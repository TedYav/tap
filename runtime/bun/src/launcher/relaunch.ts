import { LaunchInterrupted, withLaunchSignals } from "./transaction";
import { applyOverrides, type Overrides } from "./overrides";
import { TapError } from "../context";
import { loadGlobalRegistry } from "../index-home";
import { teamRegistryRefusal } from "../register-authority";
import { pyReadUtf8 } from "../spool-publication";
import { observe, observedRows, type RegistryRow } from "../verbs/team";
import { tmuxReadOnly } from "../tmux";
import { relaunchCrew, seats, teamContext } from "../crew-lifecycle";
import { HARNESSES } from "./catalog";
import { SESSION_RELAUNCH_HELP } from "../help";
import { lifecycleDiagnostic } from "../lifecycle-diagnostics";
import { LauncherError } from "./types";
import { validateLaunchWorkdir } from "./workdir";
import { relaunchContext, prepareRelaunch, relaunchOne, type MemberResult } from "./relaunch-durable";
import { tapScriptsDir } from "../scripts-dir";

const scripts = tapScriptsDir();
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
export interface Options { seat?: string; harness?: string; team?: string; message?: string; workdir?: string; json: boolean; dryRun: boolean; overrides?: Overrides }
export interface Exclusion { team: string; handle: string; reason: string }
export interface Member { team: string; handle: string; root: string; team_doc: Record<string, unknown>; row: Record<string, any>; expect?: Record<string, unknown>; expect_resume?: string | null; prepare_error?: string }
export function parseOptions(argv: string[]): Options {
  const out: Options = { json: process.env.TAP_JSON === "1", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      (out.overrides ??= {}).argv = argv.slice(i + 1);
      break;
    }
    // Mirror the env gate so a --json caller never takes the interactive
    // custody auto-wait or its stderr progress (tap-7t3ag), as crew/out do.
    if (arg === "--json") { out.json = true; process.env.TAP_JSON = "1"; }
    else if (arg === "--dry-run") out.dryRun = true;
    else if (["--harness", "--team", "-m", "--message", "--workdir", "--env", "--unset-env"].includes(arg.split("=")[0]!)) {
      const key = arg.split("=")[0]!;
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      if (value === undefined) throw new Error(`${key} needs a value`);
      // A path never swallows the next option: `--workdir --dry-run` must refuse, not drop the dry run and go live.
      if (key === "--workdir" && !arg.includes("=") && value.startsWith("-")) throw new Error(`--workdir needs a value, got the option ${value}; write --workdir=<path> for a path that starts with -`);
      if (key === "--env" || key === "--unset-env") {
        const field = key === "--env" ? "env" : "unset_env";
        ((out.overrides ??= {})[field] ??= []).push(value);
      } else if (key === "--harness") out.harness = value;
      else if (key === "--team") out.team = value.trim();
      else if (key === "--workdir") out.workdir = value;
      else out.message = value;
    } else if (!arg.startsWith("-") && !out.seat) out.seat = arg;
    else throw new Error(`unexpected argument ${arg}`);
  }
  if (!!out.seat === !!out.harness) throw new Error("supply a team/handle OR --harness <claude|codex|cursor|opencode>");
  if (out.harness && !["claude", "codex", "cursor", "opencode"].includes(out.harness)) throw new Error("unsupported relaunch harness");
  if (out.workdir !== undefined && !out.seat) throw new Error("--workdir applies to a single-seat relaunch; supply [team/]handle");
  if (out.team === "") throw new Error("empty --team refuses; use a team name or '*' for all teams");
  if (out.seat && (!/^[^/\s]+(?:\/[^/\s]+)?$/.test(out.seat) || out.team !== undefined)) throw new Error("single-seat relaunch requires [team/]handle without --team");
  if (out.overrides) applyOverrides({}, out.overrides);
  return out;
}

/** One authority snapshot; unreadable teams remain visible in the structured receipt.
 * The default reader refuses invalid UTF-8 and a leading BOM: `readFileSync(path, "utf8")` turns a bad
 * byte into U+FFFD, so a mangled registry would parse and relaunch seats from it. */
