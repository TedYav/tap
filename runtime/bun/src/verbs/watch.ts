import { inheritedActor } from "../context";
// `tap watch on|pause|resume|off|status|ack|reminders|tick|run` -- the supervision
// verb layer, native (migration slice W1; `tick` since W2c-2, `run` since W3; the
// `tap-watch.sh` forward deleted at W4). Two doors reach ONE body: the Bun router
// (`main.ts` NATIVE_HANDLERS.watch) and a direct `bun` run of this file
// (`tap remind` reaches `reminders` the same way). `tick` runs the tick body
// (watch-tick-run.ts) in this process; `run` re-execs into the loop's own entry
// (watch-run.ts), which stamps the sidecar's sources before it loads them -- the
// loop never runs inside the router's image.
//
// This file is the only watch module that resolves a context or an actor; the
// modules it calls (watch-lease, watch-notice, watch-registry, watch-sidecar,
// remind) are stamped in the sidecar's source fingerprint and take every fact as
// an argument. Nothing the loop calls imports this file.
//
// Actor resolution is watch-specific and per-verb, so it is not done.ts's
// resolveActor: `--by` > TAP_SELF > the calling pane (`off` is pane-only: tap-calo); an EMPTY actor is a valid
// outcome for pause/resume/off/ack (recorded as `unknown`), only `on` refuses it
// (`no_actor`); an unverifiable server generation is fatal everywhere except
// `off --force`, the loud escape. Each verb resolves the actor at the same point
// the incumbent did -- AFTER its no-op and validation exits -- so `ack` with no
// NOTIFY, `off` when disarmed, `resume` when running and a `pause` missing its
// reason never turn into generation_unverifiable.
//
// The contract this implements is CONTRACT.md §Watch layer / Verbs: same-goal
// `on` idempotent; a differing explicitly-passed setting refused with the
// caller-chosen door (armer: off or --rearm; non-armer: off --force, never
// --rearm); --rearm armer-owned unless --force, forced path notifies; pause
// default 4h, cap 7d with a stderr warning; resume clears the pause and resets
// the cursors and silence floor; off armer-owned unless --force; status renders
// the lease; ack clears sticky NOTIFY.

import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { callingPane, resolveContext, resolveSelf, TapError, type Context } from "../context";
import { off as remindOff } from "../remind";
import { assertResetUnfenced, markResetGenerationReused } from "../reset";
import { clearPause, fieldValue, isFile, parseRecord, printed, readLoose, set as leaseSet } from "../watch-lease";
import { armPath, noticeOrNotify, notifyPath } from "../watch-notice";
import { clearTints, dispatcherLiveness, ensureSidecar, existingWatchWindow, remindersEntry } from "../watch-sidecar";
import { main as tickMain } from "../watch-tick-run";
import { tapScriptsDir, artifactBun, runtimeModule } from "../scripts-dir";

const TAP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TAP_ID_RE_TEXT = "^[A-Za-z0-9][A-Za-z0-9._-]*$";
const HELP = "tap help watch";
const USAGE = "usage: tap watch <on|pause|resume|off|status|ack|tick|run> [...]  (see: tap help watch)";
/** Bash's `[ -gt 0 ]` refuses anything past a signed 64-bit integer. */
const BASH_INT_MAX = 9223372036854775807n;

/** `tap_fail`: the error line flattens newlines in detail and action, at BOTH doors (the router prints detail as given). */
function fail(code: number, klass: string, action: string, detail: string): never {
  throw new TapError(code, klass, action.replace(/[\r\n]/g, " "), detail.replace(/[\r\n]/g, " "), "tap watch");
}

function usage(detail: string): never { fail(1, "usage_error", HELP, detail); }
function unknownOption(arg: string): never { fail(1, "unknown_option", HELP, `unknown option '${arg}'`); }

/** `${2:?<flag> needs a value}`: unset OR empty refuses; `${2?...}` (allowEmpty) refuses only unset. */
function value(argv: string[], i: number, message: string, allowEmpty = false): string {
  const v = argv[i + 1];
  if (v === undefined || (!allowEmpty && v === "")) usage(message);
  return v;
}

function now(env: NodeJS.ProcessEnv): string {
  return env.TAP_WATCH_NOW || String(Math.floor(Date.now() / 1000));
}

