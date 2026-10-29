import { captureCrewProcess, fenceCrewLifetime, stopCrewProcess } from "./crew-lifetime";
import { writeSync } from "node:fs";
import { join } from "node:path";
import { observeCallerIdentity, TapError } from "./context";
import { registryWriteRefusal } from "./register-authority";
import { acquireRegistryLock, childBusEnv } from "./panelock";
import { acquireResetMutationLock, markResetGenerationReused } from "./reset";
import { loadRegistry, saveRegistry, seatMap, type Seat } from "./registry";
import { assertSelectionCurrent, parseTarget, selectCaller, SelectorError, type Selection } from "./selector";
import { canonicalSessionName, lifecycleDisposition, lifecycleReceipt, tmuxFateStopsNamedSession } from "./lifecycle-target";
import { physicalSocketPath } from "./tmux";
import { liveSeat, liveOwnerSeat, ownedCrewRows, seatSnapshot, stopExactPane } from "./seat-stop";
export { liveSeat, ownedCrewRows, seatSnapshot, stopExactPane } from "./seat-stop";
import { resumeSelectedSeat, validateSeatUp, withLaunchSignals, LaunchInterrupted, TransactionError } from "./launcher/transaction";
import { withStartupTrace } from "./startup-trace";
import { tapScriptsDir } from "./scripts-dir";
import { assertSharedStopCleared, quiesceSharedSession, refuseSharedSelfStop } from "./opencode-shared-stop";

export interface SeatOptions { target: string; team?: string; json: boolean; dryRun: boolean; selfReported?: boolean; skipQuiesce?: boolean }
export function parseSeatOptions(argv: string[]): SeatOptions {
  const options: SeatOptions = { target: "", json: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") options.json = true;
    else if (arg === "--skip-quiesce") options.skipQuiesce = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--team") {
      if (options.team !== undefined || !argv[i + 1] || argv[i + 1]!.startsWith("-")) fail("usage_error", "--team needs one team name");
      options.team = argv[++i];
    } else if (arg.startsWith("-") || options.target) fail("usage_error", `unexpected argument '${arg}'`);
    else options.target = arg;
  }
  if (!options.target) fail("usage_error", "name one durable seat");
  return options;
}
function fail(errorClass: string, detail: string): never {
  throw new TapError(1, errorClass, "tap help up / tap help down", detail);
}

export function validateDurable(row: Seat | undefined, handle: string, team: string, verb: "up" | "down"): Seat {
  if (!row || typeof row !== "object" || Array.isArray(row)) fail("not_found", `unknown seat '${team}/${handle}'; create it with tap session launch`);
  const disposition = lifecycleDisposition(row.crew === true ? "crew" : "seat", verb);
  if (!disposition.ok) fail("ephemeral_crew", disposition.detail);
  if (row.delivery === "poll") fail("poll_seat", "poll seats have no durable tmux session");
  if (row.session !== canonicalSessionName(team, handle)) fail("session_identity_mismatch", "stored session is not this durable seat's exact session");
  if (row.status === "pending" || row.launch_token) fail("launch_in_progress", "seat launch is in progress");
  return row;
}

function render(verb: "up" | "down", options: SeatOptions, fields: Record<string, unknown>): void {
  const disposition = lifecycleDisposition("seat", verb);
  if (!disposition.ok) fail(disposition.errorClass, disposition.detail);
  const receipt = { ok: true, verb, ...lifecycleReceipt(disposition), ...fields };
  // Synchronous fd write matters when this command is stopping its own session.
  const crews = Array.isArray(fields.crews) && fields.crews.length ? ` (owned crew: ${fields.crews.join(", ")})` : "";
  writeSync(1, options.json ? `${JSON.stringify(receipt)}\n` : `tap ${verb}: ${fields.team}/${fields.handle} ${fields.outcome}${crews}\n`);
}

function selectionFor(options: SeatOptions): { selection: Selection; handle: string } {
  const parsed = parseTarget(options.target);
  if (parsed.qualified && options.team) fail("selector_conflict", "pass --team OR a qualified seat, not both");
  const selection = selectCaller({ cwd: process.cwd(), explicitTeam: parsed.qualified ? parsed.team : options.team, verbClass: "lifecycle" });
  return { selection, handle: parsed.handle };
}

/** The environment a seat-up launch runs under; the dry run probes through the same one. */
const upEnv = (selection: Selection): NodeJS.ProcessEnv => ({ ...childBusEnv(selection.busHome), TMUX: `${physicalSocketPath()},0,0`, TMUX_PANE: undefined });

