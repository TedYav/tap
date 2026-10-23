// Self-compaction worker, one detached process per compaction, three family modes.
// Codex, with durable proof: interrupt a busy turn with a single authorized
// Escape, submit bare `/compact` once through the locked submit seam, and gate
// the resume on a FRESH compacted record in the bound rollout. Missing, late, or
// unreadable proof is NOT COMPACTED: the handoff is preserved and nothing is sent.
// Claude: the worker waits on no-effect courier refusals, submits the focused
// control once, then waits for a fresh bound transcript summary before resume.
// OpenCode: the worker waits for two idle reads, submits bare `/compact` once,
// then waits for a completed summary in its bound store before sending the resume.
import { appendFileSync, closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { resolveContext, resolveSelf, TapError, type ResolvedContext } from "./context";
import { loadRegistry, seatMap, type Seat, loadCurrentRegistry } from "./registry";
import { atomicWrite } from "./fsatomic";
import { acquirePaneLock } from "./panelock";
import { authorizePaneEffect, inspectClearFenceRecord, submitVerifyLocked, REAL_EFFECTS, type BoundRecipient, type PaneEffects, type SubmitAuthority, type SubmitResult } from "./courier";
import { agentAtRest, detectAgentState, type AgentState } from "./agent-state";
import { classifySubmitFrame } from "./submit-frame";
import { capturePane, observePane, pressEscape, settle, tmuxReadOnly } from "./tmux";
import { assertResetUnfenced, resetFenceRefusal } from "./reset";
import { recoveryHold } from "./recovery/state";
import { cmdSendOutcome, type SendOutcome } from "./verbs/send";
import { AGENT_FAMILIES } from "./harness-families";
import { copyBrief, requireHandoff, validateNotify, notifyRecoveryFailure, sendRecovery, sameSeat, transcriptIdentity } from "./self-rebrief";
import { compactionWitnessPath, captureCompactionBoundary, compactionEnterEffects, waitForCompactionProof, type CompactionBoundary, type CompactionProof } from "./compaction-proof";
import { checkText } from "./self-gate";
import { focusNarrowing, handoffPing } from "./compact-focus";
import { tapScriptsDir, artifactBun, runtimeModule } from "./scripts-dir";
import { applySwitches, claudeSwitchEffects, hasSwitches, requireSwitchHarness, switchFailure, switchWarning, type SeatSwitches, type SwitchReport } from "./self-switch";

const scripts = tapScriptsDir();
const HEAD_BYTES = 65536;
const TAIL_BYTES = 2 * 1024 * 1024;
const INTERRUPT_TIMEOUT_MS = 30000;
const DEFAULT_TIMEOUT_MS = 600000;

export interface Options { handoffPath?: string; pane: string; focus: string; notify?: string; switches?: SeatSwitches }
export interface CompactRequest {
  id: string; registry: string; bus: string; team: string; handle: string; command: string;
  bound: BoundRecipient & { handle: string; instance: string };
  oldSession: string; oldTranscript: string; handoff: string; focus: string; resumePing?: string; notify?: string;
  /** The Codex turn observed at arm time; a different latest turn means new work and refuses every pane effect. */
  turnId: string;
}
export type CompactState = "armed" | "interrupted" | "submitted" | "submission-unverified" | "compacted" | "resume-sent" | "resume-miss" | "not-compacted" | "incomplete";
export interface CompactReceipt {
  state: CompactState; detail: string; handoff?: string; delivery?: string;
  compactedAt?: string; ordinal?: number;
}
export type SeatReadiness = AgentState;
export interface CompactEffects {
  row(): Seat | undefined;
  state(): SeatReadiness;
  /** Latest Codex turn id in the bound rollout, or null when it cannot be proven (fail closed). */
  turn(): string | null;
  escape(): boolean;
  submit(): { result: SubmitResult; submitAt: string; baselineOffset: number };
  send(body: string): SendOutcome;
  record(receipt: CompactReceipt): void;
  /** Called exactly once after fresh compaction proof, before settle/resume: releases the pane-submit lock so the resume send never parks behind the worker's own hold. Earlier exits keep the lock; the worker's finally releases it. */
  unlock?(): void;
  settle(seconds: number): void;
  wait(): Promise<void>;
  now(): number;
}

/** Every self-compaction preserves an authored brief before arming. */
export function parseOptions(argv: string[]): Options {
  const out: Partial<Options> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--") {
      const focus = argv.slice(i + 1).join(" ").trim();
      if (!focus) throw new Error("focus text is required: run tap self compact --handoff <file> -- '<focus>'");
      out.focus = focus;
      break;
    }
    if (!["--pane", "--handoff-path", "--notify"].includes(key ?? "")) throw new Error(`unexpected argument: ${key}`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
    const field = ({ "--pane": "pane", "--handoff-path": "handoffPath", "--notify": "notify" } as const)[key!]!;
    if (out[field] !== undefined) throw new Error(`duplicate ${key}`);
    out[field] = value;
  }
  if (!out.pane) throw new Error("self compact requires --pane <tmux-target>");
  if (!out.focus) throw new Error("focus text is required: run tap self compact --handoff <file> -- '<focus>'");
  if (!out.handoffPath) throw new Error("an authored --handoff FILE is required; use /tap:self compact to prepare it");
  return out as Options;
}

function readSlice(fd: number, start: number, size: number): string {
  const bytes = Buffer.alloc(size);
  return bytes.subarray(0, readSync(fd, bytes, 0, size, start)).toString("utf8");
}

/**
 * The first qualifying compacted record strictly after the captured submit
 * boundary. The boundary is the byte offset captured immediately before the
 * real Enter: only complete JSONL records appended after that offset can be
 * proof, and their timestamp must clear `sinceIso`. Older rollouts without
 * top-level ordinals prove through the same gate (an ordinal, when present, is
 * carried for observability, never required). Fails closed: no bound
 * session_meta, a truncated or rewritten rollout, an unreadable offset
 * boundary, or an unparseable timestamp yields no proof.
 */
