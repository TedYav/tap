import { loadGlobalRegistry, resolveTeamFromDoc } from "./index-home";
import { teamRegistryRefusal } from "./register-authority";
import { noMachineIndexError, TapError } from "./context";
import { pyReadUtf8 } from "./spool-publication";
import { observe, type RegistryRow } from "./team-observe";
import { pick, displayText, type PickOptions, type PickerChoice, type PickResult } from "./fzf";
import { validToken } from "./ids";
import { isDaemon } from "./verbs/team";
import { tapScriptsDir } from "./scripts-dir";

export interface PickerIdentity {
  instance: string; pane: string; paneId: string; session: string; serverEpoch: string;
  serverSocket: string; bootId: string; registeredAt: string; observedPane: string; observedPaneId: string;
}
export interface PickerSeat { handle: string; harness: string; session: string; crew: boolean; identity?: PickerIdentity }
export interface PickerTeam { name: string; state: string; detail: string; seats: PickerSeat[]; root?: string; registry?: string }
export interface PickerSelection { target: string; team: string; handle: string; root: string; registry: string; identity: PickerIdentity }
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string => typeof v === "string" ? v : "";
const safe = displayText;

/** One index and tmux snapshot; the final attach still revalidates the selected seat. */
export function pickerModel(env = process.env, inspect: typeof observe = observe): { teams: PickerTeam[]; observable: boolean } {
  const snapshot = loadGlobalRegistry(env.TAP_INDEX_HOME);
  if (snapshot.marker === "invalid") throw new TapError(1, "invalid_flip", "tap doctor", "invalid machine registry");
  if (snapshot.marker === "absent") throw noMachineIndexError();
  const index = snapshot.doc;
  const members = object(index?.teams) ? index.teams : {};
  const pending: { team: PickerTeam; seat: PickerSeat; row: RegistryRow }[] = [];
  const teams: PickerTeam[] = [];
  // Teams with zero non-daemon candidates are byte-proven seatless: the
  // classifier has nothing to be UNKNOWN about, so they never ride the
  // unobservable exception below.
  const candidates = new Map<PickerTeam, number>();
  for (const name of Object.keys(members).sort()) {
    if (!validToken(name)) continue;
    const meta = members[name]; if (!object(meta)) continue;
    const team: PickerTeam = { name, state: "ok", detail: "", seats: [] };
    teams.push(team);
    if (meta.state === "historical") { team.state = "historical"; team.detail = "no live seats"; continue; }
    if (!text(meta.root)) { team.state = "no_root"; team.detail = "index entry names no worktree"; continue; }
    const found = resolveTeamFromDoc(snapshot.doc!, name);
    if (found.status !== "ok") { team.state = "unreachable"; team.detail = "acting registry unreachable"; continue; }
    const path = found.registryLocation;
    team.root = found.root; team.registry = path;
    let registry: unknown;
    try { registry = JSON.parse(pyReadUtf8(path)); }
    catch (error) {
      team.state = error instanceof SyntaxError ? "corrupt" : "unreadable";
      team.detail = error instanceof SyntaxError ? "acting registry is not valid JSON" : "acting registry cannot be read";
      continue;
    }
    const oldStore = teamRegistryRefusal(path, registry);
    if (oldStore) { team.state = "old_store"; team.detail = oldStore.detail; continue; }
    const seats = object(registry) ? registry.seats : null;
    if (!object(seats)) { team.state = "corrupt"; team.detail = "acting registry has no seat map"; continue; }
    for (const handle of Object.keys(seats).sort()) {
      if (!validToken(handle)) continue;
      const row = seats[handle];
      // The roster's daemon predicate: poll members and daemon-harness rows
      // are pane-less infrastructure and never attachable.
      if (!object(row) || isDaemon(row)) continue;
      candidates.set(team, (candidates.get(team) ?? 0) + 1);
      const session = text(row.session) || text(row.pane).split(":", 1)[0] || "";
      pending.push({ team, seat: { handle, session, harness: text(row.harness), crew: row.crew === true || row.crew === 1,
        identity: { instance: text(row.instance), pane: text(row.pane), paneId: text(row.pane_id), session: text(row.session),
          serverEpoch: text(row.server_epoch), serverSocket: text(row.server_socket), bootId: text(row.boot_id),
          registeredAt: text(row.registered_at), observedPane: "", observedPaneId: "" } },
        row: { ...row, team: name, handle: String(pending.length), status: row.status ?? "active", delivery: row.delivery || "pane" } as RegistryRow });
    }
  }
  const observed = pending.length ? inspect(pending.map(item => item.row), tapScriptsDir())
    : { code: 0, rows: new Map<string, string[]>(), serverEpoch: "" };
  for (let i = 0; i < pending.length; i++) {
    const item = pending[i]!;
    const record = observed.rows.get(String(i));
    if (record?.[0] === "active") {
      item.seat.identity!.observedPane = record[2] ?? "";
      item.seat.identity!.observedPaneId = record[3] ?? "";
      item.team.seats.push(item.seat);
    }
  }
  if (observed.code !== 0) for (const team of teams) if (team.state === "ok" && (candidates.get(team) ?? 0) > 0) {
    team.state = "unobservable"; team.detail = "seat classifier could not observe this team";
  }
  return { teams, observable: observed.code === 0 };
}

