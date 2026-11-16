import { dueWaitCue, protectedMessageDeadline, protectedMessageState, protectionUntil } from "./input-protection";
// One drain owner. Pane observation and submit/custody stay behind the retained
// Bash interface; queue decisions and the three phase ordering live here.
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { cleanupPark, MAX_PARK_NOTICES_PER_PASS, parkCleanupDue, parkedIds } from "./spool-expiry";
import { appendRegistryEventOrWarn } from "./events";
import { validId } from "./ids";
import { digestDraftPlan, injectionBehavior } from "./injection-behavior";
import { DEFAULT_AGENT_FAMILIES, harnessFamily } from "./observe";
import { acquireObligationLock, type PaneLock } from "./panelock";
import { markResetGenerationReused, RESET_HELD_LOCK_WAIT_MS } from "./reset";
import {
  disposeAtDeadline, disposeGraceDue, disposeSenderGone, disposeUnrouted, graceAttempted, isDone, underDrainCustody,
  notifySenderOnEscalate, recipientIsPresent, reconcileSettled, registryMatchesTeam,
  type DeadlineContext, type DeadlineRow,
} from "./spool-deadline";
import { PyFloat, PyInt, pyStrCompare, pyTruthy } from "./spool-publication";
import { pythonInt } from "./pyint";
import { retirementCandidates, retirementNoticeIds, withdrawRetired } from "./spool-retired";
import { type ClaimToken, bumpAttempts, claimAcquire, claimRelease, metaPath, payloadPath, pyPrint, reapStaleSidecars, removeEntryAsync } from "./spool-sidecar";
import { recoverStrandedReparks } from "./spool-repark";
import { rebindRestartedSeats } from "./spool-rebind";
import { listEntries, liveProbes, noteBusyProbe, noteLiveProbe, updateHeldVisits, type SpoolRow } from "./spool-state";
import { pendingReprobe, stagedIdleSubmitEligible } from "./submit-phase";
import { reapSettledDigests } from "./digest-index";
import { emptyGcBatch, type GcBatch } from "./spool-gc";
import { envelopeField } from "./envelope";
import { armPath } from "./watch-notice";
import { fieldValue, readLoose } from "./watch-lease";
import { KIND_DELIVERY_FAILED } from "./notice";
import { loadRegistry, seatMap } from "./registry";
import { acquireStallLock, harnessEvidence, noteStallNotified, observeStall, stallBoundSeconds, stallNoticeId } from "./readiness-stall";
import { rowRetry } from "./retry";

export interface DrainContext extends DeadlineContext {
  gcBatch?: GcBatch;
  payloadsDir: string;
  receiptsDir: string;
  courierIdentity: string;
  active?: boolean;
  signal?: AbortSignal;
}

/**
 * The supervising leader: the armer of a supervision watch on this bus. A
 * reminders-only arm names a seat that scheduled its own reminders, not a leader.
 */
function supervisingLeader(home: string): string {
  const rec = readLoose(armPath(home));
  return fieldValue(rec, "mode") === "supervision" ? fieldValue(rec, "armed_by") : "";
}

/**
 * First observed probe of a named human-owned surface publishes one durable alert
 * per payload; the payload stays queued. Shell mode alerts the sender. A Claude
 * feedback card hiding the composer also alerts the supervising leader, because the
 * blocked seat is often its own sender (reminders) and only a human or the leader
 * can clear it once the courier will not.
 */
function notifyHeld(ctx: DrainContext, row: DeadlineRow, outcome: "shell-mode" | "feedback-draft"): boolean {
  const env = ctx.env ?? process.env;
  const lock = acquireObligationLock(row.id, 0, env);
  if (!lock) return false;
  let claimToken: ClaimToken | null = null;
  try {
    const claim = claimAcquire(ctx.spoolDir, row.id, false, env);
    if (claim.status !== "acquired") return false;
    claimToken = claim.token;
    const base = { id: row.id, target: row.target, targetRegistry: row.targetRegistry, outcome };
    if (outcome === "shell-mode") {
      return notifySenderOnEscalate(ctx, { ...base, detail: "OpenCode shell mode blocks chat delivery", durableId: `${row.id}-shell-mode` });
    }
    const detail = "Claude feedback-draft card hides the composer";
    const sent = notifySenderOnEscalate(ctx, { ...base, detail, durableId: `${row.id}-feedback-draft` });
    const leader = supervisingLeader(ctx.home);
    let sender = "";
    try { sender = envelopeField(readFileSync(payloadPath(ctx.spoolDir, row.id), "utf8"), "from") ?? ""; } catch { /* unreadable: the notice path refused too */ }
    if (!leader || leader === sender || leader === row.target) return sent;
    return notifySenderOnEscalate(ctx, { ...base, detail, durableId: `${row.id}-feedback-draft-leader`, addressee: leader }) && sent;
  } finally {
    if (claimToken !== null) claimRelease(ctx.spoolDir, row.id, claimToken);
    lock.release();
  }
}

