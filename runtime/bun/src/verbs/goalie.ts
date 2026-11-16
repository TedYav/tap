// `tap goalie on|off|status|verdict|tick|run|reap` — the belief-state goalie's
// verb layer, native (R6 U3 cutover; the tick body has been goalie-tick.ts since
// U2 and the lease transactions goalie-lease.ts since U1). Two doors reach ONE
// body: the Bun router (`main.ts` NATIVE_HANDLERS.goalie) and a direct
// `bun` run of this file. `tick` runs the tick body in this
// process; `run` re-execs into the loop's own entry (goalie-run.ts), which
// stamps the sidecar's sources before it loads them — the loop never runs
// inside the router's image.
//
// This file is the only goalie module that resolves a context or an actor; the
// modules it calls (goalie-lease, goalie-tick, watch-registry, watch-sidecar)
// are stamped in the sidecar's source fingerprint and take every fact as an
// argument. Nothing the loop calls imports this file.
//
// Public behavior is the incumbent's, byte for byte: the actor comes from the
// CALLING PANE (never TAP_SELF for the verdict, which authenticates the pane),
// the fence is checked before any registry-dependent work on the mutators, the
// observer resolves once (explicit > the literal `goalie` seat > ONE active
// goalie preset role, ambiguity refuses), and the default courier argv rides
// the public `bash bin/tap send` door (the ruled U2 divergence).

import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";

import { callingPane, resolveContext, resolveSelf, spoolTeamName, TapError, type Context } from "../context";
import { renderRefusals } from "../error-line";
import { assertResetUnfenced, markResetGenerationReused } from "../reset";
import {
  claimVerdict,
  field,
  set as leaseSet,
  snapshotLines,
  unclaimVerdict,
  disarm as leaseDisarm,
  reapTo,
} from "../goalie-lease";
import { tickEntry, realGoalieDoors } from "../goalie-tick";
import { pidAlive } from "../watch-sidecar";
import { repoRoot, teamSession } from "../watch-registry";
import { isFile, readLoose, recordBytes } from "../watch-lease";
import { activePane, courierDisposition, readRegistryText, seatMapOf } from "../watch-tick";
import { rosterDisplayFacts, tryLoadCatalogForDisplay } from "../launcher/catalog-listing";
import { sq } from "../watch-sidecar";
import { bunBinary, courierArgv } from "../courier-argv";
import { configDirectory, isRegularFile, readSecureBytes } from "../launcher/catalog";
import { childBusEnv, lockRoot } from "../panelock";
import { Notices } from "../launcher/catalog-notices";
import { tapScriptsDir } from "../scripts-dir";
import { inWorkdir, stableSpawnCwd } from "../tmux-spawn-cwd";
import { ownBunArgv, ownBunFlags } from "../own-bun";

const TAP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HELP = "tap help goalie";
const USAGE = "usage: tap goalie <on|off|status> [--feeder <handle>] [--ledger <abs-path>] [...]  (verdict/tick/run are sidecar internals; see: tap help goalie)";
/** lib.sh:10207 resets TAP_WATCH_IDENTITY unconditionally at source time, so the
 * incumbent's notice/probe sender is ALWAYS the reserved watcher identity. */
const WATCH_IDENTITY = "watcher";
/** The loop's process signature (was `tap-goalie.sh run` in the Bash sidecar). */
const RUN_SIGNATURE = "goalie-run.ts run";
const GOALIE_WINDOW = "goalie-sidecar";

function fail(code: number, klass: string, action: string, detail: string): never {
  throw new TapError(code, klass, action.replace(/[\r\n]/g, " "), detail.replace(/[\r\n]/g, " "), "tap goalie");
}
function usage(detail: string): never { fail(1, "usage_error", HELP, detail); }
function unknownOption(arg: string): never { fail(1, "unknown_option", HELP, `unknown option '${arg}'`); }
function value(argv: string[], i: number, message: string): string {
  const v = argv[i + 1];
  if (v === undefined || v === "") usage(message);
  return v;
}
function now(env: NodeJS.ProcessEnv): string {
  return env.TAP_GOALIE_NOW || String(Math.floor(Date.now() / 1000));
}
function scriptsDirOf(scripts?: string): string {
  return scripts ?? tapScriptsDir();
}

function armPathOf(home: string): string { return home + "/goalie/arm.json"; }
function isArmed(home: string): boolean { return isFile(armPathOf(home)); }

