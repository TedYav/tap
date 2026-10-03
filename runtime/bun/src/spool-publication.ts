// The ONE writer of a spool pair: `spool/<id>.md` (the parked body) and
// `spool/<id>.meta.json` (its accounting sidecar). Ported from lib.sh
// `tap_spool_add` (Bash prologue + an inline Python program) as a strangler-fig
// slice; the Bash function is now a thin adapter that gathers the facts other
// functions own (team, window, last verified delivery) and calls this module.
//
// Publication order is load-bearing: the BODY is published before the
// METADATA, and a drain that snapshots the spool between the two must not
// condemn the pair (spool-publication-binding). A failure at either write, or
// at the sidecar lock, leaves the sender's canonical payload where it was —
// the caller (`tap_spool_park_placed`) owns the claim across the whole pair and
// unlinks canonical only after both files exist.
//
// The decision table below (hold / deadline / waiter_lifetime /
// deadline_source) is the Python program's, branch for branch. Its comments are
// kept where the branch shape is the point; the rest of the archaeology lives
// in git history and CONTRACT.md. Where Python and JavaScript disagree on a
// conversion — `int()` on a JSON value, `str.strip()`, `or` chains, key
// presence versus null — the Python rule is reproduced explicitly, because the
// meta file is read back by Python and Bash readers that were written against
// that rule.

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseUnicodeDecimal } from "./unicode-decimal";
import { atomicWrite, lockNameFits } from "./fsatomic";
import { acquirePathLock } from "./panelock";

/** A bounded idle wait for a staged sentinel after an unverified drain attempt. */
export function stagedIdleWindowSeconds(env: Record<string, string | undefined> = process.env): number {
  const raw = env.TAP_STAGED_IDLE_SUBMIT_WINDOW;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  return 1800;
}

/** Twin of lib.sh `TAP_ID_RE`; the id names two files, so the charset is the whole gate. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** tap-13c8: the tail bound for a readiness-gate (busy) park, fleet-shaped and tunable. */
const BUSY_DEADLINE_DEFAULT = 300;

export type ReasonClass = "busy" | "safety_gate" | "window";

/**
 * Twin of the retired `tap_spool_reason_class`: the timeout-fire branch a
 * reason takes must be mechanical. copy-mode is a SAFETY concern (injecting
 * would send raw keys); a window park is a rate limit the courier applied to a
 * READY pane (tap-7r3fn.20), so calling it busy would mint a readiness-gate
 * deadline for a seat that was never unavailable; everything else is an
 * ordinary busy-pane wait.
 */
export function reasonClass(reason: string): ReasonClass {
  if (reason === "copy-mode") return "safety_gate";
  if (reason === "window") return "window";
  return "busy";
}

export interface PublishInput {
  spoolDir: string;
  id: string;
  /** Sender's canonical payload; copied byte-for-byte, never moved. */
  canonical: string;
  target: string;
  team: string;
  reason: string;
  /** Empty derives from `reason`. */
  reasonClass: string;
  timeoutSeconds: string;
  pane: string;
  paneId: string;
  toTeam: string;
  policy: string;
  graceSeconds: string;
  targetRegistry: string;
  /** Resolved by the caller from policy/team/handle; empty or invalid reads as 10. */
  windowSeconds: string;
  /** Last VERIFIED delivery epoch for the recipient; empty means "due now". */
  lastDelivered: string;
  cueStyle: string;
  cueRedAt: string;
  env?: NodeJS.ProcessEnv;
  /** Wall clock, injectable for tests only; production never reads TAP_SPOOL_NOW here. */
  now?: Date;
  /** Metadata-sidecar wait; see METADATA_LOCK_TIMEOUT_MS. Tests use 0 so a holder refuses at once. */
  lockTimeoutMs?: number;
}

