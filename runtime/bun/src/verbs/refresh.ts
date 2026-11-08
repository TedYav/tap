// `tap team refresh` — native. Classify registry rows live/gone/unobservable,
// trim the gone ones, and report. tap-nyvty.
//
// WHAT IS NATIVE HERE AND WHAT IS DELIBERATELY NOT.
//
// This file owns the VERB: argument parsing and refusals, the reset-fence gate,
// the bucket chain, the compare-and-trim under the registry lock, the atomic
// write, the registry event append, the in-process stranded-mail report, and
// both renderers. The `--hard` namespace read is the tmux.ts leaf the launcher's
// classifier was ported into.
//
// It does NOT own seat classification. "Is this seat gone" is answered in
// exactly one place — the in-process observe.ts engine, reached the same way
// team.ts's roster reaches it. Pending-reservation expiry uses the shared
// native helper, also called by the remaining Bash adapters. A second
// implementation here would create a SECOND answer that drifts from roster and
// attach, which is the parity hazard shared-helper discipline exists to prevent.
//
// THE FINGERPRINT IS A COMPARE-AND-SWAP ACROSS THE LOCK. Read a row,
// fingerprint it, then under the lock re-fingerprint and pop only on an exact
// match, so a row that changed under a racing `tap in` is never deleted. Both
// sides of that comparison run HERE: the roster reader parses losslessly and
// the under-lock fingerprint comes from a serializer whose bytes are python's
// `json.dumps(sort_keys=True, separators=(",", ":"))` exactly, per
// `spool-publication` — so the comparison compares two runs of ONE encoding,
// not two encodings that merely agree today. The danger that killed the
// earlier two-language design is not the language but the drift: a
// silent-never-trim class where encodings diverge by one byte and refresh
// reports a clean run forever. The native side is pinned against that by the
// trim and roster tests in `team.test.ts` (whose fingerprints are computed by
// python, not by this file) and by the parity comparator's trim scenarios,
// which byte-compare every rewrite the verb makes, non-ASCII rows included.
//
// PARITY IS THE WHOLE OBSERVABLE SURFACE — stdout, stderr, exit status, the
// registry's bytes, and its file MODE (tap-vltws) — not just the happy buckets.
// Two shapes below look like defects and are reproduced on purpose; each is
// marked PARITY where it appears.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { TapError, resolveContext, type ResolvedContext } from "../context";
import { isNoMachineIndex } from "../selector";
import { teamRegistryRefusal, isOldStoreRefusal } from "../register-authority";
import { atomicWrite, ensureAscii } from "../fsatomic";
import { lockRoot, acquireRegistryLockAsync } from "../panelock";
import { PhaseProgress, progressMode } from "../progress";
import {
  isDict,
  jsonDumpBytes,
  metaBytes,
  parseJsonPreserving,
  pyReadUtf8,
  pyStrCompare,
  pyTruthy,
} from "../spool-publication";
import { assertResetUnfenced } from "../reset";
import { StrandScanFailure, strandedIds } from "../seat-adopt";
import { tmuxReadOnly, tmuxSessionNamespace } from "../tmux";
import { pendingExpired, pendingGrace } from "../pending-reservation";
import { observe, type RegistryRow } from "./team";
import type { ObserveEngine } from "../observe";
import { appendRegistryEventOrWarn, registryEventsPath } from "../events";
import { fenceCrewLifetime } from "../crew-lifetime";
import { verbArgv } from "../courier-argv";
import { cmdRefreshStale, isStaleArgv } from "../team/stale";

const US = "\x1f";

// Bash runs this subcommand with TAP_VERB="tap team refresh", so every refusal
// it raises names the subcommand rather than the parent verb.
const VERB = "tap team refresh";

export interface RefreshOptions {
  json: boolean;
  dryRun: boolean;
  hard: boolean;
}

/**
 * The fingerprint python computes for a registry row: `json.dumps(ent,
 * sort_keys=True, separators=(",", ":"))`, urlsafe-base64'd. A non-dict value
 * fingerprints as the empty string, which is also what the incumbent compares
 * against — no row the roster reader emits can carry an empty fingerprint, so
 * the empty-matches-empty corner is unreachable through the verb and kept only
 * to stay faithful to the shape being ported.
 *
 * `Buffer.toString("base64")` keeps python's `=` padding; substituting the
 * urlsafe alphabet character-by-character reproduces `urlsafe_b64encode`
 * exactly, where `"base64url"` may strip the padding.
 */
function rowFingerprint(current: unknown): string {
  if (!isDict(current)) return "";
  const compact = jsonDumpBytes(current, { item: ",", key: ":" }, true);
  return Buffer.from(compact, "utf8").toString("base64").replaceAll("+", "-").replaceAll("/", "_");
}

/**
 * The compare-and-trim the incumbent runs as a python child — now in-process,
 * because the caller holds the registry lock. Takes candidate lines of
 * `handle<US>fingerprint` (the pre-lock fingerprints), re-fingerprints each
 * row as the registry reads NOW, and pops only on an exact match. Returns the
 * handles ACTUALLY removed: a row whose fingerprint changed under the race is
 * kept, and must not then be reported as removed. Rewrites the registry only
 * when something was removed — a zero-match call must not touch the file, not
 * even with identical bytes.
 *
 * Refusals are the incumbent's trim-failure shape: nothing here can run unless
 * the registry is readable, so an unreadable registry under the lock is
 * `registry_invalid` / `repair_registry` — and so is a registry that cannot be
 * rewritten, as the incumbent's nonzero writer child was.
 */
