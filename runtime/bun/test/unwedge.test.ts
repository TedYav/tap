import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unwedgeProgress } from "../src/recovery/unwedge-progress";
import { executeUnwedge, type UnwedgeDeps } from "../src/verbs/unwedge";
import { readRun, createRun, updateRun, releaseRun } from "../src/recovery/state";
import type { SeatCheck } from "../src/verbs/doctor-seat";
import type { UnwedgeReading } from "../src/recovery/unwedge-observe";
import type { ResolvedContext } from "../src/context";
const binding = { team: "test", handle: "peer", registry: "/registry", pane: "seat:0.0", paneId: "%8", session: "seat", instance: "i", harness: "codex", processPid: "888", serverSocket: "/socket", serverEpoch: "epoch", nativeSessionId: "native" };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "unwedge-command-"));
  const env = { ...process.env, TAP_INDEX_HOME: root };
  const report: SeatCheck = { code: 2, report: { ok: false, scope: "seat", handle: "peer", verdict: "severed", evidence: [], not_checked: [], sampled_at: new Date().toISOString(), action: "tap peek peer" }, snapshot: { binding, seat: {}, root, busHome: root } };
  const bytes = Buffer.from('{"type":"event_msg","payload":{"type":"turn_aborted"}}\n');
  const reading: UnwedgeReading = { observation: { binding, verdict: "severed", cause: "model_capacity", turnEnded: true, protection: "clear", composer: "empty", progress: "unchanged" }, transcript: { path: "/transcript", fileId: "1:1", size: bytes.length, start: 0, bytes, lines: bytes.toString().trim().split("\n"), mtime: 1 } };
  const effects: string[] = [];
  const deps: UnwedgeDeps = {
    env, now: () => Date.now(), context: () => ({ team: "test", registryPath: "/registry", root, bus: { home: root } }) as ResolvedContext,
    actor: () => "actor", diagnose: () => report, observe: () => structuredClone(reading), mode: () => "aggressive",
    event: () => true,
    send: (args, _scripts, _families, options) => {
      options?.reauthorize?.({} as never);
      expect(readFileSync(args[args.indexOf("-f") + 1]!, "utf8")).toContain("selected model was at capacity");
      expect(options?.recipientInstance).toBe("i"); effects.push("message"); return { rc: 0, disposition: "queued-spool" };
    },
    nudge: (_args, _scripts, _families, _instance, boundary) => {
      expect(boundary?.check(false)).toBe("");
      const run = createRun(binding, "aggressive", [], "", process.pid, env, undefined, false);
      boundary?.onRun?.(run.id);
      updateRun(run.id, r => { r.effects = 1; }, env); releaseRun(run.id, "verified", env);
      effects.push("nudge"); return 0;
    },
    restart: () => { effects.push("restart"); return { code: 5, detail: "resume verification pending" }; },
  };
  return { deps, effects, reading, report, env };
}
const request = (rung: "report" | "message" | "nudge" | "continue" | "restart", after?: string) => ({ handle: "peer", rung, json: false, ...(after && { after }) });

