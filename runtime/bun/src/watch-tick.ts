// The watch tick's pure programs (slice W2c-1): the nine python programs the
// Bash tick forked -- each a decision over strings the tick already held --
// as functions over the same strings, measured against the deleted programs
// RUN verbatim through the ported module (test/watch-tick-programs.test.ts). Byte parity
// where the program's inputs are the ones the tick writes; where python's
// semantics for a value nobody writes would be a second engine (a set of
// mixed scalars sorted, a container printed by repr), the port refuses with a
// thrown error the caller renders as one `tap watch:` line (R2b class).
//
// The programs, by the tap-watch.sh line they occupied at f6be3e855:
//   :663  the registry's active rows for the roster snapshot        activeSeatRows
//   :814  the activity floor: max(floor, clamp(now, ...)) and real  activityFloor
//   :888  the blocked map's keys as a JSON list                     blockedKeysJson
//   :893  the rung skip-set: probed ∪ blocked keys ∪ touched        skipSetJson
//   :912  a real wedge outside the blocked/exempt sets              realWedge
//   :951  is the rung in blocked_exempt (exit status)               isExempt
//   :193  the probe courier's JSON receipt, seven fields            probeReceipt
//   :276  the blocked-banner ladder over a pane transcript          classifyBlockedTranscript
//   :294  a 12h clock + tz name -> the next epoch it occurs         parseResetEpoch

import { readFileSync } from "node:fs";

import { PY_SPACE } from "./events";
import { pyStrCompare } from "./spool-publication";
import { cmdSubst, dumps, isMap, loads, pyIntArg, pyStr, pyTruthy, pyTypeName, type JsonMap, type JsonValue } from "./watch-detect";

const PY_WS = new RegExp(`${PY_SPACE}+`, "gu");
const PY_STRIP = new RegExp(`^${PY_SPACE}+|${PY_SPACE}+$`, "gu");
/** python `str.strip()`. */
const pyStrip = (s: string): string => s.replace(PY_STRIP, "");

// --- :663 the registry's active rows -----------------------------------------------------

/** The eleven fields the roster snapshot reads from a seat, in the tick's `read` order. */
export const SEAT_ROW_FIELDS = ["status", "delivery", "pane", "pane_id", "session", "registered_at", "server_epoch", "boot_id", "harness", "status_reason"] as const;

/**
 * `registry_v20._seat_map(load_state_doc(reg))`: `seats` when it is an object, else
 * `agents` when it is, else `{}`; `load_state_doc` raised on a readable non-object
 * (the caller's `except Exception: sys.exit(0)` -- no rows) and on unreadable JSON.
 * A missing file was `{}`; the caller passes null for that.
 */
export function seatMapOf(docText: string | null): JsonMap {
  if (docText === null) return new Map();
  let doc: JsonValue;
  try { doc = loads(docText); } catch { return new Map(); }
  if (!isMap(doc)) return new Map();
  const m = doc.get("seats");
  return isMap(m) ? m : new Map();
}

/**
 * The rows the snapshot's python printed: every seat whose entry is an object and
 * whose `status` is absent or exactly "active", as `[handle, status, delivery, pane,
 * pane_id, session, registered_at, server_epoch, boot_id, harness, status_reason]`,
 * each value `str(v or "")` -- a falsy value ("" / null / 0 / false / an empty
 * container) is "", a string is itself, anything else its python repr.
 * `status` and `delivery` default to "active" / "pane" when absent (only when
 * absent: a present null is falsy and prints "", as python did).
 *
 * Printing stops where python's `print` would have raised: a field holding a lone
 * surrogate cannot be encoded, so the rows before it are returned and `error` names
 * the row -- the tick's `while read < <(python ...)` consumed the partial roster in
 * both shapes (a process substitution's status is never checked), which the caller
 * reproduces by printing `rows` and then the one `tap watch:` line.
 */
