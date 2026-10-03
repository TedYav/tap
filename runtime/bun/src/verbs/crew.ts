// `tap crew` — create, list, and shut down ephemeral pane crew. One Bun authority.
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isFile } from "../watch-lease";
import { observeCallingPane, TapError } from "../context";
import { validToken } from "../ids";
import { checkCrewRegistry } from "../crew-registry";
import { resolveSelection } from "../team-selection";
import type { ResolvedContext } from "../context";
import { cmdTeam } from "./team";
import { ServerUnresponsive, literalKeysArg, tmux as runTmux, tmuxReadOnly } from "../tmux";
import { cmdCrewRelaunch, cmdCrewShutdown, teamContext } from "../crew-lifecycle";
import { armNewCrew, rearmCrewLifetime, validateCrewLifetimeBinding } from "../crew-lifetime";
import { verbArgv } from "../courier-argv";
import { artifactBun } from "../scripts-dir";

export const CREW_SUBCOMMANDS = ["list", "add", "shutdown", "relaunch", "rearm", "remove"] as const;

const ID_CHARSET = "^[A-Za-z0-9][A-Za-z0-9._-]*$";

function tmux(args: string[], opts: { stdio?: "ignore" | "inherit" } = {}): number {
  const result = runTmux(args);
  if (opts.stdio !== "ignore") {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  }
  return result.code;
}

function tmuxRead(args: string[]): string {
  return tmuxReadOnly(args).stdout.replace(/\n+$/, "");
}

function outChild(scriptsDir: string, handle: string): void {
  spawnSync(artifactBun() ?? "bun", [`${scriptsDir}/../../../runtime/bun/main.ts`, "out", handle], { stdio: "ignore" });
}

function rollback(scriptsDir: string, paneId: string, handle?: string): void {
  if (handle) outChild(scriptsDir, handle);
  if (paneId) tmux(["kill-window", "-t", paneId], { stdio: "ignore" });
}

// Re-render a launcher refusal in the shape THIS caller asked for: TAP_JSON is
// the caller's request, so the caller's setting decides the shape. A payload
// that is not the expected object falls back to relaying the raw text, because
// a refusal that cannot be re-rendered must still reach the operator.
function relayRefusal(payload: string): number {
  let doc: Record<string, unknown> | undefined;
  const lines = payload.trim().split("\n");
  try { doc = JSON.parse(lines[lines.length - 1] ?? "") as Record<string, unknown>; } catch { doc = undefined; }
  if (doc && typeof doc === "object" && typeof doc.error_class === "string") {
    throw new TapError(1, doc.error_class, typeof doc.action === "string" ? doc.action : "", typeof doc.detail === "string" ? doc.detail : "");
  }
  process.stderr.write(`${payload.replace(/\n+$/, "")}\n`);
  return 1;
}

export function cmdCrew(argv: string[], scriptsDir: string): number | Promise<number> {
  const sub = argv[0] ?? "";
  const rest = argv.slice(1);
  if (sub === "list") {
    if (rest.length > 0) throw new TapError(1, "usage_error", "tap help crew", `unexpected arg '${rest[0]}'`);
    process.env.TAP_TEAM_CREW_ONLY = "1";
    process.env.TAP_TEAM_LIST_VERB = "crew list";
    return cmdTeam([], scriptsDir);
  }
  if (sub === "add") return cmdCrewAdd(rest, scriptsDir);
  if (sub === "shutdown") return cmdCrewShutdown(rest, scriptsDir);
  if (sub === "relaunch") return cmdCrewRelaunch(rest);
  if (sub === "rearm") return cmdCrewRearm(rest);
  // `remove` is the one-crew alias of shutdown, without the owner forms.
  if (sub === "remove") return cmdCrewShutdown(rest, scriptsDir, true);
  if (sub === "up" || sub === "down") {
    throw new TapError(1, "retired_verb", sub === "up" ? "tap crew add <preset|harness> [name]" : "tap crew shutdown [<crew>|--owner <handle>]",
      `tap crew ${sub} does not exist: crew rows exist only while live, so there is nothing to bring ${sub}`);
  }
  if (sub === "") throw new TapError(1, "usage_error", "tap help crew", "usage: tap crew add <preset|harness> [name] [--preset <name>] [--model <m>] [--env KEY=VALUE] [--cwd <path>] | tap crew shutdown [<crew>|<owner>|--owner <handle|team/handle>] | tap crew relaunch <crew> | tap crew rearm <crew> | tap crew list");
  if (sub.startsWith("--")) throw new TapError(1, "unknown_option", "tap help crew", `unknown option '${sub}'`);
  throw new TapError(1, "unknown_subcommand", "tap help crew", `unknown subcommand '${sub}' (usage: tap crew [add|shutdown|relaunch|rearm|remove|list])`);
}

