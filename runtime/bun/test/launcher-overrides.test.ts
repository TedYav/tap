import { parseNew } from "../src/launcher/new";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { launchInvocation, invocationShellCommand } from "../src/launcher/invocation";
import { Notices } from "../src/launcher/catalog-notices";
import type { SessionRecord } from "../src/launcher/types";
import { applyOverrides, launchHelpRequested, splitLaunchPassthrough } from "../src/launcher/overrides";
import { parseOptions } from "../src/launcher/relaunch";
import { TapError } from "../src/context";
import { INHERITED_IDENTITY_ENV } from "../src/session-store";

test("overrides preserve defaults, replace sets, persist unsets and append literal argv", () => {
  const first = applyOverrides({ harness_env: { WINDOW: "old", KEEP: "yes" }, harness_tail: ["-c", "a=1"] }, {
    env: ["WINDOW=600000"], unset_env: ["AMBIENT"], argv: ["-c", "a=2", "space ; $literal"],
  });
  expect(first).toEqual({ harness_env: { WINDOW: "600000", KEEP: "yes" }, harness_unset_env: ["AMBIENT"], harness_tail: ["-c", "a=1", "-c", "a=2", "space ; $literal"] });
  expect(applyOverrides(first, { env: ["AMBIENT=restored"], unset_env: ["WINDOW"] })).toEqual({
    harness_env: { AMBIENT: "restored", KEEP: "yes" }, harness_unset_env: ["WINDOW"], harness_tail: first.harness_tail,
  });
});

test("environment fences and contradictory intent fail before launch", () => {
  for (const key of ["TAP_HANDLE", "HOME", "PATH", "BAD-NAME", "API_KEY"]) {
    expect(() => applyOverrides({}, { unset_env: [key] })).toThrow();
    expect(() => applyOverrides({}, { env: [`${key}=value`] })).toThrow();
  }
  expect(() => applyOverrides({}, { env: ["FOO=x"], unset_env: ["FOO"] })).toThrow();
});

test("launch and relaunch keep the explicit tail opaque", () => {
  const tail = ["-c", "model_context_window=250000", "--env", "literal"];
  expect(splitLaunchPassthrough(["new", "ast-fast", "--unset-env", "WINDOW", "--", ...tail]))
    .toEqual([["new", "ast-fast", "--unset-env", "WINDOW"], tail]);
  expect(parseOptions(["astra-fast", "--env", "WINDOW=600000", "--", ...tail])).toMatchObject({
    seat: "astra-fast", overrides: { env: ["WINDOW=600000"], argv: tail },
  });
});

test("native launch rendering retains persisted tail and actually unsets inherited env", () => {
  const record: SessionRecord = { name: "tap/test", harness: "codex", cwd: process.cwd(), base: "tap", model: "preset-model",
    harness_passthrough: ["-c", "model_context_window=100000"], passthrough_from_config: true,
    ...applyOverrides({}, { env: ["KEEP=yes"], unset_env: ["WINDOW"], argv: ["-c", "model_context_window=250000"] }) };
  const invocation = launchInvocation("new", JSON.parse(JSON.stringify(record)), new Notices());
  expect(invocation.argv.slice(-2)).toEqual(["-c", "model_context_window=250000"]);
  expect(invocation.argv).toContain("model_context_window=100000");
  expect(invocation.unset_env).toEqual(["WINDOW"]);
  const command = invocationShellCommand({ ...invocation, argv: [process.execPath, "-e",
    "if ('WINDOW' in process.env || process.env.KEEP !== 'yes') process.exit(1); console.log('verified');"] });
  const result = spawnSync("/bin/sh", ["-c", command], { env: { ...process.env, WINDOW: "ambient" }, encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("verified");
});

test("durable launch removes a stateless caller or server marker before the harness", () => {
  const command = invocationShellCommand({argv:[process.execPath,"-e","console.log(process.env.TAP_STATELESS ?? 'absent')"],env:{TAP_STATELESS:"1"}}, {...process.env,TAP_LAUNCH_SHELL:"/bin/sh"});
  const child = spawnSync("/bin/sh", ["-c", command], {env:{...process.env,TAP_STATELESS:"1"},encoding:"utf8"});
  expect(child.status,child.stderr).toBe(0);
  expect(child.stdout.trim()).toBe("absent");
});

test("durable launch strips inherited harness identity env, keeps what the invocation configures and the tmux pins (tap-y4jkj)", () => {
  const keys = [...INHERITED_IDENTITY_ENV, "TMUX", "TMUX_PANE", "TAP_INDEX_HOME"];
  const print = `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k => [k, process.env[k] ?? null]))))`;
  const invocation = { argv: [process.execPath, "-e", print], env: { CLAUDE_CODE_SESSION_ID: "configured-id" } };
  const command = invocationShellCommand(invocation, { ...process.env, TAP_LAUNCH_SHELL: "/bin/sh", TAP_INDEX_HOME: "/tmp/index" });
  expect(command).toContain("-u TAP_HARNESS_SESSION_ID");
  expect(command).toContain("-u TAP_SELF");
  expect(command).not.toContain("-u CLAUDE_CODE_SESSION_ID");
  // The tmux server's global env is the decoy carrier: every identity key is foreign, and the pane pins are real.
  const decoy = Object.fromEntries([...INHERITED_IDENTITY_ENV].map(key => [key, `foreign-${key}`]));
  const child = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8",
    env: { ...process.env, ...decoy, TMUX: "/tmp/sock,1,0", TMUX_PANE: "%3", TAP_INDEX_HOME: "/tmp/index" } });
  expect(child.status, child.stderr).toBe(0);
  const seen = JSON.parse(child.stdout) as Record<string, string | null>;
  expect(Object.fromEntries(Object.entries(seen).filter(([, value]) => value !== null))).toEqual({
    CLAUDE_CODE_SESSION_ID: "configured-id", TMUX: "/tmp/sock,1,0", TMUX_PANE: "%3", TAP_INDEX_HOME: "/tmp/index" });
});

