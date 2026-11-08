import { cmdCrewResume } from "../crew-resume";
import { loadRegistry, seatMap } from "../registry";
// `tap crew` — create, resume, list, and shut down crew conversations. One Bun authority.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isFile } from "../watch-lease";
import { observeCallerIdentity, resolveSelf, TapError } from "../context";
import { takeSeatFilters } from "../seat-filter";
import { validToken } from "../ids";
import { checkCrewRegistry } from "../crew-registry";
import { resolveSelection } from "../team-selection";
import type { ResolvedContext } from "../context";
import { cmdTeam } from "./team";
import { ServerUnresponsive, literalKeysArg, tmux as runTmux, tmuxReadOnly } from "../tmux";
import { cmdCrewRelaunch, cmdCrewShutdown, teamContext } from "../crew-lifecycle";
import { authorizeNewCrew, validateCrewProcess } from "../crew-lifetime";
import { verbArgv } from "../courier-argv";
import { artifactBun } from "../scripts-dir";
import { captureNewCrewIdentity } from "../crew-capture";
import { CREW_HELP } from "../help";
import { assignCreatedCrew } from "../crew-assignment";
import { explicitReplyToStamp } from "./send";
import { assertCrewResumeUnheld } from "../crew-resume-identity";
import { NATIVE_CONVERSATION_ID } from "../native-conversation";
import { LauncherError } from "../launcher/types";
import { inWorkdir, stableSpawnCwd } from "../tmux-spawn-cwd";

export const CREW_SUBCOMMANDS = ["list", "add", "resume", "shutdown", "relaunch", "rearm", "remove"] as const;

const ID_CHARSET = "^[A-Za-z0-9][A-Za-z0-9._-]*$";
const CREW_ADD_USAGE = "tap crew add <preset|harness> [name] [--preset <name>] [--model <m>] [--resume <native-id>] [--env KEY=VALUE] [--unset-env KEY] [--cwd <path>] [--assign <brief-file> [--reply-to <seat>]] [-- harness-arguments...]";

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

/** Registration checks the pane's path, and the crew shell changes into its
 * directory only after tmux starts it: wait until it is there. False when it
 * never arrives or the pane is gone. */
function awaitPaneIn(pane: string, dir: string, timeoutMs = 3000): boolean {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const path = tmuxRead(["display-message", "-p", "-t", pane, "#{pane_current_path}"]);
    if (!path) return false;
    try { if (realpathSync(path) === dir) return true; } catch { /* not resolvable yet */ }
    if (Date.now() >= deadline) return false;
    Bun.sleepSync(20);
  }
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
    const unfiltered = takeSeatFilters(rest, "tap help crew").rest.filter(arg => !["--no-state", "--no-cache"].includes(arg));
    if (unfiltered.length > 0) throw new TapError(1, "usage_error", "tap help crew", `unexpected arg '${unfiltered[0]}'`);
    process.env.TAP_TEAM_CREW_ONLY = "1";
    process.env.TAP_TEAM_LIST_VERB = "crew list";
    return cmdTeam(rest, scriptsDir);
  }
  if (sub === "add") return cmdCrewAdd(rest, scriptsDir);
  if (sub === "shutdown") return cmdCrewShutdown(rest, scriptsDir);
  if (sub === "resume") return cmdCrewResume(rest, scriptsDir);
  if (sub === "relaunch" && rest.includes("--resume")) {
    if (rest.filter(arg => arg === "--resume").length !== 1) throw new TapError(1, "usage_error", "tap help crew", "pass --resume once");
    return cmdCrewResume(rest.filter(arg => arg !== "--resume"), scriptsDir, true);
  }
  if (sub === "relaunch") return cmdCrewRelaunch(rest);
  if (sub === "rearm") return cmdCrewRearm(rest);
  // `remove` is the one-crew alias of shutdown, without the owner forms.
  if (sub === "remove") return cmdCrewShutdown(rest, scriptsDir, true);
  if (sub === "up" || sub === "down") {
    throw new TapError(1, "retired_verb", sub === "up" ? "tap crew add <preset|harness> [name]" : "tap crew shutdown [<crew>|--owner <handle>]",
      `tap crew ${sub} does not exist: use crew resume to continue a retained conversation or crew shutdown to remove it`);
  }
  if (sub === "") throw new TapError(1, "usage_error", "tap help crew", `usage: ${CREW_ADD_USAGE} | tap crew shutdown [<crew>|<owner>|--owner <handle|team/handle>] | tap crew relaunch <crew> | tap crew rearm <crew> | tap crew list`);
  if (sub.startsWith("--")) throw new TapError(1, "unknown_option", "tap help crew", `unknown option '${sub}'`);
  throw new TapError(1, "unknown_subcommand", "tap help crew", `unknown subcommand '${sub}' (usage: tap crew [add|resume|shutdown|relaunch|rearm|remove|list])`);
}

