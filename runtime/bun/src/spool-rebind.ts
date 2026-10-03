// tap-03rfq: a park whose seat restarted onto a new pane.
//
// `tap session restart` (and any rebind) keeps the seat's row and its instance
// and moves it to a new pane. The park still names the old pane, so readiness
// reads the binding as drifted ("gone") and nothing would ever deliver it, and
// the retirement path never fires because the instance did not change. Each
// drain pass, before Phase A plans digests by pane, settles every such park one
// of two ways:
//
//   - RE-BIND when the row is provably the same seat and no attempt is
//     provable: the target's row on the park's registry is active, pane-delivered
//     and bound to a different pane; the payload's stamped recipient instance
//     equals the row's instance; and the requeue no-effect proof passes (zero
//     attempts behind the pre-attempt fence, no attempt/delivery/read/settlement
//     evidence). Only `pane` and `pane_id` change. Ordinary delivery then runs the
//     courier's bound-identity guard on the new pane.
//   - TERMINALIZE with a sender notice when the same row cannot be re-bound:
//     "unconfirmed" when an attempt may have reached the old pane (no retry after
//     a possible effect: the body is never typed into the new pane), "never
//     attempted" when the payload carries no instance to prove the seat.
//
// Everything else is left alone: a row that is pending (a restart in flight),
// inactive or missing; a row whose instance differs (a different seat on the
// reused handle, the retirement path's case); an escalated park (its owners are
// nudge, sender-gone and the human). The lookup is keyed on the target's row,
// never on the old pane id, so a stranger now holding that pane id is never
// a candidate.
//
// Custody follows the requeue order: obligation lock, no-steal spool claim,
// reset custody, metadata lock. Every leg is re-read under custody.
import { readFileSync, renameSync, writeFileSync } from "node:fs";

import { envelopeField } from "./envelope";
import { appendRegistryEventOrWarn } from "./events";
import { lockNameFits } from "./fsatomic";
import { acquireObligationLock, acquirePathLock } from "./panelock";
import { loadRegistry, seatMap } from "./registry";
import { teamRegistryRefusal } from "./register-authority";
import { withResetCustody } from "./reset";
import { canonicalConflicts, type DeadlineContext, isDone, notifySenderOnEscalate, registryMatchesTeam, terminalize, type NoticeOutcome } from "./spool-deadline";
import { KIND_DELIVERY_FAILED } from "./notice";
import { isDict, metaBytes, METADATA_LOCK_TIMEOUT_MS, parseJsonPreserving, pyReadUtf8, pyTruthy } from "./spool-publication";
import { noEffectProof } from "./spool-effect-proof";
import { hashedNoticeId, noticeNameTooLong } from "./spool-retired";
import { claimAcquire, claimRelease, metaPath, payloadPath } from "./spool-sidecar";
import type { SpoolRow } from "./spool-state";

export type RebindVerdict = "current" | "untouched" | "rebound" | "terminalized" | "held";

interface SeatBinding { pane: string; paneId: string; instance: string }

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The target's current row when it is an active pane seat with a full binding; else null (leave the park alone). */
function currentSeat(registry: string, target: string): SeatBinding | null {
  let row: Record<string, unknown> | undefined;
  try {
    const doc = loadRegistry(registry);
    // An old-format registry authorizes no pane: the park stays as it is.
    if (teamRegistryRefusal(registry, doc)) return null;
    row = seatMap(doc)[target] as Record<string, unknown> | undefined;
  } catch { return null; }
  if (!row || (row.status ?? "active") !== "active" || row.status_reason === "launching" || row.delivery === "poll") return null;
  const pane = text(row.pane), paneId = text(row.pane_id);
  if (!pane || !paneId) return null;
  return { pane, paneId, instance: text(row.instance) };
}

type Plan =
  | { kind: "current" | "untouched" }
  | { kind: "rebind"; seat: SeatBinding }
  | { kind: "terminal"; outcome: NoticeOutcome; detail: string; why: string };

