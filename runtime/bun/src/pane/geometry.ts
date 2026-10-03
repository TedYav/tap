/**
 * Prompt geometry for the pane reader family — the per-harness tables, and the
 * three character classes the incumbent's three instruments actually used.
 *
 * `tap_prompt_line_re` (lib.sh:9939) printed ONE pattern string,
 * `^[[:space:] ]*GLYPH`, and the shell then fed it to THREE different
 * programs. They are three implementations of `[[:space:]]` and they do not
 * agree, so a port that picks one class for all three changes verdicts:
 *
 *   `grep -E`  `tap_inputline`'s selector          — the generic pending-input path
 *   `awk`      `tap_inputregion`'s selector        — region reads and draft backup
 *   `sed -E`   `tap_pending_input_text`'s strip    — prompt removal on the chosen row
 *
 * Measured on this machine (a selector probe script, macOS
 * `/usr/bin/{grep,awk,sed}` under `LANG=en_US.UTF-8`), with a padded row
 * `<sep>❯ draft`:
 *
 *   separator                              grep  awk  sed
 *   TAB VT FF CR SPACE                      Y     Y    Y
 *   U+00A0 NBSP                             Y     Y    Y      (explicit in the class)
 *   U+1680, U+2000-200A, U+2028/29,         Y     n    Y
 *   U+202F, U+205F, U+3000
 *   U+001C-001F, U+0085, U+FEFF,            n     n    n
 *   U+2060, U+200B
 *
 * So `grep` sides with `sed` and `awk` stands alone. That asymmetry is the
 * incumbent's, and WHICH selector a pane gets is decided PER HARNESS rather
 * than per function — a distinction measured by running the incumbent, after a
 * first version of this comment generalized it from one harness and a unit
 * control caught the generalization:
 *
 *   - Claude's prompt row is read out of the overlay capture its approval check
 *     already took, and the incumbent selected that row with `awk`. NARROW.
 *   - Codex, Cursor, Hermes and the generic path re-read through
 *     `tap_inputline`, whose selector is `grep`. WIDE.
 *   - A caller that supplies its own frame gets the narrow one, whatever the
 *     harness.
 *   - The region reader — draft backup and id matching — is `awk` for every
 *     harness.
 *
 * Two consequences, both load-bearing and both preserved rather than repaired:
 *
 *   - On a U+2000-padded prompt row a CLAUDE pane reports absent geometry —
 *     status 3, the direction `tap_submit_verify`'s draft-clear types over —
 *     while the identical row on Codex reports the draft it is holding.
 *   - The same row can be a draft to the pending-input reader and nothing at
 *     all to the region reader that would back it up.
 *
 * Both are incumbent defects and both are RATIFIED here: narrowing the wide
 * selector would extend the first one to every harness, and widening the narrow
 * one would accept rows the incumbent rejected. The native land/clear region
 * reader in `tmux.ts` (`observeInputRegion`) is the awk twin and takes the
 * narrow class (tap-6zzsk); the frame readers in `submit-frame.ts` keep their
 * ASCII-blank class, whose own oracle is the previously ported module.
 *
 * PLATFORM: glibc's `[[:space:]]` in a UTF-8 locale is ASCII-only, so `grep`
 * and `sed` are NARROWER on Linux than on the operator's macOS for exactly the
 * U+1680/U+2000-200A/U+202F/U+205F/U+3000 rows above. The literal NBSP byte in
 * the pattern is what keeps U+00A0 in every locale. This file picks the
 * platform the courier runs on, which is also the safe direction for the
 * selector — the same choice `terminal-text.ts` documents for the strip.
 */
import { AWK_POSIX_SPACE, HERMES_PREFIX, POSIX_LOCALE_SPACE, PYTHON_SPACE, codexPlaceholder } from "../terminal-text";

/** Per-harness idle prompt glyph, as a regex character class. lib.sh:9923. */
export function promptGlyph(paneCmd: string): string {
  if (paneCmd.startsWith("cursor")) return "[›❯→]";
  if (paneCmd.startsWith("codex")) return "[›❯»]";
  // Antigravity/Gemini paints an ASCII '>' band prompt, bottom-anchored.
  if (paneCmd.startsWith("agy")) return ">";
  return "[›❯]";
}

/**
 * Hermes prefixes its prompt glyph with a token: a named profile's
 * ("ops-hermes ❯") at rest, and the literal "⚕ " while a turn runs (tap-rhajr).
 * The prefix is exactly those two shapes, so the composer stays readable
 * mid-turn — a staged `/queue` wire verifies there instead of reading
 * unobservable. A readable row is not an idle verdict: the ⚕ row is
 * agent-state's working witness (`hermes` rules) and seat-state's busy gate.
 */
