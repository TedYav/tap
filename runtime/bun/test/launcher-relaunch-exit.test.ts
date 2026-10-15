import { afterEach, expect, test } from "bun:test";
// tap-xnfko: a relaunch of a Codex seat from a caller outside tmux must exit
// with a receipt within a bound. The incident caller was a human terminal with
// a controlling tty; scripts and agents call the same door piped. Both shapes
// drive the public door over a fixture tmux, so the assert is the whole exit
// contract — the process ends by itself, within the bound, holding a receipt.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { stripPaneSgr } from "../src/launcher/readiness";
import { acquirePathLock } from "../src/panelock";
import { removeScratchTree } from "./support/scratch";

const REPO = resolve(import.meta.dir, "../../..");
const PTY_CALLER = join(import.meta.dir, "support/pty-caller.py");
const TAP = join(REPO, "bin/tap");
// The codex rebind ceiling is 45s (CLEAR_REBIND_TIMEOUT_BY_FAMILY); a healthy
// fixture relaunch observes ~5s and exits. The bound sits above the ceiling
// plus door overhead, so it fails only the hang class it guards, never load.
const EXIT_BOUND_SECONDS = 60;

const saved = { ...process.env }, roots: string[] = [];
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  for (const root of roots.splice(0)) removeScratchTree(root);
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "relaunch-exit-")));
  roots.push(root);
  const bin = join(root, "bin"), index = join(root, "index"), busHome = join(root, ".tap/bus");
  for (const dir of [bin, index, busHome, join(root, ".tap/elsewhere")]) mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", root]);
  const registryPath = join(root, ".tap/elsewhere/registry.json"), effect = join(root, "effects"), state = join(root, "state");
  const row = { harness: "codex", status: "active", delivery: "pane", pane_id: "%7", pane: "Demo/alice:0.0", session: "Demo/alice",
    server_epoch: "srv:1:1", server_socket: "/fixture/socket", boot_id: "boot:1", harness_session_id: "conversation", permissions: "bypass" };
  writeFileSync(registryPath, JSON.stringify({ schema: "0.20", team: { name: "Demo" }, seats: { alice: row } }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { Demo: { root, registry_location: registryPath } } }));
  writeFileSync(state, JSON.stringify({ replaced: false }));
  writeFileSync(join(bin, "tmux"), `#!${process.execPath}
    import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
    const args = process.argv.slice(2); while (['-S', '-L'].includes(args[0])) args.splice(0, 2);
    const statePath = ${JSON.stringify(state)};
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    if (args[0] === 'list-sessions') console.log('Demo/alice\\t1:1\\t1');
    else if (args[0] === 'list-panes') console.log(['Demo/alice', 'Demo/alice:0.0', '%7', 'codex', '111', '1:1', '0'].join('\\t'));
    else if (args[0] === 'display-message') {
      if (args.at(-1) === '#{socket_path}') { console.log('/fixture/socket'); process.exit(0); }
      if (args.at(-1).includes('pane_current_command'))
        // A new pane pid once replaced: the readiness observer's stability leg.
        console.log(['Demo/alice:0.0', '%7', 'codex', '1:1', '0', state.replaced ? 222 : 111, ${JSON.stringify(root)}].join('\\t'));
      else console.log('1:1\\t/fixture/socket');
    } else if (args[0] === 'respawn-pane') {
      appendFileSync(${JSON.stringify(effect)}, JSON.stringify(args) + '\\n');
      state.replaced = true; writeFileSync(statePath, JSON.stringify(state));
    } else if (args[0] === 'set-option') {
      appendFileSync(${JSON.stringify(effect)}, JSON.stringify(args) + '\\n');
    } else if (args[0] === 'clear-history') throw Error('relaunch must retain scrollback');
    else if (args[0] !== 'capture-pane') process.exit(1);
  `, { mode: 0o755 });
  Object.assign(process.env, { PATH: `${bin}:${saved.PATH}`, TAP_INDEX_HOME: index, TAP_SERVER_EPOCH: "srv:1:1",
    TAP_BOOT_ID: "boot:1", TAP_TMUX_SOCKET_PATH: "/fixture/socket" });
  for (const key of ["TMUX", "TMUX_PANE", "TAP_HOME", "TAP_SELF"]) delete process.env[key];
  const effects = () => { try { return readFileSync(effect, "utf8"); } catch { return ""; } };
  return { root, effects };
}

test.each(["flag", "env", "human"])("Codex relaunch receipt preview keeps JSON quiet (%s)", mode => {
  const f = fixture();
  const run = spawnSync(TAP, ["session", "relaunch", "alice", "--dry-run", ...(mode === "flag" ? ["--json"] : [])],
    { cwd: f.root, env: { ...process.env, TAP_JSON: mode === "env" ? "1" : "0" }, encoding: "utf8", timeout: 10000 });
  expect(run.status, run.stdout + run.stderr).toBe(0);
  expect(existsSync(join(f.root, ".tap/elsewhere/receipts"))).toBe(false);
  expect(f.effects()).toBe("");
  if (mode === "human") expect((run.stdout + run.stderr).match(/will be created/g)).toHaveLength(1);
  else {
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout).ok).toBe(true);
    expect(run.stdout).not.toContain("will be created");
  }
});