function pyStr(v: unknown): string {
  if (v === null) return "None";
  if (v === undefined) return "";
  return String(v);
}
/** `_goalie_registry_pane`: the seat's pane field, empty when absent. */
function registryPane(registryPath: string, handle: string): string {
  const raw = seatMapOf(readRegistryText(registryPath)).get(handle);
  if (!(raw instanceof Map)) return "";
  return pyStr((raw as Map<string, unknown>).get("pane"));
}
/** `tap_pane_alive`: prints the pane id; fails when the pane is gone. */
function paneAlive(pane: string): boolean {
  if (pane === "") return false;
  const r = spawnSync("tmux", ["display-message", "-p", "-t", pane, "#{pane_id}"], { encoding: "utf8" });
  return r.status === 0 && (r.stdout ?? "").trim() !== "";
}
/** `tap_valid_token`. */
const validToken = (s: string) => TAP_ID_RE.test(s);

/**
 * `_goalie_resolve_handle`: explicit > the active literal `goalie` seat > ONE
 * active seat whose preset roles carry `goalie` (record-first, name-guess
 * second, like `roster_display_facts`); >1 match prints AMBIGUOUS and refuses.
 */
function resolveHandle(ctx: Context, explicit: string, env: NodeJS.ProcessEnv): string {
  if (explicit !== "") return explicit;
  if (activePane(ctx.registryPath, "goalie")) return "goalie";
  const seats = seatMapOf(readRegistryText(ctx.registryPath));
  const active: string[] = [];
  const recorded = new Map<string, string>();
  for (const handle of [...seats.keys()].sort()) {
    const raw = seats.get(handle);
    if (!(raw instanceof Map)) continue;
    const ent = raw as Map<string, unknown>;
    const status = ent.has("status") ? pyStr(ent.get("status")) : "active";
    if (status !== "active" || pyStr(ent.get("delivery")) === "poll") continue;
    active.push(handle);
    const preset = ent.get("preset");
    if (preset instanceof Map) {
      const name = preset.get("name");
      if (name !== undefined && name !== null && pyStr(name) !== "") recorded.set(handle, pyStr(name));
    }
  }
  const notices = new Notices();
  const dir = configDirectory(env);
  const catalog = dir === null ? null : tryLoadCatalogForDisplay(notices, env, readSecureBytes, dir, isRegularFile);
  // Roster facts carry the accepted resolution order: record first, then the
  // catalog's longest-preset-prefix guess for an unrecorded duty-suffixed
  // handle. An exact preset-name lookup here would miss that fallback.
  const facts = rosterDisplayFacts([...seats.keys()].sort().filter((h) => active.includes(h)),
    { recorded: Object.fromEntries(recorded), catalog });
  const hasGoalie = (handle: string): boolean => {
    const roles = String(facts[handle]?.roles ?? "").split(/,\s*/).filter(Boolean);
    return roles.includes("goalie");
  };
  const matched = active.filter(hasGoalie);
  if (matched.length === 1) return matched[0]!;
  if (matched.length > 1) return "AMBIGUOUS\t" + matched.join(",");
  return "";
}

/** `_goalie_validate_seat`: the observer seat must exist, be unambiguous, and be pane-live. */
function validateSeat(ctx: Context, handle: string): void {
  if (handle === "") {
    fail(1, "no_goalie_seat",
      "tap goalie on --goalie <handle>, or launch a seat whose preset carries the goalie role",
      "no active seat carries the goalie role and none is named 'goalie'");
  }
  if (handle.startsWith("AMBIGUOUS")) {
    const list = handle.slice("AMBIGUOUS\t".length);
    fail(1, "ambiguous_goalie_seat", `tap goalie on --goalie <one of: ${list}>`,
      "more than one active seat carries the goalie role; naming one is the board's call, not mine");
  }
  if (!activePane(ctx.registryPath, handle)) {
    fail(1, "no_goalie_seat",
      `tap session launch hermes ${handle} && tap in ${handle}`,
      `the team goalie '${handle}' must be an active pane-backed seat before arming`);
  }
  const pane = registryPane(ctx.registryPath, handle);
  if (!paneAlive(pane)) {
    fail(1, "goalie_pane_gone",
      `restart the '${handle}' seat, run tap in ${handle}, then retry`,
      "the registered goalie pane is gone");
  }
}

/** `_goalie_team_session`: the owner's session, from the registry or the pane target. */
const teamSessionOf = (ctx: Context, owner: string, env: NodeJS.ProcessEnv) =>
  teamSession(ctx.registryPath, owner, env);

/** `_goalie_stop_owned`, with the native loop signature. */
function stopOwned(pid: string, session: string): void {
  const target = session !== "" && pid !== "" && pid !== "0" ? `=${session}:${GOALIE_WINDOW}` : "";
  if (target !== "" && pid !== "" && pid !== "0" &&
    spawnSync("tmux", ["display-message", "-p", "-t", target, "#{pane_pid}"], { encoding: "utf8" }).stdout?.trim() === pid) {
    spawnSync("tmux", ["kill-pane", "-t", target]);
  } else if (pidAlive(pid, RUN_SIGNATURE)) {
    try { process.kill(Number(pid)); } catch { /* gone already */ }
  }
}

