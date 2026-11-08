import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

/** Read only the frontmatter, preserving the parser's universal-newline rules. */
export function readFrontmatterHeader(path: string, stripFenceWhitespace = false): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) return "";
    const chunk = Buffer.alloc(512), decoder = new StringDecoder("utf8");
    let raw = "", start = 0, scan = 0;
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      raw += n ? decoder.write(chunk.subarray(0, n)) : decoder.end();
      const newline = /\r\n|\r|\n/g;
      newline.lastIndex = scan;
      let match: RegExpExecArray | null;
      while ((match = newline.exec(raw))) {
        // CRLF may cross a chunk boundary.
        if (n && match[0] === "\r" && newline.lastIndex === raw.length) break;
        const line = stripFenceWhitespace ? raw.slice(start, match.index).replace(PY_STRIP, "") : raw.slice(start, match.index);
        if (start === 0 && line !== "---") return "";
        if (start > 0 && line === "---") return raw.slice(0, newline.lastIndex);
        start = newline.lastIndex;
      }
      if (!n) return raw;
      scan = raw.endsWith("\r") ? raw.length - 1 : raw.length;
    }
  } finally { closeSync(fd); }
}

export function readFrontmatter(path: string): Record<string, string> {
  return frontmatterFields(readFrontmatterHeader(path));
}

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

