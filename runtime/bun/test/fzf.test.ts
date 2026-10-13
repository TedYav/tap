import { expect, test } from "bun:test";
import { pick, type FzfEffects } from "../src/fzf";
const choices = [{ id: "0", label: "alpha\nESC\x1b", value: "a" }, { id: "1", label: "beta", value: "b" }];
const env = { TERM: "xterm", FZF_DEFAULT_OPTS: "--filter=beta --select-1", FZF_DEFAULT_OPTS_FILE: "/bad", FZF_DEFAULT_COMMAND: "bad", NO_COLOR: "" };
function effects(output: string, code = 0): FzfEffects {
  return { terminal: () => true, binary: () => "/private/fzf", run: async (bin, args, input, childEnv) => {
    expect(bin).toBe("/private/fzf");
    expect(args).toContain("--expect=esc"); expect(args).toContain("--no-select-1"); expect(args).toContain("--no-exit-0");
    expect(args).toContain("--ignore-case");
    expect(args).toContain("--color=bw"); expect(args).toContain("--query=zz");
    expect(input).toBe("0\talpha ESC \0" + "1\tbeta\0");
    expect(childEnv.FZF_DEFAULT_OPTS).toBeUndefined(); expect(childEnv.FZF_DEFAULT_OPTS_FILE).toBeUndefined(); expect(childEnv.FZF_DEFAULT_COMMAND).toBeUndefined();
    return { output, code };
  } };
}
const options = { verb: "attach", query: "zz" };
test("selection validates returned IDs and neutralizes external behavior", async () => {
  expect(await pick(choices, options, effects("\0" + "1\0"), env)).toEqual({ kind: "selected", values: ["b"] });
  expect(await pick(choices, { ...options, multi: true }, effects("\0" + "1\0" + "0\0"), env)).toEqual({ kind: "selected", values: ["b", "a"] });
});
test("Escape discards even selected rows; Ctrl-C remains interrupted", async () => {
  expect(await pick(choices, options, effects("esc\0" + "1\0"), env)).toEqual({ kind: "cancelled" });
  expect(await pick(choices, options, effects("esc\0", 1), env)).toEqual({ kind: "cancelled" });
  expect(await pick(choices, options, effects("", 130), env)).toEqual({ kind: "interrupted" });
});
for (const output of ["", "\0", "\0z\0", "\0" + "0\0" + "0\0", "\0" + "1", "other\0" + "0\0"]) test(`invalid output refuses: ${JSON.stringify(output)}`, async () => {
  await expect(pick(choices, { ...options, multi: true }, effects(output), env)).rejects.toMatchObject({ errorClass: "fzf_invalid_output" });
});
for (const code of [1, 2, 127]) test(`fzf ${code} is a failure, never a selection`, async () => {
  await expect(pick(choices, options, effects("\0" + "0\0", code), env)).rejects.toMatchObject({ errorClass: "fzf_failed" });
});
test("machine modes refuse before executing any child", async () => {
  const fx = effects("\0" + "0\0"); fx.run = async () => { throw new Error("must not run"); };
  for (const mode of [{ TERM: "dumb" }, { TERM: "xterm", TAP_JSON: "1" }]) await expect(pick(choices, options, fx, mode)).rejects.toMatchObject({ errorClass: "no_terminal" });
  fx.terminal = () => false;
  await expect(pick(choices, options, fx, env)).rejects.toMatchObject({ errorClass: "no_terminal" });
});
test("tiebreak is opt-in: equal scores keep the caller's order only when asked", async () => {
  const seen: string[][] = [];
  const fx = effects("\0" + "0\0"); const run = fx.run;
  fx.run = async (bin, args, input, childEnv) => { seen.push(args); return run(bin, args, input, childEnv); };
  await pick(choices, options, fx, env);
  await pick(choices, { ...options, tiebreak: "index" }, fx, env);
  expect(seen[0]!.some(a => a.startsWith("--tiebreak"))).toBe(false);
  expect(seen[1]).toContain("--tiebreak=index");
});
