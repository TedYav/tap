// `--recent` on `tap team` and `tap teams`: order seats, and teams, by when each was last used,
// so after a restart or a resume the operator sees which teams and seats they were working with.
//
// ONE RULE, shared with `tap team refresh --stale` (stale.ts): a seat's last activity is
// offlineActivity's answer (the later of its transcript's newest dated record and last_launched,
// else exited_at, else registered_at; the transcript file's mtime never counts), raised to the
// roster's dated turn end when that is later. A seat the roster sees working is active now.
// A team is as recent as its most recent seat, crews included. Undated rows sort last, never fail.
import { TapError } from "../context";
import { offlineActivity, type ActivityReader } from "./stale";

type Row = Record<string, unknown>;

/** When a seat or team was last active, epoch seconds, and the witness: working, turn end, or offlineActivity's source. */
export interface LastActive { at: number; source: string }

/** What the roster observed of the seat: whether it is working now, and its dated turn end if any. */
export interface LiveFacts { working: boolean; turnEndedAt?: number | null }

export const WORKING = "working";

/** Epoch seconds a Date can hold (±8.64e15 ms). Anything else, or a non-finite value, is undated. */
const datable = (at: number | null | undefined): at is number =>
  typeof at === "number" && Number.isFinite(at) && Math.abs(at) <= 8.64e12;

/**
 * Pure apart from `transcript`, which a working seat never reaches. A source whose date no Date can
 * hold (an OpenCode message created at 9e15 ms, say) counts as undated, so one bad row degrades to its
 * other evidence in every view instead of aborting the listing.
 */
export function seatLastActive(stored: Row, live: LiveFacts, transcript: ActivityReader, now: number): LastActive | null {
  if (live.working) return { at: now, source: WORKING };
  const dated = offlineActivity(stored, row => { const at = transcript(row); return datable(at) ? at : null; });
  const ended = live.turnEndedAt;
  if (datable(ended) && (!dated || ended > dated.at)) return { at: ended, source: "turn end" };
  return dated;
}

/** The most recent of several activities (a team over its seats); null when none is dated. A working seat wins. */
export function latestActivity(activities: Iterable<LastActive | null>): LastActive | null {
  let best: LastActive | null = null;
  for (const activity of activities) if (activity && (!best || byRecency(activity, best) < 0)) best = activity;
  return best;
}

/** Working is its own first tier, ahead of any date (a skewed or later-captured clock never outranks it); then most recent; undated last. */
const tier = (a: LastActive | null): number => (a === null ? 2 : a.source === WORKING ? 0 : 1);
const byRecency = (a: LastActive | null, b: LastActive | null): number =>
  tier(a) - tier(b) || (tier(a) === 1 ? b!.at - a!.at : 0);

/**
 * Working first, then most recent, undated last; `tieBreak` orders the rest by name so the output is
 * deterministic. `count` keeps the first n rows after the sort, like `head -n`. Each row's activity is
 * computed once.
 */
export function recentOrder<T>(rows: readonly T[], activityOf: (row: T) => LastActive | null,
  tieBreak: (a: T, b: T) => number, count?: number): Array<{ row: T; active: LastActive | null }> {
  const dated = rows.map(row => ({ row, active: activityOf(row) }));
  dated.sort((a, b) => byRecency(a.active, b.active) || tieBreak(a.row, b.row));
  return count === undefined ? dated : dated.slice(0, count);
}

// --- -n <n> ------------------------------------------------------------------------

const usage = (action: string, detail: string): never => { throw new TapError(1, "usage_error", action, detail); };

/**
 * Lift `-n <n>` out of argv, refusing a glued spelling (-n5, -n=5), a missing value and anything but a
 * positive integer; the last -n wins. -n takes the word typed after it, and an option word there is a
 * missing value. Run it on takeSeatFilters' rest with `-n` among its pass-through flags, so -n keeps its
 * typed neighbour; `passValues` are the verb's own value flags, kept here with their words. Stops at `--`.
 */
export function takeCount(argv: readonly string[], action: string, passValues: readonly string[] = []): { count: number | undefined; rest: string[] } {
  let count: number | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") { rest.push(...argv.slice(i)); break; }
    if (arg === "-n") {
      const value = argv[++i];
      // A negative number is a bad value rather than an option.
      if (value === undefined || (value.startsWith("-") && !/^-[0-9]/.test(value))) usage(action, "-n needs a positive integer: the number of rows to keep, e.g. -n 15");
      const n = /^[0-9]+$/.test(value!) ? Number(value) : NaN;
      if (!Number.isSafeInteger(n) || n < 1) usage(action, `-n must be a positive integer, got '${value}'`);
      count = n;
    } else if (/^-n./.test(arg)) usage(action, "-n takes its value as a separate word: -n <n>");
    else {
      rest.push(arg);
      if (passValues.includes(arg) && i + 1 < argv.length && argv[i + 1] !== "--") rest.push(argv[++i]!);
    }
  }
  return { count, rest };
}

/** The -n count once the verb's own options are parsed: it limits a --recent listing only. */
export function recentCount(count: number | undefined, recent: boolean, action: string): number | undefined {
  if (count !== undefined && !recent) usage(action, "-n limits a --recent listing; add --recent");
  return count;
}
