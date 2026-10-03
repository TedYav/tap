import { pasteText } from "./tmux";
import { inputProtectionHeld, protectionDetail, protectionUntil } from "./input-protection";
import { BLANK_DRAFT_NOTICE, DraftChain, INCOMPLETE_DRAFT_NOTICE, restorePlainDraft } from "./input-backup";
import { hasInputText } from "./terminal-text";
import { injectionBehavior } from "./injection-behavior";
import { sentinelShapedInput } from "./sentinel-tail";
import { parseStuckSentinel } from "./stuck-sentinel";
import {recordPhase} from "./submit-phase";
import {recordHarnessQueued} from "./harness-queue";
import { recoveryHold } from "./recovery/state";
import { captureCourierFailure } from "./debug-capture";
// Dark delivery: receipts and the draft-clobber pipeline around the existing
// pane seam. submitVerifyLocked stays in courier.ts (pane custody);
// this module wraps REAL_EFFECTS / tmux exports and writes .attempts + .sent.

import { randomUUID } from "node:crypto";
import { finalizeInputBackup, inputHash, writeInputBackup } from "./pane/draft";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Bus } from "./bus";
import {
  decodeAttemptRows,
  encodeAttemptRows,
  joinAttemptRows,
  type AttemptBeginRow,
  type AttemptOutcomeRow,
  type DeliveryResult,
} from "./courier-contract";
import {
  REAL_EFFECTS,
  type BoundRecipient,
  type PaneEffects as CourierPaneEffects,
} from "./courier";
import { atomicWrite, receiptBytes } from "./fsatomic";
import { utcStamp } from "./ids";
import { acquirePaneLock } from "./panelock";
import { CLAUDE_SCROLLED_DRAFT_REASON, isPasteCollapse, type PaneBand } from "./pane-state";
import { isOpenCodeCommand, normalizeInputMatch, tmux } from "./tmux";
import { repaintPane, type RepaintGate, type RepaintResult } from "./pane/repaint";

export type { BoundRecipient };

export interface PaneEffects extends CourierPaneEffects {
  paneCurrentCommand?: (target: string) => string;
  clearInput?: (target: string) => boolean | "rate_limited";
  backspace?: (target: string) => boolean | "rate_limited";
  restoreInput?: (target: string, text: string) => boolean | "rate_limited";
  /** The budget gate rides the repaint (tap-cl1es): the real impl applies it under the window lock; fakes may ignore it. */
  repaint?: (target: string, gate?: RepaintGate) => RepaintResult;
  /** Fault-injection seam: a kill just after the pre-submit custody moves the body. Prod never sets it. */
  crashAfterMove?: (id: string) => void;
}

type DraftDisposition = "repark" | "deliver-anyway";

export interface DeliveryInput {
  bus: Bus;
  id: string;
  pane: string;
  sentinel: string;
  bound?: BoundRecipient;
  from: string;
  to: string;
  kind: string;
  via: "send" | "owner";
  digestId?: string;
  deliveryClass?: string;
  draftDisposition?: DraftDisposition;
}

export interface DeliveryHooks {
  pane?: PaneEffects;
  notice?: (notice: "failed" | "unconfirmed", result: DeliveryResult) => void;
  warn?: (message: string) => void;
}

function tmuxKey(target: string, key: string): boolean | "rate_limited" {
  const result = tmux(["send-keys", "-t", target, key]);
  return result.rateLimited ? "rate_limited" : result.code === 0;
}


/** Production pane seam plus the clear/restore effects; the `pane clobber`
 * door runs on this same set so the CLI verb and native delivery cannot drift. */
export const DARK_EFFECTS: PaneEffects = {
  ...REAL_EFFECTS,
  clearInput: (target) => tmuxKey(target, "C-u"),
  backspace: (target) => tmuxKey(target, "BSpace"),
  restoreInput: pasteText,
  repaint: (target, gate) => repaintPane(target, undefined, gate),
};

type Denial =
  | { cause: "pane_gone"; detail: string }
  | { cause: "pane_dead"; detail: string }
  | { cause: "identity_mismatch"; detail: string }
  | { cause: "identity_unobservable"; detail: string }
  | { cause: "rate_limited"; detail: string };

export function authorize(pane: string, bound: BoundRecipient | undefined, fx: PaneEffects): Denial | null {
  const observation = fx.observePane(pane);
  if (observation === "pane_dead") return { cause: "pane_dead", detail: `pane '${pane}' has exited; delivery is held` };
  if (observation === "unobservable") {
    return { cause: "identity_unobservable", detail: `pane '${pane}' identity is unobservable` };
  }
  if (observation === "rate_limited") {
    return { cause: "rate_limited", detail: "tmux client budget exhausted before pane identity could be authorized" };
  }
  if (!observation) return { cause: "pane_gone", detail: `pane '${pane}' does not exist` };
  if (bound?.serverEpoch && fx.inputHeld) {
    const held = fx.inputHeld(observation.paneId, observation.serverEpoch);
    if (held) return { cause: "identity_unobservable", detail: protectionDetail(held) };
  }
  if (!bound) return null;
  // tap-zk1w: a pane-bound recipient with no generation claim binds its pane
  // id to no server lifetime; pane agreement alone does not authorize input.
  if (bound.paneId && !bound.serverEpoch) {
    return { cause: "identity_unobservable", detail: `pane '${pane}' is bound without a server generation, so its identity cannot be verified` };
  }
  if (bound.paneId && bound.paneId !== observation.paneId) {
    return {
      cause: "identity_mismatch",
      detail: `'${pane}' is now pane ${observation.paneId}, not the bound ${bound.paneId}`,
    };
  }
  if (bound.serverEpoch && bound.serverEpoch !== observation.serverEpoch) {
    return {
      cause: "identity_mismatch",
      detail: observation.serverEpoch
        ? `the pane reports server generation ${observation.serverEpoch}, not the bound ${bound.serverEpoch}`
        : `the pane's server generation is not observable, so the bound generation ${bound.serverEpoch} cannot be verified`,
    };
  }
  return null;
}

function commandOf(fx: PaneEffects, pane: string, bound: BoundRecipient | undefined): string {
  if (fx.paneCurrentCommand) return fx.paneCurrentCommand(pane);
  return bound?.harness ?? "";
}

function readBand(fx: PaneEffects, target: string, harness: string, command: string): PaneBand {
  return fx.paneState(target, harness, command);
}

