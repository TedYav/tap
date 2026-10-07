import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { TapError, callingPane, noMachineIndexError, observeCallingPane, requireActingRegistry, resolveContext, resolveSelf, type ResolvedContext } from "../context";
import { renderRefusals } from "../error-line";
import { helpArgv } from "../help";
import { createOpenCodeContextReader, opencodeSessionDirectories } from "../opencode-context";
import { refreshWindowMap } from "../opencode-model-windows";
import { readContextTokens, withClaudeWindow, formatContextTokens, type TokenSample } from "../context-tokens";
import { claudeWindows } from "../context-window";
import { contextUsedPercent, contextQueueFacts, pendingInboundAsks, type AddresseeGate } from "../context-census";
import { addresseeGrant, historyDirForBus } from "../addressee-grant";
import { judgeStalled, type StalledJudgement } from "../roster-stalled";
import {
  actingRegistryForTeamOverride,
  flipMarkerState,
  globalRegistryPath,
  resolveEnrolledTeamRoot,
  resolveTeamFromGlobal,
} from "../index-home";
import { applyTeamOverride } from "../team-override";
import { assertResetUnfenced } from "../reset";
import { busHomeForEnrolled, isNoMachineIndex } from "../selector";
import { runTeamStop, type RegistryPolicy, type StopEffects } from "../team/stop";
import { parseStopArgs, type StopVerb } from "../team/stop-plan";
import { crewSelectGate, noSelection, parseSelection, registryRoster, rosterGate, scanOptionalSelection, selectConflictGate, selectedHandles, selectionBlob } from "../team/selection";
import { crewLifetimeHealth } from "../crew-lifetime";
import { teamStopQueueSummary } from "../team-stop-queue";
import { loadRegistry, seatMap } from "../registry";
import { disarm, readLoose } from "../watch-lease";
import { clearTints } from "../watch-sidecar";
import { armPath } from "../watch-notice";
import type { LifecycleTmux } from "../lifecycle-target";
import { REGISTRY_MAX_BUFFER } from "../spawn";
import { ensureAscii } from "../fsatomic";
import { detectAgentState, type AgentState, type AgentStateResult } from "../agent-state";
import { harnessEvidence } from "../readiness-stall";
import { computeFor, formatAge, rosterActivity, type ComputeJob, type RosterAgentState, type WaitingOn } from "../roster-activity";
import { readOverprintRecord } from "../overprint-marker";
import { ServerUnresponsive, serverEpochFromRaw, tmuxReadOnly } from "../tmux";
import { repoSetupHeadsUp } from "../first-run";
import { archiveNudge } from "../bus-archive-index";
import { cmdRefresh } from "./refresh";
import { effectiveWindows, windowsDoc } from "../digest-window";
import { configDirectory, isRegularFile, readSecureBytes } from "../launcher/catalog";
import { rosterDisplayFacts, tryLoadCatalogForDisplay } from "../launcher/catalog-listing";
import { harnessModelFamily } from "../launcher/catalog-metadata";
import { loadModelReference, matchingVariant } from "../launcher/model-reference";
import type { LaunchTuning } from "../launcher/tuning";
import { Notices } from "../launcher/catalog-notices";
import { shlexQuote } from "../launcher/invocation";
import { PyInt } from "../spool-publication";
import { cmdTeamDoctor } from "../team/doctor";
import { cmdTeamAttach } from "../team/attach";
import { cmdTeamReset } from "../team/reset";
import { cmdTeamRestore } from "../team/restore";
import { cmdTeamPurge } from "../team/purge";
import { cmdTeamDetach } from "../team/detach";
import { cmdTeamOut } from "../team/out";
import { calibrationView, writeRoutingResult } from "../routing";
import { isOldStoreRefusal } from "../register-authority";
import { lifecycleDisposition, lifecycleReceipt } from "../lifecycle-target";
import { assertBoundParentLifetimes, captureCohortParentLifetimes, chooseSeatCohort, chooseTeam, confirmAction, discoveryTerminalAvailable, parentSeatSnapshot, readDiscoverySeats, requireDiscoveryTerminal, revalidateTeam, type BoundCohort, type BoundTeam, type Picker } from "../team/discovery";
import { pick } from "../fzf";
import { parseSessionDoor } from "../launcher/session-doors";
import { crewLifetimeBinding, crewLifetimeMatchesRows, reconcileCrewLifetime, validateCrewLifetimeBinding } from "../crew-lifetime";

type HumanAgentState = RosterAgentState | "offline" | "unbound" | "incapable" | "unsubmitted" | "ready";

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const AGENT_COLOR: Record<HumanAgentState, number> = {
  ready: 96,
  working: 32,
  waiting: 93,
  blocked: 31,
  idle: 34,
  booting: 36,
  overprint: 35,
  unknown: 33,
  unbound: 33,
  offline: 90,
  incapable: 35,
  unsubmitted: 33,
};
export const TEAM_SUBCOMMANDS = ["doctor", "list", "roster", "calibration", "attach", "detach", "refresh", "shutdown", "down", "out", "up", "reset", "purge", "restore"];
export { AGENT_FAMILIES, DENYLIST } from "../harness-families";


export type { RegistryRow } from "../team-observe";
import { observe, type RegistryRow } from "../team-observe";
import { artifactBun } from "../scripts-dir";
export { observe } from "../team-observe";

interface RegistryRead {
  ok: boolean;
  team?: unknown;
  rows?: RegistryRow[];
  error?: string;
  rawError?: boolean;
  rawOutput?: string;
}

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
  crewLifetime?: "supervised" | "unsupervised" | "unknown";
  preset: string;
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
}

interface TeamOptions {
  json: boolean;
  all: boolean;
  names: boolean;
  active: boolean;
  offline: boolean;
  team?: string;
  wide: boolean;
  stalled: boolean;
  /** Refetch OpenCode model windows into the persisted map (the only roster path that runs `opencode`). */
  refreshModels?: boolean;
  /** Seconds a seat must have been idle (from its dated turn end); set only with --stalled. */
  staleAfter?: number;
}

const DEFAULT_STALE_AFTER = 600;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function humanAction(action: string): string {
  const flat = action.replace(/[\r\n]/g, " ");
  return /[ /]/.test(flat) ? flat : flat.replace(/_/g, " ");
}

function jsonRefusal(error: TapError): void {
  const fields: [string, string][] = [
    ["ok", "false"],
    ["error_class", JSON.stringify(error.errorClass)],
    ["action", JSON.stringify(error.action)],
  ];
  if (error.detail) fields.push(["detail", JSON.stringify(error.detail)]);
  const body = fields.map(([k, v]) => `${JSON.stringify(k)}:${v}`).join(",");
  process.stdout.write(`${ensureAscii(`{${body}}`)}\n`);
}

function genericRegistryRefusal(): TapError {
  return new TapError(
    1,
    "registry_unreachable",
    "tap doctor",
    "acting registry unreachable — refusing tap team against a bus decoy",
  );
}

function teamContext(explicitTeam?: string): ResolvedContext {
  let ctx: ResolvedContext;
  try {
    ctx = resolveContext(process.cwd(), process.env, explicitTeam ? { explicitTeam } : undefined);
  } catch (error) {
    if (error instanceof TapError) {
      if (!explicitTeam && error.errorClass !== "not_a_bus" && !isNoMachineIndex(error) && !isOldStoreRefusal(error)) throw genericRegistryRefusal();
      throw error;
    }
    throw error;
  }
  if (!explicitTeam && ctx.marker === "live" && (!ctx.registryPath || !existsSync(ctx.registryPath))) {
    throw genericRegistryRefusal();
  }
  return ctx;
}

function initialArgs(argv: string[]): string[] {
  const first = argv[0] ?? "";
  if (!first) return argv.length > 0 ? argv.slice(1) : argv;
  if (first.startsWith("--")) {
    if (first && !["--json", "--all", "--names", "--active", "--offline", "--wide", "--stalled", "--stale-after", "--refresh-models"].includes(first)) {
      throw new TapError(1, "unknown_option", "tap help team", `unknown option '${first}'`);
    }
    return argv;
  }
  if (!TEAM_SUBCOMMANDS.includes(first)) {
    throw new TapError(
      1,
      "unknown_subcommand",
      "tap help team",
      `unknown subcommand '${first}' (usage: tap team [list|roster|calibration|attach|detach|down|out|up|refresh|shutdown|reset|restore|purge] [--json|--all|--wide])`,
    );
  }
  return first === "roster" ? argv.slice(1) : argv;
}

function parseOptions(argv: string[], allowTeamPositional: boolean = false): TeamOptions {
  const out: TeamOptions = { json: false, all: false, names: false, active: false, offline: false, wide: false, stalled: false };
  let staleAfter: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") out.json = true;
    else if (arg === "--stalled") out.stalled = true;
    else if (arg === "--stale-after") {
      staleAfter = argv[++i];
      if (!staleAfter) throw new TapError(1, "usage_error", "tap help team", "--stale-after needs a value (seconds)");
    }
    else if (arg === "--all") out.all = true;
    else if (arg === "--names") out.names = true;
    else if (arg === "--active") out.active = true;
    else if (arg === "--offline") out.offline = true;
    else if (arg === "--wide") out.wide = true;
    else if (arg === "--refresh-models") out.refreshModels = true;
    else if (arg.startsWith("--")) {
      throw new TapError(1, "unknown_option", "tap help team", `unknown option '${arg}'`);
    } else if (allowTeamPositional && !out.team) {
      if (!arg) throw new TapError(1, "usage_error", "tap help team", "team name cannot be empty");
      out.team = arg;
    } else {
      throw new TapError(1, "usage_error", "tap help team", `unexpected arg '${arg}'`);
    }
  }
  if (out.names && out.json) {
    throw new TapError(
      1,
      "usage_error",
      "tap team --names   (or: tap team --json)",
      "--names and --json are alternative output shapes — pick one",
    );
  }
  if (out.names && out.refreshModels) {
    throw new TapError(
      1,
      "usage_error",
      "tap team --refresh-models   (or: tap team --names)",
      "--refresh-models prints the roster; --names prints handles only — pick one",
    );
  }
  if (staleAfter !== undefined && !out.stalled) {
    throw new TapError(1, "usage_error", "tap help team", "--stale-after needs --stalled");
  }
  if (out.stalled && out.all) {
    throw new TapError(1, "usage_error", "tap help team", "--stalled and --all are alternative views — pick one (--all skips the state pass --stalled reads)");
  }
  if (out.stalled) {
    if (staleAfter !== undefined && !/^\d+$/.test(staleAfter)) {
      throw new TapError(1, "usage_error", "tap help team", `--stale-after must be a positive integer (seconds), got '${staleAfter}'`);
    }
    const seconds = staleAfter === undefined ? DEFAULT_STALE_AFTER : Number(staleAfter);
    if (seconds <= 0) throw new TapError(1, "usage_error", "tap help team", "--stale-after must be > 0");
    if (!Number.isSafeInteger(seconds)) throw new TapError(1, "usage_error", "tap help team", `--stale-after must not exceed ${Number.MAX_SAFE_INTEGER}, got '${staleAfter}'`);
    out.staleAfter = seconds;
  }
  if (out.active && out.offline) {
    throw new TapError(
      1,
      "usage_error",
      "tap help team",
      "--active and --offline are mutually exclusive",
    );
  }
  return out;
}

