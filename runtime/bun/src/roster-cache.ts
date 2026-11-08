import { statSync } from "node:fs";
import { runtimeCache } from "./runtime-cache";
import type { ObservedRow } from "./roster-observation";

export interface RosterSnapshot {
  rows: ObservedRow[];
  hierarchyRows: ObservedRow[];
  serverEpoch: string;
  callerSocket: string;
}

/** Seconds; zero disables caching, invalid env values retain the configured default. */
export function rosterCacheTtl(env: NodeJS.ProcessEnv = process.env, configured = 5): number {
  if (env.TAP_WATCH_NOW !== undefined) return 0;
  const value = env.TAP_ROSTER_CACHE_TTL;
  if (value === undefined || value.trim() === "") return configured;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : configured;
}

/** Registry changes invalidate display observations without any subprocess. */
export function rosterRegistryStamp(path: string): string | null {
  try {
    const s = statSync(path);
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  } catch { return null; }
}

/** Display-only snapshots. No lifecycle or delivery authority reads this cache. */
export function rosterCache(directory: string, mode: "full" | "nostate", identity: unknown, ttl: number, now?: number) {
  return runtimeCache(directory, `roster-${mode}`, identity, ttl, (value): value is RosterSnapshot => {
    const snapshot = value as RosterSnapshot | null;
    return Array.isArray(snapshot?.rows) && Array.isArray(snapshot?.hierarchyRows);
  }, now);
}
