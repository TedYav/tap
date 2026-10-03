// tap_serial_triggers "runtime/bun/test/support/send-reply-flip-fixture.ts" "runtime/bun/main.ts" "runtime/bun/test/support/native-send-entry.ts" "skills/tap/scripts/lib.sh"
// send-cutover-spool — component split out of the former
// runtime/bun/test/send-reply-flip.test.ts (Deliverable B unit 1). The test
// bodies below are verbatim moves; the shared fixture and helpers live in
// ./support/send-reply-flip-fixture.ts and this file registers its own
// scratch cleanup. The redelivery-side paired scenarios of the same describe
// live in send-cutover-redelivery.test.ts (budget split; row bytes unchanged).
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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
  // tap-7r3fn.166: same cap rationale as send-cutover-redelivery's door().
  // The old 60000ms exceeded most budgets in this file outright (60s cap in
  // 20s bodies, two calls summing 120s in 20-30s bodies) and left eight U3
  // bodies at 60s-cap-in-60s-budget zero headroom. Measured healthy whole
  // bodies span 0.3-1.4s (junit census at 1f3a4f006, 2026-10-02); children
  // here run sequentially, so a body duration upper-bounds each of its
  // children, and 6000ms clears the worst measured body by >2x while fitting
  // every body including the two-door ones (2x6000 inside 20s). Revisit if
  // any single child exceeds 3000ms (half the cap).
  function door(fx: ReturnType<typeof teamFixture>, native: boolean, argv: string[]) {
    return Bun.spawnSync(native ? [process.execPath, MAIN, ...argv] : ["bash", join(scripts, "../../../bin/tap"), ...argv], {
      cwd: fx.wt, env: { ...fx.env, TAP_BUN_ROUTE_TRACE: join(fx.root, "cutover.trace"), TAP_SPOOL_DRAIN_ACTIVE: "1",
        // The mock tmux shim has no redraw race, so the courier's settle pacing
        // only adds wall time here; the same scale the drain() helper below
        // already uses. Timeout and grace semantics never route through
        // tap_settle, so scenario deadlines are unaffected.
        TAP_TUI_SETTLE_SCALE: "0.1" },
      stdout: "pipe", stderr: "pipe", timeout: 6000, killSignal: "SIGKILL",
    });
  }
  // tap-12ys6: a reset holder never waits on a pane lock or spawns. The draft park's
  // red cue flashes under the pane lock; with the flash held at a barrier, reset
  // custody must already be free, and the deliverer spawn comes after the flash.
  test("native: a draft park flashes its cue and spawns its deliverer after releasing reset custody", async () => {
    const fx = teamFixture({});
    writeFileSync(fx.env.FAKE_BAND!, "unfinished human draft");
    const barrier = join(fx.root, "flash-barrier");
    const child = Bun.spawn([process.execPath, MAIN, "send", "ub", "--ask", "-m", "hello", "--from", "ua"], {
      cwd: fx.wt, env: { ...fx.env, TAP_SPOOL_DRAIN_ACTIVE: "1", TAP_TUI_SETTLE_SCALE: "0.1", FAKE_FLASH_BARRIER: barrier },
      stdout: "pipe", stderr: "pipe",
    });
    let probe: ReturnType<typeof resetLockProbe>;
    try {
      waitFor(`${barrier}.reached`);
      probe = resetLockProbe(fx.bus);
    } finally {
      writeFileSync(`${barrier}.release`, "");
    }
    const [rc, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ rc, err, probe: probe.status }).toEqual({ rc: 0, err: "", probe: 0 });
    assertParked(fx, placed(fx.bus)[0]!.replace(/\.placed$/, ""), "pending-input");
  }, 20_000);
  for (const native of [false, true]) {
    const label = native ? "native" : "bash";
    test(`${label}: draft park preserves shared metadata and the 30s grace`, () => {
      const fx = teamFixture({});
      fx.env.SUPERVISOR_GRACE_SECONDS = "7";
      writeFileSync(fx.env.FAKE_BAND!, "unfinished human draft");
      const result = door(fx, native, ["send", "ub", "--ask", "-m", "hello", "--from", "ua"]);
      expect(result.exitCode).toBe(0);
      const id = placed(fx.bus)[0]!.replace(/\.placed$/, "");
      const meta = assertParked(fx, id, "pending-input");
      expect(meta.deadline_epoch - meta.first_spooled_epoch).toBe(30);
      expect(meta.pane_id).toBe("%7");
      const receiptLines = result.stdout.toString().trimEnd().split("\n");
      expect(receiptLines[0]).toBe(`tap send: queued ${id}`);
      expect(receiptLines).toHaveLength(2);
      // The queue explanation names the shared protection countdown.
      expect(receiptLines[1]).toContain("Queue: draft grace until");
      expect(receiptLines[1]).toContain("submits earlier when the composer is ready");
      if (native) expect(readFileSync(join(fx.root, "cutover.trace"), "utf8")).toBe("native send\n");
    }, 20_000);

    test(`${label}: parked reply settles using the durable spool body`, () => {
      const id = "ub-20260905T000000Z-aabbccddeeff";
      const fx = teamFixture({ inbound: { id, from: "ub", to: "ua" } });
      writeFileSync(fx.env.FAKE_BAND!, "unfinished human draft");
      const result = door(fx, native, ["reply", id, "-m", "answer", "--by", "ua"]);
      expect(result.exitCode).toBe(0);
      const receipt = JSON.parse(readFileSync(join(fx.bus, "receipts", `${id}.done`), "utf8"));
      assertParked(fx, receipt.reply_id, "pending-input");
      expect(receipt.reply_sha256).toBe(createHash("sha256").update("answer\n").digest("hex"));
      expect(receipt.reply_preview).toBe("answer");
      expect(receipt.via).toBe("reply");
      expect(result.stdout.toString()).toBe(`tap reply: queued ${id}\n`);
      if (native) expect(readFileSync(join(fx.root, "cutover.trace"), "utf8")).toBe("native reply\n");
    }, 20_000);

    test(`${label}: a verified send stamps the clock and the next bare composer still receives immediately`, () => {
      const fx = teamFixture({});
      fx.env.TAP_AUTOSETTLE_HOLD_SECONDS = "10";
      fx.env.TAP_SPOOL_NOW = String(Math.floor(Date.now() / 1000));
      const first = door(fx, native, ["send", "ub", "--ask", "-m", "first", "--from", "ua"]);
      expect(first.exitCode).toBe(0);
      const clock = JSON.parse(readFileSync(join(fx.bus, "delivery", "ub.json"), "utf8"));
      expect(clock.last_delivered_at).toBe(Number(fx.env.TAP_SPOOL_NOW));
      const second = door(fx, native, ["send", "ub", "--ask", "-m", "second", "--from", "ua"]);
      expect(second.exitCode).toBe(0);
      expect(payloads(fx.bus)).toHaveLength(2);
      expect(readdirSync(join(fx.bus, "receipts")).filter(name => name.endsWith(".sent"))).toHaveLength(2);
      if (existsSync(join(fx.bus, "spool"))) expect(readdirSync(join(fx.bus, "spool")).filter(name => name.endsWith(".meta.json"))).toEqual([]);
      if (native) expect(readFileSync(join(fx.root, "cutover.trace"), "utf8")).toBe("native send\nnative send\n");
    }, 30_000);

    // The redelivery-side scenarios (a parked draft redelivers exactly once,
    // native-format-free resend eligibility, unverified attempt clock) live in
    // send-cutover-redelivery.test.ts; same describe name, same door().
  }

  // tap-12ys6 review: the failed-park fallback reads residency, so it decides under the
  // same custody as the park. Released first, a reset could move the retained payload
  // before that read and turn a durable send into a retry-inviting exit 1.
  test("native failed park decides its fallback under reset custody", async () => {
    const fx = teamFixture({});
    writeFileSync(fx.env.FAKE_BAND!, "unfinished human draft");
    writeFileSync(join(fx.bus, "spool"), "not a directory: the park transaction fails");
    const barrier = join(fx.root, "fence-barrier");
    writeFileSync(`${barrier}.send-pre-publication.release`, "");
    writeFileSync(`${barrier}.send-post-placement.release`, "");
    const child = Bun.spawn([process.execPath, NATIVE_SEND, "ub", "--ask", "-m", "hello", "--from", "ua", "--json"], {
      cwd: fx.wt, env: { ...fx.env, TAP_RESET_FENCE_TEST_BARRIER: barrier, TAP_SCRATCH_ONLY: fx.root }, stdout: "pipe", stderr: "pipe",
    });
    let probe: ReturnType<typeof resetLockProbe>;
    try {
      waitFor(`${barrier}.send-park-fallback.reached`);
      probe = resetLockProbe(fx.bus);
    } finally {
      writeFileSync(`${barrier}.send-park-fallback.release`, "");
    }
    const [rc, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect({ rc, held: probe.status !== 0, reason: JSON.parse(out).reason }).toEqual({ rc: 0, held: true, reason: "spool_park_failed" });
  }, 20_000);

  test("native late park failure reports the retained spool pair", () => {
    const fx = teamFixture({});
    writeFileSync(fx.env.FAKE_BAND!, "unfinished human draft");
    // The park runs in process (spool-park-report.ts); its late step is the detached
    // waiter spawn, whose log path is made unopenable here — the pair is already
    // published, so the receipt must name it and say no waiter is coming.
    mkdirSync(join(fx.bus, "tap-deliver.log"), { recursive: true });
    const result = Bun.spawnSync([process.execPath, NATIVE_SEND, "ub", "--ask", "-m", "hello", "--from", "ua", "--json"], { cwd: fx.wt, env: { ...fx.env, TAP_SPOOL_DISABLE_DELIVERER: undefined }, stdout: "pipe", stderr: "pipe", timeout: 15000 });
    expect(result.exitCode).toBe(0);
    const receipt = JSON.parse(result.stdout.toString());
    expect(receipt.delivery).toBe("spool");
    expect(receipt.reason).toBe("spool_park_failed");
    expect(existsSync(receipt.path)).toBe(true);
    expect(existsSync(receipt.meta)).toBe(true);
    expect(existsSync(join(fx.bus, "payloads", `${receipt.id}.md`))).toBe(false);
    expect(result.stderr.toString()).toContain("automatic redelivery is not confirmed");
  }, 20_000);

  // --note left this list in tap-dk19b's native-note slice: it is the one
  // settle-only form that never consults the guard, so it routes natively and is
  // pinned as such by "--note runs natively" below, not here.
  // --delivery now|polite, --no-spool, --polite and --polite-timeout are native
  // since D3a; the interrupt class (--urgent, --delivery interrupt,
  // --kind escalate) stays Bash-owned until D3b and is pinned in router.test.ts.
  for (const argv of [["--delivery", "now", "--ask"], ["--no-spool"]]) {
    test(`send ${argv.join(" ")} runs natively after the native flip (D3a)`, () => {
      const fx = teamFixture({});
      const result = door(fx, true, ["send", "ub", "-m", "hello", "--from", "ua", ...argv]);
      expect(result.exitCode).toBe(0);
      expect(readFileSync(join(fx.root, "cutover.trace"), "utf8")).toBe("native send\n");
      expect(placed(fx.bus)).toHaveLength(1);
    }, 20_000);
  }
  test("reply --delivery now runs natively after the native flip (D4b)", () => {
    const id = "ub-20260905T010000Z-aabbccddeeff";
    const fx = teamFixture({ inbound: { id, from: "ub", to: "ua" } });
    const result = door(fx, true, ["reply", id, "--delivery", "now", "-m", "answer", "--by", "ua"]);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(fx.root, "cutover.trace"), "utf8")).toBe("native reply\n");
    expect(existsSync(join(fx.bus, "receipts", `${id}.done`))).toBe(true);
  }, 20_000);

  test("order-shaped poll notes refuse through both doors without placement", () => {
    for (const native of [false, true]) {
      const fx = teamFixture({ seats: { pollbot: { status: "active", delivery: "poll", instance: "pollbot|A" } } });
      const result = door(fx, native, ["send", "pollbot", "-m", "Work order tap-abc: start now", "--from", "ua"]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr.toString()).toContain("reads like a work order");
      expect(payloads(fx.bus)).toHaveLength(0);
      expect(placed(fx.bus)).toHaveLength(0);
    }
  }, 20_000);

  test("plain poll-recipient notes are judged by the native guard and stay native", () => {
    const fx = teamFixture({ seats: { pollbot: { status: "active", delivery: "poll", instance: "pollbot|A" } } });
    const result = door(fx, true, ["send", "pollbot", "-m", "hello", "--from", "ua"]);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(fx.root, "cutover.trace"), "utf8")).toBe("native send\n");
    expect(payloads(fx.bus)).toHaveLength(1);
  }, 20_000);

  test("a poll delivery writes .sent but stamps no clock", () => {
    for (const native of [false, true]) {
      const fx = teamFixture({ seats: { pollbot: { status: "active", delivery: "poll", instance: "pollbot|A" } } });
      fx.env.TAP_AUTOSETTLE_HOLD_SECONDS = "99999";
      const result = door(fx, native, ["send", "pollbot", "-m", "queued", "--from", "ua"]);
      expect(result.exitCode).toBe(0);
      expect(readdirSync(join(fx.bus, "receipts")).filter(name => name.endsWith(".sent"))).toHaveLength(1);
      expect(existsSync(join(fx.bus, "delivery", "pollbot.json"))).toBe(false);
    }
  }, 20_000);

  test("missing, invalid and non-regular spool evidence cannot settle an inbound", () => {
    const fx = teamFixture({});
    const ctx = { bus: new Bus(fx.bus), team: "flip", registryPath: join(fx.wt, ".tap", "team-registry.json"), root: fx.wt, busRule: "env" as const };
    const id = "ua-20260905T000000Z-aabbccddeeff";
    expect(() => resolveOutboundEvidence(ctx, id, "inbound")).toThrow("not found after durable courier transition");
    const spool = join(fx.bus, "spool");
    mkdirSync(spool);
    writeFileSync(join(spool, `${id}.md`), stampEnvelope("---\n---\nanswer\n", {
      id, from: "ua", to: "ub", kind: "discuss", path: ctx.bus.payloadPath(id), reply: "settle-only", in_reply_to: "inbound",
    }));
    for (const bad of [{ id, team: "wrong" }, { id: "wrong", team: "flip" }]) {
      writeFileSync(join(spool, `${id}.meta.json`), JSON.stringify({ ...bad, target: "ub", first_spooled_epoch: 1 }));
      expect(() => resolveOutboundEvidence(ctx, id, "inbound")).toThrow("invalid courier metadata");
    }
    unlinkSync(join(spool, `${id}.md`));
    mkdirSync(join(spool, `${id}.md`));
    expect(() => resolveOutboundEvidence(ctx, id, "inbound")).toThrow("not a regular courier-owned bus entry");
    expect(existsSync(ctx.bus.donePath("inbound"))).toBe(false);
  });
});

