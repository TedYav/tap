/**
 * The ONE pane reader.
 *
 * Every function here replaces a Bash body in `skills/tap/scripts/lib.sh` that
 * captured a pane and decided something about the band on it. The pure
 * frame-to-verdict half of that family was ported first (`submit-frame.ts`,
 * `opencode-composer.ts`); what stayed in Bash was the half that holds the
 * capture, re-derives prompt geometry with `grep`/`awk`/`sed` and a per-call
 * the incumbent's interpreter, and decides whether a human's draft is about to be typed over.
 *
 * THE POLARITY RULE governs every verdict below. `tap_submit_verify`'s
 * draft-clear proceeds to the backup and the `C-u` on status 3 and DEFERS on
 * status 4. So:
 *
 *   status 3  "nothing readable was here"  — the caller may push through
 *   status 4  "a human is being asked"     — never typed over
 *
 * and **unconvincing geometry never reports a clear band**. A reader that
 * cannot see is not a reader that saw nothing. The specimen: a
 * NBSP-padded prompt row read as absent geometry where the incumbent read it as
 * a draft — shipped past a green exact-head gate and two family approvals, and
 * caught by a review bot, because the differential's one NBSP case put the byte
 * on the far side of the glyph.
 */
import { createHash } from "node:crypto";
import { AWK_POSIX_SPACE, HERMES_PREFIX, PYTHON_SPACE, normalizeInputMatch } from "../terminal-text";
import { approvalPrompt } from "../agent-state";
import { claudeActiveBoxRange, claudeFeedbackCard } from "../pane-state";
import { agyComposer, agyPermissionOverlay, composerInput } from "../submit-frame";
import { opencodeBoxText, opencodeTerminalOverprint } from "../opencode-composer";
import { tmux } from "../tmux";
import {
  promptGlyph,
  promptRowReAwk,
  promptRowReGrep,
  stripAnsi,
  dimPromptInput,
  stripPromptRow,
  stripRowTail,
  textHasPasteCollapse,
} from "./geometry";

/** Python's `str.strip()`, which is not JavaScript's `trim()`. */
const PY_TRIM = new RegExp(`^[${PYTHON_SPACE}]+|[${PYTHON_SPACE}]+$`, "g");
const pyStrip = (text: string): string => text.replace(PY_TRIM, "");
/** Python's `re.sub(r"\\s+", " ", …)` — the same class, not JS `\s`. */
const PY_RUNS = new RegExp(`[${PYTHON_SPACE}]+`, "g");
const pyCollapse = (text: string): string => pyStrip(text).replace(PY_RUNS, " ");

/**
 * Every tmux read this family performs, behind one seam.
 *
 * Not an abstraction for its own sake: the whole reader is testable from a
 * captured frame only if exactly one place spells `capture-pane`, and the
 * incumbent spelled it in seven.
 */
export interface PaneIo {
  capture(target: string, escaped: boolean, joined: boolean): { code: number; stdout: string };
  paneWidth(target: string): string;
}

/** `run` defaults to the rate-limited courier client; a pure observer passes `tmuxReadOnly`. */
export function paneIo(env?: NodeJS.ProcessEnv, run: typeof tmux = tmux): PaneIo { return {
  capture(target, escaped, joined) {
    const r = run(["capture-pane", ...(joined ? ["-J"] : []), "-p", ...(escaped ? ["-e"] : []), "-t", target], env ?? process.env);
    return { code: r.code, stdout: r.stdout };
  },
  paneWidth(target) {
    const r = run(["display-message", "-p", "-t", target, "#{pane_width}"], env ?? process.env);
    return r.code === 0 ? r.stdout.trim() : "";
  },
}; }

export const realPaneIo: PaneIo = paneIo();

/**
 * A `PaneIo` backed by ONE already-taken escaped capture.
 *
 * This is how the Bash adapters reach the reader, and it is not a testing
 * convenience: it keeps CAPTURE in the caller's language while the DECISION
 * lives here once. The suite's pane fixtures work by overriding
 * `tap_capture_pane` as a shell function, so a reader that captured for itself
 * would be invisible to twenty-one existing smokes — and a production door that
 * honoured an environment variable to fake a pane read would be a worse answer
 * than either.
 *
 * `capture-pane -p` without `-e` is the same frame with its SGR sequences
 * removed, so the plain view is derived rather than sampled again. That is a
 * MEASURED DEVIATION and it is declared: the incumbent's generic
 * `tap_pending_input_text` took up to three separate samples (a plain row, an
 * escaped row, the pane width) and could observe a band mid-redraw differently
 * in each. One sample cannot disagree with itself, which is the safe direction —
 * and the deliberate double-read in `pendingInputProbe` is unaffected, because
 * that one calls the whole reader twice.
 */
/**
 * A `PaneIo` backed by the TWO captures the incumbent took, handed over by the
 * adapter rather than derived from one another.
 *
 * `frameIo` below derives the plain view with `stripAnsi`, and that is not the
 * same thing as tmux's plain capture: `stripAnsi` strips CSI, so an OSC 8
 * hyperlink wrapping the prompt row survives it, the derived row stops starting
 * with the glyph, and the reader answers rc 3 — absent geometry, the type-over
 * direction — where the incumbent returned the draft (reproduced on a real tmux
 * 3.7c pane by the reviewer).
 *
 * The incumbent never derived: `tap_inputline` took `capture-pane -p`, which
 * tmux renders without emitting the hyperlink at all. Its own `tap_strip_ansi`
 * is the SAME CSI-only regex, so widening the strip would make this port differ
 * from the incumbent in a NEW way and still leave DCS/APC/PM/SOS behind it.
 * Turning escaped bytes into plain ones is terminal emulation, not a regex.
 *
 * Bash adapters that still capture through `tap_capture_pane` hand their frames in
 * here. lib.sh's `tmux()` routes through `tmux_deadline.py`, which applies the same
 * TAP_TMUX_SOCKET_PATH/NAME selection as `runTmux`, so a native capture (peek's
 * `paneIo`) asks the same server.
 */
