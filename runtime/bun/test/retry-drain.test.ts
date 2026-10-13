// Same-id retry at the drain (delivery decision-v1): a retry row rings under its
// own license with a `retry` wire, never inherits an interrupt, rechecks
// observation under the obligation lock, and never joins a digest.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PaneEffects } from "../src/deliver";
import { reparkLicensed } from "../src/delivery-custody";
import { recipientState, recordAuthorizedRead } from "../src/harness-queue";
import { retryMarkerPath, retryRecords, spentRetryRow } from "../src/retry";
import { drainOnce, type DrainContext, type DrainEffects, type SpoolBinding } from "../src/spool-drain";
import { redeliver } from "../src/spool-drain-effects";
import { installSpoolPane } from "./support/spool-pane";
import { acquirePathLock } from "../src/panelock";
import { retryRepark } from "../src/spool-repark";

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const RETRY = "0b4a5f0e-6d2c-4c1e-9a3b-2f6e8d7c1a90";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "retry-drain-")); roots.push(root);
  const home = join(root, ".tap", "bus"); mkdirSync(home, { recursive: true });
  const scriptsDir = join(home, "scripts"), spoolDir = join(home, "spool");
  for (const path of [scriptsDir, spoolDir, join(home, "payloads"), join(home, "receipts")]) mkdirSync(path);
  const registry = join(home, "registry.json");
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture" }, seats: {} }));
  writeFileSync(join(home, ".tap-bus-authority"), "");
  const env = { ...process.env, TAP_HOME: home, TAP_INDEX_HOME: join(home, "index"), TAP_SPOOL_DISABLE_DELIVERER: "1" };
  installSpoolPane(home, registry, env).writeSeat({ boot_id: "" });
  const ctx: DrainContext = { home, scriptsDir, spoolDir, payloadsDir: join(home, "payloads"), receiptsDir: join(home, "receipts"),
    eventLog: join(home, "registry-events.log"), actingRegistry: registry, team: "fixture", verbLabel: "tap", courierIdentity: "courier",
    alert: { mode: "none" }, now: 100, unroutedGrace: 1800, env };
  const binding: SpoolBinding = { target: "peer", targetRegistry: registry, toTeam: "fixture", pane: "fixture:0.0", paneId: "%401" };
  // A retry row: the original was attempted (and may have reached the pane); the canonical is re-parked.
  const parkRetry = (id: string, urgency = "") => {
    writeFileSync(join(spoolDir, `${id}.md`), `---\nid: ${id}\nfrom: sender\nto: peer\nkind: discuss\nreply: expected\n${urgency ? `urgency: ${urgency}\n` : ""}---\nbody ${id}\n`);
    writeFileSync(join(spoolDir, `${id}.meta.json`), JSON.stringify({ id, target: "peer", pane: binding.pane, pane_id: binding.paneId,
      target_registry: binding.targetRegistry, to_team: binding.toTeam, policy: "standard", reason: "retry", retry: RETRY, retry_ordinal: 1,
      first_spooled_epoch: 1, deadline_epoch: 9999999999 }));
    writeFileSync(join(home, "receipts", `${id}.attempted`), '{"id":"' + id + '","effect":"possible"}\n');
    writeFileSync(join(home, "receipts", `${id}.sent`), "original transport receipt\n");
    const old = new Date(Date.now() - 10_000);
    utimesSync(join(home, "receipts", `${id}.sent`), old, old);
  };
  const typedWires: string[] = [], keys: string[][] = [];
  let typed = "";
  const fx: PaneEffects = {
    observePane: () => ({ paneId: "%401", session: "fixture", serverEpoch: "srv:123:456", currentCommand: "codex", panePid: "4242" }),
    harnessEvidence: () => "alive", copyMode: () => ({ status: "normal" }),
    paneState: () => typed ? { state: "busy", text: typed } : { state: "ready" },
    injectText: (_, text) => { typedWires.push(text); typed = text; return true; },
    inputHasId: (_, __, id) => typed.includes(id), pressEnter: () => { typed = ""; return true; }, settle: () => {},
    pressKeys: (_, k) => { keys.push(k); return true; },
    clearInput: () => { typed = ""; return true; }, backspace: () => { typed = ""; return true; },
    restoreInput: (_, value) => { typed = value; return true; },
    submitFrame: () => ({ state: typed ? "staged" : "empty", mode: "idle", width: "80" }),
    captureEscaped: () => ({ ok: true, frame: `› ${typed}\n\n  gpt-6-astra medium · Context 99% left\n` }),
    paneTitle: () => ({ ok: true, title: "codex" }),
  };
  return { ctx, binding, parkRetry, fx, typedWires, keys, home };
}

