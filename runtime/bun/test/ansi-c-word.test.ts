// ANSI-C $'...' decoding vs bash itself as the oracle (moved from the
// shell-body-pretool-hook smoke in the S1 port: the smoke's importlib guard
// module was the Python hook; this keeps the ground-truth comparison against
// `printf` in the Bun suite without executing any protected tool).
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";

import { ansiCWord } from "../src/lint-body";

const WORDS = [
  "$''",
  String.raw`$'kill-server'`,
  String.raw`$'\153ill\x2dserver'`,
  String.raw`$'\u0074\U0000006d\165\170'`,
  String.raw`$'a\q'`,
  String.raw`$'a\'b\\c'`,
  String.raw`$'first\0discarded'`,
  String.raw`$'\a\b\e\f\n\r\t\v\E\?\c?\cA'`,
  "$'a\\\nb'",
];

for (const word of WORDS) {
  test(`ansiCWord matches bash printf: ${JSON.stringify(word)}`, () => {
    const bash = spawnSync("bash", ["-c", `printf "%s" ${word}`], {
      timeout: 5000,
      maxBuffer: 1024,
    });
    expect(bash.status).toBe(0);
    const decoded = ansiCWord(word, 0);
    expect(decoded).not.toBeNull();
    expect(decoded![0]).toBe(word.length);
    expect(Buffer.from(decoded![1], "utf8").equals(bash.stdout)).toBe(true);
  });
}

test("unterminated ANSI-C word is not a literal span", () => {
  expect(ansiCWord("$'open", 0)).toBeNull();
  expect(ansiCWord("plain", 0)).toBeNull();
});
