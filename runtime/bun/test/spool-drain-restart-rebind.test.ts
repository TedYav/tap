// tap-03rfq: mail parked for a seat must not stay parked forever after the seat
// restarts. `tap session restart` keeps the row's instance and moves it to a new
// pane, so the retirement path never fires and the parked binding names a pane
// the seat no longer owns.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainOnce, type DrainContext, type DrainEffects } from "../src/spool-drain";
import { boundPaneIdentityState } from "../src/observe-gather";
import { terminalize } from "../src/spool-deadline";
import { removeScratchTree } from "./support/scratch";
import { restartNoticeId } from "../src/spool-rebind";
import { validId } from "../src/ids";

const NOW = 1788625000;
const iso = (epoch: number) => new Date(epoch * 1000).toISOString().replace(".000Z", "Z");
// Parks land at NOW-100; a restart re-registers the row afterwards (it stamps registered_at).
const PARKED = NOW - 100, RESTARTED = iso(NOW - 50);

interface Park { id: string; instance?: string; attempts?: number; attempted?: boolean; deadline?: number; escalated?: string; reasonClass?: string; deadlineSource?: string }
interface Seat { instance: string; paneId: string; pane?: string; status?: string; registeredAt?: string }

function world(seat: Seat, parks: Park[], others: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), "drain-restart-rebind-"));
  const registry = join(home, "registry.json"), spool = join(home, "spool");
  for (const dir of ["spool", "payloads", "receipts", "locks"]) mkdirSync(join(home, dir));
  writeFileSync(join(home, ".tap-bus-authority"), "");
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture" }, seats: {
    sender: { instance: "sender|1", registered_at: "2026-09-07T11:00:00Z", status: "active", pane: "s:0.0", pane_id: "%2", server_epoch: "e1" },
    peer: { instance: seat.instance, registered_at: seat.registeredAt ?? RESTARTED, status: seat.status ?? "active", pane: seat.pane ?? "peer:0.0",
      pane_id: seat.paneId, server_epoch: "e1", harness: "codex" },
    ...others,
  } }));
  for (const park of parks) {
    const instance = park.instance ?? "peer|same";
    writeFileSync(join(spool, `${park.id}.md`), `---\nid: ${park.id}\nfrom: sender\nto: peer\nkind: discuss\nreply: expected\npath: ${home}/payloads/${park.id}.md\n`
      + `${instance ? `recipient_instance: ${instance}\n` : ""}sender_instance: sender|1\n---\nbody ${park.id}\n`);
    writeFileSync(join(spool, `${park.id}.meta.json`), JSON.stringify({ id: park.id, target: "peer", pane: "peer:0.0", pane_id: "%69",
      to_team: "fixture", target_registry: registry, policy: "standard", first_spooled_epoch: PARKED, hold_until_epoch: PARKED,
      deadline_epoch: park.deadline ?? NOW + 200, reason: "booting", reason_class: park.reasonClass ?? "busy",
      deadline_source: park.deadlineSource ?? "readiness-gate", attempts: park.attempts ?? 0, attempt_fence: 1, held_drain_visits: 0,
      ...(park.escalated ? { escalated_at: park.escalated } : {}) }));
    if (park.attempted) writeFileSync(join(home, "receipts", `${park.id}.attempted`), "{}\n");
  }
  const env: NodeJS.ProcessEnv = { ...process.env, TAP_HOME: home, TAP_LOCK_DIR: join(home, "locks"), TAP_SPOOL_DRAIN_ACTIVE: "0",
    TAP_SPOOL_DISABLE_DELIVERER: "1", TAP_SPOOL_HUMAN_ALERT: undefined };
  const ctx: DrainContext = { home, spoolDir: spool, payloadsDir: join(home, "payloads"), receiptsDir: join(home, "receipts"),
    eventLog: join(home, "registry-events.log"), team: "fixture", actingRegistry: registry, verbLabel: "tap",
    scriptsDir: join(import.meta.dir, "../../../skills/tap/scripts"), courierIdentity: "courier", alert: { mode: "none" },
    now: NOW, unroutedGrace: 1800, env };
  const probes: string[] = [], deliveries: string[] = [];
  // Production readiness reads the bound identity first (readinessWalk: anything
  // but "match" is gone). This runs the production row legs; without the native
  // router it stops at "harness_unobservable" once every row leg has passed,
  // which here stands for the live-pane match.
  const fx: DrainEffects = {
    readiness: async row => {
      probes.push(`${row.target}@${row.paneId}`);
      return boundPaneIdentityState(row.targetRegistry, row.target, row.pane, row.paneId, env, false) === "harness_unobservable" ? "ready" : "gone";
    },
    harness: async () => "codex", flash: async () => {}, repairOrphans: async () => {},
    redeliverLocked: async (id, binding) => { deliveries.push(`${id}@${binding.paneId}`); return 1; },
    digest: async (binding, ids) => { deliveries.push(...ids.map(id => `${id}@${binding.paneId}`)); return 1; },
  };
  const meta = (id: string) => existsSync(join(spool, `${id}.meta.json`)) ? JSON.parse(readFileSync(join(spool, `${id}.meta.json`), "utf8")) : null;
  const payloads = () => readdirSync(join(home, "payloads")).sort();
  return { home, spool, registry, ctx, fx, probes, deliveries, meta, payloads };
}