export function activeSeatRows(docText: string | null): { rows: string[][]; error: string | null } {
  const rows: string[][] = [];
  for (const [handle, ent] of seatMapOf(docText)) {
    if (!isMap(ent)) continue;
    const status = ent.has("status") ? ent.get("status") : "active";
    if (status !== "active") continue;
    const row: string[] = [strOrEmpty(handle)];
    for (const field of SEAT_ROW_FIELDS) {
      const fallback = field === "status" ? "active" : field === "delivery" ? "pane" : undefined;
      const v = ent.has(field) ? ent.get(field) : fallback;
      row.push(strOrEmpty(v));
    }
    const bad = row.find((f) => !f.isWellFormed());
    if (bad !== undefined) return { rows, error: `'utf-8' codec can't encode a lone surrogate in the row for ${JSON.stringify(handle)}` };
    rows.push(row);
  }
  return { rows, error: null };
}

/**
 * `load_state_doc`'s read: a missing path was `{}`; any other failure to open or
 * decode -- a directory, an unreadable file, a byte that is not UTF-8 (python's
 * `open()` decoded strictly and raised) -- was the caller's `except Exception:
 * sys.exit(0)`: no rows, silently. Null stands for all of them here. A leading
 * byte-order mark stays in the text (`ignoreBOM`): python's `open()` kept it and
 * `json.load` refused the document, so the reader must see it too.
 */
/**
 * A dischargeable pane-backed seat right now (formerly lib.sh
 * `tap_registry_active_pane`): registered, `status` active (absent reads as
 * active), not launching, `delivery` not poll, and a truthy `pane`. Absent,
 * unreadable or malformed rows are not active. Goalie's feeder/observer
 * reachability and its wake-seat target share this one rule.
 */
export function activePane(registryPath: string, handle: string): boolean {
  const ent = seatMapOf(readRegistryText(registryPath)).get(handle);
  if (!isMap(ent)) return false;
  if (ent.get("delivery") === "poll") return false;
  if ((ent.has("status") ? ent.get("status") : "active") !== "active") return false;
  if (ent.get("status_reason") === "launching") return false;
  return pyTruthy(ent.get("pane"));
}

export function readRegistryText(path: string): string | null {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(path)); } catch { return null; }
}

/** `str(v or "")`. */
function strOrEmpty(v: JsonValue | undefined): string {
  if (v === undefined || !pyTruthy(v)) return "";
  return pyStr(v);
}

// --- :814 the activity floor -------------------------------------------------------------

/**
 * `now = int(argv[1]); floor = int(argv[2]); best = floor; real = 0` then for every
 * further value that parses as an int (python `int()`: whitespace, unicode digits,
 * underscores; a failure skips the value), clamp it to `now` and take the max into
 * both. Prints `best\treal`. An unparsable `now` or `floor` raised -- a thrown error
 * here (the tick's clock and its own lease field; never a value the tick writes).
 */
export function activityFloor(now: string, floor: string, values: readonly string[]): string {
  const nowN = pyIntArg(now);
  let best = pyIntArg(floor);
  let real = 0n;
  for (const a of values) {
    let v: bigint;
    try { v = pyIntArg(a); } catch { continue; }
    if (v > nowN) v = nowN;
    if (v > best) best = v;
    if (v > real) real = v;
  }
  return `${best}\t${real}`;
}

// --- the set programs (:888, :893, :912, :951) ---------------------------------------------

/**
 * `set(x)` over a JSON value the way python built it from the tick's own shapes: a
 * list's elements, a dict's keys, a string's code points. Every member must be a
 * string -- the tick only ever writes handles -- so a non-string element (an int, a
 * nested list, null) is refused here where python would have sorted, deduplicated
 * or raised on it by rules that would be a second engine for a value nobody writes
 * (R2b class). A number, bool or null in place of the container raised in python
 * (`not iterable`) and throws here.
 */
function handleSet(v: JsonValue, what: string): Set<string> {
  const out = new Set<string>();
  if (Array.isArray(v)) {
    for (const x of v) {
      if (typeof x !== "string") throw new TypeError(`${what} holds a ${pyTypeName(x)} where a handle was expected: ${dumps(v, true)}`);
      out.add(x);
    }
    return out;
  }
  if (isMap(v)) { for (const k of v.keys()) out.add(k); return out; }
  if (typeof v === "string") { for (const ch of v) out.add(ch); return out; }
  throw new TypeError(`'${pyTypeName(v)}' object is not iterable`);
}

/** `json.loads(text or default)` with no try/except: an unreadable text raised. */
const loadsBare = (text: string, dflt: string): JsonValue => loads(text || dflt);
/** `try: json.loads(text or default) except Exception: fallback`. */
const loadsSafe = (text: string, dflt: string, fallback: JsonValue): JsonValue => { try { return loads(text || dflt); } catch { return fallback; } };

