// Crew lifecycle: shutdown one crew seat or an owner's whole crew (tap-yih6n.1).
// Durable parentage gates rearm/relaunch. Explicit teardown keeps its existing
// session-scoped family selection so legacy crews can always be removed.
import { observeCallerIdentity, TapError, type ResolvedContext } from "./context";
import { validToken } from "./ids";
import { isFile } from "./watch-lease";
import { loadRegistry, saveRegistry, seatMap } from "./registry";
import { resolveSelection } from "./team-selection";
import { assertActingRegistryMatches, SelectorError } from "./selector";
import { tmux, tmuxReadOnly, tmuxTimeoutMs } from "./tmux";
import { scratchOnlyGuard, retireSelected, retirementReceipt, type RetirementDisposition, type PlainForm } from "./out-retire";
import { lifecycleDisposition } from "./lifecycle-target";
import { acquireRegistryLock } from "./panelock";
import { acquireResetMutationLock, assertResetUnfenced, RESET_HELD_LOCK_WAIT_MS } from "./reset";
import { checkCrewRegistry } from "./crew-registry";
import { crewRecipeInvocation, crewRecipeWithOverrides } from "./launcher/crew-invocation";
import type { Overrides } from "./launcher/overrides";
import { LaunchInterrupted } from "./launcher/transaction";
import { launchTmux } from "./launcher/process";
import { LauncherError } from "./launcher/types";
import { prepareCodexAutoReceipts } from "./launcher/permissions";
import { assertCrewOwnerLink, crewLifetimeBinding, rearmCrewLifetime, rearmReplacedCrewLifetime, stopCrewLifetimeHelper } from "./crew-lifetime";

const HELP = "tap help crew";
export const OWNER_GRAMMAR = "tap crew shutdown --owner <handle> or --owner <team>/<handle>";

type Row = Record<string, unknown>;
const str = (v: unknown): string => typeof v === "string" ? v : "";
const read = (args: string[]): string => tmuxReadOnly(args).stdout.replace(/\n+$/, "");

export interface Target { team: string; handle: string }

/** `team/handle` names that team; a bare handle is the current-folder team. Never scans teams. */
export function parseTarget(spec: string): Target {
  const parts = spec.split("/");
  const [team, handle] = parts.length === 2 ? parts : ["", parts[0]!];
  if (parts.length > 2 || (parts.length === 2 && !validToken(team!)) || !validToken(handle!)) {
    throw new TapError(1, "usage_error", HELP, `'${spec}' is not <handle> or <team>/<handle>`);
  }
  return { team: team!, handle: handle! };
}

export function teamContext(team: string, honorPin = true): ResolvedContext {
  const ctx = resolveSelection(honorPin ? process.env.TAP_HOME ?? "" : "", team);
  // A caller pin decides the selection; an explicit team it does not match refuses.
  if (team && ctx.team !== team) {
    throw new TapError(1, "team_mismatch", `unset TAP_HOME, or run from team ${team}`, `selected team is '${ctx.team}', not '${team}'`);
  }
  if (!isFile(ctx.registryPath)) throw new TapError(1, "not_found", "tap team / tap doctor", "no acting registry for this team");
  try { assertActingRegistryMatches({ registryLocation: ctx.registryPath, team: ctx.team, rootReal: ctx.root }); }
  catch (error) {
    if (error instanceof SelectorError) throw new TapError(error.code, error.errorClass, error.action, error.detail);
    throw error;
  }
  return ctx;
}

export function seats(ctx: ResolvedContext): Record<string, Row> {
  const out: Record<string, Row> = {};
  for (const [handle, row] of Object.entries(seatMap(loadRegistry(ctx.registryPath) as Record<string, unknown>))) {
    if (row && typeof row === "object") out[handle] = row as Row;
  }
  return out;
}

// The numeric marker is the supported legacy spelling the census also accepts.
const isCrew = (row: Row | undefined): boolean => row?.crew === true || row?.crew === 1;

