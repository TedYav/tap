// The sentinel — the wire poke, and deliberately the weakest thing in TAP.
//
// It carries ZERO authority: it is a one-line pointer that wakes a pane. The
// payload on the bus is the message. A recipient never acts on the sentinel
// alone, and TAP never trusts a value read back out of one.

import { hasPickerTrigger, previewFields } from "./sentinel-preview";

export const SENTINEL_VERSION = "0.23";

export interface SentinelFields {
  from: string;
  to: string;
  id: string;
  kind: string;
  reply: string;
  urgency?: string;
  /** The direct send that may press the interrupt key; spool redelivery never does. */
  interrupt?: boolean;
  path: string;
  /** Cross-team callers must supply affirmative index evidence to omit path=. */
  senderIndex?: "reachable" | "unreachable" | "refuse";
  /** Section 1's inline note body. Rendered only by the v0.23 constructor, and only when eligible. */
  body?: string;
}

/**
 * `urgency` and `path` are both trailing tokens, and `path` stays LAST because it
 * may run to end of line. Field order is fixed: a parser splitting on whitespace
 * must never have to guess where a path ended.
 */
/**
 * The v0.23 wire (tap-7r3fn.8, spec section 13):
 * `[[TAP <version> <ask|note> [<team>/]<id> [tag ...] [path=<abs>][: body]]]` —
 * three fixed positional slots, then order-free bare tags from a closed set.
 *
 * The native constructor owns the wire. Fixed expectations in differential.test.ts
 * retain the retired Bash constructor's grammar cases.
 * Cross-team callers supply affirmative sender-index evidence to omit path=;
 * invalid authority refuses instead of guessing at reachability.
 *
 * `from` and `to` already arrive
 * team-qualified when the caller resolved a team, so the one comparison section 13
 * needs is available from the fields this function already receives.
 */
export function renderSentinel(f: SentinelFields): string {
  // Slot 2. `ask|note` replaces `reply=` — section 13 calls it the one word every
  // reader must see, so it is never omitted. Anything that is not an expectation of
  // a reply is a note; the at-rest envelope keeps the precise `reply:` value.
  const obligation = f.reply === "expected" ? "ask" : "note";

  // Slot 3. The prefix is the SENDER's team and it is a BUS LOCATOR, not a label
  // naming who spoke: the canonical payload lives on the sender's bus, and the only
  // cross-worktree write is the tmux inject. A reader splits on the first `/` to
  // find the bus and reads the remainder as the file id; ids on disk are never
  // qualified.
  //
  // An unqualified recipient is same-team BY CONSTRUCTION — `to` is qualified only
  // when the target's team was actually resolved, and a manual
  // `--cross-worktree --pane <bare-handle>` send never learns it. Comparing the RAW
  // stamps would read cross-team on exactly the case section 13 reserves for
  // `path=`, the unindexed manual relay, and stamp a prefix that resolves through
  // the machine index to one registry location — not necessarily the worktree whose
  // bus holds the payload. So the empty side defaults to the sender's team first.
  const fromTeam = f.from.includes("/") ? f.from.slice(0, f.from.indexOf("/")) : "";
  const rawToTeam = f.to.includes("/") ? f.to.slice(0, f.to.indexOf("/")) : "";
  const toTeam = rawToTeam || fromTeam;
  const unindexedRelay = fromTeam !== "" && rawToTeam === "";
  // Unreachable today (every caller stamps the sender team for any cross-worktree
  // send and the recipient team only inside that same branch); refused rather than
  // assumed, because the silent outcome would be no prefix AND no pointer, and a
  // reader looking on its own bus for bytes that sit on the sender's.
  if (fromTeam === "" && rawToTeam !== "") {
    throw new Error(`sentinel_render: recipient '${f.to}' is team-qualified but sender '${f.from}' is not`);
  }
  const wireId = fromTeam && fromTeam !== toTeam ? `${fromTeam}/${f.id}` : f.id;

  let out = `[[TAP v${SENTINEL_VERSION} ${obligation} ${wireId}`;

  // Escalation describes content; urgent records explicit interrupt permission.
  // They are independent tags. Other kinds stay in the envelope; `critical`
  // remains reserved parse-side with no producer.
  // A digest never carries an urgency (the digest path always passes none), so the
  // digest arm does not append one: a branch with no producer and no arm is a claim
  // nothing checks.
  if (f.kind === "escalate") out += " escalate";
  else if (f.kind === "digest") out += " digest";
  if (f.kind !== "digest" && f.urgency) out += ` ${f.urgency}`;
  // tap-1i81h: Claude renders the cancelled tool call as "interrupted by user",
  // so the line right after it says who pressed the key. The envelope's
  // `urgency` survives into plain spool redelivery; this tag rides only the
  // send that may interrupt.
  if (f.interrupt && f.urgency === "urgent") out += " agent-interrupt";

  // path=, the one surviving key, kept only where the id alone does NOT resolve:
  // the unindexed manual relay (`--cross-worktree --pane <bare-handle>`
  // never learns the recipient's team, so no machine-index lookup finds the bus —
  // which is exactly the qualified-from / bare-to shape). Dropping it elsewhere
  // RETIRES tap-0z9l, adjudicated rather than swept; the full id in slot 3 is what
  // replaces the pointer. See the bash constructor for the whole reasoning.
  const crossTeam = !!fromTeam && fromTeam !== toTeam;
  if (crossTeam && f.senderIndex === "refuse") {
    throw new Error(`sentinel_render: registry marker is invalid or unreadable; refusing to render rather than guess whether team '${fromTeam}' is reachable`);
  }
  const pointer = unindexedRelay || (crossTeam && f.senderIndex !== "reachable");
  const preview = previewFields(f.path, f.kind);
  out += preview;
  if (pointer) out += ` path=${f.path}`;

  // `: ` starts the inline note body, LAST because it may run to end of line.
  // Section 1's rule is narrow on purpose: the body rides the wire only when it is
  // already wire-safe BYTE FOR BYTE, and is never transformed. An ineligible body
  // is not an error and is never truncated — it takes the read path, which every
  // message already has, because the payload file and receipt chain are written
  // either way. There is no escaping: a transformed body would make the wire a
  // second, lossy record, and two readers of one id could disagree about what was
  // said. Notes only — an ask's obligation is acted on by reading the payload.
  // Never alongside `path=`: both can run to end of line and nothing says which
  // wins, so a path holding `": "` would parse as a short pointer and a body made
  // of the rest of the path. Both pointer cases already hand the reader an explicit
  // path, so this costs a convenience and never a record.
  if (!preview && f.body && obligation === "note" && !pointer && sentinelBodyInlineable(f.body)) out += `: ${f.body}`;
  return `${out}]]`;
}

