// The goalie lease record: `<bus>/goalie/arm.json`, one JSON object that every
// `tap goalie` fire reads and that this module's writers rewrite. Migration
// slice G1 moves the record's read/merge/delete and its three seat transactions
// out of tap-goalie.sh -- `_goalie_field`, `_goalie_snapshot`, `_goalie_set`,
// `_goalie_disarm`, `_goalie_reap_to`, `_goalie_observe_seat`,
//   `_goalie_set_request_status`, `_goalie_prune_seats` -- and leaves those Bash
//   names as `_goalie_lease` adapters. R6 U1 moves `tap goalie verdict`'s
//   claim/unclaim pair here as `claimVerdict`/`unclaimVerdict` (in-process only:
//   the Bash heredocs remain the live writers until U3 rewires the verb); the tick
//   body and the loop until G3/G4.
//
// The adapter is `_goalie_lease`, NOT the usual `tap_bun_call`, and that is
// deliberate: `tap_bun_call` maps every nonzero module status to 1 under one
// `slice_failed` message, which would make this module's typed 3 ("no record and
// not allowed to create") and 4 ("generation mismatch") indistinguishable from
// "bun is not installed" -- the infrastructure-failure-as-predicate-answer
// collapse rule 19 forbids (tap-qa6e2). No Bash caller reads 3 or 4 today, which
// is the reason to refuse the collapse now rather than after one starts.
//
// WHY A SECOND MODULE AND NOT A PARAMETER ON watch-lease.ts: the two records
// share the mechanism -- one no-follow lock, one atomic synced publish, one
// exact-integer JSON codec -- and differ in their SCHEMA and their RENDERING.
// The key sets differ, the JSON-field coercion differs (see `coerce` below), and
// the read-side formatters differ observably: this record's `field` prints a JSON
// null as `None` where the watch record's prints empty, and this record's
// `snapshot` faults on a non-object where the watch record's returns no rows.
// Two schemas over one engine is not the second engine rule 1 forbids; a
// `RecordSpec`/`PublishPolicy` options object over one `set` would have been a
// god-parameter that still left the three transactions below unanswered.
// (leader ruling.)
//
// THESE EIGHT SURFACES PUBLISH THROUGH ONE WRITER -- the record as a whole does
// not yet (leader ruling).
//
// Before this slice the record had two production writers with divergent byte
// policies: the Python heredocs these functions replace (compact, no trailing
// newline, publish-only-on-change, an uncaught EISDIR on a directory at the path)
// and `watch-lease.ts publish` via `tap teardown`'s
// `tap_watch_prune_handle`/`restore_handle` (trailing newline, always publish,
// `refuseNonRegular`). "Reproduce the incumbent" had no single referent, so the
// eight surfaces here unify on `publish`. Measured before the change: seed in the
// heredoc's exact form, last byte 0x7d; after `prune-handle`, 0x0a.
//
// WHAT IS STILL OUTSIDE THIS WRITER, because claiming otherwise would be false:
// `tap goalie verdict`'s claim/unclaim pair is ported above as
// `claimVerdict`/`unclaimVerdict`, and since R6 U3 those are the LIVE writers
// (the Bash heredocs they replace wrote this same record with
// `json.dump(separators=(",",":"))` + `os.replace` -- compact, NO
// trailing newline, guarded by `os.path.exists` rather than a regular-file test).
// The port keeps that policy in `publishCompact` rather than normalizing it onto
// `publish`, so when U3 cuts over, a record whose last writer was a verdict still
// ends `}`. Nor is the presence operator
// uniform: the verb-level armed decisions are regular-file, while claim/unclaim
// (`os.path.exists`) and `pruneHandle`/`restoreHandle` (`existsSync`) test mere
// existence. What this slice settles is narrower and real -- the armed test and
// the CREATE GUARD, which used to disagree with each other inside one operation,
// now agree, so a directory at the path is "not armed" and an arming write through
// it is a refusal instead of an uncaught fault.
//
// Every current reader tolerates both byte forms (`json.load` and `parseRecord`
// both accept trailing whitespace) and nothing reads the record's mtime -- the
// heartbeat ages a separate `goalie/heartbeat` file by its CONTENT -- which is why
// a record with two byte policies has not broken anything. Ratified in the PR body
// per rule 18. (Scope corrected after review:
// the first draft of this comment said "ONE WRITER FOR THE RECORD" and
// "regular-file everywhere", both of which overclaimed past the two remaining
// Python writers -- the same census-by-name error this slice's own findings are
// about.)
//
// Grammar:  goalie-lease.ts <arm.json> snapshot
//           goalie-lease.ts <arm.json> field <key>
//           goalie-lease.ts <arm.json> set [<key> <value>]...
//           goalie-lease.ts <arm.json> disarm
//           goalie-lease.ts <arm.json> reap <archive-dir>
//           goalie-lease.ts <arm.json> observe-seat <armed_at> <handle> <now> <activity> <idle> <threshold>
//           goalie-lease.ts <arm.json> request-status <armed_at> <handle> <episode> <status>
//           goalie-lease.ts <arm.json> prune-seats <armed_at> [<handle>...]

import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { pythonInt } from "./pyint";
import { floatSource, isFile, parseRecord, publish, pyInt, pythonStr, readLoose, recordBytes, withLock, type Rec } from "./watch-lease";

