// tap_serial_triggers "bin/" "runtime/bun/main.ts" "skills/tap/scripts/tap-send.sh" "skills/tap/scripts/lib.sh" "runtime/bun/test/support/send-delivery-fixture.ts" "runtime/bun/test/fixtures/agent-state/"
/* The explicit interrupt class (--urgent, --delivery interrupt) on the
   native pane path. The interrupt keystroke lands BEFORE the payload, a human
   decision on screen is never interrupted, a live clearing fence refuses urgent
   outright, and an interrupt that landed without a verified submit is never
   retried (the .attempted evidence holds the spool). Shared fixture:
   support/send-delivery-fixture.ts — the fake tmux records every send-keys line,
   so interrupt keys are observable without band mutation. One fixture per send:
   a Bash spool body on the bus delegates the next native send. */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digestDraftPlan } from "../src/injection-behavior";
import { acquirePaneLock } from "../src/panelock";
import { AGENT_INTERRUPT_ATTRIBUTION, phaseRows, interruptNotice } from "../src/submit-phase";

import { effects, fixture, flashes, notices, releaseScratch, run, routeOf } from "./support/send-delivery-fixture";

afterAll(releaseScratch, 40_000);

const attemptedCount = (fx: ReturnType<typeof fixture>): number => {
  const receipts = join(fx.bus, "receipts");
  return existsSync(receipts) ? readdirSync(receipts).filter(f => f.endsWith(".attempted")).length : 0;
};

const protectionRecord = (fx: ReturnType<typeof fixture>): string => {
  const dir = join(fx.env.TAP_INDEX_HOME!, "input-protection");
  return join(dir, readdirSync(dir).find(n => n.endsWith(".json"))!);
};

/** The interrupt keys must sit BEFORE the payload line: keystroke, then body. */
const interruptBeforePayload = (keys: string[], interrupt: string): void => {
  const hit = keys.findIndex(l => l.includes(interrupt));
  const payload = keys.findIndex(l => l.includes(" -l -- "));
  expect({ interrupt: hit, payload }).toEqual({ interrupt: expect.any(Number), payload: expect.any(Number) });
  expect(hit).toBeGreaterThanOrEqual(0);
  expect(payload).toBeGreaterThan(hit);
};

function drainFixture(fx: ReturnType<typeof fixture>, now?: number) {
  return Bun.spawnSync(["bash", "-c", '. "$1/smoke/runtime-helpers.sh"; . "$1/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once', "drain", join(import.meta.dir, "../../../skills/tap/scripts")], {
    cwd: fx.wt, env: { ...fx.env, ...(now !== undefined ? { TAP_SPOOL_NOW: String(now) } : {}), TAP_HOME: fx.bus, TAP_SPOOL: join(fx.bus, "spool"), TAP_PAYLOADS: join(fx.bus, "payloads"), TAP_RECEIPTS: join(fx.bus, "receipts"), TAP_REGISTRY: fx.registry, TAP_REGISTRY_EVENTS: join(fx.bus, "registry-events.log") }, stdout: "pipe", stderr: "pipe", timeout: 15000,
  });
}

function expireAndDrain(fx: ReturnType<typeof fixture>) {
  for (const dir of [join(fx.env.TAP_INDEX_HOME!, "input-protection"), join(fx.bus, "spool")]) {
    // A run that never wrote protection/spool state leaves the dir absent.
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter(n => n.endsWith(".json"))) {
      const path = join(dir, name), meta = JSON.parse(readFileSync(path, "utf8"));
      if (meta.graceUntil !== undefined) meta.graceUntil = Date.now() - 1000;
      else { meta.deadline_epoch = Math.floor(Date.now() / 1000) - 1; meta.draft_deadline_epoch = meta.deadline_epoch; }
      writeFileSync(path, JSON.stringify(meta));
    }
  }
  return drainFixture(fx);
}

