// Shared fixture tree for the `tap session list` goldens and their native
// byte-compares. The capture driver (Python oracle at the plan base) captured
// the checked-in goldens from a tree at the CANONICAL spelling FG; every test
// run rebuilds the SAME tree under a UNIQUE root (runner TMUX_TMPDIR), so
// concurrent suites cannot collide and the no-write snapshot can own its tree.
// Only the root prefix differs, and normalization maps it back before bytes
// are compared — nothing else in the golden bytes is rewritten.
//
// Layout (canonical spelling; actual = uniqueRoot with the same relative shape):
//   root    git repo (the enrolled worktree, cwd scope)
//   root2   plain dir outside the repo (names-only mixed fixture)
//   reg/    acting registries (main, empty, agents-axis, mixed, bad)
//   index/  machine indexes (main, unenrolled, invalid, unreadable-team, ...)
//   home bus tmux-home/  pinned HOME, TAP_HOME scratch, mutant tmux dir
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** The spelling the checked-in goldens were captured at. Never built. */
export const FG = "/tmp/tap-list-golden";

export interface FixtureMap {
  fg: string;
  root: string;
  root2: string;
  index: string;
  reg: string;
  home: string;
  bus: string;
  fakeBin: string;
}

type Row = Record<string, unknown>;

const ACTIVE = { status: "active", delivery: "pane", pane: "demo/x:0.0", pane_id: "%1" };

function seat(root: string, over: Row): Row {
  return {
    ...ACTIVE,
    harness: "claude",
    registered_from_worktree: root,
    base: "demo",
    index: 1,
    last_seen: "2026-09-20T10:00:00Z",
    ...over,
  };
}

function mainSeats(root: string): Record<string, Row> {
  const s = (over: Row) => seat(root, over);
  const seats: Record<string, Row> = {
    grok: s({ session: "demo/legacy-scout", tag: "grok", model: "o3", preset: { name: "plan", source_path: "/cfg/tap/config.toml", config_digest: "sha256:abc" } }),
    "grok-2": s({ session: "demo/legacy-scout", tag: "grok", index: 2, last_seen: "2026-09-20T10:05:00Z" }),
    scout: s({ session: "demo/legacy-scout", last_launched: "2026-09-20T09:30:00Z" }),
    codex: s({ session: "other/legacy-scout", harness: "codex", index: 3, last_seen: "2026-09-20T10:30:00Z" }),
    repo: s({ session: "My-Repo/legacy-scout", harness: "opencode", base: "My Repo!", last_seen: "2026-09-20T10:45:00Z" }),
    stopped: s({ session: "demo/stopped", status: "suspended", status_reason: "session_stopped", delivery: undefined, pane: undefined, pane_id: undefined, last_seen: "2026-09-20T10:10:00Z" }),
    unrel: s({ session: "demo/gone", status: "suspended", status_reason: "user_removed", delivery: undefined, pane: undefined, pane_id: undefined, last_seen: "2026-09-20T11:30:00Z" }),
    tie1: s({ session: "demo/tie-alpha", harness: "codex", last_seen: "2026-09-20T11:00:00Z" }),
    tie2: s({ session: "demo/tie-zeta", harness: "codex", last_seen: "2026-09-20T11:00:00Z" }),
    scoutlive: s({ session: "demo/scout", last_seen: "2026-09-20T09:00:00Z" }),
    bare: s({ session: "demo/bare", harness: "hermes", last_seen: undefined, last_launched: "2026-09-20T09:00:00Z" }),
  };
  return seats;
}

function registry(root: string, seats: Record<string, Row>, axis: "seats" | "agents" = "seats"): string {
  return JSON.stringify({ schema: "0.20", team: { name: "demo", worktree_root: root }, [axis]: seats });
}

function indexDoc(teams: Record<string, { root: string; registry_location: string; state?: string }>): string {
  return JSON.stringify({ schema: "0.20", teams });
}

export const TMUX_NAMES = ["demo/scout", "tmux-only"];

/**
 * Total width the nine-column table spends left of the cwd column at these
 * fixture values: the eight non-last column widths plus 2 spaces between each
 * pair. Independent of the unique root — the cwd column is the one clamped.
 */
export function mainTableFixedWidth(): number {
  const cells = Object.entries(mainSeats(FG))
    .filter(([key]) => key !== "unrel")
    .map(([key, row]) => [String(row.session), String(row.harness), "no", "yes", "fresh", "-", "-", String(row.last_seen ?? "-"), ""]);
  const headers = ["name", "harness", "live", "seated", "revive", "model", "preset", "last seen"];
  const widths = headers.map((header, i) => Math.max(header.length, ...cells.map((row) => row[i]!.length)));
  // Eight column widths plus the eight two-space gaps — the fixed spend the
  // 9-column render makes before the clamped cwd column.
  return widths.reduce((sum, n) => sum + n, 0) + 2 * headers.length;
}

