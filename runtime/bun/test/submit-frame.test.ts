import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { classifySubmitFrame, composerInput, cursorComposer, agyComposer, agyReprobeInputMatches, claudeWrappedControlMatches, claudeScrolledControlMatches } from "../src/submit-frame";
import { submitVerifyLocked, type PaneEffects } from "../src/courier";
import { classifyPane, toPaneBand, claudeBox } from "../src/pane-state";

const id = "courier-20260906T080300Z-b0957ae8155f";
const wire = `[[TAP v0.23 note ${id} digest]]`;
function frame(input: string, width = 69, cue = ""): string {
  const lines: string[] = [];
  for (let i = 0; i < input.length; i += width - 2) lines.push(input.slice(i, i + width - 2));
  return `Worked for 1m 02s\n\n› ${lines.join("\n  ")}\n\n${cue}\ngpt-6-astra high · Context 90% left · /tmp\n`;
}
for (const width of [50, 57, 69, 140]) {
  test(`native classifies wrapped whole digest at ${width}`, () => {
    expect(classifySubmitFrame(frame(wire, width), "codex", wire, String(width)).state).toBe("staged");
    expect(classifySubmitFrame(frame(wire + " human draft", width), "codex", wire).state).toBe("staged");
    expect(classifySubmitFrame(frame("", width), "codex", wire).state).toBe("empty");
  });
}
test("mid-turn cue is staged, never evidence of submitted input", () => {
  expect(classifySubmitFrame(frame(wire, 69, "  tab to queue message"), "codex", wire)).toMatchObject({ state: "staged", mode: "mid-turn" });
  expect(classifySubmitFrame(`Transcript mentions tab to queue message\n${frame(wire)}`, "codex", wire).mode).toBe("idle");
});
for (const acceptedAt of [1, 2, 4, 99]) {
  test(`native submission samples final frame, accepting at Enter ${acceptedAt}`, () => {
    let text = ""; let enters = 0;
    const waits: number[] = [];
    const fx: PaneEffects = {
      observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "codex" } as any),
      paneState: () => ({ state: "ready" }),
      injectText: (_, input) => { text = input; return true; },
      inputHasId: () => text.includes(id),
      pressEnter: () => { enters++; if (enters >= acceptedAt) text = ""; return true; },
      settle: seconds => { waits.push(seconds); },
      submitFrame: () => classifySubmitFrame(frame(text), "codex", wire, "69"),
    };
    const result = submitVerifyLocked("%1", id, wire, undefined, fx);
    expect(result.status).toBe(acceptedAt === 99 ? "unverified" : "injected");
    expect(enters).toBe(Math.min(4, acceptedAt) + 1);
    expect(waits).toEqual([...([0.5, 0.5, 0.5, 1.5].slice(0, Math.min(4, acceptedAt))), 0.15]);
    if (result.status === "unverified") expect(result.detail).toBe("staged, idle, width 69");
  });
}
for (const after of ["human draft", "capture failed"]) {
  test(`native preserves ${after} after first Enter`, () => {
    let text = ""; let enters = 0;
    const fx: PaneEffects = {
      observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "codex" } as any),
      paneState: () => text === after ? (after === "capture failed" ? { state: "unobservable", reason: "capture failed" } : { state: "busy", text }) : { state: "ready" },
      injectText: (_, input) => { text = input; return true; },
      inputHasId: () => text.includes(id),
      pressEnter: () => { enters++; text = after; return true; },
      settle: () => {},
      submitFrame: () => classifySubmitFrame(after === "capture failed" && enters ? "" : frame(text), "codex", wire),
    };
    expect(submitVerifyLocked("%1", id, wire, undefined, fx).status).toBe("unverified");
    expect(enters).toBe(1);
    expect(text).toBe(after);
  });
}
for (const acceptedAt of [1, 4, 99]) {
  test(`mid-turn Codex uses Enter and verifies composer transition: ${acceptedAt}`, () => {
    let text = ""; let enters = 0;
    const fx: PaneEffects = {
      observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "codex" } as any),
      paneState: () => ({ state: "ready" }),
      injectText: (_, input) => { text = input; return true; },
      inputHasId: () => text.includes(id),
      pressEnter: () => { enters++; if (enters >= acceptedAt) text = ""; return true; },
      settle: () => {},
      submitFrame: () => classifySubmitFrame(frame(text, 69, "tab to queue message"), "codex", wire, "69"),
    };
    const result = submitVerifyLocked("%1", id, wire, undefined, fx);
    expect(result.status).toBe(acceptedAt === 99 ? "unverified" : "injected");
    expect(enters).toBe(Math.min(acceptedAt, 4) + 1);
    if (result.status === "unverified") expect(result.detail).toBe("staged, mid-turn, width 69");
  });
}
for (const lingering of [false, true]) {
  test(`new Working frame only accepts when sentinel is no longer visible: lingering=${lingering}`, () => {
    let entered = false;
    const fx: PaneEffects = {
      observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "codex" } as any),
      paneState: () => ({ state: "ready" }), injectText: () => true, inputHasId: () => true,
      pressEnter: () => { entered = true; return true; }, settle: () => {},
      submitFrame: () => classifySubmitFrame(entered ? `• Working (1s • esc to interrupt)\n${lingering ? wire : ""}` : frame(wire), "codex", wire),
    };
    expect(submitVerifyLocked("%1", id, wire, undefined, fx).status).toBe(lingering ? "unverified" : "injected");
  });
}
for (const dim of [true, false]) {
  test(`post-Enter placeholder is empty only with dim paint: dim=${dim}`, () => {
    let entered = false;
    const hint = dim ? "\x1b[2mAsk Codex to do anything\x1b[0m" : "Ask Codex to do anything";
    const fx: PaneEffects = {
      observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "codex" } as any),
      paneState: () => ({ state: "ready" }), injectText: () => true, inputHasId: () => true,
      pressEnter: () => { entered = true; return true; }, settle: () => {},
      submitFrame: () => classifySubmitFrame(frame(entered ? hint : wire), "codex", wire),
    };
    expect(submitVerifyLocked("%1", id, wire, undefined, fx).status).toBe(dim ? "injected" : "unverified");
  });
}


