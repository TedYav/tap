// Native `tap nudge` (tap-voys3): re-submit a STUCK sentinel in a peer's pane. The `--harness` fan-out form
// (nudge-fanout.ts, tap-s1k5j) wakes seats by DELIVERY — ordinary courier notes — never by keystrokes here.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { boundPaneIdentityState } from "../observe-gather";
import { callingPane, resolveSelf, TapError, type Context } from "../context";
import { classifyHarness, harnessFamily, observeProcessHarness, readProcessTable } from "../observe";
import { captureInputFrame, pendingInputText, realPaneIo } from "../pane/reader";
import { digestIndexPath, pyReadText, stampInjected } from "../digest-index";
import { numberDigestItems } from "../digest-items";
import { deliveryClockStamp } from "../delivery-clock";
import { envelopeField } from "../envelope";
import { harnessQueueMessage, recordHarnessQueued } from "../harness-queue";
import { validId } from "../ids";
import { isRegularFile, resolveEnrolledTeamRoot } from "../index-home";
import { recoveryPolicy } from "../recovery-policy";
import { recordedCopyCancel } from "../recovery/copy-mode";
import { observeCopyMode } from "../pane-state";
import { copyModeCancelLicense, requeueCopyModeParks, type RequeueInput, type RequeueResult } from "../spool-requeue";
import { cancelUnattendedCopyMode, type CopyParkCancel } from "../recovery/copy-park-cancel";
import { recoveryCli } from "../recovery/cli";
import { recoveryCliArgv } from "../courier-argv";
import { escalateRecovery, recoveryEffect, REAL_RECOVERY_IO } from "../recovery/effect";
import { readRun } from "../recovery/state";
import { authorizePaneEffect, REAL_EFFECTS, submitStagedLocked, type BoundRecipient, type PaneEffects, type SubmitAuthority, type SubmitResult } from "../courier";
import { recordPhase, type SubmitPhase } from "../submit-phase";
import { loadRegistry, seatMap } from "../registry";
import { parseTarget, selectTarget, SelectorError, type TargetSelection } from "../selector";
import { sentinelInputTail, visibleSentinel } from "../submit-frame";
import { stuckSentinelFieldsFromRegion } from "../stuck-sentinel";
import { closedSentinelInput, sentinelShapedInput } from "../sentinel-tail";
import { paneCurrentCommand, ServerUnresponsive, tmuxReadOnly } from "../tmux";
import { opencodeShellMode } from "../opencode-composer";
import { retireOverprintAfterReadableHeal, type OverprintHealVerdict } from "../overprint-marker";
import { busForRoot } from "./admin";
import { resolveSelection } from "../team-selection";
import { TOKEN_RE } from "../remote-target";
import { cmdNudgeFanout, isFanoutArgv } from "./nudge-fanout";
import { PreKeyRefusal, previewLadder, runLadder, type ComposerRead, type LadderIO } from "./nudge-ladder";
import { nudgeMessageRefusal, parseNudgeWire, renderNudgeWire } from "../nudge-wire";
import { createRun, updateRun } from "../recovery/state";
import { targetRow } from "../recovery/cli";
import { observePaneKind } from "../pane-state";
import { childBusEnv } from "../panelock";

const USAGE = "tap help nudge";
const USAGE_LINE = "usage: tap nudge <peer|team/peer> [--message \"<one line>\"] [--no-interrupt] [--dry-run] | --pane <tmux-target>";

/** `<to>` is the positional or `--to`, never both: one target, one spelling. */
function setTarget(current: string, value: string, via: "--to" | "positional"): string {
  if (current === "") return value;
  if (via === "--to") throw new TapError(1, "usage_error", USAGE, `the target is already '${current}'; pass it positionally or with --to, not both`);
  throw new TapError(1, "usage_error", USAGE, `unexpected arg '${value}' (the target is already '${current}')`);
}

interface Binding { status: string; pane: string; paneId: string; delivery: string; }

// A present legacy row defaults status/delivery like `tap_registry_pane_binding`; a missing row stays all-empty.
function binding(registryLocation: string, handle: string): Binding {
  const row = seatMap(loadRegistry(registryLocation))[handle] as { status?: unknown; pane?: unknown; pane_id?: unknown; delivery?: unknown } | undefined;
  if (!row) return { status: "", pane: "", paneId: "", delivery: "" };
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  return { status: text(row.status) || "active", pane: text(row.pane), paneId: text(row.pane_id), delivery: text(row.delivery) || "pane" };
}

/**
 * tap-8nmot: a digest sentinel names no payload file — its canonical record is
 * the courier's digest index, `spool/digests/<id>.json`, whose `to`/`to_team`
 * name the recipient the same way a payload envelope does. Unreadable, reaped
 * or unnamed records return null and the caller keeps its not_found refusal.
 */
function digestRecordIdentity(bus: string, id: string): { to: string; toTeam: string; from: string; members: string[]; indexPath: string } | null {
  const path = digestIndexPath(join(bus, "spool"), id);
  if (!isRegularFile(path)) return null;
  let parsed: unknown;
  // Strict UTF-8, as the digest index itself decodes: a record the index cannot
  // parse is reapable, so a lenient read here could hand over a doomed pointer.
  try { parsed = JSON.parse(pyReadText(path)); } catch { return null; }
  // The record authorizes an Enter, so it must be exactly the digest this id
  // names: an object, kind digest, its own digest_id, a
  // non-empty string `to`, a string `to_team` and members the reader accepts.
  // Anything else is malformed
  // and keeps the caller's not_found refusal.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const doc = parsed as Record<string, unknown>;
  if (doc.kind !== "digest" || doc.digest_id !== id) return null;
  if (typeof doc.to !== "string" || doc.to === "" || typeof doc.to_team !== "string") return null;
  // The recipient's reader refuses a record without well-formed members, so an
  // Enter here would hand over a pointer `tap read` cannot resolve. Validate with
  // the reader's own member check (shape, unique ids, unique positive ordinals).
  // The validated members ride along: a queued submit records exactly this selected snapshot.
  // Each id becomes a receipt path, so it must be a charset-valid token (never `../x`), and the
  // queued digest's receipt needs the doorbell's sender route, so `from` must be a non-empty string.
  let members: string[];
  try { members = numberDigestItems(doc.items).map(item => item.id); } catch { return null; }
  if (!members.every(validId)) return null;
  if (typeof doc.from !== "string" || doc.from === "") return null;
  return { to: doc.to, toTeam: doc.to_team, from: doc.from, members, indexPath: path };
}

