// The stuck-readiness alarm's evidence (tap-bprtg). A seat whose mail is held as
// booting or no-prompt past a bound, while its harness positively shows no turn in
// progress and no activity across that bound, is probably misread. This module
// only answers "is the harness provably quiet"; the drain owns the notice. It
// observes files and the OpenCode store read-only and never touches a pane.
//
// Positive evidence only. A stale transcript alone is not quiet: a long blocking
// tool call writes nothing. Each instrument therefore needs BOTH a terminal
// turn marker and no growth across the bound. Anything it cannot read, or a
// harness with no instrument, answers "not quiet", which never alarms.
import { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { Seat } from "./registry";
import { acquirePathLock, lockRoot, type PaneLock } from "./panelock";
import { createHash } from "node:crypto";
import { opencodeStorePath } from "./opencode-store";

/** The no-band holds a misread can produce. Named holds (modal, shell mode, feedback draft) have their own alarms. */
export const STALL_VERDICTS: ReadonlySet<string> = new Set(["busy:booting", "busy:noprompt", "busy:overprint"]);

export const STALL_DEFAULT_SECONDS = 600;

/** `TAP_STUCK_READINESS_SECONDS`, a positive integer; anything else is the default. */
export function stallBoundSeconds(env: NodeJS.ProcessEnv): number {
  const raw = env.TAP_STUCK_READINESS_SECONDS ?? "";
  return /^[0-9]+$/.test(raw) && Number(raw) > 0 ? Number(raw) : STALL_DEFAULT_SECONDS;
}

/** How much of a transcript's end the turn-marker scan reads. */
const TAIL_BYTES = 256 * 1024;

export interface BoundTranscript {
  path: string; fileId: string; size: number; start: number; bytes: Buffer; lines: string[]; mtime: number;
}
function tailLines(path: string, binding?: { harness: "claude" | "codex"; id: string }): BoundTranscript | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const start = Math.max(0, st.size - TAIL_BYTES);
    const buf = Buffer.alloc(st.size - start);
    const n = readSync(fd, buf, 0, buf.length, start);
    const lines = buf.subarray(0, n).toString("utf8").split("\n");
    // A partial first line is a cut, not a record.
    if (start > 0) lines.shift();
    if (binding) {
      if (!binding.id) return null;
      if (binding.harness === "codex") {
        const head = Buffer.alloc(Math.min(st.size, 65536));
        const bytes = readSync(fd, head, 0, head.length, 0);
        const meta = head.subarray(0, bytes).toString("utf8").split("\n").map(parsed).find(row => row?.type === "session_meta");
        if (obj(meta?.payload).id !== binding.id) return null;
      } else {
        const messages = lines.map(parsed).filter(row => row?.type === "user" || row?.type === "assistant");
        if (!messages.length || messages.some(row => row?.sessionId !== binding.id || row?.isSidechain === true)) return null;
      }
    }
    if (n !== buf.length || fstatSync(fd).size !== st.size) return null;
    return { path, fileId: `${st.dev}:${st.ino}`, size: st.size, start, bytes: buf, lines, mtime: st.mtimeMs / 1000 };
  } catch { return null; } finally { closeSync(fd); }
}

function parsed(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
}

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};

/**
 * A transcript's last turn. Three answers, because only two are evidence: ended,
 * in progress (`ended: false`), or unknown (`null`). A newer record that does not
 * parse, a torn append say, is unknown rather than a reason to fall back to an
 * older end marker; so is a tail with no turn marker at all. Unknown neither
 * alarms nor counts as recovery. `at` is the ending record's own timestamp
 * (epoch seconds), never a file time; null while in progress or when the record
 * carries no readable timestamp.
 */
export type Turn = { ended: boolean; at: number | null } | null;

/** A record's own ISO `timestamp`, in epoch seconds. */
function recordTime(e: Record<string, unknown>): number | null {
  const ms = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
  return Number.isFinite(ms) ? ms / 1000 : null;
}

