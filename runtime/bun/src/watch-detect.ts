// Pure rules of the watch tick's pane detectors (slice W2a). Every function here is a
// port of a python heredoc or a shell pipeline that `tap-watch.sh` used to fork per
// seat per tick, and each keeps the incumbent's BYTES: the JSON maps below are
// written back into `arm.json` fields, so key order, integer exactness, the two
// separator styles python used, and its `ensure_ascii` escaping are all part of
// the contract the frozen-capture oracle replays (runtime/bun/test/watch-detect*).
//
// Nothing in this file reads a pane, the registry, the bus or the lease; the
// detector runners (`watch-detectors.ts`) do that through their seams and call
// these rules.

import { createHash } from "node:crypto";

import { ensureAscii } from "./fsatomic";
import { pythonInt } from "./pyint";
import { pyFloatRepr } from "./spool-publication";

// --- ordered JSON ---------------------------------------------------------------
//
// python dicts keep insertion order for EVERY key; a JS object moves integer-like
// keys ("42") to the front. A handle can be all digits, and the maps here are keyed
// by handle, so they are Maps end to end, parsed and printed by hand. Numbers keep
// their source text (a BigInt when integral, so 9007199254740993 survives; a float
// is carried as its literal) the way watch-lease.ts's parseRecord keeps them.

export type JsonValue = null | boolean | string | bigint | JsonFloat | JsonValue[] | JsonMap;
export type JsonMap = Map<string, JsonValue>;
/** A float literal carried as text: python printed it back as written (`1.0` stays `1.0`). */
export interface JsonFloat { readonly float: string }

export function isMap(v: JsonValue | undefined): v is JsonMap { return v instanceof Map; }

class Parser {
  private i = 0;
  constructor(private readonly s: string) {}
  parse(): JsonValue {
    this.ws();
    const v = this.value();
    this.ws();
    if (this.i !== this.s.length) throw new SyntaxError(`trailing data at ${this.i}`);
    return v;
  }
  private ws(): void { while (this.i < this.s.length && " \t\n\r".includes(this.s[this.i]!)) this.i++; }
  private value(): JsonValue {
    const c = this.s[this.i];
    if (c === "{") return this.object();
    if (c === "[") return this.array();
    if (c === '"') return this.string();
    if (c === "t" && this.s.startsWith("true", this.i)) { this.i += 4; return true; }
    if (c === "f" && this.s.startsWith("false", this.i)) { this.i += 5; return false; }
    if (c === "n" && this.s.startsWith("null", this.i)) { this.i += 4; return null; }
    return this.number();
  }
  private object(): JsonMap {
    const m: JsonMap = new Map();
    this.i++; this.ws();
    if (this.s[this.i] === "}") { this.i++; return m; }
    for (;;) {
      this.ws();
      if (this.s[this.i] !== '"') throw new SyntaxError(`expected a key at ${this.i}`);
      const k = this.string();
      this.ws();
      if (this.s[this.i] !== ":") throw new SyntaxError(`expected ':' at ${this.i}`);
      this.i++; this.ws();
      m.set(k, this.value()); // a repeated key: last wins, first position kept -- python's dict
      this.ws();
      if (this.s[this.i] === ",") { this.i++; continue; }
      if (this.s[this.i] === "}") { this.i++; return m; }
      throw new SyntaxError(`expected ',' or '}' at ${this.i}`);
    }
  }
  private array(): JsonValue[] {
    const a: JsonValue[] = [];
    this.i++; this.ws();
    if (this.s[this.i] === "]") { this.i++; return a; }
    for (;;) {
      this.ws();
      a.push(this.value());
      this.ws();
      if (this.s[this.i] === ",") { this.i++; continue; }
      if (this.s[this.i] === "]") { this.i++; return a; }
      throw new SyntaxError(`expected ',' or ']' at ${this.i}`);
    }
  }
  private string(): string {
    // JSON.parse does the escapes exactly; find the closing quote by hand
    let j = this.i + 1;
    while (j < this.s.length) {
      const c = this.s[j];
      if (c === "\\") { j += 2; continue; }
      if (c === '"') break;
      if (c === "\n") throw new SyntaxError(`control character in string at ${j}`);
      j++;
    }
    if (j >= this.s.length) throw new SyntaxError("unterminated string");
    const out = JSON.parse(this.s.slice(this.i, j + 1)) as string;
    this.i = j + 1;
    return out;
  }
  private number(): bigint | JsonFloat {
    // python's json.loads also takes NaN, Infinity and -Infinity (and dumps them back as such)
    for (const lit of ["NaN", "Infinity", "-Infinity"]) {
      if (this.s.startsWith(lit, this.i)) { this.i += lit.length; return { float: lit }; }
    }
    const m = /^-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(this.s.slice(this.i));
    if (!m) throw new SyntaxError(`unexpected token at ${this.i}`);
    this.i += m[0].length;
    if (m[1] === undefined && m[2] === undefined) return BigInt(m[0]);
    return { float: m[0] };
  }
}

