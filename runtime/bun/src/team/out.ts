// Team-scoped retirement preserves the acting registry and every bus component.
// A selected parent is one lifecycle unit with its process-bound crew.
import { TapError, observeCallingPane, resolveContext, type ResolvedContext } from "../context";
import { renderRefusalsAsync } from "../error-line";
import { pick } from "../fzf";
import type { Seat } from "../registry";
import { assertResetUnfenced, procStartEpoch } from "../reset";
import { retireFamilyRows, restoreFamilyRows, scratchOnlyGuard } from "../out-retire";
import { liveSeat, seatSnapshot, stopExactPane } from "../seat-stop";
import { physicalSocketPath } from "../tmux";
import { lifecycleDisposition, tmuxFateStopsNamedSession } from "../lifecycle-target";
import { agentFamilies, harnessEvidence, readProcessTable } from "../observe";
import { observePaneResult } from "../tmux";
import { codePointCompare, rosterGate, scanOptionalSelection, selectedHandles, type Selection } from "./selection";
import {
  chooseSeatCohort, chooseTeam, confirmAction, readDiscoverySeats, revalidateTeam,
  type BoundCohort, type BoundSeat, type BoundTeam,
} from "./discovery";
import {
  captureParentHarnessLifetime, crewLifetimeBinding, crewLifetimeMatchesRows,
  parentLifetimeMatchesRow, reconcileCrewLifetime, stopBoundCrewPane,
  stopCrewLifetimeHelper, validateCrewLifetimeBinding, validateParentHarnessLifetime,
  type CrewLifetimeBinding, type ParentHarnessLifetime,
} from "../crew-lifetime";

type Row = Record<string, unknown>;
const field = (row: Row | undefined, key: string): string => typeof row?.[key] === "string" ? row[key] as string : "";
const crew = (row: Row | undefined): boolean => row?.crew === true || row?.crew === 1;
const poll = (row: Row | undefined): boolean => field(row, "delivery") === "poll";
function fail(cls: string, detail: string): never {
  throw new TapError(1, cls, "tap team roster; tap help team out", detail, "tap team out");
}

interface Options { team?: string; selection: Selection; pending?: "--only" | "--except"; hard: boolean; yes: boolean; dryRun: boolean; json: boolean }

function parse(argv: string[]): Options {
  const scan = scanOptionalSelection("team out", argv);
  const out: Options = { selection: scan.selection, pending: scan.pending, hard: false, yes: false, dryRun: false, json: false };
  for (const arg of scan.rest) {
    if (arg === "--kill" || arg === "--hard") { if (out.hard) fail("usage_error", "--kill and --hard cannot be repeated or combined"); out.hard = true; }
    else if (arg === "--yes") out.yes = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--json") out.json = true;
    else if (arg.startsWith("-")) fail("unknown_option", `unknown option '${arg}'`);
    else if (!out.team) out.team = arg;
    else fail("usage_error", `unexpected team operand '${arg}'`);
  }
  return out;
}

function rows(ctx: ResolvedContext): Record<string, Seat> {
  return readDiscoverySeats(ctx.registryPath);
}

function boundTeam(ctx: ResolvedContext): BoundTeam {
  return { team: ctx.team, root: ctx.root, registryPath: ctx.registryPath, context: ctx };
}

function boundSeat(handle: string, row: Row): BoundSeat {
  return { handle, instance: field(row, "instance"), session: field(row, "session"), paneId: field(row, "pane_id"), serverEpoch: field(row, "server_epoch") };
}

function selectedParentRow(current: Record<string, Seat>, approved: BoundSeat, owner: string): Row {
  if (!approved.instance) fail("target_unbound", `parent '${owner}' has no durable instance; its registration was retained`);
  const row = current[owner];
  if (!row || field(row, "instance") !== approved.instance || field(row, "session") !== approved.session
    || field(row, "pane_id") !== approved.paneId || field(row, "server_epoch") !== approved.serverEpoch)
    fail("target_changed", `parent '${owner}' changed after selection`);
  return row;
}

function cohort(team: BoundTeam, selection: Selection, current: Record<string, Seat>): BoundCohort {
  const parents = Object.keys(current).filter(h => !crew(current[h])).sort(codePointCompare);
  // Crew names cannot be used as independent family selectors.
  const named = selectedHandles(selection);
  const crewNamed = named.filter(h => crew(current[h]));
  if (crewNamed.length) fail("usage_error", `crew handle '${crewNamed[0]}' follows its parent; select the parent handle instead`);
  rosterGate("team out", selection, parents);
  const chosen = parents.filter(h => selection.mode === "--only" ? selection.only.includes(h)
    : selection.mode === "--except" ? !selection.except.includes(h) : true);
  const seats = new Map(chosen.map(handle => [handle, boundSeat(handle, current[handle]!) ]));
  return { team, seats, original: selection, selection: { mode: "--only", only: chosen, except: [] } };
}

