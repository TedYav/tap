// tap-w85su: nudge requeues an escalated copy-mode park only on positive proof of no
// effect, the same recipient, and a pane that has left copy mode; anything else holds.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CopyModeObservation } from "../src/pane-state";
import { copyModeCancelLicense, requeueCopyModeParks, type RequeueInput } from "../src/spool-requeue";

let home = "";
let spawned: string[] = [];
const NORMAL: CopyModeObservation = { status: "normal" };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "spool-requeue-"));
  for (const dir of ["spool", "receipts", "payloads", "archive"]) mkdirSync(join(home, dir), { recursive: true });
  writeRegistry("i-peer");
  spawned = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const registry = (name = "registry.json") => join(home, name);
function writeRegistry(instance: string, name = "registry.json", paneId = "%401"): void {
  writeFileSync(registry(name), JSON.stringify({ schema: "0.20", team: { name: "fixture" },
    seats: { peer: { status: "active", pane: "sess:0.0", pane_id: paneId, harness: "codex", instance, server_epoch: "srv:1:2" } } }));
}

function park(id: string, over: { meta?: Record<string, unknown>; fields?: Record<string, string>; registryName?: string } = {}): void {
  const fields = { id, from: "alice", to: "peer", to_team: "fixture", recipient_instance: "i-peer", kind: "discuss", ...over.fields };
  const header = Object.entries(fields).filter(([, v]) => v !== "").map(([k, v]) => `${k}: ${v}\n`).join("");
  writeFileSync(join(home, "spool", `${id}.md`), `---\n${header}---\nbody of ${id}\n`);
  writeFileSync(join(home, "spool", `${id}.meta.json`), `${JSON.stringify({
    id, target: "peer", reason: "copy-mode", reason_class: "safety_gate", policy: "notify-and-hold", first_spooled_epoch: 1,
    hold_until_epoch: 1, deadline_epoch: 301, waiter_lifetime: "window", pane: "sess:0.0", pane_id: "%401", to_team: "fixture",
    target_registry: registry(over.registryName), attempts: 0, attempt_fence: 1, escalated_at: "2026-10-01T09:00:00Z",
    human_escalated_at: "2026-10-01T09:00:01Z", ...over.meta,
  }, null, 2)}\n`);
}

const meta = (id: string) => JSON.parse(readFileSync(join(home, "spool", `${id}.meta.json`), "utf8"));
const events = () => { try { return readFileSync(join(home, "registry-events.log"), "utf8"); } catch { return ""; } };

function run(over: Partial<RequeueInput> = {}) {
  return requeueCopyModeParks({
    home, team: "fixture", recipientTeam: "fixture", target: "peer", registry: registry(), paneId: "%401", scriptsDir: join(home, "scripts"),
    observeMode: () => NORMAL, authorizePane: () => "", now: () => 5000, env: { ...process.env, TAP_SPOOL_BUSY_DEADLINE_SECONDS: "300" },
    spawn: input => { spawned.push(input.id); return true; },
    ...over,
  });
}

test("an escalated copy-mode park on a pane that left copy mode is requeued to the ordinary deliverer", () => {
  park("p1");
  const result = run();
  expect(result).toEqual({ requeued: [{ id: "p1", deliverer: "started" }], held: [] });
  const m = meta("p1");
  expect(m.escalated_at).toBeUndefined();
  expect(m.human_escalated_at).toBeUndefined();
  expect(m.hold_until_epoch).toBe(5000);
  expect(m.deadline_epoch).toBe(5300);
  expect(m.attempts).toBe(0);
  expect(spawned).toEqual(["p1"]);
  expect(events()).toContain("spool_requeued_copy_mode");
  expect(events()).toContain("id=p1");
  // Idempotent: the entry is no longer escalated, so a second nudge finds nothing.
  expect(run()).toEqual({ requeued: [], held: [] });
});

test("a pane still in copy mode, or one whose mode cannot be read, holds the park untouched", () => {
  park("p2");
  for (const [mode, why] of [
    [{ status: "copy-mode" }, "pane is still in copy mode"],
    [{ status: "unobservable", reason: "x" }, "copy mode is unreadable (unobservable)"],
    [{ status: "rate-limited", reason: "x" }, "copy mode is unreadable (rate-limited)"],
    [{ status: "gone" }, "copy mode is unreadable (gone)"],
  ] as const) {
    expect(run({ observeMode: () => mode as CopyModeObservation })).toEqual({ requeued: [], held: [{ id: "p2", why }] });
    expect(meta("p2").escalated_at).toBe("2026-10-01T09:00:00Z");
  }
  expect(spawned).toEqual([]);
});

