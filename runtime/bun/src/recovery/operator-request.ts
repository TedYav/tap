import { sameOperatorBinding, validOperatorBinding, type OperatorBinding } from "./operator-admission";
import type { OperatorPolicy } from "./operator-policy";
import { recoveryRoot, type PayloadRef } from "./state";
import { OPERATOR_REQUEST_ID, type OperatorApproval } from "./operator-record";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../fsatomic";
import { acquirePathLock } from "../panelock";
import { validToken } from "../ids";
export interface OperatorCaller { handle: string; instance: string; paneId: string; team: string }
export interface RequestData { binding: OperatorBinding; caller: OperatorCaller; preset: string; policyDigest: string; mail: PayloadRef }
export interface OperatorRequest extends RequestData {
  v: 1; id: string; created: number; expires: number; state: "notifying" | "notified" | "notification-failed" | "claimed";
  notification?: { code: number; stdout: string; stderr: string; at: number }; approval?: OperatorApproval;
}
export const OPERATOR_APPROVAL_MS = 300_000;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const time = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function operatorRequestPath(id: string, env = process.env): string {
  if (!OPERATOR_REQUEST_ID.test(id)) throw new Error("invalid operator request id");
  return join(recoveryRoot(env), "operator-requests", `${id}.json`);
}
function validData(data: RequestData): boolean {
  return object(data.binding) && validOperatorBinding(data.binding) && object(data.caller)
    && [data.caller.handle, data.caller.team, data.preset].every(value => typeof value === "string" && validToken(value))
    && typeof data.caller.instance === "string" && data.caller.instance !== ""
    && /^%\d+$/.test(data.caller.paneId) && /^sha256:[a-f0-9]{64}$/.test(data.policyDigest)
    && object(data.mail) && typeof data.mail.id === "string" && validToken(data.mail.id)
    && typeof data.mail.home === "string" && data.mail.home.startsWith("/");
}
function notificationAccepted(request: OperatorRequest): boolean {
  if (request.notification?.code !== 0) return false;
  try {
    const receipt = JSON.parse(request.notification.stdout);
    return receipt.ok === true && receipt.notified === true && receipt.delivery === "accepted" && receipt.human_received === null
      && receipt.from === request.caller.handle && receipt.team === request.caller.team
      && typeof receipt.label === "string" && receipt.label.includes(request.id);
  } catch { return false; }
}
export function createOperatorRequest(data: RequestData, env = process.env, now = Date.now()): OperatorRequest {
  if (!validData(data) || !time(now)) throw new Error("invalid operator approval request");
  const request: OperatorRequest = { ...data, v: 1, id: `operator-request-${randomUUID()}`, created: now,
    expires: now + OPERATOR_APPROVAL_MS, state: "notifying" };
  mkdirSync(join(recoveryRoot(env), "operator-requests"), { recursive: true, mode: 0o700 });
  writeFileSync(operatorRequestPath(request.id, env), JSON.stringify(request, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return request;
}
export function readOperatorRequest(id: string, env = process.env): OperatorRequest {
  const fd = openSync(operatorRequestPath(id, env), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  let request;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) throw new Error("operator request is not a bounded regular file");
    request = JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
  if (!object(request) || request.v !== 1 || request.id !== id || !validData(request as unknown as RequestData)
    || !time(request.created) || !time(request.expires) || request.expires - request.created !== OPERATOR_APPROVAL_MS
    || !["notifying", "notified", "notification-failed", "claimed"].includes(request.state)) throw new Error("invalid operator approval request");
  if (["notified", "claimed"].includes(request.state) && !notificationAccepted(request as OperatorRequest)) throw new Error("operator notification evidence is invalid");
  return request as OperatorRequest;
}
function changeRequest(id: string, env: NodeJS.ProcessEnv, change: (request: OperatorRequest) => void): OperatorRequest {
  const path = operatorRequestPath(id, env), lock = acquirePathLock(`${path}.lock`, 1000, env);
  if (!lock) throw new Error("operator approval request is busy");
  try {
    const request = readOperatorRequest(id, env);
    change(request);
    atomicWrite(path, JSON.stringify(request, null, 2) + "\n");
    return request;
  } finally { lock.release(); }
}
export function finishOperatorNotification(id: string, result: { code: number; stdout: string; stderr: string }, env = process.env, now = Date.now()): void {
  changeRequest(id, env, request => {
    if (request.state !== "notifying") throw new Error("operator notification already finished; no automatic repeat");
    request.notification = { code: result.code, stdout: result.stdout.slice(0, 16384), stderr: result.stderr.slice(0, 4096), at: now };
    request.state = notificationAccepted(request) ? "notified" : "notification-failed";
  });
}
/** --approve is the initiating agent's attestation of a human answer, not human authentication. */
export function claimOperatorRequest(id: string, caller: OperatorCaller, binding: OperatorBinding, policy: OperatorPolicy,
  note: unknown, env = process.env, now = Date.now()): OperatorRequest {
  return changeRequest(id, env, request => {
    if (request.state === "claimed") throw new Error("operator approval request was already consumed");
    if (request.state !== "notified" || !notificationAccepted(request)) throw new Error("operator notification was not accepted");
    if (!time(now) || now < request.created || now >= request.expires) throw new Error("operator approval request expired; make a new request");
    if (policy.mode !== "ask" || policy.digest !== request.policyDigest) throw new Error("operator config changed since the approval request");
    if (!sameOperatorBinding(binding, request.binding)) throw new Error("operator target changed since the approval request");
    if (["handle", "instance", "paneId", "team"].some(key => caller[key as keyof OperatorCaller] !== request.caller[key as keyof OperatorCaller])) {
      throw new Error("only the unchanged initiating seat may attest to this approval");
    }
    if (!object(note) || note.request_id !== id || typeof note.reply !== "string" || !note.reply.trim() || note.reply.length > 4096) {
      throw new Error("approval file needs this request_id and the explicit human reply");
    }
    request.approval = { requestId: id, reply: note.reply };
    request.state = "claimed";
  });
}