for (const width of [50, 69, 140]) {
  for (const tag of ["urgent", "escalate", "escalate urgent", "urgent agent-interrupt", "escalate urgent agent-interrupt"]) {
    test(`wrapped ${tag} wire uses complete-text containment at ${width}`, () => {
      const tagged = `[[TAP v0.23 note ArchitectureAudit/${id} ${tag}]]`;
      const capture = frame(tagged, width);
      expect(classifySubmitFrame(capture, "codex", tagged).state).toBe("staged");
      expect(classifySubmitFrame(frame(tagged + " human draft", width), "codex", tagged).state).toBe("staged");
    });
  }
}

test("expected wire text tolerates wrapping without interpreting its tags", () => {
  for (const tag of ["invented", "urgent digest"]) {
    const other = `[[TAP v0.23 note ArchitectureAudit/${id} ${tag}]]`;
    expect(classifySubmitFrame(frame(other, 50), "codex", other).state).toBe("staged");
  }
});

test("Cursor active bordered composer ignores tint, not draft or queue text", () => {
  const raw = readFileSync(new URL("../../../skills/tap/scripts/smoke/fixtures/submit-verify/cursor-red-box.ansi", import.meta.url), "utf8");
  expect(cursorComposer(raw)).toBe("");
  expect(classifySubmitFrame(raw, "cursor", wire).state).toBe("empty");
  const staged = raw.split("\n").map(line => line.includes("→") ? ` \x1b[48;2;119;15;15m→ ${wire}\x1b[0m` : line).join("\n");
  expect(classifySubmitFrame(staged, "cursor", wire).state).toBe("staged");
  expect(classifySubmitFrame(staged.replaceAll("119;15;15", "32;32;32"), "cursor", wire).state).toBe("staged");
  // tap-maavp effect 2: foreign bytes inside a readable bounded composer are the
  // recipient's own input — flagged fused, never promoted to staged. This
  // supersedes the earlier tolerance here and only here.
  expect(classifySubmitFrame(staged.replace(wire, wire + " human draft"), "cursor", wire))
    .toMatchObject({ state: "changed", fused: true });
  expect(classifySubmitFrame(staged.split("\n").filter(line => !line.includes("▀▀▀▀▀▀▀▀▀▀")).join("\n"), "cursor", wire).state).toBe("staged");
  expect(cursorComposer(staged + "\n▄▄▄▄▄▄▄▄▄▄▄▄\n→ new unfinished composer")).toBeNull();
  const placeholderDraft = staged.replace(wire, "Add a follow-up");
  expect(cursorComposer(placeholderDraft)).toBe("Add a follow-up");
});

