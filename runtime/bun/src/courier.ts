import { OPENCODE_SHELL_MODE_REASON } from "./opencode-composer";
import { parseStuckSentinel } from "./stuck-sentinel";
import { corroborateExistingSentinel } from "./existing-sentinel";
import { recordHarnessQueued } from "./harness-queue";
import { recordedPermissions } from "./delivery-permissions";
import { recoverAgySurvey, SURVEY_EFFECTS, type SurveyEffects } from "./agy-survey";
import { recoveryHold } from "./recovery/state";
import { randomUUID } from "node:crypto";
import { pendingReprobe, recordPhase, type SubmitPhase, type PhaseRecorder, type InterruptDetails, type InterruptFact } from "./submit-phase";
import { inputHash, writeInputBackup } from "./pane/draft";
import { deliveryBand, deliveryDisposition, type DeliveryFacts, type DeliveryDisposition } from "./slices/delivery-disposition";
import { captureCourierFailure } from "./debug-capture";
import { beginDeliveryAttempts } from "./delivery-attempt";
import { codexUpdateDismissed, codexUpdatePrompt, codexUpdateSkipReceipt } from "./codex-update";
import { appendRegistryEventOrWarn } from "./events";
// The courier: place the canonical, then submit-verify the sentinel into a real
// pane.
//
// TWO INVARIANTS THIS FILE EXISTS TO HOLD.
//
// 1. FAILED-SEND ATOMICITY. A caller must never see a terminal refusal while an
//    untracked payload from that send is outstanding. So: the pane check runs
//    BEFORE the canonical is placed (exit 3 leaves nothing), and stamping or
//    validation failure removes the staging file (exit 1 leaves nothing).
//
// 2. THE RECEIPT NEVER CLAIMS MORE THAN THE INSTRUMENT SAW. Submit-verify proves
//    the minted id left the input band. It does NOT prove a turn began — no
//    harness in the fleet exposes a post-submit turn-boundary token — so every
//    exit-0 send is stamped `turn=unconfirmed`, always, on every path.

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Bus } from "./bus";
import { stampEnvelope, stampEnvelopeBytes, validateEnvelope, type Routing } from "./envelope";
import { atomicWrite, jsonObj, stagingPath } from "./fsatomic";
import { renderSentinel } from "./sentinel";
import { acquireObligationLock, acquirePaneLock } from "./panelock";
import { nativeClaudeCommand, observeProcessHarness, readProcessTable } from "./observe";
import { APPROVAL_PROMPT_REASON, CLAUDE_FEEDBACK_DRAFT_REASON, CLAUDE_SCROLLED_DRAFT_REASON, observeCopyMode, observeInputId, paneState, claudeFeedbackOverlay, isPasteCollapse, type CopyModeObservation, type InputObservation, type PaneBand } from "./pane-state";
import { repaintPane, type RepaintGate, type RepaintResult } from "./pane/repaint";
import { overprintRepaintGate, overprintRetryDue, readOverprintRecord, retireOverprintRecord } from "./overprint-marker";
import { approvalPrompt, codexHookTrust, CODEX_HOOK_TRUST_REASON } from "./agent-state";
import { queuePrefix } from "./stuck-sentinel";
import { bootId, bootIdsMatch, capturePane, injectText, inputHasId, normalizeInputMatch, observePaneResult, pressEnter, pressKeys, ServerUnresponsive, settle, tmuxReadOnly, type PaneObservation } from "./tmux";
import { controlChunkLanded, controlPayloadChunks, controlTailReady } from "./slices/control-payload";
import { captureInputFrame, pendingInputRegionText, pendingInputText, realPaneIo, type PendingInput } from "./pane/reader";
import { composerHoldsExactly, observeSubmitFrame, agyPermissionOverlay, agyReprobeInputMatches, isOrdinarySentinel, readFrame, sentinelSubmitDecision, visibleSentinelId, type SubmitFrame } from "./submit-frame";
import { agentAtRest, detectAgentState, type AgentState } from "./agent-state";
import { stagedIdleSubmitEligible } from "./submit-phase";
import { beginIdleSubmit } from "./delivery-attempt";
import { closedSentinelInput, sentinelShapedInput } from "./sentinel-tail";
import { CLOBBER_BLINK, flashPaneLocked, notifyDraftBackedUp } from "./spool-park-report";
import { emitWaitCue } from "./wait-cues";
import type { ClobberBackupReq, ClobberVerdict } from "./deliver";
import { updateInputProtection, inputProtectionHeld, protectionUntil, protectionDetail, claimStartClear, completeStartClear, composerControlWord, type InputProtection } from "./input-protection";
import { injectionBehavior } from "./injection-behavior";
import { hasInputText } from "./terminal-text";
import { BLANK_DRAFT_NOTICE, inputBackupBody, inputBackupIncomplete, restorePlainDraft, INCOMPLETE_DRAFT_NOTICE } from "./input-backup";
import { utcStamp } from "./ids";
import { loadRegistry, seatMap, loadCurrentRegistry } from "./registry";
import { OldStoreError } from "./register-authority";
import { resetFenceRefusal } from "./reset";
import { DENYLIST } from "./harness-families";
import { noticeExpiredAtSendDoor, readClearFence, type ClearFenceRead, type ClearFenceState } from "./clear-fence";

/**
 * Stamp into a private staging file on the SAME filesystem as payloads/, validate
 * the staged envelope, then rename into place. A half-written, zero-byte, or
 * validation-failed payload never appears in payloads/.
 */
export function canonicalPlace(bus: Bus, src: string, routing: Routing): void {
  const lock = acquireObligationLock(routing.id);
  if (!lock) {
    throw new Error(`canonical_place: obligation '${routing.id}' is busy; refusing to place without exclusive eligibility`);
  }
  try {
    canonicalPlaceLocked(bus, src, routing);
  } finally {
    lock.release();
  }
}

export function canonicalPlaceLocked(bus: Bus, src: string | Buffer, routing: Routing): void {
  const dest = bus.payloadPath(routing.id);
  if (existsSync(dest)) throw new Error(`canonical_place: refusing duplicate id '${routing.id}' (payload already exists)`);
  // Placement owns an occupied-slot (`-e`) guard, broader than Bus.isDone's
  // settlement predicate (`-f`). A directory is not settlement, but it still
  // cannot license reuse of the same receipt address. The archive index is not
  // consulted: minted ids carry a stamp and random suffix, deterministic notice
  // ids check archived history themselves, and reuse is otherwise deliberate.
  if (existsSync(bus.donePath(routing.id)) || existsSync(bus.cancelPath(routing.id))) {
    throw new Error(`canonical_place: refusing duplicate id '${routing.id}' (receipt already settled)`);
  }

  mkdirSync(bus.stagingDir, { recursive: true });
  const staging = stagingPath(bus.stagingDir);
  try {
    // A byte source (D1's staged body) keeps its body bytes verbatim; only the
    // header is text, and it is the header TEXT the stamp built that is
    // validated — validateEnvelope reads nothing past the closing fence, and a
    // lossy decode of the body would make the verdict about bytes never written.
    let stamped: string | Buffer;
    let validated: string;
    if (typeof src === "string") { stamped = stampEnvelope(src, routing); validated = stamped; }
    else { const out = stampEnvelopeBytes(src, routing); stamped = out.bytes; validated = out.header; }
    writeFileSync(staging, stamped, { mode: 0o600 });
    const v = validateEnvelope(validated);
    if (!v.ok) throw new Error(`canonical_place: envelope invalid after stamp: ${v.reason}`);
    renameSync(staging, dest);
  } catch (e) {
    rmSync(staging, { force: true });
    throw e;
  }
  writePlaced(bus, routing.id);
}

/**
 * Place-time courier attribution, written on EVERY successful rename — including
 * the submit-unverified paths that deliberately never reach `.sent`. This is the
 * authority for "this file is courier mail"; `.sent` is telemetry.
 */
export function writePlaced(bus: Bus, id: string): void {
  try {
    atomicWrite(bus.placedPath(id), `${jsonObj({ id, via: "courier", at: utcStamp() })}\n`);
  } catch {
    // Non-fatal: the payload is already on the bus. Poll LABELS an unattributed
    // payload rather than hiding it, so a missing receipt degrades to a warning
    // instead of losing mail.
    process.stderr.write(`tap: warning: placed receipt not written for ${id} (payload is on the bus; poll will label unattributed)\n`);
  }
}

export type SubmitResult = (
  | { status: "injected" }
  | { status: "harness_queued" }
  /** A recovery effect was ready, but its required attempt receipt could not be admitted. */
  | { status: "attempt_evidence_unwritable"; detail: string }
  | { status: "pane_gone"; detail: string }
  | { status: "unverified"; detail: string; reprobePending?: boolean; cause?: "pane_dead" | "overprint" | "shell-mode" | "feedback-draft" | "staged_absent" }
  /** The per-socket client budget was exhausted before a pane effect. */
  | { status: "rate_limited"; detail: string }
  /** No sentinel was injected. A bounded survey Skip may precede this hold. */
  | { status: "band_busy"; cause?: "pane_dead" | "overprint" | "shell-mode" | "feedback-draft"; bandState?: "busy" | "queued" | "unobservable"; bandText?: string; disposition?: DeliveryDisposition; detail: string }
  /** `#{pane_in_mode}=1`. NO pane effect. Send queued/polls; owner uses observePaneKind. */
  | { status: "copy_mode"; cause: "copy-mode"; detail: string }
  /** Another submit holds this pane. NO pane effect was taken. */
  | { status: "lock_busy"; detail: string }
  | { status: "recovery_held"; detail: string }
  /** The live pane is not the seat we were addressing. NO pane effect taken. */
  | { status: "identity_mismatch"; detail: string }
  /** Reset fence appeared after placement. NO pane effect taken. */
  | { status: "team_reset_fenced"; detail: string; action: string }
  /** Clear fence appeared after placement. NO pane effect taken; canonical stays. */
  | { status: "clearing"; detail: string }
) & {
  /** Pre-Enter busy evidence from the submit's first frame read, threaded so the
   * completion-Enter path can apply the same fast-start relabel (tap-ho6pk). */
  preBusy?: boolean;
  interrupt?: InterruptFact
};

/**
 * The family's U4 interrupt (tap-pkh9c): what urgent delivery sends before the
 * paste, and the only thing an interrupt preview may promise. One table, two
 * readers — the courier's keystroke path and the `tap nudge --interrupt`
 * dry-run preview — so a preview can never promise keys the courier will not send.
 */
export function interruptKeysForFamily(fam: string): { method: "keys" | "bare-submit"; keys: string[] } {
  const seq = fam === "opencode" ? ["Escape", "Escape"]
    : fam === "cursor" ? ["C-c"]
    : fam === "hermes" ? []
    : ["Escape"];
  return { method: fam === "hermes" ? "bare-submit" : "keys", keys: seq };
}

/**
 * Inject the sentinel and verify the minted id leaves the input band.
 *
 * Enter is attempted once. If the TUI swallows it while committing a paste,
 * read-back returns unverified; a possible effect is never retried.
 *
 * Failure is reported as UNVERIFIED, never as failure-to-deliver: the canonical
 * stays on the bus and the recipient may still poll it.
 */
/**
 * The identity a submit is authorized against.
 *
 * Carried INTO the locked path rather than checked once before it. The lock can
 * wait five seconds, and a pane address is positional: within that window a
 * session can be replaced and the same address can name a DIFFERENT pane.
 * Reproduced — hold the lock, swap %1 for %2 at the same address, release: the
 * sentinel went to %2 and the send exited 0.
 */
export interface BoundRecipient {
  paneId: string;
  serverEpoch: string;
  harness: string;
  /** Registered `boot_id`. Empty skips the axis, matching Bash. */
  bootId?: string;
  /** Recipient handle captured before placement. Absent skips the row reread. */
  handle?: string;
  /** Recipient instance captured before placement. */
  instance?: string;
}

export type BoundBootRefusal = {
  reason: "boot_id_stale" | "boot_id_unobservable";
  detail: string;
};

/**
 * Bash polarity for a registered boot stamp: skip when the row has none;
 * fail closed when the current boot is unreadable or cannot be related;
 * `boot_id_stale` when the boots positively differ. Reuses `bootId` /
 * `bootIdsMatch` — no second oracle.
 */
export function boundBootRefusal(
  rowBoot: string,
  when: "delivery" | "submit" = "delivery",
  env: NodeJS.ProcessEnv = process.env,
): BoundBootRefusal | null {
  if (!rowBoot) return null;
  const now = bootId(env);
  if (!now) {
    return {
      reason: "boot_id_unobservable",
      detail: `bound recipient identity drifted before ${when} (boot_id_unobservable): stored boot_id cannot be attested because the current boot session is unreadable`,
    };
  }
  const relation = bootIdsMatch(rowBoot, now, env);
  if (relation === "match") return null;
  if (relation === "unknown") {
    return {
      reason: "boot_id_unobservable",
      detail: `bound recipient identity drifted before ${when} (boot_id_unobservable): stored boot_id cannot be related to the current boot session`,
    };
  }
  return {
    reason: "boot_id_stale",
    detail: `bound recipient identity drifted before ${when} (boot_id_stale): stored boot_id does not attest the current boot session`,
  };
}

export type HarnessEvidenceClass = "alive" | "mismatch" | "exited" | "unattested" | "unobservable";

export type SubmitAuthority = {
  sender?: string;
  draftGraceSatisfied?: boolean;
  /** This invocation already admitted its first effect (copy-mode cancellation). */
  attemptAdmitted?: boolean;
  /** Every payload whose possible first effect this invocation owns. */
  attemptIds?: readonly string[];
  /**
   * A same-id retry's own one-shot license (retry.ts `beginRetryAttempt`), minted
   * INSTEAD of `<id>.attempted`, which already exists and is never cleared or
   * reused. `attemptMarker` is its path for the prior-attempt check;
   * `attemptUuid` carries the retry's uuid into the submit-phase rows.
   */
  attemptLicense?: (beforeCreate?: () => boolean) => "created" | "existing" | "refused";
  attemptMarker?: string;
  attemptUuid?: string;
  /** A drain may back up human drafts; ordinary callers preserve them. */
  preserveDraft?: boolean;
  /** Only unreadable composer geometry is eligible, never positive safety holds. */
  forceNoPrompt?: boolean;
  /** Continue an evidenced zero-Enter transition without typing again. */
  reprobeOnly?: boolean;
  /** The drain's explicit event destination, retained when corroborating staged input. */
  eventContext?: { actor: string; log: string; team: string; verb: string };
  /** Send policy consumes the same authorized band sample as the verifier. */
  deliveryFacts?: Omit<DeliveryFacts, "band">;
  scriptsDir: string;
  agentFamilies: ReadonlySet<string>;
  /** When set, recheck reset/clear fences after authorize and before inject. */
  busHome?: string;
  /**
   * A cross-team recipient's own bus (D2): its clear fence lives there, and its
   * reset fence is checked beside the sender's. Unset means one bus.
   */
  recipientBusHome?: string;
  recipient?: string;
  /** Acting registry reread at every point-of-effect authorize. */
  registryPath: string;
  /** Reset callers bind the pre-effect conversation; the post-Enter check keeps seat identity only. */
  expectedNativeSession?: string;
  /** Reset controls submit once; a still-staged command is not permission to repeat Enter. */
  singleEnter?: boolean;
  /**
   * The idle-time staged-sentinel submit (tap-9lqa7): Enter-only by
   * construction. When set, the submit body presses Enter at most once on a
   * composer positively observed idle holding exactly one well-formed TAP
   * sentinel and nothing else; it never injects, never clobbers, never
   * interrupts, never rides the scrolled-tail arm, and returns immediately
   * after that one Enter. Admission is the separate link-atomic
   * `receipts/<id>.idle-submit` license (never the `.attempted` door), minted
   * under this pane lock after the final authorize and the two-sample check,
   * immediately before the key.
   */
  idleStaged?: boolean;
  /**
   * The caller's environment (the drain passes its ctx env; the direct send
   * defaults to process.env). The idle arm's eligibility re-check reads the
   * spool clock (TAP_SPOOL_NOW) through it so the arm and the dispatch agree
   * on the staged-idle window.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * A slash-command token (`/goal `, `/compact `, `/loop `) typed as its own
   * keystrokes before the payload (tap-lmbs), so the harness commits it as a
   * command before any paste chip can form. Exactly one trailing space. The
   * payload is then written in small chunks and must render in full: a paste
   * chip is a refusal, never landing evidence. Refused before any effect when
   * combined with `noPromptOk`, `singleEnter` or an urgent send.
   */
  typedPrefix?: string;
  /**
   * The queue-prefix harness (lib.sh:10871 `no_prompt_ok="$qprefix"`): a
   * hermes pane is injectable with no visible idle prompt — the bare prefix
   * IS the handoff — so the rc-3 no-input-prompt defer never applies.
   * Positive holds (a busy band, gone, rate-limited) still hold.
   */
  noPromptOk?: boolean;
};

