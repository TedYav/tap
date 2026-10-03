// Bus resolution. CONTRACT.md §Bus layout, resolution order — one place, so the
// deciding rule is reportable by `whoami --verbose` and `doctor`.

import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { memoizedToplevel } from "./git-root";
import { basename, dirname, join, resolve } from "node:path";
import { OldStoreError } from "./register-authority";

export type BusRule = "env" | "dotdir" | "default" | "old_store";

export interface BusResolution {
  home: string;
  rule: BusRule;
}

/**
 * 1. TAP_HOME set            → use it (rule `env`; a custom home is unindexable)
 * 2. <root>/.tap/bus exists  → v0.3 layout (rule `dotdir`)
 * 3. otherwise              → default to <root>/.tap/bus, created on demand
 * A legacy registry without a canonical bus refuses with old_store.
 */
/**
 * PATHS THAT ARE PRINTED ARE RESOLVED, because the incumbent prints resolved
 * ones and the rubric is byte fidelity.
 *
 * Note the direction is the OPPOSITE of `displayCwd`, and that is not an
 * inconsistency to tidy away: the incumbent prints `$PWD` for the caller's
 * location (the logical name the operator typed) and a realpath for the bus
 * (the location a payload actually lives at, which a second process must be
 * able to open). One is where you are; the other is where a file is.
 */
function resolved(p: string): string {
  return realOrSelf(p.replace(/\/+$/, "") || "/");
}

export function resolveBus(repoRoot: string, env: NodeJS.ProcessEnv = process.env): BusResolution {
  const home = env.TAP_HOME;
  if (home) return { home: resolved(home), rule: "env" };
  const path = join(repoRoot, ".tap", "bus");
  if (isDir(path)) return { home: path, rule: "dotdir" };
  let legacyRegistry = false;
  try { lstatSync(join(repoRoot, "tmp", "tap", "registry.json")); legacyRegistry = true; }
  catch (error) { if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  return { home: path, rule: legacyRegistry ? "old_store" : "default" };
}

export function oldBusRefusal(home: string): { errorClass: "old_store"; action: string; detail: string } {
  const path = join(dirname(dirname(home)), "tmp", "tap");
  return { errorClass: "old_store", action: `move ${path} aside by hand, then run tap init`,
    detail: `${path} is an old TAP bus location; this TAP uses <root>/.tap/bus and never converts old stores` };
}

/** Selection/effect boundary: observers can inspect resolveBus's rule instead. */
export function busHomeForRoot(root: string): string {
  return requireResolvedBus(resolveBus(root, {}));
}

export function requireResolvedBus(bus: BusResolution): string {
  if (bus.rule === "old_store") {
    const refusal = oldBusRefusal(bus.home);
    throw new OldStoreError(refusal.action, refusal.detail);
  }
  return bus.home;
}

/** Custom parents anchor an env-pinned context walk, never new team storage.
 * Making that context anchor optional belongs to tap-1t0h.1. */
export function teamRootFromBus(busHome: string): string {
  const parent = realOrSelf(dirname(busHome));
  return basename(parent) === ".tap" ? dirname(parent) : parent;
}

/**
 * Reject a TAP_HOME that names a CONTAINER rather than a bus, BEFORE any write.
 *
 * Why this is a real guard and not defensive noise: an arbitrary custom home is
 * a supported layout and may legitimately bootstrap, so absence of a registry
 * proves nothing. Container SHAPES are proof. Pointing TAP_HOME at a git root
 * that already holds `.tap/bus` and letting it bootstrap creates a SECOND,
 * internally consistent bus underneath the real one — mail lands in a location
 * nothing else reads, and the empty queue at the real bus looks like a quiet
 * peer rather than a split.
 *
 * Verified against the incumbent: `TAP_HOME=<git-root> tap poll x` refuses,
 * names the nested bus, and writes nothing.
 *
 * Returns the expected bus path when the value is a container, else null.
 */
export function containerRefusal(home: string): string | null {
  // Resolve physically first so aliases and trailing separators cannot bypass
  // the check by spelling the same directory differently.
  const p = realOrSelf(resolve(home));

  // Already a canonical bus: accepted.
  if (p.endsWith("/.tap/bus")) {
    busHomeForRoot(dirname(dirname(p)));
    return null;
  }

  // `.tap` itself — its bus is one level down.
  if (basename(p) === ".tap") return join(p, "bus");

  // A root that already CONTAINS a canonical bus.
  if (existsSync(join(p, ".tap", "bus"))) return join(p, ".tap", "bus");

  // A git worktree root, even one with no bus yet: the bus belongs beside it.
  if (isDir(p) && gitToplevel(p) === p) return join(p, ".tap", "bus");

  return null;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Git worktree root of `cwd`, or `cwd` itself when git cannot name one. */
export function repoRoot(cwd: string = process.cwd()): string {
  return gitToplevel(cwd) || cwd;
}

export function gitToplevel(p: string): string {
  const top = memoizedToplevel(p);
  return top ? realOrSelf(top) : "";
}

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // A not-yet-created custom home is legitimate; resolve its parent so an
    // alias in the parent chain still normalizes.
    const parent = dirname(p);
    try {
      return join(realpathSync(parent), basename(p));
    } catch {
      return p;
    }
  }
}

// The remaining shell entry needs errno-aware classification before mkdir.
// Its explicit TAP_HOME branch stays in the caller; this door resolves a root.
if (import.meta.main) {
  try {
    const root = process.argv[2];
    if (!root || process.argv.length !== 3) throw new Error("usage: bushome.ts <root>");
    process.stdout.write(resolveBus(root, {}).rule + "\n");
  } catch (error) {
    process.stderr.write(`tap: bus lookup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
