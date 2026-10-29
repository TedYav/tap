import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeOperate, operateOptions, type OperateIO } from "../src/verbs/operate";
import { harnessEvidence } from "../src/readiness-stall";
import { Bus } from "../src/bus";
import type { ResolvedContext } from "../src/context";
import { readRun, recoveryHold, releaseRun, type Liveness } from "../src/recovery/state";

const root = mkdtempSync(join(tmpdir(), "tap-operator-lifecycle-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let serial = 0;
function fixture(mode: "off" | "ask" | "on" = "on") {
  const env = { ...process.env, TAP_INDEX_HOME: join(root, String(++serial)), TAP_LOCK_DIR: join(root, "locks") };
  const now = 2_000_000, facts: Liveness = { now, processAlive: () => true, paneAlive: () => true };
  const ctx = { team: "tap", root, registryPath: join(root, "registry.json"), bus: new Bus(root) } as ResolvedContext;
  const binding = { team: "tap", handle: "target", registry: ctx.registryPath, pane: "target:0.0", paneId: `%${3000 + serial}`,
    session: "target", instance: "target|abc", harness: "claude", processPid: "123", serverSocket: "/tmp/socket", serverEpoch: "epoch" };
  const caller = { handle: "owner", instance: "owner|abc", paneId: "%1", team: "tap" };
  const policy = { mode, afterMs: 1_200_000, source: "config" as const, digest: "sha256:" + "a".repeat(64) };
  const state = { launches: 0, notifications: 0, reads: 0, driftAt: Infinity, workerError: "", auditFailure: false };
  const audit: string[] = [];
  const io: OperateIO = {
    env, now: () => now, liveness: () => facts, caller: () => ({ ...caller }), policy: () => ({ ...policy }),
    preset: () => {}, workerCurrent: () => true,
    read: (_target, _ownRun) => {
      state.reads++;
      return { nativeActivity: state.reads >= state.driftAt ? 1001 : 1000, frame: "fixture menu",
        facts: { binding, callerPane: caller.paneId, captured: true, verdict: "parked-on-dialog", turnEnded: true, progress: false,
          screen: "menu", protection: "clear", scriptedCure: false, recoveryOwned: false, clients: [],
          mail: [{ home: root, id: "mail", instance: binding.instance, firstSpooled: 1, disposition: "undelivered", valid: true }] } };
    },
    notify: async request => { state.notifications++; return { code: 0, stderr: "", stdout: JSON.stringify({ ok: true, notified: true, delivery: "accepted", human_received: null,
      label: `Approve ${request.id}`, from: caller.handle, team: caller.team }) }; },
    worker: async (run, _preset, _brief, inspect, boundary) => {
      expect(recoveryHold(binding.paneId, env, facts)).toBe(true);
      const refusal = boundary();
      if (refusal) { releaseRun(run.id, undefined, env); return { error: refusal, gaps: [] }; }
      state.launches++;
      if (state.workerError) { releaseRun(run.id, undefined, env); return { error: state.workerError, gaps: [] }; }
      const original = io.read;
      io.read = (...args) => { const r = original(...args); return { ...r, facts: { ...r.facts, screen: "composer", verdict: "healthy" } }; };
      const value = inspect(readRun(run.id, env));
      releaseRun(run.id, undefined, env);
      return { value, gaps: [] };
    },
    audit: (_run, action) => { if (state.auditFailure) throw new Error("audit unavailable"); audit.push(action); },
  };
  const start = () => executeOperate(ctx, operateOptions(["target", "--preset", "astra"]), io);
  return { env, ctx, binding, caller, policy, state, io, start, audit, facts };
}
test("off and awaiting human approval launch no crew and hold no pane", async () => {
  const off = fixture("off"); await expect(off.start()).rejects.toThrow("off");
  expect(off.state.launches).toBe(0);
  const ask = fixture("ask"), result = await ask.start();
  expect(result.status).toBe("approval-required");
  expect(ask.state.notifications).toBe(1); expect(ask.state.launches).toBe(0);
  expect(recoveryHold(ask.binding.paneId, ask.env, ask.facts)).toBe(false);
});
test("explicit request-bound human attestation launches once; a repeat refuses", async () => {
  const f = fixture("ask"), request = await f.start(), note = join(root, `reply-${serial}.json`);
  writeFileSync(note, JSON.stringify({ request_id: request.request_id, reply: "Yes, navigate that target now." }));
  const options = operateOptions(["--approve", String(request.request_id), "--reply-file", note]);
  const result = await executeOperate(f.ctx, options, f.io);
  expect(result.status).toBe("composer-restored"); expect(f.state.launches).toBe(1);
  await expect(executeOperate(f.ctx, options, f.io)).rejects.toThrow("consumed");
});
test("native activity changing under custody blocks launch and releases the hold", async () => {
  const f = fixture(); f.state.driftAt = 2;
  const result = await f.start();
  expect(result.status).toBe("held"); expect(f.state.launches).toBe(0);
  expect(recoveryHold(f.binding.paneId, f.env, f.facts)).toBe(false);
});
test("on mode retains the independent UI result and releases ownership", async () => {
  const f = fixture(), result = await f.start();
  expect(result.status).toBe("composer-restored"); expect(f.state.launches).toBe(1);
  expect(recoveryHold(f.binding.paneId, f.env, f.facts)).toBe(false);
  expect(readFileSync(String(result.status_file), "utf8")).toContain("processing unconfirmed");
  expect(f.audit).toContain("operator_start"); expect(f.audit).toContain("operator_finish");
});
test("worker failure cannot become UI success and retains cleanup evidence", async () => {
  const f = fixture(); f.state.workerError = "worker identity mismatch";
  const result = await f.start();
  expect(result.status).toBe("unverified"); expect(result.summary).toContain("identity mismatch");
  expect(recoveryHold(f.binding.paneId, f.env, f.facts)).toBe(false);
});
test("a missing audit trail prevents crew launch", async () => {
  const f = fixture(); f.state.auditFailure = true;
  const result = await f.start();
  expect(result.status).not.toBe("composer-restored"); expect(f.state.launches).toBe(0);
  expect(recoveryHold(f.binding.paneId, f.env, f.facts)).toBe(false);
});
test("public grammar requires an explicit preset and a single complete action", () => {
  for (const args of [["target"], ["target", "--preset", "astra", "--key", "Escape"], ["--approve", "id"],
    ["--run", "id", "--key", "Escape", "--reason-file", "x"], ["--run", "id", "--observe", "--stop"],
    ["--run", "id", "--key", "Escape", "--sample", "s", "--reason-file", "r", "--key", "Enter"]]) {
    expect(() => operateOptions(args)).toThrow();
  }
  expect(operateOptions(["--run", "id", "--observe"]).observe).toBe(true);
});

test("Claude local-command dismissal advances native activity without invalidating final composer evidence", async () => {
  const f = fixture(), path = join(root, `native-${serial}.jsonl`);
  const rows = readFileSync(join(import.meta.dir, "fixtures/operator-native/claude-model-cancel.jsonl"), "utf8").trim().split("\n");
  writeFileSync(path, rows[0]! + "\n"); utimesSync(path, 1000, 1000);
  const seat = { transcript_path: path, harness_session_id: "00000000-0000-4000-8000-000000000001" };
  const originalRead = f.io.read;
  f.io.read = (...args) => {
    const seen = originalRead(...args), native = harnessEvidence("claude", seat, f.env, true)!;
    expect(native.ended).toBe(true);
    return { ...seen, nativeActivity: native.lastActivity, facts: { ...seen.facts, turnEnded: native.ended } };
  };
  const worker = f.io.worker;
  f.io.worker = (run, preset, brief, inspect, gate) => worker(run, preset, brief, latest => {
    appendFileSync(path, rows.slice(1).join("\n") + "\n"); utimesSync(path, 1001, 1001);
    expect(harnessEvidence("claude", seat, f.env, true)).toMatchObject({ ended: true, lastActivity: 1001 });
    return inspect(latest);
  }, gate);
  const result = await f.start();
  expect(result.status).toBe("composer-restored"); expect(f.state.launches).toBe(1);
  expect(recoveryHold(f.binding.paneId, f.env, f.facts)).toBe(false);
});

test("completion still refuses active work, protection, changed identity, clients and config", async () => {
  for (const change of ["turn", "progress", "protection", "identity", "clients", "config"]) {
    const f = fixture(), worker = f.io.worker;
    f.io.worker = (run, preset, brief, inspect, gate) => worker(run, preset, brief, latest => {
      const original = f.io.read;
      f.io.read = (...args) => {
        const seen = original(...args), facts = { ...seen.facts };
        if (change === "turn") facts.turnEnded = false;
        if (change === "progress") facts.progress = true;
        if (change === "protection") facts.protection = "held";
        if (change === "identity") facts.binding = { ...facts.binding, instance: "new-instance" };
        if (change === "clients") facts.clients = [{ id: "new", session: "target", activity: 1, created: 1 }];
        if (change === "config") f.policy.digest = "sha256:" + "b".repeat(64);
        return { ...seen, facts };
      };
      return inspect(latest);
    }, gate);
    expect((await f.start()).status, change).toBe("held");
  }
});
