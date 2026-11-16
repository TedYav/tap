import { opencodeShellMode } from "./opencode-composer";
import { classifyPane, claudeFeedbackCard } from "./pane-state";
import { cardDismissSpent } from "./feedback-card-dismiss";
import { feedbackCardBehaviorOrHold } from "./injection-behavior";
import { refreshInputProtection } from "./input-protection";
import { codexUpdatePrompt } from "./codex-update";
// Native lazy readiness observations and their shared decision walk.
// Retained shell callers forward to this owner using the same selected tmux namespace.
import { classifyHarness, harnessFamily, agentFamilies } from "./observe";
import { identityUnobservable } from "./pane-identity";
import { pyInt, pyTruthy } from "./spool-publication";
import { pyStr } from "./digest-window";
import { deliveryBand, type DeliveryBand } from "./slices/delivery-disposition";
import { surveyAdmission } from "./agy-survey";
import { agyPermissionOverlay, agySurveyOverlay, composerInput } from "./submit-frame";
import { dimPromptInput, promptGlyph, textHasPasteCollapse } from "./pane/geometry";
import { captureInputFrame, escapedPromptFromFrame, frameIo, framePairIo, paneIo, pendingInputText } from "./pane/reader";
import { paneHarness } from "./pane-harness";
import { boundPaneIdentityState } from "./observe-gather";
import { tmux } from "./tmux";
import { hasInputText } from "./terminal-text";
import { fieldValue, readLoose } from "./watch-lease";
import { join } from "node:path";

/** Preserve the shallow-command fast path; a missing pid does not trigger a process walk. */
export function paneHarnessAt(pane: string, env: NodeJS.ProcessEnv = process.env,
  field: (pane: string, field: string, env: NodeJS.ProcessEnv) => string = paneField): string {
  const command = field(pane, "pane_current_command", env);
  const families = agentFamilies(env), family = harnessFamily(command, families);
  if (classifyHarness(family, families) !== "unsupported") return family;
  const pid = field(pane, "pane_pid", env);
  return pid ? paneHarness({ command, pane_pid: Number(pid) }, env) : family;
}

function paneField(pane: string, field: string, env: NodeJS.ProcessEnv): string {
  const r = tmux(["display-message", "-p", "-t", pane, `#{${field}}`], env);
  return r.code === 0 ? r.stdout.replace(/\n+$/, "") : "";
}

/**
 * The readiness driver's field read. A rate-limited tmux client never RAN the
 * command, so its non-zero rc is not an observation of absence: it throws, and
 * `readPaneReady`'s catch lands on `busy:decision-unavailable` (the hold). A
 * genuine tmux answer keeps the incumbent's reading — rc != 0 ("can't find
 * pane") and rc 0 with empty output stay a POSITIVE absence, which the walk
 * may read as `gone`. The rate limiter's own reply is the discriminator; the
 * same rule the capture path already follows (`observeInputRegion`'s
 * `rate_limited` status is distinct from its `unobservable` one).
 */
export function paneFieldReady(pane: string, field: string, env: NodeJS.ProcessEnv, run: typeof tmux = tmux): string {
  const r = run(["display-message", "-p", "-t", pane, `#{${field}}`], env);
  if (r.rateLimited) throw new Error(`tmux client rate limited before #{${field}} could be read`);
  return r.code === 0 ? r.stdout.replace(/\n+$/, "") : "";
}

export function readObservedBand(pane: string, harness: string, env: NodeJS.ProcessEnv = process.env): DeliveryBand {
  const io = paneIo(env), capture = captureInputFrame(io, pane, harness, true);
  return observedBand({ frame: capture.ok ? capture.frame : null, harness,
    paneWidth: harness.startsWith("claude") ? io.paneWidth(pane) : "" });
}

/**
 * Most families' pending reader returns only the prompt row, and a draft can sit
 * on a continuation row under an empty one. A prompt row that is blank under the
 * blanking rule therefore defers to the whole composer, read by `classifyPane`
 * from the escaped capture: a draft there holds, and its text is the pending text.
 * Only the escaped capture may supply a draft, because the plain one has lost the
 * dim styling that marks a harness's idle placeholder as chrome. A row of only
 * whitespace still admits the pane only when both captures classify ready (they
 * are separate observations); otherwise the row stays as read and holds.
 */
export function pendingTextFromFrames(text: string, escaped: string, plain: string, command: string,
  paneHeight?: () => number | undefined): string {
  if (hasInputText(text)) return text;
  // Claude's scrolled-draft witness needs the real pane height; read it only here,
  // when the visible composer is blank.
  const composer = classifyPane(escaped, command, false, command.startsWith("claude") ? paneHeight?.() : undefined);
  if (composer.kind === "draft") return composer.text;
  if (!text) return "";
  return composer.kind === "ready" && classifyPane(plain, command, false).kind === "ready" ? "" : text;
}

