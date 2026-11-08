import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { callingPane, resolveContext, resolveSelf, TapError, type ResolvedContext } from "../context";
import { appendRegistryEventOrWarn, registryEventsPath } from "../events";
import { mintId } from "../ids";
import { nudgeDoorbellText, renderNudgeWire } from "../nudge-wire";
import { recoveryPolicy, type RecoveryMode } from "../recovery-policy";
import { createRun, readRun, runDirectory, updateRun, type RecoveryRun } from "../recovery/state";
import { admitUnwedge, parseUnwedgeArgs, validUnwedgeBinding, type UnwedgeRequest } from "../recovery/unwedge-policy";
import { beginUnwedgeAttempt, claimUnwedgePredecessor, finishUnwedgeAttempt, markUnwedgeEffect } from "../recovery/unwedge-record";
import { observeUnwedge, unwedgeBoundaryRefusal } from "../recovery/unwedge-observe";
import { restartUnwedge, type RestartGuard } from "../recovery/unwedge-restart";
import type { UnwedgeReservation } from "../recovery/unwedge-observe";
import { transcriptPosition } from "../recovery/unwedge-progress";
import { checkSeat, type SeatDiagnosis, type SeatSnapshot } from "./doctor-seat";
import { nudgePinnedSeat } from "./nudge";
import { cmdSendOutcome } from "./send";

