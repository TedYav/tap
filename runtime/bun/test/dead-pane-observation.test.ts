import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { observePaneResult } from "../src/tmux";
import { acquirePathLock } from "../src/panelock";
import { removeScratchTree } from "./support/scratch";

const scratch = mkdtempSync(join(tmpdir(), "tap-dead-observe."));
const socket = `dead-observe-${process.pid}`;
const repo = join(scratch, "repo");
const index = join(scratch, "index");
const registry = join(repo, ".tap/team-registry.json");
const env: NodeJS.ProcessEnv = { ...process.env, TAP_INDEX_HOME: index, TAP_TMUX_SOCKET: socket,
  TAP_SESSION_MANIFEST: join(scratch, "sessions.json"), TAP_SKIP_VERSION_BRIEFING: "1" };
for (const name of ["TMUX", "TMUX_PANE", "TAP_HOME", "TAP_TMUX_SOCKET_PATH", "TAP_SELF", "TAP_HARNESS_SESSION_ID"]) delete env[name];
const T = (...args: string[]) => {
  const r = spawnSync("tmux", ["-L", socket, ...args], { env, encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
};
let dead: string, live: string;

beforeAll(() => {
  mkdirSync(join(repo, ".tap"), { recursive: true });
  mkdirSync(index);
  expect(spawnSync("git", ["init", "-q", repo]).status).toBe(0);
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} }));
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "repo", worktree_root: repo }, seats: {} }));
  dead = T("new-session", "-d", "-s", "stale", "-c", repo, "-P", "-F", "#{pane_id}", "sleep 60");
  T("set-option", "-w", "-t", dead, "remain-on-exit", "on");
  T("respawn-pane", "-k", "-t", dead, "exit 0");
  live = T("new-session", "-d", "-s", "fresh", "-c", repo, "-P", "-F", "#{pane_id}", "sleep 60");
  for (let i = 0; i < 100 && T("display-message", "-p", "-t", dead, "#{pane_dead}") !== "1"; i++) Bun.sleepSync(10);
  expect(T("display-message", "-p", "-t", dead, "#{pane_dead}")).toBe("1");
});

afterAll(() => { T("kill-server"); removeScratchTree(scratch); });

function register(handle: string, pane: string) {
  return spawnSync(resolve(import.meta.dir, "../../../bin/tap"), ["register", handle, "--pane", pane], {
    cwd: repo, env, encoding: "utf8", timeout: 30_000,
  });
}

test("explicit registration rejects retained dead panes and still binds live panes", () => {
  const refused = register("dead-target", dead);
  expect(refused.status, refused.stdout + refused.stderr).not.toBe(0);
  expect(refused.stderr).toContain("has exited");
  expect(JSON.parse(readFileSync(registry, "utf8")).seats["dead-target"]).toBeUndefined();
  const accepted = register("live-target", live);
  expect(accepted.status, accepted.stdout + accepted.stderr).toBe(0);
  expect(JSON.parse(readFileSync(registry, "utf8")).seats["live-target"].pane_id).toBe(live);
});

test("physical observation retains dead-pane identity for cleanup ownership checks", () => {
  expect(observePaneResult(dead, env)).toMatchObject({ status: "pane_dead", observation: { paneId: dead, session: "stale" } });
  expect(observePaneResult(live, env)).toMatchObject({ status: "ok", observation: { paneId: live, session: "fresh" } });
});

for (const change of ["dead", "replaced", "live"] as const) test(`registration revalidates a real ${change} pane after the registry lock wait`, async () => {
  const target = T("new-session", "-d", "-s", `race-${change}`, "-c", repo, "-P", "-F", "#{pane_id}", "sleep 60");
  T("set-option", "-w", "-t", target, "remain-on-exit", "on");
  const barrier = join(scratch, `race-${change}`);
  const stage = (name: string, kind: string) => `${barrier}.${name}.${kind}`;
  writeFileSync(stage("after-entry-guard", "release"), "");
  writeFileSync(stage("holding-mutation-lock", "release"), "");
  const before = JSON.parse(readFileSync(registry, "utf8")).seats;
  const child = Bun.spawn([resolve(import.meta.dir, "../../../bin/tap"), "register", `race-${change}`, "--pane", target], {
    cwd: repo, env: { ...env, TAP_RESET_FENCE_TEST_BARRIER: barrier, TAP_SCRATCH_ONLY: "1" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  let lock: ReturnType<typeof acquirePathLock> = null;
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(stage("pre-mutation", "reached")) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(stage("pre-mutation", "reached"))).toBe(true);
    lock = acquirePathLock(`${registry}.lock`, 1000, env);
    expect(lock).not.toBeNull();
    writeFileSync(stage("pre-mutation", "release"), "");
    if (change !== "live") {
      T("respawn-pane", "-k", "-t", target, change === "dead" ? "exit 0" : "sleep 60");
      if (change === "dead") {
        for (let i = 0; i < 100 && T("display-message", "-p", "-t", target, "#{pane_dead}") !== "1"; i++) await Bun.sleep(10);
        expect(T("display-message", "-p", "-t", target, "#{pane_dead}")).toBe("1");
      }
    }
    lock!.release(); lock = null;
    const code = await child.exited;
    const error = await new Response(child.stderr).text();
    const seats = JSON.parse(readFileSync(registry, "utf8")).seats;
    if (change === "live") {
      expect(code, error).toBe(0);
      expect(seats["race-live"].pane_id).toBe(target);
    } else {
      expect(code, error).toBe(1);
      expect(error).toContain(change === "dead" ? "has exited" : "changed during registration");
      expect(seats).toEqual(before);
    }
  } finally {
    writeFileSync(stage("pre-mutation", "release"), "");
    lock?.release();
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}, 30_000);
