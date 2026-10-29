import { INCOMPLETE_DRAFT_NOTICE } from "./input-backup";
// The park's whole route, in process: the A1b transaction (`parkPlaced`) and the
// choreography `tap_spool_park_placed` kept in Bash after it — the green/red flash
// cue, the deliverer spawn, the backlog report and its warning, the queue-explanation
// injection branches and the queued receipts. One export for both doors: native
// `send` calls `parkAndReport` in process (its busy-pane route no longer spawns a
// Bash shell to park), and lib.sh's `tap_spool_park_placed` is an adapter over the
// same function through the CLI at the bottom. Ported with it, because these were
// the only live callers left of their bodies: `tap_pane_effect_flash` (+ `_body`),
// `tap_pane_effect_clear_verified`, `tap_spool_spawn_deliverer`,
// `tap_spool_backlog_warn` and the receipt rendering.
//
// The native waiter calls the native spool engine once per tick. The verbose human
// receipt's `[display state]` token is READINESS (`tap_spool_display_state` →
// `tap_spool_pane_ready`, the reader lane B's B1 ports); it enters as data
// (`ReceiptOptions.displayState`), computed by the incumbent on the Bash door and, on the
// native door, by the caller that owns the verbose form. `reply`'s route is quiet and never
// reads it (reviewer finding).
//
// Every decided outcome answers at exit 0 with a verdict; a refusal carries the
// incumbent's class and detail with the canonical retained.

import { closeSync, mkdirSync, openSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

import { bunBinary } from "./courier-argv";
import { atomicWrite, jsonObj } from "./fsatomic";
import { harnessQueueMessage, harnessQueued } from "./harness-queue";
import { snoozedInputForPane } from "./input-protection";
import { acquirePaneLock } from "./panelock";
import { queueExplanation } from "./queue-explanation";
import { recoveryHold } from "./recovery/state";
import { withResetCustody } from "./reset";
import { reownRelease } from "./spool-reown";
import { ParkRefusal, parkPlaced, type ParkInput, type Parked } from "./spool-park";
import { backlogThresholds, spoolBacklog } from "./spool-backlog";
import { tintPane, untintPane } from "./pane-tint";
import { unresolvedInjection } from "./submit-phase";
import { observePaneResult, serverEpochFromRaw, tmux } from "./tmux";

// --- the pane-effect flash ------------------------------------------------------------

export interface FlashInput {
  /** `$TAP_HOME`: the effect token lives under `pane-effects/`. */
  home: string;
  pane: string;
  paneId: string;
  ownerId: string;
  style?: string;
  count?: number;
  env?: NodeJS.ProcessEnv;
}

function paneEffectTokenPath(home: string, paneId: string): string {
  return join(home, "pane-effects", `${paneId}.json`);
}

/** `tap_pane_observe`: the live pane id and server epoch, or null when the pane is gone. */
function observe(target: string, env: NodeJS.ProcessEnv): { paneId: string; epoch: string } | null {
  const r = observePaneResult(target, env);
  if (r.status !== "ok") return null;
  return { paneId: r.observation.paneId, epoch: r.observation.serverEpoch };
}

/**
 * `tap_server_epoch_now`: the env pin, else the server's `#{pid}:#{start_time}`; "" when unobservable.
 * `run` defaults to the rate-limited courier client; a pure observer passes `tmuxReadOnly`.
 */
export function serverEpochNow(env: NodeJS.ProcessEnv = process.env, run: typeof tmux = tmux): string {
  if (env.TAP_SERVER_EPOCH !== undefined) return env.TAP_SERVER_EPOCH;
  const r = run(["display-message", "-p", "#{pid}:#{start_time}"], env);
  if (r.code !== 0) return "";
  try { return serverEpochFromRaw(r.stdout.replace(/\n$/, ""), env); } catch { return ""; }
}

/** Notify the clients that owned the backed-up draft, using the caller's captured identity. */
export function notifyDraftBackedUp(pane: string, paneId: string, epoch: string, session: string,
  env: NodeJS.ProcessEnv = process.env, incomplete = false): void {
  notifyPaneOperator(pane, paneId, epoch, session,
    incomplete ? INCOMPLETE_DRAFT_NOTICE : "tap: your draft was saved, not lost -- recover it with: tap draft", env);
}

/** A non-blocking cue to the attached clients, never a popup or composer input. */
export function notifyPaneOperator(pane: string, paneId: string, epoch: string, session: string,
  message: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!paneId || !epoch || !session) return;
  try {
    if (observe(pane, env)?.paneId !== paneId) return;
    const clients = tmux(["list-clients", "-t", session, "-F", "#{client_name}"], env);
    if (clients.code !== 0) return;
    for (const client of clients.stdout.split("\n").filter(Boolean)) {
      if (serverEpochNow(env) !== epoch || observe(pane, env)?.paneId !== paneId) return;
      tmux(["display-message", "-c", client, "-t", paneId, "-d", "8000",
        message], env);
    }
  } catch { /* Cosmetic failure never changes delivery. */ }
}

