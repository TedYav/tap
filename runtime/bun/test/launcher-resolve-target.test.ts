// `tap crew` resolve-target — the native preset/harness resolver behind
// tap-crew.sh (S1 of the launcher tail's second unit). The Python oracle was
// captured into support/launcher-resolve-target/g*.{out,err,rc} at the base and
// deleted in the same PR; every success form must reproduce those bytes (with
// the config dir spelled @CONFIG@), the refusal matrix keeps the incumbent's
// classes and actions, the harness fast path must not open the catalog, and
// the whole verb is argv/catalog-decidable: no write may escape the scratch
// config dir. Two ruled deviations from the Python are pinned: a version-1
// catalog with a requested preset refuses preset_config_retired (the CONTRACT
// launch rule) instead of notice-then-not-found, and argparse prefix
// abbreviations are gone (unknown options are usage refusals).
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Notices } from "../src/launcher/catalog-notices";
import { resolveLaunchPresetArgs, cmdResolveTarget } from "../src/launcher/resolve-target";
import { removeScratchTree } from "./support/scratch";

const repo = resolve(import.meta.dir, "../../..");
const module = join(repo, "runtime/bun/src/launcher/resolve-target.ts");
const goldens = join(import.meta.dir, "support/launcher-resolve-target");
const scratchRoot = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "tap-resolve-target."));
afterAll(() => removeScratchTree(scratchRoot));

const USAGE = "tap crew add <preset|harness> [name]";
const CONFIG = join(scratchRoot, "config");
const CONFIG_FILE = join(CONFIG, "tap", "config.toml");

const CATALOG = [
  "version = 2",
  "",
  "[roles]",
  'review = "reviews changes"',
  "",
  "[notes]",
  'opus = "the reasoning workhorse"',
  "",
  "[presets.opus]",
  'harness = "claude"',
  'family = "opus"',
  "[presets.opus.params]",
  'model = "o3"',
  "[presets.opus.metadata]",
  'primary_roles = ["review"]',
  'summary = "long-context reasoning"',
  "",
  "[presets.bare]",
  'harness = "codex"',
  "",
].join("\n");

const NOTICES = "tap crew: opus — the reasoning workhorse\ntap crew: opus — review — long-context reasoning\n";

let allocated = 0;

/** A private XDG_CONFIG_HOME carrying the standard catalog (or custom text). */
function freshConfig(text: string = CATALOG): string {
  const dir = join(scratchRoot, `xdg${allocated++}`);
  mkdirSync(join(dir, "tap"), { recursive: true });
  writeFileSync(join(dir, "tap", "config.toml"), text);
  return dir;
}

/** Freeze the config tree: every case must leave these bytes untouched. */
function configState(dir: string): string[] {
  const out: string[] = [];
  const walk = (path: string) => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name);
      const st = statSync(full);
      out.push(st.isDirectory() ? `d\t${full}` : `f\t${createHash("sha256").update(readFileSync(full)).digest("hex")}\t${full}`);
      if (st.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out;
}

