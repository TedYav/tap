import { Database } from "bun:sqlite";
import { createOpenCodeStore, addSession, addMessage } from "./support/opencode-store";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { removeScratchTree } from "./support/scratch";
import { observe, fitColumns, type RegistryRow } from "../src/verbs/team";
import { nextEligible } from "../src/verbs/attach";
import { observeAll, readRoster, trimRegistryLocked } from "../src/verbs/refresh";
import { tmuxSessionNamespace } from "../src/tmux";
import { TapError } from "../src/context";
import { SEAT_HARNESS_VALUES } from "../src/seat-filter";

const root = resolve(import.meta.dir, "../../..");
const shippedEntry = join(root, "bin/tap");
const scriptsDir = join(root, "skills/tap/scripts");
const realPython = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const realBun = spawnSync("sh", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim();
const TTY_RUNNER = String.raw`import fcntl, os, pty, struct, sys, termios
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(1, termios.TIOCSWINSZ, struct.pack("HHHH", 0, int(sys.argv[1]), 0, 0))
    err = os.environ.get("TTY_RUNNER_STDERR")
    if err:
        os.dup2(os.open(err, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 2)
    os.execv(sys.argv[2], sys.argv[2:])
chunks = []
while True:
    try:
        chunk = os.read(fd, 65536)
    except OSError:
        break
    if not chunk:
        break
    chunks.append(chunk)
os.close(fd)
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(b"".join(chunks))
raise SystemExit(os.waitstatus_to_exitcode(status))
`;
const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) removeScratchTree(path);
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tap-bun-team."));
  scratch.push(dir);
  const home = join(dir, "home");
  const index = join(dir, "index");
  const worktree = join(dir, "worktree");
  const bin = join(dir, "bin");
  const tmuxTmp = join(dir, "tmux-tmp");
  const trace = join(dir, "route.trace");
  mkdirSync(home, { recursive: true });
  mkdirSync(index, { recursive: true });
  // Born live (F1): an absent machine marker refuses before any selection.
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} }));
  mkdirSync(worktree, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(tmuxTmp, { recursive: true });
  spawnSync("git", ["init", "-q", worktree]);
  writeFileSync(join(worktree, "AGENTS.md"), "<!-- tap:begin -->\nTAP\n<!-- tap:end -->");

  const tmux = join(bin, "tmux");
  writeFileSync(tmux, `#!/bin/sh
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
  list-sessions)
    printf 'live-session\\t1:1\\t1\\n'
    ;;
  list-panes)
    printf 'live-session\\tlive-session:0.0\\t%%7\\tcodex\\t123\\t1:1\\t0\\n'
    ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });

  // The roster reads the compute queue for waiting evidence (tap-i5fzq): never
  // the machine's real queue. COMPUTE_QUEUE names a canned `--json queue` doc.
  writeFileSync(join(bin, "compute"), `#!/bin/sh
if [ -n "$COMPUTE_QUEUE" ]; then cat "$COMPUTE_QUEUE"; else printf '{"jobs":[]}\\n'; fi
`, { mode: 0o755 });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    TAP_INDEX_HOME: index,
    TAP_SESSION_MANIFEST: join(index, "sessions.json"),
    OPENCODE_DB_PATH: join(index, "opencode.db"),
    TAP_VERSION_SEEN_PATH: join(index, "version-seen.json"),
    TAP_TMUX_SOCKET: basename(dir),
    TMUX_TMPDIR: tmuxTmp,
    TAP_SERVER_EPOCH: "srv:1:1",
    TAP_BOOT_ID: "bootuuid:00000000-0000-0000-0000-000000000001",
    TAP_BOOT_ID_LEGACY: "boot:1",
    TAP_WATCH_NOW: "1787790000",
    TAP_ROSTER_CACHE_TTL: "0",
    TAP_BUN_ROUTE_TRACE: trace,
    COLUMNS: "200",
    NO_COLOR: "1",
  };
  delete env.TAP_HOME;
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.TAP_SELF;
  return { dir, env, home, index, worktree, trace };
}

function run(argv: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return spawnSync(shippedEntry, argv, { cwd, env, encoding: "utf8" });
}

function runTty(argv: string[], cwd: string, env: NodeJS.ProcessEnv, columns = 132) {
  const runEnv: NodeJS.ProcessEnv = { ...env, TERM: "xterm-256color" };
  delete runEnv.COLUMNS;
  return spawnSync("python3", ["-B", "-c", TTY_RUNNER, String(columns), shippedEntry, ...argv], {
    cwd, env: runEnv, encoding: "utf8",
  });
}

function seedPostFlip(
  f: ReturnType<typeof fixture>,
  seats: Record<string, unknown>,
  registryBytes?: string,
) {
  const dotTap = join(f.worktree, ".tap");
  const registry = join(dotTap, "team-registry.json");
  mkdirSync(dotTap, { recursive: true });
  writeFileSync(join(f.index, "global-registry.json"), JSON.stringify({
    schema: "0.20",
    teams: {
      roster: { root: f.worktree, registry_location: registry, state: "registered" },
    },
  }));
  writeFileSync(registry, registryBytes ?? JSON.stringify({
    schema: "0.20",
    team: { name: "roster", worktree_root: f.worktree },
    seats,
  }, null, 2) + "\n", { mode: 0o640 });
  chmodSync(registry, 0o640);
  return registry;
}

test("calibration preserves its roster when tmux activity cannot be observed", () => {
  const f = fixture();
  seedPostFlip(f, { reader: { status: "active", delivery: "poll", harness: "codex", pane: "%7" } });
  const ledger = join(f.dir, "ledger.md");
  writeFileSync(ledger, "## Routing table\n|handle|model @ harness|family|tier|\n|-|-|-|-|\n|reader|model @ codex|openai|advanced|\n");
  f.env.TAP_MODELS_LEDGER = ledger;
  replaceTmux(f, String.raw`while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$*" in
  *window_activity*) echo 'tmux: fork failed: Device not configured' >&2; exit 1 ;;
  *) exit 1 ;;
esac`);
  const result = run(["team", "calibration"], f.worktree, f.env);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/^reader\s+reader\s+model @ codex.*active.*-$/m);
  expect(result.stdout).toContain("IDLE is tmux window activity");
  expect(run(["team", "calibration", "--strongest"], f.worktree, f.env).stdout).toBe("reader\n");
});

// C4a: an old-format team registry is a typed old_store refusal (exit 1) on
// both surfaces, never a roster and never the generic unreadable envelope.
function expectOldStore(f: ReturnType<typeof fixture>) {
  const human = run(["team"], f.worktree, f.env);
  const json = run(["team", "--json"], f.worktree, f.env);
  expect(human.status, human.stderr).toBe(1);
  expect(human.stdout).toBe("");
  expect(human.stderr).toContain("is an old TAP registry format");
  expect(json.status, json.stderr).toBe(1);
  expect(json.stdout + json.stderr).toContain("old_store");
}

// Registry projection errors retain the public envelope/exit, not Python's
// incidental parser messages or traceback. Index/authority errors still use parity.
function expectRegistryUnreadable(f: ReturnType<typeof fixture>) {
  const human = run(["team"], f.worktree, f.env);
  const json = run(["team", "--json"], f.worktree, f.env);
  expect(human.status).not.toBe(0);
  expect(human.stdout).toBe("");
  expect(human.stderr).toContain("tap team: registry unreadable (");
  expect(human.stderr).toContain("run: tap doctor");
  expect(json.status).not.toBe(0);
  expect(json.stderr).toBe("");
  const receipt = JSON.parse(json.stdout);
  if (receipt.ok === false) {
    expect(receipt.error_class).toMatch(/registry|unreachable|invalid/);
    expect(receipt.detail).toEqual(expect.any(String));
  } else {
    expect(receipt).toEqual({ team: null, agents: [], error: expect.any(String) });
    expect(receipt.error.length).toBeGreaterThan(0);
  }
}


function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function replaceTmux(f: ReturnType<typeof fixture>, body: string): void {
  writeFileSync(join(f.dir, "bin", "tmux"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

function writeCatalog(f: ReturnType<typeof fixture>, body: string): void {
  const dir = join(f.home, ".config", "tap");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.toml"), body);
}

describe("native team roster", () => {
  test("legacy roster projections classify live, gone, stale, and poll rows", () => {
    const f = fixture();
    const registry = seedPostFlip(f, {
      live: {
        status: "active", delivery: "pane", pane: "live-session:0.0", pane_id: "%7",
        session: "live-session", server_epoch: "srv:1:1", harness: "codex",
      },
      gone: {
        status: "active", delivery: "pane", pane: "gone-session:0.0", pane_id: "%8",
        session: "gone-session", server_epoch: "srv:1:1", harness: "codex",
      },
      stale: {
        status: "suspended", status_reason: "server_restarted", delivery: "pane",
        pane: "stale-session:0.0", pane_id: "%9", session: "stale-session", harness: "codex",
      },
      pollbot: { status: "active", delivery: "poll", harness: "daemon", unattended: true },
    });
    const before = readFileSync(registry);
    const beforeMode = mode(registry);

    const json = run(["team", "--json"], f.worktree, f.env);
    expect(json.status, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout).agents.map((a: any) => [a.handle, a.status]).sort()).toEqual([["gone", "gone"], ["live", "active"], ["pollbot", "active"], ["stale", "offline"]]);
    // A row the census never read says so instead of looking measured or empty.
    expect(JSON.parse(json.stdout).agents.find((a: any) => a.handle === "stale").context_unknown_reason).toBe("not_sampled");
    const all = run(["team", "--all"], f.worktree, f.env);
    expect(all.status, all.stderr).toBe(0);
    expect(all.stdout).toBe(
      "tap team: roster\n"
      + "handle   kind  harness  pane               status   attached  unattended  reason            notes/asks\n"
      + "gone     SEAT  codex    gone-session:0.0   gone     no        no          session_absent    10s/10s\n"
      + "live     SEAT  codex    live-session:0.0   active   yes       no                            10s/10s\n"
      + "stale    SEAT  codex    stale-session:0.0  offline  no        no          server_restarted  10s/10s\n"
      + "pollbot  SEAT  daemon                      active   no        yes         stored_status     10s/10s\n",
    );
    const names = run(["team", "--names"], f.worktree, f.env);
    expect(names.status, names.stderr).toBe(0);
    expect(names.stdout).toBe("gone\nlive\npollbot\nstale\n");
    const namesActive = run(["team", "--names", "--online"], f.worktree, f.env);
    expect(namesActive.status, namesActive.stderr).toBe(0);
    expect(namesActive.stdout).toBe("live\n");

    expect(readFileSync(registry)).toEqual(before);
    expect(mode(registry)).toBe(beforeMode);
    expect(readFileSync(f.trace, "utf8")).toBe("native team\n".repeat(4));
  }, 30_000);

  test("read-only roster observation does not require writable tmux rate-cache state", () => {
    const f = fixture();
    seedPostFlip(f, {
      live: {
        status: "active", delivery: "pane", pane: "live-session:0.0", pane_id: "%7",
        session: "live-session", server_epoch: "srv:1:1", harness: "codex",
      },
    });
    chmodSync(f.index, 0o555);
    try {
      const r = run(["team", "--json"], f.worktree, f.env);
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout).agents.map((a: any) => [a.handle, a.status])).toEqual([["live", "active"]]);
    } finally {
      chmodSync(f.index, 0o755);
    }
  }, 30_000);

  test("Codex roster uses the painted composer and pane title without a status-line contract", () => {
    const f = fixture();
    const capturePath = join(f.dir, "frame.ansi"), titlePath = join(f.dir, "title");
    const tmuxTrace = join(f.dir, "tmux.trace");
    f.env.STATE_FRAME = capturePath; f.env.STATE_TITLE = titlePath; f.env.TMUX_TRACE = tmuxTrace;
    replaceTmux(f, String.raw`
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
printf '%s\n' "$*" >> "$TMUX_TRACE"
case "$1" in
  list-sessions) printf 'live-session\t1:1\t1\n' ;;
  list-panes)
    if [ "$TITLE_IN_LIST" = yes ]; then
      printf 'live-session\tlive-session:0.0\t%%7\tcodex\t123\t1:1\t0\t\t\t'; cat "$STATE_TITLE"
    else printf 'live-session\tlive-session:0.0\t%%7\tcodex\t123\t1:1\t0\n'; fi ;;
  capture-pane) cat "$STATE_FRAME" ;;
  display-message) case "$*" in *pane_title*) cat "$STATE_TITLE" ;; *) printf '1:1\n' ;; esac ;;
  *) exit 1 ;;
esac`);
    seedPostFlip(f, { live: { status: "active", delivery: "pane", pane: "live-session:0.0", pane_id: "%7",
      session: "live-session", server_epoch: "srv:1:1", harness: "codex" } });
    const observed = () => {
      const result = run(["team", "--json"], f.worktree, f.env);
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout).agents[0];
    };
    const captured = readFileSync(join(root, "runtime/bun/test/fixtures/agent-state/codex/fresh-warning-fast.ansi"), "utf8");
    writeFileSync(capturePath, captured); writeFileSync(titlePath, "DemoProject\n");
    expect(observed()).toMatchObject({ agent_state: "idle", agent_state_reason: "prompt_idle" });
    writeFileSync(titlePath, "⠹ DemoProject\n");
    expect(observed()).toMatchObject({ agent_state: "working", agent_state_reason: "title_working" });
    writeFileSync(titlePath, "DemoProject\n");
    writeFileSync(capturePath, "› human draft\nmy custom footer\n");
    expect(observed()).toMatchObject({ agent_state: "unknown", agent_state_reason: "no_matching_rule" });
    writeFileSync(capturePath, captured); f.env.STATE_TITLE = join(f.dir, "absent-title");
    expect(observed()).toMatchObject({ agent_state: "unknown", agent_state_reason: "capture_failed" });
    const trace = readFileSync(tmuxTrace, "utf8");
    expect(trace).toContain("capture-pane -e -p -t %7");
    expect(trace).toContain("display-message -p -t %7 #{pane_title}");
    f.env.TITLE_IN_LIST = "yes"; f.env.STATE_TITLE = titlePath;
    writeFileSync(titlePath, "⠹ DemoProject\n"); writeFileSync(tmuxTrace, "");
    expect(observed()).toMatchObject({agent_state:"working", agent_state_reason:"title_working"});
    expect(readFileSync(tmuxTrace, "utf8")).not.toContain("display-message -p -t %7 #{pane_title}");
  }, 30_000);

  test("default human reports agent state with additive context JSON fields", () => {
    const f = fixture();
    delete f.env.TAP_SERVER_EPOCH;
    const tmuxTrace = join(f.dir, "tmux.trace");
    f.env.TMUX_TRACE = tmuxTrace;
    const capturePath = join(f.dir, "state-frame");
    f.env.STATE_FRAME = capturePath;
    writeFileSync(capturePath, "Allow command?\n");
    replaceTmux(f, String.raw`
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
printf '%s\n' "$*" >> "$TMUX_TRACE"
case "$1" in
  list-sessions) printf 'live-session\t1:1\t1\n' ;;
  list-panes) printf 'live-session\tlive-session:1.0\t%%7\tcodex\t123\t1:1\t0\n' ;;
  capture-pane) cat "$STATE_FRAME" ;;
  display-message) printf '1:1\n' ;;
  *) exit 1 ;;
esac`);
    seedPostFlip(f, {
      live: {
        status: "active", delivery: "pane", pane: "live-session:0.0", pane_id: "%7",
        session: "live-session", server_epoch: "srv:1:1", harness: "codex",
      },
    });

    writeFileSync(tmuxTrace, "");
    const result = run(["team", "--json"], f.worktree, f.env);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).agents[0]).toMatchObject({handle:"live", agent_state:"blocked", context_used_percent:null, context_source:null, attached:"1"});
    expect(JSON.parse(result.stdout).agents[0].sampled_at).toMatch(/^\d{4}-/);
    expect(readFileSync(tmuxTrace, "utf8").match(/capture-pane/g)).toHaveLength(1);

    writeFileSync(tmuxTrace, "");
    const human = run(["team"], f.worktree, f.env);
    expect(human.status).toBe(0);
    expect(human.stderr).toBe("");
    expect(human.stdout).toMatch(/handle\s+harness\s+state\s+context\s+family\s+model\s+preset(?:\s|$)/);
    expect(human.stdout).not.toMatch(/handle\s+harness\s+status\s+agent/);
    expect(human.stdout).not.toMatch(/\sroles(?:\s|$)/);
    expect(human.stdout).toMatch(/live\s+codex\s+● blocked\s+—\s+openai\s+\?\s+n\/a/);
    const trace = readFileSync(tmuxTrace, "utf8");
    expect(trace.match(/capture-pane/g)).toHaveLength(1);
    expect(trace).toContain("capture-pane -e -p -t %7");
    writeFileSync(tmuxTrace, "");
    expect(run(["team", "roster"], f.worktree, f.env).stdout).toBe(human.stdout);
    expect(readFileSync(tmuxTrace, "utf8").match(/capture-pane/g)).toHaveLength(1);
    writeFileSync(capturePath, readFileSync(join(import.meta.dir, "fixtures/agent-state/errors/codex-usage-limit.ansi"), "utf8"));
    expect(run(["team"], f.worktree, f.env).stdout).toContain("● error");
    expect(JSON.parse(run(["team", "--json"], f.worktree, f.env).stdout).agents[0])
      .toMatchObject({ agent_state: "error", agent_state_reason: "usage_limit" });
  }, 30_000);

  test("an ended turn that owns background work reads waiting, aged from its dated turn end (tap-i5fzq)", () => {
    const f = fixture();
    const capturePath = join(f.dir, "frame.txt"), queuePath = join(f.dir, "queue.json");
    f.env.STATE_FRAME = capturePath;
    replaceTmux(f, String.raw`
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
  list-sessions) printf 'live-session\t1:1\t1\n' ;;
  list-panes) printf 'live-session\tlive-session:0.0\t%%7\tclaude\t123\t1:1\t0\n' ;;
  capture-pane) cat "$STATE_FRAME" ;;
  display-message) printf '1:1\n' ;;
  *) exit 1 ;;
esac`);
    // The turn's own end_turn record dates it (00:05:00, 15m before TAP_WATCH_NOW).
    // The file's later mtime is a last-write time and never the date (team-wait review, round 1).
    const transcript = join(f.dir, "claude.jsonl");
    const endTurn = JSON.stringify({ type: "assistant", timestamp: "2026-08-27T00:05:00.000Z", message: { stop_reason: "end_turn" } });
    writeFileSync(transcript, `${endTurn}\n${JSON.stringify({ type: "system", subtype: "turn_duration" })}\n`);
    utimesSync(transcript, 1787789400, 1787789400);
    seedPostFlip(f, { live: { status: "active", delivery: "pane", pane: "live-session:0.0", pane_id: "%7",
      session: "live-session", server_epoch: "srv:1:1", harness: "claude", transcript_path: transcript } });
    const rule = "─".repeat(40);
    const frame = (above: string, footer: string) =>
      `⏺ history\n${above}\n${rule} roster/live ─\n❯ \n${rule}\n  Opus 5.5 med | status\n${footer}\n`;
    const observed = () => {
      const r = run(["team", "--json"], f.worktree, f.env);
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(r.stdout).agents[0];
    };

    writeFileSync(capturePath, frame("✻ Baked for 1m 29s · done 12:05 AM · 1 shell still running", "  ⏵⏵ bypass permissions on · 1 shell · ← 3 agents"));
    expect(observed()).toMatchObject({ agent_state: "waiting", agent_state_reason: "background_shells",
      waiting_on: [{ kind: "shell", count: 1 }], turn_started_at: null,
      turn_ended_at: "2026-08-27T00:05:00Z", turn_ended_source: "transcript" });
    expect(run(["team"], f.worktree, f.env).stdout).toMatch(/live\s+claude\s+● waiting 15m\s/);

    // The shells finished: idle, with the same turn-end age.
    writeFileSync(capturePath, frame("✻ Baked for 1m 29s · done 12:05 AM", "  ⏵⏵ bypass permissions on · ← 3 agents"));
    expect(observed()).toMatchObject({ agent_state: "idle", waiting_on: [], turn_ended_at: "2026-08-27T00:05:00Z" });
    expect(run(["team"], f.worktree, f.env).stdout).toMatch(/live\s+claude\s+● idle 15m\s/);

    // A transcript whose last entry is a user turn has no ended turn to date.
    writeFileSync(transcript, `${endTurn}\n${JSON.stringify({ type: "user", timestamp: "2026-08-27T00:06:00.000Z", message: {} })}\n`);
    expect(observed()).toMatchObject({ agent_state: "idle", turn_ended_at: null, turn_ended_source: null });
    expect(run(["team"], f.worktree, f.env).stdout).toMatch(/live\s+claude\s+● idle\s{2,}/);
    writeFileSync(transcript, `${endTurn}\n`);

    // A compute job that will wake this seat's current pane.
    f.env.COMPUTE_QUEUE = queuePath;
    writeFileSync(queuePath, JSON.stringify({ jobs: [
      { id: "c1", status: "running", notify_done: "roster/live", released_at: null, identity: JSON.stringify({ pane_id: "%7" }) },
      { id: "c2", status: "running", notify_done: null, requester: "roster/live", identity: JSON.stringify({ pane_id: "%7" }) },
    ] }));
    expect(observed()).toMatchObject({ agent_state: "waiting", agent_state_reason: "compute", waiting_on: [{ kind: "compute", id: "c1" }] });

    // A running turn: the spinner is working, aged from its elapsed clock.
    writeFileSync(capturePath, frame("✢ Crystallizing… (3m 0s · ↓ 5k tokens)", "  ⏵⏵ bypass permissions on · ← 3 agents"));
    expect(observed()).toMatchObject({ agent_state: "working", agent_state_reason: "spinner_working",
      waiting_on: [], turn_started_at: "2026-08-27T00:17:00Z", turn_ended_at: null });
    expect(run(["team"], f.worktree, f.env).stdout).toMatch(/live\s+claude\s+● working 3m\s/);

  }, 60_000);

  test("a Codex turn end dates idle only through a transcript bound to this session (tap-i5fzq)", () => {
    const f = fixture();
    const capturePath = join(f.dir, "frame.ansi"), titlePath = join(f.dir, "title");
    f.env.STATE_FRAME = capturePath; f.env.STATE_TITLE = titlePath;
    replaceTmux(f, String.raw`
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
  list-sessions) printf 'live-session\t1:1\t1\n' ;;
  list-panes) printf 'live-session\tlive-session:0.0\t%%7\tcodex\t123\t1:1\t0\n' ;;
  capture-pane) cat "$STATE_FRAME" ;;
  display-message) case "$*" in *pane_title*) cat "$STATE_TITLE" ;; *) printf '1:1\n' ;; esac ;;
  *) exit 1 ;;
esac`);
    writeFileSync(capturePath, readFileSync(join(root, "runtime/bun/test/fixtures/agent-state/codex/fresh-warning-fast.ansi"), "utf8"));
    writeFileSync(titlePath, "DemoProject\n");
    const transcript = join(f.dir, "codex.jsonl");
    writeFileSync(transcript, [
      { type: "session_meta", payload: { id: "seat" } },
      { type: "event_msg", timestamp: "2026-08-27T00:10:00.000Z", payload: { type: "task_complete" } },
    ].map(e => JSON.stringify(e)).join("\n") + "\n");
    const observed = (sessionId: string) => {
      seedPostFlip(f, { live: { status: "active", delivery: "pane", pane: "live-session:0.0", pane_id: "%7",
        session: "live-session", server_epoch: "srv:1:1", harness: "codex", harness_session_id: sessionId, transcript_path: transcript } });
      const r = run(["team", "--json"], f.worktree, f.env);
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(r.stdout).agents[0];
    };
    expect(observed("seat")).toMatchObject({ agent_state: "idle", turn_ended_at: "2026-08-27T00:10:00Z", turn_ended_source: "transcript" });
    // A damaged binding names another session's transcript: its turn end is not this seat's.
    expect(observed("other")).toMatchObject({ agent_state: "idle", turn_ended_at: null, turn_ended_source: null });
  }, 60_000);

  test("model column prefers transcript-observed tuning and marks the launch fallback", () => {
    const f = fixture();
    const transcript = join(f.dir, "codex.jsonl");
    writeFileSync(transcript, [
      {type:"session_meta",payload:{id:"obs"}},
      {type:"turn_context",timestamp:"2026-09-26T03:00:00Z",payload:{model:"gpt-6-astra",effort:"high"}},
      {type:"turn_context",timestamp:"2026-09-26T04:00:00Z",payload:{model:"gpt-6-astra",effort:"xhigh"}},
      {type:"event_msg",timestamp:"2026-09-26T04:01:00Z",payload:{type:"token_count",info:{model_context_window:380000,last_token_usage:{input_tokens:84000}}}},
    ].map(e => JSON.stringify(e)).join("\n") + "\n");
    const compacted = join(f.dir, "codex-compacted.jsonl");
    writeFileSync(compacted, [
      {type:"session_meta",payload:{id:"cpx"}},
      {type:"turn_context",timestamp:"2026-09-26T02:00:00Z",payload:{model:"gpt-6-astra",effort:"high"}},
      {type:"event_msg",timestamp:"2026-09-26T02:01:00Z",payload:{type:"token_count",info:{model_context_window:380000,last_token_usage:{input_tokens:10000}}}},
      {type:"event_msg",timestamp:"2026-09-26T02:02:00Z",payload:{type:"context_compacted"}},
    ].map(e => JSON.stringify(e)).join("\n") + "\n");
    replaceTmux(f, `
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
  list-sessions) printf 'observed-session\\t1:1\\t1\\nfallback-session\\t1:1\\t1\\ncompacted-session\\t1:1\\t1\\n' ;;
  list-panes) printf 'observed-session\\tobserved-session:0.0\\t%%7\\tcodex\\t123\\t1:1\\t0\\nfallback-session\\tfallback-session:0.0\\t%%8\\tcodex\\t124\\t1:1\\t0\\ncompacted-session\\tcompacted-session:0.0\\t%%9\\tcodex\\t125\\t1:1\\t0\\n' ;;
  capture-pane) cat '${join(root, "runtime/bun/test/fixtures/agent-state/codex/working.txt")}' ;;
  display-message) case "$*" in *pane_title*) printf '\\342\\240\\271 roster\\n' ;; *) printf '0\\n' ;; esac ;;
  *) exit 1 ;;