test("any attempt, delivery, read, settlement or resend evidence holds: a possible effect is never retried", () => {
  // A cancel that did not take writes .attempted before parking copy-mode.
  for (const [suffix, dir] of [["attempted", "receipts"], ["idle-submit", "receipts"], ["unconfirmed", "receipts"], ["sent", "receipts"],
    ["read", "receipts"], ["harness-queued", "receipts"], ["done", "receipts"], ["cancelled", "receipts"], ["resent", "receipts"],
    ["attempts", "spool"]] as const) {
    const id = `e-${suffix}`;
    park(id);
    writeFileSync(join(home, dir, `${id}.${suffix}`), "{}");
    expect(run().held).toContainEqual({ id, why: `.${suffix} evidence exists` });
    expect(meta(id).escalated_at).toBe("2026-10-01T09:00:00Z");
  }
  expect(spawned).toEqual([]);
});

test("no effect needs zero attempts behind a modern fence; a legacy zero counter holds", () => {
  park("a1", { meta: { attempts: 1 } });
  park("a2", { meta: { attempt_fence: undefined } });
  park("a3", { meta: { attempts: "0" } });
  const held = run().held;
  expect(held).toContainEqual({ id: "a1", why: "the entry records a delivery attempt" });
  expect(held).toContainEqual({ id: "a2", why: "no pre-attempt fence; no effect cannot be proved" });
  expect(held).toContainEqual({ id: "a3", why: "attempt count is missing or malformed" });
  expect(spawned).toEqual([]);
});

test("the recipient must be the same seat instance on the same pane", () => {
  park("r1", { fields: { recipient_instance: "" } });
  park("r2", { fields: { to: "someone-else" } });
  park("r3", { meta: { pane_id: "%999" } });
  const first = run().held;
  expect(first).toContainEqual({ id: "r1", why: "payload carries no recipient instance to prove the seat" });
  expect(first).toContainEqual({ id: "r3", why: "recorded for a different pane" });
  // r2's payload names another seat; its meta still scopes it to peer.
  expect(first).toContainEqual({ id: "r2", why: "payload names a different recipient" });
  park("r4");
  writeRegistry("i-peer-relaunched");
  expect(run().held).toContainEqual({ id: "r4", why: "the seat has a new instance since the park" });
  expect(spawned).toEqual([]);
});

test("a held claim or obligation is another process's custody: the park holds", () => {
  park("c1");
  writeFileSync(join(home, "spool", "c1.claim"), "{}\n");
  expect(run().held).toEqual([{ id: "c1", why: "another process holds the entry" }]);
  expect(meta("c1").escalated_at).toBe("2026-10-01T09:00:00Z");
});

test("a settlement that lands while the pane is read holds the park: the proofs are read last, under custody", () => {
  park("s1");
  const settleDuringRead = () => { writeFileSync(join(home, "receipts", "s1.done"), "{}"); return NORMAL; };
  expect(run({ observeMode: settleDuringRead }).held).toEqual([{ id: "s1", why: ".done evidence exists" }]);
  expect(meta("s1").escalated_at).toBe("2026-10-01T09:00:00Z");
  expect(spawned).toEqual([]);
});

test("only this target on this registry is touched: a same-handle seat on another registry keeps its park", () => {
  writeRegistry("i-peer", "other-registry.json");
  park("o1", { registryName: "other-registry.json" });
  park("o2");
  expect(run().requeued.map(r => r.id)).toEqual(["o2"]);
  expect(meta("o1").escalated_at).toBe("2026-10-01T09:00:00Z");
});

test("other parks are not this recovery's: busy, unescalated or non-copy-mode entries are never listed", () => {
  park("n1", { meta: { escalated_at: "" } });
  park("n2", { meta: { reason: "pending-input", reason_class: "busy" } });
  expect(run()).toEqual({ requeued: [], held: [] });
  expect(existsSync(join(home, "registry-events.log"))).toBe(false);
});

