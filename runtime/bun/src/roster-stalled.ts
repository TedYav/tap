// `tap team --stalled` (tap-vl8cp): the seats that show "everyone waiting on
// everyone". Read-only and roster-only, like roster-activity.ts: nothing here
// feeds delivery or readiness decisions.
//
// A seat is stalled when it reads `idle` (not waiting, not working), its last
// turn ended at least N seconds ago by a DATED transcript record, and it still
// owes an unanswered ask. What a seat owes is its INBOUND asks, which
// `pendingInboundAsks` already reads per seat; `tap outstanding` lists what a
// seat SENT and awaits, which is the other side of the same stall.
//
// Claims need positive evidence. An idle seat with no dated turn end, or whose
// inbound answer is unreadable, is never listed as stalled: it is reported as
// unjudged, with the reason, so the silence stays visible.

export interface StalledRow {
  handle: string;
  agentState: string;
  turnEndedAt?: number | null;
  turnEndedSource?: "transcript" | null;
}

export type UnjudgedReason = "no_turn_end_date" | "inbound_unknown";

export interface StalledJudgement {
  stalled: { handle: string; stalledForSeconds: number }[];
  unjudged: { handle: string; reason: UnjudgedReason }[];
}

/**
 * `inbound` is `pendingInboundAsks`' answer: true owes, false owes nothing,
 * null/absent unreadable. A seat is named unjudged only when the missing
 * evidence could change the answer: a positive "owes nothing" settles the seat
 * with or without a date, and a dated seat under N is decidable already.
 */
export function judgeStalled(rows: StalledRow[], inbound: Record<string, boolean | null>, now: number, afterSeconds: number): StalledJudgement {
  const out: StalledJudgement = { stalled: [], unjudged: [] };
  for (const row of rows) {
    if (row.agentState !== "idle") continue;
    const owes = inbound[row.handle];
    if (owes === false) continue;
    const ended = row.turnEndedAt;
    if (row.turnEndedSource !== "transcript" || ended == null || !Number.isFinite(ended) || ended > now) {
      out.unjudged.push({ handle: row.handle, reason: "no_turn_end_date" });
      continue;
    }
    const idleFor = now - ended;
    if (idleFor < afterSeconds) continue;
    if (owes === true) out.stalled.push({ handle: row.handle, stalledForSeconds: idleFor });
    else out.unjudged.push({ handle: row.handle, reason: "inbound_unknown" });
  }
  return out;
}
