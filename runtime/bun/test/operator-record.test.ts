import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRun, readRun, writeRun, type Liveness } from "../src/recovery/state";

const root = mkdtempSync(join(tmpdir(), "tap-operator-record-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function fixture() {
  const env = { ...process.env, TAP_INDEX_HOME: join(root, String(n++)), TAP_LOCK_DIR: join(root, "locks") };
  const binding = { team: "tap", handle: "target", registry: "/tmp/registry", pane: "target:0.0", paneId: `%${1000 + n}`,
    session: "target", instance: "instance", harness: "claude", processPid: "123", serverSocket: "/tmp/socket", serverEpoch: "epoch" };
  const facts: Liveness = { now: 1000, processAlive: () => true, paneAlive: () => true };
  const operator = { v: 1 as const, binding, policyDigest: "sha256:" + "a".repeat(64),
    authority: "on" as const, admittedAt: 1000, mail: { home: "/tmp/bus", id: "sender-20261028T000000Z-abcdef123456" },
    nativeActivity: 1, clients: [] };
  return { env, binding, facts, operator };
}
test("purpose and operator admission are present from creation and cannot be changed later", () => {
  const f = fixture();
  const run = createRun(f.binding, "cautious", [f.operator.mail], "%1", process.pid, f.env, f.facts, true, f.operator);
  expect(readRun(run.id, f.env)).toMatchObject({ purpose: "operator", operator: f.operator });
  expect(() => writeRun({ ...run, purpose: undefined }, f.env)).toThrow();
  expect(() => writeRun({ ...run, operator: { ...f.operator, authority: "ask" } }, f.env)).toThrow();
});
test("an older detective run cannot acquire an operator purpose after creation", () => {
  const f = fixture();
  const run = createRun(f.binding, "cautious", [], "%1", process.pid, f.env, f.facts);
  expect(readRun(run.id, f.env).purpose).toBeUndefined();
  expect(() => writeRun({ ...run, purpose: "operator", operator: f.operator }, f.env)).toThrow();
});
test("malformed or mismatched operator admission never becomes a held run", () => {
  for (const patch of [{ policyDigest: "" }, { nativeActivity: NaN }, { binding: { ...fixture().binding, paneId: "%99999" } }]) {
    const f = fixture();
    expect(() => createRun(f.binding, "cautious", [f.operator.mail], "%1", process.pid, f.env, f.facts, true,
      { ...f.operator, ...patch })).toThrow();
  }
});
