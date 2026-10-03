// tap_serial_triggers "bin/" "runtime/bun/main.ts" "runtime/bun/test/support/reply-foreign-fixture.ts" "skills/tap/scripts/tap-send.sh" "skills/tap/scripts/lib.sh"
// SETTLEMENT/TEAM/ROUTING component of the former reply-foreign-payload.test.ts
// (unit 2 split): the settlement-side rows (courier-auto presettle door, the
// reset-generation reused/pristine pins), the --team bus-anchor shapes with
// their no---team control, the non-payloads/ bus-shape guard, the no-actor
// prefill, and the door router tracing. Shared world:
// support/reply-foreign-fixture.ts (this file registers its own
// afterAll(releaseScratch, 40_000)).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { envelopeField } from "../src/envelope";
import { TapError } from "../src/context";
import { refuseUnreachableSenderTeam } from "../src/verbs/reply";
import { removeScratchTree } from "./support/scratch";
import { fixture, run, outbounds, injected, settlement, INBOUND_ID, releaseScratch } from "./support/reply-foreign-fixture";

afterAll(releaseScratch, 40_000);
describe("the foreign payload file", () => {
  test("courier-auto presettled on beta's bus: the problem-report door stays open — the answer is delivered, no second .done", () => {
    const fx = fixture({ betaDone: { id: INBOUND_ID, status: "done", at: "2026-09-16T11:00:00Z", by: "ua", via: "courier-auto" } });
    const before = readFileSync(join(fx.beta.bus, "receipts", `${INBOUND_ID}.done`), "utf8");
    const v = run(fx, ["reply", fx.payload, "-m", "wrong premise", "--by", "ua"]);
    expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr, alpha: outbounds(fx.alpha.bus).length, injected: injected(fx).length })
      .toEqual({ code: 0, route: "native reply", stdout: `tap reply: ok ${INBOUND_ID}\n`, stderr: "", alpha: 1, injected: 1 });
    expect({ unchanged: readFileSync(join(fx.beta.bus, "receipts", `${INBOUND_ID}.done`), "utf8") === before, alphaDone: existsSync(join(fx.alpha.bus, "receipts", `${INBOUND_ID}.done`)) }).toEqual({ unchanged: true, alphaDone: false });
  }, 120_000);
  // The settle receipt is a mutation of the bus it lands on: a pristine reset
  // generation on beta must read `reused` by `done` after a foreign settlement
  // (tap-reply-settle.sh:315 `tap_reset_generation_touch_bus "$_ext_bus_home" "done"`),
  // alpha's by the outbound's `send`; a progress outbound, a courier-auto
  // presettled inbound and a refused reply claim no beta mutation.
  test("reset generation: a foreign settlement marks BETA's pristine generation reused by `done` (alpha's by the outbound's `send`)", () => {
    const generation = (bus: string) => JSON.parse(readFileSync(join(bus, "reset-generation.json"), "utf8")) as Record<string, unknown>;
    const fx = fixture({ generations: true });
    const v = run(fx, ["reply", fx.payload, "-m", "answer", "--by", "ua"]);
    expect({ code: v.code, beta: generation(fx.beta.bus), alpha: generation(fx.alpha.bus) })
      .toEqual({ code: 0, beta: { state: "reused", first_mutation: "done" }, alpha: { state: "reused", first_mutation: "send" } });
  }, 120_000);

  test("reset generation controls: progress, a courier-auto presettled inbound and a refused reply leave BETA's generation pristine", () => {
    const generation = (bus: string) => JSON.parse(readFileSync(join(bus, "reset-generation.json"), "utf8")) as Record<string, unknown>;
    const progress = fixture({ generations: true });
    expect({ shape: "progress", code: run(progress, ["reply", progress.payload, "-m", "still working", "--by", "ua", "--progress"]).code, beta: generation(progress.beta.bus), alpha: generation(progress.alpha.bus).state })
      .toEqual({ shape: "progress", code: 0, beta: { state: "pristine" }, alpha: "reused" });
    const presettled = fixture({ generations: true, betaDone: { id: INBOUND_ID, status: "done", at: "2026-09-16T11:00:00Z", by: "ua", via: "courier-auto" } });
    expect({ shape: "courier-auto", code: run(presettled, ["reply", presettled.payload, "-m", "wrong premise", "--by", "ua"]).code, beta: generation(presettled.beta.bus) })
      .toEqual({ shape: "courier-auto", code: 0, beta: { state: "pristine" } });
    const refused = fixture({ generations: true, inbound: { to_team: "gamma" } });
    expect({ shape: "refused", code: run(refused, ["reply", refused.payload, "-m", "answer", "--by", "ua"]).code, beta: generation(refused.beta.bus), alpha: generation(refused.alpha.bus) })
      .toEqual({ shape: "refused", code: 1, beta: { state: "pristine" }, alpha: { state: "pristine" } });
  }, 120_000);

  test("--team: the pane-less bus anchor from a cwd outside every worktree", () => {
    const fx = fixture();
    const elsewhere = join(fx.root, "elsewhere");
    mkdirSync(elsewhere);
    const v = run(fx, ["reply", fx.payload, "-m", "answer", "--by", "ua", "--team", "alpha"], { cwd: elsewhere });
    expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr, alpha: outbounds(fx.alpha.bus).length, ...settlement(fx) })
      .toEqual({ code: 0, route: "native reply", stdout: `tap reply: ok ${INBOUND_ID}\n`, stderr: "", alpha: 1, betaDone: expect.objectContaining({ via: "reply", by: "ua" }), alphaDone: false });
  }, 120_000);

  // The shape `--team` exists for (tap-mxf95, reply-selected-registry.test.sh —
  // the gate specimen at 9ea22bffa): a pane-less caller standing INSIDE
  // ANOTHER enrolled team's root. The incumbent's override exports TAP_HOME
  // and its bus resolution is TAP_HOME-first; a native selection through the
  // cwd walk would pick the cwd team under a live marker, so both the reply
  // and the send it composes select the EXPLICIT team. The outbound on ALPHA
  // and beta's payload dir gaining nothing is the send-half falsifier.
  test("--team from a cwd inside ANOTHER enrolled team's root: the reply and its composed send act on the named team, the cwd team's bus gains nothing", () => {
    const fx = fixture();
    const insideBeta = join(fx.beta.wt, "trees", "lane");
    mkdirSync(insideBeta, { recursive: true });
    const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua", "--team", "alpha"], { cwd: insideBeta });
    expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr, alpha: outbounds(fx.alpha.bus).length, beta: outbounds(fx.beta.bus), ...settlement(fx) })
      .toEqual({ code: 0, route: "native reply", stdout: `tap reply: ok ${INBOUND_ID}\n`, stderr: "", alpha: 1, beta: [], betaDone: expect.objectContaining({ via: "reply", by: "ua" }), alphaDone: false });
  }, 120_000);

  // Measured: with beta selected the inbound is a LOCAL payload addressed to
  // alpha/ua, so the refusal is `not_addressee` naming `beta/ua` — the cwd
  // team's name in the refusal is the selection evidence.
  test("control: the same cwd inside beta's root WITHOUT --team selects beta — not_addressee names 'beta/ua', nothing placed, nothing settled", () => {
    const fx = fixture();
    const insideBeta = join(fx.beta.wt, "trees", "lane");
    mkdirSync(insideBeta, { recursive: true });
    const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua"], { cwd: insideBeta });
    expect({ code: v.code, route: v.route, alpha: outbounds(fx.alpha.bus), beta: outbounds(fx.beta.bus), ...settlement(fx) })
      .toEqual({ code: 1, route: "native reply", alpha: [], beta: [], betaDone: null, alphaDone: false });
    expect(v.stderr).toContain(`'${INBOUND_ID}' is addressed to 'alpha/ua', not 'beta/ua'`);
  }, 120_000);

  // Review round, thread 1: a foreign path whose parent directory is
  // not `payloads/`. Native refuses before any outbound with the incumbent's
  // bus-shape sentence (tap-reply-settle.sh's structural bus-shape guard,
  // F2B-2).
  test("a foreign path outside a payloads/ directory: native refuses before any outbound with the incumbent's bus-shape sentence", () => {
    const fx = fixture();
    const relay = join(fx.root, "relay"); mkdirSync(relay);
    const copy = join(relay, `${INBOUND_ID}.md`); writeFileSync(copy, readFileSync(fx.payload));
    const v = run(fx, ["reply", copy, "-m", "answer", "--by", "ua"]);
    const detail = "--payload must be inside a 'payloads/' directory (parent is 'relay', expected 'payloads')";
    expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr, alpha: outbounds(fx.alpha.bus).length, injected: injected(fx).length, relayReceipts: existsSync(join(fx.root, "receipts")), ...settlement(fx) })
      .toEqual({ code: 1, route: "native reply", stdout: "", stderr: `tap reply: ${detail}; next: tap help reply; AGENTS.md TAP card (Ask/Note/Digest)\n`, alpha: 0, injected: 0, relayReceipts: false, betaDone: null, alphaDone: false });
  }, 120_000);

  // Review round, thread 2: no --by, no TAP_SELF, no pane — the
  // addressee is PREFILLED into a copyable line with the reference as typed
  // (tap-g3o6; tap-reply.sh:109-122), never adopted.
  test("no actor derivable: the exact --by is prefilled from the inbound's addressee with the reference as typed, nothing placed", () => {
    const fx = fixture();
    const v = run(fx, ["reply", fx.payload, "-m", "answer"], { self: "" });
    expect({ code: v.code, route: v.route, alpha: outbounds(fx.alpha.bus).length, ...settlement(fx) })
      .toEqual({ code: 1, route: "native reply", alpha: 0, betaDone: null, alphaDone: false });
    expect({ stdout: v.stdout, stderr: v.stderr }).toEqual({ stdout: "", stderr: `tap reply: could not derive your handle from this pane; '${INBOUND_ID}' is addressed to 'ua' — re-run with --by ua if that is you (only the addressee replies); next: tap reply <root>/beta/.tap/bus/payloads/${INBOUND_ID}.md --by ua -f <file>\n` });
  }, 120_000);

  test("router: every reference spelling, --payload, --team and a second positional (the incumbent's body file) trace native", () => {
    const fx = fixture();
    expect(run(fx, ["reply", fx.payload, "-m", "x", "--by", "ua", "--progress"]).route).toBe("native reply");
    expect(run(fixture(), ["reply", `beta/${INBOUND_ID}`, "-m", "x", "--by", "ua", "--progress"]).route).toBe("native reply");
    const p = fixture();
    expect(run(p, ["reply", INBOUND_ID, "--payload", p.payload, "-m", "x", "--by", "ua", "--progress"]).route).toBe("native reply");
    const t = fixture();
    expect(run(t, ["reply", t.payload, "-m", "x", "--by", "ua", "--team", "alpha", "--progress"]).route).toBe("native reply");
    const body = fixture();
    writeFileSync(join(body.root, "body.md"), "answer\n");
    expect(run(body, ["reply", body.payload, join(body.root, "body.md"), "--by", "ua"]).route).toBe("native reply");
  }, 120_000);
});
