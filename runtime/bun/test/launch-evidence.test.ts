// tap-bogkt / tap-7b9od: the launcher's pane evidence authorizes a SessionStart
// bind and `tap in`'s worktree guard only for the incarnation the row expects.
// Every refusal here falls back to the cwd path, which is silent outside an
// enrolled root; launch evidence never creates a row (tap-9jfyl's boundary).
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchPlacedInWorktree, launchTokenMatches, launchedRowForPane } from "../src/launch-evidence";
import { resolveLaunchEvidence, sessionContext } from "../src/session-start";
import type { CallingPaneObservation } from "../src/context";
import { removeScratchTree } from "./support/scratch";
import { validateDurable } from "../src/seat-updown";
import { observeBinding } from "../src/team/doctor";

const RUNNER_ROOT = process.env.TMUX_TMPDIR;
if (!RUNNER_ROOT) throw new Error("launch-evidence.test.ts: run through runtime/bun/test/run.sh (TMUX_TMPDIR unset)");
const WORK = realpathSync(mkdtempSync(join(RUNNER_ROOT, "launch-evidence.")));
afterAll(() => removeScratchTree(WORK));

const PANE = { pane_id: "%7", server_epoch: "srv:1:1", status: "active" };
const env = (extra: Record<string, string>): NodeJS.ProcessEnv => ({ ...extra });

test.each([
  ["pending launch_id matches TAP_LAUNCH_ID", { launch_id: "L" }, { TAP_LAUNCH_ID: "L" }, true],
  ["pending launch_id refuses another launch id", { launch_id: "L" }, { TAP_LAUNCH_ID: "X" }, false],
  ["pending launch_id ignores a matching clear id", { launch_id: "L" }, { TAP_CLEAR_ID: "L" }, false],
  ["pending clear nonce matches TAP_CLEAR_ID", { expected_clear_nonce: "N" }, { TAP_CLEAR_ID: "N" }, true],
  ["promoted launch_witness matches the launch id", { launch_witness: "L" }, { TAP_LAUNCH_ID: "L" }, true],
  ["promoted launch_witness matches the clear id", { launch_witness: "N" }, { TAP_CLEAR_ID: "N" }, true],
  // Partner review round 2: an outgoing harness (old token X) while replacement Y is pending.
  ["stale token while a clear is pending", { launch_witness: "X", expected_clear_nonce: "Y" }, { TAP_LAUNCH_ID: "X" }, false],
  ["stale clear id while a clear is pending", { launch_witness: "X", expected_clear_nonce: "Y" }, { TAP_CLEAR_ID: "X" }, false],
  ["stale token while a launch is pending", { launch_witness: "X", launch_id: "Y" }, { TAP_LAUNCH_ID: "X" }, false],
  ["conflicting pending fields refuse", { launch_id: "L", expected_clear_nonce: "L" }, { TAP_LAUNCH_ID: "L", TAP_CLEAR_ID: "L" }, false],
  // Partner review round 1 F3: the pane was replaced in place by incarnation Y; env X is stale.
  ["post-ready replacement on the same pane", { launch_witness: "Y" }, { TAP_LAUNCH_ID: "X" }, false],
  ["no token on the row", {}, { TAP_LAUNCH_ID: "X" }, false],
  ["no token in env", { launch_witness: "X" }, {}, false],
])("%s", (_name, row, e, expected) => {
  expect(launchTokenMatches({ ...PANE, ...row }, env(e))).toBe(expected);
});

test("only exactly one active row on this pane and generation qualifies", () => {
  const e = env({ TAP_LAUNCH_ID: "L" });
  expect(launchedRowForPane({ ada: { ...PANE, launch_witness: "L" } }, "%7", "srv:1:1", e)?.handle).toBe("ada");
  expect(launchedRowForPane({ ada: { ...PANE, launch_witness: "L" } }, "%8", "srv:1:1", e)).toBeNull();
  expect(launchedRowForPane({ ada: { ...PANE, launch_witness: "L" } }, "%7", "srv:2:2", e)).toBeNull();
  expect(launchedRowForPane({ ada: { ...PANE, launch_witness: "L", status: "suspended" } }, "%7", "srv:1:1", e)).toBeNull();
  expect(launchedRowForPane({ ada: { ...PANE, launch_witness: "L" }, bob: { ...PANE } }, "%7", "srv:1:1", e)).toBeNull();
  expect(launchedRowForPane(null, "%7", "srv:1:1", e)).toBeNull();
});

// A team with its own index; returns the pieces resolveLaunchEvidence reads.
function team(name: string, seats: Record<string, unknown>) {
  const root = join(WORK, name);
  const index = join(root, "index");
  mkdirSync(join(root, ".tap", "bus"), { recursive: true });
  mkdirSync(index, { recursive: true });
  const registry = join(root, ".tap", "team-registry.json");
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name }, seats }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { [name]: { root, registry_location: registry } } }));
  return { root, index, registry };
}
const inside: CallingPaneObservation = { state: "inside", paneId: "%7", session: "s", serverEpoch: "srv:1:1" };

