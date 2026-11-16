// tap_serial_triggers "bin/" "runtime/bun/test/support/send-reply-flip-fixture.ts" "runtime/bun/main.ts" "runtime/bun/test/support/native-send-entry.ts" "runtime/bun/test/support/native-reply-entry.ts" "runtime/bun/test/support/reenabled-router-entry.ts"
// reply-obligations-fences — component split out of the former
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
import { NATIVE_SEND, NATIVE_REPLY, MAIN, REENABLED, scratch, teamFixture, spawnGit, waitFor, payloads, placed, assertParked, paneObserveCount, resetLockProbe, startPoller, flushScratch } from "./support/send-reply-flip-fixture";
import { writeLiveFence } from "./support/live-fence";

afterEach(() => flushScratch(), 40_000);

describe("D1 reply obligation modes — --expect-reply, --progress, --json", () => {
  test("the receipt's queued predicate is spool, poll AND the harness queue", () => {
    // The native receipt once counted only poll and spool, so a harness-queued
    // outbound was reported as "sent … submitted to pane" — a pane effect that
    // never happened.
    const queued = ["queued-harness", "queued-poll", "queued-spool"];
    for (const d of ["delivered", "queued-poll", "queued-spool", "queued-harness", "unverified"] as const) {
      expect({ d, queued: receiptQueued(d) }).toEqual({ d, queued: queued.includes(d) });
    }
  });

  const BIN_TAP = join(import.meta.dir, "..", "..", "..", "bin", "tap");
  type Fx = ReturnType<typeof teamFixture>;
  function fixture(inbound: { id: string; reply?: string }) {
    const fx = teamFixture({
      seats: { pollbot: { status: "active", delivery: "poll", instance: "pollbot|A" } },
      inbound: { id: inbound.id, from: "pollbot", to: "ua", extra: inbound.reply ? { reply: inbound.reply } : undefined },
    });
    writeFileSync(join(fx.bus, "registry.json"), readFileSync(join(fx.wt, ".tap", "team-registry.json")));
    return fx;
  }
  function reply(fx: Fx, args: string[]) {
    const trace = join(fx.root, `route.${Math.random().toString(36).slice(2)}.trace`);
    const r = Bun.spawnSync(["bash", BIN_TAP, "reply", ...args, "--by", "ua"], {
      cwd: fx.wt, env: { ...fx.env, TAP_BUN_ROUTE_TRACE: trace },
      stdout: "pipe", stderr: "pipe", timeout: 60_000,
    });
    const norm = (s: string) => s.split(fx.root).join("<ROOT>");
    const outbound = payloads(fx.bus).filter((n) => !n.startsWith("pollbot-"));
    const outboundRaw = outbound.length === 1 ? readFileSync(join(fx.bus, "payloads", outbound[0]!), "utf8") : "";
    return {
      code: r.exitCode, out: norm(r.stdout.toString()), err: norm(r.stderr.toString()),
      traced: existsSync(trace) ? readFileSync(trace, "utf8") : "",
      outbounds: outbound.length,
      outboundReply: envelopeField(outboundRaw, "reply") ?? "",
      outboundInReplyTo: envelopeField(outboundRaw, "in_reply_to") ?? "",
    };
  }
  const rows: Array<{ label: string; inboundReply?: string; args: string[]; code: number; outbounds: number; outboundReply: string; settled: boolean; out?: string; errContains?: string }> = [
    { label: "--expect-reply: the outbound is reply=expected and the inbound settles", args: ["-m", "a question back", "--expect-reply"], code: 0, outbounds: 1, outboundReply: "expected", settled: true },
    { label: "plain reply: the outbound is settle-only and the inbound settles", args: ["-m", "answer"], code: 0, outbounds: 1, outboundReply: "settle-only", settled: true },
    { label: "--progress: settle-only outbound, the inbound stays OPEN, its own receipt", args: ["-m", "half way", "--progress"], code: 0, outbounds: 1, outboundReply: "settle-only", settled: false, out: "tap reply: progress <ID> (open)\n" },
    { label: "--progress on a settle-only inbound is sender_contract", inboundReply: "settle-only", args: ["-m", "x", "--progress"], code: 1, outbounds: 0, outboundReply: "", settled: false, errContains: "--progress requires a reply=expected inbound; '<ID>' is reply=settle-only — a note settles when you read it; next: tap read <ID>" },
    { label: "--progress --expect-reply is progress_settle_only", args: ["-m", "x", "--progress", "--expect-reply"], code: 1, outbounds: 0, outboundReply: "", settled: false, errContains: "--progress is hard reply=settle-only; remove --expect-reply; next: tap reply <ID> --progress -f <file>" },
    { label: "--json is unknown_option on reply", args: ["-m", "x", "--json"], code: 1, outbounds: 0, outboundReply: "", settled: false, errContains: "unknown option '--json'; next: tap help reply" },
  ];
  // The partner reviewer's D1 F2: the .done receipt hashes the reply body as BYTES
  // (hashing over the file bytes after the closing fence); a byte-invalid
  // body decoded and re-encoded would hash to a different value.
  test("a byte-invalid -f reply body settles with the pinned reply_sha256", () => {
    const id = "pollbot-20260901T000099Z-aabbccddeeff";
    const fx = fixture({ id });
    const body = join(fx.root, "bad.md"); writeFileSync(body, Buffer.from([0xc3, 0x28, 0xff, 0x00, 0x61, 0x0a]));
    const r = reply(fx, [id, "-f", body]);
    const done = readFileSync(join(fx.bus, "receipts", `${id}.done`), "utf8");
    const sha = /"reply_sha256":"([0-9a-f]{64})"/.exec(done)?.[1] ?? "";
    expect({ code: r.code, traced: r.traced }).toEqual({ code: 0, traced: "native reply\n" });
    expect(sha).toBe("66004aaac8c43d683f1dc1de60678988c20e6e12edd5b10f2028c68150f12e7a");
  }, 180_000);

  let n = 0;
  for (const row of rows) {
    test(row.label, () => {
      const id = `pollbot-20260901T0000${String(++n).padStart(2, "0")}Z-aabbccddeeff`;
      const fx = fixture({ id, reply: row.inboundReply });
      const r = { ...reply(fx, [id, ...row.args]), settled: existsSync(join(fx.bus, "receipts", `${id}.done`)) };
      expect({ label: row.label, code: r.code, outbounds: r.outbounds, outboundReply: r.outboundReply, settled: r.settled })
        .toEqual({ label: row.label, code: row.code, outbounds: row.outbounds, outboundReply: row.outboundReply, settled: row.settled });
      if (row.outbounds) expect(r.outboundInReplyTo).toBe(id);
      if (row.out) expect(r.out).toBe(row.out.replace("<ID>", id));
      if (row.errContains) expect(r.err).toContain(row.errContains.split("<ID>").join(id));
      expect({ label: row.label, traced: r.traced }).toEqual({ label: row.label, traced: "native reply\n" });
    }, 180_000);
  }
});

