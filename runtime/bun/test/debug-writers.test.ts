import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { recordCommand, recordDebug, safeFields } from "../src/debug-capture";
import { acquirePathLock } from "../src/panelock";

const repo = resolve(import.meta.dir, "../../..");
const leaf = join(repo, "runtime/bun/src/debug-capture.ts");
const entry = join(repo, "bin/tap");
const bashEntry = join(repo, "scripts/tap.sh");
const frameArgs = ["_frame", "first", "codex", "%7", "wire", "last-observed"];

test("journal fields redact credential-named values even when absent from the collector environment", () => {
  for (const key of ["CLAUDE_CODE_MESSAGING_TOKEN", "SERVICE_SECRET", "SSH_KEY", "DB_PASSWORD", "AUTH_COOKIE"]) {
    expect(safeFields({ nested: { [key]: "unseen value with spaces", session_id: "kept" } }, {}))
      .toEqual({ nested: { [key]: "<redacted>", session_id: "kept" } });
    expect(safeFields(`IDENTIFY_ENVIRON ${key}=unseen value with spaces`, {}))
      .toBe(`IDENTIFY_ENVIRON ${key}=<redacted>`);
    expect(safeFields(`{"${key}":"unseen value with spaces"}`, {})).not.toContain("unseen value");
  }
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(process.env.TMUX_TMPDIR!, "dw-")));
  const index = join(root, "index"), bus = join(root, "bus"), run = join(root, "run");
  const env = { ...process.env, PATH: process.env.PATH || "", HOME: join(root, "home"), TAP_INDEX_HOME: index, TAP_HOME: bus,
    TAP_LOCK_DIR: join(root, "locks"), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
  for (const path of [join(index, "debug"), join(bus, "payloads"), run, env.HOME]) mkdirSync(path, { recursive: true });
  const enabled = join(index, "debug/enabled.json");
  writeFileSync(enabled, JSON.stringify({ id: "capture", directory: run }));
  return { root, index, bus, run, env, enabled };
}

