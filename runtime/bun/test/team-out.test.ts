import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { bootId } from "../src/tmux";
import { crewLifetimeBinding, processGeneration, stopCrewLifetimeHelper } from "../src/crew-lifetime";
import { captureParentHarnessLifetime } from "../src/crew-lifetime";
import { retireFamilyRows, restoreFamilyRows } from "../src/out-retire";
import { fileMatches, fzfTool } from "../src/fzf-tool";
import { fixtureFzf } from "./support/fzf-fixture";
import type { ResolvedContext } from "../src/context";
import { removeScratchTree } from "./support/scratch";

const MAIN = join(import.meta.dir, "../main.ts");
const owned: string[] = [];
afterEach(() => { for (const path of owned.splice(0)) removeScratchTree(path); });

function fixture(seats: Record<string, unknown>) {
  const base = realpathSync(mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "tap-team-out.")));
  owned.push(base);
  const root = join(base, "team"), bus = join(root, ".tap", "bus"), index = join(base, "index");
  const registry = join(root, ".tap", "team-registry.json");
  mkdirSync(bus, { recursive: true });
  mkdirSync(index);
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    t: { root, registry_location: registry, state: "registered" },
  } }));
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "t", worktree_root: root }, seats,
    extension: { untouched: true } }, null, 2));
  const env: NodeJS.ProcessEnv = { ...process.env, TAP_HOME: bus, TAP_INDEX_HOME: index, TAP_LOCK_DIR: join(base, "locks"),
    TAP_SPOOL_DISABLE_DELIVERER: "1", TAP_SCRATCH_ONLY: base, TAP_TMUX_SOCKET: `team-out-${process.pid}` };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.TAP_SELF;
  const run = (...argv: string[]) => {
    const result = Bun.spawnSync([process.execPath, MAIN, "team", "out", "t", ...argv],
      { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  };
  const runCommand = (...argv: string[]) => {
    const result = Bun.spawnSync([process.execPath, MAIN, "team", "out", ...argv],
      { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  };
  const runOperator = (...argv: string[]) => {
    const result = Bun.spawnSync(["python3", join(import.meta.dir, "support/pty-caller.py"), "15",
      process.execPath, join(import.meta.dir, "support/team-out-operator.ts"), MAIN, ...argv],
    { cwd: root, env, stdout: "pipe", stderr: "pipe", timeout: 20000 });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const report = JSON.parse(result.stdout.toString());
    expect(report.timedOut).toBe(false);
    return { code: report.code as number, out: (report.output as string).replace(/\r\n/g, "\n"), err: "" };
  };
  const doc = () => JSON.parse(readFileSync(registry, "utf8")) as Record<string, unknown>;
  const history = () => {
    const path = join(root, ".tap", "team-history");
    return existsSync(path) ? readdirSync(path) : [];
  };
  return { run, runCommand, runOperator, doc, history, registry, bus, index, base, root, env };
}

const poll = (instance: string) => ({ instance, delivery: "poll", status: "active" });

test("plain team out retires an explicit poll cohort with history and leaves team initialization", () => {
  const f = fixture({ a: poll("a|one"), b: poll("b|one") });
  const result = f.run("--only", "a", "--json");
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out.trim()).families).toHaveLength(1);
  expect(result.out.trim().split("\n")).toHaveLength(1);
  expect((f.doc().seats as Record<string, unknown>)).toEqual({ b: poll("b|one") });
  expect(f.doc().extension).toEqual({ untouched: true });
  expect(existsSync(f.registry)).toBe(true);
  expect(existsSync(join(f.index, "global-registry.json"))).toBe(true);
  expect(f.history()).toHaveLength(1);
  expect(result.out).toContain('"retired":["a"]');
});

test("plain and hard team retirement events keep distinct lifecycle dispositions", () => {
  const f = fixture({ a: poll("a|one"), b: poll("b|one") });
  expect(f.run("--only", "a", "--json").code).toBe(0);
  expect(f.run("--only", "b", "--hard", "--json").code).toBe(0);
  const events = readFileSync(join(f.bus, "registry-events.log"), "utf8");
  expect(events).toContain("action=team-out handle=a");
  expect(events).toContain("lifecycle_action=out;mechanism=team-out;outcome=retired");
  expect(events).toContain("action=team-out-hard handle=b");
  expect(events).toContain("lifecycle_action=out-hard;mechanism=team-out-hard;outcome=already_stopped");
});

test("empty team out is idempotent; a named missing parent refuses", () => {
  const f = fixture({});
  expect(f.run("--yes").code).toBe(0);
  expect(f.run("--yes").code).toBe(0);
  expect(f.run("--only", "missing", "--json").code).toBe(1);
  expect(f.doc().seats).toEqual({});
  expect(f.history()).toHaveLength(0);
});

test("typed unknown team retains its selector refusal outside a terminal", () => {
  const f = fixture({ a: poll("a|one") });
  delete f.env.TAP_HOME;
  const result = f.runCommand("missing", "--dry-run", "--json");
  expect(result.code).toBe(1);
  const body = JSON.parse(result.out.trim());
  expect(body.error_class).toBe("unknown_team");
  expect(body.action).toBe("tap register");
  expect(f.doc().seats).toEqual({ a: poll("a|one") });
});

test("omitted team from an unanchored nonterminal caller requires a target", () => {
  const f = fixture({ a: poll("a|one") });
  const env = { ...f.env };
  delete env.TAP_HOME;
  const result = Bun.spawnSync([process.execPath, MAIN, "team", "out", "--dry-run", "--json"],
    { cwd: f.base, env, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(1);
  const body = JSON.parse(result.stdout.toString().trim());
  expect(body.error_class).toBe("target_required");
  expect(body.action).toContain("<team>");
  expect(f.doc().seats).toEqual({ a: poll("a|one") });
});

const pickerDriver = String.raw`
import fcntl, json, os, pty, select, signal, struct, sys, termios, time
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 100, 0, 0))
pid = os.fork()
if pid == 0:
    os.close(master); os.setsid()
    tty = os.open(os.ttyname(slave), os.O_RDWR)
    for fd in (0, 1, 2): os.dup2(tty, fd)
    os.close(tty); os.close(slave)
    os.execvp(sys.argv[1], sys.argv[1:-1])
os.close(slave)
data = bytearray(); deadline = time.monotonic() + 6; cursor_requests = 0; reaped = False
try:
    while time.monotonic() < deadline:
        if select.select([master], [], [], .05)[0]:
            try:
                chunk = os.read(master, 65536)
                if not chunk: break
                data.extend(chunk)
            except OSError: break
        next_requests = data.count(b'\x1b[6n')
        if next_requests > cursor_requests:
            os.write(master, b'\x1b[1;1R'); cursor_requests = next_requests
        if sys.argv[-1].startswith('confirm'): ready = b'Proceed? [Y/n]' in data
        elif sys.argv[-1] == 'cohort': ready = b'act on>' in data and b'parent' in data
        else: ready = b'missing' in data and b'team>' in data
        if ready: break
    else: raise AssertionError('picker did not appear: ' + repr(data[-1000:]))
    if sys.argv[-1].startswith('confirm'):
        path = os.environ['TAP_TEST_LATE_REGISTRY']
        with open(path) as handle: document = json.load(handle)
        document['seats']['child'] = json.loads(os.environ['TAP_TEST_LATE_ROW'])
        with open(path, 'w') as handle: json.dump(document, handle)
        os.write(master, b'\r')
    elif sys.argv[-1] == 'escape': os.write(master, b'\x1b')
    else:
        if sys.argv[-1] != 'cohort': os.write(master, b'\x15')
        while time.monotonic() < deadline and b'1/1' not in data:
            if select.select([master], [], [], .05)[0]:
                try:
                    chunk = os.read(master, 65536)
                    if not chunk: break
                    data.extend(chunk)
                except OSError: break
        if b'1/1' not in data: raise AssertionError('picker did not offer one candidate: ' + repr(data[-1000:]))
        os.write(master, b'\r')
    while time.monotonic() < deadline:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done == pid:
            reaped = True
            break
        if select.select([master], [], [], .05)[0]:
            try:
                chunk = os.read(master, 65536)
                if not chunk:
                    done, status = os.waitpid(pid, 0); reaped = True
                    break
                data.extend(chunk)
            except OSError:
                done, status = os.waitpid(pid, 0); reaped = True
                break
        next_requests = data.count(b'\x1b[6n')
        if next_requests > cursor_requests:
            os.write(master, b'\x1b[1;1R'); cursor_requests = next_requests
    else: raise AssertionError('picker did not exit: ' + repr(data[-1000:]))
    if done != pid: raise AssertionError('picker status was not reaped')
    while select.select([master], [], [], .05)[0]:
        try:
            chunk = os.read(master, 65536)
            if not chunk: break
            data.extend(chunk)
        except OSError: break
    print(json.dumps({'code': os.WEXITSTATUS(status) if os.WIFEXITED(status) else None, 'raw_status': status, 'pid': pid,
                      'output': data.decode('utf-8', 'replace')}))
finally:
    if not reaped:
        try: os.killpg(pid, signal.SIGKILL)
        except OSError: pass
        try: os.waitpid(pid, 0)
        except OSError: pass
    os.close(master)
`;
async function pinTestFzf(f: ReturnType<typeof fixture>, source = process.env.TAP_TEST_FZF_SOURCE): Promise<void> {
  if (!source) { await fixtureFzf(f.env); return; }
  const pinned = fzfTool(f.env);
  if (!fileMatches(source, pinned.binarySha256)) throw new Error(`test fzf source is not the pinned release: ${source}`);
  mkdirSync(pinned.directory, { recursive: true });
  copyFileSync(source, pinned.binary);
}

test("an invalid explicit pinned-fzf source fails the test dependency", async () => {
  const f = fixture({});
  await expect(pinTestFzf(f, join(f.base, "missing-fzf"))).rejects.toThrow("not the pinned release");
});

test("typed unknown team seeds the pinned picker; selection previews and Escape cancels", async () => {
  const f = fixture({ a: poll("a|one") });
  delete f.env.TAP_HOME;
  await pinTestFzf(f);
  for (const mode of ["select", "escape"]) {
    const result = Bun.spawnSync(["python3", "-c", pickerDriver, process.execPath, MAIN, "team", "out", "missing", "--dry-run", mode],
      { cwd: f.root, env: { ...f.env, TERM: "xterm-256color" }, timeout: 20000 });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const record = JSON.parse(result.stdout.toString()) as { code: number; output: string };
    expect(record.code).toBe(0);
    if (mode === "select") expect(record.output).toContain("tap team out t: retire 1 parent family");
    else expect(record.output).not.toContain("tap team out t: retire");
  }
  expect(f.doc().seats).toEqual({ a: poll("a|one") });
}, 45000);

test("invalid acting registry refuses without opening discovery", () => {
  const f = fixture({ a: poll("a|one") });
  delete f.env.TAP_HOME;
  writeFileSync(f.registry, "{broken");
  for (const args of [["--dry-run"], ["--dry-run", "--json"]]) {
    const result = f.runCommand(...args);
    expect(result.code).toBe(1);
    if (args.includes("--json")) expect(JSON.parse(result.out.trim()).error_class).toBe("registry_invalid");
    else expect(result.err).toContain("acting registry unreadable");
    expect(result.out + result.err).not.toContain("target_required");
  }
});

test("human dry-run names selected families, process fate, and retained orphans", () => {
  const f = fixture({ a: poll("a|one"), orphan: { crew: true, instance: "orphan|one", session: "t/gone", pane_id: "%7" } });
  const result = f.run("--dry-run");
  expect(result.code).toBe(1);
  expect(result.out).toContain("tap team out t: retire 1 parent family");
  expect(result.out).toContain("a: no crew");
  expect(result.out).toContain("leave selected parents and crew running");
  expect(result.out).toContain("Retained orphan crew without a proven binding: orphan");
  expect(result.out).not.toContain('"families":');
});

test("dry-run refuses the same unbound parent without publishing history", () => {
  const f = fixture({ a: { delivery: "poll", status: "active" } });
  const preview = f.run("--only", "a", "--dry-run", "--json");
  expect(preview.code).toBe(1);
  const body = JSON.parse(preview.out.trim());
  expect(body.ok).toBe(false);
  expect(body.families[0].error_class).toBe("target_unbound");
  expect(f.history()).toHaveLength(0);
  expect(f.doc().seats).toEqual({ a: { delivery: "poll", status: "active" } });
  expect(f.run("--only", "a", "--json").code).toBe(1);
});

test("hard dry-run refuses a noncanonical session before effects", () => {
  const row = { instance: "a|one", delivery: "pane", status: "active", harness: "codex",
    session: "wrong/session", pane_id: "%7", server_epoch: "srv:1:1" };
  const f = fixture({ a: row });
  const result = f.run("--only", "a", "--hard", "--dry-run", "--json");
  expect(result.code).toBe(1);
  expect(JSON.parse(result.out.trim()).families[0].error_class).toBe("session_identity_mismatch");
  expect(f.doc().seats).toEqual({ a: row });
  expect(f.history()).toHaveLength(0);
});

// Control: launch_witness (launch-evidence.ts) is a ready seat's persistent
// incarnation witness, not a launch in progress. Hard retirement's settled-session
// precondition still refuses launch_token and still admits the witness.
test("a ready seat's launch_witness does not read as a launch in progress for hard retirement", () => {
  const row = { instance: "a|one", delivery: "pane", status: "active", harness: "codex",
    session: "t/a", pane_id: "%7", server_epoch: "srv:1:1" };
  const preview = (extra: Record<string, unknown>) => {
    const f = fixture({ a: { ...row, ...extra } });
    const result = f.run("--only", "a", "--hard", "--dry-run", "--json");
    return { code: result.code, out: result.out.trim() };
  };
  expect(preview({ launch_token: "pending" }).out).toContain("session_identity_mismatch");
  const witnessed = preview({ launch_witness: "w" });
  expect(witnessed.out).not.toContain("session_identity_mismatch");
  // The witness changes nothing: same outcome as the bare ready row.
  expect(witnessed).toEqual(preview({}));
});

test("full team out retains an orphan crew and reports partial without losing unrelated history", () => {
  const f = fixture({ a: poll("a|one"), orphan: { instance: "orphan|one", crew: true, session: "t/gone", pane_id: "%7" } });
  const result = f.run("--yes", "--json");
  expect(result.code).toBe(1);
  expect(JSON.parse(result.out.trim()).ok).toBe(false);
  expect(result.out.trim().split("\n")).toHaveLength(1);
  expect(f.doc().seats).toEqual({ orphan: { instance: "orphan|one", crew: true, session: "t/gone", pane_id: "%7" } });
  expect(result.out).toContain('"orphan_retained":["orphan"]');
  expect(f.history()).toHaveLength(1);
});

test("crew selector refuses with parent remedy before effects", () => {
  const f = fixture({ a: poll("a|one"), child: { crew: true, instance: "child|one", session: "t/a" } });
  const result = f.run("--only", "child", "--json");
  expect(result.code).toBe(1);
  expect(result.out).toContain("select the parent handle");
  expect(Object.keys(f.doc().seats as object)).toEqual(["a", "child"]);
});

test("failed self-stop rollback restores only retired rows and keeps a replacement safe", () => {
  const f = fixture({ a: poll("a|one") });
  const ctx = { root: f.root, registryPath: f.registry, team: "t", bus: { home: f.bus } } as ResolvedContext;
  const original = poll("a|one");
  const first = retireFamilyRows(ctx, new Map([["a", original]]), () => ["a"]);
  expect(f.doc().seats).toEqual({});
  expect(f.history()).toHaveLength(1);
  expect(restoreFamilyRows(ctx, first)).toEqual([]);
  expect(f.doc().seats).toEqual({ a: original });
  expect(f.history()).toHaveLength(0);

  const second = retireFamilyRows(ctx, new Map([["a", original]]), () => ["a"]);
  writeFileSync(f.registry, JSON.stringify({ ...f.doc(), seats: { a: poll("a|replacement") } }));
  expect(() => restoreFamilyRows(ctx, second)).toThrow("rollback would overwrite its replacement");
  expect(f.doc().seats).toEqual({ a: poll("a|replacement") });
  expect(f.history()).toHaveLength(1);
});

function liveFamily() {
  const f = fixture({});
  const socket = join(f.base, "tmux.sock");
  const bin = join(f.base, "bin");
  mkdirSync(bin);
  symlinkSync("/bin/sleep", join(bin, "codex"));
  delete f.env.TAP_TMUX_SOCKET;
  f.env.TAP_TMUX_SOCKET_PATH = socket;
  const tmux = (...args: string[]) => spawnSync("tmux", ["-S", socket, ...args], { encoding: "utf8", timeout: 5000 });
  const read = (...args: string[]) => {
    const result = tmux(...args);
    expect(result.status).toBe(0);
    return (result.stdout ?? "").trim();
  };
  expect(tmux("new-session", "-d", "-s", "t/parent", "-n", "parent", `${bin}/codex 600`).status).toBe(0);
  const parentPane = read("display-message", "-p", "-t", "t/parent:0.0", "#{pane_id}");
  expect(tmux("new-window", "-d", "-t", "t/parent", "-n", "child", "sleep 600").status).toBe(0);
  const childPane = read("display-message", "-p", "-t", "t/parent:1.0", "#{pane_id}");
  const epoch = `srv:${read("display-message", "-p", "#{pid}:#{start_time}")}`;
  const common = { delivery: "pane", status: "active", harness: "codex", session: "t/parent",
    server_epoch: epoch, server_socket: socket, boot_id: bootId() };
  writeFileSync(f.registry, JSON.stringify({ schema: "0.20", team: { name: "t", worktree_root: f.root }, seats: {
    parent: { ...common, instance: "parent|one", pane_id: parentPane },
    child: { ...common, instance: "child|one", pane_id: childPane, crew: true },
  } }));
  return { ...f, socket, tmux, read, parentPane, childPane };
}

function onFamilySocket<T>(f: ReturnType<typeof liveFamily>, action: () => T): T {
  const priorPath = process.env.TAP_TMUX_SOCKET_PATH, priorName = process.env.TAP_TMUX_SOCKET;
  process.env.TAP_TMUX_SOCKET_PATH = f.socket;
  delete process.env.TAP_TMUX_SOCKET;
  try { return action(); }
  finally {
    if (priorPath === undefined) delete process.env.TAP_TMUX_SOCKET_PATH;
    else process.env.TAP_TMUX_SOCKET_PATH = priorPath;
    if (priorName === undefined) delete process.env.TAP_TMUX_SOCKET;
    else process.env.TAP_TMUX_SOCKET = priorName;
  }
}

function stopFamilyHelper(f: ReturnType<typeof liveFamily>): void {
  onFamilySocket(f, () => {
    const binding = crewLifetimeBinding(f.childPane);
    if (binding) stopCrewLifetimeHelper(binding);
  });
}

test("family retirement preserves rows on other generations with the same session and pane", () => {
  const f = liveFamily();
  try {
    const document = JSON.parse(readFileSync(f.registry, "utf8"));
    document.seats.oldParent = { ...document.seats.parent, server_epoch: "srv:1:1" };
    document.seats.oldChild = { ...document.seats.child, server_epoch: "srv:1:1" };
    const otherRows = { oldParent: document.seats.oldParent, oldChild: document.seats.oldChild };
    writeFileSync(f.registry, JSON.stringify(document));
    const result = f.run("--only", "parent", "--json");
    expect(result.code, result.out + result.err).toBe(0);
    expect(f.doc().seats).toEqual(otherRows);
    expect(f.read("display-message", "-p", "-t", f.childPane, "#{pane_id}")).toBe(f.childPane);
  } finally { stopFamilyHelper(f); f.tmux("kill-server"); }
}, 30000);

for (const observation of ["no-terminal", "unreadable"] as const) test(`hard out refuses a ${observation} caller with a live private server`, () => {
  const f = liveFamily();
  try {
    const bin = join(f.base, "caller-bin");
    mkdirSync(bin);
    // Only the caller's tty-aware observation changes. Target ancestry and
    // lifetime proofs still use real ps against the live private server.
    writeFileSync(join(bin, "ps"), `#!/bin/sh
case "$*" in
  '-o ppid= -o tty= -p '*) ${observation === "no-terminal" ? "printf '1 ??\\n'" : "exit 1"} ;;
  *) exec /bin/ps "$@" ;;
esac
`, { mode: 0o755 });
    f.env.PATH = `${bin}:${f.env.PATH}`;
    const before = readFileSync(f.registry, "utf8");
    const result = f.run("--only", "parent", "--hard", "--json");
    expect(result.code, result.out + result.err).toBe(1);
    const receipt = JSON.parse(result.out);
    expect(receipt.error_class).toBe("caller_identity_unobservable");
    expect(receipt.detail).toContain(observation === "no-terminal"
      ? "process ancestry ended before finding a tmux pane" : "process observation unavailable");
    expect(receipt.action).toContain("terminal");
    expect(readFileSync(f.registry, "utf8")).toBe(before);
    expect(f.history()).toHaveLength(0);
    expect(f.read("display-message", "-p", "-t", f.parentPane, "#{pane_id}")).toBe(f.parentPane);
    expect(f.read("display-message", "-p", "-t", f.childPane, "#{pane_id}")).toBe(f.childPane);
  } finally { f.tmux("kill-server"); }
}, 30000);

test("plain family dry-run validates live crew without arming its helper", () => {
  const f = liveFamily();
  try {
    const result = f.run("--only", "parent", "--dry-run", "--json");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.trim()).ok).toBe(true);
    expect(Object.keys(f.doc().seats as object).sort()).toEqual(["child", "parent"]);
    expect(f.history()).toHaveLength(0);
    const option = f.tmux("show-options", "-p", "-v", "-t", f.childPane, "@tap_crew_lifetime");
    expect(option.status === 0 ? option.stdout.trim() : "").toBe("");
    expect(f.read("display-message", "-p", "-t", f.parentPane, "#{pane_id}")).toBe(f.parentPane);
    expect(f.read("display-message", "-p", "-t", f.childPane, "#{pane_id}")).toBe(f.childPane);
  } finally { f.tmux("kill-server"); }
}, 30000);

test("bare --only picker retires a live parent without crew and leaves both sessions alive", async () => {
  const f = fixture({});
  await pinTestFzf(f);
  const socket = join(f.base, "tmux.sock"), bin = join(f.base, "bin");
  mkdirSync(bin);
  symlinkSync("/bin/sleep", join(bin, "codex"));
  const tmux = (...args: string[]) => spawnSync("tmux", ["-S", socket, ...args], { encoding: "utf8", timeout: 5000 });
  const read = (...args: string[]) => {
    const result = tmux(...args);
    expect(result.status).toBe(0);
    return (result.stdout ?? "").trim();
  };
  try {
    expect(tmux("new-session", "-d", "-s", "t/parent", "-n", "parent", `${bin}/codex 600`).status).toBe(0);
    expect(tmux("new-session", "-d", "-s", "operator", "sleep 600").status).toBe(0);
    const pane = read("display-message", "-p", "-t", "t/parent:0.0", "#{pane_id}");
    const epoch = `srv:${read("display-message", "-p", "#{pid}:#{start_time}")}`;
    writeFileSync(f.registry, JSON.stringify({ schema: "0.20", team: { name: "t", worktree_root: f.root }, seats: {
      parent: { delivery: "pane", status: "active", harness: "codex", session: "t/parent",
        instance: "parent|one", pane_id: pane, server_epoch: epoch, server_socket: socket, boot_id: bootId() },
    } }));
    f.env.TAP_TMUX_SOCKET_PATH = socket;
    delete f.env.TAP_TMUX_SOCKET;
    const result = Bun.spawnSync(["python3", "-c", pickerDriver, process.execPath, MAIN,
      "team", "out", "t", "--only", "--yes", "cohort"],
    { cwd: f.root, env: { ...f.env, TERM: "xterm-256color" }, timeout: 20000 });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const record = JSON.parse(result.stdout.toString()) as { code: number; output: string };
    expect(record.code).toBe(0);
    expect(record.output).toContain("tap team out: 1 registration retired; 0 retained/refused");
    expect(f.doc().seats).toEqual({});
    expect(f.history()).toHaveLength(1);
    expect(read("display-message", "-p", "-t", pane, "#{pane_id}")).toBe(pane);
    expect(tmux("has-session", "-t", "operator").status).toBe(0);
  } finally { tmux("kill-server"); }
}, 30000);

test.each([false, true])("a late crew follows only its durable selected owner (linked=%s)", async linked => {
  const f = liveFamily();
  try {
    expect(f.tmux("new-session", "-d", "-s", "operator", "sleep 600").status).toBe(0);
    const seats = f.doc().seats as Record<string, Record<string, unknown>>, lateChild = { ...seats.child!,
      ...(linked ? { crew_owner: "parent", crew_owner_instance: seats.parent!.instance } : {}) };
    writeFileSync(f.registry, JSON.stringify({ ...f.doc(), seats: { parent: seats.parent } }));
    const result = Bun.spawnSync(["python3", "-c", pickerDriver, process.execPath, MAIN,
      "team", "out", "t", "confirm-late"],
      { cwd: f.root, env: { ...f.env, TERM: "xterm-256color", TAP_TEST_LATE_REGISTRY: f.registry,
        TAP_TEST_LATE_ROW: JSON.stringify(lateChild) }, timeout: 20000 });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const record = JSON.parse(result.stdout.toString()) as { code: number; output: string };
    expect(record.code, record.output).toBe(linked ? 0 : 1);
    expect(Object.keys(f.doc().seats as object).sort()).toEqual(linked ? [] : ["child", "parent"]);
    expect(f.history()).toHaveLength(linked ? 2 : 0);
    expect(f.read("display-message", "-p", "-t", f.childPane, "#{pane_id}")).toBe(f.childPane);
  } finally { f.tmux("kill-server"); }
}, 30000);

async function waitFor(predicate: () => boolean, max = 5000): Promise<boolean> {
  const deadline = Date.now() + max;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(100);
  }
  return false;
}

