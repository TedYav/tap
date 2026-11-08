// The watch tick's body: one pure evaluation over (bus, repo, injected clock) -- the
// deleted `tap_watch_tick` (tap-watch.sh, slice W2c-2), with `_watch_send_probe` and
// `_watch_reset_episode`, which only it reached.
//
// The tick is orchestration over doors that are native already: the lease
// (watch-lease.ts), the pure programs (watch-tick.ts), the blocked-seat pass
// (watch-blocked.ts), the four pane detectors (watch-detectors.ts), the evaluator rung
// and the chain (watch-evaluator.ts), the notice courier (watch-notice.ts), the
// reminders (remind.ts), the spool claim (spool-sidecar.ts) and the bus activity clock
// (watch-detectors.ts). Every door is behind `TickSeams` so the pass replays the
// frozen capture of the incumbent (test/fixtures/watch-tick-oracle.json) over a
// scripted world; `realTickSeams` is the production world. The spool pass runs
// through the native engine with the watcher snapshot as arguments. Retained
// Bash boundaries include the roster classifier and probe courier, plus B1
// capture/submit and the spool engine's same-shell effect/custody transaction.
//
// One failure semantics in both calling shapes (the sidecar loop's `tap_watch_tick ||
// true` and the `tick` verb's bare call), ruled by the leader:
//   D.  a maintenance door's nonzero status -- a reminders finish, the blocked pass, a
//       detector, the spool pass, a notice or notification -- is reported by the door's
//       own line; the tick goes on and returns 0 (the loop's bytes; the verb's errexit
//       ended the process mid-pass, which was the accident, not the design);
//   R1. a non-integer where the tick compares a number (`threshold_seconds`,
//       `probe_timeout_seconds`, `episode_started_at`, `carried_probe_at`): one
//       `tap watch:` line naming the field, bash's decision kept (`[` answered false);
//   R2. a clock the tick cannot read (`TAP_WATCH_NOW` not an integer): one line and
//       status 1 -- where bash's arithmetic died and, in the loop shape, took the
//       whole sidecar with it;
//   R2b. a `current_rung` bash would have EVALUATED as a name is refused when the
//       record is read, before any side effect (status 1, one line, no probe).

import { spawnSync } from "node:child_process";
import { spoolEngineCommand } from "./spool-engine";
import { checkWatchStop, watchChild, withWatchLifetime } from "./watch-child";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resolveContext, spoolTeamName } from "./context";
import { fire as remindFire, finish as remindFinish } from "./remind";
import { type ClaimToken, claimAcquire, claimRelease } from "./spool-sidecar";
import { blockedUpsert, cmdSubst } from "./watch-detect";
import { classifyBlocked, processBlocked, realBlockedSeams } from "./watch-blocked";
import { processApprovalTimeouts } from "./approval-timeout";
import { realApprovalSeams } from "./approval-timeout-real";
import { busActivity, codexLivelock, contextFreeze, contextPressure, opencodeWedge, realSeams as realDetectorSeams, TickAbort } from "./watch-detectors";
import { nextUnprobed, probedAppend } from "./watch-evaluate";
import { buildChain, evaluate, realSeams as realEvaluatorSeams, testInt } from "./watch-evaluator";
import { armPath, noticeOrNotify, notifyHuman } from "./watch-notice";
import { loadRegistry, seatMap, type RegistryDoc } from "./registry";
import { teamRegistryRefusal } from "./register-authority";
import { clearPause, fieldValue, isFile, readLoose, set as leaseSet, snapshotLines } from "./watch-lease";
import { activeSeatRows, activityFloor, blockedKeysJson, courierDisposition, isExempt, parseResetEpoch, probeReceipt, readRegistryText, realWedge, skipSetJson } from "./watch-tick";
// TODO(C): import the hoisted roster door once the roster door is exported out of the verb layer
// (leader reply); until then the batch classifier is
// the team verb's `observe`. The rows are the incumbent's own program (`activeSeatRows`,
// the registry's active rows in the document's order), never the verb's sorted display reader.
import { observe, type RegistryRow } from "./team-observe";
import { courierArgv } from "./courier-argv";
import { childBusEnv } from "./panelock";
import { tapScriptsDir } from "./scripts-dir";

/** One active seat of the roster prefetch: `TAP_WATCH_TICK_ROSTER_HANDLES` / `_PANE_RECORDS` / `_HARNESSES`. */
export interface RosterRow {
  handle: string;
  pane: string;
  paneId: string;
  harness: string;
}

/** The probe courier's answer: `_watch_send_probe`'s status and the parsed receipt. */
export interface ProbeSend {
  rc: number;
  status: string;
  id: string;
  path: string;
  delivery: string;
  errorClass: string;
  action: string;
  detail: string;
  /** The first line of the courier's stderr (the failure line's fallback text). */
  err: string;
  /** rc0 queued/harness-queue, turn unconfirmed: accepted by the harness, never an injection. */
  harnessQueued: boolean;
}

