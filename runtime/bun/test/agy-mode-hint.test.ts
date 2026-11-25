// Antigravity paints a mode hint where typed text goes: at start and after a
// shift+tab mode cycle an empty composer reads `> Auto mode: … (shift+tab to
// cycle)` until the first keystroke. Read as a draft it held mail for the
// draft grace. Rows below are the band and footer of real `capture-pane -e -J`
// frames (Antigravity CLI 1.5.7), with the banner above the band left out.
import { describe, expect, test } from "bun:test";

import { classifyPane } from "../src/pane-state";
import { agyComposer, agyModeHint, composerInput, readFrame } from "../src/submit-frame";

import { frameIo, inputRegion, paneRead, pendingInputProbe } from "../src/pane/reader";
import startup from "./fixtures/agy-startup-1.5.13.json";

const E = "\x1b[";
const BLUE = `${E}38;2;122;162;247m`, MUTED = `${E}38;2;154;165;206m`, RULE_FG = `${E}38;2;65;72;104m`;
const ORANGE = `${E}38;2;255;158;100m`, DEFAULT = `${E}39m`;
const RULE = `${RULE_FG}${"─".repeat(60)}`;
const CUE = `${MUTED}? for shortcuts${DEFAULT}            ${ORANGE}auto${MUTED} · Gemini 4 Hydrogen · high`;
const NO_CUE = `${DEFAULT}                           ${ORANGE}auto${MUTED} · Gemini 4 Hydrogen · high`;
const AUTO = "Auto mode: edits & safe commands auto-approved (shift+tab to cycle)";
const WIRE = "[[TAP v0.23 note team/peer-20261113T035242Z-3ca0a9433e90]]";

const frame = (...rows: string[]): string => [`${DEFAULT}  earlier transcript`, "", RULE, ...rows, ""].join("\n");
/** The start-up frame: the hint row ends without a reset. */
const fresh = frame(`${BLUE}>${DEFAULT} ${MUTED}${AUTO}`, RULE, CUE);
/** After a shift+tab cycle the hint row ends with a reset. */
const cycled = frame(`${BLUE}>${DEFAULT} ${MUTED}Plan mode: research & plan only (shift+tab to cycle)${DEFAULT}`, RULE, CUE);
/** A 48-column pane truncates the sentence on its one row. */
const narrow = frame(`${BLUE}>${DEFAULT} ${MUTED}Auto mode: edits & safe commands auto-appr...${DEFAULT}`, RULE, CUE);
const strip = (text: string): string => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

describe("the Antigravity mode hint is chrome, not a draft", () => {
  for (const [name, hint] of [["start-up", fresh], ["after a mode cycle", cycled], ["truncated in a narrow pane", narrow]] as const) {
    test(`${name}: every reader sees an empty composer`, () => {
      expect(agyModeHint(hint)).toBe(true);
      expect(agyComposer(hint)).toBe("");
      expect(classifyPane(hint, "agy", false)).toEqual({ kind: "ready" });
      expect(composerInput(hint, "agy")).toEqual({ state: "text", text: "" });
      expect(readFrame(hint, "agy", WIRE).state).toBe("empty");
    });
  }

  test("an empty composer without a hint is unchanged", () => {
    const empty = frame(`${BLUE}>${DEFAULT}`, RULE, CUE);
    expect(agyModeHint(empty)).toBe(false);
    expect(classifyPane(empty, "agy", false)).toEqual({ kind: "ready" });
  });
});