export function seatRow(seat: PickerSeat, team: string): string {
  const session = seat.session !== `${team}/${seat.handle}` ? `  ${safe(seat.session)}` : "";
  return `${safe(seat.handle)}  ${safe(seat.harness)}${session}${seat.crew ? " (crew)" : ""}`;
}

export type Choose = <T>(choices: PickerChoice<T>[], options: PickOptions) => Promise<PickResult<T>>;

export interface AttachPickerQuery { team?: string; teamQuery?: string; seatQuery?: string }

/** A scoped miss skips the team stage; an unknown team seeds that stage. */
export async function chooseAttachSelection(model: ReturnType<typeof pickerModel>, choose: Choose = pick,
  query: AttachPickerQuery = {}): Promise<PickResult<PickerSelection>> {
  let team = query.team ? model.teams.find(candidate => candidate.name === query.team) : undefined;
  if (query.team && !team) throw new TapError(1, "selection_changed", "tap teams --all", `team '${query.team}' left the machine index before selection`);
  if (!team) {
    // A live-seat fleet filter: only teams holding at least one live seat are
    // offered. An unobservable team stays visible, because a probe that could
    // not run is UNKNOWN, never GONE; every other diagnosis means no live seat
    // can be confirmed for that team.
    const offered = model.teams.filter(candidate =>
      candidate.state === "ok" ? candidate.seats.length > 0 : candidate.state === "unobservable");
    if (!offered.length) throw new TapError(1, "no_candidates",
      "tap teams --all   (diagnostics)   ·   tap session launch <preset|harness> <handle>   (start a seat)",
      "no team has a live attachable seat — daemon and pane-less infrastructure rows never count");
    const teamResult = await choose(offered.map((candidate, i) => ({ id: String(i), value: candidate,
      label: `${safe(candidate.name)}  ${candidate.state === "ok" ? `${candidate.seats.length} live seats` : `${safe(candidate.state)}: ${safe(candidate.detail)}`}` })),
      { verb: "attach", query: query.teamQuery, prompt: "Team > ", header: "Pick a team · Type to search · Enter select · Esc cancel" });
    if (teamResult.kind !== "selected") return teamResult;
    team = teamResult.values[0]!;
  }
  if (team.state !== "ok") throw new TapError(1, "team_unavailable", "tap teams / tap doctor", `${team.name}: ${team.state} — ${team.detail}`);
  if (!team.seats.length) throw new TapError(1, "no_candidates", "tap team / tap session resume <seat>", `${team.name} has no live attachable seats`);
  const selected = await choose(team.seats.map((seat, i) => ({ id: String(i), label: seatRow(seat, team.name), value: `${team.name}/${seat.handle}` })),
    { verb: "attach", query: query.seatQuery, prompt: `${safe(team.name)} > `, header: "Pick a seat · Type to search · Enter attach · Esc cancel" });
  if (selected.kind !== "selected") return selected;
  const target = selected.values[0]!;
  const seat = team.seats.find(row => `${team.name}/${row.handle}` === target)!;
  return { kind: "selected", values: [{ target, team: team.name, handle: seat.handle,
    root: team.root ?? "", registry: team.registry ?? "", identity: seat.identity ?? {
      instance: "", pane: "", paneId: "", session: seat.session, serverEpoch: "", serverSocket: "",
      bootId: "", registeredAt: "", observedPane: "", observedPaneId: "",
    } }] };
}

/** Compatibility projection for callers that only display the canonical target. */
export async function chooseAttachTarget(model: ReturnType<typeof pickerModel>, choose: Choose = pick): Promise<PickResult<string>> {
  const result = await chooseAttachSelection(model, choose);
  return result.kind === "selected" ? { kind: "selected", values: result.values.map(row => row.target) } : result;
}

export interface AttachPickerEffects {
  model: () => ReturnType<typeof pickerModel>;
  choose: Choose;
  attach?: (target: string) => number;
}
export async function runPicker(argv: string[], scriptsDir = tapScriptsDir(),
  effects?: AttachPickerEffects, query: AttachPickerQuery = {}): Promise<number> {
  if (argv.length) throw new TapError(1, "usage_error", "tap attach --interactive", "interactive picker takes no target or competing selector");
  // Refuse before the model's observations, including when no teams exist.
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === "dumb" || process.env.TAP_JSON === "1") {
    throw new TapError(1, "no_terminal", "tap attach <team/handle>", "interactive picker needs a terminal and human output");
  }
  const result = await chooseAttachSelection(effects ? effects.model() : pickerModel(), effects?.choose, query);
  if (result.kind === "interrupted") return 130;
  if (result.kind === "cancelled") { console.log("tap attach: picker closed without selecting a seat"); return 0; }
  if (effects?.attach) return effects.attach(result.values[0]!.target);
  const { attachSelected } = await import("./verbs/attach");
  return attachSelected(result.values[0]!, scriptsDir);
}

if (import.meta.main) {
  try { process.exitCode = await runPicker(process.argv.slice(2)); }
  catch (error) {
    if (error instanceof TapError && process.env.TAP_JSON === "1") console.log(JSON.stringify({ ok: false, error_class: error.errorClass, action: error.action, detail: error.detail }));
    else console.error(`tap attach: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof TapError ? error.code : 1;
  }
}
