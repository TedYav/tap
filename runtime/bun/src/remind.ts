// Watcher reminders: persist each schedule and claim every occurrence before
// its one send attempt.
//
// This is the reminders service behind `tap remind` and the watch sidecar tick
// (CONTRACT §Agent reminders on the watch sidecar). The queue lives in
// `<bus>/watch/reminders.json`; the lease it may create is `<bus>/watch/arm.json`.
// One kernel lock on `reminders.json.lock` serializes scheduling, cancellation,
// dispatch, minimal-arm completion and disarm; `finish` then takes the lease lock
// INSIDE it (queue, then lease — the same order `add` uses, so a schedule can
// never land between the empty check and the lease's removal).
//
// Reads that only report (`list`, `delay`) take the lock too, briefly, because
// an unlocked read cannot see a schedule that `add` has admitted and not yet
// published -- `delay` would sleep past that deadline. But they never REFUSE on
// contention: a contended read is not an unreadable queue (the loop announces one
// of those every tick, tap-r9rrc), so it falls back to the unlocked snapshot, which
// atomic rename keeps coherent if stale. (An earlier revision left these reads
// unlocked on the atomic-rename argument; that rules out a torn read, not a missed
// one. See readUnderLockOrStale.)
//
// Two facts the fixture cannot see but the contract depends on:
//   - `publish` fsyncs before rename. `dispatching` is the durable claim that
//     survives a process loss and is never replayed; it has to reach the disk
//     before the send attempt, not merely the page cache.
//   - The lease is checked TWICE, and the second check is not redundant even
//     though no single-check mutant reds the fixture (measured; see the comment
//     at the second one). `off` cannot race this function -- it takes the same
//     queue lock -- but `tap watch on` re-arms through `watch-lease.ts set` under
//     `arm.json.lock` alone, so a concurrent re-arm CAN land between the claim
//     and the send while this call holds the queue lock.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { commandWake, launchCommand, type CommandJob } from "./remind-job";
import { acquireNoFollowLock, SymlinkedLockPath } from "./remind-lock";
import { courierArgv } from "./courier-argv";
import { floatSource, isFile, publish, read, readExact, withLock } from "./watch-lease";
import { offGuarded, type OffArgs } from "./watch-sidecar";

export interface ReminderRow {
  owner: string;
  to: string;
  body: string;
  due_at: number;
  every_seconds: number;
  status: "scheduled" | "dispatching" | "accepted" | "unresolved" | "cancelled";
  job?: CommandJob;
  message_id?: string;
  exit_code?: number;
  result?: string;
  retry_attempts?: number;
  notice?: { id: string; exit_code: number; result: string };
}
export type Rows = Record<string, ReminderRow>;

/**
 * The queue's root, validated ONCE for every consumer (list, delay, fire, finish,
 * cancel, add, off): a JSON value that is not an object -- `null`, an array, a
 * number, a string -- is refused with one stable reason naming the file, so the loop's
 * degrade line, `tap remind list`'s refusal and the tick's own line all say the same
 * thing about the same queue (seen at the seam: `Object.entries(null)`
 * and `Object.values(null)` had two engine-worded reasons for one malformed root). An
 * absent file is `{}`, as `read` answers.
 */
export function readRows(state: string): Rows {
  const rows: unknown = read<object>(state);
  if (typeof rows !== "object" || rows === null || Array.isArray(rows)) {
    throw new Error(`reminders queue is not an object: ${state}`);
  }
  return rows as Rows;
}

/** Bound on waiting for the queue or lease lock. The incumbent blocked without
 *  bound; the longest legitimate holder is `fire` across one `tap send`
 *  run, whose own blocking path is the 5 s pane lock plus bounded read-back
 *  polls (drafts, queued input and closed windows PARK and return at once). */

const DURATION_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** `<positive integer><s|m|h|d>` → seconds, refusing exactly what the incumbent refused. */
export function duration(raw: string): number {
  const unit = raw.slice(-1);
  const digits = raw.slice(0, -1);
  if (!raw || !(unit in DURATION_UNITS) || !/^[0-9]+$/.test(digits)) {
    throw new Error("duration must be a positive integer followed by s, m, h, or d");
  }
  const seconds = BigInt(digits) * BigInt(DURATION_UNITS[unit]!);
  if (seconds < 1n || seconds > 2147483647n) throw new Error("duration is out of range");
  return Number(seconds);
}

