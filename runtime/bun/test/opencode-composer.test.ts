import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fgAtGlyph, hasNongrayText, opencodeBoxText, opencodeTerminalOverprint, sgrRuns, stripGrayOverlay } from "../src/opencode-composer";
import { classifyPane } from "../src/pane-state";
import { pendingInputText } from "../src/pane/reader";
import { readComposerFrame } from "../src/submit-frame";

const root = new URL("../../../", import.meta.url).pathname;
const fx = root + "skills/tap/scripts/smoke/fixtures/";
const wrapped = readFileSync(root + "runtime/bun/test/fixtures/opencode-capture/all-wrapped-160.plain.txt", "utf8");
const FOOTER = "  ┃  Build · OpenCode Fixture · high";
const withRows = (...rows: string[]) => wrapped.replace(FOOTER, [...rows, FOOTER].join("\n"));

/** Splice rows INSIDE the box region, located the way the reader locates it. A
 * `String.replace` on "  ┃  " lands on line 1 of this capture — in the
 * transcript, above the box — so a constructed popup row placed that way
 * exercises nothing. Two of this suite's cases were written that way first. */
function atRegionTop(frame: string, ...rows: string[]): string {
  const lines = frame.split("\n");
  const plain = lines.map(l => l.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""));
  let border = -1;
  for (let i = 0; i < plain.length; i++) if (/^\s*╹▀/.test(plain[i]!)) border = i;
  let start = border;
  while (start - 1 >= 0 && /^\s*┃/.test(plain[start - 1]!)) start--;
  lines.splice(start, 0, ...rows);
  return lines.join("\n");
}
const accent = (frame: string) => frame.replace("  ╹▀", "  \x1b[36m╹\x1b[39m▀");

test("every captured OpenCode fixture reads the same through the module and the native band classifier", () => {
  const files: [string, string][] = [];
  for (const d of ["submit-verify", "peek-harness-adapters", "opencode-splash"]) {
    for (const f of readdirSync(fx + d)) {
      if (!f.endsWith(".ansi")) continue;
      if (!f.includes("opencode") && d !== "opencode-splash") continue;
      files.push([`${d}/${f}`, readFileSync(fx + d + "/" + f, "utf8")]);
    }
  }
  expect(files.length).toBeGreaterThanOrEqual(16);
  for (const [name, capture] of files) {
    expect(`${name}:${readComposerFrame(capture, "opencode")}`).toBe(`${name}:${opencodeBoxText(capture)}`);
  }
});

test("the command-palette popup is stripped by BOTH halves of its discriminator, never one", () => {
  const palette = readFileSync(fx + "submit-verify/opencode-command-palette.ansi", "utf8");
  expect(opencodeBoxText(palette)).toBe("/new");
  expect(opencodeBoxText(readFileSync(fx + "submit-verify/opencode-command-palette-nomatch.ansi", "utf8"))).toBe("/zzz");
  // Structural half alone would eat a draft row that legitimately ends in the
  // border glyph — a pasted box diagram. With no colour anywhere, the reading is
  // UNAVAILABLE, and tap-d901's polarity keeps the row.
  expect(opencodeBoxText(atRegionTop(wrapped, "  ┃  box diagram ┃"))).toBe("box diagram ┃");
  // Colour half alone is not enough either: a row painted in the box's OWN
  // accent is typed text whatever it ends with.
  expect(opencodeBoxText(accent(atRegionTop(wrapped, "  \x1b[36m┃\x1b[39m  box diagram \x1b[36m┃\x1b[39m")))).toBe("box diagram ┃");
  // Both halves present and disagreeing: that is a popup, and it goes.
  expect(opencodeBoxText(accent(atRegionTop(withRows("  ┃  typed draft"), "  \x1b[31m┃\x1b[39m  /new  New session  \x1b[31m┃\x1b[39m")))).toBe("typed draft");
  // HALF a reading — the row is painted, the box's corner is not. The incumbent
  // stops stripping when either side is unavailable; a rule that only compared
  // readings it HAS would eat this row. Both-null does not distinguish them,
  // which is why this case exists.
  expect(opencodeBoxText(atRegionTop(wrapped, "  \x1b[31m┃\x1b[39m  item row \x1b[31m┃\x1b[39m"))).toBe("item row ┃");
});