function familyChildren(current: Record<string, Seat>, owner: string): string[] {
  const parent = current[owner];
  if (!parent) fail("target_changed", `parent '${owner}' disappeared`);
  if (poll(parent)) return [];
  const session = field(parent, "session");
  if (!session) fail("crew_owner_unidentified", `parent '${owner}' has no recorded session`);
  const owners = Object.keys(current).filter(h => !crew(current[h]) && !poll(current[h]) && field(current[h], "session") === session);
  if (owners.length !== 1) fail("crew_owner_ambiguous", `session '${session}' has ${owners.length} parent rows; family ownership is ambiguous`);
  return Object.keys(current).filter(h => crew(current[h]) && field(current[h], "session") === session).sort(codePointCompare);
}

function orphanChildren(current: Record<string, Seat>, approved: ReadonlySet<string>): string[] {
  return Object.keys(current).filter(h => crew(current[h]) && !Object.keys(current).some(parent =>
    approved.has(parent) && !crew(current[parent]) && !poll(current[parent])
      && field(current[parent], "session") === field(current[h], "session"))).sort(codePointCompare);
}

function orphanBindingMatchesRow(binding: CrewLifetimeBinding, handle: string, row: Row): boolean {
  return crew(row) && binding.crew === handle && field(row, "instance") === binding.crewInstance
    && field(row, "pane_id") === binding.crewPane && field(row, "session") === binding.crewSession
    && field(row, "server_epoch") === binding.serverEpoch
    && (!field(row, "server_socket") || field(row, "server_socket") === binding.serverSocket);
}

function boundOrphan(ctx: ResolvedContext, current: Record<string, Seat>, handle: string): CrewLifetimeBinding | null {
  const row = current[handle];
  if (!row || !crew(row)) return null;
  const binding = crewLifetimeBinding(field(row, "pane_id"));
  if (!binding || binding.team !== ctx.team || !orphanBindingMatchesRow(binding, handle, row)) return null;
  if (Object.keys(current).some(parent => !crew(current[parent]) && !poll(current[parent])
    && field(current[parent], "session") === binding.crewSession)) return null;
  return validateCrewLifetimeBinding(binding) ? binding : null;
}

interface Family { owner: string; parent: Row; lifetime?: ParentHarnessLifetime; children: Map<string, CrewLifetimeBinding> }

function sameCrewApproval(row: Row, approved: Row | undefined): boolean {
  return !!approved && ["instance", "session", "pane_id", "server_epoch", "server_socket", "harness"]
    .every(key => field(row, key) === field(approved, key));
}

function bindingMatchesApprovedParent(binding: CrewLifetimeBinding, lifetime: ParentHarnessLifetime): boolean {
  return binding.parent.pid === lifetime.process.pid && binding.parent.start === lifetime.process.start
    && binding.parent.boot === lifetime.process.boot;
}

/** A live shell may remain after its enrolled harness exits. Only a positive
 * foreground observation permits hard removal without a captured generation. */
function exitedParentHarness(row: Row): boolean {
  const seen = observePaneResult(field(row, "pane_id"));
  if (seen.status !== "ok" || seen.observation.paneId !== field(row, "pane_id")
    || seen.observation.session !== field(row, "session")
    || seen.observation.serverEpoch !== field(row, "server_epoch")) return false;
  const table = readProcessTable();
  return harnessEvidence(field(row, "harness"), seen.observation.currentCommand,
    seen.observation.panePid, table.table, table.ok, agentFamilies()).state === "exited";
}

/** Read-only counterpart of crew arming for previews. */
function inspectCrewArmability(row: Row): void {
  const pane = field(row, "pane_id");
  const seen = observePaneResult(pane);
  if (seen.status !== "ok" || seen.observation.paneId !== pane
    || seen.observation.session !== field(row, "session")
    || seen.observation.serverEpoch !== field(row, "server_epoch")
    || (field(row, "server_socket") && field(row, "server_socket") !== physicalSocketPath())
    || !procStartEpoch(seen.observation.panePid)) {
    fail("crew_lifetime_unprovable", `crew pane '${pane}' has no provable current process generation`);
  }
}

