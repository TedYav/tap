// Digest planning and post-submit bookkeeping. The native effect owner completes
// custody before returning here; all cleanup shares the same claim record.
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { digestIndexPath, stampInjected, writeDigestIndex } from "./digest-index";
import { mintId } from "./ids";
import { recordHarnessQueued } from "./harness-queue";
import { renderSentinel } from "./sentinel";
import { digestOutcome } from "./slices/digest-outcome";
import { type ClaimToken, claimAcquire, claimRelease, metaField, metaPath, payloadPath as spoolPayloadPath } from "./spool-sidecar";
import { queuedDraftClobberDue } from "./injection-behavior";
import { graceAttempted, type DeadlineContext } from "./spool-deadline";
import { rowRetry } from "./retry";

/**
 * `$TAP_AUTOSETTLE_POLICY` — `tap_spool_entry_is_presettled`'s one comparison, and the
 * literal is `autosettle` with no separator (lib.sh:1930). The plausible spelling is wrong
 * and fails QUIETLY in the direction of doing less: no entry matches, `autos` is empty, and
 * a batch that should have notified its senders simply notifies nobody.
 */
export const AUTOSETTLE_POLICY = "autosettle";

/** Facts the caller already holds when it enters the transaction. */
export interface InjectPrefix {
  /** `$TAP_HOME`. */
  home: string;
  /** `$TAP_SPOOL`. */
  spoolDir: string;
  /** `$TAP_PAYLOADS`. */
  payloadsDir: string;
  /** `$TAP_RECEIPTS`. */
  receiptsDir: string;
  /** `tap_spool_team_name` — the empty-`toTeam` fallback, in both carriers. */
  team: string;
  /** `$TAP_COURIER_IDENTITY`. */
  courierIdentity: string;
  targetRegistry: string;
  toTeam: string;
  handle: string;
  pane: string;
  paneId: string;
  /** The candidate ids, in the caller's order. */
  ids: string[];
}

/**
 * One observation or effect the walk wants next. `id` rides the per-entry kinds so the
 * adapter answers about the entry the walk is currently revalidating.
 */
export type InjectNeed =
  | { kind: "readiness" }
  | { kind: "matches-team"; id: string }
  | { kind: "identity"; id: string }
  | { kind: "harness" }
  | { kind: "submit"; submit: SubmitRequest }
  | { kind: "notify-senders"; digestId: string; target: string; registry: string; ids: string[] };

/** The shared native submit owner admits each member at its first effect. */
export interface SubmitRequest {
  attemptIds: string[];
  preserveDraft: boolean;
  digestId: string;
  /** Preserve the existing diagnostic members=[ a b] spelling. */
  members: string;
  sentinel: string;
}

/** A registry-event append the adapter never composes and never interprets. */
export interface InjectEvent {
  identity: string;
  event: string;
  handle: string;
  pane: string;
  detail: string;
  /** `tap_registry_event_append_or_warn` (true) vs the silent `..._append` (false). */
  warn: boolean;
}

/** A stderr line the incumbent printed. The adapter writes it and reads nothing into it. */
export type InjectWarning = string;

export type InjectStep =
  | { done: true; rc: number; events: InjectEvent[]; warnings: InjectWarning[]; stampClock: boolean }
  | { done: false; need: InjectNeed };

/** The answers the adapter hands back, one field per need kind. */
export interface InjectAnswer {
  readiness?: string;
  matchesTeam?: boolean;
  identity?: string;
  harness?: string;
  submitRc?: number;
  notified?: boolean;
}

export interface InjectState {
  prefix: InjectPrefix;
  /** Claims held, in acquisition order. Released on every exit path. */
  claimed: string[];
  /** The release token for each id in `claimed`, from its acquire. */
  tokens: Map<string, ClaimToken>;
  /** Ids that survived revalidation, in the incumbent's order. */
  survivors: string[];
  /** Survivors whose policy is auto-settle. */
  autos: string[];
  /** The index of the claimed id currently being revalidated. */
  cursor: number;
  /** Per-entry observations already answered for `claimed[cursor]`. */
  matchesTeam?: boolean;
  identity?: string;
  digestId?: string;
  clobberDraft?: boolean;
  indexPath?: string;
  harness?: string;
  /** The finished verdict, held across the notify round. */
  pending?: { rc: number; events: InjectEvent[]; warnings: InjectWarning[]; stampClock: boolean };
  phase: "claim" | "readiness" | "revalidate" | "harness" | "submit" | "notify" | "done";
}

