// One Bun selector authority for caller-bus and target selection (tap-1t0h.1).
//
// THIS FILE IS THE AUTHORITY. context.ts consumes selectCaller for caller-bus
// resolution: under a live marker, native verbs that go through resolveContext
// inherit the cwd enrollment walk and TAP_HOME-last fallback. Target selection,
// lock-held revalidation, and child-pin comparison are library capability —
// no production mutation site or router --team flag is wired in this stage.
// There is no second Python implementation, no TAP_TEAM pin, and no new env.
//
// Deferred caller route / deletion accounting (Stage 0 does not cut these over):
//   skills/tap/scripts/lib.sh              tap_apply_team_override, tap_authority_context,
//                                          tap_resolve_team_target (still TAP_HOME-first)
//   skills/tap/scripts/tap-register.sh     --team vs TAP_HOME team_home_conflict
//   skills/tap/scripts/session/launcher.py _team_bus_home, root_for_cwd
//   runtime/bun/src/verbs/done.ts          applyTeamOverride (TAP_HOME still wins;
//                                          --team remains Bash-owned on the router)
// A CLI that printed one JSON Selection is planned for those callers; it is
// not in this tree.

import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { memoizedToplevel } from "./git-root";

import { busHomeForRoot, containerRefusal, repoRoot, resolveBus, teamRootFromBus, type BusRule } from "./bushome";
import { pyReadUtf8 } from "./spool-publication";
import { validToken } from "./ids";
import {
  enrollmentAt,
  enrollmentAtFromDoc,
  flipMarkerState,
  globalRegistryPath,
  loadGlobalRegistry,
  resolveTeamFromDoc,
  resolveTeamFromGlobal,
} from "./index-home";
import { isRegistryLock, type RegistryLock, type AsyncRegistryLock } from "./panelock";
import { teamRegistryFileRefusal, teamRegistryRefusal } from "./register-authority";

export class SelectorError extends Error {
  constructor(
    readonly code: number,
    readonly errorClass: string,
    readonly action: string,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "SelectorError";
  }
}

export type SelectorSource = "explicit-team" | "cwd" | "pinned-root" | "env" | "pane";
export type AuthorityMode = "enrolled" | "bus";
export type VerbClass = "send" | "lifecycle";

export interface Selection {
  team: string;
  rootReal: string;
  /** Index-recorded acting registry path. Lock sidecar and effects use this. */
  registryLocation: string;
  /** Canonical realpath of the acting registry. Equality only — not lock identity. */
  registryLocationReal: string;
  busHome: string;
  busRule: BusRule;
  source: SelectorSource;
  /** Machine flip marker observed at select time: always live; absent refuses. */
  marker: "live";
  /**
   * Where this pin is authoritative.
   * `enrolled` revalidates through the global index.
   * `bus` is an unindexed custom/scratch bus — even when the machine marker is
   * live — and must never be forced through globalRegistry.
   */
  authority: AuthorityMode;
}

export interface TargetSelection {
  team: string;
  handle: string;
  rootReal: string;
  registryLocation: string;
  registryLocationReal: string;
  scope: "local" | "remote";
}

export interface SelectorInput {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Caller-axis `--team`. */
  explicitTeam?: string;
  /** Target-axis raw address: bare handle or `team/handle`. */
  explicitTarget?: string;
  /** Detached child: run as if cwd were this enrolled root. */
  pinnedRoot?: string;
  /** Lifecycle verbs treat `--team` and `team/handle` as the same axis. */
  verbClass?: VerbClass;
}

export interface SelectorResult {
  caller: Selection;
  target?: TargetSelection;
}

export interface ParsedTarget {
  team: string;
  handle: string;
  qualified: boolean;
}

/**
 * Parse a seat address. `team:handle` normalizes to `team/handle`.
 * More than one slash, empty parts, or a bad charset refuse — they never
 * fall through to cwd or TAP_HOME.
 */
