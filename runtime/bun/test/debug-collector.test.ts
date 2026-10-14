import { expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { collect, command, effects, listed, lsofFiles, main, parse, processFiles, startLog, stopLog, streamUpdates, teamBuses, withControl, type CollectorEffects, type Identity, type Log, type Run } from "../src/debug";

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
function fixture(name: string) {
  const root = mkdtempSync(join(tmpdir(), "tap-debug-")), directory = join(root, "capture"), trace = join(directory, "trace");
  mkdirSync(trace, { recursive: true }); mkdirSync(join(root, "debug"));
  const env = { ...process.env, TAP_INDEX_HOME: root };
  const identity: Identity = { pid: 123, start: "456", socket: join(root, "private.sock") };
  const run: Run = { id: name, directory, socket: identity.socket, config: { max_mb: 1024 } };
  writeFileSync(join(directory, "session.json"), JSON.stringify(run));
  writeFileSync(join(root, "debug/enabled.json"), JSON.stringify(run));
  writeFileSync(join(directory, "trace-request.json"), JSON.stringify({ id: name, directory: trace, seconds: 0 }));
  return { root, directory, trace, env, identity, run, stop: () => writeFileSync(join(directory, "stop"), "") };
}

test("debug parser preserves action and option restrictions", () => {
  expect(parse([])?.action).toBe("status");
  expect(parse(["trace", ".25", "--json"])?.seconds).toBe(.25);
  expect(parse(["--max-mb=1_024", "config"])?.max).toBe(1024);
  expect(parse(["config", "--max=10", "--j"])?.max).toBe(10);
  expect(() => parse(["on", "--socket", "--json"])).toThrow("expected one argument");
  for (const args of [["trace", "nan"], ["trace", "inf"], ["trace", "-1"], ["trace", "0"], ["trace"], ["off", "2"], ["on", "--max-mb", "10"], ["config", "--max-mb", "1.5"], ["config", "--max-mb", "10241"], ["status", "--socket", "x"]])
    expect(() => parse(args)).toThrow();
  expect(parse(["trace", "--help"])).toBeNull();
  expect(() => parse(["config", "--lifetime-hours", "24"])).toThrow("retired");
  for (const args of [["config", "--lifetime-hours", "0"], ["config", "--lifetime-hours", "169"], ["on", "--lifetime-hours", "2"]]) expect(() => parse(args)).toThrow();
});

test("debug help states the option scope the parser enforces", async () => {
  const written: string[] = [], write = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try { expect(await main(["--help"])).toBe(0); } finally { process.stdout.write = write; }
  const help = written.join("");
  for (const scope of ["on and trace only", "config only", "trace only", "tap debug trace 120 --json", "tap debug config --max-mb"]) expect(help).toContain(scope);
  expect(() => parse(["config", "--socket", "/tmp/s"])).toThrow("--socket belongs to tap debug on or trace");
  expect(() => parse(["status", "--max-mb", "10"])).toThrow("settings belong to tap debug config");
  expect(() => parse(["on", "--retain-mb", "10"])).toThrow("settings belong to tap debug config");
  expect(() => parse(["on", "5"])).toThrow("seconds belong to tap debug trace");
  expect(parse(["trace", "5", "--socket", "/tmp/s"])?.socket).toBe("/tmp/s");
  expect(parse(["config", "--max-mb", "5", "--retain-mb", "6"])).toMatchObject({ max: 5, retain: 6 });
});

// tap-5omvz: 63 buses held 47k settled .attempts files; each 5 s pass opened
// every one. Unchanged files and directories now cost one stat.
test("bus listings are cached until the directory changes; unchanged streams skip the read", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-listing-")), listings = new Map(), positions = new Map();
  try {
    writeFileSync(join(root, "a.attempts"), "{}\n"); writeFileSync(join(root, "a.md"), "");
    const first = listed(root, ".attempts", listings);
    expect(first).toEqual([join(root, "a.attempts")]);
    expect(listed(root, ".attempts", listings)).toBe(first);
    writeFileSync(join(root, "b.attempts"), "");
    expect(listed(root, ".attempts", listings).sort()).toEqual([join(root, "a.attempts"), join(root, "b.attempts")]);
    expect(listed(join(root, "missing"), ".attempts", listings)).toEqual([]);
    expect(streamUpdates(join(root, "a.attempts"), positions, false).lines).toEqual(["{}"]);
    expect(streamUpdates(join(root, "a.attempts"), positions, false)).toEqual({ lines: [], gap: false });
    expect(streamUpdates(root, positions, false)).toEqual({ lines: [], gap: false });
    expect(streamUpdates(join(root, "gone"), positions, false)).toEqual({ lines: [], gap: false });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a capture ignores legacy lifetime settings and runs until explicitly stopped", async () => {
  const f = fixture("lifetime"); rmSync(join(f.directory, "trace-request.json"));
  // An existing session may still carry the retired setting.
  Object.assign(f.run.config, { lifetime_hours: 0 });
  let collected = false;
  const io: CollectorEffects = { ...effects, server: async () => f.identity, teamBuses: () => ({}),
    collectArtifacts: async () => {
      expect(read(join(f.directory, "status.json")).recording).toBe(true);
      collected = true;
      f.stop();
    } };
  try {
    await collect(f.run, io, f.env);
    expect(collected).toBe(true);
    expect(read(join(f.directory, "status.json")).stopped).toBeUndefined();
    expect(existsSync(join(f.root, "debug/enabled.json"))).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("descriptor absence is an answered query; errors and incomplete results remain unknown", async () => {
  expect(lsofFiles({ code: 1, stdout: "lsof: process ID not located: 42\n", stderr: "" }, 42)).toBeNull();
  expect(lsofFiles({ code: 0, stdout: "p42\nfcwd\nn/tmp\nf3\nn/tmp/log\n", stderr: "" }, 42)).toEqual({ cwd: "/tmp", paths: ["/tmp/log"] });
  for (const result of [
    { code: 1, stdout: "", stderr: "" }, { code: 0, stdout: "", stderr: "" },
    { code: 1, stdout: "lsof: process ID not located: 43\n", stderr: "" },
    { code: 1, stdout: "lsof: process ID not located: 42\n", stderr: "permission denied" },
    { code: 0, stdout: "p43\nfcwd\nn/tmp\n", stderr: "" },
  ]) expect(() => lsofFiles(result, 42)).toThrow();
  const root = mkdtempSync(join(tmpdir(), "tap-proc-"));
  try {
    expect(await processFiles(42, root)).toBeNull();
    const process = join(root, "42"); mkdirSync(process); mkdirSync(join(process, "fd"));
    // An incomplete /proc record cannot become a completed absence observation.
    await expect(processFiles(42, root)).rejects.toThrow();
    symlinkSync(root, join(process, "cwd")); symlinkSync("/private/log", join(process, "fd/3"));
    expect(await processFiles(42, root)).toEqual({ cwd: root, paths: ["/private/log"] });
    rmSync(join(process, "fd"), { recursive: true }); writeFileSync(join(process, "fd"), "not a directory");
    await expect(processFiles(42, root)).rejects.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("streams preserve initial EOF, partial bytes, rotation and truncation", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-stream-")), path = join(root, "stream"), positions = new Map();
  try {
    writeFileSync(path, "existing\n");
    expect(streamUpdates(path, positions, true)).toEqual({ lines: [], gap: false });
    appendFileSync(path, Buffer.from([0xff, 13, 10, 112]));
    expect(streamUpdates(path, positions, false).lines).toEqual(["�"]);
    expect(streamUpdates(path, positions, false).lines).toEqual([]);
    appendFileSync(path, "artial\n"); expect(streamUpdates(path, positions, false).lines).toEqual(["partial"]);
    writeFileSync(path, "tiny\n"); expect(streamUpdates(path, positions, false)).toEqual({ lines: ["tiny"], gap: true });
    writeFileSync(join(root, "new"), "rotated\n"); renameSync(join(root, "new"), path);
    expect(streamUpdates(path, positions, false)).toEqual({ lines: ["rotated"], gap: true });
    expect(streamUpdates(path, new Map(), false).lines).toEqual(["rotated"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an absent machine index never reads legacy teams.json and historical teams are excluded", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-buses-")), env = { ...process.env, TAP_INDEX_HOME: root };
  try {
    writeFileSync(join(root, "teams.json"), JSON.stringify({ teams: { old: { root: "/old" } } }));
    expect(teamBuses(env)).toEqual({});
    writeFileSync(join(root, "global-registry.json"), "invalid"); expect(() => teamBuses(env)).toThrow("unreadable");
    writeFileSync(join(root, "global-registry.json"), JSON.stringify({ teams: { old: { root: "/old", state: "historical" }, live: { registry_location: "/live/bus/registry.json" } } }));
    expect(teamBuses(env)).toEqual({ "/live/bus": "live" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pending closure toggles once, later observed closure succeeds, pending activation cannot close", async () => {
  const identity: Identity = { pid: 123, start: "456", socket: "/private.sock" };
  let logging = true, signals = 0;
  const io: CollectorEffects = { ...effects, server: async () => identity, logPath: async () => ({ cwd: "/tmp", path: logging ? "/tmp/log" : null }), toggle: async () => { signals++; } };
  const record: Log = { identity, path: "/tmp/log", owned: true };
  await expect(stopLog(record, io)).rejects.toThrow("close");
  await expect(stopLog(record, io)).rejects.toThrow("close");
  expect(signals).toBe(1);
  logging = false; await stopLog(record, io); expect(signals).toBe(1);
  await expect(stopLog({ identity, owned: true, opened: false }, io)).rejects.toThrow("activation");
});

test("identity mismatch never signals; unknown old-log inspection retains ownership", async () => {
  const old: Identity = { pid: 123, start: "old", socket: "/private.sock" };
  let signals = 0;
  const io: CollectorEffects = { ...effects, server: async () => ({ ...old, start: "reused" }), toggle: async () => { signals++; }, logPath: async () => { throw new Error("inspection denied"); } };
  const record: Log = { identity: old, path: "/tmp/log", owned: true, opened: true };
  await expect(stopLog(record, io)).rejects.toThrow("inspection denied"); expect(record.owned).toBe(true);
  io.logPath = async () => ({ cwd: "/tmp", path: "/tmp/log" }); await expect(stopLog(record, io)).rejects.toThrow("still logging");
  io.logPath = async () => ({ cwd: null, path: null }); await stopLog(record, io);
  expect(signals).toBe(0);
});

for (const reason of ["duration_elapsed", "capture_stopped"]) test(`${reason} retains ownership until third stop and observes ordering at trace.finished`, async () => {
  const f = fixture(reason); let calls = 0;
  const io: CollectorEffects = { ...effects, server: async () => f.identity, teamBuses: () => ({}),
    startLog: async () => { if (reason === "capture_stopped") f.stop(); return { identity: f.identity, path: join(f.root, "log"), owned: true }; },
    stopLog: async record => { expect(record?.owned).toBe(true); calls++; if (calls <= 2) throw new Error("temporary unresponsive server"); },
    appendEvent: (run, event, fields) => {
      if (event === "trace.finished") {
        expect(calls).toBe(3);
        expect(read(join(f.trace, "status.json"))).toMatchObject({ active: true, stopping: reason }); f.stop();
      }
      effects.appendEvent(run, event, fields);
    },
  };
  try {
    await collect(f.run, io, f.env);
    expect(calls).toBe(3); expect(read(join(f.trace, "status.json")).active).toBe(false);
    expect(read(join(f.directory, "status.json")).recording).toBe(false);
    expect(existsSync(join(f.root, "debug/enabled.json"))).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const failure of ["rename", "journal"]) test(`${failure} failure keeps activated trace ownership until third stop`, async () => {
  const f = fixture(failure); let logging = false, calls = 0;
  const io: CollectorEffects = { ...effects, server: async () => f.identity, teamBuses: () => ({}),
    logPath: async () => ({ cwd: f.directory, path: logging ? join(f.directory, "tmux-server-123.log") : null }),
    toggle: async () => { logging = true; },
    rename: (...args: Parameters<typeof renameSync>) => { if (failure === "rename") throw new Error("rename failed"); renameSync(...args); },
    stopLog: async record => {
      expect(record?.owned).toBe(true); expect(record?.opened).toBe(true);
      calls++; if (calls <= 2) throw new Error("temporary rollback failure"); logging = false;
    },
    appendEvent: (run, event, fields) => {
      if (failure === "journal" && event === "tmux.logging") throw new Error("journal failed");
      if (event === "trace.finished") {
        expect(calls).toBe(3); expect(read(join(f.trace, "status.json"))).toMatchObject({ active: true, stopping: "setup_failed" }); f.stop();
      }
      effects.appendEvent(run, event, fields);
    },
  };
  try {
    await collect(f.run, io, f.env);
    expect(calls).toBe(3); expect(logging).toBe(false);
    expect(read(join(f.trace, "status.json"))).toMatchObject({ active: false, reason: "setup_failed" });
    expect(read(join(f.trace, "status.json")).files).not.toHaveLength(0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("exceptional cleanup refreshes its stopping heartbeat and cannot unlink a replacement capture", async () => {
  const f = fixture("exception"); let calls = 0, previousHeartbeat = 0;
  writeFileSync(join(f.directory, "trace-request.json"), JSON.stringify({ id: "exception", directory: f.trace, seconds: 60 }));
  const io: CollectorEffects = { ...effects, server: async () => f.identity,
    startLog: async () => ({ identity: f.identity, path: join(f.root, "log"), owned: true }),
    teamBuses: () => { throw new Error("index unreadable"); },
    stopLog: async record => {
      expect(record?.owned).toBe(true); calls++;
      if (calls > 1) {
        const pending = read(join(f.directory, "status.json"));
        expect(pending).toMatchObject({ recording: true, mode: "trace", trace: { active: true, stopping: "capture_stopped" } });
        expect(pending.heartbeat).toBeGreaterThan(previousHeartbeat); previousHeartbeat = pending.heartbeat;
      }
      if (calls <= 2) throw new Error("inspection failed");
    },
    appendEvent: (run, event, fields) => { if (event === "trace.finished") { expect(calls).toBe(3); writeFileSync(join(f.root, "debug/enabled.json"), JSON.stringify({ id: "replacement" })); } effects.appendEvent(run, event, fields); },
  };
  try { await collect(f.run, io, f.env); expect(read(join(f.root, "debug/enabled.json")).id).toBe("replacement"); }
  finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("external logging refuses before any toggle or file replacement", async () => {
  const f = fixture("external"); let signals = 0;
  const io: CollectorEffects = { ...effects, logPath: async () => ({ cwd: f.directory, path: join(f.directory, "external.log") }), toggle: async () => { signals++; } };
  try { await expect(startLog(f.run, f.identity, f.trace, { identity: f.identity, owned: false }, io)).rejects.toThrow("independently"); expect(signals).toBe(0); }
  finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const location of ["raw", "artifact"]) test(`a pre-existing ${location} tmux log is preserved and never claimed for a new trace`, async () => {
  const f = fixture("existing-log"); let signals = 0;
  const path = join(location === "raw" ? f.root : f.trace, "tmux-server-123.log");
  writeFileSync(path, "prior evidence");
  const io: CollectorEffects = { ...effects, logPath: async () => ({ cwd: f.root, path: null }), toggle: async () => { signals++; } };
  try {
    await expect(startLog(f.run, f.identity, f.trace, { identity: f.identity, owned: false }, io)).rejects.toThrow();
    expect(signals).toBe(0);
    expect(readFileSync(path, "utf8")).toBe("prior evidence");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("closed native traces publish redacted artifacts and remove their private raw capture", async () => {
  const f = fixture("redacted-trace");
  const oldKey = process.env.TAP_TEST_API_KEY;
  process.env.TAP_TEST_API_KEY = "trace"; // A credential value also occurs in operational IDs and paths.
  let logging = false, raw = "", finished = false;
  const secrets = ["token-value", "secret-value", "key-value", "password with spaces", "auth-value"];
  const io: CollectorEffects = { ...effects, server: async () => f.identity, teamBuses: () => ({}), collectArtifacts: async () => {},
    logPath: async () => ({ cwd: f.root, path: logging ? raw || join(f.root, "tmux-server-123.log") : null }),
    toggle: async () => {
      logging = !logging;
      if (logging) appendFileSync(join(f.root, "tmux-server-123.log"), [
        "100.001 " + "x".repeat(65520) + " IDENTIFY_ENVIRON CLAUDE_CODE_MESSAGING_TOKEN=token-value",
        "100.002 IDENTIFY_ENVIRON SERVICE_SECRET=secret-value",
        "100.003 IDENTIFY_ENVIRON SSH_KEY=key-value",
        "100.004 IDENTIFY_ENVIRON DB_PASSWORD=password with spaces",
        "100.005 IDENTIFY_ENVIRON AUTH_COOKIE=auth-value\ncontinued-private-value",
        "100.006 IDENTIFY_ENVIRON CODEX_SESSION_ID=session-kept", "",
      ].join("\n"));
    },
    rename: (from, to) => { renameSync(from, to); raw = String(to); },
    appendEvent: (run, event, fields) => {
      if (event === "trace.started") {
        expect(raw.startsWith(f.directory + "/")).toBe(false);
        expect(read(join(f.root, ".raw", f.run.id, "owner.json"))).toEqual({ id: f.run.id, pid: process.pid });
        expect(statSync(raw).mode & 0o777).toBe(0o600);
        expect(existsSync(join(f.trace, "tmux-server-123.log"))).toBe(false);
      }
      if (event === "trace.finished") {
        expect(read(join(f.directory, "status.json"))).toMatchObject({ recording: true, trace: { stopping: "duration_elapsed" } });
        const artifact = join(f.trace, "tmux-server-123.log");
        const content = readFileSync(artifact, "utf8");
        for (const secret of secrets) expect(content).not.toContain(secret);
        expect(content).not.toContain("continued-private-value");
        expect(content).toContain("CODEX_SESSION_ID=session-kept");
        expect(content.match(/<redacted>/g)).toHaveLength(5);
        expect(existsSync(raw)).toBe(false);
        expect(statSync(artifact).mode & 0o777).toBe(0o600);
        finished = true; f.stop();
      }
      effects.appendEvent(run, event, fields);
    },
  };
  try {
    await collect(f.run, io, f.env); expect(finished).toBe(true);
    expect(read(join(f.trace, "status.json"))).toMatchObject({ id: f.run.id, directory: f.trace });
  } finally {
    if (oldKey === undefined) delete process.env.TAP_TEST_API_KEY; else process.env.TAP_TEST_API_KEY = oldKey;
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("status claims redaction only for a capture started with the sanitizer", async () => {
  const f = fixture("legacy-output"), output: string[] = [];
  writeFileSync(join(f.directory, "status.json"), JSON.stringify({ trace: { active: true, directory: f.trace, deadline_epoch: 0 } }));
  const log = console.log;
  console.log = (...args) => { output.push(args.join(" ")); };
  try {
    await main(["status"], f.env);
    expect(output.join("\n")).toContain("Credential redaction is unverified for this legacy capture");
    expect(output.join("\n")).not.toContain("Credential-named environment values redacted");
    expect(output.join("\n")).not.toContain("the redacted artifact is published");
    writeFileSync(join(f.root, "debug/enabled.json"), JSON.stringify({ ...f.run, redaction: "credentials-v1" }));
    output.length = 0;
    await main(["status"], f.env);
    expect(output.join("\n")).toContain("Credential-named environment values redacted");
  } finally { console.log = log; rmSync(f.root, { recursive: true, force: true }); }
});

test("every basic journal event redacts credential-named fields before append", () => {
  const f = fixture("event-redaction");
  try {
    effects.appendEvent(f.run, "sample", { nested: { AUTH_COOKIE: "hidden" }, detail: "API_TOKEN=also hidden" });
    const event = read(join(f.directory, "events.jsonl"));
    expect(event.nested.AUTH_COOKIE).toBe("<redacted>");
    expect(event.detail).toBe("API_TOKEN=<redacted>");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("control.lock excludes Python and native contenders and retains its inode after release", async () => {
  const root = mkdtempSync(join(tmpdir(), "tap-control-")); let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(r => { entered = r; }), hold = new Promise<void>(r => { release = r; });
  try {
    const first = withControl(root, async () => { entered(); await hold; }); await ready;
    const path = join(root, "control.lock"), inode = statSync(path).ino;
    const python = spawnSync("python3", ["-c", "import fcntl,sys\nf=open(sys.argv[1],'a')\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(75)", path], { encoding: "utf8", timeout: 2000 });
    expect(python.status, python.stderr).toBe(75);
    let granted = false; const second = withControl(root, async () => { granted = true; });
    await Bun.sleep(100); expect(granted).toBe(false); release(); await first; await second;
    expect(granted).toBe(true); expect(existsSync(path)).toBe(true); expect(statSync(path).ino).toBe(inode);
  } finally { release?.(); rmSync(root, { recursive: true, force: true }); }
});

test("control grant tolerates split pipe reads and refuses silent/invalid holders", async () => {
  const root = mkdtempSync(join(tmpdir(), "tap-grant-"));
  try {
    let granted = false;
    await withControl(root, async () => { granted = true; }, ["sh", "-c", "printf he; sleep .05; printf 'ld\\n'; exec cat >/dev/null"]);
    expect(granted).toBe(true);
    for (const script of ["exit 75", "printf invalid; exec cat >/dev/null"]) {
      granted = false;
      await expect(withControl(root, async () => { granted = true; }, ["sh", "-c", script])).rejects.toThrow();
      expect(granted).toBe(false);
    }
    await withControl(root, async () => {});
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("child timeout reaps its group and prevents descendant late writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "tap-deadline-")), late = join(root, "late");
  try {
    let responsive = false;
    const turn = setTimeout(() => { responsive = true; }, 10);
    await expect(command(["sh", "-c", '(sleep .5; printf late > "$1") & wait', "_", late], 100)).rejects.toThrow("timed out");
    clearTimeout(turn); expect(responsive).toBe(true);
    await Bun.sleep(550); expect(existsSync(late)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("control waits respond to TERM before and after grant and release kernel exclusion", async () => {
  for (const phase of ["before", "after"]) {
    const root = mkdtempSync(join(tmpdir(), "tap-interrupt-")), script = join(root, "owner.ts");
    let release!: () => void, entered!: () => void;
    const holding = new Promise<void>(done => { release = done; }), ready = new Promise<void>(done => { entered = done; });
    const blocker = phase === "before" ? withControl(root, async () => { entered(); await holding; }) : Promise.resolve();
    if (phase === "before") await ready;
    writeFileSync(script, `import { withControl } from ${JSON.stringify(join(import.meta.dir, "../src/debug.ts"))};
import { writeFileSync } from 'node:fs'; import { setTimeout } from 'node:timers/promises';
writeFileSync(${JSON.stringify(join(root, "started"))}, '');
await withControl(${JSON.stringify(root)}, async signal => { writeFileSync(${JSON.stringify(join(root, "granted"))}, ''); await setTimeout(60000, undefined, {signal}); });`);
    const child = Bun.spawn([process.execPath, script], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000, killSignal: "SIGKILL" });
    try {
      const marker = join(root, phase === "before" ? "started" : "granted"), until = performance.now() + 3000;
      while (!existsSync(marker) && performance.now() < until) await Bun.sleep(10);
      expect(existsSync(marker)).toBe(true);
      child.kill("SIGTERM");
      const [code] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code).not.toBe(0); expect(child.signalCode).not.toBe("SIGKILL");
      if (phase === "before") expect(existsSync(join(root, "granted"))).toBe(false);
      release(); await blocker;
      await withControl(root, async () => {});
    } finally { child.kill(); await child.exited; release(); await blocker; rmSync(root, { recursive: true, force: true }); }
  }
});

test("trace excludes raw bytes, defers artifact budget, and uses a monotonic duration", async () => {
  for (const artifacts of [false, true]) {
    const f = fixture(artifacts ? "artifact-cap" : "raw-cap"); f.run.config.max_mb = 1;
    writeFileSync(join(f.trace, "tmux-server-123.log"), Buffer.alloc(2 * 1048576));
    if (artifacts) { mkdirSync(join(f.directory, "artifacts")); writeFileSync(join(f.directory, "artifacts/frame"), Buffer.alloc(2 * 1048576)); }
    writeFileSync(join(f.directory, "trace-request.json"), JSON.stringify({ id: f.run.id, directory: f.trace, seconds: .4 }));
    let finished = false, started = 0, rotated = false;
    const realNow = Date.now;
    const io: CollectorEffects = { ...effects, server: async () => f.identity, teamBuses: () => ({}),
      startLog: async () => ({ identity: f.identity, path: join(f.trace, "tmux-server-123.log"), owned: true }), stopLog: async () => {},
      appendEvent: (run, event, fields) => {
        if (event === "trace.started") { started = performance.now(); Date.now = () => realNow() + 3600000; }
        if (event === "trace.finished") { expect(performance.now() - started).toBeGreaterThanOrEqual(350); finished = true; if (!artifacts) f.stop(); }
        if (event === "capture.rotated") { expect(finished).toBe(true); rotated = true; f.stop(); }
        effects.appendEvent(run, event, fields);
      },
    };
    try { await collect(f.run, io, f.env); expect(finished).toBe(true); expect(rotated).toBe(artifacts); }
    finally { Date.now = realNow; rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("TERM to either public CLI PID cannot leave a queued config mutation behind", async () => {
  const repo = join(import.meta.dir, "../../..");
  for (const entry of [join(repo, "bin/tap"), join(repo, "scripts/tap.sh")]) {
    const root = mkdtempSync(join(tmpdir(), "tap-public-stop-")), directory = join(root, "debug"), bin = join(root, "bin");
    mkdirSync(directory); mkdirSync(bin);
    const started = join(root, "started");
    writeFileSync(join(bin, "bun"), '#!/bin/sh\nprintf started > "$STARTED"\nexec "$REAL_BUN" "$@"\n', { mode: 0o755 });
    let release!: () => void, entered!: () => void;
    const hold = new Promise<void>(done => { release = done; }), ready = new Promise<void>(done => { entered = done; });
    const owner = withControl(directory, async () => { entered(); await hold; }); await ready;
    const child = Bun.spawn([entry, "debug", "config", "--max-mb", "3"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000, killSignal: "SIGKILL",
      env: { ...process.env, TAP_INDEX_HOME: root, PATH: bin + ":" + process.env.PATH, REAL_BUN: process.execPath, STARTED: started } });
    try {
      const until = performance.now() + 2000;
      while (!existsSync(started) && performance.now() < until) await Bun.sleep(10);
      expect(existsSync(started)).toBe(true); await Bun.sleep(100);
      child.kill("SIGTERM"); await child.exited;
      release(); await owner;
      await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(child.signalCode).not.toBe("SIGKILL");
      expect(existsSync(join(directory, "config.json"))).toBe(false);
      await withControl(directory, async () => {});
    } finally { child.kill(); await child.exited; release(); await owner; rmSync(root, { recursive: true, force: true }); }
  }
});
