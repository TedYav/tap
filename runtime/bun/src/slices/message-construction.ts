/**
 * Message construction for `tap send` — the ONE implementation both doors call
 * (lane D, batch 2, unit D1).
 *
 * Construction is what happens between "here is an argv" and "here is a staged
 * payload with its routing fields resolved": the option parse and its usage
 * refusals, the body source (`-m` / `-f <path>` / `-f -` / positional file)
 * staged as BYTES behind a synthetic empty fence, the inline byte cap, the
 * effective kind, the fenceless wrap, the reply obligation (with the unattended
 * downgrade and the assign refusal), and the id. Addressing, sender facts,
 * delivery and effects are NOT here: the native door computes them in
 * `verbs/send.ts` and the Bash door computes them in `tap-send.sh`, and both
 * hand the answers IN. The module never reads a registry.
 *
 * The operations are separate on purpose — parse, stage, obligation — and the
 * caller invokes them at the incumbent's sites, in the incumbent's order, so a
 * combined failure refuses with the same class it always did (partner review,
 * D1 boundary read, correction 1): Bash checks the reset fences between parse
 * and staging, resolves the sender and the reply_to between staging and the
 * obligation, and judges the order-shape guard on the explicit `--ask` bit, not
 * on the downgraded obligation. Refusals the incumbent raised at a LATER site
 * than the operation that can compute them (the body-source count at :340, the
 * token charset at :779) are returned as deferred refusals, and the caller
 * raises them where the incumbent did.
 *
 * `tap-send.sh` reaches these through the `construct` CLI at the bottom, which
 * writes NUL-delimited key/value pairs to a result file. That carrier is
 * lossless for every argv-derived string (an argv value cannot contain NUL, a
 * multi-line `-m` or a `\x1f` in a path travel intact) and needs no parser on
 * the Bash side: `while IFS= read -r -d '' key && IFS= read -r -d '' value`.
 */

