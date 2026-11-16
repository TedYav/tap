import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { submitStagedLocked, submitVerifyLocked, typedDeliveryWire, type PaneEffects } from "../src/courier";
import { classifySubmitFrame } from "../src/submit-frame";
import { claudeBox } from "../src/pane-state";
import { phaseRows } from "../src/submit-phase";
import { recordTypedWire, submittedWire, typedWires } from "../src/typed-wire";
import { removeScratchTree } from "./support/scratch";

// tap-1ncs6: a Claude seat in a narrow pane. The composer is a viewport of the
// last rows of the input (pane height minus about fifteen), so at 38 columns
// a delivered wire shows only its tail and the courier's id-anchored landing
// check reported "input did not land" with the wire in the composer and Enter
// withheld. The next delivery then read that tail as a human draft and
// cleared it. These drive the production submit loop over a Claude-shaped
// composer at 38 and at 79 columns.

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeScratchTree(root); });

const ID = "sample-review-coach-seat-20260101T010101Z-0123456789ab";
const WIRE = `[[TAP v0.23 note ${ID} preview="Thanks for the review pass; the narrow pane held only the scrolled tail, and a single Enter landed the whole wire"]]`;
const OLD_ID = "digest-seat-20260101T000000Z-0123456789ab";
const OLD_WIRE = `[[TAP v0.23 note ${OLD_ID} preview="Digest 4 for bob-seat: three landings since 20:05Z and one open review request from the merger seat"]]`;

// A Claude-shaped composer at `columns` showing only the last `viewport` rows
// of `text` (the same renderer as the tap-vho8h suite): greedy word wrap
// inside the box, long tokens hard-split at the full row, prompt glyph on the
// first visible row, bottom border after the last.
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
  return `✻ done\n\n${fence}\n❯ ${shown[0] ?? ""}\n${shown.slice(1).map(r => `  ${r}`).join("\n")}\n${border}\n  Sonnet 5 low | 39%\n`;
}

function seat(columns: number, viewport: number, initial = "") {
  const home = mkdtempSync(join(tmpdir(), "narrow-pane-")); roots.push(home);
  mkdirSync(join(home, "receipts"));
  let buffer = initial;
  const keys: string[] = [];
  const frame = () => claudeFrame(buffer, columns, viewport);
  // Rowless on purpose: this file characterizes the composer, not registry identity,
  // and a bound handle with no registry path is refused (that refusal is pinned in the courier tests).
  const bound = { paneId: "%7", serverEpoch: "srv:1:1", harness: "claude", handle: "", instance: "coach|A" };
  const fx: PaneEffects = {
    observePane: () => ({ paneId: "%7", session: "tap/coach", serverEpoch: "srv:1:1", currentCommand: "claude", panePid: "42" }),
    harnessEvidence: () => "alive",
    paneState: () => buffer ? { state: "busy", text: claudeBox(frame())!.typed } : { state: "ready" },
    copyMode: () => ({ status: "normal" }),
    injectText: (_target, text) => { keys.push(`type:${text}`); buffer += text; return true; },
    inputHasId: (_target, _command, id) => claudeBox(frame())!.typed.includes(id),
    pressEnter: () => { keys.push("Enter"); buffer = ""; return true; },
    settle: () => {},
    submitFrame: (_target, command, expected, alive) => classifySubmitFrame(frame(), command, expected, String(columns), alive),
    clobber: () => { throw new Error("a sentinel tail must never be backed up and cleared"); },
  };
  // Each seat keeps its own typed-wire record, so one test's wire is never another's evidence.
  const env: NodeJS.ProcessEnv = { ...process.env, TAP_INDEX_HOME: home };
  const authority = { busHome: home, recipient: "coach", registryPath: "", scriptsDir: "/unused", agentFamilies: new Set(["claude"]), preserveDraft: false, env };
  // What this seat's courier writes and reads typed-wire evidence under: its server generation and bus.
  const binding = { epoch: bound.serverEpoch, bus: home };
  return { home, fx, bound, authority, keys, env, binding, get buffer() { return buffer; }, frame,
    submit: () => submitVerifyLocked("tap/coach:0.0", ID, WIRE, bound, fx, authority) };
}

