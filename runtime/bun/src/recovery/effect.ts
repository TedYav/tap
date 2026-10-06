import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { normalizeInputMatch } from "../terminal-text";
import { composerHoldsExactly, sentinelInputTail, sentinelSubmitDecision, visibleSentinelId } from "../submit-frame";
import { matchSentinelSuffix } from "../sentinel-tail";
import { detectAgentState } from "../agent-state";
import { parseStuckSentinel, queuePrefix } from "../stuck-sentinel";
import { parseNudgeWire, renderNudgeWire } from "../nudge-wire";
import { repaintPane, type RepaintResult } from "../pane/repaint";
import { checkIdentityGuard, type IdentityGuardEvidence } from "./identity-guard";
import { atomicWrite } from "../fsatomic";
import { tapScriptsDir } from "../scripts-dir";
import { acquirePaneLock } from "../panelock";
import { isOpenCodeCommand, tmux, tmuxReadOnly, type Run } from "../tmux";
import { seatMap, loadCurrentRegistry } from "../registry";
import { OldStoreError } from "../register-authority";
import { MAX_EFFECTS, canAct, readRun, runDirectory, updateRun, writeRun, type RecoveryRun, type RecoveryTarget, type Liveness } from "./state";

export interface PaneSnapshot {
  dead: string; command: string; windowCount: string; paneId: string;
  instance: string | null; present?: boolean | null; pid?: string; registered?: boolean | null;
}
export type EffectOutcome = "verified" | "unverified" | "harness-exited" | "refused";
export interface RecoveryEvent {
  v: 1; recoveryId: string; seat: string; mode: string; action: string; reason: string;
  before: string | null; after: string | null; state: PaneSnapshot | null;
  effect?: "none" | "possible"; identityChecks?: IdentityGuardEvidence[];
  outcome: EffectOutcome; summary: string; at: string; incident: boolean;
}
export interface EffectIO {
  capture(target: RecoveryTarget, wholeHistory?: boolean): string;
  snapshot(target: RecoveryTarget): PaneSnapshot;
  authorize(target: RecoveryTarget, record?: (e: IdentityGuardEvidence) => void): string | null;
  repaint?(target: RecoveryTarget): RepaintResult;
  effect(args: string[]): Run;
  settle(): void;
}
function field(target: RecoveryTarget, format: string): string {
  const r = tmuxReadOnly(["display-message", "-p", "-t", target.paneId, format]);
  return r.code === 0 ? r.stdout.trim() : "";
}
export const REAL_RECOVERY_IO: EffectIO = {
  capture(target, wholeHistory = true) {
    const r = tmuxReadOnly(["capture-pane", "-p", "-e", "-J", ...(wholeHistory ? ["-S", "-"] : []), "-t", target.paneId]);
    if (r.code !== 0 || r.rateLimited) throw new Error("full before/after frame unavailable");
    return r.stdout;
  },
  snapshot(target) {
    let instance: string | null = null, registered: boolean | null = null;
    // An old-format registry is unknown, never evidence that the seat left.
    try { const row = seatMap(loadCurrentRegistry(target.registry))[target.handle]; registered = !!row; instance = String(row?.instance ?? ""); } catch { /* unknown */ }
    // A successful server inventory can prove absence; socket/read failure cannot.
    const presence = tmuxReadOnly(["list-panes", "-a", "-F", "#{pane_id}"]);
    const ids = presence.stdout.trim().split(/\r?\n/).filter(Boolean);
    return { registered, pid: field(target, "#{pane_pid}"), present: presence.code === 0 && !presence.rateLimited && ids.every(id => /^%\d+$/.test(id)) ? ids.includes(target.paneId) : null,
      dead: field(target, "#{pane_dead}"), command: field(target, "#{pane_current_command}"),
      windowCount: field(target, "#{session_windows}"), paneId: field(target, "#{pane_id}"), instance };
  },
  authorize(target, record) {
    try {
      const row = seatMap(loadCurrentRegistry(target.registry))[target.handle];
      if (!row || (row.status ?? "active") !== "active" || row.pane_id !== target.paneId || row.pane !== target.pane ||
          String(row.instance ?? "") !== target.instance || String(row.session ?? "") !== target.session ||
          String(row.harness ?? "") !== target.harness) return "captured target binding changed";
      if (!target.processPid || field(target, "#{pane_pid}") !== target.processPid) return "captured target process changed or is unobservable";
    } catch (error) { return error instanceof OldStoreError ? error.message : "captured target registry is unreadable"; }
    return checkIdentityGuard(target, record);
  },
  repaint: target => repaintPane(target.paneId),
  effect: args => tmux(args),
  settle: () => Bun.sleepSync(100),
};
function exited(run: RecoveryRun, state: PaneSnapshot): boolean {
  return state.present === false || state.dead === "1" || (state.registered === false && !!run.target.handle) ||
    (!!state.pid && !!run.target.processPid && state.pid !== run.target.processPid) || (state.instance !== null && state.instance !== run.target.instance) ||
    /^(?:ba|z|fi|da|k|c|tc)?sh$|^(?:less|more|vim|nvim|vi|nano)$/.test(state.command);
}

