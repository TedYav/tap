// The watch sidecar loop (`tap watch run`), migration slice W3: the last Bash
// body of tap-watch.sh -- `tap_watch_run` with `_watch_heartbeat` -- as one Bun
// process. While the lease exists: refresh the sources, stamp the heartbeat, run
// one tick, sleep. The entry that starts it is watch-run.ts, which computes the
// source stamp BEFORE this module (or anything it imports) is loaded, exactly as the
// incumbent snapshotted its sources before sourcing lib.sh; the loop then re-execs
// itself the moment that stamp changes, and a Bun `process.execve` keeps the PID the
// lease records and the tmux window owns, which is what "one re-exec with the lease
// carried" means. Nothing here is a decision the incumbent did not make; the three
// ratified departures are named at their lines.
//
// The tick stays a CHILD (`bun watch-tick-run.ts tick`, the incumbent's exact door):
// the child always executes the installed bytes, the loop never runs the tick's
// state twice in one process. The long-lived loop retains GC filename snapshots
// across ticks (architect / the migration partner, W3 F2).
//
// Replayed against a frozen capture of the incumbent loop at f4099de37
// (runtime/bun/test/fixtures/watch-run-oracle.json, taken by the since-retired
// capture harness): every door the loop called, in order, with
// its arguments, plus the status, stderr, the heartbeat file's mtime and the record.

import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { delayFor } from "./remind";
import { cmdSubst } from "./watch-detect";
import { fieldValue, isFile, readLoose, set as leaseSet } from "./watch-lease";
import { armPath } from "./watch-notice";
import { WATCHER_COMMAND } from "./watch-sidecar";
import { checkWatchStop, watchChild, watchSleep } from "./watch-child";
import { SpoolGcCursor } from "./spool-gc";
import { bunBinary } from "./courier-argv";
import { maybeStartBusMaintenance } from "./bus-maintenance-trigger";
import { ownBunArgv } from "./own-bun";

/** `tap_watch_run`'s fallback when the record carries no interval. */
export const DEFAULT_INTERVAL = 60;

/**
 * A reminder queue the loop cannot READ -- the file (not JSON, unreadable) or its
 * lock (a symlink where the lock should be): the one failure of the delay door the
 * loop degrades on (tap-r9rrc). The seam throws it with the queue's path in front of
 * remind's own reason. Anything else the door throws (the injected clock refused, a
 * harness door that printed no number) is not a queue and ends the loop as before.
 */
export class QueueUnreadable extends Error {}

/** How the loop ended: `tap_watch_run`'s status (0: the lease is gone or a signal; 1: refused). */
export interface LoopExit { status: number }

export interface LoopSeams {
  close?(): void;
  /** Source refresh (ported from the retired Bash `tap_sidecar_source_refresh`): null to continue; an exit when the sources cannot be read (the real seam never returns on a change: it re-execs). */
  refresh(): LoopExit | null;
  /** `tap_watch_is_armed`: `[ -f arm.json ]`. */
  armed(): boolean;
  /** `_watch_heartbeat`: the heartbeat file (fatal when it cannot be truncated: the incumbent ran under `set -e`), then the mtime and the lease write, best-effort. */
  heartbeat(now: string): LoopExit | null;
  /** `tap_watch_field tick_interval_seconds`: the record's text, "" when absent. */
  interval(): string;
  /** `tap_watch_tick || true`: the status is not the loop's. */
  tick(): void | Promise<void>;
  /** `[ -f "$TAP_HOME/watch/reminders.json" ]`. */
  remindersPresent(): boolean;
  /** `tap_bun_call remind delay remind.ts <reminders> delay <interval>`: the seconds until the next reminder, at most the interval; throws QueueUnreadable for a queue it cannot read (the loop announces it and sleeps the interval it already parsed), anything else for a failure that still ends the loop. */
  remindDelay(interval: number): number;
  /** `sleep "$interval" & wait`: interruptible; the signal handlers end the process with 0 (the incumbent's trap). */
  sleep(seconds: number): Promise<void>;
  /** `_watch_now`: the injected clock, else the wall clock. */
  now(): string;
  stderr(line: string): void;
}