async function prepareFamily(ctx: ResolvedContext, owner: string, current: Record<string, Seat>,
  approvedLifetime: ParentHarnessLifetime | null, originalCrew: ReadonlyMap<string, Row>, dryRun = false): Promise<Family> {
  const parent = current[owner];
  if (!parent || crew(parent)) fail("target_changed", `parent '${owner}' changed after selection`);
  const children = new Map<string, CrewLifetimeBinding>();
  const handles = familyChildren(current, owner);
  let lifetime: ParentHarnessLifetime | undefined;
  if (approvedLifetime) {
    if (!parentLifetimeMatchesRow(approvedLifetime, owner, parent!) || !validateParentHarnessLifetime(approvedLifetime))
      fail("target_changed", `parent '${owner}' harness generation changed after approval`);
    lifetime = approvedLifetime;
  } else if (!poll(parent)) {
    // A new harness in the same row and pane is a replacement, not the one
    // approved at preview. Unknown observation cannot authorize a family.
    try { captureParentHarnessLifetime(ctx, owner); fail("target_changed", `parent '${owner}' harness started after approval`); }
    catch (error) { if (error instanceof TapError && error.errorClass === "target_changed") throw error; }
  }
  if (handles.length) {
    // Arm while both rows still exist. Registry absence is never evidence that
    // an old crew's parent process ended.
    if (!lifetime) fail("crew_lifetime_unprovable", `parent '${owner}' process generation was not bound before confirmation`);
    for (const handle of handles) {
      const row = current[handle]!;
      if (sameCrewApproval(row, originalCrew.get(handle))) {
        if (dryRun) inspectCrewArmability(row);
        else children.set(handle, await reconcileCrewLifetime(ctx, owner, handle));
        continue;
      }
      // A child added or replaced while the operator chose/confirmed the
      // family may follow only if its own existing helper already proves the
      // approved parent process generation. Never mint that authority here.
      const binding = crewLifetimeBinding(field(row, "pane_id"));
      if (!binding || !crewLifetimeMatchesRows(binding, owner, parent!, handle, row)
        || !bindingMatchesApprovedParent(binding, lifetime) || !validateCrewLifetimeBinding(binding)) {
        fail("crew_lifetime_unprovable", `late crew '${handle}' has no valid binding to the approved parent; family rows were retained`);
      }
      children.set(handle, binding);
    }
  }
  return { owner, parent: parent!, lifetime, children };
}

function validateFamily(family: Family, current: ReadonlyMap<string, Row>, hard: boolean): string[] {
  const all = Object.fromEntries(current) as Record<string, Seat>;
  const parent = all[family.owner];
  if (!parent || crew(parent)) fail("target_changed", `parent '${family.owner}' changed during team out`);
  if (family.lifetime && (!parentLifetimeMatchesRow(family.lifetime, family.owner, parent!)
    || (!hard && !validateParentHarnessLifetime(family.lifetime)))) fail("target_changed", `parent '${family.owner}' process generation changed`);
  const children = familyChildren(all, family.owner);
  for (const handle of children) {
    const row = all[handle]!;
    const binding = family.children.get(handle) ?? crewLifetimeBinding(field(row, "pane_id"));
    if (!binding || !crewLifetimeMatchesRows(binding, family.owner, parent!, handle, row)
      || (family.lifetime && !bindingMatchesApprovedParent(binding, family.lifetime))
      || !validateCrewLifetimeBinding(binding)) {
      fail("crew_lifetime_unprovable", `crew '${handle}' has no valid process-lifetime binding; family rows were retained`);
    }
    family.children.set(handle, binding);
  }
  // A replacement or late unrelated parent sharing the session blocks the
  // family. familyChildren has already checked unique owner authority.
  return [...children, family.owner];
}

function hardPreflight(ctx: ResolvedContext, family: Family, current: Record<string, Seat>): ReturnType<typeof liveSeat> {
  scratchOnlyGuard(process.env, "team out --hard would stop a session on", ctx.bus.home, "tap team out");
  if (poll(family.parent)) return undefined;
  const canonical = `${ctx.team}/${family.owner}`;
  if (field(family.parent, "session") !== canonical || family.parent.status === "pending" || family.parent.launch_token)
    fail("session_identity_mismatch", `parent '${family.owner}' has no settled canonical session`);
  if (field(family.parent, "server_socket") && field(family.parent, "server_socket") !== physicalSocketPath())
    fail("session_identity_mismatch", `parent '${family.owner}' belongs to a different tmux server`);
  const snapshot = seatSnapshot();
  const permitted = new Set([field(family.parent, "pane_id"),
    ...familyChildren(current, family.owner).map(handle => field(current[handle], "pane_id"))]);
  if (snapshot.panes.some(p => p.session === canonical && !permitted.has(p.id)))
    fail("shared_durable_session", `session '${canonical}' contains an unapproved pane`);
  const live = liveSeat(family.parent, canonical, snapshot);
  if (live) {
    if (family.lifetime) {
      if (!validateParentHarnessLifetime(family.lifetime))
        fail("target_changed", `parent '${family.owner}' live harness generation is not the approved one`);
    } else if (familyChildren(current, family.owner).length || !exitedParentHarness(family.parent)) {
      fail("target_changed", `parent '${family.owner}' live harness generation is not the approved one`);
    }
  }
  return live;
}

