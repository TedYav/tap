import { requireOpenCode2 } from "./opencode-version";
import { opencodeStoredSession } from "../opencode-store";
import { launchWorkdir, validateLaunchWorkdir } from "./workdir";
// Durable relaunch keeps the census conversation and replaces only its pane.
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { observeCallerIdentity, TapError, type CallingPaneObservation } from "../context";
import { teamContext } from "../crew-lifecycle";
import { enrolledTeamNameForRoot } from "../index-home";
import { assertResetUnfenced } from "../reset";
import { seatIsRelaunchable } from "./complete";
import { Notices } from "./catalog-notices";
import { invocationShellCommand, launchInvocation, shlexQuote } from "./invocation";
import { applyOverrides } from "./overrides";
import { entrySession } from "./observation";
import { rootForCwd } from "./records";
import { registryEntry } from "./resume";
import { codexChildStoreEnv, codexSessionExists, recordHasResumeArtifact, resolvedResumeIdentity, reviveTier } from "./resume-identity";
import { LaunchInterrupted, mintLaunchSessionId, recordFromRow } from "./transaction";
import { assertSharedStopCleared, refuseSharedSelfStop } from "../opencode-shared-stop";
import { LauncherError } from "./types";
import { ClearRefusal, checkRelaunchExpectation, clearRebindTimeout, clearTargetPane, relaunchIdentity, refuseOnIdentityDrift,
  refuseUnsupportedInstruction, replaceHarnessInPane, type ClearScope } from "./replace";
import type { Member, Options } from "./relaunch";

export interface MemberResult { code: number; error_class?: string; reason?: string; stdout?: string; stderr?: string; elapsed?: number; workdir?: string }
export interface RelaunchContext { team?: string; caller_pane: string; caller: CallingPaneObservation }

export function relaunchContext(): RelaunchContext {
  const enrolled = enrolledTeamNameForRoot(rootForCwd(process.cwd()));
  const caller = observeCallerIdentity(process.env, true);
  return { team: enrolled.status === "ok" ? enrolled.name : undefined,
    caller_pane: caller.state === "inside" ? caller.paneId : "", caller };
}

/** Freeze every conversation before starting any replacement. */
export function prepareRelaunch(members: Member[]): Member[] {
  return members.map(member => {
    try {
      const record = recordFromRow(member.handle, member.row, member.team_doc, member.root);
      return { ...member, root: realpathSync(member.root), expect: relaunchIdentity(member.row),
        expect_resume: record ? resolvedResumeIdentity(record) : null };
    } catch (error) { return { ...member, prepare_error: String(error) }; }
  });
}

/** Resolve only the named target team. A corrupt unrelated team cannot veto it. */
export function relaunchTarget(member: Member): ClearScope {
  const ctx = teamContext(member.team, false);
  if (ctx.root !== member.root) throw new TapError(2, "team_changed", "repeat the census before relaunching",
    `team ${member.team} enrollment changed since selection; nothing was replaced`);
  return { root: ctx.root, registryPath: ctx.registryPath, busHome: ctx.bus.home };
}

export interface RelaunchControl { signal?: AbortSignal; progress?: (line: string) => void }