function cmdCrewRearm(_argv: string[]): never {
  throw new TapError(1, "retired_verb", "tap crew resume <crew>",
    "crews now have independent lifetime; rearm no longer starts a parent-death helper");
}

function actingContext(): ResolvedContext {
  const ctx = resolveSelection(process.env.TAP_HOME ?? "", "");
  if (!isFile(ctx.registryPath)) throw new TapError(1, "not_found", "tap team / tap doctor", "no acting registry for this team");
  return ctx;
}

async function cmdCrewAdd(argv: string[], scriptsDir: string): Promise<number> {
  const usage = `usage: ${CREW_ADD_USAGE}`;
  let model = "", modelSupplied = false, crewCwd = process.cwd(), preset = "", presetSupplied = false;
  let assignmentFile = "", replyTo = "";
  let resumeId: string | undefined;
  // Everything after the first bare `--` goes literally to the harness, as with tap session launch.
  const dash = argv.indexOf("--");
  const own = dash < 0 ? argv : argv.slice(0, dash), tail = dash < 0 ? [] : argv.slice(dash + 1);
  // Overrides reach the preparation child as inline tokens: its parser rejects a dash-led separate value.
  const positionals: string[] = [], overrides: string[] = tail.map(token => `--harness-arg=${token}`);
  for (let i = 0; i < own.length; i++) {
    const arg = own[i]!;
    if (arg === "--harness") {
      throw new TapError(1, "retired_flag", `tap crew add ${own[i + 1] || "<h>"} [name]`, "--harness is retired; the harness is now the first positional, the same grammar tap session launch and tap ask take");
    }
    if (arg.startsWith("--harness=")) {
      throw new TapError(1, "retired_flag", `tap crew add ${arg.slice("--harness=".length)} [name]`, "--harness is retired; the harness is now the first positional, the same grammar tap session launch and tap ask take");
    }
    const at = arg.indexOf("=");
    const flag = arg.startsWith("--") && at > 0 ? arg.slice(0, at) : arg;
    if (["--model", "--preset", "--env", "--unset-env", "--cwd", "--assign", "--reply-to", "--resume"].includes(flag)) {
      const value = flag === arg ? own[++i] : arg.slice(at + 1);
      if (value === undefined) throw new TapError(1, "usage_error", "tap help crew", `${flag} requires ${flag === "--env" ? "a KEY=VALUE" : flag === "--unset-env" ? "a KEY" : "a value"}`);
      if ((flag === "--assign" || flag === "--reply-to") && value === "") {
        throw new TapError(1, "usage_error", "tap help crew", `${flag} requires a non-empty value`);
      }
      if (flag === "--model") { model = value; modelSupplied = true; }
      else if (flag === "--resume") {
        if (resumeId !== undefined || !NATIVE_CONVERSATION_ID.test(value)) throw new TapError(1, "usage_error", "tap help crew", "pass --resume once with one non-empty exact native conversation id");
        resumeId = value;
      }
      else if (flag === "--preset") { preset = value; presetSupplied = true; }
      else if (flag === "--env" || flag === "--unset-env") overrides.push(`${flag}=${value}`);
      else if (flag === "--assign") assignmentFile = value;
      else if (flag === "--reply-to") replyTo = value;
      else crewCwd = value;
      continue;
    }
    if (arg === "-h" || arg === "--help") { process.stdout.write(CREW_HELP); return 0; }
    if (arg.startsWith("--")) throw new TapError(1, "unknown_option", "put harness arguments after --, e.g. tap crew add <preset|harness> [name] -- <harness-args>; see tap help crew", `unknown option '${arg}'`);
    if (positionals.length >= 2) throw new TapError(1, "usage_error", "tap help crew", `unexpected arg '${arg}' (crew add takes at most <preset|harness> and a name; put harness arguments after --)`);
    positionals.push(arg);
  }
  if (argv.length === 0) throw new TapError(1, "usage_error", "tap help crew", usage);
  if (positionals.length === 0 && !presetSupplied) throw new TapError(1, "usage_error", "tap help crew", "usage: tap crew add <preset|harness> [name]");
  if (replyTo && !assignmentFile) throw new TapError(1, "usage_error", "tap help crew", "--reply-to requires --assign <brief-file>");
  if (replyTo && (replyTo.split("/").length > 2 || !replyTo.split("/").every(validToken))) {
    throw new TapError(1, "usage_error", "tap help crew", "--reply-to requires a handle or team/handle");
  }
  if (assignmentFile) {
    try {
      if (!statSync(assignmentFile).isFile()) throw new Error("not a regular file");
      assignmentFile = realpathSync(assignmentFile);
      readFileSync(assignmentFile);
    } catch {
      throw new TapError(1, "invalid_brief", "pass --assign with a readable regular brief file", `cannot read assignment brief '${assignmentFile}'; no crew started`);
    }
  }

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
  const resumeArgs = resumeId === undefined ? [] : ["--resume", resumeId];
  const digestArgs = presetDigest ? ["--preset-digest", presetDigest] : [];
  const modelArgs = modelSupplied ? ["--model", model] : [];
  // tap-4b9e: the receipt names the selected launch model. An explicit --model
  // wins; otherwise the preset resolution supplies it.
  const selectedModel = modelSupplied ? model : resolvedModel;

  // Validate argv-decidable TUNING before any effect — the 14 named classes
  // abort early; any other nonzero falls through so the ordinary rollback path
  // still runs (a preflight that failed on any nonzero would pre-empt that
  // tested recovery path).
  const preflightArgs = [harness, "preflight/preflight", "--cwd", crewCwd, ...presetArgs, ...digestArgs, ...modelArgs, ...overrides, ...resumeArgs];
  const preflight = spawnSync(artifactBun() ?? "bun", [`${scriptsDir}/../../../runtime/bun/src/launcher/crew-invocation.ts`, ...preflightArgs], { env: { ...process.env, TAP_JSON: "1" }, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
  if ((preflight.status ?? 1) !== 0) {
    const payload = preflight.stdout ?? "";
    const classes = ["launch_env_forbidden", "launch_model_unsupported", "launch_effort_unsupported", "launch_arg_invalid", "harness_env_forbidden", "preset_not_found", "preset_not_composable", "preset_harness_mismatch", "preset_config_missing", "preset_config_invalid", "preset_config_insecure", "preset_unsupported", "preset_handle_ambiguous", "preset_config_changed"];
    if (resumeId !== undefined || classes.some(c => payload.includes(c))) return relayRefusal(payload);
  }

  const ctx = actingContext();
  if (resumeId !== undefined) {
    try { assertCrewResumeUnheld(harness, resumeId, ctx.registryPath); }
    catch (error) {
      if (!(error instanceof LauncherError)) throw error;
      throw new TapError(1, error.errorClass || "crew_resume_refused", error.action || "tap help crew", error.detail || error.message);
    }
  }
  const held = seatMap(loadRegistry(ctx.registryPath))[handle];
  if (held?.crew === true || held?.crew === 1) throw new TapError(1, "handle_collision",
    `tap crew resume ${handle} or tap crew remove ${handle}`,
    `crew '${handle}' is retained; resume it or explicitly remove it before adding another conversation`);
  const override = !(crewCwd === ctx.root || crewCwd.startsWith(`${ctx.root}/`));
  try { checkCrewRegistry(crewCwd, ctx.registryPath); } catch (error) {
    throw new TapError(1, "crew_registry_mismatch", "use --cwd within the launcher's team or launch from the intended team", error instanceof Error ? error.message : String(error), "tap crew add");
  }
  const observed = observeCallerIdentity();
  if (observed.state !== "inside") {
    throw new TapError(1, "not_in_tmux", "run tap crew add from the driver tmux session", `caller tmux pane is not observable (${observed.state === "unobservable" ? observed.refusal : observed.detail})`);
  }
  const callerPane = observed.paneId;
  if (replyTo) replyTo = explicitReplyToStamp(replyTo, resolveSelf(ctx, { ...observed, status: "ok" }, 1).handle, ctx);
  const driverSession = tmuxRead(["display-message", "-p", "-t", callerPane, "#{session_name}"]);
  if (!driverSession) throw new TapError(1, "not_in_tmux", "run tap crew add from the driver tmux session", "caller tmux session is not observable");

  // The crew's login shell enters crewCwd by path; tmux itself starts it in $HOME (tmux-spawn-cwd.ts).
  const paneId = runTmux(["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", driverSession, "-n", handle,
    "-c", stableSpawnCwd(process.env), inWorkdir(crewCwd, 'exec "$SHELL" -l')]);
  process.stderr.write(paneId.stderr);
  if (paneId.code !== 0) throw new TapError(1, "tmux_error", "check the caller session and --cwd", "could not create crew window");
  const newPane = paneId.stdout.replace(/\n+$/, "");
  if (!newPane) throw new TapError(1, "tmux_error", "check the caller session", "tmux created no observable crew pane");
  if (!awaitPaneIn(newPane, crewCwd)) {
    tmux(["kill-window", "-t", newPane], { stdio: "ignore" });
    throw new TapError(1, "tmux_error", "check --cwd and retry tap crew add", `crew shell did not reach '${crewCwd}'`);
  }
  // tap-fgx9: registry `pane` is an address (session:window.pane), not a bare %id.
  const pane = tmuxRead(["display-message", "-p", "-t", newPane, "#{session_name}:#{window_index}.#{pane_index}"]);
  if (!pane) {
    tmux(["kill-window", "-t", newPane], { stdio: "ignore" });
    throw new TapError(1, "tmux_error", "check the caller session", `could not resolve address for crew pane '${newPane}'`);
  }

  const [regCmd, ...regArgs] = verbArgv(scriptsDir, ["register", handle, "--pane", pane, "--crew", "--json", ...(override ? ["--override-worktree"] : [])]);
  const registration = spawnSync(regCmd!, regArgs, {
    env: { ...process.env, TAP_REGISTER_EXPECTED_HARNESS: harness, TAP_REGISTER_SUPPRESS_IDENTITY_CAPTURE: "1", TAP_REGISTER_CREW_OWNER_PANE: callerPane },
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
  const invocationArgs = [harness, `${chosenTeam}/${chosenHandle}`, "--cwd", crewCwd, "--record-pane", newPane, "--record-registry", fresh.registryPath, ...presetArgs, ...digestArgs, ...modelArgs, ...overrides, ...resumeArgs];
  const invocation = spawnSync(artifactBun() ?? "bun", [`${scriptsDir}/../../../runtime/bun/src/launcher/crew-invocation.ts`, ...invocationArgs], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (invocation.stderr) process.stderr.write(invocation.stderr);
  if ((invocation.status ?? 1) !== 0) {
    rollback(scriptsDir, newPane, chosenHandle);
    const text = (invocation.stdout ?? "").replace(/\n+$/, "");
    if (text) process.stderr.write(`${text}\n`);
    else process.stderr.write(`tap crew add: launch preparation failed (exit ${invocation.status ?? 1}); next: tap help crew / tap doctor\n`);
    return invocation.status ?? 1;
  }
  // Prove the caller and new child before starting; later parent loss leaves the crew running.
  let childProof;
  try { childProof = authorizeNewCrew(fresh, callerPane, chosenHandle); }
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
  // The exact crew process must survive startup; its parent may have exited.
  if (!validateCrewProcess(childProof)) {
    throw new TapError(1, "crew_start_unverified", "inspect tap crew list", "crew process changed while starting; its row is retained");
  }
  try { await captureNewCrewIdentity(fresh, scriptsDir, chosenHandle, newPane, childProof.crewInstance, harness); }
  catch (error) {
    process.stderr.write(`tap crew add: native identity capture could not be recorded: ${error instanceof Error ? error.message : String(error)}; next: tap team doctor\n`);
  }
  if (!validateCrewProcess(childProof)) {
    throw new TapError(1, "crew_start_unverified", "inspect tap crew list; use tap crew resume for a stopped crew",
      "crew process changed during native identity capture; its row is retained");
  }
  process.stdout.write(`tap crew add: started ${chosenTeam}/${chosenHandle} (${harness}, model=${selectedModel}) in ${pane}\n`);
  if (assignmentFile) return assignCreatedCrew(fresh, { handle: chosenHandle, instance: childProof.crewInstance,
    pane: newPane, owner: childProof.owner, ownerInstance: childProof.ownerInstance, harness, model: selectedModel,
    preset: resolvedPreset, configDigest: presetDigest }, assignmentFile, replyTo, scriptsDir);
  return 0;
}
