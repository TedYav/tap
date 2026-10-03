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
// so that arm is deleted rather than kept as a placebo: each row's expected
// code/payloads already comes from `row.shaped`, not from the retired
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

  describe("engine-boundary rows from the differential give the incumbent's verdict through -f", () => {
    // Each row is a body where a JavaScript default diverged from the incumbent's
    // Python semantics; the verdict is the incumbent's own, reproduced natively.
    const rows: Array<{ label: string; body: string; shaped: boolean }> = [
      { label: "leading BOM before a fence: the BOM is body, the fence is not stripped", body: "﻿---\nre: x\n---\n" + ORDER, shaped: true },
      { label: "CR-only line boundaries", body: "## Plan\rNEXT ITEM: tap-oglkh — start now.\r", shaped: true },
      { label: "heading indented by U+001F (Python \\s)", body: "\u001f## Plan\n\nNEXT ITEM: tap-oglkh — start now.\n", shaped: true },
      { label: "Greek letter glued to the bead id: no Unicode word boundary", body: "## Plan\n\nNEXT ITEM: αtap-oglkh — start now.\n", shaped: false },
      { label: "lowercase marker phrase, SHOUTY marker absent", body: "## Plan\n\nnext item: tap-oglkh — start now.\n", shaped: true },
      { label: "bead id alone", body: "status: tap-oglkh is merged.\n", shaped: false },
      // -f stages the body under a synthetic empty envelope, so the body's OWN
      // leading fence block is body: its bead id counts. Judging the raw file
      // instead would strip it and license the send.
      { label: "body-level fence block: the synthetic envelope is what gets stripped", body: "---\nid: tap-oglkh\n---\n## Plan\n\nNEXT ITEM: start now.\n", shaped: true },
    ];
    for (const row of rows) {
      test(row.label, () => {
        const fx = fixture();
        const body = join(fx.root, "row.md"); writeFileSync(body, row.body);
        const r = send(fx, "send", ["ub", "-f", body]);
        expect({ label: row.label, code: r.code, payloads: payloads(fx.bus).length })
          .toEqual({ label: row.label, code: row.shaped ? 2 : 0, payloads: row.shaped ? 0 : 1 });
        expect({ label: row.label, traced: r.traced }).toEqual({ label: row.label, traced: "native send\n" });
      }, 240_000);
    }
  });
});