test("plain family out leaves both processes running after the parent later exits", async () => {
  const f = liveFamily();
  try {
    const result = f.run("--only", "parent", "--json");
    expect(result.code).toBe(0);
    expect(f.doc().seats).toEqual({});
    expect(f.history()).toHaveLength(2);
    expect(f.read("display-message", "-p", "-t", f.parentPane, "#{pane_id}")).toBe(f.parentPane);
    expect(f.read("display-message", "-p", "-t", f.childPane, "#{pane_id}")).toBe(f.childPane);
    expect(f.tmux("kill-pane", "-t", f.parentPane).status).toBe(0);
    await Bun.sleep(3000);
    expect(f.read("display-message", "-p", "-t", f.childPane, "#{pane_id}")).toBe(f.childPane);
  } finally { f.tmux("kill-server"); }
}, 30000);

test("full plain out retires an orphan row with a current crew process proof", async () => {
  const f = liveFamily();
  try {
    const child = (f.doc().seats as Record<string, unknown>).child;
    expect(f.run("--only", "parent", "--json").code).toBe(0);
    writeFileSync(f.registry, JSON.stringify({ ...f.doc(), seats: { child } }));
    const result = f.run("--yes", "--json");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.trim()).preview.bound_orphans).toEqual(["child"]);
    expect(f.doc().seats).toEqual({});
    expect(f.read("display-message", "-p", "-t", f.childPane, "#{pane_id}")).toBe(f.childPane);
    expect(f.tmux("kill-pane", "-t", f.parentPane).status).toBe(0);
    await Bun.sleep(3000);
    expect(f.read("display-message", "-p", "-t", f.childPane, "#{pane_id}")).toBe(f.childPane);
  } finally { f.tmux("kill-server"); }
}, 30000);

