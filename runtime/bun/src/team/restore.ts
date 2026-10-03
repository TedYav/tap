import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, join, relative, isAbsolute } from "node:path";
import { TapError, type ResolvedContext } from "../context";
import { acquireResetFence, fenceOwnerLive, markResetGenerationReused, readResetFence, setResetFencePhase } from "../reset";
import { loadRegistry, seatMap } from "../registry";
import { acquireRegistryLock } from "../panelock";
import { scratchOnlyGuard } from "../out-retire";
import { registryWriteRefusal, teamRegistryRefusal } from "../register-authority";
import { tmuxSessionNamespace } from "../tmux";
import { runEntry } from "../error-line";
import { physicalPath } from "../clear-fence";
import { stripStaleBindings } from "./stop-tx";
import { releaseFence } from "./reset";
import { actingPath, componentPath, componentTable, copyComponent, durableJson, fileCount, isObject, lifecycleContext, readObject, type Component } from "./reset-components";

export interface RestoreOptions { archive: string; dryRun: boolean; json: boolean; again: boolean }
function refuse(kind: string, detail: string, action = "tap help team restore"): never {
  throw new TapError(1, kind, action, detail, "tap team restore");
}

export function parseRestoreOptions(args: string[]): RestoreOptions {
  const out = { archive: "", dryRun: false, json: args.includes("--json"), again: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--archive") {
      const value = args[++i];
      if (!value) refuse("usage_error", "missing --archive value");
      out.archive = value;
    } else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--json") continue;
    else if (arg === "--again") out.again = true;
    else refuse(arg?.startsWith("--") ? "unknown_option" : "usage_error", `unsupported restore argument '${arg}'`);
  }
  return out;
}

export function resolveCheckpoint(ctx: ResolvedContext, selector: string): string {
  const root = join(ctx.bus.home, "archive", "team-reset");
  if (!existsSync(root)) refuse("archive_not_found", `no team-reset archives under ${root}`, "tap team reset");
  const canonicalRoot = realpathSync(root);
  const contained = (candidate: string): string => {
    let canonical: string;
    try { canonical = realpathSync(candidate); } catch { return refuse("archive_not_found", `no checkpoint at '${candidate}'`); }
    const rel = relative(canonicalRoot, canonical);
    if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) refuse("archive_escape", "checkpoint escapes the team-reset archive root");
    if (!lstatSync(canonical).isDirectory()) refuse("archive_invalid", "checkpoint must be a directory");
    return canonical;
  };
  if (selector) return contained(isAbsolute(selector) ? selector : join(root, selector));
  for (const name of readdirSync(root).sort().reverse()) {
    try {
      const path = contained(join(root, name));
      if (existsSync(join(path, "COMPLETE")) && readObject(join(path, "meta.json")).kind === "team-reset") return path;
    } catch { /* A newer incomplete or unrelated archive must not hide a valid one. */ }
  }
  return refuse("archive_not_found", "no COMPLETE team-reset checkpoint", "tap team reset");
}

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

/** A live registry restore may replace: current format with no rows. A
 * noncurrent live file refuses here, so restore never overwrites it. */
function emptyRegistry(path: string): boolean {
  const doc = loadRegistry(path);
  const refusal = registryWriteRefusal(path, doc);
  if (refusal) refuse(refusal.errorClass, refusal.detail, refusal.action);
  return Object.keys(doc.seats as Record<string, unknown>).length === 0;
}

/**
 * Restore publishes checkpointed registries byte for byte, so each one must
 * already be the current format. An old one is refused before anything is
 * published; the archive itself is never rewritten.
 */
function requireCurrentCheckpointRegistries(bundle: string): string {
  const acting = join(bundle, "bus", "team-registry.json");
  // Presence is the entry itself (lstat), not its target: a dangling link is a
  // present member that cannot be read, never an absent registry.
  const present = (path: string) => Boolean(lstatSync(path, { throwIfNoEntry: false }));
  for (const path of [acting, join(bundle, "bus", "registry.json")]) {
    if (!present(path)) continue;
    let doc: Record<string, unknown>;
    try { doc = readObject(path); } catch { return refuse("archive_invalid", `checkpoint registry ${basename(path)} is unreadable or not a JSON object`); }
    const refusal = teamRegistryRefusal(path, doc);
    if (refusal) refuse(refusal.errorClass, refusal.detail, refusal.action);
  }
  return join(bundle, "bus", present(acting) ? "team-registry.json" : "registry.json");
}