function anchored(paneCmd: string, space: string): RegExp {
  if (paneCmd.startsWith("hermes")) return new RegExp(`^[${space}]*${HERMES_PREFIX}[›❯]`);
  return new RegExp(`^[${space}]*${promptGlyph(paneCmd)}`);
}

/** `grep -E` — `tap_inputline`'s selector. Wide class; see the header. */
export function promptRowReGrep(paneCmd: string): RegExp {
  return anchored(paneCmd, POSIX_LOCALE_SPACE);
}

/** `awk` — `tap_inputregion`'s selector. Narrow class; see the header. */
export function promptRowReAwk(paneCmd: string): RegExp {
  return anchored(paneCmd, AWK_POSIX_SPACE);
}

/**
 * The `sed -E` prompt strip applied to one row: the substitution whose
 * left-hand side is the prompt pattern followed by `[[:space:] ]*`, replaced
 * with nothing.
 *
 * Two classes, not one: the pattern's own leading `[[:space:] ]*` and the
 * trailing run after the glyph are both `sed`'s wide class. The glyph itself
 * sits between them. A row that does not start with a prompt comes back
 * unchanged, which is what `s///` does when it does not match.
 */
export function stripPromptRow(row: string, paneCmd: string): string {
  const wide = new RegExp(`^[${POSIX_LOCALE_SPACE}]*${promptGlyph(paneCmd)}[${POSIX_LOCALE_SPACE}]*`);
  if (paneCmd.startsWith("hermes")) {
    const hermes = new RegExp(`^[${POSIX_LOCALE_SPACE}]*${HERMES_PREFIX}[›❯][${POSIX_LOCALE_SPACE}]*`);
    return row.replace(hermes, "");
  }
  return row.replace(wide, "");
}

/** The trailing `s/[[:space:] ]*$` substitution of the same `sed` program. */
export function stripRowTail(row: string): string {
  return row.replace(new RegExp(`[${POSIX_LOCALE_SPACE}]*$`), "");
}

/**
 * Per-harness post-injection renderings for large pasted input. lib.sh:9953.
 *
 * NOT a pending-input classifier: before TAP injects, a visible chip is a pane
 * owner's draft and follows the normal backup/C-u path. Callers must establish
 * the input's provenance first.
 */
