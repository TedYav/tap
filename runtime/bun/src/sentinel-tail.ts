import { normalizeInputMatch } from "./terminal-text";

/**
 * One recognizer for a TAP wire whose HEAD has scrolled out of a composer
 * viewport (tap-1ncs6). Claude's composer shows the last rows of a long
 * input (pane height minus about fifteen rows), so at a narrow width a wire
 * lands whole and renders as its tail alone: no `[[TAP` opener, and often no
 * id. Every reader that used to key on the opener — the landing check, the
 * draft-versus-sentinel classification before a clobber, `tap nudge` and the
 * recovery Enter guard — reads this module instead, so they cannot disagree
 * about what a tail is.
 *
 * The rule answers one question: does the visible text look safe to submit,
 * that is, is it a TAP sentinel or the tail of one rather than a human draft?
 * It does not prove WHICH wire it is. Pressing Enter on a stale or different
 * sentinel is harmless — the recipient's `tap read` handles the message or
 * reports it settled — while submitting or clearing a human draft is the
 * only real cost. See SECURITY.md, "Failure modes TAP does not defend
 * against" (ruling of 2026-09-28).
 *
 * Evidence (2026-09-27, debug capture 20260925T204842Z-d2994dc8): 42 Claude
 * frames at 38 columns, every one a strict suffix of its expected wire ending
 * in `]]` across five visible rows; the id fully hidden in 12, the whole
 * preview visible in 41, one tail starting inside the preview.
 */

/** The minted stamp inside every v0.23 id (`<date>T<time>Z-<12 hex>`), or its nonce alone closing the wire. */
const ID_FRAGMENT = /[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|[0-9a-f]{12}\]\]$/;

/**
 * Candidate-free shape test: does this composer text look like a TAP wire,
 * anchored or scrolled? Joined and whitespace-free, the way every wrapped-band
 * comparison already is, the text is a sentinel when it opens with `[[TAP`,
 * or when it closes with `]]` and carries a piece of the wire grammar: a
 * quoted `preview="…"` or `path=` field, the closing quote of one (`"]]`), or
 * an id-shaped fragment (the minted stamp, or its twelve-hex nonce closing
 * the wire). Anything else is a human draft. A wiki-style
 * `[[link]]` at the end of prose is prose; a tail cut inside an inline body
 * with none of those marks is also read as prose and parks the delivery
 * behind it, never cleared by this rule and never submitted.
 *
 * This says only "TAP-flavored, not a human draft" — the anchor-gated callers
 * (deliver.ts's clobber refusal, input-protection's draft classification) stop
 * here on purpose: a broken or double marker must never be backed up and
 * cleared as prose. Whether it is safe to press Enter on is the stricter,
 * separate question below.
 */
export function sentinelShapedInput(text: string): boolean {
  const normalized = normalizeInputMatch(text);
  if (normalized.startsWith("[[TAP")) return true;
  if (!normalized.endsWith("]]")) return false;
  return normalized.endsWith('"]]') || normalized.includes('preview="') || normalized.includes("path=") || ID_FRAGMENT.test(normalized);
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0, at = 0;
  for (;;) {
    at = haystack.indexOf(needle, at);
    if (at < 0) return count;
    count++; at += needle.length;
  }
}

/**
 * The stricter question the Enter-on-tail paths ask (courier and `tap nudge`):
 * sentinel-shaped AND closed with `]]`. A wire is recognized by its END; an
 * anchored opener that never closes (a cut paste, `[[TAP v0.23 note truncated`)
 * is shaped but not closed, and stays parked as it always has.
 *
 * Two or more `[[TAP` openers is never closed, however the text ends: pressing
 * Enter on it would submit whichever concatenation the composer happens to
 * hold, not a single recognized wire. `sentinelShapedInput` still reads it as
 * TAP-flavored (so the draft-clear path above still refuses it); this is the
 * narrower refusal that keeps it off the submit path too.
 */
export function closedSentinelInput(text: string): boolean {
  const normalized = normalizeInputMatch(text);
  if (countOccurrences(normalized, "[[TAP") > 1) return false;
  return sentinelShapedInput(text) && normalized.endsWith("]]");
}

export type SentinelMatch = "full" | "tail" | null;

/**
 * Is the visible composer text the whole expected wire (`full`), its scrolled
 * tail (`tail`), or neither? `tail` means the visible text is a strict suffix
 * of the wire and is itself sentinel-shaped. A visible prefix that is not
 * part of the wire fails the suffix test, so a human draft above or around
 * the tail is never staged as it.
 */
export function matchSentinelSuffix(visible: string, expected: string): SentinelMatch {
  const actual = normalizeInputMatch(visible), want = normalizeInputMatch(expected);
  if (!actual || !want) return null;
  if (actual === want) return "full";
  return want.endsWith(actual) && sentinelShapedInput(actual) ? "tail" : null;
}