for (const [columns, viewport, scrolls] of [[38, 5, true], [79, 5, false]] as const) {
  test(`a fresh wire at ${columns} columns ${scrolls ? "shows only its tail and still" : "fits whole and"} submits with one Enter`, () => {
    const s = seat(columns, viewport);
    const result = s.submit();
    expect(result.status).toBe("injected");
    // One verified Enter, then the courier's ordinary completion Enter on the idle band.
    expect(s.keys).toEqual([`type:${WIRE}`, "Enter", "Enter"]);
    expect(s.buffer).toBe("");
    // What the composer showed before Enter: the head hidden at 38, whole at 79.
    const box = claudeBox(claudeFrame(WIRE, columns, viewport))!;
    expect(box.typed.startsWith("[[TAP")).toBe(!scrolls);
    expect(classifySubmitFrame(claudeFrame(WIRE, columns, viewport), "claude", WIRE, String(columns), true))
      .toMatchObject(scrolls ? { state: "staged", scrolled: true } : { state: "staged" });
    expect(phaseRows(s.home, ID).at(-1)).toMatchObject({ phase: "verify-result", result: "verified", enter_count: 2 });
    // The submission verified, so the wire is no longer evidence for anything in this composer:
    // its tail showing up later was recalled or pasted by someone, and is theirs.
    expect(typedWires("%7", s.binding, s.env)).toEqual([]);
  });
}

test("cascade: an old wire's scrolled tail the courier recorded typing gets Enter, never a backup and clear, then ours delivers", () => {
  // No payload, no receipt, no opener in frame: the pane's typed-wire record is the reason to press Enter.
  const s = seat(38, 5, OLD_WIRE);
  recordTypedWire("%7", s.binding, OLD_ID, OLD_WIRE, s.env);
  const typed = claudeBox(s.frame())!.typed;
  expect(typed.includes("[[TAP")).toBe(false);
  expect(typed.replace(/\s+/g, "").includes(OLD_ID.slice(-12))).toBe(true);
  const result = s.submit();
  expect(result.status).toBe("injected");
  // Enter for the old wire first (never a retype), then one injection and the
  // ordinary verified-plus-completion Enters for ours.
  expect(s.keys).toEqual(["Enter", `type:${WIRE}`, "Enter", "Enter"]);
  expect(existsSync(join(s.home, "input-backups"))).toBe(false);
  expect(phaseRows(s.home, ID).at(-1)).toMatchObject({ phase: "verify-result", result: "verified" });
});

test("cascade: a staged nudge doorbell is one whole well-formed wire and gets Enter before ours", () => {
  // The doorbell carries no id for the stuck-sentinel parser; its own grammar recognizes it whole.
  const s = seat(38, 5, "[[TAP v0.23 nudge]]");
  expect(s.submit().status).toBe("injected");
  expect(s.keys).toEqual(["Enter", `type:${WIRE}`, "Enter", "Enter"]);
  expect(existsSync(join(s.home, "input-backups"))).toBe(false);
});

// The record's lifetime is the staged-idle hold window: one number for the hold, the cascade and nudge.
for (const [label, window, ageMs] of [
  ["twenty minutes old, inside the default thirty-minute window", undefined, 1_200_000],
  ["fifty seconds old, inside a window shortened to a minute", "60", 50_000],
  ["twenty minutes old with the idle Enter turned off (window 0 keeps the default length)", "0", 1_200_000],
] as const) {
  test(`cascade: a stuck wire's tail ${label} is still proven and gets Enter`, () => {
    const s = seat(38, 5, OLD_WIRE);
    if (window !== undefined) s.env.TAP_STAGED_IDLE_SUBMIT_WINDOW = window;
    recordTypedWire("%7", s.binding, OLD_ID, OLD_WIRE, s.env, Date.now() - ageMs);
    expect(s.submit().status).toBe("injected");
    expect(s.keys).toEqual(["Enter", `type:${WIRE}`, "Enter", "Enter"]);
  });
}