interface ActorRefusal { action: string; detail: string }

/**
 * `--by` > TAP_SELF > `tap_resolve_self_handle_into`. Empty when the pane cannot
 * be resolved for any reason other than an unverifiable server generation, which
 * refuses with the verb's own message unless `escape` (off --force) is set.
 * `paneOnly` skips TAP_SELF: the disarm door authenticates the physical pane.
 */
function resolveActor(ctx: Context, explicit: string, env: NodeJS.ProcessEnv, refusal: ActorRefusal, escape = false, paneOnly = false): string {
  if (explicit) return explicit;
  const inherited = paneOnly ? "" : inheritedActor(env);
  if (inherited) return inherited;
  const pane = callingPane(env);
  if (pane?.status === "ok") {
    try { return resolveSelf(ctx, pane, 1, env).handle; } catch (error) {
      if (error instanceof TapError && error.errorClass === "generation_unverifiable" && !escape) fail(1, "generation_unverifiable", refusal.action, refusal.detail);
      return "";
    }
  }
  if (pane?.status === "unverifiable" && !escape) fail(1, "generation_unverifiable", refusal.action, refusal.detail);
  return "";
}

const RETRY_BY = "wait for tmux to answer and retry, or pass --by <handle>";

function scriptsDirOf(scripts?: string): string {
  return scripts ?? tapScriptsDir();
}

// --- on -------------------------------------------------------------------------

const INTENT_FIELD: Record<string, string> = {
  "--threshold": "threshold_seconds",
  "--context-threshold": "context_threshold_percent",
  "--context-exempt": "context_exempt",
  "--probe-timeout": "probe_timeout_seconds",
  "--interval": "tick_interval_seconds",
  "--evaluator": "evaluator",
  "--chain": "chain_overrides",
  "--terminal": "terminal_seat",
};

function positiveInt(flag: string, v: string): void {
  if (!/^[0-9]+$/.test(v)) usage(`${flag} must be a positive integer`);
  if (BigInt(v) <= 0n || BigInt(v) > BASH_INT_MAX) usage(`${flag} must be > 0 (0 would advance the ladder immediately)`);
}