test("a park for a restarted seat re-binds to the seat's current pane and delivers there", async () => {
  const w = world({ instance: "peer|same", paneId: "%87" }, [{ id: "p1" }]);
  try {
    expect(await drainOnce(w.ctx, w.fx)).toBe(0);
    expect(w.deliveries).toEqual(["p1@%87"]);
    expect(w.meta("p1")).toMatchObject({ pane: "peer:0.0", pane_id: "%87", attempts: 1, attempt_fence: 1 });
    expect(readFileSync(w.ctx.eventLog, "utf8")).toContain("spool_rebound_restarted_seat");
  } finally { removeScratchTree(w.home); }
});

test("two parks for a restarted seat re-bind before the digest plan, so the digest targets the new pane", async () => {
  const w = world({ instance: "peer|same", paneId: "%87" }, [{ id: "p1" }, { id: "p2" }]);
  try {
    expect(await drainOnce(w.ctx, w.fx)).toBe(0);
    expect(w.deliveries.sort()).toEqual(["p1@%87", "p2@%87"]);
    expect(w.probes).not.toContain("peer@%69");
  } finally { removeScratchTree(w.home); }
});

test("a park with a recorded attempt is never typed into the new pane; it terminalizes with an unconfirmed notice", async () => {
  const w = world({ instance: "peer|same", paneId: "%87" }, [{ id: "p1", attempts: 1, attempted: true }]);
  try {
    expect(await drainOnce(w.ctx, w.fx)).toBe(0);
    expect(w.deliveries).toEqual([]);
    expect(w.meta("p1")).toBeNull();
    expect(existsSync(join(w.spool, "p1.md"))).toBe(false);
    const payloads = w.payloads();
    expect(payloads).toContain("p1.md");
    const notices = payloads.filter(name => name !== "p1.md").map(name => readFileSync(join(w.home, "payloads", name), "utf8"));
    expect(notices.some(text => /kind: delivery-failed/.test(text) && /to: sender/.test(text) && text.includes("p1"))).toBe(true);
  } finally { removeScratchTree(w.home); }
});

test("an attempt count without a receipt still refuses the re-bind (no effect cannot be proved)", async () => {
  const w = world({ instance: "peer|same", paneId: "%87" }, [{ id: "p1", attempts: 2 }]);
  try {
    expect(await drainOnce(w.ctx, w.fx)).toBe(0);
    expect(w.deliveries).toEqual([]);
    expect(w.meta("p1")).toBeNull();
    expect(w.payloads()).toContain("p1.md");
  } finally { removeScratchTree(w.home); }
});

test("a new instance on the reused handle, on a new pane id, is withdrawn by retirement and never receives the park", async () => {
  const w = world({ instance: "peer|other", paneId: "%87" }, [{ id: "p1" }]);
  try {
    expect(await drainOnce(w.ctx, w.fx)).toBe(0);
    expect(w.deliveries).toEqual([]);
    expect(w.meta("p1")).toBeNull();
    expect(JSON.parse(readFileSync(join(w.home, "receipts", "p1.cancelled"), "utf8"))).toMatchObject({ reason: "instance_retired" });
    expect(existsSync(w.ctx.eventLog) && readFileSync(w.ctx.eventLog, "utf8").includes("spool_rebound_restarted_seat")).toBe(false);
  } finally { removeScratchTree(w.home); }
});