/**
 * A row's deadline as the queue wrote it -- a JSON integer -- or null for a value only
 * a hand edit produces (a string, a float, a missing field). The tick's doctrine for
 * the record applies to the queue: such a row is announced and skipped, never
 * compared as NaN. Before this a `"due_at": "soon"` row made `delay` return NaN, so
 * the loop's sleep(NaN) returned at once (a tight loop of tick children), and `fire`
 * dispatched it on the next tick because `"soon" > now` is false.
 */
export function dueAt(row: ReminderRow): number | null {
  return Number.isSafeInteger(row.due_at) ? row.due_at : null;
}

/** The next sleep: the tick interval, or the nearest scheduled deadline if sooner (never below 1 s); a row without a readable deadline is not a deadline. */
export function delay(rows: Rows, interval: number, now: number): number {
  const waits = Object.values(rows)
    .filter(row => row.status === "scheduled" && dueAt(row) !== null)
    .map(row => Math.max(1, dueAt(row)! - now));
  return Math.min(interval, ...waits);
}

/**
 * The sidecar loop's delay door (watch-loop.ts `remindDelay`, in-process since W3): the
 * same locked-or-stale read the CLI arm makes, then `delay`. A queue that cannot be read
 * throws; the loop names the file and the reason, sleeps its parsed interval and goes
 * on (tap-r9rrc) -- `tap remind list` refuses the same queue with the same
 * reason, because it is this same read.
 */
export function delayFor(state: string, interval: number, now: number): number {
  return delay(readUnderLockOrStale(state, () => readRows(state)), interval, now);
}

export function active(rows: Rows): boolean {
  return Object.values(rows).some(row => row.status === "scheduled");
}

/** One human line per row; the `--json` form carries every field. */
export function humanLine(id: string, row: ReminderRow, team = ""): string {
  const line = `${id}  ${row.owner}->${row.to}  ${row.status}  due=${row.due_at}  every=${row.every_seconds}s  message=${row.message_id ?? "-"}`;
  if (row.status !== "unresolved") return line;
  const failure = row.job?.terminal_deliveries?.find(delivery => delivery.exit_code !== undefined && delivery.exit_code !== 0 && delivery.exit_code !== 5) ?? row;
  let summary = String(failure.result ?? "");
  try {
    const result = JSON.parse(summary);
    summary = [result?.error_class, result?.detail].filter(value => typeof value === "string" && value).join(": ") || summary;
  } catch { /* Non-JSON sender diagnostics remain readable. */ }
  summary = summary.replace(/[\s\x00-\x1f\x7f]+/g, " ").trim().slice(0, 160);
  return `${line}  exit=${failure.exit_code ?? "-"}  failure=${summary || "-"}  full result: tap remind list${team ? ` --team ${team}` : ""} --json`;
}

/** Waits before each re-attempt of a declared-repeatable refusal; its length bounds the attempts. */
export const RETRY_BACKOFF_SECONDS = [5, 15, 30] as const;

/**
 * Waits before each re-attempt of a send the tmux server never answered before any
 * effect (tap-yk8it). Longer than the custody schedule because the cause is an
 * outage -- host sleep, a network drop -- not a lock held for seconds: the 09-24
 * specimen lasted about 90 minutes, and these waits span 1 h 42.5 min before the row
 * goes unresolved and its owner is told.
 */
export const OUTAGE_BACKOFF_SECONDS = [30, 120, 600, 1800, 3600] as const;

/**
 * The backoff a failed send may be re-attempted on, or null when it must not be.
 *
 * - The tmux-outage refusal: error class `server_unresponsive` WITH `effect: "none"`,
 *   which `tap send` states only when the server stopped answering before it placed
 *   anything or touched the pane. The same class without that field -- a timeout
 *   after an effect, outcome unknown -- is never re-attempted: a delivery that may
 *   have reached the pane is not repeated. The action text plays no part here.
 * - A refusal the sender declared safe to repeat as-is: exit 1 with the declared next
 *   action "retry this command". Its only emitter is the reset-custody refusal
 *   (reset.ts `acquireResetMutationLock`), raised before anything is placed.
 *   Matching the ACTION's prefix, not "retry" anywhere, keeps out refusals that
 *   name a change first ("tap team; retry with a current recipient").
 */