function expectedNudgeId(run: RecoveryRun): string | null {
  if (!run.nudgeExpected) return null;
  const parsed = parseStuckSentinel(run.nudgeExpected, run.target.harness);
  return parsed.ok ? parsed.fields.id : null;
}

/** The run expects an id-less nudge doorbell (bare, or behind Hermes' queue prefix). */
function isNudgeDoorbell(run: RecoveryRun): boolean {
  const prefix = queuePrefix(run.target.harness);
  const staged = run.nudgeExpected && prefix && run.nudgeExpected.startsWith(prefix) ? run.nudgeExpected.slice(prefix.length) : run.nudgeExpected;
  return !!staged && parseNudgeWire(staged) !== null;
}

/**
 * Nudge's Enter submits the whole composer, so a staged wire (ask, note or the
 * id-less doorbell, every family) must be its only text: an Enter never sends a
 * human draft along (tap-xe42x). Hermes may hold it behind its queue prefix. A
 * recorded scrolled tail (tap-1ncs6) must equal the whole bounded composer, so
 * text typed after it holds. A composer the reader cannot bound holds rather
 * than submits; only Claude's own scrolled input reads count beyond that.
 */
function soleStagedSentinel(run: RecoveryRun, frame: string): boolean {
  const expected = run.nudgeExpected;
  if (!expected) return false;
  const prefix = queuePrefix(run.target.harness);
  const wire = prefix && expected.startsWith(prefix) ? expected.slice(prefix.length) : expected;
  const harness = run.target.harness;
  const scrub = (f: string) => /^codex(?:-|$)/.test(harness) ? f.replace(/[\u2800-\u28ff]/g, " ") : f;
  if (!wire.startsWith("[[TAP")) {
    if (composerHoldsExactly(scrub(frame), harness, expected)) return true;
    const tail = harness.startsWith("claude") ? sentinelInputTail(frame, harness) : null;
    return tail !== null && normalizeInputMatch(tail) === normalizeInputMatch(expected);
  }
  if (composerHoldsExactly(scrub(frame), harness, wire)) return true;
  if (prefix && composerHoldsExactly(frame, harness, prefix + wire)) return true;
  // Claude's composer may show only the wire's scrolled tail; it is still the sole text.
  // Any other composer without a bounded reader (Cursor's borderless input) holds: a blank
  // row is not proof that no draft follows.
  const input = harness.startsWith("claude") ? sentinelInputTail(frame, harness) : null;
  return input !== null && matchSentinelSuffix(input, wire) === "tail";
}

