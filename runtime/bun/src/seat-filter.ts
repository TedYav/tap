// The seat filters every seat list shares: `--harness`, `--model`, `--state`.
// One parser and one predicate, so `tap team`, `tap teams`, `tap crew list`,
// `tap admin ps` and `tap session list` cannot disagree on what a value means.
// Items within a flag OR; different flags AND. Each list adapts its own rows to
// SeatFacts and owns what a fact it cannot observe does there.
import { TapError } from "./context";
import { AGENT_FAMILIES } from "./harness-families";
import { prettyModelName } from "./model-names";
import { DEFAULT_STALE_AFTER } from "./roster-stalled";

/** Every state the roster's state column can show. */
export const SEAT_STATES = ["working", "blocked", "error", "idle", "waiting", "booting", "overprint", "unknown", "unsubmitted", "incapable", "unbound", "offline", "ready"] as const;
export type SeatState = typeof SEAT_STATES[number];
/** `--state` values: the displayed states plus the meta state `active`. */
export const SEAT_STATE_VALUES: readonly string[] = [...SEAT_STATES, "active"];
/** `--harness` values: `tap nudge --harness`'s families, plus the roster's displayed `daemon`. */
export const SEAT_HARNESS_VALUES: readonly string[] = [...AGENT_FAMILIES, "daemon"];
/** Lifecycle states that are not live, so `active` never keeps them. */
const NOT_LIVE: ReadonlySet<string> = new Set(["offline", "incapable", "unbound"]);

export interface SeatFilters { harness: string[]; model: string[]; state: string[] }
type FilterName = keyof SeatFilters;

export interface SeatFacts {
  harness: string;
  /** Delivery by polling or the daemon harness: the roster shows `daemon`. */
  daemon?: boolean;
  /** Raw model ids this seat is known by: observed and launch. */
  models: readonly (string | null | undefined)[];
  /** The displayed state; lists without one refuse `--state` before reaching here. */
  state: string;
  /** Seconds since a dated turn end for an idle seat; null when nothing dates it. */
  idleSeconds: number | null;
}

const FLAG = /^--(harness|model|state)(?:=(.*))?$/s;

export const emptySeatFilters = (): SeatFilters => ({ harness: [], model: [], state: [] });
export const isSeatFilterFlag = (arg: string): boolean => FLAG.test(arg);
export const hasSeatFilters = (filters: SeatFilters): boolean => filters.harness.length + filters.model.length + filters.state.length > 0;
/** The roster clock: pinned by TAP_WATCH_NOW in tests, wall time otherwise. */
export const seatClock = (): number => Number(process.env.TAP_WATCH_NOW || Math.trunc(Date.now() / 1000));

/** One flag's comma list, trimmed and lowercased. */
export const commaItems = (value: string): string[] => value.split(",").map(item => item.trim().toLowerCase()).filter(Boolean);

/** A flag's items, refusing an empty list or a bad `--harness` or `--state` value. */
function seatFilterItems(name: FilterName, value: string, help: string): string[] {
  const items = commaItems(value);
  if (!items.length) throw new TapError(1, "usage_error", help, `--${name} needs a comma list of values`);
  const valid = name === "harness" ? SEAT_HARNESS_VALUES : name === "state" ? SEAT_STATE_VALUES : null;
  const bad = valid && items.find(item => !valid.includes(item));
  if (bad) throw new TapError(1, "usage_error", help, `--${name} '${bad}' is not a supported ${name === "harness" ? "harness" : "seat state"} (one of: ${valid.join(", ")})`);
  return items;
}

/**
 * Removes `--harness`, `--model` and `--state` from argv, so each verb's own parser sees only its flags.
 * `passValues` names the verb's other value flags: each stays in `rest` with the word typed after it,
 * whatever that word is, so lifting a filter never makes an unrelated word that flag's value.
 */
export function takeSeatFilters(argv: readonly string[], help: string, passValues: readonly string[] = []): { filters: SeatFilters; rest: string[] } {
  const filters = emptySeatFilters(), rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") { rest.push(...argv.slice(i)); break; }
    if (passValues.includes(arg)) {
      rest.push(arg);
      if (i + 1 < argv.length && argv[i + 1] !== "--") rest.push(argv[++i]!);
      continue;
    }
    const match = FLAG.exec(arg);
    if (!match) { rest.push(arg); continue; }
    const name = match[1] as FilterName;
    const value = match[2] ?? argv[++i];
    // An inline value keeps its text; a split operand that is itself an option is a missing value.
    if (value === undefined || (match[2] === undefined && value.startsWith("-"))) throw new TapError(1, "usage_error", help, `--${name} needs a comma list of values`);
    filters[name].push(...seatFilterItems(name, value, help));
  }
  return { filters, rest };
}

/** The roster's state column for one seat. */
export function displayState(seat: { status: string; statusReason: string; agentState: string; agentStateReason: string; daemon: boolean }): SeatState {
  if (seat.daemon && seat.status === "active") return "ready";
  if (seat.status === "suspended" && seat.statusReason === "incapable") return "incapable";
  if (seat.status === "active") return (seat.agentStateReason === "sentinel_unsubmitted" ? "unsubmitted" : seat.agentState) as SeatState;
  return seat.status === "unbound" ? "unbound" : "offline";
}

/** Age of an idle seat's dated turn end; every other state, and an undated idle, has none. */
export function idleSeconds(state: string, turnEndedAt: number | null | undefined, now: number): number | null {
  return state === "idle" && turnEndedAt != null && Number.isFinite(turnEndedAt) ? now - turnEndedAt : null;
}

const anyOf = (items: string[], test: (item: string) => boolean): boolean => !items.length || items.some(test);

function matchesHarness(item: string, seat: SeatFacts): boolean {
  const harness = seat.harness.toLowerCase();
  // Family match, as `tap nudge --harness` reads it: `claude` covers `claude-code`.
  return harness === item || harness.startsWith(`${item}-`) || (item === "daemon" && seat.daemon === true);
}

function matchesModel(item: string, seat: SeatFacts): boolean {
  return seat.models.some(model => !!model && (model.toLowerCase().includes(item) || prettyModelName(model).toLowerCase().includes(item)));
}

/** `active` is every live seat except one idle for the `--stalled` default or longer. An undated idle
 * seat stays active: it cannot be shown stale. */
function matchesState(item: string, seat: SeatFacts): boolean {
  if (item !== "active") return seat.state === item;
  if (NOT_LIVE.has(seat.state)) return false;
  return seat.state !== "idle" || seat.idleSeconds === null || seat.idleSeconds < DEFAULT_STALE_AFTER;
}

export function seatMatches(filters: SeatFilters, seat: SeatFacts): boolean {
  return anyOf(filters.harness, item => matchesHarness(item, seat))
    && anyOf(filters.model, item => matchesModel(item, seat))
    && anyOf(filters.state, item => matchesState(item, seat));
}