export function trimRegistryLocked(registryPath: string, candidates: string[]): Set<string> {
  const wanted = new Map<string, string>();
  for (const line of candidates) {
    if (!line) continue;
    const at = line.indexOf(US);
    if (at < 0) continue;
    wanted.set(line.slice(0, at), line.slice(at + 1));
  }
  let reg: unknown;
  try {
    reg = existsSync(registryPath) ? parseJsonPreserving(pyReadUtf8(registryPath)) : {};
  } catch (error) {
    throw new TapError(1, "registry_invalid", "repair_registry",
      `tap team refresh: registry unreadable under the trim lock (${(error as Error).message})`, VERB);
  }
  if (!isDict(reg)) {
    throw new TapError(1, "registry_invalid", "repair_registry",
      "tap team refresh: registry unreadable under the trim lock (not an object)", VERB);
  }
  // A missing file reads as {} and trims nothing; an existing old-format file refuses.
  if (existsSync(registryPath)) {
    const refusal = teamRegistryRefusal(registryPath, reg);
    if (refusal) throw new TapError(1, refusal.errorClass, refusal.action, refusal.detail, VERB);
  }
  // Only a seats map beside no `agents` key is writable; anything else is never rewritten.
  const agentsRaw = "agents" in reg ? undefined : reg.seats;
  const removed = new Set<string>();
  if (!isDict(agentsRaw)) return removed;
  for (const [handle, fingerprint] of wanted) {
    if (rowFingerprint(agentsRaw[handle]) === fingerprint) {
      delete agentsRaw[handle];
      removed.add(handle);
    }
  }
  if (removed.size > 0) {
    try {
      // metaBytes is exactly python's `json.dump(reg, indent=2, sort_keys=True)`
      // plus the trailing newline, so everything JSON.parse would have erased —
      // `2.0`, integers past 2^53, non-ASCII — survives the rewrite; atomicWrite
      // lands it by rename from a 0600 temp file in the registry's own directory.
      atomicWrite(registryPath, metaBytes(reg as Parameters<typeof metaBytes>[0]));
    } catch (error) {
      // Publication failure is the native twin of the incumbent's nonzero
      // writer child: same public refusal, original bytes untouched.
      throw new TapError(1, "registry_invalid", "repair_registry",
        `tap team refresh: registry could not be rewritten under the trim lock (${
          (error as NodeJS.ErrnoException)?.code ?? (error as Error).message
        })`, VERB);
    }
  }
  return removed;
}


export interface Row {
  handle: string;
  delivery: string;
  pane: string;
  paneId: string;
  status: string;
  session: string;
  registeredAt: string;
  statusReason: string;
  launchId: string;
  serverEpoch: string;
  serverSocket: string;
  harness: string;
  bootId: string;
  fingerprint: string;
  crew: boolean;
}

interface Bucketed {
  handle: string;
  reason: string;
  pane: string;
  harness?: string;
  lastStatus?: string;
  crew?: boolean;
  collectReason?: string;
  parent?: string;
}

type SeatObservation = [string, string, string, string, string, string];

/**
 * A refusal in `--json` mode is an OBJECT ON STDOUT, not a line on stderr.
 *
 * Bash's `tap_fail` branches on TAP_JSON: `tap_error_json` prints
 * `{"ok":false,"error_class":…,"action":…,"detail":…}` to stdout, while
 * `tap_error_line` writes the human sentence to stderr. A native path that
 * sends every refusal to stderr passes a human-mode fixture and fails the
 * machine surface — which is exactly what happened here, in a verb whose own
 * audit table documents the rule.
 *
 * THE ACTION IS RAW IN JSON. `tap_error_json` passes it through untouched;
 * only the human renderer turns `repair_registry` into "repair registry". The
 * same refusal therefore reads differently in the two modes, and humanizing
 * both would look tidier and be wrong.
 *
 * `detail` is OMITTED when empty rather than emitted as "" — bash's `if detail:`.
 */
function jsonRefusal(error: TapError): void {
  const fields: [string, string][] = [
    ["ok", "false"],
    ["error_class", JSON.stringify(error.errorClass)],
    ["action", JSON.stringify(error.action)],
  ];
  if (error.detail) fields.push(["detail", JSON.stringify(error.detail)]);
  const body = fields.map(([k, v]) => `${JSON.stringify(k)}:${v}`).join(",");
  process.stdout.write(`${ensureAscii(`{${body}}`)}\n`);
}

/**
 * `tap team`, NOT `tap team refresh` — and that is measured, not stylistic.
 *
 * The incumbent raises this refusal from `tap_team_context`, which runs while
 * TAP_VERB is still the parent verb, so bash prints `tap team: acting registry
 * unreachable ...` even when the subcommand is `refresh`. Labelling it with this
 * file's VERB constant is the natural thing to write and diverges by seven bytes
 * on a line the parity comparator reads.
 *
 * That divergence was already present on the decoy branch below before this
 * guard existed; no scenario reached either branch, so nothing reddened.
 */
function unreachableRegistry(): TapError {
  return new TapError(1, "registry_unreachable", "tap doctor",
    "acting registry unreachable — refusing tap team against a bus decoy", "tap team");
}

/**
 * PARITY: the detail already begins "tap team refresh: ", and the incumbent's
 * tap_fail prepends the verb again — so the human line carries the prefix
 * TWICE. It reads like a defect and the fenced path does the same thing, so
 * it is tap_fail's shape rather than one site's slip. Emitting it once here
 * would break byte parity while looking like a cleanup; any fix belongs in a
 * separate PR against both implementations.
 */
function registryUnreadable(reason: string): TapError {
  return new TapError(1, "registry_invalid", "repair_registry",
    `tap team refresh: registry unreadable (${reason})`, VERB);
}

/**
 * The acting-registry guard has TWO halves, and this function once had one.
 *
 * `resolveContext()` THROWS for a bus decoy, which the catch below converts. It
 * does NOT throw for the other unreachable shape: a live v0.20 flip marker that
 * enrolls this root while the enrolled `registry_location` does not exist. There
 * it returns a live-marker context holding a path to nothing, and every read
 * downstream succeeds at reading nothing — the in-process roster read answers a
 * missing file with an empty roster (by design: an absent registry is a
 * legitimate empty roster), so refresh rendered `nothing to refresh` and
 * exited 0.
 *
 * MEASURED, not reasoned. On one bus with a live marker, an unreachable
 * `registry_location`, and a seat sitting in the bus decoy:
 *
 *   native  tap team          -> registry_unreachable, exit 1
 *   bash    tap team refresh  -> registry_unreachable, exit 1
 *   native  tap team refresh  -> "nothing to refresh",  exit 0
 *   native  tap team refresh --json -> {"trimmed":[],"skipped":[],"kept":[]}, exit 0
 *
 * A success receipt for a reconciliation that never reached a registry, and the
 * sibling verb in the same runtime refusing correctly beside it. `teamContext()`
 * (team.ts) has carried the second half all along; this one did not, which is
 * why the divergence was invisible to a reader comparing the two catch blocks.
 */
