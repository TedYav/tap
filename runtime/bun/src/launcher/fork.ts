// `tap session fork <seat> [<new-name>]`: a NEW seat on the same team, in its own
// tmux session, carrying the source seat's conversation through the harness's
// native fork. The source is only read: no keystroke reaches its pane and its
// registry row is never written. Naming and collisions are launch's
// (makeNewRecord); effects are the shared launchTransaction as kind "new" with
// ensure_action "fork", so the fork registers as a launcher-new identity.
import { reservedSeatName } from "../ids";
import { startupTrace, withStartupTrace } from "../startup-trace";
import { beginLifecycleOperation } from "../lifecycle-diagnostics";
import { FORKABLE_HARNESSES, forkSourceFingerprint, storedForkConflict } from "../harness-families";
import { freshLaunchSessionId } from "./adapters";
import { detachedReceipt } from "./attach-policy";
import { Notices } from "./catalog-notices";
import { currentBootId } from "./generation";
import { makeNewRecord, requireLaunchCommands, type LaunchDeps, type Resolved } from "./new";
import { callerHasTty, callerTty, exitKeepingTerminal, promptChoice } from "./prompt";
import { realOrSelf, rootForCwd } from "./records";
import { timestamp } from "./repair";
import { attachTailInProcess, baseAlias, receipt, registryEntry, unexpiredSeats } from "./resume";
import { sessionNameForHandle } from "./naming";
import { verifiedSession } from "./observation";
import { HARNESSES } from "./catalog";
import { tmuxSessionNamespace } from "../tmux";
import { resolvedResumeIdentity, reviveTier } from "./resume-identity";
import { cloneRecord, commandSummary, compact, errorLine, refuseIfFlipAuthority, refuseIfResetFenced, registryState, render, SCRIPTS } from "./resume-prelude";
import { LaunchCommandError } from "./process";
import { shlexQuote } from "./invocation";
import { launchHandle, launchTransaction, recordFromRow, withLaunchSignals, type LaunchRecord } from "./transaction";
import { LauncherError } from "./types";
import { FORK_HELP, FORK_USAGE as USAGE } from "../help";

const HANDLE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;


/** Launch's effects plus its prerequisite check, which a test may replace. */
/** expectedSource: the launch collision menu's checked source (forkSourceFingerprint); a different one refuses. */
export type ForkDeps = LaunchDeps & { requireCommands?: (harness: string) => void; expectedSource?: string };

export interface ForkOptions { source: string; name: string | null; dryRun: boolean; json: boolean; help: boolean }

const usage = (detail: string): never => { throw new LauncherError(detail, "usage_error", "tap session fork --help", `${detail}; ${USAGE}`); };

export function parseFork(argv: string[]): ForkOptions {
  const options: ForkOptions = { source: "", name: null, dryRun: false, json: process.env.TAP_JSON === "1", help: false };
  const positionals: string[] = [];
  let literal = false;
  for (const arg of argv) {
    if (literal || arg === "-" || !arg.startsWith("-")) { positionals.push(arg); continue; }
    if (arg === "--") literal = true;
    else if (arg === "--help" || arg === "-h") { options.help = true; return options; }
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--json") options.json = true;
    else usage("unrecognized option");
  }
  if (!positionals.length) usage("name the seat to fork");
  if (positionals.length > 2) usage("too many arguments");
  options.source = positionals[0]!;
  options.name = positionals[1] ?? null;
  return options;
}

/** The action that answers "this harness cannot fork from the CLI". */
function unsupportedAction(harness: string, handle: string): string {
  return harness === "opencode" ? `OpenCode 2 TUI has no CLI fork; native API support is tracked in tap-ki7uw. Use the session menu in OpenCode`
    : harness === "hermes" ? `tap session launch hermes <new-name> starts a fresh seat`
    : `tap attach ${handle}, then run /fork inside the seat`;
}

export { forkConflictingFlag } from "../harness-families";

