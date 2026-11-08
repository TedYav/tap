// `tap team refresh --stale[=<duration>] [--include-idle]` — list seats nobody
// has used for a while and, after the operator confirms, retire them through
// the ordinary `tap out` path so each one leaves a tombstone for `tap restore`.
//
// DELIBERATELY SIMPLE (project decision, 2026-11-03): one observation pass, the same one
// `tap team` prints; a color-coded list; the operator's confirmation is the
// check. There is no re-observation after consent and no expected-row lock: a
// seat that changes between the list and the action is an accepted race.
//
// Groups:
//   Offline (default): no running process, aged from its last real activity.
//   Idle, still running (only with --include-idle): live, idle past the cutoff
//   by its dated turn end. Stopping it uses `tap out --kill`, which also ends
//   its crews; the crew count column says so.
//
// AGE IS ACTIVITY, NOT LIFECYCLE. Stopping or re-registering a seat must not
// make it look fresh, so an offline seat is aged from the later of its
// transcript's newest dated record (never the file's mtime: a copied or
// touched transcript is not activity) and `last_launched`. `last_seen` is not used:
// nothing in the runtime writes it any more, and its legacy writer recorded the
// launcher's observation, not seat activity. `exited_at`, then `registered_at`,
// count only when neither activity source exists; a seat with no date at all is
// not listed.
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { TapError, observeCallerIdentity, resolveContext } from "../context";
import { renderRefusalsAsync } from "../error-line";
import { globalRegistryPath, readIndexJson } from "../index-home";
import { activeWithinSeconds, productionRoster, type FanoutRow } from "../verbs/nudge-fanout";
import { verbArgv } from "../courier-argv";
import { loadRegistry, seatMap } from "../registry";
import { crewFamilyHandles } from "../crew-ownership";
import { claudeTranscript, harnessEvidence } from "../readiness-stall";
import { physicalSocketPath, tmuxSessionNamespace } from "../tmux";
import { formatDuration, readTeamHistory } from "../team-history";

type Row = Record<string, unknown>;
const VERB = "tap team refresh";
const USAGE = "tap help team refresh";
export const DEFAULT_STALE = { seconds: 7 * 86400, text: "7d" };
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const usage = (detail: string): never => { throw new TapError(1, "usage_error", USAGE, detail, VERB); };

export interface StaleOptions { stale: { seconds: number; text: string }; includeIdle: boolean; yes: boolean; dryRun: boolean; json: boolean; team?: string }

export const isStaleArgv = (argv: readonly string[]): boolean => argv.some(arg => arg === "--stale" || arg.startsWith("--stale="));

function duration(raw: string): { seconds: number; text: string } {
  try { return { seconds: activeWithinSeconds(raw, "--stale"), text: raw }; }
  catch (error) { return usage(error instanceof TapError ? error.detail : String(error)); }
}

export function parseStaleOptions(argv: readonly string[]): StaleOptions {
  const out: StaleOptions = { stale: DEFAULT_STALE, includeIdle: false, yes: false, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--stale") {
      // refresh takes no positionals, so a following non-flag word can only be the duration.
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) { out.stale = duration(next); i++; }
    } else if (arg.startsWith("--stale=")) out.stale = duration(arg.slice(8));
    else if (arg === "--include-idle") out.includeIdle = true;
    else if (arg === "--hard") usage("--stale and --hard cannot be combined: --stale runs only the stale pass");
    else if (arg === "--yes") out.yes = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--team") {
      const v = argv[++i];
      if (!v || v.startsWith("-")) usage("--team needs a team name or '*'");
      out.team = v;
    } else if (arg.startsWith("--team=")) out.team = arg.slice(7) || usage("--team needs a team name or '*'");
    else if (arg.startsWith("-")) throw new TapError(1, "unknown_option", USAGE, `unknown option '${arg}'`, VERB);
    else usage(`unexpected arg '${arg}'`);
  }
  return out;
}

// --- selection -----------------------------------------------------------------