/**
 * The record's interval: an optionally signed run of ASCII digits and nothing else --
 * the bytes `--interval` writes. No trimming: a padded, BOM'd or NBSP'd value is a
 * hand edit the loop names on one line rather than a parse that quietly succeeds
 * (leader ruling, UNTRIMMED confirmed; remind.ts's own parser trims, and
 * that is its door's rule-40 row, not this one's). Null for anything else; the caller
 * refuses zero and negatives.
 */
export function parseInterval(raw: string): number | null {
  return /^[+-]?[0-9]+$/.test(raw) ? Number(raw) : null;
}

/** `tap_watch_run`: 0 when the lease is gone, 1 when the loop refused to go on. */
export async function runLoop(s: LoopSeams, signal?: AbortSignal): Promise<number> {
  try { return await loopBody(s, signal); } finally { s.close?.(); }
}

async function loopBody(s: LoopSeams, signal?: AbortSignal): Promise<number> {
  for (;;) {
    checkWatchStop(signal);
    const refused = s.refresh();
    if (refused) return refused.status;
    if (!s.armed()) return 0;
    const dead = s.heartbeat(s.now());
    if (dead) return dead.status;
    const raw = s.interval();
    let interval = DEFAULT_INTERVAL;
    if (raw !== "") {
      const parsed = parseInterval(raw);
      // DEVIATION (W3 F6a, RATIFIED by the leader): the incumbent
      // handed the record's text to `sleep` unparsed -- `abc` failed at once and
      // `wait … || true` swallowed it (a tight loop hammering the tick), `1.5` slept, `0`
      // slept nothing (another tight loop), and with a reminders file present remind.ts's
      // integer parser refused every non-integer and ENDED the loop with the lease armed
      // and silent. `--interval` already refuses anything but a positive integer at arm
      // time, so every cell outside the integer column is a hand edit or corruption: one
      // grammar for the one field, applied before the reminder door in both columns, and
      // a loop that keeps going -- anything else says so once and sleeps the default.
      if (parsed === null || parsed <= 0) {
        s.stderr(`tap watch: tick_interval_seconds must be a positive integer: ${JSON.stringify(raw)}; sleeping ${DEFAULT_INTERVAL}`);
      } else {
        interval = parsed;
      }
    }
    await s.tick();
    checkWatchStop(signal);
    if (!s.armed()) return 0;
    if (s.remindersPresent()) {
      // DEVIATION (tap-r9rrc; the class the W3 interval ruling named,
      // leader ruling): the incumbent's `|| return 1` ENDED the
      // loop when the reminder queue could not be read -- lease kept, nothing behind it,
      // `tap health` the only thing that notices. A queue the loop cannot read now
      // DEGRADES the tick: one `tap watch:` line from this loop naming the file and the
      // reason (the real seam prefixes the path), the record's own interval slept, and
      // the loop goes on -- the reminders wait, the watcher does not end. One rule for
      // every way the QUEUE can be unreadable, a symlinked lock path included; the tick
      // child's own reminders pass refuses the same queue first and says so on its own
      // line (watch-tick-run.ts, the tick's status is not the loop's), so an operator
      // reading the sidecar window sees two lines per cycle, one per door. A loop that
      // keeps heartbeating is what leaves the failure observable. `tap remind list`
      // reads the queue through the same helper, so what it refuses and what this line
      // names agree. Any OTHER failure of the door still ends the loop as the incumbent
      // did -- the injected clock refused is not a queue.
      try {
        interval = s.remindDelay(interval);
      } catch (error) {
        if (!(error instanceof QueueUnreadable)) {
          s.stderr(`tap watch: reminders: ${(error as Error).message}`);
          return 1;
        }
        s.stderr(`tap watch: reminders: ${error.message}; sleeping ${interval}`);
      }
    }
    await s.sleep(interval);
  }
}

export interface RealLoopArgs {
  bus: string;
  /** `skills/tap/scripts`: the tick's scripts directory. */
  scripts: string;
  /** `runtime/bun/src`: where the tick entry lives. */
  src: string;
  /** The entry that re-execs: watch-run.ts hands its own refresh in, computed over the stamp it took before loading this module. */
  refresh: () => LoopExit | null;
  env?: NodeJS.ProcessEnv;
  /** Where the loop's own lines go (the replay records them); the process's stderr by default. */
  stderr?: (line: string) => void;
  signal?: AbortSignal;
}

