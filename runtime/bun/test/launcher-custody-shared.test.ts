import { afterEach, expect, test } from "bun:test";
// tap-7t3ag: a launch is a registry mutation, not a structural cut. It holds
// reset custody SHARED across its whole transaction (harness start included),
// so an unrelated send or relaunch proceeds while a launch runs, teardown and
// restore still take EX and stay excluded, and an interactive verb that meets
// a structural EX holder auto-waits with a stderr line naming the holder
// before refusing. A pending (mid-restart) row refuses a send cleanly.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { acquirePathLock } from "../src/panelock";
import { acquireResetMutationLock } from "../src/reset";

const original = { ...process.env };
const repo = resolve(import.meta.dir, "../../..");
const realTmux = Bun.which("tmux")!;
const holderProbe = join(import.meta.dir, "support/reset-ex-holder.ts");
const waiterProbe = join(import.meta.dir, "support/reset-custody-waiter.ts");
const roots: string[] = [], sockets: string[] = [];

afterEach(() => {
  // Launcher modules retain process.env at import time; restore its keys without replacing it.
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  for (const socket of sockets.splice(0)) spawnSync(realTmux, ["-L", socket, "kill-server"], { stdio: "ignore" });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The launcher-new-live fixture shape: a fake harness on a private tmux
 * socket, a real SessionStart hook, and a real `new.ts` launch. */
function launchFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tap-custody-")));
  roots.push(root);
  const index = join(root, "index"), bus = join(root, ".tap/bus"), registry = join(root, ".tap/team-registry.json");
  for (const dir of [index, bus, join(root, ".config/tap"), join(root, "bin"), join(root, "real")]) mkdirSync(dir, { recursive: true });
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture", worktree_root: root }, seats: {} }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { fixture: { root, registry_location: registry } } }));
  const socket = `custody-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  sockets.push(socket);
  const env: NodeJS.ProcessEnv = { ...original, HOME: root, XDG_CONFIG_HOME: join(root, ".config"), TAP_INDEX_HOME: index,
    TAP_HOME: bus, TAP_TMUX_SOCKET: socket, TAP_LAUNCH_SHELL: "/bin/bash", SHELL: "/bin/bash", PATH: `${root}/bin:${original.PATH}` };
  for (const key of ["TMUX", "TMUX_PANE", "TAP_SELF", "TAP_TMUX_SOCKET_PATH", "TAP_SERVER_EPOCH", "TAP_BOOT_ID", "TAP_LOCK_DIR", "TAP_LAUNCHER", "TAP_JSON"]) delete env[key];
  writeFileSync(join(root, ".bash_profile"), `export PATH='${env.PATH}'\n`);
  writeFileSync(join(root, ".config/tap/config.toml"), 'version = 3\n[presets.testseat]\nharness = "claude"\n');
  if (process.platform === "linux") copyFileSync("/bin/sleep", join(root, "real/claude"));
  else symlinkSync("/bin/sleep", join(root, "real/claude"));
  writeFileSync(join(root, "bin/claude"), `#!/bin/bash
printf '%s\\n' "$@" > '${root}/argv'
sid=""; prev=""
for a in "$@"; do [ "$prev" = --session-id -o "$prev" = --resume ] && sid="$a"; prev="$a"; done
transcript='${root}/.claude/projects/fixture/'"$sid.jsonl"
mkdir -p "$(dirname "$transcript")"; : > "$transcript"
(
  for _ in $(seq 1 600); do grep -q '"active"' '${registry}' 2>/dev/null && break; sleep 0.02; done
  printf '{"hook_event_name":"SessionStart","source":"startup","session_id":"%s","transcript_path":"%s"}\\n' "$sid" "$transcript" \\
    | TAP_HOME= bun '${join(repo, "runtime/bun/src/session-start.ts")}' context "$PWD" >'${root}/hook.out' 2>'${root}/hook.err'
  echo $? > '${root}/hook.rc'
) &
export PATH='${root}/real':"$PATH"
exec '${root}/real/claude' 600
`);
  chmodSync(join(root, "bin/claude"), 0o755);
  return { root, bus, registry, env };
}

test("a parked launch holds SH custody: send proceeds, structural EX still excluded", async () => {
  const f = launchFixture();
  const barrier = join(f.root, "barrier");
  writeFileSync(`${barrier}.pre-mutation.release`, "");
  const child = Bun.spawn(["bun", join(repo, "runtime/bun/src/launcher/new.ts"), "testseat", "reviewer"], {
    cwd: f.root,
    env: { ...f.env, TAP_RESET_FENCE_TEST_BARRIER: barrier, TAP_SCRATCH_ONLY: "1" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  try {
    const deadline = Date.now() + 30_000;
    while (!existsSync(`${barrier}.holding-mutation-lock.reached`) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(`${barrier}.holding-mutation-lock.reached`)).toBe(true);
    // The launch now holds the reset lock across harness start. A send's SHARED
    // custody must succeed at once (tap-7t3ag: this refused under the old EX).
    const send = acquireResetMutationLock(f.bus, "tap send", undefined, "shared");
    send.release();
    // Structural cuts still take EX and stay excluded while any launch holds.
    const structural = acquirePathLock(join(f.bus, "reset.fence.json.lock"), 0, f.env, "exclusive");
    expect(structural).toBeNull();
    writeFileSync(`${barrier}.holding-mutation-lock.release`, "");
    const code = await child.exited;
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(f.registry, "utf8")).seats.reviewer.status).toBe("active");
  } finally {
    writeFileSync(`${barrier}.holding-mutation-lock.release`, "");
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}, 120_000);

function holder(bus: string, release: string) {
  return Bun.spawn(["bun", holderProbe, bus, release], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
}

function waiter(bus: string, maxWaitMs: number, lines: string) {
  return Bun.spawn(["bun", waiterProbe, bus, String(maxWaitMs), lines], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
}

/** Resolve once the holder child's EX is observable (a SHARED try-once fails). */
async function untilExHeld(lockPath: string) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const probe = acquirePathLock(lockPath, 0, process.env, "shared");
    if (probe) probe.release();
    else return;
    if (Date.now() >= deadline) throw new Error("holder never took EX");
    await Bun.sleep(20);
  }
}

test("an interactive verb waits out a structural EX holder, naming it, then proceeds", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tap-wait-"))); roots.push(root);
  const bus = join(root, "bus"); mkdirSync(bus, { recursive: true });
  const release = join(root, "release"), lines = join(root, "lines");
  const child = holder(bus, release);
  try {
    await untilExHeld(join(bus, "reset.fence.json.lock"));
    const waiting = waiter(bus, 10_000, lines);
    try {
      const deadline = Date.now() + 5_000;
      while (!(existsSync(lines) && readFileSync(lines, "utf8").trim() !== "") && Date.now() < deadline) await Bun.sleep(20);
      expect(readFileSync(lines, "utf8")).toContain("held by tap teardown (pid");
      writeFileSync(release, "");
      const code = await waiting.exited;
      expect(code).toBe(0);
      expect(await new Response(waiting.stdout).text()).toContain('"acquired":true');
    } finally {
      writeFileSync(release, "");
      if (waiting.exitCode === null) waiting.kill();
      await waiting.exited;
    }
  } finally {
    writeFileSync(release, "");
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}, 30_000);

test("the bounded refusal names the EX holder when the wait runs out", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tap-refuse-"))); roots.push(root);
  const bus = join(root, "bus"); mkdirSync(bus, { recursive: true });
  const release = join(root, "release"), lines = join(root, "lines");
  const child = holder(bus, release);
  try {
    await untilExHeld(join(bus, "reset.fence.json.lock"));
    const started = Date.now();
    const waiting = waiter(bus, 2_200, lines);
    const code = await waiting.exited;
    const report = JSON.parse(await new Response(waiting.stdout).text());
    expect(code).toBe(0);
    expect(report.acquired).toBe(false);
    expect(report.errorClass).toBe("reset_custody_busy");
    expect(report.action).toContain("a structural TAP operation holds the reset sidecar (tap teardown, pid");
    expect(Date.now() - started).toBeLessThan(10_000);
  } finally {
    writeFileSync(release, "");
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}, 30_000);

test("a published fence stays terminal: the waiter refuses as fenced, promptly", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tap-fenced-"))); roots.push(root);
  const bus = join(root, "bus"); mkdirSync(bus, { recursive: true });
  const release = join(root, "release"), lines = join(root, "lines");
  const child = holder(bus, release);
  try {
    await untilExHeld(join(bus, "reset.fence.json.lock"));
    writeFileSync(join(bus, "reset.fence.json"), JSON.stringify({ op: "team-reset", pid: 1, token: "t", phase: "checkpointing" }));
    const started = Date.now();
    const waiting = waiter(bus, 30_000, lines);
    await waiting.exited;
    const report = JSON.parse(await new Response(waiting.stdout).text());
    expect(report.acquired).toBe(false);
    expect(report.errorClass).toBe("team_reset_fenced");
    expect(Date.now() - started).toBeLessThan(10_000);
  } finally {
    writeFileSync(release, "");
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}, 30_000);

test("a send to a seat mid-restart (pending row) refuses cleanly, placing nothing", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tap-pending-"))); roots.push(root);
  const bus = join(root, ".tap/bus"), index = join(root, "index"), home = join(root, "home");
  for (const dir of [bus, index, home]) mkdirSync(dir, { recursive: true });
  const registry = join(root, ".tap/team-registry.json");
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "spec" }, seats: {
    sender: { status: "active", delivery: "pane", pane_id: "%1", pane: "spec/sender:0.0", session: "spec/sender", server_epoch: "srv:1:1", harness: "claude" },
    builder: { status: "pending", delivery: "pane", session: "spec/builder" } } }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { spec: { root, registry_location: registry, state: "registered" } } }));
  // A deterministic live-session census: no sessions at all.
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin/tmux"), "#!/bin/bash\ncase \"$*\" in *list-sessions*) exit 0;; esac\nexit 1\n");
  chmodSync(join(root, "bin/tmux"), 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TAP_INDEX_HOME: index, TAP_HOME: bus, TAP_SELF: "sender", TAP_JSON: "1",
    PATH: `${join(root, "bin")}:${process.env.PATH}` };
  for (const key of ["TMUX", "TMUX_PANE"]) delete env[key];
  // The exact window a parked restart creates: the row is a pending
  // reservation with no pane. The census filters it before the pane leg, so
  // the send refuses with the named, retryable seat_pending state — never an
  // unhandled error, and no payload is placed. This row has no registered_at,
  // so pendingExpired is false: the live "still launching" wording applies,
  // not the expired-reservation `tap team refresh` one.
  const run = spawnSync("bash", [join(repo, "bin/tap"), "send", "builder", "-m", "ping"], { cwd: root, env, encoding: "utf8", timeout: 15_000 });
  expect(run.status).toBe(1);
  expect(run.stdout + run.stderr).toContain("seat_pending");
  expect(run.stdout + run.stderr).toContain("wait for 'builder' to finish launching");
  expect(run.stdout + run.stderr).not.toContain("unknown_recipient");
  // The same window from the retirement side (tap-7t3ag): a launch holds SH
  // custody, so `tap out` can interleave with its pending reservation — plain
  // retirement must refuse the reservation by name, not delete the claim.
  const out = spawnSync("bash", [join(repo, "bin/tap"), "out", "builder"], { cwd: root, env, encoding: "utf8", timeout: 15_000 });
  expect(out.status).toBe(1);
  expect(out.stdout + out.stderr).toContain("seat_launching");
  expect(out.stdout + out.stderr).toContain("pending launch reservation");
  const row = JSON.parse(readFileSync(registry, "utf8")).seats.builder;
  expect(row.status).toBe("pending");
  // The stale reservation retires: its session is absent and the reservation
  // is older than the launcher's 60s window, so a crashed launch never
  // strands the handle (tap-7t3ag review round).
  const stale = new Date(Date.now() - 120_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const seeded = JSON.parse(readFileSync(registry, "utf8"));
  seeded.seats.builder.registered_at = stale;
  writeFileSync(registry, JSON.stringify(seeded));
  const retire = spawnSync("bash", [join(repo, "bin/tap"), "out", "builder"], { cwd: root, env, encoding: "utf8", timeout: 15_000 });
  expect(retire.status, retire.stdout + retire.stderr).toBe(0);
  expect(JSON.parse(readFileSync(registry, "utf8")).seats.builder).toBeUndefined();
});
