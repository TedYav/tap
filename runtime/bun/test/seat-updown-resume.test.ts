import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { removeScratchTree } from "./support/scratch";

const repo = resolve(import.meta.dir, "../../..");
const realTmux = Bun.which("tmux")!;
const roots: string[] = [];
const cleanupSockets: { env: NodeJS.ProcessEnv; path: string }[] = [];
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
function tm(env: NodeJS.ProcessEnv, path: string, ...args: string[]) {
  return spawnSync(realTmux, ["-S", path, ...args], { env, encoding: "utf8" });
}
afterEach(() => {
  for (const { env, path } of cleanupSockets.splice(0)) tm(env, path, "kill-server");
  for (const root of roots.splice(0)) removeScratchTree(root);
});
function fixture(harness: "codex" | "claude" | "cursor") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tap-up-resume.")));
  roots.push(root);
  const index = join(root, "index");
  const bus = join(root, ".tap/bus");
  const registry = join(root, ".tap/team-registry.json");
  for (const path of [index, bus, join(root, ".config/tap"), join(root, "bin"), join(root, "real")]) mkdirSync(path, { recursive: true });
  const socket = `up-resume-${process.pid}-${roots.length}`;
  if (!process.env.TMUX_TMPDIR) throw new Error("run through runtime/bun/test/run.sh");
  const socketDir = join(process.env.TMUX_TMPDIR, `tmux-${process.getuid!()}`);
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  const socketPath = join(socketDir, socket);
  const defaultPath = join(socketDir, "default");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, ".config"),
    TAP_HOME: bus, TAP_INDEX_HOME: index, TAP_SESSION_MANIFEST: join(root, "sessions.json"),
    TAP_TMUX_SOCKET: socket, TAP_TMUX_SOCKET_PATH: undefined, TMUX: undefined, TMUX_PANE: undefined,
    TAP_SELF: undefined, TAP_SERVER_EPOCH: undefined, TAP_BOOT_ID: undefined,
    TAP_LAUNCH_SHELL: "/bin/bash", SHELL: "/bin/bash", TAP_CURSOR_HOME: join(root, "cursor-home"), CURSOR_HOME: undefined,
    PATH: `${root}/bin:${process.env.PATH}`,
  };
  cleanupSockets.push({ env, path: socketPath }, { env, path: defaultPath });
  writeFileSync(join(index, "registry-flip.json"), JSON.stringify({ schema: "0.20", state: "live" }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", migrated: {}, teams: {
    team: { root, registry_location: registry, state: "registered" },
  } }));
  writeFileSync(join(root, ".config/tap/config.toml"), `version = 3\n[harness.${harness}.env]\nACCOUNT_MARKER = "machine-value"\n`);
  writeFileSync(join(root, ".bash_profile"), `export PATH=${quote(env.PATH!)}\n`);
  const tmuxLog = join(root, "tmux.argv");
  writeFileSync(join(root, "bin/tmux"), `#!/bin/bash\nprintf '%q ' "$@" >> ${quote(tmuxLog)}\nprintf '\\n' >> ${quote(tmuxLog)}\nfor arg in "$@"; do case "$arg" in attach|attach-session|switch-client) echo unexpected-attach >&2; exit 93;; esac; done\nexec ${quote(realTmux)} "$@"\n`);
  chmodSync(join(root, "bin/tmux"), 0o755);
  if (process.platform === "linux") copyFileSync("/bin/sleep", join(root, "real", harness));
  else symlinkSync("/bin/sleep", join(root, "real", harness));
  writeFileSync(join(root, "bin", harness), `#!/bin/bash\nset -e\nprintf '%s\\n' "$@" > ${quote(join(root, "harness.argv"))}\nprintf '%s\\n' "$ACCOUNT_MARKER" > ${quote(join(root, "harness.env"))}\ncp ${quote(registry)} ${quote(join(root, "before-harness.json"))}\nexport PATH=${quote(join(root, "real"))}:"$PATH"\nexec ${quote(join(root, "real", harness))} 600\n`);
  chmodSync(join(root, "bin", harness), 0o755);
  const put = (seats: Record<string, unknown>) => writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "team", worktree_root: root }, seats }));
  const get = () => JSON.parse(readFileSync(registry, "utf8"));
  const run = (...args: string[]) => spawnSync(process.execPath, [join(repo, "runtime/bun/main.ts"), ...args], {
    cwd: root, env, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"],
  });
  put({});
  return { root, bus, registry, env, socketPath, defaultPath, put, get, run, tmuxLog };
}

