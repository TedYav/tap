import { afterAll, expect, test } from "bun:test";
import { resolveCatalog } from "../src/launcher/catalog";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dir, "../../..");
const work = realpathSync(mkdtempSync(join(tmpdir(), "presets-view-")));
afterAll(() => rmSync(work, { recursive: true, force: true }));
let index = 0;
function fixture(config?: string, legacy?: string) {
  const dir = join(work, String(index++));
  mkdirSync(join(dir, "tap"), { recursive: true });
  for (const [name, text] of [["config.toml", config], ["presets.toml", legacy]] as const) {
    if (text !== undefined) { writeFileSync(join(dir, "tap", name), text); chmodSync(join(dir, "tap", name), 0o600); }
  }
  return dir;
}
function run(dir: string, args = ["--json"], entry = join(root, "bin/tap")) {
  const result = Bun.spawnSync([entry, "presets", ...args], { env: { ...process.env, XDG_CONFIG_HOME: dir }, cwd: work });
  expect(result.exitCode).toBe(0);
  return { out: result.stdout.toString(), err: result.stderr.toString() };
}
// Captured from the Python display probe before retiring it. The fixture pins
// the values independently of the native reader; only its scratch path varies.
const oracle = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/presets-display-oracle.json"), "utf8"));
let referenceIndex = 0;
afterAll(() => expect(referenceIndex).toBe(oracle.cases.length));
function reference(dir: string) {
  const value = oracle.cases[referenceIndex++];
  expect(value).toBeDefined();
  const parsed = JSON.parse(JSON.stringify(value).replaceAll("@ROOT@", work));
  // The frozen oracle predates the family column. Its expected family is projected
  // from the raw fixture independently of the reader: an explicit
  // metadata.model_family, else the vendor a single-vendor harness implies.
  let raw: any = {};
  try { raw = Bun.TOML.parse(readFileSync(join(dir, "tap", "config.toml"), "utf8")); } catch { /* legacy or broken fixtures have no explicit keys */ }
  const implied: Record<string, string> = { claude: "anthropic", codex: "openai", agy: "google" };
  for (const row of parsed.presets ?? []) row.family = raw.presets?.[row.name]?.metadata?.model_family ?? implied[row.harness] ?? null;
  return parsed;
}
const valid = 'version=3\n[presets.zed]\nharness="codex"\n[presets.alpha]\nharness="claude"\nparams.model="opus"\ndescription="  hello\\nforged\\trow\\u007f  "\nmetadata.primary_roles=["reviewer", "leader"]\n';
for (const [name, config, legacy] of [
  ["sorted rich and sparse", valid],
  ["missing"],
  ["vacant", "version=3\n[presets]"],
  ["absent section", "version=3"],
  ["vacant legacy fallback", "version=3\n[presets]", valid],
  ["harness policy legacy fallback", 'version=3\n[harness.codex]\nparams.model="test"', valid],
  ["legacy alone", undefined, valid],
  ["non-table authority", 'version=3\npresets=["bad"]', valid],
  ["broken authority", "invalid [[[", valid],
  ["broken legacy", undefined, "invalid [[["],
  ["retired", valid.replace("version=3", "version=1")],
  ["future", valid.replace("version=3", "version=42")],
  ["noninteger version", valid.replace("version=3", 'version="later"')],
  ["tolerant rows", valid + '\n[presets.codex]\nharness="codex"\n[presets."bad name"]\nharness="claude"\n[presets.unknown]\nharness="unknown"\n[presets.secret]\nharness="codex"\nenv.API_KEY="private-value"\n[presets.invalid]\nharness="codex"\nparams.model=true\n[presets.list]\nharness="codex"\nparams.model=["first","second"]\n[presets.unknownkey]\nharness="claude"\nunknown="x"\n'],
  ["ambiguous metadata", 'version=3\n[presets.a]\nharness="codex"\nmetadata.primary_roles=["reviewer","reviewer","leader","executor","undefined","bad\\n"]\nmetadata.secondary_roles=["leader"]'],
  ["invalid metadata array", 'version=3\n[presets.a]\nharness="codex"\nmetadata.primary_roles=["reviewer",1]'],
] as [string, string?, string?][]) {
  test(`frozen discovery contract: ${name}`, () => {
    const dir = fixture(config, legacy);
    expect(JSON.parse(run(dir).out)).toEqual(reference(dir));
  });
}

