// `tap nudge --harness <h> [--team <t|*>]` (tap-s1k5j): wake every live seat of one harness family with an
// ordinary courier note, one per seat. The single-peer stuck-sentinel recovery form lives in nudge.ts.

import { existsSync, readFileSync } from "node:fs";

import { TapError } from "../context";
import { interruptKeysForFamily } from "../courier";
import { AGENT_FAMILIES } from "../harness-families";
import { globalRegistryPath, readIndexJson } from "../index-home";
import { loadRegistry, seatMap } from "../registry";
import { tmuxReadOnly } from "../tmux";
import { assertNudgeContextCurrent, confirmOperator, nudgeContext, refuseLegacyUserSeat, resolveNudgeSender } from "./nudge-sender";
import { cmdSendOutcome, type SendOutcome } from "./send";
import { observe, observedRows, readRegistry, type ObservedRow, type RegistryRow } from "./team";

const USAGE = "tap help nudge";
/** A fan-out wider than this, or any `--team '*'`, needs `--yes` or a TTY confirmation. */
export const CONFIRM_ABOVE = 1;

export interface FanoutArgs {
  harness: string; team: string; from: string; message: string; file: string; dryRun: boolean; yes: boolean;
  interrupt: boolean; reason: string;
}

/** True when any of `flags` appears in flag position. A valued flag consumes
 * the next token first, so `-m --team` (a body that says --team) is a body,
 * never a routing signal (tap-pkh9c review). */