test("the right-aligned overlay is dropped in the same row as a draft, by style", () => {
  // Same row as typed text: split BY STYLE, never by whitespace width — a draft
  // may legitimately carry a long internal run of spaces, and this reader feeds
  // the pending-input backup, so cutting on width destroys text the clobber
  // then clears.
  expect(opencodeBoxText(readFileSync(fx + "submit-verify/opencode-overlay-samerow.ansi", "utf8"))).toBe("/new");
  expect(opencodeBoxText(readFileSync(fx + "submit-verify/opencode-overlay-widespace-draft.ansi", "utf8")))
    .toBe("col1     col2          col3 end");
});

test("only the pinned truecolor gray is placeholder chrome; other themes keep the row", () => {
  const ask = 'Ask anything... "Fix broken tests"';
  expect(opencodeBoxText(withRows(`  ┃  \x1b[38;2;128;128;128m${ask}\x1b[39m`))).toBe("");
  expect(opencodeBoxText(withRows(`  ┃  \x1b[38;2;238;238;238m${ask}\x1b[39m`))).toBe(ask);
  // 256-colour and basic themes: NOT the pinned gray, so the row is kept. This
  // is deliberate (the placeholder is not filtered under those themes) and it is
  // the safe side of the same polarity — a spurious draft costs a backup, a
  // wrongly-dropped row costs the text.
  expect(opencodeBoxText(withRows(`  ┃  \x1b[38;5;244m${ask}\x1b[39m`))).toBe(ask);
  expect(opencodeBoxText(withRows(`  ┃  \x1b[90m${ask}\x1b[39m`))).toBe(ask);
  // TAGGED comparison is what keeps 256-colour 128 from reading as the
  // truecolor gray. A bare number would make these compare equal, and the Bash
  // comment called that untestable — it is not.
  expect(fgAtGlyph("\x1b[38;5;128mx", "x")).toEqual(["idx", "128"]);
  expect(hasNongrayText("\x1b[38;5;128mtyped")).toBe(true);
  expect(hasNongrayText("\x1b[38;2;128;128;128mchrome")).toBe(false);
  expect(opencodeBoxText(withRows("  ┃  \x1b[38;5;128mtyped in 256-colour 128\x1b[39m"))).toBe("typed in 256-colour 128");
});

test("the footer row is popped only when the row IS the footer", () => {
  // With the footer present, every row above it is draft — two rows included.
  expect(opencodeBoxText(withRows("  ┃  first draft", "  ┃  second draft"))).toBe("first draft\nsecond draft");
  // Trailing blanks go FIRST, which is what lets the pop reach the footer
  // instead of eating a blank and leaving the footer as a draft.
  expect(opencodeBoxText(wrapped.replace(FOOTER, `${FOOTER}\n  ┃`))).toBe("");
  // Every one of the 17 captured boxes ends in this grammar, so a
  // grammar-conditional pop and the incumbent's unconditional one agree on all
  // real input. They part on a box with NO footer — and there the incumbent ate
  // a row of human text, which this reader would then have failed to back up.
  // DEVIATION from the incumbent, deliberate and pending adjudication
  // (sol-ponytail-2 B1): the row is KEPT.
  expect(opencodeBoxText(wrapped.replace(FOOTER, "  ┃  only draft row"))).toBe("only draft row");
  expect(opencodeBoxText(wrapped.replace(FOOTER, "  ┃  kept draft\n  ┃  also kept"))).toBe("kept draft\nalso kept");
  // The grammar itself, both spellings and the effort suffix.
  expect(opencodeBoxText(wrapped.replace(FOOTER, "  ┃  Plan · Some Model · high"))).toBe("");
  expect(opencodeBoxText(wrapped.replace(FOOTER, "  ┃  Build · GLM 5.2 TokenRouter"))).toBe("");
});

