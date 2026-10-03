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
import { parseEnvAssignments } from "./overrides";
import { enforcePermissions, PERMISSION_HARNESSES, type PermissionMode } from "./permissions";
import { applyLaunchEnv } from "./plan";
import { LauncherError } from "./types";
import { teamRegistryRefusal } from "../register-authority";
import { artifactBun, runtimeModule } from "../scripts-dir";

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

/** Fresh argv for a crew seat: the "new" invocation, never a resume, with no session id. */
function renderArgv(harness: string, name: string, cwd: string, model: string, seatEnv: Record<string, string>,
  passthrough: string[], presetFloor: boolean, env: NodeJS.ProcessEnv, notices: Notices, recordedPermissions?: PermissionMode): { argv: string[]; permissions: string; launchEnv: Record<string, string> } {
  // Crew has no conversation id. Bind permissions once for argv, checks and persistence.
  const policy = resolveHarnessPolicy(harness, env, notices, facadeSecureRead);
  const permissions = recordedPermissions ?? (PERMISSION_HARNESSES.includes(harness) ? policy.permissions : "bypass");
  const record = { name, harness, cwd, base: name.split("/", 1)[0]!, model, harness_env: seatEnv };
  const invocation = applyLaunchEnv(buildHarnessInvocation("new", record, null, null, env, permissions), record, env, notices.sink, () => {
    const current = resolveHarnessPolicy(harness, env, notices, facadeSecureRead);
    for (const notice of current.notices) notices.emit(notice);
    return current.env;
  });
  let argv = passthrough.length
    ? spliceTokensIfAbsent(invocation.argv, passthrough, { floor: presetFloor, configKeys: harness === "codex" }) : invocation.argv;
  const params = resolveHarnessPolicy(harness, env, notices, facadeSecureRead).params;
  for (const source of [passthrough, paramsToArgv(params), argv.slice(1)]) enforcePermissions(harness, permissions, source, env);
  argv = withoutNoDaemonForRemote(harness, spliceVerbatimParams(argv, params, { configKeys: harness === "codex" }));
  if (harness === "opencode") {
    const clean: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      const token = argv[i]!, key = token.split("=", 1)[0]!;
      if (key === "--session" || key === "-s") {
        if (!token.includes("=") && i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) i++;
      } else if (key !== "--continue" && key !== "-c") clean.push(token);
    }
    argv = clean;
  }

  return { argv, permissions, launchEnv: invocation.env };
}

