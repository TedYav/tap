// Two-repository nested-root parity control for the selector walk (tap-1t0h.1).
//
// The planner probe showed the nested
// walk GREEN on BOTH sides before U1: the Bun `selectCaller` walk and the Bash
// `tap_authority_context` walk agree at a two-repo boundary. A
// later fix bounded the Bun walk at the checkout's git toplevel; `selector.test.ts`
// covers same-repository nested roots only. This file adds the missing arm:
// an inner repo with its OWN git toplevel nested inside an enrolled outer, and
// an unenrolled linked worktree of that inner repo.
//
// These are parity controls, labelled GREEN-before — NOT a RED-first defect.
// `worktreeTeamRoot` arms at the bottom are new in U1 and assert the
// across-repos rule: a basename scan never crosses into another repo.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { globalRegistryPath } from "../src/index-home";
import { selectCaller, SelectorError } from "../src/selector";
import { boundWorktreeRoot, worktreeTeamRoot } from "../src/team-selection";
import { TapError } from "../src/context";
import { removeScratchTree } from "./support/scratch";

const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) {
    removeScratchTree(path);
  }
});

function work() {
  const dir = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "tap-selector-nested."));
  scratch.push(dir);
  const index = join(dir, "index");
  mkdirSync(index, { recursive: true });
  return { dir, index };
}

function envFor(index: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TAP_INDEX_HOME: index };
  delete env.TAP_HOME;
  delete env.TAP_REGISTRY;
  return env;
}

function writeRegistry(path: string, team: string, root: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    schema: "0.20",
    team: { name: team, worktree_root: root },
    seats: {},
  }));
}

function enroll(index: string, root: string, team: string) {
  const registry = join(root, ".tap", "team-registry.json");
  writeRegistry(registry, team, root);
  mkdirSync(join(root, ".tap", "bus"), { recursive: true });
  let teams: Record<string, unknown> = {};
  try {
    teams = (JSON.parse(readFileSync(globalRegistryPath(index), "utf8")) as { teams?: Record<string, unknown> }).teams ?? {};
  } catch { /* first enroll */ }
  teams[team] = {
    enrolled_at: "2026-09-01T00:00:00Z",
    registry_location: registry,
    root,
    state: "registered",
  };
  writeFileSync(globalRegistryPath(index), JSON.stringify({ schema: "0.20", migrated: {}, teams }));
  return registry;
}

function errClass(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof SelectorError) return error.errorClass;
    if (error instanceof TapError) return error.errorClass;
    throw error;
  }
  throw new Error("expected refusal");
}

/** The probe layout: enrolled outer repo, enrolled inner repo with its own
 *  git toplevel at outer/trees/inner, unenrolled linked worktree at
 *  outer/trees/inner-wt. */
