import { acquirePathLock, lockRoot } from "./panelock";
// Private failure evidence from observations the courier already made.
import { appendFileSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { atomicWrite, ensureAscii } from "./fsatomic";
import { redact } from "./verbose";
import { tapScriptsDir, artifactBun } from "./scripts-dir";

export const JOURNAL_SECRET = /key|token|secret|password|passwd|credential|authorization/i;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export const timestamp = () => new Date().toISOString().slice(0, -1) + "000+00:00";
export const json = (value: unknown) => ensureAscii(JSON.stringify(value));

export function readJson(path: string): any {
  try { return JSON.parse(UTF8.decode(readFileSync(path))); } catch { return null; }
}

const alive = (pid: unknown) => {
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

export function safeFields(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") return redact(value, env, JOURNAL_SECRET);
  if (Array.isArray(value)) return value.map(v => safeFields(v, env));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, safeFields(v, env)]));
  return value;
}

/** The opted-in capture, or null when recording is off or stopping. */
function activeRun(env: NodeJS.ProcessEnv): { id: string; directory: string } | null {
  const home = join(env.TAP_INDEX_HOME || join(homedir(), ".tap"), "debug");
  const run = readJson(join(home, "enabled.json"));
  if (!run || (typeof run === "object" && Object.keys(run).length === 0)) return null;
  if (typeof run.directory !== "string" || typeof run.id !== "string") throw new Error("invalid debug capture");
  if (existsSync(join(run.directory, "stop"))) return null;
  return run;
}

/**
 * One `tap.command` journal row, written in-process by the public entry
 * (main.ts). bin/tap execs into Bun, so the caller pid is the command the
 * user ran.
 */
export function recordCommand(args: string[], env: NodeJS.ProcessEnv, callerPid: number): void {
  const run = activeRun(env);
  if (!run) return;
  const home = join(env.TAP_INDEX_HOME || join(homedir(), ".tap"), "debug");
  let hide = false;
  const command = args.map(arg => {
    const value = hide ? "<redacted>" : redact(arg, env, JOURNAL_SECRET);
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
  appendFileSync(join(run.directory, "events.jsonl"), json({ schema: 1, timestamp: timestamp(), capture_id: run.id,
    event: "tap.command", operation_id: randomUUID().replaceAll("-", ""), argv: command,
    caller_pid: callerPid, cwd: process.cwd(), pane: env.TMUX_PANE ?? null, tmux: env.TMUX ?? null, team }) + "\n",
    { mode: 0o600 });
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
  const enabled = join(process.env.TAP_INDEX_HOME || join(homedir(), ".tap"), "debug", "enabled.json");
  if (!existsSync(enabled)) return run();
  const previous = observation;
  const current: { frame?: string } = {};
  observation = current;
  const started = new Date().toISOString();
  function capture(args: string[], input: string): void {
    try {
      const leaf = resolve(context.scriptsDir || tapScriptsDir(), "../../../runtime/bun/src/debug-capture.ts");
      const result = spawnSync(artifactBun() ?? "bun", [leaf, ...args], {
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
