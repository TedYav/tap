// The team stop orchestrator (U4 Range A of the libsh-bun TeamStop ladder).
// Port of `team_runtime_stop` (skills/tap/scripts/tap-team-stop.sh at base
// 58484fb5f): composes the approved U1 plan/classification surfaces, the U2
// locked transaction, and the U3 clear/restore/rollback/reaper in the
// incumbent's order. tmux/queue/watch/identity effects are injected, so the
// orchestration branches are provable offline; the production effect set is
// assembled in verbs/team.ts. Env knobs of the incumbent (TAP_TEAM_STOP_*,
// TAP_JSON) drop: their contract lives in these parameters and returns.

import { existsSync, mkdirSync, rmSync, openSync, closeSync, fsyncSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendRegistryEventOrWarn } from "../events";
import { atomicWrite } from "../fsatomic";
import { parseJsonPreserving, pyReadUtf8, isDict as pyIsDict } from "../spool-publication";
import {
  classifyNokill,
  classifyTeamRows,
  buildSpareSets,
  dryRunText,
  noSeatsMatchedText,
  parseRowDump,
  parseStopArgs,
  partiallyDownLine,
  passZeroAllSpared,
  passZeroSpareSets,
  renderPlanText,
  renderReceiptLines,
  renderSpareReceiptLines,
  renderStopReceiptJson,
  selfNote,
  stopExitCode,
  teammateSessionsOf,
  zeroRowText,
  type NokillEntry,
  type RegistryPolicy,
  type SeatEntry,
  type StopRow,
  type StopVerb,
} from "./stop-plan";
import { outcomeWord, runStopTx, type StopTxMode, type StopTxSeatTuple } from "./stop-tx";
import {
  allocateRecoveryArtifact,
  clearRegistry,
  clearSelfSnap,
  emitCrewRestored,
  reapArtifact,
  restoreSelfRows,
  rollbackSelfSnap,
} from "./stop-clear";
import { deenrollTeamWithCapture, restoreTeamEnrollment } from "../index-home";
import { assertResetUnfenced } from "../reset";
import { TapError, type ResolvedContext } from "../context";
import { humanAction, humanLine, errorJson } from "../native-error";
import { crewSelectGate, rosterGate, selectAny, spared, type Selection } from "./selection";
import { refuseSharedSelfStop } from "../opencode-shared-stop";
import { assertBoundSeats, readDiscoverySeats, type BoundCohort } from "./discovery";
import type { LifecycleTmux } from "../lifecycle-target";
import type { Seat } from "../registry";

export interface StopEffects {
  tmux: LifecycleTmux;
  /** Same synchronous locked transaction; injectable for orchestration tests. */
  stopTx?: typeof runStopTx;
  killSession(session: string): boolean;
  hasSession(session: string): boolean;
  paneCount(session: string): number;
  observeSpare(target: string): string | null;
  queueSummary(handles: string[]): { unsettled: number; counts: Map<string, number> };
  /** Where the run's bookkeeping buffers are allocated; a full or unwritable
   * directory refuses the stop before any session dies. */
  bufferDir?: string;
  watch: { isArmed(): boolean; clearTints(): void; disarm(): void };
  identity: {
    tmuxActive: boolean;
    callingPaneId: string;
    callingPaneRefusal?: string;
    selfRefusal: string;
    resolveSelf(): { handle: string; pane: string; paneId: string } | null;
    displaySession(paneTarget: string): string;
  };
  runId: string;
  eventLog: string;
  io: { stdout(line: string): void; stderr(line: string): void; warn(line: string): void };
}

export interface StopInvocation {
  verb: StopVerb;
  policy: RegistryPolicy;
  argv: string[];
  ctx: ResolvedContext;
  roster: string[];
  effects: StopEffects;
  /** Public entries set this; the internal reset-stop runs under reset's own fence. */
  fenced?: boolean;
  /** The `[<team>]` operand, when the caller named the team to stop. */
  namedTeam?: string;
  bound?: BoundCohort;
}

interface Engine {
  inv: StopInvocation;
  selection: Selection;
  team: string;
  selfHandle: string;
  selfSession: string;
  selfPresent: boolean;
  keepSelf: boolean;
  dryRun: boolean;
  wantJson: boolean;
  crewHandles: Set<string>;
  approvedCrewInstances: Map<string, string>;
  retainedPoll: string[];
  refusedHandles: string[];
  sparedRows: number;
  killedCount: number;
  stopped: string[];
  refusedCount: number;
  refusedList: string[];
  refusedJsonList: string[];
  excludedHandles: string[];
  sparedSessions: string[];
  adopted: Array<[string, string]>;
  /** Adoptions whose transaction proved `killed`; the only ones that become durable killed events. */
  terminalAdopted: Array<[string, string]>;
  /** Durable adopted-seat terminal bridge: created before any kill, written
   * and fsynced by the transaction on proven kills, removed only at drain. */
  adoptedBridge: string;
  retainedHandles: string[];
  unrecorded: string[];
  selfRowsPath: string;
  io: StopEffects["io"];
}