// Port of the deleted lib.sh `tap_refuse_if_terminal`/`tap_refuse_if_cancelled` gates: residency is not
// liveness, absence is its own class (never identity_mismatch), and receipt paths use the regular-file
// predicate so a directory/FIFO is not a receipt and a FIFO is never opened (which would hang).
function terminalityRefusal(bus: string, id: string, digest = false): TapError | null {
  // A digest never gets its own .done: the recipient's digestView records
  // observation as `.read`, so an observed digest is already consumed.
  const settled = isRegularFile(`${bus}/receipts/${id}.done`) ? ".done" : digest && isRegularFile(`${bus}/receipts/${id}.read`) ? ".read" : null;
  if (settled) {
    return new TapError(1, "already_settled", `tap show ${id}`, `'${id}' is already settled (${settled} exists on ${bus}); it must not be re-submitted`);
  }
  const cancelPath = `${bus}/receipts/${id}.cancelled`;
  if (!isRegularFile(cancelPath)) return null;
  let doc: Record<string, unknown> = {}; try { doc = JSON.parse(readFileSync(cancelPath, "utf8")) as Record<string, unknown>; } catch {}
  const via = typeof doc.via === "string" && doc.via !== "" ? doc.via : "cancelled";
  if (via !== "withdrawn") {
    return new TapError(1, "already_settled", `tap show ${id}`, `'${id}' is already terminal (via: ${via}); it cannot be answered or settled again`);
  }
  const reason = typeof doc.reason === "string" ? doc.reason : ""; const successor = typeof doc.superseded_by === "string" ? doc.superseded_by : "";
  return new TapError(1, "withdrawn", successor ? `tap read ${successor}` : `tap show ${id}`,
    `'${id}' was withdrawn by its sender — superseded: ${reason || "no reason given"}` +
    (successor ? `; answer '${successor}' instead` : "; the sender named no successor") + `. Nothing is owed on '${id}'.`);
}

/**
 * Re-submit the visible sentinel through the courier's staged-submit loop, with
 * every Enter recorded by the recovery engine. The loop never retypes the wire.
 * Nudge takes no pane-submit lock of its own: `recoveryEffect` takes it for each
 * key and reauthorizes immediately before it, and a second acquisition in this
 * process would block on itself. Between keys nothing holds the pane: ordinary
 * nudge runs have no thinking-time hold (recovery/state.ts).
 *
 * Fences are read on both buses: the payload's (`bus`, also where evidence is
 * filed) and the recipient team's own, which for cross-team mail is not the
 * payload's.
 */
function submitRecorded(input: { runId: string; pane: string; paneId: string; paneCmd: string; id: string; expected: string;
  registry: string; handle: string; bus: string; recipientBus: string; scriptsDir: string; families: ReadonlySet<string>; repainted: boolean }): number {
  const row = seatMap(loadRegistry(input.registry))[input.handle] as Record<string, unknown> | undefined;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const bound: BoundRecipient = { paneId: input.paneId, serverEpoch: text(row?.server_epoch), harness: input.paneCmd,
    handle: input.handle, instance: text(row?.instance) };
  const authority: SubmitAuthority = { registryPath: input.registry, recipient: input.handle, busHome: input.bus,
    ...(input.recipientBus ? { recipientBusHome: input.recipientBus } : {}),
    // Rung 2 presses exactly one Enter for every family (tap-xe42x); an unverified one is exit 5.
    scriptsDir: input.scriptsDir, agentFamilies: input.families, singleEnter: true };
  const effectEnv: NodeJS.ProcessEnv = { ...childBusEnv(input.bus), TAP_RECOVERY_RUN: input.runId, TAP_VERB: "tap nudge" };
  if (input.repainted) effectEnv.TAP_NUDGE_REPAINTED = "1"; else delete effectEnv.TAP_NUDGE_REPAINTED;
  let refused = false, enterCount = 0, ordinal = 0;
  const fx: PaneEffects = { ...REAL_EFFECTS, pressEnter: () => {
    const run = readRun(input.runId, effectEnv);
    const result = recoveryEffect(input.runId, "nudge Enter", `${run.mode}: complete visible sentinel and canonical recipient authorized by nudge`,
      ["send-keys", "-t", run.target.paneId, "Enter"], REAL_RECOVERY_IO, effectEnv);
    if (result.event.incident) escalateRecovery(input.runId, result.event.summary, effectEnv);
    if (result.code !== 0) process.stderr.write(`tap recovery: ${result.event.summary}; tap debug recovery ${input.runId}\n`);
    // A positively recorded pre-key refusal sent nothing: stop, never press again.
    // The loop counted this Enter before asking; the phase record counts keys sent.
    if (result.event.effect === "none") { refused = true; enterCount--; return false; }
    return result.code === 0;
  } };
  const attempt = randomUUID();
  const record = (phase: SubmitPhase, result?: string) => {
    try { recordPhase(input.bus, { id: input.id, attempt, phase, recipient: input.handle, enter_count: enterCount, ordinal, result }); }
    catch { /* Diagnostics never authorize replay. */ }
  };
  // recordPhase files evidence under the recovery run it finds in the environment.
  const priorRun = process.env.TAP_RECOVERY_RUN;
  process.env.TAP_RECOVERY_RUN = input.runId;
  let result: SubmitResult;
  try {
    try {
      result = submitStagedLocked({ pane: input.pane, target: input.paneId, bound, fx, authority, command: input.paneCmd,
        auto: false, urgent: false, preEnterDriftClass: true, cursorSteer: false }, input.id, input.expected, true,
        { record, admit: () => null, bumpOrdinal: () => { ordinal++; }, bumpEnter: () => { enterCount++; } });
    } catch (error) {
      // A tmux read that cannot answer after an Enter was sent is unverified,
      // never a retry and never a pre-effect drift. Before any key it stays the
      // public deadline failure: nothing reached the pane.
      if (!(error instanceof ServerUnresponsive) || enterCount === 0) throw error;
      result = { status: "unverified", detail: `pane observation failed: ${error.message}` };
    }
    record("verify-result", result.status === "injected" ? "verified" : result.status === "harness_queued" ? "queued" : "unverified");
  } finally {
    if (priorRun === undefined) delete process.env.TAP_RECOVERY_RUN; else process.env.TAP_RECOVERY_RUN = priorRun;
  }
  switch (result.status) {
    case "injected": return 0;
    case "harness_queued": return 7;
    case "identity_mismatch": return 6;
  }
  if (refused) { process.stderr.write("tap: recovery refused this Enter -> submit-unverified\n"); return 5; }
  // A pane that vanished mid-submit is the incumbent's human-relay class. An
  // unanswerable probe leaves the result unverified, as it already is.
  let alive: { code: number; stdout: string } = { code: 0, stdout: input.paneId };
  try { alive = tmuxReadOnly(["display-message", "-p", "-t", input.pane, "#{pane_id}"]); }
  catch (error) { if (!(error instanceof ServerUnresponsive)) throw error; }
  if (alive.code !== 0 || alive.stdout.trim() === "") {
    process.stderr.write(`tap: pane '${input.pane}' gone during submit verification -> human-relay\n`);
    return 3;
  }
  process.stderr.write(`tap: ${result.detail} -> submit-unverified\n`);
  return 5;
}

