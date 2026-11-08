// Pure rules of the watch tick's evaluator rung and escalation chain (slice W2b):
// the verdict normaliser, the unsettled-payload pre-check, the chain cursor
// (`next unprobed` / `probed append`), the probe-worthiness predicate, the
// evaluator prompt render, and python's `json.tool` rendering the prompt embeds.
// Each is a port of a python program `tap-watch.sh` forked, and each keeps its
// BYTES: the normalised verdict is written to a file the tick reads back field by
// field, the probed set goes into the arm record, and the prompt is what the
// evaluator model is given (runtime/bun/test/watch-evaluate.test.ts runs the
// python programs verbatim beside these).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { dumps, isMap, loads, pyStr, type JsonMap, type JsonValue } from "./watch-detect";
import { isSettled } from "./watch-lease";
import { readFrontmatterHeader } from "./payload-fields";

// python `str.strip()` / `.lower()` on the values the programs touch
const PY_WS = "[\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const PY_STRIP = new RegExp(`^${PY_WS}+|${PY_WS}+$`, "gu");
export function pyStrip(text: string): string { return text.replace(PY_STRIP, ""); }

/** `str(x)` of a JSON value read from the verdict: a string as-is, else python's repr. */
function str(v: JsonValue | undefined): string { return v === undefined ? "None" : pyStr(v); }

// --- the verdict normaliser -----------------------------------------------------------

export type Normalised = { status: 0; norm: string } | { status: 2 };

const ALLOW = new Set(["advance", "notify human", "disarm"]);
const VERDICTS = new Set(["done", "not_done", "blocked"]);

/** python truthiness of `data.get(k)` for the `or` chains below. */
function truthy(v: JsonValue | undefined): boolean {
  if (v === undefined || v === null || v === false) return false;
  if (v === true) return true;
  if (typeof v === "bigint") return v !== 0n;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map) return v.size > 0;
  return Number(v.float) !== 0;
}

/**
 * `_watch_normalize_verdict`: the evaluator's raw JSON to `{verdict, action, reason,
 * evidence_text}` (compact, ensure_ascii), or status 2 for anything the program
 * refused: unreadable JSON, a non-dict, a verdict outside done|not_done|blocked, an
 * action outside the allow list, or a `disarm` on a verdict that was not `done`.
 * A `done` without per-clause observable evidence, or with transcript-only
 * evidence, is demoted to `not_done`/`advance` with the program's reason.
 */
export function normalizeVerdict(raw: string): Normalised {
  let data: JsonValue;
  try { data = loads(raw); } catch { return { status: 2 }; }
  if (!isMap(data)) return { status: 2 };
  const verdictV = data.get("verdict");
  if (typeof verdictV !== "string" || !VERDICTS.has(verdictV)) return { status: 2 };
  let verdict: string = verdictV;
  const actionV = data.get("action");
  let action: JsonValue | undefined = actionV;
  // `action not in ALLOW`: a non-empty list or dict is unhashable -- the program raised (exit 1)
  if (truthy(actionV) && (Array.isArray(actionV) || isMap(actionV))) throw new TypeError(`unhashable type: '${Array.isArray(actionV) ? "list" : "dict"}'`);
  if (truthy(actionV) && !(typeof actionV === "string" && ALLOW.has(actionV))) return { status: 2 };
  const origVerdict = verdict;
  let evidence: JsonValue = truthy(data.get("evidence")) ? data.get("evidence")! : [];
  if (!Array.isArray(evidence)) evidence = [];
  let reason = truthy(data.get("reason")) ? str(data.get("reason")) : "";
  const lines: string[] = [];
  for (const item of evidence) {
    if (!isMap(item)) continue;
    const clause = pyStrip(truthy(item.get("clause")) ? str(item.get("clause")) : "");
    const citation = pyStrip(truthy(item.get("citation")) ? str(item.get("citation")) : truthy(item.get("source")) ? str(item.get("source")) : "");
    if (clause && citation) lines.push(`- ${clause}: ${citation}`);
  }
  let badDone = false;
  if (verdict === "done") {
    if (lines.length === 0) {
      badDone = true;
      reason = reason || "done verdict lacked per-clause observable evidence";
    }
    for (const line of lines) {
      const lower = line.toLowerCase();
      if (lower.includes("transcript:") || lower.startsWith("- transcript")) {
        badDone = true;
        reason = reason || "done verdict cited transcript-only evidence";
      }
    }
  }
  if (badDone) {
    verdict = "not_done";
    action = "advance";
  } else if (!truthy(action)) {
    action = ({ done: "disarm", blocked: "notify human", not_done: "advance" } as Record<string, string>)[verdict]!;
  }
  if (origVerdict !== "done" && action === "disarm") return { status: 2 };
  const norm: JsonMap = new Map<string, JsonValue>([
    ["verdict", verdict],
    ["action", action as JsonValue],
    ["reason", reason],
    ["evidence_text", lines.join("\n")],
  ]);
  return { status: 0, norm: dumps(norm, true) };
}

/** `_watch_norm_field`: `json.load(file).get(field, "")` printed (`print` of a str is the text; of a container, its repr). */
export function normField(norm: string, field: string): string {
  const v = loads(norm);
  if (!isMap(v)) throw new TypeError(`'${Array.isArray(v) ? "list" : typeof v === "string" ? "str" : "object"}' object has no attribute 'get'`);
  return v.has(field) ? pyStr(v.get(field)) : "";
}

// --- the chain cursor ------------------------------------------------------------------

