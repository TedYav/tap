import { activeInputForPane } from "./input-protection";
// Native delivery owns submit and immediate custody together for singles and digests.
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { authorizedHome, isFile, type DrainContext, type DrainEffects, type SpoolBinding } from "./spool-drain";
import { deliveryClockStamp } from "./delivery-clock";
import { appendRegistryEvent, appendRegistryEventOrWarn } from "./events";
import { digestNoticeGroups } from "./notice";
import { acquireObligationLock, acquirePaneLock, paneLockPath, type PaneLock } from "./panelock";
import { recoveryHold } from "./recovery/state";
import { digestOutcome } from "./slices/digest-outcome";
import { redeliveryEligibility } from "./slices/redelivery-eligibility";
import { notifySenderOnEscalate, publishUnconfirmed, registryMatchesTeam } from "./spool-deadline";
import { digestInjectStep, initialState, releaseAll, type InjectAnswer, type InjectState, type SubmitRequest } from "./spool-digest-inject";
import { claimAcquire, claimRelease, metaPath, payloadPath, removeEntry } from "./spool-sidecar";
import { markLegacyNoBinding } from "./spool-state";
import { paneHarnessAt, readPaneReady, type Readiness } from "./spool-readiness";
import { markOverprintAlarmed, overprintRetryDue, retireOverprintRecord, OVERPRINT_RETRY_MAX,
  type OverprintCause } from "./overprint-marker";
import { boundPaneIdentityState } from "./observe-gather";
import { authorizePaneEffect, inspectClearFence, submitVerifyLocked, type BoundRecipient,
  type SubmitAuthority, type SubmitResult } from "./courier";
import { clobberBand, DARK_EFFECTS, type PaneEffects } from "./deliver";
import { captureCourierFailure } from "./debug-capture";
import { beginDeliveryAttempt } from "./delivery-attempt";
import { recordedPermissions } from "./delivery-permissions";
import { envelopeField } from "./envelope";
import { atomicWrite, receiptBytes } from "./fsatomic";
import { reparkLicensed } from "./delivery-custody";
import { recordHarnessQueued } from "./harness-queue";
import { recordLockPark } from "./lock-attribution";
import { DEFAULT_AGENT_FAMILIES } from "./observe";
import { loadRegistry, seatMap } from "./registry";
import { RESET_HELD_LOCK_WAIT_MS, withResetCustody } from "./reset";
import { renderSentinel } from "./sentinel";
import { senderIndexEvidence, spoolRecipientBusHome } from "./remote-target";
import { reownAfterRepark } from "./spool-reown";
import { clearReparkPending, markReparkPendingOutcome, stagedIdleHoldOutcome } from "./spool-repark";
import { pendingReprobe, stagedIdleEvidence } from "./submit-phase";
import { stagedIdleWindowSeconds } from "./spool-publication";
import { cancelCopyMode } from "./tmux";
import { endPaneCueAfter, flashPane, paneEffectClearVerified, serverEpochNow, spawnDeliverer } from "./spool-park-report";
import { emitWaitCue } from "./wait-cues";

/** A rate refusal without attempt evidence is retryable, for singles and digests. */
function spoolSubmitCode(result: SubmitResult, receiptsDir: string, ids: readonly string[]): number {
  if (result.status === "injected") return 0;
  if (result.status === "harness_queued") return 7;
  if (result.status === "unverified") return 5;
  if (result.status !== "rate_limited") return 1;
  if (!ids.length) return 124;
  for (const id of ids) {
    try { lstatSync(join(receiptsDir, `${id}.attempted`)); return 124; }
    catch (error) {
      // Dangling markers and unreadable evidence remain possible-effect custody.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return 124;
    }
  }
  return 1;
}

// --- tap-cl1es: bounded automatic healing ------------------------------------------------
//
// The drain's readiness step is the ONE owner of the stuck-paint retry: the
// spool waiter's existing cadence is the retry clock, so no second poller
// exists. This layer is state-only (review B): it reads and writes the pane's
// stuck-paint record and maps a DUE episode to `ready` — attemptable — so the
// attempt reaches the courier's band gate, where the one repaint actually
// happens. An exhausted episode fires the leader alarm exactly once per
// record: a registry event plus the roster's exhausted suffix (the alarm, per
// tap-bprtg's report-only shape). A ready read retires the record.

export interface OverprintRetryIo {
  due(paneId: string, cause: OverprintCause, now: number): "repaint" | "hold" | "exhausted";
  markAlarmed(paneId: string, now: number): boolean;
  retire(paneId: string): void;
}