/**
 * The goalie sidecar window's full launch command. The pane inherits the tmux
 * server's global environment plus this prefix — not the arming client's env —
 * so the derived TAP_HOME alone would leave sidecar descendants locking under
 * `<bus>/locks` while interactive seats lock under the default root
 * (tap-a5j6t). The armer's resolved lock root rides along explicitly.
 */
export function goalieSidecarCommand(busHome: string, goalieRun: string, env: NodeJS.ProcessEnv = process.env): string {
  return `TAP_LOCK_DIR=${sq(lockRoot(env))} TAP_HOME=${sq(busHome)} exec ${ownBunArgv(bunBinary()).map(sq).join(" ")} ${sq(goalieRun)} run`;
}

/** `_goalie_send_durable` over Bun's own send entry (courier-argv.ts). The
 * selected bus facts ride the env: a stand-in courier cannot rediscover context.
 * `quiet` is the caller's choice: the forced on/off doors always pass it so the
 * typed failure stays the single human line; other callers
 * keep the stderr line. */
function sendDurable(home: string, registryPath: string, scriptsDir: string, env: NodeJS.ProcessEnv, to: string, from: string, kind: string, body: string, quiet = false): { ok: boolean; detail: string } {
  const argv = courierArgv(scriptsDir, [to, "-m", body, "--from", from, "--kind", kind, "--fyi", "--wake", "--json"], env);
  const r = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", env: { ...childBusEnv(home, env), TAP_REGISTRY: registryPath, TAP_SELF: from } });
  const rc = r.status ?? 1;
  const d = courierDisposition(rc, r.stdout ?? "{}", r.stderr ?? "");
  if (d.accepted) return { ok: true, detail: "" };
  if (!quiet) process.stderr.write(`tap goalie: send to '${to}' failed (rc=${rc}): ${d.detail}; next: ${d.action}\n`);
  return { ok: false, detail: `${d.detail}; next: ${d.action}` };
}

// --- on -------------------------------------------------------------------------

