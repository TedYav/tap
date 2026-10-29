// The internal preparation child of `tap crew add`: fresh argv and row-bound tuning.
import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { atomicWrite } from "../fsatomic";
import { pyDumpIndent } from "../lossless-json";
import { acquireRegistryLock } from "../panelock";
import { facadeSecureRead } from "../slices/preset-api";
import { INHERITED_IDENTITY_ENV } from "../session-store";
import { verbose } from "../verbose";
import { dumps, isMap, loads, pyTruthy, type JsonMap, type JsonValue } from "../watch-detect";
import { buildHarnessInvocation, withoutNoDaemonForRemote } from "./adapters";
import { paramsToArgv, spliceTokensIfAbsent, spliceVerbatimParams } from "./argv-splice";
import { configDirectory, environment, HARNESSES, isRegularFile, refuse, resolveHarnessPolicy } from "./catalog";
import { loadPresetCatalog, requirePreset } from "./catalog-listing";
import { pyBlank } from "./catalog-metadata";
import { Notices } from "./catalog-notices";
import { applyOverrides, parseEnvAssignments, type Overrides } from "./overrides";
import { defaultPermissions, enforcePermissions, PERMISSION_HARNESSES, prepareCodexAutoReceipts, type PermissionMode } from "./permissions";
import { applyLaunchEnv } from "./plan";
import { LauncherError, type SessionRecord } from "./types";
import { pinOpenCodeSession } from "./invocation";
import { launchTuning } from "./tuning";
import { stripTuningAxes } from "./resume-tuning";
import { prepareOpenCodeSession } from "./opencode-prepare";
import { openCodeServerMode } from "./opencode-mode";
import { teamRegistryRefusal } from "../register-authority";
import { forkConflictingFlag } from "../harness-families";
import { artifactBun, runtimeModule } from "../scripts-dir";
import { assertCrewResumeIdentity, assertCrewResumeUnheld } from "../crew-resume-identity";
import { NATIVE_CONVERSATION_ID } from "../native-conversation";
import { restoredAxes } from "./resume-tuning";

const quote = (s: string): string => /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'"'"'`)}'`;

function realpathLenient(path: string): string {
  const suffix: string[] = [];
  let prefix = resolve(path);
  for (;;) {
    try { return join(realpathSync(prefix), ...suffix); }
    catch {
      if (dirname(prefix) === prefix) return resolve(path);
      suffix.unshift(basename(prefix));
      prefix = dirname(prefix);
    }
  }
}

function loginShell(env: NodeJS.ProcessEnv): string {
  for (const candidate of [env.TAP_LAUNCH_SHELL, env.SHELL, "zsh", "bash", "sh", "/bin/sh"]) {
    if (!candidate) continue;
    let found: string | null = null;
    if (isAbsolute(candidate)) {
      try { accessSync(candidate, constants.X_OK); found = candidate; } catch { /* try PATH */ }
    }
    found ??= Bun.which(candidate, { PATH: env.PATH });
    if (found && ["sh", "bash", "zsh", "dash", "ksh", "ash"].includes(basename(found).replace(/\.exe$/, ""))) return found;
  }
  return "/bin/sh";
}

class ChildFailure extends Error {
  constructor(readonly status: number, detail: string) { super(detail); }
}