export function framePairIo(escaped: string, plain: string, width: string): PaneIo {
  return {
    capture: (_target, wantEscaped) => ({ code: 0, stdout: wantEscaped ? escaped : plain }),
    paneWidth: () => width,
  };
}

/**
 * Derives the plain view from one escaped capture. FIXTURE USE ONLY — see
 * `framePairIo` for why production must not derive.
 */
export function frameIo(frame: string, width: string): PaneIo {
  const plain = stripAnsi(frame);
  return {
    capture: (_target, escaped) => ({ code: 0, stdout: escaped ? frame : plain }),
    paneWidth: () => width,
  };
}

/**
 * `tap_capture_input_frame` (lib.sh:10358).
 *
 * OpenCode opts out of `-J`. One renderer can mark every physical row wrapped
 * and collapse the whole pane into a single line, which destroys the box
 * geometry the OpenCode reader depends on; every other harness needs the join
 * so a soft-wrapped token survives. The incumbent expressed this as a bare
 * `tmux capture-pane` versus the `-J` wrapper, and the EXACT name test is the
 * incumbent's too: the test was on the harness BASENAME compared for equality
 * with `opencode`, never a prefix match.
 */
export function captureInputFrame(io: PaneIo, target: string, harness: string, escaped: boolean): { ok: true; frame: string } | { ok: false } {
  const bare = (harness.split("/").pop() ?? harness) === "opencode";
  const r = io.capture(target, escaped, !bare);
  return r.code === 0 ? { ok: true, frame: r.stdout } : { ok: false };
}

/**
 * `tap_inputline` (lib.sh:10371) — the LAST prompt row, or OpenCode's box text.
 *
 * `grep -E … | tail -1`: the last match, and `|| true` meant a capture with no
 * prompt row was the empty string rather than a failure. The selector class is
 * `grep`'s, which is WIDER than the `awk` class `inputRegion` selects with —
 * see `geometry.ts` for the measurement and why the two disagree on purpose.
 */
export function inputLine(io: PaneIo, target: string, cmd: string): { ok: true; line: string } | { ok: false } {
  if (cmd === "opencode") {
    const captured = captureInputFrame(io, target, cmd, true);
    if (!captured.ok) return { ok: false };
    const box = opencodeBoxText(captured.frame);
    return box === null ? { ok: false } : { ok: true, line: box };
  }
  const r = io.capture(target, false, true);
  // `tap_capture_pane | grep | tail -1 || true`: only the pipeline's last
  // status reached the caller, so a failed capture and an empty pane were the
  // same empty answer. Reproduced rather than corrected — the callers that read
  // this as "no band" are the polarity rule's status-3 side, and turning a
  // capture failure into a distinct value here would change what they do.
  if (r.code !== 0) return { ok: true, line: "" };
  const box = cmd.startsWith("claude") ? claudeActiveBoxRange(r.stdout) : null;
  if (box) return { ok: true, line: `${r.stdout.split("\n")[box.start]}\n` };
  const re = promptRowReGrep(cmd);
  const rows = r.stdout.split("\n").filter(row => re.test(row));
  // `tail -1` prints the row it selected WITH its terminator, and `grep` prints
  // nothing at all when nothing matched. Every Bash consumer of the generic
  // branch reads this through `$(…)`, which strips it — but the OpenCode branch
  // above ends in `printf '%s'` and `tap_pending_input_text` writes ITS result
  // straight to stdout, so the two branches genuinely differ by one byte and
  // reproducing that costs one conditional.
  return { ok: true, line: rows.length ? `${rows[rows.length - 1]!}\n` : "" };
}

/**
 * `tap_inputregion` (lib.sh:10388) — the active region for id matching and
 * draft backup: the LAST prompt row plus every following row.
 *
 * The last, not the first. A capture holds the transcript, which contains every
 * earlier prompt and every previously submitted line; anchoring on the first
 * match returns the whole scrollback, and a sentinel submitted minutes ago then
 * still reads as pending input.
 *
 * The incumbent's awk terminated EVERY row it printed, so a non-empty region
 * ends in a newline and trailing blank rows are kept. `composerInput`'s generic
 * branch trims them; this one does not, and the difference is load-bearing for
 * `inputRegionHasContinuation`, which asks whether any row after the first has
 * a field.
 */
export type Region = { status: "ok" | "no-band"; region: string };

