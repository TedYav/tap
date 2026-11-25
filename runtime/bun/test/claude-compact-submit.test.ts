import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { submitQueuedClaude, type WakeRequest } from "../src/self-compact";
import type { PaneEffects } from "../src/courier";
import { classifySubmitFrame, composerInput } from "../src/submit-frame";
import { claudeBox, classifyPane } from "../src/pane-state";
import { frameIo, pendingInputRegionText, pendingInputText } from "../src/pane/reader";
import collapsed from "./fixtures/claude-compact-collapsed.json";
import { proofFixture } from "./fixtures/compaction-proof";
import { removeScratchTree } from "./support/scratch";

function fixture() {
  const root = mkdtempSync(join(process.env.TAP_HOME!, "queued-compact-"));
  const proof = proofFixture(root, "claude"), registry = join(root, "registry.json");
  const seat = { ...proof.seat, status: "active", instance: "i1", pane_id: "%7", pane: "fixture:0.0", session: "fixture", server_epoch: "srv:1" };
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture" }, seats: { worker: seat } }));
  const request: WakeRequest = { mode: "claude", id: "worker.dot-1", registry, bus: root, team: "fixture", handle: "worker",
    bound: { paneId: "%7", instance: "i1", serverEpoch: "srv:1", harness: "claude", handle: "worker" },
    focus: "preserve the handoff   ", session: proof.seat.harness_session_id, transcript: proof.path, queuedAt: 0 };
  let buffer = "", held = false, copy = false, refuseEnter = false, releases = 0;
  const keys: string[] = [];
  const fx: PaneEffects = {
    observePane: () => ({ paneId: "%7", session: "fixture", serverEpoch: "srv:1", currentCommand: "claude", panePid: "42" }),
    harnessEvidence: () => "alive",
    paneState: () => buffer ? { state: "busy", text: buffer } : { state: "ready" },
    copyMode: () => ({ status: copy ? "copy-mode" : "normal" }),
    injectText: (_target, text) => { keys.push(text); buffer += text; return true; },
    inputHasId: () => false,
    promptInput: () => ({ status: "text", text: buffer.replace(/ $/, "") }),
    regionInput: () => ({ status: "text", text: buffer }),
    submitFrame: (_target, _command, expected) => ({ state: buffer === expected ? "staged" : buffer ? "changed" : "empty", mode: "working", width: "77" }),
    pressEnter: () => { keys.push("Enter"); if (refuseEnter) return false; buffer = ""; return true; },
    settle: () => {},
  };
  const lock = (_pane: string, timeout: number) => { expect(timeout).toBe(0); return held ? null : { release: () => { releases++; } }; };
  return { root, request, fx, keys, lock, get buffer() { return buffer; }, set buffer(v: string) { buffer = v; },
    set held(v: boolean) { held = v; }, set copy(v: boolean) { copy = v; }, set refuseEnter(v: boolean) { refuseEnter = v; },
    get releases() { return releases; }, close: () => removeScratchTree(root) };
}

// Live 2.1.327 frames: the second payload chunk hides both the command and
// prompt glyph behind an explicit collapsed border. Exercise the real readers
// at each chunk and at Enter, rather than handing the courier its own buffer.
function collapsedFixture(edit: (frame: string, index: number) => string = frame => frame) {
  const f = fixture();
  f.request.id = "collapse-probe";
  f.request.focus = collapsed.focus;
  const frame = () => {
    if (!f.buffer) return `✻ done\n${"─".repeat(58)}\n❯ \n${"─".repeat(58)}\n`;
    const index = f.keys.filter(k => k !== "Enter").length - 1;
    return edit(collapsed.frames[index]!, index);
  };
  f.fx.promptInput = () => pendingInputText(frameIo(frame(), "58"), "%7", "claude");
  f.fx.regionInput = (_target, _command, allowCollapsed) => pendingInputRegionText(frameIo(frame(), "58"), "%7", "claude", allowCollapsed);
  f.fx.submitFrame = (_target, _command, expected, _alive, _sole, scrolledControl) =>
    classifySubmitFrame(frame(), "claude", expected, "58", true, false, scrolledControl);
  return f;
}

test("live collapsed Claude composer proves every chunk and submits compact exactly once", () => {
  const f = collapsedFixture();
  try {
    const out = submitQueuedClaude(f.request, f.fx, f.lock);
    expect(out.result.status).toBe("injected");
    expect(out.boundary).toBeDefined();
    expect(f.keys.filter(k => k === "Enter")).toHaveLength(1);
    expect(f.keys.slice(0, -1).join("")).toBe(`/compact ${collapsed.focus} [[sv:self-collapse-probe]]`);
    expect(f.keys.at(-1)).toBe("Enter");
  } finally { f.close(); }
});