export function census(options: Options, scope: string, teams: Record<string, unknown>, read = (path: string) => JSON.parse(pyReadUtf8(path))): { members: Member[]; skipped_teams: Exclusion[]; excluded_inactive: Exclusion[] } {
  const members: Member[] = [], skipped_teams: Exclusion[] = [], excluded_inactive: Exclusion[] = [];
  const target = options.seat?.split("/");
  if (scope !== "*" && !Object.hasOwn(teams, scope)) throw new Error(`team '${scope}' is not enrolled`);
  for (const [team, enrollment] of Object.entries(teams).sort(([a], [b]) => a.localeCompare(b))) {
    if (scope !== "*" && team !== scope) continue;
    const skip = (reason: string) => skipped_teams.push({ team, handle: "*", reason });
    if (!object(enrollment)) { skip("invalid enrollment"); continue; }
    if (enrollment.state === "historical") { skip("historical team"); continue; }
    if (typeof enrollment.registry_location !== "string" || typeof enrollment.root !== "string") { skip("missing registry location or root"); continue; }
    let doc;
    try { doc = read(enrollment.registry_location); }
    catch (error) { skip(`registry unreadable: ${String(error)}`); continue; }
    const oldStore = teamRegistryRefusal(enrollment.registry_location, doc);
    if (oldStore) { skip(`old_store: ${oldStore.detail}`); continue; }
    const seats = object(doc) && doc.seats;
    if (!object(seats)) { skip("registry has no seats map"); continue; }
    for (const [handle, row] of Object.entries(seats).sort(([a], [b]) => a.localeCompare(b))) {
      const exclude = (reason: string) => excluded_inactive.push({ team, handle, reason });
      if (!object(row)) { exclude("invalid seat row"); continue; }
      if (typeof row.harness !== "string" || !HARNESSES.includes(row.harness)) { exclude("unknown harness"); continue; }
      if (target && handle !== target[1]) continue;
      if (options.harness && row.harness !== options.harness) { exclude("harness mismatch"); continue; }
      if (row.delivery === "poll") { exclude("poll"); continue; }
      members.push({ team, handle, row, root: enrollment.root, team_doc: object(doc.team) ? doc.team : {} });
    }
    if (target && !Object.hasOwn(seats, target[1]!)) throw new TapError(1, "unknown_seat", `tap team roster ${team}`, `seat '${options.seat}' is not registered`);
  }
  return { members, skipped_teams, excluded_inactive };
}

/** Exactly the roster observation and socket-namespace policy, without preset/UI work. */
export function classify(members: Member[], diagnostics: string[]): { member: Member; status: string; reason: string; pane: string }[] {
  const rows = members.map((m, i) => ({ ...m.row, team: m.team, handle: String(i),
    status: m.row.status ?? "active", delivery: m.row.delivery || "pane" } as RegistryRow));
  if (!rows.length) return [];
  const observation = observe(rows, scripts, false, text => diagnostics.push(text));
  if (observation.code !== 0) throw new Error("seat classifier failed; run tap doctor");
  const socket = rows.some(row => row.server_socket) ? tmuxReadOnly(["display-message", "-p", "#{socket_path}"]) : null;
  const currentSocket = socket?.code === 0 && socket.stdout.trim().startsWith("/") ? socket.stdout.trim() : "";
  return observedRows(rows, observation.rows, observation.serverEpoch, {}, currentSocket).map(row => ({
    member: members[Number(row.handle)]!, status: row.status, reason: row.statusReason, pane: row.observedPaneId,
  }));
}

const short = (text: string, limit = 140) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\r\n\x00-\x1f\x7f]+/g, " ").trim().slice(0, limit);
/** A live crew row relaunches fresh in its own pane, in-process; durable rows resume through the native replacement core. */
async function crew(member: Member, callerPane: string, options: Options, signal?: AbortSignal, progress?: (line: string) => void): Promise<MemberResult> {
  try {
    // A fresh crew process has no conversation to instruct and no resume argv to amend.
    if (options.message !== undefined || options.overrides || options.workdir !== undefined) {
      return { code: 2, reason: "-m, --workdir, --env, --unset-env and harness flags do not apply to a fresh crew relaunch; relaunch crew without them" };
    }
    const ctx = teamContext(member.team, false);
    if (ctx.root !== member.root) return { code: 2, reason: `team ${member.team} enrollment changed since selection; nothing was replaced` };
    await relaunchCrew(ctx, seats(ctx), member.handle, callerPane, { dryRun: options.dryRun, expect: member.row, signal, progress });
    return { code: 0 };
  } catch (error) {
    return error instanceof TapError ? { code: error.code, reason: `${error.detail}; next: ${error.action}` }
      : { code: 1, reason: String((error as Error).message ?? error) };
  }
}

const isCrewRow = (m: Member): boolean => m.row.crew === true || m.row.crew === 1;

