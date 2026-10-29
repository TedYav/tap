import type { RecoveryMode } from "../recovery-policy";
import { acquirePaneLock } from "../panelock";
import { admitUnwedge, sameUnwedgeBinding, UNWEDGE_OBSERVATION_MS, validUnwedgeAttempt, validUnwedgeBinding,
  type UnwedgeAdmission, type UnwedgeBinding, type UnwedgeObservation, type UnwedgePosition, type UnwedgeRung, type UnwedgeStimulus } from "./unwedge-policy";
import { createRun, readRun, writeRun, type RecoveryRun } from "./state";
interface Start { binding: UnwedgeBinding; rung: UnwedgeRung; cause: string; ownerPane: string; mode: RecoveryMode }
export function beginUnwedgeAttempt(input: Start, env = process.env, now = Date.now()): RecoveryRun {
  if (!validUnwedgeBinding(input.binding) || !Number.isFinite(now) || now < 0) throw new Error("invalid unwedge target or time");
  const report = input.rung === "report";
  const disabled = input.mode === "report-only";
  const run = createRun(input.binding, report ? "report-only" : input.mode, [], input.ownerPane, process.pid, env,
    { now, processAlive: pid => pid === process.pid, paneAlive: () => false }, false);
  run.unwedge = { v: 1, rung: input.rung, binding: input.binding, cause: input.cause,
    outcome: report ? "completed" : disabled ? "refused_pre_effect" : null,
    effect: "none", ...((report || disabled) && { completedAt: now, nextEligibleAt: now }),
    ...(disabled && !report && { detail: "recovery policy is report-only" }) };
  writeRun(run, env);
  return run;
}

function mutable(id: string, env: NodeJS.ProcessEnv, now: number): RecoveryRun & { unwedge: NonNullable<RecoveryRun["unwedge"]> } {
  const run = readRun(id, env);
  if (!validUnwedgeAttempt(run.unwedge) || run.hold || run.state !== "active" || run.ownerPid !== process.pid
    || !Number.isFinite(now) || now < run.started || now >= run.deadline) throw new Error("unwedge attempt is invalid, finished, expired or owned by another process");
  return run as RecoveryRun & { unwedge: NonNullable<RecoveryRun["unwedge"]> };
}

function underMutex<T>(id: string, env: NodeJS.ProcessEnv, fn: () => T): T {
  const before = readRun(id, env);
  const lock = acquirePaneLock(before.target.paneId, 1000, env);
  if (!lock) throw new Error("unwedge predecessor metadata is busy");
  try { return fn(); } finally { lock.release(); }
}

/** Claim once; an abandoned claim remains evidence, regardless of its owner's liveness. */
export function claimUnwedgePredecessor(id: string, priorId: string, seen: UnwedgeObservation, env = process.env, now = Date.now()): UnwedgeAdmission {
  return underMutex(id, env, () => {
    const child = mutable(id, env, now);
    if (child.unwedge.outcome !== null || child.unwedge.predecessor || !sameUnwedgeBinding(child.unwedge.binding, seen.binding)) throw new Error("unwedge child already used or target changed");
    const parent = readRun(priorId, env);
    const admission = admitUnwedge({ handle: child.target.handle, rung: child.unwedge.rung, after: priorId, json: false }, seen, parent, now);
    if (admission.action === "refuse") throw new Error(admission.reason);
    if (admission.action === "report" || admission.action === "message") throw new Error("this rung takes no predecessor");
    // Parent first: a crash between the writes leaves a consumed predecessor, never a duplicate license.
    parent.unwedge!.successor = id;
    writeRun(parent, env);
    child.unwedge.predecessor = priorId;
    writeRun(child, env);
    return admission;
  });
}

/** The caller persists this intent before handing control to a non-idempotent actuator. */
export function markUnwedgeEffect(id: string, stimulus: UnwedgeStimulus, position: UnwedgePosition, env = process.env, now = Date.now()): void {
  underMutex(id, env, () => {
    const run = mutable(id, env, now), attempt = run.unwedge;
    if (attempt.outcome !== null || attempt.effect !== "none" || attempt.rung === "report") throw new Error("unwedge effect was already attempted or is report-only");
    if (attempt.rung !== "message") {
      if (!attempt.predecessor) throw new Error("unwedge effect requires its claimed predecessor");
      const parent = readRun(attempt.predecessor, env);
      if (!validUnwedgeAttempt(parent.unwedge) || parent.unwedge.successor !== id
        || !sameUnwedgeBinding(parent.unwedge.binding, attempt.binding)) throw new Error("unwedge predecessor claim changed");
    }
    Object.assign(attempt, { effect: "possible", outcome: "uncertain_effect", stimulus, position,
      completedAt: now, nextEligibleAt: now + UNWEDGE_OBSERVATION_MS });
    if (!validUnwedgeAttempt(attempt)) throw new Error("invalid unwedge stimulus or position");
    writeRun(run, env);
  });
}

export function finishUnwedgeAttempt(id: string, outcome: "completed" | "refused_pre_effect" | "uncertain_effect", detail: string, env = process.env, now = Date.now()): void {
  underMutex(id, env, () => {
    const run = mutable(id, env, now), attempt = run.unwedge;
    if (outcome === "refused_pre_effect" && attempt.effect !== "none") throw new Error("cannot erase a possible effect");
    if (outcome !== "refused_pre_effect" && attempt.effect !== "possible") throw new Error("no recorded effect to finish");
    Object.assign(attempt, { outcome, detail, completedAt: now, nextEligibleAt: now + (attempt.effect === "possible" ? UNWEDGE_OBSERVATION_MS : 0) });
    run.state = "released";
    writeRun(run, env);
    if (outcome === "refused_pre_effect" && attempt.predecessor) {
      const parent = readRun(attempt.predecessor, env);
      if (validUnwedgeAttempt(parent.unwedge) && sameUnwedgeBinding(parent.unwedge.binding, attempt.binding) && parent.unwedge.successor === id) {
        delete parent.unwedge.successor;
        writeRun(parent, env);
      }
    }
  });
}