/** The crew of an owner: rows sharing its session. Two owners in one session never guess. */
export function crewOf(all: Record<string, Row>, owner: string): string[] {
  const session = str(all[owner]?.session);
  if (!session) throw new TapError(1, "crew_owner_unidentified", OWNER_GRAMMAR, `owner '${owner}' has no recorded session`);
  const owners = Object.keys(all).filter(h => !isCrew(all[h]) && str(all[h]!.session) === session);
  if (owners.length > 1) {
    throw new TapError(1, "crew_owner_ambiguous", "tap crew shutdown <crew-handle>",
      `session '${session}' holds ${owners.length} non-crew seats (${owners.sort().join(", ")}); crew ownership is ambiguous, name crew seats individually`);
  }
  return Object.keys(all).filter(h => isCrew(all[h]) && str(all[h]!.session) === session).sort();
}

/** The caller's own non-crew row, or the owner-inference refusal. */
function inferOwner(ctx: ResolvedContext, all: Record<string, Row>): string {
  const refuse = (why: string) => new TapError(1, "crew_owner_unidentified", OWNER_GRAMMAR,
    `cannot identify crew owner; pass the crew owner explicitly (${why})`);
  const seen = observeCallerIdentity();
  if (seen.state !== "inside") throw refuse("caller is not in an attributable tmux pane");
  // tap-zk1w: pane ids recycle across tmux servers, so only a row stamped with
  // the caller's observed generation can name the owner.
  const matches = Object.keys(all).filter(h => str(all[h]!.pane_id) === seen.paneId
    && str(all[h]!.server_epoch) !== "" && str(all[h]!.server_epoch) === seen.serverEpoch);
  if (matches.length !== 1 || isCrew(all[matches[0]!])) {
    throw refuse(matches.length === 0 ? `pane ${seen.paneId} is not registered on team ${ctx.team}`
      : matches.length > 1 ? `pane ${seen.paneId} holds ${matches.length} rows` : `pane ${seen.paneId} is a crew seat`);
  }
  return matches[0]!;
}

/** Why the row's recorded pane is not observably the crew's own, or "" when it is. */
function recordedPaneRefusal(row: Row): string {
  const paneId = str(row.pane_id), session = str(row.session), socket = str(row.server_socket);
  if (!paneId) return "no pane_id on row";
  if (!session) return "no session on row";
  // Pane ids are per server: on another server the same id names another pane.
  if (socket) {
    const live = read(["display-message", "-p", "#{socket_path}"]);
    if (live !== socket) return `row is on tmux server ${socket}, not ${live || "?"}`;
  }
  if (read(["display-message", "-p", "-t", paneId, "#{pane_id}"]) !== paneId) return "crew pane not observable";
  const tipSession = read(["display-message", "-p", "-t", paneId, "#{session_name}"]);
  if (tipSession !== session) return `pane_live_elsewhere (pane_id ${paneId} in session '${tipSession || "?"}'; row session=${session})`;
  return "";
}

/**
 * The pane a crew shutdown may stop, or the reason it may not. Only the row's
 * recorded pane on the row's recorded tmux server and session — never a
 * sibling split, never a session's last pane (that would end the session).
 */
export function killablePane(row: Row): { paneId: string; skip: string; hint: string } {
  const paneId = str(row.pane_id), session = str(row.session);
  const refusal = recordedPaneRefusal(row);
  if (refusal) return { paneId: "", skip: refusal, hint: refusal.startsWith("pane_live_elsewhere") ? paneId : "" };
  const windows = read(["display-message", "-p", "-t", paneId, "#{session_windows}"]);
  const panes = read(["display-message", "-p", "-t", paneId, "#{window_panes}"]);
  if (!(Number(windows) > 1) && !(Number(panes) > 1)) return { paneId: "", skip: `pane ${paneId} is the last in session '${session}'`, hint: "" };
  return { paneId, skip: "", hint: "" };
}

