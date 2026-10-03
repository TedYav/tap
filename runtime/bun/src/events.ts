// The registry event log has ONE writer.
//
// `registry-events.log` is the operator visibility tail on a bus (CONTRACT.md
// § Registry event log): one line per lifecycle/courier event, tail-truncated
// at write. Until this module, that write existed three times — an inline
// Python program inside lib.sh `tap_registry_event_append`, a second copy in
// `session/launcher.py`, and native verbs that spawned `bash -c '. lib.sh; …'`
// to reach the first. Three implementations of one lock-and-rewrite is how the
// two Python copies came to disagree about which blank lines survive. This file
// is the one implementation; lib.sh keeps a forwarding adapter so every Bash and
// Python-in-.sh caller reaches it by the name they already use.
//
// What is preserved from the incumbent, byte for byte: the line shape
// (`ts= actor= action= handle= pane= [detail=] team=`, `team` last), the atom
// sanitizer (empty → `-`, whitespace runs → `_`), the `<log>.lock` sidecar and
// the `<log>.tmp` rename, the last-N retention (`TAP_REGISTRY_EVENT_LIMIT`,
// default 200, floor 1), and the warn-only failure contract of the callers.
//
// The lock is `acquirePathLock` on that same sidecar: kernel flock(2) through
// the platform helper, so an in-flight process still running the old lib.sh
// body (a deliverer sidecar that loaded before this landed) and this writer
// exclude each other on the same inode. Two deliberate deviations: the Python
// writer blocked on LOCK_EX forever, this one gives up after
// EVENT_LOCK_TIMEOUT_MS and reports; and a host without the lock helper reports
// `lock_unavailable` instead of throwing into a warn-only caller.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseUnicodeDecimal } from "./unicode-decimal";
import { acquirePathLock } from "./panelock";

export const REGISTRY_EVENTS_FILE = "registry-events.log";
export const DEFAULT_EVENT_LIMIT = 200;
/** A wedged holder must not park a warn-only breadcrumb forever. */
export const EVENT_LOCK_TIMEOUT_MS = 5000;

export function registryEventsPath(busHome: string): string {
  return join(busHome, REGISTRY_EVENTS_FILE);
}

export interface RegistryEventFields {
  actor: string;
  action: string;
  handle: string;
  pane: string;
  team: string;
  /** Present in the line only when non-empty; whitespace-only still prints `detail=-`. */
  detail: string;
}

// Python's str.isspace()/re `\s` class, not JavaScript's: the incumbent turned
// U+001C–U+001F and U+0085 into `_` (a `\x1f` separator inside a detail is the
// live case), and did NOT treat U+FEFF as whitespace. A JS `\s` here would
// silently change both.
// Exported because slice 2 needed exactly this class and nearly wrote a third
// spelling of it. This is the whitespace of Python's `str.split()` and `strip()`
// — NOT JavaScript's, and NOT `shlex`'s.
//
// The distinction is load-bearing and I got it wrong once (astra W1): `shlex`
// separates unquoted words on ' \t\r\n' ONLY, so NBSP and thin space stay
// inside a word; it falls back to this wider class only when a quote or escape
// is unfinished. `str.splitlines()` is a third set again. `observe.ts` states
// all three and uses each where it belongs; this constant is the wide one.
//
// A JS `\s` in place of this class splits inside a `ps` field on U+FEFF and
// shifts every column (tap-lrm64). The long-term home is a `pystr.ts` beside
// `pyint.ts`, which already records the same fact for `int()`; that move crosses
// a lane boundary and is not this PR's to make.
export const PY_SPACE = "[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const PY_SPACE_RUN = new RegExp(`${PY_SPACE}+`, "g");
const PY_STRIP = new RegExp(`^${PY_SPACE}+|${PY_SPACE}+$`, "g");

/** `atom()` from the incumbent: empty → `-`, strip, whitespace runs → `_`, empty again → `-`. */
export function atom(value: string | undefined | null): string {
  const raw = value || "-";
  const cleaned = raw.replace(PY_STRIP, "").replace(PY_SPACE_RUN, "_");
  return cleaned || "-";
}

/** `%Y-%m-%dT%H:%M:%SZ` in UTC — second resolution, no fraction. */
export function eventTimestamp(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function registryEventLine(fields: RegistryEventFields, now: Date = new Date()): string {
  return [
    `ts=${eventTimestamp(now)}`,
    `actor=${atom(fields.actor)}`,
    `action=${atom(fields.action)}`,
    `handle=${atom(fields.handle)}`,
    `pane=${atom(fields.pane)}`,
    ...(fields.detail ? [`detail=${atom(fields.detail)}`] : []),
    `team=${atom(fields.team)}`,
  ].join(" ");
}

/**
 * `TAP_REGISTRY_EVENT_LIMIT` as both incumbents read it: unset/empty or not an
 * integer → 200; below 1 → 1. "Integer" is Python `int()`'s grammar, which is
 * not `parseInt`'s: surrounding whitespace (but not the \x1c–\x1f separators
 * `str.strip` removes), an optional sign, Unicode decimal digits, and single
 * underscores between digits; no exponent, no radix prefix, no trailing junk.
 */
export function eventLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_EVENT_LIMIT;
  const text = raw.replace(PY_INT_STRIP, "");
  const body = /^([+-]?)(\d(?:_?\d)*)$/u.exec(text.replace(/\p{Nd}/gu, digit => {
    // The repo's Nd decoder, not a local one: decimal blocks are adjacent
    // (U+1D7CE..U+1D7D7 abuts U+1D7D8), so "find the nearest non-Nd below" and
    // "codepoint % 10" both decode the second block wrong.
    const value = parseUnicodeDecimal(digit);
    return value === null ? "\uffff" : String(value);
  }));
  if (!body) return DEFAULT_EVENT_LIMIT;
  const limit = Number.parseInt(`${body[1]}${body[2]!.replaceAll("_", "")}`, 10);
  return limit < 1 ? 1 : limit;
}