/**
 * `numeric` in the heredocs: stored through Python's `int()`, and a `ValueError`
 * stores 0 rather than refusing. `consent_pane_peek` is numeric despite reading
 * as a boolean -- the incumbent wrote `1`.
 */
export const INT_KEYS: ReadonlySet<string> = new Set([
  "armed_at", "threshold_seconds", "tick_interval_seconds", "heartbeat_at",
  "watcher_pid", "consent_pane_peek",
  "deadlock_since", "wake_at", "wake_rung", "exception_until",
]);

/** `json_fields` in the heredocs. Note `ageable_samples` is initialised to `[]` -- a LIST. */
export const JSON_KEYS: ReadonlySet<string> = new Set(["seats", "ageable_samples"]);

/**
 * The generation check this record supports. The watch record offers six; the
 * goalie heredoc reads exactly one env var, and only `_goalie_set` consults it.
 */
export const EXPECTED_ARMED_AT_ENV = "TAP_GOALIE_EXPECT_ARMED_AT";
/** `TAP_GOALIE_ALLOW_CREATE=1` is the only thing that lets a write create the record. */
export const ALLOW_CREATE_ENV = "TAP_GOALIE_ALLOW_CREATE";

const IS_RAW_JSON = (JSON as unknown as { isRawJSON(v: unknown): boolean }).isRawJSON;

/**
 * A record object -- not an array, and NOT the frozen wrapper a preserved float
 * rides in. The wrapper matters: `watch-lease.ts` excludes it for the same reason
 * and the first draft here did not, so a `seats: 1.0` was admitted as a mapping
 * and failed to fault where the incumbent's `.get` raised.
 */
function isObject(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !IS_RAW_JSON(v);
}

/**
 * `floatSource` is imported, not redefined: see `watch-lease.ts`.
 *
 * `parseRecord`'s reviver keeps a float as `JSON.rawJSON(source)` so `1.0` reads
 * back as `1.0` the way `json.load`/`json.dump` round-tripped it. That wrapper is
 * a frozen, NULL-PROTOTYPE object, and `isObject` excludes it -- correctly, so a
 * `seats: 1.0` still fails the mapping test the way the incumbent's `.get` did.
 * The cost is that every Python-semantics helper below has to be TOLD that this
 * object is a number, and the first draft told none of them:
 * `asInt` returned its fallback (so a live `episode_started_at: 101.0` read as 0
 * and the port minted a second episode over it), `goalieStr` reached `String()` on
 * a null-prototype object and threw `No default value` where Python printed the
 * value, and `pyTruthy` fell off the end of its ladder to `true` so a float zero
 * was truthy where Python's `(x or {})` is falsy. review measured
 * all three; they are one omission, so they get one accessor.
 *
 * No TAP writer emits a float into this record. A hand-edited or third-party one
 * does, and the incumbent answered for it, so the port owes the same answers.
 */
/**
 * The numeric value of a JSON scalar under Python's rules, or null if it has none.
 * A `kind` discriminant rather than two disjoint property names: the mixed
 * int-vs-float comparison below narrows only one side with `in`, and the compiler
 * was right to refuse the other.
 */
type PyNumber = { kind: "int"; int: bigint } | { kind: "float"; float: number };
function pyNumber(v: unknown): PyNumber | null {
  if (typeof v === "bigint") return { kind: "int", int: v };
  if (typeof v === "boolean") return { kind: "int", int: v ? 1n : 0n };   // bool subclasses int
  const src = floatSource(v);
  if (src !== null) return { kind: "float", float: Number(src) };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { kind: "int", int: BigInt(v) } : { kind: "float", float: v };
  }
  return null;
}

/**
 * Python's `int(value)` with the incumbent's `except ValueError: 0`. Reuses the
 * shared exact-integer parser so `9007199254740993` survives, and mirrors the
 * heredoc's fallback rather than throwing: a non-integer stored 0.
 */
export function goalieInt(value: string): bigint {
  // `pyInt` IS `pythonInt(value, true) ?? 0n` -- exactly the incumbent's
  // `try: int(value) except ValueError: 0`, including Python's whitespace set,
  // Unicode decimal digits, signs and underscores. The first draft here accepted
  // ASCII digits only and returned 0 for `1_000`, where Python returns 1000.
  // Writing a second, narrower integer parser beside the
  // shared one is the duplication rule 1 is about.
  return pyInt(value);
}

/**
 * Python's `int(x)` where the incumbent did NOT catch -- `map(int, ...)` over
 * argv in `_goalie_observe_seat` raised on a bad argument and killed the call.
 * A CLI argument and an INT_KEY record value are two different contracts, and the
 * first draft used the forgiving one for both, so `observe-seat foo` silently
 * became 0 instead of refusing.
 */
export function goalieIntStrict(name: string, value: string): bigint {
  const parsed = pythonInt(value, true);
  if (parsed === null) throw new Error(`invalid literal for int() with base 10: '${value}' (${name})`);
  return parsed;
}

/**
 * Python's `str()` as `print(value)` and `f"{key}\t{value}"` rendered it. This is
 * where the goalie record diverges from the watch record's `printed`: a JSON null
 * reaches the operator as the four characters `None`, and booleans as `True` /
 * `False`. Preserved deliberately -- `tap goalie status` output is parsed by
 * `goalie-working-zero.test.sh` through the live door.
 */
