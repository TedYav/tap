// launcher/resume.ts, the single-seat resume command: lookup precedence,
// reattach, departed history, the occupied-roster refusal and the create
// fallback, ported from test_launcher.py when cmd_resume became a door.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DRAIN_KEY, LIBC_NAMES, openLibc } from "../src/launcher/prompt";
import { LauncherError } from "../src/config-error";
import { sessionAttachable } from "../src/launcher/resume";
import { fixture, options, recorder, restoreEnvironment, resume, type TmuxRule } from "./support/resume-harness";
import { liveFenceBytes, writeLiveFence } from "./support/live-fence";

const RESUME = resolve(import.meta.dir, "../src/launcher/resume.ts");

afterEach(restoreEnvironment);

test("a recordless resume refuses create when the roster occupies the handle", async () => {
  const world = fixture({ registry: { schema: "0.20", team: { name: "repo" },
    seats: { occupied: { status: "active", harness: "codex", session: "repo/occupied", pane: "", pane_id: "" } } } });
  const { events, deps } = recorder({ hasTty: true });
  const result = await resume(world.root, options({ key: "codex", legacyName: "occupied" }), deps);
  expect(result.error?.message).toContain("occupied on the roster");
  expect(result.error?.message).toContain("[k] fresh replacement");
  expect(result.error?.message).toContain("[n] suffixed sibling");
  expect(result.error?.message).toContain("tap session launch codex occupied");
  expect(events).toEqual([]);
});

test("a stale cursor chat refuses resume before any probe or transaction (tap-we6b rework)", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "tap-resume-cursor-"));
  process.env.TAP_CURSOR_HOME = scratch;
  try {
    const world = fixture({ registry: { schema: "0.20", team: { name: "repo" },
      seats: { cursorseat: { status: "active", harness: "cursor", delivery: "pane", session: "repo/cursorseat",
        pane: "repo/cursorseat:0.0", pane_id: "", harness_session_id: "019a1111-2222-7333-8444-555555555555",
        tag: "cursorseat", index: 1 } } } });
    const { events, deps } = recorder();
    const result = await resume(world.root, options({ key: "cursorseat" }), deps);
    expect(result.code).toBe(null);
    expect((result.error as LauncherError | null)?.errorClass).toBe("no_exact_resume_identity");
    expect(result.error?.message).toContain("no persisted conversation store");
    // The launch HANDLE, not the slash-bearing session name, or the recovery
    // would sanitize to a sibling instead of reclaiming the seat.
    expect((result.error as LauncherError | null)?.action).toBe("tap session launch cursor cursorseat --fresh");
    // The refusal precedes the launch transaction: no run, no registration —
    // nothing was reserved and no identity was captured. (Pane liveness probes
    // still run; they are read-only observations.)
    expect(events.filter(event => event[0] === "run" || event[0] === "register")).toEqual([]);
  } finally {
    restoreEnvironment();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a named resume reattaches a live registry row: register, then the resume attach tail", async () => {
  const world = fixture({
    registry: { schema: "0.20", team: { name: "repo" },
      seats: { sol: { status: "active", session: "repo/sol", harness: "codex", pane: "repo/sol:0.0", pane_id: "%42" } } },
    tmux: [{ match: "*has-session -t =repo/sol" }],
  });
  const { events, deps } = recorder({ hasTty: true });
  const result = await resume(world.root, options({ key: "sol" }), deps);
  expect(result.error).toBeNull();
  expect(result.code).toBe(0);
  expect(events).toEqual([["register", "repo/sol", "codex"], ["attach", "resume", "repo/sol"]]);
});

test("resume with no roster row offers the departed history restore, and refuses it without a terminal", async () => {
  const world = fixture({ registry: { schema: "0.20", team: { name: "repo" }, seats: {} } });
  world.writeHistory("opus.out-1.20260730T120000Z.json",
    { handle: "opus", instance: "opus|abc123def456", retired_at: "2026-07-30T12:00:00Z", retired_by: "out-1" });
  const { events, deps } = recorder({ hasTty: false });
  const result = await resume(world.root, options({ key: "opus" }), deps);
  const message = result.error?.message ?? "";
  expect(message).toContain("no active seat named opus");
  expect(message).toContain("1 departed in team-history");
  expect(message).toContain("tap in opus --list-history");
  expect(message).toContain("tap in opus --restore 'opus|abc123def456'");
  expect(events).toEqual([]);
});

