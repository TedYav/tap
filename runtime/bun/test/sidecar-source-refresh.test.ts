import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Ported from the retired smoke/sidecar-source-refresh.test.sh. The module-level
// refresh branches are unit-owned elsewhere (watch-run.test.ts drives makeRefresh
// with a recorder); what only a REAL process proves is the re-exec itself: the
// same PID survives process.execve, the lease identity it owns survives, and a
// bounded retry cadence is not reset. Acceptance for this file: a mutant that
// turns either loop's re-exec into a plain exit must go RED here.

const REPO_ROOT = join(import.meta.dir, "../../..");

const SCRATCH_ROOT = join(process.env.TMUX_TMPDIR ?? tmpdir(), "sidecar-refresh-");
const scratches: string[] = [];
afterEach(() => {
  while (scratches.length) rmSync(scratches.pop()!, { recursive: true, force: true });
});

function scratch(): string {
  const path = join(SCRATCH_ROOT, `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(path, { recursive: true });
  scratches.push(path);
  return path;
}

// The loops exec helper scripts out of skills/tap/scripts; give the copy the same.
function provisionScripts(work: string): void {
  const source = join(REPO_ROOT, "skills/tap/scripts");
  const scripts = join(work, "skills/tap/scripts");
  mkdirSync(scripts, { recursive: true });
  for (const name of readdirSync(source)) {
    if (name.endsWith(".sh")) cpSync(join(source, name), join(scripts, name));
  }
}

function copySrc(work: string): string {
  const src = join(work, "runtime/bun/src");
  cpSync(join(import.meta.dir, "../src"), src, { recursive: true });
  return src;
}

// The real compiled shim is covered by the stranger acceptance. Here a small
// executable shim exercises actual execve across version directories for all loops.
function sources(work: string, upgrade: boolean) {
  const old = upgrade ? join(work, "versions/v1") : work;
  provisionScripts(old);
  const src = copySrc(old);
  const release = (root: string, version: string) => {
    writeFileSync(join(root, "tap-release.json"), JSON.stringify({ schema: 1, version }));
    mkdirSync(join(root, "libexec/tap"), { recursive: true });
    const shim = join(root, "libexec/tap/bun");
    writeFileSync(shim, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`);
    chmodSync(shim, 0o755);
  };
  if (upgrade) { release(old, "v1"); symlinkSync("versions/v1", join(work, "current")); }
  return {
    src,
    next: () => {
      if (!upgrade) return src;
      const next = join(work, "versions/v2");
      cpSync(old, next, { recursive: true });
      release(next, "v2");
      return join(next, "runtime/bun/src");
    },
    activate: () => {
      if (!upgrade) return;
      symlinkSync("versions/v2", join(work, "next"));
      renameSync(join(work, "next"), join(work, "current"));
    },
  };
}

type Loop = ReturnType<typeof startLoop>;
function startLoop(work: string, entry: string, args: string[], env: NodeJS.ProcessEnv) {
  const log = join(work, "child.log");
  writeFileSync(log, "");
  // exec: the shell replaces itself with the loop, so proc.pid is the loop's
  // PID and re-exec keeps it — the same-PID observations need that identity.
  const output = Bun.spawn(["/bin/sh", "-c", `exec "${process.execPath}" "${entry}" ${args.map(a => `"${a}"`).join(" ")} >> "${log}" 2>&1`], {
    cwd: join(work, "repo"),
    // An inherited lease token would make a readiness-gate waiter believe it
    // owns an entry whose lease file does not exist in this scratch bus.
    env: { ...process.env, TAP_HOME: join(work, "repo", ".tap", "bus"), TAP_SPOOL_REOWN_TOKEN: undefined, ...env },
  });
  return {
    proc: output,
    log,
    text: () => readFileSync(log, "utf8"),
    stop: async () => {
      if (output.exitCode === null) {
        output.kill();
        await output.exited;
      }
    },
  };
}