export interface TickSeams {
  /** `_watch_now`: `TAP_WATCH_NOW` or the clock, as a string. */
  now(): string;
  /** `tap_reset_fence_present`. */
  fencePresent(): boolean;
  /** `tap_watch_is_armed`. */
  armed(): boolean;
  /** `tap_watch_snapshot`: the record's `key<TAB>value` lines. */
  snapshot(): string[];
  /** `tap_watch_field <key>`. */
  field(key: string): string;
  /** `tap_watch_set`, with the generation guards as `TAP_WATCH_EXPECT_*` (0 = written). */
  set(pairs: string[], expect?: Record<string, string>): boolean;
  /** `_watch_clear_pause`. */
  clearPause(now: string, armedAt: string, pausedAt: string, pausedUntil: string): boolean;
  /** `_watch_lease_current <armed_at>`. */
  leaseCurrent(armedAt: string): boolean;
  /** `watch/reminders.json` exists. */
  remindersPresent(): boolean;
  /** `remind.ts fire <arm_at>`: 0, or nonzero when it failed (the tick returns 1). */
  remindFire(armAt: string): number;
  /** `remind.ts finish <arm_at>`: its status (D: reported, not fatal). */
  remindFinish(armAt: string): number;
  /** The active roster after the classifier (C's door), or null when the acting registry could not be read. */
  roster(): RosterRow[] | null;
  /** `_watch_process_blocked`: the touched handles (one per line, as printed) and the pass's status. */
  processBlocked(armedAt: string, now: string, armedBy: string, map: string, exempt: string, roster: RosterRow[]): { touched: string; rc: number };
  /**
   * The approval-timeout pass (tap-rlebf.2) over the tick's roster: its status (D).
   * Optional so a world without the door (the frozen oracle) replays unchanged.
   */
  approvalTimeouts?(armedBy: string, now: string, roster: RosterRow[]): number;
  /** One pane detector by name, with the tick's argv and roster: its status. */
  detector(name: "context-pressure" | "codex-livelock" | "context-freeze" | "opencode-wedge", args: string[], roster: RosterRow[]): number;
  /** `_watch_process_spool <armed_at> <now>` with the tick's snapshot as data: its status. */
  processSpool(armedAt: string, now: string, snapshot: { queuedProbeId: string; probeTimeout: string }): number | Promise<number>;
  /** Spool claim acquire (spool-sidecar.ts `claim`): the release token when acquired (a held claim or a failed writer is null). */
  claimAcquire(id: string): ClaimToken | null;
  /** Release the claim `claimAcquire` granted, with its token. */
  claimRelease(id: string, token: ClaimToken): void;
  /** A bus file exists (`spool/<id>.md`, `spool/<id>.meta.json`, `payloads/<id>.md`, `receipts/<id>.done`). */
  busFile(rel: string): boolean;
  /** `_watch_notice_or_notify <to> <reason> <evidence>`: its status. */
  noticeOrNotify(to: string, reason: string, evidence: string): number;
  /** `_watch_notify_human <reason>`: its status. */
  notifyHuman(reason: string): number;
  /** `_watch_evaluate`: its status (advisory); the rung reads the tick's roster. */
  evaluate(roster: RosterRow[]): number;
  /** `git -C <root> log -1 --format=%ct` ("" when git failed). */
  headCommitTime(): string;
  /** `git -C <root> status --porcelain | tap_sha256` ("" when git failed -- the hash of nothing is still a hash). */
  porcelainHash(): string;
  /** `tap_supervision_bus_activity <now>`. */
  busActivity(now: string): string;
  /** `_watch_build_chain <overrides> <terminal>`: the chain, one seat per line, over the tick's roster (a seat the classifier rejected is no rung). */
  buildChain(overrides: string, terminal: string, roster: RosterRow[]): string;
  /** `_watch_next_unprobed <skip-json>` over the chain text. */
  nextUnprobed(chain: string, skipJson: string): string;
  /** `_watch_probed_append <probed-json> <seat>`. */
  probedAppend(probed: string, seat: string): string;
  /** `_watch_classify_blocked <rung>`: `reason\ttime\ttz` or "". */
  classify(rung: string, roster: RosterRow[]): string;
  /** The probe courier: `tap send <rung> <draft> --from <id> --kind probe --fyi --json` under `TAP_SELF`, `TAP_SEND_GRACE_SECONDS`. */
  sendProbe(rung: string, body: string, probeTimeout: string): { rc: number; stdout: string; err: string };
  /** `watch-templates/probe.md`. */
  probeTemplate(): string;
  stderr(line: string): void;
}

export const WATCH_IDENTITY_DEFAULT = "watcher";

/** `[ "$a" -lt "$b" ]` with the shell's diagnostic on a non-integer: false, and one line (R1). */
function cmp(s: TickSeams, a: string, aName: string, b: string, bName: string, op: "-lt" | "-gt" | "-ge"): boolean {
  const x = testInt(a);
  const y = testInt(b);
  if (x === null || y === null) {
    const bad = x === null ? [aName, a] : [bName, b];
    s.stderr(`tap watch: ${bad[0]} is not an integer: ${JSON.stringify(bad[1])}`);
    return false;
  }
  return op === "-lt" ? x < y : op === "-gt" ? x > y : x >= y;
}

/** `$(( a - b ))` / `$(( a + 1 ))` over values the record holds: a name or an expression is refused (R2/R2b). */
function arith(text: string, what: string): bigint {
  const v = testInt(text);
  if (v === null) throw new Error(`${what} is not an integer: ${JSON.stringify(text)}`);
  return v;
}

/** `_watch_send_probe`'s template render: `{{ARMER}}` then `{{NUDGE}}` (a nudge line, or nothing). */
export function probeBody(template: string, armer: string, nudge: string): string {
  let body = template.replace(/\n+$/, ""); // `$(cat ...)`
  body = body.split("{{ARMER}}").join(armer);
  body = nudge !== "" ? body.split("{{NUDGE}}").join(`> Carrying forward: ${nudge}`) : body.replace("{{NUDGE}}", "");
  return `${body}\n`;
}