describe("reset custody on send and reply", () => {
  test("a live fence refuses send before any bus effect", () => {
    const dir = mkdtempSync(join(tmpdir(), "tap-send-fence."));
    scratch.push(dir);
    const bus = join(dir, "bus");
    mkdirSync(bus);
    writeLiveFence(join(bus, "reset.fence.json"));
    const env = {
      ...process.env,
      TAP_HOME: bus,
      TAP_INDEX_HOME: join(dir, "index"),
      TAP_LOCK_DIR: join(dir, "locks"),
    } as NodeJS.ProcessEnv;
    mkdirSync(env.TAP_INDEX_HOME!);
    writeFileSync(join(env.TAP_INDEX_HOME!, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} }));
    const result = Bun.spawnSync([process.execPath, NATIVE_SEND, "ub", "-m", "x", "--from", "ua", "--ask"], {
      cwd: dir, env, stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("mid-reset");
    expect(existsSync(join(bus, "payloads"))).toBe(false);
    expect(existsSync(join(bus, "receipts"))).toBe(false);
  });

  test("fence during the send observe window still leaves zero canonical and zero .placed", async () => {
    const fx = teamFixture({ parkAfter: 0 });
    const send = Bun.spawn([process.execPath, NATIVE_SEND, "ub", "-m", "hello", "--from", "ua", "--ask"], {
      cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe",
    });
    waitFor(fx.reached);
    expect(payloads(fx.bus)).toEqual([]);
    expect(placed(fx.bus)).toEqual([]);
    writeLiveFence(join(fx.bus, "reset.fence.json"));
    writeFileSync(fx.release, "go\n");
    expect(await send.exited).toBe(1);
    expect((await new Response(send.stderr).text())).toContain("mid-reset");
    expect(payloads(fx.bus)).toEqual([]);
    expect(placed(fx.bus)).toEqual([]);
  }, 30_000);

  test("a live fence refuses reply before outbound send or inbound settlement", () => {
    const inboundId = "ub-20260831T000000Z-aabbccddeeff";
    const fx = teamFixture({ fence: true, inbound: { id: inboundId, from: "ub", to: "ua" } });
    const before = payloads(fx.bus);
    const result = Bun.spawnSync([process.execPath, NATIVE_REPLY, inboundId, "-m", "answer", "--by", "ua"], {
      cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("mid-reset");
    expect(payloads(fx.bus)).toEqual(before);
    expect(existsSync(join(fx.bus, "receipts", `${inboundId}.done`))).toBe(false);
  });

  test("fence between outbound send and inbound settlement keeps the outbound and refuses .done", async () => {
    const inboundId = "ub-20260831T000100Z-aabbccddeeff";
    // Park on inject, after the pane-effect fence recheck, so this stays the
    // settlement-window control.
    const fx = teamFixture({ parkOnInject: true, inbound: { id: inboundId, from: "ub", to: "ua" } });
    const reply = Bun.spawn(
      [process.execPath, NATIVE_REPLY, inboundId, "-m", "answer", "--by", "ua"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    waitFor(fx.reached);
    expect(payloads(fx.bus).some((name) => name !== `${inboundId}.md`)).toBe(true);
    expect(existsSync(join(fx.bus, "receipts", `${inboundId}.done`))).toBe(false);
    writeLiveFence(join(fx.bus, "reset.fence.json"));
    writeFileSync(fx.release, "go\n");
    expect(await reply.exited).toBe(1);
    expect((await new Response(reply.stderr).text())).toContain("mid-reset");
    expect(payloads(fx.bus).some((name) => name !== `${inboundId}.md`)).toBe(true);
    expect(existsSync(join(fx.bus, "receipts", `${inboundId}.done`))).toBe(false);
  }, 30_000);

  test("a settle refusal after the outbound advises inspection, never the retired done or a re-reply", async () => {
    const inboundId = "ub-20260831T000200Z-aabbccddeeff";
    const fx = teamFixture({ parkOnInject: true, inbound: { id: inboundId, from: "ub", to: "ua" } });
    const reply = Bun.spawn(
      [process.execPath, NATIVE_REPLY, inboundId, "-m", "answer", "--by", "ua"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    waitFor(fx.reached);
    const outbound = payloads(fx.bus).filter((name) => name !== `${inboundId}.md`);
    expect(outbound.length).toBe(1);
    const outId = outbound[0]!.replace(/\.md$/, "");
    // The inbound vanishing mid-flight makes the settler refuse no_local_payload,
    // whose own advice is the retired `tap done ... --payload`.
    unlinkSync(join(fx.bus, "payloads", `${inboundId}.md`));
    writeFileSync(fx.release, "go\n");
    expect(await reply.exited).toBe(1);
    const err = await new Response(reply.stderr).text();
    expect(err).toContain(`no payload '${inboundId}'`);
    expect(err).not.toMatch(/\btap (?:help )?done\b/);
    expect(err).toContain("do not re-run 'tap reply'");
    expect(err).toContain(`next: tap show ${outId}`);
    expect(existsSync(join(fx.bus, "receipts", `${inboundId}.done`))).toBe(false);
    // The advised lookup is read-only and finds the reply that was sent.
    const show = Bun.spawnSync([process.execPath, MAIN, "show", outId], { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" });
    expect(show.exitCode).toBe(0);
    expect(show.stdout.toString()).toContain(outId);
    expect(payloads(fx.bus)).toEqual(outbound);
  }, 30_000);

  test("an authority change after the outbound never advises a re-reply", async () => {
    const inboundId = "ub-20260831T000300Z-aabbccddeeff";
    const fx = teamFixture({ parkOnInject: true, inbound: { id: inboundId, from: "ub", to: "ua" } });
    const reply = Bun.spawn(
      [process.execPath, NATIVE_REPLY, inboundId, "-m", "answer", "--by", "ua"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    waitFor(fx.reached);
    const outbound = payloads(fx.bus).filter((name) => name !== `${inboundId}.md`);
    expect(outbound.length).toBe(1);
    const outId = outbound[0]!.replace(/\.md$/, "");
    // Readdress the inbound mid-flight: the settle's authority recheck refuses
    // not_addressee, whose own advice is `tap reply <id> --by <addressee>`.
    const inboundPath = join(fx.bus, "payloads", `${inboundId}.md`);
    writeFileSync(inboundPath, readFileSync(inboundPath, "utf8").replace(/^to: ua$/m, "to: uc"));
    writeFileSync(fx.release, "go\n");
    expect(await reply.exited).toBe(1);
    const err = await new Response(reply.stderr).text();
    expect(err).toContain(`is addressed to 'uc', not 'ua'`);
    expect(err).not.toMatch(/next: tap (?:help )?(?:reply|done)\b/);
    expect(err).toContain("do not re-run 'tap reply'");
    expect(err).toContain(`next: tap show ${outId}`);
    expect(existsSync(join(fx.bus, "receipts", `${inboundId}.done`))).toBe(false);
    expect(payloads(fx.bus).filter((name) => name !== `${inboundId}.md`)).toEqual(outbound);
  }, 30_000);

  test("a successful send marks a pristine reset generation reused", async () => {
    const fx = teamFixture({ generation: { bundle_id: "bundle", state: "pristine" } });
    writeFileSync(fx.release, "go\n");
    const result = Bun.spawnSync([process.execPath, NATIVE_SEND, "ub", "-m", "hello", "--from", "ua", "--ask"], {
      cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(fx.bus, "reset-generation.json"), "utf8"))).toEqual({
      bundle_id: "bundle",
      state: "reused",
      first_mutation: "send",
    });
  });

  // tap-0p7hx: custody covers placement, not pane delivery.
  test("reset can acquire its sidecar once send has placed, while delivery is still pending", async () => {
    const fx = teamFixture({ parkAfter: 2 });
    const send = Bun.spawn([process.execPath, NATIVE_SEND, "ub", "-m", "hello", "--from", "ua", "--ask"], {
      cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe",
    });
    waitFor(fx.reached);
    expect(payloads(fx.bus).length).toBe(1);
    expect(placed(fx.bus).length).toBe(1);
    expect(resetLockProbe(fx.bus).status).toBe(0);
    writeFileSync(fx.release, "go\n");
    expect(await send.exited).toBe(0);
    expect(resetLockProbe(fx.bus).status).toBe(0);
  }, 30_000);

  test("reset can acquire its sidecar while a reply's outbound is pending delivery, before settlement", async () => {
    const inboundId = "ub-20260831T000200Z-aabbccddeeff";
    const fx = teamFixture({ parkAfter: 2, inbound: { id: inboundId, from: "ub", to: "ua" } });
    const reply = Bun.spawn(
      [process.execPath, NATIVE_REPLY, inboundId, "-m", "answer", "--by", "ua"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    waitFor(fx.reached);
    expect(payloads(fx.bus).some((name) => name !== `${inboundId}.md`)).toBe(true);
    expect(existsSync(join(fx.bus, "receipts", `${inboundId}.done`))).toBe(false);
    expect(resetLockProbe(fx.bus).status).toBe(0);
    writeFileSync(fx.release, "go\n");
    expect(await reply.exited).toBe(0);
    expect(existsSync(join(fx.bus, "receipts", `${inboundId}.done`))).toBe(true);
    expect(resetLockProbe(fx.bus).status).toBe(0);
  }, 30_000);

  test("send fails closed when reset mutation custody is already held", () => {
    const fx = teamFixture({});
    const held = acquirePathLock(join(fx.bus, "reset.fence.json.lock"), 5000, fx.env);
    expect(held).not.toBeNull();
    try {
      const result = Bun.spawnSync([process.execPath, NATIVE_SEND, "ub", "-m", "hello", "--from", "ua", "--ask"], {
        cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe",
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain("could not obtain reset mutation custody");
      expect(result.stderr.toString()).toContain("retry this command");
      expect(result.stderr.toString()).not.toContain("tap team reset");
      expect(payloads(fx.bus)).toEqual([]);
      expect(placed(fx.bus)).toEqual([]);
    } finally {
      held!.release();
    }
  });

  test("reset custody contention distinguishes a brief mutation from a reset fence", () => {
    const fx = teamFixture({});
    const held = acquirePathLock(join(fx.bus, "reset.fence.json.lock"), 5000, fx.env);
    expect(held).not.toBeNull();
    try {
      let busy: unknown;
      try {
        acquireResetMutationLock(fx.bus, "tap reply");
      } catch (error) {
        busy = error;
      }
      expect(busy).toBeInstanceOf(TapError);
      expect((busy as TapError).errorClass).toBe("reset_custody_busy");
      expect((busy as TapError).action).toContain("retry this command");
      expect((busy as TapError).action).not.toContain("tap team reset");
      expect((busy as TapError).detail).toContain("could not obtain reset mutation custody");

      const fencePath = join(fx.bus, "reset.fence.json"), directory = join(fx.bus, "fence-directory");
      mkdirSync(fencePath); mkdirSync(directory);
      expect(resetFenceRefusal(fx.bus, "tap reply")).toBeNull();
      let directoryBusy: unknown;
      try { acquireResetMutationLock(fx.bus, "tap reply"); } catch (error) { directoryBusy = error; }
      expect((directoryBusy as TapError).errorClass).toBe("reset_custody_busy");
      rmSync(fencePath, { recursive: true }); symlinkSync(directory, fencePath);
      expect(resetFenceRefusal(fx.bus, "tap reply")).toBeNull();
      let symlinkDirectoryBusy: unknown;
      try { acquireResetMutationLock(fx.bus, "tap reply"); } catch (error) { symlinkDirectoryBusy = error; }
      expect((symlinkDirectoryBusy as TapError).errorClass).toBe("reset_custody_busy");
      rmSync(fencePath);
      writeLiveFence(join(fx.bus, "reset.fence.json"));
      expect(resetFenceRefusal(fx.bus, "tap reply")).not.toBeNull();
      let fenced: unknown;
      try {
        acquireResetMutationLock(fx.bus, "tap reply");
      } catch (error) {
        fenced = error;
      }
      expect(fenced).toBeInstanceOf(TapError);
      expect((fenced as TapError).errorClass).toBe("team_reset_fenced");
      expect((fenced as TapError).action).toBe(
        "wait for the reset owner (or until identity is readable)",
      );
      expect((fenced as TapError).detail).toContain("could not obtain reset mutation custody");
    } finally {
      held!.release();
    }
  });
});

describe("pane-effect fence recheck after placement", () => {
  test("a reset fence that appears after placement prevents inject and leaves the canonical for the checkpoint", async () => {
    const fx = teamFixture({ parkAfter: 2 });
    const send = Bun.spawn([process.execPath, NATIVE_SEND, "ub", "-m", "hello", "--from", "ua", "--ask"], {
      cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe",
    });
    waitFor(fx.reached);
    expect(payloads(fx.bus)).toHaveLength(1);
    expect(placed(fx.bus)).toHaveLength(1);
    expect(existsSync(fx.env.FAKE_SUBMITTED as string)).toBe(false);
    writeLiveFence(join(fx.bus, "reset.fence.json"));
    writeFileSync(fx.release, "go\n");
    // Withdrawing now would mutate the bus inside the reset's checkpoint
    // (tap-0p7hx, the tap-g191v shape): rc 5, placed, not delivered.
    expect(await send.exited).toBe(5);
    const stderr = await new Response(send.stderr).text();
    expect(stderr).toContain("team_reset_fenced");
    expect(stderr).toContain("will not be delivered");
    expect(payloads(fx.bus)).toHaveLength(1);
    expect(placed(fx.bus)).toHaveLength(1);
    expect(existsSync(fx.env.FAKE_SUBMITTED as string)).toBe(false);
    expect(existsSync(fx.env.FAKE_BAND as string)).toBe(false);
  }, 30_000);

  test("a clear fence that appears after placement queues without inject", async () => {
    const fx = teamFixture({ parkAfter: 2 });
    const send = Bun.spawn(
      [process.execPath, NATIVE_SEND, "ub", "-m", "hello", "--from", "ua", "--ask", "--id", "ua-20260831T013000Z-aabbccddeeff"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    waitFor(fx.reached);
    expect(payloads(fx.bus)).toHaveLength(1);
    mkdirSync(join(fx.bus, "clear-fence"), { recursive: true });
    writeFileSync(join(fx.bus, "clear-fence", "ub.json"), JSON.stringify({
      since_epoch: Date.now() / 1000,
      ceiling_seconds: 600,
      pid: 1,
    }));
    writeFileSync(fx.release, "go\n");
    expect(await send.exited).toBe(0);
    expect(existsSync(join(fx.bus, "payloads", "ua-20260831T013000Z-aabbccddeeff.md"))).toBe(false);
    expect(existsSync(join(fx.bus, "receipts", "ua-20260831T013000Z-aabbccddeeff.sent"))).toBe(false);
    expect(existsSync(fx.env.FAKE_SUBMITTED as string)).toBe(false);
    expect(existsSync(fx.env.FAKE_BAND as string)).toBe(false);
    assertParked(fx, "ua-20260831T013000Z-aabbccddeeff", "clearing");
  }, 30_000);

  test("a clear fence after inject before first Enter stays unverified with no Enter", async () => {
    const fx = teamFixture({ parkOnInject: true });
    const id = "ua-20260831T013100Z-aabbccddeeff";
    const send = Bun.spawn(
      [process.execPath, NATIVE_SEND, "ub", "-m", "hello", "--from", "ua", "--ask", "--id", id, "--json"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    waitFor(fx.reached);
    expect(payloads(fx.bus)).toHaveLength(1);
    expect(placed(fx.bus)).toHaveLength(1);
    expect(existsSync(fx.env.FAKE_BAND as string)).toBe(false);
    expect(existsSync(fx.env.FAKE_SUBMITTED as string)).toBe(false);
    mkdirSync(join(fx.bus, "clear-fence"), { recursive: true });
    writeFileSync(join(fx.bus, "clear-fence", "ub.json"), JSON.stringify({
      since_epoch: Date.now() / 1000,
      ceiling_seconds: 600,
      pid: 1,
    }));
    writeFileSync(fx.release, "go\n");
    expect(await send.exited).toBe(5);
    const rec = JSON.parse((await new Response(send.stdout).text()).trim().split("\n").at(-1)!);
    expect(rec).toMatchObject({
      status: "pending",
      error_class: "submit_unverified",
      action: "tap outstanding ua",
      id,
    });
    expect(existsSync(join(fx.bus, "payloads", `${id}.md`))).toBe(true);
    expect(existsSync(join(fx.bus, "receipts", `${id}.placed`))).toBe(true);
    expect(existsSync(join(fx.bus, "receipts", `${id}.sent`))).toBe(false);
    expect(existsSync(fx.env.FAKE_BAND as string)).toBe(true);
    expect(existsSync(fx.env.FAKE_SUBMITTED as string)).toBe(false);
    const keys = existsSync(fx.env.FAKE_KEYS as string) ? readFileSync(fx.env.FAKE_KEYS as string, "utf8") : "";
    expect(keys).toContain(" -l -- ");
    expect(keys).not.toMatch(/ Enter /);
  }, 30_000);
});

describe("bound-harness authorization before placement", () => {
  test("a static harness mismatch plus concurrent poll never sees canonical or .placed", async () => {
    const fx = teamFixture({ command: "bash", parkAfter: 0 });
    const stop = join(fx.root, "poller-stop");
    const log = join(fx.root, "poll.log");
    const seen = join(fx.root, "poll.seen");
    const poller = startPoller(fx, stop, log, seen);
    const send = Bun.spawn([process.execPath, NATIVE_SEND, "ub", "-m", "hello", "--from", "ua", "--ask"], {
      cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe",
    });
    waitFor(fx.reached);
    expect(payloads(fx.bus)).toEqual([]);
    expect(placed(fx.bus)).toEqual([]);
    Bun.sleepSync(50);
    expect(payloads(fx.bus)).toEqual([]);
    expect(placed(fx.bus)).toEqual([]);
    writeFileSync(fx.release, "go\n");
    expect(await send.exited).toBe(1);
    const err = await new Response(send.stderr).text();
    expect(err).toContain("reason=denylist");
    expect(err).toContain("runs 'bash' (not an agent REPL)");
    // The sender gets a step it can take, not an internal token.
    expect(err).toContain("; next: run tap in ub from inside an agent, or start one with tap launch <harness> <name>");
    expect(err).not.toContain("next: escalate");
    writeFileSync(stop, "1\n");
    if (poller.pid) Bun.spawnSync(["pkill", "-KILL", "-P", String(poller.pid)]);
    poller.kill("SIGKILL");
    await poller.exited;
    expect(payloads(fx.bus)).toEqual([]);
    expect(placed(fx.bus)).toEqual([]);
    expect(readFileSync(seen, "utf8")).toBe("");
    expect(readFileSync(log, "utf8")).not.toMatch(/id:/);
  }, 30_000);
});

const STALE_BOOT = "bootuuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LIVE_BOOT = "bootuuid:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("registered boot_id authorization", () => {
  test("a stale registered boot_id refuses before placement with matching server_epoch", () => {
    const fx = teamFixture({
      seats: {
        ub: {
          status: "active", pane: "ub:0.0", pane_id: "%7", server_epoch: "srv:123:456",
          boot_id: STALE_BOOT, instance: "ub|A", harness: "claude",
        },
      },
    });
    const result = Bun.spawnSync(
      [process.execPath, NATIVE_SEND, "ub", "-m", "hello", "--from", "ua", "--ask"],
      { cwd: fx.wt, env: { ...fx.env, TAP_BOOT_ID: LIVE_BOOT }, stdout: "pipe", stderr: "pipe" },
    );
    const err = `${result.stderr.toString()}${result.stdout.toString()}`;
    expect(result.exitCode).toBe(1);
    expect(err).toContain("boot_id_stale");
    expect(err).toContain("stored boot_id");
    expect(payloads(fx.bus)).toEqual([]);
    expect(placed(fx.bus)).toEqual([]);
    expect(existsSync(fx.env.FAKE_SUBMITTED as string)).toBe(false);
  });

  test("an unreadable current boot refuses a stamped row before placement", () => {
    const fx = teamFixture({
      seats: {
        ub: {
          status: "active", pane: "ub:0.0", pane_id: "%7", server_epoch: "srv:123:456",
          boot_id: STALE_BOOT, instance: "ub|A", harness: "claude",
        },
      },
    });
    const result = Bun.spawnSync(
      [process.execPath, NATIVE_SEND, "ub", "-m", "hello", "--from", "ua", "--ask"],
      { cwd: fx.wt, env: { ...fx.env, TAP_BOOT_ID: "" }, stdout: "pipe", stderr: "pipe" },
    );
    const err = `${result.stderr.toString()}${result.stdout.toString()}`;
    expect(result.exitCode).toBe(1);
    expect(err).toContain("boot_id_unobservable");
    expect(payloads(fx.bus)).toEqual([]);
    expect(placed(fx.bus)).toEqual([]);
    expect(existsSync(fx.env.FAKE_SUBMITTED as string)).toBe(false);
  });

  test("a matching registered boot_id still injects", () => {
    const fx = teamFixture({
      seats: {
        ub: {
          status: "active", pane: "ub:0.0", pane_id: "%7", server_epoch: "srv:123:456",
          boot_id: LIVE_BOOT, instance: "ub|A", harness: "claude",
        },
      },
    });
    const result = Bun.spawnSync(
      [process.execPath, NATIVE_SEND, "ub", "-m", "hello", "--from", "ua", "--ask"],
      { cwd: fx.wt, env: { ...fx.env, TAP_BOOT_ID: LIVE_BOOT }, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toMatch(/^tap send: ok .+\n$/);
    expect(result.stdout.toString()).not.toContain("submitted to pane; recipient seat-side processing unverified");
    expect(payloads(fx.bus)).toHaveLength(1);
  });
});

describe("reserved identity on send", () => {
  test("courier as destination refuses before placement", () => {
    const fx = teamFixture({});
    const result = Bun.spawnSync(
      [process.execPath, NATIVE_SEND, "courier", "-m", "hello", "--from", "ua"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("reserved courier digest-envelope identity");
    expect(result.stderr.toString()).toContain("can never receive a send");
    expect(payloads(fx.bus)).toEqual([]);
    expect(placed(fx.bus)).toEqual([]);
  });

  test("courier as --from refuses before placement", () => {
    const fx = teamFixture({});
    const result = Bun.spawnSync(
      [process.execPath, NATIVE_SEND, "ub", "-m", "hello", "--from", "courier"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("reserved courier digest-envelope identity");
    expect(result.stderr.toString()).toContain("cannot be a --from sender");
    expect(payloads(fx.bus)).toEqual([]);
    expect(placed(fx.bus)).toEqual([]);
  });

  test("help as destination and --from refuses before placement", () => {
    const fx = teamFixture({});
    const toHelp = Bun.spawnSync(
      [process.execPath, NATIVE_SEND, "help", "-m", "hello", "--from", "ua"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    expect(toHelp.exitCode).toBe(1);
    expect(toHelp.stderr.toString()).toContain("CLI help keyword");
    expect(toHelp.stderr.toString()).toContain("send destination");
    const fromHelp = Bun.spawnSync(
      [process.execPath, NATIVE_SEND, "ub", "-m", "hello", "--from", "help"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    expect(fromHelp.exitCode).toBe(1);
    expect(fromHelp.stderr.toString()).toContain("CLI help keyword");
    expect(fromHelp.stderr.toString()).toContain("--from sender");
    expect(payloads(fx.bus)).toEqual([]);
  });

  test("watcher as destination refuses; watcher --from is checked natively", () => {
    const fx = teamFixture({});
    const toWatch = Bun.spawnSync(
      [process.execPath, NATIVE_SEND, "watcher", "-m", "hello", "--from", "ua"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    expect(toWatch.exitCode).toBe(1);
    expect(toWatch.stderr.toString()).toContain("reserved watcher identity");
    const trace = join(fx.root, "route.trace");
    const fromWatch = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "watcher"],
      { cwd: fx.wt, env: { ...fx.env, TAP_BUN_ROUTE_TRACE: trace }, stdout: "pipe", stderr: "pipe" },
    );
    expect(fromWatch.exitCode).not.toBe(0);
    expect(readFileSync(trace, "utf8")).toBe("native send\n");
    expect(payloads(fx.bus)).toEqual([]);
    expect(placed(fx.bus)).toEqual([]);
  });
});

describe("ordinary body source refusals", () => {
  test("an unreadable body file is a structured usage_error with no bus or pane effect", () => {
    const fx = teamFixture({});
    const body = join(fx.root, "secret.md");
    writeFileSync(body, "hello\n");
    chmodSync(body, 0);
    const result = Bun.spawnSync(
      [process.execPath, NATIVE_SEND, "ub", "-f", body, "--from", "ua", "--ask"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" },
    );
    chmodSync(body, 0o600);
    const err = String(result.stderr ?? "");
    expect(result.exitCode).toBe(1);
    expect(err).toContain(`body file is not readable: ${body}`);
    expect(err).toContain("next: tap help send");
    expect(err).not.toMatch(/\n\s+at /);
    expect(payloads(fx.bus)).toEqual([]);
    expect(placed(fx.bus)).toEqual([]);
    expect(readdirSync(join(fx.bus, "receipts"))).toEqual([]);
    expect(existsSync(fx.env.FAKE_BAND as string)).toBe(false);
    expect(existsSync(fx.env.FAKE_SUBMITTED as string)).toBe(false);
    expect(paneObserveCount(fx)).toBe(0);
  });

  // D1: a -f body is staged as BYTES on the native door; it no longer delegates
  // to Bash to keep a byte-invalid body verbatim.
  test("invalid UTF-8 named -f bytes stay native and reach the canonical unchanged", () => {
    const fx = teamFixture({});
    const body = join(fx.root, "bad.md");
    writeFileSync(body, Buffer.from([0xc3, 0x28]));
    const trace = join(fx.root, "utf8.trace");
    const result = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "-f", body, "--from", "ua", "--ask"],
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
    expect(existsSync(fx.env.FAKE_BAND as string)).toBe(true);
    const names = payloads(fx.bus);
    expect(names).toHaveLength(1);
    const raw = readFileSync(join(fx.bus, "payloads", names[0]!));
    expect(raw.includes(Buffer.from([0xc3, 0x28]))).toBe(true);
    expect(raw.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
    const sep = Buffer.from("\n---\n");
    const idx = raw.lastIndexOf(sep);
    expect(idx).toBeGreaterThanOrEqual(0);
    const got = raw.subarray(idx + sep.length);
    const bodyBytes = got.at(-1) === 0x0a ? got.subarray(0, -1) : got;
    expect(bodyBytes).toEqual(Buffer.from([0xc3, 0x28]));
    expect(result.exitCode).not.toBeUndefined();
  }, 20_000);
});