esac`);
    seedPostFlip(f, {
      compacted: { status: "active", delivery: "pane", pane: "compacted-session:0.0", pane_id: "%9",
        session: "compacted-session", server_epoch: "srv:1:1", harness: "codex", harness_session_id: "cpx", transcript_path: compacted },
      fallback: { status: "active", delivery: "pane", pane: "fallback-session:0.0", pane_id: "%8",
        session: "fallback-session", server_epoch: "srv:1:1", harness: "codex", launch_tuning: { model: "fable", effort: "high" } },
      observed: { status: "active", delivery: "pane", pane: "observed-session:0.0", pane_id: "%7",
        session: "observed-session", server_epoch: "srv:1:1", harness: "codex", harness_session_id: "obs", transcript_path: transcript },
    });
    const result = run(["team"], f.worktree, f.env);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[1]!.trimEnd().split(/\s{2,}/)).toEqual(["handle", "harness", "state", "context", "family", "model", "preset"]);
    const rows = Object.fromEntries(lines.slice(2).map((line) => {
      const cells = line.trimEnd().split(/\s{2,}/);
      return [cells[0], [cells[3], ...cells.slice(5)]];
    }));
    // Human cells show the short name; the JSON below keeps the raw observed id.
    expect(rows.observed).toEqual(["84k/380k", "astra6@xhigh", "n/a"]);
    expect(rows.fallback).toEqual(["—", "fable@high (launch)", "n/a"]);
    expect(rows.compacted).toEqual(["—", "astra6@high", "n/a"]);
    const agents = Object.fromEntries(JSON.parse(run(["team", "--json"], f.worktree, f.env).stdout).agents.map((a: { handle: string }) => [a.handle, a]));
    expect(agents.observed).toMatchObject({model: null, effort: null, observed_model: "gpt-6-astra", observed_effort: "xhigh", observed_at: "2026-09-26T04:00:00Z"});
    expect(agents.observed.context_tokens).toEqual({input_tokens: 84000, observed_at: "2026-09-26T04:01:00Z", source: "codex_transcript",
      window_tokens: 380000, window_source: "codex_reported_window", used_percent: 22, percent_source: "codex_reported_window", unknown_reason: null});
    expect(Object.hasOwn(agents.observed.context_tokens, "tuning")).toBe(false);
    expect(agents.fallback).toMatchObject({model: "fable", effort: "high", launch_tuning: {model: "fable", effort: "high"},
      observed_model: null, observed_effort: null, observed_at: null});
    // Tuning outlives the usage verdict: a compacted transcript has null
    // context_tokens yet still reports the observed model/effort in JSON.
    expect(agents.compacted.context_tokens).toBeNull();
    // An unknown count states why; a measured one carries no reason (tap-83tfx).
    expect(agents.compacted.context_unknown_reason).toBe("awaiting_usage_after_compact");
    expect(agents.fallback.context_unknown_reason).toBe("unbound_transcript");
    expect(agents.observed.context_unknown_reason).toBeNull();
    expect(agents.compacted).toMatchObject({observed_model: "gpt-6-astra", observed_effort: "high", observed_at: "2026-09-26T02:00:00Z"});
  }, 30_000);

  test("default human keeps lifecycle and agent-state polarity with bounded capture", () => {
    const f = fixture();
    const tmuxTrace = join(f.dir, "tmux.trace");
    f.env.TMUX_TRACE = tmuxTrace;
    replaceTmux(f, String.raw`
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
printf '%s\n' "$*" >> "$TMUX_TRACE"
case "$1" in
  list-sessions)
    printf 'working-session\t1:1\t0\nblocked-session\t1:1\t0\nidle-session\t1:1\t0\nunknown-session\t1:1\t0\nfailed-session\t1:1\t0\nunsupported-session\t1:1\t0\n'
    ;;
  list-panes)
    printf 'working-session\tworking-session:0.0\t%%1\tcodex\t101\t1:1\t0\nblocked-session\tblocked-session:0.0\t%%2\tcodex\t102\t1:1\t0\nidle-session\tidle-session:0.0\t%%3\tcodex\t103\t1:1\t0\nunknown-session\tunknown-session:0.0\t%%4\tcodex\t104\t1:1\t0\nfailed-session\tfailed-session:0.0\t%%5\tcodex\t105\t1:1\t0\nunsupported-session\tunsupported-session:0.0\t%%6\tmystery\t106\t1:1\t0\n'
    ;;
  capture-pane)
    case "$*" in
      *'-t %1') cat '${join(root, "runtime/bun/test/fixtures/agent-state/codex/working.txt")}' ;;
      *'-t %2') cat '${join(root, "runtime/bun/test/fixtures/agent-state/codex/blocked.txt")}' ;;
      *'-t %3') cat '${join(root, "runtime/bun/test/fixtures/agent-state/codex/idle.ansi")}' ;;
      *'-t %4') printf 'ordinary output\n' ;;
      *'-t %5') exit 1 ;;
      *) exit 1 ;;
    esac
    ;;
  display-message)
    case "$*" in
      *'pane_title'*) case "$*" in *'-t %1 '*) printf '\342\240\271 roster\n' ;; *) printf 'roster\n' ;; esac ;;
      *) printf '1:1\n' ;;
    esac ;;

  *) exit 1 ;;
esac`);
    seedPostFlip(f, {
      working: {
        status: "active", delivery: "pane", pane: "working-session:0.0", pane_id: "%1",
        session: "working-session", server_epoch: "srv:1:1", harness: "codex",
      },
      blocked: {
        status: "active", delivery: "pane", pane: "blocked-session:0.0", pane_id: "%2",
        session: "blocked-session", server_epoch: "srv:1:1", harness: "codex",
      },
      idle: {
        status: "active", delivery: "pane", pane: "idle-session:0.0", pane_id: "%3",
        session: "idle-session", server_epoch: "srv:1:1", harness: "codex",
      },
      unknown_active: {
        status: "active", delivery: "pane", pane: "unknown-session:0.0", pane_id: "%4",
        session: "unknown-session", server_epoch: "srv:1:1", harness: "codex",
      },
      capture_failed: {
        status: "active", delivery: "pane", pane: "failed-session:0.0", pane_id: "%5",
        session: "failed-session", server_epoch: "srv:1:1", harness: "codex",
      },
      unsupported: {
        status: "active", delivery: "pane", pane: "unsupported-session:0.0", pane_id: "%6",
        session: "unsupported-session", server_epoch: "srv:1:1", harness: "mystery",
      },
      pane_less: { status: "active", delivery: "pane", harness: "codex" },
      poll: { status: "active", delivery: "poll", harness: "daemon" },
      offline_known: {
        status: "suspended", delivery: "pane", pane: "stale-session:0.0", pane_id: "%9",
        session: "stale-session", server_epoch: "srv:1:1", harness: "codex",
      },
      offline_gone: {
        status: "active", delivery: "pane", pane: "missing-session:0.0", pane_id: "%10",
        session: "missing-session", server_epoch: "srv:1:1", harness: "codex",
      },
    });

    const result = run(["team"], f.worktree, f.env);
    expect(result.status).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[1]!.trimEnd().split(/\s{2,}/)).toEqual(["handle", "harness", "state", "context", "family", "model", "preset"]);
    const rows = Object.fromEntries(lines.slice(2).map((line) => {
      const cells = line.trimEnd().split(/\s{2,}/);
      return [cells[0], cells[2]];
    }));
    // Lethal: forcing the active arm to `unknown` fails working/blocked/idle.
    expect(rows.working, readFileSync(tmuxTrace, "utf8")).toBe("● working");
    expect(rows.blocked).toBe("● blocked");
    expect(rows.idle).toBe("● idle");
    expect(rows.unknown_active).toBe("● unknown");
    expect(rows.capture_failed).toBe("● unknown");
    // Lethal: dropping the lifecycle guard lets gone/suspended/non-active rows
    // print agent_state (`unknown`) instead of `offline`.
    expect(rows.unsupported).toBe("● offline");
    expect(rows.pane_less).toBe("● offline");
    expect(rows.poll).toBe("● ready");
    expect(rows.offline_known).toBe("● offline");
    expect(rows.offline_gone).toBe("● offline");
    expect(result.stderr).not.toContain("gone seats detected");
    const wide = run(["team", "--all"], f.worktree, f.env);
    expect(wide.stdout).toMatch(/handle\s+kind\s+harness\s+pane\s+status\s+attached\s+unattended\s+reason/);
    expect(wide.stdout).toMatch(/working\s+SEAT\s+codex\s+\S+\s+active\s+/);
    expect(wide.stdout).toMatch(/offline_known\s+SEAT\s+codex\s+\S+\s+suspended\s+/);
    expect(wide.stdout).toMatch(/offline_gone\s+SEAT\s+codex\s+\S+\s+gone\s+/);
    const names = run(["team", "--names"], f.worktree, f.env);
    expect(names.stdout.split("\n").filter(Boolean).sort()).toEqual([
      "blocked", "capture_failed", "idle", "offline_gone", "offline_known",
      "pane_less", "poll", "unknown_active", "unsupported", "working",
    ].sort());
    const trace = readFileSync(tmuxTrace, "utf8");
    expect(trace.match(/capture-pane/g)).toHaveLength(5);
    for (const pane of ["%6", "%9", "%10"]) expect(trace).not.toContain(`capture-pane -e -p -t ${pane}`);
    expect(wide.stderr).not.toContain("gone seats detected");
    const json = run(["team", "--json"], f.worktree, f.env);
    expect(json.status, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout).agents.map((a: any) => [a.handle, a.agent_state]).sort()).toEqual([
      ["blocked", "blocked"], ["capture_failed", "unknown"], ["idle", "idle"], ["offline_gone", "unknown"],
      ["offline_known", "unknown"], ["pane_less", "unknown"], ["poll", "unknown"], ["unknown_active", "unknown"],
      ["unsupported", "unknown"], ["working", "working"],
    ]);
  }, 60_000);

  test("all, names, and crew projections perform no agent-state capture", () => {
    const f = fixture();
    const tmuxTrace = join(f.dir, "tmux.trace");
    f.env.TMUX_TRACE = tmuxTrace;
    replaceTmux(f, String.raw`
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
printf '%s\n' "$*" >> "$TMUX_TRACE"
case "$1" in
  list-sessions) printf 'live-session\t1:1\t1\n' ;;
  list-panes) printf 'live-session\tlive-session:0.0\t%%7\tcodex\t123\t1:1\t0\n' ;;
  capture-pane) printf 'Allow command?\n' ;;
  display-message) printf '1:1\n' ;;
  *) exit 1 ;;
esac`);
    seedPostFlip(f, {
      live: {
        status: "active", delivery: "pane", pane: "live-session:0.0", pane_id: "%7",
        session: "live-session", server_epoch: "srv:1:1", harness: "codex", crew: true,
      },
    });

    for (const argv of [["team", "--all"], ["team", "--names"], ["team", "--names", "--online"]]) {
      writeFileSync(tmuxTrace, "");
      expect(run(argv, f.worktree, f.env).status).toBe(0);
      expect(readFileSync(tmuxTrace, "utf8")).not.toContain("capture-pane");
    }
    writeFileSync(tmuxTrace, "");
    expect(run(["team"], f.worktree, { ...f.env, TAP_TEAM_CREW_ONLY: "1" }).status).toBe(0);
    expect(readFileSync(tmuxTrace, "utf8")).not.toContain("capture-pane");
  }, 30_000);

  test("TTY color changes only the agent dot and NO_COLOR presence disables it", () => {
    const f = fixture();
    const setCapture = (command: string, title = "roster"): void => replaceTmux(f, `
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
  list-sessions) printf 'live-session\\t1:1\\t1\\n' ;;
  list-panes) printf 'live-session\\tlive-session:0.0\\t%%7\\tcodex\\t123\\t1:1\\t0\\n' ;;
  capture-pane) ${command} ;;
  display-message) case \"$*\" in *pane_title*) printf '%s\\n' '${title}' ;; *) printf '1:1\\n' ;; esac ;;
  *) exit 1 ;;
esac`);
    setCapture("printf 'Allow command?\\n'");
    seedPostFlip(f, {
      live: {
        status: "active", delivery: "pane", pane: "live-session:0.0", pane_id: "%7",
        session: "live-session", server_epoch: "srv:1:1", harness: "codex",
      },
      offline: {
        status: "suspended", delivery: "pane", pane: "offline-session:0.0", pane_id: "%8",
        session: "offline-session", server_epoch: "srv:1:1", harness: "codex",
      },
    });

    const pipeColorEnv = { ...f.env };
    delete pipeColorEnv.NO_COLOR;
    const piped = run(["team"], f.worktree, pipeColorEnv);
    const plain = run(["team"], f.worktree, f.env);
    const ttyNoColor = runTty(["team"], f.worktree, { ...f.env, NO_COLOR: "" });
    const ttyColorEnv = { ...f.env };
    delete ttyColorEnv.NO_COLOR;
    const colored = runTty(["team"], f.worktree, ttyColorEnv);
    expect(piped.stdout).not.toContain("\x1b[");
    expect(plain.stdout).not.toContain("\x1b[");
    expect(piped.stdout).toBe(plain.stdout);
    expect(ttyNoColor.stdout).not.toContain("\x1b[");
    expect(plain.stdout).toContain("● blocked");
    expect(colored.stdout).toContain("\x1b[31m●\x1b[0m blocked");
    expect(colored.stdout).toContain("\x1b[90m●\x1b[0m offline");
    const stripAnsi = (value: string): string => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replaceAll("\r", "");
    expect(stripAnsi(colored.stdout)).toBe(ttyNoColor.stdout.replaceAll("\r", ""));
    setCapture(`cat '${join(root, "runtime/bun/test/fixtures/agent-state/codex/working.txt")}'`, "⠹ roster");
    expect(runTty(["team"], f.worktree, ttyColorEnv).stdout).toContain("\x1b[32m●\x1b[0m working");
    setCapture(`cat '${join(root, "runtime/bun/test/fixtures/agent-state/codex/idle.ansi")}'`);
    expect(runTty(["team"], f.worktree, ttyColorEnv).stdout).toContain("\x1b[34m●\x1b[0m idle");
    setCapture("printf 'ordinary output\\n'");
    expect(runTty(["team"], f.worktree, ttyColorEnv).stdout).toContain("\x1b[33m●\x1b[0m unknown");
  }, 30_000);

  test("JSON fails closed when a moved pane's old address is reused", () => {
    const f = fixture();
    const tmuxTrace = join(f.dir, "tmux.trace");
    f.env.TMUX_TRACE = tmuxTrace;
    replaceTmux(f, String.raw`
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
printf '%s\n' "$*" >> "$TMUX_TRACE"
case "$1" in
  list-sessions) printf 'live-session\t1:1\t1\n' ;;
  list-panes) printf 'live-session\tlive-session:1.0\t%%7\tcodex\t123\t1:1\t0\n' ;;
  capture-pane)
    case "$*" in
      *'-t %7') exit 1 ;;
      *'-t live-session:1.0') printf '%s\n' 'Allow command?' ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 1 ;;
esac`);
    seedPostFlip(f, {
      live: {
        status: "active", delivery: "pane", pane: "live-session:0.0", pane_id: "%7",
        session: "live-session", server_epoch: "srv:1:1", harness: "codex",
      },
    });

    const result = run(["team", "--json"], f.worktree, f.env);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).agents[0]).toMatchObject({
      pane: "live-session:0.0",
      status: "active",
      agent_state: "unknown",
      agent_state_reason: "capture_failed",
    });
    const trace = readFileSync(tmuxTrace, "utf8");
    expect(trace).toContain("capture-pane -e -p -t %7");
    expect(trace).not.toContain("capture-pane -e -p -t live-session:1.0");
  }, 30_000);

  test("JSON rejects captured content when the tmux server generation changes", () => {
    const f = fixture();
    delete f.env.TAP_SERVER_EPOCH;
    const tmuxTrace = join(f.dir, "tmux.trace");
    f.env.TMUX_TRACE = tmuxTrace;
    replaceTmux(f, String.raw`
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
printf '%s\n' "$*" >> "$TMUX_TRACE"
case "$1" in
  list-sessions) printf 'live-session\t1:1\t1\n' ;;
  list-panes) printf 'live-session\tlive-session:0.0\t%%7\tcodex\t123\t1:1\t0\n' ;;
  capture-pane) printf '%s\n' 'Allow command?' ;;
  display-message) printf '2:2\n' ;;
  *) exit 1 ;;
esac`);
    seedPostFlip(f, {
      live: {
        status: "active", delivery: "pane", pane: "live-session:0.0", pane_id: "%7",
        session: "live-session", server_epoch: "srv:1:1", harness: "codex",
      },
    });

    const result = run(["team", "--json"], f.worktree, f.env);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).agents[0]).toMatchObject({
      status: "active",
      agent_state: "unknown",
      agent_state_reason: "capture_failed",
    });
    const trace = readFileSync(tmuxTrace, "utf8");
    expect(trace.match(/capture-pane/g)).toHaveLength(1);
    expect(trace).toContain("capture-pane -e -p -t %7");
    expect(trace).toContain("display-message -p #{pid}:#{start_time}");
  }, 30_000);

  test("JSON agent-state failures are typed and do not capture rows that cannot be read", () => {
    const f = fixture();
    const tmuxTrace = join(f.dir, "tmux.trace");
    f.env.TMUX_TRACE = tmuxTrace;
    replaceTmux(f, String.raw`
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
printf '%s\n' "$*" >> "$TMUX_TRACE"
case "$1" in
  list-sessions) printf 'live-session\t1:1\t1\n' ;;
  list-panes) printf 'live-session\tlive-session:0.0\t%%7\tcodex\t123\t1:1\t0\n' ;;
  capture-pane) exit 1 ;;
  *) exit 1 ;;
esac`);
    seedPostFlip(f, {
      capture_failed: {
        status: "active", delivery: "pane", pane: "live-session:0.0", pane_id: "%7",
        session: "live-session", server_epoch: "srv:1:1", harness: "codex",
      },
      no_pane: { status: "active", delivery: "poll", harness: "daemon" },
      unsupported: {
        status: "active", delivery: "pane", pane: "missing-session:0.0", pane_id: "%8",
        session: "missing-session", server_epoch: "srv:1:1", harness: "mystery",
      },
      unreadable: {
        status: "active", delivery: "pane", pane: "missing-session:0.1", pane_id: "%9",
        session: "missing-session", server_epoch: "srv:1:1", harness: "claude",
      },
    });

    const result = run(["team", "--json"], f.worktree, f.env);
    expect(result.status).toBe(0);
    const rows = Object.fromEntries(JSON.parse(result.stdout).agents.map((row: Record<string, string>) => [row.handle, row]));
    expect(rows.capture_failed).toMatchObject({ agent_state: "unknown", agent_state_reason: "capture_failed" });
    expect(rows.no_pane).toMatchObject({ agent_state: "unknown", agent_state_reason: "no_pane" });
    expect(rows.unsupported).toMatchObject({ agent_state: "unknown", agent_state_reason: "unrecognized_harness" });
    expect(rows.unreadable).toMatchObject({ agent_state: "unknown", agent_state_reason: "lifecycle_inactive" });
    expect(readFileSync(tmuxTrace, "utf8").match(/capture-pane/g)).toHaveLength(1);
  }, 30_000);

  test("an unenrolled canonical bus refuses before any write under the live marker", () => {
    // Born live (F1): bare team never bootstraps a bus; the pre-flip bootstrap
    // arm that wrote .tap/.gitignore and the authority marker is gone, and a
    // legacy tmp/tap bus beside it changes nothing.
    const actual = fixture();
    mkdirSync(join(actual.worktree, "tmp", "tap", "payloads"), { recursive: true });
    writeFileSync(join(actual.worktree, "tmp", "tap", "payloads", "live.md"), "live\n");
    actual.env.TAP_HOME = join(actual.worktree, ".tap", "bus");
    const result = run(["team"], actual.worktree, actual.env);
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 1, stdout: "",
      stderr: "tap team: acting registry unreachable — refusing tap team against a bus decoy; next: tap doctor\n",
    });
    expect(existsSync(join(actual.worktree, ".tap"))).toBe(false);

    const empty = fixture();
    const registry = seedPostFlip(empty, {});
    const before = readFileSync(registry);
    const r = run(["team", "--json"], empty.worktree, empty.env);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).agents).toEqual([]);
    expect(readFileSync(registry)).toEqual(before);
    expect(mode(registry)).toBe(0o640);
  }, 30_000);

  test("invalid index, unreachable acting file, and partial registry refuse structured", () => {
    const invalid = fixture();
    writeFileSync(join(invalid.index, "global-registry.json"), "{not json\n");
    const invalidResult = run(["team"], invalid.worktree, invalid.env);
    expect(invalidResult.status).not.toBe(0);
    expect(invalidResult.stdout).toBe("");
    expect(invalidResult.stderr).toBe("tap team: acting registry unreachable — refusing tap team against a bus decoy; next: tap doctor\n");
    expect(existsSync(join(invalid.worktree, ".tap", "bus"))).toBe(false);

    const unreachable = fixture();
    writeFileSync(join(unreachable.index, "global-registry.json"), JSON.stringify({
      schema: "0.20",
      teams: {
        roster: {
          root: unreachable.worktree,
          registry_location: join(unreachable.worktree, ".tap", "missing.json"),
          state: "registered",
        },
      },
    }));
    const unreachableResult = run(["team"], unreachable.worktree, unreachable.env);
    expect(unreachableResult.status).not.toBe(0);
    expect(unreachableResult.stdout).toBe("");
    expect(unreachableResult.stderr).toContain("tap team: acting registry unreachable — refusing tap team against a bus decoy; next: tap doctor\n");
    expect(existsSync(join(unreachable.worktree, ".tap", "bus"))).toBe(false);

    const partial = fixture();
    seedPostFlip(partial, {}, "{\"schema\":\"0.20\",\"seats\":");
    expectRegistryUnreadable(partial);
  }, 30_000);

  test("an absent machine index answers tap init, not the bus-decoy refusal", () => {
    const f = fixture();
    rmSync(join(f.index, "global-registry.json"));
    mkdirSync(join(f.worktree, ".tap", "bus"), { recursive: true });
    writeFileSync(join(f.worktree, ".tap", "bus", "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "roster" }, seats: {} }));
    const r = run(["team"], f.worktree, f.env);
    expect({ status: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({
      status: 1, stdout: "",
      stderr: "tap team: no machine index (global-registry.json); this machine has no enrolled team; next: tap init  OR  tap session launch\n",
    });
    // Counterfactual: any other selector refusal on the same tree (here an
    // invalid index) still takes the bus-decoy remap; only the absent index passes through.
    writeFileSync(join(f.index, "global-registry.json"), "{not json\n");
    expect(run(["team"], f.worktree, f.env).stderr).toBe("tap team: acting registry unreachable — refusing tap team against a bus decoy; next: tap doctor\n");
  }, 30_000);

  test("an agents axis refuses as old_store, alone or beside a seats map, and is never rewritten", () => {
    const legacy = fixture();
    const bus = join(legacy.worktree, "custom-bus");
    mkdirSync(bus, { recursive: true });
    legacy.env.TAP_HOME = bus;
    const legacyRegistry = join(bus, "registry.json");
    writeFileSync(legacyRegistry, JSON.stringify({
      team: { name: "legacy" },
      agents: {
        legacy: { status: "active", delivery: "poll", harness: "daemon" },
      },
    }) + "\n", { mode: 0o640 });
    const legacyBefore = readFileSync(legacyRegistry);
    expectOldStore(legacy);
    expect(readFileSync(legacyRegistry)).toEqual(legacyBefore);

    for (const seats of [{ current: { status: "active", delivery: "poll", harness: "daemon" } }, {}]) {
      const hybrid = fixture();
      const registry = seedPostFlip(hybrid, {}, JSON.stringify({
        schema: "0.20",
        team: { name: "roster", worktree_root: hybrid.worktree },
        seats,
        agents: {
          retired: { status: "active", delivery: "poll", harness: "daemon" },
        },
      }) + "\n");
      const before = readFileSync(registry);
      expectOldStore(hybrid);
      expect(run(["team", "--names"], hybrid.worktree, hybrid.env).stdout).toBe("");
      expect(readFileSync(registry)).toEqual(before);
      expect(mode(registry)).toBe(0o640);
    }
  }, 30_000);

  test("catalog joins preserve recorded, inferred, absent, unavailable, and unjoined facts", () => {
    const readable = fixture();
    writeCatalog(readable, `version = 2
[roles]
driver = "runs a lane"
[presets.alpha]
harness = "codex"
metadata.primary_roles = ["driver"]
`);
    const registry = seedPostFlip(readable, {
      "alpha-writer": { status: "active", delivery: "poll", harness: "codex" },
      missing: {
        status: "active", delivery: "poll", harness: "codex", preset: { name: "retired" },
      },
      nomatch: { status: "active", delivery: "poll", harness: "codex" },
      recorded: {
        status: "active", delivery: "poll", harness: "codex", preset: { name: "alpha" },
      },
    });
    const before = readFileSync(registry);
    const human = run(["team"], readable.worktree, readable.env).stdout;
    const json = run(["team", "--json"], readable.worktree, readable.env).stdout;
    expect(human).toContain("alpha?");
    expect(human).not.toMatch(/\sdriver(?:\s|$)/);
    expect(json).toContain('"preset_inferred":true');
    expect(json).toContain('"preset_absent_from_catalog":true');
    expect(readFileSync(registry)).toEqual(before);
    expect(mode(registry)).toBe(0o640);

    const unavailable = fixture();
    const unavailableRegistry = seedPostFlip(unavailable, {
      recorded: {
        status: "active", delivery: "poll", harness: "codex", preset: { name: "alpha" },
      },
    });
    const unavailableBefore = readFileSync(unavailableRegistry);
    expect(run(["team", "--json"], unavailable.worktree, unavailable.env).stdout)
      .toContain('"preset_catalog_unavailable":true');
    expect(readFileSync(unavailableRegistry)).toEqual(unavailableBefore);
    expect(mode(unavailableRegistry)).toBe(0o640);
  }, 30_000);

  // tap-gp75: each seat's family is vendor lineage: its recorded launch preset's
  // `metadata.model_family`, else what its single-vendor harness implies, and `-` /
  // null otherwise, in the table and in --json alike.
  describe("family column", () => {
    const tuning = { model: "opus", effort: "high", qualifiers: {}, environment: {} };
    function familyRoster() {
      const f = fixture();
      writeCatalog(f, `version = 2
[presets.alpha]
harness = "codex"
metadata.model_family = "xai"
[presets.beta]
harness = "codex"
metadata.model_family = "zhipu"
[presets.plain]
harness = "codex"
`);
      seedPostFlip(f, {
        recorded: { status: "active", delivery: "poll", harness: "codex", preset: { name: "alpha" } },
        tuned: { status: "active", delivery: "poll", harness: "codex", preset: { name: "beta" }, launch_tuning: tuning },
        modelonly: { status: "active", delivery: "poll", harness: "codex", preset: { name: "beta" }, model: "gpt" },
        unfamilied: { status: "active", delivery: "poll", harness: "codex", preset: { name: "plain" } },
        norecord: { status: "active", delivery: "poll", harness: "claude" },
        multivendor: { status: "active", delivery: "poll", harness: "opencode" },
        "beta-writer": { status: "active", delivery: "poll", harness: "codex" },
      });
      return f;
    }
    const jsonFamily = (f: ReturnType<typeof fixture>) => Object.fromEntries(
      JSON.parse(run(["team", "--json"], f.worktree, f.env).stdout).agents.map((a: any) => [a.handle, a.family]));

    test("table shows context ahead of family and model; recorded presets keep it with or without launch tuning", () => {
      const f = familyRoster();
      const human = run(["team"], f.worktree, f.env);
      expect(human.status, human.stderr).toBe(0);
      const lines = human.stdout.trimEnd().split("\n");
      expect(lines[1]!.trimEnd().split(/\s{2,}/)).toEqual(["handle", "harness", "state", "context", "family", "model", "preset"]);
      const at = lines[1]!.indexOf("family");
      const family = (handle: string) => lines.find(line => line.startsWith(handle + " "))!.slice(at).split(/\s{2,}/)[0];
      expect(family("recorded")).toBe("xai");
      expect(family("tuned")).toBe("zhipu");
      expect(family("modelonly")).toBe("zhipu");
      expect(family("unfamilied")).toBe("openai");
      expect(family("norecord")).toBe("anthropic");
      expect(family("multivendor")).toBe("-");
    });

    test("--json family agrees with the table; an inferred preset's explicit family is not claimed", () => {
      const f = familyRoster();
      expect(jsonFamily(f)).toEqual({
        recorded: "xai", tuned: "zhipu", modelonly: "zhipu", unfamilied: "openai",
        norecord: "anthropic", multivendor: null, "beta-writer": "openai",
      });
    });

    test("published metadata.model_family equals the resolved family when reference metadata is substituted", () => {
      const f = fixture();
      writeCatalog(f, `version = 2
[presets.custom]
harness = "claude"
metadata.model_family = "xai"
`);
      const opusHigh = { model: "opus[1m]", effort: "high", qualifiers: {}, environment: {} };
      seedPostFlip(f, {
        explicit: { status: "active", delivery: "poll", harness: "claude", preset: { name: "custom" }, launch_tuning: opusHigh },
        implied: { status: "active", delivery: "poll", harness: "claude", launch_tuning: opusHigh },
        multivendor: { status: "active", delivery: "poll", harness: "opencode", launch_tuning: { model: "zai-coding-plan/glm-5.3", effort: null, qualifiers: {}, environment: {} } },
      });
      const agents = Object.fromEntries(JSON.parse(run(["team", "--json"], f.worktree, f.env).stdout).agents.map((a: any) => [a.handle, a]));
      // The reference variant's role and cost fields survive; only lineage is canonical.
      expect(agents.explicit.metadata_source).toBe("launch-reference");
      expect(agents.explicit.metadata.intelligence).toBeDefined();
      expect([agents.explicit.family, agents.explicit.metadata.model_family]).toEqual(["xai", "xai"]);
      expect([agents.implied.family, agents.implied.metadata.model_family]).toEqual(["anthropic", "anthropic"]);
      // An unknown family omits the key rather than publishing the reference's own lineage.
      expect(agents.multivendor.family).toBeNull();
      expect(agents.multivendor.metadata?.model_family).toBeUndefined();
    });

    test("JSON labels the family source, and calibration reads explicit preset lineage only", () => {
      const f = familyRoster();
      const agents = Object.fromEntries(JSON.parse(run(["team", "--json"], f.worktree, f.env).stdout).agents.map((a: any) => [a.handle, a]));
      expect(Object.fromEntries(Object.entries(agents).map(([h, a]: [string, any]) => [h, a.family_source]))).toEqual({
        recorded: "preset", tuned: "preset", modelonly: "preset", unfamilied: "harness",
        norecord: "harness", multivendor: null, "beta-writer": "harness",
      });
      const ledger = join(f.dir, "ledger.md");
      writeFileSync(ledger, "## Routing table\n|handle|model @ harness|family|tier|\n|-|-|-|-|\n|other|model @ codex|openai|advanced|\n");
      f.env.TAP_MODELS_LEDGER = ledger;
      const out = run(["team", "calibration"], f.worktree, f.env);
      expect(out.status, out.stderr).toBe(0);
      const rows = out.stdout.split("\n");
      const at = rows.find(line => /^handle\s/i.test(line))!.search(/FAMILY/i);
      const family = (handle: string) => rows.find(line => line.startsWith(handle + " "))!.slice(at).split(/\s{2,}/)[0];
      expect(family("recorded")).toBe("xai");
      expect(family("norecord")).toBe("-");
      expect(family("unfamilied")).toBe("-");
    });

    test("a narrow terminal drops preset, model and family before context", () => {
      const f = familyRoster();
      const narrow = runTty(["team"], f.worktree, f.env, 46);
      expect(narrow.status, narrow.stderr).toBe(0);
      expect(narrow.stdout).toMatch(/handle\s+harness\s+state\s+context\r?\n/);
      expect(narrow.stdout).not.toContain("zhipu");
      expect(narrow.stdout).toContain("hid family, model, preset to fit 46 columns");
    });
  });

  test("COLUMNS-absent human output uses the live TTY width", () => {
    const f = fixture();
    const longPreset = "wide_terminal_preset_preserved_beyond_eighty_columns";
    writeCatalog(f, `version = 2
