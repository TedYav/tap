import { PYTHON_SPACE } from "./terminal-text";
/**
 * The OpenCode input box: the TYPED text inside it, chrome-free.
 *
 * ONE reader. The Bash twin (`tap_opencode_box_text`'s inline Python) is gone;
 * `tap_opencode_box_text` is now an adapter over this module, and
 * `submit-frame.ts` reads OpenCode through it instead of its own simpler
 * scanner. Those two disagreed on 8 of the 16 captured OpenCode fixtures in the
 * repo (tap-dcsg4) — the simpler one lacked the palette, overlay and padding
 * rules below, so a palette popup leaked into the draft and an idle wide pane
 * read as occupied. Every rule here was paid for by an incident; the comments
 * say which, because a reader who does not know the reason deletes the rule.
 *
 * Chrome inside the box (empirical, real 1.17.13 fixtures):
 *   - the `┃` border prefix on every line;
 *   - the mode·model footer (`Build · DeepSeek … · medium`), the box's last
 *     non-blank row in every capture — but popped by MATCHING that grammar, not
 *     by being last, because a box without one would otherwise lose a row of
 *     human text (`FOOTER_ROW`);
 *   - the right-aligned cwd/branch overlay drawn only at sidebar widths
 *     (`~/…/tap:`), which starts deep into the line — typed text renders at 2
 *     columns after the border and a wrapped continuation row starts there too,
 *     so a row whose content begins far to the right is overlay, never input.
 *     The threshold is `OVERLAY_MIN_INDENT`; the incumbent used 5, which read a
 *     five-space human draft as chrome (see that constant for what is measured
 *     and what is chosen);
 *   - the COMMAND-PALETTE POPUP (tap-e034), which opens the moment a `/` is
 *     typed and draws its item list INSIDE this same box region, above the
 *     typed row;
 *   - the first-load placeholder (`Ask anything... "Fix broken tests"`), which
 *     sits in the TYPED-TEXT position and is only distinguishable by STYLE.
 */

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/**
 * Python's whitespace and Python's LINE boundaries, because the reader this
 * replaces was Python and JavaScript agrees with it on neither.
 *
 * `trim()` treats U+FEFF as whitespace and Python does not, so a draft of
 * `<BOM>human draft` came back with the BOM eaten and a draft of a lone BOM came
 * back EMPTY — turning occupied input into a clear band. And `split("\n")` is
 * not `splitlines()`: Python also breaks on U+000B, U+000C, U+001C-U+001E,
 * U+0085, U+2028 and U+2029, so a draft containing NEL or LINE SEPARATOR was one
 * row to JavaScript and two to Python, which changed whether the row read as the
 * footer. Four measured differences, all found by review (partner review B2)
 * after the same class was fixed once already in the sentinel parser — the
 * second occurrence is why the definition is shared rather than re-spelled.
 */
const pyTrimStart = (text: string): string => text.replace(new RegExp(`^[${PYTHON_SPACE}]+`), "");
const pyTrim = (text: string): string => pyTrimStart(text).replace(new RegExp(`[${PYTHON_SPACE}]+$`), "");
/**
 * The column at or past which a box row is the right-aligned cwd/branch overlay
 * rather than typed text.
 *
 * WHAT IS MEASURED AND WHAT IS CHOSEN, because the distinction is the whole
 * value of this constant. Measured across
 * all 17 captured boxes: observed overlay rows start at columns 99 and 116,
 * observed drafts at 1 and 2 — wrapped continuations included, since a
 * continuation row starts at the left margin like any other typed row. So the
 * measured gap is [3, 98] and the incumbent's 5 sat inside the DRAFT class.
 * Chosen: 40, a policy pick inside that gap, not its onset. The overlay is
 * right-aligned, so its start column is roughly the content width minus the
 * overlay's length, and the width at which OpenCode begins drawing it is not
 * measured here — the 78-column captures draw none and the 124-column ones
 * start at 99. A long branch name on a pane just wide enough to draw the
 * overlay could therefore start below 40; that row would be kept, the pane
 * would read occupied, and delivery would park (announced) rather than clobber
 * (silent). Accepted residual, same polarity as the rest of this reader.
 */