function run(argv: string[], xdg: string, env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("bun", [module, "--usage", USAGE, "--verb", "tap crew", ...argv], {
    cwd: "/tmp",
    env: { ...process.env, XDG_CONFIG_HOME: xdg, ...env },
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const sub = (text: string): string => text.replaceAll(`${CONFIG}/`, "@CONFIG@/").replaceAll(CONFIG, "@CONFIG@");

const GOLDEN_CASES: Array<{ name: string; args: string[] }> = [
  { name: "g1-harness-name", args: ["claude", "tester"] },
  { name: "g2-preset-name", args: ["opus", "tester"] },
  { name: "g3-explicit-split", args: ["--preset", "opus", "tester"] },
  { name: "g4-modelless", args: ["bare", "crew1"] },
  { name: "g5-harness-solo", args: ["codex", "solo"] },
  { name: "g6-compat", args: ["--preset", "opus", "claude"] },
];

describe("goldens — byte parity with the Python oracle", () => {
  test("every success form reproduces the captured bytes, writing nothing", () => {
    mkdirSync(CONFIG, { recursive: true });
    mkdirSync(join(CONFIG, "tap"), { recursive: true });
    writeFileSync(CONFIG_FILE, CATALOG);
    for (const goldenCase of GOLDEN_CASES) {
      const before = configState(CONFIG);
      const r = run(goldenCase.args, CONFIG);
      const label = `${goldenCase.name} (${goldenCase.args.join(" ")})`;
      expect([label, sub(r.stdout)]).toEqual([label, readFileSync(join(goldens, `${goldenCase.name}.out`), "utf8")]);
      expect([label, sub(r.stderr)]).toEqual([label, readFileSync(join(goldens, `${goldenCase.name}.err`), "utf8")]);
      expect([label, r.status]).toEqual([label, parseInt(readFileSync(join(goldens, `${goldenCase.name}.rc`), "utf8").trim(), 10)]);
      expect(configState(CONFIG)).toEqual(before);
    }
  });

  test("the harness fast path answers without opening the catalog", () => {
    // Falsifier: a mutant that consults the catalog on the harness arm fails
    // here — the malformed file would degrade/refuse before any answer.
    const xdg = freshConfig('this is not toml [[[');
    const r = run(["claude", "tester"], xdg);
    expect(r.status).toBe(0);
    const row = JSON.parse(r.stdout.trim().split("\n").at(-1)!);
    expect(row).toMatchObject({ ok: true, harness: "claude", preset: null, handle: "tester", model: null });
  });

  test("reserved handle refuses on the fast path too, and the catalog never supersedes it", () => {
    // The incumbent checks RESERVED_HANDLES after resolution, so it covers the
    // fast path; the port must too. The malformed catalog proves ordering:
    // `claude help` refuses reserved_handle rc2 rather than a catalog error or
    // a success object, without the config ever being consulted.
    const xdg = freshConfig('this is not toml [[[');
    const r = run(["claude", "help"], xdg, { TAP_JSON: "1" });
    expect(r.status).toBe(2);
    expect(r.stderr).toBe("");
    const envelope = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(envelope).toMatchObject({ ok: false, error_class: "reserved_handle", action: "pass an explicit seat name, or rename the preset" });
    expect(String(envelope.detail)).toContain("'help' is reserved as the CLI help keyword");
    expect(r.stdout).not.toContain('"handle"');
  });

  test("the operator identity `user` refuses before launch, like `help` (tap-gridx)", () => {
    const r = run(["claude", "user"], freshConfig('this is not toml [[['), { TAP_JSON: "1" });
    expect(r.status).toBe(2);
    const envelope = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(envelope).toMatchObject({ ok: false, error_class: "reserved_handle" });
    expect(String(envelope.detail)).toContain("'user' is the reserved operator identity and cannot name a seat");
  });
});

describe("refusals — argv/catalog-decidable, rc 2, crew's action, no handle", () => {
  interface Case { name: string; args: string[]; xdg?: string; error_class: string; actionContains?: string; detailContains?: string }

  const cases: Case[] = [
    { name: "implicit unknown with catalog", args: ["nosuch", "x"], error_class: "harness_or_preset_not_found", actionContains: "tap presets", detailContains: "config.toml" },
    { name: "implicit unknown with no config", args: ["nosuch", "x"], xdg: join(scratchRoot, "xdg-absent"), error_class: "harness_or_preset_not_found", detailContains: "not a known harness or a saved preset" },
    { name: "explicit missing", args: ["--preset", "nosuch"], error_class: "preset_not_found", actionContains: "choose an available preset" },
    { name: "explicit dropped", args: ["--preset", "ghost"], xdg: freshConfig('version = 2\n\n[presets.ghost]\nharness = "nope"\n'), error_class: "preset_not_usable" },
    { name: "compat mismatch", args: ["--preset", "opus", "codex"], error_class: "preset_harness_mismatch", actionContains: "omit 'codex' or use harness 'claude'" },
    { name: "reserved handle via name", args: ["opus", "help"], error_class: "reserved_handle", detailContains: "reserved" },
    { name: "version-1 catalog refuses (ruled deviation)", args: ["--preset", "old"], xdg: freshConfig('version = 1\n\n[presets.old]\nharness = "claude"\n'), error_class: "preset_config_retired", actionContains: "version 2 or 3" },
    // Joined words refuse before the catalog opens: the malformed config would otherwise answer first.
    { name: "joined preset and name", args: ["opus name"], xdg: freshConfig("this is not toml [[["), error_class: "arguments_joined", actionContains: USAGE, detailContains: "'opus name' looks like two arguments joined into one; zsh does not word-split unquoted variables, so pass them as separate arguments" },
    { name: "joined compat harness", args: ["--preset", "opus", "claude code", "x"], xdg: freshConfig("this is not toml [[["), error_class: "arguments_joined", detailContains: "'claude code' looks like two arguments" },
    { name: "joined explicit preset", args: ["--preset", "opus name"], xdg: freshConfig("this is not toml [[["), error_class: "arguments_joined", detailContains: "zsh does not word-split" },
    { name: "unknown flag", args: ["--bogus"], error_class: "session_error", detailContains: "usage:" },
    { name: "argv --json is an unknown argument (ruled)", args: ["--json"], error_class: "session_error", detailContains: "usage:" },
    { name: "--preset --json: option not eaten as operand", args: ["--preset", "--json"], error_class: "session_error", detailContains: "usage:" },
    { name: "--usage --preset: option not eaten as operand", args: ["--usage", "--preset"], error_class: "session_error", detailContains: "usage:" },
    { name: "trailing --verb", args: ["--verb"], error_class: "session_error", detailContains: "usage:" },
    { name: "--verb --json: option not eaten as operand", args: ["--verb", "--json"], error_class: "session_error", detailContains: "usage:" },
    { name: "--preset without value", args: ["--preset"], error_class: "session_error", detailContains: "usage:" },
    { name: "nothing requested", args: [], error_class: "session_error", detailContains: "usage:" },
  ];

  for (const refusalCase of cases) {
    test(`${refusalCase.name} → ${refusalCase.error_class}`, () => {
      const xdg = refusalCase.xdg ?? freshConfig();
      const r = run(refusalCase.args, xdg, { TAP_JSON: "1" });
      expect(r.status).toBe(2);
      expect(r.stderr).toBe("");
      const envelope = JSON.parse(r.stdout.split("\n").filter(Boolean).at(-1)!);
      expect(envelope.error_class).toBe(refusalCase.error_class);
      expect(envelope.ok).toBe(false);
      if (refusalCase.actionContains) expect(envelope.action).toContain(refusalCase.actionContains);
      if (refusalCase.detailContains) expect(envelope.detail).toContain(refusalCase.detailContains);
      expect(r.stdout).not.toContain('"handle"');
    });
  }

  test("reserved handle for `--preset help` is its own class", () => {
    // The no-config arm resolves nothing, so `--preset help` reaches the
    // reserved check on the explicit arm once a catalog exists.
    const r = run(["--preset", "help"], freshConfig('version = 2\n\n[presets.help]\nharness = "claude"\n'), { TAP_JSON: "1" });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout.split("\n").filter(Boolean).at(-1)!).error_class).toBe("reserved_handle");
  });

  test("prose rendering: stderr sentence, empty stdout; argv --json stays prose (ruled: no argv --json)", () => {
    const r = run(["nosuch", "x"], freshConfig());
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("not a known harness or a saved preset");
    expect(r.stderr.startsWith("tap crew: ")).toBe(true);
    expect(r.stderr.endsWith("; next: tap presets, or launch a harness directly: tap crew add claude newcomer --model <model>\n")).toBe(true);

    // The hidden subparser took no --json and the crew door speaks TAP_JSON,
    // so a literal --json is an unknown argument: the usage refusal renders as
    // prose (no TAP_JSON in this env), never as an envelope.
    const asJson = run(["--json", "--preset", "nosuch"], freshConfig());
    expect(asJson.status).toBe(2);
    expect(asJson.stdout).toBe("");
    expect(asJson.stderr).toBe(`tap crew: usage: ${USAGE}\n`);
  });

  test("joined arguments render as one prose sentence naming the fix", () => {
    const r = run(["opus name"], freshConfig());
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`tap crew: 'opus name' looks like two arguments joined into one; zsh does not word-split unquoted variables, so pass them as separate arguments; next: ${USAGE}\n`);
  });

  test("a spaced seat name is not a joined request; the preset still resolves", () => {
    const r = run(["opus", "two words"], freshConfig(), { TAP_JSON: "1" });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim().split("\n").at(-1)!)).toMatchObject({ ok: true, preset: "opus", handle: "two words" });
  });

  test("no --verb label falls back to tap session", () => {
    const bare = spawnSync("bun", [module, "--usage", USAGE, "nosuch"], { cwd: "/tmp", env: { ...process.env, XDG_CONFIG_HOME: freshConfig() }, encoding: "utf8" });
    expect(bare.status).toBe(2);
    expect((bare.stderr ?? "").startsWith("tap session: ")).toBe(true);
  });

  test("notices render once each on stderr and vanish under TAP_JSON=1", () => {
    const plain = run(["opus", "x"], freshConfig());
    expect(plain.stderr).toBe(NOTICES);
    expect(plain.stderr.indexOf("the reasoning workhorse")).toBe(plain.stderr.lastIndexOf("the reasoning workhorse"));

    const quiet = run(["opus", "x"], freshConfig(), { TAP_JSON: "1" });
    expect(quiet.stderr).toBe("");
    expect(JSON.parse(quiet.stdout.split("\n").filter(Boolean).at(-1)!)).toMatchObject({ ok: true, preset: "opus" });
  });
});

