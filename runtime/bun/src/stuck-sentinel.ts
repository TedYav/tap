import { isOpenCodeCommand, promptLineRe } from "./tmux";
import { maskPreviewText } from "./sentinel-preview";
import { POSIX_LOCALE_SPACE, PYTHON_SPACE } from "./terminal-text";

/**
 * Read a stuck sentinel from localized composer text or a raw captured region.
 * Native delivery and recovery share this grammar.
 *
 * `wire` is the third field the Bash caller keys on (tap-7r3fn.8): a v0.23
 * region yields an EMPTY recipient by construction (the wire carries no `to=`)
 * and the caller re-keys on the payload the id names; a pre-0.23 region still
 * carries `to=`, which is read directly — the stronger witness, and free. A
 * caller that treated the old shape as unparseable would send the band down the
 * courtesy-backup-then-clobber path, which is the one thing this parser exists
 * to prevent.
 *
 * DE-WRAPPING IS LOAD-BEARING AND IT IS WHY THE SLOTS ARE REJOINED. The region
 * is captured WITHOUT `-J`, so tmux visual wrapping reaches this parser as
 * several lines and a long sentinel routinely arrives with its id split across
 * two of them. The old key=value grammar re-joined itself for free (`id=` on the
 * left, `\s+KEY=` lookahead on the right); v0.23's positional slots have neither
 * anchor, so each slot is rejoined greedily until its own anchored pattern
 * matches. Safe because every slot's target is closed or right-anchored: the
 * version is `v<major>.<minor>`, the obligation is one of two words, and a minted
 * id ends in two fixed-width fields (spec section 13). Found by probe, not by
 * reading (gate review).
 */
export type StuckSentinel = { id: string; to: string; wire: "v023" | "pre023" };
export type StuckSentinelVerdict = { ok: true; fields: StuckSentinel } | { ok: false; reason: string };

const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

// TWO whitespace classes, because the incumbent has two and they are NOT the
// same set. Using JavaScript's own `\s` or `trim()` for either one changes the
// verdict on real input: JS whitespace includes U+FEFF and excludes U+0085 and
// U+001C–U+001F, so `[[TAP v0.23\u0085ask a1]]` parsed in Bash and refused in an
// earlier draft of this module, while `[[TAP \uFEFFv0.23 ask a1]]` did the
// reverse — both found by review (partner review and a second review), both
// outside a 1314-case survey that used ASCII whitespace and NBSP only.
//
// GRAMMAR (`PY`): the parser was Python, so every anchor, separator and token
// split uses Python's whitespace set — `str.isspace()`, `str.strip()` and `re`'s
// `\s` are one set there, enumerated over U+0000–U+10FFF and pinned by the
// controls in `stuck-sentinel.test.ts`.
// `PYTHON_SPACE` lives in terminal-text.ts so the preview mask can share it
// rather than spell its own gaps `\s`: a second whitespace definition inside a
// grammar whose subject IS the difference between the two sets is the drift this
// PR exists to delete.
const PY = PYTHON_SPACE;
// REGION (`SED`): the prompt-row strip was `sed -E`, so that stage sees what
// `[[:space:]]` means in the courier's locale — measured, and NOT the same set
// as the grammar's: no U+0085 and no U+001C-U+001F. See `POSIX_LOCALE_SPACE`
// for the measurement and for the macOS/glibc seam it cannot avoid.
const SED = POSIX_LOCALE_SPACE;
const pyTrimStart = (text: string): string => text.replace(new RegExp(`^[${PY}]+`), "");
const pyTrim = (text: string): string => pyTrimStart(text).replace(new RegExp(`[${PY}]+$`), "");
const ID_CHARSET = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LEGACY_ID_RE = new RegExp(`(?:^|[${PY}])id=([A-Za-z0-9._-](?:[A-Za-z0-9._-]|[${PY}])*?)(?=[${PY}]+[A-Za-z_][A-Za-z0-9_-]*=|[${PY}]*\\]\\])`, "s");
const LEGACY_TO_RE = new RegExp(`(?:^|[${PY}])to=([A-Za-z0-9._/:-](?:[A-Za-z0-9._/:-]|[${PY}])*?)(?=[${PY}]+[A-Za-z_][A-Za-z0-9_-]*=|[${PY}]*\\]\\])`, "s");
const ANCHOR_OPEN_RE = new RegExp(`^\\[\\[TAP(?:[${PY}]|$)`, "s");
const ANCHOR_CLOSE_RE = new RegExp(`\\]\\][${PY}]*$`, "s");
const POSITIONAL_HEADER_RE = new RegExp(`^\\[\\[TAP[${PY}]+v[${PY}]*[0-9]`);
const BODY_MARKER_RE = new RegExp(`:[${PY}]`, "s");
const CLOSE_TRAILING_RE = new RegExp(`\\]\\][${PY}]*$`, "s");