type ParentPane = ReturnType<typeof liveSeat>;
interface HardResult { ok: boolean; surviving: Set<string>; errorClass?: string; detail?: string; selfRequested: boolean }

function crewSurvives(binding: CrewLifetimeBinding): boolean {
  try { return validateCrewLifetimeBinding(binding); }
  catch { return false; }
}

function parentSurvival(family: Family, pane: ParentPane): "same" | "gone" | "unknown" {
  if (!pane) return "gone";
  try {
    const samePane = seatSnapshot().panes.some(p => p.id === pane.id && p.sessionId === pane.sessionId && p.rawEpoch === pane.rawEpoch);
    if (!samePane) return "gone";
    return family.lifetime ? (validateParentHarnessLifetime(family.lifetime) ? "same" : "unknown")
      : (exitedParentHarness(family.parent) ? "same" : "unknown");
  } catch { return "unknown"; }
}

/** Before a parent stop is attempted, the locked row still owns this pane
 * even if its foreground harness changed. That exact pane can be restored. */
function parentPaneStillExact(pane: NonNullable<ParentPane>): boolean {
  try { return seatSnapshot().panes.some(p => p.id === pane.id && p.session === pane.session
    && p.sessionId === pane.sessionId && p.rawEpoch === pane.rawEpoch); }
  catch { return false; }
}

/** Child cleanup can take long enough for the parent harness or session shape
 * to change. Reobserve both directly before the irreversible session stop. */
function parentReadyToStop(family: Family, pane: NonNullable<ParentPane>):
  { state: "ready" | "gone" | "changed" | "unknown"; detail: string } {
  try {
    const snapshot = seatSnapshot();
    const exact = snapshot.panes.some(p => p.id === pane.id && p.session === pane.session
      && p.sessionId === pane.sessionId && p.rawEpoch === pane.rawEpoch);
    if (!exact) return snapshot.panes.some(p => p.session === pane.session)
      ? { state: "changed", detail: `parent '${family.owner}' session changed after crew stop` }
      : { state: "gone", detail: "" };
    if (snapshot.panes.some(p => p.session === pane.session && p.id !== pane.id))
      return { state: "changed", detail: `parent '${family.owner}' session gained an unapproved pane after crew stop` };
    if (family.lifetime ? !validateParentHarnessLifetime(family.lifetime) : !exitedParentHarness(family.parent))
      return { state: "changed", detail: `parent '${family.owner}' harness generation changed after crew stop` };
    return { state: "ready", detail: "" };
  } catch (error) {
    return { state: "unknown", detail: `parent '${family.owner}' cannot be reobserved before stop: ${error}` };
  }
}

/** The registry lock spans publication and every guarded stop. No fresh crew
 * can register between the final family scan and its process effect. */
function stopPublishedFamily(family: Family, parentPane: ParentPane, self: boolean, onSelfStop: () => void): HardResult {
  const surviving = new Set<string>();
  const bindings = [...family.children.values()];
  for (const [index, binding] of bindings.entries()) {
    let stopped: ReturnType<typeof stopBoundCrewPane>;
    try {
      stopped = process.env.TAP_TEST_TEAM_OUT_CREW_STOP_FAIL === binding.crew
        ? { outcome: "failed", detail: "injected crew stop failure" } : stopBoundCrewPane(binding);
    } catch (error) { stopped = { outcome: "failed", detail: String(error) }; }
    if (stopped.outcome !== "stopped") {
      for (const pending of bindings.slice(index)) if (crewSurvives(pending)) surviving.add(pending.crew);
      if (parentPane && parentPaneStillExact(parentPane)) surviving.add(family.owner);
      return { ok: false, surviving, errorClass: "stop_partial",
        detail: `crew '${binding.crew}' ${stopped.outcome}: ${stopped.detail}`, selfRequested: false };
    }
    try { stopCrewLifetimeHelper(binding); } catch { /* verified stopped child is still retired */ }
  }
  if (!parentPane) return { ok: true, surviving, selfRequested: false };
  // Fault seam for the narrow race: a replacement foreground harness retains
  // the same registered pane after its last crew pane was stopped.
  if (process.env.TAP_TEST_TEAM_OUT_PARENT_GENERATION_CHANGE_AFTER_CREW === "1" && family.lifetime) {
    family.lifetime = { ...family.lifetime, process: { ...family.lifetime.process, start: "changed-after-crew" } };
  }
  const refuseChangedParent = (state: "changed" | "unknown", detail: string, selfRequested: boolean): HardResult => {
    if (parentPaneStillExact(parentPane)) surviving.add(family.owner);
    return { ok: false, surviving, errorClass: state === "unknown" ? "stop_unverified" : "target_changed",
      detail, selfRequested };
  };
  let fresh = parentReadyToStop(family, parentPane);
  if (fresh.state === "gone") return { ok: true, surviving, selfRequested: false };
  if (fresh.state !== "ready") return refuseChangedParent(fresh.state, fresh.detail, false);
  if (self) {
    try { onSelfStop(); }
    catch (error) {
      if (parentPaneStillExact(parentPane)) surviving.add(family.owner);
      return { ok: false, surviving, errorClass: "stop_partial",
        detail: `own stop receipt could not be published: ${error}`, selfRequested: false };
    }
  }
  // Self receipt emission is another interval in which the pane may change.
  if (self) {
    fresh = parentReadyToStop(family, parentPane);
    if (fresh.state === "gone") return { ok: true, surviving, selfRequested: true };
    if (fresh.state !== "ready") return refuseChangedParent(fresh.state, fresh.detail, true);
  }
  let detail = "";
  try {
    const effect = process.env.TAP_TEST_TEAM_OUT_PARENT_STOP_FAIL === "1"
      ? { code: 1, stderr: "injected parent stop failure", stdout: "" } : stopExactPane(parentPane);
    detail = effect.stderr.trim() || effect.stdout.trim();
  } catch (error) { detail = String(error); }
  const observed = parentSurvival(family, parentPane);
  if (observed === "same") {
    surviving.add(family.owner);
    return { ok: false, surviving, errorClass: "session_kill_failed",
      detail: `parent '${family.owner}' survived its guarded stop${detail ? `: ${detail}` : ""}`, selfRequested: self };
  }
  if (observed === "unknown") return { ok: false, surviving, errorClass: "stop_unverified",
    detail: `parent '${family.owner}' stop outcome is unobservable; retirement history retained`, selfRequested: self };
  return { ok: true, surviving, selfRequested: self };
}