test("Claude captured queue transition is an accepted harness queue", () => {
  const load = (name: string) => readFileSync(new URL(`../../../skills/tap/scripts/smoke/fixtures/submit-verify/${name}.ansi`, import.meta.url), "utf8");
  const expected = "[[TAP v0.23 note willow-sentinel-test-20260906T144128Z-d26c789b3cec]]";
  expect(classifySubmitFrame(load("claude-queue-before"), "claude", expected).state).toBe("staged");
  expect(classifySubmitFrame(load("claude-queue-after"), "claude", expected).state).toBe("queued");
});
test("foreign bytes fused inside a bounded composer are flagged, not promoted", () => {
  const load = (name: string) => readFileSync(new URL(`../../../skills/tap/scripts/smoke/fixtures/submit-verify/${name}.ansi`, import.meta.url), "utf8");
  const expected = "[[TAP v0.23 note willow-sentinel-test-20260906T144128Z-d26c789b3cec]]";
  const fused = load("claude-queue-before").replace(expected, `BUG${expected}`);
  expect(classifySubmitFrame(fused, "claude", expected)).toMatchObject({ state: "changed", fused: true });
});
test("native owned Enter accepts Claude queue then sends the completion Enter", () => {
  const load = (name: string) => readFileSync(new URL(`../../../skills/tap/scripts/smoke/fixtures/submit-verify/${name}.ansi`, import.meta.url), "utf8");
  const expected = "[[TAP v0.23 note willow-sentinel-test-20260906T144128Z-d26c789b3cec]]";
  const queuedId = "willow-sentinel-test-20260906T144128Z-d26c789b3cec";
  let enters = 0;
  const fx: PaneEffects = {
    observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "claude" } as any),
    paneState: () => ({ state: "ready" }), injectText: () => true, inputHasId: () => true,
    pressEnter: () => { enters++; return true; }, settle: () => {},
    submitFrame: () => classifySubmitFrame(load(enters ? "claude-queue-after" : "claude-queue-before"), "claude", expected),
  };
  expect(submitVerifyLocked("%1", queuedId, expected, undefined, fx)).toEqual({ status: "harness_queued" });
  expect(enters).toBe(2);
});

