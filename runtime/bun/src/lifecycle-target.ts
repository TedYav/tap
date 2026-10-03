// Lane C exported surface: generic target resolution, per-seat grammar, and the
// durable out/down/up/shutdown matrix.
//
// Per-seat `shutdown` and `out --hard` share HARD_REMOVAL as a mechanism.
// The requested public verb stays on the disposition (`action`), never on the
// shared fate object — receipts must not render out --hard as shutdown.
// Team-wide shutdown is a separate historic no-tombstone path; team out
// retires selected parent families under distinct plain and hard fates. Crew
// window effects consume D's callable contract and are not implemented here — a
// `crew: true` row is still a seat for grammar and name resolution; this
// module never lists windows or edits the launcher. Crew dismiss tmux fate
// is `none`: the crew is a window on the driver/operator session, and
// `stop-named-sessions` would stop that shared session (2026-08-23/24).

import { validToken } from "./ids";

/** `%` plus decimal digits — bash `tap_is_pane_id` / python `seat_corpse.is_pane_id`. */
export function isPaneId(value: unknown): value is string {
  if (typeof value !== "string" || value[0] !== "%") return false;
  const rest = value.slice(1);
  return rest.length > 0 && /^[0-9]+$/.test(rest);
}

/** Canonical tmux session name. Slash form only — colon is input-only legacy. */
export function canonicalSessionName(team: string, handle: string): string {
  return `${team}/${handle}`;
}

export type SeatTarget =
  | { ok: true; team: string; handle: string; qualified: boolean; delimiter: "/" | ":" | null }
  | { ok: false; errorClass: "usage_error"; detail: string };

/**
 * Parse a seat token the way `tap_valid_qualified_token` does: bare handle,
 * `team/handle`, or input-only `team:handle`. Mixed or nested delimiters refuse.
 * The acting team fills a bare handle; it never overwrites an explicit team.
 */
export function parseSeatTarget(raw: string, actingTeam: string): SeatTarget {
  if (!raw) {
    return { ok: false, errorClass: "usage_error", detail: "empty seat target" };
  }
  if (/[:].*[/]|[/].*:/.test(raw)) {
    return {
      ok: false,
      errorClass: "usage_error",
      detail: `seat target '${raw}' mixes ':' and '/'`,
    };
  }
  if (raw.includes("/")) {
    const team = raw.slice(0, raw.indexOf("/"));
    const handle = raw.slice(raw.indexOf("/") + 1);
    if (!team || !handle || handle.includes("/")) {
      return { ok: false, errorClass: "usage_error", detail: `seat target '${raw}' is not team/handle` };
    }
    if (!validToken(team) || !validToken(handle)) {
      return { ok: false, errorClass: "usage_error", detail: `seat target '${raw}' fails charset` };
    }
    return { ok: true, team, handle, qualified: true, delimiter: "/" };
  }
  if (raw.includes(":")) {
    const team = raw.slice(0, raw.indexOf(":"));
    const handle = raw.slice(raw.indexOf(":") + 1);
    if (!team || !handle || handle.includes(":")) {
      return { ok: false, errorClass: "usage_error", detail: `seat target '${raw}' is not team:handle` };
    }
    if (!validToken(team) || !validToken(handle)) {
      return { ok: false, errorClass: "usage_error", detail: `seat target '${raw}' fails charset` };
    }
    return { ok: true, team, handle, qualified: true, delimiter: ":" };
  }
  if (!validToken(raw)) {
    return { ok: false, errorClass: "usage_error", detail: `handle '${raw}' fails charset` };
  }
  if (!actingTeam) {
    return { ok: false, errorClass: "usage_error", detail: "bare handle needs an acting team" };
  }
  if (!validToken(actingTeam)) {
    return { ok: false, errorClass: "usage_error", detail: `acting team '${actingTeam}' fails charset` };
  }
  return { ok: true, team: actingTeam, handle: raw, qualified: false, delimiter: null };
}

export type HandleListParse =
  | { ok: true; handles: string[] }
  | { ok: false; errorClass: "usage_error"; detail: string };

/**
 * `--except` / `--only` tokenizer. Handles are bare and team-local: a
 * `team/handle` form is usage_error, not a silently unmatched name. Duplicates
 * dedupe in first-seen order. The complement is never precomputed.
 */
