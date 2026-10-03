import type { PaneEffects } from "./courier";
import { alignClearFrame, claudeDraftTailMatches, claudeWrappedLineMatches } from "./submit-frame";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { hasInputText } from "./terminal-text";

/** What a restore decision tells the sender when the backup held only blanks. */
export const BLANK_DRAFT_NOTICE = "tap: input backup holds only whitespace; nothing to restore";

/** The backup writer adds exactly one newline after the original draft. */
export function inputBackupBody(raw: string): string {
  const fence = raw.indexOf("\n---\n", 4);
  const marker = "\n## Backed-up input\n\n";
  const bodyAt = fence + "\n---\n".length;
  if (!raw.startsWith("---\n") || fence < 0
      || !raw.slice(4, fence).split("\n").includes("schema_version: 1")
      || !raw.startsWith(marker, bodyAt) || raw.length <= bodyAt + marker.length || !raw.endsWith("\n")) {
    throw new Error("invalid input backup body");
  }
  return raw.slice(bodyAt + marker.length, -1);
}


/** Metadata is outside the verbatim draft body, including its paste labels. */
export function inputBackupIncomplete(raw: string): boolean {
  const fence = raw.indexOf("\n---\n", 4);
  return raw.startsWith("---\n") && fence >= 0
    && raw.slice(4, fence).split("\n").includes("capture_status: incomplete");
}

export const INCOMPLETE_DRAFT_NOTICE = "tap: draft backup incomplete: pasted contents or images were not captured -- view retained text with: tap draft";

type DraftEntry = { created: Buffer; payload: Buffer; handle: Buffer; path: Buffer; key: Buffer };

/** Match the old field reader: first value before the second exact fence. */
function draftFields(raw: Buffer): Map<string, Buffer> {
  const fields = new Map<string, Buffer>();
  let fences = 0;
  // latin1 is a lossless byte view; malformed UTF-8 must not alter C-sort order.
  for (const line of raw.toString("latin1").split("\n")) {
    if (line === "---" && ++fences === 2) break;
    for (const field of ["handle", "created_at", "payload_id"]) {
      if (!fields.has(field) && line.startsWith(`${field}: `)) {
        fields.set(field, Buffer.from(line.slice(field.length + 2).replace(/\0/g, ""), "latin1"));
      }
    }
  }
  return fields;
}

export function draftEntries(directory: string, handle?: string): DraftEntry[] {
  try { if (!statSync(directory).isDirectory()) return []; } catch { return []; }
  const entries: DraftEntry[] = [];
  const owner = handle === undefined ? undefined : Buffer.from(handle);
  for (const name of readdirSync(directory, { encoding: "buffer" })) {
    if (name[0] === 46 || !name.subarray(-3).equals(Buffer.from(".md"))) continue;
    const path = Buffer.concat([Buffer.from(directory.endsWith("/") ? directory : `${directory}/`), name]);
    try { if (!statSync(path).isFile()) continue; } catch { continue; }
    const fields = draftFields(readFileSync(path));
    const seat = fields.get("handle");
    if (!seat?.length || owner && !seat.equals(owner)) continue;
    const created = fields.get("created_at");
    const payload = fields.get("payload_id");
    if (!created?.length || !payload?.length) continue;
    // sort -r compares the complete record: timestamp, payload id, then path.
    const key = Buffer.concat([created, Buffer.from("\t"), payload, Buffer.from("\t"), path]);
    entries.push({ created, payload, handle: seat, path, key });
  }
  return entries.sort((a, b) => Buffer.compare(b.key, a.key));
}

export function draftView(directory: string, handle: string, list: boolean, requested = ""): Buffer {
  const entries = draftEntries(directory, handle);
  if (list) {
    if (!entries.length) return Buffer.from(`tap draft: no drafts backed up for ${handle}\n`);
    return Buffer.concat([Buffer.from("CREATED\tPAYLOAD_ID\n"), ...entries.slice(0, 10).map(entry =>
      Buffer.concat([entry.created, Buffer.from("\t"), entry.payload, Buffer.from("\n")]))]);
  }
  return (requested ? entries.find(entry => entry.payload.equals(Buffer.from(requested))) : entries[0])?.path ?? Buffer.alloc(0);
}


/**
 * Whole-draft capture through the clear loop (tap-ipex2). Claude's composer is a
 * viewport of its last rows; each C-u / BSpace changes only the bottom, and the
 * viewport follows the cursor, so the row above the old top comes into view.
 * `alignClearFrame` (submit-frame.ts) proves each step. The key that removed a
 * row says what the boundary above it was:
 * - C-u on a typed line leaves an empty cursor row, and the BSpace that then
 *   removes that row crossed a typed newline;
 * - C-u that removes a row outright removed a soft-wrap continuation, and the
 *   next BSpace names the join: the row unchanged means it took the wrap space,
 *   one character shorter means the wrap split a token.
 * A soft-joined line must also pass the soft-wrap layout walker. Rows keep their first-seen
 * text. Complete only if every step and boundary was proven and the last busy frame
 * was one row: the viewport shows all the rows it has, so none remained above it.
 */