async function until(predicate: () => boolean, message: string, loop: Loop, deadlineMs = 20_000): Promise<void> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (predicate()) return;
    if (loop.proc.exitCode !== null) break;
    await Bun.sleep(20);
  }
  throw new Error(`${message}\n${loop.text()}`);
}

async function exitsWith(loop: Loop, code: number, message: string): Promise<void> {
  const outcome = await Promise.race([loop.proc.exited, Bun.sleep(8000).then(() => "timeout" as const)]);
  if (outcome === "timeout") {
    await loop.stop();
    throw new Error(`${message}\n${loop.text()}`);
  }
  expect(outcome, message + "\n" + loop.text()).toBe(code);
}

function busOf(work: string): string {
  const bus = join(work, "repo", ".tap", "bus");
  mkdirSync(join(bus, "watch"), { recursive: true });
  writeFileSync(join(bus, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "fixture", worktree_root: join(work, "repo") }, seats: {} }));
  return bus;
}

for (const upgrade of [false, true]) test(`watch (${upgrade ? "release upgrade" : "source swap"}): same PID and lease survive; the new generation stays stable`, async () => {
  const work = scratch();
  const generation = sources(work, upgrade);
  let src = generation.src;
  const bus = busOf(work);
  const arm = join(bus, "watch", "arm.json");
  writeFileSync(arm, JSON.stringify({ mode: "supervision", armed_by: "fixture", armed_at: 17, tick_interval_seconds: 1, evaluator: "none" }) + "\n");
  const record = (): Record<string, unknown> => {
    try { return JSON.parse(readFileSync(arm, "utf8")); } catch { return {}; }
  };
  const loop = startLoop(work, join(src, "watch-run.ts"), ["run"], {});
  try {
    await until(() => record().watcher_pid === loop.proc.pid && record().watcher_command === "watch-run.ts run", "watch: no heartbeat from the Bun loop", loop);
    const first = record().heartbeat_at as number;
    // A stamped module changes: only a process that loaded the NEW bytes can print the marker.
    src = generation.next();
    appendFileSync(join(src, "watch-loop.ts"), '\nprocess.stderr.write("generation=new\\n");\n');
    generation.activate();
    await until(() => loop.text().includes("generation=new"), "watch: stale module survived source swap", loop);
    expect(loop.text()).toContain(upgrade ? "release-changed; re-exec" : "source-changed; re-exec");
    expect(loop.proc.exitCode).toBeNull();
    await until(() => (record().heartbeat_at as number) > first && record().watcher_pid === loop.proc.pid, "watch: no heartbeat from the re-exec'd loop", loop);
    expect(record().armed_at).toBe(17);
    expect(record().armed_by).toBe("fixture");
    await until(() => (record().heartbeat_at as number) > first + 1, "watch: new generation did not keep ticking", loop);
    expect(loop.text().match(/; re-exec:/g)).toHaveLength(1);
    // A stamped source deleted mid-life is a change: the loop re-execs, and the
    // new process, whose own list still names it, refuses at start, lease kept.
    rmSync(join(src, "watch-tick.ts"));
    await exitsWith(loop, 1, "watch: the loop did not end with the unreadable-source refusal");
    const text = loop.text();
    const reexec = text.indexOf("source-unreadable; re-exec");
    expect(reexec).toBeGreaterThanOrEqual(0);
    expect(reexec).toBeLessThan(text.indexOf("source-unreadable; refusing another iteration"));
    expect(existsSync(arm)).toBe(true);
  } finally { await loop.stop(); }
}, 40_000);

// The retired poll_read_atomicity contract (SIDECAR_REFRESH:entry_stamp)
// deterministically guarded exactly one thing: the goalie source-stamp must be
// published through atomicWrite, never an in-place write — an in-place stamp
// lets the re-exec arc observe torn contents and answer "changed" early. The
// scanner's shell poll model cannot carry a TS publisher, so the guard lives
// here as a source pin; the read side (oldStamp compare) also lives in this
// file's goalie arc.
test("the goalie source-stamp publisher stays atomic (retired scanner contract)", () => {
  const text = readFileSync(join(import.meta.dir, "../src/goalie-run.ts"), "utf8");
  expect(text).toContain('atomicWrite(ctx.bus.home + "/goalie/source-stamp", stampOf(files) + "\\n");');
  expect(text).not.toContain('writeFileSync(ctx.bus.home + "/goalie/source-stamp"');
});

