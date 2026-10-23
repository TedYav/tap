import { POSIX_LOCALE_SPACE, codexPlaceholder, dimPlaceholder, readStdinFrame, withoutCodexPaint } from "./terminal-text";

/** Codex paint is chrome, never input — the one definition lives in terminal-text. */
export { withoutCodexPaint };
import { opencodeBoxText } from "./opencode-composer";
// A submission decision uses one joined frame, never an id's disappearance alone.
import { capturePane, isOpenCodeCommand, normalizeInputMatch, promptLineRe, promptRowReAwk, tmux } from "./tmux";
import { classifyPane, claudeActiveBoxRange, claudeBox, claudeFeedbackOverlay, claudeQueuedRows, isPasteCollapse } from "./pane-state";
import { agentAtRest, approvalPrompt, detectAgentState } from "./agent-state";
import { parseStuckSentinel } from "./stuck-sentinel";
import { matchSentinelSuffix, sentinelShapedInput } from "./sentinel-tail";
import { dimPromptInput, promptGlyph } from "./pane/geometry";

export type SubmitFrame = { state: "staged" | "empty" | "queued" | "changed" | "unobservable"; mode: "idle" | "working" | "mid-turn"; width: string; fused?: boolean;
  /** OpenCode and Claude: the same detectAgentState reading the generic queue arm consumes (tap-ho6pk, tap-7txco). */
  busy?: boolean;
  /** The queue verdict was inferred from "wire + working" and may be relabeled from pre-Enter evidence. */
  inferred?: boolean;
  /** Claude only: `staged` was proven from the visible wrapped SUFFIX of the
   * input, because the composer viewport has scrolled its head out of frame.
   * A typed `/compact` control (tap-vho8h) sets it only when the caller opted
   * in with `scrolledControl`; an ordinary wire sets it whenever its tail is
   * recognized by the shared suffix rule (tap-1ncs6, `sentinel-tail.ts`). */
  scrolled?: boolean;
  /** Claude's feedback-draft panel is up: no authority may press Enter (tap-89a57).
   * An approval prompt or trust dialog is up: no authority may press Enter either,
   * since Enter selects its highlighted choice (tap-rlebf.1). */
  held?: "feedback-draft" | "approval" };

/** Cursor warning tints recolor the composer; only its closed borders bound it. */
export function cursorComposer(frame: string): string | null {
  const raw = frame.split("\n");
  const lines = raw.map(line => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trimEnd());
  let end = -1, start = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^\s*▀{10,}\s*$/.test(lines[i]!)) { end = i; break; }
  if (end < 0 || lines.slice(end + 1).some(line => /^\s*(?:→|▄{10,})/.test(line))) return null;
  for (let i = end - 1; i >= 0; i--) if (/^\s*▄{10,}\s*$/.test(lines[i]!)) { start = i; break; }
  if (start < 0) return null;
  const box = lines.slice(start + 1, end);
  const prompt = box.findIndex(line => /^\s*→/.test(line));
  if (prompt < 0 || box.slice(0, prompt).some(line => line.trim())) return null;
  const rows = box.slice(prompt);
  rows[0] = rows[0]!.replace(/^\s*→\s*/, "");
  while (rows.length && !rows.at(-1)!.trim()) rows.pop();
  const text = rows.join("\n").trim();
  if (/^(Add a follow-up|Plan, search, build anything)(\s+ctrl\+c to stop)?$/.test(text)
      && dimPlaceholder(raw[start + 1 + prompt]!, text)) return "";
  return text;
}

/** One shared Antigravity band anchor for input and post-band modal chrome. */
function agyBand(frame: string): { lines: string[]; top: number; bottom: number } | null {
  const lines = frame.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split("\n");
  const rule = (line: string) => /^─{10,}$/.test(line.trim());
  let bottom = -1, top = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!rule(lines[i]!)) continue;
    if (bottom < 0) { bottom = i; continue; }
    let first = i + 1;
    while (first < bottom && !lines[first]!.trim()) first++;
    if (first < bottom && /^\s*>/.test(lines[first]!)) { top = i; break; }
    bottom = i;
  }
  if (top < 0) return null;
  return { lines, top, bottom };
}

/** Preserved CLI 1.1.16 survey: terminal question/options immediately above
 * the Gemini footer. Quoted transcript or composer text cannot supply this tail.
 */
