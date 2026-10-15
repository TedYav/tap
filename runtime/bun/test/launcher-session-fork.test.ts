// `tap session fork`: argv per harness through the production composer,
// refusals before any effect, naming, collision and an untouched source.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forkSeat, parseFork, planFork, type ForkOptions } from "../src/launcher/fork";
import { forkSourceFingerprint } from "../src/harness-families";
import { launchInvocation } from "../src/launcher/invocation";
import { Notices } from "../src/launcher/catalog-notices";
import type { LaunchDeps } from "../src/launcher/new";
import type { LaunchRecord } from "../src/launcher/transaction";
import { LauncherError } from "../src/launcher/types";
import { fixture, restoreEnvironment } from "./support/resume-harness";
import { writeLiveFence } from "./support/live-fence";

afterEach(restoreEnvironment);

const CLAUDE_ID = "11111111-2222-4333-8444-555555555555";
const seat = (handle: string, harness: string, extra: Record<string, unknown> = {}) => ({
  status: "active", harness, delivery: "pane", session: `repo/${handle}`, pane: `repo/${handle}:0.0`, tag: handle, index: 1, ...extra });
const SEATS = {
  fable: seat("fable", "claude", { harness_session_id: CLAUDE_ID, model: "opus", harness_env: { FEATURE: "kept" }, harness_unset_env: ["DROP"],
    harness_tail: ["--literal"], passthrough: ["--verbose"], preset: { name: "fable", source_path: "/cfg", config_digest: "sha256:x" } }),
  cx: seat("cx", "codex", { harness_session_id: "codex-thread-1", model: "gpt-5" }),
  oc: seat("oc", "opencode", { harness_session_id: "ses_source" }),
  ag: seat("ag", "agy", { harness_session_id: "agy-conv" }),
  cu: seat("cu", "cursor", { harness_session_id: "cursor-chat" }),
  noid: seat("noid", "codex"),
  he: seat("he", "hermes", { harness_session_id: "hermes-conv" }),
};

function world(seats: Record<string, unknown> = SEATS, live: string[] = Object.keys(seats).map(h => `repo/${h}`)) {
  const claude = mkdtempSync(join(tmpdir(), "fork-claude-"));
  mkdirSync(join(claude, "projects", "p"), { recursive: true });
  writeFileSync(join(claude, "projects", "p", `${CLAUDE_ID}.jsonl`), "{}\n");
  const f = fixture({ registry: { schema: "0.20", team: { name: "repo" }, seats },
    tmux: [{ match: "*list-sessions*", stdout: live.join("\n") }], env: { TAP_CLAUDE_HOME: claude } });
  // `tap init` creates the bus receipts folder; the Codex fork argv now composes under the auto default, which requires it.
  mkdirSync(join(f.root, ".tap", "bus", "receipts"), { recursive: true });
  return { ...f, registryText: () => readFileSync(join(f.root, ".tap", "bus", "registry.json"), "utf8") };
}

function recorder(tty = false) {
  const runs: LaunchRecord[] = [];
  const deps: LaunchDeps = { run: async record => { runs.push(structuredClone(record)); return 0; },
    hasTty: () => tty, choose: () => "q", scriptDir: "/nonexistent" };
  return { runs, deps };
}

const opts = (source: string, patch: Partial<ForkOptions> = {}): ForkOptions =>
  ({ source, name: null, dryRun: true, json: true, help: false, ...patch });
const argvOf = (record: LaunchRecord) => launchInvocation("fork", structuredClone(record), new Notices(() => {})).argv;

async function refusal(promise: Promise<unknown>): Promise<LauncherError> {
  try { await promise; } catch (error) { if (error instanceof LauncherError) return error; throw error; }
  throw new Error("expected a refusal");
}