const claudeQueuedFixture = (name: string) => readFileSync(new URL(`../../../skills/tap/scripts/smoke/fixtures/submit-verify/${name}.ansi`, import.meta.url), "utf8");
const lunaWire = '[[TAP v0.23 note lime-conductor-20260918T085028Z-f75f1bd3af66 preview="Correction to my custody update: Astra independently verified all four SuiteSplit4 compute jobs are terminal/pass; they"]]';
test("Claude queued row over a live draft accepts without working chrome", () => {
  const capture = claudeQueuedFixture("claude-queued-live-draft-claudebar");
  expect(classifySubmitFrame(capture, "claude", lunaWire, "238")).toMatchObject({ state: "queued", mode: "working" });
  const fused = capture.replace("\u00A0\x1b[39mCom", `\u00A0\x1b[39m${lunaWire} own note`);
  expect(classifySubmitFrame(fused, "claude", lunaWire, "238")).toMatchObject({ state: "changed", fused: true });
  const transcript = capture.replace("\n  \x1b[38;2;80;80;80m\x1b[48;2;55;55;55m❯", "\n\x1b[38;2;80;80;80m\x1b[48;2;55;55;55m❯");
  expect(transcript).not.toBe(capture);
  expect(classifySubmitFrame(transcript, "claude", lunaWire, "238").state).toBe("changed");
});
test("native owned Enter accepts Claude queued row over a live draft", () => {
  const after = claudeQueuedFixture("claude-queued-live-draft-claudebar");
  const staged = after.replace("\u00A0\x1b[39mCom", `\u00A0\x1b[39m${lunaWire}`);
  let enters = 0;
  const fx: PaneEffects = {
    observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "claude" } as any),
    paneState: () => enters ? toPaneBand(classifyPane(after, "claude", false)) : { state: "ready" }, injectText: () => true, inputHasId: () => true,
    pressEnter: () => { enters++; return true; }, settle: () => {},
    submitFrame: () => classifySubmitFrame(enters ? after : staged, "claude", lunaWire),
  };
  expect(submitVerifyLocked("%1", "lime-conductor-20260918T085028Z-f75f1bd3af66", lunaWire, undefined, fx)).toEqual({ status: "harness_queued", preBusy: true }); // the capture's live spinner (tap-7txco)
  expect(enters).toBe(1);
});
test("preexisting Claude queued row is refused at the public pane-state gate", () => {
  const preexisting = claudeQueuedFixture("claude-queued-live-draft-claudebar");
  let injects = 0, enters = 0;
  const fx: PaneEffects = {
    observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "claude" } as any),
    // The real band derivation for this frame: the live human draft in the
    // bounded composer reads as busy, which must refuse the attempt before
    // any pane effect — a preexisting queue is not THIS attempt's acceptance.
    paneState: () => toPaneBand(classifyPane(preexisting, "claude", false)),
    injectText: () => { injects++; return true; }, inputHasId: () => true,
    pressEnter: () => { enters++; return true; }, settle: () => {},
    submitFrame: () => classifySubmitFrame(preexisting, "claude", lunaWire),
  };
  const result = submitVerifyLocked("%1", "lime-conductor-20260918T085028Z-f75f1bd3af66", lunaWire, undefined, fx);
  expect(result).toMatchObject({ status: "band_busy", bandState: "busy" });
  expect(injects).toBe(0);
  expect(enters).toBe(0);
});