export type Group = "idle" | "offline";
export interface StaleSeat {
  team: string; handle: string; harness: string; model: string; group: Group;
  ageSeconds: number; source: string; crews: number; leader: boolean;
}
/**
 * One team as the pass sees it: stored rows, the roster's observation of each, and the one
 * tmux session listing of the run (null when it could not be read). A stored status is not
 * proof that nothing runs: a seat restored while its process kept running is a suspended row
 * with a live session, so "offline" also needs its session positively absent from the listing.
 */
/** `callerSocket` is the caller's resolved tmux socket path (`physicalSocketPath`), known with or without a server there. */
export interface TeamView {
  team: string; root: string; stored: Record<string, Row>; observed: Map<string, FanoutRow>; liveSessions: Set<string> | null; callerSocket: string;
}
/** `stillRunning` counts the unobserved seats whose stored status says offline while their session runs. */
export interface Listing { idle: StaleSeat[]; offline: StaleSeat[]; unobserved: number; stillRunning: number }

/** The newest dated record in the seat's transcript, epoch seconds; null when no record is dated. */
export type ActivityReader = (row: Row) => number | null;

/** The newest `timestamp` of any record type among transcript lines; mtime never counts. */
export function newestDatedRecord(lines: readonly string[]): number | null {
  let newest: number | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let record: unknown;
    try { record = JSON.parse(line); } catch { continue; }
    const at = typeof record === "object" && record !== null ? stamp((record as Row).timestamp) : null;
    if (at !== null && (newest === null || at > newest)) newest = at;
  }
  return newest;
}

const TAIL_BYTES = 256 * 1024;

/** Whole lines from the last TAIL_BYTES of a regular file; null when it cannot be read. Never blocks on a FIFO. */
function tailLines(path: string): string[] | null {
  if (!path || !isAbsolute(path)) return null;
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const start = Math.max(0, st.size - TAIL_BYTES);
    const buf = Buffer.alloc(st.size - start);
    const n = readSync(fd, buf, 0, buf.length, start);
    const lines = buf.subarray(0, n).toString("utf8").split("\n");
    if (start > 0) lines.shift(); // a partial first line is a cut, not a record
    return lines;
  } catch { return null; } finally { closeSync(fd); }
}

export const transcriptActivity: ActivityReader = row => {
  const harness = text(row.harness);
  const family = (name: string) => harness === name || harness.startsWith(`${name}-`);
  // Our own tail: any dated record counts (system and progress lines too), not only user/assistant turns.
  if (family("claude") || family("codex")) {
    const path = family("claude") ? claudeTranscript(row as never, process.env) : text(row.transcript_path);
    const lines = tailLines(path);
    return lines ? newestDatedRecord(lines) : null;
  }
  // OpenCode's evidence is the newest message's own created/updated/completed times.
  if (family("opencode")) {
    const evidence = harnessEvidence(harness, row as never, process.env);
    return evidence && Number.isFinite(evidence.lastActivity) ? Math.floor(evidence.lastActivity) : null;
  }
  return null;
};