/** Drive the existing lazy walk in process; no later observation is fetched early. */
export function readPaneReady(prefix: ReadinessPrefix, home: string, env: NodeJS.ProcessEnv = process.env, nativeRouter = true): Readiness {
  const seen: ReadinessObservations = {}, io = paneIo(env), deps = doorDeps(env, home);
  try {
    for (let round = 0; round < 9; round++) {
      const step = readinessWalk(prefix, seen, deps);
      if (step.done) return step.verdict;
      switch (step.need) {
        case "identity": {
          seen.identity = boundPaneIdentityState(prefix.targetRegistry, prefix.handle, prefix.pane, prefix.paneId, env, nativeRouter);
          // A pane-wide operator hold applies only after this queue entry's binding
          // is verified; unrelated protection must not mask a stale recipient.
          if (seen.identity === "match") {
            try { if (refreshInputProtection(prefix.paneId, env)) return "busy:operator-wait"; }
            catch { return "busy:decision-unavailable"; }
          }
          break;
        }
        case "harness": seen.harnessCmd = paneHarnessAt(prefix.pane, env, paneFieldReady); break;
        case "pane-mode": seen.paneInMode = paneFieldReady(prefix.pane, "pane_in_mode", env); break;
        case "blocked-fields": {
          const arm = join(home, "watch/arm.json");
          seen.blocked = { map: fieldValue(readLoose(arm), "blocked_map") || "{}",
            exempt: fieldValue(readLoose(arm), "blocked_exempt") || "[]" };
          break;
        }
        case "in-turn-frame": case "survey-frame": {
          const frame = io.capture(prefix.pane, false, true);
          if (step.need === "in-turn-frame") seen.inTurnFrame = frame.code === 0 ? frame.stdout : "";
          else seen.surveyFrame = frame.code === 0 ? frame.stdout : "";
          break;
        }
        case "band": seen.band = readObservedBand(prefix.pane, seen.harnessCmd!, env); break;
        case "pending": {
          const command = seen.harnessCmd!;
          const escaped = captureInputFrame(io, prefix.pane, command, true);
          const plain = escaped.ok ? captureInputFrame(io, prefix.pane, command, false) : { ok: false as const };
          const width = command.startsWith("claude") ? io.paneWidth(prefix.pane) : "";
          // The Bash pair door refuses a failed capture before parsing. Its
          // per-harness failure polarity is part of readiness (modal is never forced).
          if (!escaped.ok || !plain.ok) {
            seen.pending = command.startsWith("claude") || command.startsWith("codex") ? { kind: "modal" }
              : { kind: "no-band" };
            break;
          }
          if (command === "codex" && codexUpdatePrompt(escaped.frame)) { seen.pending = { kind: "codex-update" }; break; }
          if (command.startsWith("opencode") && opencodeShellMode(escaped.frame)) { seen.pending = { kind: "shell-mode" }; break; }
          // A composer the feedback card hides holds; with the dismiss setting, an
          // idle-hint card not yet dismissed admits one licensed Escape (tap-89a57).
          if (command.startsWith("claude")) {
            const card = claudeFeedbackCard(escaped.frame);
            if (card && card.composer !== "visible") {
              const dismissible = card.composer === "hidden" && feedbackCardBehaviorOrHold(env) === "dismiss"
                && !cardDismissSpent({ paneId: prefix.paneId, panePid: paneFieldReady(prefix.pane, "pane_pid", env), card: card.card }, env);
              seen.pending = dismissible ? { kind: "feedback-card" } : { kind: "feedback-draft" };
              break;
            }
          }
          const pending = pendingInputText(framePairIo(escaped.frame, plain.frame, width), prefix.pane, command);
          // The overprint verdict is the detector's alone (tap-cl1es): the
          // bounded-healing decision lives in the drain's disposition, which
          // consults the pane's stuck-paint record.
          seen.pending = pending.status === "blocked" ? { kind: "modal" }
            : pending.status === "no-band" ? { kind: "no-band" }
            : pending.status === "overprint" ? { kind: "overprint-hold" }
            : { kind: "text", text: pendingTextFromFrames(pending.text, escaped.frame, plain.frame, command, () => {
              const height = paneFieldReady(prefix.pane, "pane_height", env);
              return /^[1-9]\d*$/.test(height) ? Number(height) : undefined;
            }) };
          break;
        }
      }
    }
  } catch { /* An unavailable observation never admits a submit. */ }
  return "busy:decision-unavailable";
}

/** One metadata snapshot remains bound to the readiness result used by the receipt. */
export function readDisplayState(metaPath: string, home: string, now: number, env: NodeJS.ProcessEnv = process.env, nativeRouter = true): DisplayState {
  if (!Number.isFinite(now) || !Number.isInteger(now)) return "unknown";
  let meta: unknown = null;
  try { meta = JSON.parse(readDoorFile(metaPath, "utf8")); } catch { /* Unreadable metadata. */ }
  const row = displayRow(meta, now);
  const verdict = row?.pane && row.paneId && row.target && row.targetRegistry
    ? readPaneReady({ ...row, handle: row.target }, home, env, nativeRouter) : "";
  return displayState(row, verdict);
}

