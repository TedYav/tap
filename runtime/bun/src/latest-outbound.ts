// Read-only progress evidence shared by the team census and watcher.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type Outbound = { epoch: number; id: string };

// Match tap_frontmatter.py, not the courier's first-match envelope parser:
// universal newlines, optional closing fence, last duplicate wins, strip values.
function senderFields(raw: string): Record<string, string> {
  const fields: Record<string, string> = Object.create(null);
  const lines = raw.split(/\r\n|\r|\n/);
  if (lines[0] !== "---") return fields;
  for (const line of lines.slice(1)) {
    if (line === "---") break;
    const colon = line.indexOf(":");
    if (colon < 0 || ![" ", "\t"].includes(line[colon + 1] ?? "")) continue;
    const key = line.slice(0, colon);
    if (key === "from" || key === "from_team") {
      // Python str.strip includes U+001C..001F and U+0085, but not BOM.
      fields[key] = line.slice(colon + 1).replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g, "");
    }
  }
  return fields;
}

/** One read per eligible path, independent of the number of roster seats. */
export function latestOutbound(payloads: string, spool: string, team: string, now: number): Record<string, Outbound> {
  if (!Number.isSafeInteger(now)) throw new Error("invalid outbound clock");
  const latest: Record<string, Outbound> = Object.create(null);
  for (const directory of [payloads, spool]) {
    let names: string[];
    try { names = readdirSync(directory); } catch { continue; } // Python glob treats inaccessible directories as empty.
    for (const name of names) {
      if (!name.endsWith(".md") || name.startsWith("_") || name.startsWith(".")) continue;
      const path = join(directory, name);
      let fields: Record<string, string>;
      try { fields = senderFields(readFileSync(path, "utf8")); } catch { continue; }
      const sender = fields.from;
      if (sender === undefined || (fields.from_team && fields.from_team !== team)) continue;
      let epoch: number;
      try { epoch = Math.min(Math.trunc(statSync(path).mtimeMs / 1000), now); } catch { continue; }
      const id = name.slice(0, -3);
      const previous = latest[sender] ?? { epoch: 0, id: "" };
      // UTF-8 byte order matches Python's Unicode code-point tuple ordering.
      if (epoch > previous.epoch || (epoch === previous.epoch && Buffer.compare(Buffer.from(id), Buffer.from(previous.id)) > 0)) {
        latest[sender] = { epoch, id };
      }
    }
  }
  return latest;
}
