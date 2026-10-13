// The drain's deadline dispositions (spool-deadline.ts): custody, receipts, events
// and the sender/human addressees, arm by arm, with the sender-notice submit and the
// human alert stubbed at their in-process seams. Everything else is real: the
// spool pair, the claim, the metadata lock, canonical placement.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SubmitResult } from "../src/courier";
import {
  type DeadlineContext, type DeadlineRow, type HumanAlert, ROW_FIELDS,
  disposeAtDeadline, disposeGraceDue, disposeSenderGone, disposeUnrouted, graceAttempted, markEscalated,
  notifySenderOnEscalate, recipientIsPresent, registryMatchesTeam, terminalize, writeDeliveryFailedReceipt,
} from "../src/spool-deadline";
import { noticeBody } from "../src/notice";
import { drainOnce, type DrainContext, type DrainEffects } from "../src/spool-drain";
import { markLegacyNoBinding } from "../src/spool-state";
import { recordPhase } from "../src/submit-phase";

let home: string;
let submits: Array<{ id: string; pane: string; to: string }>;
let alerts: Array<{ reason: string; kind?: string }>;
let submitResult: SubmitResult;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "spool-deadline-"));
  for (const d of ["spool", "payloads", "receipts", "watch"]) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, "registry.json"), JSON.stringify({
    schema: "0.20",
    team: { name: "fixture" },
    seats: {
      alice: { status: "active", pane: "sess:0.1", pane_id: "%402", harness: "codex", instance: "i-alice", boot_id: "b1", server_epoch: "7" },
      peer: { status: "active", pane: "sess:0.0", pane_id: "%401", harness: "codex", instance: "i-peer", boot_id: "b1", server_epoch: "7" },
      poller: { status: "active", pane: "", pane_id: "", delivery: "poll" },
      // Python `str(x or "")`: a numeric 0 pane id reads as "" — no pane, no wake.
      zero: { status: "active", pane: "sess:0.9", pane_id: 0, harness: "codex" },
      listed: { status: ["active"], pane: "sess:0.8", pane_id: "%408", harness: "codex", instance: "i-l", boot_id: "b1", server_epoch: "7" },
    },
  }));
  submits = [];
  alerts = [];
  submitResult = { status: "injected" };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const registry = () => join(home, "registry.json");

function ctx(over: Partial<DeadlineContext> = {}, alert: HumanAlert = { mode: "none" }): DeadlineContext {
  return {
    home, spoolDir: join(home, "spool"), eventLog: join(home, "registry-events.log"), team: "fixture", verbLabel: "tap test",
    actingRegistry: registry(), scriptsDir: join(home, "scripts"), alert, now: 1000, unroutedGrace: 1800,
    wall: () => new Date("2026-09-16T05:00:00Z"),
    submit: (input) => { submits.push({ id: input.id, pane: input.pane, to: input.bound.handle ?? "" }); return submitResult; },
    notifyHuman: (a) => { alerts.push({ reason: a.reason, kind: a.kind }); return 0; },
    ...over,
  };
}

function seed(id: string, meta: Record<string, unknown>, from = "alice", to = "peer"): void {
  writeFileSync(join(home, "spool", `${id}.md`), `---\nid: ${id}\nfrom: ${from}\nto: ${to}\nkind: discuss\nreply: expected\npath: ${join(home, "payloads", `${id}.md`)}\n---\nbody of ${id}\n`);
  writeFileSync(join(home, "spool", `${id}.meta.json`), `${JSON.stringify({
    id, target: to, reason: "pending-input", reason_class: "busy", policy: "standard", first_spooled_epoch: 1,
    hold_until_epoch: 0, deadline_epoch: 500, pane: "sess:0.0", pane_id: "%401", to_team: "fixture",
    target_registry: registry(), attempts: 0, ...meta,
  }, null, 2)}\n`);
}

function seedPendingReprobe(id: string): void {
  seed(id, { waiter_lifetime: "grace-window", policy: "standard" });
  writeFileSync(join(home, "receipts", `${id}.attempted`), `{"id":"${id}","effect":"possible"}\n`);
  const phase = { id, attempt: "transition", recipient: "peer", enter_count: 0 };
  recordPhase(home, { ...phase, phase: "injected-text-confirmed" });
  recordPhase(home, { ...phase, phase: "verify-result", result: "unverified" });
}

function row(id: string, over: Partial<DeadlineRow> = {}): DeadlineRow {
  return {
    id, target: "peer", reason: "pending-input", reasonClass: "busy", timeoutSeconds: "300", firstEpoch: "1", pane: "sess:0.0",
    paneId: "%401", toTeam: "fixture", targetRegistry: registry(), policy: "standard", deadlineEpoch: "500", escalatedAt: "",
    deadlineSource: "readiness-gate", holdUntilEpoch: "0", ...over,
  };
}

const meta = (id: string): Record<string, unknown> => JSON.parse(readFileSync(join(home, "spool", `${id}.meta.json`), "utf8"));

/** One REAL Phase-B pass over the sandbox spool, with the pane effects stubbed to
 *  move nothing: whatever the assertions find afterwards, the routing did it. */
