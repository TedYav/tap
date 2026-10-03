import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pendingSentinel } from "../deliver";
import { phaseRows, type PhaseRow } from "../submit-phase";
import { classifySubmitFrame, visibleSentinel } from "../submit-frame";
import { atomicWrite } from "../fsatomic";
import { runDirectory, type RecoveryRun, type PayloadRef } from "./state";
import type { RecoveryEvent } from "./effect";

export interface PayloadBaseline extends PayloadRef { attempts: string[]; sentHash: string | null; readHash?: string | null; doneHash?: string | null; queuedHash?: string | null }
export interface FlowProof { kind: "submitted" | "queued" | "read" | "observed" | "unresolved"; payload?: PayloadRef; summary: string }
/** UI-only observation is distinct from verified message flow. Never wait for nonexistent receipts. */
export function composerOnlyProof(run: RecoveryRun, frame: string, pendingCompleteAndEmpty: boolean, identityVerified: boolean): FlowProof | null {
  if (!pendingCompleteAndEmpty || run.payloads.length || !identityVerified || run.state === "stopped") return null;
  const state = classifySubmitFrame(frame, run.target.harness, "\0");
  if (state.state !== "empty" || !["idle", "working", "mid-turn"].includes(state.mode)) return null;
  return { kind: "observed", summary: "composer available; no pending message found to verify submission flow" };
}
function receiptHash(ref: PayloadRef, suffix: string): string | null {
  try { return createHash("sha256").update(readFileSync(join(ref.home, "receipts", `${ref.id}.${suffix}`))).digest("hex"); }
  catch { return null; }
}
export function baselinePayload(ref: PayloadRef): PayloadBaseline {
  return { ...ref, attempts: [...new Set(phaseRows(ref.home, ref.id).map(r => r.attempt))], sentHash: receiptHash(ref, "sent"), readHash: receiptHash(ref, "read"), doneHash: receiptHash(ref, "done"), queuedHash: receiptHash(ref, "harness-queued") };
}
export function saveBaseline(run: RecoveryRun): PayloadBaseline[] {
  const baseline = run.payloads.map(baselinePayload);
  atomicWrite(join(runDirectory(run.id), "baseline.json"), JSON.stringify(baseline, null, 2));
  return baseline;
}
/** A natural-language worker report, old .sent, or uncorrelated verify row is never proof. */
export function evaluateFlow(
  run: RecoveryRun, baseline: PayloadBaseline[], events: RecoveryEvent[],
  observations: Array<{ ref: PayloadRef; phases: PhaseRow[]; sentHash: string | null; queued: boolean; queuedHash?: string | null; readHash?: string | null; read?: Record<string, unknown> | null; doneHash?: string | null; done?: Record<string, unknown> | null }>,
  identityVerified: boolean,
): FlowProof {
  if (!identityVerified || events.some(e => e.incident) || run.state === "stopped") {
    return { kind: "unresolved", summary: "recovery identity/effect evidence is unverified; no replay" };
  }
  const captured = events.filter(e => e.recoveryId === run.id && e.before && e.after && existsSync(e.before) && existsSync(e.after));
  const hasPair = captured.some(e => e.before !== e.after) ||
    (captured.some(e => e.action === "inspect:initial") && captured.some(e => e.action === "inspect:final"));
  for (const item of observations) {
    const prior = baseline.find(b => b.id === item.ref.id && b.home === item.ref.home);
    if (!prior) continue;
    const reads = [
      { receipt: item.read, hash: item.readHash, prior: prior.readHash, allowed: true },
      { receipt: item.done, hash: item.doneHash, prior: prior.doneHash, allowed: item.done?.via === "read" },
    ];
    if (hasPair && reads.some(({ receipt, hash, prior, allowed }) => allowed && receipt && hash && hash !== prior &&
        receipt.id === item.ref.id && receipt.by === run.target.handle && String(receipt.forced) !== "true" && receipt.reason !== "instance_retired")) {
      return { kind: "read", payload: item.ref, summary: `message ${item.ref.id} read by ${run.target.handle}; task completion unconfirmed` };
    }
    if (item.queued && item.queuedHash && item.queuedHash !== prior.queuedHash) return { kind: "queued", payload: item.ref, summary: `message ${item.ref.id} queued in harness; processing unconfirmed; no replay` };
    const fresh = item.phases.filter(p => !prior.attempts.includes(p.attempt) && p.recipient === run.target.handle);
    for (const result of fresh.filter(p => p.phase === "verify-result" && p.result === "verified" && p.enter_count > 0)) {
      if (!fresh.some(p => p.attempt === result.attempt && p.phase === "Enter-sent" && p.enter_count > 0)) continue;
      const recordedStaged = result.recovery_id === run.id && events.some(event => {
        if (event.recoveryId !== run.id || !event.action.includes("Enter") || !event.before || !event.after ||
            !existsSync(event.after) || event.outcome === "refused" || event.incident) return false;
        const wire = visibleSentinel(readFileSync(event.before, "utf8"), run.target.harness);
        const parsed = wire && pendingSentinel(wire, run.target.harness);
        return !!parsed && parsed.id.split("/").at(-1) === item.ref.id;
      });
      const ordinaryCourier = hasPair && result.recovery_id === undefined && item.sentHash !== null && item.sentHash !== prior.sentHash;
      if (recordedStaged || ordinaryCourier) return { kind: "submitted", payload: item.ref,
        summary: `staged message ${item.ref.id} submitted; processing unconfirmed` };
    }
  }
  return { kind: "unresolved", summary: "no fresh attempt-correlated submission proof; inspect recovery frames, no blind replay" };
}
export function inspectFlow(run: RecoveryRun, baseline: PayloadBaseline[], queued: (ref: PayloadRef) => boolean, identityVerified: boolean): FlowProof {
  let events: RecoveryEvent[] = [];
  try {
    events = readFileSync(join(runDirectory(run.id), "events.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  } catch { return { kind: "unresolved", summary: "recovery events incomplete or unreadable; no proof claimed" }; }
  return evaluateFlow(run, baseline, events, run.payloads.map(ref => {
    let read: Record<string, unknown> | null = null, done: Record<string, unknown> | null = null;
    try { read = JSON.parse(readFileSync(join(ref.home, "receipts", `${ref.id}.read`), "utf8")); } catch { /* not observed */ }
    try { done = JSON.parse(readFileSync(join(ref.home, "receipts", `${ref.id}.done`), "utf8")); } catch { /* not observed */ }
    return { ref, phases: phaseRows(ref.home, ref.id), sentHash: receiptHash(ref, "sent"), queued: queued(ref), queuedHash: receiptHash(ref, "harness-queued"),
      read, readHash: receiptHash(ref, "read"), done, doneHash: receiptHash(ref, "done") };
  }), identityVerified);
}

export function snapshotProof(run: RecoveryRun, proof: FlowProof): void {
  const records = run.payloads.map(ref => {
    const receipts: Record<string, unknown> = {};
    for (const suffix of ["sent", "read", "done", "harness-queued"]) {
      try { receipts[suffix] = JSON.parse(readFileSync(join(ref.home, "receipts", `${ref.id}.${suffix}`), "utf8")); }
      catch { receipts[suffix] = null; }
    }
    return { ...ref, phases: phaseRows(ref.home, ref.id), receipts };
  });
  atomicWrite(join(runDirectory(run.id), "proof.json"), JSON.stringify({ at: new Date().toISOString(), result: proof, records }, null, 2));
}