for (const fault of ["save", "stop"] as const) test(`hard orphan ${fault} failure keeps its live bound child registered`, () => {
  const f = liveFamily();
  try {
    const child = (f.doc().seats as Record<string, unknown>).child;
    expect(f.run("--only", "parent", "--json").code).toBe(0);
    writeFileSync(f.registry, JSON.stringify({ ...f.doc(), seats: { child } }));
    if (fault === "save") f.env.TAP_TEST_UNREGISTER_SAVE_FAIL = "1";
    else f.env.TAP_TEST_TEAM_OUT_CREW_STOP_FAIL = "child";
    const result = f.runOperator("--yes", "--hard", "--json");
    expect(result.code).toBe(1);
    expect((f.doc().seats as Record<string, unknown>).child).toEqual(child);
    expect(f.history()).toHaveLength(2);
    expect(f.read("display-message", "-p", "-t", f.parentPane, "#{pane_id}")).toBe(f.parentPane);
    expect(f.read("display-message", "-p", "-t", f.childPane, "#{pane_id}")).toBe(f.childPane);
  } finally { stopFamilyHelper(f); f.tmux("kill-server"); }
}, 30000);

test("hard family out stops exact parent and child while retaining the team envelope", () => {
  const f = liveFamily();
  try {
    const result = f.runOperator("--only", "parent", "--hard", "--json");
    expect(result.code).toBe(0);
    expect(f.doc().seats).toEqual({});
    expect(f.history()).toHaveLength(2);
    expect(f.tmux("has-session", "-t", "t/parent").status).not.toBe(0);
    expect(existsSync(f.registry)).toBe(true);
    expect(readFileSync(join(f.bus, "registry-events.log"), "utf8")).toContain(`handle=parent pane=${f.parentPane}`);
  } finally { f.tmux("kill-server"); }
}, 30000);

