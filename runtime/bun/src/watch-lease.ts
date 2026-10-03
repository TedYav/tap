// The watch lease record: `<bus>/watch/arm.json`, one JSON object that every
// `tap watch` tick reads and that, on the watch and reminders paths, only `set`
// here rewrites (remind.ts imports this module's `publish`).
//
// `tap teardown`/`tap restore`'s per-handle prune/restore is NO LONGER outside
// this module: `tap_watch_prune_handle`/`tap_watch_restore_handle` (lib.sh:9707)
// call `pruneHandle`/`restoreHandle` below, both under `withLock` and through the
// same `publish` (tap-nlxce; tap-teardown.sh:179/:182/:320/:324). They are generic
// over the record path, so the same two entry points serve the GOALIE record's
// `seats` slices -- which is why `goalie-lease.ts` shares this module's writer
// rather than growing a second one. `tap team reset`'s post-checkpoint cut, which
// removes `watch/` wholesale, is a separate lifetime and is not claimed here
// either way. Migration slice W1b
// moves the record's read/merge/delete out of lib.sh -- `tap_watch_snapshot`,
// `tap_watch_field`, the `tinted_panes` read behind `tap_watch_clear_tints`,
// `tap_watch_set`, `tap_watch_disarm` -- and leaves those Bash names as
// `tap_bun_call` adapters. The verb-level lifecycle (`tap watch on/off/pause/
// resume/status/ack`) and the tick loop stay in tap-watch.sh and call these.
//
// Grammar:  watch-lease.ts <arm.json> snapshot
//           watch-lease.ts <arm.json> field <key>
//           watch-lease.ts <arm.json> items <key>
//           watch-lease.ts <arm.json> set [<key> <value>]...
//           watch-lease.ts <arm.json> disarm
//           watch-lease.ts <arm.json> clear-pause <now> <armed_at> <paused_at> <paused_until>
//           watch-lease.ts <arm.json> prune-handle <top-key> <handle> <slice-dir>
//           watch-lease.ts <arm.json> restore-handle <top-key> <slice-dir>
//
// What is carried from the incumbent, each pinned by a test rather than asserted:
//   - `set` exits 3 when there is no lease and TAP_WATCH_ALLOW_CREATE is not "1"
//     (the arming write is the one caller that sets it), and 4 when a
//     TAP_WATCH_EXPECT_<FIELD> generation check does not match; 3 is decided
//     before 4. An exported-but-empty EXPECT variable still compares.
//   - INT_KEYS coerce with Python's int() (pyint.ts: its whitespace, Unicode
//     digits, sign, underscores) and store 0 when that would raise. Integers are
//     carried as BigInt from parse to publish, so an admitted value past
//     Number.MAX_SAFE_INTEGER -- `tap watch on --threshold 9007199254740993`
//     passes the shell's positive-integer check -- is persisted exactly, as
//     json.dump persisted it, and an unrelated later `set` cannot round it;
//     JSON_KEYS store an array: parsed when the value starts with `[`, otherwise
//     comma-split with empty pieces dropped; every other key stores the string it
//     was given. `blocked_map` is a per-seat object, not an array, so it is not a
//     JSON key and rides through as an opaque string (tap-watch.sh owns its shape).
//   - The read side prints the way Python's print() did: numbers bare, None as
//     empty, dict/list as compact ASCII JSON, and `snapshot` one `key<TAB>value`
//     line per top-level field. An absent, unreadable, or non-object record prints
//     nothing and exits 0 -- the tick treats that as "unarmed", not as a fault.
//   - `disarm` deletes `arm.json` and `arm.json.tmp` under the lease lock and keeps
//     the lock FILE: it is the stable inode every locker shares, and removing it
//     would let a later locker synchronize on a fresh inode while an older
//     descriptor still holds the old one. `.tmp` is no longer this writer's temp
//     name (see `publish`), but a pre-upgrade `tap_watch_set` interrupted mid-write
//     can still have left one. Any failure returns nonzero; the Bash adapter then
//     reports the lease KEPT rather than falling back to an unlocked delete.
//   - A record that exists but does not parse is treated as `{}` and rewritten by
//     `set`. That is the incumbent's behavior, inherited here on purpose so this
//     slice changes one thing; a record that parses to a non-object refuses, as
//     the incumbent's `rec.get` did.
//
// Lock: `arm.json.lock`, taken through `acquireNoFollowLock` -- remind-lock.ts is
// the shared no-follow holder for both watch modules until tap-0yvv9 folds it into
// panelock. It is stronger than the incumbent's plain open()+flock: a symlinked
// lock path is refused instead of followed, and the wait is bounded at
// LOCK_WAIT_MS where Python blocked forever. A timeout or a refused path exits 1
// with a message, never 3 or 4, so no caller mistakes it for a missing lease.
// remind.ts takes this same lock through `withLock` below and always takes the
// reminders queue lock first; nothing in this module takes the queue lock, so the
// queue -> lease order cannot invert from this side.

