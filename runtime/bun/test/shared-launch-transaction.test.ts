import { startupTrace, withStartupTrace } from "../src/startup-trace";
import { destructiveTarget } from "../src/launcher/observation";
import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { bindTransaction, launchTransaction, RestartResumeFailure, type LaunchRecord } from "../src/launcher/transaction";
import { paneFacts } from "../src/launcher/readiness";

const original = { ...process.env }, tmux = Bun.which("tmux")!;
const sockets: string[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) spawnSync(tmux, ["-S", socket, "kill-server"], { stdio: "ignore" });
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
});
function fixture(harness: string, binary = "/bin/sleep") {
  const root = realpathSync(mkdtempSync(join(original.TAP_INDEX_HOME!, "shared-")));
  const registry = join(root, ".tap/team-registry.json"), socket = join(original.TMUX_TMPDIR!, `shared-${process.pid}-${sockets.length}`);
  sockets.push(socket);
  for (const d of ["index", "bin", "real", ".tap/bus", "config"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture", worktree_root: root }, seats: {} }));
  writeFileSync(join(root, "index/global-registry.json"), JSON.stringify({ schema: "0.20", teams: { fixture: { root, registry_location: registry } } }));
  const env: NodeJS.ProcessEnv = { ...original, HOME: root, XDG_CONFIG_HOME: join(root, "config"), TAP_INDEX_HOME: join(root, "index"), TAP_HOME: join(root, ".tap/bus"),
    TAP_TMUX_SOCKET_PATH: socket, TAP_LAUNCH_SHELL: "/bin/bash", SHELL: "/bin/bash", PATH: `${root}/bin:${original.PATH}` };
  for (const key of ["TMUX", "TMUX_PANE", "TAP_SELF", "TAP_TMUX_SOCKET", "TAP_SERVER_EPOCH", "TAP_BOOT_ID", "TAP_LOCK_DIR"]) delete env[key];
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  writeFileSync(join(root, ".bash_profile"), `export PATH='${env.PATH}'\n`);
  const executable = harness === "cursor" ? "cursor-agent" : harness;
  const real = join(root, "real", executable);
  if (process.platform === "linux") copyFileSync(binary, real); else symlinkSync(binary, real);
  writeFileSync(join(root, "bin", executable), `#!/bin/sh\nif [ "$1" = create-chat ]; then echo 550e8400-e29b-41d4-a716-446655440000; exit 0; fi\nprintf '%s\\n' "$@" > '${root}/argv'\nprintf '%s\\n' "$FEATURE" > '${root}/env'\nexec '${real}' ${binary === "/bin/sleep" ? "600" : ""}\n`);
  chmodSync(join(root, "bin", executable), 0o755);
  const record: LaunchRecord = { name: "fixture/seat", harness, cwd: root, base: "fixture", tag: "seat", index: 1, ensure_action: "new",
    harness_env: { FEATURE: "literal $HOME" }, harness_tail: ["literal $(touch SHOULD_NOT_EXIST)"], harness_passthrough: [], harness_unset_env: [] };
  return { root, registry, socket, env, record };
}

test.each(["claude", "codex", "opencode", "cursor", "agy", "hermes"])("shared fresh transaction launches %s natively", async harness => {
  const f = fixture(harness);
  Object.assign(process.env, f.env);
  const outcome = await withStartupTrace(async () => {
    startupTrace("launch_start", { cwd: f.root, handle: "seat" });
    const result = await launchTransaction({ kind: "new", record: f.record }, f.env);
    startupTrace("launch_complete", { exit_code: result.code });
    return result;
  });
  expect(outcome.code).toBe(0);
  expect(outcome.backup.status).toBe("not-needed");
  expect(existsSync(join(f.root, ".tap/backup"))).toBe(false);
  const trace = readFileSync(join(f.root, "index/logs/startup.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const operation = trace.find(row => row.event === "launch_start").operation_id;
  expect(trace.find(row => row.event === "respawn_pane").operation_id).toBe(operation);
  expect(trace.findLast(row => row.event === "launch_complete").operation_id).toBe(operation);
  const row = JSON.parse(readFileSync(f.registry, "utf8")).seats.seat;
  expect(row.status).toBe("active");
  expect(row.status_reason).toBe("");
  expect(row.launch_id).toBeUndefined();
  expect(row.pane_id).toMatch(/^%\d+$/);
  expect(readFileSync(join(f.root, "argv"), "utf8")).toContain("literal $(touch SHOULD_NOT_EXIST)");
  expect(readFileSync(join(f.root, "env"), "utf8")).toBe("literal $HOME\n");
  expect(existsSync(join(f.root, "SHOULD_NOT_EXIST"))).toBe(false);
}, 20_000);

// tap session fork: kind "new" with ensure_action "fork" runs the native fork argv
// and records a launcher-new identity, so the fork never claims the source's id.
test.each([
  ["claude", ["--resume", "source-id", "--fork-session", "--session-id", "fork-minted-id"]],
  ["codex", ["fork", "source-id"]],
  ["opencode", ["--session", "source-id"]],
] as const)("shared fork transaction launches %s with its native fork", async (harness, expected) => {
  const f = fixture(harness);
  Object.assign(process.env, f.env);
  Object.assign(f.record, { ensure_action: "fork", fork_source_session_id: "source-id",
    harness_session_id: harness === "claude" ? "fork-minted-id" : null });
  const { reserveTransaction } = await import("../src/launcher/transaction");
  const { selectCaller } = await import("../src/selector");
  const selection = selectCaller({ cwd: f.root, env: f.env, verbClass: "lifecycle" });
  const probe = structuredClone(f.record);
  await reserveTransaction(selection, { kind: "new", record: probe }, { selection, handle: "seat", token: "", instance: null, record: probe,
    vessel: null, backup: { status: "not-needed" }, reason: "session_replaced", output_path: "" }, f.env);
  const reserved = JSON.parse(readFileSync(f.registry, "utf8")).seats.seat;
  expect(reserved.identity_capture).toEqual({ mode: "launcher_new", ...(harness === "claude" ? { expected_harness_session_id: "fork-minted-id" } : {}) });
  expect(reserved.harness_session_id ?? null).toBe(harness === "claude" ? "fork-minted-id" : null);
  expect(reserved.fork_source_session_id).toBeUndefined();
  const doc = JSON.parse(readFileSync(f.registry, "utf8")); doc.seats = {}; writeFileSync(f.registry, JSON.stringify(doc));
  const outcome = await launchTransaction({ kind: "new", record: f.record }, f.env);
  expect(outcome.code).toBe(0);
  const argv = readFileSync(join(f.root, "argv"), "utf8").trim().split("\n");
  const at = argv.indexOf(expected[0]);
  expect(at).toBeGreaterThanOrEqual(0);
  expect(argv.slice(at, at + expected.length)).toEqual([...expected]);
  // The composer's session pin moves opencode's --session after the tail; --fork stays.
  if (harness === "opencode") expect(argv).toContain("--fork");
  expect(JSON.parse(readFileSync(f.registry, "utf8")).seats.seat.status).toBe("active");
}, 20_000);

test("a fork whose source worktree sits outside the team root still reserves on the pinned team", async () => {
  const f = fixture("codex");
  Object.assign(process.env, f.env);
  const foreign = realpathSync(mkdtempSync(join(original.TAP_INDEX_HOME!, "foreign-worktree-")));
  Object.assign(f.record, { cwd: foreign, ensure_action: "fork", fork_source_session_id: "source-id", harness_session_id: null });
  const outcome = await launchTransaction({ kind: "new", record: f.record, root: f.root }, f.env);
  expect(outcome.code).toBe(0);
  const row = JSON.parse(readFileSync(f.registry, "utf8")).seats.seat;
  expect([row.status, row.registered_from_worktree]).toEqual(["active", f.root]);
}, 20_000);

function incumbent(f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) {
  const created = spawnSync(tmux, ["-S", f.socket, "new-session", "-d", "-s", f.record.name, "-P", "-F", "#{pane_id}\t#{pid}:#{start_time}", "/bin/sleep 600"], { env: f.env, encoding: "utf8" });
  expect(created.status, created.stderr).toBe(0);
  const [pane, server] = created.stdout.trim().split("\t");
  const row = { status: "active", harness: f.record.harness, delivery: "pane", session: f.record.name, pane: `${f.record.name}:0.0`, pane_id: pane,
    server_epoch: `srv:${server}`, instance: "original-instance", base: "fixture", tag: "seat", index: 1, registered_from_worktree: f.root,
    permissions: "auto", future: { nested: ["retained", 17] }, ...extra };
  const doc = JSON.parse(readFileSync(f.registry, "utf8"));
  doc.seats.seat = row;
  doc.seats.sibling = { ...row, instance: "sibling-instance", crew: true };
  delete doc.seats.sibling.harness_session_id;
  writeFileSync(f.registry, JSON.stringify(doc));
  return row;
}

// The created pane, as the ready bind recorded it.
const boundPaneId = (f: { registry: string; record: { name: string } }): string =>
  (Object.values(JSON.parse(readFileSync(f.registry, "utf8")).seats) as { session?: string; pane_id?: string }[])
    .find(row => row.session === f.record.name)!.pane_id!;

test.each(["claude", "opencode"])("ready %s launch lets an immediate clean exit close the session", async harness => {
  const f = fixture(harness, "/usr/bin/tee");
  await launchTransaction({ kind: "new", record: f.record }, f.env);
  const pane = boundPaneId(f);
  expect(spawnSync(tmux, ["-S", f.socket, "show-options", "-p", "-A", "-v", "-t", pane, "remain-on-exit"], { encoding: "utf8" }).stdout.trim()).toBe("off");
  expect(spawnSync(tmux, ["-S", f.socket, "show-hooks", "-p", "-t", pane], { encoding: "utf8" }).stdout).not.toContain("pane-died");
  // EOF makes the running fixture harness exit 0, without killing or replacing its pane.
  expect(spawnSync(tmux, ["-S", f.socket, "send-keys", "-t", pane, "C-d"]).status).toBe(0);
  await until(() => spawnSync(tmux, ["-S", f.socket, "has-session", "-t", `=${f.record.name}`]).status !== 0);
}, 20_000);

test.each([0, 17])("exit %s before launch readiness leaves no stranded session", async code => {
  const f = fixture("claude");
  writeFileSync(join(f.root, "bin/claude"), `#!/bin/sh\necho early-exit-fixture\nexit ${code}\n`);
  await expect(launchTransaction({ kind: "new", record: f.record }, f.env)).rejects.toThrow();
  await until(() => spawnSync(tmux, ["-S", f.socket, "has-session", "-t", `=${f.record.name}`]).status !== 0);
  expect(JSON.parse(readFileSync(f.registry, "utf8")).seats).toEqual({});
}, 20_000);

test.each(["on", "failed"])("shared launch restores inherited retention %s", async retention => {
  const f = fixture("claude");
  expect(spawnSync(tmux, ["-S", f.socket, "new-session", "-d", "-s", "keeper", "exec /bin/sleep 600"]).status).toBe(0);
  expect(spawnSync(tmux, ["-S", f.socket, "set-option", "-g", "remain-on-exit", retention]).status).toBe(0);
  expect(spawnSync(tmux, ["-S", f.socket, "set-hook", "-g", "pane-died[42]", "display-message unrelated-hook"]).status).toBe(0);
  await launchTransaction({ kind: "new", record: f.record }, f.env);
  const pane = boundPaneId(f);
  expect(spawnSync(tmux, ["-S", f.socket, "show-options", "-p", "-v", "-t", pane, "remain-on-exit"], { encoding: "utf8" }).stdout.trim()).toBe("");
  expect(spawnSync(tmux, ["-S", f.socket, "show-options", "-p", "-A", "-v", "-t", pane, "remain-on-exit"], { encoding: "utf8" }).stdout.trim()).toBe(retention);
  expect(spawnSync(tmux, ["-S", f.socket, "show-hooks", "-g", "pane-died"], { encoding: "utf8" }).stdout).toContain("pane-died[42]");
}, 20_000);

test("restart preserves sibling metadata, writes the pre-claim bundle, and the real restore consumes it", async () => {
  const f = fixture("claude");
  const before = incumbent(f);
  const outcome = await launchTransaction({ kind: "restart", record: f.record, incumbent_live: true }, f.env);
  expect(outcome.backup.status).toBe("backed-up");
  if (outcome.backup.status !== "backed-up") throw new Error("missing bundle");
  const bundle = outcome.backup.path;
  expect(JSON.parse(readFileSync(join(bundle, "registry-row.json"), "utf8")).agent).toEqual(before);
  expect(readFileSync(join(bundle, "COMPLETE"), "utf8")).toBe("complete\n");
  const after = JSON.parse(readFileSync(f.registry, "utf8"));
  expect(after.seats.sibling).toEqual({ ...before, instance: "sibling-instance", crew: true, status: "suspended", status_reason: "session_restarted" });
  expect(after.seats.seat.future).toEqual(before.future);
  expect(after.seats.seat.instance).toBe(before.instance);
  // Restore refuses any extant row. Remove the fixture's current seat through
  // the actual public teardown, then consume the original backup via restore.
  spawnSync(tmux, ["-S", f.socket, "kill-session", "-t", `=${f.record.name}`], { env: f.env });
  const cli = resolve(import.meta.dir, "../main.ts");
  const teardown = spawnSync(process.execPath, [cli, "teardown", "seat", "--yes", "--json"], { cwd: f.root, env: f.env, encoding: "utf8", timeout: 15_000 });
  expect(teardown.status, teardown.stderr + teardown.stdout).toBe(0);
  const restore = spawnSync(process.execPath, [cli, "restore", "seat", "--archive", bundle, "--json"], { cwd: f.root, env: f.env, encoding: "utf8", timeout: 15_000 });
  expect(restore.status, restore.stderr + restore.stdout).toBe(0);
  const restored = JSON.parse(readFileSync(f.registry, "utf8")).seats.seat;
  expect(restored.future).toEqual(before.future);
  expect(restored.instance).toBe(before.instance);
  expect(restored.permissions).toBe("auto");
  expect(restored.status).toBe("suspended");
  expect(restored.status_reason).toBe("restored_from_archive");
  expect(restored.launch_id).toBeUndefined();
}, 35_000);

test.each(["fresh", "preserving"])("%s backup failure keeps the specified destruction policy", async policy => {
  const f = fixture("claude");
  const before = incumbent(f);
  writeFileSync(join(f.root, ".tap/backup"), "unwritable path fixture");
  if (policy === "fresh") {
    f.record.replaces_session = f.record.name;
    f.record.kill_backup_required = true;
    await expect(launchTransaction({ kind: "new", record: f.record }, f.env)).rejects.toThrow("session was not killed");
    expect(JSON.parse(readFileSync(f.registry, "utf8")).seats.seat).toEqual(before);
    expect(spawnSync(tmux, ["-S", f.socket, "has-session", "-t", `=${f.record.name}`]).status).toBe(0);
  } else {
    const outcome = await launchTransaction({ kind: "restart", record: f.record, incumbent_live: true }, f.env);
    expect(outcome.backup.status).toBe("unavailable");
    expect(JSON.parse(readFileSync(f.registry, "utf8")).seats.seat.status_reason).toBe("");
  }
}, 20_000);

async function until(predicate: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}

test("coordinator-kill releases the real reset holder after tmux descendants existed", async () => {
  const f = fixture("claude");
  writeFileSync(join(f.root, "bin/claude"), `#!/bin/sh\nprintf entered > '${f.root}/entered'\nexec /bin/sleep 600\n`);
  const request = JSON.stringify({ kind: "new", record: f.record });
  const source = `import {launchTransaction,withLaunchSignals} from ${JSON.stringify(resolve(import.meta.dir,"../src/launcher/transaction.ts"))};\nawait withLaunchSignals(signal => launchTransaction(JSON.parse(process.argv[2]), process.env, signal));\n`;
  const file = join(f.root, "coordinator.ts");
  writeFileSync(file, source);
  const argv = [process.execPath, file, request];
  const child = Bun.spawn(argv, { cwd: f.root, env: f.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const output = new Response(child.stdout).text(), errors = new Response(child.stderr).text();
  try {
    await until(() => existsSync(join(f.root, "entered")));
    expect(JSON.parse(readFileSync(f.registry, "utf8")).seats.seat.status_reason).toBe("launching");
    child.kill("SIGKILL");
    await child.exited;
    const { acquirePathLockAsync } = await import("../src/panelock");
    const lock = await acquirePathLockAsync(join(f.root, ".tap/bus/reset.fence.json.lock"), 4000);
    expect(lock).not.toBeNull();
    await lock!.release();

  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await Promise.all([output, errors]);
  }
}, 15_000);

let oracleRoot: string | undefined;
function pinnedOracle() {
  if (oracleRoot) return oracleRoot;
  const archive = resolve(import.meta.dir, "support/shared-launch/precut-source.tar.gz");
  const hash = new Bun.CryptoHasher("sha256").update(readFileSync(archive)).digest("hex");
  expect(hash).toBe("605677029296b9dc8e7eec71fab3f7b650ad9f4b75c11847c7e7702d74ba7846");
  oracleRoot = realpathSync(mkdtempSync(join(original.TAP_INDEX_HOME!, "precut-")));
  expect(spawnSync("tar", ["-xzf", archive, "-C", oracleRoot]).status).toBe(0);
  return oracleRoot;
}

function callerSnapshot(kind: string, harness: string, source: string) {
  const f = fixture(harness);
  const resumeId = "550e8400-e29b-41d4-a716-446655440000";
  if (["resume", "resume-all", "restart", "replacement", "seat-up"].includes(kind)) {
    const row = incumbent(f, { harness_session_id: resumeId, harness_env: f.record.harness_env, harness_tail: f.record.harness_tail });
    if (!["restart", "replacement"].includes(kind)) {
      spawnSync(tmux, ["-S", f.socket, "kill-session", "-t", `=${f.record.name}`], { env: f.env });
      const doc = JSON.parse(readFileSync(f.registry, "utf8"));
      doc.seats.seat.status = "suspended";
      doc.seats.seat.status_reason = "session_stopped";
      delete doc.seats.sibling;
      writeFileSync(f.registry, JSON.stringify(doc));
    }
    if (kind === "replacement") Object.assign(f.record, { replaces_session: f.record.name, kill_backup_required: true });
    else f.record.harness_session_id = resumeId;
    // The resume resolver's transcript evidence is real, isolated input.
    f.env.CLAUDE_CONFIG_DIR = join(f.root, ".claude"); f.env.CLAUDE_HOME = f.env.CLAUDE_CONFIG_DIR;
    const project = join(f.root, ".claude/projects", f.root.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${resumeId}.jsonl`), JSON.stringify({ type: "attachment", sessionId: resumeId, cwd: f.root }) + "\n");
    const rollout = join(f.root, ".codex/sessions/2026/09/22");
    mkdirSync(rollout, { recursive: true }); f.env.CODEX_HOME = join(f.root, ".codex");
    writeFileSync(join(rollout, `rollout-2026-09-22T00-00-00-${resumeId}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id: resumeId, cwd: f.root } }) + "\n");
    if (harness === "cursor") {
      // The cursor resume-artifact probe (tap-we6b rework) refuses a stored id
      // whose chat never persisted, so this cell gets real store.db evidence
      // under the worktree hash, like the claude/codex cells. The pinned
      // Python owner id-firsts the same stored id, so both sides resume
      // exactly and stay byte-identical.
      f.env.TAP_CURSOR_HOME = join(f.root, ".cursor");
      const chatDir = join(f.env.TAP_CURSOR_HOME, "chats", createHash("md5").update(f.root, "utf8").digest("hex"), resumeId);
      mkdirSync(chatDir, { recursive: true });
      writeFileSync(join(chatDir, "store.db"), "");
    }
  }
  // Candidate callers are native; the Python fixture reads only the pinned tree.
  const nativeLaunch = source === resolve(import.meta.dir, "../../..") && ["new", "replacement", "adopted", "resume", "resume-all", "restart", "seat-up"].includes(kind);
  const result = nativeLaunch
    ? spawnSync(process.execPath, [resolve(import.meta.dir, "support/shared-launch-native.ts"), JSON.stringify(f.record), kind], {
      cwd: f.root, env: f.env, encoding: "utf8", timeout: 20_000 })
    : spawnSync(original.TAP_PYTHON ?? "python3", ["-B", resolve(import.meta.dir, "support/shared-launch-caller.py"), source, kind, JSON.stringify(f.record)], {
      cwd: f.root, env: f.env, encoding: "utf8", timeout: 20_000 });
  expect(result.error?.message, result.stderr).toBeUndefined();
  const doc = JSON.parse(readFileSync(f.registry, "utf8"));
  for (const row of Object.values(doc.seats) as Record<string, unknown>[]) {
    // Only generated process identity/time differ between independent fixtures.
    for (const key of ["registered_at", "last_launched", "last_seen", "boot_id", "server_epoch", "server_socket", "instance", "pane_id", "pane"]) delete row[key];
  }
  const normalize = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll(f.root, "$ROOT"));
  return normalize({ code: result.status, registry: doc,
    argv: existsSync(join(f.root, "argv")) ? readFileSync(join(f.root, "argv"), "utf8") : null,
    env: existsSync(join(f.root, "env")) ? readFileSync(join(f.root, "env"), "utf8") : null,
    // Receipts are kept for the failure message while state/argv are compared.
    stdout: result.stdout, stderr: result.stderr });
}

test.each(["new", "adopted", "resume", "resume-all", "restart", "replacement", "seat-up"])("pinned pre-cut %s caller matches the shared owner across six harnesses", kind => {
  const oracle = pinnedOracle();
  const candidate = resolve(import.meta.dir, "../../..");
  for (const harness of ["claude", "codex", "opencode", "cursor", "agy", "hermes"]) {
    const before = callerSnapshot(kind, harness, oracle);
    const after = callerSnapshot(kind, harness, candidate);
    const { stdout: oldOut, stderr: oldErr, ...oldState } = before;
    const { stdout: newOut, stderr: newErr, ...newState } = after;
    // tap-we6b rework (driver-authorized deviation from the pinned Python
    // owner): a cursor resume-family argv no longer ends in the bare
    // `--resume` picker token — the native door refuses a stale cursor
    // identity upstream and emits nothing when the resolved identity is null.
    // Strip that one trailing token from the oracle side for exactly those
    // cells so the differential still pins every other byte. A live-id cell
    // is untouched: its token is followed by the id, so it is never last.
    const RESUME_FAMILY = new Set(["adopted", "resume", "resume-all", "restart", "seat-up"]);
    if (harness === "cursor" && RESUME_FAMILY.has(kind) && typeof oldState.argv === "string") {
      const lines = oldState.argv.split("\n");
      if (lines.length > 1 && lines[lines.length - 2] === "--resume" && lines[lines.length - 1] === "") lines.splice(lines.length - 2, 1);
      else if (lines[lines.length - 1] === "--resume") lines.pop();
      oldState.argv = lines.join("\n");
    }
    // Second deviation, same cells: an id-less cursor resume starts a fresh
    // conversation, so it is captured as launcher_new (as id-less OpenCode is),
    // not the oracle's untrusted_resume that quarantines the new SessionStart id.
    if (harness === "cursor" && RESUME_FAMILY.has(kind)) {
      for (const row of Object.values((oldState.registry as any).seats) as Record<string, any>[]) {
        if (row.identity_capture?.mode === "untrusted_resume" && !row.identity_capture.expected_harness_session_id) row.identity_capture.mode = "launcher_new";
      }
    }
    // Third deviation (tap-4tclq): a Codex resume by explicit id now names the
    // folder it starts in, `--cd <worktree>` right before the id, so a seat
    // relaunched into another folder never stops at Codex's folder-choice prompt.
    // The pinned owner predates it; splice that one pair into the oracle side at
    // the cells where the id follows `resume`, so every other byte stays pinned
    // and a candidate without the pair (or with it anywhere else) still fails.
    if (harness === "codex" && typeof oldState.argv === "string") {
      const lines = oldState.argv.split("\n"), at = lines.indexOf("550e8400-e29b-41d4-a716-446655440000");
      if (at > 0 && lines[at - 1] === "resume") {
        lines.splice(at, 0, "--cd", "$ROOT");
        oldState.argv = lines.join("\n");
      }
    }
    // Fourth deviation (tap-6c1me): Cursor and AGY permissions are now launcher-owned
    // like Claude's and Codex's, so a launched row records the resolved mode (the
    // default, bypass). The pinned owner never touched those rows' permissions, so
    // the fixture's seeded "auto" survives on its side. Splice exactly that one
    // value pair; any other permissions difference still fails the equality below.
    if (harness === "cursor" || harness === "agy") {
      const oldSeats = (oldState.registry as any).seats as Record<string, Record<string, unknown>>;
      for (const [name, row] of Object.entries((newState.registry as any).seats) as [string, Record<string, unknown>][]) {
        if (name === "sibling" || oldSeats[name]?.permissions !== "auto") continue;
        expect(row.permissions, JSON.stringify({ kind, harness, name })).toBe("bypass");
        oldSeats[name].permissions = "bypass";
      }
    }
    // The pre-cut oracle predates launch_tuning, which the candidate now stores
    // on the seat this transaction actually launches (named "seat", or after
    // the harness for "adopted"); the fixed "sibling" row it leaves untouched
    // must never gain it, so assert both the presence and the absence.
    for (const [name, row] of Object.entries((newState.registry as any).seats) as [string, Record<string, unknown>][]) {
      if (name === "sibling") { expect(row.launch_tuning, JSON.stringify({ kind, harness, name })).toBeUndefined(); continue; }
      if (after.code === 0 || "launch_tuning" in row) {
        expect(row.launch_tuning, JSON.stringify({ kind, harness, name })).toEqual({ model: null, effort: null, qualifiers: {}, environment: {} });
      }
      delete row.launch_tuning;
      // The oracle also predates launch_witness (launch-evidence.ts): a verified
      // launch promotes its launch_id there; an untouched sibling never gains it.
      if (name === "sibling" || !("launch_witness" in row)) continue;
      expect(row.launch_witness, JSON.stringify({ kind, harness, name })).toMatch(/^[0-9a-f-]{36}$/);
      expect(row.launch_id, JSON.stringify({ kind, harness, name })).toBeUndefined();
      delete row.launch_witness;
    }
    expect(newState, JSON.stringify({ kind, harness, oldOut, oldErr, newOut, newErr })).toEqual(oldState);
    expect(after.code, `${kind}/${harness}: ${newErr}`).toBe(kind === "seat-up" && harness === "hermes" ? 1 : 0);
  }
}, 180_000);

test.each(["owned", "changed-token", "changed-instance", "ready", "launching-bind", "changed-vessel"])("actual delayed failure worker: %s after coordinator exit", async variant => {
  const f = fixture("claude");
  const coordinator = join(f.root, "prepare.ts"), evidenceFile = join(f.root, "evidence.json"), report = join(f.root, "failure.txt");
  const modulePath = (name: string) => JSON.stringify(resolve(import.meta.dir, `../src/${name}.ts`));
  writeFileSync(coordinator, `
import {reserveTransaction,bindTransaction,parseVessel} from ${modulePath("launcher/transaction")};
import {selectCaller} from ${modulePath("selector")};
import {launchTmux} from ${modulePath("launcher/process")};
import {paneFacts} from ${modulePath("launcher/readiness")};
import {jsonDumpBytes} from ${modulePath("spool-publication")};
import {writeFileSync} from "node:fs";
const record = JSON.parse(process.argv[2]);
const selection = selectCaller({cwd: record.cwd, env: process.env, verbClass: "lifecycle"});
const evidence = { selection, handle: "seat", token: "", instance: null, record, vessel: null, backup: {status:"not-needed"}, reason:"restart_failed", output_path:${JSON.stringify(report)} };
await reserveTransaction(selection, {kind:"new",record}, evidence, process.env);
const created = await launchTmux(["new-session","-d","-s",record.name,"-P","-F","#{pid}:#{start_time}\\t#{session_id}\\t#{window_id}\\t#{pane_id}\\t#{pane_pid}\\t#{socket_path}","/bin/sleep 600"],process.env);
evidence.vessel = parseVessel(created.stdout);
await bindTransaction(evidence,await paneFacts(evidence.vessel.pane),false,process.env);
await launchTmux(["set-option","-p","-t",evidence.vessel.pane,"remain-on-exit","on"],process.env);
await launchTmux(["respawn-pane","-k","-t",evidence.vessel.pane,"echo fixture-failure; exit 17"],process.env);
writeFileSync(${JSON.stringify(evidenceFile)},jsonDumpBytes(evidence));
`);
  const prepared = spawnSync(process.execPath, [coordinator, JSON.stringify(f.record)], { cwd: f.root, env: f.env, encoding: "utf8", timeout: 10_000 });
  expect(prepared.status, prepared.stderr).toBe(0);
  const evidence = JSON.parse(readFileSync(evidenceFile, "utf8"));
  const doc = JSON.parse(readFileSync(f.registry, "utf8"));
  if (variant === "changed-token") doc.seats.seat.launch_id = "successor";
  if (variant === "changed-instance") doc.seats.seat.instance = "successor";
  if (variant === "ready") { delete doc.seats.seat.launch_id; doc.seats.seat.status_reason = ""; }
  if (variant === "changed-vessel") evidence.vessel.server = "0:0";
  writeFileSync(f.registry, JSON.stringify(doc));
  if (variant === "ready" || variant === "launching-bind") {
    await until(() => spawnSync(tmux, ["-S", f.socket, "display-message", "-p", "-t", evidence.vessel.pane, "#{pane_dead}"], { encoding: "utf8" }).stdout.trim() === "1");
    const stale = { ...(await paneFacts(evidence.vessel.pane, f.env))!, dead: false };
    await expect(bindTransaction(evidence, stale, true, f.env)).rejects.toThrow("harness is not running");
    expect(JSON.parse(readFileSync(f.registry, "utf8"))).toEqual(doc);
  }
  // The coordinator has exited. Invoke the exact installed callback door in a
  // separate process, with the serialized claim and created-vessel evidence.
  const callback = spawnSync(process.execPath, [resolve(import.meta.dir, "../src/launcher/worker.ts"), "failure", JSON.stringify(evidence)], {
    cwd: f.root, env: f.env, encoding: "utf8", timeout: 10_000,
  });
  expect(callback.status, callback.stderr).toBe(0);
  const after = JSON.parse(readFileSync(f.registry, "utf8"));
  if (variant === "owned" || variant === "launching-bind") {
    expect(after.seats).toEqual({});
    expect(readFileSync(report, "utf8")).toContain("fixture-failure");
    expect(readFileSync(report, "utf8")).toContain("exit 17");
    expect(spawnSync(tmux, ["-S", f.socket, "has-session", "-t", `=${f.record.name}`]).status).not.toBe(0);
  } else {
    expect(after).toEqual(doc);
    expect(existsSync(report)).toBe(false);
    expect(callback.stderr).toBe("");
    expect(spawnSync(tmux, ["-S", f.socket, "has-session", "-t", `=${f.record.name}`]).status).toBe(0);
  }
}, 20_000);

test("Cursor cancellation stops pre-mint before any registry claim", async () => {
  const f = fixture("cursor"), pidfile = join(f.root, "mint-pid");
  writeFileSync(join(f.root, "bin/cursor-agent"), `#!/bin/sh\necho $$ > '${pidfile}'\nexec /bin/sleep 30\n`);
  const script = join(f.root, "cancel.ts");
  writeFileSync(script, `import {launchTransaction,withLaunchSignals} from ${JSON.stringify(resolve(import.meta.dir,"../src/launcher/transaction.ts"))};\ntry { await withLaunchSignals(signal => launchTransaction(JSON.parse(process.argv[2]), process.env, signal)); } catch (error) { process.exitCode = error.exitCode ?? 1; }\n`);
  const child = Bun.spawn([process.execPath, script, JSON.stringify({kind:"new",record:f.record})], {
    cwd:f.root, env:f.env, stdin:"ignore", stdout:"pipe", stderr:"pipe",
  });
  const out = new Response(child.stdout).text(), err = new Response(child.stderr).text();
  try {
    await until(() => existsSync(pidfile));
    child.kill("SIGTERM");
    expect(await child.exited, await err).toBe(143);
    expect(JSON.parse(readFileSync(f.registry,"utf8")).seats).toEqual({});
    const pid = Number(readFileSync(pidfile,"utf8"));
    expect(() => process.kill(pid,0)).toThrow();
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited; await Promise.all([out,err]);
  }
});

test("post-stop authority drift leaves the new store untouched and never fabricates recovery without a bundle", async () => {
  const f = fixture("claude");
  incumbent(f);
  writeFileSync(join(f.root,".tap/backup"), "unwritable path fixture");
  const foreign = join(f.root,"foreign-registry.json");
  const untouched = JSON.stringify({schema:"0.20",team:{name:"fixture",worktree_root:f.root},seats:{foreign:{future:"untouched"}}});
  writeFileSync(foreign,untouched);
  const moved = join(f.root,"moved-index.json");
  writeFileSync(moved,JSON.stringify({schema:"0.20",teams:{fixture:{root:f.root,registry_location:foreign}}}));
  const shim = join(f.root,"bin/tmux");
  writeFileSync(shim, `#!/bin/sh\n'${tmux}' "$@"\nrc=$?\ncase " $* " in *' kill-session '*) /bin/cp '${moved}' '${f.root}/index/global-registry.json';; esac\nexit "$rc"\n`);
  chmodSync(shim,0o755);
  let message = "";
  try { await launchTransaction({kind:"restart",record:f.record,incumbent_live:true},f.env); }
  catch (error) {
    message = (error as Error).message;
    expect(error).toBeInstanceOf(RestartResumeFailure);
    expect((error as RestartResumeFailure).receipt).toMatchObject({ recovery_required: true, action: `cd ${f.root} && tap doctor`,
      resume_command: `cd ${f.root} && tap session resume seat` });
  }
  expect(message).toContain("rollback incomplete");
  expect(message).toContain("no durable recovery bundle is available");
  expect(message).toContain(f.registry);
  expect(message).not.toContain("tap restore");
  expect(readFileSync(foreign,"utf8")).toBe(untouched);
  expect(JSON.parse(readFileSync(f.registry,"utf8")).seats.seat.launch_id).toBeTruthy();
}, 20_000);

test("incumbent destructive-target truth table matches independent pre-cut rules", async () => {
  const oracle = pinnedOracle();
  const cases = [
    { name:"gone tip authorizes selected name", pane:null, members:"%1", expected:"fixture/seat" },
    { name:"different pane id refuses", pane:"fixture/seat:0.0\t%2\tclaude\t1:1\t0\t100\t/", members:"%1", expected:null },
    { name:"foreign session address refuses", pane:"foreign/seat:0.0\t%1\tclaude\t1:1\t0\t100\t/", members:"%1", expected:null },
    { name:"member census excludes the recorded pane", pane:"fixture/seat:0.0\t%1\tclaude\t1:1\t0\t100\t/", members:"%2", expected:null },
    { name:"matching frame authorizes", pane:"fixture/seat:0.0\t%1\tclaude\t1:1\t0\t100\t/", members:"%1", expected:"fixture/seat" },
    { name:"empty member census preserves incumbent fallback", pane:"fixture/seat:0.0\t%1\tclaude\t1:1\t0\t100\t/", members:"", expected:"fixture/seat" },
  ];
  for (const item of cases) {
    const f = fixture("claude");
    const shim = join(f.root,"bin/tmux");
    writeFileSync(join(f.root,"frame"), item.pane ?? ""); writeFileSync(join(f.root,"members"),item.members);
    writeFileSync(shim, `#!/bin/sh\ncase " $* " in *' has-session '*) exit 0;; *' display-message '*) ${item.pane === null ? "exit 1" : `/bin/cat '${f.root}/frame'`};; *' list-panes '*) /bin/cat '${f.root}/members';; *) exit 1;; esac\n`);
    chmodSync(shim,0o755);
    for (const source of [oracle]) {
      const result = spawnSync(original.TAP_PYTHON ?? "python3", ["-B","-c",'import sys,json; sys.path.insert(0,sys.argv[1]+"/skills/tap/scripts/session"); import launcher; entry={"session":"fixture/seat","pane_id":"%1"}; print(json.dumps(launcher.destructive_session_target(entry,"fixture/seat") if hasattr(launcher,"destructive_session_target") else launcher._launcher_bridge.call("confirmed-target",entry=entry,expected="fixture/seat")))',source], {cwd:f.root,env:f.env,encoding:"utf8",timeout:5000});
      expect(result.status,item.name+result.stderr).toBe(0);
      expect(JSON.parse(result.stdout),item.name).toBe(item.expected);
      expect(await destructiveTarget({ session: "fixture/seat", pane_id: "%1" }, "fixture/seat", f.env), item.name).toBe(item.expected);
    }
  }
});

test.each(["missing", "gone", "foreign", "unstamped"])("explicit-fresh uses the chosen name with a %s incumbent pane hint", async hint => {
  const f = fixture("claude");
  incumbent(f);
  const foreign = spawnSync(tmux,["-S",f.socket,"new-session","-d","-s","foreign","-P","-F","#{pane_id}","/bin/sleep 600"],{env:f.env,encoding:"utf8"});
  expect(foreign.status).toBe(0);
  const doc = JSON.parse(readFileSync(f.registry,"utf8"));
  if (hint === "missing") delete doc.seats.seat.pane_id;
  if (hint === "gone") doc.seats.seat.pane_id = "%999999";
  if (hint === "foreign") doc.seats.seat.pane_id = foreign.stdout.trim();
  if (hint === "unstamped") delete doc.seats.seat.session;
  writeFileSync(f.registry,JSON.stringify(doc));
  Object.assign(f.record,{replaces_session:f.record.name,kill_backup_required:true});
  const result = await launchTransaction({kind:"new",record:f.record},f.env);
  expect(result.code).toBe(0);
  expect(result.backup.status).toBe("backed-up");
  expect(spawnSync(tmux,["-S",f.socket,"has-session","-t","=foreign"]).status).toBe(0);
  expect(JSON.parse(readFileSync(f.registry,"utf8")).seats.seat.session).toBe(f.record.name);
},15000);

test("legacy transaction waits beyond both native reset and registry limits", async () => {
  const f = fixture("claude");
  const {acquirePathLockAsync} = await import("../src/panelock");
  const reset = await acquirePathLockAsync(join(f.root,".tap/bus/reset.fence.json.lock"));
  const registry = await acquirePathLockAsync(`${f.registry}.lock`);
  const start = Date.now();
  const releasing = Promise.all([
    Bun.sleep(1200).then(() => reset!.release()),
    Bun.sleep(6200).then(() => registry!.release()),
  ]);
  try {
    const result = await launchTransaction({kind:"new",record:f.record},f.env);
    expect(result.code).toBe(0);
    expect(Date.now()-start).toBeGreaterThanOrEqual(6200);
  } finally { await releasing; await reset!.release(); await registry!.release(); }
},15000);

test.each(["new", "restart"] as const)("%s failed incumbent stop restores full driver and sibling rows without a stopped stamp", async kind => {
  const f = fixture("claude");
  incumbent(f);
  const before = readFileSync(f.registry,"utf8").replace('"future":{"nested":["retained",17]}','"future":{"nested":["retained",17],"wide":9007199254740993123456789,"float":1.0}');
  writeFileSync(f.registry,before);
  const shim = join(f.root,"bin/tmux");
  writeFileSync(shim,`#!/bin/sh\ncase " $* " in *' kill-session '*) echo 'fixture stop refused' >&2; exit 9;; esac\nexec '${tmux}' "$@"\n`);
  chmodSync(shim,0o755);
  f.record.replaces_session = f.record.name;
  await expect(launchTransaction({kind,record:f.record,incumbent_live:true},f.env)).rejects.toThrow();
  const after = readFileSync(f.registry,"utf8");
  expect(JSON.parse(after)).toEqual(JSON.parse(before));
  expect(after).toContain('9007199254740993123456789');
  expect(after).toContain('1.0');
  expect(after).not.toContain('restart_failed');
  expect(spawnSync(tmux,["-S",f.socket,"has-session","-t",`=${f.record.name}`]).status).toBe(0);
},15000);

test("post-stop launch failure restores complete displaced metadata and exact numbers", async () => {
  const f = fixture("claude");
  const before = incumbent(f);
  const raw = readFileSync(f.registry,"utf8").replace('"future":{"nested":["retained",17]}','"future":{"nested":["retained",17],"wide":9007199254740993123456789,"float":1.0}');
  writeFileSync(f.registry,raw);
  writeFileSync(join(f.root,"bin/claude"),"#!/bin/sh\nexit 17\n");
  await expect(launchTransaction({kind:"restart",record:f.record,incumbent_live:true},f.env)).rejects.toThrow();
  const after = readFileSync(f.registry,"utf8"), row = JSON.parse(after).seats.seat;
  expect(row).toEqual({...JSON.parse(raw).seats.seat,status:"suspended",status_reason:"restart_failed"});
  expect(after).toContain('9007199254740993123456789'); expect(after).toContain('1.0');
  expect(row.instance).toBe(before.instance);
  expect(row.launch_id).toBeUndefined();
},15000);

test("post-kill restart failure carries the retained recipe and manual recovery without a retry", async () => {
  const f = fixture("claude");
  incumbent(f, { harness_session_id: "prior-conversation" });
  f.record.harness_session_id = "prior-conversation";
  writeFileSync(join(f.root, "bin/claude"), `#!/bin/sh\nprintf 'attempt\n' >> '${f.root}/attempts'\nexit 17\n`);
  const result = spawnSync(process.execPath, [resolve(import.meta.dir, "../src/launcher/session-doors.ts"), "restart", "seat", "--force", "--json"],
    { cwd: f.root, env: f.env, encoding: "utf8", timeout: 12000 });
  expect(result.status, result.stderr).toBe(1);
  const receipt = JSON.parse(result.stdout);
  expect(receipt).toMatchObject({ ok: false, error_class: "restart_resume_failed", killed_session: f.record.name,
    record: { name: f.record.name, harness_session_id: "prior-conversation" } });
  expect(receipt.action).toBe(`cd ${f.root} && tap session resume seat`);
  expect(existsSync(receipt.stored_record_path)).toBe(true);
  expect(JSON.parse(readFileSync(receipt.stored_record_path, "utf8")).record.harness_session_id).toBe("prior-conversation");
  expect(readFileSync(join(f.root, "attempts"), "utf8")).toBe("attempt\n");
}, 15000);

test.each(["new", "exact", "picker", "opencode-picker", "cursor-fresh", "family-change"])("claim preserves recipe and %s capture provenance", async mode => {
  const f = fixture(mode === "opencode-picker" ? "opencode" : mode === "cursor-fresh" ? "cursor" : "claude");
  const { reserveTransaction, recordFromRow } = await import("../src/launcher/transaction");
  const { selectCaller } = await import("../src/selector");
  Object.assign(f.record, { harness_session_id: ["new","exact"].includes(mode) ? "native-id" : null,
    transcript_path:"/old/transcript", quarantined_harness_session_id:"quarantined", quarantined_transcript_path:"/quarantined", identity_quarantine_reason:"mismatch",
    adopted_from_manual:true,passthrough_from_config:true,harness_passthrough:["--literal"],harness_unset_env:["OLD"],history:["old-id"],
    preset:{name:"fixture",source_path:"/fixture/config",config_digest:"sha256:fixture"},last_seen:"2026-01-01T00:00:00Z" });
  if (mode === "family-change") {
    const doc = JSON.parse(readFileSync(f.registry,"utf8"));
    doc.seats.seat = {status:"suspended",session:f.record.name,harness:"codex",harness_session_id:"old-native",transcript_path:"/old",future:"retain"};
    writeFileSync(f.registry,JSON.stringify(doc)); f.record.transcript_path = null;
  }
  const selection = selectCaller({cwd:f.root,env:f.env,verbClass:"lifecycle"});
  const evidence = { selection,handle:"seat",token:"",instance:null,record:f.record,vessel:null,backup:{status:"not-needed"} as const,reason:"restart_failed",output_path:"" };
  const kind = mode === "new" ? "new" : "resume";
  await reserveTransaction(selection,{kind,record:f.record},evidence,f.env);
  const doc = JSON.parse(readFileSync(selection.registryLocation,"utf8"));
  const row = doc.seats.seat;
  expect(row.identity_capture).toEqual({mode:kind === "new" || mode === "opencode-picker" || mode === "cursor-fresh" ? "launcher_new" : mode === "exact" ? "exact_resume" : "untrusted_resume",...(f.record.harness_session_id ? {expected_harness_session_id:f.record.harness_session_id}:{})});
  expect(row.history).toEqual(["old-id"]); expect(row.harness_env).toEqual(f.record.harness_env);
  expect(row.harness_unset_env).toEqual(["OLD"]); expect(row.passthrough).toEqual(["--literal"]);
  expect(row.preset).toEqual(f.record.preset); expect(row.quarantined_harness_session_id).toBe("quarantined");
  expect(row.registered_from_worktree).toBe(f.root);
  expect(recordFromRow("seat",row,doc.team,f.root)?.harness_tail).toEqual(f.record.harness_tail);
  if (mode === "family-change") { expect(row.harness_session_id).toBeUndefined(); expect(row.transcript_path).toBeUndefined(); expect(row.future).toBe("retain"); }
});

test("a claim against an agents-axis store is refused and leaves it untouched", async () => {
  const f = fixture("claude");
  const { selectCaller } = await import("../src/selector");
  const old = JSON.stringify({team:{name:"fixture",worktree_root:f.root},agents:{}});
  writeFileSync(f.registry,old);
  // C4a: selection refuses the old store before any claim can be reserved.
  let refused: unknown = null;
  try { selectCaller({cwd:f.root,env:f.env,verbClass:"lifecycle"}); } catch (error) { refused = error; }
  expect((refused as { errorClass?: string } | null)?.errorClass).toBe("old_store");
  expect(readFileSync(f.registry,"utf8")).toBe(old);
});

test("failure hook and bound launching row precede the first harness instruction", async () => {
  const f = fixture("claude");
  writeFileSync(join(f.root,"bin/claude"), `#!/bin/sh\n'${tmux}' -S '${f.socket}' show-hooks -p -t "$TMUX_PANE" > '${f.root}/hook'\n/bin/cp '${f.registry}' '${f.root}/bound'\nexec '${f.root}/real/claude' 600\n`);
  const result = await launchTransaction({kind:"new",record:f.record},f.env);
  expect(result.code).toBe(0);
  expect(readFileSync(join(f.root,"hook"),"utf8")).toContain("pane-died");
  const bound = JSON.parse(readFileSync(join(f.root,"bound"),"utf8")).seats.seat;
  expect(bound.status_reason).toBe("launching"); expect(bound.launch_id).toBeTruthy(); expect(bound.pane_id).toMatch(/^%\d+$/);
});

test("PTY launch keeps termios, sees settled phase lines, and attaches only after another process can lock reset", () => {
  const f = fixture("claude"), script = join(f.root, "pty-test.py");
  // new.ts on a real terminal, end to end: a pass-through tmux intercepts only
  // the attach, and there checks what the caller's terminal and locks look like.
  writeFileSync(join(f.root, "bin/tmux"), `#!/bin/sh
case " $* " in
  *" attach-session "*)
    stty -g > '${f.root}/stty.after'
    cmp -s '${f.root}/stty.before' '${f.root}/stty.after' || { echo 'termios changed before attach'; exit 91; }
    ${original.TAP_PYTHON ?? "python3"} -c 'import fcntl,sys; f=open(sys.argv[1],"a"); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)' '${f.root}/.tap/bus/reset.fence.json.lock' || exit 92
    ${original.TAP_PYTHON ?? "python3"} -c 'import json,sys; assert json.load(open(sys.argv[1]))["seats"]["seat"]["status_reason"]==""' '${f.registry}' || exit 93
    echo ATTACH_AFTER_RELEASE
    exit 0 ;;
esac
exec '${tmux}' "$@"
`);
  chmodSync(join(f.root, "bin/tmux"), 0o755);
  writeFileSync(script, String.raw`
import errno, os, pathlib, pty, select, subprocess, sys, time
root = pathlib.Path(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    (root / "stty.before").write_bytes(subprocess.run(["stty", "-g"], check=True, capture_output=True).stdout)
    os.execvp("bun", ["bun", sys.argv[2], "claude", "seat", "--attach"])
data = bytearray(); deadline = time.monotonic() + 12
while time.monotonic() < deadline:
    if select.select([fd], [], [], 0.1)[0]:
        try: part = os.read(fd, 65536)
        except OSError as error:
            if error.errno != errno.EIO: raise
            break
        if not part: break
        data.extend(part)
else:
    os.kill(pid, 9); raise AssertionError("PTY child timed out")
_, status = os.waitpid(pid, 0)
os.close(fd)
assert os.waitstatus_to_exitcode(status) == 0, data.decode(errors="replace")
# The launch door's phase lines replace the old one-line "starting" progress:
# at least one phase settles to a check mark, and every spinner frame is
# settled before the terminal is handed to attach.
assert b"starting 'fixture/seat'..." not in data, data
assert "\u2713 ".encode() in data, data
# The final readiness step keeps its check mark however fast the bind landed.
assert "\u2713 Marking ".encode() in data, data
assert b"ATTACH_AFTER_RELEASE" in data, data
frames = [data.rfind(ch.encode()) for ch in "\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f"]
assert max(frames) < data.find(b"ATTACH_AFTER_RELEASE"), data
print("PTY and attach custody passed")
`);
  // The phase spinner is off for TERM=dumb, which is what smoke-all and the full gate admit; this test asserts the
  // drawn ✓ lines, so it asks for a terminal that animates.
  const result = spawnSync(original.TAP_PYTHON ?? "python3", ["-B", script, f.root, resolve(import.meta.dir, "../src/launcher/new.ts")],
    { cwd: f.root, env: { ...f.env, TERM: "xterm-256color" }, encoding: "utf8", timeout: 15000 });
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(JSON.parse(readFileSync(f.registry, "utf8")).seats.seat.status_reason).toBe("");
  expect(spawnSync(tmux, ["-S", f.socket, "has-session", "-t", `=${f.record.name}`]).status).toBe(0);
}, 20000);

test("late zero-result Codex screen after healthy frames never becomes ready", async () => {
  const f=fixture("codex");
  f.record.harness_session_id="550e8400-e29b-41d4-a716-446655440000";
  writeFileSync(join(f.root,"bin/codex"),`#!/bin/sh\n(/bin/sleep 0.4; printf 'No results for your search\\n0 / 0\\n') &\nexec '${f.root}/real/codex' 600\n`);
  await expect(launchTransaction({kind:"resume",record:f.record},f.env)).rejects.toThrow("zero results");
  expect(JSON.parse(readFileSync(f.registry,"utf8")).seats).toEqual({});
},10000);

test("registry custody spans incumbent stop and is released while readiness retains reset custody",async()=>{
  const f=fixture("claude"); incumbent(f);
  const check=join(f.root,"locks.py");
  writeFileSync(check,String.raw`
import fcntl,json,pathlib,sys
root=pathlib.Path(sys.argv[1]); stage=sys.argv[2]
for name,path,want in [("registry",root/".tap/team-registry.json.lock",stage=="stop"),("reset",root/".tap/bus/reset.fence.json.lock",True)]:
    with path.open("a") as stream:
        try: fcntl.flock(stream,fcntl.LOCK_EX|fcntl.LOCK_NB); held=False
        except BlockingIOError: held=True
    assert held==want,(stage,name,held,want)
if stage=="stop":
    rows=json.loads((root/".tap/team-registry.json").read_text())["seats"]
    assert rows["seat"]["status"]=="pending"
    assert rows["sibling"]["status_reason"]=="session_restarted"
(root/(stage+"-verified")).write_text("yes")
`);
  const python=Bun.which(original.TAP_PYTHON??"python3")!;
  writeFileSync(join(f.root,"bin/tmux"),`#!/bin/sh\ncase " $* " in *' kill-session '*) '${python}' '${check}' '${f.root}' stop || exit 97;; esac\nexec '${tmux}' "$@"\n`,{mode:0o755});
  writeFileSync(join(f.root,"bin/claude"),`#!/bin/sh\n'${python}' '${check}' '${f.root}' readiness || exit 98\nexec '${f.root}/real/claude' 600\n`);
  expect((await launchTransaction({kind:"restart",record:f.record,incumbent_live:true},f.env)).code).toBe(0);
  expect(readFileSync(join(f.root,"stop-verified"),"utf8")).toBe("yes");
  expect(readFileSync(join(f.root,"readiness-verified"),"utf8")).toBe("yes");
});

test("SIGTERM followed by EOF and SIGINT during unwind keeps one cleanup and both locks",async()=>{
  const f=fixture("claude"), reached=join(f.root,"cleanup-reached"), release=join(f.root,"cleanup-release");
  writeFileSync(join(f.root,"bin/claude"),`#!/bin/sh\necho entered > '${f.root}/entered'\nexec /bin/sleep 600\n`);
  writeFileSync(join(f.root,"bin/tmux"),`#!/bin/sh\ncase " $* " in *'kill-session -t'*) echo cleanup >> '${reached}'; while [ ! -f '${release}' ]; do /bin/sleep 0.02; done;; esac\nexec '${tmux}' "$@"\n`,{mode:0o755});
  const {spawn}=await import("node:child_process");
  const child=spawn(process.execPath,[resolve(import.meta.dir,"../src/launcher/worker.ts"),"bridge","3"],{cwd:f.root,env:f.env,stdio:["pipe","pipe","pipe","pipe"]});
  let result="",stderr="";
  child.stdout!.resume();child.stderr!.on("data",data=>stderr+=data);
  (child.stdio[3] as import("node:stream").Readable).on("data",data=>result+=data);
  const completed=new Promise(resolve=>child.once("close",resolve));
  child.stdin!.write(JSON.stringify({op:"transaction",payload:{kind:"new",record:f.record}})+"\n");
  try{
    await until(()=>existsSync(join(f.root,"entered")));
    child.kill("SIGTERM");await until(()=>existsSync(reached));
    child.stdin!.end();child.kill("SIGINT");
    const {acquirePathLockAsync}=await import("../src/panelock");
    expect(await acquirePathLockAsync(`${f.registry}.lock`,0)).toBeNull();
    expect(await acquirePathLockAsync(join(f.root,".tap/bus/reset.fence.json.lock"),0)).toBeNull();
    writeFileSync(release,"go");
    expect(await completed,stderr).toBe(0);
    expect(JSON.parse(result).error).toMatchObject({kind:"interrupted",code:143});
    expect(readFileSync(reached,"utf8")).toBe("cleanup\n");
    expect(JSON.parse(readFileSync(f.registry,"utf8")).seats).toEqual({});
  }finally{
    writeFileSync(release,"go");
    if(child.exitCode===null)child.kill("SIGTERM");
    await completed;
  }
},15000);

test.each(["missing-native","removed","crew","poll","hermes","instance-drift","recipe-drift","relocated","live-vessel"])("seat-up %s refuses before changing its selected row",async mode=>{
  const f=fixture("codex");
  const row:Record<string,unknown>={status:"suspended",status_reason:"session_stopped",delivery:"pane",session:f.record.name,harness:"codex",harness_session_id:"native-id",instance:"original",registered_from_worktree:f.root};
  if(mode==="missing-native")delete row.harness_session_id;
  if(mode==="removed")row.status_reason="user_removed";
  if(mode==="crew")row.crew=true;
  if(mode==="poll")row.delivery="poll";
  if(mode==="hermes")row.harness="hermes";
  const expected={...row};
  if(mode==="instance-drift")row.instance="successor";
  if(mode==="recipe-drift")row.passthrough=["--changed"];
  const doc=JSON.parse(readFileSync(f.registry,"utf8"));doc.seats.seat=row;
  writeFileSync(f.registry,JSON.stringify(doc));const before=readFileSync(f.registry,"utf8");
  if(mode==="live-vessel")expect(spawnSync(tmux,["-S",f.socket,"new-session","-d","-s",f.record.name,"/bin/sleep 600"],{env:f.env}).status).toBe(0);
  const selection=(await import("../src/selector")).selectCaller({cwd:f.root,env:f.env,verbClass:"lifecycle"});
  if(mode==="relocated")selection.registryLocationReal=join(f.root,"elsewhere.json");
  const {resumeSelectedSeat}=await import("../src/launcher/transaction");
  await expect(resumeSelectedSeat(selection,"seat",expected,f.env)).rejects.toThrow();
  expect(readFileSync(f.registry,"utf8")).toBe(before);
},10000);

test("native bind stamps the observed epoch and current boot; ready drops an unavailable boot",async()=>{
  const f=fixture("claude");
  const {reserveTransaction,bindTransaction,parseVessel}=await import("../src/launcher/transaction");
  const {paneFacts}=await import("../src/launcher/readiness");
  const selection=(await import("../src/selector")).selectCaller({cwd:f.root,env:f.env,verbClass:"lifecycle"});
  const evidence:import("../src/launcher/transaction").FailureEvidence={selection,handle:"seat",token:"",instance:null,record:f.record,vessel:null,backup:{status:"not-needed"},reason:"repair_failed",output_path:""};
  await reserveTransaction(selection,{kind:"new",record:f.record},evidence,{...f.env,TAP_BOOT_ID:"boot:123"});
  const created=spawnSync(tmux,["-S",f.socket,"new-session","-d","-s",f.record.name,"-P","-F","#{pid}:#{start_time}\t#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_pid}\t#{socket_path}",`exec '${f.root}/real/claude' 600`],{env:f.env,encoding:"utf8"});
  evidence.vessel=parseVessel(created.stdout);
  const facts=await paneFacts(evidence.vessel!.pane,f.env);
  const pending = readFileSync(f.registry,"utf8");
  await expect(bindTransaction(evidence,{...facts!,server_epoch:"srv:0:0"},false,f.env)).rejects.toThrow("generation moved");
  expect(readFileSync(f.registry,"utf8")).toBe(pending);
  await bindTransaction(evidence,facts!,false,{...f.env,TAP_BOOT_ID:"boot:456"});
  let row=JSON.parse(readFileSync(f.registry,"utf8")).seats.seat;
  expect(row.server_epoch).toBe(`srv:${evidence.vessel!.server}`);expect(row.boot_id).toBe("boot:456");
  // tap-zk1w: an unobservable generation refuses rather than writing an unstamped row.
  const stamped = readFileSync(f.registry,"utf8");
  const unstamped = await bindTransaction(evidence,{...facts!,server_epoch:""},true,{...f.env,TAP_BOOT_ID:""}).then(() => null, error => error);
  expect(unstamped).toMatchObject({ tapErrorClass: "generation_unverifiable", tapAction: "wait for tmux to answer, then retry" });
  const { render } = await import("../src/launcher/resume-prelude");
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    expect(render(unstamped, true)).toBe(1);
    expect(JSON.parse(String(stdout.mock.calls[0]![0]))).toMatchObject({ error_class: "generation_unverifiable", action: "wait for tmux to answer, then retry" });
    expect(render(unstamped, false)).toBe(1);
  } finally { stdout.mockRestore(); stderr.mockRestore(); }
  expect(readFileSync(f.registry,"utf8")).toBe(stamped);
  // The ready transition still drops an unavailable boot stamp and keeps the generation.
  await bindTransaction(evidence,facts!,true,{...f.env,TAP_BOOT_ID:""});
  row=JSON.parse(readFileSync(f.registry,"utf8")).seats.seat;
  expect(row.boot_id).toBeUndefined();expect(row.status_reason).toBe("");
  expect(row.server_epoch).toBe(`srv:${evidence.vessel!.server}`);
});

// launch_witness lifecycle across a respawn. Reserving a new incarnation
// clears the outgoing witness; the ready bind promotes the new launch_id.
test("a resume reservation clears the old launch_witness and the ready bind promotes the new launch_id",async()=>{
  const f=fixture("claude");
  const {reserveTransaction,bindTransaction,parseVessel}=await import("../src/launcher/transaction");
  const {paneFacts}=await import("../src/launcher/readiness");
  f.record.harness_session_id="native-id";
  const doc=JSON.parse(readFileSync(f.registry,"utf8"));
  doc.seats.seat={status:"suspended",session:f.record.name,harness:"claude",harness_session_id:"native-id",launch_witness:"old-incarnation"};
  writeFileSync(f.registry,JSON.stringify(doc));
  const selection=(await import("../src/selector")).selectCaller({cwd:f.root,env:f.env,verbClass:"lifecycle"});
  const evidence:import("../src/launcher/transaction").FailureEvidence={selection,handle:"seat",token:"",instance:null,record:f.record,vessel:null,backup:{status:"not-needed"},reason:"repair_failed",output_path:""};
  await reserveTransaction(selection,{kind:"resume",record:f.record},evidence,f.env);
  let row=JSON.parse(readFileSync(f.registry,"utf8")).seats.seat;
  expect(row.launch_witness).toBeUndefined();
  expect(row.launch_id).toBe(evidence.token);
  const created=spawnSync(tmux,["-S",f.socket,"new-session","-d","-s",f.record.name,"-P","-F","#{pid}:#{start_time}\t#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_pid}\t#{socket_path}",`exec '${f.root}/real/claude' 600`],{env:f.env,encoding:"utf8"});
  evidence.vessel=parseVessel(created.stdout);
  const facts=await paneFacts(evidence.vessel!.pane,f.env);
  await bindTransaction(evidence,facts!,false,f.env);
  row=JSON.parse(readFileSync(f.registry,"utf8")).seats.seat;
  expect(row.launch_witness).toBeUndefined();
  await bindTransaction(evidence,facts!,true,f.env);
  row=JSON.parse(readFileSync(f.registry,"utf8")).seats.seat;
  expect(row.launch_id).toBeUndefined();
  expect(row.launch_witness).toBe(evidence.token);
  expect(row.launch_token).toBeUndefined();
});

test("compiled launch and up use installed companion paths and a real Bun callback",()=>{
  const f=fixture("claude"),repo=resolve(import.meta.dir,"../../..");
  // Capture the failure callback while startup owns it; readiness retires it.
  writeFileSync(join(f.root,"bin/claude"), `#!/bin/sh\n'${tmux}' -S '${f.socket}' show-hooks -p -t "$TMUX_PANE" > '${f.root}/hook'\nexec '${f.root}/real/claude' 600\n`);
  const layout=mkdtempSync(join(original.TAP_INDEX_HOME!,"compiled-launch-"));
  mkdirSync(join(layout,"runtime/bun"),{recursive:true});mkdirSync(join(layout,"skills/tap"),{recursive:true});
  symlinkSync(join(repo,"skills/tap/scripts"),join(layout,"skills/tap/scripts"),"dir");
  symlinkSync(join(repo,"runtime/bun/src"),join(layout,"runtime/bun/src"),"dir");
  const binary=join(layout,"runtime/bun/tap-fixture");
  const built=spawnSync(process.execPath,["build","--compile",join(repo,"runtime/bun/main.ts"),"--outfile",binary],{env:f.env,encoding:"utf8",timeout:60000});
  expect(built.status,built.stderr).toBe(0);
  const doc=JSON.parse(readFileSync(f.registry,"utf8"));
  doc.seats.seat={status:"suspended",status_reason:"session_stopped",delivery:"pane",session:f.record.name,harness:"claude",harness_session_id:"native-id",instance:"original",registered_from_worktree:f.root};
  writeFileSync(f.registry,JSON.stringify(doc));
  const up=spawnSync(binary,["up","seat","--json"],{cwd:f.root,env:f.env,encoding:"utf8",timeout:20000});
  expect(up.status,up.stderr+up.stdout).toBe(0);
  const row=JSON.parse(readFileSync(f.registry,"utf8")).seats.seat;
  expect(row.status_reason).toBe("");
  const hook=readFileSync(join(f.root,"hook"),"utf8");
  expect(hook).toContain(join(layout,"runtime/bun/src/launcher/worker.ts"));
  expect(hook).not.toContain(binary);
  const readyHooks=spawnSync(tmux,["-S",f.socket,"show-hooks","-p","-t",row.pane_id],{env:f.env,encoding:"utf8"});
  expect(readyHooks.status,readyHooks.stderr).toBe(0);
  expect(readyHooks.stdout).not.toContain("pane-died");
  const launch=spawnSync(binary,["session","launch","claude","second","--json"],{cwd:f.root,env:f.env,encoding:"utf8",timeout:20000});
  expect(launch.status,launch.stderr+launch.stdout).toBe(0);
  expect(JSON.parse(readFileSync(f.registry,"utf8")).seats.second.status_reason).toBe("");
},65000);

test("keeper token drift is refused under the stop lock and preserves the successor",async()=>{
  const f=fixture("claude");incumbent(f);f.record.replaces_session=f.record.name;
  const {reserveTransaction,suspendAndStop,rollbackOwned}=await import("../src/launcher/transaction");
  const {acquirePathLockAsync}=await import("../src/panelock");
  const selection=(await import("../src/selector")).selectCaller({cwd:f.root,env:f.env,verbClass:"lifecycle"});
  const evidence:import("../src/launcher/transaction").FailureEvidence={selection,handle:"seat",token:"",instance:null,record:f.record,vessel:null,backup:{status:"not-needed"},reason:"restart_failed",output_path:""};
  const request={kind:"restart" as const,record:f.record,incumbent_live:true};
  const reset=await acquirePathLockAsync(join(f.root,".tap/bus/reset.fence.json.lock"));
  try{
    await reserveTransaction(selection,request,evidence,f.env);
    const doc=JSON.parse(readFileSync(f.registry,"utf8"));doc.seats.seat.launch_id="successor";writeFileSync(f.registry,JSON.stringify(doc));
    const before=readFileSync(f.registry,"utf8");
    const stop={attempted:false,killed:false,uncertain:false,adoptedShell:false};
    await expect(suspendAndStop(evidence,request,stop,f.env)).rejects.toThrow("reservation changed");
    expect(stop.attempted).toBe(false);expect(await rollbackOwned(evidence,"restart_failed",f.env,true)).toBe(false);
    expect(readFileSync(f.registry,"utf8")).toBe(before);
    expect(spawnSync(tmux,["-S",f.socket,"has-session","-t",`=${f.record.name}`]).status).toBe(0);
  }finally{await reset!.release();}
});

test("native bind refuses an enrolled foreign claim before publishing active or consuming its pending mail", async () => {
  const f = fixture("claude");
  const { reserveTransaction, parseVessel } = await import("../src/launcher/transaction");
  const selection = (await import("../src/selector")).selectCaller({ cwd: f.root, env: f.env, verbClass: "lifecycle" });
  const evidence: import("../src/launcher/transaction").FailureEvidence = { selection, handle: "seat", token: "", instance: null,
    record: f.record, vessel: null, backup: { status: "not-needed" }, reason: "repair_failed", output_path: "" };
  await reserveTransaction(selection, { kind: "new", record: f.record }, evidence, f.env);
  const created = spawnSync(tmux, ["-S", f.socket, "new-session", "-d", "-s", f.record.name, "-c", f.root, "-P", "-F",
    "#{pid}:#{start_time}\t#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_pid}\t#{socket_path}", "/bin/sleep 600"],
    { env: f.env, encoding: "utf8" });
  expect(created.status).toBe(0);
  evidence.vessel = parseVessel(created.stdout);
  const facts = await paneFacts(evidence.vessel!.pane, f.env);
  expect(facts).not.toBeNull();
  const other = join(f.root, "other.json");
  writeFileSync(other, JSON.stringify({ schema: "0.20", team: { name: "other" }, seats: { incumbent: {
    status: "active", delivery: "pane", pane: facts!.pane, pane_id: facts!.pane_id,
    server_epoch: facts!.server_epoch, server_socket: f.socket, instance: "incumbent|kept",
    session: f.record.name, harness: "claude",
  } } }));
  const index = join(f.root, "index", "global-registry.json");
  const machine = JSON.parse(readFileSync(index, "utf8"));
  const otherRoot = join(f.root, "other-root");
  machine.teams.other = { root: otherRoot, registry_location: other, state: "registered" };
  writeFileSync(index, JSON.stringify(machine));
  mkdirSync(join(otherRoot, ".tap/bus/payloads"), { recursive: true });
  const mail = join(otherRoot, ".tap/bus/payloads/pending-mail.md");
  writeFileSync(mail, "---\nid: pending\nto: incumbent\nrecipient_instance: incumbent|kept\n---\nretain custody\n");
  const before = [readFileSync(f.registry, "utf8"), readFileSync(other, "utf8"), readFileSync(mail, "utf8")];
  const refusal = await bindTransaction(evidence, facts!, false, f.env).then(() => null, error => error);
  const action = "keep the existing enrollment, or remove the wrong row with tap out other/incumbent";
  expect(refusal).toMatchObject({ tapErrorClass: "pane_enrolled_elsewhere", tapAction: action });
  const { render } = await import("../src/launcher/resume-prelude");
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    expect(render(refusal, true)).toBe(2);
    expect(JSON.parse(String(stdout.mock.calls[0]![0]))).toMatchObject({ error_class: "pane_enrolled_elsewhere", action });
    expect(render(refusal, false)).toBe(2);
    const diagnostic = stderr.mock.calls.map(call => String(call[0])).join("");
    expect(diagnostic).toContain("next: " + action);
    expect(diagnostic).not.toContain("tap help session");
    expect(diagnostic.match(/next:/g)).toHaveLength(1);
  } finally { stdout.mockRestore(); stderr.mockRestore(); }
  expect([readFileSync(f.registry, "utf8"), readFileSync(other, "utf8"), readFileSync(mail, "utf8")]).toEqual(before);
  expect(JSON.parse(readFileSync(f.registry, "utf8")).seats.seat.status).toBe("pending");
});

