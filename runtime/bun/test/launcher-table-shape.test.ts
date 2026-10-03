import { expect, test } from "bun:test";
import { table } from "../src/launcher/catalog";
import { jsonSafe } from "../src/launcher/catalog-metadata";

// TOML has first-class date scalars. `typeof aDate === "object"` is true and
// `Object.keys(aDate)` is empty, so a date read as a table looks like an EMPTY
// table -- and the precedence path classifies an empty [presets] as vacant and
// falls back to the legacy catalog. That is the one thing that branch must never
// do for a wrong-shape value: it answers a botched migration by telling the
// operator to perform the migration they just attempted.
/**
 * TOML date scalars are not parseable by every Bun the installer accepts.
 *
 * `install.sh` enforces no Bun version floor, and before 1.2.x `Bun.TOML.parse`
 * rejects `1979-05-27` outright. These tests must therefore be correct on BOTH
 * kinds of runtime -- and they say so with assertions rather than with a skip.
 *
 * A skip would be a hole with a label: the suite runner rejects undeclared skip
 * output precisely because a quiet skip is indistinguishable from coverage that
 * was never there. An earlier version of this file used `test.skipIf` and reddened
 * `bun-launcher` and `bun-router` for exactly that reason. Branching INSIDE the
 * assertion keeps one executed test per behavior on every runtime.
 *
 * The property is the same either way: a date literal must never reach a caller
 * as something table-shaped. A parser that refuses the document satisfies that
 * by never producing a date at all.
 */
const parsesDates = (() => {
  try { Bun.TOML.parse("d = 1979-05-27\n"); return true; } catch { return false; }
})();

test("a runtime either refuses a date literal, or hands one back that is not a table", () => {
  const src = "presets = 1979-05-27\nstamp = 1979-05-27T07:32:00\n[real]\nx = 1\n";
  if (!parsesDates) {
    // No date support: the document is refused, so no date can be mistaken for
    // a table. That IS the property, satisfied a different way.
    expect(() => Bun.TOML.parse(src)).toThrow();
    return;
  }
  const document = Bun.TOML.parse(src) as Record<string, unknown>;
  // Not `instanceof Date`: Bun returns Temporal PlainDate/PlainDateTime. An
  // earlier fix here excluded `Date` by name, looked correct, and caught
  // nothing -- which is why the predicate asks what the value IS.
  expect(document.presets instanceof Date).toBe(false);
  expect(table(document.presets)).toBe(false);
  expect(table(document.stamp)).toBe(false);
  expect(table(document.real)).toBe(true);
});

test("a table is still a table, including a null-prototype one", () => {
  expect(table({ a: 1 })).toBe(true);
  expect(table(Object.create(null))).toBe(true);
  expect(table([])).toBe(false);
  expect(table(null)).toBe(false);
  expect(table("x")).toBe(false);
});

// Being unable to ACT as a table and being unable to TRAVEL as data are
// different questions: passthrough promises the operator that what they wrote
// reaches the reading model, and a date carried as an annotation still must.
test("a date still serializes when carried as an inert annotation value", () => {
  if (!parsesDates) {
    expect(() => Bun.TOML.parse("d = 1979-05-27\n")).toThrow();
    return;
  }
  const document = Bun.TOML.parse("d = 1979-05-27\n") as Record<string, unknown>;
  expect(jsonSafe(document.d)).toBe("1979-05-27");
  expect(JSON.stringify(jsonSafe({ nested: document.d }))).toBe('{"nested":"1979-05-27"}');
});