export const REAL_OVERPRINT_RETRY_IO: OverprintRetryIo = {
  due: (paneId, cause, now) => overprintRetryDue(paneId, cause, now),
  markAlarmed: (paneId, now) => markOverprintAlarmed(paneId, now),
  retire: paneId => retireOverprintRecord(paneId),
};

export function withOverprintRetry(verdict: Readiness, paneId: string, io: OverprintRetryIo, now: number,
  onAlarmFirst?: (info: { paneId: string; cause: OverprintCause }) => void): Readiness {
  if (verdict === "busy:overprint" || verdict === "busy:booting") {
    const cause: OverprintCause = verdict === "busy:overprint" ? "overprint" : "booting";
    const decision = io.due(paneId, cause, now);
    if (decision === "repaint") return "ready";
    // The exhausted episode alarms once; a held episode is just early.
    if (decision === "exhausted" && io.markAlarmed(paneId, now) && onAlarmFirst) onAlarmFirst({ paneId, cause });
    return verdict;
  }
  if (verdict === "ready") io.retire(paneId);
  return verdict;
}

const readiness = (ctx: DrainContext, b: SpoolBinding) => withOverprintRetry(
  readPaneReady({ pane: b.pane, paneId: b.paneId,
    handle: b.target, toTeam: b.toTeam, targetRegistry: b.targetRegistry, policy: b.policy || "" }, ctx.home, ctx.env),
  b.paneId, REAL_OVERPRINT_RETRY_IO, Math.floor(Date.now() / 1000),
  ({ paneId, cause }) => appendRegistryEventOrWarn(ctx.verbLabel,
    { log: ctx.eventLog, actor: "courier", action: "overprint_heal_exhausted",
      handle: b.target, pane: b.pane, team: ctx.team, env: ctx.env,
      detail: `pane_id=${paneId} cause=${cause} repaints=${OVERPRINT_RETRY_MAX} exhausted; manual cure: tap nudge ${b.target}` }));

export function realDrainEffects(ctx: DrainContext): DrainEffects {
  return {
    readiness: async b => readiness(ctx, b),
    harness: async pane => paneHarnessAt(pane, ctx.env),
    flash: async (b, id) => {
      ctx.signal?.throwIfAborted();
      // The -10 s cue: tinted under the pane lock, cleared after the dwell with the lock released.
      try { endPaneCueAfter(flashPane({ home: ctx.home, pane: b.pane, paneId: b.paneId, ownerId: id, env: ctx.env }, { detached: true })); }
      catch { /* Cosmetic failure must not stop delivery. */ }
    },
    flashCue: async (b, id) => {
      ctx.signal?.throwIfAborted();
      // Cosmetic: never contend for the pane lock; a busy pane keeps its milestone unclaimed.
      const lock = acquirePaneLock(b.paneId, 0, ctx.env);
      if (!lock) return;
      try { emitWaitCue(b.paneId, { pane: b.pane, home: ctx.home, ownerId: id, env: ctx.env, now: Number(ctx.now) * 1000 }); }
      finally { lock.release(); }
    },
    repairOrphans: names => repairOrphans(ctx, names),
    redeliverLocked: (id, b, force) => redeliver(ctx, id, b, { locked: true, force }),
    digest: (b, ids) => injectDigest(ctx, b, ids),
  };
}

export async function redeliver(ctx: DrainContext, id: string, b: SpoolBinding,
  options: { locked?: boolean; force?: boolean } = {}, fx: PaneEffects = DARK_EFFECTS): Promise<number> {
  const lock = options.locked ? undefined : acquireObligationLock(id, 0, ctx.env);
  if (!options.locked && !lock) return 1;
  try {
    const eligibility = redeliveryEligibility(ctx.home, id);
    if (eligibility !== "eligible") {
      appendRegistryEventOrWarn(ctx.verbLabel, { log: ctx.eventLog, actor: "courier", action: "redelivery_skipped",
        handle: b.target, pane: b.pane, team: ctx.team, detail: `id=${id} reason=${eligibility} effect=none`, env: ctx.env });
      return 0;
    }
    if (!isFile(payloadPath(ctx.spoolDir, id)) || !b.pane || !b.paneId || !b.targetRegistry) return 1;
    if (!authorizedHome(ctx, "tap_spool_redeliver")) return 1;
    if (!registryMatchesTeam(b.targetRegistry, b.toTeam)) {
      markLegacyNoBinding(ctx.spoolDir, id, ctx.eventLog, ctx.team, ctx.verbLabel, undefined, ctx.env); return 1;
    }
    if (boundPaneIdentityState(b.targetRegistry, b.target, b.pane, b.paneId, ctx.env) !== "match") return 1;
    const recipientBus = spoolRecipientBusHome(ctx.home, b.targetRegistry, b.toTeam, ctx.env?.TAP_INDEX_HOME);
    if (!recipientBus || inspectClearFence(recipientBus, b.target) === "live") return 1;
    return singleEffectCustody(ctx, id, b, options.force === true, fx);
  } finally { lock?.release(); }
}