/**
 * How long publication waits for the entry's metadata sidecar before refusing.
 *
 * A DECLARED NARROWING, not a port artifact. The incumbent took this lock with
 * `fcntl.flock(lock, LOCK_EX)` — an UNBOUNDED wait — so a wedged holder stalled
 * the send with no receipt and no end. A bounded wait converts that silent
 * seat-wide hang into a refusal the caller sees and reports. The repo already
 * treats bounded-vs-unbounded AT THIS LOCK as a contract-visible decision: the
 * live-probe counter's 0.5s bound is argued in CONTRACT.md on both sides.
 *
 * THE NUMBER IS MEASURED, not inherited from `acquirePathLock`'s pane-lock
 * default. The legitimate hold is the critical section every writer of this
 * sidecar runs — acquire, read the meta, mutate, atomic-replace, release — and
 * 2000 rounds of exactly that on a loaded 16-core box (load1m 39) gave a median
 * of 0.27 ms, a p99 of 2.03 ms and a worst case of 41 ms. Five seconds is ~122x
 * that worst case. Process wall time would have been the wrong instrument:
 * interpreter startup inflates it and never holds the lock.
 *
 * WHAT A REFUSAL COSTS, so nobody has to reconstruct it from the call chain:
 * `tap_spool_add` returns nonzero, `tap_spool_park_placed` releases its
 * publication claim and fails with `spool_publish_failed`, exit 1, and the
 * sender's canonical payload is retained. The message's EXISTING `.placed`
 * attribution remains and is not this refusal's to remove — both send doors
 * place canonical first (`courier.ts` `canonicalPlaceLocked`; Bash
 * `tap_canonical_place`), so a park never runs before placement. What does not
 * happen is `.sent` and any INJECTION. "No pane effect" would be too strong:
 * the Bash direct-send door cancels copy mode before parking (`tap-send.sh`,
 * gated off for `--polite`, `--no-spool` and auto-permission seats; the native
 * door never cancels copy mode), so that one mutation may already have been
 * applied. It delivers nothing, which is why it does not arm the retry rule.
 * Publication is reached only from
 * certified PRE-effect outcomes (`lock_busy`, `band_busy`, `rate_limited`,
 * `copy_mode`, `clearing` — CONTRACT.md "Native-route parks use the same engine
 * as Bash"), so a refused park carries `effect=none` and re-sending that id
 * cannot duplicate DELIVERY: never retrying after a possible effect
 * (skills/tap/protocol/delivery/reliability.md) is satisfied by the ordering,
 * not by a promise. Placement is not delivery.
 */
export const METADATA_LOCK_TIMEOUT_MS = 5000;

export class PublishError extends Error {}

/** Bash `[ -f <path> ]`: exists, and is a regular file. Symlinks resolve. */
function isRegularFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

type Json = null | boolean | number | string | PyFloat | PyInt | Json[] | { [key: string]: Json };

// --- Python conversion twins ------------------------------------------------

// Python `str.isspace()`: Unicode White_Space plus the C0 separators 1C-1F.
const PY_SPACE = /[\t-\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;

// THE TWO TRIM SETS ARE NOT THE SAME SET (partner review, A1). `str.strip()`
// removes the C0 separators 1C-1F; `int()` and `float()` REJECT them. Measured
// against CPython: `int("\x1c7\x1f")` raises ValueError while the same string's
// `.strip()` returns `"7"`. Using one rule for both made this module accept a
// `TAP_SPOOL_BUSY_DEADLINE_SECONDS` the incumbent refuses — minting a 7-second
// readiness tail where the incumbent takes its 300-second default.
// `delivery-clock.ts`'s `integer()` already draws this distinction with its
// `separators` flag; the rule is restated here because this module parses its
// own inputs rather than borrowing that one.
const PY_NUMERIC_SPACE = /[\t-\r \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;

function trimBy(value: string, space: RegExp): string {
  let start = 0, end = value.length;
  while (start < end && space.test(value[start]!)) start++;
  while (end > start && space.test(value[end - 1]!)) end--;
  return value.slice(start, end);
}

/** Python `str.strip()`, not JS `trim()`: a BOM is not whitespace to Python. */
export function pyStrip(value: string): string {
  return trimBy(value, PY_SPACE);
}

/** The surrounding whitespace `int()` and `float()` accept — 1C-1F excluded. */
function numericStrip(value: string): string {
  return trimBy(value, PY_NUMERIC_SPACE);
}

/** One Unicode decimal digit to its ASCII form; a non-digit passes through for the shape check. */
function asciiDigits(text: string): string {
  let out = "";
  for (const ch of text) {
    const value = /\p{Nd}/u.test(ch) ? parseUnicodeDecimal(ch) : null;
    out += value === null ? ch : String(value);
  }
  return out;
}

/**
 * Python `int(<str>)`: surrounding whitespace, one optional sign, Unicode
 * decimal digits with single underscores between digit groups. Anything else
 * raises, which here is `null`.
 */
export function pyIntString(raw: string): number | null {
  const digits = asciiDigits(numericStrip(raw));
  if (!/^[+-]?\d(?:_?\d)*$/.test(digits)) return null;
  return Number(digits.replaceAll("_", ""));
}

/** Python `int(<json value>)`: numbers truncate toward zero, bools are 0/1, strings parse, the rest raise. */
export function pyInt(value: unknown): number | null {
  if (value instanceof PyFloat) return pyInt(value.value);
  if (value instanceof PyInt) return Number(value.source);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === "string") return pyIntString(value);
  return null;
}

/** Python `float(<str>)` for the probe delay: decimal, exponent, inf/nan spellings, underscores. */
export function pyFloatString(raw: string): number | null {
  const text = numericStrip(raw).toLowerCase();
  const special = text.replace(/^[+-]/, "");
  if (special === "inf" || special === "infinity") return text.startsWith("-") ? -Infinity : Infinity;
  if (special === "nan") return NaN;
  const digits = asciiDigits(text);
  if (!/^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:e[+-]?\d(?:_?\d)*)?$/.test(digits)) return null;
  return Number(digits.replaceAll("_", ""));
}

