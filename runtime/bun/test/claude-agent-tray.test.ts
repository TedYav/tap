import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { submitVerifyLocked, type PaneEffects } from "../src/courier";
import { claudeBox, claudeFeedbackOverlay, classifyPane } from "../src/pane-state";
import { composerMatches, classifySubmitFrame, sentinelSubmitDecision, visibleSentinelId } from "../src/submit-frame";
import { frameIo, inputLine, inputRegion, inputHasId, pendingInputText, escapedPromptFromFrame } from "../src/pane/reader";

// Idle tray transcribed in tap-9lqa7, 2026-09-25 04:41Z; the preserved
// busy capture has the same fences/status/footer but no selected agent row.
const rule = "─".repeat(118);
const id = "tray-owned";
const wire = `[[TAP v0.23 note ${id}]]`;
const frame = (text: string) => [
  "❯ old transcript", "previous output", `${rule} tap/leader ─`,
  `❯ ${text}`, rule,
  "  Opus 5.5 med | 45%↯ 229k/500k | 📁 tap | 🌿 main",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 3 agents",
  "  ⏺ main",
  "❯ ◯ general-purpose  Rebuilding draft.md after overwrite   23m 49s · ↓ 200.6k tokens",
  "",
].join("\n");

test("idle agent tray selects the framed empty composer", () => {
  const capture = frame("");
  expect(claudeBox(capture)?.typed).toBe("");
  expect(classifyPane(capture, "claude", false)).toEqual({ kind: "ready" });
  expect(pendingInputText(frameIo(capture, "118"), "%p", "claude")).toEqual({ status: "text", text: "" });
});

test("staged sentinel remains visible in the composer above the tray", () => {
  const capture = frame(wire);
  const io = frameIo(capture, "118");
  expect(inputLine(io, "%p", "claude")).toEqual({ ok: true, line: `❯ ${wire}\n` });
  expect(inputRegion(io, "%p", "claude")).toEqual({ status: "ok", region: `❯ ${wire}\n` });
  expect(inputHasId(io, "%p", "claude", id)).toBe(true);
  expect(escapedPromptFromFrame(capture, "claude")).toBe(`❯ ${wire}\n`);
  expect(sentinelSubmitDecision(capture, "claude", wire)).toEqual({ action: "submit" });
});

test("compact ownership and cleared composer verification ignore the tray", () => {
  const command = "/compact keep evidence [[sv:tray]]";
  expect(composerMatches(frame(command), "claude", command)).toBe(true);
  expect(classifySubmitFrame(frame(""), "claude", command)).toMatchObject({ state: "empty" });
  expect(inputHasId(frameIo(frame(""), "118"), "%p", "claude", "old transcript")).toBe(false);
});

test("tray recognition does not resurrect a stale box or trust a chevron alone", () => {
  for (const capture of [
    frame(wire) + "❯ newer human draft\n",
    frame(wire).replace("← 3 agents", "ordinary footer").replace("  ⏺ main\n", ""),
  ]) {
    expect(claudeBox(capture)).toBeNull();
    expect(sentinelSubmitDecision(capture, "claude", wire)).toEqual({ action: "withhold", reason: "not-visible" });
  }
});

// tap-ile3j, 2026-09-28: Claude 2.1.283 drew the open tray while the footer's
// count slot held a PR link (the "· PR #<n>" form) instead of "← N agents", so the
// footer-count witness never armed, the tray caret read as a prompt below the
// border, and the courier called the composer absent geometry — the sentinel
// stayed staged and unverified with enter_count 0, and `tap nudge` could not
// see it either. This specimen is a synthetic reconstruction of that capture
// (neutral seat, made-up id and preview) preserving the pinned 145-column
// geometry; the original held another team's private conversation and is
// never committed.
const FIXTURE = join(import.meta.dir, "fixtures/claude-agent-tray");
const prFooter = readFileSync(join(FIXTURE, "specimen-pr-footer-145.ansi"), "utf8");
const prMeta = JSON.parse(readFileSync(join(FIXTURE, "specimen-pr-footer-145.json"), "utf8")) as { expected: string };
const prId = "fixture-peer-seat-20260928T081630Z-aabbccddeeff";

test("PR-link tray footer still locates the composer and its staged wire", () => {
  expect(claudeBox(prFooter)?.typed).toBe(prMeta.expected);
  expect(classifySubmitFrame(prFooter, "claude", prMeta.expected, "145")).toMatchObject({ state: "staged", mode: "idle" });
  expect(sentinelSubmitDecision(prFooter, "claude", prMeta.expected)).toEqual({ action: "submit" });
  expect(pendingInputText(frameIo(prFooter, "145"), "%p", "claude")).toEqual({ status: "text", text: prMeta.expected });
});

test("tap nudge reads the staged id through the PR-link tray", () => {
  expect(visibleSentinelId(prFooter, "claude")).toBe(prId);
});

test("the tray header alone witnesses the tray when the footer count is gone", () => {
  const capture = frame(wire).replace("← 3 agents", "ordinary footer");
  expect(claudeBox(capture)?.typed).toBe(wire);
  expect(sentinelSubmitDecision(capture, "claude", wire)).toEqual({ action: "submit" });
});

test("a newer human draft below a header-witnessed tray still invalidates the box", () => {
  const capture = frame(wire).replace("← 3 agents", "ordinary footer") + "❯ newer human draft\n";
  expect(claudeBox(capture)).toBeNull();
  expect(sentinelSubmitDecision(capture, "claude", wire)).toEqual({ action: "withhold", reason: "not-visible" });
});

