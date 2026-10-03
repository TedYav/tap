import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SubmitResult } from "../src/courier";
import { classifyNotice } from "../src/notice";
import { removeEntryAsync } from "../src/spool-sidecar";
import { notifySenderOnEscalate, type DeadlineContext } from "../src/spool-deadline";
import { drainOnce, type DrainContext, type DrainEffects } from "../src/spool-drain";

for (const [evidence, expected] of [["failed", "failed"], ["possible", "unconfirmed"], ["unconfirmed", "unconfirmed"], ["unrouted", "unrouted"]] as const) {
  test(`notice evidence ${evidence || "no attempt"} selects ${expected}`, () => {
    expect(classifyNotice(evidence, false)).toBe(expected);
    expect(classifyNotice(evidence, true)).toBe("skip");
    expect(classifyNotice(evidence, false, true)).toBe("skip");
  });
}
test("unknown evidence cannot silently become a failure claim", () => {
  expect(() => classifyNotice("unknown", false)).toThrow();
  expect(() => classifyNotice("", false)).toThrow();
});

// --- ported from skills/tap/scripts/smoke/notice-outcome.test.sh ------------------------
// The sender-notice selection over seeded receipt state. The possible/read/settled/
// delivered scenarios call the notice decision directly at its in-process seam (the
// drain's recipient attempt moved into the native engine, beyond any Bash
// stub); publication — the payload on the bus — is what is asserted, never the wake.
// The grace-* scenarios run one REAL drain pass (drainOnce), which owns the routing
// the retired arm exercised through spool_drain_fixture_once; the wrapper diagnostics
// stay subprocess because they belong to runtime-helpers.sh's tap_bun_call, not to
// any module here.