export function inputRegion(io: PaneIo, target: string, cmd: string): Region {
  if (cmd === "opencode") {
    const line = inputLine(io, target, cmd);
    // OpenCode inherits `tap_inputline`'s status, box text and all.
    return line.ok ? { status: "ok", region: line.line } : { status: "no-band", region: "" };
  }
  if (cmd === "agy") {
    // Bounded band only, between the bottom rule pair. The prompt-anchored scan
    // would start at a transcript '>' echo and drag the rule and footer in.
    // An absent rule-pair band is status 3, as `tap_agy_box_text` returned it.
    const r = io.capture(target, true, true);
    if (r.code !== 0) return { status: "no-band", region: "" };
    const box = agyComposer(r.stdout);
    return box === null ? { status: "no-band", region: "" } : { status: "ok", region: box };
  }
  const r = io.capture(target, false, true);
  // The generic branch is an `awk` pipeline whose status the incumbent never
  // reported: a failed capture printed nothing at status 0. Preserved.
  if (r.code !== 0) return { status: "ok", region: "" };
  const box = cmd.startsWith("claude") ? claudeActiveBoxRange(r.stdout) : null;
  if (box) return { status: "ok", region: r.stdout.split("\n").slice(box.start, box.bot).join("\n") + "\n" };
  const re = promptRowReAwk(cmd);
  const lines = r.stdout.split("\n");
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (re.test(lines[i]!)) { start = i; break; }
  if (start < 0) return { status: "ok", region: "" };
  // awk's records exclude the final newline of the stream, so a capture ending
  // in "\n" contributes no trailing empty record. Splitting in JS produces one,
  // and keeping it would append a spurious blank row to every region.
  const rows = lines.slice(start);
  if (rows.length && rows[rows.length - 1] === "" && r.stdout.endsWith("\n")) rows.pop();
  return { status: "ok", region: rows.length ? rows.join("\n") + "\n" : "" };
}

/**
 * `tap_escaped_prompt_from_frame` (lib.sh:11909) — the last prompt row WITH its
 * SGR sequences, for dim-placeholder detection only.
 *
 * Anchored on an ANSI-STRIPPED copy of each row and returning the RAW row: an
 * escaped input line begins with SGR, so anchoring the raw row would never
 * match, while an unanchored search would let a transcript arrow elsewhere in
 * the window win as the last match.
 *
 * The 12-row window is anchored at the last NON-BLANK row, not the pane bottom.
 * cursor-agent's prompt is not bottom-fixed — it scrolls down as the transcript
 * fills, leaving blank rows beneath that a plain tail would search instead.
 */
export function escapedPromptFromFrame(frame: string, cmd: string): string {
  // OpenCode has no glyph prompt row; a stray chevron in the transcript tail
  // must not be mistaken for one. Its input state comes from the box.
  if (cmd === "opencode") return "";
  const box = cmd.startsWith("claude") ? claudeActiveBoxRange(frame) : null;
  if (box) return `${frame.split("\n")[box.start]}\n`;
  const re = promptRowReAwk(cmd);
  const raw = frame.split("\n");
  const plain = raw.map(row => row.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""));
  // awk's own `s ~ /[^[:space:] ]/`: a row holding any character outside the
  // AWK space class. Not Python's and not JS's — the instrument was awk.
  const nonBlank = new RegExp(`[^${AWK_POSIX_SPACE}]`);
  let lastNonBlank = -1;
  for (let i = 0; i < plain.length; i++) if (nonBlank.test(plain[i]!)) lastNonBlank = i;
  if (lastNonBlank < 0) return "";
  const lo = Math.max(0, lastNonBlank - 11);
  let last = "";
  for (let i = lo; i <= lastNonBlank; i++) if (re.test(plain[i]!)) last = raw[i]!;
  // `if (last != "") print last` — awk terminates the row it prints, and prints
  // nothing when it found none.
  return last === "" ? "" : `${last}\n`;
}

/** `tap_escaped_inputline` (lib.sh:11903). */
export function escapedInputLine(io: PaneIo, target: string, cmd: string): string {
  const r = io.capture(target, true, true);
  if (r.code !== 0) return "";
  return escapedPromptFromFrame(r.stdout, cmd);
}

/**
 * Cursor band chrome is never a human draft.
 *
 * WHOLE BAND ONLY — never a substring strip. Bare "ctrl+c to stop" is NOT
 * chrome: a human can type exactly that, and stripping it out of a real draft
 * is data loss (review P1, at 8617652a). Real busy chrome always pairs with a
 * placeholder.
 */
export function cursorBandChrome(text: string): boolean {
  const t = pyCollapse(text);
  if (t === "" || t === "Add a follow-up" || t === "Plan, search, build anything") return true;
  return /^(Add a follow-up|Plan, search, build anything)( ctrl\+c to stop)?$/.test(t);
}

/**
 * The same check as `cursorBandChrome`, minus the empty string.
 *
 * `tap_input_state_from_region`'s chrome set includes `""` while
 * `tap_pending_input_text`'s does not. It reads like an oversight and is not
 * reachable as one — both callers test a value they have already proven
 * non-empty — but the two programs are not the same program, and collapsing
 * them would be a judgement about reachability rather than a port.
 */
function cursorBandChromeNonEmpty(text: string): boolean {
  const t = pyCollapse(text);
  if (t === "Add a follow-up" || t === "Plan, search, build anything") return true;
  return /^(Add a follow-up|Plan, search, build anything)( ctrl\+c to stop)?$/.test(t);
}

const ELLIPSIS = "…";
const CLAUDE_ARG_HINTS: Record<string, string> = {
  "/compact": "<optional custom summarization instructions>",
  "/goal": "[<condition> | clear]",
  "/loop": "[interval] [prompt]",
  "/clear": "[name]",
};
const BLANKS_BEFORE_HINT = 2;

/** East-asian wide cells, as `unicodedata.east_asian_width in ("F","W")`. */
function cells(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    n += (cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a
      || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f)
      || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
      || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60)
      || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f)
      || (cp >= 0x1f900 && cp <= 0x1f9ff)
      || (cp >= 0x20000 && cp <= 0x3fffd))) ? 2 : 1;
  }
  return n;
}

