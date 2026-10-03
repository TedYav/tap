import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// tap-amfle: a CLI door that reads a pane frame from stdin is byte-transparent.
// `Bun.stdin.text()` strips a leading U+FEFF, and the Bash pipe the doors replaced
// did not, so a frame whose first row begins with U+FEFF would turn an absent
// prompt row into a readable one. Each arm drives the LIVE door through stdin
// (a string handed to the exported function never touches the decoder) and
// pairs the BOM'd frame with its bare control, so identical answers cannot pass.

const BOM = "﻿";
const src = join(import.meta.dir, "../src");
const door = (module: string, args: string[], input: string) => {
  const result = spawnSync("bun", [join(src, module), ...args], { input, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout };
};

// U+FEFF is not in the prompt-row selector's class, so a BOM-first row has no
// composer geometry: unknown / not-staged / unobservable, exactly as before the port.
const FRAME = "❯ draft text";

test("submit-frame door keeps a leading BOM: codex-composer reads no composer row", () => {
  expect(door("submit-frame.ts", ["codex-composer"], FRAME)).toEqual({ status: 0, stdout: "known:draft text" });
  expect(door("submit-frame.ts", ["codex-composer"], BOM + FRAME)).toEqual({ status: 0, stdout: "unknown" });
});

test("submit-frame door keeps a leading BOM: auto-match does not stage the draft", () => {
  expect(door("submit-frame.ts", ["auto-match", "codex", "draft text"], FRAME).stdout).toBe("yes");
  expect(door("submit-frame.ts", ["auto-match", "codex", "draft text"], BOM + FRAME).stdout).toBe("no");
});

test("submit-frame door keeps a leading BOM: submit-state is unobservable, not staged", () => {
  expect(door("submit-frame.ts", ["submit-state", "codex", "draft text"], FRAME).stdout).toBe("staged\tidle\t0");
  expect(door("submit-frame.ts", ["submit-state", "codex", "draft text"], BOM + FRAME).stdout).toBe("unobservable\tidle\t0");
});

test("submit-frame door keeps a leading BOM: sentinel-tail finds no sentinel row (exit 3)", () => {
  expect(door("submit-frame.ts", ["sentinel-tail", "claude"], FRAME)).toEqual({ status: 0, stdout: " draft text" });
  expect(door("submit-frame.ts", ["sentinel-tail", "claude"], BOM + FRAME)).toEqual({ status: 3, stdout: "" });
});

// agent-state is BOM-INSENSITIVE for claude (lane C): the band selector's `\s*`
// absorbs U+FEFF whichever way the reader decodes. The arm records that. The
// door still reads through the shared helper so every frame door decodes alike.
test("agent-state door answers the same for a BOM-first claude frame, per state", () => {
  const fixtures = join(import.meta.dir, "fixtures/agent-state/claude");
  const seen = new Set<string>();
  for (const [file, state] of [["idle.txt", "idle"], ["working.txt", "working"], ["blocked.txt", "blocked"]] as const) {
    const frame = readFileSync(join(fixtures, file), "utf8");
    const bare = door("agent-state.ts", ["claude-seat-state"], frame);
    expect(bare).toEqual({ status: 0, stdout: `${state}\n` });
    expect(door("agent-state.ts", ["claude-seat-state"], BOM + frame)).toEqual(bare);
    seen.add(bare.stdout);
  }
  expect(seen.size).toBe(3);
});