export function parseBareHandleList(raw: string, flag: "--except" | "--only"): HandleListParse {
  const what = flag === "--only" ? "act on" : "spare";
  if (!raw) {
    return {
      ok: false,
      errorClass: "usage_error",
      detail: `${flag} was given an empty value; name at least one handle to ${what}`,
    };
  }
  const parts = raw.split(",");
  const seen = new Set<string>();
  const handles: string[] = [];
  for (const tok of parts) {
    if (!tok) {
      return {
        ok: false,
        errorClass: "usage_error",
        detail: `${flag} '${raw}' has an empty handle between commas`,
      };
    }
    if (tok.includes("/") || tok.includes(":")) {
      return {
        ok: false,
        errorClass: "usage_error",
        detail: `${flag} takes bare handles from THIS team; '${tok}' is team-qualified`,
      };
    }
    if (!validToken(tok)) {
      return {
        ok: false,
        errorClass: "usage_error",
        detail: `${flag} handle '${tok}' fails charset`,
      };
    }
    if (seen.has(tok)) continue;
    seen.add(tok);
    handles.push(tok);
  }
  return { ok: true, handles };
}

export type SelectMode = "except" | "only" | "all";

/** Per-row spare predicate. `--only` spares unnamed seats; `--except` spares named ones. */
export function seatSpared(handle: string, mode: SelectMode, named: ReadonlySet<string>): boolean {
  if (mode === "only") return !named.has(handle);
  if (mode === "except") return named.has(handle);
  return false;
}

export function unmatchedHandles(named: readonly string[], roster: readonly string[]): string[] {
  const live = new Set(roster);
  return named.filter((h) => !live.has(h));
}

export type DestructiveRefuseReason =
  | "pane_identity_missing"
  | "session_name_gone"
  | "pane_live_elsewhere"
  | "server_epoch_unproven";

export type TargetDecision =
  | { ok: true; session: string }
  | { ok: false; reason: DestructiveRefuseReason };

/**
 * Injected tmux observation. Callers that already hold a snapshot pass it so a
 * later team-stop engine can keep one observation per run. `hasSession` matches
 * today's bash/python existence oracle (`tmux has-session -t "=<name>"`): a
 * failed probe is absence, not a distinct unobservable cell.
 */
export interface LifecycleTmux {
  hasSession(name: string): boolean;
  /** Live session that currently owns this pane id, or null when the tip is gone. */
  paneSession(paneId: string): string | null;
  sessionPaneIds(name: string): string[];
}

/**
 * The one adapter from a pane snapshot to the predicate's tmux view.
 *
 * `destructiveSessionTarget` asks three questions, and every caller answered
 * them by writing the same three closures over its own snapshot. That was two
 * copies and about to be three (lane T's stop / detach / reset), so it is one
 * function now.
 *
 * The parameter is STRUCTURAL rather than `SeatSnapshot`: the rows live in
 * another lane's module, and a shared adapter should not drag an import across
 * that seam to describe the two fields it reads. Anything with `panes` of
 * `{ id, session }` fits, including a fixture that never called tmux.
 *
 * Note what this does NOT do: it answers every question from ONE snapshot, so
 * all three describe the same instant. That is the property a destructive
 * transaction needs -- a plan built from one snapshot and an effect authorized
 * by a fresh one are different instants ON PURPOSE, and slipping a live query
 * in here would erase that distinction without anyone noticing.
 */
export function snapshotTmux(snapshot: { panes: readonly { id: string; session: string }[] }): LifecycleTmux {
  return {
    hasSession: name => snapshot.panes.some(p => p.session === name),
    paneSession: id => snapshot.panes.find(p => p.id === id)?.session ?? null,
    sessionPaneIds: name => snapshot.panes.filter(p => p.session === name).map(p => p.id),
  };
}

function paneLiveElsewhere(
  tmux: LifecycleTmux,
  paneId: string,
  expected: string,
): boolean {
  const tip = tmux.paneSession(paneId);
  if (tip === null) return false;
  if (tip === expected) return false;
  return !tmux.sessionPaneIds(expected).includes(paneId);
}

