import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dimPromptInput, promptRowReAwk, promptRowReGrep, stripPromptRow, textHasPasteCollapse,
} from "../src/pane/geometry";
import {
  cursorBandChrome, escapedPromptFromFrame, frameIo, inputHasId, inputLine, inputRegion,
  inputRegionHasContinuation, inputStateFromRegion,
  paneAlertState, paneRead, peekTranscript, pendingInputProbe, pendingInputText, promptLineReText,
  stripClaudeArgHint,
} from "../src/pane/reader";
import { sanitizeFilenameComponent, writeInputBackup } from "../src/pane/draft";
import { inputBackupBody } from "../src/input-backup";

const WIRE = "[[TAP v0.23 ask fable-leader-20260101T000000Z-0123456789ab]]";
const io = (frame: string, width = "80") => frameIo(frame, width);

// ---------------------------------------------------------------------------
// Selector classes. ONE CASE PER POSITION, because position is the axis an earlier
// revision was blind on: its single NBSP case sat AFTER the glyph, which the strip was
// already handling, while the selector side diverged unnoticed.
// ---------------------------------------------------------------------------

// Separators the incumbent's `grep -E`/`sed -E` accept and its `awk` does not.
// A representative per row of the measured table, not the whole U+2000-200A
// range — the selector probe script is the measurement.
const WIDE_ONLY = [" ", " ", " ", " ", " ", " ", " ", "　"];
const BOTH = ["\t", "\v", "\f", "\r", " ", " "];
const NEITHER = ["", "", "", "﻿", "⁠", "​"];

test("the grep selector is WIDER than the awk selector, per measured separator", () => {
  for (const sep of BOTH) {
    expect(promptRowReGrep("claude").test(`${sep}❯ draft`)).toBe(true);
    expect(promptRowReAwk("claude").test(`${sep}❯ draft`)).toBe(true);
  }
  for (const sep of WIDE_ONLY) {
    // The whole point of two selectors. If these ever agree, one of them has
    // been "tidied" into the other and a verdict has moved with it.
    expect(promptRowReGrep("claude").test(`${sep}❯ draft`)).toBe(true);
    expect(promptRowReAwk("claude").test(`${sep}❯ draft`)).toBe(false);
  }
  for (const sep of NEITHER) {
    expect(promptRowReGrep("claude").test(`${sep}❯ draft`)).toBe(false);
    expect(promptRowReAwk("claude").test(`${sep}❯ draft`)).toBe(false);
  }
});

test("a wide separator before the glyph: claude refuses the row, every other harness reads it", () => {
  // MEASURED PER HARNESS against the incumbent run from the pinned base, not
  // generalized from one. The first version of this test asserted "a padded row
  // is always a band" and failed on claude — and the code was right: claude is
  // the one harness whose prompt row is selected with awk's narrow class,
  // because it is the only arm that promotes its overlay capture to the
  // prompt-row source. Every other harness re-reads through `tap_inputline`,
  // whose `grep` class is wide.
  //
  // The asymmetry is the incumbent's and it is a live defect: on a U+2000-padded
  // prompt row a claude pane reports ABSENT GEOMETRY — status 3, the direction
  // `tap_submit_verify`'s draft-clear types over — while the identical row on
  // codex reports the draft it is holding. Ported byte-for-byte and RATIFIED
  // rather than repaired inside a port; closing it is a behavior change with its
  // own oracle.
  for (const sep of BOTH) {
    for (const cmd of ["claude", "codex", "cursor", "hermes"]) {
      expect(pendingInputText(io(`${sep}❯ ${WIRE}\n`), "%p", cmd)).toEqual({ status: "text", text: WIRE });
    }
  }
  for (const sep of WIDE_ONLY) {
    expect(pendingInputText(io(`${sep}❯ ${WIRE}\n`), "%p", "claude").status).toBe("no-band");
    for (const cmd of ["codex", "cursor", "hermes"]) {
      expect(pendingInputText(io(`${sep}❯ ${WIRE}\n`), "%p", cmd)).toEqual({ status: "text", text: WIRE });
    }
  }
  for (const sep of NEITHER) {
    for (const cmd of ["claude", "codex", "cursor", "hermes"]) {
      expect(pendingInputText(io(`${sep}❯ ${WIRE}\n`), "%p", cmd).status).toBe("no-band");
    }
  }
});

