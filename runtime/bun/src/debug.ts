// Opt-in cross-team journal. This process owns its tmux log until closure is observed.
import { appendFileSync, closeSync, constants, copyFileSync, chmodSync, existsSync, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir, loadavg } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { atomicWrite } from "./fsatomic";
import { JOURNAL_SECRET, json, readJson, recorderState, safeFields, timestamp } from "./debug-capture";
export { debugAttention } from "./debug-capture";
import { redact } from "./verbose";
import { KERNEL_LOCK, kernelLockArgs } from "./panelock";
import { pythonInt } from "./pyint";
import { errorJson } from "./native-error";
import { bunBinary } from "./courier-argv";
import { deliveryStats, renderStats } from "./debug-stats";

export type Run = { id: string; directory: string; socket: string; config: { max_mb: number; retain_mb?: number } };
export type Identity = { pid: number; start: string; socket: string };
export type Log = { identity: Identity; owned: boolean; path?: string; offset?: number; opened?: boolean; stop_signalled?: boolean };
type Trace = { id: string; directory: string; seconds: number; active: boolean; uncapped: boolean; files: string[];
  started_at?: string; ended_at?: string; deadline_epoch?: number; stopping?: string; error?: string; setup_error?: string; reason?: string };
export type Result = { code: number; stdout: string; stderr: string };
type Files = { cwd: string; paths: string[] } | null;
type Position = { dev: number; ino: number; offset: number };
const clock = () => Number(process.hrtime.bigint()) / 1e9;
const home = (env = process.env) => join(env.TAP_INDEX_HOME || join(homedir(), ".tap"), "debug");
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const writeJson = (path: string, value: unknown) => atomicWrite(path, json(value));
const sameIdentity = (a: Identity | null, b: Identity) => !!a && a.pid === b.pid && a.start === b.start && a.socket === b.socket;

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
  catch (error) { if (errorText(error) === "too many socket path links") throw error; }
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
  appendFileSync(join(run.directory, "events.jsonl"), json({ schema: 1, timestamp: timestamp(), capture_id: run.id, event, ...fields }) + "\n", { mode: 0o600 });
}

export async function startLog(run: Run, identity: Identity, directory: string, record: Log, io = effects): Promise<Log> {
  const observed = await io.logPath(identity);
  if (observed.path) throw new Error("tmux logging is already enabled independently; stop that capture before tracing");
  if (!observed.cwd) throw new Error("cannot determine tmux server working directory");
  const path = join(observed.cwd, `tmux-server-${identity.pid}.log`);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try { fchmodSync(fd, 0o600); } finally { closeSync(fd); }
  Object.assign(record, { identity, path, offset: statSync(path).size, owned: false, opened: false });
  await io.toggle(identity, io);
  record.owned = true;
  for (let i = 0; i < 30; i++) {
    const active = (await io.logPath(identity)).path;
    if (active) { record.path = active; record.opened = true; break; }
    await sleep(50);
  }
  if (!record.opened) throw new Error("tmux did not open its log");
  const destination = join(directory, basename(record.path!));
  io.rename(record.path!, destination); // same filesystem; tmux retains its open fd
  record.path = destination;
  io.appendEvent(run, "tmux.logging", { server: identity, path: destination, enabled_by_tap: true, start_offset: record.offset });
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
export type Listing = { mtime: number; ino: number; paths: string[] };
/** Bus directories hold tens of thousands of entries; relist one only when its own mtime or inode moves (a created or removed entry). */
export function listed(directory: string, suffix: string, listings: Map<string, Listing>): string[] {
  const stat = statSync(directory, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) return [];
  const cached = listings.get(directory);
  if (cached && cached.mtime === stat.mtimeMs && cached.ino === stat.ino) return cached.paths;
  const paths = names(directory).filter(p => p.endsWith(suffix)).map(p => join(directory, p));
  listings.set(directory, { mtime: stat.mtimeMs, ino: stat.ino, paths });
  return paths;
}
function teamStreams(buses: Record<string, string>, listings: Map<string, Listing>): Record<string, string> {
  const streams: Record<string, string> = {};
  for (const [bus, team] of Object.entries(buses)) {
    // streamUpdates skips a path that is absent or not a regular file.
    for (const path of [join(bus, "registry-events.log"), join(bus, "tap-deliver.log"), ...listed(join(bus, "payloads"), ".attempts", listings)]) streams[path] = team;
  }
  return streams;
}

export function streamUpdates(path: string, positions: Map<string, Position>, baseline: boolean): { lines: string[]; gap: boolean } {
  // Tens of thousands of settled .attempts files sit in a long-lived bus; one
  // stat answers "unchanged" without the open/fstat/close of a read.
  const quick = statSync(path, { throwIfNoEntry: false }), known = positions.get(path);
  if (!quick?.isFile()) return { lines: [], gap: false };
  if (known && known.dev === quick.dev && known.ino === quick.ino && known.offset === quick.size) return { lines: [], gap: false };
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd), old = positions.get(path);
    const gap = !!old && (old.dev !== stat.dev || old.ino !== stat.ino || stat.size < old.offset);
    let offset = old && !gap ? old.offset : baseline ? stat.size : 0;
    const chunks: Buffer[] = []; let count = offset;
    while (count < stat.size) {
      const buffer = Buffer.alloc(Math.min(65536, stat.size - count));
      const n = readSync(fd, buffer, 0, buffer.length, count);
      if (!n) break;
      chunks.push(buffer.subarray(0, n)); count += n;
    }
    const bytes = Buffer.concat(chunks), lines: string[] = []; let start = 0;
    for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
      lines.push(bytes.subarray(start, end).toString("utf8").replace(/[\r\n]+$/, ""));
      start = end + 1;
    }
    offset += start;
    positions.set(path, { dev: stat.dev, ino: stat.ino, offset });
    return { lines, gap };
  } finally { closeSync(fd); }
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
        for (const source of [frame, metadata]) { const target = join(artifact, basename(source)); copyFileSync(source, target); chmodSync(target, 0o600); }
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