function cmdOn(ctx: Context, argv: string[], scripts: string, env: NodeJS.ProcessEnv): number {
  // tap-0nzm: `evaluator` defaults AFTER parsing, so "passed --evaluator codex"
  // stays distinguishable from "omitted". Only the settings EXPLICITLY passed
  // enter `intent`, as "<stored-field-name>=<value>".
  let armer = "", doneWhen = "", doneFile = "", threshold = "", probeTimeout = "", interval = "",
    evaluator = "", chain = "", terminal = "", contextThreshold = "40", contextExempt = "", rearm = false, force = false,
    noSpawn = (env.TAP_WATCH_NO_SPAWN ?? "0") === "1";
  const intent: Array<[field: string, want: string]> = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--by": armer = value(argv, i, "--by needs a value"); i++; break;
      case "-m": case "--done-when": doneWhen = value(argv, i, "--done-when needs a value"); i++; break;
      case "--file": doneFile = value(argv, i, "--file needs a value"); i++; break;
      case "--context-exempt": contextExempt = value(argv, i, "--context-exempt needs comma-separated handles", true); intent.push([INTENT_FIELD[a]!, contextExempt]); i++; break;
      case "--threshold": case "--context-threshold": case "--probe-timeout": case "--interval": case "--evaluator": case "--chain": case "--terminal": {
        const v = value(argv, i, `${a} needs a ${a === "--context-threshold" ? "percentage" : "value"}`);
        if (a === "--threshold") threshold = v; else if (a === "--context-threshold") contextThreshold = v;
        else if (a === "--probe-timeout") probeTimeout = v; else if (a === "--interval") interval = v;
        else if (a === "--evaluator") evaluator = v; else if (a === "--chain") chain = v; else terminal = v;
        intent.push([INTENT_FIELD[a]!, v]);
        i++;
        break;
      }
      case "--rearm": rearm = true; break;
      case "--force": force = true; break;
      case "--no-spawn": noSpawn = true; break;
      default:
        if (a.startsWith("--")) unknownOption(a);
        usage(`unexpected arg '${a}'`);
    }
  }

  if (!armer) {
    armer = resolveActor(ctx, "", env, { action: RETRY_BY,
      detail: "refusing watch arm because the tmux server generation is unavailable and the caller identity cannot be verified" });
  }
  if (!armer) fail(1, "no_actor", "tap watch on --by <me>", "could not resolve the arming handle");
  if (!TAP_ID_RE.test(armer)) usage(`armer '${armer}' is not a valid token (${TAP_ID_RE_TEXT})`);

  if (!doneWhen && doneFile) {
    let text = "";
    try { text = readFileSync(doneFile, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EISDIR") fail(1, "not_found", HELP, `--file '${doneFile}' is not readable`);
      // `[ -r dir ]` is true and `done_when="$(cat dir)"` then fails under set -e:
      // the incumbent exits 1 with cat's line and nothing else (measured, oracle
      // case on-file-dir). Carried as is -- the line names the problem.
      process.stderr.write(`cat: ${doneFile}: Is a directory\n`);
      return 1;
    }
    doneWhen = text.replace(/\n+$/, ""); // `$(cat ...)` strips trailing newlines
  }
  if (!doneWhen) fail(1, "no_done_when",
    "tap watch on -m '<one measurable end state + proof command + invariants + hard bound>'",
    "arming needs a done_when (R20): the run's completion test, checkable from observable state");

  if (!evaluator) evaluator = "codex";
  if (evaluator === "claude") fail(1, "evaluator_unimplemented", "tap watch on --evaluator codex   # or: none", "the claude evaluator is not yet implemented — use codex or none");
  if (evaluator !== "codex" && evaluator !== "none") usage("--evaluator must be codex|none");
  if (!threshold) threshold = "1500";          // 25 min (KTD10)
  if (!probeTimeout) probeTimeout = threshold; // one silence threshold (KTD10)
  if (!interval) interval = "60";
  if (!terminal) terminal = armer;
  positiveInt("--threshold", threshold);
  positiveInt("--probe-timeout", probeTimeout);
  positiveInt("--interval", interval);

  if (!/^[0-9]+$/.test(contextThreshold)) usage("--context-threshold must be 1..100");
  if (BigInt(contextThreshold) < 1n || BigInt(contextThreshold) > 100n) usage("--context-threshold must be 1..100");
  if (/[\s]/.test(contextExempt) || contextExempt.startsWith(",") || contextExempt.endsWith(",") || contextExempt.includes(",,")) usage("--context-exempt needs comma-separated handles");
  for (const h of contextExempt.split(",").filter((x) => x)) {
    if (!TAP_ID_RE.test(h)) usage("--context-exempt needs comma-separated handles");
  }

  // Fence before ensure_dirs (sol 052921).
  assertResetUnfenced(ctx.bus.home, "tap watch on");
  ctx.bus.ensureDirs();
  const at = now(env);
  const arm = armPath(ctx.bus.home);
  const armed = () => isFile(arm); // Any regular lease file is armed, whatever the bytes say.
  const field = (k: string) => fieldValue(readLoose(arm), k);

  // Re-arm semantics (T0): `on` is idempotent for the SAME goal; an episode reset is
  // explicit-only. tap-pqf2: --rearm skips the idempotence gate, so without this it
  // was an ungated takeover -- same shape as `watch off`, deliberately: a non-armer
  // must opt in with --force, and the forced path is LOUD.
  if (rearm && armed()) {
    const owner = field("armed_by");
    if (owner && armer !== owner) {
      if (!force) fail(1, "rearm_refused",
        `re-run the same command with --force (notifies '${owner}'), or ask '${owner}' to re-arm`,
        `watch is armed by '${owner}'; '${armer}' cannot re-arm it`);
      // `set -e`: a fallback that could not publish ended the incumbent here, before the fresh arm
      if (noticeOrNotify({ bus: ctx.bus.home, scripts, to: owner, now: at, env,
        reason: `tap watch on --rearm was run by '${armer}' for a watch armed by '${owner}'.`, evidence: `actor=${armer}` }) !== 0) return 1;
    }
  }

  let doArmWrite = true;
  if (!rearm && armed() && field("mode") !== "reminders-only") {
    // tap-0nzm: compare the caller's WHOLE stated intent, not done_when alone. A
    // setting the caller did not pass never enters `intent`, so an omitted flag
    // still cannot change or block anything.
    const differing: string[] = [];
    if (field("done_when") !== doneWhen) differing.push("done_when");
    for (const [f, want] of intent) if (field(f) !== want) differing.push(f);
    if (differing.length) {
      // Refuse rather than apply: `watch` is TEAM-SCOPED supervision state. A peer is
      // offered --force and NOT --rearm -- --force disarms loudly and NOTIFIES the
      // armer, --rearm would hand a peer the exact takeover this refusal prevents.
      const armedBy = field("armed_by");
      // Bare `off` only when the PANE is the armer (`off` is pane-only; `armer` may
      // come from --by/TAP_SELF). A mismatched or unresolvable pane gets --force.
      const paneActor = resolveActor(ctx, "", env, { action: RETRY_BY, detail: "" }, true, true);
      const door = !armedBy || paneActor === armedBy
        ? "tap watch off   # or re-run with --rearm to reset the episode"
        : `tap watch off --force   # or ask '${armedBy}' to disarm`;
      fail(1, "already_armed", door, `already armed with a different ${differing.join(", ")}; the episode belongs to '${armedBy || "<unknown>"}'`);
    }
    doArmWrite = false;
    process.stdout.write(`tap watch: already armed; keeping current episode since ${field("armed_at")}\n`);
  }

  if (doArmWrite) {
    const consent = evaluator !== "none";
    if (consent) process.stderr.write(`tap watch: consent: evaluator '${evaluator}' may read pane transcripts while this watch is armed\n`);
    // --rearm resets tinted_panes below but that only forgets the OLD arm's tint
    // bookkeeping -- clear real tint backgrounds against the STILL-CURRENT record first.
    clearTints(ctx.bus.home, env);
    // Write a FRESH arm record (the lease), resetting episode state (explicit per T0).
    const rc = leaseSet(arm, [
      "mode", "supervision", "armed_by", armer, "armed_at", at, "silence_floor_at", at, "done_when", doneWhen,
      "threshold_seconds", threshold, "probe_timeout_seconds", probeTimeout, "tick_interval_seconds", interval,
      "evaluator", evaluator, "chain_overrides", chain || "[]", "terminal_seat", terminal,
      "consent_transcript_egress", consent ? "1" : "0",
      "current_rung", "0", "consecutive_defers", "0", "evaluator_calls", "0", "last_probe_at", "0",
      "episode_started_at", "0", "notified_at", "0", "probed_seats", "[]", "defer_seat", "",
      "queued_probe_id", "", "queued_probe_seat", "", "carried_probe_seat", "", "carried_probe_at", "0",
      "paused_by", "", "paused_at", "0", "paused_until", "0", "pause_reason", "",
      "blocked_map", "{}", "blocked_exempt", "[]",
      "context_threshold_percent", contextThreshold, "context_exempt", contextExempt,
      "context_pressure", "{}", "livelock_alerts", "{}", "livelock_samples", "{}", "context_freeze", "{}", "opencode_wedge", "{}",
      "tinted_panes", "[]",
    ], { ...env, TAP_WATCH_ALLOW_CREATE: "1" });
    if (rc !== 0) throw new Error(`arming write refused (watch-lease.ts set exit ${rc})`);
    markResetGenerationReused(ctx.bus.home, "watch");
    process.stdout.write(`tap watch: armed by '${armer}'; checks after ${threshold}s; probes after ${probeTimeout}s; evaluator ${evaluator}; terminal '${terminal}'\n`);
  }

  return ensureSidecar({ bus: ctx.bus.home, scripts, registry: ctx.registryPath, armer, noSpawn, now: at, env });
}

