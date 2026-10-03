// tap-lmbs: a slash command is typed as its own keystrokes, then its payload
// arrives in small chunks and must render in full before Enter. A paste chip is
// a refusal, and a control that never submitted is taken back while it is ours.
import { expect, test } from "bun:test";
import { submitVerifyLocked, type PaneEffects } from "../src/courier";
import { permittedTakeBack, type PaneEffects as DeliverEffects } from "../src/deliver";
import { readFileSync } from "node:fs";
import { classifySubmitFrame, type SubmitFrame } from "../src/submit-frame";

const bound = { paneId: "%7", harness: "claude", serverEpoch: "srv:1:1" };
const payload = "carry the plan and the verdicts " + "x".repeat(600) + " [[sv:self-20260923T000000Z-abcd1234]]";

interface Options {
  /** The composer drops the prefix keystrokes. */ dropPrefix?: boolean;
  /** A wrapped draft sits on a continuation row. */ continuation?: string;
  /** The payload collapses into a paste chip. */ chip?: boolean;
  /** The frame the Enter loop sees in place of the staged control. */ frameState?: SubmitFrame["state"];
  /** Text a human types once the Enter loop is reading frames. */ foreign?: string;
}

function claudePane(options: Options = {}) {
  let buffer = "", looped = false;
  const injects: string[] = [], effects: string[] = [];
  const rendered = () => options.chip && buffer.length > 16 ? "/goal [Pasted text #1 +3 lines]" : buffer + (looped && options.foreign ? options.foreign : "");
  const frame = (state: SubmitFrame["state"]): SubmitFrame => ({ state, mode: "idle", width: "120" });
  const fx: DeliverEffects = {
    observePane: () => ({ paneId: "%7", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "claude" } as any),
    harnessEvidence: () => "alive",
    paneState: () => rendered() ? { state: "busy", text: rendered() } : { state: "ready" },
    injectText: (_target, text) => {
      injects.push(text);
      if (!(options.dropPrefix && injects.length === 1)) buffer += text;
      return true;
    },
    inputHasId: () => false,
    pressEnter: () => { effects.push("Enter"); buffer = ""; return true; },
    settle: () => {},
    submitFrame: (_target, _command, expected) => (looped = true) && !rendered() ? frame("empty")
      : options.frameState ? frame(options.frameState) : rendered() === expected ? frame("staged") : frame("changed"),
    // Bash's prompt-line reader trims exactly one trailing space.
    promptInput: () => ({ status: "text", text: rendered().split("\n", 1)[0]!.replace(/ $/, "") }),
    regionInput: () => ({ status: "text", text: rendered() + (options.continuation ? `\n${options.continuation}` : "") }),
    clearInput: () => { effects.push("C-u"); buffer = ""; return true; },
  };
  fx.takeBack = permittedTakeBack(fx);
  return { fx: fx as PaneEffects, injects, effects };
}

const submit = (pane: ReturnType<typeof claudePane>, typedPrefix = "/goal ", extra: object = {}) =>
  submitVerifyLocked("%7", "self-20260923T000000Z-abcd1234", payload, bound, pane.fx,
    { registryPath: "", scriptsDir: "", agentFamilies: new Set(["claude"]), typedPrefix, ...extra });

test("a prefix with an argument (/loop 5m ) is still one keystroke stage", () => {
  const pane = claudePane();
  expect(submit(pane, "/loop 5m ").status).toBe("injected");
  expect(pane.injects[0]).toBe("/loop 5m ");
  expect(pane.effects).toEqual(["Enter"]);
});

test("(a) the prefix is its own keystrokes and the payload arrives in chunks of at most 250 bytes", () => {
  const pane = claudePane();
  expect(submit(pane).status).toBe("injected");
  expect(pane.injects[0]).toBe("/goal ");
  const chunks = pane.injects.slice(1);
  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(250);
  expect(chunks.join("")).toBe(payload);
  expect(pane.effects).toEqual(["Enter"]);
});

test("(b) a paste chip is a refusal, never landing evidence: zero Enters", () => {
  const pane = claudePane({ chip: true });
  const result = submit(pane);
  expect(result.status).toBe("unverified");
  // The chip is refused at the first chunk read-back; the tail check is the last line of defense.
  expect("detail" in result ? result.detail : "").toMatch(/did not render contiguously|control tail absent\/opaque/);
  expect(pane.effects).not.toContain("Enter");
});

