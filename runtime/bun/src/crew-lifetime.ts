import { spawnSync } from "node:child_process";
// Crew process proofs and transition of pre-independent lifetime helpers.
// Ownership lives in registry links; no new parent-death helper is started.
import { observeProcessHarness, agentFamilies, readProcessTable, parsePsTable } from "./observe";
import { procStartEpoch } from "./reset";
import { bootId, bootIdsMatch, observePaneResult, physicalSocketPath, tmuxSessionNamespace, tmux, tmuxReadOnly } from "./tmux";
import { TapError, type ResolvedContext } from "./context";
import { pyReadUtf8 } from "./spool-publication";
import { isMap, loads } from "./watch-detect";
import { crewFamilyHandles, sameCrewSession } from "./crew-ownership";

const OPTION = "@tap_crew_lifetime";
const TOKEN_OPTION = "@tap_crew_lifetime_token";
const str = (value: unknown): string => typeof value === "string" ? value : "";
type Row = Record<string, unknown>;
const isCrew = (row: Row | undefined): boolean => row?.crew === true || row?.crew === 1 || row?.crew === 1n;

export interface ProcessIdentity { pid: string; start: string; boot: string }
export interface ParentHarnessLifetime {
  team: string;
  owner: string;
  instance: string;
  pane: string;
  session: string;
  serverSocket: string;
  serverEpoch: string;
  process: ProcessIdentity;
  family: string;
}
export interface CrewLifetimeBinding {
  version: 1;
  token: string;
  team: string;
  owner: string;
  ownerInstance: string;
  ownerPane: string;
  ownerSession: string;
  crew: string;
  crewInstance: string;
  crewPane: string;
  crewSession: string;
  serverSocket: string;
  serverEpoch: string;
  parent: ProcessIdentity;
  parentFamily: string;
  child: ProcessIdentity;
  childFamily: string;
  helper: ProcessIdentity;
}

function refuse(detail: string): never {
  throw new TapError(1, "crew_lifetime_unprovable", "inspect the family; use explicit tap crew shutdown for an unbound child", detail);
}
const read = (args: string[]): string => {
  const result = tmuxReadOnly(args);
  return result.code === 0 ? result.stdout.replace(/\n+$/, "") : "";
};
const paneOption = (pane: string, name: string): string => read(["show-options", "-p", "-v", "-t", pane, name]);

/** Read only identity fields without rounding unrelated registry extensions. */
function registryRows(path: string): Record<string, Row> {
  let doc: ReturnType<typeof loads>;
  try { doc = loads(pyReadUtf8(path)); }
  catch (error) { refuse(`acting registry is unreadable: ${error}`); }
  if (!isMap(doc)) refuse("acting registry has no current seats map");
  const seats = doc.get("seats");
  if (!isMap(seats)) refuse("acting registry has no current seats map");
  const out: Record<string, Row> = Object.create(null);
  for (const [handle, value] of seats) {
    if (!isMap(value)) continue;
    const row: Row = {};
    for (const field of ["crew", "crew_owner", "crew_owner_instance", "instance", "pane_id", "session", "server_epoch", "server_socket", "harness"])
      row[field] = value.get(field);
    out[handle] = row;
  }
  return out;
}

/** Presence is three-valued: an unreadable probe never certifies process loss. */
export function processGeneration(identity: ProcessIdentity): "same" | "gone" | "unknown" {
  if (!/^[1-9][0-9]*$/.test(identity.pid) || !identity.start || !identity.boot) return "unknown";
  const boot = bootId();
  const relation = bootIdsMatch(identity.boot, boot);
  if (relation === "mismatch") return "gone";
  if (relation !== "match") return "unknown";
  try { process.kill(Number(identity.pid), 0); }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown";
  }
  const start = procStartEpoch(identity.pid);
  return !start ? "unknown" : start === identity.start ? "same" : "gone";
}

