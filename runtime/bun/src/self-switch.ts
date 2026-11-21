// Seat-tier switches after a self context reset (Claude Code only). A seat that
// compacts or rebriefs on a cheap model asks for `/model` and `/effort` to run
// after the reset and before the resume note, so the first real turn runs on
// the requested tier. Each switch is a local harness command: it starts no model
// turn, and Claude Code records its outcome in the bound transcript as
// `<local-command-stdout>`, which is the proof. An unconfirmed switch never
// withholds the resume; the resume note carries a warning instead. The pane-submit
// lock is held from the first switch to the last proof, so no other delivery can
// start a model turn between the switches.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { TapError } from "./context";
import { submitVerifyLocked, authorizePaneEffect, inspectClearFenceRecord, REAL_EFFECTS, type PaneEffects, type BoundRecipient, type SubmitAuthority, type SubmitResult } from "./courier";
import { capturePane } from "./tmux";
import { acquirePaneLock } from "./panelock";
import { resetFenceRefusal } from "./reset";
import { recoveryHold } from "./recovery/state";

export interface SeatSwitches { model?: string; effort?: string }
export type SwitchKind = keyof SeatSwitches;
export interface SwitchOutcome { state: "confirmed" | "unconfirmed" | "skipped"; command: string; detail: string }
export type SwitchReport = Partial<Record<SwitchKind, SwitchOutcome>>;

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]*(\[[A-Za-z0-9]+\])?$/;
/** Refusals that took no pane effect and may clear on their own. */
const TRANSIENT: ReadonlySet<SubmitResult["status"]> = new Set(["band_busy", "recovery_held", "copy_mode", "rate_limited"]);
export const SWITCH_TIMEOUT_MS = 15000;

/**
 * `--model opus@high` is the preset spelling operators already use for a model
 * and its effort. Split it here, in place, so every caller sees two plain
 * values; an `--effort` that disagrees with the suffix refuses.
 */
function splitModelEffort(switches: SeatSwitches): void {
  const at = switches.model?.lastIndexOf("@") ?? -1;
  if (at <= 0) return;
  const level = switches.model!.slice(at + 1);
  if (switches.effort !== undefined && switches.effort !== level) {
    throw new TapError(1, "usage_error", "tap help self", `--model ${switches.model} names effort '${level}' but --effort says '${switches.effort}'; pass one`, "tap self");
  }
  switches.model = switches.model!.slice(0, at);
  switches.effort = level;
}

/** Value checks only: the transcript proof, not a name list, establishes that Claude Code accepted the model. */
export function checkSwitches(switches: SeatSwitches): void {
  splitModelEffort(switches);
  const { model, effort } = switches;
  if (model !== undefined && (model.length > 80 || !MODEL.test(model))) {
    throw new TapError(1, "usage_error", "tap help self", `--model must be one model name or alias, such as fable, sonnet or claude-opus-5-5[1m]; got '${model}'`, "tap self");
  }
  if (effort !== undefined && !(EFFORT_LEVELS as readonly string[]).includes(effort)) {
    throw new TapError(1, "usage_error", "tap help self", `--effort must be one of ${EFFORT_LEVELS.join("|")}; got '${effort}'`, "tap self");
  }
}

export const hasSwitches = (switches?: SeatSwitches): switches is SeatSwitches =>
  !!switches && (switches.model !== undefined || switches.effort !== undefined);

/** Refused before any effect: only Claude Code records the switch outcome TAP can prove. */
export function requireSwitchHarness(switches: SeatSwitches | undefined, harness: string): void {
  if (hasSwitches(switches) && harness !== "claude") {
    throw new TapError(6, "switch_unsupported", "omit --model and --effort",
      `DEGRADED — --model and --effort are supported on Claude Code only; '${harness || "unknown"}' has no provable switch. Nothing was armed`, "tap self");
  }
}

/** Model first: the effort levels a seat accepts depend on its model. */
export function switchSteps(switches: SeatSwitches): Array<{ kind: SwitchKind; value: string; command: string }> {
  const steps: Array<{ kind: SwitchKind; value: string; command: string }> = [];
  if (switches.model !== undefined) steps.push({ kind: "model", value: switches.model, command: `/model ${switches.model}` });
  if (switches.effort !== undefined) steps.push({ kind: "effort", value: switches.effort, command: `/effort ${switches.effort}` });
  return steps;
}

export function transcriptSize(path: string): number {
  if (!isAbsolute(path)) return -1;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    return stat.isFile() ? stat.size : -1;
  } catch { return -1; } finally { if (fd !== undefined) closeSync(fd); }
}

