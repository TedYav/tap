import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { enrollScratchRoot } from "./support/enroll-scratch";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { resolveCatalog } from "../src/launcher/catalog";
import { LauncherError } from "../src/launcher/types";
import { cmdSessionLaunch } from "../src/launcher/new";
import { spawnSync } from "node:child_process";

const work = mkdtempSync(join(tmpdir(), "policy-refusals-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

let n = 0;
function machine(config: string, legacy?: string) {
  const dir = join(work, String(n++));
  mkdirSync(join(dir, "tap"), { recursive: true });
  const write = (name: string, body: string) => {
    const f = join(dir, "tap", name);
    writeFileSync(f, body);
    chmodSync(f, 0o600);
    return f;
  };
  const configPath = write("config.toml", config);
  if (legacy !== undefined) write("presets.toml", legacy);
  return { env: { HOME: "/nonexistent", XDG_CONFIG_HOME: dir }, dir, configPath };
}

/** The refusal a policy read produced, or null if it did not refuse. */
function refusalFor(env: NodeJS.ProcessEnv, harness = "claude") {
  try {
    resolveCatalog(undefined, harness, env, () => {});
    return null;
  } catch (error) {
    if (!(error instanceof LauncherError)) throw error;
    return { cls: error.errorClass, action: error.action, detail: error.detail };
  }
}

/**
 * The incumbent's invalid-config constructor is `_invalid(path, detail)`
 * (presets.py:430): class `preset_config_invalid`, action **`fix <path>`** — the
 * path alone — and detail `invalid preset config <path>: <detail>`. Only a
 * well-formed key crossing the fence is `harness_env_forbidden`, with the
 * remove-key repair (presets.py:1725).
 *
 * These arms exist because an earlier fix got the CLASS right and then invented
 * the prose: `fix [harness.claude.env] in <path>`, `fix the key name in …`,
 * `fix env.GOOD in …`, and one collapsed value diagnostic where the incumbent has
 * two. Class-only assertions could not see any of that.
 */
test("a non-table env is an invalid config, with the incumbent's action", () => {
  const m = machine('version=3\n[harness.claude]\nenv = "not-a-table"\n');
  const r = refusalFor(m.env)!;
  expect(r.cls).toBe("preset_config_invalid");
  expect(r.action).toBe(`fix ${realpathSync(m.configPath)}`);
  expect(r.detail).toContain("[harness.claude.env] must be a table");
});

test("an illegal key spelling is invalid config, not a fence violation", () => {
  const m = machine('version=3\n[harness.claude.env]\n"BAD-KEY" = "x"\n');
  const r = refusalFor(m.env)!;
  expect(r.cls).toBe("preset_config_invalid");
  expect(r.action).toBe(`fix ${realpathSync(m.configPath)}`);
  expect(r.detail).toContain("[harness.claude.env] has invalid environment key 'BAD-KEY'");
});

test("a blank value and a control character are DIFFERENT diagnostics", () => {
  const blank = refusalFor(machine('version=3\n[harness.claude.env]\nGOOD = "   "\n').env)!;
  expect(blank.detail).toContain("field 'env.GOOD' must be a non-empty string");
  const ctrl = refusalFor(machine('version=3\n[harness.claude.env]\nGOOD = "a\\u0007b"\n').env)!;
  expect(ctrl.detail).toContain("field 'env.GOOD' contains a control character");
});

test("only a well-formed fenced key is harness_env_forbidden", () => {
  const m = machine('version=3\n[harness.claude.env]\nHF_TOKEN = "x"\n');
  const r = refusalFor(m.env)!;
  expect(r.cls).toBe("harness_env_forbidden");
  expect(r.action).toBe(`remove key 'HF_TOKEN' from [harness.claude.env] in ${realpathSync(m.configPath)}`);
});

/**
 * U+FEFF is not whitespace to Python's `str.strip()` and IS stripped by JS
 * `trim()`, so a policy value of U+FEFF is a usable string to the incumbent and
 * blank to a `trim()`-based check. Third site in this lane for that same
 * disagreement; the first two were `family` and the description cell.
 */
test("U+FEFF is not blank to Python, so the value is accepted", () => {
  const m = machine('version=3\n[harness.claude.env]\nGOOD = "\\ufeff"\n');
  expect(refusalFor(m.env)).toBeNull();
});

/**
 * Presets from the legacy file, policy from config.toml — so a policy refusal
 * must name config.toml, RESOLVED. With config.toml a symlink the requested and
 * resolved paths differ, and the incumbent names the real file.
 */
test("a policy refusal names the resolved config.toml, never presets.toml", () => {
  const dir = join(work, `sym${n++}`);
  mkdirSync(join(dir, "tap"), { recursive: true });
  const real = join(dir, "real-config.toml");
  writeFileSync(real, 'version=3\n[harness.claude.env]\nHF_TOKEN = "x"\n');
  chmodSync(real, 0o600);
  symlinkSync(real, join(dir, "tap", "config.toml"));
  const legacy = join(dir, "tap", "presets.toml");
  writeFileSync(legacy, 'version=3\n[presets.alpha]\nharness="claude"\n');
  chmodSync(legacy, 0o600);

  const r = refusalFor({ HOME: "/nonexistent", XDG_CONFIG_HOME: dir })!;
  expect(r.action).toContain(realpathSync(real));
  expect(r.action).not.toContain("presets.toml");
  expect(r.action).not.toContain(join(dir, "tap", "config.toml"));
});

/**
 * ONE COMMAND SAYS IT ONCE; TWO COMMANDS SAY IT TWICE.
 *
 * A launch reads the catalog more than once: to resolve the preset and again
 * where policy is reread fresh on every launch and resume. That is only
 * survivable because identical text de-duplicates for the life of ONE command;
 * an earlier launcher handed both reads a raw sink with no generation behind
 * it, and a stable `version = 4` config printed its notice twice.
 *
 * The per-command half and the across-commands half are both asserted, because a
 * process-scoped dedup would satisfy the first and silently break the second —
 * `resume --all` re-reads policy per seat and must still speak once per command,
 * not once per process.
 */
// One in-process `tap session launch --dry-run` from an enrolled scratch git root.
async function captureLaunch(env: NodeJS.ProcessEnv): Promise<string[]> {
  const lines: string[] = [];
  const root = join(work, `launch-${n++}`);
  mkdirSync(root);
  spawnSync("git", ["init", "-q", root]);
  enrollScratchRoot(root, join(root, "index"));
  const saved = { cwd: process.cwd(), env: { ...process.env } };
  const originalErr = process.stderr.write, originalOut = process.stdout.write;
  // Narrowed test doubles for the duration of one call: the real `write` carries
  // overloads and a callback arm this capture never uses.
  process.stderr.write = ((chunk: string) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    process.chdir(root);
    delete process.env.TAP_HOME; delete process.env.TAP_JSON;
    Object.assign(process.env, env, { TAP_INDEX_HOME: join(root, "index") });
    await cmdSessionLaunch(["claude", "seat", "--dry-run"]);
  } finally {
    process.stderr.write = originalErr; process.stdout.write = originalOut;
    process.chdir(saved.cwd);
    for (const key of Object.keys(process.env)) if (!(key in saved.env)) delete process.env[key];
    Object.assign(process.env, saved.env);
  }
  return lines.join("").split("\n").filter(Boolean);
}

const NEWER = "is newer";

test("two policy reads in ONE command say a stable notice once", async () => {
  const m = machine('version=4\n[harness.claude.env]\nGOOD = "x"\n');
  const said = (await captureLaunch(m.env)).filter(l => l.includes(NEWER));
  expect(said.length).toBe(1);
});

test("two separate commands each say it — dedup is per command, not per process", async () => {
  const m = machine('version=4\n[harness.claude.env]\nGOOD = "x"\n');
  const first = (await captureLaunch(m.env)).filter(l => l.includes(NEWER));
  const second = (await captureLaunch(m.env)).filter(l => l.includes(NEWER));
  expect(first.length).toBe(1);
  expect(second.length).toBe(1);
});
