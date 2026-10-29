import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRun, readRun, recoveryHold, type Liveness } from "../src/recovery/state";
import { recoveryEffect, type EffectIO } from "../src/recovery/effect";
import { operatorStep, sampleOperator } from "../src/recovery/operator-action";
import { recoveryCli } from "../src/recovery/cli";

const root = mkdtempSync(join(tmpdir(), "tap-operator-action-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const menu = "╭────────────────────────────────────╮\n│ Settings\n│ ❯ Close\n│ ↑/↓ to navigate · Enter to select · Esc to cancel\n╰────────────────────────────────────╯\n";
const composer = "────────────────────────────────────\n❯ \n────────────────────────────────────\n ? for shortcuts\n";
function fixture(operator = true) {
  const env = { ...process.env, TAP_INDEX_HOME: join(root, String(n++)), TAP_LOCK_DIR: join(root, "locks") };
  const binding = { team: "tap", handle: "target", registry: "/tmp/registry", pane: "target:0.0", paneId: `%${2000 + n}`,
    session: "target", instance: "instance", harness: "claude", processPid: "123", serverSocket: "/tmp/socket", serverEpoch: "epoch" };
  const facts: Liveness = { now: 1000, processAlive: () => true, paneAlive: () => true };
  const record = { v: 1 as const, binding, policyDigest: "sha256:" + "a".repeat(64), authority: "on" as const,
    admittedAt: 1000, mail: { home: "/tmp/bus", id: "mail" }, nativeActivity: 1, clients: [] };
  const run = createRun(binding, "cautious", [], "%1", process.pid, env, facts, true, operator ? record : undefined);
  const state = { frame: menu, after: menu, refusal: "", captures: 0, blindAfter: false };
  const effects: string[][] = [];
  const io: EffectIO = {
    capture(_target, history) {
      expect(history).toBe(false);
      if (state.blindAfter && effects.length) throw new Error("capture lost");
      state.captures++; return state.frame;
    },
    snapshot: () => ({ dead: "0", command: "claude", windowCount: "2", paneId: binding.paneId, instance: binding.instance, pid: binding.processPid }),
    authorize: () => null, settle: () => {},
    effect(args) { effects.push(args); state.frame = state.after; return { code: 0, stdout: "", stderr: "" }; },
  };
  const sample = () => sampleOperator(run.id, io, env, () => facts);
  const step = (id: string, key = "Escape") => operatorStep(run.id, id, key, "close this observed settings menu",
    () => state.refusal, io, env, () => facts);
  return { env, binding, facts, run, state, effects, io, sample, step };
}
test("each fresh sample permits one key and holds the courier across model thinking", () => {
  const f = fixture(), s = f.sample();
  expect(recoveryHold(f.binding.paneId, f.env, f.facts)).toBe(true);
  expect(f.step(s.id).code).toBe(0);
  expect(f.effects).toEqual([["send-keys", "-t", f.binding.paneId, "Escape"]]);
  expect(f.step(s.id).event.effect).toBe("none");
  expect(f.effects).toHaveLength(1);
  expect(readRun(f.run.id, f.env).operator!.sample!.used).toBe(true);
});
test("changed screen and late external admission refusal send no key", () => {
  const changed = fixture(), s = changed.sample(); changed.state.frame = menu.replace("Settings", "Preferences");
  // Both screens still permit Enter on Close: only the old sample's hash can refuse this key.
  const stale = changed.step(s.id, "Enter");
  expect(stale.event.effect).toBe("none");
  expect(stale.event.summary).toContain("no longer matches the current viewport");
  expect(changed.effects).toHaveLength(0);
  const late = fixture(), sample = late.sample(); late.state.refusal = "human became active";
  expect(late.step(sample.id).event.effect).toBe("none");
  expect(late.effects).toHaveLength(0);
});
test("menu to composer ends navigation before a second Escape can open rewind", () => {
  const f = fixture(); f.state.after = composer;
  expect(f.step(f.sample().id).code).toBe(0);
  const next = f.sample();
  expect(next.surface.kind).toBe("composer");
  expect(f.step(next.id).event.effect).toBe("none");
  expect(f.effects).toHaveLength(1);
});
test("operator purpose cannot borrow nudge editing and legacy recovery cannot borrow operator steps", () => {
  const f = fixture(); f.sample();
  for (const key of ["C-u", "Escape"]) {
    const r = recoveryEffect(f.run.id, "nudge key", "broader path", ["send-keys", "-t", f.binding.paneId, key], f.io, f.env, () => f.facts);
    expect(r.event.effect).toBe("none");
  }
  expect(f.effects).toHaveLength(0);
  const old = fixture(false);
  expect(() => old.sample()).toThrow("operator");
});
test("an uncertain after capture stops the run and prevents a new sample or replay", () => {
  const f = fixture(), s = f.sample(); f.state.blindAfter = true;
  expect(f.step(s.id).code).toBe(124);
  expect(readRun(f.run.id, f.env).state).toBe("stopped");
  expect(() => f.sample()).toThrow();
  expect(f.effects).toHaveLength(1);
});
test("the internal nudge adapter cannot borrow operator custody for repaint or other broader operations", () => {
  const f = fixture();
  const patch = { TAP_INDEX_HOME: f.env.TAP_INDEX_HOME, TAP_LOCK_DIR: f.env.TAP_LOCK_DIR, TAP_RECOVERY_RUN: f.run.id };
  const before = Object.fromEntries(Object.keys(patch).map(key => [key, process.env[key]]));
  Object.assign(process.env, patch);
  try {
    expect(() => recoveryCli(["repaint-probe", f.binding.registry, f.binding.handle, f.binding.pane, f.binding.paneId])).toThrow("operator");
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  expect(f.effects).toHaveLength(0);
});