function paneFacts(pane: string): { id: string; session: string; sessionId: string; windowId: string; pid: string; serverEpoch: string; socket: string } | null {
  const result = tmuxReadOnly(["display-message", "-p", "-t", pane,
    "#{pane_id}\t#{session_name}\t#{session_id}\t#{window_id}\t#{pane_pid}\t#{pid}:#{start_time}\t#{socket_path}"]);
  if (result.code !== 0) return null;
  const fields = result.stdout.trimEnd().split("\t");
  const [id, session, sessionId, windowId, pid, rawEpoch, socket] = fields;
  if (fields.length !== 7 || !/^%\d+$/.test(id ?? "") || !session || !/^\$\d+$/.test(sessionId ?? "")
    || !/^@\d+$/.test(windowId ?? "") || !/^[1-9]\d*$/.test(pid ?? "") || !/^\d+:\d+$/.test(rawEpoch ?? "") || !socket) return null;
  return { id: id!, session, sessionId: sessionId!, windowId: windowId!, pid: pid!, serverEpoch: `srv:${rawEpoch}`, socket };
}

function identity(pid: string, boot: string): ProcessIdentity | null {
  const start = procStartEpoch(pid);
  return /^[1-9]\d*$/.test(pid) && start && boot ? { pid, start, boot } : null;
}

function readBinding(pane: string, retired = false): CrewLifetimeBinding | null {
  try {
    const value = JSON.parse(paneOption(pane, OPTION)) as CrewLifetimeBinding;
    if (!value || typeof value !== "object" || value.version !== 1) return null;
    const fields: (keyof CrewLifetimeBinding)[] = ["token", "team", "owner", "ownerInstance", "ownerPane",
      "ownerSession", "crew", "crewInstance", "crewPane", "crewSession", "serverSocket", "serverEpoch",
      "parentFamily", "childFamily"];
    if (fields.some(key => typeof value[key] !== "string" || value[key] === "")
      || !/^[0-9a-f-]{36}$/.test(value.token) || value.crewPane !== pane
      || !/^%\d+$/.test(value.ownerPane) || !/^%\d+$/.test(value.crewPane)
      || (![value.token, ...(retired ? [`retired:${value.token}`] : [])].includes(paneOption(pane, TOKEN_OPTION)))) return null;
    const processFields = [value.parent, value.child, value.helper];
    if (processFields.some(item => !item || typeof item !== "object" || !/^[1-9]\d*$/.test(item.pid)
      || typeof item.start !== "string" || !item.start || typeof item.boot !== "string" || !item.boot)) return null;
    return value;
  } catch { return null; }
}
export const crewLifetimeBinding = readBinding;

function parentIdentity(parent: Row): ProcessIdentity {
  const pane = str(parent.pane_id);
  const observed = observePaneResult(pane);
  if (observed.status !== "ok" || observed.observation?.paneId !== pane || observed.observation.session !== str(parent.session)
    || observed.observation.serverEpoch !== str(parent.server_epoch)) refuse("owner pane or server generation is not current");
  const table = readProcessTable();
  const match = observeProcessHarness(observed.observation!.panePid, table.table, table.ok, agentFamilies());
  if (match.state !== "observed" || !match.pid || match.family !== str(parent.harness)) refuse("actual foreground owner harness is not observable");
  const found = identity(match.pid, bootId());
  if (!found || processGeneration(found) !== "same") refuse("owner process start or boot fingerprint is unreadable");
  return found!;
}

/** Selection captures a harness generation, including a manual foreground child. */
export function captureParentHarnessLifetime(ctx: ResolvedContext, owner: string): ParentHarnessLifetime {
  const all = registryRows(ctx.registryPath);
  const row = all[owner];
  if (!row || isCrew(row) || !str(row.instance) || !str(row.pane_id)) refuse(`parent '${owner}' lacks a current durable instance`);
  const pane = paneFacts(str(row!.pane_id));
  if (!pane || pane.id !== str(row!.pane_id) || pane.session !== str(row!.session)
    || pane.serverEpoch !== str(row!.server_epoch)
    || (str(row!.server_socket) && pane.socket !== str(row!.server_socket))) refuse(`parent '${owner}' pane or server generation is not current`);
  return { team: ctx.team, owner, instance: str(row!.instance), pane: pane!.id, session: pane!.session,
    serverSocket: pane!.socket, serverEpoch: pane!.serverEpoch, process: parentIdentity(row!), family: str(row!.harness) };
}

export function parentLifetimeMatchesRow(lifetime: ParentHarnessLifetime, owner: string, row: Row): boolean {
  return lifetime.owner === owner && !isCrew(row) && str(row.instance) === lifetime.instance
    && str(row.harness) === lifetime.family
    && str(row.pane_id) === lifetime.pane && str(row.session) === lifetime.session
    && str(row.server_epoch) === lifetime.serverEpoch
    && (!str(row.server_socket) || str(row.server_socket) === lifetime.serverSocket);
}

