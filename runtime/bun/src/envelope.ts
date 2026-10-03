// The payload envelope. CONTRACT.md §Envelope: five routing fields the COURIER
// owns (id/from/to/kind/path), plus optional courier fields and any writer
// extras, which are preserved verbatim.
//
// EVERY RULE HERE MIRRORS THE INCUMBENT'S awk, VERIFIED BY PROBE rather than by
// reading it. The awk is four lines and every clause turned out to matter:
//
//   NR==1 && $0!="---" { exit 1 }                       an opening fence, exactly
//   NR>1 && $0=="---"  { exit 0 }                       the FIRST closing fence ends it
//   NR>1 { if ($0 ~ "^"k":[ \t]") { sub("^"k":[ \t]*",""); sub(/\r$/,""); print; exit } }
//
// Consequences that a "reasonable" parser gets wrong, each checked against the
// installed tap:
//   - the key is anchored at COLUMN ZERO. ` id: x` is not a field (bash: missing).
//   - the separator must be followed by a space or tab. `kind:x` is not a field.
//   - only LEADING separator whitespace is stripped. `kind: discuss ` keeps its
//     trailing space and therefore FAILS the charset (bash rc=1).
//   - the FIRST match wins, not the last. Duplicate `id: good` then `id: bad`
//     yields `good` (bash rc=0).
// A trimming, last-wins parser accepts envelopes the incumbent rejects and
// rejects ones it accepts — in both directions, silently.

import { validId, validPathToken, validToken } from "./ids";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

export interface Envelope {
  fields: Record<string, string>;
  body: string;
}

/** Courier-owned fields, in the exact order the incumbent emits them. */
export interface Routing {
  id: string;
  from: string;
  to: string;
  kind: string;
  path: string;
  cross_worktree?: string;
  reply?: string;
  from_team?: string;
  to_team?: string;
  urgency?: string;
  reply_to?: string;
  in_reply_to?: string;
  recipient_instance?: string;
  sender_instance?: string;
  to_adopted_from?: string;
  original_recipient_instance?: string;
  adopted_from?: string;
  sentinel_preview?: string;
}

/**
 * Every key the courier re-emits from its own arguments. A writer's copy of any
 * of these is DROPPED rather than merged: a surviving spoofed `from_team` or
 * `reply_to` would misroute the next reply.
 */
const COURIER_OWNED = [
  "id", "from", "to", "kind", "path", "cross_worktree", "reply", "from_team",
  "to_team", "urgency", "reply_to", "in_reply_to", "recipient_instance",
  "sender_instance", "to_adopted_from", "original_recipient_instance", "adopted_from", "sentinel_preview",
] as const satisfies readonly string[];

const FENCE = "---";

/** Read through the closing fence without loading the unbounded message body. */
export function readEnvelopeHeader(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`envelope is not a regular file: ${path}`);
    const chunk = Buffer.alloc(4096), decoder = new StringDecoder("utf8");
    let raw = "", lineStart = 0, scan = 0;
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      raw += count ? decoder.write(chunk.subarray(0, count)) : decoder.end();
      if (raw.length >= 4 && !raw.startsWith(`${FENCE}\n`)) return "";
      let end = raw.indexOf("\n", scan);
      while (end !== -1) {
        if (lineStart > 0 && raw.slice(lineStart, end) === FENCE) return raw.slice(0, end + 1);
        lineStart = end + 1;
        end = raw.indexOf("\n", lineStart);
      }
      if (!count) return raw;
      scan = raw.length;
    }
  } finally { closeSync(fd); }
}

/** Split into the frontmatter lines and the body, or null when unfenced. */
function splitFrontmatter(raw: string): { head: string[]; body: string } | null {
  const lines = raw.split("\n");
  if (lines[0] !== FENCE) return null;
  const close = lines.indexOf(FENCE, 1);
  if (close < 0) return null;
  return { head: lines.slice(1, close), body: lines.slice(close + 1).join("\n") };
}

/**
 * Read ONE field, exactly as `tap_envelope_field` does: column-zero key, a space
 * or tab after the colon, leading separator whitespace stripped, a trailing CR
 * removed, first match wins. Undefined when absent.
 */