import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ensureAscii } from "./fsatomic";
import { pythonInt } from "./pyint";
import { acquireNoFollowLock } from "./remind-lock";

export const LOCK_WAIT_MS = 120_000;

export type Rec = Record<string, unknown>;

export const INT_KEYS: ReadonlySet<string> = new Set([
  "armed_at", "threshold_seconds", "probe_timeout_seconds", "tick_interval_seconds", "watcher_pid",
  "current_rung", "consecutive_defers", "evaluator_calls", "last_probe_at", "carried_probe_at",
  "episode_started_at", "heartbeat_at", "silence_floor_at", "paused_at", "paused_until",
]);
export const JSON_KEYS: ReadonlySet<string> = new Set(["chain_overrides", "probed_seats", "blocked_exempt", "tinted_panes"]);

/** Generation checks a caller can demand: record field -> the env var carrying the expected value. */
export const EXPECTED: ReadonlyArray<readonly [key: string, env: string]> = [
  ["armed_at", "TAP_WATCH_EXPECT_ARMED_AT"],
  ["paused_at", "TAP_WATCH_EXPECT_PAUSED_AT"],
  ["paused_until", "TAP_WATCH_EXPECT_PAUSED_UNTIL"],
  ["queued_probe_id", "TAP_WATCH_EXPECT_QUEUED_PROBE_ID"],
  ["carried_probe_seat", "TAP_WATCH_EXPECT_CARRIED_PROBE_SEAT"],
  ["carried_probe_at", "TAP_WATCH_EXPECT_CARRIED_PROBE_AT"],
];

const IS_RAW_JSON = (JSON as unknown as { isRawJSON(v: unknown): boolean }).isRawJSON;
/** A record object -- not an array, and not the frozen wrapper a preserved float rides in. */
/**
 * `[ -f path ]`: a REGULAR file (symlinks followed). The lease's presence predicate
 * -- `tap_watch_is_armed` -- was this test, not existence: a directory or a fifo
 * named arm.json is "unarmed" to every verb (a fifo would block the read that
 * `existsSync` let through).
 */
/** A present path that is not a regular file is refused by name, before any open or rename. */
export function refuseNonRegular(path: string): void {
  if (existsSync(path) && !isFile(path)) throw new Error(`${path} is not a regular file; refusing to read or publish it`);
}

export function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/** A payload is settled by a regular-file `.done` (the recipient's) or `.cancelled` (the sender cleared it). */
export function isSettled(receipts: string, id: string): boolean {
  return isFile(join(receipts, `${id}.done`)) || isFile(join(receipts, `${id}.cancelled`));
}

function isObject(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !IS_RAW_JSON(v);
}

// --- the shared JSON-file primitives (remind.ts imports these) -----------------

/**
 * Integers stay exact across parse and publish. JSON.parse hands a reviver the
 * source text (`context.source`); an integer-shaped source becomes a BigInt
 * instead of a rounded Number, and the replacer writes a BigInt back as raw
 * digits. delivery-clock.ts reads its stamp the same way. Floats and everything
 * else are untouched, so remind.ts's records (all Number) publish unchanged.
 */
const RAW_JSON = (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON;
function exactIntegerReviver(_key: string, value: unknown, context?: { source: string }): unknown {
  if (typeof value !== "number" || !context?.source) return value;
  if (/^-?\d+$/.test(context.source)) return BigInt(context.source);
  // A float keeps its source text (JSON.rawJSON), so `1.0` reads back as `1.0`
  // the way json.load/json.dump round-trip it -- Number would print `1`. No TAP
  // writer produces a float here; this is read-side fidelity for a hand-edited
  // record, and a NON-canonical float (`1E5`) stays as written where Python
  // would have printed `100000.0`.
  return RAW_JSON(context.source);
}
function exactIntegerReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? RAW_JSON(String(value)) : value;
}
/** Parse a lease record with integers exact. */
export function parseRecord(text: string): unknown {
  return JSON.parse(text, exactIntegerReviver);
}