export function goalieStr(v: unknown): string {
  // `pythonStr` is the shared conversion: a float prints its SOURCE TEXT (where
  // `String(wrapper)` was a `No default value` TypeError), a list or dict prints
  // Python's repr (where `String([100])` was the generation-check bypass `"100"`),
  // and None/True/False are Python's. DECLARED DEVIATION, the one `watch-lease.ts`
  // already carried: a NON-canonical float source (`1E5`) prints as written where
  // Python's `str(float("1E5"))` is `100000.0`. Every float `json.dump` itself
  // emits is canonical, so the deviation needs a hand-edited record to observe.
  //
  // `field` and `snapshot` do NOT come through here for a container -- the
  // incumbent printed `json.dumps(...)` for a dict or list and `print(value)`
  // otherwise, so those two call `compactJson` explicitly. Two renderings of one
  // value, by site, exactly as the incumbent had them.
  return pythonStr(v);
}

/** `json.dumps(v, separators=(",", ":"))` for the dict/list branch of `field`/`snapshot`. */
function compactJson(v: unknown): string {
  return recordBytes(v);
}

/**
 * Store a CLI value under this record's coercion.
 *
 * The JSON branch is "ANY successfully parsed JSON, else `{}`" -- NOT "an object,
 * else `{}`". `tap_goalie_on` writes `ageable_samples '[]'` through this same
 * branch and must get a LIST; `seats '[1]'` stores a list too, which the seat
 * transactions read as an empty map and `observe-seat` replaces. Only a PARSE
 * FAILURE becomes `{}`.
 * (leader ruling; measured five ways.)
 */
export function coerce(key: string, value: string): unknown {
  if (INT_KEYS.has(key)) return goalieInt(value);
  if (JSON_KEYS.has(key)) {
    try { return parseRecord(value); } catch { return {}; }
  }
  return value;
}

/**
 * Python `==` over JSON values, for the change guards the transactions carry.
 * Cross-type numeric comparison is deliberate: Python holds `1 == 1.0`, and our
 * codec yields bigint for an exact integer and a `JSON.rawJSON` WRAPPER for a
 * float -- not a Number, which is what this comment used to say and why the
 * `Number.isInteger` branches below never saw a float at all. A structural `===`
 * would report a spurious change and rewrite `1.0` to `1` where the incumbent left
 * it alone. The comparison stays EXACT past 2^53: a float equals an integer only
 * when it is integral, and `BigInt(<integral double>)` is exact.
 */
export function pyEqual(a: unknown, b: unknown): boolean {
  // Python: `True == 1` and `False == 0`. bool is a subclass of int, so a record
  // holding `true` compares equal to one holding 1 and the incumbent's change
  // guard would NOT have published. Missed in the first draft (partner review).
  const an = pyNumber(a), bn = pyNumber(b);
  if (an || bn) {
    if (!an || !bn) return false;                       // a number never equals a str/list/dict
    if (an.kind === "int" && bn.kind === "int") return an.int === bn.int;
    if (an.kind === "float" && bn.kind === "float") return an.float === bn.float;
    // Mixed: EXACT past 2^53 without going through Number. A float equals an
    // integer only when it is integral, and `BigInt(<integral double>)` is exact.
    const i = an.kind === "int" ? an.int : (bn as { int: bigint }).int;
    const f = an.kind === "float" ? an.float : (bn as { float: number }).float;
    return Number.isFinite(f) && Number.isInteger(f) && BigInt(f) === i;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => pyEqual(x, b[i]));
  }
  if (isObject(a) || isObject(b)) {
    if (!isObject(a) || !isObject(b)) return false;
    const ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    // Python dict equality ignores insertion order; so does this.
    return ak.every((k) => k in b && pyEqual(a[k], b[k]));
  }
  return a === b;
}

// --- the read side ------------------------------------------------------------

/**
 * `_goalie_field`: the Bash guard was `[ -f "$path" ] || return 0`, so a
 * directory, a fifo or an absent path printed NOTHING; a malformed record also
 * printed nothing (`except: sys.exit(0)`). A readable record prints the value
 * line even for a missing key, because `print("")` still emits the newline.
 */
export function field(path: string, key: string): string | null {
  const rec = readLoose(path);
  if (!isObject(rec)) return null;
  const v = key in rec ? rec[key] : "";
  return isObject(v) || Array.isArray(v) ? compactJson(v) : goalieStr(v);
}

/**
 * `_goalie_snapshot`: `for key, value in record.items()`. `.items()` on a valid
 * NON-OBJECT record (a top-level list or scalar) raises `AttributeError` in the
 * incumbent, so this throws rather than returning no rows -- the watch record's
 * `snapshotLines` returns `[]` there, and that difference is why the formatters
 * are per-record. An absent or malformed record is no rows, as `sys.exit(0)` was.
 */
export function snapshotLines(path: string): string[] {
  const raw = readLoose(path);
  if (raw === undefined) return [];
  if (!isObject(raw)) throw new Error(`goalie lease record is not an object: ${path}`);
  return Object.entries(raw).map(([k, v]) =>
    `${k}\t${isObject(v) || Array.isArray(v) ? compactJson(v) : goalieStr(v)}`);
}

// --- the write side -----------------------------------------------------------

