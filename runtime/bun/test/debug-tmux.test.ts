import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateTmux, setTmuxEnabled, tmuxSourceStatus, tmuxControlIO, type TmuxControlIO } from "../src/debug-tmux";
import { main, withControl } from "../src/debug";
import { uninstallMachine } from "../src/verbs/machine";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tmux-control-"));
  const env = { ...process.env, HOME: root, TAP_INDEX_HOME: join(root, "index"), XDG_CONFIG_HOME: join(root, "config") };
  const plist = join(root, "Library/LaunchAgents/local.tmux-flight.plist"), flight = join(root, "Library/Logs/tmux-flight");
  mkdirSync(join(root, "Library/LaunchAgents"), { recursive: true });
  const calls: string[][] = [], events: string[] = [];
  let loaded = false, disabled = false, owner = "", bootstrapFailure = false, sampleFailure = false, died = false;
  const io: TmuxControlIO = {
    platform: "darwin", root: join(import.meta.dir, "../../.."), now: () => Date.now(), wait: async () => { events.push("wait-owner"); died = true; },
    which: name => name === "bash" ? "/fake/bash" : name === "timeout" ? "/fake/timeout" : `/fake/${name}`,
    run: async argv => {
      calls.push(argv);
      const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
      const bad = (stderr = "failure") => ({ code: 1, stdout: "", stderr });
      if (argv[0] === "/fake/bash") {
        if (argv.includes("-c")) return ok("5\n");
        if (argv.includes("-n")) return ok();
        if (argv.includes("incident")) { events.push("private-incident"); return ok(); }
        if (argv.includes("sample")) { events.push("sample"); return sampleFailure ? bad() : ok(); }
      }
      if (argv[0] === "ps") return died || !owner ? bad("") : ok(owner);
      if (argv[1] === "print-disabled") return ok(`{ "local.tmux-flight" => ${disabled} }`);
      if (argv[1] === "print") return loaded ? ok("state = running\npid = 321\n") : { code: 113, stdout: "", stderr: "Could not find service" };
      if (argv[1] === "bootout") { events.push("bootout"); loaded = false; return ok(); }
      if (argv[1] === "bootstrap") { events.push("bootstrap"); if (bootstrapFailure && readFileSync(plist, "utf8").includes("tap-debug-tmux-tick")) return bad(); loaded = true; return ok(); }
      if (argv[1] === "disable") { disabled = true; return ok(); }
      if (argv[1] === "enable") { disabled = false; return ok(); }
      return ok();
    },
    readPlist: async path => {
      const raw = readFileSync(path, "utf8");
      if (raw.startsWith("{")) return JSON.parse(raw);
      const manifest = JSON.parse(readFileSync(join(env.TAP_INDEX_HOME, "install-manifest.json"), "utf8"));
      const data = manifest.entries.find((e: any) => e.path === plist).tmux;
      return { Label: "local.tmux-flight", ProgramArguments: ["/fake/bash", "tick", "watch-once"], StartInterval: data.interval, Disabled: !data.enabled, EnvironmentVariables: data.environment };
    },
    verifySample: async () => { if (sampleFailure) throw new Error("first sample missing"); },
    incidentProbe: async () => { events.push("private-incident"); },
  };
  const legacy = (off = false) => {
    const script = join(root, "tmux-flight.sh");
    writeFileSync(script, "#!/bin/bash\n# tmux-flight — flight recorder\ncmd_watch_once() { :; }\ncmd_incident() { :; }\n");
    writeFileSync(plist, JSON.stringify({ Label: "local.tmux-flight", ProgramArguments: ["/bin/bash", script, "watch-once"], StartInterval: 5,
      RunAtLoad: true, Disabled: off, EnvironmentVariables: { PATH: "/opt/homebrew/bin:/usr/bin:/bin" },
      StandardOutPath: join(flight, "launchd.out"), StandardErrorPath: join(flight, "launchd.err") }));
    loaded = !off; disabled = off; owner = `/bin/bash ${script} watch-once`;
    return script;
  };
  return { root, env, plist, flight, calls, events, io, legacy,
    failures: (sample = false, bootstrap = false) => { sampleFailure = sample; bootstrapFailure = bootstrap; },
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("status and ordinary on/off leave the unmanaged legacy registration untouched", async () => {
  const f = fixture();
  try {
    f.legacy(); const before = readFileSync(f.plist, "utf8");
    expect(tmuxSourceStatus(f.env).state).toBe("unmanaged");
    expect((await setTmuxEnabled(true, f.env, f.io)).state).toBe("unmanaged");
    expect((await setTmuxEnabled(false, f.env, f.io)).state).toBe("unmanaged");
    expect(f.calls).toHaveLength(0); expect(readFileSync(f.plist, "utf8")).toBe(before);
  } finally { f.cleanup(); }
});

test("explicit migration backs up, observes legacy exit, verifies private capture, and records owned artifacts", async () => {
  const f = fixture();
  try {
    const script = f.legacy(), before = readFileSync(f.plist, "utf8"), original = readFileSync(script, "utf8");
    const result = await migrateTmux(f.env, f.io);
    expect(result.enabled).toBe(true);
    expect(readFileSync(join(result.backup!, "local.tmux-flight.plist"), "utf8")).toBe(before);
    expect(readFileSync(join(result.backup!, "tmux-flight.sh"), "utf8")).toBe(original);
    expect(f.events.indexOf("wait-owner")).toBeGreaterThan(f.events.indexOf("bootout"));
    expect(f.events.indexOf("bootstrap")).toBeGreaterThan(f.events.indexOf("wait-owner"));
    expect(f.events).toContain("private-incident");
    expect(readFileSync(f.plist, "utf8")).toContain("/fake/bash");
    expect(readFileSync(script, "utf8")).toContain("exec");
    expect(readFileSync(script, "utf8")).not.toContain("cmd_incident");
    const manifest = JSON.parse(readFileSync(join(f.env.TAP_INDEX_HOME, "install-manifest.json"), "utf8"));
    expect(manifest.entries).toContainEqual(expect.objectContaining({ kind: "file", path: f.plist, launchd_label: "local.tmux-flight" }));
    expect(manifest.entries).toContainEqual(expect.objectContaining({ kind: "file", path: script }));
  } finally { f.cleanup(); }
});

test("disabled legacy intent survives migration and no registration is bootstrapped", async () => {
  const f = fixture();
  try {
    f.legacy(true); expect((await migrateTmux(f.env, f.io)).enabled).toBe(false);
    expect(f.events).not.toContain("bootstrap");
    expect(tmuxSourceStatus(f.env).state).toBe("off");
  } finally { f.cleanup(); }
});

test("failed activation restores the exact legacy plist and script and reloads the old label", async () => {
  const f = fixture();
  try {
    const script = f.legacy(), before = readFileSync(f.plist, "utf8"), original = readFileSync(script, "utf8");
    f.failures(false, true);
    await expect(migrateTmux(f.env, f.io)).rejects.toThrow("restored");
    expect(readFileSync(f.plist, "utf8")).toBe(before); expect(readFileSync(script, "utf8")).toBe(original);
    expect(f.events.filter(x => x === "bootstrap")).toHaveLength(2);
    expect(tmuxSourceStatus(f.env).state).toBe("unmanaged");
  } finally { f.cleanup(); }
});

test("invalid advanced settings, foreign plists and unsupported legacy overrides refuse before bootout", async () => {
  for (const mode of ["config", "foreign", "override"]) {
    const f = fixture();
    try {
      f.legacy();
      if (mode === "config") { mkdirSync(join(f.env.XDG_CONFIG_HOME, "tap"), { recursive: true }); writeFileSync(join(f.env.XDG_CONFIG_HOME, "tap/config.toml"), "[advanced]\ndebug_tmux_timeout_seconds=0\n"); }
      else {
        const data = JSON.parse(readFileSync(f.plist, "utf8"));
        if (mode === "foreign") data.ProgramArguments = ["/some/unrelated/program"];
        else data.EnvironmentVariables.TMUX_FLIGHT_KEEP_DAYS = "90";
        writeFileSync(f.plist, JSON.stringify(data));
      }
      const before = readFileSync(f.plist, "utf8");
      await expect(migrateTmux(f.env, f.io)).rejects.toThrow();
      expect(f.events).not.toContain("bootout"); expect(readFileSync(f.plist, "utf8")).toBe(before);
    } finally { f.cleanup(); }
  }
});

test("source status decodes its own sample and reports protected incident overage", async () => {
  const f = fixture();
  try {
    await migrateTmux(f.env, f.io);
    writeFileSync(join(f.flight, ".state"), ["v1", Math.floor(Date.now()/1000), "false", "null", 44, 0, 123, 234, 7, 600000000, 63129088, "-L:default"].join("\t") + "\n");
    expect(tmuxSourceStatus(f.env)).toMatchObject({ state: "off", alive: false, incident_count: 7, incident_over_budget_bytes: 63129088 });
    writeFileSync(join(f.flight, ".state"), "torn");
    expect(tmuxSourceStatus(f.env).last_sample_at).toBeNull();
  } finally { f.cleanup(); }
});

test("off stops owned automatic sampling with invalid config and no Bash dependency", async () => {
  const f = fixture();
  try {
    f.legacy(); await migrateTmux(f.env, f.io);
    mkdirSync(join(f.env.XDG_CONFIG_HOME, "tap"), { recursive: true });
    writeFileSync(join(f.env.XDG_CONFIG_HOME, "tap/config.toml"), "[debug\n");
    f.io.which = () => null;
    f.events.length = 0; f.calls.length = 0;
    const stopped = await setTmuxEnabled(false, f.env, f.io);
    expect(stopped.state).toBe("off"); expect(f.events).toContain("bootout");
    expect(f.events).not.toContain("sample"); expect(f.events).not.toContain("private-incident");
    expect(f.calls.some(call => call[1] === "disable")).toBe(true);
    expect(existsSync(join(f.root, "tmux-flight.sh"))).toBe(true);
  } finally { f.cleanup(); }
});

test("first-sample failure rolls back and a changed owned plist is never adopted by ordinary on", async () => {
  const f = fixture();
  try {
    f.legacy(); const before = readFileSync(f.plist, "utf8"); f.failures(true);
    await expect(migrateTmux(f.env, f.io)).rejects.toThrow("restored"); expect(readFileSync(f.plist, "utf8")).toBe(before);
    f.failures(); await migrateTmux(f.env, f.io);
    writeFileSync(f.plist, readFileSync(f.plist, "utf8") + "<!-- user edit -->\n");
    f.calls.length = 0;
    expect((await setTmuxEnabled(true, f.env, f.io)).state).toBe("unmanaged"); expect(f.calls).toHaveLength(0);
  } finally { f.cleanup(); }
});

test("public debug controls expose migration, independent status and source removal", async () => {
  const f = fixture(), output: string[] = [], log = console.log;
  console.log = (...args) => { output.push(args.join(" ")); };
  try {
    f.legacy(); expect(await main(["tmux-migrate", "--json"], f.env, f.io)).toBe(0);
    expect(JSON.parse(output.pop()!).enabled).toBe(true);
    expect(await main(["status", "--json"], f.env, f.io)).toBe(0);
    expect(JSON.parse(output.pop()!).sources.tmux.state).toBe("stale");
    f.events.length = 0;
    expect(await main(["config", "--capture", "tap-events", "--json"], f.env, f.io)).toBe(0);
    expect(f.events).toContain("bootout"); expect(tmuxSourceStatus(f.env).state).toBe("off");
  } finally { console.log = log; f.cleanup(); }
});

test("uninstall stops a hash-owned tmux label before removing its plist and forwarding entry", async () => {
  const f = fixture(), saved = { ...process.env }, log = console.log;
  console.log = () => {};
  try {
    const wrapper = f.legacy(); await migrateTmux(f.env, f.io); f.events.length = 0;
    process.env = { ...f.env };
    expect(await uninstallMachine(async () => "n", { yes: true, history: "keep" }, f.io)).toBe(0);
    expect(f.events).toContain("bootout"); expect(existsSync(f.plist)).toBe(false); expect(existsSync(wrapper)).toBe(false);
    expect(existsSync(f.flight)).toBe(true);
  } finally { process.env = saved; console.log = log; f.cleanup(); }
});

test("an unobserved legacy exit leaves rollback on hold instead of loading a second invocation", async () => {
  const f = fixture();
  try {
    f.legacy(); const before = readFileSync(f.plist, "utf8");
    let now = Date.now(); f.io.now = () => now; f.io.wait = async () => { now += 31000; };
    await expect(migrateTmux(f.env, f.io)).rejects.toThrow("rollback incomplete");
    expect(f.events.filter(event => event === "bootstrap")).toHaveLength(0);
    expect(readFileSync(f.plist, "utf8")).toBe(before);
  } finally { f.cleanup(); }
});

test("supported legacy timing overrides survive reconfiguration until an explicit advanced value replaces them", async () => {
  const f = fixture();
  try {
    f.legacy(); const old = JSON.parse(readFileSync(f.plist, "utf8")); old.StartInterval = 17;
    old.EnvironmentVariables.TMUX_FLIGHT_INCIDENT_GAP_S = "42"; writeFileSync(f.plist, JSON.stringify(old));
    await migrateTmux(f.env, f.io);
    expect(readFileSync(f.plist, "utf8")).toContain("<integer>17</integer>");
    await setTmuxEnabled(true, f.env, f.io);
    expect(readFileSync(f.plist, "utf8")).toContain("<integer>17</integer>");
    mkdirSync(join(f.env.XDG_CONFIG_HOME, "tap"), { recursive: true });
    writeFileSync(join(f.env.XDG_CONFIG_HOME, "tap/config.toml"), "[advanced]\ndebug_tmux_sample_seconds=10\n");
    await setTmuxEnabled(true, f.env, f.io);
    expect(readFileSync(f.plist, "utf8")).toContain("<integer>10</integer>");
    expect(readFileSync(f.plist, "utf8")).toContain("<key>TMUX_FLIGHT_INCIDENT_GAP_S</key><string>42</string>");
  } finally { f.cleanup(); }
});

test("first-sample verification waits for a new matching publication rather than accepting a prior same-second sample", async () => {
  const f = fixture();
  try {
    mkdirSync(f.flight, { recursive: true });
    const path = join(f.flight, ".state"), since = Date.now();
    const line = ["v1", Math.floor(since/1000), "true", 8, 123, 0, 0, 0, 0, 0, 0, "-L:default"].join("\t") + "\n";
    writeFileSync(path, line); utimesSync(path, new Date(since-2000), new Date(since-2000));
    let published = false;
    const pending = tmuxControlIO().verifySample(f.flight, since, "-L:default");
    const timer = setTimeout(() => { writeFileSync(path, line); published = true; }, 50);
    try { await pending; expect(published).toBe(true); } finally { clearTimeout(timer); }
  } finally { f.cleanup(); }
});

test("the production private incident probe captures with the router absent and leaves history untouched", async () => {
  const f = fixture();
  try {
    await tmuxControlIO().incidentProbe(Bun.which("bash")!, join(f.io.root, "scripts/tap-debug-tmux-tick.sh"), f.env);
    expect(existsSync(f.flight)).toBe(false);
  } finally { f.cleanup(); }
}, 30000);

if (process.platform === "darwin") test("the rendered LaunchAgent parses through the system plist reader", async () => {
  const f = fixture();
  try {
    f.legacy(); await migrateTmux(f.env, f.io);
    const data = await tmuxControlIO().readPlist(f.plist, f.env);
    expect(data.ProgramArguments).toEqual(["/fake/bash", join(f.io.root, "scripts/tap-debug-tmux-tick.sh"), "watch-once", "-L", "default"]);
    expect(data.StartInterval).toBe(5); expect(data.Disabled).toBe(false);
  } finally { f.cleanup(); }
});

test("migration preserves legacy HOME and the separate default server-log directory", async () => {
  const f = fixture();
  try {
    f.legacy(); const data = JSON.parse(readFileSync(f.plist, "utf8"));
    const legacyHome = join(f.root, "legacy-home"), samples = join(f.root, "legacy-samples");
    data.EnvironmentVariables.HOME = legacyHome; data.EnvironmentVariables.TMUX_FLIGHT_DIR = samples;
    writeFileSync(f.plist, JSON.stringify(data)); await migrateTmux(f.env, f.io);
    const manifest = JSON.parse(readFileSync(join(f.env.TAP_INDEX_HOME, "install-manifest.json"), "utf8"));
    expect(manifest.entries.find((e: any) => e.path === f.plist).tmux.environment).toMatchObject({
      HOME: legacyHome, TMUX_FLIGHT_DIR: samples, TMUX_FLIGHT_LOG_DIR: join(legacyHome, "Library/Logs/tmux-flight/server-logs"),
    });
  } finally { f.cleanup(); }
});

test("explicit migration waits for the same control lock as on and off", async () => {
  const f = fixture(), log = console.log; console.log = () => {};
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { entered = resolve; });
  const directory = join(f.env.TAP_INDEX_HOME, "debug"); mkdirSync(directory, { recursive: true });
  const holding = withControl(directory, async () => { entered(); await gate; });
  let pending: Promise<number> | undefined;
  try {
    await held; f.legacy(); pending = main(["tmux-migrate", "--json"], f.env, f.io);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(f.events).not.toContain("private-incident");
  } finally {
    release(); await holding; await pending; console.log = log; f.cleanup();
  }
});