// --- pause / resume -------------------------------------------------------------

/** `_watch_duration_seconds`: `<N><s|m|h|d>`, N digits and not the single digit 0. */
export function durationSeconds(duration: string): bigint | null {
  const unit = { s: 1n, m: 60n, h: 3600n, d: 86400n }[duration.slice(-1)];
  if (unit === undefined) return null;
  const count = duration.slice(0, -1);
  if (!count || count === "0" || !/^[0-9]+$/.test(count)) return null;
  return BigInt(count) * unit;
}

function cmdPause(ctx: Context, argv: string[], scripts: string, env: NodeJS.ProcessEnv): number {
  let actor = "", reason = "", duration = "4h";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--by": actor = value(argv, i, "--by needs a value"); i++; break;
      case "-m": case "--reason": reason = value(argv, i, "--reason needs a value"); i++; break;
      case "--for": duration = value(argv, i, "--for needs a value"); i++; break;
      default:
        if (a.startsWith("--")) unknownOption(a);
        usage(`unexpected arg '${a}'`);
    }
  }
  actor ||= inheritedActor(env);
  assertResetUnfenced(ctx.bus.home, "tap watch pause");
  ctx.bus.ensureDirs();
  const arm = armPath(ctx.bus.home);
  if (!isFile(arm)) fail(1, "watch_unarmed", "tap watch on -m '<done_when>'", "cannot pause an unarmed watch");
  if (!reason) fail(1, "no_pause_reason", "tap watch pause -m '<reason>'", "pausing requires a reason");
  let seconds = durationSeconds(duration);
  if (seconds === null) fail(1, "invalid_duration", "tap watch pause -m '<reason>' --for <N><s|m|h|d>", `invalid pause duration '${duration}'`);
  if (seconds > 604800n) {
    process.stderr.write(`tap watch: --for '${duration}' exceeds 7d; clamping to 7d\n`);
    seconds = 604800n;
  }
  if (!actor) {
    actor = resolveActor(ctx, "", env, { action: RETRY_BY,
      detail: "refusing watch pause because the tmux server generation is unavailable and the actor cannot be verified" });
  }
  const at = now(env);
  const until = String(BigInt(at) + seconds);
  const rec = readLoose(arm);
  const entryArmedAt = fieldValue(rec, "armed_at");
  const armedBy = fieldValue(rec, "armed_by");
  const rc = leaseSet(arm, ["paused_by", actor || "unknown", "paused_at", at, "paused_until", until, "pause_reason", reason],
    { ...env, TAP_WATCH_EXPECT_ARMED_AT: entryArmedAt });
  if (rc !== 0) fail(1, "watch_changed", "tap watch pause -m '<reason>'", "watch was re-armed or disarmed while pausing; retry");
  if (armedBy && actor !== armedBy) {
    // `set -e`: the pause is recorded, but a fallback that could not publish ended the incumbent here
    if (noticeOrNotify({ bus: ctx.bus.home, scripts, to: armedBy, now: at, env,
      reason: `watch paused by '${actor || "<unknown>"}' until ${until}; reason: ${reason}`, evidence: `actor=${actor || "unknown"}` }) !== 0) return 1;
  }
  markResetGenerationReused(ctx.bus.home, "watch");
  process.stdout.write(`tap watch: paused by '${actor || "?"}' until ${until}; reason: ${reason}\n`);
  return 0;
}