test("(c) a prefix that did not render stops before any payload", () => {
  const pane = claudePane({ dropPrefix: true });
  const result = submit(pane);
  expect(result.status).toBe("unverified");
  expect("detail" in result ? result.detail : "").toContain("typed prefix did not render");
  expect(pane.injects).toEqual(["/goal "]);
  expect(pane.effects).toEqual([]);
});

test("(c) a wrapped draft on a continuation row stops before any payload", () => {
  const pane = claudePane({ continuation: "LEFTOVER-DRAFT-TEXT" });
  const result = submit(pane);
  expect(result.status).toBe("unverified");
  expect("detail" in result ? result.detail : "").toContain("past the typed prefix");
  expect(pane.injects).toEqual(["/goal "]);
});

test("a malformed or incompatible prefix is refused before any keystroke", () => {
  for (const [prefix, extra] of [["/goal", {}], ["/goal  ", {}], ["/goal ", { singleEnter: true }], ["/goal ", { noPromptOk: true }]] as const) {
    const pane = claudePane();
    expect(submit(pane, prefix, extra).status).toBe("unverified");
    expect(pane.injects).toEqual([]);
  }
});

test("(h) a control withheld before Enter is taken back while the band is still ours", () => {
  const pane = claudePane({ frameState: "changed" });
  const result = submit(pane);
  expect(result.status).toBe("unverified");
  expect("detail" in result ? result.detail : "").toContain("take-back: cleared");
  expect(pane.effects).toEqual(["C-u"]);
});

test("(h) a band holding more than our control is never cleared", () => {
  const pane = claudePane({ frameState: "changed", foreign: " and a human's words" });
  const result = submit(pane);
  expect(result.status).toBe("unverified");
  expect("detail" in result ? result.detail : "").toContain("take-back: foreign");
  expect(pane.effects).toEqual([]);
});

// tap-eynht: a seat compacting ITSELF mid-turn. The frame is nightwatch's real
// refused self compact (17:21Z, 2026-09-23): Claude's spinner and a running
// shell tool repaint above the composer while the control waits for Enter. The
// spinner word, elapsed time and token count change between samples; none of
// that is the composer, so every repaint must still read as our staged control.
const fixture = "../../../skills/tap/scripts/smoke/fixtures/submit-verify/claude-control-wrap-20260923";
const liveFrame = readFileSync(new URL(fixture + ".ansi", import.meta.url), "utf8");
const liveControl = readFileSync(new URL(fixture + "-expected.txt", import.meta.url), "utf8");
const repaints = [
  liveFrame,
  liveFrame.replace("\x1b[38;2;255;153;51m✽", "\x1b[38;2;255;153;51m✻").replace("(19s · ↓", "(20s · ↓"),
  liveFrame.replace("Catapulting…", "Pondering…").replace("(19s · ↓", "(21s · ↑"),
  liveFrame.replace("in fligh… (8s)", "in fligh… (9s)"),
  liveFrame.replace("62%\x1b[32m↯\x1b[38;2;153;153;153m 264k/420k", "63%\x1b[32m↯\x1b[38;2;153;153;153m 265k/420k"),
];

test("tap-eynht control: a repainting spinner and status band never read as a changed composer", () => {
  expect(new Set(repaints).size).toBe(repaints.length);
  for (const frame of repaints) expect(classifySubmitFrame(frame, "claude", liveControl, "145", true).state).toBe("staged");
});

test("tap-eynht control: a self-target mid-turn submits its typed /compact with one Enter", () => {
  const prefix = "/compact ";
  expect(liveControl.startsWith(prefix)).toBe(true);
  let buffer = "", samples = 0, submitted = false;
  const effects: string[] = [];
  const fx: DeliverEffects = {
    observePane: () => ({ paneId: "%614", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "claude" } as any),
    harnessEvidence: () => "alive",
    paneState: () => buffer ? { state: "busy", text: buffer } : { state: "ready" },
    injectText: (_target, text) => { buffer += text; return true; },
    inputHasId: () => false,
    pressEnter: () => { effects.push("Enter"); submitted = true; buffer = ""; return true; },
    settle: () => {},
    // Each Enter-loop sample sees the next repaint of the real working frame.
    submitFrame: (_target, command, expected) => submitted ? { state: "empty", mode: "working", width: "145" }
      : classifySubmitFrame(repaints[samples++ % repaints.length]!, command, expected, "145", true),
    promptInput: () => ({ status: "text", text: buffer.replace(/ $/, "") }),
    regionInput: () => ({ status: "text", text: buffer }),
    clearInput: () => { effects.push("C-u"); buffer = ""; return true; },
  };
  fx.takeBack = permittedTakeBack(fx);
  const result = submitVerifyLocked("%614", "self-20260923T172121Z-cbe03497", liveControl.slice(prefix.length),
    { paneId: "%614", harness: "claude", serverEpoch: "srv:1:1" }, fx as PaneEffects,
    { registryPath: "", scriptsDir: "", agentFamilies: new Set(["claude"]), typedPrefix: prefix });
  expect(result.status).toBe("injected");
  expect(effects).toEqual(["Enter"]);
});

