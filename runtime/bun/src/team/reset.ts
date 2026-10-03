import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { observeCallingPane, TapError, type ResolvedContext } from "../context";
import { acquireResetFence, fenceOwnerLive, fenceTestBarrier, readResetFence, releaseResetFence, resetInProgress, setResetFencePhase, stampResetGenerationPristine } from "../reset";
import { acquirePathLock, acquireRegistryLock } from "../panelock";
import { enrolledTeamNameForRoot } from "../index-home";
import { teamRegistryFileRefusal, teamRegistryRefusal, isOldStoreRefusal } from "../register-authority";
import { loadRegistry, seatMap, SCHEMA } from "../registry";
import { scratchOnlyGuard } from "../out-retire";
import { destructiveSessionTarget } from "../lifecycle-target";
import { productionStopEffects } from "../verbs/team";
import { runTeamStop, type StopEffects } from "./stop";
import { registryRoster } from "./selection";
import { renderRefusals, runEntry } from "../error-line";
import { physicalPath } from "../clear-fence";
import { resolveCheckpoint, validateCheckpoint } from "./restore";
import { actingPath, checkComponents, componentPath, componentTable, copyComponent, cutComponents, durableJson, durableWrite, fileCount, isObject, lifecycleContext, readObject, syncTree, type Component } from "./reset-components";

export interface ResetOptions { dryRun: boolean; allowNonstandard: boolean; killSelf: boolean; json: boolean }
export function parseResetOptions(args: string[]): ResetOptions {
  const opts: ResetOptions = { dryRun: false, allowNonstandard: false, killSelf: false, json: args.includes("--json") };
  for (const arg of args) {
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--allow-nonstandard-bus-path") opts.allowNonstandard = true;
    else if (arg === "--kill-self") opts.killSelf = true;
    else if (arg === "--json" || arg === "--yes") continue;
    else if (arg === "--keep-registry") throw new TapError(1, "usage_error", "tap team down", "--keep-registry was removed from team reset; use tap team down");
    else if (arg === "--abort-fence") throw new TapError(1, "usage_error", "tap team reset", "--abort-fence was removed; retry reset to reclaim a dead-owner fence");
    else if (arg === "--force") throw new TapError(1, "unknown_option", "tap team reset   # or --allow-nonstandard-bus-path for a noncanonical TAP_HOME", "unknown option '--force'; --yes is a compatibility no-op, path override is --allow-nonstandard-bus-path");
    else throw new TapError(1, arg.startsWith("--") ? "unknown_option" : "usage_error", "tap help team reset",
      `unsupported reset argument '${arg}'`, "tap team reset");
  }
  return opts;
}

export function releaseFence(ctx: ResolvedContext, token: string): void {
  if (releaseResetFence(ctx.bus.home, token) !== 0) throw new Error("reset fence release refused; inspect the retained fence before retrying");
}

function blankRegistry(ctx: ResolvedContext): void {
  const path = actingPath(ctx);
  mkdirSync(dirname(path), { recursive: true });
  const lock = acquireRegistryLock(path);
  if (!lock) throw new Error("acting registry lock busy");
  try {
    if (actingPath(ctx) !== path) throw new Error("acting registry moved during blank reboot");
    if (existsSync(path)) {
      const refusal = teamRegistryRefusal(path, loadRegistry(path));
      if (refusal) throw new TapError(1, refusal.errorClass, refusal.action, refusal.detail, "tap team reset");
      return;
    }
    const enrolled = enrolledTeamNameForRoot(ctx.root);
    if (!["ok", "missing"].includes(enrolled.status)) throw new Error("team enrollment is unreadable");
    const name = enrolled.name || basename(ctx.root);
    const CHARSET = /^[A-Za-z0-9_.-]+$/;
    if (!CHARSET.test(name)) throw new Error(`team name '${name}' fails charset ${CHARSET}`);
    const branch = spawnSync("git", ["-C", ctx.root, "symbolic-ref", "--quiet", "--short", "HEAD"], { encoding: "utf8" });
    durableJson(path, { schema: SCHEMA, team: {
      schema_version: "1", name, worktree_root: ctx.root,
      created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      branch_at_bootstrap: branch.status === 0 ? branch.stdout.trim() : "unknown",
    }, seats: {} });
  } finally { lock.release(); }
}