const OVERLAY_MIN_INDENT = 40;

/** The mode·model row every captured box ends with: `Build · <model> [· <effort>]`. */
const FOOTER_ROW = new RegExp(`^[${PYTHON_SPACE}]*(?:Build|Plan)[${PYTHON_SPACE}]+·`);
const PY_LINE_BREAK = /\r\n|[\n\v\f\r\x1c\x1d\x1e\x85\u2028\u2029]/;
/** `str.splitlines()`: a trailing break yields no extra empty element. */
const pySplitlines = (text: string): string[] => {
  const lines = text.split(new RegExp(PY_LINE_BREAK.source, "g"));
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
};
const BORDER = "┃"; // ┃
const CORNER = "╹"; // ╹
/** The child-process diagnostic observed overwriting OpenCode's input rows. */
const OVERPRINT_DIAGNOSTIC = new RegExp(
  `^\\s*${BORDER}.*\\[claude-mem-capture\\]\\s+Worker\\s+POST\\b.*\\bfailed\\b`,
  "i",
);
/** The same producer-and-action signature without the border anchor: a wrapped
 * continuation paints from the cursor column and carries no `┃`. */
const OVERPRINT_DEBRIS = new RegExp(
  `\\[claude-mem-capture\\]\\s+Worker\\s+POST\\b.*\\bfailed\\b`,
  "i",
);
const BORDERED_ROW = new RegExp(`^\\s*${BORDER}`);
const CORNER_ROW = new RegExp(`^\\s*${CORNER}▀`);

/**
 * A child process can write directly to the terminal while OpenCode owns the
 * screen. OpenCode repaints only changed cells, so that output can split the
 * bordered input rows while leaving the mode footer and bottom border intact.
 * The old bottom-up reader then saw the footer as the entire box and reported
 * an empty composer — exactly the unsafe direction for delivery.
 *
 * A healthy empty composer has at least one bordered input row above its
 * footer. A footer that is the sole contiguous row above the bottom border is
 * chrome without an observable input band; the non-bordered row immediately
 * above it is the terminal overprint. The observed child diagnostic can also
 * retain one or more bordered input rows, so that observed producer-and-action
 * signature is recognized in the bounded tail independently of the geometry.
 */
export function opencodeTerminalOverprint(frame: string): boolean {
  return geometryOverprint(frame) || inBoxDebrisOverprint(frame);
}

/** The geometry-gated arm, verbatim: it owns the split-box verdicts the
 * unanchored scan below must not be asked to reproduce. */
function geometryOverprint(frame: string): boolean {
  const lines = pySplitlines(frame);
  const stripped = lines.map(line => line.replace(ANSI, ""));
  let border = -1;
  for (let i = 0; i < stripped.length; i++) if (CORNER_ROW.test(stripped[i]!)) border = i;
  if (border < 1) return false;
  let start = border;
  while (start > 0 && BORDERED_ROW.test(stripped[start - 1]!)) start--;
  const footer = stripped[border - 1]!.replace(BORDERED_ROW, "");
  if (!FOOTER_ROW.test(footer)) return false;
  for (let i = Math.max(0, start - 4); i < border - 1; i++) {
    if (OVERPRINT_DIAGNOSTIC.test(stripped[i]!)) return true;
  }
  if (border - start !== 1) return false;
  for (let i = start - 1; i >= Math.max(0, start - 3); i--) {
    if (!pyTrim(stripped[i]!)) continue;
    return !BORDERED_ROW.test(stripped[i]!);
  }
  return false;
}

/**
 * tap-vctb8 hardening for a reconstructed, not-yet-observed wrap shape. The
 * REAL specimen (overprint-live-124.ansi) paints the debris INSIDE a bordered
 * row — footer and corner intact — and the geometry arm above always detected
 * it; the seat went deaf because the pre-inject repaint had been dropped,
 * and senders saw "booting" because that label named any unobservable
 * OpenCode band. This arm covers the shape a ~190-char stderr line can also
 * take: painted from the cursor column it can WRAP, destroying the footer row
 * or the `╹▀` corner, after which the geometry gates above bail false before
 * any scan. It runs the SAME producer-and-action signature unanchored (no `┃`
 * required), anchored SPATIALLY at the box top: the first `┃` row of the
 * bottom-most contiguous `┃` run. A downward wrap paints over rows BELOW that
 * run's top and cannot erase it; rows above it are transcript, where quoting
 * the diagnostic must stay ready — and where a real draft pasted with the
 * signature is already held by the same verdict (no-band, never empty), so no
 * key can enter it.
 */