export function dismissCrew(ctx: ResolvedContext, handle: string, row: Row, disposition: RetirementDisposition,
  options: { verb?: string; callerPane?: string; deadOnly?: boolean; retirementForm?: PlainForm; collect?: (receipt: Record<string, unknown>) => void } = {}): number {
  const verb = options.verb ?? "tap out";
  let callerPane = options.callerPane;
  scratchOnlyGuard(process.env, `a registry ${verb} would stop a crew pane on`, ctx.bus.home, verb);
  if (callerPane === undefined) {
    const seen = observeCallerIdentity();
    callerPane = seen.state === "inside" ? seen.paneId : "";
  }
  if (callerPane && str(row.pane_id) === callerPane) {
    throw new TapError(1, "usage_error", `run ${verb} from another pane`, `'${handle}' is the calling pane; a crew seat cannot shut itself down`);
  }
  const before = killablePane(row);
  const lifetime = crewLifetimeBinding(str(row.pane_id));
  if (options.deadOnly && read(["display-message", "-p", "-t", str(row.pane_id), "#{pane_id}"]) === str(row.pane_id) && row.pane_id) {
    throw new TapError(1, "lifecycle_refused", "inspect the live crew seat", "dash-selected crew became live; nothing removed");
  }
  // No lock is held here. The registry-only leaf owns reset → registry custody,
  // validates this exact identity and returns without re-entering a public door.
  retireSelected(ctx, options.retirementForm ?? { name: handle, team: ctx.team, pane: "", kill: false, dash: false }, handle, row, disposition);
  // Decide again at the effect: retirement can take long enough for identity to change.
  const { paneId, skip, hint } = options.deadOnly ? { paneId: "", skip: "dead-only selector never stops panes", hint: "" }
    : before.paneId ? killablePane(row) : before;
  if (paneId && paneId === before.paneId) {
    if (tmux(["kill-pane", "-t", paneId]).code !== 0) {
      throw new TapError(1, "tmux_error", `tmux kill-pane -t '${paneId}'`, `removed registry row for '${handle}' but could not stop crew pane '${paneId}'`);
    }
    retirementReceipt(ctx, handle, disposition, { outcome: "dismissed", pane_id: paneId }, options.collect);
    if (lifetime && lifetime.crew === handle && lifetime.crewInstance === str(row.instance)) stopCrewLifetimeHelper(lifetime);
    if (process.env.TAP_JSON !== "1") process.stdout.write(`${verb}: removed ${handle} and stopped pane ${paneId}\n`);
  } else {
    retirementReceipt(ctx, handle, disposition, { outcome: "retired_pane_retained", reason: skip || "crew pane changed" }, options.collect);
    if (process.env.TAP_JSON !== "1") {
      process.stdout.write(`${verb}: removed ${handle} (pane not stopped: ${skip || "crew pane changed"})\n`);
      if (hint) process.stdout.write(`${verb}: next: tmux kill-pane -t '${hint}'\n`);
    }
  }
  return 0;
}

