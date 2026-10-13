// Same-id retry (delivery decision-v1, L1-L11): a sender's explicit re-ring of an
// existing canonical. One request mints one UUID; that UUID names the spool row,
// the retry attempt license, the submit-phase attempt and the outcome record, so
// a crash at any point leaves attributable pending or unknown work, never a
// recomputed identity. The original `<id>.attempted` is never cleared or reused.
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { receiptBytes } from "./fsatomic";
import { validId } from "./ids";
import { acquireResetMutationLock } from "./reset";

export const RETRY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** `receipts/<id>.retry-<uuid>.attempted`: the variable suffix readers must match. */
export const RETRY_MARKER_SUFFIX = /\.retry-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.attempted$/;
export const RETRY_IDLE_SUBMIT_SUFFIX = /\.retry-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.idle-submit$/;

export type RetryEvent = "request" | "suppressed" | "admitted" | "outcome";
/** `unknown`: the license was spent but no outcome was recorded (a kill or refusal after admission). */
export type RetryOutcome = "suppressed" | "parked" | "refused" | "submission-confirmed" | "harness-queued" | "unverified" | "unknown";
export interface RetryRecord {
  v: 1; id: string; retry: string; ordinal: number; event: RetryEvent; at: string;
  actor?: string; trigger?: "explicit";
  /** Observation state seen when the record was written: the known-redundant evidence. */
  prior?: { state: RecipientState; via?: string; at?: string; attempts: number };
  outcome?: RetryOutcome; detail?: string;
}

/** What the recipient side shows for a message, strongest first. */
export type RecipientState = "cancelled" | "settled" | "observed" | "unobserved";

function check(id: string, uuid?: string): void {
  if (!validId(id)) throw new Error("retry needs a valid id");
  if (uuid !== undefined && !RETRY_UUID.test(uuid)) throw new Error("retry needs a valid retry uuid");
}

export function retryLogPath(home: string, id: string): string {
  check(id);
  return join(home, "receipts", `${id}.retries.jsonl`);
}

export function retryMarkerPath(home: string, id: string, uuid: string): string {
  check(id, uuid);
  return join(home, "receipts", `${id}.retry-${uuid}.attempted`);
}

export function retryIdleSubmitPath(home: string, id: string, uuid: string): string {
  check(id, uuid);
  return join(home, "receipts", `${id}.retry-${uuid}.idle-submit`);
}

/** Append one record, fsynced with its directory: a request precedes any runnable work. */
export function appendRetryRecord(home: string, record: Omit<RetryRecord, "v" | "at">): void {
  check(record.id, record.retry);
  const receipts = join(home, "receipts");
  mkdirSync(receipts, { recursive: true });
  const fd = openSync(retryLogPath(home, record.id), "a", 0o600);
  try { writeFileSync(fd, JSON.stringify({ v: 1, ...record, at: new Date().toISOString() }) + "\n"); fsyncSync(fd); }
  finally { closeSync(fd); }
  const dir = openSync(receipts, "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

/**
 * Every well-formed record, plus how much of the history could not be read:
 * `malformed` counts torn or foreign lines (skipped, never guessed) and
 * `unreadable` says the file exists but could not be read. Readers that
 * report must surface both rather than treat them as an empty history.
 */
export function retryHistory(home: string, id: string): { rows: RetryRecord[]; malformed: number; unreadable: boolean } {
  let raw: string;
  try { raw = readFileSync(retryLogPath(home, id), "utf8"); }
  catch (error) { return { rows: [], malformed: 0, unreadable: (error as NodeJS.ErrnoException).code !== "ENOENT" }; }
  const rows: RetryRecord[] = [];
  let malformed = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as RetryRecord;
      if (row && row.v === 1 && row.id === id && typeof row.retry === "string" && RETRY_UUID.test(row.retry)
        && Number.isSafeInteger(row.ordinal) && typeof row.event === "string") rows.push(row);
      else malformed++;
    } catch { malformed++; /* a torn tail line stays unknown */ }
  }
  return { rows, malformed, unreadable: false };
}