const attemptsPath = (input: DeliveryInput): string => input.bus.payloadPath(input.id).replace(/\.md$/, ".attempts");

function attemptBase(input: DeliveryInput, attemptId: string, started: string, seq: number) {
  return {
    v: 1 as const,
    payload_id: input.id,
    attempt_id: attemptId,
    seq,
    rung: 1,
    op: "deliver" as const,
    driver: "tmux" as const,
    class: input.deliveryClass ?? "plain",
    native_ref: "",
    ts_start: started,
  };
}

function appendBegin(input: DeliveryInput, attemptId: string, started: string, seq: number): void {
  const path = attemptsPath(input);
  const row: AttemptBeginRow = {
    ...attemptBase(input, attemptId, started, seq),
    phase: "begin",
    disposition: "attempt-begin",
    effect: "possible",
    tier: "none",
    detail: "pane delivery may begin",
    ts_end: null,
  };
  appendFileSync(path, encodeAttemptRows([row]), { mode: 0o600 });
}

function appendOutcome(
  input: DeliveryInput,
  attemptId: string,
  started: string,
  seq: number,
  result: DeliveryResult,
): void {
  const path = attemptsPath(input);
  const row: AttemptOutcomeRow = {
    ...attemptBase(input, attemptId, started, seq),
    phase: "outcome",
    disposition: result.action,
    effect: result.effect,
    tier: result.action === "delivered" ? "left-input-band" : "none",
    detail: result.detail,
    ts_end: utcStamp(),
  };
  appendFileSync(path, encodeAttemptRows([row]), { mode: 0o600 });
}

function sentReceipt(input: DeliveryInput): string {
  return receiptBytes({
    id: input.id,
    from: input.from,
    to: input.to,
    pane: input.pane,
    kind: input.kind,
    via: input.via,
    turn: "unconfirmed",
    delivery: "pane",
    digest_id: input.digestId,
  });
}

function materializeSent(input: DeliveryInput): void {
  const path = input.bus.sentPath(input.id);
  if (!existsSync(path)) atomicWrite(path, sentReceipt(input));
}

function finish(
  input: DeliveryInput,
  hooks: DeliveryHooks,
  attemptId: string,
  started: string,
  seq: number,
  result: DeliveryResult,
): DeliveryResult {
  appendOutcome(input, attemptId, started, seq, result);
  if (result.action === "delivered") {
    materializeSent(input);
  } else if (result.action === "harness-queued") {
    recordHarnessQueued(input.bus.home,input.id,input.digestId ? {from:input.from,to:input.to,kind:input.kind} : undefined);
    try {
      recordPhase(input.bus.home,{id:input.id,attempt:attemptId,phase:"verify-result",recipient:input.to,enter_count:1,ordinal:1,result:"queued"});
    } catch (error) { console.error(`tap: submission phase evidence unavailable; submit behavior unchanged: ${error}`); }
  } else if (result.action === "cancel") {
    atomicWrite(input.bus.cancelPath(input.id), receiptBytes({
      status: "cancelled",
      id: input.id,
      via: "cancelled",
      reason: result.receipt_reason,
      target: input.to,
      source: "courier",
    }));
  }
  if ("notice" in result) hooks.notice?.(result.notice, result);
  return result;
}

function afterBeginDenial(denial: Denial): Extract<DeliveryResult, { effect: "possible" }> {
  if (denial.cause === "pane_gone") {
    return {
      action: "cancel",
      effect: "possible",
      cause: "pane_gone",
      receipt_reason: "pane_gone",
      notice: "failed",
      detail: denial.detail,
    };
  }
  return {
    action: "unconfirmed",
    effect: "possible",
    cause: denial.cause,
    notice: "unconfirmed",
    detail: denial.detail,
  };
}

interface DraftBackup {
  text: string;
  lines: number;
  pasteCollapse: boolean;
  /** Claude's visible rows and box width: the clear chain's first frame (tap-ipex2). */
  drawn?: { rows: string[]; columns: number };
  /** The retained file may hold only the visible rows: never auto-restored. */
  incomplete?: boolean;
  path?: string;
  /** A fused band's own wire: stripped from the proven draft before it is finalized. */
  wire?: string;
}

interface DraftPipeline {
  write: (target: string, paneCommand: string, band: Extract<PaneBand, { state: "busy" }>) => DraftBackup;
  restore: (backup: DraftBackup, target: string, paneCommand: string, fx: PaneEffects) => void;
  warn: (message: string) => void;
}

/**
 * The stuck-sentinel grammar lives in `stuck-sentinel.ts`, shared with the Bash
 * courier's `tap_stuck_sentinel_fields_from_region` adapter, so the two paths
 * cannot drift. This keeps the delivery path's exact `{id, to}` shape: the
 * wire kind the Bash caller keys on is not consumed here.
 *
 * The recipient comes back EMPTY for v0.23 by construction: that wire carries
 * no `to=`, and the caller re-keys on the payload the id names (architect
 * ruling, 2026-09-04). The pre-0.23 wire still carries `to=` and it is read.
 *
 * WHAT THIS SIDE DOES NOT YET IMPLEMENT, stated rather than implied: the bash
 * caller distinguishes three verdicts on that re-key — the recipient DISAGREES
 * (refuse), AGREES (submit), or is UNAVAILABLE (submit uncorroborated, and record
 * it). This function's consumer has only the last: an empty `to` short-circuits
 * the guard at the call site, so every v0.23 sentinel takes the submit path. The
 * OUTCOME matches bash's unavailable branch, which is why nothing reds — but it
 * gets there by having no verdicts rather than three, so the disagrees→refuse case
 * is absent and no arm would notice if it should have fired. That is tolerable only
 * while this path is dark (send/reply are Bash-owned). Whoever lights the owner
 * child owns closing it.
 * Sharing the parser does not change that: it is the consumer, not the grammar.
 */
export function pendingSentinel(text: string, paneCommand: string): { id: string; to: string } | null {
  const verdict = parseStuckSentinel(text, paneCommand);
  return verdict.ok ? { id: verdict.fields.id, to: verdict.fields.to } : null;
}

/**
 * What a clobber backs up before its first clear key. Claude's composer shows
 * only its last rows (tap-ipex2), so a Claude snapshot is its visible rows as
 * typed, less any fused wire of ours, marked unproven until the clear chain
 * proves the whole draft. Other harnesses keep the band text.
 */
