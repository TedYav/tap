import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWrite } from "./fsatomic";

interface Entry<T> {
  version: 1;
  key: string;
  observedAt: number;
  snapshot: T;
  checksum: string;
}
export const cacheDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Advisory observations only. Missing or damaged entries leave live readers in charge.
 * An entry's age is measured when it is read, not when this object was built: a clock
 * captured at construction misread an entry written after it as from the future, and
 * understated the age of one read late. `now` pins the clock for tests. */
export function runtimeCache<T>(directory: string, name: string, identity: unknown, ttl: number,
  valid: (value: unknown) => value is T, now?: number) {
  const path = join(directory, `${name}.json`), key = cacheDigest(identity);
  return {
    read(): { snapshot: T; observedAt: number } | null {
      if (ttl <= 0) return null;
      const at = now ?? Date.now();
      try {
        const entry = JSON.parse(readFileSync(path, "utf8")) as Entry<unknown>;
        if (entry.version !== 1 || entry.key !== key || !Number.isFinite(entry.observedAt)
          || at < entry.observedAt || at - entry.observedAt >= ttl * 1000
          || !valid(entry.snapshot) || entry.checksum !== cacheDigest(entry.snapshot)) return null;
        return { snapshot: entry.snapshot, observedAt: entry.observedAt };
      } catch { return null; }
    },
    write(snapshot: T, observedAt = Date.now()): void {
      // A display cache never creates the bus it sits in. The display entry
      // point separately decides whether the selected bus may be written.
      if (ttl <= 0 || !existsSync(dirname(directory))) return;
      try {
        atomicWrite(path, JSON.stringify({ version: 1, key, observedAt, snapshot, checksum: cacheDigest(snapshot) } satisfies Entry<T>) + "\n");
      } catch { /* An unavailable display cache never prevents a live report. */ }
    },
  };
}