/** Per-harness SAFE QUEUE PREFIX; the Bash twin is `tap_queue_prefix`. */
export function queuePrefix(paneCommand: string): string {
  return /^hermes/.test(paneCommand) ? "/queue " : "";
}

const refuse = (reason = ""): StuckSentinelVerdict => ({ ok: false, reason });
// The reason text is a consumer surface (submit-visible.test.ts pins the
// previous parser's `%r` form), so reproduce `repr()`, not just its quote
// choice: it also escapes backslashes, escapes the quote it chose, and renders
// non-printable bytes as escapes rather than emitting them raw. An earlier draft
// chose the quote and stopped, which put literal ESC bytes from an OSC-8 token
// into a diagnostic that used to be safe to print (review).
const NAMED: Record<string, string> = { "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t" };
function repr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of value) {
    if (NAMED[ch]) { out += NAMED[ch]; continue; }
    if (ch === quote) { out += `\\${ch}`; continue; }
    const code = ch.codePointAt(0)!;
    // Python's repr escapes exactly the code points str.isprintable() rejects:
    // C0/C1 controls, unassigned, separators and other formatting characters.
    // Approximated by category here for the characters a captured band can
    // carry — controls and the space-separator class beyond U+0020.
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
      continue;
    }
    if (/[\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/.test(ch)) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    out += ch;
  }
  return `${quote}${out}${quote}`;
}

/**
 * Parse localized input text (a composer, or a region whose prompt line is
 * already stripped). Escape stripping and NFC are idempotent on text that is
 * already clean, so the native and Bash paths converge here without a second
 * grammar. Refusals that name a slot carry a reason; the anchor and charset
 * refusals are silent, as the previous parser's were.
 */
export function parseStuckSentinel(text: string, paneCommand: string): StuckSentinelVerdict {
  let normalized = pyTrim(text.replace(CSI_RE, "").normalize("NFC"));
  const prefix = queuePrefix(paneCommand);
  if (prefix && normalized.startsWith(prefix)) normalized = pyTrimStart(normalized.slice(prefix.length));
  if (!ANCHOR_OPEN_RE.test(normalized) || !ANCHOR_CLOSE_RE.test(normalized)) return refuse();

  // A positional version header selects its grammar before any legacy-key
  // search: inline prose containing id= or to= must not supply the parsed
  // identity. A 0.22 sentinel still sitting in a band when the new code installs
  // is an ordinary transition state, and the caller treats this verdict as
  // sentinel-first exactly as it treats v023 — never as human text.
  const legacy = POSITIONAL_HEADER_RE.test(normalized) ? null : LEGACY_ID_RE.exec(normalized);
  if (legacy) {
    const id = legacy[1]!.replace(new RegExp(`[${PY}]+`, "g"), "");
    if (!ID_CHARSET.test(id)) return refuse();
    const to = LEGACY_TO_RE.exec(normalized)?.[1]?.replace(new RegExp(`[${PY}]+`, "g"), "") ?? "";
    return { ok: true, fields: { id, to, wire: "pre023" } };
  }
  return parseV023(normalized);
}