/** Keep the existing alias policy in its native owner; only project and transport. */
function supersede(doc: JsonMap, seats: JsonMap, env: NodeJS.ProcessEnv): void {
  const forwardings = doc.get("seat_forwardings");
  if (!Array.isArray(forwardings) || !forwardings.length) return;
  const instances = new Map<string, JsonValue>();
  for (const [handle, row] of seats) instances.set(handle, new Map([["instance", isMap(row) ? row.get("instance") ?? null : null]]));
  const door = runtimeModule("src/forwarding.ts");
  const child = spawnSync(artifactBun() ?? "bun", [door, "supersede"], {
    input: dumps(new Map<string, JsonValue>([["seats", instances], ["seat_forwardings", forwardings]]), true),
    env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new ChildFailure(child.status ?? 1, `command failed (exit ${child.status ?? 1}): bun ${door} supersede`);
  const result = loads(child.stdout);
  if (!isMap(result) || !Array.isArray(result.get("seat_forwardings"))) throw new Error("invalid forwarding supersede response");
  doc.set("seat_forwardings", result.get("seat_forwardings")!);
}

/** Conversation selectors a crew tail may not carry, beyond Claude's fork-owned flags. OpenCode's are dropped instead. */
const CREW_SELECTOR_FLAGS: Record<string, string[]> = { cursor: ["--resume", "--continue"], agy: ["--conversation", "--continue", "-c"], hermes: ["--resume", "-r", "--continue", "-c"] };
function conversationSelector(harness: string, tail: string[], exactResume = false): string | null {
  const flags = harness === "opencode" && exactResume ? ["--session", "-s", "--continue", "-c", "--fork"] : CREW_SELECTOR_FLAGS[harness] ?? [];
  return forkConflictingFlag(harness, tail)
    ?? flags.find(flag => tail.some(token => token.split("=", 1)[0] === flag))
    // Codex selects a stored conversation with a subcommand, not a flag.
    ?? (harness === "codex" ? tail.find(token => token === "resume" || token === "fork") ?? null : null);
}

/** Fresh or exact-resume argv for a crew's own window, never a durable-seat transaction. */
async function renderArgv(harness: string, name: string, cwd: string, model: string, seatEnv: Record<string, string>,
  passthrough: string[], presetFloor: boolean, env: NodeJS.ProcessEnv, notices: Notices, overrides: CrewOverrides,
  recordedPermissions?: PermissionMode, prepare = false, signal?: AbortSignal, recordedMode?: "private" | "shared",
  resumeId?: string): Promise<{ argv: string[]; permissions: string; launchEnv: Record<string, string> }> {
  // A saved tail never selects a conversation; only the validated explicit selector may do that.
  const owned = conversationSelector(harness, overrides.tail, !!resumeId);
  if (owned) refuse("launch_arg_invalid", `${owned} selects a conversation outside the crew's explicit selector`,
    `drop ${owned} from the harness arguments; use tap crew add --resume <native-id> to adopt a conversation`);
  // Bind permissions once for argv, checks and persistence.
  const policy = resolveHarnessPolicy(harness, env, notices, facadeSecureRead);
  const permissions = recordedPermissions ?? (PERMISSION_HARNESSES.includes(harness) ? policy.permissions : defaultPermissions(harness));
  const defaulted = recordedPermissions === undefined && policy.permissionsDefaulted;
  const record: SessionRecord = { name, harness, cwd, base: name.split("/", 1)[0]!, model, harness_env: seatEnv,
    harness_unset_env: overrides.unset, ...(resumeId ? { harness_session_id: resumeId } : {}) };
  if (harness === "opencode") {
    record.opencode_server_mode = recordedMode;
    if (openCodeServerMode(record, env) === "shared") refuse("opencode_shared_crew_unsupported",
      "shared OpenCode crews are not available yet", "use a durable shared seat, or set experimental.opencode_shared_server=false to launch a private crew");
  }
  const invocation = applyLaunchEnv(buildHarnessInvocation(resumeId ? "resume" : "new", record, null, resumeId ?? null, env, permissions, undefined, notices.sink), record, env, notices.sink, () => {
    const current = resolveHarnessPolicy(harness, env, notices, facadeSecureRead);
    for (const notice of current.notices) notices.emit(notice);
    return current.env;
  });
  let argv = passthrough.length
    ? spliceTokensIfAbsent(invocation.argv, passthrough, { floor: presetFloor, configKeys: harness === "codex" }) : invocation.argv;
  const params = resolveHarnessPolicy(harness, env, notices, facadeSecureRead).params;
  if (resumeId) {
    for (const source of [passthrough, paramsToArgv(params)]) {
      const selector = conversationSelector(harness, source, true);
      if (selector) refuse("launch_arg_invalid", `${selector} conflicts with the crew's exact --resume id`, "remove the conversation selector from the preset or harness policy");
    }
  }
  for (const source of [passthrough, paramsToArgv(params), argv.slice(1), overrides.tail]) enforcePermissions(harness, permissions, source, env, defaulted);
  // Typed harness arguments append last, as tap session launch's `--` tail does.
  argv = withoutNoDaemonForRemote(harness, [...spliceVerbatimParams(argv, params, { configKeys: harness === "codex" }), ...overrides.tail]);
  // Apply the same environment to preparation and to the eventual TUI.
  const launchEnv = { ...invocation.env };
  for (const key of overrides.unset) delete launchEnv[key];
  if (resumeId) {
    const childEnv = { ...env, ...launchEnv };
    for (const key of overrides.unset) delete childEnv[key];
    assertCrewResumeIdentity(harness, resumeId, cwd, childEnv);
    argv = stripTuningAxes(harness, argv, [...restoredAxes(harness)]);
    // The durable Hermes launcher still has no resume contract; this exact crew selector is separate.
    if (harness === "hermes") argv.push("--resume", resumeId);
  }
  if (harness === "opencode") {
    record.launch_tuning = launchTuning(harness, argv.slice(1), launchEnv);
    argv = pinOpenCodeSession(stripTuningAxes(harness, argv, ["model", "effort"]), resumeId ?? null);
    if (prepare && !resumeId) {
      const childEnv = { ...env, ...launchEnv };
      for (const key of overrides.unset) delete childEnv[key];
      argv = pinOpenCodeSession(argv, await prepareOpenCodeSession(record, childEnv, signal, notices));
    }
  }

  return { argv, permissions, launchEnv };
}

/** Typed `--unset-env` keys and `--` harness arguments: persisted beside the base recipe, replayed by relaunch. */
interface CrewOverrides { unset: string[]; tail: string[] }

export async function crewInvocation(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    cwd: { type: "string" }, model: { type: "string" }, preset: { type: "string" }, resume: { type: "string" },
    "preset-digest": { type: "string" }, env: { type: "string", multiple: true },
    "unset-env": { type: "string", multiple: true }, "harness-arg": { type: "string", multiple: true },
    "record-pane": { type: "string" }, "record-registry": { type: "string" },
  } });
  if (values.resume !== undefined && !NATIVE_CONVERSATION_ID.test(values.resume)) refuse("launch_arg_invalid", "--resume requires one exact native conversation id", "pass --resume <native-id>");
  const [harness, name] = positionals;
  if (positionals.length !== 2 || !harness || !HARNESSES.includes(harness) || name === undefined || values.cwd === undefined) {
    throw new LauncherError("usage: crew-invocation <harness> <name> --cwd <path> [--preset <name> | --model <model>] [--env=KEY=VALUE] [--unset-env=KEY] [--harness-arg=<token>]");
  }
  const notices = new Notices();
  notices.suppress(env.TAP_JSON === "1");
  let model: string | null = values.model ?? null;
  let baseEnv: Record<string, string> = {};
  let passthrough: string[] = [];
  let preset: { name: string; source_path: string; config_digest: string } | null = null;
  // Parsing precedes model validation; model precedes the environment fence.
  const rawEnv = parseEnvAssignments(values.env);
  if (values.preset !== undefined) {
    const catalog = loadPresetCatalog(env, notices.sink, facadeSecureRead, configDirectory(env), isRegularFile);
    const selected = requirePreset(catalog, values.preset);
    if (values["preset-digest"] && selected.provenance.config_digest !== values["preset-digest"]) {
      refuse("preset_config_changed", `preset '${values.preset}' resolved against a different catalog than this launch was planned with (config digest changed mid-launch)`,
        "re-run the command; the catalog changed while this seat was starting");
    }
    // Tuning stays preset-owned; --env, --unset-env and -- still apply, as with tap session launch.
    if (values.model !== undefined) refuse("preset_not_composable", `preset '${values.preset}' is complete; --model cannot override it`,
      "drop --model, or add the crew without --preset and pass tuning by flag");
    if (harness !== selected.harness) refuse("preset_harness_mismatch", `preset '${values.preset}' uses harness '${selected.harness}', not requested harness '${harness}'`,
      `use --harness ${selected.harness}, or choose a preset whose harness is '${harness}'`);
    model = selected.model;
    baseEnv = selected.env;
    passthrough = selected.harness_passthrough;
    preset = selected.provenance;
  } else if (model !== null) {
    if (pyBlank(model)) refuse("launch_arg_invalid", "--model must be a non-empty string", "fix the --model value");
    if (/[\x00-\x1f\x7f]/.test(model)) refuse("launch_arg_invalid", "--model contains a control character", "fix the --model value");
  }
  const fence = (flag: string) => ({
    notTable: () => refuse("launch_arg_invalid", "--env values must be supplied as KEY=VALUE pairs", "pass environment as --env KEY=VALUE"),
    keyInvalid: (key: string) => refuse("launch_arg_invalid", `${flag} key '${key}' is not a valid environment variable name`, `fix the ${flag} key '${key}'`),
    forbidden: (key: string) => refuse("launch_env_forbidden", `${flag} key '${key}' crosses the identity, transport, process, credential, or policy fence`,
      `remove ${flag} ${key}${flag === "--env" ? "=..." : ""} from the command`),
    fieldError: (field: string, problem: string) => refuse("launch_arg_invalid", `${flag} ${field.slice(4)} ${problem}`, `fix the ${flag} ${field.slice(4)} value`),
  });
  const typedEnv = environment(rawEnv, "launch_env_forbidden", fence("--env"));
  const unset = [...new Set(values["unset-env"] ?? [])].sort();
  environment(Object.fromEntries(unset.map(key => [key, "1"])), "launch_env_forbidden", fence("--unset-env"));
  const both = unset.find(key => Object.hasOwn(typedEnv, key));
  if (both) refuse("launch_arg_invalid", `both --env and --unset-env name ${both}`, `keep one of --env ${both}=... or --unset-env ${both}`);
  const tail = values["harness-arg"] ?? [];
  const seatEnv: Record<string, string> = { ...baseEnv, ...typedEnv };
  for (const key of unset) delete seatEnv[key];
  const overrides: CrewOverrides = { unset, tail };
  if (model === null) refuse("launch_arg_invalid", "crew add requires an explicit validated launch model; harness defaults cannot establish model identity",
    "use a preset with params.model, or pass --model <model>");

  const cwd = realpathLenient(values.cwd);
  const { argv, permissions, launchEnv } = await renderArgv(harness, name, cwd, model, seatEnv, passthrough, preset !== null, env, notices, overrides, undefined, !!values["record-pane"], undefined, undefined, values.resume);

  const pane = values["record-pane"];
  if (pane) {
    const path = values["record-registry"];
    if (!path) throw new LauncherError("crew recipe persistence requires its acting registry");
    prepareCodexAutoReceipts(harness, permissions, env);
    const handle = name.slice(name.indexOf("/") + 1);
    // Match flock(LOCK_EX), including contention beyond the native five-second default.
    const lock = acquireRegistryLock(path, Infinity, env);
    if (!lock) throw new LauncherError("could not obtain crew recipe registry lock");
    try {
      const doc = loads(readFileSync(path, "utf8"));
      if (!isMap(doc)) throw new LauncherError("crew registry is not an object");
      const refusal = teamRegistryRefusal(path, doc);
      if (refusal) throw new LauncherError(refusal.detail, refusal.errorClass, refusal.action, refusal.detail);
      // Only a seats map beside no `agents` key is writable; anything else has no row to persist into.
      const seats = doc.get("seats");
      const rows = isMap(seats) && !doc.has("agents") ? seats : new Map<string, JsonValue>();
      const row = rows.get(handle);
      if (!isMap(row) || !pyTruthy(row.get("crew")) || row.get("pane_id") !== pane || row.get("harness") !== harness) {
        throw new LauncherError(`crew launch row changed before recipe persistence for ${handle}; expected crew pane ${pane} with harness ${harness}`);
      }
      if (values.resume !== undefined) {
        assertCrewResumeUnheld(harness, values.resume, path, handle, env, doc);
        row.set("harness_session_id", values.resume);
        row.set("identity_capture", new Map<string, JsonValue>([["mode", "exact_resume"], ["expected_harness_session_id", values.resume]]));
      }
      // harness_env_set names typed --env keys (never values) so doctor knows a preset re-add would drop them.
      for (const [key, value] of Object.entries({ model, permissions, harness_env: seatEnv, passthrough, cwd,
        passthrough_from_config: preset !== null, preset, harness_env_set: Object.keys(typedEnv).sort(),
        harness_unset_env: unset, harness_tail: tail })) row.set(key, loads(JSON.stringify(value)));
      supersede(doc, rows, env);
      verbose("state_write", { path }, env);
      atomicWrite(path, `${pyDumpIndent(doc, 0)}\n`);
    } finally { lock.release(); }
  }
  return shellCommand(argv, launchEnv, env, unset);
}