export async function relaunch(options: Options, deps = { context: relaunchContext, prepare: prepareRelaunch, run: relaunchOne, classify, crew, load: loadGlobalRegistry, write: (text: string) => { process.stdout.write(text); }, color: !!process.stdout.isTTY }, signal?: AbortSignal): Promise<number> {
  const context = deps.context();
  if (options.seat && !options.seat.includes("/")) {
    if (!context.team) throw new Error("current team unresolved; pass team/handle");
    options = { ...options, seat: `${context.team}/${options.seat}` };
  }
  const scope = options.seat?.split("/")[0] ?? options.team ?? context.team;
  if (!scope) throw new Error("current team unresolved; pass --team <name> or --team='*'");
  const global = deps.load();
  if (global.marker !== "live") throw new Error("global registry unreadable; run tap doctor");
  const data = census(options, scope, (global.doc?.teams ?? {}) as Record<string, unknown>);
  // An explicit --workdir is checked while resolving the target, before the active/self exclusions can
  // drop the seat: a mistyped repair command must refuse, not report "nothing to relaunch".
  const teamRoot = ((global.doc?.teams as Record<string, any> | undefined)?.[scope] ?? {}).root;
  if (options.workdir !== undefined) {
    // An explicit repair must be provable: a team whose root cannot be read would otherwise skip the check
    // and return a quiet empty census for a path nobody validated.
    if (typeof teamRoot !== "string" || !teamRoot) throw new TapError(2, "invalid_workdir", "tap doctor",
      `--workdir cannot be validated: team '${short(scope)}' has no provable root in the machine index`);
    try { validateLaunchWorkdir(teamRoot, options.workdir); }
    catch (error) {
      if (error instanceof LauncherError) throw new TapError(2, error.errorClass ?? "invalid_workdir", error.action ?? "tap help session", error.detail ?? error.message);
      throw error;
    }
  }
  const diagnostics: unknown[] = [context];
  const classifierDiagnostics: string[] = [];
  const selected: Member[] = [];
  const excluded_caller: Exclusion[] = [];
  for (const observed of deps.classify(data.members, classifierDiagnostics)) {
    const { team, handle } = observed.member;
    if (observed.status !== "active") data.excluded_inactive.push({ team, handle, reason: observed.reason || observed.status });
    else if (context.caller_pane && observed.pane === context.caller_pane) excluded_caller.push({ team, handle, reason: "caller-pane" });
    else selected.push(observed.member);
  }
  diagnostics.push(...classifierDiagnostics);
  const label = options.harness ? `${options.harness} seats` : "seats";
  const where = scope === "*" ? "on all teams" : `on team ${short(scope)}`;
  if (!options.json) deps.write(selected.length
    ? `${options.dryRun ? "Would relaunch" : "Relaunching"} ${selected.length} active ${label} ${where}\n`
    : `No active ${label} ${where}; nothing to relaunch.\n`);
  // Crew rows have no conversation to resume.
  const durable = selected.filter(m => !isCrewRow(m));
  const prepared = deps.prepare(durable);
  // Finish the census's resume identities before any replacement starts. The
  // native core binds these expectations to its stamp and pre-respawn checks.
  const runMember = async (member: Member) => {
    const crewMember = isCrewRow(member);
    const i = durable.indexOf(member);
    let result: MemberResult;
    try {
      result = signal?.aborted
        ? { code: signal.reason instanceof LaunchInterrupted ? signal.reason.exitCode : 130,
          error_class: "relaunch_interrupted", reason: "interrupted before replacement; nothing was replaced" }
        : crewMember ? await deps.crew(member, context.caller_pane ?? "", options, signal, options.json ? undefined : line => deps.write(`  ${short(member.team)}/${short(member.handle)}: ${short(line)}\n`))
        : !prepared[i] || prepared[i]?.prepare_error
        ? { code: 1, reason: prepared[i]?.prepare_error || "resume census failed" }
        : await deps.run(prepared[i]!, options, context.caller, { signal, progress: options.json ? undefined : line => deps.write(`  ${short(member.team)}/${short(member.handle)}: ${short(line)}\n`) });
    } catch (error) { result = { code: error instanceof LaunchInterrupted ? error.exitCode : 1, reason: String(error) }; }
    const code = result.code ?? 1;
    const errorLine = result.stderr?.trim().split("\n").findLast(line => line.startsWith("tap session relaunch:"));
    const reason = code === 0 ? "" : short(result.reason || errorLine || result.stderr || `exit ${code}; inspect the pane`, Infinity);
    if (!options.json) {
      for (const warning of (result.stderr ?? "").split("\n").filter(line => line.includes(": WARNING:") || line.startsWith("tap: receipt folder "))) {
        deps.write(`  ${short(member.team)}/${short(member.handle)}: ${short(warning, Infinity)}\n`);
      }
      const dot = deps.color && process.env.NO_COLOR === undefined && !options.dryRun ? `\x1b[${code === 0 ? 32 : 31}m●\x1b[0m` : "●";
      deps.write(`${dot} ${short(member.team)}/${short(member.handle)}${code === 0 ? "" : ` — ${short(reason || "replacement failed", Infinity)}`}\n`);
      if (options.dryRun && result.workdir) deps.write(`  ${short(member.team)}/${short(member.handle)}: would respawn in ${short(result.workdir, Infinity)} and record it as launch_workdir\n`);
    }
    return { ...result, team: member.team, handle: member.handle, code, reason, status: code !== 0 ? "failed" : crewMember ? (options.dryRun ? "would-replace" : "replaced") : options.dryRun ? "would-resume" : "resumed" };
  };
  // Bound concurrent replacements as the incumbent batch did.
  const results: Awaited<ReturnType<typeof runMember>>[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, selected.length) }, async () => {
    while (next < selected.length) {
      const i = next++;
      results[i] = await runMember(selected[i]!);
    }
  }));
  // With --workdir the single-seat member's exit 7 is a post-effect state (already respawned, never retry); collapsing it to 1 invites a second replacement. Every other relaunch keeps its pinned exit 1.
  // A failed respawn-pane passes tmux's RAW status through as tmux_error: a raw 7 there failed BEFORE any effect, so it is the pre-effect 1.
  const postEffect = !!options.seat && options.workdir !== undefined && results.length === 1 && results[0]!.code === 7 && results[0]!.error_class !== "tmux_error";
  // An interruption after the respawn whose required row write failed is still that post-effect 7, not the signal's 130/143.
  const code = signal?.aborted ? (postEffect && results[0]!.error_class === "launch_workdir_unpersisted" ? 7 : signal.reason instanceof LaunchInterrupted ? signal.reason.exitCode : 130)
    : results.some(result => result.code !== 0) ? (postEffect ? 7 : 1) : 0;
  const receipt = { ok: code === 0, code, harness: options.harness ?? null, team: scope, dry_run: options.dryRun,
    candidates: selected.length, results, excluded_inactive: data.excluded_inactive, skipped_teams: data.skipped_teams,
    excluded_caller, counts: { candidates: selected.length, excluded_inactive: data.excluded_inactive.length,
      skipped_teams: data.skipped_teams.length, excluded_caller: excluded_caller.length }, diagnostics };
  // File-only and opt-in, and ONLY structured verdicts. `reason` (and a result's stdout/stderr) is free
  // text: a worker's stderr, a raw exception, a reader error naming a path. The shared writer redacts
  // by key and known secret shapes, not arbitrary prompt text, so no free text crosses this boundary.
  // Console and --json stay complete.
  // One summary row, then one small row per result, exclusion and skipped team: the shared writer
  // truncates arrays at 20 and drops any row that reaches 4096 bytes, and a machine-wide relaunch can
  // exceed both, so a batched row would silently lose the tail.
  lifecycleDiagnostic("relaunch", { ok: receipt.ok, code, harness: receipt.harness, team: scope, dry_run: options.dryRun,
    candidates: selected.length, counts: receipt.counts });
  for (const { team, handle, status, code: memberCode, error_class, elapsed } of results) {
    lifecycleDiagnostic("relaunch_result", { team, handle, status, code: memberCode, error_class, elapsed });
  }
  for (const { team, handle } of data.excluded_inactive) lifecycleDiagnostic("relaunch_excluded", { team, handle, kind: "inactive" });
  for (const { team, handle } of excluded_caller) lifecycleDiagnostic("relaunch_excluded", { team, handle, kind: "caller" });
  for (const { team } of data.skipped_teams) lifecycleDiagnostic("relaunch_skipped_team", { team });
  if (options.json) deps.write(JSON.stringify(receipt) + "\n");
  return code;
}

