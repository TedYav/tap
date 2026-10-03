// Pure planning/classification/receipt surface for the team stop engine
// (U1 of the libsh-bun TeamStop ladder, tap-1e213). Port of the decision and
// rendering arms of `team_runtime_stop` and `_tap_team_stop_*` in
// skills/tap/scripts/tap-team-stop.sh at head abc184510b761c555a08c417b4005805e5044a0b:
// flag parse (L1533-1562), pass-0 (L1746-1775), pass-1 spare sets (L1802-1867),
// row classification (L1870-1926), `_tap_team_stop_classify_nokill` (L1107-1125),
// plan/dry-run text (L2057-2133), `_tap_team_stop_emit_json` (L1030-1102),
// receipt text (L2698-2865) and the exit-code rule (L3121-3123).
// No IO: tmux/registry/queue observations arrive injected, so U4 composes and
// tests run offline. No production importer until the U4 cutover.

import { TapError } from "../context";
import { ensureAscii } from "../fsatomic";
import {
  codePointCompare,
  parseSelection,
  selectAny,
  selectConflictGate,
  selectFlag,
  selectLabel,
  selectOperand,
  selectSummary,
  selectTyped,
  spared,
  type Selection,
} from "./selection";
import {
  destructiveSessionTarget,
  type DestructiveRefuseReason,
  type LifecycleTmux,
} from "../lifecycle-target";

export type StopVerb = "down" | "shutdown" | "reset-stop";
export type RegistryPolicy = "suspend" | "clear" | "none";

export interface ParsedStopArgs {
  wantJson: boolean;
  dryRun: boolean;
  keepSelf: boolean;
  killSelf: boolean;
  selection: Selection;
}

export function parseStopArgs(verb: StopVerb, argv: readonly string[]): ParsedStopArgs {
  let wantJson = false;
  let dryRun = false;
  let keepSelf = false;
  let killSelf = false;
  let exceptRaw: string | null = null;
  let onlyRaw: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--json":
        wantJson = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--yes":
      case "--force":
        break;
      case "--keep-self":
        keepSelf = true;
        break;
      case "--kill-self":
        killSelf = true;
        break;
      case "--except":
        if (i + 1 >= argv.length) {
          throw new TapError(
            1,
            "usage_error",
            `tap team ${verb} --except <handle>[,<handle>...]`,
            "--except was given no value; name at least one handle to spare",
          );
        }
        exceptRaw = argv[i + 1]!;
        i++;
        break;
      case "--only":
        if (i + 1 >= argv.length) {
          throw new TapError(
            1,
            "usage_error",
            `tap team ${verb} --only <handle>[,<handle>...]`,
            "--only was given no value; name at least one handle to act on",
          );
        }
        onlyRaw = argv[i + 1]!;
        i++;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new TapError(1, "unknown_option", `tap help team ${verb}`, `unknown option '${arg}'`);
        }
        throw new TapError(1, "usage_error", `tap help team ${verb}`, `unexpected arg '${arg}'`);
    }
  }
  if (exceptRaw !== null && onlyRaw !== null) selectConflictGate(`team ${verb}`);
  if (verb === "reset-stop" && !killSelf) keepSelf = true;
  const selection: Selection =
    exceptRaw !== null
      ? parseSelection(`team ${verb}`, exceptRaw, "--except")
      : onlyRaw !== null
        ? parseSelection(`team ${verb}`, onlyRaw, "--only")
        : { mode: "", except: [], only: [] };
  return { wantJson, dryRun, keepSelf, killSelf, selection };
}

export interface StopRow {
  handle: string;
  delivery: string;
  pane: string;
  paneId: string;
  serverEpoch: string;
  session: string;
  status: string;
  statusReason: string;
  crew: boolean;
}

export type NokillReason = "poll" | "unseated" | "unverified_unbound" | DestructiveRefuseReason;

export interface NokillEntry {
  handle: string;
  reason: NokillReason;
}

export interface SpareEntry {
  handle: string;
  why: "excepted" | "shared_session";
  session: string;
}

export interface SeatEntry {
  session: string;
  handle: string;
  paneId: string;
  rowSession: string;
  serverEpoch: string;
  expected: string;
}

