// The parked entry's METADATA lifecycle — the sidecar read-modify-writes the
// courier performs between publication (`spool-publication.ts`) and removal
// (`spool-sidecar.ts`), plus the live-sidecar listing every drain walks. Lane A,
// batch 2, slice A1b (U2 + U4). Each writer keeps the incumbent's OWN lock
// discipline and byte contract, because they differ on purpose:
//
//   writer                | lock                          | bytes
//   ----------------------|-------------------------------|---------------------------
//   scheduleProbe         | blocking `<meta>.lock`        | json.dump default, no `\n`, fixed `<meta>.tmp`
//   noteBusyProbe         | NONE                          | sorted indent-2 + `\n`, mkstemp `.tap-meta.`
//   noteLiveProbe         | bounded poll (0.5 s), skip    | sorted indent-2 + `\n`, mkstemp `.tap-meta.`
//   updateHeldVisits      | one non-blocking try, skip    | sorted indent-2 + `\n`, mkstemp `.tap-held-visit-`
//   markLegacyNoBinding   | blocking `<meta>.lock`        | sorted indent-2 + `\n`, mkstemp `.tap.`
//
// "Blocking" is bounded here (`METADATA_LOCK_TIMEOUT_MS`, the same bound
// publication took) where `fcntl.flock(LOCK_EX)` waited forever — a
// declared delta. The lock is the kernel-lock transport over the same
// `<meta>.lock` file the Python sidecars flock, so mixed writers still exclude.
import { closeSync, existsSync, openSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";

import { physicalPath } from "./clear-fence";

import { appendRegistryEventOrWarn } from "./events";
import { acquirePathLock } from "./panelock";
import { METADATA_LOCK_TIMEOUT_MS, PyFloat, PyInt, isDict, jsonDumpBytes, metaBytes, parseJsonPreserving, pyFloatString, pyReadUtf8, pyStrCompare, pyTruthy } from "./spool-publication";
import { pythonInt } from "./pyint";
import { pyPrint } from "./spool-sidecar";
import { metaPath, payloadPath } from "./spool-sidecar";
import { lockNameFits } from "./fsatomic";

/** A sidecar the incumbent could `json.load` into a dict; anything else is "no metadata" to every writer here. */
function readMetaDict(path: string): Record<string, unknown> | null {
  try {
    const parsed = parseJsonPreserving(pyReadUtf8(path));
    return isDict(parsed) ? parsed : null;
  } catch { return null; }
}

/**
 * Python `int(<json value>)` EXACTLY — a bigint, so a counter or epoch past 2^53
 * keeps its digits (`Number()` narrowed 9007199254740993 to …992
 * and `+1` produced …992 where Python wrote …994). Bools are 0/1, floats truncate
 * toward zero, strings parse as `int()` does (whitespace, sign, single underscores),
 * a PyInt is its source digits; anything else RAISES (null here).
 */
function pyIntExact(value: unknown): bigint | null {
  if (value instanceof PyInt) return BigInt(value.source);
  if (value instanceof PyFloat) return Number.isFinite(value.value) ? BigInt(Math.trunc(value.value)) : null;
  if (typeof value === "boolean") return value ? 1n : 0n;
  if (typeof value === "number") return Number.isFinite(value) ? BigInt(Math.trunc(value)) : null;
  if (typeof value === "string") return pythonInt(value, true);
  return null;
}
/** A bigint back into the sidecar: a safe integer as a number, a wide one as its digits (`PyInt`) — the same bytes either way. */
function intValue(n: bigint): number | PyInt {
  return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : new PyInt(n.toString());
}
/** Python `int(meta.get(key) or 0)`: falsy → 0, else `int()` — which RAISES (null here) on `"3.0"`, a list, … */
function counterOf(meta: Record<string, unknown>, key: string): bigint | null {
  const value = meta[key];
  return pyTruthy(value) ? pyIntExact(value) : 0n;
}

/** `tempfile.mkstemp(dir, prefix)` + write + `os.replace`: the sorted-indent-2 sidecar writers' shape. */
function replaceSortedIndent2(path: string, meta: Record<string, unknown>, prefix: string): void {
  const dir = dirname(path) || ".";
  const tmp = join(dir, `${prefix}${process.pid.toString(36)}${Math.random().toString(36).slice(2, 10)}`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try { writeFileSync(fd, metaBytes(meta as Record<string, never>)); } finally { closeSync(fd); }
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
}

// --- scheduleProbe ----------------------------------------------------------
/**
 * `tap_spool_schedule_probe <id> <delay>`: record the actual scheduled sleep
 * as `next_probe_epoch = time.time() + float(delay)` under a blocking meta
 * lock, written with `json.dump`'s DEFAULT bytes to the fixed `<meta>.tmp`.
 * `false` where the incumbent exited 1 (unreadable meta, bad delay, IO).
 */
export function scheduleProbe(spoolDir: string, id: string, delay: string, now: number = Date.now() / 1000, env: NodeJS.ProcessEnv = process.env): boolean {
  const path = metaPath(spoolDir, id);
  const seconds = pyFloatString(delay);
  // A lock NAME the filesystem cannot hold: the incumbent's open() raised ENAMETOOLONG at once
  // (exit 1); the helper's refusal is not observable inside the bounded wait, so preflight it
  // (the sidecar family's `lockNameFits`) rather than stall the full bound on every probe.
  if (!lockNameFits(`${path}.lock`)) return false;
  const lock = acquirePathLock(`${path}.lock`, METADATA_LOCK_TIMEOUT_MS, env);
  if (!lock) return false;
  try {
    let meta: unknown;
    try { meta = parseJsonPreserving(pyReadUtf8(path)); } catch { return false; }
    // Python: `meta['next_probe_epoch'] = …` on a non-dict raises TypeError, which is NOT in the
    // caught (OSError, ValueError) set — an uncaught exception is still exit 1 to the caller.
    if (!isDict(meta)) return false;
    if (seconds === null) return false;
    // `time.time() + float(delay)` is a float even when whole: Python writes `…235.0`.
    meta.next_probe_epoch = new PyFloat(now + seconds);
    const tmp = `${path}.tmp`;
    try {
      writeFileSync(tmp, jsonDumpBytes(meta));
      renameSync(tmp, path);
    } catch { return false; }
    return true;
  } finally { lock.release(); }
}

// --- noteBusyProbe -------------------------------------------------------------
/**
 * Only `busy:pending` counts. Unlocked read-modify-write; failures are silent.
 */
export function noteBusyProbe(spoolDir: string, id: string, detail: string, now: number = Date.now() / 1000): void {
  const path = metaPath(spoolDir, id);
  if (!isFile(path)) return;
  if (detail !== "busy:pending") return;
  const meta = readMetaDict(path);
  if (!meta) return;
  const count = counterOf(meta, "busy_pending_probes");
  if (count === null) return;
  meta.busy_pending_probes = intValue(count + 1n);
  meta.last_busy_probe_at = Math.trunc(now);
  meta.last_busy_probe_detail = "busy:pending";
  try { replaceSortedIndent2(path, meta, ".tap-meta."); } catch { /* the incumbent swallowed every failure */ }
}

// --- noteLiveProbe --------------------------------------------------------------
const LIVE_PROBE_DETAILS = new Set(["busy", "busy:noprompt", "busy:pending", "busy:in-turn"]);

/**
 * `tap_spool_note_live_probe <id> <ready-detail>`: a live look at a pane that
 * refused, counted under a BOUNDED wait for the meta lock — the deadline exits
 * without counting (a skipped increment delays a force by one drain; a double
 * increment would force early). `timeoutSeconds` is `tap_spool_probe_lock_timeout`.
 */
export function noteLiveProbe(spoolDir: string, id: string, detail: string, timeoutSeconds: string, now: number = Date.now() / 1000, env: NodeJS.ProcessEnv = process.env): void {
  const path = metaPath(spoolDir, id);
  if (!isFile(path)) return;
  if (!LIVE_PROBE_DETAILS.has(detail)) return;
  let timeout = pyFloatString(timeoutSeconds);
  // `inf`/`1e309` parse to Infinity: the incumbent then waited without bound; the helper refuses a
  // non-numeric `--timeout` and the bounded loop would never observe it — a misconfigured seam
  // must not hang every live probe, so a non-finite bound is the default (declared).
  if (timeout === null || !Number.isFinite(timeout)) timeout = 0.5;
  if (!lockNameFits(`${path}.lock`)) return;
  // The kernel-lock helper's granularity is whole seconds: a 0.5 s bound waits up to 1 s (declared).
  const lock = acquirePathLock(`${path}.lock`, Math.max(0, Math.ceil(timeout * 1000)), env);
  if (!lock) return;
  try {
    const meta = readMetaDict(path);
    if (!meta) return;
    const count = counterOf(meta, "busy_live_probes");
    if (count === null) return;
    meta.busy_live_probes = intValue(count + 1n);
    meta.last_live_probe_at = Math.trunc(now);
    meta.last_live_probe_detail = detail;
    try { replaceSortedIndent2(path, meta, ".tap-meta."); } catch { /* silent, as the incumbent */ }
  } finally { lock.release(); }
}

/** `tap_spool_live_probes <id>`: the counter's digits (exact past 2^53), or 0 for anything unreadable. */
export function liveProbes(spoolDir: string, id: string): string {
  const meta = readMetaDict(metaPath(spoolDir, id));
  if (!meta) return "0";
  const count = counterOf(meta, "busy_live_probes");
  return count === null ? "0" : count.toString();
}

// --- updateHeldVisits -------------------------------------------------------------
/**
 * Fairness accounting that never waits: one non-blocking try on the meta lock,
 * skipping on contention.
 * Returns 2 for an unknown action (the incumbent's rc), 0 otherwise.
 */
export function updateHeldVisits(spoolDir: string, id: string, action: string, env: NodeJS.ProcessEnv = process.env): number {
  if (action !== "increment" && action !== "clear") return 2;
  const path = metaPath(spoolDir, id);
  if (!isFile(path)) return 0;
  if (!lockNameFits(`${path}.lock`)) return 0;
  const lock = acquirePathLock(`${path}.lock`, 0, env);
  if (!lock) return 0;
  try {
    const meta = readMetaDict(path);
    if (!meta) return 0;
    if (action === "increment") {
      const count = counterOf(meta, "held_drain_visits");
      if (count === null) return 0;
      meta.held_drain_visits = intValue(count + 1n);
    } else if (Object.hasOwn(meta, "held_drain_visits")) {
      delete meta.held_drain_visits;
    } else {
      return 0;
    }
    try { replaceSortedIndent2(path, meta, ".tap-held-visit-"); } catch { /* silent */ }
    return 0;
  } finally { lock.release(); }
}

// --- markLegacyNoBinding -----------------------------------------------------------
/**
 * `tap_spool_mark_legacy_no_binding <id>`: the fail-closed upgrade marker. Keeps
 * the predecessor reason (`original_reason` once, `reason_history` bounded to
 * 16) so the mark stops destroying its own diagnosis (tap-6vwz), and appends
 * the `spool_marked_unroutable` registry event only on a REAL transition.
 * `eventLog`/`team` are the facts `tap_registry_event_append` resolved.
 */
export function markLegacyNoBinding(spoolDir: string, id: string, eventLog: string, team: string, verbLabel: string, now: Date = new Date(), env: NodeJS.ProcessEnv = process.env, lockTimeoutMs = METADATA_LOCK_TIMEOUT_MS): void {
  const path = metaPath(spoolDir, id);
  if (!isFile(path)) return;
  // A bounded refusal is no transition, so no event (the incumbent read the
  // predecessor before its unbounded lock; with a bound, an event from that read could claim a
  // transition that never happened). The event is appended only once the guarded replacement
  // completed, naming the reason it displaced — the VALUE as stored (`True`, `2` stay values in
  // `original_reason`/history), spelled the way Python's `print` spelled it in the event.
  if (!lockNameFits(`${path}.lock`)) return;
  const lock = acquirePathLock(`${path}.lock`, lockTimeoutMs, env);
  if (!lock) return;
  let displaced: unknown = null;
  try {
    const meta = readMetaDict(path);
    if (!meta || meta.reason === "legacy_meta_no_binding") return;
    // Python `meta.get("reason") or ""`: a falsy value reads as "".
    const prior: unknown = pyTruthy(meta.reason) ? meta.reason : "";
    const priorClass: unknown = pyTruthy(meta.reason_class) ? meta.reason_class : "";
    if (prior !== "" && !Object.hasOwn(meta, "original_reason")) {
      meta.original_reason = prior;
      meta.original_reason_class = priorClass;
    }
    if (prior !== "") {
      const history = Array.isArray(meta.reason_history) ? meta.reason_history : [];
      history.push({ reason: prior, reason_class: priorClass, replaced_by: "legacy_meta_no_binding", at: isoSeconds(now) });
      meta.reason_history = history.slice(-16);
    }
    meta.reason = "legacy_meta_no_binding";
    meta.reason_class = "safety_gate";
    try { replaceSortedIndent2(path, meta, ".tap."); } catch { return; /* no replacement, no transition, no event */ }
    if (prior !== "") displaced = prior;
  } finally { lock.release(); }
  if (displaced !== null) {
    appendRegistryEventOrWarn(verbLabel, {
      log: eventLog, actor: "courier", action: "spool_marked_unroutable", handle: id, pane: "", team,
      detail: `id=${id} from_reason=${pyPrint(displaced)} to_reason=legacy_meta_no_binding`, env, lockTimeoutMs,
    });
  }
}
/** `time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())`. */
function isoSeconds(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// --- blockedOrExempt ----------------------------------------------------------------
/**
 * `tap_spool_blocked_or_exempt <handle>`: is the handle in the watcher's
 * `blocked_map` or `blocked_exempt`? The two JSON facts come from the arm
 * record (`tap_watch_field`, W's); unparseable → empty, as the incumbent.
 */
export function blockedOrExempt(handle: string, blockedMap: string, blockedExempt: string): boolean {
  let map: unknown = {}, exempt: unknown = [];
  try { map = JSON.parse(blockedMap || "{}"); } catch { map = {}; }
  try { exempt = JSON.parse(blockedExempt || "[]"); } catch { exempt = []; }
  // `handle in m or handle in e`: a TypeError on the FIRST operand raised out of the program
  // (exit 1, "not blocked") without consulting the exemption — `null` here is that raise.
  const inMap = pyIn(handle, map);
  if (inMap === null || inMap) return inMap ?? false;
  return pyIn(handle, exempt) ?? false;
}
/** Python `x in container` over what `json.loads` returns; `null` where `in` raises (int/float/bool/None). */
function pyIn(needle: string, container: unknown): boolean | null {
  if (Array.isArray(container)) return container.includes(needle);
  if (isDict(container)) return Object.hasOwn(container, needle);
  if (typeof container === "string") return container.includes(needle);
  return null;
}

// --- listEntries -------------------------------------------------------------------------
export interface SpoolRow {
  id: string; target: string; team: string; reason: string; reason_class: string; timeout_seconds: unknown;
  attempts: number | PyInt; held_drain_visits: number | PyInt; first_spooled: string; first_spooled_epoch: unknown;
  pane: string; pane_id: string; to_team: string; target_registry: string; policy: string;
  deadline_epoch: unknown; deadline_source: string; hold_until_epoch: unknown; escalated_at: string;
  path: string; meta: string; incomplete: boolean;
}

/**
 * `tap_spool_list [target] [target_registry]`: one row per live id (a `.md` or
 * a `.meta.json`), oldest `first_spooled_epoch` first, ties and untimestamped
 * entries by id; optionally scoped to one target on one registry. The row's
 * defaults are Python's `or` — a present falsy value takes the default.
 */
export function listEntries(spoolDir: string, scopeTarget = "", scopeRegistry = ""): SpoolRow[] {
  if (!isDir(spoolDir)) return [];
  if (scopeTarget && !scopeRegistry) return [];
  let registryReal = "";
  if (scopeRegistry) registryReal = pyRealpath(scopeRegistry);
  const ids = new Set<string>();
  for (const name of readdirSync(spoolDir)) {
    // `glob.glob("*.md")` / `("*.meta.json")`: dotfiles excluded, as glob does.
    if (name.startsWith(".")) continue;
    if (name.endsWith(".md")) ids.add(name.slice(0, -3));
    else if (name.endsWith(".meta.json")) ids.add(name.slice(0, -10));
  }
  const keyed = [...ids].map(ident => {
    // `int(json.load(fh).get("first_spooled_epoch"))`: absent/None/junk → the except → inf (null here, sorted last).
    let first: bigint | null = null;
    const meta = readMetaDict(metaPath(spoolDir, ident));
    if (meta) {
      const value = meta.first_spooled_epoch;
      first = value === undefined || value === null ? null : pyIntExact(value);
    }
    return { ident, first };
  });
  keyed.sort((a, b) => {
    if (a.first === b.first || (a.first !== null && b.first !== null && a.first === b.first)) return pyStrCompare(a.ident, b.ident);
    if (a.first === null) return 1;
    if (b.first === null) return -1;
    return a.first < b.first ? -1 : a.first > b.first ? 1 : pyStrCompare(a.ident, b.ident);
  });
  const rows: SpoolRow[] = [];
  for (const { ident } of keyed) {
    const payload = payloadPath(spoolDir, ident);
    const mp = metaPath(spoolDir, ident);
    let meta: Record<string, unknown> = {};
    let metaRead = false;
    // DECLARED DELTA: a sidecar that parses to a non-dict was "read" (meta_read = True) and then
    // every `.get` raised, so the incumbent printed the rows sorted BEFORE it and crashed —
    // one corrupt sidecar hid the rest of the queue from every drain. Here it is a row with
    // the defaults (a document with no keys), INCOMPLETE, and the listing completes.
    try {
      const parsed = parseJsonPreserving(pyReadUtf8(mp));
      // A document with no keys is NOT a read sidecar: the row must stay `incomplete`
      // so the drain projection excludes it (a row admitted with an
      // empty binding selects the no-binding marker against a sidecar repaired later).
      metaRead = isDict(parsed);
      meta = isDict(parsed) ? parsed : {};
    } catch { meta = {}; }
    if (scopeTarget) {
      const registry = meta.target_registry;
      if (meta.target !== scopeTarget || typeof registry !== "string" || !registry || pyRealpath(registry) !== registryReal) continue;
    }
    const attempts = intOrZero(meta.attempts);
    const held = intOrZero(meta.held_drain_visits);
    rows.push({
      id: orDefault(meta.id, ident) as string,
      target: orDefault(meta.target, "") as string,
      team: orDefault(meta.team, "") as string,
      reason: orDefault(meta.reason, "unknown") as string,
      reason_class: orDefault(meta.reason_class, "busy") as string,
      timeout_seconds: meta.timeout_seconds ?? null,
      attempts, held_drain_visits: held,
      first_spooled: orDefault(meta.first_spooled, "") as string,
      first_spooled_epoch: meta.first_spooled_epoch ?? null,
      pane: orDefault(meta.pane, "") as string,
      pane_id: orDefault(meta.pane_id, "") as string,
      to_team: orDefault(meta.to_team, "") as string,
      target_registry: orDefault(meta.target_registry, "") as string,
      policy: orDefault(meta.policy, "standard") as string,
      deadline_epoch: meta.deadline_epoch ?? null,
      deadline_source: orDefault(meta.deadline_source, "") as string,
      hold_until_epoch: meta.hold_until_epoch ?? null,
      escalated_at: orDefault(meta.escalated_at, "") as string,
      path: payload, meta: mp,
      incomplete: !(existsSync(payload) && metaRead),
    });
  }
  return rows;
}

/** Python `int(meta.get(k, 0))` with `except: 0` — exact digits past 2^53. */
function intOrZero(value: unknown): number | PyInt {
  if (value === undefined) return 0;
  const parsed = value === null ? null : pyIntExact(value);
  return parsed === null ? 0 : intValue(parsed);
}
/** Python `meta.get(k) or default`. */
function orDefault(value: unknown, fallback: unknown): unknown {
  if (value === undefined || value === null || value === false || value === 0 || value === "") return fallback;
  if (Array.isArray(value) && value.length === 0) return fallback;
  if (isDict(value) && Object.keys(value).length === 0) return fallback;
  return value;
}
/**
 * `os.path.realpath(strict=False)`: a DANGLING link is followed to its target's
 * name, absent components kept lexically — S's `physicalPath` (clear-fence.ts),
 * the walker this file adopted; the longest-existing-prefix approximation this
 * replaced compared a dangling link's own name.
 */
function pyRealpath(path: string): string {
  return physicalPath(path);
}

function isFile(path: string): boolean { try { return statSync(path).isFile(); } catch { return false; } }
function isDir(path: string): boolean { try { return statSync(path).isDirectory(); } catch { return false; } }
/** `os.access(dir, R_OK)`. */
export function dirReadable(path: string): boolean { try { accessSync(path, constants.R_OK); return true; } catch { return false; } }

// --- CLI (the adapters' door) ----------------------------------------------------------------
//   schedule-probe <spool> <id> <delay>                 → scheduled | refused (a verdict at exit 0)
//   note-busy-probe <spool> <id> <detail>
//   note-live-probe <spool> <id> <detail> <timeout-seconds>
//   live-probes <spool> <id>
//   update-held-visits <spool> <id> <increment|clear>
//   mark-legacy-no-binding <spool> <id> <event-log> <team> <verb-label>
//   blocked-or-exempt <handle> <blocked-map-json> <blocked-exempt-json>   → blocked | clear
//   list <spool> [target] [target_registry]                → rows, then `#spool-state list complete`
export function main(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  const [verb, ...a] = argv;
  const now = env.TAP_SPOOL_NOW && /^[0-9]+$/.test(env.TAP_SPOOL_NOW) ? Number(env.TAP_SPOOL_NOW) : Date.now() / 1000;
  switch (verb) {
    // Decided outcomes are verdicts at exit 0: the adapter boundary reports every nonzero exit
    // as `slice_failed`, and a refused schedule or an unblocked handle is routine, not a failure.
    case "schedule-probe": process.stdout.write(scheduleProbe(a[0] ?? "", a[1] ?? "", a[2] ?? "", now, env) ? "scheduled" : "refused"); return 0;
    case "note-busy-probe": noteBusyProbe(a[0] ?? "", a[1] ?? "", a[2] ?? "", now); return 0;
    case "note-live-probe": noteLiveProbe(a[0] ?? "", a[1] ?? "", a[2] ?? "", a[3] ?? "0.5", now, env); return 0;
    case "live-probes": process.stdout.write(`${liveProbes(a[0] ?? "", a[1] ?? "")}\n`); return 0;
    case "update-held-visits": return updateHeldVisits(a[0] ?? "", a[1] ?? "", a[2] ?? "", env);
    case "mark-legacy-no-binding": markLegacyNoBinding(a[0] ?? "", a[1] ?? "", a[2] ?? "", a[3] ?? "", a[4] ?? "tap", new Date(now * 1000), env); return 0;
    case "blocked-or-exempt": process.stdout.write(blockedOrExempt(a[0] ?? "", a[1] ?? "", a[2] ?? "") ? "blocked" : "clear"); return 0;
    case "list": {
      for (const row of listEntries(a[0] ?? "", a[1] ?? "", a[2] ?? "")) process.stdout.write(`${jsonRow(row)}\n`);
      // The listing's completion marker is its verdict: an EMPTY answer from a runtime that
      // exited 0 having written nothing must be refused by the adapter, not read as "no
      // entries" (digest-outcome's empty-runtime arm). The adapter strips it; consumers
      // see exactly the incumbent's rows.
      process.stdout.write(`${LIST_COMPLETE}\n`);
      return 0;
    }
    default:
      process.stderr.write(`tap spool-state: unknown subcommand '${verb ?? ""}'\n`);
      return 1;
  }
}

export const LIST_COMPLETE = "#spool-state list complete";

/** `json.dumps(row, separators=(",", ":"))`: compact, non-ASCII escaped, Python float/int spellings. */
function jsonRow(row: SpoolRow): string {
  return jsonDumpBytes(row as unknown as Record<string, unknown>, { item: ",", key: ":" });
}

// Let the rows drain: a forced exit cuts a pending pipe write at 64 KiB (the
// drain rule: 250 pairs through a slow pipe = 122 rows, exit 0,
// and both drain projections skip the torn tail without a failed status). A
// reader that went away surfaces on the stream after `main` returns: exit 1, one line.
if (import.meta.main) {
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    process.stderr.write(`tap spool-state: stdout ${error.code ?? error.message}\n`);
    process.exitCode = 1;
  });
  process.exitCode = main(process.argv.slice(2));
}
