import { inheritedActor } from "../context";
import { CODEX_HOOK_TRUST_REASON } from "../agent-state";
import { activeInputForPane, protectionDetail, updateInputProtection } from "../input-protection";
import { readDisplayState } from "../spool-readiness";
import { deliveryClockStamp } from "../delivery-clock";
import { recordedPermissions } from "../delivery-permissions";
import { clobberBand, DARK_EFFECTS } from "../deliver";
import {recordHarnessQueued,harnessQueueMessage} from "../harness-queue";
import { unverifiedSend } from "../queue-explanation";
import { deliveryBand, deliveryDisposition, type DeliveryBand } from "../slices/delivery-disposition";
import { isOrderShaped } from "../slices/order-shape";
import { validateLockedRegistryAuthority } from "../slices/registry-authority";
import { bodySourceRefusal, effectiveKind, guardApplies, parseSendArgs, refusalError, resolveId, resolveObligation, stageSource, tokenRefusal, type Obligation } from "../slices/message-construction";
// `tap send <to> (-m "text" | -f <file> | <payload-file>) [--from me] [--kind k]`
//
// The courier verb. Its exit codes are a contract, not a convenience:
//
//   0  durably accepted. `injected`/`pane` means the sentinel was verified out of
//      the input band. It does NOT claim the recipient processed anything.
//      After placement, a certified pre-effect identity_mismatch or pane_gone
//      is also 0: queued/poll, canonical and `.placed` kept.
//   1  terminal refusal (usage, validation, unknown seat) — NO canonical exists.
//   3  pane gone — checked BEFORE the canonical is placed, so nothing exists.
//   5  submit-unverified — the canonical STAYS on the bus for the recipient to
//      poll, and no `.sent` is written. Effect-ambiguous post-placement
//      failures stay here.
//
// The rule underneath all of them: a caller must never see a terminal refusal
// while an untracked payload from that send is outstanding. After canonical
// placement, no ordinary send path deletes the canonical.

import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { driverConfigPath, parseToml } from "../digest-window";
import { readSecureBytes } from "../launcher/catalog";
import { archiveRows } from "../bus-archive-index";
import { basename, join } from "node:path";

import { authorizePaneEffect, boundBootRefusal, canonicalPlaceLocked, evaluateBoundHarness, inspectClearFenceRecord, observeHarnessPid, submitVerify } from "../courier";
import { stagedIdleEvidence, type InterruptFact } from "../submit-phase";
import { stagedIdleWindowSeconds } from "../spool-publication";
import { noticeExpiredAtSendDoor } from "../clear-fence";
import { TapError, callingPane, observeCallerIdentity, refuseUnanchoredPane, resolveContext, resolveSelf, teamRootFromBus, type ResolvedContext } from "../context";
import { COURIER_IDENTITY, HELP_HANDLE, USER_IDENTITY, WATCH_IDENTITY, utcStamp, validToken } from "../ids";
import { forwardingRoute } from "../forwarding";
import { listHandleHistory } from "./register";
import { writeCancelledReceipt } from "../cancelled-receipt";
import { loadRegistry, seatMap, type RegistryDoc } from "../registry";
import { registryWriteRefusal, isOldStoreRefusal } from "../register-authority";
import { DENYLIST } from "../observe";
import { loadGlobalRegistry, flipMarkerState } from "../index-home";
import { atomicWrite, ensureAscii, jsonObj } from "../fsatomic";
import { renderSentinel } from "../sentinel";
import { parseStuckSentinel } from "../stuck-sentinel";
import { sentinelPayloadRecipient } from "../existing-sentinel";
import { cancelCopyMode, observePaneResult, paneAddress, ServerUnresponsive, serverEpochFromRaw, tmuxReadOnly } from "../tmux";
import { pendingExpired } from "../pending-reservation";
import { unboundPaneIdentityRecord } from "../pane-identity";
import { beginDeliveryAttempt } from "../delivery-attempt";
import { lockRoot, acquireObligationLock, acquirePaneLock, acquireRegistryLock, acquirePathLock, type PaneLock } from "../panelock";
import { bindExplicitRemoteRegistry, bindRemoteTeam, loadRemoteRegistry, remoteRecipientRow, senderIndexEvidence, splitSendTarget, TOKEN_RE, type RemoteTeam } from "../remote-target";
import { acquireResetMutationLock, assertResetUnfenced, fenceTestBarrier, interactiveResetCustodyWaiting, markResetGenerationReused, withResetCustody, type CustodyRefusal, RESET_HELD_LOCK_WAIT_MS } from "../reset";
import { recoveryHold } from "../recovery/state";
import { ParkRefusal, parkPlaced, type Parked } from "../spool-park";
import { finishPark, renderParkReceipt, type ParkReport, type ParkReportInput } from "../spool-park-report";

import { stampPreview } from "../sentinel-preview";
import { InvalidHeaderEncoding } from "../envelope";
import { appendRegistryEventOrWarn, registryEventsPath } from "../events";
import { noteSendEntered, recordSendRefusal, refusalErrorId, type SendRefusalFields } from "../send-refusal-log";

export type SendDisposition = "delivered" | "queued-poll" | "queued-spool" | "queued-harness" | "unverified" | "placed" | "recorded-departed";
export interface SendOutcome {
  rc: number;
  disposition: SendDisposition;
  // Present only when the courier's U4 interrupt actually fired pane effects
  // (tap-pkh9c): `tap nudge --interrupt` reports "interrupted" from this, and
  // never reports queued or unverified deliveries as recovery.
  interrupt?: InterruptFact;
}
/** A caller may wait on authorization only when the send proves no effect. */
export class SendAuthorizationPending extends Error {
  effect: "none" | "possible" = "possible";
}
interface SendOptions {
  inReplyTo?: string; noAutoReplyTo?: boolean; quiet?: boolean;
  recipientInstance?: string; historicalRecipient?: boolean; adoptedFrom?: string;
  expectedSenderInstance?: string; reauthorize?: (registry: RegistryDoc) => void; explicitTeam?: string;
  /** The sender bus already selected by the caller (tap nudge, tap-gridx); used as is, so a TAP_HOME
   * pin it honoured is never re-resolved from the cwd. */
  senderContext?: ResolvedContext;
  // Reply-only (tap-4lrwv): a missing addressee row becomes a terminal
  // durable record (canonical archived + cancel's `.cancelled` receipt)
  // instead of the unknown_recipient refusal. Never set by the public send
  // door; the predicate is re-proved under the publication locks below.
  departedSender?: boolean;
}

export function cmdSend(
  argv: string[],
  scriptsDir: string,
  agentFamilies: ReadonlySet<string>,
  opts?: SendOptions,
): number {
  return cmdSendOutcome(argv, scriptsDir, agentFamilies, opts).rc;
}

/**
 * The recipient row's own pre-effect refusals: still launching, or a pane
 * recipient with no usable pane id (tap-send.sh:879-880, :976-983). Poll and
 * paneless placement skip the pane_id guard; that check is injection-only.
 * nudge runs the same check before it asks the operator (tap-w85su).
 */
export function paneRecipientRefusal(to: string, seat: Record<string, unknown>): TapError | null {
  if (String(seat.status_reason ?? "") === "launching") return new TapError(1, "seat_launching", `tap team`, `'${to}' is bound but still launching`);
  if (String(seat.delivery ?? "pane") === "poll") return null;
  const boundPaneId = String(seat.pane_id ?? "");
  if (isTmuxPaneId(boundPaneId)) return null;
  const bindAction = String(seat.session ?? "") !== "" && String(seat.harness ?? "") !== ""
    ? `run 'tap session repair ${to}' to re-bind session`
    : `target seat '${to}' must run 'tap in' from its pane`;
  return boundPaneId === ""
    ? new TapError(1, "identity_unverified", bindAction, `registry row for '${to}' has no pane_id; refusing unbound delivery`)
    : new TapError(1, "identity_unverified", bindAction, `registry row for '${to}' has invalid pane_id '${boundPaneId}'; refusing delivery without changing seat status`);
}

/**
 * A tmux server that stops answering before this invocation placed its canonical
 * or admitted a delivery attempt has touched neither the bus nor the pane, so its
 * refusal says `effect: "none"` and a caller may repeat the whole command
 * (tap-yk8it: the reminder watcher's outage schedule). From the first effect on,
 * the same timeout keeps its untagged "outcome unknown" refusal: a delivery that
 * may have reached the pane, or mail already placed, is never repeated.
 */
export function cmdSendOutcome(
  argv: string[],
  scriptsDir: string,
  agentFamilies: ReadonlySet<string>,
  opts?: SendOptions,
): SendOutcome {
  noteSendEntered();
  const stage: SendStage = { preEffect: true, placed: false, withdrawn: false };
  try {
    return cmdSendOutcomeBody(argv, scriptsDir, agentFamilies, opts, stage);
  } catch (error) {
    if (error instanceof SendAuthorizationPending) error.effect=stage.preEffect ? "none" : "possible";
    const refusal = error instanceof ServerUnresponsive && stage.preEffect
      ? new TapError(1, error.tapErrorClass, "wait for the tmux server to answer, then repeat this command",
        `${error.message.replace(/; outcome unknown$/, "")}; refused before placement or any pane effect`, undefined, "none")
      : error;
    // Counted for the reliability census, which only sees placed mail. The two
    // arms exclude each other: `placed` is false for one and true for the other.
    const refusedAs = refusalErrorId(refusal);
    if (refusedAs !== null && !stage.placed) recordSendRefusal(refusedAs, stage, "pre");
    else if (refusedAs !== null && stage.withdrawn) recordSendRefusal(refusedAs, stage, "withdrawn");
    throw refusal;
  }
}

/**
 * What a refusal can name about its send, filled in as the send resolves it.
 * `placed` flips once the canonical is on the bus: a throw after that is not a
 * pre-placement refusal and the census already sees the mail. `withdrawn` flips
 * once the send has taken its own canonical back off the bus: the mail is gone
 * and the send refused, so it is counted as a withdrawal. A withdrawal that
 * custody refused leaves the payload in place and never sets it.
 */
interface SendStage extends SendRefusalFields { preEffect: boolean; placed: boolean; withdrawn: boolean }