/** Shared with onboarding so invalid roster forms cannot initialize a repository. */
export function parseRosterOptions(argv: string[]): TeamOptions {
  const args = argv.filter(arg => arg !== "--context");
  return parseOptions(initialArgs(args), args[0] === "roster");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Python's `or` treats empty lists and dictionaries as false. Keep that rule
// before validating container shapes; JavaScript's object truthiness differs.
function pythonOr(value: unknown, fallback: unknown): unknown {
  if (value === undefined || value === null || value === false || value === "" || value === 0) return fallback;
  if (Array.isArray(value) && value.length === 0) return fallback;
  if (record(value) && Object.keys(value).length === 0) return fallback;
  return value;
}

export function readRegistry(path: string, wantJson: boolean, crewOnly: boolean): RegistryRead {
  try {
    // loadRegistry's write-safe numeric restrictions are intentionally not
    // imposed on this display-only projection. Invalid UTF-8 still refuses.
    // Missing is not empty: this path names the enrolled acting authority, so
    // ENOENT is an observation failure just like malformed bytes.
    const reg: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(path)),
    );
    if (!record(reg)) throw new Error("registry document must be an object");
    const teamRecord = pythonOr(reg.team, {});
    if (!record(teamRecord)) throw new Error("registry team must be an object");
    const team = Object.hasOwn(teamRecord, "name") ? teamRecord.name : "";
    const agents = pythonOr(reg.seats, {});
    if (!record(agents)) throw new Error("registry seats must be an object");
    const rows: RegistryRow[] = [];
    // Python sorted() compares code points, including JSON-escaped surrogates.
    const handles = Object.keys(agents).sort((a, b) => {
      const left = Array.from(a, c => c.codePointAt(0)!);
      const right = Array.from(b, c => c.codePointAt(0)!);
      for (let i = 0; i < Math.min(left.length, right.length); i++) {
        if (left[i] !== right[i]) return left[i]! - right[i]!;
      }
      return left.length - right.length;
    });
    for (const handle of handles) {
      const ent = agents[handle];
      if (!record(ent) || (crewOnly && ent.crew !== true)) continue;
      const get = (key: string, fallback: unknown = "") => Object.hasOwn(ent, key) ? ent[key] : fallback;
      rows.push({
        team, handle,
        harness_session_id: ent.harness_session_id, transcript_path: ent.transcript_path,
        harness: get("harness"), pane: get("pane"), status: get("status", "active"),
        status_reason: pythonOr(ent.status_reason, ""), delivery: pythonOr(ent.delivery, "pane"),
        pane_id: pythonOr(ent.pane_id, ""), unattended: ent.unattended === true,
        session: pythonOr(ent.session, ""), registered_at: pythonOr(ent.registered_at, ""),
        crew: ent.crew === true, server_epoch: pythonOr(ent.server_epoch, ""),
        ...(ent.server_socket ? {server_socket: ent.server_socket} : {}),
        boot_id: pythonOr(ent.boot_id, ""), preset: record(ent.preset) ? pythonOr(ent.preset.name, "") : "",
        model: ent.model, launch_tuning: ent.launch_tuning,
      });
    }
    return { ok: true, team, rows };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // Keep the existing public error envelope and exit path. Native diagnostics
    // name the bad input rather than reproducing an incidental Python traceback.
    return wantJson
      ? { ok: false, rawError: true, rawOutput: ensureAscii(JSON.stringify({ team: null, agents: [], error: detail })) + "\n" }
      : { ok: false, rawError: true, error: `tap team: registry unreadable (${detail}) — run: tap doctor\n` };
  }
}