/**
 * `tap_strip_claude_arg_hint` (lib.sh:11323).
 *
 * Claude Code paints an argument-placeholder hint after a recognized slash
 * command whose argument is still empty. Four commands are affected and they
 * share no text grammar. The hint is chrome in the typed-text position — the
 * pane owner never typed it and the harness never submits it — so removing it
 * is the BAND READER's job, not any one caller's (tap-tx3s, CONTRACT.md:2799).
 *
 * Refuses (returns the input unchanged) on anything it cannot identify by BOTH
 * where the hint sits and the placeholder's own text. The truncated form is
 * accepted only when the row fills the pane exactly, which is the geometry
 * signal that the terminal did the truncating.
 *
 * TWO REJECTED DESIGNS, carried from the Bash body this replaced. Both are the
 * obvious implementation, so without this record they come back.
 *
 * 1. COLOUR IS NOT AN AUTHORITY. An earlier rule used style-plus-position, on
 *    the reasoning "match what the harness PAINTS rather than what the hint
 *    SAYS". It failed: a reviewer built a band holding a pane owner's REAL typed
 *    draft in the hint's position, painted a muted gray a theme could plausibly
 *    produce, and it stripped. Colour also binds the reader to the capture
 *    environment — an ANSI-256 downgrade when truecolor is not advertised, which
 *    happens whenever CLAUDE_CODE_TMUX_TRUECOLOR is unset under tmux or
 *    NO_COLOR / FORCE_COLOR=0 leaks in from the launching client. Zero 38;5 was
 *    observed on sampled production panes. There is no colour conjunct here and
 *    adding one is a regression, not a hardening.
 *
 * 2. NOT THE PAINTED CURSOR CELL. The obvious reading of the position signal is
 *    "the hint follows the reverse-video cursor cell". That was implemented
 *    first and is wrong: at the production read beat the cell is usually not
 *    painted at all — a census found it painted in 0/12 captures and 0/20 at
 *    steady state, with the hint present in every one. Requiring it would have
 *    left the defect in place on the common render while the fixtures said
 *    green, because the first fixtures happened to catch the painted variant
 *    minutes after a fresh start. Paint is corroboration, never a requirement.
 *
 *    What survives is the column the cursor RESERVES whether or not it is
 *    painted: committing the command token takes the trailing space, so the
 *    healthy shape is always [typed][committed space][reserved column][hint] —
 *    hence exactly two blanks, on all four verbs and under both renders.
 *
 * The placeholder table is enumerated and deliberately NOT generalized to an
 * angle/bracket grammar. That generalization was tried first and fits a pane
 * owner's own bracket text — `/compact <not really a hint>` — exactly as well as
 * it fits a hint. A reworded placeholder leaves the table and the caller returns
 * to its pre-existing behaviour, which is the intended failure direction.
 */
export function stripClaudeArgHint(typed: string, row: string, widthRaw: string): string {
  // Peel prompt leftovers only: glyph, POSIX space, NBSP. macOS bash passes a
  // lone NBSP byte that Python's argv decode turned into a surrogate, so the
  // incumbent matched that class rather than one code point; the surrogate
  // range is kept here because a frame carrying an unpaired surrogate must peel
  // identically rather than stop early.
  let body = typed;
  while (body.length > 0 && body[0] !== "/") {
    const o = body.codePointAt(0)!;
    if (o === 0x276f || o === 0x203a || o === 0xa0 || o === 0x20 || o === 0x09 || (o >= 0xdc00 && o <= 0xdfff)) {
      body = body.slice(1);
      continue;
    }
    break;
  }
  let command: string | null = null;
  let after = "";
  for (const cmd of Object.keys(CLAUDE_ARG_HINTS)) {
    if (body === cmd || body.startsWith(cmd)) { command = cmd; after = body.slice(cmd.length); break; }
  }
  if (command === null) return typed;
  const blanks = after.length - after.replace(/^ +/, "").length;
  if (blanks !== BLANKS_BEFORE_HINT) return typed;
  const hint = after.slice(blanks);
  if (!hint) return typed;
  const placeholder = CLAUDE_ARG_HINTS[command]!;
  let accepted = hint === placeholder;
  if (!accepted && hint.endsWith(ELLIPSIS)) {
    const prefix = hint.slice(0, -ELLIPSIS.length);
    if (prefix && prefix !== placeholder && placeholder.startsWith(prefix)) {
      const trimmed = (widthRaw || "").trim();
      const width = /^[0-9]+$/.test(trimmed) ? Number(trimmed) : NaN;
      if (Number.isFinite(width) && width > 0 && cells(row) === width) accepted = true;
    }
  }
  return accepted ? command : typed;
}

/**
 * `tap_pending_input_text` (lib.sh:11408) — the band's TYPED text.
 *
 * The four answers are the contract, and they are not interchangeable:
 *
 *   `{ status: "text" }`    rc 0 — this is what is typed (empty = a clear band)
 *   `{ status: "no-band" }` rc 3 — nothing readable was here
 *   `{ status: "overprint" }` — terminal output split OpenCode's input geometry
 *   `{ status: "blocked" }` rc 4 — a modal is asking this seat's human
 *
 * `frame` is a caller's already-observed capture. Supplying it keeps the
 * prompt-row and styled-placeholder rules without taking another sample, and
 * changes which reader runs: the generic path reads the prompt row out of the
 * supplied ESCAPED frame instead of re-capturing a plain one.
 */