function cmdOn(ctx: Context, argv: string[], scriptsDir: string, env: NodeJS.ProcessEnv): number {
  let lead = "", threshold = "1500", interval = "60", goalieHandle = "", feeder = "", ledger = "";
  let rearm = false, force = false, noSpawn = (env.TAP_GOALIE_NO_SPAWN ?? "0") === "1";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--by": lead = value(argv, i, "--by needs a value"); i++; break;
      case "--threshold": threshold = value(argv, i, "--threshold needs a value"); i++; break;
      case "--interval": interval = value(argv, i, "--interval needs a value"); i++; break;
      case "--goalie": goalieHandle = value(argv, i, "--goalie needs a value"); i++; break;
      case "--feeder": feeder = value(argv, i, "--feeder needs a value"); i++; break;
      case "--ledger": ledger = value(argv, i, "--ledger needs a value"); i++; break;
      case "--rearm": rearm = true; break;
      case "--force": force = true; break;
      case "--no-spawn": noSpawn = true; break;
      default:
        if (arg.startsWith("--")) unknownOption(arg);
        usage(`unexpected arg '${arg}'`);
    }
  }
  // Fence before lead/seat validation — mid-reset must refuse before any
  // registry-dependent checks (sol 055309 #6 / unscoped mutator re-audit).
  assertResetUnfenced(ctx.bus.home, "tap goalie on");
  if (!isFile(ctx.registryPath)) {
    fail(1, "not_registered", "tap register <handle>", "no acting registry — cannot arm goalie");
  }
  if (lead === "") lead = resolveActorHandle(ctx, env);
  if (lead === "") fail(1, "no_actor", "tap goalie on --by <lead>", "could not resolve the lead handle");
  if (!validToken(lead)) usage(`lead '${lead}' is not a valid handle`);
  if (!activePane(ctx.registryPath, lead)) {
    fail(1, "goalie_lead_unavailable",
      `register the lead pane, then retry tap goalie on --by ${lead}`,
      `lead '${lead}' is not an active pane-backed seat`);
  }
  goalieHandle = resolveHandle(ctx, goalieHandle, env);
  validateSeat(ctx, goalieHandle);
  if (feeder !== "" && !validToken(feeder)) usage(`--feeder '${feeder}' is not a valid handle`);
  if (ledger !== "" && !ledger.startsWith("/")) {
    usage("--ledger must be an absolute path (the sidecar runs from the team worktree root, not your cwd)");
  }
  for (const [flag, v] of [["--threshold", threshold], ["--interval", interval]] as const) {
    if (v === "" || v === "0" || /[^0-9]/.test(v)) usage(`${flag} must be a positive integer`);
  }

  const armPath = armPathOf(ctx.bus.home);
  const tickNow = now(env);
  mkdirSync(dirname(armPath), { recursive: true });
  let doWrite = true;
  // tap-1e8o: the forced takeover's notice is half of its loudness contract;
  // a send that cannot land still completes the takeover but must not exit 0.
  let notifyOwner = "", notifyOk = true, notifyDetail = "", quiet = false;
  const finish = (rc: number, sidecarLost = rc !== 0): number => {
    if (!notifyOk) {
      // One human line on both doors (CLI-ERR-1): sendDurable runs quiet, so
      // this typed failure carries the courier detail itself. When the sidecar
      // also failed to start, the detail names both facts — the lease IS armed
      // and the takeover is done, so automation must not just re-run this.
      const sidecar = sidecarLost ? "sidecar was not started; lease remains armed; " : "";
      fail(1, "goalie_owner_notify_failed",
        `notify '${notifyOwner}' directly (tap send '${notifyOwner}' --kind notice --fyi --wake -m 'GOALIE: forced re-arm happened; inspect the team') or inspect the team`,
        `${sidecar}force re-arm done (lease now armed by '${lead}'); armer '${notifyOwner}' was NOT notified (send failed: ${notifyDetail})`);
    }
    return rc;
  };
  // tap-pqf2: --rearm skipped this entire block, so the refusal below protected
  // nothing. A non-armer opts in with --force, and the forced path is LOUD.
  if (isArmed(ctx.bus.home) && rearm) {
    const rearmOwner = field(armPath, "armed_by") ?? "";
    if (rearmOwner !== "" && lead !== rearmOwner) {
      if (!force) {
        fail(1, "goalie_rearm_refused",
          `re-run the same command with --force (notifies '${rearmOwner}'), or ask '${rearmOwner}' to re-arm`,
          `goalie is armed by '${rearmOwner}'; '${lead}' cannot re-arm it`);
      }
      notifyOwner = rearmOwner;
      // quiet on BOTH doors: the typed failure below is the
      // one human line, so the courier detail must not also print from
      // sendDurable. quiet then additionally suppresses the prose receipts in
      // JSON mode, where the error object is the whole output.
      const sent = sendDurable(ctx.bus.home, ctx.registryPath, scriptsDir, env, rearmOwner, WATCH_IDENTITY, "notice",
        `GOALIE: The lease was force-re-armed by '${lead}' for a lease armed by '${rearmOwner}'. Inspect the team.`, true);
      notifyOk = sent.ok;
      notifyDetail = sent.detail;
      quiet = env.TAP_JSON === "1" && !notifyOk;
    }
  }
  if (isArmed(ctx.bus.home) && !rearm) {
    const owner = field(armPath, "armed_by") ?? "";
    if (owner === lead && (field(armPath, "threshold_seconds") ?? "") === threshold &&
      (field(armPath, "tick_interval_seconds") ?? "") === interval) {
      doWrite = false;
      process.stdout.write("tap goalie: already armed; keeping the current episode\n");
    } else {
      // The door depends on who is standing at it: a peer is never told to pass
      // the OWNER's handle (that claimed another seat's identity), only the
      // loud --force override. Bare `off` is offered only when the PANE is the
      // owner (`off` is pane-only): `lead` may come from --by/TAP_SELF, and a
      // mismatched or unresolvable pane would be sent to a refusal.
      const door = resolveActorHandle(ctx, env) === owner
        ? "tap goalie off   # or pass --rearm"
        : `tap goalie off --force   # or ask '${owner}' to re-arm`;
      fail(1, "goalie_already_armed", door, `goalie is already armed with different settings by '${owner || "<unknown>"}'`);
    }
  }
  if (doWrite) {
    if (rearm && isArmed(ctx.bus.home)) {
      const oldPid = field(armPath, "watcher_pid") ?? "";
      const oldOwner = field(armPath, "armed_by") ?? "";
      stopOwned(oldPid, teamSessionOf(ctx, oldOwner, env));
    }
    leaseSet(armPath, [
      "armed_by", lead, "armed_at", tickNow, "alarm_generation", randomUUID(),
      "threshold_seconds", threshold, "tick_interval_seconds", interval, "consent_pane_peek", "1",
      "seats", "{}", "ageable_samples", "[]", "heartbeat_at", "0", "watcher_pid", "0", "watcher_pane", "",
      "feeder", feeder, "board_ledger", ledger, "goalie_handle", goalieHandle,
      "deadlock_since", "0", "wake_id", "", "wake_at", "0", "wake_rung", "0",
      "exception_tag", "", "exception_until", "0", "exception_refused", "",
    ], { ...env, TAP_GOALIE_ALLOW_CREATE: "1" });
    markResetGenerationReused(ctx.bus.home, "goalie");
    if (!quiet) {
      // A failed owner notice owns stderr: its typed failure is the one human
      // line (CLI-ERR-1), so the diagnostics below yield to it.
      if (notifyOk) process.stderr.write("tap goalie: consent: the goalie seat may read teammate pane transcripts while this lease is armed\n");
      process.stdout.write(`tap goalie: armed by '${lead}'; checks after ${threshold}s; repeats every ${interval}s\n`);
      if (notifyOk && (!isArmed(ctx.bus.home) || !watchIsArmed(ctx.bus.home))) {
        process.stderr.write("tap goalie: warning: tap watch is not armed; the full goalie-to-lead-to-machine escalation chain is incomplete\n");
      }
    }
  }
  if (noSpawn) {
    if (!quiet) process.stdout.write("tap goalie: sidecar spawn skipped because --no-spawn was requested\n");
    return finish(0);
  }

  let pid = field(armPath, "watcher_pid") ?? "";
  let heartbeat = field(armPath, "heartbeat_at") ?? "";
  if (heartbeat === "") heartbeat = "0";
  let stale = Number(interval) * 3;
  if (stale < 180) stale = 180;
  if (pidAlive(pid, RUN_SIGNATURE) && (heartbeat === "0" || Number(tickNow) - Number(heartbeat) <= stale)) {
    if (!quiet) process.stdout.write("tap goalie: sidecar already running\n");
    return finish(0);
  }
  const session = teamSessionOf(ctx, lead, env);
  if (session === "") {
    if (!quiet && notifyOk) process.stderr.write(`tap goalie: no tmux session is available for '${lead}'; lease remains armed but sidecar was not started\n`);
    // sidecarLost even at rc 0: a notice failure here must not claim the
    // sidecar started.
    return finish(0, true);
  }
  stopOwned(pid, session);
  const root = repoRoot(ctx.registryPath, process.cwd());
  const goalieRun = resolve(scriptsDir, "../../../runtime/bun/src/goalie-run.ts");
  const spawnedCmd = goalieSidecarCommand(ctx.bus.home, goalieRun, env);
  const spawned = spawnSync("tmux", ["new-window", "-d", "-P", "-F", "#{pane_id} #{pane_pid}",
    "-t", `=${session}`, "-n", GOALIE_WINDOW, "-c", stableSpawnCwd(process.env), inWorkdir(root, spawnedCmd)], { encoding: "utf8" });
  const [paneId = "", panePid = ""] = (spawned.stdout ?? "").trim().split(/\s+/);
  if (panePid === "") {
    if (!quiet && notifyOk) process.stderr.write("tap goalie: could not start the sidecar; lease remains armed\n");
    return finish(1);
  }
  leaseSet(armPath, ["watcher_pid", panePid, "watcher_pane", paneId], env);
  if (!quiet) process.stdout.write(`tap goalie: sidecar started in session '${session}'\n`);
  return finish(0);
}

