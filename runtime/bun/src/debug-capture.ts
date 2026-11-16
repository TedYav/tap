import { acquirePathLock, lockRoot } from "./panelock";
// Private failure evidence from observations the courier already made.
import { appendFileSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { spawnSync } from "node:child_process";
import { atomicWrite, ensureAscii, stagingPath } from "./fsatomic";
import { redact } from "./verbose";
import { tapScriptsDir, artifactBun } from "./scripts-dir";
import { ownBun, ownBunFlags } from "./own-bun";

export const JOURNAL_SECRET = /key|token|secret|password|passwd|credential|authorization|^auth/i;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export const timestamp = () => new Date().toISOString().slice(0, -1) + "000+00:00";
export const json = (value: unknown) => ensureAscii(JSON.stringify(value));

export function readJson(path: string): any {
  try { return JSON.parse(UTF8.decode(readFileSync(path))); } catch { return null; }
}

/**
 * A recorder rewrites its status.json at least every 5 s (every 0.5 s while
 * tracing), so a status.json older than this means no recorder is writing.
 * Commands judge it from the file's mtime alone (one stat, no read), which is
 * wrong in both directions for a while, by design:
 * - A recorder that wedges just after a write still reads as live until the
 *   mtime ages past this threshold: commands keep appending to the wedged
 *   capture for at most this long, then correct themselves.
 * - A live recorder stalled longer than this (a long artifact pass, a machine
 *   waking from sleep) reads as gone: commands skip their journal rows until
 *   its next status write. With always_on set, an arm child's `tap debug on`
 *   retires that capture and starts a fresh one; the stalled recorder, never
 *   signalled, stops itself on its next cycle.
 */
export const RECORDER_STALE_SECONDS = 30;

export const alive = (pid: unknown) => {
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return false;
  try { process.kill(pid as number, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

/** The recorder's state from its own status record. A fresh heartbeat proves recording; a live pid covers only the startup baseline. */
export function recorderState(state: any, enabled: boolean): "recording" | "stopping" | "starting" | "unresponsive" | "stopped" | "off" {
  const fresh = Date.now() / 1000 - (state.heartbeat ?? 0) < 10;
  if (enabled && fresh && state.recording) return state.trace?.stopping ? "stopping" : "recording";
  if (enabled) return state.starting && (fresh || alive(state.pid)) ? "starting" : "unresponsive";
  return state.stopped ? "stopped" : "off";
}

/** Health signal: a capture the operator enabled that is no longer recording. `tap debug off` is not a concern. */
export function debugAttention(env = process.env): Record<string, unknown> | null {
  const home = join(env.TAP_INDEX_HOME || join(homedir(), ".tap"), "debug");
  const enabled = readJson(join(home, "enabled.json")), run = enabled || readJson(join(home, "last.json"));
  if (typeof run?.directory !== "string") return null;
  const state = readJson(join(run.directory, "status.json")) ?? {};
  const current = recorderState(state, !!enabled);
  if (current === "stopped") return { type: "debug-stopped", capture_id: run.id, reason: state.stopped.reason, at: state.stopped.at ?? null };
  if (current === "unresponsive") return { type: "debug-unresponsive", capture_id: run.id };
  return null;
}

export function redactJournalText(text: string, env: NodeJS.ProcessEnv = process.env): string {
  // Native environment records can contain spaces or newlines in an unquoted value.
  for (const match of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)=/g)) {
    if (JOURNAL_SECRET.test(match[1]!)) return redact(text.slice(0, match.index) + match[1] + "=<redacted>", env, JOURNAL_SECRET);
  }
  return redact(text, env, JOURNAL_SECRET);
}

export function safeFields(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") return redactJournalText(value, env);
  if (Array.isArray(value)) return value.map(v => safeFields(v, env));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, JOURNAL_SECRET.test(k) ? "<redacted>" : safeFields(v, env)]));
  return value;
}

