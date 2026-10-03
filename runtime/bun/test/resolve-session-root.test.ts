import { afterAll, expect, test } from "bun:test";
import { resolveSessionAuthority, walkUpSessionRoot } from "../src/session-start";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeScratchTree } from "./support/scratch";

// Ported from skills/tap/scripts/smoke/resolve-session-root.test.sh: the
// SessionStart ROOT-discovery gate. The function arms drive
// resolveSessionAuthority (exact) and walkUpSessionRoot (walk) with the index
// home as the explicit argument. The CLI arm below spawns the module the way
// its installed wrapper does, which is the arm that covers the env-derived
// index home (the CLI passes none in-process), argv dispatch, and rc 0 on
// silence.
//
// The gate: exactly one non-historical enrolled team whose root realpaths to
// ROOT and whose registry_location is a readable file. A bus registry.json,
// a mere .tap/, or nothing at all establishes no root — silence, not error.
//
// Scratch allocation: the fixture tree lives only beneath the runner-owned
// scratch root. runtime/bun/test/run.sh builds WORK under ${TMUX_TMPDIR:-/tmp}
// and exports TMUX_TMPDIR=$WORK/tmux to the test process, so TMUX_TMPDIR is
// the one root the runner hands down; this file refuses to run without it and
// asserts containment, so a reverted tmpdir() allocation fails the suite
// instead of silently leaking into /tmp.

const RUNNER_ROOT = process.env.TMUX_TMPDIR;
if (!RUNNER_ROOT) {
  throw new Error(
    "resolve-session-root.test.ts: TMUX_TMPDIR is unset — this fixture allocates only beneath the supported runner's scratch root (runtime/bun/test/run.sh exports it); refusing to write outside it",
  );
}
const WORK = mkdtempSync(join(RUNNER_ROOT, "tap-resolveroot."));
afterAll(() => removeScratchTree(WORK));

test("the fixture tree stays beneath the runner-owned scratch root", () => {
  expect(realpathSync(WORK).startsWith(realpathSync(RUNNER_ROOT) + "/")).toBe(true);
});

const SCHEMA = "0.20";

interface Fixture {
  index: string;
  path: string;
}

function fixture(name: string): Fixture {
  const root = join(WORK, name);
  const index = join(root, "index");
  mkdirSync(index, { recursive: true });
  return { index, path: root };
}

/** The machine-index marker. Fixture writer only: the resolver reads strict
 *  UTF-8 JSON and classifies the file kind itself, so formatting is free. */
function writeMarker(f: Fixture, teams: Record<string, unknown>): void {
  const doc = { schema: SCHEMA, migrated: { at: "", backups: {} }, teams };
  writeFileSync(join(f.index, "global-registry.json"), `${JSON.stringify(doc, null, 2)}\n`);
}

function enroll(f: Fixture, team: string, root: string, location: string): void {
  writeMarker(f, { [team]: { root, registry_location: location, state: "registered" } });
}

/** The `resolve exact <path>` door: print the path when it is a session root. */
function exact(f: Fixture, p: string): string {
  return resolveSessionAuthority(p, f.index) ? p : "";
}

/** The `resolve walk <path>` door: print the enrolled root, or nothing. */
function walk(f: Fixture, p: string): string {
  return walkUpSessionRoot(p, f.index);
}

test("an absent marker ignores a bus registry.json: a bus alone is no root", () => {
  const f = fixture("absent-marker");
  // The pre-flip presence gate is gone: with no machine index nothing is
  // enrolled, and a .tap/bus/registry.json must not stand in for enrollment.
  mkdirSync(join(f.path, ".tap", "bus"), { recursive: true });
  writeFileSync(join(f.path, ".tap", "bus", "registry.json"), "{}\n");
  const sub = join(f.path, "subdir");
  mkdirSync(sub);
  // Silence must come from the rule, not a crash: walk still answers "".
  expect(walk(f, sub)).toBe("");
  expect(exact(f, f.path)).toBe("");
});