/**
 * Name-first stop-target derivation. Authorize iff:
 *   1. stored pane_id is in-grammar;
 *   2. row.session exactly equals caller-derived expected name;
 *   3. that name is live;
 *   4. the stored pane id is not alive in a different session.
 *
 * A gone tip does not block name-keyed stop. Epoch stamps do not gate
 * authorization. Reasons match the shell twin, including the name-mismatch
 * arm that still reports `pane_live_elsewhere` when the stored id is live on
 * a foreign session while the expected name is live (E2).
 */
export function destructiveSessionTarget(
  entry: { pane_id?: unknown; session?: unknown },
  expectedSession: string | null | undefined,
  tmux: LifecycleTmux,
): TargetDecision {
  if (!isPaneId(entry.pane_id)) {
    return { ok: false, reason: "pane_identity_missing" };
  }
  const paneId = entry.pane_id;
  const expected = typeof expectedSession === "string" ? expectedSession : "";
  const rowSession = typeof entry.session === "string" ? entry.session : "";
  if (!expected || rowSession !== expected) {
    if (expected && tmux.hasSession(expected) && paneLiveElsewhere(tmux, paneId, expected)) {
      return { ok: false, reason: "pane_live_elsewhere" };
    }
    return { ok: false, reason: "server_epoch_unproven" };
  }
  if (!tmux.hasSession(expected)) {
    return { ok: false, reason: "session_name_gone" };
  }
  if (paneLiveElsewhere(tmux, paneId, expected)) {
    return { ok: false, reason: "pane_live_elsewhere" };
  }
  return { ok: true, session: expected };
}

export type RegistryFate = "retain" | "suspend-rows" | "resume-rows" | "delete-row" | "delete-acting-file";
export type TmuxFate = "none" | "stop-named-sessions" | "relaunch";
export type RecoveryDoor = "none" | "tap-up" | "tap-team-up" | "tap-init";
export type CrewEffect = "none" | "consume-d-contract";
export type LifecycleScope = "seat" | "team" | "crew";
export type LifecycleVerb = "out" | "out-hard" | "down" | "up" | "shutdown";
export type MechanismId =
  | "seat-out"
  | "seat-down"
  | "seat-up"
  | "hard-removal"
  | "team-down"
  | "team-up"
  | "team-shutdown"
  | "team-out"
  | "team-out-hard"
  | "crew-dismiss";

/** Shared fate. Mechanism identity only — never the invoked public verb. */
export interface DurableFate {
  readonly mechanism: MechanismId;
  readonly scope: LifecycleScope;
  readonly registry: RegistryFate;
  readonly tmux: TmuxFate;
  readonly recovery: RecoveryDoor;
  readonly crews: CrewEffect;
}

export type LifecycleDisposition =
  | { ok: true; action: LifecycleVerb; row: DurableFate }
  | { ok: false; errorClass: "usage_error"; detail: string };

export interface LifecycleReceipt {
  lifecycle_action: LifecycleVerb;
  mechanism: MechanismId;
  registry_fate: RegistryFate;
}
export function lifecycleReceipt(disposition: Extract<LifecycleDisposition, { ok: true }>): LifecycleReceipt {
  return { lifecycle_action: disposition.action, mechanism: disposition.row.mechanism, registry_fate: disposition.row.registry };
}

/**
 * Durable out/down/up/shutdown matrix, extended for selected team out families.
 * The public owners consume these fates; this table contains no effects.
 *
 * Seat rows are the four distinct operations. Per-seat `shutdown` and
 * `out --hard` SHARE one hard-removal object. Team-wide verbs keep team scope
 * (shutdown still historic no-tombstone). Crew `up`/`down` refuse; generic crew
 * `out`/`shutdown` dismiss process and row via D's contract. Owner `up` never
 * recreates crews (`crews: "none"`).
 */
const HARD_REMOVAL = {
  mechanism: "hard-removal",
  scope: "seat",
  registry: "delete-row",
  tmux: "stop-named-sessions",
  recovery: "none",
  crews: "consume-d-contract",
} as const satisfies DurableFate;

const CREW_DISMISS = {
  mechanism: "crew-dismiss",
  scope: "crew",
  registry: "delete-row",
  tmux: "none",
  recovery: "none",
  crews: "consume-d-contract",
} as const satisfies DurableFate;

const CREW_EPHEMERAL =
  "crew seats are ephemeral; tap crew shutdown dismisses a live crew";

