// `tap self` after the native submit flip: its exit contract over every courier
// result, and the full-axis owner witness a background job carries.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SubmitResult } from "../src/courier";
import { ownerHolds, selfExit } from "../src/verbs/self";

test("every courier result has one self exit", () => {
  const cases: [SubmitResult, number, string?][] = [
    [{ status: "injected" }, 0], [{ status: "harness_queued" }, 0],
    [{ status: "pane_gone", detail: "" }, 3],
    [{ status: "lock_busy", detail: "" }, 4, "lock-park"],
    [{ status: "band_busy", detail: "" }, 4, "no-prompt"], [{ status: "recovery_held", detail: "" }, 4, "no-prompt"],
    [{ status: "copy_mode", cause: "copy-mode", detail: "" }, 4, "no-prompt"], [{ status: "rate_limited", detail: "" }, 4, "no-prompt"],
    [{ status: "unverified", detail: "" }, 5], [{ status: "attempt_evidence_unwritable", detail: "" }, 5],
    // The owner-mismatch class: nothing was submitted to a pane that is not ours.
    [{ status: "identity_mismatch", detail: "" }, 1], [{ status: "team_reset_fenced", detail: "", action: "" }, 1],
    [{ status: "clearing", detail: "" }, 1],
  ];
  for (const [result, code, reason] of cases) {
    const exit = selfExit(result);
    expect(exit.code).toBe(code);
    expect(exit.reason).toBe(reason as typeof exit.reason);
  }
});

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function registry(row: Record<string, unknown>): string {
  const dir = mkdtempSync(join(process.env.TAP_HOME ?? tmpdir(), "self-owner-"));
  dirs.push(dir);
  const path = join(dir, "registry.json");
  writeFileSync(path, JSON.stringify({ schema: "0.20", team: { name: "t" }, seats: { me: row } }));
  return path;
}
const witness = { TAP_CALLER_SELECTED_HANDLE: "me", TAP_CALLER_SELECTED_INSTANCE: "i1", TAP_CALLER_SELECTED_PANE: "s:0.0",
  TAP_CALLER_SELECTED_PANE_ID: "%1", TAP_CALLER_SELECTED_SESSION: "s", TAP_CALLER_SELECTED_EPOCH: "srv:1:1", TAP_CALLER_SELECTED_SOCKET: "/sock" };
const row = { status: "active", instance: "i1", pane: "s:0.0", pane_id: "%1", session: "s", server_epoch: "srv:1:1", server_socket: "/sock" };

test("the owner witness holds only while every recorded axis still matches", () => {
  expect(ownerHolds("/nonexistent", {})).toBe(true); // no background owner
  expect(ownerHolds(registry(row), witness)).toBe(true);
  expect(ownerHolds(registry({ ...row, instance: "i2" }), witness)).toBe(false);
  expect(ownerHolds(registry({ ...row, status: "suspended" }), witness)).toBe(false);
  // Session and socket stay in the full-axis check (fable N6): the per-effect row check drops them.
  expect(ownerHolds(registry({ ...row, session: "other" }), witness)).toBe(false);
  expect(ownerHolds(registry({ ...row, server_socket: "/other" }), witness)).toBe(false);
  expect(ownerHolds(registry({ ...row, pane_id: "%2" }), witness)).toBe(false);
  // A witness bound to no pane checks the instance only.
  expect(ownerHolds(registry({ ...row, session: "other" }), { ...witness, TAP_CALLER_SELECTED_PANE: "" })).toBe(true);
  expect(ownerHolds("/nonexistent/registry.json", witness)).toBe(false);
});