for (const keepServer of [true, false]) test.each(["codex", "claude"] as const)(`real %s down/up retains identity and mail; ${keepServer ? "existing" : "absent"} server; no attach`, (harness) => {
  const f = fixture(harness);
  f.env.TAP_BUN_ROUTE_TRACE = join(f.root, "route-trace");
  const initial = tm(f.env, f.socketPath, "new-session", "-d", "-s", "team/seat", "-c", f.root, "-P", "-F", "#{pane_id}", "sleep 600");
  expect({ code: initial.status, stderr: initial.stderr }).toEqual({ code: 0, stderr: "" });
  const pane = initial.stdout.trim();
  // Retain the selected server across down/up, and prove its other session survives.
  if (keepServer) expect(tm(f.env, f.socketPath, "new-session", "-d", "-s", "bystander", "sleep 600").status).toBe(0);
  const native = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const passthrough = harness === "codex"
    ? ["-c", 'model_reasoning_effort="high"', "-c", 'service_tier="fast"']
    : ["--append-system-prompt", "stored prompt one", "--append-system-prompt", "stored prompt two"];
  const retained = { session: "team/seat", pane_id: pane, status: "active", harness,
    instance: "seat|stable", harness_session_id: native, model: "stored-model", passthrough,
    harness_env: { ACCOUNT_MARKER: "stored-account" }, registered_from_worktree: f.root,
    cost_mode: "operator-choice", extension: { durable: "keep" } };
  f.put({ seat: retained });
  mkdirSync(join(f.bus, "payloads")); mkdirSync(join(f.bus, "receipts"));
  const mailPath = join(f.bus, "payloads/pending.md");
  const sentPath = join(f.bus, "receipts/pending.sent");
  const mail = "---\nreply: expected\nto: seat\n---\nUnsettled work survives stopping.\n";
  writeFileSync(mailPath, mail); writeFileSync(sentPath, "placed but unsettled\n");
  const down = f.run("down", "seat", "--json");
  expect({ code: down.status, stderr: down.stderr, stdout: down.stdout }).toMatchObject({ code: 0 });
  expect(JSON.parse(down.stdout).outcome).toBe("stopped");
  expect(f.get().seats.seat.instance).toBe(retained.instance);
  const up = f.run("up", "team/seat", "--json");
  expect({ code: up.status, stderr: up.stderr }).toMatchObject({ code: 0 });
  expect(JSON.parse(up.stdout)).toMatchObject({ outcome: "resumed", lifecycle_action: "up", mechanism: "seat-up", registry_fate: "resume-rows" });
  const current = f.get().seats.seat;
  expect(current).toMatchObject({ instance: retained.instance, harness_session_id: native,
    model: retained.model, passthrough, harness_env: retained.harness_env, cost_mode: retained.cost_mode, extension: retained.extension,
    status: "active", status_reason: "" });
  if (keepServer) expect(current.pane_id).not.toBe(pane);
  expect(current.launch_id).toBeUndefined();
  expect(tm(f.env, f.socketPath, "has-session", "-t", "=team/seat").status).toBe(0);
  if (keepServer) expect(tm(f.env, f.socketPath, "has-session", "-t", "=bystander").status).toBe(0);
  expect(tm(f.env, f.socketPath, "list-sessions", "-F", "#{session_name}:#{session_attached}").stdout.split("\n")).toContain("team/seat:0");
  expect(tm(f.env, f.defaultPath, "has-session", "-t", "=team/seat").status).not.toBe(0);
  const argv = readFileSync(join(f.root, "harness.argv"), "utf8").trimEnd().split("\n");
  expect(argv.slice(0, passthrough.length)).toEqual(passthrough);
  expect(argv).toContain(native); expect(argv).toContain("stored-model");
  const resumeAt = argv.indexOf(harness === "codex" ? "resume" : "--resume");
  expect(resumeAt).toBeGreaterThanOrEqual(0);
  expect(argv.filter(arg => arg === native)).toHaveLength(1);
  expect(readFileSync(join(f.root, "harness.env"), "utf8")).toBe("stored-account\n");
  expect(readFileSync(mailPath, "utf8")).toBe(mail);
  expect(readFileSync(sentPath, "utf8")).toBe("placed but unsettled\n");
  expect(existsSync(join(f.bus, "receipts/pending.done"))).toBe(false);
  expect(readFileSync(f.tmuxLog, "utf8")).not.toMatch(/(?:^|\s)(?:attach|attach-session|switch-client)(?:\s|$)/);
  const repeat = f.run("up", "seat", "--json");
  expect(repeat.status).toBe(0);
  expect(JSON.parse(repeat.stdout).outcome).toBe("already_live");
  const trace = readFileSync(f.env.TAP_BUN_ROUTE_TRACE, "utf8");
  expect(trace).toContain("native down\n"); expect(trace).toContain("native up\n");
  expect(trace).not.toContain("bash ");
}, 45_000);

