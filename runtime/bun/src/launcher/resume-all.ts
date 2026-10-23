import { detachedReceipt } from "./attach-policy";
// `tap session resume --all` / `tap team up`: the whole cohort command.
// One namespace + generation snapshot, the only/except complement, every
// receipt, per-seat continuation, the terminal summary and its optional fresh
// start. Each seat enters the ONE native launch transaction in-process; no
// Python callback exists inside custody. session-doors.ts parses public argv;
// team up enters that same owner in process.
import { SelectorError } from "../selector";
import { startupTrace, withStartupTrace, withStartupTraceScope } from "../startup-trace";
import { beginLifecycleOperation } from "../lifecycle-diagnostics";
import { Notices } from "./catalog-notices";
import { currentBootId, namespaceSnapshot, observeGeneration, staleSeatGeneration, truthy, type Observation } from "./generation";
import { assertUniqueHarnessSessionIdentity, identityHandle } from "./identity-owner";
import { InvocationError } from "./invocation";
import { LaunchCommandError } from "./process";
import { callerHasTty, callerTty, exitKeepingTerminal, promptYesNo } from "./prompt";
import { pathIsUnder, realOrSelf, rootForCwd } from "./records";
import { timestamp } from "./repair";
import { freshLaunchSessionId } from "./adapters";
import { bootstrapTmux, cloneRecord, commandSummary, compact, entryGuard, err, out, Refusal, refuseRetiredFlags, registryState, render,
  SCRIPTS, withRecordDefaults, type Row } from "./resume-prelude";
import { durableRecord, launchHandle, LaunchInterrupted, TransactionError, launchTransaction, recordFromRow, withLaunchSignals, type LaunchRecord } from "./transaction";
import { LauncherError } from "./types";
import { idlessFreshWarning } from "./resume-identity";
import type { LifecycleReceipt } from "../lifecycle-target";
import { assertBoundInstances, assertBoundSeats, readDiscoverySeats, type BoundCohort } from "../team/discovery";

export { bootstrapTmux } from "./resume-prelude";

export interface Options { dryRun: boolean; json: boolean; model: string | null; teams: boolean; key: string | null; legacyName: string | null; lifecycle?: LifecycleReceipt; restartRows?: Map<string, Row> }

/** Canonical cohort options from the public session door. */
export function parseResumeAll(argv: string[]): Options {
  const options: Options = { dryRun: false, json: false, model: null, teams: false, key: null, legacyName: null };
  let all = false, positional = false;
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (positional || !token.startsWith("-")) { positionals.push(token); continue; }
    if (token === "--") positional = true;
    else if (token === "--all") all = true;
    else if (token === "--dry-run") options.dryRun = true;
    else if (token === "--json") options.json = true;
    else if (token === "--teams") options.teams = true;
    else if (token === "--model" && i + 1 < argv.length) options.model = argv[++i]!;
    else throw new Refusal("usage: tap session resume --all [--dry-run]");
  }
  if (!all || positionals.length > 2) throw new Refusal("usage: tap session resume --all [--dry-run]");
  [options.key = null, options.legacyName = null] = positionals;
  return options;
}

const RECOVERABLE = new Set(["pane_gone", "session_replaced", "repair_failed", "restart_failed"]);
export function rebootResumeRecords(root: string, entries: Map<string, Row>, observation: Observation): LaunchRecord[] {
  const records: LaunchRecord[] = [];
  for (const [handle, row] of entries) {
    if (truthy(row.crew) || row.delivery !== "pane" || row.status !== "suspended"
      || !RECOVERABLE.has(row.status_reason as string) || !staleSeatGeneration(row, observation)) continue;
    const record = recordFromRow(handle, row, { worktree_root: root }, root);
    if (record) records.push(withRecordDefaults(record));
  }
  return records;
}