export type PendingInput =
  | { status: "text"; text: string }
  | { status: "no-band" }
  | { status: "overprint" }
  | { status: "blocked" };

export function pendingInputText(io: PaneIo, target: string, cmd: string, frame?: string): PendingInput {
  if (cmd === "opencode") {
    // Read one escaped frame so the torn-band predicate and text reader decide
    // the same observation. A child stderr overprint is distinct from startup:
    // callers may repaint it once, while a genuinely absent band stays booting.
    const captured = frame === undefined
      ? captureInputFrame(io, target, cmd, true)
      : { ok: true as const, frame };
    if (!captured.ok) return { status: "no-band" };
    if (approvalPrompt(cmd, captured.frame)) return { status: "blocked" };
    if (opencodeTerminalOverprint(captured.frame)) return { status: "overprint" };
    const text = opencodeBoxText(captured.frame);
    return text === null ? { status: "no-band" } : { status: "text", text };
  }
  if (cmd === "agy") {
    // BAND PRESENCE IS READINESS, not the footer's turn vocabulary (tap-92v3r).
    // agy queues typed input mid-turn like every non-hermes harness, so a
    // visible '>' band between its rule pair is permission to type wherever
    // that band sits — under a spinner, and with a task card rendered BELOW it.
    const r = io.capture(target, true, true);
    if (r.code !== 0) return { status: "no-band" };
    // `_agy_cap="$(tap_capture_pane …)"` then `printf '%s\n' "$_agy_cap" | …`:
    // the substitution stripped every trailing newline and the printf added
    // back exactly one, so both agy readers saw that frame, not the capture.
    const agyFrame = `${commandSubstitution(r.stdout)}\n`;
    // Fail-closed on a recognized permission modal BEFORE the band read: a
    // modal can leave the band rendered, and geometry alone would then say
    // "inject". BLOCKED, not no-band — ruling 15 item 3. A recognized modal and
    // an unreadable pane are opposite dispositions: the modal HOLDS and is
    // retried on the next drain, never reported to the sender as "will not
    // arrive", while an unknown no-band pane holds for a bounded three
    // post-deadline looks and is then injected anyway. One value for both left
    // the force path nothing to exclude on.
    if (agyPermissionOverlay(agyFrame)) return { status: "blocked" };
    const box = agyComposer(agyFrame);
    return box === null ? { status: "no-band" } : { status: "text", text: box };
  }

  // THE OVERLAY FRAME AND THE PROMPT-ROW SOURCE ARE TWO DIFFERENT THINGS, and
  // only claude promotes one to the other. The incumbent captured a frame for
  // both claude and codex to run the approval check, and then ran
  // `set -- "$pane" "$cmd" "$full_frame"` **inside the `claude*` arm only** —
  // so a codex pane with no caller-supplied frame fell through to
  // `tap_inputline`, a SECOND and PLAIN capture selected with `grep`'s wide
  // class, not to the escaped frame read with `awk`'s narrow one.
  //
  // Promoting it for codex as well read an idle codex band as absent geometry
  // (`sentinel-submit.test.sh`, every width) and an unstyled codex draft as a
  // known empty band — the type-over direction, found by the partner reviewer
  // reviewing unit 1. One `set --` inside one arm is the whole difference.
  // Cursor and Hermes share the approval check only (tap-3oox6).
  let promptSource = frame;
  if (cmd.startsWith("claude") || cmd.startsWith("codex") || cmd.startsWith("cursor") || cmd.startsWith("hermes")) {
    let overlayFrame = frame;
    if (overlayFrame === undefined) {
      const r = io.capture(target, true, true);
      if (r.code !== 0) return { status: "no-band" };
      // The incumbent read this one through `$(…)`; the generic path's
      // `tap_inputline` did not. Per branch, not per function.
      overlayFrame = commandSubstitution(r.stdout);
    }
    if (approvalPrompt(cmd, overlayFrame)) return { status: "blocked" };
    if (cmd.startsWith("claude")) {
      // The feedback card is not a modal, but a composer it hides is
      // unreadable input, which holds like a modal (tap-89a57).
      const card = claudeFeedbackCard(overlayFrame);
      if (card && card.composer !== "visible") return { status: "blocked" };
      promptSource = overlayFrame;
    }
  }

  let currentInput: string;
  let escapedInput = "";
  if (promptSource !== undefined) {
    escapedInput = commandSubstitution(escapedPromptFromFrame(promptSource, cmd));
    currentInput = stripAnsi(escapedInput);
  } else {
    const line = inputLine(io, target, cmd);
    if (!line.ok) return { status: "no-band" };
    // `current_input="$(tap_inputline …)"`: the caller's command substitution.
    currentInput = commandSubstitution(line.line);
  }
  if (currentInput === "") return { status: "no-band" };

  // `printf '%s\n' "$current_input" | sed -E "s/<prompt>[[:space:] ]*//; s/[[:space:] ]*$//"`:
  // both substitutions run on EVERY row, and the trailing one runs on the row
  // the prompt strip just produced.
  let typed = currentInput.split("\n").map(row => stripRowTail(stripPromptRow(row, cmd))).join("\n");

  if (cmd.startsWith("claude") || cmd.startsWith("codex") || cmd.startsWith("cursor") || cmd.startsWith("hermes")) {
    if (typed !== "") {
      if (promptSource === undefined) escapedInput = commandSubstitution(escapedInputLine(io, target, cmd));
      // Cursor's SGR-2 placeholder and Hermes's calibrated styled hint are
      // chrome. A known paste chip is still human input before injection, so it
      // is exempt from placeholder blanking.
      if (dimPromptInput(typed, escapedInput, promptGlyph(cmd), cmd) && !textHasPasteCollapse(cmd, typed)) typed = "";
    }
  }
  if (cmd.startsWith("claude") && typed !== "") {
    typed = stripClaudeArgHint(typed, currentInput, io.paneWidth(target));
  }
  if (cmd.startsWith("cursor") && typed !== "" && cursorBandChromeNonEmpty(typed)) typed = "";
  return { status: "text", text: typed };
}