test("hard family save failure leaves every process and registration intact", () => {
  const f = liveFamily();
  try {
    f.env.TAP_TEST_UNREGISTER_SAVE_FAIL = "1";
    const result = f.runOperator("--only", "parent", "--hard", "--json");
    expect(result.code).toBe(1);
    expect(Object.keys(f.doc().seats as object).sort()).toEqual(["child", "parent"]);
    expect(f.history()).toHaveLength(0);
    expect(f.read("display-message", "-p", "-t", f.parentPane, "#{pane_id}")).toBe(f.parentPane);
    expect(f.read("display-message", "-p", "-t", f.childPane, "#{pane_id}")).toBe(f.childPane);
  } finally { stopFamilyHelper(f); f.tmux("kill-server"); }
}, 30000);

for (const stoppedPart of ["child", "parent"] as const) test(`hard family ${stoppedPart} stop failure restores only proven survivors`, () => {
  const f = liveFamily();
  try {
    if (stoppedPart === "child") f.env.TAP_TEST_TEAM_OUT_CREW_STOP_FAIL = "child";
    else f.env.TAP_TEST_TEAM_OUT_PARENT_STOP_FAIL = "1";
    const result = f.runOperator("--only", "parent", "--hard", "--json");
    expect(result.code).toBe(1);
    const receipt = JSON.parse(result.out.trim());
    expect(receipt.ok).toBe(false);
    expect(receipt.families[0].outcome).toBe("partial");
    expect(Object.keys(f.doc().seats as object).sort()).toEqual(stoppedPart === "child" ? ["child", "parent"] : ["parent"]);
    expect(f.history()).toHaveLength(stoppedPart === "child" ? 0 : 1);
    expect(f.read("display-message", "-p", "-t", f.parentPane, "#{pane_id}")).toBe(f.parentPane);
    if (stoppedPart === "child") expect(f.read("display-message", "-p", "-t", f.childPane, "#{pane_id}")).toBe(f.childPane);
    else expect((f.tmux("list-panes", "-a", "-F", "#{pane_id}").stdout ?? "").split("\n")).not.toContain(f.childPane);
  } finally { stopFamilyHelper(f); f.tmux("kill-server"); }
}, 30000);

