// Read-only presentation for the Bash and native show doors.
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { isSpace } from "./lint-body";
import { interruptNotice } from "./submit-phase";

type Json = null | boolean | string | Numeric | Json[] | Map<string, Json>;
class Numeric {
  constructor(readonly source: string) {}
  text(): string {
    if (!/[.eE]/.test(this.source) && !/NaN|Infinity/.test(this.source)) return BigInt(this.source).toString();
    const n = Number(this.source);
    if (!Number.isFinite(n)) return String(n);
    if (Object.is(n, -0)) return "-0.0";
    const scientific = n !== 0 && (Math.abs(n) < 1e-4 || Math.abs(n) >= 1e16);
    let result = scientific ? n.toExponential() : String(n);
    if (scientific) result = result.replace(/e([+-])(\d+)$/, (_, sign, digits) => `e${sign}${digits.padStart(2, "0")}`);
    else if (!result.includes(".")) result += ".0";
    return result;
  }
}

// Keep numeric lexemes and object insertion order: JSON.parse would round large
// integer evidence, lose 1.0, and reorder integer-like dictionary keys.
function parseJson(raw: string): Json {
  const tokens = raw.match(/"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|-Infinity|Infinity|NaN|true|false|null|[\[\]{},:]|[^\x20\t\r\n]/g) ?? [];
  let i = 0;
  const take = (expected: string) => { if (tokens[i++] !== expected) throw new Error("invalid JSON"); };
  function value(): Json {
    const token = tokens[i++];
    if (token === undefined) throw new Error("invalid JSON");
    if (token === "{") {
      const result = new Map<string, Json>();
      if (tokens[i] === "}") { i++; return result; }
      do {
        const key = tokens[i++];
        if (!key?.startsWith('"')) throw new Error("invalid JSON key");
        take(":"); result.set(JSON.parse(key), value());
        if (tokens[i] !== ",") break;
        i++;
      } while (true);
      take("}"); return result;
    }
    if (token === "[") {
      const result: Json[] = [];
      if (tokens[i] === "]") { i++; return result; }
      do { result.push(value()); if (tokens[i] !== ",") break; i++; } while (true);
      take("]"); return result;
    }
    if (token.startsWith('"')) return JSON.parse(token);
    if (token === "null") return null;
    if (token === "true" || token === "false") return token === "true";
    if (/^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|-Infinity|Infinity|NaN)$/.test(token)) return new Numeric(token);
    throw new Error("invalid JSON value");
  }
  const result = value();
  if (i !== tokens.length) throw new Error("trailing JSON");
  return result;
}
function reprString(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let result = quote;
  for (const c of value) {
    const cp = c.codePointAt(0)!;
    if (c === quote || c === "\\") result += "\\" + c;
    else if (c === "\n") result += "\\n";
    else if (c === "\r") result += "\\r";
    else if (c === "\t") result += "\\t";
    else if (c !== " " && /[\p{C}\p{Z}]/u.test(c)) result += cp <= 255 ? `\\x${cp.toString(16).padStart(2, "0")}` : cp <= 65535 ? `\\u${cp.toString(16).padStart(4, "0")}` : `\\U${cp.toString(16).padStart(8, "0")}`;
    else result += c;
  }
  return result + quote;
}
function format(value: Json, json = false, nested = false): string {
  if (value === null) return json ? "null" : "None";
  if (typeof value === "boolean") return json ? String(value) : value ? "True" : "False";
  if (typeof value === "string") return json ? JSON.stringify(value) : nested ? reprString(value) : value;
  if (value instanceof Numeric) {
    const text = value.text();
    return json ? text : text.replace(/NaN|Infinity/g, word => word === "NaN" ? "nan" : "inf");
  }
  if (Array.isArray(value)) return `[${value.map(v => format(v, json, true)).join(", ")}]`;
  return `{${[...value].map(([k, v]) => `${json ? JSON.stringify(k) : reprString(k)}: ${format(v, json, true)}`).join(", ")}}`;
}
function truthy(value: Json | undefined): boolean {
  if (value === undefined || value === null || value === false || value === "") return false;
  if (value instanceof Numeric) return Number(value.source) !== 0;
  if (Array.isArray(value)) return value.length > 0;
  return !(value instanceof Map) || value.size > 0;
}
function regular(path: string): boolean { try { return statSync(path).isFile(); } catch { return false; } }
function strip(value: string): string {
  let first = 0, last = value.length;
  while (first < last && isSpace(value[first]!)) first++;
  while (last > first && isSpace(value[last - 1]!)) last--;
  return value.slice(first, last);
}
function pad(value: string, width: number): string { return value + " ".repeat(Math.max(0, width - [...value].length)); }

