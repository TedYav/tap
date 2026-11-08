// `tap session list` — the native session snapshot (S2 of the launcher tail).
// Controls: every golden form reproduces the Python oracle BYTE-for-BYTE
// (captured at the plan base into support/launcher-list/goldens/ by the driver
// in a scratch directory, oracle deleted in the same PR) against a UNIQUE
// fixture root, with only that root prefix normalized back to the canonical
// golden spelling; no form writes any TAP state; list forms are native on the
// primary doors and stay on the Bash adapter under a selected Bash runtime;
// BOM registries and a slow/lying tmux refuse exactly as the incumbent did;
// ordering is by code point where the incumbent sorted strings; and the
// installed-style doors write nothing under HOME. See
// support/launcher-list/fixtures.ts for the tree, the case table shared with
// the capture driver, and the tmux setup both engines must reproduce.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadNativeHandlers, route } from "../main";
import { lookupHelp } from "../src/help";
import {
  buildFixtureTree,
  fixtureEnv,
  goldenCases,
  installActingRegistry,
  normalizeRoot,
  snapshot,
  TMUX_NAMES,
  type FixtureMap,
} from "./support/launcher-list/fixtures";
import { removeScratchTree } from "./support/scratch";

const NATIVE_HANDLERS = await loadNativeHandlers();

const repo = resolve(import.meta.dir, "../../..");
const module = join(repo, "runtime/bun/src/launcher/list.ts");
const goldens = join(import.meta.dir, "support/launcher-list/goldens");

// This file owns its socket: sibling suites create sessions on the shared
// runner socket, which would flip the goldens' live flags under load.
const tmuxSocket = "tapbun-list-golden";

let fx: FixtureMap;
const tmux = (args: string[]) => spawnSync("tmux", ["-L", tmuxSocket, ...args], { encoding: "utf8" });

beforeAll(() => {
  fx = buildFixtureTree();
  installActingRegistry(fx, "main");
  for (const name of TMUX_NAMES) {
    const created = tmux(["new-session", "-d", "-s", name]);
    if (created.status !== 0 && !created.stderr.includes("duplicate session")) {
      throw new Error(`tmux create ${name} failed: ${created.stderr}`);
    }
  }
});

afterAll(() => {
  tmux(["kill-server"]);
  removeScratchTree(fx.fg);
});

const goldenText = (name: string) => readFileSync(join(goldens, name), "utf8");

/** Env for a spawn that must see the fixture, with this file's own tmux socket. */
function goldenEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return fixtureEnv(fx, { TAP_TMUX_SOCKET: tmuxSocket, ...extra });
}

const TMUX_REFUSAL = "tmux session-name snapshot is unobservable; refusing to treat the session namespace as empty";
const NO_INDEX_REFUSAL = "no machine index (global-registry.json); this machine has no enrolled team; next: tap init  OR  tap session launch";

/** Write `<dir>/global-registry.json` enrolling each team at its realpath root and registry. */
function enrollIndex(dir: string, teams: Record<string, { root: string; registry: string }>): string {
  mkdirSync(dir, { recursive: true });
  const entries = Object.fromEntries(Object.entries(teams).map(([name, { root, registry }]) =>
    [name, { root: realpathSync(root), registry_location: realpathSync(registry), state: "registered" }]));
  writeFileSync(join(dir, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: entries }));
  return dir;
}

function runModule(args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
  return spawnSync("bun", [module, ...args], { cwd: cwd ?? "/tmp", env, encoding: "utf8" });
}

/** Golden refusals captured with `--json` and no TAP_JSON: prose in the oracle, the envelope now (see the loop). */
const JSON_FLAG_REFUSALS = new Set(["10-json-agents", "24-err-unenrolled-jsonflag", "28-err-notmux"]);

describe("goldens — byte parity with the Python oracle", () => {
  test("every form reproduces the captured bytes and exit status, writing nothing", () => {
    for (const goldenCase of goldenCases(fx)) {
      const label = `${goldenCase.name} (cwd=${goldenCase.cwd ?? "/tmp"})`;
      const before = snapshot(fx.fg);
      const env = fixtureEnv(fx, { TAP_TMUX_SOCKET: tmuxSocket, ...goldenCase.env });
      if (goldenCase.pathPrefix) env.PATH = `${goldenCase.pathPrefix}:${env.PATH}`;
      const r = runModule(goldenCase.args, env, goldenCase.cwd);
      if (JSON_FLAG_REFUSALS.has(goldenCase.name)) {
        // RULED DEVIATION (tap-az7l4.1 review): the incumbent's refusal branches read only TAP_JSON, so `--json`
        // alone got prose while the help page promised the envelope. `--json` now selects the envelope, as TAP_JSON does.
        // Same exit status and no stderr; stdout is the envelope, whose class and detail come from the captured prose.
        const captured = normalizeRoot(goldenText(`${goldenCase.name}.err`), fx);
        expect([label, r.stderr]).toEqual([label, ""]);
        const envelope = JSON.parse(normalizeRoot(r.stdout, fx));
        expect([label, envelope.ok]).toEqual([label, false]);
        expect(captured.startsWith("tap session: ")).toBe(true);
        expect([label, captured.includes(envelope.detail)]).toEqual([label, true]);
        expect([label, r.status]).toEqual([label, parseInt(goldenText(`${goldenCase.name}.rc`).trim(), 10)]);
        expect([label, snapshot(fx.fg)]).toEqual([label, before]);
        continue;
      }
      // The corpus is ASCII and only the unique root prefix differs from the
      // canonical capture spelling; normalization maps that one prefix.
      expect([label, normalizeRoot(r.stdout, fx)]).toEqual([label, normalizeRoot(goldenText(`${goldenCase.name}.out`), fx)]);
      if (goldenCase.name === "27-err-machbad") {
        // RULED DEVIATION: the native parser's SyntaxError prose replaces
        // Python's JSONDecodeError sentence, so the pinned contract here is
        // the structural refusal — team name, failure, next step — not the
        // middle prose.
        const stderr = normalizeRoot(r.stderr, fx);
        expect(stderr.startsWith("tap session: acting registry for team 'beta' is unreadable: ")).toBe(true);
        expect(stderr.endsWith("; next: tap doctor\n")).toBe(true);
      } else {
        expect([label, normalizeRoot(r.stderr, fx)]).toEqual([label, normalizeRoot(goldenText(`${goldenCase.name}.err`), fx)]);
      }
      expect([label, r.status]).toEqual([label, parseInt(goldenText(`${goldenCase.name}.rc`).trim(), 10)]);
      expect([label, snapshot(fx.fg)]).toEqual([label, before]);
    }
  });

  test("a malformed flag is the one usage error", () => {
    const r = runModule(["--bogus", "--cwd", fx.root], fixtureEnv(fx));
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("usage: tap session list");
  });
});