function cmdSendOutcomeBody(
  argv: string[],
  scriptsDir: string,
  agentFamilies: ReadonlySet<string>,
  opts: SendOptions | undefined,
  stage: SendStage,
): SendOutcome {
  // --- construction, shared with the Bash door (slices/message-construction) ---
  // The parse, its usage refusals and the body-source count are the module's;
  // the refusals it returns for a later site are raised here at that site.
  // Bash's TAP_JSON is process-global from the moment `--json` is parsed:
  // every later refusal is a JSON error object (main.ts nativeError reads it
  // back), an earlier one is a human line.
  const args = parseSendArgs(argv, process.env.TAP_ASSIGN_VERB === "1", { onJson: () => { process.env.TAP_JSON = "1"; } });
  // Bash's success receipt names the verb the caller typed (tap_send_success_receipt).
  const receiptVerb = process.env.TAP_ASSIGN_VERB === "1" ? "assign" : "send";
  const sourcesRefusal = bodySourceRefusal(args);
  if (sourcesRefusal) throw refusalError(sourcesRefusal);
  // --- team-qualified addressing (D2, member 2 of the reply stack) ------------
  // `<team>:<handle>` normalizes and `<team>/<handle>` splits here with the
  // incumbent's refusals (tap-send.sh:168-172, tap_resolve_team_target); `to`
  // is the BARE handle from here on, as Bash's TO is after :270. The team is
  // bound through the machine index once the caller's own team is known.
  const target = splitSendTarget(args.to);
  let to = target.handle;
  stage.to = target.qualified ? target.original : to;
  const preview = args.preview;
  let from = args.from;
  const note = args.note;
  const json = args.json;
  // --- delivery classes, send side (D3a, reply stack member 3) ---------------
  // `--polite` parks before any attempt with the polite policy and its timeout
  // (tap-send.sh:1661); a retryable defer under polite carries the same pair
  // (:136-148); the clearing park is `standard` regardless (:1650). `--no-spool`
  // turns every pre-effect park into the `delivery_refused` refusal (:108-113).
  // The explicit interrupt class (`--urgent`, `--delivery interrupt`)
  // is native end to end — the courier owns the interrupt sequence
  // and its safety ordering; `--wake` is a parsed no-op.
  const polite = args.polite;
  const noSpool = args.noSpool;
  const retryablePolicy = polite ? "polite" : "standard";
  const retryableTimeout = polite ? args.politeTimeout : "";

  // send-reply-r2 checkpoint A (U1): the PUBLIC argv forms of the options that
  // reply already passes through opts ride the same opts — argv wins, the
  // caller's opts stay the default (tap-send.sh parses these today; the
  // stamps they feed were already native).
  const inReplyTo = args.inReplyTo || opts?.inReplyTo || undefined;
  const noAutoReplyTo = args.noAutoReplyTo || opts?.noAutoReplyTo || false;
  const recipientInstance = args.recipientInstance || opts?.recipientInstance || undefined;
  const historicalRecipient = args.historicalRecipient || opts?.historicalRecipient || false;
  const adoptedFrom = args.adoptedFrom || opts?.adoptedFrom || undefined;
  const expectedSenderInstance = args.expectedSenderInstance || opts?.expectedSenderInstance || undefined;

  // A composing reply passes its `--team` selection down (D4d): the incumbent's
  // `tap send` child inherits the override's exported TAP_HOME and is TAP_HOME-
  // first, where a native cwd walk under a live marker would re-select the
  // cwd team. send-reply-r2 checkpoint A (U1): the public `--team` form joins
  // the same selection — the incumbent applies the flag before its own cwd
  // walk (tap_apply_team_override, tap-send.sh:216) and ignores it for a
  // TAP_HOME caller, exactly as reply's own explicitTeam handling does.
  // With an explicit --team the caller named their bus; the pane arm is only
  // for a cwd-derived send that found no acting registry. Send's documented
  // refusal code is 1, and the pane arm's re-anchor names the enrolled seat.
  // Anything else keeps the generic unanchored refusal.
  const teamFlag = args.team && !process.env.TAP_HOME ? args.team : "";
  let ctx: ReturnType<typeof resolveContext>;
  try {
    ctx = opts?.senderContext ?? resolveContext(process.cwd(), process.env, opts?.explicitTeam || teamFlag ? { explicitTeam: opts?.explicitTeam || teamFlag } : undefined);
  } catch (error) {
    if (opts?.explicitTeam || !(error instanceof TapError) || error.errorClass !== "unanchored_bus") throw error;
    const seen = observeCallerIdentity();
    if (seen.state === "inside") {
      refuseUnanchoredPane(seen.paneId, process.cwd(), 1,
        { session: seen.session, serverEpoch: seen.serverEpoch }, process.env, seen.paneId, true);
    }
    throw error;
  }

  stage.team = ctx.team;
  // --- resolve the sender -------------------------------------------------
  // `from` = --from > TAP_SELF > pane-derived handle > fail loud. The resolved
  // sender must name an ACTIVE seat: an unknown --from is refused rather than
  // stamped, because a forged author is invisible to every downstream reader.
  if (!from) from = inheritedActor();
  if (!from) {
    const pane = callingPane();
    if (!pane) {
      throw new TapError(1, "identity_unverified", "tap register in this pane, or pass --from",
        "sender identity could not be derived and --from was not given");
    }
    from = resolveSelf(ctx, pane, 1).handle;
  }
  stage.from = from;
  if (!validToken(from)) throw new TapError(1, "usage_error", "tap help send", `--from '${from}' is not a valid token`);
  refuseReservedIdentity(to, "to", ctx.bus.home);
  refuseReservedIdentity(from, "from", ctx.bus.home);

  // --- stage the body, then resolve kind and id from the staged source -------
  // Bash's order: the source is staged (not_found / cap / unreadable refuse
  // here, before any recipient question), `--kind` beats the source's own
  // `kind:` beats `discuss`, and `--id` beats the source's `id:` beats a mint.
  // Staging is in memory on this door: nothing under the bus is created before
  // authorization. The staged bytes are BYTES — a `-f` body that is not valid
  // UTF-8 used to delegate to Bash and now stays here unchanged.
  // Detached waiters and watch own draining; sending does not scan the spool.
  // Refuse a reset fence before staging so a fenced send never consumes stdin.
  assertResetUnfenced(ctx.bus.home, "tap send");
  // A qualified destination on the caller's own team is a local send (Bash's
  // `local` scope). Any other team is the remote route, bound in the incumbent's
  // order — after the sender's fence (:244), before anything is staged (:264):
  // the recipient's acting registry and bus come from the index (marker live;
  // the router keeps an absent marker on Bash), the canonical stays on THIS bus,
  // and the recipient's own reset fence is checked as Bash checks it (:301).
  // The caller's own team must be a token before anything is staged or
  // placed: `tap_resolve_team_target` refuses it first (lib.sh:7265), for a
  // bare handle as much as for a qualified one, and it is the `from_team`
  // stamp and the sentinel's prefix on the remote route.
  if (!validToken(ctx.team)) {
    throw new TapError(1, "usage_error", "tap help", `local team '${ctx.team}' is not a valid token (${TOKEN_RE})`);
  }
  let remote: RemoteTeam | null = null;
  // send-reply-r2 checkpoint A (U2): the explicit `--remote-registry <path>`
  // override (tap-send.sh:293-303, 671-678) pins the recipient's acting
  // registry, so it takes the destination checks before the index bind would
  // and binds without sampling any marker. A bare-handle `--cross-worktree`
  // destination with no override is the MANUAL relay (:788-820): its pane is
  // mandatory and session-designated, resolved below with the recipient
  // questions it replaces.
  let manualRelay = false;
  // The hermes queue prefix (lib.sh:9096-9100): `/queue ` rides the INJECTED
  // sentinel only (lib.sh:11011), never the canonical or its preview.
  let queuePrefix = "";
  // The incumbent's from_team and sentinel `from` team half come from its
  // target resolver's LOCAL answer (tap-send.sh:307, :1000, :1682), whose
  // derivation is tap_resolve_team_target's TAP_TT_LOCAL_TEAM
  // (lib.sh:6972-6988): the bus's own registry.json `team.name` when that
  // file parses (any read/parse fault falls through), else the bus-anchor
  // root's basename (TAP_TT_SENDER_ROOT = the git toplevel of
  // dirname(TAP_HOME); teamRootFromBus is the native twin of that climb).
  // Review round 3: never a literal — the fixture's old worktree basename
  // `team` made the round-2 short-circuit look like parity.
  const relayTeamName = (() => {
    try {
      const doc = loadRegistry(join(ctx.bus.home, "registry.json")) as unknown as { team?: { name?: unknown } };
      return String(doc.team?.name ?? "").trim();
    } catch {
      return "";
    }
  })() || basename(teamRootFromBus(ctx.bus.home));
  if (args.remoteRegistry) {
    if (!target.qualified) {
      throw new TapError(1, "usage_error", "tap help send", "--remote-registry requires a <team>/<handle> destination");
    }
    let overrideIsFile = false;
    try { overrideIsFile = statSync(args.remoteRegistry).isFile(); } catch { overrideIsFile = false; }
    if (!overrideIsFile) {
      throw new TapError(1, "not_found", "tap help send", `--remote-registry path not found: ${args.remoteRegistry}`);
    }
    if (!validToken(target.team)) {
      throw new TapError(1, "usage_error", "tap help send", `team '${target.team}' is not a valid token (${TOKEN_RE})`);
    }
    if (!validToken(to)) {
      throw new TapError(1, "usage_error", "tap help send", `handle '${to}' is not a valid token (${TOKEN_RE})`);
    }
    remote = bindExplicitRemoteRegistry(target.team, to, args.remoteRegistry);
    assertResetUnfenced(remote.busHome, "tap send (recipient bus)");
  } else if (target.qualified && target.team !== ctx.team) {
    remote = bindRemoteTeam(target.team, to, process.env.TAP_INDEX_HOME);
    assertResetUnfenced(remote.busHome, "tap send (recipient bus)");
  } else if (args.crossWorktree && !target.qualified) {
    manualRelay = true;
  }
  // Bash's IDENTITY_ACTION for a remote seat (tap-send.sh:944-946): one action
  // for every drift, before and after placement, naming the team the seat must
  // re-bind from. Reads `to` late, after forwarding has settled it.
  const identityAction = (local: string): string => remote ? `target seat '${to}' must run 'tap in' from team '${remote.team}'` : local;
  // stageSource keeps the incumbent's order: a source's own refusals (a missing
  // file, the cap) come before the usage line for a missing destination.
  const staged = stageSource(args, { inlineMaxBytes: process.env.TAP_INLINE_MAX_BYTES });
  const kind = effectiveKind(args, staged);
  // Content and kind never grant preemption. Only the parser's explicit
  // --delivery interrupt / --urgent choice authorizes an interrupt.
  const urgent = args.urgent;
  const id = resolveId(args, staged, from);
  const charset = tokenRefusal(id, from, to, kind);
  if (charset) throw refusalError(charset);
  // tap-gyc91: a plain send is settle-only; --ask/--reply/--expect-reply request
  // a reply; --fyi is a no-op alias of the default. The obligation itself is
  // resolved inside the registry snapshot (U3) — its facts are the sender's
  // own immutable row, revalidated before publication.
  const canonPath = ctx.bus.payloadPath(id);
  let replyExpect: Obligation["replyExpect"] = "settle-only";
  let pane = "";
  let authorizedPaneId = "";
  let authorizedEpoch = "";
  let authorizedHarness = "";
  let authorizedBoot = "";
  let authorizedInstance = "";
  let autoUrgent = false;
  let attemptAdmitted = false;
  let pollRecipient = false;
  let resetLock: PaneLock | null = null;
  let relaySession = "";
  let copyModeDefer = "";
  let copyModeRecoveryHeld = false;
  // The handle forwarding resolved FROM; `to` becomes its target.
  let routeSource = to;
  // The departed-sender record (tap-4lrwv): set in the route block when
  // reply's option met a missing addressee row; consumed after placement.
  let departed = false;
  // Departure EVIDENCE (tap-4lrwv review I-A): a missing row alone is not
  // "left the team" — watcher probes, courier identities and restored
  // envelopes carry from-handles that were never seats. Departure leaves a
  // tombstone under team-history/ (out-retire writeTombstoneRow), so the
  // predicate requires one for the handle, and — when the inbound named a
  // sender instance — one for THAT instance. An unreadable history dir is
  // unknown, never gone: it refuses by returning false here.
  const hasDepartureTombstone = (): boolean => {
    try {
      const rows = listHandleHistory(ctx.bus.home, to);
      if (recipientInstance === undefined || recipientInstance === "") return rows.length > 0;
      return rows.some((row) => String(row.get("instance") ?? "") === recipientInstance);
    } catch { return false; }
  };

  try {

  // Per-id eligibility is serialized; atomic registry reads need no writer lock.
  const obligationLock = acquireObligationLock(id);
  if (!obligationLock) {
    throw new TapError(1, "obligation_busy", `tap outstanding ${from}`,
      `obligation '${id}' is busy; refusing to place without exclusive eligibility`);
  }
  try {
      const registry = loadRegistry(ctx.registryPath);
      const seats = seatMap(registry);
      const recipientDoc = remote ? loadRemoteRegistry(remote.registryPath, target.original) : registry;
      const fromSeat = ownSeat(seats, from);
      // The reserved watcher identity is not a seat (lib.sh:9913 keeps it a
      // constant; tap-register refuses it), so the active-row precondition
      // below must not answer it — bash's sender facts read a missing row as
      // non-dischargeable and the supervisor branch licenses settle-only mail
      // (tap-send.sh:512-553). The instance check is likewise row-scoped.
      if (from !== WATCH_IDENTITY && (!fromSeat || String(fromSeat.status ?? "active") !== "active")) {
        throw unregisteredSenderRefusal(from, seats, ctx.registryPath);
      }
      if (fromSeat && expectedSenderInstance && fromSeat.instance !== expectedSenderInstance) {
        throw new TapError(1, "instance_replaced", "retry reply from the authorized successor", "responding seat changed after recipient authorization; no reply placed");
      }
      // Point-of-effect authority: a reply's recipient
      // authorization — the addressee, a forwarding grant, an adoption grant —
      // was read before this snapshot; the caller re-runs the same predicate
      // here and again before effects/publication. The
      // incumbent rechecks only the actor's instance (tap-send.sh:1046-1052),
      // which cannot see a revoked adoption — the same instance can lose
      // custody of its fork — so this door refuses where the incumbent places.
      opts?.reauthorize?.(registry);
      // U3 (checkpoint B): the incumbent's sender facts
      // (tap_registry_sender_facts, lib.sh:9608-9688) answer ONE question —
      // is this sender dischargeable: active_pane OR (active AND
      // delivery=poll). active needs an active row that is not launching;
      // active_pane additionally a nonempty pane, demoted only by
      // epoch/boot staleness (lib.sh:9639-9677: the stored stamp must be
      // non-empty AND differ from the live server generation / this boot) —
      // the facts never read pane_id, so a malformed stored pane_id or an
      // empty stored epoch never demotes. A poll sender stays
      // instance-unstamped (tap_send_optimistic_sender_instance,
      // tap-send.sh:1024-1053) and an unattended sender proceeds into the
      // obligation module's downgrade.
      const senderDelivery = String(fromSeat?.delivery ?? "pane");
      const fromPane = String(fromSeat?.pane ?? "");
      const senderPaneId = String(fromSeat?.pane_id ?? "");
      const senderEpoch = String(fromSeat?.server_epoch ?? "");
      const senderLaunching = String(fromSeat?.status_reason ?? "") === "launching";
      const senderActive = !senderLaunching;
      const storedBoot = String(fromSeat?.boot_id ?? "");
      const bootVerdict = storedBoot ? boundBootRefusal(storedBoot, "delivery") : null;
      if (bootVerdict?.reason === "boot_id_unobservable") {
        // The incumbent's sender_liveness_unobservable (tap-send.sh:535-538)
        // with the child-exit spelling dropped: there is no child process to
        // quote on this door, so the diagnostic rides the refusal alone.
        throw new TapError(1, "sender_liveness_unobservable", "bun --version",
          `'${from}' could not be observed: the send-time registry read did not finish, so whether this seat is live is unknown. This is an observation failure, not a registration one -- it does not establish that the handle is stale, so do not reclaim it; retry, and if it persists check that the Bun runtime runs`);
      }
      const nowEpoch = serverEpochNow();
      const epochStale = senderEpoch !== "" && nowEpoch !== "" && senderEpoch !== nowEpoch;
      // tap-zk1w: a pane sender with no stamp makes no generation claim, so
      // pane agreement alone cannot make it dischargeable; poll seats never
      // carry one and keep their own disjunct below.
      const senderActivePane = senderActive && senderDelivery !== "poll" && fromPane !== "" && senderEpoch !== "" && !epochStale && bootVerdict === null;
      const senderDischargeable = senderActivePane || (senderActive && senderDelivery === "poll");
      // The watch identity (tap-send.sh:512-522, :546-548): the reserved
      // sidecar has no pane and cannot register, so it is never
      // dischargeable — but settle-only mail IS its channel: a supervisor
      // kind (probe/notice/progress) sent WITHOUT a reply obligation
      // bypasses the refusal, and reply-capable mail keeps the
      // reserved-identity refusal with the incumbent's bytes. (--fyi is the
      // deprecated spelling of the same settle-only default; tap-7rpf0
      // re-keys the carve-out on the obligation bit itself.)
      const watchIdentity = WATCH_IDENTITY;
      const supervisorLicensed = from === watchIdentity && !args.expectReply &&
        new Set(["probe", "notice", "progress"]).has(kind);
      if (from === watchIdentity && !senderDischargeable && !supervisorLicensed) {
        throw new TapError(1, "unregistered_sender",
          `tap send ${args.to} -f <path> --from ${watchIdentity} --kind notice`,
          `'${watchIdentity}' is the reserved watch-sidecar identity: it has no pane and cannot register, so it may only send settle-only mail — --kind probe, notice or progress with no reply obligation. A reply-expecting message is sent from a registered pane-backed seat`);
      }
      if (!senderDischargeable && !supervisorLicensed) throw unregisteredSenderRefusal(from, seats, ctx.registryPath);
      // Resolve once: only the effective, deliverable stamp grants an
      // unattended sender a reply obligation (tap-send.sh:582-623).
      const replyToStamp = args.replyToSet
        ? explicitReplyToStamp(args.replyTo, from, ctx)
        : noAutoReplyTo ? undefined : fromSeat ? autoReplyTo(from, fromSeat, seats, ctx.team, ctx) : undefined;
      const obligation = resolveObligation({ ...args, from }, kind, { unattended: fromSeat?.unattended === true, replyToStamped: !!replyToStamp }, process.env.TAP_ASSIGN_VERB === "1");
      if (obligation.refusal) throw refusalError(obligation.refusal);
      replyExpect = obligation.replyExpect;
      for (const warning of obligation.warnings) {
        process.stderr.write(`tap send: warning: ${warning}\n`);
      }
      // send-reply-r2 checkpoint A (U1): a qualified STORED reply_to no longer
      // delegates — the deliverability port below (seatDeliverable) answers
      // for it, exactly as the incumbent's tap_seat_deliverable did.
      // Bash prints $ORIGINAL_TO in the order-shape refusal: the target the
      // caller typed, before forwarding reduced it. Capture it here for parity.
      const originalTo = target.original;
      // --- the source payload: staged above, as bytes -----------------------
      // What the order-shape guard judges is Bash's staged $PAYLOAD: for -m/-f
      // the synthetic empty fence then the body bytes as staged, for a
      // positional file the file BEFORE any fenceless wrap. Canonicalization
      // stamps the wrapped bytes.
      const src = staged.wrapped;
      const judged = staged.judged.toString("utf8");

      // --- order-shaped-note guard (tap-oglkh), both doors, one predicate ------
      // Bash judges its staged $PAYLOAD (`judged` above): for -m/-f that is
      // exactly `src`, the synthetic empty fence then the body bytes as staged;
      // for a positional payload it is the file before any wrap. The exemptions are
      // Bash's, literally: an ask (the obligation is already tracked), --note
      // (the author's confirmation), the lane-request/probe/notice kinds, and a
      // reply-composed outbound. Not the autosettle carve-out set — a plain
      // `--kind digest` note is judged on Bash and is judged here too.
      // In-process there is no "could not classify" outcome: the predicate runs
      // on a string it already holds, and an exception would fail this send
      // loudly rather than read as not-shaped. The refusal spends no tmux
      // budget and creates nothing: it sits before the fence check and the
      // recipient observation, as Bash's sits before canonicalize.
      if (guardApplies({ expectReply: args.expectReply, note, inReplyTo: inReplyTo ?? "" }, kind)) {
        if (isOrderShaped(judged)) {
          // Bash appends the caller's explicit relay pane to the re-anchor
          // (tap-send.sh:443): the same note typed through the relay is routed
          // as work through the relay.
          const orderRoute = `tap assign ${originalTo} -f <path>${args.pane ? ` --cross-worktree --pane ${args.pane}` : ""}`;
          throw new TapError(2, "order_shaped_note", orderRoute,
            `this body reads like a work order (a bead id plus a work-order marker) but is being sent as a note, which mints no reply obligation and is how five dispatches went unanswered on 2026-09-03. Send it as work with: ${orderRoute}. If it really is a note, say so with: tap send ${originalTo} --note -f <path>`);
        }
      }

      let forwarded = { target: to, instance: "", adopted_from: "", source_instance: "" };
      let toSeat: Record<string, unknown> | null = null;
      // The departed-sender record (tap-4lrwv): only reply's option reaches
      // this branch, and only down the addressed-route arm — a manual relay
      // and a remote target keep every ordinary refusal. An edge routes to
      // its successor above (toSeat found); an ambiguous or revoked edge
      // refuses inside forwardingRoute; a row present but not active refuses
      // below. The predicate is re-proved under the publication locks
      // (assertDepartedUnchanged), so a seat that re-registered between the
      // route and the place never gets a "departed" record.
      if (manualRelay) {
        // --- the manual unbound relay (U2; tap-send.sh:788-820, 996-1001) ----
        // The relay's pane is MANDATORY (no implicit cross-worktree peer
        // discovery) and must be session-qualified; the unbound identity record
        // vouches that the session observes the pane as designated membership.
        // Nothing about the recipient is read from any registry: the sentinel
        // carries the SENDER's team on the from and a bare handle on the to,
        // `path=` rides, and the target binding stays unbound.
        if (!args.pane) {
          throw new TapError(1, "usage_error", "tap help send",
            "--cross-worktree requires --pane <tmux-target> (no implicit cross-worktree peer discovery)");
        }
        if (!args.pane.includes(":")) {
          throw new TapError(1, "identity_unverified", "pass --pane '<session>:<window>.<pane>'",
            `manual cross-worktree relay requires an exact session-qualified pane; bare target '${args.pane}' has ambient tmux meaning`);
        }
        relaySession = args.pane.slice(0, args.pane.indexOf(":"));
        // Route-time flip polarity (tap-send.sh:806-815, _XWT_ROUTE_MARKER):
        // the unbound relay place stays behind the invalid belt.
        if (flipMarkerState(process.env.TAP_INDEX_HOME) === "invalid") {
          throw new TapError(1, "invalid_flip", "tap doctor",
            "manual cross-worktree send refused — global-registry.json is present but unreadable or wrong schema");
        }
        const record = unboundPaneIdentityRecord(relaySession, args.pane, {});
        if (record.state !== "match" || !record.paneId) {
          throw new TapError(1, "identity_unverified", "verify the exact tmux session and pane, then retry",
            `manual cross-worktree pane '${args.pane}' is not observable as designated membership (${record.state})`);
        }
        authorizedPaneId = record.paneId;
        authorizedEpoch = record.epoch;
        authorizedBoot = "";
        pane = args.pane;
        toSeat = { pane: args.pane, pane_id: record.paneId, server_epoch: record.epoch, instance: "", harness: "" };
        // The relay's route seam (tap-send.sh:818): fire-and-forget, as Bash's.
        const hook = process.env.TAP_SEND_AFTER_ROUTE_HOOK;
        // The incumbent executes the hook directly and ignores only its exit
        // status (tap-send.sh:816-820): no timeout, inherited stdio. This seam
        // is the deterministic U3 cutover handshake — a slow handshake must not
        // be killed and its observable output must not silently change.
        if (hook) spawnSync(hook, [], { stdio: "inherit" });
        // Review round 5 (r4056301888/r4056301891): the incumbent resolves
        // PANE_CMD only AFTER the route hook (tap-send.sh:1417-1418), through
        // tap_pane_harness_command (lib.sh:8726) — an unsupported shallow
        // command ("node", a version string) is resolved through the pane's
        // process evidence, so the family the relay binds is the REAL agent
        // family, not the wrapper's name — and its denylist gate
        // (:1569-1575) then owns a hook that parked a shell on the pane:
        // terminal refuse before publication, with the gate's bytes, while
        // the place-time identity guard keeps pane_id recycle.
        const routeObs = observePaneResult(args.pane, process.env);
        if (routeObs.status === "unobservable") {
          throw new TapError(1, "tmux_unreachable", "restore tmux observation, then retry", routeObs.reason);
        }
        if (routeObs.status === "pane_dead") throw new TapError(1, "pane_dead", "resume the target pane before sending", `pane '${args.pane}' has exited`, "tap send");
        if (routeObs.status === "pane_gone") {
          // Review round 6 (P2): the incumbent re-checks pane liveness after
          // the hook and BEFORE PANE_CMD classification (tap-send.sh:1413);
          // a pane the hook killed is the rc 3 human-relay outcome with zero
          // artifacts — not an unsupported-harness refusal for an empty
          // command.
          throw new TapError(3, "pane_gone", "human_relay", `pane '${args.pane}' gone`, "tap send");
        }
        if (routeObs.status === "rate_limited") {
          throw new TapError(1, "rate_limited", "retry the send",
            `tmux client budget exhausted before '${args.pane}' could be classified`);
        }
        const routeCommand = routeObs.observation.currentCommand;
        authorizedHarness = relayHarnessFamily(
          routeCommand,
          routeObs.observation.panePid,
          agentFamilies, scriptsDir,
        );
        toSeat.harness = authorizedHarness;
        if (DENYLIST.includes(authorizedHarness)) {
          throw new TapError(1, "unsafe_target", "escalate",
            `reason=denylist; pane '${args.pane}' runs '${routeCommand}' (not an agent REPL)`, "tap send");
        }
        if (!agentFamilies.has(authorizedHarness)) {
          throw new TapError(1, "unsupported_harness", "escalate",
            `reason=unsupported; pane '${args.pane}' runs unsupported harness '${routeCommand}'`, "tap send");
        }
      } else {
        routeSource = to;
        forwarded = forwardingRoute(recipientDoc, to, recipientInstance, historicalRecipient);
        to = forwarded.target;
        // The remote row's verdicts (missing, pending, launching, suspended, poll,
        // no pane, unbound or malformed pane_id) are the incumbent's remote
        // refusals, raised here in its order; a row it answers FOUND continues
        // into the same checks a local row does.
        toSeat = remote ? remoteRecipientRow(recipientDoc, remote.team, to, ctx.team).seat : ownSeat(seats, to);
        // A concurrent writer may replace this atomic snapshot. The pre-effect
        // recheck refuses a changed route rather than silently retargeting it.
        const hook = process.env.TAP_SEND_AFTER_ROUTE_HOOK;
        if (hook) spawnSync(hook, [], { stdio: "inherit" });
      }
      if (!toSeat && !remote && !manualRelay && opts?.departedSender === true && hasDepartureTombstone()) {
        departed = true;
        // An inert row satisfies the downstream shape reads: delivery "poll"
        // skips every pane/driver guard below, and the record's stamps come
        // from `forwarded` and from absence (no recipient_instance), not
        // from this row.
        toSeat = { delivery: "poll", status: "active", status_reason: "", harness: "", pane: "", pane_id: "", instance: undefined, session: "" };
      } else if (!toSeat) {
        throw new TapError(1, "unknown_recipient", `tap team`, `'${to}' is not an active seat on team '${ctx.team}'`);
      }
      if (!manualRelay && String(toSeat.delivery ?? "pane") === "poll" && args.pane) {
        throw new TapError(1, "poll_mode_member", `tap send ${to} <payload> --from <handle>`,
          `'${to}' is a poll member and has no pane; --pane cannot target it (poll entries omit pane)`);
      }
      if (!remote && String(toSeat.status ?? "active") === "suspended") {
        // The incumbent's suspended split (tap-send.sh:866-888): a poll
        // member refuses rc 1 with the register action; a pane seat refuses
        // rc 3 — an incapable seat names re-registration, a launcher-managed
        // seat names session resume, anything else re-opening the pane.
        if (String(toSeat.delivery ?? "pane") === "poll") {
          throw new TapError(1, "suspended", `tap register ${to} --delivery poll`, `'${to}' is suspended`);
        }
        if (String(toSeat.status_reason ?? "") === "incapable") {
          throw new TapError(3, "suspended",
            `re-register '${to}' from its pane: run 'tap in' there, or 'tap register ${to} --pane <tmux-target>'`,
            `'${to}' is suspended (incapable)`);
        }
        const supSession = String(toSeat.session ?? "");
        const supHarness = String(toSeat.harness ?? "");
        throw new TapError(3, "suspended",
          (toSeat.crew === true || toSeat.crew === 1) ? `tap crew resume ${to}` : supSession !== "" && supHarness !== "" ? `tap session resume ${to}` : `re-open pane for '${to}' and run 'tap in'`,
          `'${to}' is suspended`);
      }
      if (!remote && String(toSeat.status ?? "active") === "pending") {
        // The incumbent's pending split (tap-send.sh tap_send_pending_refusal): a launch
        // reservation past its grace names refresh; a live one names waiting for the launch (tap-5exht).
        if (pendingExpired(String(toSeat.session ?? ""), String(toSeat.registered_at ?? ""))) {
          throw new TapError(1, "seat_pending", "tap team refresh", `'${to}' launch reservation expired; run tap team refresh to trim it`);
        }
        throw new TapError(1, "seat_pending", `wait for '${to}' to finish launching (or target seat '${to}' must run 'tap in')`, `'${to}' is still launching`);
      }
      if (!remote && String(toSeat.status ?? "active") !== "active") {
        throw new TapError(1, "unknown_recipient", `tap team`, `'${to}' is not an active seat on team '${ctx.team}'`);
      }
      // The hermes queue prefix rides the injected sentinel (lib.sh:9096-9100,
      // :11011) and its no_prompt_ok (lib.sh:10871) bypasses the rc-3
      // no-input-prompt defer — the bare prefix IS the handoff for a harness
      // with no visible idle prompt. Urgent zeroes it (U4).
      const toHarness = String(toSeat.harness ?? "");
      // Urgent zeroes the prefix (U4): the incumbent clears qprefix inside
      // submit_verify (lib.sh, "takes queue-prefix/bare-urgent delivery"),
      // but keeps the no_prompt_ok bypass hermes captured from it.
      if (toHarness.startsWith("hermes") && !urgent) queuePrefix = "/queue ";
      // Post-toSeat, pre-effect: launching and unbound pane_id are the
      // incumbent's refusals (tap-send.sh:879-880, :976-983). Poll/paneless
      // placement skips the pane_id guard — that check is injection-only.
      const recipientRefusal = paneRecipientRefusal(to, toSeat);
      if (recipientRefusal) throw recipientRefusal;
      pollRecipient = String(toSeat.delivery ?? "pane") === "poll";
      // An empty stored server_epoch never refuses (lib.sh:9676): staleness
      // needs both stamps, enforced at the courier's evidence layer.
      // Only tmux remains wired. Refuse an unusable preference before parking
      // can hand the message to a different transport. Poll never injects.
      if (!pollRecipient && process.env.TAP_DRIVER_FORCE_TMUX !== "1") {
        if (!resolveConfiguredDriver(String(toSeat.harness ?? "")).ok) {
          throw new TapError(1, "driver_unavailable", "tap doctor",
            "the configured delivery driver for this recipient cannot be used; refusing before parking rather than queueing a message that would drain through tmux");
        }
      }

      // Atomic snapshots are immutable. Revalidate the pinned sender and route
      // before effects and publication; never silently retarget a successor.
      const assertSenderUnchanged = (): void => {
        const current = loadRegistry(ctx.registryPath);
        opts?.reauthorize?.(current);
        if (!isDeepStrictEqual(ownSeat(seatMap(current), from), fromSeat)) {
          throw new TapError(1, "instance_replaced", "retry the send",
            "sender registration changed before placement; no reply placed");
        }
      };
      // The departed predicate re-proved under the publication locks
      // (tap-4lrwv): the acting registry must LOAD (an unreadable or
      // old-format one is unknown, never gone — it keeps refusing), the
      // target must still have NO row, and the historical route must still
      // resolve to the same handle with no forwarding edge.
      const routeChanged = (detail: string): TapError => new TapError(1, "forwarding_changed", "retry the send",
        `pinned recipient route changed before placement (${detail})`);
      const assertDepartedUnchanged = (): void => {
        let current: ReturnType<typeof loadRegistry>;
        try { current = loadRegistry(ctx.registryPath); }
        catch (error) {
          throw routeChanged(`acting registry unreadable before placement (${error instanceof Error ? error.message : "unreadable"})`);
        }
        if (ownSeat(seatMap(current), to)) {
          throw routeChanged("departed recipient re-registered before placement");
        }
        if (!hasDepartureTombstone()) {
          throw routeChanged("departure evidence disappeared before placement");
        }
        const now = forwardingRoute(current, routeSource, recipientInstance, historicalRecipient);
        if (now.target !== to || now.adopted_from !== "" || now.source_instance !== "") {
          throw routeChanged("a forwarding successor appeared before placement");
        }
      };
      const assertRouteUnchanged = (): void => {
        const changed = routeChanged;
        let now: typeof forwarded;
        let row: Record<string, unknown> | null;
        try {
          const doc = remote ? loadRegistry(remote.registryPath) : loadRegistry(ctx.registryPath);
          now = forwardingRoute(doc, routeSource, recipientInstance, historicalRecipient);
          row = remote ? remoteRecipientRow(doc, remote.team, now.target, ctx.team).seat : ownSeat(seatMap(doc), now.target);
        } catch {
          throw changed("forwarding route changed before placement; retry");
        }
        if ((["target", "instance", "adopted_from", "source_instance"] as const).some(k => now[k] !== forwarded[k])) {
          throw changed("forwarding route changed before placement; retry");
        }
        const seat = toSeat as Record<string, unknown>;
        if (!row || (["instance", "pane_id", "status", "status_reason", "delivery"] as const)
          .some(k => String(row[k] ?? "") !== String(seat[k] ?? ""))) {
          throw changed("forwarding recipient identity changed before placement; retry");
        }
      };
      assertSenderUnchanged();
      if (!departed && !manualRelay) assertRouteUnchanged();

      if (!pollRecipient && !manualRelay) {
        // The explicit `--pane` override (tap-send.sh:895-902) confirms the
        // binding or refuses; it cannot bypass the registered pane identity.
        if (args.pane) {
          const registeredPane = String(toSeat.pane ?? "");
          if (registeredPane && args.pane !== registeredPane) {
            const session = String(toSeat.session ?? "");
            const harness = String(toSeat.harness ?? "");
            const launcherManaged = session !== "" && harness !== "";
            throw new TapError(1, "identity_mismatch",
              launcherManaged ? `run 'tap session repair ${to}' to re-bind session` : `target seat '${to}' must run 'tap in' from its pane`,
              `explicit pane '${args.pane}' does not match registered pane '${registeredPane}' for '${to}'`);
          }
        }
        // The pane-drift heal (tap-send.sh:904-970): a live id-shaped address
        // field is observed before its short registry rewrite, so the first send
        // does not refuse pane_drift against `%N`. Epoch-stale rows are never
        // resolved — a recycled id would write the wrong address — and the
        // identity checks below report the staleness instead.
        const idPane = String(toSeat.pane ?? "");
        if (isTmuxPaneId(idPane) && String(toSeat.pane_id ?? "")) {
          const healed = healIdShapedPane(remote ? remote.registryPath : ctx.registryPath, remote ? remote.rootReal : ctx.root, to, idPane, String(toSeat.pane_id), String(toSeat.server_epoch ?? ""), remote ? remote.busHome : ctx.bus.home, toSeat as Record<string, unknown>);
          if (healed) (toSeat as Record<string, unknown>).pane = healed;
        }
      }

      // The optimistic sender_instance stamp (tap-send.sh:1024-1053): a
      // pane-backed active sender stamps its row instance; a poll or demoted
      // sender stays unbound.
      const senderInstance = senderActivePane && typeof fromSeat?.instance === "string" ? fromSeat.instance : undefined;

      // Step A dead pane (tap-send.sh:1394-1414, lib.sh:8010-8015): a
      // registry-bound seat whose pane is gone is marked suspended
      // (pane_gone, exited_at stamped once) and refused rc 3; when the mark
      // cannot run — the tmux server is unreachable, "a dead socket is not
      // a dead pane" — the send refuses without touching the registry. The
      // copy-mode cancel ladder maps its empty reads to the same refusal.
      const refuseDeadPane = (): never => {
        if (manualRelay) throw new TapError(3, "pane_gone", "human_relay", `pane '${pane}' gone`, "tap send");
        // Remote pane loss never grants suspension authority over a local namesake.
        if (remote) {
          const fallback = `tap send ${to} <payload> --cross-worktree --pane <tmux-target>`;
          throw new TapError(1, "pane_gone", fallback, `pane '${pane}' for ${remote.team}/${to} is not alive. Fallback: ${fallback}`);
        }
        fenceTestBarrier("send-before-suspend");
        const suspended = markSuspendedLocked(ctx.registryPath, ctx.root, to, ctx.bus.home, toSeat as Record<string, unknown>);
        if (suspended === "busy") throw new TapError(1, "registry_lock_busy", "retry the send", `registry busy; refused to suspend '${to}'`);
        if (suspended === "changed") throw new TapError(1, "forwarding_changed", "retry the send", `recipient registration changed; refused to suspend '${to}'`);
        if (suspended === "unobservable") {
          throw new TapError(1, "tmux_unreachable", "unset TMUX, restore tmux on PATH, or repair the server socket",
            `tmux server unreachable; refused to suspend '${to}' (a dead socket is not a dead pane)`);
        }
        const session = String(toSeat.session ?? "");
        const harness = String(toSeat.harness ?? "");
        throw new TapError(3, "pane_gone",
          (toSeat.crew === true || toSeat.crew === 1) ? `tap crew resume ${to}` : session !== "" && harness !== "" ? `tap session resume ${to}` : `re-open pane for '${to}' and run 'tap in'`,
          `pane '${pane}' gone; marked '${to}' suspended`);
      };

      if (!pollRecipient && !manualRelay) {
        pane = String(toSeat.pane ?? "");
        if (!pane) throw new TapError(1, "unknown_recipient", "tap team", `'${to}' has no pane recorded`);
        // tap-zk1w: an unstamped pane row binds its pane id to no server
        // lifetime, so it authorizes neither delivery nor the lifecycle effects
        // below (a gone pane would otherwise mark the row suspended).
        const boundEpoch = String(toSeat.server_epoch ?? "");
        if (!boundEpoch) {
          throw new TapError(1, "identity_mismatch", identityAction(`tap register ${to}   (the recorded pane carries no tmux server generation; re-register to stamp it)`),
            `'${to}' has no recorded server generation, so its recorded pane cannot be proven to be the addressed seat`);
        }

        // The clear fence is NOT read here: the incumbent reads it once, after
        // placement and the render (tap-send.sh:1639), and runs these identity
        // checks for a clearing seat too. A pre-placement sample used to decide
        // the later park class and missed both directions of the race.
        // Checked before placement and against the same registry snapshot.
        const observed = observePaneResult(pane);
        if (observed.status === "unobservable") {
          throw new TapError(1, "tmux_unreachable", "restore tmux observation, then retry", observed.reason);
        }
        if (observed.status === "rate_limited") {
          throw new TapError(1, "rate_limited", "retry the send",
            `tmux client budget exhausted before '${to}' could be authorized`);
        }
        if (observed.status === "pane_dead") throw new TapError(1, "pane_dead", "resume the recipient before sending", `pane '${pane}' has exited; recipient registration is unchanged`, "tap send");
        if (observed.status === "pane_gone") {
          throw refuseDeadPane();
        }
        const obs = observed.observation;
        const boundPaneId = String(toSeat.pane_id ?? "");
        if (boundPaneId && boundPaneId !== obs.paneId) {
          throw new TapError(1, "identity_mismatch", identityAction(`tap register ${to}   (the recorded pane is stale; re-register to rebind)`),
            `'${to}' is bound to pane id ${boundPaneId}, but '${pane}' is now ${obs.paneId} — refusing to deliver to a pane that is not the addressed seat`);
        }
        const boundBoot = String(toSeat.boot_id ?? "");
        const bootRefuse = boundBootRefusal(boundBoot, "delivery");
        if (bootRefuse) {
          throw new TapError(1, "identity_mismatch", identityAction(`tap register ${to}   (the recorded pane is from a previous boot session)`),
            bootRefuse.detail);
        }
        if (obs.serverEpoch && boundEpoch !== obs.serverEpoch) {
          throw new TapError(1, "identity_mismatch", identityAction(`tap register ${to}   (the recorded pane is from a previous tmux server)`),
            `'${to}' was registered under server generation ${boundEpoch}, but the pane now reports ${obs.serverEpoch}`);
        }
        if (DENYLIST.includes(manualRelayFamily(obs.currentCommand, agentFamilies))) {
          throw new TapError(1, "unsafe_target", "escalate",
            `reason=denylist; pane '${pane}' runs '${obs.currentCommand}' (not an agent REPL)`, "tap send");
        }
        authorizedPaneId = boundPaneId || obs.paneId;
        authorizedEpoch = boundEpoch;
        authorizedHarness = String(toSeat.harness ?? "");
        authorizedBoot = boundBoot;
        authorizedInstance = typeof toSeat.instance === "string" ? toSeat.instance : "";
        const { state: evidence, error } = evaluateBoundHarness(obs, authorizedHarness, { scriptsDir, agentFamilies, registryPath: "" });
        if (evidence === "unobservable") {
          throw new TapError(1, "harness_unobservable", "if this command runs in a sandbox, retry the exact authorized command once with approved sandbox escalation",
            `process inspection unavailable; identity unobservable, not proven stale (bound family '${authorizedHarness}', live command '${obs.currentCommand}')${error ? `; ${error}` : ""}`);
        }
        if (evidence !== "alive") {
          throw new TapError(1, "identity_mismatch", identityAction(`tap register ${to}   (the recorded pane is stale; re-register to rebind)`),
            `harness evidence ${evidence} for bound family '${authorizedHarness}' (live command '${obs.currentCommand}')`);
        }
      }

      // Copy-mode cancellation BEFORE placement (tap-send.sh:1597-1643,
      // lib.sh:9001-9047): polite and auto recipients are never touched; an
      // in-mode --no-spool send refuses without cancelling (the same
      // spool_and_exit path, which for --no-spool is a refusal); everyone
      // else gets the cancel keystroke, an empty re-read maps to the dead
      // pane's rc 3, and a pane that stayed in copy mode places first and
      // defers with the typed copy-mode reason.
      const permissions = manualRelay ? "bypass" : recordedPermissions(remote?.registryPath ?? ctx.registryPath, to);
      autoUrgent = !pollRecipient && urgent && permissions === "auto";
      if (!pollRecipient && !polite && permissions === "bypass") {
        const copyTarget = authorizedPaneId || pane;
        const inModeRead = (): "gone" | "in" | "out" => {
          const read = tmuxReadOnly(["display-message", "-p", "-t", copyTarget, "#{pane_in_mode}"], process.env);
          const raw = read.stdout.trim();
          if (read.code === 0 && (raw === "0" || raw === "1")) return raw === "0" ? "out" : "in";
          const observation = observePaneResult(copyTarget);
          if (observation.status === "pane_dead") throw new TapError(1, "pane_dead", "resume the recipient before sending", `pane '${copyTarget}' has exited`, "tap send");
          if (observation.status === "pane_gone") return "gone";
          throw new TapError(1, "tmux_unreachable", "restore tmux observation, then retry",
            `copy-mode state for '${copyTarget}' is unobservable; no pane absence established`);
        };
        const first = inModeRead();
        if (first !== "out") {
          if (noSpool) {
            // The refusal bytes of tap_send_spool_and_exit's --no-spool arm
            // (tap-send.sh:148-153), which for copy-mode fires BEFORE the
            // cancel: nothing is published, nothing is cancelled.
            throw new TapError(1, "delivery_refused", "re-send when the recipient is ready",
              "--no-spool refused (copy-mode); no message queued; pane is in copy mode or unreadable", "tap send");
          }
          if (first === "gone") refuseDeadPane();
          const copyLock = acquirePaneLock(copyTarget);
          if (!copyLock) copyModeDefer = "another submit holds the pane -> defer copy-mode cancellation";
          else try {
            const protectedInput = activeInputForPane(copyTarget);
            if (protectedInput) copyModeDefer = protectionDetail(protectedInput);
            else if (recoveryHold(copyTarget)) copyModeRecoveryHeld = true;
            else {
              const rowless = manualRelay ? unboundPaneIdentityRecord(relaySession, pane, {
                paneId: authorizedPaneId, harness: authorizedHarness, families: [...agentFamilies],
              }).state : "match";
              if (rowless !== "match") {
                throw new TapError(1, "identity_mismatch", "verify the exact tmux session and pane, then retry",
                  `rowless recipient identity drifted before copy-mode cancellation (${rowless})`, "tap send");
              }
              const authorized = authorizePaneEffect(copyTarget, {
                paneId: authorizedPaneId, serverEpoch: authorizedEpoch, harness: authorizedHarness,
                bootId: authorizedBoot, handle: manualRelay ? "" : to, instance: authorizedInstance,
              }, DARK_EFFECTS, { scriptsDir, agentFamilies, registryPath: manualRelay ? "" : remote?.registryPath ?? ctx.registryPath });
              if (authorized.status !== "ok") {
                throw new TapError(1, authorized.status, authorized.status === "rate_limited" ? "retry the send"
                  : identityAction(`tap register ${to}   (the recorded pane is stale; re-register to rebind)`), authorized.detail);
              }
              const lockedMode = inModeRead();
              if (lockedMode === "gone") refuseDeadPane();
              if (lockedMode === "in") {
                stage.preEffect = false; // the copy-mode cancel is this delivery's first pane effect
                try {
                  if (beginDeliveryAttempt(ctx.bus.home, id) !== "created") throw new Error("prior delivery attempt");
                  attemptAdmitted = true;
                } catch {
                  throw new TapError(1, "attempt_evidence_unwritable", "tap doctor", "cannot record attempt before delivery");
                }
                const cancelled = cancelCopyMode(copyTarget);
                if (cancelled === "ok") DARK_EFFECTS.settle(0.05);
                const second = cancelled === "ok" ? inModeRead() : "in";
                if (second === "gone") refuseDeadPane();
                if (second === "in") copyModeDefer = "stayed in copy-mode after cancel -> defer";
              }
            }
          } finally { copyLock.release(); }
        }
      }

      // Review round 5 (r4056301887/r4056301888): the incumbent's placement
      // re-runs the rowless identity guard INSIDE tap_send_place_canonical
      // (tap_send_require_bound_identity, tap-send.sh:1217/1350-1360) and
      // keeps a live-route marker belt there too (:1226-1233) — a route seam
      // that flipped the pane's family or recycled its pane id since route is
      // refused BEFORE anything else moves, including the sender's own live
      // re-authorization: a self-relay whose pane id was recycled must answer
      // the guard's pane_recycled, not the sender check's mismatch. The
      // incumbent's pane-alive check (tap-send.sh:1413-1427) sits before this
      // point and answers an unobservable target with rc 3, so the gone
      // states map there. The submit-time guard below stays as defense in
      // depth, as does the courier's own evidence check.
      if (manualRelay) {
        const placeRecord = unboundPaneIdentityRecord(relaySession, args.pane, {
          paneId: authorizedPaneId, harness: authorizedHarness, families: [...agentFamilies],
        });
        if (placeRecord.state === "session_absent" || placeRecord.state === "session_unobservable" ||
            placeRecord.state === "pane_set_unobservable" || placeRecord.state === "designated_pane_missing" ||
            placeRecord.state === "identity_incomplete" || placeRecord.state === "pane_outside_session") {
          throw new TapError(3, "pane_gone", "human_relay", `pane '${args.pane}' gone`, "tap send");
        }
        if (placeRecord.state !== "match") {
          process.stderr.write(`tap: rowless pane identity drifted before pane effect (${placeRecord.state})\n`);
          throw new TapError(1, "identity_mismatch", "verify the exact tmux session and pane, then retry",
            "rowless recipient identity drifted before delivery", "tap send");
        }
        // The optional belt (tap-send.sh:1227-1233): route-time polarity live,
        // fresh sample invalid — refuse, publish nothing.
        if (loadGlobalRegistry(process.env.TAP_INDEX_HOME).marker === "invalid") {
          throw new TapError(1, "invalid_flip", "tap doctor",
            "manual cross-worktree send refused — global-registry.json became invalid before place");
        }
      }

      // A manual relay whose sender's own pane binding drifted still delivers:
      // the relay target is bound above by its own observation, and the
      // sender's pane only names who is asking.
      // It warns so the operator can rebind; a pane-less poll sender has no
      // binding to check.
      if (manualRelay && senderDelivery !== "poll") {
        const senderObserved = observePaneResult(fromPane);
        const stale = senderObserved.status !== "ok" || senderPaneId !== senderObserved.observation.paneId ||
          senderEpoch !== senderObserved.observation.serverEpoch || boundBootRefusal(storedBoot, "delivery") !== null;
        if (stale) process.stderr.write("tap: warning: your seat's pane binding is stale; run tap in to rebind\n");
      }

      // tap-7t3ag: an interactive sender auto-waits a busy sidecar (stderr
      // progress names the holder); non-interactive callers keep the bound.
      resetLock = acquireResetMutationLock(ctx.bus.home, "tap send", undefined, "shared", interactiveResetCustodyWaiting("tap send"));
      ctx.bus.ensureDirs();
      // Readers share only the final validation/publication span. Identity
      // writers must see this payload before retiring either stamped instance.
      const publicationLocks: PaneLock[] = [];
      try {
        const paths = [...new Set([ctx.registryPath, ...(!manualRelay && remote ? [remote.registryPath] : [])])].sort();
        for (const path of paths) {
          const lock = acquirePathLock(`${path}.lock`, RESET_HELD_LOCK_WAIT_MS, process.env, "shared");
          if (!lock) throw new TapError(1, "registry_lock_busy", "retry the send",
            "could not obtain registry publication custody; no payload placed");
          publicationLocks.push(lock);
        }
        assertSenderUnchanged();
        if (departed) assertDepartedUnchanged();
        else if (!manualRelay) assertRouteUnchanged();
      // An explicit --id is native since D1, so the incumbent's placement
      // refusals for an id already on the bus are produced here with the
      // incumbent's bytes, in tap_canonical_place's order: a spool entry, an
      // archived id, an existing canonical, a settled receipt.
      // tap_send_place_canonical's own selector (tap-send.sh:1216-1262) picks
      // the recipient lock (:1057-1214, generic wrap — its case statement has
      // no branch for tap_fail's exit 1, so every refusal there, spooled_id
      // included, collapses to `die "tap send: locked place failed for
      // '<to>' (<line>)"`, class `error`, action `fix_command`) only for an
      // ORDINARY (non-manual-relay) send once the global flip marker is
      // live — an ordinary send that reaches this point is always
      // v0.20-bound already: an unbound local/remote target is refused
      // upstream (this file's own `identity_unverified`/"refusing unbound
      // delivery" throw a few lines above; tap-send.sh:976-983, :987 is the
      // same guarantee), so "live + ordinary" always means recipient-lock.
      // A manual cross-worktree relay (`--cross-worktree` + bare handle,
      // never registry-bound) takes no wrapper: :1224-1234 places directly,
      // so a manual relay preserves spooled_id.
      const lockedPlaceFailed = (innerDetail: string, innerAction: string): TapError =>
        new TapError(1, "error", "fix_command", `tap send: locked place failed for '${to}' (tap: ${innerDetail}; next: ${innerAction})`);
      const spoolPayload = join(ctx.bus.home, "spool", `${id}.md`);
      const spoolMeta = join(ctx.bus.home, "spool", `${id}.meta.json`);
      if (existsSync(spoolPayload) || existsSync(spoolMeta)) {
        const detail = `id '${id}' already has a spool entry: ${spoolPayload}`;
        throw manualRelay
          ? new TapError(1, "spooled_id", "wait_for_redelivery_or_remove_spool_entry", detail)
          : lockedPlaceFailed(detail, "wait for redelivery or remove spool entry");
      }
      if (archiveRows(ctx.bus.home, true).has(id)) {
        throw lockedPlaceFailed(`canonical_place: refusing duplicate archived id '${id}'`, "fix command");
      }
      if (existsSync(canonPath)) {
        throw lockedPlaceFailed(`canonical_place: refusing duplicate id '${id}' (payload already exists: ${canonPath})`, "fix command");
      }
      if (existsSync(ctx.bus.donePath(id))) {
        throw lockedPlaceFailed(`canonical_place: refusing duplicate id '${id}' (receipt already settled: ${ctx.bus.donePath(id)})`, "fix command");
      }
      // The recipient reset fence's SECOND check (tap-send.sh:699): the bus
      // about to receive the payload is re-read right before the publish — a
      // reset that landed during staging is refused before anything is placed.
      assertResetUnfenced(remote ? remote.busHome : ctx.bus.home, "tap send (recipient bus)");
      try {
      const placeCanonical = () => canonicalPlaceLocked(ctx.bus, src, {
        id, from, to, kind, path: canonPath, reply: replyExpect,
        // A manual relay carries Bash's cross_worktree/from_team stamps and NO
        // to_team: the relay never learns the recipient's team
        // (tap-send.sh:996-1001).
        cross_worktree: remote || manualRelay ? "true" : undefined,
        from_team: remote ? ctx.team : manualRelay ? relayTeamName : undefined,
        to_team: remote ? remote.team : undefined,
        // The urgency stamp rides only --urgent (tap-send.sh:1003-1004,
        // :1234): a bare closed-set tag, present on the envelope and the
        // sentinel, absent otherwise.
        urgency: urgent && !autoUrgent ? "urgent" : undefined,
        sentinel_preview: stampPreview(args.previewSet, preview),
        in_reply_to: inReplyTo,
        reply_to: replyToStamp,
        recipient_instance: !manualRelay && typeof toSeat.instance === "string" ? toSeat.instance : undefined,
        sender_instance: senderInstance,
        to_adopted_from: forwarded.adopted_from || undefined,
        original_recipient_instance: forwarded.source_instance || undefined,
        adopted_from: adoptedFrom,
      });
      // Route polarity live (tap-send.sh:1226-1234): the optional belt — a
      // fresh sample gone invalid refuses the unbound place.
      if (manualRelay && loadGlobalRegistry(process.env.TAP_INDEX_HOME).marker === "invalid") {
        throw new TapError(1, "invalid_flip", "tap doctor",
          "manual cross-worktree send refused — global-registry.json became invalid before place");
      }
      fenceTestBarrier("send-pre-publication");
      stage.preEffect = false; // placed mail is deliverable; a repeat would sit beside it
      placeCanonical();
      stage.placed = true;
      } catch (error) {
        // A positional payload whose own frontmatter is not valid UTF-8 is
        // refused, as the incumbent's awk refused to stamp it (partner review,
        // D1 F5): the header is text, only the body is bytes.
        if (error instanceof InvalidHeaderEncoding) {
          throw lockedPlaceFailed(`canonical_place: stamp failed for ${args.payloadFile || "the staged source"}: frontmatter is not valid UTF-8`, "fix command");
        }
        if (error instanceof Error && !(error instanceof TapError) && error.message.startsWith("canonical_place:")) {
          throw lockedPlaceFailed(error.message, "fix command");
        }
        throw error;
      }
      } finally { for (const lock of publicationLocks.reverse()) lock.release(); }
      markResetGenerationReused(ctx.bus.home, "send");
  } finally {
    obligationLock.release();
  }

  // Reset custody covers the placement above and each short bus mutation below,
  // never pane I/O (tap-0p7hx; register narrowed the same way). A reset
  // that starts during delivery is honored by the courier's per-stage fence
  // read, which refuses before the next keystroke.
  resetLock?.release();
  resetLock = null;
  fenceTestBarrier("send-post-placement");

  // The canonical is durable, so a custody refusal from here on is never an
  // exit-1 error: that would invite a duplicate re-send. The payload stays
  // where placement put it, and the outcome names its real fate (rc 5, like
  // an unverified submit: on the bus, delivery not confirmed).
  const placedNotDelivered = (refusal: CustodyRefusal | "pane_dead", detail: string, interrupt?: InterruptFact): SendOutcome => {
    const action = refusal === "team_reset_fenced"
      ? `a team reset holds this bus: the payload goes into its checkpoint and will not be delivered; after the reset, re-send only if tap outstanding ${from} no longer lists ${id}`
      : `the payload stays on the bus for ${to} to poll, with no automatic delivery; inspect with tap show ${id}; do not re-send while tap outstanding ${from} lists ${id}`;
    const fullDetail = `${detail}${noSpool ? "; --no-spool could not withdraw the placed payload" : ""}`;
    if (!opts?.quiet) {
      if (json) {
        process.stdout.write(`${jsonObj({
          status: "placed", delivery: "none", id, from, to, pane, kind, turn: "unconfirmed", path: canonPath,
          reason: refusal, action, detail: fullDetail,
        })}\n`);
      } else {
        process.stdout.write(`tap ${receiptVerb}: placed ${id}; not delivered\n`);
        process.stderr.write(`tap send: ${refusal}; ${fullDetail}; action: ${action}\n`);
      }
    }
    // An interrupt that already ran is part of the outcome (tap-pkh9c): a
    // placed-after-Escapes report must carry the fact or the caller will print
    // "no interrupt keys sent" over a pane that was just cleared.
    return { rc: 5, disposition: "placed", ...(interrupt ? { interrupt } : {}) };
  };
  // The send takes its own canonical (and, unless kept, `.placed`) back off the
  // bus, caller holding custody. The flag flips once the canonical is gone, so
  // the refusal that follows is counted as a withdrawal; a throw before that
  // leaves the payload and counts nothing.
  const withdrawPlacement = (withPlaced = true): void => {
    rmSync(canonPath, { force: true });
    stage.withdrawn = true;
    if (withPlaced) rmSync(ctx.bus.placedPath(id), { force: true });
  };
  // A pre-effect refusal withdraws the canonical (and `.placed`) under custody,
  // then refuses; if it cannot take custody, the payload stays and says so.
  const retract = (refusal: () => TapError, withPlaced = true): SendOutcome => {
    const done = withResetCustody(ctx.bus.home, "tap send", () => withdrawPlacement(withPlaced));
    if (!done.ok) return placedNotDelivered(done.refusal, done.detail);
    throw refusal();
  };
  // Post-effect records are evidence, not delivery: without custody they are
  // skipped with a warning and the observed outcome still stands.
  const recordAfterEffect = (what: string, body: () => void): void => {
    const done = withResetCustody(ctx.bus.home, "tap send", body);
    if (!done.ok) process.stderr.write(`tap send: warning: ${what} not recorded (${done.refusal}: ${done.detail}); the delivery outcome stands\n`);
  };

  // The departed-sender record (tap-4lrwv): the canonical was placed through
  // the ordinary path; under fresh reset custody it is archived under
  // cancel's convention and given cancel's terminal `.cancelled` receipt, so
  // provenance never claims the departed seat read it and the sender's
  // outstanding list carries no stranded entry. No delivery lane, no spool,
  // no pane effect, no `.placed`/`.sent` clock. Reply owns the caller-facing
  // receipt line; send stays quiet here.
  if (departed) {
    const recordDone = withResetCustody(ctx.bus.home, "tap send", () => {
      const archiveDir = join(ctx.bus.home, "archive");
      mkdirSync(archiveDir, { recursive: true });
      renameSync(canonPath, join(archiveDir, `${id}.cancelled.md`));
      writeCancelledReceipt(ctx.bus, {
        id, by: from, reason: "seat_unresolvable", target: to,
        target_status: "gone", registry_checked: "bound_team_registry", source: "payloads",
      });
    });
    if (!recordDone.ok) return placedNotDelivered(recordDone.refusal, recordDone.detail);
    return { rc: 0, disposition: "recorded-departed" };
  }

  interface ParkClass { policy?: string; timeout?: string; detail?: string; notice?: string; retainCanonical?: boolean }
  // Only the park's durable writes run under reset custody. The cue flash takes the pane
  // lock and the deliverer spawn forks, so both run after release, as the retire path
  // defers its wakes (tap-12ys6).
  // A failed park's fallback reads residency, so it decides under custody too: a reset
  // between release and that read could move the retained payload and turn a durable
  // send into a retry-inviting exit 1.
  const parkQueued = (reason: string, grace = "", cue = "", cueRedAt = "", cls: ParkClass = {}, interrupt?: InterruptFact): SendOutcome => {
    // A park after the courier ran can follow a fired interrupt (tap-pkh9c):
    // whatever internal path produced the outcome, the fact rides on it.
    const outcome = parkQueuedInner(reason, grace, cue, cueRedAt, cls);
    return interrupt && !outcome.interrupt ? { ...outcome, interrupt } : outcome;
  };
  const parkQueuedInner = (reason: string, grace = "", cue = "", cueRedAt = "", cls: ParkClass = {}): SendOutcome => {
    if (reason === "copy-mode" && urgent) cls = { ...cls, policy: "urgent" };
    const held = withResetCustody(ctx.bus.home, "tap send", () => parkQueuedLocked(reason, grace, cue, cueRedAt, cls));
    if (!held.ok) return placedNotDelivered(held.refusal, held.detail);
    if ("outcome" in held.value) return held.value.outcome;
    const { input, parked } = held.value;
    let report: ParkReport;
    try {
      // Register only after durable placement, before spawning the waiter. Never read scrollback as a draft.
      if (reason === "copy-mode") {
        const lock = acquirePaneLock(authorizedPaneId);
        if (lock) try {
          const observed = observePaneResult(authorizedPaneId);
          if (observed.status === "ok" && observed.observation.serverEpoch === authorizedEpoch) {
            updateInputProtection(observed.observation, { state: "unobservable", reason: "copy-mode" }, {
              urgent, sender: from, harness: authorizedHarness, message: { home: ctx.bus.home, id, sender: from },
            });
          }
        } finally { lock.release(); }
      }
      report = finishPark(input, parked);
    }
    catch (error) {
      parkFailed(error);
      const fallback = withResetCustody(ctx.bus.home, "tap send", parkFallback);
      return fallback.ok ? fallback.value : placedNotDelivered(fallback.refusal, fallback.detail);
    }
    return reportPark(report, input, reason, cls);
  };
  // A decided refusal (`spool_busy`, `spool_publish_failed`: the claim is released
  // and the canonical retained) reports as the adapter's `tap_fail` did on stderr;
  // any failure then takes parkFallback, exactly as a failed shell did.
  const parkFailed = (error: unknown): void => {
    const detail = String(error instanceof Error ? error.message : error).replace(/[\r\n]/g, " ");
    process.stderr.write(error instanceof ParkRefusal ? `tap send: ${detail}; next: inspect with tap show ${id}\n` : `tap send: ${detail}\n`);
  };
  const parkQueuedLocked = (reason: string, grace: string, cue: string, cueRedAt: string, cls: ParkClass): { outcome: SendOutcome } | { input: ParkReportInput; parked: Parked } => {
    const supervisorGrace = process.env.TAP_SEND_GRACE_SECONDS ?? "";
    // Same obligation key as the carve-out above (tap-7rpf0): a watcher probe
    // is grace-eligible when it carries no reply obligation, however spelled.
    if (from === WATCH_IDENTITY && !args.expectReply && kind === "probe" && supervisorGrace !== "" && !/[^0-9]/.test(supervisorGrace)) {
      grace = supervisorGrace;
    }
    const policy = cls.policy ?? "standard";
    const timeoutSeconds = cls.timeout ?? "";
    // `--no-spool` refuses a proven pre-effect defer and never creates an owner
    // (tap-send.sh:108-113): the canonical and its `.placed` go, the refusal
    // names the reason and the defer's own detail.
    if (noSpool) {
      withdrawPlacement();
      throw new TapError(1, "delivery_refused", "re-send when the recipient is ready",
        `--no-spool refused (${reason}); no message queued${cls.detail ? `; ${cls.detail}` : ""}`, "tap send");
    }
    // The unbound manual relay never parks (tap-send.sh:152-157): its target is
    // no registry seat, so no spool row could ever redeliver — the canonical
    // goes and the refusal says so. This is the ONE convergence point: the
    // readiness defers, polite parks, recovery holds and clear fences all land
    // here, so the guard covers every spool-write path at once.
    if (manualRelay) {
      withdrawPlacement();
      throw new TapError(1, "identity_unverified", "register the recipient in its TAP team, then address it as <team>/<handle>",
        "unbound manual relay cannot be parked for later delivery", "tap send");
    }
    // The park's whole route in process (spool-park-report.ts `parkAndReport`: the A1b
    // transaction, the cue, the deliverer spawn, the backlog, the injection facts) —
    // the same export lib.sh's `tap_spool_park_placed` adapts. Resolved pane/pane_id
    // are captured HERE, at park time, from this send's own resolution; redelivery
    // replays against this exact pane. The environment the Bash route carried
    // (TAP_HOME, TAP_LOCK_DIR) still reaches the deliverer child it spawns. The
    // class's policy and timeout (D3a: the polite pair) travel as the park's own.
    const input: ParkReportInput = {
      spoolDir: join(ctx.bus.home, "spool"), home: ctx.bus.home, id, canonical: canonPath, target: to, acting: ctx.team,
      reason, timeoutSeconds, pane, paneId: authorizedPaneId, toTeam: remote ? remote.team : "", targetRegistry: remote ? remote.registryPath : manualRelay ? "" : ctx.registryPath,
      policy, graceSeconds: grace, cueStyle: cue, cueRedAt, env: { ...process.env, TAP_LOCK_DIR: lockRoot(), TAP_HOME: ctx.bus.home },
      from, kind, replyExpect, scriptsDir, retainCanonical: cls.retainCanonical,
    };
    try { return { input, parked: parkPlaced(input) }; }
    catch (error) {
      parkFailed(error);
      return { outcome: cls.retainCanonical ? { rc: 5, disposition: "unverified" } : parkFallback() };
    }
  };
  // Runs under reset custody. A refusal after publication (the canonical could not be
  // retired) leaves the pair; it is reported exactly as a failed shell park was. (A
  // failed waiter spawn is the report's own `spawned: false` and renders in reportPark.)
  const parkFallback = (): SendOutcome => {
    fenceTestBarrier("send-park-fallback");
    process.stderr.write(`tap send: warning: parking '${id}' did not complete; inspect with tap show ${id}; automatic redelivery is not confirmed\n`);
    const spoolPath = join(ctx.bus.home, "spool", `${id}.md`);
    const metaPath = join(ctx.bus.home, "spool", `${id}.meta.json`);
    const regular = (path: string): boolean => {
      try { return statSync(path).isFile(); } catch { return false; }
    };
    if (regular(spoolPath) && regular(metaPath)) {
      if (!opts?.quiet) {
        process.stdout.write(json
          ? `${jsonObj({ status: "queued", delivery: "spool", id, from, to, pane, kind,
              turn: "unconfirmed", path: spoolPath, meta: metaPath,
              reason: "spool_park_failed", action: `tap show ${id}` })}\n`
          : process.env.TAP_VERBOSE === "1"
            ? `tap ${receiptVerb}: accepted, queued ${id} for ${to}; reply ${replyExpect}. Delivery not confirmed. Inspect with tap show ${id}.\n`
            : `tap ${receiptVerb}: queued ${id}\n`);
      }
      return { rc: 0, disposition: "queued-spool" };
    }
    if (regular(canonPath)) return emitQueued("spool_park_failed", `tap show ${id}`);
    throw new TapError(1, "spool_park_failed", `tap show ${id}`,
      "parking failed and no complete spool entry or canonical payload could be confirmed", "tap send");
  };
  const reportPark = (report: ParkReport, input: ParkReportInput, reason: string, cls: ParkClass): SendOutcome => {
    if (!opts?.quiet) {
      let displayState = "";
      if (!json && process.env.TAP_VERBOSE === "1") {
        displayState = readDisplayState(join(ctx.bus.home, "spool", `${id}.meta.json`), ctx.bus.home,
          Number(process.env.TAP_SPOOL_NOW || Math.floor(Date.now() / 1000)), input.env);
      }
      process.stdout.write(renderParkReceipt(report, { home: ctx.bus.home, id, from, to, pane, kind, replyExpect, reason,
        policy: input.policy, json, verbose: process.env.TAP_VERBOSE === "1", verb: receiptVerb, displayState, notice: cls.notice }));
    }
    return { rc: 0, disposition: "queued-spool" };
  };

  const emitQueued = (reason?: string, action?: string, extra = "", detail?: string): SendOutcome => {
    if (!opts?.quiet) {
      if (json) {
        process.stdout.write(`${jsonObj({
          status: "queued", delivery: "poll", id, from, to, pane, kind,
          turn: "unconfirmed", path: canonPath,
          ...(reason ? { reason } : {}),
          ...(action ? { action } : {}),
          ...(detail ? { detail } : {}),
        })}\n`);
      } else {
        // Keep recovery for a pre-effect delivery fallback visible by default.
        process.stdout.write(
          process.env.TAP_VERBOSE === "1" ? `tap ${receiptVerb}: accepted, queued ${id} for ${to}; reply ${replyExpect}${extra}\n` : `tap ${receiptVerb}: queued ${id}\n`,
        );
        if (action) process.stderr.write(`tap send: ${reason}${detail ? `; ${detail}` : ""}; action: ${action}\n`);
      }
    }
    return { rc: 0, disposition: "queued-poll" };
  };

  // The copy-mode defer that outlived the cancel (tap-send.sh:1635-1636):
  // the canonical is placed FIRST (above), then the typed reason spools —
  // the same place-then-defer order as the incumbent's other-rc arm.
  if (autoUrgent) {
    process.stderr.write("tap send: warning: auto_mode_no_interrupt: auto seat cannot be interrupted; queued as ordinary delivery\n");
    return parkQueued("auto_mode_no_interrupt");
  }
  if (copyModeRecoveryHeld) return parkQueued("recovery-hold", "", "", "", { detail: "recovery owns the recipient; delivery parked" });
  if (copyModeDefer) return parkQueued("copy-mode", "", "", "", { detail: copyModeDefer });

  if (pollRecipient) {
    recordAfterEffect("poll receipt", () => atomicWrite(ctx.bus.sentPath(id), `${jsonObj({
      id, from, to, pane, kind, turn: "unconfirmed", delivery: "poll",
    })}\n`));
    return emitQueued();
  }

  const dispositionFor = (band: DeliveryBand) => deliveryDisposition({
    band, harness: authorizedHarness, urgent: false, noSpool,
    // The manual relay's target binding is unbound (Bash TARGET_BINDING=0).
    recipientBound: !manualRelay,
  });
  const parkDisposition = (decision: ReturnType<typeof deliveryDisposition>, detail = "", interrupt?: InterruptFact) => parkQueued(
    decision.parkReason!, decision.graceSeconds === null ? "" : String(decision.graceSeconds),
    decision.cue.initialStyle ?? "", decision.cue.redAtSecondsBeforeDeadline === null ? "" : String(decision.cue.redAtSecondsBeforeDeadline),
    { detail, policy: urgent ? "urgent" : "standard" }, interrupt,
  );
  // Slash qualification is sentinel-only (tap-send.sh:1594-1612): a cross-team
  // sentinel names both teams, and carries `path=` exactly when the sender's
  // team does not resolve through the index (lib.sh:822-838). The manual
  // relay is the unindexed shape: the sender's team on the from, a bare
  // handle on the to, no sender-index question — so `path=` always rides.
  const sentinel = renderSentinel({
    from: remote ? `${ctx.team}/${from}` : manualRelay ? `${relayTeamName}/${from}` : from, to: remote ? `${remote.team}/${to}` : to,
    id, kind, reply: replyExpect, path: canonPath,
    urgency: urgent ? "urgent" : undefined, interrupt: urgent,
    senderIndex: remote ? senderIndexEvidence(ctx.team, process.env.TAP_INDEX_HOME) : undefined,
  });
  // The incumbent's post-placement sequence, in its order (tap-send.sh:1617
  // render → :1632 recovery guard → :1639 clear-fence inspection → :1661
  // polite park → :1666 submit): the render first, so an index that turns
  // invalid at render refuses on both doors before any park; recovery owns the
  // recipient before a clearing fence does (a hold parks `recovery-hold`,
  // under the polite pair when polite); the fence is read ONCE, here, and that
  // read alone decides — live parks, expired warns and continues (on the
  // submit path the courier's own read prints that warning), absent continues.
  // Then `--polite` parks before any disposition, copy-mode or band question.
  if (recoveryHold(authorizedPaneId || pane)) {
    return parkQueued("recovery-hold", "", "", "", { policy: retryablePolicy, timeout: retryableTimeout, detail: "recovery owns the recipient; delivery parked" });
  }
  const fenceBus = remote ? remote.busHome : ctx.bus.home;
  const fence = inspectClearFenceRecord(fenceBus, to);
  if (fence.state === "live" && urgent) {
    // The incumbent refuses urgent outright on a live fence: a human is
    // actively clearing, and interrupting them would be worse than waiting
    // (tap-send.sh:1714-1729 — the canonical goes, nothing is queued or typed).
    const rec = fence.rec ?? {};
    const pid = rec.pid === undefined || rec.pid === null || rec.pid === "" ? "unknown" : String(rec.pid);
    const since = rec.since_epoch === undefined || rec.since_epoch === null || rec.since_epoch === "" ? "unknown" : String(rec.since_epoch);
    return retract(() => new TapError(1, "recipient_clearing",
      `wait for '${to}' to finish clearing, then retry without --urgent`,
      `seat '${to}' is mid-clear (pid ${pid} since ${since})`, "tap send"), false);
  }
  if (fence.state === "live") return parkQueued("clearing", "", "", "", { detail: `seat '${to}' is mid-clear` });
  if (fence.state === "expired" && polite && noticeExpiredAtSendDoor(fenceBus, to, fence.rec)) {
    process.stderr.write(`tap send: WARNING: clear fence for ${to} expired; delivering anyway (fail-open past the family await ceiling)\n`);
  }
  if (polite) return parkQueued("polite", "", "", "", { policy: "polite", timeout: args.politeTimeout });
  // Review round 2 (critical 1): the rowless relay re-observes its pane
  // immediately before effect, as the incumbent's courier does
  // (tap_harness_evidence, lib.sh:7207). The proof's identity bind is
  // re-checked: an observed miss is pane gone (terminal, rc 3) and a flipped
  // command family is harness_exited drift (terminal, rc 1). A rowless relay
  // defers NOWHERE — no spool row could redeliver — so both clean the
  // canonical and refuse instead of queueing.
  if (manualRelay) {
    const relayObs = observePaneResult(pane, process.env);
    if (relayObs.status === "unobservable") {
      return retract(() => new TapError(1, "tmux_unreachable", "restore tmux observation, then retry", relayObs.reason));
    }
    if (relayObs.status === "pane_dead") return placedNotDelivered("pane_dead", `pane '${pane}' has exited; no pane effect was attempted`);
    if (relayObs.status === "pane_gone") {
      // The incumbent's rowless pane-gone refusal (measured bash bytes for
      // this scenario: tap_fail 3 pane_gone human_relay "pane '$PANE' gone").
      return retract(() => new TapError(3, "pane_gone", "human_relay", `pane '${pane}' gone`, "tap send"));
    }
    // Review round 5: the evidence re-check goes through the SAME record the
    // place-time guard uses, so the drift state in the incumbent's line is
    // the record's own verdict (harness_mismatch for an agent flip, not a
    // hardcoded exited).
    if (relayObs.status === "ok") {
      const drift = unboundPaneIdentityRecord(relaySession, pane, {
        paneId: authorizedPaneId, harness: authorizedHarness, families: [...agentFamilies],
      });
      if (drift.state !== "match") {
        process.stderr.write(`tap: rowless pane identity drifted before pane effect (${drift.state})\n`);
        return retract(() => new TapError(1, "identity_mismatch", "verify the exact tmux session and pane, then retry",
          "rowless recipient identity drifted before delivery", "tap send"));
      }
    }
  }
  // The manual relay's submit is bound to the RESOLVED pane identity only: no
  // registry row is named (handle empty — the courier's row re-read is
  // skipped) and no permissions registry is consulted, matching Bash
  // TARGET_BINDING=0 and its bypassed tap_recorded_permissions. The authority
  // keeps the sender's bus so fences and failure capture still work.
  // The courier records and discloses interrupts at the effect boundary;
  // passing the request here does not prove that its safety gates allowed it.
  const result = submitVerify(pane, id, queuePrefix + sentinel, manualRelay ? {
    paneId: authorizedPaneId,
    serverEpoch: authorizedEpoch,
    harness: authorizedHarness,
    bootId: "",
    handle: "",
    instance: "",
  } : {
    paneId: authorizedPaneId,
    serverEpoch: authorizedEpoch,
    harness: authorizedHarness,
    bootId: authorizedBoot,
    handle: to,
    instance: authorizedInstance,
  }, manualRelay ? {
    sender: from, scriptsDir, agentFamilies, busHome: ctx.bus.home, recipient: to, attemptAdmitted, registryPath: "",
    noPromptOk: authorizedHarness.startsWith("hermes"),
    deliveryFacts: { urgent, noSpool, recipientBound: false, harness: authorizedHarness },
  } : {
    sender: from, scriptsDir, agentFamilies, busHome: ctx.bus.home, recipientBusHome: remote?.busHome, recipient: to, attemptAdmitted,
    registryPath: remote ? remote.registryPath : ctx.registryPath,
    noPromptOk: authorizedHarness.startsWith("hermes"),
    deliveryFacts: { urgent, noSpool, recipientBound: true, harness: authorizedHarness },
  }, {
    ...DARK_EFFECTS,
    clobber: (target, command, bound, backup) => clobberBand(target, command, bound, DARK_EFFECTS, backup, ""),
  });

  if (result.interrupt) {
    const interrupt = result.interrupt;
    process.stderr.write(`tap send: interrupt ${interrupt.tmux_confirmed ? "input sent" : "input acceptance unconfirmed"} for ${id}; cancellation outcome unknown; inspect with tap show ${id}\n`);
    recordAfterEffect("urgent_interrupt registry event", () => appendRegistryEventOrWarn("tap send", {
      log: registryEventsPath(ctx.bus.home), actor: from, action: "urgent_interrupt", handle: to, pane,
      team: ctx.team, detail: ensureAscii(JSON.stringify({ id, ...interrupt })),
    }));
  }

  if (result.status === "band_busy" && result.cause === "pane_dead") return placedNotDelivered("pane_dead", result.detail, result.interrupt);
  if (result.status === "team_reset_fenced") {
    // The courier refused before any keystroke because a reset fence appeared
    // after placement. Withdrawing the canonical now would mutate the bus in
    // the middle of the reset's checkpoint (the tap-g191v shape), so it stays
    // and goes into the checkpoint; the sender is told it was not delivered.
    return placedNotDelivered("team_reset_fenced", result.detail, result.interrupt);
  }

  if (result.status === "recovery_held") {
    return parkQueued("recovery-hold", "", "", "", { policy: retryablePolicy, timeout: retryableTimeout, detail: "recovery owns the recipient; delivery parked" }, result.interrupt);
  }

  if (result.status === "clearing") {
    return parkQueued("clearing", "", "", "", { detail: `seat '${to}' is mid-clear` }, result.interrupt);
  }

  // A certified pre-effect refusal under `--no-spool` leaves nothing queued:
  // the incumbent's pre-submit identity recheck removes the canonical and
  // fails (tap-send.sh:1687-1695, `identity_mismatch`) whatever the class, and
  // the flag's contract is "no message queued". Measured for a pane_id drift
  // under the held submit lock; the pane-gone arm mirrors its pre-placement
  // refusal by reading (the fake cannot lose a pane between placement and the
  // band check — the row an earlier version dropped).
  const refuseUnqueued = (code: number, cls: string, action: string, detail: string): SendOutcome =>
    retract(() => new TapError(code, cls, action, detail, "tap send"));

  if (result.status === "attempt_evidence_unwritable") {
    const done = withResetCustody(ctx.bus.home, "tap send", () => {
      try { withdrawPlacement(); } catch (error) {
        // The receipt directory is already known unwritable; only a failure
        // after the canonical went (the flag is set) is that known case.
        if (!stage.withdrawn) throw error;
      }
    });
    if (!done.ok) return placedNotDelivered(done.refusal, done.detail, result.interrupt);
    throw new TapError(1, "attempt_evidence_unwritable", "tap doctor", result.detail, "tap send");
  }

  if (result.status === "identity_mismatch") {
    // Review round 2 (critical 1): a rowless relay never queues a certified
    // pre-effect mismatch — it has no spool row and no poller; the canonical
    // goes and the refusal is terminal (the incumbent's rowless convergence).
    if (manualRelay) {
      return retract(() => new TapError(1, "identity_mismatch", "verify the exact tmux session and pane, then retry",
        "rowless recipient identity drifted before delivery", "tap send"));
    }
    if (noSpool) return refuseUnqueued(1, "identity_mismatch", identityAction(`tap register ${to}   (the recorded pane is stale; re-register to rebind)`), result.detail);
    // Proven pre-effect: authorize refused before any keystroke. Canonical and
    // `.placed` stay so a poller who already saw the mail can still settle it.
    return emitQueued(
      "identity_mismatch",
      identityAction(`tap register ${to}   (the recorded pane is stale; re-register to rebind)`),
      result.detail ? `; ${result.detail}` : "",
      result.detail,
    );
  }

  if (result.status === "pane_gone") {
    // Rowless relay: pane gone is terminal, never queued (review round 2).
    if (manualRelay) {
      return retract(() => new TapError(3, "pane_gone", "human_relay", result.detail, "tap send"));
    }
    if (noSpool) return refuseUnqueued(3, "pane_gone", "human_relay", result.detail);
    // submitVerify reports pane_gone only from the pre-inject band check, so
    // this is certified pre-effect. Mid-paste disappearance is `unverified`.
    return emitQueued(
      "pane_gone",
      "human_relay",
      result.detail ? `; ${result.detail}` : "",
      result.detail,
    );
  }

  if (result.status === "lock_busy") {
    return parkQueued("lock-park", "", "", "", { detail: noSpool
      ? `tap: another submit holds pane '${pane}' (waited 5s) -> park` : result.detail });
  }

  if (result.status === "band_busy" && result.detail === CODEX_HOOK_TRUST_REASON) {
    return parkQueued("codex-hook-trust", "", "", "", { detail: result.detail, notice: result.detail });
  }
  if (result.status === "band_busy" || result.status === "rate_limited" || result.status === "copy_mode") {
    if (noSpool) {
      // The refusal names what the incumbent named: its pre-attempt copy-mode
      // sentence (tap-send.sh:1537), its driver's draft line for a band that
      // was READ as busy or queued under `tap_send_defer_reason`'s
      // `no-input-prompt` catch-all (lib.sh:11846, tap-send.sh:60-64),
      // OpenCode's `booting` hold for a composer it could not observe, its
      // rc-4 defer line for a band that was unobservable
      // for any reason other than unreadable geometry — a human decision on
      // screen (lib.sh:11279; the geometry-unreadable reasons never reach here,
      // the courier injected); every other hold (a rate-limited read, a
      // permission policy that would not read, an auto seat's band) keeps this
      // door's own sentence under the same catch-all.
      const [reason, detail] = result.status === "copy_mode" ? ["copy-mode", "pane is in copy mode or unreadable"]
        : result.status === "band_busy" && (result.bandState === "busy" || result.bandState === "queued") ? ["no-input-prompt", "tap: draft-preserving delivery refuses pending human input"]
        : result.status === "band_busy" && result.cause === "overprint" ? ["overprint", result.detail]
        : result.status === "band_busy" && result.bandState === "unobservable" && authorizedHarness.startsWith("opencode") ? ["booting", result.detail]
        : result.status === "band_busy" && result.bandState === "unobservable" ? ["no-input-prompt", `tap: pane '${pane}' has no visible input prompt -> defer`]
        : ["no-input-prompt", result.detail];
      return parkQueued(reason, "", "", "", { detail }, result.interrupt);
    }
    if (result.status === "copy_mode") return parkQueued("copy-mode", "", "", "", { policy: retryablePolicy, timeout: retryableTimeout, detail: result.detail }, result.interrupt);
    if (result.status === "band_busy" && result.disposition) return parkDisposition(result.disposition, result.detail, result.interrupt);
    // Urgent never parks through the ordinary disposition — its own
    // disposition row is an inject (no park reason to render). The incumbent's
    // rc-4 defer parks under the catch-all no-input-prompt reason and the
    // standard policy (lib.sh:11279, tap-send.sh:60-64), and its refusal
    // sentence rode STDERR next to the park — the park receipt renders the
    // canonical queue explanation, so the verbatim sentence goes here.
    if (urgent) {
      // tap-rdy9n: a stuck sentinel for another recipient suggests a stale or
      // rebound pane, so the park receipt names it rather than generic input.
      const team = remote ? remote.team : ctx.team;
      const stuck = result.status === "band_busy" && result.bandText ? parseStuckSentinel(result.bandText, authorizedHarness) : null;
      let stuckTo = "";
      if (stuck?.ok) {
        // A v0.23 wire carries no to=; its payload names the recipient.
        const slash = stuck.fields.id.indexOf("/");
        try {
          const idTeam = slash < 0 ? "" : stuck.fields.id.slice(0, slash);
          const named = sentinelPayloadRecipient({ wire: stuck.fields.wire, id: slash < 0 ? stuck.fields.id : stuck.fields.id.slice(slash + 1),
            idTeam, recipient: stuck.fields.to, payloads: join(ctx.bus.home, "payloads"), busHome: ctx.bus.home });
          // A bare pre-0.23 to= names the recipient's team (as nudge reads it);
          // a bare payload to: names the team whose bus holds the payload.
          const bareTeam = stuck.fields.wire === "pre023" ? team : idTeam || ctx.team;
          if (!named.unavailable && named.recipient) stuckTo = named.recipient.includes("/") ? named.recipient : `${bareTeam}/${named.recipient}`;
        } catch { /* an unresolvable sentinel keeps the generic park detail */ }
      }
      const notice = stuck?.ok && stuckTo && stuckTo !== `${team}/${to}`
        ? `parked behind a stuck TAP sentinel addressed to ${stuckTo} (id ${stuck.fields.id}), not ${team}/${to}; pane '${pane}' may be stale or rebound; no message was pasted and the draft was not cleared`
        : "";
      const detail = notice || result.detail;
      if (detail) process.stderr.write(`tap send: ${detail}\n`);
      return parkQueued("no-input-prompt", "", "", "", { detail, notice }, result.interrupt);
    }
    const band: DeliveryBand = result.status === "band_busy" && result.bandState === "queued" ? "queued"
      : result.status === "band_busy" && result.bandState === "busy"
        ? deliveryBand(result.bandText ?? "unsubmitted input", authorizedHarness, "") : "unobservable";
    return parkDisposition(dispositionFor(band), result.detail, result.interrupt);
  }

  if (result.status === "harness_queued") {
    recordAfterEffect("harness-queued receipt", () => recordHarnessQueued(ctx.bus.home, id));
    if (!opts?.quiet) process.stdout.write(harnessQueueMessage(ctx.bus.home,id,json));
    return { rc: 0, disposition: "queued-harness", ...(result.interrupt ? { interrupt: result.interrupt } : {}) };
  }
  if (result.status === "unverified") {
    if (result.reprobePending && !noSpool && !manualRelay) {
      return parkQueued("pending-input", "30", "", "", {
        policy: urgent ? "urgent" : retryablePolicy, timeout: retryableTimeout, detail: result.detail,
      }, result.interrupt);
    }
    // An unverified direct send keeps the rc 5 canonical and pending receipt.
    // Its separate spool copy lets the later drain use the one-shot, Enter-only
    // staged-idle authority; it does not turn this attempt into a queued success.
    if (!noSpool && !manualRelay && !urgent && result.cause !== "pane_dead" && result.cause !== "staged_absent"
      && stagedIdleEvidence(ctx.bus.home, id)) {
      const held = withResetCustody(ctx.bus.home, "tap send", () => parkQueuedLocked("staged-idle", "", "", "", {
        policy: retryablePolicy, timeout: String(stagedIdleWindowSeconds()), detail: result.detail, retainCanonical: true,
      }));
      if (held.ok && "input" in held.value) {
        try { finishPark(held.value.input, held.value.parked); }
        catch (error) { parkFailed(error); }
      }
    }
    // The canonical STAYS. No `.sent` is written — that is the whole point of
    // exit 5: the recipient may still poll it, and the sender can see that the
    // submit went unconfirmed rather than being told either lie.
    recordAfterEffect("submit-unverified event", () => appendSubmitUnverifiedEvent(ctx.bus.home, ctx.team, from, to, pane, id));
    if (!opts?.quiet) {
      const output = unverifiedSend(ctx.bus.home, id, from, to, canonPath, json,
        result.cause === "pane_dead" ? { cause: "pane_dead", detail: result.detail } : undefined);
      process.stdout.write(output.stdout); process.stderr.write(output.stderr);
    }
    // A post-interrupt unverified submit is possible (Escapes fired, verify
    // failed): the fact must survive on the rc-5 outcome (tap-pkh9c).
    return { rc: 5, disposition: "unverified", ...(result.interrupt ? { interrupt: result.interrupt } : {}) };
  }

  // `turn=unconfirmed` is UNCONDITIONAL and is never upgraded on this path. The
  // courier verified the id left the input band; no harness in the fleet exposes
  // a post-submit turn-boundary token, so nothing here may imply a turn began.
  // A missing `.sent` during a team reset does not mean "never injected".
  recordAfterEffect("delivery receipt", () => {
    atomicWrite(ctx.bus.sentPath(id), `${ensureAscii(JSON.stringify({
      id, from, to, pane, kind, turn: "unconfirmed", delivery: "pane",
      ...(result.interrupt ? { interrupt: result.interrupt } : {}),
    }))}\n`);
    // An empty registry is a no-op, not a fallback (lib.sh:1911-1916, ruling 43):
    // the manual unbound relay has no authoritative target registry and no clock
    // to stamp — the stamp is skipped outright, exactly as the empty-path call was.
    if (!manualRelay) deliveryClockStamp(remote ? remote.registryPath : ctx.registryPath, to);
  });

  if (!opts?.quiet) {
    if (json) {
      process.stdout.write(`${ensureAscii(JSON.stringify({
        status: "injected", delivery: "pane", id, from, to, pane, kind, turn: "unconfirmed", path: canonPath,
        ...(result.interrupt ? { interrupt: result.interrupt } : {}),
      }))}\n`);
    } else {
      process.stdout.write(
        process.env.TAP_VERBOSE === "1" ? `tap ${receiptVerb}: accepted, injected ${id} to ${to}; reply ${replyExpect}\n` : `tap ${receiptVerb}: ok ${id}\n`,
      );
    }
  }
  return { rc: 0, disposition: "delivered", ...(result.interrupt ? { interrupt: result.interrupt } : {}) };
  } finally {
    resetLock?.release();
  }
}

