import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { removeScratchTree } from "./support/scratch";
import { recordPermissionRequest } from "../src/claude-permission-hook";
import { pendingPermissionRequest, permissionRequestFiles } from "../src/permission-request";
import { scanEntries } from "../src/install-manifest";
import { removeEntry } from "../src/verbs/machine";

const REPO = resolve(import.meta.dir, "../../..");
const HOOK = join(REPO, "hooks/tap-claude-permission.sh");
const SESSION = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const OTHER = "59b665c7-cb5e-455b-81a4-d15671fd82ee";
const NOW = 1_794_598_987_311;

/** The payload Claude Code 2.1.323 sent for a Bash approval (probe, 2026-11-13), with a secret added to the command. */
function payload(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: SESSION, transcript_path: "/srv/agent/projects/x/s.jsonl", cwd: "/work", permission_mode: "auto",
    effort: { level: "high" }, hook_event_name: "PermissionRequest", tool_name: "Bash",
    tool_input: { command: "curl --data SECRET-FIELD https://example.test/Authorization", description: "Fetch the status page" },
    permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "curl:*" }], behavior: "allow", destination: "localSettings" }],
    ...fields,
  });
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(process.env.TMUX_TMPDIR!, "claude-permission-")));
  const workspace = join(root, "workspace"), index = join(root, "index"), bus = join(workspace, ".tap/bus");
  const registry = join(workspace, ".tap/team-registry.json"), sessions = join(root, ".claude/sessions");
  for (const dir of [bus, index, sessions]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    demo: { root: workspace, registry_location: registry, state: "registered" },
  } }));
  const seat = { harness: "claude", status: "active", pane_id: "%7", server_epoch: "srv:1:2", session: "demo/scout",
    instance: "scout|1", harness_session_id: SESSION };
  const save = (seats: Record<string, object>) =>
    writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "demo", worktree_root: workspace }, seats }));
  save({ scout: seat });
  const sessionFile = join(sessions, `${process.pid}.json`);
  const writeSession = (fields: Record<string, unknown> = {}) => writeFileSync(sessionFile, JSON.stringify({
    pid: process.pid, sessionId: SESSION, status: "waiting", waitingFor: "permission prompt", statusUpdatedAt: NOW - 12, ...fields }));
  writeSession();
  const env = { HOME: root, TAP_INDEX_HOME: index, CLAUDE_PROJECT_DIR: workspace, TAP_LAUNCH_ROOT: "", TAP_LAUNCH_ID: "", TAP_CLEAR_ID: "", TAP_STATELESS: "" };
  const observed = { state: "inside" as const, paneId: "%7", panePid: String(process.pid), serverEpoch: "srv:1:2", session: "demo/scout" };
  const fx = { observe: () => observed, now: () => NOW };
  const records = (): string[] => permissionRequestFiles(bus, "scout");
  /** The seat's one record file; a test that expects exactly one fails loudly on none or several. */
  const record = (): string => {
    const all = records();
    if (all.length !== 1) throw new Error(`expected one record for scout, found ${all.length}`);
    return all[0]!;
  };
  return { root, workspace, bus, seat, save, sessionFile, writeSession, env, observed, fx, record, records };
}

test("a registered seat's bound session records a bounded summary that the reader then shows", () => {
  const f = fixture();
  try {
    expect(recordPermissionRequest(payload(), f.env, f.fx)).toBe("scout");
    const raw = readFileSync(f.record(), "utf8");
    expect(JSON.parse(raw)).toEqual({ v: 1, harness: "claude", at: NOW, session: SESSION, pane_id: "%7", server_epoch: "srv:1:2",
      tool: "Bash", summary: "Fetch the status page", permission_mode: "auto", session_file: f.sessionFile });
    // Nothing of the command line, the suggestions or the transcript path is kept.
    for (const leak of ["curl", "SECRET", "Authorization", "addRules", "transcript", "/work"]) expect(raw.includes(leak), leak).toBe(false);
    expect(pendingPermissionRequest(f.bus, "scout", { sessionId: SESSION, paneId: "%7", serverEpoch: "srv:1:2" })).toEqual({
      tool: "Bash", summary: "Fetch the status page", since: Math.floor(NOW / 1000), waitingFor: "permission prompt" });

    // A question travels the same hook.
    f.writeSession({ waitingFor: "input needed" });
    expect(recordPermissionRequest(payload({ tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "Pick one", header: "Pick one", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] } }), f.env, { ...f.fx, now: () => NOW + 500 })).toBe("scout");
    // The later request is a new file, and the earlier one is gone.
    expect(JSON.parse(readFileSync(f.record(), "utf8"))).toMatchObject({ tool: "AskUserQuestion", summary: "Pick one", at: NOW + 500 });
  } finally { removeScratchTree(f.root); }
});