// The same tail without proof that the courier typed it is a human draft: it
// never takes the Enter path and reaches the backup pipeline (the stub's door).
test("a wire typed but not verified submitted stays as evidence, bound to its generation and bus; the next delivery submits its tail and drops it", () => {
  const s = seat(38, 5);
  // The first delivery's Enter is accepted by tmux but never clears the composer: the wire is stuck.
  const clearing = s.fx.pressEnter;
  s.fx.pressEnter = () => { s.keys.push("Enter(stuck)"); return true; };
  expect(s.submit().status).not.toBe("injected");
  expect(s.buffer).toBe(WIRE);
  expect(typedWires("%7", s.binding, s.env)).toMatchObject([{ id: ID, wire: WIRE, epoch: "srv:1:1" }]);
  // The evidence is this generation's and this bus's only.
  expect(typedWires("%7", { ...s.binding, epoch: "srv:2:2" }, s.env)).toEqual([]);
  expect(typedWires("%7", { ...s.binding, bus: join(s.home, "foreign-bus") }, s.env)).toEqual([]);
  expect(typedWires("%7", { epoch: "", bus: s.home }, s.env)).toEqual([]);
  // A later delivery finds only the stuck wire's tail in frame, proves it from the record and submits it first.
  s.fx.pressEnter = clearing;
  s.keys.length = 0;
  const NEXT_ID = "next-seat-20260101T020202Z-ba9876543210";
  const NEXT = `[[TAP v0.23 note ${NEXT_ID} preview="A second delivery that found the first one's tail waiting in the narrow composer"]]`;
  expect(claudeBox(s.frame())!.typed.includes("[[TAP")).toBe(false);
  expect(submitVerifyLocked("tap/coach:0.0", NEXT_ID, NEXT, s.bound, s.fx, s.authority).status).toBe("injected");
  expect(s.keys).toEqual(["Enter", `type:${NEXT}`, "Enter", "Enter"]);
  expect(existsSync(join(s.home, "input-backups"))).toBe(false);
  // Both wires are submitted now; neither is evidence any longer.
  expect(typedWires("%7", s.binding, s.env)).toEqual([]);
});

// Tagged wires are delivery wires too: what the courier types is what it records, byte for byte.
for (const [label, head] of [
  ["a retry", `note ${OLD_ID} retry`],
  ["an urgent interrupt", `ask ${OLD_ID} urgent agent-interrupt`],
] as const) {
  test(`${label} wire is recorded exactly as typed, and its stuck tail gets Enter from the next delivery`, () => {
    const tagged = `[[TAP v0.23 ${head} preview="Digest 4 for bob-seat: three landings since 20:05Z and one open review request"]]`;
    expect(typedDeliveryWire(tagged)).toBe(tagged);
    const s = seat(38, 5);
    const clearing = s.fx.pressEnter;
    s.fx.pressEnter = () => true;
    expect(submitVerifyLocked("tap/coach:0.0", OLD_ID, tagged, s.bound, s.fx, s.authority).status).not.toBe("injected");
    expect(s.keys).toEqual([`type:${tagged}`]);
    expect(typedWires("%7", s.binding, s.env).map(typed => typed.wire)).toEqual([tagged]);
    s.fx.pressEnter = clearing;
    s.keys.length = 0;
    expect(claudeBox(s.frame())!.typed.includes("[[TAP")).toBe(false);
    expect(s.submit().status).toBe("injected");
    expect(s.keys).toEqual(["Enter", `type:${WIRE}`, "Enter", "Enter"]);
    expect(typedWires("%7", s.binding, s.env)).toEqual([]);
  });
}

test("the record holds the wire itself: a queue prefix is not part of it, and a control or doorbell is never a delivery wire", () => {
  expect(typedDeliveryWire(`/queue ${WIRE}`)).toBe(WIRE);
  expect(typedDeliveryWire(WIRE)).toBe(WIRE);
  expect(typedDeliveryWire("[[TAP v0.23 nudge]]")).toBeNull();
  expect(typedDeliveryWire("/compact keep the open review")).toBeNull();
  expect(typedDeliveryWire("/queue /compact")).toBeNull();
});

