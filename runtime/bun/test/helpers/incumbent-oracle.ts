/**
 * Shared harness for the lane-T differentials: a native verb against the Bash
 * verb it deletes — RUN from a base-commit checkout, not read (batch-2 rule
 * 13) — through the verb's PUBLIC doors, from one restored fixture state per
 * door, comparing stdout, stderr, exit code and the team's `.tap/` effects.
 *
 *   - `bin/tap …`                  → main.ts → native (the door)
 *   - `bash <base>/bin/tap …`      → the incumbent, LIVE when
 *     `TAP_T1_ORACLE_BASE=<checkout at the base commit>` is set; otherwise
 *     replayed from the frozen capture the test names, which records the
 *     commit and the blob ids it was taken from. `TAP_T1_ORACLE_WRITE=1` with
 *     the base rewrites the capture.
 *
 * Deviations from the incumbent are DECLARED per case, applied as a named
 * transform to the incumbent's bytes, and each declared transform must fire on
 * the case that declares it: a deviation that matches nothing is a stale
 * ratification and fails the test.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

/**
 * The bus authority marker's bytes, PINNED as historical fixture input: the
 * differential must be able to build and replay its fixtures without
 * executing any HEAD production sibling (rule 34), so the literal is spelled
 * here instead of imported from src/bus.ts. If production ever renames the
 * marker, the freeze/replay owner updates this pin deliberately.
 */
export const ORACLE_BUS_AUTHORITY_MARKER = ".tap-bus-authority";

export const repo = resolve(import.meta.dir, "../../../..");
export const headTap = join(repo, "bin", "tap");
export const BASE = process.env.TAP_T1_ORACLE_BASE;
export const WRITE = process.env.TAP_T1_ORACLE_WRITE === "1";
export const baseTap = BASE ? join(BASE, "bin", "tap") : "";
// Rule 34 (amended): the fixture builders may execute only the PINNED base's
// siblings, never HEAD's. At FREEZE (TAP_T1_ORACLE_BASE set) sessionDir points
// into the base checkout, so `sanitize` (completion.py) and the registry
// builder (launcher.py) read the same vintage the pinned verb was frozen
// against; at REPLAY the builders do not run at all — the frozen inputs are
// restored (see buildFixture). HEAD's session siblings are never executed.
export const sessionDir = BASE
  ? join(BASE, "skills", "tap", "scripts", "session")
  : join(repo, "skills", "tap", "scripts", "session");

/**
 * The commit `tap team attach`'s incumbent was last current at (the salvage's
 * base). A capture whose `captured_from.head` is not this commit is not
 * evidence for this verb's differential, and a TAP_T1_ORACLE_BASE checkout at
 * any other commit is not the freeze environment — both fail loud.
 */
export const ORACLE_PINNED_BASE = "753f005c8bc2242428bebd637d471cec8c8f20a0";

/**
 * The commit `tap team down|shutdown|reset`'s incumbent engine
 * (`tap-team-stop.sh`) was last current at (the TeamStop r5 cutover base,
 * after H1 landed). Same contract as ORACLE_PINNED_BASE, different verb.
 */
export const TEAMSTOP_ORACLE_PINNED_BASE = "bfe4f1bcaf24d43ab795839ab811442e83d9ab24";

export interface RowSpec {
  handle: string;
  /** Whether a tmux session exists for the row at run time. */
  live: boolean;
  /** Override the session name (a foreign-prefix or noncanonical session). */
  session?: string;
  crew?: boolean;
  delivery?: "pane" | "poll";
  /** A register-born row: no launcher session fields, so the catalog omits it. */
  bare?: boolean;
  /** Override the stored status (`active` by default). */
  status?: string;
  status_reason?: string;
  /** Leave the row's `session` field out (register-born rows name only a pane). */
  noSession?: boolean;
  /** Leave the row's `pane`/`pane_id` out. */
  noPane?: boolean;
}

export interface FixtureSpec {
  team: string;
  /** Directory name for the team root; defaults to the team name. */
  rootName?: string;
  /** `absent` leaves team.worktree_root out of the registry. */
  worktreeRoot?: "absent";
  rows: RowSpec[];
  osascript?: "refuse-probe" | "accept" | "reject-script";
  python?: "list-fails" | "list-array";
  /** `?` answers every ps probe with no tty; `tty` answers with a tty no pane owns. */
  ps?: "unobservable" | "foreign-tty";
  /** Handles whose session gets a real pty-backed tmux client before the run. */
  attached?: string[];
  /** Stamp every row with the live server's socket and a STALE generation. */
  staleGeneration?: boolean;
  /** Replace the registry file's bytes wholesale after the fixture is built; `null` deletes it (absent-registry premises). */
  registryBytes?: string | null;
  /**
   * Write `$TAP_INDEX_HOME/global-registry.json` with schema 0.20 and this
   * team enrolled at `root` (registry_location under its bus) — a live v0.20
   * marker, which is what arms the H1 index de-enroll paths.
   */
  globalEnroll?: boolean;
  /** Extra root-relative files written after the fixture is built (fence stamps, decoys). */
  preFiles?: Record<string, string>;
  /** tmux subcommands the fixture's `tmux` shim refuses for the verb under test. */
  tmuxRefuse?: string[];
}

export interface Streams {
  stdout: string;
  stderr: string;
  rc: number;
  /** Files under `.tap/` the run created (bytes), rewrote (bytes) or deleted (null). */
  effects: Record<string, string | null>;
}

