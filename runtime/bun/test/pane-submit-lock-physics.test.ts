import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { removeScratchTree } from "./support/scratch";
import { renderSentinel } from "../src/sentinel";

// Ported from skills/tap/scripts/regress/pane-submit-lock-physics.test.sh
// (tap-9ivr lane B, PHYSICS tier).
//
// THE DEFECT, observed on a real pane before the lock existed: two senders
// submitting concurrently to ONE pane produce a FUSED LINE carrying both
// sentinels, and BOTH senders exit 0. The band-clear read-back cannot see it:
// the id DID leave the band — glued to someone else's — so one Enter submitted
// both and the band was honestly empty.
//
// The instrument is a real tmux pane running a FAKE harness band (a read loop
// with a ❯ prompt that logs each submitted line). Real tmux, real send-keys,
// real concurrency — without injecting into any agent's pane. The native
// courier binds to the pane's live command, so the band runs under a bash copy
// named `codex` (the harness this fixture impersonates).
//
// Two port deviations, both narrowing nothing: the private server pin rides
// the documented TAP_TMUX_SOCKET seam instead of a generated PATH wrapper (the
// same -L effect through the courier's own socket seam, with TMUX/TMUX_PANE
// scrubbed from the children as the shell did), and the pin runs in the Bun
// suite instead of by hand — the retired shell header documented that the
// regress gate never enforced this tier at all, because the smoke suite's
// mocked tmux leaves no interleaving window.
//
// GATE PLACEMENT (deliberate promotion, mirroring the arg-hint port): this
// file lives in the Bun suite that nightwatch's full gate runs
// (full-gate.yml, workflow_dispatch). It is NOT part of the merge-gating
// smoke.yml, which runs only sanity, typecheck and the stamped pair; the
// full Bun suite never blocks a merge by itself. The retired disposition said
// "keep without porting" because the shell regress tier could not enforce
// this pin continuously; this promotion upgrades documented-not-enforced to
// enforced-continuously-on-demand. The structural share of the gate remains
// the native lock tests (unit3-lock.test.ts, lock-attribution.test.ts).

const REAL_TMUX = Bun.which("tmux");
if (!REAL_TMUX) throw new Error("pane-submit-lock-physics.test.ts: no tmux on PATH — this physics pin requires a real tmux server");
const tmuxBin: string = REAL_TMUX;

const RUNNER_ROOT = process.env.TMUX_TMPDIR;
if (!RUNNER_ROOT) {
  throw new Error(
    "pane-submit-lock-physics.test.ts: TMUX_TMPDIR is unset — this fixture allocates only beneath the supported runner's scratch root (runtime/bun/test/run.sh exports it); refusing to write outside it",
  );
}
const WORK = mkdtempSync(join(RUNNER_ROOT, "tap-panesubmit."));

const SOCK = `panesubmit-${process.pid}`;
const SESS = `tapsublock${process.pid}`;
const LOG = join(WORK, "submitted.log");
const COURIER = resolve(import.meta.dir, "../src/courier.ts");
const SENDER = resolve(import.meta.dir, "fixtures/pane-submit-lock/submit-one.ts");

// The courier keys pane-submit locks by server-scoped pane id. Keep
// TAP_LOCK_DIR under WORK so fixture pane ids cannot contend with
// identically numbered live panes.
const LOCK_DIR = join(WORK, "locks");

function childEnv(): NodeJS.ProcessEnv {
  const { TMUX: _t, TMUX_PANE: _p, ...rest } = process.env;
  return {
    ...rest,
    TAP_LOCK_DIR: LOCK_DIR,
    // A test process may carry an inherited PATH-socket pin; the production
    // socket selector gives the path variable precedence, so leaving it set
    // would send the senders to the wrong server instead of our private -L one.
    TAP_TMUX_SOCKET_PATH: undefined,
    TAP_TMUX_SOCKET: SOCK,
    HOME: WORK,
  };
}

