import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { computeFor, formatAge, parseElapsed, readClaude, readCodex, rosterActivity } from "../src/roster-activity";
import { detectAgentState } from "../src/agent-state";

const NOW = Date.UTC(2026, 9, 1, 13, 0, 0) / 1000; // 13:00 UTC
const IDLE = { agentState: "idle" as const, reason: "prompt_idle" };
const RULE = "─".repeat(60);

// Live Claude Code specimens captured 2026-10-01 (spinner, done line, footer).
function claude(above: string, footer: string): string {
  return [
    "⏺ earlier transcript row",
    above,
    `${RULE} tap/seat ─`,
    "❯ ",
    RULE,
    "  Opus 5.5 med | 44%↯ 186k/420k ●59m ████░░░░░░ | 📁 Tree | 🌿 lane/x",
    footer,
  ].join("\n");
}
const SPINNER = "✢ Crystallizing… (8m 57s · ↓ 53.1k tokens)";
const DONE_SHELL = "✻ Baked for 1m 29s · done 12:30 PM · 1 shell still running";
const DONE = "✻ Brewed for 42s · done 12:30 PM";
const FOOTER = "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 3 agents";
const FOOTER_SHELL = "  ⏵⏵ bypass permissions on · PR !4377 · 1 shell · ← 3 agents";

describe("pane clocks", () => {
  test("elapsed and age round-trip the roster's compact units", () => {
    expect(parseElapsed("8m 57s")).toBe(537);
    expect(parseElapsed("1h 2m")).toBe(3720);
    expect(parseElapsed("soon")).toBeNull();
    expect([45, 720, 11100, 200000].map(formatAge)).toEqual(["45s", "12m", "3h05m", "2d"]);
  });

});

describe("Claude band neighbours", () => {
  test("the spinner, done line and footer shell count read from their own rows", () => {
    expect(readClaude(claude(SPINNER, FOOTER))).toEqual({ spinnerElapsed: 537, shells: 0 });
    expect(readClaude(claude(DONE_SHELL, FOOTER_SHELL))).toEqual({ spinnerElapsed: null, shells: 1 });
    expect(readClaude(claude("✻ Worked for 7s · done 5:59 AM", FOOTER))?.shells).toBe(0);
  });

  test("a phase-first spinner under a right-aligned notice still dates the turn (tap-7txco)", () => {
    const hooked = `✽ Elucidating… (running PreToolUse hook · 1m 19s · ↓ 5.5k tokens)\n${" ".repeat(78)}✔ Update installed · Restart to update`;
    expect(readClaude(claude(hooked, FOOTER))).toEqual({ spinnerElapsed: 79, shells: 0 });
  });

  test("agent-list counts and transcript text are not this seat's work", () => {
    // `← 3 agents` is painted on every seat; it is not a shell count.
    expect(readClaude(claude(DONE, FOOTER))?.shells).toBe(0);
    // A spinner-shaped line above the band's last row is history.
    const frame = claude(DONE, FOOTER).replace("⏺ earlier transcript row", SPINNER);
    expect(readClaude(frame)?.spinnerElapsed).toBeNull();
    // A shell count quoted in the input band is a draft, not the footer.
    expect(readClaude(claude(DONE, FOOTER).replace("❯ ", "❯ · 2 shells ·"))?.shells).toBe(0);
  });
});

describe("Codex status rows", () => {
  test("working elapsed, and background terminals as live chrome below the turn's end", () => {
    const fixture = readFileSync(join(import.meta.dir, "fixtures/codex-warning-footer/midturn-partial.ansi"), "utf8");
    expect(readCodex(fixture)?.workingElapsed).toBe(401);
    const ended = "• done.\n  Worked for 2m 47s • 12:30 PM\n  1 background terminal running · /ps to view · /stop to close\n› Ask Codex to do anything\n  status";
    expect(readCodex(ended)).toEqual({ workingElapsed: null, terminals: 1 });
    expect(readCodex("no composer here")).toBeNull();
  });

  test("the terminal phrase in transcript history is not live chrome", () => {
    // A completed reply quoting the chrome, then its real end row (team-wait review, round 1).
    const quoted = "• The footer said:\n  1 background terminal running · /ps to view · /stop to close\n  Worked for 10s • 12:30 PM\n› Ask Codex to do anything\n  status";
    expect(readCodex(quoted)?.terminals).toBe(0);
    // No turn-end row bounds the chrome: refuse rather than guess.
    expect(readCodex("  1 background terminal running · /ps to view\n› Ask Codex to do anything")?.terminals).toBe(0);
    // A prose row that merely starts like the end row is not one (team-wait review, round 2).
    const prose = "• Example syntax:\n  Worked for 1s is the example header\n  1 background terminal running · /ps to view\n" + "─".repeat(42) + "\n› Ask Codex to do anything";
    expect(readCodex(prose)?.terminals).toBe(0);
    // Prose that merely mentions terminals is not the chrome shape.
    expect(readCodex("  Worked for 10s • 12:30 PM\n  I left 2 background terminals running for you\n› Ask Codex to do anything")?.terminals).toBe(0);
  });
});

