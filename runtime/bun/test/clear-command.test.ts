// The clear-command table's one native owner (M6 U1): watch and self-rebrief
// must read the same spellings from runtime/bun/src/clear-command.ts.
import { describe, expect, test } from "bun:test";

import { clearCommand } from "../src/clear-command";

describe("clearCommand", () => {
  test("opencode* -> /new", () => {
    expect(clearCommand("opencode")).toBe("/new");
    expect(clearCommand("opencode-tui")).toBe("/new");
  });

  test("claude|codex|cursor|agy|hermes prefixes -> /clear", () => {
    for (const harness of ["claude", "codex", "cursor-agent", "agy", "hermes"]) expect(clearCommand(harness)).toBe("/clear");
  });

  test("an unlisted harness -> empty", () => {
    expect(clearCommand("shell")).toBe("");
    expect(clearCommand("mistral")).toBe("");
    expect(clearCommand("")).toBe("");
  });
});