/**
 * Effect keys whose presence is a DOOR artifact, not stop semantics, and so
 * never compare:
 * - `.tap/.gitignore` / `.tap/bus/.tap-bus-authority`: bus scaffolding the
 *   Bash door's ensure_dirs creates mid-run; the native door owns no
 *   scaffolding.
 * - `index/runtime-cache/*`: the native observe/queue rate limiter's speed
 *   artifact; no incumbent counterpart.
 * - `*.lock.held.*`: the native lock handshake marker, which survives a
 *   KILLED holder (self-last panes die mid-hold); flock leaves no trace.
 */
export function isDroppedEffectKey(key: string): boolean {
  return key === ".tap/.gitignore"
    || key === ".tap/bus/.tap-bus-authority"
    || key.startsWith("index/runtime-cache/")
    || /\.lock\.held\./.test(key);
}

/** Journal files carry the writing process's pid; the name does not compare.
 *  Recovery `.inflight` artifacts carry a random stem from the writing engine. */
export function normalizeEffectKey(key: string): string {
  return key
    .replace(/\.self-last-journal\.[0-9]+\.json$/, ".self-last-journal.{PID}.json")
    .replace(/self-row-[A-Za-z0-9]+\.inflight$/, "self-row-{ART}.inflight");
}

/** Both the live result and the frozen expectation pass through this shape. */
export function canonicalStreams<T extends Streams>(s: T): T {
  return {
    ...s,
    effects: Object.fromEntries(
      Object.entries(s.effects)
        .filter(([k]) => !isDroppedEffectKey(k))
        .map(([k, v]) => [normalizeEffectKey(k), v]),
    ),
  };
}

export interface Deviation {
  why: string;
  apply: (s: Streams) => Streams;
}

export interface Capture {
  captured_from: { head: string; blobs: Record<string, string>; platform: string; bash: string; python: string };
  cases: Array<{ name: string; expected: Streams; inputs?: FixtureInputs }>;
}

/**
 * The fixture inputs the BASE-built constructors produced, vendored into the
 * capture so REPLAY restores these bytes instead of re-running the builders
 * against HEAD siblings (rule 34: a replay must execute nothing from HEAD —
 * a strangler sibling moving HEAD completion.py/launcher.py would otherwise
 * rebuild the fixture the pinned verb was frozen against).
 */
export interface FixtureInputs {
  /** `sanitize_component(team)` as the BASE completion.py spells it. */
  base: string;
  /** registry.json bytes exactly as the BASE registry builder wrote them (frozen runtime stamps). */
  registry: string;
  /** The frozen pane ids of the spec's live rows, by handle — replay substitutes the fresh ones. */
  panes: Record<string, string>;
  /** The frozen `#{socket_path}` the builder stamped (staleGeneration rows) — refreshed at replay. */
  serverSocket?: string;
  /**
   * The frozen `srv:<pid>:<start>` server epoch the builder stamped into
   * every row's server_epoch — refreshed at replay, because a fresh runner
   * namespace means a fresh tmux server, and a stale epoch makes every live
   * row pane_identity_missing before the verb under test even runs.
   */
  serverEpoch?: string;
  /** The frozen fixture root the builder stamped into worktree_root/registered_from_worktree — refreshed at replay. */
  root: string;
}

/** Bare tmux on the runner's namespace: the same server every implementation and the catalog see. */
export function tmuxEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // The runner pins TAP_TMUX_SOCKET for Bun's own tmux calls; the incumbent,
  // the catalog (Python) and this fixture use bare tmux, so all four must
  // meet on the namespace's default socket rather than on two servers.
  delete env.TAP_TMUX_SOCKET;
  delete env.TAP_TMUX_SOCKET_PATH;
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

export function tmux(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("tmux", args, { encoding: "utf8", env: tmuxEnv() });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

type StateSnapshot = Map<string, string>;

/**
 * One walked directory of durable state. `keyBase` is what relative keys are
 * taken against, `keyPrefix` namespaces them (`""` for the fixture root's
 * `.tap`, `index/` for the machine-index home).
 */
interface StateRoot { dir: string; keyBase: string; keyPrefix: string }

function snapshotState(roots: StateRoot[]): StateSnapshot {
  const out: StateSnapshot = new Map();
  const walk = (root: StateRoot, dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(root, path);
      else if (entry.isFile()) out.set(`${root.keyPrefix}${relative(root.keyBase, path)}`, readFileSync(path, "latin1"));
    }
  };
  for (const root of roots) walk(root, root.dir);
  return out;
}

function restoreState(roots: StateRoot[], snapshot: StateSnapshot): void {
  for (const root of roots) rmSync(root.dir, { recursive: true, force: true });
  for (const [rel, bytes] of snapshot) {
    // Prefix order is stable: the longest matching prefix owns the key. The
    // unprefixed `.tap/…` keys predate the index namespace and stay byte-form.
    const owner = [...roots].sort((a, b) => b.keyPrefix.length - a.keyPrefix.length)
      .find(r => r.keyPrefix !== "" && rel.startsWith(r.keyPrefix))
      ?? roots.find(r => r.keyPrefix === "")!;
    const relRest = owner.keyPrefix === "" ? rel : rel.slice(owner.keyPrefix.length);
    mkdirSync(join(owner.keyBase, relRest, ".."), { recursive: true });
    writeFileSync(join(owner.keyBase, relRest), Buffer.from(bytes, "latin1"));
  }
}

function effects(before: StateSnapshot, after: StateSnapshot): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [rel, bytes] of after) if (before.get(rel) !== bytes) out[rel] = bytes;
  for (const rel of before.keys()) if (!after.has(rel)) out[rel] = null;
  return out;
}

