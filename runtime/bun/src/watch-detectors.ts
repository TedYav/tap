import { frontmatterFields, PY_STRIP } from "./payload-fields";
import { contextUsedPercent, pendingInboundAsks } from "./context-census";
// The watch tick's four pane detectors (slice W2a): context pressure, codex
// livelock, codex context-freeze, opencode wedge. Each was a `_watch_process_*`
// loop in tap-watch.sh that walked the roster, read a pane, stepped a per-seat
// sample map kept in the arm record, and sent an advisory. The loops are ported
// statement for statement over a `Seams` object -- every read of the world and
// every effect goes through it -- so the frozen-capture oracle can drive the
// same scripted world through the incumbent (shell function shims) and through
// these runners (a fixture-backed Seams) and compare the outputs and effects.
//
// What stays outside this module, by charter:
//   - the pane READ's seat-state half is seat-state.ts (formerly lib.sh
//     `tap_seat_state`), called in-process -- never a second classifier here; pane-alive and the opencode db reads went native in M6 U1,
//     and the team + machine-index facts followed in M6 U2;
//   - the capture is the incumbent's raw `capture-pane -p` (tmux.ts `capturePane`,
//     unjoined) until B1's `captureInputFrame` is in this branch's ancestry -- that
//     reader joins wrapped rows for every harness but OpenCode, a change in what the
//     detectors see that lands with B1, not here;
//   - the notice/notify sender is watch-notice.ts (spawns the native send via courierArgv).
//
// Grammar (reached from the tick through `_watch_bun_run`):
//   watch-detectors.ts context-pressure <armed_at> <now> <threshold> <exempt>
//   watch-detectors.ts codex-livelock   <armed_at> <now> <threshold> <armed_by> [alerts] [samples]
//   watch-detectors.ts context-freeze   <armed_at> <now> <armed_by> [samples]
//   watch-detectors.ts opencode-wedge   <armed_at> <now> <armed_by> [samples]

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { clearCommand } from "./clear-command";
import { resolveContext, spoolTeamName } from "./context";
import { markerSelectedIndex } from "./index-home";
import { latestOutbound } from "./latest-outbound";
import { opencodeTurnState } from "./opencode-turn-state";
import { type Seat } from "./registry";
import { capturePane, tmuxReadOnly } from "./tmux";
import { registryPanes, seatsOf } from "./watch-registry";
import {
  alertAbsent, alertMark, blockedField, cmdSubst, codexWorkingSeconds, collapseSpinner, freezeStep, hasInk, isMap, loads,
  pressureRemember, pyTypeName, sampleForget, sha256Hex, stripAnsi, withoutWorkingLines,
} from "./watch-detect";
import { fieldValue, isFile, isSettled, readLoose, set as leaseSet } from "./watch-lease";
import { noticeOrNotify, sendNotice, armPath, type NoticeKind } from "./watch-notice";
import { seatState } from "./seat-state";
import { tapScriptsDir } from "./scripts-dir";

// --- the world, as the detectors see it ---------------------------------------------

export interface AgentEntry { pane: string; harness: string; harness_session_id: string }

export interface Seams {
  /** `_watch_roster_handles`: the tick's cached active handles, else the registry's. */
  rosterHandles(): string[];
  /** `tap_registry_agent_json` + the field pick: null when the registry has no such seat. */
  agent(handle: string): AgentEntry | null;
  /** `_watch_tick_resolved_pane`: the pane this tick admitted for the handle, or null. */
  resolvedPane(handle: string): string | null;
  /** `tap_pane_alive` (rc only). */
  paneAlive(pane: string): boolean;
  /** `tmux capture-pane -t <pane> -p`: the raw frame, or null when tmux failed. */
  capture(pane: string, harness: string): string | null;
  /** `_watch_tick_seat_state`. */
  seatState(handle: string): string;
  /** `tap_clear_command <harness>` ("" for an unlisted harness). */
  clearCommand(harness: string): string;
  /** Native shared context gauge over the frame, rendered as a percentage or empty. */
  contextUsed(harness: string, frame: string): string;
  /** `_watch_context_inbox_clear <handle>`: rc 0. */
  inboxClear(handle: string): boolean;
  /** `tap_supervision_oldest_unsettled_inbound <handle> <now>`: `id\tage` or "". */
  oldestUnsettledInbound(handle: string, now: bigint): string;
  /** `tap_supervision_latest_outbound <handle> <now>`: `epoch\tid`, or null when the helper failed. */
  latestOutbound(handle: string, now: bigint): string | null;
  /** `tap_opencode_db_turn_state <session_id>`: its stdout line ("error" when it failed). */
  opencodeDbTurnState(sessionId: string): string;
  /** Read a field from the current watch lease. */
  leaseField(key: string): string;
  /** `[TAP_WATCH_EXPECT_ARMED_AT=<armed_at>] tap_watch_set <key> <value>`: the lease module's status. */
  leaseSet(key: string, value: string, expectArmedAt?: string): number;
  /** `_watch_lease_current <armed_at>`. */
  leaseCurrent(armedAt: string): boolean;
  /** `_watch_send_notice <to> <reason> <evidence> [kind] [--wake]`: 0 when durable. */
  sendNotice(to: string, reason: string, evidence: string, kind: NoticeKind, wake: boolean): number;
  /** `_watch_notice_or_notify <to> <reason> <evidence>`. */
  noticeOrNotify(to: string, reason: string, evidence: string): number;
  /** Diagnostics the incumbent let through to the tick's stderr. */
  stderr(line: string): void;
  /**
   * Keep a corrupt lease field's bytes before the pass overwrites them: the sidecar
   * path they were written to (`arm.json.corrupt-<field>-<now>` beside the lease),
   * or "" when that write failed.
   */
  preserveCorrupt(field: string, raw: string): string;
}