export function compactedAfter(path: string, session: string, sinceIso: string, sinceOffset: number): { timestamp: string; ordinal?: number } | null {
  if (!isAbsolute(path) || !session || !Number.isFinite(Date.parse(sinceIso)) || !Number.isSafeInteger(sinceOffset) || sinceOffset < 0) return null;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return null;
    const size = fstatSync(fd).size;
    if (size < sinceOffset) return null;
    const head = readSlice(fd, 0, Math.min(size, HEAD_BYTES)).split("\n");
    let bound = false;
    for (const line of head) {
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event.type === "session_meta") { bound = event.payload?.id === session; break; }
    }
    if (!bound) return null;
    let region = readSlice(fd, sinceOffset, Math.min(size, sinceOffset + TAIL_BYTES) - sinceOffset);
    if (sinceOffset > 0) {
      const boundary = Buffer.alloc(1);
      readSync(fd, boundary, 0, 1, sinceOffset - 1);
      if (boundary[0] !== 0x0a) region = region.slice(region.indexOf("\n") + 1);
    }
    region = region.slice(0, region.lastIndexOf("\n") + 1);
    for (const line of region.split("\n")) {
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event.type !== "compacted" && !(event.type === "event_msg" && event.payload?.type === "context_compacted")) continue;
      const at = typeof event.timestamp === "string" ? event.timestamp : "";
      if (!at || !Number.isFinite(Date.parse(at))) continue;
      if (Date.parse(at) > Date.parse(sinceIso)) {
        const ordinal = event.ordinal;
        return Number.isSafeInteger(ordinal) ? { timestamp: at, ordinal } : { timestamp: at };
      }
    }
    return null;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * The latest Codex turn id in the bound rollout: `turn_context.payload.turn_id`
 * or a task event's `turn_id`, last one wins. The search walks backward in
 * bounded chunks with no tail ceiling — a long active turn can push its marker
 * past any fixed window — and reconstructs a marker record that straddles a
 * chunk boundary from both halves. A trailing fragment without its newline is
 * mid-write, never evidence — and when that record spans whole chunks, its
 * bytes stay discarded until the walk reaches the chunk holding its opening
 * boundary newline; reassembling them earlier would present mid-write bytes
 * as a finished record. A complete malformed record newer than the newest
 * valid marker also returns null: it could conceal that marker, and accepting
 * an older id would interrupt new work. Null when the rollout is unreadable,
 * malformed in that way, or exposes no complete turn marker; callers fail
 * closed on all of those.
 */
export function latestTurnId(path: string): string | null {
  const isTurnMarker = (line: string): string | null | "malformed" => {
    let event; try { event = JSON.parse(line); } catch { return "malformed"; }
    const payload = event.payload ?? {};
    if (typeof payload.turn_id !== "string" || !payload.turn_id) return null;
    if (event.type === "turn_context" || (event.type === "event_msg" && String(payload.type ?? "").startsWith("task_"))) return payload.turn_id;
    return null;
  };
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return null;
    const size = fstatSync(fd).size;
    let carry = "";
    let eofOpen = true;
    for (let end = size; end > 0;) {
      const start = Math.max(0, end - 262144);
      const chunk = readSlice(fd, start, end - start);
      const lines = chunk.split("\n");
      const trailing = lines.pop() ?? "";
      if (eofOpen) {
        // The file's final record has no newline yet: every byte down to the
        // first newline found in an older chunk belongs to it, and none of it
        // is complete evidence.
        if (!lines.length) { end = start; continue; }
        eofOpen = false;
      } else if (end !== size) {
        lines.push(trailing + carry);
      }
      if (start > 0) carry = lines.length ? lines.shift()! : trailing + carry;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i]) continue;
        const turn = isTurnMarker(lines[i]!);
        if (turn === "malformed") {
          // Chunk edges carry partial records out of the scan, so every line
          // scanned here is complete — and the walk is newest-first: a
          // malformed record newer than a marker conceals it, and accepting
          // the older id would interrupt new work.
          return null;
        }
        if (turn) return turn;
      }
      end = start;
    }
    return null;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

function rolloutSize(path: string): number {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try { return fstatSync(fd).isFile() ? fstatSync(fd).size : -1; } finally { closeSync(fd); }
  } catch { return -1; }
}

const resultDetail = (result: SubmitResult): string => "detail" in result && result.detail ? result.detail : result.status;
const msg = (error: unknown): string => error instanceof Error ? error.message : String(error);
/** Only actual final outcomes publish self-helper.log pointers; armed/observed phases stay out of the terminal surface. */
export const TERMINAL: ReadonlySet<CompactState | WakeState> = new Set(["resume-sent", "resume-miss", "not-compacted", "not-submitted", "incomplete"]);

/**
 * Custody holds that must refuse ANY pane effect — Escape, the locked submit,
 * and the real Enter: a live team reset fence, an in-flight recovery run owning
 * the pane, and a live clear fence on the recipient. One narrow seam so the
 * Escape path, the submit path and the Enter effect answer to the same
 * predicates — no second copies.
 */
export function escapeRefusal(
  authority: SubmitAuthority,
  paneId: string,
  probes: {
    resetFence: (busHome: string) => { detail: string } | null;
    recovery: (paneId: string) => boolean;
    clear: (busHome: string, handle: string) => { state: string };
  } = { resetFence: busHome => resetFenceRefusal(busHome, "self compact Escape"), recovery: paneId => recoveryHold(paneId), clear: inspectClearFenceRecord },
): string | null {
  const busHome = authority.busHome ?? "";
  const fence = probes.resetFence(busHome);
  if (fence) return fence.detail;
  if (probes.recovery(paneId)) return `recovery owns pane '${paneId}'; refusing the pane effect`;
  const clear = probes.clear(authority.recipientBusHome || busHome, authority.recipient ?? "");
  if (clear.state === "live") return `seat '${authority.recipient}' is mid-clear; refusing the pane effect`;
  return null;
}

/**
 * The locked Codex submit, gated by the one custody seam at BOTH effect
 * moments: before the courier stages anything, and at the real Enter — so a
 * recovery that appears after `/compact` is staged still sends no Enter. Each
 * gate throws once; the caller records the refusal and never retries.
 */