/**
 * A REGISTRY IS A FILE, and `existsSync` does not say that.
 *
 * The incumbent's test is `[ -f ]`. The first version of this guard used
 * `existsSync`, which is TRUE for a directory — so a live v0.20 marker whose
 * enrolled `registry_location` pointed at an existing directory sailed past the
 * guard, reached the reader, and came back as `registry_invalid` /
 * `repair_registry` while bash refused `registry_unreachable` / `tap doctor`.
 *
 * MEASURED at `b1febbfd` (cleanup review), four divergences on one
 * input: the error class, the remedy, and — under `--json` — the STREAM, where
 * native emitted a parseable object and the incumbent emitted nothing on stdout.
 * The exit code agreed at 1, so nothing downstream could tell them apart.
 *
 * It is also the conflation this PR exists to kill, one guard earlier than the
 * one it killed. `readRoster`'s note already says it: "repair the registry" is
 * wrong advice for a registry nobody managed to read — and a directory is
 * exactly a registry nobody managed to read.
 *
 * `statSync`, not `lstatSync`: `[ -f ]` follows symlinks, so a symlink to a real
 * registry must pass here as it does there.
 */
function isRegularFile(path: string): boolean {
  if (!path) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function refreshContext(): ResolvedContext {
  let ctx: ResolvedContext;
  try {
    ctx = resolveContext();
  } catch (error) {
    if (error instanceof TapError && error.errorClass !== "not_a_bus" && !isNoMachineIndex(error) && !isOldStoreRefusal(error)) throw unreachableRegistry();
    throw error;
  }
  if (ctx.marker === "live" && !isRegularFile(ctx.registryPath)) {
    throw unreachableRegistry();
  }
  return ctx;
}

export function parseRefreshOptions(argv: string[]): RefreshOptions {
  const out: RefreshOptions = { json: false, dryRun: false, hard: false };
  for (const arg of argv) {
    if (arg === "--json") out.json = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--hard") out.hard = true;
    else if (arg.startsWith("--")) {
      throw new TapError(1, "unknown_option", "tap help team refresh", `unknown option '${arg}'`, VERB);
    } else {
      throw new TapError(1, "usage_error", "tap help team refresh", `unexpected arg '${arg}'`, VERB);
    }
  }
  return out;
}

export function readRoster(registryPath: string): Row[] {
  let text: string;
  try {
    text = pyReadUtf8(registryPath);
  } catch (error) {
    // The incumbent's FileNotFoundError exited 0: an absent registry is a
    // legitimate empty roster, never a refusal (the acting-registry guard's
    // note depends on this for the unreachable-marker path).
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw registryUnreadable((error as Error).message);
  }
  let reg: unknown;
  try {
    reg = parseJsonPreserving(text);
  } catch (error) {
    throw registryUnreadable((error as Error).message);
  }
  if (!isDict(reg)) throw registryUnreadable("registry is not an object");
  // `seats or {}`: the acting pin already refused an old store (old_store), so a
  // falsy seats value is an empty roster and a truthy non-dict one is refused.
  const rawAgents = reg.seats;
  const agents = pyTruthy(rawAgents) ? rawAgents : {};
  if (!isDict(agents)) throw registryUnreadable("seats map is not an object");
  const rows: Row[] = [];
  for (const handle of Object.keys(agents).sort(pyStrCompare)) {
    const ent = agents[handle];
    if (!isDict(ent)) continue;
    // An `or`-field sends a falsy value to its default and REFUSES a truthy
    // non-string — the incumbent's join crashed with TypeError, so coercion
    // was never a behavior to preserve. `status` is `get(key, default)`, not
    // `or`: the default applies only when the key is ABSENT, and a present
    // value of any non-string type (null included) refused.
    const orField = (key: string, fallback: string): string => {
      const value = ent[key];
      if (!pyTruthy(value)) return fallback;
      if (typeof value === "string") return value;
      throw registryUnreadable(`row '${handle}' field '${key}' is not a string`);
    };
    let status: string;
    if ("status" in ent) {
      if (typeof ent.status !== "string") {
        throw registryUnreadable(`row '${handle}' field 'status' is not a string`);
      }
      status = ent.status;
    } else {
      status = "active";
    }
    rows.push({
      handle,
      delivery: orField("delivery", "pane"),
      pane: orField("pane", ""),
      paneId: orField("pane_id", ""),
      status,
      session: orField("session", ""),
      registeredAt: orField("registered_at", ""),
      statusReason: orField("status_reason", ""),
      launchId: orField("launch_id", ""),
      serverEpoch: orField("server_epoch", ""),
      harness: orField("harness", ""),
      bootId: orField("boot_id", ""),
      fingerprint: rowFingerprint(ent),
      crew: ent.crew === true,
      serverSocket: orField("server_socket", ""),
    });
  }
  return rows;
}

export function cmdRefresh(argv: string[], scriptsDir: string): number | Promise<number> {
  // `--stale` is its own pass with its own selection and consent (team/stale.ts).
  if (isStaleArgv(argv)) return cmdRefreshStale(argv, scriptsDir);
  if (argv.includes("--include-idle")) {
    throw new TapError(1, "usage_error", "tap help team refresh", "--include-idle selects the idle group of the stale pass; use it with --stale", VERB);
  }
  // ORDER IS OBSERVABLE. The incumbent gates the fence in the `tap team`
  // dispatcher, BEFORE the subcommand parses its own argv, so a fenced bus plus
  // a bogus flag reports the FENCE, never unknown_option — and because
  // `want_json` is still unset at that point, a fenced refusal is always
  // human-mode even under --json. Parsing argv first here (the natural way to
  // write it) would invert both, and no single-condition fixture catches it.
  const ctx = refreshContext();
  assertResetUnfenced(ctx.bus.home, "tap team refresh");

  const options = parseRefreshOptions(argv);
  ctx.bus.ensureDirs();

  // From here on the mode is known, so a refusal can take its JSON form. The
  // two lines above deliberately cannot: bash gates the fence and resolves the
  // registry BEFORE `want_json` is parsed, so those refusals are always
  // human-form even under --json (audit E3 / R-ORDER, fixture arm 6c).
  //
  // The progress line is a terminal-only exception (CLI-STANDARDS CLI-TTY):
  // stderr on a TTY, never under --json, a dry run (nothing to wait on), NO_COLOR
  // or TERM=dumb. The launcher's progressMode animates under NO_COLOR; refresh
  // does not, so the extra gate lives here and the launcher's bytes stay put.
  const animate = progressMode(!!process.stderr.isTTY, options.json || options.dryRun) === "animate"
    && !Object.hasOwn(process.env, "NO_COLOR");
  const progress = animate ? new PhaseProgress() : null;
  return runRefresh(ctx, options, scriptsDir, progress).then(
    (code) => { progress?.stop("✓"); return code; },
    (error) => {
      progress?.stop("✗");
      if (options.json && error instanceof TapError) {
        jsonRefusal(error);
        return error.code;
      }
      throw error;
    },
  );
}

async function runRefresh(
  ctx: ResolvedContext, options: RefreshOptions, scriptsDir: string, progress: PhaseProgress | null,
): Promise<number> {
  progress?.phase("Reading the team registry");
  const rows = readRoster(ctx.registryPath);
  if (rows.length === 0) { progress?.stop("✓"); return renderEmpty(options.json); }

  const trimmed: Bucketed[] = [];
  const kept: Bucketed[] = [];
  const skipped: Bucketed[] = [];
  const candidates: string[] = [];
  const rebinds: { handle: string; pane: string }[] = [];

  // One blocking tmux/process snapshot classifies the whole roster (~150 ms at
  // 160 sessions, measured), too short to animate: the line names it anyway so
  // a slow host is not silent. The waits that DO take seconds — the registry
  // lock and the per-seat rebinds — are async below, so their frames tick.
  progress?.phase(`Checking ${rows.length} seat${rows.length === 1 ? "" : "s"} against tmux`);
  let hardSnapshot: Set<string> | null = null;
  let hardObservable = true;
  if (options.hard) {
    // Fail-closed, by the launcher's own classification: a RECOGNIZED
    // no-server answer is positive proof of an empty namespace; every other
    // failure is not deletion authority. Only an observable read fills the
    // snapshot.
    const ns = tmuxSessionNamespace();
    if (ns.observable) {
      hardSnapshot = ns.names;
    } else {
      hardObservable = false;
      hardSnapshot = new Set();
    }
  }

  // ONE snapshot for the run, taken when the FIRST row actually needs it.
  //
  // Still one call, so every row is classified against the same observation —
  // that is what makes two rows' verdicts comparable and what the batch engine
  // exists to provide, and calling it per row is what deleted a live seat
  // earlier in this port. What changed is only WHEN: taking it eagerly meant a
  // roster where no row can reach the observation branch still spawned the
  // classifier.
  //
  // MEASURED, on a poll-only roster with a failing classifier — every row is
  // bucketed by the poll branch, so nothing consults an observation:
  //
  //   bash    {"trimmed":[],"skipped":[...poll-mode...],"kept":[]}   exit 0
  //   native  <the classifier's raw stdout>\n{...the same JSON...}   exit 0
  //
  // The incumbent's poll, pending and hard branches all precede
  // `tap_seat_observed_record`, so a classifier failure it never triggers cannot
  // reach its receipt. Eagerly, ours could: `observe` copies a failed child's
  // output to our stdout, which turned a valid `--json` receipt into an
  // unparseable one for a failure that had no bearing on any row's verdict
  // (codex, refresh.ts:417).
  //
  // Deferring rather than pre-computing the subset is deliberate: the set of
  // rows that reach observation is defined by the guards in the loop below, and
  // restating them above it would be a second copy of the bucket chain, drifting
  // the first time a branch is added.
  let observedMemo: Map<string, SeatObservation> | null = null;
  const observation = (handle: string): SeatObservation => {
    observedMemo ??= observeAll(scriptsDir, rows);
    return observedMemo.get(handle)
      ?? ["unknown", "harness_unobservable", "", "", "", ""];
  };

  const socketProbe = rows.some(row => row.serverSocket) ? tmuxReadOnly(["display-message", "-p", "#{socket_path}"]) : null;
  const callerSocket = socketProbe?.code === 0 ? socketProbe.stdout.trim() : "";
  for (const row of rows) {
    if (row.delivery !== "poll" && row.serverSocket && row.serverSocket !== callerSocket) {
      kept.push({ handle: row.handle, reason: callerSocket ? "foreign_namespace" : "socket_unobservable", pane: row.pane });
      continue;
    }
    const parked = row.status === "suspended" || row.status === "offline";
    if (options.hard && parked && !row.crew) {
      if (!hardObservable) {
        kept.push({ handle: row.handle, reason: "hard_session_unobservable", pane: row.pane });
      } else if (!row.session) {
        trimmed.push({ handle: row.handle, reason: "hard_session_missing", pane: row.pane, harness: row.harness, lastStatus: row.status });
        candidates.push(`${row.handle}${US}${row.fingerprint}`);
      } else if (hardSnapshot!.has(row.session)) {
        kept.push({ handle: row.handle, reason: "hard_session_live", pane: row.pane });
      } else {
        trimmed.push({ handle: row.handle, reason: "hard_session_absent", pane: row.pane, harness: row.harness, lastStatus: row.status });
        candidates.push(`${row.handle}${US}${row.fingerprint}`);
      }
      continue;
    }
    // NOTE the order: the hard branch above runs BEFORE this poll test, so a
    // parked poll row under --hard is a session cut, not a skip. Checking poll
    // first reads as more natural and silently stops trimming parked poll rows.
    if (row.delivery === "poll") {
      skipped.push({ handle: row.handle, reason: "poll-mode", pane: row.pane });
      continue;
    }
    // Retained crews are not expiring launch reservations, even after an interrupted resume.
    if (row.crew) {
      const [state, reason] = observation(row.handle);
      if (!options.dryRun && state === "active") {
        try { await fenceCrewLifetime(ctx, row.handle); }
        catch (error) {
          if (!(error instanceof TapError)) throw error;
          kept.push({ handle: row.handle, reason: "crew_retained:legacy_fence_refused", pane: row.pane });
          process.stderr.write(`tap team refresh: crew '${row.handle}': legacy helper transition refused: ${error.detail}; next: ${error.action}\n`);
          continue;
        }
      }
      kept.push({ handle: row.handle, reason: state === "active" ? "active" : `crew_retained:${reason || state}`, pane: row.pane });
      continue;
    }
    const pendingish = row.status === "pending"
      || (row.status === "active" && row.statusReason === "launching" && !!row.launchId);
    if (pendingish) {
      if (pendingExpired(row.session, row.registeredAt)) {
        const reason = row.status === "pending" ? "pending_expired" : "launching_expired";
        trimmed.push({ handle: row.handle, reason, pane: row.pane });
        candidates.push(`${row.handle}${US}${row.fingerprint}`);
      } else {
        const detail = pendingGrace(row.session, row.registeredAt);
        const base = row.status === "pending" ? "pending" : row.statusReason;
        if (detail.startsWith("grace:")) {
          kept.push({ handle: row.handle, reason: `${base}, expires in ~${detail.slice(6)}s`, pane: row.pane });
        } else {
          kept.push({ handle: row.handle, reason: base, pane: row.pane });
        }
      }
      continue;
    }
    if (row.status === "suspended" && row.statusReason === "server_restarted") {
      const [state, reason, observedPane] = observation(row.handle);
      if (state === "unbound") {
        if (options.dryRun) {
          kept.push({ handle: row.handle, reason: "unbound:rebind_ready", pane: observedPane });
        } else {
          rebinds.push({ handle: row.handle, pane: observedPane });
        }
      } else {
        const suffix = reason && reason !== "stored_status" ? `:${reason}` : "";
        kept.push({ handle: row.handle, reason: `${state}${suffix}`, pane: row.pane });
      }
      continue;
    }
    if (!row.pane && !row.paneId) {
      kept.push({ handle: row.handle, reason: "no-pane", pane: row.pane });
      continue;
    }
    // Only GONE is deletion authority: tmux answered one current-generation
    // snapshot and the exact name was absent. UNKNOWN preserves the row, because
    // an unobservable or conflicting identity is not proof of anything.
    const [state, reason] = observation(row.handle);
    if (state === "gone") {
      trimmed.push({ handle: row.handle, reason, pane: row.pane });
      candidates.push(`${row.handle}${US}${row.fingerprint}`);
    } else if (state === "active") {
      kept.push({ handle: row.handle, reason: "active", pane: row.pane });
    } else {
      const suffix = reason && reason !== "stored_status" ? `:${reason}` : "";
      kept.push({ handle: row.handle, reason: `${state}${suffix}`, pane: row.pane });
    }
  }

  if (candidates.length > 0 && !options.dryRun) {
    await applyTrim(ctx, candidates, trimmed, progress);
  }

  // `tap register` owns re-binding and takes the registry lock itself. Keep it
  // outside applyTrim's lock: nesting the writer would deadlock, while copying
  // its mutation here would create a second answer to registration identity.
  for (const [index, item] of rebinds.entries()) {
    progress?.phase(`Re-binding ${item.handle} (${index + 1}/${rebinds.length})`);
    if (await rebindSeat(ctx, scriptsDir, item.handle, item.pane)) {
      kept.push({ handle: item.handle, reason: "rebound:server_revived", pane: item.pane });
    } else {
      kept.push({ handle: item.handle, reason: "unbound:rebind_failed", pane: item.pane });
    }
  }

  // The strand report runs in dry-run too: the preview is the most useful moment
  // to learn that a trim would orphan unsettled mail, before it commits. It
  // REPORTS and never adopts — refresh has no successor to name.
  if (trimmed.length > 0) reportStranded(ctx, trimmed);

  // Settle ✓ before the receipt lines land on stdout.
  progress?.stop("✓");
  return render(options.json, trimmed, kept, skipped);
}

/**
 * Classify the WHOLE roster in one call, exactly as the roster view does.
 *
 * The engine is a BATCH classifier (`observe.ts` — "classifies an entire
 * roster without re-spawning per seat"), and feeding it one row at a time is not
 * merely slower: it takes a fresh tmux/process snapshot per call, so the engine's
 * pane-set coverage reconciliation runs against a different picture each time and
 * can answer differently than it does for the full set. The parity fixture caught
 * exactly that — bash kept a seat as `unknown:pane_set_unobservable` where the
 * per-row version removed it as `session_absent`, which is a live registration
 * deleted on a snapshot artifact.
 *
 * A classifier that cannot run at all is UNKNOWN, never gone: unknown keeps the
 * row, and treating an unobservable probe as death is what deletes live seats.
 */
export function observeAll(
  scriptsDir: string, rows: Row[], engine?: ObserveEngine,
): Map<string, SeatObservation> {
  const out = new Map<string, SeatObservation>();
  if (rows.length === 0) return out;
  const batch = rows.map((row) => ({
    team: "", handle: row.handle, harness: row.harness, pane: row.pane,
    status: row.status, status_reason: row.statusReason, delivery: row.delivery,
    pane_id: row.paneId, unattended: false, session: row.session,
    registered_at: row.registeredAt, crew: row.crew,
    server_epoch: row.serverEpoch, boot_id: row.bootId, preset: "",
  })) as unknown as RegistryRow[];
  // The engine seam is forwarded, not re-invented: refresh's custody rule under
  // a failed classification is the incident class this whole slice argues about
  // (a live registration deleted on an answer the courier never got), and after
  // the cutover there is no child to fail and no input that makes the in-process
  // engine refuse. A parameter is the only honest driver — the same one
  // `observe()` already carries, one level up.
  const result = observe(batch, scriptsDir, false, undefined, engine);
  for (const row of rows) {
    const fields = result.code === 0 ? result.rows.get(row.handle) : undefined;
    out.set(row.handle, fields
      ? [fields[0] ?? "unknown", fields[1] ?? "", fields[2] ?? "",
        fields[3] ?? "", fields[4] ?? "", fields[5] ?? ""]
      : ["unknown", "harness_unobservable", "", "", "", ""]);
  }
  return out;
}

/**
 * Compare-and-trim, then record what actually happened.
 *
 * THE LOCK IS THE POINT. This is a read-modify-write against a file concurrent
 * `tap in` / `tap register` also mutate, and the incumbent holds an exclusive
 * flock on `<registry>.lock` across the whole cycle. `acquireRegistryLock` takes
 * the SAME file, and both sides are BSD flock(2), so the exclusion genuinely
 * spans the two implementations during the mixed-runtime period — measured, not
 * inferred: lockf holds it and python blocks, python holds it and lockf refuses
 * with "already locked".
 *
 * A NULL LOCK IS A REFUSAL, NEVER A PROCEED. The helper times out at 5s where
 * bash blocks forever; writing unlocked because the wait was long is the silent
 * corruption this whole path exists to prevent. `send.ts` sets the precedent and
 * this reuses its error class rather than minting a second one for one null.
 *
 * The trim itself is in-process (`trimRegistryLocked`): the incumbent's child
 * needed the candidates and the survivors shuttled through scratch files, which
 * was the one symlink-following write surface this verb had. Under the lock the
 * read-modify-write is one function call, and the shuttle is gone.
 */
async function applyTrim(
  ctx: ResolvedContext,
  candidates: string[],
  trimmed: Bucketed[],
  progress: PhaseProgress | null,
): Promise<void> {
  progress?.phase("Writing changes");
  // One immediate attempt, so only a contended lock earns a wait phase. The wait
  // is async: a synchronous flock would freeze the frame timer for the full 5 s.
  // flock keeps no owner record, so the line says what is waited on, not by whom.
  let lock = await acquireRegistryLockAsync(ctx.registryPath, 0);
  if (!lock) {
    progress?.phase("Waiting for another tap command to release the registry lock");
    lock = await acquireRegistryLockAsync(ctx.registryPath, 5000);
  }
  if (!lock) {
    throw new TapError(1, "registry_lock_busy", "retry the refresh",
      `acting registry '${ctx.registryPath}' is busy; refusing to trim from an incoherent snapshot`, VERB);
  }
  let removedItems: Bucketed[] = [];
  try {
    // The trim reports what it ACTUALLY removed: a row whose fingerprint moved
    // under a racing registration was kept, and must not now be reported as
    // removed. Prune the pre-lock bucket list rather than trusting it.
    const removed = trimRegistryLocked(ctx.registryPath, candidates);
    for (let i = trimmed.length - 1; i >= 0; i--) {
      if (!removed.has(trimmed[i]!.handle)) trimmed.splice(i, 1);
    }
    removedItems = [...trimmed];
  } finally {
    // RELEASE BEFORE THE APPENDS. Each event append takes its own flock, so
    // doing them inside this one holds the registry lock across unrelated
    // contention — long enough to push another native mutator past its 5s
    // acquisition window and turn a log queue into a registry_lock_busy refusal
    // for a caller that did nothing wrong. The incumbent leaves its locked
    // python block before its event loop (tap-team.sh:695-743); this matches.
    await lock.release();
  }
  for (const item of removedItems) appendTrimEvent(ctx, item);
}

/**
 * Append one trim to the registry event log — best-effort by design.
 *
 * The incumbent warns on stderr and keeps going: an audit line that cannot be
 * written is not a reason to fail a refresh that already completed its trim, and
 * exiting nonzero here would report the whole verb as failed after the registry
 * was already rewritten.
 */
function appendTrimEvent(ctx: ResolvedContext, item: Bucketed): void {
  const action = item.crew ? "crew_collected" : "trimmed";
  appendRegistryEventOrWarn("tap team refresh", {
    log: registryEventsPath(ctx.bus.home),
    actor: "team-refresh", action, handle: item.handle, pane: item.pane, team: ctx.team,
    detail: item.crew ? `reason=${item.collectReason ?? "unknown"} parent=${item.parent ?? ""}` : "",
  });
}

/**
 * One `tap register` child per seat, the slow phase of a post-restart refresh
 * (0.5-1 s each, serial). Async so the progress line animates while it runs;
 * the children stay serial, because registration owns its own locking and
 * identity capture. A child that cannot run or is killed is a failed rebind,
 * exactly as the synchronous spawn's unusable outcome was.
 */
async function rebindSeat(
  ctx: ResolvedContext,
  scriptsDir: string,
  handle: string,
  pane: string,
): Promise<boolean> {
  const env = {
    ...process.env,
    TAP_LOCK_DIR: lockRoot(), TAP_HOME: ctx.bus.home,
    TAP_REGISTER_SUPPRESS_IDENTITY_CAPTURE: "1",
  };
  const [cmd, ...args] = verbArgv(scriptsDir, ["register", handle, "--pane", pane], env);
  let stdout = "", stderr = "", ran = false;
  try {
    const child = Bun.spawn([cmd!, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    stdout = out; stderr = err; ran = code === 0;
  } catch {
    // Not runnable: no output, no rebind.
  }
  if (!ran) {
    const detail = (stderr || stdout || "registration refused")
      .split("\n").find(Boolean) ?? "registration refused";
    process.stderr.write(`tap team refresh: warning: could not rebind '${handle}'; ${detail}\n`);
    return false;
  }
  appendRegistryEventOrWarn("tap team refresh", {
    log: registryEventsPath(ctx.bus.home),
    actor: "dispatcher", action: "server_revived", handle, pane, team: ctx.team, detail: "",
  });
  return true;
}

/**
 * Report unsettled mail a trim would strand (tap-q2v4).
 *
 * It REPORTS and never adopts: refresh has no successor to name, unlike a
 * register-release. Best-effort — a payload that cannot be read degrades to a
 * warning rather than aborting a completed refresh — and it rides STDERR in
 * both modes on purpose, so the trimmed/kept/skipped stdout and the --json
 * object stay byte-stable for parsers. Runs in dry-run too, because the preview
 * is the most useful moment to learn that a trim would orphan an obligation.
 *
 * The scan is the read-only half of seat_adopt.py's stranded-mail classifier,
 * in-process since the reporter child retired: same frontmatter grammar (python
 * str.strip, unindented `key:value`, last wins), same strict `to` match, same
 * `.done`/`.cancelled` settlement, same code-point id order, and shlex.quote
 * reproduced byte-for-byte for the cancel remedies — the two texts must stay
 * byte-equivalent (ruling 33/34, LIVE). The remedy names a command that RUNS
 * in this state (tap-fcd3's principle): the sender's cancel does, and the from
 * field is on the payload itself. No settle verb is advertised for adopted
 * instance-bound mail until tap-7r3fn.27 lands the grant.
 */

// Python str.strip() is not JS trim(): python also strips \x1c-\x1f and \x85,
// and JS also strips \ufeff. The fence and field grammar is compared under
// python's rule, because its other half still lives in seat_adopt.py.
const PY_STRIP_CHARS = "\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\x1c-\\x1f\\x85";
const PY_STRIP_RE = new RegExp(`^[${PY_STRIP_CHARS}]+|[${PY_STRIP_CHARS}]+$`, "g");

function pyStrip(value: string): string {
  return value.replace(PY_STRIP_RE, "");
}

// Python shlex.quote, byte-for-byte: the remedy strings are compared against
// the bash twin's output, so a quoting dialect of our own is not on offer.
const SHLEX_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

function pyShlexQuote(value: string): string {
  if (value === "") return "''";
  if (SHLEX_SAFE.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

// errors="replace" in python's open(): undecodable bytes become U+FFFD and a
// BOM survives, so the sender line is readable no matter what else the payload
// carries. This decoder never throws; only the file read under it can.
const REPLACING_UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * The strand report's remedy must name a command that RUNS in this state:
 * the sender's cancel does, and the from field is on the payload itself.
 * Returns the first `from:` inside the frontmatter fence, else `<sender>`.
 */
function senderOf(payloadsDir: string, id: string): string {
  try {
    // python's open() translates \r\n and \r to \n before its scan sees them
    // (universal newlines); the phantom trailing "" that split leaves is not a
    // line the file iteration would ever yield.
    let opened = false;
    const translated = REPLACING_UTF8.decode(readFileSync(join(payloadsDir, `${id}.md`))).replace(/\r\n?/g, "\n");
    const lines = translated.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    for (const line of lines) {
      const stripped = pyStrip(line);
      if (!opened) {
        if (stripped === "---") opened = true;
        continue;
      }
      if (stripped === "---") break;
      if (line.startsWith("from:")) return pyStrip(line.slice("from:".length));
    }
  } catch {
    // python catches OSError around the whole scan; same reach here.
  }
  return "<sender>";
}

function reportStranded(ctx: ResolvedContext, trimmed: Bucketed[]): void {
  // This runs AFTER the trim has committed, so nothing here may turn a
  // completed trim into a stack trace; the worst outcome it is allowed to
  // produce is a warning that the operator did not get the stranded-mail list.
  try {
    // The team name and the reclaim grants come from the post-trim registry
    // snapshot, with python's tolerance: an unreadable registry costs the
    // grants and the team name, not the whole report (the reporter used
    // plain json.load in the same bare try/except).
    let localTeam = "";
    const grantHolder = new Map<string, string>();
    try {
      // The team name and the reclaim grants come from the post-trim registry
      // snapshot, with python's tolerance: an unreadable registry costs the
      // grants and the team name, not the whole report. The reporter's plain
      // json.load ACCEPTS NaN/Infinity/-Infinity, and the trim side keeps
      // those values lossless in registries it rewrites — so this must be the
      // lossless parser, or one non-finite value anywhere would refuse the
      // whole snapshot and strand the report's team and grant knowledge.
      const reg = parseJsonPreserving(pyReadUtf8(ctx.registryPath)) as Record<string, unknown>;
      if (isDict(reg.team)) {
        // python keeps the json value AS-IS; only a string name can ever equal
        // a payload's string to_team. Coercing a numeric name would invent a
        // team match, so a non-string name means the team is simply unavailable.
        localTeam = typeof reg.team.name === "string" && pyTruthy(reg.team.name) ? reg.team.name : "";
      }
      const rawSeats = reg.seats;
      const seats = pyTruthy(rawSeats) ? rawSeats : {};
      if (isDict(seats)) {
        for (const [succ, ent] of Object.entries(seats)) {
          if (!isDict(ent)) continue;
          const grants = ent.adopted_handles;
          if (!pyTruthy(grants)) continue;
          // setdefault: FIRST successor holding a grant keeps it. A string
          // value iterates per character here exactly as it did in python.
          // Only STRING entries can match a string handle; python's int key 1
          // never equaled "1", so String() coercion must not invent that grant.
          for (const granted of grants as Iterable<unknown>) {
            if (typeof granted !== "string") continue;
            if (!grantHolder.has(granted)) grantHolder.set(granted, succ);
          }
        }
      }
    } catch {
      // Same bare except the reporter had; the report goes on without grants.
    }
    for (const { handle } of trimmed) {
      let ids: string[];
      try {
        ids = strandedIds(ctx.bus.payloadsDir, ctx.bus.receiptsDir, handle, localTeam);
      } catch (error) {
        // The retired Bash reporter shelled out to a `bun ... stranded` child
        // and treated any non-zero exit or malformed stdout as "unknown, not
        // proven empty" (a distinct warning from a proven-empty result). Now
        // in-process, the analogous failure is eligibleIds's directory scan
        // throwing (e.g. EACCES on the payloads dir) instead of returning []
        // — same distinction, same warning text. Only StrandScanFailure means
        // that; anything else (e.g. a per-payload frontmatter decode throw)
        // must keep escaping to this function's own outer catch, which is the
        // report's designed degraded-warning boundary (team.test.ts's
        // "an unreadable payload degrades the report without overturning the
        // trim").
        if (!(error instanceof StrandScanFailure)) throw error;
        process.stderr.write(
          `tap team refresh: WARNING: stranded-payload scan failed for '${handle}' (transport failure); stranded set unknown, not claiming it empty\n`,
        );
        continue;
      }
      if (ids.length === 0) continue;
      const idList = ids.join(", ");
      const cancels = ids
        .map((id) => `tap cancel ${pyShlexQuote(id)} --by ${pyShlexQuote(senderOf(ctx.bus.payloadsDir, id))}`)
        .join("; ");
      const succ = grantHolder.get(handle);
      let next: string;
      if (succ) {
        // A prior register-release adoption already granted this handle to a
        // live seat; honor that grant instead of claiming no path exists — but
        // advertise only what runs today: locally adopted instance-bound mail
        // refuses read/reply/done, so the executable door is the sender's
        // cancel per stranded id, and the adoption-aware settle surface is
        // named by its bead.
        next = `successor '${succ}' holds the reclaim grant — the sender clears each stranded id (${cancels}); the adoption-aware settle path lands with bead tap-7r3fn.27`;
      } else {
        next = `the sender clears each stranded id (${cancels}), or re-register a seat as '${handle}' (tap in reclaims the handle and adopts this mail)`;
      }
      process.stderr.write(
        `tap team refresh: WARNING: trimming '${handle}' strands ${ids.length} unsettled payload(s) addressed to it: ${idList}. ${next}.\n`,
      );
    }
  } catch {
    // THE ROW IS ALREADY GONE, so a degraded report costs the operator the
    // only list of what the trim stranded — not the trim. The reason is the
    // reporter's stable exit shape, `(exit 1)`, in both runtimes: the child
    // crashed with exit 1, and the in-process failure stands in for that
    // crash instead of leaking its own stack text.
    process.stderr.write(
      "tap team refresh: warning: the stranded-mail report did not complete — " +
      "trimmed rows may have unsettled payloads this run did not name (exit 1)\n",
    );
  }
}

function renderEmpty(json: boolean): number {
  if (json) process.stdout.write('{"trimmed":[],"skipped":[],"kept":[]}\n');
  else process.stdout.write("tap team refresh: nothing to refresh\n");
  return 0;
}

// The prose maps are PRETTIFIERS, not filters: an unmapped reason prints raw
// rather than being dropped, so a new classifier state degrades to a visible
// token instead of a silently missing line.
const REMOVED_PROSE: Record<string, string> = {
  pane_gone: "its pane is gone",
  pane_recycled: "its pane was recycled",
  session_absent: "its exact session is absent from the current tmux server",
  pending_expired: "its pending launch expired",
  launching_expired: "its launch expired",
  hard_session_absent: "its exact session is absent from the current tmux namespace",
  hard_session_missing: "it has no session name that could still be live",
};
const KEPT_PROSE: Record<string, string> = {
  active: "pane is active",
  pending: "it is pending",
  launching: "it is launching",
  "no-pane": "it has no pane",
  unobservable: "its pane could not be probed (tmux unobservable), which is not proof it is dead",
  hard_session_live: "its exact session is still live",
  hard_session_unobservable: "the tmux session namespace is unobservable, which is not deletion authority",
  "rebound:server_revived": "its binding was restored after server revival",
  "unbound:rebind_ready": "its binding can be restored after server revival",
  "unbound:rebind_failed": "its binding is still lost because re-registration refused",
};

function jsonItem(item: Bucketed): Record<string, string> {
  const out: Record<string, string> = { handle: item.handle, reason: item.reason, pane: item.pane };
  // harness/last_status ride together and ONLY when one is non-empty — the
  // incumbent adds both keys or neither, so a consumer never sees a half pair.
  if (item.harness || item.lastStatus) {
    out.harness = item.harness ?? "";
    out.last_status = item.lastStatus ?? "";
  }
  return out;
}

function render(json: boolean, trimmed: Bucketed[], kept: Bucketed[], skipped: Bucketed[]): number {
  if (json) {
    // ASCII-ESCAPED, because the incumbent's renderer is python's `json.dumps`
    // with its default `ensure_ascii=True`. Without this wrapper the two
    // runtimes emit DIFFERENT BYTES for the same registry, which is the one
    // thing this verb's contract says cannot happen.
    //
    // MEASURED on a seat whose session is `café/seat`:
    //   bash    {"handle":"caf\u00e9-seat",...,"pane":"caf\u00e9:0.0"}
    //   native  {"handle":"café-seat",...,"pane":"café:0.0"}
    // Byte-compared: bash has zero bytes >= 0x80, native has them. Note the
    // divergence rides USER-CONTROLLED strings (handles, session names, panes),
    // so it is reachable by naming a session rather than by any rare state.
    //
    // The refusal renderer above and the roster renderer in team.ts already
    // wrap; this one was the site that did not, and no parity scenario carried a
    // non-ASCII registry, so nothing reddened. A scenario now does.
    //
    // This wrapper closes the measured divergence for every code point python's
    // ensure_ascii escapes: `ensureAscii` covers U+007F too, tap-u2nfe having
    // closed the gap that once left it raw.
    process.stdout.write(
      `${ensureAscii(JSON.stringify({
        trimmed: trimmed.map(jsonItem),
        skipped: skipped.map(jsonItem),
        kept: kept.map(jsonItem),
      }))}\n`,
    );
    return 0;
  }
  for (const item of trimmed) {
    const receipt = item.harness !== undefined || item.lastStatus !== undefined
      ? ` (harness=${item.harness || "unknown"}, last_status=${item.lastStatus || "unknown"})`
      : "";
    let prose = REMOVED_PROSE[item.reason];
    if (!prose && item.reason.startsWith("crew_collected:")) {
      prose = item.reason.includes("reason=pane_dead") ? "crew pane is not live"
        : item.reason.includes("reason=server_restarted") ? "crew pane cannot survive a server restart"
        : item.reason;
    }
    process.stdout.write(
      `tap team refresh: removed '${item.handle}'${receipt} because ${prose ?? item.reason}\n`,
    );
  }
  for (const item of kept) {
    const idx = item.reason.indexOf(", expires in ~");
    if (idx >= 0) {
      const state = item.reason.slice(0, idx);
      const expiry = item.reason.slice(idx + 2);
      process.stdout.write(`tap team refresh: kept '${item.handle}'; ${KEPT_PROSE[state] ?? state} and ${expiry}\n`);
    } else {
      process.stdout.write(`tap team refresh: kept '${item.handle}'; ${KEPT_PROSE[item.reason] ?? item.reason}\n`);
    }
  }
  for (const item of skipped) {
    if (item.reason === "poll-mode") {
      process.stdout.write(`tap team refresh: skipped '${item.handle}'; it uses poll delivery\n`);
    } else {
      process.stdout.write(`tap team refresh: skipped '${item.handle}'; ${item.reason}\n`);
    }
  }
  if (trimmed.length === 0 && kept.length === 0 && skipped.length === 0) {
    process.stdout.write("tap team refresh: nothing to refresh\n");
  }
  return 0;
}