/**
 * `tap_slice_delivery_disposition`'s band half, in process (a reviewer ruled this
 * composition lane A's: it has exactly two live callers — readiness, ported here, and
 * the send path, which closes with D's verb; lib.sh keeps the adapter until then).
 *
 * TWO INHERITED TRAPS, both named by that reviewer from B1's fix round:
 *
 * 1. A DEFINITE "NO CHIP" BLANKS A DIM PLACEHOLDER; AN UNREADABLE ANSWER MUST NOT.
 *    The incumbent is lib.sh:235-239 at the base, and the rc it keys on is 1, not 0:
 *
 *        tap_text_has_paste_collapse "$2" "$composer" || _pn_chip_rc=$?
 *        if [ "$_pn_chip_rc" -eq 1 ]; then composer=""; fi
 *
 *    rc 0 is "a chip IS present" (a real pasted draft — keep it), rc 1 is "no chip" (the
 *    painted idle placeholder — blank it), rc 2 is "could not read". The pre-B1 shape
 *    `! tap_text_has_paste_collapse` was wrong because in Bash `!` is true for rc 2 as
 *    well, so a reader that merely FAILED TO RUN blanked the composer in the
 *    inject-eligible direction. Keying on rc 1 exactly is the fix.
 *
 *    In process there is no third answer: `textHasPasteCollapse` is total, so
 *    `!textHasPasteCollapse(...)` IS rc 1 and nothing collapses into it. That is why the
 *    negation is correct here and why `pane/reader.ts:519` — the repo's own native
 *    equivalent of this branch — is written the same way.
 *
 *    An earlier version of this port read "only a positive rc 1 may blank it" as "only a
 *    positive CHIP may blank it" and dropped the negation, inverting the rule: a dim
 *    placeholder would have been kept as a draft and a real pasted chip blanked. Caught in review.
 *    Two REAL captures discriminate the two rules —
 *    `claude-code-idle.ansi` and `claude-code-session-limit.ansi` answer `bare` under this
 *    rule and `draft` under the inverted one — and the unit arm is written over them.
 *    (I first claimed no fixture in the repo discriminated; review found these at
 *    the gate.) No CODEX capture reaches the branch: `composerInput` strips codex's painted
 *    hint first, so its composer is empty — which is why the four-door differential, whose
 *    band door is codex-only, agreed on `codex idle -> ready` with the predicate inverted.
 * 2. A FAILED CAPTURE IS NOT AN IDLE BAND. The agy permission overlay and a capture the
 *    caller could not take both mean "the composer is absent", never "the band is bare".
 *
 * The caller hands over the ESCAPED frame it captured; this never derives a plain view
 * from it (`stripAnsi` strips CSI only, so an OSC 8 hyperlink around the prompt row
 * survives and the geometry reads as missing — B1's own P1).
 */
export interface BandFacts {
  /** The escaped capture, or null when the caller could not take one. */
  frame: string | null;
  harness: string;
  /** `#{pane_width}`, as the reader's geometry needs it. */
  paneWidth: string;
}

export function observedBand(facts: BandFacts): DeliveryBand {
  const { harness } = facts;
  if (facts.frame === null) return deliveryBand(null, harness, "");
  const frame = facts.frame;
  let present = true;
  let composer = "";
  // Hermes reads through the pending-input reader; every other harness through the
  // composer reader. `unknown`/`blocked` are the incumbent's rc 3/rc 4: composer absent.
  if (harness.startsWith("hermes")) {
    const pending = pendingInputText(frameIo(frame, facts.paneWidth), "", harness, frame);
    if (pending.status === "text") composer = pending.text; else present = false;
  } else {
    const read = composerInput(frame, harness);
    if (read.state === "text") composer = read.text; else present = false;
  }
  // Trap 2: a recognized permission overlay is a human being asked a question.
  if (harness === "agy" && agyPermissionOverlay(frame)) present = false;
  if (harness === "agy" && agySurveyOverlay(frame)) {
    if (surveyAdmission(frame) === "recoverable") { present = true; composer = ""; }
    else present = false;
  }
  // Trap 1: the chip test runs only over a composer that was actually read, and a DEFINITE
  // "no chip" over dim-prompt geometry is what blanks it — the incumbent's rc 1.
  if (composer) {
    const escaped = escapedPromptFromFrame(frame, harness);
    if (dimPromptInput(composer, escaped, promptGlyph(harness), harness) &&
        !textHasPasteCollapse(harness, composer)) {
      composer = "";
    }
  }
  return deliveryBand(present ? composer : null, harness, frame);
}

/**
 * Every `busy:*` subclass says WHY a live pane refused delivery, and the drain records
 * the subclass so a persistent-backlog CONDITION can fire on a wedge rather than on a
 * working suite. `busy:in-turn` is not `busy:noprompt`: noprompt means there is no band
 * to type into (an injection-safety fact), in-turn means there is one and the seat is
 * concentrating (a focus fact only `--polite` waits on). Merging them would be a bug.
 */