/**
 * The pane effects, injectable.
 *
 * This seam exists so the replacement race can be tested DETERMINISTICALLY. The
 * defect is "a pane is replaced between two tmux processes", and reproducing
 * that against a real server means hitting a sub-second window — a flake
 * generator, and the reason an earlier attempt asserted SOURCE SHAPE instead.
 * The partner reviewer rejected that correctly: a regex over the source passes if
 * authorize always returns null, or validates the wrong identity, or the helper
 * targets the wrong pane. It proves the code was written, not that it works.
 *
 * With the seam, a test drives the replacement between effects and asserts what
 * the replacement RECEIVED, which is the actual property.
 */
export interface PaneEffects extends SurveyEffects {
  observePane: (target: string) => PaneObservation | null | "rate_limited" | "unobservable" | "pane_dead";
  injectText: typeof injectText;
  inputHasId: typeof inputHasId;
  pressEnter: typeof pressEnter;
  /** The interrupt sequence (U4). Optional only so pre-U4 fakes keep type-checking. */
  pressKeys?: typeof pressKeys;
  clobber?: (target: string, command: string, bound: BoundRecipient | undefined, backup: ClobberBackupReq, beforeEffect?: () => boolean) => ClobberVerdict;
  restoreInput?: (target: string, text: string) => boolean | "rate_limited";
  protectInput?: typeof updateInputProtection;
  inputHeld?: typeof inputProtectionHeld;
  /** Injected clock: the fakes advance time without spending it. */
  settle: (seconds: number) => void;
  /** Injected evidence seam for state-machine tests. Production uses observeHarnessPid. */
  harnessEvidence?: (obs: PaneObservation, expected: string) => HarnessEvidenceClass;
  /** Required typed pre-inject band: the six-state pane-state reader. */
  paneState: (target: string, harness: string, command: string) => PaneBand;
  /**
   * tap-vctb8: one SIGWINCH repaint before any key, never input itself.
   * Optional so pre-U4 fakes keep type-checking; the overprint branch needs
   * `captureEscaped` too, so a repaint without the capture seam keeps the
   * effect-free repark.
   */
  repaint?: (target: string, gate?: RepaintGate) => RepaintResult;
  /** The escaped, unjoined frame — the same bytes the readiness walk hashes
   * (`captureInputFrame` escaped). The overprint branch compares and records
   * the marker against what the next observer will actually see. */
  captureEscaped?: (target: string, command: string) => { ok: true; frame: string } | { ok: false };
  /** `#{pane_title}` (tap-8nmot): the idle staged submit refuses unless the
   * title reads — an absent title is never treated as an empty one. */
  paneTitle?: (target: string) => { ok: true; title: string } | { ok: false };
  /** Budgeted `#{pane_in_mode}` peek. Production returns typed copy_mode; send queued/polls. */
  copyMode?: (target: string) => CopyModeObservation;
  /** Typed land/clear. Absent on unit3-lock fakes; those keep boolean inputHasId.
   * `scrolledControl` (tap-vho8h) is the typed-prefix /compact arm's opt-in: a
   * Claude composer whose command row scrolled out of the viewport may prove
   * `staged` from the visible wrapped suffix ending in the marker. */
  submitFrame?: (target: string, command: string, expected: string, harnessAlive?: boolean, soleContent?: boolean, scrolledControl?: boolean) => SubmitFrame;
  observeInput?: (target: string, command: string, id: string) => InputObservation;
  /** The composer's prompt line (`tap_pending_input_text`). Required by `typedPrefix`. */
  promptInput?: (target: string, command: string) => PendingInput;
  /** The composer's typed rows (`tap_pending_input_region_text`). Required by `typedPrefix`. */
  regionInput?: (target: string, command: string) => PendingInput;
  /**
   * Take back our own typed control when it was never submitted: C-u only
   * while the band is still ours (deliver.ts `clearOwnInjection`). Supplied by
   * the caller, which owns the clear effects; absent means the input stays.
   * `permit` is the courier's fresh owner and fence check: every key the
   * take-back sends must pass it first, as every other submit effect does.
   */
  takeBack?: (target: string, command: string, bound: BoundRecipient | undefined, id: string, wire: string, permit: () => boolean) => string;
}

/** Production pane seam. Dark `deliver()` wraps this object rather than relocating submit-verify. */
export const REAL_EFFECTS: PaneEffects = {
  ...SURVEY_EFFECTS,
  protectInput: updateInputProtection, inputHeld: inputProtectionHeld,
  observePane: (target) => {
    const result = observePaneResult(target);
    return result.status === "ok" ? result.observation : result.status === "pane_gone" ? null : result.status;
  },
  injectText, inputHasId, pressEnter, pressKeys, settle,
  paneState,
  repaint: (target, gate) => repaintPane(target, undefined, gate),
  captureEscaped: (target, command) => captureInputFrame(realPaneIo, target, command, true),
  paneTitle: (target) => {
    const r = tmuxReadOnly(["display-message", "-p", "-t", target, "#{pane_title}"]);
    return r.code === 0 ? { ok: true, title: r.stdout.trim() } : { ok: false };
  },
  copyMode: observeCopyMode,
  observeInput: observeInputId,
  submitFrame: observeSubmitFrame,
  promptInput: (target, command) => pendingInputText(realPaneIo, target, command),
  regionInput: (target, command) => pendingInputRegionText(realPaneIo, target, command),
};

function familyOf(command: string, families: ReadonlySet<string>): string {
  if (families.has("claude") && nativeClaudeCommand(command)) return "claude";
  const name = (command.split("/").pop() ?? command).toLowerCase();
  for (const fam of families) {
    if (name === fam || name.startsWith(`${fam}-`)) return fam;
  }
  return name;
}

/**
 * Is the harness rooted at `panePid` observable, and as which family.
 *
 * This used to spawn a child process on the script that became this module
 * and parse a US-separated line back. The observation is now this process's:
 * one `ps` table, `observeProcessHarness` from the shared module. Two things
 * went with the child, and both are deliberate:
 *
 * - The wire is gone, so `parseHarnessPidStdout` is gone with it. A malformed
 *   record is no longer a reachable state — the engine returns a typed answer
 *   or nothing. Its framing arm in `unit3-lock.test.ts` went too; what a
 *   malformed process TABLE does is still pinned, at the engine, in
 *   `observe.test.ts`.
 * - `TAP_OBS_HARNESS_FAMILIES` is gone. The configured set reached the old
 *   observation only because it crossed a process boundary as an environment
 *   variable; in-process it is an argument. That is the point of the seam and
 *   not an incidental tidy: slice 1 shipped a defect where an in-process
 *   caller silently lost a configured knob that had only ever arrived by
 *   inheritance, so the caller's set is threaded explicitly and an arm makes
 *   dropping it red.
 *
 * `scriptsDir` no longer resolves a script and is retained on purpose: it is
 * this bridge's declared dependency on the installed scripts tree, threaded
 * from submit-verify's configuration, and removing it would churn every caller
 * for a parameter the Bash door still needs to agree on.
 */
export function observeHarnessPid(
  scriptsDir: string,
  agentFamilies: ReadonlySet<string>,
  panePid: string,
  env: NodeJS.ProcessEnv = process.env,
): { state: "observed" | "unobservable"; family: string; pid?: string; error?: string } {
  const { table, ok, error } = readProcessTable(env);
  return { ...observeProcessHarness(panePid, table, ok, [...agentFamilies]), ...(error ? { error } : {}) };
}

export function evaluateHarnessEvidence(
  expected: string,
  command: string,
  panePid: string,
  agentFamilies: ReadonlySet<string>,
  processObs: { state: "observed" | "unobservable"; family: string } | null,
): HarnessEvidenceClass {
  const want = familyOf(expected, agentFamilies);
  if (!want) return "unattested";
  const observed = familyOf(command, agentFamilies);
  if (agentFamilies.has(observed)) return observed === want ? "alive" : "mismatch";
  if (DENYLIST.has(observed)) return "exited";
  if (!panePid) return "unobservable";
  if (!processObs || processObs.state !== "observed") return "unobservable";
  if (processObs.family) return processObs.family === want ? "alive" : "mismatch";
  return "exited";
}

function collectEvidence(
  obs: PaneObservation,
  expected: string,
  fx: PaneEffects,
  authority?: SubmitAuthority,
): { state: HarnessEvidenceClass; error?: string } {
  if (fx.harnessEvidence) return { state: fx.harnessEvidence(obs, expected) };
  if (!authority) return { state: "unobservable" };
  const observed = familyOf(obs.currentCommand, authority.agentFamilies);
  let processObs: ReturnType<typeof observeHarnessPid> | null = null;
  if (!authority.agentFamilies.has(observed) && !DENYLIST.has(observed)) {
    processObs = observeHarnessPid(authority.scriptsDir, authority.agentFamilies, obs.panePid);
  }
  return { state: evaluateHarnessEvidence(expected, obs.currentCommand, obs.panePid, authority.agentFamilies, processObs),
    ...(processObs?.error ? { error: processObs.error } : {}) };
}

/** Pre-placement twin of the post-lock authorize harness check. */
export function evaluateBoundHarness(
  obs: PaneObservation,
  expected: string,
  authority: SubmitAuthority,
): { state: HarnessEvidenceClass; error?: string } {
  return collectEvidence(obs, expected, REAL_EFFECTS, authority);
}

export function submitVerify(
  pane: string,
  id: string,
  sentinel: string,
  bound?: BoundRecipient,
  authority?: SubmitAuthority,
  fx: PaneEffects = REAL_EFFECTS,
): SubmitResult {
  // SERIALIZE THE WHOLE SUBMIT CYCLE ON THE PANE. Nothing between the text write
  // and the Enter is atomic, so any concurrent writer lands inside that window
  // and both sentinels are submitted as one line — with both senders exiting 0.
  const lock = acquirePaneLock(bound?.paneId || pane);
  if (!lock) {
    return {
      status: "lock_busy",
      detail: `another submit holds pane '${pane}'; parking rather than risking a fused line`,
    };
  }
  try {
    if (recoveryHold(bound?.paneId || pane)) return { status: "recovery_held", detail: `recovery owns pane '${pane}'; delivery parked` };
    const submit = () => submitVerifyLocked(pane, id, sentinel, bound, fx, authority);
    return authority?.busHome ? captureCourierFailure({ id, pane, sentinel, harness: bound?.harness ?? "",
      busHome: authority.busHome, scriptsDir: authority.scriptsDir }, submit, true) : submit();
  } finally {
    lock.release();
  }
}

type AuthorizeResult =
  | { status: "ok"; observation: PaneObservation }
  | Extract<SubmitResult, { status: "identity_mismatch" | "rate_limited" | "band_busy" }>;

/**
 * The one pre-effect authorization, narrowed for callers that hold the pane
 * submit lock themselves and must re-prove identity before their OWN named key
 * (self-compact's single Escape). It is the same `authorize` every locked
 * submission runs — no second predicate, no weaker check.
 */
export function authorizePaneEffect(
  pane: string,
  bound: BoundRecipient | undefined,
  fx: PaneEffects = REAL_EFFECTS,
  authority?: SubmitAuthority,
): AuthorizeResult {
  return authorize(pane, bound, fx, authority);
}

/**
 * Reread the acting registry at point-of-effect. The captured handle must still
 * name an active pane-delivery row bound to the same pane id and instance.
 * Unreadable, absent, inactive, launching, malformed, poll-only, or rebound
 * rows refuse before any pane effect.
 */
function boundRecipientRowRefusal(
  bound: BoundRecipient,
  authority?: SubmitAuthority,
): Extract<SubmitResult, { status: "identity_mismatch" }> | null {
  if (!bound.handle) return null;
  const handle = bound.handle;
  // A bound recipient is only valid against a row we can reread: a missing or
  // empty registry path refuses rather than skipping the check.
  if (!authority?.registryPath) {
    return { status: "identity_mismatch", detail: `no acting registry path to reread '${handle}'; refusing to deliver to an unverified bound recipient` };
  }
  const path = authority.registryPath;
  let seats: Record<string, unknown>;
  try {
    seats = seatMap(loadCurrentRegistry(path));
  } catch (error) {
    // An old-format registry names no current seat: refuse before any pane effect, and say old_store.
    if (error instanceof OldStoreError) return { status: "identity_mismatch", detail: `${error.message}; refusing to deliver to '${handle}'` };
    return {
      status: "identity_mismatch",
      detail: `acting registry '${path}' is unreadable; refusing to deliver to '${handle}'`,
    };
  }
  if (!Object.hasOwn(seats, handle)) {
    return {
      status: "identity_mismatch",
      detail: `'${handle}' is not an active seat; refusing to deliver to a pane that is not the addressed seat`,
    };
  }
  const row = seats[handle];
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    return {
      status: "identity_mismatch",
      detail: `'${handle}' is not an active seat; refusing to deliver to a pane that is not the addressed seat`,
    };
  }
  const rec = row as Record<string, unknown>;
  if (authority?.expectedNativeSession !== undefined && rec.harness_session_id !== authority.expectedNativeSession) {
    return { status: "identity_mismatch", detail: `'${handle}' native session changed before reset effect` };
  }
  if (String(rec.status ?? "active") !== "active") {
    return {
      status: "identity_mismatch",
      detail: `'${handle}' is not an active seat; refusing to deliver to a pane that is not the addressed seat`,
    };
  }
  if (String(rec.status_reason ?? "") === "launching") {
    return {
      status: "identity_mismatch",
      detail: `'${handle}' is still launching; refusing to deliver to a pane that is not the addressed seat`,
    };
  }
  if (String(rec.delivery ?? "pane") === "poll") {
    return {
      status: "identity_mismatch",
      detail: `'${handle}' is no longer a pane-delivery seat; refusing to deliver to a pane that is not the addressed seat`,
    };
  }
  const rowPaneId = String(rec.pane_id ?? "");
  if (bound.paneId && rowPaneId !== bound.paneId) {
    return {
      status: "identity_mismatch",
      detail: `'${handle}' is bound to pane id ${rowPaneId || "(none)"}, not the captured ${bound.paneId} — refusing to deliver to a pane that is not the addressed seat`,
    };
  }
  // tap-zk1w: the row must still make the generation claim captured at route
  // time; a row that lost or changed its stamp no longer binds this pane.
  const rowEpoch = typeof rec.server_epoch === "string" ? rec.server_epoch : "";
  if (bound.paneId && (!rowEpoch || rowEpoch !== bound.serverEpoch)) {
    return {
      status: "identity_mismatch",
      detail: `'${handle}' records server generation ${rowEpoch || "(none)"}, not the captured ${bound.serverEpoch || "(none)"} — refusing to deliver to a pane that is not the addressed seat`,
    };
  }
  const rowInstance = typeof rec.instance === "string" ? rec.instance : "";
  const captured = bound.instance ?? "";
  if (captured !== rowInstance) {
    return {
      status: "identity_mismatch",
      detail: `'${handle}' is instance '${rowInstance || "(none)"}', not the captured '${captured || "(none)"}' — refusing to deliver to a pane that is not the addressed seat`,
    };
  }
  return null;
}

/**
 * Re-authorize the live pane against the bound row. Returns the accepted
 * same-tuple observation, or a refusal. Success is never null.
 *
 * FAILS CLOSED ON AN UNOBSERVABLE GENERATION. An earlier version required BOTH
 * the bound and the live generation to be present before comparing, which
 * treated "cannot observe" as permission — precisely backwards for a check whose
 * job is to refuse when identity is in doubt.
 */
function authorize(
  pane: string,
  bound: BoundRecipient | undefined,
  fx: PaneEffects = REAL_EFFECTS,
  authority?: SubmitAuthority,
  checkInput = true,
): AuthorizeResult {
  if (bound) {
    const rowRefuse = boundRecipientRowRefusal(bound, authority);
    if (rowRefuse) return rowRefuse;
  }
  const obs = fx.observePane(pane);
  if (obs === "pane_dead") return { status: "band_busy", cause: "pane_dead", detail: `pane '${pane}' has exited; delivery is held` };
  if (obs === "unobservable") {
    return { status: "band_busy", bandState: "unobservable", detail: `pane '${pane}' identity is unobservable` };
  }
  if (obs === "rate_limited") {
    return { status: "rate_limited", detail: "tmux client budget exhausted before pane identity could be authorized" };
  }
  if (!obs) return { status: "identity_mismatch", detail: `pane '${pane}' does not exist` };

  if (!bound) return { status: "ok", observation: obs };
  if (bound.paneId && bound.paneId !== obs.paneId) {
    return { status: "identity_mismatch", detail: `'${pane}' is now pane ${obs.paneId}, not the bound ${bound.paneId} — refusing to deliver to a pane that is not the addressed seat` };
  }
  // tap-zk1w: a pane-bound recipient with no generation claim binds its pane
  // id to no server lifetime; pane agreement alone does not authorize input.
  if (bound.paneId && !bound.serverEpoch) {
    return { status: "identity_mismatch", detail: `pane '${pane}' is bound without a server generation, so it cannot be proven to be the addressed seat` };
  }
  const bootRefuse = boundBootRefusal(bound.bootId ?? "", "submit");
  if (bootRefuse) {
    return { status: "identity_mismatch", detail: bootRefuse.detail };
  }
  if (bound.serverEpoch && bound.serverEpoch !== obs.serverEpoch) {
    return { status: "identity_mismatch", detail: obs.serverEpoch
      ? `the pane reports server generation ${obs.serverEpoch}, not the bound ${bound.serverEpoch}`
      : `the pane's server generation is not observable, so the bound generation ${bound.serverEpoch} cannot be verified` };
  }
  const { state: evidence, error } = collectEvidence(obs, bound.harness ?? "", fx, authority);
  if (evidence === "alive" && checkInput && bound.serverEpoch && fx.inputHeld) {
    const held = fx.inputHeld(obs.paneId, obs.serverEpoch);
    if (held) return { status: "band_busy", bandState: "busy", detail: protectionDetail(held), disposition: {
      action: "park", parkReason: "pending-input", graceSeconds: Math.max(1, Math.ceil((protectionUntil(held) - Date.now()) / 1000)),
      cue: { initialStyle: null, redAtSecondsBeforeDeadline: 10 },
    } };
  }
  if (evidence === "alive") return { status: "ok", observation: obs };
  return {
    status: "identity_mismatch",
    detail: `harness evidence ${evidence} for bound family '${bound.harness ?? ""}' (live command '${obs.currentCommand}')${error ? `; ${error}` : ""}`,
  };
}