function inBoxDebrisOverprint(frame: string): boolean {
  const lines = pySplitlines(frame);
  const stripped = lines.map(line => line.replace(ANSI, ""));
  let runEnd = -1;
  for (let i = stripped.length - 1; i >= 0; i--) if (BORDERED_ROW.test(stripped[i]!)) { runEnd = i; break; }
  if (runEnd < 0) return false; // No composer box on screen: the geometry arm owns this frame.
  let top = runEnd;
  while (top > 0 && BORDERED_ROW.test(stripped[top - 1]!)) top--;
  for (let i = top; i < stripped.length; i++) {
    if (OVERPRINT_DEBRIS.test(stripped[i]!)) return true;
  }
  return false;
}

/** Empirically pinned; the fixtures catch drift. Tagged, see `fgAtGlyph`. */
const GRAY: Fg = ["rgb", "128", "128", "128"];

/**
 * A foreground reading. TAGGED so two colour spaces can never compare equal by
 * coincidence: `["rgb", r, g, b]`, `["idx", n]`, `["basic", n]`. Callers only
 * ever compare two readings from the SAME capture, so the tag is what keeps
 * `38;5;4` and basic `34` distinct — a bare number is correct in every test
 * that can be written today, and wrong the first time one frame mixes
 * encodings, because a popup border would then read as the border of the box
 * itself (tap-d901).
 */
type Fg = [string, ...string[]];

const sameFg = (a: Fg | null, b: Fg | null): boolean =>
  a === null || b === null ? a === b : a.length === b.length && a.every((part, i) => part === b[i]);

/**
 * Yield `[fg, text]` for each text run of an escaped capture line.
 *
 * ONE walker over the SGR grammar, because two implementations of one grammar
 * are a drift surface whether or not they currently agree. The Bash file used to
 * carry two WALKERS — one inside `fg_at_glyph`, one inside `has_nongray_text` —
 * and the older copy did not know `38;5` or basic at all, so the same escape
 * stream produced different answers depending on which function asked. Sharing
 * one walker makes the remedy the strong one: delete a copy rather than pin the
 * pair in lockstep.
 *
 * `fg` is null when no colour is in effect. 38, 48 and 58 all take operands and
 * are consumed as units; only 38 sets a reading, so a background can never be
 * mistaken for a foreground.
 */