export async function cmdSeatUpDown(verb: "up" | "down", argv: string[], scriptDir: string): Promise<number> {
  let options: SeatOptions | undefined;
  try {
    options = parseSeatOptions(argv);
    return verb === "up" ? await withStartupTrace(() => withLaunchSignals(signal => executeSeatUpDown(verb, options!, scriptDir, signal)), undefined, scriptDir)
      : await executeSeatUpDown(verb, options, scriptDir);
  } catch (error) {
    if (error instanceof LaunchInterrupted) return error.exitCode;
    // A typed transaction refusal keeps its class and recovery action; one with no class is still an operation failure.
    const typed = error instanceof TransactionError && error.tapErrorClass ? new TapError(1, error.tapErrorClass, error.tapAction ?? "tap help up",
      error.message.slice(error.tapErrorClass.length + 2)) : error;
    const known = typed instanceof TapError || typed instanceof SelectorError;
    const detail = typed instanceof TapError ? typed.detail : typed instanceof Error ? typed.message : String(typed);
    if (argv.includes("--json")) {
      writeSync(options?.selfReported ? 2 : 1, JSON.stringify({ ok: false, verb, error_class: known ? typed.errorClass : "operation_failed",
        ...(typed instanceof TapError ? { action: typed.action } : {}), detail }) + "\n");
      return 1;
    }
    if (typed instanceof SelectorError) throw new TapError(typed.code, typed.errorClass, typed.action, typed.detail);
    throw typed;
  }
}

