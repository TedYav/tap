import { requireActingRegistry, resolveContext, TapError, type ResolvedContext } from "../context";
import { renderRefusalsAsync } from "../error-line";
import { validToken } from "../ids";
import { withActingRegistry } from "../registry-tx";
import { loadRegistry, seatMap } from "../registry";
import { ServerUnresponsive, tmux } from "../tmux";
import { crewSelectGate, rosterGate, scanOptionalSelection, selectAny, selectSummary, selectTyped, spared, type Selection } from "./selection";
import { assertBoundSeats, chooseSeatCohort, chooseTeam, confirmAction, discoveryTerminalAvailable, parentSeatSnapshot, readDiscoverySeats, type BoundCohort, type BoundTeam } from "./discovery";
import { pick } from "../fzf";

export interface DetachOptions { handle: string; selection: Selection; team?: string; pending?: "--only" | "--except"; yes?: boolean; dryRun?: boolean; bound?: BoundCohort }
const label = "tap team detach";
function fail(klass: string, detail: string, action = "tap help team detach"): never {
  throw new TapError(1, klass, action, detail, label);
}

export function parseDetachOptions(args: string[]): DetachOptions {
  const scanned = scanOptionalSelection("team detach", args);
  const out: DetachOptions = { handle: "", selection: scanned.selection, pending: scanned.pending };
  for (let i = 0; i < scanned.rest.length; i++) {
    const arg = scanned.rest[i];
    if (arg === "--handle") {
      const value = scanned.rest[++i];
      if (!value || !validToken(value)) fail("usage_error", "--handle needs one valid bare handle");
      out.handle = value;
    } else if (arg === "--yes") out.yes = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg && !arg.startsWith("-") && out.team === undefined) out.team = arg;
    else {
      fail(arg?.startsWith("--") ? "unknown_option" : "usage_error", `unexpected argument '${arg}'`);
    }
  }
  if (out.handle && (out.selection.mode === "--except" || out.pending === "--except")) fail("usage_error", "--handle and --except are opposite selectors — pick one");
  if (out.handle && (out.selection.mode === "--only" || out.pending === "--only")) fail("usage_error", "--handle and --only both name the seats to act on — pass one of them",
    "tap team detach --only <h,...>   (--handle targets one row; --only is session-granular)");
  return out;
}

export function runTeamDetach(ctx: ResolvedContext, options: DetachOptions, run = tmux, write = (line: string) => console.log(line)): number {
  const { handle, selection } = options;
  requireActingRegistry(ctx, 1);
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  let rows: ReturnType<typeof seatMap>;
  try { rows = seatMap(loadRegistry(ctx.registryPath)); }
  catch { return fail("registry_invalid", "acting registry unreadable", "tap doctor"); }
  const roster = Object.keys(rows).filter(h => object(rows[h])).sort();
  if (options.bound) assertBoundSeats(options.bound, rows);
  rosterGate("team detach", selection, roster);
  crewSelectGate("team detach", selection, ctx.registryPath);
  if (handle && (!Object.hasOwn(rows, handle) || !object(rows[handle]))) fail("not_found", `no registry row for '${handle}'`, "tap team");
  const sparedHere = (h: string, current: typeof rows): boolean => {
    if (!spared(h, selection)) return false;
    const child = current[h];
    if (selection.mode !== "--only" || !object(child) || child.crew !== true) return true;
    const session = child.session;
    const owners = Object.entries(current).filter(([, row]) => object(row) && row.crew !== true && row.session === session);
    return owners.length !== 1 || !selection.only.includes(owners[0]![0]);
  };
  const groups = new Map<string, string[]>();
  const counts = { detached: 0, already_detached: 0, session_gone: 0, no_session: 0, excluded: 0 };
  for (const h of handle ? [handle] : roster) {
    const row = rows[h]!;
    const session = typeof row.session === "string" ? row.session : "";
    if (row.delivery === "poll" || !session) {
      const result = sparedHere(h, rows) ? "excluded" : "no_session";
      counts[result]++; write(`${label}: ${h}  ${result}`);
    } else groups.set(session, [...(groups.get(session) ?? []), h]);
  }
  if (options.dryRun) {
    for (const [session, handles] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      write(`${label}: ${handles.join(",")}  session=${session}  ${handles.some(h => sparedHere(h, rows)) ? "excluded" : "would_detach"}`);
    }
    write(`${label}: dry-run; no viewer was detached`);
    return 0;
  }
  for (const [session, handles] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    if (handles.some(h => sparedHere(h, rows))) {
      counts.excluded++; write(`${label}: ${handles.join(",")}  session=${session}  excluded`); continue;
    }
    let result: "late_spared" | "session_gone" | "already_detached" | "detached";
    try {
      result = withActingRegistry(ctx, (doc, current) => {
        if (options.bound) assertBoundSeats(options.bound, current);
        // Keep the lock through the tmux action: a spared co-tenant cannot join
        // between this reread and detach-client. --handle intentionally targets a row.
        // withActingRegistry refuses a registry deleted after planning.
        if (Object.entries(current).some(([h, row]) => object(row) && row.session === session && sparedHere(h, current))) return "late_spared";
        if (run(["has-session", "-t", `=${session}`]).code !== 0) return "session_gone";
        const clients = run(["list-clients", "-t", `=${session}`, "-F", "#{client_tty}"]);
        if (clients.code !== 0) fail("tmux_error", `could not inspect clients of '${session}'`);
        if (!clients.stdout.trim()) return "already_detached";
        if (run(["detach-client", "-s", `=${session}`]).code !== 0) fail("tmux_error", `could not detach clients from session '${session}'`);
        return "detached";
      });
    } catch (error) {
      if (error instanceof TapError || error instanceof ServerUnresponsive) throw error;
      return fail("registry_invalid", `acting registry unreadable (session ${session})`, "tap doctor");
    }
    if (result === "late_spared") {
      counts.excluded++; write(`${label}: ${handles.join(",")}  session=${session}  excluded (late co-tenant joined after planning)`);
    } else {
      counts[result]++; write(`${label}: ${handles.join(",")}  session=${session}  ${result}`);
    }
  }
  const actionable = counts.detached + counts.already_detached + counts.session_gone;
  if (selectAny(selection) && counts.excluded && !actionable) write(`${label}: no seats matched after ${selectSummary(selection)}`);
  else if (selection.mode === "--only" && !counts.excluded) write(`${label}: --only ${selectTyped(selection)} matched every seat — none spared`);
  write(`${label}: ${Object.entries(counts).map(([key, count]) => `${key}=${count}`).join(" ")}`);
  return 0;
}

