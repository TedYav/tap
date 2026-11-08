import { expect, test } from "bun:test";
import { crewRecipeWithOverrides } from "../src/launcher/crew-invocation";
import { expandSugar, parseContextSize, parsePonytailMode, PONYTAIL_MODES, refuseSugarConflicts, withSugar } from "../src/launcher/launch-sugar";
import { applyOverrides, composeTail } from "../src/launcher/overrides";
import { assignments } from "../src/launcher/config-args";

const refusal = (run: () => unknown): { errorClass: string; detail: string } => {
  try { run(); } catch (error) { return error as { errorClass: string; detail: string }; }
  throw new Error("expected a refusal");
};

test.each([
  ["850k", 850000], ["850K", 850000], ["1M", 1000000], ["1m", 1000000], ["250000", 250000], ["1.5M", 1500000], ["1.5m", 1500000],
  // Float math gets these wrong: 4.35 * 1000 is 4350.000000000001 and 1.001 * 1e6 is 1000999.9999999999.
  ["4.35k", 4350], ["1.001M", 1001000], ["0.5k", 500], ["1.0", 1], ["2.50k", 2500],
])("--context %s is %d tokens", (text, size) => { expect(parseContextSize(text)).toBe(size); });

test.each(["0", "0k", "0.0M", "-5", "abc", "", "1e6", "1,000", "850kb", "k", ".5M", "1.", "+5", " 850k", "99999999999999999999"])("--context refuses '%s'", text => {
  const error = refusal(() => parseContextSize(text));
  expect(error.errorClass).toBe("launch_arg_invalid");
  expect(error.detail).toContain(`got '${text}'`);
});

test.each(["1.5", "1.0005k", "1.0000005M"])("--context %s is not a whole number of tokens", text => {
  expect(refusal(() => parseContextSize(text))).toMatchObject({ errorClass: "launch_arg_invalid", detail: `--context ${text} is not a whole number of tokens` });
});

test("--ponytail is a closed, exact value set", () => {
  for (const mode of PONYTAIL_MODES) expect(parsePonytailMode(mode)).toBe(mode);
  for (const value of ["FULL", "on", "", "off "]) expect(refusal(() => parsePonytailMode(value))).toMatchObject({ errorClass: "launch_arg_invalid" });
  expect(refusal(() => parsePonytailMode("purple")).detail).toBe("--ponytail must be one of off, lite, full, ultra; got 'purple'");
});

test("claude expands --context to the window and the fixed 95 percent override", () => {
  expect(expandSugar("claude", { context: 850000 })).toEqual({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "850000", CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "95" }, tail: [], replace_config: [] });
});

test.each([[850000, 807500], [333333, 316666], [1, 0], [Number.MAX_SAFE_INTEGER, 8556839292003941]])("codex compacts %d at %d by integer math", (size, limit) => {
  expect(expandSugar("codex", { context: size })).toEqual({ env: {},
    tail: ["-c", `model_context_window=${size}`, "-c", `model_auto_compact_token_limit=${limit}`],
    replace_config: ["model_context_window", "model_auto_compact_token_limit"] });
});

test.each(["claude", "codex"])("%s expands --ponytail to its env key and replaces no config", harness => {
  expect(expandSugar(harness, { ponytail: "lite" })).toEqual({ env: { PONYTAIL_DEFAULT_MODE: "lite" }, tail: [], replace_config: [] });
});

test("both flags combine in one expansion", () => {
  expect(expandSugar("codex", { context: 850000, ponytail: "ultra" })).toMatchObject({ env: { PONYTAIL_DEFAULT_MODE: "ultra" }, replace_config: ["model_context_window", "model_auto_compact_token_limit"] });
});

test.each(["cursor", "opencode", "agy", "hermes"])("%s refuses each flag and names the supported harnesses", harness => {
  expect(refusal(() => expandSugar(harness, { context: 850000 }))).toMatchObject({ errorClass: "launch_context_unsupported", detail: `harness '${harness}' does not support --context (supported by: claude, codex)` });
  expect(refusal(() => expandSugar(harness, { ponytail: "off" }))).toMatchObject({ errorClass: "launch_ponytail_unsupported", detail: `harness '${harness}' does not support --ponytail (supported by: claude, codex)` });
});