export class DraftChain {
  private readonly rows: string[];
  /** joins[i] joins rows[i] and rows[i + 1]; null until the clear crosses it. */
  private readonly joins: (string | null)[];
  private last: string[];
  private pendingSoft: { at: number; row: string } | null = null;
  private broken = false;
  /** The viewport's height, once a frame came in below it nothing remains hidden. */
  private readonly viewport: number;
  private shrunk = false;
  reveals = 0;
  constructor(rows: string[], private readonly columns: number) {
    this.rows = [...rows];
    this.joins = rows.slice(1).map(() => null);
    this.last = rows;
    this.viewport = rows.length;
  }
  observe(key: "C-u" | "BSpace", next: string[] | undefined): void {
    if (this.broken) return;
    const step = next?.length ? alignClearFrame(this.last, next, !this.shrunk) : null;
    if (!step || step.removed > 1 || this.pendingSoft && key !== "BSpace") { this.broken = true; return; }
    if (next!.length < this.viewport) this.shrunk = true;
    if (step.revealed) { this.rows.unshift(next![0]!); this.joins.unshift(null); this.reveals++; }
    const bottom = next!.length - 1;
    if (this.pendingSoft) {
      const { at, row } = this.pendingSoft, now = next![bottom]!;
      this.pendingSoft = null;
      // The same row, shifted by any reveal, one BSpace later.
      if (step.removed || bottom !== at + step.revealed) { this.broken = true; return; }
      if (now === row) this.joins[at + step.revealed] = " ";
      else if (now.length === row.length - 1) this.joins[at + step.revealed] = "";
      else { this.broken = true; return; }
    } else if (step.removed) {
      // The frame always starts at rows[0], so the boundary sits under the new bottom row.
      const at = bottom;
      if (key === "BSpace") {
        if (this.last.at(-1) !== "") { this.broken = true; return; }
        this.joins[at] = "\n";
      } else this.pendingSoft = { at, row: next![bottom]! };
    }
    this.last = next!;
  }
  capture(cleared: boolean): { text: string; complete: boolean } {
    let text = this.rows[0] ?? "";
    let line = [this.rows[0] ?? ""], soft = false, proven = true;
    const closeLine = () => {
      if (soft && !claudeWrappedLineMatches(line, text.slice(text.lastIndexOf("\n") + 1), this.columns)) proven = false;
      line = []; soft = false;
    };
    this.joins.forEach((join, i) => {
      const row = this.rows[i + 1]!;
      if (join === "\n" || join === null) { closeLine(); text += "\n" + row; line.push(row); return; }
      text += join + row; line.push(row); soft = true;
    });
    closeLine();
    const complete = cleared && proven && !this.broken && !this.pendingSoft
      && this.last.length === 1 && this.joins.every(join => join !== null);
    return { text, complete };
  }
}

/** Restore only while the composer remains ours; never submit a newline as a key. */
export function restorePlainDraft(target: string, text: string, harness: string, command: string,
  fx: Pick<PaneEffects, "restoreInput" | "paneState" | "settle">, permitted: () => boolean): boolean {
  if (!fx.restoreInput || !hasInputText(text)) return false;
  let expected = "";
  // Claude's viewport is proven full, and so scrolling, once a pasted newline
  // leaves its row count unchanged. Until then the rows must be the whole draft.
  let scrolled = false, shown = 0;
  const matches = (exact = false, grewFrom?: number) => {
    const band = fx.paneState(target, harness, command);
    if (!(exact ? expected : expected.trim())) return band.state === "ready";
    if (band.state !== "busy") return false;
    // Claude reports its rows: prove the end, since a tall draft scrolls its head out of frame.
    if (band.rows && band.columns) {
      if (grewFrom !== undefined && band.rows.length <= grewFrom) scrolled = true;
      shown = band.rows.length;
      return claudeDraftTailMatches(band.rows, expected, band.columns, scrolled);
    }
    return exact ? band.text === expected : band.text.trimEnd() === expected.trimEnd();
  };
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const part = lines[i]! + (i < lines.length - 1 ? "\n" : "");
    if (!part) continue;
    if (!permitted() || !matches()) return false;
    const before = shown;
    if (fx.restoreInput(target, part) !== true) return false;
    expected += part;
    fx.settle(0.03);
    if (!matches(false, part.endsWith("\n") ? before : undefined)) return false;
  }
  return permitted() && matches(true);
}
