// Opt-in cross-team journal. This process owns its tmux log until closure is observed.
import { appendFileSync, closeSync, constants, existsSync, fchmodSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir, loadavg } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { atomicWrite, stagingPath } from "./fsatomic";
import { alive, copyRedactedFile, JOURNAL_SECRET, json, readJson, RECORDER_STALE_SECONDS, recorderState, redactJournalText, safeFields, timestamp } from "./debug-capture";
export { debugAttention } from "./debug-capture";
import { redact } from "./verbose";
import { KERNEL_LOCK, kernelLockArgs } from "./panelock";
import { pythonInt } from "./pyint";
import { errorJson } from "./native-error";
import { bunBinary } from "./courier-argv";
import { debugConfig, type CaptureFidelity, type CaptureSource } from "./config-file";
import { AlwaysOnUnconfirmed, clearAlwaysOn, writeDebugConfig } from "./debug-config";
import { migrateTmux, setTmuxEnabled, tmuxSourceStatus, type TmuxControlIO } from "./debug-tmux";
import { LauncherError } from "./config-error";
import { deliveryStats, renderStats } from "./debug-stats";
import { ARM_CHILD, armsTapEvents, pruneArmClaims } from "./debug-arm";
import { listed, streamUpdates, StreamSet, type Listing, type Position, type TraceWindow } from "./debug-streams";
export { listed, streamUpdates, type Listing } from "./debug-streams";

export type Run = { id: string; directory: string; socket: string; redaction?: "credentials-v1"; config: { max_mb: number; retain_mb?: number; fidelity?: CaptureFidelity; capture?: CaptureSource[]; always_on?: boolean; archive_mb?: number } };
export type Identity = { pid: number; start: string; socket: string };
export type Log = { identity: Identity; owned: boolean; path?: string; artifact?: string; published?: boolean; offset?: number; opened?: boolean; stop_signalled?: boolean };
type Trace = { id: string; directory: string; seconds: number; active: boolean; uncapped: boolean; files: string[];
  started_at?: string; ended_at?: string; deadline_epoch?: number; stopping?: string; error?: string; setup_error?: string; reason?: string };
export type Result = { code: number; stdout: string; stderr: string };
type Files = { cwd: string; paths: string[] } | null;
const clock = () => Number(process.hrtime.bigint()) / 1e9;
const home = (env = process.env) => join(env.TAP_INDEX_HOME || join(homedir(), ".tap"), "debug");
const errorText = (error: unknown) => redactJournalText(error instanceof Error ? error.message : String(error));
// Typed control metadata keeps exact IDs and paths; free-form errors are sanitized at their source.
const writeJson = (path: string, value: unknown) => atomicWrite(path, json(value));
const sameIdentity = (a: Identity | null, b: Identity) => !!a && a.pid === b.pid && a.start === b.start && a.socket === b.socket;
const sourceStatus = (state: string, lastSample: string | null, env = process.env) => ({
  "tap-events": { state, last_sample_at: lastSample, alive: state === "recording", incident_count: null },
  tmux: tmuxSourceStatus(env),
});

export async function command(argv: string[], timeout = 3000, env = process.env): Promise<Result> {
  const child = Bun.spawn(argv, { env, detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* group already exited */ }
  }, timeout);
  try {
    // Include descendants holding output pipes; a timeout must not leave late writers.
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (timedOut || child.signalCode) throw new Error(`${argv[0]} ${timedOut ? "timed out" : "stopped by " + child.signalCode}`);
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}

// Bun on macOS cannot realpath a socket inode; resolve its links/parent instead.
export function physicalPath(path: string, links = 0): string {
  path = resolve(path);
  try { return realpathSync(path); } catch { /* missing path or Unix socket */ }
  if (links >= 40) throw new Error("too many socket path links");
  try { return physicalPath(resolve(dirname(path), readlinkSync(path)), links + 1); }
  catch (error) { if (error instanceof Error && error.message === "too many socket path links") throw error; }
  const parent = dirname(path);
  return parent === path ? path : join(physicalPath(parent, links), basename(path));
}

export async function server(socket: string): Promise<Identity | null> {
  const result = await command(["tmux", "-S", socket, "display-message", "-p", "#{pid}\t#{start_time}\t#{socket_path}"]);
  if (result.code) return null;
  const parts = result.stdout.trim().split("\t");
  if (parts.length !== 3 || !/^\d+$/.test(parts[0]!) || Number(parts[0]) <= 0 || physicalPath(parts[2]!) !== physicalPath(socket))
    throw new Error("tmux server identity could not be verified");
  return { pid: Number(parts[0]), start: parts[1]!, socket: physicalPath(parts[2]!) };
}

export function lsofFiles(result: Result, pid: number): Files {
  // -V's complete, PID-matched stdout answer distinguishes absence from failure.
  // Empty/nonzero, warnings, partial results and unknown diagnostics cannot release ownership.
  if (result.code === 1 && !result.stderr && result.stdout.trim() === `lsof: process ID not located: ${pid}`) return null;
  if (result.code !== 0 || result.stderr) throw new Error("cannot inspect tmux log descriptors with lsof: " + result.stderr.trim());
  let descriptor = "", cwd: string | undefined, observed: number | undefined;
  const paths: string[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("p")) {
      if (observed !== undefined || line !== `p${pid}`) throw new Error("unexpected lsof process identity");
      observed = pid;
    } else if (line.startsWith("f")) descriptor = line.slice(1);
    else if (line.startsWith("n")) { if (descriptor === "cwd") cwd = line.slice(1); else paths.push(line.slice(1)); }
  }
  if (observed !== pid || !cwd) throw new Error("incomplete tmux descriptor observation");
  return { cwd, paths };
}

