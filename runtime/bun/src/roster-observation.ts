import { spawnSync } from "node:child_process";
import { validToken } from "./ids";
import type { TokenSample } from "./context-tokens";
import { contextUsedPercent } from "./context-census";
import { detectAgentState, type AgentStateResult } from "./agent-state";
import { harnessEvidence } from "./readiness-stall";
import { computeFor, rosterActivity, type ComputeJob, type RosterAgentState, type WaitingOn } from "./roster-activity";
import { readOverprintRecord } from "./overprint-marker";
import { pendingPermissionRequest, type PendingPermissionRequest } from "./permission-request";
import { serverEpochFromRaw, tmuxReadOnly } from "./tmux";
import { REGISTRY_MAX_BUFFER } from "./spawn";
import { harnessModelFamily } from "./launcher/catalog-metadata";
import type { RegistryRow } from "./team-observe";

const str = (value: unknown): string => typeof value === "string" ? value : "";
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export interface ObservedRow {
  handle: string;
  session: string;
  harness: string;
  pane: string;
  observedPaneId: string;
  observedServerEpoch: string;
  serverSocket?: string;
  foreignNamespace?: boolean;
  delivery: string;
  status: string;
  statusReason: string;
  attached: string;
  unattended: boolean;
  crew: boolean;
  crewLifetime?: "independent" | "legacy_supervised" | "unknown";
  preset: string;
  /** The seat's assigned team role (`tap role`), or "" when it holds none. A label, not a permission. */
  role?: string;
  /** Vendor lineage: the recorded preset's `metadata.model_family`, else the seat harness's single vendor; null when unknown. */
  family?: string | null;
  /** Where `family` came from: the recorded preset's explicit key, or only the seat harness's vendor. */
  familySource?: "preset" | "harness" | null;
  model?: string | null;
  effort?: string | null;
  launchTuning?: unknown;
  digestWindow?: number;
  askWindow?: number;
  agentState: RosterAgentState;
  agentStateReason: string;
  /** Live background work an ended turn still owns (tap-i5fzq); empty unless waiting. */
  waitingOn?: WaitingOn[];
  /** Working: epoch seconds the running turn began (its elapsed clock). */
  turnStartedAt?: number | null;
  /** Idle/waiting: epoch seconds the last turn ended, and the witness that dated it. */
  turnEndedAt?: number | null;
  turnEndedSource?: "transcript" | null;
  harnessSessionId?: string;
  transcriptPath?: string;
  tokenSample?: TokenSample;
  contextUsedPercent?: number | null;
  contextSampledAt?: string | null;
  /** Claude only: the approval or question the seat is waiting on, while Claude's own session file says it is waiting. Never cached. */
  permissionRequest?: PendingPermissionRequest | null;
}

/** Explicit preset lineage wins; otherwise only what the seat's own harness implies, and the source says which. */
function familyOf(explicit: string, harness: string): Pick<ObservedRow, "family" | "familySource"> {
  if (explicit) return { family: explicit, familySource: "preset" };
  const implied = harnessModelFamily(harness);
  return implied ? { family: implied, familySource: "harness" } : { family: null, familySource: null };
}

