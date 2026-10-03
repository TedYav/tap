// The delivery-window override: one recipient's `[delivery.overrides."team/handle"]`
// table in `~/.config/tap/config.toml`, read and edited without rewriting the
// rest of the file. The one implementation of what `digest_window.py`,
// `tap_delivery_config_window` and `tap_delivery_window_seconds` did in Python
// and Bash (lane A, batch 2, slice A1a).
//
// Fidelity notes — every place JavaScript reads LOOSER than the incumbent is
// pinned back to Python here, and every deviation that stays is declared in
// the PR body, never folded in silently:
//   - `tomllib.loads` refuses a leading U+FEFF; `Bun.TOML.parse` accepts one.
//     `parseToml` refuses it first, so a BOM config is unusable on both sides.
//   - `str.splitlines()` / `str.strip()` / `re.match(r'\s')` are Python's
//     boundary sets, not JavaScript's (`﻿` is not space to Python;
//     `\x1c`-`\x1f` are).
//   - `json.dumps(seat)` escapes non-ASCII; `ensureAscii(JSON.stringify(...))`
//     writes the same bytes.
//   - `flock(LOCK_EX)` blocked forever; the descriptor lock here is bounded
//     (5 s of non-blocking tries) and refuses with "config lock busy" — a declared delta.
import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { ensureAscii } from "./fsatomic";
import { physicalPath } from "./clear-fence";
import { KERNEL_LOCK } from "./panelock";
import { readSecureBytes } from "./config-file";
import { PyInt, isDict, jsonDumpBytes, pyFloatRepr } from "./spool-publication";

export const DELIVERY_NOW_WINDOW_DEFAULT = 10;
export const DELIVERY_POLITE_WINDOW_DEFAULT = 60;
export const WINDOW_MAX = 2147483647;

/** Python `str.splitlines()` boundaries (keepends handled by the caller). */
const PY_LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/g;
/** Python `\s` in a `str` pattern: Unicode whitespace, which includes 1C–1F and excludes U+FEFF. */
const PY_SPACE_CLASS = "[\\t-\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const HEADER_LINE = new RegExp(`^${PY_SPACE_CLASS}*\\[`);
const WINDOW_KEY_LINE = new RegExp(`^${PY_SPACE_CLASS}*["']?(now_window_seconds|digest_include_asks)["']?${PY_SPACE_CLASS}*=`);
const ASCII_DIGITS = /^[0-9]+$/;

