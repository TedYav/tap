// tap-cl1es: the stuck-paint record, successor to tap-vctb8's one-shot marker.
// A paint that survives the courier's repaint (or an OpenCode band that never
// paints) starts one bounded healing episode per pane: the courier may repaint
// again on a cooldown, at most N times, and then the episode is exhausted and
// the leader alarm fires. The record is keyed by {cause, count, firstSeen,
// lastAt} ALONE (tap-cl1es review A): a working turn repaints the pane bytes
// every few seconds while the debris still paints, so a hash-keyed bound would
// reset on every observation and never bind. The only retirement is a READY
// read — the band observable again. v1 files (a lone frameHash) read as one
// spent repaint, eligible again after the cooldown.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { atomicWrite } from "./fsatomic";
import { physicalSocketPath } from "./tmux";

export type OverprintCause = "overprint" | "booting";

export interface OverprintRecord {
  v: 2;
  cause: OverprintCause;
  /** Automatic repaints spent on this episode — only attempted resizes count. */
  count: number;
  /** Epoch seconds of the first stuck observation of this episode. */
  firstSeen: number;
  /** Epoch seconds of the last recorded attempt; 0 when none was recorded. */
  lastAt: number;
  /** The exhausted alarm fired for this episode (once, ever). */
  alarmed?: boolean;
}

/** Minimum seconds between two automatic repaints of the same pane. */
export const OVERPRINT_RETRY_COOLDOWN_SECS = 60;
/** Total automatic repaints one episode may spend before it is exhausted. */
export const OVERPRINT_RETRY_MAX = 5;
/** An OpenCode booting pane must persist this long before it is repaint-eligible. */
export const OVERPRINT_BOOTING_PERSISTENCE_SECS = 30;
/**
 * A record this old names a pane id a new pane may now own (ids restart with
 * the tmux server), so it reads as absent and the next paint starts fresh.
 */
export const OVERPRINT_RECORD_STALENESS_SECS = 3600;

export function overprintRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.TAP_INDEX_HOME || join(env.HOME || homedir(), ".tap"), "debug", "overprint");
}

function markerPath(paneId: string, env: NodeJS.ProcessEnv): string {
  const key = createHash("sha256").update(`${physicalSocketPath(env)}\0${paneId}`).digest("hex");
  return join(overprintRoot(env), `${key}.json`);
}

const FINITE_EPOCH = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

function parseRecord(raw: string, path: string): OverprintRecord | null {
  try {
    const doc = JSON.parse(raw) as Record<string, unknown>;
    if (doc.v === 2 && (doc.cause === "overprint" || doc.cause === "booting")
      && typeof doc.count === "number" && Number.isSafeInteger(doc.count) && doc.count >= 0
      && FINITE_EPOCH(doc.firstSeen) && FINITE_EPOCH(doc.lastAt)) {
      return { v: 2, cause: doc.cause, count: doc.count, firstSeen: doc.firstSeen, lastAt: doc.lastAt,
        ...(doc.alarmed === true ? { alarmed: true } : {}) };
    }
    // A v1 one-shot marker (tap-vctb8) is one spent repaint. Its mtime dates
    // the attempt, so a pre-upgrade hold becomes eligible after the cooldown.
    if (doc.v === 1 && typeof doc.frameHash === "string" && /^[0-9a-f]{64}$/.test(doc.frameHash)) {
      let mtime = 0;
      try { mtime = Math.floor(statSync(path).mtimeMs / 1000); } catch { /* unreadable mtime */ }
      return { v: 2, cause: "overprint", count: 1, firstSeen: mtime, lastAt: mtime };
    }
  } catch { /* An unreadable record grants no hold and no budget. */ }
  return null;
}

/** The pane's stuck-paint record, or null when none is credible or still fresh. */
export function readOverprintRecord(paneId: string, env: NodeJS.ProcessEnv = process.env, now: number = Date.now() / 1000): OverprintRecord | null {
  if (!/^%\d+$/.test(paneId)) return null;
  const path = markerPath(paneId, env);
  try {
    const record = parseRecord(readFileSync(path, "utf8"), path);
    if (record && now - Math.max(record.firstSeen, record.lastAt) >= OVERPRINT_RECORD_STALENESS_SECS) return null;
    return record;
  } catch { return null; }
}

/**
 * Seed (or re-target) the episode record. Idempotent for a matching cause:
 * the first observation of a stuck pane plants `firstSeen`, later ones leave
 * it. A cause transition (paint <-> booting) starts a fresh episode.
 */
export function seedOverprintRecord(paneId: string, cause: OverprintCause, now: number, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!/^%\d+$/.test(paneId) || !Number.isFinite(now)) return false;
  const existing = readOverprintRecord(paneId, env, now);
  if (existing && existing.cause === cause) return true;
  return writeRecord(paneId, { v: 2, cause, count: 0, firstSeen: now, lastAt: 0 }, env);
}