test("resolveLaunchEvidence names the launcher's team only for a matching launched row", () => {
  const t = team("evidence-ok", { ada: { ...PANE, status_reason: "launching", launch_id: "L" } });
  const base = { TAP_INDEX_HOME: t.index, TAP_LAUNCH_ROOT: t.root };
  const hit = resolveLaunchEvidence(env({ ...base, TAP_LAUNCH_ID: "L" }), () => inside);
  expect(hit?.authority.team).toBe("evidence-ok");
  expect(hit?.root).toBe(t.root);
  // Stale token, no token, unobservable pane, other pane: no authority.
  expect(resolveLaunchEvidence(env({ ...base, TAP_LAUNCH_ID: "X" }), () => inside)).toBeNull();
  expect(resolveLaunchEvidence(env(base), () => inside)).toBeNull();
  expect(resolveLaunchEvidence(env({ ...base, TAP_LAUNCH_ID: "L" }), () => ({ state: "outside", detail: "x" }))).toBeNull();
  expect(resolveLaunchEvidence(env({ ...base, TAP_LAUNCH_ID: "L" }), () => ({ ...inside, paneId: "%8" }))).toBeNull();
});

test("a root the index does not enroll, or an unreadable registry, is no authority", () => {
  const t = team("evidence-bad", { ada: { ...PANE, launch_id: "L" } });
  const other = team("evidence-other", {});
  // Mismatched team: env names a root whose registry holds no row on this pane.
  expect(resolveLaunchEvidence(env({ TAP_INDEX_HOME: other.index, TAP_LAUNCH_ROOT: other.root, TAP_LAUNCH_ID: "L" }), () => inside)).toBeNull();
  // A root this index does not enroll.
  expect(resolveLaunchEvidence(env({ TAP_INDEX_HOME: other.index, TAP_LAUNCH_ROOT: t.root, TAP_LAUNCH_ID: "L" }), () => inside)).toBeNull();
  writeFileSync(t.registry, "{not json");
  expect(resolveLaunchEvidence(env({ TAP_INDEX_HOME: t.index, TAP_LAUNCH_ROOT: t.root, TAP_LAUNCH_ID: "L" }), () => inside)).toBeNull();
});

test("a shared caller's selected handle does not bypass automatic-capture ancestry", () => {
  const t = team("shared-child", { ada: { ...PANE, harness: "opencode", harness_session_id: "parent", instance: "ada|one" } });
  const before = readFileSync(t.registry, "utf8");
  const seen: CallingPaneObservation = { ...inside, selectedHandle: "ada", selectedInstance: "ada|one" };
  const lines = sessionContext(t.root, JSON.stringify({ session_id: "new-child", transcript_path: join(t.root, "child.jsonl") }),
    { ...process.env, TAP_INDEX_HOME: t.index }, { root: t.root, authority: { bus: join(t.root, ".tap/bus"), registry: t.registry, team: "shared-child" }, seen });
  expect(lines).toEqual([]);
  expect(readFileSync(t.registry, "utf8")).toBe(before);
});

test("the worktree guard accepts only the launcher-placed incarnation inside a team worktree", () => {
  const t = team("guard", { ada: { ...PANE, launch_witness: "L" } });
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-C", t.root, ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root");
  const wt = join(WORK, "guard-wt");
  git("worktree", "add", "-q", "--detach", wt);
  const nested = join(wt, "sub");
  mkdirSync(nested);
  const stray = join(WORK, "guard-stray");
  mkdirSync(stray);
  const ok = env({ TAP_LAUNCH_ID: "L" });
  expect(launchPlacedInWorktree(t.registry, t.root, "%7", "srv:1:1", wt, ok)).toBe(true);
  expect(launchPlacedInWorktree(t.registry, t.root, "%7", "srv:1:1", nested, ok)).toBe(true);
  // Not a worktree of the team's repository, a stale token, no token, another pane.
  expect(launchPlacedInWorktree(t.registry, t.root, "%7", "srv:1:1", stray, ok)).toBe(false);
  expect(launchPlacedInWorktree(t.registry, t.root, "%7", "srv:1:1", wt, env({ TAP_LAUNCH_ID: "X" }))).toBe(false);
  expect(launchPlacedInWorktree(t.registry, t.root, "%7", "srv:1:1", wt, env({}))).toBe(false);
  expect(launchPlacedInWorktree(t.registry, t.root, "%8", "srv:1:1", wt, ok)).toBe(false);
  // A pending relaunch qualifies before launch_workdir is recorded: membership is the repository's.
  writeFileSync(t.registry, JSON.stringify({ schema: "0.20", team: { name: "guard" }, seats: { ada: { ...PANE, launch_witness: "L", expected_clear_nonce: "N" } } }));
  expect(launchPlacedInWorktree(t.registry, t.root, "%7", "srv:1:1", wt, env({ TAP_CLEAR_ID: "N" }))).toBe(true);
  expect(launchPlacedInWorktree(t.registry, t.root, "%7", "srv:1:1", wt, ok)).toBe(false);
  expect(readFileSync(t.registry, "utf8")).toContain("expected_clear_nonce");
});

// Control: launch_witness is distinct from launch_token,
// which keeps meaning "launch in progress" for every existing reader.
test("a ready seat carrying launch_witness can still go up and down and is checked by doctor", () => {
  const ready = { session: "t/ada", status: "active", harness: "claude", delivery: "pane", pane_id: "%7", server_epoch: "srv:1:1" };
  for (const verb of ["up", "down"] as const) {
    expect(validateDurable({ ...ready, launch_witness: "w" } as never, "ada", "t", verb)).toBeTruthy();
    expect(() => validateDurable({ ...ready, launch_token: "pending" } as never, "ada", "t", verb)).toThrow("launch is in progress");
  }
  expect(observeBinding({ ...ready, launch_witness: "w" } as never).reason).not.toBe("seat is not an active pane seat");
  expect(observeBinding({ ...ready, launch_token: "pending" } as never).reason).toBe("seat is not an active pane seat");
});
