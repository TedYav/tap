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

describe("bin/tap sandbox route evidence", () => {
  for (const [marker, ask, route] of [
    ["live", true, "native"],
    // Checkpoint B also owns legacy-registry send construction.
    ["live", false, "native"],
  ] as const) {
    test(`${marker} marker, ${ask ? "ask" : "plain note"}: ${route} send`, () => {
      const fx = teamFixture({
        seats: { ub: { status: "active", delivery: "poll", instance: "ub|A" } },
      });
      // Legacy pre-flip lookup needs its own acting registry at the bus root.
      writeFileSync(join(fx.bus, "registry.json"), readFileSync(join(fx.wt, ".tap", "team-registry.json")));
      const trace = join(fx.root, "route.trace");
      const result = Bun.spawnSync([
        join(import.meta.dir, "..", "..", "..", "bin", "tap"),
        "send", "ub", "-m", "route evidence", "--from", "ua", ...(ask ? ["--ask"] : []),
      ], {
        cwd: fx.wt,
        env: { ...fx.env, TAP_BUN_ROUTE_TRACE: trace },
        stdout: "pipe", stderr: "pipe", timeout: 60_000,
      });
      expect(readFileSync(trace, "utf8")).toBe(`${route} send\n`);
      expect(result.exitCode).toBe(0);
      const messages = payloads(fx.bus);
      expect(messages).toHaveLength(1);
      const body = readFileSync(join(fx.bus, "payloads", messages[0]!), "utf8");
      expect(envelopeField(body, "reply")).toBe(ask ? "expected" : "settle-only");
      expect(body).toContain("route evidence");
    }, 65_000);
  }
});

