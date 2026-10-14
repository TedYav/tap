// Shared value owner for creation, resume and the retained in-pane callers.
// No registry, fence or process effects belong to invocation construction.
import { buildHarnessInvocation, hostBootEnv, isolationArgv, withoutNoDaemonForRemote } from "./adapters";
import { resolveHarnessPolicy } from "./catalog";
import { facadeSecureRead } from "../slices/preset-api";
import { Notices } from "./catalog-notices";
import { applyLaunchEnv } from "./plan";
import { paramsToArgv, spliceTokensIfAbsent } from "./argv-splice";
import { enforcePermissions, permissionArgv, PERMISSION_HARNESSES, refuseAmbientCodexSockets } from "./permissions";
import { claudeSessionTranscriptExists, resolveResumeTarget, resolvedResumeIdentity, emitResumeTargetReceipts } from "./resume-identity";
import { assignments } from "./config-args";
import { launchWorkdir } from "./workdir";
import { modelArgv, launchTuning } from "./tuning";
import { observedResumeEffort, restoredAxes, resumeReopensSession, setsAxis, stripTuningAxes, type TuningAxis } from "./resume-tuning";
import { LauncherError, UNBOUND_RESUME_IDENTITY, type Invocation, type ResumeIdentity, type SessionRecord } from "./types";
import { basename } from "node:path";
import { shellQuote } from "../shell-quote";
import { INHERITED_IDENTITY_ENV } from "../session-store";

export class InvocationError extends Error {}

/** Resume-target receipts reach stderr unless a caller hands the build another sink. */
export const stderrReceipts = (line: string): void => { process.stderr.write(`${line}\n`); };
/** The one way a validation-only build stays quiet: the real invocation build owns the launch's single receipt. */
export const discardReceipts = (_line: string): void => {};
export const shlexQuote = (value: string): string => /^[\w@%+=:,./-]+$/.test(value) ? value : shellQuote(value);

export function resolveLoginShell(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [env.TAP_LAUNCH_SHELL, env.SHELL, "zsh", "bash", "sh", "/bin/sh"];
  return candidates.flatMap(candidate => {
    if (!candidate) return [];
    const found = Bun.which(candidate, { PATH: env.PATH });
    return found && ["zsh", "bash", "sh", "dash", "ksh", "ash"].includes(basename(found).replace(/\.exe$/, "")) ? [found] : [];
  })[0] ?? "/bin/sh";
}

export function invocationShellCommand(invocation: Invocation, env: NodeJS.ProcessEnv = process.env): string {
  const shell = resolveLoginShell(env);
  const configured = { ...invocation.env };
  for (const key of ["TAP_INDEX_HOME", "TAP_TMUX_SOCKET_PATH", "TAP_TMUX_SOCKET"]) if (env[key]) configured[key] = env[key]!;
  // A real seat must bind even when its caller or tmux server came from ask.
  delete configured.TAP_STATELESS;
  // The tmux server's global env may carry another seat's identity; the harness mints its own.
  // A key the invocation itself configures is set below, not unset.
  const inherited = INHERITED_IDENTITY_ENV.filter(key => !(key in configured));
  const unset = [...new Set([...(invocation.unset_env ?? []), "TAP_STATELESS", ...inherited])];
  const command = ["/usr/bin/env", ...unset.flatMap(key => ["-u", key]),
    ...Object.keys(configured).sort().map(key => `${key}=${configured[key]}`), ...invocation.argv];
  return [shell, "-lic", 'exec "$0" "$@"', ...command].map(shlexQuote).join(" ");
}

export function pinOpenCodeSession(argv: string[], id: string | null | undefined): string[] {
  const clean: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!, option = token.split("=", 1)[0];
    if (option === "--session" || option === "-s") {
      if (!token.includes("=") && i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) i++;
    } else if (option !== "--continue" && option !== "-c") clean.push(token);
  }
  if (id) clean.push("--session", id);
  return clean;
}