test("a delivered wire is no longer evidence: its tail reappearing in the composer is a human draft and gets no keys", () => {
  const s = seat(38, 5);
  expect(s.submit().status).toBe("injected");
  expect(typedWires("%7", s.binding, s.env)).toEqual([]);
  // The same text comes back, recalled from history or pasted at the end of a longer draft whose
  // first rows the narrow composer has scrolled out of view. Only the wire's tail is in frame.
  s.keys.length = 0;
  s.fx.injectText("%7", `a question about the message above, long enough to scroll out of the five visible rows of this composer ${WIRE}`);
  s.keys.length = 0;
  const visible = claudeBox(s.frame())!.typed;
  expect(visible.includes("[[TAP")).toBe(false);
  expect(visible.includes("a question about")).toBe(false);
  const NEXT_ID = "next-seat-20260101T020202Z-ba9876543210";
  let thrown = "";
  try { submitVerifyLocked("tap/coach:0.0", NEXT_ID, `[[TAP v0.23 note ${NEXT_ID}]]`, s.bound, s.fx, s.authority); } catch (error) { thrown = String(error); }
  expect(s.keys).toEqual([]);
  expect(thrown).toContain("a sentinel tail must never be backed up and cleared");
});

test("a damaged, foreign-shaped or unbound typed-wire record proves nothing and never blocks the delivery", () => {
  for (const damage of ["{not json", JSON.stringify({ pane: "%8", wires: [] }), JSON.stringify({ pane: "%7", wires: [{ id: OLD_ID, wire: OLD_WIRE, at: 1 }] }), JSON.stringify({ pane: "%7", wires: "none" })]) {
    const s = seat(38, 5, OLD_WIRE);
    recordTypedWire("%7", s.binding, OLD_ID, OLD_WIRE, s.env);
    const directory = join(s.home, "typed-wires");
    writeFileSync(join(directory, readdirSync(directory)[0]!), damage);
    expect(typedWires("%7", s.binding, s.env)).toEqual([]);
    // Unproven, so the tail takes the draft path (the stub's door), and nothing is entered.
    let thrown = "";
    try { s.submit(); } catch (error) { thrown = String(error); }
    expect(s.keys).toEqual([]);
    expect(thrown).toContain("a sentinel tail must never be backed up and cleared");
  }
  // A record that cannot be written at all leaves the delivery itself untouched.
  const s = seat(79, 5);
  writeFileSync(join(s.home, "typed-wires"), "a file where the directory would go");
  expect(s.submit().status).toBe("injected");
  expect(s.keys).toEqual([`type:${WIRE}`, "Enter", "Enter"]);
});

// Every path that verifies a submission ends that wire's evidence, not only the path that typed it.
test("an older complete wire submitted ahead of a delivery is no longer evidence: its tail reappearing below hidden text gets no keys", () => {
  const s = seat(38, 8, OLD_WIRE);
  recordTypedWire("%7", s.binding, OLD_ID, OLD_WIRE, s.env);
  expect(claudeBox(s.frame())!.typed.startsWith("[[TAP")).toBe(true);
  expect(s.submit().status).toBe("injected");
  expect(s.keys).toEqual(["Enter", `type:${WIRE}`, "Enter", "Enter"]);
  expect(typedWires("%7", s.binding, s.env)).toEqual([]);
  // The submitted older wire comes back below human text that the composer has scrolled out of view.
  s.fx.injectText("%7", `${"this question is human draft text above the visible viewport ".repeat(15)}${OLD_WIRE}`);
  s.keys.length = 0;
  s.fx.paneState = () => s.buffer ? { state: "busy", text: claudeBox(claudeFrame(s.buffer, 38, 5))!.typed } : { state: "ready" };
  s.fx.submitFrame = (_target, command, expected, alive) => classifySubmitFrame(claudeFrame(s.buffer, 38, 5), command, expected, "38", alive);
  const thirdId = "third-seat-20260101T030303Z-abcdef012345";
  let thrown = "";
  try { submitVerifyLocked("tap/coach:0.0", thirdId, `[[TAP v0.23 note ${thirdId}]]`, s.bound, s.fx, s.authority); } catch (error) { thrown = String(error); }
  expect(s.keys).toEqual([]);
  expect(thrown).toContain("a sentinel tail must never be backed up and cleared");
});

