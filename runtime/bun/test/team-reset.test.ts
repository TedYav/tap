import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/bus";
import { acquirePathLock } from "../src/panelock";
import { acquireResetFence, releaseResetFence } from "../src/reset";
import { TapError, type ResolvedContext } from "../src/context";
import { runReset, parseResetOptions } from "../src/team/reset";
import { runRestore, parseRestoreOptions } from "../src/team/restore";
import { actingPath, componentTable, readObject } from "../src/team/reset-components";
import type { StopEffects } from "../src/team/stop";

function fixture(body: (f: { ctx: ResolvedContext; root: string; effects: StopEffects; archive(): string }) => void, relocated: boolean | "bus" = false): void {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "team-reset-"));
  const bus = new Bus(join(root, ".tap", "bus")), index = join(root, "index");
  mkdirSync(bus.home, { recursive: true }); mkdirSync(index);
  const registry = relocated === "bus" ? join(bus.home, "registry.json")
    : relocated ? join(root, "custom", "roster.json") : join(root, ".tap", "team-registry.json");
  mkdirSync(join(root, "custom"));
  const previous = { TAP_INDEX_HOME: process.env.TAP_INDEX_HOME, TAP_HOME: process.env.TAP_HOME,
    TAP_SCRATCH_ONLY: process.env.TAP_SCRATCH_ONLY, TAP_BOOT_ID: process.env.TAP_BOOT_ID };
  Object.assign(process.env, { TAP_INDEX_HOME: index, TAP_HOME: bus.home, TAP_SCRATCH_ONLY: root, TAP_BOOT_ID: "boot:100" });
  const ctx: ResolvedContext = { bus, root, registryPath: registry, team: "demo", marker: "live", busRule: "env" };
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "demo" }, seats: {
    poller: { delivery: "poll", status: "active", pane_id: "%9", pane: "old", wake_url: "old" },
  } }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { demo: { root, registry_location: registry } } }));
  for (const dir of ["payloads", "receipts", "spool", "input-backups", "tmp", "locks"]) mkdirSync(join(bus.home, dir));
  writeFileSync(join(bus.payloadsDir, "message.md"), "from: other\nto: poller\n");
  writeFileSync(join(bus.home, "locks", "keep.lock"), "held inode");
  writeFileSync(join(bus.home, "tmp", "scratch"), "discard");
  writeFileSync(join(bus.home, ".tap-bus-authority"), "existing authority");
  const effects: StopEffects = {
    tmux: { hasSession: () => false, paneSession: () => null, sessionPaneIds: () => [] },
    killSession: () => { throw new Error("unexpected kill"); }, hasSession: () => false, paneCount: () => 0,
    observeSpare: () => null, queueSummary: () => ({ unsettled: 0, counts: new Map() }),
    watch: { isArmed: () => false, clearTints: () => {}, disarm: () => {} },
    identity: { tmuxActive: false, callingPaneId: "", selfRefusal: "", resolveSelf: () => null, displaySession: () => "" },
    runId: "test", eventLog: join(bus.home, "registry-events.log"), io: { stdout: () => {}, stderr: () => {}, warn: () => {} },
  };
  try { body({ ctx, root, effects, archive: () => join(bus.home, "archive", "team-reset", readdirSync(join(bus.home, "archive", "team-reset"))[0]!) }); }
  finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
