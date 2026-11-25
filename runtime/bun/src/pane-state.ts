import { opencodeShellMode, OPENCODE_SHELL_MODE_REASON } from "./opencode-composer";
import { approvalPrompt, codexHookTrust, CODEX_HOOK_TRUST_REASON } from "./agent-state";
import { textHasPasteCollapse } from "./pane/geometry";
import { opencodeTerminalOverprint } from "./opencode-composer";
import { agyComposer, agyPermissionOverlay, agySurveyOverlay, composerInput, readComposerFrame } from "./submit-frame";
import { codexQueuedRows } from "./slices/delivery-disposition";
import { dimPlaceholder, hasInputText } from "./terminal-text";
// Typed band + active-input observation. Family authority is bound.harness,
// never chrome and never a raw pane_current_command guess.
import {
  capturePane,
  normalizeInputMatch,
  observeInputRegion,
  observePaneResult,
  tmux,
} from "./tmux";
import { pendingInputText, type PaneIo } from "./pane/reader";

export type InputObservation =
  | { state: "present"; text: string }
  | { state: "chip"; text: string }
  | { state: "absent" }
  | { state: "unobservable"; reason: string; cause?: "pane_dead" | "overprint" | "shell-mode" | "feedback-draft" }
  | { state: "rate_limited"; reason: string }
  | { state: "gone" };

export type PaneBand =
  | { state: "ready" }
  | { state: "busy"; text: string; queued?: boolean;
      /** Claude only: the visible composer rows as typed and the box width, for draft capture and restore proofs. */
      rows?: string[]; columns?: number;
      /** A full Claude viewport may hide earlier rows; exact control words need the whole composer. */
      mayBeTruncated?: true;
      /** Claude only: the box sits at its height cap with every visible row blank; the draft lies above the viewport. */
      scrolled?: true }
  | { state: "unobservable"; reason: string; cause?: "pane_dead" | "overprint" | "shell-mode" | "feedback-draft" }
  | { state: "rate_limited"; reason: string }
  | { state: "gone" };

/** R5 six-state vocabulary. Frozen; a semantic change is a HOLD for sol. */
export type PaneKind = "ready" | "draft" | "no-band" | "copy-mode" | "gone" | "rate-limited";

export type ClassifiedPane =
  | { kind: "queued"; text: string }
  | { kind: "ready" }
  | { kind: "draft"; text: string; rows?: string[]; columns?: number; scrolled?: true; mayBeTruncated?: true }
  | { kind: "no-band"; reason: string; cause?: "pane_dead" | "overprint" | "shell-mode" | "feedback-draft" }
  | { kind: "copy-mode" }
  | { kind: "gone" }
  | { kind: "rate-limited"; reason: string };

/** U+2500 run floor. Footer after the border is chrome, not draft. */
export const CLAUDE_BORDER_CELLS = 10;

const CLAUDE_PROMPT = /^[ \t]*[›❯]\s*(.*)$/;

/**
 * Proof that the classifier consumes only the frame its caller supplies:
 * the pane reader may never sample the pane again behind classifyPane's back.
 */
const NO_RECAPTURE: PaneIo = {
  capture() {
    throw new Error("classifyPane must classify the supplied frame, not recapture the pane");
  },
  paneWidth() {
    return "";
  },
};

/** After a live first peek, an unobservable later read may mean the pane vanished. */
function afterLiveNoBand(target: string, reason: string): ClassifiedPane {
  const again = panePresence(target);
  if (again?.state === "gone") return { kind: "gone" };
  if (again?.state === "unobservable" && again.cause === "pane_dead") return { kind: "no-band", cause: "pane_dead", reason: again.reason };
  if (again?.state === "rate_limited") return { kind: "rate-limited", reason: again.reason };
  return { kind: "no-band", reason };
}