import { accessSync, closeSync, constants as fsConstants, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { TapError } from "../context";
import { envelopeField } from "../envelope";
import { mintId, validId, validToken } from "../ids";
import { writeResult } from "./result-pairs";

const FENCE = Buffer.from("---\n---\n", "utf8");
const INLINE_MAX_BYTES_DEFAULT = 102400;

// --- parse ------------------------------------------------------------------

export interface SendArgs {
  to: string;
  payloadFile: string;
  message: string | null;
  bodyFile: string;
  preview: string;
  /** `--preview` was given, even blank: a rejected hint must not fall back to derivation. */
  previewSet: boolean;
  from: string;
  fromSet: boolean;
  kind: string;
  kindSet: boolean;
  id: string;
  pane: string;
  crossWorktree: boolean;
  fyi: boolean;
  note: boolean;
  /** `--ask` / `--reply` / `--expect-reply`: the explicit request for a reply,
   *  BEFORE the unattended downgrade. The order-shape guard keys on this. */
  expectReply: boolean;
  team: string;
  json: boolean;
  polite: boolean;
  politeTimeout: string;
  politeTimeoutSet: boolean;
  urgent: boolean;
  urgentSet: boolean;
  wake: boolean;
  delivery: string;
  deliverySet: boolean;
  noSpool: boolean;
  replyTo: string;
  replyToSet: boolean;
  noAutoReplyTo: boolean;
  inReplyTo: string;
  recipientInstance: string;
  expectedSenderInstance: string;
  historicalRecipient: boolean;
  adoptedFrom: string;
  remoteRegistry: string;
  /** Bash's `_body_source_count`: how many of -m / -f / positional were given. */
  bodySources: number;
}

/** A refusal the incumbent raises at a later site than the operation that
 *  computes it. The caller raises it where the incumbent did. */
export interface Refusal { code: number; errorClass: string; action: string; detail: string }

export function refusalError(r: Refusal): TapError {
  return new TapError(r.code, r.errorClass, r.action, r.detail);
}

const HELP = "tap help send";
const MISSING_PAYLOAD_ACTION = "check the payload path, then retry";
/** Options whose operand must be present AND non-empty (`${2:?…}` in Bash). */
const VALUE_NONEMPTY: Record<string, string> = {
  "-f": "--body-file needs a value", "--body-file": "--body-file needs a value",
  "--from": "--from needs a value", "--kind": "--kind needs a value", "--id": "--id needs a value",
  "--pane": "--pane needs a value", "--team": "--team needs a value",
  "--polite-timeout": "--polite-timeout needs a value", "--delivery": "--delivery needs a value",
  "--reply-to": "--reply-to needs a value", "--in-reply-to": "--in-reply-to needs a value",
  "--recipient-instance": "--recipient-instance needs a value", "--sender-instance": "--sender-instance needs a value",
  "--adopted-from": "--adopted-from needs a value", "--remote-registry": "--remote-registry needs a value",
};
/** Options whose operand must be present but may be empty (`${2?…}` in Bash). */
const VALUE_MAYBE_EMPTY: Record<string, string> = {
  "--preview": "--preview needs a value", "-m": "-m needs a value", "--message": "-m needs a value",
};

/**
 * Bash's parse loop (`tap-send.sh` :159-:218) and its post-parse usage checks
 * (:219-:245), in that order. `assignVerb` is `TAP_ASSIGN_VERB=1`: the caller
 * came through `tap assign`, which supplies `--expect-reply --kind order` itself.
 *
 * MEASURED DEVIATION, ratified in the PR body: a missing or empty operand was a
 * shell `${2:?…}` diagnostic (`tap-send.sh: line N: 2: --kind needs a value`),
 * whose line number moved with every edit. It is a `usage_error` refusal here.
 */
export function parseSendArgs(argv: readonly string[], assignVerb: boolean, hooks?: { onJson?: () => void }): SendArgs {
  const a: SendArgs = {
    to: "", payloadFile: "", message: null, bodyFile: "", preview: "", previewSet: false, from: "", fromSet: false,
    kind: "", kindSet: false, id: "", pane: "", crossWorktree: false, fyi: false, note: false,
    expectReply: false, team: "", json: false, polite: false, politeTimeout: "", politeTimeoutSet: false,
    urgent: false, urgentSet: false, wake: false, delivery: "", deliverySet: false, noSpool: false,
    replyTo: "", replyToSet: false, noAutoReplyTo: false, inReplyTo: "", recipientInstance: "",
    expectedSenderInstance: "", historicalRecipient: false, adoptedFrom: "", remoteRegistry: "",
    bodySources: 0,
  };
  let messageSet = false;
  let bodyFileSet = false;
  const usage = (detail: string, action = HELP): never => { throw new TapError(1, "usage_error", action, detail); };
  const operand = (i: number, opt: string): string => {
    const nonempty = VALUE_NONEMPTY[opt];
    const maybeEmpty = VALUE_MAYBE_EMPTY[opt];
    const v = argv[i + 1];
    if (v === undefined) return usage(nonempty ?? maybeEmpty!);
    if (nonempty !== undefined && v === "") return usage(nonempty);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const opt = argv[i]!;
    switch (opt) {
      case "--preview": a.preview = operand(i, opt); a.previewSet = true; i++; break;
      case "-m": case "--message": a.message = operand(i, opt); messageSet = true; i++; break;
      case "-f": case "--body-file": a.bodyFile = operand(i, opt); bodyFileSet = true; i++; break;
      case "--from": a.from = operand(i, opt); a.fromSet = true; i++; break;
      case "--kind": a.kind = operand(i, opt); a.kindSet = true; i++; break;
      case "--id": a.id = operand(i, opt); i++; break;
      case "--pane": a.pane = operand(i, opt); i++; break;
      case "--cross-worktree": a.crossWorktree = true; break;
      case "--fyi": a.fyi = true; break;
      case "--note": a.note = true; break;
      case "--ask": case "--reply": case "--expect-reply": a.expectReply = true; break;
      case "--team": a.team = operand(i, opt); i++; break;
      // Bash sets TAP_JSON=1 the moment `--json` is parsed, so a refusal
      // LATER in the same argv is a JSON error object and one EARLIER is not.
      case "--json": a.json = true; hooks?.onJson?.(); break;
      case "--polite": a.polite = true; break;
      case "--polite-timeout": a.politeTimeout = operand(i, opt); a.politeTimeoutSet = true; i++; break;
      case "--urgent": a.urgent = true; a.urgentSet = true; break;
      case "--wake": a.wake = true; break;
      case "--delivery": a.delivery = operand(i, opt); a.deliverySet = true; i++; break;
      case "--no-spool": a.noSpool = true; break;
      case "--reply-to": a.replyTo = operand(i, opt); a.replyToSet = true; i++; break;
      case "--no-auto-reply-to": a.noAutoReplyTo = true; break;
      case "--in-reply-to": a.inReplyTo = operand(i, opt); i++; break;
      case "--recipient-instance": a.recipientInstance = operand(i, opt); i++; break;
      case "--sender-instance": a.expectedSenderInstance = operand(i, opt); i++; break;
      case "--historical-recipient": a.historicalRecipient = true; break;
      case "--adopted-from": a.adoptedFrom = operand(i, opt); i++; break;
      case "--remote-registry": a.remoteRegistry = operand(i, opt); i++; break;
      default:
        if (opt.startsWith("--")) throw new TapError(1, "unknown_option", HELP, `unknown option '${opt}'`);
        if (!a.to) a.to = opt;
        else if (!a.payloadFile) a.payloadFile = opt;
        else usage(`unexpected arg '${opt}'`);
    }
  }
  a.bodySources = (messageSet ? 1 : 0) + (bodyFileSet ? 1 : 0) + (a.payloadFile ? 1 : 0);

  if (a.adoptedFrom && !(a.inReplyTo && validToken(a.adoptedFrom))) {
    usage("--adopted-from requires a reply and a valid predecessor handle", "tap reply <id> -f <file>");
  }
  // THE ASSIGN REFUSAL COMES FIRST (tap-oglkh): assign supplies --expect-reply
  // itself, so the generic checks below would blame the caller for a flag they
  // never wrote.
  if (assignVerb && (a.fyi || a.note)) {
    usage(`tap assign is a work order and always expects a reply; ${a.note ? "--note" : "--fyi"} names a note — use tap send`, "tap help assign");
  }
  if (a.note && a.expectReply) usage("pass either --note or --ask, not both");
  if (a.note && a.fyi) usage("--fyi and --note are the same claim; pass one");
  if (a.fyi && a.expectReply) usage("pass either --fyi or --ask, not both");

  // --- delivery class (tap-7r3fn.20) ---------------------------------------
  if (a.deliverySet) {
    if (!["interrupt", "now", "polite"].includes(a.delivery)) {
      usage(`--delivery takes interrupt, now, or polite (got '${a.delivery}')`);
    }
    const aliases: string[] = [];
    if (a.urgent) aliases.push("--urgent");
    if (a.polite) aliases.push("--polite");
    if (a.wake) aliases.push("--wake");
    const alias = aliases.join(" and ");
    if (a.delivery === "interrupt" && (a.polite || a.wake)) usage(`--delivery interrupt contradicts ${alias}; pass one delivery class`);
    if (a.delivery === "polite" && (a.urgent || a.wake)) usage(`--delivery polite contradicts ${alias}; pass one delivery class`);
    if (a.delivery === "now" && (a.urgent || a.polite)) usage(`--delivery now contradicts ${alias}; pass one delivery class`);
    if (a.delivery === "interrupt") { a.urgent = true; a.urgentSet = true; }
    if (a.delivery === "polite") a.polite = true;
  }
  if (a.noSpool && (a.urgent || a.polite)) {
    usage("--no-spool contradicts interrupt/--urgent and polite/--polite; use the now class");
  }
  if (a.polite && a.urgent) usage("pass either --polite or --urgent, not both");
  if (a.inReplyTo && !validId(a.inReplyTo)) usage(`invalid in-reply-to id '${a.inReplyTo}'`, "tap help reply");
  if (a.politeTimeout !== "") {
    if (!/^[0-9]+$/.test(a.politeTimeout)) usage("--polite-timeout must be a positive integer (seconds)");
    // Bash's `[ "$n" -gt 0 ]` converts with strtoimax: past 2^63-1 the operand
    // is "integer expression expected" (status 2) and the `||` refuses it as
    // not > 0 (9223372036854775808 sent).
    const n = BigInt(a.politeTimeout);
    if (!(n > 0n && n <= 9223372036854775807n)) usage("--polite-timeout must be > 0");
  }
  if (a.politeTimeout === "") a.politeTimeout = "600"; // delivery-policies plan: ~10m default
  return a;
}

/** Bash :340-:345, raised by the caller at that site (after the reply-to alias block). */
export function bodySourceRefusal(a: Pick<SendArgs, "bodySources">): Refusal | null {
  if (a.bodySources <= 1) return null;
  return { code: 1, errorClass: "usage_error", action: HELP,
    detail: 'pass exactly one message source: -m "text", -f <body-file>, or a positional <payload-file>' };
}

/**
 * Bash's usage line at :463, raised when no destination or no source survived —
 * AFTER staging: with a source but no destination the incumbent staged first,
 * so a missing `-f` or an over-cap `-m` refuses with its own class before the
 * usage line does. `stageSource` keeps that
 * order on both doors; with no source at all there is nothing to stage and the
 * usage line comes first.
 */
export function usageRefusal(a: Pick<SendArgs, "to" | "bodySources">): Refusal | null {
  if (a.to && a.bodySources === 1) return null;
  return { code: 1, errorClass: "usage_error", action: HELP,
    detail: 'usage: tap send <to> (-m "inline text" | -f <body-file> | <payload-file>) [--from me] [--kind k] [--id id] [--pane tmux-target] [--cross-worktree]' };
}

// --- stage --------------------------------------------------------------------

/**
 * Bash's `${TAP_INLINE_MAX_BYTES:-102400}` with `[ -gt ]`'s integer grammar
 * (an optional sign then digits; `+5`, `-1`, `0005` are caps) and the operator's
 * spelling kept for the refusal. Outside the grammar is the default cap.
 * Native trims surrounding whitespace before matching, so `5<LF>` is a cap on
 * every build; Bash's acceptance of that operand varied by interpreter build
 * (CONTRACT § Envelope). On the Bash door this policy is a MEASURED DEVIATION
 * from the incumbent's errored-and-skipped check, ratified in the D1 PR body.
 */
export function inlineMaxBytes(raw: string | undefined): { spelled: string; value: number } {
  const v = raw || String(INLINE_MAX_BYTES_DEFAULT);
  if (/^[+-]?\d+$/.test(v.trim())) return { spelled: v, value: Number(v.trim()) };
  return { spelled: String(INLINE_MAX_BYTES_DEFAULT), value: INLINE_MAX_BYTES_DEFAULT };
}

/**
 * Bash :421-:437 BEFORE its ensure_dirs: a named `-f` must exist, be regular
 * and readable, and an inline `-m` must fit the cap, before the bus is
 * bootstrapped for the staging write — a refused send never creates the bus
 * authority marker (partner review, D1 U2-A). `-f -` has nothing to check
 * before reading it; a positional file's checks come after staging in the
 * incumbent (:466-:469) and are re-run by `stageBody` in that order.
 * `ensureDirs` reports whether the incumbent bootstrapped the bus at this site
 * (it did for -m/-f, not for a positional, whose bootstrap follows the guard).
 */
export function checkSource(a: Pick<SendArgs, "to" | "message" | "bodyFile" | "payloadFile">, env: { inlineMaxBytes?: string }): { ensureDirs: boolean } {
  if (a.bodyFile) {
    if (a.bodyFile !== "-") assertReadableBody(a.to, a.bodyFile);
    return { ensureDirs: true };
  }
  if (a.message !== null) {
    assertInlineCap(a.to, a.message, env);
    return { ensureDirs: true };
  }
  return { ensureDirs: false };
}

function assertReadableBody(to: string, bodyFile: string): void {
  if (!existsSync(bodyFile)) throw new TapError(1, "not_found", `tap send ${to} --body-file <path>`, `body file not found: ${bodyFile}`);
  let st;
  try { st = statSync(bodyFile); } catch { throw new TapError(1, "usage_error", HELP, `body file is not a regular file: ${bodyFile}`); }
  if (!st.isFile()) throw new TapError(1, "usage_error", HELP, `body file is not a regular file: ${bodyFile}`);
  try { accessSync(bodyFile, fsConstants.R_OK); }
  catch { throw new TapError(1, "usage_error", HELP, `body file is not readable: ${bodyFile}`); }
}

function assertInlineCap(to: string, message: string, env: { inlineMaxBytes?: string }): number {
  const bytes = Buffer.byteLength(message, "utf8");
  const cap = inlineMaxBytes(env.inlineMaxBytes);
  if (bytes > cap.value) {
    throw new TapError(1, "payload_too_large", `tap send ${to} <payload-file>`,
      `-m body is ${bytes} bytes (limit ${cap.spelled}). Too big for inline — write it to a file and use: tap send ${to} <payload-file> (the file form has no size limit).`);
  }
  return bytes;
}

/** Stage with the incumbent's refusal order: no source → the usage line; a
 *  source → its own refusals first, then the usage line if `to` is missing. */
export function stageSource(a: Pick<SendArgs, "to" | "message" | "bodyFile" | "payloadFile" | "bodySources">, env: { inlineMaxBytes?: string }): StagedBody {
  if (a.bodySources === 0) throw refusalError(usageRefusal(a)!);
  const staged = stageBody(a, env);
  const usage = usageRefusal(a);
  if (usage) throw refusalError(usage);
  return staged;
}

export interface StagedBody {
  /** The staged bytes: `---\n---\n` + body for -m/-f, the file itself for a positional. */
  bytes: Buffer;
  /** What the order-shape guard judges: Bash's staged `$PAYLOAD` — `bytes` for
   *  -m/-f, the positional file BEFORE any fenceless wrap. */
  judged: Buffer;
  /** The bytes after the fenceless wrap: identical to `bytes` unless the
   *  positional file's first line is not `---`. Canonicalization stamps THIS. */
  wrapped: Buffer;
  /** `true` when `wrapped !== bytes` (a positional file without a fence). */
  needsWrap: boolean;
  /** Frontmatter `kind:` / `id:` of the staged source, when it carries one. */
  envelopeKind: string;
  envelopeId: string;
  /** The bytes read from stdin for `-f -`, so a caller that later delegates
   *  can hand them to the other door — stdin cannot be read twice. */
  stdinConsumed?: Buffer;
}

function ioCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
}

