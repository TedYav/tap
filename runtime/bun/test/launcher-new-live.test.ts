// Live check for `tap session launch` (launcher/new.ts): new.ts launches one
// fake-harness seat on a private tmux socket, with the real SessionStart hook
// binding it. The receipts, exit status and resulting registry row must equal
// the incumbent `launcher.py new`'s, recorded before the Python launcher was retired,
// once volatile values (pane ids, times, minted ids, pids) are masked.
// This proves the effects the dry-run oracle cannot reach: transaction kind
// "new", readiness, binding and the detached tail.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const original = { ...process.env };
const realTmux = Bun.which("tmux")!;
const repo = resolve(import.meta.dir, "../../..");
const hook = join(repo, "runtime/bun/src/session-start.ts");
const native = ["bun", join(repo, "runtime/bun/src/launcher/new.ts")];
const GOLDEN = join(import.meta.dir, "fixtures/launch-new-live-oracle.json");
const roots: string[] = [], sockets: string[] = [];

function expectedLaunch() {
  const expected = JSON.parse(readFileSync(GOLDEN, "utf8")).cases["launch testseat reviewer"];
  // The frozen Python launch predates the auto default and the foreground attach guidance.
  expected.harnessArgv.splice(0, 1, "--permission-mode", "auto");
  expected.row.permissions = "auto";
  expected.stdout = expected.stdout.replace("next: tmux attach -t ", "next: from a foreground terminal, run tap attach ");
  return expected;
}