export { utcStamp };

function refuseReservedIdentity(handle: string, role: "to" | "from", busHome: string): void {
  if (handle === COURIER_IDENTITY) {
    throw new TapError(
      1,
      "reserved_handle",
      role === "to" ? "tap send <a-teammate> …" : "tap send <a-teammate> --from <your-handle>",
      role === "to"
        ? `'${COURIER_IDENTITY}' is the reserved courier digest-envelope identity and can never receive a send (digests are delivery envelopes, not seats). Address a real teammate instead.`
        : `'${COURIER_IDENTITY}' is the reserved courier digest-envelope identity and cannot be a --from sender`,
    );
  }
  if (handle === HELP_HANDLE) {
    throw new TapError(
      1,
      "reserved_handle",
      "tap send <a-teammate> …",
      `'${HELP_HANDLE}' is the CLI help keyword (so 'tap <verb> help' is unambiguous for every verb) and cannot be a ${role === "to" ? "send destination" : "--from sender"}`,
    );
  }
  if (handle === USER_IDENTITY) {
    throw new TapError(
      1,
      "reserved_handle",
      role === "to" ? "tap send <a-teammate> …" : "tap nudge <peer>   (a senderless doorbell; it records you as the actor)",
      role === "to"
        ? `'${USER_IDENTITY}' is the reserved operator identity and can never receive a send`
        : `'${USER_IDENTITY}' is the reserved operator identity: an audit actor in nudge recovery runs, never a sender`,
    );
  }
  if (handle === WATCH_IDENTITY) {
    if (role === "from") {
      // The watch sidecar cannot register, so its one lawful use — settle-only
      // mail (`--fyi` with --kind probe, notice or progress) — is decided with
      // the sender facts inside the lock: an eligible watcher send proceeds,
      // an ineligible one is refused there with the incumbent's
      // reserved-identity bytes (tap-send.sh:541-553).
      return;
    }
    throw new TapError(
      1,
      "reserved_handle",
      "tap send <a-teammate> …",
      `'${WATCH_IDENTITY}' is the reserved watcher identity and can never receive a send`,
    );
  }
}