/** Every well-formed record; torn or foreign lines are skipped, never guessed. */
export function retryRecords(home: string, id: string): RetryRecord[] {
  return retryHistory(home, id).rows;
}

/** A requested retry with no terminal record yet: the one a new request coalesces into. */
export function pendingRetry(home: string, id: string): { retry: string; ordinal: number } | null {
  const rows = retryRecords(home, id), closed = new Set<string>();
  for (const row of rows) if (row.event === "suppressed" || row.event === "outcome") closed.add(row.retry);
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.event === "request" && !closed.has(row.retry)) return { retry: row.retry, ordinal: row.ordinal };
  }
  return null;
}

/** Display ordinal only: correlation always uses the uuid. */
export function nextRetryOrdinal(home: string, id: string): number {
  return retryRecords(home, id).reduce((max, row) => Math.max(max, row.ordinal), 0) + 1;
}

/** What a retry license records about its admission, evaluated just before the marker is linked. */
export interface RetryAdmission {
  target: string; pane: string; pane_id: string; instance: string;
  prior_state: RecipientState; prior_via?: string; prior_at?: string;
}

/**
 * The retry's one-shot possible-effect license, modelled on `beginIdleSubmit`:
 * link-atomic, minted under short shared reset custody immediately before the
 * first effect. `beforeCreate` runs after any lock wait and before the marker
 * exists, so the caller's final pane reauthorization is never skipped.
 */