export function parseTarget(raw: string): ParsedTarget {
  const value = raw.trim();
  if (!value) {
    throw new SelectorError(1, "usage_error", "tap help", "address is empty");
  }
  let normalized = value;
  if (value.includes(":") && !value.includes("/")) {
    const team = value.slice(0, value.indexOf(":"));
    const handle = value.slice(value.indexOf(":") + 1);
    if (!team || !handle) {
      throw new SelectorError(1, "usage_error", "tap help",
        `address '${value}' is not a valid <team>:<handle> token`);
    }
    normalized = `${team}/${handle}`;
  }
  if (normalized.includes("/")) {
    const team = normalized.slice(0, normalized.indexOf("/"));
    const handle = normalized.slice(normalized.indexOf("/") + 1);
    if (!team || !handle || handle.includes("/")) {
      throw new SelectorError(1, "usage_error", "tap help",
        `address '${value}' must be <team>/<handle> with one slash`);
    }
    if (!validToken(team)) {
      throw new SelectorError(1, "usage_error", "tap help",
        `team '${team}' is not a valid token (^[A-Za-z0-9][A-Za-z0-9._-]*$)`);
    }
    if (!validToken(handle)) {
      throw new SelectorError(1, "usage_error", "tap help",
        `handle '${handle}' is not a valid token (^[A-Za-z0-9][A-Za-z0-9._-]*$)`);
    }
    return { team, handle, qualified: true };
  }
  if (!validToken(normalized)) {
    throw new SelectorError(1, "usage_error", "tap help",
      `handle '${normalized}' is not a valid token (^[A-Za-z0-9][A-Za-z0-9._-]*$)`);
  }
  return { team: "", handle: normalized, qualified: false };
}

export function resolveSelector(input: SelectorInput): SelectorResult {
  const env = input.env ?? process.env;
  const verbClass = input.verbClass ?? "send";
  const parsed = input.explicitTarget !== undefined ? parseTarget(input.explicitTarget) : undefined;

  if (verbClass === "lifecycle" && input.explicitTeam && parsed?.qualified) {
    throw new SelectorError(1, "selector_conflict", "pass --team OR a team/handle target, not both",
      `lifecycle --team '${input.explicitTeam}' and qualified target '${input.explicitTarget}' are the same axis`);
  }

  const caller = selectCaller(input);
  if (!parsed) return { caller };
  const target = selectTarget(caller, parsed, env);
  return { caller, target };
}

export function selectCaller(input: SelectorInput): Selection {
  const env = input.env ?? process.env;
  const indexHome = env.TAP_INDEX_HOME;
  if (!env.TAP_HOME && !input.explicitTeam && input.pinnedRoot === undefined) busHomeForRoot(repoRoot(canonicalDir(input.cwd, "cwd")));
  requireMarker(indexHome);

  if (input.explicitTeam !== undefined && input.explicitTeam === "") {
    throw new SelectorError(1, "usage_error", "tap help", "--team needs a value");
  }

  if (input.pinnedRoot !== undefined) {
    if (input.pinnedRoot === "") {
      throw new SelectorError(1, "usage_error", "tap help", "pinned root needs a value");
    }
    const pinned = bindPinnedRoot(canonicalDir(input.pinnedRoot, "pinned_root"), indexHome);
    if (input.explicitTeam) {
      const explicit = selectExplicitTeam(input.explicitTeam, indexHome);
      if (pinned.team !== explicit.team || pinned.registryLocation !== explicit.registryLocation) {
        throw new SelectorError(1, "selector_conflict", "pass --team OR a pinned root, not both",
          `explicit --team '${explicit.team}' disagrees with pinned root team '${pinned.team}'`);
      }
      return explicit;
    }
    return pinned;
  }

  if (input.explicitTeam) {
    return selectExplicitTeam(input.explicitTeam, indexHome);
  }
  return selectFromWalk(canonicalDir(input.cwd, "cwd"), indexHome, env, "cwd");
}

export function selectTarget(caller: Selection, parsed: ParsedTarget, env: NodeJS.ProcessEnv = process.env): TargetSelection {
  const handle = parsed.handle;
  if (!parsed.qualified || parsed.team === caller.team) {
    return {
      team: caller.team,
      handle,
      rootReal: caller.rootReal,
      registryLocation: caller.registryLocation,
      registryLocationReal: caller.registryLocationReal,
      scope: "local",
    };
  }
  const bound = bindTeam(parsed.team, env.TAP_INDEX_HOME);
  return {
    team: bound.team,
    handle,
    rootReal: bound.rootReal,
    registryLocation: bound.registryLocation,
    registryLocationReal: bound.registryLocationReal,
    scope: "remote",
  };
}