/** The team up only/except sets arrive already parsed and roster-gated; popped so no seat inherits them. */
export function popHandles(name: "TAP_TEAM_EXCEPT_HANDLES" | "TAP_TEAM_ONLY_HANDLES"): Set<string> {
  const raw = process.env[name] ?? "";
  delete process.env[name];
  return new Set(raw.split(/\r\n|\r|\n/).filter(Boolean));
}

/** Complement against the candidate records, never the roster. */
export function onlyToExcepted(records: LaunchRecord[], only: Set<string>): Set<string> {
  return new Set(records.map(identityHandle).filter(handle => !only.has(handle)));
}

// ---- the cohort ----

/** Seats that launch at once in the cohort: the per-seat wait is mostly harness
 * boot and readiness polling, so 4 cuts a full cohort's wall time roughly
 * fourfold while bounding simultaneous harness boots and keeping
 * `withLaunchSignals` (2 process listeners per seat) at 8, under Node's
 * 10-listener warning. */
const TEAM_UP_CONCURRENCY = 4;

/** A failed seat, its reason, and a typed recovery action when the refusal carried one. */
type Failure = [LaunchRecord, string, string?];
type Retained = { handle: string; session: string; reason: string; action: string };
export type Transaction = (kind: "resume-all" | "new", record: LaunchRecord, extra?: { live_sessions?: string[] }) => Promise<number>;

/** Per-seat bridge categories: launcher refusals and command failures continue the cohort. */
function seatFailure(error: unknown): string | null {
  if (error instanceof LauncherError && error.errorClass) return null;
  if (error instanceof LaunchInterrupted) return null;
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
  if (error instanceof SelectorError) return `${error.errorClass}: ${error.detail}; next: ${error.action}`;
  if (error instanceof InvocationError) return error.message;
  if (error instanceof LaunchCommandError) return `tmux error: ${commandSummary(error.argv)}`;
  // Anything else crashed the incumbent worker: it said so on stderr, and the
  // bridge reported a failed `bun worker.ts bridge <fd>` command.
  err(`tap session: launcher worker failed: ${(error as Error)?.message ?? String(error)}`);
  return `tmux error: ${process.execPath} ...`;
}

/** Effect seams: the production entry wires the real ones; tests substitute. */
export interface ResumeAllDeps {
  run: Transaction; bootstrap: () => Promise<void>; namespace: () => Promise<Set<string>>;
  observe: () => Promise<Observation>; hasTty: () => boolean; confirm: (verb: string, question: string, defaultYes: boolean) => boolean;
  /** Fired once the pool settles, in roster order: a seat that came up (dry run: would come up). */
  onCameUp?: (handle: string, session: string) => void;
  /** Fired when any seat's fatal was an interrupt, whichever seat's error the cohort rethrows. */
  onInterrupted?: () => void;
}

/** What `tap team up --attach` learns from the cohort: the seats that came up, and whether the operator interrupted it. */
export interface CohortObserver { cameUp: (handle: string, session: string) => void; interrupted: () => void }