export async function processFiles(pid: number, proc = "/proc", execute = command): Promise<Files> {
  try { statSync(proc); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return lsofFiles(await execute(["lsof", "+w", "-V", "-a", "-p", String(pid), "-Ffn"]), pid);
  }
  const root = join(proc, String(pid));
  try { statSync(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const cwd = readlinkSync(join(root, "cwd")), paths: string[] = [];
  for (const fd of readdirSync(join(root, "fd"))) {
    try { paths.push(readlinkSync(join(root, "fd", fd))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } // a descriptor closed during enumeration
  }
  return { cwd, paths };
}

export async function logPath(identity: Identity): Promise<{ cwd: string | null; path: string | null }> {
  const files = await processFiles(identity.pid);
  return { cwd: files?.cwd ?? null, path: files?.paths.find(p => basename(p.replace(/ \(deleted\)$/, "")) === `tmux-server-${identity.pid}.log`) ?? null };
}

export interface CollectorEffects {
  server: typeof server; logPath: typeof logPath; toggle: typeof toggle;
  startLog: typeof startLog; stopLog: typeof stopLog; appendEvent: typeof appendEvent;
  teamBuses: typeof teamBuses; rename: typeof renameSync; collectArtifacts: typeof collectArtifacts;
}
export const effects: CollectorEffects = { server, logPath, toggle, startLog, stopLog, appendEvent, teamBuses, rename: renameSync, collectArtifacts };

export async function toggle(identity: Identity, io = effects): Promise<void> {
  if (!sameIdentity(await io.server(identity.socket), identity)) throw new Error("tmux server changed before logging toggle");
  process.kill(identity.pid, "SIGUSR2");
}

export function appendEvent(run: Run, event: string, fields: Record<string, unknown> = {}): void {
  appendFileSync(join(run.directory, "events.jsonl"), json(safeFields({ schema: 1, timestamp: timestamp(), capture_id: run.id, event, ...fields }, process.env)) + "\n", { mode: 0o600 });
}

export async function startLog(run: Run, identity: Identity, directory: string, record: Log, io = effects): Promise<Log> {
  const observed = await io.logPath(identity);
  if (observed.path) throw new Error("tmux logging is already enabled independently; stop that capture before tracing");
  if (!observed.cwd) throw new Error("cannot determine tmux server working directory");
  const path = join(observed.cwd, `tmux-server-${identity.pid}.log`);
  const artifact = join(directory, basename(path));
  if (lstatSync(artifact, { throwIfNoEntry: false })) throw new Error("trace artifact already exists; refusing to replace it");
  const privateDir = join(dirname(run.directory), ".raw", run.id, basename(directory));
  mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  writeJson(join(dirname(privateDir), "owner.json"), { id: run.id, pid: process.pid });
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { fchmodSync(fd, 0o600); } finally { closeSync(fd); }
  Object.assign(record, { identity, path, artifact, offset: 0, owned: false, opened: false });
  await io.toggle(identity, io);
  record.owned = true;
  for (let i = 0; i < 30; i++) {
    const active = (await io.logPath(identity)).path;
    if (active) { record.path = active; record.opened = true; break; }
    await sleep(50);
  }
  if (!record.opened) throw new Error("tmux did not open its log");
  const destination = join(privateDir, basename(record.path!));
  io.rename(record.path!, destination); // same filesystem; tmux retains its open fd
  record.path = destination;
  io.appendEvent(run, "tmux.logging", { server: identity, private_raw_path: destination, artifact: record.artifact, enabled_by_tap: true, start_offset: record.offset });
  return record;
}

export async function stopLog(record: Log | null, io = effects): Promise<void> {
  if (!record?.owned) return;
  const identity = record.identity;
  if (!sameIdentity(await io.server(identity.socket), identity)) {
    // A failed observation must propagate: finishTrace must retain ownership.
    const active = (await io.logPath(identity)).path;
    if (active && active.replace(/ \(deleted\)$/, "") === record.path?.replace(/ \(deleted\)$/, ""))
      throw new Error("original tmux is still logging but its socket identity is unavailable");
    return;
  }
  if (!(await io.logPath(identity)).path) {
    if (record.opened === false && !record.stop_signalled) throw new Error("waiting for the pending tmux logging activation before stopping it");
    return;
  }
  if (!record.stop_signalled) { await io.toggle(identity, io); record.stop_signalled = true; }
  if ((await io.logPath(identity)).path) throw new Error("waiting for tmux to close its trace log");
}

function publishLog(record: Log | null, env: NodeJS.ProcessEnv, progress: () => void): void {
  if (!record?.artifact || !record.path) return;
  if (!record.published) {
    copyRedactedFile(record.path, record.artifact, env, progress);
    record.published = true;
  }
  try { unlinkSync(record.path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export function teamBuses(env = process.env): Record<string, string> {
  const index = dirname(home(env)), path = join(index, "global-registry.json");
  if (!existsSync(path)) return {}; // No machine index, no enrolled team buses; teams.json is retired.
  const doc = readJson(path);
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || (doc.teams !== undefined && (!doc.teams || typeof doc.teams !== "object" || Array.isArray(doc.teams))))
    throw new Error("machine team index is unreadable");
  const buses: Record<string, string> = {};
  for (const [name, value] of Object.entries(doc.teams ?? {})) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, string>;
    if (entry.state === "historical") continue;
    const registry = entry.registry_location || join(entry.root || "/nonexistent", ".tap/team-registry.json");
    buses[basename(registry) === "team-registry.json" ? join(dirname(registry), "bus") : dirname(registry)] = name;
  }
  return buses;
}
function names(path: string): string[] {
  try { return readdirSync(path); } catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code!)) return []; throw error; }
}
export async function collectArtifacts(run: Run, buses: Record<string, string>, seen: Set<string>, env = process.env, append = appendEvent, listings = new Map<string, Listing>()): Promise<void> {
  try {
    const result = await command([bunBinary(), join(import.meta.dir, "recovery/artifacts.ts"), "_collect", run.directory], 10000, env);
    if (result.code) append(run, "capture.gap", { source: "recovery", reason: result.stderr.trim() });
  } catch (error) { append(run, "capture.gap", { source: "recovery", reason: errorText(error) }); }
  for (const [bus, team] of Object.entries(buses)) {
    for (const metadata of listed(join(bus, "receipts"), ".submit-unverified.json", listings)) {
      if (seen.has(metadata)) continue;
      const info = readJson(metadata) ?? {};
      if (info.capture_id !== run.id) { seen.add(metadata); continue; }
      const frame = metadata.replace(/\.json$/, ".frame");
      try {
        const artifact = join(run.directory, "artifacts", createHash("sha256").update(frame).digest("hex").slice(0, 20));
        mkdirSync(artifact, { recursive: true, mode: 0o700 });
        for (const source of [frame, metadata]) copyRedactedFile(source, join(artifact, basename(source)), env);
        append(run, "tap.failure_frame", { team, payload_id: info.payload_id, stage: info.stage ?? null, source: frame, artifact: join(artifact, basename(frame)) });
        seen.add(metadata);
      } catch (error) { append(run, "capture.gap", { team, source: frame, reason: errorText(error) }); }
    }
  }
}
function treeBytes(directory: string): number {
  let size = 0;
  for (const name of names(directory)) { const path = join(directory, name), stat = statSync(path); size += stat.isDirectory() ? treeBytes(path) : stat.isFile() ? stat.size : 0; }
  return size;
}
function fileBytes(path: string): number {
  try { return statSync(path).size; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
}
// The journal is events.jsonl plus closed segments events.NNNNNN.jsonl, oldest first.
const SEGMENT = /^events\.(\d{6})\.jsonl$/;
const segments = (directory: string) => names(directory).filter(name => SEGMENT.test(name)).sort();
const journalBytes = (directory: string) =>
  ["events.jsonl", ...segments(directory)].reduce((sum, name) => sum + fileBytes(join(directory, name)), 0) + treeBytes(join(directory, "artifacts"));

function newestContentMtime(path: string): number {
  const stat = statSync(path);
  return stat.isDirectory()
    ? Math.max(stat.mtimeMs, ...names(path).map(name => newestContentMtime(join(path, name))))
    : stat.mtimeMs;
}

// Archived history lives in <debug home>/archive/<capture-id>/, beside the captures rather than in
// them: retention removes a capture's directory, and archive_mb, not max_mb, bounds the archive.
// Every archived file is zstd; a bundle directory keeps its tree with each file compressed.
const archiveHome = (root: string) => join(root, "archive");
const FRAME = 8 * 1048576;
/** Thrown by a compression tick when the capture is stopping; the source stays in place. */
class ArchiveStopped extends Error {}
/** Give a finished staging file its final name without ever replacing one: link(2) refuses an existing
 * name, so a taken `<name>.zst` becomes `<name>.1.zst`, `<name>.2.zst` and so on. */
function publish(staging: string, destination: string): string {
  for (let n = 0; ; n++) {
    const target = n ? destination.replace(/\.zst$/, `.${n}.zst`) : destination;
    try { linkSync(staging, target); unlinkSync(staging); return target; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
}
/** The directory fsync, replaceable so a test can record which directories are synced. */
export const archiveSync = {
  directory(directory: string): void {
    const fd = openSync(directory, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  },
};
/** Make a new file's pathname durable: fsync its directory and, when `created` (mkdir's first new
 * directory) is set, every directory from there up to the one holding `created`, so each entry mkdir
 * added is on disk too. */
function syncNewEntries(directory: string, created: string | undefined): void {
  archiveSync.directory(directory);
  if (created) for (let dir = directory; dir !== dirname(created); dir = dirname(dir)) archiveSync.directory(dirname(dir));
}
/** Compress one file into `destination` and return the name written. Each 8 MiB read becomes its own
 * zstd frame, written to a staging file as soon as it is made, so memory stays at one chunk plus one
 * frame; `zstd -dc` reads concatenated frames as one stream. The staging file is fsynced, linked under
 * a name that replaces nothing, and every new pathname entry is fsynced before the caller removes the
 * source. `tick` runs after every frame; it may throw to abandon the file. */
function compressFile(source: string, destination: string, tick?: () => void): string {
  const directory = dirname(destination);
  const created = mkdirSync(directory, { recursive: true, mode: 0o700 });
  const input = openSync(source, "r"), staging = stagingPath(directory);
  try {
    const output = openSync(staging, "wx", 0o600), chunk = Buffer.alloc(FRAME);
    try {
      for (let n = -1, frames = 0; n !== 0; frames++) {
        n = readSync(input, chunk, 0, FRAME, null);
        if (n || !frames) writeFileSync(output, Bun.zstdCompressSync(chunk.subarray(0, n), { level: 3 }));
        tick?.();
      }
      fsyncSync(output);
    } finally { closeSync(output); }
    const written = publish(staging, destination);
    syncNewEntries(directory, created);
    return written;
  } catch (error) { rmSync(staging, { force: true }); throw error; }
  finally { closeSync(input); }
}
/** Archive a file as `<destination>.zst`, or a directory as the same tree of `.zst` files.
 * compressFile creates each directory, so the one that creates it also makes it durable. */
function archiveTree(source: string, destination: string, tick?: () => void): void {
  const stat = lstatSync(source);
  if (stat.isFile()) { compressFile(source, destination + ".zst", tick); return; }
  if (!stat.isDirectory()) return; // collector copies are files and directories; a link is not followed
  for (const name of names(source)) archiveTree(join(source, name), join(destination, name), tick);
}
/** Keep the archive within archive_mb by removing whole capture archives, oldest first.
 * The newest capture archive and `keep` always stay. */
function pruneArchive(root: string, archiveMb: number, keep?: string): { id: string; bytes: number }[] {
  const archive = archiveHome(root), budget = archiveMb * 1048576, removed: { id: string; bytes: number }[] = [];
  if (!lstatSync(archive, { throwIfNoEntry: false })?.isDirectory()) return removed;
  const ids = names(archive).filter(id => CAPTURE.test(id) && lstatSync(join(archive, id)).isDirectory()).sort();
  let total = treeBytes(archive);
  for (const id of ids.slice(0, -1)) {
    if (total <= budget) break;
    if (id === keep) continue;
    const bytes = treeBytes(join(archive, id));
    rmSync(join(archive, id), { recursive: true });
    total -= bytes; removed.push({ id, bytes });
  }
  return removed;
}

const ARCHIVED_SEGMENT = /^events\.(\d{6})\.jsonl(?:\.\d+)?\.zst$/;
const highest = (directory: string, pattern: RegExp) => Math.max(0, ...names(directory).map(name => Number(pattern.exec(name)?.[1] ?? 0)));
const HEARTBEAT_SECONDS = 2;

/** Archive diagnostics must never cost the cleanup they report: on a full disk the journal, and even stderr, may be unwritable. */
function warn(text: string): void {
  try { console.error(text); } catch { /* nowhere left to say it; the cleanup already happened */ }
}
/** Journal a rotation diagnostic, falling back to stderr (recorder.log in the recorder) when the journal write fails. */
function journalSafely(run: Run, io: CollectorEffects, event: string, fields: Record<string, unknown>): void {
  try { io.appendEvent(run, event, fields); }
  catch (error) { warn(`tap debug: could not journal ${event} (${errorText(error)}): ${JSON.stringify(fields)}`); }
}

/** Close journal segments; past the budget, move the oldest segments and copied artifacts into the archive. */
export function rotateJournal(run: Run, io = effects): { bytes: number; archived: string[]; dropped: string[] } {
  const directory = run.directory, budget = run.config.max_mb * 1048576, live = join(directory, "events.jsonl");
  // The capture directory sits in the debug home, as .raw does (see startLog).
  const root = dirname(directory), archive = join(archiveHome(root), run.id);
  if (fileBytes(live) >= budget / 8) {
    // Numbering continues past archived segments, so a new segment never reuses an archived name.
    const next = Math.max(highest(directory, SEGMENT), highest(archive, ARCHIVED_SEGMENT)) + 1;
    // Writers append by path, so the next line opens a fresh events.jsonl.
    io.rename(live, join(directory, `events.${String(next).padStart(6, "0")}.jsonl`));
  }
  let bytes = journalBytes(directory);
  const archived: string[] = [], dropped: string[] = [];
  if (bytes < budget) return { bytes, archived, dropped };
  // Compression runs inside the recorder: between frames, keep its heartbeat fresh and yield to a stop.
  const statusPath = join(directory, "status.json");
  let beat = clock(), stopped = false;
  const tick = () => {
    if (clock() - beat >= HEARTBEAT_SECONDS) {
      writeJson(statusPath, { ...readJson(statusPath), heartbeat: Date.now() / 1000 });
      beat = clock();
    }
    const enabled = readJson(join(root, "enabled.json"));
    if (existsSync(join(directory, "stop")) || (enabled && enabled.id !== run.id)) throw new ArchiveStopped("capture is stopping");
  };
  const candidates = [...segments(directory), ...names(join(directory, "artifacts")).map(name => join("artifacts", name))]
    .map(name => ({ name, stat: statSync(join(directory, name)), modified: newestContentMtime(join(directory, name)) }))
    .sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name));
  for (const { name, stat } of candidates) {
    if (bytes < budget) break;
    const path = join(directory, name), size = stat.isDirectory() ? treeBytes(path) : stat.size;
    let failure: string | undefined;
    try { archiveTree(path, join(archive, name), tick); archived.push(name); }
    catch (error) {
      if (error instanceof ArchiveStopped) { stopped = true; break; } // the source stays; retention archives it later
      // A failed archive must not stop the recorder: drop the copy to stay in budget, and journal the loss.
      failure = errorText(error);
      dropped.push(name);
    }
    bytes -= size;
    // These are collector-owned copies; source receipts and recovery records remain intact.
    if (stat.isDirectory()) rmSync(path, { recursive: true });
    else unlinkSync(path);
    // Journal only after the source is gone: on a full disk this write can fail too, and must not keep the bytes.
    if (failure !== undefined) journalSafely(run, io, "capture.archive_failed", { source: name, archive, reason: failure });
  }
  if (archived.length || dropped.length) journalSafely(run, io, "capture.rotated", { archived, dropped, archive, bytes, budget });
  // Any attempt may have written bytes, even one that failed or stopped partway, so the cap always runs.
  if (archived.length || dropped.length || stopped) {
    const archiveMb = run.config.archive_mb ?? DEFAULT_ARCHIVE_MB;
    try {
      const removed = pruneArchive(root, archiveMb, run.id);
      if (removed.length) journalSafely(run, io, "capture.archive_pruned", { removed, archive_mb: archiveMb });
    } catch (error) { journalSafely(run, io, "capture.archive_failed", { source: "archive_mb", archive: archiveHome(root), reason: errorText(error) }); }
  }
  return { bytes, archived, dropped };
}

export async function collect(run: Run, io = effects, env = process.env): Promise<void> {
  const directory = run.directory, positions = new Map<string, Position>(), seen = new Set<string>();
  let initialized = false, stopping = false, unavailable = false, artifactsDue = false;
  let stopped: Record<string, unknown> | undefined;
  let identity: Identity | null = null, native: Log | null = null, trace: Trace | null = null;
  let handled: string | undefined, nextSample = 0, nextStatus = 0, deadline = 0, nextStop = 0;
  let samplingTrace: TraceWindow | undefined;
  let buses: Record<string, string> = {};
  const listings = new Map<string, Listing>(), streams = new StreamSet(positions);
  const captureFidelity = run.config.fidelity ?? "best-effort";
  const captureEvents = run.config.capture?.includes("tap-events") ?? true;
  let lastSample: string | null = null;
  let previousStreamFidelity: CaptureFidelity = captureFidelity;
  const stop = () => { stopping = true; };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  function publishNative(reason: string): void {
    let nextHeartbeat = 0;
    publishLog(native, env, () => {
      if (clock() < nextHeartbeat) return;
      writeJson(join(directory, "status.json"), { ...readJson(join(directory, "status.json")), recording: true,
        mode: "trace", trace: { ...trace, stopping: reason }, heartbeat: Date.now() / 1000 });
      nextHeartbeat = clock() + 1;
    });
  }
  async function finishTrace(reason: string): Promise<boolean> {
    if (!trace?.active) return true;
    try { await io.stopLog(native, io); publishNative(reason); }
    catch (error) {
      const previous = trace.error; trace.stopping = reason; trace.error = errorText(error);
      try {
        if (previous !== trace.error) io.appendEvent(run, "capture.error", { error: "stopping tmux trace: " + trace.error });
        writeJson(join(trace.directory, "status.json"), trace);
      } catch (failure) { console.error("tap debug: shutdown evidence write failed: " + errorText(failure)); }
      nextStop = clock() + 1; nextStatus = 0;
      return false;
    }
    delete trace.error; delete trace.stopping;
    Object.assign(trace, { active: false, ended_at: timestamp(), reason });
    io.appendEvent(run, "trace.finished", { trace });
    writeJson(join(trace.directory, "status.json"), trace);
    native = null; nextStatus = 0;
    return true;
  }
  try {
    io.appendEvent(run, "capture.started", { socket: run.socket, mode: "basic", fidelity: captureFidelity });
    // The first pass baselines the selected team streams; readiness follows it.
    writeJson(join(directory, "status.json"), { recording: false, starting: true, pid: process.pid, heartbeat: Date.now() / 1000, mode: "basic", fidelity: captureFidelity,
      sources: sourceStatus(captureEvents ? "starting" : "off", lastSample, env) });
    while (true) {
      const now = clock();
      stopping ||= existsSync(join(directory, "stop")) || readJson(join(home(env), "enabled.json"))?.id !== run.id;
      if (stopping) { if (now >= nextStop && await finishTrace("capture_stopped")) break; }
      else if (trace?.active && now >= deadline && now >= nextStop) {
        await finishTrace(trace.stopping || "duration_elapsed"); nextSample = 0;
        if (!captureEvents && !trace.active) stopping = true;
      }
      const request = stopping ? null : readJson(join(directory, "trace-request.json"));
      if (request && request.id !== handled) {
        handled = request.id;
        samplingTrace = { id: request.id, since: Date.now() - 5000 };
        trace = { ...request, active: false, uncapped: true, files: [] } as Trace;
        try {
          identity = await io.server(run.socket);
          if (!identity) throw new Error("no tmux server available to trace");
          native = { identity, owned: false };
          native = await io.startLog(run, identity, trace.directory, native, io);
          Object.assign(trace, { active: true, started_at: timestamp(), deadline_epoch: Date.now() / 1000 + trace.seconds });
          trace.files.push(native.artifact ?? native.path!); deadline = clock() + trace.seconds;
          io.appendEvent(run, "trace.started", { trace, server: identity });
        } catch (error) {
          trace.error = trace.setup_error = errorText(error);
          if (native?.owned) {
            trace.files.push(native.artifact ?? native.path!);
            Object.assign(trace, { active: true, deadline_epoch: Date.now() / 1000, stopping: "setup_failed" });
            deadline = clock(); await finishTrace("setup_failed");
          }
          io.appendEvent(run, "trace.failed", { trace });
        }
        writeJson(join(trace.directory, "status.json"), trace);
        nextSample = nextStatus = 0;
        if (!captureEvents && !trace.active) stopping = true;
      }
      const tracing = !!trace?.active;
      if (now >= nextSample) {
        try { identity = await io.server(run.socket); }
        catch (error) { identity = null; io.appendEvent(run, "tmux.unavailable", { socket: run.socket, error: errorText(error) }); }
        if (!identity && !unavailable) { io.appendEvent(run, "tmux.unavailable", { socket: run.socket }); unavailable = true; }
        else if (identity) {
          unavailable = false;
          if (tracing && native && !sameIdentity(identity, native.identity) && !trace!.stopping) {
            await io.stopLog(native, io);
            publishNative("server_replaced");
            native = { identity, owned: false };
            native = await io.startLog(run, identity, trace!.directory, native, io);
            trace!.files.push(native.artifact ?? native.path!); writeJson(join(trace!.directory, "status.json"), trace);
          }
          if (tracing) {
            const result = await command(["ps", "-p", String(identity.pid), "-o", "pcpu=,rss=,stat="], 2000, env);
            io.appendEvent(run, "trace.telemetry", { server: identity, process: result.stdout.trim(), load: loadavg(), monotonic: clock(), trace_id: trace!.id });
          }
        }
        buses = captureEvents ? io.teamBuses(env) : {};
        const streamFidelity = tracing ? "precise" : captureFidelity;
        for (const [path, team] of streams.select(buses, listings, streamFidelity, statSync, tracing ? samplingTrace : undefined)) {
          let update: ReturnType<typeof streamUpdates>;
          try {
            const baseline = !initialized || (streamFidelity !== previousStreamFidelity && streamFidelity === "precise" && !positions.has(path));
            update = streamUpdates(path, positions, baseline, streamFidelity);
          }
          catch (error) { io.appendEvent(run, "capture.gap", { team, source: path, reason: errorText(error) }); continue; }
          if (update.gap) io.appendEvent(run, "capture.gap", { team, source: path, reason: update.reason ?? "source_rotated_or_truncated" });
          for (const line of update.lines) {
            if (path.endsWith(".attempts")) {
              let record: any;
              try { record = JSON.parse(line); } catch { io.appendEvent(run, "capture.gap", { team, source: path, reason: "malformed_attempt_record" }); continue; }
              io.appendEvent(run, "tap.attempt", { team, source: path, payload_id: record.payload_id ?? null, fields: safeFields(record, env) });
            } else {
              const detail = redact(line, env, JOURNAL_SECRET);
              const fields = Object.fromEntries(detail.split(/\s+/).filter(word => word.includes("=")).map(word => [word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1)]));
              io.appendEvent(run, path.endsWith("registry-events.log") ? "tap.registry" : "tap.delivery", { team, source: path, source_timestamp: fields.ts ?? null, fields, detail });
            }
          }
        }
        previousStreamFidelity = streamFidelity;
        if (captureEvents) lastSample = timestamp();
        initialized = artifactsDue = true; nextSample = clock() + (tracing ? .5 : 5);
      }
      if (clock() >= nextStatus) {
        // A trace window is uncapped; the budget applies between traces.
        const size = tracing ? journalBytes(directory) : rotateJournal(run, io).bytes;
        writeJson(join(directory, "status.json"), { recording: true, pid: process.pid, heartbeat: Date.now() / 1000, mode: tracing ? "trace" : "basic", fidelity: captureFidelity, trace,
          sources: sourceStatus(captureEvents ? "recording" : "off", lastSample, env),
          tmux_logging: !!(tracing && identity && native), server: identity, teams: [...new Set(Object.values(buses))].sort(), bytes: size, gaps: "see capture.gap events" });
        nextStatus = clock() + (tracing ? .5 : 5);
      }
      if (artifactsDue) {
        artifactsDue = false;
        if (captureEvents) await io.collectArtifacts(run, buses, seen, env, io.appendEvent, listings);
      }
      await sleep(100);
    }
  } catch (error) {
    stopped = { reason: "error", at: timestamp(), error: errorText(error) };
    io.appendEvent(run, "capture.error", { error: errorText(error) });
    writeJson(join(directory, "error.json"), { error: errorText(error) });
  } finally {
    try {
      while (!await finishTrace("capture_stopped")) {
        try { writeJson(join(directory, "status.json"), { ...readJson(join(directory, "status.json")), recording: true, mode: "trace", trace, heartbeat: Date.now() / 1000 }); }
        catch (error) { console.error("tap debug: shutdown status write failed: " + errorText(error)); }
        await sleep(1000);
      }
      io.appendEvent(run, "capture.stopped");
      writeJson(join(directory, "status.json"), { ...readJson(join(directory, "status.json")), recording: false, starting: false, mode: "off", fidelity: captureFidelity,
        sources: sourceStatus("off", lastSample, env), trace, tmux_logging: false, heartbeat: Date.now() / 1000, stopped });
      if (readJson(join(home(env), "enabled.json"))?.id === run.id) {
        try { unlinkSync(join(home(env), "enabled.json")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    } finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); }
  }
}

/**
 * Under the control lock: a capture whose recorder heartbeat is
 * RECORDER_STALE_SECONDS old is retired. Before the recorder's first status
 * write, enabled.json's mtime is the heartbeat. Its status is marked stopped
 * and enabled.json released (on then writes a new one); its journal, artifacts
 * and raw files stay. Nothing is signalled: a stale heartbeat can mean slow,
 * not dead (a load of 100+), and a recorder that is still alive sees
 * enabled.json no longer naming its capture on its next cycle and stops
 * itself. Its shutdown removes enabled.json only while it still names that
 * capture, so it never removes a replacement. Returns the stop reason.
 */
function retireStaleCapture(run: any, env: NodeJS.ProcessEnv, by: "on" | "off"): string | null {
  if (typeof run?.directory !== "string" || typeof run.id !== "string") return null;
  const enabled = join(home(env), "enabled.json"), path = join(run.directory, "status.json"), state = readJson(path);
  let heartbeat = state?.heartbeat;
  if (typeof heartbeat !== "number") { try { heartbeat = statSync(enabled).mtimeMs / 1000; } catch { return null; } }
  if (Date.now() / 1000 - heartbeat < RECORDER_STALE_SECONDS) return null;
  const gone = Number.isSafeInteger(state?.pid) && state.pid > 0 && !alive(state.pid);
  const stopped = { reason: gone ? "recorder_gone" : by === "on" ? "replaced" : "unresponsive", at: timestamp(), pid: state?.pid ?? null };
  if (existsSync(run.directory)) {
    // mode keeps the collector's own basic|trace|off spelling.
    writeJson(path, { ...(state ?? {}), recording: false, starting: false, mode: "off", tmux_logging: false, stopped });
    appendEvent(run, "capture.stopped", { stopped });
  }
  try { unlinkSync(enabled); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return stopped.reason;
}

/** Why a capture is unresponsive, for arm.log and status: its pid, whether it lives, and its heartbeat age. */
function recorderDetail(state: any): string {
  const age = typeof state?.heartbeat === "number" ? `heartbeat ${Math.round(Date.now() / 1000 - state.heartbeat)}s old` : "no heartbeat";
  if (!Number.isSafeInteger(state?.pid)) return `no recorder pid, ${age}`;
  return `recorder pid ${state.pid} ${alive(state.pid) ? "alive" : "gone"}, ${age}`;
}

/** always_on as the arm path reads it: a refused [debug] block reads as off. */
function alwaysOnState(env: NodeJS.ProcessEnv): { always_on: boolean; always_on_error?: string } {
  try { return { always_on: debugConfig(env).always_on }; }
  catch (error) { return { always_on: false, always_on_error: errorText(error) }; }
}

export async function status(env = process.env, readSettings = true): Promise<any> {
  const run = readJson(join(home(env), "enabled.json")) || readJson(join(home(env), "last.json"));
  if (!run) {
    const config = readSettings ? debugConfig(env) : null;
    return { recording: false, state: "off", mode: "off", directory: null, tmux_logging: false,
      fidelity: config?.fidelity ?? null, config, sources: sourceStatus("off", null, env) };
  }
  const state = readJson(join(run.directory, "status.json")) ?? {};
  Object.assign(state, { directory: run.directory, capture_id: run.id, socket: run.socket, config: run.config });
  state.redaction = run.redaction === "credentials-v1" ? run.redaction : null;
  const enabled = readJson(join(home(env), "enabled.json"))?.id === run.id;
  state.state = recorderState(state, enabled);
  state.recording = state.state === "recording" || state.state === "stopping";
  state.mode = state.recording ? state.mode || "basic" : "off";
  state.fidelity = state.fidelity ?? run.config?.fidelity ?? "precise";
  state.sources ??= sourceStatus(state.recording ? "recording" : "off", null, env);
  state.sources.tmux = tmuxSourceStatus(env);
  if (!state.recording) Object.assign(state.sources["tap-events"], { state: "off", alive: false });
  if (state.recording && run.config?.lifetime_hours !== undefined) state.restart_required = true;
  state.tmux_logging = false;
  if (state.recording && state.server) {
    try { state.tmux_logging = sameIdentity(await server(run.socket), state.server) && !!(await logPath(state.server)).path; } catch { /* unavailable is not confirmed logging */ }
  }
  try { state.archive_bytes = treeBytes(archiveHome(home(env))); } catch { state.archive_bytes = null; } // an archive changing mid-walk is unmeasured
  return Object.assign(state, readJson(join(run.directory, "error.json")) ?? {});
}

/** Wait for the recorder's own ready signal. Only a recorder that exited unready is a failure. */
export async function awaitRecorder(directory: string, exited: () => boolean, wait: () => Promise<unknown>): Promise<void> {
  while (true) {
    if (readJson(join(directory, "status.json"))?.recording) return;
    const error = readJson(join(directory, "error.json"))?.error;
    if (error) throw new Error(error);
    if (exited()) {
      let log = "";
      try { log = readFileSync(join(directory, "recorder.log"), "utf8").trim().split("\n").slice(-5).join("\n"); } catch { /* no recorder output */ }
      throw new Error("recorder exited before it was ready" + (log ? ": " + log : "; see " + join(directory, "recorder.log")));
    }
    await wait();
  }
}

// Retention owns captures with matching session.json and private raw trees with matching owner.json.
const CAPTURE = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;
async function inactiveRaw(root: string, id: string, inspect: typeof processFiles): Promise<boolean> {
  const rawRoot = join(root, ".raw"), directory = join(rawRoot, id);
  try {
    const parent = lstatSync(rawRoot, { throwIfNoEntry: false });
    if (!parent) return true;
    if (!parent.isDirectory()) return false;
    const entry = lstatSync(directory, { throwIfNoEntry: false });
    if (!entry) return true;
    if (!entry.isDirectory() || !lstatSync(join(directory, "owner.json")).isFile()) return false;
    const owner = readJson(join(directory, "owner.json"));
    if (owner?.id !== id || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
    try { process.kill(owner.pid, 0); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
    // A dead collector may leave tmux writing; only confirmed closed descriptors permit removal.
    for (const trace of names(directory).filter(name => name !== "owner.json")) {
      const traceDir = join(directory, trace);
      if (!/^trace-[0-9a-f]{12}$/.test(trace) || !lstatSync(traceDir).isDirectory()) return false;
      for (const file of names(traceDir)) {
        const match = /^tmux-server-([1-9][0-9]*)\.log$/.exec(file), path = join(traceDir, file);
        if (!match || !lstatSync(path).isFile()) return false;
        const opened = await inspect(Number(match[1]));
        if (opened?.paths.some(p => physicalPath(p.replace(/ \(deleted\)$/, "")) === physicalPath(path))) return false;
      }
    }
    return true;
  } catch { return false; } // Unreadable ownership or descriptors cannot license deletion.
}
// Every recovery record is read or retention does not run: a missed reference must never license a delete.
function recoveryText(root: string): { text: string } | { unreadable: string } {
  const recovery = join(root, "recovery"), texts: string[] = [];
  for (const run of names(recovery).filter(name => name.startsWith("recovery-")))
    for (const name of names(join(recovery, run)).filter(name => /\.(?:json|jsonl|md)$/.test(name)))
      try { texts.push(readFileSync(join(recovery, run, name), "utf8")); } catch { return { unreadable: join(recovery, run, name) }; }
  return { text: texts.join("\n") };
}

/** Archive what remains of a capture before retention removes it: the journal and small metadata first,
 * then its redacted artifact copies and published traces in the same layout rotation uses. Private raw
 * files under .raw/ are never archived, and a capture without the sanitizer keeps its copies out. */
function archiveCapture(directory: string, archive: string): void {
  for (const name of [...segments(directory), "events.jsonl", "session.json", "status.json", "recovery-artifacts.json"])
    if (lstatSync(join(directory, name), { throwIfNoEntry: false })?.isFile()) compressFile(join(directory, name), join(archive, name + ".zst"));
  if (readJson(join(directory, "session.json"))?.redaction !== "credentials-v1") return;
  for (const name of names(directory).filter(name => name === "artifacts" || /^trace-[0-9a-f]{12}$/.test(name)))
    if (lstatSync(join(directory, name)).isDirectory()) archiveTree(join(directory, name), join(archive, name));
}
export type Pruned = { id: string; bytes: number; archive?: string; archive_error?: string };
/** Keep the newest captures within retain_mb; the newest, the enabled one and any a recovery post-mortem names are always kept.
 * A pruned capture moves into the archive first; archive_mb then bounds the archive. */
export async function pruneCaptures(env = process.env, inspect = processFiles): Promise<Pruned[]> {
  const root = home(env), budget = debugConfig(env).retain_mb * 1048576;
  const enabled = readJson(join(root, "enabled.json"))?.id, recovery = recoveryText(root);
  if ("unreadable" in recovery) { console.error(`tap debug: retention skipped; ${recovery.unreadable} is unreadable`); return []; }
  const referenced = recovery.text;
  const captures = names(root).filter(id => CAPTURE.test(id) && readJson(join(root, id, "session.json"))?.id === id).sort().reverse();
  const pruned: Pruned[] = [];
  let kept = 0, retained = 0, full = false, attempted = false;
  for (const id of captures) {
    if (id === enabled || referenced.includes(id)) continue;
    if (!await inactiveRaw(root, id, inspect)) continue;
    const directory = join(root, id), raw = join(root, ".raw", id), bytes = treeBytes(directory) + treeBytes(raw);
    if (!full && (kept === 0 || retained + bytes <= budget)) { kept++; retained += bytes; continue; }
    full = true;
    const archive = join(archiveHome(root), id);
    let outcome: Pruned = { id, bytes, archive };
    attempted = true;
    try { archiveCapture(directory, archive); }
    catch (error) { outcome = { id, bytes, archive_error: errorText(error) }; }
    try { rmSync(raw, { recursive: true, force: true }); rmSync(directory, { recursive: true }); pruned.push(outcome); }
    catch (error) { warn(`tap debug: kept ${id}: ${errorText(error)}`); continue; }
    // As in rotation, a failed archive still prunes to stay within budget, and says so only after the prune.
    if (outcome.archive_error) warn(`tap debug: could not archive ${id} (${outcome.archive_error}); pruned it to stay within retain_mb`);
  }
  // A failed or partial archive may still have written bytes, so the cap runs after every attempt.
  if (attempted) {
    try {
      const archiveMb = debugConfig(env).archive_mb, removed = pruneArchive(root, archiveMb, enabled);
      if (removed.length) warn(`tap debug: the archive passed its ${archiveMb} MiB cap; removed ${removed.length} oldest capture archive(s), ${(removed.reduce((sum, r) => sum + r.bytes, 0) / 1048576).toFixed(1)} MiB`);
    } catch (error) { warn(`tap debug: archive cap not applied: ${errorText(error)}`); }
  }
  for (const id of names(join(root, ".raw")).filter(id => CAPTURE.test(id))) {
    if (id === enabled || referenced.includes(id) || lstatSync(join(root, id), { throwIfNoEntry: false })) continue;
    if (!await inactiveRaw(root, id, inspect)) continue;
    const raw = join(root, ".raw", id), bytes = treeBytes(raw);
    try { rmSync(raw, { recursive: true }); pruned.push({ id, bytes }); }
    catch (error) { console.error(`tap debug: kept raw ${id}: ${errorText(error)}`); }
  }
  return pruned;
}

export async function withControl<T>(directory: string, body: (signal: AbortSignal) => Promise<T>, holder = ["sh", "-c", "printf 'held\\n'; exec cat >/dev/null"]): Promise<T> {
  const path = join(directory, "control.lock");
  closeSync(openSync(path, "a", 0o600));
  // macOS -k in kernelLockArgs retains this inode; unlinking splits exclusion.
  const child = spawn(KERNEL_LOCK, kernelLockArgs(path, Infinity, holder), { detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const abort = new AbortController();
  const interrupt = () => abort.abort(new Error("debug control interrupted"));
  process.on("SIGTERM", interrupt); process.on("SIGINT", interrupt);
  let stderr = "";
  child.stderr.on("data", bytes => { stderr += bytes; });
  let closed = false;
  const exited = new Promise<void>(done => child.once("close", () => { closed = true; done(); }));
  try {
    await new Promise<void>((accept, reject) => {
      let output = "";
      child.stdout.on("data", bytes => { output += bytes; if (output === "held\n") accept(); else if (!"held\n".startsWith(output)) reject(new Error("invalid debug control lock grant")); });
      child.once("error", reject);
      child.once("exit", () => reject(new Error("debug control lock unavailable: " + stderr.trim())));
      abort.signal.addEventListener("abort", () => reject(abort.signal.reason), { once: true });
    });
    abort.signal.throwIfAborted();
    return await body(abort.signal);
  } finally {
    child.stdin.end();
    if (!closed && child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch { /* child already exited */ } }
    const kill = setTimeout(() => { if (!closed && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } } }, 1000);
    try { await exited; } finally { clearTimeout(kill); process.off("SIGTERM", interrupt); process.off("SIGINT", interrupt); }
  }
}

const DEFAULT_RETAIN_MB = 2048, DEFAULT_ARCHIVE_MB = 10240;
const STOPPED: Record<string, string> = {
  recorder_gone: "its recorder was gone (an unclean exit or a reboot)",
  replaced: "its recorder stopped writing status; tap debug on started a new capture",
  unresponsive: "its recorder stopped writing status; tap debug off released it",
};
const HELP = `usage: tap debug [-h] [--json] [--socket SOCKET] [--max-mb MAX_MB]
                 [--retain-mb RETAIN_MB] [--archive-mb ARCHIVE_MB] [--days N]
                 [--always-on | --no-always-on]
                 [{status,on,off,config,trace,stats,tmux-migrate}] [seconds]

Opt-in, cross-team flight journal. Records until tap debug off.
The collector lives outside tmux.
Credential-named environment values (*TOKEN*, *SECRET*, *KEY*, *PASSWORD*, AUTH*)
are redacted from journal writes and copied artifacts. Session IDs, paths, team
and pane names, commands and terminal contents remain. Review before sharing.
Existing captures are not rewritten on upgrade; status identifies legacy captures.
Timed traces keep raw capture private outside the journal until logging closes;
the published trace is then redacted and its raw file removed.

subcommands, and the options each one accepts:
  status           show whether recording is on (the default)    [--json]
  on               start recording a tmux server                 [--socket SOCKET] [--json]
  off              stop recording; also turns always_on off       [--json]
  config           show or set capture settings [--capture tmux,tap-events] [--fidelity best-effort|precise] [--max-mb N] [--retain-mb N]
                   [--archive-mb N] [--always-on | --no-always-on] [--json]
  trace <seconds>  record one uncapped trace window; starts the recorder if it is not running   [--socket SOCKET] [--json]
  stats            count nightly deliveries, same-id retries and extra rings across team buses; read-only   [--days N] [--json]
  tmux-migrate     adopt or install local.tmux-flight with backup and rollback   [--json]

positional arguments:
  {status,on,off,config,trace,stats,tmux-migrate}
  seconds               duration of an uncapped trace window; trace only,
                        a finite number above zero

options:
  -h, --help            show this help message and exit
  --json                print one JSON object instead of text
  --socket SOCKET       tmux socket path; defaults to the current server.
                        on and trace only; recording another socket needs
                        tap debug off first
  --fidelity FIDELITY           best-effort (default): active streams and a two-tick drain;
                        precise: all sidecars, including late writes and rewrite
                        replay. config only; applies to the next capture.
                        Timed traces sample active, draining and recent sidecars
  --capture SOURCES     tmux,tap-events (default), either source, or none.
                        Removing tmux stops its owned automatic sampler now.
                        Run tmux-migrate once to bring a legacy sampler under TAP.
  --max-mb MAX_MB       capture storage budget; oldest journal segments and
                        artifact copies rotate out, compressed into the archive
                        (1..10240 MiB, default 1024). config only; applies to
                        the next capture
  --retain-mb RETAIN_MB
                        on keeps the newest earlier captures within this total
                        and prunes older ones, archiving them first
                        (1..1048576 MiB, default 2048).
                        Set it with config only; on uses the stored value
  --archive-mb ARCHIVE_MB
                        cap on the zstd archive of rotated and pruned history in
                        debug/archive/; past it the oldest capture archives are
                        removed, never the newest (1..1048576 MiB, default
                        10240). config only; applies to the next capture
  --days N              nights to report by .placed UTC date (1..365, default
                        7). stats only
  --always-on, --no-always-on
                        set debug.always_on in config.toml (default off).
                        config only; read by the next tap command
  --lifetime-hours       retired; recording now continues until tap debug off

examples:
  tap debug on
  tap debug on --socket /private/tmp/tmux-501/work
  tap debug trace 120 --json
  tap debug config --fidelity precise
  tap debug config --max-mb 2048 --retain-mb 4096
  tap debug config --archive-mb 20480
  tap debug config --always-on
  tap debug status
  tap debug stats --days 3
  tap debug off

Settings live in config.toml [debug]: always_on (default false), capture,
fidelity, max_mb, retain_mb and archive_mb. Trace is manual, never a setting.

Always on (config.toml [debug] always_on = true, off by default) is for someone
debugging TAP: the first tap command that finds no live recorder starts
tap debug on in the background, at most once a minute, logging to
debug/arm.log. A recorder whose status is ${RECORDER_STALE_SECONDS}s old counts as gone: tap debug on
replaces its capture and keeps its evidence. Help, the state-free verbs
(ask, admin, completion, doctor, health, models, provenance, show, who,
version, tap session listing) and tap debug never arm; tap debug off turns
always_on off.

Recovery post-mortems: tap debug recovery [recovery-id|payload-id] [--json]
(available even with recording off).

exit: 0 done, 2 usage error, 1 any other failure.
`;
class UsageError extends Error {}
class RetiredLifetimeError extends UsageError {}
export function parse(argv: string[]) {
  const values: string[] = []; let jsonOutput = false, socket: string | undefined, max: number | undefined, retain: number | undefined, archive: number | undefined, days: number | undefined, fidelity: CaptureFidelity | undefined, capture: CaptureSource[] | undefined;
  let alwaysOn: boolean | undefined;
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i]!;
    if (arg === "--") { values.push(...argv.slice(i + 1)); break; }
    if (arg.startsWith("--")) {
      const key = arg.split("=", 1)[0]!;
      const matches = ["--help", "--json", "--socket", "--max-mb", "--retain-mb", "--archive-mb", "--days", "--fidelity", "--capture", "--lifetime-hours", "--always-on", "--no-always-on"].filter(option => option.startsWith(key));
      if (matches.length === 1) arg = matches[0]! + arg.slice(key.length); // argparse's unambiguous long options
    }
    if (arg === "-h" || arg === "--help") return null;
    if (arg === "--json") { jsonOutput = true; continue; }
    if (arg === "--always-on" || arg === "--no-always-on") {
      if (alwaysOn !== undefined && alwaysOn !== (arg === "--always-on")) throw new UsageError("--always-on and --no-always-on contradict each other");
      alwaysOn = arg === "--always-on"; continue;
    }
    if (/^--(?:socket|max-mb|retain-mb|archive-mb|days|fidelity|capture|lifetime-hours)(?:=|$)/.test(arg)) {
      const equals = arg.indexOf("="), key = equals < 0 ? arg : arg.slice(0, equals);
      if (key === "--lifetime-hours") throw new RetiredLifetimeError("--lifetime-hours is retired; recording continues until tap debug off");
      const value = equals < 0 ? argv[++i] : arg.slice(equals + 1);
      if (value === undefined || (equals < 0 && value.startsWith("-") && !/^-\d*(?:\.\d+)?$/.test(value))) throw new UsageError(`${key}: expected one argument`);
      if (key === "--socket") socket = value;
      else if (key === "--fidelity") {
        if (value !== "best-effort" && value !== "precise") throw new UsageError("--fidelity must be best-effort or precise; use tap debug trace for a timed trace");
        fidelity = value;
      } else if (key === "--capture") {
        const sources = value === "none" ? [] : value.split(",");
        if (sources.some(source => source !== "tmux" && source !== "tap-events")) throw new UsageError("--capture must be tmux,tap-events, either source, or none");
        capture = [...new Set(sources)] as CaptureSource[];
      } else {
        const n = pythonInt(value, true);
        if (n === null) throw new UsageError(`${key}: invalid int value: '${value}'`);
        if (key === "--max-mb") max = Number(n); else if (key === "--days") days = Number(n); else if (key === "--archive-mb") archive = Number(n); else retain = Number(n);
      }
    } else if (arg.startsWith("-") && !/^-\d*(?:\.\d+)?$/.test(arg)) throw new UsageError(`unrecognized arguments: ${arg}`);
    else values.push(arg);
  }
  const action = values[0] ?? "status";
  if (!["status", "on", "off", "config", "trace", "stats", "tmux-migrate"].includes(action)) throw new UsageError(`invalid choice: '${action}' (choose from 'status', 'on', 'off', 'config', 'trace', 'stats', 'tmux-migrate')`);
  if (values.length > 2) throw new UsageError(`unrecognized arguments: ${values.slice(2).join(" ")}`);
  let seconds: number | undefined;
  if (values[1] !== undefined) {
    const text = values[1].trim().replace(/(?<=\d)_(?=\d)/g, "");
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) && !/^[+-]?(?:nan|inf(?:inity)?)$/i.test(text)) throw new UsageError(`invalid float value: '${values[1]}'`);
    seconds = Number(text);
  }
  if (action === "trace") { if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) throw new UsageError("trace requires a finite positive duration in seconds"); }
  else if (seconds !== undefined) throw new UsageError("seconds belong to tap debug trace");
  if (max !== undefined && !(max >= 1 && max <= 10240)) throw new UsageError("--max-mb must be between 1 and 10240");
  if (retain !== undefined && !(retain >= 1 && retain <= 1048576)) throw new UsageError("--retain-mb must be between 1 and 1048576");
  if (archive !== undefined && !(archive >= 1 && archive <= 1048576)) throw new UsageError("--archive-mb must be between 1 and 1048576");
  if ((max !== undefined || retain !== undefined || archive !== undefined || fidelity !== undefined || capture !== undefined || alwaysOn !== undefined) && action !== "config") throw new UsageError("settings belong to tap debug config");
  if (socket && action !== "on" && action !== "trace") throw new UsageError("--socket belongs to tap debug on or trace");
  if (days !== undefined && !(days >= 1 && days <= 365)) throw new UsageError("--days must be between 1 and 365");
  if (days !== undefined && action !== "stats") throw new UsageError("--days belongs to tap debug stats");
  return { action, seconds, socket, max, retain, archive, days, fidelity, capture, alwaysOn, jsonOutput };
}

export async function main(argv: string[], env = process.env, tmuxIO?: TmuxControlIO): Promise<number> {
  if (argv.length === 2 && argv[0] === "_collect") { await collect(readJson(argv[1]!), effects, env); return 0; }
  let args;
  try { args = parse(argv); }
  catch (error) {
    if (!(error instanceof RetiredLifetimeError)) throw error;
    const options = argv.slice(0, argv.includes("--") ? argv.indexOf("--") : argv.length);
    if (env.TAP_JSON === "1" || options.some(arg => ["--j", "--js", "--jso", "--json"].includes(arg)))
      process.stdout.write(errorJson("renamed_verb", "tap debug off", error.message));
    else console.error(`tap debug: ${error.message}; next: tap debug off`);
    return 1;
  }
  if (!args) { process.stdout.write(HELP); return 0; }
  let result: any;
  if (args.action === "status") result = await status(env);
  // Read-only over every enrolled bus: no debug home, control lock or recorder.
  else if (args.action === "stats") result = deliveryStats(teamBuses(env), { days: args.days ?? 7, env });
  else if (args.action === "config" && args.max === undefined && args.retain === undefined && args.archive === undefined && args.fidelity === undefined && args.capture === undefined && args.alwaysOn === undefined) result = debugConfig(env);
  else {
    mkdirSync(home(env), { recursive: true, mode: 0o700 });
    result = await withControl(home(env), async signal => {
      const wait = () => sleep(100, undefined, { signal });
      if (args.action === "tmux-migrate") return migrateTmux(env, tmuxIO);
      if (args.action === "config") {
        const config = writeDebugConfig({ ...(args.fidelity === undefined ? {} : { fidelity: args.fidelity }),
          ...(args.capture === undefined ? {} : { capture: args.capture }), ...(args.max === undefined ? {} : { max_mb: args.max }),
          ...(args.retain === undefined ? {} : { retain_mb: args.retain }), ...(args.archive === undefined ? {} : { archive_mb: args.archive }),
          ...(args.alwaysOn === undefined ? {} : { always_on: args.alwaysOn }) }, env);
        if (args.capture !== undefined && !config.capture.includes("tmux")) await setTmuxEnabled(false, env, tmuxIO);
        // always_on is read by the next public command; the other settings wait for the next capture.
        const capture = args.fidelity !== undefined || args.capture !== undefined || args.max !== undefined || args.retain !== undefined || args.archive !== undefined;
        return { ...config, applies: args.alwaysOn === undefined ? "next capture" : capture ? "next capture; always_on on the next tap command" : "next tap command" };
      }
      if (args.action === "off") {
        // Off means off: always_on is cleared under this lock, so an arm child queued behind off finds it off.
        // off validates no next-capture setting: when the [debug] block is refused, clearAlwaysOn
        // edits always_on alone, so fixing the refused key later cannot re-arm.
        let cleared = false, clearing: unknown;
        const current = alwaysOnState(env);
        try {
          if (current.always_on) {
            try { writeDebugConfig({ always_on: false }, env); cleared = true; }
            catch { cleared = clearAlwaysOn(env); }
          } else if (current.always_on_error) cleared = clearAlwaysOn(env);
        } catch (error) { clearing = error; }
        const run = readJson(join(home(env), "enabled.json"));
        let stopping: unknown;
        try { if (run && !retireStaleCapture(run, env, "off")) {
          closeSync(openSync(join(run.directory, "stop"), "a", 0o600));
          const until = clock() + 10;
          while (existsSync(join(home(env), "enabled.json"))) { if (clock() >= until) throw new Error("recorder did not stop; inspect tap debug status"); await wait(); }
        } } catch (error) { stopping = error; }
        try { await setTmuxEnabled(false, env, tmuxIO); } catch (error) { stopping = stopping ? new Error(`${errorText(stopping)}; ${errorText(error)}`) : error; }
        if (stopping) throw stopping;
        if (clearing) throw new Error(clearing instanceof AlwaysOnUnconfirmed ? `recording stopped; ${errorText(clearing)}`
          : `recording stopped, but debug.always_on is still set: ${errorText(clearing)}; next: set always_on = false under [debug] in config.toml`);
        return { ...(await status(env, false)), ...(cleared ? { always_on_cleared: true } : {}) };
      }
      if (env[ARM_CHILD] === "1") {
        pruneArmClaims(home(env));
        // Read again under the lock: off clears always_on while holding it.
        if (!armsTapEvents(debugConfig(env))) return { ...(await status(env)), arm_skipped: "always_on is off or capture excludes tap-events" };
      }
      const config = writeDebugConfig({}, env);
      // An always_on arm child manages tap-events only. Ordinary CLI activity
      // never invokes launchctl or changes the independent tmux scheduler.
      if (args.action === "on" && env[ARM_CHILD] !== "1")
        await setTmuxEnabled(config.capture.includes("tmux"), env, tmuxIO, args.socket ? physicalPath(args.socket) : undefined);
      if (args.action === "on" && !config.capture.includes("tap-events")) return status(env);
      let old = readJson(join(home(env), "enabled.json"));
      const replaced = old ? retireStaleCapture(old, env, "on") : null;
      const retired = replaced ? { capture_id: old.id, reason: replaced } : null;
      if (retired) old = null;
      let state: any;
      if (old) {
        state = await status(env);
        if (args.socket && physicalPath(args.socket) !== old.socket) throw new Error("another socket is being recorded; use tap debug off first");
        if (state.state === "starting") throw new Error("the recorder is still starting; check tap debug status");
        if (!state.recording) throw new Error(`an existing recorder is unresponsive (${recorderDetail(state)}); inspect tap debug status`);
      } else {
        const socket = physicalPath(args.socket || env.TAP_TMUX_SOCKET_PATH || env.TMUX?.split(",")[0] || join(env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid!()}`, env.TAP_TMUX_SOCKET || "default"));
        if (!await server(socket)) throw new Error("no tmux server on " + socket);
        signal.throwIfAborted();
        const pruned = await pruneCaptures(env);
        const id = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z") + "-" + randomUUID().slice(0, 8);
        const directory = join(home(env), id);
        mkdirSync(directory, { mode: 0o700 });
        const run: Run = { id, directory, socket, config, redaction: "credentials-v1" };
        writeJson(join(directory, "session.json"), run); writeJson(join(home(env), "last.json"), run); writeJson(join(home(env), "enabled.json"), run);
        const log = openSync(join(directory, "recorder.log"), "a", 0o600);
        let exited = false;
        try {
          const child = spawn(bunBinary(), [import.meta.path, "_collect", join(directory, "session.json")], { detached: true, stdio: ["ignore", log, log], env: { ...env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
          child.once("exit", () => { exited = true; });
          await new Promise<void>((accept, reject) => { child.once("spawn", accept); child.once("error", reject); });
          child.unref();
        } finally { closeSync(log); }
        try { await awaitRecorder(directory, () => exited, wait); }
        catch (error) {
          if (exited && readJson(join(home(env), "enabled.json"))?.id === id) {
            try { unlinkSync(join(home(env), "enabled.json")); } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure; }
          }
          throw error;
        }
        state = await status(env);
        if (!state.recording) throw new Error(state.error || "recorder stopped right after it became ready; inspect tap debug status");
        state.pruned = pruned;
        if (retired) state.retired = retired;
      }
      if (args.action === "trace") {
        signal.throwIfAborted();
        if (state.trace?.active) throw new Error("a trace is already active; wait for its deadline or use tap debug off");
        const id = randomUUID().replaceAll("-", "").slice(0, 12), directory = join(state.directory, "trace-" + id);
        mkdirSync(directory, { mode: 0o700 });
        writeJson(join(state.directory, "trace-request.json"), { id, directory, seconds: args.seconds });
        const until = clock() + 10;
        while (true) {
          state = await status(env);
          if (state.trace?.id === id) {
            if (state.trace.error || state.trace.setup_error) throw new Error(state.trace.setup_error || state.trace.error);
            if (state.trace.active) break;
          }
          if (clock() >= until) throw new Error("trace did not become ready; inspect tap debug status");
          await wait();
        }
      }
      return state;
    });
  }
  if (args.action !== "stats" && args.action !== "config") Object.assign(result, alwaysOnState(env));
  if (args.jsonOutput) console.log(json(result));
  else if (args.action === "stats") process.stdout.write(renderStats(result));
  else if (args.action === "config") console.log("tap debug config: " + json(result));
  else if (args.action === "tmux-migrate") console.log(`tap debug tmux-migrate: ${result.enabled ? "enabled" : "off"}; ${result.plist}${result.backup ? `; backup ${result.backup}` : ""}`);
  else {
    console.log(`tap debug: ${result.state} (${result.mode}; fidelity ${result.fidelity})\n  Recovery post-mortems: tap debug recovery [recovery-id|payload-id]`);
    for (const [name, source] of Object.entries(result.sources) as [string, any][]) {
      console.log(`  ${name}: ${source.state}; last sample ${source.last_sample_at ?? "none"}; alive ${source.alive ?? "unknown"}; incidents ${source.incident_count ?? "unknown"}`);
      if (source.incident_over_budget_bytes > 0) console.log(`    Protected newest incidents exceed the retention budget by ${(source.incident_over_budget_bytes / 1048576).toFixed(1)} MiB`);
      if (source.error) console.log(`    ${source.error}`);
    }
    if (result.directory) {
      const tmux = result.tmux_logging ? "confirmed" : result.trace?.active ? "unavailable" : "trace windows only (tap debug trace <seconds>)";
      console.log(`  Journal: ${result.directory}\n  tmux logging: ${tmux}`);
      console.log(result.redaction === "credentials-v1"
        ? "  Credential-named environment values redacted; session IDs, paths and terminal contents remain"
        : "  Credential redaction is unverified for this legacy capture; review before sharing");
      if (result.trace?.active) {
        console.log(`  Trace: ${Math.max(0, result.trace.deadline_epoch - Date.now() / 1000).toFixed(1)}s remaining, no byte cap; ${result.trace.directory}`);
        console.log(result.redaction === "credentials-v1"
          ? "  Raw trace is private; the redacted artifact is published after logging closes"
          : "  Legacy trace files may contain credentials; review before sharing");
        if (result.trace.stopping) console.log("  Trace stopping: " + (result.trace.error || "awaiting log closure"));
      }
      console.log(`  TAP event streams: ${(result.teams ?? []).length} teams\n  Journal: ${((result.bytes ?? 0) / 1048576).toFixed(1)} MiB / ${result.config.max_mb} MiB (oldest journal segments and artifact copies rotate into the archive)`);
      if (typeof result.archive_bytes === "number") console.log(`  Archive: ${(result.archive_bytes / 1048576).toFixed(1)} MiB / ${result.config.archive_mb ?? DEFAULT_ARCHIVE_MB} MiB of zstd history; oldest capture archives go first`);
      if (result.recording) console.log(result.restart_required
        ? "  Legacy recorder may still expire; restart with tap debug off, then tap debug on"
        : "  Recording until tap debug off");
      if (result.state === "starting") console.log("  Starting: the recorder is baselining team streams");
      if (result.stopped) console.log(`  Stopped: ${result.stopped.reason === "storage_limit" ? "reached the storage budget with nothing left to rotate out" : result.stopped.reason === "lifetime_limit" ? `reached its ${result.stopped.hours}-hour lifetime cap` : STOPPED[result.stopped.reason] ?? result.stopped.error ?? result.stopped.reason} at ${result.stopped.at}; tap debug on starts a new capture`);
      if (result.state === "unresponsive") console.log(`  Unresponsive: ${recorderDetail(result)}; tap debug on replaces it once the heartbeat is ${RECORDER_STALE_SECONDS}s old`);
      if (result.retired) console.log(`  Replaced: capture ${result.retired.capture_id} (${result.retired.reason}); its journal and artifacts are kept`);
      if (result.pruned?.length) {
        const unarchived = result.pruned.filter((p: Pruned) => p.archive_error).length;
        console.log(`  Pruned: ${result.pruned.length} older capture(s), ${(result.pruned.reduce((sum: number, p: Pruned) => sum + p.bytes, 0) / 1048576).toFixed(1)} MiB; ${unarchived ? `${unarchived} could not be archived` : "archived first"}; retaining ${result.config.retain_mb ?? DEFAULT_RETAIN_MB} MiB`);
      }
      if (result.error) console.log("  Error: " + result.error);
    }
    if (result.always_on_cleared) console.log("  Always on: cleared (debug.always_on = false); tap debug config --always-on turns it back on");
    else if (result.always_on_error) console.log("  Always on: off; the [debug] config is refused: " + result.always_on_error);
    else if (result.always_on) console.log(`  Always on: ${armsTapEvents(debugConfig(env)) ? `a tap command starts a recorder when none is live; arm log ${join(home(env), "arm.log")}` : "set, but capture excludes tap-events, so nothing arms"}`);
    if (result.arm_skipped) console.log("  Arm skipped: " + result.arm_skipped);
  }
  return 0;
}

if (import.meta.main) {
  process.umask(0o077);
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) {
    if (error instanceof LauncherError &&
        (process.env.TAP_JSON === "1" || process.argv.slice(2).some(arg => ["--j", "--js", "--jso", "--json"].includes(arg))))
      process.stdout.write(errorJson(error.errorClass ?? "debug_failed", error.action ?? "tap debug config", error.detail ?? error.message));
    else console.error("tap debug: " + errorText(error));
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