/**
 * tap-bprtg: a seat read as booting or no-prompt continuously past the bound,
 * while its harness positively shows its last turn ended and no activity since,
 * is probably misread. Publish one durable alarm per stuck episode to the
 * supervising leader and to the sender of the oldest payload held for it. The
 * episode lives in seat-state/<handle>.stall.json (readiness-stall.ts) and
 * re-arms when the seat reads otherwise. Report only: no pane input, and
 * delivery, custody and deadlines never consult the episode.
 */
function observeSeatStall(ctx: DrainContext, row: DeadlineRow, ready: string, held: number): boolean {
  const env = ctx.env ?? process.env;
  const bound = stallBoundSeconds(env);
  let seat: Record<string, unknown> | undefined;
  try { seat = seatMap(loadRegistry(row.targetRegistry))[row.target]; } catch { seat = undefined; }
  const instance = typeof seat?.instance === "string" ? seat.instance : "";
  const evidence = seat && typeof seat.harness === "string" ? harnessEvidence(seat.harness, seat, env) : null;
  const binding = { home: ctx.home, registry: row.targetRegistry, handle: row.target, paneId: row.paneId, instance };
  const stallLock = acquireStallLock(binding, env);
  if (!stallLock) return false;
  try {
    const due = observeStall({ ...binding, verdict: ready, evidence, now: ctx.now, bound });
    if (!due) return false;
    // Binding-scoped, deterministic ids: a retired oldest payload cannot mint a second
    // copy, and each addressee's copy is tracked on its own.
    const senderId = stallNoticeId(binding, due.since), leaderId = `${senderId}-leader`;
    const leader = supervisingLeader(ctx.home);
    let sender = "";
    try { sender = envelopeField(readFileSync(payloadPath(ctx.spoolDir, row.id), "utf8"), "from") ?? ""; } catch { /* unreadable: the notice path refused too */ }
    const wantLeader = !!leader && leader !== sender && leader !== row.target;
    const pending = [senderId, ...(wantLeader ? [leaderId] : [])].filter(nid => !due.notified.includes(nid));
    if (!pending.length) return false;
    const lock = acquireObligationLock(row.id, 0, env);
    if (!lock) return false;
    let claimToken: ClaimToken | null = null;
    try {
      const claim = claimAcquire(ctx.spoolDir, row.id, false, env);
      if (claim.status !== "acquired") return false;
      claimToken = claim.token;
      const detail = `${row.target} has read as ${ready} past the ${bound}s alarm bound; ${held} payload(s) to it are held.`;
      const base = { id: row.id, target: row.target, targetRegistry: row.targetRegistry, outcome: "stuck-readiness" as const, detail };
      const published = pending.filter(nid => notifySenderOnEscalate(ctx,
        nid === leaderId ? { ...base, durableId: nid, addressee: leader } : { ...base, durableId: nid }));
      if (published.length) noteStallNotified(binding, published);
      return published.length > 0;
    } finally {
      if (claimToken !== null) claimRelease(ctx.spoolDir, row.id, claimToken);
      lock.release();
    }
  } finally { stallLock.release(); }
}

/** A courier notice in the spool cannot represent its seat: the notice path refuses to notify about a notice. */
function isCourierNotice(ctx: DrainContext, id: string): boolean {
  try { return envelopeField(readFileSync(payloadPath(ctx.spoolDir, id), "utf8"), "kind") === KIND_DELIVERY_FAILED; }
  catch { return true; }
}

export interface SpoolBinding {
  target: string;
  pane: string;
  paneId: string;
  toTeam: string;
  targetRegistry: string;
  policy?: string;
}

export interface DrainEffects {
  /** A listing snapshot; production uses listEntries. Controlled writers can
   * finish publication after this read without changing the captured rows. */
  entries?(target: string, registry: string): SpoolRow[];
  readiness(binding: SpoolBinding): Promise<string>;
  harness(pane: string): Promise<string>;
  flash(binding: SpoolBinding, id: string): Promise<void>;
  /** A snoozed pane: claim-and-flash the pane-shared milestone instead of per-id cues. */
  flashCue?(binding: SpoolBinding, id: string): Promise<void>;
  repairOrphans(names?: readonly string[]): Promise<void>;
  /** Caller already owns the obligation and claim; never reacquire either. */
  redeliverLocked(id: string, binding: SpoolBinding, force: boolean): Promise<number>;
  digest(binding: SpoolBinding, ids: string[]): Promise<number>;
}

