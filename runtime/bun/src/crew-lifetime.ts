// Finite, pane-less supervision of one crew pane by one parent harness generation.
// The pane-local binding survives registry-only retirement of either row.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { observeProcessHarness, agentFamilies, readProcessTable, parsePsTable } from "./observe";
import { procStartEpoch } from "./reset";
import { bootId, bootIdsMatch, observePaneResult, ServerUnresponsive, tmux, tmuxReadOnly } from "./tmux";
import { TapError, type ResolvedContext } from "./context";
import { pyReadUtf8 } from "./spool-publication";
import { isMap, loads } from "./watch-detect";
import { artifactBun, runtimeModule } from "./scripts-dir";

const OPTION = "@tap_crew_lifetime";
const TOKEN_OPTION = "@tap_crew_lifetime_token";
const CADENCE_MS = 2000;
const str = (value: unknown): string => typeof value === "string" ? value : "";
type Row = Record<string, unknown>;
const isCrew = (row: Row | undefined): boolean => row?.crew === true || row?.crew === 1;

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

function readBinding(pane: string): CrewLifetimeBinding | null {
  try {
    const value = JSON.parse(paneOption(pane, OPTION)) as CrewLifetimeBinding;
    if (!value || typeof value !== "object" || value.version !== 1) return null;
    const fields: (keyof CrewLifetimeBinding)[] = ["token", "team", "owner", "ownerInstance", "ownerPane",
      "ownerSession", "crew", "crewInstance", "crewPane", "crewSession", "serverSocket", "serverEpoch",
      "parentFamily", "childFamily"];
    if (fields.some(key => typeof value[key] !== "string" || value[key] === "")
      || !/^[0-9a-f-]{36}$/.test(value.token) || value.crewPane !== pane
      || !/^%\d+$/.test(value.ownerPane) || !/^%\d+$/.test(value.crewPane)
      || paneOption(pane, TOKEN_OPTION) !== value.token) return null;
    const processFields = [value.parent, value.child, value.helper];
    if (processFields.some(item => !item || typeof item !== "object" || !/^[1-9]\d*$/.test(item.pid)
      || typeof item.start !== "string" || !item.start || typeof item.boot !== "string" || !item.boot)) return null;
    return value;
  } catch { return null; }
}
export const crewLifetimeBinding = readBinding;

export function crewLifetimeHealth(pane: string): "supervised" | "unsupervised" | "unknown" {
  const binding = readBinding(pane);
  if (!binding) return "unsupervised";
  const helper = processGeneration(binding.helper);
  if (helper === "gone") return "unsupervised";
  if (helper === "unknown") return "unknown";
  return paneOption(pane, TOKEN_OPTION) === binding.token ? "supervised" : "unsupervised";
}

/** A live pane row may be bound only to its unique non-crew session owner. */
function ownerRows(ctx: FamilyContext, owner: string, crew: string, requireOwnerLink = false): { parent: Row; child: Row } {
  const all = registryRows(ctx.registryPath);
  const parent = all[owner], child = all[crew];
  if (!parent || !child || isCrew(parent) || !isCrew(child)) refuse(`owner '${owner}' or crew '${crew}' is not a current family; remove and recreate the crew with tap crew remove ${crew}, then tap crew add`);
  if (requireOwnerLink && (str(child!.crew_owner) !== owner || !str(child!.crew_owner_instance)
    || str(child!.crew_owner_instance) !== str(parent!.instance))) {
    refuse(`crew '${crew}' has no matching durable owner link; remove and recreate it with tap crew remove ${crew}, then tap crew add`);
  }
  const session = str(parent!.session);
  if (!session || str(child!.session) !== session) refuse(`crew '${crew}' no longer shares owner '${owner}' session`);
  const owners = Object.entries(all).filter(([, row]) => !isCrew(row) && str(row.session) === session);
  if (owners.length !== 1 || owners[0]![0] !== owner) refuse(`session '${session}' has no unique durable owner`);
  if (!str(parent!.instance) || !str(child!.instance) || !str(parent!.pane_id) || !str(child!.pane_id)) refuse("family rows lack instance or pane identity");
  return { parent: parent!, child: child! };
}

/** Eligibility only: no helper arm, process replacement or legacy adoption. */
export function assertCrewOwnerLink(ctx: FamilyContext, crew: string): void {
  const child = registryRows(ctx.registryPath)[crew];
  const owner = str(child?.crew_owner);
  if (!owner) refuse(`crew '${crew}' lacks a durable owner link; remove and recreate it with tap crew remove ${crew}, then tap crew add`);
  ownerRows(ctx, owner, crew, true);
}

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

