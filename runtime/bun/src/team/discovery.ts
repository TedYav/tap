import { crewFamilyHandles } from "../crew-ownership";
import type { CrewProcess } from "../crew-lifetime";
import { TapError, resolveContext, type ResolvedContext } from "../context";
import { loadGlobalRegistry, resolveTeamFromDoc } from "../index-home";
import { validToken } from "../ids";
import type { Seat } from "../registry";
import { pyReadUtf8 } from "../spool-publication";
import { isMap, loads } from "../watch-detect";
import { teamRegistryRefusal } from "../register-authority";
import { isFile } from "../watch-lease";
import { codePointCompare, type Selection } from "./selection";
import { captureParentHarnessLifetime, validateParentHarnessLifetime, type ParentHarnessLifetime } from "../crew-lifetime";

export interface Choice<T> { id: string; label: string; value: T }
export interface Picker {
  <T>(choices: Choice<T>[], options: { verb: string; query?: string; multi?: boolean; prompt?: string; header?: string }):
    Promise<{ kind: "selected"; values: T[] } | { kind: "cancelled" } | { kind: "interrupted" }>;
}

export type DiscoveryResult<T> = { kind: "selected"; value: T } | { kind: "cancelled" } | { kind: "interrupted" };

/** Refuse UI before touching stdin. The picker owns the foreground-terminal check. */
export function discoveryTerminalAvailable(json = false): boolean {
  return !json && process.env.TAP_JSON !== "1" && process.stdin.isTTY === true
    && process.stdout.isTTY === true && process.env.TERM !== "dumb";
}

export function requireDiscoveryTerminal(verb: string, example: string, json = false): void {
  if (!discoveryTerminalAvailable(json)) {
    throw new TapError(1, "target_required", example,
      `tap ${verb} needs a target here; pass ${example} explicitly (interactive picker requires a terminal and non-JSON output)`,
      `tap ${verb}`);
  }
}

export interface BoundTeam {
  team: string;
  root: string;
  registryPath: string;
  context: ResolvedContext;
}

/** Re-read exact authority after the UI; index churn cannot retarget a choice. */
export function revalidateTeam(bound: BoundTeam): ResolvedContext {
  const current = resolveContext(process.cwd(), process.env, { explicitTeam: bound.team, readOnly: true });
  if (current.root !== bound.root || current.registryPath !== bound.registryPath) {
    throw new TapError(1, "target_changed", `retry tap team ${bound.team}`,
      `team '${bound.team}' changed enrollment while a target was being selected`, "tap team");
  }
  return current;
}

/** Candidate discovery is a single guarded, read-only index snapshot. */
export function discoverTeams(): Array<{ team: string; root: string; registryPath: string }> {
  const snapshot = loadGlobalRegistry();
  if (snapshot.marker === "invalid") {
    throw new TapError(1, "invalid_flip", "tap doctor", "global-registry.json is present but unusable", "tap team");
  }
  if (snapshot.marker === "absent" || !snapshot.doc) {
    throw new TapError(1, "unanchored_bus", "tap team <team>", "no machine index is available for team discovery", "tap team");
  }
  const entries = snapshot.doc.teams;
  if (typeof entries !== "object" || entries === null || Array.isArray(entries)) return [];
  return Object.keys(entries).filter(validToken).sort().flatMap(team => {
    const resolved = resolveTeamFromDoc(snapshot.doc!, team);
    return resolved.status === "ok" ? [{ team, root: resolved.root, registryPath: resolved.registryLocation }] : [];
  });
}

/** Exact callers invoke this only for a permitted target miss or absent required team. */
export async function chooseTeam(verb: string, query: string | undefined, picker: Picker, json = false): Promise<DiscoveryResult<BoundTeam>> {
  if (process.env.TAP_TEAM_SELECT || (process.env.TAP_HOME && ["", "env"].includes(process.env.TAP_BUS_RULE ?? ""))) {
    throw new TapError(1, "target_conflict", `pass an exact team to tap ${verb}`,
      "caller team or bus is pinned; refusing to replace an unresolved target through discovery", `tap ${verb}`);
  }
  requireDiscoveryTerminal(verb, `tap ${verb} <team>`, json);
  const offered = discoverTeams();
  if (offered.length === 0) {
    throw new TapError(1, "not_found", "tap team list", "no reachable enrolled team is available to select", `tap ${verb}`);
  }
  const result = await picker(offered.map((item, index) => ({
    id: String(index), label: `${item.team}  ${item.root}`, value: item,
  })), { verb, query, prompt: "team> ", header: "Choose a team; Enter selects, Esc cancels" });
  if (result.kind !== "selected") return result;
  if (result.values.length !== 1) throw new TapError(1, "picker_invalid", `retry tap ${verb}`, "picker returned no unique team", `tap ${verb}`);
  const selected = result.values[0]!;
  const context = resolveContext(process.cwd(), process.env, { explicitTeam: selected.team, readOnly: true });
  if (context.root !== selected.root || context.registryPath !== selected.registryPath) {
    throw new TapError(1, "target_changed", `retry tap ${verb}`, `team '${selected.team}' changed enrollment during selection`, `tap ${verb}`);
  }
  return { kind: "selected", value: { team: selected.team, root: selected.root, registryPath: selected.registryPath, context } };
}