test("an empty composer ends every earlier wire's evidence for the pane, whichever bus typed it", () => {
  // The stuck wire was submitted or cleared by someone the courier did not see: nudge, or the person.
  const s = seat(38, 5);
  recordTypedWire("%7", s.binding, OLD_ID, OLD_WIRE, s.env);
  const foreign = { ...s.binding, bus: join(s.home, "foreign-bus") };
  recordTypedWire("%7", foreign, OLD_ID, OLD_WIRE, s.env);
  expect(s.submit().status).toBe("injected");
  expect(typedWires("%7", s.binding, s.env)).toEqual([]);
  expect(typedWires("%7", foreign, s.env)).toEqual([]);
});

test("a submission that stays unverified keeps its evidence; the matcher ends a wire by id or by the text that was submitted", () => {
  const typed = { id: OLD_ID, wire: OLD_WIRE };
  expect(submittedWire({ id: OLD_ID })(typed)).toBe(true);
  expect(submittedWire({ text: OLD_WIRE })(typed)).toBe(true);
  expect(submittedWire({ text: OLD_WIRE.slice(-40) })(typed)).toBe(true);
  expect(submittedWire({ id: "scrolled-tail", text: OLD_WIRE.slice(-40) })(typed)).toBe(true);
  expect(submittedWire({ id: ID, text: WIRE })(typed)).toBe(false);
  expect(submittedWire({})(typed)).toBe(false);
  expect(submittedWire({ id: "", text: "   " })(typed)).toBe(false);
});

// The lifetime is each reader's own window, so forgetting must reach entries that have
// already expired for the process doing the forgetting: a submitted wire never comes back.
test("a verified wire that had already aged out under a short window never revives under a longer one", () => {
  const s = seat(79, 5, OLD_WIRE);
  s.env.TAP_STAGED_IDLE_SUBMIT_WINDOW = "60";
  recordTypedWire("%7", s.binding, OLD_ID, OLD_WIRE, s.env, Date.now() - 61_000);
  expect(typedWires("%7", s.binding, s.env)).toEqual([]);
  // A complete sentinel still submits through the shared staged-submit path (nudge's route)
  // after its tail proof has expired for this process.
  const result = submitStagedLocked({ pane: "tap/coach:0.0", target: "%7", bound: s.bound,
    fx: s.fx, authority: s.authority, command: "claude", auto: false, urgent: false }, OLD_ID, OLD_WIRE, true,
    { record: () => {}, admit: () => null, bumpOrdinal: () => {}, bumpEnter: () => {} });
  expect(result.status).toBe("injected");
  expect(s.buffer).toBe("");
  // Another invocation runs with the default thirty-minute window: the submitted wire stays gone.
  delete s.env.TAP_STAGED_IDLE_SUBMIT_WINDOW;
  expect(typedWires("%7", s.binding, s.env)).toEqual([]);
});

test("an empty composer also ends entries that had aged out under a short window", () => {
  const s = seat(79, 5);
  s.env.TAP_STAGED_IDLE_SUBMIT_WINDOW = "60";
  recordTypedWire("%7", s.binding, OLD_ID, OLD_WIRE, s.env, Date.now() - 61_000);
  expect(s.submit().status).toBe("injected");
  delete s.env.TAP_STAGED_IDLE_SUBMIT_WINDOW;
  expect(typedWires("%7", s.binding, s.env)).toEqual([]);
});