export function observedRows(
  rows: RegistryRow[],
  observations: Map<string, string[]>,
  observedServerEpoch: string,
  facts: Record<string, Record<string, unknown>>,
  callerSocket = "",
): ObservedRow[] {
  const out: ObservedRow[] = [];
  for (const row of rows) {
    const handle = str(row.handle);
    if (!handle) continue;
    const observation = observations.get(handle) ?? ["unknown", "observation_missing", "", "", "", "0"];
    const foreignNamespace = str(row.delivery) !== "poll" && !!callerSocket && !!str(row.server_socket) && str(row.server_socket) !== callerSocket;
    const status = foreignNamespace ? "offline" : observation[0] || "unknown";
    let attached = observation[5] || "";
    const delivery = str(row.delivery) || "pane";
    if (delivery !== "poll") {
      if (attached === "true" || attached === "yes") attached = "1";
      else if (!/^[0-9]+$/.test(attached)) attached = "0";
      if (status !== "active") attached = "0";
    } else {
      attached = "";
    }
    let harness = str(row.harness);
    if (row.crew === true && status === "active" && observation[4]) harness = observation[4]!;
    const fact = facts[handle] ?? {};
    let preset = str(fact.preset);
    if (preset && fact.preset_inferred === true) preset += "?";
    out.push({
      handle,
      session: str(row.session),
      harnessSessionId: str(row.harness_session_id), transcriptPath: str(row.transcript_path),
      harness,
      pane: str(row.pane),
      observedPaneId: observation[3] || "",
      observedServerEpoch,
      delivery,
      status,
      statusReason: foreignNamespace ? "foreign_namespace" : observation[1] || "",
      serverSocket: str(row.server_socket), foreignNamespace,
      attached,
      unattended: row.unattended === true,
      crew: row.crew === true,
      preset,
      role: validToken(str(row.role)) ? str(row.role) : "",
      ...familyOf(str(fact.family), harness),
      model: record(row.launch_tuning) ? str(row.launch_tuning.model) || null : str(row.model) || null,
      effort: record(row.launch_tuning) ? str(row.launch_tuning.effort) || null : null,
      launchTuning: row.launch_tuning,
      digestWindow: Number(fact.digest_window_seconds ?? 10),
      askWindow: Number(fact.ask_window_seconds ?? 10),
      agentState: "unknown",
      agentStateReason: "not_observed",
    });
  }
  return out;
}

// Exported for tap health (tap-diagnostics-u1): the health roster renders the
// SAME live seat-state ladder the roster does, never a second answer to "what
// is this seat doing right now".
export interface AgentStateOptions {
  /** The rendered team: compute jobs attribute to `<team>/<handle>`. */
  team?: string;
  /** The compute queue's jobs; read at most once, only when some seat is idle. */
  computeJobs?: () => ComputeJob[];
  /** Titles from the same pane listing; absent fields retain the targeted fallback. */
  paneTitles?: Map<string, string>;
  now?: number;
}

/** `compute --json queue`, bounded: a missing binary or any failure is no evidence. */
export function readComputeJobs(): ComputeJob[] {
  try {
    const r = spawnSync("compute", ["--json", "queue"], { encoding: "utf8", timeout: 3000, maxBuffer: REGISTRY_MAX_BUFFER });
    if (r.status !== 0) return [];
    const doc = JSON.parse(r.stdout) as { jobs?: unknown };
    return Array.isArray(doc.jobs) ? doc.jobs.filter((job): job is ComputeJob => typeof job === "object" && job !== null) : [];
  } catch {
    return [];
  }
}