/** `tap_watch_is_armed` over the RESOLVED bus home. */
const watchIsArmed = (busHome: string) => isFile(busHome + "/watch/arm.json");

// --- off ------------------------------------------------------------------------

function cmdOff(ctx: Context, argv: string[], scriptsDir: string, env: NodeJS.ProcessEnv): number {
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      // Parsed so old scripts do not hit unknown_option, but it grants no
      // authority: a peer naming the owner would disarm as the owner (tap-calo).
      case "--by": value(argv, i, "--by needs a value"); i++; break;
      case "--force": force = true; break;
      default:
        if (arg.startsWith("--")) unknownOption(arg);
        usage(`unexpected arg '${arg}'`);
    }
  }
  assertResetUnfenced(ctx.bus.home, "tap goalie off");
  if (!isArmed(ctx.bus.home)) {
    process.stdout.write("tap goalie: already disarmed\n");
    return 0;
  }
  // Disarm authority is the actual current pane, never TAP_SELF or --by. An
  // unresolvable pane is "" and only --force proceeds, attributed "unknown".
  const actor = resolveActorHandle(ctx, env);
  const armPath = armPathOf(ctx.bus.home);
  const owner = field(armPath, "armed_by") ?? "";
  if (actor !== owner && !force) {
    fail(1, "goalie_off_refused",
      `run 'tap goalie off --force' for the loud escape (it notifies '${owner}'), or ask '${owner}' to disarm`,
      "only the goalie armer may disarm by default");
  }
  let notifyOk = true, notifyDetail = "", quiet = false;
  if ((actor || "") !== owner) {
    // quiet on BOTH doors: the typed failure below is the
    // one human line, so the courier detail must not also print from
    // sendDurable. quiet then additionally suppresses the prose receipt in
    // JSON mode, where the error object is the whole output.
    const sent = sendDurable(ctx.bus.home, ctx.registryPath, scriptsDir, env, owner, WATCH_IDENTITY, "notice",
      `GOALIE: The sidecar was force-disarmed by '${actor || "unknown"}' for a lease armed by '${owner}'. Inspect the team before re-arming.`, true);
    notifyOk = sent.ok;
    notifyDetail = sent.detail;
    quiet = env.TAP_JSON === "1" && !notifyOk;
  }
  const pid = field(armPath, "watcher_pid") ?? "";
  const session = teamSessionOf(ctx, owner, env);
  leaseDisarm(armPath);
  markResetGenerationReused(ctx.bus.home, "goalie");
  stopOwned(pid, session);
  if (!quiet) process.stdout.write(`tap goalie: disarmed by '${actor || "unknown"}'\n`);
  // tap-1e8o: the disarm is done; the missed notice still refuses success.
  if (!notifyOk) {
    fail(1, "goalie_owner_notify_failed",
      `notify '${owner}' directly (tap send '${owner}' --kind notice --fyi --wake -m 'GOALIE: forced disarm happened; inspect the team before re-arming') or inspect the team`,
      `force disarm done (lease removed); armer '${owner}' was NOT notified (send failed: ${notifyDetail})`);
  }
  return 0;
}

