import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { acquireObligationLock, type PaneLock } from "../src/panelock";
import { removeScratchTree } from "./support/scratch";

// Ported from skills/tap/scripts/smoke/settled-wake.test.sh (tap-6fd0x): the
// production ordinary-park orderings. A real `tap send` parks a note against
// busy human input; one pass of the REAL spool engine (spool-engine.ts, the
// same subprocess entrance production drains use) then meets a recipient who
// reads at each ordering window:
//   settlement-first — paused at the native readiness barrier, before any
//     claim: the poll/read wins, the drain must skip with an explicit
//     settled-before-delivery disposition and never wake the pane.
//   delivery-first — paused mid-canonical-move through the PATH-tmux barrier:
//     the courier owns the window, a concurrent read refuses, delivery lands
//     exactly one sentinel, and a later read settles exactly once.
//   delivery-lock-order — paused right after the Phase B claim: the obligation
//     lock must already be held, or a reader could hold obligation while
//     refusing the courier-owned claim.
//
// Every pane below is a fixture; the drain is the only flush the fixture
// cannot see coming (no opportunistic drain, no detached deliverer).

const RUNNER_ROOT = process.env.TMUX_TMPDIR;
if (!RUNNER_ROOT) {
  throw new Error(
    "settled-wake.test.ts: TMUX_TMPDIR is unset — this fixture allocates only beneath the supported runner's scratch root (runtime/bun/test/run.sh exports it); refusing to write outside it",
  );
}
const WORK = mkdtempSync(join(RUNNER_ROOT, "tap-settledwake."));
afterAll(() => removeScratchTree(WORK));

const ROOT = resolve(import.meta.dir, "../../..");
const BIN_TAP = join(ROOT, "bin", "tap");
const SPOOL_ENGINE = join(ROOT, "runtime", "bun", "src", "spool-engine.ts");
const SCRIPTS_DIR = join(ROOT, "skills", "tap", "scripts");
const ENVELOPE_CLI = join(import.meta.dir, "support", "envelope-field-cli.ts");
const FAKE_BIN = join(WORK, "bin");
const STATE = join(WORK, "tmux");
const REPO = join(WORK, "repo");
const BUS = join(REPO, ".tap", "bus");
const SPOOL = join(BUS, "spool");
const PAYLOADS = join(BUS, "payloads");
const RECEIPTS = join(BUS, "receipts");
const BARRIER = join(WORK, "barrier");
const LOG = join(STATE, "send-keys.log");
const INDEX = join(WORK, "index");
const NOW = 1_000_000_000;
const DRAIN_NOW = String(NOW + 3600);

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const pins: Record<string, string> = {};
  for (const key of ["TMUX_TMPDIR", "TMPDIR", "TAP_NOTIFY_USER_BIN", "EPISODIC_MEMORY_SUMMARIZER_GUARD",
    "TAP_SESSION_MANIFEST", "OPENCODE_DB_PATH", "TAP_VERSION_SEEN_PATH"]) {
    const value = process.env[key];
    if (value !== undefined) pins[key] = value;
  }
  return {
    ...pins,
    PATH: `${FAKE_BIN}:${process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin"}`,
    HOME: WORK,
    TAP_HOME: BUS,
    TAP_INDEX_HOME: INDEX,
    XDG_CONFIG_HOME: join(WORK, "config"),
    TMUX: "/fake/socket",
    FAKE_TMUX_STATE: STATE,
    FAKE_WORKTREE: REPO,
    FAKE_TMUX_CMD: "codex",
    FAKE_PANE_ID: "%401",
    TAP_SERVER_EPOCH: "srv:4242:100",
    TAP_BOOT_ID: "boot:1",
    TAP_TUI_SETTLE_SCALE: "0.1",
    TAP_SPOOL_DISABLE_DELIVERER: "1",
    TAP_LOCK_DIR: join(BUS, "locks"),
    ...extra,
  };
}
const BASE = env();

