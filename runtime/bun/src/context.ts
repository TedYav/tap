import { verbose } from "./verbose";
// Resolving "where am I and who am I" — the preamble every verb runs.
//
// Both halves are fallible and they fail DIFFERENTLY, which is the whole point:
// an unanchored bus and an unregistered pane need opposite remedies, so they are
// separate refusals rather than one generic error.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";

import { Bus } from "./bus";
import { teamRootFromBus, type BusRule } from "./bushome";
import {
  enrolledSeatForObservedPane,
  PaneLookupError,
  resolveHandleByPane,
  resolvePaneByHarnessSession,
  resolvePaneByRegisteredHandle,
} from "./registry";
import {
  parseTarget,
  NO_MACHINE_INDEX, selectCaller, reportingEnrollment, SelectorError, teamNameFromActingFile, type Selection,
} from "./selector";
import { enrolledNameForRootFromDoc, flipMarkerState, loadGlobalRegistry } from "./index-home";
import { NO_SERVER_ON, physicalSocketPath, serverEpochFromRaw, seedServerIdentity, socketFingerprint, tmux, tmuxReadOnly } from "./tmux";
import { isFile } from "./watch-lease";
import { pidHasAncestor, processRow } from "./process-ancestry";
import { DEFAULT_AGENT_FAMILIES, classifyHolderCommand, readProcessTableMemoized } from "./observe";
import { isOldStoreRefusal } from "./register-authority";
import { nativeOpenCodeCaller, readOpenCodeAncestry } from "./opencode-service";
import { openCodeServerAncestor } from "./opencode-shared";
import { verifySharedSeat } from "./opencode-shared-seat";
import { reportingMemo, reportingMemoActive } from "./invocation-memo";

// Output flags do not alter discovery; selector/socket/environment changes do.
function reportingEnvKey(env: NodeJS.ProcessEnv): string {
  return JSON.stringify(Object.entries(env).filter(([key]) => !["TAP_JSON", "TAP_ONBOARDING_CHECKED"].includes(key)).sort(([a], [b]) => a.localeCompare(b)));
}
const retainedContext = reportingMemo<ResolvedContext>();
const retainedCaller = reportingMemo<CallingPaneObservation>();
const retainedCommonDir = reportingMemo<string | null>();
const retainedUniqueClaim = reportingMemo<void>();

function contextMemoKey(cwd: string, env: NodeJS.ProcessEnv,
  opts?: { explicitTeam?: string; pinnedRoot?: string; paneFallback?: boolean; readOnly?: boolean }): string {
  return JSON.stringify([cwd, reportingEnvKey(env), opts?.explicitTeam, opts?.pinnedRoot, opts?.paneFallback !== false, opts?.readOnly === true]);
}

/** Seed only the reporting scope; the context was resolved live for this call. */
export function seedReportingObservation(ctx: ResolvedContext, caller: CallingPaneObservation,
  env: NodeJS.ProcessEnv = process.env): void {
  if (!reportingMemoActive()) throw new Error("reporting observation needs a synchronous reporting scope");
  retainedContext(contextMemoKey(process.cwd(), env), () => ctx);
  retainedCaller(JSON.stringify([reportingEnvKey(env), false, false]), () => caller);
}

export class TapError extends Error {
  constructor(
    readonly code: number,
    readonly errorClass: string,
    readonly action: string,
    readonly detail: string,
    /**
     * The verb label for the error line, when it is not the router's own token.
     *
     * Bash sets `TAP_VERB` to the SUBCOMMAND-qualified verb — "tap team refresh",
     * not "tap team" — so a subcommand's refusal names itself. Without this the
     * router labels every `tap team *` refusal "tap team:", which is a different
     * sentence from the incumbent's for every subcommand that refuses.
     */
    readonly verbLabel?: string,
    /** `"none"`: refused before any bus or pane effect, so the command may be repeated as-is. */
    readonly effect?: "none",
  ) {
    super(detail);
  }
}

/** The selector's absent-marker refusal for entries that read the index before any selector (F2b). */
export function noMachineIndexError(verbLabel?: string): TapError {
  return new TapError(1, "unanchored_bus", "tap init  OR  tap session launch", NO_MACHINE_INDEX, verbLabel);
}

export { repoRoot } from "./bushome";

/**
 * The team root that OWNS a bus, derived from the bus path itself.
 *
 *   <root>/.tap/bus -> <root>      (canonical)
 *
 * This is why it exists rather than always using the cwd's git root: an explicit
 * TAP_HOME names a bus that may belong to a DIFFERENT tree than the caller's
 * cwd. Deriving the root from cwd in that case binds the seat to the wrong
 * worktree, which the register-time scope check then correctly refuses — the
 * failure looks like a scope bug and is actually a resolution bug.
 */
export { teamRootFromBus } from "./bushome";

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * The authority team for spool qualification -- the incumbent
 * `tap_spool_team_name`'s mapping, native and single-owned.
 *
 * Post-flip the team is the GLOBAL enrollment key for the bus's own root,
 * never the acting file's `team.name`: that content is pre-authority, and a
 * decoy or relocated registry must not be resolved by its own claim. A live
 * root that is genuinely unenrolled is its bus-root basename; anything the
 * index cannot answer (absent or invalid marker, ambiguous enrollment,
 * unreachable root) fails closed as empty.
 */
export function spoolTeamName(busHome: string, indexHome?: string): string {
  // ONE GUARDED SNAPSHOT (the resolveTeamMarkerAware shape): the marker
  // classification and the enrollment lookup read the SAME parsed document.
  // Reopening global-registry.json after the classification would be the
  // TOCTOU/FIFO-hang window index-home documents.
  const snap = loadGlobalRegistry(indexHome);
  if (snap.marker !== "live") return "";
  const root = teamRootFromBus(busHome);
  const enrolled = enrolledNameForRootFromDoc(snap.doc ?? {}, root);
  if (enrolled.status === "ok") return enrolled.name;
  // Genuinely unenrolled only. Ambiguous and enrolled-unreachable stay
  // closed: a root the index claims but cannot verify is not a basename.
  if (enrolled.status === "missing") return basename(root);
  return "";
}

export interface Context {
  bus: Bus;
  busRule: BusRule;
  team: string;
  registryPath: string;
  root: string;
  /** Stage 0 pin. Optional so test-constructed contexts stay valid. */
  selection?: Selection;
}

export interface ResolvedContext extends Context {
  marker: "live";
}

/**
 * Resolve the bus and the ACTING registry.
 *
 * Caller-bus selection is the Stage 0 selector (tap-1t0h.1): explicit `--team`,
 * then nearest enrolled cwd ancestor, then TAP_HOME only when that walk finds
 * no enrollment. The acting registry is located through the machine index,
 * never guessed from the bus. `invalid` fails closed rather than falling back
 * to legacy — a marker we cannot read is not permission to ignore it.
 */
export function resolveContext(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  opts?: { explicitTeam?: string; pinnedRoot?: string; paneFallback?: boolean; readOnly?: boolean },
): ResolvedContext {
  if (!reportingMemoActive()) return discoverContext(cwd, env, opts);
  const key = contextMemoKey(cwd, env, opts);
  return retainedContext(key, () => discoverContext(cwd, env, opts));
}

function discoverContext(cwd: string, env: NodeJS.ProcessEnv,
  opts?: { explicitTeam?: string; pinnedRoot?: string; paneFallback?: boolean; readOnly?: boolean }): ResolvedContext {
  if (opts?.explicitTeam === undefined && opts?.pinnedRoot === undefined && opts?.paneFallback !== false) {
    const shared = observeSharedCaller(env, opts?.readOnly);
    if (shared?.kind === "verified" && shared.child) {
      return buildContext(selectCaller({ cwd, env: shared.env, pinnedRoot: shared.match.root }), shared.env);
    }
  }
  let caller: Selection;
  try {
    caller = selectCaller({ cwd, env, explicitTeam: opts?.explicitTeam, pinnedRoot: opts?.pinnedRoot });
  } catch (error) {
    if (!(error instanceof SelectorError)) throw error;
    // Pane-anchored fallback (tap-7s1r U1): ONLY the ordinary cwd-derived
    // `unanchored_bus` — never an explicit --team, a pinned root, or a caller
    // that opted out — may be re-anchored through the calling pane's existing
    // enrollment. ONE conversion boundary: the incumbent TapError is built
    // once here, and a pane fallback miss throws this SAME saved refusal
    // object, never a rebuilt copy.
    const converted = new TapError(error.code, error.errorClass, error.action, error.detail);
    if (error.errorClass === "unanchored_bus"
      && opts?.paneFallback !== false
      && opts?.explicitTeam === undefined && opts?.pinnedRoot === undefined) {
      const anchored = paneAnchorOrUndefined(cwd, env, opts?.readOnly);
      if (anchored) {
        caller = anchored;
      } else {
        throw converted;
      }
    } else {
      throw converted;
    }
  }
  // Pane precedence (tap-djlri): a seat is resolved by its pane, never by its cwd. The cwd walk
  // only picks the DEFAULT team, for a pane no team has registered. When the cwd-selected
  // enrolled team is not the one that holds the calling pane (a seat launched with --workdir
  // into another team's enrolled root), the pane's team is the caller's. The same anchor as
  // above decides, on process-owned evidence (the observed pane, never an inherited TMUX_PANE
  // value): canonical session hint, unique current claim over the whole machine, one git common
  // directory. An anchor on the cwd team itself, or any ordinary miss, keeps the cwd selection,
  // so today's refusals (`unregistered`, `pane_enrolled_elsewhere`) are unchanged for a pane no
  // team can prove. Explicit --team, a pinned root, TAP_HOME and `paneFallback:false` keep
  // their precedence (the launcher opts out: its record selection is cwd-bound), and nothing is
  // observed outside tmux.
  if (caller.source === "cwd" && caller.authority === "enrolled"
    && opts?.paneFallback !== false
    && opts?.explicitTeam === undefined && opts?.pinnedRoot === undefined
    && env.TMUX) {
    const anchored = paneAnchorOrUndefined(cwd, env, opts?.readOnly);
    // The anchor is the revalidated selection: it replaces the walk's whenever any part of the
    // selection identity differs (team, root, registry path or its realpath, bus), which covers
    // an index rewrite between the two reads. Only an identical selection keeps the walk's.
    if (anchored && !sameSelection(anchored, caller)) caller = anchored;
  }
  return buildContext(caller, env);
}