// --- status ---------------------------------------------------------------------

function cmdStatus(ctx: Context, argv: string[], env: NodeJS.ProcessEnv): number {
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") { json = true; continue; }
    if (arg.startsWith("--")) unknownOption(arg);
    usage(`unexpected arg '${arg}'`);
  }
  if (!isArmed(ctx.bus.home)) {
    process.stdout.write(json ? '{"armed":false}\n' : "tap goalie: disarmed\n");
    return 0;
  }
  const armPath = armPathOf(ctx.bus.home);
  let armedBy = "", armedAt = "", threshold = "", interval = "", seats = "{}", heartbeat = "",
    pid = "", feeder = "", ledger = "", goalieSeat = "", wakeId = "", wakeRung = "";
  for (const line of snapshotLines(armPath)) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const key = line.slice(0, tab), v = line.slice(tab + 1);
    if (key === "armed_by") armedBy = v;
    else if (key === "armed_at") armedAt = v;
    else if (key === "threshold_seconds") threshold = v;
    else if (key === "tick_interval_seconds") interval = v;
    else if (key === "seats") seats = v;
    else if (key === "heartbeat_at") heartbeat = v;
    else if (key === "watcher_pid") pid = v;
    else if (key === "feeder") feeder = v;
    else if (key === "board_ledger") ledger = v;
    else if (key === "goalie_handle") goalieSeat = v;
    else if (key === "wake_id") wakeId = v;
    else if (key === "wake_rung") wakeRung = v;
  }
  const alive = pidAlive(pid, RUN_SIGNATURE);
  if (json) {
    const record = (isFile(armPath) ? readLoose(armPath) : {}) as Record<string, unknown>;
    record["armed"] = true;
    record["watcher_alive"] = alive;
    process.stdout.write(recordBytes(record) + "\n");
    return 0;
  }
  // The incumbent faults here (python `.values()` on a non-object raises) rather
  // than printing healthy-looking zeros; keep that disposition.
  let tracked = 0, open = 0;
  let seatMap: unknown;
  try {
    seatMap = JSON.parse(seats);
  } catch {
    seatMap = null;
  }
  if (seatMap === null || typeof seatMap !== "object" || Array.isArray(seatMap)) {
    // The incumbent prints the header, then faults (python `.values()` on a
    // non-object raises) rather than printing healthy-looking zeros.
    process.stdout.write("tap goalie: armed\n");
    process.stderr.write(`tap goalie: malformed seats in the lease record (${seats.slice(0, 60)}); refusing to invent counts\n`);
    return 1;
  }
  tracked = Object.keys(seatMap as Record<string, unknown>).length;
  for (const v of Object.values(seatMap as Record<string, unknown>)) {
    if ((v as { episode_started_at?: number } | null)?.episode_started_at) open += 1;
  }
  const out: string[] = [];
  out.push("tap goalie: armed");
  out.push(`  armed by: ${armedBy}`);
  out.push(`  armed at: ${armedAt}`);
  out.push(`  threshold: ${threshold}s`);
  out.push(`  interval: ${interval}s`);
  out.push(`  tracked: ${tracked}`);
  out.push(`  open: ${open}`);
  out.push(`  heartbeat: ${heartbeat}`);
  out.push(`  goalie seat: ${goalieSeat || "goalie"}`);
  out.push(`  feeder: ${feeder || "<unset — defaults to the armer>"}`);
  out.push(`  ledger: ${ledger || "<no ledger configured>"}`);
  out.push(`  wake: ${wakeId || "<none outstanding>"}${wakeRung !== "" ? ` (rung ${wakeRung})` : ""}`);
  out.push(`  pid: ${pid}`);
  out.push(`  alive: ${alive ? "yes" : "no"}`);
  process.stdout.write(out.join("\n") + "\n");
  return 0;
}

// --- verdict --------------------------------------------------------------------

