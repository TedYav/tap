import { writeSync } from "node:fs";
import { TapError } from "../context";
import { registryWriteRefusal } from "../register-authority";
import { acquireRegistryLock } from "../panelock";
import { acquireResetMutationLock, markResetGenerationReused } from "../reset";
import { atomicWrite } from "../fsatomic";
import { loadRegistry, pyJson, seatMap } from "../registry";
import { assertSelectionCurrent, parseTarget, selectCaller, SelectorError } from "../selector";

const VERB = "incapable";
const PAIR = "suspended/incapable";

// The manual door for "this seat's human is present but cannot work right now".
// It is a registry-only mutation: no pane is probed, killed or resumed, and the
// pane keeps running. Exactly two row values change — `status` becomes
// "suspended" and `status_reason` becomes "incapable" — so every unrelated
// value, row and forwarding alias round-trips untouched. Registration is the
// reverse door: it restores "active" with an empty reason on the same instance.
interface Options { target: string; team?: string; json: boolean }

function fail(errorClass: string, detail: string): never {
  throw new TapError(1, errorClass, `tap help ${VERB}`, detail);
}

function parseOptions(argv: string[]): Options {
  const options: Options = { target: "", json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") options.json = true;
    else if (arg === "--team") {
      if (options.team !== undefined || !argv[i + 1] || argv[i + 1]!.startsWith("-")) fail("usage_error", "--team needs one team name");
      options.team = argv[++i];
    } else if (arg.startsWith("-") || options.target) fail("usage_error", `unexpected argument '${arg}'`);
    else options.target = arg;
  }
  if (!options.target) fail("usage_error", "name one seat to mark incapable");
  return options;
}

/**
 * The narrow validator. This is deliberately NOT validateDurable: that one
 * demands a canonical live session for up/down, while this verb's whole point
 * is a seat that stays exactly where it is. Everything it cannot read as "an
 * active (or legacy-active) pane seat" refuses with the stored state named.
 */
function validateMarkable(row: unknown, handle: string, team: string): { record: Record<string, unknown>; instance: unknown; already: boolean } {
  if (row === undefined || row === null) {
    fail("not_found", `unknown seat '${team}/${handle}'; create it with tap session launch`);
  }
  if (typeof row !== "object" || Array.isArray(row)) {
    fail("invalid_row", `seat '${team}/${handle}' has an unreadable registry row (${typeof row})`);
  }
  const record = row as Record<string, unknown>;
  // Legacy writers serialized the flag as 1; the shared lifecycle readers
  // (launcher/complete, launcher/relaunch) treat true and 1 alike.
  if (record.crew === true || record.crew === 1) fail("usage_error", "crew seats are ephemeral; use tap crew remove");
  const delivery = record.delivery;
  if (delivery === "poll") fail("poll_seat", "poll seats have no durable tmux session");
  // Legacy rows may omit delivery (or carry ""); only an exact "pane" says a
  // durable seat. Anything else present fails closed: a mark must never land
  // on a row this verb cannot read.
  if (delivery !== undefined && delivery !== "" && delivery !== "pane") {
    fail("invalid_row", `seat '${team}/${handle}' has an unreadable delivery (${typeof delivery} '${String(delivery)}')`);
  }
  // A pane seat must carry recorded coordinates: the mark's meaning — "this
  // pane is live but its human cannot work it" — and every consumer's
  // re-registration advice point at those coordinates. Stale coordinates are
  // fine (a prior generation is still this seat); absence is not.
  if (typeof record.pane !== "string" || !record.pane || typeof record.pane_id !== "string" || !record.pane_id) {
    fail("invalid_row", `seat '${team}/${handle}' has no stored pane identity (pane, pane_id); only a pane seat with recorded coordinates can be marked incapable`);
  }
  if (record.status === "pending" || record.status_reason === "launching" || record.launch_token) {
    fail("launch_in_progress", "seat launch is in progress");
  }

  const rawStatus = record.status;
  const rawReason = record.status_reason;
  if (rawStatus !== undefined && typeof rawStatus !== "string") fail("invalid_row", `seat '${team}/${handle}' has an unreadable status (${typeof rawStatus})`);
  if (rawReason !== undefined && typeof rawReason !== "string") fail("invalid_row", `seat '${team}/${handle}' has an unreadable status_reason (${typeof rawReason})`);

  const status = rawStatus ?? "active";
  const reason = rawReason ?? "";
  if (status === "suspended" && reason === "incapable") {
    return { record, instance: record.instance, already: true };
  }
  if (status !== "active") {
    fail("seat_not_active", `seat '${team}/${handle}' is ${status}${reason ? ` (${reason})` : ""}, not active; only an active seat can be marked incapable`);
  }
  if (reason) {
    fail("seat_not_active", `seat '${team}/${handle}' is active but carries status_reason '${reason}'; clear it before marking incapable`);
  }
  return { record, instance: record.instance, already: false };
}

