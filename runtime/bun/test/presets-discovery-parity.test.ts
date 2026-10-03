import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogDisplayRows, loadPresetCatalog } from "../src/launcher/catalog-listing";
import { configDirectory, readSecureBytes } from "../src/launcher/catalog";
import { Notices } from "../src/launcher/catalog-notices";

/**
 * `tap presets` and `tap session launch` must answer the same question about the
 * same file: what can I launch.
 *
 * Discovery used to walk the raw document itself, with its own version check,
 * its own preset validation and its own `family.trim()`. The two drifted in BOTH
 * directions, and both directions are asserted below because they fail
 * differently and a fix could restore one while breaking the other:
 *
 *   - `version = true` made discovery ADVERTISE a preset the launcher refuses
 *     (`preset_not_found`). CONTRACT's §Schema tolerance names that exact shape:
 *     tolerant reading must not "advertise what cannot launch".
 *   - a `family` of U+FEFF made discovery HIDE a preset that launches, because
 *     JS `trim()` strips U+FEFF and Python's `str.isspace` does not.
 */
const machine = (body: string): NodeJS.ProcessEnv => {
  const root = mkdtempSync(join(tmpdir(), "tap-discovery-"));
  mkdirSync(join(root, "tap"), { recursive: true });
  writeFileSync(join(root, "tap", "config.toml"), body);
  return { XDG_CONFIG_HOME: root } as NodeJS.ProcessEnv;
};
const both = (env: NodeJS.ProcessEnv) => {
  const notices = new Notices(() => {});
  const catalog = notices.quietly(() =>
    loadPresetCatalog(env, notices.sink, readSecureBytes, configDirectory(env), existsSync));
  return {
    launchable: [...catalog.presets.keys()].sort(),
    shown: catalogDisplayRows(catalog).map(r => r.name),
  };
};

const FEFF = String.fromCharCode(0xfeff);

for (const [label, body] of [
  ["a retired version reads no presets", 'version = 1\n[presets.review]\nharness = "claude"\n'],
  ["a float version reads no presets", 'version = 1.0\n[presets.review]\nharness = "claude"\n'],
  ["a boolean version reads no presets", 'version = true\n[presets.review]\nharness = "claude"\n'],
  ["a supported version reads them", 'version = 3\n[presets.review]\nharness = "claude"\n'],
  ["an absent version reads them", '[presets.review]\nharness = "claude"\n'],
  ["a U+FEFF family is a real family", `version = 3\n[presets.review]\nharness = "claude"\nfamily = "${FEFF}"\n`],
  ["a dropped preset is neither shown nor launchable", 'version = 3\n[presets.ok]\nharness = "claude"\n[presets.bad]\nharness = "nope"\n'],
] as const) {
  test(`discovery and launch agree: ${label}`, () => {
    const { launchable, shown } = both(machine(body));
    expect(shown).toEqual(launchable);
  });
}

// The two specimens, asserted by VALUE as well as by agreement -- so a future
// change that makes both sides wrong in the same way still reds.
test("a boolean version advertises nothing, because nothing launches", () => {
  const { launchable, shown } = both(machine('version = true\n[presets.review]\nharness = "claude"\n'));
  expect(launchable).toEqual([]);
  expect(shown).toEqual([]);
});
test("a U+FEFF family neither hides the preset nor makes it unlaunchable", () => {
  const { launchable, shown } = both(
    machine(`version = 3\n[presets.review]\nharness = "claude"\nfamily = "${FEFF}"\n`));
  expect(launchable).toEqual(["review"]);
  expect(shown).toEqual(["review"]);
});
