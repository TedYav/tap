// Whole-draft capture and put-back for Claude's scrolled composer (tap-ipex2).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaneEffects } from "../src/courier";
import { clobberBand } from "../src/deliver";
import { DraftChain, inputBackupBody, inputBackupIncomplete, restorePlainDraft } from "../src/input-backup";
import { alignClearFrame, claudeDraftTailMatches, claudeWrappedLineMatches } from "../src/submit-frame";
import { claudeDraftRows } from "../src/pane-state";

const LONG = "this line is deliberately long so that it wraps inside the composer at one hundred columns and forces a second visual row for the capture chain";
const DRAFT = Array.from({ length: 15 }, (_, i) => i === 6 ? `L07 ${LONG}` : `L${String(i + 1).padStart(2, "0")} draft line ${i + 1} of fifteen`).join("\n");
const COLUMNS = 100;

/** A recorded live chain: Claude 2.1.283 at 100x20, alternating C-u / BSpace until empty. */
const recorded = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/claude-draft-chain/h20.json"), "utf8")).frames as
  { key: "initial" | "C-u" | "BSpace"; state: string; raw: string | null }[];
/** The rows `claudeDraftRows` reports for a box whose `raw` the probe saved. */
const rowsOf = (raw: string) => raw.split("\n").map((row, i) => (i ? row.slice(2) : row).replace(/[ \t ]+$/, ""));

function replay(frames: typeof recorded) {
  const chain = new DraftChain(rowsOf(frames[0]!.raw!), COLUMNS);
  let cleared = false;
  for (const frame of frames.slice(1)) {
    if (frame.state === "ready") { cleared = true; break; }
    chain.observe(frame.key as "C-u" | "BSpace", rowsOf(frame.raw!));
  }
  return chain.capture(cleared);
}

test("the recorded clear chain reads back every line, the soft wrap as one line", () => {
  expect(rowsOf(recorded[0]!.raw!)).toHaveLength(5);
  expect(replay(recorded)).toEqual({ text: DRAFT, complete: true });
});

test("a chain that stops before the composer empties stays incomplete", () => {
  const partial = replay(recorded.slice(0, 12));
  expect(partial.complete).toBe(false);
  expect(DRAFT.endsWith(partial.text.slice(partial.text.indexOf("\n") + 1))).toBe(true);
});

test("a frame that is not one clear key away breaks the chain", () => {
  const frames = recorded.map(frame => ({ ...frame }));
  frames[5] = { ...frames[5]!, raw: frames[5]!.raw!.replace("L10", "X10") };
  expect(replay(frames).complete).toBe(false);
  // Dropping a frame means two rows moved at once: not provable.
  expect(replay([recorded[0]!, ...recorded.slice(3)]).complete).toBe(false);
});

test("a soft join the width-bounded walker rejects breaks the chain", () => {
  // Pretend the continuation were half as wide: no longer a width-bounded wrap.
  const frames = recorded.map(frame => ({ ...frame, raw: frame.raw?.replace("L07 this line is deliberately long so that it wraps inside the composer at one hundred columns", "L07 this line is") ?? null }));
  expect(replay(frames).complete).toBe(false);
});

test("alignClearFrame demands exactly one alignment", () => {
  expect(alignClearFrame(["a", "b", "c"], ["a", "b", ""])).toEqual({ revealed: 0, removed: 0 });
  expect(alignClearFrame(["a", "b", ""], ["z", "a", "b"])).toEqual({ revealed: 1, removed: 1 });
  expect(alignClearFrame(["a", "b"], ["a"])).toEqual({ revealed: 0, removed: 1 });
  // Identical rows admit both readings: refuse.
  expect(alignClearFrame(["x", "x", "x"], ["x", "x", "x"])).toBeNull();
  expect(alignClearFrame(["a", "b"], ["q", "r"])).toBeNull();
});

test("claudeWrappedLineMatches accepts the recorded wrap and refuses a short split", () => {
  const wrapped = rowsOf(recorded.find(f => f.raw?.startsWith("L07 "))!.raw!).slice(0, 2);
  expect(claudeWrappedLineMatches(wrapped, `L07 ${LONG}`, COLUMNS)).toBe(true);
  expect(claudeWrappedLineMatches(["L07 this line", "is deliberately long"], "L07 this line is deliberately long", COLUMNS)).toBe(false);
});

test("claudeDraftTailMatches proves the visible end of a tall draft", () => {
  const tail = rowsOf(recorded[0]!.raw!);
  expect(claudeDraftTailMatches(tail, DRAFT, COLUMNS, true)).toBe(true);
  // Unproven scrolling: the rows must be the whole draft.
  expect(claudeDraftTailMatches(tail, DRAFT, COLUMNS)).toBe(false);
  expect(claudeDraftTailMatches(DRAFT.split("\n").slice(0, 6), DRAFT.split("\n").slice(0, 6).join("\n"), COLUMNS)).toBe(true);
  // The wrapped line's continuation may be the top visible row.
  const cut = rowsOf(recorded.find(f => f.raw?.startsWith("and forces"))!.raw!);
  expect(cut.at(-1)).toBe("L11 draft line 11 of fifteen");
  expect(claudeDraftTailMatches(cut, DRAFT.split("\n").slice(0, 11).join("\n"), COLUMNS, true)).toBe(true);
  expect(claudeDraftTailMatches(tail, DRAFT + "\nextra", COLUMNS, true)).toBe(false);
  expect(claudeDraftTailMatches(["L15 draft line 15 of fifteen", "L14 draft line 14 of fifteen"], DRAFT, COLUMNS, true)).toBe(false);
  // A lost head is not a scrolled one: a unique suffix alone proves nothing.
  expect(claudeDraftTailMatches(["world"], "hello world", COLUMNS)).toBe(false);
});