describe("public door — installed-style bin/tap relays the refusals", () => {
  const doorHome = join(scratchRoot, "door-home");
  const doorCwd = join(scratchRoot, "door-cwd");

  test("tap crew add refusals carry the resolver's exact envelope through the door", () => {
    mkdirSync(doorHome, { recursive: true });
    mkdirSync(doorCwd, { recursive: true });
    const xdg = freshConfig();
    const env = {
      ...process.env,
      HOME: doorHome,
      XDG_CONFIG_HOME: xdg,
      TAP_TMUX_SOCKET: "tap-rt-absent",
      TAP_JSON: "1",
    };
    delete (env as Record<string, unknown>).BUN_RUNTIME_TRANSPILER_CACHE_PATH;
    // Exact semantics, not "it failed somehow": a missing module, a broken
    // bridge, or an unrelated preflight failure must not pass this arm. The
    // implicit unknown routes to the harness-or-preset sentence; the explicit
    // absent preset routes to requirePreset's not-found sentence.
    const expectations = [
      {
        argv: ["crew", "add", "__nosuch__"],
        errorClass: "harness_or_preset_not_found",
        actionPart: "tap crew add claude newcomer --model <model>",
        detailPart: "not a known harness or a saved preset",
      },
      {
        argv: ["crew", "add", "claude", "--preset", "sol-max"],
        errorClass: "preset_not_found",
        actionPart: "choose an available preset",
        detailPart: "preset 'sol-max' was not found",
      },
    ];
    for (const expected of expectations) {
      const r = spawnSync("bash", [join(repo, "bin", "tap"), ...expected.argv], { cwd: doorCwd, env, encoding: "utf8" });
      // The resolver exits 2 (pinned by the refusal matrix on direct module
      // spawns), but the crew bridge's relay re-renders the refusal through
      // tap_fail 1 — the public rc has been 1 since the Python incumbent, and
      // this arm pins the BRIDGE contract, not the module's.
      expect([expected.argv, r.status]).toEqual([expected.argv, 1]);
      expect([expected.argv, r.stderr]).toEqual([expected.argv, ""]);
      const envelope = JSON.parse(r.stdout) as Record<string, unknown>;
      expect([expected.argv, envelope.ok]).toEqual([expected.argv, false]);
      expect([expected.argv, envelope.error_class]).toEqual([expected.argv, expected.errorClass]);
      expect(String(envelope.action)).toContain(expected.actionPart);
      expect(String(envelope.detail)).toContain(expected.detailPart);
      expect(JSON.stringify(envelope)).not.toContain('"handle"');
    }
  });
});