/**
 * Retired spellings (tap-xe42x) answer with their replacement and change nothing.
 * The interrupt is the default now, the nudge carries no sender, and a whole
 * replacement body is an ordinary message.
 */
const RETIRED: Record<string, string> = {
  "--interrupt": "interrupting is the default now; run 'tap nudge <peer>' (add --no-interrupt to skip the interrupt key)",
  "--reason": "use --message \"<one line>\"",
  "--aggressiveness": "use --dry-run to preview without effects",
  "--from": "a nudge carries no sender; to send as a seat, use tap send",
  "-m": "a nudge has no body; add one line with --message, or use tap send for a message",
  "-f": "a nudge has no body; add one line with --message, or use tap send for a message",
};

export function cmdNudge(argv: string[], scriptsDir: string, families: ReadonlySet<string>): number {
  try {
    const valued = new Set(["--message", "--to", "--pane", "--harness", "--team"]);
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]!;
      if (arg === "--") break;
      if (valued.has(arg)) { i++; continue; }
      const hint = RETIRED[arg];
      if (hint) throw new TapError(1, "retired_option", USAGE, `${arg} is retired; ${hint}; nothing sent`);
    }
    if (isFanoutArgv(argv)) {
      let self = { team: "", handle: process.stdin.isTTY ? "user" : "unknown" };
      try { const ctx = resolveSelection(process.env.TAP_HOME ?? "", ""); self = { team: ctx.team, handle: nudgeActor(ctx).handle }; }
      catch { /* outside every enrolled checkout: --team names the teams */ }
      return cmdNudgeFanout(argv, scriptsDir, self, (address, args, instance) =>
        nudgePinnedSeat([address, ...(args.message ? ["--message", args.message] : []), ...(args.interrupt ? [] : ["--no-interrupt"])], scriptsDir, families, instance));
    }
    return nudge(argv, scriptsDir, families);
  } catch (error) {
    if (error instanceof TapError) throw error;
    if (error instanceof SelectorError) throw new TapError(error.code, error.errorClass, error.action, error.detail);
    throw new TapError(1, "recovery_failed", "tap debug recovery", String(error));
  }
}

// Nudge-local translation of the shared selector's ARGV-TARGET verdicts into the incumbent's public
// classes/actions/details; sentinel re-resolution keeps its own mapping, and shared selector policy is untouched.
function argvTargetRefusal(parsed: { team: string }, error: SelectorError): TapError {
  const team = parsed.team;
  const incumbent: Record<string, [string, string, string?]> = {
    historical_team: ["tap doctor", `team '${team}' is historical — not delivery-addressable (${error.detail})`],
    live_unreachable: ["tap doctor", `team '${team}' registry_location is unreachable (${error.detail})`, "unreachable_team"],
    invalid_flip: ["tap doctor", `registry flip marker is present but invalid — refusing legacy delivery (${error.detail})`],
    ambiguous_team: ["enroll the intended '" + team + "' worktree in the machine index", `team '${team}' matches multiple worktree roots: ${error.detail}`],
    unknown_team: ["enroll team '" + team + "' by registering a seat from that worktree", `unknown team '${team}' (not in the machine index)`],
  };
  const hit = incumbent[error.errorClass];
  return new TapError(error.code, hit?.[2] ?? error.errorClass, hit?.[0] ?? error.action, hit?.[1] ?? error.detail);
}

/** One fan-out seat's nudge, pinned to the instance the fan-out selected (exported for its handoff test). */
export function nudgePinnedSeat(argv: string[], scriptsDir: string, families: ReadonlySet<string>, instance: string): number {
  return nudge(argv, scriptsDir, families, instance);
}