export function crewInvocation(args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    cwd: { type: "string" }, model: { type: "string" }, preset: { type: "string" },
    "preset-digest": { type: "string" }, env: { type: "string", multiple: true },
    "record-pane": { type: "string" }, "record-registry": { type: "string" },
  } });
  const [harness, name] = positionals;
  if (positionals.length !== 2 || !harness || !HARNESSES.includes(harness) || name === undefined || values.cwd === undefined) {
    throw new LauncherError("usage: crew-invocation <harness> <name> --cwd <path> [--preset <name> | --model <model>]");
  }
  const notices = new Notices();
  notices.suppress(env.TAP_JSON === "1");
  let model: string | null = values.model ?? null;
  let seatEnv: Record<string, string> = {};
  let passthrough: string[] = [];
  let preset: { name: string; source_path: string; config_digest: string } | null = null;
  if (values.preset !== undefined) {
    const catalog = loadPresetCatalog(env, notices.sink, facadeSecureRead, configDirectory(env), isRegularFile);
    const selected = requirePreset(catalog, values.preset);
    if (values["preset-digest"] && selected.provenance.config_digest !== values["preset-digest"]) {
      refuse("preset_config_changed", `preset '${values.preset}' resolved against a different catalog than this launch was planned with (config digest changed mid-launch)`,
        "re-run the command; the catalog changed while this seat was starting");
    }
    const combined = [values.model !== undefined ? "--model" : "", values.env !== undefined ? "--env" : ""].filter(Boolean);
    if (combined.length) refuse("preset_not_composable", `preset '${values.preset}' is complete; ${combined.join(" and ")} cannot override it`,
      `drop ${combined.join(" and ")}, or add the crew without --preset and pass tuning by flag`);
    if (harness !== selected.harness) refuse("preset_harness_mismatch", `preset '${values.preset}' uses harness '${selected.harness}', not requested harness '${harness}'`,
      `use --harness ${selected.harness}, or choose a preset whose harness is '${harness}'`);
    model = selected.model;
    seatEnv = selected.env;
    passthrough = selected.harness_passthrough;
    preset = selected.provenance;
  } else {
    // Parsing precedes model validation; model precedes the environment fence.
    const rawEnv = parseEnvAssignments(values.env);
    if (model !== null) {
      if (pyBlank(model)) refuse("launch_arg_invalid", "--model must be a non-empty string", "fix the --model value");
      if (/[\x00-\x1f\x7f]/.test(model)) refuse("launch_arg_invalid", "--model contains a control character", "fix the --model value");
    }
    seatEnv = environment(rawEnv, "launch_env_forbidden", {
      notTable: () => refuse("launch_arg_invalid", "--env values must be supplied as KEY=VALUE pairs", "pass environment as --env KEY=VALUE"),
      keyInvalid: key => refuse("launch_arg_invalid", `--env key '${key}' is not a valid environment variable name`, `fix the --env key '${key}'`),
      forbidden: key => refuse("launch_env_forbidden", `--env key '${key}' crosses the identity, transport, process, credential, or policy fence`, `remove --env ${key}=... from the command`),
      fieldError: (field, problem) => refuse("launch_arg_invalid", `--env ${field.slice(4)} ${problem}`, `fix the --env ${field.slice(4)} value`),
    });
  }
  if (model === null) refuse("launch_arg_invalid", "crew add requires an explicit validated launch model; harness defaults cannot establish model identity",
    "use a preset with params.model, or pass --model <model>");

  const cwd = realpathLenient(values.cwd);
  const { argv, permissions, launchEnv } = renderArgv(harness, name, cwd, model, seatEnv, passthrough, preset !== null, env, notices);

  const pane = values["record-pane"];
  if (pane) {
    const path = values["record-registry"];
    if (!path) throw new LauncherError("crew recipe persistence requires its acting registry");
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
      for (const [key, value] of Object.entries({ model, permissions, harness_env: seatEnv, passthrough, cwd,
        passthrough_from_config: preset !== null, preset })) row.set(key, loads(JSON.stringify(value)));
      supersede(doc, rows, env);
      verbose("state_write", { path }, env);
      atomicWrite(path, `${pyDumpIndent(doc, 0)}\n`);
    } finally { lock.release(); }
  }
  return shellCommand(argv, launchEnv, env);
}

/**
 * Replay a live crew row's persisted recipe as a fresh launch: no catalog or
 * preset read, no session or conversation id. A missing or malformed recipe
 * refuses rather than guessing (tap-odt1d.1).
 */
export function crewRecipeInvocation(team: string, handle: string, row: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): { command: string; cwd: string } {
  const { harness, model, harness_env: seatEnv, passthrough, cwd, permissions } = row;
  const missing = (field: string) => refuse("crew_recipe_missing", `crew '${team}/${handle}' has no usable launch recipe (${field})`,
    `tap crew shutdown ${team}/${handle}, then tap crew add a fresh seat`);
  if (typeof harness !== "string" || !HARNESSES.includes(harness)) return missing("harness");
  if (typeof model !== "string" || pyBlank(model)) return missing("model");
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return missing("cwd");
  if (!seatEnv || typeof seatEnv !== "object" || Array.isArray(seatEnv) || Object.values(seatEnv).some(v => typeof v !== "string")) return missing("harness_env");
  if (!Array.isArray(passthrough) || passthrough.some(v => typeof v !== "string")) return missing("passthrough");
  if (permissions !== "bypass" && permissions !== "auto") return missing("permissions");
  const notices = new Notices();
  notices.suppress(true);
  const { argv, launchEnv } = renderArgv(harness, `${team}/${handle}`, cwd, model, seatEnv as Record<string, string>,
    passthrough as string[], row.passthrough_from_config === true, env, notices, permissions);
  // The fresh seat binds through its cwd, never an inherited bus pin (odt1d #8):
  // unset it in the child, since the tmux server environment may carry one.
  const { TAP_HOME: _pin, ...unpinned } = env;
  return { command: shellCommand(argv, launchEnv, unpinned, ["TAP_HOME"]), cwd };
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

export function crewInvocationCli(args: string[]): number {
  try { process.stdout.write(`${crewInvocation(args)}\n`); return 0; }
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

if (import.meta.main) process.exitCode = crewInvocationCli(process.argv.slice(2));
