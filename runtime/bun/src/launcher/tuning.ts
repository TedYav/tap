// Per-harness tuning axes (ported from the retired presets.TUNING_CAPABILITIES) and
// the argv-supplied tuning resolver (ported from presets.resolve_tuning under
// cli_tuning_context). launcher-tuning.test.ts holds the enumerating pin.
import { pyBlank } from "./catalog-metadata";
import { environment, refuse } from "./catalog";
import { assignments } from "./config-args";

type TuningAxis = {
  argv: readonly string[];
  valueTemplate?: string;
  /** The closed value set the harness publishes; absent means pass through. */
  domain?: readonly string[];
};

type HarnessTuning = {
  model?: TuningAxis;
  effort?: TuningAxis;
  /** opencode fuses provider into model as provider/model. */
  provider?: boolean;
};

const EFFORT_AGY = ["low", "medium", "high"];
const EFFORT_CLAUDE = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_HERMES = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export const TUNING_CAPABILITIES: Record<string, HarnessTuning> = {
  claude: { model: { argv: ["--model"] }, effort: { argv: ["--effort"], domain: EFFORT_CLAUDE } },
  codex: { model: { argv: ["--model"] }, effort: { argv: ["-c"], valueTemplate: 'model_reasoning_effort="{value}"' } },
  opencode: { model: { argv: ["--model"] }, provider: true },
  cursor: { model: { argv: ["--model"] } },
  agy: { model: { argv: ["--model"] }, effort: { argv: ["--effort"], domain: EFFORT_AGY } },
  hermes: { model: { argv: ["--model"] }, effort: { argv: ["--reasoning"], domain: EFFORT_HERMES } },
};

/** What TAP passed at launch, not the model's later in-session settings. */
export type LaunchTuning = {
  model: string | null; effort: string | null;
  qualifiers: Record<string, string>; environment: Record<string, string>;
};

// Read only tuning axes, using the same option definitions as their writer.
// Unknown harness defaults stay null; explicit tail options occur last.
export function launchTuning(harness: string, argv: readonly string[], env: Record<string, string | undefined> = {}): LaunchTuning {
  const caps = TUNING_CAPABILITIES[harness];
  const values = new Map<string, string>();
  const flags = new Set([...(caps?.model?.argv ?? []), ...(caps?.effort?.valueTemplate ? [] : caps?.effort?.argv ?? []), "--provider"]);
  if (["claude", "codex", "opencode", "hermes"].includes(harness)) flags.add("-m");
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") break;
    const equal = token.indexOf("="), key = equal < 0 ? token : token.slice(0, equal);
    if (!flags.has(key)) continue;
    const value = equal < 0 ? argv[++i] : token.slice(equal + 1);
    if (value && !value.startsWith("-")) values.set(key === "-m" ? "--model" : key, value);
  }
  const qualifiers: Record<string, string> = {};
  if (harness === "codex") for (const { start, end, key } of assignments(argv)) {
    if (!["model_reasoning_effort", "service_tier", "model_context_window", "model_max_output_tokens"].includes(key)) continue;
    const token = argv[end - 1]!, raw = end - start === 1 ? token.slice(token.indexOf("=") + 1) : token;
    const value = raw.slice(raw.indexOf("=") + 1).trim();
    // Codex accepts bare strings as well as TOML scalars.
    let parsed: unknown = value;
    try { parsed = (Bun.TOML.parse(`value = ${value}`) as Record<string,unknown>).value; } catch { /* bare string */ }
    qualifiers[key] = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
  }
  const effort = caps?.effort?.valueTemplate ? qualifiers.model_reasoning_effort ?? null : values.get(caps?.effort?.argv[0] ?? "") ?? null;
  delete qualifiers.model_reasoning_effort;
  const provider = values.get("--provider");
  if (provider) qualifiers.provider = provider;
  const environment: Record<string, string> = {};
  // This is the catalog's current wrapper qualification, never a provider credential.
  if (harness === "codex" && env.PONYTAIL_DEFAULT_MODE !== undefined) environment.PONYTAIL_DEFAULT_MODE = env.PONYTAIL_DEFAULT_MODE;
  return { model: values.get(caps?.model?.argv[0] ?? "") ?? null, effort, qualifiers, environment };
}