/**
 * A failed `_watch_notice_or_notify` ends the pass with status 1 and no message of
 * its own, and NOTHING is written: the sample keeps `fired: 0`, so the next tick
 * re-evaluates and re-notifies until the alert is durable. That is the `tap watch
 * tick` verb's `set -e` reading of the incumbent; the sidecar loop (`tap_watch_tick
 * || true`, errexit ignored) went on to write the sample as fired and never retried
 * -- a lost alert, not a behavior to keep (leader ruling
 * leader ruling, class A; the rows are in the fixture).
 */
export class TickAbort extends Error {
  constructor() { super("tick aborted"); this.name = "TickAbort"; }
}

/**
 * A lease map field as the pass will use it. "" reads as `{}` (the incumbent's
 * `${x:-{}}`). A CORRUPT value -- unparsable, or readable but not an object -- is
 * announced on one `tap watch:` line naming the field, the reason and the reset,
 * its bytes are kept (verbatim in that line when they fit in 200 bytes, else in a
 * sidecar beside the lease), and the pass proceeds from `{}` and writes the map it
 * computed back over the corrupt value. Neither incumbent shape did this well: the
 * verb died on the python raise every tick until someone edited arm.json, the loop
 * went on with "" and wrote "" back -- an unannounced heal (leader ruling
 * leader ruling, class C: loud, evidence kept, recovered).
 */
export function leaseMap(s: Seams, field: string, raw: string): string {
  if (!raw) return "{}";
  let reason: string | null = null;
  try {
    const v = loads(raw);
    if (!isMap(v)) reason = `a ${pyTypeName(v)}, not an object`;
  } catch {
    reason = "unparsable";
  }
  if (reason === null) return raw;
  const bytes = Buffer.byteLength(raw, "utf8");
  let kept: string;
  if (bytes <= 200) kept = `was: ${JSON.stringify(raw)}`;
  else {
    const path = s.preserveCorrupt(field, raw);
    kept = path ? `${bytes} bytes preserved at ${path}` : `${bytes} bytes; preserving them FAILED, first ${Buffer.byteLength(utf8Prefix(raw, 200), "utf8")} bytes shown: ${JSON.stringify(utf8Prefix(raw, 200))}`;
  }
  s.stderr(`tap watch: lease field ${field} is ${reason}; reset to {} (${kept})`);
  return "{}";
}

/** The longest prefix of `text` that is at most `limit` UTF-8 bytes and ends on a code point. */
export function utf8Prefix(text: string, limit: number): string {
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch, "utf8");
    if (bytes + n > limit) break;
    bytes += n;
    end += ch.length;
  }
  return text.slice(0, end);
}

/** `case "$x" in ''|*[!0-9]*)`: the shell's "is a number" test (ASCII digits only). */
const isDigits = (s: string): boolean => /^[0-9]+$/.test(s);

/** `printf '%s' "$full" | prog` after `full="$( ... )"`: the frame as the pipeline saw it. */
const substituted = (frame: string | null): string | null => (frame === null ? null : cmdSubst(frame));

// --- context pressure -------------------------------------------------------------------

