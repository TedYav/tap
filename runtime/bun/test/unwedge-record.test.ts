import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquirePaneLock } from "../src/panelock";
import { createRun, readRun, recoveryHold, runDirectory } from "../src/recovery/state";
import { beginUnwedgeAttempt, claimUnwedgePredecessor, markUnwedgeEffect, finishUnwedgeAttempt } from "../src/recovery/unwedge-record";
import type { UnwedgeBinding, UnwedgeObservation, UnwedgeRung } from "../src/recovery/unwedge-policy";

// All fixtures live under the isolated runner's TMPDIR; its owner reaps them.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tap-unwedge-record-"));
  const env = { ...process.env, TAP_INDEX_HOME: root, TAP_LOCK_DIR: join(root, "locks") };
  const binding: UnwedgeBinding = { team: "tap", handle: "peer", registry: join(root, "registry.json"), pane: "tap/peer:0.0",
    paneId: "%701", session: "tap/peer", instance: "instance-1", harness: "codex", processPid: "123", serverSocket: "/test/socket",
    serverEpoch: "epoch-1", nativeSessionId: "session-1" };
  const observation: UnwedgeObservation = { binding, verdict: "severed", cause: "model_capacity", turnEnded: true,
    composer: "empty", protection: "clear", progress: "unchanged" };
  const begin = (rung: UnwedgeRung, now = 1000) => beginUnwedgeAttempt({ binding, rung, cause: "model_capacity",
    ownerPane: "%700", mode: "aggressive" }, env, now);
  const dispatch = (id: string, now = 1500) => markUnwedgeEffect(id, { hash: "a".repeat(64), id: "message-1" },
    { path: join(root, "transcript.jsonl"), offset: 100 }, env, now);
  const complete = (id: string, now = 2000) => finishUnwedgeAttempt(id, "completed", "submitted; work unverified", env, now);
  const prior = () => { const r = begin("message"); dispatch(r.id); complete(r.id); return readRun(r.id, env); };
  return { root, env, binding, observation, begin, dispatch, complete, prior };
}

test("the outer attempt records no hold and does not block a separate actuator", () => {
  const f = fixture(), run = f.begin("message");
  expect(readRun(run.id, f.env).hold).toBe(false);
  expect(recoveryHold("%701", f.env, { now: 1001, paneAlive: () => true, processAlive: () => true })).toBe(false);
  expect(() => createRun(f.binding, "aggressive", [], "%700", process.pid, f.env,
    { now: 1001, paneAlive: () => true, processAlive: () => true }, false)).not.toThrow();
});

test("a predecessor can be claimed once across distinct invocation records", () => {
  const f = fixture(), prior = f.prior();
  const first = f.begin("nudge", 130000), second = f.begin("nudge", 130000);
  expect(claimUnwedgePredecessor(first.id, prior.id, f.observation, f.env, 130000)).toEqual({ action: "nudge" });
  expect(() => claimUnwedgePredecessor(second.id, prior.id, f.observation, f.env, 130000)).toThrow("consumed");
  expect(readRun(prior.id, f.env).unwedge?.successor).toBe(first.id);
  expect(readRun(first.id, f.env).unwedge?.predecessor).toBe(prior.id);
});

test("a claim surviving a crashed caller is not reopened by PID death or time", () => {
  const f = fixture(), prior = f.prior(), lost = f.begin("nudge", 130000);
  claimUnwedgePredecessor(lost.id, prior.id, f.observation, f.env, 130000);
  const later = f.begin("nudge", 900000);
  expect(() => claimUnwedgePredecessor(later.id, prior.id, f.observation, f.env, 900000)).toThrow("consumed");
});