[presets.${longPreset}]
harness = "codex"
`);
    seedPostFlip(f, {
      recorded: {
        status: "active", delivery: "poll", harness: "codex",
        preset: { name: longPreset },
      },
    });

    const actual = runTty(["team"], f.worktree, f.env);
    expect(actual.stdout).toContain(longPreset);
  }, 30_000);

  test("fitColumns drops right-to-left and never drops handle or state", () => {
    expect(fitColumns([8, 7, 7, 7, 5, 56], null)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(fitColumns([8, 7, 7, 7, 5, 56], 200)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(fitColumns([8, 7, 7, 7, 5, 56], 50)).toEqual([0, 1, 2, 3, 4]);
    expect(fitColumns([8, 7, 7, 7, 5, 56], 42)).toEqual([0, 1, 2, 3, 4]);
    expect(fitColumns([8, 7, 7, 7, 5, 56], 32)).toEqual([0, 1, 2]);
    expect(fitColumns([8, 7, 7], 1)).toEqual([0, 2]);
  });

  test("a narrow TTY drops right-hand columns and hints --wide on stderr", () => {
    const f = fixture();
    const longPreset = "phone_narrow_preset_column_that_overflows_thirty_two";
    writeCatalog(f, `version = 2
[presets.${longPreset}]
harness = "codex"
`);
    seedPostFlip(f, {
      recorded: {
        status: "active", delivery: "poll", harness: "codex",
        preset: { name: longPreset },
      },
    });
    const errFile = join(f.dir, "narrow-stderr.txt");
    const narrow = runTty(["team"], f.worktree, { ...f.env, TTY_RUNNER_STDERR: errFile }, 32);
    expect(narrow.stdout).not.toContain("preset");
    expect(narrow.stdout).not.toContain("model");
    expect(narrow.stdout).toContain("handle");
    expect(narrow.stdout).toContain("state");
    expect(narrow.stdout).not.toContain("hid ");
    const hid = readFileSync(errFile, "utf8").split("\n").filter(line => line.includes("hid "));
    expect(hid).toHaveLength(1);
    expect(hid[0]).toMatch(/^tap team: hid [a-z]+(, [a-z]+)* to fit 32 columns; tap team --wide shows every column$/);
    expect(hid[0]).toContain("preset");
  }, 30_000);

  test("--wide keeps every column on a narrow TTY with no hint", () => {
    const f = fixture();
    const longPreset = "phone_narrow_preset_column_that_overflows_thirty_two";
    writeCatalog(f, `version = 2
[presets.${longPreset}]
harness = "codex"
`);
    seedPostFlip(f, {
      recorded: {
        status: "active", delivery: "poll", harness: "codex",
        preset: { name: longPreset },
      },
    });
    const errFile = join(f.dir, "wide-stderr.txt");
    const wide = runTty(["team", "--wide"], f.worktree, { ...f.env, TTY_RUNNER_STDERR: errFile }, 32);
    expect(wide.stdout).toContain("handle");
    expect(wide.stdout).toContain("preset");
    expect(wide.stdout).toContain("model");
    expect(wide.stdout).toContain(longPreset);
    expect(readFileSync(errFile, "utf8")).not.toContain("hid ");
  }, 30_000);

  test("redirected output never drops columns or hints, whatever COLUMNS says", () => {
    const f = fixture();
    const longPreset = "phone_narrow_preset_column_that_overflows_thirty_two";
    writeCatalog(f, `version = 2
[presets.${longPreset}]
harness = "codex"
`);
    seedPostFlip(f, {
      recorded: {
        status: "active", delivery: "poll", harness: "codex",
        preset: { name: longPreset },
      },
    });
    const piped = run(["team"], f.worktree, { ...f.env, COLUMNS: "40" });
    expect(piped.stdout).toContain("handle");
    expect(piped.stdout).toContain("preset");
    expect(piped.stdout).toContain(longPreset);
    expect(piped.stderr).not.toContain("hid ");
  }, 30_000);

  test("crew, unattended, and unobservable pane rows project correctly", () => {
    const crew = fixture();
    const crewRegistry = seedPostFlip(crew, {
      crew: {
        status: "active", delivery: "pane", pane: "live-session:0.0", pane_id: "%7",
        session: "live-session", server_epoch: "srv:1:1", harness: "codex-via",
        crew: true, unattended: true,
      },
    });
    const crewBefore = readFileSync(crewRegistry);
    expect(run(["team", "--all"], crew.worktree, crew.env).stdout).toContain("CREW");
    expect(run(["team", "--json"], crew.worktree, crew.env).stdout).toContain('"unattended":true');
    expect(readFileSync(crewRegistry)).toEqual(crewBefore);
    expect(mode(crewRegistry)).toBe(0o640);

    const unobservable = fixture();
    replaceTmux(unobservable, "exit 1");
    const unobservableRegistry = seedPostFlip(unobservable, {
      seat: {
        status: "active", delivery: "pane", pane: "seat-session:0.0", pane_id: "%4",
        session: "seat-session", server_epoch: "srv:1:1", harness: "codex",
      },
    });
    const unobservableBefore = readFileSync(unobservableRegistry);
    const human = run(["team"], unobservable.worktree, unobservable.env);
    expect(human.stdout).toMatch(/seat\s+codex\s+● offline/);
    expect(human.stderr).not.toContain("gone seats detected");
    const result = run(["team", "--json"], unobservable.worktree, unobservable.env);
    expect(result.stdout).toContain('"status":"unknown"');
    expect(result.stdout).toContain('"status_reason":"session_unobservable"');
    expect(result.stderr).not.toContain("gone seats detected");
    expect(readFileSync(unobservableRegistry)).toEqual(unobservableBefore);
    expect(mode(unobservableRegistry)).toBe(0o640);
  }, 30_000);

  // Both runtime selectors now use the native classifier. This is a unit arm, and the reason is worth
  // stating because it is a real consequence of the port rather than a
  // convenience: after the cutover NO INPUT AND NO ENVIRONMENT can make the
  // native classifier fail. It is a pure in-process function over a payload
  // this code builds itself; every row is coerced with `str()` before it gets
  // there, so there is no malformed row to seed and no child to shadow. The
  // engine parameter is the only honest driver. The alternative considered and
  // refused was an environment variable that makes production refuse — that
  // would be a live defect vector shipped so a test could reach it, and the
  // arm would then be about the fault door rather than the classifier.
  test("native door: a classification that could not finish never becomes a roster", () => {
    const diagnostics: string[] = [];
    const rows = [{
      handle: "live", status: "active", delivery: "pane", pane: "live-session:0.0",
      pane_id: "%7", session: "live-session", server_epoch: "srv:1:1", harness: "codex",
    }] as unknown as Parameters<typeof observe>[0];
    const result = observe(rows, scriptsDir, false, text => { diagnostics.push(text); }, () => {
      throw new Error("engine exploded mid-roster");
    });
    expect(result.code).not.toBe(0);
    // Empty, not partial: a half-answer must never be readable as rows.
    expect(result.rows.size).toBe(0);
    // The failure is a diagnostic. `observe`'s caller turns a nonzero code into
    // the `classifier_failed` refusal; what must never happen is the text
    // becoming part of a JSON receipt, which an empty row map guarantees.
    expect(diagnostics.join("")).toContain("engine exploded mid-roster");
  });

  // THE ONE-SNAPSHOT PROPERTY, stated as a fixture that can refuse.
  //
  // The claim is NOT that the batch and N=1 doors agree on identical text — the
  // core's own differential covers that, and agreement on identical input says
  // nothing about how many inputs production takes. The claim is that the WHOLE
  // ROSTER is judged against ONE gather.
  //
  // The defect is recorded at `refresh.ts:656` and it is not hypothetical: a
  // per-seat loop takes a fresh tmux picture for every row, so a seat can be
  // judged against a world that moved between rows — and the observed specimen
  // was a live registration removed as `session_absent` on a snapshot artifact.
  //
  // So the fake tmux DRIFTS. Its first answer carries all three sessions; every
  // later answer omits the third. One gather classifies `c` from the first
  // answer; ANY regather classifies it `session_absent`. That is the only way
  // this arm can go green, and the mutant that must red it is the defect that
  // existed — the single `engine(payload)` replaced by a per-row loop.
  test("the whole roster is judged against one gather, not one per seat", () => {
    const f = fixture();
    // The drift counter is bumped by `list-sessions` ONLY, and `list-panes`
    // reads it without bumping. That is deliberate, not a fixture accident: it
    // makes one gather (sessions once, panes once, n stays 1) see all three
    // sessions, and makes the Nth regather see the shrunken world — which is
    // precisely what the per-row mutant does.
    const driftLog = join(f.dir, "tmux.drift.log");
    f.env.TMUX_DRIFT_LOG = driftLog;
    f.env.TMUX_DRIFT_N = join(f.dir, "tmux.drift.n");
    replaceTmux(f, `
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
printf '%s\\n' "$*" >> "$TMUX_DRIFT_LOG"
n=$(cat "$TMUX_DRIFT_N" 2>/dev/null || echo 0)
case "$1" in
  list-sessions)
    n=$((n+1)); printf '%s' "$n" > "$TMUX_DRIFT_N"
    printf 'sa\\t1:1\\t1\\nsb\\t1:1\\t1\\n'
    if [ "$n" -eq 1 ]; then printf 'sc\\t1:1\\t1\\n'; fi
    ;;
  list-panes)
    printf 'sa\\tsa:0.0\\t%%1\\tcodex\\t101\\t1:1\\t0\\nsb\\tsb:0.0\\t%%2\\tcodex\\t102\\t1:1\\t0\\n'
    if [ "$n" -eq 1 ]; then printf 'sc\\tsc:0.0\\t%%3\\tcodex\\t103\\t1:1\\t0\\n'; fi
    ;;
  display-message) printf '1:1\\n' ;;
  *) exit 1 ;;
esac
exit 0`);
    seedPostFlip(f, {
      a: { status: "active", delivery: "pane", pane: "sa:0.0", pane_id: "%1", session: "sa", server_epoch: "srv:1:1", harness: "codex" },
      b: { status: "active", delivery: "pane", pane: "sb:0.0", pane_id: "%2", session: "sb", server_epoch: "srv:1:1", harness: "codex" },
      c: { status: "active", delivery: "pane", pane: "sc:0.0", pane_id: "%3", session: "sc", server_epoch: "srv:1:1", harness: "codex" },
    });

    const roster = run(["team", "--json"], f.worktree, f.env);
    expect(roster.status).toBe(0);
    // ORDER MATTERS HERE. bun stops a test at the first failed expect, so the
    // assertion placed first is the one a reader sees when this arm reds. The
    // gather COUNT is the mechanism; the seat surviving the drift is the
    // CONSEQUENCE, and the consequence is the reason the arm exists — a live
    // registration removed as `session_absent` on a snapshot artifact. So the
    // consequence is asserted first and the mechanism second.
    const agents = JSON.parse(roster.stdout).agents;
    const third = agents.find((row: any) => row.handle === "c");
    expect(third.status_reason).not.toBe("session_absent");
    expect(agents.map((row: any) => `${row.handle}:${row.status}`)).toEqual(["a:active", "b:active", "c:active"]);
    // Then the mechanism: ONE gather for the whole roster.
    const calls = readFileSync(driftLog, "utf8").trim().split("\n");
    expect(calls.filter(call => call.startsWith("list-sessions"))).toHaveLength(1);
    expect(calls.filter(call => call.startsWith("list-panes -a"))).toHaveLength(1);
    // And no per-session fallback: the first answer covered every session, so
    // the documented `-s -t` chunking must not fire and inflate the count.
    expect(calls.filter(call => call.includes("list-panes -s"))).toHaveLength(0);
  }, 30_000);

  test("an empty shallow pane field triggers the process-table fallback", () => {
    const f = fixture();
    replaceTmux(f, `
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
  list-sessions) printf 'live-session\\t1:1\\t1\\n' ;;
  list-panes) printf 'live-session\\tlive-session:0.0\\t%%7\\t\\t123\\t1:1\\t0\\n' ;;
  *) exit 1 ;;
esac`);
    const psTrace = join(f.dir, "ps.argv");
    f.env.PS_TRACE = psTrace;
    writeFileSync(join(f.dir, "bin", "ps"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PS_TRACE"\nexit 1\n', { mode: 0o755 });
    seedPostFlip(f, {
      seat: {
        status: "active", delivery: "pane", pane: "live-session:0.0", pane_id: "%7",
        session: "live-session", server_epoch: "srv:1:1", harness: "codex",
      },
    });

    const actual = run(["team", "--json"], f.worktree, f.env);
    expect(actual.status, actual.stderr).toBe(0);
    const actualJson = JSON.parse(actual.stdout);
    expect(actualJson.agents[0]).toMatchObject({
      status: "unknown",
      status_reason: "pane_set_unobservable",
      agent_state: "unknown",
      agent_state_reason: "lifecycle_unreadable",
    });
    expect(readFileSync(psTrace, "utf8")).toContain("-Ao pid=,pgid=,tpgid=,comm=,command=");
  }, 30_000);

  test("valid JSON with scalar team or roster axes refuses as old_store and is left intact", () => {
    for (const body of [
      { schema: "0.20", team: "roster", seats: {} },
      { schema: "0.20", team: { name: "roster" }, seats: [], agents: "not-a-map" },
    ]) {
      const f = fixture();
      const registry = seedPostFlip(f, {}, `${JSON.stringify(body)}\n`);
      const before = readFileSync(registry);
      expectOldStore(f);
      expect(readFileSync(registry)).toEqual(before);
      expect(mode(registry)).toBe(0o640);
    }
  }, 30_000);

  test("native argv and refusal surface after roster ownership", () => {
    const f = fixture();
    seedPostFlip(f, {});
    const argvs = [
      ["team", ""],
      ["team", "", "--json"],
      ["team", "show"],
      ["team", "--future-option"],
      ["team", "--names", "--json"],
      ["team", "--online"],
      ["team", "--json", "extra"],
      ["team", "roster", "--future-option"],
      ["team", "roster", "--names", "--json"],
      ["team", "roster", "--online"],
      ["team", "--json", "--all"],
      ["team", "--names", "--all"],
      ["team", "--online", "--names"],
    ];
    const actual = argvs.map(argv => { const r = run(argv, f.worktree, f.env); return [argv.join(" "), r.status, r.stdout, r.stderr]; });
    expect(actual).toEqual([
      ["team ", 0, "tap team: no agents registered yet — start one: tap launch <preset|harness> [name]\n", ""],
      ["team  --json", 0, "{\"team\":null,\"agents\":[],\"observed_at\":null}\n", ""],
      ["team show", 1, "", "tap team: unknown subcommand 'show' (usage: tap team [list|roster|calibration|attach|detach|down|out|up|refresh|history|shutdown|reset|restore|purge] [--json|--all|--wide]); next: tap help team\n"],
      ["team --future-option", 1, "", "tap team: unknown option '--future-option'; next: tap help team\n"],
      ["team --names --json", 1, "{\"ok\":false,\"error_class\":\"usage_error\",\"action\":\"tap team --names   (or: tap team --json)\",\"detail\":\"--names and --json are alternative output shapes \\u2014 pick one\"}\n", ""],
      ["team --online", 0, "tap team: no agents registered yet — start one: tap launch <preset|harness> [name]\n", ""],
      ["team --json extra", 1, "{\"ok\":false,\"error_class\":\"usage_error\",\"action\":\"tap help team\",\"detail\":\"unexpected arg 'extra'\"}\n", ""],
      ["team roster --future-option", 1, "", "tap team roster: unknown option '--future-option'; next: tap help team\n"],
      ["team roster --names --json", 1, "{\"ok\":false,\"error_class\":\"usage_error\",\"action\":\"tap team --names   (or: tap team --json)\",\"detail\":\"--names and --json are alternative output shapes \\u2014 pick one\"}\n", ""],
      ["team roster --online", 0, "tap team: no agents registered yet — start one: tap launch <preset|harness> [name]\n", ""],
      ["team --json --all", 0, "{\"team\":null,\"agents\":[],\"observed_at\":null}\n", ""],
      ["team --names --all", 0, "", ""],
      ["team --online --names", 0, "", ""],
    ]);

    const container = fixture();
    container.env.TAP_HOME = container.worktree;
    const containerResult = run(["team"], container.worktree, container.env);
    const containerReal = realpathSync(container.worktree);
    expect([containerResult.status, containerResult.stdout, containerResult.stderr]).toEqual([1, "", `tap team: TAP_HOME='${containerReal}' does not name a bus; expected '${containerReal}/.tap/bus'; next: unset TAP_HOME or point it at the bus dir\n`]);
    expect(existsSync(join(container.worktree, "payloads"))).toBe(false);
  }, 60_000);

  test("U1: crew indented under parent with |-- and `-- tree markers sorted by window index", () => {
    const f = fixture();
    seedPostFlip(f, {
      "codex-spark-moderator": {
        status: "active", delivery: "pane", pane: "tap/codex-spark:0.0", pane_id: "%1",
        session: "tap/codex-spark", server_epoch: "srv:1:1", harness: "codex", preset: { name: "gpt-spark" },
      },
      "luna-moderator": {
        status: "active", delivery: "pane", pane: "tap/luna:0.0", pane_id: "%2",
        session: "tap/luna", server_epoch: "srv:1:1", harness: "codex", preset: { name: "luna" },
      },
      "z-second-child": {
        status: "active", delivery: "pane", pane: "tap/luna:1.0", pane_id: "%4",
        session: "tap/luna", server_epoch: "srv:1:1", harness: "codex", crew: true,
      },
      "a-first-child": {
        status: "active", delivery: "pane", pane: "tap/luna:2.0", pane_id: "%3",
        session: "tap/luna", server_epoch: "srv:1:1", harness: "codex", crew: true,
      },
    });

    const res = run(["team"], f.worktree, f.env);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
    const lines = res.stdout.trim().split("\n");
    expect(lines[0]).toBe("tap team: roster");
    expect(lines[1]).toMatch(/^handle\s+harness\s+state\s+context\s+family\s+model\s+preset$/);
    expect(lines[2]).toMatch(/^codex-spark-moderator\s+codex\s+● offline\s+—\s+openai\s+\?\s+gpt-spark$/);
    expect(lines[3]).toMatch(/^luna-moderator\s+codex\s+● offline\s+—\s+openai\s+\?\s+luna$/);
    // window 1 (z-second-child) sorted before window 2 (a-first-child), overriding alphabetical order
    expect(lines[4]).toMatch(/^\|-- z-second-child\s+codex\s+● offline\s+—\s+openai\s+\?\s+n\/a$/);
    expect(lines[5]).toMatch(/^`-- a-first-child\s+codex\s+● offline\s+—\s+openai\s+\?\s+n\/a$/);
    expect(lines.length).toBe(6);

    // Invariant guards: --all, --json, --names run clean and silent.
    for (const argv of [["team", "--all"], ["team", "--json"], ["team", "--names"]]) {
      const r = run(argv, f.worktree, f.env);
      expect([argv.join(" "), r.status, r.stderr]).toEqual([argv.join(" "), 0, ""]);
    }
    const names = run(["team", "--names"], f.worktree, f.env);
    expect(names.stdout).toBe("a-first-child\ncodex-spark-moderator\nluna-moderator\nz-second-child\n");
  }, 30_000);

  test("U1.3: rootless crew renders flat and prints ONE stderr warning naming tap-zhx82 (even with multiple rootless rows)", () => {
    const f = fixture();
    seedPostFlip(f, {
      "orphan-crew": {
        status: "active", delivery: "pane", pane: "tap/ghost:1.0", pane_id: "%5",
        session: "tap/ghost", server_epoch: "srv:1:1", harness: "codex", crew: true,
      },
      "second-orphan": {
        status: "active", delivery: "pane", pane: "tap/other-ghost:1.0", pane_id: "%6",
        session: "tap/other-ghost", server_epoch: "srv:1:1", harness: "codex", crew: true,
      },
    });

    const human = run(["team"], f.worktree, f.env);
    expect(human.status).toBe(0);
    expect(human.stdout).toMatch(/orphan-crew\s+codex\s+● offline\s+—\s+openai\s+\?\s+n\/a/);
    expect(human.stdout).toMatch(/second-orphan\s+codex\s+● offline\s+—\s+openai\s+\?\s+n\/a/);
    expect(human.stdout).not.toContain("|--");
    expect(human.stdout).not.toContain("`--");
    expect(human.stderr).toContain("tap-zhx82");
    expect(human.stderr).toContain("orphan-crew");
    expect(human.stderr).toContain("second-orphan");
    // Cardinality proof: exactly ONE line emitted despite multiple rootless defects
    expect(human.stderr.trim().split("\n").length).toBe(1);

    // Diagnostic scope constraint: silent on --all, --json, --names
    const all = run(["team", "--all"], f.worktree, f.env);
    expect(all.status).toBe(0);
    expect(all.stderr).toBe("");
    const json = run(["team", "--json"], f.worktree, f.env);
    expect(json.status).toBe(0);
    expect(json.stderr).toBe("");
    const names = run(["team", "--names"], f.worktree, f.env);
    expect(names.status).toBe(0);
    expect(names.stderr).toBe("");
  }, 30_000);

  test("U1.3b: multiple non-crew seats in same session nests under first in roster order and emits ONE stderr warning naming tap-7ph7f (even with multiple ambiguous sessions)", () => {
    const f = fixture();
    seedPostFlip(f, {
      "alpha-parent": {
        status: "active", delivery: "pane", pane: "tap/shared:0.0", pane_id: "%1",
        session: "tap/shared", server_epoch: "srv:1:1", harness: "codex",
      },
      "beta-parent": {
        status: "active", delivery: "pane", pane: "tap/shared:1.0", pane_id: "%2",
        session: "tap/shared", server_epoch: "srv:1:1", harness: "codex",
      },
      "crew-child": {
        status: "active", delivery: "pane", pane: "tap/shared:2.0", pane_id: "%3",
        session: "tap/shared", server_epoch: "srv:1:1", harness: "codex", crew: true,
      },
      "gamma-parent": {
        status: "active", delivery: "pane", pane: "tap/other-shared:0.0", pane_id: "%4",
        session: "tap/other-shared", server_epoch: "srv:1:1", harness: "codex",
      },
      "delta-parent": {
        status: "active", delivery: "pane", pane: "tap/other-shared:1.0", pane_id: "%5",
        session: "tap/other-shared", server_epoch: "srv:1:1", harness: "codex",
      },
      "second-crew-child": {
        status: "active", delivery: "pane", pane: "tap/other-shared:2.0", pane_id: "%6",
        session: "tap/other-shared", server_epoch: "srv:1:1", harness: "codex", crew: true,
      },
    });

    const human = run(["team"], f.worktree, f.env);
    expect(human.status).toBe(0);
    const lines = human.stdout.trim().split("\n");
    expect(lines[2]).toMatch(/^alpha-parent\s+/);
    expect(lines[3]).toMatch(/^`-- crew-child\s+/);
    expect(lines[4]).toMatch(/^beta-parent\s+/);
    expect(lines[5]).toMatch(/^delta-parent\s+/);
    expect(lines[6]).toMatch(/^`-- second-crew-child\s+/);
    expect(lines[7]).toMatch(/^gamma-parent\s+/);
    expect(human.stderr).toContain("tap-7ph7f");
    expect(human.stderr).toContain("tap/shared");
    expect(human.stderr).toContain("tap/other-shared");
    // Cardinality proof: exactly ONE line emitted despite multiple ambiguous sessions
    expect(human.stderr.trim().split("\n").length).toBe(1);

    // Diagnostic scope constraint: silent on --all, --json, --names
    expect(run(["team", "--all"], f.worktree, f.env).stderr).toBe("");
    expect(run(["team", "--json"], f.worktree, f.env).stderr).toBe("");
    expect(run(["team", "--names"], f.worktree, f.env).stderr).toBe("");
  }, 30_000);

  test("U1.5: column alignment holds when prefixed handle is the widest cell", () => {
    const f = fixture();
    seedPostFlip(f, {
      parent: {
        status: "active", delivery: "pane", pane: "tap/s:0.0", pane_id: "%1",
        session: "tap/s", server_epoch: "srv:1:1", harness: "codex",
      },
      "very-long-crew-child-seat-name": {
        status: "active", delivery: "pane", pane: "tap/s:1.0", pane_id: "%2",
        session: "tap/s", server_epoch: "srv:1:1", harness: "codex", crew: true,
      },
    });

    const res = run(["team"], f.worktree, f.env);
    expect(res.status).toBe(0);
    const lines = res.stdout.trim().split("\n");
    const parentHarnessIndex = lines[2]!.indexOf("codex");
    const childHarnessIndex = lines[3]!.indexOf("codex");
    expect(parentHarnessIndex).toBe(childHarnessIndex);
    expect(childHarnessIndex).toBeGreaterThan("`-- very-long-crew-child-seat-name".length);
  }, 30_000);

  test("U2: tap team roster [<team>] renders named enrolled team with same human roster projection", () => {
    const f = fixture();
    const foreignRoot = join(f.dir, "foreign-tree");
    const foreignDotTap = join(foreignRoot, ".tap");
    mkdirSync(foreignDotTap, { recursive: true });
    const foreignRegistry = join(foreignDotTap, "team-registry.json");
    writeFileSync(foreignRegistry, JSON.stringify({
      schema: "0.20",
      team: { name: "foreign-team", worktree_root: foreignRoot },
      seats: {
        "lead-seat": {
          status: "active", delivery: "pane", pane: "live-session:0.0", pane_id: "%7",
          session: "live-session", server_epoch: "srv:1:1", harness: "codex", preset: { name: "lead" },
        },
        "crew-seat": {
          status: "active", delivery: "pane", pane: "live-session:1.0", pane_id: "%2",
          session: "live-session", server_epoch: "srv:1:1", harness: "codex", crew: true,
        },
      },
    }, null, 2) + "\n");

    const localDotTap = join(f.worktree, ".tap");
    mkdirSync(localDotTap, { recursive: true });
    const localRegistry = join(localDotTap, "team-registry.json");
    writeFileSync(localRegistry, JSON.stringify({
      schema: "0.20",
      team: { name: "local-team", worktree_root: f.worktree },
      seats: {
        "local-seat": {
          status: "active", delivery: "pane", pane: "local/lead:0.0", pane_id: "%3",
          session: "local/lead", server_epoch: "srv:1:1", harness: "codex",
        },
      },
    }, null, 2) + "\n");

    const decoyRoot = join(f.dir, "decoy-tree");
    const decoyDotTap = join(decoyRoot, ".tap");
    mkdirSync(decoyDotTap, { recursive: true });
    const decoyRegistry = join(decoyDotTap, "team-registry.json");
    writeFileSync(decoyRegistry, JSON.stringify({
      schema: "0.20",
      team: { name: "DECOY_ACTING_NAME", worktree_root: decoyRoot },
      seats: {
        "decoy-seat": {
          status: "active", delivery: "poll", harness: "codex",
        },
      },
    }, null, 2) + "\n");

    writeFileSync(join(f.index, "global-registry.json"), JSON.stringify({
      schema: "0.20",
      teams: {
        "local-team": { root: f.worktree, registry_location: localRegistry, state: "registered" },
        "foreign-team": { root: foreignRoot, registry_location: foreignRegistry, state: "registered" },
        "decoy-team": { root: decoyRoot, registry_location: decoyRegistry, state: "registered" },
      },
    }));

    replaceTmux(f, `
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
  list-sessions) printf 'live-session\\t1:1\\t1\\n' ;;
  list-panes) printf 'live-session\\tlive-session:0.0\\t%%7\\tcodex\\t123\\t1:1\\t0\\n' ;;
  capture-pane) cat '${join(root, "runtime/bun/test/fixtures/agent-state/codex/working.txt")}' ;;
  display-message) case \"$*\" in *pane_title*) printf '\\342\\240\\271 roster\\n' ;; *) printf '0\\n' ;; esac ;;
  *) exit 1 ;;
esac`);

    // 1. Bare tap team and tap team roster match pre-change oracle and render local-team
    const expectedLocal = [
      "tap team: local-team",
      "handle      harness  state      context  family  model  preset",
      "local-seat  codex    ● offline  —        openai  ?      n/a",
      "",
    ].join("\n");
    const bare = run(["team"], f.worktree, f.env);
    const bareRoster = run(["team", "roster"], f.worktree, f.env);
    expect(bare.status).toBe(0);
    expect(bareRoster.status).toBe(0);
    expect(bare.stdout).toBe(expectedLocal);
    expect(bareRoster.stdout).toBe(expectedLocal);
    expect(bare.stderr).toBe("");
    expect(bareRoster.stderr).toBe("");
    expect(bare.stdout).toContain("local-seat");
    expect(bare.stdout).not.toContain("lead-seat");

    // 2. Named team renders foreign-team through the same renderHuman projection and stays read-only
    const foreignTapBefore = readdirSync(foreignDotTap).sort();
    const named = run(["team", "roster", "foreign-team"], f.worktree, f.env);
    expect(named.status).toBe(0);
    expect(named.stderr).toBe("");
    expect(named.stdout).toContain("tap team: foreign-team");
    expect(named.stdout).toContain("lead-seat");
    expect(named.stdout).toContain("`-- crew-seat");
    expect(named.stdout).not.toContain("local-seat");
    expect(named.stdout).toContain("● working");
    expect(named.stdout).toContain("● offline");
    expect(readdirSync(foreignDotTap).sort()).toEqual(foreignTapBefore);
    expect(existsSync(join(foreignRoot, ".tap", "bus"))).toBe(false);

    // 3. Named team live TTY renders ANSI colors for status dots
    const ttyColorEnv = { ...f.env };
    delete ttyColorEnv.NO_COLOR;
    const namedTty = runTty(["team", "roster", "foreign-team"], f.worktree, ttyColorEnv);
    expect(namedTty.status).toBe(0);
    expect(namedTty.stdout).toContain("\x1b[32m●\x1b[0m working");
    expect(namedTty.stdout).toContain("\x1b[90m●\x1b[0m offline");

    // 4. Decoy team internal acting name does not override authoritative enrolled key
    const decoyHuman = run(["team", "roster", "decoy-team"], f.worktree, f.env);
    expect(decoyHuman.status).toBe(0);
    expect(decoyHuman.stdout).toContain("tap team: decoy-team");
    expect(decoyHuman.stdout).not.toContain("DECOY_ACTING_NAME");
    const decoyJson = run(["team", "roster", "decoy-team", "--json"], f.worktree, f.env);
    expect(decoyJson.status).toBe(0);
    const decoyParsed = JSON.parse(decoyJson.stdout);
    expect(decoyParsed.team).toBe("decoy-team");
    expect(decoyParsed.team).not.toBe("DECOY_ACTING_NAME");

    // 5. Flags work on named team
    const namedJson = run(["team", "roster", "foreign-team", "--json"], f.worktree, f.env);
    expect(namedJson.status).toBe(0);
    expect(namedJson.stderr).toBe("");
    const parsed = JSON.parse(namedJson.stdout);
    expect(parsed.team).toBe("foreign-team");
    expect(parsed.agents.map((a: any) => a.handle)).toEqual(["crew-seat", "lead-seat"]);

    const namedNames = run(["team", "roster", "foreign-team", "--names"], f.worktree, f.env);
    expect(namedNames.status).toBe(0);
    expect(namedNames.stderr).toBe("");
    expect(namedNames.stdout.trim().split("\n")).toEqual(["crew-seat", "lead-seat"]);

    const namedAll = run(["team", "roster", "foreign-team", "--all"], f.worktree, f.env);
    expect(namedAll.status).toBe(0);
    expect(namedAll.stderr).toBe("");
    expect(namedAll.stdout).toContain("CREW");
  }, 30_000);

  test("U2.3: unknown team refuses with unknown_team and non-zero exit, no empty table", () => {
    const f = fixture();
    seedPostFlip(f, {});

    const human = run(["team", "roster", "nonexistent-team"], f.worktree, f.env);
    expect(human.status).toBe(1);
    expect(human.stdout).toBe("");
    expect(human.stderr).toContain("tap team roster: --team 'nonexistent-team' is not enrolled in the machine index");
    expect(human.stderr).toContain("next: tap register");

    const json = run(["team", "roster", "nonexistent-team", "--json"], f.worktree, f.env);
    expect(json.status).toBe(1);
    expect(json.stderr).toBe("");
    const parsed = JSON.parse(json.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error_class).toBe("unknown_team");
    expect(parsed.action).toBe("tap register");
  }, 30_000);

  test("U2.4: unreachable team refuses with live_unreachable and exit 1, never renders offline (Ruling 11)", () => {
    const f = fixture();
    const missingRoot = join(f.dir, "missing\nroot");
    writeFileSync(join(f.index, "global-registry.json"), JSON.stringify({
      schema: "0.20",
      teams: {
        "ghost-team": { root: missingRoot, registry_location: join(missingRoot, ".tap/team-registry.json"), state: "registered" },
      },
    }));

    const human = run(["team", "roster", "ghost-team"], f.worktree, f.env);
    expect(human.status).toBe(1);
    expect(human.stdout).toBe("");
    expect(human.stderr.trimEnd().split("\n").length).toBe(1);
    expect(human.stderr).toContain("tap team roster: acting registry for team 'ghost-team' (root '");
    expect(human.stderr).toContain("missing\\nroot') is unreachable");
    expect(human.stderr).toContain("next: tap doctor");

    const json = run(["team", "roster", "ghost-team", "--json"], f.worktree, f.env);
    expect(json.status).toBe(1);
    expect(json.stderr).toBe("");
    const parsed = JSON.parse(json.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error_class).toBe("live_unreachable");
    expect(parsed.action).toBe("tap doctor");
  }, 30_000);

  test("U2: bare tap team <team> refuses as unknown_subcommand (ponytail anti-overengineering veto)", () => {
    const f = fixture();
    seedPostFlip(f, {});

    const res = run(["team", "some-team"], f.worktree, f.env);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("unknown subcommand 'some-team'");

    const help = spawnSync(shippedEntry, ["help", "team"], { env: f.env, encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("tap team [--json | --names | --all | --wide] [--online | --offline]");
    expect(help.stdout).toContain("tap team roster [<team>] [--json | --names | --all | --wide] [--online | --offline]");
    expect(help.stdout).not.toContain("tap team [roster] [<team>]");
  }, 30_000);
});

