import type { SeatCheck, SeatSnapshot } from "../verbs/doctor-seat";
import { harnessEvidence, type HarnessEvidence } from "../readiness-stall";
import { admitOperator, sameOperatorBinding, type OperatorBinding, type OperatorClient, type OperatorFacts, type OperatorMail } from "./operator-admission";
import type { OperatorPolicy } from "./operator-policy";
import type { OperatorRecord } from "./operator-record";
import type { ResolvedContext } from "../context";
import { detectAgentState } from "../agent-state";
import { recoveryPolicy } from "../recovery-policy";
import { REAL_UNWEDGE_READ_IO } from "./unwedge-observe";
import { operatorSurface } from "./operator-screen";
import { readOperatorClients } from "./operator-clients";
import { readOperatorMail } from "./operator-mail";
import { pendingEvidence } from "./evidence";
import { active, readHold } from "./state";
export interface OperatorReadIO {
  identity(snapshot: SeatSnapshot): OperatorBinding;
  frame(snapshot: SeatSnapshot): { text: string; title: string; height: number; copyMode: boolean };
  protection(snapshot: SeatSnapshot): boolean;
  native(snapshot: SeatSnapshot): HarnessEvidence | null;
  clients(snapshot: SeatSnapshot): OperatorClient[] | null;
  mail(snapshot: SeatSnapshot, frame: string): OperatorMail[];
  competingHold(snapshot: SeatSnapshot): boolean;
  reportOnly?(): boolean;
}
export interface OperatorReading { facts: OperatorFacts; frame: string; nativeActivity: number | null }
export function operatorReadIO(ctx: ResolvedContext, ownRun?: string): OperatorReadIO {
  return {
    identity: snapshot => { const binding = REAL_UNWEDGE_READ_IO.identity(snapshot); return { ...binding, processPid: binding.processPid ?? "" }; },
    frame: snapshot => REAL_UNWEDGE_READ_IO.frame(snapshot),
    protection: snapshot => REAL_UNWEDGE_READ_IO.protection(snapshot),
    native: snapshot => harnessEvidence(snapshot.binding.harness, snapshot.seat, process.env, true),
    clients: snapshot => readOperatorClients(snapshot.binding.paneId),
    mail: (snapshot, frame) => readOperatorMail(pendingEvidence(ctx, snapshot.binding, frame).payloads, { ...snapshot.binding, processPid: snapshot.binding.processPid ?? "" }),
    competingHold: snapshot => { const hold = readHold(snapshot.binding.paneId); return active(hold) && hold?.id !== ownRun; },
    reportOnly: () => recoveryPolicy("cautious").mode === "report-only",
  };
}
export function observeOperator(check: SeatCheck, callerPane: string, io: OperatorReadIO, now = Date.now()): OperatorReading {
  const snapshot = check.snapshot;
  if (!snapshot || check.report.verdict === null) throw new Error("seat doctor could not bind the target");
  const binding = io.identity(snapshot);
  if (!sameOperatorBinding(binding, { ...snapshot.binding, processPid: snapshot.binding.processPid ?? "" })) throw new Error("target binding changed before operator observation");
  const before = io.native(snapshot), capture = io.frame(snapshot), surface = operatorSurface(binding.harness, capture.text);
  const protection = io.protection(snapshot) ? "held" : "clear";
  const clients = io.clients(snapshot), mail = io.mail(snapshot, capture.text), competing = io.competingHold(snapshot);
  const after = io.native(snapshot);
  if (!sameOperatorBinding(binding, io.identity(snapshot))) throw new Error("target binding changed during operator observation");
  const valid = (e: HarnessEvidence | null): e is HarnessEvidence => e !== null && Number.isFinite(e.lastActivity) && e.lastActivity >= 0 && e.lastActivity <= now / 1000;
  const both = valid(before) && valid(after);
  const state = detectAgentState(binding.harness, capture.text, capture.title);
  return { frame: capture.text, nativeActivity: valid(after) ? after.lastActivity : null,
    facts: { binding, callerPane, captured: true, verdict: check.report.verdict,
      turnEnded: valid(after) ? after.ended : null,
      progress: both ? before.lastActivity !== after.lastActivity || before.ended !== after.ended || before.at !== after.at : null,
      screen: capture.copyMode ? "unobservable" : surface.kind, protection, clients, mail,
      recoveryOwned: competing, scriptedCure: state.reason === "codex-update-available", reportOnly: io.reportOnly?.() ?? false } };
}
export function operatorBoundaryRefusal(record: OperatorRecord, seen: OperatorReading, policy: OperatorPolicy, now = Date.now(), stage: "action" | "completion" = "action"): string {
  if (policy.digest !== record.policyDigest || policy.mode !== record.authority) return "operator config changed since admission";
  if (!sameOperatorBinding(record.binding, seen.facts.binding)) return "operator target binding changed since admission";
  const admission = admitOperator(policy, { ...seen.facts, mail: seen.facts.mail.filter(item => item.id === record.mail.id && item.home === record.mail.home) }, now);
  if (!admission.ok) return admission.reason;
  if (stage === "action" && seen.nativeActivity !== record.nativeActivity) return "native activity changed since operator admission";
  const census = (clients: OperatorClient[]) => clients.map(c => JSON.stringify([c.id, c.session, c.activity, c.created])).sort().join("\n");
  if (seen.facts.clients === null || census(seen.facts.clients) !== census(record.clients)) return "target-window client activity or membership changed since admission";
  return "";
}
