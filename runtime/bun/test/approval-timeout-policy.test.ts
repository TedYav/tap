import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readPolicy, policyPath } from "../src/approval-timeout-policy";
import { readEpisodes } from "../src/approval-timeout";
import { approvalTimeoutOn, cmdApprovalTimeout } from "../src/verbs/approval-timeout";
import { TapError } from "../src/context";

let bus: string;
beforeEach(() => { bus = mkdtempSync(join(tmpdir(), "approval-policy-")); });
afterEach(() => { rmSync(bus, { recursive: true, force: true }); });

const arm = (record: object) => {
  mkdirSync(join(bus, "watch"), { recursive: true });
  writeFileSync(join(bus, "watch", "arm.json"), JSON.stringify(record));
};
const status = () => JSON.parse(approvalTimeoutOn(bus, "demo", "status", true, "x", 10).stdout);

describe("tap approval-timeout (tap-rlebf.2 U3)", () => {
  test("on then status shows enabled, setter and time; off turns it off", () => {
    arm({ mode: "supervision", tick_interval_seconds: 60 });
    const on = approvalTimeoutOn(bus, "demo", "on", false, "lead", 1_000_000);
    expect(on).toEqual({ rc: 0, stdout: "tap approval-timeout: on for team demo\n", stderr: "" });
    expect(status()).toMatchObject({ enabled: true, by: "lead", at: new Date(1_000_000_000).toISOString(), active: true, inactive_reason: null, open_requests: 0 });
    const off = approvalTimeoutOn(bus, "demo", "off", false, "lead", 1_000_100);
    expect(off.stdout).toBe("tap approval-timeout: off for team demo; 0 open request(s) cancelled\n");
    expect(status()).toMatchObject({ enabled: false, inactive_reason: "policy_off" });
  });

  test("on twice is idempotent: one record, the first setter kept", () => {
    approvalTimeoutOn(bus, "demo", "on", false, "lead", 100);
    const before = readFileSync(policyPath(bus), "utf8");
    expect(approvalTimeoutOn(bus, "demo", "on", false, "other", 200).rc).toBe(0);
    expect(readFileSync(policyPath(bus), "utf8")).toBe(before);
  });

  test("a corrupt policy reads as off and status names the problem", () => {
    mkdirSync(join(bus, "approval-timeout"), { recursive: true });
    writeFileSync(policyPath(bus), "{not json");
    expect(readPolicy(bus).policy.enabled).toBe(false);
    const r = approvalTimeoutOn(bus, "demo", "status", false, "x", 1);
    expect(r.stdout).toStartWith("approval-timeout: off\n");
    expect(r.stderr).toMatch(/^tap approval-timeout: policy\.json is not JSON: .*; reading it as off\n$/);
    // `on` repairs it.
    approvalTimeoutOn(bus, "demo", "on", false, "lead", 2);
    expect(readPolicy(bus)).toEqual({ policy: { enabled: true, by: "lead", at: 2 }, problem: null });
  });

  test("off cancels two open requests", () => {
    approvalTimeoutOn(bus, "demo", "on", false, "lead", 1);
    const episode = (handle: string, paneId: string) => ({ handle, instance: "i", paneId, harness: "codex", rule: "r", fingerprint: handle, excerpt: "x", first_seen: 1, deadline: 601, state: "open" });
    writeFileSync(join(bus, "approval-timeout", "episodes.json"), JSON.stringify({ v: 1, episodes: { a: episode("a", "%1"), b: episode("b", "%2") } }));
    const r = approvalTimeoutOn(bus, "demo", "off", true, "lead", 5);
    expect(JSON.parse(r.stdout)).toMatchObject({ enabled: false, cancelled: 2 });
    expect(Object.values(readEpisodes(bus)).every(e => e.state === "tombstone" && e.outcome === "cancelled_policy_off")).toBe(true);
    const lines = readFileSync(join(bus, "approval-timeout", "events.jsonl"), "utf8").trim().split("\n");
    expect(lines.map(l => JSON.parse(l).outcome)).toEqual(["cancelled_policy_off", "cancelled_policy_off"]);
  });

  test("on while unarmed or reminders-only warns that no timeout runs (R15)", () => {
    const unarmed = approvalTimeoutOn(bus, "demo", "on", false, "lead", 1);
    expect(unarmed.rc).toBe(0);
    expect(unarmed.stderr).toContain("the team's watch is not armed");
    expect(status()).toMatchObject({ enabled: true, active: false, inactive_reason: "watch_unarmed" });
    arm({ mode: "reminders-only", tick_interval_seconds: 60 });
    expect(status()).toMatchObject({ active: false, inactive_reason: "watch_reminders_only" });
  });

  test("a slow tick interval warns about Hermes's native denial", () => {
    arm({ mode: "supervision", tick_interval_seconds: 120 });
    approvalTimeoutOn(bus, "demo", "on", false, "lead", 1);
    expect(status().warnings.join("\n")).toContain("Hermes's own 300s denial");
  });

  test("status lists one built-in timeout per harness and no row is live without captured evidence", () => {
    expect(status().harnesses).toEqual([
      { harness: "claude", timeout_seconds: 600, row: "pending_capture" },
      { harness: "codex", timeout_seconds: 600, row: "pending_capture" },
      { harness: "cursor", timeout_seconds: 600, row: "pending_capture" },
      { harness: "opencode", timeout_seconds: 600, row: "pending_capture" },
      { harness: "agy", timeout_seconds: 600, row: "pending_capture" },
      { harness: "hermes", timeout_seconds: 120, row: "pending_capture" },
    ]);
  });

  test("a duration flag, an unknown subcommand, or none is a usage error before any bus read", () => {
    for (const argv of [["on", "--timeout", "30"], ["sometimes"], [], ["on", "off"]]) {
      let thrown: unknown;
      try { cmdApprovalTimeout(argv, {}); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(TapError);
      expect((thrown as TapError).action).toBe("tap help approval-timeout");
    }
  });


});
