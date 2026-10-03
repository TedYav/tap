import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeScratchTree } from "./support/scratch";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "tap-dead-list.")));
const repo = join(scratch, "repo"), index = join(scratch, "index");
const registry = join(repo, ".tap/team-registry.json");
const socket = "dead-list-" + process.pid;
const env: NodeJS.ProcessEnv = { ...process.env, TAP_INDEX_HOME: index, TAP_TMUX_SOCKET: socket,
  TAP_SESSION_MANIFEST: join(scratch, "sessions.json"), TAP_SKIP_VERSION_BRIEFING: "1" };
for (const key of ["TMUX", "TMUX_PANE", "TAP_HOME", "TAP_SELF", "TAP_TMUX_SOCKET_PATH"]) delete env[key];
const T = (...args: string[]) => {
  const r = spawnSync("tmux", ["-L", socket, ...args], { env, encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
};
let before: string[];
beforeAll(async () => {
  mkdirSync(join(repo, ".tap"), { recursive: true }); mkdirSync(index);
  expect(spawnSync("git", ["init", "-q", repo]).status).toBe(0);
  const seats: Record<string, unknown> = {};
  for (const name of ["dead", "live", "mixed", "unregistered-dead"]) {
    const session = "fixture/" + name;
    const pane = T("new-session", "-d", "-s", session, "-c", repo, "-P", "-F", "#{pane_id}", "sleep 600");
    if (name === "mixed") T("new-window", "-d", "-t", session, "-c", repo, "sleep 600");
    if (name !== "live") {
      T("set-option", "-w", "-t", pane, "remain-on-exit", "on");
      T("respawn-pane", "-k", "-t", pane, "exit 0");
      for (let i = 0; i < 100 && T("display-message", "-p", "-t", pane, "#{pane_dead}") !== "1"; i++) await Bun.sleep(10);
      expect(T("display-message", "-p", "-t", pane, "#{pane_dead}")).toBe("1");
    }
    if (name !== "unregistered-dead") seats[name] = { status: "active", delivery: "pane", harness: "codex",
      pane_id: pane, pane: session + ":0.0", session, registered_from_worktree: repo };
  }
  seats.missing = { status: "active", delivery: "pane", harness: "codex", pane_id: "%9999",
    pane: "fixture/missing:0.0", session: "fixture/missing", registered_from_worktree: repo };
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture", worktree_root: repo }, seats }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    fixture: { root: repo, registry_location: registry, state: "registered" },
  } }));
  before = [readFileSync(registry, "utf8"), readFileSync(join(index, "global-registry.json"), "utf8")];
});
afterAll(() => { T("kill-server"); removeScratchTree(scratch); });

function list(...args: string[]) {
  const r = spawnSync(resolve(import.meta.dir, "../../../bin/tap"), ["session", "list", "--machine", ...args],
    { cwd: repo, env, encoding: "utf8", timeout: 30_000 });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  expect([readFileSync(registry, "utf8"), readFileSync(join(index, "global-registry.json"), "utf8")]).toEqual(before);
  return r.stdout;
}

test("live list excludes retained dead sessions but includes a live pane in another window", () => {
  const result = JSON.parse(list("--live", "--json"));
  expect(result.sessions.map((row: { name: string }) => row.name).sort()).toEqual(["fixture/live", "fixture/mixed"]);
});

test("full list retains dead-session history with live=false and never reaps panes", () => {
  const rows = JSON.parse(list("--json")).sessions as { name: string; live: boolean }[];
  expect(Object.fromEntries(rows.map(row => [row.name, row.live]))).toEqual({
    "fixture/dead": false, "fixture/live": true, "fixture/mixed": true, "fixture/missing": false,
  });
  expect(T("display-message", "-p", "-t", "fixture/dead", "#{pane_dead}")).toBe("1");
});

test("completion includes retained unregistered tmux sessions", () => {
  expect(list("--names-only", "--include-tmux").trim().split("\n")).toContain("fixture/unregistered-dead");
});