export function envelopeField(raw: string, key: string): string | undefined {
  const split = splitFrontmatter(raw);
  if (!split) return undefined;
  for (const line of split.head) {
    if (!line.startsWith(`${key}:`)) continue;
    const after = line.slice(key.length + 1);
    if (after === "" || (after[0] !== " " && after[0] !== "\t")) continue;
    return after.replace(/^[ \t]*/, "").replace(/\r$/, "");
  }
  return undefined;
}

export function parseEnvelope(raw: string): Envelope {
  const split = splitFrontmatter(raw);
  if (!split) {
    throw new Error(raw.startsWith(`${FENCE}\n`)
      ? "envelope: no closing frontmatter fence"
      : "envelope: source does not open with a --- fence");
  }
  const fields: Record<string, string> = {};
  for (const line of split.head) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const key = line.slice(0, i);
    const v = envelopeField(raw, key);
    // First-match semantics: never overwrite a key already resolved.
    if (v !== undefined && !(key in fields)) fields[key] = v;
  }
  return { fields, body: split.body };
}

/**
 * Stamp routing into the first frontmatter block, emitting the courier fields
 * once just inside the closing fence. This is what makes "omit --id" real: the
 * writer may leave id/path out and the courier fills them into the CANONICAL
 * payload BEFORE validation, so the on-disk payload can never disagree with the
 * injected sentinel.
 *
 * EVERY UNMATCHED LINE SURVIVES BYTE-FOR-BYTE, blank lines included. The
 * incumbent's drop pattern is `^(id|from|...):[ \t]` — anchored, and requiring
 * the separator space — so `id:forged` (no space) is NOT a recognized field and
 * is preserved as ordinary text. Dropping it would delete a writer's content on
 * a shape the incumbent keeps.
 */
export function stampEnvelope(src: string, routing: Routing): string {
  const split = splitFrontmatter(src);
  if (!split) {
    throw new Error(src.startsWith(`${FENCE}\n`)
      ? "stamp_envelope: no closing frontmatter fence"
      : "stamp_envelope: source does not open with a --- fence");
  }

  const ownedRe = new RegExp(`^(${COURIER_OWNED.join("|")}):[ \\t]`);
  const kept = split.head.filter((line) => !ownedRe.test(line));

  const stamped: string[] = [];
  for (const key of COURIER_OWNED) {
    const v = routing[key];
    if (v !== undefined && v !== "") stamped.push(`${key}: ${v}`);
  }

  // Routing changes only the header. Preserve the exact body bytes, including
  // a missing final newline, so reply hashes and resend agree with Bash.
  return [FENCE, ...kept, ...stamped, FENCE, split.body].join("\n");
}

/**
 * `splitFrontmatter` over BYTES: the head lines are decoded (a frontmatter key
 * is sentinel-safe ASCII and its value is read as text either way), the body is
 * returned as the exact bytes after the closing fence. The incumbent's awk and
 * `cat` never decoded the body, and a `-f` body is bytes, not a string — a
 * byte-invalid or NUL-bearing body must reach the canonical unchanged.
 */
/** Thrown for a frontmatter line that is not valid UTF-8: a header is TEXT
 *  (its fields are routing tokens), and the incumbent's awk refused to stamp
 *  one it could not convert rather than repairing the writer's bytes. */
export class InvalidHeaderEncoding extends Error {
  constructor() { super("stamp_envelope: frontmatter is not valid UTF-8"); this.name = "InvalidHeaderEncoding"; }
}

/**
 * Never throws. `headerValid` is false when a frontmatter line does not
 * round-trip UTF-8; the fences are ASCII, so the body is still located exactly.
 * The STAMP door refuses on it (a writer's header is never repaired); a READ
 * path that only needs the body — a receipt hash — must not refuse a file it
 * can still read (lane B, D1 seam read F1).
 */