function finishCut(ctx: ResolvedContext, table: Component[], bundle: string, token: string): void {
  try {
    if (setResetFencePhase(ctx.bus.home, "cutting", token) !== 0) throw new Error("cannot advance reset fence to cutting");
    cutComponents(ctx, table);
    ctx.bus.ensureDirs();
    blankRegistry(ctx);
    stampResetGenerationPristine(ctx.bus.home, basename(bundle));
    releaseFence(ctx, token);
  } catch (error) {
    // A retry cannot complete a cut over an old-format registry: keep the class and name the checkpoint.
    if (error instanceof TapError && isOldStoreRefusal(error)) {
      throw new TapError(1, error.errorClass, error.action,
        `${error.detail}; the cut ran and the checkpoint and fence are retained (tap team restore --archive ${basename(bundle)})`, "tap team reset");
    }
    throw new TapError(1, "reset_partial", `tap team reset  # retry completes the cut, then: tap team restore --archive ${basename(bundle)}`,
      `reset_partial: ${error instanceof Error ? error.message : error}; checkpoint and fence retained`, "tap team reset");
  }
}

/** Stop effects are shared with down/shutdown; only their stdout is captured. */
export function stopForReset(ctx: ResolvedContext, effects: StopEffects): void {
  const lines: string[] = [];
  const status = runTeamStop({ ctx, verb: "reset-stop", policy: "none", argv: ["--json"],
    roster: registryRoster(ctx.registryPath), effects: { ...effects, io: { ...effects.io, stdout: line => lines.push(line) } },
  });
  let receipt: unknown;
  try { if (lines.length === 1) receipt = JSON.parse(lines[0]!); } catch { /* invalid output refuses below */ }
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === "string");
  if (!isObject(receipt) || "ok" in receipt || typeof receipt.partial !== "boolean"
    || !strings(receipt.stopped_sessions) || !strings(receipt.refused_sessions) || !strings(receipt.refused_handles)
    || receipt.partial !== Boolean(receipt.refused_sessions.length || receipt.refused_handles.length)) {
    throw new TapError(1, "stop_receipt_invalid", "re-run tap team reset; inspect the stop engine if it repeats",
      `reset aborted: no usable stop receipt (status ${status}); no checkpoint cut committed, but sessions may already be stopped`);
  }
  if (receipt.partial) throw new TapError(1, "session_stop_refused", "re-run tap team reset after stopping survivors",
    `reset aborted: ${receipt.stopped_sessions.length} stopped, ${receipt.refused_sessions.length + receipt.refused_handles.length} refused — team is partially down; live TAP state unchanged`);
}

function emitSuccess(ctx: ResolvedContext, bundle: string, opts: ResetOptions, resumed: boolean): void {
  const id = basename(bundle);
  if (opts.json) console.log(JSON.stringify({ ok: true, status: resumed ? "cut_resumed" : "reset", dry_run: false,
    bundle_id: id, archive: bundle, rejoin: "tap in", next_restore: `tap team restore --archive ${id}`, next_up: "tap team up" }));
  else console.log(`tap team reset: ${resumed ? "cut completed — bus is pristine" : "checkpointed and reinitialized team bus"}\n` +
    `tap team reset:   archive=${bundle}\ntap team reset:   bundle_id=${id}\n` +
    `tap team reset:   next: tap in   # rejoin the clean bus (caller is unregistered)\n` +
    `tap team reset:   optional: tap team restore --archive ${id}   # then tap team up`);
}

function killCaller(before: ReturnType<typeof observeCallingPane>, effects: StopEffects): void {
  const unchanged = () => {
    const now = observeCallingPane();
    return before.state === "inside" && now.state === "inside" && before.paneId === now.paneId
      && before.session === now.session && before.serverEpoch === now.serverEpoch;
  };
  if (before.state !== "inside" || !unchanged()) {
    console.error("tap team reset: --kill-self skipped — caller identity is unobservable or moved after commit"); return;
  }
  const authorize = () => destructiveSessionTarget({ pane_id: before.paneId, session: before.session }, before.session, effects.tmux).ok;
  if (!authorize() || !unchanged() || !authorize()) {
    console.error("tap team reset: --kill-self skipped — caller session no longer authorized"); return;
  }
  console.log(`tap team reset: --kill-self: stopping caller session '${before.session}'`);
  effects.killSession(before.session);
  if (effects.hasSession(before.session)) console.error(`tap team reset: --kill-self: session '${before.session}' still live after kill`);
}