/** Before staging, require ordinary idle; at Enter, recognize only our exact owned command. */
export function compactReadiness(screen: string, title: string, staged = false): SeatReadiness {
  if (staged) {
    const frame = classifySubmitFrame(screen, "codex", "/compact");
    if (frame.state !== "staged") return "unknown";
    if (frame.mode !== "idle") return "working";
  }
  return detectAgentState("codex", screen, title, staged).agentState;
}

export function lockedCompactSubmit(
  request: CompactRequest,
  authority: SubmitAuthority,
  readiness: (staged?: boolean) => SeatReadiness,
  base: PaneEffects = REAL_EFFECTS,
  probes?: Parameters<typeof escapeRefusal>[2],
): { result: SubmitResult; submitAt: string; baselineOffset: number } {
  const hold = escapeRefusal(authority, request.bound.paneId, probes);
  if (hold) throw new Error(hold);
  let submitAt = "", baselineOffset = -1;
  const lockedFx: PaneEffects = { ...base, pressEnter: target => {
    if (latestTurnId(request.oldTranscript) !== request.turnId) {
      throw new Error("turn: a new Codex turn started after staging; refusing Enter; nothing interrupted");
    }
    if (!agentAtRest(readiness(true))) {
      throw new Error("readiness: staged compact is not idle or no longer owned; refusing Enter; nothing interrupted");
    }
    const late = escapeRefusal(authority, request.bound.paneId, probes);
    if (late) throw new Error(late);
    submitAt = new Date().toISOString();
    baselineOffset = rolloutSize(request.oldTranscript);
    return base.pressEnter(target);
  } };
  const result = submitVerifyLocked(request.bound.paneId, request.id, "/compact", request.bound, lockedFx, authority);
  return { result, submitAt, baselineOffset };
}

export async function runCompact(request: CompactRequest, fx: CompactEffects, timeout = DEFAULT_TIMEOUT_MS): Promise<void> {
  let phase: CompactState = "armed";
  const finish = (state: CompactState, detail: string, extra: Partial<CompactReceipt> = {}) => {
    try { fx.record({ state, detail: `${phase}: ${detail}`, handoff: request.handoff, ...extra }); }
    catch (error) { console.error(`self: compact receipt unavailable: ${error}; ${detail}`); }
  };
  try {
    const row = fx.row();
    if (!sameSeat(request, row) || row?.harness_session_id !== request.oldSession ||
      !transcriptIdentity(request.oldTranscript, request.bound.harness, request.oldSession)) {
      return finish("incomplete", "identity: seat or bound rollout changed before any effect; nothing submitted");
    }
    const readiness = fx.state();
    if (readiness === "working") {
      if (fx.turn() !== request.turnId) {
        return finish("incomplete", "turn: a new Codex turn started since arming; refusing to interrupt it; handoff preserved; nothing submitted");
      }
      let escaped: boolean;
      try { escaped = fx.escape(); }
      catch (error) { return finish("incomplete", `interrupt refused before Escape: ${msg(error)}`); }
      if (!escaped) return finish("not-compacted", "interrupt-unobserved: Escape did not reach the pane; nothing submitted");
      phase = "interrupted";
      fx.record({ state: phase, detail: "one authorized Escape sent to a working pane", handoff: request.handoff });
      const deadline = fx.now() + INTERRUPT_TIMEOUT_MS;
      let idle = 0;
      while (fx.now() < deadline) {
        if (agentAtRest(fx.state())) { idle++; if (idle >= 2) break; } else idle = 0;
        await fx.wait();
      }
      if (idle < 2) return finish("not-compacted", "interrupt-unobserved: pane never returned to idle; nothing submitted; queued work untouched");
    } else if (!agentAtRest(readiness)) {
      return finish("not-compacted", `${readiness}: seat is not compactable now; nothing submitted`);
    }
    const pre = fx.row();
    if (!sameSeat(request, pre) || pre?.harness_session_id !== request.oldSession) {
      return finish("incomplete", "identity: seat changed before Enter; nothing submitted");
    }
    if (!agentAtRest(fx.state())) {
      return finish("incomplete", "readiness boundary lost: pane took new work before Enter; nothing submitted; queued work untouched");
    }
    if (fx.turn() !== request.turnId) {
      return finish("incomplete", "turn: a new Codex turn started since arming; refusing to compact stale work; handoff preserved; nothing submitted");
    }
    const submission = fx.submit();
    const accepted = submission.result.status === "injected" || submission.result.status === "harness_queued";
    const uncertain = submission.result.status === "unverified";
    if (!accepted && !uncertain) {
      return finish("incomplete", `submission ${submission.result.status}: ${resultDetail(submission.result)}; no automatic retry; nothing sent`);
    }
    phase = accepted ? "submitted" : "submission-unverified";
    if (!submission.submitAt || !Number.isFinite(Date.parse(submission.submitAt))) {
      return finish("incomplete", `submission ${submission.result.status} (${resultDetail(submission.result)}); submission proof clock unavailable; refusing to guess the boundary`);
    }
    fx.record({ state: phase, detail: accepted ? "bare /compact submitted; compaction proof pending" : `submission unverified (${resultDetail(submission.result)}); observing the transcript without resubmitting`, handoff: request.handoff });
    const deadline = fx.now() + timeout;
    const tick = (): { timestamp: string; ordinal?: number } | null | "drift" => {
      const current = fx.row();
      if (!sameSeat(request, current) || current?.harness_session_id !== request.oldSession) return "drift";
      return compactedAfter(request.oldTranscript, request.oldSession, submission.submitAt, submission.baselineOffset);
    };
    let proof: { timestamp: string; ordinal?: number } | null = null;
    while (fx.now() < deadline && !proof) {
      const scanned = tick();
      if (scanned === "drift") return finish("incomplete", "identity: seat or conversation changed while awaiting compaction proof; nothing further sent");
      proof = scanned;
      if (!proof) await fx.wait();
    }
    if (!proof) {
      // Documented boundary scan: a record that landed during the final wait is
      // still fresh proof. The deadline is NOT extended by this pass.
      const scanned = tick();
      if (scanned === "drift") return finish("incomplete", "identity: seat or conversation changed at the proof deadline; nothing further sent");
      proof = scanned;
    }
    if (!proof) {
      return finish("not-compacted", "no fresh compacted record — NOT COMPACTED; handoff preserved; nothing sent");
    }
    phase = "compacted";
    fx.record({ state: phase, detail: "fresh compacted record observed", handoff: request.handoff, compactedAt: proof.timestamp, ordinal: proof.ordinal });
    fx.unlock?.();
    fx.settle(2);
    const post = fx.row();
    if (!sameSeat(request, post) || post?.harness_session_id !== request.oldSession) {
      return finish("resume-miss", "identity: seat changed before resume; handoff preserved for manual resume");
    }
    const body = request.resumePing?.trim()
      ? request.resumePing
      : handoffPing(request.handoff, request.handle, "", request.focus, process.env, request.notify);
    let outcome: SendOutcome;
    try { outcome = fx.send(body); }
    catch (error) { return finish("resume-miss", `resume send failed: ${msg(error)}; handoff preserved for manual resume`); }
    if (outcome.rc !== 0) {
      return finish("resume-miss", `resume send ${outcome.disposition}; handoff preserved for manual resume`, { delivery: outcome.disposition });
    }
    finish("resume-sent", `resume ${outcome.disposition}; acceptance does not prove the seat read it`, { delivery: outcome.disposition });
  } catch (error) { finish("incomplete", msg(error)); }
}