// Born-live index (F1) and the three-seat bus registry.
mkdirSync(INDEX, { recursive: true });
writeFileSync(join(INDEX, "global-registry.json"), '{"schema":"0.20","teams":{}}\n');
for (const dir of [STATE, REPO, BUS, PAYLOADS, RECEIPTS, SPOOL, BARRIER, FAKE_BIN, join(WORK, "config")]) mkdirSync(dir, { recursive: true });
writeFileSync(join(BUS, "registry.json"), JSON.stringify({
  schema: "0.20",
  team: { name: "t", worktree_root: REPO },
  seats: {
    peer: { session: "sess", pane: "sess:0.0", pane_id: "%401", harness: "codex", status: "active", server_epoch: "srv:4242:100", boot_id: "boot:1", registered_from_worktree: REPO },
    alice: { session: "sess", pane: "sess:0.1", pane_id: "%402", harness: "codex", status: "active", server_epoch: "srv:4242:100", boot_id: "boot:1", registered_from_worktree: REPO },
    bob: { session: "sess", pane: "sess:0.2", pane_id: "%403", harness: "codex", status: "active", server_epoch: "srv:4242:100", boot_id: "boot:1", registered_from_worktree: REPO },
  },
}));
// The engine's authorized-home marker; tap_ensure_dirs wrote it in the shell.
writeFileSync(join(BUS, ".tap-bus-authority"), "");
// The fixture tmux, on PATH.
copyFileSync(join(import.meta.dir, "fixtures", "settled-wake", "tmux"), join(FAKE_BIN, "tmux"));
chmodSync(join(FAKE_BIN, "tmux"), 0o755);

function tap(args: string[], extra: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(BIN_TAP, args, { encoding: "utf8", env: env(extra), cwd: REPO });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** An ordinary note parked against busy human input on the peer's band. */
function parkNote(id: string): void {
  writeFileSync(join(STATE, "input.sess_0_0"), "human-draft");
  const body = join(WORK, "body");
  writeFileSync(body, "ordinary note fixture\n");
  const send = tap(["send", "peer", "--from", "alice", "--id", id, "-f", body, "--json"]);
  expect(send.status, send.stderr).toBe(0);
  const receipt = JSON.parse(send.stdout);
  expect(receipt.status, send.stdout).toBe("queued");
  expect(receipt.delivery, send.stdout).toBe("spool");
  const meta = JSON.parse(readFileSync(join(SPOOL, `${id}.meta.json`), "utf8"));
  expect(meta.policy).toBe("standard");
  expect(meta.reason).toBe("pending-input");
  expect(existsSync(join(SPOOL, `${id}.md`))).toBe(true);
  expect(existsSync(join(PAYLOADS, `${id}.md`))).toBe(false);
  const reply = spawnSync(process.execPath, [ENVELOPE_CLI, join(SPOOL, `${id}.md`), "reply"], { encoding: "utf8" });
  expect(reply.stdout.trim(), "fixture is not an ordinary note").toBe("settle-only");
  expect(existsSync(join(RECEIPTS, `${id}.done`)), "note already settled").toBe(false);
  expect(existsSync(join(RECEIPTS, `${id}.sent`)), "note already delivered").toBe(false);
  rmSync(join(STATE, "input.sess_0_0"), { force: true });
  // The parked send left a draft-grace input-protection hold (30s, unscaled).
  // The fixture erases the draft, so the hold's premise is gone; removing the
  // leftover record makes the drain's first readiness probe see a bare band
  // with no prior state — the engine's unambiguous ready — instead of racing
  // the bare-band aging inside a one-shot drain's bounded probe rounds.
  rmSync(join(INDEX, "input-protection"), { recursive: true, force: true });
  writeFileSync(LOG, "");
}

/** One pass of the REAL engine as its own subprocess, so its blocking
 *  PATH-tmux barrier never freezes this test process. */
function startDrain(extra: Record<string, string>): { child: ReturnType<typeof Bun.spawn>; stderr: () => Promise<string> } {
  const facts = [BUS, SPOOL, PAYLOADS, RECEIPTS, join(BUS, "registry-events.log"), "t", "", "tap", "courier", "0", "", "", "", ""];
  const child = Bun.spawn([process.execPath, SPOOL_ENGINE, "--receipt", "--facts", SCRIPTS_DIR, ...facts, "drain", DRAIN_NOW], {
    env: env(extra),
    stdout: "pipe",
    stderr: "pipe",
  });
  const collected = new Response(child.stderr as ReadableStream<Uint8Array>).text();
  return { child, stderr: () => collected };
}

async function awaitMarker(marker: string, child: ReturnType<typeof Bun.spawn>,
  stderr: () => Promise<string>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!existsSync(marker)) {
    if (child.exitCode !== null || Date.now() >= deadline) {
      throw new Error(`drain did not reach ${marker}: ${await stderr()}`);
    }
    await Bun.sleep(20);
  }
}