test("a separator AFTER the glyph is stripped in the wide class", () => {
  for (const sep of [...BOTH.filter(s => s !== "\r"), ...WIDE_ONLY]) {
    expect(stripPromptRow(`❯${sep}${WIRE}`, "claude")).toBe(WIRE);
  }
  // U+FEFF is in no class, so it survives the strip and stays part of the text.
  expect(stripPromptRow(`❯﻿${WIRE}`, "claude")).toBe(`﻿${WIRE}`);
});

// ---------------------------------------------------------------------------
// The three-way contract.
// ---------------------------------------------------------------------------

test("an empty band is text, not no-band", () => {
  const verdict = pendingInputText(io("Worked for 1m\n\n❯ \n\nmodel · Context 90% left\n"), "%p", "claude");
  expect(verdict).toEqual({ status: "text", text: "" });
});

test("a pane with no prompt row is no-band", () => {
  expect(pendingInputText(io("just transcript\nmore\n"), "%p", "claude").status).toBe("no-band");
});

test("codex reads its prompt row from its OWN capture, not the overlay frame", () => {
  // The incumbent ran `set -- … "$full_frame"` inside the `claude*` arm ONLY,
  // so codex fell through to `tap_inputline` — a plain capture selected with
  // grep's wide class. Promoting the overlay frame for codex too read an idle
  // codex band as absent geometry at every pane width (sentinel-submit) and an
  // unstyled codex draft as a known empty band.
  const idle = `Worked for 1m 02s\n\n› ${" ".repeat(138)}\n\ngpt-6-astra high · Context 90% left · /tmp\n`;
  expect(pendingInputText(io(idle), "%p", "codex")).toEqual({ status: "text", text: "" });
  const drafted = `Worked for 1m 02s\n\n› ${WIRE}\n\ngpt-6-astra high · Context 90% left · /tmp\n`;
  expect(pendingInputText(io(drafted), "%p", "codex")).toEqual({ status: "text", text: WIRE });
});

test("cursor band chrome blanks, and a human who types the busy phrase does not", () => {
  expect(cursorBandChrome("Add a follow-up")).toBe(true);
  expect(cursorBandChrome("Add a follow-up ctrl+c to stop")).toBe(true);
  expect(cursorBandChrome("Plan, search, build anything")).toBe(true);
  // The reviewer P1: a bare "ctrl+c to stop" is a draft a human can type, and
  // substring-stripping it out of a real draft is data loss.
  expect(cursorBandChrome("ctrl+c to stop")).toBe(false);
  expect(cursorBandChrome("Add a follow-up later today")).toBe(false);
});

// ---------------------------------------------------------------------------
// Claude's argument-placeholder hint (tap-tx3s).
// ---------------------------------------------------------------------------

test("the arg hint is removed only on both properties together", () => {
  expect(stripClaudeArgHint("/compact  <optional custom summarization instructions>", "", "80")).toBe("/compact");
  expect(stripClaudeArgHint("/goal  [<condition> | clear]", "", "80")).toBe("/goal");
  expect(stripClaudeArgHint("/loop  [interval] [prompt]", "", "80")).toBe("/loop");
  expect(stripClaudeArgHint("/clear  [name]", "", "80")).toBe("/clear");
  // ONE blank, not two: the second blank is the column the cursor reserves, and
  // one means a relocated cursor spent it.
  const oneBlank = "/compact <optional custom summarization instructions>";
  expect(stripClaudeArgHint(oneBlank, "", "80")).toBe(oneBlank);
  // Position without the table is not enough: a real draft sitting in the
  // two-blank position must survive.
  const draft = "/compact  something the human actually typed";
  expect(stripClaudeArgHint(draft, "", "80")).toBe(draft);
});

test("the truncated hint needs an exact pane fill, and an unreadable width refuses it", () => {
  const row = "/compact  <optional custom summ…";
  expect(stripClaudeArgHint(row, row, String([...row].length))).toBe("/compact");
  expect(stripClaudeArgHint(row, row, "")).toBe(row);
  expect(stripClaudeArgHint(row, row, String([...row].length + 1))).toBe(row);
});

// ---------------------------------------------------------------------------
// Dim placeholder. Two attributes together for Hermes.
// ---------------------------------------------------------------------------