test("public Codex relaunch exits from a controlling terminal outside tmux", () => {
  const f = fixture();
  // The helper self-bounds: on EXIT_BOUND_SECONDS it kills the child and
  // reports timedOut, so a hung door fails here instead of stalling CI.
  const run = spawnSync("python3", [PTY_CALLER, String(EXIT_BOUND_SECONDS), TAP, "session", "relaunch", "alice"],
    { cwd: f.root, env: process.env, encoding: "utf8", timeout: (EXIT_BOUND_SECONDS + 15) * 1000 });
  expect(run.status).toBe(0);
  const report = JSON.parse(run.stdout!);
  if (report.code !== 0) console.log("pty caller report:", JSON.stringify(report));
  expect(report.timedOut).toBe(false);
  expect(report.code).toBe(0);
  const screen = stripPaneSgr(report.output);
  expect(screen).toContain("Relaunching 1 active seats on team Demo");
  expect(screen).toContain("● Demo/alice");
  expect(f.effects()).toContain("respawn-pane");
}, (EXIT_BOUND_SECONDS + 20) * 1000);

test("public Codex relaunch exits from a piped caller outside tmux", () => {
  const f = fixture();
  const run = spawnSync(TAP, ["session", "relaunch", "alice", "--json"],
    { cwd: f.root, env: process.env, encoding: "utf8", timeout: EXIT_BOUND_SECONDS * 1000 });
  expect(run.error).toBeUndefined();
  expect(run.status).toBe(0);
  const receipt = JSON.parse(run.stdout!);
  expect(receipt.ok).toBe(true);
  expect(receipt.results[0].status).toBe("resumed");
  expect(receipt.results[0].handle).toBe("alice");
}, (EXIT_BOUND_SECONDS + 20) * 1000);

test("Ctrl-C during the custody wait exits promptly; the wait yields and no effect runs (tap-7t3ag)", async () => {
  const f = fixture();
  // A structural EX holder (teardown shape) parks the relaunch's shared
  // custody stamp. The interactive wait reports it; Ctrl-C must end the door
  // at once — the wait is async, so the door's own SIGINT handler can run.
  // The bus home carries the reset sidecar even though the acting registry is
  // relocated to .tap/elsewhere (the fixture tests that separation).
  const busHome = join(f.root, ".tap/bus");
  const release = join(f.root, "holder-release");
  const holder = Bun.spawn(["bun", join(import.meta.dir, "support/reset-ex-holder.ts"), busHome, release],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  try {
    // The holder must already hold EX when the door starts, or the door's
    // stamp simply wins the race and never waits.
    const lockPath = join(busHome, "reset.fence.json.lock");
    const ready = Date.now() + 10_000;
    while (Date.now() < ready) {
      const probe = acquirePathLock(lockPath, 0, process.env, "shared");
      if (probe) probe.release();
      else break;
      await Bun.sleep(20);
    }
    const run = spawnSync("python3",
      [PTY_CALLER, "30", "--interrupt-on", "waiting for reset custody", TAP, "session", "relaunch", "alice"],
      { cwd: f.root, env: process.env, encoding: "utf8", timeout: 45_000 });
    expect(run.status).toBe(0);
    const report = JSON.parse(run.stdout!);
    if (report.timedOut || !report.interrupted) console.log("pty caller report:", JSON.stringify(report));
    expect(report.interrupted).toBe(true);
    expect(report.timedOut).toBe(false);
    expect(report.code).toBe(130);
    // Prompt: the wait yields instead of blocking the handler.
    expect(report.elapsed).toBeLessThan(15);
    const screen = stripPaneSgr(report.output);
    expect(screen).toContain("waiting for reset custody");
    expect(screen).toContain("held by tap teardown");
    expect(screen).toContain("interrupted before respawn; nothing was replaced");
    expect(f.effects()).not.toContain("respawn-pane");
  } finally {
    writeFileSync(release, "");
    if (holder.exitCode === null) holder.kill();
    holder.exited.then(() => {}, () => {});
  }
}, 60_000);

test("Ctrl-C during Codex observation exits with an interrupted receipt", () => {
  const f = fixture();
  // A human presses Ctrl-C when the observation line stalls; the door must
  // report the possible effect and exit by itself (tap-c27s2 contract).
  const run = spawnSync("python3",
    [PTY_CALLER, String(EXIT_BOUND_SECONDS), "--interrupt-on", "observing codex startup", TAP, "session", "relaunch", "alice"],
    { cwd: f.root, env: process.env, encoding: "utf8", timeout: (EXIT_BOUND_SECONDS + 15) * 1000 });
  expect(run.status).toBe(0);
  const report = JSON.parse(run.stdout!);
  expect(report.interrupted).toBe(true);
  expect(report.timedOut).toBe(false);
  expect(report.code).toBe(130);
  const screen = stripPaneSgr(report.output);
  expect(screen).toContain("interrupted after respawn was attempted; replacement state unverified");
  expect(screen).toContain("no retry performed");
}, (EXIT_BOUND_SECONDS + 20) * 1000);