// Exercise the public entry point while counting the remaining Python seams.
// The observer seam is GONE as of the observation cutover, so this arm's job
// changed from "observer runs once" to "observer never runs".
test("shipped team projects registry, observation and presets natively", () => {
  const f = fixture();
  const registry = seedPostFlip(f, {
    live: { status: "active", delivery: "pane", pane: "live-session:0.0", pane_id: "%7",
      session: "live-session", server_epoch: "srv:1:1", harness: "codex" },
  });
  const pythonTrace = join(f.dir, "python.trace");
  f.env.TAP_TEST_REAL_PYTHON = realPython;
  f.env.TAP_TEST_REGISTRY = registry;
  f.env.TAP_TEST_PY_TRACE = pythonTrace;
  writeFileSync(join(f.dir, "bin", "python3"), `#!/bin/sh
if [ "$1" = -B ] && [ "$2" = - ] && [ "$3" = "$TAP_TEST_REGISTRY" ]; then
  printf 'registry-projection\\n' >> "$TAP_TEST_PY_TRACE"
fi
case "$2" in
  */tap_observe_seats.py) printf 'observer\\n' >> "$TAP_TEST_PY_TRACE" ;;
  -c) case "$3" in *presets*) printf 'presets\\n' >> "$TAP_TEST_PY_TRACE" ;; esac ;;
esac
exec "$TAP_TEST_REAL_PYTHON" "$@"
`, { mode: 0o755 });
  const result = run(["team", "--json"], f.worktree, f.env);
  expect(result.status).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.agents.map((row: any) => row.handle)).toEqual(["live"]);
  const calls = existsSync(pythonTrace) ? readFileSync(pythonTrace, "utf8").trim().split("\n") : [];
  expect(calls.filter(call => call === "registry-projection")).toHaveLength(0);
  expect(calls.filter(call => call === "observer")).toHaveLength(0);
  expect(calls.filter(call => call === "presets")).toHaveLength(0);
  // POSITIVE CONTROL for the zero above: the classification still HAPPENED. A
  // roster that skipped observation entirely would also log zero observer
  // calls, and would report the seat as unknown. This asserts the seat was
  // actually classified, so the zero means "moved in-process", not "skipped".
  expect(parsed.agents[0].status).not.toBe("unknown");
  expect(readFileSync(f.trace, "utf8")).toContain("native team");
});


test("human roster heads-up shares init's TAP-block check without polluting machine output", () => {
  const f = fixture(); seedPostFlip(f, {});
  writeFileSync(join(f.worktree, "AGENTS.md"), "# Local instructions\n");
  expect(run(["team"], f.worktree, f.env).stderr).toContain("run tap setup --repo");
  for (const flag of ["--json", "--names"]) {
    const r = run(["team", flag], f.worktree, f.env);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  }
  writeFileSync(join(f.worktree, "AGENTS.md"), "<!-- tap:begin -->\nTAP\n<!-- tap:end -->");
  expect(run(["team"], f.worktree, f.env).stderr).not.toContain("tap setup --repo");
});

test("foreign socket rows render their namespace and cannot appear active", () => {
  const f = fixture();
  const registry = seedPostFlip(f, {
    remote: {status:"active", delivery:"pane", pane:"live-session:0.0", pane_id:"%7", session:"live-session", harness:"codex", server_epoch:"srv:1:1", server_socket:"/fixture/tap-tmux.foreign"},
  });
  replaceTmux(f, `
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
 list-sessions) printf 'live-session\\t1:1\\t1\\n' ;;
 list-panes) printf 'live-session\\tlive-session:0.0\\t%%7\\tcodex\\t123\\t1:1\\t0\\n' ;;
 display-message) printf '/fixture/default\\n' ;;
 *) exit 1 ;;
esac`);
  const before = readFileSync(registry, "utf8");
  const result = run(["team"], f.worktree, f.env);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("bound under tap-tmux.foreign");
  const item = JSON.parse(run(["team", "--json"], f.worktree, f.env).stdout).agents[0];
  expect(item.status).toBe("offline");
  expect(item.status_reason).toBe("foreign_namespace");
  expect(item.server_socket).toBe("/fixture/tap-tmux.foreign");
  expect(readFileSync(registry, "utf8")).toBe(before);
});

test("refresh and hard refresh preserve foreign namespace crew and suspended rows", () => {
  for (const hard of [false, true]) {
    const f = fixture();
    const registry = seedPostFlip(f, {
      remoteCrew: {status:"active",delivery:"pane",crew:true,pane:"remote:0.0",pane_id:"%9",session:"remote",harness:"codex",server_epoch:"srv:2:2",server_socket:"/fixture/foreign"},
      remoteSeat: {status:"suspended",delivery:"pane",session:"absent",harness:"codex",server_epoch:"srv:2:2",server_socket:"/fixture/foreign"},
    });
    replaceTmux(f, `
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
 list-sessions) printf 'live-session\\t1:1\\t1\\n' ;;
 list-panes) printf 'live-session\\tlive-session:0.0\\t%%7\\tcodex\\t123\\t1:1\\t0\\n' ;;
 display-message) printf '/fixture/default\\n' ;;
 *) exit 1 ;;
esac`);
    const before=readFileSync(registry,"utf8");
    const result=run(["team","refresh","--json",...(hard?["--hard"]:[])],f.worktree,f.env);
    expect(result.status,result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).trimmed).toEqual([]);
    expect(readFileSync(registry,"utf8")).toBe(before);
  }
}, 20000);

// opus-xhigh-4 required this and they were right to: `:902`'s second half was
// REFRESH CUSTODY under a failed classification, and neither replacement arm
// exercised refresh. That is the incident class the one-gather argument exists
// for — a live registration deleted on an answer nobody got — so it cannot be
// the property that quietly falls out of the re-aim.
//
// The mapping lives in `observeAll`: `result.code !== 0` makes every row
// `unknown / harness_unobservable`, which refresh KEEPS. It is a pure mapping
// with no child to fail and no input that makes the in-process engine refuse,
// so the engine seam is forwarded one level up rather than a fault door added.
test("refresh keeps every seat as unknown when the classification could not finish", () => {
  const rows = [
    { handle: "live", harness: "codex", pane: "sa:0.0", status: "active", statusReason: "",
      delivery: "pane", paneId: "%1", session: "sa", registeredAt: "", crew: false,
      serverEpoch: "srv:1:1", bootId: "boot:1" },
    { handle: "other", harness: "codex", pane: "sb:0.0", status: "active", statusReason: "",
      delivery: "pane", paneId: "%2", session: "sb", registeredAt: "", crew: false,
      serverEpoch: "srv:1:1", bootId: "boot:1" },
  ] as unknown as Parameters<typeof observeAll>[1];

  const observed = observeAll(scriptsDir, rows, () => { throw new Error("engine exploded"); });

  // NONE ABSENT is the load-bearing half. A row missing from this map is a row
  // refresh has no answer for, and an answerless row is exactly what must not
  // become a deletion.
  expect([...observed.keys()].sort()).toEqual(["live", "other"]);
  for (const handle of ["live", "other"]) {
    expect({ handle, state: observed.get(handle)![0], reason: observed.get(handle)![1] })
      .toEqual({ handle, state: "unknown", reason: "harness_unobservable" });
  }
  // And the polarity that deletes seats: never `gone`.
  expect([...observed.values()].some(fields => fields[0] === "gone")).toBe(false);
});

test("roster reads catalog in-process without spawning the preset bridge", () => {
  const f = fixture();
  writeCatalog(f, 'version = 2\n[presets.native]\nharness = "codex"\n');
  seedPostFlip(f, { native: { status: "active", delivery: "poll", harness: "codex", preset: { name: "native" } } });
  const trace = join(f.dir, "preset-calls");
  writeFileSync(join(f.dir, "bin", "python3"), `#!/bin/sh
case "$3" in *"import presets"*) echo called >> '${trace}';; esac
exec '${realPython}' "$@"
`, { mode: 0o755 });
  const result = run(["team", "--json"], f.worktree, f.env);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).agents[0].preset).toBe("native");
  expect(existsSync(trace)).toBe(false);
});

test("fresh two-seat roster shows blocked permission and hook-trust states without a stale-binding warning", () => {
  const f = fixture(); delete f.env.TAP_SERVER_EPOCH;
  const captures = join(root, "runtime/bun/test/fixtures/agent-state");
  replaceTmux(f, `
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
 list-sessions) printf 'claude-seat\\t1:1\\t1\\ncodex-seat\\t1:1\\t1\\n' ;;
 list-panes) printf 'claude-seat\\tclaude-seat:0.0\\t%%7\\tclaude\\t123\\t1:1\\t0\\ncodex-seat\\tcodex-seat:0.0\\t%%8\\tcodex\\t124\\t1:1\\t0\\n' ;;
 capture-pane)
   printf '%s\\n' 'Private conversation text must not leak'
   case "$*" in *%7*) cat '${captures}/claude/blocked-real.txt' ;; *) cat '${captures}/codex/hook-trust.txt' ;; esac ;;
 display-message) case "$*" in *pane_title*) printf '⠹ stale working title\\n' ;; *) printf '1:1\\n' ;; esac ;;
 *) exit 1 ;;
esac`);
  seedPostFlip(f, {
    helper: { status: "active", delivery: "pane", pane: "claude-seat:0.0", pane_id: "%7", session: "claude-seat", server_epoch: "srv:1:1", harness: "claude" },
    reviewer: { status: "active", delivery: "pane", pane: "codex-seat:0.0", pane_id: "%8", session: "codex-seat", server_epoch: "srv:1:1", harness: "codex" },
  });
  for (const args of [["team"], ["team", "roster", "roster"]]) {
    const human = run(args, f.worktree, f.env);
    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).toContain("blocked");
    expect(human.stdout).toContain("blocked");
    expect(human.stdout).not.toContain("Warning:");
    expect(human.stdout).not.toContain("Private conversation");
    const json = run([...args, "--json"], f.worktree, f.env);
    expect(json.status, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout).agents).toEqual([
      expect.objectContaining({ handle: "helper", agent_state: "blocked", agent_state_reason: "permission_prompt", context_tokens: null }),
      expect.objectContaining({ handle: "reviewer", agent_state: "blocked", agent_state_reason: "codex-hook-trust", context_tokens: null }),
    ]);
    expect(json.stdout).not.toContain("Private conversation");
    expect(json.stdout).not.toContain("Hooks need review");
    expect(json.stdout).not.toContain("needs you");
  }
});

test("context warning requires a positively mismatched transcript session", () => {
  const f = fixture(), transcript = join(f.dir, "transcript.jsonl");
  const row = { status: "active", delivery: "pane", pane: "live-session:0.0", pane_id: "%7", session: "live-session",
    server_epoch: "srv:1:1", harness: "codex", harness_session_id: "seat", transcript_path: transcript };
  for (const events of [[], [{type: "session_meta", payload: {id: "seat"}}],
    [{type: "session_meta", payload: {id: "seat"}}, {type: "compacted"}], [{type: "session_meta", payload: {}}]]) {
    writeFileSync(transcript, events.map(e => JSON.stringify(e)).join("\n") + "\n");
    seedPostFlip(f, { live: row });
    const result = run(["team"], f.worktree, f.env);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("Warning:");
    expect(result.stdout).toContain("—");
  }
  seedPostFlip(f, { live: { ...row, transcript_path: join(f.dir, "not-created-yet.jsonl") } });
  expect(run(["team"], f.worktree, f.env).stdout).not.toContain("Warning:");
  writeFileSync(transcript, JSON.stringify({type: "session_meta", payload: {id: "another-seat"}}) + "\n");
  seedPostFlip(f, { live: row });
  const mismatch = run(["team"], f.worktree, f.env);
  expect(mismatch.status, mismatch.stderr).toBe(0);
  expect(mismatch.stdout).toContain("Warning: transcript session does not match the binding for live. Run `tap team doctor` to diagnose.");
  expect(run(["team", "--json"], f.worktree, f.env).stdout).not.toContain("Warning:");
});

test("default context reuses the state capture and --context retains queue facts", () => {
  const f = fixture(); delete f.env.TAP_SERVER_EPOCH;
  const trace = join(f.dir,"context.trace"); f.env.TMUX_TRACE = trace;
  replaceTmux(f, String.raw`
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
printf '%s\n' "$*" >> "$TMUX_TRACE"
case "$1" in
 list-sessions) printf 'live-session\t1:1\t1\n' ;;
 list-panes) printf 'live-session\tlive-session:0.0\t%%7\tclaude\t123\t1:1\t0\n' ;;
 capture-pane) printf '%s\n' 'Private text must not leak' '❯ ' '42% (84K) ctx' ;;
 display-message) printf '1:1\n' ;;
 *) exit 1 ;;
esac`);
  seedPostFlip(f, { live: {status:"active",delivery:"pane",pane:"live-session:0.0",pane_id:"%7",session:"live-session",server_epoch:"srv:1:1",harness:"claude"} });
  writeFileSync(trace,"");
  const plain = run(["team","--json"],f.worktree,f.env);
  expect(plain.status).toBe(0);
  expect(plain.stdout).not.toContain("Private text");
  expect(JSON.parse(plain.stdout).agents[0]).toMatchObject({context_used_percent:42,context_source:"footer"});
  expect(JSON.parse(plain.stdout).agents[0].context_tokens).toBeNull();
  expect(JSON.parse(plain.stdout).agents[0].context_unknown_reason).toBe("unbound_transcript");
  expect(JSON.parse(plain.stdout).agents[0].sampled_at).toMatch(/^\d{4}-/);
  expect(readFileSync(trace,"utf8").match(/capture-pane/g)).toHaveLength(1);
  const missing = run(["team"],f.worktree,f.env);
  expect(missing.stdout).toMatch(/live\s+claude\s+● \w+\s+—\s+anthropic/);
  expect(missing.stdout).not.toContain("Warning:");
  expect(missing.stdout).not.toContain("0 /");
  expect(run(["team","--all"],f.worktree,f.env).stdout).not.toContain("Warning: stats unavailable");
  expect(run(["team","--names"],f.worktree,f.env).stdout).toBe("live\n");
  const details = run(["team","--context","--json"],f.worktree,f.env);
  expect(details.status).toBe(0);
  expect(JSON.parse(details.stdout).agents[0]).toMatchObject({context_used_percent:42,pending_inbound_ask:false,last_outbound_age_seconds:null});
  // macOS ps environment seam; Linux /proc and parser agreement are unit-tested separately.
  if (process.platform !== "darwin") return;
  const transcript = join(f.dir,"seat.jsonl");
  writeFileSync(transcript, JSON.stringify({type:"assistant",sessionId:"seat",timestamp:"2026-09-19T09:00:00Z",message:{usage:{input_tokens:84000,cache_creation_input_tokens:0,cache_read_input_tokens:0}}})+"\n");
  seedPostFlip(f, {live:{status:"active",delivery:"pane",pane:"live-session:0.0",pane_id:"%7",session:"live-session",server_epoch:"srv:1:1",harness:"claude",harness_session_id:"seat",transcript_path:transcript}});
  const ps = join(f.dir,"bin","ps");
  writeFileSync(ps, "#!/bin/sh\ncase \"$1\" in -axo) echo \"123 1 claude\";; *) echo \"123 claude PATH=/bin CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000\";; esac\n", {mode:0o755});
  const human = run(["team"],f.worktree,f.env);
  expect(human.stdout).toMatch(/live\s+claude\s+● \w+\s+84k\/100k\s+anthropic/);
  expect(human.stdout).not.toContain("Warning: stats unavailable");
  const overridden = JSON.parse(run(["team","--json"],f.worktree,f.env).stdout).agents[0];
  expect(overridden.context_used_percent).toBe(42);
  expect(overridden.context_tokens).toMatchObject({input_tokens:84000,used_percent:84,percent_source:"claude_process_env"});
  writeFileSync(ps, "#!/bin/sh\ncase \"$1\" in -axo) echo \"123 1 claude\";; *) echo \"123 claude PATH=/bin\";; esac\n", {mode:0o755});
  const unset = JSON.parse(run(["team","--json"],f.worktree,f.env).stdout).agents[0];
  expect(unset.context_tokens).toMatchObject({input_tokens:84000,used_percent:8,percent_source:"default_1m",window_tokens:1000000});

});

// ---------------------------------------------------------------------------
// Native compare-and-trim, the ported registry trim. These assert the trim's
// own contract directly because parity-by-comparison cannot reach any of it:
// the incumbent never produces a changed row, a zero-match rewrite-skip, or a
// lossless-regression on purpose, so no bash-vs-native scenario can pin them.
// Fingerprints are computed by PYTHON, never by the code under test, so a
// native serializer that drifted from python's would fail to match rather than
// agree with itself.

const TRIM_US = "\x1f";

const TRIM_FP_PY = `import base64, json, sys
reg = json.load(open(sys.argv[1]))
seats = reg.get("seats") if isinstance(reg.get("seats"), dict) else (reg.get("agents") or {})
for handle, ent in seats.items():
    if isinstance(ent, dict):
        fp = base64.urlsafe_b64encode(json.dumps(ent, sort_keys=True, separators=(",", ":")).encode()).decode()
        print(handle + "\\x1f" + fp)
`;

function pythonFingerprints(registry: string): Map<string, string> {
  const r = spawnSync(realPython, ["-B", "-", registry], { encoding: "utf8", input: TRIM_FP_PY });
  if (r.status !== 0) throw new Error(`fingerprint helper failed: ${r.stderr}`);
  const out = new Map<string, string>();
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const at = line.indexOf(TRIM_US);
    out.set(line.slice(0, at)!, line.slice(at + 1));
  }
  return out;
}

// Lossless shapes a JSON round-trip erases, written as raw bytes because
// JSON.stringify cannot produce them: a whole float that must stay `2.0`, an
// integer far past 2^53 whose digits must survive verbatim, and a non-ASCII
// note that must come back ensure_ascii-escaped like python wrote it.
function trimFixtureRegistry(worktree: string, changedRow: string): string {
  return `{
  "seats": {
    "trimmable": {"pane": "s:0.0", "delivery": "pane", "status": "active"},
    "floaty": {"weight": 2.0, "big": 123456789012345678901234567890, "note": "café"},
    "changed": ${changedRow},
    "stable": {"weight": 2.5, "big": 999999999999999999999999, "note": "köln", "delivery": "pane"},
    "scalar": "not-an-object"
  },
  "team": {"name": "roster", "worktree_root": "${worktree}"},
  "schema": "0.20",
  "seat_forwardings": [{"source": "a", "destination": "b", "at": "2026-01-01", "address_active": true}],
  "unknown_top_level": {"kept": true}
}
`;
}

test("native trim keeps a changed row, reports only actual removals, and rewrites losslessly", () => {
  if (!realPython) return;
  const f = fixture();
  const oldRow = '{"pane": "old:0.0", "delivery": "pane"}';
  const registry = seedPostFlip(f, {}, trimFixtureRegistry(f.worktree, oldRow));
  const stale = pythonFingerprints(registry);
  expect([...stale.keys()].sort()).toEqual(["changed", "floaty", "stable", "trimmable"]);

  // The race: the row the candidate fingerprint was computed from is rewritten
  // BEFORE the trim runs, the way a concurrent `tap in` would under the lock.
  writeFileSync(registry, trimFixtureRegistry(f.worktree, '{"pane": "new:0.9", "delivery": "pane", "status": "active"}'), { mode: 0o640 });

  const removed = trimRegistryLocked(registry, [
    `trimmable${TRIM_US}${stale.get("trimmable")}`,
    `floaty${TRIM_US}${stale.get("floaty")}`,
    `changed${TRIM_US}${stale.get("changed")}`,
  ]);
  expect([...removed].sort()).toEqual(["floaty", "trimmable"]);

  const bytes = readFileSync(registry).toString();
  const doc = JSON.parse(bytes) as Record<string, any>;
  expect(mode(registry)).toBe(0o600);
  expect(bytes.endsWith("\n")).toBe(true);
  // floaty was removed, so its lossless bytes are gone with it — the surviving
  // `stable` row is what pins the REWRITE against a JSON round-trip: a whole
  // float keeps `.0`, a >2^53 integer keeps its digits, non-ASCII stays
  // ensure_ascii-escaped the way python wrote the file.
  expect(doc.seats.floaty).toBeUndefined();
  expect(doc.seats.trimmable).toBeUndefined();
  expect(bytes).toContain('"weight": 2.5');
  expect(bytes).toContain('"big": 999999999999999999999999');
  expect(bytes).toContain("k\\u00f6ln");
  expect(doc.seats.changed).toMatchObject({ pane: "new:0.9" });
  expect(doc.seats.scalar).toBe("not-an-object");
  expect(doc.seat_forwardings).toEqual([{ source: "a", destination: "b", at: "2026-01-01", address_active: true }]);
  expect(doc.unknown_top_level).toEqual({ kept: true });
  expect(doc.team).toEqual({ name: "roster", worktree_root: f.worktree });
}, 15_000);

test("native trim rewrites nothing when no fingerprint matches", () => {
  if (!realPython) return;
  const f = fixture();
  const registry = seedPostFlip(f, {}, trimFixtureRegistry(f.worktree, '{"pane": "old:0.0", "delivery": "pane"}'));
  const before = readFileSync(registry);
  const beforeIno = statSync(registry).ino;
  const removed = trimRegistryLocked(registry, [`trimmable${TRIM_US}bogus`, `floaty${TRIM_US}alsobogus`]);
  expect(removed.size).toBe(0);
  // Same inode, not merely same bytes: python's rewrite path is a rename, so a
  // rewrite that round-tripped identical content would still move the file.
  expect(statSync(registry).ino).toBe(beforeIno);
  expect(readFileSync(registry)).toEqual(before);
}, 15_000);

// ---------------------------------------------------------------------------
// The roster reader, ported in-process (U2). The incumbent ran this read as a
// python child whose FileNotFoundError meant "empty roster" and whose other
// failures meant "registry_invalid". The native reader must keep every one of
// those verdicts — absent-is-empty, truthiness-driven defaults, code-point
// ordering, is-True crew identity, complete-row fingerprints — while the
// refusal's diagnostic prose becomes native (the one seam U2 consciously
// widened). Fingerprints are again computed by PYTHON, never by the code
// under test.
// ---------------------------------------------------------------------------