test("only a present session that is not a bare shell is attachable; shells fall through to resume", async () => {
  const panes = (command: string, pid: string, attached: string) => `repo/sol:0.0\t%1\t${command}\t${pid}\t${attached}\n`;
  const cases: [string, TmuxRule[], boolean][] = [
    ["absent", [], false],
    ["unobservable panes read unknown", [{ match: "*has-session*" }], true],
    ["live harness", [{ match: "*has-session*" }, { match: "*list-panes*", stdout: panes("claude", "999999", "0") }], true],
    ["busy editor", [{ match: "*has-session*" }, { match: "*list-panes*", stdout: panes("vim", "999999", "0") }], true],
    ["unreadable shell pid reads busy", [{ match: "*has-session*" }, { match: "*list-panes*", stdout: panes("zsh", "notapid", "0") }], true],
    ["bare shell", [{ match: "*has-session*" }, { match: "*list-panes*", stdout: panes("zsh", "999999", "0") }], false],
    ["a human's attached shell", [{ match: "*has-session*" }, { match: "*list-panes*", stdout: panes("zsh", "999999", "1") }], false],
  ];
  for (const [label, tmux, expected] of cases) {
    fixture({ tmux });
    expect([label, await sessionAttachable("repo/sol")]).toEqual([label, expected]);
    restoreEnvironment();
  }
});

test("the resume attach tail detaches without a controlling terminal and never runs tmux", () => {
  const world = fixture();
  const script = `import { attachTailInProcess } from ${JSON.stringify(RESUME)};
process.exitCode = await attachTailInProcess("resume", { name: "repo/scout", harness: "claude", cwd: "/repo", base: "repo", tag: "scout", index: 1 });`;
  const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: process.env });
  expect([child.status, child.stdout, child.stderr]).toEqual([0,
    "tap session: repo/scout is running detached (no controlling terminal); next: from a foreground terminal, run tap attach repo/scout\n", ""]);
  expect(world.tmuxCalls()).toEqual([]);
});

// ---- the reset fence: at entry for every form, and again inside the adopted arm ----

const fencePath = (root: string) => join(root, ".tap/bus/reset.fence.json");
const midReset = (root: string) => `refusing session resume — team bus is mid-reset (fence at ${fencePath(root)}); next: tap team reset`;

test("a live reset fence refuses at entry, before any lookup, tmux probe or effect", async () => {
  const world = fixture({ registry: { schema: "0.20", team: { name: "repo" },
    seats: { sol: { status: "active", session: "repo/sol", harness: "codex", pane: "repo/sol:0.0", pane_id: "%42" } } },
    tmux: [{ match: "*has-session*" }] });
  writeLiveFence(fencePath(world.root));
  const { events, deps } = recorder({ hasTty: true });
  const result = await resume(world.root, options({ key: "sol" }), deps);
  expect(result.error?.message).toBe(midReset(world.root));
  expect([events, world.tmuxCalls()]).toEqual([[], []]);
});

test("a fence published after the entry guard refuses the adopted arm before it allocates or launches", async () => {
  // The bare-harness attach probe is the last step before the adopted arm.
  const world = fixture({ registry: { schema: "0.20", team: { name: "repo" }, seats: {} },
    tmux: [{ match: "*has-session -t =claude", run: `printf '%s' "$RESUME_TEST_FENCE_BYTES" > "$RESUME_TEST_FENCE"`, code: 1 }] });
  process.env.RESUME_TEST_FENCE = fencePath(world.root);
  process.env.RESUME_TEST_FENCE_BYTES = liveFenceBytes();
  const { events, deps } = recorder({ hasTty: true });
  const result = await resume(world.root, options({ key: "claude" }), deps);
  expect(result.error?.message).toBe(midReset(world.root));
  expect(events).toEqual([]);
  expect(world.tmuxCalls().some(call => call.startsWith("list-sessions"))).toBe(false);
});

test("the entry guard parks on the reset test barrier after the fence check", async () => {
  const world = fixture({ registry: { schema: "0.20", team: { name: "repo" }, seats: {} } });
  const barrier = join(world.root, "barrier");
  writeFileSync(`${barrier}.after-entry-guard.release`, "");
  process.env.TAP_RESET_FENCE_TEST_BARRIER = barrier;
  process.env.TAP_SCRATCH_ONLY = world.root;
  const { deps } = recorder();
  await resume(world.root, options({ key: "nobody" }), deps);
  expect(existsSync(`${barrier}.after-entry-guard.reached`)).toBe(true);
});

// ---- the trace capsule: the door's open operation, joined and finished by resume.ts ----