/**
 * Recheck the pinned triple under the acting registry lock. A caller that
 * mutates the acting registry can invoke this immediately before the write.
 * Stage 0 does not wire a production mutation site.
 *
 * `lock` must be the branded token `acquireRegistryLock` minted for this file.
 */
export function assertSelectionCurrent(
  selection: Selection,
  lock: RegistryLock | AsyncRegistryLock,
  indexHome?: string,
): void {
  if (!isRegistryLock(lock as object)) {
    throw new SelectorError(1, "lock_required", "acquire the acting registry lock, then retry",
      "selection revalidation requires the acting registry lock");
  }
  if (lock.registryLocation !== selection.registryLocation) {
    throw new SelectorError(1, "lock_mismatch", "acquire the acting registry lock for the selected file",
      `held lock is for '${lock.registryLocation}', selection is '${selection.registryLocation}'`);
  }

  if (selection.authority === "enrolled") {
    const snap = loadGlobalRegistry(indexHome);
    if (snap.marker === "invalid") {
      throw new SelectorError(1, "invalid_flip", "tap doctor",
        "registry flip marker is present but invalid; refusing rather than skipping a v0.20 obligation");
    }
    {
      if (snap.marker !== "live" || !snap.doc) {
        throw new SelectorError(1, "team_moved", "tap doctor",
          `team '${selection.team}' enrollment is no longer live (marker ${snap.marker})`);
      }
      const r = resolveTeamFromDoc(snap.doc, selection.team);
      if (r.status !== "ok") {
        throw new SelectorError(1, "team_moved", "tap doctor",
          `team '${selection.team}' is no longer a live enrollment (${r.status})`);
      }
      if (r.registryLocation !== selection.registryLocation) {
        throw new SelectorError(1, "team_moved", "tap doctor",
          `team '${selection.team}' acting path moved (literal ${selection.registryLocation} -> ${r.registryLocation})`);
      }
      const rootNow = realOrSelf(r.root);
      const locRealNow = realOrSelf(r.registryLocation);
      if (rootNow !== selection.rootReal || locRealNow !== selection.registryLocationReal) {
        throw new SelectorError(1, "team_moved", "tap doctor",
          `team '${selection.team}' moved (root ${selection.rootReal} -> ${rootNow}; registry ${selection.registryLocationReal} -> ${locRealNow})`);
      }
    }
  } else {
    // A bus pin has no enrollment to recheck, but its symlinked registry can
    // still be retargeted after selection.
    const locRealNow = realOrSelf(selection.registryLocation);
    if (locRealNow !== selection.registryLocationReal) {
      throw new SelectorError(1, "team_moved", "tap doctor",
        `team '${selection.team}' registry moved (${selection.registryLocationReal} -> ${locRealNow})`);
    }
    // A root adopted from a stamp can vanish apart from its bus; realOrSelf
    // would echo the stale path back, so the comparison below cannot see it.
    if (!isDir(selection.rootReal)) {
      throw new SelectorError(1, "team_moved", "tap doctor",
        `team '${selection.team}' root '${selection.rootReal}' is gone`);
    }
  }

  assertActingRegistryMatches(selection);
}