test("native roster reader: absent registry is an empty roster, malformed is registry_invalid", () => {
  const f = fixture();
  // FileNotFoundError in the incumbent exited 0 with no rows: an absent
  // registry is a legitimate empty roster, never a refusal.
  expect(readRoster(join(f.worktree, "no-such-registry.json"))).toEqual([]);

  const malformed = seedPostFlip(f, {}, "not json at all\n");
  try {
    readRoster(malformed);
    throw new Error("expected registry_invalid");
  } catch (error) {
    expect(error).toBeInstanceOf(TapError);
    const refusal = error as TapError;
    expect(refusal.code).toBe(1);
    expect(refusal.errorClass).toBe("registry_invalid");
    expect(refusal.action).toBe("repair_registry");
    expect(refusal.detail.startsWith("tap team refresh: registry unreadable (")).toBe(true);
  }

  // A top-level non-object crashed the incumbent's `.get` — the same refusal.
  for (const bytes of ["[]\n", '"a string"\n']) {
    const path = seedPostFlip(fixture(), {}, bytes);
    expect(() => readRoster(path)).toThrow(TapError);
  }
});

test("native roster reader: python truthiness picks or refuses the seats axis; agents is never read", () => {
  // seats falsy -> `or {}` -> empty roster, NOT a refusal.
  for (const seats of ["null", "[]", '""', "0"]) {
    const path = seedPostFlip(fixture(), {}, `{"seats": ${seats}}\n`);
    expect(readRoster(path)).toEqual([]);
  }
  // C4a-2: an agents map is never a roster (the acting pin refused an old store first).
  const agentsOnly = seedPostFlip(fixture(), {}, `{"agents": {"z": {"pane": "p:0.0"}}}\n`);
  expect(readRoster(agentsOnly)).toEqual([]);
  // truthy non-dict seats is refused, even beside an agents map.
  for (const body of [`{"seats": "x"}\n`, `{"seats": ["not", "a", "map"], "agents": {"z": {"pane": "p:0.0"}}}\n`]) {
    const bad = seedPostFlip(fixture(), {}, body);
    expect(() => readRoster(bad)).toThrow(TapError);
  }
});

test("native roster reader projects rows with python defaults, identity crew, and code-point order", () => {
  const f = fixture();
  const registry = seedPostFlip(
    f,
    {},
    `{
  "seats": {
    "sparse": {},
    "empty_delivery": {"delivery": "", "status": ""},
    "crew_lie": {"crew": 1},
    "crew_yes": {"crew": "yes"},
    "scalar": "i-am-a-string",
    "café": {"pane": "p:0.0", "session": "s", "registered_at": "at", "status_reason": "why", "launch_id": "l", "server_epoch": "e", "harness": "h", "boot_id": "b", "server_socket": "sock", "crew": true},
    "Zebra": {"pane": "z:0.0"},
    "zebra": {"pane": "Z:0.0"},
    "apple": {"pane": "a:0.0"}
  }
}
`,
  );
  const rows = readRoster(registry);
  // Non-dict rows are skipped, not refused, and the rest come back in
  // python's `sorted(items())` order — code-point, so Z < a < c < z.
  expect(rows.map((row) => row.handle)).toEqual(["Zebra", "apple", "café", "crew_lie", "crew_yes", "empty_delivery", "sparse", "zebra"]);

  const sparse = rows.find((row) => row.handle === "sparse")!;
  expect(sparse.delivery).toBe("pane");
  expect(sparse.status).toBe("active");
  expect(sparse.pane).toBe("");
  expect(sparse.paneId).toBe("");
  expect(sparse.session).toBe("");
  expect(sparse.registeredAt).toBe("");
  expect(sparse.statusReason).toBe("");
  expect(sparse.launchId).toBe("");
  expect(sparse.serverEpoch).toBe("");
  expect(sparse.serverSocket).toBe("");
  expect(sparse.harness).toBe("");
  expect(sparse.bootId).toBe("");
  expect(sparse.crew).toBe(false);

  // `ent.get("status", "active")` defaults ONLY when the key is absent: a
  // present empty string stays empty, and `delivery or "pane"` sends a falsy
  // empty string to the default.
  const emptyDelivery = rows.find((row) => row.handle === "empty_delivery")!;
  expect(emptyDelivery.delivery).toBe("pane");
  expect(emptyDelivery.status).toBe("");

  // `is True` is an identity test: only the boolean is crew.
  expect(rows.find((row) => row.handle === "crew_lie")!.crew).toBe(false);
  expect(rows.find((row) => row.handle === "crew_yes")!.crew).toBe(false);
  expect(rows.find((row) => row.handle === "café")!.crew).toBe(true);
  const full = rows.find((row) => row.handle === "café")!;
  expect([full.pane, full.session, full.registeredAt, full.statusReason]).toEqual(["p:0.0", "s", "at", "why"]);
  expect([full.launchId, full.serverEpoch, full.harness, full.bootId, full.serverSocket]).toEqual(["l", "e", "h", "b", "sock"]);
});

test("native roster reader fingerprints the full row losslessly and writes nothing", () => {
  if (!realPython) return;
  const f = fixture();
  const registry = seedPostFlip(f, {}, trimFixtureRegistry(f.worktree, '{"pane": "old:0.0", "delivery": "pane"}'));
  const before = readFileSync(registry);
  const beforeIno = statSync(registry).ino;

  const rows = readRoster(registry);
  expect(rows.map((row) => row.handle)).toEqual(["changed", "floaty", "stable", "trimmable"]);
  // The fingerprint is the python serialization of the WHOLE entity — a
  // whole float, an integer past 2^53, non-ASCII — matching what python
  // computes for the same bytes, byte for byte.
  const python = pythonFingerprints(registry);
  for (const row of rows) {
    expect(row.fingerprint).toBe(python.get(row.handle)!);
  }

  // A read never rewrites: same inode, not merely same bytes.
  expect(statSync(registry).ino).toBe(beforeIno);
  expect(readFileSync(registry)).toEqual(before);
}, 15_000);

test("native roster reader refuses truthy non-string fields instead of coercing", () => {
  // The incumbent's `"\x1f".join` crashed with TypeError on a truthy
  // non-string field — a refusal, never a coercion. Present-but-null status
  // also refused (get returned None, join crashed); a FALSY pane value took
  // its default instead.
  const truthyPane = seedPostFlip(fixture(), {}, `{"seats": {"a": {"pane": 123}}}\n`);
  expect(() => readRoster(truthyPane)).toThrow(TapError);
  const truthyStatus = seedPostFlip(fixture(), {}, `{"seats": {"a": {"status": {"nested": true}}}}\n`);
  expect(() => readRoster(truthyStatus)).toThrow(TapError);
  const nullStatus = seedPostFlip(fixture(), {}, `{"seats": {"a": {"status": null}}}\n`);
  expect(() => readRoster(nullStatus)).toThrow(TapError);
  const falsyPane = seedPostFlip(fixture(), {}, `{"seats": {"a": {"pane": 0}}}\n`);
  const rows = readRoster(falsyPane);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.pane).toBe("");
});

// --- U3: the --hard session namespace snapshot ---

// The three-way authority the hard cut stands on, straight from the launcher's
// tmux_sessions_for_namespace(): exit 0 is the namespace; a RECOGNIZED
// no-server stderr is positive proof of an empty one; every other failure is
// NOT deletion authority. The recognized set stays narrow — `no sessions` and
// the connection-failure families belong to launch.ts and seat-updown's
// broader answers, deliberately not folded in here.
test("namespace leaf: recognized no-server answers prove empty, near misses stay unobservable", () => {
  const f = fixture();
  replaceTmux(f, String.raw`
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
printf '%b' "$NS_STDERR" >&2
exit $NS_CODE`);
  const arm = (code: number, stderr: string) => {
    f.env.NS_CODE = String(code);
    f.env.NS_STDERR = stderr;
  };
  const emptyNamespace = (): void => {
    const ns = tmuxSessionNamespace(f.env);
    if (!ns.observable) throw new Error("recognized no-server must be observable");
    expect(ns.names.size).toBe(0);
  };

  arm(1, "no server running on /tmp/fake");
  emptyNamespace();
  arm(1, "error connecting to /tmp/fake (No such file or directory)");
  emptyNamespace();

  // Near misses and other failures fail closed: no names, no deletion authority.
  for (const stderr of [
    "no sessions",
    "failed to connect to /tmp/fake: Connection refused",
    "no server running",
    "",
    "no server running on /x\nno sessions",
    "error connecting to /tmp/fake (No such file or directory): boom",
  ]) {
    arm(1, stderr);
    expect(tmuxSessionNamespace(f.env).observable, JSON.stringify(stderr)).toBe(false);
  }

  // A successful read is the namespace itself — empty or not.
  replaceTmux(f, String.raw`
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
printf '%b' "$NS_OUT"
exit 0`);
  f.env.NS_OUT = "";
  const empty = tmuxSessionNamespace(f.env);
  if (!empty.observable) throw new Error("exit 0 must be observable");
  expect(empty.names.size).toBe(0);
  f.env.NS_OUT = "alpha\nabsent\n\n";
  const named = tmuxSessionNamespace(f.env);
  if (!named.observable) throw new Error("exit 0 must be observable");
  expect([...named.names].sort()).toEqual(["absent", "alpha"]);
});

const U3_PARKED = { status: "suspended", delivery: "pane", session: "absent", harness: "codex", server_epoch: "srv:1:1" } as const;

test("hard refresh: recognized no-server answers license the parked-row trim", () => {
  for (const stderr of ["no server running on /fake/socket", "error connecting to /fake/socket (No such file or directory)"]) {
    const f = fixture();
    const registry = seedPostFlip(f, { parked: U3_PARKED });
    replaceTmux(f, `while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
 *) printf '%b' '${stderr}' >&2; exit 1 ;;
esac`);
    const result = run(["team", "refresh", "--hard", "--json"], f.worktree, f.env);
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.trimmed).toHaveLength(1);
    expect(receipt.trimmed[0]).toMatchObject({ handle: "parked", reason: "hard_session_absent" });
    expect(readFileSync(registry, "utf8")).not.toContain('"parked"');
  }
}, 20000);

test("hard refresh: every unrecognized namespace failure keeps the parked row", () => {
  for (const stderr of [
    "no sessions",
    "failed to connect to /fake/socket: Connection refused",
    "no server running",
    "",
    "no server running on /x\\nno sessions",
  ]) {
    const f = fixture();
    const registry = seedPostFlip(f, { parked: U3_PARKED });
    const before = readFileSync(registry, "utf8");
    replaceTmux(f, `while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
 *) printf '%b' '${stderr}' >&2; exit 1 ;;
esac`);
    const result = run(["team", "refresh", "--hard", "--json"], f.worktree, f.env);
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.trimmed).toEqual([]);
    expect(receipt.kept).toHaveLength(1);
    expect(receipt.kept[0]).toMatchObject({ handle: "parked", reason: "hard_session_unobservable" });
    expect(readFileSync(registry, "utf8")).toBe(before);
  }
}, 30000);

test("hard refresh: a successful namespace read is deletion authority exactly when the session is absent", () => {
  // Exit 0 with EMPTY stdout is an observable EMPTY namespace — still authority.
  const gone = fixture();
  seedPostFlip(gone, { parked: U3_PARKED });
  replaceTmux(gone, String.raw`
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
 list-sessions) exit 0 ;;
 *) exit 1 ;;
esac`);
  const goneResult = run(["team", "refresh", "--hard", "--json"], gone.worktree, gone.env);
  expect(goneResult.status, goneResult.stderr).toBe(0);
  const goneReceipt = JSON.parse(goneResult.stdout);
  expect(goneReceipt.trimmed).toHaveLength(1);
  expect(goneReceipt.trimmed[0]).toMatchObject({ handle: "parked", reason: "hard_session_absent" });

  // Exit 0 with the row's session among the names keeps it.
  const live = fixture();
  const registry = seedPostFlip(live, { parked: U3_PARKED });
  replaceTmux(live, String.raw`
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
 list-sessions) printf 'absent\n' ;;
 *) exit 1 ;;
esac`);
  const liveResult = run(["team", "refresh", "--hard", "--json"], live.worktree, live.env);
  expect(liveResult.status, liveResult.stderr).toBe(0);
  const liveReceipt = JSON.parse(liveResult.stdout);
  expect(liveReceipt.trimmed).toEqual([]);
  expect(liveReceipt.kept).toHaveLength(1);
  expect(liveReceipt.kept[0]).toMatchObject({ handle: "parked", reason: "hard_session_live" });
  expect(readFileSync(registry, "utf8")).toContain('"parked"');
}, 20000);

test("hard refresh consults tmux directly and never the retired namespace python child", () => {
  if (!realPython) return;
  const f = fixture();
  seedPostFlip(f, { parked: U3_PARKED });
  const pylog = join(f.dir, "py.calls");
  writeFileSync(join(f.dir, "bin", "python3"), `#!/bin/sh
echo "$@" >> '${pylog}'
exec '${realPython}' "$@"
`, { mode: 0o755 });
  const trace = join(f.dir, "tmux.trace");
  f.env.TMUX_TRACE = trace;
  replaceTmux(f, `while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
printf '%s\\n' "$*" >> "$TMUX_TRACE"
case "$1" in
 list-sessions) printf 'absent\\n' ;;
 *) exit 1 ;;
esac`);
  const result = run(["team", "refresh", "--hard", "--json"], f.worktree, f.env);
  expect(result.status, result.stderr).toBe(0);
  const receipt = JSON.parse(result.stdout);
  expect(receipt.trimmed).toEqual([]);
  expect(receipt.kept).toHaveLength(1);
  expect(receipt.kept[0]).toMatchObject({ handle: "parked", reason: "hard_session_live" });
  // The leaf reached tmux itself...
  expect(readFileSync(trace, "utf8")).toMatch(/list-sessions/);
  // ...and no stdin-python child ran in this flow: the row was kept, so no
  // trim, no strand report, no rebind — python3 must never have been invoked.
  const pyCalls = existsSync(pylog) ? readFileSync(pylog, "utf8") : "";
  expect(pyCalls).toBe("");
}, 20000);

test("hard refresh: a tmux client that cannot answer at all leaves the parked row", () => {
  // The exceptional paths — fork failure, client deadline expired — throw
  // ServerUnresponsive out of the shared tmux leaf. The namespace classifier
  // must convert exactly that to the unobservable namespace, never let it
  // escape as a crashed refresh.
  const arms: Array<{ name: string; body: string; slow?: boolean }> = [
    {
      name: "fork failure",
      body: String.raw`while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
 list-sessions) echo 'tmux: fork failed: Device not configured' >&2; exit 1 ;;
 *) exit 1 ;;
esac`,
    },
    {
      name: "deadline expired",
      body: String.raw`while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
  list-sessions) exec sleep 5 ;;
 *) exit 1 ;;
esac`,
      slow: true,
    },
  ];
  for (const arm of arms) {
    const f = fixture();
    const registry = seedPostFlip(f, { parked: U3_PARKED });
    const before = readFileSync(registry, "utf8");
    const ino = statSync(registry).ino;
    replaceTmux(f, arm.body);
    if (arm.slow) f.env.TAP_TMUX_TIMEOUT_SECONDS = "0.2";
    const result = run(["team", "refresh", "--hard", "--json"], f.worktree, f.env);
    expect(result.status, `${arm.name}: ${result.stderr}`).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.trimmed, arm.name).toEqual([]);
    expect(receipt.kept, arm.name).toHaveLength(1);
    expect(receipt.kept[0], arm.name).toMatchObject({ handle: "parked", reason: "hard_session_unobservable" });
    expect(readFileSync(registry, "utf8")).toBe(before);
    expect(statSync(registry).ino).toBe(ino);
  }
}, 20000);

// --- U4: the stranded-mail report ---

const U4_ROW = { status: "suspended", delivery: "pane", session: "absent", harness: "codex", server_epoch: "srv:1:1" } as const;

function u4BusPaths(f: ReturnType<typeof fixture>): { payloads: string; receipts: string } {
  const payloads = join(f.worktree, ".tap", "bus", "payloads");
  const receipts = join(f.worktree, ".tap", "bus", "receipts");
  mkdirSync(payloads, { recursive: true });
  mkdirSync(receipts, { recursive: true });
  return { payloads, receipts };
}

function u4WritePayload(payloads: string, id: string, lines: string[]): void {
  writeFileSync(join(payloads, `${id}.md`), `${lines.join("\n")}\n`);
}

function u4StrandedStub(): string {
  // Observable empty namespace -> the parked row hard-trims -> the strand path runs.
  return String.raw`
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
 list-sessions) exit 0 ;;
 *) exit 1 ;;
esac`;
}

function u4Remedy(id: string, sender: string): string {
  return `tap cancel ${id} --by ${sender}`;
}

test("hard refresh: trimming a seat strands its unsettled mail and says so on stderr", () => {
  const f = fixture();
  const registry = seedPostFlip(f, { parked: U4_ROW });
  const { payloads, receipts } = u4BusPaths(f);
  u4WritePayload(payloads, "u4strand-1", ["---", "id: u4strand-1", "from: alice", "to: parked", "---", "body"]);
  u4WritePayload(payloads, "u4strand-2", ["---", "id: u4strand-2", "from: alice_2.0", "to: parked", "to_team: roster", "---", "body"]);
  mkdirSync(join(payloads, "u4notmail.md"), { recursive: true }); // a *.md DIRECTORY is skipped, not fatal
  const result = run(["team", "refresh", "--hard", "--json"], f.worktree, f.env);
  expect(result.status, result.stderr).toBe(0);
  const receipt = JSON.parse(result.stdout);
  expect(receipt.trimmed).toHaveLength(1);
  expect(receipt.trimmed[0]).toMatchObject({ handle: "parked", reason: "hard_session_absent" });
  expect(result.stderr).toContain(
    `tap team refresh: WARNING: trimming 'parked' strands 2 unsettled payload(s) addressed to it: u4strand-1, u4strand-2. ` +
    `the sender clears each stranded id (${u4Remedy("u4strand-1", "alice")}; ${u4Remedy("u4strand-2", "alice_2.0")}), ` +
    `or re-register a seat as 'parked' (tap in reclaims the handle and adopts this mail).`,
  );
  expect(existsSync(join(receipts, "u4strand-1.done"))).toBe(false);
  expect(readFileSync(join(payloads, "u4strand-1.md"), "utf8")).toContain("to: parked");
}, 20000);

test("hard refresh: the stranded-mail frontmatter grammar is python's, byte for byte", () => {
  const arms: Array<{ name: string; lines: string[]; stranded: boolean }> = [
    { name: "no space after colon still parses", lines: ["---", "id:x", "from:y", "to:parked", "---"], stranded: true },
    { name: "unterminated fence is skipped", lines: ["---", "to: parked", "body without close"], stranded: false },
    { name: "absent frontmatter is skipped", lines: ["just text", "no fence"], stranded: false },
    {
      name: "duplicate keys: last wins",
      lines: ["---", "to: elsewhere", "to: parked", "---"],
      stranded: true,
    },
    {
      name: "duplicate keys: last wins the other way",
      lines: ["---", "to: parked", "to: elsewhere", "---"],
      stranded: false,
    },
    {
      name: "indented key lines are not fields",
      lines: ["---", "  to: parked", "---"],
      stranded: false,
    },
  ];
  for (const arm of arms) {
    const f = fixture();
    const { payloads } = u4BusPaths(f);
    seedPostFlip(f, { parked: U4_ROW });
    u4WritePayload(payloads, "u4grammar", ["---", "id: u4grammar", "from: alice", ...arm.lines.slice(1)]);
    const result = run(["team", "refresh", "--hard", "--json"], f.worktree, f.env);
    expect(result.status, `${arm.name}: ${result.stderr}`).toBe(0);
    expect(result.stderr.includes("WARNING: trimming 'parked'"), `${arm.name}: ${result.stderr}`).toBe(arm.stranded);
  }
}, 30000);

test("hard refresh: stranded mail is team-filtered, settlement-aware, and code-point ordered", () => {
  const f = fixture();
  const { payloads, receipts } = u4BusPaths(f);
  seedPostFlip(f, { parked: U4_ROW });
  u4WritePayload(payloads, "a.md-keep", ["---", "id: a.md-keep", "from: alice", "to: parked", "---"]);
  u4WritePayload(payloads, "A-keep", ["---", "id: A-keep", "from: alice", "to: parked", "---"]);
  u4WritePayload(payloads, "b-keep", ["---", "id: b-keep", "from: alice", "to: parked", "---"]);
  u4WritePayload(payloads, "other-team", ["---", "id: other-team", "from: alice", "to: parked", "to_team: elsewhere", "---"]);
  u4WritePayload(payloads, "done-keep", ["---", "id: done-keep", "from: alice", "to: parked", "---"]);
  writeFileSync(join(receipts, "done-keep.done"), "");
  u4WritePayload(payloads, "cancelled-keep", ["---", "id: cancelled-keep", "from: alice", "to: parked", "---"]);
  writeFileSync(join(receipts, "cancelled-keep.cancelled"), "");
  const result = run(["team", "refresh", "--hard", "--json"], f.worktree, f.env);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain(
    "strands 3 unsettled payload(s) addressed to it: A-keep, a.md-keep, b-keep",
  );
  expect(result.stderr).not.toContain("other-team");
  expect(result.stderr).not.toContain("done-keep");
  expect(result.stderr).not.toContain("cancelled-keep");
}, 20000);

test("hard refresh: the sender is the first from: inside the fence, shlex-quoted", () => {
  const f = fixture();
  const { payloads } = u4BusPaths(f);
  seedPostFlip(f, { parked: U4_ROW });
  u4WritePayload(payloads, "u4sender", [
    "---",
    "id: u4sender",
    "from: bob; rm -rf ~",
    "to: parked",
    "---",
    "from: after.fence@ignored",
  ]);
  const result = run(["team", "refresh", "--hard", "--json"], f.worktree, f.env);
  expect(result.status, result.stderr).toBe(0);
  // The remedy quotes the sender shlex-style; the after-fence `from:` line is
  // never consulted because the fence terminated.
  expect(result.stderr).toContain(`tap cancel u4sender --by 'bob; rm -rf ~'`);
  expect(result.stderr).not.toContain("after.fence@ignored");
}, 20000);

test("hard refresh: a missing sender falls back and a successor grant rewords the remedy", () => {
  const plain = fixture();
  const { payloads: p1 } = u4BusPaths(plain);
  seedPostFlip(plain, { parked: U4_ROW });
  u4WritePayload(p1, "u4nosender", ["---", "id: u4nosender", "to: parked", "---"]);
  const plainResult = run(["team", "refresh", "--hard", "--json"], plain.worktree, plain.env);
  expect(plainResult.status, plainResult.stderr).toBe(0);
  expect(plainResult.stderr).toContain("tap cancel u4nosender --by '<sender>'");

  const granted = fixture();
  const { payloads: p2 } = u4BusPaths(granted);
  seedPostFlip(granted, {
    parked: U4_ROW,
    succ: { status: "active", delivery: "pane", session: "s", harness: "codex", adopted_handles: ["parked"] },
  });
  u4WritePayload(p2, "u4grant", ["---", "id: u4grant", "from: alice", "to: parked", "---"]);
  const grantedResult = run(["team", "refresh", "--hard", "--json"], granted.worktree, granted.env);
  expect(grantedResult.status, grantedResult.stderr).toBe(0);
  expect(grantedResult.stderr).toContain(
    "trimming 'parked' strands 1 unsettled payload(s) addressed to it: u4grant. " +
    "successor 'succ' holds the reclaim grant — the sender clears each stranded id " +
    "(tap cancel u4grant --by alice); the adoption-aware settle path lands with bead tap-7r3fn.27.",
  );
}, 20000);

test("hard refresh: the strand preview runs in dry-run and still writes nothing", () => {
  const f = fixture();
  const registry = seedPostFlip(f, { parked: U4_ROW });
  const { payloads } = u4BusPaths(f);
  u4WritePayload(payloads, "u4dry", ["---", "id: u4dry", "from: alice", "to: parked", "---"]);
  const before = readFileSync(registry, "utf8");
  const ino = statSync(registry).ino;
  const result = run(["team", "refresh", "--hard", "--dry-run", "--json"], f.worktree, f.env);
  expect(result.status, result.stderr).toBe(0);
  const receipt = JSON.parse(result.stdout);
  expect(receipt.trimmed).toHaveLength(1);
  expect(result.stderr).toContain("WARNING: trimming 'parked' strands 1 unsettled payload(s) addressed to it: u4dry");
  expect(readFileSync(registry, "utf8")).toBe(before);
  expect(statSync(registry).ino).toBe(ino);
}, 20000);

test("hard refresh: the stranded-mail report invokes no python child at all", () => {
  if (!realPython) return;
  const f = fixture();
  const { payloads } = u4BusPaths(f);
  seedPostFlip(f, { parked: U4_ROW });
  u4WritePayload(payloads, "u4nopy", ["---", "id: u4nopy", "from: alice", "to: parked", "---"]);
  const pylog = join(f.dir, "py.calls");
  writeFileSync(join(f.dir, "bin", "python3"), `#!/bin/sh
echo "$@" >> '${pylog}'
exec '${realPython}' "$@"
`, { mode: 0o755 });
  const result = run(["team", "refresh", "--hard", "--json"], f.worktree, f.env);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain("WARNING: trimming 'parked' strands 1 unsettled payload(s)");
  // The whole flow — trim AND strand report — is now python-free.
  expect(existsSync(pylog) ? readFileSync(pylog, "utf8") : "").toBe("");
}, 20000);

test("hard refresh: an unreadable payload degrades the report without overturning the trim", () => {
  const f = fixture();
  const registry = seedPostFlip(f, { parked: U4_ROW });
  const { payloads } = u4BusPaths(f);
  writeFileSync(join(payloads, "u4bad.md"), Buffer.of(0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0x0a));
  const result = run(["team", "refresh", "--hard", "--json"], f.worktree, f.env);
  expect(result.status, result.stderr).toBe(0);
  const receipt = JSON.parse(result.stdout);
  expect(receipt.trimmed).toHaveLength(1);
  expect(receipt.trimmed[0]).toMatchObject({ handle: "parked" });
  expect(result.stderr).toContain(
    "the stranded-mail report did not complete — trimmed rows may have unsettled payloads this run did not name (exit 1)",
  );
  expect(result.stderr).not.toMatch(/^ *at /m);
}, 20000);

test("hard refresh: a non-finite value anywhere does not blind the strand report", () => {
  const f = fixture();
  const registry = seedPostFlip(f, { parked: U4_ROW });
  const { payloads } = u4BusPaths(f);
  u4WritePayload(payloads, "u4finite", ["---", "id: u4finite", "from: alice", "to: parked", "to_team: roster", "---"]);
  // An incumbent-valid registry: python json.load accepts NaN/Infinity, and
  // the trim side rewrites such values losslessly. A parser that refuses the
  // file would drop the team name and the grants over an unrelated value.
  let bytes = readFileSync(registry, "utf8");
  bytes = bytes.replace(/\}\n$/, `,\n  "meta": {"weight": NaN, "cap": Infinity, "floor": -Infinity}\n}\n`);
  writeFileSync(registry, bytes, { mode: 0o640 });
  const result = run(["team", "refresh", "--hard", "--json"], f.worktree, f.env);
  expect(result.status, result.stderr).toBe(0);
  // The `to_team: roster` filter still matches (team name survived the parse)
  // and the whole sentence is intact — nothing degraded.
  expect(result.stderr).toContain(
    "trimming 'parked' strands 1 unsettled payload(s) addressed to it: u4finite. " +
    "the sender clears each stranded id (tap cancel u4finite --by alice), " +
    "or re-register a seat as 'parked' (tap in reclaims the handle and adopts this mail).",
  );
}, 20000);

test("hard refresh: a CR-only payload still counts as stranded mail with its sender", () => {
  const f = fixture();
  const { payloads } = u4BusPaths(f);
  seedPostFlip(f, { parked: U4_ROW });
  writeFileSync(
    join(payloads, "u4cr.md"),
    "---\rid: u4cr\rfrom: carol\rto: parked\r---\rbody\r",
  );
  const result = run(["team", "refresh", "--hard", "--json"], f.worktree, f.env);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain(
    "trimming 'parked' strands 1 unsettled payload(s) addressed to it: u4cr. " +
    "the sender clears each stranded id (tap cancel u4cr --by carol), " +
    "or re-register a seat as 'parked' (tap in reclaims the handle and adopts this mail).",
  );
}, 20000);

// --- PR1 whole-diff review: the trim's publication failure keeps the public boundary ---