/** python `json.loads`; throws on anything python would refuse (callers map that to `{}` where the incumbent did). */
export function loads(text: string): JsonValue { return new Parser(text).parse(); }

/** `json.loads(text or "{}")` inside `try/except: {}`: an unreadable text is `{}`; a readable non-dict is kept, as python kept it. */
export function loadsOr(text: string | undefined): JsonValue {
  if (!text) return new Map();
  try { return loads(text); } catch { return new Map(); }
}

/**
 * The same read followed by the first dict operation (`.get`, `.pop`, `[k] =`):
 * python RAISED on a list, a string, a number or None there, so a readable
 * non-dict is a thrown error, never an empty map.
 */
export function loadsMapOr(text: string | undefined): JsonMap {
  const v = loadsOr(text);
  if (!isMap(v)) throw new TypeError(`'${pyTypeName(v)}' object has no dict operations`);
  return v;
}

export function pyTypeName(v: JsonValue): string {
  if (v === null) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "bigint") return "int";
  if (typeof v === "string") return "str";
  if (Array.isArray(v)) return "list";
  if (v instanceof Map) return "dict";
  return "float";
}

/**
 * python `json.dumps(value)` with the default separators (`, ` / `: `) or the
 * compact ones (`,` / `:`), `ensure_ascii=True`, and python's float/bool/None spellings.
 */
export function dumps(value: JsonValue, compact: boolean): string {
  const [comma, colon] = compact ? [",", ":"] : [", ", ": "];
  const go = (v: JsonValue): string => {
    if (v === null) return "null";
    if (v === true) return "true";
    if (v === false) return "false";
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "string") return ensureAscii(JSON.stringify(v));
    if (Array.isArray(v)) return `[${v.map(go).join(comma)}]`;
    if (v instanceof Map) return `{${[...v].map(([k, x]) => `${ensureAscii(JSON.stringify(k))}${colon}${go(x)}`).join(comma)}}`;
    return pyFloat(v.float);
  };
  return go(value);
}

/** python's `float.__repr__` of a JSON float literal, as `json.dumps` prints it: A's formatter (spool-publication.ts), not a second one. */
function pyFloat(literal: string): string {
  if (literal === "NaN" || literal === "Infinity" || literal === "-Infinity") return literal;
  return pyFloatRepr(Number(literal));
}

/** python `int(x)` of a JSON value: raises (throws) where python raised. */
export function pyInt(v: JsonValue | undefined): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "string") return pyIntArg(v);
  if (v === true) return 1n;
  if (v === false) return 0n;
  if (v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v) && !(v instanceof Map)) {
    const n = Number(v.float);
    if (!Number.isFinite(n)) throw new Error(`cannot convert float ${v.float} to integer`);
    return BigInt(Math.trunc(n)); // int(1.9) == 1
  }
  throw new TypeError(`int() argument must be a string, a bytes-like object or a real number, not ${v === null ? "'NoneType'" : "'list'"}`);
}