test("hermes needs italic AND the muted colour, never either alone", () => {
  const hint = "Ask anything, or type / for commands…";
  const both = `\x1b[3m\x1b[38;5;136m${hint}\x1b[0m`;
  expect(dimPromptInput(hint, both, "[›❯]", "hermes")).toBe(true);
  expect(dimPromptInput(hint, `\x1b[3m${hint}\x1b[0m`, "[›❯]", "hermes")).toBe(false);
  expect(dimPromptInput(hint, `\x1b[38;5;136m${hint}\x1b[0m`, "[›❯]", "hermes")).toBe(false);
  // A different muted colour is draft paint, not the hint.
  expect(dimPromptInput(hint, `\x1b[3m\x1b[38;5;137m${hint}\x1b[0m`, "[›❯]", "hermes")).toBe(false);
  // And the same paint on a non-hermes harness is not this rule's business.
  expect(dimPromptInput(hint, both, "[›❯]", "claude")).toBe(false);
});

test("SGR 2 is a placeholder for every harness, and a reverse cursor alone is not", () => {
  expect(dimPromptInput("Add a follow-up", "\x1b[2mAdd a follow-up\x1b[0m", "[›❯→]", "cursor")).toBe(true);
  // A reverse-video cursor can cover the whole of a one-character draft;
  // placeholder paint on text beyond the glyph is required.
  expect(dimPromptInput("x", "\x1b[7mx\x1b[27m", "[›❯→]", "cursor")).toBe(false);
});

// ---------------------------------------------------------------------------
// Region, continuation, transcript.
// ---------------------------------------------------------------------------

test("the region is the LAST prompt row and everything after it", () => {
  const frame = "❯ submitted long ago\ntranscript\n❯ new draft\n  wrapped\n";
  expect(inputRegion(io(frame), "%p", "claude")).toEqual({ status: "ok", region: "❯ new draft\n  wrapped\n" });
  expect(inputRegionHasContinuation(io(frame), "%p", "claude")).toBe(true);
  expect(inputRegionHasContinuation(io("❯ single row\n"), "%p", "claude")).toBe(false);
});

test("the transcript keeps everything above the LAST prompt row", () => {
  const frame = "❯ old\nmiddle transcript\n❯ active";
  expect(peekTranscript(frame, "claude", promptRowReAwk("claude"))).toBe("❯ old\nmiddle transcript\n");
  // No prompt at all: every row is transcript, each terminated as `print` did.
  expect(peekTranscript("a\nb", "claude", promptRowReAwk("claude"))).toBe("a\nb\n");
});

test("peek's human view carries the state header and a terminated transcript", () => {
  const out = paneRead(io("hello\n❯ \n"), "%p", "claude", "seat", false);
  expect(out).toBe("input_state: empty\n---\nhello\n");
  const json = JSON.parse(paneRead(io("hello\n❯ draft\n"), "%p", "claude", "seat", true));
  expect(json.input_state).toBe("other-text");
  // The JSON branch read its transcript through `$(…)`; the human branch above
  // did not. So the printed view keeps every row terminator and the wire value
  // has none — per branch, exactly as the Bash door was written.
  expect(json.transcript).toBe("hello");
});

test("input state separates a staged sentinel from ordinary text", () => {
  expect(inputStateFromRegion(`❯ ${WIRE}\n`, "", "[›❯]", "", "claude")).toBe("unsubmitted-sentinel");
  expect(inputStateFromRegion("❯ ordinary draft\n", "", "[›❯]", "", "claude")).toBe("other-text");
  expect(inputStateFromRegion("❯ \n", "", "[›❯]", "", "claude")).toBe("empty");
  expect(inputStateFromRegion("❯ [[TAPISH thing]]\n", "", "[›❯]", "", "claude")).toBe("other-text");
});

test("id matching ignores the whitespace a TUI re-pads with", () => {
  expect(inputHasId(io(`❯ ${WIRE}\n`), "%p", "claude", WIRE)).toBe(true);
  expect(inputHasId(io("❯ [[TAP v0.23 ask fable-leader-\n  20260101T000000Z-0123456789ab]]\n"), "%p", "claude", WIRE)).toBe(true);
  expect(inputHasId(io("❯ something else\n"), "%p", "claude", WIRE)).toBe(false);
  // An empty needle is never a match — otherwise every band "contains" it.
  expect(inputHasId(io("❯ anything\n"), "%p", "claude", "")).toBe(false);
});

