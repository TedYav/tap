// tap_serial_triggers "runtime/bun/test/support/send-reply-flip-fixture.ts" "runtime/bun/main.ts" "runtime/bun/test/support/native-send-entry.ts" "skills/tap/scripts/lib.sh"
// send-cutover-redelivery — budget split of the former send-cutover-spool
// paired scenarios (Deliverable B unit 1). The test bodies below are verbatim
// moves; the describe string matches send-cutover-spool.test.ts on purpose so
// pattern-based selection keeps covering the whole scenario family. The
// shared fixture and helpers live in ./support/send-reply-flip-fixture.ts and
// this file registers its own scratch cleanup.
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

describe("native cutover shared-spool parity", () => {
  const scripts = join(import.meta.dir, "../../../skills/tap/scripts");
  function door(fx: ReturnType<typeof teamFixture>, native: boolean, argv: string[]) {
    return Bun.spawnSync(native ? [process.execPath, MAIN, ...argv] : ["bash", join(scripts, "../../../bin/tap"), ...argv], {
      cwd: fx.wt, env: { ...fx.env, TAP_BUN_ROUTE_TRACE: join(fx.root, "cutover.trace"), TAP_SPOOL_DRAIN_ACTIVE: "1",
        // The mock tmux shim has no redraw race, so the courier's settle pacing
        // only adds wall time here; the same scale the drain() helper below
        // already uses. Timeout and grace semantics never route through
        // tap_settle, so scenario deadlines are unaffected.
        TAP_TUI_SETTLE_SCALE: "0.1" },
      // tap-7r3fn.166: the child cap must keep every body's budget above the
      // sum of its spawn caps (tap-7r3fn.146 invariant). Measured healthy
      // whole bodies span 0.6-2.9s (junit census at 1f3a4f006, 2026-10-02);
      // children here run sequentially, so a body duration upper-bounds each
      // of its children, and 6000ms clears the worst measured body by >2x
      // while fitting the tightest budget (three doors inside 20s; fixture
      // overhead is an allowance, not a separately timed decomposition). The
      // old 15000ms let 2-3 calls sum past several bodies' budgets. Revisit
      // the sizing if any single child exceeds 3000ms (half the cap).
      // SIGKILL makes the cap a hard bound on a child
      // that ignores TERM, consistent with run() below in the spool file.
      stdout: "pipe", stderr: "pipe", timeout: 6000, killSignal: "SIGKILL",
    });
  }
  for (const native of [false, true]) {
    const label = native ? "native" : "bash";
    test(`${label}: a parked draft redelivers exactly once; a resend of the unread message re-rings under the same id`, () => {
      const fx = teamFixture({});
      writeFileSync(fx.env.FAKE_BAND!, "unfinished human draft");
      const result = door(fx, native, ["send", "ub", "--ask", "-m", "hello", "--from", "ua"]);
      expect(result.exitCode).toBe(0);
      const id = placed(fx.bus)[0]!.replace(/\.placed$/, "");
      assertParked(fx, id, "pending-input");
      unlinkSync(fx.env.FAKE_BAND!);
      // Same tap-7r3fn.166 cap as door(): three drain calls plus two doors
      // must stay under this body's 40s budget.
      const drain = () => Bun.spawnSync(["bash", "-c", '. "$1/smoke/runtime-helpers.sh"; . "$1/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once', "drain", scripts], {
        cwd: fx.wt, env: { ...fx.env, TAP_TUI_SETTLE_SCALE: "0.1" }, stdout: "pipe", stderr: "pipe", timeout: 6000, killSignal: "SIGKILL",
      });
      expect(drain().exitCode).toBe(0);
      // A second observation confirms the empty composer after the shared draft hold.
      Bun.sleepSync(260);
      const secondDrain = drain();
      expect(secondDrain.exitCode).toBe(0);
      expect(existsSync(join(fx.bus, "receipts", `${id}.sent`)), JSON.stringify({stderr: secondDrain.stderr.toString(), meta: existsSync(join(fx.bus, "spool", `${id}.meta.json`)) ? readFileSync(join(fx.bus, "spool", `${id}.meta.json`), "utf8") : "gone"})).toBe(true);
      expect(existsSync(join(fx.bus, "spool", `${id}.md`))).toBe(false);
      expect(existsSync(join(fx.bus, "spool", `${id}.meta.json`))).toBe(false);
      expect(readFileSync(fx.env.FAKE_BAND!, "utf8")).toContain(id);
      const keys = readFileSync(fx.env.FAKE_KEYS!, "utf8");
      expect(drain().exitCode).toBe(0);
      expect(readFileSync(fx.env.FAKE_KEYS!, "utf8")).toBe(keys);
      const resend = door(fx, false, ["resend", id, "--by", "ua", "--json"]);
      expect(resend.exitCode).toBe(0);
      // tap-7r3fn.166 killed-child control: a cap-killed resend must fail
      // here, not pass as a plausible refusal. The not-0 check alone accepts
      // one (exitCode null), the signal guard accepts a child that handles
      // SIGTERM and exits 1 after the timeout (astra-ponytail probe
      // 9dd526bfc453), so reject both: a normal exit carries no signalCode
      // (undefined, hence ?? null), and exitedDueToTimeout is true whenever
      // the cap fired, regardless of how the child then exited.
      expect(resend.signalCode ?? null).toBeNull();
      expect(resend.exitedDueToTimeout).toBe(false);
      // Delivered but unread: the same id is re-parked as a retry row (decision-v1 L2); no successor.
      expect(JSON.parse(resend.stdout.toString())).toMatchObject({ status: "queued", id, ordinal: 1 });
      expect(JSON.parse(readFileSync(join(fx.bus, "spool", `${id}.meta.json`), "utf8"))).toMatchObject({ reason: "retry", retry_ordinal: 1 });
      expect(existsSync(join(fx.bus, "receipts", `${id}.resent`))).toBe(false);
    }, 40_000);

    test(`${label}: a resend of a send still waiting for its first delivery coalesces`, () => {
      const fx = teamFixture({});
      writeFileSync(fx.env.FAKE_BAND!, "unfinished human draft");
      const first = door(fx, native, ["send", "ub", "--ask", "-m", "hello", "--from", "ua"]);
      expect(first.exitCode).toBe(0);
      const id = placed(fx.bus)[0]!.replace(/\.placed$/, "");
      assertParked(fx, id, "pending-input");
      const resent = door(fx, false, ["resend", id, "--by", "ua", "--json"]);
      expect(resent.exitCode).toBe(0);
      expect(JSON.parse(resent.stdout.toString())).toMatchObject({ status: "pending", id });
      expect(existsSync(join(fx.bus, "receipts", `${id}.resent`))).toBe(false);
      expect(existsSync(join(fx.bus, "spool", `${id}.md`))).toBe(true);
    }, 30_000);

    test(`${label}: an unverified attempt does not stamp a delivery clock`, () => {
      const fx = teamFixture({});
      writeFileSync(fx.env.FAKE_ENTER_FAIL!, "1");
      const result = door(fx, native, ["send", "ub", "--ask", "-m", "hello", "--from", "ua"]);
      expect(result.exitCode).toBe(5);
      const id = payloads(fx.bus)[0]!.replace(/\.md$/, "");
      expect(JSON.parse(readFileSync(join(fx.bus, "spool", `${id}.meta.json`), "utf8")).reason).toBe("staged-idle");
      expect(existsSync(join(fx.bus, "spool", `${id}.md`))).toBe(true);
      expect(existsSync(join(fx.bus, "delivery", "ub.json"))).toBe(false);
      expect(payloads(fx.bus)).toHaveLength(1);
    }, 20_000);

    test(`${label}: an unverified staged hold can be withdrawn by its sender`, () => {
      const fx = teamFixture({});
      writeFileSync(fx.env.FAKE_ENTER_FAIL!, "1");
      expect(door(fx, native, ["send", "ub", "--ask", "-m", "hello", "--from", "ua"]).exitCode).toBe(5);
      const id = payloads(fx.bus)[0]!.replace(/\.md$/, "");
      const premature = door(fx, native, ["withdraw", id, "--by", "ua", "-m", "superseded", "--json"]);
      expect(premature.exitCode).toBe(1);
      expect(JSON.parse(premature.stdout.toString()).error_class).toBe("not_delivered");
      const cancelled = door(fx, native, ["cancel", id, "--by", "ua", "--spooled"]);
      expect(cancelled.exitCode, cancelled.stderr.toString()).toBe(0);
      expect(existsSync(join(fx.bus, "archive", `${id}.cancelled.md`))).toBe(true);
      expect(existsSync(join(fx.bus, "spool", `${id}.md`))).toBe(false);
      expect(existsSync(join(fx.bus, "spool", `${id}.meta.json`))).toBe(false);
      expect(existsSync(join(fx.bus, "receipts", `${id}.cancelled`))).toBe(true);
    }, 20_000);

    test(`${label}: recipient read retires an unverified staged copy`, () => {
      const fx = teamFixture({});
      writeFileSync(fx.env.FAKE_ENTER_FAIL!, "1");
      expect(door(fx, native, ["send", "ub", "-m", "hello", "--from", "ua"]).exitCode).toBe(5);
      const id = payloads(fx.bus)[0]!.replace(/\.md$/, "");
      const claim = join(fx.bus, "spool", `${id}.claim`);
      writeFileSync(claim, "held");
      const busy = door(fx, native, ["read", id, "--by", "ub"]);
      expect(busy.exitCode).toBe(1);
      expect(busy.stderr.toString()).toContain("staged-idle copy");
      expect(existsSync(join(fx.bus, "receipts", `${id}.done`))).toBe(false);
      unlinkSync(claim);
      const read = door(fx, native, ["read", id, "--by", "ub"]);
      expect(read.exitCode, read.stderr.toString()).toBe(0);
      expect(existsSync(join(fx.bus, "receipts", `${id}.done`))).toBe(true);
      expect(existsSync(join(fx.bus, "spool", `${id}.md`))).toBe(false);
      expect(existsSync(join(fx.bus, "spool", `${id}.meta.json`))).toBe(false);
    }, 20_000);

    test(`${label}: reply settlement retires an unverified staged copy`, () => {
      const fx = teamFixture({});
      writeFileSync(fx.env.FAKE_ENTER_FAIL!, "1");
      expect(door(fx, native, ["send", "ub", "--ask", "-m", "hello", "--from", "ua"]).exitCode).toBe(5);
      const id = payloads(fx.bus)[0]!.replace(/\.md$/, "");
      const reply = door(fx, native, ["reply", id, "-m", "answer", "--by", "ub"]);
      expect(reply.exitCode, reply.stderr.toString()).toBe(0);
      expect(existsSync(join(fx.bus, "receipts", `${id}.done`))).toBe(true);
      expect(existsSync(join(fx.bus, "spool", `${id}.md`))).toBe(false);
      expect(existsSync(join(fx.bus, "spool", `${id}.meta.json`))).toBe(false);
    }, 20_000);
  }
});