/** The v0.23 wire: three positional slots, then order-free tags. */
function parseV023(normalized: string): StuckSentinelVerdict {
  // Mask only complete quoted preview fields before looking for the inline-body
  // colon. The preview has no authority; quoted id=/to= text stays display data.
  const inner = maskPreviewText(normalized.slice("[[TAP".length).replace(CLOSE_TRAILING_RE, ""));
  // The inline body is LAST and may hold anything, so it is separated before the
  // header is tokenised. `: ` is the marker and no header token contains one: the
  // version, the obligation and the tags are closed forms, and an id cannot hold
  // a colon. A path could in principle, and that is the accepted limit.
  const bodyAt = BODY_MARKER_RE.exec(inner);
  const tokens = (bodyAt ? inner.slice(0, bodyAt.index) : inner).split(new RegExp(`[${PY}]+`)).filter(Boolean);

  // Consume tokens from `index`, rejoining across a visual wrap, until the slot
  // pattern matches. Returns [value, next] or [null, index].
  const take = (index: number, re: RegExp, limit = 8): [string | null, number] => {
    let acc = "";
    for (let k = index; k < Math.min(index + limit, tokens.length); k++) {
      acc += tokens[k];
      if (re.test(acc)) return [acc, k + 1];
    }
    return [null, index];
  };

  let i = 0;
  let slot: string | null;
  [slot, i] = take(i, /^v[0-9]+\.[0-9]+$/);
  if (slot === null) return refuse("slot 1 is not a version token");
  // A nudge doorbell (tap-xe42x, nudge-wire.ts) names no payload, so there is
  // no id to re-key on; Enter-on-shape callers recognize it by its own parser.
  if (tokens[i] === "nudge") return refuse("a nudge doorbell names no payload id");
  [slot, i] = take(i, /^(?:ask|note)$/);
  if (slot === null) return refuse("slot 2 is not ask|note");

  // Slot 3 accepts any charset-valid id, and the ORDER is what makes that safe.
  // The minted pattern goes first, and it is the only one allowed to REJOIN
  // across a visual wrap: its two suffix fields are fixed-width and always
  // present, so joining greedily until it matches can only produce the value the
  // sender wrote. The fallback exists because an id is NOT guaranteed
  // minted-shaped (`tap_valid_id` is a charset gate; `--id` and frontmatter `id:`
  // take any token passing it — tap-710pw measured 155 such values across 32
  // suite files). Requiring the minted grammar here meant the renderer emitted
  // sentinels this parser refused, and a refusal reaches the anchor gate, so the
  // recipient pane PARKS.
  //
  // WHAT KEEPS THE FALLBACK FROM TRUNCATING A WRAPPED ID IS THE STRICT TAIL, not
  // the limit=1 on this call: the loose pattern matches a single token
  // immediately, so it can never rejoin at any limit (a mutation relaxing it
  // survives). A wrapped id leaves its second fragment in the token stream, the
  // tail accepts only closed-set tags, `path=`, or the body, and the fragment
  // matches none — so the WHOLE REGION is reported malformed and the band is
  // preserved. Make the tail permissive and a wrapped short id silently parses
  // as the truncated `seat-20260831T0955`; that is the mutation that reds the
  // arms, and it names the real mechanism.
  //
  // The team half uses the ID charset, not a lowercase subset: spec section 13
  // writes the grammar lowercase, but real team names are capitalized (25 of the
  // 33 enrolled on this machine), and a lowercase-only pattern refuses every
  // cross-team sentinel from those teams. Found by relaunch-fence-target-bus.
  let identifier: string | null;
  [identifier, i] = take(i, /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)?.+-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$/);
  if (identifier === null) [identifier, i] = take(i, /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/, 1);
  if (identifier === null) {
    const seen = i < tokens.length ? tokens[i]!.slice(0, 80) : "<missing>";
    return refuse(`slot 3 is not an id (saw ${repr(seen)})`);
  }
  // The id on the wire may carry the SENDER team as a locator prefix. Ids on
  // disk are never qualified, so the bare id is what a caller opens; the prefix
  // is returned through the id itself and split by the caller, not here.
  if (!ID_CHARSET.test(identifier.slice(identifier.lastIndexOf("/") + 1))) return refuse();

  // THE TAIL. Everything left is a closed-set tag or the one surviving key, and
  // ANYTHING ELSE IS MALFORMED AND REPORTED, never skipped — v0.22 tolerated
  // unknown trailing tokens, and that tolerance is what let a wrong-shaped
  // sentinel look well-formed. Rejoined for the same reason the slots are: a
  // wrap lands inside `digest` or `path=` as easily as inside an id.
  const TAG_RE = /^(?:urgent|critical|escalate|digest|agent-interrupt|retry|preview="")$/;
  while (i < tokens.length) {
    const [tag, next] = take(i, TAG_RE);
    if (tag !== null) { i = next; continue; }
    // `path=` runs to the end of the header and may itself be wrapped, so once
    // it starts, the rest of the header belongs to it.
    const [pointer] = take(i, /^path=.+/);
    if (pointer !== null) break;
    return refuse(`malformed token ${repr(tokens[i]!)}`);
  }
  return { ok: true, fields: { id: identifier, to: "", wire: "v023" } };
}

/**
 * The Bash courier's entry: a raw captured region. Every harness but OpenCode
 * anchors the region on its prompt line, so that line's glyph (and any prefix
 * or padding around it) is removed before parsing; an OpenCode region is the
 * composer's own rows and carries no glyph.
 */
export function stuckSentinelFieldsFromRegion(region: string, paneCommand: string): StuckSentinelVerdict {
  let text = region;
  // EXACT `opencode`, not `isOpenCodeCommand`'s basename-and-lowercase test.
  // The incumbent branch was `[ "$cmd" = opencode ]`, so `OpenCode` and
  // `/usr/bin/opencode` took the prompt-stripping path; the broader predicate
  // silently changed status 0 to 1 for those spellings (partner review N4). No
  // production caller uses them today, which is exactly why a widened predicate
  // here would be invisible.
  if (paneCommand !== "opencode") {
    const lines = text.replace(CSI_RE, "").split("\n");
    // `sed -E "1{s/${prompt_re}[[:space:] ]*//;}"`: the prompt row's own leading
    // padding is part of `prompt_re`, and the run after the glyph is the POSIX
    // class plus a literal NBSP. `promptLineRe` anchors on ASCII blanks only,
    // so the padding is trimmed here, in the SED class, before and after it.
    const sedStart = new RegExp(`^[${SED}]+`);
    lines[0] = lines[0]!.replace(sedStart, "").replace(promptLineRe(paneCommand), "").replace(sedStart, "");
    text = lines.join("\n");
  }
  return parseStuckSentinel(text, paneCommand);
}