export function buildInvocation(
  action: string,
  record: SessionRecord,
  notices: Notices,
  env: NodeJS.ProcessEnv = process.env,
  prompt: string | null = null,
  resume: ResumeIdentity = UNBOUND_RESUME_IDENTITY,
  nativeQuery?: string | null,
  receipts: (line: string) => void = stderrReceipts,
): Invocation {
  if (!["claude", "codex", "opencode", "cursor", "agy", "hermes"].includes(record.harness)) {
    throw new InvocationError(`unknown harness: ${record.harness}`);
  }
  if (nativeQuery === undefined && resume === UNBOUND_RESUME_IDENTITY) {
    resume = action === "resume" ? resolvedResumeIdentity(record, env, receipts) : null;
  }
  const permissions = PERMISSION_HARNESSES.includes(record.harness)
    ? resolveHarnessPolicy(record.harness, env, notices, facadeSecureRead).permissions : "bypass";
  if (PERMISSION_HARNESSES.includes(record.harness)) record.permissions = permissions;
  if (nativeQuery === undefined || !["claude", "codex", "agy"].includes(record.harness)) {
    return buildHarnessInvocation(action, record, prompt, resume, env, permissions, receipts);
  }
  const argv = [record.harness, ...isolationArgv(record.harness)];
  if (record.harness === "codex" && permissions === "auto") refuseAmbientCodexSockets(env, launchWorkdir(record));
  argv.push(...permissionArgv(record.harness, permissions, env));
  if (record.harness === "codex") argv.push("resume");
  if (!resumeReopensSession(record.harness, nativeQuery) || !restoredAxes(record.harness).includes("model")) argv.push(...modelArgv(record.harness, record.model));
  if (record.harness === "claude") {
    if (record.name) argv.push("--name", record.name);
    argv.push("--resume");
    if (nativeQuery && claudeSessionTranscriptExists(nativeQuery, env)) argv.push(nativeQuery);
    else {
      const target = resolveResumeTarget(record, env);
      emitResumeTargetReceipts(record, target, receipts);
      if (target.session_id) argv.push(target.session_id);
    }
  } else if (record.harness === "codex") {
    if (nativeQuery) argv.push(nativeQuery);
  } else {
    const id = nativeQuery || record.harness_session_id;
    if (id) argv.push("--conversation", id); else argv.push("--continue");
  }
  return { argv, env: hostBootEnv(record.harness, permissions, env) };
}

export function applyInvocationEnv(
  invocation: Invocation, record: SessionRecord, notices: Notices,
  env: NodeJS.ProcessEnv = process.env, notify = true,
): Invocation {
  // Parse-level notices still share command lifetime. `notify` suppresses only
  // policy/collision notices, not resume-target receipts or future live notices.
  const policy = resolveHarnessPolicy(record.harness, env, notices, facadeSecureRead);
  if (notify) for (const message of policy.notices) notices.emit(message);
  const value = applyLaunchEnv(invocation, record, env, notify ? notices.sink : () => {}, () => policy.env);
  for (const key of record.harness_unset_env ?? []) delete value.env[key];
  return { ...value, unset_env: [...record.harness_unset_env ?? []] };
}

/**
 * A resume's tuning inputs (tap-j5k1b). `typedTail` counts the trailing harness_tail tokens typed on THIS invocation
 * (relaunch's `--` tail): they always win and are never stripped. `observedEffort` is Claude's last observed effort.
 */
export interface ResumeTuning { typedTail?: number; observedEffort?: string | null }

/** Resume tuning applies when the resume reopens a native session (named, or a native picker); a fresh start keeps launch tuning. */
export function resumeTuning(record: SessionRecord, target: ResumeIdentity | undefined, env: NodeJS.ProcessEnv, typedTail?: number): ResumeTuning | undefined {
  const id = typeof target === "string" && target ? target : null;
  if (!resumeReopensSession(record.harness, id)) return undefined;
  return { typedTail, observedEffort: observedResumeEffort(record, id, env) };
}

/** What the full launch composition would record, with the same floor and Codex config-key rules as composeInvocation. */
function recordedLaunchTuning(record: SessionRecord, params: string[], env: Record<string, string | undefined>) {
  const codex = record.harness === "codex";
  let argv = spliceTokensIfAbsent([record.harness, ...modelArgv(record.harness, record.model)], record.harness_passthrough ?? [], {
    floor: record.passthrough_from_config ?? false, configKeys: codex,
  });
  argv = spliceTokensIfAbsent(argv, params, { configKeys: codex });
  return launchTuning(record.harness, [...argv.slice(1), ...record.harness_tail ?? []], env);
}

