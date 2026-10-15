import { launchWorkdir, validateLaunchWorkdir } from "./workdir";
// Durable in-pane replacement for `tap clear` (R7a). Dark until R7b routes
// `clear` here: nothing in main.ts reaches this module yet.
//
// Lock order (tap-12ys6 layered rule). The clear fence is taken first, with
// nothing held, and spans the whole replacement. Reset custody is taken twice,
// each time only around one registry write (stamp, then consume). The registry
// lock is taken inside custody with the bounded wait. No reset or registry lock
// is held across any tmux call or wait. What makes releasing custody before the
// respawn safe is the fence: `tap team reset` refuses `clear_in_flight` while a
// live fence exists (reset-components.ts firstLiveFence), and each side stores
// its claim before it loads the other's.
import { randomUUID } from "node:crypto";
import { appendFileSync, fsyncSync, ftruncateSync, mkdirSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { loadavg } from "node:os";
import { dirname, join } from "node:path";
import { fencePath, readClearFence } from "../clear-fence";
import { observeCallingPane, resolveContext, TapError, type CallingPaneObservation } from "../context";
import { acquireRegistryLock } from "../panelock";
import { loadCurrentRegistry, saveRegistry, seatMap } from "../registry";
import { OldStoreError } from "../register-authority";
import { acquireFlock } from "../remind-lock";
import { acquireResetMutationLockAsync, assertResetUnfenced, interactiveResetCustodyWaiting, RESET_HELD_LOCK_WAIT_MS } from "../reset";
import { tapScriptsDir } from "../scripts-dir";
import { epochVoidedIds } from "../seat-verdict";
import { tmux, tmuxTimeoutMs } from "../tmux";
import { launchTmux } from "./process";
import type { JsonMap } from "../watch-detect";
import { freshLaunchSessionId } from "./adapters";
import { HARNESSES } from "./catalog";
import { Notices } from "./catalog-notices";
import { prepareCodexAutoReceipts } from "./permissions";
import { observeGeneration, staleSeatGeneration, type Observation } from "./generation";
import { InvocationError, invocationShellCommand, launchInvocation } from "./invocation";
import { currentEpoch, entrySession, paneSession } from "./observation";
import { PaneObservationTimeout, awaitReplacedHarness, paneFacts, paneHarness, startupBlocker, type PaneFacts } from "./readiness";
import { assertUniqueHarnessSessionIdentity } from "./identity-owner";
import { resolvedResumeIdentity } from "./resume-identity";
import { timestamp } from "./repair";
import { registryEntry } from "./resume";
import { LaunchInterrupted, mintLaunchSessionId, recordFromRow, type LaunchRecord } from "./transaction";
import { LauncherError, type Invocation } from "./types";

type Row = Record<string, unknown>;
/** seat_corpse.epoch_voided_ids over a plain registry row: a pane id stamped under another server generation is void. */
const voidedPaneId = (row: Row, epoch: string | null): string => epochVoidedIds(new Map(Object.entries(row)) as JsonMap, epoch)[0];

/** Where one clear reads and writes: the caller team's root, acting registry and root-authority bus. */
export interface ClearScope { root: string; registryPath: string; busHome: string }

/**
 * A command outcome. 0 replaced and verified; 2 refused with nothing replaced;
 * 1 the respawn itself failed; 7 replaced but the rebind was not verified; 6
 * replaced and verified but the opencode instruction did not land. 7 is never
 * a refusal: the process is already gone, so a caller must not retry it as one.
 */
/** 0 ok, 2 refused, 6 instruction undelivered, 7 replaced but unverified; a failed respawn carries tmux's own code; old_store is 1. */
export interface ReplaceOutcome { code: number; errorClass: string; action: string; detail: string }

const refusal = (errorClass: string, action: string, detail: string): ReplaceOutcome =>
  ({ code: 2, errorClass, action, detail });

/** A refusal raised mid-plan and returned as its outcome at the command boundary. */
export class ClearRefusal extends Error {
  constructor(readonly outcome: ReplaceOutcome) { super(outcome.detail); }
}

// ---- per-family await ceiling (launcher.py CLEAR_REBIND_TIMEOUT_BY_FAMILY) ----

export const CLEAR_REBIND_TIMEOUT_SECONDS = 45;
// Provisional: one night's observation plus margin (2026-08-14 fleet clear,
// where agy and opencode registered after 45s). clear-latency.jsonl is the data.
const CLEAR_REBIND_TIMEOUT_BY_FAMILY: Record<string, number> = { claude: 45, codex: 45, cursor: 45, agy: 90, opencode: 90 };

export function clearRebindTimeout(harness: string | null | undefined): number {
  return CLEAR_REBIND_TIMEOUT_BY_FAMILY[(harness ?? "").trim().toLowerCase()] ?? CLEAR_REBIND_TIMEOUT_SECONDS;
}

// ---- the clear fence, writer half (clear-fence.ts is the lockless reader) ----

/** Python's float repr for the two float fields, so the marker bytes match clear_fence.py. */
const pyFloat = (value: number): string => Number.isInteger(value) ? `${value}.0` : String(value);

export interface HeldClearFence { readonly path: string; release(): void }

/**
 * Take the per-seat clearing fence without waiting, or return null when another
 * clear holds it. The flock is on the marker inode and stays held across
 * stamp → respawn → await → consume. Release truncates in place and never
 * unlinks: an unlink would let a second clearer create a new inode and acquire
 * while this descriptor still holds the old one. `pid` is a diagnostic label for
 * a losing clearer's message; liveness is age against `ceiling_seconds`.
 */
export function acquireClearFence(busHome: string, handle: string, nonce: string, harness: string,
  ceilingSeconds: number, now: Date = new Date()): HeldClearFence | null {
  const path = fencePath(busHome, handle);
  mkdirSync(dirname(path), { recursive: true });
  const lock = acquireFlock(path, 0, true);
  if (!lock) return null;
  const bare = handle.includes("/") ? handle.slice(handle.lastIndexOf("/") + 1) : handle;
  const record = `{"nonce":${JSON.stringify(nonce)},"since":${JSON.stringify(now.toISOString().replace(/\.\d{3}Z$/, "Z"))},`
    + `"since_epoch":${pyFloat(now.getTime() / 1000)},"pid":${process.pid},"handle":${JSON.stringify(bare)},`
    + `"harness":${JSON.stringify(harness ?? "")},"ceiling_seconds":${pyFloat(ceilingSeconds)}}`;
  try {
    ftruncateSync(lock.fd, 0);
    writeSync(lock.fd, record, 0);
    fsyncSync(lock.fd);
  } catch (error) {
    try { ftruncateSync(lock.fd, 0); } finally { lock.release(); }
    throw error;
  }
  let released = false;
  return {
    path,
    release() {
      if (released) return;
      released = true;
      try { ftruncateSync(lock.fd, 0); fsyncSync(lock.fd); } finally { lock.release(); }
    },
  };
}

// ---- registry writes: reset custody, then the registry lock with the held-lock bound ----

/**
 * Run one registry mutation under reset custody. `acquireResetMutationLock`
 * rechecks the reset fence under its lock, so a reset that published first is
 * seen here. Returns the body's value, or a refusal with nothing written.
 */
async function underCustody<T>(scope: ClearScope, operation: string, body: (doc: Row) => T | null, signal?: AbortSignal): Promise<{ ok: true; value: T | null } | { ok: false; outcome: ReplaceOutcome }> {
  let reset;
  // tap-7t3ag: an interruptible door (one that passed a signal) auto-waits a
  // busy sidecar with a stderr progress line naming the holder; the async
  // wait yields, so Ctrl-C stays prompt and concurrent relaunch members keep
  // running. Cleanup consumes and non-interactive callers keep the bounded
  // quiet refusal, so an abort never blocks its own cleanup.
  const waiting = signal ? interactiveResetCustodyWaiting(operation) : undefined;
  try { reset = await acquireResetMutationLockAsync(scope.busHome, operation, undefined, "shared", waiting, signal); }
  catch (error) {
    if (error instanceof TapError) return { ok: false, outcome: refusal(error.errorClass, error.action, error.detail) };
    throw error;
  }
  try {
    const lock = acquireRegistryLock(scope.registryPath, RESET_HELD_LOCK_WAIT_MS);
    if (!lock) return { ok: false, outcome: refusal("registry_lock_busy", `retry ${operation}`, "the acting registry is busy; nothing was replaced") };
    // The current-format loader: a registry that turned old-format under us is
    // refused by name, never read and rewritten as a hybrid.
    try { return { ok: true, value: body(loadCurrentRegistry(scope.registryPath) as Row) }; }
    catch (error) {
      if (error instanceof ClearRefusal) return { ok: false, outcome: error.outcome };
      if (error instanceof OldStoreError) return { ok: false, outcome: { code: 1, errorClass: "old_store", action: error.action, detail: error.detail } };
      throw error;
    } finally { lock.release(); }
  } finally { reset.release(); }
}

/** The target a clear was authorized against: pane identity plus the generation it was observed under. */
export interface ClearTargetIdentity { paneId: string; epoch: string | null; generation: Observation }

export const RELAUNCH_IDENTITY_FIELDS = ["harness", "pane_id", "harness_session_id", "launch_workdir"] as const;
export interface RelaunchExpectation { identity: Row; resume: string | null }
export function relaunchIdentity(row: Row): Row {
  return Object.fromEntries(RELAUNCH_IDENTITY_FIELDS.map(field => [field, row[field] ?? null]));
}
export function refuseOnIdentityDrift(tag: string, expect: Row, row: Row): void {
  const moved = RELAUNCH_IDENTITY_FIELDS.filter(field => Object.hasOwn(expect, field) && (expect[field] ?? null) !== (row[field] ?? null));
  if (moved.length) throw new ClearRefusal(refusal("relaunch_identity_changed", "repeat the census before relaunching",
    `seat '${tag}' changed since enumeration (${moved.join(", ")}); nothing was replaced`));
}
export function checkRelaunchExpectation(scope: ClearScope, handle: string, row: Row, team: Row,
  expect: RelaunchExpectation | undefined, env: NodeJS.ProcessEnv): void {
  if (!expect) return;
  refuseOnIdentityDrift(handle, expect.identity, row);
  const fresh = recordFromRow(handle, row, team, scope.root);
  if ((fresh ? resolvedResumeIdentity(fresh, env) : null) !== expect.resume) {
    throw new ClearRefusal(refusal("relaunch_resume_changed", "repeat the census before relaunching",
      `seat '${handle}' now resolves to a different conversation than the one enumerated; nothing was replaced`));
  }
  if (fresh && expect.resume) {
    try {
      assertUniqueHarnessSessionIdentity([], { ...fresh, harness_session_id: expect.resume }, "tap session relaunch", { ...scope, handle });
    } catch (error) {
      if (error instanceof InvocationError) throw new ClearRefusal(refusal("duplicate_resume_identity",
        "repair the duplicate native identity before relaunching", error.message));
      throw error;
    }
  }
}

/** The row still names this pane under this server generation and boot. */
function rowStillTarget(row: unknown, target: ClearTargetIdentity): boolean {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return false;
  return voidedPaneId(row as Row, target.epoch) === target.paneId && !staleSeatGeneration(row, target.generation);
}

/**
 * Write the nonce the NEXT registration must carry, after rechecking that the
 * fresh row is still the target. Written before the respawn, so a clear that
 * fails halfway leaves an unmet expectation, which reads as "not rebound".
 * It is also the claim: whichever clear stamps last owns the expectation.
 */
export async function stampExpectedClearNonce(scope: ClearScope, handle: string, nonce: string, target: ClearTargetIdentity,
  record: LaunchRecord, verb: string, expect?: RelaunchExpectation, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<ReplaceOutcome | null> {
  const result = await underCustody(scope, verb, doc => {
    const row = seatMap(doc)[handle] as Row | undefined;
    if (!row || typeof row !== "object") throw new ClearRefusal(refusal("not_found", "tap team", `no seat '${handle}' on this bus`));
    if (!rowStillTarget(row, target)) {
      throw new ClearRefusal(refusal("clear_target_moved", `${verb} ${handle}`,
        `seat '${handle}' no longer names pane ${target.paneId} under this tmux server; nothing was replaced`));
    }
    checkRelaunchExpectation(scope, handle, row, (doc.team ?? {}) as Row, expect, env);
    Object.assign(row, { harness_env: record.harness_env ?? {}, harness_unset_env: record.harness_unset_env ?? [], harness_tail: record.harness_tail ?? [] });
    row.expected_clear_nonce = nonce;
    if (record.permissions != null) row.permissions = record.permissions;
    // A witness left by a PREVIOUS clear must not verify this one.
    delete row.clear_nonce;
    saveRegistry(scope.registryPath, doc);
    return true;
  }, signal);
  return result.ok ? null : result.outcome;
}

/**
 * Retire our pending question. Only the asker may: registration never pops
 * `expected_clear_nonce`. Pops only our own nonce, so a later clear's stamp
 * survives. Returns false when custody refused and the stamp was left standing.
 */
export async function consumeExpectedClearNonce(scope: ClearScope, handle: string, nonce: string, verb: string, signal?: AbortSignal): Promise<boolean> {
  return (await consumeClearNonce(scope, handle, nonce, verb, signal)).ok;
}

/**
 * The row's launch_witness (launch-evidence.ts) on retiring the nonce: "keep" when
 * nothing was replaced (the old incarnation still runs), "promote" only on
 * positive replacement evidence, "clear" when a replacement happened but was not
 * verified, so neither incarnation's token stays authoritative.
 */
type TokenOutcome = "keep" | "promote" | "clear";

async function consumeClearNonce(scope: ClearScope, handle: string, nonce: string, verb: string, signal?: AbortSignal, launchWorkdir?: string,
  token: TokenOutcome = "keep") {
  return underCustody(scope, verb, doc => {
    const row = seatMap(doc)[handle] as Row | undefined;
    if (!row || typeof row !== "object" || row.expected_clear_nonce !== nonce) return false;
    delete row.expected_clear_nonce;
    if (token === "promote") row.launch_witness = nonce;
    else if (token === "clear") delete row.launch_witness;
    // A relaunch --workdir: the harness now runs there, so the row says so. Written
    // here, after the last identity check, because launch_workdir is one of the
    // relaunch identity fields and stamping it earlier would read as drift.
    if (launchWorkdir !== undefined) row.launch_workdir = launchWorkdir;
    saveRegistry(scope.registryPath, doc);
    return true;
  }, signal);
}

/**
 * The rebind predicate: same handle, same pane, NEW process. respawn-pane keeps
 * the pane id, so the pane leg alone is satisfied by its own failure case; the
 * per-clear nonce breaks the tie. Both `clear_nonce` (what the fresh process
 * registered with) and `expected_clear_nonce` (whose clear this is) must equal
 * ours. The nonce is a freshness-and-claim tag, not a credential.
 */
export function clearRebindVerified(row: Row | null, paneId: string, epoch: string | null, nonce: string): boolean {
  if (!row || row.status !== "active" || !nonce) return false;
  if (voidedPaneId(row, epoch) !== paneId) return false;
  return row.expected_clear_nonce === nonce && row.clear_nonce === nonce;
}

/** Appends clear/relaunch observation timing for both outcomes; calibration writes are best effort. */
export function recordClearLatency(root: string, handle: string, harness: string, paneId: string,
  verified: boolean, seconds: number, timeout: number, operation: "clear" | "relaunch" = "clear"): void {
  const line = { at: timestamp(), handle, harness: harness ?? "", pane_id: paneId, verified, operation,
    seconds: Math.round(seconds * 100) / 100, timeout, loadavg1: Math.round(loadavg()[0]! * 100) / 100 };
  try {
    mkdirSync(join(root, ".tap"), { recursive: true });
    appendFileSync(join(root, ".tap", "clear-latency.jsonl"), `${JSON.stringify(line)}\n`);
  } catch { /* best effort */ }
}

/** Classify an unverified pane (tap-36kb). The class rides beside rc 7; 7 alone means "already replaced". */
export async function clearUnverifiedDiagnosis(post: PaneFacts | null, harness: string | null, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<[string, string]> {
  if (!post) return ["rebind_unverified_pane_gone", "the pane is GONE — the harness did not survive its start and the pane went with it despite remain-on-exit"];
  if (harness) {
    const blocker = await startupBlocker(post, harness, env, signal);
    if (blocker) return [blocker.startsWith("codex-hook-trust:") ? "harness_start_dialog" : "harness_start_unverified_picker", blocker];
  }
  if (!HARNESSES.includes(paneHarness(post, env))) {
    return ["rebind_unverified_not_a_harness", `the pane is alive but is running '${post.command}', not a harness — the process most likely exited immediately (check the pane for its error)`];
  }
  return ["rebind_unverified_starting", "the pane is alive and running a harness, so it is most likely still starting up and simply had not registered yet"];
}

// ---- target resolution (launcher.py clear_target_pane) ----

export interface ClearTarget extends ClearTargetIdentity { entry: Row; warnings: string[] }

/**
 * Resolve a handle to the LIVE pane an in-pane respawn will replace. Two guards
 * with deliberately opposite polarities: occupancy fails OPEN (an unreadable
 * session name only warns), self-clear fails CLOSED (an unprovable caller inside
 * tmux refuses). The caller pane comes from the tty walk alone, never TMUX_PANE.
 */
export async function clearTargetPane(scope: ClearScope, handle: string, opts: { verb?: string; restartHint?: string; rosterHint?: string;
  env?: NodeJS.ProcessEnv; caller?: CallingPaneObservation; signal?: AbortSignal } = {}): Promise<ClearTarget> {
  const verb = opts.verb ?? "tap clear", env = opts.env ?? process.env;
  const restartHint = opts.restartHint ?? `tap session restart ${handle}`, rosterHint = opts.rosterHint ?? "tap team";
  const fail = (errorClass: string, action: string, detail: string) => new ClearRefusal(refusal(errorClass, action, detail));
  const entry = registryEntry(scope.root, handle);
  if (!entry) throw fail("not_found", rosterHint, `no seat '${handle}' on this bus; run \`${rosterHint}\` to see who is registered`);
  opts.signal?.throwIfAborted();
  const generation = await observeGeneration(opts.signal);
  opts.signal?.throwIfAborted();
  const epoch = generation.epoch ?? await currentEpoch(env, opts.signal);
  // A row captured under a prior server generation or boot names an unrelated
  // pane on the reborn server; replacing it would replace a stranger (tap-24f).
  const paneId = voidedPaneId(entry, epoch);
  if (!paneId || staleSeatGeneration(entry, generation)) {
    throw fail("pane_identity_stale", restartHint, `seat '${handle}' has no usable pane identity on record (stale row, or ids captured under a previous tmux server). Its process is not there to replace — recreate the seat instead: ${restartHint}`);
  }
  const facts = await paneFacts(paneId, env, opts.signal);
  if (!facts || facts.pane_id !== paneId) {
    throw fail("pane_gone", restartHint, `seat '${handle}' is registered at pane ${paneId}, but that pane is gone. ${verb} replaces a live process in place; there is nothing to replace — recreate the seat instead: ${restartHint}`);
  }
  const warnings: string[] = [];
  const expected = await entrySession(entry, env, opts.signal) ?? "";
  const observed = facts.pane ? paneSession(facts.pane) : "";
  if (!expected || !observed) {
    warnings.push(`${verb}: WARNING: cannot confirm pane ${paneId} belongs to '${handle}' (expected session ${expected || "unknown"}, observed ${observed || "unknown"}); proceeding on the registry binding alone`);
  } else if (observed !== expected) {
    throw fail("pane_recycled", restartHint, `seat '${handle}' is on record in session '${expected}', but pane ${paneId} now lives in '${observed}' — the id has been recycled and that pane belongs to something else. Refusing to replace a process this seat does not own; re-register the seat, or recreate it: ${restartHint}`);
  }
  const caller = opts.caller ?? observeCallingPane(env, true);
  if (caller.state === "inside" && caller.paneId === paneId) {
    throw fail("self_clear", "ask a teammate to run it, or run it from another pane", `refusing to run ${verb} on '${handle}' from inside its own pane — it would end its own process before it could verify the rebind. Ask a teammate to run it, or run it from another pane.`);
  }
  if (caller.state === "unobservable" && env.TMUX) {
    throw fail("caller_pane_unprovable", "re-run from a pane whose controlling tty resolves, or from outside tmux", `refusing to run ${verb} on '${handle}': this command is running inside tmux but cannot identify its own pane, so it cannot prove it is not the target. Re-run from a pane whose controlling tty resolves, or from outside tmux.`);
  }
  return { paneId, epoch, generation, entry, warnings };
}

// ---- plan: one builder for dry run and effect (odt1d #2) ----

export interface ClearPlan { target: ClearTarget; record: LaunchRecord; nonce: string; invocation: Invocation; command: string; ceiling: number }

/**
 * Refuse an instruction the harness has no channel for, before any effect. Hermes
 * argv never carries a prompt and, unlike opencode, nothing delivers `-m` after
 * the rebind, so accepting it would exit 0 and drop the text (tap-boiq).
 */
export function refuseUnsupportedInstruction(harness: string, instruction: string | null | undefined, recipient: string,
  env: NodeJS.ProcessEnv): ReplaceOutcome | null {
  if (!instruction || harness !== "hermes") return null;
  const sender = (env.TAP_SELF ?? "").trim();
  return refusal("instruction_unsupported",
    `repeat without -m, then: tap send ${recipient} -f <file> --fyi --wake ${sender ? `--from ${sender}` : "--from <your-handle>"}`,
    `${harness} has no channel for a -m instruction (its argv carries no prompt); nothing was replaced`);
}

/**
 * Build the fresh-context launch from the target row. The nonce is minted here,
 * so a dry run prints the exact environment the respawn will carry, including
 * `TAP_CLEAR_ID`.
 */
export async function planClear(scope: ClearScope, handle: string, instruction: string | null,
  opts: { env?: NodeJS.ProcessEnv; caller?: CallingPaneObservation; notices?: Notices } = {}): Promise<ClearPlan> {
  const env = opts.env ?? process.env;
  const target = await clearTargetPane(scope, handle, { env, caller: opts.caller });
  const row = recordFromRow(handle, target.entry, {}, scope.root);
  if (!row) {
    throw new ClearRefusal(refusal("launch_recipe_missing", "re-register it from its live pane before clearing",
      `seat '${handle}' has no valid harness/session launch recipe on its row; re-register it from its live pane before clearing`));
  }
  const unsupported = refuseUnsupportedInstruction(row.harness, instruction, handle, env);
  if (unsupported) throw new ClearRefusal(unsupported);
  if (row.launch_workdir !== undefined) row.launch_workdir = validateLaunchWorkdir(scope.root, row.launch_workdir);
  // A FRESH conversation: reusing the old id would point the new process at a populated session.
  let record: LaunchRecord = await mintLaunchSessionId({ ...row, harness_session_id: null }, env);
  if (record.harness === "claude" && !record.harness_session_id) {
    record = { ...record, harness_session_id: freshLaunchSessionId("claude"), identity_capture_action: "new" };
  }
  const built = launchInvocation("new", record, opts.notices ?? new Notices(), { env, prompt: instruction });
  const nonce = randomUUID();
  const invocation: Invocation = { ...built, env: { ...built.env, TAP_CLEAR_ID: nonce, TAP_LAUNCH_ROOT: scope.root } };
  return { target, record, nonce, invocation, command: invocationShellCommand(invocation, env), ceiling: clearRebindTimeout(record.harness) };
}

// ---- the replacement (launcher.py replace_harness_in_pane, fresh-registration arm) ----

export interface ReplaceOptions {
  verb: string; handle: string; instruction: string | null; clearHistory: boolean;
  /** Present for relaunch: bind the census identity and use harness readiness. */
  relaunch?: RelaunchExpectation;
  /** Relaunch only: the validated `--workdir` the harness was respawned in; recorded on the row once the nonce is consumed. */
  launchWorkdir?: string;
  diagnostic?: (line: string) => void;
  signal?: AbortSignal;
  progress?: (line: string) => void;
  /** The TARGET seat's team, when the instruction must be addressed across teams. */
  team?: string; env?: NodeJS.ProcessEnv; pollMs?: number;
  /** Test seam: the opencode instruction send. Returns the send's exit code. */
  sendInstruction?: (recipient: string, instruction: string) => number | Promise<number>;
}

/**
 * Replace the harness inside an OCCUPIED pane and verify the fresh registration.
 * Order: fence → stamp (custody #1) → recheck → respawn → await → consume
 * (custody #2) → instruction → release fence. Once the respawn has been
 * attempted, nothing here retries it (no-retry-after-possible-effect).
 */
export async function replaceHarnessInPane(scope: ClearScope, plan: ClearPlan, opts: ReplaceOptions): Promise<ReplaceOutcome> {
  const { verb, handle } = opts, env = opts.env ?? process.env;
  const { target, record, nonce, ceiling } = plan, paneId = target.paneId;
  if (record.launch_workdir !== undefined) record.launch_workdir = validateLaunchWorkdir(scope.root, record.launch_workdir);
  prepareCodexAutoReceipts(record.harness, record.permissions, env);
  const fence = acquireClearFence(scope.busHome, handle, nonce, record.harness, ceiling);
  if (!fence) {
    let holder = "unknown", since = "unknown";
    try {
      const rec = readClearFence(scope.busHome, handle).rec;
      holder = rec && rec.pid !== undefined ? String(rec.pid) : holder;
      since = rec && rec.since !== undefined ? String(rec.since) : since;
    } catch { /* diagnostic only */ }
    return refusal("clear_in_progress", "wait for the in-flight replacement to finish, then retry",
      `another in-place replacement of '${handle}' is in progress (pid ${holder} since ${since}); nothing was changed`);
  }
  let respawned = false, workdirRecorded = false, respawnAttempted = false, remainMayBeOn = false, remainCleanupAttempted = false;
  // Interruption or a late exception after a SUCCESSFUL respawn: the harness already runs in the new
  // directory, so retiring the nonce also records it (same write the normal path makes), or the row
  // keeps naming the old one. Never retried; a failed write is reported, not hidden.
  const UNPERSISTED_ACTION = `tap team   # inspect the seat's row, and tap doctor for the registry; do not relaunch again, a second respawn would replace the running harness. The row keeps the old launch_workdir until a new, deliberate relaunch --workdir`;
  // `unpersisted` carries the structured write failure so an exceptional path can report the stable
  // launch_workdir_unpersisted class (with its own error as secondary detail) instead of reducing it to prose.
  const retireAfterRespawn = async (): Promise<{ retired: boolean; note: string; unpersisted?: string }> => {
    const workdir = respawned ? opts.launchWorkdir : undefined;
    // The normal path already consumed the nonce and saved the row: the nonce is gone, so a second consume
    // would read as "not written". Trust the recorded fact instead of inferring it from that no-op.
    if (workdirRecorded) return { retired: true, note: `; launch_workdir recorded as ${workdir}` };
    let retired = false, wrote = false, why = "";
    try {
      const c = await consumeClearNonce(scope, handle, nonce, verb, undefined, workdir, respawnAttempted ? "clear" : "keep");
      retired = c.ok; wrote = c.ok && c.value === true;
      why = c.ok ? "the seat row is gone or its clear expectation changed" : c.outcome.detail;
    } catch (error) {
      why = `${(error as { errorClass?: string }).errorClass ?? "error"}: ${(error as { detail?: string }).detail ?? (error as Error).message ?? String(error)}`;
    }
    // An ambiguous respawn (tmux may have run it, the client timed out or was cancelled first) proves no
    // effect, so the row is NOT recorded, but the possible new directory is disclosed.
    if (workdir === undefined) return { retired, note: respawnAttempted && opts.launchWorkdir !== undefined
      ? `; the harness may now run in ${opts.launchWorkdir}; launch_workdir was not updated` : "" };
    return { retired, note: wrote ? `; launch_workdir recorded as ${workdir}`
      : `; the harness runs in ${workdir} but the recorded launch_workdir was NOT updated`, ...(wrote ? {} : { unpersisted: why }) };
  };
  const unpersistedOutcome = (persisted: { unpersisted?: string }, original: string): ReplaceOutcome | null => persisted.unpersisted === undefined ? null
    : { code: 7, errorClass: "launch_workdir_unpersisted", action: `tmux attach -t ${paneId}   # the pane is the authority; then: ${UNPERSISTED_ACTION}`,
      detail: `respawned ${handle} at ${paneId}, but the harness now runs in ${opts.launchWorkdir}, the seat's recorded launch_workdir was NOT updated and the relaunch was not retried: ${persisted.unpersisted}; also ${original}${remainMayBeOn ? "; remain-on-exit may be on" : ""}` };
  const cleanupRemain = async () => {
    if (!remainMayBeOn || remainCleanupAttempted) return;
    remainCleanupAttempted = true;
    // Cancellation ends replacement work, not its cleanup. One fresh bounded
    // window covers the owner observation and disarm, while the fence is held.
    const signal = AbortSignal.timeout(2000);
    let failure = "";
    try {
      const current = await paneFacts(paneId, env, signal, true, 2000);
      if (!target.epoch || !current?.server_epoch || current.pane_id !== paneId || current.server_epoch !== target.epoch) {
        failure = "pane identity changed or is unobservable";
      } else {
        const disarm = await launchTmux(["set-option", "-p", "-t", paneId, "remain-on-exit", "off"], env, signal, true, 2000);
        remainMayBeOn = disarm.code !== 0;
        failure = disarm.stderr.trim() || `tmux exit ${disarm.code}`;
      }
    } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    if (remainMayBeOn) (opts.diagnostic ?? (line => process.stderr.write(`${line}\n`)))(
      `${verb}: WARNING: remain-on-exit cleanup unverified on pane ${paneId}; the option may still be on (${failure})`);
  };
  try {
    opts.signal?.throwIfAborted();
    const stamped = await stampExpectedClearNonce(scope, handle, nonce, target, record, verb, opts.relaunch, env, opts.signal);
    if (stamped) return stamped;
    // N1: the last decision before the effect reads the row and the pane again.
    const facts = await paneFacts(paneId, env, opts.signal);
    const doc = loadCurrentRegistry(scope.registryPath) as Row;
    const row = seatMap(doc)[handle] as Row | undefined;
    if (!row || !rowStillTarget(row, target) || row.expected_clear_nonce !== nonce
      || !facts || facts.pane_id !== paneId || (target.epoch !== null && facts.server_epoch !== target.epoch)) {
      await consumeExpectedClearNonce(scope, handle, nonce, verb);
      return refusal("clear_target_moved", `${verb} ${handle}`,
        `seat '${handle}' or pane ${paneId} changed after authorization; nothing was replaced`);
    }
    try { checkRelaunchExpectation(scope, handle, row, (doc.team ?? {}) as Row, opts.relaunch, env); }
    catch (error) { await consumeExpectedClearNonce(scope, handle, nonce, verb); throw error; }
    if (opts.relaunch && (!facts.server_epoch || !facts.pane_pid)) {
      await consumeExpectedClearNonce(scope, handle, nonce, verb);
      return refusal("pane_identity_unobservable", `tmux attach -t ${paneId}`, `pane ${paneId} has no observable pre-respawn identity; nothing was replaced`);
    }
    const warnings: string[] = [];
    // Armed BEFORE the replacement: a harness that dies on the way up otherwise
    // takes the pane (and a single-window seat's session) with it.
    remainMayBeOn = true;
    const arm = await launchTmux(["set-option", "-p", "-t", paneId, "remain-on-exit", "on"], env, opts.signal, true, tmuxTimeoutMs(["set-option"], env));
    opts.signal?.throwIfAborted();
    if (arm.code === 124) throw new PaneObservationTimeout(paneId);
    const remainArmed = arm.code === 0;
    opts.signal?.throwIfAborted();
    if (!remainArmed) {
      warnings.push(`${verb}: WARNING: could not arm remain-on-exit on pane ${paneId}; if the harness fails to start, the pane (and a single-window seat's session) will be lost rather than kept for inspection`);
    }
    let verified = false;
    let readinessReason: string | null = null;
    // After the respawn the process is already replaced: a registry that cannot
    // be read now is a post-effect state (exit 7), never a refusal.
    let afterEffect: { errorClass: string; action: string; detail: string; lead?: string } | null = null;
    try {
      // -k: also the hung-harness path. -c: the old process's cwd would rebind a wandered seat elsewhere.
      opts.signal?.throwIfAborted();
      opts.progress?.(`replacing ${record.harness} in pane ${paneId}`);
      respawnAttempted = true;
      const respawn = await launchTmux(["respawn-pane", "-k", "-t", paneId, "-c", launchWorkdir(record), plan.command], env, opts.signal, true, tmuxTimeoutMs(["respawn-pane"], env));
      // Recorded before any abort check: a cancellation racing a code-0 respawn must not lose the evidence
      // that the harness already runs in the new directory.
      if (respawn.code === 0) respawned = true;
      opts.signal?.throwIfAborted();
      if (respawn.code === 124) throw new PaneObservationTimeout(paneId);
      if (respawn.code !== 0) {
        await consumeExpectedClearNonce(scope, handle, nonce, verb);
        return { code: respawn.code, errorClass: "tmux_error", action: `tmux attach -t ${paneId}   # the pane is the authority`,
          detail: `could not respawn pane ${paneId}: ${respawn.stderr.trim() || `tmux exit ${respawn.code}`}` };
      }
      if (opts.clearHistory) await launchTmux(["clear-history", "-t", paneId], env, opts.signal, true, tmuxTimeoutMs(["clear-history"], env));
      opts.signal?.throwIfAborted();
      opts.progress?.(`respawn attempted; observing ${record.harness} startup for up to ${ceiling}s (pane ${paneId})`);
      const started = performance.now(), deadline = started + ceiling * 1000;
      if (opts.relaunch) {
        const readiness = await awaitReplacedHarness({ pane_id: paneId, harness: record.harness, timeout: ceiling,
          expected_server_epoch: facts.server_epoch, previous_pane_pid: facts.pane_pid, detect_resume_picker: true }, env, opts.signal);
        verified = readiness.ready;
        readinessReason = readiness.reason;
      } else {
        for (;;) {
          let row: Row | null;
          try { row = registryEntry(scope.root, handle); }
          catch (error) {
            if (!(error instanceof LauncherError) && !(error instanceof TapError)) throw error;
            afterEffect = { errorClass: error.errorClass ?? "registry_unreadable", action: error.action ?? "tap doctor", detail: error.detail ?? error.message };
            break;
          }
          if (clearRebindVerified(row, paneId, target.epoch, nonce)) { verified = true; break; }
          if (performance.now() >= deadline) break;
          await Bun.sleep(opts.pollMs ?? 250);
        }
      }
      recordClearLatency(scope.root, handle, record.harness, paneId, verified, (performance.now() - started) / 1000, ceiling, opts.relaunch ? "relaunch" : "clear");
    } finally {
      await cleanupRemain();
      for (const line of warnings) (opts.diagnostic ?? (line => process.stderr.write(`${line}\n`)))(line);
    }
    opts.signal?.throwIfAborted();
    let consumed: Awaited<ReturnType<typeof consumeClearNonce>>;
    try { consumed = await consumeClearNonce(scope, handle, nonce, verb, undefined, opts.launchWorkdir, verified ? "promote" : "clear"); }
    catch (error) {
      // A custody/registry read or write that THROWS after the respawn is still the post-effect case when
      // --workdir's row update was required; report it as launch_workdir_unpersisted naming the cause, not exit 1.
      if (opts.launchWorkdir === undefined) throw error;
      consumed = { ok: false, outcome: { code: 1, errorClass: "registry_write_failed", action: "tap doctor",
        detail: `${(error as { errorClass?: string }).errorClass ?? "error"}: ${(error as { detail?: string }).detail ?? (error as Error).message ?? String(error)}` } };
    }
    if (!consumed.ok && consumed.outcome.errorClass === "old_store") afterEffect ??= consumed.outcome;
    if (opts.launchWorkdir !== undefined && consumed.ok && consumed.value === true) workdirRecorded = true;
    // An explicit --workdir exists to change the stored recipe, so the row update is not best-effort:
    // the harness already runs in the new directory, and a row that still names the old one sends the
    // next clear or relaunch back there. Report it as the post-effect failure it is; never retry.
    if (opts.launchWorkdir !== undefined && (!consumed.ok || consumed.value !== true)) {
      const why = consumed.ok ? "the seat row is gone or its clear expectation changed" : `${consumed.outcome.detail}`;
      // An earlier post-effect finding (old_store, unreadable registry) must not hide this one: name both.
      const prior = afterEffect as { errorClass: string; detail: string } | null;
      afterEffect = { errorClass: "launch_workdir_unpersisted", action: UNPERSISTED_ACTION,
        lead: `the harness now runs in ${opts.launchWorkdir}, but the seat's recorded launch_workdir was NOT updated and the relaunch was not retried`,
        detail: !prior ? why : prior.detail !== why ? `${why}; also ${prior.errorClass}: ${prior.detail}` : `${why} (${prior.errorClass})` };
    }
    if (afterEffect) {
      return { code: 7, errorClass: afterEffect.errorClass,
        action: `tmux attach -t ${paneId}   # the pane is the authority; then: ${afterEffect.action}`,
        detail: `respawned ${handle} at ${paneId}, but ${afterEffect.lead ?? "its team registry cannot be read, so the rebind cannot be verified"}: ${afterEffect.detail}` };
    }
    if (!consumed.ok) {
      (opts.diagnostic ?? (line => process.stderr.write(`${line}\n`)))(`${verb}: WARNING: could not retire the clear expectation on '${handle}' (reset custody or registry busy); it reads as not rebound until the next clear`);
    }
    if (!verified) {
      const post = readinessReason ? null : await paneFacts(paneId, env, opts.signal);
      let [errorClass, state] = readinessReason
        ? [readinessReason.startsWith("codex-hook-trust:") ? "harness_start_dialog" : readinessReason.startsWith("pane observation timed out") ? "pane_observation_timeout" : "harness_start_unverified_picker", readinessReason]
        : await clearUnverifiedDiagnosis(post, record.harness, env, opts.signal);
      opts.signal?.throwIfAborted();
      if (opts.relaunch) {
        errorClass = errorClass.replace("rebind_unverified", "harness_start_unverified");
        if (post?.dead) {
          errorClass = "harness_start_unverified_dead";
          state = "the pane is present but the resumed harness exited before readiness was observed";
        }
      }
      return { code: 7, errorClass, action: `tmux attach -t ${paneId}   # the pane is the authority`,
        detail: `respawned ${handle} at ${paneId}, but ${opts.relaunch ? "the intended harness was not verified" : "it did not re-register with this witness"} within ${ceiling}s: ${state}.` };
    }
    if (opts.instruction && record.harness === "opencode") {
      // The fence is still held, so the send parks (reason=clearing) and drain
      // delivers it before anything parked later in the window.
      const recipient = opts.team ? `${opts.team}/${handle}` : handle;
      const rc = opts.sendInstruction ? await opts.sendInstruction(recipient, opts.instruction) : await sendClearInstruction(recipient, opts.instruction, scope.busHome, !!opts.relaunch);
      if (rc !== 0) {
        const sender = (env.TAP_SELF ?? "").trim();
        return { code: 6, errorClass: "instruction_undelivered",
          action: `tap send ${recipient} -f <file> --fyi --wake ${sender ? `--from ${sender}` : "--from <your-handle>"}`,
          detail: `replaced ${handle} (${record.harness}) in place at ${paneId}, but the -m instruction did not land (send exit ${rc})` };
      }
    }
    return { code: 0, errorClass: "", action: "", detail: `${verb}: ${opts.relaunch ? "resumed" : "cleared"} ${handle} (${record.harness}) in place at ${paneId}` };
  } catch (error) {
    // The arm itself may have taken effect before failing or being cancelled.
    await cleanupRemain();
    if (opts.signal?.aborted) {
      // No second respawn and no claim that the old process survived. Retire
      // only our nonce; the pane remains the authority after a possible effect.
      const persisted = await retireAfterRespawn();
      // A failed required write outranks the interruption: the harness runs in the new directory with a stale row.
      const unpersisted = unpersistedOutcome(persisted, "relaunch_interrupted: interrupted after respawn was attempted; replacement state unverified");
      if (unpersisted) return unpersisted;
      const cleanup = (persisted.retired ? "" : "; clear expectation cleanup unverified") + persisted.note;
      const reason = opts.signal.reason;
      return { code: reason instanceof LaunchInterrupted ? reason.exitCode : 130, errorClass: "relaunch_interrupted",
        action: respawnAttempted ? `tmux attach -t ${paneId}   # inspect before deciding whether to relaunch` : `${verb} ${handle}`,
        detail: (respawnAttempted ? "interrupted after respawn was attempted; replacement state unverified"
          : "interrupted before respawn; nothing was replaced") + cleanup + (remainMayBeOn ? "; remain-on-exit may be on" : "") + "; no retry performed" };
    }
    if (error instanceof PaneObservationTimeout) {
      const persisted = await retireAfterRespawn();
      const unpersisted = unpersistedOutcome(persisted, `pane_observation_timeout: ${error.detail}`);
      if (unpersisted) return unpersisted;
      return { code: respawnAttempted ? 7 : 2, errorClass: "pane_observation_timeout", action: error.action!,
        detail: (respawnAttempted ? `respawn was attempted for ${handle}; ${error.detail}; replacement state unverified`
          : `${error.detail}; nothing was replaced`) + (persisted.retired ? "" : "; clear expectation cleanup unverified") + persisted.note
          + (remainMayBeOn ? "; remain-on-exit may be on" : "") };
    }
    if (error instanceof ClearRefusal) return error.outcome;
    if (error instanceof OldStoreError) return { code: 1, errorClass: "old_store", action: error.action, detail: error.detail };
    if (respawned && opts.launchWorkdir !== undefined) {
      // Any other exception after a successful respawn (a spawn error, a failed process-group termination in a
      // later observation) is the same post-effect case: record the workdir, report exit 7, never retry.
      const persisted = await retireAfterRespawn();
      const unpersisted = unpersistedOutcome(persisted, `post_respawn_error: ${(error as { detail?: string }).detail ?? (error as Error).message ?? String(error)}`);
      if (unpersisted) return unpersisted;
      return { code: 7, errorClass: "post_respawn_error", action: `tmux attach -t ${paneId}   # the pane is the authority; inspect it, and tap doctor for the registry; do not relaunch again`,
        detail: `respawned ${handle} at ${paneId}, but a later step failed: ${(error as { detail?: string }).detail ?? (error as Error).message ?? String(error)}${persisted.retired ? "" : "; clear expectation cleanup unverified"}${persisted.note}${remainMayBeOn ? "; remain-on-exit may be on" : ""}` };
    }
    throw error;
  } finally {
    fence.release();
  }
}

/**
 * Place the opencode `-m` text as a settle-only bus payload, in-process (the
 * Python door spawned `bun main.ts send`). `--wake` keeps it OWED by the seat
 * that reads it: courier pre-settlement must not write its `.done`.
 */
async function sendClearInstruction(recipient: string, instruction: string, busHome: string, quiet = false): Promise<number> {
  // Dynamic import supports the compiled router's top-level-await closure.
  const { cmdSend } = await import("../verbs/send");
  const { AGENT_FAMILIES } = await import("../harness-families");
  const dir = join(busHome, "tmp");
  const path = join(dir, `.tap-clear-instruction.${randomUUID()}.md`);
  try {
    mkdirSync(dir, { recursive: true });
    // A file, not -m: the instruction is caller prose and may quote commands.
    writeFileSync(path, "This instruction arrived over the TAP bus, not as process argv (opencode has no interactive "
      + "initial-prompt form; the positional is a project directory).\n\n" + `${instruction.trimEnd()}\n`);
    const argv = [recipient, "-f", path, "--fyi", "--wake"];
    const sender = (process.env.TAP_SELF ?? "").trim();
    if (sender) argv.push("--from", sender);
    return cmdSend(argv, tapScriptsDir(), AGENT_FAMILIES, { quiet });
  } catch {
    return 1;
  } finally {
    try { unlinkSync(path); } catch { /* already gone */ }
  }
}

// ---- dark entry (tests only until R7b routes `tap clear`) ----

/** Resolve the caller team's scope from cwd, as `tap clear` does (a seat verb: the calling pane's
 * team wins over an enrolled cwd, tap-djlri). A caller that already resolved its team (refresh)
 * names it, so the selection is fresh and revalidated here yet never a different team from the
 * caller's preflight and retirement. */
export function clearScopeForCwd(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env, team?: string): ClearScope {
  const ctx = resolveContext(cwd, env, team ? { explicitTeam: team } : undefined);
  return { root: ctx.root, registryPath: ctx.registryPath, busHome: ctx.bus.home };
}

function printOutcome(outcome: ReplaceOutcome, verb: string): void {
  if (outcome.code === 0) { process.stdout.write(`${outcome.detail}\n`); return; }
  if (process.env.TAP_JSON === "1") {
    process.stdout.write(`${JSON.stringify({ ok: false, error_class: outcome.errorClass, action: outcome.action, detail: outcome.detail })}\n`);
    return;
  }
  process.stderr.write(`${verb}: ${outcome.detail.replace(/[\r\n]/g, " ")}; next: ${outcome.action}\n`);
}

/** A caller that already resolved its scope (refresh): the clear is selected fresh, pinned to
 * the caller's enrolled team when it has one (a custom TAP_HOME bus has no index row to pin, so
 * the same cwd/TAP_HOME resolution reproduces it), and refuses before any effect when the fresh
 * selection no longer matches the caller's (`expect`), so the caller's later phases never run
 * against a moved registry. */
export interface ClearPin { team?: string; expect: ClearScope }

/** `tap clear <seat> [-m <instruction>] [--dry-run]`. */
export async function cmdClearNative(argv: string[], env: NodeJS.ProcessEnv = process.env, pin?: ClearPin): Promise<number> {
  const verb = "tap clear";
  let seat: string | null = null, message: string | null = null, dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "-m" || arg === "--message") {
      // argparse parity: an option-shaped or missing operand is a usage error, never a silent clear.
      const value = argv[i + 1];
      if (value === undefined || (value.startsWith("-") && value !== "-" && !value.includes(" "))) {
        process.stderr.write(`${verb}: ${arg} needs an instruction; usage: tap clear <seat> [-m <instruction>]\n`); return 2;
      }
      message = value; i++;
    }
    else if (!arg.startsWith("-") && seat === null) seat = arg;
    else { process.stderr.write(`${verb}: usage: tap clear <seat> [-m <instruction>]\n`); return 2; }
  }
  if (!seat) { process.stderr.write(`${verb}: usage: tap clear <seat> [-m <instruction>]\n`); return 2; }
  let scope: ClearScope;
  try {
    scope = clearScopeForCwd(process.cwd(), env, pin?.team);
    if (pin && (scope.root !== pin.expect.root || scope.registryPath !== pin.expect.registryPath || scope.busHome !== pin.expect.busHome)) {
      printOutcome(refusal("team_moved", "re-run the command", `team '${pin.team ?? scope.root}' is no longer where its caller resolved it (${pin.expect.registryPath} -> ${scope.registryPath}); nothing was cleared`), verb);
      return 2;
    }
    assertResetUnfenced(scope.busHome, "clear");
  } catch (error) {
    if (error instanceof TapError) { printOutcome(refusal(error.errorClass, error.action, error.detail), verb); return 2; }
    throw error;
  }
  let plan: ClearPlan;
  const notices = new Notices();
  notices.suppress(env.TAP_JSON === "1");
  try { plan = await planClear(scope, seat, message, { env, notices }); }
  catch (error) {
    if (error instanceof ClearRefusal) { printOutcome(error.outcome, verb); return 2; }
    if (error instanceof LauncherError) {
      // An old-format team registry is refused by name with rc 1 (launcher.py parity).
      const outcome = refusal(error.errorClass ?? "session_error", error.action ?? "tap help clear", error.detail ?? error.message);
      printOutcome(outcome, verb);
      return error.errorClass === "old_store" ? 1 : 2;
    }
    throw error;
  }
  for (const line of plan.target.warnings) process.stderr.write(`${line}\n`);
  if (dryRun) {
    process.stdout.write(`${plan.command}\n`);
    if (message && plan.record.harness === "opencode") {
      process.stdout.write("tap clear: opencode instruction rides tap send after rebind (no argv channel; fence holds the send so drain delivers it first)\n");
    }
    return 0;
  }
  const outcome = await replaceHarnessInPane(scope, plan, { verb, handle: seat, instruction: message, clearHistory: true, env });
  printOutcome(outcome, verb);
  return outcome.code;
}

if (import.meta.main) process.exitCode = await cmdClearNative(process.argv.slice(2));