/**
 * Claude: the last user/assistant entry is an assistant message that ended its
 * turn (`end_turn` or `stop_sequence`). A trailing user entry, or an assistant
 * entry with any other stop reason (`tool_use`, still streaming), is a turn in progress.
 */
export function claudeTurn(lines: readonly string[]): Turn {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.trim()) continue;
    const e = parsed(lines[i]!);
    if (!e) return null;
    if (e.type !== "assistant" && e.type !== "user") continue;
    if (e.type === "user") return { ended: false, at: null };
    const stop = obj(e.message).stop_reason;
    return stop === "end_turn" || stop === "stop_sequence" ? { ended: true, at: recordTime(e) } : { ended: false, at: null };
  }
  return null;
}

/** Codex: the last task boundary event is a completion or an abort (ended) or a start (in progress). */
export function codexTurn(lines: readonly string[]): Turn {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.trim()) continue;
    const e = parsed(lines[i]!);
    if (!e) return null;
    if (e.type !== "event_msg") continue;
    const kind = obj(e.payload).type;
    if (kind === "task_started") return { ended: false, at: null };
    if (kind === "task_complete" || kind === "turn_aborted") return { ended: true, at: recordTime(e) };
  }
  return null;
}

function claudeProjectsDir(env: NodeJS.ProcessEnv): string {
  return join(env.TAP_CLAUDE_HOME || env.CLAUDE_HOME || join(env.HOME || homedir(), ".claude"), "projects");
}

/** The seat's Claude transcript: the registered path, else `<session>.jsonl` in a projects directory. */
function claudeTranscript(seat: Seat, env: NodeJS.ProcessEnv): string {
  const registered = typeof seat.transcript_path === "string" ? seat.transcript_path : "";
  if (registered) return isAbsolute(registered) ? registered : "";
  const sid = typeof seat.harness_session_id === "string" ? seat.harness_session_id : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(sid)) return "";
  const projects = claudeProjectsDir(env);
  let dirs: string[] = [];
  try { dirs = readdirSync(projects); } catch { return ""; }
  for (const d of dirs) {
    if (d.startsWith(".")) continue;
    const path = join(projects, d, `${sid}.jsonl`);
    try { if (statSync(path).isFile()) return path; } catch { /* not here */ }
  }
  return "";
}

/**
 * What the harness itself shows: whether its last turn ended, when it last wrote
 * (the activity clock), and `at`, the turn's own completion time (non-null only
 * when `ended` and the ending record carries one; tap-i5fzq's turn_ended_at).
 */
export interface HarnessEvidence { ended: boolean; lastActivity: number; at: number | null }

function transcriptEvidence(path: string, scan: (lines: readonly string[]) => Turn, binding?: { harness: "claude" | "codex"; id: string }): HarnessEvidence | null {
  if (!path || !isAbsolute(path)) return null;
  const t = tailLines(path, binding);
  const turn = t ? scan(t.lines) : null;
  return t && turn ? { ended: turn.ended, lastActivity: t.mtime, at: turn.ended ? turn.at : null } : null;
}

/**
 * One index seek on `session_message_session_seq_idx (session_id, seq)`:
 * the operator's store is ~100 GB, so filtering or ordering on `json_extract` would
 * decode every row of every session (tap-2zzft). JSON stays in the SELECT list only.
 * INDEXED BY makes a store without that index fail (unknown evidence) instead of silently scanning.
 */
export const OPENCODE_EVIDENCE_SQL = `SELECT type, time_created AS created, time_updated AS updated, json_extract(data, '$.time.completed') AS completed
  FROM session_message INDEXED BY session_message_session_seq_idx WHERE session_id = ?
  ORDER BY seq DESC LIMIT 1`;

/**
 * OpenCode 2 ends a turn with an `idle` row, for any outcome. A newer row of
 * any other type is work, including input queued after that marker. The marker's
 * native creation time dates the end; an assistant finish alone is not proof.
 */