function isTmuxPaneId(value: string): boolean {
  return /^%[0-9]+$/.test(value);
}

function ownSeat(seats: Record<string, unknown>, handle: string): Record<string, unknown> | null {
  if (!Object.hasOwn(seats, handle)) return null;
  const row = seats[handle];
  return typeof row === "object" && row !== null && !Array.isArray(row)
    ? row as Record<string, unknown>
    : null;
}

function deliverableLocal(seats: Record<string, unknown>, handle: string): boolean {
  const seat = ownSeat(seats, handle);
  if (!seat || String(seat.status ?? "active") !== "active") return false;
  // `tap_seat_deliverable` rejects a `launching` status_reason outright
  // (lib.sh:7337-7343); a launching row is not a deliverable target yet.
  if (String(seat.status_reason ?? "") === "launching") return false;
  const delivery = String(seat.delivery ?? "pane");
  // tap-zk1w: a pane row with no generation stamp cannot receive (send refuses it).
  return delivery === "poll" || (!!String(seat.pane ?? "") && !!String(seat.server_epoch ?? ""));
}

function autoReplyTo(
  from: string,
  fromSeat: Record<string, unknown>,
  seats: Record<string, unknown>,
  team: string,
  ctx: ReturnType<typeof resolveContext>,
): string | undefined {
  const stored = typeof fromSeat.reply_to === "string" ? fromSeat.reply_to : "";
  if (!stored) return undefined;
  if (stored === from) {
    selfReplyToWarning(stored);
    return undefined;
  }
  if (/[/:]/.test(stored)) {
    // send-reply-r2 checkpoint A (U1): the qualified stored form takes the
    // same deliverability port as an explicit stamp (tap-send.sh:582-613).
    // Scope resolves BEFORE the self test: a remote team naming the same
    // handle is a legitimate default and stamps; only an address that
    // resolves LOCAL to the sender is the self-pointing case.
    const answer = seatDeliverable(stored, ctx);
    if (answer.deliverable) {
      if (answer.local && answer.handle === from) {
        selfReplyToWarning(stored);
        return undefined;
      }
      return stored;
    }
    notDeliverableReplyToWarning(stored);
    return undefined;
  }
  if (deliverableLocal(seats, stored)) return `${team}/${stored}`;
  notDeliverableReplyToWarning(stored);
  return undefined;
}