// P1/N1 (gate share of regress/claude-arg-hint): the render check reads the
// prompt line through pendingInputText. A truncated argument hint on a pane
// the full placeholder cannot fit is chrome (P1); the same bytes on a pane
// wide enough for the whole placeholder are not (N1), so a prefix check fails closed.
test("P1/N1: a 53-column truncated /compact hint reads as the typed prefix only at width 53", async () => {
  const { pendingInputText } = await import("../src/pane/reader");
  const bytes = readFileSync(new URL("../../../skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-hint-compact-truncated-53.ansi", import.meta.url), "utf8");
  const io = (width: string) => ({
    capture: (_t: string, escaped: boolean) => ({ code: 0, stdout: escaped ? bytes : bytes.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "") }),
    paneWidth: () => width,
  });
  expect(pendingInputText(io("53"), "%7", "claude")).toEqual({ status: "text", text: "/compact" });
  const wide = pendingInputText(io("80"), "%7", "claude");
  expect(wide.status === "text" && wide.text === "/compact").toBe(false);
});

test('a self compact echo after one possible Enter never retries or takes input back', () => {
  const pane = claudePane();
  pane.fx.submitFrame = () => ({ state: 'staged', mode: 'working', width: '120' });
  expect(submit(pane, '/compact ').status).toBe('unverified');
  expect(pane.effects).toEqual(['Enter']);
});

for (const frameState of ['changed', 'unobservable'] as const) {
  for (const foreign of [undefined, ' and a human draft']) {
    test(`an unverified compact ${frameState} preserves ${foreign ? 'mixed' : 'owned'} input`, () => {
      const pane = claudePane({ frameState, foreign });
      const result = submit(pane, '/compact ');
      expect(result.status).toBe('unverified');
      expect(pane.effects).toEqual([]);
      expect('detail' in result ? result.detail : '').toContain('stays in the composer');
      expect('detail' in result ? result.detail : '').toContain('press Enter there to submit it');
    });
  }
}

// tap-vho8h (Codex review): a scrolled viewport hides the head and
// middle at Enter time, so each chunk is proven as it lands. A middle chunk
// that never renders, while the tail does, must withhold Enter.
test('(g) a dropped middle chunk with a landed tail withholds Enter and leaves the text in place', () => {
  let buffer = '';
  const injects: string[] = [], effects: string[] = [];
  const fx: DeliverEffects = {
    observePane: () => ({ paneId: '%7', session: 'fixture', serverEpoch: 'srv:1:1', currentCommand: 'claude' } as any),
    harnessEvidence: () => 'alive',
    paneState: () => buffer ? { state: 'busy', text: buffer } : { state: 'ready' },
    injectText: (_target, text) => { injects.push(text); if (injects.length !== 3) buffer += text; return true; },
    inputHasId: () => false,
    pressEnter: () => { effects.push('Enter'); buffer = ''; return true; },
    settle: () => {},
    submitFrame: () => ({ state: 'staged', mode: 'idle', width: '120' }),
    promptInput: () => ({ status: 'text', text: buffer.split('\n', 1)[0]!.replace(/ $/, '') }),
    regionInput: () => ({ status: 'text', text: buffer }),
    clearInput: () => { effects.push('C-u'); buffer = ''; return true; },
  };
  const result = submitVerifyLocked('%7', 'self-20260923T000000Z-abcd1234', payload, bound, fx as PaneEffects,
    { registryPath: "", scriptsDir: '', agentFamilies: new Set(['claude']), typedPrefix: '/compact ' });
  // The chain stops at the chunk that never rendered: nothing after it is typed.
  expect(injects).toHaveLength(3);
  expect(buffer).toBe(injects[0]! + injects[1]!);
  expect(result.status).toBe('unverified');
  expect('detail' in result ? result.detail : '').toContain('control chunk 2/');
  expect('detail' in result ? result.detail : '').toContain('Enter withheld');
  expect(effects).toEqual([]);
});
