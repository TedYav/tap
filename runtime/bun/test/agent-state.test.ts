import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { detectAgentState } from "../src/agent-state";

const fixtures = join(import.meta.dir, "fixtures", "agent-state");
const opencodeSplashFixtures = join(
  import.meta.dir,
  "../../../skills/tap/scripts/smoke/fixtures/opencode-splash",
);

function fixture(harness: string, state: string): string {
  const ext = harness === "codex" && ["idle", "near-idle", "stale"].includes(state) ? "ansi" : "txt";
  return readFileSync(join(fixtures, harness, `${state}.${ext}`), "utf8");
}

describe("agent state detection", () => {
  test("Codex fresh quota-warning captures ignore configured or absent status lines", () => {
    for (const name of ["fresh-warning", "fresh-warning-fast"]) {
      const frame = readFileSync(join(fixtures, "codex", `${name}.ansi`), "utf8");
      const prompt = frame.slice(0, frame.indexOf("Ask Codex to do anything") + "Ask Codex to do anything".length);
      for (const candidate of [frame, prompt, prompt + "\n\x1b[0mmy custom status: everything is optional"]) {
        expect(detectAgentState("codex", candidate, "DemoProject")).toEqual({ agentState: "idle", reason: "prompt_idle" });
      }
    }
  });

  test("Codex cannot reuse an older painted placeholder above a later draft", () => {
    const frame = "› \x1b[2mAsk Codex to do anything\x1b[0m\nprevious screen contents\n› human draft\ncustom footer";
    expect(detectAgentState("codex", frame, "tap")).toEqual({ agentState: "unknown", reason: "no_matching_rule" });
  });

  test("Codex title spinner wins over an empty prompt and draft text", () => {
    const empty = "› \x1b[2mAsk Codex to do anything\x1b[0m";
    for (const frame of [empty, "› a human draft", "ordinary running output"]) {
      expect(detectAgentState("codex", frame, "⠹ tap")).toEqual({ agentState: "working", reason: "title_working" });
    }
    expect(detectAgentState("codex", "Allow command?", "⠹ tap")).toEqual({ agentState: "blocked", reason: "live_strong_blocker" });
    for (const draft of ["a human draft", "Ask Codex to do anything"]) {
      expect(detectAgentState("codex", `› ${draft}\ncustom footer`, "tap").agentState).toBe("unknown");
    }
    expect(detectAgentState("codex", "no prompt", "tap").agentState).toBe("unknown");
  });

  test("literal harness fixtures distinguish live state from stale scrollback", () => {
    for (const harness of ["claude", "codex", "cursor", "opencode", "agy", "hermes"]) {
      for (const agentState of ["working", "blocked", "idle"] as const) {
        expect(detectAgentState(harness, fixture(harness, agentState), harness === "codex" && agentState === "working" ? "⠹ tap" : "tap").agentState)
          .toBe(agentState);
      }
      expect(detectAgentState(harness, fixture(harness, "stale")).agentState).toBe("idle");
    }
  });

  test("current idle chrome beats nearby stale working and blocker tokens", () => {
    const cases = [
      ["claude", { agentState: "idle", reason: "prompt_idle" }],
      ["codex", { agentState: "idle", reason: "prompt_idle" }],
      ["cursor", { agentState: "idle", reason: "prompt_idle" }],
      ["opencode", { agentState: "idle", reason: "composer_idle" }],
      ["agy", { agentState: "idle", reason: "shortcuts_idle" }],
    ] as const;
    for (const [harness, expected] of cases) {
      expect(detectAgentState(harness, fixture(harness, "near-idle"))).toEqual(expected);
    }
  });

  test("Cursor recognizes a busy marker wrapped below the live composer", () => {
    expect(detectAgentState("cursor", fixture("cursor", "working-wrapped"))).toEqual({
      agentState: "working",
      reason: "stop_hint_working",
    });
  });

  test("Codex anchors typed composer text to live chrome, not stale transcript glyphs", () => {
    expect(detectAgentState("codex", fixture("codex", "working-typed"), "⠹ tap")).toEqual({
      agentState: "working",
      reason: "title_working",
    });
    expect(detectAgentState("codex", fixture("codex", "stale-composer"))).toEqual({
      agentState: "unknown",
      reason: "no_matching_rule",
    });
  });

  test("Hermes current idle chrome beats nearby stale working and approval evidence", () => {
    for (const state of ["near-idle-working", "near-idle-blocked"]) {
      expect(detectAgentState("hermes", fixture("hermes", state))).toEqual({
        agentState: "idle",
        reason: "prompt_idle",
      });
    }
  });

  test("higher-priority blocked evidence beats simultaneous working chrome", () => {
    const result = detectAgentState("claude", [
      "Do you want to proceed?",
      "Bash command: printf safe",
      "❯ 1. Yes",
      "  2. No",
      "Esc to cancel · Tab to amend · esc to interrupt",
    ].join("\n"));

    expect(result).toEqual({ agentState: "blocked", reason: "permission_prompt" });
  });

  test("all, any, and not gates reject incomplete or interrupted permission text", () => {
    expect(detectAgentState("claude", [
      "Do you want to proceed?",
      "Esc to cancel · Tab to amend",
    ].join("\n"))).toEqual({
      agentState: "unknown",
      reason: "no_matching_rule",
    });
    expect(detectAgentState("claude", [
      "Do you want to proceed?",
      "⏵ Working on command · esc to interrupt",
    ].join("\n"))).toEqual({
      agentState: "working",
      reason: "interrupt_hint_working",
    });
    expect(detectAgentState("claude", [
      "Do you want to proceed?",
      "❯ 1. Yes",
      "■ Conversation interrupted",
      "Esc to cancel · Tab to amend · esc to interrupt",
    ].join("\n"))).toEqual({
      agentState: "working",
      reason: "interrupt_hint_working",
    });
  });

  test("Codex PR-3339 stale confirmation text cannot beat the current composer", () => {
    expect(detectAgentState("codex", fixture("codex", "stale"))).toEqual({
      agentState: "idle",
      reason: "prompt_idle",
    });
    expect(detectAgentState("codex", fixture("codex", "blocked"))).toEqual({
      agentState: "blocked",
      reason: "live_strong_blocker",
    });
  });

  test("recognized no-match and unsupported harnesses fail closed", () => {
    expect(detectAgentState("codex", "ordinary transcript with no live chrome")).toEqual({
      agentState: "unknown",
      reason: "no_matching_rule",
    });
    expect(detectAgentState("daemon", "❯")).toEqual({
      agentState: "unknown",
      reason: "unrecognized_harness",
    });
  });

  test("OpenCode splash without a live input band is booting, not idle or working", () => {
    const splash = readFileSync(join(opencodeSplashFixtures, "constructed-splash.txt"), "utf8");
    expect(detectAgentState("opencode", splash)).toEqual({
      agentState: "booting",
      reason: "input_band_absent",
    });
    expect(detectAgentState("opencode", fixture("opencode", "idle"))).toEqual({
      agentState: "idle",
      reason: "composer_idle",
    });
  });

  test("runtime harness aliases select the same rule family", () => {
    expect(detectAgentState("claude-code", fixture("claude", "idle")))
      .toEqual(detectAgentState("claude", fixture("claude", "idle")));
    expect(detectAgentState("codex-via", fixture("codex", "working"), "⠹ tap"))
      .toEqual(detectAgentState("codex", fixture("codex", "working"), "⠹ tap"));
    expect(detectAgentState("cursor-agent", fixture("cursor", "blocked")))
      .toEqual(detectAgentState("cursor", fixture("cursor", "blocked")));
    expect(detectAgentState("open-code", fixture("opencode", "idle")))
      .toEqual(detectAgentState("opencode", fixture("opencode", "idle")));
    expect(detectAgentState("antigravity", fixture("agy", "working")))
      .toEqual(detectAgentState("agy", fixture("agy", "working")));
    expect(detectAgentState("hermes-agent", fixture("hermes", "idle")))
      .toEqual(detectAgentState("hermes", fixture("hermes", "idle")));
  });

  test("Claude Code real live pane captures detect idle, wrapped-working, and permission dialogs", () => {
    expect(detectAgentState("claude", fixture("claude", "done-real"))).toEqual({
      agentState: "idle",
      reason: "prompt_idle",
    });
    expect(detectAgentState("claude", fixture("claude", "working-real"))).toEqual({
      agentState: "working",
      reason: "interrupt_hint_working",
    });
    expect(detectAgentState("claude", fixture("claude", "blocked-real"))).toEqual({
      agentState: "blocked",
      reason: "permission_prompt",
    });
  });

  // tap-7txco: current Claude Code paints no `esc to interrupt`. Live captures
  // from 2026-10-01 (prose neutralized); done-shells.txt and blocked-spinner.txt
  // are derived from done-shell-real.txt and blocked-real.txt.
  test("Claude's live spinner row is working; every done line and an empty composer are idle", () => {
    for (const name of ["spinner-real", "spinner-hook-notice-real"]) {
      expect(detectAgentState("claude", fixture("claude", name))).toEqual({ agentState: "working", reason: "spinner_working" });
    }
    for (const name of ["done-real", "done-shell-real", "done-shells"]) {
      expect(detectAgentState("claude", fixture("claude", name))).toEqual({ agentState: "idle", reason: "prompt_idle" });
    }
    expect(detectAgentState("claude", fixture("claude", "blocked-spinner"))).toEqual({ agentState: "blocked", reason: "permission_prompt" });
  });

  // Review finding (Codex): live rows Claude paints between the spinner and
  // the band are indented, so the spinner is still the status row.
  test("queued messages, tip blocks and wrapped continuations below the spinner do not hide it", () => {
    const paneState = join(import.meta.dir, "../../../skills/tap/scripts/smoke/fixtures/pane-state/claude");
    for (const name of ["20260918-queued-empty.ansi", "20260918-queued-live-draft.ansi", "mid-turn-queued-input.txt"]) {
      expect(detectAgentState("claude", readFileSync(join(paneState, name), "utf8"))).toEqual({ agentState: "working", reason: "spinner_working" });
    }
    // A raw capture pads the blank row above the spinner to the pane width; padding is not content.
    const padded = readFileSync(join(import.meta.dir, "../../../skills/tap/scripts/smoke/fixtures/submit-verify/claude-control-wrap-20260923.ansi"), "utf8");
    expect(padded).toMatch(/\n {100,}\n/);
    expect(detectAgentState("claude", padded).agentState).toBe("working");
    // A wrapped queued wire continues at column 0 under a full-width row.
    const spinner = fixture("claude", "spinner-real");
    const width = Bun.stringWidth(spinner.split("\n").find(row => /^─{10,}$/.test(row))!);
    const queued = `  ❯ ${"x".repeat(width - 4)}\ncontinued at column zero`;
    const wrapped = spinner.replace("✽ Combobulating… (3m 4s · ↓ 22.7k tokens)\n", `✽ Combobulating… (3m 4s · ↓ 22.7k tokens)\n\n${queued}\n`);
    expect(wrapped).toContain("continued at column zero");
    expect(detectAgentState("claude", wrapped).agentState).toBe("working");
    // The same column-0 row NOT under a full-width row is the status row, so no spinner.
    expect(detectAgentState("claude", wrapped.replace(`${"x".repeat(width - 4)}\n`, "short\n")).agentState).toBe("idle");
    // A full-width content row may end in a real space where it wrapped; content keeps its width.
    const spaced = wrapped.replace(`${"x".repeat(width - 4)}\n`, `${"x".repeat(width - 5)} \n`);
    expect(spaced).not.toBe(wrapped);
    expect(detectAgentState("claude", spaced).agentState).toBe("working");
  });

  test("only the status row nearest the band is spinner evidence", () => {
    const done = fixture("claude", "done-real");
    // Each control must actually rewrite the frame, or it proves nothing.
    const variant = (from: string, to: string) => {
      expect(done).toContain(from);
      return done.replace(from, to);
    };
    // A spinner-shaped transcript row above the done line is history.
    expect(detectAgentState("claude", variant("⏺ Done: the change is committed and pushed.", "✽ Combobulating… (3m 4s · ↓ 22.7k tokens)")).agentState).toBe("idle");
    // A tool-progress row is not the spinner glyph set.
    expect(detectAgentState("claude", variant("✻ Brewed for 35s · done 10:58 PM", "  ⎿  Running… (7s · 5 lines)")).agentState).toBe("idle");
    // A spinner shape typed into the composer (live empty row: `❯` + NBSP) is a draft, not a turn.
    expect(detectAgentState("claude", variant("❯\u00a0\n", "❯ ✽ Combobulating… (3m 4s)\n")).agentState).toBe("idle");
  });

  // Default-mode captures from tap-3oox6; provenance in approval-delivery.test.ts.
  test("OpenCode, Cursor and agy real default-mode approval dialogs read as blocked", () => {
    expect(detectAgentState("opencode", fixture("opencode", "idle-real"))).toEqual({ agentState: "idle", reason: "composer_idle" });
    expect(detectAgentState("opencode", fixture("opencode", "blocked-real"))).toEqual({ agentState: "blocked", reason: "permission_required" });
    expect(detectAgentState("cursor", fixture("cursor", "idle-real"))).toEqual({ agentState: "idle", reason: "prompt_idle" });
    expect(detectAgentState("cursor", fixture("cursor", "working-real"))).toEqual({ agentState: "working", reason: "stop_hint_working" });
    expect(detectAgentState("cursor-agent", fixture("cursor", "blocked-real"))).toEqual({ agentState: "blocked", reason: "approval_prompt" });
    expect(detectAgentState("agy", fixture("agy", "idle-real"))).toEqual({ agentState: "idle", reason: "shortcuts_idle" });
    expect(detectAgentState("agy", fixture("agy", "working-real"))).toEqual({ agentState: "working", reason: "generating_working" });
    expect(detectAgentState("agy", fixture("agy", "blocked-real"))).toEqual({ agentState: "blocked", reason: "permission_prompt" });
  });

  // tap-aimey: agy 1.2.9 hides `? for shortcuts` while its composer holds text.
  // draft-real is a live 237-column capture of our wrapped wire, email redacted.
  test("agy names our unsubmitted wire and never reads a draft as idle", () => {
    const draft = fixture("agy", "draft-real");
    expect(detectAgentState("agy", draft)).toEqual({ agentState: "unknown", reason: "sentinel_unsubmitted" });
    const human = draft.replace(/> \[\[TAP[\s\S]*?\]\]/, "> fix the build please");
    expect(human).not.toBe(draft);
    expect(detectAgentState("agy", human)).toEqual({ agentState: "unknown", reason: "no_matching_rule" });
    // Constructed: agy queues typed input mid-turn, and working still wins.
    const midTurn = fixture("agy", "working-real").replace(/\n>\n/, "\n> [[TAP v0.23 note x-20260923T000000Z-aaaaaaaaaaaa]]\n");
    expect(midTurn).not.toBe(fixture("agy", "working-real"));
    expect(detectAgentState("agy", midTurn)).toEqual({ agentState: "working", reason: "generating_working" });
  });

  test("Claude Code typed composer is idle activity, not generation", () => {
    const typed = fixture("claude", "done-real").replace("❯ ", "❯ git status");
    expect(detectAgentState("claude", typed)).toEqual({
      agentState: "idle",
      reason: "prompt_idle",
    });
  });
});

test("tap-8nmot: paint rows and a sub-status between Working and the prompt still read working", () => {
  // Without the before-composer paint strip the braille rows fill the
  // four-row window and displace the Working banner: a mid-turn pane would
  // read unknown and the idle staged-submit arm would trust its stillness.
  const workingWords = "• Working (8s • esc to interrupt)";
  const frame = [workingWords, "⠁", "⠁", "⠁", "⠁", "context low · 12% left", "› [[TAP v0.23 note test-20260914T040000Z-0123456789ab]]"].join("\n");
  expect(detectAgentState("codex", frame, "", true).agentState).toBe("working");
});
