import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentFamilies, harnessFallbackHandle } from "../src/observe";
import { removeScratchTree } from "./support/scratch";

// tap-2al3d: implicit handle derivation must work in a bare numeric tmux
// session by falling back to the pane's positively observed harness family,
// while named sessions keep deriving exactly as before.

test("harnessFallbackHandle returns agent families only", () => {
  const families = ["claude", "codex"];
  expect(harnessFallbackHandle("claude", families)).toBe("claude");
  expect(harnessFallbackHandle("codex", families)).toBe("codex");
  expect(harnessFallbackHandle("", families)).toBe("");
  expect(harnessFallbackHandle("sleeper", families)).toBe("");
  expect(harnessFallbackHandle("bash", families)).toBe("");
  expect(harnessFallbackHandle("claude", agentFamilies())).toBe("claude");
});

const MAIN = join(import.meta.dir, "../main.ts");
const root = realpathSync(mkdtempSync(join(tmpdir(), "tap-bare-tmux.")));
const socket = `bare-tmux-${process.pid}`;
const env: NodeJS.ProcessEnv = {
  ...process.env,
  TAP_HOME: join(root, ".tap", "bus"),
  TAP_INDEX_HOME: join(root, ".tap", "index"),
  TAP_LOCK_DIR: join(root, ".tap", "locks"),
  TAP_SPOOL_DISABLE_DELIVERER: "1",
  TAP_SCRATCH_ONLY: root,
  TAP_TMUX_SOCKET: socket,
};
for (const key of ["TMUX", "TMUX_PANE", "TAP_SERVER_EPOCH", "TAP_REGISTER_EXPECTED_HARNESS", "TAP_CALLER_SELECTED_HANDLE"]) delete env[key];

