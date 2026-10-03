// `tap team refresh` progress line: stderr only, a real terminal only, and the
// per-seat receipt on stdout is byte-identical whether or not it animates.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeScratchTree } from "./support/scratch";

const root = resolve(import.meta.dir, "../../..");
const entry = join(root, "bin/tap");
// stdout goes to a file and stderr stays on the pty, so the two streams are
// judged separately: stderr as a terminal sees it, stdout as a pipe sees it.
const PTY_STDERR = String.raw`import os, pty, sys
pid, fd = pty.fork()
if pid == 0:
    os.dup2(os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 1)
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
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(b"".join(chunks))
raise SystemExit(os.waitstatus_to_exitcode(status))
`;
const HOLD = "import fcntl,sys,time\nf=open(sys.argv[1]+'.lock','a+')\nfcntl.flock(f,fcntl.LOCK_EX)\nprint('held',flush=True)\ntime.sleep(float(sys.argv[2]))\n";
const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) removeScratchTree(path); });

/** One gone seat (its session is absent from the stub tmux), so a real run must trim under the registry lock. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tap-refresh-progress."));
  scratch.push(dir);
  const [home, index, worktree, bin, tmuxTmp] = ["home", "index", "worktree", "bin", "tmux-tmp"].map(name => join(dir, name));
  for (const path of [home!, index!, worktree!, bin!, tmuxTmp!]) mkdirSync(path, { recursive: true });
  spawnSync("git", ["init", "-q", worktree!]);
  writeFileSync(join(worktree!, "AGENTS.md"), "<!-- tap:begin -->\nTAP\n<!-- tap:end -->");
  writeFileSync(join(bin!, "tmux"), `#!/bin/sh
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
  list-sessions) printf 'live-session\\t1:1\\t1\\n' ;;
  list-panes) printf 'live-session\\tlive-session:0.0\\t%%7\\tcodex\\t123\\t1:1\\t0\\n' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  const registry = join(worktree!, ".tap", "team-registry.json");
  mkdirSync(join(worktree!, ".tap"), { recursive: true });
  writeFileSync(join(index!, "global-registry.json"), JSON.stringify({
    schema: "0.20", teams: { roster: { root: worktree, registry_location: registry, state: "registered" } },
  }));
  writeFileSync(registry, JSON.stringify({
    schema: "0.20", team: { name: "roster", worktree_root: worktree },
    seats: { gone: { status: "active", delivery: "pane", harness: "codex", pane: "gone:0.0", pane_id: "%9", session: "gone", registered_at: "2026-10-01T00:00:00Z" } },
  }, null, 2) + "\n", { mode: 0o640 });
  chmodSync(registry, 0o640);
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, XDG_CONFIG_HOME: join(home!, ".config"),
    TAP_INDEX_HOME: index, TAP_SESSION_MANIFEST: join(index!, "sessions.json"),
    OPENCODE_DB_PATH: join(index!, "opencode.db"), TAP_VERSION_SEEN_PATH: join(index!, "version-seen.json"),
    TAP_TMUX_SOCKET: `rp-${process.pid}-${scratch.length}`, TMUX_TMPDIR: tmuxTmp, TAP_SERVER_EPOCH: "srv:1:1",
    TAP_BOOT_ID: "bootuuid:00000000-0000-0000-0000-000000000001", TAP_BOOT_ID_LEGACY: "boot:1", TAP_WATCH_NOW: "1787790000",
  };
  for (const key of ["TAP_HOME", "TMUX", "TMUX_PANE", "TAP_SELF", "NO_COLOR", "TERM", "TAP_JSON"]) delete env[key];
  return { dir, env, worktree: worktree!, registry };
}

/** Hold the registry lock in another process; resolves once it really holds it, never on a guessed delay. */
async function holdLock(registry: string, seconds: number) {
  const holder = Bun.spawn(["python3", "-c", HOLD, registry, String(seconds)], { stdout: "pipe" });
  const { value } = await holder.stdout.getReader().read();
  expect(new TextDecoder().decode(value)).toContain("held");
  return holder;
}

/** Run refresh with stderr on a pty (a terminal) and stdout in a file. Optionally hold the registry lock for `holdSeconds`. */
async function onTerminal(args: string[], extraEnv: NodeJS.ProcessEnv = {}, holdSeconds = 0) {
  const f = fixture();
  const stdoutFile = join(f.dir, "stdout");
  const env = { ...f.env, TERM: "xterm-256color", ...extraEnv };
  const holder = holdSeconds ? await holdLock(f.registry, holdSeconds) : null;
  const result = spawnSync("python3", ["-B", "-c", PTY_STDERR, stdoutFile, entry, "team", "refresh", ...args], {
    cwd: f.worktree, env, encoding: "utf8", timeout: 60_000,
  });
  holder?.kill();
  // The pty's bytes arrive on the runner's stdout: they ARE the terminal's stderr.
  return { status: result.status, stderr: result.stdout, stdout: readFileSync(stdoutFile, "utf8"), fixture: f };
}
const lines = (text: string) => text.replace(/\r\x1b\[2K/g, "\n").split(/\r?\n/).filter(Boolean);

test("terminal: a contended registry lock animates a named wait, settles ✓, and leaves the stdout receipt alone", async () => {
  const plain = fixture();
  const piped = spawnSync(entry, ["team", "refresh"], { cwd: plain.worktree, env: plain.env, encoding: "utf8" });
  expect(piped.status, piped.stderr).toBe(0);
  expect(piped.stderr).not.toContain("\x1b");

  const run = await onTerminal([], {}, 1.2);
  expect(run.status, run.stderr).toBe(0);
  const seen = lines(run.stderr);
  expect(seen.filter(line => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Waiting for another tap command to release the registry lock$/.test(line)).length).toBeGreaterThan(1);
  expect(seen).toContain("✓ Waiting for another tap command to release the registry lock");
  // The receipt is the same bytes a pipe sees.
  expect(run.stdout).toBe(piped.stdout);
  expect(run.stdout).toContain("removed 'gone'");
  // The registry really was trimmed once the wait ended.
  expect(readFileSync(run.fixture.registry, "utf8")).not.toContain('"gone"');
}, 90_000);

test("redirected stderr: a contended lock still draws no frames and no terminal controls", async () => {
  const f = fixture();
  const holder = await holdLock(f.registry, 1.2);
  const started = Date.now();
  const run = spawnSync(entry, ["team", "refresh"], { cwd: f.worktree, env: { ...f.env, TERM: "xterm-256color" }, encoding: "utf8", timeout: 60_000 });
  holder.kill();
  // The wait was long enough for many frames had any been drawn.
  expect(Date.now() - started).toBeGreaterThan(800);
  expect(run.status, run.stderr).toBe(0);
  expect(run.stderr).not.toMatch(/\x1b|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|Waiting for|Writing changes/);
  expect(run.stdout).toContain("removed 'gone'");
}, 90_000);

test.each([
  ["NO_COLOR", [], { NO_COLOR: "1" }],
  ["an empty NO_COLOR", [], { NO_COLOR: "" }],
  ["TERM=dumb", [], { TERM: "dumb" }],
  ["--json", ["--json"], {}],
  ["TAP_JSON=1", [], { TAP_JSON: "1" }],
  ["--dry-run", ["--dry-run"], {}],
] as [string, string[], NodeJS.ProcessEnv][])("terminal: %s draws no frames and no terminal controls", async (_name, args, env) => {
  const run = await onTerminal(args, env, 0.6);
  expect(run.stderr, run.stderr).not.toMatch(/\x1b|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|Waiting for|Writing changes/);
}, 90_000);