test("an entry that only aged out, and was never submitted or seen gone, is still a longer window's evidence", () => {
  // Mixed windows are an operator's own inconsistency; the wire is still stuck, so it is still the courier's.
  const s = seat(38, 5, OLD_WIRE);
  s.env.TAP_STAGED_IDLE_SUBMIT_WINDOW = "60";
  recordTypedWire("%7", s.binding, OLD_ID, OLD_WIRE, s.env, Date.now() - 61_000);
  expect(typedWires("%7", s.binding, s.env)).toEqual([]);
  delete s.env.TAP_STAGED_IDLE_SUBMIT_WINDOW;
  expect(typedWires("%7", s.binding, s.env)).toMatchObject([{ id: OLD_ID, wire: OLD_WIRE }]);
});

// A wire whose preview holds a `[[`. Its own delivery proves the landing against the whole
// wire; left stuck, its opener-less tail still shows a `[[` and is unproven at every reader.
const BRACKET_ID = "bracket-seat-20260101T040404Z-00ff11ee22dd";
const BRACKET_WIRE = `[[TAP v0.23 note ${BRACKET_ID} preview="The parser note says to see the [[wiki page on wrapped rows before the next review pass on the narrow pane"]]`;

test("a fresh wire whose preview holds a [[ still proves its own scrolled landing and submits", () => {
  const s = seat(38, 5);
  expect(submitVerifyLocked("tap/coach:0.0", BRACKET_ID, BRACKET_WIRE, s.bound, s.fx, s.authority).status).toBe("injected");
  expect(s.keys).toEqual([`type:${BRACKET_WIRE}`, "Enter", "Enter"]);
});

test("cascade: a recorded tail that still shows a [[ is unproven and is treated as a human draft", () => {
  const s = seat(38, 5, BRACKET_WIRE);
  recordTypedWire("%7", s.binding, BRACKET_ID, BRACKET_WIRE, s.env);
  const visible = claudeBox(s.frame())!.typed;
  expect(visible.includes("[[TAP")).toBe(false);
  expect(visible.includes("[[wiki")).toBe(true);
  let thrown = "";
  try { s.submit(); } catch (error) { thrown = String(error); }
  expect(s.keys).toEqual([]);
  expect(s.buffer).toBe(BRACKET_WIRE);
  expect(thrown).toContain("a sentinel tail must never be backed up and cleared");
});

type Seat = ReturnType<typeof seat>;
for (const [label, prepare, viewport] of [
  ["no typed-wire record for the pane", () => {}, 5],
  ["a record older than the staged-idle window", (s: Seat) => recordTypedWire("%7", s.binding, OLD_ID, OLD_WIRE, s.env, Date.now() - 1_801_000), 5],
  ["a record older than a shortened staged-idle window", (s: Seat) => {
    s.env.TAP_STAGED_IDLE_SUBMIT_WINDOW = "60";
    recordTypedWire("%7", s.binding, OLD_ID, OLD_WIRE, s.env, Date.now() - 61_000);
  }, 5],
  ["a record of a different wire", (s: Seat) => recordTypedWire("%7", s.binding, ID, WIRE, s.env), 5],
  ["the id fragment scrolled out of frame", (s: Seat) => recordTypedWire("%7", s.binding, OLD_ID, OLD_WIRE, s.env), 2],
  // A pane id is unique only within one server generation: a restarted server's %7 is another pane.
  ["a record from a previous server generation", (s: Seat) => recordTypedWire("%7", { ...s.binding, epoch: "srv:0:0" }, OLD_ID, OLD_WIRE, s.env), 5],
  ["a server restart after the record was written", (s: Seat) => {
    recordTypedWire("%7", s.binding, OLD_ID, OLD_WIRE, s.env);
    s.bound.serverEpoch = "srv:2:2";
    s.fx.observePane = () => ({ paneId: "%7", session: "tap/coach", serverEpoch: "srv:2:2", currentCommand: "claude", panePid: "84" });
  }, 5],
  // A courier vouches only for its own bus.
  ["a record written by another bus's courier", (s: Seat) => recordTypedWire("%7", { ...s.binding, bus: join(s.home, "foreign-bus") }, OLD_ID, OLD_WIRE, s.env), 5],
] as const) {
  test(`cascade: an old wire's tail with ${label} is unproven and is treated as a human draft`, () => {
    const s = seat(38, viewport, OLD_WIRE);
    prepare(s);
    expect(claudeBox(s.frame())!.typed.trimEnd().endsWith('"]]')).toBe(true);
    let thrown = "";
    try { s.submit(); } catch (error) { thrown = String(error); }
    expect(s.keys).toEqual([]);
    expect(s.buffer).toBe(OLD_WIRE);
    expect(thrown).toContain("a sentinel tail must never be backed up and cleared");
  });
}