function selfReplyToWarning(stored: string): void {
  process.stderr.write(
    `tap send: warning: this seat's registered reply_to '${stored}' points to itself — sending without it (register --reply-to <different-handle> to refresh it)\n`,
  );
}

function notDeliverableReplyToWarning(stored: string): void {
  process.stderr.write(
    `tap send: warning: this seat's registered reply_to '${stored}' is not currently deliverable — sending without it (register --reply-to <handle> to refresh it)\n`,
  );
}

interface DeliverableAnswer {
  deliverable: boolean;
  team: string;
  handle: string;
  /** How the address failed to resolve, when it did. */
  scope: "ok" | "unknown_team" | "other";
  detail: string;
  qualified: boolean;
  /** Whether the address resolves to the CALLER's own team — the scope the
   *  self-pointing tests key on, carried from the resolver itself. */
  local: boolean;
}

/**
 * `tap_seat_deliverable` (lib.sh:7307) over the native bind/row primitives
 * (send-reply-r2 checkpoint A, U1): resolve the address — bare means the
 * caller's own team, qualified binds through the machine index — then read one
 * seat row and report deliverability: active, not launching, and a poll member
 * or pane-backed, with the forwarding route applied as the incumbent's helper
 * does. The unresolvable index scopes answer not-deliverable and name their
 * scope, which is everything the explicit stamp's refusals need.
 */