export interface BoundSeat { handle: string; instance: string; session: string; paneId: string; serverEpoch: string; status?: string; delivery?: string }
export interface CrewInstance { instance: string; session: string; paneId?: string; serverEpoch?: string; owner?: string; ownerInstance?: string }
export interface BoundCohort { team: BoundTeam; seats: Map<string, BoundSeat>; selection: Selection; original: Selection; restartRows?: Map<string, Seat>; parentLifetimes?: Map<string, ParentHarnessLifetime>; crewAtSelection?: Map<string, CrewInstance>; approvedCrewAtConsent?: Map<string, CrewInstance>; approvedCrewProcesses?: Map<string, CrewProcess | null> }

function field(row: Seat, key: string): string { return typeof row[key] === "string" ? row[key] as string : ""; }

/** Read only named row fields without rounding unrelated wide-number extensions. */
export function readDiscoverySeats(path: string): Record<string, Seat> {
  if (!isFile(path)) throw new TapError(1, "registry_unreachable", "tap doctor", "acting registry is not a readable file", "tap team");
  let document: ReturnType<typeof loads>;
  try { document = loads(pyReadUtf8(path)); }
  catch (error) { throw new TapError(1, "registry_invalid", "tap doctor", `acting registry unreadable: ${String(error)}`, "tap team"); }
  if (!isMap(document)) throw new TapError(1, "registry_invalid", "tap doctor", "acting registry root is not an object", "tap team");
  const old = teamRegistryRefusal(path, document);
  if (old) throw new TapError(1, old.errorClass, old.action, old.detail, "tap team");
  const rows = document.get("seats");
  if (!isMap(rows)) throw new TapError(1, "registry_invalid", "tap doctor", "acting registry has no seats map", "tap team");
  const result: Record<string, Seat> = Object.create(null);
  for (const [handle, value] of rows) {
    if (!isMap(value)) throw new TapError(1, "registry_invalid", "tap doctor", `seat '${handle}' is not a row`, "tap team");
    result[handle] = Object.fromEntries(value);
  }
  return result;
}

/** Registry rows are read from the exact selected team, with no display handler effects. */
export function parentSeatSnapshot(team: BoundTeam): BoundSeat[] {
  revalidateTeam(team);
  const seats = readDiscoverySeats(team.registryPath);
  return Object.keys(seats).sort(codePointCompare).flatMap(handle => {
    const row = seats[handle];
    if (!row || row.crew === true) return [];
    const instance = field(row, "instance");
    if (!instance) throw new TapError(1, "target_unbound", "tap team doctor",
      `seat '${handle}' has no instance; interactive approval cannot bind it`, "tap team");
    return [{ handle, instance, session: field(row, "session"), paneId: field(row, "pane_id"), serverEpoch: field(row, "server_epoch"),
      status: field(row, "status"), delivery: field(row, "delivery") }];
  });
}

export function assertBoundSeats(bound: BoundCohort, current: Record<string, Seat>): void {
  for (const seat of bound.seats.values()) {
    const row = current[seat.handle];
    if (!row || field(row, "instance") !== seat.instance || field(row, "session") !== seat.session
      || field(row, "pane_id") !== seat.paneId || field(row, "server_epoch") !== seat.serverEpoch) {
      throw new TapError(1, "target_changed", `retry tap team ${bound.team.team}`,
        `seat '${seat.handle}' changed identity after selection; refusing to substitute its replacement`, "tap team");
    }
  }
}

/** Action owners may strip pane coordinates; the row instance must still be the selected one. */
export function assertBoundInstances(bound: BoundCohort, current: Record<string, Seat>): void {
  for (const seat of bound.seats.values()) {
    const row = current[seat.handle];
    if (!row || field(row, "instance") !== seat.instance) {
      throw new TapError(1, "target_changed", `retry tap team ${bound.team.team}`,
        `seat '${seat.handle}' was replaced after selection; refusing to act on its replacement`, "tap team");
    }
  }
}

/** A reused row/pane cannot inherit approval after its foreground harness relaunches. */
export function assertBoundParentLifetimes(bound: BoundCohort): void {
  for (const [handle, lifetime] of bound.parentLifetimes ?? []) {
    if (!validateParentHarnessLifetime(lifetime)) {
      throw new TapError(1, "target_changed", `retry tap team ${bound.team.team}`,
        `parent '${handle}' harness process changed after selection`, "tap team");
    }
  }
}

function crewSessions(rows: Record<string, Seat>): Set<string> {
  return new Set(Object.entries(rows).filter(([handle, row]) => row?.crew !== true && crewFamilyHandles(rows, handle).length > 0)
    .map(([, row]) => field(row, "session")).filter(Boolean));
}

