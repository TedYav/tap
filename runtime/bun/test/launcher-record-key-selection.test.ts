import { expect, test } from "bun:test";
import { recordKeySelection } from "../src/launcher/records";
import { PyInt } from "../src/spool-publication";

// Selection outcomes pinned before the Python selector was removed (00160f752).
// Cwd filtering belongs to resume's record lookup and is covered by launcher-resume-records.
const row = (extra: Record<string, unknown> = {}) => ({ name: "elsewhere", harness: "claude", base: "scope", tag: null, index: null, ...extra });
const huge = new PyInt("1208925819614629174706179");
const cases: [string, Record<string, unknown>[], string, number | null][] = [
  ["empty", [], "seat", null],
  ["missing", [row()], "seat", null],
  ["exact-before-handle", [row({ tag: "seat" }), row({ name: "seat", harness: "codex" })], "seat", 1],
  ["first-exact", [row({ name: "seat" }), row({ name: "seat", harness: "codex" })], "seat", 0],
  ["first-handle", [row({ tag: "seat" }), row({ tag: "seat" })], "seat", 0],
  ["authoritative-tag", [row({ name: "scope/vessel", tag: "seat" })], "seat", 0],
  ["tag-hides-slash", [row({ name: "scope/vessel", tag: "seat" })], "vessel", null],
  ["null-tag-slash", [row({ name: "scope/seat" })], "seat", 0],
  ["empty-tag-slash", [row({ name: "scope/seat", tag: "" })], "seat", 0],
  ["empty-tag-harness", [row({ tag: "" })], "claude", 0],
  ["null-tag-harness", [row()], "claude", 0],
  ["slash-ignores-index", [row({ name: "scope/seat", index: 7 })], "seat", 0],
  ["indexed-tag", [row({ tag: "seat", index: 7 })], "seat-7", 0],
  ["huge-tag", [row({ tag: "seat", index: huge })], `seat-${huge.source}`, 0],
  ["huge-harness", [row({ index: huge })], `claude-${huge.source}`, 0],
  ["normalized-base", [row({ name: "odd-base/seat", base: " odd base " })], "seat", 0],
  ["unicode", [row({ name: "scope/席😀" })], "席😀", 0],
  ["numeric-looking-key", [row({ name: "7" }), row({ name: "2", tag: "7" })], "7", 0],
];
for (const index of [null, 0, 1, -1]) cases.push([`index-${index}`, [row({ tag: "seat", index })], "seat", 0]);
for (const [label, rows, key, expected] of cases) test(`record key selection: ${label}`, () => {
  const before = rows.map(record => ({ ...record }));
  expect(recordKeySelection(rows, key)).toBe(expected);
  expect(rows).toEqual(before);
});

test("malformed native requests refuse instead of becoming no-match", () => {
  for (const [rows, key] of [[{}, "seat"], [[], null], ...[
    { name: null }, { base: [] }, { harness: false }, { tag: 0 }, { index: true }, { index: 1.5 },
  ].map(change => [[row(change)], "seat"])]) {
    expect(() => recordKeySelection(rows, key)).toThrow("invalid record key selection request");
  }
});
