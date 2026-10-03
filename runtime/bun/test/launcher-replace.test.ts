/**
 * The dark clear core (R7a): fence writer, stamp → consume, the rebind
 * predicate, and the refusals that must leave the fence released and the row
 * untouched. The tmux-facing path (dry-run parity with launcher.py, a real
 * respawn) is the clear-native-core smoke.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fencePath, readClearFence } from "../src/clear-fence";
import {
  acquireClearFence, clearRebindTimeout, clearRebindVerified, consumeExpectedClearNonce, replaceHarnessInPane,
  stampExpectedClearNonce, type ClearPlan, type ClearScope, type ClearTargetIdentity,
} from "../src/launcher/replace";
import type { LaunchRecord } from "../src/launcher/transaction";

function scope(seats: Record<string, unknown> = {}): ClearScope {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "replace-core-")));
  const busHome = join(root, ".tap", "bus");
  mkdirSync(busHome, { recursive: true });
  const registryPath = join(root, ".tap", "team-registry.json");
  writeFileSync(registryPath, `${JSON.stringify({ schema: "0.20", team: { name: "demo" }, seats })}\n`);
  return { root, registryPath, busHome };
}
const seats = (s: ClearScope) => JSON.parse(readFileSync(s.registryPath, "utf8")).seats as Record<string, Record<string, unknown>>;
const target = (paneId = "%7", epoch: string | null = "srv:1:1"): ClearTargetIdentity =>
  ({ paneId, epoch, generation: { boot: null, epoch: null, socket: "" } });
const record = { name: "demo-sol", harness: "claude", cwd: "/tmp", base: "demo", harness_env: { A: "1" },
  harness_unset_env: ["B"], harness_tail: ["--x"], permissions: "bypass" } as unknown as LaunchRecord;
const live = { status: "active", pane_id: "%7", server_epoch: "srv:1:1", harness: "claude", session: "demo-sol" };

describe("clear fence writer", () => {
  test("record round-trips through the lockless reader with clear_fence.py's field order and float spelling", () => {
    const s = scope();
    const held = acquireClearFence(s.busHome, "demo/sol", "n-1", "claude", 45, new Date(Date.UTC(2026, 8, 23, 12, 0, 0)));
    expect(held).not.toBeNull();
    const raw = readFileSync(fencePath(s.busHome, "sol"), "utf8");
    expect(raw).toBe(`{"nonce":"n-1","since":"2026-09-23T12:00:00Z","since_epoch":1790164800.0,"pid":${process.pid},"handle":"sol","harness":"claude","ceiling_seconds":45.0}`);
    const read = readClearFence(s.busHome, "sol", Date.UTC(2026, 8, 23, 12, 0, 10) / 1000);
    expect(read.state).toBe("live");
    expect(read.rec?.nonce).toBe("n-1");
    held!.release();
  });

  test("a second clearer loses without waiting; release truncates in place and never unlinks", () => {
    const s = scope();
    const first = acquireClearFence(s.busHome, "sol", "n-1", "claude", 45)!;
    expect(acquireClearFence(s.busHome, "sol", "n-2", "claude", 45)).toBeNull();
    first.release();
    const path = fencePath(s.busHome, "sol");
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBe(0);
    expect(readClearFence(s.busHome, "sol").state).toBe("absent");
    const again = acquireClearFence(s.busHome, "sol", "n-3", "claude", 45);
    expect(again).not.toBeNull();
    again!.release();
  });

  test("per-family ceilings keep the historical default for unmeasured families", () => {
    expect(clearRebindTimeout("claude")).toBe(45);
    expect(clearRebindTimeout(" Opencode ")).toBe(90);
    expect(clearRebindTimeout("hermes")).toBe(45);
    expect(clearRebindTimeout(null)).toBe(45);
  });
});

describe("stamp → consume", () => {
  test("stamp writes the expectation and recipe, and drops a previous clear's witness", async () => {
    const s = scope({ sol: { ...live, clear_nonce: "old" } });
    expect(await stampExpectedClearNonce(s, "sol", "n-1", target(), record, "tap clear")).toBeNull();
    const row = seats(s).sol!;
    expect(row.expected_clear_nonce).toBe("n-1");
    expect(row.clear_nonce).toBeUndefined();
    expect(row.harness_env).toEqual({ A: "1" });
    expect(row.harness_unset_env).toEqual(["B"]);
    expect(row.harness_tail).toEqual(["--x"]);
    expect(row.permissions).toBe("bypass");
  });

  test("a row that moved to another pane, or another server generation, refuses with nothing written", async () => {
    for (const moved of [{ ...live, pane_id: "%8" }, { ...live, server_epoch: "srv:2:2" }]) {
      const s = scope({ sol: moved });
      const before = readFileSync(s.registryPath, "utf8");
      const out = await stampExpectedClearNonce(s, "sol", "n-1", target(), record, "tap clear");
      expect(out?.code).toBe(2);
      expect(out?.errorClass).toBe("clear_target_moved");
      expect(readFileSync(s.registryPath, "utf8")).toBe(before);
    }
  });

  test("a published reset fence refuses the stamp under custody", async () => {
    const s = scope({ sol: live });
    writeFileSync(join(s.busHome, "reset.fence.json"), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    const out = await stampExpectedClearNonce(s, "sol", "n-1", target(), record, "tap clear");
    expect(out?.code).toBe(2);
    expect(out?.errorClass).toBe("team_reset_fenced");
    expect(seats(s).sol!.expected_clear_nonce).toBeUndefined();
  });

  test("consume pops only our own nonce, so a later clear's stamp survives", async () => {
    const s = scope({ sol: { ...live, expected_clear_nonce: "theirs" } });
    expect(await consumeExpectedClearNonce(s, "sol", "ours", "tap clear")).toBe(true);
    expect(seats(s).sol!.expected_clear_nonce).toBe("theirs");
    expect(await consumeExpectedClearNonce(s, "sol", "theirs", "tap clear")).toBe(true);
    expect(seats(s).sol!.expected_clear_nonce).toBeUndefined();
  });
});

describe("rebind predicate", () => {
  const row = { ...live, expected_clear_nonce: "n", clear_nonce: "n" };
  test.each([
    ["verified", row, true],
    ["witness absent", { ...row, clear_nonce: undefined }, false],
    ["another clear owns the expectation", { ...row, expected_clear_nonce: "m" }, false],
    ["witness from another clear", { ...row, clear_nonce: "m" }, false],
    ["not active", { ...row, status: "pending" }, false],
    ["other pane", { ...row, pane_id: "%8" }, false],
    ["other server generation", { ...row, server_epoch: "srv:9:9" }, false],
  ])("%s", (_name, candidate, expected) => {
    expect(clearRebindVerified(candidate as Record<string, unknown>, "%7", "srv:1:1", "n")).toBe(expected);
  });
  test("an empty nonce never verifies", () => {
    expect(clearRebindVerified({ ...row, expected_clear_nonce: "", clear_nonce: "" }, "%7", "srv:1:1", "")).toBe(false);
  });
});

describe("refusals release the fence (odt1d 12th finding)", () => {
  const plan = (nonce: string): ClearPlan => ({ target: { ...target(), entry: live, warnings: [] }, record, nonce,
    invocation: { argv: ["claude"], env: { TAP_CLEAR_ID: nonce } }, command: "claude", ceiling: 45 });

  test("a stamp that fails after the fence is published releases it, with no tmux effect", async () => {
    const s = scope({});
    let sent = 0;
    const out = await replaceHarnessInPane(s, plan("n-1"), { verb: "tap clear", handle: "sol", instruction: null, clearHistory: true,
      sendInstruction: () => { sent++; return 0; } });
    expect(out.code).toBe(2);
    expect(out.errorClass).toBe("not_found");
    expect(statSync(fencePath(s.busHome, "sol")).size).toBe(0);
    const again = acquireClearFence(s.busHome, "sol", "n-2", "claude", 45);
    expect(again).not.toBeNull();
    again!.release();
    expect(sent).toBe(0);
  });

  test("the loser of a concurrent clear refuses clear_in_progress and changes nothing", async () => {
    const s = scope({ sol: live });
    const held = acquireClearFence(s.busHome, "sol", "winner", "claude", 45)!;
    const before = readFileSync(s.registryPath, "utf8");
    const out = await replaceHarnessInPane(s, plan("loser"), { verb: "tap clear", handle: "sol", instruction: null, clearHistory: true });
    expect(out.code).toBe(2);
    expect(out.errorClass).toBe("clear_in_progress");
    expect(out.detail).toContain(`pid ${process.pid}`);
    expect(readFileSync(s.registryPath, "utf8")).toBe(before);
    expect(readClearFence(s.busHome, "sol").rec?.nonce).toBe("winner");
    held.release();
  });
});