function checkpointObject(bundle: string, name: "meta.json" | "inventory.json"): Record<string, unknown> {
  try { return readObject(join(bundle, name)); }
  catch {
    return refuse(name === "meta.json" ? "archive_invalid" : "inventory_mismatch",
      `checkpoint ${name} is unreadable or not a JSON object`, "choose a valid COMPLETE team-reset checkpoint");
  }
}

export function validateCheckpoint(ctx: ResolvedContext, bundle: string, table: Component[]): Record<string, unknown> {
  for (const member of ["COMPLETE", "meta.json", "inventory.json", "bus"]) {
    const st = lstatSync(join(bundle, member), { throwIfNoEntry: false });
    if (!st || (member === "bus" ? !st.isDirectory() : !st.isFile())) refuse("incomplete_checkpoint", `checkpoint missing regular member '${member}'`);
  }
  const meta = checkpointObject(bundle, "meta.json");
  if (meta.kind !== "team-reset") refuse("wrong_archive_kind", "checkpoint kind is not team-reset");
  if (typeof meta.root !== "string" || canonical(meta.root) !== canonical(ctx.root)) refuse("root_mismatch", "checkpoint belongs to another root");
  if (typeof meta.source_bus !== "string" || canonical(meta.source_bus) !== canonical(ctx.bus.home)) refuse("source_bus_mismatch", "checkpoint belongs to another bus");
  if (ctx.marker === "live" && meta.team && meta.team !== ctx.team) refuse("team_mismatch", "checkpoint belongs to another enrolled team");
  const checkpoint = table.filter(c => c.fate === "checkpoint"), names = new Set(checkpoint.map(c => c.name));
  const inventory = checkpointObject(bundle, "inventory.json").components;
  if (!Array.isArray(inventory)) refuse("inventory_mismatch", "checkpoint inventory has no component array");
  const seen = new Set<string>();
  for (const item of inventory) {
    if (!isObject(item) || typeof item.name !== "string" || !names.has(item.name)) refuse("unclassified_component", "checkpoint inventory names an unclassified component");
    if (seen.has(item.name) || !Number.isSafeInteger(item.files) || (item.files as number) < 0) refuse("inventory_mismatch", "invalid or duplicate checkpoint inventory entry");
    seen.add(item.name);
    if (fileCount(join(bundle, "bus", item.name)) !== item.files) refuse("inventory_mismatch", `checkpoint file count differs for '${item.name}'`);
  }
  if (seen.size !== names.size) refuse("inventory_mismatch", "checkpoint inventory omits a classified component");
  for (const name of readdirSync(join(bundle, "bus"))) {
    if (!names.has(name)) refuse("unclassified_component", `unknown checkpoint member bus/${name}`);
  }
  return meta;
}

export function validateRestore(ctx: ResolvedContext, bundle: string, options: RestoreOptions, table: Component[], resume: boolean,
  namespace: typeof tmuxSessionNamespace = tmuxSessionNamespace): Record<string, unknown> {
  const meta = validateCheckpoint(ctx, bundle, table);
  const liveTeam = ctx.team;
  if (meta.team && liveTeam && meta.team !== liveTeam) refuse("team_mismatch", "checkpoint belongs to another team");
  if (meta.restored_at && !options.again && !resume) refuse("already_restored", "checkpoint already restored", `tap team restore --again --archive ${basename(bundle)}`);
  const checkpoint = table.filter(c => c.fate === "checkpoint");
  if (!resume) {
    const generation = join(ctx.bus.home, "reset-generation.json");
    if (!existsSync(generation)) refuse("generation_missing", "live bus has no reset-generation marker", "tap team reset");
    const gen = readObject(generation);
    if (gen.state !== "pristine") refuse("generation_reused", "reset-generation is not pristine", "tap team reset");
    if (gen.bundle_id !== basename(bundle)) refuse("generation_mismatch", "reset-generation names another checkpoint");
    const acting = actingPath(ctx), blank = existsSync(acting) && emptyRegistry(acting);
    for (const component of checkpoint) {
      const path = componentPath(ctx, component), st = lstatSync(path, { throwIfNoEntry: false });
      if (!st) continue;
      if (blank && (path === acting || path === `${acting}.lock`)) continue;
      if (st.isDirectory() && readdirSync(path).length === 0) continue;
      refuse("live_state", `live component '${component.name}' is not empty`, "tap team reset");
    }
  }
  const archived = requireCurrentCheckpointRegistries(bundle);
  const sessions = Object.values(seatMap(loadRegistry(archived))).filter(isObject).map(row => row.session).filter((s): s is string => typeof s === "string" && !!s);
  if (sessions.length) {
    const live = namespace();
    if (!live.observable) refuse("tmux_unobservable", "cannot verify archived session names are free");
    const collisions = sessions.filter(name => live.names.has(name));
    if (collisions.length) refuse("tmux_collision", `live sessions collide with checkpoint: ${collisions.join(", ")}`, "stop colliding sessions, then re-run restore");
  }
  return meta;
}

