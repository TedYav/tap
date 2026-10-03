// An authored brief survives first; a detached observer orders reset then wake.
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { callerPaneObservation, observeCallerPaneChain, resolveContext, resolveSelf, TapError, type ResolvedContext } from "./context";
import { loadRegistry, seatMap, type Seat, loadCurrentRegistry } from "./registry";
import { atomicWrite } from "./fsatomic";
import { acquirePathLock } from "./panelock";
import { submitVerify, type BoundRecipient, type SubmitAuthority, type SubmitResult } from "./courier";
import { detectAgentState } from "./agent-state";
import { capturePane, observePane, tmuxReadOnly } from "./tmux";
import { assertResetUnfenced } from "./reset";
import { cmdSendOutcome, type SendOutcome } from "./verbs/send";
import { AGENT_FAMILIES } from "./harness-families";
import { mintId } from "./ids";
import { codexPlaceholder } from "./terminal-text";
import { clearCommand } from "./clear-command";
import { tapScriptsDir, artifactBun } from "./scripts-dir";

export { clearCommand };

const scripts = tapScriptsDir();
export interface Options { verb: "clear" | "rebrief"; handoff?: string; charter?: string; notify?: string; pane?: string; harness?: string }
export interface Request {
  id: string; registry: string; bus: string; team: string; handle: string;
  bound: BoundRecipient; oldSession: string; oldTranscript: string;
  command: string; handoff?: string; notify?: string; recoveryId?: string;
}
type Witness = "none" | "native-id-changed" | "codex-ui-transition";
export interface Receipt {
  state: "armed" | "submitted" | "submission-unverified" | "reset-observed" | "recovery-pending-proof" | "recovery-accepted" | "delivery-miss" | "incomplete";
  detail: string; newSession?: string; newTranscript?: string; delivery?: string;
  witness?: Witness; recoveryId?: string; firstInput?: string;
}
export function parseOptions(argv: string[]): Options {
  const verb = argv[0];
  if (verb !== "clear" && verb !== "rebrief") throw new Error("expected clear or rebrief");
  const out: Options = { verb };
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i];
    if (!["--handoff", "--charter", "--notify", "--pane", "--harness"].includes(key ?? "")) throw new Error(`unexpected argument: ${key}`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
    const field = key!.slice(2) as "handoff" | "charter" | "notify" | "pane" | "harness";
    if (out[field] !== undefined) throw new Error(`duplicate ${key}`);
    out[field] = value;
  }
  if (out.verb === "rebrief" && (!out.handoff || !out.notify)) throw new Error("rebrief requires --handoff FILE and --notify <continuing-recovery-owner>");
  if (out.charter && !out.handoff) throw new Error("--charter requires --handoff");
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
export function copyBrief(home: string, id: string, handoff?: string, charter?: string): string | undefined {
  if (!handoff) return undefined;
  // Validate every required source before publication or any pane effect.
  const body = readRegular(resolve(handoff), 4 * 1024 * 1024);
  const purpose = charter ? readRegular(resolve(charter), 4 * 1024 * 1024) : "";
  if (!body.trim() || (charter && !purpose.trim())) throw new Error("handoff and supplied charter must be nonempty");
  const path = join(home, "handoff", `${id}.md`);
  mkdirSync(join(home, "handoff"), { recursive: true, mode: 0o700 });
  writeFileSync(path, `# Authored rebrief\n\nWritten before the requested reset. These notes preserve existing instructions; they do not create new authority. Reconcile them with current instructions and live state.\n\n${charter ? `## Charter\n\n${purpose}\n\n` : ""}## Current handoff\n\n${body}\n`, { flag: "wx", mode: 0o600 });
  return path;
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
  send(to: string, body: string, id?: string, nativeSession?: string): SendOutcome; record(receipt: Receipt): void;
  fresh(seat?: Seat): { session: string; transcript: string } | null;
  uiTransition?(): boolean; firstInput?(transcript: string): string | null;
  wait(): Promise<void>; now(): number;
}
/** Positive observed clear acknowledgement, fresh header, reset context and painted empty composer. */
export function codexUiTransition(before: string, after: string, oldSession: string): boolean {
  const plain = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const acknowledgement = (text: string) => plain(text).split("\n").some(line =>
    line.startsWith("To continue this session, run codex resume") && line.includes(`(${oldSession})`));
  return !!before && !acknowledgement(before) && acknowledgement(after)
    && /^\s*│\s*>_ OpenAI Codex \(v[^)]+\)/m.test(plain(after))
    && /\bContext 100% left\b/.test(plain(after))
    && after.split("\n").some(codexPlaceholder);
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
  const fail = (detail: string, state: "incomplete" | "delivery-miss" = "incomplete") => {
    try { fx.record({ state, detail: `${phase}: ${detail}`, witness, recoveryId }); }
    catch (error) { console.error(`self: incomplete receipt unavailable: ${error}; ${detail}`); }
    if (request.notify) {
      try {
        const sent = fx.send(request.notify, `Rebrief ${state} for ${request.team}/${request.handle}: ${phase}: ${detail}. Preserved brief: ${request.handoff ?? "none"}. Inspect the seat and forward the brief if needed; do not repeat reset merely to recover delivery.`);
        if (sent.rc !== 0) console.error(`self: owner notification unconfirmed (${sent.disposition})`);
      } catch (error) { console.error(`self: owner notification failed: ${error}`); }
    }
  };
  try {
    let idle = 0;
    while (fx.now() < idleDeadline) {
      const row = fx.row();
      if (!sameSeat(request, row) || row?.harness_session_id !== request.oldSession) return fail("seat or conversation changed before submit");
      idle = fx.idle() ? idle + 1 : 0;
      if (idle >= 2) break;
      await fx.wait();
    }
    if (idle < 2) return fail("no idle turn boundary observed; nothing submitted");
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
        const first = fx.firstInput?.(fresh.transcript);
        if (first !== null && first !== undefined) {
          phase = "reset-observed";
          fx.record({ state: phase, detail: "post-input native identity observed; checking first input", witness, recoveryId,
            newSession: fresh.session, newTranscript: fresh.transcript, firstInput: first });
          if (!firstInputMatches(first, recoveryId)) return fail("first substantive input was not authored recovery; owner must forward the brief", "delivery-miss");
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
          return fail("first substantive input was not authored recovery; recovery not sent; owner must forward the brief", "delivery-miss");
        }
      } else if (codex && row?.harness_session_id === request.oldSession && fx.uiTransition?.()) {
        witness = "codex-ui-transition";
        phase = "recovery-pending-proof";
        fx.record({ state: phase, detail: "fresh Codex UI observed; authored recovery will bootstrap native registration, not yet reset proof", witness, recoveryId });
      } else { await fx.wait(); continue; }
      {
        const evidence = fresh ? `Native session change observed: ${request.oldSession} -> ${fresh.session}.` : "Fresh Codex UI transition observed; new native session proof is pending until this input starts the turn.";
        const body = `TAP authored recovery for ${request.team}/${request.handle}. ${evidence} ${request.handoff ? `Read ${request.handoff} first (charter, then current handoff).` : "Recover your standing brief from the bus."} Run tap whoami and tap poll ${request.handle}; reconcile current obligations, then continue the standing mission. ${request.notify ? `Report the absolute brief path you read and next action to ${request.notify}.` : ""} Delivery acceptance does not establish that you read the brief.`;
        const outcome = fx.send(request.handle, body, recoveryId, fresh?.session ?? request.oldSession);
        if (outcome.rc !== 0) return fail(`recovery send ${outcome.disposition}; do not reset again`);
        if (codex) { sent = outcome; continue; }
        fx.record({ state: "recovery-accepted", detail: "durable recovery accepted; recipient read remains unverified", witness, recoveryId, newSession: fresh!.session, newTranscript: fresh!.transcript, delivery: outcome.disposition });
        return;
      }
    }
    fail(sent ? "post-input native identity/recovery-first proof not observed before timeout; brief retained" : "fresh native session/transcript not observed before timeout; brief retained");
  } catch (error) { fail(String(error)); }
}
export function sendRecovery(request: Request, to: string, body: string, id?: string, nativeSession?: string): SendOutcome {
  return cmdSendOutcome([to, "--from", request.handle, "--note", "--wake", "-m", body, ...(id ? ["--id", id] : [])], scripts, AGENT_FAMILIES,
    { explicitTeam: request.team, expectedSenderInstance: request.bound.instance, quiet: true,
      reauthorize: registry => {
        const current = seatMap(registry)[request.handle];
        if (!sameSeat(request, current)) throw new Error("rebrief sender identity changed");
        if (nativeSession !== undefined && current?.harness_session_id !== nativeSession) throw new Error("rebrief native session changed before recovery placement");
      } });
}
export function recoveryIdle(request: Request, fx = { observePane, capturePane, tmuxReadOnly }): boolean {
  const pane = fx.observePane(request.bound.paneId);
  if (!pane || pane.serverEpoch !== request.bound.serverEpoch) return false;
  // Codex's empty composer is corroborated by dim paint; plain text could be a draft.
  const screen = fx.capturePane(request.bound.paneId, true);
  const title = fx.tmuxReadOnly(["display-message", "-p", "-t", request.bound.paneId, "#{pane_title}"]);
  return screen.code === 0 && title.code === 0 && detectAgentState(request.bound.harness, screen.stdout, title.stdout.trim()).agentState === "idle";
}
async function worker(path: string): Promise<void> {
  const request: Request = JSON.parse(readRegular(path, 65536));
  const receiptPath = path.slice(0, -5) + ".receipt.json";
  const beforePath = path.slice(0, -5) + ".before.ansi", afterPath = path.slice(0, -5) + ".after.ansi";
  const record = (receipt: Receipt) => {
    let previous = {};
    try { previous = JSON.parse(readFileSync(receiptPath, "utf8")); } catch { /* first receipt */ }
    atomicWrite(receiptPath, JSON.stringify({ ...previous, ...receipt, id: request.id, at: new Date().toISOString(), handoff: request.handoff, oldSession: request.oldSession, oldTranscript: request.oldTranscript,
      ...(receipt.witness === "codex-ui-transition" ? { beforeFrame: beforePath, afterFrame: afterPath } : {}) }) + "\n");
  };
  const lock = acquirePathLock(join(request.bus, "handoff", request.handle + ".rebrief.lock"), 0);
  if (!lock) {
    record({ state: "incomplete", detail: "another recovery observer already owns this seat; nothing submitted" });
    if (request.notify) {
      const result = sendRecovery(request, request.notify, `Rebrief for ${request.handle} not started: another observer owns the seat. Preserved brief: ${request.handoff ?? "none"}. Receipt: ${receiptPath}.`);
      if (result.rc) console.error(`self: owner notification unconfirmed (${result.disposition})`);
    }
    return;
  }
  try {
    // A repeated worker invocation never repeats a possibly submitted reset.
    writeFileSync(`${path}.started`, new Date().toISOString(), { flag: "wx", mode: 0o600 });
    const authority: SubmitAuthority = { registryPath: request.registry, recipient: request.handle, busHome: request.bus, agentFamilies: AGENT_FAMILIES, scriptsDir: scripts, expectedNativeSession: request.oldSession,
      singleEnter: request.bound.harness.startsWith("codex") };
    let before = "";
    await runRecovery(request, {
      row: () => seatMap(loadCurrentRegistry(request.registry))[request.handle], fresh: current => freshIdentity(request, current),
      idle: () => recoveryIdle(request),
      submit: () => {
        const captured = capturePane(request.bound.paneId, true);
        before = captured.code === 0 ? captured.stdout : "";
        if (before && request.bound.harness.startsWith("codex")) atomicWrite(beforePath, before);
        return submitVerify(request.bound.paneId, request.id, request.command, request.bound, authority);
      },
      uiTransition: () => {
        if (!recoveryIdle(request)) return false;
        const captured = capturePane(request.bound.paneId, true);
        if (captured.code !== 0 || !codexUiTransition(before, captured.stdout, request.oldSession)) return false;
        atomicWrite(afterPath, captured.stdout);
        return true;
      },
      firstInput: firstCodexInput,
      send: (to, body, id, session) => sendRecovery(request, to, body, id, session),
      record, now: Date.now, wait: () => Bun.sleep(1000),
    });
  } finally { lock.release(); }
}
export function armSelfRecovery(options: Options, context?: ResolvedContext, scriptsDir = scripts): number {
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
  const oldSession = String(seat.harness_session_id ?? ""), oldTranscript = String(seat.transcript_path ?? "");
  if (!transcriptIdentity(oldTranscript, harness, oldSession)) throw new Error("current native session/transcript identity is unverified; nothing armed");
  if (options.notify) {
    const peer = seats[options.notify];
    if (!peer || options.notify === self.handle || (peer.status ?? "active") !== "active") throw new Error("--notify must name a different active teammate");
  }
  if (!seat.instance || !seat.server_epoch) throw new Error("seat identity is incomplete");
  const id = `${self.handle}-${new Date().toISOString().replace(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`;
  const handoff = copyBrief(ctx.bus.home, id, options.handoff, options.charter);
  const request: Request = { id, registry: ctx.registryPath, bus: ctx.bus.home, team: ctx.team, handle: self.handle,
    bound: { paneId: self.paneId, instance: String(seat.instance), serverEpoch: String(seat.server_epoch), bootId: String(seat.boot_id ?? ""), harness, handle: self.handle },
    oldSession, oldTranscript, command: clearCommand(harness), handoff, notify: options.notify, recoveryId: mintId(self.handle) };
  const dir = join(ctx.bus.home, "handoff");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${id}.json`);
  writeFileSync(path, JSON.stringify(request) + "\n", { flag: "wx", mode: 0o600 });
  atomicWrite(join(dir, `${id}.receipt.json`), JSON.stringify({ state: "armed", witness: "none", recoveryId: request.recoveryId, id, handoff, oldSession, oldTranscript }) + "\n");
  const log = openSync(join(dir, `${id}.log`), "a", 0o600);
  try {
    const child = Bun.spawn([bun, workerPath, "--run", path], { detached: true, stdin: "ignore", stdout: log, stderr: log, env: { ...process.env } });
    child.unref();
  } catch (error) {
    atomicWrite(join(dir, `${id}.receipt.json`), JSON.stringify({ state: "incomplete", id, handoff, detail: `observer spawn failed; nothing submitted: ${error}` }) + "\n");
    throw error;
  } finally { closeSync(log); }
  console.error(`self: recovery ARMED, reset UNVERIFIED; end this turn now. Brief: ${handoff ?? "standing bus brief"}. Receipt: ${join(dir, `${id}.receipt.json`)}`);
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