export function* sgrRuns(raw: string): Generator<[Fg | null, string]> {
  let fg: Fg | null = null;
  for (const part of raw.split(/(\x1b\[[0-9;]*m)/)) {
    if (!part) continue;
    if (!part.startsWith("\x1b[")) { yield [fg, part]; continue; }
    const params = (part.slice(2, -1) || "0").split(";");
    let i = 0;
    while (i < params.length) {
      const p = params[i] || "0";
      if ((p === "38" || p === "48" || p === "58") && i + 1 < params.length) {
        const mode = params[i + 1];
        if (mode === "2" && i + 4 < params.length) {
          if (p === "38") fg = ["rgb", params[i + 2]!, params[i + 3]!, params[i + 4]!];
          i += 5;
          continue;
        }
        if (mode === "5" && i + 2 < params.length) {
          if (p === "38") fg = ["idx", params[i + 2]!];
          i += 3;
          continue;
        }
        // MALFORMED OPERAND RUN. Consuming marker+mode only is a DEFENSIBLE
        // CHOICE UNDER GENUINE GRAMMAR AMBIGUITY, not an oversight — a
        // truncated `48;2;30;30` cannot be told apart from a `48;2` followed by
        // other params without deciding what a malformed stream MEANS, and the
        // grammar does not say. What it costs is real and measured (a
        // 60-case review): partial operands fall through to the basic
        // branch below, so `48;2;30;30` reads `["basic","30"]` where refusing
        // would read null. Not production-reachable — tmux emits well-formed
        // SGR — which is why it is documented rather than guessed at. DO NOT
        // "fix" this by skipping three params unconditionally: that would
        // silently swallow a real, well-formed sequence following a truncated
        // one. If it is ever closed, the safe direction is fg = null and
        // consume the remainder, restoring "we cannot read this".
        i += 2;
        continue;
      }
      const code = Number(p);
      if (/^\d+$/.test(p) && ((code >= 30 && code <= 37) || (code >= 90 && code <= 97))) {
        fg = ["basic", p];
        i += 1;
        continue;
      }
      if (p === "0" || p === "39") fg = null;
      i += 1;
    }
  }
}

/** The foreground colour active when `glyph` is first painted, or null. */
export function fgAtGlyph(raw: string, glyph: string): Fg | null {
  for (const [fg, text] of sgrRuns(raw)) if (text.includes(glyph)) return fg;
  return null;
}

/**
 * Does this row carry text that is not the pinned placeholder gray?
 *
 * The COMPARISON stays truecolor-only on purpose. GRAY is an empirically pinned
 * (128,128,128); there is no principled 256-colour or basic equivalent, and
 * inventing one would guess in the direction where a wrong guess reclassifies a
 * real draft as chrome — the data-loss direction this reader refuses everywhere
 * else. So under a `38;5` or basic theme a non-rgb reading simply is not GRAY,
 * the text counts as typed, and the row is KEPT. The placeholder is therefore
 * not filtered under those themes: a spurious draft, which costs a backup and a
 * clear of chrome, and is the safe side of tap-d901's polarity. What tap-d901
 * closed here is WALKER DRIFT, not a theme-wide placeholder filter.
 */
export function hasNongrayText(raw: string): boolean {
  for (const [fg, text] of sgrRuns(raw)) {
    for (const ch of text) {
      if (new RegExp(`[${PYTHON_SPACE}]`).test(ch) || ch === BORDER) continue; // spaces + the border glyph
      if (!sameFg(fg, GRAY)) return true;
    }
  }
  return false;
}

/**
 * Drop the SAME-ROW right-aligned overlay from one box row (tap-vp7j).
 *
 * OpenCode draws its cwd/branch overlay on the same row as the typed text at
 * some widths. The whole-row rule below only knows overlay ROWS (content
 * starting at or past `OVERLAY_MIN_INDENT`); a row that starts with typed text
 * at 2 columns kept the overlay glued on, and the exact-match clear could then
 * never be true.
 *
 * The split is BY STYLE, and that choice is load-bearing rather than
 * convenient. A live capture paints the overlay in exactly the gray already
 * pinned as chrome here while typed text is bright, so this reads GRAY rather
 * than re-hardcoding the triple at a second site. A whitespace-width cut would
 * have been the obvious alternative and is the dangerous one: a draft may
 * legitimately contain a long internal run of spaces, and this reader feeds the
 * pending-input BACKUP, so cutting there destroys text the clobber then clears.
 * A style split never asks about spaces, so that hazard is absent rather than
 * managed.
 *
 * Polarity follows tap-d901: with no colour information at all, KEEP the row
 * whole. A leaked overlay makes the exact match fail and the clear refuse,
 * which is recoverable and announced; a wrong cut is silent and is not.
 */
export function stripGrayOverlay(raw: string, content: string): string {
  const kept: string[] = [];
  let sawColour = false;
  for (const [fg, text] of sgrRuns(raw)) {
    if (fg !== null) sawColour = true;
    if (!sameFg(fg, GRAY)) kept.push(text);
  }
  if (!sawColour) return content;
  // Drop only the LEADING border glyph, exactly as the caller does for content.
  // A blanket removal would eat a border glyph a draft legitimately contains.
  const text = kept.join("").replace(new RegExp(`^\\s*${BORDER}`), "");
  return pyTrim(text) ? text : content;
}

/**
 * The typed text inside the box, or null when no box is present (the Bash
 * twin's status 3 — absent geometry is never evidence of a clear band).
 */
export function opencodeBoxText(frame: string): string | null {
  if (opencodeShellMode(frame)) return null;
  if (opencodeTerminalOverprint(frame)) return null;
  const lines = pySplitlines(frame);
  const stripped = lines.map(line => line.replace(ANSI, ""));
  let border = -1;
  for (let i = 0; i < stripped.length; i++) if (new RegExp(`^\\s*${CORNER}▀`).test(stripped[i]!)) border = i;
  if (border < 0) return null;
  let start = border;
  while (start - 1 >= 0 && new RegExp(`^\\s*${BORDER}`).test(stripped[start - 1]!)) start--;
  // A bottom border with NO bordered row above it is a partial redraw, not an
  // empty composer. The incumbent Python walked the same way and printed "",
  // which its callers read as a readable empty band — and native delivery then
  // injects into a composer that does not exist yet. The old native scanner had
  // this right (`if (top === bottom) return null`), so unifying naively took the
  // less safe of the two answers. Absent geometry is status 3 / `no-band`, which
  // is the documented "nothing readable was here", and the named booting defer
  // is what should handle it.
  //
  // Third deviation from the incumbent, same polarity and same class as the two
  // the leader ratified: when the reading is unconvincing, do not report a clear
  // band. Found in review.
  if (start === border) return null;
  const rows: [string, string][] = [];
  for (let i = start; i < border; i++) rows.push([lines[i]!, stripped[i]!.replace(new RegExp(`^\\s*${BORDER}`), "")]);
  while (rows.length && !pyTrim(rows.at(-1)![1])) rows.pop();
  // The mode·model footer, popped only when the row IS one.
  //
  // The incumbent popped the last row unconditionally, on the premise that the
  // footer is always the box's last non-blank row. On every capture in the repo
  // that premise holds — all 17 match this grammar — so the two rules agree on
  // real input. They part on a box with NO footer, where the unconditional pop
  // eats a row of human text, and this reader feeds the pending-input BACKUP, so
  // an eaten row means the clobber clears text nothing can recover.
  //
  // KEEP is therefore the polarity here, the same one the popup rule already
  // uses: unrecognized chrome leaking into the band makes a pane read occupied
  // and delivery park, which is announced and recoverable; eating a draft is
  // silent and is not. Deviation from the incumbent, named rather than implied
  // (partner review B1).
  if (rows.length && FOOTER_ROW.test(rows.at(-1)![1])) rows.pop();

  // Command-palette popup rows (tap-e034). Two conditions, both required,
  // because "ends with the border glyph" ALONE would eat a human draft row that
  // happens to end in one (a pasted box diagram) — and this extractor also
  // feeds the pending-input BACKUP, so dropping a row there means the
  // exact-mode clobber backs up part of a draft and then clears all of it,
  // leaving text `tap draft` can never recover.
  //   1. The popup is a contiguous run at the TOP of the region: it is always
  //      drawn above the typed area, so a draft row below it is never a
  //      candidate.
  //   2. Its border is painted a DIFFERENT colour from the border of the box,
  //      read from the bottom-left corner glyph rather than hardcoded, so it
  //      calibrates to whatever theme is live. A row whose left border carries
  //      the accent of the box itself is typed text, whatever it ends with.
  // DEGRADATION: when a capture carries no SGR at all (mocks, older fixtures)
  // the colour condition is UNAVAILABLE, not satisfied — and an unavailable
  // reading STOPS the strip rather than licensing it, so the row is KEPT.
  const boxFg = fgAtGlyph(lines[border]!, CORNER);
  let popupRows = 0;
  for (const [raw, content] of rows) {
    if (!content.replace(new RegExp(`[${PYTHON_SPACE}]+$`), "").endsWith(BORDER)) break;
    const rowFg = fgAtGlyph(raw, BORDER);
    // POLARITY (tap-d901): an UNAVAILABLE colour reading stops the strip, it
    // does not license it. Eating a row is destructive for one consumer and
    // merely inconvenient for the other: this extractor feeds both the
    // exact-match clear, where a wrongly-kept popup row means a refused clear
    // (recoverable, and the caller is told), and the pending-input BACKUP,
    // where a wrongly-eaten row means the clobber clears text that was never
    // saved (unrecoverable, silent). "Fail-closed" is only a safety property
    // when the failure is a REFUSAL, so the two consumers cannot share one
    // polarity — and the one that protects the unrecoverable side is: when in
    // doubt, KEEP.
    //
    // NOT EVERY CONSUMER PREFERS THIS (found in review). `tap nudge`
    // parses the region through the stuck-sentinel reader, which requires the
    // region to BE the sentinel, so leaked chrome makes it refuse with a
    // malformed-sentinel error. That strictness is deliberate: it stops nudge
    // pressing Enter on a band that also holds human text. KEEP is still
    // chosen, because nudge's failure under leak is a LOUD REFUSAL an operator
    // can act on, while eat's failure is a draft cleared after a partial
    // backup, which is silent and unrecoverable. Confined to the no-colour
    // case; with colour readable, chrome is stripped and nudge is unaffected.
    if (boxFg === null || rowFg === null || sameFg(rowFg, boxFg)) break;
    popupRows++;
  }

  const typed: string[] = [];
  for (const [raw, content] of rows.slice(popupRows)) {
    if (!pyTrim(content)) continue;
    // The right-aligned overlay, as a whole row.
    //
    // The rule is load-bearing rather than redundant with the style rule above:
    // the overlay is only PARTLY gray (`~/work/` painted, `tap:` not),
    // so on `opencode-wide-idle`, `-wide-working`, `-overlay-samerow` and
    // `-overlay-widespace-draft` dropping it entirely leaves `tap:` or
    // `opencode-` behind as a phantom draft — an IDLE pane that reads occupied,
    // which parks delivery forever. Measured, not assumed.
    //
    // But the incumbent's threshold was "indented >= 5 columns", and that eats a
    // human draft indented five spaces — silently, after a partial backup, which
    // is the unrecoverable direction this reader refuses everywhere else.
    //
    // The geometry says 5 was far too low. Measured across all 17 captured boxes
    // (a right-edge probe script): the real overlay rows start at
    // columns 99 and 116, and every human draft — including the wide-internal-
    // space one and the wrapped multi-row ones — starts at column 1 or 2. A
    // wrapped continuation row also starts at the left margin, so length alone
    // never pushes typed text rightward. The threshold therefore sits in the
    // middle of a measured gap rather than at its edge.
    //
    // Deviation from the incumbent, named rather than implied (partner review
    // B1, ratified): no captured fixture changes answer, and the
    // destroyed-draft class shrinks from "indented >= 5" to
    // "indented >= OVERLAY_MIN_INDENT".
    //
    // The residual, stated rather than hidden: an overlay drawn at a narrower
    // width than any capture in the corpus would leak into the band, and a
    // leaked row makes the pane read occupied so delivery PARKS. That is the
    // announced, recoverable failure; eating a draft is the silent one. If a
    // real capture ever shows an overlay below this column, the fix is the
    // pane's true right edge, which these rstripped captures cannot supply —
    // tap-dcsg4, not a guess here.
    const indent = content.length - pyTrimStart(content).length;
    if (indent >= OVERLAY_MIN_INDENT) continue;
    if (!hasNongrayText(raw)) continue; // all-gray row = placeholder chrome
    typed.push(pyTrim(stripGrayOverlay(raw, content)));
  }
  return typed.join("\n");
}

/** A live shell composer is not a chat input, even when it contains a TAP marker. */
export function opencodeShellMode(frame: string): boolean {
  const lines = frame.replace(ANSI, "").split("\n");
  let border = -1;
  for (let i = 0; i < lines.length; i++) if (CORNER_ROW.test(lines[i]!)) border = i;
  if (border < 1 || !/^\s*┃\s+Shell(?:\s|$)/.test(lines[border - 1]!)) return false;
  return lines.slice(border + 1, border + 5).some(line => /\besc\s+exit shell mode\b/.test(line));
}
export const OPENCODE_SHELL_MODE_REASON = "OpenCode shell mode blocks chat delivery; exit shell mode before retrying";
