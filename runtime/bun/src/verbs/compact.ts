import { compactionWitnessPath } from "../compaction-proof";
// One compact orchestrator. Focus policy, the resume ping and the peer submit
// are native, including identity, observations, diagnostics and reset bookkeeping.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { constants as osConstants } from "node:os";
import { TapError, resolveContext, resolveSelf, observeCallingPane, type ResolvedContext } from "../context";
import { resolveSelection } from "../team-selection";
import { stampEnvelope, validateEnvelope } from "../envelope";
import { atomicWrite, ensureAscii } from "../fsatomic";
import { mintId, utcStamp, validToken } from "../ids";
import { seatMap, type Seat } from "../registry";
import { lockRoot } from "../panelock";
import { pyReadUtf8, pyStrCompare } from "../spool-publication";
import { hasControlCharacter } from "../pane/reader";
import { focusMode, focusNarrowing, handoffPing } from "../compact-focus";
import { teamRegistryFileRefusal } from "../register-authority";
import { peerSubmitArgv, verbArgv } from "../courier-argv";

import { assertResetUnfenced, markResetGenerationReused } from "../reset";
import { compactNoActor, compactObservedRow, compactHarness, attention } from "../compact-support";
import { classifyHarness, DEFAULT_AGENT_FAMILIES } from "../observe";

const err = (message: string) => process.stderr.write(`${message}\n`);
const usage = (surface: string, detail: string): never => {
  throw new TapError(1, "usage_error", `tap help ${surface}`, detail, `tap ${surface}`);
};
class Cancelled extends Error { constructor(readonly code: number) { super("compact cancelled"); } }
type Result = { code: number; out: string };
type Audit = { id: string; payload: string; receipt: string; dest: string; done: string };

/** One peer control to submit: the target's resolved pane and its row identity. */
export interface PeerSubmit { pane: string; id: string; text: string; target: string; paneId: string; session: string;
  rowHarness: string; family: string; serverEpoch: string; bootId: string; instance: string; registry: string; busHome: string; scriptsDir: string;
  nativeSession: string; transcript: string; proofReceipt: string; handoff: string;
  initiator: string; initiatorInstance: string; team: string }
/** Submits `request.text` and answers 0 only after durable compaction proof. `run` is the cancellable child runner. */
export type PeerSubmitter = (request: PeerSubmit, run: (command: string[], input?: string) => Promise<Result>) => Promise<number>;

/** Production peer submit: the courier in its own process (compact-peer-submit.ts), so cancellation can stop it. */
export const nativePeerSubmit: PeerSubmitter = async (request, run) =>
  (await run(peerSubmitArgv(request.scriptsDir), JSON.stringify(request))).code;