/**
 * `_goalie_set`: merge `key value` pairs under the record's lock.
 *
 * Presence is `isFile` -- a REGULAR file -- for both the create guard and
 * `tap goalie status`'s armed test, per the leader's condition 3. The incumbent
 * disagreed with itself here: `_goalie_is_armed` was `[ -f ]` while this guard
 * was `os.path.exists`, so a directory at the path read as "disarmed" to the verb
 * and as "present" to the mutator, which then died uncaught in `os.replace`.
 * Unifying on `isFile` + `publish`'s `refuseNonRegular` makes a directory
 * consistently absent-then-refused. Exit codes are the incumbent's: 3 = no record
 * and not allowed to create, 4 = generation mismatch.
 */
export function set(path: string, pairs: string[], env: NodeJS.ProcessEnv = process.env): 0 | 3 | 4 {
  const allowCreate = env[ALLOW_CREATE_ENV] === "1";
  mkdirSync(dirname(path), { recursive: true });
  return withLock(path, () => {
    if (!isFile(path) && !allowCreate) return 3;
    const raw = readLoose(path);
    // A record that PARSED but is not an object is not an empty record. The
    // incumbent did `rec = json.load(...)` and then `rec.get(...)`, so a
    // top-level list or scalar reached `.get` and raised -- leaving the record
    // untouched. The first draft here collapsed it to `{}` and published,
    // DESTROYING the file (partner review measured `[]` being rewritten).
    //
    // The fault is conditional on actually reaching a `.get`, which is the
    // incumbent's shape and not an approximation of it: with no pairs and no
    // EXPECTED check, the loop body never runs, `changed` is false, and the
    // incumbent exits 0 without faulting and without writing.
    const expected = env[EXPECTED_ARMED_AT_ENV];
    if (raw !== undefined && !isObject(raw)) {
      const reaches_get = expected !== undefined || pairs.length >= 2;
      if (reaches_get) {
        throw new Error(`goalie lease record is not an object: ${describe(raw)} has no attribute 'get'`);
      }
      return 0; // parsed, non-object, nothing to merge: the incumbent's silent exit 0
    }
    const rec: Rec = isObject(raw) ? (raw as Rec) : {};
    if (expected !== undefined && goalieStr("armed_at" in rec ? rec["armed_at"] : "") !== expected) return 4;
    // The incumbent's `changed` flag did TWO jobs and only one of them is dropped.
    //
    // (a) Whether to PUBLISH: gone. The record has one writer now and that writer
    //     always publishes (leader ruling …T220043Z). Nothing reads this record's
    //     mtime -- the heartbeat ages `goalie/heartbeat` by its CONTENT -- so the
    //     extra write is not consumer-observable. Declared, with a control.
    //
    // (b) Whether to ASSIGN the key: KEPT, because it is content, not bytes.
    //     `if rec.get(key) != value: rec[key] = value` skips the assignment when
    //     the value is already equal, and the case that matters is a JSON field
    //     set to `null` on a record where the key is ABSENT: `rec.get(key)` is
    //     already `None`, so `None != None` is false and the key stays absent.
    //     Dropping this guard too would store an explicit `"seats": null`, which
    //     a reader CAN see -- `field` prints an empty line for an absent key and
    //     the four characters `None` for a present null. Caught by this module's
    //     own differential after the migration partner named the case
    //     (…T215608Z: "setting a missing JSON key to null can leave the key
    //     absent because Python's rec.get(key) is already None").
    // An EXISTING record that did not parse is not an empty record either. This is
    // the fifth defect of the class the partner reviewer opened, found by a reviewer
    // at the place I told him to look: `readLoose` answers `undefined` for
    // unreadable bytes exactly as it does for an absent file, so the non-object
    // fault above does not fire, `rec` becomes `{}`, and an unconditional publish
    // would write `{}` OVER the garbage and destroy it.
    const existedUnreadable = isFile(path) && raw === undefined;

    let assigned = false;
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const key = pairs[i]!;
      const value = coerce(key, pairs[i + 1]!);
      // `null`, not `undefined`, is the absent sentinel: the incumbent compared
      // `rec.get(key)`, which yields Python's `None` for a missing key. With
      // `undefined` the null-on-absent-key case would compare unequal and assign,
      // which is the very divergence this guard exists to prevent.
      if (!pyEqual(key in rec ? rec[key] : null, value)) { rec[key] = value; assigned = true; }
    }

    // The incumbent's `changed = not os.path.exists(path)` starts FALSE for an
    // existing record, so with nothing assigned it exits 0 and leaves the bytes
    // untouched. Measured: `{not json` + no pairs -> rc 0, bytes unchanged; the same
    // record WITH pairs -> rc 0 and the garbage replaced by the pairs, which is what
    // we already do.
    //
    // This does NOT reinstate the general `changed` short-circuit the unification
    // ruling dropped, and the line between them is the point: republishing content
    // we successfully READ is harmless (identical bytes, and the declared D1
    // deviation), while publishing over content we could NOT read is destructive.
    // Always-publish is safe exactly when the record's content is known.
    if (existedUnreadable && !assigned) return 0;

    publish(path, rec);
    return 0;
  });
}

/**
 * `_goalie_disarm`: remove the record and any `arm.json.tmp` beside it, under the
 * lock.
 *
 * The `.tmp` removal is NOT vestigial after the unification, and it is not a
 * leftover to sweep: `publish` cleans its own temp in its failure path, so no NEW
 * residue can appear, but a machine upgrading across G1 can still carry an
 * `arm.json.tmp` written by the old Bash writer before the upgrade. This is
 * transition cleanup with a finite life; it goes when the rule-45 bead lands.
 */