export async function resumeAll(options: Options, cwd: string, deps: ResumeAllDeps): Promise<number> {
  const run = deps.run;
  entryGuard(cwd);
  if (!options.dryRun) await deps.bootstrap();
  const state = registryState(cwd);
  if (options.key !== null || options.legacyName !== null) throw new Refusal("usage: tap session resume --all [--dry-run]");
  entryGuard(cwd);
  const root = rootForCwd(cwd);
  const liveNames = await deps.namespace();
  const observation = await deps.observe();
  const priorNames = new Set(state.sessions.map(record => record.name));
  const recovered = rebootResumeRecords(root, state.entries, observation).filter(record => !priorNames.has(record.name));
  const sessions = options.restartRows
    ? [...options.restartRows].map(([handle, row]) => {
      const record = recordFromRow(handle, row, state.team, root);
      if (!record) {
        const detail = `stored launch recipe for '${handle}' cannot be decoded; no restart cohort launched`;
        throw new LauncherError(detail, "invalid_restart_recipe", "tap team doctor", detail);
      }
      return withRecordDefaults(record);
    }) : [...state.sessions, ...recovered];
  let excepted = popHandles("TAP_TEAM_EXCEPT_HANDLES");
  const only = popHandles("TAP_TEAM_ONLY_HANDLES");
  const inScope = sessions.filter(record => pathIsUnder(record.cwd, root));
  // tap-team.ts already refused the two selectors together.
  if (only.size) excepted = onlyToExcepted(inScope, only);
  const occupied = inScope.filter(record => liveNames.has(record.name) && !excepted.has(identityHandle(record))
    && staleSeatGeneration(state.entries.get(identityHandle(record)), observation)).map(identityHandle);
  if (occupied.length) err(`tap team up: skipped unverified live occupants after restart: ${occupied.sort().join(", ")}; inspect those sessions before named resume`);
  const spared = inScope.filter(record => excepted.has(identityHandle(record)));
  const sparedNames = spared.map(identityHandle).sort().join(", ");
  const records = inScope.filter(record => !liveNames.has(record.name) && !excepted.has(identityHandle(record)));
  const typed = [...only].sort().join(", ");
  const emptyClause = only.size ? `selection (--only: ${typed})` : `exclusions (excluded: ${sparedNames})`;
  const sparedClause = only.size ? `by --only ${typed} — every other seat` : `by --except: ${sparedNames}`;
  const receipt = options.json ? err : out;
  if (spared.length && !inScope.some(record => !excepted.has(identityHandle(record)))) {
    if (options.json) {
      out(compact({ ok: true, ...options.lifecycle, sessions: [], count: 0, scope: "cwd", excluded: spared.map(identityHandle).sort() }));
      err(`tap team up: no seats matched after exclusions (excluded: ${sparedNames})`);
    } else out(`tap team up: no seats matched after ${emptyClause}`);
    return 0;
  }
  if (spared.length) receipt(`tap team up: spared ${spared.length} seat(s) ${sparedClause}`);
  else if (only.size) receipt(`tap team up: --only ${typed} matched every seat — none spared`);
  if (!records.length) {
    if (options.json) out(compact({ ok: true, ...options.lifecycle, sessions: [], count: 0, scope: "cwd" }));
    else out("tap session resume --all: no stopped sessions");
    return 0;
  }
  const cohort = sessions.length ? sessions : records;
  for (const record of records) assertUniqueHarnessSessionIdentity(cohort, record, "tap session resume --all");
  const total = records.length;
  // Every per-seat result is keyed by roster POSITION, never by handle or
  // session name (a registry key and an identityHandle can diverge), and the
  // summaries are read out in position order, so completion order never
  // reorders a line, a failure or a manual_attention. stdout lines use an
  // ordered flush: seat i prints once every seat < i has settled, which keeps
  // streaming (a settled prefix prints immediately) and roster order.
  const lines: (string | null)[] = Array.from({ length: total }, () => null);
  const failuresByPosition: (Failure | null)[] = Array.from({ length: total }, () => null);
  const retainedByPosition: (Retained | null)[] = Array.from({ length: total }, () => null);
  const cameUpByPosition: ({ handle: string; session: string } | null)[] = Array.from({ length: total }, () => null);
  let nextToPrint = 0;
  const settle = (position: number, line: string): void => {
    lines[position] = line;
    while (nextToPrint < total && lines[nextToPrint] !== null) {
      const ready = lines[nextToPrint]!;
      if (ready) out(ready);
      nextToPrint++;
    }
  };
  // A non-per-seat error (seatFailure === null: an interrupt, a launcher
  // refusal) aborts the cohort: workers stop dequeuing, seats already in
  // flight finish, and the lowest roster position's error is rethrown. One
  // signal can land on several in-flight seats, so every fatal is kept.
  const aborted: { position: number; error: unknown; name: string }[] = [];
  const startedByPosition: boolean[] = Array.from({ length: total }, () => false);
  const launchSeat = async (position: number): Promise<void> => {
    startedByPosition[position] = true;
    const record = records[position]!;
    const launched = { ...record, last_launched: timestamp() };
    const freshWarning = idlessFreshWarning(launched);
    if (freshWarning) err(freshWarning);
    let code: number;
    try { code = await run("resume-all", launched, { live_sessions: [...liveNames] }); }
    catch (error) {
      if (error instanceof TransactionError && error.tapErrorClass === "harness_start_dialog") {
        retainedByPosition[position] = { handle: identityHandle(launched), session: launched.name, reason: error.message, action: error.tapAction ?? `tmux attach -t ${launched.name}` };
        return settle(position, "");
      }
      const reason = seatFailure(error);
      if (reason === null) {
        aborted.push({ position, error, name: launched.name });
        // Settle without a line: later in-flight seats' receipts must still
        // flush past this position before the rethrow, or a live seat would
        // show no summary at all.
        return settle(position, "");
      }
      // A typed refusal (e.g. no_exact_resume_identity) carries its own recovery;
      // the generic "resume manually" line would only meet the same refusal.
      failuresByPosition[position] = [launched, reason, error instanceof TransactionError ? error.tapAction : undefined];
      return settle(position, "");
    }
    if (code !== 0) { failuresByPosition[position] = [launched, `resume failed (exit ${code})`]; return settle(position, ""); }
    cameUpByPosition[position] = { handle: identityHandle(launched), session: launched.name };
    settle(position, options.json ? "" : `tap session resume --all: [${position + 1}/${total}] ${options.dryRun ? "would resume" : "resumed"} ${launched.name}`);
  };
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (aborted.length === 0) {
      const position = nextIndex++;
      if (position >= total) return;
      await launchSeat(position);
    }
  };
  await Promise.all(Array.from({ length: Math.min(TEAM_UP_CONCURRENCY, total) }, worker));
  // Came-up seats hand to the caller in roster order (dry run: would-resume),
  // never completion order: the caller's preview and viewer plan must not
  // shuffle run to run.
  const flushCameUp = (): void => {
    if (!deps.onCameUp) return;
    for (const seat of cameUpByPosition) if (seat) deps.onCameUp(seat.handle, seat.session);
  };
  const fatals = aborted.slice().sort((a, b) => a.position - b.position);
  if (fatals.length > 0) {
    // The rethrown error stays the lowest position's; an interrupt anywhere
    // in the cohort is still the operator cancelling the command.
    if (fatals.some(row => row.error instanceof LaunchInterrupted)) deps.onInterrupted?.();
    flushCameUp();
    const lowest = fatals[0]!;
    // Seats already in flight can finish with live dialogs or failures while
    // the cohort aborts; text mode reports every completed outcome in roster
    // order before the rethrow, with no fresh-start recovery on this path.
    // JSON mode keeps CLI-ERR's contract — one object on stdout, nothing on
    // stderr — so there the abort prints no prose at all.
    if (!options.json) {
      // "aborted" alone would hide the blast radius: name every seat whose
      // error aborted the cohort, and the seats that were never attempted.
      const notAttempted = records.filter((_, position) => !startedByPosition[position]).map(record => record.name);
      out(`tap team up: aborted by ${lowest.name}`
        + (fatals.length > 1 ? `; also aborted: ${fatals.slice(1).map(row => row.name).join(", ")}` : "")
        + (notAttempted.length ? `; not attempted: ${notAttempted.join(", ")}` : ""));
      const failures = failuresByPosition.filter((failure): failure is Failure => failure !== null);
      if (failures.length) out(`tap team up: ${failures.length} of ${total} seat(s) ${options.dryRun ? "would not resume" : "failed to resume"}:`);
      for (let position = 0; position < total; position++) {
        const row = retainedByPosition[position];
        if (row) out(retainedLine(row));
        const failure = failuresByPosition[position];
        if (failure) for (const line of failureLines(failure)) out(line);
      }
    }
    throw lowest.error;
  }
  const failures = failuresByPosition.filter((failure): failure is Failure => failure !== null);
  const retained: Retained[] = retainedByPosition.filter((row): row is Retained => row !== null);
  if (retained.length && !options.json) {
    for (const row of retained) out(retainedLine(row));
  }
  if (failures.length) {
    // An accepted fresh start that succeeds brings its seat up too: record it
    // at the failed seat's own position, then hand the ledger over.
    const positionOf = new Map(failuresByPosition.flatMap((failure, position) => failure ? [[failure[0], position] as const] : []));
    // finally: a recovery that throws (an interrupt mid fresh start) must not
    // take the seats that already came up with it.
    try {
      return (await failureSummary(failures, total, options, deps, retained, (record, fresh) => {
        const position = positionOf.get(record);
        if (position !== undefined) cameUpByPosition[position] = { handle: identityHandle(fresh), session: fresh.name };
      })) || (retained.length ? 2 : 0);
    } finally { flushCameUp(); }
  }
  flushCameUp();
  if (retained.length) {
    if (options.json) out(compact({ ok: false, ...options.lifecycle, outcome: "manual_attention", resumed: total - retained.length, total, retained }));
    else out(`tap session resume --all: resumed ${total - retained.length}; ${retained.length} retained for manual_attention`);
    return 2;
  }
  if (options.json && options.lifecycle && !options.dryRun) out(compact({ ok: true, ...options.lifecycle, resumed: total, total, outcome: "resumed" }));
  if (!options.json) out(`tap session resume --all: ${options.dryRun ? "would resume" : "resumed"} ${total} session${total !== 1 ? "s" : ""}`);
  return 0;
}