describe("absent machine index (F2c)", () => {
  test("list refuses in machine and cwd scope and never walks the bus registry", () => {
    // The pre-flip oracle walked <root>/.tap/bus and tmp/tap here; both layouts
    // stay on disk in the fixture, and neither scope may read them.
    for (const args of [["--machine", "--cwd", fx.root], ["--cwd", fx.root]]) {
      const before = snapshot(fx.fg);
      const r = runModule(args, fixtureEnv(fx, { TAP_TMUX_SOCKET: tmuxSocket, TAP_INDEX_HOME: join(fx.fg, "index-missing") }));
      expect([args, r.status, r.stdout, r.stderr]).toEqual([args, 2, "", `tap session: ${NO_INDEX_REFUSAL}\n`]);
      expect([args, snapshot(fx.fg)]).toEqual([args, before]);
    }
  });

  test("--json alone (no TAP_JSON) renders every state refusal as the envelope, as TAP_JSON does", () => {
    const env = fixtureEnv(fx, { TAP_TMUX_SOCKET: tmuxSocket, TAP_INDEX_HOME: join(fx.fg, "index-missing") });
    delete env.TAP_JSON;
    for (const args of [["--json", "--cwd", fx.root], ["--json", "--machine", "--cwd", fx.root], ["--names-only", "--include-tmux", "--json", "--cwd", fx.root]]) {
      const r = runModule(args, env);
      expect([args.join(" "), r.status, r.stderr]).toEqual([args.join(" "), 2, ""]);
      expect([args.join(" "), JSON.parse(r.stdout.trim())]).toEqual([args.join(" "), { ok: false, error_class: "unanchored_bus", action: "tap init  OR  tap session launch",
        detail: "no machine index (global-registry.json); this machine has no enrolled team" }]);
    }
    // The tmux-unobservable refusal takes the same path.
    const slowBin = join(fx.fg, "tmux-slow-bin-json");
    mkdirSync(slowBin, { recursive: true });
    writeFileSync(join(slowBin, "tmux"), "#!/bin/sh\nsleep 5\n");
    spawnSync("chmod", ["+x", join(slowBin, "tmux")]);
    const slow = fixtureEnv(fx, { TAP_TMUX_TIMEOUT_SECONDS: "0.01", TAP_TMUX_SOCKET: "tap-list-capture-absent" });
    delete slow.TAP_JSON;
    slow.PATH = `${slowBin}:${slow.PATH}`;
    const t = runModule(["--json", "--cwd", fx.root], slow);
    expect([t.status, t.stderr]).toEqual([2, ""]);
    expect(t.stdout).toBe(`{"ok":false,"error_class":"session_error","action":"tap help session","detail":"${TMUX_REFUSAL}"}\n`);
  });

  test("TAP_JSON renders the refusal as unanchored_bus with its recovery", () => {
    const r = runModule(["--json", "--cwd", fx.root], fixtureEnv(fx, { TAP_TMUX_SOCKET: tmuxSocket, TAP_INDEX_HOME: join(fx.fg, "index-missing"), TAP_JSON: "1" }));
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ error_class: "unanchored_bus", action: "tap init  OR  tap session launch",
      detail: "no machine index (global-registry.json); this machine has no enrolled team" });
  });
});

describe("BOM registry — RULED DEVIATION: native strips U+FEFF and accepts, unlike the incumbent", () => {
  // The Python reader opened plain utf-8, so a leading U+FEFF rode into
  // json.load and refused the document. The native decoder strips it, and the
  // ceiling brief rules that acceptance is the shipped behavior — these arms
  // pin the deviation, byte-neutral against the same registry without a BOM.
  test("cwd scope accepts a BOM-prefixed registry with byte-identical output", () => {
    const candidate = join(fx.root, ".tap/bus/registry.json");
    const original = readFileSync(candidate);
    // Enrolled at the candidate itself, so the cwd scope reads the file this arm BOM-prefixes.
    const index = enrollIndex(join(fx.fg, "index-bom-cwd"), { alpha: { root: fx.root, registry: candidate } });
    try {
      const baseline = runModule(["--json", "--cwd", fx.root], fixtureEnv(fx, { TAP_INDEX_HOME: index, TAP_TMUX_SOCKET: "tap-list-capture-absent" }));
      expect(baseline.status).toBe(0);
      writeFileSync(candidate, Buffer.concat([Buffer.from("\uFEFF", "utf8"), original]));
      const withBom = runModule(["--json", "--cwd", fx.root], fixtureEnv(fx, { TAP_INDEX_HOME: index, TAP_TMUX_SOCKET: "tap-list-capture-absent" }));
      expect([withBom.status, withBom.stdout]).toEqual([0, baseline.stdout]);
      expect(withBom.stderr).toBe("");
    } finally {
      writeFileSync(candidate, original);
    }
  });

  test("--machine accepts a BOM-prefixed team registry", () => {
    const bomReg = join(fx.reg, "bom.json");
    writeFileSync(bomReg, '\uFEFF{"schema":"0.20","seats":{}}', "utf8");
    const index = join(fx.fg, "index-bom");
    mkdirSync(index, { recursive: true });
    writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { alpha: { root: fx.root, registry_location: bomReg } } }));
    const r = runModule(["--json", "--machine", "--cwd", fx.root], fixtureEnv(fx, { TAP_INDEX_HOME: index, TAP_TMUX_SOCKET: "tap-list-capture-absent" }));
    expect([r.status, r.stderr]).toEqual([0, ""]);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, count: 0, scope: "machine" });
  });
});