/** Revalidate the binding immediately before a family registry-only effect. */
export function validateCrewLifetimeBinding(binding: CrewLifetimeBinding): boolean {
  const child = paneFacts(binding.crewPane);
  const parent = paneFacts(binding.ownerPane);
  return !!child && !!parent && child.id === binding.crewPane && child.session === binding.crewSession
    && parent.id === binding.ownerPane && parent.session === binding.ownerSession
    && child.socket === binding.serverSocket && parent.socket === binding.serverSocket
    && child.serverEpoch === binding.serverEpoch && parent.serverEpoch === binding.serverEpoch
    && child.pid === binding.child.pid
    && paneOption(binding.crewPane, TOKEN_OPTION) === binding.token
    && parentHarnessState(binding.parent, binding.parentFamily) === "same" && processGeneration(binding.child) === "same"
    && processGeneration(binding.helper) === "same";
}

/** Pure row comparison for a lifecycle transaction holding registry custody. */
export function crewLifetimeMatchesRows(binding: CrewLifetimeBinding, ownerHandle: string, parent: Row,
  crewHandle: string, child: Row): boolean {
  return binding.owner === ownerHandle && binding.crew === crewHandle
    && !isCrew(parent) && isCrew(child)
    && str(parent.harness) === binding.parentFamily && str(child.harness) === binding.childFamily
    && str(parent.instance) === binding.ownerInstance && str(child.instance) === binding.crewInstance
    && str(parent.pane_id) === binding.ownerPane && str(child.pane_id) === binding.crewPane
    && str(parent.session) === binding.ownerSession && str(child.session) === binding.crewSession
    && str(parent.server_epoch) === binding.serverEpoch && str(child.server_epoch) === binding.serverEpoch
    && (!str(parent.server_socket) || str(parent.server_socket) === binding.serverSocket)
    && (!str(child.server_socket) || str(child.server_socket) === binding.serverSocket);
}

/** Existing rows are reconciled while owner evidence is still available. */
type FamilyContext = Pick<ResolvedContext, "team" | "registryPath">;

/** Both family panes as their rows record them, on one server generation; else a refusal. */
function familyFacts(parent: Row, child: Row) {
  const parentFacts = paneFacts(str(parent.pane_id)), childFacts = paneFacts(str(child.pane_id));
  if (!parentFacts || !childFacts || parentFacts.session !== str(parent.session) || childFacts.session !== str(child.session)
    || parentFacts.socket !== childFacts.socket || parentFacts.serverEpoch !== childFacts.serverEpoch
    || parentFacts.serverEpoch !== str(parent.server_epoch) || childFacts.serverEpoch !== str(child.server_epoch)
    || (str(parent.server_socket) && parentFacts.socket !== str(parent.server_socket))
    || (str(child.server_socket) && childFacts.socket !== str(child.server_socket))) refuse("family pane or server generation changed");
  return { parentFacts: parentFacts!, childFacts: childFacts! };
}

/** An unarmed binding of this child to the parent's current harness generation. */
function newBinding(ctx: FamilyContext, owner: string, crew: string, parent: Row, child: Row,
  facts: ReturnType<typeof familyFacts>, parentProcess: ProcessIdentity): CrewLifetimeBinding {
  const { parentFacts, childFacts } = facts;
  const childProcess = identity(childFacts.pid, parentProcess.boot);
  if (!childProcess) refuse(`crew '${crew}' process generation is unreadable`);
  return {
    version: 1, token: randomUUID(), team: ctx.team, owner, ownerInstance: str(parent.instance), ownerPane: str(parent.pane_id),
    ownerSession: parentFacts.session, crew, crewInstance: str(child.instance), crewPane: str(child.pane_id), crewSession: childFacts.session,
    serverSocket: childFacts.socket, serverEpoch: childFacts.serverEpoch, parent: parentProcess, parentFamily: str(parent.harness), child: childProcess!, childFamily: str(child.harness),
    helper: { pid: "", start: "", boot: parentProcess.boot },
  };
}