/**
 * Python truthiness over parsed JSON values, INCLUDING the two wrappers the
 * preserving parser produces: `0.0` and `-0.0` are falsy floats, and a big
 * integer is never zero. `[]` and `{}` are falsy too — a reader that tests
 * only the primitive zero lets an empty container through as "present"
 * (`escalated_at: 0.0` read as set and skipped the
 * escalation the incumbent performs).
 */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (value instanceof PyFloat) return value.value !== 0;
  if (value instanceof PyInt) return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}
const truthy = pyTruthy;

/** Python `a or b or ""` over JSON values: the first truthy operand, else "". */
function orChain(...values: unknown[]): Json {
  for (const value of values) if (truthy(value)) return value as Json;
  return "";
}

/**
 * Python `a + b` with `b` an int: a float operand yields a float (and keeps
 * its `.0` on the way out), an int past 2^53 adds exactly, a bool is 0/1, and
 * anything else raises. The two wrapper branches exist because the existing
 * sidecar is now read by the preserving parser: a carried
 * `first_spooled_epoch: 1789458100.0` reaches this addition as a `PyFloat`,
 * and refusing it turned a park the incumbent completes into a refusal after
 * the body write (eight oracle scenarios).
 */
function add(a: unknown, b: number, what: string): Json {
  if (a instanceof PyFloat) return new PyFloat(a.value + b);
  if (a instanceof PyInt) return new PyInt((BigInt(a.source) + BigInt(b)).toString());
  if (typeof a !== "number" && typeof a !== "boolean") throw new PublishError(`${what}: unsupported operand type`);
  return Number(a) + b;
}

export function busyDeadlineSeconds(env: NodeJS.ProcessEnv): number {
  const raw = env.TAP_SPOOL_BUSY_DEADLINE_SECONDS ?? "";
  const value = pyIntString(raw);
  if (value === null) return BUSY_DEADLINE_DEFAULT;
  // A zero or negative bound would make every park instantly overdue: refuse
  // it and say so, because a silently ignored knob is worse than a rejected one.
  if (value > 0) return value;
  process.stderr.write(
    `tap: TAP_SPOOL_BUSY_DEADLINE_SECONDS=${raw} refused (legal domain: integer seconds > 0); using the ${BUSY_DEADLINE_DEFAULT}s default. A non-positive bound would make every park instantly overdue.\n`,
  );
  return BUSY_DEADLINE_DEFAULT;
}

/** Receipt timing must not prevent the durable park on an invalid override. */
function probeDelay(env: NodeJS.ProcessEnv): number {
  const tokens = env.TAP_SPOOL_DELIVERER_DELAYS || "0.25";
  const first = tokens.split(PY_SPACE).find(token => token !== "");
  if (first === undefined) return 0.25;
  const value = pyFloatString(first);
  if (value === null || !(0 <= value && value < Infinity)) return 0.25;
  return value;
}

// A non-regular sidecar (a FIFO, a device) is ABSENT, not refused: `readFileSync`
// on a FIFO blocks forever under the lock, and the atomic rename over it replaces
// the node with a fresh regular file. That is the deliberate asymmetry with the
// canonical, which REFUSES when non-regular because it is the caller's payload
// and never ours to replace. The incumbent (`os.path.exists` then `json.load`)
// hung on the same FIFO, so this is a declared narrowing, not parity (tap-ahpdi).
function readOldMeta(path: string): Record<string, Json> {
  if (!isRegularFile(path)) return {};
  let parsed: unknown;
  // The PRESERVING parser, not `JSON.parse`: every field this function carries
  // forward unchanged (`first_spooled_epoch`, `hold_until_epoch`, `deadline_epoch`,
  // `attempt_fence`, …) is written back by `metaBytes`, and a whole float read as
  // a plain number comes back without its `.0` — the read-modify-write defect
  // `bumpAttempts` was fixed for, on publication's own door.
  try { parsed = parseJsonPreserving(readFileSync(path, "utf8")); } catch { return {}; }
  // A parsed non-object made every `old.get` raise in Python: the pair is not overwritten blind.
  if (!isDict(parsed)) throw new PublishError("existing metadata is not an object");
  return parsed as Record<string, Json>;
}

