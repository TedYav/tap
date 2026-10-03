// tap_serial_triggers "runtime/bun/test/support/send-reply-flip-fixture.ts" "runtime/bun/main.ts" "runtime/bun/test/support/native-send-entry.ts"
// tap-zk1w: a pane-backed row with no server_epoch makes no generation claim,
// so pane agreement alone neither confers identity nor authorizes delivery.
// Pane-less poll seats never carry a stamp and must keep working unchanged.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { authorize } from "../src/deliver";
import { authorizePaneEffect } from "../src/courier";
import { NATIVE_SEND, teamFixture, payloads, flushScratch } from "./support/send-reply-flip-fixture";

afterEach(() => flushScratch(), 40_000);

const UNSTAMPED_UA = { ua: { status: "active", pane: "ua:0.0", pane_id: "%6", instance: "ua|A", harness: "claude" } };
const UNSTAMPED_UB = { ub: { status: "active", pane: "ub:0.0", pane_id: "%7", instance: "ub|A", harness: "claude" } };
const POLLBOT = { pollbot: { status: "active", delivery: "poll", instance: "pollbot|A" } };

function send(fx: ReturnType<typeof teamFixture>, args: string[]) {
  const r = Bun.spawnSync([process.execPath, NATIVE_SEND, ...args],
    { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("unstamped pane-backed rows (tap-zk1w)", () => {
  test("an unstamped pane recipient is refused before any bus effect", () => {
    const fx = teamFixture({ seats: UNSTAMPED_UB });
    const r = send(fx, ["ub", "-m", "hello", "--from", "ua", "--id", "ua-20260930T230000Z-aabbccddeeff"]);
    expect(r.code, r.err).toBe(1);
    expect(r.err).toContain("'ub' has no recorded server generation");
    expect(r.err).toContain("tap register ub");
    expect(payloads(fx.bus)).toEqual([]);
  });

  test("an unstamped recipient whose pane is gone is refused, not marked suspended", () => {
    const fx = teamFixture({ seats: UNSTAMPED_UB, recipientGone: true });
    writeFileSync(fx.env.FAKE_UB_GONE as string, "");
    const r = send(fx, ["ub", "-m", "hello", "--from", "ua", "--id", "ua-20260930T230050Z-aabbccddeeff"]);
    expect(r.code, r.err).toBe(1);
    expect(r.err).toContain("'ub' has no recorded server generation");
    const row = JSON.parse(readFileSync(join(fx.wt, ".tap", "team-registry.json"), "utf8")).seats.ub;
    expect(row.status).toBe("active");
    expect(row.status_reason).toBeUndefined();
    expect(payloads(fx.bus)).toEqual([]);
  });

  test("--reply-to does not accept an unstamped pane row as a response channel", () => {
    const fx = teamFixture({ seats: { uc: { status: "active", pane: "uc:0.0", pane_id: "%8", instance: "uc|A", harness: "claude" } } });
    const r = send(fx, ["ub", "-m", "hello", "--from", "ua", "--ask", "--reply-to", "uc", "--id", "ua-20260930T230060Z-aabbccddeeff"]);
    expect(r.code, r.err).toBe(1);
    expect(r.err).toContain("--reply-to handle 'uc' is not a deliverable seat");
    expect(payloads(fx.bus)).toEqual([]);
  });

  test("an unstamped pane sender is not dischargeable", () => {
    const fx = teamFixture({ seats: UNSTAMPED_UA });
    const r = send(fx, ["ub", "-m", "hello", "--from", "ua", "--id", "ua-20260930T230100Z-aabbccddeeff"]);
    expect(r.code, r.err).toBe(1);
    expect(r.err).toContain("is not an active sender");
    expect(payloads(fx.bus)).toEqual([]);
  });

  test("a pane-less poll seat still sends and receives with no stamp", () => {
    const outbound = teamFixture({ seats: POLLBOT });
    const from = send(outbound, ["ub", "-m", "hello", "--from", "pollbot", "--team", "flip", "--id", "pollbot-20260930T230200Z-aabbccddeeff"]);
    expect(from.code, from.err).toBe(0);
    expect(existsSync(join(outbound.bus, "payloads", "pollbot-20260930T230200Z-aabbccddeeff.md"))).toBe(true);

    const inbound = teamFixture({ seats: POLLBOT });
    const to = send(inbound, ["pollbot", "-m", "hello", "--from", "ua", "--id", "ua-20260930T230300Z-aabbccddeeff"]);
    expect(to.code, to.err).toBe(0);
    expect(existsSync(join(inbound.bus, "payloads", "ua-20260930T230300Z-aabbccddeeff.md"))).toBe(true);
  });

  test("the reserved watch identity still sends settle-only notices", () => {
    const fx = teamFixture({});
    const r = send(fx, ["ub", "-m", "tick", "--from", "watcher", "--kind", "notice", "--id", "watcher-20260930T230400Z-aabbccddeeff"]);
    expect(r.code, r.err).toBe(0);
    expect(r.err).not.toContain("unregistered_sender");
  });

  test("courier authorization refuses a pane bound without a generation", () => {
    const fx = { observePane: () => ({ paneId: "%7", session: "ub", serverEpoch: "srv:1:1", currentCommand: "claude" }) } as never;
    expect(authorize("ub:0.0", { paneId: "%7", serverEpoch: "", harness: "claude" }, fx)?.cause).toBe("identity_unobservable");
    expect(authorize("ub:0.0", { paneId: "%7", serverEpoch: "srv:1:1", harness: "claude" }, fx)).toBeNull();
    // A pane-less bound (poll or unbound relay) carries no pane claim to verify.
    expect(authorize("ub:0.0", { paneId: "", serverEpoch: "", harness: "claude" }, fx)).toBeNull();
  });

  test("the locked-submission authorizer (spool redelivery) refuses a pane bound without a generation", () => {
    const fx = { observePane: () => ({ paneId: "%7", session: "ub", serverEpoch: "srv:1:1", currentCommand: "claude" }) } as never;
    const refused = authorizePaneEffect("ub:0.0", { paneId: "%7", serverEpoch: "", harness: "claude" }, fx);
    expect(refused.status).toBe("identity_mismatch");
    expect("detail" in refused ? refused.detail : "").toContain("without a server generation");
  });

  test("the point-of-effect row reread refuses a row that lost or changed its stamp", () => {
    const dir = mkdtempSync(join(tmpdir(), "zk1w-row-"));
    try {
      const registryPath = join(dir, "team-registry.json");
      const fx = { observePane: () => ({ paneId: "%7", session: "ub", serverEpoch: "srv:1:1", currentCommand: "claude" }) } as never;
      const bound = { paneId: "%7", serverEpoch: "srv:1:1", harness: "claude", handle: "ub", instance: "ub|A" };
      const row = { status: "active", delivery: "pane", pane: "ub:0.0", pane_id: "%7", instance: "ub|A", harness: "claude" };
      for (const stamp of [undefined, "srv:2:2"]) {
        writeFileSync(registryPath, JSON.stringify({ schema: "0.20", team: { name: "t" }, seats: { ub: stamp ? { ...row, server_epoch: stamp } : row } }));
        const refused = authorizePaneEffect("ub:0.0", bound, fx, { registryPath } as never);
        expect(refused.status).toBe("identity_mismatch");
        expect("detail" in refused ? refused.detail : "").toContain("not the captured srv:1:1");
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
