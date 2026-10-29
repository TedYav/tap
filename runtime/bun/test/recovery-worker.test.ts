import { expect, test } from "bun:test";
import { runRecoveryWorker, type WorkerCycleIO } from "../src/recovery/worker";
import type { OwnedCrew } from "../src/recovery/crew";

const crew: OwnedCrew = { handle: "worker", paneId: "%7", windowId: "@7", session: "session", serverEpoch: "epoch", instance: "worker-i1", assignments: [] };
function fixture() {
  const calls: string[] = [];
  let jobs = 0;
  const io: WorkerCycleIO<string> = {
    launch: async () => { calls.push("launch"); return { crew }; },
    assign: async (_crew, brief) => { calls.push(brief.includes("Identity check only") ? "identity" : "mission"); return `job-${++jobs}`; },
    wait: async (_crew, id) => { calls.push(`wait:${id}`); return id === "job-1" ? "worker" : "claimed done"; },
    inspect: () => { calls.push("inspect"); return "observed composer"; },
    cleanup: async owned => { calls.push(owned ? "cleanup-owned" : "release-only"); return []; },
  };
  return { calls, io };
}
test("worker identity precedes its mission and its natural-language answer never substitutes for inspection", async () => {
  const f = fixture(), result = await runRecoveryWorker("fixed navigation mission", f.io);
  expect(result).toEqual({ value: "observed composer", gaps: [] });
  expect(f.calls).toEqual(["launch", "identity", "wait:job-1", "mission", "wait:job-2", "inspect", "cleanup-owned"]);
});
test("wrong identity cannot receive a mission and still releases custody with owned cleanup", async () => {
  const f = fixture(); f.io.wait = async () => "other-worker";
  const result = await runRecoveryWorker("fixed navigation mission", f.io);
  expect(result.error).toContain("identity");
  expect(f.calls).toEqual(["launch", "identity", "cleanup-owned"]);
});
test("partial launch and unknown launch failures preserve distinct cleanup authority", async () => {
  const partial = fixture(); partial.io.launch = async () => ({ crew, error: "assignment cannot start" });
  expect((await runRecoveryWorker("mission", partial.io)).error).toContain("assignment");
  expect(partial.calls).toEqual(["cleanup-owned"]);
  const unknown = fixture(); unknown.io.launch = async () => { throw new Error("launch identity unobservable"); };
  expect((await runRecoveryWorker("mission", unknown.io)).error).toContain("unobservable");
  expect(unknown.calls).toEqual(["release-only"]);
});
test("timeout, inspection failure and cleanup gaps cannot report successful restoration", async () => {
  const timeout = fixture(); timeout.io.wait = async () => { throw new Error("deadline"); };
  expect(await runRecoveryWorker("mission", timeout.io)).toMatchObject({ error: "deadline", gaps: [] });
  expect(timeout.calls.at(-1)).toBe("cleanup-owned");
  const inspect = fixture(); inspect.io.inspect = () => { throw new Error("composer not observable"); };
  expect((await runRecoveryWorker("mission", inspect.io)).error).toContain("not observable");
  const cleanup = fixture(); cleanup.io.cleanup = async () => ["worker identity changed"];
  expect((await runRecoveryWorker("mission", cleanup.io)).gaps).toEqual(["worker identity changed"]);
});
