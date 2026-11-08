// Read-only progress evidence shared by the team census and watcher.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readFrontmatter } from "./payload-fields";

export type Outbound = { epoch: number; id: string };

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
      try { fields = readFrontmatter(path); } catch { continue; }
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