// Deliberate family teardown can bind legacy rows while their original live
// parent is still observed. Creation/rearm pass true; they may not adopt one.
export async function reconcileCrewLifetime(ctx: ResolvedContext, owner: string, crew: string, requireOwnerLink = false): Promise<CrewLifetimeBinding> {
  const { parent, child } = ownerRows(ctx, owner, crew, requireOwnerLink);
  const childPane = str(child.pane_id);
  const facts = familyFacts(parent, child);
  const parentProcess = parentIdentity(parent);
  const prior = readBinding(childPane);
  if (prior && prior.ownerInstance === str(parent.instance) && prior.crewInstance === str(child.instance)
    && prior.parent.pid === parentProcess.pid && prior.parent.start === parentProcess.start
    && prior.parentFamily === str(parent.harness) && prior.childFamily === str(child.harness)
    && validateCrewLifetimeBinding(prior)) return prior;
  // A crew belongs to its original parent lifetime even after that parent exits.
  // Re-arming a missing helper must never adopt it into a replacement harness.
  if (prior && prior.crewInstance === str(child.instance)
    && (prior.owner !== owner || prior.ownerInstance !== str(parent.instance)
      || prior.parent.pid !== parentProcess.pid || prior.parent.start !== parentProcess.start
      || bootIdsMatch(prior.parent.boot, parentProcess.boot) !== "match"
      || prior.parentFamily !== str(parent.harness))) {
    refuse(`crew '${crew}' belongs to a different parent generation`);
  }
  // A valid binding to a different live parent is not ours to replace.
  if (prior && processGeneration(prior.parent) === "same" && processGeneration(prior.helper) === "same"
    && processGeneration(prior.child) === "same") {
    refuse(`crew '${crew}' is already supervised by another parent generation`);
  }
  return armCrewLifetime(newBinding(ctx, owner, crew, parent, child, facts, parentProcess));
}

/** Stop exactly this helper generation, even a stopped one, and confirm it is gone. */
async function fenceHelper(helper: ProcessIdentity): Promise<boolean> {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (processGeneration(helper) !== "same") break;
    try {
      process.kill(Number(helper.pid), signal);
      // A stopped helper only acts on its pending TERM once continued.
      if (signal === "SIGTERM") process.kill(Number(helper.pid), "SIGCONT");
    } catch { /* already gone */ }
    for (let i = 0; i < 20 && processGeneration(helper) === "same"; i++) await Bun.sleep(50);
  }
  return processGeneration(helper) === "gone";
}

/** A crew that outlived its parent seat, captured before the seat is revived (tap-9rrat). */
export interface SurvivingCrew { crew: string; crewInstance: string; crewPane: string; ownerInstance: string;
  /** The pane's process generation at the snapshot; a crew whose process is unreadable is not snapshotted. */
  child: ProcessIdentity; binding: CrewLifetimeBinding | null }

/** The registered crews in the owner's session, with their pane-local bindings, before any revival effect. */
export function survivingCrews(ctx: FamilyContext, owner: string): SurvivingCrew[] {
  const all = registryRows(ctx.registryPath);
  const parent = all[owner];
  if (!parent || isCrew(parent) || !str(parent.instance) || !str(parent.session)) return [];
  const found: SurvivingCrew[] = [];
  for (const [crew, row] of Object.entries(all)) {
    if (!isCrew(row) || str(row.crew_owner) !== owner || str(row.crew_owner_instance) !== str(parent.instance) || str(row.session) !== str(parent.session) || !str(row.instance) || !/^%\d+$/.test(str(row.pane_id))) continue;
    const fact = paneFacts(str(row.pane_id));
    const child = fact && fact.id === str(row.pane_id) ? identity(fact.pid, bootId()) : null;
    if (child) found.push({ crew, crewInstance: str(row.instance), crewPane: str(row.pane_id), ownerInstance: str(parent.instance),
      child, binding: readBinding(str(row.pane_id)) });
  }
  return found;
}

/**
 * The one continuation past "a crew belongs to its original parent lifetime":
 * after the SAME retained seat instance is revived, its surviving crew moves to
 * the revived harness generation. Refuses unless the crew is unchanged since the
 * snapshot, its original parent is provably gone, and its old helper is fenced;
 * the new token then voids the old helper's guarded kill. A fresh replacement
 * mints a new instance and so can never inherit crews this way.
 */