// tap-dk19b: --note is the first settle-only form to run natively, in-process,
// with Bash's own kind/reply lint and byte-for-byte verdicts preserved as
// frozen literals below (the Bash comparison this used to run against is
// retired with the adapter).
describe("--note runs natively, refuses its conflicts, and skips only the guard", () => {
  const ORDER = "## Plan\n\nNEXT ITEM: tap-oglkh — read-back required, start now.\n";
  function send(fx: ReturnType<typeof teamFixture>, verb: string, args: string[]) {
    const trace = join(fx.root, `route.${Math.random().toString(36).slice(2)}.trace`);
    const result = Bun.spawnSync([join(import.meta.dir, "..", "..", "..", "bin", "tap"), verb, "ub", ...args, "--from", "ua"], {
      cwd: fx.wt,
      env: { ...fx.env, TAP_BUN_ROUTE_TRACE: trace },
      stdout: "pipe", stderr: "pipe", timeout: 60_000,
    });
    const traced = existsSync(trace) ? readFileSync(trace, "utf8") : "";
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString(), traced };
  }
  function fixture() {
    const fx = teamFixture({ seats: { ub: { status: "active", delivery: "poll", instance: "ub|A" } } });
    writeFileSync(join(fx.bus, "registry.json"), readFileSync(join(fx.wt, ".tap", "team-registry.json")));
    return fx;
  }

  test("a --note send is native, settle-only, and lands", () => {
    const fx = fixture();
    const r = send(fx, "send", ["-m", "confirmed note", "--note"]);
    expect(r.traced).toBe("native send\n");
    expect(r.code).toBe(0);
    const messages = payloads(fx.bus);
    expect(messages).toHaveLength(1);
    const body = readFileSync(join(fx.bus, "payloads", messages[0]!), "utf8");
    expect(envelopeField(body, "reply")).toBe("settle-only");
    expect(body).toContain("confirmed note");
  }, 65_000);

  test("--note skips the order-shape guard; a plain send of the same body is refused", () => {
    const fx = fixture();
    const body = join(fx.root, "order.md"); writeFileSync(body, ORDER);
    const plain = send(fx, "send", ["-f", body]);
    expect({ code: plain.code, payloads: payloads(fx.bus).length }).toEqual({ code: 2, payloads: 0 });
    expect(plain.err).toContain("reads like a work order");
    // The guard is in-process now, so a plain note never falls back to Bash.
    expect(plain.traced).toBe("native send\n");
    const noted = send(fx, "send", ["-f", body, "--note"]);
    expect({ code: noted.code, payloads: payloads(fx.bus).length }).toEqual({ code: 0, payloads: 1 });
    expect(noted.traced).toBe("native send\n");
  }, 120_000);

  test("--note with an ask spelling is refused with the incumbent's bytes, with no payload", () => {
    // FROZEN (native === the incumbent, measured at the branch point): the
    // parity comparison this test used to run against Bash was the sole
    // assertion of the exact refusal bytes.
    const REFUSAL = "tap send: pass either --note or --ask, not both; next: tap help send\n";
    for (const spelling of ["--ask", "--reply"]) {
      const fx = fixture();
      const r = send(fx, "send", ["-m", "x", "--note", spelling]);
      expect({ spelling, code: r.code, payloads: payloads(fx.bus).length }).toEqual({ spelling, code: 1, payloads: 0 });
      expect(r.err).toContain("pass either --note or --ask, not both");
      expect(r.traced).toBe("native send\n");
      expect(r.err).toBe(REFUSAL);
    }
  }, 120_000);

  // Review catch: the first settle-only pairing to run
  // natively must keep Bash's kind/reply lint (tap-send.sh, tap-iez4).
  test("--note --kind lane-request warns once with the incumbent's bytes and still lands settle-only; ordinary notes stay quiet", () => {
    const WARNING = "tap send: warning: kind=lane-request sent reply=settle-only — a work-order-shaped kind needs a tracked reply obligation (CONTRACT §using-tap); did you mean --ask?\n";
    const fx = fixture();
    const r = send(fx, "send", ["-m", "lane request as a note", "--note", "--kind", "lane-request"]);
    const messages = payloads(fx.bus);
    const reply = messages.length === 1 ? envelopeField(readFileSync(join(fx.bus, "payloads", messages[0]!), "utf8"), "reply") : "";
    expect({ code: r.code, payloads: messages.length, reply }).toEqual({ code: 0, payloads: 1, reply: "settle-only" });
    expect(r.err.split(WARNING).length - 1).toBe(1);
    expect(r.traced).toBe("native send\n");
    // FROZEN: the parity comparison this used to run against Bash was the
    // sole assertion that the warning is exactly this one line, no more.
    expect(r.err).toBe(WARNING);
    // Negative controls: an ordinary --note and a lane-request ASK print no lint.
    for (const args of [["--note"], ["--ask", "--kind", "lane-request"]]) {
      const q = fixture();
      const qr = send(q, "send", ["-m", "quiet", ...args]);
      expect({ args, code: qr.code, payloads: payloads(q.bus).length }).toEqual({ args, code: 0, payloads: 1 });
      expect(qr.err).not.toContain("warning: kind=");
      // FROZEN: the parity comparison this used to run against Bash was the
      // sole assertion that a quiet send prints nothing at all on stderr.
      expect(qr.err).toBe("");
    }
  }, 180_000);

  // D1: --fyi and assign are native, so these conflicts are refused in-process.
  test("--note --fyi and tap assign --note are refused natively with the incumbent's bytes", () => {
    // FROZEN (native === the incumbent, measured at the branch point): the
    // parity comparison this test used to run against Bash was the sole
    // assertion of these exact refusal bytes.
    const frozen = (verb: "send" | "assign"): { err: string; out: string } => verb === "send"
      ? { err: "tap send: --fyi and --note are the same claim; pass one; next: tap help send\n", out: "" }
      : { err: "tap send: tap assign is a work order and always expects a reply; --note names a note — use tap send; next: tap help assign\n", out: "" };
    for (const [verb, args] of [["send", ["-m", "x", "--note", "--fyi"]], ["assign", ["-m", "x", "--note"]]] as const) {
      const fx = fixture();
      const r = send(fx, verb, [...args]);
      expect({ verb, code: r.code, payloads: payloads(fx.bus).length }).toEqual({ verb, code: 1, payloads: 0 });
      expect({ verb, traced: r.traced }).toEqual({ verb, traced: `native ${verb}\n` });
      expect({ verb, err: r.err, out: r.out }).toEqual({ verb, ...frozen(verb) });
    }
    expect(send(fixture(), "send", ["-m", "x", "--note", "--fyi"]).err).toContain("--fyi and --note are the same claim; pass one");
    expect(send(fixture(), "assign", ["-m", "x", "--note"]).err).toContain("tap assign is a work order and always expects a reply; --note names a note");
  }, 120_000);
});
