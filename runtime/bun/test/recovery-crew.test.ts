import { expect, test } from "bun:test";
import { cleanupIO, cleanupRecoveryCrew, prepareWorkerWorkspace, type CleanupIO, type OwnedCrew } from "../src/recovery/crew";
import { createRun, recoveryRoot, runDirectory, type RecoveryRun } from "../src/recovery/state";
import { resolveContext } from "../src/context";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { teamFixture, flushScratch } from "./support/send-reply-flip-fixture";
const crew: OwnedCrew = { handle: "worker", paneId: "%72", windowId: "@72", session: "operator",
  serverEpoch: "srv:1:2", instance: "worker-instance", assignments: ["identity-job", "repair-job"] };
function fixture() {
  const calls: string[] = []; let stopped = false;
  const io: CleanupIO = {
    release: () => { calls.push("release"); }, matches: () => true, panes: () => [crew.paneId],
    stop: () => { calls.push("stop-exact-worker"); stopped = true; },
    markGone: () => { expect(stopped).toBe(true); calls.push("mark-worker-gone"); },
    settled: id => id === "identity-job",
    cancel: async id => { expect(stopped).toBe(true); calls.push(`cancel:${id}`); },
    remove: async () => { calls.push("remove"); },
  };
  return { calls, io };
}
test("malformed live identity grants no crew cancellation or suspension authority", () => {
  const fx = teamFixture({ seats: { ub: { status: "active", crew: true, pane: "ub:0.0", pane_id: "%7",
    session: "ub", harness: "claude", instance: "ub|A", server_epoch: "srv:123:456" } } });
  const original = { ...process.env };
  try {
    Object.assign(process.env, fx.env);
    const tmux = join(fx.root, "bin", "tmux");
    writeFileSync(tmux, readFileSync(tmux, "utf8").replace("#!/bin/sh\n", `#!/bin/sh
case "$*" in *'#{pane_id}'*'#{pane_pid}'*) printf '%%7\\tub\\t123:456\\n'; exit 0 ;; esac
`));
    const ctx = resolveContext(fx.wt);
    const before = readFileSync(ctx.registryPath, "utf8");
    const owned = { ...crew, handle: "ub", paneId: "%7", session: "ub", instance: "ub|A", serverEpoch: "srv:123:456" };
    const io = cleanupIO({ id: "unobservable-worker" } as RecoveryRun, owned, ctx, "ua");
    expect(() => io.matches()).toThrow("cannot prove worker identity");
    expect(() => io.markGone()).toThrow("no cancellation authority");
    expect(readFileSync(ctx.registryPath, "utf8")).toBe(before);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    flushScratch();
  }
});
test("worker scratch is bootstrapped in place while recovery evidence stays in the debug index", () => {
  const fx = teamFixture({});
  const original = { ...process.env };
  try {
    Object.assign(process.env, fx.env);
    const ctx = resolveContext(fx.wt);
    const run = createRun(
      { team: ctx.team, handle: "driver", registry: ctx.registryPath,
        pane: "%9", paneId: "%9", session: "crew/driver", instance: "driver|fixture", harness: "daemon" },
      "report-only", [], "", process.pid);
    const scratch = prepareWorkerWorkspace(ctx, run);
    const evidence = runDirectory(run.id);
    expect(scratch).toBe(join(ctx.root, "tmp", "tap-recovery", run.id));
    const bootstrap = readFileSync(join(scratch, "AGENTS.md"), "utf8");
    expect(bootstrap).toContain("tool-owned recovery workspace");
    expect(readFileSync(join(evidence, "worker-bootstrap.md"), "utf8")).toBe(bootstrap);
    expect(JSON.parse(readFileSync(join(evidence, "run.json"), "utf8")).id).toBe(run.id);
    expect(evidence.startsWith(recoveryRoot())).toBe(true);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    flushScratch();
  }
});
test("unanswered canonical worker assignment is cancelled truthfully after exact worker stop, then reaped", async () => {
  const f = fixture(); expect(await cleanupRecoveryCrew(crew, f.io)).toEqual([]);
  expect(f.calls).toEqual(["release", "stop-exact-worker", "mark-worker-gone", "cancel:repair-job", "remove"]);
});
test("completed worker uses ordinary crew removal; no synthetic cancellation", async () => {
  const f = fixture(); f.io.settled = () => true;
  expect(await cleanupRecoveryCrew(crew, f.io)).toEqual([]);
  expect(f.calls).toEqual(["release", "remove"]);
});
test("extra pane in the worker window prevents a collateral stop but releases the recovery hold", async () => {
  const f = fixture(); f.io.panes = () => [crew.paneId, "%target"];
  expect((await cleanupRecoveryCrew(crew, f.io))[0]).toContain("another pane");
  expect(f.calls).toEqual(["release"]);
});
test("changed worker identity and cancellation failures cannot retain a recovery hold", async () => {
  const changed = fixture(); changed.io.matches = () => false;
  expect((await cleanupRecoveryCrew(crew, changed.io))[0]).toContain("identity changed");
  expect(changed.calls).toEqual(["release"]);
  const failed = fixture(); failed.io.cancel = async () => { throw new Error("cancel refused"); };
  expect((await cleanupRecoveryCrew(crew, failed.io))[0]).toContain("cancel refused");
  expect(failed.calls[0]).toBe("release"); expect(failed.calls).not.toContain("remove");
});
