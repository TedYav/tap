import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimOperatorRequest, createOperatorRequest, finishOperatorNotification, readOperatorRequest } from "../src/recovery/operator-request";

const root = mkdtempSync(join(tmpdir(), "tap-operator-request-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const env = { ...process.env, TAP_INDEX_HOME: root, TAP_LOCK_DIR: join(root, "locks") };
const binding = { team: "tap", handle: "target", registry: "/tmp/registry", pane: "target:0.0", paneId: "%2",
  session: "target", instance: "instance", harness: "claude", processPid: "123", serverSocket: "/tmp/socket", serverEpoch: "epoch" };
const caller = { handle: "owner", instance: "owner|0123456789abcdef", paneId: "%1", team: "tap" };
const policy = { mode: "ask" as const, afterMs: 1_200_000, source: "config" as const, digest: "sha256:" + "a".repeat(64) };
const accepted = (id: string) => ({ code: 0, stdout: JSON.stringify({ ok: true, notified: true, delivery: "accepted", human_received: null, label: `Approve ${id} — tap/owner`, from: "owner", team: "tap" }), stderr: "" });
const data = { binding, caller, preset: "astra", policyDigest: policy.digest, mail: { home: "/tmp/bus", id: "mail" } };

test("an ask request owns no recovery hold and cannot be approved before notification acceptance", () => {
  const request = createOperatorRequest(data, env, 1000);
  expect(readOperatorRequest(request.id, env)).toMatchObject({ state: "notifying", created: 1000, expires: 301000 });
  expect(() => claimOperatorRequest(request.id, caller, binding, policy, { request_id: request.id, reply: "Yes, go ahead." }, env, 2000)).toThrow("notification");
});
test("accepted notification permits one bounded explicit approval against the original target and config", () => {
  const request = createOperatorRequest(data, env, 1000);
  finishOperatorNotification(request.id, accepted(request.id), env, 1100);
  const approved = claimOperatorRequest(request.id, caller, binding, policy, { request_id: request.id, reply: "Yes, go ahead." }, env, 2000);
  expect(approved).toMatchObject({ state: "claimed", approval: { requestId: request.id, reply: "Yes, go ahead." } });
  expect(() => claimOperatorRequest(request.id, caller, binding, policy, { request_id: request.id, reply: "Yes" }, env, 2001)).toThrow("consumed");
});
test("stale requests, other callers, changed bindings/config and empty or mismatched attestations refuse", () => {
  const cases = [
    { now: 301000 }, { caller: { ...caller, instance: "new-owner" } }, { binding: { ...binding, instance: "new-target" } },
    { policy: { ...policy, mode: "off" as const } }, { policy: { ...policy, digest: "sha256:" + "b".repeat(64) } },
    { note: { request_id: "other-request", reply: "Yes" } }, { note: { reply: "Yes" } }, { note: { request_id: "", reply: "" } },
  ];
  for (const change of cases) {
    const request = createOperatorRequest(data, env, 1000);
    finishOperatorNotification(request.id, accepted(request.id), env, 1100);
    expect(() => claimOperatorRequest(request.id, change.caller ?? caller, change.binding ?? binding, change.policy ?? policy,
      change.note ?? { request_id: request.id, reply: "Yes" }, env, change.now ?? 2000)).toThrow();
    expect(readOperatorRequest(request.id, env).state).toBe("notified");
  }
});
test("failed notification and a missing/forged notifier receipt do not authorize launch", () => {
  for (const result of [{ code: 1, stdout: "", stderr: "notifier down" }, { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: '{"ok":false}', stderr: "" }]) {
    const request = createOperatorRequest(data, env, 1000);
    finishOperatorNotification(request.id, result, env, 1100);
    expect(() => claimOperatorRequest(request.id, caller, binding, policy, { request_id: request.id, reply: "Yes" }, env, 2000)).toThrow("notification");
  }
});
