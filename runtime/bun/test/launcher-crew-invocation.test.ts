import { afterAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeScratchTree } from "./support/scratch";
import { enrollScratchRoot } from "./support/enroll-scratch";
import { INHERITED_IDENTITY_ENV } from "../src/session-store";
import { crewRecipeInvocation, crewRecipeWithOverrides } from "../src/launcher/crew-invocation";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

const root = realpathSync(mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "crew-inv.")));
const door = resolve(import.meta.dir, "../src/launcher/crew-invocation.ts");
afterAll(() => removeScratchTree(root));
let sequence = 0;
function fixture(config = "version = 3\n") {
  const cwd = join(root, String(sequence++));
  mkdirSync(join(cwd, "config/tap"), { recursive: true });
  const configFile = join(cwd, "config/tap/config.toml");
  writeFileSync(configFile, config, { mode: 0o600 });
  return { cwd, configFile, env: { ...process.env, XDG_CONFIG_HOME: join(cwd, "config"),
    TAP_LAUNCH_SHELL: "/bin/sh", TAP_JSON: "1", TAP_VERBOSE: "0" } };
}
type Fixture = ReturnType<typeof fixture>;
const resumeId = "11111111-2222-4333-8444-555555555555";
function nativeConversation(f: Fixture, harness: string, cwd = f.cwd): string {
  const base = join(f.cwd, "native");
  Object.assign(f.env, { CLAUDE_CONFIG_DIR: join(base, "claude"), CODEX_HOME: join(base, "codex"),
    CURSOR_HOME: join(base, "cursor"), GEMINI_HOME: join(base, "gemini"), HERMES_HOME: join(base, "hermes"), XDG_DATA_HOME: base });
  const file = (path: string, contents = "") => { mkdirSync(resolve(path, ".."), { recursive: true }); writeFileSync(path, contents); return path; };
  if (harness === "claude") file(join(base, "claude/projects/fixture", `${resumeId}.jsonl`), JSON.stringify({ type: "user", sessionId: resumeId, cwd }) + "\n");
  if (harness === "codex") file(join(base, "codex/sessions/2026/10/28", `rollout-now-${resumeId}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id: resumeId, cwd, source: "exec" } }) + "\n");
  if (harness === "cursor") file(join(base, "cursor/chats", createHash("md5").update(cwd).digest("hex"), resumeId, "store.db"));
  if (harness === "agy") file(join(base, "gemini/antigravity-cli/conversations", `${resumeId}.db`));
  if (harness === "opencode" || harness === "hermes") {
    const db = new Database(file(join(base, harness, harness === "opencode" ? "opencode.db" : "state.db")));
    if (harness === "opencode") { db.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT)"); db.query("INSERT INTO session_v2 VALUES (?, ?)").run("ses_adopt", cwd); }
    else { db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY)"); db.query("INSERT INTO sessions VALUES (?)").run(resumeId); }
    db.close();
  }
  return harness === "opencode" ? "ses_adopt" : resumeId;
}
function run(f: Fixture, harness = "codex", flags: string[] = ["--model", "model-x"]) {
  return spawnSync("bun", [door, harness, "team/crew", "--cwd", f.cwd, ...flags], {
    cwd: f.cwd, env: f.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000,
  });
}
function success(f: Fixture, harness?: string, flags?: string[]): string {
  const r = run(f, harness, flags);
  expect([r.status, r.stderr]).toEqual([0, ""]);
  return r.stdout.trim();
}
function refusal(f: Fixture, flags: string[], errorClass: string, harness = "codex") {
  const r = run(f, harness, flags);
  expect([r.status, r.stderr]).toEqual([2, ""]);
  const error = JSON.parse(r.stdout);
  expect(error.error_class).toBe(errorClass);
  expect(typeof error.action).toBe("string");
  return error;
}

test.each(["claude", "codex", "opencode", "cursor", "agy", "hermes"])("%s crew adopts only the explicit existing native conversation", harness => {
  const f = fixture(), id = nativeConversation(f, harness);
  const command = success(f, harness, ["--model", "model-x", "--resume", id]);
  const selector = harness === "codex" ? `resume ${id}` : harness === "opencode" ? `--session ${id}` : harness === "agy" ? `--conversation ${id}` : `--resume ${id}`;
  expect(command).toContain(selector);
  expect(command).not.toContain("--continue");
  expect(command).not.toContain("--session-id");
  if (["claude", "codex", "opencode"].includes(harness)) expect(command).not.toContain("--model model-x");
  refusal(f, ["--model", "model-x", "--resume", "missing-native-id"], "no_exact_resume_identity", harness);
});

test.each(["claude", "cursor", "opencode"])("%s adoption refuses a native conversation from a different cwd", harness => {
  const f = fixture(), other = join(f.cwd, "other"); mkdirSync(other);
  const id = nativeConversation(f, harness, other);
  refusal(f, ["--model", "model-x", "--resume", id], "no_exact_resume_identity", harness);
});

test("adoption checks the preset's effective native store before any row write", () => {
  const f = fixture(preset("claude", 'env.CLAUDE_CONFIG_DIR="/does-not-exist/crew-test-store"\n'));
  nativeConversation(f, "claude");
  const r = registry(f), before = readFileSync(r.path, "utf8");
  refusal(f, [...r.args, "--resume", resumeId], "no_exact_resume_identity", "claude");
  expect(readFileSync(r.path, "utf8")).toBe(before);
});

test("adoption writes the exact expectation before launch while fresh recipe replay remains fresh", async () => {
  const f = fixture(preset("claude")), id = nativeConversation(f, "claude"), r = registry(f);
  const command = success(f, "claude", [...r.args, "--resume", id]);
  expect(command).toContain(`--resume ${id}`);
  const saved = JSON.parse(readFileSync(r.path, "utf8")).seats.crew;
  expect(saved.instance).toBe(r.row.instance);
  expect(saved.harness_session_id).toBe(id);
  expect(saved.identity_capture).toEqual({ mode: "exact_resume", expected_harness_session_id: id });
  const fresh = await crewRecipeInvocation("team", "crew", saved, f.env);
  expect(fresh.command).not.toContain(id); expect(fresh.command).not.toContain("--resume");
});

test.each(["", "--latest", "bad id", "../other"])("invalid crew adoption id %j refuses before recipe write", id => {
  const f = fixture(preset("claude")), r = registry(f), before = readFileSync(r.path, "utf8");
  refusal(f, [...r.args, `--resume=${id}`], "launch_arg_invalid", "claude");
  expect(readFileSync(r.path, "utf8")).toBe(before);
});

test("adoption refuses a native identity held in another enrolled team", () => {
  const f = fixture(preset("claude")), id = nativeConversation(f, "claude"), r = registry(f);
  const index = join(f.cwd, "index"), other = join(f.cwd, "other");
  mkdirSync(index); mkdirSync(other);
  const foreign = join(other, "registry.json");
  writeFileSync(foreign, JSON.stringify({ schema: "0.20", team: { name: "other", worktree_root: other }, seats: {
    held: { harness: "claude", harness_session_id: id, instance: "foreign", status: "active" },
  } }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    team: { root: f.cwd, registry_location: r.path, state: "registered" },
    other: { root: other, registry_location: foreign, state: "registered" },
  } }));
  Object.assign(f.env, { TAP_INDEX_HOME: index });
  const before = readFileSync(r.path, "utf8");
  refusal(f, [...r.args, "--resume", id], "duplicate_identity_owner", "claude");
  expect(readFileSync(r.path, "utf8")).toBe(before);
  writeFileSync(foreign, JSON.stringify({ agents: { held: { harness: "claude", harness_session_id: id } } }));
  const oldStore = run(f, "claude", [...r.args, "--resume", id]);
  expect(oldStore.status).toBe(1);
  expect(JSON.parse(oldStore.stdout)).toMatchObject({ error_class: "old_store" });
  expect(readFileSync(r.path, "utf8")).toBe(before);
});

test.each(["claude", "opencode", "cursor", "agy", "hermes"])("%s exact adoption refuses a second selector in preset or tail", harness => {
  const key = harness === "opencode" ? "session" : harness === "agy" ? "conversation" : "resume";
  const f = fixture(preset(harness, `params.${key}="other-id"\n`)), id = nativeConversation(f, harness);
  refusal(f, ["--preset", "chosen", "--resume", id], "launch_arg_invalid", harness);
  const g = fixture(), otherId = nativeConversation(g, harness);
  refusal(g, ["--model", "model-x", "--resume", otherId, `--harness-arg=--${key}=other-id`], "launch_arg_invalid", harness);
});

for (const harness of ["claude", "codex", "opencode", "cursor", "agy", "hermes"]) {
  test(`${harness}: fresh explicit model, no borrowed conversation`, () => {
    const f = fixture();
    Object.assign(f.env, { TAP_HARNESS_SESSION_ID: "parent-id", CODEX_THREAD_ID: "parent-id", CLAUDE_CODE_SESSION_ID: "parent-id" });
    const command = success(f, harness);
    if (harness === "opencode") expect(command).not.toContain("--model");
    else expect(command).toContain("--model model-x");
    for (const forbidden of ["parent-id", "--resume", "--session", "--conversation", "--continue"]) expect(command).not.toContain(forbidden);
    expect(command.startsWith("/bin/sh -lic ")).toBe(true);
    if (harness === "claude") expect(command).toContain("--name team/crew");
    if (harness === "cursor") {
      expect(command).toContain(`--workspace ${f.cwd}`);
      expect(command).toContain("--trust");
    }
  });
}

test.each(["0", "1"])("missing receipt preview follows crew notice suppression (TAP_JSON=%s)", json => {
  const f = fixture();
  const index = join(f.cwd, "index");
  enrollScratchRoot(f.cwd, index);
  Object.assign(f.env, { TAP_INDEX_HOME: index, TAP_JSON: json });
  const r = run(f);
  expect(r.status).toBe(0);
  expect(existsSync(join(f.cwd, ".tap/bus/receipts"))).toBe(false);
  if (json === "1") expect(r.stderr).toBe("");
  else expect(r.stderr.match(/will be created/g)).toHaveLength(1);
});

test("model/env validation preserves suppliedness, ordering and flag-specific actions", () => {
  const f = fixture();
  expect(refusal(f, [], "launch_arg_invalid").detail).toContain("explicit validated launch model");
  for (const model of ["", "  ", "bad\nvalue"]) refusal(f, ["--model", model], "launch_arg_invalid");
  expect(refusal(f, ["--env", "TAP_HOME=/x"], "launch_env_forbidden").action).toBe("remove --env TAP_HOME=... from the command");
  expect(refusal(f, ["--model", "", "--env", "TAP_HOME=/x"], "launch_arg_invalid").detail).toContain("--model");
  expect(refusal(f, ["--model", "", "--env", "broken"], "launch_arg_invalid").detail).toContain("missing '='");
  refusal(f, ["--model", "ok", "--env", "BAD-KEY=x"], "launch_arg_invalid");
  expect(success(f, "codex", ["--model", "ok", "--env", "GOOD=a=b=c"])).toContain("GOOD=a=b=c");
});

const preset = (harness: string, extra = "") => `version = 3\n[presets.chosen]\nharness = "${harness}"\nparams.model = "model-x"\n${extra}`;
test("preset digest, exclusivity and harness are checked before rendering", () => {
  const f = fixture(preset("codex"));
  expect(refusal(f, ["--preset", "chosen", "--preset-digest", "wrong"], "preset_config_changed").detail).toContain("changed mid-launch");
  refusal(f, ["--preset", "chosen", "--model", ""], "preset_not_composable");
  refusal(f, ["--preset", "chosen", "--model", "model-x"], "preset_not_composable");
  expect(success(f, "codex", ["--preset", "chosen", "--env", "GOOD=x"])).toContain("GOOD=x");
  refusal(f, ["--preset", "chosen"], "preset_harness_mismatch", "claude");
  success(f, "codex", ["--preset", "chosen"]);
});
test("dropped and missing presets remain different answers", () => {
  const f = fixture(preset("codex") + '[presets.bad]\nharness = "codex"\nenv.PATH = "/x"\n');
  refusal(f, ["--preset", "bad"], "preset_not_usable");
  refusal(f, ["--preset", "absent"], "preset_not_found");
});
test("config tokens use the builder floor, and OpenCode cannot adopt a configured conversation", () => {
  const f = fixture(preset("cursor", 'params.workspace = "/elsewhere"\n'));
  const command = success(f, "cursor", ["--preset", "chosen"]);
  expect(command.match(/--workspace/g)?.length).toBe(1);
  expect(command).not.toContain("/elsewhere");
  const oc = fixture(preset("opencode", 'params.session = "stolen"\nparams.continue = true\n') + '[harness.opencode.params]\nsession = "stolen-too"\ncontinue = true\n');
  const rendered = success(oc, "opencode", ["--preset", "chosen"]);
  expect(rendered).not.toMatch(/stolen|--session|--continue/);
});

test("declared environment wins, notices deduplicate, JSON stays quiet, values stay quoted", () => {
  const f = fixture(preset("claude", 'env.CREW_VALUE = "from preset"\n') + '[harness.claude.env]\nCREW_VALUE = "policy"\n');
  Object.assign(f.env, { CREW_VALUE: "ambient", TAP_JSON: "0" });
  const r = run(f, "claude", ["--preset", "chosen"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("'CREW_VALUE=from preset'");
  expect(r.stderr).toBe("tap session: overriding ambient ENV var CREW_VALUE with the declared value\n");
  f.env.TAP_JSON = "1";
  success(f, "claude", ["--preset", "chosen"]);
  const quoted = success(f, "codex", ["--model", "ok", "--env", `GOOD=it's $(touch should-not-exist)`]);
  expect(quoted).toContain(`'GOOD=it'"'"'s $(touch should-not-exist)'`);
  expect(existsSync(join(f.cwd, "should-not-exist"))).toBe(false);
});
test("PATH-selected POSIX shells and socket/index repins survive rendering", () => {
  const f = fixture();
  mkdirSync(join(f.cwd, "bin"));
  const shell = join(f.cwd, "bin/ash");
  writeFileSync(shell, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  Object.assign(f.env, { TAP_LAUNCH_SHELL: "ash", PATH: `${f.cwd}/bin:${process.env.PATH}`,
    TAP_TMUX_SOCKET: "private-socket", TAP_TMUX_SOCKET_PATH: join(f.cwd, "socket") });
  const command = success(f);
  expect(command.startsWith(`${shell} -lic `)).toBe(true);
  expect(command).toContain("TAP_TMUX_SOCKET=private-socket");
  expect(command).toContain(`TAP_TMUX_SOCKET_PATH=${f.cwd}/socket`);
  expect(command).toContain(`TAP_INDEX_HOME=${process.env.TAP_INDEX_HOME}`);
  f.env.TAP_LAUNCH_SHELL = join(f.cwd, "bin/fish");
  symlinkSync(shell, f.env.TAP_LAUNCH_SHELL);
  expect(success(f).startsWith(`${f.env.TAP_LAUNCH_SHELL} `)).toBe(false);
});

function registry(f: Fixture, axis = "seats") {
  const path = join(f.cwd, "registry.json");
  const row = { crew: true, pane_id: "%2", harness: "claude", session: "team/parent", harness_session_id: "keep-id",
    instance: "keep-instance", status: "active", registered_from_worktree: "/keep/worktree" };
  writeFileSync(path, JSON.stringify({ schema: "0.20", team: { name: "team" }, [axis]: { crew: row }, seat_forwardings: [{ source: "crew", source_instance: "keep-instance", address_active: true }] })
    .replace(/}$/, ',"wide":9007199254740993,"fraction":1.25}'));
  return { path, row, args: ["--preset", "chosen", "--record-pane", "%2", "--record-registry", path] };
}
for (const axis of ["seats"]) test(`${axis}: persist tuning, identity, numeric metadata and forwarding supersession`, () => {
  const f = fixture(preset("claude", 'env.TERM = "xterm"\n') + '[harness.claude]\npermissions = "auto"\n');
  const r = registry(f, axis);
  const command = success(f, "claude", r.args);
  expect(command).toContain("--permission-mode auto");
  expect(command).not.toContain("--dangerously");
  const bytes = readFileSync(r.path, "utf8"), saved = JSON.parse(bytes);
  expect(bytes).toContain("9007199254740993");
  expect(saved.fraction).toBe(1.25);
  expect(saved[axis].crew).toMatchObject({ ...r.row, model: "model-x", permissions: "auto", harness_env: { TERM: "xterm" }, passthrough: [], passthrough_from_config: true });
  expect(saved[axis].crew.preset.name).toBe("chosen");
  expect(saved.seat_forwardings[0]).toMatchObject({ address_active: false, custody_revoked: true });
});
test("moved/non-crew/wrong-harness/missing rows refuse without write or command", () => {
  const f = fixture(preset("claude")), r = registry(f);
  for (const change of [{ pane_id: "%3" }, { crew: false }, { harness: "codex" }, null]) {
    const before = JSON.stringify({ schema: "0.20", team: { name: "team" }, seats: { crew: change === null ? null : { ...r.row, ...change } } });
    writeFileSync(r.path, before);
    const error = refusal(f, r.args, "session_error", "claude");
    expect(error.detail).toContain("row changed");
    expect(readFileSync(r.path, "utf8")).toBe(before);
  }
  // C4a: an old agents-axis store is a typed old_store refusal, and is never rewritten.
  const old = JSON.stringify({ agents: { crew: r.row } });
  writeFileSync(r.path, old);
  const oldRun = run(f, "claude", r.args);
  expect(oldRun.status).toBe(1);
  expect(JSON.parse(oldRun.stdout).error_class).toBe("old_store");
  expect(readFileSync(r.path, "utf8")).toBe(old);
});
test("auto permission conflicts are checked before the config floor can hide them", () => {
  const f = fixture(preset("claude", 'params.permission-mode = "bypassPermissions"\n') + '[harness.claude]\npermissions = "auto"\n');
  const r = registry(f), before = readFileSync(r.path, "utf8");
  expect(refusal(f, r.args, "session_error", "claude").detail).toContain("harness_permissions_conflict");
  expect(readFileSync(r.path, "utf8")).toBe(before);
});

test("crew Codex auto carries the launcher profile and refuses a config param that turns the proxy off", () => {
  const auto = 'version = 3\n[harness.codex]\npermissions = "auto"\n';
  const command = success(fixture(auto), "codex");
  expect(command).toContain("--approve-for-me");
  expect(command).toMatch(/tap_launcher_auto_[0-9a-f]{12}/);
  for (const spelling of ['disable = "network_proxy"', 'config = ["features={network_proxy=false}"]']) {
    const f = fixture(auto + "[harness.codex.params]\n" + spelling + "\n");
    expect(refusal(f, ["--model", "model-x"], "session_error", "codex").detail).toContain("harness_permissions_conflict");
  }
});

test("final preparation rechecks the preset digest before touching the registered row", () => {
  const f = fixture(preset("claude")), r = registry(f), before = readFileSync(r.path, "utf8");
  refusal(f, [...r.args, "--preset-digest", "changed"], "preset_config_changed", "claude");
  expect(readFileSync(r.path, "utf8")).toBe(before);
});
test("a registry disappearing after selection retains the incumbent missing-file exit", () => {
  const f = fixture();
  const r = run(f, "codex", ["--model", "ok", "--record-pane", "%2", "--record-registry", join(f.cwd, "gone.json")]);
  expect(r.status).toBe(127);
  expect(r.stdout).toBe("");
  expect(r.stderr).toContain(`tap session: missing command: ${f.cwd}/gone.json`);
});
test("crew preserves the incumbent secure-read refusal and degraded-notice vocabulary", async () => {
  const realOpen = fs.openSync;
  for (const explicitPreset of [true, false]) {
    const f = fixture(preset("codex"));
    const replacement = join(f.cwd, "replacement.toml");
    writeFileSync(replacement, preset("codex"), { mode: 0o600 });
    let opens = 0;
    const spy = spyOn(fs, "openSync").mockImplementation(((path: never, ...rest: never[]) => {
      const fd = (realOpen as unknown as (...a: never[]) => number)(path, ...rest);
      // For ad-hoc crew, fault the fresh environment read after permission selection.
      if (String(path) === f.configFile && ++opens === (explicitPreset ? 1 : 2)) {
        fs.unlinkSync(f.configFile); symlinkSync(replacement, f.configFile);
      }
      return fd;
    }) as never);
    const messages: string[] = [];
    const stderr = spyOn(process.stderr, "write").mockImplementation(((text: unknown) => { messages.push(String(text)); return true; }) as never);
    try {
      const { crewInvocation } = await import("../src/launcher/crew-invocation");
      const args = ["codex", "team/crew", "--cwd", f.cwd, ...(explicitPreset ? ["--preset", "chosen"] : ["--model", "ok"])];
      if (explicitPreset) await expect(crewInvocation(args, f.env)).rejects.toThrow("preset_config_invalid: invalid preset config");
      else {
        await crewInvocation(args, { ...f.env, TAP_JSON: "0" });
        expect(messages.join("")).toContain("source changed while it was being opened; retry");
        expect(messages.join("")).not.toContain("changed while opening");
      }
    } finally { stderr.mockRestore(); spy.mockRestore(); }
    expect(opens).toBeGreaterThanOrEqual(explicitPreset ? 1 : 2);
    success(f, "codex", ["--preset", "chosen"]);
  }
});

test("literal sidecar contention waits beyond five seconds, then writes successfully", async () => {
  const f = fixture(preset("claude")), r = registry(f), before = readFileSync(r.path, "utf8");
  const holder = Bun.spawn(["python3", "-c", "import fcntl,sys; f=open(sys.argv[1],'w'); fcntl.flock(f,fcntl.LOCK_EX); print('locked',flush=True); sys.stdin.read()", `${r.path}.lock`],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: f.env });
  let worker: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const reader = holder.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked"); reader.releaseLock();
    worker = Bun.spawn(["bun", door, "claude", "team/crew", "--cwd", f.cwd, ...r.args],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: f.env });
    await Bun.sleep(6500);
    expect(worker.exitCode).toBeNull();
    expect(readFileSync(r.path, "utf8")).toBe(before);
    holder.stdin.end();
    expect(await holder.exited).toBe(0);
    expect(await worker.exited).toBe(0);
    expect(JSON.parse(readFileSync(r.path, "utf8")).seats.crew.model).toBe("model-x");
  } finally {
    holder.kill(); await holder.exited;
    if (worker) { worker.kill(); await worker.exited; }
  }
}, 20000);

