import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareExactRestart } from "../src/recovery/unwedge-restart";
import type { LaunchRecord } from "../src/launcher/transaction";
import { verifyRestartedConversation, type RestartProofIO } from "../src/recovery/unwedge-restart";
import type { SeatSnapshot } from "../src/verbs/doctor-seat";
const id = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
function fixture(harness = "codex") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "unwedge-restart-")));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config"), PATH: join(root, "bin") };
  mkdirSync(env.PATH!, { recursive: true }); mkdirSync(join(root, "config/tap"), { recursive: true });
  writeFileSync(join(root, "config/tap/config.toml"), `[harness.${harness}]\npermissions = "bypass"\n`, { mode: 0o600 });
  const executable = join(root, "bin", harness); writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const record: LaunchRecord = { name: "test/seat", base: "test", tag: "seat", index: 1, harness, cwd: root, harness_session_id: id };
  const dir = harness === "codex" ? join(root, ".codex/sessions/2026/10/28") : join(root, ".claude/projects/project"); mkdirSync(dir, { recursive: true });
  const path = harness === "codex" ? join(dir, `rollout-2026-10-28T00-00-00-${id}.jsonl`) : join(dir, `${id}.jsonl`);
  writeFileSync(path, JSON.stringify(harness === "codex" ? { type: "session_meta", payload: { id, cwd: root } } : { type: "assistant", sessionId: id, message: { content: [], stop_reason: "end_turn" } }) + "\n");
  record.transcript_path = path;
  return { root, env, record, path, executable };
}

test.each(["codex", "claude"])("exact restart binds %s identity, artifact, workdir and executable", harness => {
  const f = fixture(harness), prepared = prepareExactRestart(f.record, id, f.env);
  expect(prepared.invocation.argv[0]).toBe(f.executable); expect(prepared.invocation.argv).toContain(id);
  expect(prepared.transcript).toBe(f.path); expect(prepared.workdir).toBe(f.root);
});

test("missing, wrong-id and split-identity artifacts refuse before teardown", () => {
  for (const defect of ["missing-id", "wrong-id", "missing-artifact", "split"] as const) {
    const f = fixture();
    if (defect === "missing-id") f.record.harness_session_id = null;
    if (defect === "wrong-id") writeFileSync(f.path, JSON.stringify({ type: "session_meta", payload: { id: other, cwd: f.root } }) + "\n");
    if (defect === "missing-artifact") renameSync(f.path, f.path + ".gone");
    if (defect === "split") f.record.harness_session_id = other;
    expect(() => prepareExactRestart(f.record, id, f.env)).toThrow();
  }
});

test("a same-cwd different conversation is never an exact-resume artifact", () => {
  const f = fixture(); renameSync(f.path, f.path.replace(id, other));
  expect(() => prepareExactRestart(f.record, id, f.env)).toThrow("artifact");
});

test("the declared child store wins over ambient TAP aliases", () => {
  const f = fixture(), store = join(f.root, "child-codex");
  f.record.harness_env = { CODEX_HOME: store }; f.env.TAP_CODEX_HOME = join(f.root, ".codex");
  expect(() => prepareExactRestart(f.record, id, f.env)).toThrow("artifact");
  mkdirSync(join(store, "sessions/2026/10/28"), { recursive: true });
  const path = join(store, "sessions/2026/10/28", f.path.split("/").at(-1)!); renameSync(f.path, path); f.record.transcript_path = path;
  expect(prepareExactRestart(f.record, id, f.env).transcript).toBe(path);
});

test("removed workdir and unavailable executable refuse before any session stop", () => {
  const f = fixture(); f.record.launch_workdir = join(f.root, "missing");
  expect(() => prepareExactRestart(f.record, id, f.env)).toThrow("workdir");
  delete f.record.launch_workdir; chmodSync(f.executable, 0o600);
  expect(() => prepareExactRestart(f.record, id, f.env)).toThrow("executable");
});

test("post-start verification requires this launch and a stable process-bound native identity", () => {
  const f = fixture(), plan = prepareExactRestart(f.record, id, f.env);
  const snapshot = { binding: { harness: "codex", nativeSessionId: id, instance: "instance" } } as SeatSnapshot;
  const row = { status: "active", harness: "codex", harness_session_id: id, pane_id: "%2", instance: "instance", launch_witness: "launch" };
  const make = (): RestartProofIO => ({ row: () => row, pid: () => "321", native: () => ({ identity: { harness: "codex", harness_session_id: id, store_path: f.path, store_kind: "file", trust: "process", candidates: 1, detail: "process file", derived_at: "" }, refusal: "" }), transcript: () => true });
  expect(verifyRestartedConversation(snapshot, plan, "launch", f.env, make()).code).toBe(0);
  for (const defect of ["witness", "wrong-native", "unknown-native", "row-drift", "pid-drift", "transcript"] as const) {
    const io = make();
    if (defect === "witness") io.row = () => ({ ...row, launch_witness: "other" });
    if (defect === "wrong-native") { const native = io.native; io.native = pid => ({ identity: { ...native(pid).identity!, harness_session_id: other }, refusal: "" }); }
    if (defect === "unknown-native") io.native = () => ({ identity: null, refusal: "no_open_session" });
    if (defect === "row-drift") { let reads = 0; io.row = () => ++reads === 1 ? row : { ...row, pane_id: "%3" }; }
    if (defect === "pid-drift") { let reads = 0; io.pid = () => ++reads === 1 ? "321" : "322"; }
    if (defect === "transcript") io.transcript = () => false;
    expect(verifyRestartedConversation(snapshot, plan, "launch", f.env, io).code, defect).toBe(5);
  }
});