/** The existing submit owner and its immediate custody disposition run in one process. */
function singleEffectCustody(ctx: DrainContext, id: string, b: SpoolBinding, force: boolean, fx: PaneEffects): number {
  const recipientBus = spoolRecipientBusHome(ctx.home, b.targetRegistry, b.toTeam, ctx.env?.TAP_INDEX_HOME);
  if (!recipientBus) return 1;
  const spoolPayload = payloadPath(ctx.spoolDir, id), canon = join(ctx.payloadsDir, `${id}.md`);
  const event = (action: string, detail: string) => appendRegistryEventOrWarn(ctx.verbLabel,
    { log: ctx.eventLog, actor: "courier", action, handle: b.target, pane: b.pane, team: ctx.team, detail, env: ctx.env,
      lockTimeoutMs: RESET_HELD_LOCK_WAIT_MS });
  const custody = (stage: string, body: () => void, wait = 10_000): boolean => {
    const held = withResetCustody(ctx.home, `courier ${stage}`, body, wait);
    if (held.ok) return true;
    const why = held.refusal === "team_reset_fenced" ? "fenced" : "busy";
    event("spool_effect_fenced", `id=${id} stage=${stage} reason=${why}`);
    process.stderr.write(`tap: spool effect for '${id}' left in place at ${stage} — reset custody ${why}\n`);
    return false;
  };
  const repark = (legacy = false) => {
    // The write-ahead mark from the pre-submit move already marks this entry, so a
    // busy or fenced refusal leaves the licensed state for the waiter or the watch
    // drain's recoverStrandedReparks; a fence leaves it to reset (tap-c9vlf).
    if (!custody("repark", () => {
      try { renameSync(canon, spoolPayload); clearReparkPending(ctx.spoolDir, id, ctx.env, RESET_HELD_LOCK_WAIT_MS); }
      catch { /* An absent or unmoved body is not a replay license. */ }
      if (legacy) markLegacyNoBinding(ctx.spoolDir, id, ctx.eventLog, ctx.team, ctx.verbLabel, undefined, ctx.env, RESET_HELD_LOCK_WAIT_MS);
    })) return;
    const token = reownAfterRepark(ctx.spoolDir, id, ctx.env?.TAP_SPOOL_REOWN_LEASE_SECONDS || "20", Date.now() / 1000, ctx.env);
    if (token) spawnDeliverer({ scriptsDir: ctx.scriptsDir, home: ctx.home, spoolDir: ctx.spoolDir, id, reownToken: token, env: ctx.env });
  };
  let row;
  try { row = seatMap(loadRegistry(b.targetRegistry))[b.target]; } catch { return 1; }
  if (!row) return 1;
  const bound: BoundRecipient = { paneId: b.paneId, handle: b.target, instance: String(row.instance ?? ""),
    serverEpoch: String(row.server_epoch ?? ""), bootId: String(row.boot_id ?? ""), harness: String(row.harness ?? "") };
  // A staged-idle row is Enter-only BY CONSTRUCTION on every drain entry:
  // the authority keys on the row's reason, not the momentary eligibility —
  // an ineligible row (spent license, elapsed window, ended evidence) still
  // takes the idleStaged arm, which refuses without keys, so the rc-5 hold
  // disposition (stagedIdleHoldOutcome) retires or re-holds it. Routing such
  // a row down the normal path would only re-refuse on .attempted and could
  // never type bytes anyway.
  let idleStagedReason = false;
  try {
    const meta = JSON.parse(readFileSync(join(ctx.spoolDir, `${id}.meta.json`), "utf8")) as { reason?: unknown };
    idleStagedReason = meta?.reason === "staged-idle";
  } catch { /* unreadable metadata: the ordinary authority refuses safely */ }
  const authority: SubmitAuthority = { scriptsDir: ctx.scriptsDir, agentFamilies: new Set(DEFAULT_AGENT_FAMILIES),
    busHome: ctx.home, recipientBusHome: recipientBus, recipient: b.target, registryPath: b.targetRegistry,
    attemptIds: [id], preserveDraft: false, draftGraceSatisfied: true, forceNoPrompt: force, reprobeOnly: pendingReprobe(ctx.home, id),
    env: ctx.env,
    ...(idleStagedReason ? { idleStaged: true, singleEnter: true } : {}),
    eventContext: { actor: "courier", log: ctx.eventLog, team: ctx.team, verb: ctx.verbLabel } };
  let lockBusy = false;
  let terminal: { rc: 5 | 124; detail: string; disposed: boolean } | undefined;
  const diagnostic = { id, pane: b.pane, sentinel: "", harness: bound.harness,
    busHome: ctx.home, scriptsDir: ctx.scriptsDir };
  const result = captureCourierFailure(diagnostic, () => {
    const refused = { rc: 1, status: "band_busy" };
    ctx.signal?.throwIfAborted();
    if (existsSync(join(ctx.home, "reset.fence.json"))) { custody("pre-submit", () => {}, 1000); return refused; }
    const mode = fx.copyMode?.(b.paneId);
    if (mode?.status !== "normal") {
      if (mode?.status !== "copy-mode" || authority.reprobeOnly || recordedPermissions(b.targetRegistry, b.target) !== "bypass") return refused;
      const paneLock = acquirePaneLock(b.paneId, Number(ctx.env?.TAP_PANE_SUBMIT_LOCK_TIMEOUT ?? 5) * 1000, ctx.env);
      if (!paneLock) return refused;
      try {
        if (activeInputForPane(b.paneId, ctx.env) || recoveryHold(b.paneId, ctx.env) || authorizePaneEffect(b.pane, bound, fx, authority).status !== "ok") return refused;
        if (beginDeliveryAttempt(ctx.home, id) !== "created") return refused;
        authority.attemptAdmitted = true;
        if (cancelCopyMode(b.paneId, ctx.env) !== "ok") return refused;
        fx.settle(0.05);
        if (fx.copyMode?.(b.paneId).status !== "normal") return refused;
      } finally { paneLock.release(); }
    }
    let moved = false;
    // Write-ahead (tap-c9vlf): a kill after the move must strand a licensed entry,
    // never an unmarked one the orphan sweep would retire as unconfirmed. A busy mark
    // refuses the move (parked; the next drain retries). Unparseable metadata is left
    // untouched and the body delivers unmarked: a permanent refusal would strand it.
    if (!custody("pre-submit", () => {
      const mark = markReparkPendingOutcome(ctx.spoolDir, id, ctx.env, RESET_HELD_LOCK_WAIT_MS);
      if (mark === "busy") {
        event("spool_repark_unmarked", `id=${id} reason=busy`);
        process.stderr.write(`tap: spool repark for '${id}' could not be marked; body stays in spool/\n`);
        return;
      }
      if (mark === "unparseable") event("spool_repark_unmarked", `id=${id} reason=unparseable`);
      try { renameSync(spoolPayload, canon); moved = true; } catch { /* Retain in spool. */ }
    }, 1000) || !moved) return refused;
    fx.crashAfterMove?.(id);
    let wire = "";
    try {
      const raw = readFileSync(canon, "utf8"), field = (name: string) => envelopeField(raw, name) ?? "";
      if (field("id") !== id || !field("from") || !field("to") || !field("kind")) throw new Error("missing canonical routing fields");
      const from = field("from_team") ? `${field("from_team")}/${field("from")}` : field("from");
      const to = field("to_team") ? `${field("to_team")}/${field("to")}` : field("to");
      const fromTeam = from.includes("/") ? from.split("/", 1)[0]! : "";
      const toTeam = to.includes("/") ? to.split("/", 1)[0]! : "";
      authority.sender = from;
      authority.deliveryFacts = { urgent: field("urgency") === "urgent", noSpool: false, recipientBound: true, harness: bound.harness };
      wire = renderSentinel({ id, from, to, kind: field("kind"),
        senderIndex: fromTeam && toTeam && fromTeam !== toTeam ? senderIndexEvidence(fromTeam, ctx.env?.TAP_INDEX_HOME) : undefined,
        reply: field("reply") || "expected", urgency: field("urgency"), path: canon });
    } catch { repark(); return refused; }
    if (!registryMatchesTeam(b.targetRegistry, b.toTeam)) { repark(true); return refused; }
    if (boundPaneIdentityState(b.targetRegistry, b.target, b.pane, b.paneId, ctx.env) !== "match") { repark(); return refused; }
    const harness = paneHarnessAt(b.pane, ctx.env);
    if (harness.startsWith("hermes")) { wire = "/queue " + wire; authority.noPromptOk = true; }
    diagnostic.sentinel = wire;
    diagnostic.harness = harness;
    let submitted: SubmitResult;
    const paneLock = acquirePaneLock(b.paneId, Number(ctx.env?.TAP_PANE_SUBMIT_LOCK_TIMEOUT ?? 5) * 1000, ctx.env);
    if (!paneLock) submitted = { status: "lock_busy", detail: "pane submit lock busy" };
    else try {
      if (activeInputForPane(b.paneId, ctx.env) || recoveryHold(b.paneId, ctx.env)) submitted = { status: "recovery_held", detail: "recovery owns pane" };
      else submitted = submitVerifyLocked(b.pane, id, wire, bound, draftEffects(fx), authority);
    } finally { paneLock.release(); }
    const rc = spoolSubmitCode(submitted, ctx.receiptsDir, [id]);
    // tap-9lqa7: an unverified submit with the pane alive and the wire
    // possibly still staged holds as staged-idle for one bounded idle window
    // instead of dropping custody — the next drain's idleStaged authority may
    // press Enter once. Never for rc 124 (a kill mid-attempt), an urgent
    // original, a dead pane, or a composer the submit could not see a staged
    // wire in (staged_absent: a human submitted or cleared it; dispose
    // quietly, the manual path owns any follow-up).
    const unverifiedCause = "cause" in submitted ? submitted.cause : undefined;
    const stagedIdle = rc === 5 && !authority.deliveryFacts?.urgent
      && unverifiedCause !== "pane_dead" && unverifiedCause !== "staged_absent"
      && stagedIdleEvidence(ctx.home, id);
    const stagedIdleOutcome = { value: "expired" as "held" | "expired" | "busy" };
    // A staged-idle hold that is held, busy, or never decided (refused custody) is
    // licensed custody recovery may still re-adopt: not terminal. A retained entry
    // (removal refused) is terminal only when the same repark license recovery and
    // the orphan sweep read refuses it — mark plus .attempted. Without attempt
    // evidence (a pre-effect rc 5, e.g. a failed draft backup) recovery re-parks it.
    // `disposed` records whether the spool entry is gone.
    let disposed = false, custodyRan = false;
    if (rc === 0 || rc === 7 || rc === 5 || rc === 124) {
      // A kill mid-attempt (124) is a real unverified outcome — log it before
      // custody so a kill during the disposition cannot lose the event. An
      // rc-5 pass is logged after custody instead: a staged-idle hold is a
      // scheduled follow-up, not an unverified outcome, and logging it every
      // drain tick for the whole window would bury the log (gate review nit).
      if (rc === 124) event("redelivery_submit_unverified", `id=${id}`);
      custody("post-submit", () => {
        custodyRan = true;
        if (rc === 0) {
          let raw = "";
          try { raw = readFileSync(canon, "utf8"); } catch { /* Receipt fields were historically best-effort. */ }
          try { atomicWrite(join(ctx.receiptsDir, `${id}.sent`), receiptBytes({ id, from: envelopeField(raw, "from") || "unknown",
            to: b.target, pane: b.pane, kind: envelopeField(raw, "kind") || "unknown", turn: "unconfirmed", delivery: "pane" })); }
          catch { process.stderr.write(`tap: WARNING — redelivery of ${id} verified but its .sent receipt could not be written\n`); }
          deliveryClockStamp(b.targetRegistry, b.target, ctx.env?.TAP_SPOOL_NOW, RESET_HELD_LOCK_WAIT_MS);
          event("redelivery_delivered", `id=${id}`);
        } else if (rc === 7) recordHarnessQueued(ctx.home, id);
        if (stagedIdle) {
          // Decide the hold FIRST, touching only the parked metadata: an
          // expired window must leave the body canonical (the ordinary rc-5
          // semantics), never move it back only to delete it. Only a held
          // entry wants its body back in spool/, under the write-ahead
          // repark mark until the pair is complete — a kill between the
          // decision and the move leaves a marked canonical body the
          // existing stranded-repark recovery moves back and re-decides.
          stagedIdleOutcome.value = stagedIdleHoldOutcome(ctx.spoolDir, id, stagedIdleWindowSeconds(ctx.env), ctx.env, RESET_HELD_LOCK_WAIT_MS);
          if (stagedIdleOutcome.value === "held") {
            try {
              renameSync(canon, spoolPayload);
              clearReparkPending(ctx.spoolDir, id, ctx.env, RESET_HELD_LOCK_WAIT_MS);
            } catch {
              // The body never reached spool/: KEEP the write-ahead mark. The
              // mark plus the staged-idle metadata is the Enter-only
              // re-adoption license, so the stranded-repark recovery moves it
              // back for the next drain to re-decide; clearing the mark here
              // would strand the hold. A pair already moved consumes the mark.
              if (existsSync(spoolPayload)) clearReparkPending(ctx.spoolDir, id, ctx.env, RESET_HELD_LOCK_WAIT_MS);
            }
          } else if (stagedIdleOutcome.value === "expired") {
            try { removeEntry(ctx.spoolDir, id, ctx.env, RESET_HELD_LOCK_WAIT_MS); disposed = true; } catch (error) { process.stderr.write(`tap: ${error}\n`); }
          }
          // "busy": the metadata lock was unavailable; the body stays
          // canonical under the pre-submit repark mark and the existing
          // recovery re-parks it for the next drain to re-decide.
        } else {
          try { removeEntry(ctx.spoolDir, id, ctx.env, RESET_HELD_LOCK_WAIT_MS); disposed = true; } catch (error) { process.stderr.write(`tap: ${error}\n`); }
        }
      });
      if (rc === 5 && stagedIdleOutcome.value !== "held") event("redelivery_submit_unverified", `id=${id}`);
      if (rc === 5 || rc === 124) {
        if (stagedIdleOutcome.value === "held") {
          process.stderr.write(`tap: redelivery id '${id}' submit-unverified; held as staged-idle — the courier presses Enter once the pane is safely idle with the staged wire\n`);
        } else if (rc === 5 && unverifiedCause === "staged_absent") {
          process.stderr.write(`tap: redelivery id '${id}' no longer sees a staged sentinel; the manual path (tap nudge) owns any follow-up\n`);
        } else if (rc === 5 || rc === 124) {
          process.stderr.write(`tap: redelivery id '${id}' is canonical but submit-unverified; automatic retry stopped to avoid duplicate injection\n`);
        }
        const recoverableHold = stagedIdle && (!custodyRan || stagedIdleOutcome.value !== "expired");
        if (!recoverableHold && (disposed || !reparkLicensed(ctx.home, id, ctx.env))) terminal = { rc: rc as 5 | 124, detail: "detail" in submitted ? submitted.detail : "", disposed };
      }
    } else { repark(); lockBusy = submitted.status === "lock_busy"; }
    // A held staged-idle entry keeps its custody and its waiter: report the
    // pass as not-unverified (0) so the caller neither pings the sender nor
    // escalates a hold whose window is still running.
    return { ...submitted, rc: rc === 7 ? 0 : rc === 5 && stagedIdleOutcome.value === "held" ? 0 : rc };
  }, true);
  if (lockBusy) {
    let detail = "reason=lock-park; holder attribution unavailable";
    try { detail = recordLockPark(metaPath(ctx.spoolDir, id), paneLockPath(b.paneId, ctx.env)); } catch { /* Best effort after disposition. */ }
    try { notifySenderOnEscalate(ctx, { id, target: b.target, targetRegistry: b.targetRegistry, outcome: "lock-park", durableId: `${id}-lock-park`, detail }); } catch { /* Best effort. */ }
  }
  if (terminal) {
    // tap-67y3s: the terminal disposition grace already gives a possible attempt —
    // one deterministic sender notice and the .unconfirmed receipt naming it. Outside
    // reset custody (the notifier takes its own). Best effort: a failed notice never
    // re-parks or retries a possible effect. A retained sidecar gets the notice only;
    // the orphan sweep archives it and writes the receipt.
    // rc 124 is a rate refusal WITH attempt evidence: .attempted is the possible-effect
    // marker (an earlier draft clear or interrupt may precede the refused paste), and a
    // rate refusal without it already reparked as rc 1. Both terminal codes are possible.
    const rateLimited = terminal.rc === 124;
    try {
      publishUnconfirmed(ctx, { id, target: b.target, pane: b.pane, registry: b.targetRegistry,
        reason: rateLimited ? "redelivery_rate_limited" : "redelivery_submit_unverified", effect: "possible", receipt: terminal.disposed,
        detail: `${rateLimited ? "redelivery refused by the tmux client budget" : "redelivery submit unverified"}`
          + `${terminal.detail ? ` (${terminal.detail})` : ""}; automatic recipient retry stopped` });
    } catch { /* Best effort. */ }
  }
  return result.rc;
}