test("claudeDraftRows de-indents continuation rows and keeps the cursor row", () => {
  const border = "─".repeat(COLUMNS);
  const capture = [border, "❯ first", "    indented", "", border, "  ⏵⏵ auto mode on"].join("\n");
  expect(claudeDraftRows(capture)).toEqual({ rows: ["first", "  indented", ""], columns: COLUMNS });
});

test("restorePlainDraft finishes a draft taller than the viewport", () => {
  const typed: string[] = [];
  const view = (): string[] => {
    const rows = typed.join("").split("\n").flatMap(line => line.length > COLUMNS - 3
      ? [line.slice(0, LONG.indexOf("and forces") + 3), line.slice(LONG.indexOf("and forces") + 4)] : [line]);
    return rows.slice(-5);
  };
  const fx = {
    restoreInput: (_: string, text: string) => { typed.push(text); return true as const; },
    paneState: () => typed.length ? { state: "busy" as const, text: view().join("\n"), rows: view(), columns: COLUMNS } : { state: "ready" as const },
    settle: () => {},
  };
  expect(restorePlainDraft("%1", DRAFT, "claude", "claude", fx, () => true)).toBe(true);
  expect(typed.join("")).toBe(DRAFT);
});

test("restorePlainDraft refuses a pasted line whose head never landed in an unscrolled composer", () => {
  let text = "";
  const fx = {
    // The composer drops the first word of every paste: only a suffix lands.
    restoreInput: (_: string, part: string) => { text += part.replace(/^\S+ /, ""); return true as const; },
    paneState: () => text ? { state: "busy" as const, text, rows: text.split("\n"), columns: COLUMNS } : { state: "ready" as const },
    settle: () => {},
  };
  expect(restorePlainDraft("%1", "hello world", "claude", "claude", fx, () => true)).toBe(false);
});

/** A Claude composer with a 3-row viewport: C-u empties the cursor row, BSpace drops an empty one. */
function scrollingComposer(lines: string[], shown: (rows: string[]) => string[] = rows => rows) {
  let rows = [...lines];
  const view = () => rows.slice(-3);
  const fx = {
    observePane: () => ({ paneId: "%7", session: "team/bob", serverEpoch: "srv:1:2", panePid: "1", currentCommand: "claude" }),
    paneCurrentCommand: () => "claude",
    paneState: () => rows.join("") === "" && rows.length === 1 ? { state: "ready" as const }
      : { state: "busy" as const, text: view().join("\n"), rows: shown(view()), columns: COLUMNS },
    clearInput: () => { rows[rows.length - 1] = ""; return true; },
    backspace: () => { if (rows.length > 1 && rows.at(-1) === "") rows.pop(); return true; },
    injectText: () => true, inputHasId: () => true, pressEnter: () => true, settle: () => {},
  } as unknown as PaneEffects;
  return fx;
}

describe("a fused Claude band (human draft plus our wire) runs the chain too", () => {
  const WIRE = "[[TAP v0.23 note alice/alice-20260926T000000Z-aabbccddeeff]]";
  const human = ["h1 first line", "h2 second line", "h3 third line", "h4 fourth line", "h5 fifth"];
  let dir = "";
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fused-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const req = () => ({ directory: dir, handle: "bob", payloadId: "payload-1", pane: "team/bob:0.0", paneId: "%7" });
  const body = () => readFileSync(join(dir, readdirSync(dir)[0]!), "utf8");

  test("the whole draft is proven, our wire comes out, and the backup is complete", () => {
    const fx = scrollingComposer([...human.slice(0, -1), `${human.at(-1)} ${WIRE}`]);
    const verdict = clobberBand("%7", "claude", undefined, fx, req(), WIRE);
    expect(verdict.kind).toBe("cleared");
    expect("incomplete" in verdict && verdict.incomplete).toBe(false);
    expect(inputBackupIncomplete(body())).toBe(false);
    expect(inputBackupBody(body())).toBe([...human.slice(0, -1), `${human.at(-1)} `].join("\n"));
  });

  test("a proven draft the wire cannot be found in stays incomplete", () => {
    // The rows the reader reports lack the wire, as if it had been redrawn away.
    const fx = scrollingComposer([...human.slice(0, -1), `${human.at(-1)} ${WIRE}`],
      rows => rows.map(row => row.replace(WIRE, "")));
    const verdict = clobberBand("%7", "claude", undefined, fx, req(), WIRE);
    expect(verdict.kind).toBe("cleared");
    expect("incomplete" in verdict && verdict.incomplete).toBe(true);
    expect(inputBackupIncomplete(body())).toBe(true);
  });
});
