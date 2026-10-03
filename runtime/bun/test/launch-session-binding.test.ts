// tap-6g90c: a launcher-started Claude seat must be bound by its own
// SessionStart registration (env capture), even while another TAP mutation —
// in production, an assign still delivering to the new pane — holds the team's
// reset custody for a few seconds. The fake harness runs the real SessionStart
// hook the way Claude does, shortly after the launch completes.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { removeScratchTree } from "./support/scratch";

const original = { ...process.env };
const realTmux = Bun.which("tmux")!;
const roots: string[] = [];
const sockets: string[] = [];
const repo = resolve(import.meta.dir, "../../..");
const publicBin = join(repo, "bin/tap");
const hook = join(repo, "runtime/bun/src/session-start.ts");
const panelock = join(repo, "runtime/bun/src/panelock.ts");

afterEach(() => {
  for (const socket of sockets.splice(0)) spawnSync(realTmux, ["-L", socket, "kill-server"], { env: process.env, stdio: "ignore" });
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  for (const root of roots.splice(0)) removeScratchTree(root);
});

function fixture() {
  // Scratch lives under the runner's root (runtime/bun/test/run.sh), never /tmp.
  if (!original.TMUX_TMPDIR) throw new Error("launch-session-binding.test.ts: run through runtime/bun/test/run.sh (TMUX_TMPDIR unset)");
  const root = realpathSync(mkdtempSync(join(original.TMUX_TMPDIR, "tap-bind-test-")));
  roots.push(root);
  const index = join(root, "index");
  const bus = join(root, ".tap/bus");
  const registry = join(root, ".tap/team-registry.json");
  for (const dir of [index, bus, join(root, ".config/tap"), join(root, "bin"), join(root, "real")]) mkdirSync(dir, { recursive: true });
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture", worktree_root: root }, seats: {} }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { fixture: { root, registry_location: registry } } }));
  const socket = `bind-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  sockets.push(socket);
  Object.assign(process.env, { HOME: root, XDG_CONFIG_HOME: join(root, ".config"), TAP_INDEX_HOME: index,
    TAP_HOME: bus, TAP_TMUX_SOCKET: socket, TAP_LAUNCH_SHELL: "/bin/bash", SHELL: "/bin/bash",
    PATH: `${root}/bin:${original.PATH}` });
  for (const key of ["TMUX", "TMUX_PANE", "TAP_SELF", "TAP_TMUX_SOCKET_PATH", "TAP_SERVER_EPOCH", "TAP_BOOT_ID", "TAP_LOCK_DIR"]) delete process.env[key];
  writeFileSync(join(root, ".bash_profile"), `export PATH='${process.env.PATH}'\n`);
  writeFileSync(join(root, ".config/tap/config.toml"), `version = 3\n[presets.testseat]\nharness = "claude"\n`);
  return { root, bus, registry };
}

// Waits until the launcher has published the ready row, then either holds the
// team's reset custody for a while, as an in-flight send does during pane
// delivery, or leaves an unreadable reset fence, which registration refuses.
function writeHolder(root: string) {
  writeFileSync(join(root, "holder.ts"), `
import { acquirePathLock } from ${JSON.stringify(panelock)};
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const [registry, bus, mode, heldFlag] = process.argv.slice(2);
const deadline = Date.now() + 15000;
for (;;) {
  try {
    const row = JSON.parse(readFileSync(registry, "utf8")).seats?.reviewer;
    if (row?.status === "active" && !row.launch_id && !row.status_reason) break;
  } catch {}
  if (Date.now() > deadline) process.exit(3);
  await Bun.sleep(50);
}
if (mode === "fence") {
  writeFileSync(bus + "/reset.fence.json", "unreadable\\n");
  writeFileSync(heldFlag, "");
} else if (mode === "park") {
  // One authorized parked message for the new seat (tap-iee3x).
  const { mkdirSync } = await import("node:fs");
  mkdirSync(bus + "/spool", { recursive: true });
  writeFileSync(bus + "/spool/park-1.md", "---\\nid: park-1\\nfrom: sender\\nto: reviewer\\nto_team: fixture\\nkind: discuss\\npath: " + bus + "/payloads/park-1.md\\nreply: expected\\nrecipient_instance: \\n---\\nbody\\n");
  writeFileSync(bus + "/spool/park-1.meta.json", JSON.stringify({ target: "reviewer" }));
  writeFileSync(heldFlag, "");
} else {
  const lock = acquirePathLock(bus + "/reset.fence.json.lock", 5000);
  if (!lock) process.exit(4);
  writeFileSync(heldFlag, "");
  await Bun.sleep(Number(mode));
  lock.release();
}
`);
}

// The fake Claude fires SessionStart through the real hook with the payload
// Claude sends, after exec'ing into a process the launcher accepts as the harness.
function fakeClaude(f: { root: string; bus: string; registry: string }, mode: string, hookMode: "context" | "claude" = "context") {
  writeHolder(f.root);
  if (process.platform === "linux") copyFileSync("/bin/sleep", join(f.root, "real/claude"));
  else symlinkSync("/bin/sleep", join(f.root, "real/claude"));
  const held = join(f.root, "held");
  writeFileSync(join(f.root, "bin/claude"), `#!/bin/bash
printf '%s\\n' "$@" > '${f.root}/argv'
sid=""; prev=""
for a in "$@"; do [ "$prev" = --session-id ] && sid="$a"; prev="$a"; done
transcript='${f.root}/.claude/projects/fixture/'"$sid.jsonl"
mkdir -p "$(dirname "$transcript")"; : > "$transcript"
(
  ${mode === "now" ? `: > '${held}'` : `{ '${process.execPath}' '${f.root}/holder.ts' '${f.registry}' '${f.bus}' '${mode}' '${held}' 2>'${f.root}/holder.err'; echo $? > '${f.root}/holder.rc'; } &`}
  for _ in $(seq 1 300); do [ -e '${held}' ] && break; sleep 0.05; done
  printf '{"hook_event_name":"SessionStart","source":"startup","session_id":"%s","transcript_path":"%s"}\\n' "$sid" "$transcript" \\
    | TAP_HOME= TAP_HARNESS_SESSION_ID=stale-generic CLAUDE_CODE_SESSION_ID=stale-native TAP_BUN_ROUTE_TRACE='${f.root}/route.trace' ${hookMode === "claude" ? `CLAUDE_PROJECT_DIR="$PWD" bun '${hook}' claude` : `bun '${hook}' context '${f.root}'`} >'${f.root}/hook.out' 2>'${f.root}/hook.err'
  echo $? > '${f.root}/hook.rc'
) &
export PATH='${f.root}/real':"$PATH"
exec '${f.root}/real/claude' 600
`);
  chmodSync(join(f.root, "bin/claude"), 0o755);
}

async function launchAndFireSessionStart(f: { root: string; registry: string }, extra: string[] = []) {
  const started = performance.now();
  const launch = spawnSync("bash", [publicBin, "session", "launch", "testseat", "reviewer", "--json", ...extra], {
    cwd: f.root, env: process.env, encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" });
  expect({ status: launch.status, stderr: launch.stderr }).toEqual({ status: 0, stderr: "" });
  const launchMs = performance.now() - started;
  const deadline = Date.now() + 30_000;
  while (!existsSync(join(f.root, "hook.rc")) && Date.now() < deadline) await Bun.sleep(100);
  const argv = readFileSync(join(f.root, "argv"), "utf8").split("\n");
  return {
    sid: argv[argv.indexOf("--session-id") + 1]!,
    hookOut: readFileSync(join(f.root, "hook.out"), "utf8"),
    row: JSON.parse(readFileSync(f.registry, "utf8")).seats.reviewer,
    launchMs,
  };
}

test("SessionStart binds a launched Claude seat by env capture while a send briefly holds reset custody", async () => {
  const f = fixture();
  fakeClaude(f, "3000");
  const { sid, hookOut, row } = await launchAndFireSessionStart(f);
  expect(existsSync(join(f.root, "held")), `the contention never happened: ${JSON.stringify(row)} ${readFileSync(join(f.root, "holder.err"), "utf8")}`).toBe(true);
  expect(hookOut).not.toContain("did not record its harness identity");
  expect(row.identity_capture_result).toMatchObject({ decision: "accepted", mode: "launcher_new", observed_harness_session_id: sid });
  expect(row.identity_capture).toBeUndefined();
  expect(row.session_attribution_trust).toBe("env");
  const transcript = join(f.root, ".claude/projects/fixture", `${sid}.jsonl`);
  expect(row.transcript_path).toBe(transcript);
  expect(row.session_store_path).toBe(transcript);
}, 60_000);

test("a SessionStart bind that is refused says so instead of passing silently", async () => {
  const f = fixture();
  // An unreadable fence refuses at once, and says it is unreclaimable rather than
  // mid-reset: no owner exists to finish it (tap-mkiqq).
  fakeClaude(f, "fence");
  const { hookOut, row } = await launchAndFireSessionStart(f);
  expect(hookOut).toContain("did not record its harness identity");
  expect(hookOut).toContain("reset.fence.json is unreadable, so nothing will clear it automatically");
  expect(hookOut).not.toContain("mid-reset");
  expect(row.identity_capture_result).toBeUndefined();
}, 60_000);

test("SessionStart binds through exactly one `tap in` child and passes only its parked-mail line to the model", async () => {
  const f = fixture();
  fakeClaude(f, "park");
  const { hookOut, row } = await launchAndFireSessionStart(f);
  expect(existsSync(join(f.root, "held")), readFileSync(join(f.root, "holder.err"), "utf8")).toBe(true);
  expect(row.identity_capture_result).toMatchObject({ decision: "accepted" });
  // One bind, and no second identity lookup: the route trace records every tap verb.
  expect(readFileSync(join(f.root, "route.trace"), "utf8").trim().split("\n")).toEqual(["native in"]);
  const lines = hookOut.trim().split("\n");
  expect(lines[0]).toStartWith("TAP: registered as reviewer on team fixture.");
  expect(lines.filter(line => line.startsWith("tap "))).toEqual(["tap register: 1 parked message(s) for you; next: tap poll reviewer"]);
}, 60_000);

// tap-bogkt / tap-7b9od: a seat launched with --workdir into a worktree OUTSIDE
// the enrolled root runs the real Claude adapter (CLAUDE_PROJECT_DIR = its
// cwd). The launcher's pane evidence, not the cwd, names the team, and the
// bind's worktree guard accepts the launcher-placed worktree.
function worktreeOf(root: string, at?: string): string {
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root");
  let wt = at ?? "";
  if (!wt) {
    // Inside the fixture root's scratch parent, outside the enrolled root itself.
    const parent = realpathSync(mkdtempSync(join(original.TMUX_TMPDIR!, "tap-bind-wt-")));
    roots.push(parent);
    wt = join(parent, "wt");
  }
  git("worktree", "add", "-q", "--detach", wt);
  return realpathSync(wt);
}

test("a seat launched into a worktree outside the enrolled root binds through launcher evidence", async () => {
  const f = fixture();
  const wt = worktreeOf(f.root);
  // The hook fires as soon as the harness starts, as Claude's does: its bind is
  // the launcher's readiness signal, so the launch ends before the 5 s window.
  fakeClaude(f, "now", "claude");
  const { sid, hookOut, row } = await launchAndFireSessionStart(f, ["--workdir", wt]);
  // The launch ended on that bind, not the window timer: the startup trace names the
  // claude_bind signal for this launch and launch_complete follows it within a short
  // tail (a timer wait leaves the rest of the window between them). Both events carry
  // the launcher's own emission clock (`emitted_at`, stamped by the caller; the row's
  // `timestamp` is the asynchronous writer's drain time and is never mixed in).
  const events: Array<Record<string, string>> = readFileSync(join(process.env.TAP_INDEX_HOME!, "logs/startup.jsonl"), "utf8")
    .trim().split("\n").map(line => JSON.parse(line));
  const respawn = events.find(e => e.event === "respawn_pane");
  const bound = events.find(e => e.event === "readiness_signal" && e.signal === "claude_bind" && e.launch_id === respawn?.launch_id);
  const complete = events.find(e => e.event === "launch_complete" && e.operation_id === respawn?.operation_id);
  expect(bound?.emitted_at, "trace names claude_bind for the launch").toBeDefined();
  expect(complete?.emitted_at, "launch_complete in the trace").toBeDefined();
  expect(Date.parse(complete!.emitted_at!) - Date.parse(bound!.emitted_at!), "launch_complete follows the bind, not the window timer").toBeLessThan(3000);
  // The ready bind promoted the pending launch_id to the incarnation's launch_witness.
  expect(row.launch_id).toBeUndefined();
  expect(row.launch_witness).toMatch(/^[0-9a-f-]{36}$/);
  expect(readFileSync(join(f.root, "hook.err"), "utf8")).not.toContain("outside worktree");
  expect(hookOut).toContain("TAP: registered as reviewer on team fixture.");
  expect(row.launch_workdir).toBe(wt);
  expect(row.identity_capture_result).toMatchObject({ decision: "accepted", observed_harness_session_id: sid });
  expect(row.transcript_path).toBe(join(f.root, ".claude/projects/fixture", `${sid}.jsonl`));
}, 60_000);

// Intended behavior change: the launch workdir is itself ANOTHER team's enrolled
// root. CLAUDE_PROJECT_DIR used to name that team, and the bind child, selecting
// by cwd before TAP_HOME, would register this pane there. Launch evidence wins,
// pins the bind child to the launching root, and leaves the other team's
// registry byte-identical.
test("a workdir that is another team's enrolled root binds to the launching team and leaves the other untouched", async () => {
  const f = fixture();
  const wt = worktreeOf(f.root);
  mkdirSync(join(wt, ".tap/bus"), { recursive: true });
  const otherRegistry = join(wt, ".tap/team-registry.json");
  writeFileSync(otherRegistry, JSON.stringify({ schema: "0.20", team: { name: "other", worktree_root: wt }, seats: {} }));
  const index = join(process.env.TAP_INDEX_HOME!, "global-registry.json");
  const doc = JSON.parse(readFileSync(index, "utf8"));
  doc.teams.other = { root: wt, registry_location: otherRegistry };
  writeFileSync(index, JSON.stringify(doc));
  const otherBefore = readFileSync(otherRegistry, "utf8");
  fakeClaude(f, "now", "claude");
  const { sid, hookOut, row } = await launchAndFireSessionStart(f, ["--workdir", wt]);
  expect(hookOut).toContain("TAP: registered as reviewer on team fixture.");
  expect(hookOut).not.toContain("on team other");
  expect(row.identity_capture_result).toMatchObject({ decision: "accepted", observed_harness_session_id: sid });
  expect(readFileSync(otherRegistry, "utf8")).toBe(otherBefore);
}, 60_000);

// tap-9jfyl boundary, end to end: a harness the launcher did NOT start, sitting in
// a worktree of an enrolled root, runs the real Claude adapter in a real pane.
// Without launch evidence, and with forged evidence naming no row, the hook is
// silent and neither the index nor the registry moves a byte.
test("an unlaunched session in a worktree stays silent and writes nothing, with or without forged evidence", async () => {
  const f = fixture();
  const wt = worktreeOf(f.root);
  const index = join(process.env.TAP_INDEX_HOME!, "global-registry.json");
  const before = { index: readFileSync(index, "utf8"), registry: readFileSync(f.registry, "utf8") };
  const socket = process.env.TAP_TMUX_SOCKET!;
  for (const [name, evidence] of [["bare", ""], ["forged", `TAP_LAUNCH_ROOT='${f.root}' TAP_LAUNCH_ID=forged-id `]] as const) {
    const out = join(f.root, `${name}.out`), rc = join(f.root, `${name}.rc`);
    writeFileSync(join(f.root, `${name}.sh`), `#!/bin/bash
printf '%s\\n' '{"hook_event_name":"SessionStart","source":"startup","session_id":"unlaunched-${name}","transcript_path":"${wt}/t.jsonl"}' \\
  | ${evidence}CLAUDE_PROJECT_DIR="$PWD" bun '${hook}' claude >'${out}' 2>&1
echo $? > '${rc}'
`);
    const started = spawnSync(realTmux, ["-L", socket, "new-session", "-d", "-s", `unlaunched-${name}`, "-c", wt, `bash '${join(f.root, `${name}.sh`)}'; sleep 30`],
      { env: process.env, encoding: "utf8" });
    expect(started.status, started.stderr).toBe(0);
    const deadline = Date.now() + 20_000;
    while (!existsSync(rc) && Date.now() < deadline) await Bun.sleep(100);
    expect(readFileSync(rc, "utf8").trim()).toBe("0");
    expect(readFileSync(out, "utf8")).toBe("");
  }
  expect(readFileSync(index, "utf8")).toBe(before.index);
  expect(readFileSync(f.registry, "utf8")).toBe(before.registry);
}, 60_000);