/** `str.splitlines(keepends=True)`: each boundary Python recognizes, kept on its line. */
export function pySplitLinesKeepEnds(text: string): string[] {
  const out: string[] = [];
  let last = 0;
  for (const m of text.matchAll(PY_LINE_BREAK)) {
    out.push(text.slice(last, m.index! + m[0].length));
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** `str.rstrip()` with Python's whitespace set (`pyStrip`'s set, trailing side only). */
const PY_TRAILING_SPACE = new RegExp(`${PY_SPACE_CLASS}+$`);
function pyRstrip(text: string): string {
  return text.replace(PY_TRAILING_SPACE, "");
}

export class DigestWindowError extends Error {}

/** `Bun.TOML.parse` returns datetimes as Temporal objects — not tables. */
function isTemporal(value: unknown): boolean {
  return typeof value === "object" && value !== null && Object.prototype.toString.call(value).startsWith("[object Temporal.");
}
/** Python `isinstance(x, dict)` over a parsed TOML document. */
function isTable(value: unknown): value is Record<string, unknown> {
  return isDict(value) && !isTemporal(value);
}

/**
 * `tomllib.loads` as the incumbent used it. A leading BOM is the one input
 * where Bun's parser accepts what Python refused; the refusal message names
 * the same position Python did.
 */
export function parseToml(text: string): Record<string, unknown> {
  if (text.startsWith("\ufeff")) throw new DigestWindowError("Invalid statement (at line 1, column 1)");
  let doc: unknown;
  try { doc = Bun.TOML.parse(text); }
  catch (error) { throw new DigestWindowError(String((error as Error).message ?? error)); }
  if (!isTable(doc)) throw new DigestWindowError("TOML document is not a table");
  return doc;
}

/** `digest_window.seconds`: `off` → null; ASCII digits within int32 → the integer. */
export function windowSeconds(raw: string): number | null {
  if (raw === "off") return null;
  if (!ASCII_DIGITS.test(raw) || BigInt(raw) > BigInt(WINDOW_MAX)) {
    throw new DigestWindowError("window must be off or integer seconds from 0 to 2147483647");
  }
  return Number(raw);
}

/**
 * `digest_window.configured_window`: the seat's override table first (the
 * team-qualified name, then the bare handle when no team or the acting team),
 * then the `[delivery]` default. `key in seat` is presence, not truthiness.
 */
export function configuredWindow(doc: Record<string, unknown>, key: string, team: string, handle: string, acting: string, reply: string): unknown {
  const delivery = doc.delivery;
  if (!isTable(delivery)) return null;
  const overrides = delivery.overrides;
  if (isTable(overrides) && handle) {
    const names = [...(team ? [`${team}/${handle}`] : []), ...(!team || team === acting ? [handle] : [])];
    for (const name of names) {
      const seat = overrides[name];
      if (isTable(seat) && Object.hasOwn(seat, key)) {
        if (key === "now_window_seconds" && Object.hasOwn(seat, "digest_include_asks") && seat.digest_include_asks !== true && reply !== "settle-only") break;
        return seat[key];
      }
    }
  }
  return Object.hasOwn(delivery, key) ? delivery[key] : null;
}

/** Python `str(value)` over what `Bun.TOML.parse` returns, as `effective_windows` and the CLI print it. */
export function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  // A whole number below 2^53 cannot say whether its token was `600` or
  // `600.0` (the declared float deviation); past 2^53 only a float token
  // reaches here, since Bun refuses an integer it cannot hold exactly.
  if (typeof value === "number") return Number.isSafeInteger(value) ? String(value) : pyFloatRepr(value);
  if (typeof value === "string") return value;
  if (isTemporal(value)) return pyTemporalStr(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`).join(", ")}}`;
  return String(value);
}
/**
 * Python `str()` of what `tomllib` produced for a TOML datetime: `datetime`
 * prints with a space separator and `+HH:MM` offset (an offset datetime is
 * a `Temporal.Instant`, whose offset is always rendered as UTC — a declared
 * deviation for a non-UTC source offset); `date` and `time` print as ISO.
 */
function pyTemporalStr(value: unknown): string {
  const tag = Object.prototype.toString.call(value);
  // Python prints a non-zero fraction as exactly six digits (microseconds);
  // Temporal prints the shortest form. tomllib keeps microsecond precision.
  const text = String(value).replace(/\.(\d+)(?=Z?$)/, (_, frac: string) => `.${frac.slice(0, 6).padEnd(6, "0")}`);
  if (tag === "[object Temporal.Instant]") return `${text.replace("T", " ").replace(/Z$/, "")}+00:00`;
  if (tag === "[object Temporal.PlainDateTime]") return text.replace("T", " ");
  return text;
}
function pyRepr(value: unknown): string {
  if (typeof value === "string") return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  return pyStr(value);
}

/**
 * `tap_driver_config_path` / `digest_window.effective_windows`: `$XDG_CONFIG_HOME`
 * when SET (and then it must be absolute — a relative one is NO config, never
 * a fallback to HOME), else `$HOME/.config`; nothing when neither is usable.
 * `launcher/catalog.ts`'s `configDirectory` falls back to HOME for a relative
 * XDG, which is not this caller's rule.
 */
export function driverConfigPath(env: NodeJS.ProcessEnv): string | null {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg !== "" ? xdg : env.HOME ? `${env.HOME}/.config` : null;
  if (base === null || !isAbsolute(base)) return null;
  return join(base, "tap", "config.toml");
}

/** The document the incumbents read: secure bytes, strict UTF-8, Python's parser semantics. */
function readConfigDoc(path: string): Record<string, unknown> {
  const { bytes } = readSecureBytes(path);
  return parseToml(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
}

/**
 * The config document the roster readers consult, or `{}` when it cannot be
 * read or parsed — the incumbent's bare `except Exception`. Read ONCE per
 * roster: a 2,000-seat `tap team` consults it 2,000 times.
 */
export function windowsDoc(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const cfg = driverConfigPath(env);
  if (cfg === null) return {};
  try { return readConfigDoc(cfg); } catch { return {}; }
}

export interface EffectiveWindows { digest_window_seconds: number | PyInt; ask_window_seconds: number | PyInt }

/**
 * `digest_window.effective_windows`: the roster's two windows for one seat. Any
 * failure to read or parse the config is the defaults, as the incumbent's bare
 * `except Exception` made it. `doc` is `windowsDoc(env)` unless the caller
 * already holds it.
 */
export function effectiveWindows(team: string, handle: string, env: NodeJS.ProcessEnv = process.env, doc: Record<string, unknown> = windowsDoc(env)): EffectiveWindows {
  const seam = env.TAP_AUTOSETTLE_HOLD_SECONDS ?? "";
  // `int(str(value))`: an unbounded Python int. A digit string past 2^53 stays
  // exact as a `PyInt` (its JSON is the digits); a safe one is a number.
  const pick = (reply: string): number | PyInt => {
    const value = ASCII_DIGITS.test(seam) ? seam : configuredWindow(doc, "now_window_seconds", team, handle, team, reply);
    const text = pyStr(value);
    if (!ASCII_DIGITS.test(text)) return 10;
    const digits = text.replace(/^0+(?=.)/, "");
    return Number.isSafeInteger(Number(digits)) ? Number(digits) : new PyInt(digits);
  };
  return { digest_window_seconds: pick("settle-only"), ask_window_seconds: pick("expected") };
}

/**
 * `tap_delivery_config_window`: the configured value printed as Python printed
 * it, or nothing. Throws where the incumbent exited 1 (config unusable); the
 * "no tomllib" exit 4 has no native counterpart.
 */
export function configWindowValue(cfg: string, key: string, team: string, handle: string, acting: string, reply: string): string | null {
  const doc = readConfigDoc(cfg);
  const value = configuredWindow(doc, key, team, handle, acting, reply);
  return value === null || value === undefined ? null : pyStr(value);
}

/**
 * `tap_delivery_window_seconds`: THE one answer for how long an entry's window
 * is. `polite` takes the long window; everything else the short one, which
 * `TAP_AUTOSETTLE_HOLD_SECONDS` (digits only) overrides. The config is
 * consulted only when it exists; an unusable config is the built-in.
 */
export function deliveryWindowSeconds(policy: string, team: string, handle: string, reply: string, acting: string, env: NodeJS.ProcessEnv = process.env): string {
  let key: string, builtin: number, value = "";
  if (policy === "polite") {
    key = "polite_window_seconds"; builtin = DELIVERY_POLITE_WINDOW_DEFAULT;
  } else {
    key = "now_window_seconds"; builtin = DELIVERY_NOW_WINDOW_DEFAULT;
    const seam = env.TAP_AUTOSETTLE_HOLD_SECONDS ?? "";
    if (ASCII_DIGITS.test(seam)) value = seam;
  }
  if (value === "") {
    const cfg = driverConfigPath(env);
    if (cfg === null || !isFile(cfg)) return String(builtin);
    try { value = configWindowValue(cfg, key, team, handle, acting, reply) ?? ""; }
    catch { value = ""; }
  }
  if (!ASCII_DIGITS.test(value)) return String(builtin);
  // The incumbent printed the DIGITS with leading zeros stripped (`${value:-0}`), never a
  // rounded number: a quoted `"9007199254740993"` or an env seam past 2^53 stays exact.
  return value.replace(/^0+(?=.)/, "");
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/**
 * `digest_window.edit`: splice the seat's table in place, or append one, and
 * refuse any layout where the textual result does not parse to the document
 * the semantic edit produced (headers inside multi-line strings, inline or
 * dotted forms the splice cannot see).
 */
export function editConfig(raw: string, seat: string, window: number | null, includeAsks: boolean): string {
  const doc = parseToml(raw);
  const expected = pyDeepCopy(doc) as Record<string, unknown>;
  const delivery = setdefaultDict(expected, "delivery");
  const overrides = setdefaultDict(delivery, "overrides");
  if (!Object.hasOwn(overrides, seat)) overrides[seat] = {};
  const row = overrides[seat];
  if (!isTable(row)) throw new DigestWindowError("recipient override must be a TOML table");
  if (window === null) {
    delete row.now_window_seconds;
    delete row.digest_include_asks;
  } else {
    row.now_window_seconds = window;
    row.digest_include_asks = includeAsks;
  }
  const lines = pySplitLinesKeepEnds(raw);
  let start: number | null = null, end: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!HEADER_LINE.test(line)) continue;
    if (start !== null) { end = i; break; }
    try {
      const header = parseToml(line);
      const d = header.delivery;
      const o = isTable(d) ? d.overrides : undefined;
      // Python: `seat in header.get('delivery', {}).get('overrides', {})` — a
      // non-dict at either level raised and was swallowed; `in` on a dict is
      // key presence.
      if (d !== undefined && !isTable(d)) throw new TypeError("not a dict");
      if (o !== undefined && !isTable(o)) throw new TypeError("not a dict");
      if (isTable(o) && Object.hasOwn(o, seat)) start = i + 1;
    } catch { /* an unparseable or foreign header is not this seat's */ }
  }
  const added = window === null ? "" : `now_window_seconds = ${window}\ndigest_include_asks = ${includeAsks ? "true" : "false"}\n`;
  let candidate: string;
  if (start === null) {
    candidate = `${pyRstrip(raw)}\n\n[delivery.overrides.${ensureAscii(JSON.stringify(seat))}]\n${added}`;
  } else {
    const stop = end === null ? lines.length : end;
    const body = lines.slice(start, stop).filter(line => !WINDOW_KEY_LINE.test(line)).join("");
    candidate = lines.slice(0, start).join("") + added + body + lines.slice(stop).join("");
  }
  // Python: `tomllib.loads(candidate)` raising propagates its own message; a
  // parse that succeeds but differs is the layout refusal.
  if (!pyEqual(parseToml(candidate), expected)) {
    throw new DigestWindowError('cannot safely edit this TOML layout; use a dedicated [delivery.overrides."team/handle"] table');
  }
  return candidate;
}

/**
 * `copy.deepcopy` over a parsed TOML document. `structuredClone` cannot clone
 * the Temporal objects `Bun.TOML.parse` returns for datetimes; they are
 * immutable, so a reference is a faithful copy.
 */
function pyDeepCopy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pyDeepCopy);
  if (isTable(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, pyDeepCopy(v)]));
  return value;
}