function nestedLayout() {
  const { dir, index } = work();
  const outer = join(dir, "outer");
  const inner = join(outer, "trees", "inner");
  const wt = join(outer, "trees", "inner-wt");
  mkdirSync(inner, { recursive: true });
  const init = (cwd: string) => {
    const r = spawnSync("git", ["init", "-q", cwd], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git init failed: ${r.stderr}`);
  };
  init(outer);
  init(inner);
  const commit = spawnSync("git", [
    "-C", inner, "-c", "user.email=p@x", "-c", "user.name=p", "commit", "-q", "--allow-empty", "-m", "init",
  ], { encoding: "utf8" });
  if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr}`);
  const wadd = spawnSync("git", ["-C", inner, "worktree", "add", "-q", wt, "-b", "wt"], { encoding: "utf8" });
  if (wadd.status !== 0) throw new Error(`git worktree add failed: ${wadd.stderr}`);
  const sub = join(inner, "sub");
  mkdirSync(sub, { recursive: true });
  enroll(index, outer, "outer-team");
  enroll(index, inner, "inner-team");
  return { index, outer, inner, wt, sub };
}

describe("two-repository nested walk (probe parity, GREEN-before)", () => {
  test("outer/inner/inner-sub answer; unenrolled linked worktree refuses", () => {
    const { index, outer, inner, wt, sub } = nestedLayout();
    expect(selectCaller({ cwd: outer, env: envFor(index) }).team).toBe("outer-team");
    expect(selectCaller({ cwd: inner, env: envFor(index) }).team).toBe("inner-team");
    expect(selectCaller({ cwd: sub, env: envFor(index) }).team).toBe("inner-team");
    expect(selectCaller({ cwd: sub, env: envFor(index) }).source).toBe("cwd");
    expect(errClass(() => selectCaller({ cwd: wt, env: envFor(index) }))).toBe("unanchored_bus");
  });
});

describe("worktreeTeamRoot diagnostics (new in U1)", () => {
  test("finds the linked worktree by basename from its OWN repo, never across repos", () => {
    const { inner, outer, wt } = nestedLayout();
    // git reports resolved paths (/tmp → /private/tmp on macOS), and the twin
    // echoes git's output verbatim — so the expectation is resolved too.
    const found = worktreeTeamRoot("inner-wt", inner);
    expect(found.state).toBe("found");
    expect(found.root).toBe(realpathSync(wt));
    // Across-repos arm: scanning from the OUTER repo must not find the inner
    // repo's linked worktree — the scan is bounded by the sender's repo.
    const across = worktreeTeamRoot("inner-wt", outer);
    expect(across.state).toBe("missing");
    expect(across.root).toBe("");
  });

  test("REAL ambiguity: two linked worktrees sharing one basename under one repo", () => {
    // The old test's "ambiguity" label never constructed two matches. This
    // layout does: inner gets a SECOND linked worktree also named inner-wt
    // (under outer/other), so one `git worktree list` from inner lists two
    // same-basename paths and the scan must refuse rather than pick.
    const { dir, index } = work();
    const outer = join(dir, "outer");
    const inner = join(outer, "trees", "inner");
    mkdirSync(inner, { recursive: true });
    const init = (cwd: string) => {
      const r = spawnSync("git", ["init", "-q", cwd], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git init failed: ${r.stderr}`);
    };
    init(outer);
    init(inner);
    const commit = spawnSync("git", [
      "-C", inner, "-c", "user.email=p@x", "-c", "user.name=p", "commit", "-q", "--allow-empty", "-m", "init",
    ], { encoding: "utf8" });
    if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr}`);
    const wt1 = join(outer, "trees", "inner-wt");
    const wt2 = join(outer, "other", "inner-wt");
    for (const [path, branch] of [[wt1, "wt"], [wt2, "wt2"]] as const) {
      const wadd = spawnSync("git", ["-C", inner, "worktree", "add", "-q", path, "-b", branch], { encoding: "utf8" });
      if (wadd.status !== 0) throw new Error(`git worktree add failed: ${wadd.stderr}`);
    }
    enroll(index, inner, "inner-team");
    const scan = worktreeTeamRoot("inner-wt", inner);
    expect(scan.state).toBe("ambiguous");
    expect(scan.root).toBe("");
    // Both same-basename worktrees are named in the diagnostic, Python-scan parity.
    expect(scan.detail).toContain(realpathSync(wt1));
    expect(scan.detail).toContain(realpathSync(wt2));
    // A unique basename still resolves.
    const unique = worktreeTeamRoot("inner", inner);
    expect(unique.state).toBe("found");
    expect(unique.root).toBe(realpathSync(inner));
  });

  test("missing lists sibling basenames; ERROR is its own state, not a miss", () => {
    const { inner } = nestedLayout();
    const miss = worktreeTeamRoot("no-such-team", inner);
    expect(miss.state).toBe("missing");
    expect(miss.detail).toContain("inner-wt");
    expect(miss.root).toBe("");
    // Unusable spawn (no such repo) must surface ERROR with the git reason —
    // never silently hide as a missing sibling (u1 round-1, r4045876930).
    const err = worktreeTeamRoot("inner-wt", join(inner, "does-not-exist"));
    expect(err.state).toBe("error");
    expect(err.detail).toContain("git worktree list failed");
    const empty = worktreeTeamRoot("", "/tmp");
    expect(empty.state).toBe("missing");
    expect(worktreeTeamRoot("inner-wt", "").state).toBe("missing");
  });
});

describe("boundWorktreeRoot state polarity (u1 round-1, r4045876920)", () => {
  test("parsed registry answers ok — bound root or legitimately empty", () => {
    const { index } = work();
    const reg = join(index, "reg.json");
    writeRegistry(reg, "t1", "/bound/root");
    expect(boundWorktreeRoot(reg)).toEqual({ state: "ok", root: "/bound/root" });
    writeFileSync(reg, JSON.stringify({ schema: "0.20", team: { name: "t2" }, seats: {} }));
    expect(boundWorktreeRoot(reg)).toEqual({ state: "ok", root: "" });
    writeFileSync(reg, JSON.stringify({ schema: "0.20", seats: {} }));
    expect(boundWorktreeRoot(reg)).toEqual({ state: "ok", root: "" });
  });

  test("unreadable registry answers error — invalid UTF-8 and BOM, not empty-ok", () => {
    const { index } = work();
    const reg = join(index, "reg.json");
    // One invalid byte anywhere fails the whole strict decode (incumbent
    // polarity) — the old body answered "" here, indistinguishable from unbound.
    writeFileSync(reg, Buffer.concat([
      Buffer.from('{"team":{"worktree_root":"/x"},"trailing":'),
      Buffer.from([0xe9]),
      Buffer.from([0x00]),
    ]));
    expect(boundWorktreeRoot(reg)).toEqual({ state: "error", root: "" });
    // BOM-prefixed JSON: the strict decoder keeps the BOM, JSON.parse refuses.
    writeFileSync(reg, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(JSON.stringify({ schema: "0.20", team: { name: "t", worktree_root: "/x" }, seats: {} })),
    ]));
    expect(boundWorktreeRoot(reg)).toEqual({ state: "error", root: "" });
  });
});

// Ported from index-resolve-read-only.test.sh arm 3: EXACT CLI arity — extra
// operands are a usage error at exit 2, never silently ignored input; the
// exact-operand call completes at exit 0 (u1 round-1 finding 2).
describe("team-selection CLI arity (subprocess, process boundary)", () => {
  test("exact operands exit 0; one extra operand exits 2 on every op that takes them", () => {
    const root = mkdtempSync(join(tmpdir(), "tap-ts-arity."));
    scratch.push(root);
    const run = (args: string[]): number | null =>
      spawnSync(process.execPath, [join(import.meta.dir, "../src/team-selection.ts"), ...args],
        { encoding: "utf8" }).status;
    // Exact operand counts complete (worktree-root answers even when the scan
    // errors — the result file carries the state, the exit stays 0).
    expect(run(["worktree-root", "--result", join(root, "ok.bin"), "--", "A", "B"])).toBe(0);
    // One extra operand is usage, not ignored input.
    expect(run(["worktree-root", "--result", join(root, "bad.bin"), "--", "A", "B", "C"])).toBe(2);
    expect(run(["resolve-team", "--result", join(root, "bad2.bin"), "--", "A", "B"])).toBe(2);
  });
});