/**
 * `tap_pane_effect_clear_verified <pane-id> <server-epoch>`: the pane is still the
 * one the effect was applied to (same id, same server generation), the window
 * styles are unset, and nothing remains set — all three, or the token stays.
 */
export function paneEffectClearVerified(paneId: string, epoch: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!paneId || !epoch) return false;
  const live = observe(paneId, env);
  if (!live || live.paneId !== paneId || live.epoch !== epoch) return false;
  const r = tmux([
    "set-option", "-p", "-u", "-t", paneId, "window-style", ";",
    "set-option", "-p", "-u", "-t", paneId, "window-active-style", ";",
    "show-options", "-p", "-t", paneId, "window-style", ";",
    "show-options", "-p", "-t", paneId, "window-active-style",
  ], env);
  if (r.code !== 0) return false;
  return r.stdout === "";
}

/**
 * How long a cue stays up, and how old an unfinished token must be before a later
 * cue may take it over. The Bash original got its dwell for free from the
 * subprocess forks between tint and clear. The in-process port tinted and
 * cleared within a few milliseconds, so no cue was ever visible (tap-ipex2).
 */
export const CUE_DWELL_MS = 400;
export const CLOBBER_BLINK = { count: 2, onMs: 300, offMs: 200 } as const;
export const STALE_CUE_TOKEN_MS = 5000;

/** A tint this process applied under its token; `ino` names that exact mint. */
export interface PaneCue { home: string; paneId: string; epoch: string; path: string; ino: number; env: NodeJS.ProcessEnv }

function tokenIno(path: string): number | null {
  try { return statSync(path).ino; } catch { return null; }
}

/**
 * The first half of `tap_pane_effect_flash_body`, for a caller holding the pane's
 * submit lock. Observe the ADDRESS first (a recycled pane is not ours); mint the
 * effect token exclusively; tint once. An existing token means another effect is
 * in flight, unless it is older than any dwell (its owner never finished) or the
 * caller takes over (the clobber's lead-time blink outranks a cue).
 */
export function beginPaneCue(input: FlashInput, takeOver = false): PaneCue | null {
  const env = input.env ?? process.env;
  const style = input.style ?? "bg=red";
  if (!input.paneId || !input.home) return null;
  const first = observe(input.pane, env);
  if (!first || first.paneId !== input.paneId || !first.epoch) return null;
  const path = paneEffectTokenPath(input.home, input.paneId);
  // `json.dump(…, sort_keys=True)` with Python's default separators, then a newline.
  const token = `{"applied_style": ${JSON.stringify(style)}, "owner_id": ${JSON.stringify(input.ownerId)}, "pane": ${JSON.stringify(input.pane)}, "pane_id": ${JSON.stringify(input.paneId)}, "server_epoch": ${JSON.stringify(first.epoch)}, "v": 2}\n`;
  let ino: number | null = null;
  // The token lives in pane-effects/, which a team reset checkpoints, so each token
  // write takes reset custody for just that write; the tmux calls between them never
  // hold it (tap-12ys6). Custody refused, busy or fenced: no cue, or the token stays.
  withResetCustody(input.home, "pane-effect cue", () => {
    try { mkdirSync(dirname(path), { recursive: true }); } catch { /* the create below reports it */ }
    let fd: number;
    try { fd = openSync(path, "wx", 0o600); }
    catch {
      let age = 0;
      try { age = Date.now() - statSync(path).mtimeMs; } catch { return; }
      if (!takeOver && age < STALE_CUE_TOKEN_MS) return;
      // A fresh file (new inode) retires the old owner's pending `end` as a no-op.
      try { atomicWrite(path, token); ino = tokenIno(path); } catch { /* no cue */ }
      return;
    }
    try { writeFileSync(fd, token); } finally { closeSync(fd); }
    ino = tokenIno(path);
  }, 0);
  if (ino === null) return null;
  const live = observe(input.paneId, env);
  if (live && live.paneId === input.paneId && live.epoch) tintPane(input.paneId, style, env);
  return { home: input.home, paneId: input.paneId, epoch: first.epoch, path, ino, env };
}

