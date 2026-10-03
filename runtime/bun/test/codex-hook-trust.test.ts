import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectAgentState } from "../src/agent-state";
import { classifyPane } from "../src/pane-state";
import { frameIo, pendingInputText } from "../src/pane/reader";
import { startupBlocker, awaitReplacedHarness, type PaneFacts } from "../src/launcher/readiness";

// Codex 0.156.1, 118x32, 2026-09-25; unchanged pane capture.
const frame = readFileSync(join(import.meta.dir, "fixtures/agent-state/codex/hook-trust.txt"), "utf8");
const facts: PaneFacts = { pane: "fixture:0.0", pane_id: "%1", command: "codex", server_epoch: "srv:1:1", dead: false, pane_pid: 123, path: "/fixture" };

test("hook trust is named and blocked even under a stale working title", () => {
  for (const screen of [frame, frame.replace("1 hook is", "3 hooks are"), frame.replace("› 1.", "  1.").replace("  2.", "› 2.")]) {
    expect(detectAgentState("codex", screen, "⠹ tap")).toEqual({ agentState: "blocked", reason: "codex-hook-trust" });
    expect(classifyPane(screen, "codex", false)).toMatchObject({ kind: "no-band", reason: expect.stringContaining("codex-hook-trust") });
    expect(pendingInputText(frameIo(screen, "118"), "%1", "codex")).toEqual({ status: "blocked" });
  }
});

test("historical hook dialog above a current composer is not a live modal", () => {
  const current = frame + "\n› \x1b[2mAsk Codex to do anything\x1b[0m\n";
  expect(detectAgentState("codex", current).agentState).toBe("idle");
  expect(detectAgentState("codex", frame.replace("enter confirm · esc skip", "ordinary transcript")).reason).not.toBe("codex-hook-trust");
});

test("startup reports hook trust with its frame and manual follow-up without keys", async () => {
  const root = mkdtempSync(join(process.env.TAP_INDEX_HOME!, "hooks-"));
  writeFileSync(join(root, "frame"), frame);
  writeFileSync(join(root, "tmux"), '#!/bin/sh\ncat "$HOOK_FRAME"\n', { mode: 0o755 });
  const reason = await startupBlocker(facts, "codex", { ...process.env, PATH: `${root}:${process.env.PATH}`, HOOK_FRAME: join(root, "frame") });
  expect(reason).toContain("codex-hook-trust");
  expect(reason).toContain("Hooks need review");
  expect(reason).toContain("hook review");
});


import { fixture, releaseScratch, run } from "./support/send-delivery-fixture";
afterAll(releaseScratch, 40_000);
for (const permissions of ["bypass", "auto"]) for (const flags of [[], ["--urgent"], ["--no-spool"]]) {
  test(`public send names hook trust and never types: ${permissions} ${flags.join(" ")}`, () => {
    const f = fixture({ harness: "codex" });
    writeFileSync(join(f.root, "modal"), frame);
    const registry = JSON.parse(readFileSync(f.registry, "utf8"));
    registry.seats.rb.permissions = permissions;
    writeFileSync(f.registry, JSON.stringify(registry));
    const result = run(f, ["send", "rb", "-m", "hello", ...flags]);
    expect(result.keys).toEqual([]);
    if (flags.includes("--no-spool")) {
      expect(result.code).toBe(1);
      expect(result.spool).toEqual([]);
      expect(result.receipt.detail).toContain("codex-hook-trust");
      expect(result.receipt.detail).toContain("hook review");
    } else if (permissions === "auto" && flags.includes("--urgent")) {
      // Auto mode parks before observing any frame; its permission-policy
      // refusal remains authoritative and sends no keys.
      expect(result.code).toBe(0);
      expect(result.receipt.reason).toBe("auto_mode_no_interrupt");
    } else {
      expect(result.code).toBe(0);
      expect(result.receipt.reason).toBe("codex-hook-trust");
      expect(result.receipt.queue_explanation).toContain("hook review");
      expect(result.receipt.queue_explanation).not.toContain("occupied composer");
    }
  }, 30_000);
}


test("relaunch readiness retains the original hook-dialog evidence", async () => {
  const root = mkdtempSync(join(process.env.TAP_INDEX_HOME!, "relaunch-hooks-"));
  writeFileSync(join(root, "frame"), frame);
  writeFileSync(join(root, "tmux"), '#!/bin/sh\ncase "$*" in *capture-pane*) cat "$HOOK_FRAME";; *) printf "fixture:0.0\\t%%1\\tcodex\\t1:1\\t0\\t2002\\t/fixture\\n";; esac\n', { mode: 0o755 });
  const result = await awaitReplacedHarness({ pane_id: "%1", harness: "codex", timeout: 1, expected_server_epoch: "srv:1:1", previous_pane_pid: 1001, detect_resume_picker: true },
    { ...process.env, PATH: `${root}:${process.env.PATH}`, TAP_SERVER_EPOCH: undefined, HOOK_FRAME: join(root, "frame") });
  expect(result).toMatchObject({ ready: false, reason: expect.stringContaining("codex-hook-trust") });
});
