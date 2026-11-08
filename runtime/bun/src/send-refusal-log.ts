// Machine-scope trace of sends refused before placement (tap-i83d9).
//
// A refusal before placement leaves no `.placed` receipt, so the delivery
// reliability census cannot count it. One line per refusal goes to
// `<index home>/send-refusals.log`:
//
//   <UTC time>\t<sender>\t<recipient>\t<team>\t<error id>\t<phase>
//
// The phase is `pre` for a refusal before placement and `withdrawn` for a send
// that placed its canonical, took it back off the bus and refused (tap-4dcii).
// A refused send is written by exactly one of the two. `-` stands for a field
// the refusal came before. No body, preview or detail
// is ever written. The write is best effort and silent: a log failure must not
// change the refusal's exit code, stdout or stderr, and a diagnostic would
// change stderr.
//
// Rotation is by size, and it cannot overwrite anything. Past the cap the
// active log is renamed to a unique generation, `<log>.<UTC stamp>-<pid>-<rand>`,
// and the rotator keeps the newest GENERATIONS_KEPT generations and deletes the
// older ones, so the files stay within about (GENERATIONS_KEPT + 1) x the cap.
// Rotation runs under `<log>.lock`, an in-process flock(2) the kernel drops
// when the holder exits, so there is no stale state to own. The lock makes the
// size re-check and the rename see the same file. Without it, two senders that
// both saw the full log could both rename: the second renamed the fresh active
// file the first had just created and written to, and that near-empty
// generation then counted toward GENERATIONS_KEPT, so a prune could delete it
// with its lines (tap-atnqw). Appends take no lock. What can still be lost:
// lines from an unwritable log; a line from a sender that cannot get the
// rotation lock within ROTATE_LOCK_WAIT_MS while the log is full; and a line
// appended through a descriptor whose generation has already been pruned.
// A full log that cannot be rotated is not appended to, so the bound holds.
import { closeSync, constants, existsSync, fstatSync, openSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { TapError } from "./context";
import { utcStamp } from "./ids";
import { isOldStoreRefusal } from "./register-authority";
import { acquirePathLock } from "./panelock";

export const SEND_REFUSAL_LOG_CAP_BYTES = 1024 * 1024;
export const GENERATIONS_KEPT = 2;
/** How long a sender waits for another sender's rotation before dropping its line. */
export const ROTATE_LOCK_WAIT_MS = 5000;

export interface SendRefusalFields { from?: string; to?: string; team?: string }
export type SendRefusalPhase = "pre" | "withdrawn";

const FIELD_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const ERROR_ID_RE = /^[a-z0-9_]{1,64}$/;
const field = (value: string | undefined): string => (value && FIELD_RE.test(value) ? value : "-");

/**
 * The stable id of a refusal the router renders as a typed refusal: a TapError,
 * or an old_store raised below context.ts (OldStoreError and its kin), which is
 * not a TapError but is just as much a refused send. Anything else is a crash.
 */
export function refusalErrorId(error: unknown): string | null {
  if (error instanceof TapError) return error.errorClass;
  return isOldStoreRefusal(error) ? "old_store" : null;
}

// Set once a send reaches cmdSendOutcome, whose own catch counts its refusals.
// The reply-alias route runs reply preparation before that point; a refusal
// there is a refused send that only the outer route can count, and it must not
// count again once the inner catch has had its chance.
let sendEntered = false;
export function noteSendEntered(): void { sendEntered = true; }
export function recordRefusalBeforeSend(errorId: string, fields: SendRefusalFields = {}): void {
  if (!sendEntered) recordSendRefusal(errorId, fields, "pre");
}

export function sendRefusalLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.TAP_INDEX_HOME || join(homedir(), ".tap"), "send-refusals.log");
}

// Non-blocking, so a FIFO squatting on the path fails the open (ENXIO) instead
// of hanging the refusal; the fstat on the opened descriptor then refuses
// anything that is not a regular file, with no window to swap the path.
function openRegular(path: string): { fd: number; size: number } | null {
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NONBLOCK, 0o600);
  const st = fstatSync(fd);
  if (!st.isFile()) { closeSync(fd); return null; }
  return { fd, size: st.size };
}

const GENERATION_RE = /^send-refusals\.log\.\d{8}T\d{6}Z-\d+-[a-z0-9]{1,8}$/;

/** Generations, oldest first: the stamp leads the name, so name order is time order. */
function generations(dir: string): string[] {
  return readdirSync(dir).filter(name => GENERATION_RE.test(name)).sort();
}

function pruneGenerations(dir: string): void {
  const all = generations(dir);
  for (const name of all.slice(0, Math.max(0, all.length - GENERATIONS_KEPT))) {
    try { unlinkSync(join(dir, name)); } catch { /* a racing prune got it */ }
  }
}

export function recordSendRefusal(errorId: string, fields: SendRefusalFields, phase: SendRefusalPhase, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const path = sendRefusalLogPath(env);
    const dir = dirname(path);
    // A machine with no TAP state has nothing to count: never create the home.
    if (!existsSync(dir)) return;
    const id = ERROR_ID_RE.test(errorId) ? errorId : "unknown";
    const line = Buffer.from(`${utcStamp()}\t${field(fields.from)}\t${field(fields.to)}\t${field(fields.team)}\t${id}\t${phase}\n`);
    let open = openRegular(path);
    if (!open) return;
    if (open.size + line.length > SEND_REFUSAL_LOG_CAP_BYTES) {
      closeSync(open.fd);
      const stamp = utcStamp().replace(/[-:]/g, "");
      const generation = `${path}.${stamp}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      const lock = acquirePathLock(`${path}.lock`, ROTATE_LOCK_WAIT_MS, env);
      // A full file that cannot rotate is not appended to: the bound holds.
      if (!lock) return;
      try {
        // Another sender may have rotated between our size read and the lock.
        if (statSync(path).size + line.length > SEND_REFUSAL_LOG_CAP_BYTES) {
          renameSync(path, generation);
          pruneGenerations(dir);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
      } finally {
        lock.release();
      }
      open = openRegular(path);
      if (!open) return;
    }
    try { writeSync(open.fd, line); } finally { closeSync(open.fd); }
  } catch { /* best effort by contract */ }
}