/** `_watch_process_context_pressure <armed-at> <now> <threshold-percent> <comma-exempt-handles>` */
export function contextPressure(armedAt: string, now: bigint, threshold: string, exempt: string, s: Seams): number {
  const before = s.leaseField("context_pressure") || "{}";
  let samples = leaseMap(s, "context_pressure", before);
  const exemptSet = new Set(exempt.split(",").filter((h) => h !== ""));
  for (const handle of s.rosterHandles()) {
    if (!handle) continue;
    if (exemptSet.has(handle)) continue;
    const harness = s.agent(handle)?.harness ?? "";
    let clearCmd: string;
    switch (harness) {
      case "claude": case "codex": case "opencode": clearCmd = s.clearCommand(harness); break;
      default: continue;
    }
    const pane = s.resolvedPane(handle);
    if (!pane) continue;
    const full = substituted(s.capture(pane, harness));
    if (full === null) continue;
    const used = cmdSubst(s.contextUsed(harness, full));
    if (!isDigits(used)) continue;
    // `[ "$used" -lt "$threshold" ]`: bash integer compare (an unparsable threshold errors the tick)
    if (BigInt(used) < shellInt(threshold)) { samples = sampleForget(samples, handle); continue; }
    const prior = blockedField(samples, handle, "pane");
    if (prior === pane) continue;
    if (s.seatState(handle) !== "idle-at-prompt") continue;
    if (!s.inboxClear(handle)) continue;
    if (!s.leaseCurrent(armedAt)) return 0;
    // Recheck after the inbox read; only advise, never inject a harness command.
    if (s.seatState(handle) !== "idle-at-prompt") continue;
    if (!s.leaseCurrent(armedAt)) return 0;
    const rc = s.sendNotice(handle,
      `context-pressure: ${used}% context used (threshold ${threshold}%).`,
      `If you are still idle with no unfinished review or unsettled inbound ask, preserve any standing brief, then use ${clearCmd} to start fresh. If a review has arrived or work remains, defer this notice until after your verdict. After clearing, run tap whoami; run tap in only if offline. This is a notice, not a new work assignment.`,
      "progress", true);
    if (rc === 0) {
      samples = pressureRemember(samples, handle, pane);
      if (s.leaseSet("context_pressure", samples, armedAt) !== 0) return 0;
    }
  }
  if (samples !== before) s.leaseSet("context_pressure", samples, armedAt); // `|| true`
  return 0;
}

/** bash `[ x -lt y ]` operand: a decimal integer with optional sign; anything else is a tick-level error. */
function shellInt(text: string): bigint {
  const t = text.trim();
  if (!/^[+-]?[0-9]+$/.test(t)) throw new Error(`integer expression expected: ${JSON.stringify(text)}`);
  return BigInt(t);
}

// --- codex livelock ---------------------------------------------------------------------

/** `_watch_process_codex_livelock <armed-at> <now> <threshold> <armed-by> [alerts_json] [samples_json]` */
export function codexLivelock(armedAt: string, now: bigint, threshold: string, armedBy: string, alertsArg: string | undefined, samplesArg: string | undefined, s: Seams): number {
  let alerts = alertsArg ?? "";
  if (!alerts) alerts = s.leaseField("livelock_alerts");
  const alertsIn = alerts || "{}";
  alerts = leaseMap(s, "livelock_alerts", alertsIn);
  let samples = samplesArg === undefined ? s.leaseField("livelock_samples") : samplesArg; // `${6:-$(...)}`: an EMPTY sixth arg also reads the lease
  if (samplesArg === "") samples = s.leaseField("livelock_samples");
  const samplesIn = samples || "{}";
  samples = leaseMap(s, "livelock_samples", samplesIn);
  const thresholdN = shellInt(threshold);
  for (const handle of s.rosterHandles()) {
    if (!handle) continue;
    const ent = s.agent(handle);
    if (!ent) continue;
    const harness = ent.harness;
    const pane = s.resolvedPane(handle);
    if (harness !== "codex" || !pane) { samples = sampleForget(samples, handle); continue; }
    if (!s.paneAlive(pane)) { samples = sampleForget(samples, handle); continue; }
    const full = substituted(s.capture(pane, harness)) ?? ""; // `|| true`: a failed capture is an empty frame
    const timer = codexWorkingSeconds(full);
    if (timer === null) { samples = sampleForget(samples, handle); continue; }
    if (timer < thresholdN) { samples = sampleForget(samples, handle); continue; }
    const pending = s.oldestUnsettledInbound(handle, now);
    const [ident = "", age = ""] = pending.split("\t");
    if (!isDigits(age)) { samples = sampleForget(samples, handle); continue; }
    if (BigInt(age) < thresholdN) { samples = sampleForget(samples, handle); continue; }
    const key = `${handle}:${ident}`;
    let absent: boolean;
    try { absent = alertAbsent(alerts, key); } catch { absent = false; } // python raised -> exit 1 -> `|| continue`
    if (!absent) continue;
    const outbound = s.latestOutbound(handle, now) ?? "";
    const outboundAt = outbound.split("\t")[0] ?? "";
    if (!isDigits(outboundAt)) continue;
    const progressKey = `${key}:progress`;
    if (BigInt(outboundAt) > now - BigInt(age) && alertAbsent(alerts, progressKey, true)) {
      // Ordinary NOTE: courier digest only, with no human-notify fallback.
      if (s.sendNotice(armedBy, `codex-progress: '${handle}' has sent progress while inbound '${ident}' remains open`, `latest_outbound=${outbound}`, "progress", false) === 0) {
        // the mark's `json.loads(argv)` had no try/except and its `s[key] = ...` raised on a
        // readable non-dict: the `$( )` assignment failed under set -e AFTER the notice went
        // out, and the function ended with status 1 and no lease write. A thrown error here
        // is that status (R1 renders it), never a swallowed "" (review)
        alerts = alertMark(alerts, progressKey, now, true);
      }
    }
    // Reuse the freeze sampler: strip the animated timer, and treat a new
    // outbound payload as a body change even when pane text is unchanged.
    const bodyContent = cmdSubst(withoutWorkingLines(stripAnsi(full)));
    if (!hasInk(bodyContent)) { samples = sampleForget(samples, handle); continue; }
    const body = sha256Hex(`${bodyContent}\n${outbound}\n${key}\n${pane}`);
    const ctrl = freezeStep(samples, handle, now, body, timer.toString(), thresholdN, true);
    samples = ctrl.samples;
    if (!ctrl.fire) continue;
    const reason = `codex-livelock: '${handle}' has been Working for ${timer}s while inbound '${ident}' is unsettled for ${age}s, with no observed pane or outbound progress for ${ctrl.frozen}s`;
    const evidence = `timer_seconds=${timer}; pending_id=${ident}; pending_age_seconds=${age}; threshold_seconds=${threshold}; no_progress_seconds=${ctrl.frozen}`;
    if (s.noticeOrNotify(armedBy, reason, evidence) !== 0) throw new TickAbort();
    alerts = alertMark(alerts, key, now);
  }
  if (!s.leaseCurrent(armedAt)) return 0;
  // Common path: nothing fired -> map unchanged -> skip the arm-record rewrite fork.
  if (alerts !== alertsIn) s.leaseSet("livelock_alerts", alerts);
  if (samples !== samplesIn) s.leaseSet("livelock_samples", samples);
  return 0;
}