test("only a recorded pre-effect refusal returns its own claim", () => {
  const f = fixture(), prior = f.prior(), refused = f.begin("nudge", 130000);
  claimUnwedgePredecessor(refused.id, prior.id, f.observation, f.env, 130000);
  finishUnwedgeAttempt(refused.id, "refused_pre_effect", "operator hold appeared", f.env, 130001);
  expect(readRun(prior.id, f.env).unwedge?.successor).toBeUndefined();
  const next = f.begin("nudge", 130002);
  expect(claimUnwedgePredecessor(next.id, prior.id, f.observation, f.env, 130002).action).toBe("nudge");
  f.dispatch(next.id, 130003);
  expect(() => finishUnwedgeAttempt(next.id, "refused_pre_effect", "cannot erase possible effect", f.env, 130004)).toThrow("possible effect");
  expect(readRun(prior.id, f.env).unwedge?.successor).toBe(next.id);
});

test("the durable intent says uncertain before the actuator can run and cannot be repeated", () => {
  const f = fixture(), run = f.begin("message");
  f.dispatch(run.id);
  expect(readRun(run.id, f.env).unwedge).toMatchObject({ outcome: "uncertain_effect", effect: "possible",
    stimulus: { id: "message-1" }, position: { offset: 100 } });
  expect(() => f.dispatch(run.id)).toThrow();
  f.complete(run.id);
  expect(readRun(run.id, f.env)).toMatchObject({ state: "released", unwedge: { outcome: "completed", nextEligibleAt: 122000 } });
  expect(() => f.dispatch(run.id)).toThrow();
});

test("pending, corrupt and legacy records cannot authorize a rung", () => {
  const f = fixture(), pending = f.begin("message"), next = f.begin("nudge", 130000);
  expect(() => claimUnwedgePredecessor(next.id, pending.id, f.observation, f.env, 130000)).toThrow();
  const prior = f.prior();
  const path = join(runDirectory(prior.id, f.env), "run.json");
  const bytes = JSON.parse(readFileSync(path, "utf8"));
  bytes.unwedge.outcome = "anything";
  writeFileSync(path, JSON.stringify(bytes));
  expect(() => claimUnwedgePredecessor(next.id, prior.id, f.observation, f.env, 130000)).toThrow();
  delete bytes.unwedge;
  writeFileSync(path, JSON.stringify(bytes));
  expect(() => claimUnwedgePredecessor(next.id, prior.id, f.observation, f.env, 130000)).toThrow();
});

test("refused admission neither consumes the predecessor nor grants a child effect", () => {
  const f = fixture(), prior = f.prior(), next = f.begin("nudge", 130000);
  expect(() => claimUnwedgePredecessor(next.id, prior.id, { ...f.observation, verdict: "thinking" }, f.env, 130000)).toThrow();
  expect(readRun(prior.id, f.env).unwedge?.successor).toBeUndefined();
  expect(() => f.dispatch(next.id, 130001)).toThrow("predecessor");
});

test("predecessor admission uses the same mutex as pane effects", () => {
  const f = fixture(), prior = f.prior(), next = f.begin("nudge", 130000);
  const lock = acquirePaneLock("%701", 1000, f.env)!;
  expect(lock).not.toBeNull();
  try {
    expect(() => claimUnwedgePredecessor(next.id, prior.id, f.observation, f.env, 130000)).toThrow("busy");
    expect(readRun(prior.id, f.env).unwedge?.successor).toBeUndefined();
  } finally { lock.release(); }
  expect(claimUnwedgePredecessor(next.id, prior.id, f.observation, f.env, 130000).action).toBe("nudge");
});

test("report-only policy produces a final refusal record for an acting request", () => {
  const f = fixture();
  const run = beginUnwedgeAttempt({ binding: f.binding, rung: "message", cause: "model_capacity", ownerPane: "%700", mode: "report-only" }, f.env, 1000);
  expect(run).toMatchObject({ state: "released", hold: false, unwedge: { rung: "message", outcome: "refused_pre_effect", effect: "none" } });
  expect(() => f.dispatch(run.id)).toThrow();
});
