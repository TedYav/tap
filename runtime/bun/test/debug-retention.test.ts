import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
// Namespace import: each defect reproduces red on its own before the fix exists.
import * as debug from "../src/debug";
import { collect, effects, status, type CollectorEffects, type Run } from "../src/debug";

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const events = (directory: string) => readdirSync(directory).filter(name => /^events(\.\d+)?\.jsonl$/.test(name)).sort()
  .flatMap(name => readFileSync(join(directory, name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
function fixture(id: string, maxMb = 1024) {
  const root = mkdtempSync(join(tmpdir(), "tap-debug-retention-")), home = join(root, "debug"), directory = join(home, id);
  mkdirSync(directory, { recursive: true });
  const env = { ...process.env, TAP_INDEX_HOME: root };
  const run: Run = { id, directory, socket: join(root, "private.sock"), config: { max_mb: maxMb } };
  writeFileSync(join(directory, "session.json"), JSON.stringify(run));
  writeFileSync(join(home, "enabled.json"), JSON.stringify(run));
  writeFileSync(join(home, "last.json"), JSON.stringify(run));
  return { root, home, directory, env, run, stop: () => writeFileSync(join(directory, "stop"), "") };
}
const quiet = (extra: Partial<CollectorEffects> = {}): CollectorEffects => ({ ...effects, server: async () => null, teamBuses: () => ({}), ...extra });

test("the recorder publishes readiness before optional artifact collection", async () => {
  const f = fixture("20260923T000000Z-00000001");
  let readyFirst: boolean | undefined;
  const io = quiet({ collectArtifacts: async () => {
    readyFirst ??= existsSync(join(f.directory, "status.json")) && read(join(f.directory, "status.json")).recording === true;
    f.stop();
  } });
  const fallback = setTimeout(f.stop, 3000);
  try { await collect(f.run, io, f.env); expect(readyFirst).toBe(true); }
  finally { clearTimeout(fallback); rmSync(f.root, { recursive: true, force: true }); }
});

test("on waits for the recorder's ready signal and reports failure only when the recorder exits", async () => {
  const f = fixture("20260923T000000Z-00000002");
  try {
    let exited = false, polls = 0;
    // Readiness arrives after many polls; no fixed deadline gives up first.
    await debug.awaitRecorder(f.directory, () => exited, async () => {
      if (++polls === 200) writeFileSync(join(f.directory, "status.json"), JSON.stringify({ recording: true, heartbeat: Date.now() / 1000 }));
    });
    expect(polls).toBe(200);
    rmSync(join(f.directory, "status.json"));
    writeFileSync(join(f.directory, "recorder.log"), "startup exploded\n");
    await expect(debug.awaitRecorder(f.directory, () => exited, async () => { exited = true; })).rejects.toThrow("startup exploded");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("on observes a real recorder that crashes before it is ready", async () => {
  const f = fixture("20260923T000000Z-00000007");
  const log = join(f.directory, "recorder.log");
  // The production spawn shape: detached, unref'd, output to recorder.log; a missing session crashes it.
  const { openSync, closeSync } = await import("node:fs");
  const fd = openSync(log, "a", 0o600);
  let exited = false;
  const child = spawn(process.execPath, [join(import.meta.dir, "../src/debug.ts"), "_collect", join(f.directory, "missing-session.json")],
    { detached: true, stdio: ["ignore", fd, fd], env: { ...f.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  child.once("exit", () => { exited = true; });
  await new Promise<void>((accept, reject) => { child.once("spawn", accept); child.once("error", reject); });
  child.unref(); closeSync(fd);
  const until = performance.now() + 10000;
  try {
    await expect(debug.awaitRecorder(f.directory, () => exited, async () => {
      if (performance.now() > until) throw new Error("recorder exit was never observed");
      await Bun.sleep(50);
    })).rejects.toThrow("recorder exited before it was ready");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 15000);

test("a journal at its storage budget rotates out the oldest segment and keeps recording", async () => {
  const f = fixture("20260923T000000Z-00000003", 1);
  writeFileSync(join(f.directory, "events.jsonl"), (JSON.stringify({ event: "old", pad: "x".repeat(200) }) + "\n").repeat(6000));
  let rotated = false;
  const io = quiet({ appendEvent: (run, event, fields) => {
    effects.appendEvent(run, event, fields);
    if (event === "capture.rotated") { rotated = true; f.stop(); }
  } });
  try {
    await collect(f.run, io, f.env);
    const journal = events(f.directory);
    expect(rotated).toBe(true);
    expect(journal.some(e => e.event === "capture.limit")).toBe(false);
    expect(journal.find(e => e.event === "capture.rotated")).toMatchObject({ dropped: ["events.000001.jsonl"] });
    expect(read(join(f.directory, "status.json")).stopped).toBeUndefined();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("artifact pressure rotates copied evidence and keeps recording until stopped", async () => {
  const f = fixture("20260923T000000Z-00000004", 1);
  mkdirSync(join(f.directory, "artifacts", "old"), { recursive: true });
  writeFileSync(join(f.directory, "artifacts/old/frame"), Buffer.alloc(2 * 1048576));
  let collected = false;
  const io = quiet({ collectArtifacts: async () => {
    expect(read(join(f.directory, "status.json")).recording).toBe(true);
    collected = true;
    f.stop();
  } });
  try {
    await collect(f.run, io, f.env);
    expect(collected).toBe(true);
    expect(existsSync(join(f.directory, "artifacts/old"))).toBe(false);
    expect(events(f.directory).find(e => e.event === "capture.rotated")?.dropped).toContain("artifacts/old");
    expect((await status(f.env)).state).toBe("off");
    expect(debug.debugAttention(f.env)).toBeNull();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("an operator stop is not a health concern", async () => {
  const f = fixture("20260923T000000Z-00000005");
  f.stop();
  try {
    await collect(f.run, quiet(), f.env);
    expect((await status(f.env)).state).toBe("off");
    expect(debug.debugAttention(f.env)).toBeNull();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a stale heartbeat reads unresponsive even while its recorded pid is alive", async () => {
  const f = fixture("20260923T000000Z-00000006");
  writeFileSync(join(f.directory, "status.json"), JSON.stringify({ recording: true, pid: process.pid, heartbeat: Date.now() / 1000 - 60 }));
  try {
    expect((await status(f.env)).state).toBe("unresponsive");
    expect(debug.debugAttention(f.env)).toMatchObject({ type: "debug-unresponsive" });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("an unreadable recovery record keeps every capture", async () => {
  const f = fixture("20260923T000000Z-0000000b");
  const old = join(f.home, "20260901T000000Z-00000001");
  mkdirSync(old); writeFileSync(join(old, "session.json"), JSON.stringify({ id: "20260901T000000Z-00000001" }));
  mkdirSync(join(f.home, "recovery", "recovery-00000000-0000-0000-0000-000000000002", "run.json"), { recursive: true });
  writeFileSync(join(f.home, "config.json"), JSON.stringify({ retain_mb: 1 }));
  rmSync(join(f.home, "enabled.json"));
  // The skip is announced on stderr. Capture it here: left on the runner's
  // stream, the product's "retention skipped" reads as an undeclared test skip.
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await debug.pruneCaptures(f.env)).toEqual([]);
    expect(existsSync(old)).toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toMatch(/^tap debug: retention skipped; .*run\.json is unreadable$/);
  } finally { error.mockRestore(); rmSync(f.root, { recursive: true, force: true }); }
});

test("retention keeps the newest captures within budget and every referenced or foreign directory", async () => {
  const f = fixture("20260923T000000Z-0000000a");
  const capture = (id: string, mib: number) => {
    const directory = join(f.home, id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "session.json"), JSON.stringify({ id, directory }));
    writeFileSync(join(directory, "events.jsonl"), Buffer.alloc(mib * 1048576));
  };
  // Newest first: 1 + 2 MiB (plus session records) fit a 4 MiB budget; the next 2 MiB does not.
  capture("20260922T000000Z-00000009", 1);
  capture("20260921T000000Z-00000008", 2);
  capture("20260920T000000Z-00000007", 2);
  capture("20260919T000000Z-00000006", 1);
  capture("20260918T000000Z-00000005", 1);
  const recovery = join(f.home, "recovery", "recovery-00000000-0000-0000-0000-000000000001");
  mkdirSync(recovery, { recursive: true });
  writeFileSync(join(recovery, "events.jsonl"), JSON.stringify({ evidence: join(f.home, "20260919T000000Z-00000006", "events.jsonl") }) + "\n");
  mkdirSync(join(f.home, "bootstrap")); writeFileSync(join(f.home, "bootstrap/events.jsonl"), Buffer.alloc(4 * 1048576));
  mkdirSync(join(f.home, "20260917T000000Z-00000004")); // no session: not a capture this rule owns
  writeFileSync(join(f.home, "config.json"), JSON.stringify({ max_mb: 1024, retain_mb: 4 }));
  rmSync(join(f.home, "enabled.json"));
  try {
    const pruned = (await debug.pruneCaptures(f.env)).map(p => p.id).sort();
    expect(pruned).toEqual(["20260918T000000Z-00000005", "20260920T000000Z-00000007"]);
    for (const kept of ["20260923T000000Z-0000000a", "20260922T000000Z-00000009", "20260921T000000Z-00000008", "20260919T000000Z-00000006", "bootstrap", "20260917T000000Z-00000004", "recovery"])
      expect(existsSync(join(f.home, kept))).toBe(true);
    for (const gone of pruned) expect(existsSync(join(f.home, gone))).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("retention counts private raw bytes and prunes them with their capture", async () => {
  const f = fixture("20260923T000000Z-0000000a"), id = "20260922T000000Z-00000009";
  const child = spawn("sh", ["-c", "exit 0"]);
  await new Promise<void>(done => child.once("exit", () => done()));
  const raw = join(f.home, ".raw", id), directory = join(f.home, id);
  mkdirSync(directory); writeFileSync(join(directory, "session.json"), JSON.stringify({ id }));
  mkdirSync(join(raw, "trace-0123456789ab"), { recursive: true });
  writeFileSync(join(raw, "owner.json"), JSON.stringify({ id, pid: child.pid }));
  writeFileSync(join(raw, "trace-0123456789ab/tmux-server-123.log"), Buffer.alloc(2 * 1048576));
  writeFileSync(join(f.home, "config.json"), JSON.stringify({ retain_mb: 1 }));
  rmSync(join(f.home, "enabled.json"));
  try {
    const pruned = await debug.pruneCaptures(f.env, async () => null);
    expect(pruned.map(p => p.id)).toEqual([id]);
    expect(pruned[0]!.bytes).toBeGreaterThan(2 * 1048576);
    expect(existsSync(directory)).toBe(false);
    expect(existsSync(raw)).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("orphan raw cleanup requires a dead collector and closed tmux descriptors", async () => {
  const f = fixture("20260923T000000Z-0000000a"), child = spawn("sh", ["-c", "exit 0"]);
  await new Promise<void>(done => child.once("exit", () => done()));
  const ids = ["20260922T000000Z-00000001", "20260922T000000Z-00000002", "20260922T000000Z-00000003", "20260922T000000Z-00000004", "20260922T000000Z-00000005"];
  for (const [i, id] of ids.entries()) {
    const raw = join(f.home, ".raw", id);
    mkdirSync(join(raw, "trace-0123456789ab"), { recursive: true });
    if (i !== 4) writeFileSync(join(raw, "owner.json"), JSON.stringify({ id, pid: i === 1 ? process.pid : child.pid }));
    writeFileSync(join(raw, `trace-0123456789ab/tmux-server-${123 + i}.log`), "secret raw evidence");
  }
  try {
    const pruned = await debug.pruneCaptures(f.env, async pid => {
      if (pid === 126) throw new Error("inspection unavailable");
      return pid === 125 ? { cwd: f.home, paths: [join(f.home, ".raw", ids[2]!, "trace-0123456789ab/tmux-server-125.log")] } : null;
    });
    expect(pruned.map(p => p.id)).toEqual([ids[0]!]);
    expect(existsSync(join(f.home, ".raw", ids[0]!))).toBe(false);
    for (const id of ids.slice(1)) expect(existsSync(join(f.home, ".raw", id))).toBe(true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("raw retention never follows a symlink to an unowned directory", async () => {
  const f = fixture("20260923T000000Z-0000000a"), id = "20260922T000000Z-00000001";
  const child = spawn("sh", ["-c", "exit 0"]);
  await new Promise<void>(done => child.once("exit", () => done()));
  const foreign = join(f.root, "foreign");
  mkdirSync(foreign);
  writeFileSync(join(foreign, "owner.json"), JSON.stringify({ id, pid: child.pid }));
  mkdirSync(join(f.home, ".raw")); symlinkSync(foreign, join(f.home, ".raw", id));
  try {
    expect(await debug.pruneCaptures(f.env, async () => null)).toEqual([]);
    expect(read(join(foreign, "owner.json"))).toMatchObject({ id });
    expect(existsSync(join(f.home, ".raw", id))).toBe(true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("rotation retains a recovery bundle whose existing children were updated", () => {
  const f = fixture("updated-artifacts", 1);
  const updated = join(f.directory, "artifacts", "updated"), stale = join(f.directory, "artifacts", "stale");
  for (const dir of [updated, stale]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.json"), Buffer.alloc(600 * 1024));
  }
  utimesSync(updated, 10, 10); utimesSync(join(updated, "run.json"), 30, 30);
  utimesSync(stale, 20, 20); utimesSync(join(stale, "run.json"), 20, 20);
  try {
    expect(debug.rotateJournal(f.run).dropped).toEqual(["artifacts/stale"]);
    expect(existsSync(join(updated, "run.json"))).toBe(true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("status identifies an active legacy recorder that still needs restarting", async () => {
  const f = fixture("legacy-running");
  Object.assign(f.run.config, { lifetime_hours: 12 });
  writeFileSync(join(f.home, "enabled.json"), JSON.stringify(f.run));
  writeFileSync(join(f.directory, "status.json"), JSON.stringify({ recording: true, heartbeat: Date.now() / 1000, mode: "basic" }));
  try {
    expect((await status(f.env)).restart_required).toBe(true);
    const result = await debug.command([process.execPath, join(import.meta.dir, "../src/debug.ts"), "status"], 3000, f.env);
    expect(result.stdout).toContain("Legacy recorder may still expire");
    expect(result.stdout).not.toContain("Recording until tap debug off");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
