import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeScratchTree } from "./support/scratch";
const repo = resolve(import.meta.dir, "../../..");
const tmuxBin = Bun.which("tmux")!;
function world() {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "tap-ambient-triage-")));
  const home = join(scratch, "home"), root = join(scratch, "fixture"), index = join(home, ".tap");
  const bus = join(root, ".tap/bus"), registry = join(root, ".tap/team-registry.json");
  for (const path of [home, index, bus]) mkdirSync(path, { recursive: true });
  expect(spawnSync("git", ["init", "-q", root]).status).toBe(0);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), TAP_HOME: bus,
    TAP_SCRATCH_ONLY: scratch, TAP_SKIP_VERSION_BRIEFING: "1", TAP_SETUP_OPEN_GUIDE: "0" };
  for (const key of ["TMUX", "TMUX_PANE", "TAP_SELF", "TAP_INDEX_HOME", "TAP_SERVER_EPOCH", "TAP_BOOT_ID", "TAP_BOOT_ID_LEGACY", "TAP_SCRIPTS_DIR", "TAP_TMUX_SOCKET"]) delete env[key];
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    fixture: { root, registry_location: registry, state: "registered" },
  } }));
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture", worktree_root: root }, seats: {} }));
  const door = (args: string[], extra: NodeJS.ProcessEnv = {}) => spawnSync(join(repo, "bin/tap"), args,
    { cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 30000 });
  return { scratch, home, root, index, registry, bus, env, door };
}

import { MAIN, teamFixture, flushScratch } from "./support/send-reply-flip-fixture";
afterEach(() => flushScratch(), 40000);

function boundWorld(stale = false) {
  const f = world(), socket = join(process.env.TMUX_TMPDIR!, "fp16.sock");
  f.env.TAP_TMUX_SOCKET_PATH = socket;
  const tmux = (args: string[]) => {
    const r = spawnSync(tmuxBin, ["-S", socket, ...args], { env: f.env, encoding: "utf8", timeout: 5000 });
    expect({ code: r.status, err: r.stderr }).toMatchObject({ code: 0 }); return r.stdout.trim();
  };
  const seats: Record<string, unknown> = {};
  for (const name of ["one", "two"]) {
    const pane = tmux(["new-session", "-d", "-s", "fixture/" + name, "-c", f.root, "-P", "-F", "#{pane_id}", "/bin/sleep 600"]);
    const [epoch, actualSocket] = tmux(["display-message", "-p", "-t", pane, "#{pid}:#{start_time}\t#{socket_path}"]).split("\t");
    seats[name] = { status: "active", delivery: "pane", session: "fixture/" + name, pane: "fixture/" + name + ":0.0",
      pane_id: pane, harness: "bash", server_socket: actualSocket, server_epoch: stale ? "srv:0:0" : "srv:" + epoch,
      boot_id: "", instance: name + "|kept", harness_session_id: name + "-conversation" };
  }
  writeFileSync(f.registry, JSON.stringify({ schema: "0.20", team: { name: "fixture", worktree_root: f.root }, seats }));
  const before = readFileSync(f.registry, "utf8");
  const unchanged = () => {
    expect(readFileSync(f.registry, "utf8")).toBe(before);
    expect(existsSync(join(f.bus, "registry-events.log"))).toBe(false);
    for (const name of ["one", "two"]) tmux(["has-session", "-t", "fixture/" + name]);
  };
  const cleanup = () => {
    spawnSync(tmuxBin, ["-S", socket, "kill-server"], { env: f.env, stdio: "ignore" });
    removeScratchTree(f.scratch);
  };
  return { ...f, unchanged, cleanup };
}

for (const args of [
  ["cancel", "missing-fixture-payload", "--json"],
  ["cancel", "missing-fixture-payload", "--by", "one", "--json"],
  ["compact", "--bogus", "--json"],
  ["clear", "--bogus", "--json"],
]) {
  test(`restart prelude: refused ${args.join(" ")} keeps live bindings despite an ambient epoch`, () => {
    const f = boundWorld();
    try {
      const r = f.door(args, { TAP_SERVER_EPOCH: "srv:0:0" });
      expect(r.status, r.stdout + r.stderr).not.toBe(0);
      f.unchanged();
    } finally { f.cleanup(); }
  }, 60000);
}

test("restart prelude: a genuine generation mismatch does not rewrite rows before a refusal", () => {
  const f = boundWorld(true);
  try {
    const r = f.door(["cancel", "missing-fixture-payload", "--json"]);
    expect(JSON.parse(r.stdout).error_class).toBe("no_actor");
    f.unchanged();
  } finally { f.cleanup(); }
}, 60000);

test("restart prelude: an unknown session subcommand refuses with no hidden registry write", async () => {
  const f = boundWorld();
  try {
    const r = f.door(["session", "unknown-fixture-subcommand"], { TAP_INDEX_HOME: f.index, TAP_SERVER_EPOCH: "srv:0:0" });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("tap session: unknown session subcommand 'unknown-fixture-subcommand'; next: tap help session\n");
    f.unchanged();
  } finally { f.cleanup(); }
}, 60000);

for (const epoch of ["srv:123:456", "srv:999:999"]) {
  test(`restart prelude: public send respects stored generation ${epoch}`, () => {
    const fx = teamFixture({ seats: { ub: {
      status: "active", delivery: "pane", session: "ub", pane: "ub:0.0", pane_id: "%7",
      harness: "claude", server_epoch: epoch, instance: "ub|A",
    } } });
    const r = Bun.spawnSync([process.execPath, MAIN, "send", "ub", "-m", "hello", "--from", "ua", "--json"], {
      cwd: fx.wt, env: { ...fx.env, TAP_SPOOL_DRAIN_ACTIVE: "1", TAP_TUI_SETTLE_SCALE: "0.1" },
      stdout: "pipe", stderr: "pipe", timeout: 30000,
    });
    const receipt = JSON.parse(r.stdout.toString());
    if (epoch === "srv:123:456") {
      expect(r.exitCode, r.stderr.toString()).toBe(0);
      expect(receipt.status).toBe("injected");
      expect(existsSync(fx.env.FAKE_SUBMITTED!)).toBe(true);
    } else {
      expect(r.exitCode).toBe(1);
      expect(receipt.error_class).toBe("identity_mismatch");
      expect(receipt.detail).toContain("server generation srv:999:999");
      expect(existsSync(fx.env.FAKE_SUBMITTED!)).toBe(false);
      expect(existsSync(fx.env.FAKE_BAND!)).toBe(false);
    }
  }, 60000);
}