export function retrySchedule(exitCode: number, output: string): readonly number[] | null {
  if (exitCode !== 1) return null;
  let result: { error_class?: unknown; action?: unknown; effect?: unknown } | null;
  try { result = JSON.parse(output); } catch { return null; }
  if (typeof result !== "object" || result === null) return null;
  if (result.error_class === "server_unresponsive") return result.effect === "none" ? OUTAGE_BACKOFF_SECONDS : null;
  return typeof result.action === "string" && result.action.startsWith("retry this command") ? RETRY_BACKOFF_SECONDS : null;
}

/**
 * Custody after one send attempt: rc 0 and 5 are handed off; a re-attemptable
 * refusal is rescheduled on its backoff until that runs out; anything else is left
 * for inspection. One count spans a streak of failures; the current refusal's
 * schedule supplies the next wait and the bound.
 */
export function afterSend(row: ReminderRow, exitCode: number, output: string, now: number): void {
  row.exit_code = exitCode;
  row.result = output;
  const attempts = row.retry_attempts ?? 0;
  const schedule = exitCode === 0 || exitCode === 5 ? null : retrySchedule(exitCode, output);
  if (exitCode === 0 || exitCode === 5) {
    delete row.retry_attempts;
    row.status = row.every_seconds ? "scheduled" : "accepted";
    if (row.every_seconds) row.due_at = now + row.every_seconds;
  } else if (schedule && attempts < schedule.length) {
    row.retry_attempts = attempts + 1;
    row.status = "scheduled";
    row.due_at = now + schedule[attempts]!;
  } else {
    row.status = "unresolved";
  }
}

/**
 * Reads that report but never gate: `list` and `delay`.
 *
 * They take the lock, because an unlocked read cannot see a schedule that `add`
 * has admitted and not yet published -- `delay` would then return the full tick
 * interval and sleep past that reminder's deadline. The atomic rename rules out a
 * torn read; it does not rule out a missed one.
 *
 * They must not REFUSE on contention: `delay`'s failure used to exit the sidecar
 * loop (`tap_watch_run`, tap-watch.sh at the pinned base) and strand an armed lease
 * with no runner -- the tap-7r3fn.112 shape; since tap-r9rrc the loop degrades on a
 * queue it cannot read instead, but a contended read is still not an unreadable
 * queue, and announcing one every tick would be noise. A contended read falls back
 * to the unlocked snapshot: a coherent older snapshot, at worst one tick late, never
 * torn and never fatal. The wait is short because the only realistic contender is a
 * fast `add`/`cancel`; one bus has one sidecar, so `fire`'s batch hold is not a
 * sibling of this call.
 *
 * A SYMLINKED lock path is not contention and does not fall back -- it is a state
 * the incumbent never operated in, so it propagates.
 */
const READ_LOCK_WAIT_MS = 5_000;
function readUnderLockOrStale<T>(path: string, body: () => T): T {
  let lock = null;
  try {
    lock = acquireNoFollowLock(`${path}.lock`, READ_LOCK_WAIT_MS);
  } catch (error) {
    if (error instanceof SymlinkedLockPath) throw error;
    lock = null; // an unreachable primitive must not end the sidecar loop
  }
  try { return body(); } finally { lock?.release(); }
}

function armPath(state: string): string { return join(dirname(state), "arm.json"); }
function armedAt(state: string): string {
  const rec = read<{ armed_at?: unknown }>(armPath(state));
  return rec.armed_at === undefined ? "" : String(rec.armed_at);
}