export function validateParentHarnessLifetime(lifetime: ParentHarnessLifetime): boolean {
  const pane = paneFacts(lifetime.pane);
  return !!pane && pane.id === lifetime.pane && pane.session === lifetime.session
    && pane.socket === lifetime.serverSocket && pane.serverEpoch === lifetime.serverEpoch
    && parentHarnessState(lifetime.process, lifetime.family) === "same";
}

function parentHarnessState(parent: ProcessIdentity, family: string): "same" | "gone" | "unknown" {
  const processState = processGeneration(parent);
  if (processState !== "same") return processState;
  const row = spawnSync("ps", ["-p", parent.pid, "-o", "pid=,pgid=,tpgid=,comm=,command="],
    { encoding: "utf8", timeout: 2000, maxBuffer: 16384 });
  if (row.status !== 0) return "unknown";
  const observation = observeProcessHarness(parent.pid, parsePsTable(row.stdout ?? ""), true, agentFamilies());
  if (observation.state !== "observed") return "unknown";
  return observation.pid === parent.pid && observation.family === family ? "same" : "gone";
}

/** Stop exactly this helper generation, even a stopped one, and confirm it is gone. */
function fenceHelper(helper: ProcessIdentity): boolean {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (processGeneration(helper) !== "same") break;
    try {
      process.kill(Number(helper.pid), signal);
      // A stopped helper only acts on its pending TERM once continued.
      if (signal === "SIGTERM") process.kill(Number(helper.pid), "SIGCONT");
    } catch { /* already gone */ }
    for (let i = 0; i < 20 && processGeneration(helper) === "same"; i++) Bun.sleepSync(50);
  }
  return processGeneration(helper) === "gone";
}

/** Exact helper stop after explicit child dismissal. A replaced PID is never signalled. */
export function stopCrewLifetimeHelper(binding: CrewLifetimeBinding): void {
  if (processGeneration(binding.helper) === "same") {
    try { process.kill(Number(binding.helper.pid), "SIGTERM"); } catch { /* helper already exited */ }
  }
}


export type FamilyContext = Pick<ResolvedContext, "team" | "registryPath">;
export interface CrewProcess {
  team: string; crew: string; crewInstance: string; crewPane: string; crewSession: string;
  owner: string; ownerInstance: string; childFamily: string;
  serverSocket: string; serverEpoch: string; sessionId: string; windowId: string;
  child: ProcessIdentity;
}

/** Durable owner authority survives process/server loss, but never handle reuse. */
export function assertCrewOwnerLink(ctx: FamilyContext, crew: string): { owner: string; parent: Row; child: Row } {
  const all = registryRows(ctx.registryPath), child = all[crew], owner = str(child?.crew_owner), parent = all[owner];
  if (!child || !isCrew(child) || !owner || !parent || isCrew(parent) || !str(parent.instance)
    || str(child.crew_owner_instance) !== str(parent.instance) || !str(child.instance)) {
    throw new TapError(1, "crew_owner_unidentified", `tap crew remove ${crew}; then tap crew add --resume <native-id> under the intended owner`,
      `crew '${crew}' has no matching retained owner instance; no owner was inferred from its session`);
  }
  return { owner, parent, child };
}