function draftSnapshot(band: Extract<PaneBand, { state: "busy" }>, harness: string, stripWire: string):
  { text: string; drawn?: { rows: string[]; columns: number }; unproven: boolean } {
  const foreign = stripWire ? stripWrappedWire(band.text, stripWire) : band.text;
  if (!/^claude/i.test(harness.split("/").pop() ?? "")) return { text: foreign, unproven: false };
  if (!band.rows || !band.columns) return { text: foreign, unproven: true };
  const rows = band.rows.join("\n");
  return { text: stripWire ? stripWrappedWire(rows, stripWire) : rows, drawn: { rows: band.rows, columns: band.columns }, unproven: true };
}

/**
 * After the clear: a proven whole draft replaces the snapshot; anything less
 * stays incomplete. A fused draft is finalized only once our wire has actually
 * come out of it: a wire the stripper cannot find would be restored as the human's text.
 */
function settleDraftCapture(backup: DraftBackup, capture: { text: string; complete: boolean } | undefined): void {
  if (!backup.path || !backup.incomplete || !capture?.complete) return;
  const text = backup.wire ? stripWrappedWire(capture.text, backup.wire) : capture.text;
  if (backup.wire && text === capture.text) return;
  finalizeInputBackup(backup.path, text);
  backup.text = text;
  backup.lines = text.split("\n").length;
  backup.incomplete = false;
}

function makeDraftPipeline(input: DeliveryInput, hooks: DeliveryHooks): DraftPipeline {
  const warn = hooks.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
  return {
    warn,
    write(target, paneCommand, band) {
      const snapshot = draftSnapshot(band, input.bound?.harness || paneCommand, "");
      const text = snapshot.text;
      // ONE draft writer, shared with the Bash door (`pane/draft.ts`). This
      // function used to build the file itself, which made it a SECOND writer
      // into the same `input-backups/` directory that `tap draft` reads — and
      // the two disagreed about what they wrote there: `recovery_policy` was
      // the caller's value through Bash and the literal `clobber` here, so the
      // field telling a human what happened to their text depended on which
      // engine ran. The format is the module's; the FACTS stay this caller's,
      // including `clobber`, which is this path's actual policy rather than a
      // default standing in for one. Boundary agreed with lane A, 2026-09-15.
      // Blanks are content-free: no backup file, and the restore below says so.
      // A viewport whose earlier rows are unproven keeps its file: emptiness is unknown.
      const path = !snapshot.unproven && !hasInputText(text) ? undefined : writeInputBackup({
        directory: join(input.bus.home, "input-backups"),
        handle: input.to,
        payloadId: input.id,
        pane: input.pane,
        paneId: input.bound?.paneId ?? target,
        paneCommand,
        inputHash: inputHash(text),
        recoveryPolicy: "clobber",
        text,
        scrolledRowsUnproven: snapshot.unproven,
      });
      return { text, lines: text.split("\n").length, pasteCollapse: isPasteCollapse(paneCommand, text),
        drawn: snapshot.drawn, incomplete: snapshot.unproven, path };
    },
    restore(backup, target, paneCommand, fx) {
      if (!backup.incomplete && !hasInputText(backup.text)) {
        warn(BLANK_DRAFT_NOTICE);
        return;
      }
      if (backup.incomplete) {
        warn(INCOMPLETE_DRAFT_NOTICE);
        return;
      }
      if (/^opencode/.test(paneCommand) || backup.pasteCollapse) {
        warn("tap: draft backed up — view + copy with: tap draft");
        return;
      }
      // Restoration is optional after an accepted wire: a pane that throws
      // here leaves the retained backup and the notice, never the result.
      let restored = false;
      try {
        const denied = authorize(input.pane, input.bound, fx);
        const band = readBand(fx, target, input.bound?.harness ?? "", paneCommand);
        restored = !denied && band.state === "ready" && !!fx.restoreInput
          && restorePlainDraft(target, backup.text, input.bound?.harness ?? "", paneCommand, fx,
            () => !authorize(input.pane, input.bound, fx));
      } catch { /* restored stays false */ }
      if (!restored) warn("tap: draft backed up — view + copy with: tap draft");
    },
  };
}

function possibleFailure(
  input: PaneDeliveryInput,
  fx: PaneEffects,
  detail: string,
): Extract<DeliveryResult, { effect: "possible" }> {
  const denied = authorize(input.pane, input.bound, fx);
  return denied
    ? afterBeginDenial(denied)
    : { action: "unconfirmed", effect: "possible", cause: "mid_pipeline_failure", notice: "unconfirmed", detail };
}

/**
 * What the bounded clear loop ended with. The distinction is the caller's
 * policy input: `residue` means "clear failed but injection may proceed"
 * (pipeline > drafts), `chip-residue` means a paste chip survived and the
 * attempt must stop, `failed` carries the mid-loop denial verbatim. The warn
 * strings ride the outcome so the DOOR (clobberBand) can stay silent and let
 * each route speak its own notice, while the delivery pipeline replays them.
 */
export type ClearOutcome =
  | { kind: "cleared"; capture?: { text: string; complete: boolean } }
  | { kind: "residue"; warn: string }
  | { kind: "chip-residue"; warn: string; result: Extract<DeliveryResult, { effect: "possible" }> }
  | { kind: "failed"; result: Extract<DeliveryResult, { effect: "possible" }> };

