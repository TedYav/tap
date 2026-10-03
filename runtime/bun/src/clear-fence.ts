/**
 * The clearing fence, READ side. Content is the signal; the flock is not read.
 *
 * The writer half — `try_acquire`, `HeldFence`, `release` — stays in Python and
 * stays authoritative. Its lock lives on the marker INODE and is held across
 * stamp → respawn → await, so it cannot survive a one-shot subprocess that
 * exits. Nothing here takes that lock, which is what makes the read half
 * portable on its own: a reader that waited on the writer's flock would turn a
 * wedged clearer into a fleet outage.
 *
 * Polarity is deliberately asymmetric and both halves are load-bearing. Content
 * that is merely unusable — absent, torn, malformed — reads ABSENT at every
 * door, so a bad marker wedges nothing. Content the reader cannot DECODE raises,
 * and the two doors answer that oppositely on purpose: the courier's adapter
 * swallows it and delivers (fail-open), while `tap team reset` refuses
 * (fail-closed, clean-team claim). `readClearFence` therefore throws on a
 * decode failure rather than folding it into `absent`, and each caller picks.
 */
import {
  mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

export type ClearFenceState = "absent" | "live" | "expired";

export interface ClearFenceRead {
  state: ClearFenceState;
  /**
   * The record at BOTH malformed exits, and null ONLY when the file could not
   * be read or parsed into an object. One try/catch around the whole body
   * collapses the two, and a marker with a bad ceiling then loses the
   * since/pid/nonce the Bash diagnostics print — a diagnostic that names the
   * wedged clearer becomes one that says nothing.
   */
  rec: Record<string, unknown> | null;
}

// Python's str.strip() set: the 29 code points where chr(c).isspace() is True.
// NOT JavaScript's trim(). Python strips \x1c-\x1f and \x85, which trim() keeps;
// trim() strips ﻿, which Python keeps. Both differences are pinned in the
// oracle's `handle` group, and both decide which file a handle names.
const PY_STRIP_CLASS =
  "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP = new RegExp(`^[${PY_STRIP_CLASS}]+|[${PY_STRIP_CLASS}]+$`, "gu");

// Both trim sets are explicit code-point lists, not engine classes, so no
// runtime's \s or trim() tables decide a verdict here.
// float()'s set is the strip set MINUS the ASCII file/group separators: Python
// strips "5\x1c" to "5", but float("5\x1c") is a ValueError. `delivery-clock.ts`
// records the same split for int().
const PY_NUMERIC_CLASS =
  "\\t\\n\\v\\f\\r \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_NUMERIC_TRIM = new RegExp(`^[${PY_NUMERIC_CLASS}]+|[${PY_NUMERIC_CLASS}]+$`, "gu");

// The digit repertoire is PINNED to ASCII 0-9, spelled as an explicit class
// rather than \d or \p{Nd}. Python's float() accepts every Unicode decimal
// digit, but its answer depends on the interpreter's Unicode tables: U+11F51
// (Kawi one) is a ValueError on 3.11 and 1.0 on 3.14, and the Python reader is
// gone, so "match Python" names no single behavior. A numeric string carrying
// any non-ASCII digit is unparseable here and the marker reads absent. TAP's
// writers emit plain JSON numbers, so no real marker changes meaning. Revisit
// only if a writer ever emits non-ASCII digits.
const PY_DIGITS = "[0-9](?:_?[0-9])*";
const PY_FLOAT_GRAMMAR = new RegExp(
  `^[+-]?(?:inf(?:inity)?|nan|(?:(?:${PY_DIGITS})(?:\\.(?:${PY_DIGITS})?)?|\\.(?:${PY_DIGITS}))(?:[eE][+-]?(?:${PY_DIGITS}))?)$`,
  "i",
);

export function pythonStrip(value: string): string {
  return value.replace(PY_STRIP, "");
}

/**
 * `float()`, not `Number()`. The two disagree on inputs a marker can actually
 * carry: Number("1_000") and Number("infinity") are NaN where float() is 1000
 * and inf; Number("0x10") is 16 and Number([1]) is 1 where float() refuses
 * both. Returns null where float() raises TypeError or ValueError — `inspect`
 * catches them together, so one sentinel is the whole distinction it draws.
 */
export function pythonFloat(value: unknown): number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") {
    // float(int) on an integer too large for a double raises OverflowError,
    // which is an ArithmeticError — NOT caught by `except (TypeError,
    // ValueError)`, so it escapes `inspect` entirely. The doors then split:
    // the courier delivers, the reset refuses. Returning +/-Infinity here would
    // classify the marker instead, and silently.
    const asNumber = Number(value);
    if (!Number.isFinite(asNumber)) {
      throw new ClearFenceOverflow(`int too large to convert to float: ${value}`);
    }
    return asNumber;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.replace(PY_NUMERIC_TRIM, "");
  if (!PY_FLOAT_GRAMMAR.test(trimmed)) return null;
  const bare = trimmed.replaceAll("_", "");
  const sign = bare.startsWith("-") ? -1 : 1;
  const magnitude = bare.replace(/^[+-]/, "").toLowerCase();
  if (magnitude === "nan") return Number.NaN;
  if (magnitude === "inf" || magnitude === "infinity") return sign * Number.POSITIVE_INFINITY;
  return Number(bare);
}