function presetFacts(
  rows: RegistryRow[],
): Record<string, Record<string, unknown>> {
  const handles = rows.map((row) => str(row.handle)).filter(Boolean);
  const recorded = Object.fromEntries(
    rows.map((row) => [str(row.handle), str(row.preset)]).filter(([, preset]) => preset),
  );
  let facts: Record<string, Record<string, unknown>>;
  try {
    const catalog = tryLoadCatalogForDisplay(new Notices(() => {}), process.env,
      readSecureBytes, configDirectory(process.env), isRegularFile);
    facts = rosterDisplayFacts(handles, { recorded, catalog });
  } catch {
    // An invalid config location has the same display-only fallback as an unreadable catalog.
    facts = rosterDisplayFacts(handles, { recorded, catalog: null });
  }
  const reference = rows.some(row => record(row.launch_tuning)) ? loadModelReference() : [];
  for (const row of rows) {
    const handle = str(row.handle), fact = facts[handle];
    // A preset inferred from the handle is a guess, so its explicit family is not
    // claimed; the seat falls back to what its own harness implies.
    if (fact?.preset_inferred === true) delete fact.family;
    if (!record(row.launch_tuning) && !row.model) continue;
    // A current preset is a recipe, not a reconstruction of a running seat, so its
    // metadata and roles are dropped. Its family is kept: the seat recorded the
    // preset by name, and the lineage is the operator's own label for it.
    if (fact) { delete fact.metadata; delete fact.roles; }
    const variant = record(row.launch_tuning) ? matchingVariant(reference, str(row.harness), row.launch_tuning as LaunchTuning) : undefined;
    if (variant) {
      // The reference supplies role and cost fields. Lineage is one value: the
      // published metadata.model_family is the row's resolved family, never the
      // reference variant's own, so the two surfaces cannot disagree.
      const family = str(fact?.family) || harnessModelFamily(str(row.harness));
      const { model_family: _reference, ...rest } = variant.metadata ?? {};
      const metadata = family ? { ...rest, model_family: family } : variant.metadata ? rest : null;
      facts[handle] = { ...fact, metadata, metadata_source: "launch-reference" };
    }
  }
  // The windows are read here, in-process, one config read for the roster —
  // not once per handle through the Python forwarder, which spawned the native
  // reader per row (A1a: the 2,000-seat `tap team --json` arm reddened on it).
  // A digit string past 2^53 travelled as JSON digits before and rounded on
  // parse; `Number(source)` is that same rounding.
  const team = str(rows[0]?.team);
  const doc = windowsDoc(process.env);
  const plain = (value: number | PyInt): number => (value instanceof PyInt ? Number(value.source) : value);
  for (const handle of handles) {
    const windows = effectiveWindows(team, handle, process.env, doc);
    facts[handle] = { ...(facts[handle] ?? {}), digest_window_seconds: plain(windows.digest_window_seconds), ask_window_seconds: plain(windows.ask_window_seconds) };
  }
  return facts;
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
  const native = rows.map((row) => {
    let percent: number | null = null, sampledAt: string | null = null, screen = "";
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
          const codex = /^codex(?:-|$)/.test(row.harness);
          const capture = tmuxReadOnly(["capture-pane", ...(codex ? ["-e"] : []), "-p", "-t", row.observedPaneId]);
          if (capture.code === 0) {
            const title = codex ? tmuxReadOnly(["display-message", "-p", "-t", row.observedPaneId, "#{pane_title}"]) : null;
            const generation = tmuxReadOnly(["display-message", "-p", "#{pid}:#{start_time}"]);
            const currentEpoch = generation.code === 0
              ? serverEpochFromRaw(generation.stdout.trim())
              : "";
            result = (!title || title.code === 0) && row.observedServerEpoch && currentEpoch === row.observedServerEpoch
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
    return { row, result, screen, percent, sampledAt };
  });
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

/** The refresh remedy for the roster on screen: an explicitly selected team must name itself, or the command resolves the caller's own team. */
function refreshCommandFor(team?: string): string {
  return team ? `tap team roster ${team} --refresh-models` : "tap team --refresh-models";
}

/**
 * `--refresh-models`: fetch each distinct OpenCode session directory once and rewrite the persisted map. Partial
 * failure is reported on stderr and the roster still prints; when every fetch fails the refresh itself has failed.
 */
function refreshOpenCodeModels(rows: ObservedRow[], command: string, json: boolean): TapError | null {
  const seats = rows.filter(row => row.harness === "opencode" && row.status === "active" && !row.foreignNamespace)
    .map(row => ({ sessionId: row.harnessSessionId ?? "", path: row.transcriptPath ?? "" }));
  const directories = opencodeSessionDirectories(seats);
  // Under --json stderr stays empty (CLI-ERR): the roster's window_tokens already says which models are unknown.
  const say = (line: string): void => { if (!json) process.stderr.write(line); };
  if (!directories.length) { say("tap team: no OpenCode seat with a session directory to refresh\n"); return null; }
  const result = refreshWindowMap(directories);
  if (!result.written) {
    return new TapError(1, "model_refresh_failed", command,
      `could not fetch OpenCode model info in ${result.directories} project ${result.directories === 1 ? "directory" : "directories"}; is opencode installed and working there?`);
  }
  say(`tap team: refreshed model info for ${result.directories - result.failed.length} of ${result.directories} project directories (${result.models} models)\n`);
  for (const directory of result.failed) say(`tap team: could not fetch model info in ${directory}; is opencode installed?\n`);
  return null;
}

/** An OpenCode seat whose input is known but whose model has no recorded window: the persisted map lacks it. */
function modelWindowMissing(row: ObservedRow): boolean {
  return row.harness === "opencode" && row.tokenSample?.input_tokens != null && row.tokenSample.window_tokens == null;
}

function contextCell(row: ObservedRow): string {
  if (row.tokenSample?.input_tokens == null) return "—";
  const count = formatContextTokens(row.tokenSample);
  return modelWindowMissing(row) ? `${count} / ?` : count;
}

function withTokenSamples(rows: ObservedRow[], panePids = new Map<string,string>()): ObservedRow[] {
  const readOpenCode = createOpenCodeContextReader();
  const active = rows.filter(row => row.status === "active" && !row.foreignNamespace);
  const windows = claudeWindows(active.filter(row => /^claude(?:-|$)/.test(row.harness)).map(row => panePids.get(row.observedPaneId) ?? "").filter(Boolean));
  return rows.map(row => {
    if (!active.includes(row)) return row;
    let tokenSample = row.harness === "opencode"
      ? readOpenCode(row.harnessSessionId ?? "", row.transcriptPath ?? "")
      : readContextTokens(row.harness, row.harnessSessionId ?? "", row.transcriptPath ?? "");
    if (/^claude(?:-|$)/.test(row.harness)) {
      const window = windows.get(panePids.get(row.observedPaneId) ?? "");
      if (window?.state === "set") tokenSample = withClaudeWindow(tokenSample, window.value);
      else if (window?.state === "unset") tokenSample = withClaudeWindow(tokenSample, null);
    }
    // A transcript bound to another session cannot date this seat's turn.
    if (tokenSample?.unknown_reason === "session_mismatch") return {...row, tokenSample, turnEndedAt: null, turnEndedSource: null};
    return {...row, tokenSample};
  });
}

function width(value: string): number { return Array.from(value.replace(ANSI, "")).length; }

function truncate(value: string, size: number): string {
  const chars = Array.from(value);
  if (chars.length <= size) return value;
  if (size <= 3) return chars.slice(0, size).join("");
  return `${chars.slice(0, size - 3).join("")}...`;
}

function columnWidths(headers: string[], records: string[][]): number[] {
  const rows = [headers, ...records];
  return headers.map((_, i) => Math.max(...rows.map((row) => width(row[i] ?? ""))));
}

/**
 * Which columns survive at `terminal` width: dropped right-to-left until the
 * row fits, never `handle` (0) or `state` (2), so a narrow terminal loses
 * whole columns instead of wrapping. `null` keeps every column.
 */
export function fitColumns(widths: number[], terminal: number | null): number[] {
  const kept = widths.map((_, i) => i);
  if (terminal === null) return kept;
  for (let i = widths.length - 1; i >= 0; i--) {
    if (i === 0 || i === 2) continue;
    const used = kept.reduce((sum, j) => sum + widths[j]!, 0) + 2 * (kept.length - 1);
    if (used <= terminal) break;
    kept.splice(kept.indexOf(i), 1);
  }
  return kept;
}

/** Roster width source: a TTY-only question, so pipes and redirections never
 * drop columns. `--wide` opts out. COLUMNS wins on a TTY, matching the
 * precedence `table()` has always used. */
function rosterWidth(wide: boolean): number | null {
  if (wide || !process.stdout.isTTY) return null;
  if (/^[0-9]+$/.test(process.env.COLUMNS ?? "")) {
    const forced = Number(process.env.COLUMNS);
    if (forced > 0) return forced;
  }
  const columns = process.stdout.columns;
  return columns && columns > 0 ? columns : null;
}

export function table(headers: string[], records: string[][], terminal?: number | null): string {
  const rows = [headers, ...records];
  const widths = columnWidths(headers, records);
  if (terminal === null) {
    const last = headers.length - 1;
    return rows.map((row) => row.map((cell = "", i) => {
      if (i === last) return cell;
      return cell.padEnd(widths[i]! + cell.length - width(cell)) + "  ";
    }).join("") + "\n").join("");
  }
  let size = terminal ?? (/^[0-9]+$/.test(process.env.COLUMNS ?? "")
    ? Number(process.env.COLUMNS)
    : process.stdout.columns ?? 80);
  if (size <= 0) size = 80;
  const last = headers.length - 1;
  const fixed = widths.slice(0, last).reduce((sum, n) => sum + n, 2 * last);
  widths[last] = Math.min(widths[last]!, Math.max(3, size - fixed));
  return rows.map((row) => row.map((cell = "", i) => {
    const shown = i === last ? truncate(cell, widths[i]!) : cell;
    return i === last ? shown : shown.padEnd(widths[i]! + shown.length - width(shown)) + "  ";
  }).join("") + "\n").join("");
}

export function isDaemon(row: { delivery?: unknown; harness?: unknown }): boolean {
  return row.delivery === "poll" || row.harness === "daemon";
}

function rosterMatches(row: ObservedRow, options: TeamOptions): boolean {
  if (!options.active && !options.offline) return true;
  if (isDaemon(row)) return false;
  return options.active ? row.status === "active"
    : ["offline", "gone", "suspended", "expired"].includes(row.status);
}

export function rosterStyle(): boolean {
  return !!process.stdout.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
}

function humanHarness(row: ObservedRow): string {
  return isDaemon(row) ? (rosterStyle() ? "\x1b[3mdaemon\x1b[0m" : "daemon") : row.harness;
}

/** Observed model@effort from the bound-transcript sample; the (launch)
 * marker keeps the fallback honest when no observation exists. */
function modelCell(row: ObservedRow): string {
  const tuning = row.tokenSample?.tuning;
  if (tuning) return tuning.effort ? `${tuning.model}@${tuning.effort}` : tuning.model;
  return row.model || row.effort ? `${row.model || "?"}@${row.effort || "?"} (launch)` : "?";
}

function humanAgent(row: ObservedRow, team: string): string {
  const state: HumanAgentState = isDaemon(row) && row.status === "active" ? "ready"
    : row.status === "suspended" && row.statusReason === "incapable"
    ? "incapable"
    : row.status === "active"
    ? (row.agentStateReason === "sentinel_unsubmitted" ? "unsubmitted" : row.agentState)
    : row.status === "unbound" ? "unbound" : "offline";
  // The exhausted healing alarm is the roster-visible half of the stuck-paint
  // alarm (tap-cl1es): the leader reads the cause and the manual cure here.
  // Working counts from turn start; idle and waiting from turn end (tap-i5fzq).
  const dated = row.agentState === "working" ? row.turnStartedAt : row.turnEndedAt;
  const age = row.status === "active" && dated != null && state === row.agentState
    ? ` ${formatAge(Number(process.env.TAP_WATCH_NOW || Math.trunc(Date.now() / 1000)) - dated)}` : "";
  const label = row.agentStateReason === "heal_exhausted" && (row.agentState === "overprint" || row.agentState === "booting")
    ? `${row.agentState} · heal exhausted (tap nudge)`
    : `${state}${age}`;
  const target = team ? `${team}/${row.handle}` : row.handle;
  return statusIndicator(state, state === "blocked" ? `needs you: tap attach ${shlexQuote(target)}` : label);
}

/** Shared roster/ps status semantics; keep the label useful without terminal color. */
export function statusIndicator(state: string, label = state): string {
  const color = Object.hasOwn(AGENT_COLOR, state) ? AGENT_COLOR[state as HumanAgentState] : AGENT_COLOR.unknown;
  const dot = rosterStyle() ? `\x1b[${color}m●\x1b[0m` : "●";
  return `${dot} ${label}`;
}

function isoSeconds(epoch: number | null | undefined): string | null {
  return epoch == null ? null : new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

interface StalledView extends StalledJudgement { afterSeconds: number }

function rosterJson(team: string, rows: ObservedRow[], facts: Record<string, Record<string, unknown>>, queue: Record<string, unknown> = {}, stalled?: StalledView): string {
  const stalledFor = new Map((stalled?.stalled ?? []).map(s => [s.handle, s.stalledForSeconds]));
  const agents = rows.map((row) => {
    const sampled = row.tokenSample?.input_tokens == null ? null : row.tokenSample;
    // The tuning object stays out of context_tokens; observed model/effort
    // surface as their own top-level keys beside the launch provenance.
    // Tuning is independent of the usage verdict: it survives compaction and
    // outlives invalid usage, so it reads off the sample even when
    // context_tokens is null.
    const contextTokens = sampled ? (({ tuning, ...rest }) => rest)(sampled) : null;
    const tuning = row.tokenSample?.tuning ?? null;
    const item: Record<string, unknown> = {
      handle: row.handle,
      harness: row.harness,
      model: row.model ?? null,
      effort: row.effort ?? null,
      launch_tuning: row.launchTuning ?? null,
      observed_model: tuning?.model ?? null,
      observed_effort: tuning?.effort ?? null,
      observed_at: tuning?.observed_at ?? null,
      pane: row.pane,
      status: row.status,
      status_reason: row.statusReason,
      agent_state: row.agentState,
      agent_state_reason: row.agentStateReason,
      waiting_on: row.waitingOn ?? [],
      turn_started_at: isoSeconds(row.turnStartedAt),
      turn_ended_at: isoSeconds(row.turnEndedAt),
      turn_ended_source: row.turnEndedSource ?? null,
      context_tokens: contextTokens,
      // Why the count is unknown: the reader's reason, or not_sampled for a row
      // the census did not read. Never derived from the seat's state.
      context_unknown_reason: contextTokens ? null : row.tokenSample?.unknown_reason ?? "not_sampled",
      context_used_percent: row.contextUsedPercent ?? null,
      context_source: row.contextUsedPercent == null ? null : "footer",
      sampled_at: row.contextSampledAt ?? null,
      ...(queue[row.handle] as object ?? {}),
      ...(stalledFor.has(row.handle) ? { stalled: true, stalled_for_seconds: stalledFor.get(row.handle), pending_inbound_ask: true } : {}),
      attached: row.attached,
      unattended: row.unattended,
      crew: row.crew,
      ...(row.crew ? { crew_lifetime: row.crewLifetime ?? "unknown" } : {}),
      digest_window_seconds: row.digestWindow ?? 10,
      ask_window_seconds: row.askWindow ?? 10,
    };
    if (row.serverSocket) item.server_socket = row.serverSocket;
    const fact = facts[row.handle];
    if (fact) {
      if (typeof fact.preset === "string" && fact.preset) item.preset = fact.preset;
      for (const key of [
        "preset_inferred", "preset_absent_from_catalog", "preset_catalog_unavailable", "metadata", "metadata_source",
      ]) if (key in fact) item[key] = fact[key];
    }
    // Always present so a consumer grouping by family reads null, not a missing key.
    item.family = row.family ?? null;
    item.family_source = row.familySource ?? null;
    return item;
  });
  const doc = { team: team || null, agents, ...(stalled ? { stalled_after_seconds: stalled.afterSeconds, unjudged: stalled.unjudged } : {}) };
  return `${ensureAscii(JSON.stringify(doc))}\n`;
}

const UNJUDGED_TEXT = { no_turn_end_date: "no dated turn end", inbound_unknown: "inbound unreadable" } as const;

/** The roster's idle seats joined to what each still owes; see roster-stalled.ts for the claim rules. */
function stalledView(ctx: ResolvedContext, sampled: ObservedRow[], team: string, afterSeconds: number): StalledView {
  const now = Number(process.env.TAP_WATCH_NOW || Math.trunc(Date.now() / 1000));
  // Only idle seats can qualify, so only they are asked what they owe.
  const handles = sampled.filter(row => row.agentState === "idle").map(row => row.handle);
  // The grant `tap poll` and `tap read` use: adopted and forwarded custody and retired-instance
  // stamps all follow it. A registry it cannot read says unknown, never "owes nothing".
  const grantContext = { registryPath: ctx.registryPath, marker: ctx.marker, team: ctx.team, historyDir: historyDirForBus(ctx.bus.home) };
  // The roster read its own snapshot earlier; the grant reads the registry afresh, so a file that
  // turned unreadable since must not look like a verified "not the addressee".
  let readable = true;
  // loadRegistry answers an empty document for a vanished file, so presence is checked too.
  try { if (!existsSync(ctx.registryPath)) throw new Error("registry vanished"); loadRegistry(ctx.registryPath); } catch { readable = false; }
  const gate: AddresseeGate = (ask, actor) => {
    if (!readable) return null;
    const grant = addresseeGrant({ ...grantContext, id: ask.id, from: ask.from, actor, to: ask.to, adoptedFrom: ask.adoptedFrom, recipientInstance: ask.recipientInstance });
    if (grant.ok) return true;
    if (grant.errorClass === "registry_unreachable" || grant.errorClass === "old_store") return null;
    // A stamped ask whose own addressee has no resolvable instance cannot be judged either way.
    return grant.errorClass === "instance_unresolved" && ask.to === actor ? null : false;
  };
  const inbound = pendingInboundAsks(ctx.bus.home, globalRegistryPath(), team, handles, gate);
  return { ...judgeStalled(sampled, inbound, now, afterSeconds), afterSeconds };
}

function stalledFooter(view: StalledView, seatCount: number): string {
  const lines: string[] = [];
  if (view.stalled.length === 0) lines.push(`tap team: no stalled seats (idle >= ${view.afterSeconds}s with an unanswered ask)`);
  else lines.push(`stalled: ${view.stalled.length} seat${view.stalled.length === 1 ? "" : "s"} idle >= ${view.afterSeconds}s with an unanswered ask (of ${seatCount})`);
  if (view.unjudged.length) lines.push(`not judged: ${view.unjudged.map(u => `${u.handle} (${UNJUDGED_TEXT[u.reason]})`).join(", ")}`);
  return `${lines.join("\n")}\n`;
}

function teamUp(args: string[], scriptsDir: string): number | Promise<number> {
  if (args.includes("--json")) process.env.TAP_JSON = "1";
  // --attach/--tabs are verb-level flags, not launcher flags. The operand
  // scanners see them in place, so an option still marks an omitted selector's
  // boundary (`--only --attach lead` stays refused); only the resume door's
  // parser and the downstream re-scans get the argv without them. After `--`
  // they are literal operands, left for the resume door to refuse.
  const separator = args.indexOf("--");
  const options = separator < 0 ? args : args.slice(0, separator);
  const attach = options.includes("--attach");
  const tabs = options.includes("--tabs");
  const isVerbFlag = (arg: string) => arg === "--attach" || arg === "--tabs";
  const filtered = [...options.filter(arg => !isVerbFlag(arg)), ...(separator < 0 ? [] : args.slice(separator))];
  const operand = scanTeamOperand(args);
  const scanned = scanOptionalSelection("team up", operand.rest);
  if (operand.extra) throw new TapError(1, "usage_error", "tap help team up",
    operand.target ? `unexpected extra argument after team '${operand.target}'` : "unexpected extra team argument", "tap team up");
  // Validate launcher flags before presenting any picker. The door's effective
  // modes (abbreviations such as --j, and TAP_JSON=1) decide --attach, never
  // a raw spelling.
  let modes: ReturnType<typeof parseSessionDoor>;
  try { modes = parseSessionDoor("resume", ["--all", ...scanOptionalSelection("team up", scanTeamOperand(filtered).rest).rest.filter(arg => arg !== "--yes")]); }
  catch (error) { throw new TapError(1, "usage_error", "tap help team up", String((error as Error).message), "tap team up"); }
  // The renderer reads only the TAP_JSON gate: an abbreviated --j must still
  // get each attach-flag refusal as the one JSON object.
  const refuse = (detail: string): never => {
    if (modes.json) process.env.TAP_JSON = "1";
    throw new TapError(1, "usage_error", "tap help team up", detail, "tap team up");
  };
  if (tabs && !attach) refuse("--tabs without --attach; --tabs only shapes the attach viewers");
  if (attach && modes.json) refuse("--attach opens viewers and prints human receipts; drop --json");
  let exact: ResolvedContext | undefined;
  let needsTeam = false;
  try { exact = resolveContext(process.cwd(), process.env, operand.target ? { explicitTeam: operand.target, readOnly: true } : { readOnly: true }); }
  catch (error) {
    if (error instanceof TapError && ((error.errorClass === "unknown_team" && discoveryTerminalAvailable(args.includes("--json")))
      || (!operand.target && error.errorClass === "unanchored_bus"))) needsTeam = true;
    else if (error instanceof TapError && operand.target) throw new TapError(error.code, error.errorClass, error.action, error.detail, "tap team up");
    else throw error;
  }
  const attachOptions = attach ? { tabs } : undefined;
  if (scanned.pending || needsTeam) return interactiveUp(filtered, scriptsDir, operand.target, exact, scanned.pending, scanned.selection, attachOptions);
  return teamUpExact(filtered, scriptsDir, undefined, attachOptions);
}

async function interactiveUp(
  args: string[], scriptsDir: string, typedTeam: string | undefined, exact: ResolvedContext | undefined,
  pending: "--only" | "--except" | undefined, supplied: ReturnType<typeof noSelection>, attach?: { tabs: boolean },
): Promise<number> {
  requireDiscoveryTerminal("team up", "tap team up <team> [--only <h,...> | --except <h,...>]", args.includes("--json"));
  let team: BoundTeam;
  if (exact) team = { team: exact.team, root: exact.root, registryPath: exact.registryPath, context: exact };
  else {
    const picked = await chooseTeam("team up", typedTeam, pick);
    if (picked.kind === "cancelled") { process.stdout.write("tap team up: cancelled\n"); return 0; }
    if (picked.kind === "interrupted") return 130;
    team = picked.value;
  }
  let bound: BoundCohort;
  if (pending) {
    const picked = await chooseSeatCohort("team up", team, pending, pick);
    if (picked.kind === "cancelled") { process.stdout.write("tap team up: cancelled\n"); return 0; }
    if (picked.kind === "interrupted") return 130;
    bound = picked.value;
  } else {
    rosterGate("team up", supplied, registryRoster(team.registryPath));
    crewSelectGate("team up", supplied, team.registryPath);
    const chosen = parentSeatSnapshot(team).filter(row => supplied.mode === "--only" ? supplied.only.includes(row.handle)
      : supplied.mode === "--except" ? !supplied.except.includes(row.handle) : true);
    bound = { team, seats: new Map(chosen.map(row => [row.handle, row])),
      selection: { mode: "--only", only: chosen.map(row => row.handle), except: [] }, original: supplied };
  }
  if (!bound.seats.size) { process.stdout.write("tap team up: no seats selected\n"); return 0; }
  const rest = scanOptionalSelection("team up", scanTeamOperand(args).rest).rest.filter(arg => arg !== "--yes" && arg !== "--dry-run");
  const actual = [team.team, ...rest, "--only", [...bound.seats.keys()].join(",")];
  revalidateTeam(team);
  const preview = await teamUpExact([...actual, "--dry-run"], scriptsDir, bound, attach);
  if (preview !== 0) return preview;
  if (args.includes("--dry-run")) return 0;
  if (!args.includes("--yes") && !(await confirmAction())) { process.stdout.write("tap team up: cancelled\n"); return 0; }
  revalidateTeam(team);
  return await teamUpExact(actual, scriptsDir, bound, attach);
}

function teamUpExact(args: string[], scriptsDir: string, bound?: BoundCohort, attach?: { tabs: boolean }): number | Promise<number> {
  let invoke: (() => Promise<number>) | undefined;
  const status = renderRefusals("tap team up", () => {
    const disposition = lifecycleDisposition("team", "up");
    if (!disposition.ok || disposition.row.registry !== "resume-rows" || disposition.row.tmux !== "relaunch") throw new TapError(1, "lifecycle_fate_invalid", "tap help up", "no resume owner for this team fate");
    const operand = applyTeamOperand("up", args);
    const scanned = operand.rest;
    let selection = noSelection(); const rest: string[] = [];
    for (let i = 0; i < scanned.length; i++) {
      const flag = scanned[i]!;
      if (flag !== "--only" && flag !== "--except") { rest.push(flag); continue; }
      if (selection.mode) {
        if (selection.mode !== flag) selectConflictGate("team up");
        throw new TapError(1, "usage_error", "tap help team up", `${flag} was given more than once`, "tap team up");
      }
      const value = scanned[++i];
      if (value === undefined || value.startsWith("-")) throw new TapError(1, "usage_error", `tap team up ${flag} <handles>`, `${flag} was given no value`, "tap team up");
      selection = parseSelection("team up", value, flag);
    }
    const ctx = teamContext(operand.target); requireActingRegistry(ctx, 1);
    // A named team resumes from its own enrolled root; bare `up` keeps cwd.
    const root = operand.target ? ctx.root : undefined;
    rosterGate("team up", selection, registryRoster(ctx.registryPath));
    crewSelectGate("team up", selection, ctx.registryPath);
    const env = { ...process.env };
    delete env.TAP_TEAM_EXCEPT_HANDLES; delete env.TAP_TEAM_ONLY_HANDLES;
    if (selection.mode) env[selection.mode === "--only" ? "TAP_TEAM_ONLY_HANDLES" : "TAP_TEAM_EXCEPT_HANDLES"] = selectionBlob(selectedHandles(selection));
    // Keep the cohort in process; all spellings use the public native parser.
    const cameUp: { handle: string; session: string }[] = [];
    let interrupted = false;
    invoke = async () => {
      const keys = ["TAP_TEAM_EXCEPT_HANDLES", "TAP_TEAM_ONLY_HANDLES"] as const;
      const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
      for (const key of keys) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
      try {
        const { cmdSessionDoor } = await import("../launcher/session-doors");
        const code = await cmdSessionDoor("resume", ["--all", ...rest.filter(arg => arg !== "--yes")], scriptsDir, lifecycleReceipt(disposition), root, bound,
          attach ? { cameUp: (handle, session) => { cameUp.push({ handle, session }); }, interrupted: () => { interrupted = true; } } : undefined);
        // An interrupt (Ctrl-C 130, SIGTERM 143) cancels the command: never
        // open viewers after the operator stopped it, even when a lower seat's
        // refusal is the error the cohort rethrew.
        if (!attach || interrupted || code === 130 || code === 143) return code;
        // Attach the seats that came up, then combine: team up's own verdict
        // stands unless the attach itself failed (stated in help).
        const { attachCameUp, upWithAttachCode } = await import("../team/attach");
        const { dryRun } = parseSessionDoor("resume", ["--all", ...rest.filter(arg => arg !== "--yes")]);
        const attachCode = attachCameUp(cameUp, { scriptsDir, team: operand.target, tabs: attach.tabs, dryRun });
        return upWithAttachCode(code, attachCode);
      } finally {
        for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
      }
    };
    return 0;
  }, { ...process.env, TAP_JSON: args.includes("--json") ? "1" : process.env.TAP_JSON });
  return invoke ? invoke() : status;
}

function calibration(roster: string, strongest: boolean): number {
  // Window activity is only an idle hint: an unresponsive server must not
  // turn an already-observed roster into a failed calibration view.
  let activity: ReturnType<typeof tmuxReadOnly> | undefined;
  try {
    activity = tmuxReadOnly(["list-panes", "-a", "-F", "#{pane_id}\t#{session_name}:#{window_index}.#{pane_index}\t#{window_activity}"]);
  } catch (error) {
    if (!(error instanceof ServerUnresponsive)) throw error;
  }
  return writeRoutingResult(calibrationView(JSON.parse(roster), activity?.code === 0 ? activity.stdout : "", strongest));
}

interface DisplayItem {
  row: ObservedRow;
  prefix: string;
}

function parseSessionAndWindow(row: ObservedRow): { session: string; windowIndex: number } {
  const pane = row.pane || "";
  let session = row.session || "";
  let windowIndex = 0;
  const colon = pane.indexOf(":");
  if (colon !== -1) {
    const paneSession = pane.slice(0, colon);
    if (paneSession) session = paneSession;
    const rest = pane.slice(colon + 1);
    const dot = rest.indexOf(".");
    const windowStr = dot === -1 ? rest : rest.slice(0, dot);
    const num = Number.parseInt(windowStr, 10);
    if (!Number.isNaN(num)) windowIndex = num;
  }
  return { session, windowIndex };
}

function buildHumanRosterRows(rows: ObservedRow[], hierarchyRows = rows): DisplayItem[] {
  const visibleHandles = new Set(rows.map(row => row.handle));
  const sessionParents = new Map<string, ObservedRow[]>();
  for (const row of hierarchyRows) {
    if (!row.crew) {
      const { session } = parseSessionAndWindow(row);
      if (session) {
        const list = sessionParents.get(session) ?? [];
        list.push(row);
        sessionParents.set(session, list);
      }
    }
  }

  const childrenByParent = new Map<string, { row: ObservedRow; windowIndex: number }[]>();
  const rootlessCrew: { row: ObservedRow; session: string }[] = [];
  const rootlessSet = new Set<ObservedRow>();
  const ambiguousSessions = new Map<string, { parent: ObservedRow; candidateCount: number }>();

  for (const row of rows) {
    if (row.crew) {
      const { session, windowIndex } = parseSessionAndWindow(row);
      const candidateParents = session ? sessionParents.get(session) : undefined;
      if (!candidateParents || candidateParents.length === 0) {
        rootlessCrew.push({ row, session });
        rootlessSet.add(row);
      } else {
        const parent = candidateParents.find(candidate => visibleHandles.has(candidate.handle));
        // Registered parents may all be filtered out; show their selected child flat.
        if (!parent) {
          rootlessSet.add(row);
          continue;
        }
        if (candidateParents.length > 1 && !ambiguousSessions.has(session)) {
          ambiguousSessions.set(session, { parent, candidateCount: candidateParents.length });
        }
        const children = childrenByParent.get(parent.handle) ?? [];
        children.push({ row, windowIndex });
        childrenByParent.set(parent.handle, children);
      }
    }
  }

  // Diagnostic class 1: rootless crew defect — at most ONE stderr line per invocation
  if (rootlessCrew.length === 1) {
    const c = rootlessCrew[0]!;
    process.stderr.write(`tap team: warning: crew seat '${c.row.handle}' has no parent seat in session '${c.session}' — see tap-zhx82\n`);
  } else if (rootlessCrew.length > 1) {
    const seats = rootlessCrew.map((c) => `'${c.row.handle}' (session '${c.session}')`).join(", ");
    process.stderr.write(`tap team: warning: crew seats ${seats} have no parent seat — see tap-zhx82\n`);
  }

  // Diagnostic class 2: ambiguous session parents — at most ONE stderr line per invocation
  if (ambiguousSessions.size === 1) {
    const [session, info] = [...ambiguousSessions.entries()][0]!;
    process.stderr.write(`tap team: warning: multiple parent seats for session '${session}' — nesting under '${info.parent.handle}'; see tap-7ph7f\n`);
  } else if (ambiguousSessions.size > 1) {
    const summary = [...ambiguousSessions.entries()].map(([s, info]) => `'${s}' (nesting under '${info.parent.handle}')`).join(", ");
    process.stderr.write(`tap team: warning: multiple parent seats for sessions ${summary}; see tap-7ph7f\n`);
  }

  // Sort children by window index under each parent; stable sort preserves roster order for equal window indices
  for (const children of childrenByParent.values()) {
    children.sort((a, b) => a.windowIndex - b.windowIndex);
  }

  const display: DisplayItem[] = [];
  for (const row of rows) {
    if (!row.crew) {
      display.push({ row, prefix: "" });
      const children = childrenByParent.get(row.handle);
      if (children && children.length > 0) {
        for (let i = 0; i < children.length; i++) {
          const isLast = i === children.length - 1;
          const prefix = isLast ? "`-- " : "|-- ";
          display.push({ row: children[i]!.row, prefix });
        }
      }
    } else if (rootlessSet.has(row)) {
      display.push({ row, prefix: "" });
    }
  }

  return display;
}

function socketLabel(path: string): string {
  // TMUX_TMPDIR namespaces commonly all end in "default"; retain that path.
  return basename(path) === "default" ? path : basename(path);
}

function renderHuman(team: string, rows: ObservedRow[], all: boolean, wide: boolean, hierarchyRows = rows, refreshCommand = refreshCommandFor()): void {
  rows = [...rows.filter(row => !isDaemon(row)), ...rows.filter(isDaemon)];
  process.stdout.write(`tap ${process.env.TAP_TEAM_LIST_VERB || "team"}: ${team || "(unnamed)"}\n`);
  if (all) {
    // The nine-column schema keeps its TTY truncation; only a redirected run
    // gains the no-truncation guarantee, so `tap team --all | head` is whole.
    process.stdout.write(table(
      ["handle", "kind", "harness", "pane", "status", "attached", "unattended", "reason", "notes/asks"],
      rows.map((row) => [
        row.handle, row.crew ? "CREW" : "SEAT", humanHarness(row), row.pane, row.status,
        row.attached && row.attached !== "0" ? "yes" : "no", row.unattended ? "yes" : "no", row.foreignNamespace ? `bound under ${socketLabel(row.serverSocket!)}` : row.crewLifetime === "unsupervised" ? "crew unsupervised; tap crew rearm " + row.handle : row.statusReason, `${row.digestWindow ?? 10}s/${row.askWindow ?? 10}s`,
      ]),
      process.stdout.isTTY ? undefined : null,
    ));
  } else {
    const displayItems = buildHumanRosterRows(rows, hierarchyRows);
    // Family sits ahead of the long columns: fitColumns drops from the right, so a
    // narrow terminal loses context, model and preset before it loses family.
    const headers = ["handle", "harness", "state", "family", "context", "model", "preset"];
    const records = displayItems.map(({ row, prefix }) => [
      prefix + row.handle, humanHarness(row), humanAgent(row, team) + (row.foreignNamespace ? ` (bound under ${socketLabel(row.serverSocket!)})` : ""),
      row.family || "-",
      contextCell(row),
      modelCell(row),
      row.preset || "n/a",
    ]);
    const terminal = rosterWidth(wide);
    const kept = fitColumns(columnWidths(headers, records), terminal);
    process.stdout.write(table(kept.map(i => headers[i]!), records.map(record => kept.map(i => record[i]!)), null));
    const hidden = headers.filter((_, i) => !kept.includes(i));
    if (hidden.length) {
      const verb = process.env.TAP_TEAM_LIST_VERB || "team";
      process.stderr.write(`tap ${verb}: hid ${hidden.join(", ")} to fit ${terminal} columns; tap ${verb} --wide shows every column\n`);
    }
  }
  const unknownWindow = rows.filter(modelWindowMissing).map(row => row.handle);
  if (unknownWindow.length) process.stderr.write(`Warning: model info missing for ${unknownWindow.join(", ")}. Run ${refreshCommand} to fetch it.\n`);
  const unsupervised = rows.filter(row => row.crew && row.crewLifetime === "unsupervised").map(row => row.handle);
  if (unsupervised.length) process.stdout.write(`Warning: crew supervision missing for ${unsupervised.join(", ")}; run tap crew rearm <handle>.\n`);
}

/**
 * `tap team down|up|shutdown [<team>]` positional scan (H1 tap-team.sh
 * L22-135): a pure pre-parse of the arguments after the subcommand. Option-shaped tokens
 * (including -h) are never team names; --except/--only CONSUME the next token
 * as their value; the first bare token is the target team and a second bare
 * token is an extra-argument error. The target is removed from the arguments
 * handed to the engine — the engine's own bare-arg refusal still guards the
 * remainder.
 */
export function scanTeamOperand(args: readonly string[]): { target?: string; extra: boolean; rest: string[] } {
  let target: string | undefined;
  let extra = false;
  let omittedSelector = false;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) {
      if (target === undefined && !omittedSelector) {
        target = arg;
        continue; // positional never reaches the engine
      }
      extra = true;
      rest.push(arg);
      continue;
    }
    rest.push(arg);
    if (arg === "--except" || arg === "--only") {
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith("-")) {
        rest.push(value);
        i++;
      } else omittedSelector = true;
    }
  }
  return { target, extra, rest };
}

function realPathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The pane-observe record `tap_pane_observe` returns (lib.sh L8236): first
 * line of the display-message fields; an empty pane_id is a failed
 * observation. Consumers read the SECOND tab field as the session key. */
function paneObserve(paneTarget: string): string | null {
  const result = spawnSync("tmux", ["display-message", "-p", "-t", paneTarget, "#{pane_id}\t#{session_name}\t#{pid}:#{start_time}"], {
    encoding: "utf8", env: process.env,
  });
  const line = (result.stdout ?? "").split("\n")[0] ?? "";
  const paneId = line.split("\t")[0] ?? "";
  if (result.status !== 0 || !line || !paneId) return null;
  return line;
}

function liveLifecycleTmux(): LifecycleTmux {
  return {
    hasSession: name => spawnSync("tmux", ["has-session", "-t", `=${name}`], { env: process.env }).status === 0,
    // Liveness-first, matching lib.sh tap_pane_alive: a pane that answers no
    // pane_id is GONE — never read a session name off it (a stale tip would
    // classify a dead row as pane_live_elsewhere instead of unproven). And a
    // tip that answers a DIFFERENT pane id is gone too (the tip moved or the
    // id was recycled): the answer must EXACTLY equal the requested paneId,
    // or the row is treated as unproven — a name-keyed stop on the canonical
    // session still authorizes, per the incumbent authorizer (U4B driver
    // ruling on the crew-late blocker).
    paneSession: paneId => {
      const probe = spawnSync("tmux", ["display-message", "-p", "-t", paneId, "#{pane_id}"], { encoding: "utf8", env: process.env });
      if (probe.status !== 0 || (probe.stdout ?? "").trim() !== paneId) return null;
      const result = spawnSync("tmux", ["display-message", "-p", "-t", paneId, "#{session_name}"], { encoding: "utf8", env: process.env });
      const name = (result.stdout ?? "").trim();
      return result.status === 0 && name ? name : null;
    },
    sessionPaneIds: name => {
      const result = spawnSync("tmux", ["list-panes", "-t", `=${name}`, "-F", "#{pane_id}"], { encoding: "utf8", env: process.env });
      if (result.status !== 0) return [];
      return (result.stdout ?? "").split("\n").filter(l => l.trim().length > 0);
    },
  };
}

