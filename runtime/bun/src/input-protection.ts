import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { atomicWrite } from "./fsatomic";
import { normalizeInputMatch, physicalSocketPath, observePaneResult, tmux, type PaneObservation } from "./tmux";
import { sentinelShapedInput } from "./sentinel-tail";
import { paneState, type PaneBand } from "./pane-state";
import { hasDeliveryReceipt } from "./delivery-custody";
import { acquirePathLock, acquirePaneLock } from "./panelock";

export interface InputProtection {
  pane: string; epoch: string; harness?: string; graceUntil: number; snoozeUntil: number;
  consumed: boolean; bareSince: number | null; senders: string[];
  pending?: { home: string; id: string; sender: string }[];
  /** Highest WAIT cue flashed for the live snooze; milestones never repeat within one snooze. */
  cueEmitted?: "" | WaitCue;
  /** Retained after expiry/release until a confirmed empty composer prevents rearming STOP. */
  stopUntil?: number;
  /** An exact START released this hold; the control word may be cleared once. */
  startRequested?: boolean;
  startClearAttempted?: boolean;
  operatorCueEmitted?: "stop" | "start";
}
export type WaitCue = "blue" | "green" | "red";
const CUE_RANK: Record<"" | WaitCue, number> = { "": 0, blue: 1, green: 2, red: 3 };

/** The next cue the live snooze owes: BLUE at the latch, GREEN 30s and RED 10s before delivery. */
export function dueWaitCue(state: InputProtection, now: number): WaitCue | null {
  if (!state.consumed || state.snoozeUntil <= now) return null;
  const remaining = state.snoozeUntil - now;
  const due: WaitCue = remaining <= 10_000 ? "red" : remaining <= 30_000 ? "green" : "blue";
  return CUE_RANK[due] > CUE_RANK[state.cueEmitted ?? ""] ? due : null;
}
export const protectionUntil = (s: InputProtection) => Math.max(s.stopUntil ?? 0, s.snoozeUntil || s.graceUntil);
export const protectionDetail = (s: InputProtection) => `${(s.stopUntil ?? 0) > Date.now() ? "held by operator STOP" : s.snoozeUntil > Date.now() ? "held by operator WAIT" : "draft grace"} until ${new Date(protectionUntil(s)).toISOString()}`;

export function composerControlWord(band: PaneBand): "STOP" | "START" | null {
  if (band.state !== "busy" || band.queued || band.scrolled || band.mayBeTruncated) return null;
  const text = band.text.trim();
  return text === "STOP" || text === "START" ? text : null;
}

/** One draft owns one deadline. Callers serialize updates with the pane submit lock. */
export function advanceProtection(previous: InputProtection | null, obs: Pick<PaneObservation, "paneId" | "serverEpoch" | "currentCommand">,
  band: PaneBand, now: number, urgent = false, sender = "", newBatch = false): InputProtection | null {
  let state = previous?.pane === obs.paneId && previous.epoch === obs.serverEpoch ? { ...previous, senders: [...previous.senders] } : null;
  // STOP belongs to the pane, not to the currently visible draft or TUI view.
  if (state && (state.stopUntil ?? 0) > now) {
    if (sender && !state.senders.includes(sender)) state.senders.push(sender);
    if (composerControlWord(band) === "START") {
      state.stopUntil = now;
      state.snoozeUntil = 0;
      state.graceUntil = now;
      state.startRequested = true;
    }
    return { ...state, bareSince: null };
  }
  if (band.state === "ready") {
    if (!state || newBatch && !state.consumed) return null;
    if (state.bareSince !== null && now - state.bareSince >= 250) return null;
    return { ...state, bareSince: state.bareSince ?? now };
  }
  // A sentinel in the band — anchored, or its scrolled tail (tap-1ncs6) — is never a human draft.
  const draft = band.state === "busy" && !("queued" in band && band.queued) && !sentinelShapedInput(band.text);
  if (!draft && !state) return null;
  const deadline = now + (urgent ? 10_000 : 30_000);
  if (state && newBatch) { state.graceUntil = deadline; if (state.snoozeUntil <= now) state.snoozeUntil = 0; }
  state ??= { pane: obs.paneId, epoch: obs.serverEpoch, graceUntil: deadline, snoozeUntil: 0,
    consumed: false, bareSince: null, senders: [] };
  state.bareSince = null;
  state.graceUntil = Math.min(state.graceUntil || deadline, deadline);
  if (sender && !state.senders.includes(sender)) state.senders.push(sender);
  if (!draft) return state;
  if (!state.stopUntil && composerControlWord(band) === "STOP") {
    state.stopUntil = now + 600_000;
    state.snoozeUntil = 0;
    state.consumed = true;
  }
  if (!state.consumed && normalizeInputMatch(band.text).includes("WAIT")) {
    state.consumed = true;
    state.snoozeUntil = now + 120_000;
  }
  return state;
}