describe("anything short of the painted hint stays a draft", () => {
  const draft = (text: string) => ({ kind: "draft" as const, text });
  const cases: Array<[string, string, string]> = [
    // The cue repaints a moment after the first keystroke, so a frame can show both.
    ["typed text while the cue is still painted", frame(`${BLUE}>${DEFAULT} A`, RULE, CUE), "A"],
    ["the hint sentence typed by a person", frame(`${BLUE}>${DEFAULT} ${AUTO}`, RULE, NO_CUE), AUTO],
    ["the hint sentence typed by a person, cue still painted", frame(`${BLUE}>${DEFAULT} ${AUTO}`, RULE, CUE), AUTO],
    ["a plain capture of the hint", strip(fresh), AUTO],
    ["muted text without the footer cue", frame(`${BLUE}>${DEFAULT} ${MUTED}${AUTO}`, RULE, NO_CUE), AUTO],
    ["text painted in another colour than the cue", frame(`${BLUE}>${DEFAULT} ${ORANGE}${AUTO}`, RULE, CUE), AUTO],
    ["typed text followed by muted completion text", frame(`${BLUE}>${DEFAULT} /pl${MUTED}an`, RULE, CUE), "/plan"],
    ["background still active on the hint", frame(`${BLUE}>${DEFAULT} ${MUTED}${E}48;2;12;34;56m${AUTO}${E}49m`, RULE, CUE), AUTO],
    ["background reset leaves reverse video active", frame(`${BLUE}>${DEFAULT} ${MUTED}${E}7;48;2;12;34;56;49m${AUTO}`, RULE, CUE), AUTO],
    ["muted text with a second composer row", frame(`${BLUE}>${DEFAULT} ${MUTED}${AUTO}`, `${DEFAULT}  second row`, RULE, CUE), `${AUTO}\n  second row`],
    ["muted text carrying another attribute", frame(`${BLUE}>${DEFAULT} ${MUTED}${E}7m${AUTO}${E}27m`, RULE, CUE), AUTO],
    ["muted text on a row with an unknown sequence", frame(`${BLUE}>${DEFAULT} ${MUTED}${E}58;5;1m${AUTO}`, RULE, CUE), AUTO],
    ["a cue painted in another colour", frame(`${BLUE}>${DEFAULT} ${MUTED}${AUTO}`, RULE, `${ORANGE}? for shortcuts${DEFAULT}`), AUTO],
    ["a task card between the band and the cue", frame(`${BLUE}>${DEFAULT} ${MUTED}${AUTO}`, RULE, `${DEFAULT}● [12:00:00] build`, CUE), AUTO],
  ];
  for (const [name, capture, text] of cases) {
    test(name, () => {
      expect(agyModeHint(capture)).toBe(false);
      expect(agyComposer(capture)).toBe(text);
      expect(classifyPane(capture, "agy", false)).toEqual(draft(text));
      expect(composerInput(capture, "agy")).toEqual({ state: "text", text });
    });
  }

  test("default-foreground text is typed even when the row above left the cue's colour set", () => {
    // tmux emits only changes, so paint carries across rows; the reader must too.
    const carried = [`${MUTED}  muted transcript row`, RULE, `${BLUE}>${DEFAULT} typed`, RULE, CUE, ""].join("\n");
    expect(agyModeHint(carried)).toBe(false);
    expect(classifyPane(carried, "agy", false)).toEqual(draft("typed"));
  });

  test("a hint whose colour is inherited from the row above is still the hint", () => {
    const inherited = [RULE.replace(RULE_FG, MUTED), `${BLUE}>${MUTED} ${AUTO}`, RULE, CUE, ""].join("\n");
    expect(agyModeHint(inherited)).toBe(true);
  });

  test("a staged wire reads staged, with or without the cue", () => {
    for (const footer of [CUE, NO_CUE]) {
      const staged = frame(`${BLUE}>${DEFAULT} ${WIRE}`, RULE, footer);
      expect(readFrame(staged, "agy", WIRE).state).toBe("staged");
      expect(classifyPane(staged, "agy", false)).toEqual(draft(WIRE));
    }
  });
});

// Captured before the first keystroke, then after typing the hint verbatim.
// Include the last logo row: its background paint carries into the parser.
for (const [name, capture, text] of [["fresh", startup.fresh, ""], ["typed", startup.typed, AUTO]] as const) {
  test(`CLI 1.5.13 ${name} seat: delivery and peek agree on the startup composer`, () => {
    const io = frameIo(capture, "168");
    expect(classifyPane(capture, "agy", false)).toEqual(text ? { kind: "draft", text } : { kind: "ready" });
    expect(inputRegion(io, "%7", "agy").region).toBe(text);
    expect(pendingInputProbe(io, "%7", "agy", 4096).state).toBe(text ? "pending" : "empty");
    expect(JSON.parse(paneRead(io, "%7", "agy", "fixture", true)).input_state).toBe(text ? "other-text" : "empty");
  });
}