test("paste chips are recognized per harness and nowhere else", () => {
  expect(textHasPasteCollapse("claude", "[Pasted text #3 +40 lines]")).toBe(true);
  expect(textHasPasteCollapse("codex", "[Pasted Content 900 chars]")).toBe(true);
  expect(textHasPasteCollapse("opencode", "[Pasted ~12 lines]")).toBe(true);
  expect(textHasPasteCollapse("claude", "[Pasted Content 900 chars]")).toBe(false);
  expect(textHasPasteCollapse("hermes", "[Pasted text #3]")).toBe(false);
});

test("the alert tail rejoins soft wraps without reflowing the transcript", () => {
  expect(paneAlertState("chatter\nrate limit\nreached\n")).toBe("rate-limited-error");
  expect(paneAlertState("approve this command?\n")).toBe("blocked-on-approval");
  expect(paneAlertState("ordinary transcript\n")).toBe("");
  // Nine rows of filler push the phrase out of the bounded tail.
  expect(paneAlertState(`too many requests\n${"x\n".repeat(9)}`)).toBe("");
});

// ---------------------------------------------------------------------------
// Recoverability probe.
// ---------------------------------------------------------------------------

test("a band that changed between two observations is not recoverable", () => {
  const first = io(`❯ first text\n`);
  const second = io(`❯ second text\n`);
  expect(pendingInputProbe(first, "%p", "claude", 4096, second).reason).toBe("unstable");
  expect(pendingInputProbe(first, "%p", "claude", 4096, first).reason).toBe("single-line");
});

test("every unrecoverable reason refuses for its own reason", () => {
  const probe = (frame: string, cap = 4096) => pendingInputProbe(io(frame), "%p", "claude", cap);
  expect(probe("❯ \n")).toMatchObject({ state: "empty", recoverable: false, reason: "empty" });
  expect(probe("❯ short", 3)).toMatchObject({ recoverable: false, reason: "overlong" });
  expect(probe("❯ first\n  second\n")).toMatchObject({ recoverable: false, reason: "wrapped" });
  expect(probe("❯ hasa bell\n")).toMatchObject({ recoverable: false, reason: "control-character" });
  expect(probe("no prompt here\n")).toMatchObject({ state: "blocked", reason: "no-input-prompt" });
});

// ---------------------------------------------------------------------------
// The draft writer.
// ---------------------------------------------------------------------------

test("the backup is the format `tap draft` reads back", () => {
  const dir = mkdtempSync(join(tmpdir(), "tap-draft-"));
  const path = writeInputBackup({
    directory: dir, handle: "seat", payloadId: "pid", pane: "tap/seat:1.0", paneId: "%7",
    paneCommand: "claude", inputHash: "deadbeef", recoveryPolicy: "", text: "my unsent draft",
  }, new Date(Date.UTC(2026, 8, 15, 22, 45, 30)));
  const raw = readFileSync(path, "utf8");
  expect(path.endsWith("20260915T224530Z-seat-pid.md")).toBe(true);
  // Empty policy is `unspecified` — an honest "nobody said", never `clobber`.
  expect(raw).toContain("recovery_policy: unspecified\n");
  expect(raw).toContain("first_capture_at: caller-owned\n");
  expect(inputBackupBody(raw)).toBe("my unsent draft");
});

test("filename sanitizing is per BYTE, as `tr -c` was", () => {
  expect(sanitizeFilenameComponent("plain.name-1_2")).toBe("plain.name-1_2");
  expect(sanitizeFilenameComponent("a/b c")).toBe("a_b_c");
  // One underscore per UTF-8 byte, not per character: `é` is two bytes.
  expect(sanitizeFilenameComponent("é")).toBe("__");
});

// ---------------------------------------------------------------------------
// Emitted bytes. Each of these reds on the port as it stood before the fix, so
// the assertion is about a difference that existed rather than a shape I like.
// ---------------------------------------------------------------------------

test("codex's idle hint needs its PAINT, not just its wording", () => {
  // The incumbent's door is `codexPlaceholder`, which is the text pattern AND a
  // dim-paint corroboration. A copy of it here kept only the pattern, so a human
  // who typed that exact sentence unstyled had the draft blanked. Case 2 is the
  // control that reds on the copy.
  const painted = "› \x1b[2mAsk Codex to do anything\x1b[0m";
  expect(dimPromptInput("Ask Codex to do anything", painted, "[›❯»]", "codex")).toBe(true);
  expect(dimPromptInput("Ask Codex to do anything", "› Ask Codex to do anything", "[›❯»]", "codex")).toBe(false);
  // Braille whimsy is painted around the hint, so it must not defeat the match.
  const brailled = "› \x1b[2m⠋ Ask Codex to do anything ⠙\x1b[0m";
  expect(dimPromptInput("⠋ Ask Codex to do anything ⠙", brailled, "[›❯»]", "codex")).toBe(true);
});