export function cmdTeamShutdown(args: string[], _scriptsDir: string): number | Promise<number> {
  return runTeamStopDoor("shutdown", args);
}

export function cmdTeamDown(args: string[], _scriptsDir: string): number | Promise<number> {
  return runTeamStopDoor("down", args);
}

// The one shared body behind every public stop door — `tap team down|shutdown
// [<team>]` and the private `reset-stop` CLI — so no lifecycle decision exists
// twice. The module CLI in stop.ts decodes its own argv and lands here.
export interface StopDoorUI { picker: Picker; consent: () => Promise<boolean> }

export function runTeamStopDoor(verb: StopVerb, args: string[], ui?: StopDoorUI): number | Promise<number> {
  if (args.includes("--json")) process.env.TAP_JSON = "1";
  if (verb !== "reset-stop") {
    const operand = scanTeamOperand(args);
    const scanned = scanOptionalSelection(`team ${verb}`, operand.rest);
    if (operand.extra) throw new TapError(1, "usage_error", `tap help team ${verb}`,
      operand.target ? `unexpected extra argument after team '${operand.target}'` : "unexpected extra team argument", "tap team");
    parseStopArgs(verb, scanned.rest); // all syntax before any discovery
    if (operand.target && flipMarkerState() === "invalid") {
      throw new TapError(1, "invalid_flip", "tap doctor",
        `tap team ${verb} refused — global-registry.json is present but unreadable or wrong schema`, "tap team");
    }
    let exact: ResolvedContext | undefined;
    let needsTeam = false;
    try { exact = resolveContext(process.cwd(), process.env, operand.target ? { explicitTeam: operand.target, readOnly: true } : { readOnly: true }); }
    catch (error) {
      if (error instanceof TapError && ((error.errorClass === "unknown_team" && discoveryTerminalAvailable(args.includes("--json")))
        || (!operand.target && error.errorClass === "unanchored_bus"))) needsTeam = true;
      else if (error instanceof TapError && operand.target) throw new TapError(error.code, error.errorClass, error.action, error.detail, `tap team ${verb}`);
      else throw error;
    }
    if (scanned.pending || needsTeam) return interactiveStop(verb, args, operand.target, exact, scanned.pending, scanned.selection, ui);
  }
  return runTeamStopDoorExact(verb, args);
}