/** Read all of stdin as bytes (`-f -`), as `cat -- -` did. */
function readStdin(): Buffer {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(65536);
  for (;;) {
    let n: number;
    try { n = readSync(0, buf, 0, buf.length, null); }
    catch (error) {
      if (ioCode(error) === "EAGAIN") { Bun.sleepSync(2); continue; }
      if (ioCode(error) === "EOF") break;
      throw error;
    }
    if (n <= 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks);
}

/**
 * Bash :421-:461 (body staging + inline cap) and :546-:560 (fenceless wrap),
 * as bytes. `-f` and `-m` are always a BODY behind a synthetic empty fence; a
 * positional file may carry its own frontmatter and is wrapped only when its
 * first line is not exactly `---` — Bash reads that line with `read -r`, so a
 * file whose only content is `---` with no newline counts as fenced, and
 * `---\r\n` does not.
 */
export function stageBody(a: Pick<SendArgs, "to" | "message" | "bodyFile" | "payloadFile">, env: { inlineMaxBytes?: string }): StagedBody {
  let bytes: Buffer;
  let judged: Buffer;
  let stdinConsumed: Buffer | undefined;
  if (a.bodyFile) {
    let body: Buffer;
    if (a.bodyFile === "-") {
      try { body = readStdin(); }
      catch { throw new TapError(1, "usage_error", HELP, `could not read body source: ${a.bodyFile}`); }
      stdinConsumed = body;
    } else {
      assertReadableBody(a.to, a.bodyFile);
      try { body = readFileSync(a.bodyFile); }
      catch (error) {
        if (ioCode(error) === "EACCES") throw new TapError(1, "usage_error", HELP, `body file is not readable: ${a.bodyFile}`);
        throw new TapError(1, "usage_error", HELP, `could not read body source: ${a.bodyFile}`);
      }
    }
    bytes = Buffer.concat([FENCE, body]);
    judged = bytes;
  } else if (a.message !== null) {
    assertInlineCap(a.to, a.message, env);
    const msg = Buffer.from(a.message, "utf8");
    bytes = Buffer.concat([FENCE, msg, Buffer.from("\n")]);
    judged = bytes;
  } else {
    const path = a.payloadFile;
    if (!existsSync(path)) {
      // The `-m` correction (Bash :458) rides the DETAIL, shell-quoted. The
      // copyable `next:` never carries caller-controlled text: the incumbent
      // native door's rule (native-router.test.ts "a command-shaped missing
      // path stays out of the copyable action"), now both doors' — a measured
      // deviation from the base program's action, ratified in CONTRACT.
      const q = (s: string) => shellQuote(s);
      throw new TapError(1, "not_found", MISSING_PAYLOAD_ACTION,
        `payload not found: ${path}. Did you mean: tap send ${q(a.to)} -m ${q(path)}`);
    }
    let st;
    try { st = statSync(path); } catch { throw new TapError(1, "usage_error", HELP, `payload is not a regular file: ${path}`); }
    if (!st.isFile()) throw new TapError(1, "usage_error", HELP, `payload is not a regular file: ${path}`);
    try { bytes = readFileSync(path); }
    catch { throw new TapError(1, "usage_error", HELP, `payload is not readable: ${path}`); }
    judged = bytes;
  }
  const needsWrap = firstLine(bytes) !== "---";
  // A positional file's OWN frontmatter is text: a header line that does not
  // round-trip UTF-8 is refused here, on both doors, never repaired. The
  // incumbent's refusal lived in awk at placement and depended on the awk
  // build (BSD awk refused, mawk published the raw byte — partner review, D1
  // U2-C), so the policy is the module's now, at staging, with one sentence.
  if (!needsWrap && !frontmatterDecodes(bytes)) {
    throw new TapError(1, "usage_error", HELP, `payload frontmatter is not valid UTF-8: ${a.payloadFile}`);
  }
  const wrapped = needsWrap ? Buffer.concat([FENCE, bytes]) : bytes;
  const text = wrapped.toString("utf8");
  return {
    bytes, judged, wrapped, needsWrap,
    envelopeKind: needsWrap ? "" : (envelopeField(text, "kind") || ""),
    envelopeId: needsWrap ? "" : (envelopeField(text, "id") || ""),
    stdinConsumed,
  };
}

/** Every frontmatter line (between the opening fence and the first closing
 *  fence, or to EOF when none) round-trips UTF-8. */
function frontmatterDecodes(src: Buffer): boolean {
  let pos = src.indexOf(0x0a) + 1; // past the opening `---`
  while (pos < src.length) {
    const nl = src.indexOf(0x0a, pos);
    const line = src.subarray(pos, nl === -1 ? src.length : nl);
    if (line.length === 3 && line[0] === 0x2d && line[1] === 0x2d && line[2] === 0x2d) return true;
    if (!Buffer.from(line.toString("utf8"), "utf8").equals(line)) return false;
    if (nl === -1) break;
    pos = nl + 1;
  }
  return true;
}

/** Bash's `IFS= read -r first < file`: up to the first LF, LF excluded, CR kept. */
function firstLine(bytes: Buffer): string {
  const nl = bytes.indexOf(0x0a);
  return (nl === -1 ? bytes : bytes.subarray(0, nl)).toString("utf8");
}

/** Bash's `printf '%q'` for the not-found remedy: the incumbent's exact quoting
 *  for the characters a path or handle can carry. */
export function shellQuote(s: string): string {
  if (s === "") return "''";
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(s)) return s;
  // printf %q escapes each shell-special byte; non-printables become $'…'.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(s)) {
    let out = "$'";
    for (const ch of s) {
      const c = ch.codePointAt(0)!;
      if (ch === "\n") out += "\\n";
      else if (ch === "\t") out += "\\t";
      else if (ch === "\r") out += "\\r";
      else if (ch === "'") out += "\\'";
      else if (ch === "\\") out += "\\\\";
      else if (c < 0x20 || c === 0x7f) out += `\\${c.toString(8).padStart(3, "0")}`;
      else out += ch;
    }
    return `${out}'`;
  }
  // ASCII shell specials get a backslash; printable non-ASCII stays raw, as
  // bash 5's %q prints it (bash 3.2 octal-escapes it — an interpreter-build
  // difference in a "did you mean" hint, not a contract).
  return s.replace(/([\x20-\x7e])/g, (ch) => /[A-Za-z0-9_./:@%+=,-]/.test(ch) ? ch : `\\${ch}`);
}