/** `try: int(x) except Exception: None`. */
export function pyIntOrNull(v: JsonValue | undefined): bigint | null {
  try { return pyInt(v); } catch { return null; }
}

/** python truthiness of a JSON value (`not cur.get("fired")`). */
export function pyTruthy(v: JsonValue | undefined): boolean {
  if (v === undefined || v === null || v === false) return false;
  if (v === true) return true;
  if (typeof v === "bigint") return v !== 0n;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map) return v.size > 0;
  return Number(v.float) !== 0;
}

/** `$( ... )`: a command substitution drops NUL bytes (bash warns and ignores them) and every trailing newline. */
export function cmdSubst(text: string): string { return text.replace(/\0/g, "").replace(/\n+$/, ""); }

/** python `str(x)` for a printed field value: a string as-is, otherwise `repr(x)`. */
export function pyStr(v: JsonValue | undefined): string {
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  return pyRepr(v);
}

/**
 * python `repr(x)` of a JSON value: `None`/`True`/`False`, ints, floats by their repr,
 * strings in python's quoting (single quotes unless the text has a single quote and no
 * double quote; `\\`, `\n`, `\r`, `\t` and other controls escaped), lists and dicts with
 * `, ` and `: `. Containers print this way from `print(rec.get(field, ""))`, where the
 * deleted program printed `['x', None, True]` rather than JSON (review P3).
 */