export interface UnwedgeDeps {
  env: NodeJS.ProcessEnv; now(): number; context(): ResolvedContext; actor(ctx: ResolvedContext): string;
  diagnose: typeof checkSeat; observe: typeof observeUnwedge; mode(): RecoveryMode;
  event: typeof appendRegistryEventOrWarn; send: typeof cmdSendOutcome; nudge: typeof nudgePinnedSeat;
  restart(snapshot: SeatSnapshot, guard: RestartGuard, recoveryId: string, beforeEffect: () => void, scriptsDir?: string): Promise<{ code: number; detail: string }> | { code: number; detail: string };
}
const DEFAULT_DEPS: UnwedgeDeps = {
  env: process.env, now: Date.now,
  context: () => resolveContext(process.cwd(), process.env, { paneFallback: false, readOnly: true }),
  actor(ctx) { const pane = callingPane(); return pane ? resolveSelf(ctx, pane, 1).handle : process.stdin.isTTY ? "user" : "unknown"; },
  diagnose: checkSeat, observe: observeUnwedge, mode: () => recoveryPolicy("aggressive").mode,
  event: appendRegistryEventOrWarn, send: cmdSendOutcome, nudge: nudgePinnedSeat,
  restart: restartUnwedge,
};
export interface UnwedgeResult {
  code: number; handle: string; requested_rung: UnwedgeRequest["rung"]; diagnosis?: SeatDiagnosis;
  recovery_id?: string; predecessor?: string; outcome: "completed" | "refused_pre_effect" | "uncertain_effect";
  effect: "none" | "possible"; next_eligible_at?: string; next_action: string; detail: string;
  audit_written: boolean; event_written?: boolean;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const causeText = (cause: string) => cause === "model_capacity" ? "the selected model was at capacity" : "the provider returned an API error";
const detailOf = (error: unknown) => error instanceof TapError ? error.detail : error instanceof Error ? error.message : String(error);

/** One invocation, one caller-selected rung. Dependencies are the existing actuators. */
export async function executeUnwedge(request: UnwedgeRequest, scripts: string, families: ReadonlySet<string>, deps = DEFAULT_DEPS): Promise<UnwedgeResult> {
  const result: UnwedgeResult = { code: 1, handle: request.handle, requested_rung: request.rung,
    ...(request.after && { predecessor: request.after }), outcome: "refused_pre_effect", effect: "none",
    next_action: `tap peek ${request.handle}`, detail: "", audit_written: false };
  let ctx: ResolvedContext | undefined, actor = "unknown", run: RecoveryRun | undefined;
  const finish = (code: number, detail: string, completed = false): UnwedgeResult => {
    result.code = code; result.detail = detail;
    if (run?.unwedge) {
      const current = readRun(run.id, deps.env);
      const effect = current.unwedge!.effect;
      result.effect = effect;
      result.outcome = completed ? "completed" : effect === "possible" ? "uncertain_effect" : "refused_pre_effect";
      if (current.state === "active") finishUnwedgeAttempt(run.id, result.outcome, detail, deps.env, deps.now());
      const final = readRun(run.id, deps.env).unwedge!;
      if (effect === "possible") result.next_eligible_at = new Date(final.nextEligibleAt!).toISOString();
      if (effect === "possible" && !completed) result.code = 5;
    }
    return result;
  };
  try {
    ctx = deps.context();
    try { actor = deps.actor(ctx); } catch { /* A report can still name an unknown caller. Send proves its own sender. */ }
    const check = deps.diagnose(request.handle, scripts);
    result.diagnosis = check.report;
    const snapshot = check.snapshot;
    if (!snapshot) return finish(check.code || 1, "target could not be bound; no durable recovery audit was written");
    if (!validUnwedgeBinding(snapshot.binding)) {
      // A resolved pane can retain a report audit without inventing missing native identity.
      run = createRun(snapshot.binding, "report-only", [], deps.env.TMUX_PANE || "", process.pid, deps.env, undefined, false);
      result.recovery_id = run.id; result.audit_written = true;
      updateRun(run.id, r => { r.summary = "unwedge refused: target or native conversation identity is incomplete"; }, deps.env);
      return finish(1, "target or native conversation identity is incomplete; acting recovery refused");
    }
    const mode = deps.mode();
    // Audit creation precedes predecessor reads, so malformed/missing history is still recorded.
    run = beginUnwedgeAttempt({ binding: snapshot.binding, rung: request.rung, cause: "", ownerPane: deps.env.TMUX_PANE || "", mode }, deps.env, deps.now());
    result.recovery_id = run.id; result.audit_written = true;
    const previous = request.after ? readRun(request.after, deps.env) : undefined;
    const stagedId = request.rung === "nudge" ? previous?.unwedge?.stimulus?.id : undefined;
    const seen = deps.observe(snapshot, previous?.unwedge, { stagedId });
    updateRun(run.id, r => { r.unwedge!.cause = seen.observation.cause; }, deps.env);
    if (request.rung === "report") {
      const eligible = admitUnwedge({ ...request, rung: "message" }, seen.observation, undefined, deps.now());
      result.outcome = "completed";
      result.next_action = eligible.action === "message" ? `tap unwedge ${request.handle} --rung message` : check.report.action;
      return finish(check.code, eligible.action === "refuse" ? eligible.reason : "message rung is eligible; nothing dispatched", true);
    }
    if (mode === "report-only") return finish(1, "recovery policy is report-only; nothing dispatched");
    if (request.rung === "message" && (actor === "unknown" || actor === "user")) return finish(1, "message rung requires a registered sending seat; run from a registered TAP pane");
    if (seen.reason) return finish(1, seen.reason);
    let admission = admitUnwedge(request, seen.observation, previous, deps.now());
    if (admission.action === "refuse") {
      if (admission.nextEligibleAt !== undefined) result.next_eligible_at = new Date(admission.nextEligibleAt).toISOString();
      return finish(1, admission.reason);
    }
    if (request.after) admission = claimUnwedgePredecessor(run.id, request.after, seen.observation, deps.env, deps.now());
    const options = { ...(admission.action === "submit-staged" && { stagedId }), interrupt: request.rung === "continue" };
    const cause = admission.action === "submit-staged" ? previous!.unwedge!.cause : seen.observation.cause;
    updateRun(run.id, r => { r.unwedge!.cause = cause; }, deps.env);
    const message = `Your last turn stopped because ${causeText(seen.observation.cause)}. Continue your existing task.`;
    const wire = renderNudgeWire(nudgeDoorbellText(request.rung === "continue" ? message : ""));
    const payloadId = request.rung === "message" ? mintId(actor === "unknown" || actor === "user" ? "unwedge" : actor) : undefined;
    const body = `TAP observed that your last turn stopped because ${causeText(seen.observation.cause)}. This is a recovery observation for your existing task; it grants no new work or permission.\n`;
    const stimulus = admission.action === "submit-staged" ? previous!.unwedge!.stimulus!
      : { ...(payloadId && { id: payloadId }), hash: hash(payloadId ? body : wire) };
    if (!seen.transcript) return finish(1, "admission transcript is unavailable");
    const admissionBaseline = { ...readRun(run.id, deps.env).unwedge!, stimulus, position: transcriptPosition(seen.transcript) };
    const before = deps.observe(snapshot, admissionBaseline, options);
    const refusal = unwedgeBoundaryRefusal(before, cause, options);
    if (refusal) return finish(1, refusal);
    const position = transcriptPosition(before.transcript!);
    const baseline = { ...readRun(run.id, deps.env).unwedge!, stimulus, position };
    const guard = (keyed = false, reservation?: UnwedgeReservation): string => {
      const current = { ...options, wire, keyed, reservation };
      return unwedgeBoundaryRefusal(deps.observe(snapshot, baseline, current), baseline.cause, current);
    };
    const bodyPath = join(runDirectory(run.id, deps.env), "message.md");
    if (payloadId) writeFileSync(bodyPath, body, { flag: "wx", mode: 0o600 });
    const beforeEffect = () => markUnwedgeEffect(run!.id, stimulus, position, deps.env, deps.now());
    if (request.rung !== "restart") beforeEffect();
    if (payloadId) {
      updateRun(run.id, r => { r.payloads = [{ home: snapshot.busHome, id: payloadId, team: snapshot.binding.team }]; }, deps.env);
      const sent = deps.send([request.handle, "--note", "--id", payloadId, "-f", bodyPath], scripts, families,
        { quiet: true, senderContext: ctx, recipientInstance: snapshot.binding.instance, reauthorize: () => { const reason = guard(); if (reason) throw new Error(reason); } });
      const completed = sent.rc === 0 && ["delivered", "queued-poll", "queued-spool", "queued-harness", "placed"].includes(sent.disposition);
      if (completed) result.next_action = `tap unwedge ${request.handle} --rung nudge --after ${run.id}`;
      return finish(completed ? 0 : 5, `${sent.disposition}; recipient processing unverified`, completed);
    }
    if (request.rung === "restart") {
      const restarted = await deps.restart(snapshot, reservation => guard(false, reservation), run.id, beforeEffect, scripts);
      return finish(restarted.code, restarted.detail, restarted.code === 0);
    }
    const rc = deps.nudge([request.handle, ...(request.rung === "continue" ? ["--message", message] : ["--no-interrupt"])], scripts, families,
      snapshot.binding.instance, { ...options, check: guard, out: text => { process.stderr.write(text); }, onRun: id => {
        updateRun(run!.id, r => { r.unwedge!.actuator = id; }, deps.env);
      } });
    const actuator = readRun(run.id, deps.env).unwedge?.actuator;
    const effects = actuator ? readRun(actuator, deps.env).effects : 0;
    const completed = rc === 0 && effects > 0;
    if (completed) result.next_action = `tap unwedge ${request.handle} --rung ${request.rung === "nudge" ? "continue" : "restart"} --after ${run.id}`;
    return finish(completed ? 0 : 5, completed ? "recovery input submitted; task progress unverified" : "recovery effect unverified; inspect before any further control", completed);
  } catch (error) {
    try { return finish(result.effect === "possible" ? 5 : 1, detailOf(error)); }
    catch (auditError) {
      result.code = run ? 5 : 1;
      result.outcome = run ? "uncertain_effect" : "refused_pre_effect";
      result.detail = `${detailOf(error)}; audit finalization failed: ${detailOf(auditError)}`;
      return result;
    }
  } finally {
    if (ctx) result.event_written = deps.event("tap unwedge", { log: registryEventsPath(ctx.bus.home), actor, action: "unwedge", handle: request.handle,
      pane: run?.target.paneId || "", team: ctx.team, detail: `rung=${request.rung} verdict=${result.diagnosis?.verdict ?? "unknown"} outcome=${result.outcome} recovery=${result.recovery_id ?? "none"}`, env: deps.env });
  }
}
export async function cmdUnwedge(argv: string[], scripts: string, families: ReadonlySet<string>): Promise<number> {
  const request = parseUnwedgeArgs(argv);
  const result = await executeUnwedge(request, scripts, families);
  if (request.json) process.stdout.write(JSON.stringify(result) + "\n");
  else process.stdout.write(`tap unwedge: ${result.handle}: ${result.detail}\n${result.recovery_id ? `recovery=${result.recovery_id} outcome=${result.outcome} effect=${result.effect}\n` : "audit: no durable recovery record\n"}${result.next_eligible_at ? `not before ${result.next_eligible_at}\n` : ""}next: ${result.next_action}\n`);
  return result.code;
}