/**
 * A relaunch's --env, --unset-env and -- folded into a crew row's recipe with tap session launch's
 * semantics. A malformed stored field is left for crewRecipeInvocation to refuse.
 */
export function crewRecipeWithOverrides(row: Record<string, unknown>, overrides: Overrides): Record<string, unknown> | null {
  const { harness_env: env, harness_unset_env: unset = [], harness_tail: tail = [], harness_env_set: typed = [] } = row;
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === "string");
  if (!env || typeof env !== "object" || Array.isArray(env) || !strings(unset) || !strings(tail)) return null;
  const merged = applyOverrides({ harness_env: env as Record<string, string>, harness_unset_env: unset, harness_tail: tail }, overrides);
  const set = new Set([...strings(typed) ? typed : [], ...Object.keys(parseEnvAssignments(overrides.env))]);
  for (const key of merged.harness_unset_env) set.delete(key);
  return { ...merged, harness_env_set: [...set].sort() };
}

/**
 * Replay a live crew row's persisted recipe as a fresh launch: no catalog or
 * preset read, no session or conversation id. A missing or malformed recipe
 * refuses rather than guessing (tap-odt1d.1).
 */
export async function crewRecipeInvocation(team: string, handle: string, row: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env, prepare = false, signal?: AbortSignal, resumeId?: string, launchRoot?: string): Promise<{ command: string; cwd: string }> {
  const { harness, model, harness_env: seatEnv, passthrough, cwd, permissions } = row;
  // Rows written before crew took launch overrides carry neither field.
  const unset = row.harness_unset_env ?? [], tail = row.harness_tail ?? [];
  const missing = (field: string) => refuse("crew_recipe_missing", `crew '${team}/${handle}' has no usable launch recipe (${field})`,
    `tap crew shutdown ${team}/${handle}, then tap crew add a fresh seat`);
  if (typeof harness !== "string" || !HARNESSES.includes(harness)) return missing("harness");
  if (typeof model !== "string" || pyBlank(model)) return missing("model");
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return missing("cwd");
  if (!seatEnv || typeof seatEnv !== "object" || Array.isArray(seatEnv) || Object.values(seatEnv).some(v => typeof v !== "string")) return missing("harness_env");
  if (!Array.isArray(passthrough) || passthrough.some(v => typeof v !== "string")) return missing("passthrough");
  if (permissions !== "bypass" && permissions !== "auto") return missing("permissions");
  if (!Array.isArray(unset) || unset.some(v => typeof v !== "string")) return missing("harness_unset_env");
  if (!Array.isArray(tail) || tail.some(v => typeof v !== "string")) return missing("harness_tail");
  const notices = new Notices();
  notices.suppress(true);
  const { argv, launchEnv } = await renderArgv(harness, `${team}/${handle}`, cwd, model, seatEnv as Record<string, string>,
    passthrough as string[], row.passthrough_from_config === true, env, notices, { unset: unset as string[], tail: tail as string[] }, permissions, prepare, signal,
    (row.opencode_server_mode ?? "private") as "private" | "shared", resumeId);
  // The fresh seat binds through its cwd, never an inherited bus pin (odt1d #8):
  // unset it in the child, since the tmux server environment may carry one.
  const { TAP_HOME: _pin, ...unpinned } = env;
  if (resumeId && launchRoot && typeof row.launch_id === "string") {
    launchEnv.TAP_LAUNCH_ROOT = launchRoot;
    launchEnv.TAP_LAUNCH_ID = row.launch_id;
  }
  return { command: shellCommand(argv, launchEnv, unpinned, ["TAP_HOME", ...unset as string[]]), cwd };
}

