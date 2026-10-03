// Keep filename snapshots in the existing watch lifetime. The first read is
// O(N); consuming at most 24 names per tick amortizes that cost over the scan.
// Restarting watch restarts the scan. Cleanup decisions stay in the reapers.
import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { acquirePathLock, type PaneLock } from "./panelock";

export const GC_BATCH_SIZE = 24;
export interface GcBatch { sidecars: string[]; digests: string[]; paneEffects: string[] }
const keys = ["sidecars", "digests", "paneEffects"] as const;
export const emptyGcBatch = (): GcBatch => ({ sidecars: [], digests: [], paneEffects: [] });
const safeName = (name: unknown): name is string => typeof name === "string" && name !== "" && name !== "." && name !== ".." && basename(name) === name;

/** Batches are hints, never custody proof. Bound and validate the child input. */
export function parseGcBatch(raw: string | undefined): GcBatch | undefined {
  if (raw === undefined) return undefined;
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || keys.some(k => !Array.isArray(value[k]) || !value[k].every(safeName)) ||
    keys.reduce((n, k) => n + value[k].length, 0) > GC_BATCH_SIZE) throw new Error("invalid spool cleanup batch");
  return { sidecars: value.sidecars, digests: value.digests, paneEffects: value.paneEffects };
}

export class SpoolGcCursor {
  private owner: PaneLock | null = null;
  private snapshots = new Map<string, { names: string[]; offset: number; identity: string }>();
  private turn = 0;
  constructor(private home: string, private env: NodeJS.ProcessEnv = process.env) {}

  next(): GcBatch {
    const batch = emptyGcBatch();
    // Two watch loops must not each enumerate the same bus. Kernel release on
    // exit gives the successor a new scan without an owner-PID inference.
    this.owner ??= acquirePathLock(join(this.home, "watch", "spool-gc.lock"), 0, this.env);
    if (!this.owner) return batch;
    const paths = { sidecars: join(this.home, "spool"), digests: join(this.home, "spool", "digests"), paneEffects: join(this.home, "pane-effects") };
    const available = new Set<typeof keys[number]>();
    for (const key of keys) {
      try {
        const stat = statSync(paths[key]), identity = `${stat.dev}:${stat.ino}`;
        const old = this.snapshots.get(key);
        if (old && old.identity !== identity) this.dropSnapshot(key);
        if (!this.snapshots.has(key)) this.snapshots.set(key, { names: readdirSync(paths[key]), offset: 0, identity });
        available.add(key);
      } catch (error: any) {
        this.dropSnapshot(key);
        if (error.code !== "ENOENT") process.stderr.write(`tap spool cleanup: ${key}: ${error.message}\n`);
      }
    }
    for (let visits = 0; visits < GC_BATCH_SIZE && available.size; ) {
      const key = keys[this.turn++ % keys.length]!;
      if (!available.has(key)) continue;
      visits++;
      try {
        const snapshot = this.snapshots.get(key)!;
        const name = snapshot.names[snapshot.offset++];
        if (name !== undefined) batch[key].push(name);
        else { this.dropSnapshot(key); available.delete(key); }
      } catch (error: any) {
        this.dropSnapshot(key); available.delete(key);
        process.stderr.write(`tap spool cleanup: ${key}: ${error.message}\n`);
      }
    }
    return batch;
  }

  private dropSnapshot(key: string): void {
    this.snapshots.delete(key);
  }
  close(): void {
    for (const key of keys) this.dropSnapshot(key);
    this.owner?.release(); this.owner = null;
  }
}
