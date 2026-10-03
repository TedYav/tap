import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupPark, MAX_PARK_NOTICES_PER_PASS, PARK_RETENTION_SECONDS, parkCleanupDue } from "../src/spool-expiry";
import { drainOnce, type DrainContext, type DrainEffects } from "../src/spool-drain";
import { archiveNudge, archivedPayload, maintenanceReport } from "../src/bus-archive-index";
import { archiveBus } from "../src/bus-archive";
import { maintenanceDue, maybeStartBusMaintenance, MAINTENANCE_INTERVAL_MS, MAINTENANCE_RETRY_MS } from "../src/bus-maintenance-trigger";
import { runBusMaintenance } from "../src/bus-maintenance";
import { acquireObligationLock } from "../src/panelock";
import { noEffectProof } from "../src/spool-effect-proof";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bus-hygiene-")); roots.push(root);
  const home = join(root, ".tap/bus"), registry = join(root, ".tap/team-registry.json"), index = join(root, "index");
  for (const dir of [home, join(home, "spool"), join(home, "payloads"), join(home, "receipts"), index]) mkdirSync(dir, { recursive: true });
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture" }, seats: { sender: { status: "active", delivery: "poll", instance: "sender|1" } } }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { fixture: { root, registry_location: registry, state: "registered" } } }));
  writeFileSync(join(home, ".tap-bus-authority"), "bootstrapped\n");
  const now = Math.floor(Date.now() / 1000), env = { ...process.env, TAP_HOME: home, TAP_INDEX_HOME: index, TAP_BUS_MAINTENANCE_WORKER: "1" };
  const ctx: DrainContext = { home, spoolDir: join(home, "spool"), payloadsDir: join(home, "payloads"), receiptsDir: join(home, "receipts"),
    eventLog: join(home, "registry-events.log"), team: "fixture", actingRegistry: registry, scriptsDir: join(import.meta.dir, "../../../skills/tap/scripts"),
    verbLabel: "tap", courierIdentity: "courier", now, unroutedGrace: 1800, alert: { mode: "none" }, env,
    submit: () => { throw new Error("maintenance must never submit a pane notice"); } };
  function park(id: string, changes: Record<string, unknown> = {}, age = PARK_RETENTION_SECONDS + 1) {
    const path = join(ctx.spoolDir, `${id}.md`), meta = { id, target: "peer", pane: "fixture:0.0", pane_id: "%99", to_team: "fixture", target_registry: registry,
      policy: "standard", first_spooled_epoch: now - age, deadline_epoch: now - age + 300, reason: "pending-input", reason_class: "busy",
      deadline_source: "readiness-gate", attempts: 0, attempt_fence: 1, ...changes };
    const body = `---\nid: ${id}\nfrom: sender\nto: peer\nkind: discuss\nreply: expected\npath: ${path}\n---\nsynthetic body\n`;
    writeFileSync(path, body); utimesSync(path, now - age, now - age);
    writeFileSync(join(ctx.spoolDir, `${id}.meta.json`), JSON.stringify(meta));
    return { path, body, meta };
  }
  return { root, home, registry, index, ctx, env, now, park };
}

for (const scenario of ["held", "escalated", "missing-meta", "malformed-meta", "possible-effect"]) {
  test(`72h expiry preserves body and attempt evidence: ${scenario}`, () => {
    const f = fixture(), p = f.park("old", scenario === "escalated" ? { escalated_at: new Date((f.now - PARK_RETENTION_SECONDS) * 1000).toISOString() } : {});
    const meta = join(f.ctx.spoolDir, "old.meta.json");
    if (scenario === "missing-meta") rmSync(meta);
    if (scenario === "malformed-meta") writeFileSync(meta, "{broken");
    if (scenario === "possible-effect") writeFileSync(join(f.ctx.receiptsDir, "old.attempted"), "possible\n");
    expect(parkCleanupDue(f.ctx, "old")).toBe(true);
    expect(cleanupPark(f.ctx, "old")).toBe("expired");
    expect(readFileSync(join(f.ctx.payloadsDir, "old.md"), "utf8")).toBe(p.body);
    expect(existsSync(p.path)).toBe(false);
    const receipt = JSON.parse(readFileSync(join(f.ctx.receiptsDir, "old.cancelled"), "utf8"));
    expect(receipt).toMatchObject({ reason: "park_expired", via: "cancelled", source: "courier_expiry" });
    expect(existsSync(join(f.ctx.receiptsDir, "old.done"))).toBe(false);
    expect(readFileSync(join(f.ctx.payloadsDir, "old-park-expired.md"), "utf8")).toContain("PARK EXPIRED");
    expect(existsSync(join(f.ctx.receiptsDir, "old-park-expired.attempted"))).toBe(false);
    if (scenario === "possible-effect") {
      expect(readFileSync(join(f.ctx.receiptsDir, "old.attempted"), "utf8")).toBe("possible\n");
      expect(noEffectProof(f.home, f.ctx.spoolDir, "old", p.meta)).not.toBe("");
    }
    if (scenario === "malformed-meta") expect(readFileSync(join(f.home, "archive/old.meta.json"), "utf8")).toBe("{broken");
  });
}