for (const upgrade of [false, true]) test(`goalie (${upgrade ? "release upgrade" : "source swap"}): same PID and lease survive`, async () => {
  const work = scratch();
  const generation = sources(work, upgrade);
  const src = generation.src;
  const bus = busOf(work);
  mkdirSync(join(bus, "spool"), { recursive: true });
  const arm = join(bus, "goalie", "arm.json");
  mkdirSync(join(bus, "goalie"), { recursive: true });
  writeFileSync(arm, JSON.stringify({ armed_by: "fixture", armed_at: 17, tick_interval_seconds: 0.05, episode: { preserved: true } }));
  writeFileSync(join(bus, "spool", "message.md"), "body\n");
  writeFileSync(join(bus, "spool", "message.meta.json"), JSON.stringify({
    target: "peer", target_registry: join(bus, "registry.json"), to_team: "fixture",
    waiter_lifetime: "readiness-gate", deadline_epoch: Math.floor(Date.now() / 1000) + 90,
  }));
  const stamped = join(src, "goalie-tick.ts");
  // The first stamp must already see a marker; the rewrite below is what trips it.
  appendFileSync(stamped, "\n// source-refresh probe marker\n");
  const loop = startLoop(work, join(src, "goalie-run.ts"), ["run"], { TAP_GOALIE_READY_CMD: 'printf "[]"', TAP_SPOOL_DELIVERER_DELAYS: "0.05 0.05 0.05" });
  try {
    const entryStamp = join(bus, "goalie", "source-stamp");
    await until(() => existsSync(entryStamp), "goalie: no entry source-stamp", loop);
    const oldStamp = readFileSync(entryStamp, "utf8");
    // Pause the NEW generation before any lease read/write so fixture removal
    // cannot race a heartbeat republishing it.
    const tickEntry = "  const { home, registry, scriptsDir, doors } = input;";
    const updated = readFileSync(stamped, "utf8");
    expect(updated.split(tickEntry).length - 1).toBe(1);
    const next = generation.next();
    writeFileSync(join(next, "goalie-tick.ts"), updated.replace(tickEntry, `  fs.writeFileSync(input.home + "/new-tick", String(process.pid));\n  while (!fs.existsSync(input.home + "/release-new")) Bun.sleepSync(20);\n${tickEntry}`));
    generation.activate();
    writeFileSync(join(bus, "release-old"), "");
    // Causal proof: only the post-reexec process — which imported the changed
    // goalie-tick bytes — writes a DIFFERENT stamp.
    await until(() => existsSync(entryStamp) && readFileSync(entryStamp, "utf8") !== oldStamp, "goalie: stamped source swap did not re-exec", loop);
    await until(() => {
      try { return readFileSync(join(bus, "new-tick"), "utf8") === String(loop.proc.pid); } catch { return false; }
    }, "goalie: new tick did not reach its lease-removal barrier", loop);
    const post = JSON.parse(readFileSync(arm, "utf8"));
    expect(post.watcher_pid).toBe(loop.proc.pid);
    expect(post.armed_at).toBe(17);
    expect(loop.text().match(/; re-exec:/g)).toHaveLength(1);
    // The new renderer stays paused until removal is complete; otherwise goalie
    // can pass its lease check, lose the lease before reading interval, and
    // legitimately sleep the 60s default.
    rmSync(arm);
    rmSync(join(bus, "spool", "message.md"));
    writeFileSync(join(bus, "release-new"), "");
    await exitsWith(loop, 0, "goalie: did not exit after lease removal");
  } finally {
    writeFileSync(join(bus, "release-new"), "");
    await loop.stop();
  }
}, 40_000);