test("a retry row rings once under its own license, keeps the original receipts and records its outcome", async () => {
  const f = fixture(); f.parkRetry("a");
  const original = readFileSync(join(f.home, "receipts/a.attempted"), "utf8");
  expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(0);
  expect(f.typedWires).toHaveLength(1);
  expect(f.typedWires[0]).toMatch(/^\[\[TAP v0\.23 ask a retry\]\]$/);
  expect(existsSync(retryMarkerPath(f.home, "a", RETRY))).toBe(true);
  // The license carries its admission evidence (L10): the bound recipient and the checked observation.
  expect(JSON.parse(readFileSync(retryMarkerPath(f.home, "a", RETRY), "utf8"))).toMatchObject({
    id: "a", retry: RETRY, effect: "possible", target: "peer", pane: f.binding.pane, pane_id: f.binding.paneId, prior_state: "unobserved" });
  expect(JSON.parse(readFileSync(retryMarkerPath(f.home, "a", RETRY), "utf8")).admitted_at).toMatch(/^\d{4}-\d\d-\d\dT/);
  expect(readFileSync(join(f.home, "receipts/a.attempted"), "utf8")).toBe(original);
  expect(readFileSync(join(f.home, "receipts/a.sent"), "utf8")).toBe("original transport receipt\n");
  expect(retryRecords(f.home, "a").map(r => [r.event, r.retry, r.outcome])).toEqual([["outcome", RETRY, "submission-confirmed"]]);
  const phases = readFileSync(join(f.home, "receipts/a.submit-phases.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(phases.length).toBeGreaterThan(0);
  expect(new Set(phases.map(row => row.attempt))).toEqual(new Set([RETRY]));
  expect(existsSync(join(f.ctx.spoolDir, "a.meta.json"))).toBe(false);
});

test("a spent license never rings again: the row retires as unknown and the canonical goes home", async () => {
  const f = fixture(); f.parkRetry("a");
  writeFileSync(retryMarkerPath(f.home, "a", RETRY), "{}\n");
  await redeliver(f.ctx, "a", f.binding, {}, f.fx);
  expect(f.typedWires).toEqual([]);
  expect(existsSync(join(f.ctx.spoolDir, "a.meta.json"))).toBe(false);
  expect(existsSync(join(f.ctx.spoolDir, "a.md"))).toBe(false);
  expect(readFileSync(join(f.home, "payloads", "a.md"), "utf8")).toContain("body a");
  expect(retryRecords(f.home, "a").map(r => [r.event, r.retry, r.outcome])).toEqual([["outcome", RETRY, "unknown"]]);
  // A second pass finds no row and records nothing more.
  await redeliver(f.ctx, "a", f.binding, {}, f.fx);
  expect(retryRecords(f.home, "a")).toHaveLength(1);
});

test("an unverified retry holds, submits once with its idle license, and only then records its outcome", async () => {
  const f = fixture(); f.parkRetry("a");
  const submit = f.fx.pressEnter;
  f.fx.pressEnter = () => true; // the wire stays staged after the attempted submit
  expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(0);
  expect(f.typedWires).toEqual(["[[TAP v0.23 ask a retry]]"]);
  expect(JSON.parse(readFileSync(join(f.ctx.spoolDir, "a.meta.json"), "utf8"))).toMatchObject({ reason: "staged-idle", retry: RETRY });
  expect(readFileSync(join(f.ctx.spoolDir, "a.md"), "utf8")).toContain("body a");
  expect(retryRecords(f.home, "a")).toEqual([]);
  let idleEnters = 0;
  f.fx.pressEnter = (...args) => { idleEnters++; return submit(...args); };
  expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(0);
  expect(idleEnters).toBe(1);
  expect(existsSync(join(f.home, "receipts", `a.retry-${RETRY}.idle-submit`))).toBe(true);
  expect(existsSync(join(f.ctx.spoolDir, "a.meta.json"))).toBe(false);
  expect(retryRecords(f.home, "a").map(r => r.outcome)).toEqual(["submission-confirmed"]);
  await redeliver(f.ctx, "a", f.binding, {}, f.fx);
  expect(idleEnters).toBe(1);
  expect(f.typedWires).toHaveLength(1);
});

test("a retry whose fresh idle hold cannot acquire custody records unverified and keeps its body canonical", async () => {
  const f = fixture(); f.parkRetry("a");
  const held: { lock: ReturnType<typeof acquirePathLock> } = { lock: null };
  f.fx.pressEnter = () => {
    held.lock ??= acquirePathLock(join(f.ctx.spoolDir, "a.meta.json.lock"), 0, f.ctx.env);
    return true;
  };
  try { expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(5); }
  finally { held.lock?.release(); }
  expect(held.lock).not.toBeNull();
  expect(existsSync(join(f.ctx.spoolDir, "a.meta.json"))).toBe(true);
  expect(readFileSync(join(f.ctx.payloadsDir, "a.md"), "utf8")).toContain("body a");
  expect(retryRecords(f.home, "a").map(r => r.outcome)).toEqual(["unverified"]);
  expect(retryRepark(f.home, "a", f.ctx.env)).toBe("settled");
  expect(existsSync(join(f.ctx.spoolDir, "a.md"))).toBe(false);
});

test("verified idle Enter with fenced cleanup cannot repark or overwrite the retry outcome", async () => {
  const f = fixture(); f.parkRetry("a");
  const submit = f.fx.pressEnter;
  f.fx.pressEnter = () => true;
  expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(0);
  let idleEnters = 0;
  f.fx.pressEnter = (...args) => {
    idleEnters++;
    const result = submit(...args);
    writeFileSync(join(f.home, "reset.fence.json"), "{}");
    return result;
  };
  expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(0);
  expect(retryRecords(f.home, "a").map(r => r.outcome)).toEqual(["submission-confirmed"]);
  rmSync(join(f.home, "reset.fence.json"));
  expect(reparkLicensed(f.home, "a", f.ctx.env)).toBe(false);
  expect(retryRepark(f.home, "a", f.ctx.env)).toBe("settled");
  expect(existsSync(join(f.ctx.spoolDir, "a.md"))).toBe(false);
  expect(spentRetryRow(f.home, f.ctx.spoolDir, "a")).toEqual({ retry: RETRY, ordinal: 1 });
  // Even a surviving spool copy cannot turn the successful outcome into unverified.
  writeFileSync(join(f.ctx.spoolDir, "a.md"), readFileSync(join(f.ctx.payloadsDir, "a.md")));
  await redeliver(f.ctx, "a", f.binding, {}, f.fx);
  expect(retryRecords(f.home, "a").map(r => r.outcome)).toEqual(["submission-confirmed"]);
  expect(idleEnters).toBe(1);
  expect(f.typedWires).toHaveLength(1);
});

test("a retry hold expires without another injection or an idle Enter", async () => {
  const f = fixture(); f.parkRetry("a");
  let enters = 0;
  f.fx.pressEnter = () => { enters++; return true; };
  expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(0);
  const firstEnters = enters;
  const path = join(f.ctx.spoolDir, "a.meta.json"), meta = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...meta, deadline_epoch: 1 }));
  expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(5);
  expect(enters).toBe(firstEnters);
  expect(f.typedWires).toHaveLength(1);
  expect(retryRecords(f.home, "a").map(r => r.outcome)).toEqual(["unverified"]);
  expect(existsSync(join(f.ctx.spoolDir, "a.meta.json"))).toBe(false);
});