function writeIndex(dir: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "global-registry.json");
  writeFileSync(path, body);
  return path;
}

/**
 * Build the whole fixture tree under a UNIQUE root (a fresh mkdtemp under the
 * runner's TMUX_TMPDIR, or the OS temp dir when absent) and return its paths.
 * Rebuilds are byte-identical apart from the root itself.
 */
export function buildFixtureTree(): FixtureMap {
  const fg = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "tap-list-golden."));
  const root = join(fg, "root");
  const root2 = join(fg, "root2");
  const index = join(fg, "index");
  const reg = join(fg, "reg");
  const home = join(fg, "home");
  const bus = join(fg, "bus");
  const fx: FixtureMap = { fg, root, root2, index, reg, home, bus, fakeBin: join(fg, "tmux-home", "fake-bin") };
  for (const dir of [root, root2, home, bus, reg]) mkdirSync(dir, { recursive: true });
  // The cwd-scope acting registry is discovered at the candidate path under
  // the repo; installActingRegistry swaps its contents between cases.
  mkdirSync(join(root, ".tap/bus"), { recursive: true });
  writeFileSync(join(root, ".tap/bus/registry.json"), registry(root, mainSeats(root)));
  if (spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).status !== 0) {
    const init = spawnSync("git", ["-C", root, "init", "-q"], { encoding: "utf8" });
    if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  }
  writeFileSync(join(reg, "registry.json"), registry(root, mainSeats(root)));
  writeFileSync(join(reg, "empty.json"), registry(root, {}));
  writeFileSync(join(reg, "agents.json"), registry(root, mainSeats(root), "agents"));
  // The mixed fixture is TWO rows: one seat in the cwd's root, one outside —
  // the names-only cwd-group ordering case. Not the whole main set. (The
  // capture's mixed seat carried the default last_seen, not the main set's.)
  const allSeats = mainSeats(root);
  writeFileSync(join(reg, "mixed.json"), registry(root, {
    scoutlive: { ...allSeats.scoutlive!, last_seen: "2026-09-20T10:00:00Z" },
    zeta: { ...ACTIVE, harness: "claude", registered_from_worktree: root2, base: "demo", index: 1, session: "zeta-second" },
  }));
  writeFileSync(join(reg, "bad.json"), "{");
  const mainReg = join(reg, "registry.json");
  writeIndex(index, indexDoc({ alpha: { root, registry_location: mainReg } }));
  // Alternate acting registries are selected through per-case machine indexes:
  // with a live marker the cwd scope reads the entry's registry_location.
  writeIndex(join(fg, "index-agents"), indexDoc({ alpha: { root, registry_location: join(reg, "agents.json") } }));
  writeIndex(join(fg, "index-mixed"), indexDoc({ alpha: { root, registry_location: join(reg, "mixed.json") } }));
  writeIndex(join(fg, "index-empty"), indexDoc({ alpha: { root, registry_location: join(reg, "empty.json") } }));
  writeIndex(join(fg, "index-unenrolled"), indexDoc({ other: { root: "/nowhere/team", registry_location: join(root2, "nope.json") } }));
  writeIndex(join(fg, "index-invalid"), "{");
  writeIndex(join(fg, "index-machbad"), indexDoc({
    alpha: { root, registry_location: mainReg },
    beta: { root: root2, registry_location: join(reg, "bad.json") },
  }));
  writeIndex(join(fg, "index-absent-dir"), indexDoc({}));
  // The mutant tmux answers like a real failure that is NOT a no-server
  // answer — the fail-closed refusal on a lying shim.
  mkdirSync(fx.fakeBin, { recursive: true });
  const script = join(fx.fakeBin, "tmux");
  writeFileSync(script, '#!/bin/sh\necho "no sessions" >&2\nexit 1\n');
  spawnSync("chmod", ["+x", script]);
  return fx;
}

/** Install one of the named acting registries at the repo candidate path. */
export function installActingRegistry(fx: FixtureMap, name: "main" | "empty" | "agents" | "mixed"): void {
  const file = name === "main" ? "registry.json" : `${name}.json`;
  writeFileSync(join(fx.root, ".tap/bus/registry.json"), readFileSync(join(fx.reg, file)));
}