function stopPublishedOrphan(binding: CrewLifetimeBinding, self: boolean, onSelfStop: () => void): HardResult {
  const surviving = new Set<string>();
  if (self) {
    try { onSelfStop(); }
    catch (error) {
      if (crewSurvives(binding)) surviving.add(binding.crew);
      return { ok: false, surviving, errorClass: "stop_partial",
        detail: `own stop receipt could not be published: ${error}`, selfRequested: false };
    }
  }
  let stopped: ReturnType<typeof stopBoundCrewPane>;
  try {
    stopped = process.env.TAP_TEST_TEAM_OUT_CREW_STOP_FAIL === binding.crew
      ? { outcome: "failed", detail: "injected crew stop failure" } : stopBoundCrewPane(binding);
  } catch (error) { stopped = { outcome: "failed", detail: String(error) }; }
  if (stopped.outcome !== "stopped") {
    if (crewSurvives(binding)) surviving.add(binding.crew);
    return { ok: false, surviving, errorClass: "stop_partial",
      detail: `orphan crew '${binding.crew}' ${stopped.outcome}: ${stopped.detail}`, selfRequested: self };
  }
  try { stopCrewLifetimeHelper(binding); } catch { /* verified stopped child is still retired */ }
  return { ok: true, surviving, selfRequested: self };
}

function restoreProvenSurvivors(ctx: ResolvedContext, retirement: ReturnType<typeof retireFamilyRows>,
  effect: HardResult): { restored: boolean; detail: string } {
  if (effect.surviving.size === 0) return { restored: true, detail: "" };
  try {
    const retained = restoreFamilyRows(ctx, retirement, effect.surviving);
    return { restored: true, detail: `; surviving registrations restored${retained.length ? `; history remains at ${retained.join(", ")}` : ""}` };
  } catch (error) {
    return { restored: false, detail: `; surviving registration restore failed; history retained: ${error}` };
  }
}