function plain(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function isClaudeBottomBorder(line: string): boolean {
  const vis = plain(line).replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
  return /^─+$/.test(vis) && vis.length >= CLAUDE_BORDER_CELLS;
}

function isClaudeBoxFence(line: string): boolean {
  return /^[ \t]*─{10,}/.test(plain(line)) || isClaudeCollapsedFence(line);
}

// Claude 2.1.327 removes the prompt glyph when the head is collapsed. This
// explicit, column-zero fence is a tail witness, never a whole-draft witness.
function isClaudeCollapsedFence(line: string): boolean {
  // A long seat title leaves zero rule cells between the count and title.
  return /^─{2,} ↑ [1-9][0-9]* more (?:─+|─* [^─\r\n]+ ─)[ \t]*$/.test(plain(line));
}

/**
 * What Claude's feedback-draft card says about the composer below it.
 *
 * The card (SendFeedback's "✻ Bug report drafted: …" box) is a notice, not a
 * modal: on Claude Code 2.1.325 the composer keeps focus, and the card's digit
 * keys fire only while the whole composer is one 0, 1 or 2 (or Escape on an
 * empty one). It shows only while the seat is idle, and it hides once a turn
 * starts. Its height pushes the composer down: on a short pane (live: 71x22,
 * 58x24) below the viewport, at 80x24 down to its prompt row alone.
 *
 * - `visible`: the composer is complete below the card; read it as usual.
 * - `hidden`: the composer is not completely in view, its visible rows hold
 *   nothing, and the hint row reads `1 to review · 2 to send · 0 to dismiss`.
 *   The hint is not evidence of an empty composer: the September 2026 card
 *   drew it over a composer holding a sentinel (found in review). This is the
 *   one state the courier may dismiss with Escape; every reader holds it.
 * - `text`: the composer is not completely in view, and the hint row reads
 *   `clear text to review, send, or dismiss`, or its visible rows hold text.
 *
 * `card` is the card's own rows, the observation a dismissal license names.
 * Null when no live card sits directly above the composer region. Other card
 * states (confirm send, sending, error) are not recognized and hold as an
 * unreadable composer. Live frames: tap-89a57 fixtures `claude-feedback-*`.
 */
export type ClaudeFeedbackCard = { composer: "visible" | "hidden" | "text"; card: string };

const FEEDBACK_CARD_HEADER = /^│\s*✻ (?:Bug report|Product feedback|Feature request|Feedback) drafted:/;
const FEEDBACK_CARD_QUEUED = String.raw`(?:\s*·?\s*\+\d+ more queued)?\s*│$`;
const FEEDBACK_CARD_EMPTY_HINT = new RegExp(String.raw`^│\s*(?:1 to review · )?2 to send · 0 to dismiss` + FEEDBACK_CARD_QUEUED);
const FEEDBACK_CARD_TEXT_HINT = new RegExp(String.raw`^│\s*clear text to review, send, or dismiss` + FEEDBACK_CARD_QUEUED);

export function claudeFeedbackCard(capture: string): ClaudeFeedbackCard | null {
  // Claude draws the card from column 0; a composer's continuation rows are
  // indented two columns, so a card quoted inside a draft never matches.
  const rows = plain(capture).split("\n").map(line => line.trimEnd());
  const lines = rows.map(line => line.trim());
  let bottom = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (/^╰─{10,}╯$/.test(rows[i]!)) { bottom = i; break; }
  }
  if (bottom < 0) return null;
  let top = bottom - 1;
  while (top >= 0 && /^│.*│$/.test(rows[top]!)) top--;
  if (top < 0 || !/^╭─{10,}╮$/.test(rows[top]!)) return null;
  const body = rows.slice(top + 1, bottom);
  const hint = body.at(-1) ?? "";
  if (!FEEDBACK_CARD_HEADER.test(body[0] ?? "")) return null;
  const textHint = FEEDBACK_CARD_TEXT_HINT.test(hint);
  if (!textHint && !FEEDBACK_CARD_EMPTY_HINT.test(hint)) return null;
  // Below a live card: blank rows and composer fences, then the composer's
  // prompt row or the end of the viewport. Anything else is transcript.
  let prompt = bottom + 1;
  while (prompt < lines.length && (!lines[prompt] || /^─{10,}/.test(lines[prompt]!))) prompt++;
  const card = rows.slice(top, bottom + 1).join("\n");
  if (prompt === lines.length) return { composer: textHint ? "text" : "hidden", card };
  if (!/^[›❯](?:\s|$)/.test(lines[prompt]!)) return null;
  if (claudeGeometryRange(capture)?.start === prompt) return { composer: "visible", card };
  // Only the composer's first rows are in view: any typed byte there is text.
  const typed = [lines[prompt]!.replace(/^[›❯]\s*/, ""), ...lines.slice(prompt + 1)].some(Boolean);
  return { composer: textHint || typed ? "text" : "hidden", card };
}