/** `pinnedInstance`: the fan-out's selected seat instance; a replaced seat refuses before any key. */
function nudge(argv: string[], scriptsDir: string, families: ReadonlySet<string>, pinnedInstance = ""): number {
  let to = "";
  let pane = "";
  let message = "";
  let interrupt = true;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--message") {
      if (i + 1 >= argv.length) throw new TapError(1, "usage_error", USAGE, "--message needs a value");
      message = argv[++i]!;
      const refusal = nudgeMessageRefusal(message);
      if (refusal) throw new TapError(1, "usage_error", `tap send <peer> -f <file> for anything longer or multi-line`, `${refusal}; use tap send; nothing sent`);
    } else if (arg === "--no-interrupt") { interrupt = false; }
    else if (arg === "--dry-run") { dryRun = true; }
    else if (arg === "--pane") {
      if (i + 1 >= argv.length || argv[i + 1] === "") throw new TapError(1, "usage_error", USAGE, "--pane needs a value");
      pane = argv[++i]!;
    } else if (arg === "--to") {
      if (i + 1 >= argv.length || argv[i + 1] === "") throw new TapError(1, "usage_error", USAGE, "--to needs a value");
      to = setTarget(to, argv[++i]!, "--to");
    } else if (arg.startsWith("--")) { throw new TapError(1, "unknown_option", USAGE, `unknown option '${arg}'`); }
    else { to = setTarget(to, arg, "positional"); }
  }
  if (to === "" && pane === "") throw new TapError(1, "usage_error", USAGE, USAGE_LINE);
  // --pane overrides the registered binding, so it never reaches rung 3: a nudge
  // is typed only into a registered seat's verified pane.
  const deliver = pane === "";
  if (!deliver && (message !== "" || !interrupt)) {
    throw new TapError(1, "usage_error", USAGE, "--message and --no-interrupt shape the delivery rung, which --pane skips; nothing sent");
  }
  const wire = renderNudgeWire(message);
  // Inside a detective worker's recovery run (TAP_RECOVERY_RUN), nudge is that run's
  // staged-sentinel submit only: the run's own mode governs and rungs 1 and 3 never run.
  const parentRun = process.env.TAP_RECOVERY_RUN || "";
  const policy = parentRun ? { mode: readRun(parentRun).mode, source: "recovery run" } : recoveryPolicy("aggressive");
  process.stderr.write(`tap nudge: aggressiveness=${policy.mode} source=${policy.source}\n`);
  // Caller-pin precedence: an explicit TAP_HOME outranks the cwd walk, so a foreign enrolled cwd cannot steal the inspected team from a pinned bus.
  let ctx: Context;
  try { ctx = resolveSelection(process.env.TAP_HOME ?? "", ""); } catch (error) {
    // A team-qualified target anchors the bus from a terminal outside every enrolled checkout.
    const team = to.includes("/") ? to.split("/")[0]! : "";
    if (!(error instanceof TapError) || error.errorClass !== "unanchored_bus" || team === "" || process.env.TAP_HOME) throw error;
    ctx = resolveSelection("", team);
  }
  const toLabel = to;
  let argvTeam = "";
  let argvHandle = "";
  let argvSel: TargetSelection | undefined;
  let registry = ctx.registryPath;
  let argvBinding: Binding = { status: "", pane: "", paneId: "", delivery: "" };
  if (to !== "") {
    const parsed = parseTarget(to);
    try {
      argvSel = selectTarget(ctx.selection!, parsed);
    } catch (error) {
      if (!(error instanceof SelectorError)) throw error;
      throw argvTargetRefusal(parsed, error);
    }
    registry = argvSel.registryLocation;
    argvTeam = argvSel.team;
    argvHandle = argvSel.handle;
    to = argvSel.handle;
    argvBinding = binding(registry, to);
    instanceDrift(registry, to, pinnedInstance);
    if (argvSel.scope === "remote" && argvBinding.status === "suspended") {
      throw new TapError(1, "suspended", `run 'tap register ${to} --pane <tmux-target>' from team '${argvTeam}'`, `handle '${toLabel}' is suspended — re-register it (a suspended seat is not a delivery target)`);
    }
    if (argvBinding.delivery === "poll") {
      throw new TapError(1, "poll_mode_member", `tap send ${toLabel} -m "..." (poll members discover work via tap poll, never injection)`, `'${toLabel}' is a registered poll-mode member — nudge (bare Enter into a pane) does not apply`);
    }
  }
  if (pane === "") pane = argvBinding.pane;
  if (pane === "") throw new TapError(1, "not_found", `register '${toLabel}' with its current pane, then retry`, `no registered pane for '${toLabel}'`);
  // Bash tap_pane_alive semantics: one successful pane_id display means alive.
  const alive = tmuxReadOnly(["display-message", "-p", "-t", pane, "#{pane_id}"]);
  if (alive.code !== 0 || alive.stdout.trim() === "") {
    process.stderr.write(`tap nudge: pane '${pane}' gone\n`);
    return 3;
  }
  // --dry-run is the one preview: the report-only capture (evidence, no effects), then the ladder's plan.
  if (!parentRun && (policy.mode === "report-only" || dryRun)) {
    const reported = recoveryCli(["report", registry, to, pane, toLabel]);
    if (reported !== 0 || !dryRun) return reported;
  }

  // Shallow fast path for a known family; an unsupported shallow value such as `node` defers to the observed process table.
  const shallow = harnessFamily(paneCurrentCommand(pane), [...families]);
  let paneCmd = shallow;
  let klass = classifyHarness(shallow, [...families]);
  if (klass === "unsupported") {
    const panePid = tmuxReadOnly(["display-message", "-p", "-t", pane, "#{pane_pid}"]).stdout.trim();
    const { table, ok } = readProcessTable();
    const deep = observeProcessHarness(panePid, table, ok, [...families]);
    if (deep.state === "observed" && deep.family) paneCmd = deep.family;
    klass = classifyHarness(paneCmd, [...families]);
  }
  if (klass !== "agent" && dryRun) {
    process.stdout.write(`tap nudge: dry run: '${paneCmd}' is not a supported agent harness; nothing would be sent\n`);
    return 0;
  }
  if (klass !== "agent") {
    const detail = klass === "denylist"
      ? `pane '${pane}' runs '${paneCmd}' (not an agent REPL) — refusing bare Enter`
      : `pane '${pane}' runs unsupported harness '${paneCmd}' — refusing bare Enter`;
    throw new TapError(1, "unsupported_harness", `tap send ${toLabel} -m "..."`, detail);
  }
  const captured = captureInputFrame(realPaneIo, pane, paneCmd, true);
  if (!captured.ok) return 1;
  let frame = captured.frame;
  // tap-cl1es: the heal. An OpenCode pane whose band is unobservable — the
  // claude-mem-style overprint, or an input_band_absent booting shape — gets
  // the input-free repaint (resize and restore, never a keystroke), then a
  // re-read and a before/after state report. shell-mode is a real shell and a
  // modal is a human question; neither repaints. The manual nudge is the
  // documented cure once the automatic budget exhausts, so it is not
  // budget-gated.
  let heal: { before: string; after: OverprintHealVerdict } | null = null;
  let repaintedByHeal = false;
  // A dry run previews without effects, so it never repaints.
  if (paneCmd === "opencode" && !dryRun && !opencodeShellMode(frame)) {
    const classify = (candidate: string): "overprint" | "booting" | "blocked" | "readable" => {
      const status = pendingInputText(realPaneIo, pane, paneCmd, candidate).status;
      return status === "overprint" ? "overprint"
        : status === "no-band" ? "booting"
        : status === "blocked" ? "blocked"
        : "readable";
    };
    const before = classify(frame);
    if (before === "overprint" || before === "booting") {
      let repaintHandle = to, repaintPaneId = argvBinding.paneId, repaintRegistry = registry;
      if (repaintHandle !== "") {
        if (argvBinding.status !== "active" || argvBinding.pane !== pane || repaintPaneId === "") {
          throw new TapError(1, "identity_mismatch", "tap nudge <registered-opencode-seat>", "OpenCode paint recovery requires the target's active registered pane binding");
        }
      } else {
        try {
          const self = resolveSelf(ctx, pane, 1); repaintHandle = self.handle; repaintPaneId = self.paneId;
        } catch {
          throw new TapError(1, "identity_mismatch", "tap nudge <registered-opencode-seat>", `OpenCode paint recovery requires exactly one active binding for pane '${pane}'`);
        }
        repaintRegistry = ctx.registryPath;
      }
      const [probeBin, ...probeArgs] = recoveryCliArgv(scriptsDir, ["repaint-probe", repaintRegistry, repaintHandle, pane, repaintPaneId]);
      const probe = spawnSync(probeBin!, probeArgs, { encoding: "utf8" });
      if (probe.status !== 0) {
        throw new TapError(1, "resolution_error", `tap detective ${toLabel} --aggressiveness aggressive`, "OpenCode terminal repaint could not be verified; nothing submitted");
      }
      frame = probe.stdout;
      repaintedByHeal = true;
      heal = { before, after: classify(frame) };
      retireOverprintAfterReadableHeal(repaintPaneId, heal.after);
      process.stderr.write(`tap nudge: repainted OpenCode ${before === "overprint" ? "terminal overprint" : "stuck booting band"} before composer classification\n`);
    }
  }
  if (heal) {
    process.stdout.write(`tap nudge: ${toLabel} (${pane}) band=${heal.before} -> repaint -> band=${heal.after}\n`);
    if (heal.after !== "readable") {
      process.stdout.write(`tap nudge: band still ${heal.after} after the repaint — the paint is persistent; let it settle and repeat\n`);
      return 8;
    }
  }
  // One recorded run holds the whole ladder for a registered seat (tap-xe42x);
  // rung 2's staged submit joins it. --pane alone keeps rungs 1-2.
  // The ladder needs the target's own active binding on this pane; anything else stays with rung 2's refusals.
  const bound = to !== "" && argvBinding.status === "active" && argvBinding.pane === pane && argvBinding.paneId !== "";
  let ladderHandle = bound ? to : "", ladderRegistry = registry, ladderPaneId = argvBinding.paneId, ladderTeam = argvTeam || ctx.team;
  if (ladderHandle === "" && to === "") {
    try { const self = resolveSelf(ctx, pane, 1); ladderHandle = self.handle; ladderPaneId = self.paneId; ladderRegistry = ctx.registryPath; }
    catch { ladderHandle = ""; }
  }
  if (dryRun) {
    const lines = previewLadder({ harness: paneCmd, interrupt, wire, label: toLabel || pane, deliver: deliver && ladderHandle !== "" },
      tmuxReadOnly(["capture-pane", "-p", "-e", "-J", "-t", pane]).stdout, composerRead(pane, paneCmd), closedSentinelInput(sentinelInputTail(frame, paneCmd) ?? ""));
    process.stdout.write(`tap nudge: dry run plan for ${toLabel || pane} (${pane}); nothing sent\n${lines.map(line => `  ${line}\n`).join("")}`);
    return 0;
  }
  const actor = nudgeActor(ctx);
  recordingPin = parentRun ? "" : pinnedInstance;
  recordingCaller = parentRun ? null : { team: actor.team, actor: actor.handle, registry: ladderRegistry || registry, root: ctx.root, home: ctx.bus.home };
  if (ladderHandle === "" || parentRun) {
    const staged = stagedRung(false);
    if (parentRun) {
      if (staged !== null) return staged;
      process.stdout.write(`tap nudge: no staged sentinel in ${toLabel || pane}'s input; nothing submitted\n`);
      return 0;
    }
    if (staged !== null) return staged;
    process.stdout.write(`tap nudge: ${toLabel || pane}: no staged sentinel; ${deliver ? "no active registered binding on this pane" : "--pane overrides the registered seat"}, so nothing else runs\n`);
    return 0;
  }
  if (deliver && actor.team === ladderTeam && actor.handle === ladderHandle) {
    throw new TapError(1, "not_a_target", "tap nudge <another-seat>", `'${toLabel}' is your own seat; a nudge targets other seats; nothing sent`);
  }
  // The ladder's recovery run opens at its first key (rung 1 or 3); a nudge that only
  // submits a staged sentinel keeps rung 2's own recorded run, exactly as before.
  let runId = "", joined = false, exitCode = 1;
  const ensureRun = (): string => {
    if (runId) return runId;
    const target = targetRow(ladderRegistry, ladderHandle, pane, ladderPaneId);
    pinRefusal(ladderHandle, target.instance, pinnedInstance);
    const run = createRun(target, policy.mode, [],
      process.env.TMUX_PANE || "", process.pid, process.env, undefined, false);
    updateRun(run.id, current => { current.caller = { team: actor.team, actor: actor.handle, registry: ladderRegistry, root: ctx.root, home: ctx.bus.home }; });
    process.stderr.write(`tap nudge: recovery=${run.id} (tap debug recovery ${run.id})\n`);
    return runId = run.id;
  };
  const stagedInRun = (reobserve: boolean): number | null => {
    if (!runId) return stagedRung(reobserve);
    // Rung 2 joins the ladder's run, and its own finish releases it.
    const prior = process.env.TAP_RECOVERY_RUN;
    process.env.TAP_RECOVERY_RUN = runId;
    try {
      const code = stagedRung(reobserve);
      if (code !== null) joined = true;
      return code;
    } finally { if (prior === undefined) delete process.env.TAP_RECOVERY_RUN; else process.env.TAP_RECOVERY_RUN = prior; }
  };
  try {
    exitCode = runLadder({ harness: paneCmd, interrupt, wire, label: toLabel || pane, deliver },
      ladderIo(ensureRun, pane, ladderPaneId, paneCmd, stagedInRun));
    return exitCode;
  } catch (error) {
    exitCode = error instanceof TapError ? error.code : 1;
    throw error;
  } finally {
    if (runId && !joined) finishRecordedNudge(runId, exitCode);
  }

  /** Rung 2: the staged sentinel's one recorded Enter, or a copy-mode park's recovery; null when nothing is staged. */
  function stagedRung(reobserve: boolean): number | null {
    // After a dismissal the composer is read afresh; otherwise the (possibly healed) first frame stands.
    if (reobserve) {
      const fresh = captureInputFrame(realPaneIo, pane, paneCmd, true);
      if (!fresh.ok) return null;
      frame = fresh.frame;
      repaintedByHeal = false;
    }
    const region = sentinelInputTail(frame, paneCmd);
    // Nothing staged (or no readable region): rung 3 reads the composer itself.
    if (region === null || region === "") return null;
    if (!region.includes("[[TAP") && !sentinelShapedInput(region)) {
      // tap-w85su: a copy-mode park that outlived the copy mode is what this
      // nudge recovers when the composer is clean. tap-zvuc9: a copy mode nobody
      // is viewing is left first, once, when a park would requeue but for it.
      if (to !== "") {
        const requeue: RequeueInput = { home: ctx.bus.home, team: ctx.team, recipientTeam: argvTeam,
          target: to, registry, paneId: argvBinding.paneId, scriptsDir, observeMode: () => observeCopyMode(pane),
          authorizePane: bound => {
            const verdict = authorizePaneEffect(pane, bound, REAL_EFFECTS, { registryPath: registry, recipient: to, busHome: ctx.bus.home,
              scriptsDir, agentFamilies: families, singleEnter: true });
            return verdict.status === "ok" ? "" : verdict.detail;
          } };
        const cancel = cancelUnattendedCopyMode({ mode: policy.mode, registry, handle: to, pane, paneId: argvBinding.paneId,
          home: ctx.bus.home, license: () => copyModeCancelLicense(requeue) });
        if (reportCopyModeRequeue(toLabel, argvBinding.paneId, cancel, requeueCopyModeParks(requeue))) return 0;
      }
      return null;
    }
    const expected = visibleSentinel(frame, paneCmd);
    // A staged nudge doorbell names no payload: it is submitted by shape, like a scrolled tail.
    // The bound expected text is the wire itself, so the Enter recheck proves it is the sole composer text.
    if (expected !== null && parseNudgeWire(expected) !== null) return nudgeScrolledTail(expected);
    if (expected === null) {
      // tap-1ncs6: the composer shows only the scrolled tail of a wire. Its
      // shape says it is safe to submit; no id is visible to corroborate, so the
      // argv target is the recipient and the tail itself is what every Enter
      // recheck reads. Recognition is by class, not identity (SECURITY.md).
      // An anchored opener that never closes is not a tail and stays refused.
      if (closedSentinelInput(region)) return nudgeScrolledTail(region);
      throw new TapError(1, "usage_error", "inspect the composer; preserve incomplete or ambiguous text and use tap read for the canonical message", "no single complete TAP sentinel is visible in the active input; nothing submitted");
    }
    const stored = stuckSentinelFieldsFromRegion(expected, paneCmd);
    if (!stored.ok) {
      throw new TapError(1, "usage_error", "inspect the complete sentinel and use tap read for the canonical message", "the visible TAP sentinel is malformed; nothing submitted");
    }
    let id = stored.fields.id;
    let sentinelTo = stored.fields.to;
    const wire = stored.fields.wire;
    let sentinelIdTeam = "";
    if (id.includes("/")) { sentinelIdTeam = id.slice(0, id.indexOf("/")); id = id.slice(id.indexOf("/") + 1); }
    if (id === "") throw new TapError(1, "usage_error", USAGE, "stuck sentinel is missing id");
    if (!validId(id)) throw new TapError(1, "usage_error", USAGE, `stuck sentinel id '${id}' fails charset ${TOKEN_RE}`);
    let bus = "";
    let digest: ReturnType<typeof digestRecordIdentity> = null;
    if (wire === "pre023") {
      if (sentinelTo === "") throw new TapError(1, "identity_mismatch", `tap send ${toLabel} -m "..."`, "stuck sentinel is missing its bound to= identity");
      bus = ctx.bus.home;
    } else {
      // v0.23 re-keys on the payload the id names; argv only chooses the BUS, and a wrong bus yields ABSENCE (not_found).
      if (sentinelIdTeam !== "") {
        const enrolled = resolveEnrolledTeamRoot(sentinelIdTeam, process.env.TAP_INDEX_HOME);
        if (enrolled.kind !== "ok") {
          throw new TapError(1, "unknown_team", `enroll team '${sentinelIdTeam}' in the machine index`, `stuck sentinel id names team '${sentinelIdTeam}', which the machine index cannot resolve`);
        }
        bus = `${enrolled.root}/.tap/bus`;
      } else if (argvSel?.scope === "remote" && argvSel.rootReal !== "") {
        bus = `${argvSel.rootReal}/.tap/bus`;
      }
      const payloadPath = bus !== "" ? `${bus}/payloads/${id}.md` : ctx.bus.payloadPath(id);
      if (bus === "") bus = dirname(dirname(payloadPath));
      let sentinelToTeam = "";
      digest = isRegularFile(payloadPath) ? null : digestRecordIdentity(bus, id);
      if (digest !== null) {
        // tap-8nmot: the digest index corroborates the recipient instead of a
        // payload envelope; terminality below rides the digest's own receipt.
        sentinelTo = digest.to;
        sentinelToTeam = digest.toTeam;
      } else {
        if (!isRegularFile(payloadPath)) {
          throw new TapError(1, "not_found", `tap show ${id}`, `stuck sentinel id '${id}' has no payload on ${bus} — it may already be settled or reaped; nothing was submitted`);
        }
        const payload = readFileSync(payloadPath, "utf8");
        sentinelTo = envelopeField(payload, "to") ?? "";
        sentinelToTeam = envelopeField(payload, "to_team") ?? "";
      }
      const refusal = terminalityRefusal(bus, id, digest !== null); if (refusal) throw refusal;
      if (sentinelTo === "") throw new TapError(1, "identity_mismatch", `tap show ${id}`, `payload '${payloadPath}' carries no to: — it cannot corroborate the argv target`);
      if (sentinelToTeam !== "") sentinelTo = `${sentinelToTeam}/${sentinelTo}`;
    }
    let sentinelTarget = sentinelTo; if (!sentinelTarget.includes("/") && !sentinelTarget.includes(":") && argvTeam !== "") sentinelTarget = `${argvTeam}/${sentinelTo}`;
    const parsedSentinel = parseTarget(sentinelTarget);
    let sel2: TargetSelection;
    try {
      sel2 = selectTarget(ctx.selection!, parsedSentinel);
    } catch (error) {
      if (!(error instanceof SelectorError)) throw error;
      if (error.errorClass === "unknown_team") {
        throw new TapError(1, "unknown_team", `tap send ${toLabel} -m "..."`, `stuck sentinel names unknown team '${parsedSentinel.team}'`);
      }
      if (error.errorClass === "ambiguous_team") {
        throw new TapError(1, "ambiguous_team", `enroll team '${parsedSentinel.team}' in the machine index`, `stuck sentinel team '${parsedSentinel.team}' matches multiple worktree roots: ${error.detail}`);
      }
      throw new TapError(1, "resolution_error", `tap send ${toLabel} -m "..."`, `could not resolve stuck sentinel identity '${sentinelTo}' (${error.detail})`);
    }
    const sentinelTeam = sel2.team; const sentinelHandle = sel2.handle;
    const drift = (when: string): TapError => new TapError(1, "identity_mismatch", `run 'tap register ${sentinelHandle} --pane <tmux-target>' from team '${sentinelTeam}'`, `stuck sentinel recipient identity drifted ${when}`);
    if (argvHandle !== "" && (argvTeam !== sentinelTeam || argvHandle !== sentinelHandle)) {
      throw new TapError(1, "identity_mismatch", `tap nudge ${sentinelTeam}/${sentinelHandle}`, `argv target '${argvTeam}/${argvHandle}' disagrees with stuck sentinel to='${sentinelTeam}/${sentinelHandle}'`);
    }
    const sentinelBinding = binding(sel2.registryLocation, sentinelHandle);
    if (sentinelBinding.status !== "active" || sentinelBinding.delivery === "poll") {
      throw new TapError(1, "identity_mismatch", `tap send ${sentinelTeam}/${sentinelHandle} -m "..."`, "stuck sentinel recipient is missing, inactive, or not pane-backed");
    }
    if (pane !== sentinelBinding.pane) {
      throw new TapError(1, "identity_mismatch", `tap nudge ${sentinelTeam}/${sentinelHandle}`, `candidate pane '${pane}' is not the sentinel recipient's bound pane '${sentinelBinding.pane}'`);
    }
    const identity = boundPaneIdentityState(sel2.registryLocation, sentinelHandle, sentinelBinding.pane, sentinelBinding.paneId);
    if (identity !== "match") throw drift(`(${identity})`);
    const effectBus = bus || ctx.bus.home; const lateRefusal = terminalityRefusal(effectBus, id, digest !== null); if (lateRefusal) throw lateRefusal;
    return runRecordedNudge({ policy, registry: sel2.registryLocation, handle: sentinelHandle, team: sentinelTeam, pane, paneId: sentinelBinding.paneId,
      paneCmd, id, expected, effectBus, recipientBus: busForRoot(sel2.rootReal), scriptsDir, families, toLabel, drift,
      repainted: repaintedByHeal && paneCmd === "opencode", digest });
  }

  /**
   * tap-1ncs6: the composer shows the scrolled tail of a wire whose head and
   * id are out of frame. Recognition is by class, not identity: the argv
   * target names the recipient, the tail itself is the expected text every
   * Enter recheck reads, and the recorded recovery run files its effects
   * under the literal `scrolled-tail` payload slot. Never a re-injection.
   */
  function nudgeScrolledTail(tail: string): number {
    let handle = argvHandle, team = argvTeam, registryLocation = registry, bound = argvBinding, rootReal = argvSel?.rootReal ?? "";
    if (handle === "") {
      try { const self = resolveSelf(ctx, pane, 1); handle = self.handle; }
      catch { throw new TapError(1, "identity_mismatch", "tap nudge <registered-seat>", `submitting a scrolled sentinel tail requires exactly one active binding for pane '${pane}'`); }
      team = ctx.team; registryLocation = ctx.registryPath; bound = binding(registryLocation, handle); rootReal = ctx.root;
    }
    if (bound.status !== "active" || bound.delivery === "poll") {
      throw new TapError(1, "identity_mismatch", `tap send ${toLabel} -m "..."`, "scrolled sentinel tail: the argv recipient is missing, inactive, or not pane-backed");
    }
    if (pane !== bound.pane) {
      throw new TapError(1, "identity_mismatch", `tap nudge ${team}/${handle}`, `candidate pane '${pane}' is not '${handle}'s bound pane '${bound.pane}'`);
    }
    const tailDrift = (when: string): TapError => new TapError(1, "identity_mismatch", `run 'tap register ${handle} --pane <tmux-target>' from team '${team}'`, `recipient identity drifted ${when}`);
    const identity = boundPaneIdentityState(registryLocation, handle, bound.pane, bound.paneId);
    if (identity !== "match") throw tailDrift(`(${identity})`);
    process.stderr.write(`tap nudge: composer of ${toLabel || pane} shows the scrolled tail of a TAP wire; submitting it by shape, not identity\n`);
    return runRecordedNudge({ policy, registry: registryLocation, handle, team, pane, paneId: bound.paneId, paneCmd, id: SCROLLED_TAIL_SLOT,
      expected: tail, effectBus: ctx.bus.home, recipientBus: busForRoot(rootReal), scriptsDir, families, toLabel, drift: tailDrift,
      repainted: repaintedByHeal && paneCmd === "opencode" });
  }
}