describe("U4: the interrupt class delivers natively", () => {
  for (const hold of ["recovery", "lock"] as const) {
    test(`copy-mode cancellation waits for ${hold} ownership before any key`, () => {
      const fx = fixture({ copyMode: true, recoveryHold: hold === "recovery" });
      fx.env.FAKE_CANCEL_CLEARS = "1";
      const lock = hold === "lock" ? acquirePaneLock("%7", 5000, fx.env) : null;
      if (hold === "lock") expect(lock).not.toBeNull();
      try {
        const v = run(fx, ["send", "rb", "-m", "hi", "--urgent"]);
        expect(v.route).toBe(routeOf("send"));
        expect(v.keys).toEqual([]);
        expect(v.code).toBe(0);
        expect(v.spool.map(r => r.reason)).toEqual([hold === "recovery" ? "recovery-hold" : "copy-mode"]);
        expect(attemptedCount(fx)).toBe(0);
      } finally { lock?.release(); }
    }, 120_000);
  }

  for (const draft of ["[[TAP v0.23 ask old]]", "[[TAP v0.23 ask truncated"]) {
    test(`staged courier input is preserved for checkpoint C: ${draft}`, () => {
      const fx = fixture({ draft });
      const v = run(fx, ["send", "rb", "-m", "hi", "--urgent"]);
      expect(v.route).toBe(routeOf("send"));
      expect(v.code).toBe(0);
      expect(v.spool).toHaveLength(1);
      expect(readFileSync(join(fx.root, "band"), "utf8")).toBe(draft);
      // tap-rdy9n: a visible sentinel parks before the interrupt, so no key
      // lands and no attempt is recorded.
      expect(v.keys).toEqual([]);
      expect(attemptedCount(fx)).toBe(0);
    }, 120_000);
  }

  test("urgent human drafts park for10s without any interrupt or clear key", () => {
    const fx = fixture({ draft: "human draft" });
    const v = run(fx, ["send", "rb", "-m", "hi", "--urgent"]);
    expect(v.route).toBe(routeOf("send"));
    expect({ code: v.code, status: v.receipt.status }).toEqual({ code: 0, status: "queued" });
    expect(v.keys).toEqual([]);
    const records = readdirSync(join(fx.env.TAP_INDEX_HOME!, "input-protection"));
    const state = JSON.parse(readFileSync(join(fx.env.TAP_INDEX_HOME!, "input-protection", records[0]!), "utf8"));
    expect(state.graceUntil - Date.now()).toBeGreaterThan(7000);
    expect(state.graceUntil - Date.now()).toBeLessThanOrEqual(10000);
  }, 120_000);

  test("urgent shortening makes older cohort mail due despite its future per-id deadline", () => {
    const fx = fixture({ draft: "keep this human draft" });
    expect(run(fx, ["send", "rb", "-m", "older", "--id", "cohort-old"]).receipt.status).toBe("queued");
    const dir = join(fx.env.TAP_INDEX_HOME!, "input-protection");
    const record = join(dir, readdirSync(dir).find(n => n.endsWith(".json"))!);
    const original = JSON.parse(readFileSync(record, "utf8")).graceUntil;
    expect(run(fx, ["send", "rb", "-m", "urgent", "--id", "cohort-urgent", "--urgent"]).receipt.status).toBe("queued");
    const state = JSON.parse(readFileSync(record, "utf8"));
    expect(state.graceUntil).toBeLessThan(original);
    // Advance only the shared pane clock. The older message must not wait for its original 30s.
    state.graceUntil = Date.now() - 1000;
    writeFileSync(record, JSON.stringify(state));
    const spool = join(fx.bus, "spool");
    const meta = JSON.parse(readFileSync(join(spool, "cohort-old.meta.json"), "utf8"));
    expect(Number(meta.draft_deadline_epoch)).toBeGreaterThan(Date.now() / 1000);
    const row = [fx.registry, "team", "rb", "rb", "%7", "0", "cohort-old", "auto-due", "busy:pending"].join("\x1f");
    expect(digestDraftPlan(row, spool, Date.now() / 1000, 32, "clobber", fx.env)).toEndWith("\x1fcohort-old\n");
    const drained = drainFixture(fx);
    // The fake terminal refuses ordinary clear keys, so verify the attempted backup, not a claimed submit.
    const backups = join(fx.bus, "input-backups");
    expect(existsSync(backups), drained.stderr.toString()).toBe(true);
    expect(readdirSync(backups).some(name => readFileSync(join(backups, name), "utf8").includes("payload_id: cohort-old"))).toBe(true);
  }, 120_000);

  for (const snoozed of [false, true]) test(`urgent arrival joins a protected copy-mode cohort without keys (WAIT=${snoozed})`, () => {
    const fx = fixture({draft: snoozed ? "WAIT with my draft" : "my draft"});
    expect(run(fx, ["send", "rb", "-m", "ordinary", "--id", "copy-old"]).receipt.status).toBe("queued");
    const dir = join(fx.env.TAP_INDEX_HOME!, "input-protection");
    const record = join(dir, readdirSync(dir).find(n => n.endsWith(".json"))!);
    const before = JSON.parse(readFileSync(record, "utf8"));
    writeFileSync(fx.env.FAKE_INMODE!, "1");
    const urgent = run(fx, ["send", "rb", "-m", "urgent", "--urgent", "--id", "copy-new"]);
    expect(urgent.receipt.status).toBe("queued"); expect(urgent.keys).toEqual([]);
    const after = JSON.parse(readFileSync(record, "utf8"));
    expect(after.pending.map((m: {id: string}) => m.id)).toEqual(["copy-old", "copy-new"]);
    expect(after.graceUntil).toBeLessThan(before.graceUntil);
    expect(after.graceUntil - Date.now()).toBeLessThanOrEqual(10000);
    expect(after.snoozeUntil).toBe(before.snoozeUntil);
    expect(JSON.parse(readFileSync(join(fx.bus, "spool", "copy-new.meta.json"), "utf8")).policy).toBe("urgent");
  }, 120_000);

  test("WAIT snoozes ordinary and urgent arrivals once and releases on stable empty input", () => {
    const fx = fixture({ draft: "I happen to say WAIT here" });
    const first = run(fx, ["send", "rb", "-m", "one", "--id", "wait-one"]);
    expect(first.receipt.status).toBe("queued"); expect(first.keys).toEqual([]);
    const dir = join(fx.env.TAP_INDEX_HOME!, "input-protection");
    const record = join(dir, readdirSync(dir).find(n => n.endsWith(".json"))!);
    const before = JSON.parse(readFileSync(record, "utf8"));
    expect(before.consumed).toBe(true);
    expect(before.snoozeUntil - Date.now()).toBeGreaterThan(115000);
    const second = run(fx, ["send", "rb", "-m", "two", "--id", "wait-two", "--urgent"]);
    expect(second.receipt.status).toBe("queued"); expect(second.keys).toEqual([]);
    expect(JSON.parse(readFileSync(record, "utf8")).snoozeUntil).toBe(before.snoozeUntil);
    writeFileSync(fx.env.FAKE_BAND!, "removed the keyword");
    expect(drainFixture(fx).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(record, "utf8")).snoozeUntil).toBe(before.snoozeUntil);
    expect(existsSync(join(fx.bus, "receipts", "wait-one.attempted"))).toBe(false);
    unlinkSync(fx.env.FAKE_BAND!);
    expect(drainFixture(fx).exitCode).toBe(0);
    Bun.sleepSync(260);
    expect(drainFixture(fx).exitCode).toBe(0);
    expect(existsSync(join(fx.bus, "receipts", "wait-one.sent")), JSON.stringify({ receipts: readdirSync(join(fx.bus, "receipts")), state: existsSync(record) ? readFileSync(record, "utf8") : "gone" })).toBe(true);
    expect(existsSync(join(fx.bus, "receipts", "wait-two.sent"))).toBe(true);
  }, 120_000);

  test("WAIT cues: arrival green, latch blue once, snoozed arrivals ordinary and urgent flash nothing", () => {
    const fx = fixture({ draft: "human draft" });
    expect(run(fx, ["send", "rb", "-m", "one", "--id", "cue-one"]).receipt.status).toBe("queued");
    expect(flashes(fx)).toEqual(["bg=green"]);
    writeFileSync(fx.env.FAKE_BAND!, "please WAIT before sending");
    expect(run(fx, ["send", "rb", "-m", "two", "--id", "cue-two"]).receipt.status).toBe("queued");
    expect(flashes(fx)).toEqual(["bg=green", "bg=blue"]);
    const record = protectionRecord(fx);
    const snoozed = JSON.parse(readFileSync(record, "utf8"));
    expect(snoozed.consumed).toBe(true);
    expect(snoozed.snoozeUntil - Date.now()).toBeGreaterThan(115_000);
    expect(run(fx, ["send", "rb", "-m", "three", "--id", "cue-three"]).receipt.status).toBe("queued");
    const urgent = run(fx, ["send", "rb", "-m", "four", "--id", "cue-four", "--urgent"]);
    expect(urgent.receipt.status).toBe("queued");
    expect(urgent.keys).toEqual([]);
    expect(flashes(fx)).toEqual(["bg=green", "bg=blue"]);
    writeFileSync(fx.env.FAKE_BAND!, "WAIT once more after the first snooze");
    expect(run(fx, ["send", "rb", "-m", "five", "--id", "cue-five"]).receipt.status).toBe("queued");
    expect(JSON.parse(readFileSync(record, "utf8")).snoozeUntil).toBe(snoozed.snoozeUntil);
    expect(flashes(fx)).toEqual(["bg=green", "bg=blue"]);
  }, 120_000);

  test("a WAIT the drain observes first still earns its blue: the primary flow", () => {
    const fx = fixture({ draft: "human draft" });
    expect(run(fx, ["send", "rb", "-m", "one", "--id", "drain-blue"]).receipt.status).toBe("queued");
    expect(flashes(fx)).toEqual(["bg=green"]);
    writeFileSync(fx.env.FAKE_BAND!, "human draft WAIT");
    expect(drainFixture(fx).exitCode).toBe(0);
    expect(flashes(fx)).toEqual(["bg=green", "bg=blue"]);
    drainFixture(fx);
    expect(flashes(fx)).toEqual(["bg=green", "bg=blue"]);
  }, 120_000);

  test("snoozed pane earns exactly one green at -30s and one red at -10s from the drain, never per-id repeats", () => {
    const fx = fixture({ draft: "WAIT holding the composer" });
    expect(run(fx, ["send", "rb", "-m", "one", "--id", "milestone-one"]).receipt.status).toBe("queued");
    expect(flashes(fx)).toEqual(["bg=blue"]);
    expect(run(fx, ["send", "rb", "-m", "two", "--id", "milestone-two"]).receipt.status).toBe("queued");
    expect(flashes(fx)).toEqual(["bg=blue"]);
    const su = JSON.parse(readFileSync(protectionRecord(fx), "utf8")).snoozeUntil as number;
    expect(drainFixture(fx, Math.floor(su / 1000) - 20).exitCode).toBe(0);
    expect(flashes(fx)).toEqual(["bg=blue", "bg=green"]);
    drainFixture(fx, Math.floor(su / 1000) - 20);
    expect(flashes(fx)).toEqual(["bg=blue", "bg=green"]);
    expect(drainFixture(fx, Math.floor(su / 1000) - 5).exitCode).toBe(0);
    expect(flashes(fx)).toEqual(["bg=blue", "bg=green", "bg=red"]);
    drainFixture(fx, Math.floor(su / 1000) - 5);
    expect(flashes(fx)).toEqual(["bg=blue", "bg=green", "bg=red"]);
  }, 120_000);

  test("a fresh draft after the snoozed one releases earns a new blue: one snooze per draft", () => {
    const fx = fixture({ draft: "WAIT first draft" });
    expect(run(fx, ["send", "rb", "-m", "one", "--id", "fresh-one"]).receipt.status).toBe("queued");
    expect(flashes(fx)).toEqual(["bg=blue"]);
    writeFileSync(fx.env.FAKE_BAND!, "removed the keyword");
    expect(drainFixture(fx).exitCode).toBe(0);
    unlinkSync(fx.env.FAKE_BAND!);
    expect(drainFixture(fx).exitCode).toBe(0);
    Bun.sleepSync(260);
    expect(drainFixture(fx).exitCode).toBe(0);
    expect(existsSync(join(fx.bus, "receipts", "fresh-one.sent"))).toBe(true);
    expect(readdirSync(join(fx.env.TAP_INDEX_HOME!, "input-protection")).filter(n => n.endsWith(".json"))).toEqual([]);
    rmSync(`${fx.env.FAKE_BAND!}.submitted`, { force: true });
    writeFileSync(fx.env.FAKE_BAND!, "WAIT a fresh draft");
    expect(run(fx, ["send", "rb", "-m", "two", "--id", "fresh-two"]).receipt.status).toBe("queued");
    expect(flashes(fx)).toEqual(["bg=blue", "bg=blue"]);
  }, 120_000);

  test("urgent delivery continues its own attempt after cancelling copy mode", () => {
    const fx = fixture({ copyMode: true });
    fx.env.FAKE_CANCEL_CLEARS = "1";
    const v = run(fx, ["send", "rb", "-m", "hi", "--urgent"]);
    expect(v.route).toBe(routeOf("send"));
    expect({ code: v.code, status: v.receipt.status }).toEqual({ code: 0, status: "injected" });
    expect(v.keys.filter(l => l.endsWith("Escape"))).toHaveLength(1);
    expect(attemptedCount(fx)).toBe(1);
  }, 120_000);

  test("an urgent auto-permission send parks before any pane effects", () => {
    for (const copyMode of [false, true]) {
      const fx = fixture({ copyMode });
      const registry = JSON.parse(readFileSync(fx.registry, "utf8"));
      registry.seats.rb.permissions = "auto";
      writeFileSync(fx.registry, JSON.stringify(registry));
      const v = run(fx, ["send", "rb", "-m", "hi", "--urgent"]);
      expect(v.route).toBe(routeOf("send"));
      expect({ copyMode, code: v.code, keys: v.keys, reasons: v.spool.map(r => r.reason) })
        .toEqual({ copyMode, code: 0, keys: [], reasons: ["auto_mode_no_interrupt"] });
      expect(v.stderr).toContain("auto_mode_no_interrupt: auto seat cannot be interrupted; queued as ordinary delivery");
      expect(v.stderr).not.toContain("interrupt attempt for");
      expect(attemptedCount(fx)).toBe(0);
    }
  }, 180_000);

  test("--urgent interrupts the pane, then injects, and records the attempt", () => {
    const fx = fixture();
    const v = run(fx, ["send", "rb", "-m", "hi", "--urgent"]);
    expect(v.route).toBe(routeOf("send"));
    expect(v.code).toBe(0);
    // The run's default --json receipt: status injected, never unverified.
    expect(v.receipt.status).toBe("injected");
    expect(v.receipt.interrupt).toMatchObject({ keys: ["Escape"], tmux_confirmed: true, cancellation: "unknown" });
    interruptBeforePayload(v.keys, "Escape");
    // Claude's interrupt is a single Escape, not a double.
    expect(v.keys.filter(l => l.trim().endsWith("Escape")).length).toBe(1);
    // The submit happened: the band's submitted marker exists and the payload landed.
    expect(existsSync(join(fx.root, "band.submitted"))).toBe(true);
    // The attempt evidence exists: the first interrupt key is a delivery effect.
    expect(attemptedCount(fx)).toBe(1);
    const id = readdirSync(join(fx.bus, "receipts")).find(f => f.endsWith(".attempted"))!.slice(0, -".attempted".length);
    expect(phaseRows(fx.bus, id).filter(row => row.phase.startsWith("interrupt-"))).toMatchObject([
      { phase: "interrupt-intent", interrupt: { pane: "%7", harness: "claude", method: "keys" } },
      { phase: "interrupt-sent" },
    ]);
    expect(v.stderr).toContain("current turn or tool call may be cancelled");
    expect(interruptNotice(fx.bus, id)).toContain("cannot identify cancelled work");
    const shown = run(fx, ["show", id], false);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain("Interrupt input sent");
    const read = run(fx, ["read", id, "--force"], false);
    expect(read.code).toBe(0);
    expect(read.stdout).toContain("Interrupt input sent for");
    // tap-1i81h: the harness renders the cancelled tool call as the USER's
    // stop; TAP attributes it before the body and on the injected sentinel.
    expect(read.stdout).toContain(`tap read: WARNING: ${AGENT_INTERRUPT_ATTRIBUTION}`);
    expect(shown.stdout).toContain(AGENT_INTERRUPT_ATTRIBUTION);
    expect(v.keys).toContain("send-keys -t <rb> -l -- [[TAP v0.23 note <id> urgent agent-interrupt]]");
  }, 120_000);

  for (const chip of [false, true]) test(`the visible draft is retained before Escape can erase it (chip=${chip})`, () => {
    const draft = chip ? "draft erased by Escape [Pasted text #1 +5 lines]" : "draft erased by Escape";
    const fx = fixture({ draft });
    fx.env.FAKE_INTERRUPT_CLEARS = "1";
    const v = run(fx, ["send", "rb", "-m", "hi", "--id", "erase-draft", "--delivery", "interrupt"]);
    expect(v.code).toBe(0);
    expect(v.receipt.status).toBe("queued");
    const drained = expireAndDrain(fx);
    expect(drained.exitCode, drained.stderr.toString()).toBe(0);
    const interrupt = phaseRows(fx.bus, "erase-draft").find(row => row.phase === "interrupt-intent");
    expect(interrupt?.interrupt?.draft_backup, drained.stderr.toString() + drained.stdout.toString()).toBeString();
    expect(readFileSync(interrupt!.interrupt!.draft_backup!, "utf8")).toContain("draft erased by Escape");
    expect(interruptNotice(fx.bus, "erase-draft")).toContain("Visible draft snapshot:");
    // tap-u7ra7: an Escape that empties the composer skips the clobber pipeline,
    // so the owner notice must fire on the interrupt path itself — exactly once,
    // even though the later drain also reaches the clobber notice. Owner notices
    // are client-addressed; the -p probes are identity reads, not notices.
    const ownerNotices = notices(fx).filter(l => l.includes(" -c "));
    expect(ownerNotices.length, ownerNotices.join("\n")).toBe(1);
    // Codex review, tap-xhb1l: the notice must never display while the urgent
    // payload is still in flight. The two chips take DIFFERENT notice paths —
    // chip=false's ordinary draft takes the interrupt-emptied branch, chip=true's
    // paste chip takes the paste-collapse branch — and both defer their notice
    // to AFTER the submission Enter. The effects tape orders Enter presses
    // against display-message calls.
    const tape = effects(fx);
    const lastEnter = tape.map(l => l.startsWith("send-keys Enter")).lastIndexOf(true);
    const noticeAt = tape.findIndex(l => l.startsWith("display-message") && l.includes(" -c "));
    expect(lastEnter, tape.join("\n")).toBeGreaterThanOrEqual(0);
    expect(tape.filter(l => l === "send-keys Enter").length).toBe(1);
    expect(noticeAt, tape.join("\n")).toBeGreaterThan(lastEnter);
    // The claude family's backup stays scrolled-rows-unproven on the interrupt
    // path, so the incomplete wording is correct for BOTH chips; the chip
    // distinction lives in the retained fence (asserted below), and the
    // wording mapping itself is unit-tested on notifyDraftBackedUp.
    expect(ownerNotices[0]).toContain("pasted contents or images were not captured");
    if (chip) {
      expect(readFileSync(interrupt!.interrupt!.draft_backup!, "utf8")).toContain("uncaptured_content: collapsed-paste");
      // The original send is queued; the later drain emits the incomplete-backup warning.
    } else {
      expect(readFileSync(interrupt!.interrupt!.draft_backup!, "utf8")).toContain("uncaptured_content: scrolled-rows");
    }
  }, 120_000);

  test("a paste-collapse draft the urgent clear cannot remove still tells its owner once (tap-xhb1l)", () => {
    // The Escape leaves the chip draft standing, and the post-interrupt clear
    // cannot remove it, so the submission ends before any Enter. The deferred
    // owner notice must still fire on that early exit — exactly once.
    const fx = fixture({ draft: "draft kept by Escape [Pasted text #1 +5 lines]" });
    const v = run(fx, ["send", "rb", "-m", "hi", "--id", "chip-stuck", "--delivery", "interrupt"]);
    expect(v.code).toBe(0);
    const drained = expireAndDrain(fx);
    const tape = effects(fx);
    const ownerNotices = notices(fx).filter(l => l.includes(" -c "));
    expect(ownerNotices.length, tape.join("\n") + drained.stderr.toString()).toBe(1);
    expect(ownerNotices[0]).toContain("pasted contents or images were not captured");
    // No Enter reached the recipient (%7); the sender's own pane may still get its report.
    const keys = existsSync(fx.env.FAKE_KEYS!) ? readFileSync(fx.env.FAKE_KEYS!, "utf8").split("\n") : [];
    expect(keys.filter(l => /Enter/.test(l) && /(-t (%7|rb\b))/.test(l)), keys.join("\n")).toEqual([]);
    expect(phaseRows(fx.bus, "chip-stuck").some(row => row.phase === "interrupt-sent")).toBe(true);
  }, 120_000);

  test("an interrupt whose Escape empties the band with no draft notices nobody", () => {
    const fx = fixture();
    fx.env.FAKE_INTERRUPT_CLEARS = "1";
    const v = run(fx, ["send", "rb", "-m", "hi", "--id", "erase-empty", "--delivery", "interrupt"]);
    expect(v.code).toBe(0);
    const drained = expireAndDrain(fx);
    expect(drained.exitCode, drained.stderr.toString()).toBe(0);
    const interrupt = phaseRows(fx.bus, "erase-empty").find(row => row.phase === "interrupt-intent");
    expect(interrupt?.interrupt?.draft_backup ?? null).toBeNull();
    expect(notices(fx).filter(l => l.includes(" -c "))).toEqual([]);
  }, 120_000);

  test("an ambiguous interrupt key failure retains the payload and attempt disclosure", () => {
    const fx = fixture();
    fx.env.FAKE_INTERRUPT_FAIL = "1";
    const v = run(fx, ["send", "rb", "-m", "hi", "--id", "failed-interrupt", "--urgent"]);
    expect(v.code).toBe(5);
    expect(attemptedCount(fx)).toBe(1);
    expect(existsSync(join(fx.bus, "payloads", "failed-interrupt.md"))).toBe(true);
    expect(interruptNotice(fx.bus, "failed-interrupt")).toContain("input acceptance unconfirmed");
    expect(phaseRows(fx.bus, "failed-interrupt").some(row => row.phase === "interrupt-sent")).toBe(false);
  }, 120_000);

  test("missing disclosure evidence refuses before interrupt keys", () => {
    const fx = fixture();
    mkdirSync(join(fx.bus, "receipts", "no-disclosure.submit-phases.jsonl"));
    const v = run(fx, ["send", "rb", "-m", "hi", "--id", "no-disclosure", "--urgent"]);
    expect(v.code).toBe(1);
    expect(v.receipt.error_class).toBe("attempt_evidence_unwritable");
    expect(v.keys).toEqual([]);
    expect(v.stderr).not.toContain("interrupt attempt for");
  }, 120_000);

  for (const harness of ["cursor", "hermes"]) {
    for (const explicit of [false, true]) {
      test(`${harness}: escalation interrupts only when explicitly chosen (${explicit})`, () => {
        // An interrupt is for a seat mid-turn: the explicit Cursor row starts on its working frame.
        const fx = fixture({ harness, cursorBusy: harness === "cursor" && explicit });
        const v = run(fx, ["send", "rb", "-m", "hi", "--id", "family-interrupt", "--kind", "escalate", ...(explicit ? ["--delivery", "interrupt"] : [])]);
        expect(v.code).toBe(0);
        const rows = phaseRows(fx.bus, "family-interrupt").filter(row => row.phase.startsWith("interrupt-"));
        expect(rows, JSON.stringify({ stderr: v.stderr, receipt: v.receipt })).toHaveLength(explicit ? 2 : 0);
        if (harness === "cursor") expect(v.keys.some(l => l.trim().endsWith("C-c"))).toBe(explicit);
        else {
          expect(v.keys.some(l => /Escape|C-c/.test(l))).toBe(false);
          expect(v.keys.some(l => l.includes("/queue [[TAP")), JSON.stringify({ stderr: v.stderr, receipt: v.receipt })).toBe(!explicit);
          if (explicit) expect(rows[1]).toMatchObject({ phase: "interrupt-sent", enter_count: 1,
            interrupt: { method: "bare-submit", keys: [], tmux_confirmed: true } });
        }
      }, 120_000);
    }
  }

  test("a permission prompt on screen is never interrupted", () => {
    const fx = fixture({ modal: true });
    const v = run(fx, ["send", "rb", "-m", "hi", "--urgent"]);
    expect(v.route).toBe(routeOf("send"));
    // Nothing was typed at the pane: no interrupt, no payload, no Enter.
    expect(v.keys.some(l => l.includes("Escape"))).toBe(false);
    // The fixture's modal is a real Claude permission prompt, so the claude
    // arm's incumbent sentence rides stderr next to the defer.
    expect(v.stderr).toContain("approval prompt blocks urgent delivery; nothing submitted or cleared");
    expect(v.stderr).not.toContain("interrupt attempt for");
    expect(readdirSync(join(fx.bus, "receipts")).filter(f => f.endsWith(".submit-phases.jsonl"))
      .flatMap(f => phaseRows(fx.bus, f.slice(0, -".submit-phases.jsonl".length)))
      .some(row => row.phase.startsWith("interrupt-"))).toBe(false);
    // Deferred, not lost: the message parks for ordinary delivery.
    expect(v.spool.map(r => r.reason)).toContain("no-input-prompt");
  }, 120_000);

  test("a live clearing fence refuses urgent outright", () => {
    const fx = fixture({ clearFence: true });
    const v = run(fx, ["send", "rb", "-m", "hi", "--urgent"]);
    expect(v.route).toBe(routeOf("send"));
    expect({ code: v.code, cls: v.receipt.error_class }).toEqual({ code: 1, cls: "recipient_clearing" });
    expect(v.receipt.detail).toContain("is mid-clear");
    // Nothing left behind: the canonical goes, nothing was queued or typed.
    expect(v.payloads).toBe(0);
    expect(v.spool).toEqual([]);
    expect(v.keys).toEqual([]);
  }, 120_000);

  test("an interrupt that landed but could not submit is parked; resend re-rings it as an ordinary retry and never interrupts again", () => {
    const fx = fixture({ noPrompt: true });
    const v = run(fx, ["send", "rb", "-m", "hi", "--urgent"]);
    expect(v.route).toBe(routeOf("send"));
    // The interrupt happened — the delivery effect is real and evidenced.
    expect(v.keys.some(l => l.trim().endsWith("Escape"))).toBe(true);
    expect(attemptedCount(fx)).toBe(1);
    // The submit could not be verified, so the message parks — but the
    // attempted evidence holds the spool from a blind redelivery.
    expect(v.spool.length).toBe(1);
    expect(v.spool[0]!.reason).toBe("no-input-prompt");
    const id = readdirSync(join(fx.bus, "receipts")).find(f => f.endsWith(".attempted"))!.slice(0, -".attempted".length);
    expect(interruptNotice(fx.bus, id)).toContain("Interrupt input sent");
    // The parked original's attempt is spent: the courier never rings it again. An explicit
    // resend retires that park (keeping its attempt and interrupt evidence) and queues one
    // ordinary same-id retry instead of coalescing into a row that cannot run.
    const resent = run(fx, ["resend", id]);
    expect(resent.code).toBe(0);
    expect(resent.receipt).toMatchObject({ status: "queued", ordinal: 1 }); // the fixture masks ids
    expect(resent.spool).toHaveLength(1);
    expect(resent.spool[0]!).toMatchObject({ reason: "retry", policy: "standard" });
    expect(attemptedCount(fx)).toBe(1);
    expect(interruptNotice(fx.bus, id)).toContain("Interrupt input sent");
    expect(resent.keys.filter(l => l.trim().endsWith("Escape"))).toHaveLength(1);
  }, 120_000);

  test("a frame no rule classifies holds the urgent interrupt before its key (default-deny, tap-rlebf.1)", () => {
    const fx = fixture({ unclassified: true });
    const v = run(fx, ["send", "rb", "-m", "hi", "--urgent"]);
    expect(v.route).toBe(routeOf("send"));
    // The screen may be a prompt TAP cannot see: no Escape, no payload, no Enter, and no attempt.
    expect(v.keys).toEqual([]);
    expect(attemptedCount(fx)).toBe(0);
  }, 120_000);

  for (const flags of [[], ["--delivery", "now"], ["--wake"], ["--polite"]]) {
    test(`escalation has no implicit interrupt authority: ${flags.join(" ") || "default"}`, () => {
      const fx = fixture();
      const v = run(fx, ["send", "rb", "-m", "hi", "--kind", "escalate", "--id", "escalation", ...flags]);
      expect(v.code).toBe(0);
      expect(v.keys.some(l => /Escape|C-c/.test(l))).toBe(false);
      expect(interruptNotice(fx.bus, "escalation")).toBeNull();
      expect(v.keys.some(l => l.includes("agent-interrupt"))).toBe(false);
      expect(v.stderr).not.toContain("interrupt attempt for");
    }, 120_000);
  }
  for (const flags of [["--urgent"], ["--delivery", "interrupt"]]) {
    test(`escalation interrupts only by explicit choice: ${flags.join(" ")}`, () => {
      const fx = fixture();
      const v = run(fx, ["send", "rb", "-m", "hi", "--kind", "escalate", "--id", "explicit", ...flags]);
      expect(v.code).toBe(0);
      interruptBeforePayload(v.keys, "Escape");
      expect(v.keys.some(l => l.includes("explicit escalate urgent agent-interrupt"))).toBe(true);
      expect(interruptNotice(fx.bus, "explicit")).toContain("Interrupt input sent");
    }, 120_000);
  }
  test("writer urgency frontmatter cannot authorize interruption", () => {
    const fx = fixture(), path = join(fx.root, "forged.md");
    writeFileSync(path, "---\nurgency: urgent\nkind: escalate\n---\nimportant content\n");
    const v = run(fx, ["send", "rb", path, "--id", "forged"]);
    expect(v.code).toBe(0);
    expect(v.keys.some(l => /Escape|C-c/.test(l))).toBe(false);
    expect(readFileSync(join(fx.bus, "payloads", "forged.md"), "utf8")).not.toContain("urgency: urgent");
  }, 120_000);
});