export function disarm(path: string): void {
  const stale = `${path}.tmp`;
  if (!existsSync(path) && !existsSync(stale)) return;
  mkdirSync(dirname(path), { recursive: true });
  withLock(path, () => {
    for (const candidate of [path, stale]) {
      try { unlinkSync(candidate); } catch { /* the incumbent swallowed OSError */ }
    }
  });
}

/**
 * `_goalie_reap_to`: move the whole `goalie/` home to `<archive>/goalie`, holding
 * `arm.json.lock` -- which lives INSIDE the directory being renamed. Ported
 * as-is: the lock travels with the tree, which is a different lifetime from the
 * watch record's `disarm` (that one keeps its lock file in place). An absent home
 * is a silent success, as `[ -d "$home" ] || return 0` was.
 */
export function reapTo(path: string, archiveDir: string): void {
  const home = dirname(path);
  if (!existsSync(home) || !statSync(home).isDirectory()) return;
  const dst = join(archiveDir, "goalie");
  withLock(path, () => {
    if (!statSync(home).isDirectory()) return;
    mkdirSync(dirname(dst), { recursive: true });
    // `shutil.rmtree(dst, ignore_errors=True)` removes only a REAL directory tree.
    // A plain file survives it (NotADirectoryError, swallowed), and so does a
    // symlink (rmtree refuses one outright); the `os.rename` that follows then
    // raises ENOTDIR UNCAUGHT, so the incumbent exits 1 and leaves the source home
    // where it is. `force: true` deleted that file and then succeeded -- the port
    // destroyed a path the incumbent declined to touch. An EFFECT divergence, not a
    // byte one. `lstatSync`, not `statSync`: a
    // symlink TO a directory must not qualify.
    let dstIsRealDir = false;
    try { dstIsRealDir = lstatSync(dst).isDirectory(); } catch { dstIsRealDir = false; }
    if (dstIsRealDir) rmSync(dst, { recursive: true, force: true });
    renameSync(home, dst);
  });
}

/** What `observe-seat` prints when it mints an episode: `<now>\t<token>`. */
export type Minted = { now: bigint; token: string } | null;

/**
 * `_goalie_observe_seat`: the per-seat idle state machine, under the lock.
 *
 * Exit 3 covers BOTH an absent record and a malformed one (the incumbent's
 * `except Exception: sys.exit(3)`), which is a different mapping from
 * `request-status`/`prune-seats` below -- they answer 0 for the same inputs. Exit
 * 4 is the generation mismatch, compared NUMERICALLY here (`int(rec.get(...) or 0)`)
 * where the other two compare as strings. Both asymmetries are the incumbent's.
 */
export function observeSeat(
  path: string, armedAt: bigint, seat: string, now: bigint, activity: bigint, idle: boolean, threshold: bigint,
  mintToken: () => string = () => randomBytes(16).toString("hex"),
): { rc: 0 | 3 | 4; minted: Minted } {
  return withLock(path, () => {
    if (!isFile(path)) return { rc: 3 as const, minted: null };
    const raw = readLoose(path);
    // UNREADABLE keeps the typed exit; a record that PARSED into a non-mapping faults.
    if (raw === undefined) return { rc: 3 as const, minted: null };
    const rec = refuseNonMapping(raw, path);
    if (asInt(rec["armed_at"]) !== armedAt) return { rc: 4 as const, minted: null };

    const seats = seatsFor(rec);
    const priorRaw = seats[seat];
    const prior: Rec = isObject(priorRaw) ? (priorRaw as Rec) : {};
    // `activity = min(now, max(armed_at, activity))` -- clamped into the episode.
    const clamped = activity < armedAt ? armedAt : activity > now ? now : activity;

    let current: Rec;
    let minted: Minted = null;
    if (!idle) {
      current = {
        floor_at: now, last_activity_at: now, episode_started_at: 0n,
        episode_token: "", request_status: "", verdict_at: 0n, verdict_action: "",
        verdict_target: "", verdict_reason: "",
      };
    } else {
      const floor = maxBig(armedAt, asInt(prior["floor_at"], armedAt));
      const previous = maxBig(floor, asInt(prior["last_activity_at"], floor));
      const latest = maxBig(floor, clamped);
      current = { ...prior };
      if (latest > previous) {
        current = {
          floor_at: latest, episode_started_at: 0n,
          episode_token: "", request_status: "", verdict_at: 0n, verdict_action: "",
          verdict_target: "", verdict_reason: "",
        };
      }
      current["last_activity_at"] = latest;
      if (!("floor_at" in current)) current["floor_at"] = floor;
      if (!("episode_started_at" in current)) current["episode_started_at"] = 0n;
      if (now - latest >= threshold && asInt(current["episode_started_at"]) === 0n) {
        const token = mintToken();
        current["episode_started_at"] = now;
        current["episode_token"] = token;
        current["request_status"] = "sending";
        current["verdict_at"] = 0n;
        current["verdict_action"] = "";
        current["verdict_target"] = "";
        current["verdict_reason"] = "";
        minted = { now, token };
      }
    }

    // `if prior != current` -- Python dict equality, so a reordering alone does
    // not publish. The guard is the transaction's own semantics and survives the
    // publish unification, which governs BYTES, not whether a write happens.
    if (!pyEqual(prior, current)) {
      seats[seat] = current;
      rec["seats"] = seats;
      publish(path, rec);
    }
    return { rc: 0 as const, minted };
  });
}