/**
 * The marker for one seat. The handle is STRIPPED BEFORE `<team>/` is split, so
 * "tap/  seat" names "  seat.json" while "  tap/seat  " names "seat.json".
 */
export function fencePath(busDir: string, handle: string): string {
  let name = pythonStrip(handle ?? "");
  const slash = name.lastIndexOf("/");
  if (slash >= 0) name = name.slice(slash + 1);
  return join(busDir, "clear-fence", `${name}.json`);
}

/**
 * `Path.with_suffix`, which replaces the LAST suffix rather than appending. A
 * handle that strips to empty leaves ".json", whose suffix is empty because a
 * leading dot names a hidden file — so it GAINS one and becomes
 * ".json.json.expired-notice". Appending ".expired-notice" would not.
 */
export function noticePath(busDir: string, handle: string): string {
  const fence = fencePath(busDir, handle);
  return join(dirname(fence), `${pythonStem(basename(fence))}.json.expired-notice`);
}

/**
 * `PurePath.stem`. A leading dot names a hidden file with NO suffix, so ".json"
 * stems to ".json" rather than to "". Both callers here depend on that: the
 * notice path gains a suffix, and the reset scan must not hand the reader an
 * empty handle.
 */
function pythonStem(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * `Path.resolve()`: absolute, symlinks followed, tolerant of components that do
 * not exist. `resolve()` alone is lexical and would not follow a symlinked
 * registry; `realpathSync` alone throws when the file is absent, which is a
 * supported shape here.
 */
export function physicalPath(path: string, hops = 0): string {
  // POSIX realpath ORDER, which `resolve()` alone does not give: each component
  // is resolved physically as it is walked, and ".." pops the directory that
  // resolution actually produced. Collapsing ".." lexically first answers a
  // different directory whenever a symlink precedes it — `link/../x` with
  // `link -> a/b` is `a/x` to Python and `x` to a lexical resolve. Symlinked
  // registries and absent files are both supported shapes here, so their
  // composition is reachable rather than theoretical.
  //
  // Existing components go through `realpathSync`. A DANGLING symlink is not an
  // absent component, though — Python follows one to a target that does not
  // exist yet, and a registry link written before its file is an ordinary
  // shape here — so a failed realpath falls back to reading the link itself.
  //
  // Loops are bounded by hop count, the way the kernel bounds them. A visited
  // SET gets this wrong in the other direction: it is per-walk rather than
  // per-chain, so a path that legitimately crosses the same symlink twice
  // (/var on macOS, once for a link and again for its target) reads as a loop
  // that is not there.
  if (hops > 40) throw new Error("too many levels of symbolic links");
  // NOT join(): it collapses ".." lexically, so a RELATIVE registry argument
  // would arrive at the walk already normalized and the symlink order would be
  // lost exactly as it was for absolute paths.
  const absolute = isAbsolute(path) ? path : `${process.cwd()}/${path}`;
  let resolved = "/";
  for (const part of absolute.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      resolved = dirname(resolved);
      continue;
    }
    const next = join(resolved, part);
    try {
      resolved = realpathSync(next);
      continue;
    } catch { /* absent, or a symlink whose target is absent */ }
    let target: string | undefined;
    try {
      target = readlinkSync(next);
    } catch { /* genuinely not a symlink */ }
    resolved = target === undefined
      ? next
      // Same reason: a relative symlink TARGET may itself contain "..", and
      // joining it here would resolve that against the wrong directory.
      : physicalPath(isAbsolute(target) ? target : `${resolved}/${target}`, hops + 1);
  }
  return resolved;
}