export function initialState(prefix: InjectPrefix): InjectState {
  return { prefix, claimed: [], tokens: new Map(), survivors: [], autos: [], cursor: 0, phase: "claim" };
}

function deadlineContext(prefix: InjectPrefix): DeadlineContext {
  // `graceAttempted` reads `home` and `spoolDir` only; the remaining fields carry the
  // caller's real values where it has them, so a later reader cannot mistake this for a
  // stub context that happens to work.
  const ctx: DeadlineContext = {
    home: prefix.home, spoolDir: prefix.spoolDir, eventLog: "", team: prefix.team,
    verbLabel: "tap", actingRegistry: "", scriptsDir: "", alert: { mode: "none" }, now: 0, unroutedGrace: 0,
  };
  return ctx;
}

/**
 * `[ -f "$path" ]` — regular file, following symlinks (charter rule 38). `existsSync`
 * would take the present branch for a DIRECTORY at the same path; a stat that throws is
 * the operator's FALSE, never an error.
 */
function isRegularFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

const canonicalPath = (p: InjectPrefix, id: string) => join(p.payloadsDir, `${id}.md`);
const donePath = (p: InjectPrefix, id: string) => join(p.receiptsDir, `${id}.done`);
const cancelPath = (p: InjectPrefix, id: string) => join(p.receiptsDir, `${id}.cancelled`);

/** Retire ownership when releasing claims, before any successor can acquire. */
export function releaseAll(state: InjectState): void {
  for (const id of state.claimed) {
    const token = state.tokens.get(id);
    if (token !== undefined) claimRelease(state.prefix.spoolDir, id, token);
  }
  state.claimed = [];
  state.tokens.clear();
}

function finish(state: InjectState, rc: number, events: InjectEvent[] = [],
                warnings: InjectWarning[] = [], stampClock = false): InjectStep {
  state.phase = "done";
  return { done: true, rc, events, warnings, stampClock };
}

/**
 * One step of the transaction. Call it with the state the previous step returned and the
 * answer to the need it asked for; it either answers a final rc or asks for the next thing.
 *
 * Statuses are the incumbent's, unchanged: 0 on a verified digest, 5 or 124 when the
 * submission is unverified or timed out AFTER canonicalization, 2 when fewer than two
 * entries survive revalidation and none auto-settles (the caller hands the survivors to
 * the per-id path — the one status `tap_spool_drain_once` branches on), 1 otherwise.
 */
export function digestInjectStep(state: InjectState, answer: InjectAnswer = {}): InjectStep {
  switch (state.phase) {
    case "claim": return claimPhase(state);
    case "readiness": return readinessPhase(state, answer);
    case "revalidate": return revalidate(state, answer);
    case "harness": {
      state.harness = answer.harness ?? "";
      return mintAndSubmit(state);
    }
    case "submit": return postSubmit(state, answer);
    case "notify": {
      const pending = state.pending!;
      return finish(state, pending.rc, pending.events, pending.warnings, pending.stampClock);
    }
    default:
      releaseAll(state);
      return finish(state, 1);
  }
}

// 1. Claim every candidate (exclusive-create CAS). A contended claim means another
//    drainer owns that entry — abort the whole group rather than split it.
function claimPhase(state: InjectState): InjectStep {
  const p = state.prefix;
  for (const id of p.ids) {
    const claim = claimAcquire(p.spoolDir, id);
    if (claim.status === "acquired") {
      state.claimed.push(id);
      state.tokens.set(id, claim.token);
    } else {
      releaseAll(state);
      return finish(state, 1);
    }
  }
  state.phase = "readiness";
  return { done: false, need: { kind: "readiness" } };
}

// 2. Re-check readiness once under the held claims (claim-then-verify, as redeliver).
// NO policy arg, deliberately (tap-toi9): phase A probes each candidate WITH its own
// policy, so a polite entry whose seat is mid-turn never reaches this batch. Every id that
// got here is non-polite, and passing one entry's policy would apply it to all of them.
function readinessPhase(state: InjectState, answer: InjectAnswer): InjectStep {
  state.clobberDraft = answer.readiness === "busy:pending" && state.claimed.length > 0
    && state.claimed.every(id => queuedDraftClobberDue(state.prefix.spoolDir, id));
  if (answer.readiness !== "ready" && !state.clobberDraft) {
    releaseAll(state);
    return finish(state, 1);
  }
  state.phase = "revalidate";
  state.cursor = 0;
  return revalidate(state, {});
}