/** Capture this row's live process only. A stale epoch is stopped, not a recycled pane. */
export function captureCrewProcess(team: string, crew: string, row: Row): CrewProcess | null {
  if (!isCrew(row) || !str(row.instance) || !/^%\d+$/.test(str(row.pane_id))) {
    if (isCrew(row) && !str(row.pane_id)) return null;
    refuse(`crew '${crew}' lacks a registered instance or pane`);
  }
  if (str(row.boot_id) && bootIdsMatch(str(row.boot_id), bootId()) === "mismatch") return null;
  const socket = physicalSocketPath();
  if (str(row.server_socket) && socket && socket !== str(row.server_socket)) refuse(`crew '${crew}' is on another tmux server`);
  const seen = observePaneResult(str(row.pane_id));
  if (seen.status === "pane_gone") return null;
  if (seen.status === "unobservable" || seen.status === "rate_limited") {
    const ns = tmuxSessionNamespace();
    if (ns.observable && ns.names.size === 0) return null;
    refuse(`crew '${crew}' pane cannot be observed; its row is retained`);
  }
  if (str(row.server_epoch) && seen.observation.serverEpoch !== str(row.server_epoch)) return null;
  if (seen.status === "pane_dead") return null;
  const pane = paneFacts(str(row.pane_id));
  if (!pane || pane.session !== str(row.session) || !str(row.server_epoch)
    || pane.serverEpoch !== str(row.server_epoch) || (str(row.server_socket) && pane.socket !== str(row.server_socket))) {
    refuse(`crew '${crew}' pane or server identity changed`);
  }
  const child = identity(pane.pid, bootId());
  if (!child || processGeneration(child) !== "same") refuse(`crew '${crew}' process generation is unreadable`);
  return { team, crew, crewInstance: str(row.instance), crewPane: pane.id, crewSession: pane.session,
    owner: str(row.crew_owner), ownerInstance: str(row.crew_owner_instance), childFamily: str(row.harness),
    serverSocket: pane.socket, serverEpoch: pane.serverEpoch, sessionId: pane.sessionId, windowId: pane.windowId, child };
}

export function crewProcessMatchesRow(proof: CrewProcess, crew: string, row: Row): boolean {
  return isCrew(row) && proof.crew === crew && proof.crewInstance === str(row.instance)
    && proof.crewPane === str(row.pane_id) && proof.crewSession === str(row.session)
    && proof.childFamily === str(row.harness) && proof.serverEpoch === str(row.server_epoch)
    && (!str(row.server_socket) || proof.serverSocket === str(row.server_socket))
    && proof.owner === str(row.crew_owner) && proof.ownerInstance === str(row.crew_owner_instance);
}

export function validateCrewProcess(proof: CrewProcess): boolean {
  const pane = paneFacts(proof.crewPane);
  return !!pane && pane.id === proof.crewPane && pane.session === proof.crewSession
    && pane.sessionId === proof.sessionId && pane.windowId === proof.windowId
    && pane.socket === proof.serverSocket && pane.serverEpoch === proof.serverEpoch
    && pane.pid === proof.child.pid && processGeneration(proof.child) === "same";
}

/** The exact old pane token is invalidated before its helper is signalled; evidence stays on the pane. */
export function fenceCrewLifetime(ctx: FamilyContext, crew: string, expected?: Row): void {
  const row = registryRows(ctx.registryPath)[crew];
  if (!row || !isCrew(row)) refuse(`crew '${crew}' disappeared before legacy-helper transition`);
  if (expected && ["instance", "pane_id", "session", "server_epoch", "crew_owner", "crew_owner_instance"]
    .some(key => str(row[key]) !== str(expected[key]))) refuse(`crew '${crew}' changed before legacy-helper transition`);
  const raw = paneOption(str(row.pane_id), OPTION);
  if (!raw) return;
  const proof = captureCrewProcess(ctx.team, crew, row);
  if (!proof) return;
  const old = readBinding(proof.crewPane, true);
  if (!old || old.team !== ctx.team || old.crew !== crew || old.crewInstance !== proof.crewInstance
    || old.serverSocket !== proof.serverSocket || old.serverEpoch !== proof.serverEpoch) {
    refuse(`crew '${crew}' has an unverifiable legacy helper binding; inspect it before resuming or relaunching`);
  }
  const token = paneOption(proof.crewPane, TOKEN_OPTION), retired = `retired:${old.token}`;
  if (token !== retired) {
    if (old.child.pid !== proof.child.pid || old.child.start !== proof.child.start || old.child.boot !== proof.child.boot) {
      refuse(`crew '${crew}' legacy child process changed; its helper was not signalled`);
    }
    const condition = `#{&&:#{==:#{pane_id},${proof.crewPane}},#{&&:#{==:#{pane_pid},${proof.child.pid}},#{&&:#{==:#{pid}:#{start_time},${proof.serverEpoch.slice(4)}},#{==:#{${TOKEN_OPTION}},${old.token}}}}}`;
    const result = tmux(["if-shell", "-F", "-t", proof.crewPane, condition,
      `set-option -p -t '${proof.crewPane}' '${TOKEN_OPTION}' '${retired}'`, "display-message -p 'crew transition changed'"]);
    if (result.code !== 0 || paneOption(proof.crewPane, TOKEN_OPTION) !== retired) refuse(`crew '${crew}' legacy token could not be fenced`);
  }
  if (!fenceHelper(old.helper)) refuse(`crew '${crew}' legacy token is fenced but its helper stop is unverified; inspect before retrying`);
}

