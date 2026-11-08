// [debug] always_on: the per-command arm path (debug-arm.ts), the dead-capture
// skip in recordCommand, and tap debug on/off reclaiming a stale capture.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ARM_CHILD, ARM_WINDOW_MS, alwaysOnCached, armAlwaysOn, pruneArmClaims, readsRealConfig, STATE_PINS } from "../src/debug-arm";
import { recordCommand } from "../src/debug-capture";
import { main, parse } from "../src/debug";

const repo = resolve(import.meta.dir, "../../..");
const entry = join(repo, "bin/tap");
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

/** A sandbox whose TAP state AND config are both private, so arming is allowed. */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tap-always-on-")));
  const index = join(root, "index"), debug = join(index, "debug"), xdg = join(root, "xdg"), config = join(xdg, "tap/config.toml");
  for (const path of [index, join(xdg, "tap"), join(root, "home")]) mkdirSync(path, { recursive: true });
  writeFileSync(join(index, "global-registry.json"), '{"schema":"0.20","teams":{}}\n');
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(root, "home"), XDG_CONFIG_HOME: xdg, TAP_INDEX_HOME: index,
    TAP_TMUX_SOCKET_PATH: join(root, "no-server.sock"), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
  delete env[ARM_CHILD];
  const setConfig = (text: string) => writeFileSync(config, text, { mode: 0o600 });
  return { root, index, debug, xdg, config, env, setConfig };
}
const claims = (debug: string) => existsSync(debug) ? readdirSync(debug).filter(name => /^arm\.attempt\.\d+$/.test(name)).sort() : [];
/** Every arm-chain file under a root, wherever it landed. */
function armFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/^(arm\.attempt\.\d+|arm\.log|always-on\.cache)$/.test(entry.name)) found.push(path);
    }
  };
  walk(root);
  return found.sort();
}
async function until(predicate: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
    await Bun.sleep(50);
  }
}
/** main()'s stdout: it prints through both console.log and process.stdout.write. */
async function capture<T>(body: () => Promise<T>): Promise<{ value: T; out: string }> {
  const written: string[] = [], write = process.stdout.write, log = console.log;
  process.stdout.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
  console.log = (...parts: unknown[]) => { written.push(parts.join(" ") + "\n"); };
  try { const value = await body(); return { value, out: written.join("") }; }
  finally { process.stdout.write = write; console.log = log; }
}
function tap(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const result = Bun.spawnSync([entry, ...args], { env, cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}
/** A pid that has exited and been reaped. */
function deadPid(): number {
  const child = Bun.spawnSync(["/usr/bin/true"]);
  return child.pid;
}
/** A capture whose recorder died: enabled.json, last.json, a status.json last written `age` seconds ago. */
function seedCapture(debug: string, id: string, pid: number, age: number, capture?: string[]) {
  const directory = join(debug, id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const run = { id, directory, socket: "/nonexistent.sock", config: { max_mb: 1024, retain_mb: 2048, ...(capture ? { capture } : {}) }, redaction: "credentials-v1" };
  for (const name of ["enabled.json", "last.json"]) writeFileSync(join(debug, name), JSON.stringify(run));
  writeFileSync(join(directory, "session.json"), JSON.stringify(run));
  const heartbeat = Date.now() / 1000 - age;
  writeFileSync(join(directory, "status.json"), JSON.stringify({ recording: true, pid, heartbeat, mode: "basic" }));
  utimesSync(join(directory, "status.json"), heartbeat, heartbeat);
  const events = '{"event":"capture.started","seed":1}\n{"event":"tap.command","seed":2}\n';
  writeFileSync(join(directory, "events.jsonl"), events);
  return { run, directory, events };
}

test("the arm bit is parsed once per config edit and cached; a refused config is off and named once", () => {
  const f = fixture();
  try {
    expect(alwaysOnCached(f.env, f.debug)).toBe(false);
    expect(existsSync(f.debug)).toBe(false); // no config: nothing written
    f.setConfig("[presets]\n");
    expect(alwaysOnCached(f.env, f.debug)).toBe(false);
    expect(readFileSync(join(f.debug, "always-on.cache"), "utf8")).toMatch(/^\S+ \d+ \d+ 0\n$/);
    f.setConfig("[debug]\nalways_on = true\n");
    expect(alwaysOnCached(f.env, f.debug)).toBe(true);
    expect(readFileSync(join(f.debug, "always-on.cache"), "utf8")).toEndWith(" 1\n");
    // A hit never opens the config: an unreadable config with the same mtime and size still answers from the cache.
    chmodSync(f.config, 0o000);
    try { expect(alwaysOnCached(f.env, f.debug)).toBe(true); } finally { chmodSync(f.config, 0o600); }
    // A torn cache is a miss.
    writeFileSync(join(f.debug, "always-on.cache"), "garbage");
    expect(alwaysOnCached(f.env, f.debug)).toBe(true);
    // A tmux-only capture never arms the tap-events recorder.
    f.setConfig('[debug]\nalways_on = true\ncapture = ["tmux"]\n');
    expect(alwaysOnCached(f.env, f.debug)).toBe(false);
    f.setConfig('[debug]\nalways_on = "yes"\n');
    expect(alwaysOnCached(f.env, f.debug)).toBe(false);
    expect(alwaysOnCached(f.env, f.debug)).toBe(false);
    const log = readFileSync(join(f.debug, "arm.log"), "utf8");
    expect(log.match(/always_on read as off: .*debug_config_invalid/g)).toHaveLength(1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

// bin/tap pins the Bun cache off for the verbs that promise no state creation; arming must honor the same list.
const zeroStateVerbs = (/^\s*([a-z|]+)\) export BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 ;;$/m.exec(readFileSync(entry, "utf8"))?.[1] ?? "").split("|");

test("one claim per window starts one child; help, zero-state verbs, debug and the arm child never arm; no lock or process", () => {
  const f = fixture();
  f.setConfig("[debug]\nalways_on = true\n");
  const started: { home: string; window: number; env: NodeJS.ProcessEnv }[] = [];
  const start = (home: string, window: number, env: NodeJS.ProcessEnv) => { started.push({ home, window, env }); };
  const realNow = Date.now;
  try {
    expect(zeroStateVerbs).toContain("ask");
    expect(zeroStateVerbs).toContain("health");
    const quiet = [["debug", "status"], ["-v", "debug", "off"], ["help", "send"], ["send", "--help"], ["team", "-h"], [], ["version"], ["--version"],
      ["session"], ["session", "list"], ["session", "complete"], ["session", "--json"], ...zeroStateVerbs.map(verb => [verb, "x"])];
    for (const args of quiet) armAlwaysOn(args, f.env, start);
    armAlwaysOn(["whoami"], { ...f.env, [ARM_CHILD]: "1" }, start);
    expect(started).toHaveLength(0);
    expect(claims(f.debug)).toEqual([]);
    for (let i = 0; i < 5; i++) armAlwaysOn(["whoami"], f.env, start);
    expect(started).toHaveLength(1);
    const window = started[0]!.window;
    expect(claims(f.debug)).toEqual([`arm.attempt.${window}`]);
    expect(readFileSync(join(f.debug, `arm.attempt.${window}`), "utf8")).toBe(`${process.pid}\n`);
    // Containment: the child runs in the sandbox's debug home with the sandbox's roots.
    expect(started[0]!.home).toBe(f.debug);
    expect(started[0]!.env.TAP_INDEX_HOME).toBe(f.index);
    expect(started[0]!.env.XDG_CONFIG_HOME).toBe(f.xdg);
    // The foreground took no lock and ran nothing: the only files are the cache and the claim.
    expect(readdirSync(f.debug).sort()).toEqual(["always-on.cache", `arm.attempt.${window}`]);
    Date.now = () => (window + 1) * ARM_WINDOW_MS + 1;
    armAlwaysOn(["whoami"], f.env, start);
    expect(started.map(s => s.window)).toEqual([window, window + 1]);
    pruneArmClaims(f.debug, Date.now());
    expect(claims(f.debug)).toEqual([`arm.attempt.${window + 1}`]);
    // always_on with a tmux-only capture: no spawn, no claim, in a fresh window.
    f.setConfig('[debug]\nalways_on = true\ncapture = ["tmux"]\n');
    Date.now = () => (window + 2) * ARM_WINDOW_MS + 1;
    armAlwaysOn(["whoami"], f.env, start);
    expect(started).toHaveLength(2);
    expect(claims(f.debug)).toEqual([`arm.attempt.${window + 1}`]);
  } finally { Date.now = realNow; rmSync(f.root, { recursive: true, force: true }); }
});

test("pinned TAP state over the real user's config never arms, however that config is reached; a sandboxed config may", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tap-always-on-pinned-")));
  try {
    // `passwd` stands in for the passwd entry's home (injected), so the real home is never read.
    const passwd = join(root, "passwd-home"), index = join(root, "idx"), sandbox = join(root, "xdg");
    for (const dir of [join(passwd, ".config/tap"), join(sandbox, "tap"), index]) mkdirSync(dir, { recursive: true });
    for (const dir of [join(passwd, ".config/tap"), join(sandbox, "tap")]) writeFileSync(join(dir, "config.toml"), "[debug]\nalways_on = true\n", { mode: 0o600 });
    symlinkSync(join(passwd, ".config"), join(root, "config-link"));
    // Only the tap directory linked, beneath an ordinary sandbox .config; and a hardlinked config.toml.
    mkdirSync(join(root, "linked-home/.config"), { recursive: true });
    symlinkSync(join(passwd, ".config/tap"), join(root, "linked-home/.config/tap"));
    mkdirSync(join(root, "hard-xdg/tap"), { recursive: true });
    linkSync(join(passwd, ".config/tap/config.toml"), join(root, "hard-xdg/tap/config.toml"));
    const realHome = () => passwd;
    const base: NodeJS.ProcessEnv = { ...process.env, HOME: join(root, "sandbox-home") };
    for (const name of [...STATE_PINS, "XDG_CONFIG_HOME", ARM_CHILD]) delete base[name];
    // The real config through HOME, an inherited XDG_CONFIG_HOME (run.sh keeps it), a linked .config,
    // a linked tap directory, or a hardlinked config.toml.
    const real = [{ ...base, HOME: passwd }, { ...base, XDG_CONFIG_HOME: join(passwd, ".config") }, { ...base, XDG_CONFIG_HOME: join(root, "config-link") },
      { ...base, HOME: join(root, "linked-home") }, { ...base, XDG_CONFIG_HOME: join(root, "hard-xdg") }];
    for (const env of real) expect(readsRealConfig(env, realHome)).toBe(true);
    expect(readsRealConfig({ ...base, XDG_CONFIG_HOME: sandbox }, realHome)).toBe(false);
    expect(readsRealConfig({ ...base, XDG_CONFIG_HOME: "relative" }, realHome)).toBe(true); // unresolvable: stand down
    let started = 0;
    const start = () => { started++; };
    for (const env of real) for (const pin of STATE_PINS) armAlwaysOn(["whoami"], { ...env, [pin]: index }, start, realHome);
    expect(started).toBe(0);
    expect(armFiles(root)).toEqual([]);
    // The same pin with a config that is not the real user's arms: the guard is not blanket.
    armAlwaysOn(["whoami"], { ...base, TAP_INDEX_HOME: index, XDG_CONFIG_HOME: sandbox }, start, realHome);
    expect(started).toBe(1);
    expect(claims(join(index, "debug"))).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a FIFO at the cache or arm.log never blocks a command: the cache misses and is rewritten, the arm runs without a log", async () => {
  const f = fixture();
  const tmux = privateTmux(f.root);
  const env = { ...f.env, TAP_TMUX_SOCKET_PATH: tmux.socket };
  const fifo = (path: string) => expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
  const timed = () => { const t = Date.now(); const result = tap(["whoami"], env, f.root); return { result, ms: Date.now() - t }; };
  try {
    f.setConfig("[debug]\nalways_on = false\n");
    const baseline = tap(["whoami"], env, f.root);
    rmSync(join(f.debug, "always-on.cache"));
    fifo(join(f.debug, "always-on.cache"));
    const cached = timed();
    expect(cached.result).toEqual(baseline);
    expect(cached.ms).toBeLessThan(10000);
    expect(lstatSync(join(f.debug, "always-on.cache")).isFile()).toBe(true);
    // A refused config logs once to arm.log on a miss; a FIFO there with no reader is no log.
    fifo(join(f.debug, "arm.log"));
    f.setConfig('[debug]\nalways_on = "yes"\n');
    const refused = timed();
    expect(refused.result).toEqual(baseline);
    expect(refused.ms).toBeLessThan(10000);
    // always_on on and no recorder: the arm child starts with no log and records.
    f.setConfig("[debug]\nalways_on = true\n");
    const armed = timed();
    expect(armed.result).toEqual(baseline);
    expect(armed.ms).toBeLessThan(10000);
    expect(claims(f.debug)).toHaveLength(1);
    await until(() => { const enabled = existsSync(join(f.debug, "enabled.json")) ? read(join(f.debug, "enabled.json")) : null;
      return !!enabled && existsSync(join(enabled.directory, "status.json")) && read(join(enabled.directory, "status.json")).recording === true; }, 20000, "the armed recorder");
    expect(lstatSync(join(f.debug, "arm.log")).isFIFO()).toBe(true);
  } finally {
    tap(["debug", "off"], env, f.root);
    tmux.kill();
    rmSync(f.root, { recursive: true, force: true });
  }
}, 60000);

test("parallel public commands arm exactly once per window, print nothing extra, and arming alone is never recording", async () => {
  const f = fixture();
  const runnerDebug = join(process.env.TAP_INDEX_HOME!, "debug");
  const before = existsSync(runnerDebug) ? readdirSync(runnerDebug).sort() : null;
  try {
    f.setConfig("[debug]\nalways_on = false\n");
    const baseline = tap(["whoami"], f.env, f.root);
    expect(claims(f.debug)).toEqual([]);
    f.setConfig("[debug]\nalways_on = true\n");
    const children = Array.from({ length: 8 }, () => Bun.spawn([entry, "whoami"], { env: f.env, cwd: f.root, stdin: "ignore", stdout: "pipe", stderr: "pipe" }));
    const results = await Promise.all(children.map(async child => ({ code: await child.exited,
      stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() })));
    for (const result of results) expect(result).toEqual(baseline);
    const windows = claims(f.debug).map(name => Number(name.split(".").pop()));
    expect(windows.length).toBeGreaterThanOrEqual(1);
    expect(windows.length).toBeLessThanOrEqual(2); // a burst can straddle one minute boundary
    const log = join(f.debug, "arm.log");
    // With no tmux server the child refuses; one refusal per arm, all in the sandbox's arm.log.
    await until(() => (readFileSync(log, "utf8").match(/no tmux server/g) ?? []).length === windows.length, 20000, "arm children");
    const arms = readFileSync(log, "utf8").match(/arm window=(\d+)/g)!.map(line => Number(line.split("=")[1]));
    expect(arms.sort()).toEqual(windows.sort());
    const status = tap(["debug", "status", "--json"], f.env, f.root);
    expect(JSON.parse(status.stdout)).toMatchObject({ recording: false, state: "off", always_on: true });
    expect(armFiles(f.root).every(path => path.startsWith(f.debug + "/"))).toBe(true);
    expect(existsSync(join(f.root, "home/.tap"))).toBe(false);
    expect(existsSync(runnerDebug) ? readdirSync(runnerDebug).sort() : null).toEqual(before);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 60000);

test("the command path skips a dead capture's journal; a live or still-starting capture keeps its rows", () => {
  const f = fixture();
  try {
    mkdirSync(f.debug, { recursive: true });
    const stale = seedCapture(f.debug, "20261103T000000Z-0000dead", deadPid(), 60);
    expect(recordCommand(["whoami"], f.env, process.pid)).toBe(false);
    expect(readFileSync(join(stale.directory, "events.jsonl"), "utf8")).toBe(stale.events);
    const live = seedCapture(f.debug, "20261103T000000Z-0000live", process.pid, 1);
    expect(recordCommand(["whoami"], f.env, process.pid)).toBe(true);
    // The seed already holds a tap.command row; the new one is appended after it.
    const appended = readFileSync(join(live.directory, "events.jsonl"), "utf8");
    expect(appended.startsWith(live.events)).toBe(true);
    expect(appended.slice(live.events.length)).toContain('"tap.command"');
    // Before the first status write, a fresh enabled.json stands in for the heartbeat.
    rmSync(join(live.directory, "status.json"));
    expect(recordCommand(["whoami"], f.env, process.pid)).toBe(true);
    writeFileSync(join(live.directory, "stop"), "");
    const size = statSync(join(live.directory, "events.jsonl")).size;
    expect(recordCommand(["whoami"], f.env, process.pid)).toBe(true);
    expect(statSync(join(live.directory, "events.jsonl")).size).toBe(size);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("an enabled capture that excludes tap-events journals nothing and never counts as dead, so nothing arms", () => {
  const f = fixture();
  try {
    f.setConfig("[debug]\nalways_on = true\n");
    mkdirSync(f.debug, { recursive: true });
    const live = seedCapture(f.debug, "20261103T000000Z-0000tmux", process.pid, 1, ["tmux"]);
    expect(recordCommand(["whoami"], f.env, process.pid)).toBe(true);
    expect(readFileSync(join(live.directory, "events.jsonl"), "utf8")).toBe(live.events);
    const stale = seedCapture(f.debug, "20261103T000000Z-0000tmxd", deadPid(), 60, ["tmux"]);
    expect(recordCommand(["whoami"], f.env, process.pid)).toBe(true);
    const none = seedCapture(f.debug, "20261103T000000Z-0000none", deadPid(), 60, []);
    expect(recordCommand(["whoami"], f.env, process.pid)).toBe(true);
    // The public entry over that stale capture: no row, no claim, no child, and the capture stays enabled.
    expect(tap(["whoami"], f.env, f.root).stderr).not.toContain("tap debug");
    expect(read(join(f.debug, "enabled.json")).id).toBe(none.run.id);
    for (const seeded of [stale, none]) expect(readFileSync(join(seeded.directory, "events.jsonl"), "utf8")).toBe(seeded.events);
    expect(claims(f.debug)).toEqual([]);
    expect(existsSync(join(f.debug, "arm.log"))).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("always_on flags parse as a config-only pair and round-trip through config.toml", async () => {
  expect(parse(["config", "--always-on"])?.alwaysOn).toBe(true);
  expect(parse(["config", "--no-always-on", "--json"])?.alwaysOn).toBe(false);
  expect(parse(["config", "--al"])?.alwaysOn).toBe(true);
  expect(() => parse(["config", "--always-on", "--no-always-on"])).toThrow("contradict");
  expect(() => parse(["on", "--always-on"])).toThrow("settings belong to tap debug config");
  expect(() => parse(["config", "--always-on=true"])).toThrow("unrecognized");
  const f = fixture();
  try {
    f.setConfig("# kept\n[presets]\n");
    const set = await capture(() => main(["config", "--always-on"], f.env));
    expect(set.value).toBe(0);
    expect(set.out).toContain('"always_on":true');
    expect(set.out).toContain('"applies":"next tap command"');
    expect(readFileSync(f.config, "utf8")).toStartWith("# kept\n[presets]\n");
    expect(Bun.TOML.parse(readFileSync(f.config, "utf8"))).toMatchObject({ debug: { always_on: true } });
    const shown = await capture(() => main(["config", "--json"], f.env));
    expect(JSON.parse(shown.out)).toMatchObject({ max_mb: 1024, retain_mb: 2048, always_on: true });
    await capture(() => main(["config", "--no-always-on"], f.env));
    expect(Bun.TOML.parse(readFileSync(f.config, "utf8"))).toMatchObject({ debug: { always_on: false } });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("off retires a dead capture without waiting, keeps its evidence, and turns always_on off", async () => {
  const f = fixture();
  try {
    f.setConfig("[debug]\nalways_on = true\n");
    mkdirSync(f.debug, { recursive: true });
    const dead = seedCapture(f.debug, "20261103T000000Z-0000dead", deadPid(), 60);
    const started = Date.now();
    const off = await capture(() => main(["off"], f.env));
    expect(Date.now() - started).toBeLessThan(5000); // never the 10 s stop wait
    expect(off.value).toBe(0);
    expect(off.out).toContain("Stopped: its recorder was gone (an unclean exit or a reboot)");
    expect(off.out).toContain("Always on: cleared (debug.always_on = false)");
    expect(existsSync(join(f.debug, "enabled.json"))).toBe(false);
    expect(read(join(dead.directory, "status.json"))).toMatchObject({ recording: false, mode: "off", stopped: { reason: "recorder_gone" } });
    const events = readFileSync(join(dead.directory, "events.jsonl"), "utf8");
    expect(events.startsWith(dead.events)).toBe(true);
    expect(events).toContain('"recorder_gone"');
    expect(Bun.TOML.parse(readFileSync(f.config, "utf8"))).toMatchObject({ debug: { always_on: false } });
    // off --json stays one JSON object.
    f.setConfig("[debug]\nalways_on = true\n");
    const json = await capture(() => main(["off", "--json"], f.env));
    expect(JSON.parse(json.out)).toMatchObject({ recording: false, always_on_cleared: true, always_on: false });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("off turns always_on off even when another [debug] key is refused, and says so when it cannot", async () => {
  const f = fixture();
  try {
    f.setConfig("# kept\n[debug]\nalways_on = true\nmax_mb = 0\n");
    const off = await capture(() => main(["off"], f.env));
    expect(off.value).toBe(0);
    expect(off.out).toContain("Always on: cleared (debug.always_on = false)");
    expect(readFileSync(f.config, "utf8")).toBe("# kept\n[debug]\nalways_on = false\nmax_mb = 0\n");
    // Fixing the refused key afterwards cannot re-arm.
    f.setConfig(readFileSync(f.config, "utf8").replace("max_mb = 0", "max_mb = 1024"));
    expect(alwaysOnCached(f.env, f.debug)).toBe(false);
    // Valid TOML spelling always_on quoted or dotted: off edits that key in place.
    for (const [spelled, cleared] of [['[debug]\n"always_on" = true\nmax_mb = 0\n', '[debug]\n"always_on" = false\nmax_mb = 0\n'],
      ["debug.always_on = true\ndebug.max_mb = 0\n", "debug.always_on = false\ndebug.max_mb = 0\n"]] as [string, string][]) {
      f.setConfig(spelled);
      expect((await capture(() => main(["off"], f.env))).value).toBe(0);
      expect(readFileSync(f.config, "utf8")).toBe(cleared);
    }
    // TOML that does not parse is never reported clear, whatever it spells: bare, quoted, dotted,
    // unicode-escaped, or no always_on at all. off still stops recording, exits nonzero and leaves the file alone.
    const unconfirmed = `recording stopped; config.toml does not parse, so always_on could not be confirmed off; fix ${f.config} and run tap debug off again`;
    for (const text of ["[debug]\nalways_on = true\nmax_mb =\n", '[debug]\n"always_on" = true\nmax_mb =\n', "debug.always_on = true\ndebug.max_mb =\n",
      '[debug]\n"\\u0061lways_on" = true\nmax_mb =\n', '[debug]\n"always\\u005fon" = true\nmax_mb =\n', "[debug]\nmax_mb =\n"]) {
      f.setConfig(text);
      await expect(capture(() => main(["off"], f.env))).rejects.toThrow(unconfirmed);
      expect(readFileSync(f.config, "utf8")).toBe(text);
    }
    // A config the secure reader refuses (group-writable) is never reported clear either.
    f.setConfig("[debug]\nalways_on = true\n");
    chmodSync(f.config, 0o660);
    await expect(capture(() => main(["off"], f.env))).rejects.toThrow("recording stopped; config.toml cannot be read (");
    expect(readFileSync(f.config, "utf8")).toBe("[debug]\nalways_on = true\n");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a heartbeat under the stale threshold is unresponsive, not replaced, and says why", async () => {
  const f = fixture();
  try {
    mkdirSync(f.debug, { recursive: true });
    const slow = seedCapture(f.debug, "20261103T000000Z-0000slow", process.pid, 15);
    const before = readFileSync(join(slow.directory, "status.json"), "utf8");
    await expect(main(["on"], f.env)).rejects.toThrow(`unresponsive (recorder pid ${process.pid} alive, heartbeat 15s old)`);
    expect(read(join(f.debug, "enabled.json")).id).toBe(slow.run.id);
    expect(readFileSync(join(slow.directory, "status.json"), "utf8")).toBe(before);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

/** A private tmux server for one test; teardown kills only this socket's server. */
function privateTmux(root: string) {
  const socket = join(root, "t.sock");
  const run = (...args: string[]) => Bun.spawnSync(["tmux", "-S", socket, "-f", "/dev/null", ...args], { stdout: "pipe", stderr: "pipe" });
  expect(run("new-session", "-d", "-s", "probe", "sleep 120").exitCode).toBe(0);
  return { socket, kill: () => run("kill-server") };
}

test("an ordinary command over a dead capture returns at once; the background arm replaces it and keeps the old evidence", async () => {
  const f = fixture();
  const tmux = privateTmux(f.root);
  const env = { ...f.env, TAP_TMUX_SOCKET_PATH: tmux.socket };
  try {
    f.setConfig("[debug]\nalways_on = false\n");
    const baseline = tap(["whoami"], env, f.root);
    f.setConfig("[debug]\nalways_on = true\n");
    mkdirSync(f.debug, { recursive: true });
    const dead = seedCapture(f.debug, "20261103T000000Z-0000dead", deadPid(), 60);
    const result = tap(["whoami"], env, f.root);
    expect(result).toEqual(baseline);
    // The foreground appended no row to the dead capture; the arm child may already have marked it stopped.
    const after = readFileSync(join(dead.directory, "events.jsonl"), "utf8");
    expect(after.startsWith(dead.events)).toBe(true);
    expect(after.slice(dead.events.length)).not.toContain('"tap.command"');
    await until(() => { const enabled = existsSync(join(f.debug, "enabled.json")) ? read(join(f.debug, "enabled.json")) : null;
      return !!enabled && enabled.id !== dead.run.id && existsSync(join(enabled.directory, "status.json")) && read(join(enabled.directory, "status.json")).recording === true; },
      20000, "the replacement capture");
    expect(read(join(dead.directory, "status.json")).stopped.reason).toBe("recorder_gone");
    expect(readFileSync(join(dead.directory, "events.jsonl"), "utf8").startsWith(dead.events)).toBe(true);
    // The child prints its receipt to arm.log just after the new recorder reports ready.
    await until(() => readFileSync(join(f.debug, "arm.log"), "utf8").includes("Replaced: capture 20261103T000000Z-0000dead (recorder_gone)"), 10000, "the arm receipt");
    const off = tap(["debug", "off"], env, f.root);
    expect(off.code).toBe(0);
    expect(off.stdout).toContain("Always on: cleared");
  } finally {
    tap(["debug", "off"], env, f.root);
    tmux.kill();
    rmSync(f.root, { recursive: true, force: true });
  }
}, 60000);

test("on replaces a stalled live recorder; the old one stops itself when it resumes, leaving exactly one", async () => {
  const f = fixture();
  const tmux = privateTmux(f.root);
  const env = { ...f.env, TAP_TMUX_SOCKET_PATH: tmux.socket };
  let stalled: number | null = null;
  const living = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    const first = tap(["debug", "on", "--json"], env, f.root);
    expect(first.code, first.stderr).toBe(0);
    const old = JSON.parse(first.stdout);
    const pid = read(join(old.directory, "status.json")).pid as number; // the recorder this test just started
    stalled = pid;
    process.kill(pid, "SIGSTOP");
    // Stalled long enough: its heartbeat is a minute old.
    const status = join(old.directory, "status.json"), heartbeat = Date.now() / 1000 - 60;
    writeFileSync(status, JSON.stringify({ ...read(status), heartbeat }));
    utimesSync(status, heartbeat, heartbeat);
    const events = readFileSync(join(old.directory, "events.jsonl"), "utf8");
    const second = tap(["debug", "on", "--json"], env, f.root);
    expect(second.code, second.stderr).toBe(0);
    const fresh = JSON.parse(second.stdout);
    expect(fresh.directory).not.toBe(old.directory);
    expect(fresh.retired).toEqual({ capture_id: old.capture_id, reason: "replaced" });
    expect(living(pid)).toBe(true); // never signalled by tap
    process.kill(pid, "SIGCONT");
    await until(() => !living(pid), 10000, "the replaced recorder to stop itself");
    stalled = null;
    expect(read(join(f.debug, "enabled.json")).id).toBe(fresh.capture_id); // its shutdown left the replacement alone
    const now = JSON.parse(tap(["debug", "status", "--json"], env, f.root).stdout);
    expect(now).toMatchObject({ recording: true, capture_id: fresh.capture_id });
    expect(living(read(join(fresh.directory, "status.json")).pid)).toBe(true);
    expect(readFileSync(join(old.directory, "events.jsonl"), "utf8").startsWith(events)).toBe(true);
  } finally {
    if (stalled !== null) { try { process.kill(stalled, "SIGCONT"); } catch { /* already gone */ } }
    tap(["debug", "off"], env, f.root);
    tmux.kill();
    rmSync(f.root, { recursive: true, force: true });
  }
}, 60000);
