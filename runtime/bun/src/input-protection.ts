import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, realpathSync, rmSync } from "node:fs";
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
export const protectionUntil = (s: InputProtection) => s.snoozeUntil || s.graceUntil;
export const protectionDetail = (s: InputProtection) => `${s.snoozeUntil > Date.now() ? "held by operator WAIT" : "draft grace"} until ${new Date(protectionUntil(s)).toISOString()}`;

/** One draft owns one deadline. Callers serialize updates with the pane submit lock. */
export function advanceProtection(previous: InputProtection | null, obs: Pick<PaneObservation, "paneId" | "serverEpoch" | "currentCommand">,
  band: PaneBand, now: number, urgent = false, sender = "", newBatch = false): InputProtection | null {
  let state = previous?.pane === obs.paneId && previous.epoch === obs.serverEpoch ? { ...previous, senders: [...previous.senders] } : null;
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
export function readInputProtection(pane: string, epoch: string, env = process.env): InputProtection | null {
  try {
    const s = JSON.parse(readFileSync(path(pane, env), "utf8"));
    if (s.pane !== pane || s.epoch !== epoch) return null;
    if (!Number.isFinite(s.graceUntil) || !Number.isFinite(s.snoozeUntil)
      || typeof s.consumed !== "boolean" || !(s.bareSince === null || Number.isFinite(s.bareSince))
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
  const state = advanceProtection(old, obs, band, now, options.urgent, options.sender, newBatch);
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
  try { stored = JSON.parse(readFileSync(path(pane, env), "utf8")); }
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

/** The pane's live WAIT snooze, or null: parks stay silent while one is active. */
export function snoozedInputForPane(pane: string, env = process.env, now = Date.now()): InputProtection | null {
  try { const s = observedInputProtection(pane, env); return s && s.snoozeUntil > now ? s : null; } catch { return null; }
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

/** The shared record applies only to members of this message's pending cohort. */
export function protectedMessageState(home: string, id: string, pane: string, env = process.env): InputProtection | null | undefined {
  try {
    const state = observedInputProtection(pane, env);
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
  try { stored = JSON.parse(readFileSync(path(pane, env), "utf8")); }
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