async function interactiveStop(
  verb: "down" | "shutdown", args: string[], typedTeam: string | undefined, exact: ResolvedContext | undefined,
  pending: "--only" | "--except" | undefined, supplied: ReturnType<typeof noSelection>, ui?: StopDoorUI,
): Promise<number> {
  requireDiscoveryTerminal(`team ${verb}`, `tap team ${verb} <team> [--only <h,...> | --except <h,...>]`, args.includes("--json"));
  let team: BoundTeam;
  if (exact) team = { team: exact.team, root: exact.root, registryPath: exact.registryPath, context: exact };
  else {
    const picked = await chooseTeam(`team ${verb}`, typedTeam, ui?.picker ?? pick);
    if (picked.kind === "cancelled") { process.stdout.write(`tap team ${verb}: cancelled\n`); return 0; }
    if (picked.kind === "interrupted") return 130;
    team = picked.value;
  }
  let bound: BoundCohort;
  if (pending) {
    const picked = await chooseSeatCohort(`team ${verb}`, team, pending, ui?.picker ?? pick, false, true);
    if (picked.kind === "cancelled") { process.stdout.write(`tap team ${verb}: cancelled\n`); return 0; }
    if (picked.kind === "interrupted") return 130;
    bound = picked.value;
  } else {
    const parents = parentSeatSnapshot(team);
    rosterGate(`team ${verb}`, supplied, registryRoster(team.registryPath));
    crewSelectGate(`team ${verb}`, supplied, team.registryPath);
    const chosen = parents.filter(row => supplied.mode === "--only" ? supplied.only.includes(row.handle)
      : supplied.mode === "--except" ? !supplied.except.includes(row.handle) : true);
    bound = { team, seats: new Map(chosen.map(row => [row.handle, row])),
      selection: { mode: "--only", only: chosen.map(row => row.handle), except: [] }, original: supplied };
    captureCohortParentLifetimes(bound);
  }
  if (bound.seats.size === 0) { process.stdout.write(`tap team ${verb}: no seats selected\n`); return 0; }
  revalidateTeam(team);
  assertBoundParentLifetimes(bound);
  const entrance = applyTeamOperand(verb, [team.team, ...scanTeamOperand(args).rest]);
  const stripped = scanOptionalSelection(`team ${verb}`, entrance.rest).rest;
  const actual = [...stripped.filter(arg => arg !== "--dry-run"), "--only", [...bound.seats.keys()].join(",")];
  const ctx = resolveContext(process.cwd(), process.env, { explicitTeam: team.team });
  const preview = invokeResolvedStop(verb, ctx, [...actual, "--dry-run"], team.team, bound);
  if (preview !== 0) return preview;
  if (args.includes("--dry-run")) return 0;
  if (!args.includes("--yes") && !(await (ui?.consent ?? confirmAction)())) { process.stdout.write(`tap team ${verb}: cancelled\n`); return 0; }
  revalidateTeam(team);
  assertBoundParentLifetimes(bound);
  await armApprovedCrews(bound);
  return invokeResolvedStop(verb, ctx, actual, team.team, bound);
}

async function armApprovedCrews(bound: BoundCohort): Promise<void> {
  const rows = readDiscoverySeats(bound.team.registryPath);
  const approved = new Map<string, { instance: string; session: string }>();
  for (const [handle, original] of bound.crewAtSelection ?? []) {
    if (![...bound.seats.values()].some(parent => parent.session === original.session)) continue;
    const current = rows[handle];
    if (!current || current.crew !== true || current.instance !== original.instance || current.session !== original.session) {
      throw new TapError(1, "target_changed", `retry tap team ${bound.team.team}`,
        `crew '${handle}' changed identity after selection`, "tap team");
    }
  }
  // Refuse every unapproved late child before reconciling any original child:
  // a failed stop must not arm a different family as a side effect.
  for (const parent of bound.seats.values()) {
    for (const [handle, row] of Object.entries(rows)) {
      if (row?.crew !== true || row.session !== parent.session || bound.crewAtSelection?.has(handle)) continue;
      const lifetime = bound.parentLifetimes?.get(parent.handle);
      const binding = crewLifetimeBinding(typeof row.pane_id === "string" ? row.pane_id : "");
      if (!lifetime || !binding || !crewLifetimeMatchesRows(binding, parent.handle, rows[parent.handle]!, handle, row)
        || binding.parent.pid !== lifetime.process.pid || binding.parent.start !== lifetime.process.start
        || binding.parent.boot !== lifetime.process.boot || !validateCrewLifetimeBinding(binding)) {
        throw new TapError(1, "crew_lifetime_unprovable", "tap team doctor",
          `crew '${handle}' has no approved parent lifetime binding before the team action`, "tap team");
      }
    }
  }
  for (const parent of bound.seats.values()) {
    const children = Object.entries(rows).filter(([, row]) => row?.crew === true && row.session === parent.session);
    if (!children.length) continue;
    const owners = Object.entries(rows).filter(([, row]) => row?.crew !== true && row.session === parent.session);
    if (owners.length !== 1 || owners[0]![0] !== parent.handle || !bound.parentLifetimes?.has(parent.handle)) {
      throw new TapError(1, "crew_owner_ambiguous", "tap team doctor",
        `crew in session '${parent.session}' has no uniquely approved live parent`, "tap team");
    }
    const lifetime = bound.parentLifetimes!.get(parent.handle)!;
    for (const [handle, row] of children) {
      const original = bound.crewAtSelection?.get(handle);
      if (original && (original.instance !== row.instance || original.session !== parent.session)) {
        throw new TapError(1, "target_changed", `retry tap team ${bound.team.team}`,
          `crew '${handle}' changed identity after selection`, "tap team");
      }
      // A child published during the confirmation interval may join only if
      // it was already supervised by this exact approved parent generation.
      const binding = original
        ? await reconcileCrewLifetime(bound.team.context, parent.handle, handle)
        : crewLifetimeBinding(typeof row.pane_id === "string" ? row.pane_id : "");
      if (!binding || !crewLifetimeMatchesRows(binding, parent.handle, rows[parent.handle]!, handle, row)
        || binding.parent.pid !== lifetime.process.pid || binding.parent.start !== lifetime.process.start
        || binding.parent.boot !== lifetime.process.boot || !validateCrewLifetimeBinding(binding)) {
        throw new TapError(1, "crew_lifetime_unprovable", "tap team doctor",
          `crew '${handle}' has no approved parent lifetime binding before the team action`, "tap team");
      }
      approved.set(handle, { instance: binding.crewInstance, session: parent.session });
      assertBoundParentLifetimes(bound);
    }
  }
  bound.approvedCrewAtConsent = approved;
}