test("hard family rechecks parent generation after crew stop and restores its surviving row", () => {
  const f = liveFamily();
  try {
    f.env.TAP_TEST_TEAM_OUT_PARENT_GENERATION_CHANGE_AFTER_CREW = "1";
    const result = f.runOperator("--only", "parent", "--hard", "--json");
    expect(result.code).toBe(1);
    const receipt = JSON.parse(result.out.trim());
    expect(receipt.ok).toBe(false);
    expect(receipt.families[0].error_class).toBe("target_changed");
    expect(receipt.families[0].outcome).toBe("partial");
    expect(receipt.families[0].retired).toEqual(["child"]);
    expect((f.doc().seats as Record<string, { instance: string }>).parent?.instance).toBe("parent|one");
    expect(Object.keys(f.doc().seats as object)).toEqual(["parent"]);
    expect(f.history()).toHaveLength(1);
    expect(f.read("display-message", "-p", "-t", f.parentPane, "#{pane_id}")).toBe(f.parentPane);
    expect((f.tmux("list-panes", "-a", "-F", "#{pane_id}").stdout ?? "").split("\n")).not.toContain(f.childPane);
  } finally { stopFamilyHelper(f); f.tmux("kill-server"); }
}, 30000);

test("failed survivor restoration retains published history after a partial stop", () => {
  const f = liveFamily();
  try {
    f.env.TAP_TEST_TEAM_OUT_PARENT_STOP_FAIL = "1";
    f.env.TAP_TEST_UNREGISTER_RESTORE_FAIL = "1";
    const result = f.runOperator("--only", "parent", "--hard", "--json");
    expect(result.code).toBe(1);
    const receipt = JSON.parse(result.out.trim());
    expect(receipt.families[0].detail).toContain("restore failed; history retained");
    expect(f.doc().seats).toEqual({});
    expect(f.history()).toHaveLength(2);
    expect(f.read("display-message", "-p", "-t", f.parentPane, "#{pane_id}")).toBe(f.parentPane);
    expect((f.tmux("list-panes", "-a", "-F", "#{pane_id}").stdout ?? "").split("\n")).not.toContain(f.childPane);
  } finally { stopFamilyHelper(f); f.tmux("kill-server"); }
}, 30000);