/** The registry team name as Python read it: a string, stripped; anything else is "". */
function registryTeamName(registryPath: string): string {
  try {
    const registry = JSON.parse(pyReadUtf8(registryPath)) as unknown;
    if (registry === null || typeof registry !== "object") return "";
    const team = (registry as { team?: unknown }).team;
    if (!truthy(team)) return "";
    if (typeof team !== "object" || Array.isArray(team)) return "";
    const name = (team as { name?: unknown }).name;
    if (!truthy(name)) return "";
    return typeof name === "string" ? pyStrip(name) : "";
  } catch { return ""; }
}

/**
 * A float that must serialize the way Python's `json` writes one: a whole
 * number keeps its `.0`. `next_probe_epoch` is `int + float` in the incumbent,
 * so it is ALWAYS a float there — invisible at the 0.25 default, visible the
 * moment `TAP_SPOOL_DELIVERER_DELAYS` starts with a whole number, where
 * JSON.stringify would emit `1789458205` against Python's `1789458205.0`.
 * Readers coerce, but the pair is also read by Python, and a type that changes
 * with an operator's env value is not parity.
 */
export class PyFloat {
  constructor(readonly value: number) {}
  /** Python `float.__repr__`. */
  repr(): string { return pyFloatRepr(this.value); }
}

/**
 * An integer whose JSON token does not survive a JavaScript number: past 2^53
 * `JSON.parse` rounds it and `String()` writes the rounded value back. Python
 * reads and writes it exactly, so a carried field holding one must round-trip
 * as its source text. The one arithmetic this file does on it — the deadline
 * addition in `add` — is exact through BigInt; `pyInt` on it is lossy by
 * construction and says so.
 */
export class PyInt {
  constructor(readonly source: string) {}
}

/**
 * Python's `isinstance(x, dict)` over the preserving parser's output. A
 * `PyFloat` or `PyInt` wrapper is a JavaScript object, so the shape
 * `typeof x === "object" && !Array.isArray(x)` admits a document whose whole
 * text is `1.0`, `NaN` or a wide integer — and Python's `.get`/`__setitem__`
 * on that value raised. Every dictionary guard on parsed JSON uses this.
 */
export function isDict(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof PyFloat) && !(value instanceof PyInt);
}

/**
 * Python `repr(float)`: the shortest round-trip digits (the same digits
 * JavaScript produces — both implement Steele-White/Ryu-class shortest
 * printing), laid out by PYTHON'S rules, which differ from JavaScript's in
 * exactly two places: the switch to exponent notation happens at 1e16 and
 * 1e-4 rather than 1e21 and 1e-6, and the exponent carries a sign and at
 * least two digits (`1e+16`, `1e-07`). Whole values keep a `.0`. `NaN`,
 * `Infinity` and `-Infinity` are the `json.dump(allow_nan=True)` spellings.
 */