/**
 * Who ran the nudge, as audit evidence in the recovery run (never a wire sender):
 * the calling pane's verified active seat, `user` at an interactive terminal with
 * no seat, otherwise an explicit `unknown`.
 */
function nudgeActor(ctx: Context): { team: string; handle: string } {
  const caller = callingPane();
  if (caller?.status === "ok") {
    try { return { team: ctx.team, handle: resolveSelf(ctx, caller, 1).handle }; } catch { /* not a seat pane */ }
  }
  // `user` has no team: it is an audit actor, never a seat that could escalate or send.
  return { team: "", handle: process.stdin.isTTY ? "user" : "unknown" };
}

/** Rung 3's composer read: the live six-state pane observation, never a trimmed composer string. */
function composerRead(paneId: string, harness: string): ComposerRead {
  const seen = observePaneKind(paneId, harness, harness);
  switch (seen.kind) {
    case "ready": return { kind: "ready" };
    case "queued": return { kind: "queued" };
    case "draft": return seen.text.includes("[[TAP") ? { kind: "sentinel" } : { kind: "draft" };
    case "no-band": return { kind: "unreadable", detail: seen.reason };
    default: return { kind: "unreadable", detail: seen.kind };
  }
}

/** Production ladder effects: every key is one recorded recovery effect on the bound pane. */
function ladderIo(run: () => string, pane: string, paneId: string, harness: string,
  staged: (reobserve: boolean) => number | null): LadderIO {
  return {
    frame() {
      const captured = tmuxReadOnly(["capture-pane", "-p", "-e", "-J", "-t", paneId]);
      if (captured.code !== 0 || captured.rateLimited) throw new Error(`pane '${pane}' frame unavailable`);
      return captured.stdout;
    },
    composer: () => composerRead(paneId, harness),
    effect(action, keys, gate, verify) {
      let id: string;
      try { id = run(); } catch (error) { throw new PreKeyRefusal(error); }
      const reason = `aggressive: tap nudge ${action} on the registered seat's bound pane`;
      const result = recoveryEffect(id, action, reason, ["send-keys", "-t", paneId, ...keys], REAL_RECOVERY_IO, process.env, undefined, gate, verify);
      if (result.event.incident) escalateRecovery(id, result.event.summary);
      return { sent: result.event.effect === "possible", ok: result.code === 0, verified: result.event.outcome === "verified", summary: result.event.summary };
    },
    expect: wire => { updateRun(run(), current => { current.nudgeExpected = wire; }); },
    submitStaged: reobserve => staged(reobserve),
    sleep: ms => Bun.sleepSync(ms),
    out: line => { process.stdout.write(`${line}\n`); },
  };
}