async function executeSeatUpDown(verb: "up" | "down", options: SeatOptions, scriptDir: string, signal?: AbortSignal): Promise<number> {
  const { selection, handle } = selectionFor(options);
  const resetLock = acquireResetMutationLock(selection.busHome, `tap ${verb}`, undefined, "shared");
  let row: Seat;
  try {
    const lock = acquireRegistryLock(selection.registryLocation);
    if (!lock) fail("registry_busy", "could not obtain the selected registry lock");
    try {
      assertSelectionCurrent(selection, lock);
      const doc = loadRegistry(selection.registryLocation);
      const refusal = registryWriteRefusal(selection.registryLocation, doc);
      if (refusal) throw new TapError(1, refusal.errorClass, refusal.action, refusal.detail);
      const seats = seatMap(doc);
      row = validateDurable(seats[handle], handle, selection.team, verb);
      if (options.skipQuiesce && (verb !== "down" || row.opencode_server_mode !== "shared")) fail("usage_error", "--skip-quiesce applies only to tap down for a shared OpenCode seat");
      if (verb === "down") refuseSharedSelfStop([[handle, row]], "tap down");
      else assertSharedStopCleared(selection.rootReal, row);
      const disposition = lifecycleDisposition("seat", verb);
      if (!disposition.ok) fail(disposition.errorClass, disposition.detail);
      const snapshot = seatSnapshot();
      const pane = verb === "down" ? liveOwnerSeat(seats, handle, snapshot) : liveSeat(row, String(row.session), snapshot);
      const fields = { team: selection.team, handle, session: row.session, instance: row.instance };
      if (disposition.row.registry === "resume-rows" && disposition.row.tmux === "relaunch") {
        if (pane) {
          if (row.status !== "active" || row.status_reason) fail("seat_not_ready", "session exists but its row is not ready; inspect it before resuming");
          render(verb, options, { ...fields, outcome: "already_live" });
          return 0;
        }
        if (options.dryRun) {
          if (!row.harness_session_id) fail("resume_identity_missing", "seat has no stored native conversation identity");
          // Read-only: the launch transaction's own validation, then the native-id uniqueness check the real run takes under this lock.
          await validateSeatUp(selection, handle, row, doc, upEnv(selection), scriptDir);
          render(verb, options, { ...fields, outcome: "would_resume" });
          return 0;
        }
        // The adapter reacquires the reset/registry transaction and compares this
        // complete row before claiming. Never hold the registry lock over launch.
      } else {
        if (disposition.row.registry !== "suspend-rows" || !tmuxFateStopsNamedSession(disposition.row)) fail("lifecycle_fate_invalid", "no power-state owner for this fate");
        const crews = disposition.row.crews === "consume-d-contract" ? ownedCrewRows(seats, handle) : [];
        if (!pane && crews.length === 0) {
          const stopped = options.dryRun ? { quiesced: true } : quiesceSharedSession(row, selection.rootReal, handle, { skip: options.skipQuiesce });
          if (!options.dryRun && row.opencode_server_mode === "shared") {
            row.status = "suspended"; row.status_reason = stopped.quiesced ? "session_stopped" : "unquiesced";
            markResetGenerationReused(selection.busHome, "tap down"); saveRegistry(selection.registryLocation, doc);
          }
          render(verb, options, { ...fields, outcome: stopped.quiesced ? "already_stopped" : "unquiesced", crews: [] });
          return 0;
        }
        for (const [name, other] of Object.entries(seats)) {
          if (name === handle || other.delivery === "poll") continue;
          const sharesSession = other.session === row.session || snapshot.panes.some(p => p.id === other.pane_id && p.session === row.session);
          if (sharesSession && !crews.includes(name)) {
            fail("shared_durable_session", `seat '${name}' shares this session; use the team lifecycle command`);
          }
        }
        if (options.dryRun) {
          render(verb, options, { ...fields, outcome: "would_stop", crews });
          return 0;
        }
        const crewProofs = crews.flatMap(crew => {
          fenceCrewLifetime({ team: selection.team, registryPath: selection.registryLocation }, crew, seats[crew]);
          const proof = captureCrewProcess(selection.team, crew, seats[crew]!);
          return proof ? [proof] : [];
        });
        const stopped = quiesceSharedSession(row, selection.rootReal, handle, { skip: options.skipQuiesce });
        for (const crew of crews) quiesceSharedSession(seats[crew]!, selection.rootReal, crew);
        if (crews.length) {
          writeSync(2, `tap down: removing owned crew ${crews.join(", ")}; any unsettled crew mail remains on the bus without a recipient. Hand off work before down; this command does not transfer or settle it.\n`);
        }
        const original = structuredClone(row);
        const originals = new Map(crews.map(h => [h, seats[h]!]));
        const caller = observeCallerIdentity();
        const callerPane = caller.state === "inside" && (!caller.selectedSocket || caller.selectedSocket === physicalSocketPath()) ? caller.paneId : "";
        const callingCrews = crewProofs.filter(proof => proof.crewPane === callerPane);
        const deferred = callingCrews.filter(proof => !pane || proof.crewSession !== pane.session);
        const self = deferred.length > 0 || (!!pane && callerPane !== "" &&
          snapshot.panes.some(p => p.id === callerPane && p.sessionId === pane.sessionId));
        row.status = "suspended";
        row.status_reason = stopped.quiesced ? "session_stopped" : "unquiesced";
        for (const crew of crews) delete seats[crew];
        markResetGenerationReused(selection.busHome, "tap down");
        saveRegistry(selection.registryLocation, doc);
        if (self) {
          render(verb, options, { ...fields, outcome: "stop_requested", crews });
          options.selfReported = true;
        }
        // A timeout can have acted: leave the row suspended and never retry.
        for (const proof of crewProofs.filter(proof => !callingCrews.includes(proof))) {
          const result = stopCrewProcess(proof);
          if (result.outcome !== "stopped") {
            seats[handle] = original;
            for (const [crew, old] of originals) seats[crew] = old;
            saveRegistry(selection.registryLocation, doc);
            fail("crew_stop_unverified", `crew '${proof.crew}' stop is ${result.outcome}; rows restored; inspect partial effects`);
          }
        }
        const result = pane ? stopExactPane(pane) : { code: 0, stderr: "", stdout: "" };
        const after = seatSnapshot();
        if (pane && after.panes.some(p => p.sessionId === pane.sessionId && p.rawEpoch === pane.rawEpoch)) {
          seats[handle] = original;
          for (const [crew, old] of originals) seats[crew] = old;
          saveRegistry(selection.registryLocation, doc);
          fail("stop_failed", result.stderr.trim() || result.stdout.trim() || "session survived; registry restored");
        }
        if (!self) render(verb, options, { ...fields, outcome: stopped.quiesced ? "stopped" : "pane_stopped_unquiesced", crews });
        for (const proof of deferred) {
          const result = stopCrewProcess(proof);
          if (result.outcome !== "stopped") fail("crew_stop_unverified", result.detail);
        }
        return 0;
      }
    } finally { lock.release(); }
  } finally { resetLock.release(); }
  // The selection holds above have ended. One native coordinator now owns the
  // entire claim/run/ready/unwind window on this explicitly selected server.
  await resumeSelectedSeat(selection, handle, row!, upEnv(selection), signal, scriptDir);
  render(verb, options, { team: selection.team, handle, session: row!.session, outcome: "resumed" });
  return 0;
}

if (import.meta.main) {
  const [verb, ...args] = process.argv.slice(2);
  if (verb !== "up" && verb !== "down") throw new Error("expected up or down");
  try { process.exitCode = await cmdSeatUpDown(verb, args, tapScriptsDir()); }
  catch (error) {
    process.stderr.write(`tap ${verb}: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
