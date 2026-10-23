// Shared reset-custody guards retained for spool writers. The retired team
// checkpoint copy/cut tests were removed with that implementation.
import { installSpoolPane } from "./support/spool-pane";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainOnce, withdrawRetiredEntry, type DrainContext } from "../src/spool-drain";
import { realDrainEffects } from "../src/spool-drain-effects";
import { terminalize } from "../src/spool-deadline";
import { acquireObligationLock, acquirePathLock } from "../src/panelock";
import { RESET_HELD_LOCK_WAIT_MS } from "../src/reset";
import { retirementNoticeIds } from "../src/spool-retired";
import { reapStaleSidecars } from "../src/spool-sidecar";

const scripts = join(import.meta.dir, "../../../skills/tap/scripts");
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

async function until(path: string, child?: { exitCode: number | null }): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!existsSync(path)) {
    if (child && child.exitCode !== null) throw new Error(`producer exited ${child.exitCode} before ${path}`);
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await Bun.sleep(10);
  }
}

function fixture(submitRc = 0) {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "reset-drain-")); roots.push(root);
  const home = join(root, ".tap", "bus"), scriptsDir = join(root, "scripts"), spoolDir = join(home, "spool");
  for (const path of [scriptsDir, spoolDir, join(home, "payloads"), join(home, "receipts"), join(root, "index")]) mkdirSync(path, { recursive: true });
  const effectsLog = join(root, "effects");
  const registry = join(root, ".tap", "team-registry.json");
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture" }, seats: {} }));
  writeFileSync(join(home, ".tap-bus-authority"), "");
  const env: NodeJS.ProcessEnv = { ...process.env, TAP_HOME: home, TAP_INDEX_HOME: join(root, "index"), TAP_SCRATCH_ONLY: root,
    TAP_BOOT_ID: "boot:100", SUBMIT_RC: String(submitRc), TAP_SPOOL_DISABLE_DELIVERER: "1", TAP_SPOOL_DRAIN_ACTIVE: "" };
  installSpoolPane(root, registry, env, "codex", false, undefined, true);
  const ctx: DrainContext = { home, scriptsDir, spoolDir, payloadsDir: join(home, "payloads"), receiptsDir: join(home, "receipts"),
    eventLog: join(home, "registry-events.log"), actingRegistry: registry, team: "fixture", verbLabel: "tap", courierIdentity: "courier",
    alert: { mode: "none" }, now: 100, unroutedGrace: 1800, env };
  const park = (id: string, policy = "urgent") => {
    writeFileSync(join(spoolDir, `${id}.md`), `---\nid: ${id}\nfrom: sender\nto: peer\nkind: discuss\nreply: expected\n---\nbody ${id}\n`);
    writeFileSync(join(spoolDir, `${id}.meta.json`), JSON.stringify({ id, target: "peer", pane: "fixture:0.0", pane_id: "%401",
      target_registry: registry, to_team: "fixture", policy, held_drain_visits: 1, first_spooled_epoch: 1, deadline_epoch: 9999999999 }));
  };
  const submits = () => existsSync(effectsLog) ? readFileSync(effectsLog, "utf8").trim().split("\n") : [];
  return { root, home, ctx, env, park, submits };
}

test("a fenced digest leaves every member in spool/ with its attempt evidence and releases its claims", async () => {
  const f = fixture(); f.park("a", "standard"); f.park("b", "standard");
  f.env.SUBMIT_WRITES_FENCE = "1";
  const binding = { target: "peer", targetRegistry: f.ctx.actingRegistry, toTeam: "fixture", pane: "fixture:0.0", paneId: "%401" };
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/spool-engine.ts"), scripts,
    "digest", binding.targetRegistry, binding.toTeam, binding.target, binding.pane, binding.paneId, "a", "b"],
    { env: f.env, stdout: "pipe", stderr: "pipe" });
  await child.exited;
  for (const id of ["a", "b"]) expect({
    spool: existsSync(join(f.home, "spool", `${id}.md`)), canonical: existsSync(join(f.home, "payloads", `${id}.md`)),
    attempted: existsSync(join(f.home, "receipts", `${id}.attempted`)), claim: existsSync(join(f.home, "spool", `${id}.claim`)),
  }).toEqual({ spool: true, canonical: false, attempted: true, claim: false });
  expect(readFileSync(join(f.home, "registry-events.log"), "utf8")).toContain("stage=digest_reason=fenced");
});

test("under a fence, terminalize leaves the body in spool/ and the Bash-path attempt mint refuses", async () => {
  const f = fixture(); f.park("a");
  writeFileSync(join(f.home, "reset.fence.json"), "{}\n");
  expect(await terminalize(f.ctx, "a", "peer", "fixture:0.0")).toBe(false);
  expect([existsSync(join(f.home, "spool", "a.md")), existsSync(join(f.home, "payloads", "a.md"))]).toEqual([true, false]);
  const mint = Bun.spawnSync(["bun", join(import.meta.dir, "../src/delivery-attempt.ts"), "begin", f.home, "a"], { env: f.env });
  expect({ rc: mint.exitCode, err: mint.stderr.toString() }).toEqual({ rc: 1, err: "tap: delivery attempt for 'a' refused — reset custody fenced\n" });
  expect(existsSync(join(f.home, "receipts", "a.attempted"))).toBe(false);
});