test("a retiring row keeps its body and metadata when the canonical cannot be proven home", async () => {
  // A failed move (payloads/ unwritable) on the spent path, as the review probe reproduced.
  const f = fixture(); f.parkRetry("a");
  writeFileSync(retryMarkerPath(f.home, "a", RETRY), "{}\n");
  chmodSync(join(f.home, "payloads"), 0o500);
  try { expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(1); }
  finally { chmodSync(join(f.home, "payloads"), 0o700); }
  expect(readFileSync(join(f.ctx.spoolDir, "a.md"), "utf8")).toContain("body a");
  expect(existsSync(join(f.ctx.spoolDir, "a.meta.json"))).toBe(true);
  expect(retryRecords(f.home, "a")).toEqual([]);
  expect(f.typedWires).toEqual([]);
  // A conflicting non-file canonical on the suppression path: also kept, nothing recorded.
  const g = fixture(); g.parkRetry("b");
  writeFileSync(join(g.home, "receipts", "b.read"), JSON.stringify({ id: "b", by: "peer", at: "2026-10-12T10:00:00Z" }));
  mkdirSync(join(g.home, "payloads", "b.md"));
  expect(await redeliver(g.ctx, "b", g.binding, {}, g.fx)).toBe(1);
  expect(readFileSync(join(g.ctx.spoolDir, "b.md"), "utf8")).toContain("body b");
  expect(existsSync(join(g.ctx.spoolDir, "b.meta.json"))).toBe(true);
  expect(retryRecords(g.home, "b")).toEqual([]);
});