/** A cache-hit candidate for a reporting command; no live caller or Git probes. */
export function reportingContext(cwd: string, env: NodeJS.ProcessEnv, explicitTeam?: string): ResolvedContext | null {
  try {
    if (explicitTeam) return resolveContext(cwd, env, {explicitTeam, paneFallback:false});
    // Native shared-service children can belong to a root seat outside cwd.
    // Keep their existing resolver; do not probe service identity for a cache hit.
    if (env.OPENCODE_SESSION_ID !== undefined) return null;
    if (env.TAP_HOME || env.GIT_DIR || env.GIT_WORK_TREE) return null;
    const hit = reportingEnrollment(cwd, env.TAP_INDEX_HOME);
    if (!hit) return null;
    // A pane registered elsewhere keeps the normal pane-precedence resolver.
    // This is a display hint, never an effect's identity proof.
    if (env.TMUX) {
      const seats = JSON.parse(readFileSync(hit.registryLocation, "utf8"))?.seats;
      if (!env.TMUX_PANE || !seats || !Object.values(seats).some(row => row && typeof row === "object"
        && (row as Record<string, unknown>).pane_id === env.TMUX_PANE)) return null;
    }
    return resolveContext(cwd, env, {pinnedRoot:hit.rootReal, paneFallback:false});
  } catch { return null; }
}

function sameSelection(a: Selection, b: Selection): boolean {
  return a.team === b.team && a.rootReal === b.rootReal && a.registryLocation === b.registryLocation
    && a.registryLocationReal === b.registryLocationReal && a.busHome === b.busHome;
}

/** Assemble the resolved context from a selection. */
function buildContext(caller: Selection, env: NodeJS.ProcessEnv): ResolvedContext {
  verbose("state_paths", { registry: caller.registryLocation, bus: caller.busHome,
    spool: `${caller.busHome}/spool` }, env);
  return {
    bus: new Bus(caller.busHome),
    busRule: caller.busRule,
    marker: caller.marker,
    team: caller.team,
    registryPath: caller.registryLocation,
    root: caller.rootReal,
    selection: caller,
  };
}

/**
 * Re-anchor an unanchored cwd through the calling pane's existing enrollment.
 *
 * Returns the pane-anchored selection, or undefined on every ordinary miss
 * (non-resolving, malformed, unobservable, mismatched — the caller then throws
 * its saved original refusal). A cross-team contest is the one intentional
 * exception: it throws `pane_contested`.
 */
function paneAnchorOrUndefined(cwd: string, env: NodeJS.ProcessEnv, readOnly = false): Selection | undefined {
  try {
    return attemptPaneAnchor(cwd, env, readOnly);
  } catch (error) {
    if (error instanceof TapError && error.errorClass === "pane_contested") throw error;
    if (isOldStoreRefusal(error)) throw error;
    return undefined;
  }
}

function attemptPaneAnchor(cwd: string, env: NodeJS.ProcessEnv, readOnly: boolean): Selection {
  const indexHome = env.TAP_INDEX_HOME;
  const snapshot = loadGlobalRegistry(indexHome);
  if (snapshot.marker !== "live" || !snapshot.doc) {
    throw new Error("pane anchoring needs a live machine index marker");
  }
  const seen = observeCallerIdentity(env, readOnly);
  if (seen.state !== "inside") {
    throw new Error("pane anchoring needs an observable calling pane inside tmux");
  }
  // The observed session name is a HINT ONLY: the handle half is never
  // trusted (crew seats share their driver's session), and the authoritative
  // row is read from the actual registered entry after exact checks.
  const hint = parseTarget(seen.session);
  // The hint is the EXACT canonical tmux session `team/handle`: parseTarget
  // would also accept legacy `team:handle` or padded spellings, and neither
  // may confer team scope.
  if (!hint.qualified || seen.session !== `${hint.team}/${hint.handle}`) {
    throw new Error(`pane session '${seen.session}' is not a canonical team/handle hint`);
  }
  const scoped = enrolledSeatForObservedPane(seen.paneId, seen.session, seen.serverEpoch, indexHome, { team: hint.team });
  if (scoped.kind !== "resolved" || scoped.team !== hint.team) {
    throw new Error(scoped.kind === "resolved"
      ? `the enrolled row names team '${scoped.team}', not the hinted '${hint.team}'`
      : `no current enrolled row in '${hint.team}' claims pane ${seen.paneId} (${scoped.kind})`);
  }
  // Uniqueness is judged over the WHOLE machine enrollment: a second team
  // claiming the same pane is an ordinary failed anchor, so the saved
  // original refusal reaches each verb's own handler, which recomputes the
  // typed contest verdict with the verb's own exit code.
  if (!reportingMemoActive()) requireMachineUniqueClaim(seen, indexHome);
  // Same-repository check: a foreign-repo cwd never selects the pane team.
  const callerDir = gitCommonDir(cwd, env);
  const teamDir = gitCommonDir(scoped.root, env);
  if (!callerDir || !teamDir || callerDir !== teamDir) {
    throw new Error(`cwd and enrolled team root do not share one git repository (${cwd} vs ${scoped.root})`);
  }
  // FINAL row validation, after the probes: the freshest read decides, and
  // the returned selection binds to the registry that supplied this row.
  const final = enrolledSeatForObservedPane(seen.paneId, seen.session, seen.serverEpoch, indexHome, { team: hint.team });
  if (final.kind !== "resolved" || final.team !== hint.team || final.handle !== scoped.handle
    || !final.registryLocation || realpathSync(final.root) !== realpathSync(scoped.root)) {
    throw new Error("the enrolled row drifted before the context was returned");
  }
  // Global uniqueness is checked after the probes (tap-sbvgt): another
  // team can enroll a current claim on this pane while git runs, and the
  // scoped read above only sees the hinted team. Reports use this one check;
  // effect-bearing callers retain both live checks.
  requireMachineUniqueClaim(seen, indexHome);
  const caller = selectCaller({ cwd, env, pinnedRoot: scoped.root });
  if (caller.authority !== "enrolled"
    || caller.team !== final.team || caller.rootReal !== realpathSync(final.root)
    || caller.registryLocationReal !== realpathSync(final.registryLocation)
    // The literal path too (tap-a9lcr): it is the lock-sidecar identity, so a symlink alias to the
    // same file written into the index after the final read must not anchor a second lock.
    || caller.registryLocation !== final.registryLocation) {
    throw new Error("the pinned-root re-entry no longer matches the final enrolled row");
  }
  return { ...caller, source: "pane" };
}

/**
 * Fail-closed uniqueness veto over the WHOLE machine enrollment: contested AND
 * unverified (an unreadable acting registry leaves uniqueness unproven) both
 * fail the anchor; only a positively resolved machine enrollment may anchor.
 * Another team's data-gone registry holds no rows and does not veto
 * (tap-xbpuc).
 */
function requireMachineUniqueClaim(
  seen: { paneId: string; session: string; serverEpoch: string },
  indexHome: string | undefined,
): void {
  return retainedUniqueClaim(JSON.stringify([seen.paneId, seen.session, seen.serverEpoch, indexHome]), () => {
    const unscoped = enrolledSeatForObservedPane(seen.paneId, seen.session, seen.serverEpoch, indexHome);
    if (unscoped.kind === "contested" || unscoped.kind === "unverified") {
      throw new Error(`pane ${seen.paneId} cannot be resolved to one seat; ${unscoped.kind === "contested" ? unscoped.evidence : (unscoped as { evidence?: string }).evidence}`);
    }
  });
}