/**
 * The visible Claude composer rows as the human typed them: the prompt glyph and
 * its one separator space come off the first row, the two-column continuation
 * indent off every later row, and trailing blanks off each row. Leading blank
 * rows, a row's own indentation and the empty cursor row C-u leaves all survive,
 * which `typed` (whole-trimmed) cannot promise. A soft wrap and a typed newline
 * render alike here; the clear chain tells them apart (input-backup.ts).
 * Undefined when a continuation row lacks the indent: not a geometry this reader knows.
 */
export function claudeDraftRows(capture: string): { rows: string[]; columns: number } | undefined {
  const range = claudeActiveBoxRange(capture);
  if (!range) return undefined;
  const all = capture.split("\n");
  const lines = all.slice(range.start, range.bot).map(plain);
  const rows = [lines[0]!.replace(/^[ \t]*[›❯][ \u00a0]?/, "")];
  for (const line of lines.slice(1)) {
    if (line.trim() && !line.startsWith("  ")) return undefined;
    rows.push(line.slice(2));
  }
  return { rows: rows.map(row => row.replace(/[ \t\u00a0]+$/, "")), columns: plain(all[range.bot]!).trim().length };
}

/** Active Claude box; opt in to a collapsed tail only when a caller can prove the hidden head. */
export function claudeBox(capture: string, allowCollapsed = false): { typed: string; raw: string; columns: number } | null {
  const range = claudeActiveBoxRange(capture, allowCollapsed);
  if (!range) return null;
  const { top, start, bot } = range;
  const lines = capture.split("\n");
  const first = range.collapsed ? plain(lines[start]!).slice(2) : plain(lines[start]!).match(CLAUDE_PROMPT)![1]!;
  const raw = [first, ...lines.slice(start + 1, bot).map(plain)].join("\n");
  const typed = raw.replace(/[ \t]+$/gm, "").trim();
  return { typed, raw, columns: plain(lines[bot]!).trim().length };
}

/**
 * The most composer rows Claude draws before it scrolls the draft, measured on
 * Claude Code 2.1.286 across pane heights 12 to 60 and widths 50 to 200: half the
 * pane height less five, never fewer than three. Width plays no part. The tests
 * record that calibration; after a Claude release, re-measure a live pane before
 * trusting it, and update the table rather than loosening the match.
 */
export function claudeComposerCap(paneHeight: number): number {
  return Math.max(3, Math.floor(paneHeight / 2) - 5);
}

/**
 * A draft taller than the composer scrolls: Claude moves the prompt glyph to the
 * first visible row and draws no scroll indicator (2.1.286), so a draft whose
 * visible tail is all newlines looks blank (tap-zo67f). The only witness is the
 * box at its height cap, computed from the pane's real `#{pane_height}`, never from
 * a capture's line count. Without that height the witness does not apply and the
 * verdict is unchanged. A whitespace-only draft
 * that happens to fill the cap also reads as held input. That is the safe side:
 * a held delivery is recoverable, typing over a human's hidden draft is not.
 * Revisit if Claude starts drawing a scroll indicator or the measured cap drifts.
 */
export function claudeScrolledBlank(capture: string, paneHeight?: number): boolean {
  if (!paneHeight || !Number.isInteger(paneHeight) || paneHeight < 1) return false;
  const box = claudeBox(capture);
  const range = claudeActiveBoxRange(capture);
  if (!box || !range || box.typed) return false;
  return range.bot - range.start === claudeComposerCap(paneHeight);
}

/**
 * A scrolled blank-tail draft is never cleared. Each clear key reveals a row above,
 * but blank rows are indistinguishable, so the clear chain cannot prove which row
 * came into view; it stops collecting and the keys go on erasing hidden text that
 * neither the composer nor the backup keeps. Only the human can recover it.
 */