test("default report writes a nonholding audit and performs no action", async () => {
  const f = fixture(); const result = await executeUnwedge(request("report"), "scripts", new Set(["codex"]), f.deps);
  expect(result.code).toBe(2); expect(f.effects).toEqual([]);
  const run = readRun(result.recovery_id!, f.env); expect(run.hold).toBe(false); expect(run.unwedge?.rung).toBe("report");
});
test("ordinary message records publication without claiming recipient recovery", async () => {
  const f = fixture(), result = await executeUnwedge(request("message"), "scripts", new Set(["codex"]), f.deps);
  expect(result.code).toBe(0); expect(f.effects).toEqual(["message"]); expect(result.detail).toContain("processing unverified");
  const run = readRun(result.recovery_id!, f.env); expect(run.unwedge?.outcome).toBe("completed");
  expect(run.unwedge?.stimulus?.id).toBeTruthy(); expect(run.hold).toBe(false); expect(run.state).toBe("released");
});
test("working, protected and unknown observations refuse before effects with an audit", async () => {
  for (const change of [{ verdict: "thinking" }, { protection: "held" }, { turnEnded: false }, { composer: "draft" }]) {
    const f = fixture(); Object.assign(f.reading.observation, change);
    const result = await executeUnwedge(request("message"), "scripts", new Set(["codex"]), f.deps);
    expect(result.code).toBe(1); expect(f.effects).toEqual([]); expect(readRun(result.recovery_id!, f.env).unwedge?.outcome).toBe("refused_pre_effect");
  }
});
test("successor observes the floor, claims once and links its actuator", async () => {
  const f = fixture(), first = await executeUnwedge(request("message"), "scripts", new Set(["codex"]), f.deps);
  expect((await executeUnwedge(request("nudge", first.recovery_id), "scripts", new Set(["codex"]), f.deps)).code).toBe(1);
  f.deps.now = () => Date.now() + 121000;
  const next = await executeUnwedge(request("nudge", first.recovery_id), "scripts", new Set(["codex"]), f.deps);
  expect(next.code).toBe(0); expect(f.effects).toEqual(["message", "nudge"]);
  expect(readRun(next.recovery_id!, f.env).unwedge?.actuator).toBeTruthy();
  expect((await executeUnwedge(request("nudge", first.recovery_id), "scripts", new Set(["codex"]), f.deps)).code).toBe(1);
});
test("changed evidence at send publication stops the actuator and retains uncertainty", async () => {
  const f = fixture(); let reads = 0;
  f.deps.observe = () => { const r = structuredClone(f.reading); if (++reads >= 3) r.observation.protection = "held"; return r; };
  const result = await executeUnwedge(request("message"), "scripts", new Set(["codex"]), f.deps);
  expect(f.effects).toEqual([]); expect(result.code).toBe(5); expect(result.outcome).toBe("uncertain_effect");
});
test("audit failure cannot dispatch an effect", async () => {
  const f = fixture(); f.deps.env = { ...f.env, TAP_INDEX_HOME: "/dev/null/no-audit" };
  const result = await executeUnwedge(request("message"), "scripts", new Set(["codex"]), f.deps);
  expect(result.code).toBe(1); expect(f.effects).toEqual([]); expect(result.recovery_id).toBeUndefined();
});

test("an uncertain message may complete only its exact staged sentinel without waiting", async () => {
  const f = fixture(); f.deps.send = () => ({ rc: 5, disposition: "unverified" });
  const first = await executeUnwedge(request("message"), "scripts", new Set(["codex"]), f.deps);
  const id = readRun(first.recovery_id!, f.env).unwedge!.stimulus!.id!;
  f.reading.observation.composer = "staged"; f.reading.observation.stagedPayloadId = id; f.reading.observation.verdict = "healthy"; f.reading.observation.cause = "prompt_idle";
  const nudge = f.deps.nudge;
  f.deps.nudge = (args, scripts, families, instance, boundary) => {
    expect(args).toEqual(["peer", "--no-interrupt"]); expect(boundary?.stagedId).toBe(id);
    return nudge(args, scripts, families, instance, boundary);
  };
  const next = await executeUnwedge(request("nudge", first.recovery_id), "scripts", new Set(["codex"]), f.deps);
  expect(next.code).toBe(0); expect(f.effects).toEqual(["nudge"]);
  expect(readRun(next.recovery_id!, f.env).unwedge).toMatchObject({ cause: "model_capacity", stimulus: { id } });
});

test("uncertain control, no-effect success and productive activity never authorize climbing", async () => {
  for (const mode of ["uncertain", "noop", "productive"] as const) {
    const f = fixture(); const first = await executeUnwedge(request("message"), "scripts", new Set(["codex"]), f.deps);
    f.deps.now = () => Date.now() + 121000;
    if (mode === "productive") f.reading.observation.progress = "productive";
    else f.deps.nudge = () => mode === "uncertain" ? 5 : 0;
    const next = await executeUnwedge(request("nudge", first.recovery_id), "scripts", new Set(["codex"]), f.deps);
    expect(next.code).not.toBe(0);
    f.deps.now = () => Date.now() + 242000;
    expect((await executeUnwedge(request("continue", next.recovery_id), "scripts", new Set(["codex"]), f.deps)).code).toBe(1);
  }
});