/** `tap crew shutdown [<crew>|<owner>] [--owner <owner>]`; `remove` passes crewOnly. */
export function cmdCrewShutdown(argv: string[], scriptsDir: string, crewOnly = false): number {
  const verb = crewOnly ? "tap crew remove" : "tap crew shutdown";
  let owner: string | undefined, positional: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") process.env.TAP_JSON = "1";
    else if (!crewOnly && arg === "--owner") {
      owner = argv[++i];
      if (owner === undefined) throw new TapError(1, "usage_error", HELP, `--owner requires <handle> or <team>/<handle>`);
    } else if (!crewOnly && arg.startsWith("--owner=")) owner = arg.slice("--owner=".length);
    else if (arg.startsWith("-")) throw new TapError(1, "unknown_option", HELP, `unknown option '${arg}'`);
    else if (positional === undefined) positional = arg;
    else throw new TapError(1, "usage_error", HELP, `unexpected arg '${arg}'`);
  }
  if (owner !== undefined && positional !== undefined) throw new TapError(1, "usage_error", HELP, "pass a crew handle or --owner, not both");
  if (crewOnly && positional === undefined) throw new TapError(1, "usage_error", HELP, "usage: tap crew remove <handle>");

  const spec = owner ?? positional;
  const target = spec === undefined ? undefined : parseTarget(spec);
  const ctx = teamContext(target?.team ?? "");
  scratchOnlyGuard(process.env, `a registry ${verb} would stop a crew window on`, ctx.bus.home, "tap crew");
  const all = seats(ctx);
  const seen = observeCallerIdentity();
  const callerPane = seen.state === "inside" ? seen.paneId : "";
  const disposition = lifecycleDisposition("crew", "shutdown");
  if (!disposition.ok) throw new TapError(1, disposition.errorClass, HELP, disposition.detail);
  const results: Record<string, unknown>[] = [];
  const json = process.env.TAP_JSON === "1";
  const dismiss = (handle: string, collect = false) => dismissCrew(ctx, handle, all[handle]!, disposition,
    { verb, callerPane, ...(json && collect ? { collect: (receipt: Record<string, unknown>) => results.push(receipt) } : {}) });

  let ownerHandle: string;
  if (target === undefined) ownerHandle = inferOwner(ctx, all);
  else {
    const row = Object.hasOwn(all, target.handle) ? all[target.handle] : undefined;
    if (!row) throw new TapError(1, "not_found", "tap team / tap doctor", `no registry row for '${target.handle}' on team ${ctx.team}`);
    if (owner === undefined && isCrew(row)) return dismiss(target.handle);
    if (crewOnly) throw new TapError(1, "usage_error", `tap out ${target.handle}`, `'${target.handle}' is not a crew member; use tap out / tap unregister for durable seats`);
    if (isCrew(row)) throw new TapError(1, "usage_error", `tap crew shutdown ${target.handle}`, `--owner '${target.handle}' is a crew seat, not an owner`);
    ownerHandle = target.handle;
  }
  const crew = crewOf(all, ownerHandle);
  if (crew.length === 0) {
    if (json) process.stdout.write(JSON.stringify({ ok: true, team: ctx.team, owner: ownerHandle, results }) + "\n");
    else process.stdout.write(`${verb}: ${ctx.team}/${ownerHandle} has no crew\n`);
    return 0;
  }
  let code = 0;
  for (const handle of crew) {
    try {
      const rc = dismiss(handle, true);
      if (rc !== 0) code = rc;
    } catch (error) {
      if (!(error instanceof TapError)) throw error;
      if (json) results.push({ ok: false, handle, error_class: error.errorClass, detail: error.detail, action: error.action });
      else process.stderr.write(`${verb}: ${handle}: ${error.detail}; next: ${error.action}\n`);
      code = 1;
    }
  }
  if (json) process.stdout.write(JSON.stringify({ ok: code === 0, team: ctx.team, owner: ownerHandle, lifecycle_action: disposition.action, mechanism: disposition.row.mechanism, results }) + "\n");
  return code;
}

// Identity a relaunch must not carry into the fresh process: the old
// conversation's id and transcript, and any attestation made about them.
const STALE_IDENTITY = ["harness_session_id", "transcript_path", "identity_capture_result", "crew_identity_capture"] as const;

// Result codes shared with the relaunch receipt: 2 refused before any effect,
// 1 the effect failed, 7 replaced but the new process was not verified.
const refused = (errorClass: string, action: string, detail: string) => new TapError(2, errorClass, action, detail);
const sameSeat = (a: Row, b: Row): boolean => isCrew(a) && isCrew(b)
  && str(a.instance) === str(b.instance) && str(a.crew_owner) === str(b.crew_owner) && str(a.crew_owner_instance) === str(b.crew_owner_instance)
  && str(a.pane_id) === str(b.pane_id) && str(a.session) === str(b.session) && str(a.harness) === str(b.harness);
