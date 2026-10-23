import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { approvalPrompt, detectAgentState } from "../src/agent-state";
import { keysAnswerPrompt } from "../src/recovery/effect";
import { readFrame, sentinelSubmitDecision } from "../src/submit-frame";
import { heldBlocker } from "../src/verbs/nudge-ladder";
import { codexComposerIdle, opencodeComposerIdle } from "../src/launcher/readiness";
import { teamStatus } from "../src/routing";

const fixtures = join(import.meta.dir, "fixtures/agent-state");
const read = (file: string) => readFileSync(join(fixtures, file), "utf8");
const cases = [
  { harness: "claude", file: "errors/claude-api-overloaded.txt", reason: "api_error", hold: false },
  { harness: "claude", file: "errors/claude-api-disconnected.txt", reason: "api_error", hold: false },
  { harness: "claude", file: "errors/claude-quota-footer.txt", reason: "usage_limit", hold: false },
  { harness: "claude", file: "../usage-limit-modal/pane-plain.txt", reason: "usage_limit_modal", hold: true },
  { harness: "codex", file: "errors/codex-usage-limit.ansi", reason: "usage_limit", hold: false },
  { harness: "codex", file: "errors/codex-capacity.ansi", reason: "model_capacity", hold: false },
  { harness: "opencode", file: "errors/opencode-rate-limit.txt", reason: "rate_limit", hold: false },
] as const;