export async function notifyDigestSenders(ctx: DrainContext, digestId: string, b: SpoolBinding, ids: string[], acquire = claimAcquire): Promise<number> {
  let rc = 0;
  for (const group of digestNoticeGroups(ctx.payloadsDir, ctx.receiptsDir, ids)) {
    const noticeId = `${digestId}-${group.sender}-delivery-unconfirmed`;
    const claim = acquire(ctx.spoolDir, noticeId, true, ctx.env);
    if (claim.status !== "acquired") { rc = 1; continue; }
    try {
      if (!notifySenderOnEscalate(ctx, { id: group.ids[0]!, target: b.target, targetRegistry: b.targetRegistry,
        outcome: "unconfirmed", durableId: noticeId, digestMembers: group.ids.join(" "), detail: group.detail })) rc = 1;
    } catch { rc = 1; }
    finally { claimRelease(ctx.spoolDir, noticeId, claim.token); }
  }
  return rc;
}

/** Keep each real draft-clear key behind the shared submit admission guard. */
export function draftEffects(fx: PaneEffects): PaneEffects {
  return { ...fx, clobber: (target, command, binding, backup, beforeEffect) => clobberBand(target, command, binding, {
    ...DARK_EFFECTS, ...fx,
    protectInput: fx.protectInput, inputHeld: fx.inputHeld,
    clearInput: target => beforeEffect?.() === false ? false : (fx.clearInput ?? DARK_EFFECTS.clearInput)!(target),
    backspace: target => beforeEffect?.() === false ? false : (fx.backspace ?? DARK_EFFECTS.backspace)!(target),
  }, backup, "") };
}