test("a deeply indented row is the overlay only past the measured overlay column", () => {
  // Measured geometry across all 17 captured boxes: the real overlay rows start
  // at columns 99 and 116, and every human draft starts at column 1 or 2. The
  // incumbent's threshold was "indented >= 5", which ate a five-space draft
  // silently after a partial backup. 40 sits in the middle of the measured gap.
  //
  // DEVIATION from the incumbent, deliberate and pending adjudication
  // (sol-ponytail-2 B1). No captured fixture changes answer — the two overlay
  // fixtures below still read empty — and the class of destroyed drafts shrinks
  // from "indented >= 5" to "indented >= 40".
  expect(opencodeBoxText(withRows("  ┃       indented draft"))).toBe("indented draft");
  expect(opencodeBoxText(withRows("  ┃     five"))).toBe("five");
  expect(opencodeBoxText(withRows("  ┃  " + " ".repeat(30) + "thirty-two in"))).toBe("thirty-two in");
  // Still the overlay: at and past the measured column.
  expect(opencodeBoxText(withRows("  ┃" + " ".repeat(40) + "~/work/x:"))).toBe("");
  expect(opencodeBoxText(withRows("  ┃" + " ".repeat(99) + "~/work/Example-Org/tap:"))).toBe("");
  for (const name of ["opencode-wide-idle", "opencode-wide-working"]) {
    expect(opencodeBoxText(readFileSync(fx + `peek-harness-adapters/${name}.ansi`, "utf8"))).toBe("");
  }
  // The residual runs the OTHER way now, and it is the recoverable direction: an
  // overlay drawn narrower than anything in the corpus would leak into the band,
  // the pane would read occupied, and delivery would park (announced) rather
  // than clobber (silent). A 20-column indent is therefore KEPT.
  expect(opencodeBoxText(withRows("  ┃" + " ".repeat(20) + "x"))).toBe("x");
});

test("absent box geometry is status 3, never an empty band", () => {
  expect(opencodeBoxText("no border here\njust text\n")).toBeNull();
  expect(opencodeBoxText("")).toBeNull();
  expect(classifyPane("no box at all", "opencode", false).kind).toBe("no-band");
  // A bottom border with NO bordered row above it is a partial redraw. The
  // incumbent walked the same way and printed "", which its callers read as a
  // readable EMPTY band — and native delivery then injects into a composer that
  // does not exist yet. Deviation from the incumbent, same polarity as the
  // ratified two (codex PR bot).
  expect(opencodeBoxText("  ╹▀▀▀▀▀\n")).toBeNull();
  expect(opencodeBoxText("transcript\n  ╹▀▀▀▀▀\nfooter below\n")).toBeNull();
  expect(classifyPane("  ╹▀▀▀▀▀\n", "opencode", false).kind).toBe("no-band");
  // One bordered row IS a band, even when it holds nothing.
  expect(opencodeBoxText("  ┃\n  ╹▀▀▀▀▀\n")).toBe("");
});

test("a terminal overprint cannot make the lone OpenCode footer prove an empty composer", () => {
  const torn = withRows(
    "  ┃",
    "  ┃  [claude-mem-capture] Worker POST failed: socket closed unexpec",
    "tedly. For more information, pass verbose: true",
  );
  expect(opencodeTerminalOverprint(torn)).toBe(true);
  expect(opencodeBoxText(torn)).toBeNull();
  expect(classifyPane(torn, "opencode", false)).toEqual({
    kind: "no-band",
    reason: "OpenCode terminal overprint obscures the composer",
    cause: "overprint",
  });
  const shouldNotCapture = { capture: () => { throw new Error("supplied frame was recaptured"); }, paneWidth: () => "120" };
  expect(pendingInputText(shouldNotCapture, "%1", "opencode", torn)).toEqual({ status: "overprint" });

  const oneLine = withRows(
    "  ┃  [claude-mem-capture] Worker POST failed: socket closed unexpectedly",
    "  ┃",
  );
  expect(opencodeTerminalOverprint(oneLine)).toBe(true);
  expect(opencodeBoxText(oneLine)).toBeNull();

  const retainedBlank = withRows(
    "  ┃  [claude-mem-capture] Worker POST failed: socket closed unexpec",
    "tedly. For more information, pass verbose: true",
    "  ┃",
  );
  expect(opencodeTerminalOverprint(retainedBlank)).toBe(true);
  expect(pendingInputText(shouldNotCapture, "%1", "opencode", retainedBlank)).toEqual({ status: "overprint" });

  // A user can type tagged failure text. Without the observed producer and
  // operation signature, content alone is not structural overprint evidence.
  const taggedDraft = withRows(
    "  ┃  [vite] error while compiling",
    "  ┃",
  );
  expect(opencodeTerminalOverprint(taggedDraft)).toBe(false);
  expect(opencodeBoxText(taggedDraft)).toBe("[vite] error while compiling");

  // Ordinary transcript above a complete, bordered empty box is not an
  // overprint. This control prevents a blanket "text above the footer" rule.
  expect(opencodeTerminalOverprint(wrapped)).toBe(false);
  expect(opencodeBoxText(wrapped)).toBe("");
});