const agyFixture = (name: string) => readFileSync(new URL(`../../../skills/tap/scripts/smoke/fixtures/agy-capture-20260906/${name}.ansi`, import.meta.url), "utf8");
for (const name of ["generating-50x45", "generating-69x45", "generating-140x45", "generating-taskcard-69x45", "idle-69x45", "idle-notask-69x45", "draft-69x45"]) {
  test(`Antigravity bounded native composer: ${name}`, () => {
    const capture = agyFixture(name);
    const expected = name.startsWith("draft") ? "test staged draft in agy composer" + " ".repeat(34) : "";
    expect(agyComposer(capture)).toBe(expected);
    expect(classifySubmitFrame(capture, "agy", wire).state).toBe(expected ? "changed" : "empty");
  });
}
test("Antigravity reprobe equality removes renderer whitespace but rejects edits", () => {
  const expected = "test staged draft in agy composer";
  const padded = agyComposer(agyFixture("draft-69x45"));
  expect(padded).not.toBeNull();
  expect(agyReprobeInputMatches(padded!, expected)).toBe(true);
  expect(agyReprobeInputMatches(`${expected.slice(0, 10)}\n  ${expected.slice(10)}`, expected)).toBe(true);
  expect(agyReprobeInputMatches(`${padded} human edit`, expected)).toBe(false);
  expect(agyReprobeInputMatches("test staged note in agy composer", expected)).toBe(false);
});
test("Antigravity meaningful multiline whitespace survives; missing band refuses", () => {
  const rule = "─".repeat(50);
  const capture = `${rule}\n>   indented  \n  continuation  \n\n${rule}\nesc to cancel`;
  expect(agyComposer(capture)).toBe("  indented  \n  continuation  ");
  expect(agyComposer("Generating...\n> \nesc to cancel")).toBeNull();
});
test("Antigravity generating task-card transition accepts and completes with one additional Enter", () => {
  const empty = agyFixture("generating-taskcard-69x45");
  const staged = empty.replace(/(^[^\n]*>)[^\n]*$/m, `$1 ${wire}`);
  let enters = 0;
  const fx: PaneEffects = {
    observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "agy" } as any),
    paneState: () => ({ state: "ready" }), injectText: () => true, inputHasId: () => true,
    pressEnter: () => { enters++; return true; }, settle: () => {},
    submitFrame: () => classifySubmitFrame(enters ? empty : staged, "agy", wire),
  };
  expect(submitVerifyLocked("%1", id, wire, undefined, fx).status).toBe("injected");
  expect(enters).toBe(2);
});

test("Claude saved control wraps match exact staged bytes, not changed drafts", () => {
  const path = "../../../skills/tap/scripts/smoke/fixtures/submit-verify/";
  const expected = readFileSync(new URL(path + "claude-control-wrap-expected.txt", import.meta.url), "utf8");
  for (const mode of ["joined", "physical"]) {
    const capture = readFileSync(new URL(path + `claude-control-wrap-${mode}.ansi`, import.meta.url), "utf8");
    expect(classifySubmitFrame(capture, "claude", expected).state).toBe("staged");
    expect(claudeWrappedControlMatches(capture.replaceAll("─".repeat(69), "─".repeat(80)), expected)).toBe(false);
    expect(classifySubmitFrame(capture.replace("never marks read", "ever marks read"), "claude", expected).state).toBe("changed");
    expect(classifySubmitFrame(capture.replace("preserve the", "preservethe"), "claude", expected).state).toBe("changed");
  }
  const rule = "─".repeat(69);
  const shortSplit = `${rule}\n❯ /compact first\n  second [[sv:short]]\n${rule}`;
  expect(claudeWrappedControlMatches(shortSplit, "/compact first second [[sv:short]]")).toBe(false);
  expect(claudeWrappedControlMatches(shortSplit, "/compact first\nsecond [[sv:short]]")).toBe(false);
  expect(claudeWrappedControlMatches(shortSplit, "/compact first  second [[sv:short]]")).toBe(false);
});

