import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { removeScratchTree } from "./support/scratch";
import { captureAgyIdentity, type AgyBindRequest } from "../src/agy-identity-hook";
import { scanEntries } from "../src/install-manifest";
import { removeEntry } from "../src/verbs/machine";

const REPO = resolve(import.meta.dir, "../../..");
const HOOK = join(REPO, "hooks/tap-agy-identity.sh");

test("installer adds the native invocation hook while preserving other hooks and is idempotent", () => {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR!, "agy-install-"));
  try {
    const path = join(root, "hooks.json");
    const own = { PreInvocation: [{ command: "my-hook" }], enabled: false };
    writeFileSync(path, JSON.stringify({ personal: own, "tap-tmux-kill-server": { PreToolUse: [] } }));
    const args = [join(REPO, "runtime/bun/src/install-hooks.ts"), "agy-identity", path, HOOK];
    const first = spawnSync(process.execPath, args, { encoding: "utf8" });
    expect(first.status, first.stderr).toBe(0);
    const installed = JSON.parse(readFileSync(path, "utf8"));
    expect(installed.personal).toEqual(own);
    expect(installed["tap-tmux-kill-server"]).toEqual({ PreToolUse: [] });
    expect(installed["tap-session-identity"]).toEqual({
      PreInvocation: [{ type: "command", command: `bash '${HOOK}'`, timeout: 4 }],
      PostInvocation: [{ type: "command", command: `bash '${HOOK}'`, timeout: 4 }],
    });
    const before = readFileSync(path, "utf8");
    expect(spawnSync(process.execPath, args).status).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(before);
  } finally { removeScratchTree(root); }
});

test("an untrusted native payload cannot register through the hook", () => {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR!, "agy-hook-"));
  try {
    mkdirSync(join(root, "index"));
    for (const [input, native] of [["not-json", ""], [JSON.stringify({ conversationId: "payload-only" }), ""],
      [JSON.stringify({ conversationId: "payload-id" }), "different-env-id"]]) {
      const result = spawnSync("bash", [HOOK], { input, encoding: "utf8", cwd: root,
        env: { ...process.env, HOME: root, TAP_INDEX_HOME: join(root, "index"), ANTIGRAVITY_CONVERSATION_ID: native }, timeout: 2000 });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("{}");
      expect(result.stderr).toBe("");
    }
  } finally { removeScratchTree(root); }
});