// Checkpoint B (U3): the placement-adjacent rows native now owns — the Step A
// dead-pane mark, the copy-mode cancel ladder, ready delivery with older parked
// mail, and the cutover barrier's in-lock marker resample. Original byte oracle:
// probe d25667a35939 / e07358f120b3 (both doors measured).
describe("checkpoint B: placement-adjacent rows (U3)", () => {
  // tap-7r3fn.166: same 6000ms cap as door() above; the U3 bodies each spawn
  // one child and measured 0.3-0.9s whole-body healthy, so 6000ms clears the
  // worst by >6x.
  function run(fx: ReturnType<typeof teamFixture>, argv: string[], extra: Record<string, string> = {}) {
    const trace = join(fx.root, "trace");
    const result = Bun.spawnSync(
      [process.execPath, REENABLED, ...argv],
      {
        cwd: fx.wt,
        env: {
          ...fx.env, TAP_BUN_ROUTE_TRACE: trace, TAP_AUTOSETTLE_HOLD_SECONDS: "3600", TAP_TUI_SETTLE_SCALE: "0.1",
          ...extra,
        },
        stdout: "pipe", stderr: "pipe", timeout: 6000, killSignal: "SIGKILL",
      },
    );
    return {
      code: result.exitCode,
      trace: existsSync(trace) ? readFileSync(trace, "utf8") : "",
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      keys: existsSync(fx.env.FAKE_KEYS as string) ? readFileSync(fx.env.FAKE_KEYS as string, "utf8") : "",
    };
  }

  const ubRow = (fx: ReturnType<typeof teamFixture>) => {
    const doc = JSON.parse(readFileSync(join(fx.wt, ".tap", "team-registry.json"), "utf8"));
    return (doc.seats ?? {}).ub ?? null;
  };

  test("a dead recipient pane is marked suspended and refused rc 3 before placement", () => {
    const fx = teamFixture({ recipientGone: true });
    writeFileSync(fx.env.FAKE_UB_GONE as string, "");
    const id = "ua-20260920T130100Z-aabbccddeeff";
    const v = run(fx, ["send", "ub", "-m", "hello", "--from", "ua", "--id", id], { TAP_DRIVER_FORCE_TMUX: "1" });
    expect(v.code).toBe(3);
    expect(v.stderr).toBe("tap send: pane 'ub:0.0' gone; marked 'ub' suspended; next: re-open pane for 'ub' and run 'tap in'\n");
    const row = ubRow(fx) as Record<string, unknown>;
    expect(row.status).toBe("suspended");
    expect(row.status_reason).toBe("pane_gone");
    expect(String(row.exited_at ?? "")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(existsSync(join(fx.bus, "payloads", `${id}.md`))).toBe(false);
    expect(v.keys).toBe("");
  }, 60_000);

  // Former temporal-writer-revalidation arm (c2): the acting registry and the
  // bus mirror deliberately differ (the mirror carries a `poison` decoy seat).
  // The pane_gone suspension lands on the acting registry only.
  test("a dead-pane suspension writes the acting registry and leaves the bus mirror byte-identical", () => {
    const fx = teamFixture({ recipientGone: true });
    writeFileSync(fx.env.FAKE_UB_GONE as string, "");
    const mirror = join(fx.bus, "registry.json");
    writeFileSync(mirror, `${JSON.stringify({
      schema: "0.20",
      team: { name: "flip", worktree_root: fx.wt },
      seats: {
        ub: { status: "active", pane: "ub:0.0", pane_id: "%7", server_epoch: "srv:123:456", instance: "ub|A", harness: "claude" },
        poison: { status: "active", pane: "poison:0.0", instance: "poison|A", harness: "claude" },
      },
    }, null, 2)}\n`);
    const mirrorBefore = readFileSync(mirror);
    const id = "ua-20260920T130150Z-aabbccddeeff";
    const v = run(fx, ["send", "ub", "-m", "hello", "--from", "ua", "--id", id], { TAP_DRIVER_FORCE_TMUX: "1" });
    expect(v.code).toBe(3);
    const row = ubRow(fx) as Record<string, unknown>;
    expect(row.status).toBe("suspended");
    expect(row.status_reason).toBe("pane_gone");
    expect(readFileSync(mirror).equals(mirrorBefore)).toBe(true);
    expect(existsSync(join(fx.bus, "payloads", `${id}.md`))).toBe(false);
  }, 60_000);

  // Former temporal-writer-revalidation arm (e): a hybrid (seats + agents),
  // agents-only or axis-less acting registry is never rewritten, converted or
  // given an axis by a dead-pane send.
  for (const shape of ["hybrid", "agents", "axisless"] as const) {
    test(`a dead-pane send never rewrites a ${shape} acting registry`, () => {
      const fx = teamFixture({ recipientGone: true });
      writeFileSync(fx.env.FAKE_UB_GONE as string, "");
      const registryPath = join(fx.wt, ".tap", "team-registry.json");
      const current = JSON.parse(readFileSync(registryPath, "utf8")) as { team: unknown; seats: Record<string, unknown> };
      const doc: Record<string, unknown> = { schema: "0.20", team: current.team };
      if (shape === "hybrid") doc.seats = current.seats;
      if (shape !== "axisless") doc.agents = { ...current.seats, old: current.seats.ub };
      writeFileSync(registryPath, `${JSON.stringify(doc, null, 2)}\n`);
      const before = readFileSync(registryPath);
      const id = "ua-20260920T130155Z-aabbccddeeff";
      const v = run(fx, ["send", "ub", "-m", "hello", "--from", "ua", "--id", id], { TAP_DRIVER_FORCE_TMUX: "1" });
      expect(v.code).toBe(1);
      // Selection refuses every noncurrent store as old_store before the
      // sender check or markSuspendedLocked is reached.
      expect(v.stderr).toContain("is an old TAP registry format");
      expect(v.stderr).toContain(shape === "axisless" ? "(seats not an object)" : '("agents" map)');
      expect(readFileSync(registryPath).equals(before)).toBe(true);
      expect(existsSync(join(fx.bus, "payloads", `${id}.md`))).toBe(false);
      expect(v.keys).toBe("");
    }, 60_000);
  }

  test("a copy-mode recipient is cancelled and delivered", () => {
    const fx = teamFixture({});
    writeFileSync(fx.env.FAKE_IN_MODE as string, "");
    const id = "ua-20260920T130300Z-aabbccddeeff";
    const v = run(fx, ["send", "ub", "-m", "hello", "--from", "ua", "--id", id], {});
    expect(v.code).toBe(0);
    expect(existsSync(fx.env.FAKE_IN_MODE as string)).toBe(false);
    expect(payloads(fx.bus)).toContain(`${id}.md`);
  }, 60_000);

  test("an in-mode --no-spool send refuses without cancelling", () => {
    const fx = teamFixture({});
    writeFileSync(fx.env.FAKE_IN_MODE as string, "");
    const id = "ua-20260920T130500Z-aabbccddeeff";
    const v = run(fx, ["send", "ub", "-m", "hello", "--from", "ua", "--id", id, "--no-spool"], {});
    expect(v.code).toBe(1);
    expect(v.stderr).toBe("tap send: --no-spool refused (copy-mode); no message queued; pane is in copy mode or unreadable; next: re-send when the recipient is ready\n");
    expect(existsSync(join(fx.bus, "spool", `${id}.md`))).toBe(false);
    expect(existsSync(fx.env.FAKE_IN_MODE as string)).toBe(true);
    expect(v.keys).toBe("");
  }, 60_000);

  test("parked and incomplete siblings do not delay a new bare-band send", () => {
    const fx = teamFixture({});
    const spoolDir = join(fx.bus, "spool");
    mkdirSync(spoolDir, { recursive: true });
    const registryPath = join(fx.wt, ".tap", "team-registry.json");
    writeFileSync(join(spoolDir, "ua-20260919T000001Z-aabbccddeeff.meta.json"), JSON.stringify({ id: "ua-20260919T000001Z-aabbccddeeff", target: "ub", target_registry: registryPath, first_spooled_epoch: "2026-09-19T00:00:01Z" }));
    writeFileSync(join(spoolDir, "ua-20260919T000001Z-aabbccddeeff.md"), "older parked body\n");
    writeFileSync(join(spoolDir, "ua-20260919T000002Z-aabbccddeeff.meta.json"), JSON.stringify({ id: "ua-20260919T000002Z-aabbccddeeff", target: "ub", target_registry: registryPath, first_spooled_epoch: "2026-09-19T00:00:02Z" }));
    const id = "ua-20260920T130700Z-aabbccddeeff";
    const v = run(fx, ["send", "ub", "-m", "hello", "--from", "ua", "--id", id], {});
    expect(v.code).toBe(0);
    expect(v.stdout).toContain(`tap send: ok ${id}`);
    expect(v.keys).not.toBe("");
    expect(existsSync(join(fx.bus, "receipts", `${id}.sent`))).toBe(true);
    expect(existsSync(join(spoolDir, `${id}.md`))).toBe(false);
    expect(existsSync(join(spoolDir, `${id}.meta.json`))).toBe(false);
    expect(readFileSync(join(spoolDir, "ua-20260919T000001Z-aabbccddeeff.md"), "utf8")).toBe("older parked body\n");
  }, 60_000);

  // tap-6dz3y: a manual cross-worktree relay never enters the recipient
  // lock's generic wrap (tap-send.sh:1224-1234) — it places directly with no
  // wrapper at all, so it keeps spooled_id, unlike an
  // ordinary bound recipient (the internal construction differential's
  // "--id with a spool entry refuses spooled_id" row, which DOES wrap).
  test("a relay's duplicate spooled id keeps spooled_id under a live route-time marker", () => {
    const fx = teamFixture({});
    const spoolDir = join(fx.bus, "spool");
    mkdirSync(spoolDir, { recursive: true });
    const id = "ua-20260920T150000Z-aabbccddeeff";
    writeFileSync(join(spoolDir, `${id}.meta.json`), "{}\n");
    const v = run(fx, ["send", "peer", "-m", "hello", "--from", "ua", "--id", id, "--cross-worktree", "--pane", "ua:0.0"],
      { TAP_DRIVER_FORCE_TMUX: "1" });
    expect(v.code).toBe(1);
    expect(v.stderr).toBe(
      `tap send: id '${id}' already has a spool entry: ${join(realpathSync(spoolDir), `${id}.md`)}; next: wait for redelivery or remove spool entry\n`,
    );
  }, 120_000);

});