export function cmdTeamDetach(args: string[]): Promise<number> {
  return renderRefusalsAsync(label, async () => {
    const options = parseDetachOptions(args);
    let ctx: ResolvedContext;
    let boundTeam: BoundTeam;
    let chosenTeam = false;
    try {
      ctx = resolveContext(process.cwd(), process.env, options.team ? { explicitTeam: options.team, readOnly: true } : { readOnly: true });
      boundTeam = { team: ctx.team, root: ctx.root, registryPath: ctx.registryPath, context: ctx };
    } catch (error) {
      if (!(error instanceof TapError) || !((error.errorClass === "unknown_team" && discoveryTerminalAvailable())
        || (!options.team && error.errorClass === "unanchored_bus"))) throw error;
      const choice = await chooseTeam("team detach", options.team, pick);
      if (choice.kind === "cancelled") { process.stdout.write(`${label}: cancelled\n`); return 0; }
      if (choice.kind === "interrupted") return 130;
      boundTeam = choice.value; ctx = boundTeam.context;
      chosenTeam = true;
    }
    if (options.pending) {
      const choice = await chooseSeatCohort("team detach", boundTeam, options.pending, pick);
      if (choice.kind === "cancelled") { process.stdout.write(`${label}: cancelled\n`); return 0; }
      if (choice.kind === "interrupted") return 130;
      options.bound = choice.value;
      options.selection = choice.value.selection;
      if (options.bound.seats.size === 0) { process.stdout.write(`${label}: no seats selected\n`); return 0; }
      runTeamDetach(ctx, { ...options, dryRun: true });
      if (options.dryRun) return 0;
      if (!options.yes && !(await confirmAction())) { process.stdout.write(`${label}: cancelled\n`); return 0; }
    } else if (chosenTeam) {
      if (options.handle) {
        const row = readDiscoverySeats(boundTeam.registryPath)[options.handle];
        if (!row) fail("not_found", `no registry row for '${options.handle}'`, "tap team");
        const instance = typeof row.instance === "string" ? row.instance : "";
        if (!instance) fail("target_unbound", `seat '${options.handle}' has no instance`, "tap team doctor");
        options.bound = { team: boundTeam, seats: new Map([[options.handle, { handle: options.handle, instance,
          session: String(row.session ?? ""), paneId: String(row.pane_id ?? ""), serverEpoch: String(row.server_epoch ?? "") }]]),
          selection: options.selection, original: options.selection };
      } else {
        rosterGate("team detach", options.selection, Object.keys(readDiscoverySeats(boundTeam.registryPath)));
        crewSelectGate("team detach", options.selection, boundTeam.registryPath);
        const chosen = parentSeatSnapshot(boundTeam).filter(row => !spared(row.handle, options.selection));
        options.bound = { team: boundTeam, seats: new Map(chosen.map(row => [row.handle, row])),
          selection: { mode: "--only", only: chosen.map(row => row.handle), except: [] }, original: options.selection };
        options.selection = options.bound.selection;
      }
      if (!options.bound.seats.size) { process.stdout.write(`${label}: no seats selected\n`); return 0; }
      runTeamDetach(ctx, { ...options, dryRun: true });
      if (options.dryRun) return 0;
      if (!options.yes && !(await confirmAction())) { process.stdout.write(`${label}: cancelled\n`); return 0; }
    } else if (options.dryRun) return runTeamDetach(ctx, options);
    return runTeamDetach(ctx, options);
  });
}

if (import.meta.main) cmdTeamDetach(process.argv.slice(2)).then(code => { process.exitCode = code; });