// 3. Revalidate each claimed id (present, unsettled, binding still matches). A late
//    settle/cancel or identity drift drops that id from the batch, never the digest.
function revalidate(state: InjectState, answer: InjectAnswer): InjectStep {
  const p = state.prefix;
  const ctx = deadlineContext(p);
  let pending = answer;

  while (state.cursor < state.claimed.length) {
    const id = state.claimed[state.cursor]!;

    // The pure reads come first, in the incumbent's order: a payload that left the spool
    // is skipped before any observation is spent on it.
    if (!isRegularFile(spoolPayloadPath(p.spoolDir, id)) || !isRegularFile(metaPath(p.spoolDir, id))) {
      state.cursor++; continue;
    }
    if (graceAttempted(ctx, id)) { state.cursor++; continue; }
    // A stale plan cannot carry a retry row into a digest (it rings solo only).
    if (rowRetry(p.spoolDir, id)) { state.cursor++; continue; }
    if (metaField(p.spoolDir, id, "escalated_at") !== "") { state.cursor++; continue; }
    // `tap_is_done`: a `.done` OR a `.cancelled` receipt.
    if (isRegularFile(donePath(p, id)) || isRegularFile(cancelPath(p, id))) { state.cursor++; continue; }

    if (state.matchesTeam === undefined) {
      if (pending.matchesTeam === undefined) return { done: false, need: { kind: "matches-team", id } };
      state.matchesTeam = pending.matchesTeam;
      pending = {};
    }
    if (state.matchesTeam === false) { clearEntry(state); continue; }

    if (state.identity === undefined) {
      if (pending.identity === undefined) return { done: false, need: { kind: "identity", id } };
      state.identity = pending.identity;
      pending = {};
    }
    const identity = state.identity;
    clearEntry(state);
    if (identity !== "match") continue;

    state.survivors.push(id);
  }

  return afterRevalidation(state);
}

/** Advance past the entry under revalidation and forget its per-entry observations. */
function clearEntry(state: InjectState): void {
  state.matchesTeam = undefined;
  state.identity = undefined;
  state.cursor++;
}

function afterRevalidation(state: InjectState): InjectStep {
  const p = state.prefix;

  // tap-31it: an auto-settle survivor makes N>=1 legal for THIS batch — the doorbell is
  // that item's only delivery, so there is no per-id path to hand it back to. Ordinary
  // spool keeps N>=2 exactly as before: a lone busy-pane park still takes its own solo
  // redelivery rather than a digest envelope.
  state.autos = state.survivors.filter(id => metaField(p.spoolDir, id, "policy") === AUTOSETTLE_POLICY);
  const nsurv = state.survivors.length;
  // Not a digest after revalidation — hand the survivors back to the per-id path.
  if (nsurv < 2 && state.autos.length === 0) { releaseAll(state); return finish(state, 2); }
  if (nsurv < 1) { releaseAll(state); return finish(state, 2); }

  state.phase = "harness";
  return { done: false, need: { kind: "harness" } };
}

// 4. Mint the digest id and write the index (canonical paths) BEFORE submit.
//
// OUTCOME-NEUTRAL BEFORE SUBMIT (partner review, round 2). The index published here is the
// file the recipient is about to be pointed at, and at this moment the courier has
// observed nothing: rows therefore carry each payload's own obligation. Pre-settling them
// here would publish `settled: true` while no receipt exists, and verify-5 explicitly
// allows that doorbell to have landed — so a seat could act on the false instruction
// before any repair could reach it. A rewrite AFTER the fact repairs an artifact the
// reader may already have used; the only sound version is to claim nothing until the
// injection is verified, which is the same rule the receipt writer already follows.
function mintAndSubmit(state: InjectState): InjectStep {
  const p = state.prefix;
  const toTeam = p.toTeam || p.team;
  const digestId = mintId(p.courierIdentity);
  const indexPath = digestIndexPath(p.spoolDir, digestId);
  state.digestId = digestId;
  state.indexPath = indexPath;

  try {
    writeDigestIndex({
      indexPath, digestId, toTeam, handle: p.handle, courier: p.courierIdentity,
      spoolDir: p.spoolDir, payloadsDir: p.payloadsDir,
      members: state.survivors.map(id => ({ id, presettled: false })),
    });
  } catch {
    rmSync(indexPath, { force: true });
    releaseAll(state);
    return finish(state, 1);
  }

  // 5. Submit the single digest sentinel with the spool copies STILL in place.
  //
  // A SAME-TEAM park stores `to_team=""` and this envelope interpolates the team into
  // both halves, so an empty value used to render `from=/courier to=/peer` — a sentinel
  // whose route tokens fail the qualified-form grammar every other constructor is held to.
  // The bus being drained IS the team whose seats these are, which is what an empty
  // `to_team` means here; the fallback above is the same one the index write takes.
  const sentinel = renderSentinel({
    from: `${toTeam}/${p.courierIdentity}`, to: `${toTeam}/${p.handle}`,
    id: digestId, kind: "digest", reply: "settle-only", urgency: "", path: indexPath,
  });

  state.phase = "submit";
  return {
    done: false,
    need: {
      kind: "submit",
      submit: {
        attemptIds: [...state.survivors],
        preserveDraft: !state.clobberDraft,
        digestId,
        members: state.survivors.map(id => ` ${id}`).join(""),
        sentinel,
      },
    },
  };
}