// tap-ho6pk: a fast-start OpenCode delivery (empty composer, our wire the latest
// user turn, spinner running because OUR Enter started the turn) classifies
// queued and is receipted harness_queued, undercounting first-try injection.
// The discriminator is the seat's busy evidence at this submit's earliest
// (landing) read: an idle seat refutes "queued behind an earlier turn". Both
// captures below are real (OpenCode 1.17.13).
const opencodeIdle = readFileSync(new URL("../../../skills/tap/scripts/smoke/fixtures/peek-harness-adapters/opencode-wide-idle.ansi", import.meta.url), "utf8");
const opencodeWorking = readFileSync(new URL("../../../skills/tap/scripts/smoke/fixtures/peek-harness-adapters/opencode-wide-working.ansi", import.meta.url), "utf8");
const opencodeId = "queued-label-20260924T120000Z-0123456789ab";
const opencodeWire = `[[TAP v0.23 note ${opencodeId}]]`;
const opencodeStaged = (capture: string) => {
  const lines = capture.split("\n");
  const footer = lines.findIndex((line) => /┃\s*Build ·/.test(line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")));
  expect(footer).toBeGreaterThan(0);
  lines.splice(footer, 0, `  ┃  ${opencodeWire}`);
  return lines.join("\n");
};
const opencodeAccepted = (capture: string) => {
  const lines = capture.split("\n");
  const at = lines.findIndex((line) => line.includes("TAP v=0.3"));
  expect(at).toBeGreaterThan(0);
  let end = at;
  while (!lines[end]!.includes(".md]]")) end++;
  lines.splice(at, end - at + 1, `  ┃  ${opencodeWire}`);
  return lines.join("\n");
};
function opencodeFx(script: Array<"idle-staged" | "working-staged" | "accepted-working">): PaneEffects {
  const frameFor = (kind: (typeof script)[number]) =>
    kind === "idle-staged" ? opencodeStaged(opencodeIdle)
      : kind === "working-staged" ? opencodeStaged(opencodeWorking)
      : opencodeAccepted(opencodeWorking);
  return {
    observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "opencode" } as any),
    harnessEvidence: () => "alive",
    paneState: () => ({ state: "ready" }), injectText: () => true, inputHasId: () => true,
    pressEnter: () => true, settle: () => {},
    submitFrame: () => classifySubmitFrame(frameFor(script.shift()!), "opencode", opencodeWire),
  };
}
test("OpenCode frames carry busy pre-state evidence; the generic queue verdict is tagged inferred", () => {
  expect(classifySubmitFrame(opencodeStaged(opencodeIdle), "opencode", opencodeWire)).toMatchObject({ state: "staged", busy: false });
  expect(classifySubmitFrame(opencodeStaged(opencodeWorking), "opencode", opencodeWire)).toMatchObject({ state: "staged", busy: true });
  expect(classifySubmitFrame(opencodeAccepted(opencodeWorking), "opencode", opencodeWire))
    .toMatchObject({ state: "queued", mode: "working", inferred: true, busy: true });
});
test("OpenCode frames with no readable state chrome carry no busy evidence: unknown is not idle", () => {
  // A transient render (readable composer, no idle/working chrome) must not
  // seed the fast-start discriminator with observed-idle evidence.
  const bare = opencodeIdle.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace("ctrl+p commands", "commands");
  const verdict = classifySubmitFrame(opencodeStaged(bare), "opencode", opencodeWire);
  expect(verdict).toMatchObject({ state: "staged" });
  expect(verdict.busy).toBeUndefined();
});
test("an OpenCode command spelled with a path or case reads like the bare name", () => {
  const frame = opencodeStaged(opencodeIdle);
  const bare = classifySubmitFrame(frame, "opencode", opencodeWire);
  expect(bare).toMatchObject({ state: "staged", busy: false });
  for (const spelling of ["/usr/local/bin/opencode", "OpenCode"]) {
    expect(classifySubmitFrame(frame, spelling, opencodeWire)).toEqual(bare);
    expect(composerInput(frame, spelling)).toEqual(composerInput(frame, "opencode"));
  }
});
test("Claude queue-row geometry stays positive proof: queued, never tagged inferred", () => {
  const expected = "[[TAP v0.23 note willow-sentinel-test-20260906T144128Z-d26c789b3cec]]";
  const verdict = classifySubmitFrame(claudeQueuedFixture("claude-queue-after"), "claude", expected);
  expect(verdict).toMatchObject({ state: "queued" });
  expect(verdict).not.toHaveProperty("inferred");
});
// tap-7txco: once the shared classifier reads Claude's live spinner, the
// generic arm sees "empty composer + our wire in the transcript + working"
// right after an ordinary Enter. Claude frames therefore carry the same busy
// pre-state evidence, so a fast start from an idle seat stays `injected`.
const claudeRule = "─".repeat(110);
const claudeId = "fast-start-20261001T120000Z-0123456789ab";
const claudeWire = `[[TAP v0.23 note ${claudeId}]]`;
const claudeFrame = (status: string, composer: string, transcript = "⏺ earlier reply") => [
  // Live Claude paints an empty composer as `❯` + NBSP.
  transcript, "", status, "", claudeRule, composer ? `❯ ${composer}` : "❯\u00a0", claudeRule,
  "  Opus 5.5 high | 28% 119k/420k | 📁 tap | 🌿 main",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 3 agents",
].join("\n");
const CLAUDE_DONE = "✻ Brewed for 35s · done 10:58 PM";
const CLAUDE_SPINNING = "✽ Combobulating… (3s · ↓ 1.2k tokens)";
function claudeFx(script: Array<"idle-staged" | "working-staged" | "accepted-working">): PaneEffects {
  const frameFor = (kind: (typeof script)[number]) =>
    kind === "idle-staged" ? claudeFrame(CLAUDE_DONE, claudeWire)
      : kind === "working-staged" ? claudeFrame(CLAUDE_SPINNING, claudeWire)
      : claudeFrame(CLAUDE_SPINNING, "", `❯ ${claudeWire}`);
  return {
    observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "claude" } as any),
    harnessEvidence: () => "alive",
    paneState: () => ({ state: "ready" }), injectText: () => true, inputHasId: () => true,
    pressEnter: () => true, settle: () => {},
    submitFrame: () => classifySubmitFrame(frameFor(script.shift()!), "claude", claudeWire),
  };
}
test("Claude frames carry busy pre-state evidence from the live spinner (tap-7txco)", () => {
  expect(classifySubmitFrame(claudeFrame(CLAUDE_DONE, claudeWire), "claude", claudeWire)).toMatchObject({ state: "staged", busy: false });
  expect(classifySubmitFrame(claudeFrame(CLAUDE_SPINNING, claudeWire), "claude", claudeWire)).toMatchObject({ state: "staged", busy: true });
  expect(classifySubmitFrame(claudeFrame(CLAUDE_SPINNING, "", `❯ ${claudeWire}`), "claude", claudeWire))
    .toMatchObject({ state: "queued", mode: "working", inferred: true, busy: true });
});
test("Claude fast-start acceptance from an idle seat is injected, not harness_queued (tap-7txco)", () => {
  expect(submitVerifyLocked("%1", claudeId, claudeWire,
    { paneId: "%1", harness: "claude", serverEpoch: "srv:1:1" }, claudeFx(["idle-staged", "accepted-working"])).status).toBe("injected");
});
test("a Claude follow-up to a seat already mid-turn stays harness_queued (tap-7txco)", () => {
  expect(submitVerifyLocked("%1", claudeId, claudeWire,
    { paneId: "%1", harness: "claude", serverEpoch: "srv:1:1" }, claudeFx(["working-staged", "accepted-working"])).status).toBe("harness_queued");
});
test("OpenCode fast-start acceptance from an idle seat is injected, not harness_queued", () => {
  expect(submitVerifyLocked("%1", opencodeId, opencodeWire,
    { paneId: "%1", harness: "opencode", serverEpoch: "srv:1:1" }, opencodeFx(["idle-staged", "accepted-working"])).status).toBe("injected");
});
test("OpenCode late acceptance (consumed by the next pre-Enter read) is injected", () => {
  expect(submitVerifyLocked("%1", opencodeId, opencodeWire,
    { paneId: "%1", harness: "opencode", serverEpoch: "srv:1:1" }, opencodeFx(["idle-staged", "idle-staged", "accepted-working"])).status).toBe("injected");
});
test("OpenCode follow-up to an already-working seat stays harness_queued", () => {
  expect(submitVerifyLocked("%1", opencodeId, opencodeWire,
    { paneId: "%1", harness: "opencode", serverEpoch: "srv:1:1" }, opencodeFx(["working-staged", "accepted-working"])).status).toBe("harness_queued");
});

