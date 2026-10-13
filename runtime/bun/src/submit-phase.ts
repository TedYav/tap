import {harnessQueued,hasTerminalQueueReceipt,recipientState} from "./harness-queue";
// Positive submission evidence only. These rows never authorize a retry.
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validId } from "./ids";
import { readRun } from "./recovery/state";
import { RETRY_UUID, retryIdleSubmitPath, retryMarkerPath } from "./retry";

export type SubmitPhase = "interrupt-intent" | "interrupt-sent" | "injected-text-confirmed" | "Enter-intent" | "completion-Enter-intent" | "Enter-sent" | "verify-result";
export interface InterruptDetails {
  pane: string; harness: string; method: "keys" | "bare-submit";
  keys: string[]; cancellation: "unknown"; tmux_confirmed: boolean;
  draft_backup?: string; draft_backup_error?: string;
}
export type InterruptFact = InterruptDetails;
export type PhaseRecorder = (name: SubmitPhase, result?: string, interrupt?: InterruptDetails) => boolean | void;
export interface PhaseRow {
  v: 1; id: string; attempt: string; phase: SubmitPhase; at: string;
  recipient: string; enter_count: number; ordinal?: number; result?: string; recovery_id?: string;
  interrupt?: InterruptDetails;
}
const phases = new Set<SubmitPhase>(["interrupt-intent", "interrupt-sent", "injected-text-confirmed", "Enter-intent", "completion-Enter-intent", "Enter-sent", "verify-result"]);
function phasePath(home: string, id: string): string {
  if (!validId(id)) throw new Error("invalid submission evidence id");
  return join(home, "receipts", `${id}.submit-phases.jsonl`);
}
export function recordPhase(home: string, row: Omit<PhaseRow, "v" | "at">): void {
  if (!row.attempt || !phases.has(row.phase) || !Number.isSafeInteger(row.enter_count) || row.enter_count < 0) throw new Error("invalid submission phase");
  let evidenceHome = home, recoveryId = row.recovery_id;
  if (process.env.TAP_RECOVERY_RUN) {
    const run = readRun(process.env.TAP_RECOVERY_RUN);
    const payload = run.submission?.id === row.id ? run.submission : run.payloads.find(p => p.id === row.id);
    if (payload && run.target.handle === row.recipient) { evidenceHome = payload.home; recoveryId = run.id; }
  }
  const path = phasePath(evidenceHome, row.id);
  mkdirSync(join(evidenceHome, "receipts"), { recursive: true });
  const fd = openSync(path, "a", 0o600);
  try { writeFileSync(fd, JSON.stringify({ ...row, recovery_id: recoveryId, v: 1, at: new Date().toISOString() }) + "\n"); fsyncSync(fd); }
  finally { closeSync(fd); }
  const dir = openSync(join(evidenceHome, "receipts"), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
export function phaseRows(home: string, id: string): PhaseRow[] {
  let raw: string;
  try { raw = readFileSync(phasePath(home, id), "utf8"); } catch { return []; }
  const rows: PhaseRow[] = [];
  // A torn final row is not positive evidence. Preserve earlier complete rows.
  for (const line of raw.split("\n").slice(0, -1)) {
    try {
      const row = JSON.parse(line);
      if (row.v === 1 && row.id === id && typeof row.attempt === "string" && row.attempt &&
          phases.has(row.phase) && typeof row.recipient === "string" && Number.isSafeInteger(row.enter_count) && row.enter_count >= 0) rows.push(row);
    } catch { /* unknown row */ }
  }
  return rows;
}
export function pendingReprobe(home: string, id: string): boolean {
  if (!validId(id)) return false;
  let meta: unknown;
  try { meta = JSON.parse(readFileSync(join(home, "spool", `${id}.meta.json`), "utf8")); }
  catch { return false; }
  if (!meta || typeof meta !== "object" || Array.isArray(meta) || (meta as Record<string, unknown>).reason !== "pending-input") return false;
  const rows = phaseRows(home, id);
  const injected = rows.findLast(row => row.phase === "injected-text-confirmed");
  if (!injected) return false;
  const attempt = rows.filter(row => row.attempt === injected.attempt);
  if (attempt.some(row => row.phase === "interrupt-intent" || row.phase === "interrupt-sent")) return false;
  const result = attempt.findLast(row => row.phase === "verify-result");
  if (result?.result !== "unverified" || result.enter_count !== 0) return false;
  return !attempt.some(row => row.phase === "Enter-intent" || row.phase === "Enter-sent");
}

/**
 * The idle-time staged-sentinel submit's evidence core (tap-9lqa7): the
 * submit-phase rows and receipts alone, without any spool-metadata claim, so
 * the park decisions (send/drain rc 5) and the hold's eligibility predicate
 * read the same facts. True iff the last landed attempt ended unverified (any
 * enter_count — stop-ambiguous included), no idle-submit license was spent,
 * and no settlement or queue receipt supersedes the unfinished attempt.
 */
export function stagedIdleEvidence(home: string, id: string, retry?: string): boolean {
  if (!validId(id)) return false;
  let admitted = 0;
  if (retry !== undefined) {
    try {
      const path = retryMarkerPath(home, id, retry);
      if (!lstatSync(path).isFile()) return false;
      const marker = JSON.parse(readFileSync(path, "utf8"));
      if (marker?.id !== id || marker.retry !== retry || marker.effect !== "possible" || typeof marker.admitted_at !== "string") return false;
      admitted = Date.parse(marker.admitted_at);
      if (!Number.isFinite(admitted) || new Date(admitted).toISOString() !== marker.admitted_at) return false;
    } catch { return false; }
    if (recipientState(home, id).state !== "unobserved") return false;
  }
  try { lstatSync(retry === undefined ? join(home, "receipts", `${id}.idle-submit`) : retryIdleSubmitPath(home, id, retry)); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
  // Retries may ignore only proven older transport receipts; uncertainty ends authority.
  for (const suffix of retry === undefined ? ["sent", "read", "done", "cancelled", "harness-queued"]
    : ["sent", "read", "authorized-read", "idle-submit", "done", "cancelled", "harness-queued"]) {
    try {
      const path = join(home, "receipts", `${id}.${suffix}`), stat = lstatSync(path);
      if (retry === undefined || suffix === "done" || suffix === "cancelled" || suffix === "authorized-read" || !stat.isFile()) return false;
      if (suffix === "read") {
        const read = JSON.parse(readFileSync(path, "utf8"));
        if (read?.id === id && typeof read.by === "string" && read.by
          && (read.forced === true || read.forced === "true" || read.reason === "instance_retired")) continue;
        return false;
      }
      if (suffix === "harness-queued") {
        const queued = JSON.parse(readFileSync(path, "utf8"));
        if (queued?.id !== id || queued.status !== "queued" || queued.delivery !== "harness-queue" || typeof queued.at !== "string") return false;
        const at = Date.parse(queued.at);
        const iso = new Date(at).toISOString();
        if (queued.at !== iso && queued.at !== iso.replace(".000Z", "Z")) return false;
        // Whole-second stamps overlap admission within that second; unknown order refuses.
        const resolution = /:\d{2}\.\d/.test(queued.at) ? 1 : 1000;
        if (!Number.isFinite(at) || at + resolution > admitted) return false;
      } else if (stat.mtimeMs >= admitted) return false;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
  }
  const rows = phaseRows(home, id);
  const injected = rows.findLast(row => row.phase === "injected-text-confirmed");
  if (!injected || (retry !== undefined && injected.attempt !== retry)) return false;
  const result = rows.findLast(row => row.attempt === injected.attempt && row.phase === "verify-result");
  return result?.result === "unverified";
}

/**
 * A staged-idle hold's full eligibility, a sibling of `pendingReprobe` — which
 * stays untouched and keeps refusing Enter rows. The spool metadata must name
 * the hold (`reason: staged-idle`) AND the evidence core must hold. The
 * link-atomic idle-submit license (retry-scoped when present) caps the whole
 * path at one automatic Enter per staged observation.
 */
export function stagedIdleSubmitEligible(home: string, id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!validId(id)) return false;
  let meta: unknown;
  try { meta = JSON.parse(readFileSync(join(home, "spool", `${id}.meta.json`), "utf8")); }
  catch { return false; }
  if (!meta || typeof meta !== "object" || Array.isArray(meta) || (meta as Record<string, unknown>).reason !== "staged-idle") return false;
  // The window bounds the automatic Enter itself, not only the post-hoc
  // disposition: once the deadline has passed the row is the manual path's
  // (tap nudge), never a fresh Enter authority. Accepts the seconds epoch in
  // either mint form (number or numeric string); absent or malformed is
  // expired-by-default.
  const rawDeadline = (meta as Record<string, unknown>).deadline_epoch;
  const deadline = typeof rawDeadline === "number" ? (Number.isSafeInteger(rawDeadline) ? rawDeadline : null)
    : typeof rawDeadline === "string" && /^[0-9]+$/.test(rawDeadline) ? Number(rawDeadline) : null;
  if (deadline === null) return false;
  const now = env.TAP_SPOOL_NOW && /^[0-9]+$/.test(env.TAP_SPOOL_NOW)
    ? Number(env.TAP_SPOOL_NOW) : Math.floor(Date.now() / 1000);
  if (now >= deadline) return false;
  const retry = (meta as Record<string, unknown>).retry;
  if (retry !== undefined && (typeof retry !== "string" || !RETRY_UUID.test(retry))) return false;
  return stagedIdleEvidence(home, id, retry as string | undefined);
}

/** Effect evidence cannot identify the harness work that a key cancelled. */
/** tap-1i81h: Claude renders a cancelled tool call as the user's stop order. */
export const AGENT_INTERRUPT_ATTRIBUTION = "This message may have interrupted you. The user did not interrupt you: "
  + "this was an automated interruption from another agent that needed your attention.";
export function interruptNotice(home: string, id: string): string | null {
  const rows = phaseRows(home, id);
  const intent = rows.findLast(row => row.phase === "interrupt-intent");
  if (!intent) return null;
  const sent = rows.some(row => row.attempt === intent.attempt && row.phase === "interrupt-sent");
  const backup = intent.interrupt?.draft_backup;
  const failed = intent.interrupt?.draft_backup_error;
  return `${AGENT_INTERRUPT_ATTRIBUTION} Interrupt ${sent ? "input sent" : "attempt recorded; input acceptance unconfirmed"} for ${id}. `
    + "The recipient's turn or tool call may have been cancelled and a persistent goal may be paused. "
    + "TAP cannot identify cancelled work or confirm its completion; inspect in-flight work before continuing. "
    + (backup ? `Visible draft snapshot: ${backup}. ` : failed ? "Visible draft backup failed. " : "")
    + "Draft backups cannot restore a cancelled turn or tool call.";
}
export function unresolvedInjection(home: string, id: string): string | null {
  if (harnessQueued(home,id)) return "queued in harness; recipient processing unconfirmed";
  const rows = phaseRows(home, id);
  const injected = rows.findLast(row => row.phase === "injected-text-confirmed");
  if (!injected) return null;
  const result = rows.findLast(row => row.attempt === injected.attempt && row.phase === "verify-result");
  if (result?.result === "verified") return null;
  if (result?.result === "queued") return hasTerminalQueueReceipt(home,id) ? null : "queued in harness; recipient processing unconfirmed";
  // Canonical receipts from a later nudge/read supersede an unfinished attempt.
  for (const suffix of ["sent", "read", "done", "cancelled"]) {
    try { const receipt = JSON.parse(readFileSync(join(home, "receipts", `${id}.${suffix}`), "utf8"));
      if (receipt && typeof receipt === "object") return null;
    } catch { /* no positive settlement/delivery record */ }
  }
  if (pendingReprobe(home, id)) return "injected; Enter pending re-probe.";
  const recipient = /^[A-Za-z0-9_.-]+$/.test(injected.recipient) ? injected.recipient : "<seat>";
  return `injected; Enter unconfirmed (possible effect). If the sentinel is still staged, run tap nudge ${recipient}.`;
}
if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args[0] === "reprobe-pending") {
      if (!args[1] || !args[2]) throw new Error("reprobe evidence arguments required");
      console.log(pendingReprobe(args[1], args[2]) ? "yes" : "no");
      process.exit(0);
    }
    const [home, id, attempt, phase, recipient = "", count = "0", ordinal, result] = args;
    if (!home || !id || !attempt || !phase) throw new Error("submission evidence arguments required");
    recordPhase(home, { id, attempt, phase: phase as SubmitPhase, recipient, enter_count: Number(count), ordinal: ordinal ? Number(ordinal) : undefined, result });
  } catch (error) { console.error(`tap: submission evidence unavailable: ${error}`); process.exitCode = 1; }
}
