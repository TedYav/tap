// tap_serial_triggers "runtime/bun/test/support/send-reply-flip-fixture.ts" "runtime/bun/main.ts" "runtime/bun/test/support/native-send-entry.ts" "runtime/bun/test/support/native-reply-entry.ts" "runtime/bun/test/support/reenabled-router-entry.ts" "skills/tap/scripts/lib.sh"
// send-postplacement-legacy — component split out of the former
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

describe("post-placement identity and pane-gone keep canonical", () => {
  test("post-placement identity mismatch queues with the exact register action and detail", async () => {
    const fx = teamFixture({ parkAfter: 2 });
    const id = "ua-20260831T020000Z-aabbccddeeff";
    const send = Bun.spawn(
      [process.execPath, NATIVE_SEND, "ub", "-m", "hello", "--from", "ua", "--ask", "--id", id, "--json"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    waitFor(fx.reached);
    expect(payloads(fx.bus)).toHaveLength(1);
    expect(placed(fx.bus)).toHaveLength(1);
    writeFileSync(fx.env.FAKE_PANE_ID as string, "%99\n");
    writeFileSync(fx.release, "go\n");
    expect(await send.exited).toBe(0);
    const rec = JSON.parse((await new Response(send.stdout).text()).trim().split("\n").at(-1)!);
    expect(rec).toMatchObject({
      status: "queued",
      delivery: "poll",
      reason: "identity_mismatch",
      action: "tap register ub   (the recorded pane is stale; re-register to rebind)",
    });
    expect(String(rec.detail)).toContain("%99");
    expect(existsSync(join(fx.bus, "payloads", `${id}.md`))).toBe(true);
    expect(existsSync(join(fx.bus, "receipts", `${id}.placed`))).toBe(true);
    expect(existsSync(fx.env.FAKE_BAND as string)).toBe(false);
    const poll = Bun.spawnSync([process.execPath, MAIN, "poll", "ub"], {
      cwd: fx.wt, env: { ...fx.env, TAP_SELF: "ub" }, stdout: "pipe", stderr: "pipe",
    });
    expect(poll.exitCode).toBe(2);
    expect(poll.stdout.toString()).toContain(id);
  }, 30_000);

  test("proven pre-effect pane-gone after placement queues with detail and keeps files", async () => {
    const fx = teamFixture({ parkAfter: 2 });
    const id = "ua-20260831T020100Z-aabbccddeeff";
    const send = Bun.spawn(
      [process.execPath, NATIVE_SEND, "ub", "-m", "hello", "--from", "ua", "--ask", "--id", id],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    waitFor(fx.reached);
    expect(payloads(fx.bus)).toHaveLength(1);
    expect(placed(fx.bus)).toHaveLength(1);
    writeFileSync(fx.env.FAKE_GONE as string, "1\n");
    writeFileSync(fx.release, "go\n");
    expect(await send.exited).toBe(0);
    const out = await new Response(send.stdout).text();
    expect(out).toContain("tap send: queued");
    const err = await new Response(send.stderr).text();
    expect(err).toContain("action: human_relay");
    expect(err).toMatch(/pane 'ub:0\.0' is gone/);
    expect(out).not.toContain("next: human_relay");
    expect(out).not.toMatch(/; pane_gone(?:;|$)/);
    expect(existsSync(join(fx.bus, "payloads", `${id}.md`))).toBe(true);
    expect(existsSync(join(fx.bus, "receipts", `${id}.placed`))).toBe(true);
    expect(existsSync(fx.env.FAKE_BAND as string)).toBe(false);
  }, 30_000);

  test("post-placement removed recipient row queues identity_mismatch with no inject", async () => {
    const fx = teamFixture({ parkAfter: 2 });
    const id = "ua-20260831T020200Z-aabbccddeeff";
    const registry = join(fx.wt, ".tap", "team-registry.json");
    const send = Bun.spawn(
      [process.execPath, NATIVE_SEND, "ub", "-m", "hello", "--from", "ua", "--ask", "--id", id, "--json"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    waitFor(fx.reached);
    expect(payloads(fx.bus)).toHaveLength(1);
    expect(placed(fx.bus)).toHaveLength(1);
    const doc = JSON.parse(readFileSync(registry, "utf8")) as { seats: Record<string, unknown> };
    delete doc.seats.ub;
    writeFileSync(registry, JSON.stringify(doc));
    writeFileSync(fx.release, "go\n");
    expect(await send.exited).toBe(0);
    const rec = JSON.parse((await new Response(send.stdout).text()).trim().split("\n").at(-1)!);
    expect(rec).toMatchObject({
      status: "queued",
      delivery: "poll",
      reason: "identity_mismatch",
      action: "tap register ub   (the recorded pane is stale; re-register to rebind)",
    });
    expect(String(rec.detail)).toContain("ub");
    expect(existsSync(join(fx.bus, "payloads", `${id}.md`))).toBe(true);
    expect(existsSync(join(fx.bus, "receipts", `${id}.placed`))).toBe(true);
    expect(existsSync(fx.env.FAKE_BAND as string)).toBe(false);
    expect(existsSync(fx.env.FAKE_SUBMITTED as string)).toBe(false);
  }, 30_000);

  test("post-placement same-pane instance rebind queues identity_mismatch with no inject", async () => {
    const fx = teamFixture({ parkAfter: 2 });
    const id = "ua-20260831T020300Z-aabbccddeeff";
    const registry = join(fx.wt, ".tap", "team-registry.json");
    const send = Bun.spawn(
      [process.execPath, NATIVE_SEND, "ub", "-m", "hello", "--from", "ua", "--ask", "--id", id, "--json"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    waitFor(fx.reached);
    expect(payloads(fx.bus)).toHaveLength(1);
    expect(placed(fx.bus)).toHaveLength(1);
    const doc = JSON.parse(readFileSync(registry, "utf8")) as { seats: Record<string, Record<string, unknown>> };
    doc.seats.ub = { ...doc.seats.ub, instance: "ub|B" };
    writeFileSync(registry, JSON.stringify(doc));
    writeFileSync(fx.release, "go\n");
    expect(await send.exited).toBe(0);
    const rec = JSON.parse((await new Response(send.stdout).text()).trim().split("\n").at(-1)!);
    expect(rec).toMatchObject({
      status: "queued",
      delivery: "poll",
      reason: "identity_mismatch",
      action: "tap register ub   (the recorded pane is stale; re-register to rebind)",
    });
    expect(String(rec.detail)).toContain("ub|B");
    expect(existsSync(join(fx.bus, "payloads", `${id}.md`))).toBe(true);
    expect(existsSync(join(fx.bus, "receipts", `${id}.placed`))).toBe(true);
    expect(existsSync(fx.env.FAKE_BAND as string)).toBe(false);
    expect(existsSync(fx.env.FAKE_SUBMITTED as string)).toBe(false);
  }, 30_000);

  test("post-placement launching recipient row queues identity_mismatch with no inject", async () => {
    const fx = teamFixture({ parkAfter: 2 });
    const id = "ua-20260831T020400Z-aabbccddeeff";
    const registry = join(fx.wt, ".tap", "team-registry.json");
    const send = Bun.spawn(
      [process.execPath, NATIVE_SEND, "ub", "-m", "hello", "--from", "ua", "--ask", "--id", id, "--json"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    waitFor(fx.reached);
    expect(payloads(fx.bus)).toHaveLength(1);
    expect(placed(fx.bus)).toHaveLength(1);
    const doc = JSON.parse(readFileSync(registry, "utf8")) as { seats: Record<string, Record<string, unknown>> };
    doc.seats.ub = { ...doc.seats.ub, status_reason: "launching" };
    writeFileSync(registry, JSON.stringify(doc));
    writeFileSync(fx.release, "go\n");
    expect(await send.exited).toBe(0);
    const rec = JSON.parse((await new Response(send.stdout).text()).trim().split("\n").at(-1)!);
    expect(rec).toMatchObject({
      status: "queued",
      delivery: "poll",
      reason: "identity_mismatch",
      action: "tap register ub   (the recorded pane is stale; re-register to rebind)",
    });
    expect(String(rec.detail)).toContain("launching");
    expect(existsSync(join(fx.bus, "payloads", `${id}.md`))).toBe(true);
    expect(existsSync(join(fx.bus, "receipts", `${id}.placed`))).toBe(true);
    expect(existsSync(fx.env.FAKE_BAND as string)).toBe(false);
    expect(existsSync(fx.env.FAKE_SUBMITTED as string)).toBe(false);
  }, 30_000);
});

describe("U3 sender eligibility (checkpoint B)", () => {
  // The incumbent's sender facts (tap_registry_sender_facts, lib.sh:9608-9688)
  // answer ONE question — is this sender dischargeable — and the refusal for a
  // non-dischargeable sender is `unregistered_sender` with the remedy
  // tap_unregistered_sender_next computes (lib.sh:9558-9606). Under the test
  // sandbox no calling pane exists, so every refusal carries the pane-less
  // remedy natively.
  const unregisteredBytes = (handle: string): string =>
    `tap send: '${handle}' is not an active sender on this team; pane-less daemons/scripts must register a stable poll seat, then pass --team on send when cwd is unanchored; next: tap register ${handle} --delivery poll [--team <team>]`;

  function refuseDoor(fx: ReturnType<typeof teamFixture>) {
    const trace = join(fx.root, "route.trace");
    const result = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "ua"],
      { cwd: fx.wt, env: { ...fx.env, TAP_BUN_ROUTE_TRACE: trace }, stdout: "pipe", stderr: "pipe" },
    );
    return { result, stderr: result.stderr.toString(), trace: readFileSync(trace, "utf8") };
  }

  test("a launching sender refuses unregistered_sender with the incumbent's bytes", () => {
    const fx = teamFixture({
      seats: {
        ua: { status: "active", status_reason: "launching", pane: "ua:0.0", pane_id: "%6", server_epoch: "srv:123:456", instance: "ua|A", harness: "claude" },
      },
    });
    const { result, stderr, trace } = refuseDoor(fx);
    expect(result.exitCode).toBe(1);
    expect(trace).toBe("native send\n");
    expect(stderr).toBe(`${unregisteredBytes("ua")}\n`);
    expect(payloads(fx.bus)).toEqual([]);
    expect(placed(fx.bus)).toEqual([]);
  });

  test("an unbound active sender refuses unregistered_sender with the incumbent's bytes", () => {
    const fx = teamFixture({
      seats: { ua: { status: "active", instance: "ua|A" } },
    });
    const { result, stderr, trace } = refuseDoor(fx);
    expect(result.exitCode).toBe(1);
    expect(trace).toBe("native send\n");
    expect(stderr).toBe(`${unregisteredBytes("ua")}\n`);
    expect(payloads(fx.bus)).toEqual([]);
    expect(placed(fx.bus)).toEqual([]);
  });

  test.each([
    ["stale server", { server_epoch: "srv:OLD:1" }, {}],
    ["stale boot", { boot_id: "bootuuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, {
      TAP_BOOT_ID: "bootuuid:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    }],
  ] as const)("a %s sender refuses unregistered_sender with the incumbent's bytes", (_label, seatExtra, envExtra) => {
    const fx = teamFixture({
      seats: {
        ua: {
          status: "active", pane: "ua:0.0", pane_id: "%6", server_epoch: "srv:123:456",
          instance: "ua|A", harness: "claude", ...seatExtra,
        },
      },
    });
    const trace = join(fx.root, "route.trace");
    const result = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "ua"],
      { cwd: fx.wt, env: { ...fx.env, ...envExtra, TAP_BUN_ROUTE_TRACE: trace }, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(1);
    expect(readFileSync(trace, "utf8")).toBe("native send\n");
    expect(result.stderr.toString()).toBe(`${unregisteredBytes("ua")}\n`);
    expect(payloads(fx.bus)).toEqual([]);
    expect(placed(fx.bus)).toEqual([]);
  });

  for (const currentBoot of ["", "bootuuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]) test(
    `a boot-stamped sender ${currentBoot ? "matches" : "refuses an unobservable boot"} natively`, () => {
      const fx = teamFixture({ seats: { ua: { status: "active", pane: "ua:0.0", pane_id: "%6",
        server_epoch: "srv:123:456", harness: "claude", instance: "ua|A",
        boot_id: "bootuuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } } });
      const result = Bun.spawnSync(
        [process.execPath, NATIVE_SEND, "ub", "-m", "hello", "--from", "ua", "--json"],
        { cwd: fx.wt, env: { ...fx.env, TAP_BOOT_ID: currentBoot }, stdout: "pipe", stderr: "pipe" },
      );
      expect(result.exitCode).toBe(currentBoot ? 0 : 1);
      if (!currentBoot) {
        expect(JSON.parse(result.stdout.toString()).error_class).toBe("sender_liveness_unobservable");
        expect(payloads(fx.bus)).toEqual([]);
        expect(existsSync(fx.env.FAKE_SUBMITTED!)).toBe(false);
      } else expect(payloads(fx.bus)).toHaveLength(1);
    }, 30_000,
  );

  test("a poll sender delivers native with no sender_instance stamp", () => {
    const fx = teamFixture({
      seats: { ua: { status: "active", delivery: "poll", instance: "ua|A" } },
    });
    const trace = join(fx.root, "route.trace");
    const result = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "ua"],
      { cwd: fx.wt, env: { ...fx.env, TAP_BUN_ROUTE_TRACE: trace, TAP_TUI_SETTLE_SCALE: "0.1" }, stdout: "pipe", stderr: "pipe", timeout: 30_000, killSignal: "SIGKILL" },
    );
    expect(result.exitCode).toBe(0);
    expect(readFileSync(trace, "utf8")).toBe("native send\n");
    const names = payloads(fx.bus);
    expect(names).toHaveLength(1);
    const canonical = readFileSync(join(fx.bus, "payloads", names[0]!), "utf8");
    expect(envelopeField(canonical, "sender_instance")).toBe(undefined);
  }, 40_000);

  test("an unattended pane-backed sender downgrades --ask with the incumbent warning", () => {
    const fx = teamFixture({
      seats: {
        ua: { status: "active", pane: "ua:0.0", pane_id: "%6", server_epoch: "srv:123:456", instance: "ua|A", harness: "claude", unattended: true },
      },
    });
    const trace = join(fx.root, "route.trace");
    const result = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "ua", "--ask", "--json"],
      { cwd: fx.wt, env: { ...fx.env, TAP_BUN_ROUTE_TRACE: trace, TAP_TUI_SETTLE_SCALE: "0.1" }, stdout: "pipe", stderr: "pipe", timeout: 30_000, killSignal: "SIGKILL" },
    );
    expect(result.exitCode).toBe(0);
    expect(readFileSync(trace, "utf8")).toBe("native send\n");
    expect(result.stderr.toString()).toContain(
      "tap send: warning: --ask downgraded to reply=settle-only because --from 'ua' is unattended and has no deliverable reply_to",
    );
    const names = payloads(fx.bus);
    expect(names).toHaveLength(1);
    expect(envelopeField(readFileSync(join(fx.bus, "payloads", names[0]!), "utf8"), "reply")).toBe("settle-only");
  }, 40_000);

  test("an unattended sender with a deliverable reply_to keeps the reply obligation", () => {
    const fx = teamFixture({
      seats: {
        ua: { status: "active", pane: "ua:0.0", pane_id: "%6", server_epoch: "srv:123:456", instance: "ua|A", harness: "claude", unattended: true, reply_to: "ub" },
      },
    });
    const trace = join(fx.root, "route.trace");
    const result = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "ua", "--ask", "--json"],
      { cwd: fx.wt, env: { ...fx.env, TAP_BUN_ROUTE_TRACE: trace, TAP_TUI_SETTLE_SCALE: "0.1" }, stdout: "pipe", stderr: "pipe", timeout: 30_000, killSignal: "SIGKILL" },
    );
    expect(result.exitCode).toBe(0);
    expect(readFileSync(trace, "utf8")).toBe("native send\n");
    expect(result.stderr.toString()).not.toContain("downgraded");
    const names = payloads(fx.bus);
    expect(names).toHaveLength(1);
    expect(envelopeField(readFileSync(join(fx.bus, "payloads", names[0]!), "utf8"), "reply")).toBe("expected");
  }, 40_000);

  test("a pane sender with an empty stored server_epoch is not dischargeable (tap-zk1w)", () => {
    const fx = teamFixture({
      seats: {
        ua: { status: "active", pane: "ua:0.0", pane_id: "%6", server_epoch: "", instance: "ua|A", harness: "claude" },
      },
    });
    const trace = join(fx.root, "route.trace");
    const result = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "ua"],
      { cwd: fx.wt, env: { ...fx.env, TAP_BUN_ROUTE_TRACE: trace, TAP_TUI_SETTLE_SCALE: "0.1" }, stdout: "pipe", stderr: "pipe", timeout: 30_000, killSignal: "SIGKILL" },
    );
    expect(result.exitCode).toBe(1);
    expect(readFileSync(trace, "utf8")).toBe("native send\n");
    expect(result.stderr.toString()).toContain("is not an active sender");
    expect(payloads(fx.bus)).toEqual([]);
  }, 40_000);

  test("a sender with a non-pane-id stored pane_id delivers native and stamps its instance", () => {
    const fx = teamFixture({
      seats: {
        ua: { status: "active", pane: "ua:0.0", pane_id: "bogus", server_epoch: "srv:123:456", instance: "ua|A", harness: "claude" },
      },
    });
    const trace = join(fx.root, "route.trace");
    const result = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "ua"],
      { cwd: fx.wt, env: { ...fx.env, TAP_BUN_ROUTE_TRACE: trace, TAP_TUI_SETTLE_SCALE: "0.1" }, stdout: "pipe", stderr: "pipe", timeout: 30_000, killSignal: "SIGKILL" },
    );
    expect(result.exitCode).toBe(0);
    expect(readFileSync(trace, "utf8")).toBe("native send\n");
    const names = payloads(fx.bus);
    expect(names).toHaveLength(1);
    expect(envelopeField(readFileSync(join(fx.bus, "payloads", names[0]!), "utf8"), "sender_instance")).toBe("ua|A");
  }, 40_000);
});

describe("U3 recipient rows, hermes and watch identity (checkpoint B)", () => {
  for (const field of ["#{pane_pid}", "#{pane_in_mode}"]) test(`unobservable ${field} cannot suspend a pane whose id is still observable`, () => {
    const fx = teamFixture({});
    const binary = join(fx.root, "bin", "tmux");
    writeFileSync(binary, readFileSync(binary, "utf8").replace("#!/bin/sh\n", `#!/bin/sh
case "$*" in
  *'${field}'*) printf 'malformed\\n'; exit 0 ;;
esac
`));
    const registry = join(fx.wt, ".tap", "team-registry.json");
    const before = readFileSync(registry, "utf8");
    const result = Bun.spawnSync(
      [process.execPath, NATIVE_SEND, "ub", "-m", "hello", "--from", "ua", "--json"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout.toString()).error_class).toBe("tmux_unreachable");
    expect(readFileSync(registry, "utf8")).toBe(before);
    expect(payloads(fx.bus)).toEqual([]);
    expect(existsSync(fx.env.FAKE_SUBMITTED!)).toBe(false);
  });

  // The incumbent answers recipient-row states before any observation or
  // placement (tap-send.sh:860-1017); every refusal here must trace
  // `native send` with the incumbent's exact bytes (frozen below — the
  // Bash comparison this used to run against is retired with the adapter).
  function runSend(fx: ReturnType<typeof teamFixture>, extraArgv: string[] = [], extraEnv: Record<string, string> = {}) {
    const trace = join(fx.root, "route.trace");
    const result = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "ua", ...extraArgv],
      { cwd: fx.wt, env: { ...fx.env, ...extraEnv, TAP_BUN_ROUTE_TRACE: trace }, stdout: "pipe", stderr: "pipe", timeout: 30_000, killSignal: "SIGKILL" },
    );
    return {
      code: result.exitCode,
      stderr: result.stderr.toString(),
      trace: existsSync(trace) ? readFileSync(trace, "utf8") : "",
    };
  }

  test(
    "a launching recipient refuses seat_launching",
    () => {
      const seats = { ub: { status: "active" as const, status_reason: "launching", pane: "ub:0.0", pane_id: "%7", server_epoch: "srv:123:456", instance: "ub|A", harness: "claude" } };
      const fx = teamFixture({ seats });
      const v = runSend(fx);
      expect(v.trace).toBe("native send\n");
      expect(v.code).toBe(1);
      expect(v.stderr).toBe("tap send: 'ub' is bound but still launching; next: tap team\n");
      expect(payloads(fx.bus)).toEqual([]);
      expect(paneObserveCount(fx)).toBe(0);
    },
  );

  test(
    "an empty stored pane_id refuses identity_unverified with the launcher repair action",
    () => {
      const seats = { ub: { status: "active" as const, session: "ub", pane: "ub:0.0", pane_id: "", server_epoch: "srv:123:456", instance: "ub|A", harness: "claude" } };
      const fx = teamFixture({ seats });
      const v = runSend(fx);
      expect(v.trace).toBe("native send\n");
      expect(v.code).toBe(1);
      expect(v.stderr).toBe("tap send: registry row for 'ub' has no pane_id; refusing unbound delivery; next: run 'tap session repair ub' to re-bind session\n");
      expect(payloads(fx.bus)).toEqual([]);
      expect(paneObserveCount(fx)).toBe(0);
    },
  );

  test(
    "an empty stored pane_id on a non-launcher seat names 'tap in'",
    () => {
      const seats = { ub: { status: "active" as const, pane: "ub:0.0", pane_id: "", server_epoch: "srv:123:456", instance: "ub|A", harness: "" } };
      const fx = teamFixture({ seats });
      const v = runSend(fx);
      expect(v.trace).toBe("native send\n");
      expect(v.code).toBe(1);
      expect(v.stderr).toBe("tap send: registry row for 'ub' has no pane_id; refusing unbound delivery; next: target seat 'ub' must run 'tap in' from its pane\n");
      expect(payloads(fx.bus)).toEqual([]);
    },
  );

  test(
    "a malformed stored pane_id refuses identity_unverified with the invalid-pane_id sentence",
    () => {
      const seats = { ub: { status: "active" as const, session: "ub", pane: "ub:0.0", pane_id: "%bogus", server_epoch: "srv:123:456", instance: "ub|A", harness: "claude" } };
      const fx = teamFixture({ seats });
      const v = runSend(fx);
      expect(v.trace).toBe("native send\n");
      expect(v.code).toBe(1);
      expect(v.stderr).toBe("tap send: registry row for 'ub' has invalid pane_id '%bogus'; refusing delivery without changing seat status; next: run 'tap session repair ub' to re-bind session\n");
      expect(payloads(fx.bus)).toEqual([]);
      expect(paneObserveCount(fx)).toBe(0);
    },
  );

  test(
    "a suspended poll recipient refuses suspended with the register action",
    () => {
      const seats = { ub: { status: "suspended" as const, delivery: "poll", instance: "ub|A" } };
      const fx = teamFixture({ seats });
      const v = runSend(fx);
      expect(v.trace).toBe("native send\n");
      expect(v.code).toBe(1);
      expect(v.stderr).toBe("tap send: 'ub' is suspended; next: tap register ub --delivery poll\n");
      expect(payloads(fx.bus)).toEqual([]);
    },
  );

  test(
    "a suspended launcher-managed pane recipient refuses rc 3 with the resume action",
    () => {
      const seats = { ub: { status: "suspended" as const, session: "ub", pane: "ub:0.0", pane_id: "%7", server_epoch: "srv:123:456", instance: "ub|A", harness: "claude" } };
      const fx = teamFixture({ seats });
      const v = runSend(fx);
      expect(v.trace).toBe("native send\n");
      expect(v.code).toBe(3);
      expect(v.stderr).toBe("tap send: 'ub' is suspended; next: tap session resume ub\n");
      expect(payloads(fx.bus)).toEqual([]);
      expect(paneObserveCount(fx)).toBe(0);
    },
  );

  test(
    "a suspended incapable pane recipient refuses rc 3 with the re-register action",
    () => {
      const seats = { ub: { status: "suspended" as const, status_reason: "incapable", pane: "ub:0.0", pane_id: "%7", server_epoch: "srv:123:456", instance: "ub|A", harness: "claude" } };
      const fx = teamFixture({ seats });
      const v = runSend(fx);
      expect(v.trace).toBe("native send\n");
      expect(v.code).toBe(3);
      expect(v.stderr).toBe("tap send: 'ub' is suspended (incapable); next: re-register 'ub' from its pane: run 'tap in' there, or 'tap register ub --pane <tmux-target>'\n");
      expect(payloads(fx.bus)).toEqual([]);
    },
  );

  test(
    "a suspended non-launcher pane recipient refuses rc 3 with the re-open action",
    () => {
      const seats = { ub: { status: "suspended" as const, pane: "ub:0.0", pane_id: "%7", server_epoch: "srv:123:456", instance: "ub|A", harness: "" } };
      const fx = teamFixture({ seats });
      const v = runSend(fx);
      expect(v.trace).toBe("native send\n");
      expect(v.code).toBe(3);
      expect(v.stderr).toBe("tap send: 'ub' is suspended; next: re-open pane for 'ub' and run 'tap in'\n");
      expect(payloads(fx.bus)).toEqual([]);
    },
  );

  test(
    "a pane recipient missing server_epoch refuses native (tap-zk1w)",
    () => {
      const seats = { ub: { status: "active" as const, pane: "ub:0.0", pane_id: "%7", instance: "ub|A", harness: "claude" } };
      const fx = teamFixture({ seats });
      const v = runSend(fx, [], { TAP_TUI_SETTLE_SCALE: "0.1" });
      expect(v.trace).toBe("native send\n");
      expect(v.code).toBe(1);
      expect(v.stderr).toContain("tap register ub");
      expect(payloads(fx.bus)).toEqual([]);
    },
    60_000,
  );

  test(
    "the watch identity may send settle-only probe mail without a pane, and refuses reply-capable mail with the reserved bytes",
    () => {
      // The watch identity is the CONSTANT `watcher` (lib.sh:9913); no env
      // override exists. Eligible: a supervisor kind with NO reply obligation
      // bypasses the dischargeable refusal — plain (tap-7rpf0) or the
      // deprecated --fyi spelling alike.
      const eligible = teamFixture({});
      const eligibleTrace = join(eligible.root, "route.trace");
      const okResult = Bun.spawnSync(
        [process.execPath, REENABLED, "send", "ub", "-m", "probe", "--from", "watcher", "--kind", "probe", "--id", "ua-20260920T120100Z-aabbccddeeff"],
        { cwd: eligible.wt, env: { ...eligible.env, TAP_TUI_SETTLE_SCALE: "0.1", TAP_BUN_ROUTE_TRACE: eligibleTrace }, stdout: "pipe", stderr: "pipe", timeout: 30_000, killSignal: "SIGKILL" },
      );
      expect(okResult.exitCode).toBe(0);
      expect(existsSync(eligibleTrace) ? readFileSync(eligibleTrace, "utf8") : "").toBe("native send\n");
      expect(okResult.stderr.toString()).not.toContain("reserved watch-sidecar identity");
      const spoolDir = join(eligible.bus, "spool");
      const spooled = existsSync(spoolDir) ? readdirSync(spoolDir).filter((n) => !n.startsWith(".")) : [];
      expect(payloads(eligible.bus).length + spooled.length).toBeGreaterThan(0);

      // The deprecated --fyi spelling of the same settle-only default stays
      // licensed (the watcher callers keep passing it).
      const fyi = teamFixture({});
      const fyiTrace = join(fyi.root, "route.trace");
      const fyiResult = Bun.spawnSync(
        [process.execPath, REENABLED, "send", "ub", "-m", "probe", "--from", "watcher", "--fyi", "--kind", "probe", "--id", "ua-20260920T120200Z-aabbccddeeff"],
        { cwd: fyi.wt, env: { ...fyi.env, TAP_TUI_SETTLE_SCALE: "0.1", TAP_BUN_ROUTE_TRACE: fyiTrace }, stdout: "pipe", stderr: "pipe", timeout: 30_000, killSignal: "SIGKILL" },
      );
      expect(fyiResult.exitCode).toBe(0);
      expect(existsSync(fyiTrace) ? readFileSync(fyiTrace, "utf8") : "").toBe("native send\n");

      // Ineligible: a reply obligation from the sidecar refuses with the
      // reserved-identity bytes (tap-send.sh:546-548), however the rest of
      // the send is spelled — here the deprecated --fyi.
      const ineligible = teamFixture({});
      const ineligibleTrace = join(ineligible.root, "route.trace");
      const noResult = Bun.spawnSync(
        [process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "watcher", "--id", "ua-20260920T120300Z-aabbccddeeff"],
        { cwd: ineligible.wt, env: { ...ineligible.env, TAP_BUN_ROUTE_TRACE: ineligibleTrace }, stdout: "pipe", stderr: "pipe", timeout: 30_000, killSignal: "SIGKILL" },
      );
      expect(noResult.exitCode).toBe(1);
      expect(existsSync(ineligibleTrace) ? readFileSync(ineligibleTrace, "utf8") : "").toBe("native send\n");
      expect(noResult.stderr.toString()).toBe(
        "tap send: 'watcher' is the reserved watch-sidecar identity: it has no pane and cannot register, so it may only send settle-only mail — --kind probe, notice or progress with no reply obligation. A reply-expecting message is sent from a registered pane-backed seat; next: tap send ub -f <path> --from watcher --kind notice\n",
      );
      expect(payloads(ineligible.bus)).toEqual([]);

      // The obligation key itself (tap-7rpf0): --ask on a supervisor kind
      // refuses the same way even though the kind alone would be licensed.
      const ask = teamFixture({});
      const askResult = Bun.spawnSync(
        [process.execPath, REENABLED, "send", "ub", "-m", "probe", "--from", "watcher", "--ask", "--kind", "probe", "--id", "ua-20260920T120400Z-aabbccddeeff"],
        { cwd: ask.wt, env: { ...ask.env, TAP_BUN_ROUTE_TRACE: join(ask.root, "route.trace") }, stdout: "pipe", stderr: "pipe", timeout: 30_000, killSignal: "SIGKILL" },
      );
      expect(askResult.exitCode).toBe(1);
      expect(askResult.stderr.toString()).toContain("reserved watch-sidecar identity");
      expect(askResult.stderr.toString()).toContain("A reply-expecting message is sent from a registered pane-backed seat");
      expect(payloads(ask.bus)).toEqual([]);
    },
    120_000,
  );
});

describe("reply outbound fate prose", () => {
  test("a delivered reply names outbound delivery and inbound settlement separately", () => {
    const inboundId = "ub-20260831T021000Z-aabbccddeeff";
    const fx = teamFixture({ inbound: { id: inboundId, from: "ub", to: "ua" } });
    const result = Bun.spawnSync(
      [process.execPath, NATIVE_REPLY, inboundId, "-m", "answer", "--by", "ua"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    const out = result.stdout.toString();
    expect(out).toBe(`tap reply: ok ${inboundId}\n`);
    expect(out).not.toMatch(/replied to .+ and settled/);
    expect(existsSync(join(fx.bus, "receipts", `${inboundId}.done`))).toBe(true);
  });

  test("a queued poll-target reply names queued outbound and still settles", () => {
    const inboundId = "pollbot-20260831T021100Z-aabbccddeeff";
    const fx = teamFixture({
      seats: { pollbot: { status: "active", delivery: "poll", instance: "pollbot|A" } },
      inbound: { id: inboundId, from: "pollbot", to: "ua" },
    });
    const result = Bun.spawnSync(
      [process.execPath, NATIVE_REPLY, inboundId, "-m", "answer", "--by", "ua"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    const out = result.stdout.toString();
    expect(out).toBe(`tap reply: queued ${inboundId}\n`);
    expect(out).not.toContain("submitted to pane");
    expect(out).not.toMatch(/replied to .+ and settled/);
    expect(existsSync(join(fx.bus, "receipts", `${inboundId}.done`))).toBe(true);
  });

  test("an unverified reply names submit-unverified and still settles", () => {
    const inboundId = "ub-20260831T021200Z-aabbccddeeff";
    const fx = teamFixture({ inbound: { id: inboundId, from: "ub", to: "ua" } });
    writeFileSync(fx.env.FAKE_INJECT_FAIL as string, "1\n");
    const result = Bun.spawnSync(
      [process.execPath, NATIVE_REPLY, inboundId, "-m", "answer", "--by", "ua"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(5);
    const out = result.stdout.toString();
    expect(out).toContain("outbound submit unverified");
    expect(out).toContain(`inbound ${inboundId} settled`);
    expect(out).not.toMatch(/replied to .+ and settled/);
    expect(existsSync(join(fx.bus, "receipts", `${inboundId}.done`))).toBe(true);
  });
});

describe("hermes queue-prefix delivery (checkpoint B)", () => {
  test("hermes-profile routes native and the incumbent /queue prefix rides the sentinel", () => {
    const hermes = teamFixture({
      command: "hermes-profile",
      seats: {
        ub: { status: "active", pane: "ub:0.0", pane_id: "%7", server_epoch: "srv:123:456", instance: "ub|A", harness: "hermes-profile" },
      },
    });
    const hermesTrace = join(hermes.root, "route.trace");
    const hermesResult = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "ua", "--ask"],
      {
        cwd: hermes.wt,
        env: { ...hermes.env, TAP_BUN_ROUTE_TRACE: hermesTrace, TAP_TUI_SETTLE_SCALE: "0.1" },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 20_000,
        killSignal: "SIGKILL",
      },
    );
    expect(readFileSync(hermesTrace, "utf8")).toBe("native send\n");
    expect(hermesResult.exitCode).toBe(0);
    const injected = existsSync(hermes.env.FAKE_BAND as string)
      ? readFileSync(hermes.env.FAKE_BAND as string, "utf8")
      : "";
    const keys = existsSync(hermes.env.FAKE_KEYS as string)
      ? readFileSync(hermes.env.FAKE_KEYS as string, "utf8")
      : "";
    expect(`${injected}\n${keys}`).toContain("/queue ");
  }, 40_000);

  test("ordinary Claude re-enabled send stays native without a /queue prefix", () => {
    const claude = teamFixture({});
    const claudeTrace = join(claude.root, "route.trace");
    const claudeResult = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "ua", "--ask"],
      { cwd: claude.wt, env: { ...claude.env, TAP_BUN_ROUTE_TRACE: claudeTrace }, stdout: "pipe", stderr: "pipe" },
    );
    expect(claudeResult.exitCode).toBe(0);
    expect(readFileSync(claudeTrace, "utf8")).toBe("native send\n");
    const claudeKeys = existsSync(claude.env.FAKE_KEYS as string)
      ? readFileSync(claude.env.FAKE_KEYS as string, "utf8")
      : "";
    const claudeBand = existsSync(claude.env.FAKE_BAND as string)
      ? readFileSync(claude.env.FAKE_BAND as string, "utf8")
      : "";
    expect(`${claudeBand}\n${claudeKeys}`).not.toContain("/queue ");
  }, 40_000);
});

describe("native send/reply observe existing spool custody", () => {
  for (const row of ["pair", "metadata-only", "registry-alias", "foreign-recipient", "foreign-registry", "body-only"]) {
    test(`ready native send preserves existing spool custody: ${row}`, () => {
      const fx = teamFixture({});
      const spool = join(fx.bus, "spool");
      mkdirSync(spool, { recursive: true });
      const registry = join(fx.wt, ".tap/team-registry.json");
      const alias = join(fx.root, "registry-alias.json");
      symlinkSync(registry, alias);
      const body = join(spool, "older.md"), meta = join(spool, "older.meta.json");
      if (row !== "metadata-only") writeFileSync(body, "older body");
      if (row !== "body-only") writeFileSync(meta, JSON.stringify({ id: "older",
        target: row === "foreign-recipient" ? "ua" : "ub",
        target_registry: row === "foreign-registry" ? join(fx.root, "foreign.json") : row === "registry-alias" ? alias : registry,
      }));
      const before = snapshotSpool(spool);
      const trace = join(fx.root, "ready-send.trace");
      const result = Bun.spawnSync([process.execPath, REENABLED, "send", "ub", "--ask", "-m", "new body", "--from", "ua", "--id", "new-message"],
        { cwd: fx.wt, env: { ...fx.env, TAP_BUN_ROUTE_TRACE: trace }, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(readFileSync(trace, "utf8")).toBe("native send\n");
      expect(existsSync(join(spool, "new-message.md"))).toBe(false);
      expect(existsSync(join(spool, "new-message.meta.json"))).toBe(false);
      expect(existsSync(join(fx.bus, "payloads/new-message.md"))).toBe(true);
      expect(existsSync(join(fx.bus, "receipts/new-message.sent"))).toBe(true);
      expect(readFileSync(fx.env.FAKE_KEYS as string, "utf8")).toContain("new-message");
      // Ready arrivals may overtake parked mail; send does not promote or rewrite it.
      expect(readdirSync(spool).filter(name => name.startsWith("older")).sort().map(name => `${name}:${readFileSync(join(spool, name))}`).join("\n")).toBe(before);
    }, 30_000);
  }

  function plantSpoolMd(bus: string, id: string, withMeta: boolean) {
    const spool = join(bus, "spool");
    mkdirSync(spool, { recursive: true });
    const bodyPath = join(spool, `${id}.md`);
    writeFileSync(bodyPath, `---\nid: ${id}\nfrom: ua\nto: ub\nkind: discuss\nreply: settle-only\npath: ${bodyPath}\n---\nparked\n`);
    if (withMeta) {
      writeFileSync(join(spool, `${id}.meta.json`), `${JSON.stringify({
        id, target: "ub", team: "flip", pane: "ub:0.0", pane_id: "%7", to_team: "",
        target_registry: join(bus, "..", "team-registry.json"),
        policy: "standard", reason: "pending-input", reason_class: "busy",
        attempts: 0, first_spooled: "t", first_spooled_epoch: 1,
        deadline_epoch: 9999999999,
      }, null, 2)}\n`);
    }
    return { spool, bodyPath, metaPath: join(spool, `${id}.meta.json`) };
  }

  function snapshotSpool(spool: string): string {
    return readdirSync(spool).sort().map((name) => {
      const path = join(spool, name);
      return `${name}:${readFileSync(path)}`;
    }).join("\n");
  }

  test("a body-only root artifact stays untouched by native send", () => {
    const fx = teamFixture({});
    const planted = plantSpoolMd(fx.bus, "ua-20260831T040000Z-parkbody01", false);
    const before = snapshotSpool(planted.spool);
    expect(existsSync(planted.bodyPath)).toBe(true);
    expect(existsSync(planted.bodyPath)).toBe(true);
    expect(snapshotSpool(planted.spool)).toBe(before);
    const trace = join(fx.root, "route.trace");
    const result = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "ua"],
      {
        cwd: fx.wt,
        env: { ...fx.env, TAP_BUN_ROUTE_TRACE: trace, TAP_TUI_SETTLE_SCALE: "0.1" },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 20_000,
        killSignal: "SIGKILL",
      },
    );
    expect(readFileSync(trace, "utf8")).toBe("native send\n");
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(snapshotSpool(planted.spool)).toBe(before);
  }, 40_000);

  test("a complete pair stays untouched by native send until an explicit drain", () => {
    const fx = teamFixture({});
    // Isolate legacy-spool ownership from the independent post-delivery window.
    fx.env.TAP_AUTOSETTLE_HOLD_SECONDS = "0";
    writeFileSync(join(fx.bus, ".tap-bus-authority"), "bootstrapped_at_epoch=1\n");
    const planted = plantSpoolMd(fx.bus, "ua-20260831T040100Z-parkpair01", true);
    const before = snapshotSpool(planted.spool);
    expect(existsSync(planted.bodyPath)).toBe(true);
    expect(existsSync(planted.bodyPath)).toBe(true);
    expect(snapshotSpool(planted.spool)).toBe(before);
    const firstTrace = join(fx.root, "first.trace");
    const first = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "ua", "--ask"],
      {
        cwd: fx.wt,
        env: { ...fx.env, TAP_BUN_ROUTE_TRACE: firstTrace, TAP_TUI_SETTLE_SCALE: "0.1" },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 20_000,
        killSignal: "SIGKILL",
      },
    );
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    expect(readFileSync(firstTrace, "utf8")).toBe("native send\n");
    // Send no longer drains unrelated queued mail (L1 U5). Drive the actual
    // drain explicitly; never simulate progress by deleting the legacy pair.
    expect(readFileSync(planted.bodyPath, "utf8")).toContain("parked");
    // The fake stores the previous turn's band and completion marker on disk.
    // Start each separate delivery from an empty input band.
    const clearInput = () => {
      for (const path of [fx.env.FAKE_SUBMITTED, fx.env.FAKE_BAND]) {
        if (path && existsSync(path)) unlinkSync(path);
      }
    };
    clearInput();
    const lib = join(import.meta.dir, "..", "..", "..", "skills", "tap", "scripts", "smoke/runtime-helpers.sh");
    const drain = spawnSync("bash", ["-c", '. "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once', "bash", lib], {
      cwd: fx.wt, env: fx.env, encoding: "utf8",
    });
    expect(drain.status, drain.stderr).toBe(0);
    expect(existsSync(planted.bodyPath), drain.stdout + drain.stderr).toBe(false);
    clearInput();

    const secondTrace = join(fx.root, "second.trace");
    const second = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "-m", "hello-again", "--from", "ua", "--ask"],
      { cwd: fx.wt, env: { ...fx.env, TAP_BUN_ROUTE_TRACE: secondTrace }, stdout: "pipe", stderr: "pipe" },
    );
    expect(second.exitCode).toBe(0);
    expect(readFileSync(secondTrace, "utf8")).toBe("native send\n");
    const followUps = payloads(fx.bus).filter((name) => readFileSync(join(fx.bus, "payloads", name), "utf8").includes("hello-again"));
    expect(followUps).toHaveLength(1);
  }, 120_000);

  test("public reply and its follow-up stay native beside a body-only artifact", () => {
    const inboundA = "ub-20260831T040200Z-aabbccddeeff";
    const inboundB = "ub-20260831T040300Z-aabbccddeeff";
    const fx = teamFixture({ inbound: { id: inboundA, from: "ub", to: "ua" } });
    // Isolate legacy-spool ownership from the independent post-delivery window.
    fx.env.TAP_AUTOSETTLE_HOLD_SECONDS = "0";
    plantSpoolMd(fx.bus, "ua-20260831T040200Z-parkbody02", false);
    const firstTrace = join(fx.root, "reply-first.trace");
    Bun.spawnSync(
      [process.execPath, REENABLED, "reply", inboundA, "-m", "answer", "--by", "ua"],
      {
        cwd: fx.wt,
        env: { ...fx.env, TAP_BUN_ROUTE_TRACE: firstTrace, TAP_TUI_SETTLE_SCALE: "0.1" },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 20_000,
        killSignal: "SIGKILL",
      },
    );
    expect(readFileSync(firstTrace, "utf8")).toBe("native reply\n");

    const pathB = join(fx.bus, "payloads", `${inboundB}.md`);
    writeFileSync(pathB, stampEnvelope("---\n---\nquestion-b\n", {
      id: inboundB, from: "ub", to: "ua", kind: "discuss", path: pathB, reply: "expected",
    }));
    expect(existsSync(join(fx.bus, "spool", "ua-20260831T040200Z-parkbody02.md"))).toBe(true);
    const submitted = fx.env.FAKE_SUBMITTED as string;
    if (existsSync(submitted)) unlinkSync(submitted);
    const secondTrace = join(fx.root, "reply-second.trace");
    const second = Bun.spawnSync(
      [process.execPath, REENABLED, "reply", inboundB, "-m", "answer-b", "--by", "ua"],
      { cwd: fx.wt, env: { ...fx.env, TAP_BUN_ROUTE_TRACE: secondTrace }, stdout: "pipe", stderr: "pipe" },
    );
    expect(second.exitCode).toBe(0);
    expect(readFileSync(secondTrace, "utf8")).toBe("native reply\n");
    expect(existsSync(join(fx.bus, "receipts", `${inboundB}.done`))).toBe(true);
  }, 40_000);
});

