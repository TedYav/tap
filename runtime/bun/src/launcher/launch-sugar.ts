// `--context` and `--ponytail`: shorthand for settings a seat already takes through --env and the `--` tail.
// Pure, so another launch verb can adopt the same expansion: harness and flags in; env, tail and replaced keys out.
import { refuse } from "../config-file";
import { assignments } from "./config-args";
import type { Overrides } from "./overrides";

export const PONYTAIL_MODES = ["off", "lite", "full", "ultra"] as const;
export type PonytailMode = typeof PONYTAIL_MODES[number];
export interface LaunchSugar { context?: number; ponytail?: PonytailMode }
export interface SugarExpansion { env: Record<string, string>; tail: string[]; replace_config: string[] }

const SUPPORTED = ["claude", "codex"];
const COMPACT_PERCENT = 95;
const CONTEXT_ENV = ["CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"] as const;
const CONTEXT_CONFIG = ["model_context_window", "model_auto_compact_token_limit"] as const;
const PONYTAIL_ENV = "PONYTAIL_DEFAULT_MODE";
const SUFFIX_DIGITS: Record<string, number> = { "": 0, k: 3, m: 6 };

/** Decimal units (1M = 1000000). Digits are shifted as text: float math turns a whole size like 4.35k into 4349.999. */
export function parseContextSize(text: string): number {
  const invalid = (): never => refuse("launch_arg_invalid", `--context needs a positive size such as 850k, 1M or 250000; got '${text}'`,
    "pass --context as digits with an optional k or m suffix");
  const match = /^(\d+)(?:\.(\d+))?([km]?)$/i.exec(text);
  if (!match) return invalid();
  const digits = SUFFIX_DIGITS[match[3]!.toLowerCase()]!, fraction = (match[2] ?? "").replace(/0+$/, "");
  if (fraction.length > digits) refuse("launch_arg_invalid", `--context ${text} is not a whole number of tokens`, "pass a size that resolves to a whole number");
  const size = BigInt(match[1]! + fraction.padEnd(digits, "0"));
  if (size === 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) return invalid();
  return Number(size);
}

export function parsePonytailMode(text: string): PonytailMode {
  const mode = PONYTAIL_MODES.find(value => value === text);
  return mode ?? refuse("launch_arg_invalid", `--ponytail must be one of ${PONYTAIL_MODES.join(", ")}; got '${text}'`, `pass --ponytail as one of: ${PONYTAIL_MODES.join(", ")}`);
}

/** The compaction floor as integer math: BigInt keeps n*95 exact above 2^53. */
const compactLimit = (size: number): number => Number(BigInt(size) * BigInt(COMPACT_PERCENT) / 100n);

function refuseUnsupported(harness: string, flag: string): never {
  const names = SUPPORTED.join(", ");
  return refuse(`launch_${flag}_unsupported`, `harness '${harness}' does not support --${flag} (supported by: ${names})`,
    `remove --${flag} or target a harness that supports it (${names})`);
}

export function expandSugar(harness: string, sugar: LaunchSugar): SugarExpansion {
  if (!SUPPORTED.includes(harness)) {
    if (sugar.context !== undefined) refuseUnsupported(harness, "context");
    if (sugar.ponytail !== undefined) refuseUnsupported(harness, "ponytail");
  }
  const env: Record<string, string> = {}, tail: string[] = [], replace_config: string[] = [];
  if (sugar.context !== undefined) {
    if (harness === "claude") Object.assign(env, { [CONTEXT_ENV[0]]: String(sugar.context), [CONTEXT_ENV[1]]: String(COMPACT_PERCENT) });
    else {
      tail.push("-c", `${CONTEXT_CONFIG[0]}=${sugar.context}`, "-c", `${CONTEXT_CONFIG[1]}=${compactLimit(sugar.context)}`);
      replace_config.push(...CONTEXT_CONFIG);
    }
  }
  if (sugar.ponytail !== undefined) env[PONYTAIL_ENV] = sugar.ponytail;
  return { env, tail, replace_config };
}

/** Fold an expansion into the overrides: env joins the typed env, and the tail becomes generated config,
 * placed after every stored and typed option but before any `--`, so the last-assignment rule picks it. */
export function withSugar(overrides: Overrides | undefined, expansion: SugarExpansion): Overrides {
  return { ...overrides, env: [...overrides?.env ?? [], ...Object.entries(expansion.env).map(([key, value]) => `${key}=${value}`)],
    config: { keys: expansion.replace_config, argv: expansion.tail } };
}

/** One value per setting: a flag and an explicit --env, --unset-env or tail naming the same key refuses for every harness. */
export function refuseSugarConflicts(sugar: LaunchSugar, overrides: Overrides = {}): void {
  const envKeys = [...(overrides.env ?? []).map(value => value.split("=", 1)[0]!), ...overrides.unset_env ?? []];
  const configKeys = assignments(overrides.argv ?? []).map(({ key }) => key);
  const check = (flag: string, env: readonly string[], config: readonly string[]) => {
    const key = envKeys.find(name => env.includes(name)) ?? configKeys.find(name => config.includes(name));
    if (key) refuse("launch_arg_invalid", `both ${flag} and an explicit setting name ${key}`, `drop ${flag} or the explicit ${key}`);
  };
  if (sugar.context !== undefined) check("--context", CONTEXT_ENV, CONTEXT_CONFIG);
  if (sugar.ponytail !== undefined) check("--ponytail", [PONYTAIL_ENV], []);
}
