import type { RecoveryRun, RecoveryTarget } from "./state";
import type { SeatVerdict } from "../verbs/doctor-seat";
import { TapError } from "../context";
import { validToken } from "../ids";

export type UnwedgeRung = "report" | "message" | "nudge" | "continue" | "restart";
export interface UnwedgeRequest { handle: string; rung: UnwedgeRung; json: boolean; after?: string }
export interface UnwedgeBinding extends RecoveryTarget { serverSocket: string; serverEpoch: string; nativeSessionId: string }
export interface UnwedgeStimulus { id?: string; hash: string }
export interface UnwedgePosition { path: string; offset: number; fileId?: string; prefixHash?: string }
export interface UnwedgeAttempt {
  v: 1; rung: UnwedgeRung; binding: UnwedgeBinding; cause: string;
  outcome: "completed" | "refused_pre_effect" | "uncertain_effect" | null;
  effect: "none" | "possible"; completedAt?: number; nextEligibleAt?: number;
  stimulus?: UnwedgeStimulus; position?: UnwedgePosition; predecessor?: string; successor?: string;
  actuator?: string; detail?: string;
}
export interface UnwedgeObservation {
  binding: UnwedgeBinding; verdict: SeatVerdict | null; cause: string; turnEnded: boolean | null;
  protection: "clear" | "held" | "unknown"; composer: "empty" | "staged" | "draft" | "queued" | "unreadable";
  stagedPayloadId?: string; progress: "unchanged" | "own-stimulus-stopped" | "productive" | "unknown";
}
export type UnwedgeAdmission = { action: UnwedgeRung | "submit-staged" } | { action: "refuse"; reason: string; nextEligibleAt?: number };
export const UNWEDGE_OBSERVATION_MS = 120_000;
export const RECOVERY_ID = /^recovery-[a-f0-9-]{36}$/;
const RUNGS: readonly UnwedgeRung[] = ["report", "message", "nudge", "continue", "restart"];
const BINDING_FIELDS = ["team", "handle", "registry", "pane", "paneId", "session", "instance", "harness", "processPid", "serverSocket", "serverEpoch", "nativeSessionId"] as const;
const TARGET_FIELDS = ["team", "handle", "registry", "pane", "paneId", "session", "instance", "harness", "processPid"] as const;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const time = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function validUnwedgeBinding(value: unknown): value is UnwedgeBinding {
  return object(value) && BINDING_FIELDS.every(key => typeof value[key] === "string" && value[key] !== "")
    && /^%\d+$/.test(value.paneId as string) && /^\d+$/.test(value.processPid as string);
}
export function sameUnwedgeBinding(a: UnwedgeBinding, b: UnwedgeBinding): boolean {
  return BINDING_FIELDS.every(key => a[key] === b[key]);
}
export function validUnwedgeAttempt(value: unknown): value is UnwedgeAttempt {
  if (!object(value) || value.v !== 1 || !RUNGS.includes(value.rung as UnwedgeRung) || !validUnwedgeBinding(value.binding)
    || typeof value.cause !== "string" || ![null, "completed", "refused_pre_effect", "uncertain_effect"].includes(value.outcome as null | string)
    || !["none", "possible"].includes(value.effect as string)) return false;
  for (const key of ["predecessor", "successor", "actuator"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || !RECOVERY_ID.test(value[key]))) return false;
  }
  if (value.stimulus !== undefined && (!object(value.stimulus) || typeof value.stimulus.hash !== "string"
    || !/^[a-f0-9]{64}$/.test(value.stimulus.hash) || (value.stimulus.id !== undefined && (typeof value.stimulus.id !== "string" || !value.stimulus.id)))) return false;
  if (value.position !== undefined && (!object(value.position) || typeof value.position.path !== "string"
    || !value.position.path.startsWith("/") || !Number.isSafeInteger(value.position.offset) || (value.position.offset as number) < 0)) return false;
  if (value.outcome !== null && (!time(value.completedAt) || !time(value.nextEligibleAt)
    || value.nextEligibleAt < value.completedAt)) return false;
  if (value.outcome === "completed" && value.rung !== "report" && (value.effect !== "possible" || !value.stimulus)) return false;
  if (value.effect === "possible" && !value.stimulus) return false;
  if (value.outcome === "refused_pre_effect" && value.effect !== "none") return false;
  return true;
}