function path(pane: string, env: NodeJS.ProcessEnv): string {
  const key = createHash("sha256").update(`${physicalSocketPath(env)}\0${pane}`).digest("hex");
  return join(env.TAP_INDEX_HOME || join(env.HOME || homedir(), ".tap"), "input-protection", `${key}.json`);
}
/** Status readers must not hang on a damaged record replaced by a FIFO. */
function readRecord(pane: string, env: NodeJS.ProcessEnv): InputProtection {
  const fd = openSync(path(pane, env), constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("input protection record is not a bounded regular file");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}
export function readInputProtection(pane: string, epoch: string, env = process.env): InputProtection | null {
  try {
    const s = readRecord(pane, env);
    if (s.pane !== pane || s.epoch !== epoch) return null;
    if (!Number.isFinite(s.graceUntil) || !Number.isFinite(s.snoozeUntil)
      || typeof s.consumed !== "boolean" || !(s.bareSince === null || Number.isFinite(s.bareSince))
      || !(s.stopUntil === undefined || Number.isFinite(s.stopUntil) && s.stopUntil > 0)
      || !(s.startRequested === undefined || typeof s.startRequested === "boolean")
      || !(s.startClearAttempted === undefined || typeof s.startClearAttempted === "boolean")
      || !(s.operatorCueEmitted === undefined || ["stop", "start"].includes(s.operatorCueEmitted))
      || !Array.isArray(s.senders) || !s.senders.every((v: unknown) => typeof v === "string")
      || !(s.cueEmitted === undefined || s.cueEmitted in CUE_RANK)) throw new Error("invalid input protection");
    return s;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    // A prior server generation has no authority over this pane.
    if (error instanceof SyntaxError) throw new Error("input protection record unreadable");
    throw error;
  }
}
export function inputProtectionHeld(pane: string, epoch: string, env = process.env, now = Date.now()): InputProtection | null {
  const state = readInputProtection(pane, epoch, env);
  return state && protectionUntil(state) > now ? state : null;
}

/** Must run under the pane submit lock, including waiter observations. */
export function updateInputProtection(obs: PaneObservation, band: PaneBand, options: {
  urgent?: boolean; sender?: string; harness?: string; message?: { home: string; id: string; sender: string }; env?: NodeJS.ProcessEnv; now?: number;
} = {}): InputProtection | null {
  const env = options.env ?? process.env, now = options.now ?? Date.now();
  const old = readInputProtection(obs.paneId, obs.serverEpoch, env);
  const pending = (old?.pending ?? []).filter(m => !hasDeliveryReceipt(m.home, m.id)
    && !existsSync(join(m.home, "receipts", `${m.id}.unconfirmed`))
    && (existsSync(join(m.home, "spool", `${m.id}.md`)) || existsSync(join(m.home, "payloads", `${m.id}.md`))));
  const newBatch = pending.length === 0 && !!options.message;
  if (options.message && !pending.some(m => m.home === options.message!.home && m.id === options.message!.id)) pending.push(options.message);
  if (!old && !pending.length) return null;
  // A retained WAIT/STOP marker without pending mail is observed only to retire
  // it; typing STOP while no courier is watching never creates a new hold.
  const advanceBand = !pending.length && band.state === "busy" && band.text.trim() === "STOP" && !old?.stopUntil
    ? { state: "unobservable" as const, reason: "no-pending-mail" } : band;
  const state = advanceProtection(old, obs, advanceBand, now, options.urgent, options.sender, newBatch);
  if (state) {
    state.pending = pending;
    state.senders = [...new Set(pending.map(m => m.sender).filter(Boolean))];
    if (!pending.length) state.graceUntil = 0;
  }
  if (!state || !pending.length && !state.consumed) {
    if (old) rmSync(path(obs.paneId, env), { force: true });
    return null;
  }
  state.harness = options.harness ?? state.harness ?? obs.currentCommand;
  if (JSON.stringify(old) !== JSON.stringify(state)) {
    const file = path(obs.paneId, env);
    mkdirSync(join(file, ".."), { recursive: true });
    atomicWrite(file, JSON.stringify(state) + "\n");
  }
  return state;
}

/** Read-only status for spool scheduling and operator reports. */
function observedInputProtection(pane: string, env = process.env): InputProtection | null {
  let stored: InputProtection;
  try { stored = readRecord(pane, env); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const observed = observePaneResult(pane, env);
  if (observed.status === "pane_gone" || observed.status === "pane_dead") return null;
  if (observed.status !== "ok") throw new Error("input protection identity unobservable");
  return readInputProtection(pane, observed.observation.serverEpoch, env);
}

export function activeInputForPane(pane: string, env = process.env): InputProtection | null {
  const state = observedInputProtection(pane, env);
  return state && protectionUntil(state) > Date.now() ? state : null;
}

/** The pane's live WAIT/STOP hold, or null: arrivals stay silent while held. */
export function snoozedInputForPane(pane: string, env = process.env, now = Date.now()): InputProtection | null {
  try { const s = observedInputProtection(pane, env); return s && Math.max(s.snoozeUntil, s.stopUntil ?? 0) > now ? s : null; } catch { return null; }
}

/** Under the pane lock, persist cosmetic acknowledgement before emitting it. */
export function claimOperatorCue(pane: string, env = process.env, now = Date.now()): { word: "STOP" | "START"; until: number } | null {
  const state = observedInputProtection(pane, env);
  if (!state?.stopUntil) return null;
  const cue = state.startRequested ? "start" : !state.startClearAttempted && state.stopUntil > now ? "stop" : null;
  if (!cue || state.operatorCueEmitted === cue) return null;
  state.operatorCueEmitted = cue;
  atomicWrite(path(pane, env), JSON.stringify(state) + "\n");
  return { word: cue === "stop" ? "STOP" : "START", until: state.stopUntil };
}

/** Separate one-shot license for the no-byte START clear, never a payload attempt. */
export function claimStartClear(pane: string, epoch: string, env = process.env): boolean {
  const state = readInputProtection(pane, epoch, env);
  if (!state?.startRequested || state.startClearAttempted) return false;
  state.startClearAttempted = true;
  atomicWrite(path(pane, env), JSON.stringify(state) + "\n");
  return true;
}

/** Keep the spent license, but retire the cleanup request after positive empty-input proof. */
export function completeStartClear(pane: string, epoch: string, env = process.env): void {
  const state = readInputProtection(pane, epoch, env);
  if (!state?.startRequested || !state.startClearAttempted) return;
  state.startRequested = false;
  atomicWrite(path(pane, env), JSON.stringify(state) + "\n");
}

/**
 * Under the pane submit lock: advance the pane-shared cue record to the next due
 * milestone and persist it BEFORE the caller's best-effort flash, so whichever
 * observer (send path, waiter, drain) sees the milestone first, it flashes once.
 */
export function claimWaitCue(pane: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): WaitCue | null {
  let state: InputProtection | null;
  try { state = observedInputProtection(pane, env); } catch { return null; }
  if (!state) return null;
  const due = dueWaitCue(state, now);
  if (!due) return null;
  try {
    state.cueEmitted = due;
    const file = path(pane, env);
    mkdirSync(join(file, ".."), { recursive: true });
    atomicWrite(file, JSON.stringify(state) + "\n");
  } catch { return null; }
  return due;
}

/** Draft grace/WAIT belong to their cohort; STOP covers all mail for the pane. */
export function protectedMessageState(home: string, id: string, pane: string, env = process.env): InputProtection | null | undefined {
  try {
    const state = observedInputProtection(pane, env);
    if ((state?.stopUntil ?? 0) > Date.now()) return state;
    if (!state?.pending?.some(m => m.id === id && (m.home === home || realpathSync(m.home) === realpathSync(home)))) return null;
    return state;
  } catch (error) {
    // Unknown holds this entry; null alone means no shared deadline exists.
    process.stderr.write(`tap input protection: ${id}: ${String(error)}; entry held\n`);
    return undefined;
  }
}

/** One countdown for the pending cohort, including when urgent shortens older mail's grace. */
export function protectedMessageDeadline(home: string, id: string, pane: string, env = process.env): number | null | undefined {
  const state = protectedMessageState(home, id, pane, env);
  return state ? protectionUntil(state) / 1000 : state;
}

/** The manual drain must also notice submission when no background waiter is running. */
export function refreshInputProtection(pane: string, env = process.env): InputProtection | null {
  let stored: InputProtection;
  try { stored = readRecord(pane, env); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const lock = acquirePaneLock(pane, 0, env);
  if (!lock) return activeInputForPane(pane, env);
  try {
    const observed = observePaneResult(pane, env);
    if (observed.status === "pane_gone" || observed.status === "pane_dead") { rmSync(path(pane, env), { force: true }); return null; }
    if (observed.status !== "ok") return activeInputForPane(pane, env);
    if (tmux(["display-message", "-p", "-t", pane, "#{pane_in_mode}"], env).stdout.trim() !== "0") return activeInputForPane(pane, env);
    const obs = observed.observation;
    if (obs.serverEpoch !== stored.epoch) { rmSync(path(pane, env), { force: true }); return null; }
    const state = updateInputProtection(obs, paneState(pane, stored.harness ?? obs.currentCommand, obs.currentCommand), { env });
    return state && protectionUntil(state) > Date.now() ? state : null;
  } finally { lock.release(); }
}

/** Keep the existing waiter observing a consumed draft after delivery, one owner per pane. */
export async function observeUntilDraftEnds(pane: string, epoch: string, env = process.env): Promise<void> {
  if (!readInputProtection(pane, epoch, env)?.consumed) return;
  const observer = acquirePathLock(path(pane, env) + ".observer", 0, env);
  if (!observer) return;
  try {
    while (readInputProtection(pane, epoch, env)?.consumed) {
      refreshInputProtection(pane, env);
      if (!readInputProtection(pane, epoch, env)) break;
      await Bun.sleep(250);
    }
  } finally { observer.release(); }
}
