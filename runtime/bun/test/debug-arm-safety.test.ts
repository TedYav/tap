import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { armAlwaysOn, mayArm, deferAlwaysOn } from "../src/debug-arm";

const mutationModes = [
  ["keybinding", "remove"], ["tmux-defaults", "remove"], ["bus", "archive"],
  ["role", "peer", "reviewer"], ["role", "peer", "--unset"], ["role", "--team", "example", "peer", "reviewer"],
  ["calibrate", "peer", "-f", "note.md"], ["self", "compact", "--handoff", "handoff.md", "--", "focus"],
  ["self", "goal", "--", "finish"], ["self", "loop", "--", "finish"],
  ["crew", "shutdown", "peer"], ["crew", "resume", "peer"], ["crew", "relaunch", "peer"], ["crew", "rearm", "peer"],
];
const observationalModes = [
  ["role"], ["role", "peer"], ["role", "--team", "example", "peer", "--json"],
  ["calibrate"], ["calibrate", "peer"], ["calibrate", "--all"], ["operate", "--run", "id", "--observe"], ["command", "clear"],
];

const entry = resolve(import.meta.dir, "../../../bin/tap");
function fixture(on: boolean) {
  const root = mkdtempSync(join(tmpdir(), "tap-arm-safety-"));
  const index = join(root, "index"), xdg = join(root, "config"), home = join(root, "home");
  for (const dir of [index, join(xdg, "tap"), home]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} }));
  writeFileSync(join(xdg, "tap/config.toml"), `[debug]\nalways_on = ${on}\n`, { mode: 0o600 });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, TAP_INDEX_HOME: index,
    TAP_HOME: join(root, "bus"), TAP_TMUX_SOCKET_PATH: join(root, "no-server.sock"), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
  return { root, index, env };
}