/** The decision from the park's metadata, its payload and the target's row; pure reads, safe to repeat under custody. */
function plan(ctx: DeadlineContext, id: string, meta: Record<string, unknown>): Plan {
  if (meta.id !== id || pyTruthy(meta.escalated_at)) return { kind: "untouched" };
  const target = text(meta.target), registry = text(meta.target_registry);
  const pane = text(meta.pane), paneId = text(meta.pane_id);
  if (!target || !registry || !pane || !paneId || !registryMatchesTeam(registry, text(meta.to_team))) return { kind: "untouched" };
  const seat = currentSeat(registry, target);
  if (!seat) return { kind: "untouched" };
  if (seat.pane === pane && seat.paneId === paneId) return { kind: "current" };
  let raw: string;
  try { raw = readFileSync(payloadPath(ctx.spoolDir, id), "utf8"); } catch { return { kind: "untouched" }; }
  if (envelopeField(raw, "id") !== id || envelopeField(raw, "to") !== target) return { kind: "untouched" };
  const sentTo = envelopeField(raw, "recipient_instance") ?? "";
  // A different instance is a different seat: the retirement path owns it.
  if (sentTo && sentTo !== seat.instance) return { kind: "untouched" };
  const moved = `${target} moved from ${pane} (${paneId}) to ${seat.pane} (${seat.paneId})`;
  const effect = noEffectProof(ctx.home, ctx.spoolDir, id, meta);
  if (effect) {
    return { kind: "terminal", outcome: "possible", why: effect,
      detail: `${moved} while this entry was parked, and ${effect}; it is not re-typed into the new pane` };
  }
  if (!sentTo || !seat.instance) {
    return { kind: "terminal", outcome: "unrouted", why: "no recipient instance",
      detail: `${moved} while this entry was parked, and the payload carries no recipient instance to prove the new pane is the same seat` };
  }
  return { kind: "rebind", seat };
}

/** Under the metadata lock: re-decide from fresh reads, and rewrite the binding only for a re-bind. */
function rewriteBinding(ctx: DeadlineContext, id: string): { verdict: "rebound" | "untouched" | "current" | "held" | "terminal"; plan?: Plan; from?: string } {
  const path = metaPath(ctx.spoolDir, id);
  if (!lockNameFits(`${path}.lock`)) return { verdict: "held" };
  const lock = acquirePathLock(`${path}.lock`, METADATA_LOCK_TIMEOUT_MS, ctx.env ?? process.env);
  if (!lock) return { verdict: "held" };
  try {
    let meta: unknown;
    try { meta = parseJsonPreserving(pyReadUtf8(path)); } catch { return { verdict: "held" }; }
    if (!isDict(meta)) return { verdict: "held" };
    const decided = plan(ctx, id, meta);
    if (decided.kind === "terminal") return { verdict: "terminal", plan: decided };
    if (decided.kind !== "rebind") return { verdict: decided.kind };
    const from = `${text(meta.pane)} (${text(meta.pane_id)})`;
    meta.rebound_from = { pane: text(meta.pane), pane_id: text(meta.pane_id) };
    meta.pane = decided.seat.pane;
    meta.pane_id = decided.seat.paneId;
    // Force authority counts live looks at the old pane; it never carries to a new one.
    delete meta.busy_live_probes;
    delete meta.busy_pending_probes;
    try {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, metaBytes(meta as Record<string, never>).replace(/\n$/, ""));
      renameSync(tmp, path);
    } catch { return { verdict: "held" }; }
    return { verdict: "rebound", plan: decided, from };
  } finally { lock.release(); }
}