async function cmdCrewRearm(argv: string[]): Promise<number> {
  if (argv.length !== 1 || argv[0]!.startsWith("-")) throw new TapError(1, "usage_error", "tap help crew", "usage: tap crew rearm <crew> | <team>/<crew>");
  const parts = argv[0]!.split("/");
  if (parts.length > 2 || !validToken(parts.at(-1) ?? "") || (parts.length === 2 && !validToken(parts[0]!))) {
    throw new TapError(1, "usage_error", "tap help crew", "crew must be <handle> or <team>/<handle>");
  }
  const ctx = parts.length === 2 ? teamContext(parts[0]!) : actingContext();
  const binding = await rearmCrewLifetime(ctx, parts.at(-1)!);
  process.stdout.write(`tap crew rearm: supervised ${ctx.team}/${binding.crew} by ${binding.owner} process ${binding.parent.pid}\n`);
  return 0;
}

function actingContext(): ResolvedContext {
  const callerPin = process.env.TAP_HOME ?? "";
  const ctx = resolveSelection(callerPin, "");
  if (!isFile(ctx.registryPath)) {
    throw new TapError(1, "not_found", "tap team / tap doctor", "no acting registry for this team");
  }
  return ctx;
}

// --- add --------------------------------------------------------------------
async function cmdCrewAdd(argv: string[], scriptsDir: string): Promise<number> {
  const usage = "usage: tap crew add <preset|harness> [name] [--preset <name>] [--model <m>] [--env KEY=VALUE] [--cwd <path>]";
  let model = "", modelSupplied = false, crewCwd = process.cwd(), preset = "", presetSupplied = false;
  const positionals: string[] = [], crewEnv: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--harness") {
      throw new TapError(1, "retired_flag", `tap crew add ${argv[i + 1] || "<h>"} [name]`, "--harness is retired; the harness is now the first positional, the same grammar tap session launch and tap ask take");
    }
    if (arg.startsWith("--harness=")) {
      throw new TapError(1, "retired_flag", `tap crew add ${arg.slice("--harness=".length)} [name]`, "--harness is retired; the harness is now the first positional, the same grammar tap session launch and tap ask take");
    }
    if (arg === "--model" || arg === "--preset" || arg === "--env" || arg === "--cwd") {
      const value = argv[++i];
      if (value === undefined) throw new TapError(1, "usage_error", "tap help crew", `${arg} requires ${arg === "--env" ? "a KEY=VALUE" : "a value"}`);
      if (arg === "--model") { model = value; modelSupplied = true; }
      else if (arg === "--preset") { preset = value; presetSupplied = true; }
      else if (arg === "--env") crewEnv.push("--env", value);
      else crewCwd = value;
      continue;
    }
    if (arg.startsWith("--")) throw new TapError(1, "unknown_option", "tap help crew", `unknown option '${arg}'`);
    if (positionals.length >= 2) throw new TapError(1, "usage_error", "tap help crew", `unexpected arg '${arg}' (crew add takes at most <preset|harness> and a name)`);
    positionals.push(arg);
  }
  if (argv.length === 0) throw new TapError(1, "usage_error", "tap help crew", usage);
  if (positionals.length === 0 && !presetSupplied) throw new TapError(1, "usage_error", "tap help crew", "usage: tap crew add <preset|harness> [name]");

  // The native public resolver owns argv policy and refusal rendering. Keep
  // its stderr separate from its JSON, and leave TAP_JSON caller-controlled.
  // Use Bun from PATH (or a release artifact's shim): process.execPath can be the compiled TAP router.
  const target = spawnSync(artifactBun() ?? "bun", [`${scriptsDir}/../../../runtime/bun/src/launcher/resolve-target.ts`,
    "--usage", "tap crew add <preset|harness> [name]", "--verb", "tap crew", ...positionals, ...(presetSupplied ? ["--preset", preset] : [])],
    { env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, encoding: "utf8" });
  if ((target.status ?? 1) !== 0) return relayRefusal((target.stdout || target.stderr || "").replace(/\n+$/, ""));
  if (target.stderr) process.stderr.write(target.stderr);
  let resolved: { harness: string; handle: string; preset?: string; config_digest?: string; model?: string };
  try {
    resolved = JSON.parse((target.stdout ?? "").trim().split("\n").at(-1)!);
    if (!resolved || typeof resolved.harness !== "string" || typeof resolved.handle !== "string") throw new Error("missing target");
  } catch {
    throw new TapError(1, "registry_invalid", "tap help crew", "could not read the resolved crew target");
  }
  const harness = resolved.harness, handle = resolved.handle;
  const resolvedPreset = resolved.preset ?? "", presetDigest = resolved.config_digest ?? "", resolvedModel = resolved.model ?? "";
  // An implicit preset (positional, no --preset) must reach the launcher as one,
  // or crew-invocation would render an unpresetted seat carrying only the
  // harness — the tuning-dropped class this lane already fixed once in tap ask.
  if (resolvedPreset && !presetSupplied) { preset = resolvedPreset; presetSupplied = true; }
  if (!validToken(handle)) throw new TapError(1, "usage_error", "tap help crew", `handle '${handle}' fails charset ${ID_CHARSET}`);
  if (!existsSync(crewCwd) || !statSync(crewCwd).isDirectory()) {
    throw new TapError(1, "not_found", "choose an existing --cwd", `cwd '${crewCwd}' does not exist`);
  }
  crewCwd = realpathSync(crewCwd);
  // The vector is built from SUPPLIEDNESS, not emptiness: `--model ""` is
  // supplied and invalid, and the launcher must refuse it rather than silently
  // launch a default-model seat.
  const presetArgs = presetSupplied ? ["--preset", preset] : [];
  const digestArgs = presetDigest ? ["--preset-digest", presetDigest] : [];
  const modelArgs = modelSupplied ? ["--model", model] : [];
  // tap-4b9e: the receipt names the selected launch model. An explicit --model
  // wins; otherwise the preset resolution supplies it.
  const selectedModel = modelSupplied ? model : resolvedModel;

  // Validate argv-decidable TUNING before any effect — the 14 named classes
  // abort early; any other nonzero falls through so the ordinary rollback path
  // still runs (a preflight that failed on any nonzero would pre-empt that
  // tested recovery path).
  const preflightArgs = [harness, "preflight/preflight", "--cwd", crewCwd, ...presetArgs, ...digestArgs, ...modelArgs, ...crewEnv];
  const preflight = spawnSync(artifactBun() ?? "bun", [`${scriptsDir}/../../../runtime/bun/src/launcher/crew-invocation.ts`, ...preflightArgs], { env: { ...process.env, TAP_JSON: "1" }, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
  if ((preflight.status ?? 1) !== 0) {
    const payload = preflight.stdout ?? "";
    const classes = ["launch_env_forbidden", "launch_model_unsupported", "launch_effort_unsupported", "launch_arg_invalid", "harness_env_forbidden", "preset_not_found", "preset_not_composable", "preset_harness_mismatch", "preset_config_missing", "preset_config_invalid", "preset_config_insecure", "preset_unsupported", "preset_handle_ambiguous", "preset_config_changed"];
    if (classes.some(c => payload.includes(c))) return relayRefusal(payload);
  }

  const worktreeRoot = gitRoot();
  const override = !worktreeRoot || !(crewCwd === worktreeRoot || crewCwd.startsWith(`${worktreeRoot}/`));
  const ctx = actingContext();
  try { checkCrewRegistry(crewCwd, ctx.registryPath); } catch (error) {
    throw new TapError(1, "crew_registry_mismatch", "use --cwd within the launcher's team or launch from the intended team", error instanceof Error ? error.message : String(error), "tap crew add");
  }
  const observed = observeCallingPane();
  if (observed.state !== "inside") {
    throw new TapError(1, "not_in_tmux", "run tap crew add from the driver tmux session", `caller tmux pane is not observable (${observed.state === "unobservable" ? observed.refusal : observed.detail})`);
  }
  const callerPane = observed.paneId;
  const driverSession = tmuxRead(["display-message", "-p", "-t", callerPane, "#{session_name}"]);
  if (!driverSession) throw new TapError(1, "not_in_tmux", "run tap crew add from the driver tmux session", "caller tmux session is not observable");

  const paneId = runTmux(["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", driverSession, "-n", handle, "-c", crewCwd]);
  process.stderr.write(paneId.stderr);
  if (paneId.code !== 0) throw new TapError(1, "tmux_error", "check the caller session and --cwd", "could not create crew window");
  const newPane = paneId.stdout.replace(/\n+$/, "");
  if (!newPane) throw new TapError(1, "tmux_error", "check the caller session", "tmux created no observable crew pane");
  // tap-fgx9: registry `pane` is an address (session:window.pane), not a bare %id.
  const pane = tmuxRead(["display-message", "-p", "-t", newPane, "#{session_name}:#{window_index}.#{pane_index}"]);
  if (!pane) {
    tmux(["kill-window", "-t", newPane], { stdio: "ignore" });
    throw new TapError(1, "tmux_error", "check the caller session", `could not resolve address for crew pane '${newPane}'`);
  }

  const [regCmd, ...regArgs] = verbArgv(scriptsDir, ["register", handle, "--pane", pane, "--crew", "--json", ...(override ? ["--override-worktree"] : [])]);
  const registration = spawnSync(regCmd!, regArgs, {
    env: { ...process.env, TAP_REGISTER_EXPECTED_HARNESS: harness, TAP_REGISTER_SUPPRESS_IDENTITY_CAPTURE: "1" },
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
  });
  if ((registration.status ?? 1) !== 0) {
    tmux(["kill-window", "-t", newPane], { stdio: "ignore" });
    const text = (registration.stdout ?? "").replace(/\n+$/, "");
    if (text) process.stderr.write(`${text}\n`);
    else process.stderr.write(`tap crew add: registration failed (exit ${registration.status ?? 1}); next: tap team / tap doctor\n`);
    return registration.status ?? 1;
  }
  let chosenHandle = "", chosenTeam = "";
  try {
    const receipt = (JSON.parse(registration.stdout ?? "{}") as { receipt?: { handle?: unknown; team?: unknown } }).receipt;
    if (!receipt || typeof receipt !== "object") throw new Error("no receipt");
    chosenHandle = typeof receipt.handle === "string" ? receipt.handle : "";
    chosenTeam = typeof receipt.team === "string" ? receipt.team : "";
    if (!chosenHandle || !chosenTeam) throw new Error("missing receipt fields");
  } catch {
    tmux(["kill-window", "-t", newPane], { stdio: "ignore" });
    throw new TapError(1, "registry_invalid", "tap team refresh", "crew registration returned an unreadable receipt; the dead crew row was left for the explicit broom");
  }
  if (chosenHandle !== handle) {
    rollback(scriptsDir, newPane, chosenHandle);
    throw new TapError(1, "handle_collision", `choose another handle or unregister ${handle}`, `handle '${handle}' is already held by a registration; tap crew add requires the exact requested handle (registration chose '${chosenHandle}'). Run 'tap team' to see what holds it — a LIVE pane, a pane-less POLL seat, or a row whose pane could not be observed are three different situations with three different remedies (tap-hgzj)`);
  }

  // The register child may move authority (first-entry enroll creates the
  // acting store and rebinds the index), so the recipe is persisted against a
  // FRESH resolution, never the pre-registration sample. A failed, empty, or
  // unreadable re-resolution refuses; an explicit marker absence still selects
  // the legitimate legacy path inside the resolver.
  let fresh: ResolvedContext;
  try {
    fresh = resolveSelection(process.env.TAP_HOME ?? "", chosenTeam);
  } catch {
    rollback(scriptsDir, newPane, chosenHandle);
    throw new TapError(1, "registry_unreachable", "tap doctor", "acting registry could not be re-resolved after crew registration");
  }
  if (!fresh.registryPath) {
    rollback(scriptsDir, newPane, chosenHandle);
    throw new TapError(1, "registry_unreachable", "tap doctor", "acting registry could not be re-resolved after crew registration");
  }
  const invocationArgs = [harness, `${chosenTeam}/${chosenHandle}`, "--cwd", crewCwd, "--record-pane", newPane, "--record-registry", fresh.registryPath, ...presetArgs, ...digestArgs, ...modelArgs, ...crewEnv];
  const invocation = spawnSync(artifactBun() ?? "bun", [`${scriptsDir}/../../../runtime/bun/src/launcher/crew-invocation.ts`, ...invocationArgs], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (invocation.stderr) process.stderr.write(invocation.stderr);
  if ((invocation.status ?? 1) !== 0) {
    rollback(scriptsDir, newPane, chosenHandle);
    const text = (invocation.stdout ?? "").replace(/\n+$/, "");
    if (text) process.stderr.write(`${text}\n`);
    else process.stderr.write(`tap crew add: launch preparation failed (exit ${invocation.status ?? 1}); next: tap help crew / tap doctor\n`);
    return invocation.status ?? 1;
  }
  // Supervision is acknowledged before the new seat is published. The helper
  // observes the initial shell's process generation; `exec` preserves it.
  let lifetime;
  try { lifetime = await armNewCrew(fresh, callerPane, chosenHandle); }
  catch (error) {
    rollback(scriptsDir, newPane, chosenHandle);
    throw error;
  }
  try {
    if (tmux(["send-keys", "-t", newPane, "-l", "--", literalKeysArg(`exec env ${(invocation.stdout ?? "").replace(/\n+$/, "")}`)]) !== 0 || tmux(["send-keys", "-t", newPane, "Enter"]) !== 0) {
      rollback(scriptsDir, newPane, chosenHandle);
      throw new TapError(1, "tmux_error", "retry tap crew add", `could not start ${harness} in crew pane '${newPane}'`);
    }
  } catch (error) {
    // A timed-out send may have taken effect: no Enter, retry, or rollback.
    if (error instanceof ServerUnresponsive) throw new TapError(1, error.tapErrorClass,
      `inspect the server; do not retry a possible effect; after inspection, cleanup: tmux kill-window -t '${newPane}'`, error.message);
    throw error;
  }
  // A parent can exit between the helper's acknowledgement and the send.
  if (!validateCrewLifetimeBinding(lifetime)) {
    rollback(scriptsDir, newPane, chosenHandle);
    throw new TapError(1, "crew_parent_exited", "retry from a live parent harness", "parent or helper generation changed while starting the crew");
  }
  process.stdout.write(`tap crew add: started ${chosenTeam}/${chosenHandle} (${harness}, model=${selectedModel}) in ${pane}\n`);
  return 0;
}

function gitRoot(): string {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (r.status !== 0) return realpathSync(process.cwd());
  try { return realpathSync((r.stdout ?? "").trim()); } catch { return (r.stdout ?? "").trim(); }
}