/** The largest single timer Bun (and Node) honours; a longer sleep is chained, never truncated to an instant. */
const MAX_TIMER_MS = 2_147_483_647;

export function realLoopSeams(a: RealLoopArgs): LoopSeams {
  const env = a.env ?? process.env;
  const bus = a.bus;
  const arm = armPath(bus);
  const reminders = join(bus, "watch", "reminders.json");
  const heartbeat = join(bus, "watch", "heartbeat");
  const now = (): string => env.TAP_WATCH_NOW || String(Math.floor(Date.now() / 1000));
  const stderr = a.stderr ?? ((line: string): void => { process.stderr.write(line + "\n"); });
  const gc = new SpoolGcCursor(bus, env);
  return {
    close: () => gc.close(),
    refresh: a.refresh,
    armed: () => isFile(arm),   // `[ -f ]`: a directory at the lease's path is not a lease
    heartbeat: (n) => {
      // `mkdir -p "$TAP_HOME/watch"` and `: > "$heartbeat"` ran bare in a loop the verb
      // dispatched under `set -e`: a heartbeat that cannot be truncated (a directory at
      // its path, an unwritable file) ended the incumbent with 1 before the tick, lease
      // retained, for health to report (the capture
      // now calls the loop the way the dispatch did). The mtime (`touch -t … || touch`)
      // and the record (`… || true`) stay best-effort.
      try {
        mkdirSync(join(bus, "watch"), { recursive: true });
        writeFileSync(heartbeat, "");
      } catch (error) {
        stderr(`tap watch: heartbeat: ${(error as Error).message}`);
        return { status: 1 };
      }
      try {
        const at = /^[0-9]+$/.test(n) ? Number(n) : Math.floor(Date.now() / 1000);
        utimesSync(heartbeat, at, at);
      } catch { /* `touch` after a successful truncate: the incumbent's fallback, not its exit */ }
      try {
        leaseSet(arm, ["heartbeat_at", n, "heartbeat_path", heartbeat, "watcher_pid", String(process.pid), "watcher_command", WATCHER_COMMAND], env);
      } catch { /* `>/dev/null 2>&1 || true` */ }
      return null;
    },
    interval: () => { try { return cmdSubst(fieldValue(readLoose(arm), "tick_interval_seconds")); } catch { return ""; } },
    tick: async () => {
      maybeStartBusMaintenance(bus, env, false);
      // `_watch_bun_run watch-tick-run.ts tick`: the same bun that runs the loop, the
      // tick's stdio inherited, its status ignored (`|| true`).
      let batch;
      try { batch = gc.next(); } catch (error) { stderr(`tap spool cleanup: ${String(error)}`); }
      await watchChild([...ownBunArgv(bunBinary()), join(a.src, "watch-tick-run.ts"), "tick"],
        { ...env, TAP_SPOOL_GC_BATCH: JSON.stringify(batch ?? { sidecars: [], digests: [], paneEffects: [] }) }, a.signal, "tick");
    },
    remindersPresent: () => isFile(reminders),
    remindDelay: (interval) => {
      const clock = now();
      if (!/^[+-]?[0-9]+$/.test(clock.trim())) throw new Error("TAP_WATCH_NOW must be an integer");
      // The loop's line names the FILE (tap-r9rrc): remind's own reasons -- a parse
      // error, a refused lock path -- carry no path of their own. Only the queue read
      // is the degradable class; the clock check above stays a plain refusal.
      try {
        return delayFor(reminders, interval, Number(clock.trim()));
      } catch (error) {
        throw new QueueUnreadable(`${reminders}: ${(error as Error).message}`);
      }
    },
    sleep: async (seconds) => {
      let remaining = seconds * 1000;
      while (remaining > 0) {
        const chunk = Math.min(remaining, MAX_TIMER_MS);
        await watchSleep(chunk, a.signal);
        remaining -= chunk;
      }
    },
    now,
    stderr,
  };
}