/** The actor `nudge()` resolved, for the rung-2 run nudge-start opens (null inside a parent run). */
let recordingCaller: { team: string; actor: string; registry: string; root: string; home: string } | null = null;

/** The fan-out's selected instance (empty outside a fan-out or inside a parent run). */
let recordingPin = "";

export function pinRefusal(handle: string, instance: unknown, pinned: string): void {
  if (pinned && instance !== pinned) {
    throw new TapError(1, "target_changed", "tap nudge --dry-run to re-preview", `'${handle}' was replaced after selection (instance changed); not nudged`);
  }
}

export function instanceDrift(registryLocation: string, handle: string, pinned: string): void {
  if (!pinned) return;
  pinRefusal(handle, (seatMap(loadRegistry(registryLocation))[handle] as { instance?: unknown } | undefined)?.instance, pinned);
}

/** The payload slot a recorded nudge files under when the composer shows only a scrolled tail (tap-1ncs6). */
const SCROLLED_TAIL_SLOT = "scrolled-tail";

/** Finalization is best-effort and never replaces the nudge's own result, but a failure means the
 * release could not be confirmed, so it says so once on stderr with the id to inspect (tap-k9emb). */
export function finishRecordedNudge(runId: string, exitCode: number): void {
  try { recoveryCli(["nudge-finish", runId, String(exitCode)]); }
  catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 160);
    process.stderr.write(`tap nudge: recovery release could not be confirmed (${reason}); inspect: tap debug recovery ${runId}\n`);
  }
}

