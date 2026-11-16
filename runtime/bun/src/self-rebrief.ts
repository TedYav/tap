// An authored brief survives first; a detached observer orders reset then wake.
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { callerPaneObservation, observeCallerPaneChain, resolveContext, resolveSelf, TapError, type ResolvedContext } from "./context";
import { loadRegistry, seatMap, type Seat, loadCurrentRegistry } from "./registry";
import { atomicWrite } from "./fsatomic";
import { acquirePathLock } from "./panelock";
import { submitVerify, type BoundRecipient, type SubmitAuthority, type SubmitResult } from "./courier";
import { agentAtRest, detectAgentState } from "./agent-state";
import { capturePane, observePane, settle, tmuxReadOnly } from "./tmux";
import { assertResetUnfenced, markResetGenerationReused } from "./reset";
import { cmdSendOutcome, SendAuthorizationPending, type SendOutcome } from "./verbs/send";
import { AGENT_FAMILIES } from "./harness-families";
import { mintId } from "./ids";
import { captureCodexResetBoundary, codexProcessInPane, codexRolloutAbsent, codexWriterState, nextCodexResetThread, sameCodexProcess, type CodexResetBoundary, type CodexThreadStart } from "./codex-reset-witness";
import { authoredRecovery } from "./compact-focus";
import { clearCommand } from "./clear-command";
import { tapScriptsDir, artifactBun } from "./scripts-dir";
import { applySwitches, checkSwitches, claudeSwitchEffects, hasSwitches, requireSwitchHarness, switchFailure, switchWarning, type SeatSwitches, type SwitchReport } from "./self-switch";
import { ownBunArgv } from "./own-bun";

export { clearCommand };