describe("ordering — RULED DEVIATION: UTF-16 code-unit order, not the incumbent's code-point sorted()", () => {
  // U+10000's leading surrogate D800 sits BELOW U+E000, so UTF-16 unit
  // comparison orders the astral name first ascending — the reverse of the
  // Python code-point order. The ceiling brief rules UTF-16 acceptable; these
  // arms pin the shipped deviation. The two seats share one recency so the
  // name tiebreak alone decides the view order.
  function writeAstralRegistry(): string {
    const index = join(fx.fg, "index-codepoint");
    mkdirSync(index, { recursive: true });
    const reg = join(fx.reg, "codepoint.json");
    writeFileSync(reg, JSON.stringify({
      schema: "0.20",
      team: { name: "demo", worktree_root: "" },
      seats: {
        high: { status: "active", delivery: "pane", session: "\u{10000}-seat", harness: "claude", registered_from_worktree: fx.root, base: "demo", index: 1, last_seen: "2026-09-20T10:00:00Z" },
        low: { status: "active", delivery: "pane", session: "\u{E000}-seat", harness: "claude", registered_from_worktree: fx.root, base: "demo", index: 1, last_seen: "2026-09-20T10:00:00Z" },
      },
    }));
    writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { alpha: { root: fx.root, registry_location: reg } } }));
    return index;
  }

  test("ordinary JSON order puts the BMP name first on a (recency, name) tie", () => {
    const index = writeAstralRegistry();
    const r = runModule(["--json", "--cwd", fx.root], fixtureEnv(fx, { TAP_INDEX_HOME: index, TAP_TMUX_SOCKET: "tap-list-capture-absent" }));
    expect(r.status).toBe(0);
    const names = (JSON.parse(r.stdout) as { sessions: Array<{ name: string }> }).sessions.map((row) => row.name);
    // The view order is (recency, name) REVERSED whole-tuple, so the tie
    // breaks name-DESCENDING. UTF-16 ascending is [U+10000, U+E000], so the
    // reversed view shows U+E000 first — where the incumbent's code-point
    // sort showed U+10000 first.
    expect(names).toEqual(["\u{E000}-seat", "\u{10000}-seat"]);
  });

  // The `session list` help page documents the JSON shape and the completion mode (tap-az7l4.1); these tie
  // its words to the bytes the command really prints, so the page cannot drift from the code.
  test("the documented JSON shape is the shape printed: fixed keys always, preset only when recorded", () => {
    const page = lookupHelp(["session", "list"]).stdout;
    const required = ["name", "harness", "cwd", "live", "seated", "restorable", "revive", "model", "tag", "handle", "last_seen", "last_launched"];
    const r = runModule(["--json", "--machine", "--cwd", fx.root], goldenEnv());
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout) as { ok: boolean; sessions: Array<Record<string, unknown>>; count: number; scope: string };
    expect(Object.keys(doc)).toEqual(["ok", "sessions", "count", "scope"]);
    expect([doc.ok, doc.count, doc.scope]).toEqual([true, doc.sessions.length, "machine"]);
    expect(doc.sessions.length).toBeGreaterThan(1);
    for (const row of doc.sessions) {
      const keys = Object.keys(row);
      expect(keys.filter(key => key !== "preset")).toEqual(required);
      if ("preset" in row) expect(Object.values(row.preset as Record<string, unknown>).every(v => typeof v === "string")).toBe(true);
    }
    // Both shapes occur in the fixture, so "present only when recorded" is exercised on each side.
    expect(doc.sessions.some(row => "preset" in row)).toBe(true);
    expect(doc.sessions.some(row => !("preset" in row))).toBe(true);
    for (const key of [...required, "preset", "ok", "sessions", "count", "scope"]) expect(page).toContain(key);
    expect(page).toContain('"scope": "cwd" | "machine"');
  });

  test("a usage error under --json is the envelope on stdout with empty stderr and exit 2, as the page says", () => {
    const usage = "usage: tap session list [--harness LIST] [--model LIST] [--cwd CWD] [--all] [--live] [--machine] [--json] [--names-only] [--include-tmux]";
    const cases: Array<[string[], string, string]> = [
      [["--json", "--bogus"], "unknown_option", `unknown option '--bogus'`],
      [["--bogus", "--json"], "unknown_option", `unknown option '--bogus'`],
      [["--json", "--harness", "nonesuch"], "usage_error", `--harness 'nonesuch' is not a supported harness`],
      [["--json", "--harness", "claude,nonesuch"], "usage_error", `--harness 'nonesuch' is not a supported harness`],
      [["--json", "--harness", ","], "usage_error", "--harness needs a value"],
      [["--json", "--model", "--machine"], "usage_error", "--model needs a value"],
      [["--json", "--state", "idle"], "usage_error", "--state needs an observed state, and session records store none; use tap teams --state <list>"],
      [["--json", "--cwd"], "usage_error", "--cwd needs a value"],
      [["--cwd", "--json"], "usage_error", "--cwd needs a value"],
      // A bare operand is an unexpected argument; only an option-shaped token is an unknown option.
      [["--json", "foo"], "usage_error", "unexpected argument 'foo'"],
      [["foo", "--json"], "usage_error", "unexpected argument 'foo'"],
      [["--json", "--x"], "unknown_option", "unknown option '--x'"],
      // CR/LF in echoed operator text folds to spaces, so the refusal stays one JSON line.
      [["--json", "a\nb\r\nc"], "usage_error", "unexpected argument 'a b  c'"],
      [["--json", "--x\ny"], "unknown_option", "unknown option '--x y'"],
    ];
    for (const [args, errorClass, detail] of cases) {
      const r = runModule(args, goldenEnv());
      expect([args.join(" "), r.status, r.stderr]).toEqual([args.join(" "), 2, ""]);
      expect([args.join(" "), JSON.parse(r.stdout)]).toEqual([args.join(" "), { ok: false, error_class: errorClass, action: "tap help session list", detail: `${detail}; ${usage}` }]);
      expect([args.join(" "), r.stdout.replace(/\n$/, "").includes("\n")]).toEqual([args.join(" "), false]);   // one line, whatever the operand held
    }
    // TAP_JSON=1 selects the envelope too; without either, the usage line stays on stderr.
    const viaEnv = runModule(["--bogus"], goldenEnv({ TAP_JSON: "1" }));
    expect([viaEnv.status, viaEnv.stderr, JSON.parse(viaEnv.stdout).error_class]).toEqual([2, "", "unknown_option"]);
    const plain = runModule(["--bogus"], goldenEnv());
    expect([plain.status, plain.stdout, plain.stderr]).toEqual([2, "", usage + "\n"]);
    // --state names its cause in text mode too: a usage line alone would hide why the filter was refused.
    const noState = runModule(["--state", "idle"], goldenEnv());
    expect([noState.status, noState.stdout, noState.stderr]).toEqual([2, "", "tap session list: --state needs an observed state, and session records store none; use tap teams --state <list>; next: tap help session list\n"]);
    // A state refusal under --json is the envelope as well (the no-index golden case above pins the bytes).
    const state = runModule(["--json", "--cwd", fx.root], fixtureEnv(fx, { TAP_TMUX_SOCKET: tmuxSocket, TAP_INDEX_HOME: join(fx.fg, "index-missing"), TAP_JSON: "1" }));
    expect([state.status, JSON.parse(state.stdout).ok, state.stderr]).toEqual([2, false, ""]);
    const page = lookupHelp(["session", "list"]).stdout;
    expect(page).toContain("A usage error (an unknown option or a bad operand) follows the same grammar and exits 2: without --json it prints the usage line on stderr; with --json (or TAP_JSON=1) it prints");
    expect(page).toContain("A state or data refusal");
  });

  test("completion mode (--names-only --include-tmux) ignores --json and --live and is plain names", () => {
    const env = goldenEnv();
    const plain = runModule(["--names-only", "--include-tmux", "--cwd", fx.root], env);
    expect(plain.status).toBe(0);
    expect(plain.stdout.length).toBeGreaterThan(0);
    for (const extra of [["--json"], ["--live"], ["--json", "--live"]]) {
      const r = runModule(["--names-only", "--include-tmux", ...extra, "--cwd", fx.root], env);
      expect([extra.join(" "), r.status, r.stdout]).toEqual([extra.join(" "), 0, plain.stdout]);
    }
    // Without --include-tmux the JSON view wins over --names-only, as the page says.
    const json = runModule(["--names-only", "--json", "--cwd", fx.root], env);
    expect(() => JSON.parse(json.stdout)).not.toThrow();
    const page = lookupHelp(["session", "list"]).stdout;
    expect(page).toContain("Completion mode: --names-only with --include-tmux prints plain session names");
    expect(page).toContain("--json wins over it");
  });

  test("names-only --include-tmux lists registry names first, then unseen tmux names UTF-16 ASC", () => {
    const index = writeAstralRegistry();
    for (const name of ["\u{E000}-tmux", "\u{10000}-tmux"]) {
      const created = tmux(["new-session", "-d", "-s", name]);
      if (created.status !== 0 && !created.stderr.includes("duplicate session")) throw new Error(`tmux create ${name}: ${created.stderr}`);
    }
    // list_records sorts registry names ASCENDING within the cwd-matched group.
    const r = runModule(["--names-only", "--include-tmux", "--cwd", fx.root], fixtureEnv(fx, { TAP_INDEX_HOME: index, TAP_TMUX_SOCKET: tmuxSocket }));
    expect(r.status).toBe(0);
    // UTF-16 ascending: the astral surrogate D800 sits below U+E000, and both
    // astral units sit above ASCII, so the unseen tmux names run ASCII names,
    // then U+10000, then U+E000.
    expect(r.stdout.split("\n").filter(Boolean)).toEqual([
      "\u{10000}-seat",
      "\u{E000}-seat",
      "demo/scout",
      "tmux-only",
      "\u{10000}-tmux",
      "\u{E000}-tmux",
    ]);
    // --harness filters the registry rows only; unseen tmux names are appended unfiltered, as the page says.
    const filtered = runModule(["--names-only", "--include-tmux", "--harness", "claude", "--cwd", fx.root], fixtureEnv(fx, { TAP_INDEX_HOME: index, TAP_TMUX_SOCKET: tmuxSocket }));
    expect(filtered.status).toBe(0);
    const names = filtered.stdout.split("\n").filter(Boolean);
    expect(names).toEqual(expect.arrayContaining(["tmux-only", "\u{10000}-tmux", "\u{E000}-tmux"]));
    expect(lookupHelp(["session", "list"]).stdout).toContain("those tmux names are appended unfiltered: --harness cannot filter them");
    // A registered session a filter excludes stays excluded while it runs in tmux: only sessions tap did not launch are appended.
    const running = tmux(["new-session", "-d", "-s", "\u{10000}-seat"]);
    if (running.status !== 0 && !running.stderr.includes("duplicate session")) throw new Error(`tmux create: ${running.stderr}`);
    try {
      for (const filter of [["--harness", "codex"], ["--model", "opus"]]) {
        const r = runModule(["--names-only", "--include-tmux", ...filter, "--cwd", fx.root], fixtureEnv(fx, { TAP_INDEX_HOME: index, TAP_TMUX_SOCKET: tmuxSocket }));
        expect(r.status).toBe(0);
        const shown = r.stdout.split("\n").filter(Boolean);
        expect([filter.join(" "), shown.includes("\u{10000}-seat"), shown.includes("tmux-only")]).toEqual([filter.join(" "), false, true]);
      }
    } finally {
      tmux(["kill-session", "-t", "=\u{10000}-seat"]);
    }
  });
});

