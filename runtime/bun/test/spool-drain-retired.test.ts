import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainOnce, type DrainContext, type DrainEffects } from "../src/spool-drain";
import { retirementCandidates } from "../src/spool-retired";
import { removeScratchTree } from "./support/scratch";

test("retired rows awaiting withdrawal skip readiness while a live row is observed", async () => {
  const home = mkdtempSync(join(tmpdir(), "drain-retired-readiness-"));
  const registry = join(home, "registry.json"), spool = join(home, "spool");
  for (const dir of ["spool", "payloads", "receipts"]) mkdirSync(join(home, dir));
  writeFileSync(join(home, ".tap-bus-authority"), "");
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture" }, seats: {
    peer: { instance: "peer|new", registered_at: "2026-09-07T11:52:03Z", status: "active", pane: "live:0.0", pane_id: "%5" },
  } }));
  for (const [id, policy, instance] of [["old-standard", "standard", "peer|old"], ["old-auto", "autosettle", "peer|old"], ["live", "standard", "peer|new"]]) {
    writeFileSync(join(spool, `${id}.md`), `---\nid: ${id}\nfrom: sender\nto: peer\nkind: discuss\nreply: expected\npath: ${home}/payloads/${id}.md\nrecipient_instance: ${instance}\n---\nbody ${id}\n`);
    writeFileSync(join(spool, `${id}.meta.json`), JSON.stringify({ id, target: "peer", pane: `${id}:0.0`, pane_id: "%5",
      to_team: "fixture", target_registry: registry, policy, first_spooled_epoch: 1788623678, deadline_epoch: 2000000000,
      reason: "pending-input", reason_class: "busy", attempts: 0 }));
    // A competing claim retains both files, so their absence cannot mask a
    // missing retired-row guard in either drain phase.
    if (id!.startsWith("old-")) writeFileSync(join(spool, `${id}.claim`), "another owner");
  }
  const env = { ...process.env, TAP_HOME: home, TAP_LOCK_DIR: join(home, "locks"), TAP_SPOOL_DRAIN_ACTIVE: "0" };
  const ctx: DrainContext = { home, spoolDir: spool, payloadsDir: join(home, "payloads"), receiptsDir: join(home, "receipts"),
    eventLog: join(home, "registry-events.log"), team: "fixture", actingRegistry: registry, verbLabel: "tap",
    scriptsDir: join(import.meta.dir, "../../../skills/tap/scripts"), courierIdentity: "courier", alert: { mode: "none" },
    now: 1788625000, unroutedGrace: 1800, env };
  const probes: string[] = [], deliveries: string[] = [];
  const fx: DrainEffects = {
    readiness: async row => { probes.push(row.pane); return "busy:noprompt"; },
    harness: async () => "codex", flash: async () => {}, repairOrphans: async () => {},
    redeliverLocked: async id => { deliveries.push(id); return 1; },
    digest: async (_row, ids) => { deliveries.push(...ids); return 1; },
  };
  try {
    expect(retirementCandidates(home, registry)).toEqual(["old-auto", "old-standard"]);
    expect(await drainOnce(ctx, fx)).toBe(0);
    expect(probes).toEqual(["live:0.0", "live:0.0"]);
    expect(deliveries).toEqual([]);
    for (const id of ["old-auto", "old-standard"]) {
      expect(existsSync(join(spool, `${id}.md`))).toBe(true);
      expect(readFileSync(join(spool, `${id}.claim`), "utf8")).toBe("another owner");
      expect(existsSync(join(home, "receipts", `${id}.cancelled`))).toBe(false);
    }
  } finally { removeScratchTree(home); }
});
