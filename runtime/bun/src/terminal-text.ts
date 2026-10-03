/**
 * Python's whitespace set, as a regex character-class BODY.
 *
 * `str.isspace()`, `str.strip()` and `re`'s `\s` are one set in Python 3, and it
 * is NOT JavaScript's: Python has U+001C–U+001F and U+0085 and lacks U+FEFF,
 * while JS `\s`/`trim()` has U+FEFF and lacks the other two. Any grammar ported
 * out of an inline Python program has to keep Python's set or it changes
 * verdicts on real captures — `[[TAP v0.23\u0085ask a1]]` and
 * `[[TAP \uFEFFv0.23 ask a1]]` flip in opposite directions. Enumerated over
 * U+0000–U+10FFF against CPython and pinned by a control in
 * `stuck-sentinel.test.ts`.
 */
export const PYTHON_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

/**
 * The class a `sed -E`/`awk` `[[:space:]]` matched in the courier's own locale,
 * as a regex character-class BODY. Measured on this machine rather than assumed:
 * `LC_CTYPE=en_US.UTF-8` BSD sed calls U+00A0, U+1680, U+2000–U+200A, U+2028,
 * U+2029, U+202F, U+205F and U+3000 space, and does NOT include U+0085,
 * U+001C–U+001F, U+200B or U+FEFF. So it is PYTHON_SPACE minus U+0085 and
 * U+001C–U+001F — which is why a region strip and the grammar it feeds could
 * never share one class in the incumbent.
 *
 * PLATFORM SEAM, stated because it cannot be removed: glibc's `[[:space:]]` in
 * a UTF-8 locale is ASCII-only, so the incumbent's own region strip answered
 * differently on Linux than on the operator's macOS for exactly these
 * separators. A port has to choose, and this picks the platform the courier
 * runs on — which is also the safe direction rather than merely the local one:
 * `tap_inputregion` SELECTS the prompt row with the macOS class, so an
 * ASCII-only strip would leave a separator the selector had already accepted,
 * and the anchor would then silently refuse a band that was fine.
 *
 * WHAT IS NOT KNOWN, because an earlier version of this comment claimed it:
 * nobody has shown a captured band that carries a disputed separator BEFORE a
 * prompt glyph. The fixtures do not contain one, the documented live idle shape
 * is the opposite order (U+276F then U+00A0), and the unit control that covers
 * this SYNTHESIZES the prefix — it pins the strip's class, not tmux's output.
 * The claim that mattered was always the one above (strip follows selector);
 * this sentence used to assert the unmeasured one instead. Found in review.
 *
 * The selector asymmetry this comment used to defer (tap-6zzsk) is CLOSED, and
 * closing it required measuring the two instruments separately rather than
 * assuming one class. The incumbent spelled ONE pattern, `^[[:space:] ]*GLYPH`,
 * and then fed it to TWO programs — awk selected the region row, `sed -E`
 * stripped the first row's prompt — and on macOS under en_US.UTF-8 those two
 * implementations of `[[:space:]]` DISAGREE:
 *
 *   char                      awk   sed -E   JS `[ \t]`
 *   \t \v \f \r SPACE          Y     Y        only \t and SPACE
 *   U+00A0 NBSP               Y     Y        n
 *   U+1680, U+2000-200A,      n     Y        n
 *   U+2028/29, U+202F,
 *   U+205F, U+3000
 *   U+001C-001F, U+0085,      n     n        n
 *   U+FEFF, U+2060
 *
 * So the strip's class is this constant and the SELECTOR's class is
 * `AWK_POSIX_SPACE` below — narrower, and not a matter of taste: widening the
 * selector to this constant would accept a U+2000-padded row that the
 * incumbent's awk REJECTED, which is a parity break in the other direction.
 * `tmp/opus-xhigh-2/probe-space-class.sh` is the measurement.
 *
 * Found live rather than by reading: the codex review bot flagged that
 * `\u00a0❯ draft` read as `draft` status 0 under the incumbent and status 3
 * under the port, which is the type-over direction for
 * `tap_submit_verify`'s draft-clear. The comment above had PREDICTED the
 * asymmetry and deferred it; shipping a reader that depends on the selector is
 * what turned a tracked latency into a live divergence.
 */
export const POSIX_LOCALE_SPACE = "\\t\\n\\v\\f\\r \\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

/**
 * `[[:space:] ]` as **awk** implements it — the class the incumbent's REGION
 * SELECTOR actually used. Measured, not inherited from the sed class: awk
 * accepts the ASCII blanks plus NBSP and stops there. `\n` is absent on purpose
 * — awk splits records on it, so a newline never appears inside a candidate row.
 */
export const AWK_POSIX_SPACE = "\\t\\v\\f\\r \\xa0";

