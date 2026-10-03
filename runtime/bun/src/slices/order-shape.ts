/**
 * Is this body shaped like a work order?
 *
 * On 2026-09-03 five hopper work orders went out as PLAIN sends — settle-only —
 * and three partners correctly refused them as notes. Nothing in the transport
 * objected, because a work order and a note are the same bytes to it. This
 * predicate is the objection; `tap-send.sh` owns which sends it applies to, and
 * the refusal names two doors (`tap assign`, or `--note`).
 *
 * The AND is the design: a bead id alone is ordinary status prose and a
 * `## Plan` heading alone is ordinary writing. Either half on its own must not
 * refuse anything.
 */

import { readFileSync } from "node:fs";

/** Lowercase phrases match case-insensitively; the SHOUTY markers match
 *  case-SENSITIVELY on purpose, because "dispatch" and "next item" are common in
 *  ordinary prose while "DISPATCH" and "NEXT ITEM" are how a hopper row shouts. */
const CASE_INSENSITIVE = ["read-back", "start now", "your next", "work order"];
const CASE_SENSITIVE = ["NEXT ITEM", "DISPATCH"];
const HEADINGS = ["## Plan", "## Units", "## Mission"];
/**
 * `{3,}`, not a bounded range: the issue store holds valid ids of 3, 4 and 5
 * characters after `tap-` (166 three-character ones, e.g. `tap-04n`), and the
 * counter only grows. An upper bound is the same lower-cliff defect reintroduced
 * at the top — a 6+-character id must not escape either. The marker AND still
 * gates, so a bare `tap-xxx` in prose never refuses on its own.
 */
// `\b` would be ASCII-only here, while the incumbent's Python `\b` is
// Unicode-aware — so `αtap-abc` had a word boundary in JS and none in Python, and
// a bead id glued to a non-ASCII letter counted as a conjunct that the
// incumbent did not count (review). The lookarounds spell the
// Unicode boundary out on both sides.
const BEAD_RE = /(?<![\p{L}\p{N}_])tap-[a-z0-9]{3,}(\.\d+)*(?![\p{L}\p{N}_])/u;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Python's `\s` for `str`, which is NOT JavaScript's.
 *
 * Python matches the C0 separators U+001C-U+001F and U+0085; JavaScript does
 * not. Three of those four are line boundaries and disappear in the split above,
 * but U+001F is not — so `\u001f## Plan` was an indented heading to the
 * incumbent and ordinary text to the port. The differential found this one; no
 * reviewer reported it, and no reading of the pattern list would have.
 */
const PY_SPACE = "[ \\t\\n\\r\\f\\v\\u001c-\\u001f\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const HEADING_RES = HEADINGS.map(heading => new RegExp("^" + PY_SPACE + "*" + escape(heading), "m"));
/**
 * `str.strip()`, not `trim()`. After the split, exactly two characters keep the
 * two engines' strip sets apart on a fence line: U+001F (Python strips it, JS
 * does not, and it is not a line boundary) and U+FEFF (JS strips it, Python does
 * not). Both divergences pointed in the incident direction — a `\u001f`-suffixed
 * closer left the fence unterminated so the body vanished and the order was
 * licensed; a `\ufeff`-suffixed fence was recognized as one so the conjuncts
 * were stripped and the order was licensed (review). The fence's strip
 * set is the same contract as the line-boundary set above.
 */
const PY_STRIP = new RegExp("^" + PY_SPACE + "+|" + PY_SPACE + "+$", "g");
const pyStrip = (line: string) => line.replace(PY_STRIP, "");

/**
 * BODY BYTES ONLY. A positional payload carries frontmatter, and envelope
 * metadata (an `id:` line, a `re:` line) must never supply a conjunct the author
 * did not write in their prose — otherwise the advertised AND is half-satisfied
 * by the envelope on every positional send.
 */
/**
 * Python's `str.splitlines()` boundary set, which is NOT `\n`.
 *
 * Splitting on `\n` alone let a CR-only frontmatter fence go unrecognized, so
 * the envelope stayed in the "body" and its `id:` line supplied the bead
 * conjunct the author never wrote — the exact half-satisfied AND the strip
 * exists to prevent (review). The incumbent used `splitlines`,
 * so these characters are the contract, not an implementation detail.
 */
const LINE_BOUNDARY = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

/**
 * BODY BYTES ONLY. A positional payload carries frontmatter, and envelope
 * metadata (an `id:` line, a `re:` line) must never supply a conjunct the author
 * did not write in their prose — otherwise the advertised AND is half-satisfied
 * by the envelope on every positional send.
 *
 * Lines are rejoined with `\n` exactly as the incumbent's `"\n".join(raw)` did,
 * which is also what makes the heading anchor below agree across the two regex
 * engines: after this, the only line separator left in the body is `\n`.
 */
export function bodyWithoutFrontmatter(raw: string): string {
  const lines = raw.split(LINE_BOUNDARY);
  if (pyStrip(lines[0] ?? "") !== "---") return lines.join("\n");
  for (let i = 1; i < lines.length; i++) {
    if (pyStrip(lines[i]!) === "---") return lines.slice(i + 1).join("\n");
  }
  // An unterminated fence is all frontmatter and no body, exactly as the
  // incumbent's `for ... else` read it: there is no prose to judge.
  return "";
}

export function isOrderShaped(raw: string): boolean {
  const body = bodyWithoutFrontmatter(raw);
  if (!BEAD_RE.test(body)) return false;
  const low = body.toLowerCase();
  return CASE_INSENSITIVE.some(marker => low.includes(marker))
    || CASE_SENSITIVE.some(marker => body.includes(marker))
    || HEADING_RES.some(heading => heading.test(body));
}

/**
 * The verdict is a TOKEN ON STDOUT, and the exit status is only a delivery
 * receipt for it.
 *
 * An earlier revision returned the incumbent's `sys.exit(0 if ... else 1)`
 * convention and let the adapter map 2 to "could not tell". That defeats itself:
 * a module that never runs — a missing import, a syntax error, a runtime Bun
 * cannot start — exits **1**, which is the status that means "not an order", and
 * "not an order" licenses the send this guard exists to refuse
 * (review, demonstrated with a shim that hid only this module).
 * Nothing this file can do with its own exit codes fixes that, because the
 * failing cases never reach this file's code.
 *
 * A positive token cannot be produced by a process that did not run. The
 * adapter therefore requires one and treats everything else — any other status,
 * empty output, unrecognized output — as no answer.
 */
if (import.meta.main) {
  const path = Bun.argv[2];
  if (path === undefined) process.exit(2);
  let raw: string;
  // `readFileSync(path, "utf8")`, not `Bun.file(path).text()`: the latter strips
  // a leading UTF-8 BOM, and the incumbent's `open(..., encoding="utf-8")` did
  // not. A body beginning with U+FEFF then `---` is NOT a frontmatter fence to
  // the incumbent (its strip() keeps the BOM), so the envelope stays in the
  // judged body and the order is refused; with the BOM silently removed the
  // fence is recognized, the conjuncts are stripped, and the order is licensed.
  // The predicate itself was already right — the defect was at the file-read
  // boundary, which a function-only oracle never crosses (partner review).
  try { raw = readFileSync(path, "utf8"); }
  catch (error) {
    process.stderr.write(`tap: order-shape: could not read ${path}: ${String((error as Error).message ?? error)}\n`);
    process.exit(2);
  }
  process.stdout.write(isOrderShaped(raw) ? "order-shape:shaped\n" : "order-shape:not-shaped\n");
}