describe("tmux pane liveness snapshot", () => {
  test("missing, invalid or extra dead-state fields refuse instead of claiming an empty live set", () => {
    const bin = join(fx.fg, "tmux-malformed-pane-bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "tmux"), "#!/bin/sh\nprintf '%s' \"$TEST_PANE_RECORD\"\n", { mode: 0o755 });
    for (const record of ["demo/scout\n", "demo/scout\t?\n", "demo/scout\t0\textra\n"]) {
      const env = goldenEnv({ TEST_PANE_RECORD: record });
      env.PATH = bin + ":" + env.PATH;
      const result = runModule(["--live", "--json", "--cwd", fx.root], env);
      // --json alone selects the envelope (RULED DEVIATION from the incumbent, see the goldens block).
      expect([result.status, result.stdout, result.stderr]).toEqual([2, `{"ok":false,"error_class":"session_error","action":"tap help session","detail":"${TMUX_REFUSAL}"}\n`, ""]);
    }
  });
});

describe("tmux client failure — only the deadline class is translated at the list boundary", () => {
  test("a server that blows the read deadline refuses once, rc 2, no stack trace", () => {
    const slowBin = join(fx.fg, "tmux-slow-bin");
    mkdirSync(slowBin, { recursive: true });
    writeFileSync(join(slowBin, "tmux"), "#!/bin/sh\nsleep 5\n");
    spawnSync("chmod", ["+x", join(slowBin, "tmux")]);
    const env = fixtureEnv(fx, { TAP_TMUX_TIMEOUT_SECONDS: "0.01", TAP_TMUX_SOCKET: "tap-list-capture-absent" });
    env.PATH = `${slowBin}:${env.PATH}`;
    const prose = runModule(["--cwd", fx.root], env);
    expect([prose.status, prose.stdout]).toEqual([2, ""]);
    expect(prose.stderr).toBe(`tap session: ${TMUX_REFUSAL}\n`);
    const envelope = runModule(["--cwd", fx.root], { ...env, TAP_JSON: "1" });
    expect([envelope.status, envelope.stderr]).toEqual([2, ""]);
    expect(envelope.stdout).toBe(`{"ok":false,"error_class":"session_error","action":"tap help session","detail":"${TMUX_REFUSAL}"}\n`);
  });
});

// Snapshot line shapes (fixtures.snapshot): `link\t<rel>\t<readlink>`,
// `d\t<rel>`, `sha256\t<bytes>\t<rel>`. The path is field 1 for links and the
// last field otherwise.
function snapshotPath(line: string): string {
  const fields = line.split("\t");
  return fields[0] === "link" ? fields[1]! : fields[fields.length - 1]!;
}

// The ONLY entries a door run may add beneath the snapshotted root are TAP's
// owned tmux rate-cache claims under the door's TAP_INDEX_HOME: the directory
// itself, `tmux-rate-<64 lowercase hex>.json`, and its `.lock`. An allowlist,
// not a substring test — an unrelated path that merely contains
// "/runtime-cache" stays visible to the comparison.
function isOwnedRateCache(line: string): boolean {
  // .lock is grouped with the tmux-rate filename so the bare sibling
  // `runtime-cache.lock` stays a refusal-visible foreign path.
  return /^\/?door-index\/runtime-cache(\/tmux-rate-[0-9a-f]{64}\.json(\.lock)?)?$/.test(snapshotPath(line));
}

function visibleSnapshot(lines: string[]): string[] {
  return lines.filter((line) => !isOwnedRateCache(line));
}

describe("installed door — symlinked bin/tap from an unrelated cwd, fresh HOME, no test cache pin", () => {
  test("the door serves stable list bytes; non-verbose forms write nothing, verbose claims only the TAP rate cache", () => {
    const door = join(fx.fg, "door-home");
    mkdirSync(door, { recursive: true });
    const unrelated = join(fx.fg, "door-cwd");
    mkdirSync(unrelated, { recursive: true });
    // The door's own index enrolls the unrelated cwd (an empty team, so the
    // bare forms list none) and the fixture repo (the --cwd-anchored form).
    // An absent index refuses every list form, and a live index refuses an
    // unenrolled cwd, so both roots must be enrolled.
    const doorRegistry = join(unrelated, ".tap", "team-registry.json");
    mkdirSync(join(unrelated, ".tap"), { recursive: true });
    writeFileSync(doorRegistry, JSON.stringify({ schema: "0.20", team: { name: "door", worktree_root: realpathSync(unrelated) }, seats: {} }));
    const doorIndex = enrollIndex(join(fx.fg, "door-index"), {
      door: { root: unrelated, registry: doorRegistry },
      alpha: { root: fx.root, registry: join(fx.reg, "registry.json") },
    });
    // Installed-style: the entry point is a symlink inside the owned root that
    // resolves to bin/tap and is invoked AS THE EXECUTABLE, not via `bash
    // <source path>` — shebang resolution and argv[0] are part of the proof.
    const installed = join(fx.fg, "installed");
    mkdirSync(installed, { recursive: true });
    const tapLink = join(installed, "tap");
    symlinkSync(join(repo, "bin", "tap"), tapLink);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: door,
      TAP_HOME: join(fx.fg, "door-bus"),
      TAP_INDEX_HOME: doorIndex,
      TAP_SESSION_MANIFEST: join(door, "sessions.json"),
      OPENCODE_DB_PATH: join(door, "opencode.db"),
      TAP_VERSION_SEEN_PATH: join(door, "version-seen.json"),
      TAP_TMUX_SOCKET: "tap-list-capture-absent",
    };
    // The door must pin the Bun transpiler cache ITSELF (finding 5); an arm
    // that pins it here cannot see the write this spawn would make.
    delete env.BUN_RUNTIME_TRANSPILER_CACHE_PATH;
    delete env.COLUMNS;
    // Owned roots under fx.fg — door HOME + manifests, door-bus, door-index,
    // installed/ — are created above and EMPTY. Snapshot the whole fixture
    // root after setup and before any door run: every byte the door touches
    // must land only inside roots this snapshot covers.
    const before = snapshot(fx.fg);
    const run = (args: string[]) => spawnSync(tapLink, args, { cwd: unrelated, env, encoding: "utf8" });
    // The true bare form, the explicit subcommand, the flag-led form, a
    // --cwd-anchored form, and a non-list native control that must keep
    // working untouched: NONE of these may write a byte.
    const bare = run(["session"]);
    const listed = run(["session", "list"]);
    const flagged = run(["session", "--json"]);
    const led = run(["session", "list", "--json", "--cwd", fx.root]);
    const control = run(["session", "complete", "harnesses"]);
    expect([bare.status, bare.stdout]).toEqual([0, "tap session: no sessions\n"]);
    expect([listed.status, listed.stdout]).toEqual([0, "tap session: no sessions\n"]);
    expect([flagged.status, flagged.stdout]).toEqual([0, '{"ok":true,"sessions":[],"count":0,"scope":"cwd"}\n']);
    expect(led.status).toBe(0);
    expect(JSON.parse(led.stdout)).toMatchObject({ ok: true, scope: "cwd" });
    expect(control.status).toBe(0);
    expect(control.stdout).not.toBe("");
    expect(snapshot(fx.fg)).toEqual(before);
    // The leading-global-verbose form is the one shape that writes — and the
    // write is TAP-OWNED, not a foreign cache: main.ts strips -v/--verbose
    // into TAP_VERBOSE=1, the pre-existing overdue advisor then runs for
    // every verb, and its callingPane() tmux observation makes the tmux
    // rate limiter claim a token under TAP_INDEX_HOME/runtime-cache — state
    // cacheRoot exists to hold (discovered by this arm, reported to the
    // driver). The claim is excluded here; every OTHER byte must match.
    const verbose = run(["--verbose", "session", "--json"]);
    expect([verbose.status, verbose.stdout]).toEqual([0, '{"ok":true,"sessions":[],"count":0,"scope":"cwd"}\n']);
    expect(visibleSnapshot(snapshot(fx.fg))).toEqual(visibleSnapshot(before));
  });

  test("the snapshot exception is an allowlist, not a substring match", () => {
    // The only writes the verbose form may make are TAP's owned tmux
    // rate-cache claims. The predicate must admit exactly those lines and
    // keep everything else — including any unrelated path that merely
    // CONTAINS "/runtime-cache" — visible to the comparison.
    const hex = "a".repeat(64);
    const owned = [
      `d\tdoor-index/runtime-cache`,
      `sha256\t33\tdoor-index/runtime-cache/tmux-rate-${hex}.json`,
      `sha256\t9\tdoor-index/runtime-cache/tmux-rate-${hex}.json.lock`,
    ];
    const foreign = [
      `sha256\t5\tdoor-home/runtime-cache/rogue.json`,
      `sha256\t5\tdoor-index/runtime-cache.lock`,
      `sha256\t5\tdoor-index/runtime-cache/tmux-rate-ABCDEF123.json`,
      `sha256\t5\tdoor-index/runtime-cache/other.json`,
      `sha256\t5\telsewhere/runtime-cache/tmux-rate-${hex}.json`,
    ];
    for (const line of owned) expect(isOwnedRateCache(line)).toBe(true);
    for (const line of foreign) expect(isOwnedRateCache(line)).toBe(false);
    expect(visibleSnapshot([...owned, ...foreign])).toEqual(foreign);
  });
});