describe("captured blocked screens", () => {
  test("a compact OpenCode error frame is launch-ready even inside the generic alert tail", () => {
    // Constructed short-pane control: omit decorative blank gutter rows only.
    const frame = read("errors/opencode-rate-limit.txt").split("\n").filter(row => row.trim() !== "┃").join("\n");
    expect(detectAgentState("opencode", frame)).toEqual({ agentState: "error", reason: "rate_limit" });
    expect(opencodeComposerIdle(frame)).toBe(true);
    expect(opencodeComposerIdle(read("opencode/blocked-real.txt"))).toBe(false);
  });

  test("constructed narrow usage-modal options remain blocked across physical wraps", () => {
    const frame = read("../usage-limit-modal/pane-plain.txt")
      .replace("Stop and wait for limit to reset", "Stop and wait for\n        limit to reset")
      .replace("Wait here, then continue automatically at", "Wait here, then continue\n        automatically at")
      .replace("Switch to usage credits", "Switch to usage\n        credits");
    expect(detectAgentState("claude", frame)).toEqual({ agentState: "blocked", reason: "usage_limit_modal" });
    expect(keysAnswerPrompt("claude", frame, ["Enter"], true)).not.toBeNull();
    expect(keysAnswerPrompt("claude", frame, ["Escape"], true)).toBeNull();
  });

  for (const row of cases) {
    test(`${row.harness}: ${row.file}`, () => {
      const frame = read(row.file);
      expect(detectAgentState(row.harness, frame)).toEqual({ agentState: row.hold ? "blocked" : "error", reason: row.reason });
      expect(approvalPrompt(row.harness, frame)).toBe(row.hold);
      expect(keysAnswerPrompt(row.harness, frame, ["-l", "resume"], false) !== null).toBe(row.hold);
      expect(heldBlocker(row.harness, frame) !== null).toBe(row.hold);
    });
  }

  test("a failed Codex turn remains error when its title still spins", () => {
    expect(detectAgentState("codex", read("errors/codex-usage-limit.ansi"), "⠹ example"))
      .toEqual({ agentState: "error", reason: "usage_limit" });
  });

  test("unproven error text does not invent a modal or authorize input", () => {
    for (const [harness, frame] of [
      ["claude", "⏺ API Error: 529 Overloaded."],
      ["codex", "■ You’ve hit your usage limit."],
      ["codex", "■ You’ve hit your usage limit.\n› Ask Codex to do anything"],
      ["opencode", "  ┃ Too Many Requests: You've exceeded your subscription rate limits.\n  ┃"],
    ]) {
      expect(detectAgentState(harness!, frame!).agentState).toBe(harness === "opencode" ? "booting" : "unknown");
      if (harness !== "opencode") expect(keysAnswerPrompt(harness!, frame!, ["-l", "resume"], false)).not.toBeNull();
    }
    expect(keysAnswerPrompt("claude", read("../usage-limit-modal/pane-plain.txt"), ["Escape"], true)).toBeNull();
  });

  test("a full Claude Code usage footer is current even after the transcript has scrolled away", () => {
    const frame = read("errors/claude-quota-footer.txt").replace(/^[\s\S]*?(?=─)/, "⏺ Done.\n\n");
    expect(detectAgentState("claude", frame)).toEqual({ agentState: "error", reason: "usage_limit" });
  });

  test("constructed resumed-turn controls supersede a lingering usage footer", () => {
    const frame = read("errors/claude-quota-footer.txt");
    const spinner = frame.replace(/(?=─)/, "✶ Thinking… (5s · ↓ 1.2k tokens)\n\n");
    for (const resumed of [spinner, frame + "\n  esc to interrupt\n"]) {
      expect(detectAgentState("claude", resumed).agentState).toBe("working");
    }
  });

  test("a staged Codex wire retains its exact-input submission path after an error", () => {
    const wire = "[[TAP v0.23 nudge]]";
    const frame = read("errors/codex-usage-limit.ansi").replace("\x1b[2mAsk Codex to do anything\x1b[0m", wire);
    expect(detectAgentState("codex", frame).agentState).toBe("unknown");
    expect(detectAgentState("codex", frame, "", true)).toEqual({ agentState: "error", reason: "usage_limit" });
    expect(approvalPrompt("codex", frame)).toBe(false);
    expect(sentinelSubmitDecision(frame, "codex", wire)).toEqual({ action: "submit" });
  });

  test("an error screen with a usable prompt counts as ready and not busy, and team summaries show the error", () => {
    expect(codexComposerIdle(read("errors/codex-usage-limit.ansi"), "example")).toBe(true);
    expect(readFrame(read("errors/claude-api-overloaded.txt"), "claude", "wire").busy).toBe(false);
    expect(readFrame(read("errors/opencode-rate-limit.txt"), "opencode", "wire").busy).toBe(false);
    expect(teamStatus(["error", "idle"], false, false)).toBe("● error");
  });

  test("an error above the prompt does not stop a staged TAP message from being submitted", () => {
    const wire = "[[TAP v0.23 nudge]]";
    const frame = read("errors/claude-api-overloaded.txt").replace(/^❯.*$/m, `❯ ${wire}`);
    expect(detectAgentState("claude", frame).agentState).toBe("error");
    expect(sentinelSubmitDecision(frame, "claude", wire)).toEqual({ action: "submit" });
  });

  test("the last response decides: a newer normal turn or working spinner supersedes the error", () => {
    const error = read("errors/claude-api-overloaded.txt").split("\n─")[0];
    for (const name of ["done-real", "spinner-real"]) {
      const frame = `${error}\n${read(`claude/${name}.txt`)}`;
      expect(detectAgentState("claude", frame).agentState).toBe(name === "done-real" ? "idle" : "working");
    }
    expect(detectAgentState("claude", read("errors/claude-api-overloaded.txt") + "\n  esc to interrupt\n").agentState).toBe("working");
    const codex = read("errors/codex-usage-limit.ansi");
    const newer = codex.replace(/(?=\x1b\[1m›)/, "• The next turn completed.\n\n");
    expect(detectAgentState("codex", newer).agentState).toBe("idle");
  });

  test("quoted errors, quota warnings and interruption notices do not claim blocked", () => {
    const placeholder = "› \x1b[2mAsk Codex to do anything\x1b[0m";
    for (const prose of [
      "• The log says ‘You’ve hit your usage limit’.",
      "• Example:\n  ■ You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage",
      "⚠ Heads up, you have less than 9% of your weekly limit left.",
      "■ Conversation interrupted - use /feedback if something went wrong",
    ]) expect(detectAgentState("codex", `${prose}\n\n${placeholder}`).agentState).toBe("idle");
    const idle = read("claude/done-real.txt");
    for (const prose of [
      "⏺ The server returned API Error: 529 Overloaded.",
      "⏺ Example:\n  ⏺ API Error: 529 Overloaded.",
      "⏺ Usage limit reset · continuing automatically",
    ]) expect(detectAgentState("claude", idle.replace(/^⏺.*$/m, prose)).agentState).toBe("idle");
  });

  test("all five harnesses keep their captured approval, working and idle controls", () => {
    for (const harness of ["claude", "codex", "cursor", "opencode", "agy"]) {
      const approval = read(`${harness}/blocked-real.txt`);
      expect(detectAgentState(harness, approval).agentState).toBe("blocked");
      expect(approvalPrompt(harness, approval)).toBe(true);
      const idle = harness === "claude" ? "done-real.txt" : harness === "codex" ? "idle.ansi" : "idle-real.txt";
      expect(detectAgentState(harness, read(`${harness}/${idle}`)).agentState).toBe("idle");
      const working = harness === "codex" || harness === "opencode" ? "working.txt" : "working-real.txt";
      expect(detectAgentState(harness, read(`${harness}/${working}`), harness === "codex" ? "⠹ example" : "").agentState).toBe("working");
    }
  });
});