for (const source of [undefined, "version=3\n", "version=3\n[presets]\n"]) {
  test(`unknown launch names modern config with ${source ?? "no config"}`, () => {
    const xdg = source === undefined ? join(scratchRoot,"fresh-missing") : freshConfig(source);
    const env = {...process.env, XDG_CONFIG_HOME:xdg};
    let failure: any;
    try { resolveLaunchPresetArgs(env,new Notices(),{harness:"nosuch",label:"x"}); }
    catch (error) { failure=error; }
    expect(failure.errorClass).toBe("harness_or_preset_not_found");
    expect(failure.detail).toContain("not a known harness or a saved preset");
    expect(failure.detail).toContain(join(xdg,"tap/config.toml"));
    expect(failure.detail).not.toContain("presets.toml");
    expect(failure.detail).toContain("canonical harnesses: agy, claude, codex, cursor, hermes, opencode");
    expect(failure.detail).toContain("available presets: none");
    expect(failure.action).toContain("tap presets");
    expect(failure.action).toContain("tap launch claude newcomer");
    const probe=run(["nosuch","x"],xdg,{TAP_JSON:"1"});
    expect(JSON.parse(probe.stdout).detail).toBe(failure.detail);
    expect(JSON.parse(probe.stdout).action).toContain("tap crew add claude newcomer --model <model>");
    expect(JSON.parse(probe.stdout).action).not.toContain("tap launch");
  });
}