test("hard refresh: an unpublishable registry refuses as registry_invalid, not a raw crash", () => {
  // The publication fault is armed with macOS chflags; Linux has no
  // equivalent here, and the regression would silently test nothing.
  if (process.platform !== "darwin") return;
  const f = fixture();
  const registry = seedPostFlip(f, { dead: { ...U3_PARKED, session: "absent" } });
  replaceTmux(f, u4StrandedStub());
  const before = readFileSync(registry);
  // The fault under test is PUBLICATION: after the lock is held, the read has
  // succeeded, and the candidate matches, the rewrite must refuse as
  // registry_invalid instead of crashing. An unwritable DIRECTORY cannot
  // reach that point (the lock protocol itself writes a grant marker beside
  // the sidecar), so the file is made immutable instead: the directory stays
  // writable, and the final rename fails. The arming result is asserted so a
  // fault that failed to arm is diagnosed here, not downstream.
  const flags = spawnSync("chflags", ["uchg", registry]);
  expect(flags.status, flags.stderr.toString()).toBe(0);
  try {
    const result = run(["team", "refresh", "--hard", "--json"], f.worktree, f.env);
    expect(result.status).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error_class).toBe("registry_invalid");
    expect(envelope.action).toBe("repair_registry");
    expect(typeof envelope.detail).toBe("string");
    expect(result.stderr).not.toMatch(/at |EPERM|Error:/);
    expect(readFileSync(registry).equals(before)).toBe(true);
  } finally {
    spawnSync("chflags", ["nouchg", registry]);
  }
}, 20000);

// --- Review: three parity seams the whole-diff pass caught ---

test("hard refresh: a namespace answer larger than the default buffer stays observable", () => {
  const f = fixture();
  const registry = seedPostFlip(f, { bigseat: { ...U3_PARKED, session: "sess-live" } });
  // The retired namespace child carried REGISTRY_MAX_BUFFER (64 MiB); Bun's
  // implicit ~1 MB default truncated a valid answer this large into an
  // unobservable namespace (measured: 2,000,000 bytes -> ENOBUFS).
  const big = Array.from({ length: 200_000 }, (_, i) => `sess-${i}`);
  big[123_456] = "sess-live";
  const bigFile = join(f.dir, "big-namespace.txt");
  writeFileSync(bigFile, big.join("\n") + "\n");
  replaceTmux(f, `case "$1" in -L|-S) shift; shift ;; esac
case "$1" in
  list-sessions) cat "${bigFile}" ;;
  *) exit 1 ;;
esac
`);
  const result = run(["team", "refresh", "--hard", "--json"], f.worktree, f.env);
  const envelope = JSON.parse(result.stdout);
  expect(envelope.trimmed).toEqual([]);
  expect(envelope.kept).toHaveLength(1);
  expect(envelope.kept[0].reason).toBe("hard_session_live");
  expect(readFileSync(registry).toString()).toContain("bigseat");
}, 30000);

test("hard refresh: a numeric team name never matches a payload's string to_team", () => {
  const f = fixture();
  const registry = seedPostFlip(
    f,
    { parked: { ...U3_PARKED, session: "absent" } },
    JSON.stringify({
      schema: "0.20",
      team: { name: 12345, worktree_root: f.worktree },
      seats: { parked: { ...U3_PARKED, session: "absent" } },
    }, null, 2) + "\n",
  );
  const bus = u4BusPaths(f);
  u4WritePayload(bus.payloads, "u4teamname", ["---", "id: u4teamname", "from: alice", "to: parked", "to_team: 12345", "kind: discuss", "reply: expected", "---", "body"]);
  replaceTmux(f, u4StrandedStub());
  const result = run(["team", "refresh", "--hard", "--json"], f.worktree, f.env);
  expect(result.status).toBe(0);
  const envelope = JSON.parse(result.stdout);
  expect(envelope.trimmed).toHaveLength(1);
  // The python incumbent keeps the numeric name as-is, so the string
  // "12345" cannot match it; native String() coercion invented the match.
  expect(result.stderr).not.toContain("WARNING: trimming");
  expect(readFileSync(registry).toString()).toContain("12345");
}, 20000);

test("hard refresh: a numeric team name as a string still matches to_team", () => {
  const f = fixture();
  seedPostFlip(
    f,
    { parked: { ...U3_PARKED, session: "absent" } },
    JSON.stringify({
      schema: "0.20",
      team: { name: "12345", worktree_root: f.worktree },
      seats: { parked: { ...U3_PARKED, session: "absent" } },
    }, null, 2) + "\n",
  );
  const bus = u4BusPaths(f);
  u4WritePayload(bus.payloads, "u4teamname", ["---", "id: u4teamname", "from: alice", "to: parked", "to_team: 12345", "kind: discuss", "reply: expected", "---", "body"]);
  replaceTmux(f, u4StrandedStub());
  const result = run(["team", "refresh", "--hard", "--json"], f.worktree, f.env);
  expect(result.status).toBe(0);
  expect(result.stderr).toContain("WARNING: trimming 'parked' strands 1 unsettled payload");
}, 20000);

test("hard refresh: a numeric reclaim grant does not match a string handle", () => {
  const f = fixture();
  seedPostFlip(
    f,
    {
      "1": { ...U3_PARKED, session: "absent" },
      succ: { status: "active", delivery: "pane", session: "s", harness: "codex", adopted_handles: [1] },
    },
    JSON.stringify({
      schema: "0.20",
      team: { name: "roster", worktree_root: f.worktree },
      seats: {
        "1": { ...U3_PARKED, session: "absent" },
        succ: { status: "active", delivery: "pane", session: "s", harness: "codex", adopted_handles: [1] },
      },
    }, null, 2) + "\n",
  );
  const bus = u4BusPaths(f);
  u4WritePayload(bus.payloads, "u4numgrant", ["---", "id: u4numgrant", "from: alice", "to: 1", "kind: discuss", "reply: expected", "---", "body"]);
  replaceTmux(f, u4StrandedStub());
  const result = run(["team", "refresh", "--hard", "--json"], f.worktree, f.env);
  expect(result.status).toBe(0);
  // The incumbent's json.load keeps the numeric key numeric, so grant 1
  // never reaches the string handle "1"; String() invented that grant and
  // suppressed the re-registration remedy.
  expect(result.stderr).toContain("or re-register a seat as '1'");
  expect(result.stderr).not.toContain("holds the reclaim grant");
}, 20000);

test("attach --next eligibility drops an otherwise-eligible poll row", () => {
  // The Bash poll-skip mutant died with tap-attach.sh (R11 U-A); the same
  // exclusion lives on in the filter: an eligible-looking poll row never wins.
  const rows = [
    { team: "demo", handle: "alpha", status: "active", delivery: "pane" },
    { team: "demo", handle: "delta", status: "active", delivery: "poll", pane: "demo/delta:0.0", pane_id: "%21", session: "demo/delta" },
  ] as unknown as RegistryRow[];
  const observed = new Map([
    ["alpha", ["active", "", "demo/alpha:0.0", "%11", "", "0"]],
    ["delta", ["active", "", "demo/delta:0.0", "%21", "", "0"]],
  ]);
  expect(nextEligible("", rows, observed)).toEqual(["alpha"]);
  expect(nextEligible("alpha", rows, observed)).toEqual([]);
});


function openCodeRosterFixture(secondSeat = false) {
  const f = fixture(); delete f.env.TAP_SERVER_EPOCH;
  replaceTmux(f, String.raw`
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
 list-sessions) printf 'live-session\t1:1\t1\nother-session\t1:1\t1\n' ;;
 list-panes) printf 'live-session\tlive-session:0.0\t%%7\topencode\t123\t1:1\t0\nother-session\tother-session:0.0\t%%8\topencode\t124\t1:1\t0\n' ;;
 capture-pane) printf '%s\n' 'Build GLM' ;;
 display-message) printf '1:1\n' ;;
 *) exit 1 ;;
esac`);
  const path = join(f.dir,"opencode.db"); f.env.OPENCODE_DB_PATH = path;
  const db = createOpenCodeStore(path);
  addSession(db,"seat",realpathSync(f.worktree));
  const usage={type:"assistant",model:{providerID:"zai",id:"glm"},time:{created:1,completed:2},tokens:{input:131,cache:{read:101696,write:0}}};
  addMessage(db,usage,{session:"seat"});
  const second = join(f.dir,"second-project"); mkdirSync(second);
  addSession(db,"seat2",second); addMessage(db,usage,{session:"seat2"}); db.close();
  const log=join(f.dir,"opencode.log");
  writeFileSync(join(f.dir,"bin","opencode"), `#!/bin/sh\necho unexpected >> '${log}'\nexit 1\n`,{mode:0o755});
  const publish=()=>{
    const folder=join(f.env.TAP_INDEX_HOME!,"opencode-model-windows.d");mkdirSync(folder,{recursive:true});
    writeFileSync(join(folder,"project.json"),JSON.stringify({directory:realpathSync(f.worktree),version:"2.1.2",fetched_at:Math.floor(Date.now()/1000),windows:{"zai/glm":420000}}));
  };
  seedPostFlip(f, {
    live:{status:"active",delivery:"pane",pane:"live-session:0.0",pane_id:"%7",session:"live-session",server_epoch:"srv:1:1",harness:"opencode",harness_session_id:"seat"},
    ...(secondSeat ? {other:{status:"active",delivery:"pane",pane:"other-session:0.0",pane_id:"%8",session:"other-session",server_epoch:"srv:1:1",harness:"opencode",harness_session_id:"seat2"}} : {}),
  });
  const calls = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
  return { f, calls, publish };
}

test("OpenCode roster reads plugin windows without starting a harness", () => {
  const { f, calls, publish } = openCodeRosterFixture();
  const unknown=run(["team"],f.worktree,f.env);
  expect(unknown.stdout).toContain("102k/?");
  expect(unknown.stderr).toContain("model window unavailable for live");
  expect(JSON.parse(run(["team","--json"],f.worktree,f.env).stdout).agents[0].context_tokens).toMatchObject({input_tokens:101827,window_tokens:null});
  publish();
  expect(run(["team"],f.worktree,f.env).stdout).toContain("102k/420k");
  const json=run(["team","--json"],f.worktree,f.env);
  expect(JSON.parse(json.stdout).agents[0].context_tokens).toMatchObject({input_tokens:101827,window_tokens:420000,used_percent:24,source:"opencode_store"});
  expect(calls()).toEqual([]);
});

test("retired --refresh-models prints a nonmutating notice and preserves JSON", () => {
  const { f, calls }=openCodeRosterFixture();
  const human=run(["team","--refresh-models"],f.worktree,f.env);
  expect(human.status).toBe(0); expect(human.stderr).toContain("--refresh-models is retired");
  expect(human.stdout).toContain("102k/?");
  const json=run(["team","--refresh-models","--json"],f.worktree,f.env);
  expect(json.status).toBe(0);expect(json.stderr).toBe("");
  expect(json.stdout.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(json.stdout).agents[0].context_tokens.window_tokens).toBeNull();
  const names=run(["team","--refresh-models","--names"],f.worktree,f.env);
  expect(names.status).toBe(1);expect(names.stderr).toContain("pick one");
  expect(calls()).toEqual([]);
});

test("roster filters share selection across output shapes and exclude daemons", () => {
  const f = fixture();
  const registry = seedPostFlip(f, {
    live: {status: "active", delivery: "pane", pane: "live-session:0.0", pane_id: "%7", session: "live-session", server_epoch: "srv:1:1", harness: "codex"},
    gone: {status: "active", delivery: "pane", pane: "gone:0.0", session: "gone", harness: "codex"},
    offline: {status: "offline", delivery: "pane", harness: "codex"},
    suspended: {status: "suspended", delivery: "pane", harness: "codex"},
    expired: {status: "expired", delivery: "pane", harness: "codex"},
    unknown: {status: "unknown", delivery: "pane", harness: "codex"},
    unbound: {status: "unbound", delivery: "pane", harness: "codex"},
    pending: {status: "pending", delivery: "pane", harness: "codex"},
    "a-poll": {status: "active", delivery: "poll", harness: "gateway-daemon"},
    "b-poll-offline": {status: "offline", delivery: "poll", harness: "cron-watch"},
    "c-daemon": {status: "offline", delivery: "pane", harness: "daemon"},
  });
  const before = readFileSync(registry);
  for (const [flag, expected] of [["--online", ["live"]], ["--offline", ["expired", "gone", "offline", "suspended"]]] as const) {
    for (const prefix of [["team"], ["team", "roster"], ["team", "roster", "roster"]]) {
      const names = run([...prefix, flag, "--names"], f.worktree, f.env);
      expect(names.status, names.stderr).toBe(0);
      expect(names.stdout).toBe(expected.join("\n") + "\n");
      const json = run([...prefix, "--json", flag], f.worktree, f.env);
      expect(json.status, json.stderr).toBe(0);
      expect(JSON.parse(json.stdout).agents.map((r: any) => r.handle)).toEqual([...expected]);
      for (const shape of [[], ["--all"]]) {
        const human = run([...prefix, flag, ...shape], f.worktree, f.env);
        expect(human.status, human.stderr).toBe(0);
        const handles = human.stdout.split("\n").slice(2).filter(l => l && !l.startsWith("Warning:")).map(l => l.trim().split(/\s+/)[0]);
        expect(handles).toEqual([...expected]);
      }
    }
  }
  for (const flags of [["--online", "--offline"], ["--offline", "--online", "--names"]]) {
    const result = run(["team", ...flags], f.worktree, f.env);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("mutually exclusive");
  }
  const human = run(["team"], f.worktree, f.env);
  expect(human.stdout).toMatch(/a-poll\s+daemon\s+● ready/);
  expect(human.stdout).toMatch(/b-poll-offline\s+daemon\s+● offline/);
  expect(human.stdout.indexOf("a-poll")).toBeGreaterThan(human.stdout.indexOf("unbound"));
  expect(human.stdout).not.toContain("\x1b");
  const json = JSON.parse(run(["team", "--json"], f.worktree, f.env).stdout);
  expect(json.agents.find((r: any) => r.handle === "a-poll")).toMatchObject({harness: "gateway-daemon", status: "active", agent_state: "unknown"});
  expect(readFileSync(registry)).toEqual(before);
}, 60_000);

test("daemon styling is terminal-only and respects NO_COLOR and TERM=dumb", () => {
  const f = fixture();
  seedPostFlip(f, { service: {status: "active", delivery: "poll", harness: "hermes"} });
  const env = {...f.env}; delete env.NO_COLOR;
  const styled = runTty(["team"], f.worktree, env);
  expect(styled.stdout).toContain("\x1b[3mdaemon\x1b[0m");
  expect(styled.stdout).toContain("\x1b[96m●\x1b[0m ready");
  expect(runTty(["team"], f.worktree, {...env, NO_COLOR: ""}).stdout).not.toContain("\x1b");
  const dumb = spawnSync("python3", ["-B", "-c", TTY_RUNNER, "120", shippedEntry, "team"], {cwd: f.worktree, env: {...env, TERM: "dumb"}, encoding: "utf8"});
  expect(dumb.status, dumb.stderr).toBe(0);
  expect(dumb.stdout).not.toContain("\x1b");
});

describe("team --include-crews", () => {
  function crewFixture() {
    const f = fixture();
    const pane = {delivery: "pane", pane: "live-session:0.0", pane_id: "%7", session: "live-session", server_epoch: "srv:1:1", status: "suspended"};
    seedPostFlip(f, {
      parent: {...pane, harness: "claude", model: "fable"},
      child: {...pane, harness: "codex", model: "gpt-6-sol", crew: true},
      sibling: {...pane, harness: "claude", model: "opus", crew: true},
    });
    return f;
  }

  test("unfiltered includes crews; every seat filter opts out unless explicitly included", () => {
    const f = crewFixture();
    const names = (...flags: string[]) => {
      const r = run(["team", "--names", ...flags], f.worktree, f.env);
      expect(r.status, r.stderr).toBe(0);
      return r.stdout.trim().split("\n").filter(Boolean);
    };
    expect(names()).toEqual(["child", "parent", "sibling"]);
    for (const filter of [["--harness", "codex"], ["--model", "gpt-6-sol"], ["--state", "offline"]]) {
      expect(names(...filter)).toEqual(filter[0] === "--state" ? ["parent"] : []);
      expect(names(...filter, "--include-crews")).toEqual(filter[0] === "--state" ? ["child", "parent", "sibling"] : ["child"]);
    }
    expect(names("--offline")).toEqual(["parent"]);
    expect(names("--offline", "--include-crews")).toEqual(["child", "parent", "sibling"]);
    const json = run(["team", "--include-crews", "--harness", "codex", "--json"], f.worktree, f.env);
    expect(json.status, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout).agents.map((r: any) => r.handle)).toEqual(["child"]);
    // A crew-only view still selects crews without needing the team opt-in.
    expect(run(["crew", "list", "--harness", "codex"], f.worktree, f.env).stdout).toContain("child");
  }, 60_000);

  test("cached filtered rosters distinguish crew inclusion", () => {
    const f = crewFixture();
    delete f.env.TAP_WATCH_NOW;
    f.env.TAP_ROSTER_CACHE_TTL = "60";
    for (const include of [false, true, true, false, false]) {
      const result = run(["team", "--harness", "codex", "--no-state", "--json", ...(include ? ["--include-crews"] : [])], f.worktree, f.env);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).agents.map((r: any) => r.handle)).toEqual(include ? ["child"] : []);
    }
  }, 30_000);

  test("matching child has a dim context parent, no unmatched siblings, and a plain-text marker", () => {
    const f = crewFixture();
    const args = ["team", "--include-crews", "--harness", "codex", "--wide"];
    const plain = run(args, f.worktree, f.env);
    expect(plain.status, plain.stderr).toBe(0);
    expect(plain.stdout).toMatch(/parent \(crew parent\).*context only/);
    expect(plain.stdout).toMatch(/^`-- child\s+codex/m);
    expect(plain.stdout).not.toContain("sibling");
    expect(plain.stdout).not.toContain("\x1b");
    const env = {...f.env}; delete env.NO_COLOR;
    const tty = runTty(args, f.worktree, env, 220);
    expect(tty.status, tty.stderr).toBe(0);
    expect(tty.stdout).toContain("\x1b[2mparent (crew parent)\x1b[0m");
    expect(tty.stdout).not.toContain("\x1b[2m`-- child");
    const allTty = runTty([...args, "--all"], f.worktree, env, 220);
    expect(allTty.status, allTty.stderr).toBe(0);
    expect(allTty.stdout).toContain("\x1b[2m10s/10s\x1b[0m");
    expect(runTty(args, f.worktree, {...env, NO_COLOR: ""}, 220).stdout).not.toContain("\x1b");
    const dumb = spawnSync("python3", ["-B", "-c", TTY_RUNNER, "220", shippedEntry, ...args], {cwd: f.worktree, env: {...env, TERM: "dumb"}, encoding: "utf8"});
    expect(dumb.status, dumb.stderr).toBe(0);
    expect(dumb.stdout).not.toContain("\x1b");
    for (const extra of [["--all"], ["--recent", "-n", "1"]]) {
      const r = run([...args, ...extra], f.worktree, f.env);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("parent (crew parent)");
      expect(r.stdout).toContain("child");
      expect(r.stdout).not.toContain("sibling");
    }
  }, 60_000);
});

test("filtered crew includes an excluded parent only as display context", () => {
  for (const [flag, parentStatus, childStatus] of [["--online", "suspended", "active"], ["--offline", "active", "suspended"]]) {
    const f = fixture();
    const pane = {delivery: "pane", pane: "live-session:0.0", pane_id: "%7", session: "live-session", server_epoch: "srv:1:1", harness: "codex"};
    seedPostFlip(f, { parent: {...pane, status: parentStatus}, child: {...pane, status: childStatus, crew: true} });
    const result = run(["team", flag!, "--include-crews"], f.worktree, f.env);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^`-- child\s+codex/m);
    expect(result.stdout).toContain("parent (crew parent)");
    expect(result.stdout).toContain("context only");
    expect(result.stderr).not.toContain("tap-zhx82");
  }
});

test("roster filter conflicts preserve JSON errors on named aliases", () => {
  const f = fixture(); seedPostFlip(f, {});
  for (const prefix of [["team"], ["team", "roster"], ["team", "roster", "roster"]]) {
    const result = run([...prefix, "--json", "--online", "--offline"], f.worktree, f.env);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ok: false, error_class: "usage_error", action: "tap help team", detail: "--online and --offline are mutually exclusive"});
  }
  // `teams roster` is the machine seat view, which beats this fixture's team named roster;
  // that view has no lifecycle flags, so it refuses them in its own JSON envelope.
  for (const prefix of [["teams", "roster"], ["team", "list", "roster"]]) {
    const result = run([...prefix, "--json", "--online", "--offline"], f.worktree, f.env);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ok: false, error_class: "usage_error", action: "tap help teams"});
  }
});

test("filtered crew nests under the first visible parent when earlier parents are excluded", () => {
  for (const [flag, hiddenStatus, visibleStatus] of [["--online", "suspended", "active"], ["--offline", "active", "suspended"]]) {
    const f = fixture();
    const pane = {delivery: "pane", pane: "live-session:0.0", pane_id: "%7", session: "live-session", server_epoch: "srv:1:1", harness: "codex"};
    seedPostFlip(f, {
      "a-hidden": {...pane, status: hiddenStatus},
      "b-visible": {...pane, status: visibleStatus},
      child: {...pane, status: visibleStatus, crew: true},
    });
    const result = run(["team", flag!, "--include-crews"], f.worktree, f.env);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^b-visible\s+codex/m);
    expect(result.stdout).toMatch(/^`-- child\s+codex/m);
    expect(result.stdout).not.toContain("a-hidden");
    expect(result.stderr).toContain("nesting under 'b-visible'");
    expect(result.stderr).not.toContain("a-hidden");
    expect(result.stderr).not.toContain("tap-zhx82");
  }
});

describe("tap team --stalled (tap-vl8cp)", () => {
  // One claude seat whose last turn ended 15m (900s) before TAP_WATCH_NOW, idle on screen.
  function stalledFixture(seat: Record<string, unknown> = {}) {
    const f = fixture();
    const capturePath = join(f.dir, "frame.txt");
    f.env.STATE_FRAME = capturePath;
    replaceTmux(f, String.raw`
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
  list-sessions) printf 'live-session\t1:1\t1\n' ;;
  list-panes) printf 'live-session\tlive-session:0.0\t%%7\tclaude\t123\t1:1\t0\n' ;;
  capture-pane) cat "$STATE_FRAME" ;;
  display-message) printf '1:1\n' ;;
  *) exit 1 ;;
esac`);
    const transcript = join(f.dir, "claude.jsonl");
    const endTurn = JSON.stringify({ type: "assistant", timestamp: "2026-08-27T00:05:00.000Z", message: { stop_reason: "end_turn" } });
    writeFileSync(transcript, `${endTurn}\n`);
    seedPostFlip(f, { live: { status: "active", delivery: "pane", pane: "live-session:0.0", pane_id: "%7",
      session: "live-session", server_epoch: "srv:1:1", harness: "claude", transcript_path: transcript, ...seat } });
    const rule = "─".repeat(40);
    const frame = (above: string) => `⏺ history\n${above}\n${rule} roster/live ─\n❯ \n${rule}\n  Opus 5.5 med | status\n  ⏵⏵ bypass permissions on · ← 3 agents\n`;
    const idle = () => writeFileSync(capturePath, frame("✻ Baked for 1m 29s · done 12:05 AM"));
    idle();
    const bus = join(f.worktree, ".tap", "bus");
    for (const dir of ["payloads", "receipts"]) mkdirSync(join(bus, dir), { recursive: true });
    const send = (id: string, fields = "reply: expected\n", to = "live") =>
      writeFileSync(join(bus, "payloads", `${id}.md`), `---\nid: ${id}\nfrom: lead\nto: ${to}\n${fields}---\nbody\n`);
    return { f, bus, send, idle, transcript, endTurn,
      working: () => writeFileSync(capturePath, frame("✢ Crystallizing… (3m 0s · ↓ 5k tokens)")),
      json: (...extra: string[]) => { const r = run(["team", "--json", ...extra], f.worktree, f.env); expect(r.status, r.stderr).toBe(0); return JSON.parse(r.stdout); } };
  }

  test("an idle seat past N that owes an ask is listed with its dated age; the JSON shape is additive", () => {
    const s = stalledFixture();
    s.send("ask-1", "kind: order\nreply: expected\n");
    const doc = s.json("--stalled");
    expect(doc.agents).toHaveLength(1);
    expect(doc.agents[0]).toMatchObject({ handle: "live", agent_state: "idle", turn_ended_at: "2026-08-27T00:05:00Z",
      stalled: true, stalled_for_seconds: 900, pending_inbound_ask: true });
    expect(doc.stalled_after_seconds).toBe(600);
    expect(doc.unjudged).toEqual([]);
    // Without the flag the document keeps its shape.
    const plain = s.json();
    expect(plain.agents[0]).not.toHaveProperty("stalled");
    expect(plain).not.toHaveProperty("unjudged");
    expect(plain).not.toHaveProperty("stalled_after_seconds");
    const human = run(["team", "--stalled"], s.f.worktree, s.f.env);
    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).toMatch(/live\s+claude\s+● idle 15m\s/);
    expect(human.stdout).toContain("stalled: 1 seat idle >= 600s with an unanswered ask");
    expect(run(["team", "--stalled", "--names"], s.f.worktree, s.f.env).stdout).toBe("live\n");
  }, 60_000);

  test("N is --stale-after seconds, inclusive; a seat under N is not listed", () => {
    const s = stalledFixture();
    s.send("ask-1");
    expect(s.json("--stalled", "--stale-after", "900").agents).toHaveLength(1);
    const under = s.json("--stalled", "--stale-after", "901");
    expect(under.agents).toEqual([]);
    expect(under.unjudged).toEqual([]);
    const human = run(["team", "--stalled", "--stale-after", "901"], s.f.worktree, s.f.env);
    expect(human.status).toBe(0);
    expect(human.stdout).toContain("tap team: no stalled seats (idle >= 901s with an unanswered ask)");
  }, 60_000);

  test("idle with nothing owed, a settled ask, or only a note is not listed", () => {
    const s = stalledFixture();
    expect(s.json("--stalled").agents).toEqual([]);
    s.send("note-1", "reply: settle-only\n");
    expect(s.json("--stalled").agents).toEqual([]);
    s.send("ask-1");
    expect(s.json("--stalled").agents).toHaveLength(1);
    writeFileSync(join(s.bus, "receipts", "ask-1.done"), "");
    expect(s.json("--stalled").agents).toEqual([]);
    rmSync(join(s.bus, "receipts", "ask-1.done"));
    writeFileSync(join(s.bus, "receipts", "ask-1.cancelled"), "");
    expect(s.json("--stalled").agents).toEqual([]);
  }, 60_000);

  test("a working seat is never listed, however long it owes", () => {
    const s = stalledFixture();
    s.send("ask-1");
    s.working();
    const doc = s.json("--stalled");
    expect(doc.agents).toEqual([]);
    expect(doc.unjudged).toEqual([]);
  }, 60_000);

  test("an undated idle seat is never stalled and is reported unjudged", () => {
    const s = stalledFixture();
    s.send("ask-1");
    writeFileSync(s.transcript, `${s.endTurn}\n${JSON.stringify({ type: "user", timestamp: "2026-08-27T00:06:00.000Z", message: {} })}\n`);
    const doc = s.json("--stalled");
    expect(doc.agents).toEqual([]);
    expect(doc.unjudged).toEqual([{ handle: "live", reason: "no_turn_end_date" }]);
    const human = run(["team", "--stalled"], s.f.worktree, s.f.env);
    expect(human.stdout).toContain("not judged: live (no dated turn end)");
  }, 60_000);

  test("an ask stamped for a retired recipient instance is not owed by the current seat", () => {
    const s = stalledFixture({ instance: "new" });
    s.send("ask-old", "reply: expected\nrecipient_instance: old\n");
    expect(s.json("--stalled").agents).toEqual([]);
    s.send("ask-new", "reply: expected\nrecipient_instance: new\n");
    expect(s.json("--stalled").agents).toHaveLength(1);
  }, 60_000);

  test("a registry the poll gate cannot read is unjudged, never a silent no-debt (review round 1)", () => {
    const s = stalledFixture({ instance: "new" });
    s.send("ask-new", "reply: expected\nrecipient_instance: new\n");
    expect(s.json("--stalled").agents).toHaveLength(1);
    // The roster reader accepts numeric extensions the write-safe loader (and so tap poll) refuses.
    const path = join(s.f.worktree, ".tap", "team-registry.json");
    const doc = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...doc, extension_cost: 0.5 }, null, 2) + "\n");
    const out = s.json("--stalled");
    expect(out.agents).toEqual([]);
    expect(out.unjudged).toEqual([{ handle: "live", reason: "inbound_unknown" }]);
  }, 60_000);

  test("a registry that turns unreadable after the roster read stays uncertainty, not a clean result (review round 2)", () => {
    const s = stalledFixture({ instance: "new" });
    s.send("ask-new", "reply: expected\nrecipient_instance: new\n");
    // Valid when readRegistry runs; malformed by the time capture-pane returns.
    s.f.env.RACE_REGISTRY = join(s.f.worktree, ".tap", "team-registry.json");
    replaceTmux(s.f, String.raw`
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
  list-sessions) printf 'live-session\t1:1\t1\n' ;;
  list-panes) printf 'live-session\tlive-session:0.0\t%%7\tclaude\t123\t1:1\t0\n' ;;
  capture-pane) printf broken > "$RACE_REGISTRY"; cat "$STATE_FRAME" ;;
  display-message) printf '1:1\n' ;;
  *) exit 1 ;;
esac`);
    const out = s.json("--stalled");
    expect(out.agents).toEqual([]);
    expect(out.unjudged).toEqual([{ handle: "live", reason: "inbound_unknown" }]);
  }, 60_000);

  test("a registry that vanishes after the roster read leaves adopted debt unknown, not clean (review round 3)", () => {
    const s = stalledFixture({ instance: "new", adopted_handles: ["pred"], adopted_instances: { pred: "old" } });
    s.send("kept", "reply: expected\nrecipient_instance: old\n", "pred");
    expect(s.json("--stalled").agents).toHaveLength(1);
    s.f.env.RACE_REGISTRY = join(s.f.worktree, ".tap", "team-registry.json");
    replaceTmux(s.f, String.raw`
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
  list-sessions) printf 'live-session\t1:1\t1\n' ;;
  list-panes) printf 'live-session\tlive-session:0.0\t%%7\tclaude\t123\t1:1\t0\n' ;;
  capture-pane) mv "$RACE_REGISTRY" "$RACE_REGISTRY.moved"; cat "$STATE_FRAME" ;;
  display-message) printf '1:1\n' ;;
  *) exit 1 ;;
esac`);
    const out = s.json("--stalled");
    expect(out.agents).toEqual([]);
    expect(out.unjudged).toEqual([{ handle: "live", reason: "inbound_unknown" }]);
  }, 60_000);

  test("mail an adopted predecessor owned is owed by its successor, in both addressing shapes (codex thread)", () => {
    const s = stalledFixture({ instance: "new", adopted_handles: ["pred"], adopted_instances: { pred: "old" } });
    // Still addressed to the predecessor, bound to its retired instance.
    s.send("kept", "reply: expected\nrecipient_instance: old\n", "pred");
    expect(s.json("--stalled").agents).toHaveLength(1);
    rmSync(join(s.bus, "payloads", "kept.md"));
    expect(s.json("--stalled").agents).toEqual([]);
    // Rewritten to the successor, still bound to the adopted instance.
    s.send("rewritten", "reply: expected\nto_adopted_from: pred\nrecipient_instance: old\n");
    expect(s.json("--stalled").agents).toHaveLength(1);
    rmSync(join(s.bus, "payloads", "rewritten.md"));
    // A stamp that is neither the current nor the adopted instance is nobody's debt here.
    s.send("stranger", "reply: expected\nto_adopted_from: pred\nrecipient_instance: ancient\n");
    expect(s.json("--stalled").agents).toEqual([]);
  }, 60_000);

  test("an unsanctioned reply value is no positive claim: the seat is unjudged", () => {
    const s = stalledFixture();
    s.send("odd", "reply: bogus\n");
    const out = s.json("--stalled");
    expect(out.agents).toEqual([]);
    expect(out.unjudged).toEqual([{ handle: "live", reason: "inbound_unknown" }]);
  }, 60_000);

  test("a rejected team-list flag keeps its JSON error when --json was asked", () => {
    const s = stalledFixture();
    const r = run(["team", "list", "--stalled", "--json"], s.f.worktree, s.f.env);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error_class: "unknown_option" });
    expect(r.stderr).toBe("");
  }, 60_000);

  test("the flag grammar refuses what it cannot honour", () => {
    const s = stalledFixture();
    const refuse = (argv: string[], text: RegExp) => {
      const r = run(["team", ...argv], s.f.worktree, s.f.env);
      expect(r.status, r.stdout).toBe(1);
      expect(r.stdout + r.stderr).toMatch(text);
    };
    refuse(["--stale-after", "600"], /--stale-after needs --stalled/);
    refuse(["--stalled", "--stale-after"], /--stale-after needs a value/);
    refuse(["--stalled", "--stale-after", "abc"], /--stale-after must be a positive integer/);
    refuse(["--stalled", "--stale-after", "0"], /--stale-after must be > 0/);
    refuse(["--stalled", "--all"], /--stalled and --all are alternative views/);
    refuse(["list", "--stalled"], /unknown option '--stalled'/);
  }, 60_000);

  test("tap help team documents the flag with a runnable example", () => {
    expect(run(["help", "team"], process.cwd(), process.env).stdout).toContain("tap team --stalled [--stale-after <secs>]");
    const page = run(["help", "team", "roster"], process.cwd(), process.env).stdout;
    expect(page).toContain("--stale-after <secs>");
    expect(page).toContain("tap team --stalled --stale-after 900 --json");
  });
});