test("a new instance on the reused handle that also reuses the old pane id is withdrawn, never delivered", async () => {
  const w = world({ instance: "peer|other", paneId: "%69" }, [{ id: "p1" }]);
  try {
    expect(await drainOnce(w.ctx, w.fx)).toBe(0);
    expect(w.deliveries).toEqual([]);
    expect(JSON.parse(readFileSync(join(w.home, "receipts", "p1.cancelled"), "utf8"))).toMatchObject({ reason: "instance_retired" });
  } finally { removeScratchTree(w.home); }
});

test("a different seat now holding the old pane id never receives the park", async () => {
  // The target went inactive; a stranger occupies the same pane spelling and pane id.
  const stranger = { instance: "stranger|1", registered_at: RESTARTED, status: "active", pane: "peer:0.0", pane_id: "%69", server_epoch: "e1", harness: "codex" };
  const w = world({ instance: "peer|same", paneId: "%87", status: "inactive" }, [{ id: "p1" }], { stranger });
  try {
    expect(await drainOnce(w.ctx, w.fx)).toBe(0);
    expect(w.deliveries).toEqual([]);
    expect(w.meta("p1")).toMatchObject({ pane_id: "%69", attempts: 0 });
  } finally { removeScratchTree(w.home); }
});

test("a restart still in flight (pending row with no pane) holds the park untouched", async () => {
  const w = world({ instance: "peer|same", paneId: "", pane: "", status: "pending" }, [{ id: "p1" }]);
  try {
    await drainOnce(w.ctx, w.fx);
    expect(w.deliveries).toEqual([]);
    expect(w.meta("p1")).toMatchObject({ pane_id: "%69", attempts: 0 });
  } finally { removeScratchTree(w.home); }
});

test("an unstamped park (no recipient instance) cannot prove the seat; it terminalizes with a notice, never delivers", async () => {
  const w = world({ instance: "peer|same", paneId: "%87" }, [{ id: "p1", instance: "" }]);
  try {
    await drainOnce(w.ctx, w.fx);
    expect(w.deliveries).toEqual([]);
    expect(w.meta("p1")).toBeNull();
    expect(w.payloads()).toContain("p1.md");
  } finally { removeScratchTree(w.home); }
});

test("an escalated park is not resurrected by a re-bind", async () => {
  const w = world({ instance: "peer|same", paneId: "%87" }, [{ id: "p1", escalated: "2026-09-07T12:00:00Z", reasonClass: "window", deadlineSource: "" }]);
  try {
    await drainOnce(w.ctx, w.fx);
    expect(w.deliveries).toEqual([]);
    expect(w.meta("p1")).toMatchObject({ pane_id: "%69" });
  } finally { removeScratchTree(w.home); }
});

test("a poll-delivered sender still gets a durable notice before the park is promoted", async () => {
  const w = world({ instance: "peer|same", paneId: "%87" }, [{ id: "p1", attempts: 1, attempted: true }]);
  try {
    const doc = JSON.parse(readFileSync(w.registry, "utf8"));
    doc.seats.sender = { ...doc.seats.sender, delivery: "poll" };
    writeFileSync(w.registry, JSON.stringify(doc));
    expect(await drainOnce(w.ctx, w.fx)).toBe(0);
    expect(w.deliveries).toEqual([]);
    expect(w.meta("p1")).toBeNull();
    const notice = readFileSync(join(w.home, "payloads", "p1-seat-restarted.md"), "utf8");
    expect(notice).toMatch(/^to: sender$/m);
    expect(notice).toContain("DELIVERY UNCONFIRMED: p1 to peer may or may not have reached them.");
  } finally { removeScratchTree(w.home); }
});

test("a notice that cannot publish keeps the park in the spool for the next pass", async () => {
  const w = world({ instance: "peer|same", paneId: "%87" }, [{ id: "p1", attempts: 1, attempted: true }]);
  try {
    // Something else already owns the notice's deterministic path: publication refuses.
    writeFileSync(join(w.home, "payloads", "p1-seat-restarted.md"), "---\nid: p1-seat-restarted\nfrom: someone\nto: sender\n---\nnot ours\n");
    expect(await drainOnce(w.ctx, w.fx)).toBe(0);
    expect(w.deliveries).toEqual([]);
    expect(w.meta("p1")).toMatchObject({ pane_id: "%69" });
    expect(readFileSync(join(w.spool, "p1.md"), "utf8")).toContain("body p1");
    expect(existsSync(join(w.home, "payloads", "p1.md"))).toBe(false);
  } finally { removeScratchTree(w.home); }
});