// tap-12ys6: a reset holder waits on nothing but short durable-write locks. A
// concurrent send, in its own process, must get reset while a metadata writer or a
// notice obligation holder stalls the drain.
function probeReset(f: ReturnType<typeof fixture>, delayMs: number, waitMs: number) {
  const child = Bun.spawn(["bun", join(import.meta.dir, "support", "reset-custody-probe.ts"), f.home, String(delayMs), String(waitMs)],
    { env: f.env, stdout: "pipe", stderr: "pipe" });
  return async () => { await child.exited; return JSON.parse(await new Response(child.stdout).text()) as { acquired: boolean; elapsedMs: number }; };
}

/** A retirement-ready entry: `peer` re-registered after `a` was stamped for its old instance. */
function retireReady(f: ReturnType<typeof fixture>) {
  f.park("a");
  const registry = JSON.parse(readFileSync(f.ctx.actingRegistry, "utf8"));
  Object.assign(registry.seats.peer, { instance: "peer|new", registered_at: "2026-09-07T11:52:03Z" });
  writeFileSync(f.ctx.actingRegistry, JSON.stringify(registry));
  const spool = join(f.home, "spool", "a.md");
  writeFileSync(spool, readFileSync(spool, "utf8").replace("reply: expected\n", `reply: expected\npath: ${f.home}/payloads/a.md\nrecipient_instance: peer|old\nsender_instance: sender|old\n`));
}

test("terminalize gives up a held metadata lock within the bound, releases reset to a concurrent send, and still reports terminal", async () => {
  const f = fixture(); f.park("a");
  const meta = acquirePathLock(join(f.home, "spool", "a.meta.json.lock"), 1000, f.env)!;
  let outcome: unknown, probe;
  const started = Date.now();
  try {
    const result = probeReset(f, 200, 4000);
    outcome = await terminalize(f.ctx, "a", "peer", "fixture:0.0");
    probe = await result();
  } finally { meta.release(); }
  // Promoted and evented, so the caller's receipt or notice runs; only the sidecar is left.
  expect({ outcome, acquired: probe.acquired, retained: existsSync(join(f.home, "spool", "a.meta.json")),
    spoolBody: existsSync(join(f.home, "spool", "a.md")), promoted: existsSync(join(f.home, "payloads", "a.md")) })
    .toEqual({ outcome: true, acquired: true, retained: true, spoolBody: false, promoted: true });
  expect(probe.elapsedMs).toBeLessThan(RESET_HELD_LOCK_WAIT_MS + 2000);
  expect(Date.now() - started).toBeLessThan(RESET_HELD_LOCK_WAIT_MS + 3000);
  // The next drain's sweep removes the orphaned sidecar.
  reapStaleSidecars(f.ctx.spoolDir, f.ctx.payloadsDir, f.env);
  expect(existsSync(join(f.home, "spool", "a.meta.json"))).toBe(false);
}, 20_000);

test("retirement gives up a held metadata lock within the bound and a later pass completes the removal", async () => {
  const f = fixture(); retireReady(f);
  // A prior pass wrote the receipt and stopped short of the removal, so this pass
  // reaches the removal without withdrawRetired's own metadata wait.
  writeFileSync(join(f.home, "receipts", "a.cancelled"), JSON.stringify({ id: "a", status: "cancelled", by: "courier", via: "cancelled",
    reason: "instance_retired", target: "peer", source: "spool" }) + "\n");
  const meta = acquirePathLock(join(f.home, "spool", "a.meta.json.lock"), 1000, f.env)!;
  let rc: number, probe;
  try {
    const result = probeReset(f, 200, 4000);
    rc = await withdrawRetiredEntry(f.ctx, "a", f.ctx.actingRegistry).catch(() => -1);
    probe = await result();
  } finally { meta.release(); }
  expect({ rc, acquired: probe.acquired, retained: existsSync(join(f.home, "spool", "a.meta.json")) }).toEqual({ rc: -1, acquired: true, retained: true });
  expect(probe.elapsedMs).toBeLessThan(RESET_HELD_LOCK_WAIT_MS + 2000);
  expect(await withdrawRetiredEntry(f.ctx, "a", f.ctx.actingRegistry)).toBe(0);
  expect({ receipt: existsSync(join(f.home, "receipts", "a.cancelled")), spool: existsSync(join(f.home, "spool", "a.meta.json")) })
    .toEqual({ receipt: true, spool: false });
}, 20_000);

test("retirement waits on a held notice obligation before taking reset, never under it", async () => {
  const f = fixture(); retireReady(f);
  // One lock root for every taker, as in production (withdrawRetired's own takes read process.env).
  f.env.TAP_LOCK_DIR = join(f.root, "locks");
  const previous = process.env.TAP_LOCK_DIR;
  process.env.TAP_LOCK_DIR = f.env.TAP_LOCK_DIR;
  try {
    const [noticeId] = retirementNoticeIds(f.home, "a");
    const notice = acquireObligationLock(noticeId!, 1000, f.env)!;
    let rc: number, probe;
    try {
      const result = probeReset(f, 200, 300);
      rc = await withdrawRetiredEntry(f.ctx, "a", f.ctx.actingRegistry).catch(() => -1);
      probe = await result();
    } finally { notice.release(); }
    // Busy before custody: nothing written, reset free throughout the wait.
    expect({ rc, acquired: probe.acquired, receipt: existsSync(join(f.home, "receipts", "a.cancelled")) }).toEqual({ rc: -1, acquired: true, receipt: false });
    expect(await withdrawRetiredEntry(f.ctx, "a", f.ctx.actingRegistry)).toBe(0);
    expect(existsSync(join(f.home, "receipts", "a.cancelled"))).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.TAP_LOCK_DIR; else process.env.TAP_LOCK_DIR = previous;
  }
}, 20_000);
