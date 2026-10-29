import type { OperatorPolicy } from "./operator-policy";
import type { RecoveryTarget } from "./state";
import type { SeatVerdict } from "../verbs/doctor-seat";

export interface OperatorBinding extends RecoveryTarget {
  processPid: string; serverSocket: string; serverEpoch: string;
  nativeSessionId?: string;
}
export interface OperatorClient { id: string; session: string; activity: number; created: number }
export interface OperatorMail {
  id: string; home: string; instance: string; firstSpooled: number | null;
  disposition: "undelivered" | "read" | "done" | "cancelled" | "delivered" | "queued" | "unconfirmed";
  valid: boolean;
}
export interface OperatorFacts {
  binding: OperatorBinding; callerPane: string; captured: boolean;
  verdict: SeatVerdict | null; turnEnded: boolean | null; progress: boolean | null;
  screen: "menu" | "unknown" | "composer" | "draft" | "protected" | "unobservable";
  protection: "clear" | "held" | "unknown"; scriptedCure: boolean; recoveryOwned: boolean; reportOnly?: boolean;
  clients: OperatorClient[] | null; mail: OperatorMail[];
}
export type OperatorAdmission = { ok: true; mail: OperatorMail } | { ok: false; reason: string };
export const OPERATOR_CLIENT_IDLE_MS = 120_000;
const BINDING_FIELDS = ["team", "handle", "registry", "pane", "paneId", "session", "instance", "harness", "processPid", "serverSocket", "serverEpoch"] as const;
export function validOperatorBinding(binding: OperatorBinding): boolean {
  return BINDING_FIELDS.every(key => typeof binding[key] === "string" && binding[key] !== "")
    && /^%\d+$/.test(binding.paneId) && /^[1-9]\d*$/.test(binding.processPid) && binding.serverSocket.startsWith("/");
}
export function sameOperatorBinding(a: OperatorBinding, b: OperatorBinding): boolean {
  return BINDING_FIELDS.every(key => a[key] === b[key]) && (a.nativeSessionId ?? "") === (b.nativeSessionId ?? "");
}
export function admitOperator(policy: OperatorPolicy, seen: OperatorFacts, now: number): OperatorAdmission {
  const refuse = (reason: string): OperatorAdmission => ({ ok: false, reason });
  if (policy.mode === "off") return refuse("harness operator is off; enable recovery.operator explicitly");
  if (seen.reportOnly) return refuse("report-only recovery does not authorize an operator run");
  if (!Number.isFinite(now) || now < 0 || !validOperatorBinding(seen.binding)) return refuse("target identity is incomplete");
  if (seen.callerPane === seen.binding.paneId) return refuse("a seat cannot operate its own pane");
  if (!/^(claude|codex|opencode)(?:-|$)/.test(seen.binding.harness)) return refuse("harness has no operator navigation contract");
  if (!seen.captured || !["menu", "unknown"].includes(seen.screen)) return refuse("target has no observable navigation surface");
  if (seen.protection !== "clear") return refuse("input protection is held or unobservable");
  if (seen.recoveryOwned) return refuse("another recovery owns the target");
  if (seen.scriptedCure) return refuse("a scripted cure already handles this screen; use its named recovery");
  if (!["parked-on-dialog", "unknown"].includes(seen.verdict ?? "")) return refuse("seat doctor does not support harness navigation");
  if (seen.progress !== false || seen.turnEnded !== true) return refuse("native work is active or unobservable");
  if (seen.clients === null) return refuse("client activity is unobservable");
  for (const client of seen.clients) {
    if (!client.id || !client.session || [client.activity, client.created].some(at => !Number.isFinite(at) || at < 0 || at > now)) {
      return refuse("client activity is invalid");
    }
    if (now - Math.max(client.activity, client.created) < OPERATOR_CLIENT_IDLE_MS) return refuse("a target-window client was recently active or attached");
  }
  const mail = seen.mail.find(item => item.valid && item.instance === seen.binding.instance && item.disposition === "undelivered"
    && item.id && item.home.startsWith("/") && item.firstSpooled !== null && Number.isFinite(item.firstSpooled)
    && item.firstSpooled >= 0 && item.firstSpooled <= now && now - item.firstSpooled >= policy.afterMs);
  return mail ? { ok: true, mail } : refuse("no current-instance mail has remained undelivered for operator_after");
}
