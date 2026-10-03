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
// straight into the retained tap.sh/tap-send.sh adapter) as a parity
// comparison. The rollback selector that used to force that arm through
// route() is gone (5de960f46), and the Bash bodies retire in the next lanes,
// so that arm is deleted rather than kept as a placebo: each case's expected
// code/payloads already comes from `c.admitted`, not from the retired
// cross-door comparison.
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

  describe("every exemption admits the same body; --kind digest is judged (a divergence this closed)", () => {
    const cases: Array<{ label: string; args: string[]; admitted: boolean }> = [
      { label: "--ask", args: ["--ask"], admitted: true },
      { label: "--note", args: ["--note"], admitted: true },
      { label: "--kind lane-request", args: ["--kind", "lane-request"], admitted: true },
      { label: "--kind probe", args: ["--kind", "probe"], admitted: true },
      { label: "--kind notice", args: ["--kind", "notice"], admitted: true },
      // The autosettle carve-out set is NOT the exemption set: the incumbent
      // judges a digest-kind note, and so does native now (it used to skip
      // the guard by delegating only for carve-out-eligible kinds).
      { label: "--kind digest", args: ["--kind", "digest"], admitted: false },
    ];
    for (const c of cases) {
      test(c.label, () => {
        const fx = fixture();
        const r = send(fx, "send", ["ub", "-m", ORDER, ...c.args]);
        expect({ label: c.label, code: r.code, payloads: payloads(fx.bus).length })
          .toEqual({ label: c.label, code: c.admitted ? 0 : 2, payloads: c.admitted ? 1 : 0 });
        if (!c.admitted) expect(r.err).toContain("reads like a work order");
        expect({ label: c.label, traced: r.traced }).toEqual({ label: c.label, traced: "native send\n" });
      }, 240_000);
    }
  });
});