function entry(capsule: string | undefined) {
  const world = fixture({ registry: { schema: "0.20", team: { name: "repo" }, seats: {} },
    tmux: [{ match: "*has-session*", run: `env > "$RESUME_TEST_ENV"`, code: 1 }] });
  const seen = join(world.root, "tmux-env");
  const childEnv: NodeJS.ProcessEnv = { ...process.env, RESUME_TEST_ENV: seen };
  if (capsule !== undefined) childEnv.TAP_STARTUP_TRACE_CONTEXT = capsule;
  const run = spawnSync(process.execPath, [RESUME, "--", "nobody"], { cwd: world.root, encoding: "utf8", env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
  const log = join(process.env.TAP_INDEX_HOME!, "logs", "startup.jsonl");
  const events = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>) : [];
  return { run, events, tmuxEnv: readFileSync(seen, "utf8") };
}

test("an active capsule joins the door's operation and finishes it with the real code; no child sees it", () => {
  const { run, events, tmuxEnv } = entry(JSON.stringify({ fields: { operation_id: "op-door", verb: "resume" }, active: true }));
  expect(run.status, run.stderr).toBe(2);
  expect(tmuxEnv).not.toContain("TAP_STARTUP_TRACE_CONTEXT");
  expect(events.map(e => e.event)).not.toContain("launch_start");
  expect(events.every(e => e.operation_id === "op-door")).toBe(true);
  expect(events.at(-1)).toMatchObject({ event: "launch_failure", exit_code: 2, operation_id: "op-door", verb: "resume" });
});

test("an inactive or unusable capsule leaves the operation untraced, as the incumbent did", () => {
  for (const capsule of [JSON.stringify({ fields: { operation_id: "op-door" }, active: false }), "", "not json"]) {
    const { run, events, tmuxEnv } = entry(capsule);
    expect([capsule, run.status, events]).toEqual([capsule, 2, []]);
    expect(tmuxEnv).not.toContain("TAP_STARTUP_TRACE_CONTEXT");
    restoreEnvironment();
  }
});

test("a direct entry with no capsule traces its own operation from launch_start to its finish", () => {
  const { run, events } = entry(undefined);
  expect(run.status, run.stderr).toBe(2);
  expect(events[0]).toMatchObject({ event: "launch_start", verb: "resume", target: "nobody" });
  expect(events.at(-1)).toMatchObject({ event: "launch_failure", exit_code: 2, operation_id: events[0]!.operation_id });
});

test("the failed-row scan probes every other row before the ladder goes on, as the incumbent did", async () => {
  // `sol` is an ordinarily relaunchable row: the filters alone would skip it.
  // The incumbent probed its session first, so a failing probe failed the
  // resume before the ladder's own attach probe; the call order pins that.
  const world = fixture({ registry: { schema: "0.20", team: { name: "repo" },
    seats: { sol: { status: "active", session: "repo/sol", harness: "codex", pane: "repo/sol:0.0", pane_id: "%42" } } } });
  const { events, deps } = recorder({ hasTty: true });
  await resume(world.root, options({ key: "ghost" }), deps);
  const calls = world.tmuxCalls();
  const probe = calls.findIndex(call => call.includes("-t %42"));
  const ladder = calls.findIndex(call => call.includes("has-session -t =ghost"));
  expect(probe, calls.join("\n")).toBeGreaterThanOrEqual(0);
  expect(probe, calls.join("\n")).toBeLessThan(ladder);
  expect(events).toEqual([]);
});

test("a command that cannot be found is named, as FileNotFoundError.filename was", () => {
  const world = fixture({ registry: { schema: "0.20", team: { name: "repo" }, seats: {} } });
  const empty = join(world.root, "empty-bin");
  mkdirSync(empty);
  const run = spawnSync(process.execPath, [RESUME, "--", "nobody"], { cwd: world.root, encoding: "utf8", env: { ...process.env, PATH: empty } });
  expect([run.status, run.stderr]).toEqual([127, "tap session: missing command: tmux\n"]);
});

test("libc opens under the next name when one is absent (musl ships libc.so, not libc.so.6)", () => {
  const symbols = { getpgrp: { args: [], returns: "i32" } } as const;
  const libc = openLibc(symbols, ["/nonexistent/libc.so.6", ...LIBC_NAMES]);
  try { expect(libc.symbols.getpgrp()).toBeGreaterThan(0); }
  finally { libc.close(); }
  expect(() => openLibc(symbols, ["/nonexistent/libc.so.6", "/nonexistent/libc.so"])).toThrow();
});

test("the Esc drain restores the saved mode on an interrupt, like the key read", () => {
  expect(DRAIN_KEY.startsWith(`trap 'stty "$1"; exit 130' INT TERM; trap 'stty "$1"; exit 131' QUIT; `)).toBe(true);
});