export const CLAUDE_SCROLLED_DRAFT_REASON =
  "Claude draft is scrolled above blank visible rows; it cannot be backed up, so it is never cleared -- submit or clear it in the pane";

/**
 * Shared active-box geometry: the [top, bot) row span `claudeBox` reads, with
 * `start` the composer prompt row. Same refusals: approval dialog, a feedback
 * card that hides the composer (any box found then is an older one), prompt
 * rows below the bottom border, or no prompt inside the box. Tail readers may
 * opt into the explicitly marked collapsed span without licensing draft clears.
 */
export function claudeActiveBoxRange(capture: string, allowCollapsed = false): { top: number; start: number; bot: number; collapsed?: true } | null {
  if (approvalPrompt("claude", capture)) return null;
  const card = claudeFeedbackCard(capture);
  if (card && card.composer !== "visible") return null;
  return claudeGeometryRange(capture, allowCollapsed);
}

/** Geometry alone, also used to locate the composer below a feedback card without recursion. */
function claudeGeometryRange(capture: string, allowCollapsed = false): { top: number; start: number; bot: number; collapsed?: true } | null {
  const lines = capture.split("\n");
  let bot = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isClaudeBottomBorder(lines[i]!)) { bot = i; break; }
  }
  if (bot < 0) return null;
  // The idle background-agent tray has its own selection chevron below the
  // composer. Accept that row after either witness of a live tray: the agent
  // footer's count, or the tray's own structure — a "⏺ <name>" header row
  // above the detailed selected row, with the tray's unselected "◯" rows
  // between them keeping the arm (the caret may sit on any list row, not only
  // the first). The structural witness is required because Claude 2.1.283 can
  // draw the open tray while the footer's count slot holds a PR link instead
  // (tap-ile3j). A later ordinary prompt still invalidates this older box.
  // The selected row includes an agent description, elapsed time and token
  // count. A circle-prefixed human draft alone cannot invalidate the stale-box
  // safeguard merely because an older tray footer remains above it.
  const selectedAgent = /^[ \t]*❯ ◯ \S+[ \t]{2,}.+?[ \t]{2,}\d+[hms](?: \d+[hms])*[ \t]+·[ \t]+↓[ \t]+\d+(?:\.\d+)?[kKmM]?[ \t]+tokens[ \t]*$/;
  const trayHeader = /^[ \t]*⏺ \S/;
  const unselectedAgent = /^[ \t]*◯ \S/;
  let agentTray = false;
  let underTrayHeader = false;
  for (const line of lines.slice(bot + 1).map(plain)) {
    if (/⏵⏵.*← \d+ (?:agents?\b|agen…)/.test(line)) agentTray = true;
    if (CLAUDE_PROMPT.test(line)) {
      if (!((agentTray || underTrayHeader) && selectedAgent.test(line))) return null;
      // The structural witness admits exactly one selected row — the tray's
      // single caret — and is consumed by it. A second detailed row below is
      // not witnessed by the header above the first: it reads as a newer
      // prompt and refuses the box. The footer-count witness keeps its
      // permanence (its reviewed behavior).
      underTrayHeader = false;
    } else if (line.trim()) {
      // Only the tray's own rows hold the structural witness open — the ⏺
      // header arms it, unselected ◯ rows extend it — so status chrome, prose
      // or a foreign row below the list cannot arm it for a later chevron.
      underTrayHeader = trayHeader.test(line) || (underTrayHeader && unselectedAgent.test(line));
    }
  }
  let top = 0;
  for (let i = bot - 1; i >= 0; i--) {
    if (isClaudeBoxFence(lines[i]!)) { top = i + 1; break; }
  }
  if (top > 0 && isClaudeCollapsedFence(lines[top - 1]!)) {
    // Do not fall back to a transcript prompt above this fence, or treat a
    // prompt-shaped word in the hidden-head draft as the start of its input.
    if (!allowCollapsed || top === bot) return null;
    const rows = lines.slice(top, bot).map(plain);
    if (rows.some(row => !row.startsWith("  ")) || !rows.some(row => row.trim())) return null;
    if (Bun.stringWidth(plain(lines[top - 1]!).trimEnd()) !== plain(lines[bot]!).trim().length) return null;
    return { top, start: top, bot, collapsed: true };
  }
  let start = -1;
  for (let i = top; i < bot; i++) {
    if (CLAUDE_PROMPT.test(plain(lines[i]!))) { start = i; break; }
  }
  if (start < 0) return null;
  return { top, start, bot };
}