/** `selfCompact` runs `tap self compact` for a self-target and `peerSubmit` a peer's control; tests substitute both. */
export async function cmdCompact(argv: string[], scripts: string, alias = false, selfCompact?: (focus: string) => Promise<number>,
  peerSubmit: PeerSubmitter = nativePeerSubmit): Promise<number> {
  const surface = alias ? "command" : "compact";
  const label = alias && !process.env.TAP_CONTEXT_ENTRY ? "tap command" : "tap compact";
  const args = [...argv];

  // Cancellation covers the whole fan-out, including gaps between children.
  // Each child owns a group so a shell exiting first cannot orphan its submit.
  let cancelled = 0;
  let notifyCancel!: () => void;
  const cancellation = new Promise<void>(resolve => { notifyCancel = resolve; });
  const signals = {
    SIGINT: () => { cancelled ||= 130; notifyCancel(); },
    SIGTERM: () => { cancelled ||= 143; notifyCancel(); },
    SIGHUP: () => { cancelled ||= 129; notifyCancel(); },
  };
  for (const signal of Object.keys(signals) as (keyof typeof signals)[]) process.on(signal, signals[signal]);
  let childEnv: NodeJS.ProcessEnv = { ...process.env, TAP_VERB: "tap command", TAP_LOCK_DIR: lockRoot() };
  const checkCancelled = () => { if (cancelled) throw new Cancelled(cancelled); };
  async function run(command: string[], input?: string, quiet = false): Promise<Result> {
    checkCancelled();
    const child = Bun.spawn(command, { env: childEnv, detached: true, stdin: input === undefined ? "ignore" : Buffer.from(input), stdout: "pipe", stderr: quiet ? "ignore" : "inherit" });
    const output = new Response(child.stdout).text();
    const finished = Promise.all([child.exited, output]);
    await Promise.race([finished, cancellation]);
    if (cancelled) {
      const signal = (name: NodeJS.Signals) => {
        try { process.kill(-child.pid, name); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      };
      signal("SIGTERM");
      const deadline = performance.now() + 1000;
      while (performance.now() < deadline) {
        try { process.kill(-child.pid, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") break; throw error; }
        await Bun.sleep(20);
      }
      signal("SIGKILL");
      await finished;
      throw new Cancelled(cancelled);
    }
    const [code, out] = await finished;
    return { code: child.signalCode ? 128 + osConstants.signals[child.signalCode] : code, out };
  }
  const discard = (audit: Audit) => { rmSync(audit.payload, { force: true }); rmSync(audit.receipt, { force: true }); };
  try {
    if (alias) {
      const verb = args.shift();
      if (verb === "clear") throw new TapError(1, "usage_error", "tap help clear", "'tap command clear' is retired: it was the injection clear, and process replacement supersedes it. Use 'tap clear <seat> [-m <instruction>]' — same target, a fresh process rather than a cleared context, and it fixes harness-process rot that injection cannot", "tap command");
      if (verb !== "compact") usage(surface, "usage: tap command compact <seat>...|--all [--focus <one-line text>]  (tap command clear is retired; use tap clear)");
      if (!process.env.TAP_CONTEXT_ENTRY) err("tap command: note — 'tap command compact' is deprecated; use 'tap compact <seat>... [-m <focus>]' (same behavior, and -m is the same flag tap send uses)");
    }
    let all = false, focus = "", focusSet = false;
    const targets: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === "--all") {
        if (all) usage(surface, "--all may be passed once");
        all = true;
      } else if (arg === "--focus" || (!alias && arg === "-m")) {
        if (i + 1 === args.length) usage(surface, alias ? "--focus needs text" : "-m needs one line of focus text");
        if (!alias && focusSet) usage(surface, "-m may be passed once");
        focus = args[++i]!; focusSet = true;
      } else if (!alias && (arg === "-f" || arg === "--body-file")) {
        usage(surface, '-f is not a focus flag here: unlike tap send, compact takes its focus as literal text, so -f would have injected the FILENAME. Use -m \'<focus>\' (or -m "$(cat <file>)" for a file you wrote)');
      } else if (!alias && arg === "--") continue;
      else if (arg.startsWith("--")) throw new TapError(1, "unknown_option", `tap help ${surface}`, `unknown option '${arg}'`, `tap ${surface}`);
      else {
        if (!validToken(arg)) usage(surface, `invalid seat '${arg}'`);
        targets.push(arg);
      }
    }
    if (all && targets.length) usage(surface, "choose explicit seats or --all, not both");
    if (!all && !targets.length) usage(surface, alias
      ? "usage: tap command compact <seat>...|--all [--focus <one-line text>]  (tap command clear is retired; use tap clear)"
      : "usage: tap compact <seat>...|--all [-m <one-line focus>]");
    const flag = alias ? "--focus" : "-m";
    if (/[\r\n]/.test(focus)) usage(surface, `${flag} must be one line`);
    // UTF-8 POSIX space, as in the retained Bash surface (not JS's NBSP/BOM).
    if (/^[\t-\r \u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]*\//.test(focus)) usage(surface, `${flag} is context text, not a slash command`);
    if (hasControlCharacter(focus)) usage(surface, `${flag} must not contain control characters`);
    if (focus) {
      const narrowed = focusNarrowing(focus);
      if (narrowed) throw new TapError(1, "usage_error", "tap help compact", `tap compact: focus contains exclusive/destructive phrasing: '${narrowed}'. A focus SUPPLEMENTS the summarizer — enumerate what to PRESERVE instead`, "tap command");
    }
    const caller = observeCallingPane();
    const observation = caller.state === "inside" ? { status: "ok" as const, ...caller } : null;
    const pin = process.env.TAP_HOME ?? "";
    let ctx: ResolvedContext;
    try {
      // One authority result owns both registry and audit bus. Explicit pins
      // use the shared exact-bus rule; a bare cwd never follows the caller pane.
      ctx = pin ? resolveSelection(pin, "", process.cwd(), process.env)
        : resolveContext(process.cwd(), process.env, { paneFallback: false });
    } catch (error) {
      if (!(error instanceof TapError) || error.errorClass !== "unanchored_bus") throw error;
      if (pin) throw new TapError(1, "bus_not_acting", "unset TAP_HOME, or point it at this team's acting bus",
        `TAP_HOME='${pin}' does not resolve to an acting bus`, "tap command");
      compactNoActor(caller);
    }
    // Obligation verbs also support standalone probe buses. Compact requires
    // an enrolled acting bus; its explicit pin cannot take that fallback.
    if (pin && ctx.selection?.authority !== "enrolled") throw new TapError(1, "bus_not_acting",
      "unset TAP_HOME, or point it at this team's acting bus", `TAP_HOME='${pin}' does not name an enrolled acting bus`, "tap command");
    const { bus, registryPath: registry } = ctx;
    assertResetUnfenced(bus.home, "tap command");
    let initiator = "";
    const initiatorPane = observation?.status === "ok" ? observation.paneId : "";
    if (initiatorPane && observation) {
      try { initiator = resolveSelf(ctx, observation, 1).handle; }
      catch { /* The no-actor remedy stays within this selected registry. */ }
    }
    if (!initiator || !initiatorPane) compactNoActor(caller, registry);
    bus.ensureDirs();
    if (!existsSync(registry)) throw new TapError(1, "registry_unreachable", "tap doctor", "acting registry unreachable for tap command", "tap command");
    const oldStore = teamRegistryFileRefusal(registry);
    if (oldStore) throw new TapError(1, "old_store", oldStore.action, oldStore.detail, "tap command");
    childEnv = { ...childEnv, TAP_HOME: bus.home };
    const rows = () => seatMap(JSON.parse(pyReadUtf8(registry)));
    if (all) {
      for (const [handle, row] of Object.entries(rows()).sort(([a], [b]) => pyStrCompare(a, b))) {
        if (row && typeof row === "object" && !Array.isArray(row) && (row.status === undefined ? "active" : row.status) === "active" && row.delivery !== "poll" && row.pane && typeof row.pane_id === "string" && row.pane_id && row.pane_id !== initiatorPane && handle !== initiator) targets.push(handle);
      }
      if (!targets.length) throw new TapError(1, "not_found", "tap register", "--all found no active peer pane seats", "tap command");
    }
    function prepare(target: string): Audit {
      const id = mintId(initiator);
      mkdirSync(bus.stagingDir, { recursive: true });
      const audit = { id, payload: join(bus.stagingDir, `.tap-command-success.${id}`), receipt: join(bus.receiptsDir, `.tap-command-success.${id}`), dest: bus.payloadPath(id), done: bus.donePath(id) };
      let payloadOwned = false, receiptOwned = false;
      try {
        if ([audit.dest, audit.done, join(bus.home, "spool", `${id}.md`), join(bus.home, "spool", `${id}.meta.json`)].some(existsSync)) throw new Error(`could not reserve unique durable audit '${id}'`);
        const source = `---\ncommand_target: ${target}\ncommand_verb: compact\ncommand_status: success\n---\n\ntap command compact ${target}: success\n`;
        const payload = stampEnvelope(source, { id, from: initiator, to: initiator, kind: "command", path: audit.dest, reply: "settle-only" });
        const valid = validateEnvelope(payload);
        if (!valid.ok) throw new Error(valid.reason);
        writeFileSync(audit.payload, payload, { flag: "wx", mode: 0o600 });
        payloadOwned = true;
        writeFileSync(audit.receipt, `${ensureAscii(JSON.stringify({ id, status: "done", at: utcStamp(), by: initiator, via: "done", auto: true, command_status: "success" }))}\n`, { flag: "wx", mode: 0o600 });
        receiptOwned = true;
        return audit;
      } catch (error) {
        if (payloadOwned) rmSync(audit.payload, { force: true });
        if (receiptOwned) rmSync(audit.receipt, { force: true });
        throw error;
      }
    }
    async function commit(audit: Audit): Promise<boolean> {
      checkCancelled();
      try {
        if (!existsSync(audit.payload) || !existsSync(audit.receipt)) throw new Error("prepared audit is incomplete; refusing to claim success");
        if (existsSync(audit.dest) || existsSync(audit.done)) throw new Error(`prepared audit '${audit.id}' collided before commit`);
        renameSync(audit.payload, audit.dest);
        try { atomicWrite(bus.placedPath(audit.id), `${JSON.stringify({ id: audit.id, via: "command", at: utcStamp() })}\n`); }
        catch { err(`tap command: warning: placed receipt not written for ${audit.id}`); }
        renameSync(audit.receipt, audit.done);
        markResetGenerationReused(bus.home, "command");
        return true;
      } catch (error) {
        if (error instanceof Cancelled) throw error;
        err(`tap command: ${error instanceof Error ? error.message : error}`);
        return false;
      }
    }
    const harness = (pane: string) => compactHarness(pane);
    async function self(target: string): Promise<number> {
      if ((await harness(initiatorPane)).startsWith("codex")) {
        err("tap compact: Codex seats compact themselves: write a handoff, then run tap self compact --handoff <file> -- '<focus>'"); return 1;
      }
      if (!focus) { err(`tap compact: refusing to compact '${target}' (yourself) with no -m: the focus is the only thing you can add that the default summarizer cannot, and you are the only caller who knows it. Pass -m '<live threads, paths, unresolved decisions>'.`); return 1; }
      checkCancelled();
      // A child in its own group, like every other effect here, so cancellation
      // stops the self submit too rather than waiting out a synchronous call.
      const code = selfCompact ? await selfCompact(focus)
        : (await run(verbArgv(scripts, ["self", "compact", "--", focus]))).code;
      if (!code) { process.stdout.write(`${label}: compact ${target}: armed (self; completion unverified)\n`); return 0; }
      if (code === 6) return 6;
      err(`tap compact: self-compaction of '${target}' failed (tap self rc=${code})`); return 1;
    }
    async function one(target: string): Promise<number> {
      if (target === initiator) return self(target);
      let row: Seat | undefined;
      try { row = rows()[target]; } catch { /* incumbent reports unknown seat */ }
      if (!row || typeof row !== "object" || Array.isArray(row)) { err(`tap command: unknown seat '${target}'`); return 1; }
      if (["status", "pane", "pane_id", "harness", "delivery", "cost_mode", "include_policy", "reply_to", "session", "server_epoch", "boot_id", "registered_at"].some(key => row![key] !== undefined && typeof row![key] !== "string") || (row.status_reason && typeof row.status_reason !== "string")) { err(`tap command: unknown seat '${target}'`); return 1; }
      const field = (key: string, fallback = "") => row![key] === undefined ? fallback : typeof row![key] === "string" ? row![key] as string : "";
      let pane = field("pane"), paneId = field("pane_id"), session = field("session");
      if (paneId && paneId === initiatorPane) return self(target);
      const status = field("status", "active"), delivery = field("delivery", "pane"), rowHarness = field("harness");
      if (status !== "active" || delivery === "poll" || !pane) { err(`tap command: '${target}' is not an active pane seat`); return 1; }
      if (!paneId) { err(`tap command: '${target}' has no stable pane identity; refusing`); return 1; }
      const [state, reason, resolvedPane, resolvedId] = compactObservedRow(row);
      if (state !== "active" || !resolvedPane || !resolvedId) { err(`tap command: '${target}' pane identity is not usable (${state || "unknown"}${reason ? `: ${reason}` : ""}); refusing`); return 1; }
      pane = resolvedPane; paneId = resolvedId;
      if (!session && pane.includes(":")) session = pane.split(":", 1)[0]!;
      if (paneId === initiatorPane) return self(target);
      const family = await harness(pane);
      if (classifyHarness(family, DEFAULT_AGENT_FAMILIES) !== "agent") { err(`tap command: '${target}' uses unsupported harness '${family}'`); return 1; }
      if (family === "codex") { err(`tap compact: '${target}' is a Codex seat; ask it to checkpoint and self-trigger (tap self compact --handoff FILE -- FOCUS)`); return 1; }
      const mode = focusMode(family);
      if (mode === "unsupported") {
        attention("command", "degraded", family === "hermes"
          ? `compact unavailable for '${target}' (${family}); use a manual keep-list, then 'tap clear ${target}' and re-brief it over the bus — hermes takes no -m, so a keep-list passed there is discarded — or leave the context alone`
          : `compact unavailable for '${target}' (${family}); use a manual keep-list, then 'tap clear ${target} -m <keep-list>' or leave the context alone`);
        return 6;
      }
      let audit: Audit;
      try { audit = prepare(target); }
      catch (error) { err(`tap command: compact audit preparation failed for '${target}'; refusing before pane input (${error})`); return 1; }
      {
        const id = mintId(initiator), dir = join(bus.home, "handoff");
        const handoff = join(dir, `${id}.peer-compact.resume.txt`), proofReceipt = join(dir, `${id}.peer-compact.receipt.json`);
        const request: PeerSubmit = { pane, id, text: `/compact${focus && mode === "inline" ? ` ${focus}` : ""} [[sv:${id}]]`,
          target, paneId, session, rowHarness, family, serverEpoch: field("server_epoch"), bootId: field("boot_id"),
          instance: String(row.instance ?? ""), registry, busHome: bus.home, scriptsDir: scripts,
          nativeSession: field("harness_session_id"), transcript: compactionWitnessPath(family, row), proofReceipt, handoff, initiator, initiatorInstance: String(rows()[initiator]?.instance ?? ""), team: ctx.team };
        // Preserve the existing peer wire suffix (tap-usgng). Both follow-up
        // branches now ride one durable body and the same proof barrier.
        let pingRc = 0;
        try {
          mkdirSync(dir, { recursive: true });
          const body = focus
            ? `Post-compaction focus for ${target}, written before the compaction by ${initiator}.\n\nYour context was just compacted by \`tap compact\`. Your summary is lossy;\nthese bytes are not. This payload is settle-only — settling it is how ${initiator}\nlearns the focus reached you, so settle it even if you were already working.\n\nFOCUS: ${focus}\n\nThen check your task list for work already claimed. If work is in progress\nor owed, continue it without waiting to be asked.\n`
            : handoffPing("", target, pane);
          writeFileSync(handoff, body, { flag: "wx", mode: 0o600 });
          atomicWrite(proofReceipt, JSON.stringify({ id, target, state: "armed", handoff, detail: "peer compaction child pending" }) + "\n");
          checkCancelled();
          const code = await peerSubmit(request, (command, input) => run(command, input));
          checkCancelled();
          const receipt = JSON.parse(readFileSync(proofReceipt, "utf8"));
          if (![0, 6].includes(code) || receipt.id !== id || receipt.state !== (code === 0 ? "resume-sent" : "resume-miss") ||
              !["transcript-proven", "store-proven"].includes(receipt.evidence) || !Number.isFinite(Date.parse(receipt.compactedAt))) {
            throw new Error(`compaction unverified or follow-up unverified (rc=${code})`);
          }
          pingRc = code;
        } catch (error) {
          discard(audit);
          if (error instanceof Cancelled) throw error;
          err(`tap compact: '${target}': ${error instanceof Error ? error.message : error}; handoff: ${handoff}; receipt: ${proofReceipt}; do not retry /compact`);
          return 1;
        }
        if (pingRc) {
          await commit(audit);
          if (focus) {
            err(`tap command: the focus that did NOT reach '${target}' was:\n  ${focus}`);
            err(`tap command: re-send it by hand — put that text in a file and run: tap send ${target} -f <file> --fyi --wake`);
          }
          attention("command", "degraded", `compact reached '${target}' but its wake did NOT land (rc=${pingRc}); that seat may stop after compacting${focus ? ", and its focus never arrived" : ""} — send it any message to restart it — use 'tap send --wake'`);
          return 6;
        }
        if (!await commit(audit)) { err(`tap command: 'compact' reached '${target}', but its terminal success audit failed`); return 1; }
        process.stdout.write(`${label}: compact ${target}: ok\n`);
        return 0;
      }
    }
    let hard = false, degraded = false;
    for (const target of targets) {
      checkCancelled();
      const code = await one(target);
      if (code === 6) degraded = true;
      else if (code) hard = true;
    }
    return hard ? 1 : degraded ? 6 : 0;
  } catch (error) {
    if (error instanceof Cancelled) return error.code;
    throw error;
  } finally {
    for (const signal of Object.keys(signals) as (keyof typeof signals)[]) process.off(signal, signals[signal]);
  }
}