export function flagPresent(argv: readonly string[], flags: readonly string[]): boolean {
  const valued = new Set(["-m", "-f", "--reason", "--from", "--to", "--pane", "--harness", "--team", "--aggressiveness"]);
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
  const out: FanoutArgs = { harness: "", team: "", from: "", message: "", file: "", dryRun: false, yes: false, interrupt: false, reason: "" };
  const value = (i: number, flag: string): string => {
    const next = argv[i + 1];
    if (next === undefined || next === "") throw new TapError(1, "usage_error", USAGE, `${flag} needs a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--harness": out.harness = value(i, arg); i++; break;
      case "--team": out.team = value(i, arg); i++; break;
      case "--from": out.from = value(i, arg); i++; break;
      case "--to": throw new TapError(1, "usage_error", USAGE, "the --harness fan-out form selects its seats by family; --to names one peer (tap nudge --interrupt --to <peer>)");
      case "-m": out.message = value(i, arg); i++; break;
      case "-f": out.file = value(i, arg); i++; break;
      case "--interrupt": out.interrupt = true; break;
      case "--reason": out.reason = value(i, arg); i++; break;
      case "--dry-run": out.dryRun = true; break;
      case "--yes": out.yes = true; break;
      default:
        if (arg.startsWith("-")) throw new TapError(1, "unknown_option", USAGE, `unknown option '${arg}' for the --harness fan-out form`);
        throw new TapError(1, "usage_error", USAGE, `'${arg}': the --harness fan-out form takes no peer; use 'tap nudge ${arg}' for single-peer recovery`);
    }
  }
  if (out.harness === "") throw new TapError(1, "usage_error", USAGE, "--harness is required for the fan-out form (e.g. tap nudge --harness codex --team '*')");
  if (!AGENT_FAMILIES.has(out.harness)) {
    throw new TapError(1, "usage_error", USAGE, `unknown harness '${out.harness}' (one of: ${[...AGENT_FAMILIES].join(", ")})`);
  }
  if (out.message !== "" && out.file !== "") throw new TapError(1, "usage_error", USAGE, "pass either -m or -f, not both");
  if (out.reason !== "" && !out.interrupt) throw new TapError(1, "usage_error", USAGE, "--reason belongs to --interrupt");
  // -m/-f stay complete-body overrides in interrupt mode too; --reason cannot
  // ride next to them (the body would have two authors).
  if (out.reason !== "" && (out.message !== "" || out.file !== "")) {
    throw new TapError(1, "usage_error", USAGE, "--reason cannot be combined with -m/-f");
  }
  return out;
}

/** The interrupt-mode body: -m/-f override it whole; otherwise the continue note, reason inside. */
export function interruptMessage(args: FanoutArgs): string[] {
  if (args.file !== "") return ["-f", args.file];
  return ["-m", args.message || interruptBody(args.reason)];
}

/** One shared wording for interrupt outcomes (tap-pkh9c). The interrupt fact
 * branches FIRST: once keys have fallen, every later fate of the note —
 * delivered, parked, unverified — is "interrupted; note <fate>", and only an
 * outcome with no interrupt at all may say no keys were sent. A queued or
 * unverified target is never reported as recovery. */
export function interruptOutcomeLine(address: string, outcome: { disposition: string; interrupt?: unknown }): string {
  if (outcome.interrupt) {
    if (outcome.disposition === "delivered") return `${address}  interrupted (delivered)`;
    if (outcome.disposition.startsWith("queued")) return `${address}  interrupted; note queued (${outcome.disposition})`;
    return `${address}  interrupted; note ${outcome.disposition.toUpperCase()} (possible effect; do not re-nudge)`;
  }
  if (outcome.disposition === "delivered") return `${address}  delivered (no interrupt keys sent)`;
  return `${address}  ${outcome.disposition} (no interrupt keys sent)`;
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
export interface Seat { team: string; handle: string; registryLocation: string; instance: string; verdict: Verdict }

export interface FanoutEffects {
  teams(): Array<{ team: string; registryLocation: string }>;
  roster(registryLocation: string): { rows: FanoutRow[] } | { error: string };
  /** Deliver to one selected seat; production rechecks the seat and pins its instance before placement. */
  send(seat: Seat, argv: string[], opts?: { recoveryInterrupt?: boolean }): SendOutcome;
  confirm(question: string): boolean;
  /** Refuse any target registry that still has a legacy `user` seat; a dry run checks it too. */
  refuseOperatorConflicts(targetRegistries: string[]): void;
  /** Ask the operator question; throws `cancelled` unless the person says yes. */
  confirmOperator(): void;
  /** Before each send, after every question: refuse if the sender's bus moved meanwhile. */
  recheckSender(): void;
  interactive(): boolean;
  out(text: string): void;
  err(text: string): void;
}

export function defaultBody(from: string): string {
  return `Automated nudge from ${from}: your usage limit may have reset. Check your queue (tap poll) and continue your assigned work.`;
}

/** The one interrupt note (tap-pkh9c): the reason, when given, rides inside the parens. */
export function interruptBody(reason: string): string {
  return reason === "" ? "Nudge: continue what you were working on." : `Nudge: ${reason.replace(/[.\s]+$/, "")}. Continue what you were working on.`;
}

/**
 * Enumerate, confirm, then deliver one note per target. A refusal on one seat is that seat's outcome line and never
 * stops the rest. With `--interrupt` each target first gets the courier's U4 double-Escape (explicit recovery
 * authority, tap-pkh9c), then the continue note; a target that parks instead is reported `queued`, never as
 * recovered. Exit: 0 when every target was delivered or queued (skips are not failures); 5 when any delivery was
 * unverified (possible effect: re-running the fan-out could duplicate it); otherwise 1 on any failure or unreadable team.
 */
export function runFanout(args: FanoutArgs, self: { team: string; handle: string; wouldPrompt?: boolean }, fx: FanoutEffects): number {
  const teams = fx.teams().filter(entry => args.team === "*" || entry.team === (args.team || self.team));
  if (args.team !== "*" && teams.length === 0) {
    throw new TapError(1, "unknown_team", "tap teams", `team '${args.team || self.team}' is not enrolled in the machine index`);
  }
  const seats: Seat[] = [];
  let unreadable = 0;
  for (const entry of teams) {
    const roster = fx.roster(entry.registryLocation);
    if ("error" in roster) { fx.err(`tap nudge: team '${entry.team}' unreadable: ${roster.error}\n`); unreadable++; continue; }
    for (const row of roster.rows) {
      const v = verdict(row, entry.team, args.harness, self);
      if (v) seats.push({ team: entry.team, handle: row.handle, registryLocation: entry.registryLocation, instance: row.instance, verdict: v });
    }
  }
  const targets = seats.filter(seat => seat.verdict.kind === "target");
  const scope = args.team === "*" ? "all teams" : `team '${teams[0]!.team}'`;
  fx.out(`tap nudge: ${targets.length} ${args.harness} seat(s) to nudge across ${scope}${args.dryRun ? " (dry run; nothing sent)" : ""}\n`);
  if (self.wouldPrompt && args.dryRun) fx.out(`  sender: ${self.handle} (operator; would prompt)\n`);
  if (args.interrupt) {
    // The preview derives from the courier's own family table: it may never
    // promise keys the courier would not send (tap-pkh9c review, material 2).
    const ik = interruptKeysForFamily(args.harness);
    fx.out(ik.method === "bare-submit"
      ? `  interrupt: no keys — each selected pane is interrupted by the note submission itself\n`
      : `  interrupt: ${ik.keys.join(" ")} clears each selected pane, then the note below is submitted\n`);
    if (args.dryRun) fx.out(`  note: ${args.file !== "" ? `(body from ${args.file})` : (args.message || interruptBody(args.reason)).replace(/\n.*/s, " …")}\n`);
  }
  for (const seat of targets) fx.out(`  ${seat.team}/${seat.handle}  target\n`);
  const skipped = seats.filter(seat => seat.verdict.kind === "skip");
  if (skipped.length) fx.out(`skipped ${skipped.length}:\n`);
  for (const seat of skipped) fx.out(`  ${seat.team}/${seat.handle}  skip: ${(seat.verdict as { reason: string }).reason}\n`);
  if (unreadable) fx.out(`unreadable teams: ${unreadable} (see stderr)\n`);
  // The dry run refuses what the real run refuses; only the question and the sends are skipped.
  if (self.wouldPrompt && targets.length) fx.refuseOperatorConflicts(targets.map(seat => seat.registryLocation));
  if (args.dryRun || targets.length === 0) return unreadable ? 1 : 0;
  // Identity, then scope: the operator is asked only once the targets are on
  // screen and there is something to send (tap-gridx).
  if (self.wouldPrompt) fx.confirmOperator();
  if ((args.team === "*" || targets.length > CONFIRM_ABOVE) && !args.yes) {
    if (!fx.interactive()) {
      throw new TapError(1, "confirmation_required", `re-run with --yes to nudge these ${targets.length} seat(s), or --dry-run to preview`,
        "a multi-seat nudge needs confirmation and stdin is not a terminal; nothing sent");
    }
    if (!fx.confirm(`Nudge ${targets.length} seat(s)?`)) { fx.out("tap nudge: cancelled; nothing sent\n"); return 1; }
  }
  const body = args.interrupt ? interruptMessage(args)
    : args.file !== "" ? ["-f", args.file] : ["-m", args.message || defaultBody(self.handle)];
  let failed = unreadable, unverified = 0;
  for (const seat of targets) {
    const address = `${seat.team}/${seat.handle}`;
    try {
      // The resolved context rides each send, so re-resolve it first: a prompt or
      // the earlier sends may have outlasted the team's bus.
      fx.recheckSender();
      // In-process argv: no shell sees the body, so backticks in -m stay literal.
      // Interrupt mode sends urgent with recovery authority; the send door
      // refuses any argv shape that would let ordinary send reach it.
      const outcome = fx.send(seat,
        [address, ...body, "--from", self.handle, "--fyi", ...(args.interrupt ? ["--urgent" as const] : [])],
        args.interrupt ? { recoveryInterrupt: true } : undefined);
      if (outcome.rc === 0) {
        fx.out(`  ${args.interrupt ? interruptOutcomeLine(address, outcome) : `${address}  ${outcome.disposition}`}\n`);
      }
      else if (outcome.rc === 5) {
        unverified++;
        // The interrupt fact branches first here too: an unverified note after
        // the keys reports `interrupted; note UNVERIFIED`, the single-peer
        // wording (tap-pkh9c review round 4); keyless keeps the incumbent line.
        fx.out(outcome.interrupt
          ? `  ${interruptOutcomeLine(address, outcome)}\n`
          : `  ${address}  UNVERIFIED (possible effect; pending id in the send receipt above; do not re-nudge this seat)\n`);
      } else { failed++; fx.out(`  ${address}  failed (rc=${outcome.rc}, ${outcome.disposition})\n`); }
    } catch (error) {
      failed++;
      const detail = error instanceof TapError ? `${error.errorClass}: ${error.detail}` : String(error);
      fx.out(`  ${address}  failed (${detail})\n`);
    }
  }
  if (unverified) fx.out(`tap nudge: ${unverified} unverified delivery(ies) may have landed; check tap outstanding ${self.handle} before re-running\n`);
  return unverified ? 5 : failed ? 1 : 0;
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

function productionRoster(scriptsDir: string) {
  return (registryLocation: string): { rows: FanoutRow[] } | { error: string } => {
    if (registryLocation === "") return { error: "index entry names no registry_location (run tap doctor)" };
    const read = readRegistry(registryLocation, false, false);
    if (!read.ok) return { error: `registry unreadable at ${registryLocation} (run tap doctor)` };
    const rows = read.rows as RegistryRow[];
    if (rows.length === 0) return { rows: [] };
    const observation = observe(rows, scriptsDir);
    if (observation.code !== 0) return { error: "seat classifier failed" };
    const socket = rows.some(row => typeof row.server_socket === "string" && row.server_socket) ? tmuxReadOnly(["display-message", "-p", "#{socket_path}"]) : null;
    const callerSocket = socket?.code === 0 && socket.stdout.trim().startsWith("/") ? socket.stdout.trim() : "";
    const stored = seatMap(loadRegistry(registryLocation));
    return { rows: observedRows(rows, observation.rows, observation.serverEpoch, {}, callerSocket)
      .map(row => ({ ...row, instance: typeof stored[row.handle]?.instance === "string" ? stored[row.handle]!.instance as string : "" })) };
  };
}

export function cmdNudgeFanout(argv: string[], scriptsDir: string): number {
  const parsed = parseFanoutArgs(argv);
  // Resolve the sender once, before any target is touched (dry-run included:
  // it previews the same run). A team/seat sender selects its own team's bus,
  // and "your team" (the --team default) is the sender's.
  // A named --team anchors an operator note from outside every enrolled
  // checkout, as a team/peer target does for the interrupt form; '*' names no bus.
  const senderInput = { from: parsed.from, dryRun: parsed.dryRun, deferPrompt: true,
    ...(parsed.team && parsed.team !== "*" ? { targetTeam: parsed.team } : {}) };
  const ctx = nudgeContext(senderInput);
  const sender = resolveNudgeSender(senderInput, ctx);
  const from = sender.handle;
  // `-f -` is read once here: each per-seat send would otherwise drain stdin, and every seat after the first gets EOF.
  const args = parsed.file === "-" && !parsed.dryRun ? { ...parsed, file: "", message: readFileSync(0, "utf8") } : parsed;
  if (parsed.file === "-" && !parsed.dryRun && args.message === "") throw new TapError(1, "usage_error", USAGE, "-f - read an empty body from stdin; nothing sent");
  return runFanout(args, { team: ctx.team, handle: from, wouldPrompt: sender.wouldPrompt }, {
    teams: () => indexTeams(process.env.TAP_INDEX_HOME),
    roster: productionRoster(scriptsDir),
    send: (seat, sendArgv) => {
      const drift = recheck(seatMap(loadRegistry(seat.registryLocation))[seat.handle], parsed.harness, seat.instance);
      if (drift) throw new TapError(1, "target_changed", "tap nudge --dry-run to re-preview", `${drift}; not sent`);
      // Not quiet: send's own receipt carries the id, and on rc 5 the pending path the operator needs.
      return cmdSendOutcome(sendArgv, scriptsDir, AGENT_FAMILIES,
        { recipientInstance: seat.instance || undefined, ...(parsed.interrupt ? { recoveryInterrupt: true } : {}),
          senderContext: ctx, ...(sender.user ? { operatorSender: true } : {}) });
    },
    confirm: question => confirm(question),
    refuseOperatorConflicts: refuseLegacyUserSeat,
    confirmOperator: () => confirmOperator(),
    recheckSender: () => assertNudgeContextCurrent(senderInput, ctx),
    interactive: () => process.stdin.isTTY === true,
    out: text => { process.stdout.write(text); },
    err: text => { process.stderr.write(text); },
  });
}