const T = (...args: string[]) => {
  const r = spawnSync(tmuxBin, ["-L", SOCK, ...args], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
};

let panePid = "";

beforeAll(() => {
  mkdirSync(LOCK_DIR, { recursive: true });
  writeFileSync(LOG, "");
  // The band: a read loop with a ❯ prompt that logs each submitted line and
  // exits at EOF, so killing the server takes the band down with it.
  const band = join(WORK, "band.sh");
  writeFileSync(band, `#!/usr/bin/env bash\nwhile IFS= read -r -p '❯ ' line; do\n  printf '%s\\n' "$line" >> '${LOG}'\ndone\n`);
  chmodSync(band, 0o755);
  // The harness this fixture impersonates: a bash copy named `codex`.
  const codex = join(WORK, "codex");
  expect(spawnSync("cp", [Bun.which("bash")!, codex]).status).toBe(0);
  T("new-session", "-d", "-s", SESS, "-x", "200", "-y", "50", `${codex} ${band}`);
  panePid = T("list-panes", "-t", SESS, "-F", "#{pane_pid}").split("\n")[0] ?? "";
  expect(panePid, "fixture pane pid never appeared").not.toBe("");
});

afterAll(() => {
  // The destructive call uses the real binary directly, never PATH. The band
  // process outlives the client's kill-server round-trip, so wait for the
  // pane pid to actually die before the scratch tree is lsof-checked away.
  spawnSync(tmuxBin, ["-L", SOCK, "kill-server"]);
  for (let i = 0; i < 100 && panePid; i++) {
    if (spawnSync("kill", ["-0", panePid]).status !== 0) break;
    Bun.sleepSync(50);
  }
  removeScratchTree(WORK);
});

function paneId(): string {
  for (let i = 0; i < 100; i++) {
    const r = spawnSync(tmuxBin, ["-L", SOCK, "list-panes", "-t", SESS, "-F", "#{pane_id}"], { encoding: "utf8" });
    const pane = (r.stdout ?? "").trim().split("\n")[0] ?? "";
    if (pane) return pane;
    Bun.sleepSync(50);
  }
  throw new Error("fixture pane never appeared");
}

/** The band's painted prompt is what the courier's band classifier reads;
 *  submit before it exists and the send refuses with no recognized composer. */
function awaitBandPrompt(pane: string): void {
  for (let i = 0; i < 100; i++) {
    const r = spawnSync(tmuxBin, ["-L", SOCK, "capture-pane", "-p", "-t", pane], { encoding: "utf8" });
    if ((r.stdout ?? "").includes("❯")) return;
    Bun.sleepSync(50);
  }
  throw new Error("fixture band prompt never painted");
}

function submitOne(id: string): ReturnType<typeof Bun.spawn> {
  const wire = renderSentinel({ from: "probe", to: "band", id,
    kind: "discuss", reply: "expected", path: "/fixture/payload.md" });
  return Bun.spawn([process.execPath, SENDER, COURIER, paneIdCache!, id, wire], {
    env: childEnv(),
    stdout: "ignore",
    stderr: "pipe",
  });
}

let paneIdCache = "";

test(
  "two concurrent native submits stay serialized: no fused line, both sentinels whole",
  async () => {
    paneIdCache = paneId();
    awaitBandPrompt(paneIdCache);
    // Both senders race; each exits 0 only when its own submit injected.
    const [aaa, bbb] = [submitOne("probe-AAA"), submitOne("probe-BBB")];
    const [aaaErr, bbbErr] = [await new Response(aaa.stderr as ReadableStream).text(), await new Response(bbb.stderr as ReadableStream).text()];
    // The lock wait is a fixed 5 s. Under gate load the holder can outlast it, and
    // the waiter then PARKS with lock_busy (rc 5): the refusal is the product
    // working, and it says nothing about fusing. Both senders have finished here,
    // so a parked one retries once against a free lock; the fusion pin below still
    // judges two separate submitted lines. Any other failure stays a failure.
    const first = [
      { id: "probe-AAA", rc: await aaa.exited, why: aaaErr },
      { id: "probe-BBB", rc: await bbb.exited, why: bbbErr },
    ];
    for (const sender of first) {
      if (sender.rc === 5 && sender.why.includes('"status":"lock_busy"')) {
        const retry = submitOne(sender.id);
        sender.why = await new Response(retry.stderr as ReadableStream).text();
        sender.rc = await retry.exited;
      }
      expect(sender.rc, `${sender.id} did not inject: ${sender.why}`).toBe(0);
    }
    await Bun.sleep(1000);

    const received = (await Bun.file(LOG).text()).split("\n").filter(Boolean);
    const fused = received.filter((line) => /probe-AAA.*probe-BBB|probe-BBB.*probe-AAA/.test(line));
    expect(fused, `FUSED LINE: the lock did not serialize. received: ${JSON.stringify(received)}`).toEqual([]);
    expect(received, `expected 2 separate submitted lines, got: ${JSON.stringify(received)}`).toHaveLength(2);
    expect(received.some((line) => line.includes("probe-AAA")), `probe-AAA never arrived: ${JSON.stringify(received)}`).toBe(true);
    expect(received.some((line) => line.includes("probe-BBB")), `probe-BBB never arrived: ${JSON.stringify(received)}`).toBe(true);
  },
  { timeout: 60_000 },
);