/** One recorded, bounded recovery run around the shared staged-submit loop; both the identified and the scrolled-tail paths end here. */
function runRecordedNudge(input: { policy: { mode: string }; registry: string; handle: string; team: string; pane: string; paneId: string; paneCmd: string;
  id: string; expected: string; effectBus: string; recipientBus: string; scriptsDir: string; families: ReadonlySet<string>; toLabel: string;
  drift: (when: string) => TapError; repainted: boolean; digest?: { indexPath: string; from: string; toTeam: string; members: string[] } | null }): number {
  const { policy, pane, paneCmd, id, expected, effectBus, toLabel, drift } = input;
  const [startBin, ...startArgs] = recoveryCliArgv(input.scriptsDir, ["nudge-start", policy.mode, input.registry, input.handle, pane, input.paneId, id, effectBus, String(process.pid), expected]);
  const started = spawnSync(startBin!, startArgs, { encoding: "utf8" });
  if (started.status !== 0) {
    // Relay the child's own diagnostics: a start failure must name its reason, not exit silently.
    if (started.stdout) process.stdout.write(started.stdout);
    if (started.stderr) process.stderr.write(started.stderr);
    return 1;
  }
  const runId = started.stdout.trim(); process.stderr.write(`tap nudge: recovery=${runId} (tap debug recovery ${runId})\n`);
  // Every nudge run records who pressed its keys; a parent run keeps its own caller.
  const caller = recordingCaller;
  if (caller) updateRun(runId, current => { current.caller ??= caller; });
  // The fan-out's selected occupant must be the instance this run will hold, before any key.
  try { pinRefusal(input.handle, readRun(runId).target.instance, recordingPin); }
  catch (error) { finishRecordedNudge(runId, 1); throw error; }
  let exitCode = 0;
  try {
    const copyRc = recordedCopyCancel(runId);
    if (copyRc === 6) throw drift("before copy-mode cancel");
    if (copyRc !== 0) { exitCode = copyRc; return copyRc; }
    const submitRc = submitRecorded({ runId, pane, paneId: input.paneId, paneCmd, id, expected, registry: input.registry,
      handle: input.handle, bus: effectBus, recipientBus: input.recipientBus, scriptsDir: input.scriptsDir, families: input.families, repainted: input.repainted });
    if (submitRc === 6) throw drift("before submit");
    if (submitRc === 7) {
      if (input.digest) {
        // As the courier does: each member, then the digest itself. The digest has no payload,
        // so its receipt takes the route the index recorded for the doorbell.
        for (const member of input.digest.members) recordHarnessQueued(effectBus, member);
        recordHarnessQueued(effectBus, id, { from: input.digest.from, to: `${input.digest.toTeam || input.team}/${input.handle}`, kind: "digest" });
      } else recordHarnessQueued(effectBus, id);
      process.stdout.write(harnessQueueMessage(effectBus, id, process.env.TAP_JSON === "1", "tap nudge"));
      return 0;
    }
    if (submitRc !== 0) { exitCode = submitRc; return submitRc; }
    // A verified digest injection refreshes the index's retention window, so
    // the drain cannot reap the pointer the recipient was just handed.
    if (input.digest) { try { stampInjected(input.digest.indexPath); } catch { /* retention is best-effort, as in the courier */ } }
    // Every verified digest submit advances the recipient's delivery clock
    // (spool-part-02's digest outcome contract), as injectDigest does.
    if (input.digest) { try { deliveryClockStamp(input.registry, input.handle); } catch { /* best effort, as in the courier */ } }
    process.stdout.write(`tap nudge: re-submitted a stuck sentinel for ${toLabel || pane} (${pane})\n`);
    return 0;
  } catch (error) {
    exitCode = error instanceof TapError ? error.code : 1;
    throw error;
  } finally {
    finishRecordedNudge(runId, exitCode);
  }
}