// --- codex context-freeze ---------------------------------------------------------------

/** `_watch_process_context_freeze <armed-at> <now> <armed-by> [<context_freeze_json>]` */
export function contextFreeze(armedAt: string, now: bigint, armedBy: string, samplesArg: string | undefined, s: Seams, env: NodeJS.ProcessEnv = process.env): number {
  const window = envSeconds(env.TAP_WATCH_FREEZE_SECONDS, 300n);
  let samples = samplesArg ?? "";
  if (!samples) samples = s.leaseField("context_freeze");
  const samplesIn = samples || "{}";
  samples = leaseMap(s, "context_freeze", samplesIn);
  for (const handle of s.rosterHandles()) {
    if (!handle) continue;
    const ent = s.agent(handle);
    if (!ent) continue;
    const pane = s.resolvedPane(handle);
    if (ent.harness !== "codex" || !pane) continue;
    if (!s.paneAlive(pane)) continue;
    const frame = s.capture(pane, ent.harness);
    if (frame === null) { samples = sampleForget(samples, handle); continue; } // unread frame: skip the seat (see unreadFrame)
    const full = cmdSubst(stripAnsi(frame));
    const timer = codexWorkingSeconds(full);
    // No live Working timer => not a live turn => forget any baseline for this seat.
    if (timer === null) { samples = sampleForget(samples, handle); continue; }
    const bodyContent = cmdSubst(withoutWorkingLines(full));
    if (!hasInk(bodyContent)) { samples = sampleForget(samples, handle); continue; }
    const body = sha256Hex(bodyContent);
    const ctrl = freezeStep(samples, handle, now, body, timer.toString(), window, true);
    samples = ctrl.samples;
    if (!ctrl.fire) continue;
    const reason = `context-freeze: codex seat '${handle}' Working timer advanced to ${timer}s while context+scrollback stayed frozen for ${ctrl.frozen}s (>= ${window}s; empty-inbox wait-stall)`;
    const evidence = `timer_seconds=${timer}; frozen_seconds=${ctrl.frozen}; window_seconds=${window}; body_sha=${body}`;
    if (s.noticeOrNotify(armedBy, reason, evidence) !== 0) throw new TickAbort();
  }
  if (!s.leaseCurrent(armedAt)) return 0;
  if (samples !== samplesIn) s.leaseSet("context_freeze", samples);
  return 0;
}

// AN UNREAD FRAME SKIPS THE SEAT. `$(tmux capture-pane ... | tap_strip_ansi)` under
// pipefail failed the assignment: the verb shape died there (the whole pass, every
// seat); the loop shape went on with an EMPTY frame -- three fixture rows forgot the
// seat's sample, one (`wedge-capture-fails-db`) RECORDED a sample of the empty frame,
// whose hash is the same every tick the capture keeps failing and fires a false
// wedge advisory after the window. The port forgets the seat's sample and continues
// with the other seats: never a sample of a frame that was not read (leader ruling
// leader ruling, class B).