export function opencodeEvidence(sessionId: string, env: NodeJS.ProcessEnv): HarnessEvidence | null {
  if (!sessionId) return null;
  const path = opencodeStorePath(env);
  try { if (!statSync(path).isFile()) return null; } catch { return null; }
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    const row = db.query(OPENCODE_EVIDENCE_SQL).get(sessionId) as
      { type: unknown; created: unknown; updated: unknown; completed: unknown } | null;
    if (!row || typeof row.created !== "number" || !Number.isFinite(row.created)) return null;
    const completed = typeof row.completed === "number" && Number.isFinite(row.completed) ? row.completed : null;
    const updated = typeof row.updated === "number" && Number.isFinite(row.updated) ? row.updated : null;
    const ended = row.type === "idle";
    return { ended, lastActivity: Math.max(row.created, updated ?? 0, completed ?? 0) / 1000, at: ended ? row.created / 1000 : null };
  } catch { return null; } finally { db?.close(); }
}

/** The instrument each harness uses; null is "unknown", which never alarms. */
export function harnessEvidence(harness: string, seat: Seat, env: NodeJS.ProcessEnv, requireSessionMatch = false): HarnessEvidence | null {
  const fam = (name: string) => harness === name || harness.startsWith(`${name}-`);
  const id = typeof seat.harness_session_id === "string" ? seat.harness_session_id : "";
  if (fam("claude")) return transcriptEvidence(claudeTranscript(seat, env), claudeTurn, requireSessionMatch ? { harness: "claude", id } : undefined);
  if (fam("codex")) return transcriptEvidence(typeof seat.transcript_path === "string" ? seat.transcript_path : "", codexTurn, requireSessionMatch ? { harness: "codex", id } : undefined);
  if (fam("opencode")) return opencodeEvidence(typeof seat.harness_session_id === "string" ? seat.harness_session_id : "", env);
  return null;
}

/** A bounded byte position and suffix from the same identity-checked descriptor as readiness evidence. */
export function readBoundTranscript(harness: string, seat: Seat, env = process.env): BoundTranscript | null {
  if (harness !== "claude" && harness !== "codex") return null;
  const path = harness === "claude" ? claudeTranscript(seat, env) : typeof seat.transcript_path === "string" ? seat.transcript_path : "";
  const id = typeof seat.harness_session_id === "string" ? seat.harness_session_id : "";
  return path && isAbsolute(path) && id ? tailLines(path, { harness, id }) : null;
}

// --- the episode record ------------------------------------------------------------------
//
// `<bus home>/seat-state/<handle>.<binding key>.stall.json`: one stuck episode for one
// recipient binding. The key hashes the target registry with the handle, because a
// handle alone is not a binding across teams sharing a bus; pane and instance live
// in the record, so a rebind starts a new episode in place. Its only writer and only
// reader is the drain's stall hook; delivery, custody and deadlines never read it.
// Every failure means "no alarm". Reset checkpoints seat-state/; teardown removes
// it with the seat's other seat-state files.

/** One recipient as the drain addresses it. */
export interface StallBinding { home: string; registry: string; handle: string; paneId: string; instance: string }

interface Episode {
  schema: 1; seat: string; registry: string; pane_id: string; instance: string;
  since: number; last_seen: number; notified: string[];
}

const HANDLE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 16 hex digits naming (registry, handle); the file, the lock and the notice ids all carry it. */
export function bindingKey(registry: string, handle: string): string {
  return createHash("sha256").update(`${registry}\x1f${handle}`).digest("hex").slice(0, 16);
}

export function episodePath(b: Pick<StallBinding, "home" | "registry" | "handle">): string | null {
  return HANDLE.test(b.handle) && b.registry
    ? join(b.home, "seat-state", `${b.handle}.${bindingKey(b.registry, b.handle)}.stall.json`) : null;
}

/** The durable notice id for an episode's sender copy; the leader copy appends `-leader`. */
export function stallNoticeId(b: Pick<StallBinding, "registry" | "handle">, since: number): string {
  return `stall-${b.handle}-${bindingKey(b.registry, b.handle)}-${Math.floor(since)}`;
}

