// `tap nudge --harness <h> [--team <t|*>]` (tap-s1k5j, tap-xe42x): run the single-seat nudge ladder on every
// live seat of one harness family. Each seat gets the same rungs and the same default doorbell as `tap nudge <peer>`.

import { TapError } from "../context";
import { AGENT_FAMILIES } from "../harness-families";
import { globalRegistryPath, readIndexJson } from "../index-home";
import { nudgeMessageRefusal, nudgeDoorbellText, renderNudgeWire } from "../nudge-wire";
import { existsSync } from "node:fs";
import { harnessEvidence } from "../readiness-stall";
import { loadRegistry, seatMap } from "../registry";
import { withAgentStates } from "../roster-observation";
import { formatAge } from "../roster-activity";
import { tmuxReadOnly } from "../tmux";
import { observe, observedRows, readRegistry, type ObservedRow, type RegistryRow } from "./team";

const USAGE = "tap help nudge";
/** A fan-out wider than this, or any `--team '*'`, needs `--yes` or a TTY confirmation. */
export const CONFIRM_ABOVE = 1;

export interface FanoutArgs {
  harness: string; team: string; message: string; interrupt: boolean; dryRun: boolean; yes: boolean;
  /** `--active-within <dur>`: nudge only seats whose harness shows activity this recently; null nudges every live seat. */
  activeWithin: { seconds: number; text: string } | null;
  recentlyWorking: { seconds: number; text: string } | null;
  all: boolean;
}