export function clearDraft(
  input: PaneDeliveryInput,
  target: string,
  paneCommand: string,
  fx: PaneEffects,
  draft: DraftPipeline,
  backup: DraftBackup,
): ClearOutcome {
  if (!fx.clearInput || !fx.backspace) {
    return { kind: "failed", result: possibleFailure(input, fx, "draft clear effects are unavailable after attempt-begin") };
  }
  const harness = input.bound?.harness ?? "";
  // Claude C-u clears one current line and BSpace crosses its newline. The
  // old eight-cycle cap left longer drafts partly cleared (tap-vr8iw). Bound
  // work by the initial captured rows, never by input arriving during clear.
  // The chain reads the whole draft as the clear scrolls it into view (tap-ipex2);
  // each row it reveals was never counted in the initial rows, so it earns its own rounds.
  const chain = backup.drawn ? new DraftChain(backup.drawn.rows, backup.drawn.columns) : undefined;
  const emptied = (): ClearOutcome => ({ kind: "cleared", ...(chain ? { capture: chain.capture(true) } : {}) });
  const rounds = Math.max(16, backup.lines * 2);
  let previous = backup.text, unchanged = 0;
  for (let round = 0; round < Math.min(512, rounds + 2 * (chain?.reveals ?? 0)); round++) {
    const deniedBeforeClear = authorize(input.pane, input.bound, fx);
    if (deniedBeforeClear) return { kind: "failed", result: afterBeginDenial(deniedBeforeClear) };
    const cleared = fx.clearInput(target);
    if (cleared === "rate_limited") {
      return { kind: "failed", result: { action: "unconfirmed", effect: "possible", cause: "rate_limited", notice: "unconfirmed", detail: "tmux client budget exhausted during draft clear" } };
    }
    if (!cleared) return { kind: "failed", result: possibleFailure(input, fx, `pane '${target}' refused C-u during draft clear`) };
    fx.settle(0.03);

    const afterClear = readBand(fx, target, harness, paneCommand);
    if (afterClear.state === "ready") return emptied();
    if (afterClear.state === "busy") chain?.observe("C-u", afterClear.rows);
    if (afterClear.state === "rate_limited") {
      return { kind: "failed", result: { action: "unconfirmed", effect: "possible", cause: "rate_limited", notice: "unconfirmed", detail: afterClear.reason } };
    }
    if (afterClear.state === "gone") {
      return { kind: "failed", result: afterBeginDenial({ cause: "pane_gone", detail: `pane '${target}' is gone` }) };
    }
    if (afterClear.state === "unobservable") return { kind: "failed", result: afterClear.cause === "pane_dead"
      ? afterBeginDenial({ cause: "pane_dead", detail: afterClear.reason }) : possibleFailure(input, fx, afterClear.reason) };
    const deniedBeforeBackspace = authorize(input.pane, input.bound, fx);
    if (deniedBeforeBackspace) return { kind: "failed", result: afterBeginDenial(deniedBeforeBackspace) };
    const backed = fx.backspace(target);
    if (backed === "rate_limited") {
      return { kind: "failed", result: { action: "unconfirmed", effect: "possible", cause: "rate_limited", notice: "unconfirmed", detail: "tmux client budget exhausted during continuation clear" } };
    }
    if (!backed) return { kind: "failed", result: possibleFailure(input, fx, `pane '${target}' refused BSpace during continuation clear`) };
    fx.settle(0.03);

    const afterBackspace = readBand(fx, target, harness, paneCommand);
    if (afterBackspace.state === "ready") return emptied();
    if (afterBackspace.state === "busy") chain?.observe("BSpace", afterBackspace.rows);
    if (afterBackspace.state === "rate_limited") {
      return { kind: "failed", result: { action: "unconfirmed", effect: "possible", cause: "rate_limited", notice: "unconfirmed", detail: afterBackspace.reason } };
    }
    if (afterBackspace.state === "gone") {
      return { kind: "failed", result: afterBeginDenial({ cause: "pane_gone", detail: `pane '${target}' is gone` }) };
    }
    if (afterBackspace.state === "unobservable") return { kind: "failed", result: afterBackspace.cause === "pane_dead"
      ? afterBeginDenial({ cause: "pane_dead", detail: afterBackspace.reason }) : possibleFailure(input, fx, afterBackspace.reason) };
    unchanged = afterBackspace.text === previous ? unchanged + 1 : 0;
    previous = afterBackspace.text;
    if (unchanged >= 8) break;
  }
  if (backup.pasteCollapse) {
    return {
      kind: "chip-residue",
      warn: "tap: paste-collapse draft persists after clear attempts — view + copy with: tap draft",
      result: {
        action: "unconfirmed", effect: "possible", cause: "submit_unverified", notice: "unconfirmed",
        detail: "paste-collapse draft persisted after bounded clear attempts",
      },
    };
  }
  return { kind: "failed", result: possibleFailure(input, fx, "input remains after bounded clear attempts; sentinel withheld, backup retained") };
}

/**
 * The one clobber door, shared by the delivery pipeline's pre-Enter fusion
 * gate and the `pane clobber` CLI verb: back up ONLY the foreign bytes (the
 * band with our exact wire removed), then run the existing bounded clear
 * loop. No parallel pipeline — this is `writeInputBackup` plus `clearDraft`
 * called at a second site, with the route's own voice supplied as `warn` so
 * the notices stay with the caller (the CLI door reports facts and Bash keeps
 * its existing lines; the native gate replays the pipeline notices).
 */
export interface ClobberBackupReq {
  directory: string;
  handle: string;
  payloadId: string;
  pane: string;
  paneId?: string;
  /** Reuse a pre-interrupt snapshot only if the current draft is identical. */
  retained?: { path: string; text: string };
}

export type ClobberVerdict =
  | { kind: "cleared"; backupPath?: string; lines: number; chip: boolean; incomplete?: true }
  | { kind: "residue"; backupPath?: string; lines: number; chip: boolean; incomplete?: true }
  | { kind: "chip-residue"; backupPath?: string; lines: number; chip: boolean }
  | { kind: "backup-failed"; detail: string }
  | { kind: "preserved"; detail: string }
  | { kind: "possible-failure"; result: Extract<DeliveryResult, { effect: "possible" }> }
  | { kind: "identity"; detail: string }
  | { kind: "gone"; detail: string };