function splitFrontmatterBytes(src: Buffer): { head: string[]; body: Buffer; headerValid: boolean } | null {
  const isFence = (b: Buffer) => b.length === 3 && b[0] === 0x2d && b[1] === 0x2d && b[2] === 0x2d;
  const firstNl = src.indexOf(0x0a);
  if (!isFence(firstNl === -1 ? src : src.subarray(0, firstNl))) return null;
  if (firstNl === -1) return null; // `---` alone: one line, no closing fence
  const head: string[] = [];
  let headerValid = true;
  let pos = firstNl + 1;
  for (;;) {
    const nl = src.indexOf(0x0a, pos);
    const line = src.subarray(pos, nl === -1 ? src.length : nl);
    if (isFence(line)) return { head, body: nl === -1 ? Buffer.alloc(0) : src.subarray(nl + 1), headerValid };
    const text = line.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(line)) headerValid = false;
    head.push(text);
    if (nl === -1) return null;
    pos = nl + 1;
  }
}

/** The body BYTES after the closing fence, or null when unfenced — what a
 *  reply receipt hashes (`shasum` over the file body in Bash), never a
 *  decode-and-re-encode of it. Never throws: an undecodable HEADER does not
 *  make the body unreadable (the fences are ASCII). */
export function envelopeBodyBytes(src: Buffer): Buffer | null {
  return splitFrontmatterBytes(src)?.body ?? null;
}

/**
 * `stampEnvelope` for a byte source: the header is rebuilt as text, the body
 * bytes are appended untouched (D1: a staged body is bytes on both doors).
 * Returns the header text beside the bytes so the caller validates exactly the
 * text it built — never a lossy decode of a body that may not be UTF-8
 * (lane B, D1 seam read: a validator that reads U+FFFD where the file holds
 * other bytes has validated something that was never written).
 */
export function stampEnvelopeBytes(src: Buffer, routing: Routing): { bytes: Buffer; header: string } {
  const split = splitFrontmatterBytes(src);
  if (!split) {
    throw new Error(src.subarray(0, 4).equals(Buffer.from(`${FENCE}\n`))
      ? "stamp_envelope: no closing frontmatter fence"
      : "stamp_envelope: source does not open with a --- fence");
  }
  // Never repair: a header byte that does not round-trip is a refusal here,
  // at the writer, not a U+FFFD in the canonical.
  if (!split.headerValid) throw new InvalidHeaderEncoding();
  const ownedRe = new RegExp(`^(${COURIER_OWNED.join("|")}):[ \\t]`);
  const kept = split.head.filter((line) => !ownedRe.test(line));
  const stamped: string[] = [];
  for (const key of COURIER_OWNED) {
    const v = routing[key];
    if (v !== undefined && v !== "") stamped.push(`${key}: ${v}`);
  }
  const header = `${[FENCE, ...kept, ...stamped, FENCE].join("\n")}\n`;
  return { bytes: Buffer.concat([Buffer.from(header, "utf8"), split.body]), header };
}

export type Validation = { ok: true } | { ok: false; reason: string };

/**
 * SHAPE only. TAP validates that the five routing fields are present and cannot
 * break the sentinel grammar; it never inspects meaning or content.
 */
export function validateEnvelope(raw: string): Validation {
  if (!splitFrontmatter(raw)) return { ok: false, reason: "envelope: malformed frontmatter" };
  for (const f of ["id", "from", "to", "kind", "path"] as const) {
    const v = envelopeField(raw, f);
    if (!v) return { ok: false, reason: `envelope: missing/empty field '${f}'` };
    if (f === "id" && !validId(v)) return { ok: false, reason: `envelope: field 'id' value '${v}' fails charset` };
    if ((f === "from" || f === "to" || f === "kind") && !validToken(v)) {
      return { ok: false, reason: `envelope: field '${f}' value '${v}' fails charset` };
    }
    if (f === "path" && !validPathToken(v)) {
      return { ok: false, reason: `envelope: field 'path' value '${v}' is not sentinel-safe (no whitespace or ])` };
    }
  }
  return { ok: true };
}

/** Sanctioned reply-expectation values. Empty is legacy and reads as expected. */
export function replyExpectationOk(v: string | undefined): boolean {
  return v === undefined || v === "" || v === "expected" || v === "settle-only";
}