function cmdVerdict(ctx: Context, argv: string[], scriptsDir: string, env: NodeJS.ProcessEnv): number {
  let seat = "", episode = "", token = "", action = "", target = "", reason = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--seat": seat = value(argv, i, "--seat needs a value"); i++; break;
      case "--episode": episode = value(argv, i, "--episode needs a value"); i++; break;
      case "--token": token = value(argv, i, "--token needs a value"); i++; break;
      case "--action": action = value(argv, i, "--action needs a value"); i++; break;
      case "--target": target = value(argv, i, "--target needs a value"); i++; break;
      case "--reason": reason = value(argv, i, "--reason needs a value"); i++; break;
      default:
        if (arg.startsWith("--")) unknownOption(arg);
        usage(`unexpected arg '${arg}'`);
    }
  }
  if (!["wake-seat:phantom-wait", "wake-seat:settled-undone", "wake-seat:stale-wait", "wake-lead:unsure", "clear:clean"]
    .includes(`${action}:${reason}`)) {
    fail(1, "invalid_goalie_verdict",
      "use --action wake-seat with phantom-wait|settled-undone|stale-wait; --action wake-lead with unsure; or --action clear with clean",
      "verdict action/reason is outside the allowlist");
  }
  if (action === "wake-seat") {
    if (target === "") usage("wake-seat requires --target <handle>");
  } else if (target !== "") {
    usage("--target is valid only with wake-seat");
  }
  if (!validToken(seat)) usage("--seat must name the candidate handle");
  if (episode === "" || episode === "0" || /[^0-9]/.test(episode)) usage("--episode must be a positive integer");
  if (!validToken(token)) usage("--token must be the capability from the judge request");

  // Verdict authority is the actual current pane, never TAP_SELF or --by.
  const actor = resolveActorHandle(ctx, env);
  const armPath = armPathOf(ctx.bus.home);
  const goalieHandle = field(armPath, "goalie_handle") ?? "";
  if (actor !== goalieHandle) {
    fail(1, "goalie_verdict_refused",
      `run the verdict command from the '${goalieHandle}' pane (the seat carrying the goalie role)`,
      "only the team's goalie seat may submit a goalie verdict");
  }
  if (!isArmed(ctx.bus.home)) {
    fail(1, "goalie_unarmed", "tap goalie on --by <lead>", "the goalie sidecar is not armed");
  }
  const tickNow = now(env);
  const lead = field(armPath, "armed_by") ?? "";

  if (action === "wake-seat") {
    if (!validToken(target)) usage(`target '${target}' is not a valid handle`);
    if (target !== seat) {
      fail(1, "goalie_target_refused",
        `target the candidate seat '${seat}', or wake the lead as unsure`,
        `wake-seat cannot redirect this episode to unrelated target '${target}'`);
    }
    if (target === goalieHandle || target === lead) {
      fail(1, "goalie_target_refused",
        "use --action wake-lead --reason unsure for lead escalation",
        "wake-seat may target only a non-goalie teammate");
    }
    if (!activePane(ctx.registryPath, target)) {
      fail(1, "goalie_target_refused",
        "choose one active pane-backed teammate or wake the lead",
        `target '${target}' is not an active pane-backed teammate`);
    }
    const stateRes = realGoalieDoors(scriptsDir, env, {
      busHome: ctx.bus.home,
      registryPath: ctx.registryPath,
      authorityTeam: spoolTeamName(ctx.bus.home, env.TAP_INDEX_HOME),
    }).lib("tap_seat_state", [target], { TAP_WATCH_NOW: tickNow });
    const state = (stateRes.status === 0 ? stateRes.stdout.replace(/\n+$/, "") : "unknown") || "unknown";
    if (state !== "idle-at-prompt") {
      fail(1, "goalie_target_active", "use --action wake-lead --reason unsure",
        `target '${target}' is no longer positively idle; refusing to interrupt active/unknown work`);
    }
  }

  // U1's typed contract, forwarded verbatim: 3 unarmed, 4 no open episode,
  // 5 episode closed, anything else a fault.
  const rc = claimVerdict(armPath, tickNow, seat, episode, token, action, target, reason);
  if (rc === 3) {
    fail(1, "goalie_unarmed", "tap goalie on --by <lead>", "the goalie sidecar is not armed");
  } else if (rc === 4) {
    fail(1, "no_goalie_episode", "use the candidate, episode, and token from the current judge request", "there is no matching open goalie judgment episode");
  } else if (rc === 5) {
    fail(1, "goalie_episode_closed", "wait for real seat activity and the next idle episode", "this goalie episode already has a verdict");
  } else if (rc !== 0) {
    fail(1, "goalie_verdict_failed", "inspect tap goalie status", "could not claim the goalie verdict");
  }

  if (action === "clear" && reason === "clean") {
    process.stdout.write(`tap goalie: cleared episode for '${seat}'; no mismatch found\n`);
    return 0;
  }
  let body = "";
  if (action === "wake-seat" && reason === "phantom-wait") {
    body = `GOALIE: Your pane says you are waiting, but the bus shows no matching outstanding send. Send the missing request now, or report blocked to ${lead}.`;
  } else if (action === "wake-seat" && reason === "settled-undone") {
    body = `GOALIE: A settled work order still appears unstarted. Resume the assigned work now, or report blocked to ${lead}.`;
  } else if (action === "wake-seat" && reason === "stale-wait") {
    body = `GOALIE: You appear to be waiting on work the bus shows completed. Re-read the receipt and continue, or report blocked to ${lead}.`;
  } else {
    body = `GOALIE: The idle-seat judgment for '${seat}' could not safely resolve claimed waiting against bus state. Inspect the team; episode=${episode}.`;
  }
  if (sendDurable(ctx.bus.home, ctx.registryPath, scriptsDir, env, target !== "" ? target : lead, WATCH_IDENTITY, "notice", body).ok) {
    process.stdout.write(`tap goalie: sent ${action} verdict to '${target !== "" ? target : lead}'; reason: ${reason}\n`);
    return 0;
  }
  unclaimVerdict(armPath, tickNow, seat, episode, token);
  if (action === "wake-lead") {
    if (!validToken(lead)) {
      process.stderr.write("tap goalie: human notification not attempted: no valid recorded armer\n");
    } else {
      const notified = spawnSync(process.execPath, [...ownBunFlags(process.execPath), resolve(scriptsDir, "../../../runtime/bun/src/verbs/escalate.ts"), "-m",
        `goalie could not reach lead '${lead}' during an unsure idle-seat judgment`, "--from", lead, "--team", ctx.team],
      { env: { ...childBusEnv(ctx.bus.home, env), TAP_REGISTRY: ctx.registryPath, BUN_BE_BUN: "1" }, stdio: "ignore" });
      if (notified.status !== 0) process.stderr.write(`tap goalie: human notification unconfirmed for recorded armer '${lead}'\n`);
    }
  }
  return 1;
}