/** `x="${VAR:-default}"; case "$x" in ''|*[!0-9]*) x=default ;; esac` */
function envSeconds(value: string | undefined, fallback: bigint): bigint {
  const v = value ?? "";
  return isDigits(v) ? BigInt(v) : fallback;
}

// --- opencode wedge -----------------------------------------------------------------------

/** `_watch_process_opencode_wedge <armed-at> <now> <armed-by> [<opencode_wedge_json>]` */
export function opencodeWedge(armedAt: string, now: bigint, armedBy: string, samplesArg: string | undefined, s: Seams, env: NodeJS.ProcessEnv = process.env): number {
  const thresh = envSeconds(env.TAP_WATCH_OPENCODE_WEDGE_SECONDS, 120n);
  let samples = samplesArg ?? "";
  if (!samples) samples = s.leaseField("opencode_wedge");
  const samplesIn = samples || "{}";
  samples = leaseMap(s, "opencode_wedge", samplesIn);
  for (const handle of s.rosterHandles()) {
    if (!handle) continue;
    const ent = s.agent(handle);
    if (!ent) continue;
    const pane = s.resolvedPane(handle);
    if (ent.harness !== "opencode" || !pane) continue;
    if (!s.paneAlive(pane)) continue;
    const sesId = ent.harness_session_id;
    if (sesId) {
      const dbState = s.opencodeDbTurnState(sesId);
      if (dbState === "idle") { samples = sampleForget(samples, handle); continue; }
      if (dbState === "in-turn") {
        const frame = s.capture(pane, ent.harness);
        if (frame === null) { samples = sampleForget(samples, handle); continue; }
        const full = cmdSubst(stripAnsi(frame));
        const body = sha256Hex(collapseSpinner(full));
        const ctrl = freezeStep(samples, handle, now, body, "", thresh, false);
        samples = ctrl.samples;
        if (ctrl.fire) {
          const reason = `opencode-wedge: seat '${handle}' turn active (db: in-turn) but transcript frozen for ${ctrl.frozen}s (>= ${thresh}s) — suspected provider silent-timeout; MANUAL recovery (interrupt+resubmit) by goalie/operator`;
          const evidence = `frozen_seconds=${ctrl.frozen}; threshold_seconds=${thresh}; body_sha=${body}; turn_source=db; session_id=${sesId}; recovery=manual`;
          if (s.noticeOrNotify(armedBy, reason, evidence) !== 0) throw new TickAbort();
        }
        continue;
      }
      // unknown / dirty-end / error: fall through to the TUI fallback
    }
    const frame = s.capture(pane, ent.harness);
    if (frame === null) { samples = sampleForget(samples, handle); continue; }
    const full = cmdSubst(stripAnsi(frame));
    if (!full.includes("esc interrupt")) { samples = sampleForget(samples, handle); continue; } // `grep -q`
    const body = sha256Hex(collapseSpinner(full));
    const ctrl = freezeStep(samples, handle, now, body, "", thresh, false);
    samples = ctrl.samples;
    if (!ctrl.fire) continue;
    const reason = `opencode-wedge: seat '${handle}' turn active but transcript frozen for ${ctrl.frozen}s (>= ${thresh}s) — suspected provider silent-timeout; MANUAL recovery (interrupt+resubmit) by goalie/operator`;
    const evidence = `frozen_seconds=${ctrl.frozen}; threshold_seconds=${thresh}; body_sha=${body}; turn_source=tui-fallback; recovery=manual`;
    if (s.noticeOrNotify(armedBy, reason, evidence) !== 0) throw new TickAbort();
  }
  if (!s.leaseCurrent(armedAt)) return 0;
  if (samples !== samplesIn) s.leaseSet("opencode_wedge", samples);
  return 0;
}

// --- production seams ---------------------------------------------------------------------

function isSeat(v: unknown): v is Seat { return typeof v === "object" && v !== null && !Array.isArray(v); }

export { frontmatterFields } from "./payload-fields";

/**
 * `tap_supervision_oldest_unsettled_inbound <handle> <now>`: the oldest unsettled,
 * non-supervision payload addressed to the handle on the local team, as `id\tage`
 * ("" when the inbox is clear). Transport truth: the payload's mtime is the age clock.
 */
