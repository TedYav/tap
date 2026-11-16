// Finite command custodian. It owns the ChildProcess until exit; persisted PIDs
// are diagnostics, never authority to signal a possibly reused process.
import { lstatSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { bunBinary } from "./courier-argv";
import { tapScriptsDir } from "./scripts-dir";
import { publish, read, withLock } from "./watch-lease";
import { ownBunFlags } from "./own-bun";

export interface CommandJob {
  command: string;
  cwd: string;
  fallback: string;
  circle_seconds: number;
  started_at: number;
  heartbeat_at: number;
  phase: "starting" | "running" | "done" | "failed" | "UNOBSERVABLE";
  child_pid?: number;
  custodian_pid?: number;
  child_exit?: number | null;
  child_signal?: string | null;
  tail: string;
  pending: string[];
  kill_requested?: boolean;
  kill_sent?: boolean;
  stopped?: boolean;
  escalated?: boolean;
  original_to?: string;
  unobservable_exit?: number;
  undeliverable?: number;
  delivery_error?: string;
  terminal_deliveries?: Array<{ to: string; id: string; exit_code?: number; result?: string }>;
}
interface JobRow { job?: CommandJob; status: string; due_at: number }
type JobRows = Record<string, JobRow>;
const now = () => Math.floor(Date.now() / 1000);
export const TAIL_BYTES = 8192;
export const OBSERVATION_GRACE = 180;

/** Decode first, then trim on a UTF-8 boundary: replacement bytes count too. */
function decodedTail(raw: Buffer): string {
  const encoded = Buffer.from(raw.toString("utf8"));
  let start = Math.max(0, encoded.length - TAIL_BYTES);
  while (start < encoded.length && (encoded[start]! & 0xc0) === 0x80) start++;
  return encoded.subarray(start).toString("utf8");
}

function rowsAt(state: string): JobRows {
  const rows = read<object>(state);
  if (!rows || typeof rows !== "object" || Array.isArray(rows)) throw new Error("reminders queue is not an object");
  return rows as JobRows;
}

/** Cancellation retains custody so an explicit kill can still reach a live child. */
export function requestKill(state: string, owner: string, id: string): void {
  withLock(state, () => {
    const rows = rowsAt(state);
    const row = rows[id] as (JobRow & { owner: string }) | undefined;
    if (!row?.job) throw new Error("unknown command reminder");
    if (row.owner !== owner) throw new Error("only the scheduling seat can kill this command");
    if (!["starting", "running"].includes(row.job.phase) || now() - row.job.heartbeat_at > OBSERVATION_GRACE) {
      throw new Error("child custody is no longer observable; refusing to signal a stored PID");
    }
    row.job.kill_requested = true;
    publish(state, rows);
  });
}

/** Decide the next wake, using actual settlement rather than transport placement. */
export function commandWake(job: CommandJob, bus: string, at: number): { target?: string; terminal: boolean; suppress?: boolean; text: string } {
  const lost = ["starting", "running"].includes(job.phase) && at - job.heartbeat_at > OBSERVATION_GRACE;
  const terminal = !["starting", "running"].includes(job.phase) || lost;
  if (lost) job.phase = "UNOBSERVABLE";
  if (!terminal && !job.escalated && job.pending.length) {
    const receipts = join(bus, "receipts");
    // A missing receipt is unacknowledged; an unavailable directory is not
    // evidence for escalation. Preserve that distinction without enumerating it.
    if (!statSync(receipts).isDirectory()) throw new Error("receipts is not a directory");
    const acknowledged = job.pending.some(id => {
      try { return lstatSync(join(receipts, `${id}.done`)).isFile(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    });
    if (acknowledged) { job.pending = []; job.undeliverable = 0; }
  }
  if (job.escalated && !terminal) return { terminal: false, suppress: true, text: "" };
  const escalate = !terminal && job.pending.length + (job.undeliverable ?? 0) >= 3;
  const outcome = lost ? "UNOBSERVABLE (custodian observation lost)" :
    job.phase === "UNOBSERVABLE" && job.child_exit === job.unobservable_exit && job.unobservable_exit !== undefined ?
      `UNOBSERVABLE (child exit ${job.child_exit}, declared by --unobservable-exit)` : job.phase;
  const text = `${escalate ? `UNREACHABLE: ${job.pending.length} unacknowledged, ${job.undeliverable ?? 0} undeliverable consecutive circle-backs; stopping circle-backs. The terminal wake will go to ${job.fallback} and the original seat (which may be busy rather than dead).\n` : ""}` +
    `Command ${outcome}. Elapsed ${Math.max(0, at - job.started_at)}s. ` +
    `Child pid=${job.child_pid ?? "unknown"}; last observation=${job.heartbeat_at}; ` +
    `exit=${job.child_exit ?? "unknown"}; signal=${job.child_signal ?? "none"}.\n` +
    `Last delivery error: ${job.delivery_error ?? "none"}.\n` +
    `${job.escalated && terminal ? "Fallback copied because circle-backs stood down; the original seat may be busy rather than dead.\n" : ""}` +
    `Original recipient: ${job.original_to ?? "unknown"}. Command: ${job.command}\nLast output (at most ${TAIL_BYTES} captured bytes):\n${job.tail}`;
  if (escalate) job.escalated = true;
  if (terminal) job.stopped = true;
  return { target: job.escalated ? job.fallback : undefined, terminal, text };
}

export function launchCommand(state: string, id: string, env: NodeJS.ProcessEnv): void {
  const child = spawn(bunBinary(), [...ownBunFlags(bunBinary()), join(tapScriptsDir(), "../../../runtime/bun/src/remind-job.ts"), state, id], {
    detached: true, stdio: "ignore", env,
  });
  child.on("error", error => {
    withLock(state, () => {
      const rows = rowsAt(state), row = rows[id];
      if (row?.job) { row.job.phase = "UNOBSERVABLE"; row.job.tail = String(error); row.due_at = now(); publish(state, rows); }
    });
  });
  child.unref();
}

export async function runCommand(state: string, id: string): Promise<void> {
  let spec: CommandJob | undefined;
  // Claim before spawning: a repeated custodian invocation cannot execute twice.
  withLock(state, () => {
    const rows = rowsAt(state), row = rows[id];
    if (!row?.job || row.job.phase !== "starting" || row.job.custodian_pid) return;
    spec = { ...row.job };
    row.job.custodian_pid = process.pid;
    publish(state, rows);
  });
  if (!spec) return;
  const child = spawn("/bin/sh", ["-c", spec.command], { cwd: spec.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let tail = Buffer.alloc(0), finished = false;
  const capture = (chunk: Buffer) => { tail = Buffer.concat([tail, chunk]).subarray(-TAIL_BYTES); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const update = (phase: CommandJob["phase"], code?: number | null, signal?: string | null) => {
    withLock(state, () => {
      const rows = rowsAt(state), row = rows[id];
      if (!row?.job || row.job.custodian_pid !== process.pid) return;
      Object.assign(row.job, { phase, child_pid: child.pid, heartbeat_at: now(), tail: decodedTail(tail) });
      if (finished) {
        row.job.child_exit = code; row.job.child_signal = signal;
        if (row.status === "scheduled") row.due_at = now();
      } else if (row.job.kill_requested && !row.job.kill_sent && child.pid && child.exitCode === null && child.signalCode === null) {
        // Only this living parent's unreaped child group is signal authority.
        process.kill(-child.pid, "SIGKILL");
        row.job.kill_sent = true;
      }
      publish(state, rows);
    });
  };
  // Observation failure never kills the command. Pipes stay drained to completion.
  const safeUpdate = (...args: Parameters<typeof update>) => { try { update(...args); } catch (e) { process.stderr.write(`remind custodian: ${e}\n`); } };
  let lastWrite = Date.now();
  const timer = setInterval(() => {
    try {
      const job = rowsAt(state)[id]?.job;
      if (Date.now() - lastWrite >= 15_000 || (job?.kill_requested && !job.kill_sent)) {
        safeUpdate("running"); lastWrite = Date.now();
      }
    } catch (e) { process.stderr.write(`remind custodian: ${e}\n`); }
  }, 1000);
  safeUpdate("running");
  await new Promise<void>(resolve => {
    child.once("error", error => {
      finished = true; clearInterval(timer); capture(Buffer.from(String(error)));
      safeUpdate("UNOBSERVABLE"); resolve();
    });
    child.once("exit", (code, signal) => {
      finished = true; clearInterval(timer);
      safeUpdate(code === 0 ? "done" : code === spec!.unobservable_exit ? "UNOBSERVABLE" : "failed", code, signal); resolve();
    });
  });
}

if (import.meta.main) {
  const [state, id] = process.argv.slice(2);
  if (!state || !id) throw new Error("usage: remind-job.ts <state> <id>");
  await runCommand(state, id);
}
