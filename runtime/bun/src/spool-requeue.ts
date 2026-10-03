// tap-w85su: `tap nudge <peer>` recovers a copy-mode park that outlived the copy mode.
//
// A copy-mode park is a safety_gate refusal. Its waiter redelivers within the busy
// deadline, but past it the deadline escalates the entry and the drain skips
// escalated rows for good, so a person who has long since left copy mode still sees
// the note parked ("No further recipient attempt"). doctor's stuck_spool finding
// already names `tap nudge` as the recovery; this is that step.
//
// Requeue is the only effect: it un-escalates the entry and hands it back to the
// ordinary deliverer, so every pane effect still goes through the courier's own
// gates (input protection, authorization, attempt license). It is a custody
// mutation, not a delivery: the deliverer's outcome is the delivery result.
//
// Eligibility is positive on every leg and anything unreadable holds (partner review
// review, after resend's no-effect proof in verbs/resend.ts):
//   - the park: reason copy-mode, class safety_gate, escalated, payload present;
//   - no possible effect: zero recorded attempts behind a modern pre-attempt
//     fence, and no attempt, delivery, read, settlement or resend evidence. A
//     copy-mode park after a cancel that did not take carries `.attempted` and so
//     stays held (the no-retry-after-possible-effect rule);
//   - the recipient: the payload and the entry name this target on the target's
//     team and registry, the seat's current row is still active on the recorded
//     pane with the instance the note was sent to, and the live pane passes the
//     courier's bound-identity guard (pane id, server generation, harness).
// Custody follows the drain's order: obligation lock, spool claim (no stale
// steal), reset custody, metadata lock. All are released before the deliverer
// starts, because it takes them itself.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { envelopeField } from "./envelope";
import { appendRegistryEventOrWarn } from "./events";
import { lockNameFits } from "./fsatomic";
import { pyRealpath } from "./install-manifest";
import { acquireObligationLock, acquirePathLock } from "./panelock";
import type { BoundRecipient } from "./courier";
import type { CopyModeObservation } from "./pane-state";
import { loadRegistry, seatMap } from "./registry";
import { withResetCustody } from "./reset";
import { spawnDeliverer } from "./spool-park-report";
import {
  busyDeadlineSeconds, isDict, metaBytes, METADATA_LOCK_TIMEOUT_MS, parseJsonPreserving, pyReadUtf8, pyTruthy,
} from "./spool-publication";
import { noEffectProof } from "./spool-effect-proof";
import { reownAfterRepark } from "./spool-reown";
import { claimAcquire, claimRelease, metaPath, payloadPath } from "./spool-sidecar";
import { listEntries } from "./spool-state";


export interface RequeueInput {
  /** The bus home whose spool holds the parks: the sender's bus, so only this bus's parks are seen. */
  home: string;
  /** The source bus's team: event attribution only. */
  team: string;
  /** The target's team; a cross-team target's payload names it, not the source team. */
  recipientTeam: string;
  target: string;
  /** The target's acting registry: the spool scope key, and the seat instance's source. */
  registry: string;
  /** The target's registered pane id; a park recorded for another pane holds. */
  paneId: string;
  scriptsDir: string;
  /** A fresh `#{pane_in_mode}` read of the target pane. */
  observeMode: () => CopyModeObservation;
  /** The courier's bound-identity guard on the live pane: "" when authorized, otherwise why not. */
  authorizePane: (bound: BoundRecipient) => string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  spawn?: typeof spawnDeliverer;
}

export interface RequeueResult {
  /** Ids handed back to the deliverer, with whether a new deliverer was started (false: a live one owns it). */
  requeued: { id: string; deliverer: "started" | "running" }[];
  held: { id: string; why: string }[];
}