function sampleInput(fx: PaneEffects, target: string, command: string, id: string): InputObservation {
  if (fx.observeInput) return fx.observeInput(target, command, id);
  return fx.inputHasId(target, command, id) ? { state: "present", text: id } : { state: "absent" };
}

function unverifiedRefusal(refusal: { detail: string; cause?: string }): Extract<SubmitResult, { status: "unverified" }> {
  return { status: "unverified", detail: refusal.detail, ...(refusal.cause === "pane_dead" ? { cause: "pane_dead" as const } : {}) };
}

function copyModeSubmit(pane: string): Extract<SubmitResult, { status: "copy_mode" }> {
  return { status: "copy_mode", cause: "copy-mode", detail: `pane '${pane}' is in copy-mode` };
}

/** Copy-mode, gone, and rate-limited. Unobservable is not a resample override. */
function copyModeResample(obs: CopyModeObservation | undefined, pane: string): SubmitResult | null {
  if (!obs) return null;
  if (obs.status === "unobservable" && obs.cause === "pane_dead") return { status: "band_busy", cause: "pane_dead", detail: obs.reason };
  if (obs.status === "copy-mode") return copyModeSubmit(pane);
  if (obs.status === "rate-limited") return { status: "rate_limited", detail: obs.reason };
  if (obs.status === "gone") return { status: "pane_gone", detail: `pane '${pane}' does not exist` };
  return null;
}

function copyModePreEffect(obs: CopyModeObservation | undefined, pane: string): SubmitResult | null {
  const resampled = copyModeResample(obs, pane);
  if (resampled) return resampled;
  if (obs?.status === "unobservable") return { status: "band_busy", bandState: "unobservable", detail: obs.reason };
  return null;
}

/**
 * A band holding a TAP sentinel, after any harness queue prefix (hermes
 * `/queue `): anchored on `[[TAP`, or the scrolled tail of one (tap-1ncs6).
 * The shared shape rule in `sentinel-tail.ts` decides by class, not identity.
 */
export function stagedSentinel(text: string, command: string): boolean {
  const band = text.trimStart();
  const prefix = queuePrefix(command);
  return sentinelShapedInput(prefix && band.startsWith(prefix) ? band.slice(prefix.length).trimStart() : band);
}

function bandBlocksSubmit(band: PaneBand, pane: string): SubmitResult | null {
  if (band.state === "ready") return null;
  if (band.state === "busy") {
    return {
      status: "band_busy",
      bandState: "queued" in band && band.queued ? "queued" : "busy",
      bandText: band.text,
      detail: `pane '${pane}' holds unsubmitted input; refusing to inject rather than concatenating onto it`,
    };
  }
  if (band.state === "unobservable") {
    return { status: "band_busy", bandState: "unobservable", detail: band.reason ?? "input band is unobservable", ...(band.cause ? { cause: band.cause } : {}) };
  }
  if (band.state === "rate_limited") {
    return { status: "rate_limited", detail: band.reason ?? "tmux client budget exhausted before pane input could be inspected" };
  }
  if (band.state === "gone") {
    return { status: "pane_gone", detail: `pane '${pane}' is gone` };
  }
  return null;
}

/** Called only while the normal submit lock is held, including the Bash bridge. */
export function recoverSurveyLocked(pane: string, bound: BoundRecipient | undefined,
  authority: SubmitAuthority | undefined, fx: PaneEffects = REAL_EFFECTS, id = "") {
  const target = bound?.paneId || pane;
  let admittedHere = authority?.attemptAdmitted === true;
  let deadReason: string | undefined;
  const surveyFx: PaneEffects = id && authority?.busHome ? {
    ...fx,
    admitAttempt: () => {
      if (admittedHere) return true;
      if (!authority.attemptLicense && authority.attemptIds?.length === 0) return false;
      try {
        const admitted = authority.attemptLicense ? authority.attemptLicense()
          : beginDeliveryAttempts(authority.busHome!, authority.attemptIds ?? [id]);
        if (admitted !== "created") return false;
        admittedHere = true;
        return true;
      } catch (error) {
        console.error(`tap: cannot record delivery attempt: ${error}`);
        return false;
      }
    },
  } : fx;
  const result = recoverAgySurvey(target, bound?.harness ?? "", surveyFx, () => {
    if (!bound?.handle || !bound.instance || !bound.serverEpoch || !authority?.registryPath) return "complete registered target identity required; no keys sent";
    if (id && authority.busHome && !admittedHere) {
      try {
        lstatSync(authority.attemptMarker ?? join(authority.busHome, "receipts", `${id}.attempted`));
        return "prior possible attempt; no recovery or sentinel replay";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "attempt evidence unreadable; no recovery or sentinel replay";
      }
    }
    const check = authorize(pane, bound, fx, authority);
    if (check.status !== "ok") {
      if (check.status === "band_busy" && check.cause === "pane_dead") deadReason = check.detail;
      return check.detail;
    }
    const fence = paneEffectFence(authority);
    if (fence) return fence.detail;
    const copy = copyModePreEffect(fx.copyMode?.(target), pane);
    if (copy && "detail" in copy) {
      if (copy.status === "band_busy" && copy.cause === "pane_dead") deadReason = copy.detail;
      return copy.detail;
    }
    return recoveryHold(target) ? "another recovery owns this pane" : null;
  });
  return { ...result, attemptAdmitted: admittedHere, ...(deadReason ? { cause: "pane_dead" as const, detail: deadReason } : {}) };
}

/** The `unobservable` reasons that mean "no composer geometry was readable" (classifyPane's no-band arms for an unrecognized Claude/Codex/Antigravity frame), as opposed to a human decision on screen. See the `--no-spool` arm in submitVerifyLocked. */
const NO_SPOOL_ATTEMPTS_ON: ReadonlySet<string> = new Set([
  "no recognized Claude input box",
  "no recognized Codex composer",
  "no recognized Antigravity composer",
]);

/** One final key in this submit attempt, never a new delivery or a retype. */
export function completionEnter(
  pane: string, sentinel: string, result: SubmitResult,
  facts: { textAttempted: boolean; pretypeDraft: boolean },
  bound: BoundRecipient | undefined, fx: PaneEffects, authority: SubmitAuthority | undefined,
  phase: (name: SubmitPhase) => void, nextOrdinal: () => void, entered: () => void,
): SubmitResult {
  if ((result.status === "unverified" || result.status === "band_busy") && (result.cause === "pane_dead" || result.cause === "feedback-draft")) return result;
  const wire = sentinel.startsWith("/queue ") ? sentinel.slice(7) : sentinel;
  if (!facts.textAttempted || facts.pretypeDraft || !isOrdinarySentinel(wire)) return result;
  const target = bound?.paneId || pane;
  const check = authorize(pane, bound, fx, authority);
  if (check.status !== "ok") return unverifiedRefusal(check);
  const command = bound?.harness || check.observation.currentCommand;
  const band = fx.paneState(target, bound?.harness ?? "", command);
  if (band.state === "unobservable" && band.cause === "pane_dead") return { status: "unverified", cause: "pane_dead", detail: band.reason };
  const ownedText = band.state === "busy" && normalizeInputMatch(band.text) === normalizeInputMatch(sentinel);
  // The operator may have started a new draft since our last Enter. Never
  // submit it, even if the ordinary verifier already proved our wire accepted.
  if (band.state !== "ready" && !ownedText) return result;
  // Pending re-probe authority requires the exact staged wire, not an empty
  // band after a changed frame. Preserve that owner until its wire is visible.
  if (result.status === "unverified" && result.reprobePending && !ownedText) return result;
  const copy = copyModePreEffect(fx.copyMode?.(target), pane);
  if (copy?.status === "band_busy" && copy.cause === "pane_dead") return unverifiedRefusal(copy);
  if (copy) return { status: "unverified", detail: "detail" in copy ? copy.detail : "pane changed before completion Enter" };
  if (recoveryHold(target)) return { status: "unverified", detail: "recovery owns pane before completion Enter" };
  const identity = authorize(pane, bound, fx, authority);
  if (identity.status !== "ok") return unverifiedRefusal(identity);
  const fence = paneEffectFence(authority);
  if (fence) return { status: "unverified", detail: fence.detail };
  if (ownedText) phase("injected-text-confirmed");
  nextOrdinal();
  phase("completion-Enter-intent");
  entered();
  const pressed = fx.pressEnter(target);
  if (pressed !== true) return { status: "unverified", detail: "completion Enter could not be confirmed" };
  phase("Enter-sent");
  fx.settle(0.15);
  const after = fx.submitFrame?.(target, command, sentinel, !!bound?.harness);
  const finalIdentity = authorize(pane, bound, fx, authority);
  if (finalIdentity.status !== "ok") return unverifiedRefusal(finalIdentity);
  if (after?.state === "queued") {
    // The loop already decided on pre-Enter evidence; its fast-start relabel
    // must survive this flush Enter's frame, which shows the same
    // wire-plus-working shape the turn it started produces (tap-ho6pk).
    if (result.preBusy === false && after.inferred === true) return result;
    return { status: "harness_queued" };
  }
  if (ownedText && after?.state === "empty") return { status: "injected" };
  // An actual Enter consumes zero-Enter re-probe authority even if its
  // acceptance stays unknown. It must never authorize another submit.
  if (result.status === "unverified" && result.reprobePending) return { status: "unverified", detail: "completion Enter acceptance unconfirmed" };
  // Earlier positive verification remains evidence; an unreadable final frame
  // never promotes an unverified attempt into a successful delivery.
  return result;
}

export function submitVerifyLocked(
  pane: string,
  id: string,
  sentinel: string,
  bound?: BoundRecipient,
  fx: PaneEffects = REAL_EFFECTS,
  authority?: SubmitAuthority,
): SubmitResult {
  const attempt = authority?.attemptUuid ?? randomUUID();
  let enterCount = 0, ordinal = 0;
  let phasesRecorded = !!authority?.busHome;
  let interruptFact: InterruptFact | undefined;
  const phase: PhaseRecorder = (name, result, interrupt) => {
    const fact = interrupt ? { ...interrupt, tmux_confirmed: name === "interrupt-sent" } : undefined;
    if (name === "interrupt-sent" && fact) interruptFact = fact;
    if (!authority?.busHome) return name === "interrupt-intent" ? false : undefined;
    try { recordPhase(authority.busHome, { id, attempt, phase: name, recipient: authority.recipient ?? "",
      enter_count: enterCount, ordinal, result, interrupt: fact }); }
    catch (error) {
      phasesRecorded = false;
      console.error(`tap: submission phase evidence unavailable; ${name === "interrupt-intent" ? "interrupt withheld" : "possible effect retained; no retry"}: ${error}`);
      return false;
    }
    if (name === "interrupt-intent" && fact) {
      interruptFact = fact;
      process.stderr.write(`tap send: warning: interrupt attempt for ${id} to '${authority?.recipient ?? pane}' (harness=${fact.harness}); the current turn or tool call may be cancelled and a persistent goal may pause; cancelled work is unknown\n`);
      if (fact.draft_backup) process.stderr.write(`tap send: visible draft snapshot: ${fact.draft_backup}\n`);
      if (fact.draft_backup_error) process.stderr.write(`tap send: warning: visible draft backup failed: ${fact.draft_backup_error}\n`);
    }
    return true;
  };
  const facts = { textAttempted: false, pretypeDraft: false };
  const observed: PaneEffects = { ...fx,
    paneState: (...args) => {
      const band = fx.paneState(...args);
      // A sentinel already in the band — anchored or its scrolled tail
      // (tap-1ncs6) — is not a human draft; the shared shape rule decides.
      if (!facts.textAttempted && band.state === "busy" && !("queued" in band && band.queued)
        && !stagedSentinel(band.text, args[2])) facts.pretypeDraft = true;
      return band;
    },
    injectText: (...args) => {
      const accepted = fx.injectText(...args);
      facts.textAttempted = accepted === true;
      return accepted;
    },
  };
  const submitted = submitVerifyLockedBody(pane, id, sentinel, bound, observed, authority, phase,
    () => { ordinal++; }, () => { enterCount++; });
  const result = completionEnter(pane, sentinel, submitted, facts, bound, fx, authority, phase,
    () => { ordinal++; }, () => { enterCount++; });
  phase("verify-result", result.status === "injected" ? "verified" : result.status === "harness_queued" ? "queued" : "unverified");
  if (result.status === "unverified" && result.reprobePending && !phasesRecorded) {
    return { status: "unverified", detail: result.detail, ...(interruptFact ? { interrupt: interruptFact } : {}) };
  }
  return interruptFact ? { ...result, interrupt: interruptFact } : result;
}

/** What the staged-submit loop reads from its caller; `command` is reread before each Enter. */
export interface StagedContext {
  pane: string;
  target: string;
  bound: BoundRecipient | undefined;
  fx: PaneEffects;
  authority: SubmitAuthority | undefined;
  command: string;
  auto: boolean;
  urgent: boolean;
  /**
   * Before this call's first Enter, report identity drift as the authorize
   * class rather than `unverified`: nothing was submitted yet, so the caller
   * may name drift (nudge's exit 6). Any Enter makes every refusal unverified.
   */
  preEnterDriftClass?: boolean;
  /**
   * False drops Cursor's unconditional steering Enter. Nudge re-submits a wire
   * that may already be gone after one key, and its recovery guard refuses any
   * Enter without a staged sentinel; the loop's own still-staged retry covers it.
   */
  cursorSteer?: boolean;
  interruptDetails?: InterruptDetails;
  /**
   * Busy evidence from THIS submit's earliest frame read (the landing sample),
   * threaded here because the loop's own first frame can already be the queued
   * one, whose busy is true by construction. OpenCode frames carry it; every
   * other family leaves it undefined and the fast-start relabel never fires
   * (tap-ho6pk).
   */
  initialBusy?: boolean;
}

export interface StagedHooks {
  record: PhaseRecorder;
  admit: () => SubmitResult | null;
  bumpOrdinal: () => void;
  bumpEnter: () => void;
  /** An Enter counted by `bumpEnter` was positively not sent (the tmux client refused it). */
  unsentEnter?: () => void;
}

/**
 * Submit a wire already staged in the composer and verify it leaves: four
 * attempts (one under `singleEnter`), Cursor's steering pair, each Enter
 * behind a fresh frame, authorize, fence and copy-mode check. The caller holds
 * whatever serializes pane effects — the pane-submit lock for the courier, the
 * recorded recovery effect per key for nudge. Never re-types the wire.
 */
