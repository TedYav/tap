import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { approvalPrompt, approvalRequest, detectAgentState } from "../src/agent-state";

const fixtures = join(import.meta.dir, "fixtures", "agent-state");
const read = (harness: string, name: string): string => readFileSync(join(fixtures, harness, name), "utf8");

describe("approvalRequest (tap-rlebf.2)", () => {
  const real: [string, string, string, string, boolean][] = [
    ["claude", "blocked-real.txt", "permission_prompt", "rm -f /tmp/test-file", true],
    ["claude", "blocked-queued-real.txt", "permission_prompt", "ls -la /Users/runner/.tap-l7-acceptance/probe", true],
    ["codex", "blocked-real.txt", "live_strong_blocker", "date > ~/.tap-onreq-probe.txt", true],
    ["cursor", "blocked-real.txt", "approval_prompt", "echo tap-probe", true],
    ["cursor", "blocked-auto-review-real.txt", "approval_prompt", "head -n 1 /etc/hosts", true],
    ["opencode", "blocked-real.txt", "permission_required", "/etc", false],
    ["opencode", "blocked-auto-real.txt", "permission_required", "/etc", false],
    ["agy", "blocked-real.txt", "permission_prompt", "echo tap-probe", true],
  ];
  for (const [harness, name, rule, excerpt, denyLabel] of real) {
    test(`${harness}/${name} is a request with ${denyLabel ? "a" : "no"} frame deny label`, () => {
      const request = approvalRequest(harness, read(harness, name));
      expect(request).not.toBeNull();
      expect(request!.rule).toBe(rule);
      expect(request!.excerpt).toContain(excerpt);
      expect(request!.excerpt.length).toBeLessThanOrEqual(200);
      expect(request!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(request!.denyLabel).toBe(denyLabel);
    });
  }

  test("trust dialogs and hook review are blocked but never requests", () => {
    for (const [harness, name] of [
      ["claude", "trust-auto-real.txt"],
      ["claude", "trust-auto-narrow-real.txt"],
      ["codex", "trust-auto-real.txt"],
      ["codex", "trust-auto-narrow-real.txt"],
      ["codex", "hook-trust.txt"],
      ["agy", "trust-auto-real.txt"],
    ] as const) {
      const frame = read(harness, name);
      expect(approvalPrompt(harness, frame)).toBe(true);
      expect(approvalRequest(harness, frame)).toBeNull();
    }
  });

  test("Codex question prompts and [y/n] lines are not requests", () => {
    const frame = read("codex", "blocked-real.txt");
    const question = frame.replace(/Press enter to confirm or esc to cancel\s*$/, "enter to submit answer\n");
    const yesNo = frame.replace(/Press enter to confirm or esc to cancel\s*$/, "Continue? [y/n]\n");
    for (const candidate of [question, yesNo]) {
      expect(approvalPrompt("codex", candidate)).toBe(true);
      expect(approvalRequest("codex", candidate)).toBeNull();
    }
  });

  test("an OpenCode shell-mode frame is blocked but not a request", () => {
    const shell = readFileSync(join(import.meta.dir, "fixtures", "opencode-capture", "shell-mode-staged-160.ansi"), "utf8");
    expect(detectAgentState("opencode", shell)).toEqual({ agentState: "blocked", reason: "shell_mode" });
    expect(approvalRequest("opencode", shell)).toBeNull();
  });

  test("every idle, working, stale and near-idle fixture is not a request", () => {
    for (const harness of ["claude", "codex", "cursor", "opencode", "agy", "hermes"]) {
      for (const name of readdirSync(join(fixtures, harness))) {
        if (!/^(?:idle|working|stale|near-idle|done|spinner|draft|fresh-warning)/.test(name)) continue;
        expect([harness, name, approvalRequest(harness, read(harness, name))]).toEqual([harness, name, null]);
      }
    }
  });

  test("a moved selection highlight keeps the fingerprint", () => {
    const frame = read("claude", "blocked-real.txt");
    const moved = frame.replace(" ❯ 1. Yes", "   1. Yes").replace("   4. No", " ❯ 4. No");
    expect(moved).not.toBe(frame);
    expect(approvalRequest("claude", moved)?.fingerprint).toBe(approvalRequest("claude", frame)!.fingerprint);
  });

  test("a different command is a different request", () => {
    const frame = read("cursor", "blocked-real.txt");
    const other = frame.replace(" $  echo tap-probe in .", " $  echo other in .");
    expect(other).not.toBe(frame);
    const a = approvalRequest("cursor", frame)!;
    const b = approvalRequest("cursor", other)!;
    expect(b.excerpt).toContain("echo other");
    expect(b.fingerprint).not.toBe(a.fingerprint);
  });

  test("the rotating Claude tip is not part of the request", () => {
    const frame = read("claude", "blocked-queued-real.txt");
    const tipped = frame.replace(/Tip: auto mode handles[^\n]*/, "Tip: press ctrl+r to search history");
    expect(tipped).not.toBe(frame);
    expect(approvalRequest("claude", tipped)?.fingerprint).toBe(approvalRequest("claude", frame)!.fingerprint);
  });

  test("a missing deny label is reported, not inferred", () => {
    const claude = read("claude", "blocked-real.txt").replace("Esc to cancel · Tab to amend", "Tab to amend");
    // Claude's modal reader keys on that footer, so the frame is not a request at all.
    expect(approvalRequest("claude", claude)).toBeNull();
    const codex = read("codex", "blocked-real.txt").replace("No, and tell Codex what to do differently (esc)", "No, and tell Codex what to do differently");
    expect(approvalRequest("codex", codex)?.denyLabel).toBe(false);
    const agy = read("agy", "blocked-real.txt").replace(/\nesc to cancel[^\n]*/, "\nctrl+c quit");
    expect(approvalRequest("agy", agy)?.denyLabel).toBe(false);
  });

  test("synthetic Hermes never attests a deny label", () => {
    const request = approvalRequest("hermes", read("hermes", "blocked.txt"));
    expect(request?.rule).toBe("dangerous_command_approval");
    expect(request?.denyLabel).toBe(false);
  });

  test("approvalPrompt is unchanged for every blocked fixture", () => {
    for (const harness of ["claude", "codex", "cursor", "opencode", "agy", "hermes"]) {
      for (const name of readdirSync(join(fixtures, harness))) {
        if (!/^(?:blocked|trust|hook)/.test(name)) continue;
        expect([harness, name, approvalPrompt(harness, read(harness, name))]).toEqual([harness, name, true]);
      }
    }
  });
});