/**
 * Queued-but-unaccepted messages parked above the active box's top fence.
 *
 * Claude renders a delivered message the harness has not yet consumed as an
 * INDENTED prompt row directly above the fence, wrapped continuations indented
 * beneath it. Transcript prompt rows sit at column 0, so the indent is what
 * separates a queued message from transcript prose. Parsing reuses the exact
 * bounded box `claudeBox` recognizes — no active box, no rows.
 */
export function claudeQueuedRows(capture: string): string[] {
  const range = claudeActiveBoxRange(capture);
  if (!range) return [];
  const lines = capture.split("\n");
  const fence = range.top - 1;
  if (fence < 0 || !isClaudeBoxFence(lines[fence]!)) return [];
  const rows: string[] = [];
  let continuations: string[] = [];
  for (let i = fence - 1; i >= 0; i--) {
    const text = plain(lines[i]!);
    if (!text.trim()) continue;
    const queued = text.match(/^[ \t]+[›❯]\s*(.*)$/);
    if (queued) {
      rows.unshift([queued[1]!.replace(/[ \t]+$/, ""), ...continuations].join("\n"));
      continuations = [];
      continue;
    }
    if (/^[ \t]+\S/.test(text)) {
      continuations.unshift(text.trim());
      continue;
    }
    break;
  }
  return rows;
}

/**
 * A prompt row painted dim from end to end is Claude chrome, not a draft: the
 * `Try "…"` suggestion in an empty composer (tap-ybz1s) and the `Press up to
 * edit queued messages` hint. Paint decides, never the sentence; typed input is
 * never dim, and a paste chip stays input. Same rule as the submit reader.
 */
function claudeDimChrome(capture: string, typed: string): boolean {
  const range = claudeActiveBoxRange(capture);
  if (!range || isPasteCollapse("claude", typed)) return false;
  return dimPlaceholder(capture.split("\n")[range.start] ?? "", typed, "claude");
}

function familyOf(harness: string): string {
  const name = (harness.split("/").pop() ?? harness).toLowerCase();
  if (name.startsWith("claude")) return "claude";
  return name;
}

/** Incumbent paste-collapse chip shapes, keyed by live pane command. */
export function isPasteCollapse(paneCommand: string, text: string): boolean {
  return textHasPasteCollapse(paneCommand, text);
}

function panePresence(target: string): { state: "gone" } | { state: "rate_limited" | "unobservable"; reason: string; cause?: "pane_dead" } | null {
  const live = observePaneResult(target);
  if (live.status === "rate_limited") {
    return { state: "rate_limited", reason: "tmux client budget exhausted before pane input could be inspected" };
  }
  if (live.status === "pane_gone") return { state: "gone" };
  if (live.status === "pane_dead") return { state: "unobservable", cause: "pane_dead", reason: `pane '${target}' has exited; no live input is available` };
  if (live.status === "unobservable") return { state: "unobservable", reason: live.reason };
  return null;
}

/** Budgeted `#{pane_in_mode}` peek. Never cancels copy-mode. */
export type CopyModeObservation =
  | { status: "copy-mode" }
  | { status: "normal" }
  | { status: "unobservable"; reason: string; cause?: "pane_dead" }
  | { status: "rate-limited"; reason: string }
  | { status: "gone" };

