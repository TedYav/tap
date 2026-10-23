/** Match native process evidence to launcher-owned membership; no pane effects. */
import { realpathSync, statSync } from "node:fs";
import { busHomeForRegistry, loadGlobalRegistry } from "./index-home";
import { enrolledSeatForObservedPane, isRegisteredTeamState, loadCurrentRegistry, seatMap, type Seat } from "./registry";
import { physicalSocketPath } from "./tmux";
import { childBusEnv } from "./panelock";
import { sameOpenCodeService, type OpenCodeCaller, type OpenCodeService } from "./opencode-shared";

export type SharedSeatMatch = { kind: "refused"; reason: string } | {
  kind: "matched"; team: string; root: string; registry: string; handle: string; row: Seat;
};
export interface SharedPane { paneId: string; session: string; serverEpoch: string }
type SharedRoot = Pick<Extract<OpenCodeCaller, { kind: "verified" }>, "rootSessionId" | "service">;
type PaneObserver = (target: string, env: NodeJS.ProcessEnv, socket: string) => SharedPane | null;
export type VerifiedSharedSeat = { kind: "refused"; reason: string } | {
  kind: "verified"; match: Extract<SharedSeatMatch, { kind: "matched" }>; env: NodeJS.ProcessEnv; pane: SharedPane;
};
export function verifySharedSeat(proof: Extract<OpenCodeCaller, { kind: "verified" }>, env: NodeJS.ProcessEnv,
  observe: PaneObserver): VerifiedSharedSeat {
  const refuse = (reason: string): VerifiedSharedSeat => ({ kind: "refused", reason });
  const match = matchingSharedSeat(proof, env);
  if (match.kind === "refused") return match;
  const row = match.row, socket = row.server_socket as string;
  const real = (path: string) => { try { return realpathSync(path); } catch { return path; } };
  // Root sessions get their TUI's environment; native children do not. Only
  // a child proved through server parent IDs may derive the root's pins.
  if (proof.sessionId === proof.rootSessionId &&
    (env.TMUX_PANE !== row.pane_id || physicalSocketPath(env) !== real(socket))) return refuse("pane_environment");
  return verifyMatchedSharedSeat(proof, match, env, observe);
}
/** Read-only plugin context uses an explicitly requested native root, not a
 * caller identity. The caller must separately prove its service ancestry. */
export function verifySharedRootSeat(proof: SharedRoot, env: NodeJS.ProcessEnv, observe: PaneObserver): VerifiedSharedSeat {
  const match = matchingSharedSeat(proof, env);
  return match.kind === "refused" ? match : verifyMatchedSharedSeat(proof, match, env, observe);
}
function verifyMatchedSharedSeat(proof: SharedRoot, match: Extract<SharedSeatMatch, { kind: "matched" }>, env: NodeJS.ProcessEnv,
  observe: PaneObserver): VerifiedSharedSeat {
  const refuse = (reason: string): VerifiedSharedSeat => ({ kind: "refused", reason });
  const row = match.row, socket = row.server_socket as string, bus = busHomeForRegistry(match.registry);
  if (!bus) return refuse("bus_unverified");
  const pinned: NodeJS.ProcessEnv = { ...childBusEnv(bus, env), TAP_TMUX_SOCKET_PATH: socket, TMUX_PANE: row.pane_id as string };
  delete pinned.TAP_TMUX_SOCKET;
  const pane = observe(row.pane as string, pinned, socket);
  if (!pane || pane.paneId !== row.pane_id || pane.session !== row.session || pane.serverEpoch !== row.server_epoch)
    return refuse("pane_generation");
  const owner = enrolledSeatForObservedPane(pane.paneId, pane.session, pane.serverEpoch, env.TAP_INDEX_HOME);
  if (owner.kind !== "resolved" || owner.team !== match.team || owner.handle !== match.handle ||
    owner.registryLocation !== match.registry) return refuse("pane_ambiguous");
  const final = matchingSharedSeat(proof, env);
  if (final.kind !== "matched" || final.team !== match.team || final.root !== match.root || final.registry !== match.registry ||
    final.handle !== match.handle || ["instance", "pane", "pane_id", "session", "server_epoch", "server_socket"]
      .some(key => final.row[key] !== row[key])) return refuse("seat_generation");
  return { kind: "verified", match: final, env: pinned, pane };
}
export function matchingSharedSeat(proof: SharedRoot, env: NodeJS.ProcessEnv): SharedSeatMatch {
  const refused = (reason: string): SharedSeatMatch => ({ kind: "refused", reason });
  const index = loadGlobalRegistry(env.TAP_INDEX_HOME);
  if (index.marker !== "live" || !index.doc) return refused("index_unverified");
  const teams = index.doc.teams;
  if (!teams || typeof teams !== "object" || Array.isArray(teams)) return refused("index_unverified");
  const matches: Array<Extract<SharedSeatMatch, { kind: "matched" }>> = [];
  for (const [team, value] of Object.entries(teams)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (!isRegisteredTeamState(entry.state)) continue;
    const root = entry.root, registry = entry.registry_location;
    if (typeof root !== "string" || typeof registry !== "string" || !root || !registry) return refused("index_unverified");
    let seats: Record<string, Seat>;
    try {
      if (!statSync(registry).isFile()) return refused("index_unverified");
      seats = seatMap(loadCurrentRegistry(registry));
    } catch { return refused("index_unverified"); }
    for (const [handle, row] of Object.entries(seats)) {
      if (row.harness === "opencode" && row.harness_session_id === proof.rootSessionId && (row.status ?? "active") === "active")
        matches.push({ kind: "matched", team, root, registry, handle, row });
    }
  }
  if (matches.length !== 1) return refused(matches.length ? "session_ambiguous" : "session_unregistered");
  const match = matches[0]!, row = match.row;
  if (row.status_reason === "launching" || row.delivery !== "pane" || row.opencode_server_mode !== "shared" ||
    !["instance", "pane", "pane_id", "session", "server_epoch", "server_socket"].every(key => typeof row[key] === "string" && row[key] !== "")) return refused("seat_inactive");
  const service = row.opencode_service;
  if (!service || typeof service !== "object" || Array.isArray(service) ||
    !sameOpenCodeService(proof.service, service as OpenCodeService)) return refused("service_generation");
  return match;
}