// tap-2qrt: a discarded validation build must not print the resume-target
// receipts; the real invocation build prints each exactly once per launch.
const PICKER_RECEIPT = "tap session: no verified resume transcript; falling through to id-less harness picker";
async function pickerReceiptsPrinted(body: () => Promise<unknown>): Promise<number> {
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  try { await body(); return stderr.mock.calls.map(call => String(call[0])).join("").split("\n").filter(line => line === PICKER_RECEIPT).length; }
  finally { stderr.mockRestore(); }
}

test.each([true, false])("restart prints the picker receipt once (dry_run=%p)", async dryRun => {
  const f = fixture("claude");
  incumbent(f);
  const { restartSession } = await import("../src/launcher/restart");
  const count = await pickerReceiptsPrinted(() => restartSession({ key: "seat", force: true, dryRun, json: false }, f.root, {
    live: async () => true, state: () => "idle-at-prompt",
    run: async (record, live) => (await launchTransaction({ kind: "restart", record, incumbent_live: live, preflight_done: true, dry_run: dryRun }, f.env)).code,
  }));
  expect(count).toBe(1);
}, 20_000);

test.each([true, false])("resurrect-new prints the picker receipt once (dry_run=%p)", async dryRun => {
  const f = fixture("claude");
  Object.assign(process.env, f.env);
  f.record.ensure_action = "resume";
  const count = await pickerReceiptsPrinted(async () => { expect((await launchTransaction({ kind: "new", record: f.record, dry_run: dryRun }, f.env)).code).toBe(0); });
  expect(count).toBe(1);
}, 20_000);

test("two independent resurrect launches each print their own picker receipt", async () => {
  const f = fixture("claude");
  Object.assign(process.env, f.env);
  f.record.ensure_action = "resume";
  const count = await pickerReceiptsPrinted(async () => {
    for (let launch = 0; launch < 2; launch++) await launchTransaction({ kind: "new", record: structuredClone(f.record), dry_run: true }, f.env);
  });
  expect(count).toBe(2);
}, 20_000);

test.each([true, false])("a transaction-level restart prints the picker receipt once (dry_run=%p)", async dryRun => {
  const f = fixture("claude");
  incumbent(f);
  const count = await pickerReceiptsPrinted(async () => { expect((await launchTransaction({ kind: "restart", record: f.record, incumbent_live: true, dry_run: dryRun }, f.env)).code).toBe(0); });
  expect(count).toBe(1);
}, 20_000);

test.each([true, false])("a plain resume prints the picker receipt once (dry_run=%p)", async dryRun => {
  const f = fixture("claude");
  Object.assign(process.env, f.env);
  const count = await pickerReceiptsPrinted(async () => { expect((await launchTransaction({ kind: "resume", record: f.record, dry_run: dryRun }, f.env)).code).toBe(0); });
  expect(count).toBe(1);
}, 20_000);