/** Everything the fork decides before any effect: source, identity, name, recipe. */
export async function planFork(options: ForkOptions, cwd: string, deps: ForkDeps): Promise<LaunchRecord> {
  refuseIfResetFenced(cwd, "session fork");
  refuseIfFlipAuthority(cwd, "tap session fork");
  const state = registryState(cwd);
  const base = baseAlias(state, cwd);
  const slash = options.source.indexOf("/");
  if (slash >= 0 && options.source.slice(0, slash) !== base) {
    throw new LauncherError("fork stays on the current team", "fork_other_team", `run tap session fork from team ${options.source.slice(0, slash)}'s checkout`,
      `'${options.source}' is not on this team (${base}); a fork lands on its source's team`);
  }
  const handle = slash >= 0 ? options.source.slice(slash + 1) : options.source;
  const row = state.entries.get(handle);
  if (!row) throw new LauncherError(`no seat '${handle}'`, "unknown_seat", "tap team", `no seat '${handle}' on team ${base}`);
  const harness = String(row.harness ?? "");
  if (!FORKABLE_HARNESSES.includes(harness)) {
    throw new LauncherError(`${harness} cannot fork from the CLI`, "fork_unsupported", unsupportedAction(harness, handle),
      `seat '${handle}' runs ${harness || "an unknown harness"}, whose CLI has no fork; nothing was launched`);
  }
  // Missing tmux or harness CLI refuses before the first tmux probe or any reservation, as launch does.
  if (!options.dryRun) deps.requireCommands?.(harness);
  const team = state.team as Record<string, unknown>;
  const conflict = storedForkConflict(harness, row);
  if (conflict) {
    throw new LauncherError(`stored ${conflict} conflicts with the fork`, "fork_recipe_conflict", `tap session fork --help`,
      `seat '${handle}' stores harness flag ${conflict}, which would override the fork's own conversation selection; nothing was launched`);
  }
  const source = recordFromRow(handle, row, team, rootForCwd(cwd));
  if (!source) throw new LauncherError(`seat '${handle}' has no launch recipe`, "launch_recipe_missing", "tap session launch",
    `seat '${handle}' has no launch recipe of its own to fork`);
  const sourceId = resolvedResumeIdentity(source, process.env);
  if (!sourceId) {
    throw new LauncherError(`seat '${handle}' has no resumable conversation id`, "no_exact_resume_identity",
      `run tap in from ${handle}'s live pane so it records its session id, then retry`,
      `seat '${handle}' (${harness}) has no resumable conversation id (revive tier '${reviveTier(harness, source.harness_session_id)}'); fork will not start a different conversation`);
  }
  if (deps.expectedSource !== undefined && forkSourceFingerprint(row, sourceId) !== deps.expectedSource) {
    throw new LauncherError(`seat '${handle}' changed`, "fork_source_changed", `tap session fork ${options.source}${options.name ? ` ${options.name}` : ""}`,
      `seat '${handle}' was cleared, restarted or replaced while the fork was being chosen; nothing was launched`);
  }
  const name = options.name ?? `${handle}-fork`;
  if (!HANDLE_RE.test(name)) usage(`new seat name '${name}' must use letters, digits, '.', '_' or '-'`);
  if (reservedSeatName(name)) usage(`'${name}' ${reservedSeatName(name)} and cannot name a seat`);
  // Launch reads a harness name as "no tag" and allocates a suffix; a fork's name is always literal.
  if (HARNESSES.includes(name)) usage(`'${name}' names a harness; choose a seat name`);
  // Launch's [k] would stop the incumbent: the source's handle and session must never be the collision
  // (a crew seat can share its lead's session).
  // The pane-verified session too: a renamed tmux session leaves stale strings on the row.
  const sourceSessions = new Set([source.name, String(row.pane ?? "").split(":")[0], await verifiedSession(row, process.env) ?? ""].filter(Boolean));
  const refuseSource = () => {
    throw new LauncherError("fork cannot reuse the source's name", "fork_target_is_source", `tap session fork ${handle} <new-name>`,
      `'${name}' names the source seat or its session; a fork needs its own name so the source keeps running untouched`);
  };
  if (name === handle || sourceSessions.has(sessionNameForHandle(base, name))) refuseSource();
  // Without a terminal (or under --json, whose one-object contract a chooser would break),
  // launch's chooser refuses with launch-shaped recovery; say the fork-shaped one.
  if (options.json || !deps.hasTty()) {
    const namespace = tmuxSessionNamespace(process.env);
    const live = namespace.observable ? namespace.names : null;
    if (unexpiredSeats(rootForCwd(cwd), live).has(name) || live?.has(sessionNameForHandle(base, name))) {
      throw new LauncherError(`'${name}' is taken`, "fork_name_taken", `tap session fork ${handle} <another-name>, or run it from a terminal for launch's chooser`,
        `seat name '${name}' is already on this team or its tmux session is live; nothing was launched`);
    }
  }
  const args: Resolved = { harness, label: null, preset: null, tag: name, workdir: null, unique: null, model: null, effort: null,
    env: null, unset_env: null, fresh: false, new: false, attach: false, resume: false, resume_id: null, dry_run: options.dryRun, json: options.json,
    harness_passthrough: [], preset_resolution: null };
  const made = await makeNewRecord(args, state, cwd, deps);
  // The chooser can wait on a human: re-observe the source, then re-check its answer before any effect.
  const current = registryEntry(rootForCwd(cwd), handle);
  // A tmux rename during the chooser changes only the live session, so verify it again.
  const liveNow = current ? await verifiedSession(current, process.env) : null;
  if (liveNow) sourceSessions.add(liveNow);
  if (sourceSessions.has(made.name) || (made.replaces_session && sourceSessions.has(made.replaces_session))) refuseSource();
  const now = current ? recordFromRow(handle, current, team, rootForCwd(cwd)) : null;
  if (!current || ["harness", "harness_session_id", "session", "instance"].some(key => current[key] !== row[key])
      || !now || resolvedResumeIdentity(now, process.env) !== sourceId) {
    throw new LauncherError(`seat '${handle}' changed`, "fork_source_changed", `tap session fork ${options.source}${options.name ? ` ${options.name}` : ""}`,
      `seat '${handle}' was cleared, restarted or replaced while the fork was being prepared; nothing was launched`);
  }
  // The fork runs where the source's conversation lives, with the source's recipe.
  const record: LaunchRecord = {
    ...made, cwd: source.cwd, model: source.model ?? null, preset: source.preset ?? null, permissions: source.permissions ?? null,
    harness_passthrough: [...source.harness_passthrough ?? []], passthrough_from_config: !!source.passthrough_from_config,
    harness_env: { ...source.harness_env ?? {} }, harness_unset_env: [...source.harness_unset_env ?? []],
    harness_tail: [...source.harness_tail ?? []],
    harness_session_id: freshLaunchSessionId(harness), fork_source_session_id: sourceId, ensure_action: "fork", last_launched: timestamp(),
  };
  if (source.launch_tuning) record.launch_tuning = structuredClone(source.launch_tuning); else delete record.launch_tuning;
  if (source.launch_workdir !== undefined) record.launch_workdir = source.launch_workdir; else delete record.launch_workdir;
  return record;
}