/** `sorted(strings)` by code point, then `json.dumps(..., separators=(",", ":"))`. */
function dumpsSorted(set: Set<string>): string {
  return dumps([...set].sort(pyStrCompare), true);
}

/**
 * :888 -- `d = json.loads(map or "{}")` (unreadable: `{}`); `json.dumps(list(d.keys()))`
 * compact. A readable non-dict has no `.keys()`: python raised, this throws.
 */
export function blockedKeysJson(map: string): string {
  const d = loadsSafe(map, "{}", new Map());
  if (!isMap(d)) throw new TypeError(`'${pyTypeName(d)}' object has no attribute 'keys'`);
  return dumps([...d.keys()], true);
}

/**
 * :893 -- `sorted(set(probed) | set(blocked_keys) | set(touched.split("\n") minus empties))`
 * compact; both JSON reads are bare (an unreadable one raised).
 */
export function skipSetJson(probed: string, blockedKeys: string, touched: string): string {
  const a = handleSet(loadsBare(probed, "[]"), "probed_seats");
  const b = handleSet(loadsBare(blockedKeys, "[]"), "the blocked keys");
  for (const h of touched.split("\n")) if (h) a.add(h);
  for (const h of b) a.add(h);
  return dumpsSorted(a);
}

/** :912 -- `"1" if (set(probed) - set(blocked) - set(exempt)) else "0"`; all three reads bare. */
export function realWedge(probed: string, blocked: string, exempt: string): "1" | "0" {
  const p = handleSet(loadsBare(probed, "[]"), "probed_seats");
  const b = handleSet(loadsBare(blocked, "{}"), "blocked_map");
  const e = handleSet(loadsBare(exempt, "[]"), "blocked_exempt");
  for (const h of p) if (!b.has(h) && !e.has(h)) return "1";
  return "0";
}

/**
 * :951 -- `a = json.loads(exempt or "[]")` (unreadable: `[]`); exit 0 iff `rung in a`.
 * python's `in`: a list's membership (only an equal string can match), a dict's keys,
 * a string's SUBSTRINGS; on a number, bool or null `in` raised, and the `if python`
 * read that status 1 as "not exempt".
 */
export function isExempt(rung: string, exempt: string): boolean {
  const a = loadsSafe(exempt, "[]", []);
  if (Array.isArray(a)) return a.some((x) => x === rung);
  if (isMap(a)) return a.has(rung);
  if (typeof a === "string") return a.includes(rung);
  return false;
}

// --- :193 the probe courier's receipt ------------------------------------------------------

export const RECEIPT_FIELDS = ["status", "id", "path", "delivery", "error_class", "action", "detail"] as const;

/**
 * `d = json.load(stdin)` (unreadable: exit with nothing printed); the seven fields as
 * `str(d.get(k, ""))` joined by US -- an absent field is "", a null one is "None", a
 * number its digits, a container its repr. A readable non-dict has no `.get`: python's
 * traceback went to /dev/null and the caller's `|| true` read "" -- "" here too.
 */
/**
 * The courier's `--json` result as a durable disposition — one reading for every
 * supervision sender (the watch probe, the goalie tick, the public goalie verb). Durable acceptance is an exact (rc, status, delivery) tuple, never rc0
 * alone; anything else — malformed or unknown — refuses with the courier's detail.
 * A harness-queue acceptance stays `queued` (turn unconfirmed): it is transport
 * acceptance, never an injection (harness-queue.ts `harnessQueueMessage`).
 */
export type CourierDisposition =
  | { accepted: true; status: string; delivery: string }
  | { accepted: false; detail: string; action: string };