for (const upgrade of [false, true]) for (const bounded of [false, true]) test(`waiter (${upgrade ? "release upgrade" : "source swap"})${bounded ? " (bounded lifetime)" : ""}: same PID, lease and cadence survive`, async () => {
  const work = scratch();
  const generation = sources(work, upgrade);
  const src = generation.src;
  const bus = busOf(work);
  mkdirSync(join(bus, "spool"), { recursive: true });
  writeFileSync(join(bus, "spool", "message.md"), "body\n");
  writeFileSync(join(bus, "spool", "message.meta.json"), JSON.stringify({
    target: "peer", target_registry: join(bus, "registry.json"), to_team: "fixture",
    waiter_lifetime: bounded ? "" : "readiness-gate", deadline_epoch: Math.floor(Date.now() / 1000) + 90,
  }));
  const evidence = join(bus, "evidence");
  const engine = (version: string): string => {
    // The persistent waiter calls the native engine entrance; keep its real
    // scheduler/lease/refresh and script only the spawned CLI body.
    const body = `import {appendFileSync,existsSync} from "node:fs";\nif(import.meta.main) { const bus=process.env.TAP_HOME!;\nappendFileSync(bus+"/evidence", "${version} "+process.ppid+"\\n");\nwhile(!existsSync(bus+"/release-${version}")) await Bun.sleep(20); process.exit(0); }\n`;
    return body + readFileSync(join(REPO_ROOT, "runtime/bun/src/spool-engine.ts"), "utf8");
  };
  writeFileSync(join(src, "spool-engine.ts"), engine("old"));
  const loop = startLoop(work, join(src, "spool-waiter.ts"), ["message"], { TAP_SPOOL_DELIVERER_DELAYS: "0.05 0.05 0.05" });
  try {
    await until(() => {
      try { return readFileSync(evidence, "utf8") === `old ${loop.proc.pid}\n`; } catch { return false; }
    }, "waiter: no initial drain", loop);
    const lease = join(bus, "spool", "message.meta.json.reown");
    const token = bounded ? null : readFileSync(lease, "utf8");
    writeFileSync(join(generation.next(), "spool-engine.ts"), engine("new"));
    generation.activate();
    writeFileSync(join(bus, "release-old"), "");
    await until(() => {
      try { return readFileSync(evidence, "utf8").includes("new "); } catch { return false; }
    }, "waiter: stale library survived source swap", loop);
    const rows = readFileSync(evidence, "utf8").trim().split("\n");
    expect(new Set(rows.map(row => row.split(" ")[1]))).toEqual(new Set([String(loop.proc.pid)]));
    if (token !== null) expect(readFileSync(lease, "utf8")).toBe(token);
    expect(loop.text().match(/; re-exec:/g)).toHaveLength(1);
    if (bounded) {
      writeFileSync(join(bus, "release-new"), "");
      await exitsWith(loop, 0, "bounded waiter did not exit after release");
      expect(readFileSync(evidence, "utf8").trim().split("\n")).toHaveLength(3);
    } else {
      rmSync(join(bus, "spool", "message.md"));
      writeFileSync(join(bus, "release-new"), "");
      await exitsWith(loop, 0, "waiter did not exit after lease removal");
      expect(existsSync(lease)).toBe(false);
    }
  } finally {
    writeFileSync(join(bus, "release-old"), "");
    writeFileSync(join(bus, "release-new"), "");
    await loop.stop();
  }
}, 40_000);

// The runner parity door: the retired smoke drove `bun src/<entry>` from a
// copied tree; one direct compile keeps the entries loadable outside `bun test`.
test("the loop entries compile through the same runner bun", () => {
  for (const entry of ["watch-run.ts", "goalie-run.ts", "spool-waiter.ts"]) {
    const probe = spawnSync(process.execPath, ["-e", `await import(${JSON.stringify(join(REPO_ROOT, "runtime/bun/src", entry))}); process.exit(0)`], {
      encoding: "utf8", cwd: REPO_ROOT, timeout: 30_000,
    });
    expect(probe.status, probe.stderr).toBe(0);
  }
});