export function crewLifetimeHealth(pane: string): "independent" | "legacy_supervised" | "unknown" {
  const raw = paneOption(pane, OPTION);
  if (!raw) return "independent";
  const old = readBinding(pane, true);
  if (!old) return "unknown";
  if (paneOption(pane, TOKEN_OPTION) === `retired:${old.token}`) return "independent";
  return processGeneration(old.helper) === "gone" ? "independent" : "legacy_supervised";
}

/** Creation proves a live caller once; later parent loss cannot revoke this crew's lifetime. */
export function authorizeNewCrew(ctx: ResolvedContext, callerPane: string, crew: string): CrewProcess {
  const { owner, parent, child } = assertCrewOwnerLink(ctx, crew);
  if (str(parent.pane_id) !== callerPane || !sameCrewSession(parent, child)) refuse("new crew does not share its recorded caller's generation");
  captureParentHarnessLifetime(ctx, owner);
  const proof = captureCrewProcess(ctx.team, crew, child);
  if (!proof) refuse(`new crew '${crew}' pane disappeared`);
  return proof;
}

export type CrewStop = { outcome: "stopped" | "changed" | "unknown" | "failed"; detail: string };
/** A guarded pane stop may end a crew's own last window; it never targets a whole parent session. */
export function stopCrewProcess(proof: CrewProcess): CrewStop {
  if (!validateCrewProcess(proof)) return { outcome: "changed", detail: "crew pane or process generation changed" };
  const condition = `#{&&:#{==:#{pane_id},${proof.crewPane}},#{&&:#{==:#{pane_pid},${proof.child.pid}},#{&&:#{==:#{session_id},${proof.sessionId}},#{==:#{pid}:#{start_time},${proof.serverEpoch.slice(4)}}}}}`;
  const effect = tmux(["if-shell", "-F", "-t", proof.crewPane, condition,
    `kill-pane -t '${proof.crewPane}'`, "display-message -p 'crew process changed'"]);
  if (effect.code !== 0) return { outcome: "failed", detail: effect.stderr.trim() || "tmux kill-pane failed" };
  const after = tmuxReadOnly(["list-panes", "-a", "-F", "#{pane_id}"]);
  if (after.code !== 0 && !/^no server running on /.test(after.stderr.trim())
    && !(after.code === 1 && ["no current target", "no sessions"].includes(after.stderr.trim()))) return { outcome: "unknown", detail: "crew stop could not be observed" };
  if (after.code === 0 && after.stdout.split("\n").includes(proof.crewPane)) return { outcome: "changed", detail: "crew pane remained after guarded stop" };
  let state = processGeneration(proof.child);
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (state !== "same") break;
    try { process.kill(Number(proof.child.pid), signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return { outcome: "unknown", detail: "crew process stop could not be confirmed" }; }
    if (signal === "SIGTERM") Bun.sleepSync(150);
    state = processGeneration(proof.child);
  }
  if (state === "unknown") return { outcome: "unknown", detail: "crew process generation is unobservable" };
  return { outcome: "stopped", detail: `stopped crew pane ${proof.crewPane}` };
}

export interface SurvivingCrew { crew: string; ownerInstance: string; proof: CrewProcess }
export function survivingCrews(ctx: FamilyContext, owner: string): SurvivingCrew[] {
  const all = registryRows(ctx.registryPath), parent = all[owner];
  if (!parent || isCrew(parent)) return [];
  return crewFamilyHandles(all, owner, false).flatMap(crew => {
    const proof = captureCrewProcess(ctx.team, crew, all[crew]!);
    return proof ? [{ crew, ownerInstance: str(parent.instance), proof }] : [];
  });
}
export async function fenceSurvivingCrew(ctx: FamilyContext, owner: string, surviving: SurvivingCrew): Promise<void> {
  const { parent, child } = assertCrewOwnerLink(ctx, surviving.crew);
  if (surviving.proof.owner !== owner || str(parent.instance) !== surviving.ownerInstance
    || !crewProcessMatchesRow(surviving.proof, surviving.crew, child) || !validateCrewProcess(surviving.proof)) refuse("surviving crew changed during owner revival");
  await fenceCrewLifetime(ctx, surviving.crew, child);
}