const PY_INT_STRIP = /^[\t-\r \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t-\r \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;

export type AppendResult =
  | { ok: true }
  | { ok: false; reason: "lock_timeout" | "lock_unavailable" | "io_error"; detail: string };

export interface AppendRegistryEventOptions extends RegistryEventFields {
  /** The log file itself (`<bus>/registry-events.log`); the lock is `<log>.lock`. */
  log: string;
  /** Overrides the environment's `TAP_REGISTRY_EVENT_LIMIT`; omit to inherit it. */
  limit?: number;
  /** A caller holding reset custody supplies its shorter durable-write budget. */
  lockTimeoutMs?: number;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

/**
 * Append one line under the shared sidecar lock and keep the last `limit`.
 *
 * The retention bound resolves HERE, from this call's environment, so every
 * door agrees: the Bash adapter's `TAP_REGISTRY_EVENT_LIMIT` reached the old
 * writer because it was a child process, and an in-process native caller has
 * no such inheritance moment. An explicit `limit` still overrides it.
 *
 * Reads the existing file the way the Python did — universal newlines, blank
 * lines dropped, whitespace-only lines KEPT (that is the lib.sh reading; the
 * launcher copy filtered them and is the one that was deleted) — appends,
 * truncates from the front, writes `<log>.tmp`, renames over `<log>`. Never
 * throws: every failure is a result the caller turns into its own warning.
 */
export function appendRegistryEvent(opts: AppendRegistryEventOptions): AppendResult {
  const { log } = opts;
  if (!log) return { ok: false, reason: "io_error", detail: "registry event log path is empty" };
  const env = opts.env ?? process.env;
  const line = registryEventLine(opts, opts.now);
  const limit = Math.max(1, Math.trunc(opts.limit ?? eventLimit(env.TAP_REGISTRY_EVENT_LIMIT)));
  const lockPath = `${log}.lock`;
  let lock: ReturnType<typeof acquirePathLock>;
  try {
    mkdirSync(dirname(log), { recursive: true });
    lock = acquirePathLock(lockPath, opts.lockTimeoutMs ?? EVENT_LOCK_TIMEOUT_MS, env);
  } catch (error) {
    return { ok: false, reason: "lock_unavailable", detail: String(error instanceof Error ? error.message : error) };
  }
  if (!lock) return { ok: false, reason: "lock_timeout", detail: `${lockPath} held for longer than ${opts.lockTimeoutMs ?? EVENT_LOCK_TIMEOUT_MS}ms` };
  try {
    let lines: string[] = [];
    try {
      lines = readFileSync(log, "utf8").split(/\r\n|\r|\n/).filter(entry => entry !== "");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    lines.push(line);
    lines = lines.slice(-limit);
    const tmp = `${log}.tmp`;
    writeFileSync(tmp, lines.map(entry => `${entry}\n`).join(""), "utf8");
    renameSync(tmp, log);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: "io_error", detail: String(error instanceof Error ? error.message : error) };
  } finally {
    lock.release();
  }
}

/**
 * The `tap_registry_event_append_or_warn` contract for native callers: one
 * warning line in the incumbent's exact wording, and the verb carries on. The
 * event is forensics; the mutation it describes already happened.
 */
export function appendRegistryEventOrWarn(verbLabel: string, opts: AppendRegistryEventOptions): boolean {
  const result = appendRegistryEvent(opts);
  if (!result.ok) {
    process.stderr.write(`${verbLabel}: warning: registry event log append failed action=${opts.action} handle=${opts.handle}\n`);
  }
  return result.ok;
}

// Adapter door for lib.sh `tap_registry_event_append`: seven positionals, all
// data (the empty detail travels as an empty argument). The limit is read here
// from the environment exactly where the Bash body used to read it.
if (import.meta.main) {
  try {
    const [op, ...rest] = Bun.argv.slice(2);
    if (op !== "append" || rest.length !== 7) {
      throw new Error("expected: append <log> <actor> <action> <handle> <pane> <team> <detail>");
    }
    const [log, actor, action, handle, pane, team, detail] = rest as [string, string, string, string, string, string, string];
    const result = appendRegistryEvent({ log, actor, action, handle, pane, team, detail });
    if (!result.ok) {
      console.error(`registry event append failed: ${result.reason}: ${result.detail}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(String(error));
    process.exit(2);
  }
}