test("claude fork resumes the source with --fork-session under a minted id of its own", async () => {
  const f = world(), r = recorder();
  const record = await planFork(opts("fable"), f.root, r.deps);
  expect(record.fork_source_session_id).toBe(CLAUDE_ID);
  expect(record.harness_session_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(record.harness_session_id).not.toBe(CLAUDE_ID);
  const argv = argvOf(record);
  const at = argv.indexOf("--resume");
  expect(argv.slice(at, at + 5)).toEqual(["--resume", CLAUDE_ID, "--fork-session", "--session-id", record.harness_session_id!]);
  expect(argv).toContain("--literal");
  expect(argv[argv.indexOf("--name") + 1]).toBe("repo/fable-fork");
});

test("codex fork runs `codex fork <id>` and leaves the new id to the harness", async () => {
  const f = world(), r = recorder();
  const record = await planFork(opts("cx"), f.root, r.deps);
  expect(record.harness_session_id).toBeNull();
  const argv = argvOf(record);
  expect(argv[0]).toBe("codex");
  expect(argv.indexOf("fork")).toBeGreaterThan(0);
  expect(argv.indexOf("codex-thread-1")).toBeGreaterThan(argv.indexOf("fork"));
  expect(argv).not.toContain("resume");
});

test("opencode fork keeps the source --session through the composer's session pin", async () => {
  const f = world(), r = recorder();
  const record = await planFork(opts("oc"), f.root, r.deps);
  const argv = argvOf(record);
  expect(argv).toContain("--fork");
  expect(argv.filter(token => token === "--session")).toHaveLength(1);
  expect(argv[argv.indexOf("--session") + 1]).toBe("ses_source");
});

test.each([["ag", "agy"], ["cu", "cursor"]])("%s (%s) refuses before any effect and names the in-session /fork", async (handle, harness) => {
  const f = world(), r = recorder();
  const before = f.registryText();
  const error = await refusal(planFork(opts(handle), f.root, r.deps));
  expect(error.errorClass).toBe("fork_unsupported");
  expect(error.action).toContain("/fork");
  expect(error.detail).toContain(harness);
  expect([r.runs, f.registryText()]).toEqual([[], before]);
});

test("a source without a native session id refuses as relaunch does", async () => {
  const f = world(), r = recorder();
  const error = await refusal(planFork(opts("noid"), f.root, r.deps));
  expect(error.errorClass).toBe("no_exact_resume_identity");
  expect(error.action).toContain("tap in");
  expect(r.runs).toEqual([]);
});

test("a claude id without a transcript on disk is not a resumable identity", async () => {
  const f = world({ fable: seat("fable", "claude", { harness_session_id: "99999999-2222-4333-8444-555555555555" }) }), r = recorder();
  expect((await refusal(planFork(opts("fable"), f.root, r.deps))).errorClass).toBe("no_exact_resume_identity");
});

test("unknown seat, foreign team and self-named fork refuse", async () => {
  const f = world(), r = recorder();
  expect((await refusal(planFork(opts("ghost"), f.root, r.deps))).errorClass).toBe("unknown_seat");
  expect((await refusal(planFork(opts("other/fable"), f.root, r.deps))).errorClass).toBe("fork_other_team");
  expect((await refusal(planFork(opts("fable", { name: "fable" }), f.root, r.deps))).errorClass).toBe("fork_target_is_source");
  expect((await refusal(planFork(opts("fable", { name: "bad name" }), f.root, r.deps))).errorClass).toBe("usage_error");
  expect((await refusal(planFork(opts("fable", { name: "help" }), f.root, r.deps))).errorClass).toBe("usage_error");
  expect((await refusal(planFork(opts("fable", { name: "claude" }), f.root, r.deps))).errorClass).toBe("usage_error");
  expect(r.runs).toEqual([]);
});

test("default name is <seat>-fork; an explicit name and team/handle are accepted", async () => {
  const f = world(), r = recorder();
  expect((await planFork(opts("fable"), f.root, r.deps)).tag).toBe("fable-fork");
  const named = await planFork(opts("repo/fable", { name: "fable-spike" }), f.root, r.deps);
  expect([named.tag, named.name]).toEqual(["fable-spike", "repo/fable-spike"]);
});

test("the fork inherits the source's recipe and workdir, not its identity or history", async () => {
  const f = world({ fable: { ...SEATS.fable, launch_workdir: "sub", history: ["older"], registered_from_worktree: "/elsewhere" } }), r = recorder();
  const record = await planFork(opts("fable"), f.root, r.deps);
  expect(record).toMatchObject({ harness: "claude", model: "opus", harness_env: { FEATURE: "kept" }, harness_unset_env: ["DROP"],
    harness_tail: ["--literal"], harness_passthrough: ["--verbose"], launch_workdir: "sub", cwd: "/elsewhere", history: [],
    preset: { name: "fable" }, ensure_action: "fork" });
});

test("a taken fork name refuses without a terminal and reaches launch's chooser with one", async () => {
  const f = world({ ...SEATS, "fable-fork": seat("fable-fork", "claude", { harness_session_id: "other" }) }), r = recorder();
  const before = f.registryText();
  const error = await refusal(forkSeat(opts("fable", { dryRun: false }), f.root, r.deps));
  expect([error.errorClass, error.action]).toEqual(["fork_name_taken", expect.stringContaining("tap session fork fable")]);
  const chooser = recorder(true);
  const asked: string[] = [];
  chooser.deps.choose = ((...args: unknown[]) => { asked.push(String(args[1])); return "q"; }) as LaunchDeps["choose"];
  await expect(forkSeat(opts("fable", { dryRun: false, json: false }), f.root, chooser.deps)).rejects.toMatchObject({ code: 2 });
  expect(asked.join("\n")).toContain("repo/fable-fork");
  expect([r.runs, chooser.runs, f.registryText()]).toEqual([[], [], before]);
});

test("the source is untouched: no registry write and no tmux call names its pane", async () => {
  const f = world(), r = recorder();
  const before = f.registryText();
  expect(await forkSeat(opts("fable", { dryRun: false }), f.root, r.deps)).toBe(0);
  expect(r.runs).toHaveLength(1);
  expect(r.runs[0]!.name).toBe("repo/fable-fork");
  expect(f.registryText()).toBe(before);
  const touching = f.tmuxCalls().filter(call => /send-keys|kill|respawn|repo\/fable(?!-fork)/.test(call));
  expect(touching).toEqual([]);
});

test("parser: help, usage and literal operands", () => {
  expect(parseFork(["--help"]).help).toBe(true);
  expect(parseFork(["--dry-run", "--json", "fable", "spike"])).toMatchObject({ source: "fable", name: "spike", dryRun: true, json: true });
  expect(parseFork(["--", "-odd"]).source).toBe("-odd");
  for (const bad of [[], ["a", "b", "c"], ["--force", "a"]]) expect(() => parseFork(bad)).toThrow(LauncherError);
});

test("--json never reaches the interactive chooser", async () => {
  const f = world({ ...SEATS, "fable-fork": seat("fable-fork", "claude", { harness_session_id: "other" }) }), r = recorder(true);
  r.deps.choose = (() => { throw new Error("prompted under --json"); }) as LaunchDeps["choose"];
  expect((await refusal(forkSeat(opts("fable", { dryRun: false }), f.root, r.deps))).errorClass).toBe("fork_name_taken");
  expect(r.runs).toEqual([]);
});

test("a name that lands on the source's shared session refuses before the chooser", async () => {
  const f = world({ lead: seat("lead", "claude", { harness_session_id: CLAUDE_ID }),
    consult: seat("consult", "claude", { harness_session_id: CLAUDE_ID, crew: true, session: "repo/lead", pane: "repo/lead:0.1" }) }), r = recorder(true);
  r.deps.choose = (() => "k") as LaunchDeps["choose"];
  const before = f.registryText();
  expect((await refusal(forkSeat(opts("consult", { dryRun: false, json: false, name: "lead" }), f.root, r.deps))).errorClass).toBe("fork_target_is_source");
  expect([r.runs, f.registryText()]).toEqual([[], before]);
});

// The launch collision menu's [f] passes the source it checked; planFork forks exactly that one.
test("an expected source from the collision menu must match the source planFork resolves", async () => {
  const f = world(), r = recorder();
  const row = JSON.parse(readFileSync(join(f.root, ".tap", "bus", "registry.json"), "utf8")).seats.fable;
  const matching = await planFork(opts("fable"), f.root, { ...r.deps, expectedSource: forkSourceFingerprint(row, CLAUDE_ID) });
  expect(matching.fork_source_session_id).toBe(CLAUDE_ID);
  const stale = forkSourceFingerprint({ ...row, harness_session_id: "an-earlier-id" }, "an-earlier-id");
  const error = await refusal(planFork(opts("fable"), f.root, { ...r.deps, expectedSource: stale }));
  expect(error.errorClass).toBe("fork_source_changed");
  expect(r.runs).toEqual([]);
});

test("a source changed while the fork was being prepared refuses before launch", async () => {
  const f = world(), r = recorder(true);
  r.deps.choose = (() => { throw new Error("no chooser expected"); }) as LaunchDeps["choose"];
  const path = join(f.root, ".tap", "bus", "registry.json");
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const planning = planFork(opts("fable", { dryRun: false, json: false }), f.root, {
    ...r.deps, hasTty: () => { doc.seats.fable.harness_session_id = "replaced"; writeFileSync(path, JSON.stringify(doc)); return true; } });
  expect((await refusal(planning)).errorClass).toBe("fork_source_changed");
});

test("a [k] replacement keeps the displaced seat's history while the source's stays behind", async () => {
  const f = world({ ...SEATS, fable: { ...SEATS.fable, history: ["source-older"] },
    "fable-fork": seat("fable-fork", "claude", { harness_session_id: "displaced", history: ["displaced-older"] }) }, ["repo/fable"]), r = recorder(true);
  r.deps.choose = (() => "k") as LaunchDeps["choose"];
  const record = await planFork(opts("fable", { dryRun: false, json: false }), f.root, r.deps);
  expect(record.history).toEqual(["displaced-older", "displaced"]);
  expect(record.replaces_session).toBe("repo/fable-fork");
});

test("a missing harness CLI refuses before any tmux probe; a dry run skips the check", async () => {
  const f = world(), r = recorder();
  const missing = (harness: string) => { throw new LauncherError(`missing ${harness}`, "missing_prerequisite", "install it", `${harness} was not found on PATH`); };
  const error = await refusal(planFork(opts("cx", { dryRun: false }), f.root, { ...r.deps, requireCommands: missing }));
  expect([error.errorClass, error.detail]).toEqual(["missing_prerequisite", "codex was not found on PATH"]);
  expect([f.tmuxCalls(), r.runs]).toEqual([[], []]);
  expect((await planFork(opts("cx"), f.root, { ...r.deps, requireCommands: missing })).harness).toBe("codex");
});

test("help names every refusal class the door raises", async () => {
  const { FORK_HELP } = await import("../src/help");
  for (const section of ["NAME", "USAGE", "DESCRIPTION", "OPTIONS", "EXAMPLES", "EXIT CODES", "SEE ALSO", "-h, --help"]) expect(FORK_HELP).toContain(section);
  const source = readFileSync(join(import.meta.dir, "../src/launcher/fork.ts"), "utf8");
  // Every class the door raises directly: the second LauncherError argument.
  const raised = [...source.matchAll(/new LauncherError\([^;]*?,\s*"([a-z_]+)"/g)].map(match => match[1]!);
  expect(raised.length).toBeGreaterThanOrEqual(8);
  for (const cls of raised) expect(FORK_HELP).toContain(cls);
});

test("a fork named after the source's renamed live session refuses before [k] can stop it", async () => {
  const claude = mkdtempSync(join(tmpdir(), "fork-claude-"));
  mkdirSync(join(claude, "projects", "p"), { recursive: true });
  writeFileSync(join(claude, "projects", "p", `${CLAUDE_ID}.jsonl`), "{}\n");
  const f = fixture({ registry: { schema: "0.20", team: { name: "repo" }, seats: {
    fable: seat("fable", "claude", { harness_session_id: CLAUDE_ID, pane_id: "%9", server_epoch: "srv:1:1" }) } },
    tmux: [{ match: "*display-message*-t %9*", stdout: "repo/renamed:0.0\t%9\tclaude\t1:1\t0\t42\t/x\n" },
      { match: "*list-sessions*", stdout: "repo/renamed" }], env: { TAP_CLAUDE_HOME: claude } });
  const r = recorder(true);
  r.deps.choose = (() => "k") as LaunchDeps["choose"];
  expect((await refusal(planFork(opts("fable", { dryRun: false, json: false, name: "renamed" }), f.root, r.deps))).errorClass).toBe("fork_target_is_source");
  expect(r.runs).toEqual([]);
});

test("hermes has no exact native resume, so fork refuses it before any effect", async () => {
  const f = world(), r = recorder();
  const before = f.registryText();
  const error = await refusal(planFork(opts("he"), f.root, r.deps));
  expect([error.errorClass, error.detail]).toEqual(["fork_unsupported", expect.stringContaining("hermes")]);
  expect([r.runs, f.registryText()]).toEqual([[], before]);
});

test("--json reports a tmux command failure as one structured object", async () => {
  const f = world();
  const { cmdSessionFork } = await import("../src/launcher/fork");
  const { LaunchCommandError } = await import("../src/launcher/process");
  const cwd = process.cwd(), written: string[] = [];
  const write = process.stdout.write;
  process.chdir(f.root);
  process.stdout.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
  let code: number;
  try {
    code = await cmdSessionFork(["cx", "--json"], "/nonexistent", { requireCommands: () => {}, hasTty: () => false,
      run: async () => { throw new LaunchCommandError(["tmux", "new-session"], { code: 1, stdout: "", stderr: "boom" } as never); } });
  } finally { process.stdout.write = write; process.chdir(cwd); delete process.env.TAP_JSON; }
  expect(code).toBe(1);
  const lines = written.join("").trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false, error_class: "launch_command_failed" });
});

