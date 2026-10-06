import { sentinelBodyInlineable } from "./sentinel";
import { hasPickerTrigger } from "./sentinel-preview";
import { PYTHON_SPACE } from "./terminal-text";

/**
 * The nudge doorbell (tap-xe42x): `[[TAP v0.23 nudge]]`, or with one line of
 * context, `[[TAP v0.23 nudge message="..."]]`. It names no payload, sender or
 * recipient and carries no task authority or reply obligation; its meaning
 * ("continue what you were working on; check tap poll") is the doorbell copy.
 * `tap nudge` is its only producer and types exactly these bytes.
 *
 * The message value is a JSON string literal, so `"` and `\` round-trip and a
 * trailing backslash cannot escape the closing quote. Refused: newlines and
 * other control characters, sentinel brackets (`[[`, `]]`), a token-initial `@`
 * or `/` (the composer's picker eats the submit Enter, tap-7r3fn.208), and
 * anything over NUDGE_MESSAGE_MAX_BYTES UTF-8 bytes, the inline-body bound
 * sentinel.ts uses: a limit on a wire is a limit on bytes.
 */
export const NUDGE_MESSAGE_MAX_BYTES = 200;

/**
 * Why a `--message` cannot ride the wire, or null when it can. The rule is the
 * inline-body rule every sentinel uses (sentinelBodyInlineable); this only names
 * the clause that failed. `[[` is refused on top of it, like `]]` (decided
 * 2026-10-05): sentinel brackets inside the context would give staged-sentinel
 * readers a second wire to find.
 */
export function nudgeMessageRefusal(message: string): string | null {
  if (message.includes("[[") || message.includes("]]")) return "the context cannot contain sentinel brackets ([[ or ]])";
  if (sentinelBodyInlineable(message)) return null;
  if (message === "") return "the message is empty";
  const bytes = new TextEncoder().encode(message).length;
  if (bytes > NUDGE_MESSAGE_MAX_BYTES) return `the message is ${bytes} bytes; a nudge carries at most ${NUDGE_MESSAGE_MAX_BYTES}`;
  if (hasPickerTrigger(message)) return "a word in the message starts with @ or /, which opens the composer's picker and eats the submit Enter";
  return "the message must be one line without control characters";
}

export function renderNudgeWire(message = ""): string {
  if (message === "") return "[[TAP v0.23 nudge]]";
  const refusal = nudgeMessageRefusal(message);
  if (refusal) throw new Error(refusal);
  return `[[TAP v0.23 nudge message=${JSON.stringify(message)}]]`;
}

// Whitespace between tokens may be any of the grammar's own spaces, so a
// visually wrapped wire still reads.
const S = `[${PYTHON_SPACE}]`;
const NUDGE_RE = new RegExp(`^\\[\\[TAP${S}+v0\\.23${S}+nudge(?:${S}+message=("(?:[^"\\\\]|\\\\.)*"))?${S}*\\]\\]$`, "s");

/** A complete, valid nudge wire and its decoded message ("" for the bare form), or null. */
export function parseNudgeWire(text: string): { message: string } | null {
  const match = NUDGE_RE.exec(text.trim());
  if (!match) return null;
  if (match[1] === undefined) return { message: "" };
  // A wrap inside the quoted value arrives as a line break; it is layout, not content.
  let message: unknown;
  try { message = JSON.parse(match[1].replace(/\n/g, "")); } catch { return null; }
  if (typeof message !== "string" || nudgeMessageRefusal(message) !== null) return null;
  return { message };
}