export function runReset(ctx: ResolvedContext, opts: ResetOptions, effects: StopEffects): number {
  const bus = ctx.bus.home;
  if (!opts.allowNonstandard && !bus.endsWith("/.tap/bus")) {
    throw new TapError(1, "not_a_bus", "tap team reset --allow-nonstandard-bus-path", `refusing to wipe nonstandard TAP_HOME='${bus}'`);
  }
  scratchOnlyGuard(process.env, "the bus tap team reset would clear", bus, "tap team reset");
  scratchOnlyGuard(process.env, "the acting registry tap team reset would clear", physicalPath(actingPath(ctx)), "tap team reset");
  // Seats drive the stop effects: an old-format registry refuses before any of them.
  const oldStore = teamRegistryFileRefusal(actingPath(ctx));
  if (oldStore) throw new TapError(1, oldStore.errorClass, oldStore.action, oldStore.detail, "tap team reset");
  const table = componentTable();
  checkComponents(ctx, table);
  const checkpoint = table.filter(c => c.fate === "checkpoint");
  if (opts.dryRun) {
    // Refuse exactly as the real run does. Probe only a lock that exists (the acquire would create
    // it, and a dry-run writes nothing): a bus no archiver ever touched has nothing to be held.
    if (existsSync(join(bus, "archive.lock"))) takeArchiveLock(bus).release();
    const sessions = new Set<string>();
    for (const entry of Object.values(seatMap(loadRegistry(ctx.registryPath)))) {
      if (!isObject(entry) || entry.delivery === "poll") continue;
      const target = destructiveSessionTarget(entry, typeof entry.session === "string" ? entry.session : "", effects.tmux);
      if (target.ok) sessions.add(target.session);
    }
    const unsettled = existsSync(ctx.bus.payloadsDir) ? readdirSync(ctx.bus.payloadsDir).filter(name => name.endsWith(".md") && !name.startsWith("_") && !ctx.bus.isDone(name.slice(0, -3))).length : 0;
    const receipt = { ok: true, status: "dry_run", dry_run: true, bus, root: ctx.root, unsettled_payloads: unsettled, rejoin: "tap in", next_up: "tap team up", verified_sessions: [...sessions].sort(),
      components: checkpoint.map(c => ({ name: c.name, files: fileCount(componentPath(ctx, c)) })) };
    if (opts.json) console.log(JSON.stringify(receipt));
    else console.log(`tap team reset: dry-run — would checkpoint and reinitialize ${bus}\ntap team reset:   unsettled_payloads=${unsettled}\ntap team reset:   verified_sessions ${[...sessions].join(", ") || "(none)"}\ntap team reset:   next after real reset: tap in`);
    return 0;
  }
  // `tap bus archive` takes archive.lock with no wait, so it never blocks and no lock cycle can
  // form; it reads the reset fence before taking the lock, and reset takes the lock before it
  // writes the fence. Whichever arrives second refuses. Held to the end of the cut, so an
  // archiver cannot start mid-reset. A dry-run probes and releases (see the dry-run branch).
  const archiving = takeArchiveLock(bus);
  try { return resetUnderArchiveLock(ctx, opts, effects, table, checkpoint); }
  finally { archiving.release(); }
}

/** The archiver's own zero-wait acquire. A failed acquire is a live RESET holding the lock through its cut
 * when the reset fence has a live owner, so that answers with the fence's own refusal; anything else is an archiver. */
function takeArchiveLock(bus: string): ReturnType<typeof acquirePathLock> & object {
  const lock = acquirePathLock(join(bus, "archive.lock"), 0);
  if (lock) return lock;
  const fence = join(bus, "reset.fence.json");
  if (existsSync(fence) && fenceOwnerLive(fence)) throw resetInProgress(readResetFence(bus)?.[0]);
  throw new TapError(1, "archive_active", "retry after the bus archive job finishes", "refusing team reset — a bus archive job is active", "tap team reset");
}