/**
 * A PATH exposing every system binary except the excluded names, plus `bun`
 * and the ambient python3 (the launcher's version gate refuses the Xcode
 * 3.9 shim) — for missing-tool refusal arms. The shim tree lives INSIDE the
 * owned fixture root so the whole-fixture snapshot covers it and the existing
 * ownership-checked reap collects it; nothing may stay outside fx.fg.
 */
export function shimPath(fx: FixtureMap, exclude: string[]): string {
  let n = 0;
  let dir: string;
  do {
    dir = join(fx.fg, "shims", String(n++));
  } while (existsSync(dir));
  mkdirSync(dir, { recursive: true });
  for (const base of ["/bin", "/usr/bin"]) {
    for (const entry of readdirSync(base)) {
      if (exclude.includes(entry)) continue;
      try {
        symlinkSync(join(base, entry), join(dir, entry));
      } catch {
        // already linked from an earlier call — fine
      }
    }
  }
  const python3 = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
  if (python3) {
    // The /usr/bin sweep already linked Xcode's 3.9 python3; the ambient
    // (version-gate-passing) interpreter must win.
    rmSync(join(dir, "python3"), { force: true });
    symlinkSync(python3, join(dir, "python3"));
  }
  if (!exclude.includes("tmux")) {
    // tmux is a Homebrew-only binary on this machine, and the smoke worker's
    // PATH may not carry Homebrew at all — pin from absolute locations, then
    // the ambient PATH. Without a pin the sweep yields no tmux and the
    // missing-tmux refusal shadows the scenario under test.
    const tmux = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].find((candidate) => existsSync(candidate))
      ?? spawnSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
    if (tmux) symlinkSync(tmux, join(dir, "tmux"));
  }
  try {
    symlinkSync(process.execPath, join(dir, "bun"));
  } catch {
    // already linked from an earlier call — fine
  }
  return dir;
}

/**
 * Runner-shaped env for any spawn that must see the fixture and nothing else.
 * COLUMNS is stripped so width falls back to the 80-column default unless a
 * case sets it explicitly.
 */
export function fixtureEnv(fx: FixtureMap, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fx.home,
    TAP_HOME: fx.bus,
    TAP_INDEX_HOME: fx.index,
    TAP_SESSION_MANIFEST: join(fx.home, "sessions.json"),
    OPENCODE_DB_PATH: join(fx.home, "opencode.db"),
    TAP_VERSION_SEEN_PATH: join(fx.home, "version-seen.json"),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  };
  delete env.COLUMNS;
  delete env.TMUX;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/**
 * Map the canonical root spelling — the one the checked-in goldens embed — to
 * THIS run's unique root, so the byte contract survives the unique fixture
 * root without rewriting anything else in the golden bytes. The truncated
 * table projections of the root (the 3-char hard cut and the wide case's
 * 7-char ellipsis — the frozen capture clamped cwd to 10 columns) are pure
 * functions of the same prefix and normalize with it, longest first.
 */
export function normalizeRoot(text: string, fx: FixtureMap): string {
  return text
    .split(`${FG}/`).join(`${fx.fg}/`)
    .split(`${FG.slice(0, 7)}...`).join(`${fx.fg.slice(0, 7)}...`)
    .split(FG.slice(0, 3)).join(fx.fg.slice(0, 3));
}

/**
 * Byte-level snapshot of the WHOLE fixture tree — every authority and state
 * input (acting registries, machine indexes, pinned HOME/BUS, the repo's
 * .tap) lives under the unique root, so one content hash per file covers the
 * no-write claim for every form, --machine included.
 */
export function snapshot(fg: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = path.slice(fg.length);
      const st = lstatSync(path);
      if (st.isSymbolicLink()) {
        // A symlink records its TARGET, not the target's bytes: the shim pins
        // point at ambient binaries whose content is nobody's fixture, and
        // the claim under test is that the link itself never moves.
        out.push(`link\t${rel}\t${readlinkSync(path)}`);
      } else if (st.isDirectory()) {
        out.push(`d\t${rel}`);
        walk(path);
      } else {
        const bytes = readFileSync(path);
        out.push(`${createHash("sha256").update(bytes).digest("hex")}\t${bytes.length}\t${rel}`);
      }
    }
  };
  walk(fg);
  return out;
}

export interface GoldenCase {
  name: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Prepended to PATH (after the case env is applied) — the mutant shim. */
  pathPrefix?: string;
}