/** Bash :521-:523: `--kind` > the staged source's `kind:` > `discuss`. */
export function effectiveKind(a: Pick<SendArgs, "kind" | "kindSet">, staged: Pick<StagedBody, "envelopeKind">): string {
  if (a.kindSet) return a.kind;
  return staged.envelopeKind || "discuss";
}

/** Bash :525: the guard applies to a plain note — keyed on the EXPLICIT ask bit.
 * The three supervision kinds (probe, notice, progress) are settle-only directives,
 * never order-shaped notes. */
export function guardApplies(a: Pick<SendArgs, "expectReply" | "note" | "inReplyTo">, kind: string): boolean {
  return !a.expectReply && !a.note && kind !== "lane-request" && kind !== "probe" && kind !== "notice" && kind !== "progress" && !a.inReplyTo;
}

// --- obligation ---------------------------------------------------------------

export interface SenderFacts {
  /** `FROM_UNATTENDED`: the registry says this sender cannot receive a reply itself. */
  unattended: boolean;
  /** `REPLY_TO_STAMP` non-empty: a deliverable reply_to was resolved for this send. */
  replyToStamped: boolean;
}

export interface Obligation {
  replyExpect: "expected" | "settle-only";
  /** Bash `tap_warning send …` lines, in order, without the prefix. */
  warnings: string[];
  /** `TAP_ASSIGN_VERB=1` and the obligation could not be `expected`. */
  refusal: Refusal | null;
}