/** `_watch_send_probe`: render, send, parse the receipt, report a failure on one line. */
export function sendProbe(s: TickSeams, rung: string, armer: string, nudge: string, probeTimeout: string): ProbeSend {
  const body = probeBody(s.probeTemplate(), armer, nudge);
  const r = s.sendProbe(rung, body, probeTimeout);
  // `parsed="$(printf '%s' "$stdout" | ... probe-receipt 2>/dev/null || true)"`
  const parsed = probeReceipt(cmdSubst(r.stdout));
  const [status = "", id = "", path = "", delivery = "", errorClass = "", action = "", detail = ""] = parsed === "" ? [] : parsed.split("\x1f");
  const disposition = courierDisposition(r.rc, cmdSubst(r.stdout), r.err);
  if (!disposition.accepted) s.stderr(`tap watch: probe send to '${rung}' failed (rc=${r.rc}): ${detail || r.err}; next: ${action || "tap doctor"}`);
  const harnessQueued = disposition.accepted && disposition.delivery === "harness-queue";
  return { rc: r.rc, status, id, path, delivery, errorClass, action, detail, err: r.err, harnessQueued };
}

/** `_watch_reset_episode`: genuine resumption clears the episode and the blocked memory. */
export function resetEpisode(s: TickSeams): void {
  s.set(["episode_started_at", "0", "current_rung", "0", "last_probe_at", "0", "consecutive_defers", "0", "notified_at", "0", "evaluator_calls", "0",
    "probed_seats", "[]", "defer_seat", "", "blocked_map", "{}", "blocked_exempt", "[]"]);
}

/** `tap_valid_id`: the courier's id grammar (lib.sh). */
const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$/;

/**
 * `tap_watch_tick`. Returns the tick's status: 0 when the pass completed (a failed
 * door included, D), 1 for a reminders fire that failed or a record the tick cannot
 * read (R2/R2b).
 */