test("Continue uses the same nudge actuator with one cause-naming message and an interrupt", async () => {
  const f = fixture(); const first = await executeUnwedge(request("message"), "scripts", new Set(["codex"]), f.deps);
  f.deps.now = () => Date.now() + 121000;
  const next = await executeUnwedge(request("nudge", first.recovery_id), "scripts", new Set(["codex"]), f.deps);
  f.deps.now = () => Date.now() + 242000;
  const nudge = f.deps.nudge;
  f.deps.nudge = (args, scripts, families, instance, boundary) => {
    expect(args).toEqual(["peer", "--message", "Your last turn stopped because the selected model was at capacity. Continue your existing task."]);
    return nudge(args, scripts, families, instance, boundary);
  };
  expect((await executeUnwedge(request("continue", next.recovery_id), "scripts", new Set(["codex"]), f.deps)).code).toBe(0);
});

test("restart preflight refusal returns its claim; a failure after the stop boundary retains uncertainty", async () => {
  for (const possible of [false, true]) {
    const f = fixture();
    let prior = await executeUnwedge(request("message"), "scripts", new Set(["codex"]), f.deps);
    f.deps.now = () => Date.now() + 121000;
    prior = await executeUnwedge(request("nudge", prior.recovery_id), "scripts", new Set(["codex"]), f.deps);
    f.deps.now = () => Date.now() + 242000;
    prior = await executeUnwedge(request("continue", prior.recovery_id), "scripts", new Set(["codex"]), f.deps);
    f.deps.now = () => Date.now() + 363000;
    f.deps.restart = (_snapshot, _guard, _run, beforeEffect) => {
      if (possible) beforeEffect();
      throw new Error(possible ? "resume failed after stop" : "artifact unavailable");
    };
    const result = await executeUnwedge(request("restart", prior.recovery_id), "scripts", new Set(["codex"]), f.deps);
    expect(result.code).toBe(possible ? 5 : 1);
    expect(result.outcome).toBe(possible ? "uncertain_effect" : "refused_pre_effect");
    expect(!!readRun(prior.recovery_id!, f.env).unwedge!.successor).toBe(possible);
  }
});

test("message without a registered sender refuses before recording possible effects", async () => {
  const f = fixture(); f.deps.actor = () => "user";
  const result = await executeUnwedge(request("message"), "scripts", new Set(["codex"]), f.deps);
  expect(result.code).toBe(1); expect(result.effect).toBe("none"); expect(f.effects).toEqual([]);
  expect(result.detail).toContain("registered sending seat");
});


test("productive work between admission and pre-effect sampling cannot be absorbed into a new baseline", async () => {
  const f = fixture();
  const first = await executeUnwedge(request("message"), "scripts", new Set(["codex"]), f.deps);
  f.deps.now = () => Date.now() + 121000;
  let reads = 0;
  const original = f.reading.transcript!;
  const suffix = Buffer.from([
    { type: "event_msg", payload: { type: "agent_message", message: "Useful work arrived." } },
    { type: "event_msg", payload: { type: "task_complete", error: { codex_error_info: "server_overloaded" } } },
  ].map(r => JSON.stringify(r)).join("\n") + "\n");
  const bytes = Buffer.concat([original.bytes, suffix]);
  const changed = { ...original, bytes, size: bytes.length, lines: bytes.toString().trim().split("\n") };
  f.deps.observe = (_snapshot, prior) => {
    const sample = ++reads === 1 ? original : changed;
    return { observation: { ...f.reading.observation, progress: prior ? unwedgeProgress(prior, sample, "model_capacity") : "unchanged" }, transcript: sample };
  };
  const result = await executeUnwedge(request("nudge", first.recovery_id), "scripts", new Set(["codex"]), f.deps);
  expect(result.code).toBe(1); expect(result.effect).toBe("none"); expect(f.effects).toEqual(["message"]);
  expect(readRun(first.recovery_id!, f.env).unwedge!.successor).toBeUndefined();
});
