// Native controls retained when R9a retires test_presets*.py and the Python floor probes.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDirectory, HARNESSES, isRegularFile, readSecureBytes, resolveHarnessPolicy } from "../src/launcher/catalog";
import { catalogDisplayRows, forHandle, loadPresetCatalog, requirePreset, rosterDisplayFacts, tryLoadCatalogForDisplay } from "../src/launcher/catalog-listing";
import { metadataToJson } from "../src/launcher/catalog-metadata";
import { Notices } from "../src/launcher/catalog-notices";
import { paramsToArgv, spliceTokensIfAbsent, spliceVerbatimParams } from "../src/launcher/argv-splice";

const root = realpathSync(mkdtempSync(join(tmpdir(), "preset-contracts-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let count = 0;
function fixture(body?: string, legacy?: string) {
  const dir = join(root, String(count++));
  mkdirSync(join(dir, "tap"), { recursive: true });
  const path = join(dir, "tap/config.toml");
  if (body !== undefined) writeFileSync(path, body, { mode: 0o600 });
  if (legacy !== undefined) writeFileSync(join(dir, "tap/presets.toml"), legacy, { mode: 0o600 });
  const env = { XDG_CONFIG_HOME: dir };
  const lines: string[] = [];
  const notices = new Notices(line => lines.push(line));
  return { dir, path, env, lines, notices,
    load: () => loadPresetCatalog(env, notices.sink, readSecureBytes, configDirectory(env), isRegularFile),
    policy: (harness = "claude") => resolveHarnessPolicy(harness, env, notices),
    display: () => tryLoadCatalogForDisplay(notices, env, readSecureBytes, configDirectory(env), isRegularFile),
  };
}
const good = '[presets.good]\nharness="codex"\n';

for (const [label, bad] of [
  ["unknown field", 'harness="codex"\nextra=true'],
  ["non-string harness", 'harness=4'],
  ["unknown harness", 'harness="unknown"'],
  ["empty model", 'harness="codex"\nparams.model=""'],
  ["boolean model", 'harness="codex"\nparams.model=true'],
  ["non-string description", 'harness="codex"\ndescription=4'],
  ["invalid environment name", 'harness="codex"\nenv.BAD-KEY="x"'],
  ["empty environment value", 'harness="codex"\nenv.SAFE=""'],
  ["non-string environment value", 'harness="codex"\nenv.SAFE=4'],
  ["control character", 'harness="codex"\nparams.model="x\\u0007"'],
  ["mixed param array", 'harness="codex"\nparams.foo=["x",3]'],
] as const) test(`invalid preset is dropped and named while its sibling survives: ${label}`, () => {
  const f = fixture(`version=3\n[presets.bad]\n${bad}\n${good}`);
  const c = f.load();
  expect([...c.presets.keys()]).toEqual(["good"]);
  expect(c.dropped.has("bad")).toBe(true);
  expect(f.lines.join("\n")).toContain("bad");
  expect(() => requirePreset(c, "bad")).toThrow("preset_not_usable");
  expect(() => requirePreset(c, "missing")).toThrow("preset_not_found");
});

for (const key of ["TAP", "TAP_HOME", "HOME", "TMUX_PANE", "AGENT_NAME", "CLAUDE_TEAM_ID",
  "CODEX_SANDBOX_MODE", "MODEL_APPROVALS_REQUIRED", "LOCAL_PERMISSION_LEVEL", "AUTH_BYPASS_MODE",
  "BASH_ENV", "ENV", "NODE_OPTIONS", "PYTHONPATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES",
  "OPENAI_API_KEY", "ANTHROPIC_AUTH_TOKEN", "AWS_SECRET_ACCESS_KEY", "DATABASE_PASSWORD", "SSH_PRIVATE_KEY"])
  test(`preset environment fence drops ${key} without disclosing its value`, () => {
    const f = fixture(`version=3\n[presets.bad]\nharness="codex"\nenv.${key}="private-fixture"\n${good}`);
    const c = f.load();
    expect([...c.presets.keys()]).toEqual(["good"]);
    expect(f.lines.join("\n")).toContain(key);
    expect(f.lines.join("\n")).not.toContain("private-fixture");
  });

for (const harness of HARNESSES) test(`canonical harness name ${harness} cannot become a preset`, () => {
  const f = fixture(`version=3\n[presets.${harness}]\nharness="claude"\n${good}`);
  expect([...f.load().presets.keys()]).toEqual(["good"]);
  expect(f.lines.join("\n")).toContain(harness);
});

test("preset provenance uses descriptor bytes and resolved symlink target; ambient env stays out", () => {
  const body = 'version=3\n[presets.rich]\nharness="codex"\nparams.model="model"\nparams.effort="high"\nenv.SAFE="declared"\n';
  const f = fixture();
  const target = join(f.dir, "actual.toml");
  writeFileSync(target, body, { mode: 0o600 });
  symlinkSync(target, f.path);
  const c = loadPresetCatalog({ ...f.env, SAFE: "ambient", UNDECLARED: "absent" }, f.notices.sink,
    readSecureBytes, configDirectory(f.env), isRegularFile);
  const p = requirePreset(c, "rich");
  expect(p.provenance).toEqual({ name: "rich", source_path: target,
    config_digest: `sha256:${createHash("sha256").update(body).digest("hex")}` });
  expect(p.env).toEqual({ SAFE: "declared" });
  expect(p.model).toBe("model");
  expect(p.harness_passthrough).toEqual(["--effort", "high"]);
});

for (const [body, names, notice] of [
  ['version=3\n[harness.claude.env]\nPOLICY="on"', ["old"], "presets read from"],
  ['version=3\n[presets]', ["old"], "is empty"],
  ['version=3\n'+good, ["good"], "no longer read"],
  ['version=3\npresets=["bad"]', [], "not a table"],
] as const) test(`catalog authority: ${notice}`, () => {
  const f = fixture(body, 'version=3\n[presets.old]\nharness="claude"');
  expect([...f.load().presets.keys()]).toEqual([...names]);
  expect(f.lines.join("\n")).toContain(notice);
});

test("display is silent; empty, missing and unreadable catalogs remain distinct", () => {
  const absent = fixture();
  expect(absent.display()).toBeNull();
  expect(absent.lines).toEqual([]);
  expect(absent.policy()).toMatchObject({ env: {}, notices: [] });
  expect(() => absent.load()).toThrow("preset_config_missing");
  const empty = fixture('version=3\n[presets]');
  expect(catalogDisplayRows(empty.display()!)).toEqual([]);
  const broken = fixture("invalid [[[");
  expect(broken.display()).toBeNull();
  expect(broken.lines).toEqual([]);
  expect(broken.policy().notices.join("\n")).toContain("not being applied");
  expect(() => broken.load()).toThrow("preset_config_invalid");
  const insecure = fixture("version=3\n"+good);
  chmodSync(insecure.path, 0o666);
  expect(() => insecure.load()).toThrow("preset_config_insecure");
  expect(insecure.policy().notices.join("\n")).toContain("chmod 600");
});

test("roster prefers recorded names and labels inference, missing entries and unavailable catalogs", () => {
  const c = fixture('version=3\n[presets.opus]\nharness="claude"\n[presets.opus-med]\nharness="claude"\n[presets."sol.max"]\nharness="codex"').load();
  for (const [handle, name] of [["opus", "opus"], ["opus-2", "opus"], ["opus-med-2", "opus-med"], ["sol.max-2", "sol.max"]])
    expect(forHandle(c, handle!)?.provenance.name).toBe(name);
  for (const handle of ["", "opusish", "worker"]) expect(forHandle(c, handle)).toBeNull();
  expect(rosterDisplayFacts(["opus", "opus-2", "worker"], { catalog: c, recorded: { opus: "sol.max" } })).toEqual({
    opus: { preset: "sol.max", roles: "" }, "opus-2": { preset: "opus", roles: "", preset_inferred: true },
  });
  expect(rosterDisplayFacts(["opus"], { catalog: c, recorded: { opus: "removed" } })).toEqual({
    opus: { preset: "removed", roles: "", preset_absent_from_catalog: true },
  });
  expect(rosterDisplayFacts(["opus"], { catalog: null, recorded: { opus: "removed" } })).toEqual({
    opus: { preset: "removed", roles: "", preset_catalog_unavailable: true },
  });
});

test("metadata preserves extension data while malformed known fields are dropped", () => {
  const f = fixture('version=3\n[roles]\nreviewer="Reviews"\n[presets.p]\nharness="claude"\nmetadata.primary_roles=["reviewer"]\nmetadata.speed=4\nmetadata.future={nested=["line\\n",7]}\nmetadata.when=2026-08-18\nmetadata.tolerance=inf\nmetadata.floor=-inf\nmetadata.void=nan');
  const p = requirePreset(f.load(), "p");
  const data = metadataToJson(p.metadata!);
  expect(data.primary_roles).toEqual(["reviewer"]);
  expect(data.speed).toBeNull();
  expect(data.future).toEqual({ nested: ["line\n", 7] });
  expect(data.when).toBe("2026-08-18");
  expect(data.tolerance).toBe(Infinity);
  expect(data.floor).toBe(-Infinity);
  expect(data.void).toBeNaN();
  expect(f.lines.join("\n")).toContain("speed");
});

test("catalog and policy share notice lifetime without suppressing returned policy diagnostics", () => {
  const f = fixture('version=4\n'+good+'[harness.claude]\nunknown=true\n');
  f.load();
  const first = [...f.lines];
  expect(first.join("\n")).toContain("newer");
  f.load();
  expect(f.lines).toEqual(first);
  expect(f.policy().notices.join("\n")).toContain("unknown");
  f.notices.suppress(true);
  f.notices.reset();
  f.load(); f.display();
  expect(f.policy().notices.join("\n")).toContain("unknown");
  expect(f.lines).toEqual(first);
  expect(f.notices.isSuppressed).toBe(true);
  f.notices.suppress(false);
  f.load();
  expect(f.lines).toEqual([...first, ...first]);
});

test("policy validates only the requested harness and keeps params, permissions and declared env", () => {
  const f = fixture('version=3\n[harness.codex.env]\nPATH="/forbidden"\n[harness.claude]\npermissions="auto"\nparams.model="policy"\nenv.SAFE="declared"');
  expect(() => f.policy("codex")).toThrow("harness_env_forbidden");
  expect(f.policy()).toEqual({ env: { SAFE: "declared" }, params: { model: "policy" }, permissions: "auto", permissionsDefaulted: false, notices: [] });
  expect(f.lines).toEqual([]);
  expect(() => configDirectory({ XDG_CONFIG_HOME: "relative" })).toThrow("XDG_CONFIG_HOME must be absolute");
});

const values = ["plain", "/path with spaces", "--workspace", "-tmp", "", "a=b", "$(touch nope)"];
for (const value of values) test(`argv floor preserves value binding: ${JSON.stringify(value)}`, () => {
  const builder = ["cursor", "--workspace", "/repo", "prompt"];
  const tokens = paramsToArgv({ foo: value });
  expect(spliceTokensIfAbsent(builder, tokens)).toEqual(["cursor", ...tokens, ...builder.slice(1)]);
  for (const own of [builder, ["cursor", "--workspace=/repo", "prompt"]])
    expect(spliceTokensIfAbsent(own, paramsToArgv({ workspace: value }))).toEqual(own);
});
test("false params add nothing; explicit operator tail survives the builder floor", () => {
  const builder = ["cursor", "--workspace", "/repo", "prompt"];
  expect(paramsToArgv({ mode: false })).toEqual([]);
  expect(paramsToArgv({ foo: "--workspace" })).toEqual(["--foo=--workspace"]);
  expect(spliceTokensIfAbsent(builder, ["--workspace", "/elsewhere"], { floor: false }))
    .toEqual(["cursor", "--workspace", "/elsewhere", ...builder.slice(1)]);
  expect(spliceVerbatimParams(builder, { mode: false })).toEqual(builder);
  const p = requirePreset(fixture('version=3\n[presets.p]\nharness="cursor"\nparams.mode=false\nparams.foo="--workspace"\nparams.quiet=true').load(), "p");
  expect(p.param_keys).toEqual(["foo", "quiet"]);
  expect(p.harness_passthrough).toEqual(["--foo=--workspace", "--quiet"]);
});