afterEach(() => {
  for (const socket of sockets.splice(0)) spawnSync(realTmux, ["-L", socket, "kill-server"], { stdio: "ignore" });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(config = "") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tap-new-live-")));
  roots.push(root);
  const index = join(root, "index"), bus = join(root, ".tap/bus"), registry = join(root, ".tap/team-registry.json");
  for (const dir of [index, bus, join(root, ".config/tap"), join(root, "bin"), join(root, "real")]) mkdirSync(dir, { recursive: true });
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture", worktree_root: root }, seats: {} }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { fixture: { root, registry_location: registry } } }));
  const socket = `new-live-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  sockets.push(socket);
  const env: NodeJS.ProcessEnv = { ...original, HOME: root, XDG_CONFIG_HOME: join(root, ".config"), TAP_INDEX_HOME: index,
    TAP_HOME: bus, TAP_TMUX_SOCKET: socket, TAP_LAUNCH_SHELL: "/bin/bash", SHELL: "/bin/bash", PATH: `${root}/bin:${original.PATH}` };
  for (const key of ["TMUX", "TMUX_PANE", "TAP_SELF", "TAP_TMUX_SOCKET_PATH", "TAP_SERVER_EPOCH", "TAP_BOOT_ID", "TAP_LOCK_DIR", "TAP_LAUNCHER", "TAP_JSON"]) delete env[key];
  writeFileSync(join(root, ".bash_profile"), `export PATH='${env.PATH}'\n`);
  writeFileSync(join(root, ".config/tap/config.toml"), `version = 3\n[presets.testseat]\nharness = "claude"\n${config}`);
  // Fake Claude: exec's a process the launcher accepts as the harness, and fires
  // the real SessionStart hook once the launcher has published the active row.
  if (process.platform === "linux") copyFileSync("/bin/sleep", join(root, "real/claude"));
  else symlinkSync("/bin/sleep", join(root, "real/claude"));
  writeFileSync(join(root, "bin/claude"), `#!/bin/bash
pwd >> '${root}/cwd'
printf '%s\\n' "$@" > '${root}/argv'
sid=""; prev=""
for a in "$@"; do [ "$prev" = --session-id -o "$prev" = --resume ] && sid="$a"; prev="$a"; done
transcript='${root}/.claude/projects/fixture/'"$sid.jsonl"
mkdir -p "$(dirname "$transcript")"; : > "$transcript"
(
  for _ in $(seq 1 600); do grep -q '"active"' '${registry}' 2>/dev/null && break; sleep 0.02; done
  printf '{"hook_event_name":"SessionStart","source":"startup","session_id":"%s","transcript_path":"%s"}\\n' "$sid" "$transcript" \\
    | TAP_HOME= bun '${hook}' context "$PWD" >'${root}/hook.out' 2>'${root}/hook.err'
  echo $? > '${root}/hook.rc'
) &
export PATH='${root}/real':"$PATH"
exec '${root}/real/claude' 600
`);
  chmodSync(join(root, "bin/claude"), 0o755);
  return { root, registry, env };
}

// The runner's tmux directory and the uid in its socket path vary per run and per machine.
const tmuxDirs = [...new Set([original.TMUX_TMPDIR, original.TMUX_TMPDIR && realpathSync(original.TMUX_TMPDIR)].filter(Boolean) as string[])]
  .sort((a, b) => b.length - a.length);
const VOLATILE = /^(pane|pane_id|instance|launch_id|boot_id|server_epoch|pid|.*_at|last_.*|registered|updated|created|timestamp|generation|.*epoch.*)$/;
function mask(value: unknown, root: string): unknown {
  if (typeof value === "string") return tmuxDirs.reduce((acc, dir) => acc.replaceAll(dir, "<tmux>"), value.replaceAll(root, "<root>"))
    .replace(/\/tmux-\d+\//g, "/tmux-<uid>/").replace(/new-live-\d+-[0-9a-f]+/g, "<socket>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>").replace(/%\d+/g, "%N");
  if (Array.isArray(value)) return value.map(item => mask(item, root));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1)
      .map(([key, item]) => [key, VOLATILE.test(key) ? "<volatile>" : mask(item, root)]));
  }
  return value;
}

async function launch(engine: string[], config = "") {
  const f = fixture(config);
  const argv = [...engine, "testseat", "reviewer"];
  const run = spawnSync(argv[0]!, argv.slice(1), { cwd: f.root, env: f.env, encoding: "utf8", timeout: 40_000, killSignal: "SIGKILL" });
  const deadline = Date.now() + 30_000;
  while (!existsSync(join(f.root, "hook.rc")) && Date.now() < deadline) await Bun.sleep(50);
  const row = JSON.parse(readFileSync(f.registry, "utf8")).seats.reviewer;
  const harnessArgv = readFileSync(join(f.root, "argv"), "utf8").trim().split("\n");
  return {
    raw: { row, harnessArgv, hookRc: readFileSync(join(f.root, "hook.rc"), "utf8").trim() },
    logs: (name: string) => { const path = join(f.root, "index/logs", name);
      return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line)) : []; },
    masked: mask({ status: run.status, stdout: run.stdout, stderr: run.stderr, row, harnessArgv }, f.root),
  };
}

test("launch binds the seat by its own SessionStart, as the incumbent did", async () => {
  const launched = await launch(native);
  expect(launched.raw.hookRc).toBe("0");
  // Bound by the launcher-minted identity the harness was started with.
  const sid = launched.raw.harnessArgv[launched.raw.harnessArgv.indexOf("--session-id") + 1];
  expect(launched.raw.row.harness_session_id).toBe(sid);
  expect(launched.raw.row.status).toBe("active");
  // launch_tuning and launch_witness (the launcher-minted bind evidence) postdate the incumbent's row.
  const { launch_tuning, launch_witness, ...row } = (launched.masked as any).row;
  expect(launch_tuning).toEqual({ model: null, effort: null, qualifiers: {}, environment: {} });
  expect(launch_witness).toBe("<uuid>");
  expect({ ...(launched.masked as any), row }).toEqual(expectedLaunch());
}, 120_000);

test("verbose diagnostics capture a native launch's commands without changing its result", async () => {
  const launched = await launch(native, `[diagnostics]\nlevel = "verbose"\n`);
  expect(launched.raw.hookRc).toBe("0");
  // The [diagnostics] table changes only the config file's digest.
  const withoutDigest = (value: unknown) => JSON.parse(JSON.stringify(value).replace(/"config_digest":"sha256:[0-9a-f]+"/, '"config_digest":"<digest>"'));
  // launch_tuning and launch_witness (the launcher-minted bind evidence) postdate the incumbent's row.
  const { launch_tuning, launch_witness, ...row } = (launched.masked as any).row;
  expect(launch_tuning).toEqual({ model: null, effort: null, qualifiers: {}, environment: {} });
  expect(launch_witness).toBe("<uuid>");
  expect(withoutDigest({ ...(launched.masked as any), row })).toEqual(withoutDigest(expectedLaunch()));
  const debug = launched.logs("launch-debug.jsonl");
  expect(debug[0]).toMatchObject({ event: "diagnostics_start", console: false, tmux_trace: false });
  const commands = debug.filter(row => row.event === "command").length;
  expect(commands).toBeGreaterThan(5);
  expect(debug.filter(row => row.event === "command_exit").length).toBe(commands);
  // One writer child per traced operation: the launcher's own rows ride one
  // writer, and the SessionStart bind's register/sessionstart phases (item 3a)
  // each add their own operation with its own single writer.
  const trace = launched.logs("startup.jsonl");
  expect(trace.map(row => row.event)).toContain("launch_complete");
  // The bind's post-commit tail is split per step (register_tail, launchfast):
  // every step reports an integer millisecond count.
  const tail = trace.find(row => row.event === "register_tail");
  expect(tail, `register_tail missing from: ${trace.map(row => row.event).join(", ")}`).toBeDefined();
  for (const field of ["control_lines_ms", "registry_events_ms", "reset_fence_ms", "enroll_team_ms", "emit_briefing_ms", "suffix_primer_ms", "emit_version_briefing_ms", "tail_total_ms"]) {
    expect(Number.isInteger(tail![field]), `${field} = ${JSON.stringify(tail![field])}`).toBe(true);
  }
  const pidsByOperation = new Map<string, Set<number>>();
  for (const row of trace) {
    const key = row.operation_id ?? "(bare)";
    if (!pidsByOperation.has(key)) pidsByOperation.set(key, new Set());
    pidsByOperation.get(key)!.add(row.pid);
  }
  expect([...pidsByOperation.values()].every(pids => pids.size === 1)).toBe(true);
}, 120_000);


test("explicit linked workdir keeps the root team through launch, registration and relaunch", async () => {
  const f = fixture();
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-C", f.root, ...args], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  };
  git("init", "-q");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
  const lane = realpathSync(mkdtempSync(join(tmpdir(), "tap-launch-lane-"))); roots.push(lane);
  git("worktree", "add", "--detach", lane, "HEAD");
  const before = readFileSync(f.registry, "utf8");
  const preview = spawnSync(native[0]!, [...native.slice(1), "testseat", "reviewer", "--workdir", lane, "--dry-run", "--json"],
    { cwd: f.root, env: f.env, encoding: "utf8", timeout: 10_000 });
  expect(preview.status, preview.stderr).toBe(0);
  expect(JSON.parse(preview.stdout).cwd).toBe(lane);
  const invalid = spawnSync(native[0]!, [...native.slice(1), "testseat", "reviewer", "--workdir", join(f.root,"missing"), "--json"],
    { cwd: f.root, env: f.env, encoding: "utf8", timeout: 10_000 });
  expect(invalid.status).not.toBe(0); expect(JSON.parse(invalid.stdout).error_class).toBe("invalid_workdir");
  expect(invalid.stderr).toBe(""); expect(readFileSync(f.registry,"utf8")).toBe(before);
  expect(existsSync(join(f.root,"cwd"))).toBe(false);
  const launched = spawnSync(native[0]!, [...native.slice(1), "testseat", "reviewer", "--workdir", lane],
    { cwd: f.root, env: f.env, encoding: "utf8", timeout: 40_000 });
  expect(launched.status, launched.stdout + launched.stderr).toBe(0);
  const deadline = Date.now() + 30_000;
  while (!existsSync(join(f.root, "hook.rc")) && Date.now() < deadline) await Bun.sleep(50);
  expect(readFileSync(join(f.root, "hook.rc"), "utf8").trim(), readFileSync(join(f.root, "hook.err"), "utf8")).toBe("0");
  const doc = JSON.parse(readFileSync(f.registry, "utf8"));
  expect(doc.team.name).toBe("fixture");
  expect(doc.seats.reviewer).toMatchObject({ status: "active", launch_workdir: lane, registered_from_worktree: f.root });
  expect(readFileSync(join(f.root, "cwd"), "utf8").trim()).toBe(lane);
  expect(existsSync(join(lane, ".tap"))).toBe(false);
  const relaunched = spawnSync("bun", [join(repo, "runtime/bun/main.ts"), "session", "relaunch", "reviewer", "--json"],
    { cwd: f.root, env: f.env, encoding: "utf8", timeout: 60_000 });
  expect(relaunched.status, relaunched.stdout + relaunched.stderr).toBe(0);
  expect(JSON.parse(relaunched.stdout).results[0].status).toBe("resumed");
  expect(readFileSync(join(f.root, "cwd"), "utf8").trim().split("\n")).toEqual([lane, lane]);
  expect(JSON.parse(readFileSync(f.registry, "utf8")).seats.reviewer.launch_workdir).toBe(lane);
  expect(Object.keys(JSON.parse(readFileSync(join(f.root, "index/global-registry.json"), "utf8")).teams)).toEqual(["fixture"]);
  const listed = spawnSync("bun", [join(repo,"runtime/bun/main.ts"),"session","list","--json"], {cwd:f.root,env:f.env,encoding:"utf8",timeout:10000});
  expect(listed.status,listed.stderr).toBe(0); expect(JSON.parse(listed.stdout).sessions[0].cwd).toBe(lane);
  const moved = JSON.parse(readFileSync(f.registry,"utf8")); moved.seats.reviewer.launch_workdir = join(f.root,"missing");
  writeFileSync(f.registry,JSON.stringify(moved));
  const refused = spawnSync("bun", [join(repo,"runtime/bun/main.ts"),"session","relaunch","reviewer","--dry-run","--json"], {cwd:f.root,env:f.env,encoding:"utf8",timeout:10000});
  expect(refused.status).not.toBe(0); expect(JSON.parse(refused.stdout).results[0].error_class).toBe("invalid_workdir");
  expect(readFileSync(join(f.root,"cwd"),"utf8").trim().split("\n")).toEqual([lane,lane]);

}, 120_000);