describe("ambient TAP_EPOCH is native on reply (D4c)", () => {
  test("TAP_EPOCH traces native reply and is stamped on the settle receipt", () => {
    const inboundId = "ub-20260831T050100Z-aabbccddeeff";
    const fx = teamFixture({ inbound: { id: inboundId, from: "ub", to: "ua" } });
    const trace = join(fx.root, "epoch.trace");
    const result = Bun.spawnSync(
      [process.execPath, REENABLED, "reply", inboundId, "-m", "answer", "--by", "ua"],
      {
        cwd: fx.wt,
        env: { ...fx.env, TAP_EPOCH: "17", TAP_BUN_ROUTE_TRACE: trace, TAP_TUI_SETTLE_SCALE: "0.1" },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15000,
        killSignal: "SIGKILL",
      },
    );
    expect(readFileSync(trace, "utf8")).toBe("native reply\n");
    expect(result.exitCode).toBe(0);
    expect((JSON.parse(readFileSync(join(fx.bus, "receipts", `${inboundId}.done`), "utf8")) as { epoch?: string }).epoch).toBe("17");
  }, 40_000);
});

describe("native send_submit_unverified is durable", () => {
  test("unverified send appends the registry event and outstanding names send_unverified", () => {
    const fx = teamFixture({});
    writeFileSync(fx.env.FAKE_INJECT_FAIL as string, "1\n");
    const trace = join(fx.root, "unverified.trace");
    const result = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "ua", "--ask"],
      {
        cwd: fx.wt,
        env: { ...fx.env, TAP_BUN_ROUTE_TRACE: trace, TAP_TUI_SETTLE_SCALE: "0.1" },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15000,
        killSignal: "SIGKILL",
      },
    );
    expect(readFileSync(trace, "utf8")).toBe("native send\n");
    expect(result.exitCode).toBe(5);
    const names = payloads(fx.bus);
    expect(names).toHaveLength(1);
    const id = names[0]!.replace(/\.md$/, "");
    const events = readFileSync(join(fx.bus, "registry-events.log"), "utf8");
    expect(events).toMatch(
      new RegExp(`actor=ua action=send_submit_unverified handle=ub pane=ub:0\\.0 detail=id=${id}`),
    );
    const outstanding = Bun.spawnSync(
      [process.execPath, MAIN, "outstanding", "ua", "--json"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe", timeout: 20_000, killSignal: "SIGKILL" },
    );
    expect(outstanding.exitCode).toBe(2);
    expect(outstanding.stdout.toString()).toContain(`"kind":"send_unverified"`);
    expect(outstanding.stdout.toString()).toContain(`"id":"${id}"`);
    // tap-7r3fn.146, same budget invariant: the 15000ms --ask send plus the
    // 8000ms outstanding call sum to 23000ms, above the old 20_000ms budget.
  }, 30_000);

  test("unverified send still returns 5 when the registry event log cannot be appended", () => {
    const fx = teamFixture({});
    writeFileSync(fx.env.FAKE_INJECT_FAIL as string, "1\n");
    mkdirSync(join(fx.bus, "registry-events.log"));
    const result = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "ua", "--ask"],
      {
        cwd: fx.wt,
        env: { ...fx.env, TAP_TUI_SETTLE_SCALE: "0.1" },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15000,
        killSignal: "SIGKILL",
      },
    );
    expect(result.exitCode).toBe(5);
    const names = payloads(fx.bus);
    expect(names).toHaveLength(1);
    const id = names[0]!.replace(/\.md$/, "");
    expect(existsSync(join(fx.bus, "receipts", `${id}.placed`))).toBe(true);
    expect(existsSync(join(fx.bus, "receipts", `${id}.sent`))).toBe(false);
    const err = result.stderr.toString();
    expect(err).toContain("tap send: warning: registry event log append failed action=send_submit_unverified handle=ub");
    expect(err.split("send_submit_unverified").length - 1).toBe(1);
  }, 40_000);

  test("a paste chip after Enter is unverified and writes no .sent", () => {
    const fx = teamFixture({});
    writeFileSync(fx.env.FAKE_CHIP as string, "1\n");
    const result = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "ua", "--ask"],
      {
        cwd: fx.wt,
        env: { ...fx.env, TAP_TUI_SETTLE_SCALE: "0.1" },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15000,
        killSignal: "SIGKILL",
      },
    );
    expect(result.exitCode).toBe(5);
    const names = payloads(fx.bus);
    expect(names).toHaveLength(1);
    const id = names[0]!.replace(/\.md$/, "");
    expect(existsSync(join(fx.bus, "receipts", `${id}.placed`))).toBe(true);
    expect(existsSync(join(fx.bus, "receipts", `${id}.sent`))).toBe(false);
    expect(existsSync(fx.env.FAKE_SUBMITTED as string)).toBe(true);
  }, 40_000);
});