/** Close journal segments and retire the oldest segments or copied artifacts within the budget. */
export function rotateJournal(run: Run, io = effects): { bytes: number; dropped: string[] } {
  const directory = run.directory, budget = run.config.max_mb * 1048576, live = join(directory, "events.jsonl");
  if (fileBytes(live) >= budget / 8) {
    const last = segments(directory).at(-1), next = last ? Number(SEGMENT.exec(last)![1]) + 1 : 1;
    // Writers append by path, so the next line opens a fresh events.jsonl.
    io.rename(live, join(directory, `events.${String(next).padStart(6, "0")}.jsonl`));
  }
  let bytes = journalBytes(directory);
  const dropped: string[] = [];
  if (bytes < budget) return { bytes, dropped };
  const candidates = [...segments(directory), ...names(join(directory, "artifacts")).map(name => join("artifacts", name))]
    .map(name => ({ name, stat: statSync(join(directory, name)), modified: newestContentMtime(join(directory, name)) }))
    .sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name));
  for (const { name, stat } of candidates) {
    if (bytes < budget) break;
    const path = join(directory, name);
    bytes -= stat.isDirectory() ? treeBytes(path) : stat.size;
    // These are collector-owned copies; source receipts and recovery records remain intact.
    if (stat.isDirectory()) rmSync(path, { recursive: true });
    else unlinkSync(path);
    dropped.push(name);
  }
  if (dropped.length) io.appendEvent(run, "capture.rotated", { dropped, bytes, budget });
  return { bytes, dropped };
}