function shellCommand(argv: string[], launchEnv: Record<string, string>, env: NodeJS.ProcessEnv, unset: string[] = []): string {
  const effectiveEnv = { ...launchEnv };
  for (const key of ["TAP_INDEX_HOME", "TAP_TMUX_SOCKET_PATH", "TAP_TMUX_SOCKET"]) if (env[key]) effectiveEnv[key] = env[key]!;
  // Crew owns a new seat, not the caller's stateless review scope.
  delete effectiveEnv.TAP_STATELESS;
  // The tmux server's global env may carry another seat's identity; the harness mints its own.
  const inherited = INHERITED_IDENTITY_ENV.filter(key => !(key in effectiveEnv));
  const command = ["/usr/bin/env", ...[...new Set([...unset, "TAP_STATELESS", ...inherited])].flatMap(key => ["-u", key]),
    ...Object.keys(effectiveEnv).sort().map(key => `${key}=${effectiveEnv[key]}`), ...argv];
  return [loginShell(env), "-lic", 'exec "$0" "$@"', ...command].map(quote).join(" ");
}

export async function crewInvocationCli(args: string[]): Promise<number> {
  try { process.stdout.write(`${await crewInvocation(args)}\n`); return 0; }
  catch (error) {
    if (error instanceof ChildFailure) { process.stderr.write(`tap session: ${error.message}\n`); return error.status; }
    if (!(error instanceof LauncherError) && (error as NodeJS.ErrnoException).code === "ENOENT") {
      process.stderr.write(`tap session: missing command: ${(error as NodeJS.ErrnoException & { path?: string }).path ?? "bun"}\n`); return 127;
    }
    const known = error instanceof LauncherError ? error : null;
    // The Python permissions check was a LauncherError, not a PresetError.
    const presetError = known?.errorClass && known.errorClass !== "harness_permissions_conflict";
    const detail = presetError ? known!.detail ?? known!.message : (error as Error).message;
    if (process.env.TAP_JSON === "1") process.stdout.write(JSON.stringify({ ok: false,
      error_class: presetError ? known!.errorClass : "session_error",
      action: presetError ? known!.action ?? "tap help session" : "tap help session", detail }) + "\n");
    else process.stderr.write(`tap session: ${detail}${presetError ? `; next: ${known!.action ?? "tap help session"}` : ""}\n`);
    // old_store keeps its own exit code at every launcher door (resume-prelude render).
    return known?.errorClass === "old_store" ? 1 : 2;
  }
}

if (import.meta.main) process.exitCode = await crewInvocationCli(process.argv.slice(2));
