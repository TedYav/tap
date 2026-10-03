// Durable compaction witnesses. Capture at Enter, then read only that session.
import { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Seat } from "./registry";
import type { PaneEffects } from "./courier";
import { transcriptIdentity } from "./self-rebrief";

export type ProofMode = "claude" | "opencode";
export interface CompactionBoundary {
  mode: ProofMode; path: string; session: string; since: number; dev: number; ino: number;
  offset: number; anchor: string;
}
export interface CompactionProof { evidence: "transcript-proven" | "store-proven"; compactedAt: string }

function read(fd: number, start: number, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  return bytes.subarray(0, readSync(fd, bytes, 0, length, start));
}

/** OpenCode registers a database, not a per-conversation transcript file. */
export function compactionWitnessPath(harness: string, seat: Seat | undefined): string {
  return String(harness === "opencode" ? seat?.session_store_path || seat?.transcript_path || "" : seat?.transcript_path ?? "");
}

/** Missing binding is not an excuse to downgrade to chrome: both families have a durable witness. */
export function captureCompactionBoundary(mode: ProofMode, seat: Seat, now = Date.now()): CompactionBoundary {
  const path = compactionWitnessPath(mode, seat), session = String(seat.harness_session_id ?? "");
  if (!isAbsolute(path) || !session) throw new Error("compaction needs a bound native session and transcript/store");
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error("compaction witness is not a regular file");
  let offset = 0, anchor = "";
  if (mode === "claude") {
    if (!transcriptIdentity(path, mode, session)) throw new Error("compaction transcript identity is unverified");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      offset = fstatSync(fd).size;
      anchor = read(fd, Math.max(0, offset - 64), Math.min(offset, 64)).toString("hex");
    } finally { closeSync(fd); }
  } else {
    const db = new Database(path, { readonly: true });
    try {
      if (!db.query("SELECT id FROM session WHERE id = ?").get(session)) throw new Error("compaction session is absent from the bound store");
      offset = (db.query("SELECT COALESCE(MAX(rowid), 0) AS n FROM message").get() as { n: number }).n;
    } finally { db.close(); }
  }
  return { mode, path, session, since: now, dev: stat.dev, ino: stat.ino, offset, anchor };
}

/** Wrap the actual Enter, not invocation/arming time. Never permit a second Enter. */
export function compactionEnterEffects(mode: ProofMode, seat: Seat, base: PaneEffects,
  captured: (boundary: CompactionBoundary) => void): PaneEffects {
  let entered = false;
  return { ...base, pressEnter: target => {
    if (entered) return false; // A possible first effect is never replayed.
    const boundary = captureCompactionBoundary(mode, seat);
    entered = true;
    captured(boundary);
    return base.pressEnter(target);
  } };
}

/**
 * Session-bounded: `m.session_id = ?` rides `message_session_time_created_id_idx`, `rowid > ?` is
 * answered from the index entry, and the parent is a primary-key lookup, so no row of another
 * session is read or JSON-decoded (tap-2zzft; the test pins the plan).
 */
export const OPENCODE_COMPACTION_SQL = `SELECT json_extract(m.data, '$.time.completed') AS completed
  FROM message m INDEXED BY message_session_time_created_id_idx JOIN message parent ON parent.id = json_extract(m.data, '$.parentID')
  WHERE m.session_id = ? AND parent.session_id = m.session_id
    AND m.rowid > ? AND parent.rowid > ?
    AND json_extract(parent.data, '$.role') = 'user'
    AND json_extract(m.data, '$.role') = 'assistant'
    AND json_extract(m.data, '$.summary') = 1
    AND json_extract(m.data, '$.finish') = 'stop'
    AND json_extract(m.data, '$.error') IS NULL
    AND json_extract(parent.data, '$.time.created') > ?
    AND json_extract(m.data, '$.time.created') > ?
    AND json_extract(m.data, '$.time.completed') > ?
    AND EXISTS (SELECT 1 FROM part p INDEXED BY part_message_id_id_idx WHERE p.message_id = parent.id
      AND p.session_id = m.session_id AND json_extract(p.data, '$.type') = 'compaction')
  ORDER BY m.rowid LIMIT 1`;

export function readCompactionProof(boundary: CompactionBoundary): CompactionProof | null {
  const { path, session, since, offset, mode } = boundary;
  if (!isAbsolute(path) || !session || !Number.isFinite(since) || !Number.isSafeInteger(offset) || offset < 0) return null;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.dev !== boundary.dev || stat.ino !== boundary.ino) return null;
    if (mode === "opencode") {
      const db = new Database(path, { readonly: true });
      try {
        // OpenCode consumes a summary only when its parent has a compaction part
        // and the summary has finished without an error. A request alone is not proof.
        const row = db.query(OPENCODE_COMPACTION_SQL).get(session, offset, offset, since, since, since) as { completed: number } | null;
        return row && typeof row.completed === "number" && Number.isFinite(row.completed)
          ? { evidence: "store-proven", compactedAt: new Date(row.completed).toISOString() } : null;
      } finally { db.close(); }
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const current = fstatSync(fd);
      if (current.dev !== boundary.dev || current.ino !== boundary.ino || current.size < offset) return null;
      if (read(fd, Math.max(0, offset - 64), Math.min(offset, 64)).toString("hex") !== boundary.anchor) return null;
      // Bounded tail: skipping old output may miss a witness, never invent one.
      const start = Math.max(offset, current.size - 2 * 1024 * 1024);
      let text = read(fd, start, current.size - start).toString("utf8");
      if (start > 0 && read(fd, start - 1, 1)[0] !== 10) {
        const newline = text.indexOf("\n");
        if (newline < 0) return null;
        text = text.slice(newline + 1);
      }
      text = text.slice(0, text.lastIndexOf("\n") + 1);
      for (const line of text.split("\n")) {
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.sessionId !== session || event.isSidechain === true || event.type !== "user" ||
          event.isCompactSummary !== true || event.isVisibleInTranscriptOnly !== true) continue;
        if (typeof event.timestamp === "string" && Date.parse(event.timestamp) > since) {
          return { evidence: "transcript-proven", compactedAt: event.timestamp };
        }
      }
      return null;
    } finally { closeSync(fd); }
  } catch { return null; }
}

/** A final boundary scan admits proof arriving during the last wait, without extending the deadline. */
export async function waitForCompactionProof(boundary: CompactionBoundary,
  fx: { valid(): boolean; wait(): Promise<void>; now(): number }, timeout: number): Promise<CompactionProof | null> {
  const deadline = fx.now() + timeout;
  for (;;) {
    if (!fx.valid()) throw new Error("identity: seat or native session changed while awaiting compaction proof");
    const proof = readCompactionProof(boundary);
    if (proof || fx.now() >= deadline) return proof;
    await fx.wait();
  }
}