export async function runTick(s: TickSeams, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<number> {
  checkWatchStop(signal);
  // Mid-reset: successful no-op (design: watch ticks idle on the fence).
  if (s.fencePresent()) return 0;
  if (!s.armed()) return 0;
  // R2: a clock the tick cannot read is refused here, before ANY effect -- the reminders
  // fire and the reminders-only finish included (the incumbent's `remind.ts fire` CLI
  // refused the clock first, rc 1, the record intact) -- one line, status 1, nothing
  // written. The grammar is the shell's `[ -lt ]` (`testInt`: C whitespace both sides, a
  // sign), which is what the arithmetic and the activity-floor program accepted; the
  // value every door gets is the number itself.
  const rawNow = s.now();
  const nowInt = testInt(rawNow);
  if (nowInt === null) {
    s.stderr(`tap watch: now must be an integer: ${JSON.stringify(rawNow)}`);
    return 1;
  }
  const now = String(nowInt);
  const reminderArm = s.field("armed_at");
  if (s.remindersPresent() && s.remindFire(reminderArm) !== 0) return 1;
  if (s.field("mode") === "reminders-only") {
    s.remindFinish(reminderArm); // D: its status was the verb's, and nothing followed it
    return 0;
  }
  // Snapshot the arm record ONCE; every field this tick needs, with the incumbent's defaults.
  const f: Record<string, string> = Object.create(null);
  for (const line of s.snapshot()) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    f[line.slice(0, tab)] = line.slice(tab + 1);
  }
  const g = (k: string, d = ""): string => (f[k] !== undefined && f[k] !== "" ? f[k] : d);
  const armedBy = g("armed_by");
  const armedAt = g("armed_at", now);
  const silenceFloorAt = g("silence_floor_at", armedAt);
  const threshold = g("threshold_seconds", "1500");
  const probeTimeout = g("probe_timeout_seconds", threshold);
  const terminal = g("terminal_seat");
  let currentRung = g("current_rung", "0");
  let lastProbeAt = g("last_probe_at", "0");
  let consecutiveDefers = g("consecutive_defers", "0");
  let episodeStartedAt = g("episode_started_at", "0");
  const chainOverrides = g("chain_overrides");
  const prevHash = g("last_porcelain_hash");
  let porcChangeAt = g("last_porcelain_change_at");
  const notDoneReason = g("not_done_reason");
  let probedJson = g("probed_seats", "[]");
  let deferSeat = g("defer_seat");
  let queuedProbeId = g("queued_probe_id");
  let queuedProbeSeat = g("queued_probe_seat");
  let carriedProbeSeat = g("carried_probe_seat");
  let carriedProbeAt = g("carried_probe_at", "0");
  const pausedAt = g("paused_at");
  const pausedUntil = g("paused_until");
  const pauseReason = g("pause_reason");
  const contextThreshold = g("context_threshold_percent", "40");
  const contextExempt = g("context_exempt");
  let blockedMap = g("blocked_map", "{}");
  let blockedExempt = g("blocked_exempt", "[]");
  const livelockAlerts = g("livelock_alerts", "{}");
  const livelockSamples = g("livelock_samples");
  const contextFreezeSamples = g("context_freeze", "{}");
  const opencodeWedgeSamples = g("opencode_wedge", "{}");
  // R2b: a `current_rung` bash would have evaluated as a name is refused before any side effect
  if (testInt(currentRung) === null) {
    s.stderr(`tap watch: current_rung is not an integer: ${JSON.stringify(currentRung)}`);
    return 1;
  }

  // Prefetch the candidate rows once (C's door), admitting only seats the classifier
  // observes as active; every pane-reading pass below consumes this roster.
  const roster = s.roster() ?? [];
  const harnesses: string[] = [];
  for (const row of roster) if (row.harness !== "" && !harnesses.includes(row.harness)) harnesses.push(row.harness);
  const snapshot = { queuedProbeId, probeTimeout };

  // Blocked-seat PER-SEAT timer pass (tap-dst): every tick, unconditionally.
  const blocked = s.processBlocked(armedAt, now, armedBy, blockedMap, blockedExempt, roster);
  const blockedTouched = cmdSubst(blocked.touched);
  if (blockedTouched !== "") {
    blockedMap = s.field("blocked_map") || "{}";
    blockedExempt = s.field("blocked_exempt") || "[]";
  }

  // Approval-timeout pass: every tick; a team that has not opted in costs one file read (D).
  s.approvalTimeouts?.(armedBy, now, roster);

  s.detector("context-pressure", [armedAt, now, contextThreshold, contextExempt], roster);
  // Advisory detectors are harness-specific; an empty census FAILS OPEN (run all passes).
  if (harnesses.length === 0) {
    s.detector("codex-livelock", [armedAt, now, threshold, armedBy, livelockAlerts, livelockSamples], roster);
    s.detector("context-freeze", [armedAt, now, armedBy, contextFreezeSamples], roster);
    s.detector("opencode-wedge", [armedAt, now, armedBy, opencodeWedgeSamples], roster);
  } else {
    if (harnesses.includes("codex")) {
      s.detector("codex-livelock", [armedAt, now, threshold, armedBy, livelockAlerts, livelockSamples], roster);
      s.detector("context-freeze", [armedAt, now, armedBy, contextFreezeSamples], roster);
    }
    if (harnesses.includes("opencode")) s.detector("opencode-wedge", [armedAt, now, armedBy, opencodeWedgeSamples], roster);
  }

  // Spool redelivery pass: every tick, unconditionally (a parked send is a per-entry fact).
  await s.processSpool(armedAt, now, snapshot);
  checkWatchStop(signal);

  // A queued probe owns its rung until the courier moves that exact id out of spool.
  let queuedProbeParked = false;
  if (queuedProbeId !== "") {
    const observed = queuedProbeId;
    const claimToken = s.claimAcquire(observed);
    if (claimToken === null) {
      queuedProbeParked = true;
    } else {
      let ok = true;
      const expect = { TAP_WATCH_EXPECT_ARMED_AT: armedAt, TAP_WATCH_EXPECT_QUEUED_PROBE_ID: observed };
      if (s.busFile(`payloads/${observed}.md`) || s.busFile(`receipts/${observed}.done`)) {
        if (s.set(["queued_probe_id", "", "queued_probe_seat", "", "carried_probe_seat", queuedProbeSeat, "carried_probe_at", now, "last_probe_at", now], expect)) {
          carriedProbeSeat = queuedProbeSeat; carriedProbeAt = now; lastProbeAt = now;
          queuedProbeId = ""; queuedProbeSeat = ""; snapshot.queuedProbeId = "";
        } else ok = false;
      } else if (s.busFile(`spool/${observed}.md`) || s.busFile(`spool/${observed}.meta.json`)) {
        queuedProbeParked = true;
      } else if (s.set(["queued_probe_id", "", "queued_probe_seat", "", "last_probe_at", "0"], expect)) {
        lastProbeAt = "0"; queuedProbeId = ""; queuedProbeSeat = ""; snapshot.queuedProbeId = "";
      } else ok = false;
      s.claimRelease(observed, claimToken);
      if (!ok) return 0;
    }
  }

  // A run-level pause gates ONLY the silence escalation chain.
  if (pauseReason !== "" || (pausedUntil !== "" && pausedUntil !== "0")) {
    // `[ "$now" -lt "$paused_until" ] 2>/dev/null`: a non-integer is silently false
    const n = testInt(now);
    const u = testInt(pausedUntil);
    if (pausedUntil !== "" && n !== null && u !== null && n < u) return 0;
    if (!s.leaseCurrent(armedAt)) return 0;
    if (!s.clearPause(now, armedAt, pausedAt || "0", pausedUntil || "0")) return 0;
    s.noticeOrNotify(armedBy, `watch pause expired without resume; reason was ${pauseReason || "-"} — resume work, re-pause, or watch off`, `paused_until=${pausedUntil || "0"}`);
    return 0;
  }

  // repo activity: HEAD commit time + porcelain-hash change (NEVER raw .git/index mtime).
  const headCt = s.headCommitTime();
  const porcHash = s.porcelainHash();
  if (prevHash === "") {
    porcChangeAt = armedAt;                       // first observation: seed, don't count as activity
    s.set(["last_porcelain_hash", porcHash || "none", "last_porcelain_change_at", porcChangeAt]);
  } else if (porcHash !== prevHash) {
    porcChangeAt = now;                           // worktree changed -> activity now
    s.set(["last_porcelain_hash", porcHash || "none", "last_porcelain_change_at", now]);
  }
  if (porcChangeAt === "") porcChangeAt = armedAt;

  const busAct = s.busActivity(now);
  // silence = now - max(bus, head_ct, porcelain_change_at, armed_at), each future-clamped
  let floorLine: string;
  try { floorLine = activityFloor(now, silenceFloorAt, [busAct, headCt, porcChangeAt]); } catch (error) {
    // the program refused the clock (R2): the incumbent's arithmetic died right after
    s.stderr(`tap watch: ${(error as Error).message}`);
    return 1;
  }
  const [lastActivity = "", realActivity = ""] = cmdSubst(floorLine).split("\t");
  let silence: bigint;
  try { silence = arith(now, "now") - arith(lastActivity, "last_activity"); } catch (error) {
    s.stderr(`tap watch: ${(error as Error).message}`);
    return 1;
  }

  // A delivered queued probe can bridge an activity reset; genuine work after it cancels the carried timer.
  if (carriedProbeSeat !== "" && carriedProbeAt !== "0" && cmp(s, realActivity, "real_activity", carriedProbeAt, "carried_probe_at", "-gt")) {
    if (!s.set(["carried_probe_seat", "", "carried_probe_at", "0", "last_probe_at", "0"],
      { TAP_WATCH_EXPECT_ARMED_AT: armedAt, TAP_WATCH_EXPECT_CARRIED_PROBE_SEAT: carriedProbeSeat, TAP_WATCH_EXPECT_CARRIED_PROBE_AT: carriedProbeAt })) return 0;
    carriedProbeSeat = ""; carriedProbeAt = "0"; lastProbeAt = "0";
  }

  if (cmp(s, String(silence), "silence", threshold, "threshold_seconds", "-lt")) {
    if (episodeStartedAt !== "0") resetEpisode(s);   // resumption clears the episode
    return 0;
  }

  // wedge-suspect. Non-supervision activity AFTER the episode began == resumption.
  if (episodeStartedAt !== "0" && cmp(s, lastActivity, "last_activity", episodeStartedAt, "episode_started_at", "-gt")) {
    resetEpisode(s);
    return 0;
  }
  if (queuedProbeParked) return 0;
  if (episodeStartedAt === "0") {
    episodeStartedAt = now;                          // each new episode gets a fresh budget (R13)
    if (carriedProbeSeat !== "" && carriedProbeAt !== "0") {
      probedJson = s.probedAppend("[]", carriedProbeSeat);
      currentRung = "1";
      lastProbeAt = carriedProbeAt;
      if (!s.set(["episode_started_at", now, "current_rung", currentRung, "consecutive_defers", "0", "last_probe_at", lastProbeAt, "notified_at", "0", "evaluator_calls", "0",
        "probed_seats", probedJson, "defer_seat", "", "queued_probe_id", "", "queued_probe_seat", "", "carried_probe_seat", "", "carried_probe_at", "0"],
      { TAP_WATCH_EXPECT_ARMED_AT: armedAt, TAP_WATCH_EXPECT_CARRIED_PROBE_SEAT: carriedProbeSeat, TAP_WATCH_EXPECT_CARRIED_PROBE_AT: carriedProbeAt })) return 0;
      carriedProbeSeat = ""; carriedProbeAt = "0";
      consecutiveDefers = "0"; deferSeat = "";
    } else {
      s.set(["episode_started_at", now, "current_rung", "0", "consecutive_defers", "0", "last_probe_at", "0", "notified_at", "0", "evaluator_calls", "0",
        "probed_seats", "[]", "defer_seat", "", "queued_probe_id", "", "queued_probe_seat", ""]);
      currentRung = "0"; consecutiveDefers = "0"; lastProbeAt = "0"; probedJson = "[]"; deferSeat = "";
    }
  } else if (carriedProbeSeat !== "") {
    if (!s.set(["carried_probe_seat", "", "carried_probe_at", "0"],
      { TAP_WATCH_EXPECT_ARMED_AT: armedAt, TAP_WATCH_EXPECT_CARRIED_PROBE_SEAT: carriedProbeSeat, TAP_WATCH_EXPECT_CARRIED_PROBE_AT: carriedProbeAt })) return 0;
    carriedProbeSeat = ""; carriedProbeAt = "0";
  }

  // Advance runs on probe_timeout (default one threshold) -- NEVER the tick interval.
  if (lastProbeAt !== "0") {
    let elapsed: bigint;
    try { elapsed = arith(now, "now") - arith(lastProbeAt, "last_probe_at"); } catch (error) {
      s.stderr(`tap watch: ${(error as Error).message}`);
      return 1;
    }
    if (cmp(s, String(elapsed), "elapsed", probeTimeout, "probe_timeout_seconds", "-ge")) {
      lastProbeAt = "0"; consecutiveDefers = "0"; deferSeat = "";
      s.set(["last_probe_at", "0", "consecutive_defers", "0", "defer_seat", ""]);
    }
  }
  void consecutiveDefers; void deferSeat; // the incumbent tracked them locally past this point without reading them

  // Rung = the next seat by IDENTITY, past the probed, the blocked, and the touched.
  const chain = s.buildChain(chainOverrides, terminal, roster);
  const blockedKeys = blockedKeysJson(blockedMap);
  const skipJson = skipSetJson(probedJson, blockedKeys, blockedTouched);
  const rung = cmdSubst(s.nextUnprobed(chain, skipJson));
  if (rung === "" || rung === "__human__") {
    if (blockedMap !== "{}") {
      if (realWedge(probedJson, blockedMap, blockedExempt) !== "1") return 0;
    }
    if (blockedTouched !== "") return 0;
    if (lastProbeAt !== "0") {
      let elapsed: bigint;
      try { elapsed = arith(now, "now") - arith(lastProbeAt, "last_probe_at"); } catch (error) {
        s.stderr(`tap watch: ${(error as Error).message}`);
        return 1;
      }
      if (cmp(s, String(elapsed), "elapsed", probeTimeout, "probe_timeout_seconds", "-lt")) return 0;
    }
    s.evaluate(roster);                              // ambiguity-resolution seam (U7); advisory
    if (!s.leaseCurrent(armedAt)) return 0;
    s.notifyHuman("chain exhausted (all eligible seats probed)");
    return 0;
  }

  if (lastProbeAt === "0") {
    if (!s.leaseCurrent(armedAt)) return 0;
    // Classify BEFORE probing (tap-dst): a known blocked banner is recorded, not probed.
    if (!isExempt(rung, blockedExempt)) {
      const blockedClass = cmdSubst(s.classify(rung, roster));
      if (blockedClass !== "") {
        let [bReason = "", bTime = "", bTz = ""] = blockedClass.split("\t");
        let bReset = "0";
        if (bReason === "session_limit" && bTime !== "" && bTz !== "") {
          try { bReset = cmdSubst(parseResetEpoch(bTime, bTz, now)); } catch (error) {
            // `b_reset="$(...)"`: the program's refusal printed nothing; the substitution was ""
            s.stderr(`tap watch: ${(error as Error).message}`);
            bReset = "";
          }
        }
        // an unparseable/unrecognized reset clause must NOT arm a reset_at=0 timer: demote to api_error
        if (bReason === "session_limit") {
          const r = testInt(bReset || "0");
          if (r === null || r <= 0n) { bReason = "api_error"; bReset = "0"; }
        }
        blockedMap = blockedUpsert(blockedMap, rung, bReason, now, bReset || "0");
        s.set(["blocked_map", blockedMap]);
        return 0;
      }
    }

    const probeArmer = armedBy || terminal || rung;
    const sent = sendProbe(s, rung, probeArmer, notDoneReason, probeTimeout);
    const tuple = `${sent.rc}:${sent.status}:${sent.delivery}`;
    const advance = (extra: string[]): void => {
      probedJson = s.probedAppend(probedJson, rung);
      s.set(["probed_seats", probedJson, "current_rung", String(arith(currentRung, "current_rung") + 1n), ...extra, "defer_seat", "", "consecutive_defers", "0"]);
    };
    // A harness- or poll-queued probe's payload is already canonical: probe_timeout starts
    // now, and the deadline path owns its unconfirmed turn. Unrecorded, the rung would be
    // probed again on every tick (tap-q2qw0).
    if (tuple === "0:injected:pane" || tuple === "5:pending:" || tuple === "0:queued:poll" || sent.harnessQueued) {
      advance(["last_probe_at", now]);
    } else if (tuple === "0:queued:spool") {
      if (!VALID_ID.test(sent.id)) return 0;
      advance(["last_probe_at", "0", "queued_probe_id", sent.id, "queued_probe_seat", rung]);
    } else if (sent.rc === 3) {
      advance(["last_probe_at", "0"]);
    } else if (sent.rc === 1 && (sent.errorClass === "unsafe_target" || sent.errorClass === "unsupported_harness")) {
      advance(["last_probe_at", "0"]);
      s.notifyHuman(`probe to '${rung}' refused (${sent.errorClass}): ${sent.detail || "terminal refusal"}; next: ${sent.action || "tap doctor"}`);
    }
  }
  return 0;
}