export async function relaunchOne(member: Member, options: Options, caller: CallingPaneObservation, control: RelaunchControl = {}): Promise<MemberResult> {
  const started = performance.now(), lines: string[] = [], diagnostic = (line: string) => { lines.push(line); };
  const verb = "tap session relaunch", tag = `${member.team}/${member.handle}`;
  let replacing = false;
  try {
    control.signal?.throwIfAborted();
    if (!options.dryRun) control.progress?.("checking target and resume identity");
    const scope = relaunchTarget(member), where = `cd ${shlexQuote(scope.root)} && `;
    refuseSharedSelfStop([[member.handle, member.row]], verb, false, process.env, caller);
    assertSharedStopCleared(scope.root, member.row);
    assertResetUnfenced(scope.busHome, "session relaunch");
    const refuse = (errorClass: string, action: string, detail: string): never => { throw new TapError(2, errorClass, action, detail); };
    const entry = registryEntry(scope.root, member.handle);
    if (!entry) return refuse("not_found", `${where}tap team`, `no seat '${tag}'`);
    const identity = member.expect ?? relaunchIdentity(member.row);
    refuseOnIdentityDrift(tag, identity, entry);
    if (!seatIsRelaunchable(entry)) return refuse("seat_not_relaunchable", `${where}tap team`, `seat '${tag}' is no longer a launcher-managed, pane-backed seat`);
    const target = await clearTargetPane(scope, member.handle, { verb, caller, signal: control.signal,
      restartHint: `${where}tap session restart ${member.handle}`, rosterHint: `${where}tap team` });
    refuseOnIdentityDrift(tag, identity, target.entry);
    // Build from the guarded row, not an independent session-name lookup.
    let record = recordFromRow(member.handle, target.entry, member.team_doc, scope.root);
    if (!record) return refuse("launch_recipe_missing", `${where}tap session launch`, `seat '${tag}' has no launch recipe of its own`);
    const session = await entrySession(target.entry, process.env, control.signal);
    if (record.name !== session) return refuse("seat_session_mismatch", `${where}tap session list --json`,
      `seat '${tag}' is observed in session '${session}', but its launch record names '${record.name}'; nothing was replaced`);
    const expectedResume = member.expect_resume ?? null;
    const resumed = resolvedResumeIdentity(record, process.env, diagnostic);
    if (resumed !== expectedResume) return refuse("relaunch_resume_changed", "repeat the census before relaunching",
      `seat '${tag}' now resolves to a different conversation than the one enumerated`);
    if (resumed === null) return refuse("no_exact_resume_identity", `run tap in from the live seat pane; ${where}tap clear ${member.handle} starts FRESH context`,
      `seat '${tag}' (${record.harness}) has no resumable conversation id (revive tier '${reviveTier(record.harness, record.harness_session_id)}'); relaunch will not silently start a different conversation`);
    checkRelaunchExpectation(scope, member.handle, target.entry, member.team_doc, { identity, resume: expectedResume }, process.env);
    if (options.overrides) record = { ...record, ...applyOverrides(record, options.overrides) };
    const unsupported = refuseUnsupportedInstruction(record.harness, options.message, `${member.team}/${member.handle}`, process.env);
    if (unsupported) return refuse(unsupported.errorClass, unsupported.action, unsupported.detail);
    // --workdir repairs where the harness runs; it goes through the same validator as the recorded value.
    const workdir = options.workdir ?? record.launch_workdir;
    if (workdir !== undefined) record.launch_workdir = validateLaunchWorkdir(scope.root, workdir);
    // Some resume stores are keyed by workspace (cursor's chats/<hash>/<id>/store.db), and the identity above was resolved against
    // the OLD directory. Re-resolve it against the new one and refuse before any respawn: moving a seat whose conversation lives
    // only under the old directory would kill the live harness and resume into an empty chat.
    // Claude's resolver returns only an id whose transcript exists (a quarantined or transcript_path fallback included), so that is
    // its proof; the raw-record artifact probe would look for the acting id instead. Codex is not workspace-keyed (tap-iuno2):
    // rollouts live under ~/.codex/sessions/<date>/ and `codex resume <id>` resolves the id globally (only the picker and --last
    // filter by cwd), so the proof is that the id exists anywhere in the store the CHILD will read (checked below, once its
    // environment is composed), and an unknown id hard-exits after the kill. Every other resolver returns the stored id itself.
    const refuseUnresumable = () => refuse("resume_unavailable_in_workdir", `keep the seat's current directory, or run tap in from the live pane; ${where}tap clear ${member.handle} starts FRESH context`,
      `seat '${tag}' (${record.harness}) has no stored conversation ${expectedResume} under ${record.launch_workdir}; relaunch --workdir will not resume into an empty chat; nothing was replaced`);
    if (options.workdir !== undefined && expectedResume !== null
      && (resolvedResumeIdentity(record, process.env) !== expectedResume
        || (record.harness !== "claude" && record.harness !== "codex" && record.harness !== "opencode" && !recordHasResumeArtifact(record, process.env)))) return refuseUnresumable();
    // The `--` tail typed on this relaunch is this invocation's own tuning: it wins over anything the resume would drop.
    const notices = new Notices(diagnostic);
    notices.suppress(options.json);
    const built = launchInvocation("resume", record, notices, { prompt: options.message, resume: expectedResume,
      typedTail: options.overrides?.argv?.length ?? 0 });
    if (options.workdir !== undefined && expectedResume !== null && record.harness === "codex"
      && !codexSessionExists(expectedResume, codexChildStoreEnv(process.env, built))) return refuseUnresumable();
    const nativeEnv = { ...process.env, ...built.env };
    for (const key of built.unset_env ?? []) delete nativeEnv[key];
    // OpenCode ignores TAP's reader pin; this must inspect the native child store.
    delete nativeEnv.OPENCODE_DB_PATH;
    if (options.workdir !== undefined && record.harness === "opencode"
      && opencodeStoredSession(resumed, nativeEnv, launchWorkdir(record)) !== "present")
      return refuse("resume_unavailable_in_workdir", "launch a fresh seat in the new workdir",
        `OpenCode 2 sessions are bound to their directory; conversation ${expectedResume} could not be verified in ${launchWorkdir(record)}; nothing was replaced`);
    const nonce = randomUUID(), childEnv: Record<string, string> = { ...built.env, TAP_CLEAR_ID: nonce, TAP_LAUNCH_ROOT: scope.root };
    // Registration must resolve the target cwd, never inherit the caller's bus pin.
    delete childEnv.TAP_HOME;
    const invocation = { ...built, env: childEnv, unset_env: [...new Set(["TAP_HOME", ...built.unset_env ?? []])] };
    const plan = { target, record, nonce, invocation, command: invocationShellCommand(invocation), ceiling: clearRebindTimeout(record.harness) };
    lines.push(...target.warnings);
    // An explicit --workdir is a mutation (respawn cwd + recorded row), so the preview names the directory it would use.
    if (options.dryRun) return { code: 0, stdout: `${plan.command}\n`, stderr: lines.join("\n"), workdir: options.workdir === undefined ? undefined : record.launch_workdir };
    if (record.harness === "opencode") requireOpenCode2(nativeEnv, launchWorkdir(record));
    if (record.opencode_server_mode === "shared") Object.assign(record, await mintLaunchSessionId(record, nativeEnv, control.signal, notices));
    replacing = true;
    const outcome = await replaceHarnessInPane(scope, plan, { verb, handle: member.handle, team: member.team,
      instruction: options.message ?? null, clearHistory: false, relaunch: { identity, resume: expectedResume },
      launchWorkdir: options.workdir === undefined ? undefined : record.launch_workdir, diagnostic, signal: control.signal, progress: control.progress });
    return { code: outcome.code, error_class: outcome.errorClass || undefined, reason: outcome.code ? `${outcome.detail}; next: ${outcome.action}` : undefined,
      stdout: outcome.code ? "" : `${outcome.detail}\n`, stderr: lines.join("\n"), elapsed: (performance.now() - started) / 1000 };
  } catch (error) {
    if (control.signal?.aborted) return { code: control.signal.reason instanceof LaunchInterrupted ? control.signal.reason.exitCode : 130,
      error_class: "relaunch_interrupted", reason: replacing
        ? `interrupted during replacement; state unverified; inspect ${tag} with tap team before relaunching`
        : "interrupted before replacement; nothing was replaced" };
    const outcome = error instanceof ClearRefusal ? error.outcome : null;
    const errorClass = outcome?.errorClass ?? (error instanceof TapError || error instanceof LauncherError ? error.errorClass : "session_error");
    return { code: outcome?.code ?? (errorClass === "old_store" ? 1 : error instanceof TapError || error instanceof LauncherError ? 2 : 1), error_class: errorClass ?? "session_error",
      reason: outcome ? `${outcome.detail}; next: ${outcome.action}` : error instanceof TapError ? `${error.detail}; next: ${error.action}` : String(error),
      stderr: lines.join("\n"), elapsed: (performance.now() - started) / 1000 };
  }
}