export interface Fixture {
  root: string;
  bin: string;
  indexHome: string;
  sessions: string[];
  /** Live pane ids probed at session creation, by session name. */
  paneIds: Map<string, string>;
  clients: ChildProcess[];
  scriptCapture: string;
  initialState: StateSnapshot;
  /** The sanitized tmux base for the team, as the launcher names sessions. */
  base: string;
}

export class Oracle {
  readonly scratch: string;
  private allocated = 0;
  /** Frozen→fresh runtime spellings from the last restore (epoch, socket, panes, root). */
  private activeSubs: Array<[string, string]> = [];
  /** The freeze run's scratch prefix, recovered from the vendored root, so
   *  effect bytes spelled with it normalize to {CASE} like fresh bytes do. */
  private frozenScratchDir = "";
  private readonly realPython: string;
  private readonly realBun: string;
  private readonly sanitizeScript: string;
  private readonly registryScript: string;
  private readonly tmuxDirSpellings: string[];
  /** Walk `$TAP_INDEX_HOME` into the effects diff too (verbs that mutate the machine index). */
  private readonly indexState: boolean;

  constructor(readonly name: string, readonly fixturePath: string, options: { indexState?: boolean } = {}) {
    this.indexState = options.indexState === true;
    this.scratch = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), `tap-${name}-oracle.`));
    this.realPython = spawnSync("bash", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
    this.realBun = spawnSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim();
    this.sanitizeScript = join(this.scratch, "sanitize.py");
    writeFileSync(this.sanitizeScript, "import sys\nsys.path.insert(0, sys.argv[1])\nimport completion\nprint(completion.sanitize_component(sys.argv[2]))\n");
    this.registryScript = join(this.scratch, "registry.py");
    writeFileSync(this.registryScript, REGISTRY_PY);
    const dir = process.env.TMUX_TMPDIR;
    const spellings = new Set<string>();
    if (dir) {
      spellings.add(dir);
      try { spellings.add(realpathSync(dir)); } catch { /* the literal spelling is all there is */ }
    }
    this.tmuxDirSpellings = [...spellings].sort((a, b) => b.length - a.length);
  }

  sanitize(team: string): string {
    const r = spawnSync("python3", ["-B", this.sanitizeScript, sessionDir, team], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`sanitize_component failed: ${r.stderr}`);
    return r.stdout.trim();
  }

  /** Allocate the fixture's paths first so a failed build still tears down what it started. */
  newFixture(spec: FixtureSpec): Fixture {
    const dir = join(this.scratch, `c${this.allocated++}`);
    const root = join(dir, spec.rootName ?? spec.team);
    const bin = join(dir, "bin");
    const indexHome = join(dir, "index");
    mkdirSync(root, { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(indexHome, { recursive: true });
    return {
      root, bin, indexHome, sessions: [], paneIds: new Map(), clients: [], scriptCapture: join(dir, "osascript.received"),
      initialState: new Map(), base: "",
    };
  }

  /** The durable-state roots this oracle diffs: `.tap` always, the index home when enabled. */
  private stateRoots(fixture: Fixture): StateRoot[] {
    const roots: StateRoot[] = [{ dir: join(fixture.root, ".tap"), keyBase: fixture.root, keyPrefix: "" }];
    if (this.indexState) roots.push({ dir: fixture.indexHome, keyBase: fixture.indexHome, keyPrefix: "index/" });
    return roots;
  }

  /**
   * Build the case's fixture. At FREEZE (TAP_T1_ORACLE_BASE set) the
   * BASE-built constructors run and the constructed inputs are RETURNED for
   * the caller to vendor into the capture; at REPLAY the caller passes the
   * frozen inputs and they are RESTORED — the builders do not run at all, so
   * the replay executes nothing from HEAD (rule 34 amended).
   */
  buildFixture(spec: FixtureSpec, fixture: Fixture, inputs?: FixtureInputs): FixtureInputs | undefined {
    const { root, bin, sessions, clients, scriptCapture } = fixture;
    if (!BASE && !inputs) {
      throw new Error(
        "replay without vendored inputs: rule 34 forbids rebuilding a frozen fixture from HEAD siblings — "
        + "re-freeze with TAP_T1_ORACLE_BASE + TAP_T1_ORACLE_WRITE=1",
      );
    }
    const base = inputs ? inputs.base : this.sanitize(spec.team);
    fixture.base = base;
    const rowSpecs = spec.rows.map(row => ({ ...row, session: row.session ?? `${base}/${row.handle}` }));
    for (const row of rowSpecs) {
      if (!row.live || sessions.includes(row.session)) continue;
      const r = tmux(["new-session", "-d", "-s", row.session, "-c", root, "/bin/sleep", "300"]);
      if (r.status !== 0) throw new Error(`could not start tmux session '${row.session}': ${r.stderr}`);
      sessions.push(row.session);
      fixture.paneIds.set(row.session, tmux(["display-message", "-p", "-t", `=${row.session}:0.0`, "#{pane_id}"]).stdout.trim());
    }
    let vendored: FixtureInputs | undefined;
    if (inputs) {
      // REPLAY: restore the vendored registry bytes, refreshing every
      // RUNTIME-OBSERVED stamp the builder probed from its server — pane ids
      // per live row, the socket path (staleGeneration), and the fixture root.
      // The builders do not run, so no HEAD sibling executes here. Every
      // substitution rides ONE encoded two-phase table (frozen encoded
      // spelling -> sentinel -> fresh encoded spelling) so a fresh value equal
      // to another value's frozen spelling cannot cascade, at any nesting.
      let registryText = inputs.registry;
      // The builder stamps the fixture root into worktree_root and
      // registered_from_worktree; the replay root is a different scratch, and
      // the verb's own catalog (launcher.py list --cwd) filters seats against
      // it — a restored registry naming the freeze scratch reads as an empty
      // team. The root path may carry bytes Python's json.dumps escapes
      // (non-ASCII, DEL, a BOM — the root-shape arms exist to prove those), so
      // its textual form in the file is Python-escaped while JSON.stringify
      // emits raw UTF-8; the table carries BOTH spellings. A
      // parse-and-reserialize refresh is NOT an option: it would rewrite the
      // builder's exact bytes.
      const pyJsonString = (value: string): string => {
        let out = '"';
        for (const ch of value) {
          const code = ch.codePointAt(0)!;
          if (ch === '"') out += '\\"';
          else if (ch === "\\") out += "\\\\";
          else if (ch === "\n") out += "\\n";
          else if (ch === "\t") out += "\\t";
          else if (ch === "\r") out += "\\r";
          else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
          else if (code < 0x7f) out += ch;
          else out += [...ch].map(c => `\\u${c.codePointAt(0)!.toString(16).padStart(4, "0")}`).join("");
        }
        return `${out}"`;
      };
      // Keyed on the frozen encoded spelling: an ASCII root's JSON and
      // Python spellings are identical, and the Map collapses them to one
      // entry so the sentinel pass runs once over the same bytes.
      const subs = new Map<string, string>();
      const addSub = (frozen: string, fresh: string) => { if (!subs.has(frozen)) subs.set(frozen, fresh); };
      for (const row of rowSpecs) {
        if (!row.live) continue;
        const frozenId = inputs.panes[row.handle];
        const freshId = fixture.paneIds.get(row.session ?? `${base}/${row.handle}`);
        if (frozenId && freshId) addSub(JSON.stringify(frozenId), JSON.stringify(freshId));
      }
      const freshSocket = inputs.serverSocket
        ? (tmux(["display-message", "-p", "#{socket_path}"]).stdout.trim() || "")
        : "";
      const freshEpoch = inputs.serverEpoch
        ? (tmux(["display-message", "-p", "#{pid}:#{start_time}"]).stdout.trim() || "")
        : "";
      if (inputs.serverEpoch && freshEpoch) {
        addSub(JSON.stringify(`srv:${inputs.serverEpoch}`), JSON.stringify(`srv:${freshEpoch}`));
      }
      if (inputs.serverSocket && freshSocket) addSub(JSON.stringify(inputs.serverSocket), JSON.stringify(freshSocket));
      if (inputs.root) {
        addSub(JSON.stringify(inputs.root), JSON.stringify(root));
        addSub(pyJsonString(inputs.root), pyJsonString(root));
      }
      const pairs = [...subs];
      // Replay maps fresh runtime spellings back to the frozen ones at
      // compare time (TeamStop effect bytes carry epochs the seeded
      // registry's sentinel pass cannot reach).
      this.activeSubs = pairs;
      this.frozenScratchDir = inputs.root.match(/^(.*)\/c\d+\/[^/]+$/)?.[1] ?? "";
      pairs.forEach(([frozen], i) => { registryText = registryText.split(frozen).join(`"{SUB${i}}"`); });
      pairs.forEach(([, fresh], i) => { registryText = registryText.split(`"{SUB${i}}"`).join(fresh); });
      // The freeze path's Python builder mkdir'd `.tap/bus` itself; the
      // restore must do the same before it can write the vendored bytes.
      mkdirSync(join(root, ".tap", "bus"), { recursive: true });
      writeFileSync(join(root, ".tap", "bus", "registry.json"), registryText);
    } else {
      // FREEZE: build through the BASE builders, then capture the constructed
      // inputs for the caller to vendor into the capture.
      const specPath = join(bin, "..", "spec.json");
      writeFileSync(specPath, JSON.stringify({
        team: spec.team,
        worktree_root: spec.worktreeRoot === "absent" ? null : root,
        rows: rowSpecs,
        stale_generation: spec.staleGeneration === true,
      }));
      const r = spawnSync("python3", ["-B", this.registryScript, root, sessionDir, specPath], { encoding: "utf8", env: tmuxEnv() });
      if (r.status !== 0) throw new Error(`fixture registry failed: ${r.stderr}`);
      const epoch = tmux(["display-message", "-p", "#{pid}:#{start_time}"]).stdout.trim() || undefined;
      vendored = {
        base,
        registry: readFileSync(join(root, ".tap", "bus", "registry.json"), "utf8"),
        panes: Object.fromEntries(rowSpecs.filter(row => row.live).map(row => [row.handle, fixture.paneIds.get(row.session ?? `${base}/${row.handle}`)!])),
        // The same socket probe the registry builder stamps into staleGeneration
        // rows, captured so replay can refresh it for its own server.
        serverSocket: tmux(["display-message", "-p", "#{socket_path}"]).stdout.trim() || undefined,
        serverEpoch: epoch,
        root,
      };
    }
    if (spec.registryBytes !== undefined) {
      const regPath = join(root, ".tap", "bus", "registry.json");
      if (spec.registryBytes === null) rmSync(regPath, { force: true });
      else writeFileSync(regPath, spec.registryBytes);
    }

    // A live v0.20 marker: global-registry.json IS the completion marker, so
    // this one file flips every v20 gate to `live` and arms the H1 index
    // de-enroll paths. The entry spells the same shape `tap register` writes
    // (root + registry_location), which is what the capture witnesses compare.
    if (spec.globalEnroll) {
      writeFileSync(join(fixture.indexHome, "global-registry.json"), `${JSON.stringify({
        schema: "0.20",
        teams: { [spec.team]: { root, registry_location: join(root, ".tap", "bus", "registry.json") } },
      }, null, 2)}\n`);
    } else {
      // Born live (F1): an unenrolled bus under an empty machine index.
      writeFileSync(join(fixture.indexHome, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} }));
    }

    // Refuse selected tmux subcommands for the VERB under test: the run env
    // puts fixture.bin first on PATH, and the shim passes everything else
    // through to the real binary. Kill-survival arms need kill-session to
    // fail while display-message/list-panes stay honest.
    if (spec.tmuxRefuse) {
      const realTmux = spawnSync("bash", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
      if (!realTmux) throw new Error("tmuxRefuse needs a real tmux on PATH to pass through to");
      writeFileSync(join(bin, "tmux"), `#!/usr/bin/env bash
case " $1 " in
  ${spec.tmuxRefuse.map(v => `" ${v} "`).join("|")}) exit 1 ;;
esac
exec ${JSON.stringify(realTmux)} "$@"
`);
      chmodSync(join(bin, "tmux"), 0o755);
    }
    for (const [rel, bytes] of Object.entries(spec.preFiles ?? {})) {
      const path = join(root, rel);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, bytes);
    }

    const probeExit = spec.osascript === "refuse-probe" || !spec.osascript ? 1 : 0;
    const scriptExit = spec.osascript === "reject-script" ? 1 : 0;
    // No iTerm may be reached from a test: the probe refuses unless the case
    // declared its automation mode, so a case that forgot prints commands
    // instead of opening windows on the operator's desktop.
    writeFileSync(join(bin, "osascript"), `#!/usr/bin/env bash
if [ "\${1:-}" = -e ]; then exit ${probeExit}; fi
if [ "\${1:-}" = - ]; then cat > ${JSON.stringify(scriptCapture)}; exit ${scriptExit}; fi
exit 2
`);
    chmodSync(join(bin, "osascript"), 0o755);

    if (spec.python) {
      const body = spec.python === "list-fails"
        ? 'printf "%s\\n" "catalog exploded" "second line" >&2; exit 3'
        : 'printf "[]\\n"; exit 0';
      writeFileSync(join(bin, "python3"), `#!/usr/bin/env bash
want=0; islist=0
for a in "$@"; do
  case "$a" in */launcher.py) want=1 ;; list) [ "$want" = 1 ] && islist=1 ;; esac
done
if [ "$islist" = 1 ]; then
  ${body}
fi
exec ${JSON.stringify(this.realPython)} "$@"
`);
      chmodSync(join(bin, "python3"), 0o755);
      // Since the list port, `tap team attach`'s catalog bridge execs the
      // native producer (`bun …/launcher/list.ts --json`) instead of the
      // python shim's argv — the same intercepted answer, one door later.
      writeFileSync(join(bin, "bun"), `#!/usr/bin/env bash
want=0; islist=0
for a in "$@"; do
  case "$a" in */launcher/list.ts) want=1 ;; --json) [ "$want" = 1 ] && islist=1 ;; esac
done
if [ "$islist" = 1 ]; then
  ${body}
fi
exec ${JSON.stringify(this.realBun)} "$@"
`);
      chmodSync(join(bin, "bun"), 0o755);
    }

    if (spec.ps) {
      // The caller-identity walk asks `ps -o ppid= -o tty= -p <pid>` up the
      // ancestry. Answer parent 1 with either no tty (unobservable) or a tty
      // that no pane on the runner's server owns (positively outside). Other
      // ps forms (the classifier's -Ao) reach the real ps.
      const answer = spec.ps === "unobservable" ? "1 ??" : "1 ttys001";
      writeFileSync(join(bin, "ps"), `#!/usr/bin/env bash
case " $* " in
  *" -Ao "*|*" -A "*) exec /bin/ps "$@" ;;
esac
printf '%s\\n' ${JSON.stringify(answer)}
`);
      chmodSync(join(bin, "ps"), 0o755);
    }

    for (const handle of spec.attached ?? []) {
      const session = rowSpecs.find(row => row.handle === handle)!.session;
      this.attachPtyClient(fixture, session);
    }
    fixture.initialState = snapshotState(this.stateRoots(fixture));
    return vendored;
  }

  /**
   * A pty-backed client, which is what `#{client_tty}` needs to be non-empty
   * (a control-mode client has no tty and reads as not attached). Python's
   * pty.fork gives the child its own terminal whether or not this test has
   * one, which script(1) does not on macOS.
   */
  attachPtyClient(fixture: Fixture, session: string): void {
    const before = tmux(["list-clients", "-t", `=${session}`, "-F", "#{client_tty}"]).stdout.split("\n").filter(Boolean).length;
    // TERM is pinned: under the smoke runner's TERM=dumb tmux refuses to
    // attach a client at all, and the fixture would fail its own premise
    // before either implementation ran (partner review F3).
    const child = spawn("python3", ["-c", "import pty, sys; sys.exit(pty.spawn(sys.argv[1:]) or 0)",
      "tmux", "attach-session", "-t", `=${session}`], { env: { ...tmuxEnv(), TERM: "xterm-256color" }, stdio: ["pipe", "ignore", "ignore"] });
    fixture.clients.push(child);
    let seen = false;
    for (let i = 0; i < 50 && !seen; i++) {
      Bun.sleepSync(100);
      seen = tmux(["list-clients", "-t", `=${session}`, "-F", "#{client_tty}"]).stdout.split("\n").filter(Boolean).length > before;
    }
    if (!seen) throw new Error(`no pty client appeared on '${session}'`);
  }

  teardown(fixture: Fixture): void {
    for (const client of fixture.clients) client.kill("SIGTERM");
    for (const session of fixture.sessions) {
      const r = tmux(["kill-session", "-t", `=${session}`]);
      if (r.status !== 0) throw new Error(`teardown could not kill '${session}': ${r.stderr}`);
    }
  }

  /**
   * The per-run scratch path and pty names are the only bytes that
   * legitimately differ between runs. The SCRATCH prefix is what gets
   * replaced, not the team root: a root carrying a quote is spelled
   * `'…/it'"'"'s a dir'` inside an AppleScript and one carrying non-ASCII is
   * `\u00e9`-escaped there, so the root's own bytes are not contiguous in
   * the output while the ASCII scratch prefix always is.
   */
  normalize(text: string): string {
    // The case directory index depends on which cases ran, so a filtered
    // replay (`-t name`) must not see a different index than the capture did.
    let out = text;
    // Replace the longer real path first: /tmp is a suffix of /private/tmp
    // on macOS, and replacing it first leaves a spurious /private{CASE}.
    for (const scratch of [realpathSync(this.scratch), this.scratch].sort((a, b) => b.length - a.length)) {
      out = out.split(scratch).join("{SCRATCH}");
    }
    out = out.replace(/\{SCRATCH\}\/c[0-9]+/g, "{CASE}");
    // The runner's tmux namespace names the socket the prologue stamps into rows.
    for (const dir of this.tmuxDirSpellings) out = out.split(dir).join("{TMUX_TMPDIR}");
    return out
      .replace(/\/dev\/(ttys[0-9]+|pts\/[0-9]+)/g, "{TTY}")
      // The bus authority marker both doors write carries the wall clock, and
      // so does every registry event line.
      .replace(/bootstrapped_at_epoch=[0-9]+/g, "bootstrapped_at_epoch={EPOCH}")
      .replace(/^ts=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z /gm, "ts={TS} ")
      // Reset checkpoint metadata carries the wall clock.
      .replace(/"created_at": "[^"]*"/g, '"created_at": "{TS}"')
      // A process id in a caller-identity refusal.
      .replace(/pid '[0-9]+'/g, "pid '{PID}'")
      .replace(/parent '[0-9]+'/g, "parent '{PID}'");
  }

  /**
   * One door, from the restored initial state. `insidePane` runs the command
   * INSIDE a tmux pane of the fixture's server (the caller-identity arms need
   * a real controlling tty that a pane owns); otherwise the command is a
   * plain child with no terminal.
   */
  run(door: Door, fixture: Fixture, argv: string[], options: RunOptions = {}): Streams & { trace: string } {
    const env: NodeJS.ProcessEnv = {
      ...tmuxEnv(),
      PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
      TAP_HOME: join(fixture.root, ".tap", "bus"),
      TAP_INDEX_HOME: fixture.indexHome,
      ...(options.env ?? {}),
    };
    const tracePath = join(fixture.bin, "..", `trace.${door}`);
    if (existsSync(tracePath)) rmSync(tracePath);
    if (door === "head-native") env.TAP_BUN_ROUTE_TRACE = tracePath;
    const tap = door === "base" ? baseTap : headTap;
    restoreState(this.stateRoots(fixture), fixture.initialState);
    const busRoot = join(fixture.root, ".tap", "bus");
    if (options.busAuthorityUnwritable) {
      // Ordered after the restore (which rewrites `.tap` wholesale): marker
      // gone, the two child dirs pre-created, then the root read-only for the
      // child. Restored in the finally below, before snapshot/teardown.
      rmSync(join(busRoot, ORACLE_BUS_AUTHORITY_MARKER), { force: true });
      mkdirSync(join(busRoot, "payloads"), { recursive: true });
      mkdirSync(join(busRoot, "receipts"), { recursive: true });
      chmodSync(busRoot, 0o555);
    }
    let r: { stdout: string; stderr: string; status: number | null };
    try {
      if (options.insidePane) {
        r = this.runInsidePane(fixture, tap, argv, env, options.insidePane, options);
      } else {
        const child = spawnSync("bash", [tap, ...argv], {
          cwd: fixture.root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
        });
        r = { stdout: child.stdout ?? "", stderr: child.stderr ?? "", status: child.status };
      }
    } finally {
      if (options.busAuthorityUnwritable) chmodSync(busRoot, 0o755);
    }
    const trace = existsSync(tracePath) ? readFileSync(tracePath, "utf8") : "";
    const changed = effects(fixture.initialState, snapshotState(this.stateRoots(fixture)));
    // Replay ran against THIS run's epoch/socket/root: map those spellings
    // back to the frozen ones so effect bytes compare equal.
    const applySubs = (text: string): string => {
      let out = text;
      for (const [frozen, fresh] of this.activeSubs) out = out.split(fresh).join(frozen);
      // Bytes still spelling the FREEZE scratch (roots no fresh run rewrote)
      // must reach normalize under the current scratch spelling.
      if (this.frozenScratchDir) out = out.split(this.frozenScratchDir).join(this.scratch);
      return out;
    };
    return canonicalStreams({
      stdout: this.normalize(applySubs(r.stdout)), stderr: this.normalize(applySubs(r.stderr)), rc: r.status ?? -1,
      effects: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v === null ? null : this.normalize(applySubs(v))])),
      trace,
    });
  }

  /**
   * Run the verb inside a pane of a fresh tmux session on the fixture's
   * server, so the process's controlling tty IS a pane's tty. Output lands in
   * files the pane's shell writes; the exit code is read back the same way.
   * `clients` pty clients are attached to that caller session first.
   */
  private runInsidePane(fixture: Fixture, tap: string, argv: string[], env: NodeJS.ProcessEnv, inside: InsidePane, options: RunOptions = {}) {
    const dir = join(fixture.bin, "..", `pane-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(dir, { recursive: true });
    const session = inside.session;
    const envFile = join(dir, "env");
    const lines = Object.entries(env).filter(([, v]) => v !== undefined).map(([k, v]) => `export ${k}=${shellQuote(v!)}`);
    writeFileSync(envFile, `${lines.join("\n")}\n`);
    const script = join(dir, "run.sh");
    writeFileSync(script, `#!/usr/bin/env bash
. ${shellQuote(envFile)}
cd ${shellQuote(fixture.root)}
bash ${shellQuote(tap)} ${argv.map(shellQuote).join(" ")} > ${shellQuote(join(dir, "out"))} 2> ${shellQuote(join(dir, "err"))}
echo $? > ${shellQuote(join(dir, "rc"))}
sleep 300
`);
    chmodSync(script, 0o755);
    // The caller session is per DOOR and torn down after the run, so the three
    // doors see the same session name and the same client count.
    const callerClients: ChildProcess[] = [];
    const scratchFixture: Fixture = { ...fixture, clients: callerClients, sessions: [] };
    const r = inside.existing
      ? tmux(["respawn-pane", "-k", "-t", `=${session}:0.0`, script])
      : tmux(["new-session", "-d", "-s", session, "-c", fixture.root, script]);
    if (r.status !== 0) throw new Error(`could not start caller session '${session}': ${r.stderr}`);
    try {
      for (let i = 0; i < (inside.clients ?? 0); i++) this.attachPtyClient(scratchFixture, session);
      const rcPath = join(dir, "rc");
      for (let i = 0; i < 600 && !existsSync(rcPath); i++) Bun.sleepSync(100);
      if (!existsSync(rcPath)) {
        // A self-last kill takes the pane running the verb with it: the rc
        // file never lands because the shell that would write it is gone.
        // That is the incumbent contract (the receipt precedes the kill), so
        // when allowPaneDeath is set and the caller session is observably
        // dead, the run is COMPLETE — rc stays null (run() records -1).
        if (options.allowPaneDeath && tmux(["has-session", "-t", `=${session}`]).status !== 0) {
          return {
            stdout: readFileSync(join(dir, "out"), "utf8"),
            stderr: readFileSync(join(dir, "err"), "utf8"),
            status: null,
          };
        }
        throw new Error(`the verb inside '${session}' did not finish within 60 s`);
      }
      return {
        stdout: readFileSync(join(dir, "out"), "utf8"),
        stderr: readFileSync(join(dir, "err"), "utf8"),
        status: Number(readFileSync(rcPath, "utf8").trim()),
      };
    } finally {
      for (const client of callerClients) client.kill("SIGTERM");
      // An existing session belongs to the fixture (teardown owns it); only a
      // caller session this helper created itself is torn down here.
      if (!inside.existing) tmux(["kill-session", "-t", `=${session}`]);
    }
  }

  capture(): Capture | null {
    return existsSync(this.fixturePath) ? JSON.parse(readFileSync(this.fixturePath, "utf8")) as Capture : null;
  }

  writeCapture(written: Capture["cases"], blobs: string[], expectCount?: number): void {
    if (!BASE || !WRITE) return;
    // A filtered re-run (`-t name`) captures a subset; writing it would clobber
    // the full capture with a partial corpus. Skip loud instead.
    if (expectCount !== undefined && written.length !== expectCount) {
      process.stderr.write(`writeCapture: ${written.length}/${expectCount} cases captured — filtered run? capture NOT written\n`);
      return;
    }
    const blob = (path: string) => spawnSync("git", ["-C", BASE, "rev-parse", `HEAD:${path}`], { encoding: "utf8" }).stdout.trim();
    const head = spawnSync("git", ["-C", BASE, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const out: Capture = {
      captured_from: {
        head,
        blobs: Object.fromEntries(blobs.map(p => [p, blob(p)])),
        platform: process.platform,
        bash: spawnSync("bash", ["-c", "echo $BASH_VERSION"], { encoding: "utf8" }).stdout.trim(),
        python: spawnSync("python3", ["-c", "import sys; print(sys.version.split()[0])"], { encoding: "utf8" }).stdout.trim(),
      },
      cases: written,
    };
    writeFileSync(this.fixturePath, `${JSON.stringify(out, null, 2)}\n`);
  }
}

export type Door = "head-native" | "base";

export interface InsidePane {
  /** The caller session's name. */
  session: string;
  /** How many pty clients view the caller session before the verb runs. */
  clients?: number;
  /**
   * The session already exists (built from the fixture's rows): replace its
   * window's pane process with the run script instead of creating a new
   * session. The pane id the registry stamped stays the caller's pane, which
   * is what makes caller identity resolve to that row. The session is NOT
   * killed after the run — fixture teardown owns it, and the post-run state
   * snapshot must see it alive or dead as the VERB left it.
   */
  existing?: boolean;
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  insidePane?: InsidePane;
  /**
   * The verb is expected to take its own pane down (self-last kill): a
   * missing rc file is then a completed run, not a hang, provided the caller
   * session is observably gone. Recorded rc is null.
   */
  allowPaneDeath?: boolean;
  /**
   * Test-only arm: after the fixture restore, remove the bus authority marker,
   * make sure payloads/ + receipts/ exist (ensureDirs creates them before it
   * stamps the marker — an EACCES from the mkdir would be an untagged crash,
   * not the tagged refusal this arm tests), then make the bus root unwritable
   * for the child. Permissions are restored in a `finally` before the effects
   * snapshot, so the runner can clean up.
   */
  busAuthorityUnwritable?: boolean;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function applyDeviations<N extends string>(
  deviations: Record<N, Deviation>, expected: Streams, names: N[] | undefined, caseName: string,
): Streams {
  let out = expected;
  for (const name of names ?? []) {
    const next = deviations[name].apply(out);
    if (JSON.stringify(next) === JSON.stringify(out)) {
      throw new Error(`case ${caseName} declares deviation '${name}' but the incumbent's bytes carry nothing for it to transform`);
    }
    out = next;
  }
  return out;
}