/** One retained seat's report line; shared by the summary and abort paths. */
function retainedLine(row: Retained): string {
  return `tap team up: manual_attention ${row.session}: ${row.reason}; next: ${row.action}`;
}

/** One failed seat's bullet and manual-resume line, shared by both report paths. */
function failureLines(failure: Failure): string[] {
  const [record, reason, action] = failure;
  return [`  - ${record.name}: ${reason}`,
    action ? `    next: ${action}` : `    resume manually with: tap session resume ${record.harness} ${identityHandle(record)}`];
}

async function failureSummary(failures: Failure[], total: number, options: Options, deps: ResumeAllDeps, retained: { handle: string; session: string; reason: string; action: string }[] = [],
  onStarted?: (record: LaunchRecord, fresh: LaunchRecord) => void): Promise<number> {
  if (options.json) {
    out(compact({ ok: false, ...options.lifecycle, resumed: total - failures.length - retained.length, total, ...(retained.length ? { retained } : {}),
      failed: failures.map(([record, reason, action]) => ({ handle: identityHandle(record), session: record.name, reason, ...(action ? { action } : {}) })) }));
    return 1;
  }
  out(`tap team up: ${failures.length} of ${total} seat(s) ${options.dryRun ? "would not resume" : "failed to resume"}:`);
  for (const failure of failures) for (const line of failureLines(failure)) out(line);
  if (options.dryRun || options.restartRows || !deps.hasTty()) return 1;
  if (deps.confirm("team up", "start a new session and resume manually?", true)) {
    // The run's exit is a cohort verdict: any failed fresh launch is a flat 1, never a seat's own code.
    const fresh = await freshStart(failures.map(([record]) => record), deps.run, onStarted);
    if (fresh !== 0) {
      err("tap team up: fresh start failed for at least one listed seat");
      return 1;
    }
    return 0;
  }
  out("tap team up: left unresumed; use the commands above to resume manually");
  return 1;
}

