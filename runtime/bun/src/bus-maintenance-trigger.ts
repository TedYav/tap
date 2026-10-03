// Foreground admission only. The due path detaches; no payload/spool enumeration
// or archive work runs in the invoking verb.
import { spawn } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { bunBinary } from "./courier-argv";
import { childBusEnv } from "./panelock";
import { runtimeModule } from "./scripts-dir";
import { maintenanceReport } from "./bus-archive-index";

export const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const MAINTENANCE_RETRY_MS = 60 * 60 * 1000;
const checked = new Set<string>();
const pending = new Set<string>();
let scheduled = false;

/** ensureDirs can run under reset custody. Defer admission until the command
 * has unwound every lock; a watcher uses the explicit outside-custody door. */
export function scheduleBusMaintenance(home: string): void {
  if (process.env.TAP_BUS_MAINTENANCE_WORKER === "1") return;
  pending.add(home);
  if (scheduled) return;
  scheduled = true;
  process.once("beforeExit", () => {
    for (const bus of pending) maybeStartBusMaintenance(bus);
    pending.clear();
  });
}

export function maintenanceDue(home: string, now = Date.now()): boolean {
  let old = false;
  try {
    const stamp = lstatSync(join(home, "maintenance.ok"));
    old = stamp.isFile() && now >= stamp.mtimeMs + MAINTENANCE_INTERVAL_MS;
  } catch (error: any) {
    if (error.code !== "ENOENT") return false;
    // New buses get a day before their first maintenance. This also avoids a
    // background worker racing the initial bootstrap of an empty bus.
    try {
      const birth = lstatSync(join(home, ".tap-bus-authority"));
      old = birth.isFile() && now >= birth.mtimeMs + MAINTENANCE_INTERVAL_MS;
    } catch { return false; }
  }
  if (!old) return false;
  if (existsSync(join(home,"reset.fence.json"))) return false;
  // The healthy path is one stat. A due bus also checks the tiny attempt
  // record so an in-flight or failed pass cannot spawn a worker per command.
  const attempt = maintenanceReport(home);
  return !attempt || attempt.status === "complete" || now >= attempt.at + MAINTENANCE_RETRY_MS;
}

export function maybeStartBusMaintenance(home: string, env = process.env, oncePerInvocation = true,
  start: (home: string, env: NodeJS.ProcessEnv) => void = spawnMaintenance): void {
  if (env.TAP_BUS_MAINTENANCE_WORKER === "1" || (oncePerInvocation && checked.has(home))) return;
  if (oncePerInvocation) checked.add(home);
  if (!maintenanceDue(home)) return;
  try { start(home, env); } catch { /* maintenance cannot change the verb's result */ }
}

function spawnMaintenance(home: string, env: NodeJS.ProcessEnv): void {
  const child = spawn(bunBinary(), [runtimeModule("src/bus-maintenance.ts"), home], {
      env: { ...childBusEnv(home, env), TAP_BUS_MAINTENANCE_WORKER: "1" },
      detached: true, stdio: "ignore",
  });
  child.on("error", () => { /* no success stamp: the next invocation can retry */ });
  child.unref();
}