/**
 * `tap_pending_input_region_text` (lib.sh:11561) — the composer read from one
 * capture, delegating the whole harness dispatch to `composerInput`.
 *
 * OpenCode and agy keep the REGION reader's return convention: their failure is
 * reported as rc 0 by the incumbent, not as the composer's rc 3/4. That is the
 * incumbent's shape and it is preserved rather than repaired — a caller reading
 * "rc 0, empty" for an unreadable OpenCode box is a real hazard, and it is
 * `tap-bxfd8`, not a fold-in here.
 */
export function pendingInputRegionText(io: PaneIo, target: string, cmd: string, allowCollapsed = false): PendingInput {
  const captured = captureInputFrame(io, target, cmd, true);
  if (!captured.ok) return { status: "no-band" };
  const verdict = composerInput(captured.frame, cmd, allowCollapsed);
  if (cmd === "opencode" || cmd === "agy") {
    return { status: "text", text: verdict.state === "text" ? verdict.text : "" };
  }
  if (verdict.state === "unknown") return { status: "no-band" };
  if (verdict.state === "blocked") return { status: "blocked" };
  return { status: "text", text: verdict.text };
}

/** `tap_input_region_has_continuation` (lib.sh:11759) — any field past row 1. */
export function inputRegionHasContinuation(io: PaneIo, target: string, cmd: string): boolean {
  if (cmd === "opencode") return false;
  const region = inputRegion(io, target, cmd).region;
  // awk's `NF` on the default FS: a row with any non-blank field. Rows after
  // the first only — the prompt row itself is never continuation.
  return region.split("\n").slice(1).some(row => /[^ \t]/.test(row));
}

/** `tap_input_has_id` (lib.sh:11095). */
export function inputHasId(io: PaneIo, target: string, cmd: string, id: string): boolean {
  const needle = normalizeInputMatch(id);
  if (needle === "") return false;
  return normalizeInputMatch(inputRegion(io, target, cmd).region).includes(needle);
}

/**
 * `tap_input_has_match` (lib.sh:11106).
 *
 * Exact mode is for allowlisted harness commands that cannot carry a minted
 * marker (notably `/clear`). It matches only the active input — never
 * transcript history, and never a substring such as "unclear".
 */
export function inputHasMatch(io: PaneIo, target: string, cmd: string, needle: string, mode: "id" | "exact"): boolean {
  if (mode === "id") return inputHasId(io, target, cmd, needle);
  if (mode !== "exact") return false;
  const pending = pendingInputText(io, target, cmd);
  return pending.status === "text" && pending.text === needle;
}

/** `tap_input_has_paste_collapse` (lib.sh:11143). */
export function inputHasPasteCollapse(io: PaneIo, target: string, cmd: string): boolean {
  return textHasPasteCollapse(cmd, stripAnsi(inputRegion(io, target, cmd).region));
}

/** `tap_input_has_injected_content` (lib.sh:11149). */
export function inputHasInjectedContent(
  io: PaneIo, target: string, cmd: string, id: string, allowPasteCollapse: boolean, mode: "id" | "exact",
): boolean {
  if (inputHasMatch(io, target, cmd, id, mode)) return true;
  return mode === "id" && allowPasteCollapse && inputHasPasteCollapse(io, target, cmd);
}

/**
 * `tap_pending_input_probe` (lib.sh:11768) — the recoverability verdict the
 * clobber pipeline reads before it types over a band.
 *
 * `recoverable` is the permission to paste a draft back afterwards, so every
 * arm that clears it is a refusal to promise something the restore cannot do.
 * The band is read TWICE on purpose: a band that changed between two reads is
 * being typed into right now, and a backup of either sample is a backup of
 * neither.
 */
export type PendingProbe = {
  state: "empty" | "pending" | "blocked";
  recoverable: boolean;
  reason: string;
  hash: string;
  text: string;
  bytes: number;
};

export function pendingInputProbe(io: PaneIo, target: string, cmd: string, capBytes: number, io2: PaneIo = io): PendingProbe {
  const empty: PendingProbe = { state: "empty", recoverable: false, reason: "empty", hash: "", text: "", bytes: 0 };
  const first = pendingInputText(io, target, cmd);
  // rc 3 only. The incumbent tested `[ "$rc" = 3 ]`, so rc 4 — a recognized
  // modal — fell through to the empty return and reported `state=empty`. That
  // is the incumbent's shape; a modal-bearing pane reports empty here and the
  // hold lives in the caller that asked `pendingInputText` directly. Preserved,
  // and named in the PR body rather than repaired inside a port.
  if (first.status === "no-band" || first.status === "overprint") {
    return { ...empty, state: "blocked", reason: "no-input-prompt" };
  }
  const text = first.status === "text" ? first.text : "";
  if (text === "") return empty;

  const bytes = Buffer.byteLength(text, "utf8");
  const probe: PendingProbe = {
    state: "pending",
    recoverable: true,
    reason: "single-line",
    hash: createHash("sha256").update(text).digest("hex"),
    text,
    bytes,
  };

  // The SECOND read, from a second observation. `io2` defaults to `io` for a
  // caller holding a live pane; the CLI hands it a separately captured frame,
  // because two reads of one frame can only ever agree and the instability arm
  // would then be decorative.
  const second = pendingInputText(io2, target, cmd);
  const text2 = second.status === "text" ? second.text : "";
  if (text2 !== text) return { ...probe, recoverable: false, reason: "unstable" };
  if (cmd === "opencode") return { ...probe, recoverable: false, reason: "unsupported-harness" };
  if (bytes > capBytes) return { ...probe, recoverable: false, reason: "overlong" };
  if (text.includes("\n")) return { ...probe, recoverable: false, reason: "multiline" };
  if (inputRegionHasContinuation(io2, target, cmd)) return { ...probe, recoverable: false, reason: "wrapped" };
  if (hasControlCharacter(text)) return { ...probe, recoverable: false, reason: "control-character" };
  return probe;
}

