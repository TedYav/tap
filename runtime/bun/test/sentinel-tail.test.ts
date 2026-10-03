import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeBox } from "../src/pane-state";
import { classifySubmitFrame, sentinelSubmitDecision } from "../src/submit-frame";
import { closedSentinelInput, matchSentinelSuffix, sentinelShapedInput } from "../src/sentinel-tail";
import { advanceProtection } from "../src/input-protection";
import { stagedSentinel } from "../src/courier";

// tap-1ncs6: the 38x21 Claude frames the courier saw when it gave up ("input
// did not land"): the wire had landed whole, but only its last rows were in the
// composer viewport, so the id-anchored landing check never saw it and Enter
// was withheld. These specimens are a synthetic reconstruction of that capture
// (neutral seats, made-up ids and previews) preserving the pinned wrap
// geometry; the originals held live handles and previews.
const FIX = join(import.meta.dir, "fixtures/claude-narrow-pane");
const specimen = (name: string) => ({
  frame: readFileSync(join(FIX, `${name}.ansi`), "utf8"),
  expected: JSON.parse(readFileSync(join(FIX, `${name}.json`), "utf8")).expected as string,
});
const A = specimen("specimen-a-alice-38x21"), B = specimen("specimen-b-bob-38x21");

// A Claude-shaped composer at `columns` showing only the last `viewport` rows
// of `text`, greedy-wrapped with long tokens hard-split (same renderer the
// tap-vho8h suite uses).
function claudeFrame(text: string, columns: number, viewport: number): string {
  const limit = columns - 4;
  const rows: string[] = [];
  let row = "";
  for (let word of text.split(" ")) {
    while (word.length > limit && row === "") { rows.push(word.slice(0, limit)); word = word.slice(limit); }
    if (row === "") row = word;
    else if (row.length + 1 + word.length <= limit) row += " " + word;
    else { rows.push(row); row = ""; while (word.length > limit) { rows.push(word.slice(0, limit)); word = word.slice(limit); } row = word; }
  }
  if (row) rows.push(row);
  const shown = rows.slice(-viewport);
  const fence = "─".repeat(columns - 16) + " tap/fixture ─", border = "─".repeat(columns);
  return `✻ done\n\n${fence}\n❯ ${shown[0] ?? ""}\n${shown.slice(1).map(r => `  ${r}`).join("\n")}\n${border}\n  Sonnet 5 high | 18%\n`;
}

test("the captured 38-column frames are strict tails of their wires and stage as scrolled", () => {
  for (const { frame, expected } of [A, B]) {
    const box = claudeBox(frame)!;
    expect(box.columns).toBe(38);
    expect(box.typed.split("\n")).toHaveLength(5);
    expect(box.typed.includes("[[TAP")).toBe(false);
    expect(matchSentinelSuffix(box.typed, expected)).toBe("tail");
    expect(classifySubmitFrame(frame, "claude", expected, "38")).toMatchObject({ state: "staged", scrolled: true });
    expect(sentinelSubmitDecision(frame, "claude", expected)).toEqual({ action: "submit" });
    // The same rule at every reader that decides draft-versus-sentinel.
    expect(sentinelShapedInput(box.typed)).toBe(true);
    expect(stagedSentinel(box.typed, "claude")).toBe(true);
    expect(advanceProtection(null, { paneId: "%1", serverEpoch: "s", currentCommand: "claude" }, { state: "busy", text: box.typed }, 0)).toBeNull();
  }
});

test("a width where the whole wire fits keeps the full-match path, without the scrolled flag", () => {
  const frame = claudeFrame(A.expected, 79, 15);
  expect(claudeBox(frame)!.typed.startsWith("[[TAP")).toBe(true);
  expect(matchSentinelSuffix(claudeBox(frame)!.typed, A.expected)).toBe("full");
  const read = classifySubmitFrame(frame, "claude", A.expected, "79");
  expect(read.state).toBe("staged");
  expect(read.scrolled).toBeUndefined();
});

test("suffix: a sentinel-shaped strict suffix is the tail; foreign bytes or an open tail are not", () => {
  const id = "sender-20260101T010101Z-0123456789ab";
  const bare = `[[TAP v0.23 note ${id}]]`;
  const withPreview = `[[TAP v0.23 note ${id} preview="Thanks for the review pass and the landed wire"]]`;
  expect(matchSentinelSuffix("0123456789ab]]", bare)).toBe("tail");
  expect(matchSentinelSuffix('preview="Thanks for the review pass and the landed wire"]]', withPreview)).toBe("tail");
  // Inside the preview, the closing quote is enough.
  expect(matchSentinelSuffix('the landed wire"]]', withPreview)).toBe("tail");
  // Wrapped rows compare joined and whitespace-free.
  expect(matchSentinelSuffix("010101Z-0123456789ab\n  preview=\"Thanks for the review\n  pass and the landed wire\"]]", withPreview)).toBe("tail");
  // A suffix that does not close, or is not a suffix at all, refuses.
  expect(matchSentinelSuffix("0123456789ab", bare)).toBeNull();
  expect(matchSentinelSuffix("my draft 0123456789ab]]", bare)).toBeNull();
  expect(matchSentinelSuffix(`x${bare}`, bare)).toBeNull();
  expect(matchSentinelSuffix("]]", bare)).toBeNull();
  expect(matchSentinelSuffix(bare, bare)).toBe("full");
  expect(matchSentinelSuffix("", bare)).toBeNull();
});

test("shape: sentinel grammar closes with ]] and carries a field, id fragment or closing quote; prose does not", () => {
  expect(sentinelShapedInput("[[TAP v0.23 note x-1]]")).toBe(true);
  expect(sentinelShapedInput("[[TAP v0.23 note x-1 preview=\"cut")).toBe(true);
  expect(sentinelShapedInput("0123456789ab]]")).toBe(true);
  expect(sentinelShapedInput("0123456789a]]")).toBe(false);
  expect(sentinelShapedInput("20260101T010101Z-0123456789ab]]")).toBe(true);
  expect(sentinelShapedInput("lines\"]]")).toBe(true);
  expect(sentinelShapedInput('note x preview="a\n  b"]]')).toBe(true);
  expect(sentinelShapedInput("Z-0123456789ab path=/tmp/x.md]]")).toBe(true);
  expect(sentinelShapedInput("]]")).toBe(false);
  // A human draft: wiki links, prose, an inline-body cut with no grammar mark.
  expect(sentinelShapedInput("see the wiki page [[Release notes]]")).toBe(false);
  expect(sentinelShapedInput("and rerun the tests]]")).toBe(false);
  expect(sentinelShapedInput("fix the parser and rerun")).toBe(false);
  expect(sentinelShapedInput("")).toBe(false);
  expect(sentinelShapedInput("   ")).toBe(false);
  // The Enter-on-tail paths additionally require the closing brackets.
  expect(closedSentinelInput("[[TAP v0.23 note x-1 preview=\"cut")).toBe(false);
  expect(closedSentinelInput("[[TAP v0.23 note truncated")).toBe(false);
  expect(closedSentinelInput("[[TAP v0.23 note x-1]]")).toBe(true);
  expect(closedSentinelInput("lines\"]]")).toBe(true);
});