/** Python `str()` for a JSON scalar: None renders "None", absent renders "". */
function jsonStr(v: unknown): string {
  if (v === null) return "None";
  if (v === undefined) return "";
  return String(v);
}
export function courierDisposition(rc: number, stdout: string, stderr: string): CourierDisposition {
  let status = "", delivery = "", turn = "", detail = "", action = "";
  try {
    const d = JSON.parse(stdout) as Record<string, unknown>;
    status = jsonStr(d["status"]);
    delivery = jsonStr(d["delivery"]);
    turn = jsonStr(d["turn"]);
    detail = jsonStr(d["detail"]);
    action = jsonStr(d["action"]);
  } catch {
    /* unparseable -> empty fields, like the incumbent's `except Exception: pass` */
  }
  if ((rc === 0 && status === "injected" && delivery === "pane") ||
    (rc === 0 && status === "queued" && delivery === "spool") ||
    (rc === 0 && status === "queued" && delivery === "poll") ||
    (rc === 0 && status === "queued" && delivery === "harness-queue" && turn === "unconfirmed") ||
    (rc === 5 && status === "pending")) {
    return { accepted: true, status, delivery };
  }
  if (detail === "") detail = stderr.split("\n")[0] ?? "";
  if (detail === "") detail = "invalid courier result (expected an exact durable disposition)";
  if (action === "") action = "tap doctor";
  return { accepted: false, detail, action };
}

export function probeReceipt(stdout: string): string {
  let d: JsonValue;
  try { d = loads(stdout); } catch { return ""; }
  if (!isMap(d)) return "";
  return RECEIPT_FIELDS.map((k) => pyStr(d.has(k) ? d.get(k) : "")).join("\x1f");
}

// --- :276 the blocked-banner ladder ----------------------------------------------------------

// python's `re` over str: `\s` is unicode whitespace (PY_SPACE, no BOM), `\d` any
// decimal digit (`\p{Nd}`), `\W` anything but a letter, a number or `_`, and
// re.IGNORECASE folds case by simple lowercase mapping -- the `u` flag gives JS the
// first three and simple case FOLDING for the fourth, which differs from python's
// mapping in one letter these phrases use: python matches `i` against the dotless
// `ı` (U+0131) and the dotted `İ` (U+0130); JS folds neither. `I` stands for that
// letter below (`ſ` for `s` and the Kelvin sign for `k` fold the same on both sides).
const I = "[iıİ]";
const SESSION_LIMIT = new RegExp(
  `h${I}t your sess${I}on l${I}m${I}t${PY_SPACE}*[^\\p{L}\\p{N}_]*${PY_SPACE}*resets${PY_SPACE}+(\\p{Nd}{1,2}:\\p{Nd}{2}${PY_SPACE}*[ap]m)${PY_SPACE}*\\(([^)]+)\\)`,
  "iu",
);
const API_ERROR = new RegExp(`term${I}nated early due to an ap${I} error`, "iu");

/**
 * `norm = re.sub(r"\s+", " ", transcript)`, then the ladder: a session-limit banner
 * with its reset clause prints `session_limit\t<H:MMam/pm>\t<tz>` (both groups
 * stripped), an api-error banner prints `api_error\t\t`, anything else prints nothing.
 * The caller's `$( )` drops the trailing newline; this returns the line without it.
 */
export function classifyBlockedTranscript(transcript: string): string {
  const norm = transcript.replace(PY_WS, " ");
  const m = SESSION_LIMIT.exec(norm);
  if (m) return `session_limit\t${pyStrip(m[1]!)}\t${pyStrip(m[2]!)}`;
  if (API_ERROR.test(norm)) return "api_error\t\t";
  return "";
}

// --- :294 the reset epoch -------------------------------------------------------------------

const RESET_CLAUSE = new RegExp(`^(\\p{Nd}{1,2}):(\\p{Nd}{2})${PY_SPACE}*([ap])m`, "iu");

/** python's datetime range, as UTC epochs of 0001-01-01T00:00:00 and 9999-12-31T23:59:59. */
const MIN_EPOCH = -62135596800n;
const MAX_EPOCH = 253402300799n;

/**
 * `_watch_parse_reset_epoch <H:MMam/pm> <tz-name> <now>`: the next epoch >= now at
 * which that wall-clock time occurs in that zone, or 0 when the clause does not
 * parse or the zone is unknown. `int(now)` raised on a non-integer (a thrown error:
 * the tick's own clock); a `now` outside python's datetime range raised too.
 *
 * The arithmetic is python's, fold and all: `now_dt = fromtimestamp(now, tz)` (fold
 * set by the instant), `candidate = now_dt.replace(hour, minute, 0, 0)` (fold kept),
 * `if candidate <= now_dt` -- aware datetimes with one tzinfo compare by WALL clock --
 * `candidate += 1 day` (wall-clock arithmetic; the result's fold is 0), and
 * `int(candidate.timestamp())` resolves the wall time through the zone with PEP 495:
 * in a gap or an overlap fold=0 takes the offset in force BEFORE the transition,
 * fold=1 the one after.
 */