export function runTeamStop(inv: StopInvocation): number {
  const { verb, policy, ctx, roster, effects } = inv;
  if (inv.bound) assertBoundSeats(inv.bound, readDiscoverySeats(ctx.registryPath));
  if (inv.fenced) assertResetUnfenced(ctx.bus.home, verb);
  let parsed: ReturnType<typeof parseStopArgs>;
  try {
    parsed = parseStopArgs(verb, inv.argv);
  } catch (e) {
    // Argument refusals are subcommand-scoped: `tap team shutdown --bogus`
    // labels itself "tap team shutdown:", never the bare "tap team:".
    if (e instanceof TapError && !e.verbLabel) throw new TapError(e.code, e.errorClass, e.action, e.detail, `tap team ${verb}`);
    throw e;
  }
  let selection = parsed.selection;
  rosterGate(`team ${verb}`, selection, roster);
  crewSelectGate(`team ${verb}`, selection, ctx.registryPath);
  if (inv.bound) {
    const current = readDiscoverySeats(ctx.registryPath);
    const approved = new Set(selection.only);
    for (const parent of inv.bound.seats.values()) {
      const children = Object.entries(current).filter(([, row]) => row?.crew === true && row.session === parent.session);
      if (!children.length) continue;
      const owners = Object.entries(current).filter(([, row]) => row?.crew !== true && row.session === parent.session);
      if (owners.length !== 1 || owners[0]![0] !== parent.handle) {
        throw new TapError(1, "crew_owner_ambiguous", "tap team doctor",
          `crew in session '${parent.session}' has no unique selected parent`, `tap team ${verb}`);
      }
      for (const [handle] of children) approved.add(handle);
    }
    selection = { mode: "--only", only: [...approved], except: [] };
  }

  // Caller identity before any observation (self-last ordering).
  const identity = effects.identity;
  const callerPaneId = identity.callingPaneId;
  if (!callerPaneId && identity.tmuxActive && !parsed.keepSelf) {
    throw new TapError(
      1,
      "caller_identity_unobservable",
      `run tap team ${verb} from an observable tmux pane`,
      `refusing ${verb} because the caller pane is not observable (self-last ordering cannot be guaranteed; caller pane observation: ${identity.callingPaneRefusal || "reason unavailable"})`,
      `tap team ${verb}`,
    );
  }
  let self: { handle: string; pane: string; paneId: string } | null = null;
  if (callerPaneId && !identity.selfRefusal) self = identity.resolveSelf();
  if (identity.selfRefusal === "generation_unverifiable") {
    throw new TapError(
      1,
      "generation_unverifiable",
      `wait for tmux to answer, then retry tap team ${verb}`,
      "refusing destructive team lifecycle because the tmux server generation is unavailable and the caller identity cannot be verified",
      `tap team ${verb}`,
    );
  }
  const selfSession = self
    ? identity.displaySession(self.paneId || self.pane) || identity.displaySession(callerPaneId)
    : callerPaneId
      ? identity.displaySession(callerPaneId)
      : "";
  // selfPresent is a CLASSIFICATION outcome (the incumbent's
  // self_session_present = non-empty selfmap), not an identity outcome: an
  // excepted, poll-retained, or unverified caller can resolve its identity
  // while contributing no actionable self row. The resolved handle stays as
  // actor metadata only.
  const engine: Engine = {
    inv, selection, team: "", selfHandle: self?.handle ?? "", selfSession,
    selfPresent: false, keepSelf: parsed.keepSelf, dryRun: parsed.dryRun,
    wantJson: parsed.wantJson, crewHandles: new Set(), approvedCrewInstances: new Map(), retainedPoll: [], refusedHandles: [],
    sparedRows: 0, killedCount: 0, stopped: [], refusedCount: 0, refusedList: [],
    refusedJsonList: [], excludedHandles: [], sparedSessions: [], adopted: [], terminalAdopted: [],
    adoptedBridge: "", retainedHandles: [], unrecorded: [], selfRowsPath: "", io: effects.io,
  };

  // Registry read → row dump (an absent registry is the zero-row arm's input).
  const dump = readRowDump(ctx.registryPath, `tap team ${verb}`);
  engine.team = dump.team;
  const rows = dump.rows;

  // Reuse the validated dump: identity refusals and absent/invalid registry
  // semantics must precede the shared guard, which still precedes effects.
  if (!parsed.keepSelf) refuseSharedSelfStop(dump.seats.filter(([handle]) => !spared(handle, selection)),
    `tap team ${verb === "reset-stop" ? "reset" : verb}`, true);

  if (rows.length === 0) return zeroRowArm(engine);

  // Pass-0: a selection naming every row short-circuits without observation.
  if (selectAny(selection) && passZeroAllSpared(rows, selection)) {
    const sets = passZeroSpareSets(rows);
    const unsettled = effects.queueSummary([]).unsettled;
    if (engine.wantJson) {
      engine.io.stdout(renderStopReceiptJson({
        team: engine.team, teammateSessions: [], selfSession: engine.selfSession, selfPresent: false,
        keepSelf: engine.keepSelf, dryRun: engine.dryRun, unsettled, registryPolicy: policy,
        excludedHandles: sets.excludedHandles, sparedSessions: sets.sparedSessions,
      }));
    } else {
      engine.io.stdout(noSeatsMatchedText(verb, selection));
    }
    return 0;
  }

  // Pass-1 spared sets, then classification.
  const spareSets = buildSpareSets(rows, selection, (t) => effects.observeSpare(t), verb);
  const cls = classifyTeamRows(rows, {
    team: engine.team, selection, sparedSessions: new Set(spareSets.sparedSessions),
    selfSession: engine.selfSession, tmux: effects.tmux,
  });
  const nokill = classifyNokill(cls.nokill);
  engine.retainedPoll = nokill.retainedPoll;
  engine.refusedHandles = nokill.refusedHandles;
  engine.sparedRows = cls.sparedRows;
  engine.selfPresent = cls.selfmap.length > 0;
  // A caller who is not a seat of the named team shares a session with it at
  // most by accident (a crew window in the operator's session): that session
  // is the caller's own and is kept, never stopped self-last.
  if (inv.namedTeam && !self && engine.selfPresent) engine.keepSelf = true;
  engine.crewHandles = new Set(rows.filter((r) => r.crew).map((r) => r.handle));

  const pushUnique = (list: string[], v: string) => { if (v && !list.includes(v)) list.push(v); };
  engine.excludedHandles = [...spareSets.sparedHandles];
  for (const e of cls.sparemap) pushUnique(engine.excludedHandles, e.handle);
  if (engine.keepSelf) for (const e of cls.selfmap) pushUnique(engine.excludedHandles, e.handle);
  engine.sparedSessions = [...spareSets.sparedSessions];
  // Only a caller row that actually classified contributes its session to the
  // effective spared set; `kept_self` remains the plain keep-self flag.
  if (engine.keepSelf && engine.selfPresent && engine.selfSession) pushUnique(engine.sparedSessions, engine.selfSession);

  const teammateSessions = teammateSessionsOf(cls.seatmap);
  const queue = effects.queueSummary(rows.map((r) => r.handle));
  const seatCounts = [...queue.counts.entries()].filter(([h]) => h).map(([h, n]) => `${h}=${n}`).join("; ");

  // Plan-time full-spared: the selection covers every row after planning.
  if (cls.sparedRows > 0 && cls.sparedRows === rows.length) {
    if (engine.wantJson) {
      engine.io.stdout(renderStopReceiptJson({
        team: engine.team, teammateSessions: [], selfSession: engine.selfSession, selfPresent: engine.selfPresent,
        keepSelf: engine.keepSelf, dryRun: engine.dryRun, unsettled: queue.unsettled, registryPolicy: policy,
        excludedHandles: engine.excludedHandles, sparedSessions: engine.sparedSessions,
      }));
    } else {
      engine.io.stdout(noSeatsMatchedText(verb, selection));
    }
    return 0;
  }

  if (!engine.wantJson) {
    // renderPlanText ends in one newline; io.stdout adds the line terminator,
    // so strip it or the plan prints a blank line the incumbent never had.
    engine.io.stdout(renderPlanText({
      verb, team: engine.team, registryPolicy: policy, selection,
      teammateSessions, selfSession: engine.selfSession, selfPresent: engine.selfPresent, keepSelf: engine.keepSelf,
      seatmap: cls.seatmap, selfmap: cls.selfmap, nokill: cls.nokill, sparemap: cls.sparemap,
      unsettled: queue.unsettled, paneCount: (s) => effects.paneCount(s),
    }).replace(/\n$/, ""));
  }
  // tap-7r9c: the advisory counts the seat-addressed unsettled payloads —
  // the SUM of the per-seat counts, not unsettled minus that sum (the
  // incumbent's inbound_pending, L2158-2166). Emitted outside the !wantJson
  // guard: the incumbent's stderr advisory reaches callers under --json too.
  const inbound = sumCounts(queue.counts);
  if (verb !== "reset-stop" && inbound > 0) {
    engine.io.warn(`tap team ${verb}: warning: ${inbound} unprocessed inbound payload(s); seat counts: ${seatCounts || "none"}`);
  }
  if (engine.dryRun) {
    if (engine.wantJson) {
      // The incumbent emits the plan-phase JSON receipt for EVERY ordinary
      // dry-run, not only the spared/zero-row shortcuts: the planned sessions,
      // refusals, retained poll rows, exclusions/spares, self classification,
      // and unsettled count all reach the caller before the dry-run return.
      engine.io.stdout(renderStopReceiptJson({
        team: engine.team, teammateSessions, selfSession: engine.selfSession, selfPresent: engine.selfPresent,
        keepSelf: engine.keepSelf, dryRun: true, unsettled: queue.unsettled, registryPolicy: policy,
        refusedHandles: engine.refusedHandles, retainedPoll: engine.retainedPoll,
        excludedHandles: engine.excludedHandles, sparedSessions: engine.sparedSessions,
      }));
    } else {
      engine.io.stdout(dryRunText(verb));
    }
    return 0;
  }

  // Mutation boundary: the watcher lease disarms only for a committing clear.
  watchTeardown(engine);

  // Unverified panes count as stop refusals under suspend/none (under clear
  // the rows are named by the clear's retention instead).
  if (policy !== "clear") {
    for (const h of nokill.refusedHandles) {
      engine.refusedCount += 1;
      engine.io.warn(`tap team ${verb}: warning: unverified pane seat '${h}' — counts as stop refusal (row retained; possible live target)`);
    }
  }

  const event = (action: string, handle: string, pane: string, detail?: string) =>
    appendRegistryEventOrWarn(`tap team ${verb}`, {
      log: effects.eventLog, actor: `team-${verb}`, action, handle: handle || "?", pane, team: engine.team, detail: detail ?? "",
    });

  // The adopted-seat terminal bridge is allocated BEFORE any kill and stays
  // live until drain: a late-adopted seat whose session is stopped must leave
  // a durable record even if the process dies before the drain emits its
  // killed event. The incumbent backs this with a mktemp; the port proves
  // writability by the same exclusive creation and KEEPS the file — the
  // transaction appends proven (handle, session) facts to it and the drain
  // removes it only after the killed events are emitted. An allocation failure
  // still refuses before any mutation.
  const bufferDir = effects.bufferDir ?? tmpdir();
  const adoptedBridge = join(bufferDir, `tap-team-${verb}-adopted.${Math.random().toString(36).slice(2, 8)}`);
  try {
    const fd = openSync(adoptedBridge, "wx", 0o600);
    fsyncSync(fd);
    closeSync(fd);
    engine.adoptedBridge = adoptedBridge;
  } catch {
    throw new TapError(
      1,
      "recovery_unavailable",
      `tap team ${verb} (retry once a temporary directory is writable)`,
      "cannot allocate the adopted-seat terminal bridge; refusing before any session is stopped, because a seat adopted under the lock would be stopped with no durable record",
      `tap team ${verb}`,
    );
  }

  // Teammate kill loop.
  let selfAuth: "authorized" | "refused" | "spared" | "pending" = "authorized";
  for (const s of teammateSessions) {
    // Incumbent tx modes: full (prepare+cotenant_kill) only under suspend;
    // clear and none kill outright — policy none never writes registry rows,
    // so reset's archived registry keeps the pre-stop row states.
    const word = txWord(engine, s, policy === "suspend" ? "full" : "kill_only", cls.seatmap);
    applyTeammateOutcome(engine, s, word, cls.seatmap, event);
  }

  // Self authorize before the clear so a refusal reaches the keep set.
  if (policy === "clear" && engine.selfPresent && engine.selfSession && !engine.keepSelf && cls.selfmap.length > 0) {
    const word = txWord(engine, engine.selfSession, "authorize_only", cls.selfmap);
    if (word.startsWith("spared:")) {
      engine.io.warn(`tap team ${verb}: warning: not killing own session '${engine.selfSession}': ${word.slice("spared:".length)}`);
      engine.refusedList.push(engine.selfSession);
      selfAuth = "spared";
    } else if (word !== "authorized") {
      // Counted refusals warn too (mirror of the suspend self-arm): a silent
      // refusal leaves the caller with an unexplained nonzero exit.
      const reason = word.startsWith("refused:") ? word.slice("refused:".length) : word || "transaction refused";
      engine.io.warn(`tap team ${verb}: warning: not killing own session '${engine.selfSession}': ${reason}`);
      engine.refusedCount += 1;
      engine.refusedList.push(engine.selfSession);
      engine.refusedJsonList.push(engine.selfSession);
      selfAuth = "refused";
    }
  }

  // The clear keep set is built for EVERY clear, independently of whether any
  // caller recovery state is allocated: keep-self rows, spared rows, refused
  // handles across both maps, and adopted-retained handles must all survive
  // the clear even when no self kill is pending. Gating this on a pending
  // self kill deleted the caller row under `--keep-self`.
  let selfRowsPath = "";
  let keepSet: string[] = [];
  if (policy === "clear") {
    if (engine.keepSelf) for (const e of cls.selfmap) pushUnique(keepSet, e.handle);
    for (const e of cls.sparemap) pushUnique(keepSet, e.handle);
    // Refusals are recorded per SESSION (teammate warnings and the clear-path
    // self authorization both push the session name), so retention keys on the
    // session dimension: every classified row whose session was refused,
    // spared by a transaction, or simply survived survives the clear.
    const refusedSessions = new Set(engine.refusedList);
    for (const e of [...cls.seatmap, ...cls.selfmap]) {
      if (refusedSessions.has(e.session)) pushUnique(keepSet, e.handle);
    }
    // Adoption retention bridge (incumbent): a row the stop transactions
    // adopted survives the clear only while its SESSION is in refused_list —
    // refused, spared, or otherwise survived. "Not yet in stopped" is NOT the
    // test: a self-last session is intentionally not stopped yet, and
    // retaining its adopted rows would postpone index de-enrollment past the
    // self kill.
    for (const [h, sess] of engine.adopted) {
      if (refusedSessions.has(sess)) pushUnique(keepSet, h);
    }
  }
  // Caller recovery state (artifact + capture phase) exists whenever a caller
  // row will meet the clear without being kept; a kill is only PLANNED when
  // the self authorization also stands. An allocation failure refuses BEFORE
  // the clear, naming what already stopped; the caller is not killed.
  const clearCallerPhase = policy === "clear" && engine.selfPresent && !!engine.selfSession && !engine.keepSelf;
  const selfKillPlanned = clearCallerPhase && selfAuth !== "refused" && selfAuth !== "spared";
  if (clearCallerPhase) {
    const stoppedNames = engine.stopped.join(" ");
    const refuse = (detail: string, action: string) =>
      new TapError(1, "recovery_unavailable", action, `${detail} — already stopped: [${stoppedNames || "none"}]; the registry was retained and the caller was NOT killed`, `tap team ${verb}`);
    selfRowsPath = allocateRecoveryArtifact(ctx.bus.home) ?? "";
    engine.selfRowsPath = selfRowsPath;
    if (!selfRowsPath) {
      throw refuse(
        `cannot create recovery state under '${join(ctx.bus.home, "recovery")}'; refusing to clear the registry`,
        `tap team ${verb} (retry once a temporary directory is writable)`,
      );
    }
  }

  let idxArtifact = "";
  if (policy === "clear") {
    const cleared = clearRegistry({
      registryPath: ctx.registryPath, tapHome: ctx.bus.home, keepSet,
      selfHandles: clearCallerPhase ? cls.selfmap.map((e) => e.handle) : undefined,
      recoveryOut: selfRowsPath, selection: { mode: selection.mode, set: selection.mode === "--only" ? selection.only : selection.except }, selfSession: engine.selfSession,
      approvedInstances: inv.bound && new Map([...inv.bound.seats].map(([handle, row]) => [handle, row.instance])),
      approvedCrewInstances: inv.bound ? engine.approvedCrewInstances : undefined,
    });
    if (!cleared.ok) {
      reapArtifact({ path: selfRowsPath, restoreRan: false, restoreRc: 0 });
      const stoppedNames = engine.stopped.join(" ");
      const said = cleared.detail ? ` — helper said: ${cleared.detail}` : "";
      if (cleared.cls === 5) {
        throw new TapError(1, "registry_unreadable", `tap team ${verb} (repair or remove the unreadable registry, then re-run)`,
          `the registry could not be parsed at the locked clear, so it was RETAINED as-is and nothing was cleared; already stopped: [${stoppedNames || "none"}]; the caller was NOT killed${said}`, `tap team ${verb}`);
      }
      throw new TapError(1, "recovery_unavailable", `tap team ${verb} (the registry was retained; retry after resolving the capture failure)`,
        `registry clear aborted (rc=${cleared.cls}): recovery state could not be captured, so the registry was left intact; already stopped: [${stoppedNames || "none"}]; the caller was NOT killed${said}`, `tap team ${verb}`);
    }
    // Late-spared merge (codex bot, thread 17): a row the locked clear kept is
    // effectively spared — the handle always; the session only when this run
    // did not already kill it.
    for (const late of cleared.lateSpared) {
      pushUnique(engine.excludedHandles, late.handle);
      if (late.session && !engine.stopped.includes(late.session)) pushUnique(engine.sparedSessions, late.session);
    }
    for (const crew of cleared.deletedCrew) {
      event("crew_collected", crew.handle, crew.pane, `reason=session_killed:${verb} parent=${crew.parent}`);
      engine.io.stdout(`tap team ${verb}: collected crew: ${crew.handle}`);
    }
    idxArtifact = deenrollBestEffort(engine);
  }

  // Drain the completed teammate transactions before self-last.
  drainAdopted(engine, event);

  // Self prepare under suspend; under clear the auth decision above stands.
  let pendingSelfKill = "";
  let selfKillPending = false;
  if (engine.selfPresent && engine.selfSession && !engine.keepSelf) {
    if (policy === "suspend") {
      const word = txWord(engine, engine.selfSession, "prepare", cls.selfmap);
      if (word === "prepared" || word.startsWith("prepared crew_collected=")) {
        pendingSelfKill = engine.selfSession;
        event("kill-requested", engine.selfHandle, engine.selfSession);
        if (word.startsWith("prepared crew_collected=")) {
          const human = word.slice("prepared crew_collected=".length).split(",").filter(Boolean)
            .map((e) => e.split("\x1f")[0] ?? "").filter(Boolean).join(", ");
          engine.io.stdout(`tap team ${verb}: pending crew stop: ${human}`);
        }
        selfKillPending = true;
      } else if (word.startsWith("spared:")) {
        engine.io.warn(`tap team ${verb}: warning: not killing own session '${engine.selfSession}': ${word.slice("spared:".length)}`);
        engine.refusedList.push(engine.selfSession);
      } else {
        const reason = word.startsWith("refused:") ? word.slice("refused:".length) : word || "transaction refused";
        engine.io.warn(`tap team ${verb}: warning: not killing own session '${engine.selfSession}': ${reason}`);
        engine.refusedCount += 1;
        engine.refusedList.push(engine.selfSession);
        engine.refusedJsonList.push(engine.selfSession);
      }
    } else if (selfAuth === "authorized") {
      pendingSelfKill = engine.selfSession;
      event("kill-requested", engine.selfHandle, engine.selfSession);
      selfKillPending = true;
    }
  }

  // Operator receipt BEFORE the one-way kill boundary.
  const note = selfNote({
    selfSession: engine.selfSession, selfPresent: engine.selfPresent, keepSelf: engine.keepSelf,
    selfAuthRefused: selfAuth === "refused",
  });
  emitReceipt(engine, cls, teammateSessions, pendingSelfKill, note, queue.unsettled, policy, "pre-kill");

  // One-way boundary.
  let restoreFailed = false;
  let restoreRan = false;
  if (selfKillPending) {
    const word = txWord(engine, engine.selfSession, "cotenant_kill", cls.selfmap, selfRowsPath);
    let outcome = word;
    let selfArtifact = selfRowsPath;
    if (outcome.startsWith("kill-failed-stranded:")) {
      selfArtifact = outcome.slice("kill-failed-stranded:".length);
      outcome = "kill-failed";
      engine.io.warn(`tap team ${verb}: warning: recovery state is at '${selfArtifact}' (the inverse rename failed); the captured caller row is retained there for manual repair`);
    }
    if (policy === "clear" && outcome !== "killed") {
      const restored = restoreSelfRows({ registryPath: ctx.registryPath, rowsFile: selfArtifact });
      restoreRan = restored.ran;
      if (restored.ran && !restored.ok) {
        restoreFailed = true;
        // Text callers otherwise learn only "partially down": the live caller
        // has NO registry row, and the retained artifact is the only copy of
        // it. JSON callers keep the structured recovery-path receipt alone.
        if (!engine.wantJson) {
          engine.io.warn(`tap team ${verb}: warning: caller-row restore failed: ${restored.detail}; the captured caller row is retained at '${selfArtifact}'`);
        }
      }
      // Registry rows FIRST, then enrollment — the reverse of capture order.
      if (idxArtifact && existsSync(idxArtifact)) {
        const back = restoreTeamEnrollment({ team: ctx.team, artifact: idxArtifact });
        if (back.ok) {
          discardArtifact(engine, idxArtifact);
          idxArtifact = "";
        } else {
          engine.io.warn(`tap team ${verb}: warning: machine-index enrollment for '${ctx.team}' could not be restored (code=${back.code}); the capture artifact is retained at '${idxArtifact}' for manual repair`);
        }
      }
      if (restoreFailed) event("recovery-pending", engine.selfHandle, engine.selfSession);
    }
    if (outcome === "kill-failed") {
      // Terminal below treats a surviving kill as its own counted outcome.
      if (effects.hasSession(engine.selfSession)) {
        engine.io.warn(`tap team ${verb}: warning: own session '${engine.selfSession}' still live after kill`);
      }
      engine.refusedCount += 1;
      engine.refusedList.push(engine.selfSession);
      engine.refusedJsonList.push(engine.selfSession);
      event("kill-failed", engine.selfHandle, engine.selfSession);
      // A failed kill must undo the prepared suspend exactly like a refused
      // one, or the live caller row stays `suspended` with its journal left
      // on disk.
      rollbackSuspendSelf(engine);
      emitReceipt(engine, cls, teammateSessions, "", note, queue.unsettled, policy, "self-failed", restoreFailed ? selfArtifact : undefined);
    } else if (outcome !== "killed") {
      const sparedCase = outcome.startsWith("spared:");
      const reason = sparedCase ? outcome.slice("spared:".length)
        : outcome.startsWith("refused:") ? outcome.slice("refused:".length) : outcome || "transaction refused";
      engine.io.warn(`tap team ${verb}: warning: not killing own session '${engine.selfSession}': ${reason}`);
      rollbackSuspendSelf(engine);
      if (!sparedCase) {
        engine.refusedCount += 1;
        engine.refusedJsonList.push(engine.selfSession);
      }
      engine.refusedList.push(engine.selfSession);
      selfKillPending = false;
      pendingSelfKill = "";
      event("kill-refused", engine.selfHandle, engine.selfSession);
      emitReceipt(engine, cls, teammateSessions, "", note, queue.unsettled, policy, "self-refused", restoreFailed ? selfArtifact : undefined);
    } else if (effects.hasSession(engine.selfSession)) {
      engine.io.warn(`tap team ${verb}: warning: own session '${engine.selfSession}' still live after kill`);
      rollbackSuspendSelf(engine);
      engine.refusedCount += 1;
      engine.refusedList.push(engine.selfSession);
      engine.refusedJsonList.push(engine.selfSession);
      event("kill-failed", engine.selfHandle, engine.selfSession);
      emitReceipt(engine, cls, teammateSessions, "", note, queue.unsettled, policy, "self-failed", restoreFailed ? selfArtifact : undefined);
    } else {
      clearSelfSnap(ctx.registryPath, effects.runId);
    }
    // Proof-based artifact disposal (resolved-empty / success spends).
    reapArtifact({ path: selfArtifact, restoreRan, restoreRc: restoreFailed ? 1 : 0 });
    if (selfRowsPath && selfRowsPath !== selfArtifact) reapArtifact({ path: selfRowsPath, restoreRan: false, restoreRc: 0 });
  }
  // An allocated-but-unspent artifact (self authorization refused or spared
  // after allocation) is reaped like the incumbent's unconditional final
  // reaper: resolved-empty capture rows spend it; anything else is retained.
  if (!selfKillPending && selfRowsPath) {
    reapArtifact({ path: selfRowsPath, restoreRan: false, restoreRc: 0 });
  }
  if (idxArtifact && existsSync(idxArtifact) && !restoreRan) {
    discardArtifact(engine, idxArtifact);
  }

  // Survivor-path drain: rows the self-last transaction adopted.
  drainAdopted(engine, event);
  if (engine.unrecorded.length > 0) {
    engine.io.warn(`tap team ${verb}: warning: ${engine.unrecorded.length} adopted seat(s) were stopped with no durable killed event (reconcile by hand): ${engine.unrecorded.join(" ")}`);
  }

  return stopExitCode({ restoreFailed, refusedCount: engine.refusedCount, unrecordedCount: engine.unrecorded.length });
}