// The recipe fields only crew add and relaunch write. A relaunch composed from one recipe never replaces
// a process or saves over a recipe another relaunch has since changed.
const RECIPE_FIELDS = ["harness_env", "passthrough", "harness_unset_env", "harness_tail", "harness_env_set"] as const;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Row)[key])])) : value ?? null;
const sameRecipe = (a: Row, b: Row): boolean =>
  JSON.stringify(RECIPE_FIELDS.map(key => canonical(a[key]))) === JSON.stringify(RECIPE_FIELDS.map(key => canonical(b[key])));

function withRegistry<T>(ctx: ResolvedContext, fn: (doc: Record<string, unknown>) => T): T {
  const lock = acquireRegistryLock(ctx.registryPath, RESET_HELD_LOCK_WAIT_MS);
  if (!lock) throw refused("registry_lock_busy", "retry the relaunch", "acting registry is busy; nothing was replaced");
  try { return fn(loadRegistry(ctx.registryPath) as Record<string, unknown>); } finally { lock.release(); }
}

/** A new, live process in the pane that stays live; the old pid is gone. */
async function replacementVerified(paneId: string, oldPid: string, signal?: AbortSignal): Promise<string | null> {
  let seen = "", stableSince = 0;
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    await Bun.sleep(100);
    signal?.throwIfAborted();
    const observed = await launchTmux(["display-message", "-p", "-t", paneId, "#{pane_id} #{pane_dead} #{pane_pid}"], process.env, signal, true, 5000);
    signal?.throwIfAborted();
    if (observed.code === 124) return null;
    const now = observed.code === 0 ? observed.stdout.trim() : "";
    const [id, dead, pid] = now.split(" ");
    if (id !== paneId || dead !== "0" || !pid || pid === oldPid) { seen = ""; continue; }
    if (seen === pid && performance.now() - stableSince >= 1000) return pid;
    if (seen !== pid) stableSince = performance.now();
    seen = pid;
  }
  return null;
}

/**
 * Replace a live crew seat's process in place with a fresh one from its
 * persisted recipe (tap-odt1d.1). `respawn-pane -k` keeps the pane id, window
 * and session, so the row stays bound; nothing resumes. `expect` is the row a
 * census classified; a current row that differs refuses. Every failure before
 * or at the effect leaves the row as it was.
 */