// tap-vctb8: the ~190-char claude-mem stderr line paints from the cursor column
// and WRAPS onto the footer row or the `╹▀` corner row. Both geometry gates
// (no corner, footer not a footer) then return false before the tagged scan
// runs, the box reads no-band, and an idle seat spools busy:booting. These
// frames are reconstructions built on the captured all-wrapped-160 base —
// specimen bytes were never saved — painted the way a -e capture stores
// overprinted cells: default fg/bg (39/49), no composer colour.
const OC_MSG = "[claude-mem-capture] Worker POST /api/sessions/observations failed: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";
const DEFAULT_ATTRS = "\x1b[39m\x1b[49m";
const wrappedLines = () => wrapped.replace(/\n+$/, "").split("\n");
const ocCornerOf = (lines: string[]) => lines.findLastIndex(l => /^\s*╹▀/.test(l));
function painted(changes: Record<number, string>): string {
  const lines = wrappedLines();
  for (const [row, text] of Object.entries(changes)) lines[Number(row)] = text;
  return lines.join("\n") + "\n";
}

test("debris that wraps onto the footer row is still the overprint (tap-vctb8)", () => {
  const lines = wrappedLines();
  const footer = ocCornerOf(lines) - 1;
  const torn = painted({
    [footer - 1]: `${DEFAULT_ATTRS}     ${OC_MSG}`,
    [footer]: `${DEFAULT_ATTRS}closed unexpectedly. For more information`,
  });
  expect(opencodeTerminalOverprint(torn)).toBe(true);
  expect(opencodeBoxText(torn)).toBeNull();
  expect(pendingInputText(shouldNotCaptureIo(), "%1", "opencode", torn)).toEqual({ status: "overprint" });
});

test("debris that wraps onto the corner row is still the overprint (tap-vctb8)", () => {
  const lines = wrappedLines();
  const corner = ocCornerOf(lines);
  const torn = painted({
    [corner - 1]: `${DEFAULT_ATTRS}     ${OC_MSG}`,
    [corner]: `${DEFAULT_ATTRS}fetch() tail text`,
  });
  expect(opencodeTerminalOverprint(torn)).toBe(true);
  expect(opencodeBoxText(torn)).toBeNull();
  expect(pendingInputText(shouldNotCaptureIo(), "%1", "opencode", torn)).toEqual({ status: "overprint" });
});

test("a transcript row quoting the diagnostic is never an overprint (tap-vctb8)", () => {
  const lines = wrappedLines();
  const corner = ocCornerOf(lines);
  // Box top in this base is `corner - 4`; both quote rows sit ABOVE it, in the
  // transcript the unanchored scan must never reach.
  for (const row of [corner - 5, corner - 6]) {
    const quoted = painted({
      [row]: `     \x1b[38;2;238;238;238mthe pane showed ${OC_MSG}`,
    });
    expect(opencodeTerminalOverprint(quoted)).toBe(false);
    expect(opencodeBoxText(quoted)).toBe("");
    expect(pendingInputText(shouldNotCaptureIo(), "%1", "opencode", quoted)).toEqual({ status: "text", text: "" });
  }
});