function utcStamp(epoch: number): string {
  return new Date(epoch * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Under the queue lock: create the minimal reminders-only lease when no lease exists. */
function ensureArm(state: string, owner: string, now: number): void {
  const arm = armPath(state);
  withLock(arm, () => {
    if (!isFile(arm)) {   // A directory at the lease path is not an armed lease (rule 38).
      publish(arm, { mode: "reminders-only", armed_by: owner, armed_at: now, evaluator: "none", tick_interval_seconds: 60 });
    }
  });
}

/**
 * One best-effort notice to the scheduling seat that its reminder went unresolved, so
 * a lost wake is not silent. It is attempted once and never retried; its outcome is
 * kept on the row. The reminder's own list line is the body.
 */
function noticeOwner(state: string, scripts: string, ident: string, row: ReminderRow, now: number): void {
  const id = `watcher-${utcStamp(now)}-${randomBytes(6).toString("hex")}`;
  const attempts = 1 + (row.retry_attempts ?? 0);
  const body = join(dirname(state), `.remind-notice-${randomBytes(6).toString("hex")}.md`);
  let created = false;
  try {
    const fd = openSync(body, "wx", 0o600);
    created = true;
    try { writeFileSync(fd, `Your reminder ${ident} to ${row.to} went unresolved after ${attempts} attempt${attempts === 1 ? "" : "s"} and will not fire again.\n\n${humanLine(ident, row)}\n`); }
    finally { closeSync(fd); }
    const [cmd, ...argv] = courierArgv(scripts, [row.owner, body,
      "--from", "watcher", "--id", id, "--kind", "notice", "--fyi", "--wake", "--json"]);
    const result = spawnSync(cmd!, argv, {
      env: { ...process.env, TAP_SELF: "watcher" },
      stdio: ["inherit", "pipe", "pipe"],
    });
    const output = result.error ? String(result.error) : result.stdout.toString().trim() || result.stderr.toString().trim();
    row.notice = { id, exit_code: result.status ?? 1, result: output };
  } catch (error) {
    row.notice = { id, exit_code: 1, result: String(error) };
  } finally {
    if (created) unlinkSync(body);
  }
}

/** Dispatch every due occurrence, one attempt each per tick, under the queue lock. */
export function fire(state: string, scripts: string, armAt: string, now: number): void {
  withLock(state, () => {
    const rows = readRows(state);
    for (const [ident, row] of Object.entries(rows)) {
      if (row.status !== "scheduled") continue;
      const due = dueAt(row);
      if (due === null) {
        // announced once per tick, never dispatched, the row left for inspection
        process.stderr.write(`tap watch: reminders: ${ident}: due_at is not an integer (${JSON.stringify(row.due_at)}); not dispatched\n`);
        continue;
      }
      if (due > now) continue;
      if (armedAt(state) !== armAt) return;
      const previousJob = row.job ? structuredClone(row.job) : undefined;
      let wake: ReturnType<typeof commandWake> | null = null;
      if (row.job) {
        try { wake = commandWake(row.job, dirname(dirname(state)), now); }
        catch (error) {
          process.stderr.write(`tap watch: reminders: ${ident}: acknowledgement observation unavailable: ${error}\n`);
          row.due_at = now + Math.min(60, row.job.circle_seconds);
          publish(state, rows);
          continue;
        }
        if (wake.suppress) {
          row.due_at = now + Math.min(60, row.job.circle_seconds);
          publish(state, rows);
          continue;
        }
      }
      const target = wake?.target ?? row.to;
      const targets = row.job?.escalated && wake?.terminal ? [row.to, row.job.fallback] : [target];
      const message = `watcher-${utcStamp(now)}-${randomBytes(6).toString("hex")}`;
      row.status = "dispatching";
      row.message_id = message;
      const deliveries = targets.map((to, i) => ({ to, id: i === 0 ? message : `watcher-${utcStamp(now)}-${randomBytes(6).toString("hex")}` }));
      if (row.job && wake?.terminal) row.job.terminal_deliveries = deliveries;
      if (row.job && wake && !wake.terminal && !row.job.escalated) row.job.pending.push(message);
      publish(state, rows);
      const body = join(dirname(state), `.remind-body-${randomBytes(6).toString("hex")}.md`);
      const fd = openSync(body, "wx", 0o600);
      try {
        writeFileSync(fd, `Reminder ${ident}, scheduled by ${row.owner}.\n\n${row.body}\n${wake ? `\n${wake.text}\n` : ""}`);
        closeSync(fd);
        // The window the pre-claim check cannot cover: a concurrent `tap watch on`
        // stamps a fresh `armed_at` under `arm.json.lock`, which this call does not
        // hold. Rolling back to `scheduled` (rather than leaving the claim) is
        // sound precisely because no send call occurred.
        //
        // Neither check is individually falsifiable on the current fixture -- each
        // catches the other's mutant (remind.test.ts's lease test, the stale fire
        // and stale finish legs) -- so what that arm pins
        // is the property (a stale tick never delivers), not either line. Removing
        // BOTH reds it. Do not "simplify" one away on the strength of a green run.
        if (armedAt(state) !== armAt) {
          row.status = "scheduled"; // no send call occurred
          if (previousJob) row.job = previousJob;
          publish(state, rows);
          return;
        }
        // `bash` by PATH and the incumbent's argv: the fixture redirects this exact spawn.
        let allAccepted = true;
        for (const [index, delivery] of deliveries.entries()) {
          if (index > 0 && armedAt(state) !== armAt) {
            row.status = "unresolved"; row.result = "arm changed during terminal delivery batch";
            publish(state, rows); return;
          }
          const [cmd, ...argv] = courierArgv(scripts, [delivery.to, body,
            "--from", "watcher", "--id", delivery.id, "--kind", "notice", "--fyi", "--wake", "--json"]);
          const result = spawnSync(cmd!, argv, {
            env: { ...process.env, TAP_SELF: "watcher" },
            stdio: ["inherit", "pipe", "pipe"],
          });
          if (result.error && !row.job) throw result.error;
          const output = result.error ? String(result.error) : result.stdout.toString().trim() || result.stderr.toString().trim();
          const code = result.status ?? 1, accepted = code === 0 || code === 5;
          allAccepted = allAccepted && accepted;
          if (row.job && wake) {
            Object.assign(delivery, { exit_code: code, result: output });
            row.exit_code = code; row.result = output;
            if (!wake.terminal && !row.job.escalated && !accepted) {
              row.job.pending = row.job.pending.filter(id => id !== delivery.id);
              row.job.undeliverable = (row.job.undeliverable ?? 0) + 1;
              row.job.delivery_error = output.slice(-2048);
            }
            // Keep the batch claimed across each separately journaled send.
            publish(state, rows);
          } else {
            afterSend(row, code, output, now);
            if ((row.status as ReminderRow["status"]) === "unresolved") noticeOwner(state, scripts, ident, row, now);
          }
        }
        if (row.job && wake) {
          row.status = wake.terminal ? (allAccepted ? "accepted" : "unresolved") : "scheduled";
          row.due_at = now + (row.job.escalated ? Math.min(60, row.job.circle_seconds) : row.job.circle_seconds);
        }
        publish(state, rows);
      } finally {
        unlinkSync(body);
      }
    }
  });
}

/** Minimal-arm completion: demote finished supervision, or drop an idle reminders-only lease. */
export function finish(state: string, armAt: string, supervision: boolean): void {
  withLock(state, () => {
    const rows = readRows(state);
    const arm = armPath(state);
    withLock(arm, () => {
      // Exact integers: the demotion below republishes this record (tap-j5pmi).
      const rec = readExact<Record<string, unknown>>(arm);
      // A caller's armAt is a scalar spelling. A hand-edited float (`100.0`) reads back as a
      // rawJSON wrapper that String() cannot coerce, so it compares by its source text; an
      // array or object (which may hold such a wrapper) is never equal to a scalar: no-op.
      const armed = rec.armed_at;
      const scalar = armed === null || ["string", "number", "bigint", "boolean"].includes(typeof armed);
      const spelling = armed === undefined ? "" : floatSource(armed) ?? (scalar ? String(armed) : null);
      if (spelling !== armAt) return;
      if (!supervision && rec.mode !== "reminders-only") return;
      if (active(rows)) {
        if (supervision) {
          publish(arm, { ...rec, mode: "reminders-only", evaluator: "none", done_when: "" });
        }
      } else if (isFile(arm)) {   // `[ -f ]`: only a regular file is the lease to remove (rule 38)
        unlinkSync(arm);
      }
    });
  });
}

function pendingNames(entries: Array<[string, string]>): string {
  return entries.map(([ident, target]) => `${ident} (to=${target})`).join(", ");
}

/** Refuse a disarm that would strand another seat's reminders; otherwise run the lease shutdown under the queue lock. */
export function off(state: string, a: OffArgs): number {
  return withLock(state, () => {
    const rows = readRows(state);
    const pending: Array<[string, string]> = Object.entries(rows)
      .filter(([, row]) => row.status === "scheduled")
      .map(([ident, row]) => [ident, row.to]);
    const others = pending.filter(([, target]) => target !== a.actor);
    if (others.length && !a.force) {
      process.stderr.write(`tap watch: refusing disarm; pending reminders for other seats: ${pendingNames(others)}; pass --force to stop them\n`);
      return 1;
    }
    // Keep add/fire/finish outside the whole off operation, including sidecar
    // reap: a new schedule may then create its own fresh arm. The lease shutdown
    // is watch-sidecar.ts's offGuarded, called IN THIS PROCESS under this lock --
    // the lifetime the incumbent's `bash -c '. tap-watch.sh; _watch_off_guarded'`
    // spawn kept whole is kept whole here, minus the spawn.
    const rc = offGuarded(a);
    if (rc) return rc;
    if (pending.length && a.force) {
      process.stderr.write(`tap watch: warning: reminders will not fire until re-armed: ${pendingNames(pending)}\n`);
    }
    return 0;
  });
}

function parseInteger(raw: string, what: string): number {
  if (!/^[+-]?[0-9]+$/.test(raw.trim())) throw new Error(`${what} must be an integer`);
  return Number(raw.trim());
}

/** `TAP_WATCH_NOW` (an integer, refused otherwise) or the wall clock -- read once, before the action, on every door. */
export function currentTime(env: NodeJS.ProcessEnv = process.env): number {
  const override = env.TAP_WATCH_NOW;
  return override ? parseInteger(override, "TAP_WATCH_NOW") : Math.floor(Date.now() / 1000);
}

/** `add`'s parsed argv: `body` is the positional the caller gave (a path on the CLI door; a placeholder from the verb, which holds the text). */
export interface AddArgs { owner: string; to: string; body: string; after: number | null; at: number | null; every: number }

export function parseAdd(argv: string[]): AddArgs {
  const positionals: string[] = [];
  let after: number | null = null, at: number | null = null, every = 0;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === "--in") after = duration(value());
    else if (arg === "--at") at = parseInteger(value(), "--at");
    else if (arg === "--every") every = duration(value());
    else if (arg.startsWith("--")) throw new Error(`unrecognized argument ${arg}`);
    else positionals.push(arg);
  }
  if (positionals.length !== 3) throw new Error("add needs <owner> <to> <body-path>");
  if ((after === null) === (at === null)) throw new Error("add needs exactly one of --in or --at");
  return { owner: positionals[0]!, to: positionals[1]!, body: positionals[2]!, after, at, every };
}