/**
 * `_goalie_set_request_status`: stamp one seat's `request_status`.
 *
 * Answers 0 for absent, malformed, and both generation mismatches -- it is
 * advisory and never blocks its caller. Note the incumbent's shape: `state` is
 * `(rec.get("seats") or {}).get(seat) or {}`, so for an ABSENT seat it is a fresh
 * object that is mutated and then dropped, and the record is still republished
 * with no semantic change. Preserved: the publish happens, the content does not
 * move. Both generation checks are STRING comparisons here.
 */
export function setRequestStatus(path: string, armedAt: string, seat: string, episode: string, status: string): 0 {
  withLock(path, () => {
    if (!isFile(path)) return;
    const raw = readLoose(path);
    if (raw === undefined) return;                  // unreadable stays advisory-0
    const rec = refuseNonMapping(raw, path);
    const seats = seatsFor(rec);
    // `state = seats.get(seat) or {}` -- the trailing `or {}`
    // is TRUTHINESS, so an existing but EMPTY `{}` seat is falsy and Python
    // mutated a DETACHED dict, dropping the change. The first draft attached by
    // type, so an empty seat gained `request_status` where the incumbent did not
    // (partner review). A truthy non-dict seat state faults, as `.get` did.
    const stateRaw = seats[seat];
    const attached = isObject(stateRaw) && pyTruthy(stateRaw);
    const state: Rec = attached ? (stateRaw as Rec) : {};
    // ORDER IS THE CONTRACT. The incumbent's condition is
    //   `str(rec.get("armed_at","")) != armed_at or str(state.get(...)) != episode`
    // and Python's `or` evaluates left to right and STOPS, so a generation mismatch
    // returns 0 with a corrupt seat state never touched. Validating the seat state
    // eagerly -- as the first draft did -- faults on input the incumbent answered 0
    // for. A malformed `seats` is not a
    // fault, so the seat-state check is the only one that can still throw here.
    if (goalieStr("armed_at" in rec ? rec["armed_at"] : "") !== armedAt) return;
    if (stateRaw !== undefined && !isObject(stateRaw) && pyTruthy(stateRaw)) {
      throw new Error(`goalie seat state is not an object: ${describe(stateRaw)} has no attribute 'get'`);
    }
    if (goalieStr("episode_started_at" in state ? state["episode_started_at"] : "") !== episode) return;
    state["request_status"] = status;
    if (attached) seats[seat] = state;
    publish(path, rec);
  });
  return 0;
}

/**
 * `_goalie_prune_seats`: keep only the named handles.
 *
 * `kept` is built by iterating the ACTIVE list, so a publish re-keys `seats` into
 * the caller's order -- observable in the bytes but not in any reader. The
 * `kept == seats` guard is Python dict equality, which ignores order, so a pure
 * reorder does NOT publish. Answers 0 for absent, malformed and mismatch.
 */
export function pruneSeats(path: string, armedAt: string, active: string[]): 0 {
  withLock(path, () => {
    if (!isFile(path)) return;
    const raw = readLoose(path);
    if (raw === undefined) return;                  // unreadable stays advisory-0
    const rec = refuseNonMapping(raw, path);
    if (goalieStr("armed_at" in rec ? rec["armed_at"] : "") !== armedAt) return;
    const seats = seatsFor(rec);
    const kept: Rec = {};
    for (const seat of active) if (seat in seats) kept[seat] = seats[seat];
    if (pyEqual(kept, seats)) return;
    rec["seats"] = kept;
    publish(path, rec);
  });
  return 0;
}

// --- the verdict transactions (R6 U1) ------------------------------------------

/**
 * `secrets.compare_digest(str(state.get("episode_token") or ""), token)`. The
 * stored value is Python-truthy-or-empty and then `str()`'d (`goalieStr`), and the
 * comparison runs over BYTES: `timingSafeEqual` throws on unequal lengths where
 * the incumbent's `compare_digest` answers False, so the length guard IS the port
 * of the unequal-length mismatch the brief pins. The byte comparison is the ASCII
 * path ONLY: `compare_digest` refuses a non-ASCII str outright -- TypeError,
 * either operand, unequal length or not -- and that malformed-token disposition is
 * preserved as a throw before any comparison, not collapsed into "mismatch"
 * (review round 1: the port answers for hand-edited records the same way the
 * incumbent did).
 */
function tokensMatch(stored: unknown, supplied: string): boolean {
  const want = pyTruthy(stored) ? goalieStr(stored) : "";
  if (!isAscii(want) || !isAscii(supplied)) {
    throw new TypeError("comparing strings with non-ASCII characters is not supported");
  }
  const a = Buffer.from(want, "utf8");
  const b = Buffer.from(supplied, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Python's str-level ASCII test at the compare_digest door: every code point below 128. */
function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
}

/**
 * The verdict pair's publication, which is the ONE byte policy `publish` does not
 * have and must not absorb: the incumbent wrote the FIXED name `arm.json.tmp` with
 * `json.dump(rec, separators=(",", ":"))` -- compact, NO trailing newline, default
 * file mode, no fsync -- and `os.replace`d it over the record. Preserved as
 * written, so a record whose last writer was a verdict still ends `}` and the
 * U3 cutover changes no bytes at this door.
 */
function publishCompact(path: string, rec: Rec): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, recordBytes(rec));
  renameSync(tmp, path);
}