test("a retry rings only the instance it was sent to: a re-registered handle retires the row with no effect", async () => {
  const f = fixture(); f.parkRetry("a");
  // The handle is now held by a new instance; the message was sent to the old one.
  const doc = JSON.parse(readFileSync(f.ctx.actingRegistry, "utf8"));
  doc.seats.peer.instance = "peer-now";
  writeFileSync(f.ctx.actingRegistry, JSON.stringify(doc));
  const body = readFileSync(join(f.ctx.spoolDir, "a.md"), "utf8").replace("reply: expected\n", "reply: expected\nrecipient_instance: peer-gone\n");
  writeFileSync(join(f.ctx.spoolDir, "a.md"), body);
  await redeliver(f.ctx, "a", f.binding, {}, f.fx);
  expect(f.typedWires).toEqual([]);
  expect(existsSync(join(f.ctx.spoolDir, "a.meta.json"))).toBe(false);
  expect(readFileSync(join(f.home, "payloads", "a.md"), "utf8")).toContain("recipient_instance: peer-gone");
  expect(retryRecords(f.home, "a").map(r => [r.event, r.retry])).toEqual([["suppressed", RETRY]]);
  expect(retryRecords(f.home, "a")[0]!.detail).toContain("recipient instance changed");
});

test("a staged-idle retry hold runs only while its separate Enter license is unspent", () => {
  const f = fixture(); f.parkRetry("a");
  writeFileSync(retryMarkerPath(f.home, "a", RETRY), "{}\n");
  expect(spentRetryRow(f.home, f.ctx.spoolDir, "a")).toEqual({ retry: RETRY, ordinal: 1 });
  const meta = JSON.parse(readFileSync(join(f.ctx.spoolDir, "a.meta.json"), "utf8"));
  writeFileSync(join(f.ctx.spoolDir, "a.meta.json"), JSON.stringify({ ...meta, reason: "staged-idle", repark_pending: true }));
  expect(spentRetryRow(f.home, f.ctx.spoolDir, "a")).toBeNull();
  expect(reparkLicensed(f.home, "a", f.ctx.env)).toBe(true);
  writeFileSync(join(f.home, "receipts", `a.retry-${RETRY}.idle-submit`), "{}");
  expect(spentRetryRow(f.home, f.ctx.spoolDir, "a")).toEqual({ retry: RETRY, ordinal: 1 });
  expect(reparkLicensed(f.home, "a", f.ctx.env)).toBe(false);
});

test("an urgent original re-rings as ordinary delivery: no urgency tag, no interrupt keys", async () => {
  const f = fixture(); f.parkRetry("a", "urgent");
  expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(0);
  expect(f.typedWires).toEqual(["[[TAP v0.23 ask a retry]]"]);
  expect(f.keys.flat()).not.toContain("Escape");
  expect(f.keys.flat()).not.toContain("C-c");
});