function seatDeliverable(address: string, ctx: ReturnType<typeof resolveContext>): DeliverableAnswer {
  const slash = address.indexOf("/");
  if (slash !== -1) {
    const team = address.slice(0, slash);
    const handle = address.slice(slash + 1);
    if (team === ctx.team) return deliverableRow(ctx.registryPath, team, handle, true, ctx.team);
    let bound: RemoteTeam;
    try {
      bound = bindRemoteTeam(team, handle, process.env.TAP_INDEX_HOME);
    } catch (error) {
      if (!(error instanceof TapError) || isOldStoreRefusal(error)) throw error;
      if (error.errorClass === "unknown_team") {
        // The incumbent's explicit sentence reuses the bind detail's inner
        // clause: `--reply-to team 'T' is unknown (not in the machine index; …)`.
        const m = /^unknown team '([^']*)' \((.*)\)\. Fallback:/.exec(error.detail);
        return { deliverable: false, team, handle, scope: "unknown_team", detail: m ? m[2]! : error.detail, qualified: true, local: false };
      }
      return { deliverable: false, team, handle, scope: "other", detail: error.detail, qualified: true, local: false };
    }
    return deliverableRow(bound.registryPath, bound.team, handle, true, ctx.team);
  }
  return deliverableRow(ctx.registryPath, ctx.team, address, false, ctx.team);
}