export function assertActingRegistryMatches(selection: Pick<Selection, "registryLocation" | "team" | "rootReal">): void {
  let raw: unknown;
  try {
    raw = JSON.parse(pyReadUtf8(selection.registryLocation));
  } catch {
    throw new SelectorError(1, "team_moved", "tap doctor",
      `acting registry '${selection.registryLocation}' is gone or unreadable`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SelectorError(1, "team_moved", "tap doctor",
      `acting registry is present but malformed`);
  }
  const doc = raw as Record<string, unknown>;
  // Under the lock, before the no-team early return: a file swapped for an old
  // format after selection refuses here too.
  const refusal = teamRegistryRefusal(selection.registryLocation, doc);
  if (refusal) throw new SelectorError(1, refusal.errorClass, refusal.action, refusal.detail);
  // The predicate refused a present non-object team, so a present team is an object here.
  if (!("team" in doc) || doc.team === undefined) return;
  const t = doc.team as Record<string, unknown>;
  if ("name" in t && t.name !== undefined) {
    if (typeof t.name !== "string") {
      throw new SelectorError(1, "team_moved", "tap doctor",
        `acting registry team.name is present but malformed`);
    }
    if (t.name !== selection.team) {
      throw new SelectorError(1, "team_moved", "tap doctor",
        `acting registry team.name '${t.name}' is not selection team '${selection.team}'`);
    }
  }
  if ("worktree_root" in t && t.worktree_root !== undefined && t.worktree_root !== "") {
    if (typeof t.worktree_root !== "string") {
      throw new SelectorError(1, "team_moved", "tap doctor",
        `acting registry worktree_root is present but malformed`);
    }
    if (realOrSelf(t.worktree_root) !== selection.rootReal) {
      throw new SelectorError(1, "team_moved", "tap doctor",
        `acting registry worktree_root '${t.worktree_root}' is not selection root '${selection.rootReal}'`);
    }
  }
}

/** Parent of a detached child compares the receipt against the pin it dispatched. */
export function validateChildSelection(parent: Selection, child: Selection): void {
  if (
    parent.team !== child.team
    || parent.rootReal !== child.rootReal
    || parent.registryLocation !== child.registryLocation
    || parent.registryLocationReal !== child.registryLocationReal
  ) {
    throw new SelectorError(1, "identity_mismatch", "pass --team or pin the child's cwd to the parent root",
      `child resolved team='${child.team}' root='${child.rootReal}' registry='${child.registryLocation}'; parent pinned team='${parent.team}' root='${parent.rootReal}' registry='${parent.registryLocation}'`);
  }
}

/** No machine index means no enrolled team: every install is born live (F1). */
export const NO_MACHINE_INDEX = "no machine index (global-registry.json); this machine has no enrolled team";
export function noMachineIndex(): SelectorError {
  return new SelectorError(1, "unanchored_bus", "tap init  OR  tap session launch", NO_MACHINE_INDEX);
}
/** Verbs that remap selection failures to their own refusal must let this one through: its next step is `tap init`. */
export function isNoMachineIndex(error: { errorClass: string; detail: string }): boolean {
  return error.errorClass === "unanchored_bus" && error.detail === NO_MACHINE_INDEX;
}

function requireMarker(indexHome?: string): void {
  const marker = flipMarkerState(indexHome);
  if (marker === "invalid") {
    throw new SelectorError(1, "invalid_flip", "tap doctor",
      "registry flip marker is present but invalid; refusing rather than skipping a v0.20 obligation");
  }
  if (marker === "absent") throw noMachineIndex();
}

function selectExplicitTeam(team: string, indexHome: string | undefined): Selection {
  if (!validToken(team) || team.includes("/")) {
    throw new SelectorError(1, "usage_error", "tap help",
      `--team '${team}' fails charset ^[A-Za-z0-9][A-Za-z0-9._-]*$`);
  }
  return { ...bindTeam(team, indexHome), source: "explicit-team", marker: "live" };
}

function bindTeam(
  team: string,
  indexHome: string | undefined,
): Pick<Selection, "team" | "rootReal" | "registryLocation" | "registryLocationReal" | "busHome" | "busRule" | "authority"> {
  const r = resolveTeamFromGlobal(globalRegistryPath(indexHome), team);
  if (r.status === "invalid") {
    throw new SelectorError(1, "invalid_flip", "tap doctor", r.detail || "global registry unreadable");
  }
  if (r.status === "historical") {
    throw new SelectorError(1, "historical_team", "tap doctor",
      `team '${team}' is historical (not delivery-addressable)`);
  }
  if (r.status === "missing") {
    throw new SelectorError(1, "unknown_team", "tap register",
      `--team '${team}' is not enrolled in the machine index`);
  }
  if (r.status === "unreachable" || !r.registryLocation || !readableFile(r.registryLocation)) {
    throw new SelectorError(1, "live_unreachable", "tap doctor",
      `acting registry for team '${team}' is unreachable`);
  }
  const rootReal = realOrSelf(r.root);
  const pin = actingPin(r.registryLocation);
  const busHome = busHomeForEnrolled(rootReal);
  return {
    team,
    rootReal,
    ...pin,
    busHome,
    busRule: busRuleForHome(busHome),
    authority: "enrolled",
  };
}

function bindPinnedRoot(rootReal: string, indexHome: string | undefined): Selection {
  const at = enrollmentAt(rootReal, indexHome);
  if (at.status === "invalid") {
    throw new SelectorError(1, "invalid_flip", "tap doctor",
      "registry flip marker is present but invalid; refusing rather than skipping a v0.20 obligation");
  }
  if (at.status === "ambiguous") {
    throw new SelectorError(1, "ambiguous_team", "tap doctor",
      `more than one enrolled team realpaths to '${rootReal}'`);
  }
  if (at.status === "unreachable") {
    throw new SelectorError(1, "live_unreachable", "tap doctor",
      `enrolled team '${at.name}' at '${rootReal}' has an unreachable acting registry`);
  }
  if (at.status !== "ok") {
    throw new SelectorError(1, "unanchored_bus", "pin an enrolled team root, or pass --team",
      `pinned root '${rootReal}' is not an enrolled team (no ancestor or TAP_HOME fallback)`);
  }
  const pin = actingPin(at.registryLocation);
  const busHome = busHomeForEnrolled(at.rootReal);
  return {
    team: at.name,
    rootReal: at.rootReal,
    ...pin,
    busHome,
    busRule: busRuleForHome(busHome),
    source: "pinned-root",
    marker: "live",
    authority: "enrolled",
  };
}

function selectFromWalk(
  startReal: string,
  indexHome: string | undefined,
  env: NodeJS.ProcessEnv,
  source: SelectorSource,
): Selection {
  const hit = nearestEnrollment(startReal, indexHome);
  if (hit) {
    const pin = actingPin(hit.registryLocation);
    const busHome = busHomeForEnrolled(hit.rootReal);
    return {
      team: hit.name,
      rootReal: hit.rootReal,
      ...pin,
      busHome,
      busRule: busRuleForHome(busHome),
      source,
      marker: "live",
      authority: "enrolled",
    };
  }
  return tapHomeOrDefault(startReal, indexHome, env);
}

function tapHomeOrDefault(
  startReal: string,
  indexHome: string | undefined,
  env: NodeJS.ProcessEnv,
): Selection {
  const homeEnv = env.TAP_HOME;
  if (homeEnv) {
    const { home, rule } = resolveBus(startReal, env);
    const expected = containerRefusal(home);
    if (expected) {
      throw new SelectorError(1, "not_a_bus", "unset TAP_HOME or point it at the bus dir",
        `TAP_HOME='${home}' does not name a bus; expected '${expected}'`);
    }
    // A custom bus whose parent is no enrolled root takes its registry's own
    // stamp: register writes team.worktree_root from the caller's worktree and
    // reads it back as the team's root, so the bus-parent guess disagreed with
    // every such stamp (tap-3vvf5). An enrolled parent keeps its root, so a
    // drifted stamp there still refuses; the ladder judges an adopted root too.
    let root = rule === "env" ? teamRootFromBus(home) : startReal;
    if (rule === "env" && enrollmentAt(root, indexHome).status === "missing") {
      // An old-format file refuses old_store before any stamp in it is trusted.
      const acting = join(home, "registry.json");
      if (readableFile(acting)) refuseOldActingRegistry(acting);
      root = boundRootFromActingFile(acting) || root;
    }
    const at = enrollmentAt(root, indexHome);
    if (at.status === "ok") {
      const pin = actingPin(at.registryLocation);
      const actingBus = busHomeForEnrolled(at.rootReal);
      if (realOrSelf(home) !== realOrSelf(actingBus)) {
        throw new SelectorError(1, "bus_not_acting", "unset TAP_HOME or point it at the team's acting bus",
          `TAP_HOME='${home}' is not the acting bus '${actingBus}' for enrolled team '${at.name}'`);
      }
      return {
        team: at.name,
        rootReal: at.rootReal,
        ...pin,
        busHome: actingBus,
        busRule: "env",
        source: "env",
        marker: "live",
        authority: "enrolled",
      };
    }
    if (at.status === "unreachable") {
      throw new SelectorError(1, "live_unreachable", "tap doctor",
        `TAP_HOME names enrolled team '${at.name}' whose acting registry is unreachable`);
    }
    if (at.status === "ambiguous") {
      throw new SelectorError(1, "ambiguous_team", "tap doctor",
        `TAP_HOME names a root with more than one enrolled team`);
    }
    if (at.status === "invalid") {
      throw new SelectorError(1, "invalid_flip", "tap doctor",
        "registry flip marker is present but invalid; refusing rather than skipping a v0.20 obligation");
    }
    const registryPath = join(home, "registry.json");
    const team = teamNameFromActingFile(registryPath) || basename(realOrSelf(root));
    return {
      team,
      rootReal: realOrSelf(root),
      ...actingPin(registryPath),
      busHome: home,
      busRule: rule,
      source: "env",
      marker: "live",
      authority: "bus",
    };
  }

  const busRoot = repoRoot(startReal);
  busHomeForRoot(busRoot);
  const { home, rule } = resolveBus(busRoot, withoutTapHome(env));
  const expected = containerRefusal(home);
  if (expected) {
    throw new SelectorError(1, "not_a_bus", "unset TAP_HOME or point it at the bus dir",
      `resolved bus '${home}' does not name a bus; expected '${expected}'`);
  }
  const registryPath = join(home, "registry.json");
  const rootReal = realOrSelf(busRoot);
  if (!readableFile(registryPath)) {
    throw new SelectorError(1, "unanchored_bus", "pass --team <team>  OR  set TAP_HOME to the bus directory",
      `cwd-derived bus has no acting registry (${startReal})`);
  }
  return {
    team: teamNameFromActingFile(registryPath) || basename(rootReal),
    rootReal,
    ...actingPin(registryPath),
    busHome: home,
    busRule: rule,
    source: "cwd",
    marker: "live",
    authority: "bus",
  };
}

function canonicalDir(path: string, kind: "cwd" | "pinned_root"): string {
  const action = kind === "cwd" ? "cd to a readable enrolled directory" : "pin a readable enrolled root";
  const unreachable = (detail: string) =>
    new SelectorError(1, "cwd_unreachable", action, detail);
  const proveUsable = (p: string): { dev: number; ino: number } => {
    const st = statSync(p);
    if (!st.isDirectory()) throw unreachable(`${kind} '${path}' is not a directory`);
    accessSync(p, constants.R_OK | constants.X_OK);
    return { dev: st.dev, ino: st.ino };
  };
  try {
    let real: string;
    try {
      real = realpathSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      // Bun 1.4's realpathSync throws ENOENT for an existing directory whose
      // path carries a backslash (tap-e05cw), so every verb would refuse
      // cwd_unreachable where Bash resolves. Recover the physical path through
      // the native platform — after proving the input is a real, readable,
      // searchable directory, and before trusting that the result names the
      // same directory by dev/ino and is itself readable/searchable.
      const input = proveUsable(path);
      real = nativePhysicalPath(path);
      const physical = proveUsable(real);
      if (physical.dev !== input.dev || physical.ino !== input.ino) {
        throw unreachable(`${kind} '${path}' does not match its physical path '${real}'`);
      }
    }
    proveUsable(real);
    return real;
  } catch (error) {
    if (error instanceof SelectorError) throw error;
    throw unreachable(`${kind} '${path}' is deleted or unreadable`);
  }
}

/** Physical path per the native platform when Bun's own realpath throws ENOENT. */
function nativePhysicalPath(path: string): string {
  const probe = spawnSync("/bin/pwd", ["-P"], {
    cwd: path,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const out = probe.status === 0 ? probe.stdout.trim() : "";
  if (!out.startsWith("/")) {
    throw new Error(`native pwd -P failed for '${path}'`);
  }
  return out;
}

function ancestors(start: string, stop?: string): string[] {
  const out: string[] = [];
  let dir = start;
  while (dir) {
    out.push(dir);
    if (dir === stop) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

export function busHomeForEnrolled(rootReal: string): string {
  rootReal = realOrSelf(rootReal);
  // CONTRACT: the enrolled bus belongs to the root, not registry_location.
  return realOrSelf(busHomeForRoot(rootReal));
}

function busRuleForHome(home: string): BusRule {
  const p = realOrSelf(home);
  if (p.endsWith("/.tap/bus")) return "dotdir";
  return "default";
}

export function teamNameFromActingFile(registryPath: string): string {
  try {
    const doc = JSON.parse(pyReadUtf8(registryPath)) as Record<string, unknown>;
    const t = doc.team;
    if (typeof t !== "object" || t === null) return "";
    const name = (t as Record<string, unknown>).name;
    return typeof name === "string" ? name : "";
  } catch {
    return "";
  }
}

/** The acting file's team.worktree_root when it names an existing absolute
 * directory; "" for anything else, so a missing or malformed stamp keeps the
 * caller's fallback. */
function boundRootFromActingFile(registryPath: string): string {
  try {
    const t = (JSON.parse(pyReadUtf8(registryPath)) as Record<string, unknown>).team;
    if (typeof t !== "object" || t === null) return "";
    const root = (t as Record<string, unknown>).worktree_root;
    return typeof root === "string" && isAbsolute(root) && isDir(root) ? root : "";
  } catch {
    return "";
  }
}

function withoutTapHome(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.TAP_HOME;
  return next;
}

function readableFile(p: string): boolean {
  try {
    accessSync(p, constants.R_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Index/path literal for lock identity; canonical realpath for equality only.
 * Every selection arm passes here, so an existing acting registry in an old
 * format refuses as old_store before any reader can mistake it for an empty or
 * foreign roster. A missing, unreadable or unparseable file keeps its existing
 * downstream handling. */
function actingPin(literal: string): { registryLocation: string; registryLocationReal: string } {
  const readable = readableFile(literal);
  if (readable) refuseOldActingRegistry(literal);
  return {
    registryLocation: literal,
    registryLocationReal: readable ? realOrSelf(literal) : literal,
  };
}

function refuseOldActingRegistry(path: string): void {
  const refusal = teamRegistryFileRefusal(path);
  if (refusal) throw new SelectorError(1, refusal.errorClass, refusal.action, refusal.detail);
}

/** Shared cwd enrollment walk; callers own acting-format validation and effects. */
export function nearestEnrollment(
  start: string,
  indexHome?: string,
): Extract<ReturnType<typeof enrollmentAt>, { status: "ok" }> | undefined {
  const startReal = canonicalDir(start, "cwd");
  const snap = loadGlobalRegistry(indexHome);
  if (snap.marker === "absent") throw noMachineIndex();
  if (snap.marker === "invalid" || !snap.doc) {
    throw new SelectorError(1, "invalid_flip", "tap doctor",
      "registry flip marker is present but invalid; refusing rather than skipping a v0.20 obligation");
  }
  // A checkout owns its enrollment boundary, including nested linked worktrees.
  // Outside Git there is no checkout boundary, so retain the full ancestor walk.
  const gitTop = memoizedToplevel(startReal);
  const stop = gitTop !== "" ? realOrSelf(gitTop) : undefined;
  const candidates = ancestors(startReal, stop);
  for (const dir of candidates) {
    const at = enrollmentAtFromDoc(snap.doc, dir);
    if (at.status === "invalid") {
      throw new SelectorError(1, "invalid_flip", "tap doctor",
        "registry flip marker is present but invalid; refusing rather than skipping a v0.20 obligation");
    }
    if (at.status === "ambiguous") {
      throw new SelectorError(1, "ambiguous_team", "tap doctor",
        `more than one enrolled team realpaths to '${dir}'`);
    }
    if (at.status === "unreachable") {
      throw new SelectorError(1, "live_unreachable", "tap doctor",
        `enrolled team '${at.name}' at '${dir}' has an unreachable acting registry`);
    }
    if (at.status === "ok") return at;
  }
  return undefined;
}