export function oldestUnsettledInbound(payloads: string, receipts: string, handle: string, now: bigint, localTeam: string): string {
  let names: string[];
  try { names = readdirSync(payloads).filter((n) => n.endsWith(".md") && !n.startsWith("_") && !n.startsWith(".")).sort(); } catch { return ""; }
  const pending: Array<{ ident: string; age: bigint; toTeam: string; order: number }> = [];
  let order = 0;
  for (const name of names) {
    const ident = name.slice(0, -3);
    const path = join(payloads, name);
    if (isSettled(receipts, ident)) continue;   // `tap_is_done`: `[ -f ]` on .done or .cancelled (rule 38)
    let meta: Record<string, string>;
    try { meta = frontmatterFields(readFileSync(path, "utf8")); } catch { meta = {}; }
    if (meta.to !== handle || ["probe", "notice", "progress"].includes(meta.kind ?? "")) continue;
    let age: bigint;
    try { age = now - BigInt(Math.trunc(statSync(path).mtimeMs / 1000)); } catch { continue; }
    if (age < 0n) age = 0n;
    pending.push({ ident, age, toTeam: meta.to_team ?? "", order: order++ });
  }
  // `sorted(key=age, reverse=True)` is stable: equal ages keep filename order
  pending.sort((a, b) => (a.age === b.age ? a.order - b.order : a.age > b.age ? -1 : 1));
  for (const row of pending) {
    // tap_target_team_is_local: an empty to_team is local; else it must equal the local team
    if (row.toTeam !== "" && row.toTeam !== localTeam) continue;
    return `${row.ident}\t${row.age}`;
  }
  return "";
}

/**
 * The newest mtime, clamped to `now`, among the canonical payloads and the `.done` receipts
 * that count as team activity -- every payload whose `kind` is not a supervision kind
 * (`probe`, `notice`, `progress`) when no seat is named; with a seat, those it sent or
 * that are addressed to it on the local team. Prints `best`, or "" when `best` is 0.
 * A payload's frontmatter is read once however many receipts name it; an unreadable
 * file has no fields (`frontmatter` returned `{}`), which counts as activity when no
 * seat is named. The mtime is python's `int(os.path.getmtime)`: whole seconds, floor.
 */
export function busActivity(payloads: string, receipts: string, now: bigint, floor: bigint, seat: string, localTeam: string): string {
  const cache = new Map<string, Record<string, string>>();
  const meta = (ident: string): Record<string, string> => {
    let m = cache.get(ident);
    if (m === undefined) {
      try { m = frontmatterFields(readFileSync(join(payloads, `${ident}.md`), "utf8")); } catch { m = {}; }
      cache.set(ident, m);
    }
    return m;
  };
  const relevant = (ident: string): boolean => {
    const m = meta(ident);
    if (["probe", "notice", "progress"].includes(m.kind ?? "")) return false;
    if (!seat) return true;
    if (m.from === seat) return true;
    // addressed_to_local: `to` is the seat and `to_team` is empty or the local team (the
    // field value is already stripped by the parser; the caller's team is stripped here)
    if (m.to !== seat) return false;
    const toTeam = m.to_team ?? "";
    return toTeam === "" || toTeam === localTeam.replace(PY_STRIP, "");
  };
  const mtime = (path: string): bigint | null => {
    try { return statSync(path, { bigint: true }).mtimeNs / 1000000000n; } catch { return null; }
  };
  let best = floor;
  let names: string[] = [];
  // `glob("*.md")` skips dotfiles; `list_payload_paths` then skips drafts (`_*`)
  try { names = readdirSync(payloads).filter((n) => n.endsWith(".md") && !n.startsWith("_") && !n.startsWith(".")).sort(); } catch { names = []; }
  for (const name of names) {
    const t = mtime(join(payloads, name));
    if (t === null) continue; // gone between the listing and the stat: python's getmtime raised and the program printed nothing
    const m = t < now ? t : now;
    if (m > best && relevant(name.slice(0, -3))) best = m;
  }
  let dones: string[] = [];
  try { dones = readdirSync(receipts).filter((n) => n.endsWith(".done") && !n.startsWith(".")); } catch { dones = []; }
  for (const name of dones) {
    const t = mtime(join(receipts, name));
    if (t === null) continue;
    const m = t < now ? t : now;
    if (m > best && relevant(name.slice(0, -5))) best = m;
  }
  return best !== 0n ? String(best) : "";
}

export interface RealSeamsArgs {
  bus: string;
  scripts: string;
  /** The ACTING registry (`tap_acting_registry`), resolved by the caller through C's selector. */
  registry: string;
  env?: NodeJS.ProcessEnv;
  /** The tick's clock string, passed to the notice modules. */
  now: string;
  /**
   * The caller's authority team (`spoolTeamName` over the bridged bus) —
   * the same fact `tap_spool_team_name` carried: the global enrollment key
   * or the genuinely-unenrolled bus-root basename; never the acting
   * registry's own claim.
   * Empty or absent fails closed, exactly as the old empty output did.
   */
  team?: string;
}

