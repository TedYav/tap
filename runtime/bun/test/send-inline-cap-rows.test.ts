// tap_serial_triggers "bin/" "runtime/bun/test/support/send-reply-flip-fixture.ts" "skills/tap/scripts/tap-send.sh" "runtime/bun/main.ts"
// send-note-guard — component split out of the former
// runtime/bun/test/send-reply-flip.test.ts (Deliverable B unit 1). The test
// bodies below are verbatim moves; the shared fixture and helpers live in
// ./support/send-reply-flip-fixture.ts and this file registers its own
// scratch cleanup.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { stampEnvelope, envelopeField } from "../src/envelope";
import { acquirePathLock, acquirePaneLock, KERNEL_LOCK, kernelLockArgs } from "../src/panelock";
import { createHash } from "node:crypto";
import { receiptQueued, resolveOutboundEvidence } from "../src/verbs/reply";
import { Bus } from "../src/bus";
import { TapError } from "../src/context";
import { acquireResetMutationLock, resetFenceRefusal } from "../src/reset";
import { removeScratchTree } from "./support/scratch";
import { NATIVE_SEND, NATIVE_REPLY, MAIN, REENABLED, teamFixture, spawnGit, waitFor, payloads, placed, assertParked, paneObserveCount, resetLockProbe, startPoller, flushScratch } from "./support/send-reply-flip-fixture";

afterEach(() => flushScratch(), 40_000);