const reset = parseResetOptions(["--json"]), restore = parseRestoreOptions(["--json"]);
const noSessions = () => ({ observable: true as const, names: new Set<string>() });
function refused(body: () => unknown, klass: string): void {
  let caught: unknown;
  try { body(); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(TapError);
  expect((caught as TapError).errorClass).toBe(klass);
}
function deadFence(ctx: ResolvedContext, bundle: string, op: string): void {
  writeFileSync(join(ctx.bus.home, "reset.fence.json"), JSON.stringify({ pid: 2147483647, owner_start: "1", boot_id: "boot:100",
    token: "dead", bundle_id: bundle.split("/").at(-1), op, phase: op === "team-reset" ? "cutting" : "restoring" }));
}

for (const relocated of [false, true, "bus"] as const) test(`reset/restore preserves checkpoint data, poll identity and lock inodes (relocated=${relocated})`, () => fixture(f => {
  const { ctx, effects } = f, lock = join(ctx.bus.home, "locks", "keep.lock"), inode = statSync(lock).ino;
  const payload = readFileSync(join(ctx.bus.payloadsDir, "message.md"), "utf8");
  expect(runReset(ctx, reset, effects)).toBe(0);
  const archive = f.archive();
  expect(existsSync(join(archive, "COMPLETE"))).toBe(true);
  expect(readFileSync(join(archive, "bus", "payloads", "message.md"), "utf8")).toBe(payload);
  expect(readObject(actingPath(ctx)).seats).toEqual({});
  expect(statSync(lock).ino).toBe(inode);
  expect(existsSync(join(ctx.bus.home, "tmp", "scratch"))).toBe(false);
  expect(readFileSync(join(ctx.bus.home, ".tap-bus-authority"), "utf8")).toBe("existing authority");
  expect(runRestore(ctx, restore, noSessions)).toBe(0);
  const rows = readObject(ctx.registryPath).seats as Record<string, unknown>;
  expect(rows.poller).toEqual({ delivery: "poll", status: "suspended", status_reason: "restored_from_archive" });
  expect(readFileSync(join(ctx.bus.payloadsDir, "message.md"), "utf8")).toBe(payload);
  expect(readObject(join(ctx.bus.home, "reset-generation.json")).state).toBe("reused");
  refused(() => runRestore(ctx, restore, noSessions), "already_restored");
  refused(() => runRestore(ctx, { ...restore, again: true }, noSessions), "generation_reused");
}, relocated));

test("dry-run and unknown component refusal leave the bus untouched", () => fixture(f => {
  const { ctx, effects } = f;
  const before = readdirSync(ctx.bus.home).sort(), registry = readFileSync(ctx.registryPath, "utf8");
  expect(runReset(ctx, { ...reset, dryRun: true }, effects)).toBe(0);
  expect(readdirSync(ctx.bus.home).sort()).toEqual(before);
  expect(readFileSync(ctx.registryPath, "utf8")).toBe(registry);
  writeFileSync(join(ctx.bus.home, "review-pr155-ponytail.md"), "unknown");
  refused(() => runReset(ctx, reset, effects), "unclassified_component");
  expect(existsSync(join(ctx.bus.home, "archive"))).toBe(false);
}));

// `tap bus archive` leaves archive.lock behind for good. It is a persistent lock
// inode beside a preserved archive, the same class as registry-events.log.lock
// and locks/: reset must neither refuse it nor unlink an inode a live archiver
// may hold (tap-vne2e).
test("a bus that has been archived resets: archive.lock is preserved, not unclassified", () => fixture(f => {
  const { ctx, effects } = f, lock = join(ctx.bus.home, "archive.lock");
  writeFileSync(lock, "");
  const inode = statSync(lock).ino;
  expect(runReset(ctx, { ...reset, dryRun: true }, effects)).toBe(0);
  expect(existsSync(join(ctx.bus.home, "archive"))).toBe(false);
  expect(runReset(ctx, reset, effects)).toBe(0);
  expect(statSync(lock).ino).toBe(inode);
  expect(existsSync(join(f.archive(), "COMPLETE"))).toBe(true);
  expect(existsSync(join(f.archive(), "bus", "archive.lock"))).toBe(false);
}));

// The archiver takes archive.lock with no wait; reset takes it the same way before it
// writes its fence, so a live archiver refuses reset before any effect.
test("reset refuses while a bus archive job holds archive.lock, then succeeds once it is released", () => fixture(f => {
  const { ctx, effects } = f, lock = acquirePathLock(join(ctx.bus.home, "archive.lock"), 0);
  expect(lock).not.toBeNull();
  const stopped: string[] = [];
  const watched = { ...effects, killSession: (name: string) => { stopped.push(name); return true; } };
  try {
    refused(() => runReset(ctx, reset, watched), "archive_active");
    expect(existsSync(join(ctx.bus.home, "reset.fence.json"))).toBe(false);
    expect(existsSync(join(ctx.bus.home, "archive", "team-reset"))).toBe(false);
    expect(existsSync(join(ctx.bus.payloadsDir, "message.md"))).toBe(true);
    expect(stopped).toEqual([]);
    // A dry-run resolves and refuses exactly as the real run does (CLI-STANDARDS), without keeping the lock.
    refused(() => runReset(ctx, { ...reset, dryRun: true }, watched), "archive_active");
  } finally { lock!.release(); }
  expect(runReset(ctx, { ...reset, dryRun: true }, watched)).toBe(0);
  expect(runReset(ctx, reset, watched)).toBe(0);
  // Reset released the lock at the end of the cut: an archiver can take it again.
  const again = acquirePathLock(join(ctx.bus.home, "archive.lock"), 0);
  expect(again).not.toBeNull();
  again!.release();
}));

// A second reset that reaches archive.lock while another RESET holds it through its cut is contention
// between resets, not an archiver: it gets the fence's own refusal.
test("a held archive.lock under a live reset fence is reset contention, not an archive job", () => fixture(f => {
  const { ctx, effects } = f, bus = ctx.bus.home;
  const token = acquireResetFence(bus, String(process.pid), "20260930T000000Z-1");
  const lock = acquirePathLock(join(bus, "archive.lock"), 0);
  expect(lock).not.toBeNull();
  try {
    refused(() => runReset(ctx, reset, effects), "reset_in_progress");
    refused(() => runReset(ctx, { ...reset, dryRun: true }, effects), "reset_in_progress");
  } finally { lock!.release(); releaseResetFence(bus, token); }
}));

test("a refused stop preserves traffic and removes only its incomplete checkpoint", () => fixture(f => {
  const { ctx, effects } = f;
  const doc = readObject(ctx.registryPath);
  doc.seats = { unverified: { delivery: "pane", status: "active" } };
  writeFileSync(ctx.registryPath, JSON.stringify(doc));
  refused(() => runReset(ctx, reset, effects), "session_stop_refused");
  expect(existsSync(join(ctx.bus.payloadsDir, "message.md"))).toBe(true);
  expect(existsSync(join(ctx.bus.home, "reset.fence.json"))).toBe(false);
  expect(readdirSync(join(ctx.bus.home, "archive", "team-reset"))).toEqual([]);
}));

test("invalid optional generation metadata cannot abort reset after stopping", () => {
  for (const bytes of ["{broken", "[]", "null", "42"]) fixture(f => {
    writeFileSync(join(f.ctx.bus.home, "reset-generation.json"), bytes);
    expect(runReset(f.ctx, reset, f.effects)).toBe(0);
    expect(existsSync(join(f.archive(), "COMPLETE"))).toBe(true);
    expect(readObject(join(f.archive(), "meta.json")).prior_reset_generation).toBeNull();
    expect(existsSync(join(f.ctx.bus.home, "reset.fence.json"))).toBe(false);
  });
});

test("reset snapshots prior generation metadata before stop-side effects", () => fixture(f => {
  const path = join(f.ctx.bus.home, "reset-generation.json");
  const prior = { state: "reused", bundle_id: "earlier-checkpoint" };
  writeFileSync(path, JSON.stringify(prior));
  f.effects.watch.clearTints = () => writeFileSync(path, "changed after stop");
  expect(runReset(f.ctx, reset, f.effects)).toBe(0);
  expect(readObject(join(f.archive(), "meta.json")).prior_reset_generation).toEqual(prior);
}));

test("a live clear fence refuses before stop; an expired fence is discarded, not archived", () => fixture(f => {
  const directory = join(f.ctx.bus.home, "clear-fence"), path = join(directory, "midclear.json");
  mkdirSync(directory);
  writeFileSync(path, JSON.stringify({ since_epoch: Date.now() / 1000, ceiling_seconds: 90 }));
  refused(() => runReset(f.ctx, reset, f.effects), "clear_in_flight");
  expect(existsSync(join(f.ctx.bus.home, "archive"))).toBe(false);
  writeFileSync(path, JSON.stringify({ since_epoch: 1, ceiling_seconds: 90 }));
  expect(runReset(f.ctx, reset, f.effects)).toBe(0);
  expect(readdirSync(directory)).toEqual([]);
  expect(existsSync(join(f.archive(), "bus", "clear-fence"))).toBe(false);
}));

test("reset resumes a dead-owner COMPLETE cut without creating another checkpoint", () => fixture(f => {
  runReset(f.ctx, reset, f.effects);
  const archive = f.archive(), original = readFileSync(join(archive, "bus", "payloads", "message.md"), "utf8");
  writeFileSync(join(f.ctx.bus.payloadsDir, "partial.md"), "uncut residue");
  deadFence(f.ctx, archive, "team-reset");
  expect(runReset(f.ctx, reset, f.effects)).toBe(0);
  expect(readdirSync(join(f.ctx.bus.home, "archive", "team-reset"))).toHaveLength(1);
  expect(readdirSync(f.ctx.bus.payloadsDir)).toEqual([]);
  expect(readFileSync(join(archive, "bus", "payloads", "message.md"), "utf8")).toBe(original);
}));

test("restore rejects escaped archives and an incomplete inventory before mutation", () => fixture(f => {
  runReset(f.ctx, reset, f.effects);
  const archive = f.archive(), outside = join(f.root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(f.ctx.bus.home, "archive", "team-reset", "escape"));
  refused(() => runRestore(f.ctx, { ...restore, archive: "escape" }, noSessions), "archive_escape");
  const inventory = readObject(join(archive, "inventory.json"));
  (inventory.components as unknown[]).pop();
  writeFileSync(join(archive, "inventory.json"), JSON.stringify(inventory));
  refused(() => runRestore(f.ctx, { ...restore, archive }, noSessions), "inventory_mismatch");
  expect(existsSync(join(f.ctx.bus.home, "reset.fence.json"))).toBe(false);
  expect(readdirSync(f.ctx.bus.payloadsDir)).toEqual([]);
}));

test("restore refuses an old-format checkpoint registry before publishing anything", () => fixture(f => {
  const { ctx, effects } = f;
  expect(runReset(ctx, reset, effects)).toBe(0);
  const archived = join(f.archive(), "bus", "team-registry.json");
  const old = JSON.stringify({ team: { name: "demo" }, agents: { poller: { delivery: "poll" } } });
  writeFileSync(archived, old);
  const live = readFileSync(actingPath(ctx), "utf8");
  refused(() => runRestore(ctx, restore, noSessions), "old_store");
  expect(readFileSync(archived, "utf8")).toBe(old);
  expect(readFileSync(actingPath(ctx), "utf8")).toBe(live);
  expect(existsSync(join(ctx.bus.home, "reset.fence.json"))).toBe(false);
}));

test("restore takes a team-less current checkpoint and refuses a schema-less one before publishing", () => fixture(f => {
  const { ctx, effects } = f;
  expect(runReset(ctx, reset, effects)).toBe(0);
  const archived = join(f.archive(), "bus", "team-registry.json");
  const { team: _team, ...teamless } = readObject(archived);
  const { schema: _schema, ...schemaless } = readObject(archived);
  writeFileSync(archived, JSON.stringify(schemaless));
  const live = readFileSync(actingPath(ctx), "utf8");
  refused(() => runRestore(ctx, restore, noSessions), "old_store");
  expect(readFileSync(actingPath(ctx), "utf8")).toBe(live);
  expect(existsSync(join(ctx.bus.home, "reset.fence.json"))).toBe(false);
  writeFileSync(archived, JSON.stringify(teamless));
  expect(runRestore(ctx, restore, noSessions)).toBe(0);
  expect(readObject(actingPath(ctx)).schema).toBe("0.20");
}));

test("reset refuses an old-format live registry before any effect", () => fixture(f => {
  const { ctx, effects } = f;
  const old = JSON.stringify({ team: { name: "demo" }, agents: {} });
  writeFileSync(actingPath(ctx), old);
  refused(() => runReset(ctx, reset, effects), "old_store");
  expect(readFileSync(actingPath(ctx), "utf8")).toBe(old);
  expect(existsSync(join(ctx.bus.home, "reset.fence.json"))).toBe(false);
  expect(existsSync(join(ctx.bus.home, "archive", "team-reset"))).toBe(false);
}));

test("restore refuses a dangling checkpoint registry link before publishing anything", () => fixture(f => {
  const { ctx, effects } = f;
  expect(runReset(ctx, reset, effects)).toBe(0);
  const archive = f.archive(), archived = join(archive, "bus", "team-registry.json");
  unlinkSync(archived);
  symlinkSync(join(f.root, "absent-registry"), archived);
  // Keep the inventory consistent: a link counts as zero regular files.
  const path = join(archive, "inventory.json"), inventory = readObject(path);
  const rows = inventory.components as Array<{ name: string; files: number }>;
  rows.find(row => row.name === "team-registry.json")!.files = 0;
  writeFileSync(path, JSON.stringify(inventory));
  const live = readFileSync(actingPath(ctx), "utf8");
  refused(() => runRestore(ctx, restore, noSessions), "archive_invalid");
  expect(readlinkSync(archived)).toBe(join(f.root, "absent-registry"));
  expect(readFileSync(actingPath(ctx), "utf8")).toBe(live);
  expect(existsSync(join(ctx.bus.home, "reset.fence.json"))).toBe(false);
}));

test("restore never replaces a live registry that still carries an agents map", () => fixture(f => {
  const { ctx, effects } = f;
  expect(runReset(ctx, reset, effects)).toBe(0);
  const live = actingPath(ctx), generation = join(ctx.bus.home, "reset-generation.json");
  const archived = join(f.archive(), "bus", "team-registry.json"), archivedBytes = readFileSync(archived, "utf8");
  const hybrid = JSON.stringify({ ...readObject(live), seats: {}, agents: { occupied: { delivery: "poll" } } });
  writeFileSync(live, hybrid);
  const generationBytes = readFileSync(generation, "utf8");
  refused(() => runRestore(ctx, restore, noSessions), "old_store");
  expect(readFileSync(live, "utf8")).toBe(hybrid);
  expect(readFileSync(generation, "utf8")).toBe(generationBytes);
  expect(readFileSync(archived, "utf8")).toBe(archivedBytes);
  expect(existsSync(join(ctx.bus.home, "reset.fence.json"))).toBe(false);
}));

test("a legacy COMPLETE inventory restores copied links without counting or following them", () => fixture(f => {
  const backups = join(f.ctx.bus.home, "input-backups"), outside = join(f.root, "outside-file");
  const outsideDir = join(f.root, "outside-dir"), dangling = join(f.root, "absent-target");
  writeFileSync(outside, "external data"); mkdirSync(outsideDir);
  writeFileSync(join(outsideDir, "nested"), "external directory data");
  symlinkSync(outside, join(backups, "file-link"));
  symlinkSync(outsideDir, join(backups, "directory-link"));
  symlinkSync(dangling, join(backups, "dangling-link"));
  runReset(f.ctx, reset, f.effects);
  const archive = f.archive(), path = join(archive, "inventory.json"), inventory = readObject(path);
  // Pre-migration cp -a kept all three links; find -type f wrote files: 0.
  const rows = inventory.components as Array<{ name: string; files: number }>;
  rows.find(row => row.name === "input-backups")!.files = 0;
  writeFileSync(path, JSON.stringify(inventory));
  expect(runRestore(f.ctx, restore, noSessions)).toBe(0);
  for (const [name, target] of [["file-link", outside], ["directory-link", outsideDir], ["dangling-link", dangling]]) {
    expect(lstatSync(join(backups, name!)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(backups, name!))).toBe(target!);
  }
  expect(readFileSync(outside, "utf8")).toBe("external data");
  expect(readFileSync(join(outsideDir, "nested"), "utf8")).toBe("external directory data");
  expect(existsSync(dangling)).toBe(false);
}));

test("restore dry-run does not acquire a fence; same-bundle interrupted restore converges", () => fixture(f => {
  runReset(f.ctx, reset, f.effects);
  const archive = f.archive();
  const before = readdirSync(f.ctx.bus.home).sort();
  expect(runRestore(f.ctx, { ...restore, dryRun: true }, noSessions)).toBe(0);
  expect(readdirSync(f.ctx.bus.home).sort()).toEqual(before);
  writeFileSync(join(f.ctx.bus.payloadsDir, "message.md"), "partial copy");
  writeFileSync(join(f.ctx.bus.home, "reset-generation.json"), JSON.stringify({ state: "reused", bundle_id: "anything" }));
  const meta = readObject(join(archive, "meta.json"));
  writeFileSync(join(archive, "meta.json"), JSON.stringify({ ...meta, restored_at: "prior interrupted attempt" }));
  deadFence(f.ctx, archive, "team-restore");
  expect(runRestore(f.ctx, restore, noSessions)).toBe(0);
  expect(readFileSync(join(f.ctx.bus.payloadsDir, "message.md"), "utf8")).toContain("to: poller");
  expect(existsSync(join(f.ctx.bus.home, "reset.fence.json"))).toBe(false);
}));

test("restore repeats live-state validation after acquisition", () => fixture(f => {
  const doc = readObject(f.ctx.registryPath);
  (doc.seats as Record<string, any>).poller.session = "demo/poller";
  writeFileSync(f.ctx.registryPath, JSON.stringify(doc));
  runReset(f.ctx, reset, f.effects);
  let inspections = 0;
  const race = () => {
    inspections++;
    if (inspections === 1) writeFileSync(join(f.ctx.bus.payloadsDir, "new.md"), "mutation won before fence");
    return noSessions();
  };
  refused(() => runRestore(f.ctx, restore, race), "live_state");
  expect(readFileSync(join(f.ctx.bus.payloadsDir, "new.md"), "utf8")).toBe("mutation won before fence");
  expect(existsSync(join(f.ctx.bus.payloadsDir, "message.md"))).toBe(false);
  expect(existsSync(join(f.ctx.bus.home, "reset.fence.json"))).toBe(false);
}));
