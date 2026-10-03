// Shared terminal observation and exact stop effect for seat power and retirement.
import { TapError } from "./context";
import type { Seat } from "./registry";
import { destructiveSessionTarget, isPaneId } from "./lifecycle-target";
import { bootId, bootIdsMatch, serverEpochFromRaw, tmuxReadOnly, type Run } from "./tmux";
function fail(errorClass: string, detail: string): never {
  throw new TapError(1, errorClass, "inspect the seat and selected tmux server", detail);
}

interface Pane { id: string; session: string; sessionId: string; window: string; rawEpoch: string }
export interface SeatSnapshot { panes: Pane[]; epoch: string }
export type TmuxCall = (args: string[]) => Run;
const paneFormat = "#{pane_id}\t#{session_name}\t#{session_id}\t#{window_id}\t#{pid}:#{start_time}";
/** One complete namespace observation. An unreadable server never means stopped.
 * Only stderr that positively says there is no server, or no session on a server
 * that stays up empty (exit-empty off: tmux 3.7c answers `list-panes -a` with exactly
 * `no current target`, and never does while any session lives), reads as empty. */
export function seatSnapshot(call: TmuxCall = tmuxReadOnly): SeatSnapshot {
  const result = call(["list-panes", "-a", "-F", paneFormat]);
  if (result.code !== 0) {
    const stderr = result.stderr.trim();
    if (/^(no server running on|error connecting to .*No such file or directory|failed to connect to server: No such file or directory)/.test(stderr) || stderr === "no current target") return { panes: [], epoch: "" };
    fail("tmux_unobservable", `cannot observe sessions: ${result.stderr.trim()}`);
  }
  // Some tmux versions answer a lingering server with every session closed by a
  // successful read with no rows: the command ran and listed nothing.
  if (!result.stdout.trim()) return { panes: [], epoch: "" };
  const panes: Pane[] = [];
  for (const line of result.stdout.trimEnd().split("\n")) {
    const parts = line.split("\t");
    const [id, session, sessionId, window, rawEpoch] = parts;
    if (parts.length !== 5 || !isPaneId(id) || !session || !/^\$\d+$/.test(sessionId!) || !/^@\d+$/.test(window!) || !/^\d+:\d+$/.test(rawEpoch!)) fail("tmux_unobservable", "malformed session snapshot");
    panes.push({ id, session, sessionId: sessionId!, window: window!, rawEpoch: rawEpoch! });
  }
  if (!panes.length || panes.some(p => p.rawEpoch !== panes[0]!.rawEpoch)) fail("tmux_unobservable", "inconsistent server generation");
  return { panes, epoch: serverEpochFromRaw(panes[0]!.rawEpoch) };
}

/** Strict pane membership additionally rules out a name reused after its stored pane died. */
export function liveSeat(row: Seat, expected: string, snapshot: SeatSnapshot): Pane | undefined {
  const members = snapshot.panes.filter(p => p.session === expected);
  if (!members.length) return undefined;
  const decision = destructiveSessionTarget(row, expected, {
    hasSession: name => snapshot.panes.some(p => p.session === name),
    paneSession: id => snapshot.panes.find(p => p.id === id)?.session ?? null,
    sessionPaneIds: name => snapshot.panes.filter(p => p.session === name).map(p => p.id),
  });
  if (!decision.ok) fail("session_identity_mismatch", decision.reason);
  const pane = members.find(p => p.id === row.pane_id);
  if (!pane) fail("session_identity_mismatch", "live session does not contain the stored pane; refusing a reused name");
  if (row.server_epoch && row.server_epoch !== snapshot.epoch) fail("session_identity_mismatch", "stored server generation differs");
  if (row.boot_id && bootIdsMatch(String(row.boot_id), bootId()) !== "match") fail("session_identity_mismatch", "stored boot identity is not current");
  return pane;
}

/** Shared-session ownership is the installed crew contract. No foreign pane is followed. */
export function ownedCrewRows(seats: Record<string, Seat>, session: string, snapshot: SeatSnapshot): string[] {
  const handles: string[] = [];
  for (const [handle, row] of Object.entries(seats)) {
    if (row.crew !== true || row.session !== session) continue;
    const live = snapshot.panes.find(p => p.id === row.pane_id);
    if (live && live.session !== session) fail("crew_identity_mismatch", `crew '${handle}' is live in another session`);
    handles.push(handle);
  }
  return handles;
}

/** The final predicate and kill run on the same tmux server, using immutable ids. */
export function stopExactPane(pane: Pane, call: TmuxCall = tmuxReadOnly): Run {
  const condition = `#{&&:#{==:#{session_name},${pane.session}},#{&&:#{==:#{session_id},${pane.sessionId}},#{&&:#{==:#{pane_id},${pane.id}},#{==:#{pid}:#{start_time},${pane.rawEpoch}}}}}`;
  return call(["if-shell", "-F", "-t", pane.id, condition,
    `kill-session -t '${pane.sessionId}'`, "display-message -p 'tap lifecycle: stop identity changed'"]);
}
