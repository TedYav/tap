// The `tap nudge` ladder (tap-xe42x): one pass, top to bottom, at most one key
// action per rung. Rung 1 dismisses an allowlisted blocker and continues; rung 2
// submits a staged sentinel and ends the run; rung 3 interrupts and delivers the
// senderless nudge doorbell. Every key is a recorded recovery effect (LadderIO.effect),
// and no rung ever sends C-c: on an idle composer it can exit the harness.

import { TapError } from "../context";
import { approvalPrompt, codexHookTrust, detectAgentState } from "../agent-state";
import { queuePrefix } from "../stuck-sentinel";

const USAGE = "tap help nudge";
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
export const plain = (frame: string): string => frame.replace(ANSI_RE, "");

/**
 * A blocker rung 1 may dismiss: a fixture-backed recognizer plus its cancel key.
 * Non-confirming keys only (Escape or the dialog's cancel key): never Enter, a
 * digit or an option. Adding a blocker is a captured frame, a fixture test and a row.
 */
export interface KnownBlocker { id: string; harness: string; keys: readonly string[]; matches(plainFrame: string): boolean }

const lastRows = (frame: string, count: number): string[] =>
  frame.split("\n").map(row => row.replace(/\s+$/, "")).filter(row => row.trim() !== "").slice(-count);

