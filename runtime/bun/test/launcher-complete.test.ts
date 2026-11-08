// `tap session complete` — the native zsh completion producer (S1 of the
// launcher tail). Controls: every refusal status offers nothing and exits 0;
// an absent machine index resolves no registry; the relaunch predicate
// agrees with frozen pre-retirement Python verdicts over one row matrix; nothing under the
// index, the bus or $HOME changes; TAP_HOME is ignored; the router carries
// `session complete` natively on every door while other session forms stay
// Bash; the Bash door stays silent without a runtime.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadNativeHandlers, route } from "../main";
import { cmdSessionComplete, completionHandles, completionRegistryPath, seatIsRelaunchable } from "../src/launcher/complete";
import { HARNESSES } from "../src/launcher/catalog";
import { removeScratchTree } from "./support/scratch";

const repo = resolve(import.meta.dir, "../../..");
const module = join(repo, "runtime/bun/src/launcher/complete.ts");
const dispatcher = join(repo, "bin/tap");
// Captured from registry_v20 at d9b94af16 before retirement (436-test baseline green).
import relaunchVerdicts from "./support/python-closure-relaunch.json";

const NATIVE_HANDLERS = await loadNativeHandlers();
const scriptsDir = join(repo, "skills/tap/scripts");

// One scratch root for the file: removeScratchTree runs one lsof per call, and
// per-directory teardown put these tests within a second of the 5s budget.
const scratchRoot = mkdtempSync(join(tmpdir(), "tap-complete."));
let allocated = 0;
afterAll(() => removeScratchTree(scratchRoot));

function tempDir(prefix = "dir"): string {
  const path = join(scratchRoot, `${prefix}${allocated++}`);
  mkdirSync(path, { recursive: true });
  return path;
}

type Row = Record<string, unknown>;
const PANE = { status: "active", delivery: "pane", session: "tap/a", pane: "tap/a:0.0", pane_id: "%1" };

function registryDoc(seats: Record<string, unknown>, axis: "seats" | "agents" = "seats"): string {
  // The seats axis is the current shape; the agents axis stays the bare old
  // shape the either-axis test builds on purpose.
  return JSON.stringify(axis === "seats" ? { schema: "0.20", team: { name: "tap" }, seats } : { schema: "0.20", agents: seats });
}

function writeRegistry(dir: string, seats: Record<string, unknown>, axis: "seats" | "agents" = "seats"): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "registry.json");
  writeFileSync(path, registryDoc(seats, axis));
  return path;
}

function liveIndex(teams: Record<string, { root: string; registry_location?: string; state?: string }>): string {
  const index = tempDir("tap-complete-index.");
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams }));
  return index;
}

/** Bytes-level snapshot of a tree: a completion keystroke must leave it unchanged. */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const st = statSync(path);
      out.push(`${path}\t${st.isDirectory() ? "d" : st.size}\t${st.mtimeMs}`);
      if (st.isDirectory()) walk(path);
    }
  };
  walk(root);
  return out;
}

