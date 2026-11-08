// tap-zvuc9: `tap nudge <to>` leaves a genuinely stuck copy mode before the
// tap-w85su park requeue, when nobody can be scrolling it.
//
// This is a recovery authority for a pane with no sentinel. Its license is a park
// that would requeue but for copy mode (copyModeCancelLicense) plus a pane in
// copy-mode itself that no tmux client is viewing. Two instruments with different
// shapes must both read successfully and agree. Anything unreadable refuses.
// The cancel is recorded in the recovery run ledger, never as the payload's
// `.attempted`: that license would make the park ineligible for requeue forever
// (the no-retry-after-possible-effect rule). `-X cancel` is a copy-mode
// command, not input: it adds no bytes to the pane, so it is not a delivery.
import { recoveryEffect, escalateRecovery, type EffectIO } from "./effect";
import { createRun, readRun, releaseRun, type RecoveryTarget } from "./state";
import { targetRow } from "./cli";
import { tmuxReadOnly, type Run } from "../tmux";
import type { RecoveryMode } from "../recovery-policy";

export type CopyModeClients =
  | { status: "unattended" }
  | { status: "normal" }
  | { status: "refused"; why: string };

/**
 * Whether `paneId` is in copy mode with no tmux client viewing it, through any
 * session that shows the pane (grouped sessions and linked windows included).
 */
export function observeUnattendedCopyMode(paneId: string, read: (args: string[]) => Run = args => tmuxReadOnly(args)): CopyModeClients {
  const unreadable = (r: Run) => r.code !== 0 || r.rateLimited === true;
  const pane = read(["display-message", "-p", "-t", paneId, "#{pane_id}\t#{pane_in_mode}\t#{pane_mode}\t#{session_attached}"]);
  if (unreadable(pane)) return { status: "refused", why: "the pane's mode is unreadable" };
  const fields = pane.stdout.replace(/\n$/, "").split("\t");
  if (fields.length !== 4 || fields.some(field => field.includes("\n"))) return { status: "refused", why: "the pane's mode is malformed" };
  const [id, inMode, mode, attached] = fields;
  if (id !== paneId) return { status: "refused", why: "the pane changed identity" };
  if (inMode === "0") return { status: "normal" };
  if (inMode !== "1" || mode !== "copy-mode") return { status: "refused", why: `the pane is in ${mode || "an unknown mode"}, not copy mode` };
  if (!/^\d+$/.test(attached ?? "")) return { status: "refused", why: "the session's attached count is unreadable" };
  const panes = read(["list-panes", "-a", "-F", "#{session_name}\t#{pane_id}"]);
  const clients = read(["list-clients", "-F", "#{client_session}\t#{client_tty}"]);
  if (unreadable(panes) || unreadable(clients)) return { status: "refused", why: "the tmux client list is unreadable" };
  // Every row parses strictly: malformed output is unknown, never an empty client list.
  const paneRows = rows(panes.stdout, ([session, pid]) => !!session && /^%\d+$/.test(pid ?? ""));
  const clientRows = rows(clients.stdout, ([session]) => !!session);
  if (!paneRows || !clientRows) return { status: "refused", why: "the tmux client list is malformed" };
  const sessions = new Set(paneRows.filter(([, pid]) => pid === paneId).map(([session]) => session));
  if (sessions.size === 0) return { status: "refused", why: "the pane changed identity" };
  const viewer = clientRows.find(([session]) => sessions.has(session!));
  if (viewer) return { status: "refused", why: `a tmux client (${viewer[1] || "unknown tty"}) is viewing it; leave copy mode there, then nudge again` };
  // The pane's own session counts its clients separately; the two reads must agree.
  if (attached !== "0") return { status: "refused", why: "the session reports an attached client the client list does not show" };
  return { status: "unattended" };
}