// --- helpers -----------------------------------------------------------------

function sumCounts(counts: Map<string, number>): number {
  let total = 0;
  for (const n of counts.values()) total += n;
  return total;
}

/**
 * Undo a prepared self kill after the one-way boundary refused or failed.
 * The incumbent runs this identical rollback for the refused, kill-failed,
 * and still-live correction paths; a rollback failure is never silent — the
 * journal is retained and the warning names the consequence.
 */
function rollbackSuspendSelf(engine: Engine): void {
  const { verb, policy, ctx, effects } = engine.inv;
  let rc = 0;
  if (policy === "suspend") {
    const rolled = rollbackSelfSnap({ registryPath: ctx.registryPath, runId: effects.runId });
    if (rolled.ran && rolled.ok && rolled.crewRestored.length > 0) {
      emitCrewRestored({ verb, eventLog: effects.eventLog, team: engine.team, rows: rolled.crewRestored });
    }
    if (rolled.ran && !rolled.ok) rc = rolled.rc;
  } else {
    clearSelfSnap(ctx.registryPath, effects.runId);
  }
  if (rc !== 0) {
    engine.io.warn(`tap team ${verb}: warning: the suspend recorded before the deferred kill could NOT be rolled back (rc=${rc}); the journal is retained — the caller's row may still read as suspended while its session is live`);
  }
}