test("settled routable and incomplete copies reconcile without cancelling or sending notices", () => {
  const f = fixture();
  for (const id of ["routable", "incomplete"]) {
    const p = f.park(id, {}, 10);
    if (id === "incomplete") rmSync(join(f.ctx.spoolDir, `${id}.meta.json`));
    const receipt = JSON.stringify({ id, at: new Date().toISOString(), by: "peer", via: "read" });
    writeFileSync(join(f.ctx.receiptsDir, `${id}.done`), receipt);
    expect(cleanupPark(f.ctx, id)).toBe("settled");
    expect(readFileSync(join(f.ctx.receiptsDir, `${id}.done`), "utf8")).toBe(receipt);
    expect(existsSync(p.path)).toBe(false);
    expect(existsSync(join(f.ctx.receiptsDir, `${id}.cancelled`))).toBe(false);
    expect(existsSync(join(f.ctx.payloadsDir, `${id}-park-expired.md`))).toBe(false);
  }
});

test("recent parks stay queued; expired parks never reach any readiness or submit entrance", async () => {
  const f = fixture(); f.park("expired"); const fresh = f.park("recent", {}, 10);
  const visits: string[] = [];
  const effects: DrainEffects = { readiness: async () => { visits.push("readiness"); return "busy:decision-unavailable"; },
    harness: async () => "codex", flash: async () => {}, repairOrphans: async () => {},
    redeliverLocked: async () => { throw new Error("unexpected delivery"); }, digest: async () => { throw new Error("unexpected digest"); } };
  expect(cleanupPark(f.ctx, "recent")).toBe("current");
  await drainOnce(f.ctx, effects);
  expect(existsSync(join(f.ctx.spoolDir, "expired.md"))).toBe(false);
  expect(existsSync(fresh.path)).toBe(true);
  expect(visits.length).toBe(2); // Phase A and B visit only the recent entry.
});

test("obligation/claim contention and reset fences preserve all custody", () => {
  for (const obstruction of ["obligation", "claim", "fence"]) {
    const f = fixture(), p = f.park("old");
    const lock = obstruction === "obligation" ? acquireObligationLock("old", 0, f.env) : null;
    if (obstruction === "obligation") expect(lock).not.toBeNull();
    if (obstruction === "claim") writeFileSync(join(f.ctx.spoolDir, "old.claim"), "held");
    if (obstruction === "fence") writeFileSync(join(f.home, "reset.fence.json"), "{}");
    try { expect(cleanupPark(f.ctx, "old")).toBe("busy"); }
    finally { lock?.release(); }
    expect(readFileSync(p.path, "utf8")).toBe(p.body);
    expect(existsSync(join(f.ctx.receiptsDir, "old.cancelled"))).toBe(false);
  }
});

test("conflicting canonical or preserved metadata and symlink bodies never lose evidence", () => {
  for (const obstruction of ["canonical", "metadata", "symlink"]) {
    const f = fixture(), p = f.park("old");
    if (obstruction === "canonical") writeFileSync(join(f.ctx.payloadsDir, "old.md"), "different original");
    if (obstruction === "metadata") { mkdirSync(join(f.home, "archive")); writeFileSync(join(f.home, "archive/old.meta.json"), "older evidence"); }
    if (obstruction === "symlink") { const external = join(f.root, "original"); writeFileSync(external, p.body); rmSync(p.path); symlinkSync(external, p.path); }
    expect(cleanupPark(f.ctx, "old")).toBe("held");
    expect(readFileSync(p.path, "utf8")).toBe(p.body);
    expect(existsSync(join(f.ctx.receiptsDir, "old.cancelled"))).toBe(false);
  }
});

