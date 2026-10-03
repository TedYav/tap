// launch-evidence.ts — the launcher's positive evidence that a pane's harness
// is the incarnation a registry row expects (tap-bogkt, tap-7b9od).
//
// The launcher plants TAP_LAUNCH_ROOT (the enrolled team root) and a per-
// incarnation token in the harness env: TAP_LAUNCH_ID for a launch transaction,
// TAP_CLEAR_ID for an in-place clear or relaunch. The row carries the matching
// token: pending as `launch_id` / `expected_clear_nonce` until the incarnation
// is verified, then promoted to `launch_witness`. SessionStart and `tap in`'s
// worktree guard both decide through launchTokenMatches, so they cannot drift.
//
// Precedence is exclusive: while a replacement is pending, only the pending
// token counts, so an outgoing harness (old launch_witness) never satisfies a
// row whose next incarnation is already starting.

import { readFileSync, realpathSync } from "node:fs";
import { teamWorktrees } from "./launcher/workdir";

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export const LAUNCH_ROOT_ENV = "TAP_LAUNCH_ROOT";
export const LAUNCH_ID_ENV = "TAP_LAUNCH_ID";

/** Whether ENV's incarnation token is the one ROW currently expects. */
export function launchTokenMatches(row: Row, env: NodeJS.ProcessEnv): boolean {
  const launchId = str(env[LAUNCH_ID_ENV]);
  const clearId = str(env.TAP_CLEAR_ID);
  const pendingLaunch = str(row.launch_id);
  const pendingClear = str(row.expected_clear_nonce);
  if (pendingLaunch && pendingClear) return false;
  if (pendingLaunch) return launchId === pendingLaunch;
  if (pendingClear) return clearId === pendingClear;
  const current = str(row.launch_witness);
  return current !== "" && (launchId === current || clearId === current);
}

/**
 * The one row in SEATS bound to this pane and server generation whose token
 * matches ENV, or null. Two rows claiming the pane is ambiguity, not a choice.
 */
export function launchedRowForPane(seats: unknown, paneId: string, serverEpoch: string, env: NodeJS.ProcessEnv): { handle: string; row: Row } | null {
  if (!paneId || !serverEpoch || typeof seats !== "object" || seats === null || Array.isArray(seats)) return null;
  const onPane = Object.entries(seats as Row).filter((entry): entry is [string, Row] => {
    const row = entry[1];
    return typeof row === "object" && row !== null && !Array.isArray(row)
      && ((row as Row).status ?? "active") === "active"
      && (row as Row).pane_id === paneId && (row as Row).server_epoch === serverEpoch;
  });
  if (onPane.length !== 1) return null;
  const [handle, row] = onPane[0]!;
  return launchTokenMatches(row, env) ? { handle, row } : null;
}

/**
 * `tap in`'s worktree-guard exception: the pane sits in a worktree of the team's
 * repository AND the acting registry's row on this pane and generation carries
 * the caller's incarnation token. The launcher validated that workdir and
 * placed this harness there, so no --override-worktree is needed. A pending
 * relaunch --workdir qualifies before its launch_workdir is recorded, because
 * membership is checked against the repository, not the row. Any read failure
 * refuses: the ordinary guard then applies.
 */
export function launchPlacedInWorktree(registryPath: string, teamRoot: string, paneId: string, serverEpoch: string,
  panePath: string, env: NodeJS.ProcessEnv): boolean {
  if (!(env[LAUNCH_ID_ENV] || env.TAP_CLEAR_ID)) return false;
  let seats: unknown;
  try {
    const doc = JSON.parse(readFileSync(registryPath, "utf8"));
    seats = typeof doc === "object" && doc !== null ? doc.seats : null;
  } catch { return false; }
  if (!launchedRowForPane(seats, paneId, serverEpoch, env)) return false;
  let path: string;
  try { path = realpathSync(panePath); } catch { return false; }
  return (teamWorktrees(teamRoot) ?? []).some(wt => path === wt || path.startsWith(`${wt}/`));
}