describe("cwd containment — the public door's scope predicate", () => {
  test("root, descendant, and ..cache are listed; the root's ancestor is not", () => {
    // A private non-git root keeps this arm independent of the golden loop's
    // main registry: its own index enrolls it at its own registry file.
    const contain = join(fx.fg, "contain");
    const child = join(contain, "child");
    const dotcache = join(contain, "..cache");
    mkdirSync(child, { recursive: true });
    mkdirSync(dotcache, { recursive: true });
    const seatAt = (session: string, cwd: string) => ({
      status: "active", delivery: "pane", pane: "demo/x:0.0", pane_id: "%1",
      harness: "claude", session, tag: session, index: 1, registered_from_worktree: cwd,
    });
    mkdirSync(join(contain, ".tap", "bus"), { recursive: true });
    writeFileSync(join(contain, ".tap", "bus", "registry.json"), JSON.stringify({
      schema: "0.20",
      team: { name: "demo", worktree_root: contain },
      seats: {
        atRoot: seatAt("at-root", contain),
        inChild: seatAt("in-child", child),
        inAncestor: seatAt("in-ancestor", fx.fg),
        inDotcache: seatAt("in-dotcache", dotcache),
      },
    }));
    const home = join(fx.fg, "contain-home");
    const index = enrollIndex(join(fx.fg, "contain-index"), { demo: { root: contain, registry: join(contain, ".tap", "bus", "registry.json") } });
    const unrelated = join(fx.fg, "contain-cwd");
    mkdirSync(home, { recursive: true });
    mkdirSync(unrelated, { recursive: true });
    const installed = join(fx.fg, "installed-contain");
    mkdirSync(installed, { recursive: true });
    const tapLink = join(installed, "tap");
    symlinkSync(join(repo, "bin", "tap"), tapLink);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      TAP_INDEX_HOME: index,
      TAP_TMUX_SOCKET: "tap-list-capture-absent",
    };
    // The doors must pin the Bun transpiler cache themselves (finding 5).
    delete env.BUN_RUNTIME_TRANSPILER_CACHE_PATH;
    const run = spawnSync(tapLink, ["session", "list", "--json", "--cwd", contain], {
      cwd: unrelated,
      env,
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    const payload = JSON.parse(run.stdout) as { ok: boolean; count: number; scope: string; sessions: Array<{ name: string; cwd: string }> };
    // Exact included set: the requested root, its descendant, and the
    // sibling-prefix "..cache" child — the root's ancestor stays out.
    expect(payload).toMatchObject({ ok: true, count: 3, scope: "cwd" });
    expect(payload.sessions.map((s) => s.name)).toEqual(["in-dotcache", "in-child", "at-root"]);
    expect(payload.sessions.map((s) => s.cwd)).toEqual([dotcache, child, contain]);
  });
});

describe("router — list forms are native on every launcher pin, as is an unknown subcommand", () => {
  test("bare session, list, and flag forms route native regardless of launcher pin; stop is refused natively", async () => {
    const scratch = join(fx.fg, "router");
    mkdirSync(scratch, { recursive: true });
    const trace = join(scratch, "trace");
    const delegated: string[][] = [];
    const fallback = (argv: string[]) => {
      delegated.push(argv);
      return 22;
    };
    const doors: Array<Record<string, string | undefined>> = [
      { TAP_LAUNCHER: undefined },
      { TAP_LAUNCHER: "bun" },
      { TAP_LAUNCHER: "python" },
    ];
    // This block runs route() IN-PROCESS, so its live snapshot consults whatever
    // tmux the ambient PATH resolves. Under the full suite that tmux's answers
    // are nobody's fixture (leaked servers, fork pressure), which flips the
    // namespace verdict this assertion rests on (tap-88xka). Pin the block's own
    // shim: the no-server shape is the deterministic observable-empty answer.
    const shimBin = join(fx.fg, "router-shim-bin");
    mkdirSync(shimBin, { recursive: true });
    writeFileSync(join(shimBin, "tmux"), `#!/bin/sh
while [ "\${1:-}" = "-L" ] || [ "\${1:-}" = "-S" ]; do shift 2; done
echo "no server running on /fixture/router-socket" >&2
exit 1
`, { mode: 0o755 });
    const listForms = [["session"], ["session", "list"], ["session", "list", "--json", "--cwd", scratch]];
    // Born live: every list form runs from the scratch root, enrolled in its own index.
    const root = realpathSync(scratch);
    const index = join(scratch, "index");
    mkdirSync(join(root, ".tap"), { recursive: true });
    mkdirSync(index, { recursive: true });
    writeFileSync(join(root, ".tap", "team-registry.json"), JSON.stringify({ schema: "0.20", team: { name: "router", worktree_root: root }, seats: {} }));
    writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { router: { root, registry_location: join(root, ".tap", "team-registry.json"), state: "registered" } } }));
    const saved = { TAP_LAUNCHER: process.env.TAP_LAUNCHER, TAP_INDEX_HOME: process.env.TAP_INDEX_HOME, PATH: process.env.PATH };
    const savedCwd = process.cwd();
    process.env.TAP_INDEX_HOME = index;
    process.env.PATH = `${shimBin}:${process.env.PATH}`;
    process.chdir(root);
    try {
      for (const door of doors) {
        for (const [key, value] of Object.entries(door)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        for (const argv of listForms) {
          // The list handler is async: its revive column may consult tmux for a Cursor row.
          expect([door, argv, await route(argv, NATIVE_HANDLERS, fallback, trace)]).toEqual([door, argv, 0]);
        }
        expect([door, ["session", "stop", "x"], await route(["session", "stop", "x"], NATIVE_HANDLERS, fallback, trace)]).toEqual([
          door,
          ["session", "stop", "x"],
          1,
        ]);
      }
    } finally {
      process.chdir(savedCwd);
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(delegated).toEqual([]);
    expect(readFileSync(trace, "utf8").split("\n").filter(Boolean)).toEqual(
      doors.flatMap(() => [...listForms.map(() => "native session"), "native session"]),
    );
  });
});