// --- Claude and OpenCode wake (tap-joqz, tap-ieiy, tap-lmbs) -------------------
//
// A detached wait lets the submitting turn end so its queued /compact can run.
// The resume is withheld until the native transcript/store proves completion.

export type WakeMode = "claude" | "opencode";
export interface WakeRequest {
  mode: WakeMode; id: string; registry: string; bus: string; team: string; handle: string;
  bound: BoundRecipient & { handle: string; instance: string };
  /** Historical armed requests may lack a brief; every new arm requires one. */
  handoff?: string; focus: string; resumePing?: string; notify?: string;
  session: string; transcript: string; boundary?: CompactionBoundary;
  /** New Claude submission authority. Older requests with a boundary only observe. */
  queuedAt?: number;
  /** Claude only: `/model` then `/effort`, after compaction proof and before the resume. */
  switches?: SeatSwitches;
}
export type WakeState = "armed" | "queued" | "submitting" | "compacted" | "submitted" | "submission-unverified" | "resume-sent" | "resume-miss" | "not-compacted" | "not-submitted" | "incomplete";
export interface WakeReceipt { state: WakeState; detail: string; handoff?: string; delivery?: string; evidence?: CompactionProof["evidence"]; compactedAt?: string; queuedAt?: string; submittedAt?: string; switches?: SwitchReport }
export interface WakeSubmission { result: SubmitResult; boundary?: CompactionBoundary; effectAttempted?: boolean }
export interface WakeEffects {
  row(): Seat | undefined;
  state(): SeatReadiness;
  /** Claude may retry only when effectAttempted is explicitly false. */
  submit(): WakeSubmission;
  send(body: string): SendOutcome;
  /** Requested tier switches, applied after proof and before the resume; never withholds the resume. */
  switches?(switches: SeatSwitches): Promise<SwitchReport>;
  record(receipt: WakeReceipt): void;
  /** Appends one line to wake-unverified.log, the aggregate record of wakes whose ordering or delivery was not established. */
  unverified(reason: string): void;
  unlock?(): void;
  settle(seconds: number): void;
  wait(): Promise<void>;
  now(): number;
}

/** A detached worker's seat row, reread from the registry its request names.
 * The request path never passed selection, so an old-format store refuses here
 * (old_store) and the caller records incomplete before any pane effect. */
export function requestSeat(registry: string, handle: string): Seat | undefined {
  return seatMap(loadCurrentRegistry(registry))[handle];
}

