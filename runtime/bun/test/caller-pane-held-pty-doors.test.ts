import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeScratchTree } from "./support/scratch";

// The public doors under a REAL held terminal. A sandbox pane on a private tmux
// server runs script(1) as the holder: it allocates a pty for its child and
// keeps the pane tty itself, the geometry of Antigravity's run_command. Invoked
// through a scratch symlink named `agy`, the holder classifies as the agy family
// exactly as a registered Antigravity seat does (script does not re-exec, so the
// process table carries the invoked name; a python3 symlink would not, because
// the interpreter re-execs its framework binary); invoked as plain `script` it
// is not a harness. The
// child runs bin/tap whoami, read and withdraw WITHOUT --by against a
// registry row bound to that pane, and the negative pane pins the refusal
// hints: the next step names --by and the observed reason, never --force alone.

const REPO = realpathSync(join(import.meta.dir, "..", "..", ".."));
const BIN_TAP = join(REPO, "bin", "tap");
const RUNNER_ROOT = process.env.TMUX_TMPDIR;
if (!RUNNER_ROOT) {
  throw new Error("caller-pane-held-pty-doors.test.ts: TMUX_TMPDIR is unset — this fixture spawns tmux and a team only beneath the supported runner's scratch root (runtime/bun/test/run.sh exports it)");
}
const SCRIPT = Bun.which("script") ?? "/usr/bin/script";

const WORK = mkdtempSync(join(RUNNER_ROOT, "tap-held-doors."));
const ROOT = join(WORK, "team");
const BUS = join(ROOT, ".tap", "bus");
const REGISTRY = join(ROOT, ".tap", "team-registry.json");
const INDEX = join(WORK, "index");
const BIN = join(WORK, "bin");
const OUT = join(WORK, "out");
const socket = `held-doors-${process.pid}`;
const realTmux = Bun.which("tmux")!;

const RUNNER_PINS = ["TMUX_TMPDIR", "TAP_LOCK_DIR", "TAP_NOTIFY_USER_BIN", "EPISODIC_MEMORY_SUMMARIZER_GUARD",
  "TAP_SESSION_MANIFEST", "OPENCODE_DB_PATH", "TAP_VERSION_SEEN_PATH"] as const;
function paneEnv(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: `${BIN}:/usr/bin:/bin:/opt/homebrew/bin`,
    HOME: join(WORK, "home"),
    TAP_INDEX_HOME: INDEX,
    TAP_TMUX_SOCKET: socket,
    TERM: "dumb",
    // LANG=C alone is not the runner's locale: a tmux client outside $TMUX in a
    // non-UTF-8 locale sanitizes the tab separator of -F output to `_`, and
    // the runtime pins its socket (scrubbing TMUX) whenever TAP_TMUX_SOCKET is
    // set. The runner exports both; the pane inherits both.
    LANG: "C",
    LC_CTYPE: "en_US.UTF-8",
  };
  for (const key of RUNNER_PINS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}
