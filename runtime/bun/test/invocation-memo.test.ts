import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeScratchTree } from "./support/scratch";
import { withInvocationMemo } from "../src/invocation-memo";
import { probeGitRoot } from "../src/git-root";
import { readProcessTableMemoized } from "../src/observe";

/**
 * F1 (launchfast item 2 review): the ps-table and git-root memos are scoped
 * and opt-in. Outside a `withInvocationMemo` scope both behave as fresh
 * reads — a long-lived process that re-asks after a restart must never read a
 * pre-restart table, and a `tap init` that probes around its own `git init`
 * must re-probe. Inside the scope one question is asked once.
 */
const original = { ...process.env };

function countingShimFarm(): { bin: string; scratch: string; counts: () => { git: number; ps: number } } {
  const scratch = mkdtempSync(join(tmpdir(), "tap-invocation-memo."));
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf x >> '${join(scratch, "git.count")}'\nexit 128\n`, { mode: 0o755 });
  writeFileSync(join(bin, "ps"), `#!/bin/sh\nprintf x >> '${join(scratch, "ps.count")}'\nexit 0\n`, { mode: 0o755 });
  chmodSync(join(bin, "git"), 0o755);
  chmodSync(join(bin, "ps"), 0o755);
  const count = (name: string) => {
    try { return readFileSync(join(scratch, `${name}.count`), "utf8").length; } catch { return 0; }
  };
  return { bin, scratch, counts: () => ({ git: count("git"), ps: count("ps") }) };
}

test("outside a memo scope every probe spawns fresh; inside, one; after exit, fresh again", () => {
  const farm = countingShimFarm();
  const env = { ...original, PATH: `${farm.bin}:${original.PATH}` };
  const saved = process.env.PATH;
  process.env.PATH = env.PATH;
  try {
    // Outside: two questions, two spawns.
    probeGitRoot(process.cwd());
    probeGitRoot(process.cwd());
    let git = farm.counts().git;
    expect(git, "two outside-scope git probes spawn twice").toBe(2);

    // Inside: two questions, one spawn.
    let scopedGit = 0;
    withInvocationMemo(() => {
      probeGitRoot(process.cwd());
      probeGitRoot(process.cwd());
      scopedGit = farm.counts().git;
    });
    expect(scopedGit, "inside the scope the git probe spawns once").toBe(3);

    // After the scope exits the cache is gone: the next probe spawns again.
    probeGitRoot(process.cwd());
    expect(farm.counts().git, "after the scope the next probe spawns again").toBe(4);

    // The ps table follows the same discipline.
    readProcessTableMemoized();
    readProcessTableMemoized();
    expect(farm.counts().ps, "two outside-scope ps reads spawn twice").toBe(2);
    let scopedPs = 0;
    withInvocationMemo(() => {
      readProcessTableMemoized();
      readProcessTableMemoized();
      scopedPs = farm.counts().ps;
    });
    expect(scopedPs, "inside the scope one ps read serves both").toBe(3);
    readProcessTableMemoized();
    expect(farm.counts().ps, "after the scope the next read spawns again").toBe(4);
  } finally {
    process.env.PATH = saved;
    removeScratchTree(farm.scratch);
  }
});
