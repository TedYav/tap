// tap_serial_triggers "bin/" "runtime/bun/main.ts" "skills/tap/scripts/tap-send.sh" "skills/tap/scripts/lib.sh" "runtime/bun/test/support/send-delivery-fixture.ts" "runtime/bun/test/fixtures/agent-state/"
/**
 * D3a — the send-side delivery classes `--polite` (with `--polite-timeout` and
 * `--delivery polite`), `--no-spool` and `--delivery now` run natively.
 *
 * Every differential row runs through the installed `bin/tap` over one team
 * with a fake tmux whose recipient band the row controls: a bare prompt, a
 * human draft, a frame with no readable prompt, a real Claude permission
 * prompt, copy-mode, a clearing fence in each of its states and transitions,
 * a recovery hold, a held pane-submit lock.
 *
 * `--urgent` and `--delivery interrupt` are NOT here: the
 * interrupt is a pane effect that lane B's engine carries (D3b). `--wake` is a
 * parsed no-op and has no row.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquirePaneLock } from "../src/panelock";
import { createRun } from "../src/recovery/state";
import { removeScratchTree } from "./support/scratch";
import { one, releaseScratch } from "./support/send-delivery-fixture";

afterAll(releaseScratch, 40_000);

describe("--polite: park before any attempt, with the polite policy and its timeout", () => {
  const politePark = (timeout: number) => [{ reason: "polite", policy: "polite", timeout_seconds: timeout, to: "rb" }];

  test("a bare band still parks: polite never looks at the pane", () => {
    const v = one({}, ["send", "rb", "-m", "hi", "--polite"]);
    expect({ code: v.code, status: v.receipt.status, delivery: v.receipt.delivery, reason: v.receipt.reason, policy: v.receipt.policy,
      payloads: v.payloads, spool: v.spool, keys: v.keys })
      .toEqual({ code: 0, status: "queued", delivery: "spool", reason: "polite", policy: "polite", payloads: 0, spool: politePark(600), keys: [] });
  }, 120_000);

  test("--polite-timeout travels into the park", () => {
    const v = one({}, ["send", "rb", "-m", "hi", "--polite", "--polite-timeout", "42"]);
    expect(v.spool).toEqual(politePark(42));
  }, 120_000);

  test("--delivery polite is the same class", () => {
    const v = one({}, ["send", "rb", "-m", "hi", "--delivery", "polite"]);
    expect(v.spool).toEqual(politePark(600));
  }, 120_000);

  test("a human draft in the band is never read: polite parks, no keys", () => {
    const v = one({ draft: "HUMAN DRAFT" }, ["send", "rb", "-m", "hi", "--polite"]);
    expect({ spool: v.spool, keys: v.keys }).toEqual({ spool: politePark(600), keys: [] });
  }, 120_000);

  test("copy-mode is never cancelled for a polite send: it parks as polite, no keys", () => {
    const v = one({ copyMode: true }, ["send", "rb", "-m", "hi", "--polite"]);
    expect({ spool: v.spool, keys: v.keys }).toEqual({ spool: politePark(600), keys: [] });
  }, 120_000);

  test("a live clearing fence parks as `clearing` on the standard policy, polite or not (tap-send.sh:1650)", () => {
    const v = one({ clearFence: true }, ["send", "rb", "-m", "hi", "--polite"]);
    expect({ reason: v.receipt.reason, spool: v.spool, keys: v.keys })
      .toEqual({ reason: "clearing", spool: [{ reason: "clearing", policy: "standard", timeout_seconds: null, to: "rb" }], keys: [] });
  }, 120_000);

  test("a clear fence that appears after the pre-placement sample still parks `clearing`/standard: the fence is read after the render (sol's I1, race)", () => {
    const v = one({ lateFence: "live" }, ["send", "rb", "-m", "hi", "--polite"]);
    expect({ code: v.code, spool: v.spool, keys: v.keys })
      .toEqual({ code: 0, spool: [{ reason: "clearing", policy: "standard", timeout_seconds: null, to: "rb" }], keys: [] });
  }, 120_000);

  test("a fence that lifts after the pre-placement identity checks parks `polite`: the one post-render read decides alone (sol's inverse race)", () => {
    const v = one({ clearFence: true, lateFence: "lift" }, ["send", "rb", "-m", "hi", "--polite"]);
    expect({ code: v.code, spool: v.spool, keys: v.keys })
      .toEqual({ code: 0, spool: [{ reason: "polite", policy: "polite", timeout_seconds: 600, to: "rb" }], keys: [] });
    const plain = one({ clearFence: true, lateFence: "lift" }, ["send", "rb", "-m", "hi"]);
    expect({ code: plain.code, status: plain.receipt.status, keys: plain.keys.length }).toEqual({ code: 0, status: "injected", keys: 3 });
  }, 240_000);

  test("an already-expired fence at the post-render read warns and continues to the polite park (sol's second control)", () => {
    const v = one({ lateFence: "expired" }, ["send", "rb", "-m", "hi", "--polite"]);
    expect({ code: v.code, spool: v.spool, keys: v.keys,
      warned: v.stderr.includes("WARNING: clear fence for rb expired; delivering anyway (fail-open past the family await ceiling)") })
      .toEqual({ code: 0, spool: [{ reason: "polite", policy: "polite", timeout_seconds: 600, to: "rb" }], keys: [], warned: true });
  }, 120_000);

  test("a live recovery hold wins over a live clear fence: `recovery-hold` under the class's pair (sol's I1, already-live conflict; tap-send.sh:1632 before :1639)", () => {
    const polite = one({ clearFence: true, recoveryHold: true }, ["send", "rb", "-m", "hi", "--polite"]);
    expect({ code: polite.code, spool: polite.spool, keys: polite.keys })
      .toEqual({ code: 0, spool: [{ reason: "recovery-hold", policy: "polite", timeout_seconds: 600, to: "rb" }], keys: [] });
    const plain = one({ clearFence: true, recoveryHold: true }, ["send", "rb", "-m", "hi"]);
    expect({ code: plain.code, spool: plain.spool, keys: plain.keys })
      .toEqual({ code: 0, spool: [{ reason: "recovery-hold", policy: "standard", timeout_seconds: null, to: "rb" }], keys: [] });
  }, 240_000);

  test("the human receipt of a polite park is a fixed byte-for-byte receipt", () => {
    const v = one({}, ["send", "rb", "-m", "hi", "--polite"], false);
    expect(v.code).toBe(0);
    expect({ stdout: v.stdout, stderr: v.stderr }).toEqual({
      stdout: "tap send: queued <id>\nQueue: busy/polite — polite delivery window. next probe: <iso>; deadline: <iso>; disposition follows the delivery policy. Probe time is not a delivery guarantee.\n",
      stderr: "",
    });
  }, 120_000);
});