test("corner-wrap detection comes from the in-box debris row, never from a transcript quote (tap-vctb8)", () => {
  const lines = wrappedLines();
  const corner = ocCornerOf(lines);
  const quote = `     \x1b[38;2;238;238;238mthe pane showed ${OC_MSG}`;
  const both = painted({
    [corner - 6]: quote,
    [corner - 1]: `${DEFAULT_ATTRS}     ${OC_MSG}`,
    [corner]: `${DEFAULT_ATTRS}fetch() tail text`,
  });
  expect(opencodeTerminalOverprint(both)).toBe(true);
  // Same transcript quote, box restored: no in-box debris, no overprint — the
  // quote alone must not trip the unanchored scan.
  const quoteOnly = painted({ [corner - 6]: quote });
  expect(opencodeTerminalOverprint(quoteOnly)).toBe(false);
  expect(opencodeBoxText(quoteOnly)).toBe("");
});

test("a real draft that contains the diagnostic is held as an overprint and never reads empty (tap-vctb8)", () => {  const lines = wrappedLines();
  const footer = ocCornerOf(lines) - 1;
  const pasted = painted({
    [footer - 2]: "  ┃  \x1b[38;2;238;238;238mfrom my log: [claude-mem-capture] Worker POST /api/sessions/observations failed: socket closed",
    [footer - 1]: "  ┃",
  });
  expect(opencodeTerminalOverprint(pasted)).toBe(true);
  // NEVER the unsafe direction: the band is held (no-band through the box
  // reader), never reported empty, so no key can be typed into the draft.
  expect(opencodeBoxText(pasted)).toBeNull();
  expect(pendingInputText(shouldNotCaptureIo(), "%1", "opencode", pasted)).toEqual({ status: "overprint" });
});

function shouldNotCaptureIo() {
  return { capture: () => { throw new Error("supplied frame was recaptured"); }, paneWidth: () => "120" };
}

test("the SGR walker consumes 38/48/58 operands as units and never reads a background as a foreground", () => {
  expect(fgAtGlyph("\x1b[48;2;128;128;128mx", "x")).toBeNull();
  expect(fgAtGlyph("\x1b[38;2;1;2;3mx", "x")).toEqual(["rgb", "1", "2", "3"]);
  expect(fgAtGlyph("\x1b[38;5;4mx", "x")).toEqual(["idx", "4"]);
  expect(fgAtGlyph("\x1b[31mx", "x")).toEqual(["basic", "31"]);
  expect(fgAtGlyph("\x1b[38;2;1;2;3m\x1b[39mx", "x")).toBeNull();
  expect(fgAtGlyph("\x1b[38;2;1;2;3m\x1b[0mx", "x")).toBeNull();
  // A MALFORMED operand run: marker+mode are consumed and the remainder falls
  // through to the basic branch, so `48;2;30;30` reads ["basic","30"]. Refusing
  // would be safer, and the note in the module says why it is not "fixed" here
  // rather than leaving the behavior undocumented. tmux emits well-formed SGR.
  expect(fgAtGlyph("\x1b[48;2;30;30mx", "x")).toEqual(["basic", "30"]);
  expect([...sgrRuns("a\x1b[31mb")].map(([fg, text]) => [fg?.join(":") ?? null, text]))
    .toEqual([[null, "a"], ["basic:31", "b"]]);
  // With no colour at all, the same-row overlay split returns the row whole.
  expect(stripGrayOverlay("  ┃  plain text", "  plain text")).toBe("  plain text");
});

// The REAL specimen (partner capture, sanitized: home path and model label
// swapped). The debris paints INSIDE a bordered row at the cursor column —
// footer and corner intact, SGR 39/49 default cells — and this is the bytes
// the seat actually went deaf on: detection was never the failure there.
const SPECIMEN = readFileSync(root + "runtime/bun/test/fixtures/opencode-capture/overprint-live-124.ansi", "utf8");
test("the live overprint specimen is detected, held as cause overprint, and never reads empty (tap-vctb8)", () => {
  expect(opencodeTerminalOverprint(SPECIMEN)).toBe(true);
  expect(opencodeBoxText(SPECIMEN)).toBeNull();
  expect(classifyPane(SPECIMEN, "opencode", false)).toEqual({
    kind: "no-band",
    reason: "OpenCode terminal overprint obscures the composer",
    cause: "overprint",
  });
  expect(pendingInputText(shouldNotCaptureIo(), "%1", "opencode", SPECIMEN)).toEqual({ status: "overprint" });
});