function runModule(argv: string[], env: NodeJS.ProcessEnv, cwd?: string) {
  const r = spawnSync("bun", [module, ...argv], { encoding: "utf8", env, cwd });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("seatIsRelaunchable — parity with the live Python predicate", () => {
  const MATRIX: unknown[] = [
    { ...PANE },
    { ...PANE, crew: true },
    { ...PANE, crew: 1 },
    { ...PANE, crew: "1" },
    { ...PANE, crew: false },
    { ...PANE, delivery: "poll" },
    { ...PANE, delivery: "" },
    { ...PANE, delivery: 5 },
    { ...PANE, status: "suspended", status_reason: "session_stopped" },
    { ...PANE, status: "suspended", status_reason: "restored_from_archive" },
    { ...PANE, status: "suspended", status_reason: "resurrectable" },
    { ...PANE, status: "suspended", status_reason: "server_restarted" },
    { ...PANE, status: "suspended", status_reason: "pane_gone" },
    { ...PANE, status: "suspended", status_reason: "session_replaced" },
    { ...PANE, status: "suspended", status_reason: "repair_failed" },
    { ...PANE, status: "suspended", status_reason: "restart_failed" },
    { ...PANE, status: "suspended", status_reason: "user_removed" },
    { ...PANE, status: "suspended", status_reason: "" },
    { ...PANE, status: "suspended" },
    { ...PANE, status: "suspended", status_reason: ["session_stopped"] },
    { ...PANE, status: "suspended", status_reason: 7 },
    { status: "suspended", status_reason: "session_stopped" },
    { status: "suspended", status_reason: "session_stopped", delivery: "poll" },
    { status: "suspended", status_reason: "restored_from_archive" },
    { status: "suspended", status_reason: "restored_from_archive", pane: "x:0.0", session: "tap/x" },
    { status: "suspended", status_reason: "restored_from_archive", delivery: "pane" },
    { status: "suspended", status_reason: "pane_gone", pane: "x:0.0", session: "tap/x" },
    { status: "active", pane: "x:0.0", session: "tap/x" },
    { status: "active", pane_id: "%9", session: "tap/x" },
    { status: "active", pane: "x:0.0", session: "" },
    { status: "active", pane: "x:0.0" },
    { status: "active", pane: "", pane_id: "", session: "tap/x" },
    { status: "active", session: "tap/x" },
    { status: "pending", pane: "x:0.0" },
    { status: "pending" },
    { status: ["suspended"], delivery: "pane" },
    { status: ["suspended"], pane: "x:0.0", session: "tap/x" },
    { status: 3, delivery: "pane" },
    { delivery: "pane" },
    {},
    [],
    ["pane"],
    "pane",
    null,
    42,
    true,
  ];

  test("bulk and explicit-resume verdicts match the frozen pre-retirement matrix", () => {
    const expected = relaunchVerdicts;
    expect(expected.length).toBe(MATRIX.length);
    // The matrix must reach both verdicts on both axes or a stub oracle passes.
    expect(expected.some(([bulk]) => bulk)).toBe(true);
    expect(expected.some(([bulk]) => !bulk)).toBe(true);
    expect(expected.some(([bulk, explicit]) => bulk !== explicit)).toBe(true);
    const actual = MATRIX.map(row => [seatIsRelaunchable(row), seatIsRelaunchable(row, true)]);
    const mismatches = MATRIX.flatMap((row, i) =>
      actual[i]![0] === expected[i]![0] && actual[i]![1] === expected[i]![1]
        ? []
        : [`${JSON.stringify(row)}\n  python ${JSON.stringify(expected[i])}\n  bun    ${JSON.stringify(actual[i])}`],
    );
    expect(mismatches).toEqual([]);
  });
});

describe("completionHandles — one registry, one answer", () => {
  test("relaunchable rows only, sorted by code point, from either axis", () => {
    const dir = tempDir();
    const rows = {
      zed: { ...PANE },
      alpha: { ...PANE },
      crew: { ...PANE, crew: true },
      poll: { ...PANE, delivery: "poll" },
      stopped: { status: "suspended", status_reason: "session_stopped" },
      removed: { ...PANE, status: "suspended", status_reason: "user_removed" },
      notaseat: "row",
      "é": { ...PANE },
      Zulu: { ...PANE },
    };
    expect(completionHandles(writeRegistry(join(dir, "seats"), rows))).toEqual(["Zulu", "alpha", "stopped", "zed", "é"]);
    // An agents axis, alone or beside seats, is an old format: refused, never read.
    expect(() => completionHandles(writeRegistry(join(dir, "agents"), rows, "agents"))).toThrow(/old TAP registry format/);
    const both = join(dir, "both", "registry.json");
    mkdirSync(join(dir, "both"));
    writeFileSync(both, JSON.stringify({ schema: "0.20", seats: { s: PANE }, agents: { a: PANE } }));
    expect(() => completionHandles(both)).toThrow(/old TAP registry format/);
  });

  test("old-format documents refuse old_store; unresolvable, malformed and valid-empty registries offer nothing", () => {
    const dir = tempDir();
    for (const [name, body] of [
      ["emptydoc", "{}"],
      ["noschema", JSON.stringify({ seats: { a: PANE } })],
      ["noaxis", JSON.stringify({ schema: "0.20", seat: { a: PANE } })],
      ["listaxis", JSON.stringify({ schema: "0.20", seats: [PANE] })],
    ] as const) {
      const path = join(dir, name);
      writeFileSync(path, body);
      expect(() => completionHandles(path)).toThrow(/old TAP registry format/);
    }
    const cases: Array<[string, Buffer | string | null]> = [
      ["missing", null],
      ["badjson", "{"],
      // A non-object document is malformed, not an old format: nothing to offer.
      ["list", "[]"],
      ["scalar", "3"],
      ["null", "null"],
      ["empty", JSON.stringify({ schema: "0.20", seats: {} })],
      ["allexcluded", JSON.stringify({ schema: "0.20", seats: { a: { ...PANE, crew: 1 } } })],
      // Invalid UTF-8 inside an OTHERWISE VALID registry: a lossy decode would
      // offer a U+FFFD-mangled handle the Python reader refused outright, so
      // the fixture has to carry a relaunchable row, not just bad bytes.
      ["latin1", Buffer.concat([
        Buffer.from(`{"schema":"0.20","seats":{"se`),
        Buffer.from([0xe9]),
        Buffer.from(`at":${JSON.stringify(PANE)}}}`),
      ])],
    ];
    for (const [name, body] of cases) {
      const path = join(dir, name);
      if (body !== null) writeFileSync(path, body);
      expect([name, completionHandles(path)]).toEqual([name, []]);
    }
    expect(completionHandles(null)).toEqual([]);
    expect(completionHandles(dir)).toEqual([]);
  });
});

describe("completionRegistryPath — the launcher's resolution, refusals included", () => {
  test("an absent marker resolves nothing, even with both pre-flip bus layouts present", () => {
    const index = tempDir("tap-complete-index.");
    const root = tempDir("tap-complete-root.");
    writeRegistry(join(root, "tmp", "tap"), { legacy: PANE });
    writeRegistry(join(root, ".tap", "bus"), { bus: PANE });
    expect(completionRegistryPath(root, index)).toBeNull();
  });

  test("live marker: only an enrolled root with a reachable stored registry resolves", () => {
    const enrolled = tempDir("tap-complete-root.");
    const registry = writeRegistry(join(enrolled, ".tap"), { seat: PANE });
    const unenrolled = tempDir("tap-complete-root.");
    // A canonical-looking registry at an unenrolled root never authorizes it.
    writeRegistry(join(unenrolled, ".tap"), { decoy: PANE });
    const twice = tempDir("tap-complete-root.");
    const gone = tempDir("tap-complete-root.");
    const index = liveIndex({
      alpha: { root: enrolled, registry_location: registry },
      beta: { root: twice, registry_location: registry },
      gamma: { root: twice, registry_location: registry },
      delta: { root: gone, registry_location: join(gone, ".tap", "missing.json") },
      old: { root: unenrolled, registry_location: join(unenrolled, ".tap", "registry.json"), state: "historical" },
    });
    expect(completionRegistryPath(enrolled, index)).toBe(registry);
    expect(completionRegistryPath(unenrolled, index)).toBeNull();
    expect(completionRegistryPath(twice, index)).toBeNull();
    expect(completionRegistryPath(gone, index)).toBeNull();
    // Enrollment matches by real path, so a symlinked spelling of the root resolves.
    const alias = join(tempDir("tap-complete-alias."), "link");
    symlinkSync(enrolled, alias);
    expect(completionRegistryPath(alias, index)).toBe(registry);
  });

  test("invalid UTF-8 in the index is an authority refusal, not a lossy read", () => {
    // The bad byte is in an UNRELATED team's name, so replacement decoding
    // leaves valid JSON and the matching enrollment still resolves — which is
    // exactly how a lenient reader offers handles the incumbent refused.
    const enrolled = tempDir("tap-complete-root.");
    const registry = writeRegistry(join(enrolled, ".tap"), { seat: PANE });
    const index = tempDir("tap-complete-index.");
    const marker = join(index, "global-registry.json");
    writeFileSync(marker, Buffer.concat([
      Buffer.from(`{"schema":"0.20","teams":{"oth`),
      Buffer.from([0xe9]),
      Buffer.from(`er":{"root":"/nowhere","registry_location":"/nowhere/r.json"},"mine":{"root":${JSON.stringify(enrolled)},"registry_location":${JSON.stringify(registry)}}}}`),
    ]));
    expect(completionRegistryPath(enrolled, index)).toBeNull();
    // The same index as valid UTF-8 resolves, so the arm is about the bytes and
    // not about the fixture being unresolvable for some other reason.
    writeFileSync(marker, JSON.stringify({
      schema: "0.20",
      teams: { other: { root: "/nowhere", registry_location: "/nowhere/r.json" }, mine: { root: enrolled, registry_location: registry } },
    }));
    expect(completionRegistryPath(enrolled, index)).toBe(registry);
  });

  test("an invalid marker fails closed: no legacy fallback, even with a bus registry present", () => {
    const root = tempDir("tap-complete-root.");
    writeRegistry(join(root, ".tap", "bus"), { bus: PANE });
    for (const body of ["{", JSON.stringify({ schema: "0.19" }), JSON.stringify({ schema: "0.20", teams: [] }), "[]"]) {
      const index = tempDir("tap-complete-index.");
      writeFileSync(join(index, "global-registry.json"), body);
      expect(completionRegistryPath(root, index)).toBeNull();
    }
  });
});

describe("tap session complete — the producer contract", () => {
  test("handles self-resolve through the git root and the pinned index; nothing is written; TAP_HOME is ignored", () => {
    const home = tempDir("tap-complete-home.");
    const root = tempDir("tap-complete-root.");
    const init = spawnSync("git", ["-C", root, "init", "-q"], { encoding: "utf8" });
    if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
    mkdirSync(join(root, "deep", "er"), { recursive: true });
    const registry = writeRegistry(join(root, ".tap"), { seat: PANE, gone: { ...PANE, status: "suspended", status_reason: "pane_gone" } });
    const index = liveIndex({ team: { root, registry_location: registry } });
    const decoyBus = tempDir("tap-complete-decoy.");
    writeRegistry(decoyBus, { decoy: PANE });
    // Bun's transpiler cache is the one write a bare spawn could add under HOME; pin it off.
    const env = { ...process.env, HOME: home, TAP_INDEX_HOME: index, TAP_HOME: decoyBus, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };

    // This spawns the module directly, which is not a door anyone types, so the
    // claim proven here is "writes no TAP state". Whether a TAB press writes
    // ANYTHING is a property of the two real doors and is armed below, with
    // nothing pinned, because an arm that pins the cache cannot see it.
    const before = [...snapshot(index), ...snapshot(root), ...snapshot(decoyBus)];
    const fromSubdir = runModule(["handles"], env, join(root, "deep", "er"));
    expect(fromSubdir).toEqual({ status: 0, stdout: "seat\n", stderr: "" });
    expect(runModule(["handles", "--root", root], env, home)).toEqual({ status: 0, stdout: "seat\n", stderr: "" });
    expect(runModule(["handles", `--root=${root}`], env, home)).toEqual({ status: 0, stdout: "seat\n", stderr: "" });
    // An empty --root is falsy and falls back to the git root, as it did when
    // argparse's None and '' were both falsy; an empty --registry stays a refusal.
    expect(runModule(["handles", "--root", ""], env, join(root, "deep", "er"))).toEqual({ status: 0, stdout: "seat\n", stderr: "" });
    expect(runModule(["handles", "--registry", ""], env, join(root, "deep", "er"))).toEqual({ status: 0, stdout: "", stderr: "" });
    // --registry bypasses resolution entirely (a test override, as before).
    expect(runModule(["handles", "--registry", join(decoyBus, "registry.json")], env, home)).toEqual({ status: 0, stdout: "decoy\n", stderr: "" });
    // An unenrolled cwd offers nothing under a live marker; the decoy TAP_HOME bus never leaks in.
    expect(runModule(["handles"], env, home)).toEqual({ status: 0, stdout: "", stderr: "" });
    expect([...snapshot(index), ...snapshot(root), ...snapshot(decoyBus)]).toEqual(before);
  });

  test("harnesses is the canonical sorted set", () => {
    const expected = ["agy", "claude", "codex", "cursor", "hermes", "opencode"];
    expect(expected.length).toBe(6);
    expect([...HARNESSES].sort()).toEqual(expected);
    const r = runModule(["harnesses"], { ...process.env, TAP_INDEX_HOME: tempDir("tap-complete-index.") });
    expect(r).toEqual({ status: 0, stdout: `${expected.join("\n")}\n`, stderr: "" });
  });

  test("malformed argv is the one usage error (exit 2, nothing on stdout); every other path exits 0", () => {
    const env = { ...process.env, TAP_INDEX_HOME: tempDir("tap-complete-index.") };
    for (const argv of [[], ["bogus"], ["handles", "harnesses"], ["handles", "--root"], ["handles", "--flag"], ["-h"], ["handles", "extra"]]) {
      const r = runModule(argv, env);
      expect([argv, r.status, r.stdout]).toEqual([argv, 2, ""]);
      expect(r.stderr).toContain("usage: tap session complete");
    }
    // Two argv-grammar outcomes changed, both confined to the test-override
    // flags no production caller passes (launcher.py:10615 passes none).
    // `--ro` was an argparse prefix abbreviation; restoring prefix matching is
    // mechanism nobody wants, so it is a usage error now.
    const abbreviated = runModule(["handles", "--ro", "/tmp"], { ...process.env, TAP_INDEX_HOME: tempDir("tap-complete-index.") });
    expect([abbreviated.status, abbreviated.stdout]).toEqual([2, ""]);
    expect(cmdSessionComplete(["handles", "--registry", "/nonexistent/registry.json"])).toBe(0);
    expect(cmdSessionComplete(["handles", "--root", "/nonexistent/root"])).toBe(0);
  });
});

describe("router — session complete is native on every door, as is every other session form", () => {
  test("route() carries complete to the real handler and never delegates a session form", async () => {
    const trace = join(tempDir(), "trace");
    const delegated: string[][] = [];
    const fallback = (argv: string[]) => { delegated.push(argv); return 22; };
    const doors: Array<Record<string, string | undefined>> = [
      { TAP_LAUNCHER: undefined },
      { TAP_LAUNCHER: "bun" },
      { TAP_LAUNCHER: "python" },
    ];
    // `session list` refuses on an absent index, so the list form runs from a root enrolled in its own index.
    const root = realpathSync(tempDir("tap-complete-root."));
    const registry = join(root, ".tap", "team-registry.json");
    mkdirSync(join(root, ".tap"), { recursive: true });
    writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "router", worktree_root: root }, seats: {} }));
    const index = liveIndex({ router: { root, registry_location: registry, state: "registered" } });
    // The in-process list route consults whatever tmux the ambient PATH resolves;
    // under the full suite that answer is nobody's fixture (tap-88xka). Pin the
    // no-server shape so the namespace verdict is deterministic.
    const shimBin = tempDir("tap-complete-router-shim.");
    mkdirSync(shimBin, { recursive: true });
    writeFileSync(join(shimBin, "tmux"), `#!/bin/sh
while [ "\${1:-}" = "-L" ] || [ "\${1:-}" = "-S" ]; do shift 2; done
echo "no server running on /fixture/router-socket" >&2
exit 1
`, { mode: 0o755 });
    const saved = { TAP_LAUNCHER: process.env.TAP_LAUNCHER, TAP_INDEX_HOME: process.env.TAP_INDEX_HOME, PATH: process.env.PATH };
    const savedCwd = process.cwd();
    try {
      process.env.TAP_INDEX_HOME = index;
      process.env.PATH = `${shimBin}:${process.env.PATH}`;
      process.chdir(root);
      for (const door of doors) {
        for (const [key, value] of Object.entries(door)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        expect(route(["session", "complete", "handles", "--registry", join(index, "none.json")], NATIVE_HANDLERS, fallback, trace)).toBe(0);
        // An unknown subcommand is the native door's own refusal, never a fallback.
        expect(route(["session", "stop", "x"], NATIVE_HANDLERS, fallback, trace)).toBe(1);
        // `session list --json` is native since the list port, on every launcher pin.
        expect(await route(["session", "list", "--json"], NATIVE_HANDLERS, fallback, trace)).toBe(0);
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
      doors.flatMap(() => ["native session", "native session", "native session"]),
    );
  });

  test("the primary door writes nothing under HOME during a keystroke", () => {
    // bin/tap execs `bun main.ts` for every verb, so without its own pin this
    // door writes ~/Library/Caches/bun on a TAB press — 67 files, measured.
    // Nothing is pinned here on purpose: this arm exists to see that.
    const home = tempDir("tap-complete-home.");
    const index = tempDir("tap-complete-index.");
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TAP_INDEX_HOME: index, TAP_HOME: join(home, "bus") };
    delete env.BUN_RUNTIME_TRANSPILER_CACHE_PATH;
    const entry = join(repo, "bin", "tap");
    const r = spawnSync("bash", [entry, "session", "complete", "harnesses"], { encoding: "utf8", env, cwd: home });
    expect({ status: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({ status: 0, stdout: `${[...HARNESSES].sort().join("\n")}\n`, stderr: "" });
    expect(snapshot(home)).toEqual([]);
  });

  test("the Bash door fast-paths to the native producer, writes nothing under HOME, and stays silent with exit 0 without a runtime", () => {
    const index = tempDir("tap-complete-index.");
    const home = tempDir("tap-complete-home.");
    // Deliberately NOT pinning BUN_RUNTIME_TRANSPILER_CACHE_PATH here: the door
    // owns that, and an arm that pins it cannot see the cache this spawn would
    // write during a keystroke. The retired `python3 -B` path wrote nothing.
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TAP_INDEX_HOME: index };
    delete env.BUN_RUNTIME_TRANSPILER_CACHE_PATH;
    const withBun = spawnSync("bash", [dispatcher, "session", "complete", "harnesses"], { encoding: "utf8", env, cwd: home });
    expect({ status: withBun.status, stdout: withBun.stdout, stderr: withBun.stderr }).toEqual({ status: 0, stdout: `${[...HARNESSES].sort().join("\n")}\n`, stderr: "" });
    expect(snapshot(home)).toEqual([]);

    const bin = join(tempDir("tap-complete-bin."), "bin");
    mkdirSync(bin);
    for (const tool of ["bash", "dirname"]) {
      const real = spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
      symlinkSync(real, join(bin, tool));
    }
    const noBun = spawnSync(join(bin, "bash"), [dispatcher, "session", "complete", "harnesses"], { encoding: "utf8", env: { ...env, PATH: bin }, cwd: home });
    expect({ status: noBun.status, stdout: noBun.stdout, stderr: noBun.stderr }).toEqual({ status: 0, stdout: "", stderr: "" });
  });
});
