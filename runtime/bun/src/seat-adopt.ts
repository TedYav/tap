// tap-p6el — reclaim adoption, bus-rewrite core (native port of
// skills/tap/scripts/session/seat_adopt.py).
//
// When register releases a stale fork handle `H_fork` into the successor
// `H_succ` (under the registry flock), the courier adopts unsettled team-local
// payloads addressed to `H_fork` on the LOCAL bus: `to` becomes `H_succ` and
// forensic `to_adopted_from` / `adopted_at` are stamped, while `id` / `from` /
// body / `reply` are untouched. This module owns ONLY that local rewrite; the
// registry grant (`adopted_handles`) and the N>=1 epoch bump live in
// tap-register.sh's flocked write, which calls adoptReleasedHandle once per
// released handle.
//
// §12's six mistakes are the review checklist: no fiction actor, no transitive
// adoption, no cross-team adopt, no identity laundering, no dual settler API,
// journal + re-read for the rare-reclaim races.
import { closeSync, existsSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { writeAllSync } from "./fsatomic";
import { PY_SPACE } from "./events";
import { join } from "node:path";

/** CONTRACT caps (design §2.2 / ruling 3): overflow past these is surfaced as a
 * loud remainder, fail-closed, NEVER silently truncated.
 *   MAX_PAYLOADS — payloads adopted per released handle (enforced in adoptReleasedHandle).
 *   MAX_ADOPTED_HANDLES — handles adopted per register release-sweep. Enforced by
 *     the sweep's caller (tap-register.sh), which references this constant so
 *     both caps have one source of truth. */
export const MAX_PAYLOADS = 64;
export const MAX_ADOPTED_HANDLES = 8;

/** Line bytes WITH their original terminators, so concatenating lines back is
 * the exact file. The final line may carry no terminator. Splits on the
 * newline trio — CRLF (emitted at the LF), LF, and lone CR — the same
 * universal-newline translation the incumbent frontmatter parser was written
 * against: a CR-only payload is one invisible line under a bare-\n split and
 * its mail then goes unreported and unadopted. (Python splitlines()'s wider
 * exotic family — VT/FF, 0x1c–0x1e, NEL, LS/PS — stays deliberately out of
 * scope; the delta is recorded as a declared difference.) */
function splitLineBytes(buf: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    if (b === 0x0a) {
      lines.push(buf.subarray(start, i + 1));
      start = i + 1;
    } else if (b === 0x0d && buf[i + 1] !== 0x0a) {
      lines.push(buf.subarray(start, i + 1));
      start = i + 1;
    }
  }
  if (start < buf.length) lines.push(buf.subarray(start));
  return lines;
}

/** Line content without its terminator, decoded for STRUCTURE matching only
 * (fences and field keys are ASCII text; the incumbent parsed text). Untouched
 * lines are never re-encoded — their original bytes flow through verbatim. */
function lineText(line: Buffer): string {
  let end = line.length;
  if (end > 0 && line[end - 1] === 0x0a) end--;
  if (end > 0 && line[end - 1] === 0x0d) end--;
  return line.subarray(0, end).toString("utf8");
}

/** FATAL UTF-8 for the frontmatter region only. The incumbent opened payloads
 * with encoding="utf-8", so undecodable bytes raised UnicodeDecodeError and
 * escaped; that is pinned into the report's degraded-warning boundary. A
 * lossy decode here would silently reclassify unreadable mail as absent — a
 * trim would strand payloads no warning ever named. ignoreBOM keeps the
 * leading U+FEFF in the decoded text, exactly like python's utf-8 codec: a
 * BOM'd opening line is "\ufeff---", not "---", so the payload stays
 * rejected. Body bytes stay outside this decoder: the byte-preservation
 * contract only promises frontmatter is text, and the non-UTF-8-body
 * adoption regression depends on it. */
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function lineTextStrict(line: Buffer): string {
  let end = line.length;
  if (end > 0 && line[end - 1] === 0x0a) end--;
  if (end > 0 && line[end - 1] === 0x0d) end--;
  return STRICT_UTF8.decode(line.subarray(0, end));
}

/** python str.strip() over the strict-decoded fence lines. NOT JS trim(): the
 * JS whitespace class strips U+FEFF, python's does not, so trim() would turn
 * a BOM'd opening line back into "---" and accept a payload the incumbent
 * rejects (the very bug ignoreBOM exists to prevent). */
const PY_STRIP_RE = new RegExp(`^${PY_SPACE}+|${PY_SPACE}+$`, "g");

function pyStrip(value: string): string {
  return value.replace(PY_STRIP_RE, "");
}