const T = (...args: string[]) => {
  const result = spawnSync(realTmux, ["-L", socket, ...args], { env: paneEnv(), encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
};

const NOTE_READ = "other-20261014T100000Z-000000000001";
const ASK_IN = "other-20261014T100000Z-000000000002";
const ASK_SENT = "writer-20261014T100000Z-000000000003";
const NOTE_NEG = "other-20261014T100000Z-000000000004";
const ASK_NEG = "writer-20261014T100000Z-000000000005";

function seedPayload(id: string, from: string, to: string, reply: string, extra = ""): void {
  const path = join(BUS, "payloads", `${id}.md`);
  writeFileSync(path, `---\nid: ${id}\nfrom: ${from}\nto: ${to}\nkind: discuss\npath: ${path}\nreply: ${reply}\n${extra}---\nbody\n`);
  writeFileSync(join(BUS, "receipts", `${id}.placed`), "{}\n");
  writeFileSync(join(BUS, "receipts", `${id}.sent`), "{}\n");
}

function waitFor(path: string, ms = 90_000): boolean {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (existsSync(path)) return true;
    Bun.sleepSync(100);
  }
  return existsSync(path);
}
const out = (name: string) => readFileSync(join(OUT, name), "utf8");

/** One pane whose command is HOLDER (script(1) under some name) running bash SCRIPT on a fresh pty; returns the pane facts. */
function startHeldPane(session: string, holder: string, script: string): { paneId: string; epoch: string } {
  // BSD script takes the command as operands after the typescript file; util-linux takes -c.
  const command = process.platform === "darwin"
    ? `${holder} -q /dev/null bash ${script}`
    : `${holder} -q -c 'bash ${script}' /dev/null`;
  const paneId = T("new-session", "-d", "-s", session, "-c", ROOT, "-P", "-F", "#{pane_id}", command);
  const epoch = `srv:${T("display-message", "-p", "-t", paneId, "#{pid}:#{start_time}")}`;
  return { paneId, epoch };
}

beforeAll(() => {
  for (const dir of [join(BUS, "payloads"), join(BUS, "receipts"), INDEX, BIN, OUT, join(WORK, "home")]) mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", ROOT]);
  symlinkSync(SCRIPT, join(BIN, "agy"));
  writeFileSync(join(INDEX, "global-registry.json"),
    `${JSON.stringify({ schema: "0.20", teams: { fixture: { root: ROOT, registry_location: REGISTRY, state: "registered" } } })}\n`);
  // The doors run only once the registry row exists (the go marker).
  writeFileSync(join(WORK, "doors.sh"), `#!/bin/bash
while [ ! -e "${WORK}/go.marker" ]; do sleep 0.1; done
{ echo "tty=$(tty)"; ps -o pid,ppid,tty,comm -p $$,$PPID; tmux -L "$TAP_TMUX_SOCKET" list-panes -a -F '#{pane_id} #{pane_tty} #{pane_pid} #{pane_current_command}'; } > "${OUT}/diag.txt" 2>&1
"${BIN_TAP}" whoami > "${OUT}/whoami.txt" 2>&1; echo $? > "${OUT}/whoami.rc"
"${BIN_TAP}" read ${NOTE_READ} > "${OUT}/read.txt" 2>&1; echo $? > "${OUT}/read.rc"
"${BIN_TAP}" withdraw ${ASK_SENT} -m retracted > "${OUT}/withdraw.txt" 2>&1; echo $? > "${OUT}/withdraw.rc"
touch "${OUT}/doors.marker"
`, { mode: 0o755 });
  writeFileSync(join(WORK, "neg.sh"), `#!/bin/bash
while [ ! -e "${WORK}/go.marker" ]; do sleep 0.1; done
"${BIN_TAP}" whoami > "${OUT}/neg-whoami.txt" 2>&1; echo $? > "${OUT}/neg-whoami.rc"
"${BIN_TAP}" read ${NOTE_NEG} > "${OUT}/neg-read.txt" 2>&1; echo $? > "${OUT}/neg-read.rc"
"${BIN_TAP}" read --force ${NOTE_NEG} > "${OUT}/neg-read-force.txt" 2>&1; echo $? > "${OUT}/neg-read-force.rc"
"${BIN_TAP}" reply ${ASK_IN} -m answer > "${OUT}/neg-reply.txt" 2>&1; echo $? > "${OUT}/neg-reply.rc"
"${BIN_TAP}" withdraw ${ASK_NEG} -m retracted > "${OUT}/neg-withdraw.txt" 2>&1; echo $? > "${OUT}/neg-withdraw.rc"
touch "${OUT}/neg.marker"
`, { mode: 0o755 });

  const writer = startHeldPane("fixture/writer", join(BIN, "agy"), join(WORK, "doors.sh"));
  const neg = startHeldPane("fixture/neg", SCRIPT, join(WORK, "neg.sh"));
  writeFileSync(REGISTRY, `${JSON.stringify({
    schema: "0.20", team: { name: "fixture", worktree_root: ROOT },
    seats: {
      writer: { status: "active", delivery: "pane", harness: "agy", instance: "writer|fixture",
        pane: "fixture/writer:0.0", pane_id: writer.paneId, session: "fixture/writer", server_epoch: writer.epoch },
      neg: { status: "active", delivery: "pane", harness: "claude", instance: "neg|fixture",
        pane: "fixture/neg:0.0", pane_id: neg.paneId, session: "fixture/neg", server_epoch: neg.epoch },
      other: { status: "active", delivery: "pane", harness: "claude", instance: "other|fixture",
        pane: "fixture/other:0.0", pane_id: "%9999", session: "fixture/other", server_epoch: "srv:1:1" },
    },
  })}\n`);
  seedPayload(NOTE_READ, "other", "writer", "settle-only", "recipient_instance: writer|fixture\n");
  seedPayload(ASK_IN, "other", "neg", "expected", "recipient_instance: neg|fixture\n");
  seedPayload(ASK_SENT, "writer", "other", "expected", "sender_instance: writer|fixture\nrecipient_instance: other|fixture\n");
  seedPayload(NOTE_NEG, "other", "neg", "settle-only", "recipient_instance: neg|fixture\n");
  seedPayload(ASK_NEG, "neg", "other", "expected", "sender_instance: neg|fixture\nrecipient_instance: other|fixture\n");
  writeFileSync(join(WORK, "go.marker"), "");
  expect(waitFor(join(OUT, "doors.marker"))).toBe(true);
  expect(waitFor(join(OUT, "neg.marker"))).toBe(true);
});

afterAll(() => {
  spawnSync(realTmux, ["-L", socket, "kill-server"], { env: paneEnv(), encoding: "utf8" });
  removeScratchTree(WORK);
});

describe("a seat whose harness holds the tool terminal uses its own identity", () => {
  test("whoami names the registered handle", () => {
    expect(out("whoami.rc").trim(), `${out("whoami.txt")}\n--- pane diagnostics ---\n${out("diag.txt")}`).toBe("0");
    expect(out("whoami.txt").trim()).toBe("writer");
  });

  test("read settles a note addressed to the seat without --by", () => {
    expect(out("read.rc").trim(), out("read.txt")).toBe("0");
    const receipt = JSON.parse(readFileSync(join(BUS, "receipts", `${NOTE_READ}.done`), "utf8"));
    expect(receipt.by).toBe("writer");
  });

  test("withdraw retracts the seat's own ask without --by", () => {
    expect(out("withdraw.rc").trim(), out("withdraw.txt")).toBe("0");
    expect(JSON.parse(readFileSync(join(BUS, "receipts", `${ASK_SENT}.cancelled`), "utf8")).via).toBe("withdrawn");
  });
});

describe("a holder that is not a harness keeps the caller outside, and the hints name --by", () => {
  test("whoami refuses with the climb's reason", () => {
    expect(out("neg-whoami.rc").trim(), out("neg-whoami.txt")).not.toBe("0");
    expect(out("neg-whoami.txt")).toContain("not a harness process");
  });

  test("read's next step is --by, with the observed reason; --force alone refuses the same way", () => {
    for (const name of ["neg-read", "neg-read-force"]) {
      expect(out(`${name}.rc`).trim(), out(`${name}.txt`)).toBe("1");
      const text = out(`${name}.txt`);
      expect(text).toContain(`tap read ${NOTE_NEG} --by <handle>`);
      expect(text).toContain("not a harness process");
      expect(text).not.toContain("which records you");
      expect(text).not.toContain("tmux pane inventory is unavailable");
    }
    expect(existsSync(join(BUS, "receipts", `${NOTE_NEG}.done`))).toBe(false);
  });

  test("reply prefills --by from the addressee; withdraw names its own --by spelling", () => {
    // reply owns the shared settlement actor path (tap done is retired): its
    // no_actor message prefills the exact --by from the inbound's addressee.
    expect(out("neg-reply.rc").trim(), out("neg-reply.txt")).toBe("1");
    expect(out("neg-reply.txt")).toContain("--by neg");
    expect(out("neg-withdraw.rc").trim(), out("neg-withdraw.txt")).toBe("1");
    expect(out("neg-withdraw.txt")).toContain(`tap withdraw ${ASK_NEG} --by <handle>`);
    expect(existsSync(join(BUS, "receipts", `${ASK_NEG}.cancelled`))).toBe(false);
  });
});