/** `_watch_probe_worthy`: seats with POSITIVE stopped-or-stuck evidence. */
export function probeWorthy(state: string): boolean {
  return state === "idle-at-prompt" || state === "blocked-on-approval" || state === "rate-limited-error" || state === "wedged";
}

/**
 * `_watch_next_unprobed`: the first chain line (stripped, non-empty) not in the
 * probed set, `__human__` when the human is reached first or nothing is left.
 * `set(json.loads(argv or "[]"))` inside `try/except: set()`: a list's elements, a
 * dict's keys, a string's characters; anything unreadable or unsettable is empty.
 */
export function nextUnprobed(probedJson: string, chain: string): string {
  const probed = new Set<string>();
  try {
    const v = loads(probedJson || "[]");
    if (Array.isArray(v)) {
      // a list's elements; a non-string element never equals a chain line, and an
      // unhashable element (list/dict) made `set()` raise -> the empty set
      for (const x of v) {
        if (Array.isArray(x) || x instanceof Map) throw new TypeError("unhashable type");
        if (typeof x === "string") probed.add(x);
      }
    } else if (v instanceof Map) { for (const k of v.keys()) probed.add(k); }
    else if (typeof v === "string") { for (const ch of v) probed.add(ch); }
    else throw new TypeError("not iterable"); // None, a bool, a number
  } catch { probed.clear(); }
  let out = "__human__";
  for (const line of chain.split("\n")) {
    const s = pyStrip(line);
    if (!s) continue;
    if (s === "__human__") { out = "__human__"; break; }
    if (!probed.has(s)) { out = s; break; }
  }
  return out;
}

/**
 * `_watch_probed_append`: append the seat to the episode's probed list (idempotent);
 * compact JSON. `json.loads(argv or "[]")` inside `try/except: []`; then
 * `seat and seat not in a: a.append(seat)` -- a readable non-list raises at `append`
 * (a dict's `in` reads keys, a string's reads substrings; neither appends).
 */
export function probedAppend(probedJson: string, seat: string): string {
  let a: JsonValue;
  try { a = loads(probedJson || "[]"); } catch { a = []; }
  if (seat) {
    if (Array.isArray(a)) { if (!a.some((x) => x === seat)) a.push(seat); }
    else if (a instanceof Map) { if (!a.has(seat)) throw new TypeError("'dict' object has no attribute 'append'"); }
    else if (typeof a === "string") { if (!a.includes(seat)) throw new TypeError("'str' object has no attribute 'append'"); }
    else throw new TypeError(`argument of type '${a === null ? "NoneType" : typeof a === "boolean" ? "bool" : typeof a === "bigint" ? "int" : "float"}' is not iterable`);
  }
  return dumps(a, true);
}

// --- the pre-check -----------------------------------------------------------------------

/** The program's own frontmatter read: fence on line 1, first `kind:` line before the closing fence. */
function kindOf(path: string): string | null {
  let text: string;
  try { text = readFrontmatterHeader(path, true); } catch { return null; }
  const lines = text.split(/\r\n|\r|\n/);
  if (text.length > 0 && !text.endsWith("\n") && !text.endsWith("\r")) { /* readlines keeps a last unterminated line */ }
  else lines.pop();
  if (lines.length === 0 || pyStrip(lines[0]!) !== "---") return null;
  for (const ln of lines.slice(1)) {
    const s = pyStrip(ln);
    if (s === "---") break;
    if (s.startsWith("kind:")) return pyStrip(s.slice("kind:".length));
  }
  return null;
}

const SUPERVISION = new Set(["probe", "notice", "progress"]);

/** `_watch_has_unsettled`: an unsettled NON-supervision payload exists (exit 0). */
export function hasUnsettled(payloads: string, receipts: string): boolean {
  let names: string[];
  try { names = readdirSync(payloads); } catch { return false; } // glob of a missing dir is empty
  for (const b of names) {
    if (!b.endsWith(".md") || b.startsWith(".") || b.startsWith("_")) continue;
    const pid = b.slice(0, -3);
    if (isSettled(receipts, pid)) continue;
    const kind = kindOf(join(payloads, b));
    if (kind !== null && SUPERVISION.has(kind)) continue;
    return true;
  }
  return false;
}

// --- the prompt ---------------------------------------------------------------------------

/** `_watch_write_evaluator_prompt`'s render: the three tokens, `or "-"` for an empty value. */
export function renderEvaluatorPrompt(template: string, doneWhen: string, observable: string, transcripts: string): string {
  return template
    .replaceAll("{{DONE_WHEN}}", doneWhen || "-")
    .replaceAll("{{OBSERVABLE_STATE}}", observable || "-")
    .replaceAll("{{TRANSCRIPTS}}", transcripts || "-");
}

/** The incumbent's `json.tool` of a file's text: `json.dump(obj, indent=4)` + newline, ensure_ascii, insertion order. Throws where the tool errored. */
export function pyJsonTool(text: string): string {
  const v = loads(text);
  const go = (x: JsonValue, depth: number): string => {
    const pad = "    ".repeat(depth + 1);
    const end = "    ".repeat(depth);
    if (Array.isArray(x)) return x.length === 0 ? "[]" : `[\n${x.map((e) => pad + go(e, depth + 1)).join(",\n")}\n${end}]`;
    if (x instanceof Map) return x.size === 0 ? "{}" : `{\n${[...x].map(([k, e]) => `${pad}${dumps(k, true)}: ${go(e, depth + 1)}`).join(",\n")}\n${end}}`;
    return dumps(x, true);
  };
  return `${go(v, 0)}\n`;
}