// --- the production world -------------------------------------------------------------------------

export interface RealTickArgs {
  signal?: AbortSignal;
  bus: string;
  scripts: string;
  /** The ACTING registry (`ctx.registryPath`). */
  registry: string;
  /** The reset fence's handle scope (`tap_reset_fence_path`): the bus dir's fence. */
  env?: NodeJS.ProcessEnv;
  /** The tick's authority team (`spoolTeamName` over the resolved bus and registry), threaded to the detectors. */
  team?: string;
}

/**
 * The registry's active rows as the incumbent's `seat-rows` program printed them -- the
 * document's own order, `str(v or "")` per field -- shaped for the observation door. Null
 * when the acting registry cannot be read (`tap_acting_registry` failed: no roster).
 */
export function registryRowsInOrder(registry: string, text = readRegistryText(registry)): RegistryRow[] | null {
  if (text === null) return null;
  return activeSeatRows(text).rows.map((r) => ({
    team: "", handle: r[0] ?? "", status: r[1] ?? "", delivery: r[2] ?? "", pane: r[3] ?? "", pane_id: r[4] ?? "", session: r[5] ?? "",
    registered_at: r[6] ?? "", server_epoch: r[7] ?? "", boot_id: r[8] ?? "", harness: r[9] ?? "", status_reason: r[10] ?? "",
    unattended: false, crew: false, preset: "",
  }));
}