// Human text that merely ENDS like a wire. None of it was typed by the courier,
// so none of it may take the Enter path: a closing `]]` with a quote, a `path=`
// or a `preview="` in front of it is ordinary shell, JSON and wiki syntax.
const WIRE_LOOKALIKE_DRAFTS = [
  ["a shell test", 'why does this fail: if [[ -z "$FOO" ]]'],
  ["prose naming path= before a wiki link", "set path=/usr/local/bin first, then see [[Install notes]]"],
  ["a JSON snippet", 'the fixture is [["a", "b"], ["c", "d"]]'],
  ["a markdown link list", "- [docs](https://example.test/?path=/x) - [[Roadmap]]"],
] as const;

test("a band that opens with a sentinel and closes with ]] but is not one well-formed wire is retained: no Enter, no clear", () => {
  // The opener keeps it off the clear path; only the strict parser could put it on the Enter path.
  const draft = "[[TAP v0.23 note x-1]] what does this mean? see [[Release notes]]";
  const s = seat(38, 5, draft);
  const result = s.submit();
  expect(result).toMatchObject({ status: "band_busy", detail: "unparseable TAP input retained; no keys sent" });
  expect(s.keys).toEqual([]);
  expect(s.buffer).toBe(draft);
});

for (const [label, draft] of [["a wiki link", "see the wiki page [[Release notes]]"], ["plain prose", "fix the parser and rerun the narrow-pane suite"], ...WIRE_LOOKALIKE_DRAFTS] as const) {
  // The tail rule never submits or clears a draft. What happens to a draft next is the
  // sender's pre-existing draft policy, unchanged here: preserveDraft=false reaches the
  // backup-then-clear pipeline (the stub throws at its door), preserveDraft=true parks.
  test(`a human draft (${label}) never takes the Enter path; preserveDraft=false hands it to the shipped backup pipeline unchanged`, () => {
    const s = seat(38, 5, draft);
    // Keys first, so a failure names what was pressed on the draft.
    let thrown = "";
    try { s.submit(); } catch (error) { thrown = String(error); }
    expect(s.keys).toEqual([]);
    expect(s.buffer).toBe(draft);
    expect(thrown).toContain("a sentinel tail must never be backed up and cleared");
  });
  test(`a human draft (${label}) is preserved untouched when the sender preserves drafts`, () => {
    const s = seat(38, 5, draft);
    const result = submitVerifyLocked("tap/coach:0.0", ID, WIRE, s.bound, s.fx, { ...s.authority, preserveDraft: true });
    expect(result.status).toBe("band_busy");
    expect(s.keys).toEqual([]);
    expect(s.buffer).toBe(draft);
  });
}

// A bound recipient handle is verified against the acting registry at the point
// of effect; a missing or empty registry path must refuse, never skip the check.
for (const [label, authorityFor] of [
  ["an empty registry path", (a: ReturnType<typeof seat>["authority"]) => a],
  ["no authority at all", () => undefined],
] as const) {
  test(`a bound handle with ${label} refuses before any key`, () => {
    const s = seat(79, 5);
    const result = submitVerifyLocked("tap/coach:0.0", ID, WIRE, { ...s.bound, handle: "coach" }, s.fx, authorityFor(s.authority));
    expect(result.status).toBe("identity_mismatch");
    expect(s.keys).toEqual([]);
  });
}