/**
 * Recipient bus from a registry file path. Pre-flip (and tests) registry.json
 * lives IN the bus; post-flip team-registry.json lives in .tap/ and the
 * courier's bus is .tap/bus.
 *
 * An empty registry path resolves to the CWD's parent, which is how a stray
 * file appears inside a repository checkout. Callers that may hold nothing
 * guard before calling rather than having this invent a fallback (lib.sh:1742).
 */
export function busForRegistry(registryPath: string): string {
  const directory = dirname(physicalPath(registryPath));
  if (basename(directory) === ".tap") {
    const nested = join(directory, "bus");
    try {
      if (statSync(nested).isDirectory()) return nested;
    } catch { /* pre-flip layout */ }
  }
  return directory;
}

/** The reader could not produce an answer. Each door decides its own polarity. */
export class ClearFenceUnreadable extends Error {}

/** `float(int)` overflowed, as Python's OverflowError does — and escapes too. */
export class ClearFenceOverflow extends ClearFenceUnreadable {}

/**
 * Python's TEXT-mode read. Invalid UTF-8 raises UnicodeDecodeError, which is a
 * ValueError and so escapes the incumbent's `except OSError`. `ignoreBOM` is
 * set because it means "do not strip it": Python keeps a BOM in the string, and
 * `json.loads` then refuses the document.
 */
function decodeStrict(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ClearFenceUnreadable(`clear-fence file is not valid UTF-8: ${path}`);
  }
}

function readRecord(path: string): Record<string, unknown> | null {
  let raw: string;
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch {
    return null; // OSError: absent, unreadable, or a directory in its place.
  }
  raw = decodeStrict(bytes, path);
  if (pythonStrip(raw) === "") return null;
  let parsed: unknown;
  try {
    parsed = pythonJsonParse(raw);
  } catch {
    return null;
  }
  // A TYPE guard, not an emptiness test. `[1]` is truthy and has keys, so only
  // the type check drops it the way Python's isinstance does.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/**
 * `json.loads`, which is not `JSON.parse`.
 *
 * Two differences reach the classification. Python ACCEPTS the non-standard
 * literals `Infinity`, `-Infinity` and `NaN`, where `JSON.parse` rejects the
 * whole document and the marker would read absent instead of live. And Python
 * keeps integers at arbitrary precision, so a large integer `since_epoch`
 * survives parsing and fails later, in `float()`, with an OverflowError that
 * `inspect` does not catch — while `JSON.parse` silently yields +/-Infinity.
 * Exponent-form floats are NOT the same case: `1e400` is already `inf` to
 * Python's parser and converts without error, so the two must stay distinct.
 *
 * The literals are substituted outside string values only; the reviver restores
 * them, and `context.source` marks which numbers were written as integers.
 */
/**
 * The three markers are minted PER PARSE and verified absent from the document,
 * because the sentinel is in-band: it travels as a JSON string, and a document
 * may legitimately contain that exact string. A fixed sentinel converts real
 * data — `"\u0000py-inf"` as a ceiling is a STRING to Python, so the marker
 * reads absent, where a fixed sentinel made it numeric Infinity and live.
 */
function mintSentinels(raw: string): { nan: string; inf: string; negInf: string } {
  for (;;) {
    const tag = `py-nonfinite-${crypto.randomUUID()}`;
    const mint = { nan: `${tag}-nan`, inf: `${tag}-inf`, negInf: `${tag}-neg-inf` };
    if (!raw.includes(tag)) return mint;
  }
}

/**
 * Substitute Python's non-finite literals where a VALUE may appear, and nowhere
 * else. Position matters: `{Infinity:0}` is invalid to Python — a bare key is
 * not a string — so the document is rejected and the marker reads absent.
 * Quoting that key indiscriminately turns an invalid document into a valid one
 * and the fence into `live`, which is the substitution legalizing input the
 * incumbent refused.
 */
function substituteNonFinite(raw: string, mint: { nan: string; inf: string; negInf: string }): string {
  let out = "";
  let inString = false;
  // Each open container remembers whether the next token sits in value position.
  // Objects alternate key -> value on ':' and back on ','; arrays are all values.
  const stack: { object: boolean; expectValue: boolean }[] = [];
  const atValue = () => stack.length === 0 || stack[stack.length - 1]!.expectValue;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") { out += raw[++i] ?? ""; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    const top = stack[stack.length - 1];
    if (ch === "{") { stack.push({ object: true, expectValue: false }); out += ch; continue; }
    if (ch === "[") { stack.push({ object: false, expectValue: true }); out += ch; continue; }
    if (ch === "}" || ch === "]") { stack.pop(); out += ch; continue; }
    if (ch === ":" && top?.object) { top.expectValue = true; out += ch; continue; }
    if (ch === "," && top) { top.expectValue = !top.object; out += ch; continue; }
    if (atValue()) {
      if (raw.startsWith("-Infinity", i)) { out += JSON.stringify(mint.negInf); i += 8; continue; }
      if (raw.startsWith("Infinity", i)) { out += JSON.stringify(mint.inf); i += 7; continue; }
      if (raw.startsWith("NaN", i)) { out += JSON.stringify(mint.nan); i += 2; continue; }
    }
    out += ch;
  }
  return out;
}