test("daily file-only maintenance expires parks and archives old settled history without watch", () => {
  const f = fixture(); f.park("old");
  const old = new Date((f.now - 10 * 86400) * 1000);
  utimesSync(join(f.home, ".tap-bus-authority"), old, old);
  const path = join(f.ctx.payloadsDir, "settled-sample-abc123.md");
  writeFileSync(path, `---\nid: settled-sample-abc123\nfrom: sender\nto: peer\nkind: discuss\nreply: expected\npath: ${path}\n---\nhistory\n`); utimesSync(path, old, old);
  const receipt = join(f.ctx.receiptsDir, "settled-sample-abc123.done"); writeFileSync(receipt, JSON.stringify({ id: "settled-sample-abc123", at: old.toISOString() })); utimesSync(receipt, old, old);
  expect(maintenanceDue(f.home)).toBe(true);
  const result = runBusMaintenance(f.home, Date.now(), f.env);
  expect(result).toMatchObject({ status: "complete", expired: 1, archived: 1, held: 0 });
  expect(readFileSync(archivedPayload(f.home, "settled-sample-abc123"), "utf8")).toContain("history");
  expect(maintenanceDue(f.home)).toBe(false);
  expect(runBusMaintenance(f.home, Date.now(), f.env)).toBeNull();
  expect(archiveNudge(f.home)).toBe("");
});

test("failed maintenance never advances the success stamp and reports only actionable holds", () => {
  const f = fixture(), old = new Date(Date.now() - MAINTENANCE_INTERVAL_MS * 2);
  utimesSync(join(f.home, ".tap-bus-authority"), old, old);
  f.park("old"); writeFileSync(join(f.ctx.payloadsDir, "old.md"), "conflicting body");
  const result = runBusMaintenance(f.home, Date.now(), f.env);
  expect(result?.status).toBe("blocked");
  expect(existsSync(join(f.home, "maintenance.ok"))).toBe(false);
  expect(maintenanceReport(f.home)?.held).toBe(1);
  expect(archiveNudge(f.home)).toBe("bus has 1 parked payloads needing attention; run tap spool list");
  expect(runBusMaintenance(f.home, Date.now(), f.env)).toBeNull(); // failed-run backoff
});

test("archive respects an in-flight reader obligation", () => {
  const f = fixture(), p = join(f.ctx.payloadsDir, "settled-sample-abc123.md"), old = new Date(Date.now() - 10 * 86400000);
  writeFileSync(p, `---\nid: settled-sample-abc123\nfrom: sender\nto: peer\nkind: discuss\nreply: expected\npath: ${p}\n---\nhistory\n`); utimesSync(p, old, old);
  const r = join(f.ctx.receiptsDir, "settled-sample-abc123.done"); writeFileSync(r, JSON.stringify({ at: old.toISOString() })); utimesSync(r, old, old);
  // archiveBus uses process.env's lock root, as its ordinary CLI callers do.
  const lock = acquireObligationLock("settled-sample-abc123", 0); expect(lock).not.toBeNull();
  try { expect(archiveBus(f.home).retained_reasons.busy).toBe(1); expect(existsSync(p)).toBe(true); }
  finally { lock?.release(); }
  expect(archiveBus(f.home).archived).toBe(1);
});

test("a published expiry notice remains deduplicated after archival and a cleanup retry", () => {
  const f = fixture(); f.park("old"); mkdirSync(join(f.home,"archive"));
  const conflict=join(f.home,"archive/old.meta.json");writeFileSync(conflict,"conflicting evidence");
  expect(cleanupPark(f.ctx,"old")).toBe("held");
  const notice=join(f.ctx.payloadsDir,"old-park-expired.md"), bytes=readFileSync(notice);
  writeFileSync(join(f.ctx.receiptsDir,"old-park-expired.done"),JSON.stringify({at:new Date().toISOString()}));
  expect(archiveBus(f.home,7,false,Date.now()+10*86400000).archived).toBe(1);
  rmSync(conflict);
  expect(cleanupPark(f.ctx,"old")).toBe("expired");
  expect(existsSync(notice)).toBe(false);
  expect(readFileSync(archivedPayload(f.home,"old-park-expired"))).toEqual(bytes);
});

test("a directory at the withdrawal receipt never permits removal", () => {
  const f=fixture(),p=f.park("old");mkdirSync(join(f.ctx.receiptsDir,"old.cancelled"));
  expect(cleanupPark(f.ctx,"old")).toBe("held");
  expect(readFileSync(p.path,"utf8")).toBe(p.body);
});