function stamp(raw: unknown): number | null {
  const value = text(raw);
  if (!value) return null;
  const ms = Date.parse(value.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** Last real activity of an offline seat and where it came from; null when nothing is dated. */
export function offlineActivity(row: Row, transcript: ActivityReader): { at: number; source: string } | null {
  const activity: Array<{ at: number; source: string }> = [];
  const t = transcript(row);
  if (t !== null) activity.push({ at: t, source: "transcript" });
  const launched = stamp(row.last_launched);
  if (launched !== null) activity.push({ at: launched, source: "launched" });
  if (activity.length) return activity.reduce((a, b) => (b.at > a.at ? b : a));
  const exited = stamp(row.exited_at);
  if (exited !== null) return { at: exited, source: "exited" };
  const registered = stamp(row.registered_at);
  return registered === null ? null : { at: registered, source: "registered" };
}

const OFFLINE = new Set(["offline", "gone", "suspended"]);

/**
 * `path` with its nearest existing ancestor resolved through realpath, so a socket whose directory is gone
 * still compares equal across spellings (macOS /tmp/... and /private/tmp/...). `realOrResolved` stops one
 * level up and falls back to the lexical path.
 */
export function canonicalPath(path: string): string {
  const missing: string[] = [];
  for (let at = resolve(path); ; at = dirname(at)) {
    try { return join(realpathSync(at), ...missing.reverse()); } catch { /* not there; try its parent */ }
    if (dirname(at) === at) return resolve(path);
    missing.push(basename(at));
  }
}

/** Pure: group one team's seats. `selfPane` is the caller's pane id ("" outside tmux). */
export function classifyTeam(view: TeamView, now: number, cutoff: number, selfPane: string, transcript: ActivityReader): Listing {
  const out: Listing = { idle: [], offline: [], unobserved: 0, stillRunning: 0 };
  // resolve() collapses `..` before symlinks, so a path with a `..` segment is not comparable: fail closed.
  const dotted = (path: string) => path.split("/").includes("..");
  const callerSocket = view.callerSocket && !dotted(view.callerSocket) ? canonicalPath(view.callerSocket) : "";
  for (const handle of Object.keys(view.stored).sort()) {
    const row = view.stored[handle]!;
    if (row.crew === true || row.crew === 1) continue; // shown as its parent's crew count
    if (text(row.delivery) === "poll" || text(row.harness) === "daemon") continue;
    if (selfPane && text(row.pane_id) === selfPane) continue;
    if (text(row.status) === "pending" || text(row.status_reason) === "launching") continue;
    const seen = view.observed.get(handle);
    if (!seen || seen.status === "unknown" || seen.foreignNamespace || seen.statusReason === "foreign_namespace") { out.unobserved++; continue; }
    // The roster names the caller's socket only through a live server there, so with none a seat bound on
    // another socket comes back with its stored status and would look offline. Compare the recorded socket
    // with the caller's resolved path instead, both canonical; a row with no recorded socket is unchanged.
    const recorded = text(row.server_socket);
    if (recorded && (!callerSocket || dotted(recorded) || canonicalPath(recorded) !== callerSocket)) { out.unobserved++; continue; }
    const base = {
      team: view.team, handle, harness: text(row.harness) || seen.harness, model: seen.model ?? "",
      crews: crewFamilyHandles(view.stored as never, handle).length, leader: text(row.role) === "leader",
    };
    if (seen.status === "active") {
      if (seen.agentState !== "idle") continue;
      const ended = seen.turnEndedAt;
      if (typeof ended !== "number" || !Number.isFinite(ended) || ended > now) { out.unobserved++; continue; }
      const age = Math.floor(now - ended);
      if (age >= cutoff) out.idle.push({ ...base, group: "idle", ageSeconds: age, source: "turn end" });
      continue;
    }
    if (!OFFLINE.has(seen.status) || text(row.status_reason) === "incapable") continue;
    // Offline only when its session is positively absent from the run's session listing.
    const session = text(row.session);
    if (view.liveSessions === null || !session) { out.unobserved++; continue; }
    // A stored-offline row whose session still runs (restored while its process kept going) is not
    // offline, and nothing proves it idle: the observer reported its stored status. Not listed.
    if (view.liveSessions.has(session)) { out.unobserved++; out.stillRunning++; continue; }
    const activity = offlineActivity(row, transcript);
    if (!activity) { out.unobserved++; continue; }
    const age = Math.floor(now - activity.at);
    if (age >= cutoff) out.offline.push({ ...base, group: "offline", ageSeconds: age, source: activity.source });
  }
  const oldestFirst = (a: StaleSeat, b: StaleSeat) => b.ageSeconds - a.ageSeconds || (a.handle < b.handle ? -1 : 1);
  out.idle.sort(oldestFirst);
  out.offline.sort(oldestFirst);
  return out;
}

// --- rendering -----------------------------------------------------------------

const ORANGE = "\x1b[38;5;208m", GREY = "\x1b[90m", BOLD = "\x1b[1m", RESET = "\x1b[0m";

export function renderListing(listing: Listing, opts: { includeIdle: boolean; cutoff: string; showTeam: boolean; style: boolean }): string {
  const paint = (color: string, s: string) => (opts.style ? `${color}${s}${RESET}` : s);
  const lines: string[] = [];
  const group = (title: string, seats: StaleSeat[], color: string, ageLabel: string) => {
    lines.push(paint(BOLD + color, `${title} (${seats.length})`));
    if (!seats.length) { lines.push("  none"); return; }
    const cells = seats.map(s => [
      `${opts.showTeam ? `${s.team}/` : ""}${s.handle}${s.leader ? " [leader]" : ""}`, s.harness || "-", s.model || "-",
      `${ageLabel} ${formatDuration(s.ageSeconds)} (${s.source})`, s.crews ? `${s.crews} crew${s.crews === 1 ? "" : "s"}` : "",
    ]);
    const widths = cells[0]!.map((_, i) => Math.max(...cells.map(c => c[i]!.length)));
    for (const c of cells) lines.push(paint(color, `  ${c.map((v, i) => v.padEnd(widths[i]!)).join("  ").trimEnd()}`));
  };
  if (opts.includeIdle) group("Idle, still running", listing.idle, ORANGE, "idle");
  group("Offline", listing.offline, GREY, "offline");
  if (listing.unobserved) lines.push(`${listing.unobserved} seat(s) could not be observed or dated; not listed`);
  if (listing.stillRunning) lines.push(`${listing.stillRunning} of them restored while still running; check them with tap team`);
  return `${lines.join("\n")}\n`;
}

const seatJson = (s: StaleSeat) => ({ team: s.team, handle: s.handle, harness: s.harness || null, model: s.model || null,
  group: s.group, age_seconds: s.ageSeconds, age_source: s.source, crews: s.crews, leader: s.leader });

// --- the pass ------------------------------------------------------------------

export interface StaleTeam { team: string; root: string; registryLocation: string }
export interface StaleEffects {
  teams(scope: string | undefined): StaleTeam[];
  /** The caller's own team, "" when it has none; restore hints name any other team. */
  callerTeam(): string;
  view(team: StaleTeam): TeamView | { error: string };
  transcript: ActivityReader;
  retire(team: StaleTeam, seat: StaleSeat): { ok: boolean; detail: string };
  restoreIndex(team: StaleTeam, handle: string): number | null;
  selfPane(): string;
  now(): number;
  interactive(): boolean;
  ask(question: string): Promise<string>;
  style(): boolean;
  out(text: string): void;
  err(text: string): void;
}

export async function runStale(opts: StaleOptions, fx: StaleEffects): Promise<number> {
  const teams = fx.teams(opts.team);
  const now = fx.now(), selfPane = fx.selfPane();
  const listing: Listing = { idle: [], offline: [], unobserved: 0, stillRunning: 0 };
  const unreadable: Array<{ team: string; error: string }> = [];
  const byName = new Map(teams.map(t => [t.team, t]));
  for (const team of teams) {
    const view = fx.view(team);
    if ("error" in view) { unreadable.push({ team: team.team, error: view.error }); continue; }
    const part = classifyTeam(view, now, opts.stale.seconds, selfPane, fx.transcript);
    listing.idle.push(...part.idle); listing.offline.push(...part.offline);
    listing.unobserved += part.unobserved; listing.stillRunning += part.stillRunning;
  }
  if (opts.team !== "*" && unreadable.length) {
    throw new TapError(1, "observation_failed", "tap team", `${unreadable[0]!.error}; nothing retired`, VERB);
  }
  const byAge = (a: StaleSeat, b: StaleSeat) => b.ageSeconds - a.ageSeconds;
  listing.idle.sort(byAge); listing.offline.sort(byAge);
  if (!opts.includeIdle) listing.idle = [];
  const results: Array<Record<string, unknown>> = [];
  const finish = (outcome: string, code: number) => {
    if (opts.json) fx.out(`${JSON.stringify({ ok: code === 0, stale_after: opts.stale.text, stale_after_seconds: opts.stale.seconds,
      include_idle: opts.includeIdle, dry_run: opts.dryRun, outcome, idle: listing.idle.map(seatJson), offline: listing.offline.map(seatJson),
      unobserved: listing.unobserved, still_running: listing.stillRunning, unreadable_teams: unreadable, results })}\n`);
    return code;
  };
  if (!opts.json) {
    fx.out(`${VERB} --stale: seats unused for at least ${opts.stale.text}${opts.dryRun ? " (dry run; nothing changes)" : ""}\n`);
    fx.out(renderListing(listing, { includeIdle: opts.includeIdle, cutoff: opts.stale.text, showTeam: opts.team === "*", style: fx.style() }));
    for (const u of unreadable) fx.err(`${VERB}: team '${u.team}' could not be observed: ${u.error}\n`);
  }
  const failedTeams = unreadable.length ? 1 : 0;
  if (opts.dryRun) return finish("dry_run", failedTeams);
  if (!listing.idle.length && !listing.offline.length) {
    if (!opts.json) fx.out("nothing to retire\n");
    return finish("nothing", failedTeams);
  }
  let chosen: StaleSeat[];
  if (opts.yes) chosen = [...listing.idle, ...listing.offline];
  else {
    if (opts.json || !fx.interactive()) {
      throw new TapError(1, "confirmation_required", `re-run with --yes to retire the listed seats, or --dry-run to preview`,
        "retiring stale seats needs confirmation and there is no terminal; nothing changed", VERB);
    }
    const answer = (await fx.ask(opts.includeIdle
      ? "Stop and retire both groups? [y] both / [o] offline only / [N] cancel "
      : "Retire the offline seats? [y] retire / [N] cancel ")).trim().toLowerCase();
    if (answer === "y" || answer === "yes") chosen = [...listing.idle, ...listing.offline];
    else if (opts.includeIdle && answer === "o") chosen = [...listing.offline];
    else { if (!opts.json) fx.out("cancelled; nothing changed\n"); return finish("cancelled", failedTeams); }
  }
  const caller = fx.callerTeam();
  let failed = 0;
  for (const seat of chosen) {
    const team = byName.get(seat.team)!;
    const label = opts.team === "*" ? `${seat.team}/${seat.handle}` : seat.handle;
    const result = fx.retire(team, seat);
    if (!result.ok) {
      failed++;
      results.push({ team: seat.team, handle: seat.handle, group: seat.group, ok: false, detail: result.detail });
      if (!opts.json) fx.out(`  ${label}: FAILED, still on the team: ${result.detail}\n`);
      continue;
    }
    const n = fx.restoreIndex(team, seat.handle);
    const restore = n === null ? null : `tap restore ${seat.handle}@${n}${seat.team === caller ? "" : ` --team ${seat.team}`}`;
    results.push({ team: seat.team, handle: seat.handle, group: seat.group, ok: true, restore });
    if (!opts.json) fx.out(`  ${label}: ${seat.group === "idle" ? "stopped and retired" : "retired"}${restore ? `; restore: ${restore}` : ""}\n`);
  }
  return finish("done", failed || failedTeams ? 1 : 0);
}

// --- production effects --------------------------------------------------------

function indexTeams(indexHome?: string): StaleTeam[] {
  const path = globalRegistryPath(indexHome);
  if (!existsSync(path)) return [];
  const teams = readIndexJson(path).teams;
  if (typeof teams !== "object" || teams === null) return [];
  return Object.entries(teams as Record<string, unknown>).flatMap(([team, entry]) => {
    const e = (typeof entry === "object" && entry !== null ? entry : {}) as Row;
    return String(e.state ?? "registered") === "historical" ? [] : [{ team, root: text(e.root), registryLocation: text(e.registry_location) }];
  });
}

/** One observation pass: the roster `tap team` prints, beside the stored rows and one session listing. */
export function productionView(scriptsDir: string) {
  const roster = productionRoster(scriptsDir);
  const callerSocket = physicalSocketPath(process.env);
  let listing: Set<string> | null | undefined;
  const liveSessions = (): Set<string> | null => {
    if (listing === undefined) { const ns = tmuxSessionNamespace(); listing = ns.observable ? ns.names : null; }
    return listing;
  };
  return (team: StaleTeam): TeamView | { error: string } => {
    const seen = roster(team.registryLocation, team.team);
    if ("error" in seen) return seen;
    let stored: Record<string, Row>;
    try { stored = seatMap(loadRegistry(team.registryLocation)) as Record<string, Row>; }
    catch (error) { return { error: `registry unreadable at ${team.registryLocation}: ${String(error)}` }; }
    return { team: team.team, root: team.root, stored, observed: new Map(seen.rows.map(row => [row.handle, row])),
      liveSessions: liveSessions(), callerSocket };
  };
}

/** `tap out` for an offline seat; `tap out --kill` for one still running, so no process is orphaned. */
export function retireArgv(team: StaleTeam, seat: StaleSeat): string[] {
  return ["out", seat.handle, "--team", team.team, ...(seat.group === "idle" ? ["--kill"] : []), "--json"];
}

/** Retire through the path that writes the tombstone. */
export function productionRetire(scriptsDir: string) {
  return (team: StaleTeam, seat: StaleSeat): { ok: boolean; detail: string } => {
    const env = { ...process.env, TAP_JSON: "1" };
    const argv = retireArgv(team, seat);
    const [cmd, ...args] = verbArgv(scriptsDir, argv, env);
    const child = Bun.spawnSync([cmd!, ...args], { env, cwd: team.root || process.cwd(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    if (child.exitCode === 0) return { ok: true, detail: "" };
    const out = child.stdout.toString(), err = child.stderr.toString();
    let detail = (err || out).split("\n").find(Boolean) ?? `tap out exited ${child.exitCode}`;
    for (const line of out.split("\n")) {
      try { const parsed = JSON.parse(line) as Row; if (parsed.ok === false) detail = `${text(parsed.error_class)}: ${text(parsed.detail) || text(parsed.action)}`; } catch { /* not JSON */ }
    }
    return { ok: false, detail };
  };
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    let answered = false;
    rl.once("close", () => { if (!answered) resolve(""); });
    rl.question(question, answer => { answered = true; rl.close(); resolve(answer); });
  });
}

export function cmdRefreshStale(argv: string[], scriptsDir: string): Promise<number> {
  const json = argv.includes("--json") || process.env.TAP_JSON === "1";
  return renderRefusalsAsync(VERB, async () => {
    const opts = parseStaleOptions(argv);
    opts.json ||= json;
    const fx: StaleEffects = {
      teams: scope => {
        if (scope === "*") return indexTeams(process.env.TAP_INDEX_HOME);
        const ctx = resolveContext(process.cwd(), process.env, scope ? { explicitTeam: scope } : undefined);
        return [{ team: ctx.team, root: ctx.root, registryLocation: ctx.registryPath }];
      },
      callerTeam: () => { try { return resolveContext().team; } catch { return ""; } },
      view: productionView(scriptsDir),
      transcript: transcriptActivity,
      retire: productionRetire(scriptsDir),
      restoreIndex: (team, handle) => {
        try {
          const mine = readTeamHistory(team.root, {}, Date.now() / 1000, handle).entries.filter(e => e.index !== null);
          return mine.length ? Math.max(...mine.map(e => e.index!)) : null;
        } catch { return null; }
      },
      selfPane: () => { const caller = observeCallerIdentity(process.env); return caller.state === "inside" ? caller.paneId : ""; },
      now: () => Date.now() / 1000,
      interactive: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
      ask,
      style: () => !!process.stdout.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb",
      out: t => { process.stdout.write(t); },
      err: t => { process.stderr.write(t); },
    };
    return runStale(opts, fx);
  }, { ...process.env, TAP_JSON: json ? "1" : "0" });
}