function resetUnderArchiveLock(ctx: ResolvedContext, opts: ResetOptions, effects: StopEffects, table: Component[], checkpoint: Component[]): number {
  const bus = ctx.bus.home;
  const caller = observeCallingPane();
  const archiveRoot = join(bus, "archive", "team-reset");
  const fencePath = join(bus, "reset.fence.json");
  const prior = readResetFence(bus);
  if (prior?.[4] && !fenceOwnerLive(fencePath) && readObject(fencePath).op === "team-reset") {
    const id = prior[4];
    if (basename(id) !== id || id === "." || id === "..") throw new TapError(1, "reset_in_progress", "inspect reset.fence.json", "invalid checkpoint id in reset fence");
    if (existsSync(join(archiveRoot, id, "COMPLETE"))) {
      const bundle = resolveCheckpoint(ctx, id);
      validateCheckpoint(ctx, bundle, table);
      const token = acquireResetFence(bus, String(process.pid), id);
      checkComponents(ctx, table);
      validateCheckpoint(ctx, bundle, table);
      finishCut(ctx, table, bundle, token);
      emitSuccess(ctx, bundle, opts, true);
      if (opts.killSelf) killCaller(caller, effects);
      return 0;
    }
  }
  const suffix = process.env.TAP_RESET_ARCHIVE_SUFFIX;
  if (suffix && !/^[A-Za-z0-9_.-]+$/.test(suffix)) throw new TapError(1, "usage_error", "use a safe reset archive suffix", "invalid archive suffix");
  const base = suffix ? `19700101T000000Z-${suffix}` : `${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${process.pid}`;
  let bundle = "", token = "";
  for (let n = 1; n <= 50; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    bundle = join(archiveRoot, id);
    if (lstatSync(bundle, { throwIfNoEntry: false })) continue;
    token = acquireResetFence(bus, String(process.pid), id);
    try { mkdirSync(archiveRoot, { recursive: true }); mkdirSync(bundle); break; }
    catch (error) {
      releaseFence(ctx, token); token = "";
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  if (!token) throw new TapError(1, "archive_busy", "inspect team-reset archives", "could not allocate checkpoint");
  let complete = false;
  try {
    checkComponents(ctx, table);
    // This marker is optional checkpoint metadata, never a reason to leave
    // teammates stopped without a checkpoint. Snapshot it before stopping.
    let priorGeneration: Record<string, unknown> | null = null;
    try {
      const generation = join(bus, "reset-generation.json");
      if (lstatSync(generation, { throwIfNoEntry: false })?.isFile()) {
        priorGeneration = readObject(generation);
        if (Object.keys(priorGeneration).length === 0) priorGeneration = null;
      }
    } catch { /* Invalid or unreadable optional metadata is absent. */ }
    stopForReset(ctx, effects);
    effects.watch.clearTints();
    ctx.bus.ensureDirs();
    mkdirSync(join(bundle, "bus"));
    const inventory = checkpoint.map(component => {
      const source = componentPath(ctx, component), destination = join(bundle, "bus", component.name);
      if (lstatSync(source, { throwIfNoEntry: false })) copyComponent(source, destination);
      const files = fileCount(destination);
      if (files !== fileCount(source)) throw new Error(`checkpoint copy verification failed: ${component.name}`);
      fenceTestBarrier(`copied-${component.name}`);
      return { name: component.name, files };
    });
    durableJson(join(bundle, "meta.json"), { kind: "team-reset", schema_version: 1, bundle_id: basename(bundle), team: ctx.team || null,
      root: ctx.root, source_bus: bus, created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      prior_reset_generation: priorGeneration });
    durableJson(join(bundle, "inventory.json"), { components: inventory });
    syncTree(bundle);
    durableWrite(join(bundle, "COMPLETE"), `${[basename(bundle), ...readdirSync(join(bundle, "bus")).sort().map(n => `bus/${n}`), "meta.json", "inventory.json"].join("\n")}\n`);
    complete = true;
    finishCut(ctx, table, bundle, token);
  } catch (error) {
    // A published COMPLETE checkpoint is recovery evidence even if a later
    // fsync or cut failed; never remove it in the pre-commit cleanup path.
    if (!complete && !existsSync(join(bundle, "COMPLETE"))) {
      try { releaseFence(ctx, token); } catch (releaseError) { console.error(String(releaseError)); }
      rmSync(bundle, { recursive: true, force: true });
    }
    throw error;
  }
  emitSuccess(ctx, bundle, opts, false);
  if (opts.killSelf) killCaller(caller, effects);
  return 0;
}

export function cmdTeamReset(args: string[]): number {
  if (args.includes("--json")) process.env.TAP_JSON = "1";
  return renderRefusals("tap team reset", () => {
    const opts = parseResetOptions(args), ctx = lifecycleContext("team-reset");
    return runReset(ctx, opts, productionStopEffects(ctx));
  });
}

if (import.meta.main) process.exitCode = runEntry("tap team reset", () => cmdTeamReset(process.argv.slice(2)));
