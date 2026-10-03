import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { enrollScratchRoot } from "./support/enroll-scratch";
import { addParams, parameters, resolveCatalog } from "../src/launcher/catalog";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function catalog(version: number | string) {
  const root = mkdtempSync("/tmp/tap-catalog-version-");
  roots.push(root);
  mkdirSync(join(root, "tap"));
  writeFileSync(join(root, "tap/config.toml"), `version = ${version}\n[presets.review]\nharness = "claude"\n[presets.review.params]\nmodel = "chosen"\n`);
  const notices: string[] = [];
  return { read: () => resolveCatalog("review", undefined, { XDG_CONFIG_HOME: root }, note => notices.push(note)),
    direct: () => resolveCatalog(undefined, "claude", { XDG_CONFIG_HOME: root }, note => notices.push(note)), notices };
}
// CONTRACT.md:1794 and the :2323 error table: the Bun launcher answers a
// REQUESTED preset in a version-1 catalog with `preset_config_retired` and
// migration guidance, while direct-harness launches stay notice-only. presets.py
// instead notices the retirement and reports `preset_not_found`, so this is a
// deliberate documented divergence -- and CONTRACT outranks the deleted program
// in the oracle order, which is why it is retained rather than ported away.
// It now lives in the launch projection over the one reader, not in a second one.
test("retired catalog version diagnoses migration instead of a missing preset", () => {
  const fixture = catalog(1);
  expect(fixture.read).toThrow("preset_config_retired");
  expect(fixture.read).toThrow("version 1 is retired; migrate the catalog to version 2 or 3");
});
// Direct-harness is the other half of that same CONTRACT sentence: notice only.
test("a retired catalog does not refuse a direct-harness launch", () => {
  const fixture = catalog(1);
  expect(fixture.direct).not.toThrow();
});
for (const version of [2, 3]) test(`supported catalog version ${version} retains its preset`, () => {
  const fixture = catalog(version);
  expect(fixture.read().preset?.params.model).toBe("chosen");
  expect(fixture.notices).toEqual([]);
});
test("newer catalog version diagnoses forward reading and retains recognized fields", () => {
  const fixture = catalog(4);
  expect(fixture.read().preset?.params.model).toBe("chosen");
  expect(fixture.notices).toHaveLength(1);
  expect(fixture.notices[0]).toContain("version 4 is newer than this reader understands (2, 3)");
});

test("retired catalog remains notice-only for a direct harness", () => {
  const fixture = catalog(1);
  expect(fixture.direct().preset).toBeUndefined();
  expect(fixture.notices).toHaveLength(1);
  expect(fixture.notices[0]).toContain("version 1 is retired");
});
test("non-integer catalog version diagnoses and reads recognized fields", () => {
  const fixture = catalog('"future"');
  expect(fixture.read().preset?.params.model).toBe("chosen");
  expect(fixture.notices).toHaveLength(1);
  expect(fixture.notices[0]).toContain("version is not an integer");
});


test("repeatable params preserve tokens while Codex assignments keep the last key from TOML", () => {
  const root = mkdtempSync("/tmp/tap-catalog-array-");
  roots.push(root);
  mkdirSync(join(root, "tap"));
  writeFileSync(join(root, "tap/config.toml"), `version = 3
[presets.fast]
harness = "codex"
params.config = ["service_tier=fast", "model_reasoning_effort=medium", "service_tier=fast", "-literal", "with spaces"]
params.empty = []
[harness.codex.params]
other = ["one", "two"]
config = ["shadowed"]
`);
  // The native launch's dry-run plan from an enrolled scratch git root (writes nothing).
  spawnSync("git", ["init", "-q", root]);
  enrollScratchRoot(root, join(root, "index"));
  const env = Object.fromEntries(Object.entries({ ...process.env, XDG_CONFIG_HOME: root, TAP_INDEX_HOME: join(root, "index"), TAP_HOME: undefined, TAP_JSON: undefined })
    .filter(([, value]) => value !== undefined)) as Record<string, string>;
  const preview = spawnSync(process.execPath, [resolve(import.meta.dir, "../src/launcher/new.ts"), "fast", "--dry-run", "--json"],
    { cwd: root, env, encoding: "utf8" });
  expect(preview.status, preview.stderr).toBe(0);
  const argv: string[] = JSON.parse(preview.stdout).argv;
  const repeated = ["--config", "model_reasoning_effort=medium",
    "--config", "service_tier=fast", "--config=-literal", "--config", "with spaces"];
  expect(argv.slice(1, 5)).toEqual(["--other", "one", "--other", "two"]);
  expect(argv.slice(5, 5 + repeated.length)).toEqual(repeated);
  expect(argv).not.toContain("shadowed");
  expect(argv).not.toContain("--empty");
});

test("repeatable params validate every value and preserve the existing flag floor", () => {
  for (const value of [[true], [1], [["nested"]], [""], [" "], ["bad\nvalue"], ["ok", false]]) {
    expect(() => parameters({ config: value })).toThrow("invalid param config");
  }
  expect(addParams(["codex", "--config=existing"], parameters({ config: ["one", "two"], quiet: true })))
    .toEqual(["codex", "--quiet", "--config=existing"]);
});

test("empty catalog recovery offers machine setup and bare harness launch", () => {
  const root = mkdtempSync("/tmp/tap-empty-catalog-"); roots.push(root);
  mkdirSync(join(root,"tap"));
  writeFileSync(join(root,"tap/config.toml"),"version=3\n[presets]\n");
  try {
    resolveCatalog("missing",undefined,{XDG_CONFIG_HOME:root},()=>{});
    throw new Error("expected missing preset");
  } catch (error: any) {
    expect(error.errorClass).toBe("preset_not_found");
    expect(error.action).toContain("tap setup --machine");
    expect(error.action).toContain("tap session launch <harness> <name>");
    expect(error.action).not.toContain("available preset (none)");
  }
  expect(resolveCatalog(undefined,"codex",{XDG_CONFIG_HOME:root},()=>{}).preset).toBeUndefined();
});