export function parseRowDump(dump: string): { team: string; rows: StopRow[] } {
  const lines = dump.split("\n");
  const team = lines[0] ?? "";
  const rows: StopRow[] = [];
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const f = line.split("\x1f");
    rows.push({
      handle: f[0] ?? "",
      delivery: f[1] || "pane",
      pane: f[2] ?? "",
      paneId: f[3] ?? "",
      serverEpoch: f[4] ?? "",
      session: f[5] ?? "",
      status: f[6] ?? "",
      statusReason: f[7] ?? "",
      crew: f[8] === "1",
    });
  }
  return { team, rows };
}

export function classifyNokill(entries: readonly NokillEntry[]): {
  retainedPoll: string[];
  refusedHandles: string[];
  pollN: number;
  unverifiedN: number;
} {
  const retainedPoll: string[] = [];
  const refusedHandles: string[] = [];
  for (const { handle, reason } of entries) {
    if (!handle) continue;
    if (reason === "poll" || reason === "unseated") retainedPoll.push(handle);
    else refusedHandles.push(handle);
  }
  return { retainedPoll, refusedHandles, pollN: retainedPoll.length, unverifiedN: refusedHandles.length };
}

export interface ClassifyContext {
  team: string;
  selection: Selection;
  sparedSessions: ReadonlySet<string>;
  selfSession: string;
  tmux: LifecycleTmux;
}

export interface ClassifyResult {
  seatmap: SeatEntry[];
  selfmap: SeatEntry[];
  nokill: NokillEntry[];
  sparemap: SpareEntry[];
  sparedRows: number;
}

export function classifyTeamRows(rows: readonly StopRow[], ctx: ClassifyContext): ClassifyResult {
  const result: ClassifyResult = { seatmap: [], selfmap: [], nokill: [], sparemap: [], sparedRows: 0 };
  for (const row of rows) {
    if (!row.handle) continue;
    if (spared(row.handle, ctx.selection)) {
      result.sparemap.push({ handle: row.handle, why: "excepted", session: row.session });
      result.sparedRows++;
      continue;
    }
    if (row.delivery === "poll") {
      result.nokill.push({ handle: row.handle, reason: "poll" });
      continue;
    }
    if (!row.paneId && !row.pane) {
      if (row.status === "suspended" || row.status === "exited") {
        result.nokill.push({ handle: row.handle, reason: "unseated" });
      } else {
        result.nokill.push({ handle: row.handle, reason: "unverified_unbound" });
      }
      continue;
    }
    const expected = row.session || (ctx.team ? `${ctx.team}/${row.handle}` : "");
    if (expected && ctx.sparedSessions.has(expected)) {
      result.sparemap.push({ handle: row.handle, why: "shared_session", session: expected });
      result.sparedRows++;
      continue;
    }
    const decision = destructiveSessionTarget({ pane_id: row.paneId, session: row.session }, expected, ctx.tmux);
    if (!decision.ok) {
      result.nokill.push({ handle: row.handle, reason: decision.reason });
      continue;
    }
    const entry: SeatEntry = {
      session: decision.session,
      handle: row.handle,
      paneId: row.paneId,
      rowSession: row.session,
      serverEpoch: row.serverEpoch,
      expected,
    };
    if (ctx.selfSession && decision.session === ctx.selfSession) result.selfmap.push(entry);
    else result.seatmap.push(entry);
  }
  return result;
}

export function passZeroAllSpared(rows: readonly StopRow[], selection: Selection): boolean {
  if (!selectAny(selection)) return false;
  return rows.filter(r => r.handle.length > 0).every(r => spared(r.handle, selection));
}

export function passZeroSpareSets(rows: readonly StopRow[]): { excludedHandles: string[]; sparedSessions: string[] } {
  const excludedHandles: string[] = [];
  const sparedSessions: string[] = [];
  for (const row of rows) {
    if (!row.handle) continue;
    excludedHandles.push(row.handle);
    if (row.session && !sparedSessions.includes(row.session)) sparedSessions.push(row.session);
  }
  return { excludedHandles, sparedSessions };
}