export function gitCommonDir(dir: string, env: NodeJS.ProcessEnv): string | null {
  if (!reportingMemoActive()) return probeGitCommonDir(dir, env);
  return retainedCommonDir(JSON.stringify([realOrSelf(dir), reportingEnvKey(env)]), () => probeGitCommonDir(dir, env));
}

function probeGitCommonDir(dir: string, env: NodeJS.ProcessEnv): string | null {
  // Repository discovery must not inherit the caller's Git routing vars:
  // GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR & co. can make an unrelated
  // repository report the SAME common directory and fake a same-repo match.
  const probeEnv: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(probeEnv)) {
    if (key.startsWith("GIT_")) delete probeEnv[key];
  }
  const probe = spawnSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8", env: probeEnv,
  });
  if (probe.status !== 0 || !(probe.stdout ?? "").trim()) return null;
  try {
    return realpathSync(probe.stdout.trim());
  } catch {
    return null;
  }
}

/**
 * THE EXIT CODE IS THE CALLER'S, NOT THIS FUNCTION'S — and there is no default.
 *
 * CONTRACT.md scopes `unanchored_bus`/4 to `poll`, `outstanding` and `peek`;
 * `send`'s own exit-code contract RETIRES 4 and refuses with 1 here; and
 * `whoami` is not in the class at all — the deleted `tap-whoami.sh` called
 * `tap_fail_unregistered_pane` with no code argument, so it takes the default 2.
 *
 * This used to hardcode 4 for every caller, which made `whoami` on an
 * unanchored cwd exit 4 where the incumbent exits 2. Thirty green oracle arms
 * said nothing about it, because every one of them ran somewhere a registry
 * existed. A required parameter is the fix: a new caller cannot inherit another
 * verb's exit code by omission.
 */

/**
 * The cwd as the OPERATOR sees it, not as the kernel resolves it.
 *
 * macOS aliases /tmp -> /private/tmp, so an operator standing in
 * /tmp/x and a realpath of /private/tmp/x are the same directory with two
 * names. The incumbent prints `$PWD` — the logical path the shell handed it —
 * and the lane rubric includes byte fidelity with the incumbent, so printing
 * the physical path is a divergence even though it names the same place
 * (partner review).
 *
 * AUTHORITY STILL RESOLVES ON THE PHYSICAL PATH. This is display only, and it
 * falls back the moment PWD cannot be shown to name the same directory: an
 * inherited-but-stale PWD from a parent process must never be echoed back as
 * where the caller is.
 */
export function displayCwd(physical: string, env: NodeJS.ProcessEnv = process.env): string {
  const logical = env.PWD;
  if (!logical) return physical;
  try {
    if (realpathSync(logical) === realpathSync(physical)) return logical;
  } catch {
    return physical;
  }
  return physical;
}

export function requireActingRegistry(ctx: Context, code: number): void {
  if (!isFile(ctx.registryPath)) {
    throw new TapError(code, "unanchored_bus", `pass --team <team>  OR  set TAP_HOME to the bus directory`,
      `cwd-derived bus has no acting registry (${displayCwd(ctx.root)})`);
  }
}

/**
 * The pane that owns this process's controlling TTY, when uniquely observable.
 *
 * TMUX_PANE is caller-controlled and tmux itself trusts an override, so it is
 * not identity evidence. Walk to the first controlling TTY, map that TTY to one
 * pane, then reassert the same binding with a targeted query.
 */
/**
 * Where the caller is, as a typed answer rather than an absence.
 *
 * `callingPane()` below answers `null` for EIGHT different facts: `ps` gave
 * nothing, `list-panes` failed, the controlling tty matched two panes, the
 * targeted re-query failed, the ppid was not a number, the ancestry reached
 * init, the walk ran out of steps -- and, buried among them, the one positive
 * answer, "a controlling tty was observed and no pane on this server owns it".
 * Seven refusals and a verdict, all spelled the same way.
 *
 * That conflation is load-bearing for `attach`: CONTRACT.md licenses the
 * inherited-`$TMUX` outside arm (`env -u TMUX -u TMUX_PANE tmux -S <sock>
 * attach-session`) only on POSITIVE outside evidence, and a `null` that might be
 * a failed observation must refuse rather than attach.
 *
 * The mapping is the incumbent's, taken from `tap_calling_pane_observe`
 * (lib.sh) rather than re-derived here. `tap_calling_pane_fail` defaults its
 * state to `unobservable`, and across that whole function EXACTLY ONE call site
 * passes `outside` -- the one whose sentence is "observed caller terminal is not
 * owned by a pane on this tmux server". That sentence is unique in lib.sh and is
 * the durable citation; the line number it sits on has already moved once while
 * this PR was open. In particular the ancestry-ended case -- walking to pid 1
 * without ever finding a controlling terminal -- is `unobservable` there, and
 * that is correct: "I never found a terminal" is not evidence that the caller is
 * outside a pane, and reading it as one would license attach's outside arm for a
 * process with no controlling terminal at all.
 *
 * `outside` carries the incumbent's sentence under `detail`, not `refusal`: the
 * string exists for parity and for diagnostics, but nothing about a positive
 * answer should read as a reason to refuse.
 */
export type CallingPaneObservation =
  | { state: "inside"; paneId: string; session: string; serverEpoch: string;
      selectedHandle?: string; selectedInstance?: string; selectedSocket?: string; selectedPane?: string;
      address?: string; panePid?: string; currentCommand?: string; currentPath?: string; socketPath?: string }
  | { state: "outside"; detail: string; climb?: string }
  | { state: "unobservable"; refusal: string; paneId?: string; unverifiable?: true; missing?: "session" | "epoch"; session?: string; shared?: true };

/** Native shell evidence may name a seat; it never makes the service's tty
 * the caller's terminal. Physical operations keep observeCallingPane. */
export function observeCallerIdentity(env: NodeJS.ProcessEnv = process.env, readOnly = false, extended = false): CallingPaneObservation {
  if (!reportingMemoActive()) return discoverCallerIdentity(env, readOnly, extended);
  return retainedCaller(JSON.stringify([reportingEnvKey(env), readOnly, extended]), () => discoverCallerIdentity(env, readOnly, extended));
}

function discoverCallerIdentity(env: NodeJS.ProcessEnv, readOnly: boolean, extended: boolean): CallingPaneObservation {
  const shared = observeSharedCaller(env, readOnly);
  if (!shared) return observeCallingPane(env, readOnly, extended);
  if (shared.kind === "refused") return { state: "unobservable", refusal: sharedCallerRefusal(shared.reason), shared: true };
  const row = shared.match.row;
  return { state: "inside", ...shared.pane, selectedHandle: shared.match.handle,
    selectedInstance: row.instance as string, selectedSocket: row.server_socket as string, selectedPane: row.pane as string };
}

export function observeSharedCaller(env: NodeJS.ProcessEnv = process.env, readOnly = false) {
  const proof = nativeOpenCodeCaller(env);
  if (proof.kind === "none") return null;
  if (proof.kind === "refused") return proof;
  const binding = verifySharedSeat(proof, env, (target, pinned, socket) => {
    const pane = observeIdentityPane(target, pinned, socket, readOnly);
    return pane.status === "ok" ? pane : null;
  });
  if (binding.kind === "refused") return binding;
  const child = proof.sessionId !== proof.rootSessionId;
  if (child) {
    // Native child tools inherit the service env. Carry the verified root pins
    // into subsequent in-process effect code, whose tmux helpers use this env.
    for (const key of ["TAP_HOME", "TAP_LOCK_DIR", "TAP_TMUX_SOCKET_PATH", "TMUX_PANE"]) env[key] = binding.env[key];
    delete env.TAP_TMUX_SOCKET;
    env.TMUX = `${binding.env.TAP_TMUX_SOCKET_PATH},0,0`;
  }
  return { ...binding, child };
}

function sharedCallerRefusal(reason: string): string {
  return `OpenCode shared caller refused (${reason}); use the native shell tool; if its binding changed, run tap session relaunch <handle>`;
}

/** An inherited service-wide actor must not override an attested shell seat.
 * Call only after an explicit --from/--by/positional actor has been selected. */
export function inheritedActor(env: NodeJS.ProcessEnv = process.env): string {
  const actor = env.TAP_SELF || "";
  if (!actor) return "";
  const shared = observeSharedCaller(env);
  if (shared && (shared.kind === "refused" || actor !== shared.match.handle))
    throw new TapError(1, "shared_actor_mismatch", "unset TAP_SELF and retry from the native shell tool",
      shared.kind === "refused" ? sharedCallerRefusal(shared.reason) : `inherited TAP_SELF '${actor}' disagrees with the verified shared seat '${shared.match.handle}'`);
  return actor;
}