test("hard out stops an exact parent shell after its harness exited without crew", () => {
  const f = fixture({});
  const socket = join(f.base, "tmux.sock");
  const tmux = (...args: string[]) => spawnSync("tmux", ["-S", socket, ...args], { encoding: "utf8", timeout: 5000 });
  try {
    expect(tmux("new-session", "-d", "-s", "t/parent", "-n", "parent", "/bin/bash -i").status).toBe(0);
    expect(tmux("new-session", "-d", "-s", "operator", "sleep 600").status).toBe(0);
    const pane = (tmux("display-message", "-p", "-t", "t/parent:0.0", "#{pane_id}").stdout ?? "").trim();
    const epoch = `srv:${(tmux("display-message", "-p", "#{pid}:#{start_time}").stdout ?? "").trim()}`;
    writeFileSync(f.registry, JSON.stringify({ schema: "0.20", team: { name: "t", worktree_root: f.root }, seats: {
      parent: { delivery: "pane", status: "active", harness: "codex", session: "t/parent",
        instance: "parent|one", pane_id: pane, server_epoch: epoch, server_socket: socket, boot_id: bootId() },
    } }));
    f.env.TAP_TMUX_SOCKET_PATH = socket;
    delete f.env.TAP_TMUX_SOCKET;
    const result = f.runOperator("--only", "parent", "--hard", "--json");
    expect(result.code).toBe(0);
    expect(f.doc().seats).toEqual({});
    expect(f.history()).toHaveLength(1);
    expect(tmux("has-session", "-t", "t/parent").status).not.toBe(0);
    expect(tmux("has-session", "-t", "operator").status).toBe(0);
  } finally { tmux("kill-server"); }
}, 30000);