test("crew launch removes the inherited stateless marker before the harness", () => {
  const f = fixture();
  const executable = join(f.cwd,"codex");
  writeFileSync(executable, "#!/bin/sh\nprintf '%s' \"${TAP_STATELESS-absent}\"\n", {mode:0o755});
  const command = success(f).replace(/\bcodex\b/, executable);
  const child = spawnSync("/bin/sh", ["-c",command], {env:{...f.env,TAP_STATELESS:"1"},encoding:"utf8"});
  expect(child.status,child.stderr).toBe(0);
  expect(child.stdout).toBe("absent");
});

test("crew launch strips inherited harness identity env before the harness, keeping the pane pins (tap-y4jkj)", () => {
  const f = fixture();
  const keys = [...INHERITED_IDENTITY_ENV, "TMUX", "TMUX_PANE"];
  const executable = join(f.cwd, "codex");
  writeFileSync(executable, `#!/bin/sh\n${keys.map(key => `printf '%s=%s\\n' ${key} "\${${key}-absent}"`).join("\n")}\n`, { mode: 0o755 });
  const command = success(f).replace(/\bcodex\b/, executable);
  expect(command).toContain("-u TAP_HARNESS_SESSION_ID");
  const decoy = Object.fromEntries([...INHERITED_IDENTITY_ENV].map(key => [key, `foreign-${key}`]));
  const child = spawnSync("/bin/sh", ["-c", command], { env: { ...f.env, ...decoy, TMUX: "/tmp/sock,1,0", TMUX_PANE: "%3" }, encoding: "utf8" });
  expect(child.status, child.stderr).toBe(0);
  const seen = Object.fromEntries(child.stdout.trim().split("\n").map(line => line.split(/=(.*)/s).slice(0, 2)));
  expect(seen).toEqual({ ...Object.fromEntries([...INHERITED_IDENTITY_ENV].map(key => [key, "absent"])), TMUX: "/tmp/sock,1,0", TMUX_PANE: "%3" });
});