/**
 * `_goalie_claim_verdict` (pinned 68dcc90:1344): stamp the verdict onto an open
 * episode, under the same `arm.json.lock` domain as every other writer. Exit
 * codes are the incumbent's: 3 = absent or unreadable record (the `except
 * Exception` arms), 4 = no matching open episode -- absent seat, a non-dict
 * state, wrong episode, or wrong token -- and 5 = the episode is already closed
 * (`verdict_at >= episode`, equality included). `now`/`episode` are Python's
 * plain `int()`: a bad literal raises, exactly where the uncaught ValueError did.
 * The condition short-circuits left to right, and the short-circuits are
 * LOAD-BEARING: a non-dict state answers 4 without reading the state, a wrong
 * episode answers 4 without the token compare or the `verdict_at` read, so a
 * corrupt value in an unevaluated position never faults.
 */
export function claimVerdict(
  path: string, now: string, seat: string, episode: string, token: string,
  action: string, target: string, reason: string,
): 0 | 3 | 4 | 5 {
  const nowN = goalieIntStrict("now", now);
  const episodeN = goalieIntStrict("episode", episode);
  return withLock(path, () => {
    if (!existsSync(path)) return 3;                 // `os.path.exists`, not a regular-file test
    const raw = readLoose(path);
    if (raw === undefined) return 3;                 // `except Exception: sys.exit(3)`
    const rec = refuseNonMapping(raw, path);         // a parsed non-object faults, as `.get` did
    const seats = seatsFor(rec);
    const stateRaw = seats[seat];
    if (!isObject(stateRaw)) return 4;               // `not isinstance(state, dict)`
    const state = stateRaw;
    if (asInt(state["episode_started_at"]) !== episodeN) return 4;
    if (!tokensMatch(state["episode_token"], token)) return 4;
    if (asInt(state["verdict_at"]) >= episodeN) return 5;
    state["verdict_at"] = nowN;
    state["verdict_action"] = action;
    state["verdict_target"] = target;
    state["verdict_reason"] = reason;
    publishCompact(path, rec);
    return 0;
  });
}

/**
 * `_goalie_unclaim_verdict` (pinned 68dcc90:1368): withdraw the stamp when the
 * send after the claim failed, under the same lock. Advisory, as its caller's
 * failure path needs it to be: absent, unreadable, wrong episode, wrong token, or
 * a stamp other than the episode's `verdict_at` all answer 0 and write NOTHING.
 * `stamp`/`episode` are plain `int()` again, and the checks short-circuit the same
 * way. `state` carries the incumbent's trailing `or {}`: an existing but EMPTY
 * seat is falsy, so the checks read a DETACHED dict and (never passing) nothing is
 * written, while a truthy non-dict faults at `.get` exactly as it did -- the same
 * truthiness trap `setRequestStatus` documents, with the opposite disposition.
 */
export function unclaimVerdict(path: string, stamp: string, seat: string, episode: string, token: string): 0 {
  const stampN = goalieIntStrict("stamp", stamp);
  const episodeN = goalieIntStrict("episode", episode);
  return withLock(path, () => {
    if (!existsSync(path)) return 0;
    const raw = readLoose(path);
    if (raw === undefined) return 0;
    const rec = refuseNonMapping(raw, path);
    const seats = seatsFor(rec);
    const stateRaw = seats[seat];
    if (pyTruthy(stateRaw) && !isObject(stateRaw)) {
      throw new Error(`goalie seat state is not an object: ${describe(stateRaw)} has no attribute 'get'`);
    }
    const state: Rec = pyTruthy(stateRaw) ? (stateRaw as Rec) : {};
    if (asInt(state["episode_started_at"]) !== episodeN) return 0;
    if (!tokensMatch(state["episode_token"], token)) return 0;
    if (asInt(state["verdict_at"]) !== stampN) return 0;
    state["verdict_at"] = 0n;
    state["verdict_action"] = "";
    state["verdict_target"] = "";
    state["verdict_reason"] = "";
    publishCompact(path, rec);
    return 0;
  });
}

/**
 * Python truthiness over JSON values. The seat-state reads (`state.get(seat) or {}`)
 * and `int(x or <default>)` turn on TRUTHINESS, not on type: an empty seat is
 * falsy and a stored `0` takes the default.
 */
export function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === "bigint") return v !== 0n;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  // BEFORE the mapping test: `isObject` excludes the float wrapper, so a float fell
  // through to the `true` tail and `0.0` was truthy. Both zeros are falsy in Python.
  const src = floatSource(v);
  if (src !== null) return Number(src) !== 0;
  if (isObject(v)) return Object.keys(v).length > 0;
  return true;
}

/**
 * The seat map every seat transaction reads. A `seats` value that is not a plain
 * object -- a list, a number, a string, `null`, or a preserved float -- holds no
 * seat data, so it reads as an empty map; the answer is the same for observe,
 * request-status, prune, claim and unclaim, and for the goalie tick's delivery
 * health. `observe-seat` writes a seat, so it publishes a fresh mapping in the
 * old value's place and the next tick finds a well-formed record. Nothing
 * readable is lost, and refusing instead would leave the goalie unable to mint
 * an episode until someone repaired the record by hand.
 */