/**
 * Bash :700-:768: the reply expectation from the explicit ask bit and the
 * sender facts, the unattended downgrade warning, the assign refusal, and the
 * lane-request lint.
 */
export function resolveObligation(a: Pick<SendArgs, "expectReply" | "from">, kind: string, facts: SenderFacts, assignVerb: boolean): Obligation {
  const warnings: string[] = [];
  const granted = facts.unattended && facts.replyToStamped && a.expectReply;
  if (facts.unattended && a.expectReply && !granted && !assignVerb) {
    warnings.push(`--ask downgraded to reply=settle-only because --from '${a.from}' is unattended and has no deliverable reply_to`);
  }
  const replyExpect: Obligation["replyExpect"] = a.expectReply && (!facts.unattended || granted) ? "expected" : "settle-only";
  let refusal: Refusal | null = null;
  if (assignVerb && replyExpect !== "expected") {
    refusal = { code: 1, errorClass: "usage_error", action: "tap help assign",
      detail: `tap assign needs a sender that can receive the reply, and --from '${a.from}' is unattended with no deliverable reply_to — register the seat with --reply-to <handle>, send from a reply-capable seat, or say it is a note with tap send` };
  }
  if (kind === "lane-request" && replyExpect === "settle-only") {
    warnings.push(`kind=${kind} sent reply=settle-only — a work-order-shaped kind needs a tracked reply obligation (CONTRACT §using-tap); did you mean --ask?`);
  }
  return { replyExpect, warnings, refusal };
}