for (const pin of ["name", "path"] as const) test(`up must preserve a foreign session replacing its placeholder before bind (${pin} socket)`, () => {
  const f = fixture("codex");
  if (pin === "path") f.env.TAP_TMUX_SOCKET_PATH = f.socketPath;
  expect(tm(f.env, f.socketPath, "new-session", "-d", "-s", "bystander", "sleep 600").status).toBe(0);
  f.put({ seat: { session: "team/seat", status: "suspended", status_reason: "session_stopped", harness: "codex",
    instance: "seat|stable", harness_session_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", registered_from_worktree: f.root } });
  const foreignPath = join(f.root, "foreign.identity");
  const marker = join(f.root, "replaced.once");
  const shim = join(f.root, "bin/tmux");
  const before = readFileSync(shim, "utf8");
  // Match nudge-recovery-policy's leading socket-pair peel, keeping forwarded argv intact.
  const race = `tmux_verb() {
  while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
  printf '%s' "$1"
}
if [ "$(tmux_verb "$@")" = new-session ] && [ ! -e ${quote(marker)} ]; then
  ${quote(realTmux)} "$@" || exit $?
  : > ${quote(marker)}
  ${quote(realTmux)} -S ${quote(f.socketPath)} kill-session -t '=team/seat' || exit $?
  ${quote(realTmux)} -S ${quote(f.socketPath)} new-session -d -s team/seat -P -F '#{session_id} #{pane_id} #{pane_pid}' 'sleep 600' > ${quote(foreignPath)} || exit $?
  exit 0
fi
`;
  writeFileSync(shim, before.replace(`exec ${quote(realTmux)} "$@"`, race + `exec ${quote(realTmux)} "$@"`));
  const up = f.run("up", "seat", "--json");
  const foreign = existsSync(foreignPath) ? readFileSync(foreignPath, "utf8").trim() : "not injected";
  const live = tm(f.env, f.socketPath, "list-panes", "-a", "-F", "#{session_name} #{session_id} #{pane_id} #{pane_pid} #{pane_current_command}").stdout;
  const diagnostic = { up: { status: up.status, stdout: up.stdout, stderr: up.stderr }, foreign, live,
    registry: f.get(), harnessStarted: existsSync(join(f.root, "harness.argv")), tmuxCalls: readFileSync(f.tmuxLog, "utf8") };
  expect(foreign).not.toBe("not injected");
  expect(up.status).not.toBe(0);
  expect(live).toContain(foreign);
  expect(diagnostic.harnessStarted).toBe(false);
}, 45_000);

// tap up --dry-run resolves the same refusals as the real run (tap-8my96 a, b):
// a stored Cursor chat id whose store never appeared is not resumable, so the
// preview refuses with the real run's class and its --fresh recovery action.
const CURSOR_ID = "019a1111-2222-7333-8444-555555555555";
const cursorRow = (f: ReturnType<typeof fixture>, over: Record<string, unknown> = {}) => ({ session: "team/seat", status: "suspended",
  status_reason: "session_stopped", harness: "cursor", instance: "seat|stable", harness_session_id: CURSOR_ID,
  registered_from_worktree: f.root, ...over });
const sessions = (f: ReturnType<typeof fixture>) => tm(f.env, f.socketPath, "list-sessions", "-F", "#{session_name}").stdout;
const hasCursorStore = (f: ReturnType<typeof fixture>) => {
  const store = join(f.root, "cursor-home", "chats", createHash("md5").update(f.root, "utf8").digest("hex"), CURSOR_ID, "store.db");
  mkdirSync(join(store, ".."), { recursive: true }); writeFileSync(store, "");
};

test("a stale stopped cursor row: dry-run and real tap up refuse alike, with the class and the --fresh action; nothing is written", () => {
  const f = fixture("cursor");
  f.put({ seat: cursorRow(f) });
  const before = readFileSync(f.registry, "utf8");
  const failures = [true, false].map(dry => {
    const up = f.run("up", "seat", "--json", ...(dry ? ["--dry-run"] : []));
    expect(up.status).toBe(1);
    return JSON.parse(up.stdout);
  });
  for (const failure of failures) {
    expect(failure).toMatchObject({ ok: false, verb: "up", error_class: "no_exact_resume_identity" });
    expect(failure.action).toBe("tap session launch cursor seat --fresh");
    expect(failure.detail).toContain("no persisted conversation store");
  }
  expect(failures[0]).toEqual(failures[1]);
  expect(readFileSync(f.registry, "utf8")).toBe(before);
  expect(sessions(f)).not.toContain("team/seat");
  expect(existsSync(join(f.root, "harness.argv"))).toBe(false);
  // The human spelling carries the same cause and recovery.
  const text = f.run("up", "seat", "--dry-run");
  expect(text.status).toBe(1);
  expect(text.stderr).toContain("no persisted conversation store");
  expect(text.stderr).toContain("next: tap session launch cursor seat --fresh");
}, 45_000);

test("a stopped cursor row whose store exists: the dry run previews would_resume and the real run resumes", () => {
  const f = fixture("cursor");
  f.put({ seat: cursorRow(f) });
  hasCursorStore(f);
  const before = readFileSync(f.registry, "utf8");
  const dry = f.run("up", "seat", "--json", "--dry-run");
  expect({ code: dry.status, stderr: dry.stderr }).toMatchObject({ code: 0 });
  expect(JSON.parse(dry.stdout).outcome).toBe("would_resume");
  expect(readFileSync(f.registry, "utf8")).toBe(before);
  expect(sessions(f)).not.toContain("team/seat");
}, 45_000);

test("a live cursor row before its first turn: dry-run and real tap up both report already_live", () => {
  const f = fixture("cursor");
  const live = tm(f.env, f.socketPath, "new-session", "-d", "-s", "team/seat", "-c", f.root, "-P", "-F", "#{pane_id}", "sleep 600");
  expect(live.status).toBe(0);
  f.put({ seat: cursorRow(f, { status: "active", status_reason: "", pane_id: live.stdout.trim() }) });
  const before = readFileSync(f.registry, "utf8");
  const outcomes = [true, false].map(dry => JSON.parse(f.run("up", "seat", "--json", ...(dry ? ["--dry-run"] : [])).stdout).outcome);
  expect(outcomes).toEqual(["already_live", "already_live"]);
  expect(readFileSync(f.registry, "utf8")).toBe(before);
}, 45_000);

test("a typed refusal with no recovery class keeps its operation_failed class", () => {
  const f = fixture("codex");
  // A retained row with no native identity: the dry run's own refusal, class unchanged.
  f.put({ seat: { session: "team/seat", status: "suspended", status_reason: "session_stopped", harness: "codex", instance: "seat|stable", registered_from_worktree: f.root } });
  const dry = f.run("up", "seat", "--json", "--dry-run");
  expect(JSON.parse(dry.stdout)).toMatchObject({ ok: false, error_class: "resume_identity_missing" });
}, 45_000);

test("a stopped row whose launch workdir is gone: dry-run and real tap up refuse alike (the transaction's own validation)", () => {
  const f = fixture("codex");
  f.put({ seat: { session: "team/seat", status: "suspended", status_reason: "session_stopped", harness: "codex", instance: "seat|stable",
    harness_session_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", registered_from_worktree: f.root, launch_workdir: join(f.root, "deleted-worktree") } });
  const before = readFileSync(f.registry, "utf8");
  const failures = [true, false].map(dry => {
    const up = f.run("up", "seat", "--json", ...(dry ? ["--dry-run"] : []));
    expect(up.status).toBe(1);
    return JSON.parse(up.stdout);
  });
  expect(failures[0].error_class).toBe(failures[1].error_class);
  expect(failures[1].detail).toContain("--workdir must name an existing worktree");
  expect(failures[0].detail).toBe(failures[1].detail);
  expect(readFileSync(f.registry, "utf8")).toBe(before);
  expect(sessions(f)).not.toContain("team/seat");
}, 45_000);

test("public CLI: session resume --dry-run on a live session with no matching harness pane refuses as one JSON document, writing nothing", () => {
  const f = fixture("codex");
  const live = tm(f.env, f.socketPath, "new-session", "-d", "-s", "team/seat", "-c", f.root, "-P", "-F", "#{pane_id}", join(f.root, "real", "codex") + " 600");
  expect(live.status).toBe(0);
  f.put({ seat: { session: "team/seat", status: "active", delivery: "pane", harness: "cursor", instance: "seat|stable", harness_session_id: CURSOR_ID,
    pane_id: live.stdout.trim(), registered_from_worktree: f.root } });
  const before = readFileSync(f.registry, "utf8");
  const dry = f.run("session", "resume", "seat", "--dry-run", "--json");
  expect(dry.status).toBe(2);
  expect(dry.stderr).toBe("");
  expect(JSON.parse(dry.stdout)).toMatchObject({ ok: false, error_class: "live_session_unmatched" });
  // The runner's pane is a bare sleep, so the matching-pane probe finds no harness: the not-live arm of the same typed refusal.
  expect(JSON.parse(dry.stdout).detail).toMatch(/is not live|active pane is/);
  expect(readFileSync(f.registry, "utf8")).toBe(before);
  expect(sessions(f)).toContain("team/seat");
}, 45_000);