/** Only sanitized bytes reach the destination, including its atomic staging file. */
export function copyRedactedFile(source: string, target: string, env: NodeJS.ProcessEnv = process.env, progress?: () => void): void {
  if (source.endsWith(".json")) {
    const text = readFileSync(source, "utf8");
    let safe: string;
    try { safe = json(safeFields(JSON.parse(text), env)); }
    catch { safe = redactJournalText(text, env); }
    atomicWrite(target, safe + "\n");
    return;
  }
  const input = openSync(source, "r"), temporary = stagingPath(dirname(target));
  let output: number | undefined;
  try {
    output = openSync(temporary, "wx", 0o600);
    const bytes = Buffer.alloc(65536), decoder = new StringDecoder("utf8");
    const tmuxTrace = /^tmux-server-\d+\.log$/.test(basename(source));
    let pending = "", record = "";
    const write = (text: string) => {
      let safe: string;
      if (source.endsWith(".jsonl")) {
        try { safe = json(safeFields(JSON.parse(text), env)); }
        catch { safe = redactJournalText(text, env); }
      } else safe = redactJournalText(text, env);
      writeFileSync(output!, safe.replace(/\n$/, "") + "\n");
    };
    const line = (text: string) => {
      if (!tmuxTrace) { write(text); return; }
      if (/^\d+\.\d+\s/.test(text) && record) { write(record); record = ""; }
      record += text + "\n";
    };
    for (;;) {
      const count = readSync(input, bytes, 0, bytes.length, null);
      if (!count) break;
      progress?.();
      pending += decoder.write(bytes.subarray(0, count));
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) { line(pending.slice(0, end)); pending = pending.slice(end + 1); }
    }
    pending += decoder.end();
    if (pending) line(pending);
    if (record) write(record);
    closeSync(output); output = undefined;
    renameSync(temporary, target);
  } finally {
    closeSync(input);
    if (output !== undefined) closeSync(output);
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

/** The capture enabled.json names, or null when there is none. */
function enabledRun(home: string): any {
  const run = readJson(join(home, "enabled.json"));
  return !run || (typeof run === "object" && Object.keys(run).length === 0) ? null : run;
}

/** Whether a saved capture selection includes the TAP event source; a capture from before selection existed does. */
const recordsTapEvents = (run: any) =>
  run.config?.capture === undefined || (Array.isArray(run.config.capture) && run.config.capture.includes("tap-events"));

function checked(run: any): { id: string; directory: string } {
  if (typeof run.directory !== "string" || typeof run.id !== "string") throw new Error("invalid debug capture");
  return run;
}

/** The opted-in TAP event capture, or null when that source is off or stopping. */
function activeRun(env: NodeJS.ProcessEnv): { id: string; directory: string } | null {
  const run = enabledRun(join(env.TAP_INDEX_HOME || join(homedir(), ".tap"), "debug"));
  if (!run || !recordsTapEvents(run)) return null;
  return existsSync(join(checked(run).directory, "stop")) ? null : run;
}

/** Whether a recorder is writing this capture, from its status.json mtime (RECORDER_STALE_SECONDS).
 * Before the recorder's first status write, enabled.json's own mtime stands in. */
function recorderFresh(directory: string, enabled: string, now = Date.now()): boolean {
  let written: number;
  try { written = statSync(join(directory, "status.json")).mtimeMs; }
  catch {
    try { written = statSync(enabled).mtimeMs; } catch { return false; }
  }
  return now - written < RECORDER_STALE_SECONDS * 1000;
}

/**
 * One `tap.command` journal row, written in-process by the public entry
 * (main.ts). bin/tap execs into Bun, so the caller pid is the command the
 * user ran. Returns false when no recorder is writing the enabled capture
 * (none enabled, or its status.json is stale), so the caller may arm one; a
 * dead capture gets no rows. A stopping capture, or one whose saved capture
 * excludes tap-events, is live: true, no row.
 */
export function recordCommand(args: string[], env: NodeJS.ProcessEnv, callerPid: number): boolean {
  const home = join(env.TAP_INDEX_HOME || join(homedir(), ".tap"), "debug");
  const run = enabledRun(home);
  if (!run) return false;
  // A capture without the TAP event source journals no commands, and its recorder is never a dead one to replace.
  if (!recordsTapEvents(run)) return true;
  if (!recorderFresh(checked(run).directory, join(home, "enabled.json"))) return false;
  if (existsSync(join(run.directory, "stop"))) return true;
  let hide = false;
  const command = args.map(arg => {
    const value = hide ? "<redacted>" : redactJournalText(arg, env);
    hide = ["-m", "--message", "--body"].includes(arg) || /^--(?:token|password|secret|api-key)$/.test(arg);
    return value;
  });
  const doc = readJson(join(home, "../global-registry.json")) ?? {};
  if (typeof doc !== "object" || Array.isArray(doc)) throw new Error("invalid machine team index");
  const teams = doc.teams === undefined ? {} : doc.teams;
  if (!teams || typeof teams !== "object" || Array.isArray(teams)) throw new Error("invalid machine team index");
  let team: string | null = env.TAP_TEAM ?? null, longest = -1;
  for (const [name, entry] of Object.entries(teams)) {
    const row = entry as { root?: string; state?: string } | null;
    if (!row?.root || row.state === "historical") continue;
    if (process.cwd() === row.root || process.cwd().startsWith(row.root.replace(/\/+$/, "") + "/")) {
      if (row.root.length > longest) { longest = row.root.length; team = name; }
    }
  }
  appendFileSync(join(run.directory, "events.jsonl"), json(safeFields({ schema: 1, timestamp: timestamp(), capture_id: run.id,
    event: "tap.command", operation_id: randomUUID().replaceAll("-", ""), argv: command,
    caller_pid: callerPid, cwd: process.cwd(), pane: env.TMUX_PANE ?? null, tmux: env.TMUX ?? null, team }, env)) + "\n",
    { mode: 0o600 });
  return true;
}

/** Internal leaf: check opt-in before reading stdin, resolving a bus or writing. */
export function recordDebug(argv: string[], input = () => readFileSync(0), env = process.env): void {
  const run = activeRun(env);
  if (!run) return;
  const [operation, ...args] = argv;
  if (operation !== "_frame" && operation !== "_attempt") throw new Error("unknown debug writer");
  const record = operation === "_attempt" ? JSON.parse(UTF8.decode(input())) : null;
  const id = operation === "_frame" ? args[0] : record?.payload_id;
  // This incumbent writer grammar differs from the broader public validId().
  if (typeof id !== "string" || !id || /[^A-Za-z0-9_-]/.test(id)) throw new Error("invalid debug evidence id");
  if (!env.TAP_HOME) throw new Error("TAP_HOME is required for journal writes; pass the resolved team bus directory");
  if (operation === "_attempt") {
    if (!Object.hasOwn(record, "status")) throw new Error("attempt status is required");
    const { status, ...fields } = record;
    const payloads = join(env.TAP_HOME, "payloads");
    if (!statSync(payloads).isDirectory()) throw new Error("journal payload storage is not a directory");
    const path = join(payloads, id + ".debug.attempts");
    const fd = openSync(path, "a+", 0o600);
    try {
      // The Infinity arm truncates its target. Only participating writers lock;
      // Bash spool summaries also append here and their seq remains advisory.
      // kernelLockArgs keeps the data inode (-k on macOS), including on release.
      const lock = acquirePathLock(path, 1000, env);
      if (!lock) throw new Error("debug attempt lock unavailable");
      try {
        const content = UTF8.decode(readFileSync(fd));
        const seq = (content.match(/\r\n|\r|\n/g)?.length ?? 0) + (content.length > 0 && !/[\r\n]$/.test(content) ? 1 : 0) + 1;
        const delivered = status === "injected", possible = delivered || status === "unverified";
        appendFileSync(fd, json(safeFields({ ...fields, rung: 1, op: "deliver", driver: "tmux", class: "queue",
          disposition: delivered ? "delivered" : possible ? "stop-ambiguous" : "retry-next-rung",
          effect: possible ? "possible" : "none", tier: delivered ? "left-input-band" : "none", native_ref: "", seq }, env)) + "\n");
      } finally { lock.release(0); }
    } finally { closeSync(fd); }
    return;
  }
  if (args.length !== 5) throw new Error("failure frame needs id, harness, pane, expected and stage");
  const receipts = join(env.TAP_HOME, "receipts");
  mkdirSync(receipts, { recursive: true, mode: 0o700 });
  const target = join(receipts, id + ".submit-unverified.frame");
  const temporary = join(receipts, ".debug-frame-" + randomUUID());
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try { writeFileSync(fd, input()); } finally { closeSync(fd); }
    try { linkSync(temporary, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
      throw error;
    }
    atomicWrite(target.replace(/\.frame$/, ".json"), json({ payload_id: id, harness: args[1], pane: args[2],
      expected: args[3], stage: args[4], observed_at: timestamp(), capture_id: run.id, frame: target }));
  } finally { unlinkSync(temporary); }
}

let observation: { frame?: string } | undefined;

export function rememberDebugFrame(frame: string): void {
  if (observation) observation.frame = frame;
}

type Context = { id: string; pane: string; harness: string; sentinel: string; busHome: string; scriptsDir?: string };
type Outcome = { status?: string; action?: string; effect?: string; detail?: string };

export function captureCourierFailure<T extends Outcome>(context: Context, run: () => T, attempt = false): T {
  let recording = false;
  try { recording = activeRun(process.env) !== null; } catch { /* diagnostics cannot block delivery */ }
  if (!recording) return run();
  const previous = observation;
  const current: { frame?: string } = {};
  observation = current;
  const started = new Date().toISOString();
  function capture(args: string[], input: string): void {
    try {
      const leaf = resolve(context.scriptsDir || tapScriptsDir(), "../../../runtime/bun/src/debug-capture.ts");
      const result = spawnSync(ownBun(), [...ownBunFlags(), leaf, ...args], {
        input, encoding: "utf8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, TAP_LOCK_DIR: lockRoot(), TAP_HOME: context.busHome, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      });
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.error || result.status !== 0) process.stderr.write("tap debug: native courier capture failed\n");
    } catch { /* diagnostics never change delivery */ }
  }
  try {
    const result = run();
    if (attempt) {
      capture(["_attempt"], JSON.stringify({ payload_id: context.id, status: result.status,
        detail: result.detail || "", ts_start: started, ts_end: new Date().toISOString() }));
    }
    if (current.frame !== undefined && (result.status === "unverified" || result.action === "unconfirmed")) {
      capture(["_frame", context.id, context.harness, context.pane, context.sentinel, "last-observed"], current.frame);
    }
    return result;
  } finally {
    observation = previous;
  }
}

if (import.meta.main) {
  try { recordDebug(process.argv.slice(2)); }
  catch (error) {
    console.error("tap debug: journal write failed: " + (error as Error).message);
    process.exitCode = 1;
  }
}