export function pyRepr(v: JsonValue): string {
  if (v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return pyStrRepr(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (v instanceof Map) return `{${[...v].map(([k, x]) => `${pyStrRepr(k)}: ${pyRepr(x)}`).join(", ")}}`;
  // repr(float('nan')) is `nan`, inf is `inf`/`-inf` -- by the parsed VALUE, so a legal
  // exponent overflow (`1e309`) prints `inf` too; json.dumps keeps NaN/Infinity/-Infinity
  // (partner review C1)
  const n = Number(v.float);
  if (Number.isNaN(n)) return "nan";
  if (n === Infinity) return "inf";
  if (n === -Infinity) return "-inf";
  return pyFloat(v.float);
}

function pyStrRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${quote}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${cp.toString(16).padStart(2, "0")}`;
    else if (cp >= 0x80 && cp <= 0xa0) out += `\\x${cp.toString(16)}`;
    else if (!isPyPrintable(ch)) out += cp > 0xffff ? `\\U${cp.toString(16).padStart(8, "0")}` : `\\u${cp.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out + quote;
}

/** python `str.isprintable()` for one character, over the categories repr escapes: separators (but space) and Other. */
function isPyPrintable(ch: string): boolean {
  if (ch === " ") return true;
  return !/[\p{Zs}\p{Zl}\p{Zp}\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(ch);
}

// --- text helpers -----------------------------------------------------------------

/** `tap_strip_ansi`: python's `re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)`. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

/** `tap_sha256`: `shasum -a 256` of the bytes, lowercase hex. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// python's `\s` on str is `str.isspace()`: JS `\s` lacks \x1c-\x1f and \x85 and
// includes U+FEFF, so the class is spelled out -- a BOM before "esc to interrupt"
// must NOT read as whitespace, exactly as it did not for the incumbent.
const PY_S = "[\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
// python's `\d` on str is any Unicode decimal digit (Nd); `int()` reads them all.
const PY_D = "\\p{Nd}";

const WORKING_TIMER = new RegExp(
  `Working${PY_S}*\\(${PY_S}*(?:(${PY_D}+)h${PY_S}*)?(?:(${PY_D}+)m${PY_S}*)?(?:(${PY_D}+)s${PY_S}*)?[•·-]${PY_S}*esc to interrupt${PY_S}*\\)`,
  "iu",
);

/** `int()` of a run of Unicode decimal digits: every Nd run is a contiguous 0-9 block. */
export function unicodeInt(digits: string): bigint {
  let out = 0n;
  for (const ch of digits) {
    const cp = ch.codePointAt(0)!;
    if (!/\p{Nd}/u.test(ch)) throw new Error(`invalid literal for int() with base 10: ${JSON.stringify(digits)}`);
    // every Nd run is a full, aligned 0-9 block; adjacent runs (the mathematical
    // digits) make the count below a multiple of ten plus the digit's own value
    let below = 0;
    for (let c = cp - 1; c >= 0 && /\p{Nd}/u.test(String.fromCodePoint(c)); c--) below++;
    out = out * 10n + BigInt(below % 10);
  }
  return out;
}

/**
 * `_watch_codex_working_seconds`: the codex status line `Working (1h 2m 3s • esc to
 * interrupt)` as seconds; null when there is no timer or no unit at all (python
 * exited silently on `not any(m.groups())`).
 */
export function codexWorkingSeconds(text: string): bigint | null {
  const m = WORKING_TIMER.exec(text);
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return null;
  const h = m[1] === undefined ? 0n : unicodeInt(m[1]);
  const mi = m[2] === undefined ? 0n : unicodeInt(m[2]);
  const s = m[3] === undefined ? 0n : unicodeInt(m[3]);
  return h * 3600n + mi * 60n + s;
}

/** `grep -vE 'Working \(.*esc to interrupt'` (ERE, per line; `.` never crosses a newline). */
export function withoutWorkingLines(text: string): string {
  if (text === "") return "";
  const lines = text.split("\n");
  // grep reads the input as lines; a trailing newline does not add an empty line
  const trailing = text.endsWith("\n");
  const kept = (trailing ? lines.slice(0, -1) : lines).filter((l) => !/Working \(.*esc to interrupt/.test(l));
  return kept.length ? kept.join("\n") + "\n" : "";
}

/**
 * `sed -E 's/^.*esc interrupt/<spinner> esc interrupt/'` per line -- the opencode
 * spinner collapsed. sed keeps a missing final newline missing (measured against
 * the platform's sed by the differential test, not assumed).
 */
export function collapseSpinner(text: string): string {
  if (text === "") return "";
  const lines = text.split("\n");
  const trailing = text.endsWith("\n");
  const body = (trailing ? lines.slice(0, -1) : lines).map((l) => l.replace(/^.*esc interrupt/, "<spinner> esc interrupt"));
  return body.join("\n") + (trailing ? "\n" : "");
}

/**
 * `case "$x" in *[![:space:]]*)`: does the text carry a non-space character.
 * lib.sh pins LC_CTYPE=en_US.UTF-8 when it is sourced (it unsets LC_ALL), so the
 * incumbent's `[:space:]` was the PLATFORM's `iswspace`: on Darwin the six ASCII
 * spaces, U+00A0, U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F and U+3000
 * (JS `\s` without U+FEFF); glibc excludes the three non-breaking spaces (U+00A0,
 * U+2007, U+202F), which are ink there. \x1c-\x1f, \x85, U+180E, U+200B and a BOM
 * are ink on both. The port keeps each platform's own set -- the differential test
 * measures bash on whichever platform runs it, so a wrong table reds there
 * (partner review A3).
 */
export function hasInk(text: string): boolean { return process.platform === "linux" ? LINUX_INK.test(text) : DARWIN_INK.test(text); }
const DARWIN_INK = /[^\t\n\v\f\r \xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
const LINUX_INK = /[^\t\n\v\f\r \u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]/;

// --- the sample maps ----------------------------------------------------------------

/** `_watch_sample_forget`: drop a seat's baseline; compact bytes. */
export function sampleForget(samples: string, handle: string): string {
  const m = loadsMapOr(samples);
  m.delete(handle);
  return dumps(m, true);
}

export interface FreezeResult { fire: boolean; frozen: bigint; samples: string }

/**
 * `_watch_freeze_step`: one step of the shared freeze state machine. A changed body
 * hash re-baselines the seat and re-arms one advisory; a stable hash held for
 * >= window fires ONCE (the `fired` latch); with requireAdvance the parsed clock
 * must be strictly greater than the prior sample. `timer` is the incumbent's
 * argv string ("" when there was no clock).
 */
export function freezeStep(samples: string, handle: string, now: bigint, hash: string, timer: string, window: bigint, requireAdvance: boolean): FreezeResult {
  const s = loadsMapOr(samples);
  const cur = s.get(handle);
  let fire = false;
  let frozen = 0n;
  if (!isMap(cur) || cur.get("hash") !== hash) {
    s.set(handle, new Map<string, JsonValue>([["at", now], ["hash", hash], ["timer", timer], ["fired", 0n]]));
  } else {
    // python: int(cur.get("at", now)) -- an unreadable `at` RAISED and the step printed
    // nothing (the caller's `$( )` then read an empty control line); that is a thrown
    // error here, which the runner reports the way the incumbent's `set -e` did
    frozen = now - pyInt(cur.has("at") ? cur.get("at") : now);
    let advancing = true;
    if (requireAdvance) {
      const t0 = pyIntOrNull(cur.get("timer"));
      const t1 = pyIntOrNull(timer);
      advancing = t0 !== null && t1 !== null && t1 > t0;
    }
    if (frozen >= window && advancing && !pyTruthy(cur.get("fired"))) { fire = true; cur.set("fired", 1n); }
    cur.set("timer", timer);
    s.set(handle, cur);
  }
  return { fire, frozen, samples: dumps(s, true) };
}

// --- the blocked map (JSON object of handle -> {reason, since, reset_at}) ----------

/** `_watch_blocked_keys`: the handles, one per line (a trailing newline after each, as `print` gave). */
export function blockedKeys(map: string): string {
  const v = loadsOr(map);
  if (v instanceof Map) return [...v.keys()].map((k) => `${k}\n`).join("");
  if (Array.isArray(v)) return v.map((x) => `${pyStr(x)}\n`).join(""); // `for h in d` over a list
  if (typeof v === "string") return [...v].map((c) => `${c}\n`).join("");
  throw new TypeError(`'${pyTypeName(v)}' object is not iterable`);
}

/** `_watch_blocked_field`: `(d.get(handle) or {}).get(field, "")` printed. */
export function blockedField(map: string, handle: string, field: string): string {
  const rec = loadsMapOr(map).get(handle);
  if (rec === undefined || !pyTruthy(rec)) return ""; // `or {}`
  if (!isMap(rec)) throw new TypeError(`'${pyTypeName(rec)}' object has no attribute 'get'`);
  return rec.has(field) ? pyStr(rec.get(field)) : "";
}

/** `_watch_blocked_upsert`: set `{reason, since, reset_at}` with `since`/`reset_at` as `int()`; compact bytes. */
export function blockedUpsert(map: string, handle: string, reason: string, since: string, resetAt: string): string {
  const m = loadsMapOr(map);
  m.set(handle, new Map<string, JsonValue>([["reason", reason], ["since", pyIntArg(since)], ["reset_at", pyIntArg(resetAt)]]));
  return dumps(m, true);
}

/** `_watch_blocked_remove`: drop the handle; compact bytes. */
export function blockedRemove(map: string, handle: string): string {
  const m = loadsMapOr(map);
  m.delete(handle);
  return dumps(m, true);
}

/**
 * python `int(argv)`: the whitespace int() strips (NOT str.strip()'s: \x1c-\x1f,
 * U+200B and a BOM raise), Unicode decimal digits, an optional sign, single
 * underscores between digit groups -- `pyint.ts`'s pythonInt, the one
 * implementation the lease record's INT_KEYS already coerce through; a malformed
 * prior timer must read as unknown, never as a number that licenses an advisory
 * (review).
 */
export function pyIntArg(text: string): bigint {
  const v = pythonInt(text, true);
  if (v === null) throw new Error(`invalid literal for int() with base 10: ${JSON.stringify(text)}`);
  return v;
}

/**
 * The context-pressure sample upsert: `rows[handle] = {'pane': pane}; json.dumps(rows)`
 * -- DEFAULT separators, and a bare `json.loads` (no try/except): an unreadable map
 * raised, which is a thrown error here.
 */
export function pressureRemember(samples: string, handle: string, pane: string): string {
  const v = loads(samples);
  if (!isMap(v)) throw new TypeError("'list' object does not support item assignment");
  v.set(handle, new Map<string, JsonValue>([["pane", pane]]));
  return dumps(v, false);
}

/**
 * `alerts[key] = int(now)`; compact. `_watch_process_codex_livelock`'s two mark heredocs
 * differ on the read: the episode mark is `try/except: {}` (an unreadable map starts
 * empty), the progress mark is a bare `json.loads` (an unreadable map raises). Both
 * raise on a readable non-dict at the assignment. `strict` selects the progress mark.
 */
export function alertMark(alerts: string, key: string, now: bigint, strict = false): string {
  let v: JsonValue;
  if (strict) v = loads(alerts);
  else v = loadsOr(alerts);
  if (!isMap(v)) throw new TypeError(`'${pyTypeName(v)}' object does not support item assignment`);
  v.set(key, now);
  return dumps(v, true);
}

/**
 * `key not in alerts` -- python exit 0 when absent. The livelock detector asks this
 * twice with different error handling: the first read is `try/except: {}` (an
 * unreadable map reads as "absent"), the progress read is bare (an unreadable map
 * RAISES, and the `&&` chain reads that as "not absent"). `strict` selects the second.
 */
export function alertAbsent(alerts: string, key: string, strict = false): boolean {
  let v: JsonValue;
  if (strict) { try { v = loads(alerts); } catch { return false; } }
  else v = loadsOr(alerts);
  if (v instanceof Map) return !v.has(key);
  if (Array.isArray(v)) return !v.some((x) => x === key);
  if (typeof v === "string") return !v.includes(key);
  if (strict) return false; // `in` on a number/bool/None raises -> exit 1 -> "not absent"
  throw new TypeError(`argument of type '${pyTypeName(v)}' is not iterable`);
}

// --- CLI: the blocked-map steps the still-Bash tick and blocked pass reach by name ------
//
//   watch-detect.ts blocked-keys   <map>
//   watch-detect.ts blocked-field  <map> <handle> <field>
//   watch-detect.ts blocked-upsert <map> <handle> <reason> <since> <reset_at>
//   watch-detect.ts blocked-remove <map> <handle>
//
// Each prints what its python printed (keys one per line; a value, a map, each
// with a trailing newline). A python raise is one `tap watch: <error>` line and
// status 1 -- the caller's `$( )` under set -e then ends the tick as it did.

export function main(argv: string[]): number {
  const [verb, ...rest] = argv;
  const need = (n: number, usage: string): void => { if (rest.length < n) throw new Error(`usage: watch-detect.ts ${usage}`); };
  switch (verb) {
    case "blocked-keys": need(1, "blocked-keys <map>"); process.stdout.write(blockedKeys(rest[0]!)); return 0;
    case "blocked-field": need(3, "blocked-field <map> <handle> <field>"); process.stdout.write(`${blockedField(rest[0]!, rest[1]!, rest[2]!)}\n`); return 0;
    case "blocked-upsert": need(5, "blocked-upsert <map> <handle> <reason> <since> <reset_at>"); process.stdout.write(`${blockedUpsert(rest[0]!, rest[1]!, rest[2]!, rest[3]!, rest[4]!)}\n`); return 0;
    case "blocked-remove": need(2, "blocked-remove <map> <handle>"); process.stdout.write(`${blockedRemove(rest[0]!, rest[1]!)}\n`); return 0;
    default: throw new Error(`watch-detect.ts: unknown action ${JSON.stringify(verb ?? "")}`);
  }
}

if (import.meta.main) {
  try { process.exit(main(process.argv.slice(2))); } catch (error) {
    process.stderr.write(`tap watch: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