// The only substituted effects are the native pane observation and the bind
// process boundary. Enrollment, row selection and capture decisions stay real.
test("native hook binds from workspace authority, skips accepted identity, and consumes resume expectations", async () => {
  const root = realpathSync(mkdtempSync(join(process.env.TMUX_TMPDIR!, "agy-capture-")));
  try {
    const workspace = join(root, "workspace"), index = join(root, "index"), registry = join(workspace, ".tap/team-registry.json");
    for (const dir of [join(workspace, ".tap/bus"), index]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
      demo: { root: workspace, registry_location: registry, state: "registered" },
    } }));
    const id = "59b665c7-cb5e-455b-81a4-d15671fd82ee";
    const gemini = join(root, ".gemini");
    mkdirSync(join(gemini, "antigravity-cli"), { recursive: true });
    const store = join(gemini, "antigravity-cli/conversation_summaries.db");
    const db = new Database(store);
    db.exec("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, parent_conversation_id TEXT NOT NULL DEFAULT '', nesting_depth INTEGER NOT NULL DEFAULT 0)");
    db.query("INSERT INTO conversation_summaries (conversation_id) VALUES (?)").run(id);
    db.close();
    const observed = { state: "inside" as const, paneId: "%1", panePid: String(process.pid), serverEpoch: "srv:1:2", session: "demo/scout" };
    const row = { harness: "agy", status: "active", pane_id: "%1", server_epoch: "srv:1:2", session: "demo/scout", instance: "scout|1" };
    const save = (extra: object = {}) => writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "demo", worktree_root: workspace }, seats: { scout: { ...row, ...extra } } }));
    const calls: unknown[] = [];
    const fx = { observe: () => observed, bind: ({ root, sessionId, transcript }: AgyBindRequest) => { calls.push({ root, sessionId, transcript }); } };
    const env = { HOME: root, TAP_INDEX_HOME: index, ANTIGRAVITY_CONVERSATION_ID: id,
      TAP_LAUNCH_ROOT: "", TAP_LAUNCH_ID: "", TAP_CLEAR_ID: "", TAP_STATELESS: "" };
    const input = JSON.stringify({ conversationId: id, workspacePaths: [workspace], transcriptPath: join(root, "transcript_full.jsonl"), invocationNum: 0 });
    save();
    captureAgyIdentity(input, env, fx);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ root: workspace, sessionId: id, transcript: join(root, "transcript_full.jsonl") });
    calls.length = 0;
    const accepted = { harness_session_id: id, identity_capture_result: { decision: "accepted", observed_harness_session_id: id } };
    save(accepted);
    const before = readFileSync(registry, "utf8");
    captureAgyIdentity(input, env, fx);
    expect(calls).toHaveLength(0);
    expect(readFileSync(registry, "utf8")).toBe(before);
    for (const pending of [{ launch_id: "pending" }, { expected_clear_nonce: "pending" }, { status_reason: "launching" }]) {
      save({ ...accepted, ...pending });
      captureAgyIdentity(input, env, fx);
      expect(calls).toHaveLength(1);
      calls.length = 0;
    }
    save({ ...accepted, identity_capture: { mode: "exact_resume", expected_harness_session_id: id } });
    captureAgyIdentity(input, env, fx);
    expect(calls).toHaveLength(1); // Must answer the pending expectation before a later in-app switch.
    calls.length = 0;
    save({ ...accepted, harness_session_id: "other-id" });
    captureAgyIdentity(input, env, fx);
    expect(calls).toHaveLength(1);
    calls.length = 0;
    for (const badEnv of [{ ...env, ANTIGRAVITY_CONVERSATION_ID: "" }, { ...env, ANTIGRAVITY_CONVERSATION_ID: "different" }, { ...env, TAP_STATELESS: "1" }]) captureAgyIdentity(input, badEnv, fx);
    captureAgyIdentity(JSON.stringify({ conversationId: id, workspacePaths: [root] }), env, fx);
    expect(calls).toHaveLength(0);
    // A validated launch token chooses the launching team even when its workdir is elsewhere.
    save({ launch_witness: "launch-1" });
    captureAgyIdentity(JSON.stringify({ conversationId: id, workspacePaths: [root] }), { ...env, TAP_LAUNCH_ROOT: workspace, TAP_LAUNCH_ID: "launch-1" }, fx);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ root: workspace, sessionId: id });
    calls.length = 0;
    // A subagent carries matching native env and payload, but is not the pane's root conversation.
    const child = "90de61f1-9729-4c5c-817f-0cb18b89b010";
    const native = new Database(store);
    native.query("INSERT INTO conversation_summaries VALUES (?, ?, 1)").run(child, id);
    native.close();
    save(accepted);
    captureAgyIdentity(JSON.stringify({ conversationId: child, workspacePaths: [workspace] }), { ...env, ANTIGRAVITY_CONVERSATION_ID: child }, fx);
    expect(calls).toHaveLength(0);
    const missing = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    captureAgyIdentity(JSON.stringify({ conversationId: missing, workspacePaths: [workspace] }), { ...env, ANTIGRAVITY_CONVERSATION_ID: missing }, fx);
    expect(calls).toHaveLength(0); // The store cannot supply a different id when this native id is absent.
    // Already accepted identities remain a no-op when the store is unavailable.
    writeFileSync(store, "not SQLite");
    captureAgyIdentity(input, env, fx);
    expect(calls).toHaveLength(0);
    save();
    captureAgyIdentity(input, env, fx);
    expect(calls).toHaveLength(0);
  } finally { removeScratchTree(root); }
});

test("both Gemini hook writers preserve a symlinked personal hooks file", () => {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR!, "agy-symlink-"));
  try {
    const target = join(root, "owned.json"), path = join(root, "hooks.json");
    writeFileSync(target, JSON.stringify({ personal: { Stop: [{ command: "personal-stop" }] } }));
    symlinkSync(target, path);
    for (const [mode, command] of [["gemini", "/tap/guard"], ["agy-identity", HOOK]]) {
      const result = spawnSync(process.execPath, [join(REPO, "runtime/bun/src/install-hooks.ts"), mode!, path, command!], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
    }
    const data = JSON.parse(readFileSync(target, "utf8"));
    expect(data.personal).toEqual({ Stop: [{ command: "personal-stop" }] });
    expect(data["tap-session-identity"].PreInvocation).toHaveLength(1);
  } finally { removeScratchTree(root); }
});

test("installation custody removes only the recorded identity namespace", () => {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR!, "agy-custody-"));
  try {
    const targets = Object.fromEntries(["BIN_DIR", "INDEX_HOME", "CLAUDE_HOME", "CODEX_HOME", "HERMES_HOME",
      "OPENCODE_HOME", "GEMINI_HOME", "CURSOR_AGENT_HOME", "AGENTS_HOME", "CURSOR_HOME"].map(key => [key, join(root, key)]));
    const config = join(targets.GEMINI_HOME!, "config"), path = join(config, "hooks.json");
    mkdirSync(config, { recursive: true });
    writeFileSync(path, JSON.stringify({ personal: { Stop: [{ command: "mine" }] } }));
    const result = spawnSync(process.execPath, [join(REPO, "runtime/bun/src/install-hooks.ts"), "agy-identity", path, HOOK]);
    expect(result.status).toBe(0);
    const entries = scanEntries(REPO, targets, false).filter(entry => entry.path === path);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "json-key", key: "tap-session-identity" });
    expect(removeEntry(entries[0]!)).toContain("removed TAP's tap-session-identity entry");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ personal: { Stop: [{ command: "mine" }] } });
  } finally { removeScratchTree(root); }
});