/**
 * The token Hermes paints before its prompt glyph, as a regex group: a named
 * profile's at rest ("ops-hermes ❯"), or the literal "⚕ " while a turn runs
 * (tap-rhajr). One spelling for every prompt-row twin — the `grep`/`awk`/`sed`
 * selectors in `pane/geometry.ts`, `promptLineReText`, and `tmux.ts`'s
 * `promptLineRe` and `promptRowReAwk` — so a twin that disagrees cannot strip one shape and keep
 * the other. Each twin keeps its own leading space class.
 */
export const HERMES_PREFIX = "([A-Za-z0-9._-]+ |⚕ )?";

/**
 * The one blanking rule for typed input: text that is only whitespace (JavaScript's
 * trim set, which includes U+FEFF and NBSP) is content-free. The read side classifies
 * such a band ready, readiness admits it, and the draft path neither backs it up nor
 * types it back, because restoring it re-dirties a band the courier just cleared.
 * A test only: real drafts keep every byte, surrounding blanks included.
 */
export function hasInputText(text: string): boolean { return text.trim().length > 0; }

export function normalizeInputMatch(s: string): string {
  // Match the reader's whitespace contract; a BOM inside an ID is content,
  // not wrapping, and must never make a corrupted wire match the expected ID.
  return s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").normalize("NFC").replace(new RegExp(`[${PYTHON_SPACE}]+`, "g"), "");
}

/** Whimsy paints Braille around the dim idle hint, including beside the chevron.
 * Only recognize the placeholder; never strip characters from preserved input.
 */
// Lives here, not in tmux.ts, because tmux.ts imports this module; tmux.ts re-exports it.
export function isOpenCodeCommand(command: string): boolean {
  return (command.split("/").pop() ?? command).toLowerCase() === "opencode";
}

export function codexPlaceholder(row: string): boolean {
  const plain = row.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  return /^[ \t]*[›❯»][\s\u2800-\u28ff]*Ask Codex to do anything[\s\u2800-\u28ff]*$/.test(plain)
    && dimPlaceholder(row, "Ask Codex to do anything", "codex");
}

/** Codex paints Braille-block characters (U+2800-28FF) as composer chrome —
 * the starfield and dim padding are UI, never input (tap-8nmot). One
 * definition here: submit-frame's readers, the courier's state reads and the
 * agent-state region readers all need the same strip, and a second copy is
 * the parallel engine the migration epic forbids. */
export const withoutCodexPaint = (text: string): string => text.replace(/[\u2800-\u28ff]/g, " ");

// Same SGR-2/cursor corroboration as Bash tap_dim_prompt_input. A reverse
// cursor alone cannot erase a one-character draft; actual dim text is required.
export function dimPlaceholder(escaped: string, actual: string, command = ""): boolean {
  let dim = false, reverse = false, opencodeGray = false;
  const opencode = isOpenCodeCommand(command);
  const painted: string[] = [], visible: string[] = [];
  for (const part of escaped.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith("\x1b[")) {
      const params = part.slice(2, -1).split(";").map(value => Number(value || 0));
      for (let i = 0; i < params.length; i++) {
        const value = params[i]!;
        if ((value === 38 || value === 48) && (params[i + 1] === 2 || params[i + 1] === 5)) {
          if (value === 38) {
            opencodeGray = params[i + 1] === 2
              && params[i + 2] === 128 && params[i + 3] === 128 && params[i + 4] === 128;
          }
          i += params[i + 1] === 2 ? 4 : 2;
        } else if (value === 0) { dim = false; reverse = false; opencodeGray = false; }
        else if (value === 39 || (value >= 30 && value <= 37) || (value >= 90 && value <= 97)) opencodeGray = false;
        else if (value === 2) dim = true;
        else if (value === 22) dim = false;
        else if (value === 7) reverse = true;
        else if (value === 27) reverse = false;
      }
    } else if (dim || (opencode && opencodeGray)) { painted.push(part); visible.push(part); }
    else if (reverse && part.length === 1) visible.push(part);
  }
  const trim = (text: string) => text.replace(command.startsWith("codex") ? /^[\s›❯»]+|\s+$/g : /^[\s›❯→]+|\s+$/g, "");
  return !!trim(painted.join("")) && normalizeInputMatch(trim(visible.join(""))) === normalizeInputMatch(actual);
}

/**
 * One pane frame from stdin, BYTE-TRANSPARENT.
 *
 * `Bun.stdin.text()` strips a leading U+FEFF as a byte-order mark, and a pane
 * frame is not a document: the Bash pipe these CLI doors replace passed every
 * byte through, so a frame whose first row begins with U+FEFF had a BOM-bearing
 * row, and U+FEFF is NOT in the prompt-row selector's class — the incumbent
 * therefore read that pane as absent geometry. Decoding with the BOM stripped
 * turns the same frame into a readable band: a divergence with no fixture,
 * found by probing the class rather than by reading.
 *
 * Having fixed one door and left the rest is the whole reason this is a
 * function: `pane/cli.ts` and the `submit-frame.ts` and `agent-state.ts` doors
 * share it, and the doors that had no caller were retired (tap-amfle).
 */
export async function readStdinFrame(): Promise<string> {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(await Bun.stdin.bytes());
}