/** Byte-true (fields, lines) for a payload's first `---`..`---` block. `fields`
 * is null when the frontmatter is absent or unterminated — such a file is not
 * a valid payload and is skipped by the caller. Lines keep their terminators
 * so a rewrite can mutate ONLY the target line and preserve every other byte,
 * including a non-UTF-8 body and the file's final-newline state. Decoding is
 * fatal inside the fence region and never touches body lines: without a
 * closing fence the incumbent's whole-file strict read saw every line, so an
 * unterminated frontmatter with undecodable bytes throws here exactly like
 * the python did. */
function frontmatterLines(path: string): { fields: Record<string, string> | null; lines: Buffer[] } {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch {
    return { fields: null, lines: [] };
  }
  const lines = splitLineBytes(buf);
  if (lines.length === 0 || pyStrip(lineTextStrict(lines[0]!)) !== "---") return { fields: null, lines };
  const fields: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const ln = lineTextStrict(lines[i]!);
    if (pyStrip(ln) === "---") return { fields, lines };
    if (ln.includes(":") && !ln.startsWith(" ") && !ln.startsWith("\t")) {
      const ci = ln.indexOf(":");
      fields[pyStrip(ln.slice(0, ci))] = pyStrip(ln.slice(ci + 1)); // LAST match wins
    }
  }
  return { fields: null, lines }; // unterminated frontmatter — not a valid payload
}

/** Return (fields, lines) for a payload's first `---`..`---` block. `fields` is
 * null when the frontmatter is absent or unterminated — such a file is not a
 * valid payload and is skipped by the caller. */
export function frontmatter(path: string): { fields: Record<string, string> | null; lines: string[] } {
  const { fields, lines } = frontmatterLines(path);
  return { fields, lines: lines.map((l) => lineText(l)) };
}

function isSettled(receiptsDir: string, ident: string): boolean {
  return existsSync(join(receiptsDir, `${ident}.done`)) || existsSync(join(receiptsDir, `${ident}.cancelled`));
}

/** Atomically set `to := successor` and append forensic fields; touch nothing
 * else. Only the frontmatter `to:` line is rewritten (the first one, before the
 * closing `---`), so a body line that happens to start `to:` is never mutated.
 * Every untouched line flows through as its ORIGINAL bytes — a body may carry
 * NULs, invalid UTF-8, CRLF endings, or a missing final newline, and must
 * survive adoption byte-exact (TAP admits arbitrary body bytes; only the
 * frontmatter is text). */