export function agySurveyOverlay(frame: string): boolean {
  const lines = frame.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split("\n").map(line => line.trim()).filter(Boolean);
  if (lines.length < 3) return false;
  const footer = lines.at(-1)!;
  return /^(?:\? for shortcuts|esc to cancel)\s+Gemini \S.* · \S.*$/.test(footer)
    && /^\[1\] Good\s+\[2\] Fine\s+\[3\] Bad\s+\[0\] Skip$/.test(lines.at(-2)!)
    && /^(?:How's|How is) the CLI experience so far\? Help us improve:$/.test(lines.at(-3)!);
}

/** Existing Antigravity prompt-pair geometry; footer/task cards are outside input. */
export function agyComposer(frame: string): string | null {
  const band = agyBand(frame);
  if (!band) return null;
  const { lines, top, bottom } = band;
  const rows = lines.slice(top + 1, bottom);
  while (rows.length && !rows.at(-1)!.trim()) rows.pop();
  const typed = rows.map(line => line.replace(/^\s*>\s?/, ""));
  return typed.some(line => line.trim()) ? typed.join("\n") : "";
}

/** Full AGY wire equality modulo renderer-only padding and visual wrapping.
 * The caller separately requires a successfully parsed matching sentinel id,
 * so whitespace inserted into the wire grammar cannot create authority. */
export function agyReprobeInputMatches(actual: string, expected: string): boolean {
  return normalizeInputMatch(actual) === normalizeInputMatch(expected);
}

/** Modal chrome only: transcript above the band and task-card commands are data.
 * The six-row window preserves the constructed Bash control; tap-lslrc owns
 * calibration against a real permission overlay (fleet prompts are disabled).
 */
export function agyPermissionOverlay(frame: string): boolean {
  if (approvalPrompt("agy", frame)) return true;
  const band = agyBand(frame);
  if (!band) return false;
  let ask = -1;
  for (let i = band.bottom + 1; i < band.lines.length; i++) {
    const line = band.lines[i]!;
    if (/^\s*[●○]\s*\[\d{2}:\d{2}:\d{2}\]/.test(line)) continue;
    const lower = line.toLowerCase();
    if (lower.includes("requesting permission for:")) ask = i;
    if (ask >= 0 && i - ask <= 6 && (lower.includes("do you want to proceed?") || lower.includes("tab amend"))) return true;
  }
  return false;
}

/** Full equality modulo corroborated Claude word wrapping of an emitted control. */
export function claudeWrappedControlMatches(frame: string, expected: string): boolean {
  const box = claudeBox(frame);
  return !!box && box.typed.includes("\n") && claudeControlRowsMatch(box.typed, expected, box.columns);
}

const CLAUDE_CONTROL_SHAPE = /^\/(?:compact|goal|loop) .* \[\[sv:[A-Za-z0-9_-]+\]\]$/;

/** Only known single-cell characters participate in a wrap proof. Unicode
 * arrows and accented letters occupy one cell too; ASCII-only matching made
 * the courier take its own fully rendered /compact back before Enter.
 * Wide, combining, control and intentionally multiline input stay exact-only. */
function claudeWrapProvable(want: string): boolean {
  return ![...want].some(char => char.length !== 1 || /[\p{C}\p{M}\p{Z}]/u.test(char) && char !== " " || Bun.stringWidth(char) !== 1);
}

/**
 * The visible wrapped SUFFIX of a typed `/compact` control whose command row
 * has scrolled out of the composer viewport (tap-vho8h). Claude keeps the
 * prompt glyph on the first VISIBLE row and shows the last N layout rows, so
 * the box reads as prose that merely ends in our marker. This proof anchors
 * at that marker and walks backward: every visible row must be an exact
 * width-bounded slice of the control under the same wrap rules as the full
 * match, and the rows together must end exactly at the control's end. The
 * first visible row is a partial cut; a prompt glyph on it does not make it
 * the start of the control. Exactly one alignment may satisfy this; zero or
 * two refuse. A whole-control match is not this function's business, and the
 * head is never inferred from here: the typed-prefix arm proved it on the
 * prompt line before any payload chunk (courier `typedControlBody`).
 */
export function claudeScrolledControlMatches(frame: string, expected: string): boolean {
  const box = claudeBox(frame);
  if (!box) return false;
  const want = expected.normalize("NFC").trim();
  if (!/^\/compact .* \[\[sv:[A-Za-z0-9_-]+\]\]$/.test(want) || !claudeWrapProvable(want)) return false;
  const typed = box.typed.normalize("NFC").trim();
  if (!typed || typed === want) return false;
  const rows = typed.split("\n");
  const first = rows[0]!.replace(/ +$/, "");
  if (!first) return false;
  const capacity = box.columns - 3;
  let alignments = 0;
  // A scrolled first row starts strictly inside the control (offset 0 is the
  // unscrolled shape, owned by claudeControlRowsMatch).
  for (let start = want.indexOf(first, 1); start > 0; start = want.indexOf(first, start + 1)) {
    if (claudeRowsMatchFrom(rows, want, start, capacity)) alignments++;
    if (alignments > 1) return false;
  }
  return alignments === 1;
}

function claudeControlRowsMatch(typed: string, expected: string, columns: number): boolean {
  const want = expected.normalize("NFC").trim();
  if (typed.normalize("NFC").trim() === want) return true;
  if (!claudeWrapProvable(want) || !CLAUDE_CONTROL_SHAPE.test(want)) return false;
  const rows = typed.normalize("NFC").trim().split("\n");
  // The older saved renderer reserves four columns. Claude 2.1.280 can fill
  // one more cell but wraps before adding a word that reaches that last cell.
  // Both shapes still require the complete payload and width-bounded wrapping.
  return claudeRowsMatchFrom(rows, want, 0, columns - 3);
}

/** Rows are consecutive layout rows of `want` from `offset`, ending exactly at its end. */
function claudeRowsMatchFrom(rows: string[], want: string, offset: number, capacity: number): boolean {
  for (const [index, rendered] of rows.entries()) {
    let row = rendered;
    if (index) {
      if (!row.startsWith("  ")) return false;
      row = row.slice(2);
    }
    row = row.replace(/ +$/, "");
    if (!row || row.length > capacity || !want.startsWith(row, offset)) return false;
    offset += row.length;
    if (index < rows.length - 1) {
      const atSpace = want[offset] === " ";
      const spaces = atSpace ? want.slice(offset).match(/^ +/)![0].length : 0;
      const nextWord = want.slice(offset + spaces).split(" ")[0]!;
      // A short hard split could be an actual typed newline, not a visual wrap.
      // Claude 2.1.280 is not a fixed-width greedy wrapper: across 38 live
      // frames at 69, 100 and 145 columns a word ending exactly at box width
      // minus four sometimes stays and sometimes wraps (tap-arm4w), so a break
      // is natural when the next word would reach either of the last two cells.
      if (!nextWord) return false;
      if (atSpace) {
        // Rendered trailing spaces are gone: a hidden multi-space run has no
        // independent count witness. Keep the single-separator wrap contract.
        if (spaces !== 1) return false;
        if (row.length + spaces + nextWord.length < capacity - 1) return false;
        offset += spaces;
      } else {
        // A path or another long token can fill the row and continue without
        // a space. Only a full-width row proves that hard wrap; short splits
        // still refuse. The next row must match the next exact payload byte.
        if (row.length < capacity - 1) return false;
      }
    }
  }
  return offset === want.length;
}

/**
 * One logical draft line laid out as `rows` (de-indented, as `claudeDraftRows`
 * reports them) under the same wrap rules as the control proof. `start > 0`
 * means the first row is a scrolled partial cut of the line (tap-ipex2); count
 * how many offsets fit so a caller can insist on exactly one.
 */
function draftLineAlignments(rows: string[], line: string, capacity: number, partial: boolean): number {
  if (!partial && rows.length === 1) return rows[0] === line ? 1 : 0;
  const want = line.normalize("NFC");
  if (!rows[0] || !claudeWrapProvable(want)) return 0;
  const drawn = rows.map((row, i) => (i ? "  " : "") + row.normalize("NFC"));
  if (!partial) return claudeRowsMatchFrom(drawn, want, 0, capacity) ? 1 : 0;
  let alignments = 0;
  for (let start = want.indexOf(drawn[0]!, 1); start > 0 && alignments < 2; start = want.indexOf(drawn[0]!, start + 1)) {
    if (claudeRowsMatchFrom(drawn, want, start, capacity)) alignments++;
  }
  return alignments;
}

/** A soft-wrapped logical line captured row by row must be a layout the soft-wrap layout walker accepts. */
export function claudeWrappedLineMatches(rows: string[], line: string, columns: number): boolean {
  return draftLineAlignments(rows, line, columns - 3, false) === 1;
}

/**
 * The visible Claude composer rows end the draft `text` (tap-ipex2): a typed
 * newline forces a row break, and each logical line is laid out through the soft-wrap layout
 * walker. Only a `scrolled` viewport (the caller saw it stop growing) may hide
 * lines above or cut the top row; otherwise the rows must be the whole draft.
 * Exactly one parse may hold; zero or two refuse. Anchored at the end, where the cursor is.
 */
export function claudeDraftTailMatches(rows: string[], text: string, columns: number, scrolled = false): boolean {
  const lines = text.split("\n").map(line => line.replace(/[ \t\u00a0]+$/, ""));
  const capacity = columns - 3;
  const memo = new Map<string, number>();
  // Parses of rows[0..r) as the tail of lines[0..l), capped at two.
  const parses = (r: number, l: number): number => {
    if (r === 0) return l === 0 || scrolled ? 1 : 0;
    if (l === 0) return 0;
    const key = `${r}:${l}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let count = 0;
    for (let take = 1; take <= r && count < 2; take++) {
      const segment = rows.slice(r - take, r), line = lines[l - 1]!;
      if (draftLineAlignments(segment, line, capacity, false)) count += parses(r - take, l - 1);
      if (take === r && scrolled) count += draftLineAlignments(segment, line, capacity, true);
    }
    memo.set(key, Math.min(count, 2));
    return Math.min(count, 2);
  };
  return rows.length > 0 && parses(rows.length, lines.length) === 1;
}

/**
 * One clear key's effect on the visible composer rows (tap-ipex2): the bottom
 * row shortened or `removed` whole, and at most one row `revealed` above the old top
 * because the viewport follows the cursor. Every other row is unchanged. A reveal
 * needs rows hidden above, so a viewport already seen below full height (`mayReveal`
 * false) shows them all. Exactly one alignment may hold, as in the scrolled-control
 * proof; null otherwise.
 */
export function alignClearFrame(prev: string[], next: string[], mayReveal = true): { revealed: 0 | 1; removed: number } | null {
  const fits = (mayReveal ? [0, 1] as const : [0] as const).filter(m => {
    const k = next.length - m;
    // One key changes only the bottom: it shortens the last row, or removes it whole
    // and leaves the row above untouched. Never both, never two rows.
    if (k < 1 || k > prev.length || k < prev.length - 1) return false;
    for (let i = 0; i < k - 1; i++) if (next[m + i] !== prev[i]) return false;
    return k === prev.length ? prev[k - 1]!.startsWith(next[m + k - 1]!) : prev[k - 1] === next[m + k - 1];
  });
  return fits.length === 1 ? { revealed: fits[0]!, removed: prev.length - (next.length - fits[0]!) } : null;
}

/** Claude 2.1.282's queued control: the exact owned command above its send-now
 * cue, and an active composer holding the queue-edit hint. Neither a transcript
 * occurrence nor the hint alone proves acceptance. Paint is not required. */
function claudeQueuedControlMatches(frame: string, expected: string): boolean {
  if (!/^\/compact .* \[\[sv:[A-Za-z0-9_-]+\]\]$/.test(expected)) return false;
  const range = claudeActiveBoxRange(frame), box = claudeBox(frame);
  if (!range || !box || box.typed !== "Press up to edit queued messages") return false;
  const lines = frame.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split("\n");
  // The closest send-now cue belongs to the last queued message. Stop at any
  // other prompt, so an older transcript control cannot authorize this one.
  for (let end = range.top - 2; end >= 0; end--) {
    if (/^[ \t]*[›❯]/.test(lines[end]!)) return false;
    if (!/^[ \t]+ctrl\+x ctrl\+s to send now[ \t]*$/.test(lines[end]!)) continue;
    const rows: string[] = [];
    for (let at = end - 1; at >= 0; at--) {
      const line = lines[at]!.replace(/[ \t]+$/, "");
      const prompt = line.match(/^[ \t]*[›❯][ \t\u00a0]?(.*)$/);
      if (prompt) return claudeControlRowsMatch([prompt[1]!, ...rows].join("\n"), expected, box.columns);
      if (!line.startsWith("  ") || !line.trim()) return false;
      rows.unshift(line);
    }
    return false;
  }
  return false;
}

/** Closed OpenCode input band; footer is its last nonempty left-border row. */
/**
 * The OpenCode composer, through the ONE reader in `opencode-composer.ts`.
 *
 * This used to be a second, simpler scanner: box borders, trailing blanks, a
 * `Build|Plan ·` footer row, a dim-placeholder check. It disagreed with the
 * Bash/Python reader on 8 of the 16 captured OpenCode fixtures in the repo
 * (tap-dcsg4), and every disagreement was a rule it did not have — the
 * command-palette popup leaked into the draft, the right-aligned cwd/branch
 * overlay came back AS a draft (so an idle wide pane classified as occupied and
 * native delivery parked instead of injecting), and per-row padding survived.
 * Since this feeds `readFrame` -> `classifyPane` -> `paneState`/`observePaneKind`
 * -> `deliver.ts`/`courier.ts`, those were live native-delivery answers, not a
 * dark path.
 */
function opencodeInput(frame: string): string | null {
  return opencodeBoxText(frame);
}

/**
 * Hermes paints a full-width rule bar under the live composer; the rows from
 * that bar down are footer and spinner chrome, never input. The bar must be
 * real footer geometry — pane scale (>= 40 columns) and paired with the
 * composer's matching top rule — so a user's line of box-drawing characters is
 * never mistaken for the bar and truncated. Text below the bar is NOT
 * corroboration: a draft row after a user's own wide rule is input too. Every
 * real Hermes fixture paints the matching top rule. Hermes paints its bar below
 * every input row, so the LAST matching rule is the bar: a user's own
 * pane-width rule above it stays input, with the text after it (tap-rhajr
 * review). Returns the exclusive end of the composer rows that start at the
 * prompt row `start`.
 */
function hermesComposerEnd(lines: string[], start: number): number {
  const barWidth = (line: string): number => {
    const t = line.trim();
    return t.length >= 40 && /^─+$/.test(t) ? t.length : -1;
  };
  for (let i = lines.length - 1; i > start; i--) {
    const width = barWidth(lines[i]!);
    if (width < 0) continue;
    if (lines.slice(0, start).some(l => barWidth(l) === width)) return i;
  }
  return lines.length;
}

/**
 * Hermes soft-wraps its composer at the cell, not the word (tap-rhajr: a wire
 * split as `…and wil` / `l snapshot…`). A row that fills the pane continues on
 * the next one, so the two join with nothing; any shorter row is a real line
 * break. `rows[0]` still carries its prompt, which occupies cells. Without a
 * known width no row is provably full, and the rows stay as captured.
 */
function hermesUnwrap(rows: string[], width: string): string[] {
  const columns = /^[0-9]+$/.test(width) ? Number(width) : 0;
  if (!columns) return rows;
  const out = [rows[0]!];
  for (let i = 1; i < rows.length; i++) {
    if (Bun.stringWidth(rows[i - 1]!) >= columns) out[out.length - 1] += rows[i]!;
    else out.push(rows[i]!);
  }
  return out;
}

export function readFrame(frame: string, command: string, expected: string, width = "unknown", scrolledControl = false): SubmitFrame & { text: string | null } {
  const read = readFrameText(frame, command, expected, width, scrolledControl);
  if (!command.startsWith("claude")) return read;
  // Claude's live spinner is busy evidence for the fast-start relabel, exactly
  // as OpenCode's reading is (tap-7txco): without it every quick-starting
  // Claude delivery would read as a queue behind earlier work.
  const state = detectAgentState("claude", frame.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")).agentState;
  const busy = state === "working" ? true : agentAtRest(state) ? false : undefined;
  return busy === undefined ? read : { ...read, busy };
}

function readFrameText(frame: string, command: string, expected: string, width: string, scrolledControl: boolean): SubmitFrame & { text: string | null } {
  if (approvalPrompt(command, frame)) return { state: "unobservable", mode: "idle", width, text: null };
  const lines = frame.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split("\n");
  const re = promptLineRe(command);
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (re.test(lines[i]!)) { start = i; break; }
  const region = start < 0 ? [] : command.startsWith("hermes")
    ? hermesUnwrap(lines.slice(start, hermesComposerEnd(lines, start)), width)
    : lines.slice(start);
  const queue = region.some(line => /^\s*tab to queue(?: message)?(?:\s+\d+% context left)?\s*$/.test(line));
  const before = start < 0 ? lines : lines.slice(0, start);
  const terminal = lines.filter(line => line.trim()).at(-1) ?? "";
  const working = before.filter(line => line.trim()).slice(-4).some(line => /^\s*[•*]\s*Working\b.*esc to interrupt/.test(line))
    || (!/^codex(?:-|$)/.test(command) && /esc to (?:interrupt|cancel)\)?\s*$/.test(terminal));
  let mode: SubmitFrame["mode"] = queue ? "mid-turn" : working ? "working" : "idle";
  if (isOpenCodeCommand(command)) {
    const actual = opencodeInput(frame);
    // Only an observed idle read may later license the fast-start relabel;
    // booting/unknown frames carry no busy evidence at all (tap-ho6pk).
    const state = detectAgentState("opencode", frame.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")).agentState;
    const busy = state === "working" ? true : agentAtRest(state) ? false : undefined;
    return { state: actual === null ? "unobservable" : actual === expected ? "staged" : actual ? "changed" : "empty", mode, width, text: actual, busy };
  }
  if (start < 0) {
    if (normalizeInputMatch(frame).includes(normalizeInputMatch(expected))) mode = "idle";
    return { state: "unobservable", mode, width, text: null };
  }
  let actual: string;
  // The dim-placeholder check below reads the rows as painted (tap-8nmot).
  let dimProbe: string | null = null;
  if (command.startsWith("claude")) {
    const box = claudeBox(frame);
    if (!box) return { state: "unobservable", mode, width, text: null };
    actual = box.typed;
  } else if (command === "agy") {
    const box = agyComposer(frame);
    if (box === null) return { state: "unobservable", mode, width, text: null };
    actual = box;
  } else if (command.startsWith("cursor")) {
    const box = cursorComposer(frame);
    if (box === null) return { state: "unobservable", mode, width, text: null };
    actual = box;
  } else if (/^codex(?:-|$)/.test(command)
      && region[0]?.replace(re, "").trim() === expected
      && region.slice(1).filter(line => line.trim()).length === 1
      && (expected === "/clear"
        ? /^\s*\/clear\s+clear the terminal and start a new chat\s*$/.test(region.slice(1).find(line => line.trim()) ?? "")
        : expected === "/compact" && /^\s*\/compact\s+summarize conversation to prevent hitting the context limit\s*$/.test(region.slice(1).find(line => line.trim()) ?? ""))) {
    // Observed Codex autocomplete: one exact owned control, one matching menu row.
    actual = expected;
  } else if (/^codex(?:-|$)/.test(command)
      && codexPlaceholder(frame.split("\n")[start] ?? "")) {
    // The painted placeholder proves the composer is empty; rows below it
    // belong to the UI, even when a new footer shape is not in our grammar.
    actual = "";
  } else {
    region[0] = region[0]!.replace(re, "");
    // Only complete known Codex footer rows are chrome; arbitrary text remains.
    if (/^codex(?:-|$)/.test(command)) {
      // Codex's starfield paints Braille-block spacers around the composer
      // (tap-8nmot): a paint-only row between the wire and the footer must not
      // defeat the footer grammar's non-blank precondition below. Paint is
      // chrome, not input — the same rule every codex reader applies — so the
      // rows are stripped HERE, before the loop, and the loop's own grammar
      // trims the footer it recognizes.
      const painted = region.slice();
      for (let i = 0; i < region.length; i++) region[i] = withoutCodexPaint(region[i]!);
      while (region.length && !region.at(-1)!.trim()) region.pop();
      const cue = /^\s*(?:tab to queue(?: message)?(?:\s+\d+% context left)?|shift\s*\+\s*←\s+edit last queued message|\d+% context left)\s*$/;
      const status = /^\s*[^\s·]+\s+(?:low|medium|high|xhigh|max|ultra)(?: fast)?\s+·\s+(?:Context\s+\d+% left|[^·\r\n]+\s+·\s+weekly\s+\d+% left)(\s+·.*|\s+Goal paused \(\/goal resume\)|…)?\s*$/;
      // Codex 0.160 paints a configurable status row: `<model> <reasoning label> · <cwd> [· <thread title>]`,
      // e.g. `GPT-6.1-Sol default · ~/project · Run shell diagnostics`. The old grammar above needs a Context or
      // weekly item, so this row was kept as composer input and a strict reader saw the wire plus extra text.
      // One physical row only: the cwd and title items accept free words, so joining wrapped rows could swallow
      // a human line. The cwd item must start with `~` or `/`, and Codex paints a blank row between composer and
      // status, so a row typed directly under the wire is input.
      const cwdStatus = /^\s*[^\s·]+\s+(?:default|low|medium|high|xhigh|max|ultra)(?: fast)?\s+·\s+(?:~|\/)[^·\r\n]*(?:\s+·\s+[^·\r\n]+)*\s*$/;
      // Codex paints a config-warning row beneath the status footer
      // (tap-2ajq8). It is chrome only directly under a status row the loop
      // below recognizes; anywhere else the row stays input.
      const warning = /^\s*⚠\s+\d+\s+warnings?\s+·\s+f2 to view\s*$/;
      const warned = warning.test(region.at(-1) ?? "") ? region.pop()! : null;
      const beforeFooter = region.length;
      // Recover a physically wrapped footer skeleton, never the prompt row.
      // A separator/ellipsis suffix (capture 1) completes an intermediate row;
      // later rows remain ambiguous input. A bare Context-left row may still
      // wrap into a separator on the next row, but never arbitrary human text.
      for (let count = 1; count <= Math.min(4, region.length - 1); count++) {
        const start = region.length - count;
        // A footer starts after the prompt or a blank separator, not inside a
        // wrapped model token whose suffix happens to match the status grammar.
        if (start > 1 && region[start - 1]!.trim() && !cue.test(region[start - 1]!)) continue;
        const rows = region.slice(-count);
        if (rows.some(row => !row.trim())) continue;
        const joins = ["", " "];
        if ((count === 1 && start > 1 && !region[start - 1]!.trim() && cwdStatus.test(rows[0]!)) || joins.some(separator => status.test(rows.join(separator))
            && !rows.slice(0, -1).some((_, i) => !!status.exec(rows.slice(0, i + 1).join(separator))?.[1]))) {
          region.splice(-count);
          break;
        }
      }
      if (warned !== null && region.length === beforeFooter) region.push(warned);
      while (region.length && !region.at(-1)!.trim()) region.pop();
      if (cue.test(region.at(-1) ?? "")) region.pop();
      // The paint strip must not widen the dim-placeholder blank: dim words
      // beyond the exact placeholder stay input, so that check still
      // compares the kept rows as painted.
      dimProbe = painted.slice(0, region.length).join("\n").trim();
    }
    actual = region.join("\n").trim();
  }
  if (actual && !isPasteCollapse(command, actual) && dimPlaceholder(frame.split("\n")[start] ?? "", dimProbe ?? actual, command)) actual = "";
  // Hermes's placeholder is italic 38;5;136, not SGR 2, and only the reader
  // family models that pair; without it an idle or working composer read
  // `changed` and a submitted wire could never verify (tap-rhajr).
  if (actual && command.startsWith("hermes") && dimPromptInput(actual, frame.split("\n")[start] ?? "", promptGlyph(command), command)) actual = "";
  const bare = /^\[\[TAP v0\.23 (ask|note) [A-Za-z0-9_./-]+(?: (?:urgent|escalate|digest))?(?: agent-interrupt)?(?: retry)?\]\]$/.test(expected);
  const matches = actual === expected || (bare && normalizeInputMatch(actual) === normalizeInputMatch(expected))
    || (command.startsWith("claude") && claudeWrappedControlMatches(frame, expected));
  // Opt-in only (tap-vho8h): the typed-prefix /compact arm may accept the
  // visible suffix of its own control once the command row has scrolled off.
  if (!matches && scrolledControl && actual && command.startsWith("claude") && claudeScrolledControlMatches(frame, expected)) {
    return { state: "staged", scrolled: true, mode, width, text: actual };
  }
  // tap-1ncs6: an ordinary wire whose head scrolled out of Claude's composer
  // viewport is its own tail, recognized by the shared shape-and-suffix rule.
  // The band was read empty before this wire was typed, and a human keystroke
  // during the paste lands at the cursor and breaks the suffix, so the visible
  // tail is sole content. `tap nudge` on a scrolled tail passes the tail
  // itself as `expected`, which matches whole (whitespace-free) and is still
  // a scrolled read. Controls keep their own proof above.
  if (!matches && actual && command.startsWith("claude") && (isOrdinarySentinel(expected) || sentinelShapedInput(expected))
      && matchSentinelSuffix(actual, expected) !== null) {
    const scrolled = !normalizeInputMatch(actual).startsWith("[[TAP");
    return { state: "staged", ...(scrolled ? { scrolled } : {}), mode, width, text: actual };
  }
  return { state: matches ? "staged" : actual ? "changed" : "empty", mode, width, text: actual };
}

/**
 * The harness dispatch `tap_composer_input` used to hold, with its three
 * outcomes intact: TEXT (possibly empty, meaning a readable empty composer),
 * UNKNOWN (geometry absent — never evidence of a clear band), and BLOCKED (a
 * modal or unreadable-geometry case where the caller must not use a
 * chrome-rich region as if it were input).
 *
 * The ORDER is the contract and it is not `readFrame`'s order, which is why
 * this is its own function rather than a call into that one:
 *   - the approval check runs for claude and codex ONLY, not every harness;
 *   - claude's feedback overlay blocks before its box is read;
 *   - the generic path requires a prompt region to EXIST before cursor's box
 *     reader is consulted, so a cursor pane with no prompt row is UNKNOWN
 *     while a cursor pane with a prompt row but unreadable box geometry is
 *     BLOCKED;
 *   - nothing here collapses a dim placeholder to empty. That belongs to the
 *     caller (`tap_dim_prompt_input`), and folding it in would change what the
 *     pending-input backup preserves.
 */
export type ComposerInput = { state: "text"; text: string } | { state: "unknown" } | { state: "blocked" };

const stripCsi = (text: string): string => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

export function composerInput(frame: string, command: string): ComposerInput {
  const unknown: ComposerInput = { state: "unknown" };
  const blocked: ComposerInput = { state: "blocked" };
  const text = (value: string | null): ComposerInput => value === null ? unknown : { state: "text", text: value };

  // A leading U+FEFF survives the GENERIC path and not the delegated ones, and
  // that asymmetry is the incumbent's, not a choice. Every branch below that
  // reads through a former `tap_bun_call` — the approval check, claude's
  // overlay and box, codex, cursor, agy, opencode — crossed a process boundary
  // whose stdin decode dropped a leading byte-order mark. The generic branch
  // was `awk` and `sed` inside the same shell, so it saw the byte, and U+FEFF
  // is in no selector's space class, so a BOM-prefixed row was absent geometry
  // there. Measured: with the BOM preserved everywhere, 2 of 1593 differential
  // cases diverged on the codex branch; with it stripped everywhere, the
  // generic branch diverged instead. The frame is handed on accordingly.
  const delegated = frame.replace(/^\ufeff/, "");

  if (approvalPrompt(command, delegated)) return blocked;
  if (command.startsWith("claude")) {
    if (claudeFeedbackOverlay(delegated)) return blocked;
    // `raw`, not `typed`. The Bash door returned whatever the `claude-box` CLI
    // mode prints, and that mode prints `box.raw` — trailing spaces on every
    // row preserved. `typed` additionally strips per-row trailing blanks and
    // trims the whole string, which is what `readFrame` wants for comparison
    // and NOT what this door has ever emitted. The differential caught it on 12
    // captured frames (`/compact /goal ` versus `/compact /goal`), and this
    // reader feeds the pending-input backup, where the bytes are the point.
    const box = claudeBox(delegated);
    return text(box === null ? null : box.raw);
  }
  if (/^codex(?:-|$)/.test(command)) return text(readComposerFrame(delegated, command));
  // opencode goes through the shared predicate, like every other opencode site in
  // this file. Callers pass the pane's basename, so basename-and-lowercase only
  // widens spellings no production caller sends; `agy` stays exact.
  if (isOpenCodeCommand(command)) return text(opencodeBoxText(delegated));
  // The agy reader saw an ANSI-stripped frame through the Bash pipe, so it does
  // here too rather than being handed the raw one.
  if (command === "agy") return text(agyComposer(stripCsi(delegated)));

  // Generic: the LAST prompt row and everything after it. The incumbent's awk
  // reset its accumulator at every match, which is what makes it the last — and
  // `promptRowReAwk`, not `promptLineRe`, because awk IS the oracle here and its
  // space class accepts U+00A0 where JS's `[ \t]` does not. The claude and
  // codex branches above have already returned; their oracle is the previously
  // ported module, so they keep `promptLineRe` (tap-6zzsk).
  const re = promptRowReAwk(command);
  const lines = stripCsi(frame).split("\n");
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (re.test(lines[i]!)) { start = i; break; }
  if (start < 0) return unknown;
  if (command.startsWith("cursor")) {
    const box = cursorComposer(delegated);
    // Cursor box geometry unavailable: the caller must not fall back to the
    // chrome-rich region, so this is BLOCKED rather than the region's text.
    return box === null ? blocked : { state: "text", text: box };
  }
  // Other generic harnesses keep the unbounded region.
  const end = command.startsWith("hermes") ? hermesComposerEnd(lines, start) : lines.length;
  const region = lines.slice(start, end);
  // `sed -E "1{s/${prompt_re}[[:space:] ]*//;}"`: the row's leading padding is
  // part of the prompt pattern, and the run after the glyph is the locale's
  // space class. The two instruments disagree — awk SELECTED this row with a
  // narrower class than sed STRIPS with (`terminal-text.ts` has the table) — so
  // the padding is trimmed on both sides of the glyph in sed's wider class,
  // which is what the incumbent's pipeline did to the row awk had chosen.
  const sedStart = new RegExp(`^[${POSIX_LOCALE_SPACE}]+`);
  region[0] = region[0]!.replace(sedStart, "").replace(re, "").replace(sedStart, "");
  // Drop trailing blank rows only — NOT a whole-string trim. A blank row above
  // text stays, and so does the leading padding of every row after the first.
  const blank = new RegExp(`^[${POSIX_LOCALE_SPACE}]*$`);
  let last = region.length;
  while (last > 0 && blank.test(region[last - 1]!)) last--;
  // The incumbent's tail was `awk { print line[i] }`, which terminates EVERY
  // row it prints — so a non-empty generic region ends with a newline and an
  // empty one is empty. Every caller captures this through `$(…)`, which strips
  // trailing newlines, so the byte is invisible to them; reproducing it anyway
  // costs one conditional and removes a judgement about who is looking. Only
  // the generic path had it: the claude, codex, cursor, agy and opencode
  // branches all end in `printf '%s'`.
  const rows = region.slice(0, last);
  return { state: "text", text: rows.length ? rows.join("\n") + "\n" : "" };
}

export function readComposerFrame(frame: string, command: string): string | null {
  return readFrame(frame, command, "\0").text;
}

/** Whole-composer equality for the idle staged-submit arm (tap-9lqa7 R5):
 * the composer holds exactly the expected text and nothing else. Trailing
 * human bytes, continuation rows and unknown chrome all refuse — containment
 * (`includes`) is what the two samples already check; this is the equality
 * that keeps a keystroke landing after the wire from riding the one Enter. */
export function composerHoldsExactly(frame: string, command: string, expected: string): boolean {
  const composer = readComposerFrame(frame, command);
  if (composer === null) return false;
  const actual = isCodexCommand(command) ? withoutCodexPaint(composer) : composer;
  return normalizeInputMatch(actual) === normalizeInputMatch(expected);
}

/** Only ordinary wire gets containment; slash/exact controls keep ownership proof. */
export function isOrdinarySentinel(expected: string): boolean {
  return /^\[\[TAP v0\.23 (?:ask|note) [\s\S]+\]\]$/.test(expected);
}

const isCodexCommand = (command: string): boolean => /^codex(?:-|$)/.test(command);
const hasMintedSentinelId = (wire: string): boolean =>
  /^\[\[TAP\s+v0\.23\s+(?:ask|note)\s+(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}(?=\s|\]\])/s.test(wire);

/** Localize first, independently of modal classification or complete chrome. */
export function sentinelInputTail(frame: string, command: string): string | null {
  const lines = frame.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split("\n");
  if (isOpenCodeCommand(command)) {
    let end = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^\s*(?:┃|╹▀)/.test(lines[i]!)) { end = i; break; }
    }
    if (end < 0) return null;
    let start = end;
    while (start > 0 && /^\s*┃/.test(lines[start - 1]!)) start--;
    return lines.slice(start, end + 1).map(line => line.replace(/^\s*┃\s?/, "")).join("\n");
  }
  const claudeRange = command.startsWith("claude") ? claudeActiveBoxRange(frame) : null;
  if (claudeRange) {
    const rows = lines.slice(claudeRange.start, claudeRange.bot);
    rows[0] = rows[0]!.replace(promptLineRe(command), "");
    return rows.join("\n");
  }
  const prompt = promptLineRe(command);
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (prompt.test(lines[i]!)) { start = i; break; }
  if (start < 0) return null;
  // Prefer bounded geometry only when it belongs to this last prompt. A missing
  // bottom border or a modal-aware reader's null does not erase visible input.
  const bounded = command.startsWith("claude") ? claudeBox(frame)?.typed
    : command.startsWith("cursor") ? cursorComposer(frame)
    : command === "agy" ? agyComposer(frame) : null;
  if (bounded) {
    // A stale closed box above a newer prompt must never supply transcript text.
    const normalized = normalizeInputMatch(lines.slice(start).join("\n"));
    if (normalized.includes(normalizeInputMatch(bounded))) return bounded;
  }
  const tail = lines.slice(start);
  tail[0] = tail[0]!.replace(prompt, "");
  return tail.join("\n");
}

export type SentinelDecision = { action: "submit" } | { action: "withhold"; reason: "dialog" | "url" | "chip" | "not-visible" };

/** Existing active modal witnesses; footer URLs and transcript words are data. */
function obviousDialog(frame: string, command: string): boolean {
  if (command.startsWith("claude") && claudeFeedbackOverlay(frame)) return true;
  if (command === "agy" && agyPermissionOverlay(frame)) return true;
  if (detectAgentState(command, frame).agentState === "blocked") return true;
  if (isOpenCodeCommand(command)) {
    const tail = sentinelInputTail(frame, command);
    if (tail && /^\s*\/\S+\s+[^\n]*┃\s*$/m.test(tail)) return true;
  }
  return false;
}

/**
 * Claude's feedback-draft panel takes the pane's keys, so liveness never
 * overrides it (tap-89a57): its anchored detector is not status chrome.
 */
function heldSurface(frame: string, command: string): boolean {
  return command.startsWith("claude") && claudeFeedbackOverlay(frame);
}

export function sentinelSubmitDecision(frame: string, command: string, expected: string, harnessAlive = false): SentinelDecision {
  if (approvalPrompt(command, frame) || heldSurface(frame, command)) return { action: "withhold", reason: "dialog" };
  const input = sentinelInputTail(frame, command);
  const want = normalizeInputMatch(expected);
  const visible = input !== null && (normalizeInputMatch(input).includes(want) ||
    (isCodexCommand(command) && hasMintedSentinelId(expected) && normalizeInputMatch(withoutCodexPaint(input)).includes(want)) ||
    // tap-1ncs6: the scrolled tail of this exact wire in a Claude composer.
    (command.startsWith("claude") && matchSentinelSuffix(input, expected) === "tail"));
  if (!want || !visible) {
    return { action: "withhold", reason: input !== null && isPasteCollapse(command, input) ? "chip" : "not-visible" };
  }
  if (obviousDialog(frame, command) && !harnessAlive) return { action: "withhold", reason: "dialog" };
  return { action: "submit" };
}

/** Extract, never reconstruct, one complete wire for nudge's canonical-id checks. */
export function visibleSentinel(frame: string, command: string): string | null {
  const input = sentinelInputTail(frame, command);
  if (input === null) return null;
  const matches = [...(isCodexCommand(command) ? withoutCodexPaint(input) : input).matchAll(/\[\[TAP\s[\s\S]*?\]\]/g)];
  if (matches.length !== 1) return null;
  if (!isCodexCommand(command) || hasMintedSentinelId(matches[0]![0])) return matches[0]![0];
  const raw = [...input.matchAll(/\[\[TAP\s[\s\S]*?\]\]/g)];
  return raw.length === 1 ? raw[0]![0] : null;
}

/**
 * Return the canonical visible wire id only while submission is safe. Unlike
 * the ordinary staged comparison, this deliberately compares only the parsed
 * id and ignores every other wire field plus volatile surrounding rendering;
 * nudge samples it twice after an OpenCode repaint before one Enter.
 */
export function visibleSentinelId(frame: string, command: string, harnessAlive = false): string | null {
  if (approvalPrompt(command, frame) || heldSurface(frame, command)) return null;
  if (obviousDialog(frame, command) && !harnessAlive) return null;
  const wire = visibleSentinel(frame, command);
  if (wire === null) return null;
  const parsed = parseStuckSentinel(wire, command);
  return parsed.ok ? parsed.fields.id : null;
}

export function classifySubmitFrame(frame: string, command: string, expected: string, width = "unknown", harnessAlive = false, soleContent = false, scrolledControl = false): SubmitFrame {
  const read = readFrame(frame, command, expected, width, scrolledControl);
  const { text: _text, ...result } = read;
  if (approvalPrompt(command, frame)) return { ...result, state: "unobservable", held: "approval" };
  if (heldSurface(frame, command)) return { ...result, state: "unobservable", held: "feedback-draft" };
  if (command.startsWith("claude") && result.state !== "unobservable" && claudeQueuedControlMatches(frame, expected)) {
    return { ...result, state: "queued", mode: "working" };
  }
  if (soleContent || !isOrdinarySentinel(expected)) return result;
  // tap-maavp effect 2: inside a READABLE BOUNDED composer every byte is
  // composer content, so our wire plus other non-space bytes is the
  // recipient's own input fused around it — Enter would submit that input
  // with the wire. Flag it `fused` and keep it `changed`; the caller backs up
  // the foreign bytes, clears, re-injects, then Enters. The earlier promotion
  // stays for its own case: unknown chrome rows, or the wire visible while
  // the composer itself is unreadable or unbounded (generic regions).
  const boundedRead = read.text !== null && (isOpenCodeCommand(command)
    || command.startsWith("claude") || command.startsWith("cursor") || command === "agy");
  if (boundedRead && result.state === "changed") {
    const actual = normalizeInputMatch(read.text!);
    const want = normalizeInputMatch(expected);
    if (actual.includes(want) && actual.replace(want, "").length > 0) {
      return { ...result, state: "changed", fused: true };
    }
  }
  // A Claude delivered-but-unconsumed message parks as an indented prompt row
  // above the active box's fence while the live composer holds newer input or
  // sits empty. The Claude Bar footer hides esc-to-interrupt, so working
  // chrome is absent exactly when this queue shape appears; acceptance is the
  // bounded queue-row geometry itself (claudeQueuedRows), never transcript
  // prose at column 0. A wire still in the composer is THIS attempt, not a
  // prior queue, so composer containment stays with staged/fused handling.
  if (command.startsWith("claude") && !normalizeInputMatch(read.text ?? "").includes(normalizeInputMatch(expected))
      && claudeQueuedRows(frame).some((row) => normalizeInputMatch(row).includes(normalizeInputMatch(expected)))) {
    return { ...result, state: "queued", mode: "working" };
  }
  const decision = sentinelSubmitDecision(frame, command, expected, harnessAlive);
  // A complete wire outside an observed empty composer, while the harness is
  // working, is accepted queue state. It never authorizes another Enter.
  // The generic arm is `inferred`: a fast-starting turn from an idle seat
  // matches the same three facts, so the courier may relabel it from pre-Enter
  // evidence (tap-ho6pk). Codex keeps its own mode-based arm untagged, and the
  // Claude queue-row geometry above is positive proof of a queue, also untagged.
  const generic = !/^codex(?:-|$)/.test(command);
  const working = generic
    ? detectAgentState(command, frame.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")).agentState === "working"
    : result.mode === "working";
  if (result.state === "empty" && normalizeInputMatch(frame).includes(normalizeInputMatch(expected)) && working) {
    return { ...result, state: "queued", mode: "working", ...(generic && { inferred: true }) };
  }
  return decision.action === "submit" ? { ...result, state: "staged" }
    : result.state === "staged" ? { ...result, state: "changed" } : result;
}

/** Bash supplies its existing exact-control reader's bytes; comparison lives here. */
export function composerMatches(frame: string, command: string, expected: string, allowChip = false, actual?: string, harnessAlive = false): boolean {
  if (isOrdinarySentinel(expected)) return sentinelSubmitDecision(frame, command, expected, harnessAlive).action === "submit";
  actual ??= readComposerFrame(frame, command) ?? "";
  if (!actual) return false;
  const norm = (s: string) => s.normalize("NFC").trim();
  return norm(actual) === norm(expected)
    || (command.startsWith("claude") && claudeWrappedControlMatches(frame, expected))
    || (allowChip && isPasteCollapse(command, actual) && /^\s*\[[^\]\n]+\]\s*$/.test(actual));
}

/**
 * The whole Enter-readiness decision, frame in and one token out.
 *
 * The composer read used to be a SECOND process: `tap_submit_enter_ready` piped
 * the frame to `tap_composer_input`, which spawned `submit-frame.ts
 * composer-input`, then spawned this verb with the answer as argv. Both halves
 * always read the same frame, so the second process only moved bytes. Reading
 * it in-process here is the same `composerInput` on the same input.
 *
 * `observable` is why the rc split in `tap_composer_input` does not survive the
 * move. That reader answers three ways — text, unknown (rc 3), blocked (rc 4) —
 * but its one caller here collapsed both refusals into the same pair, `actual=""`
 * and `observable=unobservable`, because `|| { ... }` cannot see which rc it
 * caught. The distinction is real and the reader keeps it for its other two
 * callers; it was never legible at this seam.
 *
 * A throw is caught rather than fatal, and that is the incumbent's shape, not a
 * defensive habit: a crashing composer reader was one process dying, which the
 * `||` read as unobservable and carried on from. Letting it kill this process
 * would turn a readable-frame-with-an-unreadable-composer into rc 5.
 *
 * TWO VIEWS, and they are not interchangeable.
 * The composer reader and the enter-ready predicates never saw the same bytes,
 * because they never shared a process: the CLI handed `composer-input` a
 * BOM-PRESERVING decode (`readStdinFrame`) and every other verb a BOM-STRIPPING
 * one (`Bun.stdin.text()`); tap-amfle moved the whole door to the preserving
 * read, and the stripped view survives only where this function builds it.
 * `composerInput`'s generic branch is built on that —
 * it strips U+FEFF for the delegated readers and leaves it for the generic one,
 * so a BOM-prefixed prompt is deliberately absent geometry there. Reading one
 * frame and passing it to both hands the composer a view it never had, turning
 * an unobservable composer into a readable one and an rc 5 withhold into an rc 0
 * ready or an rc 2 consumed. Those reach `tap_submit_existing_verify` at
 * lib.sh:11478 and :11506, so it is effect authorization, not an internal token.
 * Collapsing the process boundary must not collapse the decode boundary with it.
 *
 * `gated` and `unread` are decided before a single frame semantic is consumed,
 * and they are separate tokens because they are separate reasons, not because
 * the caller does anything different with them. The auto-permission refusal used
 * to sit in the adapter, ahead of the capture, so a gated call issued no
 * `capture-pane` at all. It lives here now and the capture is taken
 * unconditionally: one extra read-only tmux round trip on the gated path, taken
 * deliberately so the adapter holds no decision. `captured` is how the adapter
 * reports a capture that failed without deciding what the failure means.
 */
export function enterReady(
  composerFrame: string, matchFrame: string, command: string, expected: string, id: string,
  chip: boolean, entered: boolean, alive: boolean, permissions: string,
  autoReady: boolean, captured: boolean,
): "ready" | "consumed" | "withhold" | "gated" | "unread" {
  // Order is the incumbent's: the gate was ahead of the capture, so it answers
  // first even when the capture that now precedes it failed.
  if (permissions === "auto" && !autoReady) return "gated";
  if (!captured) return "unread";

  // `actual` is only assigned where `observable` becomes true, so the two never
  // disagree and a guarded read here would be dead. The incumbent carried the
  // same redundancy across the process boundary — Bash set `actual=""` in the
  // same `||` that set `observable=unobservable`, and the module then re-applied
  // `argv[10] === "unobservable" ? "" : actual`. Dropping it is not a behavior
  // change and no differential can show that it is; the equality is structural.
  // `observable` stays load-bearing BELOW, where an unreadable composer must not
  // read as a consumed one.
  let actual = "";
  let observable = false;
  try {
    const read = composerInput(composerFrame, command);
    if (read.state === "text") { actual = read.text; observable = true; }
  } catch { /* unobservable, as the crashed subprocess was */ }

  if (permissions === "auto"
    ? readFrame(matchFrame, command, expected).state === "staged"
    : composerMatches(matchFrame, command, expected, chip, actual, alive)) return "ready";
  if (entered && observable && !normalizeInputMatch(actual).includes(normalizeInputMatch(id))
    && (!chip || !isPasteCollapse(command, actual))) return "consumed";
  return "withhold";
}

export function observeSubmitFrame(target: string, command: string, expected: string, harnessAlive = false, soleContent = false, scrolledControl = false): SubmitFrame {
  const size = tmux(["display-message", "-p", "-t", target, "#{pane_width}"]);
  const width = size.code === 0 && /^\d+$/.test(size.stdout.trim()) ? size.stdout.trim() : "unknown";
  const frame = capturePane(target, true, !isOpenCodeCommand(command));
  if (frame.code !== 0 || frame.rateLimited || size.rateLimited) return { state: "unobservable", mode: "idle", width };
  return classifySubmitFrame(frame.stdout, command, expected, width, harnessAlive, soleContent, scrolledControl);
}

// The Bash and native paths share this reader; no theme-specific second parser.
if (import.meta.main) {
  const input = await readStdinFrame();
  if (process.argv[2] === "submit-state") {
    const result = classifySubmitFrame(input, process.argv[3] ?? "", process.argv[4] ?? "", "unknown", process.argv[5] === "1");
    process.stdout.write(`${result.state}\t${result.mode}\t${result.fused ? 1 : 0}`);
  } else if (process.argv[2] === "frame-mode") {
    process.stdout.write(classifySubmitFrame(input, process.argv[3] ?? "", "\0").mode);
  } else if (process.argv[2] === "sentinel-tail") {
    const tail = sentinelInputTail(input, process.argv[3] ?? "");
    if (tail === null) process.exit(3);
    process.stdout.write(tail);
  } else if (process.argv[2] === "visible-sentinel") {
    const wire = visibleSentinel(input, process.argv[3] ?? "");
    if (wire === null) process.exit(3);
    process.stdout.write(wire);
  } else if (process.argv[2] === "auto-ready") {
    process.stdout.write(classifyPane(input, process.argv[3] ?? "", false).kind === "ready" ? "ready" : "hold");
  } else if (process.argv[2] === "auto-match") {
    process.stdout.write(readFrame(input, process.argv[3] ?? "", process.argv[4] ?? "").state === "staged" ? "yes" : "no");
  } else if (process.argv[2] === "composer-match") {
    process.stdout.write(composerMatches(input, process.argv[3] ?? "", process.argv[4] ?? "", process.argv[5] === "1", process.argv[6], process.argv[7] === "1") ? "yes" : "no");
  } else if (process.argv[2] === "approval-prompt") {
    process.stdout.write(approvalPrompt(process.argv[3] ?? "", input) ? "blocked" : "clear");
  } else if (process.argv[2] === "claude-feedback-overlay") {
    process.stdout.write(claudeFeedbackOverlay(input) ? "blocked" : "clear");
  } else if (process.argv[2] === "claude-box") {
    const box = claudeBox(input);
    process.stdout.write(box === null ? "unknown" : `known:${box.raw}`);
  } else if (process.argv[2] === "codex-placeholder") {
    process.stdout.write(codexPlaceholder(input.trimEnd()) ? "yes" : "no");
  } else if (process.argv[2] === "codex-composer") {
    const text = readComposerFrame(input, "codex");
    process.stdout.write(text === null ? "unknown" : `known:${text}`);
  } else if (process.argv[2] === "claude-wrapped-match") {
    process.stdout.write(claudeWrappedControlMatches(input, process.argv[3] ?? "") ? "yes" : "no");
  } else if (process.argv[2] === "agy-survey-overlay") {
    process.stdout.write(agySurveyOverlay(input) ? "yes" : "no");
  } else if (process.argv[2] === "agy-permission-overlay") {
    process.stdout.write(agyPermissionOverlay(input) ? "yes" : "no");
  } else if (process.argv[2] === "agy-reprobe-match") {
    process.stdout.write(agyReprobeInputMatches(input, process.argv[3] ?? "") ? "yes" : "no");
  } else {
    const reader = process.argv[2] === "cursor-composer" ? cursorComposer
      : process.argv[2] === "agy-composer" ? agyComposer : null;
    if (!reader) process.exit(2);
    const text = reader(input);
    if (text === null) process.exit(3);
    process.stdout.write(text);
  }
}