function crewInstances(rows: Record<string, Seat>): Map<string, CrewInstance> {
  return new Map(Object.entries(rows).filter(([, row]) => row?.crew === true)
    .map(([handle, row]) => [handle, { instance: field(row, "instance"), session: field(row, "session"), paneId: field(row, "pane_id"), serverEpoch: field(row, "server_epoch"), owner: field(row, "crew_owner"), ownerInstance: field(row, "crew_owner_instance") }]));
}

export function captureCohortParentLifetimes(bound: BoundCohort): void {
  const lifetimes = new Map<string, ParentHarnessLifetime>();
  const rows = readDiscoverySeats(bound.team.registryPath);
  const ownedSessions = crewSessions(rows);
  for (const seat of bound.seats.values()) {
    if (seat.delivery === "poll" || seat.status !== "active" || !ownedSessions.has(seat.session)) continue;
    lifetimes.set(seat.handle, captureParentHarnessLifetime(bound.team.context, seat.handle));
  }
  bound.parentLifetimes = lifetimes;
  bound.crewAtSelection = crewInstances(rows);
}

/** Picker-selected handles become a finite positive set. A late parent stays spared. */
export async function chooseSeatCohort(
  verb: string, team: BoundTeam, mode: "--only" | "--except", picker: Picker, json = false, captureParents = false,
): Promise<DiscoveryResult<BoundCohort>> {
  requireDiscoveryTerminal(verb, `tap ${verb} ${team.team} ${mode} <h,...>`, json);
  const offered = parentSeatSnapshot(team);
  const parentLifetimes = new Map<string, ParentHarnessLifetime>();
  const initialRows = captureParents ? readDiscoverySeats(team.registryPath) : undefined;
  const ownedSessions = initialRows ? crewSessions(initialRows) : new Set<string>();
  if (captureParents) for (const row of offered) {
    if (row.delivery === "poll" || row.status !== "active" || !ownedSessions.has(row.session)) continue;
    try { parentLifetimes.set(row.handle, captureParentHarnessLifetime(team.context, row.handle)); }
    catch { /* An unprovable candidate is refused if selected, without hiding others. */ }
  }
  if (offered.length === 0) throw new TapError(1, "not_found", `tap team roster ${team.team}`,
    `team '${team.team}' has no parent seats eligible for ${mode}`, `tap ${verb}`);
  const picked = await picker(offered.map((value, index) => ({
    id: String(index), label: `${value.handle}  ${value.session || "poll/no session"}`, value,
  })), { verb, multi: true, prompt: mode === "--only" ? "act on> " : "spare> ",
    header: mode === "--only" ? "Choose parents to act on (crews follow their parent)" : "Choose parents to spare (crews follow their parent)" });
  if (picked.kind !== "selected") return picked;
  const allowed = new Map(offered.map(row => [row.handle, row]));
  const chosen = new Set(picked.values.map(row => row.handle));
  if (chosen.size !== picked.values.length || [...chosen].some(handle => !allowed.has(handle))) {
    throw new TapError(1, "picker_invalid", `retry tap ${verb}`, "picker returned a duplicate or unoffered seat", `tap ${verb}`);
  }
  const selected = offered.filter(row => mode === "--only" ? chosen.has(row.handle) : !chosen.has(row.handle));
  const original: Selection = mode === "--only"
    ? { mode, only: [...chosen], except: [] }
    : { mode, except: [...chosen], only: [] };
  const selection: Selection = { mode: "--only", only: selected.map(row => row.handle), except: [] };
  const cohort: BoundCohort = { team, seats: new Map(selected.map(row => [row.handle, row])), selection, original };
  if (captureParents) {
    cohort.crewAtSelection = crewInstances(initialRows!);
    const currentCrewSessions = crewSessions(readDiscoverySeats(team.registryPath));
    for (const row of selected) {
      if (row.delivery !== "poll" && row.status === "active" && currentCrewSessions.has(row.session)
        && !parentLifetimes.has(row.handle)) {
        throw new TapError(1, "target_unbound", "tap team doctor",
          `parent '${row.handle}' has no provable foreground harness lifetime`, `tap ${verb}`);
      }
    }
    cohort.parentLifetimes = new Map([...parentLifetimes].filter(([handle]) => cohort.seats.has(handle)));
    assertBoundParentLifetimes(cohort);
  }
  assertBoundSeats(cohort, readDiscoverySeats(team.registryPath));
  return { kind: "selected", value: cohort };
}

/** Only an explicit yes or empty Enter consents. EOF and every other answer decline. */
export async function confirmAction(): Promise<boolean> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return await new Promise<boolean>(resolve => {
    let answered = false;
    rl.once("close", () => { if (!answered) resolve(false); });
    rl.question("Proceed? [Y/n] ", answer => { answered = true; rl.close(); resolve(answer === "" || /^[Yy]$/.test(answer)); });
  });
}