/** Two tab-separated fields per line, each row valid; null when any row is not. */
function rows(stdout: string, valid: (row: string[]) => boolean): string[][] | null {
  const parsed = stdout.split("\n").filter(line => line !== "").map(line => line.split("\t"));
  return parsed.every(row => row.length === 2 && valid(row)) ? parsed : null;
}

export interface CopyParkCancelInput {
  mode: RecoveryMode; registry: string; handle: string; pane: string; paneId: string;
  /** The bus holding the parks; the run's payloads point there. */
  home: string;
  /** copyModeCancelLicense, re-read at the key boundary: a park must still license the cancel then. */
  license: () => string[];
  observe?: (paneId: string) => CopyModeClients;
  /** Injected in tests; production captures the registered row and drives the real pane. */
  target?: () => RecoveryTarget;
  io?: EffectIO;
  /** A fan-out eligibility check; independent of the park's recovery license. */
  selection?: { gate(): string; record(sent: boolean): void };
}
export type CopyParkCancel =
  | { status: "skipped"; why?: string }
  | { status: "verified" | "unverified" | "refused"; recovery: string; why?: string };

/** At most one recorded `-X cancel`; the caller's requeue still decides every park. */
export function cancelUnattendedCopyMode(input: CopyParkCancelInput): CopyParkCancel {
  const observe = input.observe ?? (paneId => observeUnattendedCopyMode(paneId));
  const parks = input.license();
  if (parks.length === 0) return { status: "skipped" };
  const before = observe(input.paneId);
  if (before.status === "normal") return { status: "skipped" };
  if (before.status === "refused") return { status: "skipped", why: before.why };
  let recovery: string;
  try {
    const target = input.target ? input.target() : targetRow(input.registry, input.handle, input.pane, input.paneId);
    recovery = createRun(target, input.mode, parks.map(id => ({ home: input.home, id })), process.env.TMUX_PANE || "", process.pid, process.env, undefined, false).id;
  } catch (error) {
    return { status: "skipped", why: `the cancel could not be recorded (${error instanceof Error ? error.message : error})` };
  }
  let outcome: CopyParkCancel;
  try {
    // The license is re-read at the key boundary, after the pane mutex, identity guard and frames.
    const result = recoveryEffect(recovery, "copy-mode cancel", `${input.mode}: copy-mode park recovery; no attached tmux client`,
      ["send-keys", "-t", input.paneId, "-X", "cancel"], input.io, undefined, undefined, () => {
        const selectionRefusal = input.selection?.gate();
        if (selectionRefusal) return selectionRefusal;
        // One cancel per dedicated run: this one, counted just now, is its only effect.
        if (readRun(recovery).effects !== 1) return "the recovery run has already spent its one cancel";
        if (!input.license().some(id => parks.includes(id))) return "no park licenses the cancel any longer";
        const now = observe(input.paneId);
        return now.status === "unattended" ? "" : now.status === "normal" ? "copy mode ended before the cancel" : now.why;
      }, () => observe(input.paneId).status === "normal");
    input.selection?.record(result.event.effect === "possible");
    if (result.event.incident) {
      try { escalateRecovery(recovery, result.event.summary); } catch (error) { console.error(`tap recovery incident notification: ${error}`); }
    }
    if (result.event.effect === "none") outcome = { status: "refused", recovery, why: result.event.summary };
    else if (result.code !== 0) outcome = { status: "unverified", recovery, why: result.event.summary };
    else if (result.event.outcome === "verified") outcome = { status: "verified", recovery };
    else outcome = { status: "unverified", recovery, why: "the captured pane did not prove out of copy mode after the cancel" };
  } catch (error) {
    outcome = { status: "unverified", recovery, why: error instanceof Error ? error.message : String(error) };
  }
  try { releaseRun(recovery, outcome.status === "verified" ? "left copy mode for a park requeue" : `copy-mode cancel ${outcome.status}`); }
  catch { /* the fixed deadline still bounds the run */ }
  return outcome;
}