export function pyFloatRepr(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const sign = value < 0 ? "-" : "";
  // `toExponential()` with no argument is the shortest unique representation.
  const [mantissa, exponent] = Math.abs(value).toExponential().split("e") as [string, string];
  const digits = mantissa.replace(".", "");
  const decpt = Number(exponent) + 1; // value = 0.<digits> × 10^decpt
  if (decpt > 16 || decpt < -3) {
    const body = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const e = decpt - 1;
    return `${sign}${body}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
  }
  if (decpt <= 0) return `${sign}0.${"0".repeat(-decpt)}${digits}`;
  if (decpt >= digits.length) return `${sign}${digits}${"0".repeat(decpt - digits.length)}.0`;
  return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
}

/**
 * Parse a sidecar the way Python does, preserving what `JSON.parse` would
 * erase: `1789458205.0` is a FLOAT and comes back with its `.0`; an integer
 * past 2^53 keeps its digits. The reviver's `context.source` is the original
 * token, which is the only place either distinction survives parsing.
 */
/** A JSON string literal, or one of the three bare tokens Python's scanner accepts and JSON.parse does not. */
const PY_NONFINITE_OR_STRING = /"(?:[^"\\]|\\.)*"|-?Infinity|NaN/g;

export function parseJsonPreserving(text: string): unknown {
  // `json.loads` reads `NaN`, `Infinity` and `-Infinity` — the spellings
  // `json.dump(allow_nan=True)` and `pyFloatRepr` write — where JSON.parse
  // refuses. Each bare token outside a string becomes a nonce-tagged string
  // the reviver turns back into the float; the string alternative in the
  // regex consumes literals whole, so a token INSIDE a string is untouched.
  // A tagged KEY is `{NaN: 1}`, which Python rejects, so the reviver throws.
  const tag = `\u0000${Math.random().toString(36).slice(2)}\u0000`;
  const rewritten = text.replace(PY_NONFINITE_OR_STRING, m => (m.startsWith('"') ? m : JSON.stringify(tag + m)));
  return JSON.parse(rewritten, (key, value, context?: { source: string }) => {
    if (key.startsWith(tag)) throw new SyntaxError(`Expecting property name: ${key.slice(tag.length)}`);
    if (typeof value === "string" && value.startsWith(tag)) {
      const token = value.slice(tag.length);
      return new PyFloat(token === "NaN" ? NaN : token === "Infinity" ? Infinity : -Infinity);
    }
    if (typeof value !== "number" || !context?.source) return value;
    if (/[.eE]/.test(context.source)) return new PyFloat(value);
    if (!Number.isSafeInteger(value)) return new PyInt(context.source);
    return value;
  });
}

/** The sidecar as an object, or a refusal: Python's `old.get` raised on anything else. */
export function parseMetaPreservingFloats(text: string): Record<string, unknown> {
  const parsed = parseJsonPreserving(text);
  if (!isDict(parsed)) throw new Error("sidecar is not an object");
  return parsed as Record<string, unknown>;
}

/** Python `str` ordering: by code point, where JavaScript's default compares UTF-16 units. */
export function pyStrCompare(a: string, b: string): number {
  const ia = a[Symbol.iterator](), ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next(), y = ib.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0)!, cy = y.value.codePointAt(0)!;
    if (cx !== cy) return cx - cy;
  }
}

/**
 * Python `json.dumps(str)` with `ensure_ascii=True`: `"` and `\` escaped, the
 * five short escapes, every other code unit outside 0x20–0x7E as `\uXXXX` —
 * including DEL (0x7F), which `JSON.stringify` leaves raw, and each half of a
 * surrogate pair on its own, which is why this walks CODE UNITS.
 */
export function pyJsonString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c === 0x09) out += "\\t";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x0c) out += "\\f";
    else if (c >= 0x20 && c <= 0x7e) out += value[i];
    else out += `\\u${c.toString(16).padStart(4, "0")}`;
  }
  return `${out}"`;
}

/**
 * Python `json.dump(indent=2, sort_keys=True)` plus the trailing newline,
 * rendered DIRECTLY from the value tree.
 *
 * Earlier versions serialized with `JSON.stringify` and then substituted float
 * literals back into the text — first by searching for a token value, then at a
 * key-anchored root line, then with ordinal tokens for nested floats. Each
 * step fixed the collision the previous one had and kept the class: text
 * substitution cannot tell a marker from a carried string that happens to
 * equal it, so every version either corrupted a carried field or refused a
 * sidecar the incumbent writes.
 * Rendering each float where it sits in the tree
 * has no marker to collide with, and no uniqueness check to fail closed on.
 *
 * Building sorted copies was the other defect in the substitution design: a
 * key named `__proto__` assigned into a fresh `{}` sets the prototype instead
 * of a property and vanishes from the output (S2). This walks `Object.keys`
 * and never constructs an object.
 *
 * Bytes match `json.dump` exactly: two-space indent, `", "`/`": "` separators
 * collapsed to `,\n` and `: ` by indent, empty containers as `[]`/`{}`, keys
 * sorted by code point at every depth, non-ASCII escaped, floats in Python's
 * repr, big integers as their source digits.
 */
export function metaBytes(meta: Record<string, Json>): string {
  return `${renderPy(meta, 0)}\n`;
}

/**
 * Python `json.dumps(obj)` / `json.dump(obj, fh)` with DEFAULT arguments —
 * keys in insertion order, `, ` and `: ` separators (or the compact pair when
 * asked), no indent, non-ASCII escaped, no trailing newline. Scalars render
 * exactly as `metaBytes` renders them (Python float repr, big integers as
 * their digits). The third byte shape a sidecar writer uses
 * (`tap_spool_schedule_probe`).
 *
 * `sortKeys` switches to `sort_keys=True` — code-point order at every depth,
 * the same ordering `renderPy` applies. The registry trim's row fingerprints
 * need the COMPACT form of exactly that call; nothing else passes it.
 */
export function jsonDumpBytes(
  value: unknown,
  separators: { item: string; key: string } = { item: ", ", key: ": " },
  sortKeys = false,
): string {
  if (Array.isArray(value)) return `[${value.map(v => jsonDumpBytes(v, separators, sortKeys)).join(separators.item)}]`;
  if (value !== null && typeof value === "object" && !(value instanceof PyFloat) && !(value instanceof PyInt)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (sortKeys) entries.sort(([a], [b]) => pyStrCompare(a, b));
    const rows = entries.map(([k, v]) => `${pyJsonString(k)}${separators.key}${jsonDumpBytes(v, separators, sortKeys)}`);
    return `{${rows.join(separators.item)}}`;
  }
  return renderPy(value, 0);
}