export async function reclaimRevivedCrew(ctx: FamilyContext, owner: string, surviving: SurvivingCrew): Promise<CrewLifetimeBinding> {
  const { parent, child } = ownerRows(ctx, owner, surviving.crew, true);
  if (str(parent.instance) !== surviving.ownerInstance) refuse(`seat '${owner}' is not the retained instance crew '${surviving.crew}' belonged to`);
  if (str(child.instance) !== surviving.crewInstance || str(child.pane_id) !== surviving.crewPane) refuse(`crew '${surviving.crew}' changed during the revival`);
  const facts = familyFacts(parent, child);
  // The process the snapshot saw, unchanged: a replacement in the same pane is not inherited.
  if (facts.childFacts.pid !== surviving.child.pid || processGeneration(surviving.child) !== "same") refuse(`crew '${surviving.crew}' process changed during the revival`);
  const prior = readBinding(surviving.crewPane);
  if ((prior?.token ?? null) !== (surviving.binding?.token ?? null)) refuse(`crew '${surviving.crew}' supervision changed during the revival`);
  if (prior) {
    if (prior.owner !== owner || prior.ownerInstance !== surviving.ownerInstance || prior.crewInstance !== surviving.crewInstance
      || prior.parentFamily !== str(parent.harness) || prior.childFamily !== str(child.harness)) refuse(`crew '${surviving.crew}' belongs to a different family`);
    if (facts.childFacts.pid !== prior.child.pid || processGeneration(prior.child) !== "same") refuse(`crew '${surviving.crew}' process changed during the revival`);
    // The supervisor's own predicate: an exec into another family also ends the parent harness.
    if (parentHarnessState(prior.parent, prior.parentFamily) !== "gone") refuse(`crew '${surviving.crew}' original parent generation is not provably gone`);
    if (!await fenceHelper(prior.helper)) refuse(`crew '${surviving.crew}' old supervisor could not be fenced`);
  }
  return armCrewLifetime(newBinding(ctx, owner, surviving.crew, parent, child, facts, parentIdentity(parent)));
}

/**
 * Before a revival starts, stop a surviving crew's old supervisor so it cannot reap the crew while the
 * revived harness starts. Only a snapshotted binding that still owns the pane, whose parent harness is
 * provably gone, is fenced; anything else is left alone and the later reclaim decides.
 */
export async function fenceSurvivingCrew(owner: string, surviving: SurvivingCrew): Promise<boolean> {
  const prior = surviving.binding;
  if (!prior || readBinding(surviving.crewPane)?.token !== prior.token || prior.owner !== owner
    || prior.ownerInstance !== surviving.ownerInstance || prior.crewInstance !== surviving.crewInstance) return false;
  if (parentHarnessState(prior.parent, prior.parentFamily) !== "gone") return false;
  return fenceHelper(prior.helper);
}

/** Creation binds the caller's actual registered owner, never a session name guess. */
export async function armNewCrew(ctx: ResolvedContext, callerPane: string, crew: string): Promise<CrewLifetimeBinding> {
  const all = registryRows(ctx.registryPath);
  const owners = Object.entries(all).filter(([, row]) => !isCrew(row) && str(row.pane_id) === callerPane);
  if (owners.length !== 1) refuse(`caller pane '${callerPane}' has no unique durable parent row`);
  return reconcileCrewLifetime(ctx, owners[0]![0], crew, true);
}

export async function rearmCrewLifetime(ctx: ResolvedContext, crew: string): Promise<CrewLifetimeBinding> {
  const all = registryRows(ctx.registryPath);
  const child = all[crew];
  if (!child || !isCrew(child) || !str(child.session)) refuse(`crew '${crew}' has no provable registered session`);
  const owner = str(child!.crew_owner);
  if (!owner) refuse(`crew '${crew}' lacks a durable owner link; remove and recreate it with tap crew remove ${crew}, then tap crew add`);
  return reconcileCrewLifetime(ctx, owner, crew, true);
}

