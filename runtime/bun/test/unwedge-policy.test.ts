import { expect, test } from "bun:test";
import { admitUnwedge, parseUnwedgeArgs, type UnwedgeObservation, type UnwedgeAttempt, type UnwedgeRung } from "../src/recovery/unwedge-policy";
import type { RecoveryRun } from "../src/recovery/state";

const binding = { team: "tap", handle: "peer", registry: "/test/registry.json", pane: "tap/peer:0.0", paneId: "%701",
  session: "tap/peer", instance: "instance-1", harness: "codex", processPid: "123", serverSocket: "/test/socket",
  serverEpoch: "epoch-1", nativeSessionId: "session-1" };
const now = 200_000;
function observation(patch: Partial<UnwedgeObservation> = {}): UnwedgeObservation {
  return { binding, verdict: "severed", cause: "model_capacity", turnEnded: true, protection: "clear",
    composer: "empty", progress: "unchanged", ...patch };
}
function previous(rung: UnwedgeRung = "message", patch: Partial<UnwedgeAttempt> = {}): RecoveryRun {
  return { v: 1, id: "recovery-00000000-0000-0000-0000-000000000001", mode: "aggressive", hold: false,
    target: binding, ownerPane: "%700", ownerPid: 101, started: 1000, deadline: 301000, effects: 0, payloads: [], state: "released",
    unwedge: { v: 1, rung, binding, cause: "model_capacity", outcome: "completed", effect: "possible",
      completedAt: 2000, nextEligibleAt: 122000, stimulus: { id: "message-1", hash: "a".repeat(64) }, ...patch } };
}
const request = (rung: UnwedgeRung, after?: string) => ({ handle: "peer", rung, json: false, ...(after && { after }) });

test("bare unwedge is a report; actions require one named rung and successors require an exact record", () => {
  expect(parseUnwedgeArgs(["peer"])).toEqual({ handle: "peer", rung: "report", json: false });
  expect(parseUnwedgeArgs(["--json", "peer", "--rung", "message"])).toEqual({ handle: "peer", rung: "message", json: true });
  expect(parseUnwedgeArgs(["peer", "--rung", "continue", "--after", previous().id]).after).toBe(previous().id);
  for (const argv of [[], ["team/peer"], ["peer", "extra"], ["peer", "--force"], ["peer", "--rung", "2"],
    ["peer", "--rung", "nudge"], ["peer", "--after", previous().id], ["peer", "--rung", "message", "--after", previous().id],
    ["peer", "--rung", "nudge", "--after", "../../run"], ["peer", "--rung", "message", "--rung", "restart"]]) {
    expect(() => parseUnwedgeArgs(argv)).toThrow();
  }
});

test("report never grants an actuator, even on a supported stopped cause", () => {
  expect(admitUnwedge(request("report"), observation(), undefined, now)).toEqual({ action: "report" });
  expect(admitUnwedge(request("message"), observation(), undefined, now)).toEqual({ action: "message" });
});

test("only a supported positive stopped diagnosis permits ordinary recovery", () => {
  for (const verdict of ["healthy", "thinking", "busy-unproven", "unverified-but-processing", "gone", "unknown", "parked-on-dialog", null] as const) {
    expect(admitUnwedge(request("message"), observation({ verdict }), undefined, now).action).toBe("refuse");
  }
  for (const patch of [{ turnEnded: false }, { turnEnded: null }, { cause: "usage_limit" }, { cause: "api_error" },
    { protection: "held" }, { protection: "unknown" }, { composer: "draft" }, { composer: "queued" }, { composer: "unreadable" }] as const) {
    expect(admitUnwedge(request("message"), observation(patch), undefined, now).action).toBe("refuse");
  }
  expect(admitUnwedge(request("message"), observation({ binding: { ...binding, harness: "claude" }, cause: "api_error" }), undefined, now).action).toBe("message");
});