export function parseUnwedgeArgs(argv: string[]): UnwedgeRequest {
  const result: UnwedgeRequest = { handle: "", rung: "report", json: false };
  const seen = new Set<string>();
  const fail = (detail: string): never => { throw new TapError(1, "usage_error", "tap help unwedge", detail); };
  let positional = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!positional && arg === "--") { positional = true; continue; }
    if (!positional && arg.startsWith("-")) {
      if (seen.has(arg)) fail(`repeated option '${arg}'`);
      seen.add(arg);
      if (arg === "--json") result.json = true;
      else if (arg === "--rung" || arg === "--after") {
        const value = argv[++i];
        if (!value) fail(`${arg} needs a value`);
        if (arg === "--rung") {
          if (!RUNGS.includes(value as UnwedgeRung)) fail(`unknown rung '${value}'`);
          result.rung = value as UnwedgeRung;
        } else {
          if (!RECOVERY_ID.test(value!)) fail("--after needs an exact recovery ID");
          result.after = value;
        }
      } else fail(`unknown option '${arg}'`);
    } else {
      if (result.handle || !validToken(arg)) fail("name one local registered handle");
      result.handle = arg;
    }
  }
  if (!result.handle) fail("a registered handle is required");
  if ((RUNGS.indexOf(result.rung) > 1) !== !!result.after) fail("--after is required only for nudge, continue and restart");
  return result;
}

function supported(binding: UnwedgeBinding, cause: string): boolean {
  return (binding.harness === "codex" && cause === "model_capacity") || (binding.harness === "claude" && cause === "api_error");
}

export function admitUnwedge(request: UnwedgeRequest, seen: UnwedgeObservation, previous: RecoveryRun | undefined, now: number): UnwedgeAdmission {
  const refuse = (reason: string, nextEligibleAt?: number): UnwedgeAdmission => ({ action: "refuse", reason, ...(nextEligibleAt !== undefined && { nextEligibleAt }) });
  if (request.rung === "report") return { action: "report" };
  if (!time(now) || !validUnwedgeBinding(seen.binding) || seen.binding.handle !== request.handle) return refuse("target binding is incomplete or changed");
  if (seen.protection !== "clear") return refuse("operator protection is active or unobservable");
  if (seen.turnEnded !== true) return refuse("the session does not prove a stopped turn");
  if (request.rung !== "message") {
    const prior = previous?.unwedge;
    if (!previous || previous.id !== request.after || !validUnwedgeAttempt(prior) || previous.state !== "released" || previous.hold
      || prior.outcome === null || prior.completedAt! < previous.started || prior.completedAt! > now
      || !sameUnwedgeBinding(prior.binding, seen.binding)
      || TARGET_FIELDS.some(key => previous.target[key] !== prior.binding[key])) return refuse("previous attempt is missing, malformed or for another target");
    if (RUNGS.indexOf(request.rung) !== RUNGS.indexOf(prior.rung) + 1 || prior.successor) return refuse("lower rung is missing or has already been consumed");
    if (!supported(prior.binding, prior.cause)) return refuse("previous cause does not authorize recovery");
    if (seen.progress !== "unchanged" && seen.progress !== "own-stimulus-stopped") return refuse("work progressed or progress cannot be checked");
    // A single completion key does not judge a recovery turn that has not been submitted.
    if (request.rung === "nudge" && prior.rung === "message" && ["completed", "uncertain_effect"].includes(prior.outcome)
      && prior.effect === "possible" && prior.stimulus?.id && seen.stagedPayloadId === prior.stimulus.id
      && seen.composer === "staged" && seen.progress === "unchanged"
      && (seen.verdict === "healthy" || (seen.verdict === "severed" && seen.cause === prior.cause))) return { action: "submit-staged" };
    if (prior.outcome !== "completed") return refuse("lower rung did not complete; inspect its outcome before further recovery");
    if (prior.cause !== seen.cause) return refuse("the stopped cause changed");
    if (prior.nextEligibleAt! < prior.completedAt! + UNWEDGE_OBSERVATION_MS) return refuse("previous observation deadline is invalid");
    if (now < prior.nextEligibleAt!) return refuse("allow the recovery observation window to finish", prior.nextEligibleAt);
  } else if (request.after) return refuse("a message starts a new incident and takes no predecessor");
  if (seen.verdict !== "severed" || !supported(seen.binding, seen.cause)) return refuse("the diagnosis does not authorize recovery");
  if (seen.composer !== "empty") return refuse("the composer holds input or cannot be checked");
  return { action: request.rung };
}