export function submitStagedLocked(ctx: StagedContext, verifiedId: string, expected: string, fullTextLanded: boolean,
  hooks: StagedHooks): SubmitResult {
  const { pane, target, bound, fx, authority, auto, urgent } = ctx;
  const { record, admit, bumpOrdinal } = hooks;
  let enters = 0;
  const bumpEnter = () => { enters++; hooks.bumpEnter(); };
  const drift = (check: Exclude<AuthorizeResult, { status: "ok" }>): SubmitResult =>
    ctx.preEnterDriftClass && enters === 0 ? check : unverifiedRefusal(check);
  // Four attempts, a pair per attempt on Cursor. Inspect after each attempt;
  // another id-free draft or a missing prompt is not positive acceptance.
  let cleared = false, queued = false, textConfirmed = false;
  let initialMode: SubmitFrame["mode"] | undefined;
  // A self-compaction can queue while its caller's tool turn is still active.
  // A lingering echo after Enter is not proof that Enter had no effect.
  const compactControl = authority?.typedPrefix === "/compact ";
  const enterAttempts = authority?.singleEnter || compactControl ? 1 : 4;
  let scrolledStaged = false;
  // The composer cleared, or a seat that was idle started working: the wire left the input band.
  const left = (frame: SubmitFrame) =>
    frame.state === "empty" || (frame.state === "unobservable" && frame.mode === "working" && initialMode !== "working");
  for (let attempt = 0; attempt < enterAttempts; attempt++) {
    const beforeEnter = authorize(pane, bound, fx, authority);
    if (beforeEnter.status !== "ok") return drift(beforeEnter);
    ctx.command = ctx.bound?.harness || beforeEnter.observation.currentCommand;
    const fenced = paneEffectFence(authority);
    if (fenced) return { status: "unverified", detail: fenced.detail };
    if (fx.submitFrame) {
      // The /compact control's head was proven on the prompt line before any
      // payload chunk and its tail was read back after the last one; a frame
      // whose viewport has scrolled the command row away may therefore stage
      // on its visible suffix (tap-vho8h). Ordinary wires keep the whole-frame rule.
      const frame = fx.submitFrame(target, ctx.command, expected, !!bound?.harness, auto, compactControl);
      initialMode ??= frame.mode;
      ctx.initialBusy ??= frame.busy;
      if (frame.state === "staged" && frame.scrolled) scrolledStaged = true;
      // A queue inferred from "wire + working" on a seat whose earliest read
      // this submit was idle is a fast-start acceptance, not a queue behind
      // earlier work: label it injected. Positive queue geometry, Codex's own
      // arm, and every family without busy evidence keep today's label.
      const relabel = frame.inferred === true && ctx.initialBusy === false;
      if (frame.state === "queued") { queued = !relabel; cleared = true; break; }
      // A feedback-draft panel that appeared after the paste refuses Enter under
      // every authority, queue-prefix included; the wire may already be typed.
      if (frame.held === "feedback-draft") return { status: "unverified", cause: "feedback-draft", detail: CLAUDE_FEEDBACK_DRAFT_REASON };
      // Default-deny (tap-rlebf.1): an approval prompt or trust dialog refuses
      // Enter under every authority, the queue-prefix bypass included; Enter
      // would answer it with its highlighted choice.
      if (frame.held === "approval") return { status: "unverified", detail: `${APPROVAL_PROMPT_REASON}; Enter withheld after sentinel injection` };
      // An earlier Enter can take effect after its own post-Enter read still saw
      // the wire staged; this attempt's frame then shows it gone. That is
      // acceptance, not drift (tap-csrls: delivered sends exited 5 on "empty").
      if (enters > 0 && left(frame)) { cleared = true; break; }
      // The queue-prefix landing was the gate (lib.sh:11507); its glyph-less
      // band never classifies staged, so no_prompt_ok proceeds to Enter.
      if (frame.state !== "staged" && !authority?.noPromptOk) {
        // AGY may repaint after the full wire landed but before the first
        // Enter. The existing owner can re-observe and submit that exact wire
        // in place; it must never repeat the injection or an earlier Enter.
        if (ctx.command === "agy" && frame.state === "changed" && attempt === 0 && fullTextLanded) {
          record("injected-text-confirmed");
          return { status: "unverified", reprobePending: true, detail: "AGY input changed before Enter; sentinel remains pending" };
        }
        return { status: "unverified", detail: `${frame.state}, ${frame.mode}, width ${frame.width}` };
      }
    }
    if (fx.submitFrame && !textConfirmed) {
      record("injected-text-confirmed");
      if (scrolledStaged) process.stderr.write(compactControl
        ? `tap: /compact staged from the visible scrolled suffix of the composer in '${pane}' (head proven before payload)\n`
        : `tap: wire staged from the visible scrolled tail of the composer in '${pane}' (narrow viewport, tap-1ncs6)\n`);
      textConfirmed = true;
    }
    bumpOrdinal();
    record("Enter-intent");
    const copy = copyModePreEffect(fx.copyMode?.(target), pane);
    if (copy?.status === "band_busy" && copy.cause === "pane_dead") return unverifiedRefusal(copy);
    if (copy) return { status: "unverified", detail: "detail" in copy ? copy.detail : "pane observation changed before submit" };
    const finalIdentity = authorize(pane, bound, fx, authority);
    if (finalIdentity.status !== "ok") return drift(finalIdentity);
    const finalFence = paneEffectFence(authority);
    if (finalFence) return { status: "unverified", detail: finalFence.detail };
    const refusal = admit();
    if (refusal) return refusal;
    const bareInterrupt = urgent && ctx.interruptDetails?.method === "bare-submit" && enters === 0;
    if (bareInterrupt && record("interrupt-intent", undefined, ctx.interruptDetails) === false) {
      return { status: "unverified", detail: "interrupt disclosure unavailable; bare Enter withheld after sentinel injection" };
    }
    bumpEnter();
    const pressed = fx.pressEnter(target);
    if (pressed === "rate_limited") {
      enters--; hooks.unsentEnter?.();
      return { status: "unverified", detail: "tmux client budget exhausted after sentinel injection" };
    }
    if (!pressed) return { status: "unverified", detail: `pane '${target}' vanished after sentinel injection` };
    if (bareInterrupt) record("interrupt-sent", undefined, ctx.interruptDetails);
    record("Enter-sent");
    // Cursor's plain sequence steers then interrupts at its safe boundary.
    // It is unconditional: a queued frame after the first Enter does not omit
    // it. An URGENT cursor send already interrupted with C-c before the
    // payload, so its steering tail stays a single Enter (the downgrade-local
    // `urgent`, not the caller's fact — a downgraded auto seat keeps its tail).
    if (ctx.command.startsWith("cursor") && !urgent && !authority?.singleEnter && ctx.cursorSteer !== false) {
      fx.settle(0.25);
      const secondCopy = copyModePreEffect(fx.copyMode?.(target), pane);
      if (secondCopy?.status === "band_busy" && secondCopy.cause === "pane_dead") return unverifiedRefusal(secondCopy);
      if (secondCopy) return { status: "unverified", detail: "pane entered copy mode during Cursor submit" };
      // The first Enter can raise Cursor's "Run this command?" prompt, whose
      // Enter runs it. Re-read the frame and withhold the steering Enter at a
      // prompt, at a frame with no readable composer, or at a screen no rule
      // classifies (tap-rlebf.1). If a real frame between the two Enters reads
      // unknown, the remedy is a rule for it, never a key into it.
      const steer = fx.submitFrame?.(target, ctx.command, expected, !!bound?.harness, auto, compactControl);
      const steerScreen = fx.captureEscaped?.(target, ctx.command);
      const steerUnknown = steerScreen !== undefined && (!steerScreen.ok || detectAgentState(ctx.command, steerScreen.frame).agentState === "unknown");
      if (steer?.held === "approval" || steer?.state === "unobservable" || steerUnknown) {
        return { status: "unverified", detail: `${steer?.held === "approval" ? APPROVAL_PROMPT_REASON : "unclassified frame"}; Cursor steering Enter withheld` };
      }
      bumpOrdinal();
      record("Enter-intent");
      const secondIdentity = authorize(pane, bound, fx, authority);
      if (secondIdentity.status !== "ok") return unverifiedRefusal(secondIdentity);
      const secondFence = paneEffectFence(authority);
      if (secondFence) return { status: "unverified", detail: secondFence.detail };
      bumpEnter();
      const second = fx.pressEnter(target);
      if (second === "rate_limited") {
        enters--; hooks.unsentEnter?.();
        return { status: "unverified", detail: "tmux client budget exhausted during Cursor submit" };
      }
      if (!second) return { status: "unverified", detail: `pane '${target}' vanished during Cursor submit` };
      record("Enter-sent");
    }
    fx.settle(attempt === 3 ? 1.5 : 0.5);
    if (fx.submitFrame) {
      const frame = fx.submitFrame(target, ctx.command, expected, !!bound?.harness, auto, compactControl);
      ctx.initialBusy ??= frame.busy;
      const relabel = frame.inferred === true && ctx.initialBusy === false;
      if (frame.state === "queued") { queued = !relabel; cleared = true; break; }
      if (authority?.noPromptOk) {
        // lib.sh:11043: no_prompt_ok (the /queue prefix) relaxes the
        // post-submit pending-input recheck too — a queue line still rendered
        // is the harness's own business, never an unverified submit.
        queued = true; cleared = true; break;
      }
      if (left(frame)) { cleared = true; break; }
      if (frame.state !== "staged" || attempt === enterAttempts - 1) {
        return { status: "unverified", detail: `${frame.state}, ${frame.mode}, width ${frame.width}` };
      }
    } else {
      // Older injected effects expose typed input observations instead of frames.
      const sample = sampleInput(fx, target, ctx.command, verifiedId);
      if (sample.state === "absent") { cleared = true; break; }
      if (sample.state === "chip") return { status: "unverified", detail: `paste-collapse chip remains in the input of '${pane}'` };
      if (sample.state === "unobservable" || sample.state === "rate_limited") return {
        status: "unverified", detail: sample.reason, ...(sample.state === "unobservable" && sample.cause ? { cause: sample.cause } : {}),
      };
      if (sample.state === "gone") return { status: "unverified", detail: `pane '${pane}' gone after sentinel injection` };
    }
  }
  if (!cleared) return { status: "unverified", detail: `staged, width unknown: id '${verifiedId}' did not leave the input line of '${pane}'` };
  // Enter may already have taken effect. A late identity failure cannot be a
  // pre-effect refusal class — the receipt would claim a different pane/epoch
  // than the one that was submitted to.
  // A successful reset may already have rebound the native conversation.
  // Keep pane/instance/epoch/harness checks, but do not reject that expected change.
  const afterClear = authorize(pane, bound, fx, authority ? { ...authority, expectedNativeSession: undefined } : undefined);
  if (afterClear.status !== "ok") {
    return { status: "unverified", detail: afterClear.detail };
  }
  return { status: queued ? "harness_queued" : "injected", preBusy: ctx.initialBusy };
}