function cmdResume(ctx: Context, argv: string[], scripts: string, env: NodeJS.ProcessEnv): number {
  let actor = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--by") { actor = value(argv, i, "--by needs a value"); i++; continue; }
    if (a.startsWith("--")) unknownOption(a);
    usage(`unexpected arg '${a}'`);
  }
  actor ||= inheritedActor(env);
  assertResetUnfenced(ctx.bus.home, "tap watch resume");
  ctx.bus.ensureDirs();
  const arm = armPath(ctx.bus.home);
  if (!isFile(arm)) fail(1, "watch_unarmed", "tap watch on -m '<done_when>'", "cannot resume an unarmed watch");
  const rec = readLoose(arm);
  const entryArmedAt = fieldValue(rec, "armed_at");
  const reason = fieldValue(rec, "pause_reason");
  const pausedAt = fieldValue(rec, "paused_at");
  const pausedUntil = fieldValue(rec, "paused_until");
  if (!reason && (!pausedUntil || pausedUntil === "0")) {
    process.stdout.write("tap watch: already running\n");
    return 0;
  }
  if (!actor) {
    actor = resolveActor(ctx, "", env, { action: RETRY_BY,
      detail: "refusing watch resume because the tmux server generation is unavailable and the actor cannot be verified" });
  }
  const at = now(env);
  const armedBy = fieldValue(rec, "armed_by");
  if (clearPause(arm, at, entryArmedAt, pausedAt || "0", pausedUntil || "0", env) !== 0) {
    fail(1, "watch_changed", "tap watch resume", "watch or pause state changed while resuming; retry");
  }
  if (armedBy && actor !== armedBy) {
    if (noticeOrNotify({ bus: ctx.bus.home, scripts, to: armedBy, now: at, env,
      reason: `watch resumed by '${actor || "<unknown>"}'; prior pause reason: ${reason || "-"}`, evidence: `actor=${actor || "unknown"}` }) !== 0) return 1;
  }
  markResetGenerationReused(ctx.bus.home, "watch");
  process.stdout.write(`tap watch: resumed by '${actor || "?"}'\n`);
  return 0;
}