test("implicit unknown launch flags warn; an explicit harness delimiter does not", () => {
  const lines: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    expect(splitLaunchPassthrough(["new", "claude", "seat", "--cwd", "/fixture"]))
      .toEqual([["new", "claude", "seat"], ["--cwd", "/fixture"]]);
    expect(lines.join("")).toContain("--cwd is not a TAP launch option");
    expect(lines.join("")).toContain("--workdir <path>");
    lines.length = 0;
    splitLaunchPassthrough(["new", "claude", "seat", "--typo"]);
    expect(lines.join("")).toContain("forwarded to the harness");
    lines.length = 0;
    splitLaunchPassthrough(["new", "claude", "seat", "--", "--cwd", "/fixture"]);
    expect(lines).toEqual([]);
  } finally { process.stderr.write = original; }
});


test("launch help recognizes only TAP-owned flags and keeps explicit harness help", () => {
  expect(launchHelpRequested(["codex", "--help"])).toBe(true);
  expect(launchHelpRequested(["codex", "--workdir", "--help"])).toBe(false);
  expect(launchHelpRequested(["codex", "--", "--help"])).toBe(false);
  expect(splitLaunchPassthrough(["new", "codex", "--", "--help"]))
    .toEqual([["new", "codex"], ["--help"]]);
});


test("a malformed option-looking value cannot turn a later help flag into success", () => {
  for (const value of ["--", "--help", "-h", "--dry-run"]) {
    const args = ["codex", "--model", value, "--help"];
    expect(launchHelpRequested(args)).toBe(false);
    expect(() => parseNew(args, () => {})).toThrow();
  }
  // A negative number is a parser value; validation of its meaning happens later.
  expect(launchHelpRequested(["codex", "--model", "-1", "--help"])).toBe(true);
});

test("--resume is a launcher flag: picker or =id, never forwarded, and the next word stays the seat name", () => {
  expect(parseNew(["claude", "installer", "--resume"])).toMatchObject({ harness: "claude", label: "installer", resume: true, resume_id: null, harness_passthrough: [] });
  expect(parseNew(["claude", "--resume", "installer"])).toMatchObject({ label: "installer", resume: true, resume_id: null, harness_passthrough: [] });
  expect(parseNew(["codex", "seat", "--resume=0199-abc"])).toMatchObject({ resume: false, resume_id: "0199-abc", harness_passthrough: [] });
  expect(splitLaunchPassthrough(["new", "claude", "installer", "--resume", "--", "--verbose"])).toEqual([["new", "claude", "installer", "--resume"], ["--verbose"]]);
  expect(() => parseNew(["claude", "seat", "--resume="], () => {})).toThrow(TapError);
  // An id rides the harness argv as a bare operand (`codex resume <id>`), so an option-looking or
  // malformed value is refused before any effect rather than becoming `codex resume --last`.
  for (const bad of ["--resume=--last", "--resume=-1", "--resume=a b", "--resume=;rm"]) {
    expect(() => parseNew(["codex", "seat", bad], () => {})).toThrow(TapError);
  }
  expect(parseNew(["codex", "seat", "--resume=0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee"])).toMatchObject({ resume_id: "0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
  expect(parseNew(["claude", "seat"])).toMatchObject({ resume: false, resume_id: null });
  // The help probe knows the flag in both forms, so TAP's launch page still answers --help after it.
  expect(launchHelpRequested(["claude", "writer", "--resume", "--help"])).toBe(true);
  expect(launchHelpRequested(["claude", "writer", "--resume=0199-abc", "--help"])).toBe(true);
  expect(launchHelpRequested(["claude", "writer", "--resume", "--", "--help"])).toBe(false);
});

test("launch parser refuses without printing and preserves value and harness ownership", () => {
  const writes: string[] = [], original = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    for (const args of [["codex", "--model"], ["codex", "seat", "extra\n\x1b[31mprivate"], ["codex", "--model", "--help", "--unknown"]]) {
      expect(() => parseNew(args)).toThrow(TapError);
    }
    expect(parseNew(["codex", "--env", "MESSAGE=--help", "--model", "-1"])).toMatchObject({ env: ["MESSAGE=--help"], model: "-1" });
    expect(parseNew(["codex", "seat", "--unknown", "--help", "--json"])).toMatchObject({ harness_passthrough: ["--unknown", "--help", "--json"], json: false });
    expect(parseNew(["codex", "seat", "--", "literal", "--model", "--help"])).toMatchObject({ harness_passthrough: ["literal", "--model", "--help"] });
    expect(writes).toEqual([]);
  } finally { process.stderr.write = original; }
});