export type Readiness =
  | "recover:codex-update" // admits one licensed Skip attempt, never payload typing
  | "recover:feedback-card" // admits one licensed Escape that dismisses a Claude feedback card, then ordinary delivery
  | "busy:shell-mode"
  | "busy:feedback-draft" // Claude's feedback card hides the composer and is not to be dismissed: a human or the seat's leader clears it
  | "busy:operator-wait"
  | "ready"
  | "unsafe"
  | "gone"
  | "busy"
  | "busy:pending"      // typed text occupies the band (an unsubmitted wedge)
  | "busy:noprompt"     // no visible input chrome (heads-down suite / mid-turn)
  | "busy:booting"      // an OpenCode pane is live, its band not drawn yet
  | "busy:overprint"    // OpenCode debris survived one repaint; hold instead of re-resizing every tick (tap-vctb8)
  | "busy:modal"        // a recognized dialog is asking the SEAT's human a question
  | "busy:in-turn"      // POLITE ONLY: the seat is demonstrably mid-turn (tap-toi9)
  | "busy:clearing"     // a live clearing-fence marker; CONTENT, not lock-held
  | "busy:recovery"     // a recovery hold owns the pane, or the guard could not answer
  | "busy:queued"       // codex: a queue is a positive hold, never a draft
  | "busy:decision-unavailable"; // the band could not be decided; never read as a state

/** The reader's answer for this pane, as `tap_pending_input_text` reports it. */
export type PendingFact =
  | { kind: "codex-update" }
  | { kind: "feedback-card" }
  | { kind: "shell-mode" }
  | { kind: "feedback-draft" }
  | { kind: "text"; text: string }   // rc 0 with bytes: a draft occupies the band
  | { kind: "empty" }                // rc 0, no bytes: the band is bare
  | { kind: "no-band" }              // rc 3: nothing readable here
  | { kind: "modal" }                // rc 4: a POSITIVELY recognized dialog
  | { kind: "overprint-hold" };      // the detector saw an OpenCode overprint (tap-vctb8; bounded by tap-cl1es at the drain's disposition)

/** Prefix + every observation, for a caller that already has them all. */
export interface ReadinessFacts extends ReadinessPrefix {
  identity: string;
  harnessCmd: string;
  paneInMode: string;
  blockedMap: string;
  blockedExempt: string;
  /** The escaped capture used by the agy branches; "" when none was taken. */
  frame: string;
  /** `tap_pending_input_text`'s verdict for this pane. */
  pending: PendingFact;
  /** codex only: the observed band, or null when the disposition refused to decide. */
  band: DeliveryBand | null;
}