function stripWrappedWire(text: string, wire: string): string {
  const chars = [...normalizeInputMatch(wire)];
  if (!chars.length) return text;
  const gap = String.raw`(?:\s|\x1b\[[0-?]*[ -/]*[@-~])*`;
  const pattern = chars
    .map(char => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(gap);
  return text.replace(new RegExp(pattern, "gu"), "");
}

export function clobberBand(
  target: string,
  paneCommand: string,
  bound: BoundRecipient | undefined,
  fx: PaneEffects,
  backupReq: ClobberBackupReq,
  stripWire: string,
  warn: (message: string) => void = () => {},
): ClobberVerdict {
  const band = readBand(fx, target, bound?.harness ?? "", paneCommand);
  if (band.state === "gone") return { kind: "gone", detail: `pane '${target}' is gone` };
  if (band.state === "rate_limited") {
    return { kind: "possible-failure", result: { action: "unconfirmed", effect: "possible", cause: "rate_limited", notice: "unconfirmed", detail: band.reason } };
  }
  if (band.state === "unobservable") {
    return { kind: "possible-failure", result: { action: "unconfirmed", effect: "possible", cause: band.cause ?? "submit_unverified", notice: "unconfirmed", detail: band.reason } };
  }
  if (band.state !== "busy") return { kind: "cleared", lines: 0, chip: false };
  if (fx.protectInput && bound?.serverEpoch && !stripWire) {
    const owner = fx.observePane(target);
    if (owner && typeof owner === "object" && owner.serverEpoch === bound.serverEpoch) {
      const held = fx.protectInput(owner, band, { harness: bound.harness });
      if (held && protectionUntil(held) > Date.now()) return { kind: "preserved", detail: protectionDetail(held) };
    }
  }
  if (band.scrolled) return { kind: "preserved", detail: CLAUDE_SCROLLED_DRAFT_REASON };
  const foreign = stripWire ? stripWrappedWire(band.text, stripWire) : band.text;
  try {
    if (hasInputText(foreign) && injectionBehavior() === "wait") return { kind: "preserved", detail: "injection.behavior=wait preserves human input" };
  } catch (error) { return { kind: "preserved", detail: String(error) }; }
  const facts = { lines: foreign.split("\n").length, chip: isPasteCollapse(paneCommand, foreign) };
  const snapshot = draftSnapshot(band, bound?.harness || paneCommand, stripWire);
  let backupPath = backupReq.retained?.text === foreign ? backupReq.retained.path : undefined;
  if (hasInputText(foreign) && !backupPath) {
    try {
      backupPath = writeInputBackup({
        directory: backupReq.directory,
        handle: backupReq.handle,
        payloadId: backupReq.payloadId,
        pane: backupReq.pane,
        paneId: backupReq.paneId ?? target,
        paneCommand,
        inputHash: inputHash(snapshot.text),
        recoveryPolicy: "clobber",
        text: snapshot.text,
        scrolledRowsUnproven: snapshot.unproven,
      });
    } catch (error) {
      return { kind: "backup-failed", detail: error instanceof Error ? error.message : String(error) };
    }
  }
  const input: PaneDeliveryInput = { pane: target, id: backupReq.payloadId, sentinel: stripWire, bound, busHome: backupReq.directory };
  const backup: DraftBackup = { text: snapshot.text, lines: facts.lines, pasteCollapse: facts.chip,
    drawn: snapshot.drawn, incomplete: snapshot.unproven && !facts.chip, path: backupPath, ...(stripWire ? { wire: stripWire } : {}) };
  const outcome = clearDraft(
    input, target, paneCommand, fx,
    { warn, write: () => { throw new Error("clobberBand wrote its own backup"); }, restore: () => {} },
    backup,
  );
  if (outcome.kind === "cleared") {
    try { settleDraftCapture(backup, outcome.capture); } catch { /* the snapshot stays incomplete */ }
  }
  // Only a proven whole draft may be put back; the file says the same to `tap draft`.
  const proven = backup.incomplete && hasInputText(foreign) ? { ...facts, incomplete: true as const } : facts;
  switch (outcome.kind) {
    case "cleared": return { kind: "cleared", backupPath, ...proven };
    case "residue": return { kind: "residue", backupPath, ...proven };
    case "chip-residue": return { kind: "chip-residue", backupPath, ...facts };
    case "failed": {
      const { result } = outcome;
      if ("cause" in result && result.cause === "pane_gone") return { kind: "gone", detail: result.detail };
      if ("cause" in result && result.cause === "identity_mismatch") return { kind: "identity", detail: result.detail };
      return { kind: "possible-failure", result };
    }
  }
}

/**
 * Take back an injection that never received Enter (tap-arm4w). A withheld
 * control used to stay typed, leaving the seat deaf to delivery until a key was
 * pressed. Clears only when the band is our wire alone, up to whitespace that
 * wrapping and indentation insert; anything else is `foreign` and untouched.
 * No Enter was sent, so this is no retry after possible effect.
 */
export type ClearOwnVerdict = "cleared" | "residue" | "absent" | "foreign" | "unread" | "identity" | "gone";

export function clearOwnInjection(
  target: string, paneCommand: string, bound: BoundRecipient | undefined, fx: PaneEffects, _payloadId: string, wire: string,
): ClearOwnVerdict {
  const want = normalizeInputMatch(wire);
  if (!want || !fx.clearInput) return "unread";
  // Ownership is re-read before EVERY key, never carried from a first look: a
  // draft typed after one read must stop the next C-u.
  // Only C-u, and only while the band is our wire or a strictly shorter piece
  // of the band we last owned: a C-u never grows the band, so growth is a
  // human typing, even when the typed words also occur in our command.
  let owned = want;
  for (let round = 0; round < 8; round++) {
    const denied = authorize(target, bound, fx);
    if (denied) return denied.cause === "pane_gone" ? "gone" : denied.cause === "identity_mismatch" ? "identity" : "unread";
    const band = readBand(fx, target, bound?.harness ?? "", paneCommand);
    if (band.state === "gone") return "gone";
    if (band.state === "ready") return round ? "cleared" : "absent";
    if (band.state !== "busy") return "unread";
    const text = normalizeInputMatch(band.text);
    const ours = round ? text !== "" && text.length < owned.length && owned.includes(text) : text === want;
    if (!ours) return round ? "residue" : "foreign";
    owned = text;
    const cleared = fx.clearInput(target);
    if (cleared === "rate_limited" || !cleared) return "unread";
    fx.settle(0.03);
  }
  return "residue";
}

/** The courier's `takeBack` over `effects`: clearOwnInjection, with each C-u
 * behind the courier's fresh owner and fence permit (the pane check above
 * alone does not see the registry row or the reset and clear fences). */
export function permittedTakeBack(effects: PaneEffects) {
  return (target: string, command: string, bound: BoundRecipient | undefined, id: string, wire: string, permit: () => boolean): ClearOwnVerdict => {
    const clear = effects.clearInput;
    return clearOwnInjection(target, command, bound, { ...effects, clearInput: clear && (t => permit() ? clear(t) : false) }, id, wire);
  };
}

interface PaneDeliveryInput {
  pane: string;
  id: string;
  sentinel: string;
  bound?: BoundRecipient;
  draftDisposition?: DraftDisposition;
  to?: string;
  /** The bus root, threaded for the fusion gate's backup directory. */
  busHome: string;
}

function sampleHasId(fx: PaneEffects, target: string, command: string, id: string): boolean {
  return sampleInput(fx, target, command, id).state === "present";
}

function sampleInput(fx: PaneEffects, target: string, command: string, id: string) {
  if (fx.observeInput) return fx.observeInput(target, command, id);
  return fx.inputHasId(target, command, id) ? { state: "present" as const, text: id } : { state: "absent" as const };
}

function deliveryResultLocked(
  input: PaneDeliveryInput,
  fx: PaneEffects,
  begin: () => void,
  draft?: DraftPipeline,
): DeliveryResult {
  let began = false;
  const beginOnce = () => {
    if (began) return;
    begin();
    began = true;
  };
  let backup: DraftBackup | null = null;
  const paneCommand = commandOf(fx, input.pane, input.bound);
  const denied = authorize(input.pane, input.bound, fx);
  if (denied?.cause === "pane_gone" || denied?.cause === "identity_mismatch") {
    return {
      action: "cancel", effect: "none", cause: denied.cause,
      receipt_reason: "pane_gone", notice: "failed", detail: denied.detail,
    };
  }
  if (denied?.cause === "rate_limited" || denied?.cause === "identity_unobservable" || denied?.cause === "pane_dead") {
    return { action: "repark", effect: "none", cause: denied.cause, detail: denied.detail };
  }

  const target = input.bound?.paneId || input.pane;
  const harness = input.bound?.harness ?? "";
  const band = readBand(fx, target, harness, paneCommand);
  if (band.state === "busy") {
    const parsed = pendingSentinel(band.text, paneCommand);
    // The parser returns the id QUALIFIED when the wire carried a `<team>/` bus
    // locator; ids on disk are never qualified, so the split happens here, the way
    // bash's tap_submit_verify does it. `bandId` keeps the wire form because that
    // is what a band sample must match; `id` is the filename every comparison and
    // every payload lookup wants.
    const stuck = parsed && {
      ...parsed,
      bandId: parsed.id,
      id: parsed.id.slice(parsed.id.lastIndexOf("/") + 1),
    };
    if (stuck?.to && input.to && stuck.to !== input.to) {
      return {
        action: "repark", effect: "none", cause: "draft",
        detail: `pending sentinel recipient '${stuck.to}' does not match '${input.to}'; refusing to submit or clobber it`,
      };
    }
    if (stuck) {
      beginOnce();
      const deniedBeforeExisting = authorize(input.pane, input.bound, fx);
      if (deniedBeforeExisting) return afterBeginDenial(deniedBeforeExisting);
      const pressed = fx.pressEnter(target);
      if (pressed === "rate_limited") {
        return {
          action: "unconfirmed", effect: "possible", cause: "rate_limited", notice: "unconfirmed",
          detail: "tmux client budget exhausted while submitting an existing sentinel",
        };
      }
      if (!pressed) return possibleFailure(input, fx, `pane '${target}' refused Enter for an existing sentinel`);

      let cleared = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        fx.settle(0.15);
        if (!sampleHasId(fx, target, paneCommand, stuck.bandId)) { cleared = true; break; }
      }
      if (!cleared) return possibleFailure(input, fx, `existing sentinel '${stuck.id}' did not leave '${input.pane}'`);
      if (stuck.id === input.id) {
        return { action: "delivered", effect: "possible", detail: `id '${input.id}' left the input band of '${input.pane}'` };
      }
    }
    if (!stuck) {
      // ANCHOR-GATED: a band that IS a sentinel — anchored `[[TAP` … `]]` — and did
      // not parse is never backed up and cleared. Keying this on a successful parse
      // means every path that fails to yield an id — pre-0.23 bytes at install time,
      // a wrap the parser could not rejoin, a truncated marker — reaches the draft
      // path, and under `deliver-anyway` that is a clobber of a real message. A
      // backup makes the loss recoverable; it does not make it acceptable.
      //
      // THE GATE IS THE OPENING ANCHOR, AND ONLY THAT — not a substring, and not the
      // closed `[[TAP` … `]]` form either. Each half of that is a decision:
      //
      // Not a substring, because prose with a sentinel inside it ("notes before
      // [[TAP …]] notes after") is a HUMAN DRAFT and stays one; the U5 arm below
      // pins that, a substring gate quietly overturns it, and my first cut was the
      // substring form — that arm is what caught it.
      //
      // Not the closed form, because a TRUNCATED marker is the case most worth
      // protecting and is exactly the one with no `]]` to match. Requiring the close
      // would hand the clobber path the shape it is likeliest to meet.
      //
      // What is left says the right thing: the band OPENS as a sentinel, so it is
      // not human prose, and nothing could be read out of it.
      //
      // Stated once, applied at all three sites: bash `tap_submit_verify`, `tap
      // nudge`, and here. The residual is that an anchored-but-broken marker parks
      // that pane until someone submits or clears it, so the remedy rides the detail.
      if (sentinelShapedInput(band.text)) {
        return {
          action: "repark", effect: "none", cause: "draft",
          detail: `pane '${input.pane}' holds an unparseable [[TAP marker or a scrolled sentinel tail; refusing to clear it — submit or clear it in the pane, or run 'tap nudge' against that seat`,
        };
      }
      if (band.scrolled) return { action: "repark", effect: "none", cause: "draft", detail: `pane '${input.pane}': ${CLAUDE_SCROLLED_DRAFT_REASON}` };
      if (input.draftDisposition !== "deliver-anyway" || !draft) {
        return { action: "repark", effect: "none", cause: "draft", detail: `pane '${input.pane}' holds unsubmitted input` };
      }
      beginOnce();
      try {
        backup = draft.write(target, paneCommand, band);
      } catch {
        return possibleFailure(input, fx, "input backup could not be created after attempt-begin");
      }
      const clearOutcome = clearDraft(input, target, paneCommand, fx, draft, backup);
      if (clearOutcome.kind === "cleared") {
        try { settleDraftCapture(backup, clearOutcome.capture); } catch { /* the snapshot stays incomplete */ }
      }
      if (clearOutcome.kind === "residue") draft.warn(clearOutcome.warn);
      else if (clearOutcome.kind === "chip-residue") {
        draft.warn(clearOutcome.warn);
        return clearOutcome.result;
      } else if (clearOutcome.kind === "failed") return clearOutcome.result;
    }
  }
  if (band.state === "unobservable") {
    return { action: "repark", effect: "none", cause: band.cause ?? "no-band", detail: band.reason };
  }
  if (band.state === "gone") {
    return {
      action: "cancel", effect: "none", cause: "pane_gone",
      receipt_reason: "pane_gone", notice: "failed", detail: `pane '${input.pane}' is gone`,
    };
  }
  if (band.state === "rate_limited") {
    return { action: "repark", effect: "none", cause: "rate_limited", detail: band.reason };
  }

  const deniedBeforeInject = authorize(input.pane, input.bound, fx);
  if (deniedBeforeInject) {
    if (began) return afterBeginDenial(deniedBeforeInject);
    if (deniedBeforeInject.cause === "rate_limited" || deniedBeforeInject.cause === "identity_unobservable" || deniedBeforeInject.cause === "pane_dead") {
      return { action: "repark", effect: "none", cause: deniedBeforeInject.cause, detail: deniedBeforeInject.detail };
    }
    return {
      action: "cancel", effect: "none", cause: deniedBeforeInject.cause,
      receipt_reason: "pane_gone", notice: "failed", detail: deniedBeforeInject.detail,
    };
  }

  beginOnce();
  const injected = fx.injectText(target, input.sentinel, isOpenCodeCommand(input.bound?.harness || paneCommand),
    () => {
      const denied = authorize(input.pane, input.bound, fx);
      return denied?.cause === "rate_limited" ? "rate_limited" : denied === null;
    });
  if (injected === "rate_limited") {
    return {
      action: "unconfirmed", effect: "possible", cause: "rate_limited", notice: "unconfirmed",
      detail: "tmux client budget exhausted before sentinel injection completed",
    };
  }
  if (!injected) {
    const after = authorize(input.pane, input.bound, fx);
    return after
      ? afterBeginDenial(after)
      : { action: "unconfirmed", effect: "possible", cause: "submit_unverified", notice: "unconfirmed", detail: `pane '${target}' refused sentinel injection` };
  }

  let landed = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    if (sampleHasId(fx, target, paneCommand, input.id)) { landed = true; break; }
    fx.settle(0.1);
  }
  if (!landed) {
    const after = authorize(input.pane, input.bound, fx);
    return after
      ? afterBeginDenial(after)
      : { action: "unconfirmed", effect: "possible", cause: "submit_unverified", notice: "unconfirmed", detail: `input did not land on '${input.pane}'` };
  }

  // Pre-Enter sole-content gate (tap-maavp effect 2). Landing proved our id is
  // VISIBLE, not alone: a human draft can be fused around the wire between the
  // pre-inject read and this gate, and Enter would submit that draft with the
  // message. Through the reader's `fused` flag (foreign bytes inside a
  // readable bounded composer) — or, without a frame reader, an observed
  // sample holding our wire plus other non-space bytes — the band is backed
  // up (foreign bytes only), cleared, and the sentinel re-injected ONCE and
  // re-verified; only sole content reaches Enter. A second fusion stops
  // unverified with the backup retained: one recovery, never a loop.
  const fusedNow = (): boolean => {
    if (fx.submitFrame) {
      return fx.submitFrame(target, paneCommand, input.sentinel, !!input.bound?.harness).fused === true;
    }
    const sample = sampleInput(fx, target, paneCommand, input.id);
    if (sample.state !== "present") return false;
    const want = normalizeInputMatch(input.sentinel);
    const actual = normalizeInputMatch(sample.text);
    return want.length > 0 && actual.includes(want) && actual.replace(want, "").length > 0;
  };
  for (let pass = 0; pass < 2; pass++) {
    if (!fusedNow()) break;
    if (pass === 1) {
      return {
        action: "unconfirmed", effect: "possible", cause: "submit_unverified", notice: "unconfirmed",
        detail: "fused band persisted after bounded re-inject; foreign bytes backed up, Enter withheld",
      };
    }
    const deniedBeforeClobber = authorize(input.pane, input.bound, fx);
    if (deniedBeforeClobber) return afterBeginDenial(deniedBeforeClobber);
    const verdict = clobberBand(
      target, paneCommand, input.bound, fx,
      { directory: join(input.busHome, "input-backups"), handle: input.to ?? input.id, payloadId: input.id, pane: input.pane, paneId: input.bound?.paneId },
      input.sentinel, draft?.warn,
    );
    if (verdict.kind === "preserved") return possibleFailure(input, fx, verdict.detail);
    if (verdict.kind === "backup-failed") {
      return possibleFailure(input, fx, `fused-band backup could not be created: ${verdict.detail}`);
    }
    if (verdict.kind === "identity") return afterBeginDenial({ cause: "identity_mismatch", detail: verdict.detail });
    if (verdict.kind === "gone") return afterBeginDenial({ cause: "pane_gone", detail: verdict.detail });
    if (verdict.kind === "possible-failure") return verdict.result;
    if (verdict.kind === "chip-residue") {
      return {
        action: "unconfirmed", effect: "possible", cause: "submit_unverified", notice: "unconfirmed",
        detail: "paste-collapse draft persisted after bounded clear attempts",
      };
    }
    // cleared | residue: the band read clean (or spoke its own residue notice)
    // and the foreign bytes are retained on disk — re-inject and re-verify.
    const deniedBeforeReinject = authorize(input.pane, input.bound, fx);
    if (deniedBeforeReinject) return afterBeginDenial(deniedBeforeReinject);
    const reinjected = fx.injectText(target, input.sentinel, isOpenCodeCommand(input.bound?.harness || paneCommand),
      () => {
        const denied = authorize(input.pane, input.bound, fx);
        return denied?.cause === "rate_limited" ? "rate_limited" : denied === null;
      });
    if (reinjected === "rate_limited") {
      return {
        action: "unconfirmed", effect: "possible", cause: "rate_limited", notice: "unconfirmed",
        detail: "tmux client budget exhausted during fused-band re-injection",
      };
    }
    if (!reinjected) {
      return possibleFailure(input, fx, `pane '${target}' refused fused-band re-injection`);
    }
    let relanded = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      if (sampleHasId(fx, target, paneCommand, input.id)) { relanded = true; break; }
      fx.settle(0.1);
    }
    if (!relanded) {
      const after = authorize(input.pane, input.bound, fx);
      return after
        ? afterBeginDenial(after)
        : { action: "unconfirmed", effect: "possible", cause: "submit_unverified", notice: "unconfirmed", detail: `input did not land on '${input.pane}' after fused-band recovery` };
    }
  }

  const deniedBeforeEnter = authorize(input.pane, input.bound, fx);
  if (deniedBeforeEnter) return afterBeginDenial(deniedBeforeEnter);

  const pressed = fx.pressEnter(target);
  if (pressed === "rate_limited") {
    return {
      action: "unconfirmed", effect: "possible", cause: "rate_limited", notice: "unconfirmed",
      detail: "tmux client budget exhausted after sentinel injection",
    };
  }
  if (!pressed) {
    const after = authorize(input.pane, input.bound, fx);
    return after
      ? afterBeginDenial(after)
      : { action: "unconfirmed", effect: "possible", cause: "submit_unverified", notice: "unconfirmed", detail: `pane '${target}' vanished after sentinel injection` };
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    fx.settle(0.15);
    if (fx.submitFrame?.(target,paneCommand,input.sentinel,!!input.bound?.harness).state === "queued") {
      const after=authorize(input.pane,input.bound,fx);
      if (after) return afterBeginDenial(after);
      // An accepted queue is a submitted wire: the cleared draft is owed the
      // same guarded restore a verified delivery gets (tap-x62ob). No Enter.
      if (backup && draft) draft.restore(backup, target, paneCommand, fx);
      return {action:"harness-queued",effect:"possible",detail:"accepted into harness queue; recipient processing unconfirmed"};
    }
    if (!sampleHasId(fx, target, paneCommand, input.id)) {
      if (backup && draft) draft.restore(backup, target, paneCommand, fx);
      return { action: "delivered", effect: "possible", detail: `id '${input.id}' left the input band of '${input.pane}'` };
    }
  }

  // OpenCode can leave terminal-operation output painted over its composer
  // after accepting Enter. One exact-window resize/restore forces a repaint;
  // it is observation-only and therefore never licenses another Enter or a
  // reinjection. Re-observe once and keep unreadable/unchanged state unverified.
  if (isOpenCodeCommand(paneCommand) && fx.repaint) {
    const deniedBeforeRepaint = authorize(input.pane, input.bound, fx);
    if (deniedBeforeRepaint) return afterBeginDenial(deniedBeforeRepaint);
    const repaint = fx.repaint(target);
    if (!repaint.ok) {
      return {
        action: "unconfirmed", effect: "possible", cause: "submit_unverified", notice: "unconfirmed",
        detail: `OpenCode repaint did not complete: ${repaint.reason}`,
      };
    }
    const deniedAfterRepaint = authorize(input.pane, input.bound, fx);
    if (deniedAfterRepaint) return afterBeginDenial(deniedAfterRepaint);
    fx.settle(0.1);
    const frame = fx.submitFrame?.(target, paneCommand, input.sentinel, !!input.bound?.harness);
    if (frame?.state === "queued") {
      const deniedBeforeQueued = authorize(input.pane, input.bound, fx);
      if (deniedBeforeQueued) return afterBeginDenial(deniedBeforeQueued);
      if (backup && draft) draft.restore(backup, target, paneCommand, fx);
      return { action: "harness-queued", effect: "possible", detail: "accepted into harness queue after OpenCode repaint; recipient processing unconfirmed" };
    }
    const inputSample = sampleInput(fx, target, paneCommand, input.id);
    if (frame && frame.state !== "unobservable" && inputSample.state === "absent") {
      const deniedBeforeDelivered = authorize(input.pane, input.bound, fx);
      if (deniedBeforeDelivered) return afterBeginDenial(deniedBeforeDelivered);
      if (backup && draft) draft.restore(backup, target, paneCommand, fx);
      return { action: "delivered", effect: "possible", detail: `id '${input.id}' left the input band after OpenCode repaint` };
    }
  }

  const finalDenial = authorize(input.pane, input.bound, fx);
  return finalDenial
    ? afterBeginDenial(finalDenial)
    : { action: "unconfirmed", effect: "possible", cause: "submit_unverified", notice: "unconfirmed", detail: `id '${input.id}' did not leave the input line of '${input.pane}'` };
}