/**
 * Atomic publish of a JSON record. `ensureAscii` is not decoration: `arm.json`
 * and `reminders.json` are read by Bash through `json.load(open(path))`, and the
 * Python this replaces escaped non-ASCII through `json.dump`'s `ensure_ascii=True`
 * default. `arm.json` carries free text (`done_when` from `tap watch on -m`,
 * `pause_reason`), so escaping is what keeps a Python reader's bytes identical to
 * the incumbent's. The temp name is per-process and random with `wx` (O_EXCL), so
 * two writers can never share a temp file; the rename is the publication.
 */
/**
 * `json.dumps(v, separators=(",", ":"))` as BOTH incumbents wrote it: compact,
 * exact integers preserved, and `ensure_ascii=True` (Python's default) applied.
 * Exported because the goalie record's read side needs the identical bytes and
 * the first draft of `goalie-lease.ts` reimplemented it with `JSON.stringify`
 * plus a BigInt->Number cast, which silently lost `9007199254740993` and emitted
 * non-ASCII literally.
 */
export function recordBytes(value: unknown): string {
  return ensureAscii(JSON.stringify(value, exactIntegerReplacer));
}

export function publish(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  // every publisher crosses here (set, prune, restore): a directory or a fifo at the
  // record's name is refused BEFORE a temp exists, never renamed over (partner review G1)
  refuseNonRegular(path);
  const tmp = join(dirname(path), `.lease-${process.pid.toString(36)}${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, recordBytes(value) + "\n");
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, path);
  } catch (error) {
    try { closeSync(fd); } catch { /* already closed */ }
    rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * A record that must parse: absent reads as `{}`, malformed throws to the caller.
 * Numbers, not BigInt: remind.ts does arithmetic on what it reads here, and its
 * own writes are all Number-valued. The lease record's exact-integer path is
 * `parseRecord` above.
 *
 * Decode is STRICT, and that is parity, not new policy: the incumbent
 * (`reminders.py`, deleted at 01fbea556) read `json.loads(path.read_text())`
 * with no catch, so one undecodable byte raised exactly as a malformed file
 * did. The port's `readFileSync(path, "utf8")` repaired bad bytes to U+FFFD
 * and then parsed, so a record the incumbent rejected became readable rows
 * (tap-yv3xm). Decoding through `UTF8_STRICT` restores that contract; note it
 * is still a change from the shipped repair for a bad-byte record, which now
 * raises where the deployed port returned repaired rows.
 */
export function read<T extends object>(path: string): T {
  return existsSync(path) ? (JSON.parse(strictText(path)) as T) : ({} as T);
}

/**
 * `read` with integers exact (`parseRecord`), for a writer that republishes the
 * record it read: plain `JSON.parse` rounds an integer past MAX_SAFE_INTEGER and the
 * rewrite would publish the rounded digits (tap-j5pmi).
 */
export function readExact<T extends object>(path: string): T {
  return existsSync(path) ? (parseRecord(strictText(path)) as T) : ({} as T);
}

/** Run `body` holding `<path>.lock`; a lock wait past LOCK_WAIT_MS is an error, not a fallback. */
export function withLock<T>(path: string, body: () => T): T {
  const lock = acquireNoFollowLock(`${path}.lock`, LOCK_WAIT_MS);
  if (!lock) throw new Error(`lock wait exceeded (${LOCK_WAIT_MS / 1000}s) on ${path}.lock`);
  try { return body(); } finally { lock.release(); }
}

// --- the read side: snapshot / field / items ---------------------------------------

/**
 * The incumbent's `try: json.load(...) except Exception: exit(0)`: anything
 * unreadable is "no record". A path that is not a regular file is "no record"
 * WITHOUT being opened: a fifo would block the open, and every verb and the tick
 * gate on `[ -f ]` before they read -- except the arming path's tint clear, which
 * read first and hung on both sides (partner review F1). This is the one boundary
 * every loose read crosses, so the guard lives here.
 */
/**
 * `open(path)` in Python 3 decodes UTF-8 STRICTLY, so one invalid byte anywhere in
 * the file raises `UnicodeDecodeError` and `json.load` never runs: the record is
 * unreadable, whole. `readFileSync(path, "utf8")` instead REPLACES the byte with
 * U+FFFD, after which the JSON parses -- so a record the incumbent refused to read
 * became readable, and the goalie state machine observed it, minted an episode
 * capability and rewrote the file (measured on a
 * 0xFF in a `note` field the machine never consults). The bad byte being in
 * irrelevant metadata is not the point: the incumbent's reader rejected the record.
 *
 * `ignoreBOM: true` is load-bearing and is NOT about ignoring anything: without it
 * TextDecoder STRIPS a leading BOM, which would make a BOM-prefixed record parse
 * where `open(path)` -- plain utf-8, not utf-8-sig -- hands the BOM to `json.load`
 * and raises. Keeping the BOM keeps that pre-existing agreement.
 *
 * Shared with the watch record, deliberately: its incumbent read the same way, so
 * this moves both toward the reader they were ported from rather than fixing one.
 */
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function readLoose(path: string): unknown {
  if (!isFile(path)) return undefined;
  try { return parseRecord(UTF8_STRICT.decode(readFileSync(path))); } catch { return undefined; }
}

/**
 * A file's bytes through the strict decoder: one invalid byte anywhere throws,
 * and a leading BOM stays to fail the parse, matching `open(path)` -- the
 * incumbent's reader on every record this module reads. The writers use this
 * rather than `readFileSync(path, "utf8")` so the module can never repair bytes
 * the reader it was ported from would have rejected (tap-yv3xm): a repair at a
 * write door publishes a record the read doors refuse.
 */
function strictText(path: string): string {
  return UTF8_STRICT.decode(readFileSync(path));
}

/**
 * Python's print() of a record value: dict/list as compact ASCII JSON, None as
 * empty, bool as True/False, integers (BigInt from `parseRecord`) and numbers
 * bare. INT_KEYS are stored as integers so no float reaches this path from a
 * record this module wrote.
 */
export function printed(v: unknown): string {
  if (v === null || v === undefined) return "";
  // the replacer, not plain stringify: parseRecord revived nested integers to
  // BigInt, and JSON.stringify throws on BigInt -- which would take the whole
  // snapshot down with it, and the tick would read that as "unarmed"
  if (typeof v === "object") return ensureAscii(JSON.stringify(v, exactIntegerReplacer));
  if (typeof v === "boolean") return v ? "True" : "False";
  return String(v);
}

/** One `key<TAB>value` line per top-level field; nothing for a non-object. */
export function snapshotLines(rec: unknown): string[] {
  if (!isObject(rec)) return [];
  return Object.entries(rec).map(([k, v]) => `${k}\t${printed(v)}`);
}

/** `rec.get(key, "")` printed; a non-object record has no fields. */
export function fieldValue(rec: unknown, key: string): string {
  return isObject(rec) && key in rec ? printed(rec[key]) : "";
}

/**
 * The elements of an array field, one per line (`tap_watch_clear_tints` reads
 * `tinted_panes` this way and untints each pane). The incumbent iterated
 * `rec.get(key) or []`, which for a string value would have yielded its
 * characters; a non-array here yields nothing -- the one deliberate divergence in
 * this module, since a pane id is never one character long.
 */
export function itemLines(rec: unknown, key: string): string[] {
  const v = isObject(rec) ? rec[key] : undefined;
  return Array.isArray(v) ? v.map(printed) : [];
}

// --- the write side: set / disarm -------------------------------------------------

/**
 * Python's int() (pyint.ts), with ValueError stored as 0 as the incumbent did.
 * `parseInt` would accept "1.5" as 1 and "12abc" as 12, both of which Python
 * refused; Number would round past MAX_SAFE_INTEGER, which json.dump did not.
 */
export function pyInt(value: string): bigint {
  return pythonInt(value, true) ?? 0n;
}

/**
 * The source text of a preserved float, or null -- see `exactIntegerReviver`. The
 * wrapper is a frozen, NULL-PROTOTYPE object, so `String(v)` on one is a TypeError
 * and every helper that means "a number" has to ask for it by name.
 */
export function floatSource(v: unknown): string | null {
  return typeof v === "object" && v !== null && IS_RAW_JSON(v)
    ? (v as { rawJSON: string }).rawJSON
    : null;
}

/**
 * Python's `repr()` of a JSON-derived value. `str()` of a container renders its
 * ELEMENTS with repr, which is why this exists separately: `str(["x"])` is
 * `['x']`, not the JSON `["x"]`, and `str([True])` is `[True]`.
 *
 * Scope, stated rather than implied: the values reachable here are what
 * `json.load` produces -- None, bool, int, float, str, list, dict. A string's repr
 * prefers single quotes and switches to double when the value contains a single
 * quote and no double, which is CPython's rule; control characters take their
 * short escape or `\xNN`. Assigned non-ASCII characters stay literal, as Python 3's
 * repr leaves them; which characters count as assigned is decided by the evaluating
 * runtime's Unicode tables -- the version ceiling the printability note below
 * carries, not a promise of byte-identical repr across Python versions.
 *
 * Three boundaries, named rather than left to be discovered. (1) `Object.entries`
 * orders integer-like keys first and ascending, while a Python dict preserves
 * insertion order, so `str({"b": 1, "1": 2})` and this disagree on KEY ORDER for a
 * mapping that mixes numeric-looking and other keys; reachable only by a
 * hand-edited record whose generation field is such a mapping. (2) The category
 * table behind `pyPrintable` below is only as current as that Unicode version.
 * (3) A non-canonical float source prints as written (declared at
 * `exactIntegerReviver`).
 */
/**
 * `str.isprintable()` -- a CATEGORY test, not an ASCII-range one. Python escapes
 * anything in Cc, Cf, Cs, Co, Cn, Zl, Zp or Zs, with ASCII space the one exception,
 * so NEL (U+0085, Cc), NBSP (U+00A0, Zs) and ZWSP (U+200B, Cf) are escaped even
 * though they sit above 0x20 -- while `cafe` and an emoji are printable and stay
 * literal. The first draft tested `code < 0x20 || code === 0x7f`, which agreed with
 * Python on every printable and disagreed on exactly those in-between characters;
 * `expectedHold` then rejected the rendering Python demands.
 *
 * One ceiling this rule cannot hold: category membership is only as current as the
 * evaluating runtime's Unicode tables, so this is not a cross-version parity PASS.
 * Measured on this candidate, Python 3.11.14 (Unicode 14) escapes U+1FAE8 and
 * U+1CC00 as unassigned where Python 3.14.6 (Unicode 16) and Bun 1.4.0 print them
 * literally; six stable neighbours agree.
 */
const NONPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;
function pyPrintable(ch: string): boolean {
  return ch === " " || !NONPRINTABLE.test(ch);
}

function pyReprStr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of s) {
    if (ch === "\\" || ch === quote) out += "\\" + ch;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (pyPrintable(ch)) out += ch;
    else {
      const code = ch.codePointAt(0)!;
      out += code < 0x100 ? `\\x${code.toString(16).padStart(2, "0")}`
        : code < 0x10000 ? `\\u${code.toString(16).padStart(4, "0")}`
        : `\\U${code.toString(16).padStart(8, "0")}`;
    }
  }
  return quote + out + quote;
}

function pyRepr(v: unknown): string {
  if (v === null) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "bigint") return String(v);
  if (typeof v === "string") return pyReprStr(v);
  const src = floatSource(v);
  if (src !== null) return src;
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (typeof v === "object") {
    return `{${Object.entries(v as Rec).map(([k, x]) => `${pyReprStr(k)}: ${pyRepr(x)}`).join(", ")}}`;
  }
  return String(v);
}

/**
 * Python's `str()` as the generation checks use it: `str(rec.get(key, ""))`.
 *
 * The container branch used to render compact JSON with the note that it was
 * "unreachable for the six EXPECTED keys, all scalars" -- a survey of what the
 * WRITERS put there, not a bound on what a hand-edited record can hold. The goalie
 * port then wrote its own version whose container branch was `String(v)`, which is
 * `Array.prototype.join`: `String([100])` is `"100"`, so a record holding
 * `armed_at: [100]` compared EQUAL to the expected generation `100` and the
 * mutation went through -- a generation-check bypass, where Python compared
 * `"[100]"` and refused. One conversion for both
 * records, so neither can drift from Python again.
 */
export function pythonStr(v: unknown): string {
  if (v === undefined) return "";
  if (v === null) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "string") return v;              // `str(s)` is s -- no quotes
  if (typeof v === "bigint") return String(v);
  const src = floatSource(v);
  if (src !== null) return src;
  if (typeof v === "object") return pyRepr(v);
  return String(v);
}

/**
 * The watch record's spelling of the same conversion. Two consumers, both checked
 * when the container branch changed: `expectedHold` below -- the generation check
 * this fixes -- and `watch-notice.ts:138`, which compares the rendering against the
 * literal `"1"`, so a container answers "not acked" under either rendering. Every
 * other `pyStr` in `src/` is a different function local to its own module
 * (`watch-detect`, `digest-window`, `registry` each define one).
 */
export function pyStr(v: unknown): string {
  return pythonStr(v);
}

/** Store a CLI value under the incumbent's per-key coercion. */
export function coerce(key: string, value: string): unknown {
  if (INT_KEYS.has(key)) return pyInt(value);
  if (JSON_KEYS.has(key)) {
    const split = () => value.split(",").filter((x) => x);
    if (!value.trim().startsWith("[")) return split();
    try { return parseRecord(value); } catch { return split(); }
  }
  return value;
}

/**
 * Every EXPECTED check whose env var is SET must match; an empty string is set
 * and compares (against a record where the field is absent, `""` matches). Only
 * an unset variable skips the check -- `if want` would be the dict-falsy trap
 * pointing the other way.
 */
export function expectedHold(rec: Rec, env: NodeJS.ProcessEnv): boolean {
  for (const [key, name] of EXPECTED) {
    const want = env[name];
    if (want === undefined) continue;
    if (pyStr(key in rec ? rec[key] : undefined) !== want) return false;
  }
  return true;
}

/** Merge `key value` pairs in order; a trailing key with no value is ignored, as `range(0, n - 1, 2)` ignored it. */
export function applyPairs(rec: Rec, pairs: string[]): void {
  for (let i = 0; i + 1 < pairs.length; i += 2) rec[pairs[i]!] = coerce(pairs[i]!, pairs[i + 1]!);
}

/** `tap_watch_set`: merge under the lease lock. Returns the incumbent's exit status. */
export function set(path: string, pairs: string[], env: NodeJS.ProcessEnv = process.env): 0 | 3 | 4 {
  mkdirSync(dirname(path), { recursive: true });
  return withLock(path, () => {
    let rec: Rec = {};
    // present but not a regular file: never READ it (a fifo blocks) -- a loud refusal
    // before the read, not a hang and not a "no lease" (3) that the arming write would
    // create past; `publish` repeats the check for the writers that read loosely
    refuseNonRegular(path);
    if (existsSync(path)) {
      let parsed: unknown = {};
      // The incumbent read `json.load(open(path))` -- strict decode -- and on ANY
      // failure, undecodable bytes or malformed JSON, discarded the record whole
      // (`except Exception: rec = {}`) before an `os.replace` rewrote it, unconditional on
      // the read succeeding; this port's rewrite still waits on the generation check
      // (`expectedHold`, exit 4) below (lib.sh at d8c3dca3e~1). The shipped port replaced bytes with U+FFFD
      // first, so a record the incumbent threw away merged as a repaired object and
      // the invalid byte shipped inside it (tap-yv3xm). Strict decode makes
      // the only unreadable path the incumbent's own: garbage in, `{} -> rewritten`.
      try { parsed = parseRecord(strictText(path)); } catch { parsed = {}; }
      if (!isObject(parsed)) throw new Error(`${path} is not a JSON object; refusing to merge into it`);
      rec = parsed;
    } else if (env.TAP_WATCH_ALLOW_CREATE !== "1") {
      return 3;
    }
    if (!expectedHold(rec, env)) return 4;
    applyPairs(rec, pairs);
    publish(path, rec);
    return 0;
  });
}

/** `tap_watch_disarm`: delete the record and any pre-upgrade `.tmp` under the lease lock; the lock file stays. */
export function disarm(path: string): void {
  if (!existsSync(path) && !existsSync(`${path}.tmp`)) return;
  mkdirSync(dirname(path), { recursive: true });
  withLock(path, () => {
    // the fallible stale-temp cleanup FIRST: if `.tmp` cannot go (a directory at
    // that name -- EPERM here, EISDIR elsewhere) the lease is still on disk when
    // the caller reports it KEPT. The other order deleted the lease, then failed,
    // then said KEPT (review). Only "never there" is silence.
    for (const p of [`${path}.tmp`, path]) {
      try { unlinkSync(p); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  });
}

// --- the verb-layer writers that share this lock (slice W1) -------------------------

/**
 * `_watch_clear_pause`: clear a pause and start a fresh silence window without
 * touching the unconditional blocked-seat/spool state. The next wedge episode
 * starts from a clean ladder. Compare-and-set on the pause generation the caller
 * captured (armed_at, paused_at, paused_until); the resume verb and the tick's
 * pause-expiry path both come here, so the field list has ONE copy.
 */
export function clearPause(path: string, now: string, armedAt: string, pausedAt: string, pausedUntil: string, env: NodeJS.ProcessEnv = process.env): 0 | 3 | 4 {
  return set(path, [
    "paused_by", "", "paused_at", "0", "paused_until", "0", "pause_reason", "",
    "silence_floor_at", now, "episode_started_at", "0", "current_rung", "0",
    "consecutive_defers", "0", "evaluator_calls", "0", "last_probe_at", "0", "notified_at", "0",
    "probed_seats", "[]", "defer_seat", "",
  ], { ...env, TAP_WATCH_EXPECT_ARMED_AT: armedAt, TAP_WATCH_EXPECT_PAUSED_AT: pausedAt, TAP_WATCH_EXPECT_PAUSED_UNTIL: pausedUntil });
}

/**
 * A top-level key holding a per-handle object, in either of the two shapes the
 * record carries: a JSON object, or -- the shape every watcher-written record
 * has for `blocked_map`, which `set` stores as an opaque string (CONTRACT
 * §Watch layer) -- a JSON-encoded string of one. The incumbent teardown prune
 * only recognised the object form, so on a real record it never fired; the
 * string form is accepted here and written back in the shape it was found, so
 * `field`/`items` readers see the same JSON text either way. Anything else is
 * "no bucket".
 */
function handleBucket(rec: Rec, top: string): { bucket: Rec; asString: boolean } | null {
  const v = rec[top];
  if (isObject(v)) return { bucket: v, asString: false };
  if (typeof v === "string") {
    try {
      const parsed = parseRecord(v);
      if (isObject(parsed)) return { bucket: parsed, asString: true };
    } catch { /* not a JSON object */ }
  }
  return null;
}

function storeBucket(rec: Rec, top: string, bucket: Rec, asString: boolean): void {
  rec[top] = asString ? ensureAscii(JSON.stringify(bucket, exactIntegerReplacer)) : bucket;
}

/**
 * `tap teardown`'s per-handle prune, under the lease lock (tap-nlxce): move
 * `<top>[handle]` out of the record into `<sliceDir>/<top>.<handle>.json` as
 * `{"<handle>": <entry>}`. No record, an unreadable one, no bucket, or no such
 * handle: nothing is written, exit 0 -- the incumbent's `sys.exit(0)` arms.
 * The slice file keeps the incumbent's `indent=2, sort_keys=True` shape because
 * `tap restore` (and its fixture) reads it back by name.
 */
export function pruneHandle(path: string, top: string, handle: string, sliceDir: string): void {
  if (!existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  withLock(path, () => {
    const rec = readLoose(path);
    if (!isObject(rec)) return;
    const found = handleBucket(rec, top);
    // own keys only: python's `handle not in bucket` never saw a prototype, and `in`
    // would find "constructor" on every parsed object (review)
    if (!found || !Object.prototype.hasOwnProperty.call(found.bucket, handle)) return;
    const entry = found.bucket[handle];
    delete found.bucket[handle];
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(join(sliceDir, `${top}.${handle}.json`), pyDumpSorted({ [handle]: entry }) + "\n");
    storeBucket(rec, top, found.bucket, found.asString);
    publish(path, rec);
  });
}

/**
 * The current value of `<top>[handle]`, or undefined, read under the lease
 * lock so a caller can later verify nothing else wrote it in between.
 */
export function readHandleEntry(path: string, top: string, handle: string): unknown {
  if (!existsSync(path)) return undefined;
  return withLock(path, () => {
    const rec = readLoose(path);
    if (!isObject(rec)) return undefined;
    const found = handleBucket(rec, top);
    if (!found || !Object.prototype.hasOwnProperty.call(found.bucket, handle)) return undefined;
    return found.bucket[handle];
  });
}

/**
 * Undo one `restoreHandle` merge, under the lease lock, but ONLY if nothing
 * else wrote `<top>[handle]` since the merge: `restoreHandle` releases its
 * lock before the next lease merge and before `saveRegistry`, so a live
 * watch/goalie writer can update this same handle in that window before a
 * later restore step fails. Blindly deleting would destroy that concurrent
 * write, and re-deriving the archive slice from whatever the entry holds NOW
 * would overwrite the recovery archive's original bytes with it — a lock per
 * operation is not custody across the whole restore attempt. `expected` (the
 * value this restore itself merged in, captured right after the merge) is
 * the value check standing in for that missing custody: unchanged means
 * safe to undo; changed means someone else has a stake in it now, so this
 * leaves both the live entry and the archive slice untouched and reports the
 * conflict instead of guessing which side should win.
 */
export function undoHandleMerge(path: string, top: string, handle: string, expected: unknown): "removed" | "unchanged-absent" | "conflict" {
  if (!existsSync(path)) return "unchanged-absent";
  return withLock(path, () => {
    const rec = readLoose(path);
    if (!isObject(rec)) return "unchanged-absent";
    const found = handleBucket(rec, top);
    if (!found || !Object.prototype.hasOwnProperty.call(found.bucket, handle)) return "unchanged-absent";
    if (pyDumpSorted(found.bucket[handle]) !== pyDumpSorted(expected)) return "conflict";
    delete found.bucket[handle];
    storeBucket(rec, top, found.bucket, found.asString);
    publish(path, rec);
    return "removed";
  });
}

/**
 * `tap restore`'s merge, under the lease lock: fold every `<sliceDir>/<top>.*.json`
 * into the record's `<top>` bucket, creating the record as `{}` when absent (as
 * the incumbent did) and the bucket as an object when the key is missing.
 */
export function restoreHandle(path: string, top: string, sliceDir: string): void {
  const slices = existsSync(sliceDir)
    ? readdirSync(sliceDir).filter((n) => n.startsWith(`${top}.`) && n.endsWith(".json")).sort()
    : [];
  mkdirSync(dirname(path), { recursive: true });
  withLock(path, () => {
    let rec: Rec = {};
    const parsed = readLoose(path);
    if (isObject(parsed)) rec = parsed;
    // a present key that is not an object (nor a JSON string of one) cannot take a merge:
    // the incumbent's `.update` raised there, and so does this
    if (top in rec && !handleBucket(rec, top)) throw new Error(`${path}: '${top}' is not an object; refusing to merge into it`);
    const found = handleBucket(rec, top) ?? { bucket: {}, asString: false };
    for (const name of slices) {
      // The incumbent read each slice with a bare `json.load(open(path))` inside the
      // loop, no catch, and dumped arm.json only after the loop -- so a bad slice
      // aborted the restore with the record untouched (tap-teardown.sh at
      // 758fa95f1~1). Strict decode keeps that abort. This is the one site where the
      // fix is loud against the SHIPPED port: replacement decode repaired a bad-byte
      // slice and merged it, where the incumbent and this line refuse it (tap-yv3xm).
      const slice = parseRecord(strictText(join(sliceDir, name)));
      if (!isObject(slice)) throw new Error(`${join(sliceDir, name)} is not a JSON object`);
      Object.assign(found.bucket, slice);
    }
    storeBucket(rec, top, found.bucket, found.asString);
    publish(path, rec);
  });
}

/** python's `json.dumps(v, indent=2, sort_keys=True)` for the slice file: keys sorted at every level, ASCII. */
export function pyDumpSorted(v: unknown, depth = 0): string {
  const pad = "  ".repeat(depth + 1);
  const end = "  ".repeat(depth);
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    return `[\n${v.map((x) => pad + pyDumpSorted(x, depth + 1)).join(",\n")}\n${end}]`;
  }
  if (isObject(v)) {
    const keys = Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (!keys.length) return "{}";
    return `{\n${keys.map((k) => `${pad}${ensureAscii(JSON.stringify(k))}: ${pyDumpSorted(v[k], depth + 1)}`).join(",\n")}\n${end}}`;
  }
  if (typeof v === "bigint") return String(v);
  if (v === undefined) return "null";
  return ensureAscii(JSON.stringify(v, exactIntegerReplacer)); // a preserved float prints its source text
}

export function main(argv: string[]): number {
  const [path, action, ...rest] = argv;
  if (!path || !action) throw new Error("usage: watch-lease.ts <arm.json> <snapshot|field <key>|items <key>|set [<key> <value>]...|disarm>");
  switch (action) {
    case "snapshot": {
      if (rest.length) throw new Error("snapshot takes no arguments");
      const lines = snapshotLines(readLoose(path));
      if (lines.length) process.stdout.write(lines.join("\n") + "\n");
      return 0;
    }
    case "field": {
      if (rest.length !== 1) throw new Error("field needs <key>");
      const rec = readLoose(path);
      // absent/unreadable printed nothing at all; a readable record prints the
      // value line even when the key is missing (Python's print("")).
      if (isObject(rec)) process.stdout.write(fieldValue(rec, rest[0]!) + "\n");
      return 0;
    }
    case "items": {
      if (rest.length !== 1) throw new Error("items needs <key>");
      const lines = itemLines(readLoose(path), rest[0]!);
      if (lines.length) process.stdout.write(lines.join("\n") + "\n");
      return 0;
    }
    case "set":
      return set(path, rest);
    case "disarm":
      if (rest.length) throw new Error("disarm takes no arguments");
      disarm(path);
      return 0;
    case "clear-pause": {
      if (rest.length !== 4) throw new Error("clear-pause needs <now> <armed_at> <paused_at> <paused_until>");
      return clearPause(path, rest[0]!, rest[1]!, rest[2]!, rest[3]!);
    }
    case "prune-handle": {
      if (rest.length !== 3) throw new Error("prune-handle needs <top-key> <handle> <slice-dir>");
      pruneHandle(path, rest[0]!, rest[1]!, rest[2]!);
      return 0;
    }
    case "restore-handle": {
      if (rest.length !== 2) throw new Error("restore-handle needs <top-key> <slice-dir>");
      restoreHandle(path, rest[0]!, rest[1]!);
      return 0;
    }
    default:
      throw new Error(`unknown action '${action}'`);
  }
}

if (import.meta.main) {
  try {
    process.exitCode = main(Bun.argv.slice(2));
  } catch (error) {
    process.stderr.write(`tap watch: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