export async function collect(run: Run, io = effects, env = process.env): Promise<void> {
  const directory = run.directory, positions = new Map<string, Position>(), seen = new Set<string>();
  let initialized = false, stopping = false, unavailable = false, artifactsDue = false;
  let stopped: Record<string, unknown> | undefined;
  let identity: Identity | null = null, native: Log | null = null, trace: Trace | null = null;
  let handled: string | undefined, nextSample = 0, nextStatus = 0, deadline = 0, nextStop = 0;
  let buses: Record<string, string> = {};
  const listings = new Map<string, Listing>();
  const stop = () => { stopping = true; };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  async function finishTrace(reason: string): Promise<boolean> {
    if (!trace?.active) return true;
    try { await io.stopLog(native, io); }
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
    io.appendEvent(run, "capture.started", { socket: run.socket, mode: "basic" });
    // The first pass baselines every team stream; readiness follows it.
    writeJson(join(directory, "status.json"), { recording: false, starting: true, pid: process.pid, heartbeat: Date.now() / 1000, mode: "basic" });
    while (true) {
      const now = clock();
      stopping ||= existsSync(join(directory, "stop")) || readJson(join(home(env), "enabled.json"))?.id !== run.id;
      if (stopping) { if (now >= nextStop && await finishTrace("capture_stopped")) break; }
      else if (trace?.active && now >= deadline && now >= nextStop) { await finishTrace(trace.stopping || "duration_elapsed"); nextSample = 0; }
      const request = stopping ? null : readJson(join(directory, "trace-request.json"));
      if (request && request.id !== handled) {
        handled = request.id;
        trace = { ...request, active: false, uncapped: true, files: [] } as Trace;
        try {
          identity = await io.server(run.socket);
          if (!identity) throw new Error("no tmux server available to trace");
          native = { identity, owned: false };
          native = await io.startLog(run, identity, trace.directory, native, io);
          Object.assign(trace, { active: true, started_at: timestamp(), deadline_epoch: Date.now() / 1000 + trace.seconds });
          trace.files.push(native.path!); deadline = clock() + trace.seconds;
          io.appendEvent(run, "trace.started", { trace, server: identity });
        } catch (error) {
          trace.error = trace.setup_error = errorText(error);
          if (native?.owned) {
            trace.files.push(native.path!);
            Object.assign(trace, { active: true, deadline_epoch: Date.now() / 1000, stopping: "setup_failed" });
            deadline = clock(); await finishTrace("setup_failed");
          }
          io.appendEvent(run, "trace.failed", { trace });
        }
        writeJson(join(trace.directory, "status.json"), trace);
        nextSample = nextStatus = 0;
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
            native = { identity, owned: false };
            native = await io.startLog(run, identity, trace!.directory, native, io);
            trace!.files.push(native.path!); writeJson(join(trace!.directory, "status.json"), trace);
          }
          if (tracing) {
            const result = await command(["ps", "-p", String(identity.pid), "-o", "pcpu=,rss=,stat="], 2000, env);
            io.appendEvent(run, "trace.telemetry", { server: identity, process: result.stdout.trim(), load: loadavg(), monotonic: clock(), trace_id: trace!.id });
          }
        }
        buses = io.teamBuses(env);
        for (const [path, team] of Object.entries(teamStreams(buses, listings))) {
          let update: ReturnType<typeof streamUpdates>;
          try { update = streamUpdates(path, positions, !initialized); }
          catch (error) { io.appendEvent(run, "capture.gap", { team, source: path, reason: errorText(error) }); continue; }
          if (update.gap) io.appendEvent(run, "capture.gap", { team, source: path, reason: "source_rotated_or_truncated" });
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
        initialized = artifactsDue = true; nextSample = clock() + (tracing ? .5 : 5);
      }
      if (clock() >= nextStatus) {
        // A trace window is uncapped; the budget applies between traces.
        const size = tracing ? journalBytes(directory) : rotateJournal(run, io).bytes;
        writeJson(join(directory, "status.json"), { recording: true, pid: process.pid, heartbeat: Date.now() / 1000, mode: tracing ? "trace" : "basic", trace,
          tmux_logging: !!(tracing && identity && native), server: identity, teams: [...new Set(Object.values(buses))].sort(), bytes: size, gaps: "see capture.gap events" });
        nextStatus = clock() + (tracing ? .5 : 5);
      }
      if (artifactsDue) { artifactsDue = false; await io.collectArtifacts(run, buses, seen, env, io.appendEvent, listings); }
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
      writeJson(join(directory, "status.json"), { ...readJson(join(directory, "status.json")), recording: false, starting: false, mode: "off", trace, tmux_logging: false, heartbeat: Date.now() / 1000, stopped });
      if (readJson(join(home(env), "enabled.json"))?.id === run.id) {
        try { unlinkSync(join(home(env), "enabled.json")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    } finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); }
  }
}