test("a seat records from any working directory: its row, not its directory, names its team", () => {
  const f = fixture();
  try {
    // A crew or worktree seat runs below the team root, or outside every enrolled root.
    const below = join(f.workspace, "tmp/lane"), outside = join(f.root, "elsewhere");
    for (const dir of [below, outside]) mkdirSync(dir, { recursive: true });
    for (const project of [below, outside]) {
      expect(recordPermissionRequest(payload(), { ...f.env, CLAUDE_PROJECT_DIR: project }, f.fx)).toBe("scout");
      expect(JSON.parse(readFileSync(f.record(), "utf8"))).toMatchObject({ session: SESSION, tool: "Bash" });
      rmSync(f.record());
    }
    // The same directories, and a session that is not the seat's: still nothing.
    for (const project of [below, outside]) {
      expect(recordPermissionRequest(payload({ session_id: OTHER }), { ...f.env, CLAUDE_PROJECT_DIR: project }, f.fx)).toBe("");
      expect(f.records()).toEqual([]);
    }
  } finally { removeScratchTree(f.root); }
});

test("a session that is not a registered seat's bound session writes nothing", () => {
  const f = fixture();
  try {
    const nothing = (input: string, env: NodeJS.ProcessEnv = f.env, fx: object = f.fx) => {
      expect(recordPermissionRequest(input, env, fx)).toBe("");
      expect(existsSync(join(f.bus, "permission-requests"))).toBe(false);
    };
    // A headless child started from the seat inherits its pane, not its session.
    nothing(payload({ session_id: OTHER }));
    // Another pane, another tmux server, or no pane at all.
    nothing(payload(), f.env, { ...f.fx, observe: () => ({ ...f.observed, paneId: "%8" }) });
    nothing(payload(), f.env, { ...f.fx, observe: () => ({ ...f.observed, serverEpoch: "srv:9:9" }) });
    nothing(payload(), f.env, { ...f.fx, observe: () => ({ state: "outside" as const, detail: "not in tmux" }) });
    // A machine with no TAP index, and one whose index does not enroll the seat's team.
    nothing(payload(), { ...f.env, TAP_INDEX_HOME: join(f.root, "no-index") });
    mkdirSync(join(f.root, "other-index"));
    writeFileSync(join(f.root, "other-index/global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} }));
    nothing(payload(), { ...f.env, TAP_INDEX_HOME: join(f.root, "other-index") });
    // The row exists and is not this session's: another harness, retired, or bound to another session.
    f.save({ scout: { ...f.seat, harness: "codex" } }); nothing(payload());
    f.save({ scout: { ...f.seat, status: "offline" } }); nothing(payload());
    f.save({ scout: { ...f.seat, harness_session_id: OTHER } }); nothing(payload());
    f.save({ scout: f.seat, twin: f.seat }); nothing(payload());
    f.save({ scout: f.seat });
    // A second enrolled team whose registry also claims this pane and session: neither is believed.
    const rival = join(f.root, "rival"), rivalRegistry = join(rival, ".tap/team-registry.json");
    mkdirSync(join(rival, ".tap/bus"), { recursive: true });
    writeFileSync(rivalRegistry, JSON.stringify({ schema: "0.20", team: { name: "rival", worktree_root: rival }, seats: { scout: f.seat } }));
    const enroll = (teams: object) => writeFileSync(join(f.root, "index/global-registry.json"), JSON.stringify({ schema: "0.20", teams }));
    const demo = { root: f.workspace, registry_location: join(f.workspace, ".tap/team-registry.json"), state: "registered" };
    enroll({ demo, rival: { root: rival, registry_location: rivalRegistry, state: "registered" } });
    nothing(payload());
    expect(existsSync(join(rival, ".tap/bus/permission-requests"))).toBe(false);
    // A retired team's registry is not consulted, so the live one is believed again.
    enroll({ demo, rival: { root: rival, registry_location: rivalRegistry, state: "historical" } });
    expect(recordPermissionRequest(payload(), f.env, f.fx)).toBe("scout");
    rmSync(f.record());
    rmSync(join(f.bus, "permission-requests"), { recursive: true });
    enroll({ demo });
    // Not this event, not an object, no usable tool name or session id.
    nothing(payload({ hook_event_name: "PreToolUse" }));
    nothing(JSON.stringify(["array"]));
    nothing(payload({ tool_name: "has space" }));
    nothing(payload({ session_id: "not-a-uuid" }));
    nothing(payload(), { ...f.env, TAP_STATELESS: "1" });
    // No session file that reports a status: no reader could vouch for a record.
    f.writeSession({ status: undefined });
    nothing(payload());
    f.writeSession({ sessionId: OTHER });
    nothing(payload());
  } finally { removeScratchTree(f.root); }
});

test("the registered adapter never answers: exit 0 and no stdout for any input", () => {
  const f = fixture();
  try {
    for (const input of [payload(), payload({ session_id: OTHER }), "not json", "", "{}"]) {
      const result = spawnSync("bash", [HOOK], { input, encoding: "utf8", cwd: f.workspace, timeout: 20_000,
        env: { ...process.env, HOME: f.root, TAP_INDEX_HOME: join(f.root, "index"), CLAUDE_PROJECT_DIR: f.workspace } });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    }
    // The test runner's pane is not the fixture seat's, so the real adapter recorded nothing.
    expect(existsSync(join(f.bus, "permission-requests"))).toBe(false);
  } finally { removeScratchTree(f.root); }
});

// --- the installer's wire and unwire ----------------------------------------------------------

const INSTALLER = join(REPO, "runtime/bun/src/install-hooks.ts");
const settingsRun = (path: string, mode: string, hook = HOOK) =>
  spawnSync(process.execPath, [INSTALLER, "claude-permission", path, hook, mode], { encoding: "utf8" });
const OURS = { hooks: [{ type: "command", command: HOOK, timeout: 10 }] };
// A user's own PermissionRequest hook and unrelated settings, as a real settings file carries them.
const USER = { model: "opus", permissions: { allow: ["Bash(ls:*)"] },
  hooks: { PermissionRequest: [{ hooks: [{ type: "command", command: "/opt/user-tools/permission-status" }] }], Stop: [{ hooks: [{ type: "command", command: "mine" }] }] } };

test("wire adds one entry, keeps the user's own hooks and settings, and a second run changes nothing", () => {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR!, "claude-permission-wire-"));
  try {
    const path = join(root, "settings.json");
    writeFileSync(path, JSON.stringify(USER));
    const first = settingsRun(path, "wire");
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toBe(`install: wired PermissionRequest observer into ${path}\n`);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ...USER, hooks: { ...USER.hooks, PermissionRequest: [...USER.hooks.PermissionRequest, OURS] } });
    const before = readFileSync(path, "utf8");
    const second = settingsRun(path, "wire");
    expect(second.status).toBe(0);
    expect(second.stdout).toBe("");
    expect(readFileSync(path, "utf8")).toBe(before);

    // No settings file yet: wire creates it with the one entry.
    const fresh = join(root, "fresh.json");
    expect(settingsRun(fresh, "wire").status).toBe(0);
    expect(JSON.parse(readFileSync(fresh, "utf8"))).toEqual({ hooks: { PermissionRequest: [OURS] } });
  } finally { removeScratchTree(root); }
});