test("a long Claude seat title can use all the space after the hidden-row count", () => {
  const f = collapsedFixture(frame =>
    frame.replace(/─+ fixture\/compact/, " sample-project/full-length-reviewer-sessi…")
  );
  try {
    expect(submitQueuedClaude(f.request, f.fx, f.lock).result.status).toBe("injected");
    expect(f.keys.filter(key => key === "Enter")).toHaveLength(1);
  } finally { f.close(); }
});

test("collapsed input is a suffix witness only; ordinary draft and submit reads still hold", () => {
  const frame = `❯ older transcript prompt\n${collapsed.frames[3]!}`;
  const expected = `/compact ${collapsed.focus} [[sv:self-collapse-probe]]`;
  expect(composerInput(frame, "claude")).toEqual({ state: "unknown" });
  expect(pendingInputRegionText(frameIo(frame, "58"), "%7", "claude")).toEqual({ status: "no-band" });
  expect(composerInput(frame, "claude", true)).toMatchObject({ state: "text" });
  expect(classifySubmitFrame(frame, "claude", expected, "58", true, false, true)).toMatchObject({ state: "staged", scrolled: true });
  expect(classifySubmitFrame(frame, "claude", expected, "58", true, false).state).toBe("unobservable");
  expect(classifyPane(frame, "claude", false).kind).toBe("no-band");
  expect(claudeBox(frame)).toBeNull();
  expect(classifySubmitFrame(frame, "claude", expected.replace("/compact ", "/goal "), "58", true, false, true).state).not.toBe("staged");
});

for (const [name, edit] of [
  ["missing collapsed indicator", (s: string) => s.replace(/↑ \d+ more/, "hidden rows")],
  ["zero hidden rows", (s: string) => s.replace(/↑ \d+ more/, "↑ 0 more")],
  ["missing bottom border", (s: string) => s.replace("─".repeat(58), "")],
  ["mismatched border widths", (s: string) => s.replace("─".repeat(58), "─".repeat(60))],
  ["unindented body row", (s: string) => s.replace("  fixture and report", "foreign text and report")],
  ["newer prompt below box", (s: string) => s + "\n❯ human draft\n"],
  ["altered visible payload", (s: string) => s.replace("fixture and report", "fixture and change")],
  ["opaque paste chip", (s: string) => s.replace("fixture and report", "[Pasted text #1 +3 lines]")],
] as const) test(`unprovable collapsed chunk withholds Enter: ${name}`, () => {
  const f = collapsedFixture((s, i) => i >= 2 ? edit(s) : s);
  try {
    const out = submitQueuedClaude(f.request, f.fx, f.lock);
    expect(out.result.status).toBe("unverified");
    expect("detail" in out.result && out.result.detail).toContain("Enter withheld");
    expect(f.keys).not.toContain("Enter");
    expect(f.keys).toHaveLength(3);
    expect(f.buffer).toBe(f.keys.join(""));
  } finally { f.close(); }
});

for (const kind of ["lock", "draft", "copy"] as const) test(`production queued submit has no effect while ${kind} holds, then submits once`, () => {
  const f = fixture();
  try {
    if (kind === "lock") f.held = true;
    if (kind === "draft") f.buffer = "human's unfinished draft";
    if (kind === "copy") f.copy = true;
    const held = submitQueuedClaude(f.request, f.fx, f.lock);
    expect(held.effectAttempted).toBe(false);
    expect(held.boundary).toBeUndefined();
    expect(f.keys).toEqual([]);
    if (kind === "draft") expect(f.buffer).toBe("human's unfinished draft");
    f.held = false; f.copy = false; f.buffer = "";
    const out = submitQueuedClaude(f.request, f.fx, f.lock);
    expect(out.result.status).toBe("injected");
    expect(out.effectAttempted).toBe(true);
    expect(out.boundary).toMatchObject({ mode: "claude", path: f.request.transcript, session: f.request.session });
    expect(f.keys).toEqual(["/compact ", "preserve the handoff [[sv:self-worker_dot-1]]", "Enter"]);
    expect(f.releases).toBe(kind === "lock" ? 1 : 2);
  } finally { f.close(); }
});