export function pasteCollapseRe(paneCmd: string): RegExp | null {
  if (/^(claude|cursor)/.test(paneCmd)) return /\[Pasted text( #[0-9]+)?( \+[0-9]+ lines)?\]/;
  if (/^codex/.test(paneCmd)) return /\[Pasted Content [0-9]+ chars\]/;
  if (/^opencode/.test(paneCmd)) return /\[Pasted ~[0-9]+ lines\]/;
  return null;
}

export function textHasPasteCollapse(paneCmd: string, text: string): boolean {
  const re = pasteCollapseRe(paneCmd);
  return re !== null && re.test(text)
    || /^(claude|codex|cursor)/.test(paneCmd) && /\[Image #[0-9]+\]/.test(text);
}

/**
 * Per-harness SAFE QUEUE PREFIX (delivery-policies plan).
 * lib.sh:9972.
 *
 * Hermes is the only harness whose default mid-turn behavior is INTERRUPT; its
 * `/queue <prompt>` form queues safely even mid-turn (verified against the
 * live harness 2026-07-08). A harness with a non-empty prefix takes queue-prefix delivery:
 * the courier prepends the prefix to the sentinel and skips the no-input-prompt
 * defer, because the harness's own queue is the turn boundary. Every other
 * harness queues typed input natively, so the empty string is the answer and
 * not a missing entry.
 */
export function queuePrefix(paneCmd: string): string {
  return paneCmd.startsWith("hermes") ? "/queue " : "";
}

/** `tap_strip_ansi` (lib.sh:10405) — the CSI-sequence strip, one place. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

/**
 * `tap_dim_prompt_input` (lib.sh:11666) — is the band's visible text HARNESS
 * CHROME rather than a human draft?
 *
 * A faithful port of the incumbent's inline SGR walk, not of
 * `terminal-text.ts`'s `dimPlaceholder`. THOSE TWO ARE NOT THE SAME FUNCTION
 * and routing the Bash callers to the native one changed a verdict: the
 * incumbent recognizes Hermes's idle hint by **italic plus muted 256-colour
 * 136**, which `dimPlaceholder` has no rule for, so a Hermes placeholder read
 * as pending input (`cursor-harness.test.sh`, case 4). They also normalize
 * differently — the incumbent strips a leading glyph/space run and a trailing
 * space run, while `dimPlaceholder` removes every whitespace character and
 * applies NFC.
 *
 * So this is the ONE implementation for every Bash caller of the reader family.
 * `dimPlaceholder` remains the native composer path's reader; unifying the two
 * is a real behavior change for `submit-frame.ts` with its own oracle, and it
 * is named as residue in the PR body rather than folded in here.
 *
 * Two attributes are REQUIRED TOGETHER for Hermes. Two live placeholders had
 * different wording and the same SGR 3 + 38;5;136 pair, while the paired live
 * typed control was plain after SGR 39: italic alone and the muted colour alone
 * are both valid draft paint.
 */
export function dimPromptInput(typed: string, escaped: string, glyph: string, command: string): boolean {
  if (typed === "") return false;
  // The incumbent's own door, not a re-derivation of it. `tap_dim_prompt_input`
  // called `tap_bun_call codex-placeholder … submit-frame.ts codex-placeholder`,
  // which is `codexPlaceholder(input.trimEnd())` — a text pattern AND a paint
  // corroboration (`terminal-text.ts`). A copy here kept the pattern and dropped
  // the paint, so a human who typed that exact sentence unstyled had their draft
  // blanked (partner review, unit 1 C1). Importing it is the fix; copying it was
  // the defect.
  if (command.startsWith("codex") && codexPlaceholder(escaped.trimEnd())) return true;

  let dim = false, italic = false, reverse = false;
  let fg256: string | null = null;
  const dimChunks: string[] = [];
  const placeholderChunks: string[] = [];

  for (const part of escaped.split(/(\x1b\[[0-9;]*m)/)) {
    if (!part) continue;
    if (part.startsWith("\x1b[")) {
      const body = part.slice(2, -1);
      const params = body ? body.split(";") : ["0"];
      let i = 0;
      while (i < params.length) {
        const param = params[i] || "0";
        if ((param === "38" || param === "48") && i + 1 < params.length) {
          const mode = params[i + 1];
          if (mode === "2") {
            if (param === "38") fg256 = null;
            i += 5;
            continue;
          }
          if (mode === "5") {
            if (param === "38" && i + 2 < params.length) fg256 = params[i + 2] ?? null;
            i += 3;
            continue;
          }
        }
        if (param === "0") { dim = false; italic = false; fg256 = null; reverse = false; }
        else if (param === "22") dim = false;
        else if (param === "2") dim = true;
        else if (param === "3") italic = true;
        else if (param === "23") italic = false;
        else if (param === "39" || (/^[0-9]+$/.test(param)
          && ((Number(param) >= 30 && Number(param) <= 37) || (Number(param) >= 90 && Number(param) <= 97)))) fg256 = null;
        else if (param === "7") reverse = true;
        else if (param === "27") reverse = false;
        i += 1;
      }
      continue;
    }
    if (dim || (command.startsWith("hermes") && italic && fg256 === "136")) {
      dimChunks.push(part);
      placeholderChunks.push(part);
    } else if (reverse && [...part].length === 1) {
      // The terminal cursor block overlays the first placeholder character in
      // reverse video (SGR 7), which resets dim on that one character and
      // splits the dim run. Keeping it is what lets the reconstructed
      // placeholder still match, for every harness.
      dimChunks.push(part);
    }
  }

  // Python's `\s`, not JavaScript's, and the caller's glyph class rather than a
  // hardcoded one: the incumbent interpolated `tap_prompt_glyph_re`'s output
  // straight into this pattern.
  // Hermes paints its working "⚕ ❯" prompt in the placeholder's own italic 136
  // (tap-rhajr), so the ⚕ is prompt, not placeholder text.
  const prompt = command.startsWith("hermes") ? `${glyph}|⚕` : glyph;
  let head: RegExp;
  try {
    head = new RegExp(`^(?:[${PYTHON_SPACE}]|${prompt})+|[${PYTHON_SPACE}]+$`, "g");
  } catch {
    return false;
  }
  const normalize = (text: string): string => text.replace(head, "");
  // A reverse-video cursor can cover the whole of a one-character human draft,
  // so actual placeholder paint is required on text beyond the prompt glyph and
  // whitespace: the cursor overlay alone cannot establish that a band is chrome.
  if (normalize(placeholderChunks.join("")) === "") return false;
  return normalize(dimChunks.join("")) === pyStrip(typed);
}

const PY_TRIM_G = new RegExp(`^[${PYTHON_SPACE}]+|[${PYTHON_SPACE}]+$`, "g");
const pyStrip = (text: string): string => text.replace(PY_TRIM_G, "");