test("wire replaces an entry left by a checkout at another path and collapses duplicates", () => {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR!, "claude-permission-move-"));
  try {
    const path = join(root, "settings.json");
    const stale = { type: "command", command: "/old/clone/hooks/tap-claude-permission.sh" };
    writeFileSync(path, JSON.stringify({ hooks: { PermissionRequest: [{ hooks: [stale] }, OURS, OURS, { hooks: [{ type: "command", command: "mine" }, stale] }] } }));
    expect(settingsRun(path, "wire").status).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ hooks: { PermissionRequest: [OURS, { hooks: [{ type: "command", command: "mine" }] }] } });

    // An entry at the current path without the time bound, or with another, is replaced by the bounded one.
    for (const unbounded of [{ type: "command", command: HOOK }, { type: "command", command: HOOK, timeout: 600 }]) {
      writeFileSync(path, JSON.stringify({ hooks: { PermissionRequest: [{ hooks: [unbounded] }] } }));
      expect(settingsRun(path, "wire").status).toBe(0);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ hooks: { PermissionRequest: [OURS] } });
    }
  } finally { removeScratchTree(root); }
});

test("unwire removes TAP's entry and nothing else, and is a no-op where there is nothing of TAP's", () => {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR!, "claude-permission-unwire-"));
  try {
    const path = join(root, "settings.json");
    writeFileSync(path, JSON.stringify(USER));
    expect(settingsRun(path, "wire").status).toBe(0);
    const removed = settingsRun(path, "unwire");
    expect(removed.status, removed.stderr).toBe(0);
    expect(removed.stdout).toBe(`install: removed PermissionRequest observer from ${path}\n`);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(USER);
    const before = readFileSync(path, "utf8");
    expect(settingsRun(path, "unwire").stdout).toBe("");
    expect(readFileSync(path, "utf8")).toBe(before);

    // TAP's entry was the only one: the event key goes with it, the rest of the file stays.
    writeFileSync(path, JSON.stringify({ model: "opus", hooks: { PermissionRequest: [OURS], Stop: [] } }));
    expect(settingsRun(path, "unwire").status).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ model: "opus", hooks: { Stop: [] } });

    // Nothing to do: no file, no hooks table. Neither creates a file.
    const absent = join(root, "absent.json");
    expect(settingsRun(absent, "unwire").status).toBe(0);
    expect(existsSync(absent)).toBe(false);
    writeFileSync(path, JSON.stringify({ model: "opus" }));
    expect(settingsRun(path, "unwire").stdout).toBe("");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ model: "opus" });
  } finally { removeScratchTree(root); }
});