/** A lower-ranked residency holding the same logical id as the shown copy. */
export interface AlsoRow { residency: string; count: number; example: string }

/** One `also:` line per lower-ranked residency, in the order given. */
export function alsoLines(also: AlsoRow[]): string[] {
  return also.map(row => `also: ${row.residency} ×${row.count} (${row.example})`);
}

export function renderShow(path: string, bus: string, ident: string, team: string, residency: string, explanation = "", also: AlsoRow[] = []): Buffer {
  const bytes = readFileSync(path);
  const lines = bytes.toString("utf8").split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  if (lines.at(-1) === "") lines.pop(); // Python splitlines has no terminal empty row.
  let front: string[] = [], bodyStart = 0;
  if (residency !== "quarantine" && lines.length && strip(lines[0]!) === "---") {
    const closing = lines.findIndex((line, i) => i > 0 && strip(line) === "---");
    if (closing >= 0) { front = lines.slice(1, closing); bodyStart = closing + 1; }
  }
  const output = [`path: ${path}`];
  if (team) output.push(`team: ${team}`);
  if (residency === "quarantine") output.push("residency: quarantine (malformed — moved out of payloads/; the bytes below are as they arrived)");
  else if (residency === "archive") output.push("residency: archive (cancelled — tap cancel moved the payload out of payloads/)");
  else if (residency === "history") output.push("residency: archive (settled history)");
  else if (residency === "spool") output.push("residency: spool");
  output.push(...alsoLines(also));
  output.push("", ...(residency === "quarantine" ? ["(no valid frontmatter — this artifact failed envelope validation)"] : front), "");
  if (explanation) output.push(explanation);
  const disruption = interruptNotice(residency === "history" ? dirname(dirname(path)) : bus, ident);
  if (disruption) output.push(disruption);
  const metadata = join(bus, "spool", ident + ".meta.json");
  if (residency === "spool" || regular(metadata)) {
    let meta: Json = null;
    try { meta = parseJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(metadata))); } catch { /* Unknown metadata is displayed below. */ }
    if (!(meta instanceof Map)) output.push("spool metadata: unavailable (missing or invalid JSON object)");
    else {
      output.push("recorded spool metadata (not current delivery status):");
      for (const field of ["reason", "policy", "waiter_lifetime", "deadline_epoch", "attempts"]) output.push(`  ${field}: ${meta.has(field) ? format(meta.get(field)!, true) : "unknown"}`);
    }
    output.push("");
  }
  output.push("receipts:");
  let found = false;
  for (const kind of ["placed", "read", "done", "cancelled", "unconfirmed"]) {
    const receipt = join(residency === "history" ? dirname(dirname(path)) : bus, "receipts", `${ident}.${kind}`);
    if (!regular(receipt)) continue;
    found = true;
    let rec: Json;
    try { rec = parseJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(receipt))); } catch { rec = new Map(); }
    if (!(rec instanceof Map)) throw new Error("receipt must be an object");
    const stamp = rec.get("at");
    const extra = ["by", "via", "identity", "forced", "reason", "superseded_by"].flatMap(field => {
      const value = rec.get(field);
      return value === undefined || value === null || value === "" ? [] : [`${field}=${format(value)}`];
    });
    output.push(`  ${pad(kind, 9)} ${pad(truthy(stamp) ? format(stamp!) : "-", 21)} ${extra.join(" ")}`);
  }
  if (!found) output.push("  (no placed/read/done/cancelled receipt)");
  output.push("", "body:");
  if (residency === "quarantine") return Buffer.concat([Buffer.from(output.join("\n") + "\n"), bytes]);
  output.push(lines.slice(bodyStart).join("\n").replace(/^\n+|\n+$/g, ""));
  return Buffer.from(output.join("\n") + "\n");
}
if (import.meta.main) {
  try {
    const [path, bus, ident, team, residency, explanation = ""] = Bun.argv.slice(2);
    if ([path, bus, ident, team, residency].some(value => value === undefined)) throw new Error("show renderer arguments missing");
    process.stdout.write(renderShow(path!, bus!, ident!, team!, residency!, explanation));
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
