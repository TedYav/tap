// Chooser-specific ROW predicates for the register transaction, executed under
// its flock (seat_corpse.py's chooser path). Per the accepted narrowing these
// are only the generation-aware predicates that have no owner elsewhere: the
// observation itself rides observe-gather.ts's chooserView (the one gather over
// observe.ts's parsed pane/session facts), and the server epoch comes from the
// caller. Nothing here spawns a process or reads the clock. seat_corpse.py
// itself stays while the launcher, the SessionStart hook, lib.sh and the
// lockstep regress import it; register is the caller that went native.
// Fail-closed doctrine: absence requires the SERVER to have answered; a failed
// probe is never an observation of absence.
import { isPaneId } from "./lifecycle-target";
import type { JsonMap, JsonValue } from "./watch-detect";
import { pyStr } from "./watch-detect";

export const SEAT_ALIVE = "alive";
export const SEAT_PANE_RECYCLED = "pane_recycled";
export const SEAT_PANE_GONE = "pane_gone";
export const SEAT_UNOBSERVABLE = "unobservable";

function field(entry: JsonMap | null, key: string): JsonValue | undefined {
  return entry?.get(key);
}

function fieldStr(entry: JsonMap | null, key: string): string {
  const v = field(entry, key);
  return typeof v === "string" ? v : v === undefined || v === null ? "" : pyStr(v);
}

function isMap(v: JsonValue | undefined): v is JsonMap {
  return v instanceof Map;
}

function asMap(entry: JsonValue | null | undefined): JsonMap | null {
  return isMap(entry) ? entry : null;
}

/** Python truthiness for the truthy() checks the incumbent makes on fields. */
function truthy(v: JsonValue | undefined): boolean {
  if (v === undefined || v === null || v === false) return false;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "";
  if (v instanceof Map) return v.size > 0;
  return true;
}

function epochDisagrees(entry: JsonMap | null, epochNow: string | null): boolean {
  if (!entry) return false;
  const entryEpoch = field(entry, "server_epoch");
  return truthy(entryEpoch) && epochNow !== null && fieldStr(entry, "server_epoch") !== epochNow;
}

export function epochVoidedIds(entry: JsonMap | null, epochNow: string | null): [string, string] {
  const storedId = entry ? fieldStr(entry, "pane_id") : "";
  const pane = entry ? fieldStr(entry, "pane") : "";
  if (epochDisagrees(entry, epochNow)) return ["", ""];
  return [storedId, pane];
}

/** THE generation-aware identity predicate: a row stamped under a prior
 * generation stops matching; unstamped rows are plain string equality. The
 * address arm is OPT-IN — only sites that already had one pass it. */
export function samePaneIdentity(entry: JsonMap | null, observedPaneId: string, observedEpoch: string | null,
  observedPane?: string): boolean {
  if (!entry) return false;
  if (epochDisagrees(entry, observedEpoch)) return false;
  const storedId = fieldStr(entry, "pane_id");
  if (storedId) return Boolean(observedPaneId) && storedId === observedPaneId;
  if (observedPane === undefined) return false;
  return Boolean(observedPane) && fieldStr(entry, "pane") === observedPane;
}

/** Four-way classification of a seat's recorded pane facts; `observe` (the
 * caller's ChooserView) returns the pane id a target resolves to, "" when
 * OBSERVED absent, null when no observation could be made. The address is only
 * observed when the identity was observed absent, so a live seat costs one
 * lookup. */
export function classifyPane(storedId: string, pane: string,
  observe: (target: string) => string | null): string {
  if (storedId) {
    // The pane-id grammar is lifecycle-target.ts's shared predicate.
    if (!isPaneId(storedId)) return SEAT_UNOBSERVABLE;
    const identity = observe(storedId);
    if (identity === null) return SEAT_UNOBSERVABLE;
    if (identity) return SEAT_ALIVE;
    if (pane) {
      const address = observe(pane);
      if (address === null) return SEAT_UNOBSERVABLE;
      if (address === storedId) return SEAT_ALIVE;
      if (address) return SEAT_PANE_RECYCLED;
    }
    return SEAT_PANE_GONE;
  }
  if (pane) {
    const address = observe(pane);
    if (address === null) return SEAT_UNOBSERVABLE;
    if (address) return SEAT_ALIVE;
  }
  return SEAT_PANE_GONE;
}

export function isLaunchReservation(entry: JsonMap | null): boolean {
  if (!entry) return false;
  const status = field(entry, "status");
  if (status === "pending") return true;
  return status === "active" && field(entry, "status_reason") === "launching" &&
    truthy(field(entry, "launch_id"));
}

export interface ChooserObservation {
  /** ChooserView.paneIdOf — the pane id a target resolves to, "" when the
   *  snapshot observed the target absent, null when unverifiable. */
  paneIdOf(target: string): string | null;
  /** ChooserView.sessionOf — the live session name of a matched pane. */
  sessionOf(paneId: string): string;
}

/** Classify a registry entry's recorded pane facts through classifyPane over
 * the caller's chooser view, returning [verdict, livePaneId, liveSession].
 * Pure: the view and the server epoch are the caller's; an unknown epoch
 * (null) voids nothing. */
export function seatVerdict(entry: JsonValue | null | undefined,
  view: ChooserObservation, epochNow: string | null): [string, string, string] {
  let livePid = "", liveSession = "";
  const observe = (target: string): string | null => {
    const pid = view.paneIdOf(target);
    if (pid === null) return null;
    if (pid) { livePid = pid; liveSession = view.sessionOf(pid); }
    return pid;
  };
  const m = asMap(entry);
  const [storedId, pane] = epochVoidedIds(m, epochNow);
  const verdict = classifyPane(storedId, pane, observe);
  return [verdict, livePid, liveSession];
}