for (const args of [
  ["init"], ["setup", "--dry-run"], ["setup", "--machine", "--answers", "/missing/answers.json"], ["init", "--dry-run"], ["uninstall", "--dry-run"], ["send", "--dry-run"], ["send", "--help"],
  ["team"], ["team", "--team", "other"], ["team", "other"], ["whoami"], ["outstanding"],
  ["poll"], ["presets"], ["in", "peer", "--list-history"], ["register", "peer", "--list-history"], ["unknown-verb"], ["session", "list"], ["watch", "status"],
]) test(`never arms or writes debug state: ${args.join(" ")}`, () => {
  const f = fixture(true);
  try {
    let starts = 0;
    armAlwaysOn(args, f.env, () => { starts++; });
    expect(starts).toBe(0);
    expect(existsSync(join(f.index, "debug"))).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const args of [["setup", "--dry-run"], ["setup", "--machine", "--answers", "/missing/answers.json"], ["init", "--dry-run"], ["init"], ["uninstall", "--dry-run"], ["team"], ["unknown-verb"], ["send"], ["in", "peer", "--list-history"], ["register", "peer", "--list-history"]]) {
  test(`public command leaves debug state untouched: ${args.join(" ")}`, () => {
    // Disabled recording still exposed the bug: reading the arm bit wrote a cache.
    const f = fixture(false);
    try {
      const result = Bun.spawnSync([entry, ...args], { cwd: f.root, env: f.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 });
      if ((args[0] === "init" && !args.includes("--dry-run")) || args[0] === "unknown-verb" || args[0] === "send") expect(result.exitCode).not.toBe(0);
      if (args[0] === "init" && args.includes("--dry-run")) expect(result.exitCode).toBe(0);
      expect(existsSync(join(f.index, "debug")) ? readdirSync(join(f.index, "debug")) : []).toEqual([]);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

test("the shell startup-cache policy and native arming use one allowlist", () => {
  const f = fixture(false), bin = join(f.root, "bin");
  try {
    mkdirSync(bin);
    writeFileSync(join(bin, "bun"), '#!/bin/sh\nprintf "%s" "$BUN_RUNTIME_TRANSPILER_CACHE_PATH"\n', { mode: 0o755 });
    const commands = readFileSync(resolve(import.meta.dir, "../src/debug-arm-commands.txt"), "utf8").trim().split("\n").map(line => line.split(" "));
    const quiet = [["remind"], ["remind", "list"], ["remind", "list", "--json"], ["in", "peer", "--list-history"], ["register", "peer", "--list-history"], ["team"], ["team", "other"], ["unknown-verb"], ["session", "list"], ["watch", "status"], ["init", "--dry-run"], ["send", "--help"]];
    for (const args of [...commands, ...quiet, ...mutationModes, ...observationalModes, ["remind", "me", "--in", "30m", "-f", "body.md"], ["remind", "peer", "--in", "30m", "-f", "body.md"], ["remind", "kill", "id"], ["remind", "cancel", "id"], ["--verbose", "session", "launch"]]) {
      const result = Bun.spawnSync([entry, ...args], { cwd: f.root, env: { ...f.env, PATH: `${bin}:${process.env.PATH}`, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "cache-enabled" }, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(result.stdout.toString(), args.join(" ")).toBe(mayArm(args) ? "cache-enabled" : "0");
    }
    expect(mayArm(["send"])).toBe(true);
    expect(mayArm(["session", "launch"])).toBe(true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a successful effectful command still checks always-on intent", () => {
  const f = fixture(false);
  try {
    const result = Bun.spawnSync([entry, "init", "--yes", "--no-trust-folders"], { cwd: f.root, env: f.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(existsSync(join(f.index, "debug"))).toBe(false);
    const changed = Bun.spawnSync([entry, "in", "arm-fixture", "--offline"], { cwd: f.root, env: f.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 });
    expect(changed.exitCode, changed.stderr.toString()).toBe(0);
    expect(readdirSync(join(f.index, "debug"))).toEqual(["always-on.cache"]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("deferred arming preserves caller pins before a handler derives TAP_HOME", () => {
  const f = fixture(true), originalHome = process.env.HOME;
  try {
    process.env.HOME = f.env.HOME;
    // Model a real-user config with an injected passwd home, without opening the operator's config.
    const env: NodeJS.ProcessEnv = { ...f.env };
    for (const key of ["TAP_INDEX_HOME", "TAP_HOME", "TAP_SESSION_MANIFEST", "TAP_LOCK_DIR", "TAP_VERSION_SEEN_PATH", "OPENCODE_DB_PATH"]) delete env[key];
    mkdirSync(join(f.env.HOME!, ".config/tap"), { recursive: true });
    writeFileSync(join(f.env.HOME!, ".config/tap/config.toml"), "[debug]\nalways_on = true\n", { mode: 0o600 });
    env.XDG_CONFIG_HOME = join(f.env.HOME!, ".config");
    let starts = 0;
    const arm = (args: string[], snapshot: NodeJS.ProcessEnv) => armAlwaysOn(args, snapshot, () => { starts++; }, () => f.env.HOME);
    // The injected passwd home identifies this private config as the operator config.
    const deferred = deferAlwaysOn(["reply"], env, arm);
    env.TAP_HOME = join(f.root, "internally-selected-bus");
    deferred();
    expect(starts).toBe(1);
    env.TAP_INDEX_HOME = f.index;
    const callerPinned = deferAlwaysOn(["reply"], env, arm);
    callerPinned();
    expect(starts).toBe(1);
    expect(existsSync(join(f.index, "debug"))).toBe(false);
  } finally {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    rmSync(f.root, { recursive: true, force: true });
  }
});

for (const args of [
  ["remind", "me", "--in", "30m", "-f", "body.md"],
  ["remind", "peer", "--at", "1790000000", "-f", "body.md"],
  ["remind", "cancel", "reminder-id"], ["remind", "kill", "reminder-id"],
]) test(`reminder mutation can arm: ${args.join(" ")}`, () => {
  const f = fixture(true);
  try {
    let starts = 0;
    armAlwaysOn(args, f.env, () => { starts++; });
    expect(starts).toBe(1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const args of [["remind"], ["remind", "list"], ["remind", "list", "--json"]]) {
  test(`reminder read never arms: ${args.join(" ")}`, () => {
    const f = fixture(true);
    try {
      let starts = 0;
      armAlwaysOn(args, f.env, () => { starts++; });
      expect(starts).toBe(0);
      expect(existsSync(join(f.index, "debug"))).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

test("every allowlist row names a command in the public help grammar", async () => {
  const { HELP_COMPOSITES, lookupHelp } = await import("../src/help");
  const commands = readFileSync(resolve(import.meta.dir, "../src/debug-arm-commands.txt"), "utf8").trim().split("\n");
  for (const row of commands) {
    const [verb, sub] = row.split(" ");
    const page = lookupHelp([verb!]);
    expect(page.stdout.length, row).toBeGreaterThan(0);
    if (sub) {
      const accepted = HELP_COMPOSITES[verb!]?.includes(sub)
        ?? new RegExp(`^[ ]*tap ${verb} ${sub}([ ]|$)`, "m").test(page.stdout);
      expect(accepted, row).toBe(true);
    }
  }
});

for (const args of mutationModes) test(`public mutation remains eligible: ${args.join(" ")}`, () => { expect(mayArm(args)).toBe(true); });

for (const args of observationalModes) test(`public read or tombstone remains quiet: ${args.join(" ")}`, () => { expect(mayArm(args)).toBe(false); });
