import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquirePaneLock } from "../panelock";
import { appendRecoveryEvent, REAL_RECOVERY_IO, recoveryEffect, type EffectIO } from "./effect";
import { canAct, readRun, runDirectory, writeRun, type Liveness } from "./state";
import { operatorSurface, type OperatorSurface } from "./operator-screen";

export function sampleOperator(id: string, io: EffectIO = REAL_RECOVERY_IO, env = process.env, facts?: () => Liveness): { id: string; path: string; surface: OperatorSurface } {
  const initial = readRun(id, env);
  if (initial.purpose !== "operator") throw new Error("not an operator run");
  const lock = acquirePaneLock(initial.target.paneId, 1000, env);
  if (!lock) throw new Error("operator observation is busy");
  try {
    const run = readRun(id, env);
    if (!canAct(run, env, facts?.())) throw new Error("operator ownership is no longer active");
    const before = io.authorize(run.target);
    if (before) throw new Error(before);
    const frame = io.capture(run.target, false), surface = operatorSurface(run.target.harness, frame);
    const after = io.authorize(run.target);
    if (after || !canAct(run, env, facts?.())) throw new Error(after || "operator observation expired");
    const sample = { id: `sample-${randomUUID()}`, hash: createHash("sha256").update(frame).digest("hex"), at: facts?.().now ?? Date.now(), used: false };
    const path = join(runDirectory(id, env), `${sample.id}.ansi`);
    writeFileSync(path, frame, { mode: 0o600, flag: "wx" });
    run.operator!.sample = sample; writeRun(run, env);
    appendRecoveryEvent(id, { v: 1, recoveryId: id, seat: `${run.target.team}/${run.target.handle}`, mode: run.mode,
      action: "operator observation", reason: "fresh viewport for one navigation decision", before: path, after: path,
      state: null, effect: "none", outcome: "verified", summary: `observed ${surface.kind}; no keys sent`,
      at: new Date(sample.at).toISOString(), incident: false }, env);
    return { id: sample.id, path, surface };
  } finally { lock.release(); }
}
export function operatorStep(id: string, sample: string, key: string, reason: string, gate: () => string,
  io: EffectIO = REAL_RECOVERY_IO, env = process.env, facts?: () => Liveness): ReturnType<typeof recoveryEffect> {
  const run = readRun(id, env);
  if (run.purpose !== "operator") throw new Error("not an operator run");
  return recoveryEffect(id, `operator:${sample}`, reason, ["send-keys", "-t", run.target.paneId, key], io, env, facts, gate);
}
