import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { removeScratchTree } from "./support/scratch";

// Ported from skills/tap/scripts/smoke/lock-dir-sandbox.test.sh: a
// TAP_HOME-only run must not write the operator's ~/.tap/locks (tap-7r3fn.66).
// The retired shell probed the native lock paths from a subprocess whose HOME
// was fake and whose TAP_INDEX_HOME/TAP_LOCK_DIR were unset, then required
// every derived path to live under the pinned bus and nothing under the fake
// home's .tap. The port keeps the subprocess shape — homedir() reads the
// process env, so the fake HOME only exists in a child — and adds the rest of
// the documented lockRoot precedence as direct cells.
//
// Scratch allocation: the fixture tree lives only beneath the runner-owned
// scratch root (runtime/bun/test/run.sh exports TMUX_TMPDIR); this file
// refuses to run without it.

const RUNNER_ROOT = process.env.TMUX_TMPDIR;
if (!RUNNER_ROOT) {
  throw new Error(
    "lock-dir-sandbox.test.ts: TMUX_TMPDIR is unset — this fixture allocates only beneath the supported runner's scratch root (runtime/bun/test/run.sh exports it); refusing to write outside it",
  );
}
const WORK = mkdtempSync(join(RUNNER_ROOT, "tap-lockdir."));
afterAll(() => removeScratchTree(WORK));

const PANELock = join(WORK, "panelock-src.ts");

// macOS /tmp is a symlink to /private/tmp and the two runtimes canonicalize
// differently; compare against the physical spelling.
const FAKE_HOME = realpathSync(mkdtempSync(join(WORK, "home-")));
const BUS = realpathSync(mkdtempSync(join(WORK, "bus-")));
void PANELock;

/** The bare-env child: runner pins ride along, TAP lock/index vars do not. */
function probe(script: string, extra: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const pins: Record<string, string> = {};
  for (const key of ["TMUX_TMPDIR", "TMPDIR", "TAP_NOTIFY_USER_BIN", "EPISODIC_MEMORY_SUMMARIZER_GUARD",
    "TAP_SESSION_MANIFEST", "OPENCODE_DB_PATH", "TAP_VERSION_SEEN_PATH"]) {
    const value = process.env[key];
    if (value !== undefined) pins[key] = value;
  }
  const r = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: { ...pins, PATH: process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin", HOME: FAKE_HOME, TAP_HOME: BUS, ...extra },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const PANE_SCRIPT = `const { paneLockPath } = await import(${JSON.stringify(join(import.meta.dir, "../src/panelock.ts"))}); process.stdout.write(paneLockPath("%42"));`;
const ROOT_SCRIPT = `const { lockRoot } = await import(${JSON.stringify(join(import.meta.dir, "../src/panelock.ts"))}); process.stdout.write(lockRoot());`;

function assertNoHomeLocks(): void {
  expect(existsSync(join(FAKE_HOME, ".tap", "locks")), "fake home .tap/locks was written").toBe(false);
  const dotTap = join(FAKE_HOME, ".tap");
  if (existsSync(dotTap)) {
    const strays = readdirSync(dotTap, { recursive: true }).filter((name) => String(name).endsWith(".lock"));
    expect(strays, `lock files appeared under the fake home's .tap: ${strays.join(", ")}`).toEqual([]);
  }
}

test("the pane submit lock derives under the pinned bus, never the fake home", () => {
  const r = probe(PANE_SCRIPT);
  expect(r.status, r.stderr).toBe(0);
  const pane = r.stdout;
  expect(pane.startsWith(join(BUS, "locks") + "/"), `pane lock escaped the pinned bus: ${pane}`).toBe(true);
  expect(pane.endsWith("pane-submit-_42.lock")).toBe(true);
  expect(existsSync(pane), "probe must not create the lock file itself").toBe(false);
  assertNoHomeLocks();
});

test("lockRoot returns the bus root itself", () => {
  const r = probe(ROOT_SCRIPT);
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toBe(join(BUS, "locks"));
  assertNoHomeLocks();
});

test("an explicit TAP_LOCK_DIR outranks every other tier", () => {
  const lockDir = join(WORK, "explicit-locks");
  const r = probe(ROOT_SCRIPT, { TAP_LOCK_DIR: lockDir, TAP_INDEX_HOME: join(WORK, "index") });
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toBe(lockDir);
});

test("TAP_INDEX_HOME without a lock dir pins the index", () => {
  const index = join(WORK, "index");
  const r = probe(ROOT_SCRIPT, { TAP_INDEX_HOME: index });
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toBe(join(index, "locks"));
});

test("a team-override bus marker does not capture the lock root", () => {
  // The --team override also sets TAP_HOME, but derived buses keep the
  // incumbent default so Bash and Bun stay in lockstep.
  const r = probe(ROOT_SCRIPT, { TAP_TEAM_OVERRIDE_BUS: BUS });
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toBe(join(FAKE_HOME, ".tap", "locks"));
  expect(existsSync(join(FAKE_HOME, ".tap", "locks")), "lockRoot must not create the default root").toBe(false);
});

test("lockPath creates its directory under the pinned bus on demand", () => {
  const script = `const m = await import(${JSON.stringify(join(import.meta.dir, "../src/panelock.ts"))});
const { acquireObligationLock } = m;
const held = acquireObligationLock("probe-id", 0);
if (!held) throw new Error("obligation lock unexpectedly held");
held.release();`;
  const r = probe(script);
  expect(r.status, r.stderr).toBe(0);
  expect(existsSync(join(BUS, "locks", "obligation-probe-id.lock"))).toBe(true);
  assertNoHomeLocks();
  rmSync(join(BUS, "locks"), { recursive: true, force: true });
});
