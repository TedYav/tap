// tap_serial_triggers "runtime/bun/test/support/send-reply-flip-fixture.ts" "runtime/bun/main.ts" "runtime/bun/test/support/native-send-entry.ts" "runtime/bun/test/support/native-reply-entry.ts" "runtime/bun/test/support/reenabled-router-entry.ts" "skills/tap/scripts/lib.sh"
// send-census-bounds — component split out of the former
// runtime/bun/test/send-reply-flip.test.ts (Deliverable B unit 1). The test
// bodies below are verbatim moves; the shared fixture and helpers live in
// ./support/send-reply-flip-fixture.ts and this file registers its own
// scratch cleanup. The clear-fence, fallback, refusal, driver-tracing
// and epoch scenarios of the same describe live in
// send-census-fences-routing.test.ts (budget split; row bytes unchanged).
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

describe("census compatibility bounds", () => {
  test("a poll-recipient send places without recipient pane observation and stays poll-visible", () => {
    const fx = teamFixture({
      seats: { pollbot: { status: "active", delivery: "poll", instance: "pollbot|A" } },
    });
    const result = Bun.spawnSync(
      [process.execPath, NATIVE_SEND, "pollbot", "-m", "hello", "--from", "ua", "--ask", "--id", "ua-20260831T010000Z-aabbccddeeff"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("tap send: queued ua-20260831T010000Z-aabbccddeeff");
    expect(existsSync(join(fx.bus, "payloads", "ua-20260831T010000Z-aabbccddeeff.md"))).toBe(true);
    expect(paneObserveCount(fx)).toBe(0);
    const poll = Bun.spawnSync([process.execPath, MAIN, "poll", "pollbot"], {
      cwd: fx.wt, env: { ...fx.env, TAP_SELF: "pollbot" }, stdout: "pipe", stderr: "pipe",
    });
    expect(poll.exitCode).toBe(2);
    expect(poll.stdout.toString()).toContain("ua-20260831T010000Z-aabbccddeeff");
  });

  test("a busy-pane native send reports lock-park and stays spooled for redelivery", () => {
    const fx = teamFixture({});
    const held = acquirePaneLock("%7", 5000, fx.env);
    expect(held).not.toBeNull();
    try {
      const result = Bun.spawnSync(
        [process.execPath, NATIVE_SEND, "ub", "-m", "hello", "--from", "ua", "--ask", "--id", "ua-20260831T010100Z-aabbccddeeff"],
        { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("tap send: queued ua-20260831T010100Z-aabbccddeeff");
      expect(existsSync(join(fx.bus, "payloads", "ua-20260831T010100Z-aabbccddeeff.md"))).toBe(false);
      expect(existsSync(join(fx.bus, "receipts", "ua-20260831T010100Z-aabbccddeeff.sent"))).toBe(false);
      assertParked(fx, "ua-20260831T010100Z-aabbccddeeff", "lock-park");
      expect(existsSync(join(fx.bus, "receipts", "ua-20260831T010100Z-aabbccddeeff.attempted"))).toBe(false);
    } finally {
      held!.release();
    }
  }, 30_000);

  test("copy-mode native send parks with zero injection when copy mode starts after placement", async () => {
    const fx = teamFixture({ parkAfter: 2 });
    const id = "ua-20260831T010202Z-aabbccddeeff";
    const send = Bun.spawn(
      [process.execPath, NATIVE_SEND, "ub", "-m", "hello", "--from", "ua", "--ask", "--id", id],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    waitFor(fx.reached);
    writeFileSync(join(fx.root, "pane-in-mode"), "1\n");
    writeFileSync(fx.release, "go\n");
    expect(await send.exited).toBe(0);
    assertParked(fx, id, "copy-mode");
    expect(existsSync(fx.env.FAKE_SUBMITTED!)).toBe(false);
    expect(existsSync(join(fx.root, "keys"))).toBe(false);
  }, 30_000);

  test("copy-mode native send cancels and delivers", () => {
    const fx = teamFixture({});
    writeFileSync(join(fx.root, "pane-in-mode"), "1\n");
    const result = Bun.spawnSync(
      [process.execPath, NATIVE_SEND, "ub", "-m", "hello", "--from", "ua", "--ask", "--id", "ua-20260831T010200Z-aabbccddeeff"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toBe("tap send: ok ua-20260831T010200Z-aabbccddeeff\n");
    const id = "ua-20260831T010200Z-aabbccddeeff";
    expect(existsSync(join(fx.bus, "payloads", `${id}.md`))).toBe(true);
    expect(existsSync(join(fx.bus, "receipts", `${id}.sent`))).toBe(true);
    expect(existsSync(join(fx.root, "keys"))).toBe(true);
    expect(existsSync(join(fx.env.FAKE_SUBMITTED!))).toBe(true);
    expect(existsSync(join(fx.root, "pane-in-mode"))).toBe(false);
    expect(existsSync(join(fx.bus, "spool"))).toBe(false);
  }, 30_000);

  test("copy-mode native send --json reports the delivered disposition", () => {
    const fx = teamFixture({});
    writeFileSync(join(fx.root, "pane-in-mode"), "1\n");
    const id = "ua-20260831T010201Z-aabbccddeeff";
    const result = Bun.spawnSync(
      [process.execPath, NATIVE_SEND, "ub", "-m", "hello", "--from", "ua", "--ask", "--id", id, "--json"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    const rec = JSON.parse(result.stdout.toString().trim().split("\n").at(-1)!);
    expect(rec.status).toBe("injected");
    expect(rec.delivery).toBe("pane");
    expect(rec.turn).toBe("unconfirmed");
    expect(rec.reason).toBeUndefined();
    expect(existsSync(join(fx.bus, "payloads", `${id}.md`))).toBe(true);
    expect(existsSync(join(fx.root, "pane-in-mode"))).toBe(false);
  }, 30_000);

  // tap-7r3fn.146. Two budget invariants, learned from a PR-event gate red (run
  // 34372336819) that a same-head dispatch run passed green. Each subprocess is
  // a full re-enabled-entry send: bun cold-start + `tap.sh` sourcing lib.sh +
  // python3. Observed single-test durations: 13.6s locally and 15.1s on a
  // reviewer's box (both under the old 15000ms budget by little or not at all),
  // 15124ms on the red CI run; a per-send share is thus ~6-8s. So:
  //   (1) A per-subprocess kill-cap near the send's own duration can SIGKILL a
  //       healthy-but-slow send (a finite cap cannot tell slowness from a hang).
  //       SIGKILL reaches only the bun pid, orphaning its bash/python children
  //       (cwd inside the runner scratch), which then own the scratch and make
  //       run.sh's lsof guard correctly refuse cleanup — a gate red with no
  //       assertion position. The 8000ms cap sat right at the observed per-send
  //       duration; 15000ms (matching the sibling re-enabled sends below) leaves
  //       room for a slow-but-healthy send while still bounding a true hang.
  //   (2) The test-level budget must exceed the SUM of the subprocess caps plus
  //       fixture overhead, or the test can abort mid-second-spawn: the 16000ms
  //       two-cap sum already exceeded the old 15000ms budget. 40_000ms clears
  //       2×15000 with headroom.
  // Do NOT weaken the scratch guard (scratch.ts / run.sh): it behaved correctly,
  // and under a budget where healthy sends complete there are no orphans to reap.
  test("poll and unattended senders trace native through the re-enabled entry", () => {
    const pollSender = teamFixture({
      seats: { ua: { status: "active", delivery: "poll", instance: "ua|A" } },
    });
    const pollTrace = join(pollSender.root, "route.trace");
    const pollResult = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "ua"],
      { cwd: pollSender.wt, env: { ...pollSender.env, TAP_BUN_ROUTE_TRACE: pollTrace, TAP_AUTOSETTLE_HOLD_SECONDS: "3600" }, stdout: "pipe", stderr: "pipe", timeout: 15000, killSignal: "SIGKILL" },
    );
    // Assert the send actually COMPLETED, not just that a trace file exists: a
    // SIGKILL'd send writes "bash send" before dying, so the trace check alone
    // would false-green a killed send (whose orphaned children then own the
    // scratch). exitCode 0 means the send finished; exitCode null/negative means
    // it was killed and fails here with a position instead of as invalid gate
    // evidence. Fully eliminating SIGKILL-orphaning is tracked in tap-7r3fn.166.
    expect(pollResult.exitCode).toBe(0);
    expect(readFileSync(pollTrace, "utf8")).toBe("native send\n");

    const ghost = teamFixture({
      seats: { ua: { status: "active", pane: "ua:0.0", pane_id: "%6", server_epoch: "srv:123:456", instance: "ua|A", harness: "claude", unattended: true } },
    });
    const ghostTrace = join(ghost.root, "route.trace");
    const ghostResult = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "ua"],
      { cwd: ghost.wt, env: { ...ghost.env, TAP_BUN_ROUTE_TRACE: ghostTrace, TAP_AUTOSETTLE_HOLD_SECONDS: "3600" }, stdout: "pipe", stderr: "pipe", timeout: 15000, killSignal: "SIGKILL" },
    );
    expect(ghostResult.exitCode).toBe(0);
    expect(readFileSync(ghostTrace, "utf8")).toBe("native send\n");
  }, 40_000);

  test("nested reply stamps in_reply_to on the outbound canonical", () => {
    const inboundId = "ub-20260831T010400Z-aabbccddeeff";
    const fx = teamFixture({ inbound: { id: inboundId, from: "ub", to: "ua" } });
    const result = Bun.spawnSync(
      [process.execPath, NATIVE_REPLY, inboundId, "-m", "answer", "--by", "ua"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    const outbound = payloads(fx.bus).find((name) => name !== `${inboundId}.md`);
    expect(outbound).toBeTruthy();
    expect(envelopeField(readFileSync(join(fx.bus, "payloads", outbound!), "utf8"), "in_reply_to")).toBe(inboundId);
    expect(JSON.parse(readFileSync(join(fx.bus, "receipts", `${inboundId}.done`), "utf8")).via).toBe("reply");
  });

  test("a live-flip plain note is judged natively then delivers; --ask and nested reply stay native", () => {
    function liveHome(fx: ReturnType<typeof teamFixture>): NodeJS.ProcessEnv {
      // A fresh empty HOME keeps operator state out of the native-door test.
      const home = join(fx.root, "home");
      mkdirSync(join(home, ".tap"), { recursive: true });
      return { ...fx.env, HOME: home };
    }

    const park = teamFixture({});
    const parkTrace = join(park.root, "route.trace");
    const parked = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "ua"],
      {
        cwd: park.wt,
        env: {
          ...liveHome(park),
          TAP_SPOOL_DISABLE_OPPORTUNISTIC: "1",
          TAP_BUN_ROUTE_TRACE: parkTrace,
          TAP_AUTOSETTLE_HOLD_SECONDS: "3600",
          TAP_DRIVER_FORCE_TMUX: "1",
          TAP_TUI_SETTLE_SCALE: "0.1",
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15000,
        killSignal: "SIGKILL",
      },
    );
    expect(parked.exitCode).toBe(0);
    // Every other assertion in this block is unchanged from the Bash-guard era:
    // the plain note is judged natively (not shaped) and native delivery then
    // reaches the pane and settles nothing — the same observable outcome.
    expect(readFileSync(parkTrace, "utf8")).toBe("native send\n");
    expect(payloads(park.bus)).toHaveLength(1);
    expect(existsSync(park.env.FAKE_SUBMITTED as string)).toBe(true);
    const noteId = payloads(park.bus)[0]!.replace(/\.md$/, "");
    expect(existsSync(join(park.bus, "receipts", `${noteId}.done`))).toBe(false);

    const ask = teamFixture({});
    const askTrace = join(ask.root, "route.trace");
    const asked = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "ua", "--ask"],
      {
        cwd: ask.wt,
        env: {
          ...liveHome(ask),
          TAP_BUN_ROUTE_TRACE: askTrace,
          TAP_DRIVER_FORCE_TMUX: "1",
          TAP_TUI_SETTLE_SCALE: "0.1",
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15000,
        killSignal: "SIGKILL",
      },
    );
    expect(asked.exitCode).toBe(0);
    expect(readFileSync(askTrace, "utf8")).toBe("native send\n");
    expect(payloads(ask.bus)).toHaveLength(1);
    expect(placed(ask.bus)).toHaveLength(1);
    expect(existsSync(join(ask.bus, "spool"))).toBe(false);
    expect(envelopeField(readFileSync(join(ask.bus, "payloads", payloads(ask.bus)[0]!), "utf8"), "reply")).toBe("expected");

    const alias = teamFixture({});
    const aliasTrace = join(alias.root, "route.trace");
    const aliased = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "ua", "--reply"],
      {
        cwd: alias.wt,
        env: {
          ...liveHome(alias),
          TAP_BUN_ROUTE_TRACE: aliasTrace,
          TAP_DRIVER_FORCE_TMUX: "1",
          TAP_TUI_SETTLE_SCALE: "0.1",
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15000,
        killSignal: "SIGKILL",
      },
    );
    expect(aliased.exitCode).toBe(0);
    expect(readFileSync(aliasTrace, "utf8")).toBe("native send\n");
    expect(payloads(alias.bus)).toHaveLength(1);
    expect(envelopeField(readFileSync(join(alias.bus, "payloads", payloads(alias.bus)[0]!), "utf8"), "reply")).toBe("expected");

    const inboundId = "ub-20260902T180100Z-aabbccddeeff";
    const replyFx = teamFixture({ inbound: { id: inboundId, from: "ub", to: "ua" } });
    const replied = Bun.spawnSync(
      [process.execPath, NATIVE_REPLY, inboundId, "-m", "answer", "--by", "ua"],
      { cwd: replyFx.wt, env: replyFx.env, stdout: "pipe", stderr: "pipe" },
    );
    expect(replied.exitCode).toBe(0);
    const outbound = payloads(replyFx.bus).find((name) => name !== `${inboundId}.md`);
    expect(outbound).toBeTruthy();
    expect(envelopeField(readFileSync(join(replyFx.bus, "payloads", outbound!), "utf8"), "in_reply_to")).toBe(inboundId);
    // tap-7r3fn.146, same budget invariant: three 15000ms-capped subprocesses
    // sum to 45000ms, above the old 40_000ms budget. Latent (these native/ask
    // sends complete fast), but a killed slow send would orphan children into
    // the scratch guard exactly as the poll/unattended census did.
  }, 60_000);

  test("a courier-auto receipt still accepts a problem-report reply without a second .done", () => {
    const inboundId = "ub-20260831T010500Z-aabbccddeeff";
    const fx = teamFixture({ inbound: { id: inboundId, from: "ub", to: "ua" } });
    writeFileSync(join(fx.bus, "receipts", `${inboundId}.done`), `${JSON.stringify({
      id: inboundId, status: "done", at: "20260831T010500Z", by: "ua", via: "courier-auto",
    })}\n`);
    const before = readFileSync(join(fx.bus, "receipts", `${inboundId}.done`), "utf8");
    const result = Bun.spawnSync(
      [process.execPath, NATIVE_REPLY, inboundId, "-m", "problem: missing file", "--by", "ua"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(`tap reply: ok ${inboundId}\n`);
    expect(readFileSync(join(fx.bus, "receipts", `${inboundId}.done`), "utf8")).toBe(before);
    expect(payloads(fx.bus).some((name) => name !== `${inboundId}.md`)).toBe(true);
  });

  test("a team-qualified reply_to traces native reply through the router", () => {
    const inboundId = "ub-20260831T010600Z-aabbccddeeff";
    const fx = teamFixture({
      inbound: { id: inboundId, from: "ub", to: "ua", extra: { reply_to: "peerteam/alice" } },
    });
    const trace = join(fx.root, "route.trace");
    const result = Bun.spawnSync(
      [process.execPath, REENABLED, "reply", inboundId, "-m", "answer", "--by", "ua"],
      { cwd: fx.wt, env: { ...fx.env, TAP_BUN_ROUTE_TRACE: trace, TAP_TUI_SETTLE_SCALE: "0.1" }, stdout: "pipe", stderr: "pipe", timeout: 8000, killSignal: "SIGKILL" },
    );
    expect(readFileSync(trace, "utf8")).toBe("native reply\n");
    expect(result.stderr.toString()).not.toContain("is not an active seat on team");
    expect(result.exitCode).not.toBeUndefined();
  }, 15_000);

  test("a stored deliverable reply_to stamps on ordinary send", () => {
    const fx = teamFixture({
      seats: { ua: { status: "active", pane: "ua:0.0", pane_id: "%6", server_epoch: "srv:123:456", instance: "ua|A", harness: "claude", reply_to: "ub" } },
    });
    const send = Bun.spawnSync(
      [process.execPath, NATIVE_SEND, "ub", "-m", "hello", "--from", "ua", "--ask", "--id", "ua-20260831T011000Z-aabbccddeeff"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    expect(send.exitCode).toBe(0);
    expect(envelopeField(readFileSync(join(fx.bus, "payloads", "ua-20260831T011000Z-aabbccddeeff.md"), "utf8"), "reply_to")).toBe("flip/ub");
  });

  test("nested reply suppresses the actor's stored reply_to", () => {
    const inboundId = "ub-20260831T011000Z-aabbccddeeff";
    const fx = teamFixture({
      seats: { ua: { status: "active", pane: "ua:0.0", pane_id: "%6", server_epoch: "srv:123:456", instance: "ua|A", harness: "claude", reply_to: "ub" } },
      inbound: { id: inboundId, from: "ub", to: "ua" },
    });
    const reply = Bun.spawnSync(
      [process.execPath, NATIVE_REPLY, inboundId, "-m", "answer", "--by", "ua"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    expect(reply.exitCode).toBe(0);
    const outbound = payloads(fx.bus).find((name) => name !== `${inboundId}.md`);
    expect(outbound).toBeTruthy();
    expect(envelopeField(readFileSync(join(fx.bus, "payloads", outbound!), "utf8"), "reply_to")).toBeUndefined();
  });
});
