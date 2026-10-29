import { validId, validToken } from "../ids";
import { sameOperatorBinding, validOperatorBinding, type OperatorBinding, type OperatorClient } from "./operator-admission";
import type { PayloadRef, RecoveryTarget } from "./state";

export interface OperatorApproval { requestId: string; reply: string }
export interface OperatorSample { id: string; hash: string; at: number; used: boolean }
export interface OperatorRecord {
  v: 1; binding: OperatorBinding; policyDigest: string; authority: "ask" | "on";
  admittedAt: number; mail: PayloadRef; nativeActivity: number; clients: OperatorClient[];
  approval?: OperatorApproval; sample?: OperatorSample;
  caller?: { handle: string; instance: string; paneId: string; team: string };
}
const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);
const time = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
export const OPERATOR_REQUEST_ID = /^operator-request-[a-f0-9-]{36}$/;
export const OPERATOR_SAMPLE_ID = /^sample-[a-f0-9-]{36}$/;

export function validOperatorRecord(value: unknown, target: RecoveryTarget): value is OperatorRecord {
  if (!object(value) || value.v !== 1 || !object(value.binding) || !validOperatorBinding(value.binding as OperatorBinding)
    || !sameOperatorBinding(value.binding as OperatorBinding, target as OperatorBinding)
    || typeof value.policyDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.policyDigest)
    || !["ask", "on"].includes(value.authority) || !time(value.admittedAt) || !time(value.nativeActivity)
    || !object(value.mail) || typeof value.mail.id !== "string" || !validId(value.mail.id) || typeof value.mail.home !== "string" || !value.mail.home.startsWith("/")
    || !Array.isArray(value.clients) || !value.clients.every((c: unknown) => object(c) && typeof c.id === "string" && c.id
      && typeof c.session === "string" && c.session && time(c.activity) && time(c.created))) return false;
  if (value.caller !== undefined && (!object(value.caller) || !validToken(value.caller.handle ?? "")
    || !validToken(value.caller.team ?? "") || typeof value.caller.instance !== "string" || !value.caller.instance
    || !/^%\d+$/.test(value.caller.paneId ?? ""))) return false;
  if (value.authority === "ask" && (!object(value.approval) || !OPERATOR_REQUEST_ID.test(value.approval.requestId ?? "")
    || typeof value.approval.reply !== "string" || !value.approval.reply.trim()
    || value.approval.reply.length > 4096)) return false;
  if (value.sample !== undefined && (!object(value.sample) || !OPERATOR_SAMPLE_ID.test(value.sample.id ?? "")
    || !/^[a-f0-9]{64}$/.test(value.sample.hash ?? "") || !time(value.sample.at) || typeof value.sample.used !== "boolean")) return false;
  return true;
}
export function operatorAdmissionRecord(record?: OperatorRecord): Omit<OperatorRecord, "sample"> | undefined {
  if (!record) return undefined;
  const { sample: _sample, ...admission } = record;
  return admission;
}