/**
 * Section 1's eligibility test, exported so the rule can be exercised directly.
 *
 * The length is counted in BYTES, on both sides, and that is a deliberate reading
 * of section 1 rather than the obvious one. `.length` counts UTF-16 units; code
 * points would match a bash `${#body}` under a UTF-8 LC_CTYPE — but `tap send`
 * runs in the operator's environment, where `${#body}` counts BYTES under LC_ALL=C
 * and characters otherwise. A character-based rule therefore agrees across the two
 * runtimes only when the locale cooperates, and the suite pins a UTF-8 LC_CTYPE, so
 * the parity arm would have measured a fixture more generous than the world. A
 * limit on a WIRE is a limit on bytes, and bytes are the same everywhere.
 */
export function sentinelBodyInlineable(body: string): boolean {
  if (!body) return false;
  if (new TextEncoder().encode(body).length > 200) return false;
  if (body.includes("]]")) return false;
  // A token-initial `@` or `/` opens the recipient composer's picker, which eats the
  // submit Enter (tap-7r3fn.208). The body is never rewritten, so it takes the read path.
  if (hasPickerTrigger(body)) return false;
  // The newline is the case worth naming: the sentinel is ONE line by
  // construction, and a body carrying one would split it into a header the parser
  // accepts and a tail it never sees. The class covers the rest of [:cntrl:].
  if (/[\x00-\x1f\x7f]/.test(body)) return false;
  return true;
}

const SENTINEL_RE = /\[\[TAP\b.*?\]\]/;

/** Parse a sentinel out of pane text. Used by tests and diagnostics, never as authority. */
export function parseSentinel(text: string): Record<string, string> | null {
  const m = SENTINEL_RE.exec(text);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const tok of m[0].slice(2, -2).split(/\s+/)) {
    const i = tok.indexOf("=");
    if (i > 0) out[tok.slice(0, i)] = tok.slice(i + 1);
  }
  return out;
}