// --- off ------------------------------------------------------------------------

function cmdOff(ctx: Context, argv: string[], scripts: string, env: NodeJS.ProcessEnv): number {
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    // Parsed so old scripts do not hit unknown_option, but it grants no
    // authority: a peer naming the armer would disarm as the armer (tap-calo).
    if (a === "--by") { value(argv, i, "--by needs a value"); i++; continue; }
    if (a === "--force") { force = true; continue; }
    if (a.startsWith("--")) unknownOption(a);
    usage(`unexpected arg '${a}'`);
  }
  assertResetUnfenced(ctx.bus.home, "tap watch off");
  ctx.bus.ensureDirs();
  const arm = armPath(ctx.bus.home);
  if (!isFile(arm)) {
    process.stdout.write("tap watch: already disarmed\n");
    return 0;
  }
  // Disarm authority is the actual current pane, never TAP_SELF or --by (the
  // goalie doors' rule): both are caller-supplied, so a peer could name the
  // armer. An unresolvable pane is "" and only --force proceeds.
  const actor = resolveActor(ctx, "", env, { action: "wait for tmux to answer and retry, or pass --force for the loud escape",
    detail: "refusing watch disarm because the tmux server generation is unavailable and the actor cannot be verified" }, force, true);
  // The lease shutdown runs under the reminder queue's lock so a schedule can never
  // land between the pending check and the reap (remind.ts owns that order).
  return remindOff(`${dirname(arm)}/reminders.json`, {
    bus: ctx.bus.home, scripts, registry: ctx.registryPath, actor, force, now: now(env), env,
  });
}

// --- status ---------------------------------------------------------------------

