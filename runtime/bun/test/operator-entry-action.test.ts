import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/bus";
import type { ResolvedContext } from "../src/context";
import { createRun, readRun, updateRun, type Liveness } from "../src/recovery/state";
import { executeOperate, operateOptions, type OperateIO } from "../src/verbs/operate";

const root = mkdtempSync(join(tmpdir(), "tap-operator-entry-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let serial = 0;
const menu = "╭────────────────────────────────────╮\n│ Settings\n│ ❯ Close\n│ ↑/↓ to navigate · Enter to select · Esc to cancel\n╰────────────────────────────────────╯\n";
function fixture() {
  const env = { ...process.env, TAP_INDEX_HOME: join(root, String(++serial)), TAP_LOCK_DIR: join(root, "locks") };
  const now = 2_000_000, facts: Liveness = { now, processAlive: () => true, paneAlive: () => true };
  const ctx = { team: "tap", root, registryPath: join(root, "registry"), bus: new Bus(root) } as ResolvedContext;
  const binding = { team: "tap", handle: "target", registry: ctx.registryPath, pane: "target:0.0", paneId: `%${5000 + serial}`,
    session: "target", instance: "target|abc", harness: "claude", processPid: "123", serverSocket: "/tmp/socket", serverEpoch: "epoch" };
  const caller = { handle: "owner", instance: "owner|abc", paneId: "%1", team: "tap" };
  const policy = { mode: "on" as const, afterMs: 1_200_000, source: "config" as const, digest: "sha256:" + "a".repeat(64) };
  const record = { v: 1 as const, binding, caller, authority: "on" as const, policyDigest: policy.digest,
    admittedAt: now, nativeActivity: 1000, mail: { id: "mail", home: root }, clients: [] };
  const run = createRun(binding, "cautious", [], caller.paneId, process.pid, env, facts, true, record);
  updateRun(run.id, current => { current.caller = { actor: caller.handle, team: ctx.team, root, registry: ctx.registryPath, home: root }; }, env);
  const state = { actor: { ...caller }, frame: menu, native: 1000, digest: policy.digest, auditFailure: false, changedAtRead: false };
  const effects: string[][] = [], audits: string[] = [];
  const io: OperateIO = {
    env, now: () => now, liveness: () => facts, caller: () => state.actor, policy: () => ({ ...policy, digest: state.digest }),
    preset: () => {}, workerCurrent: () => true, notify: async () => { throw new Error("not used"); }, worker: async () => { throw new Error("not used"); },
    read: () => ({ frame: state.changedAtRead ? menu.replace("Settings", "Preferences") : state.frame, nativeActivity: state.native,
      facts: { binding, callerPane: state.actor.paneId, captured: true, verdict: "parked-on-dialog", turnEnded: true, progress: false,
        screen: "menu", protection: "clear", recoveryOwned: false, scriptedCure: false, clients: [],
        mail: [{ ...record.mail, instance: binding.instance, firstSpooled: 1, disposition: "undelivered", valid: true }] } }),
    audit: (_r, action) => { if (state.auditFailure) throw new Error("audit unavailable"); audits.push(action); },
    effect: { capture: () => state.frame, authorize: () => null, settle: () => {},
      snapshot: () => ({ dead: "0", command: "claude", windowCount: "2", paneId: binding.paneId, instance: binding.instance, pid: binding.processPid }),
      effect: args => { effects.push(args); return { code: 0, stdout: "", stderr: "" }; } },
  };
  const reason = join(root, `reason-${serial}.txt`); writeFileSync(reason, "Close the observed settings menu.");
  const observe = () => executeOperate(ctx, operateOptions(["--run", run.id, "--observe"]), io);
  const key = (sample: string) => executeOperate(ctx, operateOptions(["--run", run.id, "--key", "Enter", "--sample", sample, "--reason-file", reason]), io);
  return { io, env, ctx, run, caller, state, effects, audits, observe, key };
}
test("the public action door permits its bound worker and records each observation/key on the bus", async () => {
  const f = fixture();
  updateRun(f.run.id, r => { r.worker = { handle: "worker", instance: "worker|abc", paneId: "%9", windowId: "@9", session: "s", serverEpoch: "e", assignments: [] }; }, f.env);
  f.state.actor = { ...f.caller, handle: "worker", instance: "worker|abc", paneId: "%9" };
  const sample = await f.observe(); expect((await f.key(String(sample.sample))).status).toBe("key-recorded");
  expect(f.effects).toHaveLength(1);
  expect(f.audits).toEqual(["operator_observation", "operator_key_intent", "operator_key_result"]);
});
test("a rebound initiating seat and another actor cannot use operator custody", async () => {
  for (const patch of [{ instance: "owner|new" }, { team: "other" }, { paneId: "%33" }, { handle: "other" }]) {
    const f = fixture(); Object.assign(f.state.actor, patch);
    await expect(f.observe()).rejects.toThrow("unchanged"); expect(f.effects).toHaveLength(0);
  }
});
test("late native/config/frame changes and audit failure send zero keys and stop the run", async () => {
  for (const patch of [{ native: 1001 }, { digest: "changed" }, { changedAtRead: true }, { auditFailure: true }]) {
    const f = fixture(), sample = await f.observe(); Object.assign(f.state, patch);
    try { expect(["held", "unverified"]).toContain((await f.key(String(sample.sample))).status); } catch (error) { expect(String(error)).toContain("audit"); }
    expect(f.effects).toHaveLength(0); expect(readRun(f.run.id, f.env).state).toBe("stopped");
  }
});
test("actor identity is rechecked at the key boundary after earlier reads", async () => {
  const f = fixture(), sample = await f.observe(); let calls = 0;
  f.io.caller = () => ({ ...f.caller, instance: ++calls > 1 ? "owner|new" : f.caller.instance });
  expect((await f.key(String(sample.sample))).status).toBe("held"); expect(f.effects).toHaveLength(0);
});
test("loss of a bound worker revokes initiator keys even while the owner is alive", async () => {
  const f = fixture(), sample = await f.observe();
  updateRun(f.run.id, r => { r.worker = { handle: "worker", instance: "worker|abc", paneId: "%9", windowId: "@9", session: "s", serverEpoch: "e", assignments: [] }; }, f.env);
  f.io.workerCurrent = () => false;
  expect((await f.key(String(sample.sample))).status).toBe("held"); expect(f.effects).toHaveLength(0);
});
test("a post-key bus audit failure reports possible effect and revokes further keys", async () => {
  const f = fixture(), sample = await f.observe();
  f.io.audit = (_run, action) => { if (action === "operator_key_result") throw new Error("bus became unavailable"); };
  const result = await f.key(String(sample.sample));
  expect(result.status).toBe("unverified"); expect(result.summary).toContain("possible");
  expect(f.effects).toHaveLength(1); expect(readRun(f.run.id, f.env).state).toBe("stopped");
});