const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * A main-thread local-command result for this session, appended after `offset`
 * and stamped after `since`. The model line names the display name, never the
 * typed alias, so only its prefix is matched; the effort line names the level.
 */
export function switchProven(path: string, session: string, offset: number, since: number, kind: SwitchKind, value: string): boolean {
  if (!isAbsolute(path) || !session || !Number.isSafeInteger(offset) || offset < 0) return false;
  const expected = kind === "model" ? "<local-command-stdout>Set model to " : `<local-command-stdout>Set effort level to ${value}`;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const size = fstatSync(fd).size;
    if (size <= offset) return false;
    // Bounded tail: skipping old output may miss a witness, never invent one.
    const start = Math.max(offset, size - 1024 * 1024);
    const bytes = Buffer.alloc(size - start);
    const text = bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, start)).toString("utf8");
    for (const line of text.split("\n")) {
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event.type !== "user" || event.sessionId !== session || event.isSidechain === true) continue;
      if (typeof event.timestamp !== "string" || !(Date.parse(event.timestamp) > since)) continue;
      const content = event.message?.content;
      if (typeof content === "string" && content.replace(ANSI, "").startsWith(expected)) return true;
    }
    return false;
  } catch { return false; } finally { if (fd !== undefined) closeSync(fd); }
}

/** Join wrapped dialog whitespace only after its rule; all content and anchors must match. */
export function claudeModelConfirmation(frame: string): boolean {
  const rows = frame.replace(ANSI, "").split("\n");
  const rule = rows.findLastIndex(row => /^\s*▔{10,}\s*$/.test(row));
  if (rule < 0) return false;
  const dialog = rows.slice(rule + 1).join(" ").replace(/\s+/g, " ").trim();
  const selected = / ❯ 1\. Yes, switch to (.+?) 2\. No, go back Enter to confirm · Esc to cancel$/.exec(dialog);
  return !!selected && dialog === "Switch model? Your next response will be slower and use more tokens " +
    `This conversation is cached for the current model. Switching to ${selected[1]} means the full history gets re-read. ` +
    `❯ 1. Yes, switch to ${selected[1]} 2. No, go back Enter to confirm · Esc to cancel`;
}

export interface SwitchEffects {
  /** A nonblocking pane-submit lock, held across every switch and proof; null while another submit holds it. */
  reserve(): { release(): void } | null;
  /** The seat and its native session are still the ones the switches were armed for. */
  valid(): boolean;
  size(): number;
  submit(command: string, kind: SwitchKind): SubmitResult;
  /** One Enter on a recognized model dialog; false means no key sent. */
  acceptModelConfirmation?(): boolean;
  proven(kind: SwitchKind, value: string, offset: number, since: number): boolean;
  settle(seconds: number): void;
  wait(): Promise<void>;
  now(): number;
}

/**
 * Submit each requested switch once and wait, bounded, for its transcript
 * proof. Only a refusal that took no pane effect is retried. A submit that may
 * have left text in the composer ends all further typing for this reset, except
 * one Enter on the complete model confirmation after our own /model.
 */
export async function applySwitches(switches: SeatSwitches, fx: SwitchEffects, timeout = SWITCH_TIMEOUT_MS, spacing = 2): Promise<SwitchReport> {
  let lock: { release(): void } | null = null;
  try {
    const deadline = fx.now() + timeout;
    while (!(lock = fx.reserve()) && fx.now() < deadline) await fx.wait();
  } catch (error) { return switchFailure(switches, error); }
  if (!lock) return switchFailure(switches, new Error("another submit held the pane-submit lock until the deadline; nothing typed"));
  try { return await switchUnderLock(switches, fx, timeout, spacing); }
  finally { lock.release(); }
}

