// ensureAscii byte-parity with python json.dumps(ensure_ascii=True): DEL (U+007F)
// must escape as \u007f, while C0 controls keep JSON.stringify's short forms.
// Regression guard for tap-u2nfe.
import { describe, expect, test } from "bun:test";
import { ensureAscii } from "../src/fsatomic";

describe("ensureAscii DEL parity (tap-u2nfe)", () => {
  test("escapes DEL the way python json.dumps does", () => {
    expect(ensureAscii(JSON.stringify(`a${String.fromCodePoint(0x7f)}b`))).toBe(`"a\\u007fb"`);
  });

  test("control: a C0 char keeps its short form", () => {
    expect(ensureAscii(JSON.stringify("a\nb"))).toBe(`"a\\nb"`);
  });
});
