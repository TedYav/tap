import { expect, test } from "bun:test";
import { frameIo, inputHasId } from "../src/pane/reader";
import { classifySubmitFrame } from "../src/submit-frame";
import { normalizeInputMatch } from "../src/terminal-text";

const id = "courier-20260906T080300Z-b0957ae8155f";
const wire = `[[TAP v0.23 note ${id}]]`;
const splitId = (separator: string) => wire.replace("b0957", `b09${separator}57`);

test("an embedded BOM cannot certify the expected input ID", () => {
  const corrupt = splitId("\uFEFF");
  expect(normalizeInputMatch(corrupt)).toContain("\uFEFF");
  expect(inputHasId(frameIo(`❯ ${corrupt}\n`, "80"), "%fixture", "claude", id)).toBe(false);
  expect(classifySubmitFrame(`› ${corrupt}\n`, "codex", wire).state).toBe("changed");
  expect(inputHasId(frameIo(`❯ ${wire}\n`, "80"), "%fixture", "claude", id)).toBe(true);
  expect(classifySubmitFrame(`› ${wire}\n`, "codex", wire).state).toBe("staged");
});

test("input ID matching retains the Python whitespace contract across wrapped IDs", () => {
  for (const separator of ["\u001c", "\u001d", "\u001e", "\u001f", "\u0085", "\n  "]) {
    expect(inputHasId(frameIo(`❯ ${splitId(separator)}\n`, "80"), "%fixture", "claude", id)).toBe(true);
  }
  expect(normalizeInputMatch("\x1b[2me\u0301\x1b[0m \t\n")).toBe("é");
});