export const DURABLE_MATRIX = {
  out: {
    mechanism: "seat-out",
    scope: "seat",
    registry: "delete-row",
    tmux: "none",
    recovery: "none",
    crews: "none",
  },
  down: {
    mechanism: "seat-down",
    scope: "seat",
    registry: "suspend-rows",
    tmux: "stop-named-sessions",
    recovery: "tap-up",
    crews: "consume-d-contract",
  },
  up: {
    mechanism: "seat-up",
    scope: "seat",
    registry: "resume-rows",
    tmux: "relaunch",
    recovery: "none",
    crews: "none",
  },
  shutdown: HARD_REMOVAL,
  "out-hard": HARD_REMOVAL,
  "team-down": {
    mechanism: "team-down",
    scope: "team",
    registry: "suspend-rows",
    tmux: "stop-named-sessions",
    recovery: "tap-team-up",
    crews: "consume-d-contract",
  },
  "team-up": {
    mechanism: "team-up",
    scope: "team",
    registry: "resume-rows",
    tmux: "relaunch",
    recovery: "none",
    crews: "none",
  },
  "team-shutdown": {
    mechanism: "team-shutdown",
    scope: "team",
    registry: "delete-acting-file",
    tmux: "stop-named-sessions",
    recovery: "tap-init",
    crews: "consume-d-contract",
  },
  "team-out": {
    mechanism: "team-out",
    scope: "team",
    registry: "delete-row",
    tmux: "none",
    recovery: "none",
    crews: "consume-d-contract",
  },
  "team-out-hard": {
    mechanism: "team-out-hard",
    scope: "team",
    registry: "delete-row",
    tmux: "stop-named-sessions",
    recovery: "none",
    crews: "consume-d-contract",
  },
} as const;

export type DurableVerbName = keyof typeof DURABLE_MATRIX;

/** Reviewed DURABLE_MATRIX keys. A new key is unreviewed until this list grows. */
export const REGISTERED_DURABLE_KEYS = [
  "out",
  "down",
  "up",
  "shutdown",
  "out-hard",
  "team-down",
  "team-up",
  "team-shutdown",
  "team-out",
  "team-out-hard",
] as const satisfies readonly DurableVerbName[];

/** Matrix rows plus CREW_DISMISS (crew dismiss is lookup-only, not a matrix key). */
export function lifecycleFateCatalog(): DurableFate[] {
  return [
    ...REGISTERED_DURABLE_KEYS.map((key) => DURABLE_MATRIX[key]),
    CREW_DISMISS,
  ];
}

/** Lifecycle effect owners consult this before a named-session stop. */
export function tmuxFateStopsNamedSession(row: DurableFate): boolean {
  return row.tmux === "stop-named-sessions";
}

/**
 * Crew rows are windows on the driver/operator session (`session:window.pane`).
 * True means applying this fate's tmux column would stop that shared session
 * (2026-08-23/24 mass-exit). This predicate checks actual or copied fates;
 * the independent catalog guard checks the complete matrix.
 */
export function crewDismissWouldStopOperatorSession(row: DurableFate): boolean {
  return row.scope === "crew" && tmuxFateStopsNamedSession(row);
}

/**
 * Standing whole-matrix guard. Own identity — not crewDismissWouldStopOperatorSession.
 * True when any catalog row is crew + stop-named-sessions.
 */
export function matrixHasCrewNamedSessionStop(rows: readonly DurableFate[]): boolean {
  return rows.some((row) => row.scope === "crew" && row.tmux === "stop-named-sessions");
}

/** Lookup: seat/team rows from the matrix; crew up/down refuse; crew out/shutdown dismiss. */
export function lifecycleDisposition(
  scope: LifecycleScope,
  verb: LifecycleVerb,
): LifecycleDisposition {
  if (scope === "crew") {
    if (verb === "up" || verb === "down") {
      return { ok: false, errorClass: "usage_error", detail: CREW_EPHEMERAL };
    }
    return { ok: true, action: verb, row: CREW_DISMISS };
  }
  if (scope === "team") {
    const key = verb === "out" ? "team-out" : verb === "out-hard" ? "team-out-hard"
      : verb === "down" ? "team-down" : verb === "up" ? "team-up" : "team-shutdown";
    return { ok: true, action: verb, row: DURABLE_MATRIX[key] };
  }
  const key = verb === "out-hard" ? "out-hard" : verb;
  return { ok: true, action: verb, row: DURABLE_MATRIX[key] };
}
