// Detached, file-only upkeep. Foreground verbs and the watcher share this owner;
// the success stamp is never advanced by a busy, interrupted or failed pass.
import { lstatSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { archiveBus } from "./bus-archive";
import { type MaintenanceReport } from "./bus-archive-index";
import { maintenanceDue } from "./bus-maintenance-trigger";
import { atomicWrite } from "./fsatomic";
import { acquirePathLock, childBusEnv } from "./panelock";
import { withResetCustody } from "./reset";
import { spoolContextFacts } from "./spool-engine-worker";
import { type DeadlineContext } from "./spool-deadline";
import { cleanupPark, MAX_PARK_NOTICES_PER_PASS, parkCleanupDue, parkedIds } from "./spool-expiry";
import { reapStaleSidecars } from "./spool-sidecar";

export function runBusMaintenance(home: string, now = Date.now(), env = process.env): MaintenanceReport | null {
  if (!isAbsolute(home) || !lstatSync(home).isDirectory() || !lstatSync(join(home, ".tap-bus-authority")).isFile()) return null;
  if (!maintenanceDue(home, now)) return null;
  const lock = acquirePathLock(join(home, "maintenance.lock"), 0, env);
  if (!lock) return null;
  try {
    if (!maintenanceDue(home, now)) return null;
    const report: MaintenanceReport = { at: now, status: "running", expired: 0, reconciled: 0, held: 0, archived: 0, error: "" };
    // Publish admission before the scan. Foreground callers observe this while
    // the first long pass runs, even though no success stamp exists yet.
    const started = withResetCustody(home,"bus maintenance start",()=>atomicWrite(join(home,"maintenance.json"),JSON.stringify(report)+"\n"),0);
    if (!started.ok) return null;
    report.status = "complete";
    try {
      const cleanEnv = { ...childBusEnv(home, env), TAP_BUS_MAINTENANCE_WORKER: "1" };
      const facts = spoolContextFacts(process.cwd(), cleanEnv);
      const ctx: DeadlineContext = { home, spoolDir: join(home, "spool"), eventLog: join(home, "registry-events.log"),
        team: facts[5] ?? "", actingRegistry: facts[6] ?? "", verbLabel: "tap bus maintenance",
        scriptsDir: join(import.meta.dir, "../../../skills/tap/scripts"), alert: { mode: "none" },
        now: now / 1000, unroutedGrace: 1800, env: cleanEnv };
      reapStaleSidecars(ctx.spoolDir, join(home, "payloads"), cleanEnv);
      let busy = 0;
      const noticeBudget = { remaining: MAX_PARK_NOTICES_PER_PASS };
      for (const id of parkedIds(ctx.spoolDir)) {
        if (!parkCleanupDue(ctx, id)) continue;
        const result = cleanupPark(ctx, id, noticeBudget);
        if (result === "expired") report.expired++;
        else if (result === "settled") report.reconciled++;
        else if (result === "held") report.held++;
        else if (result === "busy") busy++;
      }
      report.archived = archiveBus(home, 7, false, now).archived;
      if (report.held) {
        report.status = "blocked";
        report.error = "parked evidence or custody could not be retired";
      } else if (busy) {
        report.status = "retry";
        report.error = "parked cleanup is waiting for custody or notice publication";
      }
    } catch (error) {
      const detail = String(error);
      // Ordinary concurrency is not an operator repair request.
      report.status = /another bus archive job|active evidence changed|reset.*(?:fenced|busy)|team_reset_fenced|reset_custody_busy/.test(detail) ? "retry" : "blocked";
      report.error = detail;
    }
    const saved = withResetCustody(home, "bus maintenance result", () => {
      atomicWrite(join(home, "maintenance.json"), JSON.stringify(report) + "\n");
      if (report.status === "complete") atomicWrite(join(home, "maintenance.ok"), JSON.stringify({ at: now }) + "\n");
    }, 0);
    return saved.ok ? report : null;
  } finally { lock.release(); }
}

if (import.meta.main) {
  try { runBusMaintenance(Bun.argv[2] ?? ""); }
  catch { process.exitCode = 1; } // A refusal never advances maintenance.ok.
}