export function withAgentStates(rows: ObservedRow[], options: AgentStateOptions = {}): ObservedRow[] {
  const now = options.now ?? Number(process.env.TAP_WATCH_NOW || Math.trunc(Date.now() / 1000));
  const readEpoch = () => {
    const generation = tmuxReadOnly(["display-message", "-p", "#{pid}:#{start_time}"]);
    return generation.code === 0 ? serverEpochFromRaw(generation.stdout.trim()) : "";
  };
  const captures = rows.some(row => row.delivery === "pane" && row.status === "active" && row.observedPaneId);
  const before = captures ? readEpoch() : "";
  const native = rows.map((row) => {
    let percent: number | null = null, sampledAt: string | null = null, screen = "";
    let captured = false;
    let result: AgentStateResult = { agentState: "unknown", reason: "no_pane" };
    if (row.delivery === "pane" && row.pane) {
      result = detectAgentState(row.harness, "");
      if (result.reason !== "unrecognized_harness") {
        if (row.status === "unknown") {
          result = { agentState: "unknown", reason: "lifecycle_unreadable" };
        } else if (row.status !== "active") {
          result = { agentState: "unknown", reason: "lifecycle_inactive" };
        } else if (!row.observedPaneId) {
          result = { agentState: "unknown", reason: "capture_failed" };
        } else {
          captured = true;
          const codex = /^codex(?:-|$)/.test(row.harness);
          const capture = tmuxReadOnly(["capture-pane", ...(codex ? ["-e"] : []), "-p", "-t", row.observedPaneId]);
          if (capture.code === 0) {
            const observedTitle = options.paneTitles?.get(row.observedPaneId);
            const title = !codex ? null : observedTitle !== undefined ? { code: 0, stdout: observedTitle }
              : tmuxReadOnly(["display-message", "-p", "-t", row.observedPaneId, "#{pane_title}"]);
            result = (!title || title.code === 0) && row.observedServerEpoch && before === row.observedServerEpoch
              ? detectAgentState(row.harness, capture.stdout, title?.stdout.trimEnd())
              : { agentState: "unknown", reason: "capture_failed" };
            if (result.reason !== "capture_failed") {
              screen = capture.stdout;
              percent = contextUsedPercent(row.harness, capture.stdout);
              sampledAt = new Date().toISOString();
              // A stuck-paint episode that exhausted its bounded repaints is
              // alarmed once on the record; the roster carries that suffix.
              if ((result.agentState === "overprint" || result.agentState === "booting") && row.observedPaneId) {
                const record = readOverprintRecord(row.observedPaneId);
                if (record?.alarmed === true) result = { ...result, reason: "heal_exhausted" };
              }
            }
          } else {
            result = { agentState: "unknown", reason: "capture_failed" };
          }
        }
      }
    }
    return { row, result, screen, percent, sampledAt, captured };
  });
  // The bracket protects this observation from server restart, not pane turnover
  // within a server epoch. Pane identity remains the lifecycle observer's proof.
  const after = captures ? readEpoch() : "";
  if (captures && (!before || before !== after)) for (const item of native) {
    if (!(before && after && before !== after) && !item.captured) continue;
    item.result = { agentState: "unknown", reason: "capture_failed" };
    item.screen = ""; item.percent = null; item.sampledAt = null;
  }
  // Roster-only enrichment (tap-i5fzq): waiting, the Claude spinner, and time
  // in state. Delivery and readiness keep reading the native classifier.
  let jobs: ComputeJob[] | null = null;
  return native.map(({ row, result, screen, percent, sampledAt }) => {
    let compute: string[] = [];
    if (result.agentState === "idle" && options.team) {
      jobs ??= (options.computeJobs ?? readComputeJobs)();
      compute = computeFor(jobs, options.team, row.handle, row.observedPaneId);
    }
    // Idle and waiting rows are dated only by the turn's own completion record
    // (readiness-stall's transcript instrument); a footer's bare clock is not a date.
    let turnEnded: number | null = null;
    if (result.agentState === "idle" && row.status === "active") {
      const evidence = harnessEvidence(row.harness, { transcript_path: row.transcriptPath ?? "", harness_session_id: row.harnessSessionId ?? "" }, process.env);
      turnEnded = evidence?.ended && evidence.at !== null && Number.isFinite(evidence.at) && evidence.at <= now ? Math.floor(evidence.at) : null;
    }
    const activity = rosterActivity(row.harness, screen, result, compute, now, turnEnded);
    return { ...row, agentState: activity.result.agentState, agentStateReason: activity.result.reason,
      waitingOn: activity.waitingOn, turnStartedAt: activity.turnStartedAt, turnEndedAt: activity.turnEndedAt,
      turnEndedSource: activity.turnEndedSource, contextUsedPercent: percent, contextSampledAt: sampledAt };
  });
}

/**
 * Attach each Claude seat's open permission request. This is a fact read for
 * every request and never part of a cached observation: the detail must not
 * outlive its record in a second file, and a cached row must not show a request
 * that has since closed. `readOnly` is a named read of another team's bus.
 */
export function withPermissionRequests(rows: ObservedRow[], bus: string, readOnly: boolean): ObservedRow[] {
  return rows.map((row) => {
    const applies = bus && /^claude(?:-|$)/.test(row.harness) && row.delivery === "pane" && row.status === "active"
      && row.observedPaneId && row.harnessSessionId;
    return { ...row, permissionRequest: applies
      ? pendingPermissionRequest(bus, row.handle,
        { sessionId: row.harnessSessionId!, paneId: row.observedPaneId, serverEpoch: row.observedServerEpoch }, { remove: !readOnly })
      : null };
  });
}