describe("compute wake evidence", () => {
  const job = (over: Record<string, unknown>) => ({
    id: "j1", status: "running", notify_done: "tap/seat", released_at: null,
    identity: JSON.stringify({ handle: "seat", team: "tap", pane_id: "%7" }), ...over,
  });

  test("only a live notify-done job from this seat's current pane wakes it", () => {
    expect(computeFor([job({})], "tap", "seat", "%7")).toEqual(["j1"]);
    expect(computeFor([job({ status: "queued" }), job({ id: "j2", status: "offered" })], "tap", "seat", "%7")).toEqual(["j1", "j2"]);
  });

  test("attribution, a replaced instance, or a finished job is not a wake", () => {
    for (const over of [
      { notify_done: null },                       // requester alone: plain exec, no completion note
      { notify_done: "tap/other" },
      { identity: JSON.stringify({ pane_id: "%9" }) }, // a replaced instance's job
      { identity: "{not json" },
      { status: "done" },
      { released_at: 1790000000 },
      { id: 7 },
    ]) expect(computeFor([job(over)], "tap", "seat", "%7")).toEqual([]);
    expect(computeFor([job({})], "", "seat", "%7")).toEqual([]);
    expect(computeFor([job({})], "tap", "seat", "")).toEqual([]);
  });
});

describe("roster activity", () => {
  const ended = Date.UTC(2026, 9, 1, 12, 30, 0) / 1000;

  test("a live Claude spinner is the shared classifier's working; the overlay only dates it (tap-7txco)", () => {
    const frame = claude(SPINNER, FOOTER);
    expect(rosterActivity("claude", frame, detectAgentState("claude", frame), [], NOW)).toEqual({
      result: { agentState: "working", reason: "spinner_working" }, waitingOn: [],
      turnStartedAt: NOW - 537, turnEndedAt: null, turnEndedSource: null,
    });
    // One implementation: the overlay no longer lifts a native idle on its own.
    expect(rosterActivity("claude", frame, IDLE, [], NOW).result).toEqual(IDLE);
  });

  test("an ended turn with live shells is waiting; only a dated record dates it", () => {
    expect(rosterActivity("claude", claude(DONE_SHELL, FOOTER_SHELL), IDLE, [], NOW)).toEqual({
      result: { agentState: "waiting", reason: "background_shells" }, waitingOn: [{ kind: "shell", count: 1 }],
      turnStartedAt: null, turnEndedAt: null, turnEndedSource: null,
    });
    // The painted `done 12:30 PM` alone never dates the turn; a transcript record does.
    expect(rosterActivity("claude", claude(DONE_SHELL, FOOTER_SHELL), IDLE, [], NOW, ended)).toMatchObject({
      turnEndedAt: ended, turnEndedSource: "transcript",
    });
  });

  test("Codex background terminals and compute wakes are waiting; nothing else is", () => {
    const codexIdle = "  Worked for 10s • 12:30 PM\n  2 background terminals running · /ps to view\n› Ask Codex to do anything\n";
    expect(rosterActivity("codex", codexIdle, IDLE, [], NOW).result).toEqual({ agentState: "waiting", reason: "background_terminals" });
    expect(rosterActivity("opencode", "", IDLE, ["j1"], NOW)).toMatchObject({
      result: { agentState: "waiting", reason: "compute" }, waitingOn: [{ kind: "compute", id: "j1" }],
    });
    expect(rosterActivity("claude", claude(DONE, FOOTER), IDLE, [], NOW)).toMatchObject({ result: IDLE, waitingOn: [], turnEndedAt: null });
    expect(rosterActivity("cursor", "anything · 3 shells ·", IDLE, [], NOW).result).toEqual(IDLE);
  });

  test("blocked, booting and unknown keep their native answer; working keeps its elapsed", () => {
    for (const native of [
      { agentState: "blocked" as const, reason: "permission_prompt" },
      { agentState: "booting" as const, reason: "input_band_absent" },
      { agentState: "unknown" as const, reason: "no_matching_rule" },
    ]) {
      expect(rosterActivity("claude", claude(DONE_SHELL, FOOTER_SHELL), native, ["j1"], NOW, ended)).toEqual({
        result: native, waitingOn: [], turnStartedAt: null, turnEndedAt: null, turnEndedSource: null,
      });
    }
    const working = { agentState: "working" as const, reason: "screen_working" };
    const fixture = readFileSync(join(import.meta.dir, "fixtures/codex-warning-footer/midturn-partial.ansi"), "utf8");
    expect(rosterActivity("codex", fixture, working, ["j1"], NOW)).toMatchObject({ result: working, waitingOn: [], turnStartedAt: NOW - 401 });
  });
});