test("an ordinary command starts detached maintenance on an aged bus without a watcher", async () => {
  const f=fixture();f.park("old");
  const age=new Date(Date.now()-2*MAINTENANCE_INTERVAL_MS);utimesSync(join(f.home,".tap-bus-authority"),age,age);
  const env={...f.env,TAP_BUS_MAINTENANCE_WORKER:undefined,TAP_ONBOARDING_CHECKED:"1",TAP_VERBOSE:"0"};
  const command=Bun.spawnSync([process.execPath,join(import.meta.dir,"../main.ts"),"team","--names"],{cwd:f.root,env});
  expect({status:command.exitCode,error:command.stderr.toString()}).toEqual({status:0,error:""});
  expect(command.stdout.toString()).toContain("sender");
  const deadline=Date.now()+10000;
  while(!existsSync(join(f.home,"maintenance.ok"))&&Date.now()<deadline)await Bun.sleep(20);
  expect(maintenanceReport(f.home)).toMatchObject({status:"complete",expired:1});
  expect(existsSync(join(f.ctx.spoolDir,"old.md"))).toBe(false);
  expect(existsSync(join(f.home,"watch/arm.json"))).toBe(false);
},15000);

for (const status of ["running","retry","blocked"] as const) test(`${status} maintenance suppresses foreground worker spawns before backoff expires`, () => {
  const f=fixture(),age=new Date(Date.now()-2*MAINTENANCE_INTERVAL_MS);
  utimesSync(join(f.home,".tap-bus-authority"),age,age);
  const report={at:Date.now(),status,expired:0,reconciled:0,held:0,archived:0,error:""};
  writeFileSync(join(f.home,"maintenance.json"),JSON.stringify(report));
  const env={...f.env,TAP_BUS_MAINTENANCE_WORKER:undefined};let spawned=0;
  for(let i=0;i<5;i++)maybeStartBusMaintenance(f.home,env,false,()=>{spawned++;});
  expect(spawned).toBe(0);
  writeFileSync(join(f.home,"maintenance.json"),JSON.stringify({...report,at:Date.now()-MAINTENANCE_RETRY_MS-1}));
  maybeStartBusMaintenance(f.home,env,false,()=>{spawned++;});
  expect(spawned).toBe(1);
});

test("a proven departed sender gets an event instead of an unsettled notice", () => {
  const f=fixture(),p=f.park("old");
  writeFileSync(f.registry,JSON.stringify({schema:"0.20",team:{name:"fixture"},seats:{}}));
  expect(cleanupPark(f.ctx,"old")).toBe("expired");
  expect(existsSync(join(f.ctx.payloadsDir,"old-park-expired.md"))).toBe(false);
  expect(readFileSync(f.ctx.eventLog,"utf8")).toContain("notice=sender_absent");
  expect(archiveBus(f.home,7,false,Date.now()+10*86400000).archived).toBe(1);
  expect(readFileSync(archivedPayload(f.home,"old"),"utf8")).toBe(p.body);
});

test("an incomplete park with no resolvable registry surfaces for inspection", () => {
  const f=fixture(),p=f.park("old"),age=new Date(Date.now()-2*MAINTENANCE_INTERVAL_MS);
  rmSync(join(f.ctx.spoolDir,"old.meta.json"));rmSync(join(f.index,"global-registry.json"));
  utimesSync(join(f.home,".tap-bus-authority"),age,age);
  const report=runBusMaintenance(f.home,Date.now(),f.env);
  expect(report).toMatchObject({status:"blocked",held:1});
  expect(archiveNudge(f.home)).toContain("1 parked payloads needing attention");
  expect(readFileSync(p.path,"utf8")).toBe(p.body);
});

test("new expiry notices are bounded per drain pass, while deferred expiry never delivers", async () => {
  const f=fixture();for(let i=0;i<=MAX_PARK_NOTICES_PER_PASS;i++)f.park(`expired-${i}`);
  const forbidden=async()=>{throw new Error("expired custody reached a pane entrance");};
  const effects:DrainEffects={readiness:forbidden,harness:forbidden,flash:forbidden,repairOrphans:async()=>{},redeliverLocked:forbidden,digest:forbidden};
  await drainOnce(f.ctx,effects);
  const notices=()=>readdirSync(f.ctx.payloadsDir).filter(n=>n.endsWith("-park-expired.md")).length;
  expect(notices()).toBe(MAX_PARK_NOTICES_PER_PASS);
  expect(readdirSync(f.ctx.spoolDir).filter(n=>n.endsWith(".md"))).toHaveLength(1);
  await drainOnce(f.ctx,effects);
  expect(notices()).toBe(MAX_PARK_NOTICES_PER_PASS+1);
  expect(readdirSync(f.ctx.spoolDir).filter(n=>n.endsWith(".md"))).toEqual([]);
});