/** Schedule one reminder under the queue lock: the row, the minimal lease when none exists, the publish; the new id. */
export function addReminder(state: string, args: AddArgs, body: string, now: number): string {
  return withLock(state, () => {
    const rows = readRows(state);
    if (!body.trim()) throw new Error("reminder body must not be empty");
    const dueAt = args.after !== null ? now + args.after : args.at!;
    if (!(dueAt >= 0 && dueAt <= 253402300799)) throw new Error("epoch is out of range");
    const ident = `remind-${randomBytes(8).toString("hex")}`;
    rows[ident] = { owner: args.owner, to: args.to, body, due_at: dueAt, every_seconds: args.every, status: "scheduled" };
    ensureArm(state, args.owner, now);
    publish(state, rows);
    return ident;
  });
}

/** Admit the command to the same queue before launching its one finite custodian. */
export function addCommand(state: string, owner: string, to: string, body: string, command: string, circle: number, fallback: string, cwd: string, env: NodeJS.ProcessEnv, unobservableExit?: number): string {
  const now = Math.floor(Date.now() / 1000);
  const id = withLock(state, () => {
    if (!body.trim() || !command.trim()) throw new Error("command and reminder body must not be empty");
    const rows = readRows(state), id = `remind-${randomBytes(8).toString("hex")}`;
    rows[id] = { owner, to, body, status: "scheduled", due_at: now + circle, every_seconds: 0,
      job: { command, cwd, fallback, circle_seconds: circle, started_at: now, heartbeat_at: now,
        phase: "starting", tail: "", pending: [], original_to: to, unobservable_exit: unobservableExit } };
    ensureArm(state, owner, now);
    publish(state, rows);
    return id;
  });
  launchCommand(state, id, env);
  return id;
}