const scripts = tapScriptsDir();
export interface Options { verb: "clear" | "rebrief"; handoff?: string; charter?: string; notify?: string; pane?: string; harness?: string; switches?: SeatSwitches }
export interface Request {
  id: string; registry: string; bus: string; team: string; handle: string;
  bound: BoundRecipient; oldSession: string; oldTranscript: string;
  verb?: "clear" | "rebrief"; command: string; handoff?: string; notify?: string; recoveryId?: string;
  /** Claude only: `/model` then `/effort` in the fresh conversation, before the recovery note. */
  switches?: SeatSwitches;
}
type Witness = "none" | "native-id-changed" | "codex-thread-start";
export interface Receipt {
  state: "armed" | "submitted" | "submission-unverified" | "reset-observed" | "recovery-pending-proof" | "recovery-accepted" | "delivery-miss" | "incomplete";
  detail: string; newSession?: string; newTranscript?: string; delivery?: string;
  witness?: Witness; recoveryId?: string; firstInput?: string;
  threadStart?: CodexThreadStart; threadBoundary?: CodexResetBoundary; switches?: SwitchReport;
}
export function parseOptions(argv: string[]): Options {
  const verb = argv[0];
  if (verb !== "clear" && verb !== "rebrief") throw new Error("expected clear or rebrief");
  const out: Options = { verb };
  const switches: SeatSwitches = {};
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i];
    if (!["--handoff", "--charter", "--notify", "--pane", "--harness", "--model", "--effort"].includes(key ?? "")) throw new Error(`unexpected argument: ${key}`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
    if (key === "--model" || key === "--effort") {
      const field = key === "--model" ? "model" : "effort";
      if (switches[field] !== undefined) throw new Error(`duplicate ${key}`);
      switches[field] = value;
      continue;
    }
    const field = key!.slice(2) as "handoff" | "charter" | "notify" | "pane" | "harness";
    if (out[field] !== undefined) throw new Error(`duplicate ${key}`);
    out[field] = value;
  }
  if (hasSwitches(switches)) { checkSwitches(switches); out.switches = switches; }
  if (!out.handoff) throw new Error("an authored --handoff FILE is required; use /tap:self rebrief to prepare it");
  return out;
}
function readRegular(path: string, limit: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error(`not a regular file within ${limit} bytes: ${path}`);
    const bytes = Buffer.alloc(stat.size);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
  } finally { closeSync(fd); }
}
export function requireHandoff(path: string | undefined, verb: "compact" | "rebrief"): string {
  if (!path) throw new Error(`an authored --handoff FILE is required; use /tap:self ${verb} to prepare it`);
  let body: string;
  try { body = readRegular(resolve(path), 4 * 1024 * 1024); }
  catch { throw new Error(`--handoff must be a readable regular file within 4194304 bytes: ${path}; use /tap:self ${verb}`); }
  if (!body.trim()) throw new Error(`--handoff must be nonempty: ${path}; use /tap:self ${verb}`);
  return body;
}
export function validateNotify(notify: string | undefined, handle: string, seats: Record<string, Seat>): void {
  if (notify === undefined) return;
  const peer = Object.hasOwn(seats, notify) ? seats[notify] : undefined;
  if (!peer || typeof peer !== "object" || Array.isArray(peer) || notify === handle || (peer.status ?? "active") !== "active") throw new Error("--notify must name a different active teammate");
}
export function copyBrief(home: string, id: string, handoff?: string, charter?: string, verb: "compact" | "rebrief" = "rebrief"): string {
  // Validate every required source before publication or any pane effect.
  const body = requireHandoff(handoff, verb);
  const purpose = charter ? readRegular(resolve(charter), 4 * 1024 * 1024) : "";
  if (charter && !purpose.trim()) throw new Error("handoff and supplied charter must be nonempty");
  const path = join(home, "handoff", `${id}.md`);
  mkdirSync(join(home, "handoff"), { recursive: true, mode: 0o700 });
  writeFileSync(path, `# Authored ${verb} brief\n\nWritten before the requested ${verb}. These notes preserve existing instructions; they do not create new authority. Reconcile them with current instructions and live state.\n\n${charter ? `## Charter\n\n${purpose}\n\n` : ""}## Current handoff\n\n${body}\n`, { flag: "wx", mode: 0o600 });
  markResetGenerationReused(home, "handoff");
  return path;
}
/** Failure alerts have their own receipt; they cannot change or replay the reset outcome. */
export function notifyRecoveryFailure(request: { verb?: string; team: string; handle: string; handoff?: string; notify?: string },
  receiptPath: string, state: string, detail: string, send: (to: string, body: string) => SendOutcome): void {
  if (!request.notify) return;
  const verb = request.verb ?? "rebrief";
  const name = verb[0]!.toUpperCase() + verb.slice(1);
  let notification: { recipient: string; status: string; detail: string };
  try {
    const outcome = send(request.notify, `${name} ${state} for ${request.team}/${request.handle}: ${detail}. Receipt: ${receiptPath}. Preserved brief: ${request.handoff ?? "none"}. Inspect the receipt and seat, then forward the preserved brief if needed; do not repeat the operation merely to recover delivery.`);
    notification = { recipient: request.notify, status: outcome.rc === 0 ? "accepted" : "unconfirmed", detail: outcome.disposition };
  } catch (error) {
    notification = { recipient: request.notify, status: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
  try {
    mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });
    atomicWrite(`${receiptPath}.notify.json`, JSON.stringify(notification) + "\n");
  } catch (error) { console.error(`self: notification receipt unavailable: ${error}`); }
  if (notification.status !== "accepted") console.error(`self: outcome notification ${notification.status}: ${notification.detail}`);
}
export function sameSeat(request: { bound: BoundRecipient }, seat?: Seat): boolean {
  return !!seat && seat.instance === request.bound.instance && seat.pane_id === request.bound.paneId &&
    seat.server_epoch === request.bound.serverEpoch && seat.harness === request.bound.harness &&
    (seat.status ?? "active") === "active" && (seat.delivery ?? "pane") === "pane" &&
    (!request.bound.bootId || seat.boot_id === request.bound.bootId);
}
export function transcriptIdentity(path: string, harness: string, session: string): boolean {
  if (!isAbsolute(path) || !session) return false;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return false;
    const bytes = Buffer.alloc(65536);
    const text = bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0)).toString("utf8");
    for (const line of text.split("\n")) {
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (harness.startsWith("codex") && event.type === "session_meta") return event.payload?.id === session;
      if (harness === "claude" && event.sessionId === session && event.isSidechain !== true) return true;
    }
  } catch { return false; } finally { if (fd !== undefined) closeSync(fd); }
  return false;
}
export function freshIdentity(request: Request, seat?: Seat): { session: string; transcript: string } | null {
  if (!sameSeat(request, seat)) return null;
  const session = typeof seat!.harness_session_id === "string" ? seat!.harness_session_id : "";
  const transcript = typeof seat!.transcript_path === "string" ? seat!.transcript_path : "";
  if (!session || session === request.oldSession || transcript === request.oldTranscript) return null;
  return transcriptIdentity(transcript, request.bound.harness, session) ? { session, transcript } : null;
}
export interface Effects {
  row(): Seat | undefined; idle(): boolean; submit(): SubmitResult;
  /** Requested tier switches in the fresh conversation; never withholds the recovery note. */
  switches?(switches: SeatSwitches, fresh: { session: string; transcript: string }): Promise<SwitchReport>;
  send(to: string, body: string, id?: string, nativeSession?: string): SendOutcome; record(receipt: Receipt): void;
  fresh(seat?: Seat): { session: string; transcript: string } | null;
  prepareSubmit?(): boolean; resetThread?(): CodexThreadStart | null; bootstrapSafe?(thread: CodexThreadStart): boolean; firstInput?(transcript: string): string | null;
  wait(): Promise<void>; now(): number;
}
/** Bounded prefix only; startup AGENTS/environment messages precede the first turn context. */
export function firstCodexInput(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return null;
    const bytes = Buffer.alloc(1024 * 1024);
    const text = bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0)).toString("utf8");
    let turn = false;
    for (const line of text.split("\n")) {
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event.type === "turn_context") turn = true;
      if (event.type === "event_msg" && event.payload?.type === "user_message" && typeof event.payload.message === "string") return event.payload.message;
      if (turn && event.type === "response_item" && event.payload?.type === "message" && event.payload.role === "user") {
        return (event.payload.content ?? []).filter((item: { type: string }) => item.type === "input_text")
          .map((item: { text: string }) => item.text).join("\n");
      }
    }
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
  return null;
}
function firstInputMatches(text: string, id: string): boolean {
  // Recovery is a same-team note, optionally carrying a JSON-quoted preview.
  // A second sentinel or extra work in this input is not recovery-first proof.
  const match = /^\[\[TAP v0\.23 note ([^\s\]]+)(?: preview="(?:\\.|[^"\\\r\n])*")?\]\]$/.exec(text.trim());
  return match?.[1] === id;
}
export async function runRecovery(request: Request, fx: Effects, timeout = 180000): Promise<void> {
  const idleDeadline = fx.now() + timeout;
  const codex = request.bound.harness.startsWith("codex");
  const recoveryId = request.recoveryId ?? mintId(request.handle);
  let phase: Receipt["state"] = "armed";
  let witness: Witness = "none";
  let threadStart: CodexThreadStart | undefined;
  let waitingForBind=false;
  let switched: SwitchReport | undefined;
  const fail = (detail: string, state: "incomplete" | "delivery-miss" = "incomplete") => {
    try { fx.record({ state, detail: `${phase}: ${detail}`, witness, recoveryId, ...(switched && { switches: switched }) }); }
    catch (error) { console.error(`self: incomplete receipt unavailable: ${error}; ${detail}`); }
    notifyRecoveryFailure(request, join(request.bus, "handoff", `${request.id}.receipt.json`), state, `${phase}: ${detail}`, fx.send);
  };
  try {
    let idle = 0, ready = false;
    while (fx.now() < idleDeadline) {
      const row = fx.row();
      if (!sameSeat(request, row) || row?.harness_session_id !== request.oldSession) return fail("seat or conversation changed before submit");
      idle = fx.idle() ? idle + 1 : 0;
      if (idle >= 2 && (!fx.prepareSubmit || fx.prepareSubmit())) { ready=true; break; }
      await fx.wait();
    }
    if (!ready) return fail(idle<2 ? "no idle turn boundary observed; nothing submitted" : "native reset witness unavailable before submit; nothing submitted");
    const submitted = fx.submit();
    const uncertain = submitted.status === "unverified" && codex;
    if (submitted.status !== "injected" && submitted.status !== "harness_queued" && !uncertain) return fail(`reset submission ${submitted.status}; no automatic retry`);
    phase = uncertain ? "submission-unverified" : "submitted";
    fx.record({ state: phase, detail: uncertain ? "observe possible reset without repeating submission" : "reset command left input; reset not yet observed", witness, recoveryId });
    // Waiting for the initiating turn must not consume the reset's observation budget.
    const recoveryDeadline = fx.now() + timeout;
    let sent: SendOutcome | undefined;
    while (fx.now() < recoveryDeadline) {
      const row = fx.row();
      if (!sameSeat(request, row)) return fail("seat identity changed while observing reset");
      const fresh = fx.fresh(row);
      if (sent && fresh) {
        if (threadStart && fresh.session!==threadStart.session) return fail("post-input native conversation differs from the witnessed thread; inspect the receipt and forward the preserved brief","delivery-miss");
        const first = fx.firstInput?.(fresh.transcript);
        if (first !== null && first !== undefined) {
          phase = "reset-observed";
          fx.record({ state: phase, detail: "post-input native identity observed; checking first input", witness, recoveryId,
            newSession: fresh.session, newTranscript: fresh.transcript, firstInput: first });
          if (!firstInputMatches(first, recoveryId)) return fail("first substantive input was not authored recovery; inspect the receipt and forward the preserved brief", "delivery-miss");
          fx.record({ state: "recovery-accepted", detail: "post-input native identity and recovery-first transcript observed; recipient brief read remains unverified", witness, recoveryId,
            newSession: fresh.session, newTranscript: fresh.transcript, firstInput: first, delivery: sent.disposition });
          return;
        }
      }
      if (sent) { await fx.wait(); continue; }
      if (fresh) {
        witness = "native-id-changed";
        phase = "reset-observed";
        fx.record({ state: phase, detail: `${request.oldSession} -> ${fresh.session}`, witness, recoveryId, newSession: fresh.session, newTranscript: fresh.transcript });
        // Another input may have started Codex before this observer saw the reset.
        // Detect that miss before placing recovery as a disruptive second input.
        const first = codex ? fx.firstInput?.(fresh.transcript) : null;
        if (first !== null && first !== undefined && !firstInputMatches(first, recoveryId)) {
          fx.record({ state: phase, detail: "new conversation already has unrelated input; recovery not sent", firstInput: first });
          return fail("first substantive input was not authored recovery; recovery not sent; inspect the receipt and forward the preserved brief", "delivery-miss");
        }
      } else if (codex && row?.harness_session_id === request.oldSession && (threadStart=fx.resetThread?.() ?? undefined)) {
        witness = "codex-thread-start";
        if (fx.bootstrapSafe && !fx.bootstrapSafe(threadStart)) {
          waitingForBind=true;
          fx.record({state:phase,detail:"waiting for native bind; recovery not placed",witness,recoveryId,threadStart});
          await fx.wait(); continue;
        }
        phase = "recovery-pending-proof";
        fx.record({ state: phase, detail: "same-process native thread start observed; authored recovery will bootstrap rollout registration", witness, recoveryId, threadStart });
      } else { await fx.wait(); continue; }
      if (fresh && !codex && !switched && hasSwitches(request.switches) && fx.switches) {
        try { switched = await fx.switches(request.switches, fresh); }
        catch (error) { switched = switchFailure(request.switches, error); }
        fx.record({ state: phase, detail: "tier switches attempted before recovery", witness, recoveryId, switches: switched });
        if (!sameSeat(request, fx.row())) return fail("seat identity changed during the tier switch; recovery not sent");
      }
      {
        const evidence = fresh ? `Native session change observed: ${request.oldSession} -> ${fresh.session}.` : `Native Codex thread start observed: ${threadStart!.session}; bound rollout and recovery-first proof are pending until this input starts the turn.`;
        const body = `${switchWarning(switched)}TAP authored ${request.verb ?? "rebrief"} recovery for ${request.team}/${request.handle}. ${evidence} ${authoredRecovery(request.handoff ?? "the preserved bus brief", request.handle, request.notify)} Delivery acceptance does not establish that you read the brief.`;
        let outcome: SendOutcome;
        try { outcome=fx.send(request.handle,body,recoveryId,fresh?.session ?? request.oldSession); }
        catch (error) {
          if (!(error instanceof SendAuthorizationPending) || error.effect!=="none") throw error;
          waitingForBind=true;
          fx.record({state:phase,detail:`${error.message}; recovery not placed`,witness,recoveryId});
          await fx.wait(); continue;
        }
        if (outcome.rc !== 0) return fail(`recovery send ${outcome.disposition}; do not reset again`, "delivery-miss");
        if (codex) { sent = outcome; continue; }
        fx.record({ state: "recovery-accepted", detail: "durable recovery accepted; recipient read remains unverified", witness, recoveryId, newSession: fresh!.session, newTranscript: fresh!.transcript, delivery: outcome.disposition,
          ...(switched && { switches: switched }) });
        return;
      }
    }
    fail(sent ? "post-input native identity/recovery-first proof not observed before timeout; brief retained" : waitingForBind ? "waiting for native bind; recovery not placed; brief retained" : "fresh native session/transcript not observed before timeout; brief retained");
  } catch (error) { fail(String(error)); }
}
export function sendRecovery(request: Pick<Request, "team" | "handle" | "bound">, to: string, body: string, id?: string, nativeSession?: string, authorizeProcess?: ()=>void): SendOutcome {
  return cmdSendOutcome([to, "--from", request.handle, "--note", "--wake", "-m", body, ...(id ? ["--id", id] : [])], scripts, AGENT_FAMILIES,
    { explicitTeam: request.team, expectedSenderInstance: request.bound.instance, quiet: true,
      reauthorize: registry => {
        const current = seatMap(registry)[request.handle];
        if (!sameSeat(request, current)) throw new Error("self recovery sender identity changed");
        if (nativeSession !== undefined && current?.harness_session_id !== nativeSession) throw new Error("self recovery native session changed before recovery placement");
        authorizeProcess?.();
      } });
}
export function recoveryIdle(request: Request, fx = { observePane, capturePane, tmuxReadOnly }): boolean {
  const pane = fx.observePane(request.bound.paneId);
  if (!pane || pane.serverEpoch !== request.bound.serverEpoch) return false;
  // Codex's empty composer is corroborated by dim paint; plain text could be a draft.
  const screen = fx.capturePane(request.bound.paneId, true);
  const title = fx.tmuxReadOnly(["display-message", "-p", "-t", request.bound.paneId, "#{pane_title}"]);
  return screen.code === 0 && title.code === 0 && agentAtRest(detectAgentState(request.bound.harness, screen.stdout, title.stdout.trim()).agentState);
}
async function worker(path: string): Promise<void> {
  const request: Request = JSON.parse(readRegular(path, 65536));
  const receiptPath = path.slice(0, -5) + ".receipt.json";
  let threadBoundary: CodexResetBoundary | undefined;
  const record = (receipt: Receipt) => {
    let previous = {};
    try { previous = JSON.parse(readFileSync(receiptPath, "utf8")); } catch { /* first receipt */ }
    atomicWrite(receiptPath, JSON.stringify({ ...previous, ...receipt, id: request.id, at: new Date().toISOString(), handoff: request.handoff, oldSession: request.oldSession, oldTranscript: request.oldTranscript,
      ...(threadBoundary ? {threadBoundary} : {}) }) + "\n");
  };
  const lock = acquirePathLock(join(request.bus, "handoff", request.handle + ".rebrief.lock"), 0);
  if (!lock) {
    record({ state: "incomplete", detail: "another recovery observer already owns this seat; nothing submitted" });
    notifyRecoveryFailure(request, receiptPath, "incomplete", "another observer owns the seat; nothing submitted", (to, body) => sendRecovery(request, to, body));
    return;
  }
  try {
    // A repeated worker invocation never repeats a possibly submitted reset.
    writeFileSync(`${path}.started`, new Date().toISOString(), { flag: "wx", mode: 0o600 });
    const authority: SubmitAuthority = { registryPath: request.registry, recipient: request.handle, busHome: request.bus, agentFamilies: AGENT_FAMILIES, scriptsDir: scripts, expectedNativeSession: request.oldSession,
      singleEnter: request.bound.harness.startsWith("codex") };
    const codex=request.bound.harness.startsWith("codex");
    let observedThread: CodexThreadStart | undefined;
    const resolveOwner=(processUuid:string)=>{
      const pane=observePane(request.bound.paneId);
      if (!pane || pane.serverEpoch!==request.bound.serverEpoch) return null;
      return codexProcessInPane(processUuid,pane.panePid);
    };
    const owner=()=> threadBoundary ? resolveOwner(threadBoundary.processUuid) : null;
    await runRecovery(request, {
      row: () => seatMap(loadCurrentRegistry(request.registry))[request.handle], fresh: current => freshIdentity(request, current),
      idle: () => recoveryIdle(request),
      prepareSubmit: ()=> !codex || !!(threadBoundary=captureCodexResetBoundary(request.oldTranscript,request.oldSession,resolveOwner) ?? undefined),
      submit: () => submitVerify(request.bound.paneId, request.id, request.command, request.bound, authority),
      resetThread: ()=> {
        const next=threadBoundary ? nextCodexResetThread(threadBoundary,owner()) : null;
        observedThread=next ?? undefined;
        return next;
      },
      bootstrapSafe: thread=> !!threadBoundary && codexRolloutAbsent(threadBoundary.home,thread),
      firstInput: firstCodexInput,
      switches: (switches, fresh) => applySwitches(switches, claudeSwitchEffects({
        id: request.id, bound: request.bound, authority, transcript: fresh.transcript, session: fresh.session,
        valid: () => { const seat = seatMap(loadCurrentRegistry(request.registry))[request.handle]; return sameSeat(request, seat) && seat?.harness_session_id === fresh.session; },
        settle, wait: () => Bun.sleep(1000),
      })),
      send: (to, body, id, session) => sendRecovery(request, to, body, id, session,
        id && to===request.handle && threadBoundary ? ()=>{
          if (!sameCodexProcess(threadBoundary!,owner())) throw new Error("Codex process changed before recovery placement");
          if (observedThread && session===request.oldSession) {
            const state=codexWriterState(threadBoundary!.home,observedThread.session);
            if (state==="not-held") throw new Error("witnessed Codex writer released before placement");
            if (state==="unknown") throw new SendAuthorizationPending("Codex bootstrap pending: native lock state unknown");
            if (!codexRolloutAbsent(threadBoundary!.home,observedThread)) {
              throw new SendAuthorizationPending("rollout availability changed; waiting for native bind");
            }
          }
        } : undefined),
      record, now: Date.now, wait: () => Bun.sleep(1000),
    });
  } finally { lock.release(); }
}
export function armSelfRecovery(options: Options, context?: ResolvedContext, scriptsDir = scripts): number {
  requireHandoff(options.handoff, "rebrief");
  const bun = artifactBun() ?? Bun.which("bun");
  if (!bun) throw new Error("Bun runtime is unavailable; nothing armed");
  const workerPath = resolve(scriptsDir, "../../../runtime/bun/src/self-rebrief.ts");
  const ctx = context ?? resolveContext();
  assertResetUnfenced(ctx.bus.home, "self rebrief");
  // The harness-session fallback selects a background job's owner row and its socket.
  const caller = options.pane || callerPaneObservation(observeCallerPaneChain(process.env, ctx));
  if (caller && typeof caller !== "string" && caller.status === "ok" && caller.selectedSocket) {
    process.env.TAP_TMUX_SOCKET_PATH = caller.selectedSocket;
    delete process.env.TAP_TMUX_SOCKET;
  }
  if (!caller) throw new Error("cannot resolve current pane");
  const self = resolveSelf(ctx, caller, 1);
  const seats = seatMap(loadRegistry(ctx.registryPath)), seat = seats[self.handle];
  if (!seat) throw new Error("seat is no longer registered");
  const harness = String(seat.harness ?? "");
  if (options.harness && options.harness !== harness) throw new Error("--harness differs from registered harness");
  if (harness !== "claude" && !harness.startsWith("codex")) throw new TapError(6, "reset_witness_unsupported", "use a supervised peer reset", `no native reset witness for ${harness}`);
  requireSwitchHarness(options.switches, harness);
  const oldSession = String(seat.harness_session_id ?? ""), oldTranscript = String(seat.transcript_path ?? "");
  if (!transcriptIdentity(oldTranscript, harness, oldSession)) throw new Error("current native session/transcript identity is unverified; nothing armed");
  validateNotify(options.notify, self.handle, seats);
  if (!seat.instance || !seat.server_epoch) throw new Error("seat identity is incomplete");
  const id = `${self.handle}-${new Date().toISOString().replace(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`;
  const handoff = copyBrief(ctx.bus.home, id, options.handoff, options.charter);
  const request: Request = { id, verb: options.verb, registry: ctx.registryPath, bus: ctx.bus.home, team: ctx.team, handle: self.handle,
    bound: { paneId: self.paneId, instance: String(seat.instance), serverEpoch: String(seat.server_epoch), bootId: String(seat.boot_id ?? ""), harness, handle: self.handle },
    oldSession, oldTranscript, command: clearCommand(harness), handoff, notify: options.notify, recoveryId: mintId(self.handle),
    ...(hasSwitches(options.switches) && { switches: options.switches }) };
  const dir = join(ctx.bus.home, "handoff");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${id}.json`);
  writeFileSync(path, JSON.stringify(request) + "\n", { flag: "wx", mode: 0o600 });
  atomicWrite(join(dir, `${id}.receipt.json`), JSON.stringify({ state: "armed", witness: "none", recoveryId: request.recoveryId, id, handoff, oldSession, oldTranscript }) + "\n");
  const log = openSync(join(dir, `${id}.log`), "a", 0o600);
  try {
    const child = Bun.spawn([...ownBunArgv(bun), workerPath, "--run", path], { detached: true, stdin: "ignore", stdout: log, stderr: log, env: { ...process.env } });
    child.unref();
  } catch (error) {
    atomicWrite(join(dir, `${id}.receipt.json`), JSON.stringify({ state: "incomplete", id, handoff, detail: `observer spawn failed; nothing submitted: ${error}` }) + "\n");
    throw error;
  } finally { closeSync(log); }
  if (options.verb === "clear") console.error("self: clear is deprecated; use tap self rebrief with the same options (skill: /tap:self rebrief)");
  console.error(`self: ${options.verb} recovery ARMED, reset UNVERIFIED; end this turn now. Brief: ${handoff ?? "standing bus brief"}. Receipt: ${join(dir, `${id}.receipt.json`)}`);
  return 8;
}
if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === "--run" && args.length === 2) await worker(args[1]!);
    else if (args[0] === "command") process.stdout.write(clearCommand(args[1] ?? ""));
    else process.exitCode = armSelfRecovery(parseOptions(args));
  } catch (error) {
    console.error(`self: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof TapError ? error.code : 1;
  }
}
