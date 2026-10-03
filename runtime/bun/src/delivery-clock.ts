import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { busForRegistry } from "./clear-fence";
import { atomicWrite, ensureAscii } from "./fsatomic";
import { acquirePathLock } from "./panelock";
import { pythonInt as integer } from "./pyint";

export function deliveryClockPath(registry: string, handle: string): string {
  if (!registry || !handle) return "";
  // ONE resolver, shared with the clear fence. This file used to carry its own
  // copy of the same rule — the recipient-side layout rule, which differs from
  // acting-registry enrollment validation — and a second copy is how the two
  // answers drift apart without anyone changing either on purpose.
  let bus: string;
  try { bus = busForRegistry(registry); } catch { return ""; }
  return join(bus, "delivery", `${handle.slice(handle.lastIndexOf("/") + 1)}.json`);
}

function clockValue(path: string): unknown {
  // Reviver source preserves Python's integer/float distinction and integers
  // beyond Number's precision, including a prior stamp newer by one second.
  return JSON.parse(readFileSync(path, "utf8"), (_key: string, value: unknown, context?: { source: string }) => {
    if (typeof value === "number" && context?.source && /^-?\d+$/.test(context.source)) return BigInt(context.source);
    return value;
  })?.last_delivered_at;
}
export function deliveryClockRead(registry: string, handle: string): string {
  try {
    const path = deliveryClockPath(registry, handle);
    if (!path || !statSync(path).isFile()) return "";
    const value = clockValue(path);
    return typeof value === "bigint" ? String(value) : typeof value === "string" ? String(integer(value, false) ?? "") : "";
  } catch { return ""; }
}

/** Verified delivery bookkeeping: failure must never turn success into a retry. */
export function deliveryClockStamp(registry: string, handle: string, epoch?: string, lockTimeoutMs = 5000): void {
  try {
    const path = deliveryClockPath(registry, handle);
    if (!path) return;
    const incoming = integer(epoch || process.env.TAP_SPOOL_NOW || String(Math.floor(Date.now() / 1000)), true);
    if (incoming === null) return;
    // The existing Python writer locks this exact persistent sidecar with flock.
    const lock = acquirePathLock(`${path}.lock`, lockTimeoutMs);
    if (!lock) return;
    try {
      let prior: unknown;
      try { prior = clockValue(path); } catch { /* unknown clock */ }
      if (typeof prior === "bigint" && prior > incoming) return;
      const bare = handle.slice(handle.lastIndexOf("/") + 1);
      atomicWrite(path, `{"handle":${ensureAscii(JSON.stringify(bare))},"last_delivered_at":${incoming}}`);
    } finally { lock.release(); }
  } catch { /* A missing stamp costs batching; aborting risks duplicate delivery. */ }
}

if (import.meta.main) {
  const [mode, registry = "", handle = "", epoch] = Bun.argv.slice(2);
  if (mode === "stamp") deliveryClockStamp(registry, handle, epoch);
  else if (mode === "path") process.stdout.write(deliveryClockPath(registry, handle));
  else if (mode === "read") { const value = deliveryClockRead(registry, handle); if (value) console.log(value); }
  else { console.error("delivery-clock: expected path, read or stamp"); process.exit(2); }
}