test("the readers emit the terminators their programs emitted", () => {
  // `grep … | tail -1` prints the selected row WITH its newline and prints
  // nothing when nothing matched; OpenCode's branch ends in `printf '%s'`.
  const generic = inputLine(io("❯ a draft\n"), "%p", "claude");
  expect(generic).toEqual({ ok: true, line: "❯ a draft\n" });
  expect(inputLine(io("no prompt row\n"), "%p", "claude")).toEqual({ ok: true, line: "" });
  // awk's `print last` terminates the row it prints, and prints none when absent.
  expect(escapedPromptFromFrame("❯ a draft\n", "claude")).toBe("❯ a draft\n");
  expect(escapedPromptFromFrame("no prompt row\n", "claude")).toBe("");
  // The terminator must not leak into the classification the caller stripped.
  expect(pendingInputText(io("❯ a draft\n"), "%p", "claude")).toEqual({ status: "text", text: "a draft" });
});

test("peek JSON escapes non-ASCII the way Python's json.dumps defaults to", () => {
  const out = paneRead(io("héllo ☃\n❯ \n"), "%p", "claude", "seat", true);
  expect(out.endsWith("\n")).toBe(true);
  // `ensure_ascii=True` is the default the Bash door never overrode.
  expect(out).toContain("h\\u00e9llo \\u2603");
  expect(out).not.toContain("héllo");
  expect(JSON.parse(out).transcript).toBe("héllo ☃");
});

test("a named hermes profile's staged sentinel is still a staged sentinel", () => {
  // `tap_prompt_line_re hermes` carries the named-profile prefix; a pattern
  // rebuilt from the glyph alone does not, so `ops-hermes ` survives the strip,
  // the text stops starting with `[[TAP`, and a staged sentinel reads as an
  // ordinary draft. Found by the oracle on a named hermes row; reds when
  // `paneRead` reconstructs the pattern from the glyph.
  // tap-rhajr adds the working "⚕ " prefix to the same group.
  expect(promptLineReText("hermes")).toBe("^[[:space:] ]*([A-Za-z0-9._-]+ |⚕ )?[›❯]");
  expect(promptLineReText("claude")).toBe("^[[:space:] ]*[›❯]");
  const frame = `ops-hermes ❯ ${WIRE}\n`;
  expect(paneRead(io(frame), "%p", "hermes", "seat", false)).toBe("input_state: unsubmitted-sentinel\n---\n");
  // The same row on a harness whose prompt has no named prefix is unchanged.
  expect(paneRead(io(`❯ ${WIRE}\n`), "%p", "claude", "seat", false)).toBe("input_state: unsubmitted-sentinel\n---\n");
});

test("the region keeps awk's final empty record", () => {
  // `$(…)` around the capture stripped the trailing newline before the module
  // saw it, so awk's last empty record never existed and the region came back
  // one blank row short — 18 of the oracle's adapter rows. The module is handed
  // the frame exactly now.
  expect(inputRegion(io("❯ a\n \n  b \n\n"), "%p", "claude").region).toBe("❯ a\n \n  b \n\n");
  expect(inputRegion(io("❯ a\n"), "%p", "claude").region).toBe("❯ a\n");
});

test("a second backup for the same key never replaces the first", () => {
  // The key is a SECOND-resolution stamp + handle + payload id, so a retry or a
  // concurrent attempt on the same id inside one second collides. The Bash
  // writer's `mv -f` overwrote; `deliver.ts`'s `flag: "wx"` threw. One loses the
  // draft, the other loses the backup — and the file is the recovery authority
  // for someone's unsent text. Both survive instead.
  const dir = mkdtempSync(join(tmpdir(), "tap-draft-collide-"));
  const at = new Date(Date.UTC(2026, 8, 15, 22, 45, 30));
  const req = {
    directory: dir, handle: "seat", payloadId: "pid", pane: "tap/seat:1.0", paneId: "%7",
    paneCommand: "claude", inputHash: "deadbeef", recoveryPolicy: "clobber",
  };
  const first = writeInputBackup({ ...req, text: "the first draft" }, at);
  const second = writeInputBackup({ ...req, text: "the second draft" }, at);
  expect(second).not.toBe(first);
  expect(inputBackupBody(readFileSync(first, "utf8"))).toBe("the first draft");
  expect(inputBackupBody(readFileSync(second, "utf8"))).toBe("the second draft");
  // A third lands beside them rather than reusing the second's name.
  const third = writeInputBackup({ ...req, text: "the third draft" }, at);
  expect(new Set([first, second, third]).size).toBe(3);
  expect(inputBackupBody(readFileSync(first, "utf8"))).toBe("the first draft");
});