// The incumbent strips the description cell with `str.strip()`, and every arm
// above pads with ASCII spaces, which `trim()` also strips -- so they prove that
// SOMETHING strips, not WHICH strip. These two do: the sets disagree in both
// directions, U+FEFF (JS strips, Python does not) and the file separator U+001C
// (Python strips, JS does not). Each arm asserts the literal expected cell as
// well as parity, because two engines that both failed to reach the property
// would agree vacuously and report a green.
for (const [label, padded, expected] of [
  ["U+FEFF is not Python whitespace", "﻿hello﻿", "﻿hello﻿"],
  ["U+001C is Python whitespace", "\\u001Chello\\u001C", "hello"],
  // The THIRD divergence class, from a reviewer: U+0085 NEXT LINE is a C1
  // control that Python's `str.isspace()` accepts and ECMAScript's `trim()` does
  // not (it is in neither the WhiteSpace nor the LineTerminator production).
  // `PY_SPACE` already carries \x85, so production was correct -- this closes the
  // coverage across all three classes: Cf (U+FEFF), C0 (U+001C), C1 (U+0085).
  ["U+0085 is Python whitespace", "\\u0085hello\\u0085", "hello"],
] as [string, string, string][]) {
  test(`description strips the way str.strip() does: ${label}`, () => {
    const dir = fixture(`version=3\n[presets.a]\nharness="codex"\ndescription="${padded}"\n`);
    const rows = JSON.parse(run(dir).out);
    expect(rows.presets.map((row: { description: string }) => row.description)).toEqual([expected]);
    expect(rows).toEqual(reference(dir));
  });
}

test("text flattens C0 and DEL while JSON retains description", () => {
  const dir = fixture(valid);
  const text = run(dir, []).out;
  expect(text.split("\n").filter(line => line.startsWith("forged"))).toEqual([]);
  expect(text).toContain("hello forged row");
  expect(text).not.toContain("\x7f");
  expect(JSON.parse(run(dir).out).presets[0].description).toContain("\n");
});

test("relative XDG refuses fallback to HOME and broken legacy names the actual file", () => {
  const dir = fixture(undefined, "broken [[[ secret-value");
  const result = run(dir, []);
  expect(result.err).toContain(join(dir, "tap/presets.toml"));
  expect(result.err).not.toContain("secret-value");
  expect(run("relative", []).err).toContain("XDG_CONFIG_HOME must be absolute");
  expect(JSON.parse(run("relative").out).source).toBeNull();
});

test("insecure, nonregular, symlink and invalid UTF8 catalog behavior", () => {
  const dir = fixture(valid);
  const path = join(dir, "tap/config.toml");
  chmodSync(path, 0o666);
  expect(JSON.parse(run(dir).out)).toEqual(reference(dir));
  rmSync(path);
  mkdirSync(path);
  expect(JSON.parse(run(dir).out)).toEqual(reference(dir));
  rmSync(path, { recursive: true });
  const target = join(dir, "real.toml");
  writeFileSync(target, valid, { mode: 0o600 });
  symlinkSync(target, path);
  expect(JSON.parse(run(dir).out)).toEqual(reference(dir));
  writeFileSync(target, new Uint8Array([0xff]));
  expect(JSON.parse(run(dir).out)).toEqual(reference(dir));
});


test("checked-in reference catalog matches discovery", () => {
  const dir = fixture(readFileSync(join(root, "skills/tap/config/config.v3.toml"), "utf8"));
  expect(JSON.parse(run(dir).out)).toEqual(reference(dir));
});


test("reference starter choices and policy extensions remain launchable", () => {
  const text = readFileSync(join(root, "skills/tap/config/config.v3.toml"), "utf8");
  const config = Bun.TOML.parse(text) as any;
  const dir = fixture(text);
  const names = Object.keys(config.presets).sort();
  expect(names).toHaveLength(30);
  expect(JSON.parse(run(dir).out).presets.map((row: any) => row.name)).toEqual(names);
  expect(names.filter(name => config.presets[name].metadata?.starter)).toEqual(
    ["astra", "fable", "gemini", "grok", "luna", "opus", "sol", "sonnet"]);
  expect(config.sentinel.preview).toBe(false);
  // Born live (F1): launch reads the enrolled worktree's acting registry.
  const wt = join(work, "grok-wt"), registry = join(wt, ".tap", "team-registry.json"), idx = join(work, "grok-index");
  mkdirSync(join(wt, ".tap"), { recursive: true }); mkdirSync(idx);
  Bun.spawnSync(["git", "init", "-q", wt]);
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "presets", worktree_root: wt }, seats: {} }));
  writeFileSync(join(idx, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { presets: { root: wt, registry_location: registry, state: "registered" } } }));
  const grok = Bun.spawnSync(["bun", join(root, "runtime/bun/src/launcher/new.ts"), "--dry-run", "--json", "grok"], {env: {...process.env, XDG_CONFIG_HOME: dir, TAP_INDEX_HOME: idx}, cwd: wt, stdin: "ignore"});
  expect({code: grok.exitCode, stderr: grok.stderr.toString()}).toEqual({code: 0, stderr: expect.any(String)});
  // The launcher owns Cursor bypass (tap-6c1me); the reference no longer spells it as params.yolo.
  expect(JSON.parse(grok.stdout.toString()).argv.slice(1, 4)).toEqual(["--force", "--sandbox", "disabled"]);
  for (const harness of ["agy", "claude", "codex", "cursor"]) {
    expect(config.harness[harness].permissions).toBe("bypass");
  }
  for (const name of names) {
    const preset = config.presets[name];
    const resolved = resolveCatalog(name, undefined, { XDG_CONFIG_HOME: dir }, () => {});
    expect(resolved.preset?.params.model).toBe(preset.params.model);
    if (preset.harness === "codex") {
      expect(preset.params.config.filter((value: string) => value.startsWith("model_reasoning_effort="))).toHaveLength(1);
    } else if (preset.harness === "claude") {
      expect(typeof preset.params.effort).toBe("string");
    }
  }
});