function readRowDump(registryPath: string, label: string): { team: string; rows: StopRow[]; seats: Array<[string, Seat]> } {
  let doc: unknown;
  try {
    doc = parseJsonPreserving(pyReadUtf8(registryPath));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { team: "", rows: [], seats: [] };
    throw new TapError(1, "registry_invalid", "repair_registry", `tap team: registry unreadable (${(e as Error).message})`, label);
  }
  if (!pyIsDict(doc)) {
    throw new TapError(1, "registry_invalid", "repair_registry", "tap team: registry unreadable (registry is not a JSON object)", label);
  }
  const docObj = doc as Record<string, unknown>;
  const teamField = docObj.team;
  // The incumbent dump does `(reg.get("team") or {}).get("name")`: a truthy
  // non-object envelope raises inside the dump and refuses as registry_invalid,
  // while a falsy envelope stays empty. Keep exactly that boundary.
  if (teamField && !pyIsDict(teamField)) {
    throw new TapError(1, "registry_invalid", "repair_registry", "tap team: registry unreadable (team envelope is not an object)", label);
  }
  const team = pyIsDict(teamField) && typeof (teamField as Record<string, unknown>).name === "string"
    ? String((teamField as Record<string, unknown>).name)
    : "";
  const rawSeats = docObj.seats;
  const axis = pyIsDict(rawSeats) ? rawSeats : rawSeats === undefined ? {} : null;
  if (axis === null) {
    throw new TapError(1, "registry_invalid", "repair_registry", "tap team: registry unreadable (seat axis is not an object)", label);
  }
  const seats = Object.entries(axis as Record<string, unknown>)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .filter((entry): entry is [string, Seat] => pyIsDict(entry[1]));
  const lines = seats.map(([handle, ent]) => dumpLine(handle, ent, label));
  try {
    return { ...parseRowDump([team, ...lines].join("\n")), seats };
  } catch (e) {
    if (e instanceof TapError && !e.verbLabel) throw new TapError(e.code, e.errorClass, e.action, e.detail, label);
    throw e;
  }
}

