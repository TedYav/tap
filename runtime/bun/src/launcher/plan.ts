// Dark plan --json seam. Python is a printer over existing internals:
// build_harness_invocation, apply_launch_env, resolve_resume_target,
// revive_tier, _json_safe. Not a tap verb and not a main.ts route.

import { buildHarnessInvocation } from "./adapters";
import { resolveCatalog } from "./catalog";
import { planResume } from "./resume-identity";
import {
  LauncherError,
  UNBOUND_RESUME_IDENTITY,
  type Invocation,
  type ResumeIdentity,
  type SessionRecord,
} from "./types";

export type TomlDate = {
  $toml: "date";
  year: number;
  month: number;
  day: number;
};

export type TomlTime = {
  $toml: "time";
  hour: number;
  minute: number;
  second: number;
  microsecond?: number;
};

export type TomlDateTime = {
  $toml: "datetime";
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  microsecond?: number;
  offset?: string | null;
};

export type ExactInt = { $int: string };
export type ExactFloat = { $float: string };

export type PlanRecord = {
  name: string;
  harness: string;
  cwd: string;
  base: string;
  model: string | null;
  harness_session_id: string | null;
  transcript_path: string | null;
  quarantined_harness_session_id: string | null;
  harness_env: Record<string, string>;
};

export type PlanJson = {
  id: string;
  argv: string[] | null;
  env: Record<string, string>;
  record: PlanRecord;
  resume: ReturnType<typeof planResume>;
  refusal: string | null;
  json_safe: unknown;
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function pad4(n: number): string {
  return String(n).padStart(4, "0");
}

function pad6(n: number): string {
  return String(n).padStart(6, "0");
}

function isoDate(year: number, month: number, day: number): string {
  return `${pad4(year)}-${pad2(month)}-${pad2(day)}`;
}

function isoTime(
  hour: number,
  minute: number,
  second: number,
  microsecond = 0,
): string {
  const base = `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
  return microsecond ? `${base}.${pad6(microsecond)}` : base;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactInt(value: Record<string, unknown>): value is ExactInt {
  return Object.keys(value).length === 1 && typeof value.$int === "string";
}

function isExactFloat(value: Record<string, unknown>): value is ExactFloat {
  return Object.keys(value).length === 1 && typeof value.$float === "string";
}

function isTomlDate(value: Record<string, unknown>): value is TomlDate {
  return value.$toml === "date";
}

function isTomlTime(value: Record<string, unknown>): value is TomlTime {
  return value.$toml === "time";
}

function isTomlDateTime(value: Record<string, unknown>): value is TomlDateTime {
  return value.$toml === "datetime";
}

/**
 * Port of presets._json_safe, then number tags so parsed compare keeps
 * TOML 1 vs 1.0 and ints past Number.MAX_SAFE_INTEGER. IEEE Number and
 * Date are refused — those are the J3/J4 write constraints.
 */
export function jsonSafe(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    throw new TypeError(
      "jsonSafe refuses IEEE Number; pass bigint or { $float: decimal }",
    );
  }
  if (value instanceof Date) {
    throw new TypeError("jsonSafe refuses Date; pass a $toml temporal");
  }
  if (typeof value === "bigint") {
    return { $int: value.toString() };
  }
  if (Array.isArray(value)) {
    return value.map(jsonSafe);
  }
  if (isPlainObject(value)) {
    if (isExactInt(value) || isExactFloat(value)) return value;
    if (isTomlDate(value)) {
      return isoDate(value.year, value.month, value.day);
    }
    if (isTomlTime(value)) {
      return isoTime(
        value.hour,
        value.minute,
        value.second,
        value.microsecond ?? 0,
      );
    }
    if (isTomlDateTime(value)) {
      const stamp = `${isoDate(value.year, value.month, value.day)}T${isoTime(
        value.hour,
        value.minute,
        value.second,
        value.microsecond ?? 0,
      )}`;
      return value.offset ? `${stamp}${value.offset}` : stamp;
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[String(key)] = jsonSafe(item);
    }
    return out;
  }
  return String(value);
}

/**
 * Compose the launch environment from its tiers, later winning.
 *
 *   1. claude cosmetics -- the ONLY env the launcher originates, and deliberately
 *      still parent-honouring: they carry no audit weight.
 *   2. `[harness.<name>.env]` machine policy, read FRESH on every launch and
 *      every resume. Reading rather than replaying is what makes the policy
 *      migration-free: a seat created before the policy existed picks it up on
 *      its next resume. Never written back into the record -- policy belongs to
 *      the machine, the record stays portable.
 *   3. `invocation.env`.
 *   4. `record.harness_env` -- what the operator chose for THIS seat. Seat intent
 *      outranks machine policy.
 *
 * TIER 2 WAS MISSING ENTIRELY (tap-dv0b6), and the docstring that used to sit
 * here said so while pointing at a fixture that hid it: it froze
 * `XDG_CONFIG_HOME` to an empty sandbox "so Python's tier-2 is empty too", which
 * removes the only input that can tell the two apart. Measured against the
 * incumbent with a real config, the operator's variable never reached the child
 * AND their override of a launcher cosmetic lost to our own default -- the tier
 * ordering inverted, not merely a key dropped.
 *
 * It resolves its own policy rather than taking it as an argument, because the
 * incumbent does: `apply_launch_env` calls `resolve_harness_env` even when the
 * caller already read the same file. That second read is not waste, it is what
 * "read fresh on every launch AND resume" means -- and it is survivable only
 * because the notice sink dedups identical text for the life of a COMMAND, which
 * is why `notice` belongs here rather than a caller-side collision loop.
 *
 * A DECLARED value always beats the launching shell.
 * The shell used to win, so the same preset produced different seats from
 * different terminals with nothing said. The collision is announced instead,
 * once per key in sorted order -- and it names the KEY ONLY, never either value:
 * the key fence is name-based and permits plural forms, so `HF_TOKENS` clears it
 * and echoing the value would put a credential into pane transcripts and
 * anything pasted out of them.
 */
export function applyLaunchEnv(
  invocation: Invocation,
  record: SessionRecord,
  env: NodeJS.ProcessEnv = process.env,
  // Silent by default, which is the PRE-FLIGHT shape: `notify_env_policy=False`
  // suppresses exactly the policy notices and the collision warnings, and marks
  // nothing as already said, so the real build still owes them.
  notice: (message: string) => void = () => {},
  // Crew retains the incumbent's read-fault vocabulary through its live reader.
  // Call here, not with an earlier policy snapshot: env policy is read fresh.
  readPolicyEnv: () => Record<string, string> = () => resolveCatalog(undefined, record.harness, env, notice).policyEnv,
): Invocation {
  const composed: Record<string, string> = {};
  if (record.harness === "claude") {
    composed.CLAUDE_CODE_TMUX_TRUECOLOR =
      env.CLAUDE_CODE_TMUX_TRUECOLOR ?? "1";
    composed.CLAUDE_CODE_SCROLL_SPEED = env.CLAUDE_CODE_SCROLL_SPEED ?? "6";
  }
  const policyEnv = readPolicyEnv();
  const declared: Record<string, string> = {
    ...policyEnv,
    ...invocation.env,
    ...(record.harness_env ?? {}),
  };
  for (const key of Object.keys(declared).sort()) {
    const ambient = env[key];
    if (ambient !== undefined && ambient !== declared[key]) {
      notice(`tap session: overriding ambient ENV var ${key} with the declared value`);
    }
  }
  Object.assign(composed, declared);
  return { argv: invocation.argv, env: composed };
}

export function planRecord(record: SessionRecord): PlanRecord {
  return {
    name: record.name,
    harness: record.harness,
    cwd: record.cwd,
    base: record.base,
    model: record.model ?? null,
    harness_session_id: record.harness_session_id ?? null,
    transcript_path: record.transcript_path ?? null,
    quarantined_harness_session_id:
      record.quarantined_harness_session_id ?? null,
    harness_env: { ...(record.harness_env ?? {}) },
  };
}

export function planJson(input: {
  id: string;
  action: string;
  record: SessionRecord;
  prompt?: string | null;
  resumeIdentity?: ResumeIdentity;
  jsonSafeValues?: unknown;
  env?: NodeJS.ProcessEnv;
}): PlanJson {
  const env = input.env ?? process.env;
  const resumeIdentity =
    input.resumeIdentity === undefined
      ? UNBOUND_RESUME_IDENTITY
      : input.resumeIdentity;
  let argv: string[] | null = null;
  let composedEnv: Record<string, string> = {};
  let refusal: string | null = null;
  try {
    const inv = buildHarnessInvocation(
      input.action,
      input.record,
      input.prompt ?? null,
      resumeIdentity,
      env,
    );
    const launched = applyLaunchEnv(inv, input.record, env);
    argv = launched.argv;
    composedEnv = launched.env;
  } catch (err) {
    if (err instanceof LauncherError) {
      refusal = `LauncherError: ${err.message}`;
    } else {
      throw err;
    }
  }
  return {
    id: input.id,
    argv,
    env: composedEnv,
    record: planRecord(input.record),
    resume: planResume(input.record, env),
    refusal,
    json_safe:
      input.jsonSafeValues === undefined ? null : jsonSafe(input.jsonSafeValues),
  };
}
