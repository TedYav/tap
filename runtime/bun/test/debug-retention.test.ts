import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
// Namespace import: each defect reproduces red on its own before the fix exists.
import * as debug from "../src/debug";
import { writeDebugConfig } from "../src/debug-config";
import { collect, effects, status, type CollectorEffects, type Run } from "../src/debug";

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const events = (directory: string) => readdirSync(directory).filter(name => /^events(\.\d+)?\.jsonl$/.test(name)).sort()
  .flatMap(name => readFileSync(join(directory, name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
function fixture(id: string, maxMb = 1024) {
  const root = mkdtempSync(join(tmpdir(), "tap-debug-retention-")), home = join(root, "debug"), directory = join(home, id);
  mkdirSync(directory, { recursive: true });
  const env = { ...process.env, TAP_INDEX_HOME: root, XDG_CONFIG_HOME: join(root, "config") };
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
    expect(journal.find(e => e.event === "capture.rotated")).toMatchObject({ archived: ["events.000001.jsonl"], dropped: [], archive: join(f.home, "archive", f.run.id) });
    expect(existsSync(join(f.home, "archive", f.run.id, "events.000001.jsonl.zst"))).toBe(true);
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
    expect(events(f.directory).find(e => e.event === "capture.rotated")?.archived).toContain("artifacts/old");
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
  writeDebugConfig({ retain_mb: 1 }, f.env);
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
  writeDebugConfig({ max_mb: 1024, retain_mb: 4 }, f.env);
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
  writeDebugConfig({ retain_mb: 1 }, f.env);
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
    expect(debug.rotateJournal(f.run).archived).toEqual(["artifacts/stale"]);
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

// Journal-shaped bytes that are not trivially repetitive.
const journalBytes = (bytes: number) => {
  const lines: string[] = [];
  for (let size = 0; size < bytes;) {
    const line = JSON.stringify({ schema: 1, event: "tap.delivery", detail: `ts=${size} id=${randomBytes(12).toString("hex")}` }) + "\n";
    lines.push(line); size += line.length;
  }
  return Buffer.from(lines.join(""));
};
const unzst = (path: string) => Buffer.from(Bun.zstdDecompressSync(readFileSync(path)));
const staging = (directory: string): string[] => readdirSync(directory, { recursive: true, encoding: "utf8" }).filter(name => /\.tap\.[^/]*\.tmp$/.test(name));

test("rotation compresses the oldest segment and artifact bundle into the archive instead of deleting them", () => {
  const f = fixture("20260923T000000Z-0000000c", 8), archive = join(f.home, "archive", f.run.id);
  // Above 8 MiB the segment spans two zstd frames; zstd -dc and Bun read them as one stream.
  const segment = journalBytes(9 * 1048576), frame = randomBytes(1048576), meta = Buffer.from('{"stage":"verify"}\n');
  writeFileSync(join(f.directory, "events.jsonl"), segment);
  mkdirSync(join(f.directory, "artifacts", "bundle"), { recursive: true });
  writeFileSync(join(f.directory, "artifacts/bundle/frame"), frame); writeFileSync(join(f.directory, "artifacts/bundle/meta.json"), meta);
  writeFileSync(join(f.directory, "artifacts/loose"), Buffer.alloc(512 * 1024));
  utimesSync(join(f.directory, "artifacts/bundle/frame"), 5, 5); utimesSync(join(f.directory, "artifacts/bundle/meta.json"), 5, 5); utimesSync(join(f.directory, "artifacts/bundle"), 5, 5);
  utimesSync(join(f.directory, "events.jsonl"), 10, 10);
  try {
    const result = debug.rotateJournal(f.run);
    expect(result.archived).toEqual(["artifacts/bundle", "events.000001.jsonl"]);
    expect(result.dropped).toEqual([]);
    expect(unzst(join(archive, "events.000001.jsonl.zst")).equals(segment)).toBe(true);
    expect(unzst(join(archive, "artifacts/bundle/frame.zst")).equals(frame)).toBe(true);
    expect(unzst(join(archive, "artifacts/bundle/meta.json.zst")).equals(meta)).toBe(true);
    expect(existsSync(join(f.directory, "events.000001.jsonl"))).toBe(false);
    expect(existsSync(join(f.directory, "artifacts/bundle"))).toBe(false);
    expect(existsSync(join(f.directory, "artifacts/loose"))).toBe(true); // under budget again: the newest stays in place
    expect(staging(archive)).toEqual([]);
    expect(events(f.directory).find(e => e.event === "capture.rotated")).toMatchObject({ archived: result.archived, dropped: [], archive });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a failed archive still rotates within budget and journals capture.archive_failed", () => {
  const f = fixture("20260923T000000Z-0000000d", 1);
  writeFileSync(join(f.directory, "events.jsonl"), journalBytes(1.5 * 1048576));
  writeFileSync(join(f.home, "archive"), "not a directory"); // the archive cannot be created
  try {
    const result = debug.rotateJournal(f.run);
    expect(result).toMatchObject({ archived: [], dropped: ["events.000001.jsonl"] });
    expect(existsSync(join(f.directory, "events.000001.jsonl"))).toBe(false);
    const journal = events(f.directory);
    expect(journal.find(e => e.event === "capture.archive_failed")).toMatchObject({ source: "events.000001.jsonl", archive: join(f.home, "archive", f.run.id) });
    expect(journal.find(e => e.event === "capture.archive_failed")?.reason).toBeTruthy();
    expect(journal.find(e => e.event === "capture.rotated")).toMatchObject({ archived: [], dropped: ["events.000001.jsonl"] });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("rotation past archive_mb removes the oldest capture archives and keeps its own", () => {
  const f = fixture("20260923T000000Z-0000000e", 1), archive = join(f.home, "archive");
  f.run.config.archive_mb = 2;
  const seed = (id: string, mib: number) => { mkdirSync(join(archive, id), { recursive: true }); writeFileSync(join(archive, id, "events.jsonl.zst"), randomBytes(mib * 1048576)); };
  seed("20260901T000000Z-00000001", 1); seed("20260902T000000Z-00000002", 1);
  seed("notes", 0.25); // not a capture archive: never removed
  writeFileSync(join(f.directory, "events.jsonl"), journalBytes(1.5 * 1048576));
  try {
    expect(debug.rotateJournal(f.run).archived).toEqual(["events.000001.jsonl"]);
    expect(existsSync(join(archive, "20260901T000000Z-00000001"))).toBe(false);
    for (const kept of ["20260902T000000Z-00000002", "notes", f.run.id]) expect(existsSync(join(archive, kept))).toBe(true);
    expect(events(f.directory).find(e => e.event === "capture.archive_pruned")).toMatchObject({ removed: [{ id: "20260901T000000Z-00000001" }], archive_mb: 2 });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const sanitized of [true, false]) test(`retention archives a ${sanitized ? "sanitized" : "legacy"} capture before removing it, never its raw files`, async () => {
  const f = fixture("20260923T000000Z-0000000a"), id = "20260922T000000Z-00000009", directory = join(f.home, id), archive = join(f.home, "archive", id);
  const child = spawn("sh", ["-c", "exit 0"]);
  await new Promise<void>(done => child.once("exit", () => done()));
  const journal: Record<string, Buffer> = {
    "events.000002.jsonl": journalBytes(2 * 1048576), "events.jsonl": Buffer.alloc(0),
    "session.json": Buffer.from(JSON.stringify({ id, directory, ...(sanitized ? { redaction: "credentials-v1" } : {}) })),
    "status.json": Buffer.from('{"recording":false}'), "recovery-artifacts.json": Buffer.from("{}"),
  };
  // Redacted copies: artifact bundles and loose files, and a published trace with its status.
  const copies: Record<string, Buffer> = {
    "artifacts/0123456789abcdef0123/frame.frame": randomBytes(4096), "artifacts/0123456789abcdef0123/frame.json": Buffer.from('{"stage":"verify"}'),
    "artifacts/loose": Buffer.from("copied evidence"),
    "trace-0123456789ab/tmux-server-123.log": journalBytes(64 * 1024), "trace-0123456789ab/status.json": Buffer.from('{"active":false}'),
  };
  for (const [name, bytes] of Object.entries({ ...journal, ...copies })) { mkdirSync(join(directory, name, ".."), { recursive: true }); writeFileSync(join(directory, name), bytes); }
  const raw = join(f.home, ".raw", id);
  mkdirSync(join(raw, "trace-0123456789ab"), { recursive: true });
  writeFileSync(join(raw, "owner.json"), JSON.stringify({ id, pid: child.pid }));
  writeFileSync(join(raw, "trace-0123456789ab/tmux-server-123.log"), "TOKEN=unredacted raw capture\n");
  writeDebugConfig({ retain_mb: 1 }, f.env);
  rmSync(join(f.home, "enabled.json"));
  try {
    const pruned = await debug.pruneCaptures(f.env, async () => null);
    expect(pruned).toEqual([{ id, bytes: expect.any(Number), archive }]);
    expect(existsSync(directory)).toBe(false);
    expect(existsSync(raw)).toBe(false);
    // A capture recorded without the sanitizer keeps its unverified copies out of the archive.
    const archived = sanitized ? { ...journal, ...copies } : journal;
    const files = readdirSync(archive, { recursive: true, encoding: "utf8" }).filter(name => statSync(join(archive, name)).isFile()).sort();
    expect(files).toEqual(Object.keys(archived).map(name => name + ".zst").sort());
    for (const [name, bytes] of Object.entries(archived)) expect(unzst(join(archive, name + ".zst")).equals(bytes)).toBe(true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("retention prunes a capture it cannot archive and says so", async () => {
  const f = fixture("20260923T000000Z-0000000a"), id = "20260922T000000Z-00000009", directory = join(f.home, id);
  mkdirSync(directory); writeFileSync(join(directory, "session.json"), JSON.stringify({ id })); writeFileSync(join(directory, "events.jsonl"), Buffer.alloc(2 * 1048576));
  writeDebugConfig({ retain_mb: 1 }, f.env);
  writeFileSync(join(f.home, "archive"), "not a directory");
  rmSync(join(f.home, "enabled.json"));
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    const pruned = await debug.pruneCaptures(f.env, async () => null);
    expect(pruned).toMatchObject([{ id }]);
    expect(pruned[0]!.archive_error).toBeTruthy();
    expect(existsSync(directory)).toBe(false);
    expect(String(error.mock.calls[0]?.[0])).toContain(`could not archive ${id}`);
  } finally { error.mockRestore(); rmSync(f.root, { recursive: true, force: true }); }
});

test("retention past debug.archive_mb removes oldest capture archives and never the newest", async () => {
  const f = fixture("20260923T000000Z-0000000a"), archive = join(f.home, "archive"), id = "20260910T000000Z-00000005";
  writeDebugConfig({ retain_mb: 1, archive_mb: 1 }, f.env);
  for (const [old, mib] of [["20260901T000000Z-00000001", 1], ["20260920T000000Z-00000009", 2]] as const) {
    mkdirSync(join(archive, old), { recursive: true }); writeFileSync(join(archive, old, "events.jsonl.zst"), randomBytes(mib * 1048576));
  }
  const directory = join(f.home, id);
  mkdirSync(directory); writeFileSync(join(directory, "session.json"), JSON.stringify({ id })); writeFileSync(join(directory, "events.jsonl"), journalBytes(2 * 1048576));
  rmSync(join(f.home, "enabled.json"));
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect((await debug.pruneCaptures(f.env, async () => null)).map(p => p.id)).toEqual([id]);
    // Oldest first, including the archive just written; the newest stays even alone over the cap.
    expect(readdirSync(archive)).toEqual(["20260920T000000Z-00000009"]);
    expect(String(error.mock.calls[0]?.[0])).toContain("removed 2 oldest capture archive(s)");
  } finally { error.mockRestore(); rmSync(f.root, { recursive: true, force: true }); }
});

test("tap debug config stores archive_mb in [debug] of config.toml and refuses an invalid stored value", async () => {
  const f = fixture("20260923T000000Z-0000000f"), file = join(f.env.XDG_CONFIG_HOME, "tap", "config.toml");
  mkdirSync(join(f.env.XDG_CONFIG_HOME, "tap"), { recursive: true, mode: 0o700 });
  writeFileSync(file, "# operator notes\n[sentinel]\npreview = true\n", { mode: 0o600 });
  const cli = (...args: string[]) => debug.command([process.execPath, join(import.meta.dir, "../src/debug.ts"), ...args], 5000, f.env);
  try {
    const set = await cli("config", "--archive-mb", "4096", "--json");
    expect(set.code, set.stderr).toBe(0);
    expect(JSON.parse(set.stdout)).toMatchObject({ archive_mb: 4096, applies: "next capture" });
    expect(readFileSync(file, "utf8")).toStartWith("# operator notes\n[sentinel]\npreview = true\n");
    expect(Bun.TOML.parse(readFileSync(file, "utf8"))).toMatchObject({ sentinel: { preview: true }, debug: { archive_mb: 4096 } });
    expect(JSON.parse((await cli("config", "--json")).stdout)).toMatchObject({ max_mb: 1024, retain_mb: 2048, archive_mb: 4096 });
    writeFileSync(file, "[debug]\narchive_mb = 0\n", { mode: 0o600 });
    const invalid = await cli("config", "--json");
    expect(invalid.code).toBe(1);
    expect(JSON.parse(invalid.stdout)).toMatchObject({ ok: false, error_class: "debug_config_invalid" });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("successive rotations never reuse an archived segment name", () => {
  const f = fixture("20260923T000000Z-00000010", 1), archive = join(f.home, "archive", f.run.id);
  const first = journalBytes(1.5 * 1048576), second = journalBytes(1.5 * 1048576);
  try {
    writeFileSync(join(f.directory, "events.jsonl"), first);
    expect(debug.rotateJournal(f.run).archived).toEqual(["events.000001.jsonl"]);
    // Every closed segment is archived now; the next one still takes a new number.
    writeFileSync(join(f.directory, "events.jsonl"), second);
    expect(debug.rotateJournal(f.run).archived).toEqual(["events.000002.jsonl"]);
    expect(unzst(join(archive, "events.000001.jsonl.zst")).equals(first)).toBe(true);
    expect(unzst(join(archive, "events.000002.jsonl.zst")).equals(second)).toBe(true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("an archive write never replaces an existing archived file", () => {
  const f = fixture("20260923T000000Z-00000011", 1), archive = join(f.home, "archive", f.run.id), loose = randomBytes(1.5 * 1048576);
  mkdirSync(join(archive, "artifacts"), { recursive: true });
  writeFileSync(join(archive, "artifacts/loose.zst"), "earlier archive");
  mkdirSync(join(f.directory, "artifacts")); writeFileSync(join(f.directory, "artifacts/loose"), loose);
  try {
    expect(debug.rotateJournal(f.run).archived).toEqual(["artifacts/loose"]);
    expect(readFileSync(join(archive, "artifacts/loose.zst"), "utf8")).toBe("earlier archive");
    expect(unzst(join(archive, "artifacts/loose.1.zst")).equals(loose)).toBe(true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("rotation streams each frame to disk and keeps the recorder heartbeat fresh while it compresses", () => {
  const f = fixture("20260923T000000Z-00000012", 8), archive = join(f.home, "archive", f.run.id), statusPath = join(f.directory, "status.json");
  const segment = journalBytes(9 * 1048576), stale = Date.now() / 1000 - 60;
  writeFileSync(join(f.directory, "events.jsonl"), segment);
  writeFileSync(statusPath, JSON.stringify({ recording: true, pid: process.pid, heartbeat: stale, mode: "basic" }));
  const compress = Bun.zstdCompressSync, seen: { heartbeat: number; staged: number }[] = [];
  let calls = 0;
  // A slow first frame stands in for a large file; each later frame observes what the earlier ones left behind.
  (Bun as any).zstdCompressSync = (data: Buffer, options?: { level?: number }) => {
    if (calls++ === 0) Bun.sleepSync(2100);
    else seen.push({ heartbeat: read(statusPath).heartbeat, staged: staging(archive).reduce((sum, name) => sum + statSync(join(archive, name)).size, 0) });
    return compress(data, options);
  };
  try {
    expect(debug.rotateJournal(f.run).archived).toEqual(["events.000001.jsonl"]);
    expect(seen.length).toBe(1);
    expect(seen[0]!.heartbeat).toBeGreaterThan(stale + 30); // refreshed after the slow frame, before the file finished
    expect(seen[0]!.staged).toBeGreaterThan(0); // the first frame was already on disk, not held in memory
    expect(read(statusPath)).toMatchObject({ recording: true, pid: process.pid, mode: "basic" });
    expect(unzst(join(archive, "events.000001.jsonl.zst")).equals(segment)).toBe(true);
  } finally { (Bun as any).zstdCompressSync = compress; rmSync(f.root, { recursive: true, force: true }); }
});

test("a stop request during compression leaves the source in place and no partial archive", () => {
  const f = fixture("20260923T000000Z-00000013", 8), archive = join(f.home, "archive", f.run.id);
  writeFileSync(join(f.directory, "events.jsonl"), journalBytes(9 * 1048576));
  f.stop();
  try {
    expect(debug.rotateJournal(f.run)).toMatchObject({ archived: [], dropped: [] });
    expect(existsSync(join(f.directory, "events.000001.jsonl"))).toBe(true);
    expect(existsSync(join(archive, "events.000001.jsonl.zst"))).toBe(false);
    expect(staging(archive)).toEqual([]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("rotation applies archive_mb even when its archive attempt failed", () => {
  const f = fixture("20260923T000000Z-00000014", 1), archive = join(f.home, "archive");
  f.run.config.archive_mb = 1;
  mkdirSync(join(archive, "20260901T000000Z-00000001"), { recursive: true });
  writeFileSync(join(archive, "20260901T000000Z-00000001/events.jsonl.zst"), randomBytes(2 * 1048576));
  // A file where the bundle's directory belongs fails this attempt.
  mkdirSync(join(archive, f.run.id, "artifacts"), { recursive: true });
  writeFileSync(join(archive, f.run.id, "artifacts/bundle"), "in the way");
  mkdirSync(join(f.directory, "artifacts/bundle"), { recursive: true });
  writeFileSync(join(f.directory, "artifacts/bundle/frame"), randomBytes(1.5 * 1048576));
  try {
    expect(debug.rotateJournal(f.run)).toMatchObject({ archived: [], dropped: ["artifacts/bundle"] });
    expect(existsSync(join(archive, "20260901T000000Z-00000001"))).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("retention stays within archive_mb across repeated partial archive failures", async () => {
  const f = fixture("20260923T000000Z-0000000a"), archive = join(f.home, "archive");
  const ids = ["20260920T000000Z-00000001", "20260921T000000Z-00000002", "20260922T000000Z-00000003"];
  for (const id of ids) {
    const directory = join(f.home, id);
    mkdirSync(join(directory, "artifacts"), { recursive: true });
    writeFileSync(join(directory, "session.json"), JSON.stringify({ id, redaction: "credentials-v1" }));
    writeFileSync(join(directory, "events.000001.jsonl"), randomBytes(1048576));
    writeFileSync(join(directory, "artifacts/frame"), "copied evidence");
    // The journal archives; a file where artifacts/ belongs fails the rest.
    mkdirSync(join(archive, id), { recursive: true }); writeFileSync(join(archive, id, "artifacts"), "in the way");
  }
  writeDebugConfig({ retain_mb: 1, archive_mb: 1 }, f.env);
  rmSync(join(f.home, "enabled.json"));
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    const pruned = await debug.pruneCaptures(f.env, async () => null);
    expect(pruned.map(p => p.id).sort()).toEqual(ids);
    for (const p of pruned) expect(p.archive_error).toBeTruthy();
    expect(readdirSync(archive)).toEqual([ids[2]!]); // only the newest stays, though each attempt failed partway
  } finally { error.mockRestore(); rmSync(f.root, { recursive: true, force: true }); }
});

test("the first archive into new directories fsyncs every new pathname entry before deleting the source", () => {
  const f = fixture("20260923T000000Z-00000015", 1), archive = join(f.home, "archive", f.run.id), synced: string[] = [];
  mkdirSync(join(f.directory, "artifacts/bundle"), { recursive: true });
  writeFileSync(join(f.directory, "artifacts/bundle/frame"), randomBytes(1.5 * 1048576));
  writeFileSync(join(f.directory, "artifacts/bundle/frame.json"), "{}");
  const sync = debug.archiveSync.directory;
  debug.archiveSync.directory = directory => {
    // Each sync lands while the source still exists: deletion waits for every entry.
    expect(existsSync(join(f.directory, "artifacts/bundle"))).toBe(true);
    synced.push(directory); sync(directory);
  };
  try {
    expect(debug.rotateJournal(f.run).archived).toEqual(["artifacts/bundle"]);
    // The first file created archive/<id>/artifacts/bundle: its directory and each new directory's parent,
    // up to the debug home. The second file needs only its own directory.
    const bundle = join(archive, "artifacts/bundle");
    expect(synced).toEqual([bundle, join(archive, "artifacts"), archive, join(f.home, "archive"), f.home, bundle]);
  } finally { debug.archiveSync.directory = sync; rmSync(f.root, { recursive: true, force: true }); }
});

const enospc = () => Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });

test("a full disk that also refuses the archive_failed journal write still removes the source, runs the cap and returns", () => {
  const f = fixture("20260923T000000Z-00000016", 1), archive = join(f.home, "archive");
  f.run.config.archive_mb = 1;
  mkdirSync(join(archive, "20260901T000000Z-00000001"), { recursive: true });
  writeFileSync(join(archive, "20260901T000000Z-00000001/events.jsonl.zst"), randomBytes(2 * 1048576));
  // A file where the bundle's directory belongs fails the archive attempt.
  mkdirSync(join(archive, f.run.id, "artifacts"), { recursive: true });
  writeFileSync(join(archive, f.run.id, "artifacts/bundle"), "in the way");
  mkdirSync(join(f.directory, "artifacts/bundle"), { recursive: true });
  writeFileSync(join(f.directory, "artifacts/bundle/frame"), randomBytes(1.5 * 1048576));
  const sourceGone: boolean[] = [];
  const io = quiet({ appendEvent: (run, event, fields) => {
    if (event === "capture.archive_failed") { sourceGone.push(!existsSync(join(f.directory, "artifacts/bundle"))); throw enospc(); }
    effects.appendEvent(run, event, fields);
  } });
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    // Returning at all is the collector surviving: a throw here ends the recorder's loop.
    expect(debug.rotateJournal(f.run, io)).toMatchObject({ archived: [], dropped: ["artifacts/bundle"] });
    expect(sourceGone).toEqual([true]); // removed before the failure was journaled
    expect(String(error.mock.calls[0]?.[0])).toContain("could not journal capture.archive_failed (ENOSPC");
    expect(existsSync(join(archive, "20260901T000000Z-00000001"))).toBe(false); // the cap still ran
    expect(events(f.directory).map(e => e.event)).toEqual(["capture.rotated", "capture.archive_pruned"]);
  } finally { error.mockRestore(); rmSync(f.root, { recursive: true, force: true }); }
});

test("retention prunes before it reports, and a report it cannot write stops neither the prune nor the cap", async () => {
  const f = fixture("20260923T000000Z-0000000b"), archive = join(f.home, "archive");
  const id = "20260920T000000Z-00000001", directory = join(f.home, id);
  mkdirSync(join(directory, "artifacts"), { recursive: true });
  writeFileSync(join(directory, "session.json"), JSON.stringify({ id, redaction: "credentials-v1" }));
  writeFileSync(join(directory, "events.000001.jsonl"), randomBytes(1048576));
  writeFileSync(join(directory, "artifacts/frame"), "copied evidence");
  // The journal archives; a file where artifacts/ belongs fails the rest.
  mkdirSync(join(archive, id), { recursive: true }); writeFileSync(join(archive, id, "artifacts"), "in the way");
  mkdirSync(join(archive, "20260901T000000Z-00000009"));
  writeFileSync(join(archive, "20260901T000000Z-00000009/events.jsonl.zst"), randomBytes(2 * 1048576));
  writeDebugConfig({ retain_mb: 1, archive_mb: 1 }, f.env);
  rmSync(join(f.home, "enabled.json"));
  const said: { text: string; present: boolean }[] = [];
  // Stderr is unwritable too: every report throws.
  const error = spyOn(console, "error").mockImplementation((text?: unknown) => { said.push({ text: String(text), present: existsSync(directory) }); throw enospc(); });
  try {
    const pruned = await debug.pruneCaptures(f.env, async () => null);
    expect(pruned).toMatchObject([{ id }]);
    expect(pruned[0]!.archive_error).toBeTruthy();
    expect(existsSync(directory)).toBe(false);
    expect(said.find(s => s.text.includes(`could not archive ${id}`))).toMatchObject({ present: false }); // pruned first
    expect(existsSync(join(archive, "20260901T000000Z-00000009"))).toBe(false); // the cap still ran
    expect(existsSync(join(archive, id))).toBe(true);
  } finally { error.mockRestore(); rmSync(f.root, { recursive: true, force: true }); }
});