/**
 * One seat → one \x1f-joined dump line, under the incumbent dump writer's
 * trust boundary: a row field is an exact string or falsy, and `crew` is
 * exactly boolean. A truthy non-string (a numeric session, an object pane)
 * refuses as registry_invalid BEFORE any observation or mutation — coercing
 * it would turn session `123` into the tmux target "123". No schema
 * framework: this is only the join's own type requirement.
 */
function dumpLine(handle: string, e: Record<string, unknown>, label: string): string {
  const field = (name: string): string => {
    const v = e[name];
    if (!v) return "";
    if (typeof v !== "string") {
      throw new TapError(1, "registry_invalid", "repair_registry", `tap team: registry unreadable (seat '${handle}' field '${name}' is not a string)`, label);
    }
    return v;
  };
  // Crew classifies only on the exact boolean; every other value (truthy
  // strings included) is an ordinary non-crew row, as the incumbent's
  // `is True` check does. No refusal on this field.
  const delivery = field("delivery");
  return [
    handle, delivery ? delivery : "pane", field("pane"), field("pane_id"),
    field("server_epoch"), field("session"), field("status"), field("status_reason"), e.crew === true ? "1" : "0",
  ].join("\x1f");
}

function zeroRowArm(engine: Engine): number {
  const { verb, policy, ctx } = engine.inv;
  const io = engine.io;
  if (policy !== "clear") {
    emitEmptyReceipt(engine, engine.dryRun);
    if (!engine.wantJson) io.stdout(zeroRowText(verb, policy, { dryRun: engine.dryRun, registryPresent: existsSync(ctx.registryPath) }));
    return 0;
  }
  if (engine.dryRun) {
    if (engine.wantJson) {
      io.stdout(renderStopReceiptJson({
        team: engine.team, teammateSessions: [], selfSession: "", selfPresent: false, keepSelf: engine.keepSelf,
        dryRun: true, unsettled: 0, registryPolicy: policy,
      }));
    } else {
      io.stdout(zeroRowText(verb, policy, { dryRun: true }));
    }
    return 0;
  }
  const registryPresent = existsSync(ctx.registryPath);
  if (registryPresent) {
    const cleared = clearRegistry({
      registryPath: ctx.registryPath, tapHome: ctx.bus.home, keepSet: [],
      recoveryOut: "", selection: { mode: "", set: [] }, selfSession: "",
    });
    if (!cleared.ok) {
      const said = cleared.detail ? ` — helper said: ${cleared.detail}` : "";
      if (cleared.cls === 5) {
        throw new TapError(1, "registry_unreadable", `tap team ${verb} (repair or remove the unreadable registry, then re-run)`,
          `the registry could not be parsed at the locked clear, so it was RETAINED as-is and nothing was cleared; no seats were registered${said}`, `tap team ${verb}`);
      }
      throw new TapError(1, "recovery_unavailable", `tap team ${verb} (the registry was retained; retry after resolving the failure)`,
        `registry clear aborted (rc=${cleared.cls}) with no seats registered${said}`, `tap team ${verb}`);
    }
  }
  watchTeardown(engine);
  const captured = deenrollBestEffort(engine);
  if (captured) discardArtifact(engine, captured);
  if (engine.wantJson) {
    io.stdout(renderStopReceiptJson({
      team: engine.team, teammateSessions: [], selfSession: "", selfPresent: false, keepSelf: engine.keepSelf,
      dryRun: false, unsettled: 0, registryPolicy: policy,
    }));
  } else {
    io.stdout(registryPresent
      ? `tap team ${verb}: deleted blank acting registry (no seats); next: tap init`
      : `tap team ${verb}: no agents registered — nothing to shut down`);
  }
  return 0;
}