/** The production world. */
export function realSeams(a: RealSeamsArgs): Seams {
  const env = a.env ?? process.env;
  const bus = a.bus;
  const arm = armPath(bus);
  const seats = (): Record<string, Seat> | null => {
    // `[ -f registry.json ]` (rule 38, F4); an old-format registry is a said refusal, read as no record.
    return seatsOf(a.registry);
  };
  const tickActive = env.TAP_WATCH_TICK_ACTIVE === "1";
  // M6 U2: `tap_spool_team_name` was C's authority fact (enrollment key, not bus
  // prose), asked once per run. It now rides in as the caller's already-resolved
  // `Selection.team`; the memo is trivially preserved because the answer is fixed
  // per seam instance, and `undefined` (unavailable) fails closed like rc≠0 did.
  const teamName = (): string | null => a.team ?? null;
  const paneAlive = (pane: string): { alive: boolean; id: string } => {
    // M6 U1: the pane-alive read is native. tmux 3.6a answers a dead pane with
    // rc 0 and an EMPTY `#{pane_id}` expansion, so "rc 0 + empty id" is not alive.
    const r = tmuxReadOnly(["display-message", "-p", "-t", pane, "#{pane_id}"], env);
    const id = r.code === 0 ? cmdSubst(r.stdout) : "";
    return { alive: id !== "", id };
  };
  const resolvedPane = (handle: string): string | null => {
    if (tickActive && env.TAP_WATCH_TICK_PANE_RECORDS !== undefined) {
      for (const rec of env.TAP_WATCH_TICK_PANE_RECORDS.split("\n")) {
        const [cachedHandle, cachedPane = "", cachedId = ""] = rec.split("\x1f");
        if (cachedHandle !== handle) continue;
        return cachedId !== "" && paneAlive(cachedPane).id === cachedId ? cachedPane : null;
      }
      return null;
    }
    const pane = registryPanes(a.registry, handle, false)[0] ?? "";
    return pane === "" ? null : pane;
  };
  return {
    rosterHandles: () => {
      if (tickActive && env.TAP_WATCH_TICK_ROSTER_HANDLES !== undefined) return env.TAP_WATCH_TICK_ROSTER_HANDLES.split("\n");
      const m = seats();
      if (!m) return [];
      return Object.entries(m).filter(([, e]) => isSeat(e) && (e.status ?? "active") === "active").map(([h]) => h);
    },
    agent: (handle) => {
      const m = seats();
      const e = m?.[handle];
      if (!m || !isSeat(e)) return null;
      const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
      return { pane: str(e.pane), harness: str(e.harness), harness_session_id: str((e as Record<string, unknown>).harness_session_id) };
    },
    resolvedPane,
    paneAlive: (pane) => paneAlive(pane).alive,
    capture: (pane) => {
      // The incumbent's raw read: `tmux capture-pane -t <pane> -p` -- no -J, for every
      // harness. B1's reader (`captureInputFrame`, which joins wrapped rows for every
      // harness but OpenCode) replaces this seam once B1 is in this branch's ancestry;
      // joining earlier would change the bytes each detector sees (a wrapped Working
      // line the incumbent never matched would start to) without a ratified deviation
      // (partner review A1, a reviewer).
      const r = capturePane(pane, false, false);
      return r.code === 0 ? r.stdout : null;
    },
    seatState: (handle) => {
      // `_watch_tick_seat_state`: resolve first; no pane -> "unknown" without asking
      const pane = resolvedPane(handle);
      if (pane === null) return "unknown";
      return seatState(handle, { registry: a.registry, home: bus, pane, env });
    },
    clearCommand: (harness) => clearCommand(harness),
    contextUsed: (harness, frame) => {
      const value = contextUsedPercent(harness, frame);
      return value === null ? "" : String(value);
    },
    inboxClear: (handle) => {
      // M6 U2: `tap_authority_index_file` was C's marker-selected machine index;
      // `markerSelectedIndex` names global-registry.json only when live; an
      // absent or invalid marker names no path and fails closed.
      const index = markerSelectedIndex(env.TAP_INDEX_HOME);
      if (index.marker !== "live") return false;
      const t = teamName();
      if (t === null) return false;
      return pendingInboundAsks(bus, index.path, t, [handle])[handle] === false;
    },
    oldestUnsettledInbound: (handle, now) =>
      oldestUnsettledInbound(env.TAP_PAYLOADS ?? join(bus, "payloads"), env.TAP_RECEIPTS ?? join(bus, "receipts"), handle, now, teamName() ?? ""),
    latestOutbound: (handle, now) => {
      const t = teamName();
      if (t === null) return null;
      try {
        const row = latestOutbound(env.TAP_PAYLOADS ?? join(bus, "payloads"), env.TAP_SPOOL ?? join(bus, "spool"), t, Number(now))[handle] ?? { epoch: 0, id: "" };
        return `${row.epoch}\t${row.id}`;
      } catch { return null; }
    },
    opencodeDbTurnState: (sessionId) => opencodeTurnState(sessionId, env),
    leaseField: (key) => fieldValue(readLoose(arm), key),
    leaseSet: (key, value, expectArmedAt) => {
      try { return leaseSet(arm, [key, value], expectArmedAt === undefined ? env : { ...env, TAP_WATCH_EXPECT_ARMED_AT: expectArmedAt }); } catch (error) {
        process.stderr.write(`tap watch: ${(error as Error).message}\n`);
        return 1;
      }
    },
    leaseCurrent: (armedAt) => isFile(arm) && fieldValue(readLoose(arm), "armed_at") === armedAt,
    sendNotice: (to, reason, evidence, kind, wake) => sendNotice({ bus, scripts: a.scripts, to, reason, evidence, kind, wake, env }),
    noticeOrNotify: (to, reason, evidence) => noticeOrNotify({ bus, scripts: a.scripts, to, reason, evidence, now: a.now, env }),
    stderr: (line) => process.stderr.write(`${line}\n`),
    preserveCorrupt: (field, raw) => {
      const path = `${arm}.corrupt-${field}-${a.now}`;
      try { writeFileSync(path, raw); return path; } catch { return ""; }
    },
  };
}