export function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}
function isDir(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}
export function hasPayloads(spool: string): boolean {
  return readdirSync(spool).some(name => !name.startsWith(".") && name.endsWith(".md"));
}

/** The bootstrap marker protects all three pane entrances. A custom bus path is
 * supported; pathname shape is neither intent nor provenance. This is an intent
 * gate, not proof against a caller deliberately setting the hermetic override. */
export function authorizedHome(ctx: DrainContext, caller: string): boolean {
  if (isFile(join(ctx.home, ".tap-bus-authority")) || (ctx.env ?? process.env).TAP_SPOOL_PANE_EFFECTS_UNSTAMPED_HOME_OK === "1") return true;
  process.stderr.write(`tap: ${caller} refused — TAP_HOME '${ctx.home}' carries no .tap-bus-authority (never bootstrapped by a real tap verb); run 'tap_ensure_dirs' against this TAP_HOME first if it should be a real bus. Only if this is a deliberate hermetic caller that must inject without bootstrapping, set TAP_SPOOL_PANE_EFFECTS_UNSTAMPED_HOME_OK=1 (tap-ncd4)\n`);
  return false;
}

function stringField(value: unknown): string { return pyTruthy(value) ? pyPrint(value) : ""; }
export function deadlineRow(row: SpoolRow): DeadlineRow {
  return {
    id: stringField(row.id), target: stringField(row.target), reason: stringField(row.reason),
    reasonClass: stringField(row.reason_class), timeoutSeconds: stringField(row.timeout_seconds),
    firstEpoch: stringField(row.first_spooled_epoch), pane: stringField(row.pane), paneId: stringField(row.pane_id),
    toTeam: stringField(row.to_team), targetRegistry: stringField(row.target_registry), policy: stringField(row.policy),
    deadlineEpoch: stringField(row.deadline_epoch), escalatedAt: stringField(row.escalated_at),
    deadlineSource: stringField(row.deadline_source), holdUntilEpoch: stringField(row.hold_until_epoch),
  };
}

// Bash's numeric tests do not evaluate arithmetic expressions. An unreadable
// comparison is false, never permission to force or deliver early.
function integer(text: string): bigint | null {
  return /^[+-]?\d+$/.test(text.trim()) ? BigInt(text.trim()) : null;
}
/** Resume the disposition budget once at STOP release/expiry, never at each probe. */
function afterOperatorStop(row: DeadlineRow, stopUntil: number | undefined): DeadlineRow {
  if (!stopUntil) return row;
  const first = integer(row.firstEpoch), deadline = integer(row.deadlineEpoch);
  const resume = BigInt(Math.ceil(stopUntil / 1000));
  if (first === null || deadline === null || first > resume) return row;
  // Pending-input parks may encode the STOP duration itself as grace; their
  // normal post-hold window is still the ordinary/urgent draft grace.
  const window = row.reason === "pending-input" ? (row.policy === "urgent" ? 10n : 30n) : deadline - first;
  if (window <= 0n) return row;
  return { ...row, deadlineEpoch: String(resume + window) };
}
function before(a: string, b: string): boolean {
  const left = integer(a), right = integer(b);
  return left !== null && right !== null && left < right;
}
function atLeast(a: string, b: string): boolean {
  const left = integer(a), right = integer(b);
  return left !== null && right !== null && left >= right;
}
function inWindow(row: DeadlineRow, now: string): boolean {
  return !!row.holdUntilEpoch && before(now, row.holdUntilEpoch)
    && (!row.firstEpoch || row.firstEpoch === "0" || atLeast(now, row.firstEpoch));
}
function phaseADue(row: DeadlineRow, now: string): boolean {
  return !row.holdUntilEpoch || !before(now, row.holdUntilEpoch)
    || (!!row.firstEpoch && row.firstEpoch !== "0" && before(now, row.firstEpoch));
}
function files(ctx: DrainContext, id: string): boolean {
  return isFile(payloadPath(ctx.spoolDir, id)) && isFile(metaPath(ctx.spoolDir, id));
}
/** Scratch-only ordering barrier, the shape of read.ts's readTestBarrier; production never
 *  sets it. Pauses Phase B for one id after its readiness answer and before the obligation
 *  lock and claim: `.reached` carries the answer, `.release` resumes the drain. The marker
 *  is published by rename so a reader that sees it also sees the answer, never an empty file. */