// tap-dk19b: the order-shape guard runs in-process on the native door. Every
// claim is made through the installed bin/tap.
//
// These bodies used to also run a Bash-door vehicle (TAP_INTERNAL_OVERDUE_CHECKED=1
// straight into the retained tap.sh/tap-send.sh adapter) and a trailing
// full-byte-equality assertion between the two doors' stderr. The rollback
// selector that used to force that arm through route() is gone (5de960f46),
// and the Bash bodies retire in the next lanes, so that arm is deleted rather
// than kept as a placebo. FROZEN below: the exact one-line refusal is
// `assertInlineCap` (src/slices/message-construction.ts:296-301) rendered by
// `nativeError` (main.ts:444-458) as `tap send: <detail>; next: <action>`
// with the action `tap send <to> <payload-file>` — derived from source, not
// re-derived from the retired cross-door comparison.
describe("the order-shape guard runs natively with the incumbent's verdict, exemptions and bytes", () => {
  const ORDER = "## Plan\n\nNEXT ITEM: tap-oglkh — read-back required, start now.\n";
  type Fx = ReturnType<typeof teamFixture>;
  function send(fx: Fx, verb: string, args: string[], from = "ua", extraEnv: Record<string, string> = {}) {
    const trace = join(fx.root, `route.${Math.random().toString(36).slice(2)}.trace`);
    const result = Bun.spawnSync([join(import.meta.dir, "..", "..", "..", "bin", "tap"), verb, ...args, "--from", from], {
      cwd: fx.wt,
      env: { ...fx.env, TAP_BUN_ROUTE_TRACE: trace, ...extraEnv },
      stdout: "pipe", stderr: "pipe", timeout: 60_000,
    });
    const traced = existsSync(trace) ? readFileSync(trace, "utf8") : "";
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString(), traced };
  }
  function fixture(extra?: (doc: Record<string, unknown>) => void) {
    const fx = teamFixture({ seats: { ub: { status: "active", delivery: "poll", instance: "ub|A" } } });
    const registry = join(fx.wt, ".tap", "team-registry.json");
    if (extra) {
      const doc = JSON.parse(readFileSync(registry, "utf8")) as Record<string, unknown>;
      extra(doc);
      writeFileSync(registry, JSON.stringify(doc));
    }
    writeFileSync(join(fx.bus, "registry.json"), readFileSync(registry));
    return fx;
  }
  function durable(fx: Fx) {
    const receipts = existsSync(join(fx.bus, "receipts")) ? readdirSync(join(fx.bus, "receipts")).length : 0;
    const spool = existsSync(join(fx.bus, "spool")) ? readdirSync(join(fx.bus, "spool")).length : 0;
    return { payloads: payloads(fx.bus).length, receipts, spool };
  }

  describe("the inline byte cap honors TAP_INLINE_MAX_BYTES, lowered and raised, and never applies to -f", () => {
    const body13 = "ordinary note"; // 13 bytes, the reviewer's specimen
    const cases: Array<{ label: string; env: Record<string, string>; args: string[]; admitted: boolean; limit?: string }> = [
      { label: "lowered cap refuses a 13-byte -m", env: { TAP_INLINE_MAX_BYTES: "5" }, args: ["-m", body13], admitted: false, limit: "5" },
      // The incumbent's `[ -gt ]` integer grammar, spelled back as the
      // operator wrote it (partner review D4b-R4: a digits-only validator
      // read +5 as malformed and substituted the default, licensing a note
      // the incumbent refuses).
      { label: "signed positive +5", env: { TAP_INLINE_MAX_BYTES: "+5" }, args: ["-m", body13], admitted: false, limit: "+5" },
      { label: "signed negative -1", env: { TAP_INLINE_MAX_BYTES: "-1" }, args: ["-m", body13], admitted: false, limit: "-1" },
      { label: "leading zeros 0005", env: { TAP_INLINE_MAX_BYTES: "0005" }, args: ["-m", body13], admitted: false, limit: "0005" },
      // A valid cap with a trailing line ending is still a cap, and the human
      // refusal stays ONE line: the incumbent's tap_error_line folds LF/CR to
      // spaces and native's renderer does the same (partner review D4b-R5).
      // Native trims the value before matching, so its verdict is the same
      // on every build.
      { label: "trailing LF cap", env: { TAP_INLINE_MAX_BYTES: "5\n" }, args: ["-m", body13], admitted: false, limit: "5 " },
      { label: "trailing CR cap", env: { TAP_INLINE_MAX_BYTES: "5\r" }, args: ["-m", body13], admitted: false, limit: "5 " },
      { label: "trailing CRLF cap", env: { TAP_INLINE_MAX_BYTES: "5\r\n" }, args: ["-m", body13], admitted: false, limit: "5  " },
      { label: "raised cap admits a body over the default", env: { TAP_INLINE_MAX_BYTES: "200000" }, args: ["-m", "x".repeat(102_401)], admitted: true },
      { label: "default cap refuses 102401 bytes", env: {}, args: ["-m", "x".repeat(102_401)], admitted: false, limit: "102400" },
      { label: "default cap admits 102400 bytes", env: {}, args: ["-m", "x".repeat(102_400)], admitted: true },
      { label: "-f is outside the inline cap", env: { TAP_INLINE_MAX_BYTES: "5" }, args: ["-f", "__BODY__"], admitted: true },
    ];
    for (const c of cases) {
      test(c.label, () => {
        const fx = fixture();
        const body = join(fx.root, "body.md"); writeFileSync(body, body13);
        const args = c.args.map((a) => a === "__BODY__" ? body : a);
        const r = send(fx, "send", ["ub", ...args], "ua", c.env);
        const d = durable(fx);
        expect({ label: c.label, code: r.code, durable: d })
          .toEqual({ label: c.label, code: c.admitted ? 0 : 1, durable: c.admitted ? { payloads: 1, receipts: d.receipts, spool: d.spool } : { payloads: 0, receipts: 0, spool: 0 } });
        if (!c.admitted) {
          // FROZEN: assertInlineCap's exact one-line refusal (see file header).
          const bytes = c.args[1]!.length;
          const frozen = `tap send: -m body is ${bytes} bytes (limit ${c.limit}). Too big for inline — write it to a file and use: tap send ub <payload-file> (the file form has no size limit).; next: tap send ub <payload-file>\n`;
          expect({ label: c.label, err: r.err }).toEqual({ label: c.label, err: frozen });
        }
        // Native decided it natively — refused or admitted — never by falling back.
        expect({ label: c.label, traced: r.traced }).toEqual({ label: c.label, traced: "native send\n" });
      }, 300_000);
    }
    test("a value outside the incumbent's integer grammar is the default cap, not a skipped check", () => {
      // The deliberate divergence: a value outside the incumbent's integer
      // grammar is the default cap, not a skipped check.
      const fx = fixture();
      const malformed = send(fx, "send", ["ub", "-m", "x".repeat(102_401)], "ua", { TAP_INLINE_MAX_BYTES: "lots" });
      expect({ code: malformed.code, payloads: payloads(fx.bus).length, traced: malformed.traced }).toEqual({ code: 1, payloads: 0, traced: "native send\n" });
      expect(malformed.err).toContain("(limit 102400)");
    }, 300_000);
  });
});