/** The collision chooser's [k] behavior per listed seat, always detached. */
async function freshStart(failed: LaunchRecord[], run: Transaction, onStarted?: (record: LaunchRecord, fresh: LaunchRecord) => void): Promise<number> {
  let worst = 0;
  for (const record of failed) {
    const history = [...(record.history ?? [])];
    if (record.harness_session_id && !history.includes(record.harness_session_id)) history.push(record.harness_session_id);
    const fresh: LaunchRecord = {
      ...record, history, harness_session_id: freshLaunchSessionId(record.harness) ?? null, transcript_path: null,
      replacement_record: durableRecord(record), replaces_session: record.name, replaces_manifest_session: record.name,
      kill_backup_required: true, ensure_action: "new", last_launched: timestamp(),
    };
    // A failed tmux command is that seat failing, as on the resume arm; interrupts
    // and typed refusals still propagate with their own rendering.
    let code: number | string;
    try { code = await run("new", fresh); }
    catch (error) {
      if (!(error instanceof LaunchCommandError)) throw error;
      code = `tmux error: ${commandSummary(error.argv)}`;
    }
    if (code === 0) {
      onStarted?.(record, fresh);
      for (const line of fresh.ensure_receipts ?? []) out(`tap session: ${line}`);
      out(`tap session: ${detachedReceipt(fresh.name, "no controlling terminal", `${fresh.base}/${launchHandle(fresh)}`)}`);
    } else {
      err(`tap team up: warning: fresh start failed for ${record.name} (${typeof code === "number" ? `exit ${code}` : code})`);
      worst ||= 1;
    }
  }
  return worst;
}

