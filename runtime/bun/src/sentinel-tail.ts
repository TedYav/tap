import { normalizeInputMatch } from "./terminal-text";

/**
 * One recognizer for TAP's own text in a composer (tap-1ncs6). Claude's
 * composer shows the last rows of a long input (pane height minus about
 * fifteen rows), so at a narrow width a wire lands whole and renders as its
 * tail alone: no `[[TAP` opener, and often no id. Every reader that decides
 * draft-versus-sentinel — the landing check, the classification before a
 * clobber, draft protection, `tap nudge` and the recovery Enter guard — reads
 * this module, so they cannot disagree about what a tail is.
 *
 * The rule is evidence, never appearance. Text that is not provably TAP's own
 * is a human draft: never submitted, cleared only through the backup-and-grace
 * path, and its WAIT or STOP still read. A closing `]]` proves nothing — shell
 * tests, JSON and wiki links all end that way. Two things are evidence:
 *
 * - The band OPENS with `[[TAP`. That text is never backed up and cleared as
 *   prose (a broken or truncated marker is the case most worth keeping), and
 *   it is submitted only when the strict parser reads exactly one well-formed
 *   sentinel out of it. This module answers the first half; the parser owns
 *   the second.
 * - The band, joined and whitespace-free, is a suffix of a wire TAP itself
 *   typed: the wire a delivery just typed (`matchSentinelSuffix`), or one the
 *   courier recorded typing into this pane (`typedWireTail`).
 *
 * It does not prove WHICH wire it is beyond that. Pressing Enter on a stale
 * sentinel is harmless — the recipient's `tap read` handles the message or
 * reports it settled — while submitting or clearing a human draft is the only
 * real cost, so everything unproven falls on the draft side. See SECURITY.md,
 * "A sentinel is a doorbell, not proof".
 *
 * Evidence for the tail shape (debug capture of 42 Claude frames at 38
 * columns): every one a strict suffix of its expected wire ending in `]]`
 * across five visible rows; the id fully hidden in 12, the whole preview
 * visible in 41, one tail starting inside the preview.
 */

/**
 * The shortest visible suffix that proves the wire a delivery just typed: the
 * twelve-hex nonce closing a bare wire, with its `]]`. The band read empty
 * before that wire was typed, so a tail this long is the wire.
 */
const OWN_WIRE_FLOOR = 14;

/** The band opens as a TAP marker, whole or broken: never prose to back up and clear. */
export function anchoredSentinelInput(text: string): boolean {
  return normalizeInputMatch(text).startsWith("[[TAP");
}

/**
 * Is this, joined and whitespace-free, TAP wire text: a wire that opens with
 * `[[TAP`, or the opener-less tail of one? A tail's opener scrolled away with
 * its head, so a `[[` still inside opener-less text belongs to something
 * else. That is what tells a typed control apart (`/compact … [[sv:<id>]]`):
 * it closes with `]]` too, but its marker's `[[` is still in view.
 *
 * The distinction is load-bearing. For a wire, whitespace is wrapping and a
 * scrolled-off head costs nothing: Enter on any TAP sentinel is harmless. For
 * a control both are content: a deleted space or an edited head is a
 * different command. So this module never vouches for a control; its own
 * exact readers in `submit-frame.ts` do.
 */
function wireText(normalized: string): boolean {
  if (normalized.startsWith("[[TAP")) return true;
  return normalized.endsWith("]]") && !normalized.includes("[[");
}

export type SentinelMatch = "full" | "tail" | null;

/**
 * Is the visible composer text the whole expected wire (`full`), its scrolled
 * tail (`tail`), or neither? `expected` is a wire the caller typed, or a tail
 * it already proved; text that is not wire text (a typed control, prose)
 * never matches, whole or in part. `tail` means the visible text is a strict suffix of it, at least
 * `OWN_WIRE_FLOOR` characters long. A visible prefix that is not part of the
 * wire fails the suffix test, so a human draft above or around the tail is
 * never staged as it.
 */
export function matchSentinelSuffix(visible: string, expected: string): SentinelMatch {
  const actual = normalizeInputMatch(visible), want = normalizeInputMatch(expected);
  if (!actual || !want || !wireText(want)) return null;
  if (actual === want) return "full";
  // A suffix proves a landing only against the whole wire. An opener-less
  // `expected` is already a tail: the visible text must be that tail exactly.
  return want.startsWith("[[TAP") && actual.length >= OWN_WIRE_FLOOR && want.endsWith(actual) ? "tail" : null;
}

/**
 * Is opener-less composer text the scrolled tail of a wire the courier
 * recorded typing into this pane? The tail must reach back through that wire's
 * id fragment (the last twelve characters of its id, the minted nonce), so a
 * few trailing preview words can never stand in for a wire. A tail cut after
 * the id, text typed by another bus's courier, and a pane with no record are
 * all unproven, and unproven text is a human draft.
 */
export function typedWireTail(visible: string, typed: readonly { id: string; wire: string }[]): boolean {
  const actual = normalizeInputMatch(visible);
  // Opener-less wire text only: a tail that still shows a `[[` is unproven here,
  // as it is at the frame reader, so the two can never disagree about it.
  if (!actual || actual.startsWith("[[TAP") || !wireText(actual)) return false;
  return typed.some(({ id, wire }) => {
    const want = normalizeInputMatch(wire), fragment = normalizeInputMatch(id).slice(-12);
    if (!fragment || !want.endsWith(actual)) return false;
    const at = want.indexOf(fragment);
    return at >= 0 && actual.length >= want.length - at;
  });
}