export function seatsFor(rec: Rec): Rec {
  const raw = rec["seats"];
  return isObject(raw) ? raw : {};
}

/**
 * `int(x or <default>)`, which is how all four incumbent sites are spelled
 * (pinned `:253`, `:262`, `:263`, `:273`). The `or` is load-bearing in both
 * directions: a FALSY stored value takes the default, and a TRUTHY unparseable one
 * RAISES. `_goalie_observe_seat`'s only `except` wraps `json.load`, so that raise
 * is uncaught -- the incumbent exits 1 and writes nothing.
 *
 * The first draft returned `fallback` for anything it did not recognize, which
 * healed a stored `"oops"` to 0 and then minted an episode and published. Being
 * forgiving here is not conservative: it invents a value and writes it down.
 */
function asInt(v: unknown, fallback: bigint = 0n): bigint {
  if (!pyTruthy(v)) return fallback;                // `x or <default>`
  const num = pyNumber(v);
  if (num) return num.kind === "int" ? num.int : truncFloat(num.float);
  if (typeof v === "string") {
    const parsed = pythonInt(v, true);
    if (parsed !== null) return parsed;
    throw new Error(`invalid literal for int() with base 10: '${v}'`);
  }
  throw new Error(`int() argument must be a string, a bytes-like object or a real number, not ${describe(v)}`);
}

/** `int(<float>)` -- truncation toward zero, and Python's OverflowError for a non-finite. */
function truncFloat(n: number): bigint {
  if (!Number.isFinite(n)) throw new Error("cannot convert float infinity to integer");
  return BigInt(Math.trunc(n));
}

/**
 * A record that parsed but is not a mapping, which is NOT the same input as one
 * that failed to parse.
 *
 * `json.load("[]")` SUCCEEDS, so the incumbent's `except Exception` never fires and
 * the next `rec.get(...)` raises AttributeError -- uncaught, rc 1. Only an
 * UNPARSEABLE file reaches that `except` and its typed exit. `snapshotLines` already
 * modelled the split and said so in its comment; the three seat transactions
 * collapsed a parsed non-object into the malformed disposition (3, or 0), so one port
 * gave two answers to one question. Resolved toward the oracle and toward this
 * file's own snapshot handling, not by picking a nicer contract.
 */
function refuseNonMapping(raw: unknown, path: string): Rec {
  if (isObject(raw)) return raw as Rec;
  throw new Error(`goalie lease record is not an object: ${describe(raw)} has no attribute 'get' (${path})`);
}

/** A value's shape, for the fault messages above. */
function describe(v: unknown): string {
  if (v === null) return "None";
  if (Array.isArray(v)) return "a list";
  if (typeof v === "string") return "a str";
  if (typeof v === "boolean") return "a bool";
  if (floatSource(v) !== null) return "an int/float";
  return typeof v === "number" || typeof v === "bigint" ? "an int/float" : "a non-mapping";
}
function maxBig(a: bigint, b: bigint): bigint { return a > b ? a : b; }

export function main(argv: string[]): number {
  const [path, action, ...rest] = argv;
  if (!path || !action) throw new Error("usage: goalie-lease.ts <arm.json> <snapshot|field <key>|set …|disarm|reap <dir>|observe-seat …|request-status …|prune-seats …>");
  switch (action) {
    case "snapshot": {
      if (rest.length) throw new Error("snapshot takes no arguments");
      const lines = snapshotLines(path);
      if (lines.length) process.stdout.write(lines.join("\n") + "\n");
      return 0;
    }
    case "field": {
      if (rest.length !== 1) throw new Error("field needs <key>");
      const line = field(path, rest[0]!);
      if (line !== null) process.stdout.write(line + "\n");
      return 0;
    }
    case "set":
      return set(path, rest);
    case "disarm":
      if (rest.length) throw new Error("disarm takes no arguments");
      disarm(path);
      return 0;
    case "reap": {
      if (rest.length !== 1) throw new Error("reap needs <archive-dir>");
      reapTo(path, rest[0]!);
      return 0;
    }
    case "observe-seat": {
      if (rest.length !== 6) throw new Error("observe-seat needs <armed_at> <handle> <now> <activity> <idle> <threshold>");
      const [armedAt, seat, now, activity, idle, threshold] = rest as [string, string, string, string, string, string];
      const { rc, minted } = observeSeat(
        path, goalieIntStrict("armed_at", armedAt), seat, goalieIntStrict("now", now),
        goalieIntStrict("activity", activity), idle === "1", goalieIntStrict("threshold", threshold));
      if (minted) process.stdout.write(`${minted.now}\t${minted.token}\n`);
      return rc;
    }
    case "request-status": {
      if (rest.length !== 4) throw new Error("request-status needs <armed_at> <handle> <episode> <status>");
      return setRequestStatus(path, rest[0]!, rest[1]!, rest[2]!, rest[3]!);
    }
    case "prune-seats": {
      if (!rest.length) throw new Error("prune-seats needs <armed_at> [<handle>...]");
      return pruneSeats(path, rest[0]!, rest.slice(1));
    }
    default:
      throw new Error(`unknown action '${action}'`);
  }
}

if (import.meta.main) {
  try {
    process.exitCode = main(Bun.argv.slice(2));
  } catch (error) {
    process.stderr.write(`tap goalie: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
