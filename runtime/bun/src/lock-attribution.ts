// Diagnostics after a refused submit. Never acquire or break the pane lock.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { atomicWrite } from "./fsatomic";
import { acquirePathLock } from "./panelock";

export interface LockHolder { pid: number; age: string; command: string }
// Best-effort diagnostics after a refusal — but recordLockPark's sole caller runs this
// synchronously inside the drain while it holds the per-entry claim lock
// (spool-drain-effects.ts:275), so a per-call timeout multiplies with the holder count under
// contention and can stall the drain and the watch tick. Bound the WHOLE observation — lsof plus
// every ps call together — to one deadline instead; each ps call gets whatever budget is left,
// and once it's spent, remaining holders are marked "unavailable" the same way an individual
// failure already was (tap-88xka's load-sensitive class; lock-attribution.test.ts:90 lost the
// holder's command at load1m 13.4 with the old flat 1000ms-per-call budget).
const TOTAL_DIAGNOSTIC_BUDGET_MS = 2500;

export function lockHolders(path: string): { holders: LockHolder[]; detail: string } {
  const deadline = Date.now() + TOTAL_DIAGNOSTIC_BUDGET_MS;
  const holders: LockHolder[] = [];
  let lsofStatus: number | null = null;
  const lsofBudget = deadline - Date.now();
  if (lsofBudget > 0) {
    const observed = spawnSync(Bun.which("lsof") ?? "/usr/sbin/lsof", ["-Fpc", "--", path],
      { encoding: "utf8", timeout: lsofBudget, maxBuffer: 65536 });
    lsofStatus = observed.status;
    if (observed.status === 0) {
      for (const line of observed.stdout.split("\n")) {
        if (!/^p[1-9][0-9]*$/.test(line)) continue;
        const pid = Number(line.slice(1));
        if (holders.some(holder => holder.pid === pid)) continue;
        const psBudget = deadline - Date.now();
        if (psBudget <= 0) { holders.push({ pid, age: "unavailable", command: "unavailable" }); continue; }
        // Full argv can contain another sender's message or credentials.
        // comm supplies only the executable; discard even its directory.
        const ps = spawnSync("ps", ["-p", String(pid), "-o", "etime=", "-o", "comm="],
          { encoding: "utf8", timeout: psBudget, maxBuffer: 65536 });
        const row = ps.status === 0 ? ps.stdout.trim().match(/^(\S+)\s+(.+)$/) : null;
        holders.push({ pid, age: row?.[1] ?? "unavailable", command: row ? basename(row[2]!).replace(/[\x00-\x1f\x7f]/g, "?") : "unavailable" });
      }
    }
  }
  const detail = holders.length
    ? holders.map(holder => `pid=${holder.pid} age=${holder.age} command=${holder.command}`).join("; ")
    : `holder unavailable (${lsofStatus === 1 ? "no open holder observed after refusal" : "lsof unavailable, incomplete, or diagnostic budget exhausted"})`;
  return { holders, detail: `reason=lock-park; ${detail}` };
}

/** Shares the existing metadata sidecar with the cadence writer. */
export function recordLockPark(metaPath: string, path: string): string {
  const observation = lockHolders(path);
  const lock = acquirePathLock(metaPath + ".lock");
  if (!lock) throw new Error("cannot record lock attribution: metadata busy");
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error("invalid spool metadata");
    // Attribution must not remint clocks, reclassify waiter ownership, or retire mail.
    meta.reason = "lock-park";
    meta.lock_park = { observed_at: new Date().toISOString(), lock_path: path, ...observation };
    atomicWrite(metaPath, JSON.stringify(meta, null, 2) + "\n");
  } finally { lock.release(); }
  return observation.detail;
}

if (import.meta.main) {
  try {
    const [meta, path] = Bun.argv.slice(2);
    if (!meta || !path) throw new Error("metadata and pane lock paths required");
    console.log(recordLockPark(meta, path));
  } catch (error) { console.error(String(error)); process.exit(2); }
}