function rewriteTo(path: string, successor: string, released: string, nowIso: string): void {
  const { lines } = frontmatterLines(path);
  const out: Buffer[] = [];
  let injected = false;
  let inFrontmatter = false;
  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx]!;
    const text = lineText(raw);
    // Fence recognition matches frontmatterLines: python str.strip, NOT JS
    // trim() (trim misses \x85, so a NEL-terminated fence was eligible here
    // but never rewritten — counted without being stamped). Lossy decode only;
    // body lines are never decoded strictly. (Fable r1 N1.)
    if (idx === 0 && pyStrip(text) === "---") {
      inFrontmatter = true;
      out.push(raw);
      continue;
    }
    if (inFrontmatter && pyStrip(text) === "---") {
      inFrontmatter = false;
      out.push(raw);
      continue;
    }
    if (inFrontmatter && !injected && text.startsWith("to:")) {
      let cut = raw.length;
      if (cut > 0 && raw[cut - 1] === 0x0a) cut--;
      if (cut > 0 && raw[cut - 1] === 0x0d) cut--;
      out.push(Buffer.from(`to: ${successor}`, "utf8"), raw.subarray(cut)); // keep the line's own terminator
      out.push(Buffer.from(`to_adopted_from: ${released}\nadopted_at: ${nowIso}\n`, "utf8"));
      injected = true;
    } else {
      out.push(raw);
    }
  }
  // mkstemp-in-dir + atomic rename, 0600 like the incumbent's mkstemp.
  const directory = join(path, "..");
  const tmp = join(directory, `.adopt.${process.pid}.${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    // Whole-buffer write: a partial writeSync must never rename a truncated
    // payload over the canonical one.
    writeAllSync(fd, Buffer.concat(out));
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** The payloads directory itself could not be scanned (not a per-payload
 * parse failure — those stay silent/skip, matching the incumbent's
 * per-file tolerance). Distinct type so a caller can catch ONLY this. */
export class StrandScanFailure extends Error {
  constructor(readonly handle: string, readonly scanError: unknown) {
    super(`stranded-payload scan failed for '${handle}': ${String(scanError)}`);
  }
}

/** Sorted ids of unsettled team-local payloads addressed to `handle`.
 *
 * The single eligibility predicate shared by adoption (adoptReleasedHandle,
 * which then rewrites them) and the strand report (strandedIds, which only
 * names them). One definition means the report can never disagree with what
 * adoption would actually grab. Excludes outbound (`from == handle`, sender
 * supervision stays with the sender), another team's mail (18so), and settled
 * history. Sorted so callers get a deterministic claim/report order. */
export function eligibleIds(payloadsDir: string, receiptsDir: string, handle: string, localTeam: string): string[] {
  let names: string[];
  try {
    names = readdirSync(payloadsDir);
  } catch (error) {
    // ENOENT is a legitimately empty bus (no payloads dir at all); anything
    // else (EACCES, a transient I/O error) is a scan that could not run and
    // must not be reported the same as a proven-empty result (the strand
    // report distinguishes exactly this — a zero that licenses "nothing to
    // warn about" needs to come from an instrument that can refuse). Tagged
    // as StrandScanFailure (rather than left as the raw errno) so a caller
    // can catch ONLY this — not an unrelated per-payload parse throw, like
    // frontmatter's strict-UTF8 decode, which must keep escaping all the way
    // to the report's outer degraded-warning catch (team.test.ts's "an
    // unreadable payload degrades the report without overturning the trim").
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new StrandScanFailure(handle, error);
  }
  // Shell-glob parity: `*.md` never matches a dotfile (the adoption journal is
  // deliberately invisible to this scan).
  const eligible: string[] = [];
  for (const name of names) {
    if (name.startsWith(".") || !name.endsWith(".md")) continue;
    const ident = name.slice(0, -3);
    const p = join(payloadsDir, name);
    let isFile = false;
    try { isFile = statSync(p).isFile(); } catch { /* vanished mid-scan */ }
    if (!isFile) continue;
    const { fields } = frontmatter(p);
    if (!fields) continue;
    if (fields.to !== handle) continue; // addressed-to-handle only (never outbound)
    const toTeam = fields.to_team ?? "";
    if (toTeam && toTeam !== localTeam) continue; // 18so: never another team's mail
    if (isSettled(receiptsDir, ident)) continue; // never touch settled history
    eligible.push(ident);
  }
  eligible.sort();
  return eligible;
}

/** Read-only: ids a trim of `handle` would strand (unsettled team-local
 * inbound). tap-q2v4: `tap team refresh` trims a dead handle row with NO
 * successor to claim its mail (unlike register release, which adopts). This
 * names the orphan so the operator can act — same eligibility predicate as
 * adoption, but it rewrites NOTHING and invents no second adoption verb
 * (design §11.5). Returns a sorted id list. */
export function strandedIds(payloadsDir: string, receiptsDir: string, handle: string, localTeam: string): string[] {
  return eligibleIds(payloadsDir, receiptsDir, handle, localTeam);
}

export interface AdoptResult { adopted_ids: string[]; count: number; remainder: string[] }

export interface BatchAdoptResult {
  /** Per-handle actual results — every started handle finished and reports its true count. */
  handles: Record<string, AdoptResult>;
  /** Handles the deadline skipped BEFORE their mutation began (never touched). */
  skipped: string[];
  /**
   * Handles that STARTED but whose outcome is UNKNOWN: a later step threw
   * (journal/write/rename), so their payloads may be partially or fully
   * rewritten. The caller must warn loudly and must never record these as
   * count 0 — zero is a fact, unknown is not.
   */
  failed: string[];
}

/**
 * One batched adoption across every released handle: the caller spends ONE
 * subprocess for the whole sweep, and the monotonic deadline gates each handle
 * BEFORE its first rewrite. Once a handle starts it runs to completion — the
 * caller must never kill a child that has begun mutating payloads, so there is
 * no kill-after-mutation boundary by construction. A mid-flight failure on one
 * handle is isolated: earlier completed handles keep their actual results, the
 * failed handle lands in `failed`, and the batch still returns its JSON.
 */
export function adoptReleasedHandles(
  payloadsDir: string,
  receiptsDir: string,
  releasedHandles: string[],
  successor: string,
  localTeam: string,
  opts: { deadlineAtMs?: number; maxPayloads?: number; nowIso?: string; now?: () => number; adoptOne?: (handle: string) => AdoptResult } = {},
): BatchAdoptResult {
  const now = opts.now ?? Date.now;
  const adoptOne = opts.adoptOne ?? ((handle: string) => adoptReleasedHandle(payloadsDir, receiptsDir, handle, successor, localTeam, opts));
  const handles: Record<string, AdoptResult> = {};
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const handle of releasedHandles) {
    if (opts.deadlineAtMs !== undefined && now() >= opts.deadlineAtMs) {
      skipped.push(handle);
      continue;
    }
    try {
      handles[handle] = adoptOne(handle);
    } catch (e) {
      process.stderr.write(`seat-adopt: adoption of '${handle}' ended in an unknown state: ${(e as Error)?.message ?? String(e)}\n`);
      failed.push(handle);
    }
  }
  return { handles, skipped, failed };
}

export function adoptReleasedHandle(
  payloadsDir: string,
  receiptsDir: string,
  released: string,
  successor: string,
  localTeam: string,
  opts: { maxPayloads?: number; nowIso?: string } = {},
): AdoptResult {
  const maxPayloads = opts.maxPayloads ?? MAX_PAYLOADS;
  const nowIso = opts.nowIso ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  let dirOk = false;
  try { dirOk = statSync(payloadsDir).isDirectory(); } catch { /* missing bus */ }
  if (!dirOk) return { adopted_ids: [], count: 0, remainder: [] };

  // Addressed-to-handle only: never touch outbound `from == released` (do not
  // reassign guilt — sender supervision stays with the sender), never a payload
  // already at the successor (idempotent), never a non-matching handle, never
  // another team's mail (18so), never settled history.
  const eligible = eligibleIds(payloadsDir, receiptsDir, released, localTeam);
  const within = eligible.slice(0, maxPayloads);
  const remainder = eligible.slice(maxPayloads);

  // Journal the intended batch before rewriting (§8.4): a crash mid-loop is
  // recoverable because adoption is idempotent (a payload already at the
  // successor re-scans as `to != released` and is skipped) and each rewrite is
  // an atomic rename.
  const journal = join(payloadsDir, `.adopt-journal-${released}`);
  if (within.length > 1) {
    writeFileSync(journal, `${within.join("\n")}\n`, "utf8");
  }

  const adopted: string[] = [];
  for (const ident of within) {
    rewriteTo(join(payloadsDir, `${ident}.md`), successor, released, nowIso);
    adopted.push(ident);
  }

  try { unlinkSync(journal); } catch { /* single-payload batch wrote no journal */ }
  return { adopted_ids: adopted, count: adopted.length, remainder };
}

// --- CLI door (pure transport for Bash consumers) -----------------------------

export function cliSeatAdopt(argv: string[]): number {
  const cmd = argv[0] ?? "";
  try {
    if (cmd === "caps") {
      process.stdout.write(`${JSON.stringify({ max_adopted_handles: MAX_ADOPTED_HANDLES, max_payloads: MAX_PAYLOADS })}\n`);
      return 0;
    }
    if (cmd === "stranded" && argv.length >= 5) {
      const ids = strandedIds(argv[1]!, argv[2]!, argv[3]!, argv[4]!);
      process.stdout.write(`${JSON.stringify(ids)}\n`);
      return 0;
    }
    if (cmd === "adopt" && argv.length >= 6) {
      const res = adoptReleasedHandle(argv[1]!, argv[2]!, argv[3]!, argv[4]!, argv[5]!,
        argv[6] !== undefined ? { maxPayloads: Number(argv[6]) } : {});
      process.stdout.write(`${JSON.stringify(res)}\n`);
      return 0;
    }
    if (cmd === "adopt-batch" && argv.length >= 7) {
      const deadlineRaw = argv[5]!;
      const deadlineNum = Number(deadlineRaw);
      const res = adoptReleasedHandles(argv[1]!, argv[2]!, argv.slice(6), argv[3]!, argv[4]!,
        Number.isFinite(deadlineNum) && deadlineRaw !== "-" ? { deadlineAtMs: deadlineNum } : {});
      process.stdout.write(`${JSON.stringify(res)}\n`);
      return 0;
    }
  } catch (e) {
    process.stderr.write(`seat-adopt: ${(e as Error)?.message ?? String(e)}\n`);
    return 1;
  }
  process.stderr.write("seat-adopt: expected 'caps' | 'stranded <payloads> <receipts> <handle> <team>' | 'adopt <payloads> <receipts> <released> <successor> <team> [max]' | 'adopt-batch <payloads> <receipts> <successor> <team> <deadline-epoch-ms|-> <handle>...'\n");
  return 64;
}

if (import.meta.main) {
  process.exit(cliSeatAdopt(process.argv.slice(2)));
}
