import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { atomicWrite } from "../fsatomic";
import { acquirePaneLock } from "../panelock";
import { physicalSocketPath, tmuxReadOnly } from "../tmux";
import type { OwnedCrew } from "./crew";
import type { RecoveryMode } from "../recovery-policy";

export const WALL_MS = 300_000;
export const MAX_EFFECTS = 6;
export interface RecoveryTarget {
  team: string; handle: string; registry: string; pane: string; paneId: string;
  session: string; instance: string; harness: string; processPid?: string;
}
export interface PayloadRef { home: string; id: string; team?: string }
export interface RecoveryRun {
  v: 1; id: string; mode: RecoveryMode; hold: boolean; target: RecoveryTarget;
  ownerPane: string; ownerPid: number; started: number; deadline: number;
  effects: number; payloads: PayloadRef[]; state: "active" | "released" | "stopped";
  nudgeExpected?: string; summary?: string; escalationAttemptedAt?: string; escalationStatus?: "attempted" | "delivered" | "unconfirmed"; escalationCode?: number; operatorPaused?: boolean; submission?: PayloadRef; worker?: OwnedCrew;
  caller?: { team: string; actor: string; registry: string; root: string; home: string };
}
export interface Liveness {
  now: number;
  processAlive(pid: number): boolean;
  paneAlive(id: string): boolean;
}
export const live = (env = process.env): Liveness => ({
  now: Date.now(),
  processAlive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  },
  paneAlive(id) {
    const r = tmuxReadOnly(["display-message", "-p", "-t", id, "#{pane_id}"], env);
    // A budget refusal cannot prove the owner vanished. The fixed deadline still bounds the hold.
    return r.rateLimited === true || (r.code === 0 && r.stdout.trim() === id);
  },
});
export function recoveryRoot(env = process.env): string {
  return join(env.TAP_INDEX_HOME || join(env.HOME || homedir(), ".tap"), "debug", "recovery");
}
export function runDirectory(id: string, env = process.env): string {
  if (!/^recovery-[a-f0-9-]{36}$/.test(id)) throw new Error("invalid recovery id");
  return join(recoveryRoot(env), id);
}
export function readRun(id: string, env = process.env): RecoveryRun {
  const r = JSON.parse(readFileSync(join(runDirectory(id, env), "run.json"), "utf8"));
  if (r.v !== 1 || r.id !== id || typeof r.hold !== "boolean" || !/^%\d+$/.test(r.target?.paneId) ||
      !Number.isSafeInteger(r.ownerPid) || r.ownerPid <= 0 ||
      !Number.isFinite(r.started) || !Number.isFinite(r.deadline) ||
      r.deadline - r.started !== WALL_MS || !Number.isSafeInteger(r.effects) || r.effects < 0 ||
      !["report-only", "cautious", "aggressive"].includes(r.mode) ||
      !["active", "released", "stopped"].includes(r.state) || !Array.isArray(r.payloads)) {
    throw new Error("invalid recovery ownership record");
  }
  return r;
}
/** Acting runs use the target mutex; unique report-only artifacts never own it. Artifacts outlive cleanup. */
export function writeRun(run: RecoveryRun, env = process.env): void {
  const path = join(runDirectory(run.id, env), "run.json");
  if (existsSync(path)) {
    const previous = readRun(run.id, env);
    for (const key of ["id", "mode", "hold", "target", "ownerPane", "ownerPid", "started", "deadline"] as const) {
      if (JSON.stringify(previous[key]) !== JSON.stringify(run[key])) throw new Error(`recovery ${key} is immutable`);
    }
  }
  atomicWrite(path, JSON.stringify(run, null, 2) + "\n");
}
export function updateRun(id: string, change: (run: RecoveryRun) => void, env = process.env): RecoveryRun {
  const before = readRun(id, env);
  if (before.mode === "report-only") { change(before); writeRun(before, env); return before; }
  const lock = acquirePaneLock(before.target.paneId, 1000, env);
  if (!lock) throw new Error("recovery metadata is busy");
  try { const run = readRun(id, env); change(run); writeRun(run, env); return run; }
  finally { lock.release(); }
}
function holdPath(paneId: string, env = process.env): string {
  const key = createHash("sha256").update(`${physicalSocketPath(env)}\0${paneId}`).digest("hex");
  return join(recoveryRoot(env), "holds", `${key}.json`);
}
export function readHold(paneId: string, env = process.env): RecoveryRun | null {
  try {
    const pointer = JSON.parse(readFileSync(holdPath(paneId, env), "utf8"));
    const run = readRun(pointer.id, env);
    return run.target.paneId === paneId ? run : null;
  } catch { return null; } // Invalid ownership grants neither a worker effect nor an indefinite hold.
}
export function active(run: RecoveryRun | null, facts = live()): boolean {
  return run !== null && run.hold && run.state === "active" && run.mode !== "report-only" &&
    facts.now >= run.started && facts.now < run.deadline && /^%\d+$/.test(run.ownerPane) &&
    facts.processAlive(run.ownerPid) && facts.paneAlive(run.ownerPane);
}
/** Courier calls this while holding the same bound-pane-id mutex as create/update/effects. */
export function recoveryHold(paneId: string, env = process.env, facts?: Liveness): boolean {
  return active(readHold(paneId, env), facts ?? live(env));
}
export function createRun(
  target: RecoveryTarget, mode: RecoveryMode, payloads: PayloadRef[],
  ownerPane: string, ownerPid: number, env = process.env, facts = live(env), hold = true,
): RecoveryRun {
  if (!/^%\d+$/.test(target.paneId)) throw new Error("recovery requires a bound pane id");
  if (hold && mode !== "report-only" && (!/^%\d+$/.test(ownerPane) || !facts.processAlive(ownerPid) || !facts.paneAlive(ownerPane))) {
    throw new Error("recovery requires a live owner pane and process");
  }
  const lock = mode === "report-only" ? null : acquirePaneLock(target.paneId, 1000, env);
  if (mode !== "report-only" && !lock) throw new Error("target has an in-flight effect; recovery did not acquire ownership");
  try {
    if (mode !== "report-only" && recoveryHold(target.paneId, env, facts)) throw new Error("target already has a recovery owner");
    const run: RecoveryRun = { v: 1, id: `recovery-${randomUUID()}`, mode, hold: hold && mode !== "report-only", target, payloads,
      ownerPane, ownerPid, started: facts.now, deadline: facts.now + WALL_MS,
      effects: 0, state: mode === "report-only" ? "released" : "active" };
    mkdirSync(runDirectory(run.id, env), { recursive: true, mode: 0o700 });
    writeRun(run, env);
    if (run.hold) atomicWrite(holdPath(target.paneId, env), JSON.stringify({ id: run.id }));
    return run;
  } finally { lock?.release(); }
}
export function owns(run: RecoveryRun, env = process.env, facts?: Liveness): boolean {
  const current = readHold(run.target.paneId, env);
  return current?.id === run.id && active(current, facts ?? live(env));
}