/** One nonblocking, identity-bound attempt through the shared composer gate. */
export function submitQueuedClaude(request: WakeRequest, base: PaneEffects = REAL_EFFECTS,
  takeLock: (pane: string, timeout: number) => { release(): void } | null = acquirePaneLock): WakeSubmission {
  const controlId = `self-${request.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const focus = request.focus.replace(/ +$/, ""), marker = ` [[sv:${controlId}]]`;
  const gate = checkText("compact", focus, "", marker), narrowing = focusNarrowing(focus);
  if (!gate.ok || narrowing) return { result: { status: "unverified", detail: !gate.ok ? gate.message : `compact focus narrows context: ${narrowing}` }, effectAttempted: false };
  const lock = takeLock(request.bound.paneId, 0);
  if (!lock) return { result: { status: "lock_busy", detail: "another submit holds the pane" }, effectAttempted: false };
  let effectAttempted = false, boundary: CompactionBoundary | undefined;
  try {
    if (recoveryHold(request.bound.paneId)) return { result: { status: "recovery_held", detail: "recovery owns the pane" }, effectAttempted: false };
    const seat = requestSeat(request.registry, request.handle);
    if (!sameSeat(request, seat) || seat?.harness_session_id !== request.session || compactionWitnessPath("claude", seat) !== request.transcript) {
      return { result: { status: "identity_mismatch", detail: "compaction binding changed before submit" }, effectAttempted: false };
    }
    const tracked: PaneEffects = { ...base,
      injectText: (target, text) => { effectAttempted = true; return base.injectText(target, text); },
      pressEnter: target => { effectAttempted = true; return base.pressEnter(target); },
      ...(base.pressKeys && { pressKeys: (...args: Parameters<NonNullable<PaneEffects["pressKeys"]>>) => { effectAttempted = true; return base.pressKeys!(...args); } }),
    };
    const fx = compactionEnterEffects("claude", seat!, tracked, captured => { boundary = captured; });
    const authority: SubmitAuthority = { registryPath: request.registry, recipient: request.handle, busHome: request.bus,
      agentFamilies: AGENT_FAMILIES, scriptsDir: scripts, typedPrefix: "/compact ", preserveDraft: false, expectedNativeSession: request.session };
    const result = submitVerifyLocked(request.bound.paneId, controlId, focus + marker, request.bound, fx, authority);
    return { result, boundary, effectAttempted };
  } finally { lock.release(); }
}

const WAKE_SPACING_SECONDS = 2;
/** What an operator can do when the worker typed but could not prove the frame (tap-vho8h). */
export const COMPOSER_HINT = "the typed /compact text is likely still in the composer: press Enter there to submit it, or clear it; the worker never retypes or presses Enter without proof";

export async function runWake(request: WakeRequest, fx: WakeEffects, timeout = DEFAULT_TIMEOUT_MS, spacing = WAKE_SPACING_SECONDS): Promise<void> {
  let phase: WakeState = "armed";
  let submitUnverified = "";
  let proof: CompactionProof | null = null;
  const timeline: Pick<WakeReceipt, "queuedAt" | "submittedAt" | "switches"> = {};
  const valid = () => {
    const row = fx.row();
    return sameSeat(request, row) && row?.harness_session_id === request.session && compactionWitnessPath(request.mode, row) === request.transcript;
  };
  const finish = (state: WakeState, detail: string, extra: Partial<WakeReceipt> = {}) => {
    try { fx.record({ state, detail: `${phase}: ${detail}`, handoff: request.handoff, ...timeline, ...proof, ...extra }); }
    catch (error) { console.error(`self: compact receipt unavailable: ${error}; ${detail}`); }
  };
  const step = (state: WakeState, detail: string) => { phase = state; fx.record({ state, detail, handoff: request.handoff, ...timeline, ...proof }); };
  try {
    if (!valid()) return finish("incomplete", "identity: seat or native session changed before any effect; nothing sent");
    let boundary = request.boundary;
    if (request.mode === "claude" && Number.isFinite(request.queuedAt) && !boundary) {
      timeline.queuedAt = new Date(request.queuedAt!).toISOString();
      const deadline = request.queuedAt! + timeout;
      step("queued", "waiting for the courier's input and custody checks; no input attempted");
      for (;;) {
        if (!valid()) return finish("incomplete", "identity: seat or native session changed while queued; nothing submitted");
        if (fx.now() >= deadline) return finish("not-submitted", "queue deadline expired; handoff preserved; no input or resume sent");
        // Record uncertainty before calling a seam that can type. A crash must
        // never leave a receipt that claims the worker is safely waiting.
        step("submitting", "attempting one locked courier submit; no replay after a possible input effect");
        const submission = fx.submit();
        const result = submission.result;
        boundary = submission.boundary;
        const deferred = ["lock_busy", "band_busy", "copy_mode", "recovery_held", "rate_limited"].includes(result.status);
        if (deferred && submission.effectAttempted === false && !boundary) {
          step("queued", `${result.status}: ${resultDetail(result)}; no input attempted`);
          await fx.wait();
          continue;
        }
        const accepted = result.status === "injected" || result.status === "harness_queued";
        if (!accepted && submission.effectAttempted === false && !boundary) {
          return finish("not-submitted", `${result.status}: ${resultDetail(result)}; handoff preserved; no input or resume sent`);
        }
        if (accepted) timeline.submittedAt = new Date(fx.now()).toISOString();
        if (!accepted) {
          // The text may be sitting in the composer with no Enter behind it.
          // Say so here and in every later receipt: the operator's Enter is the
          // recovery, never a retype by this worker.
          const detail = resultDetail(result);
          submitUnverified = /press Enter/.test(detail) ? `${result.status}: ${detail}` : `${result.status}: ${detail}; ${COMPOSER_HINT}`;
          console.error(`self: compact submit unverified for ${request.handle}: ${submitUnverified}`);
        }
        step(accepted ? "submitted" : "submission-unverified", accepted
          ? "focused /compact submitted; compaction proof pending"
          : `${submitUnverified}; no automatic retry`);
        if (!accepted) fx.unverified("submission-unverified");
        break;
      }
    }
    if (request.mode === "opencode") {
      // Two consecutive idle reads mark a real turn boundary. The courier's own
      // pending-input hold refuses an occupied composer, so typed input survives.
      const deadline = fx.now() + timeout;
      let idle = 0;
      while (fx.now() < deadline) {
        if (agentAtRest(fx.state())) { idle++; if (idle >= 2) break; } else idle = 0;
        await fx.wait();
      }
      if (idle < 2) return finish("not-compacted", "no idle turn boundary observed before the deadline; nothing submitted");
      if (!valid()) return finish("incomplete", "identity: seat changed before submit; nothing submitted");
      const submission = fx.submit();
      const result = submission.result;
      boundary = submission.boundary;
      const accepted = result.status === "injected" || result.status === "harness_queued";
      if (!accepted && result.status !== "unverified") {
        return finish("incomplete", `submission ${result.status}: ${resultDetail(result)}; no automatic retry; nothing sent`);
      }
      step(accepted ? "submitted" : "submission-unverified", accepted
        ? "bare /compact submitted; compaction proof pending"
        : `submission unverified (${resultDetail(result)}); observing without resubmitting`);
      if (!accepted) fx.unverified("submission-unverified");
    }
    if (!boundary || boundary.mode !== request.mode || boundary.session !== request.session || boundary.path !== request.transcript) {
      fx.unverified("compaction-boundary-unavailable");
      return finish("not-compacted", submitUnverified
        ? `no Enter was pressed; input may have reached the composer (${submitUnverified}); handoff preserved; no retry or resume sent`
        : "submission proof boundary unavailable; input may have reached the composer; handoff preserved; no retry or resume sent");
    }
    proof = await waitForCompactionProof(boundary, { valid, wait: fx.wait, now: fx.now }, timeout);
    if (!proof) {
      fx.unverified("compaction-never-observable");
      return finish("not-compacted", submitUnverified
        ? `no fresh compaction proof after an unverified submit (${submitUnverified}); handoff preserved; no retry or resume sent`
        : "no fresh compaction proof; handoff preserved; no retry or resume sent");
    }
    step("compacted", `fresh compaction summary observed (${proof.evidence}); resume follows`);
    fx.unlock?.();
    // tap-lmbs: a follow-up queued with no gap often goes unprocessed.
    fx.settle(spacing);
    if (!valid()) return finish("resume-miss", "identity: seat or native session changed before resume; handoff preserved for manual resume");
    if (hasSwitches(request.switches) && fx.switches) {
      try { timeline.switches = await fx.switches(request.switches); }
      catch (error) { timeline.switches = switchFailure(request.switches, error); }
      if (switchWarning(timeline.switches)) fx.unverified("switch-unconfirmed");
      if (!valid()) return finish("resume-miss", "identity: seat or native session changed after the tier switch; handoff preserved for manual resume");
    }
    const body = switchWarning(timeline.switches) + (request.resumePing?.trim()
      ? request.resumePing
      : handoffPing(request.handoff ?? "", request.handle, "", request.focus, process.env, request.notify));
    let outcome: SendOutcome;
    try { outcome = fx.send(body); }
    catch (error) { fx.unverified("resume-send-failed"); return finish("resume-miss", `resume send failed: ${msg(error)}; handoff preserved for manual resume`); }
    if (outcome.rc !== 0) {
      fx.unverified("resume-send-failed");
      return finish("resume-miss", `resume send ${outcome.disposition}; handoff preserved for manual resume`, { delivery: outcome.disposition });
    }
    finish("resume-sent", `resume ${outcome.disposition}; acceptance does not prove the seat read it`, { delivery: outcome.disposition });
  } catch (error) { finish("incomplete", msg(error)); }
}

function readBounded(path: string, limit: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error(`not a regular file within ${limit} bytes: ${path}`);
    return readSlice(fd, 0, stat.size);
  } finally { closeSync(fd); }
}

function timeoutFromEnv(): number {
  const raw = process.env.TAP_SELF_COMPACT_TIMEOUT_SECONDS;
  const value = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value * 1000 : DEFAULT_TIMEOUT_MS;
}

const workerPath = runtimeModule("src/self-compact.ts");

function secondsFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const indexHome = () => process.env.TAP_INDEX_HOME || join(homedir(), ".tap");

function receiptWriter(path: string, request: CompactRequest | WakeRequest, extra: object = {}) {
  const receiptPath = path.slice(0, -5) + ".receipt.json";
  const helperLog = join(indexHome(), "self-helper.log");
  const pointer = (state: string, detail = "") => {
    try {
      mkdirSync(dirname(helperLog), { recursive: true, mode: 0o700 });
      appendFileSync(helperLog, `self compact ${request.id}: ${state}${detail ? ` (${detail})` : ""}; receipt: ${receiptPath}\n`, { mode: 0o600 });
    } catch (error) { console.error(`self: helper log pointer unavailable: ${error}`); }
  };
  return (receipt: { state: string; detail: string }) => {
    let previous = {};
    try { previous = JSON.parse(readFileSync(receiptPath, "utf8")); } catch { /* first receipt */ }
    atomicWrite(receiptPath, JSON.stringify({ ...previous, ...receipt, id: request.id, at: new Date().toISOString(), handoff: request.handoff, ...extra }) + "\n");
    if (TERMINAL.has(receipt.state as CompactState | WakeState) && receipt.state !== "resume-sent") {
      notifyRecoveryFailure({ ...request, verb: "compact" }, receiptPath, receipt.state, receipt.detail, (to, body) => sendRecovery(request, to, body));
    }
    if (TERMINAL.has(receipt.state as CompactState | WakeState)) pointer(receipt.state, receipt.state === "not-compacted" ? receipt.detail.replace(/\s+/g, " ").slice(0, 400) : "");
  };
}

function claimRun(path: string, id: string): boolean {
  try { writeFileSync(`${path}.started`, new Date().toISOString(), { flag: "wx", mode: 0o600 }); return true; }
  catch { console.error(`self: compact worker already ran for ${id}; refusing replay`); return false; }
}

/** One observation of the bound pane, classified; any unreadable part is "unknown". */
function paneReadiness(bound: BoundRecipient,
  classify: (screen: string, title: string) => SeatReadiness = (screen, title) => detectAgentState(bound.harness, screen, title).agentState): SeatReadiness {
  const obs = observePane(bound.paneId);
  if (!obs || typeof obs === "string" || obs.serverEpoch !== bound.serverEpoch) return "unknown";
  const screen = capturePane(bound.paneId, true);
  const title = tmuxReadOnly(["display-message", "-p", "-t", bound.paneId, "#{pane_title}"]);
  if (screen.code !== 0 || title.code !== 0) return "unknown";
  return classify(screen.stdout, title.stdout.trim());
}

function resumeSender(path: string, request: { id: string; handle: string; team: string; bound: BoundRecipient & { instance: string } }, session?: string) {
  return (body: string) => cmdSendOutcome(resumeSendArgs(request.handle, stageResumeBody(dirname(path), request.id, body)), scripts, AGENT_FAMILIES,
    { explicitTeam: request.team, expectedSenderInstance: request.bound.instance, quiet: true,
      reauthorize: registry => {
        const current = seatMap(registry)[request.handle];
        if (!sameSeat(request, current)) throw new Error("compact sender identity changed");
        if (session !== undefined && current?.harness_session_id !== session) throw new Error("compact native session changed before resume placement");
      } });
}

async function wakeWorker(path: string, request: WakeRequest): Promise<void> {
  const record = receiptWriter(path, request, { mode: request.mode });
  if (!claimRun(path, request.id)) return;
  const unverified = (reason: string) => {
    try {
      mkdirSync(indexHome(), { recursive: true, mode: 0o700 });
      appendFileSync(join(indexHome(), "wake-unverified.log"),
        `${new Date().toISOString().replace(/\.\d+Z$/, "Z")}\tpane=${request.bound.paneId}\tharness=${request.bound.harness}\treason=${reason}\tid=${request.id}\n`, { mode: 0o600 });
    } catch (error) { console.error(`self: wake-unverified record unavailable: ${error}`); }
  };
  // OpenCode retains its lock through proof. Claude takes a nonblocking lock
  // per attempt and releases it before waiting, proof or resume delivery.
  const lock = request.mode === "opencode" ? acquirePaneLock(request.bound.paneId) : null;
  if (request.mode === "opencode" && !lock) {
    record({ state: "incomplete", detail: "armed: another submit holds this pane; nothing submitted" });
    return;
  }
  let released = false;
  const release = () => { if (lock && !released) { released = true; lock.release(); } };
  try {
    const authority: SubmitAuthority = { registryPath: request.registry, recipient: request.handle, busHome: request.bus,
      agentFamilies: AGENT_FAMILIES, scriptsDir: scripts, singleEnter: true, expectedNativeSession: request.session };
    const pollMs = secondsFromEnv("TAP_SELF_COMPACT_POLL_SECONDS", 0.25) * 1000;
    await runWake(request, {
      row: () => requestSeat(request.registry, request.handle),
      state: () => paneReadiness(request.bound),
      submit: () => {
        if (request.mode === "claude") return submitQueuedClaude(request);
        const hold = escapeRefusal(authority, request.bound.paneId);
        if (hold) throw new Error(hold);
        let boundary: CompactionBoundary | undefined;
        const seat = requestSeat(request.registry, request.handle);
        if (!seat || seat.harness_session_id !== request.session || compactionWitnessPath(request.mode, seat) !== request.transcript) throw new Error("compaction binding changed before submit");
        const fx = compactionEnterEffects(request.mode, seat, REAL_EFFECTS, captured => { boundary = captured; });
        const result = submitVerifyLocked(request.bound.paneId, request.id, "/compact", request.bound, fx, authority);
        return { result, boundary };
      },
      send: resumeSender(path, request, request.session),
      switches: switches => applySwitches(switches, claudeSwitchEffects({
        id: request.id, bound: request.bound, authority, transcript: request.transcript, session: request.session,
        valid: () => { const seat = requestSeat(request.registry, request.handle); return sameSeat(request, seat) && seat?.harness_session_id === request.session; },
        settle, wait: () => Bun.sleep(pollMs),
      })),
      record,
      unverified,
      unlock: release,
      settle,
      now: Date.now,
      wait: () => Bun.sleep(request.mode === "claude" ? pollMs : 1000),
    }, timeoutFromEnv(), secondsFromEnv("TAP_SELF_PING_SPACING_SECONDS", WAKE_SPACING_SECONDS));
  } finally { release(); }
}

export async function worker(path: string): Promise<void> {
  const parsed = JSON.parse(readBounded(path, 65536)) as CompactRequest | WakeRequest;
  // --run consumes an already-armed operation, preserving its saved continuation.
  // The required-brief gate belongs to new preparation, never a historical replay.
  if ("mode" in parsed && (parsed.mode === "claude" || parsed.mode === "opencode")) return wakeWorker(path, parsed);
  const request = parsed as CompactRequest;
  const record = receiptWriter(path, request, { oldSession: request.oldSession, oldTranscript: request.oldTranscript }) as (receipt: CompactReceipt) => void;
  if (!claimRun(path, request.id)) return;
  const lock = acquirePaneLock(request.bound.paneId);
  if (!lock) {
    record({ state: "incomplete", detail: "armed: another submit holds this pane; nothing submitted" });
    return;
  }
  let released = false;
  const release = () => { if (!released) { released = true; lock.release(); } };
  try {
    const authority: SubmitAuthority = { registryPath: request.registry, recipient: request.handle, busHome: request.bus,
      agentFamilies: AGENT_FAMILIES, scriptsDir: scripts, expectedNativeSession: request.oldSession, singleEnter: true };
    const readiness = (staged = false): SeatReadiness =>
      paneReadiness(request.bound, (screen, title) => compactReadiness(screen, title, staged));
    await runCompact(request, {
      row: () => requestSeat(request.registry, request.handle),
      state: readiness,
      turn: () => latestTurnId(request.oldTranscript),
      escape: () => {
        const check = authorizePaneEffect(request.bound.paneId, request.bound, REAL_EFFECTS, authority);
        if (check.status !== "ok") throw new Error(check.detail);
        const hold = escapeRefusal(authority, request.bound.paneId);
        if (hold) throw new Error(hold);
        const pressed = pressEscape(request.bound.paneId);
        if (pressed === "rate_limited") throw new Error("tmux client budget exhausted before Escape");
        return pressed;
      },
      submit: () => lockedCompactSubmit(request, authority, readiness),
      send: resumeSender(path, request, request.oldSession),
      record,
      unlock: release,
      settle,
      now: Date.now,
      wait: () => Bun.sleep(1000),
    }, timeoutFromEnv());
  } finally { release(); }
}

/** The one production detachment seam: own process group, stdio to the worker log, never awaited. armSelfCompact and the process-lifetime test share it, so a detachment regression cannot hide behind a hand-rolled spawn in a test. */
export function spawnDetachedWorker(bun: string, workerScript: string, requestPath: string, logFd: number, env: NodeJS.ProcessEnv = process.env): number {
  const child = Bun.spawn([bun, workerScript, "--run", requestPath], { detached: true, stdin: "ignore", stdout: logFd, stderr: logFd, env: { ...env } });
  child.unref();
  return child.pid;
}

/**
 * The resume body rides a mode-0600 file beside the request, never inline: a
 * precomposed ping or a long focus has no inline guarantee, and
 * TAP_INLINE_MAX_BYTES may be far smaller than the text. File sourcing has no
 * size limit by design.
 */
export function stageResumeBody(dir: string, id: string, body: string): string {
  const path = join(dir, `${id}.compact.resume.txt`);
  writeFileSync(path, body, { mode: 0o600 });
  return path;
}

export function resumeSendArgs(handle: string, bodyPath: string): string[] {
  return [handle, "--from", handle, "--note", "--wake", "-f", bodyPath];
}

export function armSelfCompact(options: Options, context?: ResolvedContext): number {
  requireHandoff(options.handoffPath, "compact");
  const bun = artifactBun() ?? Bun.which("bun");
  if (!bun) throw new Error("Bun runtime is unavailable; nothing armed");
  const ctx = context ?? resolveContext();
  assertResetUnfenced(ctx.bus.home, "self compact");
  const self = resolveSelf(ctx, options.pane, 1);
  const seats = seatMap(loadRegistry(ctx.registryPath)), seat = seats[self.handle];
  if (!seat) throw new Error("seat is no longer registered; Codex compaction needs a registered seat with a bound rollout");
  const harness = String(seat.harness ?? "");
  const mode: WakeMode | "codex" | null = harness.startsWith("codex") ? "codex" : harness === "claude" ? "claude" : harness === "opencode" ? "opencode" : null;
  if (!mode) {
    throw new TapError(6, "compact_witness_unsupported", "unsupported harness", `self compact worker supports codex, claude and opencode; '${self.handle}' runs '${harness}'`);
  }
  requireSwitchHarness(options.switches, harness);
  validateNotify(options.notify, self.handle, seats);
  if (!seat.instance || !seat.server_epoch) throw new Error("seat identity is incomplete");
  // A background job carries the owner it was started for; a different seat
  // instance in that pane now is not the caller, and gets nothing armed.
  const owner = process.env.TAP_CALLER_SELECTED_INSTANCE;
  if (owner && owner !== seat.instance) throw new Error("background job owner changed before arming; nothing armed");
  const id = `${self.handle}-${new Date().toISOString().replace(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`;
  const handoff = copyBrief(ctx.bus.home, `${id}.compact`, options.handoffPath, undefined, "compact");
  const resumePing = handoffPing(handoff, self.handle, self.paneId, mode === "claude" ? "" : options.focus, process.env, options.notify);
  const bound = { paneId: self.paneId, instance: String(seat.instance), serverEpoch: String(seat.server_epoch), bootId: String(seat.boot_id ?? ""), harness, handle: self.handle };
  if (mode !== "codex") {
    const session = String(seat.harness_session_id ?? ""), transcript = compactionWitnessPath(mode, seat);
    // Validate before arming; the actual freshness boundary is captured at Enter.
    captureCompactionBoundary(mode, seat);
    const request: WakeRequest = { mode, id, registry: ctx.registryPath, bus: ctx.bus.home, team: ctx.team, handle: self.handle,
      bound, handoff, focus: options.focus, resumePing, notify: options.notify, session, transcript,
      ...(mode === "claude" && { queuedAt: Date.now() }), ...(hasSwitches(options.switches) && { switches: options.switches }) };
    const receipt = spawnRequest(bun, ctx.bus.home, id, request, { mode, handoff });
    const then = hasSwitches(options.switches) ? ` After proof it runs ${[options.switches.model && `/model ${options.switches.model}`, options.switches.effort && `/effort ${options.switches.effort}`].filter(Boolean).join(" then ")} before the resume.` : "";
    console.error(mode === "claude"
      ? `self: compact QUEUED; worker ARMED to wait for the composer and submit once. Resume requires fresh transcript proof.${then} End this turn now. Receipt: ${receipt}`
      : `self: compaction ARMED; the worker submits bare /compact at the next idle turn boundary; the resume requires fresh store proof. End this turn now. Receipt: ${receipt}`);
    return 0;
  }
  const oldSession = String(seat.harness_session_id ?? ""), oldTranscript = String(seat.transcript_path ?? "");
  if (!oldSession || !oldTranscript || !transcriptIdentity(oldTranscript, harness, oldSession)) {
    throw new Error("current native session/transcript identity is unverified; nothing armed");
  }
  const turnId = latestTurnId(oldTranscript);
  if (!turnId) throw new Error(`cannot prove the current Codex turn from ${oldTranscript}; nothing armed`);
  const request: CompactRequest = { id, registry: ctx.registryPath, bus: ctx.bus.home, team: ctx.team, handle: self.handle, command: "/compact",
    bound, oldSession, oldTranscript, handoff: handoff!, focus: options.focus, resumePing, notify: options.notify, turnId };
  const receipt = spawnRequest(bun, ctx.bus.home, id, request, { handoff, oldSession, oldTranscript });
  console.error(`self: compaction ARMED; completion unverified; end this turn now. Handoff: ${handoff}. Receipt: ${receipt}`);
  return 0;
}

/** Writes the request and its armed receipt under the bus handoff directory, then detaches the worker. Returns the receipt path. */
export function spawnRequest(bun: string, busHome: string, id: string, request: CompactRequest | WakeRequest, receiptFields: object): string {
  const dir = join(busHome, "handoff");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${id}.compact.json`);
  writeFileSync(path, JSON.stringify(request) + "\n", { flag: "wx", mode: 0o600 });
  const receipt = join(dir, `${id}.compact.receipt.json`);
  const queuedAt = "mode" in request && request.mode === "claude" ? request.queuedAt : undefined;
  const initial = { state: queuedAt === undefined ? "armed" : "queued", id, at: new Date().toISOString(),
    ...(queuedAt !== undefined && { queuedAt: new Date(queuedAt).toISOString() }), ...receiptFields,
    detail: "detached worker starting; no pane input attempted" };
  atomicWrite(receipt, JSON.stringify(initial) + "\n");
  const log = openSync(join(dir, `${id}.compact.log`), "a", 0o600);
  try {
    spawnDetachedWorker(bun, workerPath, path, log);
  } catch (error) {
    atomicWrite(receipt, JSON.stringify({ ...initial, state: "incomplete", at: new Date().toISOString(), detail: `worker spawn failed; nothing submitted: ${error}` }) + "\n");
    throw error;
  } finally { closeSync(log); }
  return receipt;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === "--run" && args.length === 2) await worker(args[1]!);
    else process.exitCode = armSelfCompact(parseOptions(args));
  } catch (error) {
    console.error(`self: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof TapError ? error.code : 1;
  }
}
