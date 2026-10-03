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
// byte-equality assertion between the two doors' full stderr/stdout. The
// rollback selector that used to force that arm through route() is gone
// (5de960f46), and the Bash bodies retire in the next lanes, so that arm is
// deleted rather than kept as a placebo. The full-byte cross-door equality
// was never itself the sole evidence for a specific claim — the substrings
// asserted below (`toContain`) are native's own assertion of the behavior
// that matters — so no new freeze is needed here.
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

  test("an order-shaped plain note is refused natively, with no durable effect", () => {
    for (const form of ["-m", "-f"] as const) {
      const fx = fixture();
      const body = join(fx.root, "order.md"); writeFileSync(body, ORDER);
      const r = send(fx, "send", ["ub", form, form === "-m" ? ORDER : body]);
      expect({ form, code: r.code, durable: durable(fx) }).toEqual({ form, code: 2, durable: { payloads: 0, receipts: 0, spool: 0 } });
      expect(r.err).toContain("reads like a work order");
      expect(r.err).toContain("tap assign ub -f <path>");
      expect(r.err).toContain("tap send ub --note -f <path>");
      // Refused NATIVELY: the trace shows the native handler and no fallback line.
      expect(r.traced).toBe("native send\n");
    }
  }, 120_000);

  test("the refusal names the destination as typed, not the forwarded seat", () => {
    const fx = fixture((doc) => {
      doc.seat_forwardings = [{
        source: "old", source_instance: "old|A", destination: "ub", destination_instance: "ub|A",
        at: "2026-09-15T00:00:00Z", address_active: true,
      }];
    });
    const r = send(fx, "send", ["old", "-m", ORDER]);
    expect({ code: r.code, durable: durable(fx) }).toEqual({ code: 2, durable: { payloads: 0, receipts: 0, spool: 0 } });
    expect(r.err).toContain("tap assign old -f <path>");
    expect(r.err).not.toContain("tap assign ub");
    expect(r.traced).toBe("native send\n");
  }, 120_000);
});