/** `tap_text_has_control` (lib.sh:11753) — C0 except LF, plus DEL. */
export function hasControlCharacter(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if ((cp < 32 && ch !== "\n") || cp === 127) return true;
  }
  return false;
}

/**
 * `tap_input_state_from_region` (lib.sh:10410) — the peek/seat-state verdict.
 *
 * Four answers: `empty`, `unsubmitted-sentinel`, `other-text`. (Three; the
 * fourth is the absence of a region, which the caller supplies as an empty
 * string and which lands on `empty`.)
 *
 * `escapedInput` selects the styled path: when present the classification runs
 * on the FIRST ROW ONLY — the incumbent's `sed -E "1{…;q;}"` quits after it —
 * and the dim-placeholder check applies. Without it the whole region is
 * classified and only its first row is stripped.
 */
export function inputStateFromRegion(
  region: string, escapedInput: string, glyph: string, promptRe: string, cmd: string,
): "empty" | "unsubmitted-sentinel" | "other-text" {
  const g = glyph || "[›❯→]";
  const strip = stripFirstRow(promptRe || `^[[:space:] ]*${g}`);
  let cleaned: string;
  if (escapedInput !== "") {
    // `q` after the substitution: row 1 is the whole output.
    cleaned = pyStrip(strip(stripAnsi(escapedInput).split("\n")[0] ?? ""));
    if (cleaned === "") return "empty";
    if (dimPromptInput(cleaned, escapedInput, g, cmd)) return "empty";
  } else {
    const rows = region.split("\n");
    rows[0] = strip(rows[0] ?? "");
    cleaned = pyStrip(rows.join("\n"));
    if (cleaned === "") return "empty";
  }
  if (cursorBandChrome(cleaned)) return "empty";
  return regionIsSentinel(region, promptRe || `^[[:space:] ]*${g}`) ? "unsubmitted-sentinel" : "other-text";
}

/**
 * The incumbent interpolated `tap_prompt_line_re`'s OUTPUT into a `sed`
 * program, so the pattern arrives here as the POSIX text it was, not as a
 * compiled regex. Translating it back is the one place a string is parsed:
 * `[[:space:]<NBSP>]` becomes `sed`'s wide class, and anything else is passed
 * through as-is so a caller that supplies its own pattern still gets it.
 */
function stripFirstRow(promptRe: string): (row: string) => string {
  const source = promptRe
    .replace(/\[\[:space:\] \]/g, `[${PYTHON_SPACE}]`)
    .replace(/\[:space:\]/g, PYTHON_SPACE);
  let head: RegExp;
  try {
    head = new RegExp(`${source}[${PYTHON_SPACE}]*`);
  } catch {
    return row => row;
  }
  return row => row.replace(head, "");
}

/** `tap_stdin_is_sentinel` (lib.sh:10447) applied to a region. */
export function regionIsSentinel(region: string, promptRe: string): boolean {
  const rows = stripAnsi(region).split("\n");
  rows[0] = stripFirstRow(promptRe)(rows[0] ?? "");
  const text = pyStrip(rows.join("\n").normalize("NFC"));
  // PYTHON'S `\s`, NOT JAVASCRIPT'S, and this is the case that separates them:
  // JS `\s` includes U+FEFF and Python's does not. A sentinel followed by a BOM
  // (`…]]\ufeff`) therefore ends with a character Python's `\s*$` cannot match,
  // so the incumbent answered `other-text` — while JS matched it and answered
  // `unsubmitted-sentinel`. `pyStrip` above was already correct; these two
  // patterns were not, and the mismatch survived three rounds because no frame
  // in the captured corpus carries a trailing BOM. `pad/trailing/bom` does.
  const S = `[${PYTHON_SPACE}]`;
  return new RegExp(`^\\[\\[TAP(${S}|$)`).test(text) && new RegExp(`\\]\\]${S}*$`).test(text);
}

/**
 * `tap_peek_transcript` (lib.sh:10464) — the transcript with the ACTIVE input
 * region removed.
 *
 * The LAST prompt row, not the first. Scrollback holds earlier prompt rows — a
 * submitted sentinel, a prior turn — and exiting at the first match drops every
 * recent row between an old prompt and the active one, starving the evaluator
 * of exactly the evidence it was asked for.
 */
