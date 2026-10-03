import { closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { TapError, resolveContext, teamRootFromBus, type ResolvedContext } from "../context";
import { Bus } from "../bus";
import { repoRoot } from "../bushome";
import { busHomeForEnrolled } from "../selector";
import { fenceOwnerLive } from "../reset";
import { firstLiveFence } from "../clear-fence";
import { enrollmentAt } from "../index-home";
import { pyJson } from "../registry";

type Fate = "checkpoint" | "discard" | "preserve" | "ephemeral-guard";
export interface Component { name: string; fate: Fate; scope: "bus" | "acting" }

/** A committed partial cut may have removed the acting file. Its enrolled
 * path and a dead-owner checkpoint fence can still authorize recovery. */
export function lifecycleContext(op: "team-reset" | "team-restore"): ResolvedContext {
  try { return resolveContext(); } catch (error) {
    if (!(error instanceof TapError) || error.errorClass !== "live_unreachable") throw error;
    const stop = repoRoot(), roots: string[] = [];
    for (let root = realpathSync(process.cwd()); ; root = dirname(root)) {
      roots.push(root);
      if (root === stop || dirname(root) === root) break;
    }
    if (process.env.TAP_HOME) roots.push(teamRootFromBus(process.env.TAP_HOME));
    for (const root of roots) {
      const at = enrollmentAt(root);
      if (at.status === "missing") continue;
      if (at.status !== "unreachable" || !at.registryLocation || existsSync(at.registryLocation)) throw error;
      const bus = new Bus(busHomeForEnrolled(at.rootReal)), path = join(bus.home, "reset.fence.json");
      if (!existsSync(path) || fenceOwnerLive(path)) throw error;
      const fence = readObject(path), id = fence.bundle_id;
      if (fence.op !== op || typeof id !== "string" || !id || id === "." || id === ".." || /[/\\]/.test(id)
        || !existsSync(join(bus.home, "archive", "team-reset", id, "COMPLETE"))) throw error;
      return { root: at.rootReal, team: at.name, registryPath: at.registryLocation, bus, busRule: "dotdir", marker: "live" };
    }
    throw error;
  }
}

// This table owns copy, inventory, cut and restore. Historical scratch files
// are deliberately unclassified: a new stray must not be silently discarded.
const TABLE = `payloads|checkpoint
receipts|checkpoint
registry.json|checkpoint
registry.json.lock|checkpoint
team-registry.json|checkpoint|acting
team-registry.json.lock|checkpoint|acting
spool|checkpoint
delivery|discard
clear-fence|discard
watch|checkpoint
goalie|checkpoint
approval-timeout|checkpoint
collab|checkpoint
seat-state|checkpoint
pane-effects|checkpoint
drafts|checkpoint
handoff|checkpoint
input-backups|checkpoint
tmp|discard
.tap-bus-authority|preserve
archive|preserve
archive.lock|preserve
registry-events.log|preserve
registry-events.log.lock|preserve
locks|preserve
tap-deliver.log|preserve
reset.fence.json|ephemeral-guard
reset.fence.json.lock|ephemeral-guard
reset-generation.json|ephemeral-guard`;

export function componentTable(env: NodeJS.ProcessEnv = process.env): Component[] {
  const override = env.TAP_SCRATCH_ONLY ? env.TAP_RESET_COMPONENT_TABLE_OVERRIDE : undefined;
  const names = new Set<string>();
  return (override ?? TABLE).split("\n").filter(Boolean).map(line => {
    const fields = line.split("|");
    // The scratch override retains the retired table's name|fate|reason|scope shape.
    const [name = "", fate = ""] = fields;
    const scope = (override === undefined ? fields[2] : fields[3]) || "bus";
    if (!name || name === "." || name === ".." || /[/\\\0]/.test(name) || names.has(name)
      || !["checkpoint", "discard", "preserve", "ephemeral-guard"].includes(fate)
      || !["bus", "acting"].includes(scope)) {
      throw new TapError(1, "invalid_component_fate", "fix runtime/bun/src/team/reset-components.ts",
        `refusing team reset — invalid component row '${line}'`);
    }
    names.add(name);
    return { name, fate: fate as Fate, scope: scope as Component["scope"] };
  });
}

export function actingPath(ctx: ResolvedContext): string {
  const at = enrollmentAt(ctx.root);
  if (at.status === "ok" || at.status === "unreachable") {
    if (ctx.marker === "live" && ctx.registryPath !== at.registryLocation) {
      throw new TapError(1, "team_moved", "tap doctor", "acting registry moved during reset/restore");
    }
    return at.registryLocation;
  }
  if (at.status !== "missing") throw new TapError(1, "registry_unreachable", "tap doctor", "cannot resolve reset's acting registry");
  return join(ctx.root, ".tap", "team-registry.json");
}

export function componentPath(ctx: ResolvedContext, component: Component): string {
  if (component.scope === "bus") return join(ctx.bus.home, component.name);
  const registry = actingPath(ctx);
  if (component.name === "team-registry.json") return registry;
  if (component.name === "team-registry.json.lock") return `${registry}.lock`;
  return join(dirname(registry), component.name);
}

export function checkComponents(ctx: ResolvedContext, table: readonly Component[]): void {
  const known = new Set(table.filter(c => c.scope === "bus").map(c => c.name));
  for (const name of existsSync(ctx.bus.home) ? readdirSync(ctx.bus.home).sort() : []) {
    // A live panelock holder's marker beside a classified lock is transient,
    // not a stray: reset waits on the lock itself (tap-g191v).
    const held = /^(.+\.lock)\.held\./.exec(name)?.[1];
    if (!known.has(name) && !(held && known.has(held))) throw new TapError(1, "unclassified_component", "classify the component in runtime/bun/src/team/reset-components.ts",
      `refusing team reset — unclassified bus component '${name}'`);
  }
  let live: string;
  try { live = firstLiveFence(ctx.bus.home); }
  catch { throw new TapError(1, "clear_fence_unreadable", "tap doctor", "refusing team reset — could not inspect clear-fence liveness"); }
  if (live) throw new TapError(1, "clear_in_flight", "re-run tap team reset after the clear settles",
    `refusing team reset — seat '${live}' is mid-clear (live clear fence)`);
}

/** Match the existing inventory's find -type f count. Copy links without
 * counting or following them, so old COMPLETE checkpoints remain restorable. */
export function fileCount(path: string): number {
  let st;
  try { st = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  if (st.isDirectory()) return readdirSync(path).reduce((n, name) => n + fileCount(join(path, name)), 0);
  if (st.isSymbolicLink()) return 0;
  if (st.isFile()) return 1;
  throw new Error(`unsupported checkpoint member: ${path}`);
}

export function copyComponent(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
}

export function syncTree(path: string): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) for (const name of readdirSync(path)) syncTree(join(path, name));
  if (!st.isDirectory() && !st.isFile()) throw new Error(`unsupported checkpoint member: ${path}`);
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function durableWrite(path: string, bytes: string): void {
  const temp = join(dirname(path), `.tap-reset-${randomUUID()}`);
  try {
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    const dir = openSync(dirname(path), "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { rmSync(temp, { force: true }); }
}

export function durableJson(path: string, value: Record<string, unknown>): void {
  durableWrite(path, `${pyJson(value, 0)}\n`);
}

export function readObject(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isObject(value)) throw new Error(`expected an object in ${path}`);
  return value;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function cutComponents(ctx: ResolvedContext, table: readonly Component[]): void {
  for (const component of table) {
    if (component.fate === "preserve" || component.name === "reset.fence.json" || component.name === "reset.fence.json.lock") continue;
    rmSync(componentPath(ctx, component), { recursive: true, force: true });
  }
  for (const component of table) {
    if (component.fate === "discard" && !component.name.includes(".")) mkdirSync(componentPath(ctx, component), { recursive: true });
  }
}
