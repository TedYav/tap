// The session-start hook bounds its git probe so a git that never answers
// cannot hold a host agent's session start. The bound is opt-in per process.
// A probe cut short reads as "unobservable", never as "no repository", and the
// hook's root resolver then stays silent: with the checkout boundary unknown,
// the enrollment walk must not reach an enrolled parent above an unenrolled
// nested checkout.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundGitRootProbes, probeGitRoot } from "../src/git-root";
import { walkUpSessionRoot } from "../src/session-start";
import { removeScratchTree } from "./support/scratch";

const WORK = realpathSync(mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "git-root-bound.")));
afterAll(() => removeScratchTree(WORK));

/** A directory holding a stand-in `git`, to put first on PATH. */
function standInGit(name: string, body: string): string {
  const bin = join(WORK, name);
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, "git"), 0o755);
  return bin;
}

function withGit<T>(bin: string, boundMs: number, run: () => T): T {
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
  boundGitRootProbes(boundMs);
  try { return run(); } finally {
    boundGitRootProbes(0);
    process.env.PATH = savedPath;
  }
}

const NEVER = standInGit("git-never", "exec sleep 60");

test("a bounded git probe gives up on a git that never answers", () => {
  const started = performance.now();
  const probe = withGit(NEVER, 300, () => probeGitRoot(WORK));
  expect(probe.kind).toBe("unobservable");
  // Far below the stand-in git's 60 s, with room for a loaded machine.
  expect(performance.now() - started).toBeLessThan(20_000);
});

test("a cut-short probe silences the hook resolver instead of selecting an enrolled parent", () => {
  // An enrolled parent with an unenrolled nested checkout inside it.
  const index = join(WORK, "index");
  const parent = join(WORK, "parent");
  const child = join(parent, "nested");
  mkdirSync(index);
  mkdirSync(join(parent, ".tap"), { recursive: true });
  mkdirSync(child);
  const team = join(parent, ".tap", "team-registry.json");
  writeFileSync(team, `${JSON.stringify({ schema: "0.20", team: { name: "parent" }, seats: {} })}\n`);
  writeFileSync(join(index, "global-registry.json"), `${JSON.stringify({
    schema: "0.20", migrated: { at: "", backups: {} },
    teams: { parent: { root: parent, registry_location: team, state: "registered" } },
  })}\n`);

  // Control 1: git names the nested checkout, so the walk stops there: silence.
  const answersChild = standInGit("git-child", `printf '%s\\n' '${child}'`);
  expect(withGit(answersChild, 5_000, () => walkUpSessionRoot(child, index))).toBe("");
  // Control 2: the same git and bound resolve the enrolled parent from the parent itself.
  const answersParent = standInGit("git-parent", `printf '%s\\n' '${parent}'`);
  expect(withGit(answersParent, 5_000, () => walkUpSessionRoot(parent, index))).toBe(parent);
  // Control 3: git reports no repository, so there is no boundary and the walk reaches the parent.
  const noRepo = standInGit("git-none", "echo 'fatal: not a git repository' >&2; exit 128");
  expect(withGit(noRepo, 5_000, () => walkUpSessionRoot(child, index))).toBe(parent);
  // The case: git never answers. The boundary is unknown, so the resolver stays silent
  // from the nested checkout and from the enrolled parent alike.
  expect(withGit(NEVER, 300, () => walkUpSessionRoot(child, index))).toBe("");
  expect(withGit(NEVER, 300, () => walkUpSessionRoot(parent, index))).toBe("");
});