export function runRestore(ctx: ResolvedContext, options: RestoreOptions, namespace: typeof tmuxSessionNamespace = tmuxSessionNamespace): number {
  scratchOnlyGuard(process.env, "the bus tap team restore would write", ctx.bus.home, "tap team restore");
  scratchOnlyGuard(process.env, "the acting registry tap team restore would write", physicalPath(actingPath(ctx)), "tap team restore");
  const table = componentTable(), bundle = resolveCheckpoint(ctx, options.archive), id = basename(bundle);
  const fence = join(ctx.bus.home, "reset.fence.json");
  const prior = readResetFence(ctx.bus.home);
  const resume = prior?.[4] === id && !fenceOwnerLive(fence) && readObject(fence).op === "team-restore";
  validateRestore(ctx, bundle, options, table, resume, namespace);
  if (options.dryRun) {
    if (options.json) console.log(JSON.stringify({ ok: true, dry_run: true, bundle_id: id, archive: bundle }));
    else console.log(`tap team restore: dry-run — would restore checkpoint ${id}\ntap team restore:   rows would be suspended with status_reason=restored_from_archive\ntap team restore:   next after restore: tap team up`);
    return 0;
  }
  const token = acquireResetFence(ctx.bus.home, String(process.pid), id, "team-restore");
  let mutationStarted = false;
  try {
    // A mutation can win between preview validation and acquisition. Recheck
    // while new cooperating writers are fenced, before replacing live state.
    const meta = validateRestore(ctx, bundle, options, table, resume, namespace);
    if (setResetFencePhase(ctx.bus.home, "restoring", token) !== 0) throw new Error("cannot advance restore fence");
    mutationStarted = true;
    for (const component of table.filter(c => c.fate === "checkpoint")) {
      const source = join(bundle, "bus", component.name), destination = componentPath(ctx, component);
      if (!lstatSync(source, { throwIfNoEntry: false })) continue;
      rmSync(destination, { recursive: true, force: true });
      copyComponent(source, destination);
    }
    for (const registry of new Set([ctx.registryPath, actingPath(ctx)])) {
      if (!existsSync(registry)) continue;
      const lock = acquireRegistryLock(registry);
      if (!lock) throw new Error("acting registry lock busy");
      try {
        if (ctx.marker === "live" && actingPath(ctx) !== ctx.registryPath) throw new Error("acting registry moved during restore");
        const doc = loadRegistry(registry);
        for (const row of Object.values(seatMap(doc))) {
          if (!isObject(row)) continue;
          stripStaleBindings(row);
          row.status = "suspended"; row.status_reason = "restored_from_archive";
        }
        durableJson(registry, doc);
      } finally { lock.release(); }
    }
    durableJson(join(bundle, "meta.json"), { ...meta, restored_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), restored_by: `pid:${process.pid}` });
    markResetGenerationReused(ctx.bus.home, "team-restore");
    ctx.bus.ensureDirs();
    mkdirSync(join(ctx.bus.home, "tmp"), { recursive: true });
    releaseFence(ctx, token);
  } catch (error) {
    if (!mutationStarted && !resume) { releaseFence(ctx, token); throw error; }
    refuse("restore_partial", `restore mutation failed: ${error instanceof Error ? error.message : error}; fence retained`, `tap team restore --archive ${id}  # rerun restore`);
  }
  const count = Object.keys(seatMap(loadRegistry(ctx.registryPath))).length;
  if (options.json) console.log(JSON.stringify({ ok: true, dry_run: false, bundle_id: id, archive: bundle,
    restored_agents: count, status_reason: "restored_from_archive", next: "tap team up" }));
  else console.log(`tap team restore: restored checkpoint ${id}\ntap team restore:   archive=${bundle}\ntap team restore:   agents=${count} (all suspended, status_reason=restored_from_archive)\ntap team restore:   next: tap team up`);
  return 0;
}

export function cmdTeamRestore(args: string[]): number {
  if (args.includes("--json")) process.env.TAP_JSON = "1";
  const options = parseRestoreOptions(args);
  if (options.json) process.env.TAP_JSON = "1";
  return runRestore(lifecycleContext("team-restore"), options);
}

if (import.meta.main) process.exitCode = runEntry("tap team restore", () => cmdTeamRestore(process.argv.slice(2)));