export const KNOWN_BLOCKERS: readonly KnownBlocker[] = [{
  // Claude Code's weekly usage-limit modal (2.1.282; the capture behind the recognizer is the fixture under
  // runtime/bun/test/fixtures/usage-limit-modal/). It replaces the composer; Esc cancels it (confirmed 2026-10-03: after a
  // usage limit Escape is safe).
  // Option 3 spends money and options 1-2 park the seat, so only Esc is ever sent.
  id: "claude-weekly-usage-limit",
  harness: "claude",
  keys: ["Escape"],
  matches(frame) {
    const rows = lastRows(frame, 12);
    const at = (re: RegExp) => rows.findIndex(row => re.test(row));
    const header = at(/^\s*What do you want to do\?$/);
    // The complete captured option set, in order: a dialog with other choices is not this one.
    const first = at(/^\s*(?:❯\s*)?1\.\s+Stop and wait for limit to reset$/);
    const second = at(/^\s*(?:❯\s*)?2\.\s+Wait here, then continue automatically at .+$/);
    const third = at(/^\s*(?:❯\s*)?3\.\s+Switch to usage credits$/);
    const options = rows.filter(row => /^\s*(?:❯\s*)?\d+\.\s/.test(row)).length;
    return header >= 0 && first > header && second > first && third > second && options === 3
      && /^\s*Enter to confirm · Esc to cancel$/.test(rows.at(-1) ?? "")
      && rows.slice(0, header).some(row => /You've hit your weekly limit/.test(row));
  },
}];

export function matchBlocker(harness: string, frame: string): KnownBlocker | null {
  const text = plain(frame);
  return KNOWN_BLOCKERS.find(row => row.harness === harness && row.matches(text)) ?? null;
}

/** Recognized decisions and unknown modals: rung 1 presses nothing for these. */
export function heldBlocker(harness: string, frame: string): string | null {
  if (codexHookTrust(harness, frame)) return "the Codex hook-trust dialog is a permission grant; answer it yourself";
  if (approvalPrompt(harness, frame)) return "an approval prompt is waiting for a decision";
  if (detectAgentState(harness, frame).agentState === "blocked") return "a dialog TAP does not dismiss is open";
  return null;
}

/**
 * Rung 3's interrupt key per harness. No C-c anywhere. Cursor has no
 * non-exiting interrupt key: its interrupt is message-based, two Enters after
 * the submitted nudge (as of 2026-10-05), a no-op when nothing is queued.
 * Hermes has no interrupt key: its bare submission interrupts, and
 * --no-interrupt types the nudge behind its safe `/queue ` prefix instead.
 */
export const NUDGE_INTERRUPT: Readonly<Record<string, { keys: readonly string[]; messageInterrupt?: { settleMs: number; gapMs: number } }>> = {
  claude: { keys: ["Escape"] },
  codex: { keys: ["Escape"] },
  agy: { keys: ["Escape"] },
  opencode: { keys: ["Escape", "Escape"] },
  cursor: { keys: [], messageInterrupt: { settleMs: 5000, gapMs: 200 } },
  hermes: { keys: [] },
};
export const CURSOR_INTERRUPT_SETTLE_MS = NUDGE_INTERRUPT.cursor!.messageInterrupt!.settleMs;
export const CURSOR_INTERRUPT_GAP_MS = NUDGE_INTERRUPT.cursor!.messageInterrupt!.gapMs;
const familyKey = (harness: string): string => harness.replace(/-.*$/, "");
export const interruptRow = (harness: string) => NUDGE_INTERRUPT[familyKey(harness)] ?? { keys: [] };

/** What rung 3 reads before every key: only `ready` (a readable, empty composer) admits one. */
export type ComposerKind = "ready" | "draft" | "queued" | "sentinel" | "unreadable";
export interface ComposerRead { kind: ComposerKind; detail?: string }

export interface EffectResult {
  /** Keys may have reached the pane (a possible effect); false is a recorded pre-key refusal. */
  sent: boolean;
  /** tmux accepted the keys and the target was re-proved afterwards. */
  ok: boolean;
  /** The effect's own verify read passed. */
  verified: boolean;
  summary: string;
}

/** A refusal an effect raises before it can reach any key (e.g. the run cannot be opened). */
export class PreKeyRefusal extends Error {
  constructor(readonly refusal: unknown) { super(String(refusal)); }
}

export interface LadderIO {
  frame(): string;
  composer(): ComposerRead;
  /** One recorded recovery effect; `gate` is re-read at the key boundary ("" admits). */
  effect(action: string, keys: string[], gate?: () => string, verify?: () => boolean): EffectResult;
  /** Bind the expected staged wire into the run before its Enter. */
  expect(wire: string): void;
  /** Rung 2: a staged sentinel's single Enter (or copy-mode park recovery); null when nothing is staged.
   * `reobserve` asks for a fresh composer read because rung 1 pressed a key. */
  submitStaged(reobserve: boolean): number | null;
  sleep(ms: number): void;
  out(line: string): void;
}

export interface LadderOptions { harness: string; interrupt: boolean; wire: string; label: string; deliver: boolean }

export const DISMISS_SETTLE_MS = 400;
export const INTERRUPT_SETTLE_MS = 400;
export const TYPE_SETTLE_MS = 150;

const POSSIBLE = "possible effect; do not re-nudge";

function composerRefusal(read: ComposerRead): string {
  switch (read.kind) {
    case "draft": return "the composer holds a draft; nudge never types over one (tap send preserves drafts)";
    case "queued": return "the seat has queued follow-ups an interrupt key would flush into the composer";
    case "sentinel": return "the composer holds TAP text that is not one complete sentinel";
    default: return `the composer is unreadable${read.detail ? ` (${read.detail})` : ""}`;
  }
}

export function runLadder(opts: LadderOptions, io: LadderIO): number {
  // Once any key may have landed, every later failure, thrown or returned, is a possible effect.
  let keyed = false;
  const tracked: LadderIO = { ...io, effect(action, keys, gate, verify) {
    let result: EffectResult;
    // An effect that throws (e.g. its receipt write failed) cannot prove its keys did not land.
    try { result = io.effect(action, keys, gate, verify); } catch (error) {
      if (error instanceof PreKeyRefusal) throw error.refusal;
      keyed = true;
      throw error;
    }
    if (result.sent) keyed = true;
    return result;
  } };
  try {
    const code = ladder(opts, tracked, () => keyed);
    if (!keyed || code === 0 || code === 5) return code;
    io.out(`tap nudge: ${opts.label}: stopped after a key had been sent (exit ${code}) (${POSSIBLE})`);
    return 5;
  } catch (error) {
    // Before any key a refusal is an ordinary refusal; after one, nothing can prove what the pane did.
    if (!keyed) throw error;
    const detail = error instanceof TapError ? error.detail : error instanceof Error ? error.message : String(error);
    io.out(`tap nudge: ${opts.label}: stopped after a key had been sent: ${detail} (${POSSIBLE})`);
    return 5;
  }
}

function ladder(opts: LadderOptions, io: LadderIO, keyed: () => boolean): number {
  const say = (text: string) => io.out(`tap nudge: ${opts.label}: ${text}`);
  const ready = () => io.composer().kind === "ready" ? "" : "the composer changed before the key; no keys sent";
  let dismissed = "";
  const held = (detail: string, errorClass = "nudge_held"): never => {
    throw new TapError(1, errorClass, `tap peek ${opts.label}`, `${dismissed}${detail}; ${keyed() ? "nothing more sent" : "nothing sent"}`);
  };

  // Rung 1: dismiss one allowlisted blocker, then re-observe and continue.
  let frame = io.frame();
  const blocker = matchBlocker(opts.harness, frame);
  if (blocker) {
    // The license is the match itself, re-proved at the key boundary on two fresh, identical samples.
    const stable = () => {
      const first = io.frame(); const second = io.frame();
      return first === second && blocker.matches(plain(second)) ? "" : `${blocker.id} was not stable on two samples; no keys sent`;
    };
    const result = io.effect(`nudge dismiss ${blocker.id}`, [...blocker.keys], stable);
    if (!result.sent) held(`dismissing ${blocker.id} was refused (${result.summary})`, "blocker_held");
    if (!result.ok) { say(`dismissal of ${blocker.id} UNVERIFIED (${result.summary}; ${POSSIBLE})`); return 5; }
    say(`dismissed ${blocker.id} (${blocker.keys.join(" ")})`);
    dismissed = `dismissed ${blocker.id}, then `;
    io.sleep(DISMISS_SETTLE_MS);
    // Only a positively observed dismissal continues; an unreadable post-key frame is not one.
    try { frame = io.frame(); } catch (error) {
      say(`the pane is unreadable after the dismissal (${error instanceof Error ? error.message : String(error)}; ${POSSIBLE})`);
      return 5;
    }
    if (matchBlocker(opts.harness, frame) || heldBlocker(opts.harness, frame)) {
      say(`a blocker is still showing after the dismissal (${POSSIBLE})`);
      return 5;
    }
  } else {
    const hold = heldBlocker(opts.harness, frame);
    if (hold) held(hold, "blocker_held");
  }

  // Rung 2: a staged sentinel gets its one Enter and ends the run.
  const staged = io.submitStaged(dismissed !== "");
  if (staged !== null) return staged;
  if (!opts.deliver) {
    say(`${dismissed}no staged sentinel; delivery skipped because --pane overrides the registered seat`);
    return 0;
  }

  // Rung 3: interrupt, then type and submit the doorbell once.
  const before = io.composer();
  if (before.kind !== "ready") held(composerRefusal(before));
  const row = interruptRow(opts.harness);
  let keysFell = dismissed !== "";
  const stop = (text: string): number => { say(`${text} (${POSSIBLE})`); return 5; };
  if (opts.interrupt && row.keys.length > 0) {
    const result = io.effect("nudge interrupt", [...row.keys], ready);
    if (!result.sent) held(`the interrupt was refused (${result.summary})`);
    if (!result.ok) return stop(`interrupt UNVERIFIED: ${result.summary}`);
    keysFell = true;
    io.sleep(INTERRUPT_SETTLE_MS);
    const after = io.composer();
    if (after.kind !== "ready") return stop(`interrupted (${row.keys.join(" ")}), but then ${composerRefusal(after)}; nothing typed`);
  }
  // Hermes: the bare submission is its interrupt; --no-interrupt queues it behind `/queue ` (as of 2026-10-05).
  const text = (opts.interrupt ? "" : queuePrefix(opts.harness)) + opts.wire;
  io.expect(text);
  const typed = io.effect("nudge type", ["-l", text], ready);
  if (!typed.sent) {
    if (keysFell) return stop(`typing the nudge was refused after earlier keys (${typed.summary})`);
    held(`typing the nudge was refused (${typed.summary})`);
  }
  if (!typed.ok) return stop(`typing the nudge UNVERIFIED: ${typed.summary}`);
  io.sleep(TYPE_SETTLE_MS);
  const enter = io.effect("nudge Enter", ["Enter"], undefined, () => io.composer().kind === "ready");
  if (!enter.sent) return stop(`the nudge is typed but its Enter was refused (${enter.summary}); inspect the pane before any later nudge submits it`);
  if (!enter.ok || !enter.verified) return stop(`nudge submission UNVERIFIED: ${enter.summary}`);
  const keys = opts.interrupt && row.keys.length > 0 ? `interrupted (${row.keys.join(" ")}) and ` : "";
  const recipe = row.messageInterrupt;
  if (opts.interrupt && recipe) {
    // Cursor's message interrupt: one effect with the submission for the no-retry ceiling.
    io.sleep(recipe.settleMs);
    for (const wait of [0, recipe.gapMs]) {
      if (wait) io.sleep(wait);
      const result = io.effect("cursor message-interrupt Enter", ["Enter"], ready);
      if (!result.sent) return stop(`delivered the nudge; Cursor's message interrupt stopped before its Enter (${result.summary})`);
      if (!result.ok) return stop(`delivered the nudge; Cursor's message interrupt UNVERIFIED: ${result.summary}`);
    }
    say(`delivered the nudge, then Cursor's message interrupt (Enter, Enter)`);
    return 0;
  }
  say(`${keys}delivered the nudge`);
  return 0;
}

/** The dry run's preview: the same reads, no effects. */
export function previewLadder(opts: LadderOptions, frame: string, composer: ComposerRead, stagedSentinel: boolean): string[] {
  const lines: string[] = [];
  const blocker = matchBlocker(opts.harness, frame);
  const hold = blocker ? null : heldBlocker(opts.harness, frame);
  if (blocker) lines.push(`rung 1: would dismiss ${blocker.id} (${blocker.keys.join(" ")}), then re-read the pane`);
  else if (hold) return [`rung 1: would hold: ${hold}; nothing would be sent`];
  else lines.push("rung 1: no blocker");
  if (stagedSentinel) return [...lines, "rung 2: would press Enter once on the staged sentinel"];
  lines.push("rung 2: no staged sentinel");
  if (!opts.deliver) return [...lines, "rung 3: skipped (--pane overrides the registered seat)"];
  if (!blocker && composer.kind !== "ready") return [...lines, `rung 3: would hold: ${composerRefusal(composer)}`];
  const row = interruptRow(opts.harness);
  const interrupt = !opts.interrupt ? "no interrupt (--no-interrupt)"
    : row.keys.length > 0 ? `interrupt with ${row.keys.join(" ")}`
    : row.messageInterrupt ? `no interrupt key; after the submit, Enter at +${row.messageInterrupt.settleMs} ms and +${row.messageInterrupt.gapMs} ms`
    : "no interrupt key (the submission interrupts)";
  return [...lines, `rung 3: would ${interrupt}, then type and submit ${opts.wire}`];
}

export function refuseUsage(detail: string): never {
  throw new TapError(1, "usage_error", USAGE, detail);
}