export function observeCopyMode(target: string): CopyModeObservation {
  const mode = tmux(["display-message", "-p", "-t", target, "#{pane_in_mode}"]);
  if (mode.rateLimited) {
    return { status: "rate-limited", reason: "tmux client budget exhausted before copy-mode could be inspected" };
  }
  if (mode.code !== 0) {
    const again = panePresence(target);
    if (again?.state === "gone") return { status: "gone" };
    if (again?.state === "unobservable" && again.cause === "pane_dead") return { status: "unobservable", cause: "pane_dead", reason: again.reason };
    if (again?.state === "rate_limited") return { status: "rate-limited", reason: again.reason };
    return { status: "unobservable", reason: `could not read copy-mode flag for '${target}'` };
  }
  const flag = mode.stdout.trim();
  if (flag === "1") return { status: "copy-mode" };
  if (flag === "0") return { status: "normal" };
  return { status: "unobservable", reason: `unrecognized pane_in_mode ${JSON.stringify(flag)}` };
}

export function toPaneBand(classified: ClassifiedPane): PaneBand {
  switch (classified.kind) {
    case "ready": return { state: "ready" };
    case "draft": return classified.rows
      ? { state: "busy", text: classified.text, rows: classified.rows, columns: classified.columns,
        ...(classified.scrolled ? { scrolled: true as const } : {}), ...(classified.mayBeTruncated ? { mayBeTruncated: true as const } : {}) }
      : { state: "busy", text: classified.text };
    case "queued": return { state: "busy", text: classified.text, queued: true };
    case "gone": return { state: "gone" };
    case "rate-limited": return { state: "rate_limited", reason: classified.reason };
    case "copy-mode": return { state: "unobservable", reason: "pane is in copy-mode" };
    case "no-band": return { state: "unobservable", reason: classified.reason, ...(classified.cause ? { cause: classified.cause } : {}) };
  }
}

/** Owner/delivery seam: six-state kind, including copy-mode. Do not substitute paneState(). */
export function toPaneProbe(classified: ClassifiedPane): { kind: PaneKind } {
  return { kind: classified.kind === "queued" ? "no-band" : classified.kind };
}

/**
 * Typed copy-mode surface for Courier owner delivery (tap-nwgh8 U1).
 * Callers consume this instead of the Courier-local `#{pane_in_mode}` peek.
 * `paneState()` stays the frozen PaneBand path and still collapses copy-mode.
 */
export function observePaneProbe(target: string, harness: string, command: string): { kind: PaneKind } {
  return toPaneProbe(observePaneKind(target, harness, command));
}

/**
 * Shared classifier over captured bytes. Cursor and Hermes read the pane
 * reader's verdict on the supplied frame; every other unsupported family
 * classifies no-band.
 */
/** A pane-band refusal no delivery override may clear. */
export const APPROVAL_PROMPT_REASON = "human approval prompt is visible";
/** The feedback card hides the composer, so neither its owner nor the courier can read it. */
export const CLAUDE_FEEDBACK_DRAFT_REASON = "Claude feedback-draft card hides the composer; a human or the seat's leader dismisses the card, or submits or clears any text under it";

/**
 * `paneHeight` is the pane's real `#{pane_height}` when the caller read it with
 * this capture; only Claude's scrolled-draft witness uses it, and without it no
 * verdict changes.
 */
export function classifyPane(capture: string, harness: string, copyMode: boolean, paneHeight?: number): ClassifiedPane {
  const classified = classifyFamily(capture, harness, copyMode, paneHeight);
  // Each family reader strips its own chrome; the blanking rule then decides once
  // for all of them, so a band of only whitespace reads ready on every harness.
  // A scrolled Claude draft is the one exception: its text is above the viewport.
  return classified.kind === "draft" && !classified.scrolled && !hasInputText(classified.text) ? { kind: "ready" } : classified;
}