async function run(argv: string[]): Promise<number> {
  if (argv.includes("--json")) process.env.TAP_JSON = "1";
  const opts = parse(argv);
  const disposition = lifecycleDisposition("team", opts.hard ? "out-hard" : "out");
  if (!disposition.ok || disposition.row.registry !== "delete-row" || disposition.row.recovery !== "none"
    || disposition.row.crews !== "consume-d-contract"
    || tmuxFateStopsNamedSession(disposition.row) !== opts.hard) {
    fail("lifecycle_contract_invalid", "team out has no matching registered lifecycle fate");
  }
  let team: BoundTeam;
  try { team = boundTeam(resolveContext(process.cwd(), process.env,
    opts.team ? { explicitTeam: opts.team, readOnly: true } : { readOnly: true })); }
  catch (error) {
    if (!(error instanceof TapError) || !["unanchored_bus", "unknown_team"].includes(error.errorClass)) throw error;
    // A typed miss retains its exact selector refusal in machine contexts.
    // Only a human terminal may broaden it into a seeded discovery query.
    if (error.errorClass === "unknown_team" && (opts.json || process.env.TAP_JSON === "1"
      || !process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === "dumb")) throw error;
    const chosen = await chooseTeam("team out", error.errorClass === "unknown_team" ? opts.team : undefined, pick, opts.json);
    if (chosen.kind !== "selected") return chosen.kind === "interrupted" ? 130 : 0;
    team = chosen.value;
  }
  let current = rows(revalidateTeam(team));
  // This precedes the seat picker and preview. Consent cannot mint a lifetime
  // helper for a child that appeared while the operator was deciding.
  const originalCrew = new Map(Object.entries(current).filter(([, row]) => crew(row)));
  let selected: BoundCohort;
  if (opts.pending) {
    const result = await chooseSeatCohort("team out", team, opts.pending, pick, opts.json, true);
    if (result.kind !== "selected") return result.kind === "interrupted" ? 130 : 0;
    selected = result.value;
  } else selected = cohort(team, opts.selection, current);
  const handles = [...selected.seats.keys()];
  const approvedLifetimes = new Map<string, ParentHarnessLifetime | null>();
  for (const owner of handles) {
    if (poll(current[owner])) { approvedLifetimes.set(owner, null); continue; }
    // Discovery binds crew-bearing families at selection. A no-crew parent is
    // absent from that map, so capture its generation before preview/consent.
    if (selected.parentLifetimes?.has(owner)) { approvedLifetimes.set(owner, selected.parentLifetimes.get(owner)!); continue; }
    try { approvedLifetimes.set(owner, captureParentHarnessLifetime(team.context, owner)); }
    catch { approvedLifetimes.set(owner, null); }
  }
  const orphan = !opts.selection.mode && !opts.pending ? orphanChildren(current, new Set(handles)) : [];
  const boundOrphans = new Map<string, CrewLifetimeBinding>();
  for (const handle of orphan) {
    const binding = boundOrphan(team.context, current, handle);
    if (binding) boundOrphans.set(handle, binding);
  }
  const retainedOrphan = orphan.filter(handle => !boundOrphans.has(handle));
  const preview = { team: team.team, action: "out", hard: opts.hard, parents: handles,
    families: handles.map(owner => {
      try { return { owner, crew: familyChildren(current, owner) }; }
      catch (error) { return { owner, crew: [], refusal: error instanceof Error ? error.message : String(error) }; }
    }),
    bound_orphans: [...boundOrphans.keys()], orphan_retained: retainedOrphan,
    note: "Crews added to the same selected parent lifetime follow that parent" };
  if (!opts.json) {
    process.stdout.write(`tap team out ${team.team}: ${opts.hard ? "stop" : "retire"} ${handles.length} parent famil${handles.length === 1 ? "y" : "ies"}\n`);
    for (const family of preview.families) {
      process.stdout.write(`  ${family.owner}: ${family.crew.length ? `crew ${family.crew.join(", ")}` : "no crew"}${"refusal" in family ? `; ${family.refusal}` : ""}\n`);
    }
    process.stdout.write(opts.hard
      ? "  Processes: stop each selected parent session and its bound crew panes; preserve team enrollment and history.\n"
      : "  Processes: leave selected parents and crew running; preserve team enrollment and history.\n");
    if (preview.bound_orphans.length) process.stdout.write(`  Bound orphan crew: ${preview.bound_orphans.join(", ")} (${opts.hard ? "stop and retire" : "retire; supervision remains"})\n`);
    if (preview.orphan_retained.length) process.stdout.write(`  Retained orphan crew without a proven binding: ${preview.orphan_retained.join(", ")}\n`);
  }
  if (opts.dryRun) {
    const refusals: Array<{ owner: string; error_class: string; detail: string }> = [];
    for (const owner of handles) {
      try {
        const ctx = revalidateTeam(team);
        assertResetUnfenced(ctx.bus.home, "tap team out");
        const now = rows(ctx);
        selectedParentRow(now, selected.seats.get(owner)!, owner);
        const family = await prepareFamily(ctx, owner, now, approvedLifetimes.get(owner) ?? null, originalCrew, true);
        if (opts.hard) hardPreflight(ctx, family, now);
      } catch (error) {
        refusals.push({ owner, error_class: error instanceof TapError ? error.errorClass : "team_out_partial",
          detail: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const [handle, binding] of boundOrphans) {
      try {
        const ctx = revalidateTeam(team);
        assertResetUnfenced(ctx.bus.home, "tap team out");
        if (opts.hard) scratchOnlyGuard(process.env, "team out --hard would stop a crew pane on", ctx.bus.home, "tap team out");
        const now = rows(ctx);
        if (!now[handle] || !orphanBindingMatchesRow(binding, handle, now[handle]!)
          || !validateCrewLifetimeBinding(binding))
          fail("crew_lifetime_unprovable", `bound orphan '${handle}' changed before dry-run validation`);
      } catch (error) {
        refusals.push({ owner: handle, error_class: error instanceof TapError ? error.errorClass : "team_out_partial",
          detail: error instanceof Error ? error.message : String(error) });
      }
    }
    const failed = retainedOrphan.length + refusals.length;
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: failed === 0,
      ...(failed ? { error_class: "team_out_partial", action: "inspect retained crew registrations and family refusals" } : {}),
      dry_run: true, preview, families: refusals, retained_orphan: retainedOrphan })}\n`);
    else for (const refusal of refusals) process.stderr.write(`tap team out: ${refusal.owner}: ${refusal.detail}\n`);
    return failed ? 1 : 0;
  }
  if (handles.length === 0 && orphan.length === 0) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, team: team.team, hard: opts.hard, preview, families: [], retired: [] })}\n`);
    return 0;
  }
  // Direct supplied lists preserve their existing noninteractive behavior.
  if (!opts.yes && (opts.pending || !opts.selection.mode)) {
    if (!process.stdin.isTTY || opts.json) fail("confirmation_required", "pass --yes after reviewing the preview");
    if (!await confirmAction()) return 0;
  }
  let failed = retainedOrphan.length;
  const results: Array<{ owner: string; retired?: string[]; outcome?: string; error_class?: string; detail?: string }> = [];
  let selfReceiptEmitted = false;
  let selfStopReturned = false;
  const caller = observeCallingPane();
  const selfOrphan = opts.hard && caller.state === "inside"
    ? [...boundOrphans.keys()].find(handle => field(current[handle], "pane_id") === caller.paneId)
    : undefined;
  const processOrphan = (handle: string): void => {
    try {
      const ctx = revalidateTeam(team);
      assertResetUnfenced(ctx.bus.home, "tap team out");
      const now = rows(ctx);
      const row = now[handle];
      const binding = boundOrphans.get(handle)!;
      if (!row || !orphanBindingMatchesRow(binding, handle, row)
        || Object.keys(now).some(parent => !crew(now[parent]) && !poll(now[parent])
          && field(now[parent], "session") === binding.crewSession))
        fail("target_changed", `bound orphan '${handle}' changed ownership after preview`);
      if (!validateCrewLifetimeBinding(binding)) fail("crew_lifetime_unprovable", `bound orphan '${handle}' lost its process-lifetime helper`);
      const self = handle === selfOrphan;
      if (opts.hard) scratchOnlyGuard(process.env, "team out --hard would stop a crew pane on", ctx.bus.home, "tap team out");
      let effect: HardResult = { ok: true, surviving: new Set(), selfRequested: false };
      const retirement = retireFamilyRows(ctx, new Map([[handle, row!]]), latest => {
        const currentRow = latest.get(handle);
        if (!currentRow || !orphanBindingMatchesRow(binding, handle, currentRow)
          || [...latest.values()].some(other => !crew(other) && !poll(other)
            && field(other, "session") === binding.crewSession)
          || !validateCrewLifetimeBinding(binding))
          fail("target_changed", `bound orphan '${handle}' changed before retirement`);
        return [handle];
      }, { disposition, outcome: opts.hard ? "stop_requested" : "retired",
        afterPublish: opts.hard ? published => {
          effect = stopPublishedOrphan(binding, self, () => {
            const prior = [...results, { owner: handle, retired: published.retired, outcome: "stop_requested" }];
            const receipt = { ok: failed === 0,
              ...(failed ? { error_class: "team_out_partial", action: "inspect retained crew registrations and family refusals" } : {}),
              team: team.team, hard: true, preview, families: prior,
              retired: prior.flatMap(result => result.retired ?? []), pending_self_stop: handle };
            if (opts.json) process.stdout.write(`${JSON.stringify(receipt)}\n`);
            else process.stdout.write(`tap team out: ${handle} retired; own crew stop requested\n`);
            selfReceiptEmitted = true;
          });
        } : undefined });
      if (self && selfReceiptEmitted) selfStopReturned = true;
      if (!effect.ok) {
        const restore = restoreProvenSurvivors(ctx, retirement, effect);
        const detail = `${effect.detail ?? "stop failed"}${restore.detail}`;
        failed++;
        results.push({ owner: handle,
          retired: restore.restored ? retirement.retired.filter(h => !effect.surviving.has(h)) : retirement.retired,
          outcome: "partial", error_class: effect.errorClass, detail });
        if (!opts.json) process.stderr.write(`tap team out: ${handle}: ${detail}\n`);
        return;
      }
      results.push({ owner: handle, retired: retirement.retired, outcome: self ? "stop_requested" : opts.hard ? "stopped" : "retired" });
    } catch (error) {
      failed++;
      const detail = error instanceof Error ? error.message : String(error);
      results.push({ owner: handle, error_class: error instanceof TapError ? error.errorClass : "team_out_partial", detail });
      if (!opts.json) process.stderr.write(`tap team out: ${handle}: ${detail}\n`);
    }
  };
  for (const handle of boundOrphans.keys()) if (handle !== selfOrphan) processOrphan(handle);
  handles.sort((a, b) => {
    const aSelf = caller.state === "inside" && selected.seats.get(a)?.paneId === caller.paneId;
    const bSelf = caller.state === "inside" && selected.seats.get(b)?.paneId === caller.paneId;
    return Number(aSelf) - Number(bSelf);
  });
  for (const owner of handles) {
    try {
      const ctx = revalidateTeam(team);
      assertResetUnfenced(ctx.bus.home, "tap team out");
      current = rows(ctx);
      const approved = selected.seats.get(owner)!;
      selectedParentRow(current, approved, owner);
      const family = await prepareFamily(ctx, owner, current, approvedLifetimes.get(owner) ?? null, originalCrew);
      const self = opts.hard && caller.state === "inside" && approved.paneId === caller.paneId;
      const beforeRetirement = rows(ctx);
      const expected = new Map<string, Row>([[owner, family.parent],
        ...[...family.children.keys()].map(handle => [handle, beforeRetirement[handle]!] as [string, Row])]);
      let parentPane: ParentPane;
      let effect: HardResult = { ok: true, surviving: new Set(), selfRequested: false };
      const retirement = retireFamilyRows(ctx, expected, now => {
        const selected = validateFamily(family, now, opts.hard);
        if (opts.hard) parentPane = hardPreflight(ctx, family, Object.fromEntries(now) as Record<string, Seat>);
        return selected;
      }, { disposition, outcome: opts.hard ? poll(family.parent) ? "already_stopped" : "stop_requested" : "retired",
        afterPublish: opts.hard ? published => {
          effect = stopPublishedFamily(family, parentPane, self, () => {
            const prior = [...results, { owner, retired: published.retired, outcome: "stop_requested" }];
            const receipt = { ok: failed === 0,
              ...(failed ? { error_class: "team_out_partial", action: "inspect retained crew registrations and family refusals" } : {}),
              team: team.team, hard: true, preview, families: prior,
              retired: prior.flatMap(result => result.retired ?? []), pending_self_stop: owner };
            if (opts.json) process.stdout.write(`${JSON.stringify(receipt)}\n`);
            else process.stdout.write(`tap team out: ${published.retired.join(", ")} retired; own session stop requested\n`);
            selfReceiptEmitted = true;
          });
        } : undefined });
      if (self && selfReceiptEmitted) selfStopReturned = true;
      if (!effect.ok) {
        const restore = restoreProvenSurvivors(ctx, retirement, effect);
        const detail = `${effect.detail ?? "stop failed"}${restore.detail}`;
        failed++;
        results.push({ owner,
          retired: restore.restored ? retirement.retired.filter(h => !effect.surviving.has(h)) : retirement.retired,
          outcome: "partial", error_class: effect.errorClass, detail });
        if (!opts.json) process.stderr.write(`tap team out: ${owner}: ${detail}\n`);
        continue;
      }
      results.push({ owner, retired: retirement.retired, outcome: self && selfReceiptEmitted ? "stop_requested" : opts.hard ? "stopped" : "retired" });
    } catch (error) {
      failed++;
      const detail = error instanceof Error ? error.message : String(error);
      const errorClass = error instanceof TapError ? error.errorClass : "team_out_partial";
      results.push({ owner, error_class: errorClass, detail });
      if (!opts.json) process.stderr.write(`tap team out: ${owner}: ${detail}\n`);
    }
  }
  if (selfOrphan) processOrphan(selfOrphan);
  if (retainedOrphan.length && !opts.json) process.stderr.write(`tap team out: retained unbound crew rows: ${retainedOrphan.join(", ")}\n`);
  if (!selfReceiptEmitted || selfStopReturned) {
    const retired = results.flatMap(result => result.retired ?? []);
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: failed === 0,
      ...(failed ? { error_class: "team_out_partial", action: "inspect retained crew registrations and family refusals" } : {}),
      team: team.team, hard: opts.hard, preview,
      families: results, retired, retained_orphan: retainedOrphan })}\n`);
    else process.stdout.write(`tap team out: ${retired.length} registration${retired.length === 1 ? "" : "s"} retired; ${failed} retained/refused\n`);
  }
  return failed ? 1 : 0;
}

export function cmdTeamOut(argv: string[]): Promise<number> {
  return renderRefusalsAsync("tap team out", () => run(argv));
}