test("a conflicting canonical copy holds the park: the original body is never discarded and no notice is sent", async () => {
  const w = world({ instance: "peer|same", paneId: "%87" }, [{ id: "p1", attempts: 1, attempted: true }]);
  try {
    writeFileSync(join(w.home, "payloads", "p1.md"), "CONFLICTING BODY\n");
    expect(await drainOnce(w.ctx, w.fx)).toBe(0);
    expect(w.deliveries).toEqual([]);
    expect(readFileSync(join(w.spool, "p1.md"), "utf8")).toContain("body p1");
    expect(w.meta("p1")).toMatchObject({ pane_id: "%69" });
    expect(readFileSync(join(w.home, "payloads", "p1.md"), "utf8")).toBe("CONFLICTING BODY\n");
    expect(existsSync(join(w.home, "payloads", "p1-seat-restarted.md"))).toBe(false);
  } finally { removeScratchTree(w.home); }
});

test("an unstamped park's never-attempted notice is durable and found again on retry", async () => {
  const w = world({ instance: "peer|same", paneId: "%87" }, [{ id: "p1", instance: "" }]);
  try {
    expect(await drainOnce(w.ctx, w.fx)).toBe(0);
    expect(readFileSync(join(w.home, "payloads", "p1-seat-restarted.md"), "utf8")).toContain("NOT DELIVERED: p1 to peer was never attempted.");
    expect(w.meta("p1")).toBeNull();
  } finally { removeScratchTree(w.home); }
});

test("a 239-byte accepted id whose suffixed notice name would pass 255 bytes uses the hashed fallback and terminalizes", async () => {
  const id = `s-${"a".repeat(237)}`;
  expect(Buffer.byteLength(id)).toBe(239);
  expect(validId(id)).toBe(true);
  expect(restartNoticeId("p1", "x")).toBe("p1-seat-restarted");
  const w = world({ instance: "peer|same", paneId: "%87" }, [{ id, attempts: 1, attempted: true }]);
  try {
    const notice = restartNoticeId(id, readFileSync(join(w.spool, `${id}.md`), "utf8"));
    expect(await drainOnce(w.ctx, w.fx)).toBe(0);
    expect(w.deliveries).toEqual([]);
    expect(w.meta(id)).toBeNull();
    expect(existsSync(join(w.home, "payloads", `${id}.md`))).toBe(true);
    expect(notice).toMatch(/^seat-restarted-[0-9a-f]{64}$/);
    expect(validId(notice)).toBe(true);
    expect(readFileSync(join(w.home, "payloads", `${notice}.md`), "utf8")).toContain(`DELIVERY UNCONFIRMED: ${id} to peer`);
  } finally { removeScratchTree(w.home); }
});

test("an old-format target registry authorizes no re-bind: the park is left as it is", async () => {
  const w = world({ instance: "peer|same", paneId: "%87" }, [{ id: "p1" }]);
  try {
    const doc = JSON.parse(readFileSync(w.registry, "utf8"));
    doc.agents = {};
    writeFileSync(w.registry, JSON.stringify(doc));
    await drainOnce(w.ctx, w.fx);
    expect(w.deliveries).toEqual([]);
    expect(w.meta("p1")).toMatchObject({ pane_id: "%69", attempts: 0 });
    expect(existsSync(join(w.home, "payloads", "p1-seat-restarted.md"))).toBe(false);
  } finally { removeScratchTree(w.home); }
});

test("a terminal decision that no longer stands under the promotion's custody holds the park", async () => {
  const w = world({ instance: "peer|same", paneId: "%87" }, [{ id: "p1", attempts: 1, attempted: true }]);
  try {
    expect(await terminalize(w.ctx, "p1", "peer", "peer:0.0", "seat_restarted", "spool_terminal_seat_restarted",
      { requireSameCanonical: true, precondition: () => false })).toBe(false);
    expect(w.meta("p1")).toMatchObject({ pane_id: "%69" });
    expect(readFileSync(join(w.spool, "p1.md"), "utf8")).toContain("body p1");
    expect(existsSync(join(w.home, "payloads", "p1.md"))).toBe(false);
  } finally { removeScratchTree(w.home); }
});