describe("tap team --recent", () => {
  // TAP_WATCH_NOW is 2026-08-27T00:20:00Z. `live` works on screen but its transcript is days old,
  // so it sorts first only because the state pass saw it working.
  function recentFixture() {
    const f = fixture();
    const capturePath = join(f.dir, "frame.txt");
    f.env.STATE_FRAME = capturePath;
    replaceTmux(f, String.raw`
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
  list-sessions) printf 'live-session\t1:1\t1\n' ;;
  list-panes) printf 'live-session\tlive-session:0.0\t%%7\tclaude\t123\t1:1\t0\n' ;;
  capture-pane) cat "$STATE_FRAME" ;;
  display-message) printf '1:1\n' ;;
  *) exit 1 ;;
esac`);
    const rule = "─".repeat(40);
    writeFileSync(capturePath, `⏺ history\n✢ Crystallizing… (3m 0s · ↓ 5k tokens)\n${rule} roster/live ─\n❯ \n${rule}\n  Opus 5.5 med | status\n  ⏵⏵ bypass permissions on · ← 3 agents\n`);
    const liveTranscript = join(f.dir, "live.jsonl"), freshTranscript = join(f.dir, "fresh.jsonl");
    writeFileSync(liveTranscript, `${JSON.stringify({ type: "user", timestamp: "2026-08-25T00:20:00.000Z", message: {} })}\n`);
    writeFileSync(freshTranscript, `${JSON.stringify({ type: "user", timestamp: "2026-08-27T00:10:00.000Z" })}\n`);
    const parked = (session: string, extra: Record<string, unknown>) => ({ status: "suspended", delivery: "pane", pane: `${session}:0.0`, session, ...extra });
    seedPostFlip(f, {
      live: { status: "active", delivery: "pane", pane: "live-session:0.0", pane_id: "%7", session: "live-session",
        server_epoch: "srv:1:1", harness: "claude", transcript_path: liveTranscript, role: "leader" },
      fresh: parked("fresh-session", { harness: "codex", transcript_path: freshTranscript, last_launched: "2026-08-20T00:00:00Z" }),
      "tie-b": parked("tie-b-session", { harness: "agy", last_launched: "2026-08-26T12:00:00Z" }),
      "tie-a": parked("tie-a-session", { harness: "agy", last_launched: "2026-08-26T12:00:00Z" }),
      old: parked("old-session", { harness: "codex", exited_at: "2026-08-26T00:20:00Z", registered_at: "2026-08-01T00:00:00Z" }),
      nodate: parked("nodate-session", { harness: "cursor" }),
    });
    return f;
  }
  const ok = (r: ReturnType<typeof run>) => { expect(r.status, r.stderr).toBe(0); return r.stdout; };

  test("every output shape keeps one recency order: working first, undated last, ties by handle", () => {
    const f = recentFixture();
    const names = (...extra: string[]) => ok(run(["team", "--recent", "--names", ...extra], f.worktree, f.env));
    expect(names()).toBe("live\nfresh\ntie-a\ntie-b\nold\nnodate\n");
    // Without --recent the order is the registry's, and nothing is observed for --names.
    expect(ok(run(["team", "--names"], f.worktree, f.env))).toBe("fresh\nlive\nnodate\nold\ntie-a\ntie-b\n");
    const doc = JSON.parse(ok(run(["team", "--recent", "--json"], f.worktree, f.env)));
    expect(doc.agents.map((a: any) => [a.handle, a.last_active_at, a.last_active_source])).toEqual([
      ["live", "2026-08-27T00:20:00Z", "working"],
      ["fresh", "2026-08-27T00:10:00Z", "transcript"],
      ["tie-a", "2026-08-26T12:00:00Z", "launched"],
      ["tie-b", "2026-08-26T12:00:00Z", "launched"],
      ["old", "2026-08-26T00:20:00Z", "exited"],
      ["nodate", null, null],
    ]);
    expect(doc.agents[0].agent_state).toBe("working");
    // The fields are additive and appear only with --recent.
    const plain = JSON.parse(ok(run(["team", "--json"], f.worktree, f.env)));
    expect(plain.agents[0]).not.toHaveProperty("last_active_at");
    expect(plain.agents[0]).not.toHaveProperty("last_active_source");
    // The human roster is flat in that order (the leader is not hoisted) with a last-active column.
    const human = ok(run(["team", "--recent"], f.worktree, f.env)).split("\n");
    expect(human[0]).toBe("tap team: roster");
    expect(human[1]).toMatch(/^handle +harness +state +last active +context +family +model +preset$/);
    const cell = (line: string) => line.split(/ {2,}/)[3];
    expect(human.slice(2, 8).map(line => [line.split(/\s+/)[0], cell(line)])).toEqual([
      ["live", "working"], ["fresh", "10m"], ["tie-a", "12h20m"], ["tie-b", "12h20m"], ["old", "1d"], ["nodate", "-"],
    ]);
    // --all keeps its nine-column table, gains the column after status, and still sorts working first.
    const all = ok(run(["team", "--all", "--recent"], f.worktree, f.env)).split("\n");
    expect(all[1]).toMatch(/^handle +kind +harness +pane +status +last active +attached +unattended +reason +notes\/asks$/);
    expect(all.slice(2, 8).map(line => line.split(/\s+/)[0])).toEqual(["live", "fresh", "tie-a", "tie-b", "old", "nodate"]);
    expect(all[2]).toMatch(/^live \(leader\) +SEAT +claude +live-session:0\.0 +active +working /);
  }, 60_000);

  test("-n keeps the first n after filters and the sort; --no-state dates a working seat by its evidence", () => {
    const f = recentFixture();
    const names = (...extra: string[]) => ok(run(["team", "--recent", "--names", ...extra], f.worktree, f.env));
    expect(names("-n", "2")).toBe("live\nfresh\n");
    expect(names("-n", "1")).toBe("live\n");
    expect(names("-n", "50")).toBe("live\nfresh\ntie-a\ntie-b\nold\nnodate\n");
    expect(names("--offline", "-n", "2")).toBe("fresh\ntie-a\n");
    expect(names("--harness", "agy,cursor")).toBe("tie-a\ntie-b\nnodate\n");
    // No state pass: nothing is known to be working, so the live seat's days-old transcript places it.
    expect(names("--no-state")).toBe("fresh\ntie-a\ntie-b\nold\nlive\nnodate\n");
    // The roster door reaches the same order for a named team.
    expect(ok(run(["team", "roster", "roster", "--recent", "-n", "3", "--names"], f.worktree, f.env))).toBe("live\nfresh\ntie-a\n");
    expect(ok(run(["team", "-n", "2", "--recent", "--names"], f.worktree, f.env))).toBe("live\nfresh\n");
    const human = ok(run(["team", "--recent", "-n", "2"], f.worktree, f.env)).split("\n").filter(Boolean);
    expect(human.slice(2).map(line => line.split(/\s+/)[0])).toEqual(["live", "fresh"]);
  }, 60_000);

  test("the flat view keeps the ambiguous-session warning, and a daemon sorts by its own activity", () => {
    const f = fixture();
    const parked = (pane: string, extra: Record<string, unknown>) => ({ status: "suspended", delivery: "pane", pane, session: "old-session", harness: "codex", ...extra });
    seedPostFlip(f, {
      pa: parked("old-session:0.0", { registered_at: "2026-08-01T00:00:00Z" }),
      pb: parked("old-session:1.0", { last_launched: "2026-08-26T00:20:00Z" }),
      pc: parked("old-session:2.0", { crew: true, last_launched: "2026-08-27T00:00:00Z" }),
      zbot: { status: "active", delivery: "poll", harness: "pre-merge-watch", unattended: true, last_launched: "2026-08-27T00:19:00Z" },
    });
    const warning = "tap team: warning: multiple parent seats for session 'old-session' — nesting under 'pa'; see tap-7ph7f\n";
    const nested = run(["team"], f.worktree, f.env);
    expect(nested.status, nested.stderr).toBe(0);
    expect(nested.stderr).toBe(warning);
    const flat = run(["team", "--recent"], f.worktree, f.env);
    expect(flat.status, flat.stderr).toBe(0);
    // Same line on the same stream; the rows keep recency order, the daemon by its own launch.
    expect(flat.stderr).toBe(warning);
    expect(flat.stdout.split("\n").slice(2).filter(Boolean).map(line => line.split(/\s+/)[0])).toEqual(["zbot", "pc", "pb", "pa"]);
    expect(ok(run(["team", "--recent", "--names"], f.worktree, f.env))).toBe("zbot\npc\npb\npa\n");
  }, 60_000);

  // Review fixtures (astra-ponytail): `a` launched a minute after TAP_WATCH_NOW (clock skew), and `oc`,
  // an OpenCode seat whose newest message has a creation time no Date can hold.
  function reviewFixture() {
    const f = recentFixture();
    const path = join(f.worktree, ".tap", "team-registry.json");
    const doc = JSON.parse(readFileSync(path, "utf8"));
    doc.seats.a = { status: "suspended", delivery: "pane", pane: "a-session:0.0", session: "a-session", harness: "agy", last_launched: "2026-08-27T00:21:00Z" };
    doc.seats.oc = { status: "suspended", delivery: "pane", pane: "oc-session:0.0", session: "oc-session", harness: "opencode",
      harness_session_id: "ses_far", last_launched: "2026-08-26T06:20:00Z" };
    writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
    const db = createOpenCodeStore(f.env.OPENCODE_DB_PATH!);
    addSession(db, "ses_far", f.worktree);
    addMessage(db, { type: "assistant", time: { created: 9000000000000000 } }, { session: "ses_far" });
    db.close();
    return f;
  }

  test("review 1: a working seat outranks a future-dated one, which reads just now", () => {
    const f = reviewFixture();
    expect(ok(run(["team", "--recent", "-n", "1", "--names"], f.worktree, f.env))).toBe("live\n");
    expect(ok(run(["team", "--recent", "-n", "2", "--names"], f.worktree, f.env))).toBe("live\na\n");
    const human = ok(run(["team", "--recent", "-n", "2"], f.worktree, f.env)).split("\n");
    expect(human[3]!.split(/ {2,}/)[3]).toBe("just now");
  }, 60_000);

  test("review 2: -n reads the word after it as typed, before seat filters are lifted out", () => {
    const f = recentFixture();
    const missing = run(["team", "roster", "--recent", "-n", "--harness", "codex", "2", "--names"], f.worktree, f.env);
    expect({ exit: missing.status, stdout: missing.stdout, stderr: missing.stderr }).toEqual({ exit: 1, stdout: "",
      stderr: "tap team roster: -n needs a positive integer: the number of rows to keep, e.g. -n 15; next: tap help team\n" });
    expect(ok(run(["team", "--recent", "--harness", "codex", "-n", "1", "--names"], f.worktree, f.env))).toBe("fresh\n");
  }, 60_000);

  // Every placement of `-n 2`, `--harness codex` and the team operand `roster`, through both verbs. Each
  // value flag takes the word typed after it, so lifting one flag never joins another word to a flag.
  // The fixture's freshest seat is not codex and three codex seats differ in recency, so a dropped filter
  // or a dropped -n both change the names. `tap teams` has no team operand: there the well-formed rows
  // refuse the stray `roster`, and every refusal names the same flag as on tap team.
  test("value flags read the word typed after them, whatever other flags sit around them", () => {
    const f = recentFixture();
    const path = join(f.worktree, ".tap", "team-registry.json");
    const doc = JSON.parse(readFileSync(path, "utf8"));
    doc.seats.mid = { status: "suspended", delivery: "pane", pane: "mid-session:0.0", session: "mid-session", harness: "codex", last_launched: "2026-08-26T18:00:00Z" };
    writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
    const H = ["--harness", "codex"], N = ["-n", "2"], T = "roster";
    const picked = "fresh\nmid\n", stray = "tap: error: unrecognized arguments: roster";
    const needsN = "-n needs a positive integer: the number of rows to keep, e.g. -n 15", needsH = "--harness needs a comma list of values";
    const badHarness = `--harness 'roster' is not a supported harness (one of: ${SEAT_HARNESS_VALUES.join(", ")})`;
    // [words after --recent, tap team roster … --names, tap teams …]; a string is the names printed, {refused} the detail.
    type Outcome = string | { refused: string } | null;
    const rows: [string[], Outcome, Outcome][] = [
      [[...N, ...H, T], picked, { refused: stray }],
      [[...H, ...N, T], picked, { refused: stray }],
      [[...H, T, ...N], picked, { refused: stray }],
      [[T, ...N, ...H], picked, { refused: stray }],
      [[T, ...H, ...N], picked, { refused: stray }],
      [[...N, T, ...H], picked, { refused: stray }],
      [[...H, "--context", ...N, T], picked, { refused: "tap: error: unrecognized arguments: --context roster" }],
      // --harness takes -n as its value; -n takes --harness as its value.
      [["--harness", "-n", "2", "codex", T], { refused: needsH }, { refused: needsH }],
      [["-n", "--harness", "codex", "2", T], { refused: needsN }, { refused: needsN }],
      [["-n", T, "2", ...H], { refused: "-n must be a positive integer, got 'roster'" }, { refused: "-n must be a positive integer, got 'roster'" }],
      [["--harness", T, ...N], { refused: badHarness }, { refused: badHarness }],
      [[...H, T, "-n"], { refused: needsN }, { refused: needsN }],
      [[...N, T, "--harness"], { refused: needsH }, { refused: needsH }],
      // A display switch is not lifted out from under a value flag either.
      [["-n", "--context", "2", T], { refused: needsN }, { refused: needsN }],
      [["--harness", "--context", "codex", T], { refused: needsH }, { refused: needsH }],
      // --stale-after takes the next word too (tap team only), so --harness is its value, not a filter.
      [["--stalled", "--stale-after", "--harness", "codex", "600", T], { refused: "--stale-after must be a positive integer (seconds), got '--harness'" }, null],
      // A repeated value flag checks every value as it is read, so a later one cannot hide a bad one.
      [["--stalled", "--stale-after", "--harness", "codex", "--stale-after", "600"], { refused: "--stale-after must be a positive integer (seconds), got '--harness'" }, null],
      [["-n", "x", "-n", "2", T], { refused: "-n must be a positive integer, got 'x'" }, { refused: "-n must be a positive integer, got 'x'" }],
      [[...H, "-n", "1", "-n", "2", T], picked, { refused: stray }],
    ];
    const seen = (argv: string[]) => { const r = run(argv, f.worktree, f.env); return { exit: r.status, stdout: r.stdout, stderr: r.stderr }; };
    const want = (verb: string, outcome: string | { refused: string }, action: string) => typeof outcome === "string"
      ? { exit: 0, stdout: outcome, stderr: "" } : { exit: 1, stdout: "", stderr: `${verb}: ${outcome.refused}; next: ${action}\n` };
    // Every row runs before the assertion, so a failure lists each wrong placement at once.
    const wrong: unknown[] = [];
    const check = (argv: string[], expected: ReturnType<typeof want>) => {
      const got = seen(argv);
      if (!Bun.deepEquals(got, expected)) wrong.push({ argv: argv.join(" "), got, expected });
    };
    for (const [words, team, teams] of rows) {
      if (team !== null) check(["team", "roster", "--recent", ...words, "--names"], want("tap team roster", team, "tap help team"));
      if (teams !== null) check(["teams", "--recent", ...words], want("tap teams", teams, "tap help teams"));
    }
    expect(wrong).toEqual([]);
  }, 180_000);

  test("review 3: an out-of-range timestamp is undated in every shape; the seat falls back to its launch", () => {
    const f = reviewFixture();
    for (const extra of [["--no-state"], []]) {
      const json = run(["team", "--recent", "--json", ...extra], f.worktree, f.env);
      expect(json.status, json.stderr).toBe(0);
      expect(JSON.parse(json.stdout).agents.find((a: any) => a.handle === "oc")).toMatchObject({ last_active_at: "2026-08-26T06:20:00Z", last_active_source: "launched" });
    }
    // Between tie-b (12h20m) and old (1d), in names and in the human roster alike.
    expect(ok(run(["team", "--recent", "--names", "--no-state"], f.worktree, f.env))).toBe("a\nfresh\ntie-a\ntie-b\noc\nold\nlive\nnodate\n");
    const human = ok(run(["team", "--recent"], f.worktree, f.env)).split("\n").filter(line => line.startsWith("oc "));
    expect(human.map(line => line.split(/ {2,}/)[3])).toEqual(["18h00m"]);
  }, 60_000);

  test("-n refuses a missing, non-positive or glued value and needs --recent", () => {
    const f = recentFixture();
    const refused = (args: string[], detail: string) => {
      const r = run(["team", ...args], f.worktree, f.env);
      expect({ exit: r.status, stdout: r.stdout, stderr: r.stderr }, args.join(" ")).toEqual({ exit: 1, stdout: "", stderr: `tap team: ${detail}; next: tap help team\n` });
    };
    refused(["-n", "5"], "-n limits a --recent listing; add --recent");
    refused(["--all", "-n", "5"], "-n limits a --recent listing; add --recent");
    refused(["--recent", "-n"], "-n needs a positive integer: the number of rows to keep, e.g. -n 15");
    refused(["--recent", "-n", "--names"], "-n needs a positive integer: the number of rows to keep, e.g. -n 15");
    for (const value of ["0", "-2", "x"]) refused(["--recent", "-n", value], `-n must be a positive integer, got '${value}'`);
    refused(["--recent", "-n5"], "-n takes its value as a separate word: -n <n>");
    refused(["-n5", "--recent"], "-n takes its value as a separate word: -n <n>");
    const json = run(["team", "--recent", "-n", "0", "--json"], f.worktree, f.env);
    expect(json.status).toBe(1);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)).toEqual({ ok: false, error_class: "usage_error", action: "tap help team", detail: "-n must be a positive integer, got '0'" });
    const roster = run(["team", "roster", "roster", "-n", "3"], f.worktree, f.env);
    expect({ exit: roster.status, stderr: roster.stderr }).toEqual({ exit: 1, stderr: "tap team roster: -n limits a --recent listing; add --recent; next: tap help team\n" });
  }, 60_000);
});

test("plugin windows stay directory-specific and a missing session remains unknown", () => {
  const {f,calls,publish}=openCodeRosterFixture(true);publish();
  const result=run(["team","--refresh-models","--json"],f.worktree,f.env);
  expect(result.status).toBe(0);expect(result.stderr).toBe("");
  const agents=JSON.parse(result.stdout).agents as {handle:string;context_tokens:{input_tokens:number|null;window_tokens:number|null}}[];
  expect(agents.find(a=>a.handle==="live")?.context_tokens).toMatchObject({input_tokens:101827,window_tokens:420000});
  expect(agents.find(a=>a.handle==="other")?.context_tokens).toMatchObject({input_tokens:101827,window_tokens:null});
  const db=new Database(join(f.dir,"opencode.db"));db.query("DELETE FROM session_v2").run();db.close();
  const none=run(["team","--refresh-models","--json"],f.worktree,f.env);
  expect(none.status).toBe(0);expect(none.stderr).toBe("");
  expect(JSON.parse(none.stdout).agents.every((a:any)=>a.context_tokens?.input_tokens==null)).toBe(true);
  expect(calls()).toEqual([]);
});

test("team context keeps usage and adds cache estimates with a separate JSON schema", () => {
  const f = fixture();
  replaceTmux(f, String.raw`
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
 list-sessions) printf 'live-session\t1:1\t1\n' ;;
 list-panes) printf 'live-session\tlive-session:0.0\t%%7\tclaude\t123\t1:1\t0\n' ;;
 capture-pane) printf '❯ \n' ;;
 display-message) printf '1:1\n' ;;
 *) exit 1 ;;
esac`);
  const transcript = join(f.dir,"cache.jsonl");
  const timestamp = new Date(Date.now()-60_000).toISOString();
  writeFileSync(transcript,JSON.stringify({type:"assistant",sessionId:"seat",timestamp,message:{model:"claude-opus",usage:{
    input_tokens:1000,cache_creation_input_tokens:1000,cache_read_input_tokens:0,
    cache_creation:{ephemeral_1h_input_tokens:1000,ephemeral_5m_input_tokens:0}}}})+"\n");
  seedPostFlip(f,{live:{status:"active",delivery:"pane",pane:"live-session:0.0",pane_id:"%7",session:"live-session",server_epoch:"srv:1:1",harness:"claude",harness_session_id:"seat",transcript_path:transcript}});
  const result = run(["team","--json"],f.worktree,f.env);
  expect(result.status,result.stderr).toBe(0);
  const row = JSON.parse(result.stdout).agents[0];
  expect(row.status,JSON.stringify(row)).toBe("active");
  expect(row.prompt_cache).toMatchObject({state:"warm",ttl_seconds:3600,basis:"assistant_timestamp"});
  expect(row.context_tokens.input_tokens).toBe(2000);
  expect(row.context_tokens).not.toHaveProperty("prompt_cache");
  const human = run(["team","--wide"],f.worktree,f.env);
  expect(human.stdout).toContain("●59m");
  expect(human.stdout).toContain("2k");
});


test("cache colors survive a last-kept context column and honor all monochrome modes", () => {
  const f = fixture();
  replaceTmux(f, String.raw`
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
 list-sessions) printf 'live-session\t1:1\t1\n' ;;
 list-panes) printf 'live-session\tlive-session:0.0\t%%7\tclaude\t123\t1:1\t0\n' ;;
 capture-pane) printf '❯ \n' ;;
 display-message) printf '1:1\n' ;;
 *) exit 1 ;;
esac`);
  const transcript = join(f.dir,"cache-colors.jsonl");
  const setCache = (age: number, known = true) => writeFileSync(transcript,JSON.stringify({type:"assistant",sessionId:"seat",
    timestamp:new Date(Date.now()-age*1000).toISOString(),message:{model:"claude-opus",usage:{input_tokens:1000,
      cache_creation_input_tokens:1000,cache_read_input_tokens:0,...(known ? {cache_creation:{ephemeral_1h_input_tokens:1000,ephemeral_5m_input_tokens:0}} : {})}}})+"\n");
  seedPostFlip(f,{live:{status:"active",delivery:"pane",pane:"live-session:0.0",pane_id:"%7",session:"live-session",
    server_epoch:"srv:1:1",harness:"claude",harness_session_id:"seat",transcript_path:transcript}});
  const env = {...f.env}; delete env.NO_COLOR;
  for (const [age,marker,color] of [[60,"●59m","94"],[3000,"●10m","33"],[3540,"●1m","31"],[3700,"●","38;5;88"]] as const) {
    setCache(age);
    const narrow = runTty(["team"],f.worktree,env,40);
    expect(narrow.status,narrow.stderr).toBe(0);
    expect(narrow.stdout).toContain(`\x1b[${color}m${marker}\x1b[0m`);
    expect(narrow.stdout).toMatch(/handle +harness +state +context\r?\n/);
    expect(narrow.stdout).not.toContain("...");
    for (const out of [runTty(["team"],f.worktree,{...env,NO_COLOR:""}),run(["team"],f.worktree,env),
      spawnSync("python3",["-B","-c",TTY_RUNNER,"120",shippedEntry,"team"],{cwd:f.worktree,env:{...env,TERM:"dumb"},encoding:"utf8"})]) {
      expect(out.status,out.stderr).toBe(0);
      expect(out.stdout).not.toContain("\x1b");
      expect(out.stdout).toMatch(new RegExp(`2k ${marker}(?: +|\\r?\\n)`));
    }
  }
  setCache(60,false);
  const unknown = runTty(["team"],f.worktree,{...env,NO_COLOR:""});
  expect(unknown.stdout).not.toMatch(/2k ●/);
},60_000);