test("a successor needs the immediately preceding completed rung and exact incident binding", () => {
  for (const [next, prior] of [["nudge", "message"], ["continue", "nudge"], ["restart", "continue"]] as const) {
    const record = previous(prior);
    expect(admitUnwedge(request(next, record.id), observation(), record, now).action).toBe(next);
  }
  const p = previous();
  expect(admitUnwedge(request("continue", p.id), observation(), p, now).action).toBe("refuse");
  expect(admitUnwedge(request("nudge", p.id), observation(), undefined, now).action).toBe("refuse");
  expect(admitUnwedge(request("nudge", p.id), observation(), { ...p, unwedge: undefined }, now).action).toBe("refuse");
  for (const field of Object.keys(binding)) {
    const changed = { ...binding, [field]: "changed" };
    expect(admitUnwedge(request("nudge", p.id), observation({ binding: changed }), p, now).action).toBe("refuse");
  }
  for (const patch of [{ outcome: "refused_pre_effect" }, { outcome: "uncertain_effect" }, { outcome: null }, { successor: "another-run" }] as const) {
    expect(admitUnwedge(request("nudge", p.id), observation(), previous("message", patch), now).action).toBe("refuse");
  }
});

test("observation floor returns a time, and productive or unknown progress ends admission", () => {
  const p = previous();
  expect(admitUnwedge(request("nudge", p.id), observation(), p, 121999)).toMatchObject({ action: "refuse", nextEligibleAt: 122000 });
  expect(admitUnwedge(request("nudge", p.id), observation({ progress: "own-stimulus-stopped" }), p, now).action).toBe("nudge");
  for (const progress of ["productive", "unknown"] as const) {
    expect(admitUnwedge(request("nudge", p.id), observation({ progress }), p, now).action).toBe("refuse");
  }
  const continued = previous("continue");
  expect(admitUnwedge(request("restart", continued.id), observation({ progress: "own-stimulus-stopped" }), continued, now).action).toBe("restart");
});

test("only the exact staged predecessor message can complete an unverified delivery without waiting", () => {
  const p = previous("message", { outcome: "uncertain_effect" });
  const staged = observation({ verdict: "healthy", cause: "prompt_idle", composer: "staged", stagedPayloadId: "message-1" });
  expect(admitUnwedge(request("nudge", p.id), staged, p, 2001)).toEqual({ action: "submit-staged" });
  for (const patch of [{ stagedPayloadId: "other" }, { verdict: "thinking" }, { composer: "draft" }, { turnEnded: false },
    { protection: "held" }, { progress: "unknown" }] as const) {
    expect(admitUnwedge(request("nudge", p.id), { ...staged, ...patch }, p, now).action).toBe("refuse");
  }
  const uncertainNudge = previous("nudge", { outcome: "uncertain_effect" });
  expect(admitUnwedge(request("continue", uncertainNudge.id), staged, uncertainNudge, now).action).toBe("refuse");
});

test("malformed history and clock rollback never admit a successor", () => {
  const p = previous();
  for (const patch of [{ completedAt: NaN }, { nextEligibleAt: 0 }, { v: 2 }, { effect: "none" }, { stimulus: undefined }] as const) {
    const bad = { ...p, unwedge: { ...p.unwedge, ...patch } } as unknown as RecoveryRun;
    expect(admitUnwedge(request("nudge", p.id), observation(), bad, now).action).toBe("refuse");
  }
  expect(admitUnwedge(request("nudge", p.id), observation(), p, 500).action).toBe("refuse");
});

test("partial or holding legacy targets cannot masquerade as a complete prior attempt", () => {
  const p = previous();
  expect(admitUnwedge(request("nudge", p.id), observation(), { ...p, target: { paneId: "%701" } } as RecoveryRun, now).action).toBe("refuse");
  expect(admitUnwedge(request("nudge", p.id), observation(), { ...p, hold: true }, now).action).toBe("refuse");
});