/** `tap_sha256`: `shasum -a 256 | awk '{print $1}'`. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function realTickSeams(a: RealTickArgs): TickSeams {
  const env = a.env ?? process.env;
  const bus = a.bus;
  const arm = armPath(bus);
  const identity = env.TAP_WATCH_IDENTITY || WATCH_IDENTITY_DEFAULT;
  const tickNow = env.TAP_WATCH_NOW || String(Math.floor(Date.now() / 1000));
  const now = (): string => tickNow;
  let registryCache: RegistryDoc | null | undefined;
  let registryText: string | null = null;
  const registryOnce = (): RegistryDoc | null => {
    if (registryCache !== undefined) return registryCache;
    if (!isFile(a.registry)) return (registryCache = null);
    try {
      registryText = readRegistryText(a.registry);
      if (registryText === null) return (registryCache = null);
      const doc = loadRegistry(a.registry, registryText);
      const refusal = teamRegistryRefusal(a.registry, doc);
      if (refusal) {
        process.stderr.write(`tap watch: ${refusal.errorClass}: ${refusal.detail}; next: ${refusal.action}\n`);
        return (registryCache = null);
      }
      return (registryCache = doc);
    } catch { return (registryCache = null); }
  };
  const repoRoot = (): string => {
    const team = registryOnce()?.team;
    const root = team && typeof team === "object" && !Array.isArray(team) ? (team as Record<string, unknown>).worktree_root : undefined;
    return typeof root === "string" && root ? root : process.cwd();
  };
  let detectorWorld: ReturnType<typeof realDetectorSeams> | undefined;
  let activityCache: string | undefined;
  let rosterCache: RosterRow[] | null | undefined;
  const rosterOnce = (): RosterRow[] | null => {
    if (rosterCache !== undefined) return rosterCache;
    // `tap_acting_registry` + the registry's active rows (the incumbent's program, in the
    // document's order), then ONE observation (C's batch door; the incumbent classified
    // per seat under TAP_OBS_SESSION_SCOPE -- the batch gather is ratified in advance by
    // C, observe.ts's header calls it the correction)
    const doc = registryOnce();
    if (doc === null) return (rosterCache = null);
    // Keep document order even for numeric handles, which JS object keys sort.
    const rows = registryRowsInOrder(a.registry, registryText);
    if (rows === null) return (rosterCache = null);
    const observed = observe(rows, a.scripts);
    const out: RosterRow[] = [];
    for (const row of rows) {
      const handle = String(row.handle);
      const rec = observed.rows.get(handle);
      if (rec === undefined || rec[0] !== "active") continue;
      // the record: state, reason, resolved pane, resolved id, live harness, attached
      out.push({ handle, pane: rec[2] ?? "", paneId: rec[3] ?? "", harness: (rec[4] || String(row.harness)) });
    }
    detectorWorld = realDetectorSeams({ bus, scripts: a.scripts, registry: a.registry, env: tickEnv(env, out, tickNow), now: tickNow, team: a.team,
      snapshot: { seats: seatMap(doc), roster: out, panes: observed.panes ?? new Map(), at: testInt(tickNow) ?? 0n } });
    return (rosterCache = out);
  };
  return {
    now,
    // `tap_reset_fence_present`: `[ -f "$TAP_HOME/reset.fence.json" ]` (tap-reset-fence.sh) -- the RESET fence, a regular file
    fencePresent: () => isFile(join(bus, "reset.fence.json")),
    // `tap_watch_is_armed`: `[ -f arm.json ]` -- a directory or a fifo where the lease should be is not a lease
    armed: () => isFile(arm),
    snapshot: () => { try { return snapshotLines(readLoose(arm)); } catch { return []; } },
    field: (key) => { try { return cmdSubst(fieldValue(readLoose(arm), key)); } catch { return ""; } },
    set: (pairs, expect) => { try { return leaseSet(arm, pairs, { ...env, ...(expect ?? {}) }) === 0; } catch { return false; } },
    clearPause: (n, at, pa, pu) => { try { return clearPause(arm, n, at, pa, pu, env) === 0; } catch { return false; } },
    // `_watch_lease_current`: `tap_watch_is_armed || return 1`, then the live record's armed_at
    leaseCurrent: (armedAt) => { if (!isFile(arm)) return false; try { return cmdSubst(fieldValue(readLoose(arm), "armed_at")) === armedAt; } catch { return false; } },
    remindersPresent: () => isFile(join(bus, "watch", "reminders.json")),
    remindFire: (armAt) => { try { remindFire(join(bus, "watch", "reminders.json"), a.scripts, armAt, Number(now())); return 0; } catch (error) { process.stderr.write(`tap watch: reminders: ${(error as Error).message}\n`); return 1; } },
    remindFinish: (armAt) => { try { remindFinish(join(bus, "watch", "reminders.json"), armAt, false); return 0; } catch (error) { process.stderr.write(`tap watch: reminders: ${(error as Error).message}\n`); return 1; } },
    roster: rosterOnce,
    processBlocked: (armedAt, n, armedBy, map, exempt, roster) => {
      const r = processBlocked(armedAt, n, armedBy, map, exempt, realBlockedSeams({ bus, scripts: a.scripts, registry: a.registry, env: tickEnv(env, roster, now()), now: n }), env);
      return { touched: r.touched.map((h) => `${h}\n`).join(""), rc: r.rc };
    },
    approvalTimeouts: (armedBy, n, roster) =>
      processApprovalTimeouts(roster, armedBy, realApprovalSeams({ bus, scripts: a.scripts, registry: a.registry, env, now: () => Number(n) })),
    detector: (name, args, roster) => {
      rosterOnce();
      if (!detectorWorld) return 0;
      const world = detectorWorld;
      const at = args[1] ?? "";
      if (testInt(at) === null) {
        // the module's own clock check (`now must be an integer`): the door failed, the tick goes on (D)
        process.stderr.write(`tap watch: now must be an integer: ${JSON.stringify(at)}\n`);
        return 1;
      }
      try {
        switch (name) {
          case "context-pressure": return contextPressure(args[0]!, testInt(at)!, args[2]!, args[3]!, world);
          case "codex-livelock": return codexLivelock(args[0]!, testInt(at)!, args[2]!, args[3]!, args[4], args[5], world);
          case "context-freeze": return contextFreeze(args[0]!, testInt(at)!, args[2]!, args[3], world, env);
          case "opencode-wedge": return opencodeWedge(args[0]!, testInt(at)!, args[2]!, args[3], world, env);
        }
      } catch (error) {
        if (error instanceof TickAbort) return 1;
        process.stderr.write(`tap watch: ${name}: ${(error as Error).message}\n`);
        return 1;
      }
      return 0;
    },
    processSpool: async (armedAt, n, snap) => {
      // The one native spool pass receives the tick snapshot as arguments.
      // Remove ambient caller-only facts before spawning its owned worker.
      const spoolEnv: NodeJS.ProcessEnv = { ...childBusEnv(bus, env), TAP_REGISTRY: a.registry, TAP_VERB: "tap watch" };
      delete spoolEnv.TAP_SPOOL_HUMAN_ALERT;
      delete spoolEnv.TAP_WATCH_TICK_ACTIVE;
      delete spoolEnv.TAP_WATCH_TICK_QUEUED_PROBE_ID;
      delete spoolEnv.TAP_WATCH_TICK_PROBE_TIMEOUT;
      const command = spoolEngineCommand(a.scripts, "watch", armedAt, n, snap.queuedProbeId, snap.probeTimeout);
      return watchChild(command, spoolEnv, a.signal, "spool");
    },
    claimAcquire: (id) => {
      try { const claim = claimAcquire(join(bus, "spool"), id, false, env); return claim.status === "acquired" ? claim.token : null; } catch (error) {
        process.stderr.write(`tap: slice_failed id=${id} slice=spool-sidecar: ${(error as Error).message}\n`);
        return null;
      }
    },
    claimRelease: (id, token) => { try { claimRelease(join(bus, "spool"), id, token); } catch { /* best effort, as the incumbent's rm -f */ } },
    busFile: (rel) => isFile(join(bus, rel)),   // `[ -f ]`: a directory at a payload's path is not a delivery
    noticeOrNotify: (to, reason, evidence) => noticeOrNotify({ bus, scripts: a.scripts, to, reason, evidence, now: now(), env }),
    notifyHuman: (reason) => notifyHuman({ bus, scripts: a.scripts, reason, kind: "episode", now: now(), env }),
    evaluate: (roster) => {
      const tenv = tickEnv(env, roster, now());
      try { return evaluate(realEvaluatorSeams({ bus, scripts: a.scripts, registry: a.registry, env: tenv }), bus, a.scripts, tenv); } catch (error) { process.stderr.write(`tap watch: evaluate: ${(error as Error).message}\n`); return 1; }
    },
    headCommitTime: () => {
      const r = spawnSync("git", ["-C", repoRoot(), "log", "-1", "--format=%ct"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      return r.status === 0 ? cmdSubst(r.stdout) : "";
    },
    porcelainHash: () => {
      const r = spawnSync("git", ["-C", repoRoot(), "status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      // `git ... 2>/dev/null | tap_sha256`: a failed git still fed the hash "" (the pipeline's status was awk's)
      return sha256Hex(r.status === 0 ? r.stdout : "");
    },
    busActivity: (n) => activityCache ??= busActivity(join(bus, "payloads"), join(bus, "receipts"), testInt(n) ?? 0n, 0n, "", ""),
    buildChain: (overrides, terminal, roster) => {
      // the rung walks the tick's roster (W2b's seams read it as the tick's cache): a seat the observer rejected is no rung
      try { return buildChain(overrides, terminal, realEvaluatorSeams({ bus, scripts: a.scripts, registry: a.registry, env: tickEnv(env, roster, now()) })); } catch (error) {
        process.stderr.write(`tap watch: build-chain: ${(error as Error).message}\n`);
        return "__human__\n";
      }
    },
    nextUnprobed: (chain, skipJson) => nextUnprobed(skipJson, chain),
    probedAppend,
    // `_watch_classify_blocked <rung>`: the transcript through `tap peek` (B4's reader, one spawn), classified natively
    classify: (rung, roster) => classifyBlocked(rung, realBlockedSeams({ bus, scripts: a.scripts, registry: a.registry, env: tickEnv(env, roster, now()), now: now() })),
    sendProbe: (rung, body, probeTimeout) => {
      const dir = join(bus, "watch");
      const draft = join(dir, `.probe.${process.pid}.md`);
      let result: { rc: number; stdout: string; err: string };
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(draft, body);
        const [cmd, ...argv] = courierArgv(a.scripts, [rung, draft, "--from", identity, "--kind", "probe", "--fyi", "--json"], env);
        const r = spawnSync(cmd!, argv,
          { encoding: "utf8", env: { ...env, TAP_SELF: identity, TAP_SEND_GRACE_SECONDS: probeTimeout }, stdio: ["inherit", "pipe", "pipe"] });
        const err = (r.error ? r.error.message : (r.stderr ?? "")).split("\n")[0] ?? "";
        result = { rc: r.status ?? 1, stdout: r.stdout ?? "", err };
      } catch (error) {
        result = { rc: 1, stdout: "", err: (error as Error).message.split("\n")[0] ?? "" };
      }
      try { rmSync(draft, { force: true }); } catch { /* best effort, as `rm -f` was */ }
      return result;
    },
    probeTemplate: () => { try { return readFileSync(join(a.scripts, "watch-templates", "probe.md"), "utf8"); } catch { return ""; } },
    stderr: (line) => process.stderr.write(`${line}\n`),
  };
}

/** The tick's roster cache as the detectors' and the blocked pass's seams read it (W2a's env door). */
function tickEnv(env: NodeJS.ProcessEnv, roster: RosterRow[], now: string): NodeJS.ProcessEnv {
  return {
    ...env,
    TAP_WATCH_TICK_ACTIVE: "1",
    TAP_WATCH_TICK_ROSTER_HANDLES: roster.map((r) => `${r.handle}\n`).join(""),
    TAP_WATCH_TICK_PANE_RECORDS: roster.map((r) => `${r.handle}\x1f${r.pane}\x1f${r.paneId}\n`).join(""),
    TAP_WATCH_NOW: now,
  };
}

// --- CLI ------------------------------------------------------------------------------------------

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, scriptsDir?: string): Promise<number> {
  const [verb] = argv;
  if (verb !== "tick") throw new Error("usage: watch-tick-run.ts tick");
  return withWatchLifetime(async signal => {
    const ctx = resolveContext(process.cwd(), env);
    const scripts = scriptsDir || tapScriptsDir();
    return runTick(realTickSeams({ bus: ctx.bus.home, scripts, registry: ctx.registryPath, env, signal,
      team: spoolTeamName(ctx.bus.home, env.TAP_INDEX_HOME) }), env, signal);
  }, true);
}

if (import.meta.main) {
  // Exit explicitly, as the incumbent did: `main` has awaited every owned child, and an
  // undrained tick stayed alive after a reminders-only finish, stalling the loop.
  let code = 1;
  try {
    code = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`tap watch: ${(error as Error).message}\n`);
  }
  process.exit(code);
}