export function requeueCopyModeParks(input: RequeueInput): RequeueResult {
  const env = input.env ?? process.env;
  const spoolDir = join(input.home, "spool");
  const result: RequeueResult = { requeued: [], held: [] };
  for (const row of copyModeParks(spoolDir, input)) {
    const why = requeueOne(input, spoolDir, row.id, row.pane_id, row.incomplete, env);
    if (why) { result.held.push({ id: row.id, why }); continue; }
    appendRegistryEventOrWarn("tap nudge", { log: join(input.home, "registry-events.log"), actor: "nudge",
      action: "spool_requeued_copy_mode", handle: input.target, pane: input.paneId, team: input.team, detail: `id=${row.id}`, env });
    const token = reownAfterRepark(spoolDir, row.id, "60", undefined, env);
    const deliverer = token === null ? "running"
      : (input.spawn ?? spawnDeliverer)({ scriptsDir: input.scriptsDir, home: input.home, spoolDir, id: row.id, reownToken: token, env }) ? "started" : "failed";
    // With no deliverer nothing drains the entry, and an unescalated park is not
    // this recovery's either: put the escalation back so the next nudge retries.
    if (deliverer === "failed") { result.held.push({ id: row.id, why: reEscalate(spoolDir, row.id, env) }); continue; }
    result.requeued.push({ id: row.id, deliverer });
  }
  return result;
}

/**
 * tap-zvuc9: the parks that would requeue but for copy mode, which is what licenses
 * nudge's no-client copy-mode cancel. These are requeue's own legs, read without
 * custody and without the mode read. The result is advisory: requeue re-proves every
 * leg under custody after the cancel. A park carrying `.attempted` never licenses one.
 */
export function copyModeCancelLicense(input: RequeueInput): string[] {
  const spoolDir = join(input.home, "spool");
  return copyModeParks(spoolDir, input).filter(row => {
    if (row.incomplete || !input.paneId || row.pane_id !== input.paneId) return false;
    let meta: unknown;
    try { meta = parseJsonPreserving(pyReadUtf8(metaPath(spoolDir, row.id))); } catch { return false; }
    return isDict(meta) && isEscalatedCopyModePark(meta, row.id) && !recipientProof(input, spoolDir, row.id, meta)
      && !noEffectProof(input.home, spoolDir, row.id, meta);
  }).map(row => row.id);
}

function copyModeParks(spoolDir: string, input: RequeueInput) {
  return listEntries(spoolDir, input.target, input.registry)
    .filter(row => row.reason === "copy-mode" && row.reason_class === "safety_gate" && row.escalated_at !== "");
}

function isEscalatedCopyModePark(meta: Record<string, unknown>, id: string): boolean {
  return meta.id === id && meta.reason === "copy-mode" && meta.reason_class === "safety_gate" && pyTruthy(meta.escalated_at);
}

/** "" when the entry was requeued; otherwise the leg that held it. */
function requeueOne(input: RequeueInput, spoolDir: string, id: string, rowPane: string, incomplete: boolean, env: NodeJS.ProcessEnv): string {
  if (incomplete) return "entry is incomplete";
  if (!input.paneId || rowPane !== input.paneId) return "recorded for a different pane";
  const obligation = acquireObligationLock(id, 0, env);
  if (!obligation) return "another process holds the obligation";
  try {
    const claim = claimAcquire(spoolDir, id, true, env);
    if (claim.status !== "acquired") return "another process holds the entry";
    try {
      const custody = withResetCustody(input.home, "nudge requeue", () => underMetaLock(input, spoolDir, id, env));
      return custody.ok ? custody.value : `team reset custody refused (${custody.refusal})`;
    } finally {
      claimRelease(spoolDir, id, claim.token);
    }
  } finally {
    obligation.release();
  }
}