/** Python `open(path, encoding="utf-8").read()`: invalid bytes raise rather than becoming U+FFFD; a BOM is kept. */
export function pyReadUtf8(path: string): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
}

function renderPy(value: unknown, depth: number): string {
  if (value instanceof PyFloat) return value.repr();
  if (value instanceof PyInt) return value.source;
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : pyFloatRepr(value);
  if (typeof value === "string") return pyJsonString(value);
  const inner = "  ".repeat(depth + 1), outer = "  ".repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value.map(item => `${inner}${renderPy(item, depth + 1)}`).join(",\n")}\n${outer}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort(pyStrCompare);
    if (keys.length === 0) return "{}";
    const rows = keys.map(key => `${inner}${pyJsonString(key)}: ${renderPy((value as Record<string, unknown>)[key], depth + 1)}`);
    return `{\n${rows.join(",\n")}\n${outer}}`;
  }
  throw new PublishError(`metadata value is not JSON: ${typeof value}`);
}

/**
 * The metadata a park mints, from the facts the caller resolved and whatever
 * an existing sidecar already carries. Pure: no clock beyond `now`, no I/O
 * beyond what the caller read, so the decision table is testable as a table.
 */
export function mintMeta(input: PublishInput, old: Record<string, Json>, metaExists: boolean, now: Date): Record<string, Json> {
  const env = input.env ?? process.env;
  const nowIso = `${now.toISOString().slice(0, 19)}Z`;
  const nowEpoch = Math.floor(now.getTime() / 1000);
  const reason_class = input.reasonClass || reasonClass(input.reason);

  const attempts = pyInt(old.attempts ?? 0) ?? 0;
  let timeout_seconds: Json;
  if (input.timeoutSeconds) {
    const parsed = pyIntString(input.timeoutSeconds);
    timeout_seconds = parsed === null ? (old.timeout_seconds ?? null) : parsed;
  } else timeout_seconds = old.timeout_seconds ?? null;
  const grace_seconds = input.graceSeconds ? pyIntString(input.graceSeconds) : null;
  const first_epoch: Json = truthy(old.first_spooled_epoch) ? old.first_spooled_epoch! : nowEpoch;

  // OWNERSHIP IS MINTED HERE, NOT INFERRED DOWNSTREAM (tap-13c8). `deadline_source`
  // decides the DISPOSITION at the deadline (wake the sender, terminalize);
  // `waiter_lifetime` decides only which clock keeps the detached waiter alive
  // (tap-w4f7 split). Each branch that assigns a deadline says which of the two
  // it owns, and the predicate and the decision stay one line of code.
  let deadline_source: Json = "";
  let waiter_lifetime: Json = "";

  // tap-7r3fn.20: THE WINDOW RUNS FROM THE LAST VERIFIED DELIVERY, NOT FROM
  // ENQUEUE, and it is STAMPED ONCE — an existing value is carried forward
  // untouched, which is the starvation invariant. Always a number.
  const windowParsed = pyIntString(input.windowSeconds);
  const window_seconds = windowParsed === null ? 10 : Math.max(0, windowParsed);
  let hold_until_epoch: Json;
  if (old.hold_until_epoch !== undefined && old.hold_until_epoch !== null) {
    hold_until_epoch = old.hold_until_epoch;
  } else {
    const last_delivered = pyIntString(input.lastDelivered);
    // No verified reading, or the clock moved behind that reading: due now.
    if (last_delivered === null || last_delivered > nowEpoch) hold_until_epoch = nowEpoch;
    else hold_until_epoch = Math.max(nowEpoch, last_delivered + window_seconds);
  }

  let deadline_epoch: Json;
  if (input.policy === "autosettle") {
    // tap-31it: TWO CLOCKS. The hold expiring means DELIVER NOW; the deadline
    // expiring means GIVE UP and wake the sender. Its own source, so forensics
    // can tell a held auto-settle park from a pane that was busy five minutes.
    deadline_epoch = add(hold_until_epoch, busyDeadlineSeconds(env), "deadline_epoch");
    deadline_source = "autosettle-hold";
    waiter_lifetime = "autosettle-hold";
  } else if (grace_seconds !== null) {
    // A fresh draft has one warning/clobber clock; an existing armed hold stays.
    if (!("hold_until_epoch" in old)) hold_until_epoch = first_epoch;
    deadline_epoch = add(first_epoch, grace_seconds, "deadline_epoch");
    // LIFETIME ONLY: at its deadline the grace park force-delivers, it does not terminalize.
    waiter_lifetime = "grace-window";
  } else if (input.policy === "polite" && timeout_seconds !== null) {
    const timeout = pyInt(timeout_seconds);
    if (timeout === null) throw new PublishError("timeout_seconds: invalid literal for int()");
    deadline_epoch = add(first_epoch, timeout + 60, "deadline_epoch");
    // NO lifetime marker: a polite waiter is bounded by the historical cadence on purpose.
  } else if (old.deadline_epoch !== undefined && old.deadline_epoch !== null) {
    deadline_epoch = old.deadline_epoch;
    deadline_source = orChain(old.deadline_source);
    // Upgrade-safe: an absent key means "infer from deadline_source", and
    // writing "" would turn the deliverer's absent-key fallback off.
    if ("waiter_lifetime" in old) waiter_lifetime = orChain(old.waiter_lifetime);
    else if (deadline_source === "readiness-gate" || deadline_source === "autosettle-hold") waiter_lifetime = deadline_source;
  } else if (reason_class === "window") {
    // tap-7r3fn.20: the waiter must outlive the window, and nothing failed, so
    // a lifetime and no deadline_source.
    const hold = pyInt(hold_until_epoch);
    if (hold === null) throw new PublishError("hold_until_epoch: invalid literal for int()");
    deadline_epoch = hold + busyDeadlineSeconds(env);
    waiter_lifetime = "window";
  } else if (input.reason === "staged-idle") {
    // tap-9lqa7: the staged-idle hold bounds the idle wait itself. The waiter
    // owns the lifetime (the readiness-gate clock keeps the lease alive);
    // the DISPOSITION at expiry is the ordinary escalation ladder — never a
    // held-present renewal (an idle wait that never became Enterable is a
    // manual-path fact, not a busy pane) and never a sender-wake
    // terminalize. Bounded by TAP_STAGED_IDLE_SUBMIT_WINDOW, default 1800s.
    deadline_epoch = add(first_epoch, stagedIdleWindowSeconds(env), "deadline_epoch");
    waiter_lifetime = "readiness-gate";
  } else if (reason_class === "busy") {
    // tap-13c8: a readiness-gate park gets a deadline that bounds the TAIL, not
    // one that races an ordinary turn.
    deadline_epoch = add(first_epoch, busyDeadlineSeconds(env), "deadline_epoch");
    deadline_source = "readiness-gate";
    waiter_lifetime = "readiness-gate";
  } else {
    deadline_epoch = old.deadline_epoch ?? null;
    deadline_source = orChain(old.deadline_source);
  }

  // tap-7r3fn.20, the expert's point 2: A WINDOW-PARK NEEDS AN OWNED DELIVERER.
  // Every class carries a window, and `_deadline` in the deliverer returns 0
  // unless `waiter_lifetime` names an owned class — so an unowned entry would
  // lose its only actor on the ~31s cadence before it became due. A FALLBACK,
  // never an override, and deliberately no `deadline_source`: this only keeps
  // the waiter alive long enough for the window to close. The two fields have
  // to travel together or neither does anything.
  if (!truthy(waiter_lifetime) && hold_until_epoch !== null) {
    const hold = pyInt(hold_until_epoch);
    if (hold === null) throw new PublishError("hold_until_epoch: invalid literal for int()");
    if (deadline_epoch === null) {
      deadline_epoch = hold + busyDeadlineSeconds(env);
      waiter_lifetime = "window";
    } else {
      const deadline = pyInt(deadline_epoch);
      if (deadline === null) throw new PublishError("deadline_epoch: invalid literal for int()");
      if (deadline > hold) waiter_lifetime = "window";
    }
  }

  let cue_red_at: Json = null;
  if (input.cueRedAt) {
    cue_red_at = pyIntString(input.cueRedAt);
    if (cue_red_at === null) throw new PublishError("cue_red_at: invalid literal for int()");
  }

  const meta: Record<string, Json> = {
    id: input.id,
    target: input.target,
    team: input.team,
    reason: input.reason,
    reason_class,
    timeout_seconds,
    attempts,
    // Legacy zero counters are not proof after a possible effect.
    attempt_fence: metaExists ? ("attempt_fence" in old ? old.attempt_fence! : 0) : 1,
    first_spooled: orChain(old.first_spooled, nowIso),
    first_spooled_epoch: first_epoch,
    // Resolved AT PARK TIME: target is a bare, team-stripped handle whose
    // meaning is ambiguous across teams. Redelivery re-reads the exact registry
    // bound here and requires registry pane_id == stored pane_id == live
    // pane_id before injecting; it never re-resolves the handle.
    pane: orChain(input.pane, old.pane),
    pane_id: orChain(input.paneId, old.pane_id),
    to_team: orChain(input.toTeam, old.to_team),
    target_registry: orChain(input.targetRegistry, old.target_registry),
    policy: ["standard", "polite", "urgent", "autosettle"].includes(input.policy) ? input.policy : "standard",
    deadline_epoch,
    ...(grace_seconds !== null || old.draft_deadline_epoch !== undefined
      ? { draft_deadline_epoch: old.draft_deadline_epoch ?? add(first_epoch, grace_seconds!, "draft_deadline_epoch") } : {}),
    hold_until_epoch,
    deadline_source,
    waiter_lifetime,
    next_probe_epoch: new PyFloat(nowEpoch + probeDelay(env)),
    cue_style: input.cueStyle || null,
    cue_red_at,
  };
  if (truthy(meta.to_team)) {
    const registryTeam = typeof meta.target_registry === "string" ? registryTeamName(meta.target_registry) : "";
    if (registryTeam !== meta.to_team) {
      meta.reason = "legacy_meta_no_binding";
      meta.reason_class = "safety_gate";
    }
  }
  return meta;
}

