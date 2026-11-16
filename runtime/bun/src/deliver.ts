// The pane-effects seam around the courier, and the draft-clobber doors built on
// it: back up a human draft, clear the input band with bounded keys, and take
// back an injection of ours that never received Enter. Submission itself is
// courier.ts's submitVerify; its callers hand it these doors as effects.

import { pasteText } from "./tmux";
import { protectionDetail, protectionUntil } from "./input-protection";
import { DraftChain } from "./input-backup";
import { hasInputText } from "./terminal-text";
import { injectionBehavior } from "./injection-behavior";
import { parseStuckSentinel } from "./stuck-sentinel";
import { finalizeInputBackup, inputHash, writeInputBackup } from "./pane/draft";

import type { DeliveryResult } from "./courier-contract";
import {
  REAL_EFFECTS,
  type BoundRecipient,
  type PaneEffects as CourierPaneEffects,
} from "./courier";
import { CLAUDE_SCROLLED_DRAFT_REASON, isPasteCollapse, type PaneBand } from "./pane-state";
import { normalizeInputMatch, tmux } from "./tmux";
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

function readBand(fx: PaneEffects, target: string, harness: string, command: string): PaneBand {
  return fx.paneState(target, harness, command);
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
  to?: string;
  /** The bus root, threaded for the fusion gate's backup directory. */
  busHome: string;
}
