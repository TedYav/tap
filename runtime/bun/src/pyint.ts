// Python's int() over a string, exactly: the whitespace Python strips, Unicode
// decimal digits, an optional sign, and (when `separators` is set) single
// underscores between digit groups -- returned as a BigInt so a value past
// Number.MAX_SAFE_INTEGER survives the trip through JSON the way it did through
// json.load/json.dump. Moved verbatim from delivery-clock.ts so the watch lease
// record's INT_KEYS coerce the same way the delivery clock does; null where
// Python raised ValueError.

import { parseUnicodeDecimal } from "./unicode-decimal";

export function pythonInt(raw: string, separators: boolean): bigint | null {
  // Python int whitespace excludes BOM and ASCII file/group separators.
  const whitespace = /[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
  const trim = (char: string) => whitespace.test(char) || (!separators && /[\u001c-\u001f]/.test(char));
  let start = 0, end = raw.length;
  while (start < end && trim(raw[start]!)) start++;
  while (end > start && trim(raw[end - 1]!)) end--;
  const value = raw.slice(start, end).replace(/\p{Nd}/gu, digit => String(parseUnicodeDecimal(digit)));
  if (!(separators ? /^[+-]?\d(?:_?\d)*$/ : /^-?\d+$/).test(value)) return null;
  try { return BigInt(value.replaceAll("_", "")); } catch { return null; }
}