function postSubmit(state: InjectState, answer: InjectAnswer): InjectStep {
  const p = state.prefix;
  const digestId = state.digestId!;
  const indexPath = state.indexPath!;
  const events: InjectEvent[] = [];
  const warnings: InjectWarning[] = [];

  // No result is no delivery verdict. Claim cleanup never supplies retry authority.
  if (answer.submitRc === undefined) {
    releaseAll(state);
    return finish(state, 1);
  }

  const outcome = digestOutcome({ rc: answer.submitRc, members: state.survivors.length });

  if (!outcome.canonicalize) {
    // Inject failed: discard the index (no zombie), release claims, spool intact.
    rmSync(indexPath, { force: true });
    releaseAll(state);
    events.push({ identity: "courier", event: outcome.event, handle: p.handle, pane: p.pane,
                  detail: `id=${digestId}`, warn: true });
    return finish(state, outcome.returnCode, events, warnings);
  }

  // 6. CUSTODY HAS ALREADY MOVED, in the native operation that observed the submit. This round verifies
  //    it and does everything the incumbent did AFTER custody — notify, stamp, queue record,
  //    events, verdict. A runtime death here loses what a worker death lost the incumbent at
  //    the same point: telemetry and a sender notice. Never custody.
  //
  //    Exit 5 is canonicalized too, because automatic retry could duplicate a staged digest.
  //    The index is RETAINED until all N are terminal (tap-qamw: forensics/partial-settle).
  releaseAll(state);

  if (outcome.notifySenders) {
    // Exit 5/124 is ATTEMPTED, not confirmed. The index already says the truthful thing
    // (nothing was pre-settled), so nothing is rewritten here — what is owed is the
    // sender, because rc 5 also drops the spool meta and stops automatic retry, taking the
    // delivery deadline with it. The notice says UNCONFIRMED, never failed: the courier
    // cannot observe which happened.
    state.pending = { rc: outcome.returnCode, events: tailEvents(state, outcome, digestId),
                      warnings: diagnosticWarnings(outcome, digestId), stampClock: outcome.stampClock };
    state.phase = "notify";
    return { done: false, need: { kind: "notify-senders", digestId, target: p.handle,
                                  registry: p.targetRegistry, ids: [...state.autos] } };
  }

  if (answer.submitRc === 7) {
    // Accepted into the harness queue: the entries are canonical, and each one's record is
    // the queue's, not the spool's. `harness-queue.ts record` is the same door the
    // incumbent shelled to, called here because it is already native.
    for (const id of state.survivors) recordHarnessQueue(p.home, id, warnings);
    // The digest id is the wire that was queued, and `tap read <digest>` completes it. It has
    // no payload file, so the receipt takes its route from the doorbell just rendered.
    const toTeam = p.toTeam || p.team;
    recordHarnessQueue(p.home, digestId, warnings,
      { from: `${toTeam}/${p.courierIdentity}`, to: `${toTeam}/${p.handle}`, kind: "digest" });
  } else {
    // Verified. NOW the courier may claim what it has observed.
    //
    // SETTLED IS NOT TERMINAL, and `tap_is_done` answers the second question: it is true
    // for a `.cancelled` receipt too. A `tap cancel --spooled` landing after revalidation
    // and before this line archives the payload and writes `.cancelled` — terminal, and
    // explicitly NOT delivered — so asking "is it done" published a WITHDRAWN send as
    // settled, pointing the seat at a canonical file cancel had just removed while telling
    // its sender the send was retracted. The predicate here is "does MY kind of settlement
    // exist", which is a `.done` receipt; `.cancelled` is a different fact.
    //
    // No reader may hold a pointer whose lifetime someone else's cleanup controls: a row
    // is published only while its canonical is actually there. Cancel archives the payload,
    // so a withdrawn id leaves the index rather than becoming a dangling path in a doorbell
    // already delivered.
    const live = state.survivors.filter(id => isRegularFile(canonicalPath(p, id)));
    const settled = state.autos.filter(id => live.includes(id) && isRegularFile(donePath(p, id)));

    // STAMP BEFORE REWRITING, deliberately. Retention protects an index that recorded a
    // verified injection, so stamping first means a rewrite that fails still leaves the
    // delivered doorbell's pointer alive for its window. The other order loses the file:
    // with no stamp and no `settled` rows, an index whose receipts are all terminal is
    // immediately reapable, and the seat we just woke is pointed at nothing.
    if (state.autos.length) { try { stampInjected(indexPath); } catch { /* both words exit 0 */ } }

    // Rewritten whenever this batch carried the class: the rewrite publishes the settled
    // rows AND drops any row whose payload is gone, and it is idempotent.
    //
    // ORDINARY DIGESTS ARE EXEMPT, AND THE EXEMPTION IS A DEFERRAL, NOT A JUDGEMENT
    // (tap-nz4c). An ordinary N>=2 batch writes its index once, before submit, and is never
    // rewritten — so an id cancelled AFTER its doorbell landed leaves a row pointing at a
    // path `tap cancel` has moved to archive. That dangling-row class is pre-existing and
    // predates this change; lifting the filter out of this gate is a behavior change to
    // code this port does not otherwise touch, so it stays beaded rather than folded in.
    // Stated here because an exemption implied by an `if` is the weakest form of a
    // deliberate decision — the next reader cannot tell it from an oversight.
    if (state.autos.length) {
      try {
        writeDigestIndex({
          indexPath, digestId, toTeam: p.toTeam || p.team, handle: p.handle,
          courier: p.courierIdentity, spoolDir: p.spoolDir, payloadsDir: p.payloadsDir,
          members: live.map(id => ({ id, presettled: settled.includes(id) })),
        });
      } catch {
        // Do not discard this. The doorbell has landed and the seat is holding the OLD
        // instructions — rows still read as owing a settlement on ids the courier has
        // now auto-settled. That is recoverable (reading or replying shows the receipt) and silence is
        // not: nothing else in the system will notice, and the drain would otherwise report
        // a clean success.
        events.push({ identity: p.courierIdentity, event: "digest_index_rewrite_failed",
                      handle: p.handle, pane: p.pane, detail: `id=${digestId}`, warn: true });
        warnings.push(`tap: digest '${digestId}' delivered, but its index could not be rewritten ` +
                      `(${indexPath}); the recipient holds pre-delivery instructions; inspect each item before acting`);
      }
    }
  }

  return finish(state, outcome.returnCode, [...events, ...tailEvents(state, outcome, digestId)],
                [...warnings, ...diagnosticWarnings(outcome, digestId)], outcome.stampClock);
}

