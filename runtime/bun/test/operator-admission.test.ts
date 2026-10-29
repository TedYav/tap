import { expect, test } from "bun:test";
import { admitOperator, type OperatorFacts } from "../src/recovery/operator-admission";

const now = 2_000_000;
const policy = { mode: "on" as const, afterMs: 1_200_000, source: "config" as const, digest: "a".repeat(64) };
function facts(): OperatorFacts {
  return {
    binding: { team: "tap", handle: "target", registry: "/tmp/team/registry.json", pane: "tap/target:0.0",
      paneId: "%2", session: "tap/target", instance: "instance-1", harness: "claude", processPid: "123",
      serverSocket: "/tmp/tmux/socket", serverEpoch: "1234" },
    callerPane: "%1", captured: true, verdict: "parked-on-dialog", turnEnded: true, progress: false,
    screen: "menu", protection: "clear", scriptedCure: false, recoveryOwned: false,
    clients: [{ id: "/dev/ttys1", session: "tap/target", activity: now - 120_000, created: now - 500_000 }],
    mail: [{ id: "old-mail", home: "/tmp/bus", instance: "instance-1", firstSpooled: now - 1_200_000,
      disposition: "undelivered", valid: true }],
  };
}

test("the exact mail-age and human-inactivity boundaries admit; one millisecond younger does not", () => {
  expect(admitOperator(policy, facts(), now)).toMatchObject({ ok: true, mail: { id: "old-mail" } });
  const young = facts(); young.mail[0]!.firstSpooled!++;
  expect(admitOperator(policy, young, now)).toMatchObject({ ok: false });
  const recent = facts(); recent.clients![0]!.activity++;
  expect(admitOperator(policy, recent, now)).toMatchObject({ ok: false });
});

test("off and report-only never authorize navigation; ask only admits the later approval path", () => {
  expect(admitOperator({ ...policy, mode: "off" }, facts(), now)).toMatchObject({ ok: false });
  const report = facts(); report.reportOnly = true;
  expect(admitOperator(policy, report, now)).toMatchObject({ ok: false });
  expect(admitOperator({ ...policy, mode: "ask" }, facts(), now)).toMatchObject({ ok: true });
});

test("unknown screens need a successful capture and ended native turn, not missing evidence", () => {
  const unknown = facts(); unknown.verdict = "unknown"; unknown.screen = "unknown";
  expect(admitOperator(policy, unknown, now)).toMatchObject({ ok: true });
  for (const patch of [{ captured: false }, { turnEnded: false }, { turnEnded: null }, { progress: null }, { progress: true }]) {
    expect(admitOperator(policy, { ...unknown, ...patch }, now)).toMatchObject({ ok: false });
  }
});

test("productive, healthy, failed and stopped diagnoses do not become operator work", () => {
  for (const verdict of ["healthy", "thinking", "busy-unproven", "unverified-but-processing", "severed", "gone", null] as const) {
    expect(admitOperator(policy, { ...facts(), verdict }, now), String(verdict)).toMatchObject({ ok: false });
  }
  for (const patch of [{ screen: "composer" }, { screen: "draft" }, { screen: "protected" }, { screen: "unobservable" },
    { protection: "held" }, { protection: "unknown" }, { scriptedCure: true }, { recoveryOwned: true }, { progress: true }]) {
    expect(admitOperator(policy, { ...facts(), ...patch } as OperatorFacts, now)).toMatchObject({ ok: false });
  }
});

test("mail needs complete current-instance undelivered evidence, not possible delivery or mere age", () => {
  for (const patch of [{ instance: "previous" }, { valid: false }, { firstSpooled: null }, { firstSpooled: now + 1 },
    { disposition: "read" }, { disposition: "done" }, { disposition: "cancelled" }, { disposition: "delivered" },
    { disposition: "queued" }, { disposition: "unconfirmed" }]) {
    const seen = facts(); Object.assign(seen.mail[0]!, patch);
    expect(admitOperator(policy, seen, now), JSON.stringify(patch)).toMatchObject({ ok: false });
  }
  expect(admitOperator(policy, { ...facts(), mail: [] }, now)).toMatchObject({ ok: false });
});

test("all relevant clients count, including a linked-window viewer and a newly attached client", () => {
  const linked = facts(); linked.clients!.push({ id: "control", session: "other-session", activity: now, created: 1 });
  expect(admitOperator(policy, linked, now)).toMatchObject({ ok: false });
  const attached = facts(); attached.clients![0]!.created = now - 1;
  expect(admitOperator(policy, attached, now)).toMatchObject({ ok: false });
  expect(admitOperator(policy, { ...facts(), clients: [] }, now)).toMatchObject({ ok: true });
  expect(admitOperator(policy, { ...facts(), clients: null }, now)).toMatchObject({ ok: false });
  for (const activity of [NaN, -1, now + 1]) {
    const seen = facts(); seen.clients![0]!.activity = activity;
    expect(admitOperator(policy, seen, now)).toMatchObject({ ok: false });
  }
});

test("self, unsupported harness and incomplete physical identity cannot enter the operator lifecycle", () => {
  const self = facts(); self.callerPane = "%2";
  expect(admitOperator(policy, self, now)).toMatchObject({ ok: false });
  for (const patch of [{ harness: "cursor" }, { processPid: "" }, { instance: "" }, { serverSocket: "" }, { serverEpoch: "" }]) {
    const seen = facts(); Object.assign(seen.binding, patch);
    expect(admitOperator(policy, seen, now)).toMatchObject({ ok: false });
  }
});