test("writers short-circuit disabled/stopped before stdin or bus; frames retain raw bytes and first metadata", () => {
  const f = fixture();
  try {
    rmSync(f.enabled);
    const noBus = { ...f.env, TAP_HOME: "" };
    const unread = () => { throw new Error("read disabled stdin"); };
    for (const args of [frameArgs, ["_attempt"]]) recordDebug(args, unread, noBus);
    recordCommand(["help"], noBus, process.pid);
    expect(readdirSync(f.run)).toEqual([]);
    expect(existsSync(join(f.bus, "receipts"))).toBe(false);
    writeFileSync(f.enabled, JSON.stringify({ id: "capture", directory: f.run }));
    writeFileSync(join(f.run, "stop"), "");
    recordDebug(frameArgs, unread, noBus);
    recordDebug(["_attempt"], unread, noBus);
    rmSync(join(f.run, "stop"));
    expect(() => recordDebug(frameArgs, () => Buffer.from("x"), noBus)).toThrow("TAP_HOME");
    for (const id of ["../escape", "dot.id", "id\n"]) {
      expect(() => recordDebug(["_frame", id, ...frameArgs.slice(2)], unread, f.env)).toThrow("invalid");
    }
    const bytes = Buffer.from([27, 91, 51, 50, 109, 0, 255, 10]);
    recordDebug(frameArgs, () => bytes, f.env);
    const target = join(f.bus, "receipts/first.submit-unverified.frame");
    const sidecar = target.replace(/\.frame$/, ".json");
    const before = readFileSync(sidecar, "utf8");
    recordDebug(["_frame", "first", "other", "%8", "later", "later"], () => Buffer.from("later"), f.env);
    expect(readFileSync(target)).toEqual(bytes);
    expect(readFileSync(sidecar, "utf8")).toBe(before);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(statSync(sidecar).mode & 0o777).toBe(0o600);
    expect(statSync(join(f.bus, "receipts")).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(f.bus, "receipts")).sort()).toEqual(["first.submit-unverified.frame", "first.submit-unverified.json"]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("the public entry journals in-process with broad secrets, deepest team and its own PID; early cache pins cover enabled recording", () => {
  const f = fixture();
  try {
    const env = { ...f.env, ANTHROPIC_KEY: "inherited-secret", TAP_TEAM: "fallback",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(f.root, "cache") };
    writeFileSync(join(f.index, "global-registry.json"), JSON.stringify({ teams: {
      outer: { root: f.root }, inner: { root: f.run }, historical: { root: f.run, state: "historical" },
    } }));
    // Help is static text, so the journal row is the command's only write.
    const result = spawnSync(entry, ["help", "send", "-m", "body secret", "--token", "flag secret",
      "SSH_KEY='quoted secret'", "inherited-secret", "café"], { cwd: f.run, env: { ...env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, encoding: "utf8", timeout: 10000 });
    expect(result.stderr).not.toContain("journal write failed");
    const journal = join(f.run, "events.jsonl");
    const encoded = readFileSync(journal, "utf8"), row = JSON.parse(encoded);
    expect(row.team).toBe("inner");
    expect(row.argv).toEqual(["help", "send", "-m", "<redacted>", "--token", "<redacted>", "SSH_KEY=<redacted>", "<redacted>", "café"]);
    expect(encoded).toContain("\\u00e9");
    expect(row.caller_pid).toBe(result.pid);
    expect(row.operation_id).toMatch(/^[a-f0-9]{32}$/);
    expect(row.timestamp).toMatch(/\.\d{6}\+00:00$/);
    for (const verb of ["health", "provenance"]) {
      spawnSync(entry, [verb, "--json"], { cwd: f.root, env, encoding: "utf8", timeout: 10000 });
      expect(existsSync(env.BUN_RUNTIME_TRANSPILER_CACHE_PATH)).toBe(false);
    }
    expect(readFileSync(journal, "utf8")).toContain('"health"');
    expect(readFileSync(journal, "utf8")).toContain('"provenance"');
    expect(readdirSync(env.HOME)).toEqual([]);
    for (const door of [entry, bashEntry]) {
      const frame = spawnSync(door, ["debug", ...frameArgs], { cwd: f.root, env, input: Buffer.from("door\0\n") });
      expect(frame.status, frame.stderr.toString()).toBe(0);
    }
    expect(readFileSync(join(f.bus, "receipts/first.submit-unverified.frame"))).toEqual(Buffer.from("door\0\n"));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a special file at enabled.json is not recording and never blocks the public command", () => {
  const f = fixture();
  try {
    rmSync(f.enabled);
    // A FIFO with no writer: reading it would block forever.
    expect(spawnSync("mkfifo", [f.enabled]).status).toBe(0);
    const result = spawnSync(entry, ["help", "send"], { cwd: f.root, env: f.env, encoding: "utf8", timeout: 10000 });
    expect(result.signal, "the public command blocked on the marker").toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(readdirSync(f.run)).toEqual([]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("native attempts contend with Python flock on the data inode without truncating or relocating evidence", async () => {
  const f = fixture();
  const path = join(f.bus, "payloads/mixed.debug.attempts");
  const original = '{"payload_id":"mixed","seq":1,"detail":"retained"}\n';
  writeFileSync(path, original, { mode: 0o600 });
  const inode = statSync(path).ino;
  const python = spawn("python3", ["-B", "-c", String.raw`
import fcntl,json,os,sys
with open(sys.argv[1],'a+') as out:
    fcntl.flock(out,fcntl.LOCK_EX)
    print(os.fstat(out.fileno()).st_ino,flush=True)
    sys.stdin.readline()
    out.seek(0)
    seq=sum(1 for _ in out)+1
    out.write(json.dumps(dict(payload_id='mixed',seq=seq,detail='python'))+'\n')
`, path], { env: f.env, stdio: ["pipe", "pipe", "pipe"] });
  try {
    const [ready] = await once(python.stdout!, "data");
    expect(Number(ready.toString().trim())).toBe(inode);
    const children = Array.from({ length: 3 }, () => Bun.spawn(["bun", leaf, "_attempt"], {
      env: f.env, stdin: new Blob([JSON.stringify({ payload_id: "mixed", status: "unverified", detail: "SSH_KEY=hidden",
        nested: { values: ["--keyfile", "separate value", "Authorization: Bearer hidden"] } })]),
      stdout: "pipe", stderr: "pipe",
    }));
    await Bun.sleep(150);
    expect(readFileSync(path, "utf8")).toBe(original);
    python.stdin!.end("\n");
    for (const child of children) expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
    const rows = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows.map(row => row.seq)).toEqual([1, 2, 3, 4, 5]); // participating writers only; Bash does not lock
    expect(rows.slice(2).every(row => row.detail === "SSH_KEY=<redacted>" && row.disposition === "stop-ambiguous")).toBe(true);
    expect(rows[2].nested.values).toEqual(["--keyfile", "separate value", "Authorization: <redacted>"]);
    expect(statSync(path).ino).toBe(inode);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8").startsWith(original)).toBe(true);
    expect(existsSync(join(f.bus, "payloads/mixed.attempts"))).toBe(false);
    const absent = join(f.root, "absent-bus");
    const failed = spawnSync("bun", [leaf, "_attempt"], { env: { ...f.env, TAP_HOME: absent },
      input: JSON.stringify({ payload_id: "missing", status: "injected" }), encoding: "utf8" });
    expect(failed.status).toBe(1);
    expect(existsSync(absent)).toBe(false);
    const malformed = spawnSync("bun", [leaf, "_attempt"], { env: f.env,
      input: '{"payload_id":"missing-status"}', encoding: "utf8" });
    expect(malformed.status).toBe(1);
    expect(existsSync(join(f.bus, "payloads/missing-status.debug.attempts"))).toBe(false);
  } finally {
    python.stdin?.end();
    python.kill();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("the courier's actual two-second child timeout releases a granted helper and preserves its result", () => {
  const f = fixture();
  try {
    const path = join(f.bus, "payloads/timeout.debug.attempts");
    writeFileSync(path, "retained\n", { mode: 0o600 });
    const inode = statSync(path).ino;
    const harness = join(f.root, "holding.ts"), driver = join(f.root, "driver.ts"), ready = join(f.root, "held");
    writeFileSync(harness, `
      import { acquirePathLock } from ${JSON.stringify(join(repo, "runtime/bun/src/panelock.ts"))};
      import { writeFileSync } from "node:fs";
      const lock = acquirePathLock(process.env.ATTEMPTS!, 1000);
      if (!lock) throw new Error("not granted");
      writeFileSync(process.env.READY!, "held");
      await Bun.sleep(10000);
    `);
    writeFileSync(driver, `
      import { captureCourierFailure } from ${JSON.stringify(leaf)};
      const start = Date.now();
      const result = captureCourierFailure({ id: "timeout", pane: "%7", harness: "codex", sentinel: "wire", busHome: process.env.TAP_HOME! },
        () => ({ status: "band_busy", detail: "original" }), true);
      console.log(JSON.stringify({ result, elapsed: Date.now() - start }));
    `);
    const bin = join(f.root, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "bun"), '#!/bin/sh\nexec "$REAL_BUN" "$HOLDING"\n', { mode: 0o755 });
    const result = spawnSync(process.execPath, [driver], { env: { ...f.env, PATH: bin + ":" + f.env.PATH,
      REAL_BUN: process.execPath, HOLDING: harness, ATTEMPTS: path, READY: ready }, encoding: "utf8", timeout: 7000 });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(ready)).toBe(true);
    const row = JSON.parse(result.stdout);
    expect(row.result).toEqual({ status: "band_busy", detail: "original" });
    expect(row.elapsed).toBeGreaterThanOrEqual(1900);
    expect(row.elapsed).toBeLessThan(4000);
    expect(result.stderr).toContain("native courier capture failed");
    const after = acquirePathLock(path, 1000, f.env);
    expect(after).not.toBeNull();
    after?.release(0);
    expect(statSync(path).ino).toBe(inode);
    expect(readFileSync(path, "utf8")).toBe("retained\n");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a writer killed before lock grant leaves the inode available for the next writer", async () => {
  const f = fixture();
  const path = join(f.bus, "payloads/waiting.debug.attempts");
  writeFileSync(path, "retained\n", { mode: 0o600 });
  const holder = acquirePathLock(path, 1000, f.env)!;
  const harness = join(f.root, "waiting.ts"), ready = join(f.root, "waiting");
  writeFileSync(harness, `
    import { acquirePathLock } from ${JSON.stringify(join(repo, "runtime/bun/src/panelock.ts"))};
    import { writeFileSync } from "node:fs";
    writeFileSync(process.env.READY!, "");
    const lock = acquirePathLock(process.env.ATTEMPTS!, 1000);
    lock?.release(0);
  `);
  const child = Bun.spawn([process.execPath, harness], { env: { ...f.env, READY: ready, ATTEMPTS: path }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const until = Date.now() + 2000;
    while (!existsSync(ready) && Date.now() < until) await Bun.sleep(10);
    expect(existsSync(ready)).toBe(true);
    await Bun.sleep(50);
    child.kill("SIGTERM");
    await child.exited;
    holder.release(0);
    const next = acquirePathLock(path, 1000, f.env);
    expect(next).not.toBeNull();
    next?.release(0);
    expect(readFileSync(path, "utf8")).toBe("retained\n");
  } finally {
    child.kill();
    holder.release(0);
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("new shell children have no tty descriptors, with a positive pty control", () => {
  const f = fixture();
  try {
    const bin = join(f.root, "bin"), record = join(f.root, "fds");
    mkdirSync(bin);
    writeFileSync(join(bin, "bun"), String.raw`#!/bin/bash
case "$1" in
  */debug-capture.ts)
    s0=0; s1=0; s2=0
    [ ! -t 0 ] || s0=1
    [ ! -t 1 ] || s1=1
    [ ! -t 2 ] || s2=1
    printf '%s%s%s\n' "$s0" "$s1" "$s2" >> "$FD_RECORD"
    ;;
esac
exec "$REAL_BUN" "$@"
`, { mode: 0o755 });
    const env = { ...f.env, PATH: bin + ":" + f.env.PATH, REAL_BUN: process.execPath, FD_RECORD: record };
    const pty = String.raw`
import errno,json,os,pty,select,subprocess,sys,time
master,slave=pty.openpty()
child=subprocess.Popen(json.loads(sys.argv[1]),stdin=slave,stdout=slave,stderr=slave)
os.close(slave)
try:
    until=time.monotonic()+8
    while time.monotonic()<until:
        if select.select([master],[],[],.05)[0]:
            try:
                if not os.read(master,65536): break
            except OSError as error:
                if error.errno==errno.EIO: break
                raise
        if child.poll() is not None: break
    else: raise RuntimeError('pty child did not finish')
    child.wait(timeout=2)
finally:
    if child.poll() is None: child.kill(); child.wait()
    os.close(master)
`;
    const commands = [
      ["bun", leaf, "control"], // positive control: the fake bun records the leaf's descriptors
      [entry, "help", "debug"], // no recorder hook for early debug help
      [entry, "whoami"],       // journals in-process: no recorder child at all
      [entry, "debug", ...frameArgs],
      [bashEntry, "debug", ...frameArgs],
    ];
    for (const args of commands) {
      const result = spawnSync("python3", ["-B", "-c", pty, JSON.stringify(args)], { cwd: f.root, env, encoding: "utf8", timeout: 12000 });
      expect(result.status, result.stderr).toBe(0);
    }
    expect(readFileSync(record, "utf8").trim().split("\n")).toEqual(["111", "000", "000"]);
    expect(readFileSync(join(f.run, "events.jsonl"), "utf8")).toContain('"argv":["whoami"]');
    rmSync(f.enabled);
    const cache = join(f.root, "disabled-cache");
    const disabled = spawnSync(entry, ["debug", "_attempt"], { cwd: f.root,
      env: { ...env, TAP_HOME: "", BUN_RUNTIME_TRANSPILER_CACHE_PATH: cache }, input: "not JSON", encoding: "utf8" });
    expect(disabled.status, disabled.stderr).toBe(0);
    expect(disabled.stderr).toBe("");
    expect(existsSync(cache)).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 30_000);


test("non-launch help stays in the public journal while launch help stays read-only", () => {
  const f = fixture();
  try {
    for (const args of [["help"], ["send", "--help"], ["team", "up", "--help"]]) {
      const result = spawnSync(entry, args, { cwd: f.root, env: f.env, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    }
    const journal = join(f.run, "events.jsonl");
    const before = readFileSync(journal, "utf8");
    expect(before.trim().split("\n").map(line => JSON.parse(line).argv))
      .toEqual([["help"], ["send", "--help"], ["team", "up", "--help"]]);
    for (const args of [["launch", "codex", "--help"], ["session", "launch", "codex", "-h"]]) {
      const result = spawnSync(entry, args, { cwd: f.root, env: f.env, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(journal, "utf8")).toBe(before);
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
