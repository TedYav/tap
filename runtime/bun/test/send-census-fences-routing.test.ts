// tap_serial_triggers "runtime/bun/test/support/send-reply-flip-fixture.ts" "runtime/bun/main.ts" "runtime/bun/test/support/native-send-entry.ts" "runtime/bun/test/support/native-reply-entry.ts" "runtime/bun/test/support/reenabled-router-entry.ts" "skills/tap/scripts/lib.sh"
// send-census-fences-routing — budget split of the former
// send-census-bounds (Deliverable B unit 1). The test bodies below are
// verbatim moves; the describe string matches its sibling
// send-census-bounds.test.ts on purpose so pattern-based selection keeps
// covering the whole family. This file carries the clear-fence, fallback,
// refusal, driver-tracing and epoch scenarios.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { stampEnvelope, envelopeField } from "../src/envelope";
import { acquirePathLock, KERNEL_LOCK, kernelLockArgs } from "../src/panelock";
import { createHash } from "node:crypto";
import { receiptQueued, resolveOutboundEvidence } from "../src/verbs/reply";
import { Bus } from "../src/bus";
import { TapError } from "../src/context";
import { acquireResetMutationLock, resetFenceRefusal } from "../src/reset";
import { removeScratchTree } from "./support/scratch";
import { NATIVE_SEND, NATIVE_REPLY, REENABLED, teamFixture, spawnGit, waitFor, payloads, placed, assertParked, paneObserveCount, resetLockProbe, startPoller, flushScratch } from "./support/send-reply-flip-fixture";