function cmdStatus(ctx: Context, env: NodeJS.ProcessEnv): number {
  ctx.bus.ensureDirs();
  const arm = armPath(ctx.bus.home);
  if (!isFile(arm)) {
    process.stdout.write("tap watch: disarmed\n");
    return 0;
  }
  const rec = readLoose(arm);
  const f = (k: string) => fieldValue(rec, k);
  // The arm record says a watch was armed, not that anything is running it.
  const live = dispatcherLiveness(rec, Number(now(env)));
  const lines = [
    "tap watch: armed",
    `  dispatcher: ${live.state} (${live.detail})`,
    `  mode: ${f("mode")}`,
    `  armed by: ${f("armed_by")}`,
    `  armed at: ${f("armed_at")}`,
    `  threshold: ${f("threshold_seconds")}s`,
    `  probe timeout: ${f("probe_timeout_seconds")}s`,
    `  context threshold: ${f("context_threshold_percent")}%; exempt: ${f("context_exempt")}`,
    `  evaluator: ${f("evaluator")}`,
    `  terminal: ${f("terminal_seat")}`,
    `  rung: ${f("current_rung")}`,
    `  done when: ${f("done_when")}`,
  ];
  const pausedUntil = f("paused_until");
  const pauseReason = f("pause_reason");
  if (pauseReason || (pausedUntil && pausedUntil !== "0")) {
    lines.push(`  paused by: ${f("paused_by")}  at: ${f("paused_at")}  until: ${pausedUntil}  reason: ${pauseReason}`);
  }
  if (live.state === "dead") {
    // With no watcher recorded, `ensureSidecar` refuses to touch an existing `watch` window it cannot tie to this lease and
    // returns before spawning, so the generic re-run hint cannot recover: name the window and the remediation instead.
    // The lookup is optional: a tmux that cannot be inspected (ServerUnresponsive, ...) limits the diagnostic, it does not
    // erase the established dead verdict into a generic failure.
    let window: string | null = null, tmuxBlind = false;
    if (live.noWatcher) {
      try { window = existingWatchWindow(ctx.registryPath, f("armed_by"), env); } catch { tmuxBlind = true; }
    }
    lines.push(window
      ? `  next: a \`watch\` window already exists in '${window}' but the lease records no watcher, so re-running \`tap watch on\` leaves it untouched and cannot recover; inspect it (tap health); close it if it is this watch's unrecorded sidecar, or rename it if it belongs to something else, then run \`tap watch on\``
      : live.neverTicked
      // ensureSidecar treats an empty heartbeat as a just-spawned loop and leaves a live matching watcher alone, so re-running
      // `tap watch on` would do nothing here. `off` deletes the lease and kills the recorded `watch` window; `on` then spawns a fresh loop.
      ? "  next: the watcher never ticked and re-running `tap watch on` will not replace it; inspect that pid and the `watch` window in the armer's tmux session, then run `tap watch off` (the armer, or --force) followed by `tap watch on`"
      : `  next: re-run the \`tap watch on\` that armed this (or any \`tap remind me\`) to respawn the sidecar${tmuxBlind ? " (tmux could not be inspected for an existing `watch` window; if the re-run leaves it untouched, see tap health)" : ""}`);
  }
  if (live.badCommand) {
    // The pid is live but the lease names no known watcher, so `tap health` (which matches the recorded text against the process)
    // would not corroborate this: name the cause and the recovery that works, off then on.
    const { pid, command } = live.badCommand;
    lines.push(`  next: the lease records ${command ? `an unrecognized watcher command '${command}'` : "no watcher command"}; inspect pid ${pid}, then rearm with \`tap watch off\` (the armer, or --force) followed by \`tap watch on\``);
  } else if (live.clockFault) {
    // `tap health` never reads heartbeat_at or armed_at, so it would report this live pid alive: name the clock fault instead.
    lines.push("  next: the lease's heartbeat or arm time is unreadable or in the future (a clock or lease fault tap health does not check); check the system clock, then rearm with `tap watch off` (the armer, or --force) followed by `tap watch on`");
  } else if (live.state === "unknown") lines.push("  next: tap health");
  process.stdout.write(lines.join("\n") + "\n");
  // A dead dispatcher is reported state with its `next:` line, so it exits 0 (CLI-EXIT-0); `tap health`
  // is the check verb that exits non-zero for it. Unknown could not be checked: CLI-STANDARDS assigns
  // unsafe-to-check states to exit 1, so it exits 1 with its `next:` line and never reads as dead.
  return live.state === "unknown" ? 1 : 0;
}

// --- ack ------------------------------------------------------------------------

function cmdAck(ctx: Context, argv: string[], env: NodeJS.ProcessEnv): number {
  let actor = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--by") { actor = value(argv, i, "--by needs a value"); i++; continue; }
    if (a.startsWith("--")) unknownOption(a);
    usage(`unexpected arg '${a}'`);
  }
  actor ||= inheritedActor(env);
  assertResetUnfenced(ctx.bus.home, "tap watch ack");
  ctx.bus.ensureDirs();
  const notify = notifyPath(ctx.bus.home);
  // `[ -f "$notify" ]`: presence decides the no-op; readability is the rewrite's problem.
  let present = false;
  try { present = statSync(notify).isFile(); } catch { present = false; }
  if (!present) {
    process.stdout.write("tap watch: no sticky NOTIFY to ack\n");
    return 0;
  }
  if (!actor) {
    actor = resolveActor(ctx, "", env, { action: RETRY_BY,
      detail: "refusing watch acknowledgment because the tmux server generation is unavailable and the actor cannot be verified" });
  }
  const at = now(env);
  // The incumbent's rewrite: open (an unreadable file fails here, as notify_invalid),
  // load, require an object, set acked/acked_by/acked_at, dump compact ASCII (no
  // trailing newline) to `<path>.tmp`, os.replace.
  let data: unknown;
  try { data = parseRecord(readFileSync(notify, "utf8")); } catch { data = undefined; }
  if (typeof data !== "object" || data === null || Array.isArray(data)) fail(1, "notify_invalid", "repair_or_remove_notify", "watch notify.json is invalid");
  const rec = data as Record<string, unknown>;
  rec.acked = "1";
  rec.acked_by = actor;
  rec.acked_at = at;
  try {
    writeFileSync(`${notify}.tmp`, printed(rec));
    renameSync(`${notify}.tmp`, notify);
  } catch {
    fail(1, "notify_invalid", "repair_or_remove_notify", "watch notify.json is invalid");
  }
  markResetGenerationReused(ctx.bus.home, "watch");
  process.stdout.write(`tap watch: acknowledged sticky notification by '${actor || "?"}'\n`);
  return 0;
}