/**
 * One line for a copy-mode cancel that ran, then one per copy-mode park: requeued, or held
 * with the leg that refused, and why a copy mode still set was not left. True when there was any.
 */
function reportCopyModeRequeue(label: string, paneId: string, cancel: CopyParkCancel, result: RequeueResult): boolean {
  if (cancel.status === "verified") {
    process.stdout.write(`tap nudge: ${label}: left copy mode on ${paneId} (no tmux client attached; recovery=${cancel.recovery})\n`);
  } else if (cancel.status !== "skipped") {
    process.stdout.write(`tap nudge: ${label}: copy-mode cancel ${cancel.status}: ${cancel.why ?? "no detail"} (tap debug recovery ${cancel.recovery})\n`);
  }
  for (const { id } of result.requeued) {
    // A requeue is custody, not delivery: the deliverer's outcome is the delivery result.
    process.stdout.write(`tap nudge: ${label}: requeued copy-mode park ${id} (the pane has left copy mode); delivery is not confirmed yet: tap show ${id}\n`);
  }
  for (const { id, why } of result.held) {
    const cause = why === "pane is still in copy mode" && cancel.status === "skipped" && cancel.why ? ` (${cancel.why})` : "";
    process.stdout.write(`tap nudge: ${label}: copy-mode park ${id} held: ${why}${cause}\n`);
  }
  return result.requeued.length + result.held.length > 0;
}