/**
 * `json.loads`, which is not `JSON.parse`.
 *
 * Python ACCEPTS the non-standard literals `Infinity`, `-Infinity` and `NaN`
 * where `JSON.parse` rejects the whole document, and it keeps integers at
 * arbitrary precision, so a large integer `since_epoch` survives parsing and
 * fails later in `float()` with an OverflowError that `inspect` does not catch.
 * Exponent-form floats are NOT the same case: `1e400` is already `inf` to
 * Python's parser and converts without error, so the two must stay distinct.
 */
function pythonJsonParse(raw: string): unknown {
  const mint = mintSentinels(raw);
  return JSON.parse(
    substituteNonFinite(raw, mint),
    (_key: string, value: unknown, context?: { source?: string }) => {
      if (value === mint.nan) return Number.NaN;
      if (value === mint.inf) return Number.POSITIVE_INFINITY;
      if (value === mint.negInf) return Number.NEGATIVE_INFINITY;
      // An integer literal stays an integer, so float() can overflow on it the
      // way Python's does. Only out-of-range ones need the wider type.
      if (typeof value === "number" && context?.source
          && /^-?\d+$/.test(context.source) && !Number.isSafeInteger(value)) {
        return BigInt(context.source);
      }
      return value;
    },
  );
}

/**
 * The courier's question, with the clock injected. `nowSeconds` is SECONDS
 * since the epoch — the unit `since_epoch` and `ceiling_seconds` are already
 * in. Passing milliseconds makes every live fence read expired.
 */
export function readClearFence(
  busHome: string,
  handle: string,
  nowSeconds?: number,
): ClearFenceRead {
  const rec = readRecord(fencePath(busHome, handle));
  // `if not rec` is Python falsiness: an EMPTY dict takes the absent exit and
  // reports rec: null, even though it parsed fine.
  if (!rec || Object.keys(rec).length === 0) return { state: "absent", rec: null };
  const since = pythonFloat(rec.since_epoch);
  const ceiling = pythonFloat(rec.ceiling_seconds);
  if (since === null || ceiling === null) return { state: "absent", rec };
  if (ceiling <= 0) return { state: "absent", rec };
  const stamp = nowSeconds === undefined ? Date.now() / 1000 : nowSeconds;
  // NaN makes both comparisons false, so a NaN stamp reads EXPIRED, never live.
  return { state: stamp < since + ceiling ? "live" : "expired", rec };
}

function pythonFalsy(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "boolean") return !value;
  if (typeof value === "number") return value === 0;
  if (typeof value === "string") return value === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

/**
 * True when this send should print the fail-open notice: once per nonce.
 *
 * The sidecar is not the fence and takes no lock. Two concurrent callers can
 * both miss the file and both print — a duplicate diagnostic line, and the
 * incumbent races the same way.
 *
 * Serializing it here is POSSIBLE: `panelock.acquirePathLock` is kernel-backed
 * and would do it. It is not done because it would be a behavior change beyond
 * the port, and because the incumbent races the same way. Every send door
 * reaches this helper through `noticeExpiredAtSendDoor`; none adds a second
 * lock or nonce-key spelling.
 */
export function noticeExpiredOnce(
  busDir: string,
  handle: string,
  rec: Record<string, unknown> | null | undefined,
): boolean {
  const raw = rec === null || rec === undefined ? undefined : rec.nonce;
  // Python falsiness, not JS: 0, false and [] all take the empty-nonce exit.
  const nonce = pythonFalsy(raw) ? "" : raw;
  if (nonce === "") {
    // An empty nonce is not a once-key. A torn marker must not write a blank
    // sidecar that then suppresses every later notice.
    return true;
  }
  if (typeof nonce !== "string") {
    // A truthy non-string reaches `nonce + "\n"` and raises an uncaught
    // TypeError. The only door maps any nonzero to "already noticed", so the
    // observable is SUPPRESSED with nothing written — not a printed warning.
    // String(nonce) would invent a notice the incumbent never emitted.
    return false;
  }
  const path = noticePath(busDir, handle);
  let existing: string | null = null;
  try {
    if (statSync(path).isFile()) existing = decodeStrict(readFileSync(path), path);
  } catch (error) {
    // Only an OSError falls through to the write. A decode failure is a
    // UnicodeDecodeError inside the incumbent's try, uncaught by its
    // `except OSError`, so it escapes BEFORE the write — the door suppresses
    // the warning and the sidecar's bytes are left exactly as they were. A
    // lenient read would substitute replacement characters, miscompare, and
    // then overwrite content it could not read.
    if (error instanceof ClearFenceUnreadable) throw error;
  }
  if (existing !== null && pythonStrip(existing) === nonce) return false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    // The nonce is written VERBATIM; only the read side strips.
    writeFileSync(path, `${nonce}\n`, "utf8");
  } catch {
    return true; // OSError: notice rather than silently suppress.
  }
  return true;
}