function digestEffectCustody(ctx: DrainContext, b: SpoolBinding, state: InjectState,
  request: SubmitRequest, harness: string, fx: PaneEffects): number {
  return captureCourierFailure({ id: request.digestId, pane: b.pane, harness,
    sentinel: request.sentinel, busHome: ctx.home, scriptsDir: ctx.scriptsDir }, () => {
    ctx.signal?.throwIfAborted();
    const recipientBus = spoolRecipientBusHome(ctx.home, b.targetRegistry, b.toTeam, ctx.env?.TAP_INDEX_HOME);
    if (!recipientBus) return { status: "fence_authority_mismatch", rc: 1 };
    let row;
    try { row = seatMap(loadRegistry(b.targetRegistry))[b.target]; } catch { return { status: "identity_mismatch", rc: 1 }; }
    if (!row) return { status: "identity_mismatch", rc: 1 };
    const bound: BoundRecipient = { paneId: b.paneId, handle: b.target, instance: String(row.instance ?? ""),
      serverEpoch: String(row.server_epoch ?? ""), bootId: String(row.boot_id ?? ""), harness: String(row.harness ?? "") };
    const authority: SubmitAuthority = { scriptsDir: ctx.scriptsDir, agentFamilies: new Set(DEFAULT_AGENT_FAMILIES),
      busHome: ctx.home, recipientBusHome: recipientBus, recipient: b.target, registryPath: b.targetRegistry,
      attemptIds: request.attemptIds, preserveDraft: request.preserveDraft, noPromptOk: harness.startsWith("hermes"),
      eventContext: { actor: "courier", log: ctx.eventLog, team: ctx.team, verb: ctx.verbLabel } };
    let submitted: SubmitResult;
    const lock = acquirePaneLock(b.paneId, Number(ctx.env?.TAP_PANE_SUBMIT_LOCK_TIMEOUT ?? 5) * 1000, ctx.env);
    if (!lock) submitted = { status: "lock_busy", detail: "pane submit lock busy" };
    else try {
      if (activeInputForPane(b.paneId, ctx.env) || recoveryHold(b.paneId, ctx.env)) submitted = { status: "recovery_held", detail: "recovery owns pane" };
      else submitted = submitVerifyLocked(b.pane, request.digestId, (authority.noPromptOk ? "/queue " : "") + request.sentinel, bound, draftEffects(fx), authority);
    } finally { lock.release(); }
    const rc = spoolSubmitCode(submitted, ctx.receiptsDir, request.attemptIds);
    if (digestOutcome({ rc, members: state.survivors.length }).canonicalize) {
      const held = withResetCustody(ctx.home, "courier digest", () => {
        for (const id of state.survivors) {
          try { renameSync(payloadPath(ctx.spoolDir, id), join(ctx.payloadsDir, `${id}.md`)); } catch { /* Preserve partial-move evidence. */ }
          try { rmSync(metaPath(ctx.spoolDir, id), { force: true }); } catch { /* Attempt evidence still prohibits replay. */ }
        }
      }, 10_000);
      if (!held.ok) {
        const reason = held.refusal === "team_reset_fenced" ? "fenced" : "busy";
        appendRegistryEventOrWarn(ctx.verbLabel, { log: ctx.eventLog, actor: "courier", action: "spool_effect_fenced",
          handle: "", pane: "", detail: `id=${request.digestId} stage=digest reason=${reason}`, team: ctx.team, env: ctx.env });
        process.stderr.write(`tap: spool effect for '${request.digestId}' left in place at digest — reset custody ${reason}\n`);
      }
      // Clear the same ownership record used by postSubmit/finally. A later
      // failure must never release a successor's newly acquired claim.
      releaseAll(state);
    }
    return { ...submitted, rc, detail: `members=[${request.members}] ${"detail" in submitted ? submitted.detail : ""}` };
  }, true).rc;
}