export function deliver(input: DeliveryInput, hooks: DeliveryHooks = {}): DeliveryResult {
  try { if (injectionBehavior() === "wait") input = { ...input, draftDisposition: undefined }; }
  catch (error) { return { action: "repark", effect: "none", cause: "config", detail: String(error) }; }
  const existingPath = attemptsPath(input);
  let priorRows: ReturnType<typeof decodeAttemptRows> = [];
  try {
    priorRows = decodeAttemptRows(readFileSync(existingPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (priorRows.length > 0) {
    const readout = joinAttemptRows(priorRows);
    const verified = readout.paired.find((pair) => pair.outcome.disposition === "delivered");
    if (verified) {
      materializeSent(input);
      return {
        action: "delivered",
        effect: "possible",
        detail: verified.outcome.detail,
      };
    }
    const queued=readout.paired.find(pair=>pair.outcome.disposition === "harness-queued");
    if (queued) {
      recordHarnessQueued(input.bus.home,input.id,input.digestId ? {from:input.from,to:input.to,kind:input.kind} : undefined);
      return {action:"harness-queued",effect:"possible",detail:queued.outcome.detail};
    }
    if (readout.unverified || readout.paired.length > 0) {
      const result: DeliveryResult = {
        action: "unconfirmed", effect: "possible", cause: "mid_pipeline_failure", notice: "unconfirmed",
        detail: "prior attempt evidence records a possible effect; refusing to retry",
      };
      hooks.notice?.("unconfirmed", result);
      return result;
    }
  }

  const attemptId = randomUUID();
  const started = utcStamp();
  const beginSeq = priorRows.length + 1;
  const lock = acquirePaneLock(input.bound?.paneId || input.pane);
  if (!lock) {
    return finish(input, hooks, attemptId, started, beginSeq, {
      action: "repark", effect: "none", cause: "lock_busy", detail: `another submit holds pane '${input.pane}'`,
    });
  }
  try {
    if (recoveryHold(input.bound?.paneId || input.pane)) {
      return finish(input, hooks, attemptId, started, beginSeq, {
        action: "repark", effect: "none", cause: "recovery", detail: `recovery owns pane '${input.pane}'; delivery parked`,
      });
    }
    let began = false;
    const result = captureCourierFailure({ id: input.id, pane: input.pane, sentinel: input.sentinel,
      harness: input.bound?.harness ?? "", busHome: input.bus.home },
      () => deliveryResultLocked({ ...input, busHome: input.bus.home }, hooks.pane ?? DARK_EFFECTS, () => {
      appendBegin(input, attemptId, started, beginSeq);
      began = true;
    }, input.draftDisposition === "deliver-anyway" ? makeDraftPipeline(input, hooks) : undefined));
    return finish(input, hooks, attemptId, started, began ? beginSeq + 1 : beginSeq, result);
  } finally {
    lock.release();
  }
}
