import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRetiredVersion, parseDocument } from "../src/launcher/catalog-listing";

/**
 * The version arm, and the one place it knowingly differs from the incumbent.
 *
 * TOML separates `1` from `1.0`; JS has one number type. `Bun.TOML.parse` hands
 * back 1 for both, so a float version takes the RETIRED branch where the
 * incumbent (pinned presets.py e368c9528, case version-float-1_0) reports
 * "version is not an integer (1.0)". That wording difference is RATIFIED: what
 * the reader DOES is identical, because `1.0 == 1` drops presets in both
 * languages, and only one notice reads differently.
 *
 * Recovering the type from the raw token was implemented and then removed. It
 * requires lexing TOML: the regex missed `"version" = 2.0`, a legal spelling of
 * the same key, and treated a `[not_a_table]` line inside a root multiline
 * string as a table header. The arms below pin the behavior that survives.
 */
const notices = (body: string): string[] => {
  const out: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "tap-version-float-"));
  mkdirSync(join(dir, "tap"), { recursive: true });
  const path = join(dir, "tap", "config.toml");
  writeFileSync(path, body);
  parseDocument(Buffer.from(body), path, message => out.push(message));
  return out;
};
const only = (body: string): string => {
  const got = notices(body);
  expect(got).toHaveLength(1);
  return got[0]!;
};

test("a float version takes the retired branch, and says so", () => {
  // The RATIFIED difference, asserted rather than left to be discovered: the
  // incumbent would say "version is not an integer (1.0)" here.
  expect(only('version = 1.0\n')).toContain("version 1 is retired");
});
test("what the reader DOES is unchanged: a float version drops presets", () => {
  // This is the half that must not diverge. `1.0 == 1` in both languages.
  expect(isRetiredVersion(Bun.TOML.parse('version = 1.0\n') as Record<string, unknown>)).toBe(false);
  expect(isRetiredVersion((Bun.TOML.parse('version = 1.0\n') as Record<string, unknown>).version)).toBe(true);
});
test("a non-integral float is still not an integer", () => {
  expect(only('version = 2.5\n')).toContain("version is not an integer (2.5)");
});
test("a supported integer version stays silent", () => {
  expect(notices('version = 3\n')).toEqual([]);
});
test("a retired integer version reports retirement", () => {
  expect(only('version = 1\n')).toContain("is retired");
});
test("a newer integer version still reports forward reading", () => {
  expect(only('version = 4\n')).toContain("newer than this reader understands");
});
test("a non-number version reports Python's repr of it", () => {
  expect(only('version = true\n')).toContain("version is not an integer (True)");
  expect(only('version = "2"\n')).toContain("version is not an integer ('2')");
});

/**
 * Whether a catalog's presets are read at all is `version == 1` in the
 * incumbent, and PYTHON's `==` is what makes it uniform. Running the pinned
 * program across nine version shapes gives exactly two that read nothing --
 * 1, 1.0 and True -- while "2", 4, 9007199254740993 and an absent version all
 * read their presets. JS agrees on 1.0 for free and disagrees only on `true`.
 */
test("the retired predicate is Python's == 1, across every shape the run covered", () => {
  for (const retired of [1, 1.0, true]) expect(isRetiredVersion(retired)).toBe(true);
  for (const kept of [2, 3, 4, 9007199254740993, "2", "1", undefined, null, false, 0])
    expect(isRetiredVersion(kept)).toBe(false);
});