test("an enrolled location wins over mere .tap/, and unenrolled .tap/ silences", () => {
  const f = fixture("postflip");
  const post = join(f.path, "post");
  mkdirSync(join(post, ".tap"), { recursive: true });
  mkdirSync(join(post, "tmp", "tap", "payloads"), { recursive: true });
  const team = join(post, ".tap", "team-registry.json");
  writeFileSync(team, `${JSON.stringify({ schema: SCHEMA, team: { name: "post" }, seats: {} })}\n`);
  enroll(f, "post", post, team);
  expect(walk(f, post)).toBe(realpathSync(post));
  expect(exact(f, post)).toBe(post);
  // Mere .tap/ without enrollment must NOT win: wipe the teams map.
  writeMarker(f, {});
  expect(walk(f, post)).toBe("");
});

test("a live marker with an unenrolled tree silences both doors", () => {
  const f = fixture("unenrolled");
  const empty = join(f.path, "empty");
  mkdirSync(join(empty, "src"), { recursive: true });
  enroll(f, "elsewhere", join(f.path, "not-this-tree"), join(f.path, "reg.json"));
  expect(walk(f, join(empty, "src"))).toBe("");
  expect(exact(f, empty)).toBe("");
});

test("enrolled but unreadable registry_location fails closed on both doors", () => {
  const f = fixture("unreadable");
  const root = join(f.path, "root");
  mkdirSync(root, { recursive: true });
  enroll(f, "post", root, join(f.path, "gone.json"));
  expect(exact(f, root)).toBe("");
  expect(walk(f, root)).toBe("");
});

const SESSION_START = join(import.meta.dir, "../src/session-start.ts");

/** The installed wrapper's shape (install.sh / install-manifest.ts):
 *  `exec bun .../session-start.ts resolve "$@"` — the index home from the
 *  environment, a hit on stdout, and rc 0 on silence. A minimal environment,
 *  as the deleted shell fixture pinned it with env -i. */
function cliResolve(mode: "exact" | "walk", p: string, f: Fixture): { stdout: string; exitCode: number | null } {
  const r = Bun.spawnSync(
    [process.execPath, SESSION_START, "resolve", mode, p],
    { env: { PATH: process.env.PATH ?? "", HOME: WORK, TAP_INDEX_HOME: f.index } },
  );
  return { stdout: r.stdout.toString().replace(/\n$/, ""), exitCode: r.exitCode };
}

test("the installed CLI door dispatches argv, reads the index from env, and exits 0 on silence", () => {
  const f = fixture("cli");
  const post = join(f.path, "post");
  mkdirSync(join(post, ".tap"), { recursive: true });
  const sub = join(post, "subdir");
  mkdirSync(sub, { recursive: true });
  const team = join(post, ".tap", "team-registry.json");
  writeFileSync(team, `${JSON.stringify({ schema: SCHEMA, team: { name: "post" }, seats: {} })}\n`);
  enroll(f, "post", post, team);
  // walk ascends from the subdir to the enrolled root; exact answers only for
  // the root itself. The pair discriminates the modes even where the fixture
  // path has no symlink segment.
  expect(cliResolve("walk", sub, f)).toEqual({ stdout: realpathSync(post), exitCode: 0 });
  expect(cliResolve("exact", sub, f)).toEqual({ stdout: "", exitCode: 0 });
  expect(cliResolve("walk", post, f)).toEqual({ stdout: realpathSync(post), exitCode: 0 });
  expect(cliResolve("exact", post, f)).toEqual({ stdout: post, exitCode: 0 });
  // Silence is a genuine answer, not a crash: no enrollment, no output, rc 0.
  writeMarker(f, {});
  expect(cliResolve("walk", sub, f)).toEqual({ stdout: "", exitCode: 0 });
  expect(cliResolve("exact", post, f)).toEqual({ stdout: "", exitCode: 0 });
});