function postRepaintSentinelMatches(run: RecoveryRun, frame: string): boolean {
  // A nudge doorbell has no id: the exact typed wire is what must still be staged.
  if (!soleStagedSentinel(run, frame)) return false;
  if (run.nudgeExpected && isNudgeDoorbell(run)) {
    return sentinelSubmitDecision(frame, run.target.harness, run.nudgeExpected, true).action === "submit";
  }
  const expected = expectedNudgeId(run);
  return expected !== null && visibleSentinelId(frame, run.target.harness, true) === expected;
}
export function appendRecoveryEvent(id: string, event: RecoveryEvent, env = process.env): void {
  appendFileSync(join(runDirectory(id, env), "events.jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 });
}

/**
 * Enter submits the WHOLE composer, so for the harnesses whose bounded composer read is proven
 * the nudge gate is "the composer holds the expected wire and nothing else": containment
 * (sentinelSubmitDecision) also admits the wire beside a human line or a second wire (tap-tg9vz).
 * Proven here: Codex, whose braille starfield rows the reader does not skip (its frame is
 * unpainted first, or a live staged sentinel would never compare equal), and Claude, narrow
 * (a scrolled tail of the wire is the wire and nothing else, tap-1ncs6) and wide, and AGY, whose
 * prompt-pair composer read is bounded by its rules. Every other
 * harness keeps containment alone: the generic readFrame counts Hermes's full-width bottom border
 * and cannot see Cursor's borderless composer, so an exact read would refuse a composer holding
 * only the wire. Bounded readers for those belong to readFrame's owners (tap-8nmot).
 */
function composerHoldsOnlyWire(frame: string, harness: string, expected: string): boolean {
  const codex = /^codex(?:-|$)/.test(harness);
  if (!codex && !harness.startsWith("claude") && harness !== "agy") return true;
  if (composerHoldsExactly(codex ? frame.replace(/[\u2800-\u28ff]/g, " ") : frame, harness, expected)) return true;
  if (!harness.startsWith("claude")) return false;
  const input = sentinelInputTail(frame, harness);
  return input !== null && matchSentinelSuffix(input, expected) === "tail";
}

/**
 * One recorded, bounded effect. Model thinking and completion waits never own this mutex.
 * `gate` is the caller's own license, re-read at the key boundary after the intent write:
 * "" admits the keys, anything else refuses before them; the captured target is re-proved
 * after it. `verify`, read under the same mutex between two target proofs, may mark a
 * successful effect verified.
 */
/**
 * Default-deny (tap-rlebf.1): no recovery key answers a prompt. At an approval
 * prompt or trust dialog only a lone Escape, which dismisses it, may go. On a
 * frame no rule classifies, no key may commit a choice or move a selection:
 * only Escape, 0 (a survey's dismissal, no harness's approval choice) and the
 * keys that edit the composer's own text (C-u, BSpace) may go. Enter and 1-9
 * commit; arrows, Tab, Home and End move a highlight the operator's next Enter
 * would take. Revisit if a harness ever commits on Escape or 0. The nudge path brings its own
 * staged-sentinel proof for its Enter instead. Whatever action label the caller
 * chose, the frame decides.
 */
const UNCLASSIFIED_KEYS = new Set(["Escape", "0", "C-u", "BSpace"]);
export function keysAnswerPrompt(harness: string, frame: string, keys: string[], nudge: boolean): string | null {
  if (keys.length === 2 && keys[0] === "-X" && keys[1] === "cancel") return null;
  // Escaped frames go in whole: Codex proves an empty composer by its dim placeholder.
  const state = detectAgentState(harness, frame).agentState;
  // Typed text can answer or filter any prompt, so it needs a pane positively read as a composer.
  if (keys[0] === "-l" && (state === "blocked" || state === "unknown")) {
    return `the pane state is ${state}, so typed text could answer a prompt TAP cannot see; no keys sent`;
  }
  if (state === "blocked" && !(keys.length === 1 && keys[0] === "Escape")) {
    return "an approval prompt or trust dialog is visible; only Escape may dismiss it; no keys sent";
  }
  if (state === "unknown" && !keys.every(key => UNCLASSIFIED_KEYS.has(key) || (nudge && key === "Enter"))) {
    return "the pane state is unclassified, so only Escape, 0, C-u or BSpace may go: another key could commit or move a choice in a prompt TAP cannot see; no keys sent";
  }
  return null;
}

export function recoveryEffect(
  id: string, action: string, reason: string, args: string[],
  io: EffectIO = REAL_RECOVERY_IO, env = process.env, facts?: () => Liveness, gate?: () => string, verify?: () => boolean,
): { code: number; event: RecoveryEvent } {
  if (!reason.trim() || !action.trim()) throw new Error("every recovery effect needs an action and policy decision reason");
  const initial = readRun(id, env);
  const event: RecoveryEvent = { v: 1, recoveryId: id, seat: `${initial.target.team}/${initial.target.handle}`,
    mode: initial.mode, action, reason, before: null, after: null, state: null,
    effect: "none", identityChecks: [], outcome: "refused", summary: "recovery effect refused", at: new Date().toISOString(), incident: false };
  const lock = acquirePaneLock(initial.target.paneId, 1000, env);
  if (!lock) {
    event.summary = "target effect mutex is busy; no keys sent";
    appendRecoveryEvent(id, event, env);
    return { code: 4, event };
  }
  const authorize = (target: RecoveryTarget) => io.authorize(target, detail => event.identityChecks!.push(detail));
  let attempted = false;
  let counted = false;
  let code = 1;
  try {
    const run = readRun(id, env);
    if (!canAct(run, env, facts?.()) || run.effects >= MAX_EFFECTS) throw new Error("recovery ownership expired, stopped, or exhausted; no keys sent");
    // Caller-supplied effects remain bounded key sequences. OpenCode's typed
    // repaint helper is internal observation hygiene and cannot route argv.
    if (args[0] !== "send-keys" || args[1] !== "-t" || args[2] !== run.target.paneId || args.length < 4) {
      throw new Error("recovery effects are keys to the exact bound pane only");
    }
    const keys = args.slice(3);
    const allowed = new Set(["Escape", "Enter", "C-u", "BSpace", "Up", "Down", "Left", "Right", "Tab", "BTab", "Home", "End", ..."0123456789"]);
    // The one literal-text license (tap-xe42x): `tap nudge` types its own doorbell,
    // byte-exact as rendered, and nothing else ever rides `-l`.
    // Hermes may type it behind its safe queue prefix (`tap nudge --no-interrupt`).
    const prefix = queuePrefix(run.target.harness);
    const typedText = keys.length === 2 && keys[0] === "-l" ? (prefix && keys[1]!.startsWith(prefix) ? keys[1]!.slice(prefix.length) : keys[1]!) : null;
    const nudgeWire = typedText === null ? null : parseNudgeWire(typedText);
    const typedNudge = nudgeWire !== null && action === "nudge type" && typedText === renderNudgeWire(nudgeWire.message);
    if (keys.length > 6 || (!(keys.length === 2 && keys[0] === "-X" && keys[1] === "cancel") && !typedNudge && !keys.every(key => allowed.has(key)))) {
      throw new Error("unsupported recovery key sequence");
    }
    event.state = io.snapshot(run.target);
    if (exited(run, event.state)) {
      event.outcome = "harness-exited"; event.incident = true;
      throw new Error("bound harness was already gone or its registered instance changed before the effect");
    }
    const denied = authorize(run.target);
    if (denied) throw new Error(denied);
    const stem = `effect-${run.effects + 1}-${randomUUID()}`;
    const dir = runDirectory(id, env);
    event.before = join(dir, `${stem}.before.ansi`);
    event.after = join(dir, `${stem}.after.ansi`);
    const beforeFrame = io.capture(run.target);
    writeFileSync(event.before, beforeFrame, { mode: 0o600, flag: "wx" });
    if (exited(run, event.state)) {
      event.outcome = "harness-exited"; event.incident = true;
      throw new Error("INCIDENT: bound harness exited or its registered instance changed before recovery");
    }
    const lateDenial = authorize(run.target);
    if (lateDenial || !canAct(run, env, facts?.())) throw new Error(lateDenial || "recovery expired during before capture");
    const refusal = keysAnswerPrompt(run.target.harness, beforeFrame, keys, action.startsWith("nudge "));
    if (refusal) throw new Error(refusal);
    const countEffect = () => {
      if (counted) return;
      run.effects++;
      writeRun(run, env);
      counted = true;
    };
    const nudgeEnter = action.startsWith("nudge ") && keys.includes("Enter");
    if (nudgeEnter && isOpenCodeCommand(run.target.harness)) {
      countEffect();
      let firstPostRepaint = beforeFrame;
      if (env.TAP_NUDGE_REPAINTED !== "1") {
        if (!io.repaint) throw new Error("OpenCode repaint is unavailable; no keys sent");
        const repaint = io.repaint(run.target);
        if (repaint.before !== null) writeFileSync(join(dir, `${stem}.repaint-before.ansi`), repaint.before, { mode: 0o600, flag: "wx" });
        if (repaint.after !== null) writeFileSync(join(dir, `${stem}.repaint-after.ansi`), repaint.after, { mode: 0o600, flag: "wx" });
        if (!repaint.ok || repaint.after === null) throw new Error(`${repaint.reason}; no keys sent`);
        firstPostRepaint = repaint.after;
        const repaintDenial = authorize(run.target);
        if (repaintDenial || !canAct(run, env, facts?.())) throw new Error(repaintDenial || "recovery expired after OpenCode repaint");
      } else {
        writeFileSync(join(dir, `${stem}.repaint-after.ansi`), beforeFrame, { mode: 0o600, flag: "wx" });
      }
      io.settle();
      const confirmation = io.capture(run.target);
      writeFileSync(join(dir, `${stem}.repaint-confirm.ansi`), confirmation, { mode: 0o600, flag: "wx" });
      if (!postRepaintSentinelMatches(run, firstPostRepaint) || !postRepaintSentinelMatches(run, confirmation)) {
        throw new Error("expected staged sentinel id was not stable across two post-repaint samples; no keys sent");
      }
    } else if (nudgeEnter &&
        (!run.nudgeExpected || sentinelSubmitDecision(beforeFrame, run.target.harness, run.nudgeExpected, true).action !== "submit"
          || !composerHoldsOnlyWire(beforeFrame, run.target.harness, run.nudgeExpected)
          || !soleStagedSentinel(run, beforeFrame))) {
      throw new Error("expected staged sentinel changed before Enter; no keys sent");
    }
    const finalDenial = authorize(run.target);
    if (finalDenial || !canAct(run, env, facts?.())) throw new Error(finalDenial || "recovery expired immediately before the effect");
    countEffect();
    // A crash can leave only intent after keys; it must never certify no effect.
    // Persist this immediately before the key boundary, after any input-free repaint.
    atomicWrite(join(dir, `${stem}.intent.json`), JSON.stringify({ ...event, effect: "possible", outcome: "unverified", state: event.state,
      summary: "effect intent persisted; completion not yet observed", argv: args, deadline: run.deadline }, null, 2));
    // The caller's license is the last read before the keys, after every state write;
    // a refusal here sends nothing (the conservative intent file stays).
    if (gate) {
      const unlicensed = gate();
      if (unlicensed) throw new Error(unlicensed);
      // The gate's own reads take time: the captured target is re-proved after them, with no write between.
      const gatedDenial = authorize(run.target);
      if (gatedDenial || !canAct(run, env, facts?.())) throw new Error(gatedDenial || "recovery expired during the caller's license read");
    }
    attempted = true; event.effect = "possible";
    const result = io.effect(args);
    code = result.code;
    io.settle();
    writeFileSync(event.after, io.capture(run.target), { mode: 0o600, flag: "wx" });
    event.state = io.snapshot(run.target);
    event.incident = exited(run, event.state);
    event.outcome = event.incident ? "harness-exited" : "unverified";
    event.summary = event.incident ? "INCIDENT: harness exited or registered instance changed after recovery; stopped" :
      `attempted ${action}; frames recorded, restored flow still requires submission evidence`;
    if (event.incident || result.code !== 0 || authorize(run.target)) {
      run.state = "stopped";
      if (!event.incident) event.summary = `effect or subsequent identity check unverified; stopped without replay (${result.stderr.trim()})`;
      code = 124; // Existing submit callers treat this as a possible effect, never a clean retry.
    } else if (verify?.() && !authorize(run.target)) {
      // Still under the pane mutex: the captured target was proved just before the
      // caller's fresh read and again after it, so the verdict is that target's.
      event.outcome = "verified";
      event.summary = `${action} verified on the captured target`;
    }
    writeRun(run, env);
  } catch (error) {
    if (attempted && event.after && !existsSync(event.after)) {
      try {
        io.settle();
        writeFileSync(event.after, io.capture(initial.target), { mode: 0o600, flag: "wx" });
        event.state = io.snapshot(initial.target);
        event.incident = exited(initial, event.state);
        if (event.incident) event.outcome = "harness-exited";
      } catch {
        try { event.state = io.snapshot(initial.target); event.incident = exited(initial, event.state); }
        catch { /* intent and the unverified event retain the evidence gap */ }
        if (event.incident) event.outcome = "harness-exited";
      }
    }
    event.summary = `${event.incident ? "INCIDENT: bound harness gone; stopped" : attempted ? "post-effect evidence unavailable; no replay" : "refused before keys"}: ${error instanceof Error ? error.message : error}`;
    if (attempted && !event.incident) event.outcome = "unverified";
    code = attempted ? 124 : 1;
    try {
      const run = readRun(id, env);
      run.state = "stopped";
      writeRun(run, env);
    } catch { /* fixed deadline/owner-gone still releases the courier */ }
  } finally {
    try { appendRecoveryEvent(id, event, env); }
    finally { lock.release(); }
  }
  return { code, event };
}


export function recordObservation(run: RecoveryRun, io: EffectIO = REAL_RECOVERY_IO, env = process.env, stage: "initial" | "final" | "inspection" = "inspection"): string {
  const path = join(runDirectory(run.id, env), `${stage}.ansi`);
  const event: RecoveryEvent = { v: 1, recoveryId: run.id, seat: `${run.target.team}/${run.target.handle}`,
    mode: run.mode, action: `inspect:${stage}`, reason: `${run.mode}: observation only, no pane effects`, before: null, after: null,
    state: null, outcome: "unverified", summary: "observation unavailable", at: new Date().toISOString(), incident: false };
  let frame = "", failure: unknown;
  try {
    frame = io.capture(run.target);
    writeFileSync(path, frame, { flag: "wx", mode: 0o600 });
    event.before = path; event.after = path;
    event.state = io.snapshot(run.target);
    event.incident = exited(run, event.state);
    event.outcome = event.incident ? "harness-exited" : "verified";
    event.summary = event.incident ? "INCIDENT: registered harness absent during inspection; no effects" : "inspection captured; no pane effects";
  } catch (error) {
    failure = error;
    try { event.state = io.snapshot(run.target); event.incident = exited(run, event.state); } catch { /* explicit observation gap */ }
    event.outcome = event.incident ? "harness-exited" : "unverified";
    event.summary = `${event.incident ? "INCIDENT: registered harness absent" : "observation unavailable"}: ${error}`;
  }
  appendRecoveryEvent(run.id, event, env);
  if (event.incident) updateRun(run.id, current => { current.state = "stopped"; current.summary = event.summary; }, env);
  if (failure) throw failure;
  if (event.incident && run.mode !== "report-only") throw new Error(event.summary);
  return frame;
}

/** One terminal notification attempt, shared by incident handling and worker completion. */
export function escalateRecovery(id: string, summary: string, env = process.env): number {
  const initial = readRun(id, env);
  const lock = acquirePaneLock(initial.target.paneId, 1000, env);
  if (!lock) throw new Error("cannot record recovery escalation ownership");
  let run: RecoveryRun;
  try {
    run = readRun(id, env);
    if (run.escalationAttemptedAt) return run.escalationCode ?? 1;
    run.escalationAttemptedAt = new Date().toISOString(); run.escalationStatus = "attempted"; run.summary = summary;
    writeRun(run, env);
  } finally { lock.release(); }
  const body = join(runDirectory(id, env), "escalation.md");
  const targetName = `${run.target.team}/${run.target.handle}`;
  const question = summary.startsWith(targetName + ":") ? summary : `${targetName}: ${summary}`;
  writeFileSync(body, `${question}\nRecovery: ${id}\nEvidence: ${runDirectory(id, env)}\n`, { mode: 0o600 });
  const result = spawnSync(process.execPath, [join(tapScriptsDir(), "../../../runtime/bun/src/verbs/escalate.ts"), "--team", run.caller?.team || run.target.team,
    // A recorded `user`/`unknown` nudge actor (no team) is evidence, not a seat that can escalate.
    "--from", (run.caller?.team && run.caller.actor) || run.target.handle, "-f", body], { env: { ...env, BUN_BE_BUN: "1" }, encoding: "utf8", timeout: 10_000 });
  atomicWrite(join(runDirectory(id, env), "escalation-result.json"), JSON.stringify({ at: new Date().toISOString(),
    code: result.status, error: result.error?.message, stdout: result.stdout, stderr: result.stderr }));
  const code = result.status ?? 1;
  updateRun(id, current => { current.escalationCode = code; current.escalationStatus = code === 0 ? "delivered" : "unconfirmed"; }, env);
  if (code !== 0) console.error(`tap recovery: user notification unconfirmed; retained ${join(runDirectory(id, env), "escalation-result.json")}`);
  return code;
}