function deliverableRow(registryPath: string, team: string, handle: string, qualified: boolean, ctxTeam: string): DeliverableAnswer {
  const local = !qualified || team === ctxTeam;
  try {
    const doc = loadRegistry(registryPath);
    // The forwarding route applies under the v20 marker (lib.sh:7345); a
    // refusal reads as not-deliverable, which the stamp sites map from here.
    const target = forwardingRoute(doc, handle).target;
    return { deliverable: deliverableLocal(seatMap(doc), target), team, handle, scope: "ok", detail: "", qualified, local };
  } catch {
    return { deliverable: false, team, handle, scope: "other", detail: `no registry at team '${team}' root`, qualified, local };
  }
}

/**
 * The explicit `--reply-to` stamp (send-reply-r2 checkpoint A, U1;
 * tap-send.sh:582-613): the caller names where the recipient's reply lands, so
 * every ambiguity is the caller's to fix — the refusals are hard and name the
 * scope, a deliverable address stamps `<team>/<handle>`, and only the
 * registry-DEFAULT form (autoReplyTo) falls back to a warning.
 */
export function explicitReplyToStamp(raw: string, from: string, ctx: ReturnType<typeof resolveContext>): string {
  let address = raw;
  if (raw.includes(":") && !raw.includes("/")) {
    const team = raw.slice(0, raw.indexOf(":"));
    const handle = raw.slice(raw.indexOf(":") + 1);
    if (!validToken(team) || !validToken(handle)) {
      throw new TapError(1, "usage_error", "tap help send", `--reply-to '${raw}' is not a valid <team>:<handle> token (${TOKEN_RE})`);
    }
    address = `${team}/${handle}`;
  }
  const answer = seatDeliverable(address, ctx);
  if (!answer.deliverable) {
    if (answer.scope === "unknown_team") {
      throw new TapError(1, "unknown_team", "tap help send",
        `--reply-to team '${answer.team}' is unknown (${answer.detail})`);
    }
    throw new TapError(1, "not_found", "tap help send",
      `--reply-to handle '${answer.handle}' is not a deliverable seat in team '${answer.team}' right now (must be an active pane member or active poll member)`);
  }
  if (answer.local && answer.handle === from) {
    throw new TapError(1, "usage_error", "tap help send",
      `--reply-to names where the recipient's tap reply lands; as sender '${from}', replies already return to you — omit --reply-to. Use it to route answers to another seat's inbox`);
  }
  return `${answer.team}/${answer.handle}`;
}