/** The former worker boundary muted transport diagnostics; keep one command receipt. */
export async function cmdSessionRelaunch(argv: string[]): Promise<number> {
  const previous = process.env.TAP_VERBOSE;
  process.env.TAP_VERBOSE = "0";
  try { return await runRelaunchCommand(argv); }
  finally {
    if (previous === undefined) delete process.env.TAP_VERBOSE;
    else process.env.TAP_VERBOSE = previous;
  }
}

async function runRelaunchCommand(argv: string[]): Promise<number> {
  const ownArgv = argv.slice(0, argv.includes("--") ? argv.indexOf("--") : argv.length);
  if (ownArgv.some(arg => arg === "--help" || arg === "-h")) {
    process.stdout.write(SESSION_RELAUNCH_HELP);
    return 0;
  } else {
    try { return await withLaunchSignals(signal => relaunch(parseOptions(argv), undefined, signal)); }
    catch (error) {
      const detail = short(error instanceof TapError ? error.detail : String(error));
      const code = error instanceof LaunchInterrupted ? error.exitCode : error instanceof TapError ? error.code : 2;
      const action = error instanceof TapError ? error.action : "tap help session";
      if (ownArgv.includes("--json") || process.env.TAP_JSON === "1") console.log(JSON.stringify({ ok: false, code, error_class: error instanceof TapError ? error.errorClass : "session_error", detail, action }));
      else console.error(`tap session relaunch: ${detail}; next: ${action}`);
      return code;
    }
  }
}

if (import.meta.main) process.exitCode = await cmdSessionRelaunch(process.argv.slice(2));