const busRoots: string[] = [];
afterEach(() => { for (const root of busRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function outcomeBus(): { home: string; ctx: DeadlineContext; registry: string; spool: string } {
  const home = mkdtempSync(join(tmpdir(), "notice-outcome-"));
  busRoots.push(home);
  for (const d of ["spool", "payloads", "receipts"]) mkdirSync(join(home, d), { recursive: true });
  const registry = join(home, "registry.json");
  writeFileSync(registry, JSON.stringify({
    schema: "0.20", team: { name: "fixture" },
    seats: {
      alice: { status: "active", pane: "sess:0.1", pane_id: "%402", harness: "codex" },
      peer: { status: "active", pane: "sess:0.0", pane_id: "%401", harness: "codex" },
    },
  }));
  writeFileSync(join(home, "spool", "original.md"),
    `---\nid: original\nfrom: alice\nto: peer\nkind: discuss\nreply: expected\npath: ${join(home, "payloads", "original.md")}\n---\noriginal body\n`);
  writeFileSync(join(home, "spool", "original.meta.json"), `${JSON.stringify({
    id: "original", target: "peer", reason: "pending-input", reason_class: "busy", policy: "standard",
    first_spooled_epoch: 1, hold_until_epoch: 0, deadline_epoch: 9999999999, pane: "sess:0.0", pane_id: "%401",
    to_team: "fixture", target_registry: registry, attempts: 0,
  })}\n`);
  const submits: SubmitResult[] = [];
  const ctx: DeadlineContext = {
    home, spoolDir: join(home, "spool"), eventLog: join(home, "registry-events.log"), team: "fixture",
    verbLabel: "tap", actingRegistry: registry, scriptsDir: join(home, "scripts"), alert: { mode: "none" },
    now: 1000, unroutedGrace: 1800, wall: () => new Date("2026-09-16T05:00:00Z"),
    submit: () => { const r: SubmitResult = { status: "injected" }; submits.push(r); return r; },
  };
  return { home, ctx, registry, spool: join(home, "spool") };
}

const failedNotices = (home: string): string[] =>
  readdirSync(join(home, "payloads")).filter((name) => name.endsWith(".md")
    && readFileSync(join(home, "payloads", name), "utf8").split("\n").includes("kind: delivery-failed"));

// Every decided scenario answers woken: suppression IS a decided wake of the
// settled/already-informed sender, not a silent failure to act (the shell asserted
// `= woken` for every scenario it drove).
const NOTICE_MATRIX = [
  ["possible", "DELIVERY UNCONFIRMED:"],
  ["read", null],
  ["read-forced", "DELIVERY UNCONFIRMED:"],
  ["read-malformed", "DELIVERY UNCONFIRMED:"],
  ["read-wrong-id", "DELIVERY UNCONFIRMED:"],
  ["read-unrelated", "DELIVERY UNCONFIRMED:"],
  ["settled", null],
  ["delivered", null],
  ["failed", "DELIVERY FAILED:"],
] as const;

for (const [scenario, want] of NOTICE_MATRIX) {
  test(`notify outcome ${scenario}${want ? ` publishes ${want}` : " is suppressed"}`, async () => {
    const { home, ctx, registry, spool } = outcomeBus();
    // Post-promotion state, exactly as the retired arm arranged it: canonical in
    // place, possible-effect marker seeded, spool entry removed by the production
    // remover so the notice reads the canonical path alone.
    copyFileSync(join(spool, "original.md"), join(home, "payloads", "original.md"));
    writeFileSync(join(home, "receipts", "original.attempted"), '{"id":"original","effect":"possible"}');
    await removeEntryAsync(spool, "original");
    switch (scenario) {
      case "read": writeFileSync(join(home, "receipts", "original.read"), '{"id":"original","by":"peer","at":"2026-09-09T01:28:47Z"}'); break;
      case "read-forced": writeFileSync(join(home, "receipts", "original.read"), '{"id":"original","by":"alice","forced":"true"}'); break;
      case "read-malformed": writeFileSync(join(home, "receipts", "original.read"), "{broken"); break;
      case "read-wrong-id": writeFileSync(join(home, "receipts", "original.read"), '{"id":"another","by":"peer"}'); break;
      case "read-unrelated": writeFileSync(join(home, "receipts", "another.read"), '{"id":"another","by":"peer"}'); break;
      case "settled": writeFileSync(join(home, "receipts", "original.done"), '{"via":"read"}'); break;
      case "delivered": writeFileSync(join(home, "receipts", "original.sent"), "{}"); break;
    }
    const woken = notifySenderOnEscalate(ctx, {
      id: "original", target: "peer",
      detail: scenario === "failed" ? "no attempt was made" : "possible effect; recipient pane attempt unconfirmed",
      targetRegistry: registry, outcome: scenario === "failed" ? "failed" : "possible",
    });
    expect(woken, scenario).toBe(true);
    const notices = failedNotices(home);
    if (want === null) {
      expect(notices, scenario).toEqual([]);
    } else {
      expect(notices.length, scenario).toBeGreaterThan(0);
      expect(readFileSync(join(home, "payloads", notices[0]!), "utf8")).toContain(want);
    }
    // Custody: the canonical the sender is pointed at survives every route.
    expect(existsSync(join(home, "payloads", "original.md")), scenario).toBe(true);
    if (scenario === "read") {
      // Suppression by read fabricates neither settlement nor delivery.
      expect(existsSync(join(home, "receipts", "original.done"))).toBe(false);
      expect(existsSync(join(home, "receipts", "original.sent"))).toBe(false);
    }
  });
}

// The grace-* trio ran the real drain in the retired arm, and the routing it owned
// is the drain's own: the per-row pre-gate call inside drainOnce (spool-drain.ts),
// not the module verb. So one REAL drain pass runs here, with the receipt seeded
// BEFORE it — publication must read the receipts at notice time. Settled custody
// now reconciles before the grace branch; every route preserves a canonical body.
for (const [scenario, receipt] of [["grace-read", "read"], ["grace-settled", "done"], ["grace-delivered", "sent"]] as const) {
  test(`grace ${scenario} suppresses the durable notice in a real drain pass`, async () => {
    const { home, registry, spool } = outcomeBus();
    writeFileSync(join(home, "spool", "original.meta.json"), `${JSON.stringify({
      id: "original", target: "peer", reason: "pending-input", reason_class: "busy", policy: "standard",
      waiter_lifetime: "grace-window", first_spooled_epoch: 1, hold_until_epoch: 0, deadline_epoch: 50,
      pane: "sess:0.0", pane_id: "%401", to_team: "fixture", target_registry: registry, attempts: 1,
    })}\n`);
    writeFileSync(join(home, "receipts", "original.attempted"), '{"id":"original","effect":"possible"}');
    const body = receipt === "read" ? '{"id":"original","by":"peer","at":"2026-09-09T01:28:47Z"}' : "{}";
    writeFileSync(join(home, "receipts", `original.${receipt}`), body);
    writeFileSync(join(home, ".tap-bus-authority"), "");
    mkdirSync(join(home, "index"), { recursive: true });
    const env: NodeJS.ProcessEnv = { ...process.env, TAP_HOME: home, TAP_INDEX_HOME: join(home, "index"),
      TAP_SPOOL_DISABLE_DELIVERER: "1", TAP_SPOOL_NOW: "1000", TAP_SPOOL_DRAIN_ACTIVE: "0",
      XDG_CONFIG_HOME: join(home, "config"), TAP_SPOOL_HUMAN_ALERT: undefined };
    const ctx: DrainContext = { home, spoolDir: spool, payloadsDir: join(home, "payloads"), receiptsDir: join(home, "receipts"),
      eventLog: join(home, "registry-events.log"), team: "fixture", actingRegistry: "", verbLabel: "tap",
      scriptsDir: join(home, "scripts"), courierIdentity: "courier", alert: { mode: "none" }, now: 1000, unroutedGrace: 1800, env };
    // No effect moves custody: whatever the assertions find, the disposition did.
    const effects: DrainEffects = {
      readiness: async _b => "ready", harness: async () => "codex", flash: async () => {},
      repairOrphans: async () => {}, redeliverLocked: async () => 0, digest: async () => 0,
    };
    expect(await drainOnce(ctx, effects, {})).toBe(0);
    expect(failedNotices(home), scenario).toEqual([]);
    expect(existsSync(join(home, "receipts", "original.unconfirmed")), "a suppressed grace notice was recorded as published").toBe(false);
    const events = (() => { try { return readFileSync(join(home, "registry-events.log"), "utf8"); } catch { return ""; } })();
    expect(events).not.toContain("notice_id=original-delivery-unconfirmed");
    expect(existsSync(join(home, "payloads", "original.md")), "original custody lost").toBe(true);
    if (scenario === "grace-settled") expect(existsSync(join(home, "spool", "original.md"))).toBe(false);
    if (scenario === "grace-read") {
      expect(existsSync(join(home, "receipts", "original.done"))).toBe(false);
      expect(existsSync(join(home, "receipts", "original.sent"))).toBe(false);
    }
  });
}

// The wrapper diagnostics belong to runtime-helpers.sh's tap_bun_call and only
// exist at a process boundary: bun absent from PATH refuses with runtime_missing;
// a module refusal surfaces as slice_failed naming the id and slice.
const helpers = join(import.meta.dir, "../../../skills/tap/scripts/smoke/runtime-helpers.sh");
const scriptsDir = join(import.meta.dir, "../../../skills/tap/scripts");
const wrapperCall = (busHome: string, outcome: string, env: NodeJS.ProcessEnv) => {
  const script = `. '${helpers}'\n` +
    `tap_bun_call spool-deadline original spool-deadline.ts '${busHome}' '${join(busHome, "spool")}' ` +
    `'${join(busHome, "registry-events.log")}' fixture tap '' '${scriptsDir}' none '' '' 1000 1800 ` +
    `notify original peer 'no attempt was made' '${join(busHome, "registry.json")}' '${outcome}' '' ''\n`;
  return Bun.spawnSync(["bash", "-c", script], { env });
};

test("a drain call with bun absent from PATH refuses with the wrapper's runtime_missing diagnostic", () => {
  const { home } = outcomeBus();
  copyFileSync(join(home, "spool", "original.md"), join(home, "payloads", "original.md"));
  writeFileSync(join(home, "receipts", "original.attempted"), '{"id":"original","effect":"possible"}');
  const proc = wrapperCall(home, "failed", { ...process.env, PATH: "/usr/bin:/bin", TAP_SMOKE_BUN: "bun" });
  expect(proc.exitCode, proc.stderr.toString()).not.toBe(0);
  expect(proc.stderr.toString()).toContain("runtime_missing id=original slice=spool-deadline");
  // The refusal publishes nothing, whatever the outcome string said.
  expect(failedNotices(home), "the wrapper refusal manufactured a notice").toEqual([]);
});

test("a module refusal surfaces as the wrapper's slice_failed diagnostic", () => {
  const { home } = outcomeBus();
  copyFileSync(join(home, "spool", "original.md"), join(home, "payloads", "original.md"));
  writeFileSync(join(home, "receipts", "original.attempted"), '{"id":"original","effect":"possible"}');
  const proc = wrapperCall(home, "unknown", process.env);
  expect(proc.exitCode, proc.stderr.toString()).not.toBe(0);
  expect(proc.stderr.toString()).toContain("slice_failed id=original slice=spool-deadline");
  // An unknown outcome can neither publish nor disturb custody.
  expect(failedNotices(home), "an unknown outcome manufactured a notice").toEqual([]);
  expect(existsSync(join(home, "payloads", "original.md")), "original custody lost").toBe(true);
});