function runTeamStopDoorExact(verb: StopVerb, args: string[]): number {
  const entrance = verb === "reset-stop" ? { target: undefined, rest: args } : applyTeamOperand(verb, args);
  const ctx = entrance.target
    ? resolveContext(process.cwd(), process.env, { explicitTeam: entrance.target })
    : resolveContext(process.cwd(), process.env);
  return invokeResolvedStop(verb, ctx, entrance.rest, entrance.target);
}

function invokeResolvedStop(verb: StopVerb, ctx: ResolvedContext, argv: string[], namedTeam?: string, bound?: BoundCohort): number {
  // The internal reset-stop door has no fence: it runs INSIDE the reset's own
  // fenced window (U3). The public doors carry the incumbent's full
  // `tap team <verb>` label in the fence refusal (H1 tap_reset_fence_guard).
  if (verb !== "reset-stop") assertResetUnfenced(ctx.bus.home, `tap team ${verb}`);
  const roster = registryRoster(ctx.registryPath);
  // Entrance policies are the incumbent's: down suspends, shutdown clears,
  // and reset-stop runs policy `none` — reset owns the registry itself.
  let policy: RegistryPolicy = "none";
  if (verb !== "reset-stop") {
    const disposition = lifecycleDisposition("team", verb);
    if (!disposition.ok || disposition.row.tmux !== "stop-named-sessions") throw new TapError(1, "lifecycle_fate_invalid", "tap help team", "no stop owner for this team fate");
    if (disposition.row.registry === "suspend-rows") policy = "suspend";
    else if (disposition.row.registry === "delete-acting-file") policy = "clear";
    else throw new TapError(1, "lifecycle_fate_invalid", "tap help team", "no registry owner for this team fate");
  }
  return runTeamStop({
    verb,
    policy,
    argv,
    ctx,
    roster,
    effects: productionStopEffects(ctx),
    fenced: verb !== "reset-stop",
    namedTeam,
    bound,
  });
}

// applyTeamOperand holds the H1 door precedence for `tap team down|up|shutdown
// [<team>]`: positional scan (selector values are skipped, so a selector still
// applies within the named team), then the JSON export + invalid-flip gate
// (corrupt authority refuses before anything else), then named-target
// validation through the roster's own selector. Bare down and up keep their
// cwd-anchored entrance untouched; bare shutdown keeps its incumbent gate.
function applyTeamOperand(verb: "down" | "up" | "shutdown", args: string[]): { target?: string; rest: string[] } {
  const scan = scanTeamOperand(args);
  const target = scan.target;
  if (!target && verb !== "shutdown") return { target, rest: scan.rest };
  if (args.includes("--json")) process.env.TAP_JSON = "1";
  if (flipMarkerState() === "invalid") {
    throw new TapError(
      1,
      "invalid_flip",
      "tap doctor",
      `tap team ${verb} refused — global-registry.json is present but unreadable or wrong schema`,
      "tap team",
    );
  }
  if (target) {
    if (scan.extra) {
      throw new TapError(1, "usage_error", `tap help team ${verb}`, `unexpected extra argument after team '${target}'`, "tap team");
    }
    const sel = process.env.TAP_TEAM_SELECT;
    if (sel && sel !== target) {
      throw new TapError(1, "usage_error", `tap help team ${verb}`, `TAP_TEAM_SELECT='${sel}' conflicts with named target '${target}'`, "tap team");
    }
    // The roster's resolver answers first, so an unknown, retired or
    // unreachable team refuses in the same words `tap team roster <team>` uses.
    try {
      resolveContext(process.cwd(), process.env, { explicitTeam: target });
    } catch (error) {
      if (error instanceof TapError) throw new TapError(error.code, error.errorClass, error.action, error.detail, `tap team ${verb}`);
      throw error;
    }
    // An inherited TAP_HOME is the caller's pin unless lib.sh derived it (the
    // same provenance test as done-alias): a pinned caller never retargets.
    if (process.env.TAP_HOME && ["", "env"].includes(process.env.TAP_BUS_RULE ?? "")) {
      const enrolled = resolveEnrolledTeamRoot(target);
      if (enrolled.kind === "absent") throw noMachineIndexError("tap team");
      if (enrolled.kind !== "ok") {
        // Same class as the selector's unpinned refusal (structured-failures table).
        throw new TapError(
          1,
          "unknown_team",
          "tap register",
          `team '${target}' is not enrolled in the machine index — cannot match it against the pinned TAP_HOME`,
          "tap team",
        );
      }
      const pinBus = busHomeForEnrolled(enrolled.root);
      if (realPathOrSelf(pinBus) !== realPathOrSelf(process.env.TAP_HOME ?? "")) {
        const abs = realPathOrSelf(process.env.TAP_HOME ?? "");
        throw new TapError(
          1,
          "usage_error",
          `tap help team ${verb}`,
          `pinned TAP_HOME '${abs}' is not team '${target}' bus ('${pinBus}') — refusing to override a caller pin`,
          "tap team",
        );
      }
      // lib.sh derives TAP_REGISTRY="$TAP_HOME/registry.json" for every
      // exported TAP_HOME, so that exact value carries no caller intent — only
      // a DIFFERENT TAP_REGISTRY is a genuine acting-registry pin and must be
      // honored (H1 compares the raw value, not a canonical one).
      const pinRegistry = process.env.TAP_REGISTRY;
      if (pinRegistry && pinRegistry !== `${process.env.TAP_HOME ?? ""}/registry.json`) {
        const acting = actingRegistryForTeamOverride(target, pinBus);
        const pinRegAbs = `${realPathOrSelf(dirname(pinRegistry))}/${basename(pinRegistry)}`;
        if (pinRegAbs !== acting) {
          throw new TapError(
            1,
            "usage_error",
            `tap help team ${verb}`,
            `pinned TAP_REGISTRY '${pinRegAbs}' is not team '${target}' acting registry ('${acting}') — refusing to override a caller pin`,
            "tap team",
          );
        }
      }
    } else if (verb !== "up") {
      applyTeamOverride(target);
    }
    // The named positional became TAP_TEAM_SELECT (landed H1): downstream
    // same-process helpers keep the incumbent env contract, and the explicit
    // context parameter below does not erase it. `up` passes the named root to
    // the resume owner instead, so relaunched seats never inherit either pin.
    if (verb !== "up") process.env.TAP_TEAM_SELECT = target;
  }
  return { target, rest: scan.rest };
}

export function productionStopEffects(ctx: ResolvedContext): StopEffects {
  const identityObservation = observeCallingPane(process.env);
  return {
    tmux: liveLifecycleTmux(),
    killSession: session => spawnSync("tmux", ["kill-session", "-t", `=${session}`], { env: process.env }).status === 0,
    hasSession: session => spawnSync("tmux", ["has-session", "-t", `=${session}`], { env: process.env }).status === 0,
    paneCount: session => liveLifecycleTmux().sessionPaneIds(session).length,
    observeSpare: paneObserve,
    queueSummary: handles => teamStopQueueSummary(ctx.bus.payloadsDir, ctx.bus.receiptsDir, ctx.team, handles),
    watch: {
      isArmed: () => Boolean(readLoose(armPath(ctx.bus.home))),
      clearTints: () => clearTints(ctx.bus.home),
      disarm: () => disarm(armPath(ctx.bus.home)),
    },
    identity: {
      tmuxActive: Boolean(process.env.TMUX),
      callingPaneId: identityObservation.state === "inside" ? identityObservation.paneId : "",
      callingPaneRefusal: identityObservation.state === "unobservable" ? identityObservation.refusal
        : identityObservation.state === "outside" ? identityObservation.detail : "",
      selfRefusal: identityObservation.state === "unobservable" && identityObservation.unverifiable ? "generation_unverifiable" : "",
      resolveSelf: () => {
        const observation = callingPane(process.env);
        if (!observation || observation.status !== "ok") return null;
        try {
          const self = resolveSelf(ctx, observation, 2);
          return { handle: self.handle, pane: self.pane, paneId: self.paneId };
        } catch {
          return null;
        }
      },
      displaySession: paneTarget => {
        const result = spawnSync("tmux", ["display-message", "-p", "-t", paneTarget, "#{session_name}"], { encoding: "utf8", env: process.env });
        return result.status === 0 ? (result.stdout ?? "").trim() : "";
      },
    },
    runId: process.env.TAP_TEAM_STOP_RUN_ID || String(process.pid),
    eventLog: join(ctx.bus.home, "registry-events.log"),
    io: {
      stdout: line => process.stdout.write(`${line}\n`),
      stderr: line => process.stderr.write(`${line}\n`),
      // The stop engine emits complete `tap team <verb>: warning: ...` lines;
      // pass them through unchanged or every warning would be double-prefixed.
      warn: line => process.stderr.write(`${line.endsWith("\n") ? line : `${line}\n`}`),
    },
  };
}