/** Only actual registry repairs take writer custody; never a read or pane probe. */
function repairRecipientRegistry(registryPath: string, root: string, busHome: string, handle: string,
  expected: Record<string, unknown>, change: (row: Record<string, unknown>) => void): "updated" | "busy" | "changed" {
  const reset = acquireResetMutationLock(busHome, "tap send registry repair", undefined, "shared");
  try {
    const lock = acquireRegistryLock(registryPath, RESET_HELD_LOCK_WAIT_MS);
    if (!lock) return "busy";
    try {
      if (!validateLockedRegistryAuthority(registryPath, root, process.env.TAP_INDEX_HOME).ok) return "changed";
      const doc = loadRegistry(registryPath);
      if (registryWriteRefusal(registryPath, doc)) return "changed";
      const row = ownSeat(seatMap(doc), handle);
      if (!row || !isDeepStrictEqual(row, expected)) return "changed";
      change(row);
      const sorter = (_key: string, value: unknown): unknown =>
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
          : value;
      atomicWrite(registryPath, `${JSON.stringify(doc, sorter, 2)}\n`);
      return "updated";
    } finally { lock.release(); }
  } finally { reset.release(); }
}

function markSuspendedLocked(registryPath: string, root: string, handle: string, busHome: string,
  expected: Record<string, unknown>): "updated" | "busy" | "changed" | "unobservable" {
  if (!serverEpochNow()) return "unobservable";
  return repairRecipientRegistry(registryPath, root, busHome, handle, expected, row => {
    row.status = "suspended";
    row.status_reason = "pane_gone";
    row.exited_at ||= new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  });
}

/**
 * The incumbent's unregistered_sender remedy (tap_unregistered_sender_next,
 * lib.sh:9558-9606): the detail names the pane's situation and the action is
 * pasteable. An empty bus with a live pane is the cwd diagnosis FIRST — both
 * identity answers are wrong there, and registering would split the seat's
 * identity across buses.
 */
function unregisteredSenderRefusal(from: string, seats: Record<string, Record<string, unknown>>, registryPath: string): TapError {
  const seen = callingPane();
  if (!seen || seen.status !== "ok") {
    return new TapError(1, "unregistered_sender", `tap register ${from} --delivery poll [--team <team>]`,
      `'${from}' is not an active sender on this team; pane-less daemons/scripts must register a stable poll seat, then pass --team on send when cwd is unanchored`);
  }
  const calling = seen.paneId;
  if (Object.keys(seats).length === 0 && !existsSync(registryPath)) {
    let team = "";
    try {
      const session = tmuxReadOnly(["display-message", "-p", "-t", calling, "#{session_name}"], process.env).stdout.trim();
      team = session.includes("/") ? session.slice(0, session.indexOf("/")) : "";
    } catch {
      team = "";
    }
    if (!team || team.includes("#")) team = "<team>";
    return new TapError(1, "unregistered_sender", `tap send <to> --from ${from} --team ${team}`,
      `no seats are registered on the bus this cwd resolves to, so this is almost certainly not the bus ${from} belongs to — every git worktree carries a .tap/ directory and is therefore an empty bus anchor. Pass --team <team> to name the bus, or run this from the team's worktree. Do NOT register here: it would bind this pane to the wrong bus while other seats keep writing to the right one`);
  }
  if (seats[from]) {
    return new TapError(1, "unregistered_sender", `tap in ${from}`,
      `'${from}' is not an active sender on this team and a registry row already holds that handle; naming the handle explicitly is what authorizes reclaiming it. If the registration reports it minted '${from}-2', the incumbent row is STILL holding the address other seats write to — 'tap in ${from} --force' reclaims it, and is only safe once you know the incumbent is not a live teammate. --delivery poll is for pane-less daemons and scripts: a poll seat with a pane receives nothing while reporting success`);
  }
  return new TapError(1, "unregistered_sender", `tap in ${from}`,
    `'${from}' is not an active sender on this team; this caller is in a live pane, so register from the pane itself. --delivery poll is for pane-less daemons and scripts, and a poll seat with a pane receives nothing while reporting success`);
}

/**
 * `tap_pane_harness_command` (lib.sh:8726): a shallow command that already
 * classifies as an agent or denylist family is trusted as-is; anything else
 * (a wrapper like `node`, a version string) is resolved through the pane's
 * process evidence, falling back to the shallow family when the observation
 * finds nothing.
 */
function relayHarnessFamily(
  command: string,
  panePid: string,
  agentFamilies: ReadonlySet<string>,
  scriptsDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const shallow = manualRelayFamily(command, agentFamilies);
  if (agentFamilies.has(shallow) || DENYLIST.includes(shallow) || !panePid) return shallow;
  const obs = observeHarnessPid(scriptsDir, agentFamilies, panePid, env);
  return obs.state === "observed" && obs.family ? obs.family : shallow;
}

/**
 * The relay pane's harness family, the courier's private classification
 * repeated here rather than exported: the family name is what submit evidence
 * binds, and a shell pane classifies to itself, which the courier's denylist
 * check refuses.
 */
function manualRelayFamily(command: string, agentFamilies: ReadonlySet<string>): string {
  const name = (command.split("/").pop() ?? command).toLowerCase();
  for (const fam of agentFamilies) {
    if (name === fam || name.startsWith(`${fam}-`)) return fam;
  }
  return name;
}

/**
 * The current tmux server epoch, `tap_server_epoch_now` (lib.sh:8082);
 * `serverEpochFromRaw` honours TAP_SERVER_EPOCH the same way, and an
 * unobservable server answers "" — which disables the heal, as Bash's
 * `|| true` empty answer did.
 */
function serverEpochNow(env: NodeJS.ProcessEnv = process.env): string {
  try {
    return serverEpochFromRaw(tmuxReadOnly(["display-message", "-p", "#{pid}:#{start_time}"], env).stdout.trim(), env);
  } catch {
    return "";
  }
}

/**
 * The pane-drift heal's one row rewrite (send-reply-r2 checkpoint A, U2;
 * tap-send.sh:904-970). Only its compare-and-write takes registry custody. An
 * epoch-stale row is never resolved (a recycled pane id would write the wrong
 * address); the resolved address must differ from the stored shape; the
 * rewrite is best-effort and sorted-key, as the incumbent's Python heredoc
 * wrote. The caller is told the new address so the send continues with it.
 */
function healIdShapedPane(registryPath: string, root: string, handle: string, idPane: string, paneId: string, storedEpoch: string, busHome: string, expected: Record<string, unknown>): string {
  const now = serverEpochNow();
  if (storedEpoch && now && storedEpoch !== now) {
    process.stderr.write(`tap send: refusing id-shaped pane heal for ${handle} — pane_id epoch-stale (stored ${storedEpoch} ≠ now ${now})\n`);
    return "";
  }
  let address = "";
  try {
    address = paneAddress(paneId).trim();
  } catch {
    address = "";
  }
  if (!address || !address.includes(":") || address === idPane) return "";
  try {
    if (repairRecipientRegistry(registryPath, root, busHome, handle, expected, row => { row.pane = address; }) !== "updated") return "";
  } catch { return ""; }
  process.stderr.write(`tap send: healed id-shaped pane field for ${handle} → ${address}\n`);
  return address;
}

/**
 * Direct send's submit-unverified moment, matching Bash tap-send.sh:
 * `tap_registry_event_append_or_warn "$FROM" send_submit_unverified "$TO" "$PANE" "id=$ID"`.
 * The warning is the whole failure report — rc 5 is already earned and does not
 * change either way.
 */
function appendSubmitUnverifiedEvent(
  busHome: string,
  team: string,
  from: string,
  to: string,
  pane: string,
  id: string,
): void {
  appendRegistryEventOrWarn("tap send", {
    log: registryEventsPath(busHome),
    actor: from, action: "send_submit_unverified", handle: to, pane, team,
    detail: `id=${id}`,
  });
}

export function resolveConfiguredDriver(family: string, env: NodeJS.ProcessEnv = process.env): { ok: true; driver: string } | { ok: false } {
  if (env.TAP_DRIVER_FORCE_TMUX === "1" || !family) return { ok: true, driver: "tmux" };
  const refuse = (detail: string): { ok: false } => {
    process.stderr.write("tap: " + detail + "\n");
    return { ok: false };
  };
  const path = driverConfigPath(env);
  if (!path) return refuse('XDG_CONFIG_HOME is relative or unusable ("' + (env.XDG_CONFIG_HOME ?? "") + '"); the launcher\'s contract is an absolute config home, and a cwd-relative one would let the working directory choose the delivery door. Refusing.');
  const unusable = () => refuse(path + " is unusable (insecure source, malformed TOML, or a non-string driver value); refusing rather than silently selecting tmux");
  try {
    try {
      if (lstatSync(path).isSymbolicLink() && !existsSync(path)) {
        return refuse(path + " is a dangling symlink; refusing rather than silently selecting tmux for a config that is present but unreadable");
      }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, driver: "tmux" };
      throw error;
    }
    const doc = parseToml(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readSecureBytes(path).bytes));
    const isTable = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
    const table = doc.harness, harness = isTable(table) ? table[family] : null;
    if (!isTable(harness) || !Object.hasOwn(harness, "driver")) return { ok: true, driver: "tmux" };
    const driver = harness.driver;
    if (typeof driver !== "string" || /[\x00-\x1f\x7f]/.test(driver)) return unusable();
    const key = '[harness.' + family + '] driver = "' + driver + '" in ' + path;
    if (driver === "") return refuse(key + " names no driver; remove the key to use tmux");
    if (!/^[a-z][a-z0-9_]*$/.test(driver)) return refuse(key + " is not a legal driver name");
    if (driver !== "tmux") return refuse(key + " names no WIRED driver; remove the driver key or set it to tmux");
    return { ok: true, driver };
  } catch { return unusable(); }
}