function setdefaultDict(dict: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!Object.hasOwn(dict, key)) dict[key] = {};
  const value = dict[key];
  // Python: `.setdefault(...)` on a non-dict raised AttributeError.
  if (!isTable(value)) throw new DigestWindowError(`'${typeof value}' object has no attribute 'setdefault'`);
  return value;
}

/** Python `==` over two parsed TOML documents. */
function pyEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => pyEqual(item, b[i]));
  }
  if (isTemporal(a) || isTemporal(b)) return isTemporal(a) && isTemporal(b) && pyStr(a) === pyStr(b);
  if (isTable(a) || isTable(b)) {
    if (!isTable(a) || !isTable(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => Object.hasOwn(b, k) && pyEqual(a[k], b[k]));
  }
  // Python: `True == 1` and `1 == 1.0`; JavaScript's parser already collapsed
  // int/float, and a boolean-vs-number equality is reproduced here.
  if (typeof a === "boolean" && typeof b === "number") return Number(a) === b;
  if (typeof a === "number" && typeof b === "boolean") return a === Number(b);
  return a === b;
}

/**
 * `digest_window.update`: under `<config>.lock`, read the secure bytes, edit,
 * write a same-directory temp, refuse if the file changed meanwhile, replace.
 */
export function updateConfig(path: string, seat: string, window: number | null, includeAsks: boolean, env: NodeJS.ProcessEnv = process.env, lockTimeoutMs = 5000, hooks?: LockHooks): void {
  const resolved = pyResolve(path);
  const dir = dirname(resolved);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // `os.open(lock, O_CREAT|O_RDWR|O_NOFOLLOW, 0o600)` + `fcntl.flock(LOCK_EX)`: the lock is
  // taken ON THE DESCRIPTOR the no-follow open produced — never by re-opening the path
  // (a path re-opened by a helper can be swapped under the check).
  const lockFd = acquireNoFollowLock(`${resolved}.lock`, lockTimeoutMs, hooks);
  try {
    const raw = existsSync(resolved) ? readSecureBytes(resolved).bytes : Buffer.alloc(0);
    const candidate = editConfig(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw), seat, window, includeAsks);
    const tmp = join(dir, `.digest-window-${process.pid.toString(36)}${Math.random().toString(36).slice(2, 10)}`);
    const fd = openSync(tmp, "wx", 0o600);
    try {
      try { writeFileSync(fd, candidate); fsyncSync(fd); } finally { closeSync(fd); }
      const now = existsSync(resolved) ? readFileSync(resolved) : Buffer.alloc(0);
      if (!now.equals(raw)) throw new DigestWindowError("config changed during update; retry");
      renameSync(tmp, resolved);
    } finally {
      rmSync(tmp, { force: true });
    }
  } finally {
    // flock(2) is held by the open file description: closing the descriptor releases it.
    closeSync(lockFd);
  }
}