function classifyFamily(capture: string, harness: string, copyMode: boolean, paneHeight?: number): ClassifiedPane {
  if (copyMode) return { kind: "copy-mode" as const };
  if (familyOf(harness) === "opencode" && opencodeShellMode(capture)) return { kind: "no-band", reason: OPENCODE_SHELL_MODE_REASON, cause: "shell-mode" };
  // agy's branch below reports its own overlay, which includes this rule.
  if (familyOf(harness) !== "agy" && approvalPrompt(harness, capture)) return { kind: "no-band", reason: codexHookTrust(harness, capture) ? CODEX_HOOK_TRUST_REASON : APPROVAL_PROMPT_REASON };
  if (familyOf(harness) === "claude") {
    // A card over a complete composer is not a hold; a composer it hides is (tap-89a57).
    const card = claudeFeedbackCard(capture);
    if (card && card.composer !== "visible") return { kind: "no-band", reason: CLAUDE_FEEDBACK_DRAFT_REASON, cause: "feedback-draft" };
    const box = claudeBox(capture);
    if (!box) return { kind: "no-band", reason: "no recognized Claude input box" };
    if (box.typed && !claudeDimChrome(capture, box.typed)) {
      const drawn = claudeDraftRows(capture);
      return drawn ? { kind: "draft", text: box.typed, ...drawn,
        ...(drawn.rows.length >= (paneHeight ? claudeComposerCap(paneHeight) : 3) ? { mayBeTruncated: true as const } : {}) }
        : { kind: "draft", text: box.typed, mayBeTruncated: true };
    }
    if (claudeScrolledBlank(capture, paneHeight)) {
      // The rows are what is visible, nothing synthesized; delivery never clears this band.
      const drawn = claudeDraftRows(capture);
      if (drawn) return { kind: "draft", text: drawn.rows.join("\n"), ...drawn, scrolled: true };
    }
    return { kind: "ready" };
  }
  if (familyOf(harness).startsWith("codex")) {
    const composer = readComposerFrame(capture, "codex");
    if (composer === null) return { kind: "no-band", reason: "no recognized Codex composer" };
    if (composer) return { kind: "draft", text: composer };
    const queued = codexQueuedRows(capture);
    if (queued.length) return { kind: "queued", text: queued.join("\n") };
    return { kind: "ready" };
  }
  if (familyOf(harness) === "opencode") {
    if (opencodeTerminalOverprint(capture)) {
      return { kind: "no-band", reason: "OpenCode terminal overprint obscures the composer", cause: "overprint" };
    }
    const composer = readComposerFrame(capture, "opencode");
    if (composer === null) return { kind: "no-band", reason: "no recognized OpenCode composer" };
    return composer ? { kind: "draft", text: composer } : { kind: "ready" };
  }
  if (familyOf(harness) === "agy") {
    // The overlay readers get the plain frame they have always read. Only the
    // composer reader is handed paint, for its mode-hint check.
    const plain = capture.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    if (agySurveyOverlay(plain)) return { kind: "no-band", reason: "Antigravity survey blocks the composer" };
    if (agyPermissionOverlay(plain)) return { kind: "no-band", reason: "Antigravity permission overlay is visible" };
    const composer = agyComposer(capture);
    if (composer === null) return { kind: "no-band", reason: "no recognized Antigravity composer" };
    return composer ? { kind: "draft", text: composer } : { kind: "ready" };
  }
  const family = familyOf(harness);
  if (family.startsWith("cursor") || family.startsWith("hermes")) {
    const pending = pendingInputText(NO_RECAPTURE, "", family, capture);
    if (pending.status === "text") {
      // The prompt row is only the LAST row of a typed draft, and an empty
      // prompt row can still sit above typed continuation rows. The full
      // active composer on the SAME supplied frame decides readiness, not
      // the row alone; when bounded geometry is unavailable the row stays
      // the conservative fallback.
      const composer = composerInput(capture, family);
      // composerInput models awk's emitted trailing newline; this is an
      // in-process caller, so strip exactly that synthetic terminator and
      // keep real hard newlines.
      let text = composer.state === "text" ? composer.text.replace(/\n$/, "") : "";
      // The reader collapses the idle placeholder on the prompt row, but the
      // composer's generic branch has no dim model — so for hermes its text
      // is chrome unless the region extends past the prompt row.
      if (family.startsWith("hermes") && pending.text === "" && !text.startsWith("\n")) text = "";
      if (text === "") text = pending.text;
      return text === "" ? { kind: "ready" } : { kind: "draft", text };
    }
    return { kind: "no-band", reason: `no readable ${family} prompt row in the supplied frame` };
  }
  return { kind: "no-band", reason: "no shared classifier for this harness" };
}

/**
 * The pane's `#{pane_height}`, undefined when tmux answers without a positive
 * integer, or "rate-limited" when the client budget refused the read: a refused
 * read must hold, not fall back to the no-witness verdict.
 */