async function drainTestBarrier(env: NodeJS.ProcessEnv, id: string, ready: string): Promise<void> {
  const base = env.TAP_DRAIN_TEST_BARRIER;
  if (!base || !env.TAP_SCRATCH_ONLY || env.TAP_DRAIN_TEST_ID !== id) return;
  writeFileSync(`${base}.reached.tmp`, `${ready}\n`);
  renameSync(`${base}.reached.tmp`, `${base}.reached`);
  const deadline = Date.now() + 60_000;
  while (!existsSync(`${base}.release`)) {
    if (Date.now() >= deadline) throw new Error("drain test barrier timed out");
    await Bun.sleep(5);
  }
}
function error(slice: string, id: string, failure: unknown): void {
  process.stderr.write(`tap: slice_failed id=${id || "-"} slice=${slice}: ${String(failure)}\n`);
}
function bestEffort<T>(slice: string, id: string, fn: () => T): T | undefined {
  try { return fn(); } catch (failure) { error(slice, id, failure); return undefined; }
}
async function bestEffortAsync<T>(ctx: DrainContext, slice: string, id: string, fn: () => Promise<T>): Promise<T | undefined> {
  try { return await fn(); }
  catch (failure) { ctx.signal?.throwIfAborted(); error(slice, id, failure); return undefined; }
}
function event(ctx: DrainContext, action: string, handle: string, pane: string, detail: string): void {
  appendRegistryEventOrWarn(ctx.verbLabel, { log: ctx.eventLog, actor: "courier", action, handle, pane,
    detail, team: ctx.team, env: ctx.env });
}

/** Retirement uses the same obligation → no-steal claim order as cancellation. */
export async function withdrawRetiredEntry(ctx: DrainContext, id: string, registry: string): Promise<number> {
  if (!validId(id)) return 1;
  const lock = acquireObligationLock(id, 0, ctx.env);
  if (!lock) return 0;
  let claimToken: ClaimToken | null = null;
  const noticeLocks: PaneLock[] = [];
  try {
    const claim = claimAcquire(ctx.spoolDir, id, true, ctx.env);
    if (claim.status !== "acquired") return 0;
    claimToken = claim.token;
    // Obligation locks sit above reset, and a reset holder never waits on one
    // (tap-12ys6): lock both possible notice identities before custody.
    const noticeIds = retirementNoticeIds(ctx.home, id);
    for (const noticeId of noticeIds) {
      const noticeLock = acquireObligationLock(noticeId, 1000, ctx.env);
      if (!noticeLock) throw new Error("retirement notice busy; spool retained");
      noticeLocks.push(noticeLock);
    }
    // The canonical link, receipt and spool removal are one custody span, so a
    // reset copies the body on one side of it (tap-g191v). The removal's metadata
    // wait is bounded; on expiry custody is released, the entry stays, and the
    // next pass retries the removal.
    const wakes: (() => void)[] = [];
    const held = await underDrainCustody(ctx, "retire", id, async () => {
      if (!withdrawRetired(ctx.home, id, registry, wakes, new Set(noticeIds))) return;
      markResetGenerationReused(ctx.home, "spool-instance-retired");
      event(ctx, "spool_instance_retired", id, "", `receipt=${id}.cancelled`);
      await removeEntryAsync(ctx.spoolDir, id, ctx.signal, ctx.env, RESET_HELD_LOCK_WAIT_MS);
    });
    for (const noticeLock of noticeLocks.splice(0)) noticeLock.release();
    for (const wake of wakes) bestEffort("spool-retired", id, wake);
    return held.ok ? 0 : 1;
  } finally {
    for (const noticeLock of noticeLocks) noticeLock.release();
    if (claimToken !== null) claimRelease(ctx.spoolDir, id, claimToken);
    lock.release();
  }
}

function orderedPerId(rows: SpoolRow[]): SpoolRow[] {
  // Python int(), including integral/fractional JSON numbers and exact integers.
  const counter = (v: unknown): bigint | null => {
    if (v instanceof PyInt) return BigInt(v.source);
    if (v instanceof PyFloat) return Number.isFinite(v.value) ? BigInt(Math.trunc(v.value)) : null;
    if (typeof v === "number") return Number.isFinite(v) ? BigInt(Math.trunc(v)) : null;
    if (typeof v === "boolean") return v ? 1n : 0n;
    return typeof v === "string" ? pythonInt(v, true) : null;
  };
  return rows.sort((a, b) => {
    const ah = counter(a.held_drain_visits) ?? 0n, bh = counter(b.held_drain_visits) ?? 0n;
    if (ah !== bh) return ah < bh ? -1 : 1;
    const ae = counter(a.first_spooled_epoch), be = counter(b.first_spooled_epoch);
    if (ae !== be) return ae === null ? 1 : be === null ? -1 : ae < be ? -1 : 1;
    return pyStrCompare(stringField(a.id), stringField(b.id));
  });
}

