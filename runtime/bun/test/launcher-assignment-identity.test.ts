import { test, expect } from "bun:test";
import { configDefaults } from "../src/launcher/config-args";
import { pyStrip } from "../src/launcher/catalog-metadata";

/**
 * Assignment identity is decided by the key AFTER stripping, and the two
 * languages strip different sets. JS `trim()` removes U+FEFF and Python does
 * not; Python removes U+001C-U+001F and JS does not. A key padded with either is
 * a DIFFERENT key in one language and the same key in the other, which decides
 * which `-c` assignment survives -- so this is about which value reaches the
 * harness, not about text hygiene.
 *
 * Both directions are asserted, because a port can be wrong either way. An
 * ASCII-space-and-tab-only strip is wrong in a third way while passing neither
 * of these accidentally: that mutant survived 15,582 differential comparisons
 * before the corpus reached these scalars AT THE KEY POSITION.
 */
const FEFF = String.fromCharCode(0xfeff);
const NEL = String.fromCharCode(0x85);
const NBSP = String.fromCharCode(0xa0);
const FS = String.fromCharCode(0x1c);

test("U+FEFF is NOT whitespace to Python, so it makes a distinct key", () => {
  expect(pyStrip(FEFF + "k")).toBe(FEFF + "k");
  // A distinct key is not shadowed, so the earlier assignment survives.
  expect(configDefaults(["--config", FEFF + "k=1"], ["--config", "k=2"]))
    .toEqual(["--config", FEFF + "k=1"]);
});

for (const [name, ws] of [["U+0085", NEL], ["U+00A0", NBSP], ["U+001C", FS]] as const) {
  test(`${name} IS whitespace to Python, so the key matches and is shadowed`, () => {
    expect(pyStrip(ws + "k")).toBe("k");
    expect(configDefaults(["--config", ws + "k=1"], ["--config", "k=2"])).toEqual([]);
  });
}

test("pyStrip strips both ends and leaves the interior alone", () => {
  expect(pyStrip(`${NBSP} a b ${NEL}`)).toBe("a b");
  expect(pyStrip("")).toBe("");
  expect(pyStrip(NBSP + NEL + FS)).toBe("");
  // U+200B is space to NEITHER language and must survive as a real character.
  expect(pyStrip(String.fromCharCode(0x200b))).toBe(String.fromCharCode(0x200b));
});
