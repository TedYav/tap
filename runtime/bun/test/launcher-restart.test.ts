import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { restartSession, type RestartDeps, type RestartOptions } from "../src/launcher/restart";
import { parseSessionDoor } from "../src/launcher/session-doors";
import { fixture, restoreEnvironment } from "./support/resume-harness";
import { writeLiveFence } from "./support/live-fence";
import { LauncherError } from "../src/launcher/types";

afterEach(restoreEnvironment);
const row = { status: "active", harness: "codex", delivery: "pane", session: "repo/seat", pane: "repo/seat:0.0", harness_session_id: "conversation", tag: "seat", index: 1 };
const opts = (patch: Partial<RestartOptions> = {}): RestartOptions => ({ key: "seat", force: false, dryRun: true, json: true, ...patch });
function world(extra: Record<string, unknown> = {}, siblings: Record<string, unknown> = {}) {
  return fixture({ registry: { schema: "0.20", team: { name: "repo" }, seats: { seat: { ...row, ...extra }, ...siblings } },
    tmux: [{ match: "*list-sessions*", stdout: "" }] });
}
function recorder(state = "idle-at-prompt") {
  const calls: unknown[] = [];
  const deps: RestartDeps = { live: async () => true, state: handle => { calls.push(["observe", handle]); return state; },
    run: async (record, live) => { calls.push(["run", record, live]); return 0; } };
  return { calls, deps };
}

