import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { frameIo, pendingInputText } from "../src/pane/reader";
import { readComposerFrame, classifySubmitFrame } from "../src/submit-frame";
import { classifyPane } from "../src/pane-state";
import { detectAgentState } from "../src/agent-state";

// Codex 0.154.0, 2026-09-14: literal tmux -e capture;
// only composer/adjacent decoration/footer retained, no transcript or user input.
const animated = readFileSync(new URL("./fixtures/codex-starfield/empty.ansi", import.meta.url), "utf8");
const placeholder = "Ask Codex to do anything";
const wire = "[[TAP v0.23 note test-20260914T040000Z-0123456789ab]]";

/** The pending-input reader over a supplied frame, as the spool and courier read it. */
function pendingText(frame: string): string {
  const result = pendingInputText(frameIo(frame, "80"), "unused", "codex", frame);
  expect(result.status).toBe("text");
  return result.status === "text" ? result.text : "";
}

for (const [name, capture] of [
  ["captured", animated],
  ["clear spacer", animated.replace(/⠁/g, " ")],
  ["no decoration", animated.replace(/[\u2800-\u28ff]/g, " ")],
] as const) {
  test(`Codex animated empty composer is ready through the shared readers: ${name}`, () => {
    expect(readComposerFrame(capture, "codex")).toBe("");
    expect(classifyPane(capture, "codex", false)).toEqual({ kind: "ready" });
    expect(detectAgentState("codex", capture, "tap")).toEqual({ agentState: "idle", reason: "prompt_idle" });
    expect(classifySubmitFrame(capture, "codex", wire).state).toBe("empty");
    expect(pendingText(capture)).toBe("");
  });
}

// tap-8nmot ruling: braille paint (U+2800-28FF) is Codex chrome, stripped by
// the one reader before classification — paint-carrying drafts read as their
// stripped bytes, and a paint-only draft reads empty.
const painted = (text: string): string => text.replace(/[\u2800-\u28ff]/g, " ");

for (const text of ["⠁", "human ⠁ draft", placeholder, placeholder + " ⠁", wire, "/compact"]) {
  test(`Codex starfield recognition preserves draft ${JSON.stringify(text)}`, () => {
    const capture = `› ${text}\n\n`;
    const read = painted(text) === text ? text : painted(text).replace(/\s+$/, "");
    expect(readComposerFrame(capture, "codex")).toBe(read);
    expect(classifyPane(capture, "codex", false)).toEqual(read === "" ? { kind: "ready" } : { kind: "draft", text: read });
    // inputRegion (draft backup) is unchanged: pendingText stays byte-preserving.
    expect(pendingText(capture)).toBe(text);
  });
}

test("Codex staged messages and placeholder lookalikes retain their meaning", () => {
  expect(classifySubmitFrame(`› ${wire}\n`, "codex", wire).state).toBe("staged");
  // tap-8nmot: the bright braille prefix is paint, so the composer reads the
  // placeholder's words — but without dim SGR they are not the placeholder, so
  // agent state stays unknown and pendingText keeps the raw bytes.
  const brightLookalike = `›⠁${placeholder}`;
  expect(readComposerFrame(brightLookalike, "codex")).toBe(placeholder);
  expect(pendingText(brightLookalike)).toBe(`⠁${placeholder}`);
  expect(detectAgentState("codex", brightLookalike, "tap").agentState).toBe("unknown");
  expect(readComposerFrame(animated + "\n› later draft\n", "codex")).toBe("later draft");
  expect(readComposerFrame(animated.replace(placeholder, placeholder + " real draft"), "codex")).not.toBe("");
  expect(readComposerFrame(animated.replace(/\x1b\[2m/g, "\x1b[22m"), "codex")).not.toBe("");
});

test("Codex working screen outranks animated idle hint without a title spinner", () => {
  const working = readFileSync(new URL("./fixtures/codex-starfield/working.ansi", import.meta.url), "utf8");
  expect(detectAgentState("codex", working, "")).toEqual({ agentState: "working", reason: "screen_working" });
  const workingWords = "• Working (8s • esc to interrupt)";
  expect(detectAgentState("codex", `› human draft\n${workingWords}\n`, "").agentState).toBe("unknown");
  expect(detectAgentState("codex", `${workingWords}\nold\nold\nold\nold\n${animated}`, "")).toEqual({ agentState: "idle", reason: "prompt_idle" });
});

test("tap-8nmot: the real staged Codex capture reads a clean staged band (paint + footer stripped)", () => {
  // The REAL captured specimen: a staged wire whose row carries paint and
  // whose footer rows trail the composer. The band text must come back as the
  // clean wire alone — the capture-side gate the idle arm's staged_absent
  // check keys on.
  const staged = readFileSync(new URL("../../../skills/tap/scripts/smoke/fixtures/submit-verify/codex-idle-staged-80.ansi", import.meta.url), "utf8");
  expect(classifyPane(staged, "codex", false)).toEqual({
    kind: "draft",
    text: "[[TAP v0.23 note sender-20260906T220111Z-21f26672936f]]",
  });
});

test("Codex queued-message block preserves working state beyond the four-row window", () => {
  // Reconstruction: Fable's transcribed queue rows + our literal animated composer.
  const queued = readFileSync(new URL("./fixtures/codex-starfield/queued-working.ansi", import.meta.url), "utf8");
  expect(detectAgentState("codex", queued, "")).toEqual({ agentState: "working", reason: "screen_working" });
  const prompt = queued.indexOf(animated);
  const block = queued.slice(0, prompt);
  expect(detectAgentState("codex", queued.replace('    and new receipt', '    extra wrapped queue text\n'.repeat(12) + '    and new receipt'), "").agentState).toBe("working");
  expect(detectAgentState("codex", "• Messages to be submitted after next tool call\n" + animated, "")).toEqual({ agentState: "idle", reason: "prompt_idle" });
  expect(detectAgentState("codex", block + "An answer continued after this old queue.\n" + animated, "")).toEqual({ agentState: "idle", reason: "prompt_idle" });
  expect(detectAgentState("codex", "› human draft\n" + block, "").agentState).toBe("unknown");
});