// --- dispatch -------------------------------------------------------------------

/** The calling pane only (`tap_resolve_self_handle`). Never `--by`, never
 * TAP_SELF: these doors authenticate whoever is physically at the pane. */
function resolveActorHandle(ctx: Context, env: NodeJS.ProcessEnv): string {
  const pane = callingPane(env);
  if (pane?.status === "ok") {
    try { return resolveSelf(ctx, pane, 1, env).handle; } catch { return ""; }
  }
  return "";
}

export function cmdGoalie(argv: string[], scripts?: string, env: NodeJS.ProcessEnv = process.env): number {
  const sub = argv[0] ?? "";
  const rest = argv.slice(1);
  const scriptsDir = scriptsDirOf(scripts);
  if (sub === "run") {
    if (typeof process.execve !== "function") {
      fail(2, "runtime_missing", "install a Bun runtime with process.execve", "the goalie loop needs a Bun runtime with execve");
    }
    const goalieRun = resolve(scriptsDir, "../../../runtime/bun/src/goalie-run.ts");
    const bun = bunBinary();
    process.execve(bun, [...ownBunArgv(bun), goalieRun, "run", ...rest],
      Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>);
    return 2;
  }
  if (sub === "tick") {
    const res = tickEntry(env, scriptsDir, resolveContext(process.cwd(), env));
    if (res.stdout !== "") process.stdout.write(res.stdout);
    if (res.stderr !== "") process.stderr.write(res.stderr);
    return res.rc;
  }
  if (sub === "" || sub === "-h" || sub === "--help") {
    process.stdout.write(USAGE + "\n");
    return 0;
  }
  if (!(["on", "off", "status", "verdict", "reap"].includes(sub))) {
    fail(1, "unknown_subcommand", HELP, `unknown subcommand '${sub}' (on|off|status)`);
  }
  const ctx = resolveContext(process.cwd(), env);
  switch (sub) {
    case "on": return cmdOn(ctx, rest, scriptsDir, env);
    case "off": return cmdOff(ctx, rest, scriptsDir, env);
    case "status": return cmdStatus(ctx, rest, env);
    case "verdict": return cmdVerdict(ctx, rest, scriptsDir, env);
    case "reap": {
      if (rest.length < 1 || rest[0] === undefined || rest[0] === "") {
        process.stderr.write("tap goalie reap needs an archive directory\n");
        return 1;
      }
      reapTo(armPathOf(ctx.bus.home), rest[0]);
      return 0;
    }
    default: return 0; // unreachable
  }
}

const importMain = import.meta.main;
if (importMain) {
  try {
    // The shared refusal boundary honors TAP_JSON, so this door emits the same
    // single JSON error object as the router.
    process.exitCode = renderRefusals("tap goalie", () => cmdGoalie(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`tap goalie: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