export async function status(env = process.env): Promise<any> {
  const run = readJson(join(home(env), "enabled.json")) || readJson(join(home(env), "last.json"));
  if (!run) return { recording: false, state: "off", mode: "off", directory: null, tmux_logging: false };
  const state = readJson(join(run.directory, "status.json")) ?? {};
  Object.assign(state, { directory: run.directory, capture_id: run.id, socket: run.socket, config: run.config });
  const enabled = readJson(join(home(env), "enabled.json"))?.id === run.id;
  state.state = recorderState(state, enabled);
  state.recording = state.state === "recording" || state.state === "stopping";
  state.mode = state.recording ? state.mode || "basic" : "off";
  if (state.recording && run.config?.lifetime_hours !== undefined) state.restart_required = true;
  state.tmux_logging = false;
  if (state.recording && state.server) {
    try { state.tmux_logging = sameIdentity(await server(run.socket), state.server) && !!(await logPath(state.server)).path; } catch { /* unavailable is not confirmed logging */ }
  }
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

// Retention owns only capture directories: <UTC stamp>-<8 hex> with a matching session.json.
const CAPTURE = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;
// Every recovery record is read or retention does not run: a missed reference must never license a delete.
function recoveryText(root: string): { text: string } | { unreadable: string } {
  const recovery = join(root, "recovery"), texts: string[] = [];
  for (const run of names(recovery).filter(name => name.startsWith("recovery-")))
    for (const name of names(join(recovery, run)).filter(name => /\.(?:json|jsonl|md)$/.test(name)))
      try { texts.push(readFileSync(join(recovery, run, name), "utf8")); } catch { return { unreadable: join(recovery, run, name) }; }
  return { text: texts.join("\n") };
}

/** Keep the newest captures within retain_mb; the newest, the enabled one and any a recovery post-mortem names are always kept. */
export function pruneCaptures(env = process.env): { id: string; bytes: number }[] {
  const root = home(env), budget = (readJson(join(root, "config.json"))?.retain_mb ?? DEFAULT_RETAIN_MB) * 1048576;
  const enabled = readJson(join(root, "enabled.json"))?.id, recovery = recoveryText(root);
  if ("unreadable" in recovery) { console.error(`tap debug: retention skipped; ${recovery.unreadable} is unreadable`); return []; }
  const referenced = recovery.text;
  const captures = names(root).filter(id => CAPTURE.test(id) && readJson(join(root, id, "session.json"))?.id === id).sort().reverse();
  const pruned: { id: string; bytes: number }[] = [];
  let kept = 0, retained = 0, full = false;
  for (const id of captures) {
    if (id === enabled || referenced.includes(id)) continue;
    const directory = join(root, id), bytes = treeBytes(directory);
    if (!full && (kept === 0 || retained + bytes <= budget)) { kept++; retained += bytes; continue; }
    full = true;
    try { rmSync(directory, { recursive: true }); pruned.push({ id, bytes }); }
    catch (error) { console.error(`tap debug: kept ${id}: ${errorText(error)}`); }
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

const DEFAULT_MAX_MB = 1024, DEFAULT_RETAIN_MB = 2048;
const HELP = `usage: tap debug [-h] [--json] [--socket SOCKET] [--max-mb MAX_MB]
                 [--retain-mb RETAIN_MB] [--days N]
                 [{status,on,off,config,trace,stats}] [seconds]

Opt-in, cross-team flight journal. Records until tap debug off.
The collector lives outside tmux.

subcommands, and the options each one accepts:
  status           show whether recording is on (the default)    [--json]
  on               start recording a tmux server                 [--socket SOCKET] [--json]
  off              stop recording                                [--json]
  config           show the stored capture settings, or set them [--max-mb N] [--retain-mb N] [--json]
  trace <seconds>  record one uncapped trace window; starts the recorder if it is not running   [--socket SOCKET] [--json]
  stats            count nightly deliveries, same-id retries and extra rings across team buses; read-only   [--days N] [--json]

positional arguments:
  {status,on,off,config,trace,stats}
  seconds               duration of an uncapped trace window; trace only,
                        a finite number above zero

options:
  -h, --help            show this help message and exit
  --json                print one JSON object instead of text
  --socket SOCKET       tmux socket path; defaults to the current server.
                        on and trace only; recording another socket needs
                        tap debug off first
  --max-mb MAX_MB       capture storage budget; oldest journal segments and
                        artifact copies rotate out (1..10240 MiB, default 1024).
                        config only; applies to the next capture
  --retain-mb RETAIN_MB
                        on keeps the newest earlier captures within this total
                        and prunes older ones (1..1048576 MiB, default 2048).
                        Set it with config only; on uses the stored value
  --days N              nights to report by .placed UTC date (1..365, default
                        7). stats only
  --lifetime-hours       retired; recording now continues until tap debug off

examples:
  tap debug on
  tap debug on --socket /private/tmp/tmux-501/work
  tap debug trace 120 --json
  tap debug config --max-mb 2048 --retain-mb 4096
  tap debug status
  tap debug stats --days 3
  tap debug off

Recovery post-mortems: tap debug recovery [recovery-id|payload-id] [--json]
(available even with recording off).

exit: 0 done, 2 usage error, 1 any other failure.
`;
class UsageError extends Error {}
class RetiredLifetimeError extends UsageError {}
export function parse(argv: string[]) {
  const values: string[] = []; let jsonOutput = false, socket: string | undefined, max: number | undefined, retain: number | undefined, days: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i]!;
    if (arg === "--") { values.push(...argv.slice(i + 1)); break; }
    if (arg.startsWith("--")) {
      const key = arg.split("=", 1)[0]!;
      const matches = ["--help", "--json", "--socket", "--max-mb", "--retain-mb", "--days", "--lifetime-hours"].filter(option => option.startsWith(key));
      if (matches.length === 1) arg = matches[0]! + arg.slice(key.length); // argparse's unambiguous long options
    }
    if (arg === "-h" || arg === "--help") return null;
    if (arg === "--json") { jsonOutput = true; continue; }
    if (/^--(?:socket|max-mb|retain-mb|days|lifetime-hours)(?:=|$)/.test(arg)) {
      const equals = arg.indexOf("="), key = equals < 0 ? arg : arg.slice(0, equals);
      if (key === "--lifetime-hours") throw new RetiredLifetimeError("--lifetime-hours is retired; recording continues until tap debug off");
      const value = equals < 0 ? argv[++i] : arg.slice(equals + 1);
      if (value === undefined || (equals < 0 && value.startsWith("-") && !/^-\d*(?:\.\d+)?$/.test(value))) throw new UsageError(`${key}: expected one argument`);
      if (key === "--socket") socket = value;
      else {
        const n = pythonInt(value, true);
        if (n === null) throw new UsageError(`${key}: invalid int value: '${value}'`);
        if (key === "--max-mb") max = Number(n); else if (key === "--days") days = Number(n); else retain = Number(n);
      }
    } else if (arg.startsWith("-") && !/^-\d*(?:\.\d+)?$/.test(arg)) throw new UsageError(`unrecognized arguments: ${arg}`);
    else values.push(arg);
  }
  const action = values[0] ?? "status";
  if (!["status", "on", "off", "config", "trace", "stats"].includes(action)) throw new UsageError(`invalid choice: '${action}' (choose from 'status', 'on', 'off', 'config', 'trace', 'stats')`);
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
  if ((max !== undefined || retain !== undefined) && action !== "config") throw new UsageError("settings belong to tap debug config");
  if (socket && action !== "on" && action !== "trace") throw new UsageError("--socket belongs to tap debug on or trace");
  if (days !== undefined && !(days >= 1 && days <= 365)) throw new UsageError("--days must be between 1 and 365");
  if (days !== undefined && action !== "stats") throw new UsageError("--days belongs to tap debug stats");
  return { action, seconds, socket, max, retain, days, jsonOutput };
}

export async function main(argv: string[], env = process.env): Promise<number> {
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
  const saved = readJson(join(home(env), "config.json"));
  const config = { max_mb: saved?.max_mb ?? DEFAULT_MAX_MB, retain_mb: saved?.retain_mb ?? DEFAULT_RETAIN_MB };
  let result: any;
  if (args.action === "status") result = await status(env);
  // Read-only over every enrolled bus: no debug home, control lock or recorder.
  else if (args.action === "stats") result = deliveryStats(teamBuses(env), { days: args.days ?? 7, env });
  else if (args.action === "config" && args.max === undefined && args.retain === undefined) result = config;
  else {
    mkdirSync(home(env), { recursive: true, mode: 0o700 });
    result = await withControl(home(env), async signal => {
      const wait = () => sleep(100, undefined, { signal });
      if (args.action === "config") {
        config.max_mb = args.max ?? config.max_mb; config.retain_mb = args.retain ?? config.retain_mb;
        writeJson(join(home(env), "config.json"), config); return { ...config, applies: "next capture" };
      }
      if (args.action === "off") {
        const run = readJson(join(home(env), "enabled.json"));
        if (run) {
          closeSync(openSync(join(run.directory, "stop"), "a", 0o600));
          const until = clock() + 10;
          while (existsSync(join(home(env), "enabled.json"))) { if (clock() >= until) throw new Error("recorder did not stop; inspect tap debug status"); await wait(); }
        }
        return status(env);
      }
      const old = readJson(join(home(env), "enabled.json"));
      let state: any;
      if (old) {
        state = await status(env);
        if (args.socket && physicalPath(args.socket) !== old.socket) throw new Error("another socket is being recorded; use tap debug off first");
        if (state.state === "starting") throw new Error("the recorder is still starting; check tap debug status");
        if (!state.recording) throw new Error("an existing recorder is unresponsive; inspect tap debug status");
      } else {
        const socket = physicalPath(args.socket || env.TAP_TMUX_SOCKET_PATH || env.TMUX?.split(",")[0] || join(env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid!()}`, env.TAP_TMUX_SOCKET || "default"));
        if (!await server(socket)) throw new Error("no tmux server on " + socket);
        signal.throwIfAborted();
        const pruned = pruneCaptures(env);
        const id = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z") + "-" + randomUUID().slice(0, 8);
        const directory = join(home(env), id);
        mkdirSync(directory, { mode: 0o700 });
        const run: Run = { id, directory, socket, config };
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
  if (args.jsonOutput) console.log(json(result));
  else if (args.action === "stats") process.stdout.write(renderStats(result));
  else if (args.action === "config") console.log("tap debug config: " + json(result));
  else {
    console.log(`tap debug: ${result.state} (${result.mode})\n  Recovery post-mortems: tap debug recovery [recovery-id|payload-id]`);
    if (result.directory) {
      const tmux = result.tmux_logging ? "confirmed" : result.trace?.active ? "unavailable" : "trace windows only (tap debug trace <seconds>)";
      console.log(`  Journal: ${result.directory}\n  tmux logging: ${tmux}`);
      if (result.trace?.active) {
        console.log(`  Trace: ${Math.max(0, result.trace.deadline_epoch - Date.now() / 1000).toFixed(1)}s remaining, no byte cap; ${result.trace.directory}`);
        if (result.trace.stopping) console.log("  Trace stopping: " + (result.trace.error || "awaiting log closure"));
      }
      console.log(`  TAP event streams: ${(result.teams ?? []).length} teams\n  Basic journal: ${((result.bytes ?? 0) / 1048576).toFixed(1)} MiB / ${result.config.max_mb} MiB (oldest journal segments and artifact copies rotate out)`);
      if (result.recording) console.log(result.restart_required
        ? "  Legacy recorder may still expire; restart with tap debug off, then tap debug on"
        : "  Recording until tap debug off");
      if (result.state === "starting") console.log("  Starting: the recorder is baselining team streams");
      if (result.stopped) console.log(`  Stopped: ${result.stopped.reason === "storage_limit" ? "reached the storage budget with nothing left to rotate out" : result.stopped.reason === "lifetime_limit" ? `reached its ${result.stopped.hours}-hour lifetime cap` : result.stopped.error ?? result.stopped.reason} at ${result.stopped.at}; tap debug on starts a new capture`);
      if (result.pruned?.length) console.log(`  Pruned: ${result.pruned.length} older capture(s), ${(result.pruned.reduce((sum: number, p: { bytes: number }) => sum + p.bytes, 0) / 1048576).toFixed(1)} MiB; retaining ${result.config.retain_mb ?? DEFAULT_RETAIN_MB} MiB`);
      if (result.error) console.log("  Error: " + result.error);
    }
  }
  return 0;
}

if (import.meta.main) {
  process.umask(0o077);
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { console.error("tap debug: " + errorText(error)); process.exitCode = error instanceof UsageError ? 2 : 1; }
}
