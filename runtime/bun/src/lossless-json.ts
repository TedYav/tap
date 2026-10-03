// The lossless indent-2 registry serializer (python `json.dump(indent=2,
// sort_keys=True)` over the lossless parse): shared by the retirement and
// registration transactions so unknown wide-number metadata survives every
// locked rewrite. Extracted verbatim from out-retire.ts's private copy.
import { pyFloatRepr, pyJsonString, pyStrCompare } from "./spool-publication";
import type { JsonFloat, JsonValue } from "./watch-detect";
import { isMap } from "./watch-detect";

// Key sort is python's `sort_keys`: CODE-POINT order (`pyStrCompare`), not the
// UTF-16 code-unit `<` an astral key (surrogate pair 0xD800–0xDFFF) would sort
// below U+E000 under. Float literals render through `pyFloatRepr` — `1e0` is
// python's `1.0`, never the source token. Strings and keys escape through
// `pyJsonString`, whose `\uXXXX` set matches `ensure_ascii=True` exactly:
// `JSON.stringify` leaves DEL (0x7F) raw where python writes `\u007f`.
export function pyDumpIndent(v: JsonValue, depth: number, sortKeys = true): string {
  const pad = "  ".repeat(depth + 1);
  if (typeof v === "string") return pyJsonString(v);
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean" || v === null) return String(v);
  if (typeof v === "number") return pyFloatRepr(v);
  if (Array.isArray(v)) return v.length === 0 ? "[]" : `[\n${v.map(x => `${pad}${pyDumpIndent(x, depth + 1, sortKeys)}`).join(",\n")}\n${"  ".repeat(depth)}]`;
  if (isMap(v)) {
    // sort_keys=True is python's default only for callers that asked for it
    // (the registry serializer); plain json.dump(indent=2) preserves
    // insertion order, so the installer surface passes sortKeys=false.
    const entries = [...v.entries()];
    if (sortKeys) entries.sort(([a], [b]) => pyStrCompare(a, b));
    if (v.size === 0) return "{}";
    return `{\n${entries.map(([k, x]) => `${pad}${pyJsonString(k)}: ${pyDumpIndent(x, depth + 1, sortKeys)}`).join(",\n")}\n${"  ".repeat(depth)}}`;
  }
  // A carried float literal: python reprinted the PARSED value (NaN, Infinity
  // and -Infinity included — pyFloatRepr spells each the json.dump way).
  return pyFloatRepr(Number((v as JsonFloat).float));
}