test("a settings file the installer cannot use is left as it is, with one warning and exit 0", () => {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR!, "claude-permission-bad-"));
  try {
    const path = join(root, "settings.json");
    for (const bytes of ["{ not json", JSON.stringify(["array"]), JSON.stringify({ hooks: [] }), JSON.stringify({ hooks: { PermissionRequest: {} } })]) {
      for (const mode of ["wire", "unwire"]) {
        writeFileSync(path, bytes);
        const result = settingsRun(path, mode);
        expect(result.status).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr.startsWith("install: WARNING: skipped Claude PermissionRequest observer")).toBe(true);
        expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
        expect(readFileSync(path, "utf8")).toBe(bytes);
      }
    }
    expect(settingsRun(path, "sideways").status).toBe(2);
  } finally { removeScratchTree(root); }
});

test("the install manifest records the entry, so uninstall removes it and keeps the user's own hook", () => {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR!, "claude-permission-custody-"));
  try {
    const targets = Object.fromEntries(["BIN_DIR", "INDEX_HOME", "CLAUDE_HOME", "CODEX_HOME", "HERMES_HOME",
      "OPENCODE_HOME", "GEMINI_HOME", "CURSOR_AGENT_HOME", "AGENTS_HOME", "CURSOR_HOME"].map(key => [key, join(root, key)]));
    mkdirSync(targets.CLAUDE_HOME!, { recursive: true });
    const path = join(targets.CLAUDE_HOME!, "settings.json");
    writeFileSync(path, JSON.stringify(USER));
    expect(settingsRun(path, "wire").status).toBe(0);
    const entries = scanEntries(REPO, targets, false).filter(entry => entry.path === path && entry.event === "PermissionRequest");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "hook", nested: true, value: { type: "command", command: HOOK, timeout: 10 } });
    expect(removeEntry(entries[0]!)).toContain("removed TAP PermissionRequest hook");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(USER);
  } finally { removeScratchTree(root); }
});
