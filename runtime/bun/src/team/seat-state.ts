import type { Seat } from "../registry";
import { observe, type RegistryRow } from "../team-observe";
import { observedRows, withAgentStates } from "../roster-observation";
import { tmuxReadOnly } from "../tmux";
import { tapScriptsDir } from "../scripts-dir";
import type { RosterAgentState } from "../roster-activity";

export interface SeatStateFinding {
  name: "seat-state";
  severity: "info" | "warning";
  detail: { handle: string; outcome: "unchanged" | "attention" | "skipped"; detail: string;
    agent_state: RosterAgentState; agent_state_reason: string };
  next?: string;
}

/** Read the roster's lifecycle and activity pipeline without repair or input effects. */
export function seatStateFindings(seats: Record<string, Seat>, team: string): SeatStateFinding[] {
  const rows = Object.entries(seats).sort(([a], [b]) => a.localeCompare(b)).map(([handle, row]) => ({
    ...row, team, handle, status: row?.status ?? "active", delivery: row?.delivery || "pane",
  })) as RegistryRow[];
  if (!rows.length) return [];
  const observation = observe(rows, tapScriptsDir());
  const socket = rows.some(row => row.server_socket) ? tmuxReadOnly(["display-message", "-p", "#{socket_path}"]) : null;
  const callerSocket = socket?.code === 0 && socket.stdout.trim().startsWith("/") ? socket.stdout.trim() : "";
  // Poll seats have no screen; positive inactivity belongs to session-binding.
  // Unreadable lifecycle evidence must remain visible instead of yielding a clean scan.
  const applicable = observedRows(rows, observation.rows, observation.serverEpoch, {}, callerSocket)
    .filter(row => row.delivery === "pane" && (row.status === "active" || row.status === "unknown"));
  return withAgentStates(applicable, { team }).map(row => {
    const state = row.agentState;
    const unchecked = row.status !== "active" || state === "unknown";
    const attention = state === "blocked" || state === "error";
    const next = unchecked ? "re-run tap team doctor --only seat-state"
      : state === "error" ? `tap nudge ${team}/${row.handle}`
      : state === "blocked" ? `tap attach ${team}/${row.handle}` : undefined;
    return {
      name: "seat-state", severity: unchecked || attention ? "warning" : "info",
      detail: { handle: row.handle, outcome: unchecked ? "skipped" : attention ? "attention" : "unchanged",
        detail: unchecked ? `state not checked (${row.agentStateReason})` : `${state} (${row.agentStateReason})`,
        agent_state: state, agent_state_reason: row.agentStateReason },
      ...(next ? { next } : {}),
    };
  });
}