export function paneHeight(target: string, run: typeof tmux = tmux): number | undefined | "rate-limited" {
  const r = run(["display-message", "-p", "-t", target, "#{pane_height}"]);
  if (r.rateLimited) return "rate-limited";
  if (r.code !== 0) return undefined;
  const value = r.stdout.trim();
  return /^[1-9]\d*$/.test(value) ? Number(value) : undefined;
}

/**
 * Six-state live observation for Courier owner delivery. Copy-mode is
 * `copy-mode`, never collapsed to no-band. Reads `#{pane_in_mode}` only.
 */
export function observePaneKind(target: string, harness: string, command: string): ClassifiedPane {
  const presence = panePresence(target);
  if (presence?.state === "gone") return { kind: "gone" };
  if (presence?.state === "rate_limited") return { kind: "rate-limited", reason: presence.reason };
  if (presence?.state === "unobservable") return { kind: "no-band", reason: presence.reason, ...(presence.cause ? { cause: presence.cause } : {}) };
  const mode = observeCopyMode(target);
  if (mode.status === "gone") return { kind: "gone" };
  if (mode.status === "rate-limited") return { kind: "rate-limited", reason: mode.reason };
  if (mode.status === "unobservable") return mode.cause === "pane_dead"
    ? { kind: "no-band", cause: "pane_dead", reason: mode.reason } : afterLiveNoBand(target, mode.reason);
  if (mode.status === "copy-mode") return { kind: "copy-mode" };
  // Family authority is the bound harness; the pane command is only the
  // empty-harness fallback.
  const family = familyOf(harness || command);
  const native = family === "claude" || family.startsWith("codex") ||
    family === "opencode" || family === "agy" ||
    family.startsWith("cursor") || family.startsWith("hermes");
  if (native) {
    // OpenCode's first-load placeholder sits where typed text goes and differs
    // only by colour, so an unescaped capture reads it as a draft (tap-yqonr).
    // Antigravity's mode hint is the same case: it held mail for the draft grace.
    const escaped = family === "claude" || family.startsWith("codex") || family === "opencode" || family === "agy" || family.startsWith("cursor") || family.startsWith("hermes");
    const captured = capturePane(target, escaped, family !== "opencode");
    if (captured.rateLimited) {
      return { kind: "rate-limited", reason: "tmux client budget exhausted before pane input could be inspected" };
    }
    if (captured.code !== 0) {
      return afterLiveNoBand(target, `capture-pane failed for '${target}'`);
    }
    const height = family === "claude" ? paneHeight(target) : undefined;
    if (height === "rate-limited") {
      return { kind: "rate-limited", reason: "tmux client budget exhausted before pane height could be read" };
    }
    return classifyPane(captured.stdout, harness || command, false, height);
  }
  return afterLiveNoBand(target, "no shared classifier for this harness");
}

/**
 * Pre-inject band. `harness` is BoundRecipient.harness; `command` is the
 * authorized observation's currentCommand for prompt-glyph matching only.
 * Copy-mode maps to unobservable here so submitVerify refuses without a
 * PaneBand expansion; owner delivery must call observePaneKind instead.
 */
export function paneState(target: string, harness: string, command: string): PaneBand {
  return toPaneBand(observePaneKind(target, harness, command));
}

/** Land/clear observation of one id in the active band. */
export function observeInputId(target: string, command: string, id: string): InputObservation {
  const presence = panePresence(target);
  if (presence) return presence;
  const captured = observeInputRegion(target, command);
  if (captured.status === "rate_limited") {
    return { state: "rate_limited", reason: captured.reason };
  }
  if (captured.status === "unobservable") {
    return { state: "unobservable", reason: captured.reason };
  }
  if (captured.status === "no_prompt") {
    return { state: "unobservable", reason: `no input prompt is visible in '${target}' (the harness may be mid-turn)` };
  }
  const region = captured.region;
  if (normalizeInputMatch(region).includes(normalizeInputMatch(id))) {
    return { state: "present", text: region };
  }
  if (isPasteCollapse(command, region)) {
    return { state: "chip", text: region };
  }
  return { state: "absent" };
}