// ---- entry ----

export async function cmdSessionResumeAll(argv: string[], scriptDir = SCRIPTS, lifecycle?: LifecycleReceipt, root?: string, bound?: BoundCohort,
  observer?: CohortObserver): Promise<number> {
  const jsonRequested = process.env.TAP_JSON === "1" || argv.includes("--json");
  let options: Options;
  try { options = parseResumeAll(argv); }
  catch (error) { return render(error, jsonRequested); }
  if (lifecycle) options.lifecycle = lifecycle;
  options.restartRows = bound?.restartRows;
  const cwd = realOrSelf(root ?? process.cwd());
  if (bound) assertBoundSeats(bound, readDiscoverySeats(bound.team.registryPath));
  const notices = new Notices();
  notices.suppress(jsonRequested);
  const outputPath = callerTty();
  let stderrTty = false;
  try { stderrTty = process.stderr.isTTY === true; } catch { /* no terminal */ }
  // Each seat enters with its own copy, as the bridge's serialized packet did:
  // a failed attempt's partial writes (launch_id, capture action) must never
  // reach the caller's record or the fresh-start arm that reuses it. Its trace
  // scope is per-seat too: concurrent seats' launch fields must not overwrite
  // each other in the shared operation.
  const run: Transaction = async (kind, record, extra = {}) => withStartupTraceScope(() => withLaunchSignals(async signal => {
    if (bound) assertBoundInstances(bound, readDiscoverySeats(bound.team.registryPath));
    const result = await launchTransaction({ kind, record: cloneRecord(record), dry_run: options.dryRun, json: options.json, output_path: outputPath,
      lifecycle_receipt: options.lifecycle,
      approved_instance: bound?.seats.get(identityHandle(record))?.instance,
      approved_restart_row: bound?.restartRows?.get(identityHandle(record)),
      terminal: { stderr_tty: stderrTty }, script_dir: scriptDir, ...extra }, process.env, signal, notices);
    Object.assign(record, result.record);
    return result.code;
  }));
  return withStartupTrace(async () => {
    const traced = !options.dryRun;
    if (traced) beginLifecycleOperation({ verb: "resume", cwd: root ?? process.cwd(), target: null, boot_id: currentBootId() });
    let code = 1;
    try {
      try { refuseRetiredFlags(options.model, options.teams); code = await resumeAll(options, cwd, { run, bootstrap: bootstrapTmux, namespace: namespaceSnapshot,
        observe: observeGeneration, hasTty: callerHasTty, confirm: promptYesNo, onCameUp: observer?.cameUp, onInterrupted: observer?.interrupted }); }
      catch (error) { code = render(error, jsonRequested); }
      return code;
    } finally {
      if (traced) startupTrace(code === 0 ? "launch_complete" : "launch_failure", { exit_code: code });
    }
  }, undefined, scriptDir);
}

if (import.meta.main) await exitKeepingTerminal(await cmdSessionResumeAll(process.argv.slice(2)));