/** True when any of `flags` appears in flag position; a valued flag consumes the next token first. */
export function flagPresent(argv: readonly string[], flags: readonly string[]): boolean {
  const valued = new Set(["--message", "--to", "--pane", "--harness", "--team", "--active-within"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (flags.includes(arg)) return true;
    if (valued.has(arg)) i++;
  }
  return false;
}

export function isFanoutArgv(argv: readonly string[]): boolean {
  return flagPresent(argv, ["--harness", "--team"]);
}

export function parseFanoutArgs(argv: readonly string[]): FanoutArgs {
  const out: FanoutArgs = { harness: "", team: "", message: "", interrupt: true, dryRun: false, yes: false, activeWithin: null, recentlyWorking: null, all: false };
  const value = (i: number, flag: string): string => {
    const next = argv[i + 1];
    if (next === undefined || next === "") throw new TapError(1, "usage_error", USAGE, `${flag} needs a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--recently-working=")) {
      const text = arg.slice("--recently-working=".length);
      out.recentlyWorking = {seconds: activeWithinSeconds(text, "--recently-working"), text}; continue;
    }
    switch (arg) {
      case "--harness": out.harness = value(i, arg); i++; break;
      case "--team": out.team = value(i, arg); i++; break;
      case "--message": out.message = value(i, arg); i++; break;
      case "--all": out.all = true; break;
      case "--recently-working": out.recentlyWorking = {seconds:120,text:"2m"}; break;
      case "--no-interrupt": out.interrupt = false; break;
      case "--active-within": { const text = value(i, arg); out.activeWithin = { seconds: activeWithinSeconds(text), text }; i++; break; }
      case "--to": throw new TapError(1, "usage_error", USAGE, "the --harness fan-out form selects its seats by family; nudge one peer with tap nudge <peer>");
      case "--pane": throw new TapError(1, "usage_error", USAGE, "the --harness fan-out form nudges registered seats only; --pane is not available");
      case "--dry-run": out.dryRun = true; break;
      case "--yes": out.yes = true; break;
      default:
        if (arg.startsWith("-")) throw new TapError(1, "unknown_option", USAGE, `unknown option '${arg}' for the --harness fan-out form`);
        throw new TapError(1, "usage_error", USAGE, `'${arg}': the --harness fan-out form takes no peer; use 'tap nudge ${arg}' for one seat`);
    }
  }
  if (out.harness === "") throw new TapError(1, "usage_error", USAGE, "--harness is required for the fan-out form (e.g. tap nudge --harness codex --team '*')");
  if (!AGENT_FAMILIES.has(out.harness)) {
    throw new TapError(1, "usage_error", USAGE, `unknown harness '${out.harness}' (one of: ${[...AGENT_FAMILIES].join(", ")})`);
  }
  if ([out.all, out.recentlyWorking !== null, out.activeWithin !== null].filter(Boolean).length > 1)
    throw new TapError(1, "usage_error", USAGE, "--all, --recently-working and --active-within cannot be combined");
  const refusal = out.message === "" ? null : nudgeMessageRefusal(out.message);
  if (refusal) throw new TapError(1, "usage_error", "tap send <peer> -f <file> for anything longer or multi-line", `${refusal}; use tap send; nothing sent`);
  try { nudgeDoorbellText(out.message); }
  catch (error) { throw new TapError(1, "usage_error", USAGE, String((error as Error).message)); }
  return out;
}

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** A duration that names its unit (`90s`, `30m`, `2h`, `1d`), like `tap bus archive --older-than 7d`. A bare number
 * is refused rather than guessed: `30` meant as minutes would silently nudge nobody. */
export function activeWithinSeconds(raw: string, flag = "--active-within"): number {
  const match = /^([1-9]\d*)([smhd])$/.exec(raw);
  const seconds = match ? Number(match[1]) * UNIT_SECONDS[match[2]!]! : NaN;
  if (Number.isSafeInteger(seconds)) return seconds;
  const hint = /^[1-9]\d*$/.test(raw) ? ` (add a unit: ${raw}s for seconds, ${raw}m for minutes)` : "";
  throw new TapError(1, "usage_error", USAGE, `${flag} needs a duration with a unit (s, m, h or d), e.g. 30m or 2h; got '${raw}'${hint}`);
}

export type Verdict = { kind: "target" } | { kind: "skip"; reason: string };

const familyOf = (harness: string) => new RegExp(`^${harness}(?:-|$)`);

/** Pure seat filter: `row` is the roster's observed row, exactly what `tap team` prints. */
export function verdict(row: ObservedRow, team: string, harness: string, self: { team: string; handle: string }): Verdict | null {
  if (!familyOf(harness).test(row.harness)) return null;
  if (team === self.team && row.handle === self.handle) return { kind: "skip", reason: "self" };
  if (row.delivery === "poll") return { kind: "skip", reason: "poll-mode (discovers work via tap poll)" };
  if (row.status !== "active") return { kind: "skip", reason: `${row.status}${row.statusReason ? ` (${row.statusReason})` : ""}` };
  return { kind: "target" };
}

/** Automatic selection requires positive state or dated turn evidence, never transcript mtime. */
export function stateVerdict(row: ObservedRow, now: number, recent: FanoutArgs["recentlyWorking"]): Verdict {
  if (row.agentState === "error" || row.agentState === "blocked") return {kind:"target"};
  if (recent && row.agentState === "working") return {kind:"target"};
  if (recent && (row.agentState === "idle" || row.agentState === "waiting")) {
    const ended = row.turnEndedAt;
    if (typeof ended === "number" && Number.isFinite(ended) && ended <= now && now - ended <= recent.seconds) return {kind:"target"};
  }
  return {kind:"skip",reason: recent ? `no working turn within ${recent.text} (${row.agentState ?? "unknown"}); --all to include` : `not stuck (${row.agentState ?? "unknown"})`};
}

/**
 * `--active-within`: a target stays a target only when its harness's own activity clock (the transcript's last write,
 * or OpenCode's newest message; readiness-stall's `harnessEvidence`) is at most `within` seconds old. Absent or
 * future-dated evidence is never activity, so harnesses without a clock (cursor, hermes, agy) are always skipped.
 */
export function activityVerdict(lastActivity: number | null, now: number, within: { seconds: number; text: string }): { verdict: Verdict; age: number | null } {
  if (lastActivity === null || !Number.isFinite(lastActivity)) return { verdict: { kind: "skip", reason: "activity unknown (this harness keeps no activity record TAP can read)" }, age: null };
  const age = now - Math.floor(lastActivity);
  if (age < 0) return { verdict: { kind: "skip", reason: "activity unknown (its activity record is dated in the future)" }, age: null };
  if (age > within.seconds) return { verdict: { kind: "skip", reason: `last active ${formatAge(age)} ago, over --active-within ${within.text}` }, age };
  return { verdict: { kind: "target" }, age };
}

/** The production `activity` reader: the roster row's own transcript path and session id, the shape `withAgentStates` passes. */
export function seatActivity(row: FanoutRow, env: NodeJS.ProcessEnv): number | null {
  return harnessEvidence(row.harness, { transcript_path: row.transcriptPath ?? "", harness_session_id: row.harnessSessionId ?? "" }, env)?.lastActivity ?? null;
}

/**
 * Point-of-send recheck against the seat's CURRENT stored row: the selection must still describe it. A relaunch mints a
 * new instance, so the pinned instance refuses a replacement; send then pins that instance through its own placement.
 */
export function recheck(current: Record<string, unknown> | undefined, harness: string, instance: string): string | null {
  if (!current) return "seat is no longer registered";
  const text = (key: string) => (typeof current[key] === "string" ? current[key] as string : "");
  if (text("instance") !== instance) return "seat was replaced since selection (instance changed)";
  if (!familyOf(harness).test(text("harness"))) return `seat harness is now '${text("harness")}'`;
  if ((text("delivery") || "pane") === "poll") return "seat is now poll-mode";
  if ((text("status") || "active") !== "active") return `seat is now ${text("status")}`;
  return null;
}

export type FanoutRow = ObservedRow & { instance: string };
export interface Seat { team: string; handle: string; registryLocation: string; instance: string; verdict: Verdict; activeAgo?: number }

export interface FanoutEffects {
  teams(): Array<{ team: string; registryLocation: string }>;
  roster(registryLocation: string, team: string): { rows: FanoutRow[] } | { error: string };
  /** Epoch seconds of the seat's last harness activity, or null when unknown; read only for `--active-within`. */
  activity(row: FanoutRow): number | null;
  now(): number;
  /** Run the single-seat ladder on one selected seat; production rechecks the seat's instance first. */
  nudge(seat: Seat): number;
  confirm(question: string): boolean;
  interactive(): boolean;
  out(text: string): void;
  err(text: string): void;
}

/**
 * Enumerate, confirm, then run the ladder once per target. A refusal on one seat is that seat's outcome line and
 * never stops the rest. Exit: 0 when every target finished cleanly (skips are not failures); 5 when any seat ended
 * with a possible effect (re-running could repeat it); otherwise 1 on any refusal or unreadable team.
 */
export function runFanout(args: FanoutArgs, self: { team: string; handle: string }, fx: FanoutEffects): number {
  const teams = fx.teams().filter(entry => args.team === "*" || entry.team === (args.team || self.team));
  if (args.team !== "*" && teams.length === 0) {
    throw new TapError(1, "unknown_team", "tap teams", `team '${args.team || self.team}' is not enrolled in the machine index`);
  }
  const seats: Seat[] = [];
  let unreadable = 0;
  for (const entry of teams) {
    const roster = fx.roster(entry.registryLocation, entry.team);
    if ("error" in roster) { fx.err(`tap nudge: team '${entry.team}' unreadable: ${roster.error}\n`); unreadable++; continue; }
    for (const row of roster.rows) {
      let v = verdict(row, entry.team, args.harness, self);
      if (!v) continue;
      let activeAgo: number | undefined;
      // Selection-time only: recheck() guards identity drift and never re-reads activity.
      if (v.kind === "target" && args.activeWithin !== null) {
        const judged = activityVerdict(fx.activity(row), fx.now(), args.activeWithin);
        v = judged.verdict;
        if (judged.age !== null) activeAgo = judged.age;
      }
      if (v.kind === "target" && !args.all && args.activeWithin === null) v = stateVerdict(row, fx.now(), args.recentlyWorking);
      seats.push({ team: entry.team, handle: row.handle, registryLocation: entry.registryLocation, instance: row.instance, verdict: v,
        ...(activeAgo !== undefined && v.kind === "target" ? { activeAgo } : {}) });
    }
  }
  const targets = seats.filter(seat => seat.verdict.kind === "target");
  const scope = args.team === "*" ? "all teams" : `team '${teams[0]!.team}'`;
  const window = args.activeWithin ? `, active within ${args.activeWithin.text}` : args.all ? ", all eligible" : args.recentlyWorking ? `, stuck or working within ${args.recentlyWorking.text}` : ", stuck only";
  fx.out(`tap nudge: ${targets.length} ${args.harness} seat(s) to nudge across ${scope}${window}${args.dryRun ? " (dry run; nothing sent)" : ""}\n`);
  if (args.dryRun) fx.out(`  each seat: the nudge ladder, then ${renderNudgeWire(nudgeDoorbellText(args.message))}${args.interrupt ? "" : " (--no-interrupt)"}\n`);
  for (const seat of targets) fx.out(`  ${seat.team}/${seat.handle}  target${seat.activeAgo === undefined ? "" : ` (last active ${formatAge(seat.activeAgo)} ago)`}\n`);
  const skipped = seats.filter(seat => seat.verdict.kind === "skip");
  if (skipped.length) fx.out(`skipped ${skipped.length}:\n`);
  for (const seat of skipped) fx.out(`  ${seat.team}/${seat.handle}  skip: ${(seat.verdict as { reason: string }).reason}\n`);
  if (unreadable) fx.out(`unreadable teams: ${unreadable} (see stderr)\n`);
  if (args.dryRun || targets.length === 0) return unreadable ? 1 : 0;
  if ((args.team === "*" || targets.length > CONFIRM_ABOVE) && !args.yes) {
    if (!fx.interactive()) {
      throw new TapError(1, "confirmation_required", `re-run with --yes to nudge these ${targets.length} seat(s), or --dry-run to preview`,
        "a multi-seat nudge needs confirmation and stdin is not a terminal; nothing sent");
    }
    // A declined confirmation is the operator's answer, not a failure (CLI-EXIT-0); an
    // unreadable team is still the cannot-check failure it was before the prompt.
    if (!fx.confirm(`Nudge ${targets.length} seat(s)?`)) { fx.out("tap nudge: cancelled; nothing sent\n"); return unreadable ? 1 : 0; }
  }
  let failed = unreadable, possible = 0;
  for (const seat of targets) {
    const address = `${seat.team}/${seat.handle}`;
    try {
      const code = fx.nudge(seat);
      if (code === 5) possible++;
      else if (code !== 0) { failed++; fx.out(`  ${address}  failed (exit ${code})\n`); }
    } catch (error) {
      failed++;
      const detail = error instanceof TapError ? `${error.errorClass}: ${error.detail}` : String(error);
      fx.out(`  ${address}  held (${detail})\n`);
    }
  }
  if (possible) fx.out(`tap nudge: ${possible} seat(s) ended with a possible effect; inspect them (tap peek) before nudging again\n`);
  return possible ? 5 : failed ? 1 : 0;
}

/** Every non-historical index entry, readable or not: an unreadable team is reported by its roster, never dropped. */
function indexTeams(indexHome?: string): Array<{ team: string; registryLocation: string }> {
  const path = globalRegistryPath(indexHome);
  if (!existsSync(path)) return [];
  const teams = readIndexJson(path).teams;
  if (typeof teams !== "object" || teams === null) return [];
  return Object.entries(teams as Record<string, unknown>).flatMap(([team, entry]) => {
    const e = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    return String(e.state ?? "registered") === "historical" ? [] : [{ team, registryLocation: String(e.registry_location ?? "") }];
  });
}

export function productionRoster(scriptsDir: string) {
  return (registryLocation: string, team: string, handle?: string): { rows: FanoutRow[] } | { error: string } => {
    if (registryLocation === "") return { error: "index entry names no registry_location (run tap doctor)" };
    const read = readRegistry(registryLocation, false, false);
    if (!read.ok) return { error: `registry unreadable at ${registryLocation} (run tap doctor)` };
    const rows = (read.rows as RegistryRow[]).filter(row => handle === undefined || row.handle === handle);
    if (rows.length === 0) return { rows: [] };
    const observation = observe(rows, scriptsDir);
    if (observation.code !== 0) return { error: "seat classifier failed" };
    const socket = rows.some(row => typeof row.server_socket === "string" && row.server_socket) ? tmuxReadOnly(["display-message", "-p", "#{socket_path}"]) : null;
    const callerSocket = socket?.code === 0 && socket.stdout.trim().startsWith("/") ? socket.stdout.trim() : "";
    const stored = seatMap(loadRegistry(registryLocation));
    return { rows: withAgentStates(observedRows(rows, observation.rows, observation.serverEpoch, {}, callerSocket), {team})
      .map(row => ({ ...row, instance: typeof stored[row.handle]?.instance === "string" ? stored[row.handle]!.instance as string : "" })) };
  };
}

export function cmdNudgeFanout(argv: string[], scriptsDir: string, self: { team: string; handle: string },
  nudgeSeat: (address: string, args: FanoutArgs, instance: string, stillStuck?: () => string) => number): number {
  const args = parseFanoutArgs(argv);
  const roster = productionRoster(scriptsDir);
  return runFanout(args, self, {
    teams: () => indexTeams(process.env.TAP_INDEX_HOME),
    roster,
    activity: row => seatActivity(row, process.env),
    now: () => Math.trunc(Date.now() / 1000),
    nudge: seat => {
      const drift = recheck(seatMap(loadRegistry(seat.registryLocation))[seat.handle], args.harness, seat.instance);
      if (drift) throw new TapError(1, "target_changed", "tap nudge --dry-run to re-preview", `${drift}; not nudged`);
      const stillStuck = args.all || args.recentlyWorking || args.activeWithin ? undefined : () => {
        const fresh = roster(seat.registryLocation, seat.team, seat.handle);
        const row = "rows" in fresh ? fresh.rows.find(row => row.handle === seat.handle && row.instance === seat.instance) : undefined;
        return row && (row.agentState === "error" || row.agentState === "blocked") ? "" : "seat recovered or state is unconfirmed; not nudged";
      };
      return nudgeSeat(`${seat.team}/${seat.handle}`, args, seat.instance, stillStuck);
    },
    confirm: question => confirm(question),
    interactive: () => process.stdin.isTTY === true,
    out: text => { process.stdout.write(text); },
    err: text => { process.stderr.write(text); },
  });
}