export function observeCallingPane(env: NodeJS.ProcessEnv = process.env, readOnly = false, extended = false): CallingPaneObservation {
  const processes = readOpenCodeAncestry(env);
  const boundary = processes ? openCodeServerAncestor(processes, process.pid) : { kind: "unobservable" as const };
  if (boundary.kind === "unobservable") return { state: "unobservable", refusal: "OpenCode server boundary could not be observed" };
  if (boundary.kind === "server" && !boundary.private)
    return { state: "unobservable", refusal: "OpenCode service tools have no physical calling pane", shared: true };
  const probe = readOnly ? tmuxReadOnly : tmux;
  const reporting = reportingMemoActive() && !extended;
  const inventoryFormat = reporting ? "#{pane_id}\t#{pane_tty}\t#{session_name}\t#{pid}:#{start_time}" : "#{pane_id}\t#{pane_tty}";
  let pid = process.pid;

  for (let steps = 0; steps < 64; steps++) {
    // The row parse (Bash IFS, record boundary, libproc fallback) lives in
    // process-ancestry.ts, shared with the pane-ownership proofs.
    const row = processRow(pid, env);
    if (!row) {
      return { state: "unobservable", refusal: `process observation unavailable for pid '${pid}'` };
    }
    const parentRaw = row.ppid;
    const ttyRaw = row.tty;

    if (!["", "?", "??", "-"].includes(ttyRaw)) {
      let paneTty = ttyRaw.startsWith("/dev/") ? ttyRaw : `/dev/${ttyRaw}`;
      // Remain-on-exit panes retain a tty after the OS can reuse it.
      const inventory = probe(["list-panes", "-a", "-f", "#{!=:#{pane_dead},1}", "-F", inventoryFormat], env);
      if (inventory.rateLimited) {
        return { state: "unobservable", refusal: "tmux is rate limiting; the pane inventory is unavailable", paneId: "", unverifiable: true };
      }
      if (inventory.code !== 0) {
        return { state: "unobservable", refusal: "tmux could not list panes: usually no tmux server is running, or you are outside tmux" };
      }

      let found = "";
      let reportingRecord = "";
      for (const line of inventory.stdout.split("\n")) {
        const [candidate, candidateTty] = line.split("\t", 2);
        // A non-empty record whose FIRST field is empty is malformed: Bash's
        // `IFS=$'\t' read` strips leading IFS whitespace and would read the
        // fields one slot over, so the two parsers disagree about what this row
        // says. Refusing is the narrow direction -- Bash resolves such a row and
        // this does not -- and the narrow direction is the right one here,
        // because the alternative is to widen identity acceptance inside a
        // change whose whole purpose is to stop claiming more than was observed.
        // Silently treating it as "no pane owns my tty" is the one outcome that
        // must not happen: that is a positive outside verdict built on a record
        // neither parser agrees on.
        if (line !== "" && candidate === "") {
          return { state: "unobservable", refusal: `pane inventory record is not a pane-id/tty pair: '${line}'` };
        }
        if (candidateTty !== paneTty) continue;
        if (found) {
          return { state: "unobservable", refusal: `controlling tty '${paneTty}' maps to multiple panes` };
        }
        found = candidate ?? "";
        reportingRecord = line;
      }
      // The first observed controlling TTY belongs either to this tmux server
      // or to somewhere else. Never climb past it on ancestry alone and borrow
      // an ancestor pane: a terminal-emulator window spawned from the pane, a
      // nested foreground multiplexer, or a session leader that opened a pane
      // tty by path all descend from pane processes without living in the
      // pane. The ONE admitted climb is through a harness that holds this
      // terminal for its own tool (Antigravity's run_command allocates a
      // fresh pty per command while agy itself stays on the pane tty); see
      // climbHeldTerminal for its four conditions. Anything else keeps the
      // positive outside verdict, carrying the climb's refusal as diagnostics.
      //
      // THIS is the one positive answer in the function: a terminal was
      // observed, the inventory answered, and no pane on this server owns it.
      if (!found) {
        const climbed = climbHeldTerminal(pid, paneTty, inventory.stdout, probe, env);
        if (climbed.state !== "held") return climbed;
        found = climbed.found;
        paneTty = climbed.paneTty;
      }

      // The default mode stays the incumbent's FOUR-field identity record,
      // byte-identical to origin/main: this is a shared primitive nearly every
      // verb calls, so its probe shape is load-bearing far beyond register.
      //
      // Extended mode (register's caller arm only, threaded through
      // observeCallerPaneChain) reads a NINE-field record at minimum: the four
      // identity fields (id, tty, session, server generation), four
      // descriptive facts (address, pane pid, current command, socket) — and
      // the current path LAST, because a path is free text and a tab in it
      // must not refuse the whole registration: the fast path applies only
      // when the split is EXACTLY nine fields, and any extra tab sends every
      // descriptive fact to its own targeted re-read instead. One atomic
      // record keeps the generation guard intact AND lets the descriptive
      // probes ride the same observation instead of five more
      // display-messages that could straddle a pane death between them.
      // A NEWLINE in a path stays a refusal: the record is read by first
      // line, and a newline genuinely corrupts it.
      // The socket fingerprint captured here pairs the record's epoch with
      // the server that answered it: the seed below refuses to write when a
      // rebirth swapped the socket between probe and seed.
      const identityFormat = extended
        ? "#{pane_id}\t#{pane_tty}\t#{session_name}\t#{pid}:#{start_time}\t#{session_name}:#{window_index}.#{pane_index}\t#{pane_pid}\t#{pane_current_command}\t#{socket_path}\t#{pane_current_path}"
        : "#{pane_id}\t#{pane_tty}\t#{session_name}\t#{pid}:#{start_time}";
      const socketBefore = extended ? socketFingerprint(physicalSocketPath(env)) : "";
      // A report can use the inventory's identity record. Effect-bearing
      // callers still reassert the binding with a fresh targeted query.
      const observed = reporting && reportingRecord
        ? { code: 0, stdout: reportingRecord, rateLimited: false }
        : probe(["display-message", "-p", "-t", found, identityFormat], env);
      if (observed.rateLimited) {
        return { state: "unobservable", refusal: "tmux is rate limiting; the pane identity record is unavailable", paneId: found, unverifiable: true };
      }
      // Same sentence as the mismatch arm below, deliberately: the incumbent
      // swallows a failed display-message with `|| true`, so an empty record
      // reaches its id/tty comparison and emits exactly this. Two conditions,
      // one refusal, because that is what Bash produces.
      if (observed.code !== 0) {
        return { state: "unobservable", refusal: `pane '${found}' no longer owns controlling tty '${paneTty}'` };
      }
      const fields = observed.stdout.split("\n", 1)[0]!.split("\t");
      if (extended) {
        // AT LEAST nine fields, with the tail joined into the path: the path
        // is free text and may itself contain tabs. The strict count that
        // guards the default record against a short record shifting fields
        // into the wrong slots applies here to the first EIGHT fields
        // (identity + address/pid/command/socket), while everything after
        // the socket field belongs to the path. A record with too FEW fields
        // is still refused outright: a missing delimiter shifts generation
        // into the session slot; the field is non-empty so the empty-session
        // check passes, and a matching current-generation row resolves as
        // SELF (tap-316wj).
        if (fields.length < 9) {
          return { state: "unobservable", refusal: "observation is not a nine-field record" };
        }
      } else if (fields.length !== 4) {
        // EXACT four-field arity, not "at least four". `split("\t", 4)`
        // truncated a longer record and silently dropped the remainder, so a
        // five-field response parsed as a valid four-field one and this
        // function returned `inside` -- granting identity on a record the
        // incumbent refuses. The incumbent's own comment names the attack:
        // "A missing delimiter shifts generation into the session slot; the
        // field is non-empty so the empty-session check passes, and a
        // matching current-generation row resolves as SELF (tap-316wj)."
        // Found by review against the deleted Bash
        // door, which is the only reason it was still findable.
        return { state: "unobservable", refusal: "observation is not a four-field record" };
      }
      const [observedId = "", observedTty = "", session = "", epochRaw = ""] = fields;
      let address = "", panePid = "", currentCommand = "", socketPath = "", currentPath = "";
      if (extended) {
        address = fields[4] ?? "";
        panePid = fields[5] ?? "";
        currentCommand = fields[6] ?? "";
        // The fast path applies only when the split is EXACTLY nine fields:
        // the command, socket and path are all free text, so any extra tab
        // is ambiguous between them and everything after the command shifts.
        // The provably-safe prefix stays atomic — pane id, tty, session and
        // the server generation: tmux refuses tab characters in session
        // names at both new-session and rename-session (verified live), the
        // tty is a kernel-generated device path, and the generation carries
        // the strict pid:start grammar whose misalignment a tab earlier in
        // the record would break. The ambiguous tail takes the old separate
        // targeted reads for EVERY descriptive fact — address, pane pid,
        // command, socket and path — and a failed read leaves the fact
        // empty, as a record without it would. Socket normalization strips
        // only the trailing newline (the first line), never whitespace,
        // matching the record's own socket byte-for-byte.
        if (fields.length === 9) {
          socketPath = fields[7] ?? "";
          currentPath = fields[8] ?? "";
        } else {
          const readFact = (format: string) => probe(["display-message", "-p", "-t", found, format], env);
          const rate = "tmux is rate limiting; the pane identity record is unavailable" as const;
          const addr = readFact("#{session_name}:#{window_index}.#{pane_index}");
          if (addr.rateLimited) {
            return { state: "unobservable", refusal: rate, paneId: found, unverifiable: true };
          }
          address = addr.code === 0 ? addr.stdout.split("\n", 1)[0] ?? "" : "";
          const pid = readFact("#{pane_pid}");
          if (pid.rateLimited) {
            return { state: "unobservable", refusal: rate, paneId: found, unverifiable: true };
          }
          panePid = pid.code === 0 ? pid.stdout.split("\n", 1)[0] ?? "" : "";
          const cmd = readFact("#{pane_current_command}");
          if (cmd.rateLimited) {
            return { state: "unobservable", refusal: rate, paneId: found, unverifiable: true };
          }
          currentCommand = cmd.code === 0 ? cmd.stdout.split("\n", 1)[0] ?? "" : "";
          const sock = readFact("#{socket_path}");
          if (sock.rateLimited) {
            return { state: "unobservable", refusal: rate, paneId: found, unverifiable: true };
          }
          socketPath = sock.code === 0 ? sock.stdout.split("\n", 1)[0] ?? "" : "";
          const path = readFact("#{pane_current_path}");
          if (path.rateLimited) {
            return { state: "unobservable", refusal: rate, paneId: found, unverifiable: true };
          }
          currentPath = path.code === 0 ? path.stdout.split("\n", 1)[0] ?? "" : "";
        }
      }
      // THE PANE-ID GRAMMAR IS CHECKED BEFORE EVERY OTHER FIELD CHECK.
      //
      // `%` followed by ASCII digits. Not a message preference -- a placement
      // one. `generation_unverifiable` prescribes "do NOT re-register", and
      // that is the wrong instruction for a value that is not a pane id at all;
      // CONTRACT says so explicitly. So a malformed id must not be able to
      // reach ANY refusal that carries that remedy, whatever else is also wrong
      // with the record.
      //
      // I arrived here in two corrections, and the second is the lesson. I
      // first checked this LAST and wrote that it was last "so a record
      // malformed in more than one way reports the incumbent's reason" -- false,
      // and the reviewer disproved it with a garbled id plus a
      // missing GENERATION. I then moved it ahead of the generation check only,
      // which fixed their specimen and left its sibling: the partner reviewer
      // immediately found a garbled id plus a missing SESSION still entering
      // exit 2. Fixing the instance a reviewer hands you is not fixing the
      // class; the class here is "a malformed id reaches a remedy that assumes
      // a real pane", and the only placement that closes it is first.
      //
      // The message may now differ from the incumbent on a multiply-malformed
      // record (it reports the id where Bash reports the session). That is a
      // SAFE-DIRECTION message deviation, explicitly allowed by the reviewer
      // who found it: the verdict and remedy are what may not differ, and both
      // doors refuse with exit 1.
      //
      // NOT `isPaneId` from ./observe: that one mirrors Python's
      // `str.isdigit()` and admits superscripts and circled digits, so it is
      // WIDER than the shell's `*[!0-9]*`. Reusing it would have reopened this
      // hole one alphabet over -- the C1 path-token rule verbatim, native must
      // never accept what the incumbent refuses.
      if (!/^%[0-9]+$/.test(observedId)) {
        return { state: "unobservable", refusal: "malformed pane id" };
      }
      // The incumbent refuses these separately and this port merged them under a
      // sentence no Bash path can emit (review, additive
      // pre-read). Split back to the incumbent's own two, with the CONDITIONS
      // left exactly as they were: the combined check's `unverifiable` state is
      // pre-existing behaviour of this function, and re-typing it is not this
      // unit's job. Only the strings move.
      if (observedId !== found || observedTty !== paneTty) {
        return { state: "unobservable", refusal: `pane '${found}' no longer owns controlling tty '${paneTty}'`, paneId: observedId || found, unverifiable: true };
      }
      if (!session) {
        return { state: "unobservable", refusal: "observation is missing a session name", paneId: observedId || found, unverifiable: true, missing: "session" };
      }
      const serverEpoch = serverEpochFromRaw(epochRaw, env);
      if (!serverEpoch) {
        return { state: "unobservable", refusal: "observation carries no usable tmux server generation", paneId: observedId, unverifiable: true, missing: "epoch", session };
      }
      if (extended) {
        // The record's own `pid:start_time` IS the server identity tmux.ts
        // caches; seeding that cache here saves every later caller of
        // serverIdentity() (its TTL is 100 ms, so without this the first
        // post-record caller re-probes) the display-message it would spend.
        seedServerIdentity(env, epochRaw, socketBefore, readOnly);
        return { state: "inside", paneId: observedId, session, serverEpoch,
          address, panePid, currentCommand, currentPath, socketPath };
      }
      return { state: "inside", paneId: observedId, session, serverEpoch };
    }

    if (!/^[0-9]+$/.test(parentRaw)) {
      return { state: "unobservable", refusal: `process observation returned invalid parent pid '${parentRaw}'` };
    }
    const parent = Number(parentRaw);
    if (parent <= 1 || parent === pid) {
      // NOT `outside`. The incumbent calls this unobservable and it is right:
      // the walk found no controlling terminal, which is the absence of
      // evidence, not evidence of absence.
      return { state: "unobservable", refusal: `process ancestry ended before finding a tmux pane (pid '${pid}', parent '${parentRaw}')` };
    }
    pid = parent;
  }
  return { state: "unobservable", refusal: "process ancestry exceeded 64 steps before finding a tmux pane" };
}