async function drainPass(): Promise<void> {
  writeFileSync(join(home, ".tap-bus-authority"), "");
  mkdirSync(join(home, "index"), { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, TAP_HOME: home, TAP_INDEX_HOME: join(home, "index"),
    TAP_SPOOL_DISABLE_DELIVERER: "1", TAP_SPOOL_NOW: "1000", TAP_SPOOL_DRAIN_ACTIVE: "0",
    XDG_CONFIG_HOME: join(home, "config"), TAP_SPOOL_HUMAN_ALERT: undefined };
  const ctx: DrainContext = { home, spoolDir: join(home, "spool"), payloadsDir: join(home, "payloads"), receiptsDir: join(home, "receipts"),
    eventLog: join(home, "registry-events.log"), team: "fixture", actingRegistry: "", verbLabel: "tap",
    scriptsDir: join(home, "scripts"), courierIdentity: "courier", alert: { mode: "none" }, now: 1000, unroutedGrace: 1800, env };
  const effects: DrainEffects = {
    readiness: async () => "ready", harness: async () => "codex", flash: async () => {},
    repairOrphans: async () => {}, redeliverLocked: async () => 0, digest: async () => 0,
  };
  await drainOnce(ctx, effects, {});
}
const events = (): string => { try { return readFileSync(join(home, "registry-events.log"), "utf8"); } catch { return ""; } };
const notices = (): string[] => {
  const dir = join(home, "payloads");
  return require("node:fs").readdirSync(dir).filter((f: string) => f.startsWith("courier-") || f.endsWith("-delivery-unconfirmed.md"));
};

// --- disposeAtDeadline ---------------------------------------------------------------------

test("not due, and a held claim, change nothing", async () => {
  seed("m1", {});
  expect(await disposeAtDeadline(ctx({ now: 100 }), row("m1"), "gone")).toBe("not-due");
  expect(await disposeAtDeadline(ctx(), row("m1", { deadlineEpoch: "" }), "gone")).toBe("not-due");
  expect(await disposeAtDeadline(ctx(), row("m1", { deadlineEpoch: "later" }), "gone")).toBe("not-due");
  writeFileSync(join(home, "spool", "m1.claim"), '{"v": 1, "id": "m1", "owner_pid": 1, "claimed_at_epoch": 0}\n');
  expect(await disposeAtDeadline(ctx(), row("m1"), "gone")).toBe("claim-held");
  expect(existsSync(join(home, "spool", "m1.md"))).toBe(true);
  expect(meta("m1").escalated_at).toBeUndefined();
  expect(submits).toEqual([]);
});

test("a readiness-gate or window park to a present recipient is held silently, and the claim is released", async () => {
  seed("m2", {});
  for (const ready of ["ready", "busy", "busy:pending", "busy:modal", "busy:clearing"]) {
    expect(await disposeAtDeadline(ctx(), row("m2"), ready)).toBe("held-present");
    expect(await disposeAtDeadline(ctx(), row("m2", { deadlineSource: "", reasonClass: "window" }), ready)).toBe("held-present");
  }
  expect(existsSync(join(home, "spool", "m2.claim"))).toBe(false);
  expect(meta("m2").escalated_at).toBeUndefined();
  expect(submits).toEqual([]);
  expect(events()).toBe("");
});

test("a readiness-gate park whose recipient is gone: marked, sender woken, terminalized — no .cancelled", async () => {
  seed("m3", {});
  expect(await disposeAtDeadline(ctx(), row("m3"), "gone")).toBe("terminalized");
  expect(existsSync(join(home, "spool", "m3.md"))).toBe(false);
  expect(existsSync(join(home, "spool", "m3.meta.json"))).toBe(false);
  expect(readFileSync(join(home, "payloads", "m3.md"), "utf8")).toContain("body of m3");
  expect(existsSync(join(home, "receipts", "m3.cancelled"))).toBe(false);
  expect(submits).toEqual([{ id: submits[0]!.id, pane: "sess:0.1", to: "alice" }]);
  const notice = readFileSync(join(home, "payloads", `${submits[0]!.id}.md`), "utf8");
  expect(notice).toContain("from: courier\nto: alice\nkind: delivery-failed\n");
  expect(notice).toContain("reply: settle-only\n");
  expect(notice).toContain(`DELIVERY FAILED: m3 to peer was not delivered before its deadline.\n\nThe payload is intact:\n  ${join(home, "payloads", "m3.md")}\n\nDetail: reason=pending-input ready=gone\n\n`);
  expect(notice).toContain("If it is still unread, tap resend m3 rings it again under the same id. It will not arrive on its own.\n");
  expect(events()).toContain("spool_terminal_delivery_failed");
  expect(events()).toContain("detail=id=m3_reason=deadline_reached");
  // The archived sidecar records the mark the transaction wrote.
  expect(JSON.parse(readFileSync(join(home, "archive", "m3.meta.json"), "utf8")).escalated_at).toBe("2026-09-16T05:00:00Z");
  expect(existsSync(join(home, "spool", "m3.claim"))).toBe(false);
});

test("an autosettle-hold park at its delivery deadline also gets its .cancelled receipt", async () => {
  seed("m4", { policy: "autosettle", deadline_source: "autosettle-hold" });
  expect(await disposeAtDeadline(ctx(), row("m4", { policy: "autosettle", deadlineSource: "autosettle-hold" }), "busy:pending")).toBe("terminalized");
  const receipt = JSON.parse(readFileSync(join(home, "receipts", "m4.cancelled"), "utf8"));
  expect(receipt).toEqual({ id: "m4", status: "cancelled", at: "2026-09-16T05:00:00Z", by: "courier", via: "cancelled",
    reason: "deadline_reached", target: "peer", source: "courier_expiry" });
  expect(existsSync(join(home, "payloads", "m4.md"))).toBe(true);
});

test("an unconfirmed sender wake leaves the entry escalated-and-held: marked, not terminalized", async () => {
  seed("m5", {});
  submitResult = { status: "unverified", detail: "pane gone during inject" };
  expect(await disposeAtDeadline(ctx(), row("m5"), "gone")).toBe("escalated");
  expect(existsSync(join(home, "spool", "m5.md"))).toBe(true);
  expect(meta("m5").escalated_at).toBe("2026-09-16T05:00:00Z");
  expect(existsSync(join(home, "payloads", "m5.md"))).toBe(false);
  expect(events()).not.toContain("spool_terminal");
  // A second look at an already-marked entry declines.
  expect(await disposeAtDeadline(ctx(), row("m5"), "gone")).toBe("escalate-declined");
  expect(submits.length).toBe(1);
});

test("a polite deadline is marked but owes no wake and no terminal step (the scope fence)", async () => {
  seed("m6", { policy: "polite", deadline_source: "" });
  expect(await disposeAtDeadline(ctx(), row("m6", { policy: "polite", deadlineSource: "" }), "gone")).toBe("escalated");
  expect(meta("m6").escalated_at).toBe("2026-09-16T05:00:00Z");
  expect(submits).toEqual([]);
  expect(existsSync(join(home, "spool", "m6.md"))).toBe(true);
});

test("P5: an entry settled between the gate and the claim is declined, never told it failed", async () => {
  seed("m7", {});
  writeFileSync(join(home, "receipts", "m7.done"), "{}");
  expect(await disposeAtDeadline(ctx(), row("m7"), "gone")).toBe("escalate-declined");
  expect(meta("m7").escalated_at).toBeUndefined();
  expect(submits).toEqual([]);
  // Missing spool files decline the same way.
  seed("m8", {});
  rmSync(join(home, "spool", "m8.md"));
  expect(await disposeAtDeadline(ctx(), row("m8"), "gone")).toBe("escalate-declined");
});

test("a grace park with a possible attempt is disposed: durable notice, .unconfirmed receipt, two events, marked, human alerted once", async () => {
  seed("g1", { waiter_lifetime: "grace-window", attempts: 1 });
  writeFileSync(join(home, "receipts", "g1.attempted"), '{"id":"g1","effect":"possible"}\n');
  const c = ctx({}, { mode: "tick", queuedProbeId: "", probeTimeout: "60" });
  expect(await disposeAtDeadline(c, row("g1"), "gone")).toBe("grace-disposed");
  expect(readFileSync(join(home, "payloads", "g1.md"), "utf8")).toContain("body of g1");
  expect(existsSync(join(home, "spool", "g1.md"))).toBe(true); // custody kept until explicit settlement
  const notice = readFileSync(join(home, "payloads", "g1-delivery-unconfirmed.md"), "utf8");
  expect(notice).toContain("DELIVERY UNCONFIRMED: g1 to peer may or may not have reached them.\n\n");
  expect(notice).toContain("Detail: grace deadline reached after a possible attempt; automatic recipient retry stopped\n");
  expect(JSON.parse(readFileSync(join(home, "receipts", "g1.unconfirmed"), "utf8"))).toEqual({
    id: "g1", status: "unconfirmed", effect: "possible", notice_id: "g1-delivery-unconfirmed", at: "2026-09-16T05:00:00Z",
    by: "courier", reason: "grace_deadline", target: "peer" });
  expect(events()).toContain("redelivery_submit_unverified");
  expect(events()).toContain("spool_terminal_delivery_unconfirmed");
  expect(events()).toContain("detail=id=g1_notice_id=g1-delivery-unconfirmed");
  expect(meta("g1").escalated_at).toBe("2026-09-16T05:00:00Z");
  expect(meta("g1").human_escalated_at).toBe("2026-09-16T05:00:00Z");
  expect(alerts).toEqual([{ reason: "spool entry g1 for 'peer' reached its delivery deadline (reason=grace_deadline delivery=unconfirmed) — needs a human", kind: "spool" }]);
  expect(submits.length).toBe(1);
  // Re-entry: the notice is re-validated, nothing is republished, the human is not alerted again.
  expect(await disposeAtDeadline(c, row("g1"), "gone")).toBe("grace-disposed");
  expect(alerts.length).toBe(1);
  expect(submits.length).toBe(1);
});

test("the queued watch probe's own id names the probe timeout in the human alert; an empty timeout prints '?'", async () => {
  seed("g2", { waiter_lifetime: "grace-window" });
  writeFileSync(join(home, "receipts", "g2.attempted"), "{}");
  expect(await disposeAtDeadline(ctx({}, { mode: "tick", queuedProbeId: "g2", probeTimeout: "45" }), row("g2"), "gone")).toBe("grace-disposed");
  expect(alerts[0]!.reason).toBe("watch probe g2 for 'peer' remained queued past its 45s delivery deadline (reason=grace_deadline delivery=unconfirmed) — needs a human");
  seed("g3", { waiter_lifetime: "grace-window" });
  writeFileSync(join(home, "receipts", "g3.attempted"), "{}");
  expect(await disposeAtDeadline(ctx({}, { mode: "tick", queuedProbeId: "g3", probeTimeout: "" }), row("g3"), "gone")).toBe("grace-disposed");
  expect(alerts[1]!.reason).toBe("watch probe g3 for 'peer' remained queued past its ?s delivery deadline (reason=grace_deadline delivery=unconfirmed) — needs a human");
  // No watcher: no alert, and no human mark.
  seed("g4", { waiter_lifetime: "grace-window" });
  writeFileSync(join(home, "receipts", "g4.attempted"), "{}");
  expect(await disposeAtDeadline(ctx(), row("g4"), "gone")).toBe("grace-disposed");
  expect(alerts.length).toBe(2);
  expect(meta("g4").human_escalated_at).toBeUndefined();
});

test("a failed human alert refuses the human mark and records the disposition as incomplete", async () => {
  seed("g5", { waiter_lifetime: "grace-window" });
  writeFileSync(join(home, "receipts", "g5.attempted"), "{}");
  expect(await disposeAtDeadline(ctx({ notifyHuman: () => 1 }, { mode: "tick", queuedProbeId: "", probeTimeout: "60" }), row("g5"), "gone")).toBe("grace-disposed");
  expect(meta("g5").escalated_at).toBe("2026-09-16T05:00:00Z");
  expect(meta("g5").human_escalated_at).toBeUndefined();
  expect(events()).toContain("grace_disposition_incomplete");
  expect(events()).toContain("id=g5");
});

test("a refused pre-effect grace park keeps its waiter; a conservative marker does not", async () => {
  seed("r1", { waiter_lifetime: "grace-window", policy: "standard" });
  for (const ready of ["ready", "busy", "busy:clearing"]) expect(await disposeAtDeadline(ctx(), row("r1", { deadlineSource: "" }), ready)).toBe("reprobe-eligible");
  expect(meta("r1").escalated_at).toBeUndefined();
  // Not eligible when the recipient is gone: falls through to the mark.
  expect(await disposeAtDeadline(ctx(), row("r1", { deadlineSource: "" }), "gone")).toBe("escalated");
  // The moved spool-grace CLI arm: an empty, torn, directory or dangling marker is
  // a POSSIBLE effect, so the entry is disposed rather than reprobed.
  const attempted = join(home, "receipts", "r2.attempted");
  const shapes: Array<() => void> = [
    () => writeFileSync(attempted, ""), () => writeFileSync(attempted, "{"),
    () => mkdirSync(attempted), () => symlinkSync(join(home, "absent"), attempted),
  ];
  for (const create of shapes) {
    seed("r2", { waiter_lifetime: "grace-window", policy: "standard" });
    create();
    expect(await disposeAtDeadline(ctx(), row("r2", { deadlineSource: "" }), "ready")).toBe("grace-disposed");
    rmSync(attempted, { recursive: true, force: true });
    rmSync(join(home, "payloads", "r2.md"), { force: true });
    rmSync(join(home, "payloads", "r2-delivery-unconfirmed.md"), { force: true });
    rmSync(join(home, "receipts", "r2.unconfirmed"), { force: true });
    rmSync(join(home, "spool", "r2.meta.json.tmp"), { force: true });
  }
  seedPendingReprobe("r3");
  expect(graceAttempted(ctx(), "r3")).toBe(true); // digest admission stays closed
  expect(await disposeAtDeadline(ctx(), row("r3", { deadlineSource: "" }), "busy:pending")).toBe("reprobe-eligible");
  expect(meta("r3").escalated_at).toBeUndefined();
});

test("the watcher's queued probe past its deadline escalates and alerts once instead of reprobing", async () => {
  const watch: HumanAlert = { mode: "tick", queuedProbeId: "wp1", probeTimeout: "60" };
  seed("wp1", { waiter_lifetime: "grace-window", policy: "standard" });
  expect(await disposeAtDeadline(ctx({}, watch), row("wp1", { deadlineSource: "" }), "busy:noprompt")).toBe("escalated");
  expect(meta("wp1").escalated_at).toBe("2026-09-16T05:00:00Z");
  expect(alerts).toEqual([{ reason: expect.stringContaining("watch probe wp1"), kind: "spool" }]);
  // Per-entry dedup: a later tick finds the mark and raises nothing more.
  expect(await disposeAtDeadline(ctx({}, watch), row("wp1", { deadlineSource: "" }), "busy:noprompt")).toBe("escalate-declined");
  expect(alerts).toHaveLength(1);
  // Ordinary grace control: the same shape under the watcher, but not its probe, keeps its waiter.
  seed("wp2", { waiter_lifetime: "grace-window", policy: "standard" });
  expect(await disposeAtDeadline(ctx({}, watch), row("wp2", { deadlineSource: "" }), "busy:noprompt")).toBe("reprobe-eligible");
  expect(meta("wp2").escalated_at).toBeUndefined();
  expect(alerts).toHaveLength(1);
});

test("no present-recipient hold keeps the watcher's queued probe past its deadline", async () => {
  // A window park to a present seat is otherwise held silently (tap-92v3r).
  seed("wp3", { waiter_lifetime: "grace-window", policy: "standard", reason_class: "window" });
  const w3: HumanAlert = { mode: "tick", queuedProbeId: "wp3", probeTimeout: "60" };
  expect(await disposeAtDeadline(ctx({}, w3), row("wp3", { deadlineSource: "", reasonClass: "window" }), "ready")).toBe("escalated");
  expect(meta("wp3").escalated_at).toBe("2026-09-16T05:00:00Z");
  expect(alerts).toEqual([{ reason: expect.stringContaining("watch probe wp3"), kind: "spool" }]);
  // A zero-Enter pending reprobe had a possible effect: it is disposed, never retried, and alerted.
  seedPendingReprobe("wp4");
  const w4: HumanAlert = { mode: "tick", queuedProbeId: "wp4", probeTimeout: "60" };
  expect(await disposeAtDeadline(ctx({}, w4), row("wp4", { deadlineSource: "" }), "busy:pending")).toBe("grace-disposed");
  expect(submits.filter(s => s.to === "peer")).toEqual([]); // only the sender's notice is submitted
  expect(meta("wp4").escalated_at).toBe("2026-09-16T05:00:00Z");
  expect(meta("wp4").human_escalated_at).toBe("2026-09-16T05:00:00Z");
  expect(alerts).toHaveLength(2);
});

test("a watcher probe alert that fails to publish stays unmarked and retries on the next tick", async () => {
  const watch: HumanAlert = { mode: "tick", queuedProbeId: "wp5", probeTimeout: "60" };
  seed("wp5", { waiter_lifetime: "grace-window", policy: "standard" });
  expect(await disposeAtDeadline(ctx({ notifyHuman: () => 1 }, watch), row("wp5", { deadlineSource: "" }), "busy")).toBe("alert-pending");
  expect(meta("wp5").escalated_at).toBeUndefined();
  expect(await disposeAtDeadline(ctx({}, watch), row("wp5", { deadlineSource: "" }), "busy")).toBe("escalated");
  expect(meta("wp5").escalated_at).toBe("2026-09-16T05:00:00Z");
  expect(alerts).toHaveLength(1);
});

// --- disposeGraceDue ----------------------------------------------------------------------

test("the pre-gate leaves a marked grace entry whether or not it is due, and disposes it when it is", async () => {
  seed("p1", {});
  expect(disposeGraceDue(ctx(), row("p1"))).toBe("not-grace");
  writeFileSync(join(home, "receipts", "p1.attempted"), "{}");
  expect(disposeGraceDue(ctx(), row("p1"))).toBe("not-grace"); // no grace-window lifetime
  seed("p2", { waiter_lifetime: "grace-window" });
  writeFileSync(join(home, "receipts", "p2.attempted"), "{}");
  expect(disposeGraceDue(ctx({ now: 10 }), row("p2"))).toBe("grace-waiting");
  writeFileSync(join(home, "spool", "p2.claim"), "{}\n");
  expect(disposeGraceDue(ctx(), row("p2"))).toBe("grace-waiting");
  rmSync(join(home, "spool", "p2.claim"));
  expect(disposeGraceDue(ctx(), row("p2"))).toBe("grace-disposed");
  expect(existsSync(join(home, "receipts", "p2.unconfirmed"))).toBe(true);
  expect(existsSync(join(home, "spool", "p2.claim"))).toBe(false);
  seedPendingReprobe("p3");
  expect(graceAttempted(ctx(), "p3")).toBe(true);
  expect(disposeGraceDue(ctx({ now: 10 }), row("p3"))).toBe("not-grace");
});

test("a grace disposition suppressed by a receipt publishes nothing and records nothing", async () => {
  for (const [id, receipt, body] of [["s1", "s1.done", "{}"], ["s2", "s2.sent", "{}"], ["s3", "s3.read", '{"id":"s3","by":"peer","at":"2026-09-09T01:28:47Z"}']] as const) {
    seed(id, { waiter_lifetime: "grace-window" });
    writeFileSync(join(home, "receipts", `${id}.attempted`), "{}");
    writeFileSync(join(home, "receipts", receipt), body);
    expect(disposeGraceDue(ctx(), row(id))).toBe("grace-disposed");
    expect(existsSync(join(home, "payloads", `${id}-delivery-unconfirmed.md`))).toBe(false);
    expect(existsSync(join(home, "receipts", `${id}.unconfirmed`))).toBe(false);
    expect(events()).not.toContain(`notice_id=${id}-delivery-unconfirmed`);
  }
  // Operator mail is suppressed by the same evidence: delivered or read never escalates (astra-ponytail).
  for (const [id, receipt, body] of [["o1", "o1.sent", "{}"], ["o2", "o2.read", '{"id":"o2","by":"peer","at":"2026-09-09T01:28:47Z"}']] as const) {
    seed(id, { waiter_lifetime: "grace-window" }, "user");
    writeFileSync(join(home, "receipts", `${id}.attempted`), "{}");
    writeFileSync(join(home, "receipts", receipt), body);
    expect(disposeGraceDue(ctx(), row(id))).toBe("grace-disposed");
    expect(JSON.parse(readFileSync(join(home, "spool", `${id}.meta.json`), "utf8")).escalated_at).toBeUndefined();
    expect(events()).not.toContain(`id=${id} target`);
  }
  // A forced or malformed read is not an authorized read.
  seed("s4", { waiter_lifetime: "grace-window" });
  writeFileSync(join(home, "receipts", "s4.attempted"), "{}");
  writeFileSync(join(home, "receipts", "s4.read"), '{"id":"s4","by":"alice","forced":"true"}');
  expect(disposeGraceDue(ctx(), row("s4"))).toBe("grace-disposed");
  expect(existsSync(join(home, "payloads", "s4-delivery-unconfirmed.md"))).toBe(true);
});

// --- disposeUnrouted -------------------------------------------------------------------------

test("a routable entry is left to the ordinary path; an excluded one is marked, then aged out as unrouted", async () => {
  seed("u1", {});
  expect(await disposeUnrouted(ctx(), row("u1"))).toBe("routable");
  expect(meta("u1").reason).toBe("pending-input");
  // Excluded by a missing pane id; deadline present and not yet aged.
  expect(await disposeUnrouted(ctx({ now: 600 }), row("u1", { paneId: "" }))).toBe("unrouted-waiting");
  expect(meta("u1").reason).toBe("legacy_meta_no_binding");
  expect(meta("u1").original_reason).toBe("pending-input");
  expect(events()).toContain("spool_marked_unroutable");
  expect(meta("u1").escalated_at).toBeUndefined();
  // Aged past the grace: promoted as unrouted, sender told no attempt was made.
  expect(await disposeUnrouted(ctx({ now: 500 + 1800 }), row("u1", { paneId: "", reason: "legacy_meta_no_binding" }))).toBe("unrouted-escalated");
  expect(existsSync(join(home, "spool", "u1.md"))).toBe(false);
  expect(existsSync(join(home, "payloads", "u1.md"))).toBe(true);
  expect(events()).toContain("spool_terminal_unrouted");
  expect(events()).toContain("detail=id=u1_reason=unrouted");
  const notice = readFileSync(join(home, "payloads", `${submits[0]!.id}.md`), "utf8");
  expect(notice).toContain("NOT DELIVERED: u1 to peer was never attempted.\n\n");
  expect(notice).toContain("Detail: excluded from every delivery path by reason='legacy_meta_no_binding'; no delivery was ever attempted\n\n");
  expect(notice).toContain("they may be perfectly fine. Run tap resend u1 to ring it again under the same id.\n");
});

test("an unrouted operator note is cancelled too, so `tap outstanding user` clears", async () => {
  seed("u-op", {}, "user");
  expect(await disposeUnrouted(ctx({ now: 600 }), row("u-op", { paneId: "" }))).toBe("unrouted-waiting");
  expect(await disposeUnrouted(ctx({ now: 500 + 1800 }), row("u-op", { paneId: "", reason: "legacy_meta_no_binding" }))).toBe("unrouted-escalated");
  expect(readFileSync(join(home, "receipts", "u-op.cancelled"), "utf8")).toContain("unrouted");
  // A seat's unrouted note keeps its existing semantics: notified, never cancelled.
  seed("u-seat", {});
  await disposeUnrouted(ctx({ now: 600 }), row("u-seat", { paneId: "" }));
  await disposeUnrouted(ctx({ now: 500 + 1800 }), row("u-seat", { paneId: "", reason: "legacy_meta_no_binding" }));
  expect(existsSync(join(home, "receipts", "u-seat.cancelled"))).toBe(false);
});

test("legacy clocks age from the deadline or park; no clock stays parked; settled entries reconcile", async () => {
  seed("u2", { deadline_epoch: null });
  expect(await disposeUnrouted(ctx({ now: 1 + 1800 }), row("u2", { deadlineEpoch: "", firstEpoch: "1", targetRegistry: "" }))).toBe("unrouted-escalated");
  expect(existsSync(join(home, "payloads", "u2.md"))).toBe(true);
  expect(submits.length).toBe(1);
  seed("u2-float", { deadline_epoch: 500.0 });
  expect(await disposeUnrouted(ctx({ now: 500 + 1800 }), row("u2-float", { deadlineEpoch: "500.0", pane: "" }))).toBe("unrouted-escalated");
  expect(existsSync(join(home, "payloads", "u2-float.md"))).toBe(true);
  seed("u3", {});
  expect(await disposeUnrouted(ctx({ now: 99999 }), row("u3", { deadlineEpoch: "", firstEpoch: "", pane: "" }))).toBe("unrouted-waiting");
  expect(existsSync(join(home, "spool", "u3.md"))).toBe(true);
  // Registry team mismatch is an exclusion too.
  seed("u4", {});
  expect(await disposeUnrouted(ctx({ now: 10 }), row("u4", { toTeam: "other" }))).toBe("unrouted-waiting");
  expect(meta("u4").reason).toBe("legacy_meta_no_binding");
  // Settled: promoted (or removed) without a notice.
  seed("u5", { reason: "legacy_meta_no_binding" });
  writeFileSync(join(home, "receipts", "u5.done"), "{}");
  expect(await disposeUnrouted(ctx({ now: 99999 }), row("u5", { reason: "legacy_meta_no_binding" }))).toBe("settled");
  expect(existsSync(join(home, "spool", "u5.md"))).toBe(false);
  expect(existsSync(join(home, "payloads", "u5.md"))).toBe(true);
  expect(events()).toContain("spool_terminal_settled");
  expect(submits.filter((s) => s.id.includes("u5")).length).toBe(0);
});

// Ported from smoke/drain-sink-no-silent-skip.test.sh (arms 3, 5, 6, the
// registry-moved half of arm 2, and the arm-8 event negatives the existing
// unrouted tests did not pin): no state may exist that every drain skips while
// nobody has been told, and the dispositions must not claim facts nobody made.
test("the unrouted sink: attempts stay zero, the audit trail survives re-marks, escalated entries split on settlement", async () => {
  // A sunk entry is never attempted: the unrouted disposition claims no
  // attempt and never logs as a delivery failure.
  seed("sunk", {});
  expect(await disposeUnrouted(ctx({ now: 500 + 1800 }), row("sunk", { paneId: "" }))).toBe("unrouted-escalated");
  expect(existsSync(join(home, "receipts", "sunk.attempted"))).toBe(false);
  expect(events()).not.toContain("spool_terminal_delivery_failed");
  // A waiting entry keeps attempts at zero in the meta itself.
  seed("sunk-waiting", {});
  expect(await disposeUnrouted(ctx({ now: 10 }), row("sunk-waiting", { paneId: "" }))).toBe("unrouted-waiting");
  expect(meta("sunk-waiting").attempts ?? 0).toBe(0);

  // The mark preserves the diagnosis it displaces (original_reason + history),
  // names the displaced reason in its event, and a re-mark is a no-op: the
  // early exit neither rewrites the origin nor appends a second event.
  seed("audit", {});
  const stamp = new Date("2026-09-16T05:00:00Z");
  markLegacyNoBinding(join(home, "spool"), "audit", join(home, "registry-events.log"), "fixture", "tap test", stamp);
  const audit = meta("audit");
  expect(audit.original_reason).toBe("pending-input");
  expect((audit.reason_history as Array<{ reason: string }>)[0]?.reason).toBe("pending-input");
  expect(events()).toContain("action=spool_marked_unroutable");
  const auditEvents = () => events().split("\n")
    .filter((line) => line.includes("action=spool_marked_unroutable") && line.includes("id=audit"));
  expect(auditEvents()).toHaveLength(1);
  expect(events()).toContain("from_reason=pending-input");
  markLegacyNoBinding(join(home, "spool"), "audit", join(home, "registry-events.log"), "fixture", "tap test", stamp);
  expect(meta("audit").original_reason).toBe("pending-input");
  expect(auditEvents()).toHaveLength(1);

  // The escalated split is the DRAIN's routing, not the sink's: an escalated row
  // never reaches disposeUnrouted in Phase B — a settled one reconciles above the
  // grace gate (spool-drain.ts:284-286) and any other is skipped at :290. So the
  // two halves run through one real drain pass each, with the receipt seeded first.
  seed("esc-settled", { escalated_at: "2026-01-01T00:00:00Z" });
  writeFileSync(join(home, "receipts", "esc-settled.done"), "{}");
  await drainPass();
  expect(existsSync(join(home, "spool", "esc-settled.meta.json")), "the settled escalated row was not reconciled").toBe(false);
  expect(events()).toContain("detail=id=esc-settled_reason=settled");
  seed("esc-unsettled", { escalated_at: "2026-01-01T00:00:00Z" });
  await drainPass();
  expect(existsSync(join(home, "spool", "esc-unsettled.meta.json")), "an unsettled escalated row left the spool").toBe(true);
  expect(meta("esc-unsettled").escalated_at).toBe("2026-01-01T00:00:00Z");

  // The registry-moved route: a binding valid at park sinks through the same
  // read-site disjunct when the registry file is gone.
  seed("moved", {});
  expect(await disposeUnrouted(ctx({ now: 500 + 1800 }),
    row("moved", { targetRegistry: "/nonexistent/registry-moved.json" }))).toBe("unrouted-escalated");
  expect(existsSync(join(home, "spool", "moved.meta.json"))).toBe(false);
});

// --- the watcher's queued probe vs the redelivery skip (tap-oir29) --------------------------
// These run the REAL drainOnce routing over the sandbox spool with a pinned readiness
// answer, the tick's alert facts (spool-engine-worker.ts:68), and a recording redelivery
// stub: whatever the assertions find, the routing did.

/** One real drain pass with a pinned readiness answer, the watcher's alert facts,
 *  and an optional TAP_SPOOL_DRAIN_CAP for the pass. */
async function drainPassAs(ready: string, alert: HumanAlert, cap = ""): Promise<number> {
  writeFileSync(join(home, ".tap-bus-authority"), "");
  mkdirSync(join(home, "index"), { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, TAP_HOME: home, TAP_INDEX_HOME: join(home, "index"),
    TAP_SPOOL_DISABLE_DELIVERER: "1", TAP_SPOOL_NOW: "1000", TAP_SPOOL_DRAIN_ACTIVE: "0",
    XDG_CONFIG_HOME: join(home, "config"), TAP_SPOOL_HUMAN_ALERT: undefined };
  const ctx: DrainContext = { home, spoolDir: join(home, "spool"), payloadsDir: join(home, "payloads"), receiptsDir: join(home, "receipts"),
    eventLog: join(home, "registry-events.log"), team: "fixture", actingRegistry: "", verbLabel: "tap",
    scriptsDir: join(home, "scripts"), courierIdentity: "courier", alert, now: 1000, unroutedGrace: 1800,
    wall: () => new Date("2026-09-16T05:00:00Z"),
    notifyHuman: (a) => { alerts.push({ reason: a.reason, kind: a.kind }); return 0; }, env };
  let redeliveries = 0;
  const effects: DrainEffects = {
    readiness: async () => ready, harness: async () => "codex", flash: async () => {},
    repairOrphans: async () => {}, redeliverLocked: async () => { redeliveries++; return 1; }, digest: async () => 0,
  };
  await drainOnce(ctx, effects, cap === "" ? {} : { cap });
  return redeliveries;
}

test("the watcher's own queued probe escalates past its deadline from queued and recovery holds, never redelivered", async () => {
  for (const [ready, tag] of [["busy:queued", "q"], ["busy:recovery", "r"]] as const) {
    const id = `wp-${tag}`;
    seed(id, {});
    alerts.length = 0;
    const redeliveries = await drainPassAs(ready, { mode: "tick", queuedProbeId: id, probeTimeout: "10" });
    expect(meta(id).escalated_at, `${ready}: escalated_at set beyond the deadline`).toBe("2026-09-16T05:00:00Z");
    expect(alerts, `${ready}: one sticky human alert`).toHaveLength(1);
    expect(alerts[0]!.kind).toBe("spool");
    expect(alerts[0]!.reason).toContain("watch probe");
    expect(alerts[0]!.reason).toContain(ready);
    expect(redeliveries, `${ready}: no redelivery attempt behind the hold`).toBe(0);
    expect(existsSync(join(home, "spool", `${id}.md`)), `${ready}: entry retained`).toBe(true);
    // Idempotence: a later pass neither re-alerts nor re-marks.
    expect(await drainPassAs(ready, { mode: "tick", queuedProbeId: id, probeTimeout: "10" })).toBe(0);
    expect(alerts, `${ready}: still exactly one alert`).toHaveLength(1);
    expect(meta(id).escalated_at).toBe("2026-09-16T05:00:00Z");
  }
});

test("another entry parked behind the same holds keeps the redelivery skip: held, never escalated", async () => {
  seed("plain-q", {});
  const redeliveries = await drainPassAs("busy:queued", { mode: "tick", queuedProbeId: "watcher-someone-else", probeTimeout: "10" });
  expect(redeliveries).toBe(0);
  expect(alerts).toHaveLength(0);
  expect(meta("plain-q").escalated_at).toBeUndefined();
  expect(existsSync(join(home, "spool", "plain-q.md"))).toBe(true);
});

test("gone control: the watcher probe past its deadline with a gone recipient still escalates without an attempt", async () => {
  seed("wp-gone", {});
  const redeliveries = await drainPassAs("gone", { mode: "tick", queuedProbeId: "wp-gone", probeTimeout: "10" });
  expect(redeliveries).toBe(0);
  expect(meta("wp-gone").escalated_at).toBe("2026-09-16T05:00:00Z");
  expect(alerts).toHaveLength(1);
});

test("an unparseable cap keeps the drain fail-closed: no Phase B work, probe included", async () => {
  seed("wp-abc", {});
  seed("held-abc", { first_spooled_epoch: 1 });
  const redeliveries = await drainPassAs("busy:queued", { mode: "tick", queuedProbeId: "wp-abc", probeTimeout: "10" }, "abc");
  expect(redeliveries).toBe(0);
  expect(alerts).toHaveLength(0);
  expect(meta("wp-abc").escalated_at).toBeUndefined();
  expect(meta("held-abc").escalated_at).toBeUndefined();
  expect(existsSync(join(home, "spool", "wp-abc.md"))).toBe(true);
});

test("past the spent budget only the owned probe proceeds: intervening entries keep pre-gate effects off", async () => {
  // Nine held entries: the ninth is where the old break fired (its own pre-gate
  // effects always ran); a sender-gone entry behind it must NOT be visited by the
  // open walk — disposeSenderGone would retire it before the probe is reached.
  for (let i = 0; i < 9; i++) seed(`held-${i}`, { first_spooled_epoch: 1 });
  seed("sgone", { first_spooled_epoch: 2, escalated_at: "2026-01-01T00:00:00Z" }, "zelda");
  seed("wp-after", { first_spooled_epoch: 3 });
  const redeliveries = await drainPassAs("busy:queued", { mode: "tick", queuedProbeId: "wp-after", probeTimeout: "10" }, "8");
  expect(meta("wp-after").escalated_at, "the probe still gets its alert").toBe("2026-09-16T05:00:00Z");
  expect(alerts).toHaveLength(1);
  expect(redeliveries).toBe(0);
  expect(existsSync(join(home, "spool", "sgone.meta.json")), "the spent pass left the sender-gone entry untouched").toBe(true);
  expect(meta("sgone").escalated_at).toBe("2026-01-01T00:00:00Z");
});

test("plain-busy control: the deadline attempt still runs first, and the failed attempt still escalates", async () => {
  seed("wp-busy", {});
  const redeliveries = await drainPassAs("busy", { mode: "tick", queuedProbeId: "wp-busy", probeTimeout: "10" });
  expect(redeliveries, "plain busy is not in the redelivery skip: the attempt runs").toBe(1);
  expect(meta("wp-busy").escalated_at).toBe("2026-09-16T05:00:00Z");
  expect(alerts).toHaveLength(1);
  expect(existsSync(join(home, "spool", "wp-busy.md"))).toBe(true);
});

test("a cap-sized older held backlog cannot starve the owned probe's deadline alert", async () => {
  // Twelve older held entries dwarf the pass budget (cap 8) and sort ahead of the
  // probe: the walk must keep the pass open for the probe without spending budget.
  for (let i = 0; i < 12; i++) seed(`held-${i}`, { first_spooled_epoch: 1 });
  seed("wp-starved", { first_spooled_epoch: 2 });
  const redeliveries = await drainPassAs("busy:queued", { mode: "tick", queuedProbeId: "wp-starved", probeTimeout: "10" }, "8");
  expect(meta("wp-starved").escalated_at, "the owned probe outranks the cap for its alert").toBe("2026-09-16T05:00:00Z");
  expect(alerts).toHaveLength(1);
  expect(redeliveries).toBe(0);
  for (let i = 0; i < 12; i++) {
    expect(meta(`held-${i}`).escalated_at).toBeUndefined();
    expect(existsSync(join(home, "spool", `held-${i}.md`))).toBe(true);
  }
});

// --- the helpers -----------------------------------------------------------------------------

test("markEscalated writes each key once, under the metadata lock, without a trailing newline", async () => {
  seed("k1", {});
  expect(markEscalated(ctx(), "k1")).toBe(true);
  expect(markEscalated(ctx(), "k1")).toBe(false);
  expect(markEscalated(ctx(), "k1", "human_escalated_at")).toBe(true);
  expect(markEscalated(ctx(), "k1", "human_escalated_at")).toBe(false);
  const bytes = readFileSync(join(home, "spool", "k1.meta.json"), "utf8");
  expect(bytes.endsWith("}")).toBe(true);
  expect(bytes).toBe(JSON.stringify(JSON.parse(bytes), Object.keys(JSON.parse(bytes)).sort(), 2));
  expect(markEscalated(ctx(), "absent")).toBe(false);
  // A falsy stored value does not refuse (Python `if meta.get(key)`).
  seed("k2", { escalated_at: "" });
  expect(markEscalated(ctx(), "k2")).toBe(true);
});

test("terminalize promotes before discarding, names the action, and refuses when nothing can be promoted", async () => {
  seed("t1", {});
  expect(await terminalize(ctx(), "t1", "peer", "sess:0.0", "settled", "spool_terminal_settled")).toBe(true);
  expect(existsSync(join(home, "spool", "t1.md"))).toBe(false);
  expect(existsSync(join(home, "spool", "t1.meta.json"))).toBe(false);
  expect(readFileSync(join(home, "payloads", "t1.md"), "utf8")).toContain("body of t1");
  expect(events()).toContain("spool_terminal_settled");
  expect(events()).toContain("detail=id=t1_reason=settled");
  // An existing canonical is kept; the spool copy still goes.
  seed("t2", {});
  writeFileSync(join(home, "payloads", "t2.md"), "canonical wins\n");
  expect(await terminalize(ctx(), "t2", "peer", "sess:0.0")).toBe(true);
  expect(readFileSync(join(home, "payloads", "t2.md"), "utf8")).toBe("canonical wins\n");
  expect(existsSync(join(home, "spool", "t2.md"))).toBe(false);
  expect(events()).toContain("spool_terminal_delivery_failed");
  // Nothing to promote: refused, no event, no removal.
  writeFileSync(join(home, "spool", "t3.meta.json"), "{}");
  expect(await terminalize(ctx(), "t3", "peer", "sess:0.0")).toBe(false);
  expect(existsSync(join(home, "spool", "t3.meta.json"))).toBe(true);
});

test("writeDeliveryFailedReceipt writes once and never over a settlement", async () => {
  expect(writeDeliveryFailedReceipt(ctx(), "w1", "peer", "deadline_reached")).toBe(true);
  const first = readFileSync(join(home, "receipts", "w1.cancelled"), "utf8");
  expect(writeDeliveryFailedReceipt(ctx({ wall: () => new Date("2027-01-01T00:00:00Z") }), "w1", "peer")).toBe(true);
  expect(readFileSync(join(home, "receipts", "w1.cancelled"), "utf8")).toBe(first);
  writeFileSync(join(home, "receipts", "w2.done"), "{}");
  expect(writeDeliveryFailedReceipt(ctx(), "w2", "peer")).toBe(true);
  expect(existsSync(join(home, "receipts", "w2.cancelled"))).toBe(false);
  expect(writeDeliveryFailedReceipt(ctx(), "bad id", "peer")).toBe(false);
  // Bash `[ -e ]` follows the link: a DANGLING terminal receipt is no receipt (the
  // sender would stay outstanding for ever behind it) and is replaced by the regular
  // cancellation; a dangling `.done` suppresses nothing either.
  symlinkSync(join(home, "absent"), join(home, "receipts", "w3.cancelled"));
  expect(writeDeliveryFailedReceipt(ctx(), "w3", "peer", "deadline_reached")).toBe(true);
  expect(lstatSync(join(home, "receipts", "w3.cancelled")).isSymbolicLink()).toBe(false);
  expect(JSON.parse(readFileSync(join(home, "receipts", "w3.cancelled"), "utf8"))).toMatchObject({ id: "w3", status: "cancelled", reason: "deadline_reached", source: "courier_expiry" });
  symlinkSync(join(home, "absent"), join(home, "receipts", "w4.done"));
  expect(writeDeliveryFailedReceipt(ctx(), "w4", "peer")).toBe(true);
  expect(existsSync(join(home, "receipts", "w4.cancelled"))).toBe(true);
});

test("a DIRECTORY at a digest member's .done does not suppress the sender notice (rule 38)", async () => {
  // The repo asks whether a receipt EXISTS with `[ -f ]` (`tap_is_done`, lib.sh:1779),
  // and `isDone` above already does. This question — is EVERY represented member
  // settled? — asked it with `existsSync`, so an entry that is not a regular file at
  // `receipts/<member>.done` read as a settlement and the digest's notice was skipped
  // for a message nobody settled .
  //
  // The fixture has to make that directory the ONLY thing between the members and
  // "all settled": my first version left a member with no receipt at all, which makes
  // `every` false in both directions and the mutant survived.
  seed("d1", {}, "alice", "peer");
  seed("d2", {}, "alice", "peer");
  seed("d3", {}, "alice", "peer");
  writeFileSync(join(home, "receipts", "d1.done"), "{}");
  mkdirSync(join(home, "receipts", "d2.done"));
  const base = { id: "d3", target: "peer", detail: "d", targetRegistry: registry(), outcome: "unconfirmed" } as const;
  expect(notifySenderOnEscalate(ctx(), { ...base, durableId: "d3-delivery-unconfirmed", digestMembers: "d1 d2" })).toBe(true);
  expect(existsSync(join(home, "payloads", "d3-delivery-unconfirmed.md"))).toBe(true);
  // The positive control: make d2's receipt a REAL file and the same call suppresses,
  // so the arm is not asserting that notices are simply always published.
  seed("d4", {}, "alice", "peer");
  rmSync(join(home, "receipts", "d2.done"), { recursive: true });
  writeFileSync(join(home, "receipts", "d2.done"), "{}");
  expect(notifySenderOnEscalate(ctx(), { ...base, id: "d4", durableId: "d4-delivery-unconfirmed", digestMembers: "d1 d2" })).toBe(true);
  expect(existsSync(join(home, "payloads", "d4-delivery-unconfirmed.md"))).toBe(false);
});

test("graceAttempted, recipientIsPresent and registryMatchesTeam are the incumbent predicates", async () => {
  seed("a1", { waiter_lifetime: "grace-window" });
  expect(graceAttempted(ctx(), "a1")).toBe(false);
  symlinkSync(join(home, "absent"), join(home, "receipts", "a1.attempted")); // dangling counts
  expect(graceAttempted(ctx(), "a1")).toBe(true);
  seed("a2", {});
  writeFileSync(join(home, "receipts", "a2.attempted"), "{}");
  expect(graceAttempted(ctx(), "a2")).toBe(false);
  for (const ready of ["ready", "busy", "busy:pending", "busy:modal", "busy:clearing", "", "unknown"]) expect(recipientIsPresent(ready)).toBe(true);
  for (const ready of ["gone", "unsafe"]) expect(recipientIsPresent(ready)).toBe(false);
  expect(registryMatchesTeam(registry(), "")).toBe(true);
  expect(registryMatchesTeam(registry(), "fixture")).toBe(true);
  expect(registryMatchesTeam(registry(), "other")).toBe(false);
  expect(registryMatchesTeam(join(home, "absent.json"), "fixture")).toBe(false);
  writeFileSync(join(home, "torn.json"), "{");
  expect(registryMatchesTeam(join(home, "torn.json"), "fixture")).toBe(false);
  // The incumbent's Python predicate (astra R1): `.strip()` is Python's whitespace set
  // (NEL stripped; a BOM is not whitespace), a truthy non-string name has no `.strip()`
  // and never matches, a falsy one is "", and decoding is strict — one undecodable
  // byte anywhere makes the registry unreadable.
  const teamDoc = (name: unknown) => { writeFileSync(join(home, "t.json"), JSON.stringify({ schema: "0.20", team: { name }, seats: {} })); return join(home, "t.json"); };
  expect(registryMatchesTeam(teamDoc("fixture\u0085"), "fixture")).toBe(true);
  expect(registryMatchesTeam(teamDoc(" fixture\u3000"), "fixture")).toBe(true);
  expect(registryMatchesTeam(teamDoc("fixture\ufeff"), "fixture")).toBe(false);
  expect(registryMatchesTeam(teamDoc(123), "123")).toBe(false);
  expect(registryMatchesTeam(teamDoc(["fixture"]), "fixture")).toBe(false);
  expect(registryMatchesTeam(teamDoc(true), "true")).toBe(false);
  expect(registryMatchesTeam(teamDoc(null), "fixture")).toBe(false);
  expect(registryMatchesTeam(teamDoc(0), "0")).toBe(false);
  writeFileSync(join(home, "bytes.json"), Buffer.concat([Buffer.from('{"team":{"name":"fixture"},"seats":{},"note":"'), Buffer.from([0xff]), Buffer.from('"}')]));
  expect(registryMatchesTeam(join(home, "bytes.json"), "fixture")).toBe(false);
});

test("a durable notice is never addressed to the operator: the outcome is an event", () => {
  seed("op-n", {}, "user");
  const base = { id: "op-n", target: "peer", detail: "d", targetRegistry: registry() } as const;
  expect(notifySenderOnEscalate(ctx(), { ...base, durableId: "op-n-delivery-unconfirmed", outcome: "failed" })).toBe(true);
  expect(existsSync(join(home, "payloads", "op-n-delivery-unconfirmed.md"))).toBe(false);
  expect(events()).toContain("spool_notice_operator_recorded");
  // An unreadable registry cannot confirm there is no legacy `user` seat: it refuses (astra-ponytail).
  const unreadable = ctx({ actingRegistry: join(home, "missing.json") });
  expect(notifySenderOnEscalate(unreadable, { ...base, targetRegistry: join(home, "missing.json"), durableId: "op-n-delivery-unconfirmed", outcome: "failed" })).toBe(false);
});

test("an operator grace entry escalates without a notice and then retires (astra-ponytail)", async () => {
  seed("op-g", { waiter_lifetime: "grace-window" }, "user");
  writeFileSync(join(home, "receipts", "op-g.attempted"), "{}");
  expect(disposeGraceDue(ctx(), row("op-g"))).toBe("grace-disposed");
  expect(events()).not.toContain("grace_disposition_incomplete");
  expect(events()).toContain("spool_notice_operator_recorded");
  expect(existsSync(join(home, "payloads", "op-g-delivery-unconfirmed.md"))).toBe(false);
  const meta = JSON.parse(readFileSync(join(home, "spool", "op-g.meta.json"), "utf8"));
  expect(typeof meta.escalated_at).toBe("string");
  const later = Date.parse(meta.escalated_at) / 1000 + 1800 + 1;
  expect(await disposeSenderGone(ctx({ now: later }), row("op-g", { escalatedAt: meta.escalated_at }))).toBe(true);
  expect(readFileSync(join(home, "receipts", "op-g.cancelled"), "utf8")).toContain("operator_undeliverable");
  expect(existsSync(join(home, "spool", "op-g.md"))).toBe(false);
  // A legacy seat named `user` keeps the ordinary notice.
  const doc = JSON.parse(readFileSync(registry(), "utf8"));
  doc.seats.user = { status: "active", pane: "sess:0.5", pane_id: "%405", harness: "codex" };
  writeFileSync(registry(), JSON.stringify(doc));
  seed("legacy-g", { waiter_lifetime: "grace-window" }, "user");
  writeFileSync(join(home, "receipts", "legacy-g.attempted"), "{}");
  expect(disposeGraceDue(ctx(), row("legacy-g"))).toBe("grace-disposed");
  expect(existsSync(join(home, "payloads", "legacy-g-delivery-unconfirmed.md"))).toBe(true);
});

test("the sender notice refuses recursion, self-notices, poll senders and missing senders; durable ids re-validate", async () => {
  seed("n1", {});
  const base = { id: "n1", target: "peer", detail: "d", targetRegistry: registry() } as const;
  // Recursion: a delivery-failed canonical never mints a second notice.
  writeFileSync(join(home, "spool", "n2.md"), `---\nid: n2\nfrom: courier\nto: alice\nkind: delivery-failed\n---\nx\n`);
  expect(notifySenderOnEscalate(ctx(), { ...base, id: "n2", outcome: "failed" })).toBe(false);
  // Sender is the target.
  seed("n3", {}, "peer", "peer");
  expect(notifySenderOnEscalate(ctx(), { ...base, id: "n3", outcome: "failed" })).toBe(false);
  // A poll sender: no pane wake; a durable notice is still published.
  seed("n4", {}, "poller", "peer");
  expect(notifySenderOnEscalate(ctx(), { ...base, id: "n4", outcome: "failed" })).toBe(false);
  expect(notifySenderOnEscalate(ctx(), { ...base, id: "n4", outcome: "unconfirmed", durableId: "n4-delivery-unconfirmed" })).toBe(true);
  expect(existsSync(join(home, "payloads", "n4-delivery-unconfirmed.md"))).toBe(true);
  expect(submits).toEqual([]);
  // A sender absent from every registry.
  seed("n5", {}, "ghost", "peer");
  expect(notifySenderOnEscalate(ctx(), { ...base, id: "n5", outcome: "failed" })).toBe(false);
  // A registered sender whose pane id is the number 0: Python read it as "" (no wake).
  seed("n6", {}, "zero", "peer");
  expect(notifySenderOnEscalate(ctx(), { ...base, id: "n6", outcome: "failed" })).toBe(false);
  expect(submits).toEqual([]);
  // A container never coerces into an active seat (astra R2): Python's `str(["active"])`
  // is `['active']`, which is not "active" — no notice, no submit. A registry with one
  // undecodable byte is unreadable: the sender is missing.
  seed("n7", {}, "listed", "peer");
  expect(notifySenderOnEscalate(ctx(), { ...base, id: "n7", outcome: "failed" })).toBe(false);
  expect(existsSync(join(home, "payloads"))).toBe(true);
  expect(readdirSync(join(home, "payloads")).filter((n) => n.startsWith("courier-"))).toEqual([]);
  expect(submits).toEqual([]);
  const good = readFileSync(registry());
  writeFileSync(registry(), Buffer.concat([Buffer.from(good.toString("utf8").replace(/}\s*$/, ',"note":"')), Buffer.from([0xff]), Buffer.from('"}')]));
  seed("n8", {}, "alice", "peer");
  expect(notifySenderOnEscalate(ctx(), { ...base, id: "n8", outcome: "failed" })).toBe(false);
  expect(submits).toEqual([]);
  writeFileSync(registry(), good);
  // Durable re-validation: the existing notice must be the courier's, to the sender, with the line.
  expect(notifySenderOnEscalate(ctx(), { ...base, id: "n4", outcome: "unconfirmed", durableId: "n4-delivery-unconfirmed" })).toBe(true);
  writeFileSync(join(home, "payloads", "n4-delivery-unconfirmed.md"), "---\nfrom: courier\nto: poller\nkind: delivery-failed\n---\nsomething else\n");
  expect(notifySenderOnEscalate(ctx(), { ...base, id: "n4", outcome: "unconfirmed", durableId: "n4-delivery-unconfirmed" })).toBe(false);
  // Bash `[ -e ]`: a DANGLING durable canonical is absent — the notice is published
  // over it as a regular file (the placement's rename replaces the link), not refused.
  rmSync(join(home, "payloads", "n4-delivery-unconfirmed.md"));
  symlinkSync(join(home, "absent"), join(home, "payloads", "n4-delivery-unconfirmed.md"));
  expect(notifySenderOnEscalate(ctx(), { ...base, id: "n4", outcome: "unconfirmed", durableId: "n4-delivery-unconfirmed" })).toBe(true);
  expect(lstatSync(join(home, "payloads", "n4-delivery-unconfirmed.md")).isSymbolicLink()).toBe(false);
  expect(readFileSync(join(home, "payloads", "n4-delivery-unconfirmed.md"), "utf8")).toContain("DELIVERY UNCONFIRMED: n4 to peer may or may not have reached them.");
  // A missing target binding uses the acting registry; an unresolvable acting registry falls back to the bound one.
  expect(notifySenderOnEscalate(ctx(), { ...base, targetRegistry: "", outcome: "failed" })).toBe(true);
  expect(notifySenderOnEscalate(ctx({ actingRegistry: "" }), { ...base, outcome: "failed" })).toBe(true);
  expect(submits.length).toBe(2);
  // A confirmed or queued wake is a wake; anything else is not.
  submitResult = { status: "harness_queued" };
  expect(notifySenderOnEscalate(ctx(), { ...base, outcome: "failed" })).toBe(true);
  submitResult = { status: "band_busy", detail: "busy" };
  expect(notifySenderOnEscalate(ctx(), { ...base, outcome: "failed" })).toBe(false);
  // Settled members suppress; a lock-park notice carries the queued body.
  writeFileSync(join(home, "receipts", "n1.done"), "{}");
  expect(notifySenderOnEscalate(ctx(), { ...base, outcome: "possible" })).toBe(true);
  expect(notices().filter((f) => f.includes("courier-")).length).toBe(4);
  rmSync(join(home, "receipts", "n1.done"));
  submitResult = { status: "injected" };
  expect(notifySenderOnEscalate(ctx(), { ...base, outcome: "lock-park", detail: "holder=x" })).toBe(true);
  const lockNotice = readFileSync(join(home, "payloads", `${submits[submits.length - 1]!.id}.md`), "utf8");
  expect(lockNotice).toContain("DELIVERY QUEUED: n1 to peer is waiting for the pane submit lock.\n\nDetail: holder=x\n");
});

test("noticeBody (notice.ts, the one prose source) reproduces the incumbent's bytes per mode", async () => {
  const canon = "/bus/payloads/x.md";
  expect(noticeBody("failed", "x", "peer", canon, "", "n")).toBe(
    "DELIVERY FAILED: x to peer was not delivered before its deadline.\n\nThe payload is intact:\n  /bus/payloads/x.md\n\n" +
    "Detail: deadline reached while the recipient pane stayed busy\n\nThis is not a queued send still on its way — the courier stopped trying.\n" +
    "If it is still unread, tap resend x rings it again under the same id. It will not arrive on its own.\n");
  expect(noticeBody("unconfirmed-digest", "x", "peer", canon, "d", "dg-alice-delivery-unconfirmed")).toContain(
    "DELIVERY UNCONFIRMED: digest members to peer have unconfirmed delivery.\nDigest notice: dg-alice-delivery-unconfirmed\n\n");
  // A digest doorbell has no payload of its own: the hint names member ids, never the digest id.
  expect(noticeBody("unconfirmed-digest", "dg-x", "peer", canon, "d", "n")).toContain("tap resend <member-id> rings a member again under its own id");
  expect(noticeBody("unconfirmed-digest", "dg-x", "peer", canon, "d", "n")).not.toContain("tap resend dg-x");
  expect(noticeBody("unrouted", "x", "peer", canon, "d", "n")).toContain("NOT DELIVERED: x to peer was never attempted.\n\n");
  expect(noticeBody("lock-park", "x", "peer", canon, "d", "n")).toBe(
    "DELIVERY QUEUED: x to peer is waiting for the pane submit lock.\n\nDetail: d\n\n" +
    "The lock refused this submit before pane input. The payload remains in courier custody; its existing delivery policy determines retry or disposition.\n" +
    "Inspect its current receipts with tap show x; do not resend solely because of this notice.\n\n");
  expect(() => noticeBody("sender_gone", "x", "peer", canon, "d", "n")).toThrow();
});

// --- the CLI door -------------------------------------------------------------------------------

test("the CLI answers every decided verdict at exit 0 and refuses a malformed row or alert", async () => {
  seed("c1", {});
  const prefix = [home, join(home, "spool"), join(home, "registry-events.log"), "fixture", "tap test", registry(), join(home, "scripts"), "none", "", "", "100", "1800"];
  const fields = (r: DeadlineRow) => ROW_FIELDS.map((k) => r[k]);
  const run = (args: string[]) => {
    const proc = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/spool-deadline.ts"), ...args]);
    return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
  };
  expect(run([...prefix, "at-deadline", "gone", ...fields(row("c1"))])).toEqual({ code: 0, out: "not-due\n", err: "" });
  expect(run([...prefix, "grace-due", ...fields(row("c1"))])).toEqual({ code: 0, out: "not-grace\n", err: "" });
  expect(run([...prefix, "unrouted", ...fields(row("c1"))])).toEqual({ code: 0, out: "routable\n", err: "" });
  expect(run([...prefix, "grace-attempted", "c1"])).toEqual({ code: 0, out: "no\n", err: "" });
  expect(run([...prefix, "recipient-present", "gone"])).toEqual({ code: 0, out: "absent\n", err: "" });
  expect(run([...prefix, "recipient-present", "busy:modal"])).toEqual({ code: 0, out: "present\n", err: "" });
  expect(run([...prefix, "terminalize", "c1", "peer", "sess:0.0", "settled", "spool_terminal_settled"])).toEqual({ code: 0, out: "ok\n", err: "" });
  expect(run([...prefix, "terminalize", "c9", "peer", "sess:0.0"])).toEqual({ code: 0, out: "failed\n", err: "" });
  const notify = run([...prefix, "notify", "c1", "peer", "d", registry(), "unknown"]);
  expect(notify.code).toBe(2);
  expect(notify.err).toContain("unknown notice outcome: unknown");
  expect(run([...prefix, "at-deadline", "gone", "c1"]).code).toBe(2);
  expect(run([...prefix.slice(0, 7), "arm", "", "", "100", "1800", "grace-due", ...fields(row("c1"))]).code).toBe(2);
  expect(run([...prefix.slice(0, 10), "soon", "1800", "grace-due", ...fields(row("c1"))]).code).toBe(2);
});


test("gone-sender authority holds corrupt, old, cross-team and unobservable registries", async () => {
  const current = JSON.stringify({ schema: "0.20", team: { name: "fixture" }, seats: {} });
  const invalid: Array<string | Buffer> = ["{", Buffer.from([0xff]),
    '{"schema":"0.20","team":{"name":"fixture"},"seats":{},"n":1.5}',
    '{"schema":"0.19","team":{"name":"fixture"},"seats":{}}',
    '{"schema":"0.20","team":{"name":"fixture"},"agents":{}}',
    '{"schema":"0.20","team":{"name":"other"},"seats":{}}'];
  const fallback = join(home, "fallback.json");
  writeFileSync(fallback, current);
  for (const [i, raw] of invalid.entries()) {
    const id = `invalid-${i}`, at = new Date(1000_000).toISOString();
    seed(id, { escalated_at: at });
    writeFileSync(registry(), raw);
    expect(await disposeSenderGone(ctx({ now: 2800 }), row(id, { escalatedAt: at, targetRegistry: fallback }))).toBe(false);
    expect(existsSync(join(home, "spool", `${id}.md`))).toBe(true);
  }
  const at = new Date(1000_000).toISOString();
  seed("fallback", { escalated_at: at });
  const c = ctx({ now: 2800, actingRegistry: join(home, "missing.json") });
  const r = row("fallback", { escalatedAt: at, targetRegistry: fallback });
  writeFileSync(fallback, '{"schema":"0.20","team":{"name":"other"},"seats":{}}');
  expect(await disposeSenderGone(c, r)).toBe(false);
  r.targetRegistry = c.actingRegistry;
  expect(await disposeSenderGone(c, r)).toBe(false);
  r.targetRegistry = fallback;
  writeFileSync(fallback, current);
  expect(await disposeSenderGone(c, r)).toBe(true);
  expect(events().match(/spool_sender_unobservable/g)).toHaveLength(invalid.length + 2);
  expect(submits).toEqual([]);
});

test("reserved senders are not departed seats after escalation grace", async () => {
  writeFileSync(registry(), '{"schema":"0.20","team":{"name":"fixture"},"seats":{}}');
  const at = new Date(1000_000).toISOString();
  const c = ctx({ now: 2800, env: { ...process.env, TAP_WATCH_IDENTITY: "sentinel", TAP_RESERVED_HANDLES: "service helper" } });
  for (const sender of ["watcher", "courier", "help", "sentinel", "service", "helper"]) {
    const id = `reserved-${sender}`;
    seed(id, { escalated_at: at, deadline_source: "autosettle-hold" }, sender);
    expect(await disposeSenderGone(c, row(id, { escalatedAt: at }))).toBe(false);
    expect(existsSync(join(home, "spool", `${id}.md`))).toBe(true);
    expect(existsSync(join(home, "spool", `${id}.meta.json`))).toBe(true);
    expect(existsSync(join(home, "payloads", `${id}.md`))).toBe(false);
    expect(existsSync(join(home, "receipts", `${id}.cancelled`))).toBe(false);
  }
  // Reservation is exact: an ordinary departed seat still retires.
  seed("ordinary", { escalated_at: at }, "watcher-helper");
  expect(await disposeSenderGone(c, row("ordinary", { escalatedAt: at }))).toBe(true);
  expect(submits).toEqual([]);
});

test("an escalated operator note retires past the grace with a cancel receipt, never stranded", async () => {
  // A same-team registry that could never hold the operator: presence is not consulted.
  writeFileSync(registry(), '{"schema":"0.20","team":{"name":"fixture"},"seats":{}}');
  const at = new Date(1000_000).toISOString();
  seed("operator-early", { escalated_at: at }, "user");
  expect(await disposeSenderGone(ctx({ now: 1001 }), row("operator-early", { escalatedAt: at }))).toBe(false);
  expect(existsSync(join(home, "spool", "operator-early.md"))).toBe(true);
  seed("operator", { escalated_at: at }, "user");
  expect(await disposeSenderGone(ctx({ now: 2800 }), row("operator", { escalatedAt: at }))).toBe(true);
  expect(existsSync(join(home, "spool", "operator.md"))).toBe(false);
  expect(existsSync(join(home, "payloads", "operator.md"))).toBe(true);
  expect(readFileSync(join(home, "receipts", "operator.cancelled"), "utf8")).toContain("operator_undeliverable");
  expect(events()).toContain("spool_terminal_operator_undeliverable");
  expect(submits).toEqual([]);
});

test("a legacy seat named user keeps its mail: no operator retirement, no synthesized cancel", async () => {
  const doc = JSON.parse(readFileSync(registry(), "utf8"));
  doc.seats.user = { status: "active", pane: "sess:0.5", pane_id: "%405", harness: "codex" };
  writeFileSync(registry(), JSON.stringify(doc));
  const at = new Date(1000_000).toISOString();
  seed("legacy", { escalated_at: at }, "user");
  expect(await disposeSenderGone(ctx({ now: 2800 }), row("legacy", { escalatedAt: at }))).toBe(false);
  expect(existsSync(join(home, "spool", "legacy.md"))).toBe(true);
  expect(await terminalize(ctx(), "legacy", "peer", "sess:0.0", "deadline_reached")).toBe(true);
  expect(existsSync(join(home, "receipts", "legacy.cancelled"))).toBe(false);
});

test("an operator note whose cancel receipt cannot be written keeps its spool entry", async () => {
  const at = new Date(1000_000).toISOString();
  seed("op-norcpt", { escalated_at: at }, "user");
  rmSync(join(home, "receipts"), { recursive: true, force: true });
  writeFileSync(join(home, "receipts"), "not a directory");
  expect(await disposeSenderGone(ctx({ now: 2800 }), row("op-norcpt", { escalatedAt: at }))).toBe(false);
  expect(existsSync(join(home, "spool", "op-norcpt.md"))).toBe(true);
  expect(existsSync(join(home, "spool", "op-norcpt.meta.json"))).toBe(true);
  // An unreadable registry cannot tell operator mail from a legacy seat's: it holds too.
  rmSync(join(home, "receipts"), { force: true });
  mkdirSync(join(home, "receipts"));
  expect(await terminalize(ctx({ actingRegistry: join(home, "missing.json") }), "op-norcpt", "peer", "sess:0.0", "deadline_reached")).toBe(false);
  expect(existsSync(join(home, "spool", "op-norcpt.md"))).toBe(true);
  expect(await terminalize(ctx(), "op-norcpt", "peer", "sess:0.0", "deadline_reached")).toBe(true);
  expect(readFileSync(join(home, "receipts", "op-norcpt.cancelled"), "utf8")).toContain("deadline_reached");
});

test("fresh escalation gets a full return window; autosettle and bad clocks keep their semantics", async () => {
  writeFileSync(registry(), '{"schema":"0.20","team":{"name":"fixture"},"seats":{}}');
  seed("fresh", { deadline_source: "autosettle-hold" });
  const c = ctx({ wall: () => new Date(1000_000) });
  const r = row("fresh", { deadlineSource: "autosettle-hold" });
  expect(await disposeAtDeadline(c, r, "gone")).toBe("escalated");
  r.escalatedAt = String(meta("fresh").escalated_at);
  c.now = 2799;
  expect(await disposeSenderGone(c, r)).toBe(false);
  writeFileSync(registry(), '{"schema":"0.20","team":{"name":"fixture"},"seats":{"alice":null}}');
  c.now = 2800;
  expect(await disposeSenderGone(c, r)).toBe(false);
  writeFileSync(registry(), '{"schema":"0.20","team":{"name":"fixture"},"seats":{}}');
  expect(await disposeSenderGone(c, r)).toBe(true);
  expect(JSON.parse(readFileSync(join(home, "receipts/fresh.cancelled"), "utf8")).reason).toBe("sender_gone");
  for (const [i, at] of ["", "invalid"].entries()) {
    seed(`bad-${i}`, { escalated_at: at });
    expect(await disposeSenderGone(c, row(`bad-${i}`, { escalatedAt: "stale-snapshot" }))).toBe(false);
  }
  expect(submits).toEqual([]);
  expect(notices()).toEqual([]);
});