// --- reminders (internal: the reminder queue installed its minimal lease) ---------

function cmdReminders(ctx: Context, argv: string[], scripts: string, env: NodeJS.ProcessEnv): number {
  const owner = argv[0] === "--by" ? (argv[1] ?? "") : "";
  return remindersEntry({ bus: ctx.bus.home, scripts, registry: ctx.registryPath, owner,
    noSpawn: (env.TAP_WATCH_NO_SPAWN ?? "0") === "1", now: now(env), env });
}

// --- dispatch -------------------------------------------------------------------

export function cmdWatch(argv: string[], scripts?: string, env: NodeJS.ProcessEnv = process.env): number | Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === "" || sub === "-h" || sub === "--help") {
    process.stdout.write(USAGE + "\n");
    return 0;
  }
  if (sub === "tick") return tickMain(["tick"], env, scripts);
  if (sub === "run") {
    // The loop's entry stamps its sources before loading them, so the loop must start
    // as THAT process image, not inside this one: replace this process (same pid, the
    // window's and the lease's) with `bun watch-run.ts run`.
    const entry = scripts ? resolve(scripts, "../../../runtime/bun/src/watch-run.ts") : runtimeModule("src/watch-run.ts");
    const bun = artifactBun() ?? Bun.which("bun");
    if (!bun) fail(1, "runtime_missing", "install bun", "the sidecar loop needs the companion Bun runtime");
    const execve = process.execve;
    if (typeof execve !== "function") fail(1, "runtime_missing", "tap health", `the sidecar loop needs a bun with process.execve; this is ${Bun.version}`);
    execve(bun, [bun, entry, "run", ...rest], env);
    throw new Error("re-exec into watch-run.ts returned");   // execve does not return on success
  }
  if (!["reminders", "on", "pause", "resume", "off", "status", "ack"].includes(sub)) {
    fail(1, "unknown_subcommand", HELP, `unknown subcommand '${sub}' (on|pause|resume|off|status|ack|tick|run)`);
  }
  const scriptsDir = scriptsDirOf(scripts);
  const ctx = resolveContext(process.cwd(), env);
  try {
    switch (sub) {
      case "reminders": return cmdReminders(ctx, rest, scriptsDir, env);
      case "on": return cmdOn(ctx, rest, scriptsDir, env);
      case "pause": return cmdPause(ctx, rest, scriptsDir, env);
      case "resume": return cmdResume(ctx, rest, scriptsDir, env);
      case "off": return cmdOff(ctx, rest, scriptsDir, env);
      case "status": return cmdStatus(ctx, env);
      default: return cmdAck(ctx, rest, env);
    }
  } catch (error) {
    if (error instanceof TapError) throw error;
    // An infrastructure failure (the lease lock cannot be opened, a publish
    // failed) is its own error with its own remedy -- never `watch_changed`, never
    // a stack trace on one door and a one-liner on the other (rule 19; ratified D4).
    fail(1, "runtime_failed", "tap health", error instanceof Error ? error.message : String(error));
  }
}

/** `tap_error_line`'s rendering, for the direct `bun` run of this file. */
function humanAction(action: string): string {
  const flat = action.replace(/[\r\n]/g, " ");
  return /[ /]/.test(flat) ? flat : flat.replace(/_/g, " ");
}

if (import.meta.main) {
  try {
    process.exitCode = await cmdWatch(Bun.argv.slice(2));
  } catch (error) {
    if (error instanceof TapError) {
      process.stderr.write(`${error.verbLabel ?? "tap watch"}: ${error.detail.replace(/[\r\n]/g, " ") || error.errorClass.replace(/_/g, " ")}; next: ${humanAction(error.action)}\n`);
      process.exitCode = error.code;
    } else {
      process.stderr.write(`tap watch: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