function render(options: Options, fields: Record<string, unknown>): void {
  const receipt = { ok: true, verb: VERB, ...fields };
  // Synchronous fd write, same shape as up/down's receipts.
  writeSync(1, options.json ? `${JSON.stringify(receipt)}\n` : `tap ${VERB}: ${fields.team}/${fields.handle} ${fields.outcome} (${PAIR})\n`);
}

function execute(options: Options): number {
  const parsed = parseTarget(options.target);
  if (parsed.qualified && options.team) fail("selector_conflict", "pass --team OR a qualified seat, not both");
  // Exactly down's team-selection authority: the same resolver, the same
  // lifecycle verb class, the same qualified-target rule.
  const selection = selectCaller({ cwd: process.cwd(), explicitTeam: parsed.qualified ? parsed.team : options.team, verbClass: "lifecycle" });
  const resetLock = acquireResetMutationLock(selection.busHome, `tap ${VERB}`, undefined, "shared");
  try {
    const lock = acquireRegistryLock(selection.registryLocation);
    if (!lock) fail("registry_busy", "could not obtain the selected registry lock");
    try {
      assertSelectionCurrent(selection, lock);
      const doc = loadRegistry(selection.registryLocation);
      const refusal = registryWriteRefusal(selection.registryLocation, doc);
      if (refusal) throw new TapError(1, refusal.errorClass, refusal.action, refusal.detail);
      const seats = seatMap(doc);
      const mark = validateMarkable(seats[parsed.handle], parsed.handle, selection.team);
      const fields = { team: selection.team, handle: parsed.handle, instance: mark.instance };
      if (mark.already) {
        render(options, { ...fields, outcome: "already_incapable" });
        return 0;
      }
      mark.record.status = "suspended";
      mark.record.status_reason = "incapable";
      // The reused-generation stamp lands BEFORE the write, like every other
      // registry mutation: a crash between the two leaves the row unmarked.
      markResetGenerationReused(selection.busHome, `tap ${VERB}`);
      // atomicWrite + pyJson, never saveRegistry: the superseding write would
      // flip forwarding-alias custody as a side effect of this unrelated mark.
      atomicWrite(selection.registryLocation, `${pyJson(doc, 0)}\n`);
      render(options, { ...fields, outcome: "marked" });
      return 0;
    } finally { lock.release(); }
  } finally { resetLock.release(); }
}

export function cmdIncapable(argv: string[]): number {
  let options: Options | undefined;
  try {
    options = parseOptions(argv);
    return execute(options);
  } catch (error) {
    const known = error instanceof TapError || error instanceof SelectorError;
    const detail = error instanceof Error ? error.message : String(error);
    if (argv.includes("--json")) {
      writeSync(1, JSON.stringify({ ok: false, verb: VERB, error_class: known ? error.errorClass : "operation_failed", detail }) + "\n");
      return 1;
    }
    if (error instanceof SelectorError) throw new TapError(error.code, error.errorClass, error.action, error.detail);
    throw error;
  }
}