test("an unselected agent row between the header and the caret keeps the witness", () => {
  // The caret may sit on any list row: with two or more background agents,
  // the selected row can follow an unselected one (the unselected row used to
  // disarm the structural witness and tap-ile3j came back).
  const unselected = "  ◯ general-purpose  Indexing docs section   12m 02s · ↓ 98.3k tokens";
  const selected = "❯ ◯ general-purpose  Reading docs section   23m 49s · ↓ 200.6k tokens";
  const tray = (rows: string) => frame(wire)
    .replace("← 3 agents", "ordinary footer")
    .replace(/  ⏺ main\n❯ ◯ general-purpose[^\n]*/, `  ⏺ main\n${rows}`);
  const withHeader = tray(`${unselected}\n${selected}`);
  expect(claudeBox(withHeader)?.typed).toBe(wire);
  expect(sentinelSubmitDecision(withHeader, "claude", wire)).toEqual({ action: "submit" });
  // Without the header the same list is not witnessed: the chevron alone,
  // after an unselected row, still refuses.
  const withoutHeader = tray(`${unselected}\n${selected}`).replace("  ⏺ main\n", "");
  expect(claudeBox(withoutHeader)).toBeNull();
  expect(sentinelSubmitDecision(withoutHeader, "claude", wire)).toEqual({ action: "withhold", reason: "not-visible" });
});

test("the structural witness admits one selected row only, then is consumed", () => {
  // Review catch: a newer human prompt below the tray whose text
  // exactly matches the detailed-row syntax must not ride the witness that
  // admitted the real selected row — the stale composer has to be refused so
  // no Enter goes against the newer draft.
  const selected = "❯ ◯ general-purpose  Reading docs section   23m 49s · ↓ 200.6k tokens";
  const newerDraft = "❯ ◯ task  description   23m 49s · ↓ 200.6k tokens";
  const capture = frame(wire)
    .replace("← 3 agents", "ordinary footer")
    .replace(/❯ ◯ general-purpose[^\n]*/, `${selected}\n${newerDraft}`);
  expect(claudeBox(capture)).toBeNull();
  expect(sentinelSubmitDecision(capture, "claude", wire)).toEqual({ action: "withhold", reason: "not-visible" });
  // The footer-count witness keeps its reviewed permanence: under it the
  // same second detailed row stays exempt (established behavior, unchanged here).
  const withCount = frame(wire).replace(/❯ ◯ general-purpose[^\n]*/, `${selected}\n${newerDraft}`);
  expect(claudeBox(withCount)?.typed).toBe(wire);
});

test("wrapped composer and ANSI prompt stay bounded above a long tray", () => {
  const capture = frame(`${wire}\n  second line`).replace(`❯ ${wire}`, `\x1b[1m❯\x1b[0m ${wire}`) + "  ◯ another agent\n".repeat(15);
  expect(inputRegion(frameIo(capture, "118"), "%p", "claude").region).toContain("second line");
  expect(escapedPromptFromFrame(capture, "claude")).toBe(`\x1b[1m❯\x1b[0m ${wire}\n`);
  expect(pendingInputText(frameIo(capture, "118"), "%p", "claude")).toEqual({ status: "text", text: wire });
});

for (const expected of [wire, "/compact keep evidence [[sv:tray]]"]) {
  test(`courier submits once above tray and verifies cleared input: ${expected}`, () => {
    let enters = 0, injections = 0;
    let capture = frame("");
    const fx: PaneEffects = {
      observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "claude" } as any),
      harnessEvidence: () => "alive", paneState: () => ({ state: "ready" }),
      injectText: () => { injections++; capture = frame(expected); return true; },
      inputHasId: (target, command, needle) => inputHasId(frameIo(capture, "118"), target, command, needle),
      pressEnter: () => { enters++; capture = frame(""); return true; }, settle: () => {},
      submitFrame: (_target, command, text, alive) => classifySubmitFrame(capture, command, text, "118", alive),
    };
    expect(submitVerifyLocked("%1", expected === wire ? id : "tray", expected, { paneId: "%1", harness: "claude", serverEpoch: "srv:1:1" }, fx).status).toBe("injected");
    expect(injections).toBe(1);
    expect(enters).toBe(expected === wire ? 2 : 1); // sentinel completion Enter; slash controls submit once
  });
}

test("truncated agent footer still locates the composer", () => {
  expect(claudeBox(frame(wire).replace("← 3 agents", "← 2 agen…"))?.typed).toBe(wire);
});

test("feedback modal above the composer remains blocked with the tray open", () => {
  const modal = ["╭" + "─".repeat(40) + "╮", "│ ✻ Bug report drafted: example │", "│ 1 to review · 2 to send · 0 to dismiss │", "╰" + "─".repeat(40) + "╯"].join("\n");
  const capture = frame(wire).replace("previous output", modal);
  expect(claudeFeedbackOverlay(capture)).toBe(true);
  expect(pendingInputText(frameIo(capture, "118"), "%p", "claude")).toEqual({ status: "blocked" });
  expect(sentinelSubmitDecision(capture, "claude", wire).action).toBe("withhold");
});

test("one background agent has a readable composer", () => {
  const capture = frame(wire).replace("← 3 agents", "← 1 agent");
  expect(claudeBox(capture)?.typed).toBe(wire);
  expect(sentinelSubmitDecision(capture, "claude", wire)).toEqual({ action: "submit" });
});

test("a circle-prefixed human draft below an old tray invalidates its composer", () => {
  for (const draft of ["◯ todo", "◯ general-purpose  write a note", "◯ todo  23m 49s", "◯ task  description   23m 49s · ↓ 200.6k tokens human draft"]) {
    const capture = frame(wire) + `❯ ${draft}\n`;
    expect(claudeBox(capture)).toBeNull();
    expect(sentinelSubmitDecision(capture, "claude", wire)).toEqual({ action: "withhold", reason: "not-visible" });
  }
});
