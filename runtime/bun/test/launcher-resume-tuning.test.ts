import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildHarnessInvocation } from "../src/launcher/adapters";
import { Notices } from "../src/launcher/catalog-notices";
import { buildInvocation, composeInvocation, launchInvocation, resumeTuning } from "../src/launcher/invocation";
import { NATIVE_RESUME_RESTORES, observedResumeEffort, stripTuningAxes } from "../src/launcher/resume-tuning";
import type { SessionRecord } from "../src/launcher/types";

// tap-j5k1b: a resume leaves the axes a harness restores natively to the harness, keeps
// replaying the ones it does not, passes Claude's last observed effort, and re-passes the
// seat's stored env over any ambient value.

const work = mkdtempSync(join(tmpdir(), "resume-tuning-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

let n = 0;
/** A sandboxed machine: empty Claude store, config with exactly `body`. */
function machine(body = "version=3\n"): NodeJS.ProcessEnv {
  const dir = join(work, String(n++));
  mkdirSync(join(dir, "tap"), { recursive: true });
  mkdirSync(join(dir, "claude", "projects"), { recursive: true });
  const file = join(dir, "tap", "config.toml");
  writeFileSync(file, body);
  chmodSync(file, 0o600);
  return { HOME: "/nonexistent", XDG_CONFIG_HOME: dir, TAP_CLAUDE_HOME: join(dir, "claude") };
}

/** A Claude transcript whose newest assistant turn ran at `effort`. */
function claudeTranscript(env: NodeJS.ProcessEnv, id: string, effort: string): string {
  const dir = join(env.TAP_CLAUDE_HOME!, "projects", "-wt");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  const turn = (at: string, value: string) => JSON.stringify({ type: "assistant", sessionId: id, timestamp: at, effort: value,
    message: { model: "claude-sonnet-5-5", usage: { input_tokens: 10 } } });
  writeFileSync(path, `${turn("2026-10-06T10:00:00Z", "high")}\n${turn("2026-10-06T10:05:00Z", effort)}\n`);
  return path;
}

const ID = "0f6b1c2e-1111-4222-8333-944455556666";
const seat = (harness: string, extra: Partial<SessionRecord> = {}): SessionRecord =>
  ({ name: "team-seat", harness, cwd: "/wt", base: "team", model: "launch-model", harness_session_id: ID, ...extra });
const resume = (record: SessionRecord, env: NodeJS.ProcessEnv, typedTail?: number) =>
  launchInvocation("resume", record, new Notices(() => {}), { env, resume: ID, receipts: () => {}, typedTail });
const flagValue = (argv: string[], flag: string): string[] =>
  argv.flatMap((token, i) => token === flag ? [argv[i + 1]!] : token.startsWith(`${flag}=`) ? [token.slice(flag.length + 1)] : []);

test("the restore table covers every adapter harness", () => {
  expect(Object.keys(NATIVE_RESUME_RESTORES).sort()).toEqual(["agy", "claude", "codex", "cursor", "hermes", "opencode"]);
});

test("stripping removes every spelling of an axis and nothing else", () => {
  expect(stripTuningAxes("claude", ["--model", "a", "--model=b", "-m", "c", "--name", "x", "--effort", "high", "--", "--model", "tail"], ["model"]))
    .toEqual(["--name", "x", "--effort", "high", "--", "--model", "tail"]);
  expect(stripTuningAxes("claude", ["--effort=max", "--verbose"], ["effort"])).toEqual(["--verbose"]);
  expect(stripTuningAxes("codex", ["-c", 'model="m"', '--config=model_reasoning_effort="high"', "-c", 'service_tier="fast"', "-m", "m2", "--search"], ["model", "effort"]))
    .toEqual(["-c", 'service_tier="fast"', "--search"]);
  // Attached short values, as Clap accepts them; an unrelated attached config stays.
  expect(stripTuningAxes("codex", ["-cmodel_reasoning_effort=high", '-c=model="m"', "-mgpt-x", "-cservice_tier=fast", "--", "-mkeep"], ["model", "effort"]))
    .toEqual(["-cservice_tier=fast", "--", "-mkeep"]);
  expect(stripTuningAxes("claude", ["-mopus", "--verbose"], ["model"])).toEqual(["--verbose"]);
  // A flag-shaped successor is not the axis's value.
  expect(stripTuningAxes("claude", ["--model", "--verbose"], ["model"])).toEqual(["--verbose"]);
});

test("resume omits the launch model only where the harness restores it", () => {
  const env = machine();
  for (const harness of ["claude", "codex", "opencode"]) {
    const argv = buildHarnessInvocation("resume", seat(harness), null, ID, env, "bypass", () => {}).argv;
    expect(argv.join(" "), harness).not.toContain("launch-model");
  }
  for (const harness of ["cursor", "agy"]) {
    const argv = buildHarnessInvocation("resume", seat(harness), null, ID, env, "bypass", () => {}).argv;
    expect(flagValue(argv, "--model"), harness).toEqual(["launch-model"]);
  }
  // New launches and forks keep applying the launch tuning.
  expect(flagValue(buildHarnessInvocation("new", seat("claude"), null, null, env, "bypass", () => {}).argv, "--model")).toEqual(["launch-model"]);
  expect(flagValue(buildHarnessInvocation("fork", seat("claude", { fork_source_session_id: ID }), null, null, env, "bypass", () => {}).argv, "--model"))
    .toEqual(["launch-model"]);
});

// `tap launch --resume` reopens a conversation under action "new" (the picker's pick or an exact id): the
// restore rule applies to it as to a resume, so a preset's model or a tail's effort never overrides the
// conversation's own, while the same fresh launch (no marker) keeps carrying the launch tuning.
test("a picker or exact launch composes its tuning as a resume does", () => {
  const env = machine('version=3\n[harness.codex]\nparams.config = [\'model_reasoning_effort="xhigh"\']\n');
  const launch = (record: SessionRecord) => launchInvocation("new", record, new Notices(() => {}), { env, receipts: () => {} }).argv;
  const picker = launch(seat("claude", { harness_session_id: null, launch_resume: "picker", harness_tail: ["--model", "tail-model"] }));
  expect(picker.join(" ")).not.toMatch(/launch-model|tail-model/);
  expect(picker).toContain("--resume"); expect(picker).not.toContain("--session-id");
  const exact = launch(seat("claude", { launch_resume: "exact", harness_tail: ["--model", "tail-model"] }));
  expect(exact.join(" ")).not.toMatch(/launch-model|tail-model/);
  expect(exact.slice(exact.indexOf("--resume"), exact.indexOf("--resume") + 2)).toEqual(["--resume", ID]);
  const codexSources: Partial<SessionRecord> = { harness_passthrough: ["-c", 'model="pass-model"', "-c", 'service_tier="fast"'], harness_tail: ["--model", "tail-model"] };
  const codexPicker = launch(seat("codex", { harness_session_id: null, launch_resume: "picker", ...codexSources }));
  expect(codexPicker.join(" ")).not.toMatch(/model_reasoning_effort|pass-model|tail-model|launch-model/);
  expect(codexPicker).toContain('service_tier="fast"'); expect(codexPicker).toContain("resume");
  const codexExact = launch(seat("codex", { launch_resume: "exact", launch_workdir: "/wt", ...codexSources }));
  expect(codexExact.join(" ")).not.toMatch(/model_reasoning_effort|pass-model|tail-model|launch-model/);
  expect(codexExact.slice(-3)).toEqual(["--cd", "/wt", ID]);
  // The unmarked fresh launch still carries every source.
  const fresh = launch(seat("codex", { harness_session_id: null, ...codexSources })).join(" ");
  for (const source of ['model_reasoning_effort="xhigh"', "pass-model", "tail-model", "launch-model"]) expect(fresh).toContain(source);
  expect(flagValue(launch(seat("claude", { harness_session_id: null })), "--model")).toEqual(["launch-model"]);
});

test("codex resume drops stored model and effort from passthrough, policy and tail, keeping other config", () => {
  const env = machine('version=3\n[harness.codex]\nparams.config = [\'model_reasoning_effort="xhigh"\']\n');
  const record = seat("codex", { harness_passthrough: ["-c", 'model="pass-model"', "-c", 'service_tier="fast"'], harness_tail: ["--model", "tail-model"] });
  // The same sources do reach a new launch, so the resume arm below is not vacuous.
  const fresh = launchInvocation("new", { ...record, harness_session_id: null }, new Notices(() => {}), { env, receipts: () => {} }).argv.join(" ");
  for (const source of ['model_reasoning_effort="xhigh"', "pass-model", "tail-model", "launch-model"]) expect(fresh).toContain(source);
  const argv = resume(record, env).argv;
  expect(argv.join(" ")).not.toMatch(/model_reasoning_effort|pass-model|tail-model|launch-model/);
  expect(argv).toContain('service_tier="fast"');
  // launch_tuning keeps what TAP launched with for an axis the resume left to the harness.
  const launched = seat("codex", { launch_tuning: { model: "launch-model", effort: "high", qualifiers: {}, environment: {} } });
  resume(launched, env);
  expect(launched.launch_tuning).toMatchObject({ model: "launch-model", effort: "high" });
});

test("codex resume drops attached stored tuning but keeps the same spelling typed on this invocation", () => {
  const env = machine();
  const record = seat("codex", { harness_tail: ["-cmodel_reasoning_effort=high", "-mstored-model", "-cservice_tier=fast", "-cmodel_reasoning_effort=xhigh"] });
  const argv = resume(record, env, 1).argv;
  expect(argv).not.toContain("-cmodel_reasoning_effort=high");
  expect(argv).not.toContain("-mstored-model");
  expect(argv).toContain("-cservice_tier=fast");
  expect(argv).toContain("-cmodel_reasoning_effort=xhigh");
});

test("cursor and agy keep replaying the stored launch tuning (no native restore, nothing observable)", () => {
  const env = machine();
  expect(flagValue(resume(seat("cursor"), env).argv, "--model")).toEqual(["launch-model"]);
  const agy = resume(seat("agy", { harness_passthrough: ["--effort", "low"] }), env).argv;
  expect(flagValue(agy, "--model")).toEqual(["launch-model"]);
  expect(flagValue(agy, "--effort")).toEqual(["low"]);
});

test("claude resume passes the last observed effort over the recorded one", () => {
  const env = machine();
  claudeTranscript(env, ID, "low");
  const argv = resume(seat("claude", { harness_passthrough: ["--effort", "high"] }), env).argv;
  expect(flagValue(argv, "--effort")).toEqual(["low"]);
  expect(flagValue(argv, "--model")).toEqual([]);
});

test("claude resume with no observation replays the recorded effort", () => {
  const env = machine();
  expect(observedResumeEffort(seat("claude"), ID, env)).toBeNull();
  expect(flagValue(resume(seat("claude", { harness_passthrough: ["--effort", "high"] }), env).argv, "--effort")).toEqual(["high"]);
});

test("tuning typed on this invocation beats the observation and is never stripped", () => {
  const env = machine();
  claudeTranscript(env, ID, "low");
  // A relaunch's `-- --model x --effort max`, appended to the stored tail this invocation.
  const record = seat("claude", { harness_tail: ["--model", "old-tail", "--model", "typed-model", "--effort", "max"] });
  const argv = resume(record, env, 4).argv;
  expect(flagValue(argv, "--effort")).toEqual(["max"]);
  expect(flagValue(argv, "--model")).toEqual(["typed-model"]);
});

test("documented edge: a typed relaunch effort with no later turn loses to the older observation", () => {
  // The relaunch persisted `--effort max` in the tail, the seat died before its first turn, and the
  // transcript's newest turn still says low. A plain resume follows the observation.
  const env = machine();
  claudeTranscript(env, ID, "low");
  expect(flagValue(resume(seat("claude", { harness_tail: ["--effort", "max"] }), env).argv, "--effort")).toEqual(["low"]);
});

test("resume re-passes the seat's stored env over a conflicting ambient value, unsets included", () => {
  const env = { ...machine(), PONYTAIL_MODE: "ambient", DROPPED: "ambient", BLANK: "ambient" };
  const record = seat("claude", { harness_env: { PONYTAIL_MODE: "seat", BLANK: "" }, harness_unset_env: ["DROPPED"] });
  const built = resume(record, env);
  expect(built.env.PONYTAIL_MODE).toBe("seat");
  expect(built.env.BLANK).toBe("");
  expect(built.env.DROPPED).toBeUndefined();
  expect(built.unset_env).toContain("DROPPED");
});

test("an id-less claude or codex resume opens the native picker, so restored axes stay with the pick", () => {
  const env = machine('version=3\n[harness.codex]\nparams.model = "policy-model"\n');
  const claude = launchInvocation("resume", seat("claude", { harness_session_id: null, harness_tail: ["--model", "tail-model"] }),
    new Notices(() => {}), { env, resume: null, receipts: () => {} }).argv;
  expect(claude).toContain("--resume");
  expect(flagValue(claude, "--model")).toEqual([]);
  const codex = launchInvocation("resume", seat("codex", { harness_session_id: null, harness_passthrough: ["-c", 'model_reasoning_effort="high"'] }),
    new Notices(() => {}), { env, resume: null, receipts: () => {} }).argv;
  expect(codex.join(" ")).not.toMatch(/launch-model|policy-model|model_reasoning_effort/);
  // Bare-harness adoption (nativeQuery null) through the two-step bridge composition.
  const adopted = seat("codex", { harness_session_id: null });
  const notices = new Notices(() => {});
  const bridged = composeInvocation(buildInvocation("resume", adopted, notices, env, null, null, null), adopted, notices, env, true,
    resumeTuning(adopted, null, env)).argv;
  expect(bridged.join(" ")).not.toMatch(/launch-model|policy-model/);
});

test("a legacy row's fallback follows composition precedence, not last-wins concatenation", () => {
  const env = machine('version=3\n[harness.codex]\nparams.model = "policy-model"\n');
  // A new launch floors the lower-priority machine model under the recorded one.
  expect(flagValue(launchInvocation("new", seat("codex", { harness_session_id: null }), new Notices(() => {}), { env, receipts: () => {} }).argv, "--model"))
    .toEqual(["launch-model"]);
  const record = seat("codex");
  resume(record, env);
  expect(record.launch_tuning?.model).toBe("launch-model");
  // An explicit stored tail still outranks the recorded model, as it does at launch.
  const tailed = seat("codex", { harness_tail: ["--model", "tail-model"] });
  resume(tailed, env);
  expect(tailed.launch_tuning?.model).toBe("tail-model");
});

test("an id-less resume starts fresh, so it keeps the launch model", () => {
  const env = machine();
  const record = seat("opencode", { harness_session_id: null });
  const argv = launchInvocation("resume", record, new Notices(() => {}), { env, resume: null, receipts: () => {} }).argv;
  expect(flagValue(argv, "--model")).toEqual([]);
  expect(record.launch_tuning?.model).toBe("launch-model");
  expect(resumeTuning(record, null, env)).toBeUndefined();
});

test("a row from before launch_tuning keeps its launched model and effort after a resume", () => {
  const env = machine();
  const record = seat("codex", { harness_passthrough: ["-c", 'model_reasoning_effort="high"'] });
  expect(record.launch_tuning).toBeUndefined();
  resume(record, env);
  expect(record.launch_tuning).toMatchObject({ model: "launch-model", effort: "high" });
});

test("a moved transcript_path falls back to the project store for the observation", () => {
  const env = machine();
  claudeTranscript(env, ID, "low");
  const record = seat("claude", { transcript_path: `/nonexistent/projects/-wt/${ID}.jsonl` });
  expect(observedResumeEffort(record, ID, env)).toBe("low");
  // The legacy compose bridge derives the same observation.
  expect(resumeTuning(record, ID, env)?.observedEffort).toBe("low");
});

test("OpenCode native resume refuses typed tuning rather than silently discarding it",()=>{
  const record=seat("opencode",{harness_tail:["--variant","high"]});
  expect(()=>resume(record,machine(),2)).toThrow("OpenCode 2 resumes its native model and variant");
});