/** The --receipt completion token: exactly one line, rc 0. A silent or broken
 *  engine prints no token; a failed pass prints its true code. */
async function expectDrainReceipt(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  const rc = await child.exited;
  const out = await new Response(child.stdout as ReadableStream<Uint8Array>).text();
  const lines = out.split("\n").filter((line) => line.startsWith("spool-engine\t"));
  expect(lines, `engine receipt (rc ${rc})`).toEqual(["spool-engine\t0"]);
}

function sentinelCount(id: string): number {
  return readFileSync(LOG, "utf8").split("\n").filter((line) => line.includes(id) && line.includes("[[TAP ")).length;
}

function expectDone(id: string): void {
  const done = JSON.parse(readFileSync(join(RECEIPTS, `${id}.done`), "utf8"));
  expect(done.via).toBe("read");
  expect(done.by).toBe("peer");
}

function expectNoSentinel(id: string): void {
  expect(sentinelCount(id), "a sentinel reached the fake pane").toBe(0);
  expect(existsSync(join(RECEIPTS, `${id}.sent`)), "settled note gained delivery receipt").toBe(false);
}

test("settlement wins before delivery: no wake and an explicit disposition", async () => {
  const id = "settlement-first";
  parkNote(id);
  // Pause Phase B's PRE-CLAIM readiness result, after its terminality snapshot
  // and before its delivery claim (spool-drain.ts's scratch-only barrier).
  rmSync(join(BARRIER, "drain.reached"), { force: true });
  rmSync(join(BARRIER, "drain.release"), { force: true });
  const { child, stderr } = startDrain({
    TAP_SCRATCH_ONLY: WORK,
    TAP_DRAIN_TEST_BARRIER: join(BARRIER, "drain"),
    TAP_DRAIN_TEST_ID: id,
  });
  try {
    await awaitMarker(join(BARRIER, "drain.reached"), child, stderr);
    expect(readFileSync(join(BARRIER, "drain.reached"), "utf8").trim()).toBe("ready");
    expect(existsSync(join(SPOOL, `${id}.claim`)), "readiness barrier unexpectedly holds a queue claim").toBe(false);
    const poll = tap(["poll", "peer"]);
    expect(poll.status, poll.stderr).toBe(2);
    expect(poll.stdout).toContain(id);
    const read = tap(["read", id, "--by", "peer"]);
    expect(read.status, read.stderr).toBe(0);
    expectDone(id);
    const doneBefore = join(WORK, "done-before-release");
    copyFileSync(join(RECEIPTS, `${id}.done`), doneBefore);
  } finally {
    // A failed assertion must not strand the drain on either barrier name.
    writeFileSync(join(BARRIER, "drain.release"), "");
    writeFileSync(join(BARRIER, "release"), "");
    await child.exited;
  }
  await expectDrainReceipt(child);
  expectNoSentinel(id);
  expect(readFileSync(join(RECEIPTS, `${id}.done`), "utf8")).toBe(readFileSync(join(WORK, "done-before-release"), "utf8"));
  const events = readFileSync(join(BUS, "registry-events.log"), "utf8");
  // The disposition's detail joins its fields with underscores (appendRegistryEventOrWarn).
  expect(events, "missing durable settled-before-delivery disposition").toContain("action=redelivery_skipped");
  expect(events).toContain(`id=${id}_reason=settled-before-delivery`);
  expect(existsSync(join(SPOOL, `${id}.md`)), "settlement left pending spool state").toBe(false);
  expect(existsSync(join(SPOOL, `${id}.meta.json`)), "settlement left pending meta").toBe(false);
  expect(existsSync(join(SPOOL, `${id}.claim`)), "settlement left a claim").toBe(false);
}, 60_000);

