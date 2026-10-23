import { TapError } from "../context";
import { staleSeatGeneration, truthy, type Observation } from "../launcher/generation";
import { jsonDumpBytes } from "../spool-publication";
import { physicalSocketPath } from "../tmux";

type Row = Record<string, unknown>;
const epoch = (value: unknown): RegExpExecArray | null => typeof value === "string" ? /^srv:([0-9]+):([0-9]+)$/.exec(value) : null;
const bootKind = (value: unknown): string => typeof value !== "string" ? ""
  : /^boot:[0-9]+$/.test(value) ? "seconds"
  : /^bootuuid:[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/.test(value) ? "uuid" : "";
const RECOVERABLE = new Set(["server_restarted", "pane_gone", "session_replaced", "repair_failed", "restart_failed"]);

export interface RestartCohort { rows: Map<string, Row>; generation: string | null; skipped: string[]; crews: number }

/** Choose the generation before eligibility: a deliberate stop must never expose an older cohort. */
export function selectRestartCohort(rows: Map<string, Row>, liveNames: Set<string>, observation: Observation, socket: string, team: string, serverAbsent = false): RestartCohort {
  const canonicalSocket = (value: unknown): string => typeof value === "string" && value.startsWith("/")
    ? physicalSocketPath({ TAP_TMUX_SOCKET_PATH: value }) : "";
  socket = canonicalSocket(socket);
  observation = { ...observation, socket: canonicalSocket(observation.socket) };
  if (!bootKind(observation.boot) || !socket || (serverAbsent && liveNames.size > 0)
    || (!serverAbsent && (!epoch(observation.epoch) || observation.socket !== socket))) {
    throw new TapError(1, "observation_unobservable", "inspect tmux and retry tap team up --last",
      "current boot or tmux generation is unobservable; no restart cohort selected", "tap team up");
  }
  const result: RestartCohort = { rows: new Map(), generation: null, skipped: [], crews: 0 };
  type Generation = { start: bigint; rows: Array<[string, Row]>; boots: Map<string, string>; ambiguous: boolean };
  const generations = new Map<string, Generation>();
  for (const [handle, row] of rows) {
    if (truthy(row.crew)) { result.crews++; continue; }
    const legacyStopped = !row.delivery && row.status === "suspended" && row.status_reason === "session_stopped";
    if ((row.team !== undefined && row.team !== team)
      || !(row.delivery === "pane" || legacyStopped || !row.delivery && (row.pane || row.pane_id))
      || canonicalSocket(row.server_socket) !== socket) continue;
    const stamp = epoch(row.server_epoch);
    if (!stamp || !bootKind(row.boot_id)) { result.skipped.push(handle); continue; }
    // Server epochs remain comparable across legacy/current boot-id formats.
    const previous = serverAbsent || row.server_epoch !== observation.epoch
      || staleSeatGeneration({ ...row, server_socket: socket }, observation);
    if (!previous) continue;
    // A format upgrade within one server lifetime does not split its cohort.
    // Conflicting identities in the same format still prove an epoch collision.
    const key = row.server_epoch as string;
    const group: Generation = generations.get(key) ?? { start: BigInt(stamp[2]!), rows: [], boots: new Map(), ambiguous: false };
    const kind = bootKind(row.boot_id), boot = row.boot_id as string;
    if (group.boots.has(kind) && group.boots.get(kind) !== boot) group.ambiguous = true;
    group.boots.set(kind, boot);
    group.rows.push([handle, row]); generations.set(key, group);
  }
  let latest: (Generation & { key: string }) | undefined;
  let tied = false;
  for (const [key, group] of generations) {
    if (!latest || group.start > latest.start) { latest = { key, ...group }; tied = false; }
    else if (group.start === latest.start) tied = true;
  }
  if (tied || latest?.ambiguous) throw new TapError(1, "ambiguous_restart_cohort", "tap team up --only <handles>",
    "newest prior server generations have the same start time; select handles explicitly", "tap team up");
  if (!latest) return result;
  result.generation = `${[...latest.boots.values()].sort().join("+")}/${latest.key}`;
  for (const [handle, row] of latest.rows) {
    const status = row.status ?? "active", reason = row.status_reason ?? "";
    if (reason === "user_removed" || reason === "session_stopped" || reason === "launching"
      || !(status === "active" || status === "suspended" && RECOVERABLE.has(String(reason)))
      || typeof row.session !== "string" || !row.session || liveNames.has(row.session)) continue;
    result.rows.set(handle, row);
  }
  return result;
}

// These fields bind consent to both membership and the recipe that was previewed.
const PIN_FIELDS = ["instance", "status", "status_reason", "crew", "delivery", "team", "boot_id", "server_epoch", "server_socket",
  "session", "pane", "pane_id", "harness", "harness_session_id", "registered_from_worktree", "cwd", "launch_workdir", "model",
  "permissions", "harness_env", "passthrough", "passthrough_from_config", "harness_unset_env", "harness_tail", "tag", "index", "base",
  "transcript_path", "quarantined_harness_session_id", "quarantined_transcript_path", "identity_quarantine_reason", "adopted_from_manual",
  "preset", "launch_tuning", "opencode_server_mode", "opencode_service"];
export function restartRowMatches(expected: Row, current: Row | null | undefined): boolean {
  return !!current && PIN_FIELDS.every(key => jsonDumpBytes(expected[key] ?? null, undefined, true) === jsonDumpBytes(current[key] ?? null, undefined, true));
}