function underMetaLock(input: RequeueInput, spoolDir: string, id: string, env: NodeJS.ProcessEnv): string {
  const path = metaPath(spoolDir, id);
  if (!lockNameFits(`${path}.lock`)) return "metadata lock name does not fit";
  const lock = acquirePathLock(`${path}.lock`, METADATA_LOCK_TIMEOUT_MS, env);
  if (!lock) return "metadata lock is busy";
  try {
    // Every leg is re-read here, inside the custody that settlement and delivery also take.
    let meta: unknown;
    try { meta = parseJsonPreserving(pyReadUtf8(path)); } catch { return "metadata is unreadable"; }
    if (!isDict(meta)) return "metadata is unreadable";
    if (!isEscalatedCopyModePark(meta, id)) return "entry changed before requeue";
    const mode = input.observeMode();
    if (mode.status !== "normal") return mode.status === "copy-mode" ? "pane is still in copy mode" : `copy mode is unreadable (${mode.status})`;
    // The proofs come last, immediately before the write, so evidence that lands
    // while the pane is being read still holds the entry.
    const recipient = recipientProof(input, spoolDir, id, meta);
    if (recipient) return recipient;
    const effect = noEffectProof(input.home, spoolDir, id, meta);
    if (effect) return effect;
    const now = Math.floor((input.now ?? (() => Date.now() / 1000))());
    delete meta.escalated_at;
    delete meta.human_escalated_at;
    meta.hold_until_epoch = now;
    meta.deadline_epoch = now + busyDeadlineSeconds(env);
    if (!pyTruthy(meta.waiter_lifetime)) meta.waiter_lifetime = "window";
    try {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, metaBytes(meta as Record<string, never>).replace(/\n$/, ""));
      renameSync(tmp, path);
    } catch { return "metadata could not be rewritten"; }
    return "";
  } finally {
    lock.release();
  }
}

/** Restores `escalated_at` after a deliverer that could not start; reports which way it went. */
function reEscalate(spoolDir: string, id: string, env: NodeJS.ProcessEnv): string {
  const path = metaPath(spoolDir, id);
  const lock = acquirePathLock(`${path}.lock`, METADATA_LOCK_TIMEOUT_MS, env);
  if (!lock) return "the deliverer could not start, and the metadata lock is busy; inspect with tap show";
  try {
    const meta = parseJsonPreserving(pyReadUtf8(path));
    if (!isDict(meta)) return "the deliverer could not start, and the metadata is unreadable; inspect with tap show";
    if (!pyTruthy(meta.escalated_at)) {
      meta.escalated_at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, metaBytes(meta as Record<string, never>).replace(/\n$/, ""));
      renameSync(tmp, path);
    }
    return "the deliverer could not start; the park stays escalated for the next nudge";
  } catch {
    return "the deliverer could not start, and the escalation could not be restored; inspect with tap show";
  } finally {
    lock.release();
  }
}

/**
 * The payload and the entry name this target on its team and registry; the seat's
 * row, re-read now, is active on the recorded pane with the payload's instance; and
 * the live pane still proves to be that seat.
 */
function recipientProof(input: RequeueInput, spoolDir: string, id: string, meta: Record<string, unknown>): string {
  if (meta.pane_id !== input.paneId) return "recorded for a different pane";
  // The same realpath scope listEntries selected the entry by, re-read under custody.
  if (typeof meta.target_registry !== "string" || !meta.target_registry || pyRealpath(meta.target_registry) !== pyRealpath(input.registry)) {
    return "recorded for a different registry";
  }
  if (pyTruthy(meta.to_team) && meta.to_team !== input.recipientTeam) return "recorded for a different recipient team";
  let raw: string;
  try { raw = readFileSync(payloadPath(spoolDir, id), "utf8"); } catch { return "payload is unreadable"; }
  if (envelopeField(raw, "id") !== id) return "payload id disagrees with the entry";
  if (envelopeField(raw, "to") !== input.target) return "payload names a different recipient";
  const toTeam = envelopeField(raw, "to_team");
  if (toTeam && toTeam !== input.recipientTeam) return "payload names a different recipient team";
  const sentTo = envelopeField(raw, "recipient_instance") ?? "";
  if (!sentTo) return "payload carries no recipient instance to prove the seat";
  let row: Record<string, unknown> | undefined;
  try { row = seatMap(loadRegistry(input.registry))[input.target] as Record<string, unknown> | undefined; } catch { return "recipient registry is unreadable"; }
  if (!row || row.status !== "active" || row.status_reason === "launching" || row.delivery === "poll") return "the seat is no longer an active pane seat";
  if (row.instance !== sentTo) return "the seat has a new instance since the park";
  if (row.pane_id !== input.paneId) return "the seat is now bound to a different pane";
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const denied = input.authorizePane({ handle: input.target, paneId: input.paneId, serverEpoch: text(row.server_epoch), harness: text(row.harness),
    bootId: text(row.boot_id), instance: sentTo });
  return denied ? `the pane does not prove to be the seat (${denied})` : "";
}