function submitVerifyLockedBody(
  pane: string,
  id: string,
  sentinel: string,
  bound: BoundRecipient | undefined,
  fx: PaneEffects,
  authority: SubmitAuthority | undefined,
  phase: PhaseRecorder,
  nextOrdinal: () => void,
  entered: () => void,
): SubmitResult {
  // RE-AUTHORIZED AFTER THE LOCK AND BEFORE ANY PANE EFFECT — not merely before
  // placement, which is a different moment entirely.
  const authorized = authorize(pane, bound, fx, authority, false);
  if (authorized.status !== "ok") return authorized;

  // TARGET THE PANE ID, NOT THE ADDRESS. Authorizing and then acting on the
  // positional address leaves a real gap: those are two tmux processes, and a
  // session replaced between them means the keystroke lands on whatever now
  // occupies that address. The partner reviewer's correction — bound.paneId IS the
  // immutable-within-generation identity, and combined with bound.serverEpoch
  // (which authorize compares) it is the composite identity I said was
  // unavailable. It was available; I had it in hand and was not using it.
  //
  // Authorization still runs before every effect, because the epoch check is
  // what catches a server REBIRTH — a %N is unique only within one generation,
  // so the id alone is not enough. Targeting the id closes the address race;
  // authorizing closes the generation race. Both are needed.
  const target = bound?.paneId || pane;
  const mode = recordedPermissions(authority?.registryPath, bound?.handle ?? authority?.recipient);
  if (mode === "unknown") {
    // A row can disappear during the pane observation above. Identity refusal
    // keeps precedence over the later permission-policy hold.
    const rowRefusal = bound && boundRecipientRowRefusal(bound, authority);
    if (rowRefusal) return rowRefusal;
    return { status: "band_busy", detail: "recipient permission policy is unreadable" };
  }
  const auto = mode === "auto";

  // U4 (the interrupt class). The effective urgency rides the delivery facts,
  // but an auto-permission seat has no human to interrupt — the incumbent
  // downgrades to ordinary delivery BEFORE any pane effect, warning once
  // (tap-send.sh:1582-1591). Everything urgent-scoped below keys off this
  // local, so a downgraded auto seat takes the ordinary path throughout.
  let urgent = authority?.deliveryFacts?.urgent === true;
  if (urgent && auto) {
    process.stderr.write("tap send: warning: auto_mode_no_interrupt: auto seat cannot be interrupted; queued as ordinary delivery\n");
    urgent = false;
  }
  // The idle staged path is Enter-only by construction (R1): an urgent fact on
  // this authority would fall through to the interrupt/inject arms below it.
  // Refuse before any effect; staged-idle parks never carry urgency, so this
  // is the belt-and-suspenders guard for a misbuilt authority.
  if (urgent && authority?.idleStaged) {
    return { status: "unverified", detail: "urgent delivery cannot take the idle staged-submit path; no keys sent" };
  }
  const typedPrefix = authority?.typedPrefix;
  if (typedPrefix !== undefined) {
    // Refused before any effect: each combination would type a command token
    // into a path that never carried one.
    if (!/^\S(.*\S)? $/.test(typedPrefix)) return { status: "unverified", detail: `typed prefix must end with exactly one trailing space: '${typedPrefix}'` };
    if (authority?.noPromptOk || authority?.singleEnter || urgent) {
      return { status: "unverified", detail: "typed prefix cannot combine with queue-prefix, single-Enter or urgent delivery" };
    }
    if (!fx.promptInput || !fx.regionInput) return { status: "unverified", detail: "typed prefix needs the composer readers" };
  }

  const readerCommand = (obs: PaneObservation) => bound?.harness || obs.currentCommand;
  let command = readerCommand(authorized.observation);
  // The seat's busy state at this submit's EARLIEST frame read. The staged
  // loop's own first frame can already be the queued one, whose busy is true
  // by construction, so seeding from the landing sample is what makes the
  // fast-start relabel trustworthy (tap-ho6pk).
  let preBusy: boolean | undefined;

  // INPUT SAFETY, CHECKED BEFORE ANY PANE EFFECT.
  //
  // send-keys appends to whatever is already in the band, so injecting into a
  // pane whose owner has typed something concatenates the sentinel onto their
  // half-written message and Enter submits BOTH as one line. Reproduced: a
  // pane holding `HUMAN-DRAFT` received
  // `HUMAN-DRAFT[[TAP v=0.20 …]]` as a single submitted line, and the send
  // still returned 0. That is user-input corruption reported as success.
  //
  // This PoC takes the conservative outcome — skip the pane effect, leave the
  // canonical on the bus — rather than the reference's backup-and-clobber
  // pipeline, which is out of the declared slice. The recipient can poll it:
  // blocked-band maps to exit-0 queued/poll, not exit-5.
  //
  // AN UNOBSERVABLE BAND IS ALSO A REFUSAL. A harness mid-turn renders no prompt
  // glyph at all, and an earlier version read "no prompt found" as "band is
  // empty" — then injected into a pane it could not see, leaving the sentinel
  // sitting unsubmitted while the payload looked delivered from outside.
  // "I cannot see the band" and "the band is empty" are opposite facts.
  const initialCopy = copyModePreEffect(fx.copyMode?.(target), pane);
  if (initialCopy) return initialCopy;
  const survey = recoverSurveyLocked(pane, bound, authority, fx, id);
  if (survey.status === "attempt_evidence_unwritable") return survey;
  if (survey.cause === "pane_dead" && survey.detail) return { status: survey.attemptAdmitted ? "unverified" : "band_busy", cause: "pane_dead", detail: survey.detail };
  if (survey.status === "blocked") return { status: "band_busy", bandState: "unobservable", detail: survey.detail };
  let attemptAdmitted = survey.attemptAdmitted;
  let interruptDetails: InterruptDetails | undefined;
  const admitEffect = (beforeCreate?: () => boolean): Extract<SubmitResult, { status: "attempt_evidence_unwritable" }> | null => {
    if ((!authority?.deliveryFacts && !authority?.attemptIds && !authority?.attemptLicense) || attemptAdmitted) {
      beforeCreate?.();
      return null;
    }
    if (!authority.attemptLicense && authority.attemptIds?.length === 0) return { status: "attempt_evidence_unwritable", detail: "delivery attempt ids are empty" };
    try {
      const admitted = authority.attemptLicense ? authority.attemptLicense(beforeCreate ?? (() => true))
        : beginDeliveryAttempts(authority.busHome ?? "", authority.attemptIds ?? [id], beforeCreate ?? (() => true));
      if (admitted === "existing") return { status: "attempt_evidence_unwritable", detail: "delivery attempt already recorded for a member" };
      if (admitted === "refused") return null; // The caller retains its typed guard refusal.
      attemptAdmitted = true;
      return null;
    } catch (error) {
      return { status: "attempt_evidence_unwritable", detail: `cannot record delivery attempt: ${error}` };
    }
  };
  let band = fx.paneState(target, bound?.harness ?? "", command);
  if (band.state === "unobservable" && band.cause === "pane_dead") return {
    status: attemptAdmitted ? "unverified" : "band_busy", cause: "pane_dead", detail: band.reason,
  };
  let updateSkipped = false;
  if (command === "codex" && band.state === "unobservable" && fx.captureEscaped) {
    const frame = fx.captureEscaped(target, command);
    const prompt = frame.ok ? codexUpdatePrompt(frame.frame) : null;
    if (prompt) {
      if (!bound?.paneId || !bound.serverEpoch || !authority?.busHome
        || !(authority.deliveryFacts || authority.attemptIds || authority.attemptLicense) || !fx.pressKeys || !fx.paneTitle) {
        return { status: "band_busy", bandState: "unobservable", detail: "Codex update Skip needs a bound delivery attempt and frame readers" };
      }
      const record = (outcome: string) => appendRegistryEventOrWarn("tap send", {
        log: authority.eventContext?.log ?? join(authority.busHome!, "registry-events.log"),
        actor: authority.eventContext?.actor ?? authority.sender ?? "courier", action: "codex_update_skip",
        handle: authority.recipient ?? "", pane: target, team: authority.eventContext?.team ?? "",
        detail: `${outcome}: ${codexUpdateSkipReceipt(prompt)}; id=${id}`,
      });
      const before = authorize(pane, bound, fx, authority);
      if (before.status !== "ok") return before;
      if (before.observation.panePid !== authorized.observation.panePid) return { status: "identity_mismatch", detail: "Codex process changed before update Skip" };
      const fence = paneEffectFence(authority) ?? copyModePreEffect(fx.copyMode?.(target), pane);
      if (fence) return fence;
      let refused: SubmitResult | null = null;
      const admitted = admitEffect(() => {
        const fresh = authorize(pane, bound, fx, authority);
        refused = fresh.status === "ok" ? paneEffectFence(authority) ?? copyModePreEffect(fx.copyMode?.(target), pane) : fresh;
        if (fresh.status === "ok" && fresh.observation.panePid !== before.observation.panePid)
          refused = { status: "identity_mismatch", detail: "Codex process changed before update Skip" };
        return refused === null;
      });
      if (refused) return refused;
      if (admitted) return admitted;
      record("intent");
      const unverified = (detail: string): SubmitResult => {
        record("unverified");
        return { status: "unverified", detail: `Codex update Skip: ${detail}; attach and inspect before retrying` };
      };
      try {
        if (fx.pressKeys(target, ["Escape"]) !== true) return unverified("Escape acceptance is unverified");
        fx.settle(0.1);
        const after = fx.captureEscaped(target, command), title = fx.paneTitle(target);
        const current = authorize(pane, bound, fx, authority);
        if (current.status !== "ok" || current.observation.panePid !== before.observation.panePid
          || paneEffectFence(authority) || copyModePreEffect(fx.copyMode?.(target), pane)
          || !codexUpdateDismissed(after.ok ? after.frame : null, title.ok ? title.title : null)) {
          return unverified("Escape sent; empty composer on the same pane is unverified");
        }
        updateSkipped = true;
        record("skipped");
        process.stderr.write(`tap send: ${codexUpdateSkipReceipt(prompt)}\n`);
        band = fx.paneState(target, bound?.harness ?? "", command);
      } catch (error) { return unverified(`possible Escape effect; ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  // The staged-submit loop lives at module level so a caller that owns its own
  // locking (nudge's recorded recovery effects) runs the same loop; the body's
  // `command` follows the loop's per-attempt reread.
  const verifyStaged = (verifiedId: string, expected: string, fullTextLanded: boolean,
    record: typeof phase = phase, admit: () => SubmitResult | null = () => null,
    bumpOrdinal = nextOrdinal, bumpEnter = entered, unsentEnter?: () => void): SubmitResult => {
    const ctx: StagedContext = { pane, target, bound, fx, authority, command, auto, urgent, interruptDetails, initialBusy: preBusy };
    try { return submitStagedLocked(ctx, verifiedId, expected, fullTextLanded, { record, admit, bumpOrdinal, bumpEnter, unsentEnter }); }
    finally { command = ctx.command; preBusy = ctx.initialBusy; }
  };
  // tap-vctb8: the pre-inject band, possibly REASSIGNED after one repaint.
  if (band.state === "unobservable" && band.cause === "pane_dead") return {
    status: attemptAdmitted ? "unverified" : "band_busy", cause: "pane_dead", detail: band.reason,
  };
  // tap-vctb8, bounded by tap-cl1es: the pre-inject band below, possibly
  // REASSIGNED after one repaint. A detected claude-mem-style overprint is debris a
  // single SIGWINCH repaint can clear — and the Bash incumbent repainted here
  // pre-inject for exactly that reason before it was dropped. The pane was
  // authorized for effects above; the repaint sends no keys, so the
  // draft-safety floor is untouched. An OpenCode pane whose band never painted
  // (no recognized composer: the input_band_absent booting signature) joins
  // the cure once it has persisted past the booting bound. shell-mode and
  // pane_dead carry their own causes and are never repaint targets.
  //
  // The cross-attempt budget lives HERE, at the effect (I2): readiness's
  // busy:overprint / busy:booting are only the cheap early gates, and
  // deadline-due attempts and direct sends never consult them. The
  // overprintRepaintGate decides repaint/hold/exhausted from the pane's
  // stuck-paint record — {cause, count, firstSeen, lastAt}, never the frame
  // bytes (a working turn repaints constantly; a hash-keyed bound would never
  // bind) — and both its decision and its spend recording run under the
  // window repaint lock inside repaintPane, so concurrent attempts cannot
  // double-spend (tap-cl1es review C). A declined or still-stuck repaint
  // parks the entry; the record's cooldown schedules the next look.
  const opencodeFamily = (bound?.harness ?? "").split("/").pop() === "opencode";
  // The booting cure is the AUTOMATIC path's: an attempt carrying special
  // authority (force sends, urgent, no-spool) keeps the
  // incumbent behavior — a composer-less wedge is indistinguishable from
  // booting to the band reader, and force must not grow a resize.
  const forceable = authority?.forceNoPrompt === true || authority?.noPromptOk === true
    || authority?.deliveryFacts?.noSpool === true || urgent;
  const repaintCause: "overprint" | "booting" | null = band.state !== "unobservable" ? null
    : band.cause === "overprint" ? "overprint"
    : opencodeFamily && !band.cause && !forceable ? "booting"
    : null;
  if (band.state === "unobservable" && repaintCause && fx.repaint && fx.captureEscaped) {
    const current = fx.captureEscaped(target, command);
    // No readable frame means no comparable observation, so the repaint would
    // be unbounded across attempts; repark until the pane can be read again.
    if (!current.ok) return bandBlocksSubmit(band, pane) ?? { status: "band_busy", bandState: "unobservable", detail: band.reason ?? "input band is unobservable" };
    // Cheap pre-check so a held episode stays silent; the authoritative
    // decision re-runs under the window lock inside repaintPane. This band is
    // unobservable, so it always blocks: a held episode reparks without a
    // repaint, and the incumbent gate never sees the entry.
    if (bound?.paneId && overprintRetryDue(bound.paneId, repaintCause, Math.floor(Date.now() / 1000)) !== "repaint") {
      return bandBlocksSubmit(band, pane)!;
    }
    const gate = bound?.paneId ? overprintRepaintGate(bound.paneId, repaintCause) : undefined;
    const repaint = fx.repaint(target, gate);
    process.stderr.write(repaint.ok
      ? `tap: OpenCode ${repaintCause === "overprint" ? "terminal overprint" : "stuck booting band"} repainted before delivery classification\n`
      : `tap: OpenCode ${repaintCause === "overprint" ? "terminal overprint" : "stuck booting band"} repaint failed before delivery classification: ${repaint.reason || "unknown reason"}\n`);
    const reread = fx.paneState(target, bound?.harness ?? "", command);
    if (reread.state === "unobservable" && (reread.cause === "overprint" || (opencodeFamily && !reread.cause))) {
      // Still stuck. The spend is already recorded — gate.commit ran under
      // the window lock and counted only an attempted resize, so a refused
      // attempt (lock busy, geometry unreadable) leaves the budget intact and
      // the next attempt still repaints.
      if (repaint.attempted && bound?.paneId && !readOverprintRecord(bound.paneId)) {
        process.stderr.write("tap: OpenCode overprint repaint budget could not be recorded; the next attempt may repaint again\n");
      }
      return bandBlocksSubmit(reread, pane) ?? { status: "band_busy", bandState: "unobservable", detail: reread.reason ?? "input band is unobservable" };
    }
    // A readable band is the one retirement the record honors.
    if (bound?.paneId && reread.state !== "unobservable") retireOverprintRecord(bound.paneId);
    band = reread;
  }
  // A named human-owned surface (OpenCode shell, Claude feedback draft) parks
  // with its own reason and never takes a key, whatever the delivery authority.
  const surfaceHold = (cause: "shell-mode" | "feedback-draft"): SubmitResult => ({
    status: "band_busy", bandState: "unobservable", cause,
    detail: cause === "shell-mode" ? OPENCODE_SHELL_MODE_REASON : CLAUDE_FEEDBACK_DRAFT_REASON,
    disposition: deliveryDisposition({ noSpool: false, recipientBound: !!bound,
      ...authority?.deliveryFacts, harness: bound?.harness ?? command, urgent, band: cause }),
  });
  if (band.state === "unobservable" && (band.cause === "shell-mode" || band.cause === "feedback-draft")) return surfaceHold(band.cause);
  if (band.state === "unobservable" && band.reason === CODEX_HOOK_TRUST_REASON) {
    return { status: "band_busy", bandState: "unobservable", detail: band.reason };
  }
  // The recovery-interrupt's whole premise is a seat that is NOT idle: the
  // ready-band requirement is lifted for it (tap-pkh9c), while the observer
  // refusal (!fx.submitFrame) stays — landing verification needs the frame
  // reader. Downstream guards are untouched: the survey, the urgent modal
  // captures and bandBlocksSubmit still refuse before any key.
  // The idle staged path expects a BUSY band — the staged sentinel itself —
  // so the auto seat's ready-band requirement does not apply to it; its own
  // frame gates below are stricter than this check.
  if (auto && !authority?.idleStaged && (band.state !== "ready" || !fx.submitFrame) && !composerControlWord(band)) {
    return { status: "band_busy", detail: "auto seat has no positively ready empty band" };
  }
  // This is the courier-local band, REASSIGNED after an urgent interrupt: the
  // incumbent re-reads pending input once the Escape has landed
  // (tap-send.sh:1666), because the interrupt may have cleared a half-open
  // draft into a ready band.
  let effectiveBand = band;
  let draftBackup: Extract<ClobberVerdict, { kind: "cleared" | "residue" }> | undefined;
  let draftOwner: PaneObservation | undefined;
  let draftNoticeSent = false;
  // The urgent path's owner notice — paste-collapse (tap-cnka) or
  // interrupt-emptied — recorded after the Escape and fired only once the
  // submission finishes (tap-xhb1l). `incomplete` forces the
  // incomplete wording; otherwise the retained backup's capture_status decides.
  let deferredDraft: { backup: string; owner: PaneObservation; incomplete?: true } | null = null;
  const notifyDraft = (incomplete = !!(draftBackup?.chip || draftBackup?.incomplete)) => {
    if (!draftOwner || draftNoticeSent) return;
    notifyDraftBackedUp(pane, draftOwner.paneId, draftOwner.serverEpoch, draftOwner.session, process.env, incomplete);
    draftNoticeSent = true;
  };
  let decision: DeliveryDisposition | undefined;
  if (authority?.deliveryFacts && band.state !== "gone" && band.state !== "rate_limited") {
    const facts = { ...authority.deliveryFacts, urgent };
    const observed = band.state === "ready" ? "bare"
      : band.state === "busy" ? ("queued" in band && band.queued ? "queued"
        : deliveryBand(band.text, facts.harness ?? "", "")) : "unobservable";
    decision = deliveryDisposition({ ...facts, band: observed });
    if (authority.draftGraceSatisfied && decision.parkReason === "pending-input") decision = { action: "inject", parkReason: null, graceSeconds: null, cue: { initialStyle: null, redAtSecondsBeforeDeadline: null } };
  }
  // A queue-prefix ride (hermes `/queue `) queues over pending input instead
  // of clobbering it, so it skips the pending-input hold entirely — including
  // minting one: the harness owns the turn, and a minted record would also
  // refuse the later beforeInject re-authorization. The prefix in the body is
  // the skip's evidence, not noPromptOk alone: an URGENT hermes send zeroes
  // the prefix (U4) while keeping the no_prompt_ok bypass, and its draft
  // takes the same hold as every other harness.
  const operatorWord = composerControlWord(band) !== null;
  if (fx.protectInput && bound?.serverEpoch && (!sentinel.startsWith("/queue ") || operatorWord
    || (fx.inputHeld?.(target, bound.serverEpoch)?.stopUntil ?? 0) > Date.now())) {
    const state = fx.protectInput(authorized.observation, band, {
      urgent, harness: bound.harness, sender: authority?.sender,
      message: authority?.busHome && (!authority.attemptIds || authority.attemptIds.includes(id))
        ? { home: authority.busHome, id, sender: authority.sender ?? "" } : undefined,
    });
    if (state && authority?.busHome && (state.stopUntil || state.snoozeUntil > Date.now())) {
      emitWaitCue(target, { pane, home: authority.busHome, ownerId: id });
    }
    if (state && protectionUntil(state) > Date.now()) {
      // A WAIT latch observed through any send path flashes BLUE once; the pane-shared
      // record claims the milestone so parallel observers cannot repeat it. Without a
      // bus home there is nowhere to mint the effect token, so nothing is claimed.
      return { status: "band_busy", bandState: "busy", detail: protectionDetail(state), disposition: {
        action: "park", parkReason: "pending-input", graceSeconds: Math.max(1, Math.ceil((protectionUntil(state) - Date.now()) / 1000)),
        // Snoozed arrivals queue silently: finishPark suppresses the park cue while
        // the pane's snooze is live — the one authority, covering every park source.
        cue: { initialStyle: urgent ? "red" : "green", redAtSecondsBeforeDeadline: 10 },
      } };
    }
    if (state?.startRequested && band.state !== "ready") {
      const refused = (): SubmitResult => ({ status: "band_busy", bandState: "busy",
        detail: "START cleanup not verified; clear the composer to resume incoming mail",
        disposition: { action: "park", parkReason: "pending-input", graceSeconds: 1,
          cue: { initialStyle: null, redAtSecondsBeforeDeadline: null } } });
      if (state.startClearAttempted || band.state !== "busy" || composerControlWord(band) !== "START" || !authority?.busHome || !fx.pressKeys) return refused();
      // START is TAP's own command. Back it up, then recheck identity, fences and
      // exact composer contents before spending its one no-byte control license.
      // No payload attempt is consumed and no retry of this clear is permitted.
      try {
        writeInputBackup({ directory: join(authority.busHome, "input-backups"), handle: authority.recipient ?? id,
          payloadId: id, pane, paneId: target, paneCommand: command, inputHash: inputHash(band.text),
          recoveryPolicy: "operator-start", text: band.text });
        const check = authorize(pane, bound, fx, authority);
        if (check.status !== "ok") return check;
        const fence = paneEffectFence(authority);
        if (fence) return fence;
        const fresh = fx.paneState(target, bound.harness ?? "", command);
        if (composerControlWord(fresh) !== "START") return refused();
        if (!claimStartClear(target, bound.serverEpoch)) return refused();
        if (fx.pressKeys(target, ["C-u"]) !== true) return refused();
        fx.settle(0.03);
        band = fx.paneState(target, bound.harness ?? "", command);
        if (band.state !== "ready") return refused();
        completeStartClear(target, bound.serverEpoch);
        effectiveBand = band;
      } catch { return refused(); }
    }
  }
  // The only exception above was an operator control word. After its handling,
  // auto delivery still requires the same positively empty composer.
  if (auto && !authority?.idleStaged && (band.state !== "ready" || !fx.submitFrame)) {
    return { status: "band_busy", detail: "auto seat has no positively ready empty band" };
  }
  // THE IDLE STAGED SUBMIT (tap-9lqa7). Enter-only by construction: this arm
  // runs before every effect-ful branch below — interrupts, draft clobbers,
  // injection, the scrolled-tail ride — and RETURNS unconditionally, so no
  // later path can add bytes on this authority. It presses Enter at most once
  // on a composer positively observed idle holding exactly one well-formed TAP
  // sentinel and nothing else. Enter on exactly that composer adds no bytes:
  // a completion key in the no-retry rule's terms, never a re-delivery. The
  // link-atomic `.idle-submit` receipt is the admission — `.attempted` already
  // exists for this entry and `admitEffect` rightly refuses it; this is the
  // separate one-shot license, and its existence ends all eligibility.
  if (authority?.idleStaged) {
    const refuse = (detail: string, cause?: "staged_absent"): SubmitResult =>
      ({ status: "unverified", detail, ...(cause ? { cause } : {}) });
    if (!authority.busHome || !stagedIdleSubmitEligible(authority.busHome, id, authority.env)) {
      return refuse("idle staged submit is no longer eligible; no keys sent");
    }
    if (!fx.captureEscaped || !fx.submitFrame) return refuse("idle staged submit needs the frame readers; no keys sent");
    // tap-8nmot: the title read is part of the arm's allowlist evidence —
    // without it the state read cannot distinguish idle from mid-turn quiet.
    // tap-8nmot: the ruling's title gate is a Codex gate (its spinner title is
    // the working witness); other harnesses keep their failure surface.
    const codexFamily = /^codex(?:-|$)/.test(command);
    if (codexFamily && !fx.paneTitle) return refuse("idle staged submit needs the pane title read; no keys sent");
    const text = effectiveBand.state === "busy" ? effectiveBand.text : "";
    // A readable band with no sentinel-shaped input at all is a quiet dispose:
    // a human submitted or cleared the composer. The manual path owns nothing.
    if (!text || !sentinelShapedInput(text)) {
      return refuse(`staged sentinel is not visible in the composer of '${pane}'; no keys sent`, "staged_absent");
    }
    const parsed = parseStuckSentinel(text, command);
    // Strict anchors refuse concatenations and banner-contaminated
    // regions (the M12 startup screen) alike: the parser's strictness is the
    // gate, unchanged. An unparseable wire stays held for the window, never
    // keyed.
    if (!parsed.ok) return refuse("unparseable TAP input retained; no keys sent");
    const stuckFull = parsed.fields.id;
    const stuckId = stuckFull.slice(stuckFull.lastIndexOf("/") + 1);
    // Two samples across a settle, both positively at rest (idle or error).
    // The allowlist rejects overprint, booting, working, blocked and every
    // unknown or future state. Both samples must hold the same single
    // well-formed wire — visibleSentinelId refuses approval prompts, obvious
    // dialogs and concatenated wires — and each must hold the wire as the
    // WHOLE composer, not merely contain it: composerHoldsExactly is equality,
    // so human bytes that land after the wire between samples can never ride
    // the one Enter (R5). An OpenCode pane repaints first, as the nudge Enter
    // does: a stale paint can agree with itself while the composer it shows
    // is gone.
    if (opencodeFamily) {
      if (!fx.repaint) return refuse("OpenCode idle staged submit needs the repaint seam; no keys sent");
      const repaint = fx.repaint(target);
      if (!repaint.ok) return refuse(`OpenCode repaint failed before the idle staged submit: ${repaint.reason || "unknown reason"}; no keys sent`);
    }
    const strip = (frame: string) => frame.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    // Codex reads an occupied composer as "unknown" unless the caller owns the
    // bytes (agent-state codexLiveComposer); the staged-idle corroboration IS
    // that ownership proof — the same flag self-compact passes for its own
    // staged control. Every other harness ignores the flag.
    // Why the LAST sample returned null, when it is one of the two new
    // tap-8nmot gates: the refusal then names the cause instead of the generic
    // not-idle line, and the generic bytes stay byte-identical for the gates
    // that always refused there.
    let sampleWhy = "";
    const sample = (): { id: string; state: AgentState; frame: string } | null => {
      const captured = fx.captureEscaped!(target, command);
      if (!captured.ok) return null;
      // The pane TITLE is Codex evidence, never an empty fallback: a working
      // stamp in the title means the composer's stillness is mid-turn quiet
      // (tap-8nmot). Other harnesses' samples never consult it.
      const title = codexFamily ? fx.paneTitle!(target) : { ok: true, title: "" };
      if (!title.ok) { sampleWhy = "the pane title could not be read"; return null; }
      // The frame's own mode must be `idle`: a "tab to queue message" cue is a
      // RUNNING turn, and Enter there steers the running turn instead of
      // submitting the wire (tap-8nmot).
      // So is Codex's queued-edit cue ("shift + ← edit last queued message"):
      // a queued follow-up exists only while a turn runs, and readFrame trims
      // that row as footer chrome without marking the frame mid-turn.
      if (readFrame(captured.frame, command, text).mode !== "idle"
        || (codexFamily && strip(captured.frame).split("\n").some(row => /^\s*shift\s*\+\s*←\s+edit last queued message\s*$/.test(row)))) {
        sampleWhy = "the frame reads a running turn, not an idle composer";
        return null;
      }
      const visibleId = visibleSentinelId(captured.frame, command, false);
      if (visibleId === null) return null;
      if (!composerHoldsExactly(captured.frame, command, text)) return null;
      return { id: visibleId, state: detectAgentState(command, strip(captured.frame), title.title, codexFamily).agentState, frame: captured.frame };
    };
    const first = sample();
    if (first === null && sampleWhy) {
      return refuse(`${sampleWhy}; no keys sent`);
    }
    if (first === null || first.id !== stuckFull || !agentAtRest(first.state)
      || sentinelSubmitDecision(first.frame, command, text, false).action !== "submit") {
      return refuse(`pane '${pane}' is not positively idle holding one submit-safe staged wire; no keys sent`);
    }
    fx.settle(0.2);
    const second = sample();
    if (second === null && sampleWhy) {
      return refuse(`${sampleWhy} on the second sample; no keys sent`);
    }
    if (second === null || second.id !== stuckFull || !agentAtRest(second.state)
      || sentinelSubmitDecision(second.frame, command, text, false).action !== "submit") {
      return refuse("the staged wire was not stable across two idle samples; no keys sent");
    }
    // Class, not identity: corroboration refuses only an observed wire that
    // provably addresses another recipient; a different well-formed wire still
    // gets the one Enter — `tap read` resolves or reports it settled.
    const check = authorize(pane, bound, fx, authority);
    if (check.status !== "ok") return check;
    let evidence;
    try {
      evidence = corroborateExistingSentinel({ wire: parsed.fields.wire, id: stuckId,
        idTeam: stuckFull.includes("/") ? stuckFull.slice(0, stuckFull.indexOf("/")) : "",
        recipient: parsed.fields.to,
        payloads: join(authority.busHome ?? "", "payloads"), busHome: authority.busHome ?? "",
        registry: authority.registryPath ?? "", handle: bound?.handle ?? authority.recipient ?? "", pane,
        actor: authority.eventContext?.actor ?? "courier", eventLog: authority.eventContext?.log ?? join(authority.busHome ?? "", "registry-events.log"),
        eventTeam: authority.eventContext?.team ?? "", verb: authority.eventContext?.verb ?? "tap" });
    } catch (error) { return refuse(`staged sentinel corroboration failed: ${error}`); }
    if (evidence.verdict === "disagrees") {
      return { status: "identity_mismatch", detail: "staged sentinel addresses another recipient" };
    }
    // Credit only the bus-qualified identity — with one exception the wire
    // form cannot distinguish: renderSentinel qualifies the id (senderTeam/X)
    // on cross-team sends, and cross-team spool redelivery renders that form
    // even when the team is OURS (sentinel.ts:76, spool-drain-effects.ts:251).
    // corroboration resolves that wire back to this bus, so a basename match
    // whose bus is this bus is this row's own wire; only a basename match on
    // a genuinely different bus is foreign. realpath absorbs symlinked bus
    // spellings; a raw comparison is the fallback when resolution fails.
    const sameBus = () => {
      try { return realpathSync(evidence.bus) === realpathSync(authority.busHome!); }
      catch { return evidence.bus === authority.busHome; }
    };
    const ownWire = stuckFull === id || (stuckId === id && sameBus());
    // The admission: minted after the authorize and the two-sample check,
    // immediately before the key (verifyStaged's admit hook fires between
    // submitStagedLocked's final authorize/fence and pressEnter). The license
    // names the wire that actually receives the Enter, on that wire's own bus:
    // when the staged wire belongs to another entry, BOTH observations are
    // spent — the staged wire's (its bus, its basename) and this row's — so
    // the discovering row and the wire's own staged-idle row can never each
    // fire an Enter on the same observation. The mint takes reset custody and
    // can block, so the composer is revalidated AFTER it, immediately before
    // the key: a license spent on a refused recheck is the safe direction —
    // human input always wins.
    const admit = (): SubmitResult | null => {
      if (!ownWire) {
        const foreign = beginIdleSubmit(evidence.bus, stuckId, { stagedId: stuckFull, pane, agentState: second.state });
        if (foreign !== "created") return refuse("this staged observation was already licensed on its own bus; no keys sent");
      }
      const minted = beginIdleSubmit(authority.busHome!, id, { stagedId: stuckFull, pane, agentState: second.state, retry: authority.attemptUuid });
      if (minted !== "created") return refuse("an idle-time Enter was already licensed for this staged observation; no keys sent");
      const recheck = sample();
      if (recheck === null || recheck.id !== stuckFull || !agentAtRest(recheck.state)
        || sentinelSubmitDecision(recheck.frame, command, text, false).action !== "submit") {
        return refuse("the composer changed while the idle-submit license was minted; no key sent");
      }
      return null;
    };
    process.stderr.write(`tap: idle-time submit of a staged sentinel (Enter only, no bytes) on '${pane}'${ownWire ? "" : ` — wire ${stuckFull}`}\n`);
    // Credit only the bus-qualified identity: a foreign team's wire that
    // happens to share our basename is a DIFFERENT wire — it gets the one
    // Enter under its own phases, never our .sent. Our own cross-team form
    // (senderTeam/X resolved here) is our wire and takes the credited path.
    if (ownWire) return verifyStaged(id, text, true, phase, admit);
    // Another entry's wire holds the composer: Enter it once under its own
    // phase rows, then return — this payload's fate stays with the hold's
    // disposition, never a fall-through to injecting ours.
    const submitterPreBusy = preBusy;
    const attempt = randomUUID(); let count = 0, sequence = 0;
    const existingPhase: typeof phase = (name, result) => {
      try { recordPhase(evidence.bus, { id: stuckId, attempt, phase: name, recipient: authority.recipient ?? "",
        enter_count: count, ordinal: sequence, result }); } catch { /* Diagnostics never authorize replay. */ }
    };
    const existing = verifyStaged(stuckId, text, true, existingPhase, admit, () => { sequence++; }, () => { count++; });
    preBusy = submitterPreBusy;
    existingPhase("verify-result", existing.status === "injected" ? "verified" : existing.status === "harness_queued" ? "queued" : "unverified");
    if (existing.status === "harness_queued") recordHarnessQueued(evidence.bus, stuckId);
    return { status: "unverified", detail: existing.status === "injected"
      ? "a different staged sentinel was submitted; this payload's wire was not visible — run tap nudge if it is still staged"
      : `a different staged sentinel did not submit (${existing.status}); input retained` };
  }
  // Default-deny (tap-rlebf.1): the --no-spool and queue-prefix arms below
  // inject past an unreadable input band, which they may do only on a screen a
  // rule classifies; an unclassified screen may be a prompt TAP cannot see.
  // A failed capture classifies nothing. Each call reads the current frame.
  const screenClassified = (): boolean => {
    const frame = fx.captureEscaped ? fx.captureEscaped(target, command) : (() => {
      const r = capturePane(pane, true, true);
      return r.code === 0 && !r.rateLimited ? { ok: true as const, frame: r.stdout } : { ok: false as const };
    })();
    return frame.ok && detectAgentState(command, frame.frame).agentState !== "unknown";
  };
  const noSpoolAttempt = (held: SubmitResult | null): boolean => held?.status === "band_busy" && held.bandState === "unobservable"
    && !!(authority?.deliveryFacts?.noSpool || authority?.forceNoPrompt) && NO_SPOOL_ATTEMPTS_ON.has(held.detail) && screenClassified();
  const queuePrefixRides = (held: SubmitResult | null): boolean => !!authority?.noPromptOk && held?.status === "band_busy"
    && held.detail !== APPROVAL_PROMPT_REASON && held.detail !== CODEX_HOOK_TRUST_REASON
    && held.detail !== OPENCODE_SHELL_MODE_REASON && held.detail !== CLAUDE_FEEDBACK_DRAFT_REASON && screenClassified();
  try {
    // THE URGENT INTERRUPT (U4). Ordered by the incumbent's first-effect rule
    // (tap-send.sh:1582-1760): a human decision on screen is never interrupted —
    // agy's permission overlay reads a plain capture, claude/codex read theirs
    // escape-sequenced (lib.sh:10924-10977); the red cue flashes on the direct
    // path's draft band (:1750); identity is re-authorized and the
    // possible-effect evidence minted (the FIRST interrupt key is a delivery
    // effect — never retried, held by receipts/<id>.attempted); then, and only
    // then, the interrupt keys fall.
    if (urgent && !updateSkipped) {
      // tap-rdy9n: the clear below never touches a [[TAP-anchored band, so a
      // sentinel already in the composer parks now, before an interrupt that
      // could not lead to delivery.
      if (band.state === "busy" && !("queued" in band && band.queued) && stagedSentinel(band.text, command)) {
        return bandBlocksSubmit(band, pane)!;
      }
      // Escape or C-c could erase a scrolled draft whose hidden rows no backup holds.
      if (band.state === "busy" && band.scrolled) {
        return { status: "band_busy", bandState: "busy", detail: `${CLAUDE_SCROLLED_DRAFT_REASON}; urgent interrupt withheld` };
      }
      // injection.behavior=wait promises a draft is never cleared, and Escape or C-c
      // clears one as surely as C-u does: park before any key (tap-ipex2). A config
      // that cannot be read preserves the draft too, as the clobber door does.
      if (band.state === "busy" && !("queued" in band && band.queued) && hasInputText(band.text)) {
        let behavior: string;
        try { behavior = injectionBehavior(); } catch (error) { behavior = String(error); }
        if (behavior !== "clobber") {
          return { status: "band_busy", bandState: "busy", detail: behavior === "wait"
            ? "injection.behavior=wait preserves human input; urgent interrupt withheld" : behavior };
        }
      }
      const fam = familyOf(command, authority?.agentFamilies ?? new Set<string>());
      const modalCapture = (escaped: boolean) => capturePane(pane, escaped, true);
      // Default-deny (tap-rlebf.1): an unreadable band on a screen no rule
      // classifies may be a prompt TAP cannot see. When that read would hold
      // the delivery anyway, hold before the interrupt key too, rather than
      // pressing Escape or C-c into it. A wedge that reads working keeps its key.
      const unreadHold = (screen: string): SubmitResult | null => {
        const unread = band.state === "unobservable" ? bandBlocksSubmit(band, pane) : null;
        // An unknown screen also closes the --no-spool and queue-prefix arms.
        if (unread?.status !== "band_busy") return null;
        return detectAgentState(command, screen).agentState === "unknown" ? unread : null;
      };
      if (fam === "agy") {
        const r = modalCapture(false);
        if (r.rateLimited) return { status: "rate_limited", detail: "tmux client budget exhausted before urgent interrupt" };
        if (r.code !== 0) return { status: "band_busy", bandState: "unobservable", detail: "no visible input prompt" };
        if (agyPermissionOverlay(r.stdout)) {
          return { status: "band_busy", bandState: "unobservable", detail: `pane '${pane}' is showing a permission prompt -> defer (urgent will not interrupt a pending decision)` };
        }
        const unread = unreadHold(r.stdout);
        if (unread) return unread;
      } else {
        // Every other family's interrupt key (Escape, C-c) would answer the dialog.
        const r = modalCapture(true);
        if (r.rateLimited) return { status: "rate_limited", detail: "tmux client budget exhausted before urgent interrupt" };
        if (r.code !== 0) return { status: "band_busy", bandState: "unobservable", detail: "no visible input prompt" };
        if (approvalPrompt(command, r.stdout)) {
          return { status: "band_busy", bandState: "unobservable", detail: codexHookTrust(command, r.stdout) ? CODEX_HOOK_TRUST_REASON : "approval prompt blocks urgent delivery; nothing submitted or cleared" };
        }
        if (fam === "claude" && claudeFeedbackOverlay(r.stdout)) return surfaceHold("feedback-draft");
        const unread = unreadHold(r.stdout);
        if (unread) return unread;
      }
      if (decision?.cue.initialStyle) {
        // Lead time before the interrupt key: a visible double blink while this submit holds the lock.
        flashPaneLocked({ home: authority?.busHome ?? "", pane, paneId: target, ownerId: id, style: `bg=${decision.cue.initialStyle}`, count: CLOBBER_BLINK.count }, CLOBBER_BLINK);
      }
      const interruptKeys = interruptKeysForFamily(fam);
      interruptDetails = { pane: target, harness: fam, method: interruptKeys.method,
        keys: interruptKeys.keys, cancellation: "unknown", tmux_confirmed: false };
      // Escape can erase the visible draft before the post-interrupt clear path
      // gets to observe it. Retain this snapshot before sending any abort key.
      // Backup is best effort and never grants or blocks interrupt authority.
      if (band.state === "busy" && !("queued" in band && band.queued) && hasInputText(band.text)) {
        try {
          if (!authority?.busHome) throw new Error("sender bus unavailable");
          interruptDetails.draft_backup = writeInputBackup({
            directory: join(authority.busHome, "input-backups"), handle: authority.recipient ?? id,
            payloadId: id, pane, paneId: target, paneCommand: command,
            inputHash: inputHash(band.text), recoveryPolicy: "interrupt", text: band.text,
            // Claude shows only its last rows; the clobber's clear chain may later prove the whole draft.
            scrolledRowsUnproven: familyOf(command, authority?.agentFamilies ?? new Set<string>()) === "claude",
          });
        } catch (error) {
          interruptDetails.draft_backup_error = error instanceof Error ? error.message : String(error);
        }
      }
      const beforeInterrupt = authorize(pane, bound, fx, authority);
      if (beforeInterrupt.status !== "ok") return beforeInterrupt;
      const interruptFence = paneEffectFence(authority);
      if (interruptFence) return interruptFence;
      // opencode double-Escapes; cursor interrupts with C-c; claude/codex/agy
      // Escape once; hermes is skipped — its bare un-prefixed inject IS the
      // interrupt.
      if (interruptKeys.keys.length > 0) {
        const refused = admitEffect();
        if (refused) return refused;
        if (phase("interrupt-intent", undefined, interruptDetails) === false) {
          return { status: "attempt_evidence_unwritable", detail: "interrupt disclosure unavailable; no interrupt keys sent" };
        }
        const pressed = fx.pressKeys ? fx.pressKeys(target, interruptKeys.keys) : pressKeys(target, interruptKeys.keys);
        if (pressed === "rate_limited") return { status: "rate_limited", detail: "tmux client budget exhausted before urgent interrupt" };
        if (!pressed) return { status: "unverified", detail: `interrupt input acceptance unconfirmed for pane '${pane}'` };
        phase("interrupt-sent", undefined, interruptDetails);
      }
      if (interruptDetails.draft_backup && band.state === "busy" && isPasteCollapse(command, band.text)) {
        // Deferred like the interrupt-emptied notice below (tap-xhb1l): the
        // Enter has not fallen yet. The sender's own stderr warning cannot
        // reach the composer, so it stays here.
        deferredDraft = { backup: interruptDetails.draft_backup, owner: beforeInterrupt.observation, incomplete: true };
        process.stderr.write(`${INCOMPLETE_DRAFT_NOTICE}\n`);
      }
      fx.settle(0.15);
      effectiveBand = fx.paneState(target, bound?.harness ?? "", command);
      // An interrupt's Escape that empties the composer never reaches the clobber
      // pipeline below, so the pre-key draft backup would stay silent. Record the
      // intent to send the owner the same backed-up notice — but only AFTER the
      // urgent submission has finished (verified or ended): a notice that lands
      // while the payload is still in flight invites the owner to start typing,
      // and the urgent path skips the pending-input holds before its Enter.
      // The finally below fires it once, worded incomplete when
      // the retained backup says capture_status: incomplete.
      if (!draftNoticeSent && !deferredDraft && interruptDetails.draft_backup && effectiveBand.state === "ready") {
        deferredDraft = { backup: interruptDetails.draft_backup, owner: beforeInterrupt.observation };
      }
      if (effectiveBand.state === "busy" && !stagedSentinel(effectiveBand.text, command) && !("queued" in effectiveBand && effectiveBand.queued)) {
        const beforeClear = authorize(pane, bound, fx, authority);
        if (beforeClear.status !== "ok") return unverifiedRefusal(beforeClear);
        const clearFence = paneEffectFence(authority);
        if (clearFence) return { status: "unverified", detail: clearFence.detail };
        if (!fx.clobber) return { status: "unverified", detail: "draft clear effects are unavailable; input preserved" };
        const refused = admitEffect();
        if (refused) return refused;
        const cleared = fx.clobber(target, command, bound, {
          directory: join(authority!.busHome!, "input-backups"), handle: authority?.recipient ?? id,
          payloadId: id, pane, paneId: target,
          retained: interruptDetails.draft_backup && band.state === "busy"
            ? { path: interruptDetails.draft_backup, text: band.text } : undefined,
        });
        if (cleared.kind === "possible-failure" && "cause" in cleared.result && cleared.result.cause === "pane_dead") return unverifiedRefusal(cleared.result);
        if (cleared.kind !== "cleared" && cleared.kind !== "residue") {
          return { status: "unverified", detail: "detail" in cleared ? cleared.detail
            : cleared.kind === "possible-failure" ? cleared.result.detail : "paste-collapse draft persists after clear attempts" };
        }
        draftBackup = cleared;
        // The shared door retains the draft backup and explicitly permits residue.
        effectiveBand = cleared.kind === "residue" ? { state: "ready" } : fx.paneState(target, bound?.harness ?? "", command);
      }
    }
    // The drain may continue its own staged wire, or submit an older wire first.
    // Existing native send callers retain their draft-preserving default.
    if (!urgent && (authority?.preserveDraft === false || authority?.reprobeOnly)) {
      const text = effectiveBand.state === "busy" ? effectiveBand.text : "";
      const parsed = text ? parseStuckSentinel(text, command) : null;
      const stuck = parsed?.ok ? parsed.fields : null;
      // tap-1ncs6: a wire whose head scrolled out of the composer has no opener
      // to parse and no id to corroborate. Its shape alone says it is safe to
      // submit: Enter on a stale or different sentinel is harmless (the
      // recipient's tap read handles or refuses it), and nothing is re-injected.
      // The wire is recognized by its END: an anchored opener that never closes
      // (a cut paste) stays parked below, as before.
      const scrolledTail = !stuck && !!text && !authority.reprobeOnly && stagedSentinel(text, command) && closedSentinelInput(text);
      const stuckId = stuck?.id.slice(stuck.id.lastIndexOf("/") + 1);
      if (authority.reprobeOnly && (!authority.busHome || !pendingReprobe(authority.busHome, id)
        || stuckId !== id || !agyReprobeInputMatches(text, sentinel))) {
        return { status: "unverified", cause: "staged_absent", detail: "re-probe does not see the evidenced staged wire; no keys sent" };
      }
      if (stuck && stuckId) {
        const check = authorize(pane, bound, fx, authority);
        if (check.status !== "ok") return check;
        let evidence;
        try {
          evidence = corroborateExistingSentinel({ wire: stuck.wire, id: stuckId,
            idTeam: stuck.id.includes("/") ? stuck.id.slice(0, stuck.id.indexOf("/")) : "", recipient: stuck.to,
            payloads: join(authority.busHome ?? "", "payloads"), busHome: authority.busHome ?? "",
            registry: authority.registryPath ?? "", handle: bound?.handle ?? authority.recipient ?? "", pane,
            actor: authority.eventContext?.actor ?? "courier", eventLog: authority.eventContext?.log ?? join(authority.busHome ?? "", "registry-events.log"),
            eventTeam: authority.eventContext?.team ?? "", verb: authority.eventContext?.verb ?? "tap" });
        } catch (error) { return { status: "unverified", detail: `staged sentinel corroboration failed: ${error}` }; }
        if (evidence.verdict === "disagrees") return { status: "identity_mismatch", detail: "staged sentinel addresses another recipient" };
        const admission = authority.reprobeOnly ? () => null : admitEffect;
        if (stuckId === id) return verifyStaged(id, text, true, phase, admission);
        // The existing sentinel's verification harvests its own earliest-read
        // evidence into the shared seed; restore ours so this payload's relabel
        // decides on its own landing sample (tap-ho6pk).
        const submitterPreBusy = preBusy;
        const attempt = randomUUID(); let count = 0, sequence = 0;
        const existingPhase: typeof phase = (name, result) => {
          try { recordPhase(evidence.bus, { id: stuckId, attempt, phase: name, recipient: authority.recipient ?? "",
            enter_count: count, ordinal: sequence, result }); } catch { /* Diagnostics never authorize replay. */ }
        };
        const existing = verifyStaged(stuckId, text, true, existingPhase, admission, () => { sequence++; }, () => { count++; });
        preBusy = submitterPreBusy;
        existingPhase("verify-result", existing.status === "injected" ? "verified" : existing.status === "harness_queued" ? "queued" : "unverified");
        if (existing.status === "harness_queued") recordHarnessQueued(evidence.bus, stuckId);
        else if ((existing.status === "unverified" || existing.status === "band_busy") && existing.cause === "pane_dead") return unverifiedRefusal(existing);
        else if (existing.status !== "injected") return { status: "unverified", detail: "existing sentinel did not submit; input retained" };
        effectiveBand = fx.paneState(target, bound?.harness ?? "", command);
      } else if (scrolledTail) {
        const check = authorize(pane, bound, fx, authority);
        if (check.status !== "ok") return check;
        process.stderr.write(`tap: composer of '${pane}' holds the scrolled tail of a TAP wire; submitting it before this delivery (recognized by shape, not identity)\n`);
        // The tail is its own expected text: every recheck compares the visible
        // band to it whole, and Enter is verified by the band clearing. No id is
        // known, so no phase evidence is filed for it; ours is restored below.
        const submitterPreBusy = preBusy;
        const existing = verifyStaged("", text, true, () => {}, authority.reprobeOnly ? () => null : admitEffect, () => {}, () => {});
        preBusy = submitterPreBusy;
        if ((existing.status === "unverified" || existing.status === "band_busy") && existing.cause === "pane_dead") return unverifiedRefusal(existing);
        if (existing.status !== "injected" && existing.status !== "harness_queued") return { status: "unverified", detail: "scrolled sentinel tail did not submit; input retained" };
        effectiveBand = fx.paneState(target, bound?.harness ?? "", command);
      } else if (sentinelShapedInput(text)) {
        // A read-only refusal keeps spool custody retryable; prior effects still forbid replay.
        return { status: attemptAdmitted ? "unverified" : "band_busy", detail: "unparseable TAP input retained; no keys sent" };
      } else if (effectiveBand.state === "busy" && !("queued" in effectiveBand && effectiveBand.queued)) {
        const check = authorize(pane, bound, fx, authority);
        if (check.status !== "ok") return check;
        const fence = paneEffectFence(authority);
        if (fence) return fence;
        if (!fx.clobber) return { status: "band_busy", detail: "draft clear effects are unavailable; input preserved" };
        let refusal: SubmitResult | null = null;
        let flashed = false;
        const beforeEffect = () => {
          let check = authorize(pane, bound, fx, authority);
          refusal = check.status !== "ok" ? check : paneEffectFence(authority)
            ?? copyModePreEffect(fx.copyMode?.(target), pane) ?? admitEffect();
          if (!refusal && !flashed && check.status === "ok") {
            draftOwner = check.observation;
            // Lead time before the first C-u (tap-ipex2): the human sees about a second of red first.
            flashPaneLocked({ home: authority.busHome ?? "", pane, paneId: target, ownerId: id, style: "bg=red", count: CLOBBER_BLINK.count }, CLOBBER_BLINK);
            flashed = true;
            // The cosmetic effect also reads the pane; retain the final binding check at the clear key.
            check = authorize(pane, bound, fx, authority);
            refusal = check.status !== "ok" ? check : paneEffectFence(authority);
          }
          return refusal === null;
        };
        const cleared = fx.clobber(target, command, bound, { directory: join(authority.busHome ?? "", "input-backups"),
          handle: authority.recipient ?? id, payloadId: id, pane, paneId: target }, beforeEffect);
        if (refusal) return refusal;
        if (cleared.kind === "preserved" && !attemptAdmitted) return { status: "band_busy", bandState: "busy", detail: cleared.detail };
        if (cleared.kind === "possible-failure" && "cause" in cleared.result && cleared.result.cause === "pane_dead") return unverifiedRefusal(cleared.result);
        if (cleared.kind === "chip-residue" && cleared.backupPath) {
          notifyDraft(true);
          process.stderr.write(`${INCOMPLETE_DRAFT_NOTICE}\n`);
        }
        if (cleared.kind !== "cleared" && cleared.kind !== "residue") return { status: "unverified", detail: "draft could not be cleared; backup retained" };
        draftBackup = cleared;
        if (cleared.backupPath && (cleared.chip || command.startsWith("opencode"))) notifyDraft();
        effectiveBand = cleared.kind === "residue" ? { state: "ready" } : fx.paneState(target, bound?.harness ?? "", command);
      }
    }
    let blocked = bandBlocksSubmit(effectiveBand, pane);
    // `--no-spool` (CONTRACT §tap send --no-spool; lib.sh:11774's rc-3 arm): an
    // AMBIGUOUS observation — the composer geometry could not be read — permits
    // the one direct attempt; every positive hold keeps refusing. The precondition
    // is POSITIVE: `toPaneBand` collapses eight classifications into
    // `unobservable` (pane-state.ts:171-180), and three of them are a human's
    // pending decision (a Claude/Codex approval prompt, the Claude feedback
    // dialog, the Antigravity permission overlay — lib.sh's rc 4, never typed
    // over), so "unobservable" alone would inject into an approval prompt. Only
    // the geometry-unreadable reasons qualify; an unlisted reason holds. The
    // coupling to pane-state.ts's reason strings is deliberate and FAILS CLOSED:
    // an edited reason string stops this arm rather than widening it. The
    // list is a workaround for the collapse, not the contract — it retires when
    // `PaneBand` carries the rc 3 / rc 4 distinction (lane B, B2b convergence,
    // tap-b8qp5). OpenCode's composer-absent reason is deliberately absent (its
    // `booting` hold). Named hunk from lane D (D3a) in lane B's engine, under
    // B's per-unit read.
    if (blocked?.status === "band_busy" && blocked.cause === "pane_dead") return attemptAdmitted ? unverifiedRefusal(blocked) : blocked;
    if (noSpoolAttempt(blocked)) {
      process.stderr.write("tap: explicit --no-spool attempt with no readable input band -> injecting\n");
      blocked = null;
    }
    // The queue-prefix harness (lib.sh:10871 `no_prompt_ok="$qprefix"`): the
    // `/queue ` prefix QUEUES over pending input instead of clobbering it, so
    // the incumbent skips the pending-input hold entirely whenever the prefix
    // rides — only a positive gone / rate-limited / copy-mode keeps refusing.
    // U4 drops the prefix for urgent, but the hermes bypass STAYS: the caller
    // still reports no_prompt_ok for hermes because its bare un-prefixed inject
    // is itself the interrupt (lib.sh:10871 captures no_prompt_ok from the
    // prefix before the urgent path zeroes it).
    // A recognized approval prompt is a human decision, not a missing prompt.
    if (queuePrefixRides(blocked)) blocked = null;
    if (blocked) {
      const mid = copyModeResample(fx.copyMode?.(target), pane);
      // Copy-mode / gone / rate-limited replace a blocked band. Mid
      // unobservable must not relabel pane_gone or rate_limited as band_busy.
      if (mid) return mid;
      return blocked.status === "band_busy" && decision?.action === "park" ? { ...blocked, disposition: decision } : blocked;
    }
    // The queue prefix rides over the disposition hold too: the incumbent's
    // band read of a queue-prefix pane answers unobservable and its slice then
    // injects (delivery-disposition pins "hermes unobservable injects"), so the
    // measured bash outcome for prefix + occupied composer is DELIVER, not park.
    if (decision?.action === "park" && !authority?.noPromptOk) return { status: "band_busy", disposition: decision, detail: "delivery deferred by recipient disposition" };

    const beforeInject = authorize(pane, bound, fx, authority);
    if (beforeInject.status !== "ok") return beforeInject;
    command = readerCommand(beforeInject.observation);
    const fenced = paneEffectFence(authority);
    if (fenced) return fenced;
    const finalCopy = copyModePreEffect(fx.copyMode?.(target), pane);
    if (finalCopy?.status === "band_busy" && finalCopy.cause === "pane_dead" && attemptAdmitted) return unverifiedRefusal(finalCopy);
    if (finalCopy) return finalCopy;
    const finalBand = fx.paneState(target, bound?.harness ?? "", command);
    if (finalBand.state === "unobservable" && finalBand.cause === "pane_dead") {
      return { status: attemptAdmitted ? "unverified" : "band_busy", cause: "pane_dead", detail: finalBand.reason };
    }
    // Shell input and a feedback draft are never chat delivery targets, even after an authorized interrupt.
    if (finalBand.state === "unobservable" && (finalBand.cause === "shell-mode" || finalBand.cause === "feedback-draft")) return surfaceHold(finalBand.cause);
    if (auto && finalBand.state !== "ready") {
      return { status: "band_busy", detail: "auto seat band changed before paste" };
    }
    // Default-deny (tap-rlebf.1): the last read before paste may find the band
    // unreadable on a screen no rule classifies, even after an earlier read
    // passed. Delivery holds there under every authority: no wire, no Enter.
    if (finalBand.state === "unobservable" && !screenClassified()) {
      const detail = "no rule classifies the frame before paste; delivery holds";
      return attemptAdmitted ? { status: "unverified", detail } : { status: "band_busy", bandState: "unobservable", detail };
    }
    if (!urgent && !authority?.noPromptOk) {
      const late = bandBlocksSubmit(finalBand, pane);
      const geometryAttempt = late?.status === "band_busy" && late.bandState === "unobservable"
        && (authority?.deliveryFacts?.noSpool || authority?.forceNoPrompt) && NO_SPOOL_ATTEMPTS_ON.has(late.detail);
      if (late && !geometryAttempt) return late;
    }
    // The readiness reads above are tmux round-trips, and the registry can rebind
    // (or the pane be replaced) while they run. Authorize again at the paste
    // boundary itself, before the attempt is admitted, so a change refuses as a
    // pre-effect identity_mismatch instead of pasting into the old pane (tap-wudl2).
    const beforePaste = authorize(pane, bound, fx, authority);
    if (beforePaste.status !== "ok") return beforePaste;
    command = readerCommand(beforePaste.observation);
    // Admit at the first real effect, including Hermes's interrupt-by-injection.
    // On the typed arm that effect is the prefix's first keystroke.
    const bracketed = (bound?.harness || command).split("/").pop() === "opencode";
    if (typedPrefix !== undefined || !bracketed) {
      const refused = admitEffect();
      if (refused) return refused;
    }
    if (typedPrefix !== undefined) {
      const verified = typedControlLocked(typedPrefix);
      return verified.status === "injected" || verified.status === "harness_queued" ? restoreDraft(verified) : verified;
    }
    let pasteRefusal: Exclude<AuthorizeResult, { status: "ok" }>
      | ReturnType<typeof paneEffectFence>
      | Extract<SubmitResult, { status: "attempt_evidence_unwritable" }> = null;
    // Track effect admission even for callers without durable receipt authority.
    // A denial after an earlier chunk or interrupt cannot become retryable again.
    let pasteEffectPossible = attemptAdmitted || interruptDetails !== undefined;
    const authorizePaste = () => {
      const permitted = authorize(pane, bound, fx, authority);
      pasteRefusal = permitted.status === "ok" ? paneEffectFence(authority) : permitted;
      return pasteRefusal === null;
    };
    const injected = fx.injectText(target, sentinel, bracketed,
      () => authorizePaste() ? true : pasteRefusal?.status === "rate_limited" ? "rate_limited" : false,
      () => {
        const refused = admitEffect(authorizePaste);
        if (refused) pasteRefusal = refused;
        if (pasteRefusal) return false;
        pasteEffectPossible = true;
        return true;
      });
    if (pasteRefusal && !pasteEffectPossible) return pasteRefusal;
    if (injected === "rate_limited") {
      if (bracketed && pasteEffectPossible) return { status: "unverified", detail: "tmux client budget exhausted after an earlier pane effect" };
      return { status: "rate_limited", detail: "tmux client budget exhausted before sentinel injection" };
    }
    if (!injected) return { status: "unverified", detail: `sentinel injection did not complete on '${target}'` };

    // A full visible wire is landing evidence even if the older id-only input
    // adapter cannot read this harness's band (notably OpenCode's left border).
    let fullTextLanded = false;
    const sampleLanding = (): InputObservation => {
      const landingFrame = fx.submitFrame?.(target, command, sentinel, !!bound?.harness, auto);
      preBusy ??= landingFrame?.busy;
      if (landingFrame?.state === "staged") {
        fullTextLanded = true;
        return { state: "present", text: sentinel };
      }
      // tap-dl3 / lib.sh:11507-11521: a queue-prefix harness renders its band
      // WITHOUT a prompt glyph, so the glyph-anchored reader false-negatives the
      // landed '/queue <sentinel>' line; no_prompt_ok re-checks glyph-less and a
      // positive observation proves the inject landed and submits.
      if (authority?.noPromptOk) {
        const band = fx.paneState(target, bound?.harness ?? "", command);
        if (band.state === "busy" && band.text.includes(sentinel)) return { state: "present", text: sentinel };
        if (band.state === "unobservable" && band.cause === "pane_dead") return band;
        if (band.state === "gone") return { state: "gone" };
      }
      const input = sampleInput(fx, target, command, id);
      // agy paints a paste progressively (about 4.5 ms per character, tap-aimey):
      // its id shows before the wire is whole, and an Enter judged on that
      // partial frame never comes. Only the full staged wire lands on agy.
      // Codex paints the same way mid-turn: a wire cut mid-word read `changed`
      // on the first Enter attempt, so no injected-text-confirmed row was ever
      // written and no staged-idle hold could follow (tap-2ajq8).
      if (progressivePaste && input.state === "present") { partialIdSeen = true; return { state: "absent" }; }
      return input;
    };
    const progressivePaste = (command === "agy" || /^codex(?:-|$)/.test(command)) && !!fx.submitFrame;
    let partialIdSeen = false;
    // Measured slope doubled plus a second, capped: 140 chars ~2.1 s, 400 ~4.2 s.
    const landingSamples = progressivePaste ? Math.ceil(Math.min(10, 1 + 0.008 * sentinel.length) / 0.1) : 10;
    let landed = false;
    for (let i = 0; i < landingSamples; i++) {
      const sample = sampleLanding();
      if (sample.state === "unobservable" && sample.cause === "pane_dead") return { status: "unverified", cause: "pane_dead", detail: sample.reason };
      if (sample.state === "present") { landed = true; break; }
      if (sample.state === "gone") {
        return { status: "unverified", detail: `pane '${target}' gone during land` };
      }
      if (sample.state === "rate_limited") {
        return { status: "unverified", detail: sample.reason };
      }
      fx.settle(0.1);
    }
    if (!landed) {
      const extra = sampleLanding();
      if (extra.state === "unobservable" && extra.cause === "pane_dead") return { status: "unverified", cause: "pane_dead", detail: extra.reason };
      if (extra.state === "present") landed = true;
      else if (extra.state === "gone") {
        return { status: "unverified", detail: `pane '${target}' gone during land` };
      } else if (extra.state === "rate_limited") {
        return { status: "unverified", detail: extra.reason };
      }
    }
    if (!landed && partialIdSeen) {
      return { status: "unverified", detail: `${command === "agy" ? "agy" : "Codex"} composer on '${pane}' shows our sentinel id but never the full wire; not submitted, and the input may be partial` };
    }
    if (!landed) {
      const after = authorize(pane, bound, fx, authority);
      if (after.status !== "ok") return unverifiedRefusal(after);
      return { status: "unverified", detail: `input did not land on '${pane}'` };
    }

    const verified = verifyStaged(id, sentinel, fullTextLanded);
    if (verified.status !== "injected" && verified.status !== "harness_queued") return verified;
    return restoreDraft(verified);
  } finally {
    // The deferred urgent-path notice fires here — after the submission is
    // verified or ended, whatever the outcome, early post-interrupt refusals
    // included (tap-xhb1l). Firing it earlier would invite the
    // owner to type into a composer the urgent path is about to paste onto
    // and submit.
    if (deferredDraft && !draftNoticeSent) {
      const deferred = deferredDraft;
      deferredDraft = null;
      draftOwner = deferred.owner;
      let incomplete = !!deferred.incomplete;
      if (!incomplete) {
        try { incomplete = inputBackupIncomplete(readFileSync(deferred.backup, "utf8")); }
        catch { /* unreadable backup still earns the plain backed-up notice */ }
      }
      notifyDraft(incomplete);
    }
  }

  /**
   * The typed arm (tap-lmbs): the command token as keystrokes, then the payload
   * in small chunks, then the ordinary staged Enter loop on the whole control.
   * After the first key every refusal is `unverified` — a retry would type onto
   * a partial composer (fable N1).
   */
  // N1 for thrown failures too: once the first prefix key may have reached the
  // composer, a tmux server that stops answering is unverified, never a generic
  // failure a caller could retry onto a partial composer. Nothing is replayed.
  function typedControlLocked(prefix: string): SubmitResult {
    try { return typedControlBody(prefix); } catch (error) {
      if (!(error instanceof ServerUnresponsive)) throw error;
      return { status: "unverified", detail: `tmux stopped answering after the typed prefix may have reached '${pane}' (${error.message}); nothing replayed` };
    }
  }

  function typedControlBody(prefix: string): SubmitResult {
    const unverified = (detail: string): SubmitResult => ({ status: "unverified", detail });
    const recheck = (): Extract<SubmitResult, { status: "unverified" }> | null => {
      const check = authorize(pane, bound, fx, authority);
      if (check.status !== "ok") return unverifiedRefusal(check);
      command = readerCommand(check.observation);
      const fence = paneEffectFence(authority);
      return fence ? unverifiedRefusal(fence) : null;
    };
    const typed = fx.injectText(target, prefix);
    if (typed !== true) return unverified(`pane '${target}' did not take the typed prefix`);
    fx.settle(0.2);
    const afterPrefix = recheck();
    if (afterPrefix) return afterPrefix;
    // send-keys succeeding is not proof the prefix rendered; a dropped prefix
    // behind a landed payload submits as plain prose. The prompt line compares
    // without the one trailing space, and the region must carry no second
    // typed row: a wrapped draft shows the bare token on the prompt line.
    const line = fx.promptInput!(target, command);
    const want = prefix.slice(0, -1);
    if (line.status !== "text" || line.text !== want) {
      return unverified(`typed prefix did not render in '${pane}' before payload injection (want '${want}', saw '${line.status === "text" ? line.text : line.status}')`);
    }
    const region = fx.regionInput!(target, command);
    if (region.status !== "text" || !region.text || region.text.split("\n").slice(1).some(row => /[^\s]/.test(row))) {
      return unverified(`input region carries an unclassified row past the typed prefix in '${pane}'`);
    }
    const chunks = controlPayloadChunks(sentinel);
    if (chunks.join("") !== sentinel) return unverified("invalid control chunk plan; Enter withheld");
    // Every chunk is read back before the next one goes in: the visible rows
    // must be a suffix of what has been typed so far and end with this chunk.
    // A scrolled viewport hides the head and middle at Enter time, so the
    // proof of those bytes is this chain of overlapping windows, not the
    // final frame (tap-vho8h). A chunk that never renders contiguously
    // withholds Enter with the text left in place.
    let typedSoFar = prefix;
    for (let i = 0; i < chunks.length; i++) {
      const denied = recheck();
      if (denied) return denied;
      if (fx.injectText(target, chunks[i]!) !== true) return unverified(`pane '${target}' did not take control chunk ${i + 1}/${chunks.length}`);
      typedSoFar += chunks[i]!;
      let landed = { ready: false, renderedBytes: 0 };
      for (let sample = 0; sample < 6 && !landed.ready; sample++) {
        fx.settle(sample === 0 ? 0.2 : 0.1);
        const late = recheck();
        if (late) return late;
        const rendered = fx.regionInput!(target, command);
        landed = controlChunkLanded(command, rendered.status === "text" ? rendered.text : "", typedSoFar, chunks[i]!);
      }
      if (!landed.ready) {
        return unverified(`control chunk ${i + 1}/${chunks.length} did not render contiguously in '${pane}' (rendered_bytes=${landed.renderedBytes}); Enter withheld; the typed text stays in the composer`);
      }
    }
    // A chip is opaque: it is refusal, never evidence the tail arrived.
    let tail = { ready: false, renderedBytes: 0, expectedBytes: Buffer.byteLength(sentinel) };
    for (let sample = 0; sample < 6 && !tail.ready; sample++) {
      const denied = recheck();
      if (denied) return denied;
      const rendered = fx.regionInput!(target, command);
      tail = controlTailReady(command, rendered.status === "text" ? rendered.text : "", sentinel);
      if (!tail.ready) fx.settle(0.1);
    }
    if (!tail.ready) {
      return unverified(`control tail absent/opaque in '${pane}' (rendered_bytes=${tail.renderedBytes} expected_bytes=${tail.expectedBytes}); Enter withheld`);
    }
    const control = prefix + sentinel;
    let enters = 0;
    // Only a positively unsent Enter (rate-limited) comes off the count: any
    // other failed Enter may have reached the pane, so take-back stays off.
    const result = verifyStaged(id, control, true, phase, () => null, nextOrdinal, () => { enters++; entered(); }, () => { enters--; });
    if (result.status === "injected" || result.status === "harness_queued") return result;
    if ((result.status === "unverified" || result.status === "band_busy") && result.cause === "pane_dead") return unverifiedRefusal(result);
    // An uncertain compact frame must not erase the control we just typed.
    // Leave the composer intact for inspection, without retrying any Enter.
    if (prefix === "/compact ") return unverified(`${result.detail}; the typed /compact stays in the composer of '${pane}': press Enter there to submit it or clear it; nothing is retyped and no Enter is retried`);
    // Other controls retain take-back while the band is still exactly ours.
    let refused = "";
    let deadRefusal: Extract<SubmitResult, { status: "unverified" }> | undefined;
    const permit = () => {
      const copy = copyModePreEffect(fx.copyMode?.(target), pane);
      const check = copy ? null : authorize(pane, bound, fx, authority);
      const denial = copy ?? check;
      if (denial?.status === "band_busy" && denial.cause === "pane_dead") deadRefusal = unverifiedRefusal(denial);
      refused = copy ? ("detail" in copy ? copy.detail : "copy mode") : check!.status !== "ok" ? check!.detail : paneEffectFence(authority)?.detail ?? "";
      return !refused;
    };
    const verdict = enters === 0 && fx.takeBack ? fx.takeBack(target, command, bound, id, control, permit) : "";
    const back = verdict ? `; take-back: ${refused ? `refused (${refused})` : verdict}` : "";
    return deadRefusal ?? unverified(`${result.detail}${back}`);
  }

  function restoreDraft(verified: SubmitResult): SubmitResult {
    if (draftBackup?.backupPath) {
      let restored = false, blank = false, incomplete = draftBackup.chip || !!draftBackup.incomplete;
      // Restoration is optional and runs after a verified submit: every read in
      // it, eligibility included, sits inside the one boundary, so a tmux
      // timeout here can never turn the verified result into a failure.
      try {
        // The file is the authority: a snapshot the clear chain could not prove stays manual (tap-ipex2).
        const raw = readFileSync(draftBackup.backupPath, "utf8");
        incomplete ||= inputBackupIncomplete(raw);
        // A complete backup of only blanks is nothing to restore and nothing to tell
        // the owner about; an incomplete one may hide text above its visible rows.
        blank = !incomplete && !hasInputText(inputBackupBody(raw));
        if (!blank && !incomplete && !command.startsWith("opencode") && fx.restoreInput &&
            fx.paneState(target, bound?.harness ?? "", command).state === "ready" && !paneEffectFence(authority)
            && authorize(pane, bound, fx, authority).status === "ok") {
          const text = inputBackupBody(raw);
          restored = restorePlainDraft(target, text, bound?.harness ?? "", command, fx,
            () => !paneEffectFence(authority) && authorize(pane, bound, fx, authority).status === "ok");
        }
      } catch { /* The retained backup remains the recovery authority. */ }
      process.stderr.write(restored ? `tap: input backup restored from retained file: ${draftBackup.backupPath}\n`
        : blank ? `${BLANK_DRAFT_NOTICE}\n`
        : incomplete ? `${INCOMPLETE_DRAFT_NOTICE}\n` : "tap: draft backed up — view + copy with: tap draft\n");
      if (!restored && !blank) { try { notifyDraft(incomplete); } catch { /* best-effort owner notice */ } }
    }
    return verified;
  }
}

/**
 * Bash polarity for a recipient clear marker: content is the signal, not
 * lock-held. Unreadable or malformed records are absent.
 *
 * A thin wrapper over the ONE reader. This used to hold a second copy of the
 * predicate, and the two had drifted: `Number()` is not `float()`, so a ceiling
 * of "1_000" or "infinity" read absent here and live at the Bash door, while
 * "0x10" read live here and absent there. The state is all this caller needs;
 * `readClearFence` also returns the record, which is what lets the Bash door
 * name the wedged clearer.
 *
 * Fail-open is applied HERE rather than inside the reader. A marker that cannot
 * be DECODED is a refusal at the reset door and a delivery here, so the reader
 * raises and each door chooses — folding it into "absent" would take that
 * choice away from both.
 */
export function inspectClearFenceRecord(busHome: string, handle: string): ClearFenceRead {
  try {
    return readClearFence(busHome, handle);
  } catch {
    return { state: "absent", rec: null };
  }
}

export function inspectClearFence(busHome: string, handle: string): ClearFenceState {
  return inspectClearFenceRecord(busHome, handle).state;
}

function paneEffectFence(
  authority?: SubmitAuthority,
): Extract<SubmitResult, { status: "team_reset_fenced" | "clearing" }> | null {
  if (!authority?.busHome) return null;
  const reset = resetFenceRefusal(authority.busHome, "tap send");
  if (reset) return { status: "team_reset_fenced", ...reset };
  const recipientBus = authority.recipientBusHome || authority.busHome;
  if (recipientBus !== authority.busHome) {
    const remoteReset = resetFenceRefusal(recipientBus, "tap send (recipient bus)");
    if (remoteReset) return { status: "team_reset_fenced", ...remoteReset };
  }
  if (!authority.recipient) return null;
  const clear = inspectClearFenceRecord(recipientBus, authority.recipient);
  if (clear.state === "live") {
    return { status: "clearing", detail: `seat '${authority.recipient}' is mid-clear` };
  }
  if (clear.state === "expired" && noticeExpiredAtSendDoor(recipientBus, authority.recipient, clear.rec)) {
    process.stderr.write(
      `tap send: WARNING: clear fence for ${authority.recipient} expired; delivering anyway (fail-open past the family await ceiling)\n`,
    );
  }
  return null;
}

export { renderSentinel };