afterEach(() => flushScratch(), 40_000);
describe("census compatibility bounds", () => {
  test("a live clear fence parks without injection", () => {
    const fx = teamFixture({});
    mkdirSync(join(fx.bus, "clear-fence"), { recursive: true });
    writeFileSync(join(fx.bus, "clear-fence", "ub.json"), JSON.stringify({
      since_epoch: Date.now() / 1000,
      ceiling_seconds: 600,
      pid: 1,
    }));
    const result = Bun.spawnSync(
      [process.execPath, NATIVE_SEND, "ub", "-m", "hello", "--from", "ua", "--ask", "--id", "ua-20260831T011200Z-aabbccddeeff"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("tap send: queued ua-20260831T011200Z-aabbccddeeff");
    expect(result.stdout.toString()).not.toContain("; clearing");
    expect(existsSync(join(fx.bus, "payloads", "ua-20260831T011200Z-aabbccddeeff.md"))).toBe(false);
    expect(existsSync(join(fx.bus, "receipts", "ua-20260831T011200Z-aabbccddeeff.sent"))).toBe(false);
    assertParked(fx, "ua-20260831T011200Z-aabbccddeeff", "clearing");
    // Sender authorization plus the shared park notification recheck.
  });

  test("an undeliverable bare reply_to falls back to from", () => {
    const inboundId = "ghost-20260831T011300Z-aabbccddeeff";
    const fx = teamFixture({
      inbound: { id: inboundId, from: "ub", to: "ua", extra: { reply_to: "gone" } },
    });
    const result = Bun.spawnSync(
      [process.execPath, NATIVE_REPLY, inboundId, "-m", "answer", "--by", "ua"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toContain("falling back to the original sender 'ub'");
    const outbound = payloads(fx.bus).find((name) => name !== `${inboundId}.md`);
    expect(outbound).toBeTruthy();
    expect(envelopeField(readFileSync(join(fx.bus, "payloads", outbound!), "utf8"), "to")).toBe("ub");
    expect(existsSync(join(fx.bus, "receipts", `${inboundId}.done`))).toBe(true);
  });

  test("a settle-only inbound warns and still replies", () => {
    const inboundId = "ub-20260831T013100Z-aabbccddeeff";
    const fx = teamFixture({
      inbound: { id: inboundId, from: "ub", to: "ua", extra: { reply: "settle-only" } },
    });
    const result = Bun.spawnSync(
      [process.execPath, NATIVE_REPLY, inboundId, "-m", "problem: missing file", "--by", "ua"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toContain("reply=settle-only");
    expect(result.stderr.toString()).toContain("sender did not want a reply");
    expect(existsSync(join(fx.bus, "receipts", `${inboundId}.done`))).toBe(true);
    expect(payloads(fx.bus).some((name) => name !== `${inboundId}.md`)).toBe(true);
  });

  test("a direct reply to an unattended sender refuses without the allow flag", () => {
    const inboundId = "ghost-20260831T011400Z-aabbccddeeff";
    const fx = teamFixture({
      seats: { ub: { status: "active", pane: "ub:0.0", pane_id: "%7", server_epoch: "srv:123:456", instance: "ub|A", harness: "claude", unattended: true } },
      inbound: { id: inboundId, from: "ub", to: "ua" },
    });
    const result = Bun.spawnSync(
      [process.execPath, NATIVE_REPLY, inboundId, "-m", "answer", "--by", "ua"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("unattended");
    expect(existsSync(join(fx.bus, "receipts", `${inboundId}.done`))).toBe(false);
    expect(payloads(fx.bus)).toEqual([`${inboundId}.md`]);
  });

  // D4d: the bare-id local miss no longer delegates — the shared resolver walks
  // the enrolled buses natively, and an id on no bus is the RESOLVER's own
  // `not_found` sentence (payload-view.ts: `no payload '<id> tried: …' on this
  // bus or any enrolled team bus`, the same function the incumbent calls
  // through `tap_bun_call reply-reference`), measured on CI run 35142188510.
  test("a bare reply id missing from every bus refuses natively (D4d) with the shared resolver's not_found line", () => {
    const fx = teamFixture({});
    const missingId = "ub-20260831T012000Z-deadbeefcafe";
    const trace = join(fx.root, "route.trace");
    const result = Bun.spawnSync(
      [process.execPath, REENABLED, "reply", missingId, "-m", "answer", "--by", "ua"],
      { cwd: fx.wt, env: { ...fx.env, TAP_BUN_ROUTE_TRACE: trace }, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(1);
    const stderr = result.stderr.toString();
    expect(stderr).toStartWith(`tap reply: no payload '${missingId} tried: `);
    expect(stderr).toContain("' on this bus or any enrolled team bus; next: tap poll; tap teams; ask the sender for the payload id or path; with that path in hand, tap reply <id> --payload <abs-path-from-sentinel> -f <file>\n");
    expect(readFileSync(trace, "utf8")).toBe("native reply\n");
    expect(existsSync(join(fx.bus, "payloads", `${missingId}.md`))).toBe(false);
    expect(existsSync(join(fx.bus, "receipts", `${missingId}.done`))).toBe(false);
  });

  test("an unusable configured delivery driver refuses natively before placement", () => {
    const fx = teamFixture({});
    mkdirSync(join(fx.env.XDG_CONFIG_HOME as string, "tap"), { recursive: true });
    writeFileSync(join(fx.env.XDG_CONFIG_HOME as string, "tap", "config.toml"), "[harness.claude]\ndriver = \"notwired\"\n", { mode: 0o600 });
    const trace = join(fx.root, "route.trace");
    const result = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "ua", "--ask"],
      { cwd: fx.wt, env: { ...fx.env, TAP_BUN_ROUTE_TRACE: trace, TAP_TUI_SETTLE_SCALE: "0.1" }, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(trace, "utf8")).toBe("native send\n");
    expect(existsSync(join(fx.env.FAKE_SUBMITTED as string))).toBe(false);
    expect(payloads(fx.bus)).toEqual([]);
    expect(readdirSync(join(fx.bus, "receipts"))).toEqual([]);
  }, 15_000);

  test("a launching recipient refuses seat_launching natively before any observation or canonical", () => {
    const fx = teamFixture({
      seats: { ub: { status: "active", status_reason: "launching", pane: "ub:0.0", pane_id: "%7", server_epoch: "srv:123:456", instance: "ub|A", harness: "claude" } },
    });
    const trace = join(fx.root, "route.trace");
    const result = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "ua"],
      { cwd: fx.wt, env: { ...fx.env, TAP_BUN_ROUTE_TRACE: trace }, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(1);
    expect(readFileSync(trace, "utf8")).toBe("native send\n");
    expect(result.stderr.toString()).toBe("tap send: 'ub' is bound but still launching; next: tap team\n");
    expect(paneObserveCount(fx)).toBe(0);
    expect(payloads(fx.bus)).toEqual([]);
    expect(readdirSync(join(fx.bus, "receipts"))).toEqual([]);
  });

  for (const expired of [false, true]) test(`a ${expired ? "grace-expired" : "live"} pending recipient refuses seat_pending natively with no placement, receipt, observation or injection (tap-5exht)`, () => {
    const fx = teamFixture({
      seats: { ub: { status: "pending", session: "ub-launch", registered_at: expired ? "2026-01-01T00:00:00Z" : new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        pane: "", pane_id: "", instance: "ub|A", harness: "claude" } },
    });
    const registry = join(fx.wt, ".tap/team-registry.json");
    const before = readFileSync(registry, "utf8");
    const trace = join(fx.root, "route.trace");
    const result = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "ua"],
      { cwd: fx.wt, env: { ...fx.env, TAP_BUN_ROUTE_TRACE: trace }, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(1);
    expect(readFileSync(trace, "utf8")).toBe("native send\n");
    expect(result.stderr.toString()).toBe(expired
      ? "tap send: 'ub' launch reservation expired; run tap team refresh to trim it; next: tap team refresh\n"
      : "tap send: 'ub' is still launching; next: wait for 'ub' to finish launching (or target seat 'ub' must run 'tap in')\n");
    expect(paneObserveCount(fx)).toBe(0);
    expect(existsSync(fx.env.FAKE_SUBMITTED as string)).toBe(false);
    expect(payloads(fx.bus)).toEqual([]);
    expect(readdirSync(join(fx.bus, "receipts"))).toEqual([]);
    expect(readFileSync(registry, "utf8")).toBe(before);
  });

  test("a pane recipient with invalid stored pane_id refuses identity_unverified natively before authorization", () => {
    const fx = teamFixture({
      seats: { ub: { status: "active", session: "ub", pane: "ub:0.0", pane_id: "%bogus", server_epoch: "srv:123:456", instance: "ub|A", harness: "claude" } },
    });
    const trace = join(fx.root, "route.trace");
    const result = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "ua"],
      { cwd: fx.wt, env: { ...fx.env, TAP_BUN_ROUTE_TRACE: trace }, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(1);
    expect(readFileSync(trace, "utf8")).toBe("native send\n");
    expect(result.stderr.toString()).toBe("tap send: registry row for 'ub' has invalid pane_id '%bogus'; refusing delivery without changing seat status; next: run 'tap session repair ub' to re-bind session\n");
    expect(paneObserveCount(fx)).toBe(0);
    expect(payloads(fx.bus)).toEqual([]);
  });

  test("a queued poll-target reply does not claim submitted to pane", () => {
    const inboundId = "pollbot-20260831T012300Z-aabbccddeeff";
    const fx = teamFixture({
      seats: { pollbot: { status: "active", delivery: "poll", instance: "pollbot|A" } },
      inbound: { id: inboundId, from: "pollbot", to: "ua" },
    });
    const result = Bun.spawnSync(
      [process.execPath, NATIVE_REPLY, inboundId, "-m", "answer", "--by", "ua"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).not.toContain("submitted to pane");
    expect(existsSync(join(fx.bus, "receipts", `${inboundId}.done`))).toBe(true);
  });

  test("re-enabled send routes native and refuses an absent flip marker; an invalid marker stays fail-closed", () => {
    // Born live (F1): an absent marker means no enrolled team, so native
    // send refuses in the selector rather than falling back to Bash.
    const absent = teamFixture({});
    unlinkSync(join(absent.env.TAP_INDEX_HOME as string, "global-registry.json"));
    const absentTrace = join(absent.root, "route.trace");
    const absentResult = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "ua", "--ask"],
      { cwd: absent.wt, env: { ...absent.env, TAP_BUN_ROUTE_TRACE: absentTrace, TAP_TUI_SETTLE_SCALE: "0.1" }, stdout: "pipe", stderr: "pipe", timeout: 30_000, killSignal: "SIGKILL" },
    );
    expect(absentResult.exitCode).toBe(1);
    expect(readFileSync(absentTrace, "utf8")).toBe("native send\n");
    expect(absentResult.stderr.toString()).toContain("no machine index (global-registry.json); this machine has no enrolled team; next: tap init  OR  tap session launch");
    expect(payloads(absent.bus)).toEqual([]);

    // An invalid marker refuses in the native selector before any fallback.
    const invalid = teamFixture({});
    writeFileSync(join(invalid.env.TAP_INDEX_HOME as string, "global-registry.json"), "not json at all\n");
    const invalidTrace = join(invalid.root, "route.trace");
    const invalidResult = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "ua", "--ask"],
      { cwd: invalid.wt, env: { ...invalid.env, TAP_BUN_ROUTE_TRACE: invalidTrace, TAP_TUI_SETTLE_SCALE: "0.1" }, stdout: "pipe", stderr: "pipe", timeout: 30_000, killSignal: "SIGKILL" },
    );
    expect(invalidResult.exitCode).not.toBe(0);
    expect(readFileSync(invalidTrace, "utf8")).toBe("native send\n");
    expect(invalidResult.stderr.toString()).toContain("registry flip marker is present but invalid");
    expect(payloads(invalid.bus)).toEqual([]);
  }, 60_000);

  test("a suspended recipient refuses natively on the dark path with no placement", () => {
    const fx = teamFixture({
      seats: { ub: { status: "suspended", session: "ub", pane: "ub:0.0", pane_id: "%7", server_epoch: "srv:123:456", instance: "ub|A", harness: "claude" } },
    });
    const result = Bun.spawnSync(
      [process.execPath, NATIVE_SEND, "ub", "-m", "hello", "--from", "ua", "--ask"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toBe("tap send: 'ub' is suspended; next: tap session resume ub\n");
    expect(paneObserveCount(fx)).toBe(0);
    expect(payloads(fx.bus)).toEqual([]);
  });

  test("a qualified stored reply_to warns natively and sends without the stamp", () => {
    const fx = teamFixture({
      seats: { ua: { status: "active", pane: "ua:0.0", pane_id: "%6", server_epoch: "srv:123:456", instance: "ua|A", harness: "claude", reply_to: "central/other" } },
    });
    const trace = join(fx.root, "route.trace");
    const result = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "ua", "--ask"],
      { cwd: fx.wt, env: { ...fx.env, TAP_TUI_SETTLE_SCALE: "0.1", TAP_BUN_ROUTE_TRACE: trace }, stdout: "pipe", stderr: "pipe", timeout: 30_000, killSignal: "SIGKILL" },
    );
    expect(readFileSync(trace, "utf8")).toBe("native send\n");
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toContain("this seat's registered reply_to 'central/other' is not currently deliverable — sending without it");
    const names = payloads(fx.bus);
    expect(names).toHaveLength(1);
    expect(envelopeField(readFileSync(join(fx.bus, "payloads", names[0]!), "utf8"), "reply_to")).toBe(undefined);
  }, 120_000);

  test("a pane recipient missing server_epoch refuses native before any bus effect (tap-zk1w)", () => {
    const fx = teamFixture({
      seats: { ub: { status: "active", pane: "ub:0.0", pane_id: "%7", instance: "ub|A", harness: "claude" } },
    });
    const trace = join(fx.root, "route.trace");
    const result = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "ua", "--ask"],
      { cwd: fx.wt, env: { ...fx.env, TAP_TUI_SETTLE_SCALE: "0.1", TAP_BUN_ROUTE_TRACE: trace }, stdout: "pipe", stderr: "pipe", timeout: 30_000, killSignal: "SIGKILL" },
    );
    expect(readFileSync(trace, "utf8")).toBe("native send\n");
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("'ub' has no recorded server generation");
    expect(payloads(fx.bus)).toEqual([]);
  }, 120_000);

  test("native reply copies inbound epoch onto the settlement receipt", () => {
    const inboundId = "ub-20260831T011600Z-aabbccddeeff";
    const fx = teamFixture({
      inbound: { id: inboundId, from: "ub", to: "ua", extra: { epoch: "17" } },
    });
    const result = Bun.spawnSync(
      [process.execPath, NATIVE_REPLY, inboundId, "-m", "answer", "--by", "ua"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(fx.bus, "receipts", `${inboundId}.done`), "utf8")).epoch).toBe("17");
  });
});