function emitEmptyReceipt(engine: Engine, dryRun: boolean): void {
  if (!engine.wantJson) return;
  engine.io.stdout(renderStopReceiptJson({
    team: engine.team, teammateSessions: [], selfSession: "", selfPresent: false, keepSelf: engine.keepSelf,
    dryRun, unsettled: 0, registryPolicy: engine.inv.policy,
  }));
}

function watchTeardown(engine: Engine): void {
  const { policy, effects, verb } = engine.inv;
  if (policy !== "clear") return; // U0: only a committing clear disarms.
  if (!effects.watch.isArmed()) return;
  try {
    effects.watch.clearTints();
    effects.watch.disarm();
  } catch {
    engine.io.warn(`tap team ${verb}: warning: watcher disarm failed; the lease was kept — see 'tap health'; retry 'tap watch off --force'`);
  }
}

function deenrollBestEffort(engine: Engine): string {
  const { policy, ctx, effects, verb } = engine.inv;
  if (policy !== "clear") return "";
  if (!ctx.registryPath) return "";
  if (existsSync(ctx.registryPath)) return "";
  // H1 returns before any index work for an unindexed bus: it has no
  // machine-index entry to remove, so it must silently skip, not warn.
  if (ctx.selection?.authority === "bus") return "";
  const warnLeft = (msg: string) => effects.io.warn(`tap team ${verb}: warning: ${msg} — 'tap admin refresh' can purge it`);
  const artifact = allocateIndexArtifact(ctx.bus.home);
  if (!artifact) {
    warnLeft(`cannot allocate the index capture artifact; the machine-index entry was left enrolled`);
    return "";
  }
  const done = deenrollTeamWithCapture({
    team: ctx.team, artifact, expectRoot: ctx.root, expectRegistry: ctx.registryPath,
  });
  if (!done.ok) {
    // An index write that failed after the capture artifact landed returns the
    // artifact for the run's lifecycle (restore on a failed self kill, spend
    // on success): the key removal is pending, so the file is the only copy.
    if (done.artifact) {
      warnLeft(`index de-enrollment for '${ctx.team}' failed: ${done.detail}`);
      return done.artifact;
    }
    discardArtifact(engine, artifact);
    warnLeft(`index de-enrollment for '${ctx.team}' was refused (code=${done.code}); the entry was left enrolled`);
    return "";
  }
  return artifact;
}