/** Finish a verified child replacement without adopting a new parent lifetime. */
export async function rearmReplacedCrewLifetime(ctx: ResolvedContext, crew: string,
  previous: CrewLifetimeBinding, replacementPid: string): Promise<CrewLifetimeBinding> {
  const replacement = identity(replacementPid, previous.child.boot);
  try { return await rearmCrewLifetime(ctx, crew); }
  catch (error) {
    const remedy = `inspect pane ${previous.crewPane}; tap crew shutdown ${ctx.team}/${crew}`;
    let parentState: "same" | "gone" | "unknown" = "unknown";
    try { parentState = parentHarnessState(previous.parent, previous.parentFamily); }
    catch (probeError) { if (!(probeError instanceof ServerUnresponsive)) throw probeError; }
    if (parentState === "gone" && replacement && replacement.pid !== previous.child.pid) {
      let stopped = processGeneration(replacement) === "gone";
      try {
        // A failed arm may already have published a fresh token for this same
        // replacement. Accept only that child's original parent binding.
        const current = readBinding(previous.crewPane);
        const owned = current && current.crewInstance === previous.crewInstance
          && current.child.pid === replacement.pid && current.child.start === replacement.start
          && bootIdsMatch(current.child.boot, replacement.boot) === "match"
          && current.parent.pid === previous.parent.pid && current.parent.start === previous.parent.start
          && bootIdsMatch(current.parent.boot, previous.parent.boot) === "match";
        const cleanup = owned ? current! : { ...previous, child: replacement };
        if (!stopped) stopped = stopBoundCrewPane(cleanup).outcome === "stopped";
        if (stopped && owned) stopCrewLifetimeHelper(current!);
      } catch (probeError) { if (!(probeError instanceof ServerUnresponsive)) throw probeError; }
      if (stopped) throw new TapError(1, "crew_parent_exited", `restart the parent before creating another crew`,
        `parent harness exited during relaunch; stopped the exact replacement child in pane ${previous.crewPane}`);
    }
    throw new TapError(7, "replacement_unsupervised", remedy,
      `replacement was observed in pane ${previous.crewPane}, but supervision could not be restored; inspect its current state before retrying: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function armCrewLifetime(binding: CrewLifetimeBinding): Promise<CrewLifetimeBinding> {
  const child = spawn(artifactBun() ?? "bun", [runtimeModule("src/crew-lifetime.ts"), JSON.stringify(binding)], {
    detached: true, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
  });
  child.unref();
  const line = await new Promise<string>((resolve, reject) => {
    let data = "";
    const timer = setTimeout(() => reject(new Error("helper acknowledgement timed out")), 5000);
    child.stdout!.on("data", chunk => {
      data += String(chunk);
      if (data.includes("\n")) { clearTimeout(timer); resolve(data.split("\n")[0]!); child.stdout!.destroy(); }
    });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("exit", () => { clearTimeout(timer); reject(new Error("helper exited before acknowledgement")); });
  }).catch(error => {
    const spawned = identity(String(child.pid ?? ""), binding.parent.boot);
    if (spawned && processGeneration(spawned) === "same") {
      try { process.kill(Number(spawned.pid), "SIGTERM"); } catch { /* already gone */ }
    }
    refuse(`could not arm crew helper: ${error}`);
  });
  let acknowledged: CrewLifetimeBinding;
  try { acknowledged = JSON.parse(line) as CrewLifetimeBinding; }
  catch { refuse("crew helper returned malformed acknowledgement"); }
  if (acknowledged!.token !== binding.token || acknowledged!.helper.pid !== String(child.pid)
    || !validateCrewLifetimeBinding(acknowledged!)) {
    if (acknowledged!.token === binding.token && acknowledged!.helper.pid === String(child.pid)) stopCrewLifetimeHelper(acknowledged!);
    refuse("crew helper identity or parent changed during arm");
  }
  return acknowledged!;
}

/** Exact helper stop after explicit child dismissal. A replaced PID is never signalled. */
export function stopCrewLifetimeHelper(binding: CrewLifetimeBinding): void {
  if (processGeneration(binding.helper) === "same") {
    try { process.kill(Number(binding.helper.pid), "SIGTERM"); } catch { /* helper already exited */ }
  }
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

function childBindingState(binding: CrewLifetimeBinding): "same" | "gone" | "unknown" {
  const processState = processGeneration(binding.child);
  if (processState !== "same") return processState;
  const fact = paneFacts(binding.crewPane);
  if (!fact) return "unknown";
  if (fact.id !== binding.crewPane || fact.session !== binding.crewSession
    || fact.socket !== binding.serverSocket || fact.serverEpoch !== binding.serverEpoch
    || fact.pid !== binding.child.pid) return "gone";
  const option = tmuxReadOnly(["show-options", "-p", "-v", "-t", binding.crewPane, TOKEN_OPTION]);
  if (option.code !== 0) return "unknown";
  return option.stdout.trimEnd() === binding.token ? "same" : "gone";
}

function exactChild(binding: CrewLifetimeBinding): boolean {
  return childBindingState(binding) === "same";
}

export type BoundCrewStop = { outcome: "stopped" | "changed" | "unknown" | "failed"; detail: string };

/** Exact family cleanup, including a last child pane; caller stops the helper separately. */
export function stopBoundCrewPane(binding: CrewLifetimeBinding): BoundCrewStop {
  if (!exactChild(binding)) return { outcome: "changed", detail: "crew pane, process or TAP binding changed" };
  // The condition and kill are one tmux command; a new child may reuse the pane
  // address, but it cannot pass the pane id, server generation and owned token.
  const condition = `#{&&:#{==:#{pane_id},${binding.crewPane}},#{&&:#{==:#{pane_pid},${binding.child.pid}},#{&&:#{==:#{pid}:#{start_time},${binding.serverEpoch.slice(4)}},#{==:#{${TOKEN_OPTION}},${binding.token}}}}}`;
  const effect = tmux(["if-shell", "-F", "-t", binding.crewPane, condition,
    `kill-pane -t '${binding.crewPane}'`, "display-message -p 'tap crew lifetime: pane identity changed'"]);
  if (effect.code !== 0) return { outcome: "failed", detail: effect.stderr.trim() || "tmux kill-pane failed" };
  const after = tmuxReadOnly(["list-panes", "-a", "-F", "#{pane_id}"]);
  if (after.code !== 0 && !/^no server running on /.test(after.stderr.trim())) {
    return { outcome: "unknown", detail: after.stderr.trim() || "cannot verify crew pane after effect" };
  }
  if (after.code === 0 && after.stdout.split("\n").includes(binding.crewPane)) {
    return { outcome: "changed", detail: `crew pane '${binding.crewPane}' remained after guarded stop` };
  }
  // A process that ignored terminal hangup is still the captured child, and
  // only that start/boot generation may be signalled after its pane is gone.
  let childState = processGeneration(binding.child);
  if (childState === "same") {
    try { process.kill(Number(binding.child.pid), "SIGTERM"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return { outcome: "unknown", detail: "crew pane stopped but child process stop could not be confirmed" };
    }
    Bun.sleepSync(150);
    childState = processGeneration(binding.child);
    if (childState === "same") {
      // Signal the exact same generation again; a child that ignored terminal
      // hangup and TERM must not outlive the pane it owned.
      try { process.kill(Number(binding.child.pid), "SIGKILL"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return { outcome: "unknown", detail: "crew pane stopped but child process resisted final stop" };
      }
      childState = "gone";
    }
  }
  if (childState === "unknown") return { outcome: "unknown", detail: "crew pane stopped but child process generation is unobservable" };
  return { outcome: "stopped", detail: `stopped bound crew pane ${binding.crewPane}` };
}

async function helperMain(binding: CrewLifetimeBinding): Promise<void> {
  const mine = identity(String(process.pid), binding.parent.boot);
  if (!mine || parentHarnessState(binding.parent, binding.parentFamily) !== "same" || !exactChildBeforeArm(binding)) return;
  binding.helper = mine;
  const encoded = JSON.stringify(binding);
  if (tmux(["set-option", "-p", "-t", binding.crewPane, OPTION, encoded]).code !== 0
    || tmux(["set-option", "-p", "-t", binding.crewPane, TOKEN_OPTION, binding.token]).code !== 0) return;
  if (!exactChild(binding)) return;
  process.stdout.write(`${encoded}\n`);
  process.stdout.end();
  while (true) {
    await Bun.sleep(CADENCE_MS);
    try {
      const childState = childBindingState(binding);
      if (childState === "gone") return;
      if (childState === "unknown") continue;
      const state = parentHarnessState(binding.parent, binding.parentFamily);
      if (state === "gone") {
        const result = stopBoundCrewPane(binding);
        if (result.outcome === "stopped" || result.outcome === "changed") return;
      }
      // A failed observation is unknown and keeps the child alive for another pass.
    } catch (error) {
      if (!(error instanceof ServerUnresponsive)) throw error;
      // A deadline or fork failure is unknown; keep supervising on the next pass.
    }
  }
}

function exactChildBeforeArm(binding: CrewLifetimeBinding): boolean {
  const fact = paneFacts(binding.crewPane);
  return !!fact && fact.id === binding.crewPane && fact.session === binding.crewSession
    && fact.socket === binding.serverSocket && fact.serverEpoch === binding.serverEpoch
    && fact.pid === binding.child.pid
    && processGeneration(binding.child) === "same";
}

if (import.meta.main) {
  try {
    const binding = JSON.parse(process.argv[2] ?? "") as CrewLifetimeBinding;
    await helperMain(binding);
  } catch { /* an unarmed helper cannot claim a child */ }
}