// Crew takes tap session launch's overrides: typed env, unset keys and a literal harness tail, with or without a preset.
const echoHarness = (f: Fixture, name: string, keys: string[]) => {
  const executable = join(f.cwd, name);
  writeFileSync(executable, `#!/bin/sh\n${keys.map(key => `printf '%s=%s\\n' ${key} "\${${key}-absent}"`).join("\n")}\nfor arg in "$@"; do printf 'arg=%s\\n' "$arg"; done\n`, { mode: 0o755 });
  return executable;
};
test("OpenCode crew launch and recipe replay pass merged tabs config to the TUI", async () => {
  const f = fixture();
  const executable = echoHarness(f, "opencode", ["OPENCODE_CLI_CONFIG_CONTENT"]);
  Object.assign(f.env, { OPENCODE_CLI_CONFIG_CONTENT: '{"theme":{"name":"keep"}}' });
  const fresh = success(f, "opencode");
  const replay = await crewRecipeInvocation("team", "crew", { harness: "opencode", model: "model-x", cwd: f.cwd,
    harness_env: { OPENCODE_CLI_CONFIG_CONTENT: '{"tabs":{"mode":"on"}}' }, passthrough: [], permissions: "auto" }, f.env);
  for (const [command, mode] of [[fresh, "off"], [replay.command, "on"]]) {
    const child = spawnSync("/bin/sh", ["-c", command!.replace(/\bopencode\b(?= --standalone)/, executable)], { env: f.env, encoding: "utf8" });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout.split("\n")[0]!.slice("OPENCODE_CLI_CONFIG_CONTENT=".length)))
      .toEqual({ tabs: { mode }, theme: { name: "keep" } });
  }
});
test("OpenCode crew unset masks malformed ambient config and removes the default", () => {
  const f = fixture();
  Object.assign(f.env, { OPENCODE_CLI_CONFIG_CONTENT: "malformed", TAP_JSON: "0" });
  const r = run(f, "opencode", ["--model", "m", "--unset-env=OPENCODE_CLI_CONFIG_CONTENT"]);
  expect(r.status, r.stderr).toBe(0);
  expect(r.stderr).not.toContain("tabs.mode=off");
  expect(r.stdout).toContain("-u OPENCODE_CLI_CONFIG_CONTENT");
  expect(r.stdout).not.toContain("OPENCODE_CLI_CONFIG_CONTENT=");
});
test("a preset composes typed env, unset keys and a literal harness tail", () => {
  const f = fixture(preset("codex", 'env.CREW_VALUE = "from preset"\nenv.CREW_DROP = "from preset"\n'));
  const command = success(f, "codex", ["--preset", "chosen", "--env=CREW_VALUE=typed", "--unset-env=CREW_DROP",
    "--harness-arg=-c", "--harness-arg=model_context_window=250000", "--harness-arg="]);
  expect(command).toContain("-u CREW_DROP");
  const executable = echoHarness(f, "codex", ["CREW_VALUE", "CREW_DROP"]);
  // An ambient value is masked too: env -u runs after login startup.
  const child = spawnSync("/bin/sh", ["-c", command.replace(/\bcodex\b/, executable)], { env: { ...f.env, CREW_DROP: "ambient" }, encoding: "utf8" });
  expect(child.status, child.stderr).toBe(0);
  const lines = child.stdout.trim().split("\n");
  expect(lines.slice(0, 2)).toEqual(["CREW_VALUE=typed", "CREW_DROP=absent"]);
  expect(lines.slice(-3)).toEqual(["arg=-c", "arg=model_context_window=250000", "arg="]);
  expect(lines).toContain("arg=--model");
});
test("unset keys also mask machine policy and launcher defaults", () => {
  const f = fixture('version = 3\n[harness.claude.env]\nCREW_MACHINE = "policy"\n');
  const command = success(f, "claude", ["--model", "m", "--unset-env=CREW_MACHINE", "--unset-env=CLAUDE_CODE_NO_FLICKER"]);
  expect(command).not.toContain("CREW_MACHINE=policy");
  expect(command).not.toContain("CLAUDE_CODE_NO_FLICKER=1");
  expect(command).toContain("-u CLAUDE_CODE_NO_FLICKER");
  expect(command).toContain("-u CREW_MACHINE");
});
test("override refusals: same key twice, the env fence on unset keys, conversation flags, and permission conflicts", () => {
  const f = fixture(preset("claude") + '[harness.claude]\npermissions = "auto"\n');
  expect(refusal(f, ["--model", "m", "--env=SAME=x", "--unset-env=SAME"], "launch_arg_invalid", "claude").detail).toContain("both --env and --unset-env name SAME");
  expect(refusal(f, ["--model", "m", "--unset-env=TAP_HOME"], "launch_env_forbidden", "claude").action).toBe("remove --unset-env TAP_HOME from the command");
  expect(refusal(f, ["--model", "m", "--unset-env=BAD-KEY"], "launch_arg_invalid", "claude").detail).toContain("--unset-env key 'BAD-KEY'");
  for (const flag of ["--resume=abc", "--continue", "-c", "--session-id"]) {
    expect(refusal(f, ["--preset", "chosen", `--harness-arg=${flag}`], "launch_arg_invalid", "claude").detail).toContain("outside the crew's explicit selector");
  }
  for (const [harness, flags] of [["codex", ["resume"]], ["codex", ["fork"]], ["cursor", ["--resume=abc"]], ["cursor", ["--continue"]],
    ["agy", ["--conversation", "abc"]], ["agy", ["--continue"]]] as const) {
    const detail = refusal(fixture(), ["--model", "m", ...flags.map(flag => `--harness-arg=${flag}`)], "launch_arg_invalid", harness).detail;
    expect(detail).toContain("outside the crew's explicit selector");
  }
  expect(refusal(f, ["--preset", "chosen", "--harness-arg=--dangerously-skip-permissions"], "session_error", "claude").detail).toContain("harness_permissions_conflict");
  const oc = fixture();
  expect(success(oc, "opencode", ["--model", "m", "--harness-arg=--continue", "--harness-arg=--verbose"])).not.toContain("--continue");
});
test("overrides persist beside the preset recipe and replay on relaunch", async () => {
  const f = fixture(preset("claude", 'env.TERM = "xterm"\n') + '[harness.claude]\npermissions = "auto"\n');
  const r = registry(f);
  success(f, "claude", [...r.args, "--env=CREW_SETTING=v", "--unset-env=TERM", "--harness-arg=--verbose"]);
  const row = JSON.parse(readFileSync(r.path, "utf8")).seats.crew;
  expect(row).toMatchObject({ harness_env: { CREW_SETTING: "v" }, harness_env_set: ["CREW_SETTING"], harness_unset_env: ["TERM"],
    harness_tail: ["--verbose"], passthrough_from_config: true });
  const { command } = await crewRecipeInvocation("team", "crew", row, f.env);
  expect(command).toContain("-u TERM");
  expect(command).toContain("CREW_SETTING=v");
  expect(command).not.toContain("TERM=xterm");
  expect(command.endsWith(" --verbose")).toBe(true);
  // A selector written into a stored tail refuses on replay too.
  let replayed: { errorClass?: string } | null = null;
  try { await crewRecipeInvocation("team", "crew", { ...row, harness_tail: ["--resume", "old-id"] }, f.env); } catch (error) { replayed = error as { errorClass?: string }; }
  expect(replayed?.errorClass).toBe("launch_arg_invalid");
  for (const field of ["harness_unset_env", "harness_tail"]) {
    let thrown: { errorClass?: string } | null = null;
    try { await crewRecipeInvocation("team", "crew", { ...row, [field]: "not-a-list" }, f.env); } catch (error) { thrown = error as { errorClass?: string }; }
    expect(thrown?.errorClass).toBe("crew_recipe_missing");
  }
});

test("relaunch overrides fold into a crew recipe: unset then set again, typed keys tracked by name", () => {
  const base = { harness_env: { KEEP: "k", TYPED: "old" }, harness_unset_env: [], harness_tail: ["--a"], harness_env_set: ["TYPED"] };
  const unset = crewRecipeWithOverrides(base, { unset_env: ["TYPED"], argv: ["--b"] })!;
  expect(unset).toEqual({ harness_env: { KEEP: "k" }, harness_unset_env: ["TYPED"], harness_tail: ["--a", "--b"], harness_env_set: [] });
  const reset = crewRecipeWithOverrides(unset, { env: ["TYPED=new"] })!;
  expect(reset).toEqual({ harness_env: { KEEP: "k", TYPED: "new" }, harness_unset_env: [], harness_tail: ["--a", "--b"], harness_env_set: ["TYPED"] });
  expect(crewRecipeWithOverrides({ ...base, harness_tail: "bad" }, { env: ["X=1"] })).toBeNull();
});