function allocateIndexArtifact(busHome: string): string | null {
  const dir = join(busHome, "recovery");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  for (let i = 0; i < 16; i++) {
    const p = join(dir, `team-shutdown-index.${Math.random().toString(36).slice(2, 8)}`);
    try {
      const fd = openSync(p, "wx", 0o600);
      closeSync(fd);
      return p;
    } catch {
      // name collision — retry
    }
  }
  return null;
}

function discardArtifact(engine: Engine, path: string): void {
  if (!path) return;
  try {
    rmSync(path, { force: true });
  } catch {
    engine.io.warn(`tap team ${engine.inv.verb}: warning: could not remove the consumed index capture artifact '${path}'; remove it manually`);
  }
}

function txWord(
  engine: Engine,
  session: string,
  mode: StopTxMode,
  map: SeatEntry[],
  selfRowsPath?: string,
): string {
  const { inv, selection } = engine;
  const tuples: StopTxSeatTuple[] = map
    .filter((e) => e.session === session)
    .map((e) => ({ handle: e.handle, paneId: e.paneId, rowSession: e.rowSession, rowEpoch: e.serverEpoch, expected: e.expected }));
  try {
    const result = (inv.effects.stopTx ?? runStopTx)({
      session, mode, policy: inv.policy, seats: tuples, selection: { mode: selection.mode, set: selection.mode === "--only" ? selection.only : selection.except },
      approvedInstances: inv.bound && new Map([...inv.bound.seats].map(([handle, row]) => [handle, row.instance])),
      approvedParentLifetimes: inv.bound?.parentLifetimes,
      approvedCrewAtConsent: inv.bound?.approvedCrewAtConsent,
      selfHandle: engine.selfHandle ?? "", runId: inv.effects.runId,
      selfRowsPath: selfRowsPath ?? (mode === "cotenant_kill" ? engine.selfRowsPath : ""),
      adoptedBridge: engine.adoptedBridge,
      registryPath: inv.ctx.registryPath, eventLog: inv.effects.eventLog, team: inv.ctx.team,
      verbShort: inv.verb,
      effects: { tmux: inv.effects.tmux, killSession: inv.effects.killSession, hasSession: inv.effects.hasSession },
    });
    for (const w of result.warnings) {
      engine.io.warn(`tap team ${inv.verb}: warning: ${w}`);
    }
    for (const h of result.adopted) {
      // Two distinct bridges (incumbent): EVERY adoption is a retention fact,
      // but only an adoption whose transaction PROVED `killed` may later
      // become a durable killed event. A refused transaction's adoptions are
      // retention-only — emitting killed for them would invent history. Both
      // ledgers key on the (handle, session) TUPLE: a handle that
      // re-registers into another planned session before that transaction
      // runs is a second, independent fact.
      if (!engine.adopted.some(([x, s]) => x === h && s === session)) engine.adopted.push([h, session]);
      if (result.outcome.kind === "killed" && !engine.terminalAdopted.some(([x, s]) => x === h && s === session)) {
        engine.terminalAdopted.push([h, session]);
      }
    }
    if ((result.outcome.kind === "killed" || result.outcome.kind === "authorized") && selection.mode === "--only") {
      for (const handle of result.approvedCrew ?? []) {
        if (!selection.only.includes(handle)) selection.only.push(handle);
      }
      for (const [handle, instance] of result.approvedCrewInstances ?? []) engine.approvedCrewInstances.set(handle, instance);
    }
    for (const h of result.retained) if (!engine.retainedHandles.includes(h)) engine.retainedHandles.push(h);
    for (const h of result.unrecorded) if (!engine.unrecorded.includes(h)) engine.unrecorded.push(h);
    return outcomeWord(result);
  } catch {
    return "refused:transaction refused";
  }
}