/**
 * Open `path` with `O_NOFOLLOW` (a symlink is ELOOP, never followed) and hold
 * an exclusive `flock(2)` on THAT descriptor, waiting up to `timeoutMs` in
 * 10 ms non-blocking tries. Darwin takes the lock in the open itself
 * (`O_EXLOCK|O_NONBLOCK`, one syscall: nothing can be swapped between the
 * open and the lock); Linux has no `O_EXLOCK`, so the transport's pinned
 * helper (`KERNEL_LOCK`, `/usr/bin/flock` — never a PATH lookup, whose exit 0
 * would be taken as proof of a lock a PATH program never took)
 * locks the INHERITED descriptor — an fd, not a path, so a later path
 * replacement cannot move the lock. A helper that cannot run is a loud
 * refusal, and the descriptor it was meant to lock is closed. The lock
 * releases when the caller closes the descriptor. `hooks` are test seams only.
 */
const O_EXLOCK_DARWIN = 0x20;
export function acquireNoFollowLock(path: string, timeoutMs: number, hooks?: LockHooks): number {
  const base = constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let fd: number;
    if (process.platform === "darwin") {
      try { fd = openSync(path, base | O_EXLOCK_DARWIN | constants.O_NONBLOCK, 0o600); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EAGAIN" || code === "EWOULDBLOCK") { if (Date.now() >= deadline) throw new DigestWindowError("config lock busy; retry"); Bun.sleepSync(10); continue; }
        throw new DigestWindowError(`could not open config lock: ${code ?? String(error)}`);
      }
      hooks?.afterOpen?.(path);
      hooks?.afterLock?.(path);
      return fd;
    }
    if (process.platform !== "linux") throw new DigestWindowError(`config lock: no descriptor lock on ${process.platform}`);
    try { fd = openSync(path, base, 0o600); }
    catch (error) { throw new DigestWindowError(`could not open config lock: ${(error as NodeJS.ErrnoException).code ?? String(error)}`); }
    hooks?.afterOpen?.(path);
    // `flock(1)`'s descriptor form: fd 3 in the child is this descriptor (Bun passes it verbatim).
    let held: { exitCode: number | null };
    try { held = Bun.spawnSync([KERNEL_LOCK, "--exclusive", "--nonblock", "3"], { stdio: ["ignore", "ignore", "ignore", fd] } as never); }
    catch (error) {
      closeSync(fd);
      throw new DigestWindowError(`config lock: ${KERNEL_LOCK} could not run: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
    }
    if (held.exitCode === 0) { hooks?.afterLock?.(path); return fd; }
    closeSync(fd);
    if (held.exitCode !== 1) throw new DigestWindowError(`config lock: ${KERNEL_LOCK} exited ${held.exitCode}`);
    if (Date.now() >= deadline) throw new DigestWindowError("config lock busy; retry");
    Bun.sleepSync(10);
  }
}
export interface LockHooks { afterOpen?(path: string): void; afterLock?(path: string): void }

/**
 * `pathlib.Path(path).resolve()` is `os.path.realpath(strict=False)`: POSIX
 * order (symlinks before `..`), a DANGLING link followed to its target's path
 * (which the writer then creates, leaving the link in place),
 * absent components kept lexically, loops bounded. S's
 * `physicalPath` (clear-fence.ts) is that walker; exported for this caller.
 */
function pyResolve(path: string): string {
  return physicalPath(path);
}