export function peekTranscript(full: string, cmd: string, promptRe: RegExp): string {
  const lines = full.split("\n");
  const rows = (kept: string[]): string => kept.length ? kept.join("\n") + "\n" : "";
  if (cmd === "opencode") {
    // Strip the ACTIVE input box and everything below it: border, status row.
    // The per-turn '▣ Build · …' markers STAY — they are transcript, not box
    // chrome, and keying on them truncated the transcript at the first
    // completed turn.
    let border = -1;
    for (let i = 0; i < lines.length; i++) if (/^[ \t\u00a0]*╹▀/.test(lines[i]!)) border = i;
    if (border < 0) return rows(lines);
    let start = border;
    while (start - 1 >= 0 && /^[ \t\u00a0]*┃/.test(lines[start - 1]!)) start--;
    return rows(lines.slice(0, start));
  }
  const box = cmd.startsWith("claude") ? claudeActiveBoxRange(full) : null;
  if (box) return rows(lines.slice(0, box.start));
  let last = -1;
  for (let i = 0; i < lines.length; i++) if (promptRe.test(lines[i]!)) last = i;
  const n = last >= 0 ? last : lines.length;
  return rows(lines.slice(0, n));
}

/**
 * `tap_prompt_line_re`'s OUTPUT — the POSIX text the incumbent interpolated into
 * its `sed` program, not a compiled regex. `inputStateFromRegion` translates it
 * back, so it has to arrive in the same spelling its callers passed.
 */
export function promptLineReText(paneCmd: string): string {
  if (paneCmd.startsWith("hermes")) return `^[[:space:] ]*${HERMES_PREFIX}[›❯]`;
  return `^[[:space:] ]*${promptGlyph(paneCmd)}`;
}

/** `$(…)` strips every trailing newline; the incumbent read each of these
 * through a command substitution, so the module has to do the same or the
 * transcript grows a blank row that the Bash body never produced. */
function commandSubstitution(text: string): string {
  return text.replace(/\n+$/, "");
}

/**
 * `tap_pane_alert_state` (lib.sh:10869) — the bounded alert tail.
 *
 * Physical-row captures keep OpenCode geometry intact, so whitespace is
 * rejoined only inside this eight-row tail: a phrase split by a soft wrap still
 * matches, and nothing outside the tail is reflowed.
 */
export function paneAlertState(stripped: string): "rate-limited-error" | "blocked-on-approval" | "" {
  const lines = stripped.split("\n").map(l => l.trim()).filter(l => l !== "");
  const nearPrompt = lines.slice(-8).join(" ");
  if (/rate limit(ed)? (reached|exceeded)|too many requests|try again later/i.test(nearPrompt)) return "rate-limited-error";
  if (/approve .*(command|request)|approval required|waiting for approval/i.test(nearPrompt)) return "blocked-on-approval";
  return "";
}

/**
 * `json.dumps(obj, separators=(",", ":"))` — including its `ensure_ascii`
 * default, which `JSON.stringify` does not share. Astral characters become the
 * surrogate PAIR Python emits, not one escape.
 */
function ensureAsciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u0080-\uffff]/g, ch =>
    `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Prefer the bounded composer when it can distinguish painted hints from drafts. */
function classifyPeekInput(
  io: PaneIo, target: string, cmd: string, region: Region, escaped: string,
): "empty" | "unsubmitted-sentinel" | "other-text" {
  const promptRe = promptLineReText(cmd);
  // Antigravity's bounded region already includes the paint decision. Its
  // raw prompt line alone contains the same words for the hint and a draft.
  let text: string | undefined;
  if (cmd === "agy" && region.status === "ok") text = region.region;
  if (cmd === "codex" || cmd.startsWith("codex-")) {
    // tap-8nmot: the generic glyph region includes the footer below a staged
    // Codex wire. Its bounded composer also needs paint to recognize hints.
    const captured = captureInputFrame(io, target, cmd, true);
    const composer = composerInput(captured.ok ? captured.frame : "", cmd);
    if (composer.state === "text") text = composer.text;
  }
  if (text !== undefined) {
    if (!text.trim()) return "empty";
    return regionIsSentinel(text, promptRe) ? "unsubmitted-sentinel" : "other-text";
  }
  return inputStateFromRegion(commandSubstitution(region.region), escaped, promptGlyph(cmd), promptRe, cmd);
}

/** The peek primitive's whole output (ported from lib.sh `tap_pane_read`). */
export function paneRead(
  io: PaneIo, target: string, cmd: string, handle: string, json: boolean,
): string {
  const captured = captureInputFrame(io, target, cmd, false);
  const full = commandSubstitution(captured.ok ? captured.frame : "");
  const region = inputRegion(io, target, cmd);
  const escaped = commandSubstitution(escapedInputLine(io, target, cmd));
  const state = classifyPeekInput(io, target, cmd, region, escaped);
  // The transcript split uses awk's prompt expression. Input classification
  // uses the full harness-specific sed expression, including named Hermes rows.
  const transcript = peekTranscript(full, cmd, promptRowReAwk(cmd));
  if (json) {
    // `transcript="$(tap_peek_transcript …)"` — the JSON branch read it through a
    // command substitution and the human branch did not, so the wire value has
    // no trailing newline while the printed one keeps every row terminator.
    // Per branch, like the captures.
    // One object, `print` terminated it with a newline — and Python's
    // `json.dumps` defaults to `ensure_ascii=True`, so every non-ASCII
    // character left that door as `\uXXXX`. A transcript with a glyph in it is
    // a different byte string through `JSON.stringify` alone.
    return ensureAsciiJson({ ok: true, handle, pane: target, harness: cmd, input_state: state,
      transcript: commandSubstitution(transcript) }) + "\n";
  }
  return `input_state: ${state}\n---\n${transcript}`;
}