function applyTeammateOutcome(
  engine: Engine,
  s: string,
  word: string,
  seatmap: SeatEntry[],
  event: (action: string, handle: string, pane: string, detail?: string) => void,
): void {
  const io = engine.io;
  const verb = engine.inv.verb;
  const handlesIn = seatmap.filter((e) => e.session === s && !engine.crewHandles.has(e.handle)).map((e) => e.handle);
  const killed = () => {
    engine.killedCount += 1;
    engine.stopped.push(s);
    for (const h of handlesIn) event("killed", h, s);
  };
  const stillLive = () => {
    io.warn(`tap team ${verb}: warning: session '${s}' still live after kill`);
    engine.refusedCount += 1;
    engine.refusedList.push(s);
    engine.refusedJsonList.push(s);
    for (const h of handlesIn) event("kill-failed", h, s);
  };
  if (word === "killed" || word.startsWith("killed crew_collected=")) {
    if (engine.inv.policy === "clear" && engine.inv.effects.hasSession(s)) {
      stillLive();
      return;
    }
    killed();
    if (word.startsWith("killed crew_collected=")) {
      const human: string[] = [];
      for (const entry of word.slice("killed crew_collected=".length).split(",").filter(Boolean)) {
        const [h, p, par] = entry.split("\x1f");
        if (!h) continue;
        event("crew_collected", h, p ?? "", `reason=session_killed:${verb} parent=${par ?? ""}`);
        human.push(h);
      }
      if (human.length > 0) io.stdout(`tap team ${verb}: collected crew: ${human.join(", ")}`);
    }
    return;
  }
  if (word.startsWith("spared:")) {
    io.warn(`tap team ${verb}: warning: not killing session '${s}': ${word.slice("spared:".length)}`);
    engine.refusedList.push(s);
    return;
  }
  if (word === "kill-failed") {
    stillLive();
    return;
  }
  const reason = word.startsWith("refused:") ? word.slice("refused:".length) : word || "transaction refused";
  io.warn(`tap team ${verb}: warning: not killing session '${s}': ${reason}`);
  engine.refusedCount += 1;
  engine.refusedList.push(s);
  engine.refusedJsonList.push(s);
}

function drainAdopted(engine: Engine, event: (action: string, handle: string, pane: string, detail?: string) => boolean): void {
  // Only PROVEN kills become durable killed events; the retention ledger
  // itself never speaks here. A killed event whose append fails is disclosed
  // through the unrecorded contract: the seat WAS stopped, so neither silence
  // nor success would be true.
  for (const [h, sess] of engine.terminalAdopted) {
    if (engine.crewHandles.has(h)) continue;
    if (!event("killed", h, sess) && !engine.unrecorded.includes(h)) engine.unrecorded.push(h);
  }
  engine.terminalAdopted = [];
  engine.adopted = [];
  if (engine.adoptedBridge) {
    try {
      rmSync(engine.adoptedBridge, { force: true });
    } catch {
      engine.io.warn(`tap team ${engine.inv.verb}: warning: could not remove the adopted-seat terminal bridge '${engine.adoptedBridge}'; remove it manually`);
    }
    engine.adoptedBridge = "";
  }
}

function emitReceipt(
  engine: Engine,
  cls: { selfmap: SeatEntry[] },
  teammateSessions: string[],
  pendingSelfKill: string,
  note: string,
  unsettled: number,
  policy: RegistryPolicy,
  phase: "pre-kill" | "self-refused" | "self-failed",
  recoveryPath?: string,
): void {
  const io = engine.io;
  const verb = engine.inv.verb;
  if (engine.wantJson) {
    io.stdout(renderStopReceiptJson({
      team: engine.team, teammateSessions, selfSession: engine.selfSession, selfPresent: engine.selfPresent,
      keepSelf: engine.keepSelf, dryRun: false, unsettled, registryPolicy: policy,
      stoppedSessions: engine.stopped, refusedSessions: engine.refusedJsonList,
      refusedHandles: engine.refusedHandles, retainedPoll: engine.retainedPoll,
      pendingSelfKill: phase === "pre-kill" ? pendingSelfKill : "",
      excludedHandles: engine.excludedHandles, sparedSessions: engine.sparedSessions,
      recoveryPath,
    }));
    return;
  }
  if (phase === "pre-kill") {
    for (const line of renderReceiptLines({
      verb, registryPolicy: policy, registryPresent: existsSync(engine.inv.ctx.registryPath),
      killedCount: engine.killedCount, selfNote: note, pollN: engine.retainedPoll.length,
      refusedCount: engine.refusedCount,
    })) {
      io.stdout(line);
    }
  } else {
    io.stderr(partiallyDownLine(verb, engine.killedCount, engine.refusedCount, phase));
  }
  // The incumbent prints the spare/exclusion receipt lines only alongside the
  // INITIAL receipt; the self-refused/self-failed correction receipts carry
  // the correction alone.
  if (phase === "pre-kill") {
    for (const line of renderSpareReceiptLines({
      verb, selection: engine.selection, excludedHandles: engine.excludedHandles,
      sparedRows: engine.sparedRows, keepSelf: engine.keepSelf, keepSelfRows: cls.selfmap.length,
    })) {
      io.stdout(line);
    }
  }
}

export type { StopRow, StopVerb, RegistryPolicy };

// --- module CLI door ----------------------------------------------------------
// `bun .../src/team/stop.ts <verb> [args...]` is the direct execution door for
// the Bash bridges (`tap team down|shutdown`) and the private `reset-stop
// --json` receipt seam. Entry decoding and IO live here only: every lifecycle
// decision stays in the approved orchestrator and the shared door body in
// verbs/team.ts.
async function stopCli(argv: string[]): Promise<number> {
  const verb = argv[0] ?? "";
  if (verb !== "down" && verb !== "shutdown" && verb !== "reset-stop") {
    process.stderr.write("usage: stop.ts down|shutdown|reset-stop [args...]\n");
    return 2;
  }
  try {
    // Dynamic import: verbs/team.ts statically imports this module, so the
    // shared door is loaded lazily to keep the cycle one-way at evaluation.
    const door = await import("../verbs/team");
    return door.runTeamStopDoor(verb, argv.slice(1));
  } catch (error) {
    // The public stop door exports TAP_JSON before parsing, and reset invokes
    // this private seam with command-scoped TAP_JSON=1. All machine refusals
    // use the same stdout envelope as the shipped router.
    if (error instanceof TapError) {
      if (process.env.TAP_JSON === "1") {
        process.stdout.write(errorJson(error.errorClass, error.action, error.detail));
      } else {
        const label = error.verbLabel ?? `tap team ${verb}`;
        process.stderr.write(`${label}: ${humanLine(error.detail)}; next: ${humanAction(error.action)}\n`);
      }
      return error.code;
    }
    throw error;
  }
}

if (import.meta.main) {
  stopCli(process.argv.slice(2))
    .then(rc => process.exit(rc))
    .catch(error => {
      process.stderr.write(`tap team: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