test("unknown implicit names list canonical harnesses and loaded presets on both doors", () => {
  const xdg = freshConfig();
  const probe = run(["nosuch", "x"], xdg, { TAP_JSON: "1" });
  const detail = JSON.parse(probe.stdout).detail;
  expect(detail).toContain("canonical harnesses: agy, claude, codex, cursor, hermes, opencode");
  expect(detail).toContain("available presets: bare, opus");
  let failure: any;
  try { resolveLaunchPresetArgs({ ...process.env, XDG_CONFIG_HOME: xdg }, new Notices(), { harness: "nosuch", label: "x" }); }
  catch (error) { failure = error; }
  expect(failure.detail).toBe(detail);
});

describe("a known spelling of a harness is refused with its canonical name", () => {
  const spellings: Array<[typed: string, harness: string, cause: string]> = [
    ["cursor-agent", "cursor", "TAP's name for that harness is 'cursor'"],
    ["antigravity", "agy", "TAP's name for that harness is 'agy'"],
    ["antigravity-cli", "agy", "TAP's name for that harness is 'agy'"],
    ["claude-code", "claude", "TAP's name for that harness is 'claude'"],
    ["open-code", "opencode", "TAP's name for that harness is 'opencode'"],
    ["hermes-agent", "hermes", "TAP's name for that harness is 'hermes'"],
    ["Antigravity", "agy", "TAP's name for that harness is 'agy'"],
    ["Claude", "claude", "harness names are lowercase: 'claude'"],
    ["gemini", "agy", "Google's Gemini CLI is not a supported harness; Google's Antigravity CLI is, as 'agy'"],
    ["gemini-cli", "agy", "Google's Gemini CLI is not a supported harness; Google's Antigravity CLI is, as 'agy'"],
  ];
  const configs: Array<[string, () => string]> = [
    ["no config", () => join(scratchRoot, "spelling-absent")],
    ["a catalog", () => freshConfig()],
  ];

  for (const [typed, harness, cause] of spellings) {
    for (const [label, config] of configs) {
      test(`launch '${typed}' with ${label} names '${harness}' and never launches`, () => {
        const env = { ...process.env, XDG_CONFIG_HOME: config() };
        let failure: any;
        let resolved: unknown;
        try { resolved = resolveLaunchPresetArgs(env, new Notices(), { harness: typed, label: "x" }); }
        catch (error) { failure = error; }
        expect(resolved).toBeUndefined();
        expect(failure.errorClass).toBe("harness_or_preset_not_found");
        expect(failure.detail).toBe(`'${typed}' is not a known harness or a saved preset; ${cause}`);
        expect(failure.action).toBe(`tap launch ${harness} newcomer`);
      });
    }
  }

  test("the crew door gives the same cause with its own example and exit", () => {
    const r = run(["cursor-agent", "x"], freshConfig());
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("tap crew: 'cursor-agent' is not a known harness or a saved preset; TAP's name for that harness is 'cursor'; next: tap crew add cursor newcomer --model <model>\n");
    const json = run(["gemini", "x"], freshConfig(), { TAP_JSON: "1" });
    expect(json.status).toBe(2);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)).toEqual({
      ok: false,
      error_class: "harness_or_preset_not_found",
      action: "tap crew add agy newcomer --model <model>",
      detail: "'gemini' is not a known harness or a saved preset; Google's Gemini CLI is not a supported harness; Google's Antigravity CLI is, as 'agy'",
    });
  });

  test("a saved preset with one of these names still resolves", () => {
    const xdg = freshConfig('version = 2\n\n[presets.gemini]\nharness = "agy"\n');
    const resolved = resolveLaunchPresetArgs({ ...process.env, XDG_CONFIG_HOME: xdg }, new Notices(), { harness: "gemini", label: "x" });
    expect(resolved.harness).toBe("agy");
    expect(resolved.preset_name).toBe("gemini");
  });

  test("a word TAP has never heard of keeps the full list", () => {
    let failure: any;
    try { resolveLaunchPresetArgs({ ...process.env, XDG_CONFIG_HOME: join(scratchRoot, "spelling-absent") }, new Notices(), { harness: "aider", label: "x" }); }
    catch (error) { failure = error; }
    expect(failure.detail).toContain("canonical harnesses: agy, claude, codex, cursor, hermes, opencode");
    expect(failure.action).toBe("tap presets, or launch a harness directly: tap launch claude newcomer");
  });
});