export function parseResetEpoch(timeS: string, tzS: string, nowS: string): string {
  const now = pyIntArg(nowS);
  const m = RESET_CLAUSE.exec(pyStrip(timeS));
  if (!m) return "0";
  let hour = Number(unicodeDigits(m[1]!)) % 12;
  if (m[3]!.toLowerCase() === "p") hour += 12;
  const minute = Number(unicodeDigits(m[2]!));
  // `replace(minute=99)` raised in python (`\d{2}` admits 60..99); the hour cannot: `% 12` then +12
  if (minute > 59) throw new RangeError(`minute must be in 0..59, not ${minute}`);
  const zone = zoneOf(pyStrip(tzS));
  if (zone === null) return "0";
  // python's datetime lives in years 1..9999; fromtimestamp raised past either end,
  // as did the day added to 9999-12-31 -- wall-clock bounds, in the zone
  const outOfRange = (wall: bigint): boolean => wall < MIN_EPOCH || wall > MAX_EPOCH;
  if (outOfRange(now)) throw new RangeError(`year is out of range for timestamp ${now}`);
  const nowWall = zone.wall(now);
  if (outOfRange(nowWall)) throw new RangeError(`year is out of range for timestamp ${now}`);
  const nowFold = zone.fold(now);
  // replace(hour=, minute=, second=0, microsecond=0): the same calendar day on the wall clock
  const dayStart = nowWall - ((nowWall % 86400n) + 86400n) % 86400n;
  let candidate = dayStart + BigInt(hour) * 3600n + BigInt(minute) * 60n;
  let fold = nowFold;
  if (candidate <= nowWall) {
    candidate += 86400n;
    fold = 0;
    if (outOfRange(candidate)) throw new RangeError("date value out of range");
  }
  return zone.epoch(candidate, fold).toString();
}

/** python `int()` of a run of unicode decimal digits. */
function unicodeDigits(text: string): bigint { return pyIntArg(text); }

/**
 * One IANA zone through Intl: `wall(t)` is the wall clock at instant t as seconds
 * since the epoch as if UTC; `fold(t)` is python's fold for that instant (1 when the
 * same wall clock occurred one transition earlier); `epoch(w, fold)` resolves a wall
 * clock back to an instant by PEP 495. Null when Intl does not know the name (python:
 * `ZoneInfo(name)` raised -> 0). Both sides read the IANA database; where their
 * copies disagree on a name the differential test says so.
 */
interface Zone { wall(t: bigint): bigint; fold(t: bigint): 0 | 1; epoch(w: bigint, fold: 0 | 1): bigint }

export function zoneOf(name: string): Zone | null {
  // zoneinfo keys are paths under the database; python refused an empty key, an
  // absolute one, and any `..` component before looking. Intl would accept "UTC"
  // spellings python's file lookup would not find, and python finds files Intl has no
  // id for -- the disagreements the corpus measures.
  if (!name || name.startsWith("/") || name.split("/").includes("..")) return null;
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: name, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", era: "short",
    });
  } catch { return null; }
  // Intl matches a key case-insensitively (`utc`, `america/los_angeles`) and reports
  // it in the database's own casing; the database's keys are case-sensitive, and so
  // was python's lookup on a case-sensitive filesystem (the gate's host). On macOS
  // the filesystem, not the program, let `utc` through -- a host artifact the port
  // does not reproduce: a name is a key only in the database's spelling.
  if (fmt.resolvedOptions().timeZone !== name) return null;
  const offset = (t: bigint): bigint => {
    const parts = fmt.formatToParts(new Date(Number(t) * 1000));
    const p = (type: string): number => Number(parts.find((x) => x.type === type)?.value ?? "0");
    let year = p("year");
    if ((parts.find((x) => x.type === "era")?.value ?? "AD").startsWith("B")) year = 1 - year;
    // Date.UTC maps years 0-99 into the 1900s; the setters take the year as written
    const d = new Date(0);
    d.setUTCFullYear(year, p("month") - 1, p("day"));
    d.setUTCHours(p("hour") % 24, p("minute"), p("second"), 0);
    return BigInt(Math.floor(d.getTime() / 1000)) - t;
  };
  const wall = (t: bigint): bigint => t + offset(t);
  /** The one transition instant in (lo, hi] when the offsets at lo and hi differ. */
  const transition = (lo: bigint, hi: bigint): bigint => {
    const oLo = offset(lo);
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      if (offset(mid) === oLo) lo = mid; else hi = mid;
    }
    return hi;
  };
  const DAY = 86400n;
  const fold = (t: bigint): 0 | 1 => {
    // fold=1 iff an earlier instant within the last day shows the same wall clock
    const oBefore = offset(t - DAY);
    const o = offset(t);
    if (oBefore <= o) return 0;
    const tr = transition(t - DAY, t);
    return t + o < tr + oBefore ? 1 : 0;
  };
  const epoch = (w: bigint, f: 0 | 1): bigint => {
    // the offsets a day either side of the wall clock read as an instant bracket any transition
    const oA = offset(w - DAY);
    const oB = offset(w + DAY);
    if (oA === oB) return w - oA;
    const tr = transition(w - DAY, w + DAY);
    const before = f === 0 ? w < tr + (oA > oB ? oA : oB) : w < tr + (oA < oB ? oA : oB);
    return w - (before ? oA : oB);
  };
  return { wall, fold, epoch };
}

