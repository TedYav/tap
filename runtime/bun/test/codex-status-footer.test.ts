// tap-21bdj: a Codex auto seat held a complete staged TAP sentinel and the courier never pressed Enter
// (`enter_count 0`, `verify-result unverified`); `tap nudge` refused "staged sentinel changed". Codex 0.160
// paints a status row `<model> <reasoning label> · <cwd> · <thread title>` with no Context item, which the
// footer grammar did not know, so the strict reader counted it (and the warning row under it) as input.
// The fixture is the real capture, genericized (see its README).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  classifySubmitFrame, composerHoldsExactly, composerMatches, enterReady, readComposerFrame, readFrame, sentinelSubmitDecision,
} from "../src/submit-frame";
import { classifyPane } from "../src/pane-state";

const frame = readFileSync(new URL("./fixtures/codex-status-footer/idle-staged-default.txt", import.meta.url), "utf8");
const wire = "[[TAP v0.23 ask north-20261003T053803Z-1a71a0446e42]]";
const STATUS = "GPT-6.1-Sol default · ~/project · Run identity check";
const WARNING = "⚠ 1 warning · f2 to view";

/** The captured frame with its sentinel row, status row or warning row replaced (a line prefix identifies each). */
function edit(change: { sentinel?: string; status?: string | null; warning?: string | null; after?: string }): string {
  return frame.split("\n").map(line => {
    if (line.startsWith("› [[TAP")) return `${change.sentinel === undefined ? line : `› ${change.sentinel}`}${change.after === undefined ? "" : `\n  ${change.after}`}`;
    if (line.includes(STATUS)) return change.status === undefined ? line : change.status === null ? "" : `  ${change.status}`;
    if (line.includes(WARNING)) return change.warning === undefined ? line : change.warning === null ? "" : `  ${change.warning}`;
    return line;
  }).join("\n");
}
const strict = (f: string) => readFrame(f, "codex", wire).state;
const enter = (f: string, permissions: string) => enterReady(f, f, "codex", wire, "id", false, false, true, permissions, true, true);

test("the captured 0.160 frame really carries the status and warning rows the old grammar did not know", () => {
  expect(frame).toContain(STATUS);
  expect(frame).toContain(WARNING);
  expect(frame).toContain(wire);
});

test("sentinel + 0.160 status row + warning row is staged, so every Enter license passes", () => {
  const composer = readComposerFrame(frame, "codex")!;
  expect(composer).toBe(wire);
  expect(strict(frame)).toBe("staged");
  expect(classifySubmitFrame(frame, "codex", wire, "unknown", true, true).state).toBe("staged");
  expect(composerHoldsExactly(frame, "codex", wire)).toBe(true);
  expect(sentinelSubmitDecision(frame, "codex", wire, true).action).toBe("submit");
  // The AUTO Enter gate (sole content) and the bypass gate (containment) both license Enter.
  expect(enter(frame, "auto")).toBe("ready");
  expect(enter(frame, "bypass")).toBe("ready");
});

test("the status row alone, without a warning row, is chrome as well", () => {
  const frameWithoutWarning = edit({ warning: null });
  expect(readComposerFrame(frameWithoutWarning, "codex")).toBe(wire);
  expect(strict(frameWithoutWarning)).toBe("staged");
  expect(enter(frameWithoutWarning, "auto")).toBe("ready");
});

test("the reasoning label, a missing title and extra items all read as the same footer", () => {
  for (const status of ["GPT-6.1-Sol default · ~/project", "gpt-6-astra high · ~/project · Fix the bug", "GPT-6.1-Sol low fast · /work/tree · A · B", "x default · ~/p-1 · Ünïcode title"]) {
    expect(readComposerFrame(edit({ status }), "codex"), status).toBe(wire);
  }
});

test("human text beside the sentinel is still input: AUTO withholds Enter, nudge's equality refuses", () => {
  for (const [label, f] of [
    ["text on the sentinel row", edit({ sentinel: `${wire} please also add a README` })],
    ["text before the sentinel", edit({ sentinel: `my draft ${wire}` })],
    ["a continuation row under the sentinel", edit({ after: "human tail" })],
    ["a draft instead of the sentinel", edit({ sentinel: "please keep this draft" })],
    ["text after the warning row", frame.replace(WARNING, `${WARNING} x`)],
    ["a second wire", edit({ after: "[[TAP v0.23 ask south-20261003T053900Z-aaaaaaaaaaaa]]" })],
  ] as const) {
    expect(strict(f), label).toBe("changed");
    expect(composerHoldsExactly(f, "codex", wire), label).toBe(false);
    expect(enter(f, "auto"), label).toBe("withhold");
  }
  expect(classifyPane(edit({ sentinel: "please keep this draft" }), "codex", false)).toEqual({ kind: "draft", text: "please keep this draft" });
});

test("a row that is not the status shape stays input: no path-like cwd, no known label, or wrapped across rows", () => {
  for (const status of [
    "GPT-6.1-Sol default · project · Run identity check", // cwd without ~ or /
    "GPT-6.1-Sol fancy · ~/project · Run identity check", // unknown reasoning label
    "just some typed words · ~/project",                  // not model + label
    "GPT-6.1-Sol default ~/project",                      // no separator
  ]) {
    expect(readComposerFrame(edit({ status }), "codex"), status).toContain(status);
    expect(strict(edit({ status })), status).toBe("changed");
  }
  // Wrapped over two rows: not recognized (single physical row only), so the second row stays input.
  const wrapped = edit({ status: "GPT-6.1-Sol default · ~/project ·\n  Run identity check" });
  expect(strict(wrapped)).toBe("changed");
});

test("a status-shaped row typed directly under the wire, with no real footer, is input", () => {
  // The reviewer's literal frame: no blank separator, no genuine footer. Codex paints a blank row before its status.
  const bare = `› ${wire}\n  GPT-6.1-Sol default · ~/project · please keep this draft\n`;
  expect(strict(bare)).toBe("changed");
  expect(composerHoldsExactly(bare, "codex", wire)).toBe(false);
  expect(enter(bare, "auto")).toBe("withhold");
  // The same row below the blank separator is the footer shape this fix recognizes.
  expect(strict(`› ${wire}\n\n  GPT-6.1-Sol default · ~/project · Run identity check\n`)).toBe("staged");
});

test("why bypass passed and AUTO did not: containment versus sole content on the same unrecognized footer", () => {
  // An unrecognized footer shape (not the 0.160 shape), so it is kept as input by the reader.
  const unknown = edit({ status: "Some Future Footer 1 2 3" });
  expect(strict(unknown)).toBe("changed");
  expect(enter(unknown, "auto")).toBe("withhold");
  // Bypass's composerMatches/sentinelSubmitDecision only needs the wire visible in the input tail.
  expect(composerMatches(unknown, "codex", wire, false, undefined, true)).toBe(true);
  expect(enter(unknown, "bypass")).toBe("ready");
});