test("missing and empty catalogs offer a bare launch and optional setup", () => {
  for (const config of [undefined, "version=3\n[presets]"]) {
    const dir = fixture(config);
    const r = run(dir, []);
    expect(r.err).toContain(`no saved presets in ${join(dir, "tap/config.toml")}`);
    expect(r.err).toContain("tap launch claude newcomer");
    expect(r.err).toContain("optional: tap setup --machine");
    expect(r.err).not.toContain("writable");
    expect(r.err).not.toContain("no readable");
    expect(r.err).not.toContain("cp skills/");
  }
});

// tap-gp75: the vendor lineage of each preset is visible, so a panel composer can
// group seats by family without recalling harness-to-family mappings.
const familyConfig = 'version=3\n'
  + '[presets.alpha]\nharness="claude"\nparams.model="opus"\nmetadata.model_family="anthropic"\n'
  + '[presets.beta]\nharness="opencode"\nparams.model="z-ai/glm"\nmetadata.model_family="zhipu"\n'
  + '[presets.claudefall]\nharness="claude"\n'
  + '[presets.codexfall]\nharness="codex"\n'
  + '[presets.agyfall]\nharness="agy"\n'
  + '[presets.opencodebare]\nharness="opencode"\nparams.model="x/y"\n'
  + '[presets.cursorbare]\nharness="cursor"\n'
  // The preset `family` key is the [notes] bridge, not lineage: it never shows as FAMILY.
  + '[presets.notesonly]\nharness="cursor"\nfamily="anthropic"\n[notes]\nanthropic="n"\n'
  // An explicit lineage beats the harness's implied vendor.
  + '[presets.override]\nharness="codex"\nmetadata.model_family="xai"\n';
const expectedFamilies = [
  ["agyfall", "google"], ["alpha", "anthropic"], ["beta", "zhipu"], ["claudefall", "anthropic"],
  ["codexfall", "openai"], ["cursorbare", null], ["notesonly", null], ["opencodebare", null], ["override", "xai"],
];

test("presets JSON carries family: explicit key, single-vendor harness fallback, null otherwise", () => {
  const rows = JSON.parse(run(fixture(familyConfig)).out).presets;
  expect(rows.map((row: any) => [row.name, row.family])).toEqual(expectedFamilies);
  expect(rows.find((row: any) => row.name === "alpha")).toMatchObject({ harness: "claude", model: "opus", roles: "", description: "" });
});

test("presets table shows a FAMILY column that agrees with JSON and dashes an unknown family", () => {
  const lines = run(fixture(familyConfig), []).out.split("\n");
  expect(lines[0]!.split(/\s{2,}/)).toEqual(["PRESET", "HARNESS", "FAMILY", "MODEL", "ROLES", "DESCRIPTION"]);
  const at = lines[0]!.indexOf("FAMILY");
  const family = (name: string) => lines.find(line => line.startsWith(name + " "))!.slice(at).split(/\s{2,}/)[0];
  for (const [name, expected] of expectedFamilies) expect(family(name!)).toBe(expected ?? "-");
});

test("the shipped catalog gives every preset a family and names it explicitly except the harness-implied ones", () => {
  const dir = fixture(readFileSync(join(root, "skills/tap/config/config.v3.toml"), "utf8"));
  const rows = JSON.parse(run(dir).out).presets;
  expect(rows.filter((row: any) => !row.family).map((row: any) => row.name)).toEqual([]);
  const byName = Object.fromEntries(rows.map((row: any) => [row.name, row.family]));
  expect(byName).toMatchObject({ opus: "anthropic", sonnet: "anthropic", sol: "openai", astra: "openai",
    gemini: "google", grok: "xai", glm53: "zhipu", kimi: "moonshot", "hermes-agent": "deepseek" });
});

test("an unusable model_family costs the field, never the preset", () => {
  const dir = fixture('version=3\n[presets.a]\nharness="claude"\nmetadata.model_family=""\n[presets.b]\nharness="cursor"\nmetadata.model_family=7\n');
  const rows = JSON.parse(run(dir).out).presets;
  expect(rows.map((row: any) => [row.name, row.family])).toEqual([["a", "anthropic"], ["b", null]]);
});

test("a long model id cannot push FAMILY off a narrow row", () => {
  const long = "provider/" + "long-model-name-".repeat(6);
  const dir = fixture(`version=3\n[presets.p]\nharness="codex"\nparams.model="${long}"\n`);
  const [header, row] = run(dir, []).out.split("\n");
  // FAMILY precedes the unbounded MODEL column, so it lands within a 60-column terminal.
  expect(header!.indexOf("FAMILY")).toBeLessThan(40);
  expect(row!.slice(0, 60)).toContain("openai");
});