// --- CLI: the programs the still-Bash tick reaches by name ------------------------------------
//
//   watch-tick.ts activity-floor <now> <floor> [<value>...]  -> `best\treal`
//   watch-tick.ts blocked-keys-json <map>                    -> JSON list
//   watch-tick.ts skip-set <probed> <blocked-keys> <touched> -> JSON list
//   watch-tick.ts real-wedge <probed> <blocked> <exempt>     -> 1 | 0
//   watch-tick.ts is-exempt <rung> <exempt>                  -> status 0 iff exempt
//   watch-tick.ts probe-receipt                              -> seven US-joined fields (stdin: the receipt)
//   watch-tick.ts classify-blocked                           -> the ladder's line (stdin: the transcript)
//   watch-tick.ts reset-epoch <H:MMam/pm> <tz> <now>          -> epoch | 0
//
// Each prints what its python printed, with the trailing newline `print` gave. A
// python raise is one `tap watch: <error>` line and status 1 -- the caller's `$( )`
// then reads "" the way it did (loop shape) or ends the tick (verb shape).

export function main(argv: string[]): number {
  const [verb, ...rest] = argv;
  const need = (n: number, usage: string): void => { if (rest.length < n) throw new Error(`usage: watch-tick.ts ${usage}`); };
  const out = (text: string): void => { process.stdout.write(`${text}\n`); };
  try {
    switch (verb) {
      case "activity-floor": need(2, "activity-floor <now> <floor> [<value>...]"); out(activityFloor(rest[0]!, rest[1]!, rest.slice(2))); return 0;
      case "blocked-keys-json": need(1, "blocked-keys-json <map>"); out(blockedKeysJson(rest[0]!)); return 0;
      case "skip-set": need(3, "skip-set <probed> <blocked-keys> <touched>"); out(skipSetJson(rest[0]!, rest[1]!, rest[2]!)); return 0;
      case "real-wedge": need(3, "real-wedge <probed> <blocked> <exempt>"); out(realWedge(rest[0]!, rest[1]!, rest[2]!)); return 0;
      case "is-exempt": need(2, "is-exempt <rung> <exempt>"); return isExempt(rest[0]!, rest[1]!) ? 0 : 1;
      case "probe-receipt": { const line = probeReceipt(cmdSubst(readStdin())); if (line) out(line); return 0; }
      case "classify-blocked": { const line = classifyBlockedTranscript(readStdin()); if (line) out(line); return 0; }
      case "reset-epoch": need(3, "reset-epoch <H:MMam/pm> <tz> <now>"); out(parseResetEpoch(rest[0]!, rest[1]!, rest[2]!)); return 0;
      default: throw new Error(`watch-tick.ts: unknown program ${JSON.stringify(verb ?? "")}`);
    }
  } catch (error) {
    process.stderr.write(`tap watch: ${(error as Error).message}\n`);
    return 1;
  }
}

function readStdin(): string {
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
