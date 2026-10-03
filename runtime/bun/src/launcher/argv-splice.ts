import { configAssignments, configDefaults } from "./config-args";

export type ParamValue = boolean | string | string[];

/**
 * Render params as argv tokens. `false` is omit; insertion order is preserved.
 *
 * A flag-shaped VALUE takes the unambiguous `--key=value` spelling, because
 * `["--workspace", "-tmp"]` reads as two flags to every parser we hand it to.
 */
export function paramsToArgv(params: Record<string, ParamValue>): string[] {
  const argv: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === false) continue;
    const flag = `--${key}`;
    if (value === true) { argv.push(flag); continue; }
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item.startsWith("-")) argv.push(`${flag}=${item}`);
      else argv.push(flag, item);
    }
  }
  return argv;
}

/**
 * `--workspace=-tmp` and `--workspace` are the SAME option.
 *
 * The floor asks "does the builder already emit this flag?" -- a question about
 * the option, not the spelling. Comparing whole tokens missed the `=` form, so a
 * config value beginning with `-` (rendered `--key=value` to keep it
 * unambiguous) slipped past the floor and the harness received the option TWICE.
 */
const optionName = (token: string): string => token.split("=", 1)[0]!;

/**
 * Insert tokens at index 1. `floor` is for CONFIG-SOURCED tokens only.
 *
 * Two kinds of list arrive here. Config-sourced tokens (preset `params`,
 * harness-table `params`) pass `floor: true`: builder argv is the floor and
 * config can only ADD. Operator-typed passthrough -- the pnpm-style tail a human
 * typed on `tap session launch`, persisted on the seat -- passes `floor: false`
 * and inserts unconditionally even when the builder emits the same flag, because
 * the operator is the stronger authority, not a weaker one.
 *
 * Presence, when flooring, is exact OPTION equality, never a substring scan: a
 * prompt element `"use --model x"` must not look like a flag, and `--model` must
 * not match `--model-reasoning`.
 *
 * Insertion is right after `argv[0]` because four builders append a trailing
 * positional; appending here would put flags after the prompt (cursor) or
 * mid-option (agy `--prompt-interactive`).
 *
 * A valued config token whose flag is already present is skipped TOGETHER with
 * its following non-flag value, so a later config tier cannot replace a value.
 * `false` never reaches here (`paramsToArgv` omits it): it declines to ADD and
 * cannot turn a builder-owned flag off.
 */
export function spliceTokensIfAbsent(
  argv: readonly string[],
  tokens: readonly string[],
  options: { floor?: boolean; configKeys?: boolean } = {},
): string[] {
  const { floor = true, configKeys = false } = options;
  if (!argv.length) return [...argv];

  let working: readonly string[] = tokens;
  let head: readonly string[] = argv;
  if (configKeys) {
    if (floor) {
      working = configDefaults(working, argv.slice(1));
    } else {
      working = configDefaults(working, []);
      head = [argv[0]!, ...configDefaults(argv.slice(1), working)];
    }
  }
  if (!floor) return [head[0]!, ...working, ...head.slice(1)];

  const present = new Set(head.filter(token => token.startsWith("-")).map(optionName));
  const spans = new Map<number, number>();
  if (configKeys) for (const [start, end] of configAssignments(working)) spans.set(start, end);

  const extra: string[] = [];
  let index = 0;
  while (index < working.length) {
    const span = spans.get(index);
    if (span !== undefined) {
      // A complete `-c key=value` assignment rides as one unit: its value is not
      // a stray positional and must not be judged as one.
      extra.push(...working.slice(index, span));
      index = span;
      continue;
    }
    const token = working[index]!;
    const isFlag = token.startsWith("-");
    const valued = isFlag && !token.includes("=")
      && index + 1 < working.length && !working[index + 1]!.startsWith("-");
    if (isFlag && present.has(optionName(token))) {
      index += valued ? 2 : 1;
      continue;
    }
    extra.push(token);
    index += 1;
  }
  if (!extra.length) return [...head];
  return [head[0]!, ...extra, ...head.slice(1)];
}

/** Insert config params at index 1 through the shared floor-aware splice. */
export function spliceVerbatimParams(
  argv: readonly string[], params: Record<string, ParamValue>,
  options: { configKeys?: boolean } = {},
): string[] {
  return spliceTokensIfAbsent(argv, paramsToArgv(params), { configKeys: options.configKeys });
}