export async function relaunchCrew(ctx: ResolvedContext, all: Record<string, Row>, handle: string, callerPane: string,
  opts: { dryRun?: boolean; expect?: Row; signal?: AbortSignal; progress?: (line: string) => void; overrides?: Overrides } = {}): Promise<string> {
  let respawnAttempted = false, unpersisted = "";
  try {
    opts.signal?.throwIfAborted();
    const row = Object.hasOwn(all, handle) ? all[handle] : undefined;
    if (!row) throw refused("not_found", "tap crew list", `no registry row for '${handle}' on team ${ctx.team}`);
    if (!isCrew(row)) throw refused("usage_error", `tap session relaunch ${ctx.team}/${handle}`, `'${handle}' is not a crew seat`);
    if (opts.expect && !sameSeat(opts.expect, row)) throw refused("crew_row_changed", "tap crew list", `crew row '${handle}' changed since it was selected; nothing was replaced`);
    assertCrewOwnerLink(ctx, handle);
    const paneId = str(row.pane_id);
    if (callerPane && paneId === callerPane) {
      throw refused("usage_error", "run tap crew relaunch from another pane", `'${handle}' is the calling pane; a crew seat cannot relaunch itself`);
    }
    let recipe: { command: string; cwd: string };
    // --env, --unset-env and -- update the recipe as they do a durable seat's record.
    let recipeFields: Row | null = null;
    try {
      recipeFields = opts.overrides ? crewRecipeWithOverrides(row, opts.overrides) : null;
      recipe = await crewRecipeInvocation(ctx.team, handle, recipeFields ? { ...row, ...recipeFields } : row);
    }
    catch (error) {
      if (!(error instanceof LauncherError)) throw error;
      throw refused(error.errorClass || "crew_recipe_missing", error.action ?? HELP, error.detail ?? error.message);
    }
    try { checkCrewRegistry(recipe.cwd, ctx.registryPath); }
    catch (error) {
      throw refused("crew_registry_mismatch", `tap crew shutdown ${ctx.team}/${handle}`, `${error instanceof Error ? error.message : error}`);
    }
    const paneRefusal = () => {
      const refusal = recordedPaneRefusal(row);
      return refusal ? refused("crew_pane_unverified", `tap crew shutdown ${ctx.team}/${handle}`, `crew pane ${paneId || "?"} cannot be replaced: ${refusal}`) : null;
    };
    const early = paneRefusal();
    if (early) throw early;
    if (opts.dryRun) return paneId;
    recipe = await crewRecipeInvocation(ctx.team, handle, recipeFields ? { ...row, ...recipeFields } : row, process.env, true, opts.signal);
    prepareCodexAutoReceipts(str(row.harness), row.permissions);
    // Preserve the original parent generation when replacing a supervised child.
    const lifetime = crewLifetimeBinding(paneId);
    if (lifetime) await rearmCrewLifetime(ctx, handle);
    // Reset first holding nothing, then the registry alone with a short bound;
    // both released before any tmux effect (tap-0p7hx).
    await Bun.sleep(0);
    opts.signal?.throwIfAborted();
    ctx.bus.ensureDirs();
    const stashed: Row = {};
    const reset = acquireResetMutationLock(ctx.bus.home, "tap crew relaunch", undefined, "shared");
    try {
      withRegistry(ctx, doc => {
        const now = seatMap(doc)[handle] as Row | undefined;
        if (!now || !sameSeat(now, row) || !sameRecipe(now, row)) throw refused("crew_row_changed", "tap crew list", `crew row '${handle}' changed before relaunch; nothing was replaced`);
        assertCrewOwnerLink(ctx, handle);
        for (const key of STALE_IDENTITY) if (Object.hasOwn(now, key)) { stashed[key] = now[key]; delete now[key]; }
        if (Object.keys(stashed).length) saveRegistry(ctx.registryPath, doc);
      });
    } finally { reset.release(); }
    // Put the old identity back when no replacement happened.
    const restore = () => {
      if (!Object.keys(stashed).length) return;
      withRegistry(ctx, doc => {
        const now = seatMap(doc)[handle] as Row | undefined;
        if (!now || !sameSeat(now, row) || STALE_IDENTITY.some(key => Object.hasOwn(now, key))) return;
        Object.assign(now, stashed);
        saveRegistry(ctx.registryPath, doc);
      });
    };
    // Decide again at the effect: the pane may have moved, or a reset begun.
    let oldPid = "";
    try {
      await Bun.sleep(0);
      opts.signal?.throwIfAborted();
      const observed = await launchTmux(["display-message", "-p", "-t", paneId, "#{pane_pid}"], process.env, opts.signal, true, 5000);
      oldPid = observed.code === 0 ? observed.stdout.trim() : "";
      opts.signal?.throwIfAborted();
      if (!/^[1-9][0-9]*$/.test(oldPid)) throw refused("crew_pane_unverified", `inspect pane ${paneId}`,
        `cannot observe the crew process before respawn (tmux exit ${observed.code}); nothing was replaced`);
      const late = paneRefusal();
      if (late) throw late;
      // Bun.sleep(0) can resolve without a timer turn; deliver queued signals before any effect.
      await Bun.sleep(1);
      opts.signal?.throwIfAborted();
      assertResetUnfenced(ctx.bus.home, "tap crew relaunch");
    }
    catch (error) { restore(); throw error instanceof TapError ? new TapError(2, error.errorClass, error.action, error.detail) : error; }
    opts.signal?.throwIfAborted();
    opts.progress?.(`replacing crew process in pane ${paneId}`);
    respawnAttempted = true;
    const respawn = await launchTmux(["respawn-pane", "-k", "-t", paneId, "-c", recipe.cwd, recipe.command], process.env, opts.signal, true, tmuxTimeoutMs(["respawn-pane"], process.env));
    // The new process runs with the overrides once respawn succeeds, so the row records them before an
    // interruption is honored (a bounded, synchronous registry write). A failed save is reported only
    // after verification and lifetime re-arm, which must still happen.
    if (respawn.code === 0 && recipeFields) {
      const fields = recipeFields;
      try {
        withRegistry(ctx, doc => {
          const now = seatMap(doc)[handle] as Row | undefined;
          if (!now || !sameSeat(now, row)) throw new Error("crew row changed");
          if (!sameRecipe(now, row)) throw new Error("another relaunch changed the crew recipe");
          Object.assign(now, fields);
          saveRegistry(ctx.registryPath, doc);
        });
      } catch (error) { unpersisted = error instanceof TapError ? error.detail : (error as Error).message; }
    }
    opts.signal?.throwIfAborted();
    if (respawn.code === 124) throw new TapError(7, "replacement_unverified", `inspect pane ${paneId}; do not retry blindly`, "respawn command timed out; replacement state unverified");
    if (respawn.code !== 0) {
      restore();
      throw new TapError(1, "tmux_error", `inspect pane ${paneId}; tap crew shutdown ${ctx.team}/${handle}`,
        `could not respawn crew pane ${paneId}; the row is retained: ${respawn.stderr.trim()}`);
    }
    opts.progress?.(`respawn attempted; observing crew startup in pane ${paneId}`);
    const replacementPid = await replacementVerified(paneId, oldPid, opts.signal);
    if (!replacementPid) {
      throw new TapError(7, "replacement_unverified", `inspect pane ${paneId}; do not retry blindly`,
        `respawned crew pane ${paneId}, but no stable new process was observed`);
    }
    opts.signal?.throwIfAborted();
    if (lifetime) await rearmReplacedCrewLifetime(ctx, handle, lifetime, replacementPid);
    if (unpersisted) throw new TapError(1, "crew_recipe_unpersisted", `inspect tap crew list, then repeat the overrides with tap session relaunch ${ctx.team}/${handle}`,
      `replaced crew pane ${paneId} with the overrides, but could not save them to the row (${unpersisted}); a later relaunch would drop them`);
    return paneId;
  } catch (error) {
    if (opts.signal?.aborted) {
      throw new TapError(opts.signal.reason instanceof LaunchInterrupted ? opts.signal.reason.exitCode : 130,
        "relaunch_interrupted", respawnAttempted ? `inspect pane ${str(all[handle]?.pane_id)}; do not retry blindly` : `tap crew relaunch ${ctx.team}/${handle}`,
        respawnAttempted ? `interrupted after respawn was attempted; replacement state unverified; no retry performed${unpersisted ? `; overrides not saved to the row (${unpersisted})` : ""}`
          : "interrupted before replacement; nothing was replaced");
    }
    throw error;
  }
}

/** `tap crew relaunch <crew>` */
export async function cmdCrewRelaunch(argv: string[]): Promise<number> {
  if (argv.length !== 1 || argv[0]!.startsWith("-")) throw new TapError(1, "usage_error", HELP, "usage: tap crew relaunch <crew> | <team>/<crew>");
  const target = parseTarget(argv[0]!);
  const ctx = teamContext(target.team);
  scratchOnlyGuard(process.env, "a registry tap crew relaunch would replace a crew process on", ctx.bus.home, "tap crew");
  const seen = observeCallerIdentity();
  const paneId = await relaunchCrew(ctx, seats(ctx), target.handle, seen.state === "inside" ? seen.paneId : "");
  process.stdout.write(`tap crew relaunch: replaced ${ctx.team}/${target.handle} with a fresh process in ${paneId}\n`);
  return 0;
}
