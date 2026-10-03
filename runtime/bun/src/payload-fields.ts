/** `tap_frontmatter.frontmatter`: universal newlines, optional closing fence, last duplicate wins, values stripped. */
export function frontmatterFields(raw: string): Record<string, string> {
  const fields: Record<string, string> = Object.create(null);
  const lines = raw.split(/\r\n|\r|\n/);
  if (lines[0] !== "---") return fields;
  for (const line of lines.slice(1)) {
    if (line === "---") break;
    const colon = line.indexOf(":");
    if (colon < 0 || ![" ", "\t"].includes(line[colon + 1] ?? "")) continue;
    // python str.strip: includes \x1c-\x1f and \x85, not a BOM
    fields[line.slice(0, colon)] = line.slice(colon + 1).replace(PY_STRIP, "");
  }
  return fields;
}
export const PY_STRIP = /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;