test("doctor seat-state matches roster reasons and remains read-only even with --fix", () => {
  const f = fixture();
  const frame = join(f.dir, "doctor-frame"), trace = join(f.dir, "doctor-trace");
  f.env.STATE_FRAME = frame; f.env.TMUX_TRACE = trace;
  replaceTmux(f, String.raw`
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
printf '%s\n' "$*" >> "$TMUX_TRACE"
case "$1" in
 list-sessions) printf 'live-session\t1:1\t1\n' ;;
 list-panes) printf 'live-session\tlive-session:0.0\t%%7\tcodex\t123\t1:1\t0\n' ;;
 capture-pane) cat "$STATE_FRAME" ;;
 display-message) case "$*" in *pane_title*) printf 'Demo\n' ;; *) printf '1:1\n' ;; esac ;;
 *) exit 1 ;;
esac`);
  const registry = seedPostFlip(f, { live: { status: "active", delivery: "pane", pane: "live-session:0.0", pane_id: "%7",
    session: "live-session", server_epoch: "srv:1:1", harness: "codex" },
    daemon: { status: "active", delivery: "poll", harness: "daemon" },
    stopped: { status: "suspended", delivery: "pane", harness: "codex", pane: "old:0.0", session: "old" },
  });
  const before = readFileSync(registry, "utf8");
  for (const [file, state, next] of [
    ["errors/codex-usage-limit.ansi", "error", "tap nudge roster/live"],
    ["codex/blocked-real.txt", "blocked", "tap attach roster/live"],
    ["codex/fresh-warning-fast.ansi", "idle", ""],
  ]) {
    writeFileSync(frame, readFileSync(join(root, "runtime/bun/test/fixtures/agent-state", file!), "utf8"));
    const roster = JSON.parse(run(["team", "--json"], f.worktree, f.env).stdout).agents.find((row: {handle: string}) => row.handle === "live");
    writeFileSync(trace, "");
    const checked = run(["team", "doctor", "--fix", "--only", "seat-state", "--json"], f.worktree, f.env);
    expect(checked.status, checked.stderr).toBe(0);
    const report = JSON.parse(checked.stdout), finding = report.findings[0];
    expect(report).toMatchObject({ ok: true, summary: { torn: 0, unattributed: 0, clean: true, seat_attention: state === "idle" ? 0 : 1 } });
    expect(report.findings).toHaveLength(1);
    expect(finding).toMatchObject({ name: "seat-state", detail: { handle: "live", agent_state: state,
      agent_state_reason: roster.agent_state_reason } });
    if (next) expect(finding.next).toBe(next);
    expect(readFileSync(trace, "utf8").match(/capture-pane/g)).toHaveLength(1);
    expect(readFileSync(registry, "utf8")).toBe(before);
    const human = run(["team", "doctor", "--only", "seat-state"], f.worktree, f.env);
    expect(human.status, human.stderr).toBe(0);
    if (state === "idle") expect(human.stdout).toContain("✓ no issues detected");
    else {
      expect(human.stdout).toContain(`${state} (${roster.agent_state_reason})`);
      expect(human.stdout).toContain(next!);
      expect(human.stdout).not.toContain("✓");
    }
  }
  writeFileSync(frame, "unreadable frame\n");
  const unknown = run(["team", "doctor", "--only", "seat-state", "--json"], f.worktree, f.env);
  expect(JSON.parse(unknown.stdout)).toMatchObject({summary:{clean:true,seat_attention:0}, findings:[{detail:{outcome:"skipped",agent_state:"unknown"}}]});
  const combined = JSON.parse(run(["team", "doctor", "--json"], f.worktree, f.env).stdout);
  expect(combined.findings.map((v: {name: string}) => v.name)).toEqual(["session-binding", "session-binding", "session-binding", "seat-state"]);
  expect(readFileSync(registry, "utf8")).toBe(before);
}, 30_000);

describe("shared seat filters on tap team", () => {
  // Two live panes share one frame; the transcript dates the claude seat's turn end 15m before TAP_WATCH_NOW.
  function filterFixture() {
    const f = fixture();
    const capturePath = join(f.dir, "frame.txt");
    f.env.STATE_FRAME = capturePath;
    replaceTmux(f, String.raw`
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
  list-sessions) printf 'live-session\t1:1\t1\n' ;;
  list-panes) printf 'live-session\tlive-session:0.0\t%%7\tclaude\t123\t1:1\t0\nlive-session\tlive-session:0.1\t%%8\tclaude\t124\t1:1\t0\n' ;;
  capture-pane) cat "$STATE_FRAME" ;;
  display-message) printf '1:1\n' ;;
  *) exit 1 ;;
esac`);
    const rule = "─".repeat(40);
    writeFileSync(capturePath, `⏺ history\n✻ Baked for 1m 29s · done 12:05 AM\n${rule} roster/live ─\n❯ \n${rule}\n  Opus 5.5 med | status\n  ⏵⏵ bypass permissions on · ← 3 agents\n`);
    const transcript = join(f.dir, "claude.jsonl");
    writeFileSync(transcript, `${JSON.stringify({ type: "assistant", timestamp: "2026-08-27T00:05:00.000Z", message: { stop_reason: "end_turn" } })}\n`);
    const pane = (id: string, index: number) => ({ status: "active", delivery: "pane", pane: `live-session:0.${index}`, pane_id: id, session: "live-session", server_epoch: "srv:1:1", harness: "claude" });
    seedPostFlip(f, {
      dated: { ...pane("%7", 0), transcript_path: transcript, launch_tuning: { model: "opus[1m]", effort: "xhigh" } },
      undated: { ...pane("%8", 1), launch_tuning: { model: "claude-fable-5-1", effort: "low" } },
      resting: { status: "offline", delivery: "pane", harness: "codex", launch_tuning: { model: "gpt-6-astra", effort: "high" } },
      gateway: { status: "active", delivery: "poll", harness: "gateway-daemon" },
    });
    // Every output shape must select the same seats; returns them sorted.
    const selected = (...flags: string[]): string[] => {
      const names = run(["team", "--names", ...flags], f.worktree, f.env);
      expect(names.status, names.stderr).toBe(0);
      const json = run(["team", "--json", ...flags], f.worktree, f.env);
      expect(json.status, json.stderr).toBe(0);
      const human = run(["team", ...flags], f.worktree, f.env);
      expect(human.status, human.stderr).toBe(0);
      const handles = names.stdout.split("\n").filter(Boolean).sort();
      expect(JSON.parse(json.stdout).agents.map((seat: { handle: string }) => seat.handle).sort()).toEqual(handles);
      const rows = human.stdout.split("\n").slice(2).filter(line => line && !line.startsWith("Warning:") && !line.startsWith("tap team:")).map(line => line.trim().split(/\s+/)[0]);
      expect(rows.sort()).toEqual(handles);
      return handles;
    };
    return { f, selected };
  }

  test("--harness, --model and --state select identical seats in --names, --json and the table", () => {
    const { selected } = filterFixture();
    expect(selected("--harness", "codex")).toEqual(["resting"]);
    expect(selected("--harness", "CLAUDE,codex")).toEqual(["dated", "resting", "undated"]);
    expect(selected("--harness", "daemon")).toEqual(["gateway"]);
    expect(selected("--model", "fable5.1")).toEqual(["undated"]);
    expect(selected("--model", "astra,opus")).toEqual(["dated", "resting"]);
    expect(selected("--state", "offline")).toEqual(["resting"]);
    expect(selected("--state", "ready")).toEqual(["gateway"]);
    expect(selected("--state", "idle")).toEqual(["dated", "undated"]);
    expect(selected("--harness", "claude", "--model", "opus")).toEqual(["dated"]);
    expect(selected("--harness", "codex", "--model", "opus")).toEqual([]);
  }, 120_000);

  test("--state active drops the dated long idle, keeps the undated idle and live daemons, and excludes offline", () => {
    const { selected, f } = filterFixture();
    expect(selected("--state", "active")).toEqual(["gateway", "undated"]);
    // The threshold is exact: a turn that ended 599s ago is still active, 600s ago is not.
    const ended = Date.parse("2026-08-27T00:05:00.000Z") / 1000;
    f.env.TAP_WATCH_NOW = String(ended + 599);
    expect(selected("--state", "active")).toEqual(["dated", "gateway", "undated"]);
    f.env.TAP_WATCH_NOW = String(ended + 600);
    expect(selected("--state", "active")).toEqual(["gateway", "undated"]);
  }, 120_000);

  test("filters AND with --online, --offline and --all, and refuse before any selection", () => {
    const { selected, f } = filterFixture();
    expect(selected("--online", "--state", "active")).toEqual(["undated"]);
    expect(selected("--offline", "--harness", "claude")).toEqual([]);
    expect(selected("--offline", "--harness", "codex")).toEqual(["resting"]);
    const all = run(["team", "--all", "--harness", "codex"], f.worktree, f.env);
    expect(all.status, all.stderr).toBe(0);
    expect(all.stdout).toMatch(/\bresting\b/);
    expect(all.stdout).not.toContain("dated");
    const none = run(["team", "--model", "nothing-here"], f.worktree, f.env);
    expect({ status: none.status, stdout: none.stdout }).toEqual({ status: 0, stdout: "tap team: no seats match these filters\n" });
    const bad = run(["team", "--state", "sleeping"], f.worktree, f.env);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toBe("");
    expect(bad.stderr).toContain("--state 'sleeping' is not a supported seat state (one of: working,");
    const badJson = run(["team", "roster", "--json", "--state", "sleeping"], f.worktree, f.env);
    expect(badJson.status).toBe(1);
    expect(JSON.parse(badJson.stdout)).toMatchObject({ ok: false, error_class: "usage_error", action: "tap help team" });
    const missing = run(["team", "--harness"], f.worktree, f.env);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("--harness needs a comma list of values");
  }, 120_000);

  test("--stalled judges only the seats the filters keep", () => {
    const { f } = filterFixture();
    // Both idle claude seats owe an ask: the dated one is stalled, the undated one unjudged.
    const bus = join(f.worktree, ".tap", "bus");
    for (const dir of ["payloads", "receipts"]) mkdirSync(join(bus, dir), { recursive: true });
    for (const to of ["dated", "undated"]) writeFileSync(join(bus, "payloads", `ask-${to}.md`), `---\nid: ask-${to}\nfrom: lead\nto: ${to}\nreply: expected\n---\nbody\n`);
    const judged = (...flags: string[]) => {
      const r = run(["team", "--json", "--stalled", ...flags], f.worktree, f.env);
      expect(r.status, r.stderr).toBe(0);
      const doc = JSON.parse(r.stdout);
      return { stalled: doc.agents.map((seat: { handle: string }) => seat.handle), unjudged: doc.unjudged.map((seat: { handle: string }) => seat.handle) };
    };
    expect(judged()).toEqual({ stalled: ["dated"], unjudged: ["undated"] });
    expect(judged("--model", "fable")).toEqual({ stalled: [], unjudged: ["undated"] });
    expect(judged("--model", "opus")).toEqual({ stalled: ["dated"], unjudged: [] });
    expect(judged("--harness", "codex")).toEqual({ stalled: [], unjudged: [] });
    const human = run(["team", "--stalled", "--model", "opus"], f.worktree, f.env);
    expect(human.stdout).toContain("stalled: 1 seat idle >= 600s with an unanswered ask (of 1)");
  }, 60_000);

  test("tap crew list and tap team calibration take the filters", () => {
    const { f } = filterFixture();
    const crew = run(["crew", "list", "--state", "sleeping"], f.worktree, f.env);
    expect(crew.status).toBe(1);
    expect(crew.stderr).toContain("'sleeping'");
    const stray = run(["crew", "list", "--json"], f.worktree, f.env);
    expect(stray.status).toBe(1);
    expect(stray.stderr).toContain("unexpected arg '--json'");
    const calibration = run(["team", "calibration", "--harness", "codex"], f.worktree, f.env);
    expect(calibration.status, calibration.stderr).toBe(0);
    expect(calibration.stdout).toContain("resting");
    expect(calibration.stdout).not.toContain("undated");
  }, 60_000);

  test("--active is the alias of --online: same stdout, one stderr line naming it", () => {
    const { f } = filterFixture();
    for (const shape of [["--names"], ["--json"], []]) {
      const online = run(["team", "--online", ...shape], f.worktree, f.env);
      const alias = run(["team", "--active", ...shape], f.worktree, f.env);
      expect(online.status, online.stderr).toBe(0);
      expect(alias.status).toBe(0);
      // Capture and observation timestamps use each run's wall clock.
      const stable = (text: string) => {
        if (!text.startsWith("{")) return text;
        const doc = JSON.parse(text); doc.observed_at = null;
        for (const row of doc.agents) row.sampled_at = null;
        return JSON.stringify(doc);
      };
      expect(stable(alias.stdout)).toBe(stable(online.stdout));
      expect(online.stderr).not.toContain("--online");
      expect(alias.stderr.split("\n").filter(line => line.includes("--online"))).toEqual(["tap team: --active is now --online; it still works during migration"]);
    }
    const clash = run(["team", "--active", "--offline"], f.worktree, f.env);
    expect(clash.status).toBe(1);
    expect(clash.stderr).toContain("--online and --offline are mutually exclusive");
  }, 60_000);

  test("the model column shows short names, JSON keeps raw ids, and effort color follows the roster style rule", () => {
    const { f } = filterFixture();
    const plain = run(["team"], f.worktree, f.env);
    expect(plain.stdout).toContain("opus@xhigh (launch)");
    expect(plain.stdout).toContain("fable5.1@low (launch)");
    expect(plain.stdout).not.toContain("\x1b");
    const agents = JSON.parse(run(["team", "--json"], f.worktree, f.env).stdout).agents;
    expect(agents.find((seat: { handle: string }) => seat.handle === "dated")).toMatchObject({ model: "opus[1m]", effort: "xhigh" });
    expect(agents.find((seat: { handle: string }) => seat.handle === "undated")).toMatchObject({ model: "claude-fable-5-1" });
    const env = { ...f.env };
    delete env.NO_COLOR;
    const color = runTty(["team", "--wide"], f.worktree, env, 200);
    expect(color.stdout).toContain("opus@\x1b[38;5;208mxhigh\x1b[0m (launch)");
    expect(color.stdout).toContain("fable5.1@\x1b[38;5;27mlow\x1b[0m (launch)");
    const preset = color.stdout.split("\n").filter(line => line.includes("(launch)")).map(line => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trimEnd().length);
    expect(new Set(preset).size).toBe(1);
    const noColor = runTty(["team", "--wide"], f.worktree, { ...env, NO_COLOR: "" }, 200);
    expect(noColor.stdout).toContain("opus@xhigh (launch)");
    const dumb = spawnSync("python3", ["-B", "-c", TTY_RUNNER, "200", shippedEntry, "team", "--wide"], { cwd: f.worktree, env: { ...env, TERM: "dumb" }, encoding: "utf8" });
    expect(dumb.stdout).toContain("opus@xhigh (launch)");
  }, 60_000);
});

test("--harness and --model skip the pane capture of excluded seats; --state still captures the kept ones", () => {
  const f = fixture();
  const calls = join(f.dir, "tmux-calls.log");
  f.env.TMUX_CALL_LOG = calls;
  f.env.STATE_FRAME = join(f.dir, "frame.txt");
  writeFileSync(f.env.STATE_FRAME, "› \n  gpt-6-astra high · Context 90% left\n");
  replaceTmux(f, String.raw`
printf '%s\n' "$*" >> "$TMUX_CALL_LOG"
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
  list-sessions) printf 'live-session\t1:1\t1\n' ;;
  list-panes) printf 'live-session\tlive-session:0.0\t%%7\tclaude\t123\t1:1\t0\nlive-session\tlive-session:0.1\t%%8\tcodex\t124\t1:1\t0\n' ;;
  capture-pane) cat "$STATE_FRAME" ;;
  display-message) printf '1:1\n' ;;
  *) exit 1 ;;
esac`);
  const pane = (id: string, index: number, harness: string) => ({ status: "active", delivery: "pane", pane: `live-session:0.${index}`, pane_id: id, session: "live-session", server_epoch: "srv:1:1", harness });
  seedPostFlip(f, {
    claude: { ...pane("%7", 0, "claude"), launch_tuning: { model: "opus[1m]", effort: "xhigh" } },
    codex: { ...pane("%8", 1, "codex"), launch_tuning: { model: "gpt-6-astra", effort: "high" } },
  });
  // Pane captures per seat for one invocation, read from the injected tmux's own call log.
  const captures = (...argv: string[]) => {
    writeFileSync(calls, "");
    const r = run(["team", ...argv], f.worktree, f.env);
    expect(r.status, r.stderr).toBe(0);
    const lines = readFileSync(calls, "utf8").split("\n").filter(line => line.includes("capture-pane"));
    return { claude: lines.filter(line => line.includes("%7")).length, codex: lines.filter(line => line.includes("%8")).length, stdout: r.stdout };
  };
  expect(captures("--json")).toMatchObject({ claude: 1, codex: 1 });
  for (const shape of [["--json"], [], ["--state", "idle,working,unknown"]]) {
    const filtered = captures("--harness", "codex", ...shape);
    expect([shape.join(" "), filtered.claude, filtered.codex > 0]).toEqual([shape.join(" "), 0, true]);
    expect(filtered.stdout).not.toContain("claude  ");
  }
  expect(captures("--model", "astra6", "--json")).toMatchObject({ claude: 0, codex: 1 });
  expect(captures("--model", "opus", "--json")).toMatchObject({ claude: 1, codex: 0 });
  // --names needs no state, so a harness or model filter captures nothing at all.
  expect(captures("--names", "--harness", "codex")).toEqual({ claude: 0, codex: 0, stdout: "codex\n" });
  expect(captures("--names", "--model", "opus")).toEqual({ claude: 0, codex: 0, stdout: "claude\n" });
  expect(captures("--names", "--state", "unknown,idle,working", "--harness", "claude")).toMatchObject({ claude: 1, codex: 0 });
}, 60_000);

test("one epoch bracket covers every capture and drift invalidates the whole observation", () => {
  const f = fixture(), calls = join(f.dir, "epoch.calls"), epoch = join(f.dir, "epoch");
  f.env.TMUX_CALL_LOG = calls; f.env.EPOCH_FILE = epoch;
  delete f.env.TAP_SERVER_EPOCH;
  replaceTmux(f, String.raw`
printf '%s\n' "$*" >> "$TMUX_CALL_LOG"
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
 list-sessions) printf 'live-session\t1:1\t1\n' ;;
 list-panes) for n in 7 8 9; do printf 'live-session\tlive-session:0.%s\t%%%s\tclaude\t123\t1:1\t0\t\t\t\n' "$n" "$n"; done ;;
 capture-pane)
   if [ "$FLIP_EPOCH" = yes ]; then printf '2:2\n' > "$EPOCH_FILE"; fi
   printf '❯ \n42%% (84K) ctx\n' ;;
 display-message) cat "$EPOCH_FILE" ;;
 *) exit 1 ;;
esac`);
  seedPostFlip(f, Object.fromEntries([7,8,9].map(n => [`seat${n}`, {status:"active", delivery:"pane", pane:`live-session:0.${n}`, pane_id:`%${n}`, session:"live-session", server_epoch:"srv:1:1", harness:"claude"}])));
  for (const drift of [false, true]) {
    writeFileSync(calls, ""); writeFileSync(epoch, "1:1\n"); f.env.FLIP_EPOCH = drift ? "yes" : "no";
    const r = run(["team", "--json"], f.worktree, f.env);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(calls, "utf8").split("\n").filter(s => s.includes("#{pid}:#{start_time}") && s.includes("display-message"))).toHaveLength(2);
    const agents = JSON.parse(r.stdout).agents;
    expect(agents).toHaveLength(3);
    // Existing default JSON schema, including nullable enrichment fields.
    expect(Object.keys(agents[0]).sort()).toEqual([
      "agent_state", "agent_state_reason", "ask_window_seconds", "attached", "context_source", "context_tokens",
      "context_unknown_reason", "context_used_percent", "crew", "delivery", "digest_window_seconds", "effort",
      "family", "family_source", "handle", "harness", "launch_tuning", "model", "observed_at", "observed_effort",
      "observed_model", "pane", "prompt_cache", "role", "sampled_at", "status", "status_reason", "turn_ended_at",
      "turn_ended_source", "turn_started_at", "unattended", "waiting_on",
    ]);
    if (drift) for (const row of agents) expect(row).toMatchObject({agent_state:"unknown", agent_state_reason:"capture_failed", context_used_percent:null, sampled_at:null});
    else for (const row of agents) expect(row.agent_state_reason).not.toBe("capture_failed");
  }
});

test("--no-state skips captures, compute and token reads on roster and crew routes", () => {
  const f = fixture(), calls = join(f.dir, "light.calls");
  f.env.TMUX_CALL_LOG = calls;
  replaceTmux(f, String.raw`
printf '%s\n' "$*" >> "$TMUX_CALL_LOG"
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
 list-sessions) printf 'live-session\t1:1\t1\n' ;;
 list-panes) printf 'live-session\tlive-session:0.0\t%%7\tclaude\t123\t1:1\t0\t\t\t\n' ;;
 *) exit 1 ;;
esac`);
  writeFileSync(join(f.dir, "bin", "compute"), '#!/bin/sh\necho COMPUTE >> "$TMUX_CALL_LOG"\nexit 1\n', {mode:0o755});
  const transcript = join(f.dir, "transcript.jsonl");
  writeFileSync(transcript, JSON.stringify({type:"assistant", sessionId:"sid", message:{model:"observed-model", usage:{input_tokens:1234}}}) + "\n");
  seedPostFlip(f, {seat:{status:"active",delivery:"pane",pane:"live-session:0.0",pane_id:"%7",session:"live-session",server_epoch:"srv:1:1",harness:"claude",crew:true,transcript_path:transcript,harness_session_id:"sid"}});
  for (const route of [["team"], ["team", "roster", "roster"]]) {
    writeFileSync(calls, "");
    const r = run([...route, "--no-state", "--json"], f.worktree, f.env);
    expect(r.status, r.stderr).toBe(0);
    const row = JSON.parse(r.stdout).agents[0];
    expect(row.agent_state).toBe("unknown"); expect(row.agent_state_reason).toBe("not_observed");
    expect(row.context_tokens).toBeNull();
    expect(readFileSync(calls,"utf8")).not.toMatch(/capture-pane|show-options|COMPUTE/);
  }
  writeFileSync(calls, "");
  const crew = run(["crew", "list", "--no-state"], f.worktree, f.env);
  expect(crew.status, crew.stderr).toBe(0);
  expect(crew.stdout).toContain("seat");
  expect(readFileSync(calls,"utf8")).not.toMatch(/capture-pane|show-options|COMPUTE/);
  for (const flags of [["--state","idle"],["--model","opus"],["--stalled"],["--context"]]) {
    const r = run(["team", "--no-state", "--json", ...flags], f.worktree, f.env);
    expect(r.status).toBe(1); expect(JSON.parse(r.stdout).error_class).toBe("usage_error");
  }
});

test("roster cache hits spawn nothing, preserve observed_at, and invalidate locally", () => {
  const f = fixture(), trace = join(f.dir, "cache.calls"), epoch = join(f.dir, "cache.epoch");
  f.env.TMUX_CALL_LOG = trace; f.env.EPOCH_FILE = epoch;
  f.env.STATE_FRAME = join(root, "runtime/bun/test/fixtures/agent-state/claude/idle-real.txt");
  f.env.TAP_ROSTER_CACHE_TTL = "60"; delete f.env.TAP_WATCH_NOW; delete f.env.TAP_SERVER_EPOCH;
  writeFileSync(epoch,"1:1\n");
  replaceTmux(f, String.raw`
printf 'tmux %s\n' "$*" >> "$TMUX_CALL_LOG"
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
 list-sessions) printf 'live-session\t'; cat "$EPOCH_FILE" | tr '\n' '\t'; printf '1\n' ;;
 list-panes) printf 'live-session\tlive-session:0.0\t%%7\tclaude\t123\t'; cat "$EPOCH_FILE" | tr '\n' '\t'; printf '0\t\t\t\n' ;;
 capture-pane) cat "$STATE_FRAME" ;;
 display-message) cat "$EPOCH_FILE" ;;
 *) exit 1 ;;
esac`);
  for (const command of ["ps", "compute", "git"]) writeFileSync(join(f.dir,"bin",command), `#!/bin/sh\nprintf '${command} %s\\n' "$*" >> "$TMUX_CALL_LOG"\n${command === "compute" ? "printf '{\"jobs\":[]}\\n'" : "exit 1"}\n`,{mode:0o755});
  const registry = seedPostFlip(f, {seat:{status:"active",delivery:"pane",pane:"live-session:0.0",pane_id:"%7",session:"live-session",server_epoch:"srv:1:1",harness:"claude",crew:true,preset:{name:"known"}}});
  const json = (...flags: string[]) => {
    writeFileSync(trace, "");
    const r = run(["team","--json",...flags],f.worktree,f.env);
    expect(r.status,r.stderr).toBe(0);
    return {doc:JSON.parse(r.stdout),calls:readFileSync(trace,"utf8")};
  };
  const first = json(); expect(first.calls).toContain("capture-pane"); expect(first.doc.observed_at).toMatch(/^\d{4}-/);
  const hit = json(); expect(hit.calls).toBe(""); expect(hit.doc).toEqual(first.doc);
  writeFileSync(epoch,"2:2\n");
  const stale = json(); expect(stale.calls).toBe(""); expect(stale.doc.observed_at).toBe(first.doc.observed_at);
  expect(json("--no-cache").calls).toContain("list-panes");
  writeFileSync(epoch,"1:1\n");
  const changed = JSON.parse(readFileSync(registry,"utf8")); changed.seats.seat.role = "leader";
  writeFileSync(registry, JSON.stringify(changed));
  const updated = json(); expect(updated.calls).toContain("capture-pane"); expect(updated.doc.agents[0].role).toBe("leader");
  const cacheDir = join(f.worktree,".tap","bus","runtime-cache");
  expect(existsSync(join(f.worktree,".tap","runtime-cache"))).toBe(false);
  writeFileSync(join(cacheDir,"roster-full.json"),"{broken");
  expect(json().calls).toContain("capture-pane");
  const light = json("--no-state"); expect(light.calls).not.toContain("capture-pane");
  expect(light.doc.agents[0]).toMatchObject({agent_state_reason:"not_observed",context_unknown_reason:"not_sampled"});
  const lightHit = json("--no-state"); expect(lightHit.calls).toBe(""); expect(lightHit.doc.observed_at).toBe(light.doc.observed_at);
  expect(readdirSync(cacheDir).sort()).toEqual(["roster-full.json","roster-nostate.json"]);
  const human = run(["team"],f.worktree,f.env); expect(human.stdout).toContain("cached observation");
  f.env.TAP_ROSTER_CACHE_TTL = "0"; expect(json().calls).toContain("capture-pane");
  f.env.TAP_ROSTER_CACHE_TTL = "60";
  for (const now of ["100", "200"]) { f.env.TAP_WATCH_NOW = now; expect(json().calls).toContain("capture-pane"); }
  delete f.env.TAP_WATCH_NOW; delete f.env.TAP_ROSTER_CACHE_TTL;
  const configDir = join(f.home,".config","tap"); mkdirSync(configDir,{recursive:true});
  const config = join(configDir,"config.toml");
  writeFileSync(config,"version=2\n[advanced]\nroster_cache_ttl_seconds=0\n");
  expect(json().calls).toContain("capture-pane");
  f.env.TAP_ROSTER_CACHE_TTL = "60";
  json(); expect(json().calls).toBe("");
  writeFileSync(config,"version=2\n[presets.known]\nharness='claude'\nmetadata.model_family='new-family'\n");
  const newPreset = json(); expect(newPreset.calls).toContain("capture-pane");
  expect(newPreset.doc.agents[0].family).toBe("new-family");
  expect(newPreset.doc.agents[0].metadata.model_family).toBe("new-family");
  const saved = Object.fromEntries(readdirSync(cacheDir).map(name => [name, readFileSync(join(cacheDir,name),"utf8")]));
  for (const verb of ["health", "doctor"]) run([verb,"--json"],f.worktree,f.env);
  expect(Object.fromEntries(readdirSync(cacheDir).map(name => [name, readFileSync(join(cacheDir,name),"utf8")]))).toEqual(saved);
  const body = join(f.dir,"body.md"); writeFileSync(body,"fixture");
  for (const args of [["register","probe","--json"],["in","probe","--json"],["send","missing","-f",body]]) {
    writeFileSync(trace,""); run(args,f.worktree,f.env);
    expect(readFileSync(trace,"utf8"),args.join(" ")).toContain("git ");
  }
  const crewFirst = run(["crew","list"],f.worktree,f.env); expect(crewFirst.status,crewFirst.stderr).toBe(0);
  writeFileSync(trace,"");
  expect(run(["crew","list"],f.worktree,f.env).stdout).toContain("cached observation");
  expect(readFileSync(trace,"utf8")).toBe("");
  expect(run(["crew","list","--all"],f.worktree,f.env).status).toBe(1);
  writeFileSync(config,"version=2\n[advanced]\nunknown_knob=1\n");
  const invalid = run(["team","--json"],f.worktree,f.env);
  expect(invalid.status).toBe(1); expect(JSON.parse(invalid.stdout).error_class).toBe("advanced_config_invalid");
  expect(invalid.stdout).toContain("unknown_knob");
}, 60_000);
