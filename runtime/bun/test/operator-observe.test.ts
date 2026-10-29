import { expect, test } from "bun:test";
import { observeOperator, operatorBoundaryRefusal, type OperatorReadIO } from "../src/recovery/operator-observe";
import type { SeatCheck } from "../src/verbs/doctor-seat";
import type { OperatorRecord } from "../src/recovery/operator-record";

const now = 2_000_000;
const binding = { team: "tap", handle: "target", registry: "/tmp/registry", pane: "target:0.0", paneId: "%2",
  session: "target", instance: "instance", harness: "claude", processPid: "123", serverSocket: "/tmp/socket", serverEpoch: "epoch", nativeSessionId: "native" };
const menu = "Settings\n\nTheme: dark\nEsc to cancel\n";
const policy = { mode: "on" as const, afterMs: 1_200_000, source: "config" as const, digest: "sha256:" + "a".repeat(64) };
const client = { id: "tty", session: "target", activity: 1_000_000, created: 900_000 };
const record: OperatorRecord = { v: 1, binding, policyDigest: policy.digest, authority: "on", admittedAt: now,
  mail: { home: "/tmp/bus", id: "mail" }, nativeActivity: 1000, clients: [client] };
function fixture() {
  const check: SeatCheck = { code: 2, report: { ok: false, scope: "seat", handle: "target", verdict: "unknown", evidence: [],
    not_checked: [], sampled_at: new Date(now).toISOString(), action: "tap peek target" },
    snapshot: { binding, seat: { harness_session_id: "native" }, busHome: "/tmp/bus", root: "/tmp/repo" } };
  const io: OperatorReadIO = {
    identity: () => ({ ...binding }), frame: () => ({ text: menu, title: "", height: 30, copyMode: false }),
    protection: () => false, native: () => ({ ended: true, lastActivity: 1000, at: 1000 }), clients: () => [client],
    mail: () => [{ ...record.mail, instance: binding.instance, firstSpooled: now - 1_200_000, disposition: "undelivered", valid: true }],
    competingHold: () => false,
  };
  const read = () => observeOperator(check, "%1", io, now);
  return { check, io, read };
}
test("fresh observations compose the actual gate facts without treating a menu as a composer", () => {
  const f = fixture(), seen = f.read();
  expect(seen.facts).toMatchObject({ captured: true, verdict: "unknown", screen: "menu", progress: false, turnEnded: true });
  expect(operatorBoundaryRefusal(record, seen, policy, now)).toBe("");
});
test("identity or native progress during collection cannot be absorbed as a fresh admission", () => {
  const drift = fixture(); let ids = 0;
  drift.io.identity = () => ({ ...binding, nativeSessionId: ++ids > 1 ? "new-native" : "native" });
  expect(() => drift.read()).toThrow("binding");
  const growth = fixture(); let reads = 0;
  growth.io.native = () => ({ ended: true, lastActivity: ++reads > 1 ? 1001 : 1000, at: 1000 });
  expect(operatorBoundaryRefusal(record, growth.read(), policy, now)).not.toBe("");
  const blind = fixture(); blind.io.native = () => null;
  expect(operatorBoundaryRefusal(record, blind.read(), policy, now)).not.toBe("");
});
test("a key rechecks native activity, config and client census against admission, not a new baseline", () => {
  const f = fixture(), seen = f.read();
  expect(operatorBoundaryRefusal(record, { ...seen, nativeActivity: 1001 }, policy, now)).toContain("native");
  expect(operatorBoundaryRefusal(record, seen, { ...policy, digest: "changed" }, now)).toContain("config");
  const changed = { ...seen, facts: { ...seen.facts, clients: [{ ...client, activity: 1_000_001 }] } };
  expect(operatorBoundaryRefusal(record, changed, policy, now)).toContain("client");
  expect(operatorBoundaryRefusal(record, { ...seen, facts: { ...seen.facts, clients: [] } }, policy, now)).toContain("client");
});
test("copy mode, held protection and a composer appearing before the key refuse", () => {
  const copy = fixture(); copy.io.frame = () => ({ text: menu, title: "", height: 30, copyMode: true });
  expect(operatorBoundaryRefusal(record, copy.read(), policy, now)).not.toBe("");
  const held = fixture(); held.io.protection = () => true;
  expect(operatorBoundaryRefusal(record, held.read(), policy, now)).not.toBe("");
  const ready = fixture(); ready.io.frame = () => ({ text: "────────────────────────────────────\n❯ \n────────────────────────────────────\n? for shortcuts\n", title: "", height: 30, copyMode: false });
  expect(operatorBoundaryRefusal(record, ready.read(), policy, now)).not.toBe("");
});