describe("list parser — split operands and help (tap-az7l4.1, tap-az7l4.2)", () => {
  // Public door: bin/tap installed-style. An EMPTY index proves help and refusals
  // never reach registry or tmux (the same run without them would exit 2 on
  // "no machine index"); the inline control gets an enrolled root of its own.
  function door() {
    const dir = join(fx.fg, "parser-door");
    mkdirSync(dir, { recursive: true });
    const tapLink = join(dir, "tap");
    if (!existsSync(tapLink)) symlinkSync(join(repo, "bin", "tap"), tapLink);
    const root = join(dir, "root");
    mkdirSync(join(root, ".tap"), { recursive: true });
    const registry = join(root, ".tap", "team-registry.json");
    writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "parser", worktree_root: realpathSync(root) }, seats: {} }));
    const trace = join(dir, "trace");
    const env = (index: string): NodeJS.ProcessEnv => {
      const e: NodeJS.ProcessEnv = { ...process.env, HOME: dir, TAP_INDEX_HOME: index, TAP_HOME: join(dir, "bus"),
        TAP_SESSION_MANIFEST: join(dir, "sessions.json"), OPENCODE_DB_PATH: join(dir, "opencode.db"),
        TAP_VERSION_SEEN_PATH: join(dir, "version-seen.json"), TAP_TMUX_SOCKET: "tap-list-parser-absent", TAP_BUN_ROUTE_TRACE: trace };
      delete e.BUN_RUNTIME_TRANSPILER_CACHE_PATH;
      return e;
    };
    const empty = join(dir, "empty-index");
    mkdirSync(empty, { recursive: true });
    const enrolled = enrollIndex(join(dir, "enrolled-index"), { parser: { root, registry } });
    return {
      run: (index: string, args: string[]) => spawnSync(tapLink, ["session", "list", ...args], { cwd: root, env: env(index), encoding: "utf8" }),
      /** The public door with arbitrary argv, for the catalog spelling `tap help session list`. */
      runTap: (index: string, args: string[]) => spawnSync(tapLink, args, { cwd: root, env: env(index), encoding: "utf8" }),
      empty, enrolled, root, trace,
    };
  }
  const USAGE_LINE = "usage: tap session list [--harness LIST] [--model LIST] [--cwd CWD] [--all] [--live] [--machine] [--json] [--names-only] [--include-tmux]\n";

  test("a split --cwd or --harness followed by a recognized option refuses with usage, exit 2", () => {
    const d = door();
    for (const args of [["--cwd", "--json"], ["--harness", "--machine"], ["--cwd", "--harness", "claude"], ["--harness", "--cwd=/x"], ["--cwd", "-h"], ["--harness", "--help"],
      // argparse reads ANY dash-led token as an option, known or not.
      ["--cwd", "--bogus"], ["--cwd", "-x"], ["--cwd", "--json=v"], ["--harness", "-x"],
      // A known option is recognized before the space exemption: its value may hold spaces (argparse order).
      ["--cwd", "--harness=claude foo"], ["--cwd", "--cwd=/tmp/a b"], ["--cwd", "--json=a b"], ["--harness", "--help=x y"]]) {
      const r = d.run(d.enrolled, args);
      if (args.includes("--json")) {
        // An exact --json token is JSON intent even when the parser refuses before setting it: the envelope, nothing on stderr.
        expect([args.join(" "), r.status, r.stderr]).toEqual([args.join(" "), 2, ""]);
        expect([args.join(" "), JSON.parse(r.stdout).ok]).toEqual([args.join(" "), false]);
      } else {
        expect([args.join(" "), r.status, r.stdout, r.stderr]).toEqual([args.join(" "), 2, "", USAGE_LINE]);
      }
    }
  });

  test("an inline value keeps its literal text, even when it begins with a dash", () => {
    const d = door();
    // `--cwd=-x` is DATA: the parser accepts it and the run reaches scope resolution, which
    // refuses the unenrolled path `-x` by name. A parser refusal would have printed usage.
    const inline = d.run(d.enrolled, ["--cwd=-x"]);
    expect([inline.status, inline.stdout, inline.stderr]).toEqual([2, "", "tap session: worktree is not enrolled; next: tap session launch or tap in\n"]);
    // A split operand named like an inherited Object property is data too, not an option:
    // it reaches scope resolution exactly as the inline spelling does.
    for (const name of ["constructor", "toString", "__proto__"]) {
      const inherited = d.run(d.enrolled, ["--cwd", name]);
      expect([name, inherited.status, inherited.stdout, inherited.stderr]).toEqual([name, 2, "", "tap session: worktree is not enrolled; next: tap session launch or tap in\n"]);
    }
    // A bare "-", a negative number and a token holding a space are operands, as in argparse.
    for (const name of ["-", "-5", "-a b"]) {
      const operand = d.run(d.enrolled, ["--cwd", name]);
      expect([name, operand.status, operand.stdout, operand.stderr]).toEqual([name, 2, "", "tap session: worktree is not enrolled; next: tap session launch or tap in\n"]);
    }
    // ...while a bare inherited name is still an unknown option, never a flag.
    const bare = d.run(d.enrolled, ["constructor"]);
    expect([bare.status, bare.stdout, bare.stderr]).toEqual([2, "", USAGE_LINE]);
    // The split spelling with an ordinary operand is unchanged and lists the enrolled root.
    const split = d.run(d.enrolled, ["--json", "--cwd", d.root]);
    expect(split.status).toBe(0);
    expect(JSON.parse(split.stdout)).toMatchObject({ ok: true, count: 0, scope: "cwd" });
  });

  test("-h and --help print the list usage on stdout, exit 0, before any registry access", () => {
    const d = door();
    const catalog = d.runTap(d.empty, ["help", "session", "list"]);
    expect([catalog.status, catalog.stderr]).toEqual([0, ""]);
    for (const flag of ["-h", "--help"]) {
      for (const args of [[flag], ["--json", flag]]) {
        const r = d.run(d.empty, args);
        expect([args.join(" "), r.status, r.stderr]).toEqual([args.join(" "), 0, ""]);
        // One text, two spellings: the catalog page IS what `--help` prints.
        expect(r.stdout).toBe(catalog.stdout);
        expect(r.stdout).toBe(lookupHelp(["session", "list"]).stdout);
        // The CLI-HELP structure: NAME and USAGE first, each accepted option on its own line, runnable examples.
        expect(r.stdout.startsWith(`NAME\n  tap session list`)).toBe(true);
        expect(r.stdout).toContain(`\nUSAGE\n  ${USAGE_LINE.replace("usage: ", "")}`);
        for (const option of ["--harness LIST", "--model LIST", "--cwd CWD", "--all", "--live", "--machine", "--json", "--names-only", "--include-tmux"]) {
          expect(r.stdout.split("\n").some(line => line.startsWith(`  ${option} `))).toBe(true);
        }
        expect(r.stdout).toContain("\nEXAMPLES\n  tap session list --live\n  tap session list --machine --json\n");
        expect(r.stdout.indexOf("\nUSAGE\n")).toBeLessThan(r.stdout.indexOf("\nDESCRIPTION\n"));
        expect(r.stdout.indexOf("\nOPTIONS\n")).toBeLessThan(r.stdout.indexOf("\nEXAMPLES\n"));
        expect(r.stdout.indexOf("\nEXIT CODES\n")).toBeGreaterThan(r.stdout.indexOf("\nEXAMPLES\n"));
      }
    }
    // Unknown and malformed forms still refuse: usage on stderr, exit 2, nothing on stdout.
    for (const args of [["--bogus"], ["--harness", "nonesuch"], ["--cwd"]]) {
      const r = d.run(d.empty, args);
      expect([args.join(" "), r.status, r.stdout, r.stderr]).toEqual([args.join(" "), 2, "", USAGE_LINE]);
    }
    // The router has no Bash route: every one of these ran the native session verb.
    // (`native help` is this file's own `tap help session list` call.)
    expect(new Set(readFileSync(d.trace, "utf8").split("\n").filter(Boolean))).toEqual(new Set(["native session", "native help"]));
  });
});