test.each(["out", "reset"])("%s from the selected parent pane publishes stop_requested before ending its family", async verb => {
  const f = fixture({});
  const socket = join(f.base, "tmux.sock");
  const tmux = (...args: string[]) => spawnSync("tmux", ["-S", socket, ...args], { encoding: "utf8", timeout: 5000 });
  const read = (...args: string[]) => {
    const result = tmux(...args);
    expect(result.status).toBe(0);
    return (result.stdout ?? "").trim();
  };
  const go = join(f.base, "go"), receipt = join(f.base, "self-receipt.jsonl");
  const harness = join(f.base, "codex-self.ts");
  const config = { main: MAIN, cwd: f.root, env: f.env, go, receipt, socket, verb };
  writeFileSync(harness, `import { existsSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
const config = ${JSON.stringify(config)};
while (!existsSync(config.go)) Bun.sleepSync(50);
const output = openSync(config.receipt, "w");
const args = config.verb === "reset" ? ["reset", "t", "--yes", "--json"] : ["out", "t", "--only", "parent", "--kill", "--yes", "--json"];
const child = spawn(process.execPath, [config.main, "team", ...args], {
  cwd: config.cwd, env: { ...process.env, ...config.env, TAP_TMUX_SOCKET_PATH: config.socket },
  stdio: ["inherit", output, output],
});
child.on("exit", code => { process.exitCode = code ?? 1; });
`);
  try {
    expect(tmux("new-session", "-d", "-s", "t/parent", "-n", "parent", `bun ${harness}`).status).toBe(0);
    const parentPane = read("display-message", "-p", "-t", "t/parent:0.0", "#{pane_id}");
    expect(tmux("new-window", "-d", "-t", "t/parent", "-n", "child", "sleep 600").status).toBe(0);
    const childPane = read("display-message", "-p", "-t", "t/parent:1.0", "#{pane_id}");
    expect(tmux("new-session", "-d", "-s", "operator", "sleep 600").status).toBe(0);
    const epoch = `srv:${read("display-message", "-p", "#{pid}:#{start_time}")}`;
    const common = { delivery: "pane", status: "active", harness: "codex", session: "t/parent",
      server_epoch: epoch, server_socket: socket, boot_id: bootId() };
    writeFileSync(f.registry, JSON.stringify({ schema: "0.20", team: { name: "t", worktree_root: f.root }, seats: {
      parent: { ...common, instance: "parent|one", pane_id: parentPane },
      child: { ...common, instance: "child|one", pane_id: childPane, crew: true },
    } }));
    const previousSocket = process.env.TAP_TMUX_SOCKET_PATH;
    process.env.TAP_TMUX_SOCKET_PATH = socket;
    try {
      expect(captureParentHarnessLifetime({ registryPath: f.registry, team: "t" } as ResolvedContext, "parent").process.pid).toMatch(/^[1-9]/);
    } finally {
      if (previousSocket === undefined) delete process.env.TAP_TMUX_SOCKET_PATH;
      else process.env.TAP_TMUX_SOCKET_PATH = previousSocket;
    }
    writeFileSync(go, "go");
    expect(await waitFor(() => existsSync(receipt) && readFileSync(receipt, "utf8").includes("stop_requested"), 15000)).toBe(true);
    const output = readFileSync(receipt, "utf8").trim();
    expect(JSON.parse(output).pending_self_stop).toBe("parent");
    expect(JSON.parse(output).families.at(-1).outcome).toBe("stop_requested");
    expect(await waitFor(() => tmux("has-session", "-t", "t/parent").status !== 0)).toBe(true);
    expect(tmux("has-session", "-t", "operator").status).toBe(0);
    expect(f.doc().seats).toEqual({});
    expect(existsSync(f.registry)).toBe(true);
    expect(existsSync(join(f.index, "global-registry.json"))).toBe(true);
    expect(f.history()).toHaveLength(2);
  } finally {
    tmux("kill-server");
    const unowned = () => spawnSync("lsof", ["+D", f.base], { encoding: "utf8" }).status === 1;
    expect(await waitFor(unowned, 10000)).toBe(true);
  }
}, 30000);

