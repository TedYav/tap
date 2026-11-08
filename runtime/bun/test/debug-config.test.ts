import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { debugConfig } from "../src/config-file";
import { main } from "../src/debug";
import { writeDebugConfig } from "../src/debug-config";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tap-debug-config-"));
  const env = { ...process.env, XDG_CONFIG_HOME: join(root, "config"), TAP_INDEX_HOME: join(root, "index") };
  const path = join(env.XDG_CONFIG_HOME, "tap/config.toml");
  mkdirSync(join(env.XDG_CONFIG_HOME, "tap"), { recursive: true });
  return { root, env, path };
}

test("debug defaults keep automatic recording off and separate capture from fidelity", () => {
  const f = fixture();
  try {
    expect(debugConfig(f.env)).toEqual({ always_on: false, capture: ["tmux", "tap-events"], fidelity: "best-effort", max_mb: 1024, retain_mb: 2048, archive_mb: 10240 });
    writeFileSync(f.path, '[debug]\ncapture = ["tap-events"]\nfidelity = "precise"\nalways_on = true\n');
    expect(debugConfig(f.env)).toMatchObject({ always_on: true, capture: ["tap-events"], fidelity: "precise" });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const text of [
  '[debug]\ncapture = ["unknown"]\n', '[debug]\ncapture = "tmux"\n', '[debug]\nfidelity = "trace"\n',
  '[debug]\nalways_on = "yes"\n', '[debug]\nmax_mb = 0\n', '[debug]\nretain_mb = 1.5\n', '[debug]\narchive_mb = -1\n',
  'debug = "wrong shape"\n', '[debug\n',
]) test(`debug config refuses invalid input with a typed, silent error: ${JSON.stringify(text)}`, () => {
  const f = fixture();
  try {
    writeFileSync(f.path, text);
    expect(() => debugConfig(f.env)).toThrow();
    try { debugConfig(f.env); } catch (error) { expect(error).toMatchObject({ errorClass: "debug_config_invalid" }); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a debug settings update preserves unrelated TOML and imports legacy caps only into the first block", () => {
  const f = fixture(), legacy = join(f.env.TAP_INDEX_HOME, "debug/config.json");
  mkdirSync(join(f.env.TAP_INDEX_HOME, "debug"), { recursive: true });
  writeFileSync(legacy, JSON.stringify({ max_mb: 7, retain_mb: 9 }));
  const unrelated = '# operator note\n[roles]\nreviewer = "fable" # retain this\n';
  writeFileSync(f.path, unrelated);
  try {
    expect(writeDebugConfig({ fidelity: "precise" }, f.env)).toMatchObject({ max_mb: 7, retain_mb: 9, fidelity: "precise" });
    expect(readFileSync(f.path, "utf8")).toContain(unrelated);
    writeFileSync(legacy, JSON.stringify({ max_mb: 99, retain_mb: 99 }));
    expect(debugConfig(f.env)).toMatchObject({ max_mb: 7, retain_mb: 9 });
    expect(writeDebugConfig({ capture: [] }, f.env).capture).toEqual([]);
    const before = readFileSync(f.path, "utf8");
    expect(() => writeDebugConfig({ fidelity: "trace" as never }, f.env)).toThrow();
    expect(readFileSync(f.path, "utf8")).toBe(before);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("debug settings follow a config symlink and retain its target's other tables", () => {
  const f = fixture(), target = join(f.root, "operator.toml");
  writeFileSync(target, '[sentinel]\npreview = true\n'); symlinkSync(target, f.path);
  try {
    writeDebugConfig({ fidelity: "precise" }, f.env);
    expect(readFileSync(target, "utf8")).toContain('fidelity = "precise"');
    expect(readFileSync(target, "utf8")).toContain('preview = true');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("multiline capture arrays survive no-op starts and can be changed without damaging neighboring settings", () => {
  const f = fixture();
  const capture = 'capture = [ # sources\n  "tmux", # native samples\n  "tap-events",\n] # selected\n';
  const neighbor = '\n[roles]\nreviewer = "fable" # keep this\n';
  const source = '[debug]\n' + capture + neighbor;
  writeFileSync(f.path, source);
  try {
    writeDebugConfig({}, f.env);
    expect(readFileSync(f.path, "utf8")).toBe(source);
    writeDebugConfig({ fidelity: "precise" }, f.env);
    expect(readFileSync(f.path, "utf8")).toContain(capture);
    expect(writeDebugConfig({ capture: ["tap-events"] }, f.env).capture).toEqual(["tap-events"]);
    expect(debugConfig(f.env)).toMatchObject({ capture: ["tap-events"], fidelity: "precise" });
    const changed = readFileSync(f.path, "utf8");
    expect(changed).toContain(neighbor);
    for (const comment of ["# sources", "# native samples", "# selected"]) expect(changed).toContain(comment);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test("tmux-only configuration reports unmanaged without starting the tap-events collector", async () => {
  const f = fixture(), output: string[] = [], log = console.log;
  console.log = (...args) => { output.push(args.join(" ")); };
  try {
    writeDebugConfig({ capture: ["tmux"] }, f.env);
    await main(["on", "--json"], f.env);
    expect(JSON.parse(output.pop()!)).toMatchObject({ fidelity: "best-effort", recording: false,
      sources: { "tap-events": { state: "off" }, tmux: { state: "unmanaged", last_sample_at: null, alive: null, incident_count: null } } });
  } finally { console.log = log; rmSync(f.root, { recursive: true, force: true }); }
});

test("the public JSON door reports invalid debug settings with their stable error class", () => {
  const f = fixture();
  try {
    writeFileSync(f.path, '[debug]\ncapture = ["unknown"]\n');
    const result = Bun.spawnSync([join(import.meta.dir, "../../../bin/tap"), "debug", "config", "--json"], { env: f.env, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(result.stdout.toString())).toMatchObject({ ok: false, error_class: "debug_config_invalid" });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