/**
 * The second half: clear only while the token is still the one `begin` minted
 * (a later mint makes this a no-op), verify, drop the token. Needs no lock.
 * The token stays when the clear cannot be verified and the server generation
 * has not moved; the drain's orphan repair or a stale takeover reclaims it.
 */
export function endPaneCue(cue: PaneCue): void {
  const ours = () => tokenIno(cue.path) === cue.ino;
  const drop = (): void => {
    withResetCustody(cue.home, "pane-effect cue", () => { if (ours()) { try { rmSync(cue.path, { force: true }); } catch { /* best effort */ } } }, 0);
  };
  if (!ours()) return;
  if (paneEffectClearVerified(cue.paneId, cue.epoch, cue.env)) { drop(); return; }
  const now = serverEpochNow(cue.env);
  if (now && now !== cue.epoch) drop();
}

const pendingCues = new Set<{ cue: PaneCue; due: number }>();
let exitFlushArmed = false;

/**
 * Clear after the dwell without holding anything. The timer serves a live
 * process; an exit (the CLIs end in `process.exit`, which drops timers) waits out
 * the rest of the dwell and clears synchronously. A killed process leaves the
 * token, which a later cue takes over once stale and the drain's orphan repair removes.
 */
export function endPaneCueAfter(cue: PaneCue | null, ms = CUE_DWELL_MS): void {
  if (!cue) return;
  const entry = { cue, due: Date.now() + ms };
  pendingCues.add(entry);
  if (!exitFlushArmed) {
    exitFlushArmed = true;
    process.on("exit", () => {
      for (const pending of pendingCues) {
        const wait = pending.due - Date.now();
        if (wait > 0) Bun.sleepSync(wait);
        try { endPaneCue(pending.cue); } catch { /* the cue is best effort */ }
      }
      pendingCues.clear();
    });
  }
  setTimeout(() => {
    if (pendingCues.delete(entry)) { try { endPaneCue(cue); } catch { /* the cue is best effort */ } }
  }, ms);
}

/**
 * `tap_pane_effect_flash_body`: the whole effect for a caller that already holds
 * the pane's submit lock. With `blink`, the pane stays tinted `onMs` and dark
 * `offMs` per count while the lock is held. Only a caller whose next act is a key
 * into this pane may do that: the clobber's lead time before its first C-u, the
 * urgent cue before its interrupt key. Cues never sleep under the lock
 * (`beginPaneCue` + `endPaneCueAfter`). Without `blink`, today's zero-dwell tint.
 */
export function flashPaneLocked(input: FlashInput, blink?: { onMs: number; offMs: number }): void {
  const env = input.env ?? process.env;
  const cue = beginPaneCue(input, !!blink);
  if (!cue) return;
  const count = input.count ?? 1;
  for (let i = 0; i < count; i++) {
    const live = observe(input.paneId, env);
    if (!live || live.paneId !== input.paneId || !live.epoch) break;
    if (i) tintPane(input.paneId, input.style ?? "bg=red", env);
    if (!blink) continue;
    Bun.sleepSync(blink.onMs);
    if (i < count - 1) { untintPane(input.paneId, env); Bun.sleepSync(blink.offMs); }
  }
  endPaneCue(cue);
}

/**
 * `tap_pane_effect_flash`: the locked form. No lock, no flash; a recovery hold on
 * the pane, no flash — the cue is cosmetic and never contends with a delivery.
 * `detached` tints under the lock and returns the cue for the caller to clear
 * after the dwell with the lock released (`endPaneCueAfter`).
 */