export function assertBaseCheckout(deletedFile: string, pinned: string = ORACLE_PINNED_BASE): void {
  if (BASE) {
    // Fail loud on a checkout/commit mismatch: the freeze environment must be
    // the pinned snapshot, not whichever checkout the path happens to name
    // (the incumbent file existing is not enough).
    const head = spawnSync("git", ["-C", BASE, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    if (head !== pinned) {
      throw new Error(
        `TAP_T1_ORACLE_BASE=${BASE} is at ${head || "<no commit>"}, but this oracle is pinned to ${pinned} `
        + "— point it at the pinned base checkout or re-freeze deliberately",
      );
    }
    if (!existsSync(join(BASE, deletedFile))) {
      throw new Error(`TAP_T1_ORACLE_BASE=${BASE} does not carry ${deletedFile} — not a base-commit checkout`);
    }
  }
}

/** At replay: the frozen capture must be provenance-bound to the pinned base commit. */
export function assertCaptureProvenance(
  capture: { captured_from: { head: string }; cases: Array<{ name: string; inputs?: FixtureInputs }> },
  fixturePath: string,
  pinned: string = ORACLE_PINNED_BASE,
): void {
  if (capture.captured_from.head !== pinned) {
    throw new Error(
      `${fixturePath} was captured from ${capture.captured_from.head}, not the pinned base ${pinned} — `
      + "not evidence for this differential; re-freeze from the pinned checkout",
    );
  }
  for (const c of capture.cases) {
    if (!c.inputs) {
      throw new Error(
        `${fixturePath} case '${c.name}' carries no vendored inputs — the capture predates the rule-34 `
        + "vendor rework; re-freeze with TAP_T1_ORACLE_BASE + TAP_T1_ORACLE_WRITE=1",
      );
    }
  }
}

const REGISTRY_PY = `import json, pathlib, subprocess, sys
root, session_dir, spec_path = sys.argv[1], sys.argv[2], sys.argv[3]
sys.path.insert(0, session_dir)
import launcher  # noqa: E402
try:
    SERVER_EPOCH = "srv:" + subprocess.run(
        ["tmux", "display-message", "-p", "#{pid}:#{start_time}"],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
except Exception:
    SERVER_EPOCH = "srv:0:0"  # no server: the fixture has no live rows to verify
spec = json.load(open(spec_path))
team = spec["team"]
payload = {"schema": "0.20", "team": {"name": team}, "seats": {}}
if spec.get("worktree_root") is not None:
    payload["team"]["worktree_root"] = spec["worktree_root"]
for n, row in enumerate(spec["rows"], start=1):
    handle = row["handle"]
    session = row.get("session") or f"{launcher.sanitize_component(team)}/{handle}"
    pane_id = "%%%d" % (100 + n)
    if row["live"]:
        pane_id = subprocess.run(
            ["tmux", "display-message", "-p", "-t", "=" + session + ":0.0", "#{pane_id}"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
    entry = {
        "status": row.get("status") or "active",
        "delivery": row.get("delivery") or "pane",
        "registered_from_worktree": root,
        "registered_at": "2026-09-15T00:00:00Z",
        "pane": session + ":0.0",
        "pane_id": pane_id,
        "server_epoch": SERVER_EPOCH,
        "session": session,
    }
    if row.get("status_reason"):
        entry["status_reason"] = row["status_reason"]
    if row.get("noSession"):
        del entry["session"]
    if row.get("noPane"):
        del entry["pane"]
        del entry["pane_id"]
    if spec.get("stale_generation"):
        entry["server_socket"] = subprocess.run(
            ["tmux", "display-message", "-p", "#{socket_path}"], check=True, capture_output=True, text=True,
        ).stdout.strip()
    if row.get("crew"):
        entry["crew"] = True
    if not row.get("bare"):
        record = launcher.SessionRecord(name=session, harness="claude", cwd=root, base=team, tag=handle, index=1)
        if hasattr(launcher, "store_session_record_fields"):
            launcher.store_session_record_fields(entry, record)  # pinned base
        else:
            value = launcher._native_record_value("store-recipe", record, entry=entry)
            entry.clear()
            entry.update(value)
    # The launcher owns its durable fields and clears what its record does not
    # carry — the row's LIVE PANE FACTS are this fixture's to stamp, after the
    # store, from the sessions the builder created.
    if not row.get("noPane"):
        entry["pane"] = session + ":0.0"
        entry["pane_id"] = pane_id
    payload["seats"][handle] = entry
registry = pathlib.Path(root) / ".tap" / "bus" / "registry.json"
registry.parent.mkdir(parents=True, exist_ok=True)
registry.write_text(json.dumps(payload) + "\\n")
`;