async function switchUnderLock(switches: SeatSwitches, fx: SwitchEffects, timeout: number, spacing: number): Promise<SwitchReport> {
  const report: SwitchReport = {};
  let halt = "";
  for (const step of switchSteps(switches)) {
    const outcome = (state: SwitchOutcome["state"], detail: string) => { report[step.kind] = { state, command: step.command, detail }; };
    if (halt) { outcome("skipped", halt); continue; }
    let accepted = false;
    try {
      if (!fx.valid()) { halt = "seat or native session changed; nothing more typed"; outcome("skipped", halt); continue; }
      let deadline = fx.now() + timeout;
      const offset = fx.size(), since = fx.now();
      let result = fx.submit(step.command, step.kind);
      while (TRANSIENT.has(result.status) && fx.now() < deadline && fx.valid()) {
        await fx.wait();
        result = fx.submit(step.command, step.kind);
      }
      if (step.kind === "model" && result.status === "unverified" && fx.valid()) {
        accepted = fx.acceptModelConfirmation?.() ?? false;
        if (accepted) deadline = fx.now() + timeout;
      }
      if (!accepted && result.status !== "injected" && result.status !== "harness_queued") {
        const detail = "detail" in result ? `: ${result.detail}` : "";
        outcome("unconfirmed", `submit ${result.status}${detail}`);
        // Effort levels belong to a model: an unsubmitted /model leaves effort on the old one.
        halt = `an earlier switch ended ${result.status}; nothing more typed`;
        continue;
      }
      let proven = offset >= 0 && fx.proven(step.kind, step.value, offset, since);
      while (!proven && offset >= 0 && fx.now() < deadline) {
        await fx.wait();
        proven = fx.proven(step.kind, step.value, offset, since);
      }
      outcome(proven ? "confirmed" : "unconfirmed", (accepted ? "model confirmation dialog accepted; " : "") + (proven ? "transcript recorded the switch"
        : offset < 0 ? "submitted; the bound transcript was unreadable, so the switch is unproven" : "submitted; no transcript confirmation before the deadline"));
      if (accepted && !proven) halt = "model confirmation was accepted but the switch is unproven; nothing more typed";
      // tap-lmbs: an input queued with no gap after a local command often goes unprocessed.
      fx.settle(spacing);
    } catch (error) {
      // A throw may follow a pane effect, so nothing more is typed; the resume still follows.
      outcome("unconfirmed", `${accepted ? "model confirmation dialog accepted; " : ""}switch failed: ${error instanceof Error ? error.message : String(error)}`);
      halt = "an earlier switch failed; nothing more typed";
    }
  }
  return report;
}

/** Every requested switch unconfirmed, for a switch hook that failed outright. */
export function switchFailure(switches: SeatSwitches, error: unknown): SwitchReport {
  const detail = `switch failed: ${error instanceof Error ? error.message : String(error)}`;
  return Object.fromEntries(switchSteps(switches).map(step => [step.kind, { state: "unconfirmed", command: step.command, detail }]));
}

/**
 * Production effects: submits go through the courier's locked submit under the
 * reserved pane lock, bound to the session the switches target, and proof reads
 * that session's Claude transcript.
 */
export function claudeSwitchEffects(target: { id: string; bound: BoundRecipient; authority: SubmitAuthority; transcript: string; session: string;
  valid(): boolean; settle(seconds: number): void; wait(): Promise<void> }, paneFx: PaneEffects = REAL_EFFECTS,
  capture: (pane: string, escaped: boolean, joined: boolean) => { code: number; stdout: string } = capturePane): SwitchEffects {
  const pane = target.bound.paneId;
  const authority: SubmitAuthority = { ...target.authority, expectedNativeSession: target.session, singleEnter: false };
  return { valid: target.valid, settle: target.settle, wait: target.wait, now: Date.now,
    reserve: () => acquirePaneLock(pane, 0),
    submit: (command, kind) => recoveryHold(pane) ? { status: "recovery_held", detail: "recovery owns the pane" }
      : submitVerifyLocked(pane, `${target.id}-${kind}`, command, target.bound, paneFx, authority),
    acceptModelConfirmation: () => {
      const frame = capture(pane, true, false);
      if (frame.code !== 0 || !claudeModelConfirmation(frame.stdout)) return false;
      // Keep the same pane/session and custody checks as every other named key.
      if (!target.valid() || authorizePaneEffect(pane, target.bound, paneFx, authority).status !== "ok") return false;
      if (resetFenceRefusal(authority.busHome ?? "", "self model confirmation") || recoveryHold(pane) ||
          inspectClearFenceRecord(authority.recipientBusHome || authority.busHome || "", authority.recipient ?? "").state === "live" ||
          paneFx.copyMode?.(pane)?.status !== "normal") return false;
      if (paneFx.pressEnter(pane) !== true) throw new Error("model confirmation Enter attempted but unverified; no retry");
      return true;
    },
    size: () => transcriptSize(target.transcript),
    proven: (kind, value, offset, since) => switchProven(target.transcript, target.session, offset, since, kind, value) };
}

/** One leading line for the resume note when any requested switch is unproven. */
export function switchWarning(report: SwitchReport | undefined): string {
  const missed = Object.values(report ?? {}).filter(outcome => outcome.state !== "confirmed");
  if (!missed.length) return "";
  return `TAP could not confirm ${missed.map(outcome => `'${outcome.command}' (${outcome.detail})`).join(" or ")}; this conversation may still run on the earlier model or effort. Tell the operator before taking on work that needs the requested tier. `;
}