function readEpisode(path: string, b: StallBinding): Episode | null {
  try {
    const e = JSON.parse(readFileSync(path, "utf8")) as Partial<Episode>;
    if (e.schema !== 1 || e.registry !== b.registry || e.pane_id !== b.paneId || e.instance !== b.instance) return null;
    if (typeof e.since !== "number" || typeof e.last_seen !== "number" || !Array.isArray(e.notified)) return null;
    return e as Episode;
  } catch { return null; }
}

/** Best-effort; false when the record was not written. */
function writeEpisode(path: string, e: Episode): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(e) + "\n");
    renameSync(tmp, path);
    return true;
  } catch { return false; }
}

function dropEpisode(path: string): void {
  try { unlinkSync(path); } catch { /* absent or unwritable: nothing to reset */ }
}

export interface StallObservation extends StallBinding {
  /** The drain's readiness verdict for this seat on this pass. */
  verdict: string;
  evidence: HarnessEvidence | null;
  now: number; bound: number;
}

/** The episode an alarm is due for: its start (identity) and the notices already published. */
export interface DueEpisode { since: number; notified: readonly string[] }

/**
 * One observation of a seat's readiness, under the caller's per-binding lock.
 *
 * Only positive recovery ends an episode: a ready or gone read, a turn in
 * progress, or harness activity after the episode began. That re-arms the alarm.
 * An unknown observation (no instrument, unreadable evidence, another hold, a gap
 * in observation) restarts an episode that has not alarmed yet, and leaves an
 * alarmed one alone, so a continuously stuck seat never alarms twice. A
 * qualifying read is a no-band verdict with a positive turn-ended marker. Returns
 * the episode once it has qualified continuously for the bound and is recorded.
 */
export function observeStall(o: StallObservation): DueEpisode | null {
  const path = episodePath(o);
  if (!path) return null;
  const ev = o.evidence;
  let e = readEpisode(path, o);
  if (o.verdict === "ready" || o.verdict === "gone" || (ev !== null && !ev.ended)) { dropEpisode(path); return null; }
  // Activity since the episode began ends it; a still-stuck read then starts a new one.
  if (ev !== null && e !== null && ev.lastActivity > e.since) { dropEpisode(path); e = null; }
  const qualifying = STALL_VERDICTS.has(o.verdict) && ev !== null && ev.ended && ev.lastActivity <= o.now;
  const alarmed = e !== null && e.notified.length > 0;
  if (!qualifying) { if (!alarmed) dropEpisode(path); return null; }
  if (e && !alarmed && (o.now - e.last_seen > o.bound || e.since > o.now)) e = null;
  e ??= { schema: 1, seat: o.handle, registry: o.registry, pane_id: o.paneId, instance: o.instance, since: o.now, last_seen: o.now, notified: [] };
  e.last_seen = Math.max(e.last_seen, o.now);
  // An episode that could not be recorded cannot be deduplicated: no alarm.
  if (!writeEpisode(path, e)) return null;
  return o.now - e.since >= o.bound ? { since: e.since, notified: e.notified } : null;
}

/** Record a published alarm so the episode stays quiet until it resets. */
export function noteStallNotified(b: StallBinding, ids: string[]): void {
  const path = episodePath(b);
  if (!path) return;
  const e = readEpisode(path, b);
  if (!e) return;
  e.notified = [...new Set([...e.notified, ...ids])];
  writeEpisode(path, e);
}

/** The per-binding lock that serializes observe, publish and record across drains and rows. */
export function acquireStallLock(b: Pick<StallBinding, "home" | "registry" | "handle">, env: NodeJS.ProcessEnv): PaneLock | null {
  const key = createHash("sha256").update(`${b.home}\x1f${b.registry}\x1f${b.handle}`).digest("hex").slice(0, 24);
  try { return acquirePathLock(join(lockRoot(env), `readiness-stall-${key}.lock`), 0, env); } catch { return null; }
}