/** One park: re-bind, terminalize, or leave it. */
export async function rebindRestartedSeat(ctx: DeadlineContext, id: string): Promise<RebindVerdict> {
  const env = ctx.env ?? process.env;
  // A cheap unlocked look first, so the ordinary pass takes no locks for current bindings.
  let peek: unknown;
  try { peek = parseJsonPreserving(pyReadUtf8(metaPath(ctx.spoolDir, id))); } catch { return "untouched"; }
  if (!isDict(peek)) return "untouched";
  const first = plan(ctx, id, peek);
  if (first.kind === "current" || first.kind === "untouched") return first.kind;
  const obligation = acquireObligationLock(id, 0, env);
  if (!obligation) return "held";
  try {
    const claim = claimAcquire(ctx.spoolDir, id, true, env);
    if (claim.status !== "acquired") return "held";
    try {
      if (isDone(ctx, id)) return "untouched";
      const custody = withResetCustody(ctx.home, "spool restart re-bind", () => rewriteBinding(ctx, id));
      if (!custody.ok) return "held";
      const result = custody.value;
      const target = text(peek.target);
      if (result.verdict === "rebound" && result.plan?.kind === "rebind") {
        appendRegistryEventOrWarn(ctx.verbLabel, { log: ctx.eventLog, actor: "courier", action: "spool_rebound_restarted_seat",
          handle: target, pane: result.plan.seat.paneId, team: ctx.team, detail: `id=${id} from=${result.from}`, env });
        return "rebound";
      }
      if (result.verdict !== "terminal" || result.plan?.kind !== "terminal") {
        return result.verdict === "held" ? "held" : result.verdict === "current" ? "current" : "untouched";
      }
      const terminal = result.plan;
      const pane = text(peek.pane);
      // A different canonical copy already exists: promoting would discard the only
      // original body. Hold for a human; nothing is published or removed.
      if (canonicalConflicts(ctx, id)) {
        process.stderr.write(`tap: spool entry '${id}' held — its canonical payload differs from the parked body\n`);
        return "held";
      }
      // The notice is durable custody and comes first: a deterministic id publishes
      // once (a poll or offline sender still gets it) and a retry finds it rather
      // than waking the sender again. Only a published notice licenses promotion.
      // A courier notice or self-addressed mail has no one to tell.
      let raw = "";
      try { raw = readFileSync(payloadPath(ctx.spoolDir, id), "utf8"); } catch { return "held"; }
      const sender = envelopeField(raw, "from") ?? "";
      const notifiable = envelopeField(raw, "kind") !== KIND_DELIVERY_FAILED && !!sender && sender !== target;
      if (notifiable && !notifySenderOnEscalate(ctx, { id, target, targetRegistry: text(peek.target_registry), outcome: terminal.outcome,
        detail: terminal.detail, durableId: restartNoticeId(id, raw) })) return "held";
      ctx.signal?.throwIfAborted();
      // Re-decide under the promotion's own reset custody: the registry is not
      // locked across the two custody spans, so a row that moved again holds.
      const stillTerminal = (): boolean => {
        try {
          const fresh = parseJsonPreserving(pyReadUtf8(metaPath(ctx.spoolDir, id)));
          const again = isDict(fresh) ? plan(ctx, id, fresh) : null;
          return again?.kind === "terminal" && again.outcome === terminal.outcome;
        } catch { return false; }
      };
      if (!await terminalize(ctx, id, target, pane, "seat_restarted", "spool_terminal_seat_restarted",
        { requireSameCanonical: true, precondition: stillTerminal })) return "held";
      return "terminalized";
    } finally { claimRelease(ctx.spoolDir, id, claim.token); }
  } finally { obligation.release(); }
}

/** The notice's deterministic id, with instance retirement's bounded fallback for an over-long name. */
export function restartNoticeId(id: string, raw: string): string {
  const suffixed = `${id}-seat-restarted`;
  return noticeNameTooLong(suffixed) ? hashedNoticeId("seat-restarted", raw) : suffixed;
}

/** The drain's pre-Phase-A pass over a listing snapshot. */
export async function rebindRestartedSeats(ctx: DeadlineContext, rows: SpoolRow[], skip: ReadonlySet<string>): Promise<void> {
  for (const row of rows) {
    ctx.signal?.throwIfAborted();
    const id = text(row.id);
    if (!id || row.incomplete || skip.has(id)) continue;
    await rebindRestartedSeat(ctx, id);
  }
}