test("a trailing BOM is not whitespace to the sentinel grammar", () => {
  // JS `\s` includes U+FEFF; Python's does not. A sentinel followed by a BOM
  // ends with a character Python's `\s*$` cannot match, so the incumbent reads
  // it as ordinary text — and the port read it as a staged sentinel until the
  // grammar used Python's class. Reds on JS `\s`.
  expect(inputStateFromRegion(`❯ ${WIRE}﻿\n`, "", "[›❯]", "", "claude")).toBe("other-text");
  expect(inputStateFromRegion(`❯ ${WIRE}\n`, "", "[›❯]", "", "claude")).toBe("unsubmitted-sentinel");
  // U+00A0 IS in Python's class, so it stays a sentinel — the two must not be
  // collapsed into "any odd trailing character breaks it".
  expect(inputStateFromRegion(`❯ ${WIRE} \n`, "", "[›❯]", "", "claude")).toBe("unsubmitted-sentinel");
});

test("the probe's wrapped arm refuses recovery without truncating what it reports", () => {
  // The module's text is the prompt row, so the RECORD-splitting defect this
  // pairs with lives in the Bash adapter and is covered by
  // `pane-probe-record.test.sh` — a module test cannot red on a shell `read`.
  // What belongs here is the arm that makes the pairing matter: a wrapped band
  // refuses recovery, and still reports the text it did see.
  const probe = pendingInputProbe(io("❯ first line\n  second line\n"), "%p", "claude", 4096);
  expect(probe.reason).toBe("wrapped");
  expect(probe.recoverable).toBe(false);
  expect(probe.text).toBe("first line");
  expect(probe.bytes).toBe(10);
});

test("hermes peek: a placeholder reads empty and typed input reads other-text", () => {
  // Moved from cursor-harness.test.sh section 5b with tap_pane_read. Its fake tmux
  // served the plain capture as the CSI-stripped escaped fixture, which frameIo derives.
  const fixtures = join(import.meta.dir, "../../../skills/tap/scripts/smoke/fixtures/hermes-prompt");
  for (const [fixture, state] of [["placeholder.ansi", "empty"], ["typed.ansi", "other-text"]] as const) {
    const frame = readFileSync(join(fixtures, fixture), "utf8");
    expect(paneRead(io(frame, ""), "hermespane", "hermes", "hermes", false).split("\n")[0]).toBe(`input_state: ${state}`);
  }
});

test("tap-8nmot: a staged Codex wire under paint and footer rows reads unsubmitted-sentinel", () => {
  // The composer classification goes through the ONE Codex reader, so the
  // braille chrome and the status footer never reach the classifier — the
  // incident's `other-text` verdict.
  const frame = "⠿ ⠿\n› \u001b[1m⠋\u001b[0m [[TAP v0.23 note sender-20260906T220111Z-21f26672936f]]\n\n  gpt-6-astra medium · Context 99% left · weekly 41% left\n";
  expect(paneRead(io(frame), "%p", "codex", "seat", false).split("\n")[0]).toBe("input_state: unsubmitted-sentinel");
});

test("tap-8nmot: peek classifies Codex's composer from the ESCAPED capture", () => {
  // The idle placeholder is recognized by its dim paint, which only the escaped
  // capture carries. Classifying the plain frame read an idle Codex seat as
  // other-text; an unstyled human sentence with the same words stays a draft.
  const idle = "done\n› \x1b[2mAsk Codex to do anything\x1b[0m\n\n  gpt-6 · 80% left\n";
  expect(JSON.parse(paneRead(io(idle), "%p", "codex", "seat", true)).input_state).toBe("empty");
  const typed = "done\n› Ask Codex to do anything\n\n  gpt-6 · 80% left\n";
  expect(JSON.parse(paneRead(io(typed), "%p", "codex", "seat", true)).input_state).toBe("other-text");
});