function tokens(axis: TuningAxis, value: string): string[] {
  const rendered = axis.valueTemplate
    ? axis.valueTemplate.replace("{value}", value)
    : value;
  return [...axis.argv, rendered];
}

/** Flag tokens for a resolved model, or empty when none was supplied. */
export function modelArgv(harness: string, model: string | null | undefined): string[] {
  if (!model) return [];
  const axis = TUNING_CAPABILITIES[harness]?.model;
  if (!axis) return [];
  return tokens(axis, model);
}

const RANK = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const rank = (value: string): number => { const i = RANK.indexOf(value); return i < 0 ? RANK.length : i; };
const formatDomain = (domain: readonly string[]): string =>
  [...domain].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0)).join(", ");

/** Harnesses whose row supports `field`, sorted by name. */
export function axisSupportList(field: "model" | "effort" | "provider"): string {
  const names = Object.keys(TUNING_CAPABILITIES).sort().filter(name => TUNING_CAPABILITIES[name]![field]);
  return names.length ? names.join(", ") : "none";
}

export type ResolvedTuning = { model: string | null; harness_passthrough: string[]; env: Record<string, string> };

const cliFlag = (field: string): string => field.startsWith("env.") ? `--env ${field.slice(4)}` : `--${field}`;
const fieldError = (field: string, problem: string): never =>
  refuse("launch_arg_invalid", `${cliFlag(field)} ${problem}`, `fix the ${cliFlag(field)} value`);

function behavioralString(value: string, field: string): string {
  if (pyBlank(value)) fieldError(field, "must be a non-empty string");
  if (/[\x00-\x1f\x7f]/.test(value)) fieldError(field, "contains a control character");
  return value;
}

function checked(harness: string, field: "model" | "effort", value: string, axis: TuningAxis | undefined): TuningAxis {
  if (!axis) {
    refuse(`launch_${field}_unsupported`,
      `harness '${harness}' does not support --${field} (supported by: ${axisSupportList(field)})`,
      `remove --${field} or launch a harness that supports it (${axisSupportList(field)})`);
  }
  if (axis.domain && !axis.domain.includes(value)) {
    refuse("launch_arg_invalid",
      `harness '${harness}' does not accept --${field} ${value} (legal: ${formatDomain(axis.domain)})`,
      `pass --${field} as one of: ${formatDomain(axis.domain)}`);
  }
  return axis;
}

/**
 * Validate and translate argv tuning for one harness: model and effort against
 * the axis table, then the env fence. `null` means not supplied; an empty
 * string is supplied and refused. A null harness judges only the env fence.
 */
export function resolveCliTuning(harness: string | null, model: string | null, effort: string | null,
                                 rawEnv: Record<string, string>): ResolvedTuning {
  const caps = harness === null ? {} : TUNING_CAPABILITIES[harness] ?? {};
  let resolvedModel: string | null = null;
  let passthrough: string[] = [];
  if (harness !== null && model !== null) {
    resolvedModel = behavioralString(model, "model");
    checked(harness, "model", resolvedModel, caps.model);
  }
  if (harness !== null && effort !== null) {
    const resolvedEffort = behavioralString(effort, "effort");
    passthrough = tokens(checked(harness, "effort", resolvedEffort, caps.effort), resolvedEffort);
  }
  const env = environment(rawEnv, "launch_env_forbidden", {
    notTable: () => refuse("launch_arg_invalid", "--env values must be supplied as KEY=VALUE pairs", "pass environment as --env KEY=VALUE"),
    keyInvalid: key => refuse("launch_arg_invalid", `--env key '${key}' is not a valid environment variable name`, `fix the --env key '${key}'`),
    forbidden: key => refuse("launch_env_forbidden", `--env key '${key}' crosses the identity, transport, process, credential, or policy fence`, `remove --env ${key}=... from the command`),
    fieldError: (field, problem) => fieldError(field, problem),
  });
  return { model: resolvedModel, harness_passthrough: passthrough, env: { ...env } };
}
