import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeBox } from "../src/pane-state";
import { classifySubmitFrame, sentinelSubmitDecision } from "../src/submit-frame";
import { anchoredSentinelInput, matchSentinelSuffix, typedWireTail } from "../src/sentinel-tail";
import { normalizeInputMatch } from "../src/terminal-text";
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
    // The same rule at every reader that decides draft-versus-sentinel: with a
    // record that the courier typed this wire, the tail is TAP's own exactly when
    // it reaches back through the id fragment. Without the record it is a draft.
    const id = /(?:ask|note) (\S+)/.exec(expected)![1]!;
    const typed = [{ id, wire: expected, at: 0 }];
    const idVisible = normalizeInputMatch(box.typed).includes(id.slice(-12));
    const obs = { paneId: "%1", serverEpoch: "s", currentCommand: "claude" };
    expect(typedWireTail(box.typed, typed)).toBe(idVisible);
    expect(stagedSentinel(box.typed, "claude", typed)).toBe(idVisible);
    expect(advanceProtection(null, obs, { state: "busy", text: box.typed }, 0, false, "", false, typed) === null).toBe(idVisible);
    expect(typedWireTail(box.typed, [])).toBe(false);
    expect(stagedSentinel(box.typed, "claude", [])).toBe(false);
    expect(advanceProtection(null, obs, { state: "busy", text: box.typed }, 0)).toMatchObject({ graceUntil: 30_000 });
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

test("suffix: a strict suffix of the wire a delivery typed is its tail; foreign bytes, an open tail or a few characters are not", () => {
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
  // A few trailing characters of the wire are not a tail, even though they are a suffix.
  expect(matchSentinelSuffix('wire"]]', withPreview)).toBeNull();
  expect(matchSentinelSuffix("123456789ab]]", bare)).toBeNull();
  expect(matchSentinelSuffix(bare, bare)).toBe("full");
  expect(matchSentinelSuffix("", bare)).toBeNull();
});

const TYPED_ID = "sender-20260101T010101Z-0123456789ab";
const TYPED_WIRE = `[[TAP v0.23 note ${TYPED_ID} preview="Thanks for the review pass and the landed wire"]]`;
const TYPED = [{ id: TYPED_ID, wire: TYPED_WIRE, at: 0 }];

test("a human draft that merely ends like a wire is a draft at every reader, and its WAIT is read", () => {
  const obs = { paneId: "%1", serverEpoch: "s", currentCommand: "claude" };
  for (const draft of [
    'why does this fail: if [[ -z "$FOO" ]]',
    "set path=/usr/local/bin first, then see [[Install notes]]",
    'the fixture is [["a", "b"], ["c", "d"]]',
    "- [docs](https://example.test/?path=/x)\n- [[Roadmap]]",
    'preview="draft" is the field name, as in [[Wire grammar]]',
    "what happened to sender-20260101T010101Z-0123456789ab]]",
    // The last words of a wire the courier did type, without its id fragment.
    'the landed wire"]]',
  ]) {
    // Neither an opener nor the tail of a typed wire, with or without a record for the pane.
    expect(anchoredSentinelInput(draft)).toBe(false);
    expect(typedWireTail(draft, TYPED)).toBe(false);
    expect(stagedSentinel(draft, "claude", TYPED)).toBe(false);
    // Draft protection engages: a grace record, and WAIT typed beside the text snoozes.
    expect(advanceProtection(null, obs, { state: "busy", text: draft }, 0, false, "", false, TYPED)).toMatchObject({ graceUntil: 30_000, consumed: false });
    expect(advanceProtection(null, obs, { state: "busy", text: `WAIT ${draft}` }, 0, false, "", false, TYPED)).toMatchObject({ consumed: true, snoozeUntil: 120_000 });
  }
});