export function buildSpareSets(
  rows: readonly StopRow[],
  selection: Selection,
  observe: (target: string) => string | null,
  verb: StopVerb,
): { sparedSessions: string[]; sparedHandles: string[] } {
  const sparedSessions: string[] = [];
  const sparedHandles: string[] = [];
  if (!selectAny(selection)) return { sparedSessions, sparedHandles };
  for (const row of rows) {
    if (!row.handle) continue;
    if (!spared(row.handle, selection)) continue;
    if (row.crew) {
      pushUnique(sparedHandles, row.handle);
      continue;
    }
    let key = "";
    if (row.delivery !== "poll") {
      if (row.session) key = row.session;
      else {
        const target = row.paneId || row.pane;
        const observed = target ? observe(target) : null;
        if (observed === null) {
          throw new TapError(
            1,
            "unobservable_spare",
            "tap doctor",
            `seat '${row.handle}' is a spared pane row with no stored session, and its current session could not be positively observed — refusing the destructive selection rather than risk stopping a session this operator asked to spare`,
          );
        }
        key = secondTabField(observed);
      }
    }
    pushUnique(sparedHandles, row.handle);
    if (key) pushUnique(sparedSessions, key);
  }
  return { sparedSessions, sparedHandles };
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

function secondTabField(observed: string): string {
  const afterFirst = observed.slice(observed.indexOf("\t") + 1);
  const tab = afterFirst.indexOf("\t");
  return tab === -1 ? afterFirst : afterFirst.slice(0, tab);
}

export function teammateSessionsOf(seatmap: readonly SeatEntry[]): string[] {
  const names = [...new Set(seatmap.map(e => e.session))].sort(codePointCompare);
  return names.filter(n => n.length > 0);
}

function handlesFor(seatmap: readonly SeatEntry[], session: string): string {
  return seatmap.filter(e => e.session === session).map(e => e.handle).join(" ");
}

function pad24(s: string): string {
  return s.length >= 24 ? s : s + " ".repeat(24 - s.length);
}

export interface PlanTextInput {
  verb: StopVerb;
  team: string;
  registryPolicy: RegistryPolicy;
  selection: Selection;
  teammateSessions: readonly string[];
  selfSession: string;
  selfPresent: boolean;
  keepSelf: boolean;
  seatmap: readonly SeatEntry[];
  selfmap: readonly SeatEntry[];
  nokill: readonly NokillEntry[];
  sparemap: readonly SpareEntry[];
  unsettled: number;
  paneCount(session: string): number;
}

export function renderPlanText(input: PlanTextInput): string {
  const lines: string[] = [];
  lines.push(`tap team ${input.verb}: plan for team '${input.team || "(unnamed)"}'`);
  for (const s of input.teammateSessions) {
    if (!s) continue;
    const n = input.paneCount(s);
    lines.push(`  kill session ${pad24(s)} (${n} pane${n === 1 ? "" : "s"})  seats: ${handlesFor(input.seatmap, s)}`);
  }
  if (input.selfPresent && input.selfSession) {
    const n = input.paneCount(input.selfSession);
    const seats = handlesFor(input.selfmap, input.selfSession);
    if (input.keepSelf) {
      lines.push(`  keep  session ${pad24(input.selfSession)} (${n} pane${n === 1 ? "" : "s"})  seats: ${seats}  [SELF — kept]`);
    } else {
      lines.push(`  kill session ${pad24(input.selfSession)} (${n} pane${n === 1 ? "" : "s"})  seats: ${seats}  [SELF — killed last]`);
    }
  }
  let pollLine = "";
  let refuseLine = "";
  for (const { handle, reason } of input.nokill) {
    if (reason === "poll" || reason === "unseated") pollLine = pollLine ? `${pollLine}, ${handle} (${reason})` : `${handle} (${reason})`;
    else refuseLine = refuseLine ? `${refuseLine}, ${handle} (${reason})` : `${handle} (${reason})`;
  }
  if (pollLine) {
    lines.push(
      input.registryPolicy === "clear"
        ? `  retained poll (unregister only): ${pollLine}`
        : `  retained poll (rows unchanged): ${pollLine}`,
    );
  }
  if (refuseLine) lines.push(`  refused unverified pane (rows retained; possible live target): ${refuseLine}`);
  if (input.sparemap.length > 0) {
    const spareLine = input.sparemap
      .filter(e => e.handle)
      .map(e => `${e.handle} (${e.why}${e.session ? `: ${e.session}` : ""})`)
      .join(", ");
    if (input.selection.mode === "--only") {
      lines.push(`  spared by ${selectLabel(input.selection)} (rows unchanged, the complement — not a typed set): ${spareLine}`);
    } else {
      lines.push(`  spared by ${selectLabel(input.selection)} (rows unchanged): ${spareLine}`);
    }
  }
  if (input.unsettled > 0) {
    lines.push(`  ${input.unsettled} unsettled payload(s) on the bus — ${input.verb} leaves them un-answered (warn, not blocking)`);
  }
  return `${lines.join("\n")}\n`;
}

export function dryRunText(verb: StopVerb): string {
  return `tap team ${verb}: dry-run — nothing killed, registry unchanged`;
}

export function zeroRowText(
  verb: StopVerb,
  registryPolicy: RegistryPolicy,
  opts: { dryRun: boolean; registryPresent?: boolean },
): string {
  if (registryPolicy === "clear") {
    if (opts.dryRun) return `tap team ${verb}: dry-run — would delete blank acting registry (no seats)`;
    if (opts.registryPresent) return `tap team ${verb}: deleted blank acting registry (no seats); next: tap init`;
    return `tap team ${verb}: no agents registered — nothing to shut down`;
  }
  if (verb === "down") return `tap team down: no agents registered — nothing to stop`;
  return `tap team ${verb}: no agents registered — nothing to shut down`;
}

export function noSeatsMatchedText(verb: StopVerb, selection: Selection): string {
  return `tap team ${verb}: no seats matched after ${selectSummary(selection)}`;
}

export interface StopReceiptJsonInput {
  team: string;
  teammateSessions: readonly string[];
  selfSession: string;
  selfPresent: boolean;
  keepSelf: boolean;
  dryRun: boolean;
  unsettled: number;
  registryPolicy: RegistryPolicy;
  stoppedSessions?: readonly string[];
  refusedSessions?: readonly string[];
  refusedHandles?: readonly string[];
  retainedPoll?: readonly string[];
  pendingSelfKill?: string;
  excludedHandles?: readonly string[];
  sparedSessions?: readonly string[];
  recoveryPath?: string;
}

export function renderStopReceiptJson(input: StopReceiptJsonInput): string {
  const stopped = [...(input.stoppedSessions ?? [])];
  const refused = [...(input.refusedSessions ?? [])];
  const refusedHandles = [...(input.refusedHandles ?? [])];
  const planned = [...input.teammateSessions];
  if (input.selfPresent && input.selfSession && !input.keepSelf) planned.push(input.selfSession);
  const out: Record<string, unknown> = {
    team: input.team || null,
    killed_sessions: input.dryRun ? planned : stopped,
    stopped_sessions: input.dryRun ? planned : stopped,
    refused_sessions: refused,
    refused_handles: refusedHandles,
    retained_poll: [...(input.retainedPoll ?? [])],
    excluded_handles: [...(input.excludedHandles ?? [])],
    spared_sessions: [...(input.sparedSessions ?? [])],
    self_session: input.selfSession || null,
    pending_self_kill: input.pendingSelfKill || null,
    kept_self: input.keepSelf,
    dry_run: input.dryRun,
    unsettled_payloads: input.unsettled,
    registry_policy: input.registryPolicy,
    partial: refused.length > 0 || refusedHandles.length > 0,
  };
  if (input.recoveryPath) {
    out.recovery_pending = true;
    out.recovery_path = input.recoveryPath;
    out.recovery_hint = "registry row not restored; the captured row is retained at recovery_path";
  }
  return ensureAscii(JSON.stringify(out));
}

export function selfNote(input: {
  selfSession: string;
  selfPresent: boolean;
  keepSelf?: boolean;
  selfAuthRefused?: boolean;
}): string {
  if (!input.selfPresent || !input.selfSession) return "";
  if (input.keepSelf) return ` (kept self '${input.selfSession}')`;
  if (input.selfAuthRefused) return ` (self '${input.selfSession}' REFUSED — an unselected seat shares it)`;
  return ` (self '${input.selfSession}' next)`;
}

export interface ReceiptTextInput {
  verb: StopVerb;
  registryPolicy: RegistryPolicy;
  registryPresent: boolean;
  killedCount: number;
  selfNote: string;
  pollN: number;
  refusedCount: number;
}

export function renderReceiptLines(input: ReceiptTextInput): string[] {
  const lines: string[] = [];
  if (input.registryPolicy === "clear") {
    lines.push(
      input.registryPresent
        ? `tap team ${input.verb}: killed ${input.killedCount} teammate session(s), cleared registry${input.selfNote}`
        : `tap team ${input.verb}: killed ${input.killedCount} teammate session(s), deleted registry${input.selfNote}`,
    );
  } else if (input.registryPolicy === "suspend") {
    lines.push(`tap team ${input.verb}: stopped ${input.killedCount} teammate session(s), suspended their seats${input.selfNote}`);
    if (input.pollN > 0) lines.push(`tap team ${input.verb}: retained ${input.pollN} poll seat(s) unchanged`);
    if (input.refusedCount > 0) {
      lines.push(`tap team ${input.verb}: ${input.killedCount} stopped, ${input.refusedCount} refused — the team is now partially down`);
    }
  } else {
    lines.push(`tap team ${input.verb}: stopped ${input.killedCount} teammate session(s)${input.selfNote}`);
  }
  return lines;
}

export function partiallyDownLine(
  verb: StopVerb,
  killedCount: number,
  refusedCount: number,
  suffix: "self-refused" | "self-failed",
): string {
  const tail = suffix === "self-refused" ? " (self kill refused: an unselected seat shares that session)" : " (self kill failed)";
  return `tap team ${verb}: ${killedCount} stopped, ${refusedCount} refused — the team is now partially down${tail}`;
}

export interface SpareReceiptInput {
  verb: StopVerb;
  selection: Selection;
  excludedHandles: readonly string[];
  sparedRows: number;
  keepSelf: boolean;
  keepSelfRows: number;
}

export function renderSpareReceiptLines(input: SpareReceiptInput): string[] {
  const unionRows = input.excludedHandles.length;
  const ksRows = input.keepSelf ? input.keepSelfRows : 0;
  let lateRows = unionRows - input.sparedRows - ksRows;
  if (lateRows < 0) lateRows = 0;
  const only = input.selection.mode === "--only";
  // The count and the names come from one list, so they cannot disagree. The
  // typed selector stays visible in front; this tail adds every seat actually
  // spared (co-tenants, keep-self, late registrations) unless the typed
  // `--except` list already says exactly that.
  const typed = new Set(input.selection.except);
  const sameAsTyped = !only && typed.size === unionRows && input.excludedHandles.every((h) => typed.has(h));
  const names = unionRows > 0 && !sameAsTyped ? ` (spared: ${input.excludedHandles.join(", ")})` : "";
  if (input.sparedRows > 0) {
    let note = "";
    if (ksRows > 0) note += " (includes --keep-self)";
    if (lateRows > 0) note += ` (includes ${lateRows} registered late)`;
    return [
      `tap team ${input.verb}: spared ${unionRows} seat(s) by ${selectFlag(input.selection)}${selectOperand(input.selection)}${note}${names}`,
    ];
  }
  if (unionRows > 0 && only && ksRows > 0 && lateRows <= 0) {
    return [`tap team ${input.verb}: --only ${selectTyped(input.selection)} matched every seat; ${unionRows} spared by --keep-self${names}`];
  }
  if (unionRows > 0 && only) {
    const causeNote = ksRows > 0 ? `${ksRows} by --keep-self, ${lateRows} registered late` : `${lateRows} registered late`;
    return [`tap team ${input.verb}: --only ${selectTyped(input.selection)} matched every seat at plan time; ${unionRows} spared (${causeNote})${names}`];
  }
  if (only) {
    return [`tap team ${input.verb}: --only ${selectTyped(input.selection)} matched every seat — none spared`];
  }
  return [];
}

export function stopExitCode(input: { restoreFailed: boolean; refusedCount: number; unrecordedCount: number }): 0 | 1 {
  if (input.restoreFailed || input.refusedCount > 0 || input.unrecordedCount > 0) return 1;
  return 0;
}
