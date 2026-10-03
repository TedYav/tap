import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { submitVerifyLocked, type PaneEffects } from "../src/courier";
import { classifySubmitFrame } from "../src/submit-frame";
import { claudeBox } from "../src/pane-state";
import { phaseRows } from "../src/submit-phase";
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
  const authority = { busHome: home, recipient: "coach", registryPath: "", scriptsDir: "/unused", agentFamilies: new Set(["claude"]), preserveDraft: false };
  return { home, fx, bound, authority, keys, get buffer() { return buffer; }, frame,
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
  });
}

test("cascade: an old wire's scrolled tail in the composer gets Enter by shape, never a backup and clear, then ours delivers", () => {
  // No payload, no receipt, no id in frame: the tail's shape alone is the reason to press Enter.
  const s = seat(38, 5, OLD_WIRE);
  expect(claudeBox(s.frame())!.typed.includes("[[TAP")).toBe(false);
  expect(claudeBox(s.frame())!.typed.includes(OLD_ID)).toBe(false);
  const result = s.submit();
  expect(result.status).toBe("injected");
  // Enter for the old wire first (never a retype), then one injection and the
  // ordinary verified-plus-completion Enters for ours.
  expect(s.keys).toEqual(["Enter", `type:${WIRE}`, "Enter", "Enter"]);
  expect(existsSync(join(s.home, "input-backups"))).toBe(false);
  expect(phaseRows(s.home, ID).at(-1)).toMatchObject({ phase: "verify-result", result: "verified" });
});

test("a tail cut inside the preview, with only the closing quote in frame, is still submitted by shape", () => {
  const s = seat(38, 2, OLD_WIRE);
  const typed = claudeBox(s.frame())!.typed;
  expect(typed.includes('preview="')).toBe(false);
  expect(typed.trimEnd().endsWith('"]]')).toBe(true);
  expect(s.submit().status).toBe("injected");
  expect(s.keys[0]).toBe("Enter");
});

for (const [label, draft] of [["a wiki link", "see the wiki page [[Release notes]]"], ["plain prose", "fix the parser and rerun the narrow-pane suite"]] as const) {
  // The tail rule never submits or clears a draft. What happens to a draft next is the
  // sender's pre-existing draft policy, unchanged here: preserveDraft=false reaches the
  // backup-then-clear pipeline (the stub throws at its door), preserveDraft=true parks.
  test(`a human draft (${label}) never takes the Enter path; preserveDraft=false hands it to the shipped backup pipeline unchanged`, () => {
    const s = seat(38, 5, draft);
    expect(() => s.submit()).toThrow("a sentinel tail must never be backed up and cleared");
    expect(s.keys).toEqual([]);
    expect(s.buffer).toBe(draft);
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
