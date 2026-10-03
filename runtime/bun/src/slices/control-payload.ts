import { isPasteCollapse } from "../pane-state";

/** Small writes avoid Claude's paste-collapse heuristic; pacing proves nothing. */
export function controlPayloadChunks(payload: string): string[] {
  const chunks: string[] = [];
  let chunk = "", bytes = 0;
  for (const character of payload) {
    const size = Buffer.byteLength(character);
    if (bytes + size > 250) { chunks.push(chunk); chunk = ""; bytes = 0; }
    chunk += character;
    bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

/** Incumbent ordered tail check, not a checksum or an incremental acknowledgement. */
export function controlTailReady(harness: string, rendered: string, expected: string) {
  // Python str.split() whitespace, including its four information separators.
  const compact = (text: string) => text.replace(/[\p{White_Space}\u001c-\u001f]/gu, "");
  const tail = Array.from(compact(expected)).slice(-128).join("");
  return {
    ready: !isPasteCollapse(harness, rendered) && tail.length > 0 && compact(rendered).endsWith(tail),
    renderedBytes: Buffer.byteLength(rendered),
    expectedBytes: Buffer.byteLength(expected),
  };
}

/**
 * Per-chunk contiguity witness for a typed control (tap-vho8h).
 * The composer viewport can scroll the head and middle out of frame,
 * so the tail alone never proves what sits behind it. After each chunk the
 * visible rows must be a suffix of everything typed so far AND end with that
 * chunk's own tail: each window overlaps the previous one at the chunk it
 * just proved, so the windows chain across the whole control. Whitespace is
 * ignored the way the tail check ignores it; a paste chip is a refusal.
 */
export function controlChunkLanded(harness: string, rendered: string, typedSoFar: string, chunk: string) {
  const compact = (text: string) => text.replace(/[\p{White_Space}\u001c-\u001f]/gu, "");
  const shown = compact(rendered), whole = compact(typedSoFar);
  const tail = Array.from(compact(chunk)).slice(-128).join("");
  return {
    ready: !isPasteCollapse(harness, rendered) && shown.length > 0 && tail.length > 0 && whole.endsWith(shown) && shown.endsWith(tail),
    renderedBytes: Buffer.byteLength(rendered),
  };
}