export async function injectDigest(ctx: DrainContext, b: SpoolBinding, ids: string[], fx: PaneEffects = DARK_EFFECTS): Promise<number> {
  if (!authorizedHome(ctx, "tap_spool_digest_inject")) return 1;
  const state = initialState({ home: ctx.home, spoolDir: ctx.spoolDir, payloadsDir: ctx.payloadsDir,
    receiptsDir: ctx.receiptsDir, team: ctx.team, courierIdentity: ctx.courierIdentity,
    targetRegistry: b.targetRegistry, toTeam: b.toTeam, handle: b.target, pane: b.pane, paneId: b.paneId, ids });
  let answer: InjectAnswer = {}, harness = "";
  const memberLocks: PaneLock[] = [];
  const releaseMembers = () => { for (const lock of memberLocks.splice(0).reverse()) lock.release(); };
  try {
    // Readers of a canonical copy do not take a spool claim. Own their eligibility
    // before claiming, through the actual effect and final member bookkeeping.
    for (const id of [...new Set(ids)].sort()) {
      const lock = acquireObligationLock(id, 0, ctx.env);
      if (!lock) return 1;
      memberLocks.push(lock);
    }
    for (;;) {
      const step = digestInjectStep(state, answer);
      if (step.done) {
        for (const warning of step.warnings) process.stderr.write(`${warning}\n`);
        if (step.stampClock) { try { deliveryClockStamp(b.targetRegistry, b.target); } catch { /* incumbent best effort */ } }
        for (const event of step.events) {
          const record = { log: ctx.eventLog, actor: event.identity, action: event.event, handle: event.handle, pane: event.pane,
            detail: event.detail, team: ctx.team, env: ctx.env };
          if (event.warn) appendRegistryEventOrWarn(ctx.verbLabel, record);
          else { try { appendRegistryEvent(record); } catch { /* silent append */ } }
        }
        return step.rc;
      }
      answer = {};
      switch (step.need.kind) {
        case "readiness": {
          answer.readiness = readiness(ctx, { ...b, policy: "" }); break;
        }
        case "matches-team": answer.matchesTeam = registryMatchesTeam(b.targetRegistry, b.toTeam); break;
        case "identity": {
          answer.identity = boundPaneIdentityState(b.targetRegistry, b.target, b.pane, b.paneId, ctx.env); break;
        }
        case "harness": {
          harness = paneHarnessAt(b.pane, ctx.env); answer.harness = harness; break;
        }
        case "submit": {
          const r = step.need.submit;
          answer.submitRc = digestEffectCustody(ctx, b, state, r, harness, fx); break;
        }
        case "notify-senders":
          releaseMembers(); // Member state is final; sender pane waits need no member locks.
          try { await notifyDigestSenders(ctx, step.need.digestId, b, step.need.ids); } catch { /* old caller ignored failure */ }
          answer.notified = true; break;
      }
    }
  } finally {
    try { releaseAll(state); } finally { releaseMembers(); }
  }
}

async function repairOrphans(ctx: DrainContext, candidates?: readonly string[]): Promise<void> {
  const dir = join(ctx.home, "pane-effects");
  let names: string[];
  try { names = candidates ? [...candidates].filter(n => !n.includes("/")) : readdirSync(dir); } catch { return; }
  for (const name of names) {
    ctx.signal?.throwIfAborted();
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const path = join(dir, name);
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(readFileSync(path, "utf8"));
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    } catch { continue; }
    const paneId = String(record.pane_id ?? ""), epoch = String(record.server_epoch ?? "");
    const lock = acquirePaneLock(paneId, 0, ctx.env);
    if (!lock) continue;
    try {
      if (recoveryHold(paneId, ctx.env)) continue;
      let cleared = false;
      try { cleared = paneEffectClearVerified(paneId, epoch, ctx.env); } catch { /* Keep the token unless generation changed. */ }
      if (cleared) rmSync(path, { force: true });
      else {
        let current = "";
        try { current = serverEpochNow(ctx.env); } catch { /* Unknown generation preserves the token. */ }
        if (epoch && current && current !== epoch) rmSync(path, { force: true });
      }
    } finally { lock.release(); }
  }
}