export function cmdTeam(argv: string[], scriptsDir: string): number | Promise<number> {
  if (argv.length <= 2 && ["help", "-h", "--help"].includes(argv.at(-1) ?? "")) {
    const result = helpArgv(["team", ...argv]);
    process.stdout.write(result.stdout); process.stderr.write(result.stderr); return result.exit;
  }
  const withContextDetails = argv.includes("--context");
  argv = argv.filter(arg => arg !== "--context");
  // Machine-wide discovery must work before resolving the caller's cwd bus.
  if (argv[0] === "list") {
    const args = argv.slice(1);
    const name = args[0];
    if (name && !name.startsWith("-")) return cmdTeam(["roster", ...args], scriptsDir);
    // Bare list enumerates enrolled teams, not a roster: there are no seats to judge.
    const stalledFlag = args.find(arg => arg === "--stalled" || arg === "--stale-after");
    if (stalledFlag) {
      const refusal = new TapError(1, "unknown_option", "tap help team", `unknown option '${stalledFlag}'`);
      if (!args.includes("--json")) throw refusal;
      jsonRefusal(refusal);
      return refusal.code;
    }
    const result = spawnSync(artifactBun() ?? "bun", [resolve(scriptsDir, "../../../runtime/bun/src/routing.ts"), "teams", ...args], {
      encoding: "utf8", env: process.env, maxBuffer: REGISTRY_MAX_BUFFER,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    const rc = result.status ?? 1;
    if (rc === 0) process.stdout.write("to see seats on this team: tap team (or tap team roster)\n");
    return rc;
  }

  // `refresh` is its own verb file: it MUTATES the registry, where every other
  // form here reads. Dispatching before the roster's option parser also keeps
  // refresh's own refusal vocabulary (`tap help team refresh`) intact rather
  // than laundering it through the roster's.
  if (argv[0] === "refresh") return cmdRefresh(argv.slice(1), scriptsDir);
  // `attach` opens viewers: its own option grammar and refusal vocabulary,
  // dispatched before the roster parser for the same reason refresh is.
  if (argv[0] === "doctor") return cmdTeamDoctor(argv.slice(1));
  if (argv[0] === "attach") return cmdTeamAttach(argv.slice(1), scriptsDir);
  if (argv[0] === "detach") return cmdTeamDetach(argv.slice(1));
  if (argv[0] === "out") return cmdTeamOut(argv.slice(1));
  if (argv[0] === "up") return teamUp(argv.slice(1), scriptsDir);
  if (argv[0] === "purge") {
    const ctx = teamContext();
    return cmdTeamPurge(argv.slice(1), join(ctx.bus.home, "archive/team-reset"));
  }
  if (argv[0] === "reset") return cmdTeamReset(argv.slice(1));
  if (argv[0] === "restore") return cmdTeamRestore(argv.slice(1));
  // `shutdown` is the destructive clear and `down` the suspend stop: both are
  // the engine's own grammar, dispatched before the roster parser so the
  // stop's refusal vocabulary stays its own (H1 tap-team.sh L22-135).
  if (argv[0] === "shutdown") return cmdTeamShutdown(argv.slice(1), scriptsDir);
  if (argv[0] === "down") return cmdTeamDown(argv.slice(1), scriptsDir);

  const rosterAlias = argv[0] === "roster";
  const calibrating = argv[0] === "calibration";
  if (calibrating && argv.slice(1).some(arg => arg !== "--strongest")) throw new TapError(1, "usage_error", "tap help team", "usage: tap team calibration [--strongest]", "tap team calibration");
  let options: TeamOptions;
  try {
    options = calibrating ? parseOptions(["--json"]) : parseRosterOptions(argv);
  } catch (error) {
    if (error instanceof TapError && argv.includes("--json")) {
      jsonRefusal(error);
      return error.code;
    }
    if (rosterAlias && error instanceof TapError) {
      process.stderr.write(`tap team roster: ${error.detail}; next: ${humanAction(error.action)}\n`);
      return error.code;
    }
    throw error;
  }

  let ctx: ResolvedContext;
  try {
    ctx = teamContext(options.team);
  } catch (error) {
    if (error instanceof TapError) {
      // A genuinely absent machine index has nothing to pick from — that is
      // "run tap init", not the fuzzy-picker/target_required path unanchored_bus
      // otherwise shares with an ambiguous or unknown team.
      if (!calibrating && ((error.errorClass === "unknown_team" && discoveryTerminalAvailable(options.json))
        || (!options.team && error.errorClass === "unanchored_bus" && !isNoMachineIndex(error)))) {
        if (discoveryTerminalAvailable(options.json)) {
          return chooseTeam(rosterAlias ? "team roster" : "team", options.team, pick).then(result => {
            if (result.kind === "cancelled") { process.stdout.write("tap team: cancelled\n"); return 0; }
            if (result.kind === "interrupted") return 130;
            // Roster is read-only. The choice was checked against the index
            // after Enter; the ordinary exact path still owns rendering.
            const next = rosterAlias ? [...argv] : ["roster", ...argv];
            const at = options.team ? next.indexOf(options.team) : -1;
            if (at >= 0) next[at] = result.value.team;
            else next.splice(1, 0, result.value.team);
            return cmdTeam(next, scriptsDir);
          });
        }
        jsonRefusal(new TapError(1, "target_required", "tap team roster <team>",
          "team target is required in JSON mode; pass tap team roster <team> explicitly"));
        return 1;
      }
      if (options.json) {
        jsonRefusal(error);
        return error.code;
      }
      let detail = error.detail;
      if (error.errorClass === "live_unreachable" && options.team) {
        try {
          const indexHome = process.env.TAP_INDEX_HOME;
          const globalPath = globalRegistryPath(indexHome);
          const r = resolveTeamFromGlobal(globalPath, options.team);
          if (r.root) {
            const cleanRoot = r.root.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
            const cleanTeam = options.team.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
            detail = `acting registry for team '${cleanTeam}' (root '${cleanRoot}') is unreachable`;
          }
        } catch {
          // Keep existing detail if index cannot be read
        }
      }
      const label = rosterAlias ? "tap team roster" : "tap team";
      process.stderr.write(`${label}: ${detail}; next: ${humanAction(error.action)}\n`);
      return error.code;
    }
    throw error;
  }
  if (!options.team) {
    ctx.bus.ensureDirs();
  }
  const crewOnly = process.env.TAP_TEAM_CREW_ONLY === "1";
  const registry = readRegistry(ctx.registryPath, options.json, crewOnly);
  if (!registry.ok) {
    if (calibrating) {
      process.stderr.write(`tap team calibration: acting registry unreadable; repair or restore the acting registry file (tap doctor names it), then retry\n`);
    } else if (registry.rawError) {
      process.stdout.write(registry.rawOutput || "");
      process.stderr.write(registry.error || (registry.rawOutput ? "" : "registry reader failed\n"));
    } else if (options.json) {
      process.stdout.write(`${ensureAscii(JSON.stringify({ team: null, agents: [], error: registry.error || "" }))}\n`);
    } else {
      process.stderr.write(`tap team: registry unreadable (${registry.error || "unknown error"}) — run: tap doctor\n`);
    }
    return 42;
  }

  if (!options.team && !options.json && !options.names && !crewOnly) repoSetupHeadsUp(ctx.root);

  const renderedTeam = options.team ? ctx.team : str(registry.team);
  const archiveHint = !options.json && !options.names && !crewOnly ? archiveNudge(ctx.bus.home) : "";
  const sourceRows = registry.rows ?? [];
  if (options.names && sourceRows.length === 0) return 0;
  if (options.names && !options.active && !options.offline && !options.stalled) {
    for (const row of sourceRows) {
      const handle = str(row.handle);
      if (handle) process.stdout.write(`${handle}\n`);
    }
    return 0;
  }
  if (sourceRows.length === 0) {
    if (calibrating) return calibration(JSON.stringify({ team: ctx.team, agents: [] }), argv.includes("--strongest"));
    if (options.json) process.stdout.write(`${JSON.stringify({ team: options.team ? ctx.team : null, agents: [], ...(options.stalled ? { stalled_after_seconds: options.staleAfter, unjudged: [] } : {}) })}\n`);
    else if (options.stalled) process.stdout.write(`tap team: no stalled seats (idle >= ${options.staleAfter}s with an unanswered ask)\n`);
    else if (crewOnly) process.stdout.write("tap crew list: no crew registered\n");
    else process.stdout.write("tap team: no agents registered yet — start one: tap session launch <preset|harness> [name]\n");
    if(archiveHint)process.stdout.write(archiveHint+"\n");
    return 0;
  }

  let stalledSeatCount = 0;
  const observation = observe(sourceRows, scriptsDir);
  if (observation.code !== 0) {
    if (options.json) jsonRefusal(new TapError(observation.code, "classifier_failed", "tap doctor",
      "seat classifier failed; roster unavailable"));
    return observation.code;
  }
  const facts = options.names ? {} : presetFacts(sourceRows);
  const socket = sourceRows.some(row => str(row.server_socket)) ? tmuxReadOnly(["display-message", "-p", "#{socket_path}"]) : null;
  const callerSocket = socket?.code === 0 && socket.stdout.trim().startsWith("/") ? socket.stdout.trim() : "";
  const hierarchyRows = observedRows(sourceRows, observation.rows, observation.serverEpoch, facts, callerSocket);
  if (!options.names) for (const row of hierarchyRows) {
    if (row.crew && row.status === "active") row.crewLifetime = row.foreignNamespace ? "unknown" : crewLifetimeHealth(row.observedPaneId);
  }
  let rows = hierarchyRows.filter(row => rosterMatches(row, options));
  if (options.refreshModels) {
    const failure = refreshOpenCodeModels(rows, refreshCommandFor(options.team), options.json);
    if (failure) {
      if (options.json) jsonRefusal(failure);
      else process.stderr.write(`tap team: ${failure.detail}; next: ${humanAction(failure.action)}\n`);
      return failure.code;
    }
  }
  // --stalled reads every matched seat's state once, then keeps only the stalled ones.
  let view: StalledView | undefined;
  let statesRead = false;
  if (options.stalled) {
    rows = withTokenSamples(withAgentStates(rows, { team: renderedTeam }), observation.panePids);
    statesRead = true;
    view = stalledView(ctx, rows, renderedTeam, options.staleAfter!);
    const listed = new Set(view.stalled.map(s => s.handle));
    const seatCount = rows.length;
    rows = rows.filter(row => listed.has(row.handle));
    stalledSeatCount = seatCount;
  }
  if (options.names) {
    for (const row of rows) {
      process.stdout.write(`${row.handle}\n`);
    }
  } else if (options.json) {
    const queue = withContextDetails ? contextQueueFacts(ctx.bus.home, globalRegistryPath(), renderedTeam, rows.map(row => row.handle), Number(process.env.TAP_WATCH_NOW || Math.trunc(Date.now() / 1000))) : {};
    const json = rosterJson(renderedTeam, statesRead ? rows : withTokenSamples(withAgentStates(rows, { team: renderedTeam }), observation.panePids), facts, queue, view);
    if (calibrating) return calibration(json, argv.includes("--strongest"));
    process.stdout.write(json);
  } else {
    const all = options.all || crewOnly;
    const sampledRows = all || statesRead ? rows : withTokenSamples(withAgentStates(rows, { team: renderedTeam }), observation.panePids);
    if (!view || rows.length) renderHuman(renderedTeam, sampledRows, all, options.wide, hierarchyRows, refreshCommandFor(options.team));
    if (view) process.stdout.write(stalledFooter(view, stalledSeatCount));
    if (!all) {
      const mismatchedBindings = sampledRows.filter((row) => row.status === "active" && row.delivery === "pane" &&
        !row.foreignNamespace && /^(claude|codex)(?:-|$)/.test(row.harness) &&
        row.tokenSample?.unknown_reason === "session_mismatch").map((row) => row.handle);
      if (mismatchedBindings.length) process.stdout.write(`Warning: transcript session does not match the binding for ${mismatchedBindings.join(", ")}. Run \`tap team doctor\` to diagnose.\n`);
    }
    if(archiveHint)process.stdout.write(archiveHint+"\n");
  }
  return 0;
}