for (const [name, receipt, suppressed] of [
  ["an authoritative read", { id: "a", by: "peer", at: "2026-10-12T10:00:00Z" }, true],
  ["a forced read alone", { id: "a", by: "operator", at: "2026-10-12T10:00:00Z", forced: "true" }, false],
] as const) test(`observation rechecked at the drain: ${name} ${suppressed ? "suppresses" : "does not suppress"}`, async () => {
  const f = fixture(); f.parkRetry("a");
  writeFileSync(join(f.home, "receipts/a.read"), JSON.stringify(receipt));
  expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(0);
  if (suppressed) {
    expect(f.typedWires).toEqual([]);
    expect(existsSync(retryMarkerPath(f.home, "a", RETRY))).toBe(false);
    expect(existsSync(join(f.ctx.spoolDir, "a.md"))).toBe(false);
    expect(existsSync(join(f.ctx.spoolDir, "a.meta.json"))).toBe(false);
    expect(readFileSync(join(f.ctx.payloadsDir, "a.md"), "utf8")).toContain("body a");
    expect(retryRecords(f.home, "a").map(r => [r.event, r.retry, r.prior?.state])).toEqual([["suppressed", RETRY, "observed"]]);
  } else {
    expect(f.typedWires).toEqual(["[[TAP v0.23 ask a retry]]"]);
  }
});

test("a genuine read after a confirmed pane send and a forced read is recorded and suppresses a retry", () => {
  const f = fixture();
  writeFileSync(join(f.home, "receipts/a.sent"), JSON.stringify({ id: "a", status: "sent", delivery: "pane" }));
  writeFileSync(join(f.home, "receipts/a.read"), JSON.stringify({ id: "a", by: "operator", forced: "true" }));
  expect(recipientState(f.home, "a").state).toBe("unobserved");
  recordAuthorizedRead(f.home, "a", { by: "peer", at: "2026-10-12T10:00:00Z" });
  expect(recipientState(f.home, "a")).toEqual({ state: "observed", via: "authorized-read", at: "2026-10-12T10:00:00Z" });
});

test("retry repark custody is scoped to the current attempt; ordinary rows keep every receipt", () => {
  const f = fixture(); f.parkRetry("a");
  const meta = join(f.ctx.spoolDir, "a.meta.json"), row = JSON.parse(readFileSync(meta, "utf8"));
  writeFileSync(meta, JSON.stringify({ ...row, repark_pending: true }));
  // Crash after the pre-submit move, before the new license: the original's .sent does not strand it.
  expect(reparkLicensed(f.home, "a", f.ctx.env)).toBe(true);
  // Crash after the new license: a possible effect; never a repark.
  writeFileSync(retryMarkerPath(f.home, "a", RETRY), "{}\n");
  expect(reparkLicensed(f.home, "a", f.ctx.env)).toBe(false);
  // An ordinary (non-retry) row with any delivery receipt is never reparked.
  const { retry: _retry, retry_ordinal: _ordinal, ...ordinary } = row;
  writeFileSync(meta, JSON.stringify({ ...ordinary, reason: "pending-input", repark_pending: true }));
  rmSync(retryMarkerPath(f.home, "a", RETRY));
  expect(reparkLicensed(f.home, "a", f.ctx.env)).toBe(false);
});

test("a retry row never joins a digest, even beside a fresh message to the same pane", async () => {
  const f = fixture();
  f.parkRetry("a");
  for (const id of ["b", "c"]) {
    writeFileSync(join(f.ctx.spoolDir, `${id}.md`), `---\nid: ${id}\nfrom: sender\nto: peer\nkind: discuss\nreply: expected\n---\nbody ${id}\n`);
    writeFileSync(join(f.ctx.spoolDir, `${id}.meta.json`), JSON.stringify({ id, target: "peer", pane: f.binding.pane, pane_id: f.binding.paneId,
      target_registry: f.binding.targetRegistry, to_team: "fixture", policy: "standard", reason: "pending-input", reason_class: "busy",
      deadline_source: "readiness-gate", attempts: 0, held_drain_visits: 0, first_spooled_epoch: 1, deadline_epoch: 2000 }));
  }
  const trace: string[] = [];
  const effects: DrainEffects = {
    readiness: async () => "ready", harness: async () => "codex", flash: async () => {}, repairOrphans: async () => {},
    redeliverLocked: async id => { trace.push(`solo:${id}`); return 0; },
    digest: async (_b, ids) => { trace.push(`digest:${ids.join(" ")}`); return 0; },
  };
  await drainOnce({ ...f.ctx, now: 1000, env: { ...f.ctx.env, TAP_SPOOL_NOW: "1000" } }, effects, { cap: "8" });
  expect(trace.some(line => line.startsWith("digest:") && line.split(/[: ]/).includes("a"))).toBe(false);
});