/** The incumbent's one positive-outside sentence (lib.sh `tap_calling_pane_observe`); attach keys on the state, whoami prints this. */
const OUTSIDE_DETAIL = "observed caller terminal is not owned by a pane on this tmux server";

type HeldTerminalClimb =
  | { state: "held"; found: string; paneTty: string }
  | Extract<CallingPaneObservation, { state: "outside" | "unobservable" }>;

/**
 * The one admitted climb past a controlling terminal no pane owns: a harness
 * holding that terminal for its own tool. Antigravity's `run_command` runs
 * each command on a fresh pty while `agy` stays on the pane tty, so the
 * caller's first tty is a throwaway and the seat is one boundary up.
 *
 * Four conditions, every one fail-closed back to the positive `outside`
 * verdict the walk already earned (with the refusal as `climb` diagnostics):
 *
 *  1. Walk the run of ancestors on the caller's terminal FIRST_TTY. The
 *     direct parent of its topmost process is the holder. A parent with no
 *     controlling terminal refuses (an emulator launched from a tool child:
 *     claude -> xterm(??) -> zsh), as does the chain ending on FIRST_TTY.
 *  2. The holder's own tty maps to exactly one live pane in the SAME
 *     inventory the walk read -- one list-panes per walk, nothing to race.
 *     A second foreign terminal (an emulator under agy's own tool pty) is
 *     not a pane and refuses.
 *  3. The holder is that pane's pane_pid or descends from it, by the shared
 *     fail-closed ancestry walk. A session leader that acquired a pane tty by
 *     opening the device is not under pane_pid and refuses.
 *  4. The holder's EXECUTABLE classifies as a harness family (comm, argv[0],
 *     or a supported runtime's script entrypoint, never a version-named
 *     native binary proven only under $HOME; never a later argv word,
 *     so `script -q /dev/null claude` and `xterm -e codex exec` refuse --
 *     review, P1 round 3), against the FIXED canonical family set, never the
 *     ambient TAP_OBS_HARNESS_FAMILIES override: that variable is
 *     caller-controlled, and an identity proof may not take its admission
 *     set from the process it is judging (review, P1). An emulator spawned
 *     straight from the pane shell
 *     inherits the pane tty into its own process and passes 2 and 3; it is
 *     not a harness and refuses here. script(1), a nested tmux server, login
 *     and sshd refuse the same way.
 *
 * The caller then re-verifies the pane through the unchanged targeted record
 * (id grammar, id/tty binding, session, server generation). A rate-limited
 * pane_pid read is `unverifiable`, never outside: tmux could not answer, and
 * a seat may well exist. No environment variable takes part -- TMUX_PANE,
 * harness session ids and TAP_LAUNCH_ID are inherited by every descendant,
 * so none can tell a relayed tool terminal from an escaped one.
 */
