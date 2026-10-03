import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parsePresetCatalog } from "../src/launcher/catalog-listing";
import { HARNESSES } from "../src/launcher/catalog";

const path = join(resolve(import.meta.dir, "../../.."), "skills/tap/config/example-operator-config.toml");

test("the example operator config is a valid version-3 catalog that covers every harness", () => {
  const notices: string[] = [];
  const catalog = parsePresetCatalog(readFileSync(path), path, "example", line => notices.push(line));
  expect(notices).toEqual([]);
  expect(catalog.presets.size).toBeGreaterThan(30);
  expect([...new Set([...catalog.presets.values()].map(preset => preset.harness))].sort()).toEqual([...HARNESSES].sort());
  const document = Bun.TOML.parse(readFileSync(path, "utf8")) as any;
  expect(document.version).toBe(3);
  // Every role a preset names is defined in the example's own vocabulary.
  for (const [name, preset] of Object.entries(document.presets) as [string, any][]) {
    for (const field of ["primary_roles", "secondary_roles", "avoid_roles"]) {
      for (const role of preset.metadata?.[field] ?? []) expect(Object.keys(document.roles), `${name}.${field}`).toContain(role);
    }
  }
});

test("the example carries no machine-specific path, address or credential-shaped value", () => {
  const text = readFileSync(path, "utf8");
  expect(text).toContain("It is NOT the best or the only way to configure TAP");
  for (const shape of [/\/Users\/|\/home\//, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, /(?:api[_-]?key|secret|password|token)\s*=/i]) expect(text).not.toMatch(shape);
  // Every environment value is a small tuning scalar, never a location or a credential.
  for (const preset of Object.values((Bun.TOML.parse(text) as any).presets) as any[]) {
    for (const value of Object.values(preset.env ?? {})) expect(String(value)).toMatch(/^[A-Za-z0-9]{1,12}$/);
  }
});