/** Bash :777-:779: `--id` > the staged source's `id:` > minted from the sender. */
export function resolveId(a: Pick<SendArgs, "id">, staged: Pick<StagedBody, "envelopeId">, from: string): string {
  return a.id || staged.envelopeId || mintId(from);
}

/** Bash :779-:782: the charset refusals, in the incumbent's order. */
export function tokenRefusal(id: string, from: string, to: string, kind: string): Refusal | null {
  const re = "^[A-Za-z0-9][A-Za-z0-9._-]*$";
  if (!validId(id)) return { code: 1, errorClass: "usage_error", action: HELP, detail: `id '${id}' fails charset ${re}` };
  if (!validToken(from)) return { code: 1, errorClass: "usage_error", action: HELP, detail: `from '${from}' is not a sentinel-safe token (${re})` };
  if (!validToken(to)) return { code: 1, errorClass: "usage_error", action: HELP, detail: `to '${to}' is not a sentinel-safe token (${re})` };
  if (!validToken(kind)) return { code: 1, errorClass: "usage_error", action: HELP, detail: `kind '${kind}' is not a sentinel-safe token (${re})` };
  return null;
}

// --- staging -----------------------------------------------------------------

/** Stage `bytes` under `<home>/tmp/<name>` with mode 0600, as Bash did. A
 *  write that fails part-way removes its own partial file before rethrowing:
 *  a body must never outlive a failed staging (partner review, D1 F6). */