// A typed control (`/compact … [[sv:<id>]]`) closes with `]]` too. Whitespace and a
// scrolled-off head are layout for a wire and content for a control, so the wire rule
// must never vouch for one: not whole, not with a space deleted, not by its tail.
test("the suffix rule vouches only for TAP wire text: a typed control never matches", () => {
  const control = "/compact preserve the handoff and never mark read [[sv:self-worker_dot-1]]";
  expect(matchSentinelSuffix(control, control)).toBeNull();
  expect(matchSentinelSuffix("/compact preservethe handoff and never mark read [[sv:self-worker_dot-1]]", control)).toBeNull();
  expect(matchSentinelSuffix("and never mark read [[sv:self-worker_dot-1]]", control)).toBeNull();
  expect(matchSentinelSuffix("[[sv:self-worker_dot-1]]", control)).toBeNull();
  for (const other of ["/goal ship the fix [[sv:goal-1]]", "/loop 5m check the queue [[sv:loop-1]]", "/compact [[sv:peer-1]]", "prose that ends in a [[wiki link]]"]) {
    expect(matchSentinelSuffix(other, other)).toBeNull();
  }
});

test("an opener-less expected text is already a tail: the visible text must be it exactly, and it holds no [[", () => {
  const tail = '0123456789ab preview="Thanks for the review pass and the landed wire"]]';
  expect(matchSentinelSuffix(tail, tail)).toBe("full");
  expect(matchSentinelSuffix('0123456789ab\n  preview="Thanks for the review\n  pass and the landed wire"]]', tail)).toBe("full");
  // A shorter suffix of a tail proves nothing: only a whole wire can vouch for a suffix.
  expect(matchSentinelSuffix('pass and the landed wire"]]', tail)).toBeNull();
  // A wire whose preview holds a `[[`: the delivery that typed it still proves its landing
  // against the whole wire, but the opener-less tail alone is unproven, at every reader.
  const id = "sender-20260101T010101Z-0123456789ab";
  const wire = `[[TAP v0.23 note ${id} preview="see the [[wiki page for the rest"]]`;
  const itsTail = '0123456789ab preview="see the [[wiki page for the rest"]]';
  expect(matchSentinelSuffix(itsTail, wire)).toBe("tail");
  expect(matchSentinelSuffix(itsTail, itsTail)).toBeNull();
  expect(typedWireTail(itsTail, [{ id, wire }])).toBe(false);
  expect(stagedSentinel(itsTail, "claude", [{ id, wire }])).toBe(false);
});

test("evidence: an opener is anchored; an opener-less tail is TAP's own only as a typed wire's suffix through its id fragment", () => {
  // Anchored: whole, truncated or broken, never prose to back up and clear.
  expect(anchoredSentinelInput("[[TAP v0.23 note x-1]]")).toBe(true);
  expect(anchoredSentinelInput("  [[TAP v0.23 note x-1 preview=\"cut")).toBe(true);
  expect(anchoredSentinelInput("notes before [[TAP v0.23 note x-1]]")).toBe(false);
  expect(anchoredSentinelInput("]]")).toBe(false);
  expect(anchoredSentinelInput("")).toBe(false);
  // The tail of a typed wire, from the id fragment to the close, wrapped or not.
  expect(typedWireTail('0123456789ab preview="Thanks for the review pass and the landed wire"]]', TYPED)).toBe(true);
  expect(typedWireTail('010101Z-0123456789ab\n  preview="Thanks for the review\n  pass and the landed wire"]]', TYPED)).toBe(true);
  expect(typedWireTail(`note ${TYPED_ID} preview="Thanks for the review pass and the landed wire"]]`, TYPED)).toBe(true);
  // One character short of the id fragment, or cut inside the preview: unproven.
  expect(typedWireTail('123456789ab preview="Thanks for the review pass and the landed wire"]]', TYPED)).toBe(false);
  expect(typedWireTail('preview="Thanks for the review pass and the landed wire"]]', TYPED)).toBe(false);
  // Human text in front of the tail breaks the suffix.
  expect(typedWireTail('my draft 0123456789ab preview="Thanks for the review pass and the landed wire"]]', TYPED)).toBe(false);
  // No record for the pane, or a record of some other wire: unproven.
  expect(typedWireTail('0123456789ab preview="Thanks for the review pass and the landed wire"]]', [])).toBe(false);
  expect(typedWireTail("0123456789ab]]", TYPED)).toBe(false);
  expect(typedWireTail("0123456789ab]]", [{ id: TYPED_ID, wire: `[[TAP v0.23 note ${TYPED_ID}]]` }])).toBe(true);
  // A whole anchored wire is the parser's question, not a tail.
  expect(typedWireTail(TYPED_WIRE, TYPED)).toBe(false);
  expect(typedWireTail("", TYPED)).toBe(false);
});
