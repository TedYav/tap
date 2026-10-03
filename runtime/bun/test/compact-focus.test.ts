import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beadsReachable, focusMode, focusNarrowing, handoffPing } from "../src/compact-focus";
import { removeScratchTree } from "./support/scratch";

function scratch() {
  if (!process.env.TAP_HOME) throw new Error("compact-focus tests require the isolated runner");
  return mkdtempSync(join(process.env.TAP_HOME, "compact-focus-"));
}

test("narrowing matches whole phrases, case-insensitively, and never inside a word", () => {
  expect(focusNarrowing("Focus ONLY on the lock order")).toBe("focus only");
  expect(focusNarrowing("keep the rest; ignore.")).toBe("ignore");
  expect(focusNarrowing("don't keep the logs")).toBe("don't keep");
  expect(focusNarrowing("omit")).toBe("omit");
  // The first phrase in list order wins, not the first in the text.
  expect(focusNarrowing("omit x, focus only y")).toBe("focus only");
  for (const clean of ["only once per run", "update .gitignore", "the registry to disk", "", "résumé ignored", "préignore"]) {
    expect(focusNarrowing(clean)).toBeNull();
  }
  // The retired Bash gate's decisions: only letters and
  // DECIMAL digits join a word, and İ lowercases to one plain i, as tr did.
  for (const hit of ["¹ignore", "Ⅰignore", "ignore₁", "İGNORE", "\u0345ignore"]) expect(focusNarrowing(hit)).toBe("ignore");
  expect(focusNarrowing("éignore")).toBeNull();
  expect(focusNarrowing("9ignore")).toBeNull();
});

test("focus mode keys on the harness family", () => {
  expect(focusMode("claude")).toBe("inline");
  expect(focusMode("/opt/bin/claude-code")).toBe("inline");
  expect(focusMode("codex")).toBe("deferred");
  expect(focusMode("opencode")).toBe("deferred");
  for (const other of ["cursor", "hermes", "agy", "bash", ""]) expect(focusMode(other)).toBe("unsupported");
});

test("beads resolve from an ancestor or BEADS_DIR, and a relative walk terminates", () => {
  const dir = scratch();
  try {
    mkdirSync(join(dir, "repo/.beads"), { recursive: true });
    mkdirSync(join(dir, "repo/src/deep"), { recursive: true });
    mkdirSync(join(dir, "plain"));
    expect(beadsReachable(join(dir, "repo/src/deep"), {})).toBe(true);
    expect(beadsReachable(join(dir, "plain"), {})).toBe(false);
    expect(beadsReachable(join(dir, "plain"), { BEADS_DIR: "/anywhere" })).toBe(true);
    // Relative: bottoms out at the cwd rather than looping on "." forever.
    expect(beadsReachable("claude", {})).toBe(beadsReachable(".", {}));
  } finally { removeScratchTree(dir); }
});

test("the resume ping is byte-identical to the retired Bash text", () => {
  const dir = scratch();
  try {
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin/bd"), "#!/bin/sh\n", { mode: 0o755 });
    const tail = " for work already claimed. If work is in progress or owed, continue it without waiting to be asked. If nothing is in progress, reply 'nothing in progress' and end the turn.";
    expect(handoffPing("/bus/handoff/x.md", "seat-a", "", "keep the lock ruling", { PATH: join(dir, "bin"), BEADS_DIR: "/b" })).toBe(
      "Post-compaction resume check. Read /bus/handoff/x.md first — it is a handoff written to you, before compacting, by the agent that still had the full context." +
      " Focus written for you BEFORE this compaction, by the agent that still had the full context: keep the lock ruling" +
      " Run 'tap poll seat-a' and settle or answer anything unsettled. Check your task list and 'bd ready'" + tail);
    // An unreachable tmux on the optional cwd probe falls back to our cwd; the
    // ping is often built after /compact already went in, so it must not throw.
    writeFileSync(join(dir, "bin/tmux"), "#!/bin/sh\nprintf 'fork failed: Device not configured\\n' >&2\nexit 1\n", { mode: 0o755 });
    const env = { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, BEADS_DIR: "/b" };
    expect(handoffPing("/h.md", "seat-a", "%7", "f", env)).toBe(handoffPing("/h.md", "seat-a", "", "f", env));
    // No bd on PATH: no bd instruction even where a database resolves.
    expect(handoffPing("", "", "", "", { PATH: join(dir, "empty"), BEADS_DIR: "/b" })).toBe(
      "Post-compaction resume check. No handoff file was written before this compaction, so treat your summary as lossy rather than authoritative. Check your task list" + tail);
  } finally { removeScratchTree(dir); }
});