function writeRecord(paneId: string, record: OverprintRecord, env: NodeJS.ProcessEnv): boolean {
  try {
    mkdirSync(overprintRoot(env), { recursive: true });
    atomicWrite(markerPath(paneId, env), JSON.stringify(record) + "\n");
    return true;
  } catch { return false; }
}

/** Test and recovery support: plant an exact record. */
export function writeOverprintRecord(paneId: string, record: OverprintRecord, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!/^%\d+$/.test(paneId)) return false;
  return writeRecord(paneId, record, env);
}

/**
 * One spent repaint. Only an ATTEMPTED resize may call this (a lock-busy
 * refusal spent nothing), mirroring the tap-vctb8 rule the marker carried.
 */
export function recordOverprintAttempt(paneId: string, cause: OverprintCause, now: number, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!/^%\d+$/.test(paneId) || !Number.isFinite(now)) return false;
  const existing = readOverprintRecord(paneId, env, now);
  const record: OverprintRecord = existing && existing.cause === cause
    ? { ...existing, count: existing.count + 1, lastAt: now }
    : { v: 2, cause, count: 1, firstSeen: now, lastAt: now };
  return writeRecord(paneId, record, env);
}

/** The exhausted alarm: true exactly when this call fired it first. */
export function markOverprintAlarmed(paneId: string, now: number, env: NodeJS.ProcessEnv = process.env): boolean {
  const existing = readOverprintRecord(paneId, env, now);
  if (!existing || existing.alarmed === true) return false;
  return writeRecord(paneId, { ...existing, alarmed: true }, env);
}

/** A ready read — the band observable again — is the only retirement. */
export function retireOverprintRecord(paneId: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!/^%\d+$/.test(paneId)) return;
  try { rmSync(markerPath(paneId, env), { force: true }); } catch { /* best effort */ }
}

/** The heal's before/after verdict, shared with the nudge classify arm. */
export type OverprintHealVerdict = "overprint" | "booting" | "blocked" | "readable";

/**
 * A manual cure that leaves the band readable retires any spent episode:
 * without this, a nudge-healed seat whose record never saw a ready read would
 * reopen exhausted and already alarmed — a deaf seat (tap-cl1es review 1a).
 */
export function retireOverprintAfterReadableHeal(paneId: string, after: OverprintHealVerdict, env: NodeJS.ProcessEnv = process.env): boolean {
  if (after !== "readable") return false;
  retireOverprintRecord(paneId, env);
  return true;
}

export type OverprintDecision = "repaint" | "hold" | "exhausted";

/**
 * The bound decision for a currently-stuck pane. "repaint" admits ONE more
 * automatic repaint (the caller's repaint gate re-checks under the window
 * lock); "hold" keeps the seat parked on the record's cadence; "exhausted"
 * means the budget is spent and the episode is alarmed.
 */
export function overprintRetryDue(paneId: string, cause: OverprintCause, now: number, env: NodeJS.ProcessEnv = process.env): OverprintDecision {
  if (!Number.isFinite(now)) return "hold";
  const record = readOverprintRecord(paneId, env, now);
  if (!record) {
    // First observation of this cause. The paint case repaints immediately —
    // the debris in front of a live composer is exactly the cure's target —
    // and writes nothing until a repaint actually spends. A booting pane
    // plants its persistence clock now and must outlast the bound first.
    if (cause === "booting") {
      seedOverprintRecord(paneId, cause, now, env);
      return "hold";
    }
    return "repaint";
  }
  if (record.cause !== cause) {
    // A cause transition (paint <-> booting) starts a fresh episode.
    seedOverprintRecord(paneId, cause, now, env);
    return cause === "booting" ? "hold" : "repaint";
  }
  if (record.count >= OVERPRINT_RETRY_MAX) return "exhausted";
  if (cause === "booting" && now - record.firstSeen < OVERPRINT_BOOTING_PERSISTENCE_SECS) return "hold";
  if (now - record.lastAt < OVERPRINT_RETRY_COOLDOWN_SECS) return "hold";
  return "repaint";
}

/**
 * The repaint gate the courier hands repaintPane (tap-cl1es review C): the
 * budget decision and the attempt record both run under the window repaint
 * lock, so two concurrent attempts cannot each see a stale `lastAt` and spend
 * two repaints.
 */
export interface OverprintRepaintGate {
  admit(): boolean;
  commit(attempted: boolean): void;
}

export function overprintRepaintGate(paneId: string, cause: OverprintCause, env: NodeJS.ProcessEnv = process.env,
  now: () => number = (): number => Math.floor(Date.now() / 1000)): OverprintRepaintGate {
  return {
    admit: (): boolean => overprintRetryDue(paneId, cause, now(), env) === "repaint",
    commit: (attempted: boolean): void => {
      if (attempted) recordOverprintAttempt(paneId, cause, now(), env);
    },
  };
}