export function flashPane(input: FlashInput, options: { detached?: boolean } = {}): PaneCue | null {
  const env = input.env ?? process.env;
  // `tap_pane_submit_lock <pane>`: the configured wait (`TAP_PANE_SUBMIT_LOCK_TIMEOUT`,
  // seconds, fractional allowed), else 5 s — a cosmetic cue must not hold a parked send
  // behind a held lock longer than the operator configured.
  const seconds = Number(env.TAP_PANE_SUBMIT_LOCK_TIMEOUT ?? 5);
  const lock = acquirePaneLock(input.paneId, Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 5000, env);
  if (!lock) return null;
  try {
    if (recoveryHold(input.paneId, env)) return null;
    if (options.detached) return beginPaneCue(input);
    flashPaneLocked(input);
    return null;
  } finally {
    lock.release();
  }
}

// --- the deliverer spawn ------------------------------------------------------------------

export interface SpawnDelivererInput {
  /** `$_TAP_SCRIPT_DIR`: locates the sibling Bun runtime and native drain engine. */
  scriptsDir: string;
  home: string;
  spoolDir: string;
  id: string;
  /** The `.reown` lease the spawn carries to the waiter by ENV (`TAP_SPOOL_REOWN_TOKEN`). */
  reownToken?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * `tap_spool_spawn_deliverer`: launch the per-entry waiter detached, its output
 * appended to `<home>/tap-deliver.log`, `TAP_SPOOL_DRAIN_ACTIVE` scrubbed so the
 * waiter's own drain is not read as re-entrant. Under `TAP_SPOOL_DISABLE_DELIVERER=1`
 * nothing is spawned and a carried lease is released HERE — the only place that
 * knows the spawn did not happen. A failed spawn releases the lease the same way.
 */
export function spawnDeliverer(input: SpawnDelivererInput): boolean {
  const env = { ...(input.env ?? process.env) };
  const release = (): void => { if (input.reownToken) reownRelease(input.spoolDir, input.id, input.reownToken, env); };
  if (env.TAP_SPOOL_DISABLE_DELIVERER === "1") { release(); return true; }
  delete env.TAP_SPOOL_DRAIN_ACTIVE;
  delete env.TAP_WATCH_PARENT_PIPE;
  delete env.TAP_SPOOL_PARENT_PIPE;
  if (input.reownToken) env.TAP_SPOOL_REOWN_TOKEN = input.reownToken;
  try {
    mkdirSync(input.home, { recursive: true });
    const log = openSync(join(input.home, "tap-deliver.log"), "a");
    try {
      const child = spawn(bunBinary(), [join(input.scriptsDir, "../../../runtime/bun/src/spool-waiter.ts"), input.id], {
        env, stdio: ["ignore", log, log], detached: true,
      });
      child.on("error", () => { /* surfaced through the spawn result below */ });
      child.unref();
      if (child.pid === undefined) { release(); return false; }
    } finally {
      closeSync(log);
    }
    return true;
  } catch {
    release();
    return false;
  }
}

// --- the report --------------------------------------------------------------------------

export interface ParkReportInput extends ParkInput {
  from: string;
  kind: string;
  replyExpect: string;
  scriptsDir: string;
}

export interface Backlog { count: string; condition: boolean; line: string; remedy: string }

export interface ParkReport {
  verdict: "ok";
  parked: Parked;
  /** The detached waiter launched (or was suppressed by `TAP_SPOOL_DISABLE_DELIVERER`). A
   *  false here is the incumbent's late park failure: the pair is published and retained,
   *  the canonical retired, and no waiter will redeliver it — the receipt says so. */
  spawned: boolean;
  backlog: Backlog | null;
  /** `unresolvedInjection`: a submit phase record says the id already reached the pane. */
  injected: string | null;
  injectedPhase: "harness-queued" | "injected-enter-unconfirmed" | null;
}

export interface ParkReportHooks {
  flash?: (input: FlashInput) => void;
  spawn?: (input: SpawnDelivererInput) => boolean;
}

/**
 * `tap_spool_park_placed` after its transaction: the cue, the waiter, the backlog
 * (its warning goes to stderr here, as the incumbent's did), and the injection facts
 * the receipt needs. Throws `ParkRefusal` for the transaction's two decided
 * refusals; the caller renders those as `tap_fail` did.
 */
export function parkAndReport(input: ParkReportInput, hooks: ParkReportHooks = {}): ParkReport {
  return finishPark(input, parkPlaced(input), hooks);
}

/**
 * Everything after the transaction. A caller holding reset custody runs `parkPlaced`
 * under it and this after release: the flash takes the pane lock and the spawn forks,
 * and a reset holder waits on neither (tap-12ys6).
 */
export function finishPark(input: ParkReportInput, parked: Parked, hooks: ParkReportHooks = {}): ParkReport {
  const env = input.env ?? process.env;
  // While the pane's WAIT snooze is active, every arrival parks silently: the
  // green/red park cues must not mask the BLUE latch or the -30s/-10s milestones.
  // The suppression decision and the flash share the pane submit lock so a waiter
  // latching WAIT between the check and the flash cannot be painted over.
  let cue: PaneCue | null = null;
  if (input.cueStyle === "green" || input.cueStyle === "red") {
    // COSMETIC, never load-bearing (the incumbent returned 0 on every failure): a tmux
    // that times out or cannot fork throws from the runner, and that must not stop the
    // waiter spawn below — the pair is already published and the canonical retired.
    try {
      const seconds = Number(env.TAP_PANE_SUBMIT_LOCK_TIMEOUT ?? 5);
      const lock = acquirePaneLock(input.paneId, Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 5000, env);
      if (lock) {
        try {
          if (!recoveryHold(input.paneId, env) && !snoozedInputForPane(input.paneId, env)) {
            const flash = { home: input.home, pane: input.pane, paneId: input.paneId, ownerId: input.id, style: `bg=${input.cueStyle}`, count: 1, env };
            if (hooks.flash) hooks.flash(flash); else cue = beginPaneCue(flash);
          }
        } finally { lock.release(); }
      }
    } catch { /* the cue is best effort */ }
  }
  // Liveness before cosmetics: the waiter is spawned before the cue's dwell, so a
  // sender killed during the dwell still leaves its parked message a deliverer.
  const spawned = (hooks.spawn ?? spawnDeliverer)({ scriptsDir: input.scriptsDir, home: input.home, spoolDir: input.spoolDir, id: input.id, env });
  // This send process exits next: the dwell and the clear happen here, off the lock.
  if (cue) { try { Bun.sleepSync(CUE_DWELL_MS); endPaneCue(cue); } catch { /* the cue is best effort */ } }
  // The incumbent's late failure (a bare `tap_spool_spawn_deliverer` under the send doors'
  // errexit) aborted after publication; native send reported the retained pair with this
  // warning. That receipt is now the one outcome on both doors.
  if (!spawned) process.stderr.write(`tap send: warning: parking '${input.id}' did not complete; inspect with tap show ${input.id}; automatic redelivery is not confirmed\n`);
  // `tap_spool_backlog_report "$TO" 2>/dev/null || true`: any failure is "no report".
  let backlog: Backlog | null = null;
  try {
    if (input.target) {
      const [countMin, probesMin] = backlogThresholds(env);
      const report = spoolBacklog(input.spoolDir, input.target, "", Math.floor(Date.now() / 1000), countMin, probesMin) as Record<string, unknown>;
      // Python's `r.get("count") or 0` / `"true" if r.get("condition") else "false"`.
      const count = report.count === undefined || report.count === null || report.count === 0 || report.count === "" || report.count === false ? "0" : String(report.count);
      backlog = { count, condition: !!report.condition, line: String(report.line ?? ""), remedy: String(report.remedy ?? "") };
      if (backlog.condition) process.stderr.write(`tap: WARNING — ${backlog.line}; next: ${backlog.remedy}\n`);
    }
  } catch { backlog = null; }
  const injected = unresolvedInjection(input.home, input.id) || null;
  const injectedPhase = injected ? (harnessQueued(input.home, input.id) ? "harness-queued" : "injected-enter-unconfirmed") : null;
  return { verdict: "ok", parked, spawned, backlog, injected, injectedPhase };
}

export interface ReceiptOptions {
  home: string;
  id: string;
  from: string;
  to: string;
  pane: string;
  kind: string;
  replyExpect: string;
  reason: string;
  policy: string;
  json: boolean;
  /** `TAP_VERBOSE=1`. */
  verbose: boolean;
  /** `tap_send_success_receipt`'s verb: `send`, or `assign` under `TAP_ASSIGN_VERB=1`. */
  verb: "send" | "assign";
  /** The verbose human receipt's readiness token (`tap_spool_display_state`); "" when the caller has none. */
  displayState?: string;
  /** A park the sender must hear about by name (tap-rdy9n); rendered as the queued JSON's `detail`. */
  notice?: string;
}

/**
 * The queued receipt, byte-for-byte the incumbent's: the harness-queued message, the
 * injected-enter-unconfirmed shapes, or the queued shapes (JSON with the backlog and
 * the queue explanation; human with the readiness token and the explanation line).
 * Every value in the JSON is a string, as `tap_json_obj` emitted them.
 */
export function renderParkReceipt(report: ParkReport, o: ReceiptOptions): string {
  const explanation = queueExplanation(o.home, o.id);
  const receipt = (klass: string, detail: string): string =>
    o.verbose ? `tap ${o.verb}: ${detail}\n` : `tap ${o.verb}: ${klass} ${o.id}\n`;
  if (!report.spawned) {
    // The late park failure: the pair is retained and named; no waiter is coming.
    if (o.json) {
      return `${jsonObj({ status: "queued", delivery: "spool", id: o.id, from: o.from, to: o.to, pane: o.pane, kind: o.kind,
        turn: "unconfirmed", path: report.parked.payload, meta: report.parked.meta, reason: "spool_park_failed", action: `tap show ${o.id}` })}\n`;
    }
    return receipt("queued", `accepted, queued ${o.id} for ${o.to}; reply ${o.replyExpect}. Delivery not confirmed. Inspect with tap show ${o.id}.`);
  }
  if (report.injected) {
    if (report.injectedPhase === "harness-queued") return harnessQueueMessage(o.home, o.id, o.json);
    if (o.json) {
      return `${jsonObj({ status: "queued", phase: "injected-enter-unconfirmed", delivery: "spool", id: o.id, from: o.from, to: o.to,
        pane: o.pane, kind: o.kind, turn: "unconfirmed", path: report.parked.payload, queue_explanation: report.injected })}\n`;
    }
    return `${receipt("injected-enter-unconfirmed", `accepted ${o.id} for ${o.to}; ${report.injected}`)}${report.injected}\n`;
  }
  if (o.json) {
    return `${jsonObj({ status: "queued", delivery: "spool", action: "deliver_when_clear_or_deadline",
      id: o.id, from: o.from, to: o.to, pane: o.pane, kind: o.kind, turn: "unconfirmed",
      path: report.parked.payload, meta: report.parked.meta, reason: o.reason, policy: o.policy, deadline_epoch: report.parked.deadlineEpoch,
      spool_backlog: report.backlog?.count ?? "0", spool_backlog_condition: report.backlog?.condition ? "true" : "false",
      queue_explanation: explanation, ...(o.notice ? { detail: o.notice } : {}) })}\n`;
  }
  return `${receipt("queued", `accepted, queued ${o.id} for ${o.to}; reply ${o.replyExpect}. Delivery not confirmed. Inspect with tap show ${o.id}; if it is still unread, tap resend ${o.id} rings it again under the same id. [${o.displayState ?? ""}]`)}${explanation}\n`;
}

// --- CLI (the Bash adapter's door) ---------------------------------------------------------
//   park-report <spool> <home> <id> <canonical> <from> <to> <kind> <reply> <acting> <reason> <timeout>
//               <pane> <pane_id> <to_team> <registry> <policy> <grace> <cue_style> <cue_red_at> <scripts_dir>
//     → ok\n<report json>\n | spool_busy\n<detail>\n | spool_publish_failed\n<detail>\n   (exit 0)
//   park-receipt <home> <report json> <id> <from> <to> <pane> <kind> <reply> <reason> <policy> <json 0|1> <verbose 0|1> <verb> <display-state>
//     → the receipt bytes on stdout (exit 0)
//   flash <home> <pane> <pane_id> <owner_id> <style> <count> [locked]
//   spawn-deliverer <scripts_dir> <home> <spool> <id> [<reown-token>]   → ok | failed
//   clear-verified <pane_id> <server_epoch>                              → yes | no
export function main(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  const [verb, ...rest] = argv;
  const at = (i: number): string => rest[i] ?? "";
  switch (verb) {
    case "notify-backup": {
      if (at(4) === "0") notifyDraftBackedUp(at(0), at(1), at(2), at(3), env);
      return 0;
    }
    case "park-report": {
      if (rest.length !== 20) { process.stderr.write("spool-park-report: park-report expects 20 positional facts\n"); return 2; }
      try {
        const report = parkAndReport({
          spoolDir: at(0), home: at(1), id: at(2), canonical: at(3), from: at(4), target: at(5), kind: at(6), replyExpect: at(7),
          acting: at(8), reason: at(9), timeoutSeconds: at(10), pane: at(11), paneId: at(12), toTeam: at(13), targetRegistry: at(14),
          policy: at(15), graceSeconds: at(16), cueStyle: at(17), cueRedAt: at(18), scriptsDir: at(19), env,
        });
        process.stdout.write(`ok\n${JSON.stringify(report)}\n`);
        return 0;
      } catch (error) {
        if (error instanceof ParkRefusal) { process.stdout.write(`${error.klass}\n${error.message}\n`); return 0; }
        process.stderr.write(`tap: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
    }
    case "park-receipt": {
      if (rest.length !== 14) { process.stderr.write("spool-park-report: park-receipt expects 14 positional facts\n"); return 2; }
      let report: ParkReport;
      try { report = JSON.parse(at(1)) as ParkReport; } catch { process.stderr.write("spool-park-report: report is not JSON\n"); return 2; }
      if (!report || report.verdict !== "ok" || !report.parked) { process.stderr.write("spool-park-report: report is not a park report\n"); return 2; }
      if (at(12) !== "send" && at(12) !== "assign") { process.stderr.write("spool-park-report: verb must be send|assign\n"); return 2; }
      process.stdout.write(renderParkReceipt(report, {
        home: at(0), id: at(2), from: at(3), to: at(4), pane: at(5), kind: at(6), replyExpect: at(7),
        reason: at(8), policy: at(9), json: at(10) === "1", verbose: at(11) === "1", verb: at(12) as "send" | "assign", displayState: at(13),
      }));
      return 0;
    }
    case "flash": {
      if (rest.length < 6) { process.stderr.write("spool-park-report: flash expects <home> <pane> <pane_id> <owner_id> <style> <count> [locked]\n"); return 2; }
      // `count` as the Bash loop read it: "" is the default 1; "0" tints zero times.
      const count = at(5) === "" ? 1 : Number(at(5));
      const input: FlashInput = { home: at(0), pane: at(1), paneId: at(2), ownerId: at(3), style: at(4) || "bg=red", count: Number.isInteger(count) && count >= 0 ? count : 1, env };
      if (at(6) === "locked") flashPaneLocked(input); else flashPane(input);
      return 0;
    }
    case "spawn-deliverer": {
      if (rest.length < 4) { process.stderr.write("spool-park-report: spawn-deliverer expects <scripts_dir> <home> <spool> <id> [<reown-token>]\n"); return 2; }
      const ok = spawnDeliverer({ scriptsDir: at(0), home: at(1), spoolDir: at(2), id: at(3), reownToken: at(4) || undefined, env });
      process.stdout.write(ok ? "ok\n" : "failed\n");
      return 0;
    }
    case "clear-verified": {
      process.stdout.write(paneEffectClearVerified(at(0), at(1), env) ? "yes\n" : "no\n");
      return 0;
    }
    default:
      process.stderr.write("spool-park-report: usage: park-report | park-receipt | flash | spawn-deliverer | clear-verified\n");
      return 2;
  }
}

if (import.meta.main) {
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    process.stderr.write(`tap spool-park-report: stdout ${error.code ?? error.message}\n`);
    process.exitCode = 1;
  });
  process.exitCode = main(Bun.argv.slice(2));
}