function climbHeldTerminal(first: number, firstTty: string, inventoryStdout: string,
  probe: (args: string[], env: NodeJS.ProcessEnv) => ReturnType<typeof tmux>, env: NodeJS.ProcessEnv): HeldTerminalClimb {
  const outside = (climb: string): HeldTerminalClimb => ({ state: "outside", detail: OUTSIDE_DETAIL, climb });
  // 1. Through the run on FIRST_TTY to the holder.
  let current = first;
  let holder = 0;
  let holderTty = "";
  for (let hops = 0; hops < 64 && !holder; hops++) {
    const row = processRow(current, env);
    if (!row) return outside(`process observation unavailable for pid '${current}' on terminal '${firstTty}'`);
    if (!/^[0-9]+$/.test(row.ppid)) return outside(`process observation returned invalid parent pid '${row.ppid}'`);
    const parent = Number(row.ppid);
    if (parent <= 1 || parent === current) return outside(`process ancestry ended on terminal '${firstTty}' without reaching a pane`);
    const parentRow = processRow(parent, env);
    if (!parentRow) return outside(`process observation unavailable for pid '${parent}'`);
    if (["", "?", "??", "-"].includes(parentRow.tty)) {
      return outside(`terminal '${firstTty}' is held by pid ${parent}, which has no controlling terminal`);
    }
    const parentTty = parentRow.tty.startsWith("/dev/") ? parentRow.tty : `/dev/${parentRow.tty}`;
    if (parentTty === firstTty) { current = parent; continue; }
    holder = parent;
    holderTty = parentTty;
  }
  if (!holder) return outside(`process ancestry exceeded 64 steps on terminal '${firstTty}'`);
  // 2. The holder's terminal is one live pane in the same inventory.
  let found = "";
  for (const line of inventoryStdout.split("\n")) {
    const [candidate, candidateTty] = line.split("\t", 2);
    if (candidateTty !== holderTty) continue;
    if (found) return outside(`holder terminal '${holderTty}' maps to multiple panes`);
    found = candidate ?? "";
  }
  if (!found) return outside(`terminal '${firstTty}' is held by pid ${holder} on '${holderTty}', which no pane on this server owns either`);
  // 3. The holder is under the pane's pane_pid.
  const pidRead = probe(["display-message", "-p", "-t", found, "#{pane_pid}"], env);
  if (pidRead.rateLimited) {
    return { state: "unobservable", refusal: "tmux is rate limiting; the pane identity record is unavailable", paneId: found, unverifiable: true };
  }
  const panePid = pidRead.code === 0 ? (pidRead.stdout.split("\n", 1)[0] ?? "") : "";
  if (!/^[0-9]+$/.test(panePid)) return outside(`pane ${found} reports no usable pane_pid for terminal holder pid ${holder}`);
  if (!pidHasAncestor(holder, panePid, env)) {
    return outside(`terminal '${firstTty}' is held by pid ${holder}, which is not under pane ${found}'s pane_pid ${panePid}`);
  }
  // 4. The holder is a harness process, by the registry's own classifier.
  const { table, ok } = readProcessTableMemoized(env);
  const holderRow = ok && table ? table.get(String(holder)) : undefined;
  if (!holderRow) return outside(`process table has no row for terminal holder pid ${holder}`);
  const family = classifyHolderCommand(holderRow[2], holderRow[3], DEFAULT_AGENT_FAMILIES);
  if (!family) {
    return outside(`terminal '${firstTty}' is held by '${basename(holderRow[2])}' (pid ${holder}), which is not a harness process`);
  }
  return { state: "held", found, paneTty: holderTty };
}

/**
 * Why the caller's pane could not be used, for a refusal sentence: the
 * refusal for an unobservable walk, the positive-outside sentence plus the
 * climb's own reason for an outside one, empty for a caller inside a pane.
 */
export function callerObservationReason(seen: CallingPaneObservation): string {
  if (seen.state === "inside") return "";
  if (seen.state === "outside") return seen.climb ? `${seen.detail}; ${seen.climb}` : seen.detail;
  return seen.refusal;
}

/**
 * The pane that owns this process's controlling TTY, when uniquely observable.
 *
 * TMUX_PANE is caller-controlled and tmux itself trusts an override, so it is
 * not identity evidence. Walk to the first controlling TTY, map that TTY to one
 * pane, then reassert the same binding with a targeted query.
 *
 * A projection over `observeCallerIdentity` for existing pane consumers.
 * The three shapes they select on are preserved exactly: `ok`, `unverifiable`
 * with its pane id, and `null` for everything else -- including `outside`,
 * which is not a pane. Verified shared callers additionally carry their seat
 * claims so resolveSelf rejects a successor instance.
 */
export function callingPane(env: NodeJS.ProcessEnv = process.env): IdentityPaneObservation | null {
  const seen = observeCallerIdentity(env);
  if (seen.state === "inside") {
    return { status: "ok", paneId: seen.paneId, session: seen.session, serverEpoch: seen.serverEpoch,
      ...(seen.selectedHandle ? { selectedHandle: seen.selectedHandle, selectedInstance: seen.selectedInstance,
        selectedSocket: seen.selectedSocket, selectedPane: seen.selectedPane } : {}),
      address: seen.address, panePid: seen.panePid, currentCommand: seen.currentCommand,
      currentPath: seen.currentPath, socketPath: seen.socketPath };
  }
  if (seen.state === "unobservable" && seen.unverifiable) {
    return { status: "unverifiable", paneId: seen.paneId ?? "" };
  }
  return null;
}

export interface Self {
  handle: string;
  team: string;
  pane: string;
  paneId: string;
  crew?: boolean;
  instance?: string;
}

export type IdentityPaneObservation =
  | { status: "ok"; paneId: string; session: string; serverEpoch: string; selectedHandle?: string; selectedInstance?: string; selectedSocket?: string; selectedPane?: string;
      address?: string; panePid?: string; currentCommand?: string; currentPath?: string; socketPath?: string }
  | { status: "gone"; paneId: string }
  | { status: "unverifiable"; paneId: string };

/**
 * Identity needs pane id, session, and server generation from one targeted
 * tmux record. Splitting those facts across probes lets a pane die and its id
 * be reused between them, defeating the generation guard. This deliberately
 * stays separate from the courier's general observePane contract: self
 * resolution requires the incumbent's atomic identity record and grammar.
 */
export function observeIdentityPane(target: string, env: NodeJS.ProcessEnv, expectedSocket = "", readOnly = false): IdentityPaneObservation {
  const format = expectedSocket
    ? "#{pane_id}\t#{session_name}\t#{pid}:#{start_time}\t#{socket_path}"
    : "#{pane_id}\t#{session_name}\t#{pid}:#{start_time}";
  const result = (readOnly ? tmuxReadOnly : tmux)(["display-message", "-p", "-t", target, format], env);
  if (result.rateLimited) return { status: "unverifiable", paneId: target };
  if (result.code !== 0) {
    const reason = result.stderr.trim();
    const absent = NO_SERVER_ON.test(reason) || /^can't find (?:pane|window|session): .+$/.test(reason);
    return { status: absent ? "gone" : "unverifiable", paneId: target };
  }
  const raw = result.stdout.split("\n", 1)[0] ?? "";
  const fields = raw.split("\t");
  const paneId = fields[0] ?? "";
  if (!paneId) return { status: "unverifiable", paneId: target };
  if (!/^%[0-9]+$/.test(paneId) || fields.length !== (expectedSocket ? 4 : 3)) {
    return { status: "unverifiable", paneId };
  }
  const session = fields[1] ?? "";
  const serverEpoch = serverEpochFromRaw(fields[2] ?? "", env);
  if (!session || !serverEpoch || (expectedSocket && fields[3] !== expectedSocket)) {
    return { status: "unverifiable", paneId };
  }
  return { status: "ok", paneId, session, serverEpoch };
}

function jobOwnsSeatInstance(root: string, handle: string, instance: string, createdAt: unknown): boolean {
  if (!instance || typeof createdAt !== "string") return false;
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return false;
  try {
    let latest = -Infinity;
    let owner = "";
    for (const line of readFileSync(join(root, ".tap", "team-history", `${handle}.lineage.jsonl`), "utf8").split("\n")) {
      if (!line) continue;
      const record = JSON.parse(line) as Record<string, unknown>;
      const rawStamp = typeof record.ts === "string" ? record.ts : "";
      const stamp = Date.parse(rawStamp);
      // Older lineage records were second-resolution. A record in the job's
      // creation second could be either the owner or a later successor, so it
      // cannot establish creation-time ownership. New writes carry fractions.
      if (Number.isFinite(stamp) && !rawStamp.includes(".") &&
          Math.floor(stamp / 1000) === Math.floor(created / 1000)) return false;
      if (Number.isFinite(stamp) && stamp <= created && stamp >= latest && typeof record.instance === "string") {
        latest = stamp;
        owner = record.instance;
      }
    }
    return owner === instance;
  } catch {
    return false;
  }
}

/**
 * Claude Code's desktop-backed and background tool shells can be outside the
 * tmux process and TTY tree. A background daemon has its own session id, so its
 * validated job owner name selects the row; other tools use an exact session
 * id. Either way, re-observe the pane and generation before returning it.
 */