export async function drainOnce(ctx: DrainContext, effects: DrainEffects,
  input: { cap?: string; target?: string; registry?: string } = {}): Promise<number> {
  const env = ctx.env ?? process.env;
  ctx.signal?.throwIfAborted();
  if (ctx.active || env.TAP_SPOOL_DRAIN_ACTIVE === "1") return 0;
  // Custody around each durable effect is the guarantee (tap-g191v); these
  // re-checks only stop a pass early once a reset fence lands.
  const fenced = () => isFile(join(ctx.home, "reset.fence.json"));
  if (fenced() || !isDir(ctx.spoolDir)) return 0;
  if (!authorizedHome(ctx, "tap_spool_drain_once")) return 1;
  const target = input.target || "", registry = input.registry || "";
  if (target && !registry) return 0;
  const cap = integer(input.cap || env.TAP_SPOOL_DRAIN_CAP || "8");
  const now = String(ctx.now);
  const helperNow = () => env.TAP_SPOOL_NOW && /^[0-9]+$/.test(env.TAP_SPOOL_NOW) ? Number(env.TAP_SPOOL_NOW) : Date.now() / 1000;
  let seen = 0n, refunds = 0n, unverified = false;
  if (!target) {
    // Only the watch loop owns a retained cursor. A one-shot cursor would
    // repeatedly visit the same prefix and starve later cleanup candidates.
    const batch = ctx.gcBatch ?? emptyGcBatch();
    // Recovery before the reap and before the hasPayloads early return (tap-c9vlf):
    // a licensed stranded entry reparks here and is a same-pass delivery candidate.
    // It lists spool/ itself rather than taking the cursor batch (tap-kip6q).
    bestEffort("spool-repark", "recover", () => recoverStrandedReparks(ctx.spoolDir, ctx.payloadsDir, env));
    bestEffort("spool-sidecar", "reap", () => reapStaleSidecars(ctx.spoolDir, ctx.payloadsDir, env, batch.sidecars));
    bestEffort("digest-index", "-", () => reapSettledDigests(join(ctx.home, "spool/digests"), ctx.receiptsDir, env, undefined, batch.digests));
    await effects.repairOrphans(batch.paneEffects);
  }
  if (!hasPayloads(ctx.spoolDir)) return 0;

  // Expired/settled custody never reaches readiness or a pane entrance, even
  // when cleanup is held by a lock or evidence conflict. Scoped waiters keep
  // their recipient scope; background maintenance covers incomplete rows.
  const retired = new Set<string>();
  const noticeBudget = { remaining: MAX_PARK_NOTICES_PER_PASS };
  const cleanupIds = target ? listEntries(ctx.spoolDir, target, registry).map(row => basename(row.path, ".md")) : parkedIds(ctx.spoolDir);
  for (const id of cleanupIds) {
    ctx.signal?.throwIfAborted();
    if (!parkCleanupDue(ctx, id)) continue;
    retired.add(id);
    cleanupPark(ctx, id, noticeBudget);
  }
  if (ctx.actingRegistry) {
    let ids: string[];
    try { ids = retirementCandidates(ctx.home, ctx.actingRegistry, target, registry); }
    catch (failure) { error("spool-retired", "", failure); return 1; }
    for (const id of ids) {
      ctx.signal?.throwIfAborted();
      if (!validId(id)) { error("spool-retired", "", "invalid candidate id"); return 1; }
      retired.add(id);
      try {
        if (await withdrawRetiredEntry(ctx, id, ctx.actingRegistry) === 0) continue;
      } catch (failure) { ctx.signal?.throwIfAborted(); error("spool-retired", id, failure); }
      event(ctx, "spool_retirement_incomplete", id, "", "custody retained");
    }
  }

  const list = (): SpoolRow[] => bestEffort("spool-state", "list", () => effects.entries
    ? effects.entries(target, registry) : listEntries(ctx.spoolDir, target, registry)) ?? [];
  // tap-03rfq: a park whose seat restarted onto a new pane is re-bound or
  // terminalized before Phase A plans digests by the parked pane.
  await bestEffortAsync(ctx, "spool-rebind", "-", () => rebindRestartedSeats(ctx, list(), retired));
  const eligible: string[] = [];
  const snapshot = list();
  // tap-bprtg: the stall alarm considers only each target's oldest observed payload, once per pass.
  const stallKey = (r: { targetRegistry: string; target: string }) => `${r.targetRegistry}\x1f${r.target}`;
  const heldPerTarget = new Map<string, number>();
  for (const listed of snapshot) {
    const r = deadlineRow(listed);
    heldPerTarget.set(stallKey(r), (heldPerTarget.get(stallKey(r)) ?? 0) + 1);
  }
  const stallSeen = new Set<string>();
  // Phase A visits the full arrival-ordered snapshot, before Phase B's cap.
  for (const listed of snapshot) {
    ctx.signal?.throwIfAborted();
    if (fenced()) return unverified ? 5 : 0;
    if (listed.incomplete) continue;
    const row = deadlineRow(listed), id = row.id;
    if (!id || retired.has(id) || !files(ctx, id) || row.reason === "legacy_meta_no_binding" || row.escalatedAt) continue;
    if (graceAttempted(ctx, id) || !row.targetRegistry || !row.paneId || !row.pane) continue;
    // tap-9lqa7: a staged-idle hold is Enter-only by construction — it never
    // joins a digest (new bytes); Phase B's solo path owns it exclusively.
    if (row.reason === "staged-idle") continue;
    // A same-id retry row rings only through the solo path, which carries its own
    // license, retry wire and observation recheck; a digest would bypass all three.
    if (rowRetry(ctx.spoolDir, id)) continue;
    if (!registryMatchesTeam(row.targetRegistry, row.toTeam) || isDone(ctx, id)) continue;
    if (row.policy === "urgent" && !pyTruthy(listed.held_drain_visits)) continue;
    const ready = await effects.readiness(row);
    if (!stallSeen.has(stallKey(row)) && !isCourierNotice(ctx, id)) {
      stallSeen.add(stallKey(row));
      bestEffort("stuck-readiness", id, () => observeSeatStall(ctx, row, ready, heldPerTarget.get(stallKey(row)) ?? 1));
    }
    if (ready === "busy:shell-mode" || ready === "busy:feedback-draft") { const held = ready.slice(5) as "shell-mode" | "feedback-draft"; bestEffort(`${held}-notice`, id, () => notifyHeld(ctx, row, held)); continue; }
    if (ready === "ready") bestEffort("spool-state", id, () => updateHeldVisits(ctx.spoolDir, id, "clear", env));
    if (row.policy === "urgent") continue;
    const sharedDeadline = protectedMessageDeadline(ctx.home, id, row.paneId, env);
    if (sharedDeadline === undefined) continue;
    if (!phaseADue(row, now) && !(sharedDeadline !== null && ctx.now >= sharedDeadline)) continue;
    eligible.push([row.targetRegistry, row.toTeam, row.target, row.pane, row.paneId, row.firstEpoch || "0", id,
      row.policy === "autosettle" ? "auto-due" : "plain", ready].join("\x1f"));
  }
  let plan = "";
  if (eligible.length) {
    try { plan = digestDraftPlan(eligible.join("\n") + "\n", ctx.spoolDir, ctx.now,
      Number(env.TAP_DIGEST_MAX_ITEMS || 32), injectionBehavior(env), env); }
    catch (failure) { error("injection-behavior", "plan", failure); return 1; }
  }
  const groups = plan.trimEnd().split("\n").filter(Boolean).map(line => {
    const [targetRegistry = "", toTeam = "", target = "", pane = "", paneId = "", ids = ""] = line.split("\x1f");
    return { binding: { targetRegistry, toTeam, target, pane, paneId }, ids: ids.split(/\s+/).filter(Boolean) };
  });
  const members = new Set(groups.flatMap(group => group.ids));

  // Phase B takes a new snapshot after Phase A's fairness updates.
  const ordered = orderedPerId(list());
  // The watcher's own queued probe id (tap-oir29), when the tick named one.
  const probeId = ctx.alert.mode === "tick" && ctx.alert.queuedProbeId !== "" ? ctx.alert.queuedProbeId : null;
  // Keep the capped walk open past an exhausted budget only while the probe may
  // still appear later in this snapshot; once it is past (or absent) break as before.
  let probeAwaited = probeId !== null && ordered.some((listed) => !listed.incomplete && deadlineRow(listed).id === probeId);
  // Latched when the budget is first spent with the probe still ahead: later
  // non-probe entries end this pass before any disposition, as the old break did.
  let capSpent = false;
  for (const listed of ordered) {
    ctx.signal?.throwIfAborted();
    if (fenced()) return unverified ? 5 : 0;
    if (listed.incomplete) continue;
    const row = deadlineRow(listed), id = row.id;
    if (!id || retired.has(id) || members.has(id)) continue;
    // The watcher's own queued probe (tap-oir29): a bounded alert obligation, exempt
    // from the per-pass cap so a backlog of held entries cannot starve its deadline
    // alert — for any readiness: a due plain-busy probe may run its attempt outside
    // the budget, while in the four holds it only takes the deadline disposition.
    const ownedProbe = probeId !== null && id === probeId;
    if (ownedProbe) probeAwaited = false;
    if (capSpent && !ownedProbe) continue;
    if ((row.escalatedAt || row.reason === "legacy_meta_no_binding") && isDone(ctx, id)) {
      await bestEffortAsync(ctx, "spool-deadline", id, () => reconcileSettled(ctx, row)); continue;
    }
    if (row.escalatedAt && await bestEffortAsync(ctx, "spool-deadline", id, () => disposeSenderGone(ctx, row))) continue;
    const grace = bestEffort("spool-deadline", id, () => disposeGraceDue(ctx, row));
    if (grace !== "not-grace") continue;
    if (row.escalatedAt || !files(ctx, id)) continue;
    if (await bestEffortAsync(ctx, "spool-deadline", id, () => disposeUnrouted(ctx, row)) !== "routable") continue;
    if (isDone(ctx, id)) continue;
    let sharedState = protectedMessageState(ctx.home, id, row.paneId, env);
    let sharedDeadline = sharedState === undefined ? undefined
      : sharedState === null ? null : protectionUntil(sharedState) / 1000;
    if (sharedDeadline === undefined) continue;
    let effectiveDeadline = sharedDeadline === null ? row.deadlineEpoch : String(Math.floor(sharedDeadline));
    let deadlinePassed = !!effectiveDeadline && atLeast(now, effectiveDeadline);
    if (row.policy === "autosettle" && !deadlinePassed && sharedDeadline === null) continue;
    if (inWindow(row, now) && !deadlinePassed && sharedDeadline === null) continue;
    const heldSlot = row.deadlineSource === "readiness-gate" && deadlinePassed;
    if (cap === null || (seen >= cap && !ownedProbe)) {
      // An unparseable cap stays fail-closed (Phase B ends before any entry, probe
      // included); a spent budget holds open only for the awaited probe.
      if (cap !== null && probeAwaited) { capSpent = true; continue; }
      break;
    }
    if (!ownedProbe) seen++;
    let ready = await effects.readiness(row);
    // Readiness can observe STOP or START. Use that updated deadline in this
    // same pass, rather than disposing against the stale pre-observation clock.
    sharedState = protectedMessageState(ctx.home, id, row.paneId, env);
    if (sharedState === undefined) continue;
    sharedDeadline = sharedState ? protectionUntil(sharedState) / 1000 : null;
    effectiveDeadline = sharedDeadline === null ? row.deadlineEpoch : String(Math.floor(sharedDeadline));
    deadlinePassed = !!sharedState?.stopUntil && protectionUntil(sharedState) <= Date.now()
      || !!effectiveDeadline && atLeast(now, effectiveDeadline);
    if (sharedState?.stopUntil && effects.flashCue) await effects.flashCue(row, id);
    // An operator STOP outranks even a watcher's bounded probe deadline.
    if ((sharedState?.stopUntil ?? 0) > Date.now()) continue;
    const dispositionRow = afterOperatorStop(row, sharedState?.stopUntil);
    await drainTestBarrier(env, id, ready);
    if (ready === "busy:shell-mode" || ready === "busy:feedback-draft") { const held = ready.slice(5) as "shell-mode" | "feedback-draft"; bestEffort(`${held}-notice`, id, () => notifyHeld(ctx, row, held)); continue; }
    let reprobe = ready === "busy:pending" && pendingReprobe(ctx.home, id);
    // tap-9lqa7: a staged-idle hold gets its solo attempt every pass — the
    // idleStaged authority refuses without keys whenever the pane is not
    // positively idle with one clean staged wire, so an early tick costs a
    // frame read, never a keystroke.
    let idleStaged = row.reason === "staged-idle" && stagedIdleSubmitEligible(ctx.home, id, ctx.env);
    if (ready === "busy:pending" || ready === "busy:operator-wait") {
      const snoozeAt = sharedState?.snoozeUntil ?? 0;
      const su = snoozeAt > 0 ? String(Math.floor(snoozeAt / 1000)) : "";
      const snoozed = su !== "" && before(now, su);
      if (snoozed && effects.flashCue && sharedState) {
        // The pane-shared record claims each milestone once per snooze; the pure
        // schedule (blue at the latch, green −30s, red −10s) replaces per-id
        // flashes, which would repeat on every pass and mask the milestones.
        if (dueWaitCue(sharedState, Number(now) * 1000)) await effects.flashCue(row, id);
      } else {
        let cue: Record<string, unknown>;
        try { cue = JSON.parse(readFileSync(metaPath(ctx.spoolDir, id), "utf8")); }
        catch (failure) { error("injection-behavior", id, failure); continue; }
        const red = String(cue.cue_red_at ?? ""), draft = sharedDeadline === null
          ? String(cue.draft_deadline_epoch ?? cue.deadline_epoch ?? "") : String(Math.floor(sharedDeadline));
        if (/^\d+$/.test(red) && integer(draft) !== null
          && atLeast(now, String(integer(draft)! - BigInt(red))) && before(now, draft)) await effects.flash(row, id);
      }
    }
    if (["busy:queued", "busy:decision-unavailable", "busy:recovery", "busy:operator-wait"].includes(ready)) {
      // Held mail stays parked for redelivery; the owned probe alone takes the
      // existing deadline disposition (one sticky human alert, then escalated_at).
      if (!ownedProbe) continue;
      await bestEffortAsync(ctx, "spool-deadline", id, () => disposeAtDeadline(ctx, dispositionRow, ready));
      continue;
    }
    let force = false, due = false;
    if (ready !== "busy:clearing" && (ready === "busy" || ready.startsWith("busy:"))) {
      bestEffort("spool-state", id, () => noteBusyProbe(ctx.spoolDir, id, ready, helperNow()));
      if (deadlinePassed && harnessFamily(await effects.harness(row.pane), DEFAULT_AGENT_FAMILIES) !== "hermes") {
        // Hermes bare input interrupts its turn; its queue uses a /queue prefix.
        // A busy look there must never accumulate force authority.
        bestEffort("spool-state", id, () => noteLiveProbe(ctx.spoolDir, id, ready, env.TAP_SPOOL_PROBE_LOCK_TIMEOUT || "0.5", helperNow(), env));
        force = atLeast(liveProbes(ctx.spoolDir, id), env.TAP_SPOOL_FORCE_PROBES || "3");
      }
      due = deadlinePassed && row.reasonClass === "busy";
    }
    let delivered = false, rc = 0;
    if (row.policy !== "autosettle" && (ready === "ready" || ready === "recover:codex-update" || ready === "recover:feedback-card" || due || force || reprobe || idleStaged)) {
      const lock = acquireObligationLock(id, 0, env);
      if (!lock) continue;
      let claimToken: ClaimToken | null = null;
      try {
        const claim = claimAcquire(ctx.spoolDir, id, false, env);
        if (claim.status !== "acquired") continue;
        claimToken = claim.token;
        if (graceAttempted(ctx, id) && !pendingReprobe(ctx.home, id)) continue;
        ready = await effects.readiness(row);
        if (ready === "busy:shell-mode" || ready === "busy:feedback-draft") continue; // next probe publishes the notice outside this held obligation
        reprobe = ready === "busy:pending" && pendingReprobe(ctx.home, id);
        idleStaged = row.reason === "staged-idle" && stagedIdleSubmitEligible(ctx.home, id, ctx.env);
        if (["busy:queued", "busy:decision-unavailable", "busy:recovery", "busy:operator-wait"].includes(ready)) continue;
        due = ready !== "busy:clearing" && (ready === "busy" || ready.startsWith("busy:")) && deadlinePassed && row.reasonClass === "busy";
        if (["busy:modal", "busy:clearing", "gone", "unsafe"].includes(ready)) force = false;
        if (ready === "ready" || ready === "recover:codex-update" || ready === "recover:feedback-card" || due || force || reprobe || idleStaged) {
          bestEffort("spool-sidecar", id, () => bumpAttempts(ctx.spoolDir, id));
          rc = await effects.redeliverLocked(id, row, force);
          delivered = rc === 0;
          // Preserve the incumbent's per-id 124 asymmetry; Phase C handles both.
          if (rc === 5) unverified = true;
        } else bestEffort("spool-state", id, () => noteBusyProbe(ctx.spoolDir, id, ready, helperNow()));
      } finally {
        if (claimToken !== null) claimRelease(ctx.spoolDir, id, claimToken);
        lock.release();
      }
    }
    if (heldSlot && !delivered && rc !== 5 && files(ctx, id) && recipientIsPresent(ready)) {
      bestEffort("spool-state", id, () => updateHeldVisits(ctx.spoolDir, id, "increment", env));
      if (refunds < cap) { seen--; refunds++; }
    }
    if (delivered) continue;
    // The redelivery itself published the deterministic notice and receipt (tap-67y3s).
    if (rc === 5) continue;
    await bestEffortAsync(ctx, "spool-deadline", id, () => disposeAtDeadline(ctx, dispositionRow, ready));
  }
  // Phase C stays after every solo urgent/lone attempt; no same-pass solo retry.
  for (const group of groups) {
    ctx.signal?.throwIfAborted();
    if (fenced()) return unverified ? 5 : 0;
    const rc = await effects.digest(group.binding, group.ids);
    if (rc === 5 || rc === 124) unverified = true;
  }
  return unverified ? 5 : 0;
}