/** The two appends every canonicalizing outcome makes, in the incumbent's order. */
function tailEvents(state: InjectState, outcome: ReturnType<typeof digestOutcome>, digestId: string): InjectEvent[] {
  const p = state.prefix;
  const events: InjectEvent[] = [{
    // The silent append: the incumbent discarded its status with `2>/dev/null || true`.
    identity: p.courierIdentity, event: `digest(n=${state.survivors.length})`,
    handle: `${p.toTeam}/${p.handle}`, pane: p.pane, detail: "", warn: false,
  }];
  if (outcome.event !== "digest") {
    events.push({ identity: "courier", event: outcome.event, handle: p.handle, pane: p.pane,
                  detail: `id=${digestId}`, warn: true });
  }
  return events;
}

function diagnosticWarnings(outcome: ReturnType<typeof digestOutcome>, digestId: string): InjectWarning[] {
  return outcome.diagnostic ? [`tap: digest id '${digestId}' ${outcome.diagnostic}`] : [];
}

function recordHarnessQueue(home: string, id: string, warnings: InjectWarning[],
  route?: { from: string; to: string; kind: string }): void {
  // The incumbent shelled to `harness-queue.ts record` through `tap_bun_call`; inside this
  // runtime that door is one import away, and a subprocess here would be the adapter's
  // own indirection re-created for no reason.
  try { recordHarnessQueued(home, id, route); }
  catch (error) { warnings.push(error instanceof Error ? error.message : String(error)); }
}

export { canonicalPath, donePath, cancelPath, isRegularFile };