export function observeHarnessSessionPane(
  ctx: Context,
  env: NodeJS.ProcessEnv = process.env,
): IdentityPaneObservation | null {
  const sessionId = env.TAP_HARNESS_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || "";
  let row: ReturnType<typeof resolvePaneByHarnessSession> = null;
  let selectedInstance = "";
  if (env.CLAUDE_JOB_DIR) {
    if (!env.CLAUDE_JOB_DIR || !sessionId) return null;
    try {
      const state = JSON.parse(readFileSync(join(env.CLAUDE_JOB_DIR, "state.json"), "utf8")) as Record<string, unknown>;
      const name = typeof state.name === "string" ? state.name : "";
      const prefix = `${ctx.team}/`;
      const cwd = typeof state.cwd === "string" ? state.cwd : "";
      verbose("claude_background_identity", { name, team: ctx.team,
        sessionMatch: state.sessionId === sessionId, cwdMatch: cwd ? realOrSelf(cwd) === ctx.root : false }, env);
      if (state.template === "bg" && state.sessionId === sessionId && name.startsWith(prefix) &&
          name.length > prefix.length && !name.slice(prefix.length).includes("/") &&
          cwd && realOrSelf(cwd) === ctx.root) {
        const handle = name.slice(prefix.length);
        const candidate = resolvePaneByRegisteredHandle(ctx.registryPath, "claude", handle);
        if (candidate && jobOwnsSeatInstance(ctx.root, handle, candidate.instance ?? "", state.createdAt)) {
          row = candidate;
          selectedInstance = candidate.instance ?? "";
        }
      }
    } catch (error) {
      verbose("claude_background_identity", { accepted: false, error: String(error) }, env);
    }
  } else {
    row = resolvePaneByHarnessSession(ctx.registryPath, "claude", sessionId);
  }
  if (!row) return null;
  const socketEnv: NodeJS.ProcessEnv = { ...env };
  if (row.serverSocket) {
    socketEnv.TAP_TMUX_SOCKET_PATH = row.serverSocket;
    delete socketEnv.TAP_TMUX_SOCKET;
  }
  const observed = observeIdentityPane(row.pane, socketEnv, row.serverSocket);
  if (observed.status !== "ok") return observed;
  if (observed.paneId !== row.paneId || (row.session && observed.session !== row.session) ||
      (row.serverEpoch && observed.serverEpoch !== row.serverEpoch)) {
    return { status: "unverifiable", paneId: observed.paneId || row.paneId };
  }
  return { ...observed, selectedHandle: row.handle, selectedPane: row.pane,
    ...(selectedInstance ? { selectedInstance } : {}), ...(row.serverSocket ? { selectedSocket: row.serverSocket } : {}) };
}

/**
 * A caller pane found by the fallback chain, or the reason none was. A refusal
 * caused by a failed pane observation keeps it, so a gone pane and an
 * unobservable generation stay distinguishable from "no caller pane".
 */
export type CallerPaneChain =
  | { ok: true; paneId: string; session: string; serverEpoch: string;
      selectedSocket: string; selectedHandle: string; selectedInstance: string; selectedPane: string; viaJob: boolean;
      viaHarnessSession?: true;
      address?: string; panePid?: string; currentCommand?: string; currentPath?: string; socketPath?: string }
  | { ok: false; reason: string; observation?: Exclude<IdentityPaneObservation, { status: "ok" }> };

/**
 * The caller's pane through lib.sh's `tap_caller_pane_observe` fallback chain:
 * the process-owning pane first; otherwise a Claude background job or a harness
 * session row selects its INTERACTIVE owner pane, re-verified on the row's own
 * socket. `outside` licenses the session-id arm; `unobservable` only the
 * explicit background-job arm. Registration and the SessionStart entry share it.
 * The selected* fields are set only when a row, not the caller's tty, chose the pane.
 * The anchor fixes that row lookup's authority: the self verbs pass the context
 * they already resolved, and the SessionStart entry passes its resolved root, so
 * a hook process whose cwd sits in another enrolled repo cannot reselect that
 * repo's registry. It is resolved only when a row lookup is needed.
 */
export function observeCallerPaneChain(env: NodeJS.ProcessEnv = process.env, anchor: string | Context = process.cwd(), extended = false,
  observed?: CallingPaneObservation): CallerPaneChain {
  // A caller that already observed its pane (SessionStart's launch-evidence
  // check) passes that one observation through instead of re-walking tmux.
  const seen = observed ?? observeCallerIdentity(env, false, extended);
  const direct = (p: { paneId: string; session: string; serverEpoch: string;
      address?: string; panePid?: string; currentCommand?: string; currentPath?: string; socketPath?: string;
      selectedSocket?: string; selectedHandle?: string; selectedInstance?: string; selectedPane?: string }): CallerPaneChain => ({
    ok: true, paneId: p.paneId, session: p.session, serverEpoch: p.serverEpoch,
    selectedSocket: p.selectedSocket ?? "", selectedHandle: p.selectedHandle ?? "", selectedInstance: p.selectedInstance ?? "", selectedPane: p.selectedPane ?? "", viaJob: false,
    address: p.address ?? "", panePid: p.panePid ?? "", currentCommand: p.currentCommand ?? "",
    currentPath: p.currentPath ?? "", socketPath: p.socketPath ?? "" });
  if (seen.state === "inside") return direct(seen);
  if (seen.state === "unobservable" && seen.shared) return { ok: false, reason: seen.refusal };
  const processRefusal = seen.state === "outside" ? seen.detail : seen.refusal;
  const jobDir = env.CLAUDE_JOB_DIR ?? "";
  if (seen.state !== "outside" && jobDir === "") {
    return { ok: false, reason: processRefusal,
      ...(seen.unverifiable ? { observation: { status: "unverifiable" as const, paneId: seen.paneId ?? "" } } : {}) };
  }
  let selected: IdentityPaneObservation | null = null;
  try { selected = observeHarnessSessionPane(typeof anchor === "string" ? resolveContext(anchor, env) : anchor, env); }
  catch (error) {
    if (isOldStoreRefusal(error)) throw error;
    selected = null;
  }
  if (!selected) return { ok: false, reason: "Claude caller context does not identify exactly one active pane on this team" };
  if (selected.status !== "ok") {
    return { ok: false, reason: "Claude harness session row no longer matches its live pane identity", observation: selected };
  }
  if (seen.state !== "outside" && selected.selectedSocket) {
    // The job arm's socket affinity: the caller's tty may be owned by a pane
    // on the row's own server — inside there clears the selection; a positive
    // outside there keeps the job binding (incumbent 7845-7868).
    const onSocket: NodeJS.ProcessEnv = { ...env, TAP_TMUX_SOCKET_PATH: selected.selectedSocket };
    delete onSocket.TAP_TMUX_SOCKET;
    const there = observeCallingPane(onSocket, false, extended);
    if (there.state === "inside") return direct(there);
    if (there.state !== "outside") return { ok: false, reason: processRefusal };
  }
  return { ok: true, paneId: selected.paneId, session: selected.session, serverEpoch: selected.serverEpoch,
    selectedSocket: selected.selectedSocket ?? "", selectedHandle: selected.selectedHandle ?? "",
    selectedInstance: selected.selectedInstance ?? "", selectedPane: selected.selectedPane ?? "", viaJob: jobDir !== "", viaHarnessSession: true };
}

/**
 * The chain as the identity observation resolveSelf takes: a selected row's
 * witness fields ride along, a failed pane observation keeps its status (gone,
 * unverifiable), and no caller pane at all is null.
 */
export function callerPaneObservation(chain: CallerPaneChain): IdentityPaneObservation | null {
  if (!chain.ok) return chain.observation ?? null;
  const { paneId, session, serverEpoch, selectedHandle, selectedInstance, selectedSocket, selectedPane } = chain;
  return { status: "ok", paneId, session, serverEpoch,
    ...(selectedHandle ? { selectedHandle } : {}), ...(selectedInstance ? { selectedInstance } : {}),
    ...(selectedSocket ? { selectedSocket } : {}), ...(selectedPane ? { selectedPane } : {}) };
}

// `team` here comes from the resolved CONTEXT — the global enrollment key — and
// never from the acting registry's own team.name. The row resolver deliberately
// does not answer it; see resolveHandleByPane's note.

/**
 * Resolve a pane to its registered identity.
 *
 * A pane whose CURRENT server generation cannot be observed refuses rather than
 * resolving: no row whose generation claim we cannot verify may confer identity.
 * The cost is a seat that briefly cannot name itself — loud, immediate, fixable —
 * against the alternative of a forged `from` on the bus, which is silent and
 * corrupting.
 * Observe before selecting a caller bus; observation grants no authority.
 */