export function composeInvocation(
  invocation: Invocation, record: SessionRecord, notices: Notices,
  env: NodeJS.ProcessEnv = process.env, notify = true, resume?: ResumeTuning,
): Invocation {
  const configured = applyInvocationEnv(invocation, record, notices, env, notify);
  // On resume, stored launch tuning for an axis the harness restores natively is dropped from every replayed source,
  // so an in-session /model or /effort survives; tokens typed on this invocation are kept as typed.
  const harness = record.harness, tail = record.harness_tail ?? [];
  const typedCount = Math.min(resume?.typedTail ?? 0, tail.length);
  const typed = tail.slice(tail.length - typedCount);
  const strip: TuningAxis[] = resume ? [...restoredAxes(harness)] : [];
  const observedEffort = resume?.observedEffort && !setsAxis(harness, typed, "effort") ? resume.observedEffort : null;
  if (observedEffort) strip.push("effort");
  const passthrough = stripTuningAxes(harness, record.harness_passthrough ?? [], strip);
  const replayedTail = [...stripTuningAxes(harness, tail.slice(0, tail.length - typedCount), strip), ...typed];
  let argv = spliceTokensIfAbsent(configured.argv, passthrough, {
    floor: record.passthrough_from_config ?? false, configKeys: harness === "codex",
  });
  const policy = resolveHarnessPolicy(harness, env, notices, facadeSecureRead);
  const params = stripTuningAxes(harness, paramsToArgv(policy.params), strip);
  record.permissions ??= PERMISSION_HARNESSES.includes(harness) ? policy.permissions : "bypass";
  try {
    for (const source of [passthrough, params, argv.slice(1), replayedTail]) {
      enforcePermissions(harness, record.permissions, source, env);
    }
  } catch (error) {
    if (error instanceof LauncherError) throw new InvocationError(error.message);
    throw error;
  }
  argv = spliceTokensIfAbsent(argv, params, { configKeys: harness === "codex" });
  if (observedEffort) argv.splice(1, 0, "--effort", observedEffort);
  argv.push(...replayedTail);
  argv = withoutNoDaemonForRemote(harness, argv);
  if (harness === "opencode") argv = pinOpenCodeSession(argv, record.fork_source_session_id || record.harness_session_id);
  const tuningEnv = { ...configured.env };
  for (const key of configured.unset_env ?? []) delete tuningEnv[key];
  const launched = launchTuning(harness, argv.slice(1), tuningEnv);
  // An axis a resume left to the harness keeps the value TAP last launched with, not null. A row from before
  // launch_tuning existed derives it from the stored sources the resume did not pass.
  const prior = strip.length ? record.launch_tuning ?? recordedLaunchTuning(record, paramsToArgv(policy.params), tuningEnv) : undefined;
  for (const axis of strip) launched[axis] ??= prior?.[axis] ?? null;
  record.launch_tuning = launched;
  return { argv, env: configured.env, unset_env: configured.unset_env };
}

/** Codex asks "use session directory or current directory?" when a resumed rollout's latest recorded cwd differs from where it starts
 * (codex-cli 0.159.3, observed live), and a relaunched seat has no one to answer (tap-4tclq). `--cd` overrides `tui.resume_cwd` and
 * picks the destination before the prompt. A resume by explicit id is not cwd-keyed, so naming the folder the seat already starts in
 * is redundant at worst, and no saved transcript needs reading. It is decided on the COMPOSED argv, so a directory the seat's own
 * flags, policy params or tail already chose is never contradicted. */
function withCodexResumeDirectory(invocation: Invocation, record: SessionRecord, id: string): Invocation {
  const rest = invocation.argv.slice(1), at = invocation.argv.lastIndexOf(id);
  if (at < 1 || rest.some(token => /^(--cd(=|$)|-C)/.test(token)) || assignments(rest).some(({ key }) => key === "tui.resume_cwd")) return invocation;
  return { ...invocation, argv: [...invocation.argv.slice(0, at), "--cd", launchWorkdir(record), ...invocation.argv.slice(at)] };
}

export function launchInvocation(
  action: string, record: SessionRecord, notices: Notices,
  options: { env?: NodeJS.ProcessEnv; prompt?: string | null; resume?: ResumeIdentity; nativeQuery?: string | null; notify?: boolean; receipts?: (line: string) => void; typedTail?: number } = {},
): Invocation {
  const env = options.env ?? process.env;
  const receipts = options.receipts ?? stderrReceipts;
  // Resolved here, once, so the composed command can name the id it resumes; a bound value makes buildInvocation skip its own resolution.
  let resume: ResumeIdentity = options.resume === undefined ? UNBOUND_RESUME_IDENTITY : options.resume;
  if (options.nativeQuery === undefined && resume === UNBOUND_RESUME_IDENTITY) {
    resume = action === "resume" && ["claude", "codex", "opencode", "cursor", "agy", "hermes"].includes(record.harness)
      ? resolvedResumeIdentity(record, env, receipts) : null;
  }
  const target = options.nativeQuery === undefined ? resume : options.nativeQuery;
  // `tap launch --resume` reopens a conversation under action "new": its tuning composes as a resume's does, so an
  // axis the harness restores natively (the picked conversation's own model, Codex's effort) is not re-passed from
  // the preset or the tail, and an exact Codex id names its resume directory like any other Codex resume.
  const reopened: ResumeIdentity | undefined = action === "new" && record.launch_resume
    ? (record.launch_resume === "exact" ? record.harness_session_id ?? null : null) : undefined;
  const tuning = action === "resume" ? resumeTuning(record, target, env, options.typedTail)
    : reopened !== undefined ? resumeTuning(record, reopened, env, options.typedTail) : undefined;
  const composed = composeInvocation(buildInvocation(action, record, notices, env, options.prompt,
    resume, options.nativeQuery, receipts), record, notices, env, options.notify ?? true, tuning);
  const codexResumeId = record.harness === "codex" ? (action === "resume" ? target : reopened) : null;
  return typeof codexResumeId === "string" && codexResumeId ? withCodexResumeDirectory(composed, record, codexResumeId) : composed;
}
