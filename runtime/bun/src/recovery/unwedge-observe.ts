import { agentAtRest, detectAgentState } from "../agent-state";
import { inputProtectionHeld } from "../input-protection";
import { classifyPane } from "../pane-state";
import { unboundPaneIdentityRecord } from "../pane-identity";
import { claudeTurn, codexTurn, readBoundTranscript, type BoundTranscript } from "../readiness-stall";
import { loadCurrentRegistry, seatMap, type Seat } from "../registry";
import { composerHoldsExactly, visibleSentinel } from "../submit-frame";
import { parseStuckSentinel } from "../stuck-sentinel";
import { serverEpochFromRaw, tmuxReadOnly } from "../tmux";
import type { SeatSnapshot } from "../verbs/doctor-seat";
import { REAL_RECOVERY_IO } from "./effect";
import { sameUnwedgeBinding, validUnwedgeBinding, type UnwedgeAttempt, type UnwedgeBinding, type UnwedgeObservation } from "./unwedge-policy";
import { unwedgeProgress } from "./unwedge-progress";

export interface UnwedgeReadIO {
  identity(snapshot: SeatSnapshot, reservation?: UnwedgeReservation): UnwedgeBinding;
  frame(snapshot: SeatSnapshot): { text: string; title: string; height: number; copyMode: boolean };
  protection(snapshot: SeatSnapshot): boolean;
  transcript(snapshot: SeatSnapshot): BoundTranscript | null;
}
export interface UnwedgeReservation { original: Seat; token: string }
export interface ObserveOptions { stagedId?: string; wire?: string; keyed?: boolean; interrupt?: boolean; reservation?: UnwedgeReservation }
const text = (value: unknown): string => typeof value === "string" ? value : "";
function read(args: string[]): string {
  const result = tmuxReadOnly(args);
  if (result.code !== 0 || result.rateLimited) throw new Error("pane evidence unavailable");
  return result.stdout;
}
/** Readonly recovery evidence; never acquires a recovery/pane mutex recursively. */
export const REAL_UNWEDGE_READ_IO: UnwedgeReadIO = {
  identity(snapshot, reservation) {
    const b = snapshot.binding;
    const registry = loadCurrentRegistry(b.registry);
    const current = seatMap(registry)[b.handle];
    const row = reservation?.original ?? current;
    if (reservation) {
      if (!reservation.token || current?.status !== "pending" || current.launch_id !== reservation.token
        || current.instance !== b.instance || current.harness_session_id !== b.nativeSessionId || current.harness !== b.harness
        || current.session !== b.session || row?.instance !== b.instance || row?.pane !== b.pane || row?.pane_id !== b.paneId) throw new Error("restart reservation changed");
      const identity = unboundPaneIdentityRecord(b.session, b.pane, { paneId: b.paneId, harness: b.harness });
      if (identity.state !== "match" || identity.epoch !== b.serverEpoch) throw new Error("reserved target process changed or became unobservable");
    } else {
      const refusal = REAL_RECOVERY_IO.authorize(b);
      if (refusal) throw new Error(refusal);
    }
    const observed = read(["display-message", "-p", "-t", b.pane, "#{pane_id}\t#{session_name}\t#{pane_pid}\t#{pane_dead}\t#{pid}:#{start_time}"]).trimEnd().split("\t");
    if (!row || observed.length !== 5 || !/^%\d+$/.test(observed[0]!) || !/^\d+$/.test(observed[2]!)
      || observed[3] !== "0" || !/^\d+:\d+$/.test(observed[4]!)) throw new Error("target identity unavailable");
    const epoch = serverEpochFromRaw(observed[4]!, process.env);
    const socket = read(["display-message", "-p", "#{socket_path}"]).trim();
    if ((row.server_socket && row.server_socket !== socket) || row.server_epoch !== epoch) throw new Error("registered server changed");
    if (row.transcript_path !== snapshot.seat.transcript_path) throw new Error("session instrument changed");
    return { ...b, team: text((registry.team as { name?: unknown } | undefined)?.name), pane: text(row.pane), paneId: observed[0]!, session: observed[1]!,
      instance: text(row.instance), harness: text(row.harness), processPid: observed[2]!,
      nativeSessionId: text(row.harness_session_id), serverSocket: socket, serverEpoch: epoch };
  },
  frame({ binding: b }) {
    const fields = read(["display-message", "-p", "-t", b.paneId, "#{pane_in_mode}\t#{pane_height}\t#{pane_title}"]).trimEnd().split("\t");
    if (!/^[01]$/.test(fields[0] ?? "") || !/^\d+$/.test(fields[1] ?? "")) throw new Error("pane mode or geometry unavailable");
    return { text: read(["capture-pane", "-p", "-e", "-J", "-t", b.paneId]), copyMode: fields[0] === "1", height: Number(fields[1]), title: fields.slice(2).join("\t") };
  },
  protection: ({ binding: b }) => !!inputProtectionHeld(b.paneId, b.serverEpoch),
  transcript: ({ binding: b, seat }) => readBoundTranscript(b.harness, seat),
};
export interface UnwedgeReading { observation: UnwedgeObservation; transcript: BoundTranscript | null; reason?: string }
export function observeUnwedge(snapshot: SeatSnapshot, prior?: UnwedgeAttempt, options: ObserveOptions = {}, io = REAL_UNWEDGE_READ_IO): UnwedgeReading {
  const observation: UnwedgeObservation = { binding: snapshot.binding, verdict: null, cause: "", turnEnded: null,
    composer: "unreadable", protection: "unknown", progress: "unknown" };
  const result: UnwedgeReading = { observation, transcript: null };
  try {
    if (!validUnwedgeBinding(snapshot.binding)) throw new Error("target binding or native session identity is missing");
    if (!sameUnwedgeBinding(snapshot.binding, io.identity(snapshot, options.reservation))) throw new Error("target binding changed");
    const frame = io.frame(snapshot), b = snapshot.binding;
    observation.protection = io.protection(snapshot) ? "held" : "clear";
    const pane = classifyPane(frame.text, b.harness, frame.copyMode, frame.height);
    let owned = false;
    if (pane.kind === "ready") observation.composer = "empty";
    else if (pane.kind === "queued") observation.composer = "queued";
    else if (pane.kind === "draft") {
      observation.composer = "draft";
      if (!pane.scrolled && !pane.mayBeTruncated) {
        const wire = visibleSentinel(frame.text, b.harness);
        const parsed = wire && parseStuckSentinel(wire, b.harness);
        if (options.stagedId && parsed && parsed.ok && parsed.fields.id === options.stagedId
          && composerHoldsExactly(frame.text, b.harness, wire!)) {
          observation.composer = "staged"; observation.stagedPayloadId = parsed.fields.id; owned = true;
        } else if (options.keyed && options.wire && composerHoldsExactly(frame.text, b.harness, options.wire)) {
          observation.composer = "staged"; owned = true;
        }
      }
    }
    const state = detectAgentState(b.harness, frame.text, frame.title, owned);
    observation.cause = state.reason;
    observation.verdict = state.agentState === "error" ? "severed" : state.agentState === "idle" ? "healthy"
      : state.agentState === "blocked" ? "parked-on-dialog" : state.agentState === "working" ? "thinking" : "unknown";
    result.transcript = io.transcript(snapshot);
    if (result.transcript) {
      const turn = b.harness === "codex" ? codexTurn(result.transcript.lines) : b.harness === "claude" ? claudeTurn(result.transcript.lines) : null;
      observation.turnEnded = turn?.ended ?? null;
    }
    observation.progress = prior ? unwedgeProgress(prior, result.transcript, prior.cause, !!options.keyed && !!options.interrupt) : result.transcript ? "unchanged" : "unknown";
    if (!sameUnwedgeBinding(snapshot.binding, io.identity(snapshot, options.reservation))) throw new Error("target binding changed during observation");
    if (!agentAtRest(state.agentState)) result.reason = "the seat is not positively at rest";
  } catch (error) { result.reason = error instanceof Error ? error.message : String(error); observation.verdict = null; }
  return result;
}
export function unwedgeBoundaryRefusal(seen: UnwedgeReading, cause: string, options: ObserveOptions = {}): string {
  const o = seen.observation;
  if (seen.reason) return seen.reason;
  if (o.protection !== "clear") return "operator protection is active or unobservable";
  if (o.turnEnded !== true || !seen.transcript) return "the session does not prove a stopped turn";
  if (o.progress !== "unchanged") return "session activity changed before the effect";
  const atRestAllowed = options.keyed || options.stagedId;
  if (!(o.verdict === "severed" && o.cause === cause) && !(atRestAllowed && o.verdict === "healthy")) return "the diagnosed stopped cause changed";
  if (options.stagedId) return o.composer === "staged" && o.stagedPayloadId === options.stagedId ? "" : "the exact predecessor sentinel is no longer staged";
  return o.composer === "empty" || (options.keyed && options.wire && o.composer === "staged") ? "" : "the composer holds input or cannot be checked";
}