/** Only the scheduling seat cancels its reminder; an occurrence already handed to transport is not retracted. */
export function cancelReminder(state: string, owner: string, id: string): void {
  withLock(state, () => {
    const rows = readRows(state);
    if (!(id in rows)) throw new Error("unknown reminder");
    if (rows[id]!.owner !== owner) throw new Error("only the scheduling seat can cancel this reminder");
    if (rows[id]!.job) { rows[id]!.status = "cancelled"; rows[id]!.job!.stopped = true; }
    else delete rows[id];
    publish(state, rows);
  });
}

/** `list`'s stdout: one human line per row, or one JSON array line with every field; "" for an empty queue in the human form. */
export function listText(state: string, json: boolean, team = ""): string {
  const rows = readUnderLockOrStale(state, () => readRows(state));
  if (json) return `${JSON.stringify(Object.entries(rows).map(([id, row]) => ({ id, ...row })))}\n`;
  return Object.entries(rows).map(([id, row]) => `${humanLine(id, row, team)}\n`).join("");
}

export function main(argv: string[]): number {
  const [state, action, ...rest] = argv;
  if (!state || !action) throw new Error("usage: remind.ts <state.json> <add|list|cancel|delay|fire|finish|off> ...");
  const now = currentTime();
  switch (action) {
    case "finish": {
      const supervision = rest.includes("--supervision");
      const [armAt] = rest.filter(arg => arg !== "--supervision");
      if (armAt === undefined || rest.length > 2) throw new Error("finish needs <arm_at> [--supervision]");
      finish(state, armAt, supervision);
      return 0;
    }
    case "fire": {
      if (rest.length !== 2) throw new Error("fire needs <scripts-dir> <arm_at>");
      fire(state, rest[0]!, rest[1]!, now);
      return 0;
    }
    case "off": {
      // The verb layer calls `off` in-process; this door is for controls.
      if (rest.length !== 5 || !["0", "1"].includes(rest[4]!)) throw new Error("off needs <bus> <scripts-dir> <registry> <actor> <0|1>");
      return off(state, { bus: rest[0]!, scripts: rest[1]!, registry: rest[2]!, actor: rest[3]!, force: rest[4] === "1", now: String(now) });
    }
    case "add": {
      const args = parseAdd(rest);
      // `readFileSync(path, "utf8")` keeps a leading BOM (node's utf8 decode does not
      // strip it); the verb's stdin door decodes its bytes the same way (rule 40).
      console.log(addReminder(state, args, readFileSync(args.body, "utf8"), now));
      return 0;
    }
    case "cancel": {
      if (rest.length !== 2) throw new Error("cancel needs <owner> <id>");
      const [owner, id] = rest as [string, string];
      cancelReminder(state, owner, id);
      return 0;
    }
    case "list": {
      if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--json")) throw new Error("list takes only --json");
      process.stdout.write(listText(state, rest[0] === "--json"));
      return 0;
    }
    case "delay": {
      if (rest.length !== 1) throw new Error("delay needs <interval>");
      const rows = readUnderLockOrStale(state, () => readRows(state));
      console.log(delay(rows, parseInteger(rest[0]!, "interval"), now));
      return 0;
    }
    default:
      throw new Error(`unknown action '${action}'`);
  }
}

if (import.meta.main) {
  try {
    process.exitCode = main(Bun.argv.slice(2));
  } catch (error) {
    process.stderr.write(`tap remind: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