test("a live deliverer keeps the entry: requeue starts a second one only when it is granted the lease", () => {
  park("l1");
  writeFileSync(join(home, "spool", "l1.reown"), `${JSON.stringify({ token: "0000000000000001", at: Date.now() / 1000 })}\n`);
  const result = run();
  expect(result.requeued.map(r => r.id)).toEqual(["l1"]);
  expect(result.requeued[0]!.deliverer === "running").toBe(spawned.length === 0);
});

test("a cross-team park recovers: the payload is checked against the target's team, not the source bus's", () => {
  park("x1");
  expect(run({ team: "alpha" }).requeued.map(r => r.id)).toEqual(["x1"]);
  park("x2");
  expect(run({ team: "alpha", recipientTeam: "beta" }).held).toEqual([{ id: "x2", why: "recorded for a different recipient team" }]);
  park("x3", { meta: { to_team: "" } });
  expect(run({ recipientTeam: "beta" }).held).toContainEqual({ id: "x3", why: "payload names a different recipient team" });
});

test("a seat rebound to another pane while the mode is read holds: the row is re-read at the write", () => {
  park("b1");
  const rebind = () => { writeRegistry("i-peer", "registry.json", "%999"); return NORMAL; };
  expect(run({ observeMode: rebind }).held).toEqual([{ id: "b1", why: "the seat is now bound to a different pane" }]);
  expect(meta("b1").escalated_at).toBe("2026-10-01T09:00:00Z");
  expect(spawned).toEqual([]);
});

test("the live pane must pass the bound-identity guard with the seat's current generation and harness", () => {
  park("g1");
  const seen: unknown[] = [];
  const held = run({ authorizePane: bound => { seen.push(bound); return "the pane reports server generation srv:9:9, not the bound srv:1:2"; } }).held;
  expect(held).toEqual([{ id: "g1", why: "the pane does not prove to be the seat (the pane reports server generation srv:9:9, not the bound srv:1:2)" }]);
  expect(seen).toEqual([{ handle: "peer", paneId: "%401", serverEpoch: "srv:1:2", harness: "codex", bootId: "", instance: "i-peer" }]);
  expect(meta("g1").escalated_at).toBe("2026-10-01T09:00:00Z");
  writeFileSync(registry(), JSON.stringify({ schema: "0.20", team: { name: "fixture" }, seats: { peer: { status: "active", status_reason: "launching",
    pane: "sess:0.0", pane_id: "%401", harness: "codex", instance: "i-peer" } } }));
  expect(run().held).toEqual([{ id: "g1", why: "the seat is no longer an active pane seat" }]);
  expect(spawned).toEqual([]);
});

test("a deliverer that cannot start puts the escalation back, so the next nudge can retry", () => {
  park("f1");
  const result = run({ spawn: () => false });
  expect(result).toEqual({ requeued: [], held: [{ id: "f1", why: "the deliverer could not start; the park stays escalated for the next nudge" }] });
  expect(meta("f1").escalated_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  expect(run().requeued.map(r => r.id)).toEqual(["f1"]);
});

test("a native intent whose presence cannot be proved absent holds", () => {
  park("n3");
  symlinkSync(join(home, "missing-target"), join(home, "spool", "n3.json"));
  expect(run().held).toEqual([{ id: "n3", why: "a native intent owns its own delivery evidence" }]);
  expect(spawned).toEqual([]);
});

// tap-zvuc9: the parks that license nudge's no-client copy-mode cancel are exactly
// those requeue would take but for copy mode, read without writing anything.
test("only a park that would requeue but for copy mode licenses the cancel, and reading it writes nothing", () => {
  const input = { home, team: "fixture", recipientTeam: "fixture", target: "peer", registry: registry(), paneId: "%401",
    scriptsDir: join(home, "scripts"), observeMode: () => ({ status: "copy-mode" }) as CopyModeObservation, authorizePane: () => "" };
  park("p1");
  park("p2");
  writeFileSync(join(home, "receipts", "p2.attempted"), "");
  park("p3", { meta: { pane_id: "%999" } });
  park("p4", { fields: { recipient_instance: "i-old" } });
  park("p5", { meta: { escalated_at: "" } });
  const before = meta("p1");
  expect(copyModeCancelLicense(input)).toEqual(["p1"]);
  expect(copyModeCancelLicense({ ...input, authorizePane: () => "pane drifted" })).toEqual([]);
  expect(meta("p1")).toEqual(before);
  expect(events()).toBe("");
});