// tap-vho8h: Claude's composer is a viewport of pane height minus ~15 rows. A
// typed /compact whose focus wraps past it scrolls the command row away and
// keeps the prompt glyph on the first VISIBLE row, so the whole-frame match
// reads "changed" and the worker withholds Enter. The typed-prefix arm opts in
// to a marker-anchored suffix proof; every other caller keeps the whole rule.
test("Claude scrolled /compact control: suffix proof is opt-in, anchored at the marker, exact", () => {
  const path = "../../../skills/tap/scripts/smoke/fixtures/submit-verify/";
  const load = (name: string) => readFileSync(new URL(path + name, import.meta.url), "utf8");
  const cases = [["claude-compact-scrolled-52x40", "52"], ["claude-compact-scrolled-170x20", "170"]] as const;
  for (const [name, width] of cases) {
    const frame = load(`${name}.ansi`), expected = load(`${name}-expected.txt`).replace(/\n$/, "");
    // The live specimens: the old verdict, the withhold.
    expect(classifySubmitFrame(frame, "claude", expected, width, true, false)).toMatchObject({ state: "changed" });
    expect(claudeWrappedControlMatches(frame, expected)).toBe(false);
    // The opt-in verdict, labeled.
    expect(classifySubmitFrame(frame, "claude", expected, width, true, false, true)).toMatchObject({ state: "staged", scrolled: true });
    expect(claudeScrolledControlMatches(frame, expected)).toBe(true);
    // Another control's text with our marker tail: the visible rows are not slices of it.
    // (The edit must land in the VISIBLE suffix; the scrolled-off head is proven before the payload, never from this frame.)
    const other = expected.replaceAll("second guard", "second shield");
    expect(claudeBox(frame)!.typed).toContain("second");
    expect(classifySubmitFrame(frame, "claude", other, width, true, false, true).state).toBe("changed");
    // A wrong marker refuses; so does a /goal control (the proof is /compact-only).
    expect(claudeScrolledControlMatches(frame, expected.replace(/\[\[sv:[^\]]+\]\]$/, "[[sv:self-elsewhere]]"))).toBe(false);
    expect(claudeScrolledControlMatches(frame, expected.replace(/^\/compact /, "/goal "))).toBe(false);
    // Human prose typed over the first visible row: not an exact slice, refused.
    const box = claudeBox(frame)!;
    const firstRow = box.typed.split("\n")[0]!;
    const edited = frame.replace(firstRow, "please also remember " + firstRow.slice(21));
    expect(claudeBox(edited)!.typed.startsWith("please also")).toBe(true);
    expect(claudeScrolledControlMatches(edited, expected)).toBe(false);
    expect(classifySubmitFrame(edited, "claude", expected, width, true, false, true).state).toBe("changed");
    // A wider box than the pane that rendered these rows is a different wrap: refused.
    expect(claudeScrolledControlMatches(frame.replaceAll("─".repeat(Number(width)), "─".repeat(Number(width) + 30)), expected)).toBe(false);
  }
  // The same pane one focus size smaller: the head is visible and the whole match owns it.
  const un = load("claude-compact-unscrolled-52x40.ansi"), unExpected = load("claude-compact-unscrolled-52x40-expected.txt").replace(/\n$/, "");
  expect(claudeBox(un)!.typed.startsWith("/compact ")).toBe(true);
  expect(classifySubmitFrame(un, "claude", unExpected, "52", true, false)).toMatchObject({ state: "staged" });
  const optIn = classifySubmitFrame(un, "claude", unExpected, "52", true, false, true);
  expect(optIn.state).toBe("staged");
  expect(optIn.scrolled).toBeUndefined();
  expect(claudeScrolledControlMatches(un, unExpected)).toBe(false);
});