/** Ordinary nudge records a short operation without claiming a thinking-time hold. */
export function canAct(run: RecoveryRun, env = process.env, facts = live(env)): boolean {
  const current = readRun(run.id, env);
  if (current.hold) return owns(current, env, facts);
  return current.state === "active" && current.mode !== "report-only" &&
    facts.now >= current.started && facts.now < current.deadline && facts.processAlive(current.ownerPid) &&
    !recoveryHold(current.target.paneId, env, facts);
}

export function releaseRun(id: string, summary?: string, env = process.env): void {
  const initial = readRun(id, env);
  if (initial.mode === "report-only") {
    if (summary !== undefined) { initial.summary = summary; writeRun(initial, env); }
    return;
  }
  const lock = acquirePaneLock(initial.target.paneId, 1000, env);
  if (!lock) throw new Error("recovery release is busy; fixed deadline still applies");
  try {
    const run = readRun(id, env);
    if (run.state === "active") run.state = "released";
    if (summary !== undefined) run.summary = summary;
    writeRun(run, env);
    // Never unlink a pointer observed before the lock; a successor's record stays untouched.
    if (readHold(run.target.paneId, env)?.id === id) atomicWrite(holdPath(run.target.paneId, env), "{}\n");
  } finally { lock.release(); }
}