/** mktemp's alphabet and width: `body-file.XXXXXX` is the shape the incumbent minted. */
const TEMP_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function tempSuffix(): string {
  const raw = randomBytes(6);
  let out = "";
  for (const b of raw) out += TEMP_ALPHABET[b % TEMP_ALPHABET.length];
  return out;
}

/**
 * A staged temp is created the way `mktemp` created the incumbent's
 * (Bash :423): an unpredictable name under `$TAP_HOME/tmp`, opened
 * O_CREAT|O_EXCL at mode 0600 so a pre-planted path is refused rather than
 * followed (CONTRACT §Body-file send: "an unpredictable mode-600 temporary
 * payload"). The incumbent minted only `-f`'s temp that way and named the
 * inline and wrap temps by pid; here all three staged names share the one
 * writer.
 */
export function writeStaged(home: string, prefix: string, suffix: string, bytes: Buffer, mint: () => string = tempSuffix): string {
  const dir = join(home, "tmp");
  mkdirSync(dir, { recursive: true });
  let path = "", fd = -1;
  for (let attempt = 0; ; attempt++) {
    path = join(dir, `${prefix}${mint()}${suffix}`);
    try { fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600); break; }
    catch (error) {
      if (ioCode(error) === "EEXIST" && attempt < 100) continue;
      throw error;
    }
  }
  let closed = false;
  try { writeFileSync(fd, bytes); closed = true; closeSync(fd); }
  catch (error) {
    // A failed write OR a failed close: the bytes on disk are not a staged
    // body anyone will publish, so they do not survive the helper.
    if (!closed) { try { closeSync(fd); } catch { /* closed */ } }
    try { unlinkSync(path); } catch { /* gone */ }
    throw error;
  }
  return path;
}