export async function forkSeat(options: ForkOptions, cwd: string, deps: ForkDeps): Promise<number> {
  const record = await planFork(options, cwd, deps);
  const source = options.source.slice(options.source.indexOf("/") + 1);
  const handle = launchHandle(record);
  if (!options.json) process.stderr.write(`tap session: ${options.dryRun ? "would fork" : "forking"} ${source} → ${handle} (${record.harness} conversation ${record.fork_source_session_id})\n`);
  const code = await deps.run(record);
  if (options.dryRun || code !== 0) return code;
  for (const line of record.ensure_receipts ?? []) receipt(line);
  if (options.json) {
    // codex and opencode report their fork's id at registration; the bound row has it.
    const bound = registryEntry(rootForCwd(cwd), handle)?.harness_session_id;
    process.stdout.write(`${compact({ ok: true, source, handle, session: record.name, harness: record.harness,
      fork_of: record.fork_source_session_id, harness_session_id: typeof bound === "string" && bound ? bound : record.harness_session_id ?? null })}\n`);
    return 0;
  }
  receipt(`forked ${source} → ${handle} in ${record.name}; ${source} is untouched`);
  if (!deps.hasTty()) { receipt(detachedReceipt(record.name, "no controlling terminal", `${record.base}/${handle}`)); return 0; }
  return attachTailInProcess("launch", record);
}

export async function cmdSessionFork(argv: string[], scriptDir = SCRIPTS, overrides: Partial<ForkDeps> = {}): Promise<number> {
  const jsonRequested = process.env.TAP_JSON === "1" || argv.includes("--json");
  let options: ForkOptions;
  try { options = parseFork(argv); }
  catch (error) { return render(error, jsonRequested); }
  if (options.help) { process.stdout.write(FORK_HELP); return 0; }
  // Mirror the env gate, as relaunch does, so every shared renderer branch answers in JSON.
  if (options.json) process.env.TAP_JSON = "1";
  const notices = new Notices();
  notices.suppress(options.json);
  const cwd = realOrSelf(process.cwd());
  let stderrTty = false;
  try { stderrTty = process.stderr.isTTY === true; } catch { /* no terminal */ }
  const run = (record: LaunchRecord) => withLaunchSignals(async signal => {
    // Pin authority to the caller's (the source's) team: the source's worktree may sit outside its root.
    const result = await launchTransaction({ kind: "new", record: cloneRecord(record), root: rootForCwd(cwd), dry_run: options.dryRun, json: options.json,
      rerun_command: `cd ${shlexQuote(cwd)} && ${["tap", "session", "fork", ...argv].map(shlexQuote).join(" ")}`,
      output_path: callerTty(), terminal: { stderr_tty: stderrTty && !options.json }, script_dir: scriptDir }, process.env, signal, notices);
    Object.assign(record, result.record);
    return result.code;
  });
  return withStartupTrace(async () => {
    const traced = !options.dryRun;
    let code = 1;
    try {
      if (traced) beginLifecycleOperation({ verb: "fork", cwd: process.cwd(), target: options.source, boot_id: currentBootId() });
      code = await forkSeat(options, cwd, { run, hasTty: callerHasTty, choose: promptChoice, scriptDir, requireCommands: requireLaunchCommands, ...overrides });
    } catch (error) {
      // The shared renderer prints a tmux command failure as prose; --json owes one object.
      if (options.json && error instanceof LaunchCommandError) {
        process.stdout.write(errorLine("launch_command_failed", "tap session list", `${commandSummary(error.argv)} exited ${error.result.code || 2}; a reservation may be retained`));
        code = error.result.code || 2;
      } else code = render(error, options.json);
    }
    if (traced) startupTrace(code === 0 ? "launch_complete" : "launch_failure", { exit_code: code });
    return code;
  }, undefined, scriptDir);
}

if (import.meta.main) await exitKeepingTerminal(await cmdSessionFork(process.argv.slice(2)));