test.each([
  ["--context", { context: 1 }, { env: ["CLAUDE_CODE_AUTO_COMPACT_WINDOW=2"] }, "CLAUDE_CODE_AUTO_COMPACT_WINDOW"],
  ["--context", { context: 1 }, { env: ["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=90"] }, "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"],
  ["--context", { context: 1 }, { unset_env: ["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] }, "CLAUDE_CODE_AUTO_COMPACT_WINDOW"],
  ["--context", { context: 1 }, { argv: ["-c", "model_context_window=2"] }, "model_context_window"],
  ["--context", { context: 1 }, { argv: ["--config", "model_auto_compact_token_limit=2"] }, "model_auto_compact_token_limit"],
  ["--context", { context: 1 }, { argv: ["--config=model_context_window=2"] }, "model_context_window"],
  ["--ponytail", { ponytail: "off" as const }, { env: ["PONYTAIL_DEFAULT_MODE=full"] }, "PONYTAIL_DEFAULT_MODE"],
  ["--ponytail", { ponytail: "off" as const }, { unset_env: ["PONYTAIL_DEFAULT_MODE"] }, "PONYTAIL_DEFAULT_MODE"],
])("%s conflict %#", (flag, sugar, overrides, key) => {
  expect(refusal(() => refuseSugarConflicts(sugar, overrides))).toMatchObject({ errorClass: "launch_arg_invalid", detail: `both ${flag} and an explicit setting name ${key}` });
});

test("unrelated explicit settings do not conflict", () => {
  expect(() => refuseSugarConflicts({ context: 1, ponytail: "off" }, { env: ["OTHER=1"], unset_env: ["ALSO"], argv: ["-c", "service_tier=fast", "--verbose"] })).not.toThrow();
  // --ponytail alone leaves the context keys free, and the reverse.
  expect(() => refuseSugarConflicts({ ponytail: "off" }, { env: ["CLAUDE_CODE_AUTO_COMPACT_WINDOW=2"] })).not.toThrow();
  expect(() => refuseSugarConflicts({ context: 1 }, { env: ["PONYTAIL_DEFAULT_MODE=full"] })).not.toThrow();
});

test("a repeated --context replaces every spelling of its keys and leaves other tail tokens in place", () => {
  const stored = ["--verbose", "-c", "model_context_window=1", "--config", "model_auto_compact_token_limit=1", "-c", "service_tier=fast",
    "--config=model_context_window=2", "-c=model_auto_compact_token_limit=2", "-cmodel_context_window=3", "--last"];
  const first = applyOverrides({ harness_tail: stored }, withSugar(undefined, expandSugar("codex", { context: 850000 })));
  const expected = ["--verbose", "-c", "service_tier=fast", "--last", "-c", "model_context_window=850000", "-c", "model_auto_compact_token_limit=807500"];
  expect(first.harness_tail).toEqual(expected);
  const second = applyOverrides(first, withSugar(undefined, expandSugar("codex", { context: 1000000 })));
  expect(second.harness_tail).toEqual([...expected.slice(0, 4), "-c", "model_context_window=1000000", "-c", "model_auto_compact_token_limit=950000"]);
});

test("an ordinary tail keeps appending, duplicates included", () => {
  const tail = ["-c", "model_context_window=1"];
  expect(applyOverrides({ harness_tail: tail }, { argv: tail }).harness_tail).toEqual([...tail, ...tail]);
});

test("the sugar joins typed env and becomes generated config beside the typed tail", () => {
  expect(withSugar({ env: ["A=1"], unset_env: ["B"], argv: ["--verbose"] }, expandSugar("codex", { context: 100, ponytail: "off" }))).toEqual({
    env: ["A=1", "PONYTAIL_DEFAULT_MODE=off"], unset_env: ["B"], argv: ["--verbose"],
    config: { keys: ["model_context_window", "model_auto_compact_token_limit"], argv: ["-c", "model_context_window=100", "-c", "model_auto_compact_token_limit=95"] } });
});

const sugar = (argv?: string[]) => withSugar(argv ? { argv } : undefined, expandSugar("codex", { context: 850000 }));
const GENERATED = ["-c", "model_context_window=850000", "-c", "model_auto_compact_token_limit=807500"];

test.each([
  // [stored tail, typed tail, composed tail, tokens this invocation supplied]
  [[], [], GENERATED, 4],
  [["--verbose"], ["--last"], ["--verbose", "--last", ...GENERATED], 5],
  // A typed native `--`: generated options go before it, never after, where codex would read them as positional text.
  [[], ["--", "continue"], [...GENERATED, "--", "continue"], 6],
  [["--verbose"], ["--last", "--", "-c", "x=1"], ["--verbose", "--last", ...GENERATED, "--", "-c", "x=1"], 8],
  // A stored native `--`: generated options go before it too, and replay with the stored part.
  [["--verbose", "--", "continue"], [], ["--verbose", ...GENERATED, "--", "continue"], 0],
  [["--", "continue"], ["--last"], [...GENERATED, "--", "continue", "--last"], 1],
] as [string[], string[], string[], number][])("generated config precedes the first -- of stored %j + typed %j", (stored, typed, tail, fresh) => {
  const composed = composeTail(stored, sugar(typed));
  expect(composed).toEqual({ tail, fresh });
  // The tokens counted as this invocation's are exactly its typed and generated ones.
  expect(composed.tail.slice(composed.tail.length - composed.fresh)).toEqual(fresh === 0 ? [] : tail.slice(tail.length - fresh));
  expect(applyOverrides({ harness_tail: stored }, sugar(typed)).harness_tail).toEqual(tail);
});

test("assignments after a native -- are positional text: they neither conflict nor get replaced", () => {
  expect(() => refuseSugarConflicts({ context: 1 }, { argv: ["--", "-c", "model_context_window=2"] })).not.toThrow();
  expect(composeTail(["--", "-cmodel_context_window=1"], sugar()).tail).toEqual([...GENERATED, "--", "-cmodel_context_window=1"]);
});

const SPELLINGS: [string, string[]][] = [
  ["-cK=V", ["-cmodel_context_window=2"]], ["-c K=V", ["-c", "model_context_window=2"]], ["-c=K=V", ["-c=model_context_window=2"]],
  ["--config K=V", ["--config", "model_context_window=2"]], ["--config=K=V", ["--config=model_context_window=2"]],
];

test.each(SPELLINGS)("assignments() reads %s with its key and value", (_, argv) => {
  expect(assignments(argv)).toEqual([{ start: 0, end: argv.length, key: "model_context_window", value: "2" }]);
});

test("assignments() keeps an attached value's own '=' and ignores look-alikes", () => {
  expect(assignments(["-cmodel_provider=\"a=b\""])).toEqual([{ start: 0, end: 1, key: "model_provider", value: "\"a=b\"" }]);
  for (const token of ["-continue", "-cfoo", "-c=", "-c==x", "--configure=a=b"]) expect(assignments([token])).toEqual([]);
  // A separate value that is itself an option is not consumed.
  expect(assignments(["-c", "--verbose", "-cservice_tier=fast"])).toEqual([{ start: 2, end: 3, key: "service_tier", value: "fast" }]);
});

test.each(SPELLINGS)("--context refuses a typed %s for its key", (_, argv) => {
  expect(refusal(() => refuseSugarConflicts({ context: 1 }, { argv }))).toMatchObject({ errorClass: "launch_arg_invalid", detail: "both --context and an explicit setting name model_context_window" });
});

test.each(SPELLINGS)("--context replaces a stored %s and keeps its neighbours", (_, argv) => {
  expect(applyOverrides({ harness_tail: ["--verbose", ...argv, "--last"] }, sugar()).harness_tail).toEqual(["--verbose", "--last", ...GENERATED]);
});

test("a set clears an earlier persisted unset of the same key", () => {
  const merged = applyOverrides({ harness_env: {}, harness_unset_env: ["PONYTAIL_DEFAULT_MODE"] }, withSugar(undefined, expandSugar("claude", { ponytail: "full" })));
  expect(merged.harness_env).toEqual({ PONYTAIL_DEFAULT_MODE: "full" });
  expect(merged.harness_unset_env).toEqual([]);
});

test("a crew recipe takes the same replacement and records the sugar's env keys as typed", () => {
  const row = { harness_env: { PONYTAIL_DEFAULT_MODE: "off" }, harness_unset_env: [], harness_env_set: [], harness_tail: ["-c", "model_context_window=1", "--verbose"] };
  expect(crewRecipeWithOverrides(row, withSugar(undefined, expandSugar("codex", { context: 850000, ponytail: "lite" })))).toEqual({
    harness_env: { PONYTAIL_DEFAULT_MODE: "lite" }, harness_unset_env: [], harness_env_set: ["PONYTAIL_DEFAULT_MODE"],
    harness_tail: ["--verbose", "-c", "model_context_window=850000", "-c", "model_auto_compact_token_limit=807500"] });
});
