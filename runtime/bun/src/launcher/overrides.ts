import { environment, refuse } from "./catalog";

export interface Overrides { env?: string[]; unset_env?: string[]; argv?: string[] }
export interface OverrideRecipe {
  harness_env?: Record<string, string>;
  harness_unset_env?: string[];
  harness_tail?: string[];
}

export function parseEnvAssignments(values: string[] = []): Record<string, string> {
  const env: Record<string, string> = Object.create(null);
  for (const value of values) {
    const at = value.indexOf("=");
    if (at < 0) refuse("launch_arg_invalid", "--env is missing '='; pass KEY=VALUE");
    env[value.slice(0, at)] = value.slice(at + 1);
  }
  return env;
}

/** Explicit sets replace stored values; unsets mask all lower environment tiers. */
export function applyOverrides(recipe: OverrideRecipe, overrides: Overrides): Required<OverrideRecipe> {
  const sets = environment(parseEnvAssignments(overrides.env), "launch_env_forbidden");
  const removes = overrides.unset_env ?? [];
  environment(Object.fromEntries(removes.map(key => [key, "1"])), "launch_env_forbidden");
  for (const key of removes) {
    if (Object.hasOwn(sets, key)) refuse("launch_arg_invalid", `both --env and --unset-env name ${key}`);
  }
  const env = { ...recipe.harness_env, ...sets };
  const unset = new Set(recipe.harness_unset_env ?? []);
  for (const key of Object.keys(sets)) unset.delete(key);
  for (const key of removes) { delete env[key]; unset.add(key); }
  const tail = [...recipe.harness_tail ?? [], ...overrides.argv ?? []];
  if (tail.some(arg => arg.includes("\0"))) refuse("launch_arg_invalid", "NUL in harness argument");
  return { harness_env: env, harness_unset_env: [...unset].sort(), harness_tail: tail };
}

const valueFlags = new Set(["--tag", "--workdir", "--unique", "--model", "--preset", "--effort", "--env", "--unset-env"]);
const boolFlags = new Set(["--teams", "--fresh", "--new", "--attach", "--dry-run", "--json"]);
/** Flags that take an optional `=value` only: `--resume` (picker) and `--resume=<id>` (exact); `--resume <id>` would eat the seat name. */
const optionalValueFlags = new Set(["--resume"]);

/** argparse treats dash-led values as options, except negative numbers and '-'. */
export const looksLikeOption = (token: string): boolean => token.startsWith("-") && token !== "-" && !/^-\d+$|^-\d*\.\d+$/.test(token);

/** Help belongs to TAP until a value operand or harness passthrough owns it. */
export function launchHelpRequested(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") return false;
    if (valueFlags.has(arg)) {
      const value = argv[++i];
      if (value === undefined || looksLikeOption(value)) return false;
      continue;
    }
    if (arg === "-h" || arg === "--help") return true;
    if (valueFlags.has(arg.split("=")[0]!) || boolFlags.has(arg) || optionalValueFlags.has(arg.split("=")[0]!)) continue;
    // The first unknown option starts the implicit harness tail too.
    if (arg.startsWith("-") && arg !== "-") return false;
  }
  return false;
}

/** The launch wrapper's pnpm-style split. Everything after -- is a literal child tail. */
export function splitLaunchPassthrough(argv: string[], warn: (message: string) => void = message => process.stderr.write(`${message}\n`)): [string[], string[]] {
  if (argv[0] !== "new") return [argv, []];
  const own: string[] = ["new"], tail: string[] = [];
  let started = false, harnessIndex: number | undefined, labelSeen = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (started) {
      if (arg === "--preset" || arg.startsWith("--preset=")) refuse("preset_passthrough", "--preset is never forwarded; move --preset before harness passthrough begins");
      tail.push(arg); continue;
    }
    if (arg === "--") { started = true; continue; }
    if (valueFlags.has(arg)) {
      own.push(arg);
      if (i + 1 < argv.length) own.push(argv[++i]!);
    } else if (valueFlags.has(arg.split("=")[0]!) || boolFlags.has(arg) || optionalValueFlags.has(arg.split("=")[0]!)) own.push(arg);
    else if (arg.startsWith("-") && arg !== "-") {
      const flag = arg.split("=")[0]!;
      warn(`tap session launch: warning: ${flag} is not a TAP launch option; it and following arguments are forwarded to the harness. Use -- before intentional harness arguments.${flag === "--cwd" ? " Use --workdir <path> to start in a linked worktree of the enrolled team." : ""}`);
      started = true; i--;
    }
    else if (harnessIndex === undefined) { harnessIndex = own.length; own.push(arg); }
    else if (!labelSeen) { own.splice(harnessIndex + 1, 0, arg); labelSeen = true; }
    else refuse("launch_arg_invalid", `unexpected argument '${arg}': harness passthrough flags must start with '-'; use '--' before bare harness arguments`);
  }
  return [own, tail];
}

/** Preset or inherited launch baseline. Explicit tails are composed separately. */
export function resolveRecordTuning(request: Record<string, any>): unknown[] {
  const { preset, inherited, tuning, model } = request;
  if (preset) return [preset.model, preset.harness_passthrough, preset.env, preset.provenance, true];
  const passthrough = tuning?.harness_passthrough?.length ? tuning.harness_passthrough : inherited?.harness_passthrough ?? [];
  return [model || inherited?.model || null, passthrough,
    { ...inherited?.harness_env, ...tuning?.env }, inherited?.preset ?? null,
    tuning?.harness_passthrough?.length ? false : inherited?.passthrough_from_config ?? false];
}