/**
 * Publish the pair. Returns the parked body's path, which the adapter prints.
 * Throws `PublishError` for a refused input and rethrows I/O failures; either
 * way nothing here touches the canonical payload or the caller's claim.
 */
export function publishPair(input: PublishInput): string {
  const env = input.env ?? process.env;
  if (!ID_RE.test(input.id)) throw new PublishError(`spool_add: id '${input.id}' fails charset ${ID_RE.source}`);
  // `[ -f ]`, not `-e`: the incumbent's test is "exists AND is a regular file",
  // and `existsSync` alone is only the first half. A canonical replaced by a
  // FIFO between placement and parking makes the read below block forever; a
  // character device like /dev/zero makes it consume memory without end.
  // Narrow to reach and wide in consequence, and the guard was already there —
  // dropping it was a silent weakening of the send path, not a simplification.
  if (!isRegularFile(input.canonical)) throw new PublishError(`spool_add: canonical payload not found: ${input.canonical}`);
  if (!input.target) throw new PublishError("spool_add: target required");
  if (!input.reason) throw new PublishError("spool_add: reason required");
  mkdirSync(input.spoolDir, { recursive: true });
  const payloadPath = join(input.spoolDir, `${input.id}.md`);
  const metaPath = join(input.spoolDir, `${input.id}.meta.json`);
  // Before the body: a lock name the filesystem cannot hold (a 245-byte id makes
  // `.meta.json.lock` 260 bytes) admits no holder, and the incumbent's
  // `open(path + ".lock", "w")` raised here too. Refuse by name, leaving no orphan body (tap-u708y).
  if (!lockNameFits(`${metaPath}.lock`)) throw new PublishError(`spool_add: metadata lock name exceeds the filename limit: ${metaPath}.lock`);
  // Body first: a snapshot between the two writes sees an incomplete pair, never a torn file.
  atomicWrite(payloadPath, readFileSync(input.canonical));
  // The same sidecar every Bash/Python meta writer locks. A held lock is a
  // refusal after the bounded wait (METADATA_LOCK_TIMEOUT_MS), never a retry.
  const lock = acquirePathLock(`${metaPath}.lock`, input.lockTimeoutMs ?? METADATA_LOCK_TIMEOUT_MS, env);
  if (!lock) throw new PublishError(`spool_add: metadata lock held past ${input.lockTimeoutMs ?? METADATA_LOCK_TIMEOUT_MS}ms for ${metaPath}`);
  try {
    const metaExists = isRegularFile(metaPath);
    const meta = mintMeta(input, readOldMeta(metaPath), metaExists, input.now ?? new Date());
    atomicWrite(metaPath, metaBytes(meta));
  } finally { lock.release(); }
  return payloadPath;
}

if (import.meta.main) {
  const [mode, ...rest] = Bun.argv.slice(2);
  const names = ["spoolDir", "id", "canonical", "target", "team", "reason", "reasonClass", "timeoutSeconds", "pane", "paneId", "toTeam", "policy", "graceSeconds", "targetRegistry", "windowSeconds", "lastDelivered", "cueStyle", "cueRedAt"] as const;
  if (mode !== "add" || rest.length !== names.length) {
    process.stderr.write(`spool-publication: expected add with ${names.length} positional facts\n`);
    process.exit(2);
  }
  const input = Object.fromEntries(names.map((name, i) => [name, rest[i]!])) as unknown as PublishInput;
  try {
    process.stdout.write(publishPair(input));
  } catch (error) {
    process.stderr.write(`tap: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