// --- CLI ---------------------------------------------------------------------------------

export function main(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  const [verb, ...rest] = argv;
  // The bus and the ACTING registry are facts the tick already resolved (it
  // cached `tap_acting_registry` at cycle start) and passes in; a detector
  // never resolves authority a second time in a child. The team is the pure
  // authority mapping over those facts (`spoolTeamName`, one owner in
  // context.ts), so the bridge needs no team fact of its own. A direct
  // invocation without them goes through C's selector, as the verbs do.
  let bus: string;
  let registry: string;
  if (env.TAP_WATCH_DETECT_BUS !== undefined) {
    // an EMPTY registry fact is what the tick holds when `tap_acting_registry` failed
    // (a corrupt machine index): the incumbent then found no seat entry for anyone
    // and skipped every seat -- so does this, rather than refusing the whole tick
    bus = env.TAP_WATCH_DETECT_BUS;
    registry = env.TAP_WATCH_DETECT_REGISTRY ?? "";
  } else {
    const ctx = resolveContext(process.cwd(), env);
    bus = ctx.bus.home;
    registry = ctx.registryPath;
  }
  const team = spoolTeamName(bus, env.TAP_INDEX_HOME);
  const scripts = tapScriptsDir();
  const world = (now: string): Seams => realSeams({ bus, scripts, registry, env, now, team });
  const need = (n: number, usage: string): void => { if (rest.length < n) throw new Error(`usage: watch-detectors.ts ${usage}`); };
  const clock = (text: string): bigint => { if (!isDigits(text)) throw new Error(`now must be an integer: ${JSON.stringify(text)}`); return BigInt(text); };
  switch (verb) {
    case "context-pressure": {
      need(4, "context-pressure <armed_at> <now> <threshold> <exempt>");
      const [armedAt, now, threshold, exempt] = rest as [string, string, string, string];
      return contextPressure(armedAt, clock(now), threshold, exempt, world(now));
    }
    case "codex-livelock": {
      need(4, "codex-livelock <armed_at> <now> <threshold> <armed_by> [alerts] [samples]");
      const [armedAt, now, threshold, armedBy, alerts, samples] = rest as [string, string, string, string, string?, string?];
      return codexLivelock(armedAt, clock(now), threshold, armedBy, alerts, samples, world(now));
    }
    case "context-freeze": {
      need(3, "context-freeze <armed_at> <now> <armed_by> [samples]");
      const [armedAt, now, armedBy, samples] = rest as [string, string, string, string?];
      return contextFreeze(armedAt, clock(now), armedBy, samples, world(now), env);
    }
    case "opencode-wedge": {
      need(3, "opencode-wedge <armed_at> <now> <armed_by> [samples]");
      const [armedAt, now, armedBy, samples] = rest as [string, string, string, string?];
      return opencodeWedge(armedAt, clock(now), armedBy, samples, world(now), env);
    }
    default:
      throw new Error(`watch-detectors.ts: unknown detector ${JSON.stringify(verb ?? "")}`);
  }
}

if (import.meta.main) {
  try { process.exit(main(process.argv.slice(2))); } catch (error) {
    if (!(error instanceof TickAbort)) process.stderr.write(`tap watch: ${(error as Error).message}\n`);
    if (process.env.TAP_VERBOSE === "1" && (error as Error).stack) process.stderr.write(`${(error as Error).stack}\n`);
    process.exit(1);
  }
}