export function beginRetryAttempt(home: string, id: string, uuid: string, beforeCreate?: () => boolean,
  admission?: () => RetryAdmission): "created" | "existing" | "refused" {
  const destination = retryMarkerPath(home, id, uuid);
  const lock = acquireResetMutationLock(home, "courier retry attempt", undefined, "shared");
  try {
    try { lstatSync(destination); return "existing"; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (beforeCreate && !beforeCreate()) return "refused";
    const receipts = join(home, "receipts");
    mkdirSync(receipts, { recursive: true });
    const temporary = join(receipts, `.retry-attempt.${process.pid.toString(36)}.${Math.random().toString(36).slice(2, 10)}`);
    const fd = openSync(temporary, "wx", 0o600);
    try {
      // The license carries its admission evidence (L10): the bound recipient and the
      // observation state checked immediately before the first possible effect.
      try { writeFileSync(fd, receiptBytes({ id, retry: uuid, effect: "possible", admitted_at: new Date().toISOString(), ...admission?.() })); fsyncSync(fd); }
      finally { closeSync(fd); }
      try { linkSync(temporary, destination); return "created"; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return "existing";
        throw error;
      }
    } finally {
      try { unlinkSync(temporary); } catch { /* already absent */ }
    }
  } finally { lock.release(); }
}

/** The retry identity a spool row carries in its meta, or null for an ordinary row. */
export function rowRetry(spoolDir: string, id: string): { retry: string; ordinal: number } | null {
  try {
    const meta = JSON.parse(readFileSync(join(spoolDir, `${id}.meta.json`), "utf8")) as { retry?: unknown; retry_ordinal?: unknown };
    if (typeof meta.retry === "string" && RETRY_UUID.test(meta.retry)) {
      return { retry: meta.retry, ordinal: Number.isSafeInteger(meta.retry_ordinal) ? Number(meta.retry_ordinal) : 0 };
    }
  } catch { /* no meta, or unreadable: not a retry row */ }
  return null;
}

/**
 * A retry row whose own license is already spent, except an unfinished staged-idle
 * hold whose Enter license remains unspent. Such a row can
 * never ring again: the caller retires it with an `unknown` outcome unless one
 * is already recorded, so a later explicit resend can mint a fresh retry. The
 * caller also excludes a pending reprobe, which verifies without new keys.
 */
export function spentRetryRow(home: string, spoolDir: string, id: string): { retry: string; ordinal: number } | null {
  const retry = rowRetry(spoolDir, id);
  if (!retry || !exists(retryMarkerPath(home, id, retry.retry))) return null;
  if (metaReason(spoolDir, id) === "staged-idle" && !exists(retryIdleSubmitPath(home, id, retry.retry)) && !retryClosed(home, id, retry.retry)) return null;
  return retry;
}

/**
 * An ORIGINAL (non-retry) park whose own `<id>.attempted` is spent and which is
 * not a staged-idle hold: the courier never rings it again after a possible
 * effect, so an explicit resend must not coalesce into it. The caller also
 * excludes a pending reprobe.
 */
export function spentOriginalPark(home: string, spoolDir: string, id: string): boolean {
  check(id);
  // Unreadable metadata is unknown, never spent: the drain already refuses such a row safely.
  const reason = metaReason(spoolDir, id);
  return reason !== null && reason !== "staged-idle" && exists(join(spoolDir, `${id}.md`)) && !rowRetry(spoolDir, id)
    && exists(join(home, "receipts", `${id}.attempted`));
}

/**
 * Move a retiring row's body home before its spool entry is removed. True only
 * when the canonical is then a regular file holding the body: either the move
 * succeeded, or a byte-identical regular canonical was already there. On any
 * other state (a failed move, a conflicting or non-file canonical, no body at
 * all) it returns false and the caller must keep the row: removeEntry deletes
 * the spool body, so retiring without a proven canonical would lose the message.
 */
export function returnBodyHome(spoolBody: string, canonical: string): boolean {
  try {
    const home = lstatSync(canonical, { throwIfNoEntry: false });
    const parked = lstatSync(spoolBody, { throwIfNoEntry: false });
    if (home) {
      if (!home.isFile()) return false;
      if (!parked) return true;
      return parked.isFile() && readFileSync(canonical).equals(readFileSync(spoolBody));
    }
    if (!parked?.isFile()) return false;
    renameSync(spoolBody, canonical);
    return lstatSync(canonical, { throwIfNoEntry: false })?.isFile() === true;
  } catch { return false; }
}

function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

/** A spool row's `reason`, "" when absent, or null when its metadata is missing or unreadable. */
function metaReason(spoolDir: string, id: string): string | null {
  try {
    const meta = JSON.parse(readFileSync(join(spoolDir, `${id}.meta.json`), "utf8")) as { reason?: unknown } | null;
    if (!meta || typeof meta !== "object") return null;
    return typeof meta.reason === "string" ? meta.reason : "";
  } catch { return null; }
}

/** Whether a retry already has a recorded outcome or suppression. */
export function retryClosed(home: string, id: string, uuid: string): boolean {
  return retryRecords(home, id).some(row => row.retry === uuid && (row.event === "outcome" || row.event === "suppressed"));
}

/**
 * The possible-effect marker that governs THIS row's current attempt: the retry
 * license for a retry row, the original attempt marker otherwise. Generic
 * no-effect proofs must not use this; they still remember every attempt.
 */
export function currentAttemptMarker(home: string, spoolDir: string, id: string): string {
  const retry = rowRetry(spoolDir, id);
  return retry ? retryMarkerPath(home, id, retry.retry) : join(home, "receipts", `${id}.attempted`);
}

/** Count of possible-effect pane attempts recorded so far: the original plus admitted retries. */
export function attemptCount(home: string, id: string): number {
  let count = 0;
  try { lstatSync(join(home, "receipts", `${id}.attempted`)); count++; } catch { /* none */ }
  let names: string[] = [];
  try { names = readdirSync(join(home, "receipts")); } catch { return count; }
  for (const name of names) if (name.startsWith(`${id}.retry-`) && RETRY_MARKER_SUFFIX.test(name)) count++;
  return count;
}