test.each(["working", "blocked-on-approval", "rate-limited-error", "alert", "unknown"])("restart refuses %s before transaction", async state => {
  const f = world(), r = recorder(state);
  let error: unknown;
  try { await restartSession(opts(), f.root, r.deps); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(LauncherError);
  expect((error as LauncherError).errorClass).toBe("session_busy");
  expect((error as LauncherError).detail).toContain(`seat=${state}`);
  expect(r.calls).toEqual([["observe", "seat"]]);
  if (state === "rate-limited-error") expect((error as LauncherError).action).toContain("tap session relaunch repo/seat");
});

test("busy active sibling with only a pane spelling refuses the whole session", async () => {
  const f = world({}, { helper: { status: "active", harness: "claude", crew: true, pane: "repo/seat:0.1" } }), r = recorder();
  r.deps.state = handle => handle === "helper" ? "working" : "idle-at-prompt";
  await expect(restartSession(opts(), f.root, r.deps)).rejects.toThrow("helper=working");
  expect(r.calls).toEqual([]);
});

test("force skips only busy observation and replays the stored recipe", async () => {
  const f = world({ harness_env: { FEATURE: "stored" }, harness_tail: ["--literal"] }), r = recorder("unknown");
  expect(await restartSession(opts({ force: true }), f.root, r.deps)).toBe(0);
  expect(r.calls).toHaveLength(1);
  expect(r.calls[0]).toMatchObject(["run", { harness_session_id: "conversation", harness_env: { FEATURE: "stored" }, harness_tail: ["--literal"] }, true]);
});

test.each([{ status: "suspended", status_reason: "user_removed" }, { delivery: "poll" }, { crew: true }])("force never revives a nonmember %j", async patch => {
  const f = world(patch), r = recorder();
  await expect(restartSession(opts({ force: true }), f.root, r.deps)).rejects.toThrow("not found");
  expect(r.calls).toEqual([]);
});

test("force still refuses a reset fence before probes or transaction", async () => {
  const f = world(), r = recorder();
  writeLiveFence(join(f.root, ".tap/bus/reset.fence.json"));
  await expect(restartSession(opts({ force: true }), f.root, r.deps)).rejects.toThrow("mid-reset");
  expect([r.calls, f.tmuxCalls()]).toEqual([[], []]);
});

test("invalid resume recipe and duplicate conversation refuse before transaction", async () => {
  for (const bad of [true, false]) {
    const f = bad ? world() : world({}, { other: { ...row, session: "repo/other", tag: "other", pane: "repo/other:0.0" } });
    if (bad) {
      const config = join(f.root, "config"); mkdirSync(join(config, "tap"), { recursive: true });
      process.env.XDG_CONFIG_HOME = config;
      writeFileSync(join(config, "tap/config.toml"), '[harness.codex.env]\nHOME = "/wrong"\n', { mode: 0o600 });
    }
    const r = recorder();
    await expect(restartSession(opts({ force: true }), f.root, r.deps)).rejects.toThrow();
    expect(r.calls).toEqual([]);
    restoreEnvironment();
  }
});

test("a stale cursor chat refuses restart before any probe or transaction (tap-we6b rework)", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "tap-restart-cursor-"));
  process.env.TAP_CURSOR_HOME = scratch;
  try {
    const f = world({ harness: "cursor", harness_session_id: "019a1111-2222-7333-8444-555555555555" });
    const r = recorder();
    let error: unknown;
    try { await restartSession(opts({ force: true }), f.root, r.deps); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(LauncherError);
    expect((error as LauncherError).errorClass).toBe("no_exact_resume_identity");
    expect((error as LauncherError).action).toMatch(/^tap session launch cursor [^\s/]+ --fresh$/);
    expect((error as LauncherError).detail).toContain("never persisted");
    // No busy observation, no preflight invocation, no transaction run.
    expect(r.calls).toEqual([]);
  } finally {
    restoreEnvironment();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("an id-less cursor restart discloses that it starts a fresh conversation (tap-we6b)", async () => {
  const f = world({ harness: "cursor", harness_session_id: null }), r = recorder();
  const write = process.stderr.write.bind(process.stderr); let stderr = "";
  process.stderr.write = ((chunk: string) => { stderr += chunk; return true; }) as typeof process.stderr.write;
  try { expect(await restartSession(opts({ force: true }), f.root, r.deps)).toBe(0); }
  finally { process.stderr.write = write; }
  expect(stderr).toContain("has no native cursor chat id; starting a fresh conversation");
});

test("restart accepts exact handle/session but not a family selector", async () => {
  const f = world(), r = recorder();
  await expect(restartSession(opts({ key: "codex" }), f.root, r.deps)).rejects.toThrow("exact handle");
  expect(await restartSession(opts({ key: "repo/seat" }), f.root, r.deps)).toBe(0);
});

test("public resume/restart parser retains abbreviation and literal operand boundaries", () => {
  expect(parseSessionDoor("resume", ["--al", "--dry", "--j"])).toMatchObject({ all: true, dryRun: true, json: true });
  expect(parseSessionDoor("resume", ["--", "--all"])).toMatchObject({ all: false, key: "--all" });
  expect(parseSessionDoor("resume", ["codex", "seat"])).toMatchObject({ key: "codex", legacyName: "seat" });
  expect(parseSessionDoor("restart", ["--f", "--dry", "seat"])).toMatchObject({ force: true, key: "seat", dryRun: true });
  for (const arg of ["--env", "--model", "--preset", "--teams", "--json=no"]) expect(() => parseSessionDoor("restart", ["seat", arg])).toThrow();
  expect(() => parseSessionDoor("resume", ["--model", "x"])).toThrow();
});

test("successful restart hint excludes foreign and settled mail", async () => {
  const f = world(), r = recorder(), bus = join(f.root, ".tap/bus");
  mkdirSync(join(bus, "payloads"), { recursive: true }); mkdirSync(join(bus, "receipts"), { recursive: true });
  for (const [id, team] of [["a-legacy", ""], ["b-local", "repo"], ["c-foreign", "other"], ["d-done", "repo"]]) {
    writeFileSync(join(bus, "payloads", `${id}.md`), `---\nid: ${id}\nto: seat\nto_team: ${team}\n---\nbody\n`);
  }
  writeFileSync(join(bus, "receipts/d-done.done"), "done");
  const write = process.stderr.write.bind(process.stderr); let stderr = "";
  process.stderr.write = ((chunk: string) => { stderr += chunk; return true; }) as typeof process.stderr.write;
  try { expect(await restartSession(opts({ dryRun: false, json: false }), f.root, r.deps)).toBe(0); }
  finally { process.stderr.write = write; }
  expect(stderr).toContain("2 pending for seat: a-legacy, b-local");
  expect(stderr).not.toContain("c-foreign");
});

test("public router, shell transport and team up use native dry-run doors", () => {
  const f = world(), root = resolve(import.meta.dir, "../../..");
  const before = readFileSync(join(f.root, ".tap/bus/registry.json"), "utf8");
  const commands = [
    [process.execPath, join(root, "runtime/bun/src/launcher/session-doors.ts"), "restart", "seat", "--dry", "--json"],
    ["bash", join(root, "scripts/tap.sh"), "session", "restart", "seat", "--dry-run", "--json"],
    ["bash", join(root, "bin/tap"), "session", "resume", "seat", "--dry", "--json"],
    ["bash", join(root, "scripts/tap.sh"), "session", "resume", "--all", "--dry", "--json"],
    ["bash", join(root, "scripts/tap.sh"), "team", "up", "--only", "seat", "--dry", "--json"],
  ];
  for (const [command, ...args] of commands) {
    const result = spawnSync(command!, args, { cwd: f.root, env: process.env, encoding: "utf8", timeout: 15000 });
    expect({ command, args, code: result.status, stderr: result.stderr }).toMatchObject({ code: 0 });
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    if (args.includes("team")) expect(JSON.parse(result.stdout)).toMatchObject({ lifecycle_action: "up", mechanism: "team-up", registry_fate: "resume-rows", outcome: "would_resume" });
    expect(result.stderr).not.toContain("Traceback");
  }
  expect(readFileSync(join(f.root, ".tap/bus/registry.json"), "utf8")).toBe(before);
  expect(f.tmuxCalls().join("\n")).not.toMatch(/kill-session|new-session|respawn-pane/);
});

test.each([false, true])("native restart renders old_store code 1 (json=%s) without effects", json => {
  const f = world(); f.writeRegistry({ schema: "0.20", team: { name: "repo" }, agents: { seat: row } });
  const before = readFileSync(join(f.root, ".tap/bus/registry.json"), "utf8");
  const result = spawnSync(process.execPath, [resolve(import.meta.dir, "../src/launcher/session-doors.ts"), "restart", "seat", "--force", ...(json ? ["--json"] : [])],
    { cwd: f.root, env: process.env, encoding: "utf8" });
  expect(result.status).toBe(1);
  if (json) expect(JSON.parse(result.stdout).error_class).toBe("old_store");
  else expect(result.stderr).toContain("old TAP registry format");
  expect(readFileSync(join(f.root, ".tap/bus/registry.json"), "utf8")).toBe(before);
  expect(f.tmuxCalls()).toEqual([]);
});