test("a possibly delivered Enter has an effect witness and can never look like a defer", () => {
  const f = fixture();
  try {
    f.refuseEnter = true;
    const out = submitQueuedClaude(f.request, f.fx, f.lock);
    expect(out.result.status).toBe("unverified");
    expect(out.effectAttempted).toBe(true);
    expect(out.boundary).toBeDefined();
    expect(f.keys.filter(k => k === "Enter")).toHaveLength(1);
    expect(f.releases).toBe(1);
  } finally { f.close(); }
});

test("an opaque pasted control records a possible text effect without pressing Enter", () => {
  const f = fixture();
  try {
    f.fx.regionInput = () => ({ status: "text", text: f.buffer.length > 16 ? "/compact [Pasted text #1 +3 lines]" : f.buffer });
    const out = submitQueuedClaude(f.request, f.fx, f.lock);
    expect(out.result.status).toBe("unverified");
    expect(out.effectAttempted).toBe(true);
    expect(out.boundary).toBeUndefined();
    expect(f.keys).not.toContain("Enter");
    expect(f.releases).toBe(1);
  } finally { f.close(); }
});

// tap-vho8h: a composer taller than its viewport. The fake renders the buffer
// the way Claude lays out a typed control (greedy wrap inside the box, long
// tokens hard-split at the full row) and shows only the LAST `viewport` rows
// with the prompt glyph on the first visible one; the real classifier reads it.
function scrolledClaudeFrame(text: string, columns: number, viewport: number): string {
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

for (const [label, columns, viewport, focusChars, scrolls] of [["52x40", 52, 15, 1400, true], ["170x20", 170, 5, 1100, true], ["120x60", 120, 45, 1400, false]] as const) {
  test(`production queued submit at ${label}: a ${focusChars}-char focus ${scrolls ? "scrolls the command row away and still" : "stays in view and"} submits once with Enter`, () => {
    const f = fixture();
    try {
      f.request.focus = ("preserve the handoff at docs/plans/x.md and the review threads on PR #1 " + "and the failing fixture ".repeat(80)).slice(0, focusChars).trim();
      f.fx.submitFrame = (_target, _command, expected, _alive, _sole, scrolledControl) =>
        classifySubmitFrame(scrolledClaudeFrame(f.buffer, columns, viewport), "claude", expected, String(columns), true, false, scrolledControl);
      const out = submitQueuedClaude(f.request, f.fx, f.lock);
      const frame = scrolledClaudeFrame(`/compact ${f.request.focus} [[sv:self-worker_dot-1]]`, columns, viewport);
      expect(claudeBox(frame)!.typed.startsWith("/compact ")).toBe(!scrolls);
      expect(out.result.status).toBe("injected");
      expect(out.boundary).toBeDefined();
      expect(f.keys.filter(k => k === "Enter")).toHaveLength(1);
      expect(f.keys.at(-1)).toBe("Enter");
    } finally { f.close(); }
  });
}

// A control's proof is exact: a space deleted after it was typed makes a different command.
// The frame the courier checks before Enter shows the edit; the earlier typed-text reads did not.
for (const [label, edit] of [
  ["a deleted space", (text: string) => text.replace("preserve the", "preservethe")],
  ["an added space", (text: string) => text.replace("handoff", "hand off")],
] as const) {
  test(`a control edited after it was typed never gets Enter: ${label}`, () => {
    const f = fixture();
    try {
      f.fx.submitFrame = (_target, _command, expected, _alive, _sole, scrolledControl) =>
        classifySubmitFrame(scrolledClaudeFrame(edit(f.buffer), 120, 45), "claude", expected, "120", true, false, scrolledControl);
      const out = submitQueuedClaude(f.request, f.fx, f.lock);
      expect(f.keys).not.toContain("Enter");
      expect(out.result.status).toBe("unverified");
    } finally { f.close(); }
  });
}

test("the scrolled proof is the /compact arm's alone: an ordinary wire in a scrolled composer withholds Enter", () => {
  const f = fixture();
  try {
    f.request.focus = ("preserve the handoff at docs/plans/x.md " + "and the failing fixture ".repeat(80)).slice(0, 1400).trim();
    // The same frame classifier, but the courier asked for an ordinary wire's rule.
    f.fx.submitFrame = (_target, _command, expected) =>
      classifySubmitFrame(scrolledClaudeFrame(f.buffer, 52, 15), "claude", expected, "52", true, false, false);
    const out = submitQueuedClaude(f.request, f.fx, f.lock);
    expect(out.result.status).toBe("unverified");
    expect("detail" in out.result ? out.result.detail : "").toContain("press Enter there to submit it");
    expect(f.keys).not.toContain("Enter");
    expect(out.effectAttempted).toBe(true);
  } finally { f.close(); }
});