/** What readiness reads from the world that is NOT a pane observation. */
export interface ReadinessDeps {
  /** `tap_registry_matches_team`. */
  registryMatchesTeam(registryPath: string, expectedTeam: string): boolean;
  /** `recovery/cli.ts guard` — false when a hold owns the pane or the guard failed. */
  recoveryAllowed(paneId: string): boolean;
  /** `tap_clear_fence_inspect` — the state for this handle on the bound bus. */
  clearFenceState(targetRegistry: string, handle: string, toTeam: string): string;
  /** `spool-state.ts blocked-or-exempt`. */
  blockedOrExempt(handle: string, blockedMap: string, blockedExempt: string): boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * `tap_agy_seat_in_turn` (was lib.sh:8898): 0 iff the agy seat is DEMONSTRABLY mid-turn.
 *
 * A FOCUS predicate, and only that. It answers "would injecting now interrupt this seat's
 * train of thought", never "is it safe to type here" — two facts, and agy is where they
 * were fused. Before tap-92v3r the injection-safety gate refused every generating agy
 * pane, so `--polite` got focus protection for free and nobody had to write this; the
 * moment band presence became readiness, the focus fact needed its own reader.
 *
 * POSITIVE marker on the LAST RENDERED LINE: agy's footer carries `esc to cancel` while a
 * turn runs and `? for shortcuts` when it does not. Last-line-only is load-bearing —
 * `esc to cancel` occurs in ordinary transcript text (this repo discusses it), and a
 * whole-pane match would pin a seat that merely MENTIONED it to in-turn forever, which is
 * the defect tap-4n5h fixed for claude.
 *
 * It reads the footer rather than the task card on purpose. %228 (2026-09-03,
 * smoke/fixtures/agy-capture-20260903) has a background task running, its card rendered
 * below the band, and the idle footer: the agent is idle while its task runs. A task-card
 * reader would call that seat mid-turn and park polite mail behind a background job the
 * seat is not waiting on.
 */
export function agyInTurnFromFrame(frame: string): boolean {
  const rows = frame.split("\n").filter((row) => row.trim() !== "");
  const last = rows[rows.length - 1];
  return last !== undefined && /esc to cancel/.test(last);
}

/**
 * `tap_spool_pane_ready`, in its incumbent order — AND the door, which is the same walk.
 *
 * ONE ROUND TRIP PER OBSERVATION THE INCUMBENT ACTUALLY TOOK. The incumbent returns
 * `gone`, `unsafe` and `busy` BEFORE it captures anything, and the branches that do
 * capture take a different observation each (the in-turn frame, the survey frame, the
 * codex band, the reader's verdict). A caller that gathered all of them up front would
 * put tmux traffic on panes the incumbent never touched — an observable change in the
 * wrong direction. So the walk stops at the first observation it has not been given and
 * NAMES it; the caller fetches exactly that one thing and asks again. The caller never
 * decides which observation to take, and the order of the refusals above it is the
 * contract: identity before recovery, recovery before the fence, the fence before any
 * harness question, the harness before the mode, the mode before the watch arm.
 */
export type ReadinessNeed =
  | "identity"        // boundPaneIdentityState
  | "harness"         // tap_pane_harness_command over #{pane_current_command}
  | "pane-mode"       // #{pane_in_mode}
  | "blocked-fields"  // the watch arm's blocked_map + blocked_exempt
  | "in-turn-frame" | "survey-frame" | "band" | "pending";
export type ReadinessStep = { done: true; verdict: Readiness } | { done: false; need: ReadinessNeed };

/**
 * The prefix predicates the module evaluates ITSELF (they read the registry and the recovery
 * and fence state, not the pane). They are observations like any other and are taken ONCE:
 * the walk records each as it passes, the door hands the record back on the next round, and a
 * recorded one is not re-evaluated.
 *
 * Without this the need protocol re-read the registry on every round — six times on an
 * ordinary unqualified claude path where the incumbent read it once.
 * That is not only the cost argument for laziness defeating itself; it CHANGES THE
 * ANSWER, because a fence or recovery hold appearing mid-conversation could overturn a
 * decision the incumbent had already passed on its single check.
 */
export interface ReadinessCleared {
  registryTeam?: boolean;
  recovery?: boolean;
  fence?: boolean;
}

/** The observations gathered so far; `undefined` means "not taken yet". */
export interface ReadinessObservations {
  /** Prefix predicates already evaluated in this conversation. Mutated in place by the walk. */
  cleared?: ReadinessCleared;
  /** Bound pane identity: `match`, or its refusal reason. */
  identity?: string;
  /** `tap_pane_harness_command` — the resolved family, not the shallow `pane_current_command`. */
  harnessCmd?: string;
  /** `#{pane_in_mode}`; "" is a positive absence (or the door adapter's own
   * failed read — the native driver's unanswerable reads never reach the walk). */
  paneInMode?: string;
  /** The watch arm's two fields, as `tap_spool_blocked_or_exempt` reads them. */
  blocked?: { map: string; exempt: string };
  inTurnFrame?: string;
  surveyFrame?: string;
  /** codex only: the observed band, or null when the disposition refused to decide. */
  band?: DeliveryBand | null;
  pending?: PendingFact;
}

/** Everything the incumbent held before its first capture. */
export interface ReadinessPrefix {
  pane: string;
  paneId: string;
  handle: string;
  toTeam: string;
  targetRegistry: string;
  /** The spooled entry's policy; anything but `polite` behaves as before it existed. */
  policy: string;
}

export function readinessWalk(prefix: ReadinessPrefix, seen: ReadinessObservations, deps: ReadinessDeps): ReadinessStep {
  const done = (verdict: Readiness): ReadinessStep => ({ done: true, verdict });
  const { pane, paneId, handle, toTeam, targetRegistry, policy } = prefix;
  const cleared: ReadinessCleared = seen.cleared ?? (seen.cleared = {});
  if (!pane || !paneId || !targetRegistry) return done("gone");
  if (!cleared.registryTeam) {
    if (!deps.registryMatchesTeam(targetRegistry, toTeam)) return done("gone");
    cleared.registryTeam = true;
  }
  if (seen.identity === undefined) return { done: false, need: "identity" };
  // An old-format registry cannot answer who is bound: a hold that stays poll-visible, never "gone".
  if (seen.identity === "old_store") return done("busy:decision-unavailable");
  // An unobservable identity is the instrument failing to look, not the seat being
  // gone (observe.ts's doctrine; `identityUnobservable` owns the vocabulary, and
  // `registry_missing` — a POSITIVE absence — stays in the gone family below).
  if (identityUnobservable(seen.identity)) return done("busy:decision-unavailable");
  if (seen.identity !== "match") return done("gone");
  // The guard's own failure is a hold, not an absence: an unanswerable guard must never
  // read as "no recovery is running here".
  if (!cleared.recovery) {
    if (!deps.recoveryAllowed(paneId)) return done("busy:recovery");
    cleared.recovery = true;
  }
  // The drain redelivers on rebind, not during it. A live marker parks inject;
  // expired/absent falls through (fail-open).
  if (!cleared.fence) {
    const fence = deps.clearFenceState(targetRegistry, handle, toTeam);
    if (fence === "unavailable") return done("busy:decision-unavailable");
    if (fence === "live") return done("busy:clearing");
    cleared.fence = true;
  }
  if (seen.harnessCmd === undefined) return { done: false, need: "harness" };
  const harnessCmd = seen.harnessCmd;
  const families = agentFamilies(deps.env ?? process.env);
  const klass = classifyHarness(harnessFamily(harnessCmd, families), families);
  if (klass === "denylist" || klass === "unsupported") return done("unsafe");
  // A positive no-such-pane answer is a gone pane; a rate-limited read threw
  // before this line and holds. Any mode but 0 is copy-mode and friends.
  if (seen.paneInMode === undefined) return { done: false, need: "pane-mode" };
  if (!seen.paneInMode) return done("gone");
  if (seen.paneInMode !== "0") return done("busy");
  // The incumbent read the watch arm ONLY on this branch, so the fields are asked for
  // only here — a team-targeted entry never touches the arm record.
  if (!toTeam && handle) {
    if (seen.blocked === undefined) return { done: false, need: "blocked-fields" };
    if (deps.blockedOrExempt(handle, seen.blocked.map, seen.blocked.exempt)) return done("busy");
  }
  // AGY alone retains polite focus gating (L1 U4 / leader ruling 2026-09-05). OpenCode's
  // visible composer is ready during a turn; its long window supplies the spacing.
  if (policy === "polite" && targetRegistry && handle && harnessCmd.startsWith("agy")) {
    if (seen.inTurnFrame === undefined) return { done: false, need: "in-turn-frame" };
    if (agyInTurnFromFrame(seen.inTurnFrame)) return done("busy:in-turn");
  }
  // Codex's queued list is separate from its active composer. A queue is a positive
  // hold, never a draft to warn about or a missing prompt to force.
  if (harnessCmd.startsWith("codex")) {
    if (seen.band === undefined) return { done: false, need: "band" };
    if (seen.band === null) return done("busy:decision-unavailable");
    switch (seen.band) {
      case "queued": return done("busy:queued");
      case "draft": case "staged": return done("busy:pending");
      case "bare": return done("ready");
      default:
        // A missing composer may be a permission dialog. Preserve the modal
        // hold before the deadline path considers forcing a missing prompt.
        if (seen.pending === undefined) return { done: false, need: "pending" };
        return done(seen.pending.kind === "codex-update" ? "recover:codex-update"
          : seen.pending.kind === "modal" ? "busy:modal" : "busy:noprompt");
    }
  }
  // `ready` admits a bounded submit attempt, so the locked native recovery must actually
  // restore the composer before any sentinel can be injected.
  if (harnessCmd === "agy") {
    if (seen.surveyFrame === undefined) return { done: false, need: "survey-frame" };
    switch (surveyAdmission(seen.surveyFrame)) {
      case "recoverable": return done("ready");
      // A recovery hold bypasses overdue attempts before an attempt marker is minted.
      case "blocked": return done("busy:recovery");
    }
  }
  if (seen.pending === undefined) return { done: false, need: "pending" };
  switch (seen.pending.kind) {
    // A POSITIVELY RECOGNIZED modal — e.g. the agy permission overlay. (A Claude
    // feedback card hiding typed text is named separately as busy:feedback-draft.) It is the one hold ruling 15 leaves standing, and it is deliberately its own
    // class rather than a flavour of busy:noprompt: `noprompt` means "nothing was readable
    // here", an absence of evidence, while this means "a human is being asked a question".
    // Only the second justifies waiting indefinitely; only the first may be forced through.
    case "modal": return done("busy:modal");
    case "shell-mode": return done("busy:shell-mode");
    case "feedback-draft": return done("busy:feedback-draft");
    case "feedback-card": return done("recover:feedback-card");
    case "overprint-hold": return done("busy:overprint");
    case "no-band": return done(harnessCmd.startsWith("opencode") ? "busy:booting" : "busy:noprompt");
    case "text": return done(seen.pending.text ? "busy:pending" : "ready");
    default: return done("ready");
  }
}

/** The same walk with every observation already in hand — what the tests and the CLI use. */
export function paneReady(facts: ReadinessFacts, deps: ReadinessDeps): Readiness {
  const { frame, pending, band, identity, harnessCmd, paneInMode, blockedMap, blockedExempt, ...prefix } = facts;
  const step = readinessWalk(prefix, {
    identity, harnessCmd, paneInMode, blocked: { map: blockedMap, exempt: blockedExempt },
    inTurnFrame: frame, surveyFrame: frame, band, pending,
  }, deps);
  // Unreachable: every need is satisfied above. A need here would be a new branch.
  if (!step.done) throw new Error(`readiness asked for ${step.need} with every observation supplied`);
  return step.verdict;
}

/** `tap_spool_display_state` — what `tap spool list` and the verbose receipt print. */
export type DisplayState = "hold" | "batch" | "ready" | "focus" | "gone" | "unsafe" | "unknown";

/** The sidecar row the display mapping reads, as its Python heredoc printed it. */
export interface DisplayRow {
  pane: string;
  paneId: string;
  target: string;
  toTeam: string;
  targetRegistry: string;
  policy: string;
  /** `now < hold_until_epoch and not (first_spooled_epoch and now < first_spooled_epoch)`. */
  waiting: boolean;
}

/**
 * Python `int(m.get(k) or 0)` over a sidecar value: a non-integer RAISES, which here is null.
 *
 * The `or 0` and the `int()` are the repo's own helpers rather than a hand-rolled pair,
 * because a hand-rolled one narrowed both:
 * Python's `int(True)` is 1 and it accepts Unicode decimal digits and underscore groups, all
 * of which the first version called unreadable. A valid sidecar the incumbent could read must
 * not become `unknown` here.
 */
function pyIntOrZero(value: unknown): number | null {
  return pyInt(pyTruthy(value) ? value : 0);
}

/** Python `str(m.get(k) or '')` over the six row fields — `True`, not `true`. */
function pyStrOrEmpty(value: unknown): string {
  return pyTruthy(value) ? pyStr(value) : "";
}

/**
 * The sidecar read behind `tap_spool_display_state`: a missing file, a non-object, or a
 * non-integer clock is an unreadable row (the heredoc raised and printed nothing), which
 * the caller reports as `unknown`.
 */
export function displayRow(meta: unknown, now: number): DisplayRow | null {
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return null;
  const m = meta as Record<string, unknown>;
  const due = pyIntOrZero(m.hold_until_epoch);
  const first = pyIntOrZero(m.first_spooled_epoch);
  if (due === null || first === null) return null;
  return {
    pane: pyStrOrEmpty(m.pane), paneId: pyStrOrEmpty(m.pane_id), target: pyStrOrEmpty(m.target),
    toTeam: pyStrOrEmpty(m.to_team), targetRegistry: pyStrOrEmpty(m.target_registry), policy: pyStrOrEmpty(m.policy),
    waiting: now < due && !(first !== 0 && now < first),
  };
}

/** The mapping over a readiness verdict. An unreadable row or a blank field is `unknown`. */
export function displayState(row: DisplayRow | null, ready: Readiness | ""): DisplayState {
  if (!row) return "unknown";
  if (!row.pane || !row.paneId || !row.target || !row.targetRegistry) return "unknown";
  if (ready === "busy:in-turn") return "focus";
  if (ready === "recover:codex-update" || ready === "recover:feedback-card") return "hold";
  if (ready === "busy" || ready.startsWith("busy:")) return "hold";
  if (ready === "ready") return row.waiting ? "batch" : "ready";
  if (ready === "gone" || ready === "unsafe") return ready;
  return "unknown";
}

// --- the CLI door ---------------------------------------------------------------------
//
//   readiness <pane> <pane_id> <handle> <to_team> <registry> <policy>
//             [--identity <state>] [--harness <cmd>] [--pane-mode <n>]
//             [--blocked-map <json> --blocked-exempt <json>] [--cleared <csv>]
//             [--in-turn-frame <file>] [--survey-frame <file>] [--band <band|?>]
//             [--pending <text|empty|no-band|modal>] [--pending-text <file>]
//
// EVERY observation arrives by flag, and its ABSENCE is what makes the walk ask for it.
// An observation whose value is legitimately the empty string (an unanswerable
// `#{pane_in_mode}`, a pane with no command) is therefore `--pane-mode ""`, not omission.
//     → `verdict\n<word>` | `need\n<kind>\n<cleared-csv>`   (exit 0 either way)
//
// `cleared` is the prefix predicates the module has already evaluated in this conversation
// (registry-team, recovery, fence). The door hands it back so a completed check is not
// repeated: without it the walk re-read the registry once per round.
//
//   display-row <now> <meta-file>  → the seven row fields, US-separated, or `unknown`
//   display <verdict> <waiting> <pane> <pane-id> <target> <registry>
//                                  → hold|batch|ready|focus|gone|unsafe|unknown
//
// `display` takes the ROW rather than the path: the incumbent's heredoc read the sidecar once
// and carried `waiting` and the binding through the readiness call, so re-opening the file
// after readiness would map one snapshot's verdict onto another snapshot's hold window.
//
// Frames travel as FILES, not argv: a capture is arbitrary bytes, and the walk can need
// two different ones (the in-turn frame and the survey frame) in the same conversation,
// so stdin cannot carry them both.
import { readFileSync as readDoorFile, statSync as statDoorPath } from "node:fs";
import { inspectClearFence } from "./courier";
import { recoveryHold } from "./recovery/state";
import { blockedOrExempt as blockedOrExemptNative } from "./spool-state";
import { registryMatchesTeam } from "./spool-deadline";
import { spoolRecipientBusHome } from "./remote-target";

const readOrEmpty = (path: string): string => { try { return readDoorFile(path, "utf8"); } catch { return ""; } };

export function doorDeps(env: NodeJS.ProcessEnv = process.env, home = env.TAP_HOME || ""): ReadinessDeps {
  return {
    registryMatchesTeam,
    recoveryAllowed: (paneId) => !recoveryHold(paneId, env),
    clearFenceState: (targetRegistry, handle, toTeam) => {
      const bus = spoolRecipientBusHome(home, targetRegistry, toTeam, env.TAP_INDEX_HOME);
      return bus ? inspectClearFence(bus, handle) : "unavailable";
    },
    blockedOrExempt: (handle, map, exempt) => blockedOrExemptNative(handle, map, exempt),
    env,
  };
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

export function main(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  const [verb, ...rest] = argv;
  if (verb === "observe-display") {
    if (rest.length !== 4) return 2;
    process.stdout.write(readDisplayState(rest[2]!, rest[1]!, Number(rest[3]), env, rest[0] === "0"));
    return 0;
  }
  if (verb === "readiness") {
    if (rest.length < 6) { process.stderr.write("spool-readiness: readiness expects 6 positional facts\n"); return 2; }
    const at = (i: number): string => rest[i] ?? "";
    const prefix: ReadinessPrefix = {
      pane: at(0), paneId: at(1), handle: at(2), toTeam: at(3), targetRegistry: at(4), policy: at(5),
    };
    const inTurn = flag(rest, "--in-turn-frame"), survey = flag(rest, "--survey-frame");
    const bandFlag = flag(rest, "--band"), pendingFlag = flag(rest, "--pending");
    const identity = flag(rest, "--identity"), harnessCmd = flag(rest, "--harness");
    const paneInMode = flag(rest, "--pane-mode"), blockedMap = flag(rest, "--blocked-map");
    const clearedIn = (flag(rest, "--cleared") ?? "").split(",").filter(Boolean);
    const seen: ReadinessObservations = {
      cleared: {
        registryTeam: clearedIn.includes("registry"),
        recovery: clearedIn.includes("recovery"),
        fence: clearedIn.includes("fence"),
      },
    };
    if (identity !== undefined) seen.identity = identity;
    if (harnessCmd !== undefined) seen.harnessCmd = harnessCmd;
    if (paneInMode !== undefined) seen.paneInMode = paneInMode;
    if (blockedMap !== undefined) seen.blocked = { map: blockedMap, exempt: flag(rest, "--blocked-exempt") ?? "[]" };
    if (inTurn !== undefined) seen.inTurnFrame = readOrEmpty(inTurn);
    if (survey !== undefined) seen.surveyFrame = readOrEmpty(survey);
    // `?` is the disposition refusing to decide — a band that is absent, not a band value.
    if (bandFlag !== undefined) seen.band = bandFlag === "?" ? null : (bandFlag as DeliveryBand);
    if (pendingFlag !== undefined) {
      const textFile = flag(rest, "--pending-text");
      // A word this door does not know is REFUSED rather than read as an empty band. The
      // lenient direction here is `ready`, which admits a submit attempt, while an unknown
      // `--band` word lands on the hold side — so a future adapter-side typo would fail
      // toward typing into a pane. rc 2 makes the adapter's
      // `tap_bun_call` fail, which is `busy:decision-unavailable`: a hold.
      if (!["text", "empty", "no-band", "modal"].includes(pendingFlag)) {
        process.stderr.write(`spool-readiness: unknown --pending word ${JSON.stringify(pendingFlag)}\n`);
        return 2;
      }
      seen.pending = pendingFlag === "text" ? { kind: "text", text: textFile ? readOrEmpty(textFile) : "" }
        : pendingFlag === "no-band" ? { kind: "no-band" }
        : pendingFlag === "modal" ? { kind: "modal" }
        : { kind: "empty" };
    }
    const step = readinessWalk(prefix, seen, doorDeps(env));
    if (step.done) { process.stdout.write(`verdict\n${step.verdict}\n`); return 0; }
    const out = (["registry", "recovery", "fence"] as const)
      .filter((k) => seen.cleared?.[({ registry: "registryTeam", recovery: "recovery", fence: "fence" } as const)[k]]);
    process.stdout.write(`need\n${step.need}\n${out.join(",")}\n`);
    return 0;
  }
  // The sidecar half of `tap_spool_display_state`: the six binding fields the mapping
  // needs, US-separated, or `unknown` for a row the incumbent's heredoc could not read.
  // The adapter fetches the readiness verdict between this call and `display`, because
  // only it can observe a pane.
  if (verb === "display-row") {
    const [nowRaw, metaFile] = [rest[0], rest[1]];
    if (!nowRaw || !metaFile || !/^-?\d+$/.test(nowRaw)) { process.stderr.write("spool-readiness: display-row expects <now> <meta-file>\n"); return 2; }
    let meta: unknown = null;
    try { meta = JSON.parse(readDoorFile(metaFile, "utf8")); } catch { meta = null; }
    const row = displayRow(meta, Number(nowRaw));
    process.stdout.write(row === null ? "unknown\n"
      : `${[row.pane, row.paneId, row.target, row.toTeam, row.targetRegistry, row.policy, row.waiting ? "1" : "0"].join("\x1f")}\n`);
    return 0;
  }
  if (verb === "display") {
    const [verdict, waiting, pane, paneId, target, targetRegistry] =
      [rest[0], rest[1], rest[2] ?? "", rest[3] ?? "", rest[4] ?? "", rest[5] ?? ""];
    if (verdict === undefined || (waiting !== "0" && waiting !== "1")) {
      process.stderr.write("spool-readiness: display expects <verdict> <waiting 0|1> <pane> <pane-id> <target> <registry>\n");
      return 2;
    }
    const row: DisplayRow = { pane, paneId, target, toTeam: "", targetRegistry, policy: "", waiting: waiting === "1" };
    process.stdout.write(`${displayState(row, verdict as Readiness | "")}\n`);
    return 0;
  }
  if (verb === "band") {
    const [frameFile, harness, paneWidth] = [rest[0], rest[1], rest[2]];
    if (frameFile === undefined || harness === undefined) { process.stderr.write("spool-readiness: band expects <frame-file|-> <harness> [width]\n"); return 2; }
    // `-` is the caller saying it could not capture: unobservable, never bare.
    let frame: string | null = null;
    if (frameFile !== "-") {
      try { statDoorPath(frameFile); frame = readDoorFile(frameFile, "utf8"); } catch { frame = null; }
    }
    process.stdout.write(`${observedBand({ frame, harness, paneWidth: paneWidth ?? "" })}\n`);
    return 0;
  }
  process.stderr.write("spool-readiness: usage: readiness | display-row | display | band\n");
  return 2;
}

if (import.meta.main) {
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    process.stderr.write(`tap spool-readiness: stdout ${error.code ?? error.message}\n`);
    process.exitCode = 1;
  });
  process.exitCode = main(Bun.argv.slice(2));
}