/**
 * The golden corpus, bound to one fixture map. Names match the checked-in
 * goldens/<name>.{out,err,rc} triplets; the Python capture driver iterated the
 * canonical-spelling instance of THIS list, and the native byte-compare
 * iterates the unique-root instance, so a case can never drift between them.
 */
export function goldenCases(fx: FixtureMap): GoldenCase[] {
  const ix = (name: string) => join(fx.fg, name);
  return [
    { name: "01-json-cwd", args: ["--json", "--cwd", fx.root] },
    { name: "02-json-machine", args: ["--json", "--machine", "--cwd", fx.root] },
    { name: "03-table-default", args: [], cwd: fx.root },
    { name: "04-table-40", args: ["--cwd", fx.root], env: { COLUMNS: "40" } },
    // The frozen wide-case capture clamped cwd to 10 columns (its ellipsis is
    // prefix + "..."); reproduce that terminal width, not today's width math.
    { name: "05-table-wide", args: ["--cwd", fx.root], env: { COLUMNS: String(mainTableFixedWidth() + 10) } },
    { name: "06-names-tmux", args: ["--names-only", "--include-tmux", "--live", "--cwd", fx.root] },
    { name: "07-names-plain", args: ["--names-only", "--cwd", fx.root] },
    { name: "08-json-harness", args: ["--json", "--harness", "codex", "--cwd", fx.root] },
    { name: "09-json-live", args: ["--json", "--live", "--cwd", fx.root] },
    { name: "10-json-agents", args: ["--json", "--cwd", fx.root], env: { TAP_INDEX_HOME: ix("index-agents") } },
    { name: "11-names-agents", args: ["--names-only", "--include-tmux", "--cwd", fx.root], env: { TAP_INDEX_HOME: ix("index-agents") } },
    { name: "12-names-mixed", args: ["--names-only", "--include-tmux", "--live", "--cwd", fx.root], env: { TAP_INDEX_HOME: ix("index-mixed") } },
    { name: "13-names-mixed-nolive", args: ["--names-only", "--include-tmux", "--cwd", fx.root], env: { TAP_INDEX_HOME: ix("index-mixed") } },
    { name: "14-table-mixed-live", args: ["--live", "--cwd", fx.root], env: { TAP_INDEX_HOME: ix("index-mixed") } },
    { name: "15-json-mixed-live", args: ["--json", "--live", "--cwd", fx.root], env: { TAP_INDEX_HOME: ix("index-mixed") } },
    { name: "16-json-empty", args: ["--json", "--cwd", fx.root], env: { TAP_INDEX_HOME: ix("index-empty") } },
    { name: "17-text-empty", args: ["--cwd", fx.root], env: { TAP_INDEX_HOME: ix("index-empty") } },
    { name: "18-names-empty", args: ["--names-only", "--include-tmux", "--cwd", fx.root], env: { TAP_INDEX_HOME: ix("index-empty") } },
    { name: "19-json-machine-empty", args: ["--json", "--machine", "--cwd", fx.root], env: { TAP_INDEX_HOME: ix("index-absent-dir") } },
    { name: "20-json-noserver", args: ["--json", "--cwd", fx.root], env: { TAP_TMUX_SOCKET: "tap-list-capture-absent" } },
    { name: "21-json-gitless", args: ["--json", "--cwd", fx.root], env: { PATH: shimPath(fx, ["git"]) } },
    { name: "22-err-unenrolled", args: ["--cwd", fx.root], env: { TAP_INDEX_HOME: ix("index-unenrolled") } },
    { name: "23-err-unenrolled-tapjson", args: ["--cwd", fx.root], env: { TAP_INDEX_HOME: ix("index-unenrolled"), TAP_JSON: "1" } },
    { name: "24-err-unenrolled-jsonflag", args: ["--json", "--cwd", fx.root], env: { TAP_INDEX_HOME: ix("index-unenrolled") } },
    { name: "25-err-invalid", args: ["--cwd", fx.root], env: { TAP_INDEX_HOME: ix("index-invalid") } },
    { name: "26-err-invalid-machine", args: ["--machine", "--cwd", fx.root], env: { TAP_INDEX_HOME: ix("index-invalid") } },
    { name: "27-err-machbad", args: ["--machine", "--cwd", fx.root], env: { TAP_INDEX_HOME: ix("index-machbad") } },
    { name: "28-err-notmux", args: ["--json", "--cwd", fx.root], env: { PATH: shimPath(fx, ["tmux"]) } },
    { name: "29-err-shim-tmx", args: ["--cwd", fx.root], env: { PATH: shimPath(fx, ["tmux"]) }, pathPrefix: fx.fakeBin },
  ];
}