/**
 * The send-door adapter for the incumbent shell's verdict contract.
 *
 * Bash runs the notice helper as a subprocess and prints only for the literal
 * `notice` verdict; any helper failure suppresses this diagnostic but never
 * blocks delivery. Native callers use the same boundary so corrupt sidecar
 * bytes cannot turn an expired, fail-open fence into a delivery outage.
 */
export function noticeExpiredAtSendDoor(
  busDir: string,
  handle: string,
  rec: Record<string, unknown> | null | undefined,
): boolean {
  try {
    return noticeExpiredOnce(busDir, handle, rec);
  } catch {
    return false;
  }
}

/**
 * The first seat whose fence is live, in the incumbent's order: sorted by path,
 * first match wins. A marker this cannot READ is absent and does not block; a
 * marker it cannot DECODE raises, and `tap team reset` refuses on that.
 */
export function firstLiveFence(busHome: string, nowSeconds?: number): string {
  let names: string[];
  try {
    names = readdirSync(join(busHome, "clear-fence"));
  } catch {
    return "";
  }
  const markers = names
    .filter(name => name.endsWith(".json"))
    .map(name => join(busHome, "clear-fence", name))
    .sort();
  for (const marker of markers) {
    // `Path.stem`, which is NOT "drop the last five characters": a leading dot
    // makes the whole name the stem, so ".json" stems to ".json" and the
    // incumbent then looks for ".json.json" and finds nothing. Slicing instead
    // yields "", whose marker IS ".json" — so a live empty-handle marker would
    // be returned as the empty string, which the reset door reads as NO LIVE
    // FENCE and proceeds to its destructive phase. Fail-open on the one door
    // that must fail closed.
    const stem = pythonStem(basename(marker));
    if (readClearFence(busHome, stem, nowSeconds).state === "live") return stem;
  }
  return "";
}

function printField(rec: Record<string, unknown>, key: string): string {
  const value = rec[key];
  // `rec.get(k) or ""` — Python falsiness, so a pid of 0 prints empty.
  return pythonFalsy(value) ? "" : typeof value === "string" ? value : String(value);
}

if (import.meta.main) {
  const [mode, ...rest] = process.argv.slice(2);
  try {
    if (mode === "bus") {
      // Both values are ARGUMENTS, never process.env: the Bash door reads them
      // in Bash and an in-process caller has no inheritance moment to match.
      const [registry, tapHome] = rest;
      if (registry) process.stdout.write(`${busForRegistry(registry)}\n`);
      else if (tapHome) process.stdout.write(`${tapHome}\n`);
    } else if (mode === "inspect") {
      const [bus, handle, now] = rest;
      const info = readClearFence(bus ?? "", handle ?? "", now ? Number(now) : undefined);
      const rec = info.rec ?? {};
      process.stdout.write(
        `${info.state}\n${printField(rec, "since")}\n${printField(rec, "pid")}\n${printField(rec, "nonce")}\n`,
      );
    } else if (mode === "notice") {
      const [bus, handle] = rest;
      const info = readClearFence(bus ?? "", handle ?? "");
      process.stdout.write(
        noticeExpiredOnce(bus ?? "", handle ?? "", info.rec) ? "notice\n" : "suppressed\n",
      );
    } else if (mode === "first-live") {
      const [bus] = rest;
      process.stdout.write(`${firstLiveFence(bus ?? "")}\n`);
    } else {
      process.stderr.write("usage: clear-fence.ts bus|inspect|notice|first-live <args>\n");
      process.exitCode = 2;
    }
  } catch (error) {
    // A decode failure exits nonzero so each door applies its own polarity: the
    // courier's adapter swallows it, the reset refuses on it.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