test("a reset fence refuses the fork under its own name", async () => {
  const f = world(), r = recorder();
  writeLiveFence(join(f.root, ".tap/bus/reset.fence.json"));
  await expect(planFork(opts("fable"), f.root, r.deps)).rejects.toThrow("session fork");
  expect([r.runs, f.tmuxCalls()]).toEqual([[], []]);
});

test("a source renamed while the chooser is open is re-verified before [k]", async () => {
  const claude = mkdtempSync(join(tmpdir(), "fork-claude-"));
  mkdirSync(join(claude, "projects", "p"), { recursive: true });
  writeFileSync(join(claude, "projects", "p", `${CLAUDE_ID}.jsonl`), "{}\n");
  const flag = join(mkdtempSync(join(tmpdir(), "fork-flag-")), "renamed");
  const f = fixture({ registry: { schema: "0.20", team: { name: "repo" }, seats: {
    fable: seat("fable", "claude", { harness_session_id: CLAUDE_ID, pane_id: "%9", server_epoch: "srv:1:1" }) } },
    tmux: [{ match: "*display-message*-t %9*", run: `[ -f '${flag}' ] && { printf 'repo/spike:0.0\\t%%9\\tclaude\\t1:1\\t0\\t42\\t/x\\n'; exit 0; }`,
      stdout: "repo/fable:0.0\t%9\tclaude\t1:1\t0\t42\t/x\n" },
      { match: "*list-sessions*", stdout: "repo/fable\nrepo/spike" }], env: { TAP_CLAUDE_HOME: claude } });
  const r = recorder(true);
  r.deps.choose = (() => { writeFileSync(flag, ""); return "k"; }) as LaunchDeps["choose"];
  expect((await refusal(planFork(opts("fable", { dryRun: false, json: false, name: "spike" }), f.root, r.deps))).errorClass).toBe("fork_target_is_source");
  expect(r.runs).toEqual([]);
});

test("a stored equals-form selector is named by its option alone, never its value", async () => {
  const f = world({ fable: { ...SEATS.fable, passthrough: ["--resume=\x1b[2Jold-id"] } }), r = recorder();
  const error = await refusal(planFork(opts("fable"), f.root, r.deps));
  expect(error.errorClass).toBe("fork_recipe_conflict");
  expect(error.message).toBe("stored --resume conflicts with the fork");
  expect(JSON.stringify(error)).not.toContain("old-id");
  expect(r.runs).toEqual([]);
});

test("a claude source storing a session-selection flag refuses fork_recipe_conflict", async () => {
  const f = world({ fable: { ...SEATS.fable, harness_tail: ["--session-id", "pinned"] } }), r = recorder();
  expect((await refusal(planFork(opts("fable"), f.root, r.deps))).errorClass).toBe("fork_recipe_conflict");
  expect(r.runs).toEqual([]);
});