test("delivery owns its window: a concurrent read refuses, then settles exactly once", async () => {
  const id = "delivery-first";
  parkNote(id);
  rmSync(join(BARRIER, "entered"), { force: true });
  rmSync(join(BARRIER, "release"), { force: true });
  const { child, stderr } = startDrain({
    // The observer must outlast read's five-second lock wait while the barrier is held.
    TAP_TMUX_TIMEOUT_SECONDS: "20",
    DRAIN_BARRIER_ID: id,
    DRAIN_BARRIER_STAGE: "canonical",
    DRAIN_BARRIER_DIR: BARRIER,
    DRAIN_BARRIER_BUS: BUS,
  });
  try {
    await awaitMarker(join(BARRIER, "entered"), child, stderr);
    expect(existsSync(join(PAYLOADS, `${id}.md`)), "barrier missed the canonical move window").toBe(true);
    expect(existsSync(join(SPOOL, `${id}.md`)), "barrier missed the canonical move window").toBe(false);
    const read = tap(["read", id, "--by", "peer"]);
    expect(read.status, `busy read unexpectedly succeeded: ${read.stdout}${read.stderr}`).not.toBe(0);
    expect(read.stderr).toContain("without exclusive eligibility");
    expect(existsSync(join(RECEIPTS, `${id}.done`)), "busy read wrote settlement").toBe(false);
  } finally {
    writeFileSync(join(BARRIER, "drain.release"), "");
    writeFileSync(join(BARRIER, "release"), "");
    await child.exited;
  }
  await expectDrainReceipt(child);
  expect(existsSync(join(RECEIPTS, `${id}.sent`)), "courier failed to finish delivery").toBe(true);
  expect(sentinelCount(id), "expected exactly one sentinel").toBe(1);
  const readAfter = tap(["read", id, "--by", "peer"]);
  expect(readAfter.status, readAfter.stderr).toBe(0);
  expectDone(id);
  expect(existsSync(join(SPOOL, `${id}.claim`)), "delivery left claim").toBe(false);
}, 60_000);

test("Phase B owns obligation before claiming spool; delivery and later read succeed", async () => {
  const id = "delivery-lock-order";
  parkNote(id);
  rmSync(join(BARRIER, "entered"), { force: true });
  rmSync(join(BARRIER, "release"), { force: true });
  const { child, stderr } = startDrain({
    TAP_TMUX_TIMEOUT_SECONDS: "20",
    DRAIN_BARRIER_ID: id,
    DRAIN_BARRIER_STAGE: "claimed",
    DRAIN_BARRIER_DIR: BARRIER,
    DRAIN_BARRIER_BUS: BUS,
  });
  // The probe must not outlive a red path: under a Phase-B mutant the lock
  // acquisition SUCCEEDS, the expect below throws, and an unreleased hold
  // would make afterAll's lsof guard refuse the scratch.
  let probe: PaneLock | null = null;
  try {
    await awaitMarker(join(BARRIER, "entered"), child, stderr);
    expect(existsSync(join(SPOOL, `${id}.claim`)), "barrier did not hold a real spool claim").toBe(true);
    expect(existsSync(join(SPOOL, `${id}.md`)), "claim barrier missed the pre-promotion delivery window").toBe(true);
    expect(existsSync(join(PAYLOADS, `${id}.md`)), "claim barrier missed the pre-promotion delivery window").toBe(false);
    // A separate lock read, timeout 0: the drain (panelock.ts
    // acquireObligationLock) must already hold the obligation — a reader holding
    // obligation while refusing a courier-owned claim is the old race.
    probe = acquireObligationLock(id, 0, BASE);
    expect(probe, "Phase B acquired a spool claim while its obligation lock was free").toBeNull();
    expect(existsSync(join(RECEIPTS, `${id}.done`)), "claim barrier followed settlement or delivery").toBe(false);
    expect(existsSync(join(RECEIPTS, `${id}.sent`)), "claim barrier followed settlement or delivery").toBe(false);
  } finally {
    probe?.release();
    writeFileSync(join(BARRIER, "drain.release"), "");
    writeFileSync(join(BARRIER, "release"), "");
    await child.exited;
  }
  await expectDrainReceipt(child);
  expect(existsSync(join(RECEIPTS, `${id}.sent`)), "lock order suppressed delivery").toBe(true);
  expect(sentinelCount(id), "lock-ordered drain sent the wrong sentinel count").toBe(1);
  expect(existsSync(join(SPOOL, `${id}.claim`)), "drain retained its spool claim").toBe(false);
  const released = acquireObligationLock(id, 0, BASE);
  expect(released, "drain retained its obligation lock").not.toBeNull();
  released?.release();
  const read = tap(["read", id, "--by", "peer"]);
  expect(read.status, read.stderr).toBe(0);
  expectDone(id);
}, 60_000);