export function observeSelfPane(
  paneTarget: string | IdentityPaneObservation,
  env: NodeJS.ProcessEnv = process.env,
  /** Exit for generation_unverifiable: whoami keeps 2; self-resolving verbs pass their refusal code. */
  generationCode = 2,
): Extract<IdentityPaneObservation, { status: "ok" }> {
  const target = typeof paneTarget === "string" ? paneTarget : paneTarget.paneId;
  const obs = typeof paneTarget === "string" ? observeIdentityPane(paneTarget, env) : paneTarget;
  if (obs.status === "gone") {
    throw new TapError(1, "pane_gone", "tap whoami --pane <tmux-target>", `pane '${target}' does not exist`);
  }
  if (obs.status === "unverifiable") {
    throw new TapError(generationCode, "generation_unverifiable", "wait for tmux to answer, then retry — do NOT re-register",
      `pane ${obs.paneId || target} is registered, but the tmux server generation is not observable right now, so its registration cannot be verified`);
  }
  return obs;
}

/**
 * Preserve the executable cwd remedy when caller selection refuses early.
 *
 * `observed` is REQUIRED and comes before the defaulted options: the pane id,
 * session, and server generation from one `observeCallingPane` result.
 * Enrollment is then resolved authoritatively (generation-bound,
 * session-corroborated, uniqueness-checked — see
 * `enrolledSeatForObservedPane`), because a refusal that names a team must not
 * be produced by a raw pane-id match: a stale prior-generation row, a contested
 * pane, an unreadable acting registry, or the pane's own data-gone team refuses with the incumbent's
 * typed verdict instead of pointing the operator at the wrong team's bus.
 */
/**
 * The recovery for a pane whose seat cannot be told apart or observed. It must
 * parse: `tap escalate` refuses a call with no body (verbs/escalate.ts), so the
 * advice names the body file and the caller supplies team and handle.
 */
export const ESCALATE_COMMAND = "tap escalate --team <team> --from <your handle> -f <question-file>";
/** The remedy every stale-enrollment refusal names (pane identity and send). */
export const STALE_ENROLLMENT_NEXT = "tap admin refresh   (purges enrolled teams whose acting registry file is gone)";

export function refuseUnanchoredPane(
  paneId: string, cwd: string, unanchoredCode: number, observed: { session: string; serverEpoch: string },
  env: NodeJS.ProcessEnv = process.env, displayPane = paneId, withTeamAlternative = false,
): never {
  // No machine index: the selector's own refusal, with this verb's exit code (F2b).
  if (flipMarkerState(env.TAP_INDEX_HOME) === "absent") {
    throw new TapError(unanchoredCode, "unanchored_bus", "tap init  OR  tap session launch", NO_MACHINE_INDEX);
  }
  const resolution = enrolledSeatForObservedPane(paneId, observed.session, observed.serverEpoch, env.TAP_INDEX_HOME);
  if (resolution.kind === "no_authority") {
    // No machine index (or no readable index structure): there is no
    // enrollment evidence to type a verdict against, so the refusal keeps the
    // pre-P1 incumbent shape — whoami's missing-registry diagnosis.
    throw new TapError(unanchoredCode, "unanchored_bus", "tap register",
      `no registry at cwd (${displayCwd(cwd)})`);
  }
  if (resolution.kind === "resolved") {
    // The incumbent `tap outstanding` pane arm offers `--team` as an
    // alternative because that caller requests it. Other callers keep the
    // existing cwd remedy alone.
    const action = withTeamAlternative ? `cd ${resolution.root}  OR  pass --team ${resolution.team}` : `cd ${resolution.root}`;
    throw new TapError(unanchoredCode, "unanchored_bus", action,
      `unanchored cwd (${displayCwd(cwd)}) has no TAP bus; pane ${displayPane} is registered as '${resolution.handle}' on team '${resolution.team}' at '${resolution.root}'`);
  }
  // >1 current-epoch, session-agreeing claimants: the incumbent's `contested`
  // verdict. A lookup that cannot tell two seats apart must not hand out an
  // identity, and escalate itself needs a bus anchor plus a truthful identity,
  // so the caller must supply both.
  if (resolution.kind === "contested") {
    throw new TapError(unanchoredCode, "pane_contested",
      `${ESCALATE_COMMAND}   (a human decides which seat owns this pane; the first non-empty line of <question-file> is the question to ask them)`,
      `pane ${displayPane} cannot be resolved to one seat; ${resolution.evidence}`);
  }
  if (resolution.kind === "unverified") {
    if (resolution.verdict === "no_such_pane") {
      // A live pane whose observation carries no session name cannot be
      // bound to any seat row: the incumbent's no_such_pane, whose remedy
      // re-registers the pane against the CURRENT tmux server.
      throw new TapError(unanchoredCode, "pane_gone",
        "tap register   (the recorded pane is from a previous tmux server; re-register to rebind)",
        `pane ${displayPane} is live but its observation cannot be bound to a seat row; ${resolution.evidence}`);
    }
    if (resolution.verdict === "unknown") {
      // An unrecognised pane/enrollment state is a custody question for a
      // human, not a delivery problem to wait on; the refusal is the design.
      // The class and the fail-closed refusal are the same for every cause; only
      // the blame differs. An unreadable registry, a malformed enrollment or a malformed root leaves the
      // pane OBSERVED, so pointing the operator at a healthy tmux would be false.
      const escalate = ESCALATE_COMMAND;
      if (resolution.cause === "registry_unreadable") {
        throw new TapError(unanchoredCode, "pane_unknown",
          `${escalate}   (do not retry; repair the unreadable team's registry)`,
          `${resolution.evidence}; pane ${displayPane} was observed, so tmux is not the cause`);
      }
      if (resolution.cause === "malformed_enrollment") {
        throw new TapError(unanchoredCode, "pane_unknown",
          `${escalate}   (do not retry; the enrolled team's registry_location in the machine index is missing or malformed and a human must repair the enrollment, not the team registry)`,
          `${resolution.evidence}; pane ${displayPane} was observed, so tmux is not the cause`);
      }
      if (resolution.cause === "malformed_root") {
        throw new TapError(unanchoredCode, "pane_unknown",
          `${escalate}   (do not retry; the enrolled team's root in the machine index is malformed and a human must repair the enrollment)`,
          `${resolution.evidence}; pane ${displayPane} was observed, so tmux is not the cause`);
      }
      throw new TapError(unanchoredCode, "pane_unknown",
        `${escalate}   (do not retry; tmux state is unreadable)`,
        `pane ${displayPane} could not be observed, so its identity is unknown rather than absent; ${resolution.evidence}`);
    }
    // The pane's own team is enrolled with its acting file gone. Admin refresh
    // rechecks under the index writer lock and purges data-gone enrollments.
    throw new TapError(unanchoredCode, "stale_enrollment", STALE_ENROLLMENT_NEXT,
      `pane ${displayPane} belongs to a stale enrollment; ${resolution.evidence}`);
  }
  // NO CURRENT ENROLLED TEAM CLAIMS THIS PANE. Same remedy as the incumbent's
  // generic case, but it carries the evidence — a recycled id whose only
  // claimant is a prior generation reads as "not registered" while an operator
  // can see a row that LOOKS like theirs, and the difference is the whole
  // question they are trying to answer.
  throw new TapError(unanchoredCode, "unregistered", "tap register",
    `pane ${displayPane} ${resolution.evidence}`);
}

/**
 * `refusalCode` is the caller's exit for every refusal here: unanchored, unregistered and
 * generation_unverifiable. Verbs pass 1 (refusal); whoami and its peers pass their documented 2.
 */
export function resolveSelf(
  ctx: Context,
  paneTarget: string | IdentityPaneObservation,
  refusalCode: number,
  env: NodeJS.ProcessEnv = process.env,
  strictPane = false,
): Self {
  const obs = observeSelfPane(paneTarget, env, refusalCode);
  const target = typeof paneTarget === "string" ? paneTarget : paneTarget.paneId;
  // THE REMEDY MUST BE A COMMAND THIS BINARY ACCEPTS.
  //
  // Some callers do not accept `--team`. Name the enrolled root the pane is
  // actually registered on: `cd <root>` works for every verb.
  //
  // Only reachable once the pane is observable, which is why it lives here
  // rather than in requireActingRegistry: without a pane id there is nothing to
  // look the enrollment up BY.
  if (!isFile(ctx.registryPath)) {
    refuseUnanchoredPane(obs.paneId, ctx.root, refusalCode,
      { session: obs.session, serverEpoch: obs.serverEpoch }, env, target);
  }
  requireActingRegistry(ctx, refusalCode);
  let found;
  try {
    found = resolveHandleByPane(
      ctx.registryPath, obs.paneId, target, obs.serverEpoch, obs.selectedHandle, obs.selectedInstance,
      strictPane ? obs.session : undefined,
    );
  } catch (error) {
    if (!(error instanceof PaneLookupError)) throw error;
    throw new TapError(refusalCode, error.kind, ESCALATE_COMMAND, error.message);
  }
  if (!found) {
    throw new TapError(refusalCode, "unregistered", "tap register", `pane ${target} is not registered`);
  }
  return { ...found, team: ctx.team };
}