test("a surviving self hard-stop emits a final JSON failure after its durable request", async () => {
  const f = fixture({});
  const socket = join(f.base, "tmux.sock"), go = join(f.base, "go"), receipt = join(f.base, "self-failed.jsonl");
  const harness = join(f.base, "codex-self.ts");
  const tmux = (...args: string[]) => spawnSync("tmux", ["-S", socket, ...args], { encoding: "utf8", timeout: 5000 });
  const read = (...args: string[]) => {
    const result = tmux(...args);
    expect(result.status).toBe(0);
    return (result.stdout ?? "").trim();
  };
  const config = { main: MAIN, cwd: f.root, env: f.env, go, receipt, socket };
  writeFileSync(harness, `import { existsSync, openSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const config = ${JSON.stringify(config)};
while (!existsSync(config.go)) Bun.sleepSync(50);
const output = openSync(config.receipt, "w");
const child = spawn(process.execPath, [config.main, "team", "out", "t", "--only", "parent", "--hard", "--yes", "--json"], {
  cwd: config.cwd, env: { ...process.env, ...config.env, TAP_TMUX_SOCKET_PATH: config.socket,
    TAP_TEST_TEAM_OUT_PARENT_STOP_FAIL: "1" }, stdio: ["inherit", output, output],
});
child.on("exit", code => { writeFileSync(config.go + ".done", String(code)); setInterval(() => {}, 1000); });
`);
  try {
    expect(tmux("new-session", "-d", "-s", "t/parent", "-n", "parent", `bun ${harness}`).status).toBe(0);
    expect(tmux("new-session", "-d", "-s", "operator", "sleep 600").status).toBe(0);
    const pane = read("display-message", "-p", "-t", "t/parent:0.0", "#{pane_id}");
    const epoch = `srv:${read("display-message", "-p", "#{pid}:#{start_time}")}`;
    writeFileSync(f.registry, JSON.stringify({ schema: "0.20", team: { name: "t", worktree_root: f.root }, seats: {
      parent: { delivery: "pane", status: "active", harness: "codex", session: "t/parent",
        instance: "parent|one", pane_id: pane, server_epoch: epoch, server_socket: socket, boot_id: bootId() },
    } }));
    writeFileSync(go, "go");
    expect(await waitFor(() => existsSync(go + ".done"), 15000)).toBe(true);
    expect(readFileSync(go + ".done", "utf8")).toBe("1");
    const lines = readFileSync(receipt, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0].pending_self_stop).toBe("parent");
    expect(lines[1].ok).toBe(false);
    expect(lines[1].error_class).toBe("team_out_partial");
    expect(lines[1].families.at(-1).error_class).toBe("session_kill_failed");
    expect(lines[1].retired).toEqual([]);
    expect((f.doc().seats as Record<string, unknown>).parent).toBeDefined();
    expect(f.history()).toHaveLength(0);
    expect(tmux("has-session", "-t", "t/parent").status).toBe(0);
    expect(tmux("has-session", "-t", "operator").status).toBe(0);
  } finally { tmux("kill-server"); }
}, 30000);

test("hard out refuses an unapproved pane in the selected parent session", async () => {
  const f = liveFamily();
  try {
    expect(f.tmux("new-window", "-d", "-t", "t/parent", "-n", "foreign", "sleep 600").status).toBe(0);
    const result = f.runOperator("--only", "parent", "--hard", "--json");
    expect(result.code).toBe(1);
    expect(result.out).toContain("unapproved pane");
    expect((f.doc().seats as Record<string, unknown>).parent).toBeDefined();
    expect(f.tmux("has-session", "-t", "t/parent").status).toBe(0);
    expect(f.read("display-message", "-p", "-t", f.childPane, "#{pane_id}")).toBe(f.childPane);
  } finally {
    const priorSocket = process.env.TAP_TMUX_SOCKET_PATH;
    const priorName = process.env.TAP_TMUX_SOCKET;
    process.env.TAP_TMUX_SOCKET_PATH = f.socket;
    delete process.env.TAP_TMUX_SOCKET;
    const binding = crewLifetimeBinding(f.childPane);
    if (priorSocket === undefined) delete process.env.TAP_TMUX_SOCKET_PATH;
    else process.env.TAP_TMUX_SOCKET_PATH = priorSocket;
    if (priorName === undefined) delete process.env.TAP_TMUX_SOCKET;
    else process.env.TAP_TMUX_SOCKET = priorName;
    if (binding) stopCrewLifetimeHelper(binding);
    f.tmux("kill-server");
    if (binding) expect(await waitFor(() => processGeneration(binding.helper) === "gone")).toBe(true);
    const unowned = () => spawnSync("lsof", ["+D", f.base], { encoding: "utf8" }).status === 1;
    expect(await waitFor(unowned, 10000)).toBe(true);
    await Bun.sleep(500);
    expect(await waitFor(unowned, 10000)).toBe(true);
  }
}, 30000);