const T = (...args: string[]): string => {
  const r = spawnSync("tmux", ["-L", socket, ...args], { env, encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
};
const tap = (...argv: string[]): { code: number; out: string; err: string } => {
  const result = Bun.spawnSync([process.execPath, MAIN, ...argv], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
};
const seats = (): Record<string, Record<string, unknown>> => {
  const registry = join(root, ".tap", "team-registry.json");
  return (JSON.parse(readFileSync(registry, "utf8")) as { seats: Record<string, Record<string, unknown>> }).seats;
};
const waitCommand = (pane: string, want: string): void => {
  for (let i = 0; i < 200 && T("display-message", "-p", "-t", pane, "#{pane_current_command}") !== want; i++) Bun.sleepSync(10);
  expect(T("display-message", "-p", "-t", pane, "#{pane_current_command}")).toBe(want);
};
const startPane = (session: string, executable: string): string => {
  const pane = T("new-session", "-d", "-s", session, "-c", root, "-P", "-F", "#{pane_id}", "exec " + executable);
  waitCommand(pane, executable.split("/").pop()!);
  return pane;
};

let claude = "", codex = "", sleeper = "";

beforeAll(() => {
  mkdirSync(root, { recursive: true });
  const source = join(root, "fixture.c");
  writeFileSync(source, "#include <unistd.h>\nint main(void) { sleep(600); return 0; }\n");
  for (const name of ["claude", "codex", "sleeper"]) {
    const built = spawnSync("cc", [source, "-o", join(root, name)], { env, encoding: "utf8", timeout: 20_000 });
    expect(built.status, built.stdout + built.stderr).toBe(0);
  }
  expect(tap("init", "--yes").code).toBe(0);
});

afterAll(() => {
  spawnSync("tmux", ["-L", socket, "kill-server"], { env });
  removeScratchTree(root);
});

test("a harness in a bare numeric session registers by its observed family", () => {
  claude = startPane("0", join(root, "claude"));
  const r = tap("register", "--pane", "0:0.0", "--json");
  expect(r.err + r.out).not.toContain("could not derive a handle");
  expect(r.code).toBe(0);
  expect(Object.keys(seats())).toContain("claude");
});

test("a second claude in another numeric session suffixes across sessions", () => {
  const pane = startPane("1", join(root, "claude"));
  const r = tap("register", "--pane", "1:0.0", "--json");
  expect(r.code).toBe(0);
  expect(Object.keys(seats()).sort()).toEqual(["claude", "claude-2"]);
  expect(seats()["claude-2"]!["pane_id"]).toBe(pane);
});

test("different harnesses in one numeric session get distinct family handles", () => {
  codex = T("new-window", "-t", "0:", "-c", root, "-P", "-F", "#{pane_id}", "exec " + join(root, "codex"));
  waitCommand(codex, "codex");
  const r = tap("register", "--pane", "0:1.0", "--json");
  expect(r.code).toBe(0);
  expect(Object.keys(seats())).toContain("codex");
});

test("a non-harness pane in a numeric session keeps the fail-closed refusal", () => {
  sleeper = startPane("2", join(root, "sleeper"));
  const r = tap("register", "--pane", "2:0.0", "--json");
  expect(r.code).toBe(2);
  expect(r.out + r.err).toContain("could not derive a handle");
  expect(JSON.parse(r.out.trim()).error_class).toBe("usage_error");
});

test("restarting the harness in the same pane reclaims the bare name", () => {
  T("set-option", "-w", "-t", "0:0.0", "remain-on-exit", "on");
  T("send-keys", "-t", "0:0.0", "C-c");
  for (let i = 0; i < 200 && T("display-message", "-p", "-t", "0:0.0", "#{pane_dead}") !== "1"; i++) Bun.sleepSync(10);
  expect(T("display-message", "-p", "-t", "0:0.0", "#{pane_dead}")).toBe("1");
  T("respawn-pane", "-k", "-t", "0:0.0", "exec " + join(root, "claude"));
  waitCommand("0:0.0", "claude");
  const paneId = T("display-message", "-p", "-t", "0:0.0", "#{pane_id}");
  const r = tap("register", "--pane", "0:0.0", "--json");
  expect(r.code).toBe(0);
  expect(Object.keys(seats()).sort()).toEqual(["claude", "claude-2", "codex"]);
  expect(seats()["claude"]!["pane_id"]).toBe(paneId);
});

test("named sessions still derive from the session name, byte for byte", () => {
  startPane("myproj", join(root, "claude"));
  expect(tap("register", "--pane", "myproj:0.0", "--json").code).toBe(0);
  expect(Object.keys(seats())).toContain("myproj");
  // The consolidation bead must resolve this divergence explicitly: register
  // keeps a non-harness dash remainder, admin-rebuild's strip is families-aware.
  startPane("bash-foo", join(root, "claude"));
  expect(tap("register", "--pane", "bash-foo:0.0", "--json").code).toBe(0);
  expect(Object.keys(seats())).toContain("bash-foo");
});

test("an unregistered claude pane in a numeric session cannot retire another pane's claude row", () => {
  startPane("3", join(root, "claude"));
  const owner = seats()["claude"]!["pane_id"];
  const r = tap("out", "--pane", "3:0.0", "--json");
  expect(r.code).toBe(1);
  expect(r.out + r.err).toContain("could not derive a handle");
  expect(seats()["claude"]!["pane_id"]).toBe(owner);
});

test("tap out from a registered numeric-session pane retires its own row only", () => {
  expect(Object.keys(seats()).sort()).toEqual(["bash-foo", "claude", "claude-2", "codex", "myproj"]);
  const r = tap("out", "--pane", "0:0.0", "--json");
  expect(r.err + r.out).not.toContain("could not derive a handle");
  expect(r.code).toBe(0);
  const left = Object.keys(seats()).sort();
  expect(left).toEqual(["bash-foo", "claude-2", "codex", "myproj"]);
  expect(seats()["claude-2"]!["pane_id"]).toBeTruthy();
});

test("rebuild-registry maps numeric-session panes deterministically across sessions", () => {
  const r = tap("admin", "rebuild-registry", "--json");
  expect(r.code).toBe(0);
  const planned = (JSON.parse(r.out.trim()) as { planned: Array<{ handle: string; pane: string; harness: string }> }).planned;
  const byHandle = new Map(planned.map(row => [row.handle, row]));
  const claudePane = T("display-message", "-p", "-t", "0:0.0", "#{pane_id}");
  const claude2Pane = T("display-message", "-p", "-t", "1:0.0", "#{pane_id}");
  expect(byHandle.get("claude")!.harness).toBe("claude");
  expect(byHandle.get("claude")!.pane.startsWith("0:")).toBe(true);
  expect(byHandle.get("claude-2")!.harness).toBe("claude");
  expect(byHandle.get("claude-2")!.pane.startsWith("1:")).toBe(true);
  expect(byHandle.get("claude-2")!.pane).not.toBe(byHandle.get("claude")!.pane);
  expect(claudePane).not.toBe(claude2Pane);
});
