import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { TapError, callingPane, noMachineIndexError, observeCallerIdentity, requireActingRegistry, resolveContext, reportingContext, resolveSelf, type ResolvedContext } from "../context";
import { renderRefusals } from "../error-line";
import { helpArgv } from "../help";
import { createOpenCodeContextReader } from "../opencode-context";
import { readContextTokens, withClaudeWindow, formatContextTokens, type TokenSample } from "../context-tokens";
import { claudeWindows } from "../context-window";
import { rosterCache, rosterCacheTtl, rosterRegistryStamp } from "../roster-cache";
import { formatPromptCache } from "../prompt-cache";
import { contextQueueFacts, pendingInboundAsks, type AddresseeGate } from "../context-census";
import { addresseeGrant, historyDirForBus } from "../addressee-grant";
import { modelCell } from "../model-names";
import { DEFAULT_STALE_AFTER, judgeStalled, type StalledJudgement } from "../roster-stalled";
import { displayState, emptySeatFilters, hasSeatFilters, idleSeconds, isSeatFilterFlag, seatClock, seatMatches, takeSeatFilters, type SeatFacts, type SeatFilters, type SeatState } from "../seat-filter";
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
import { crewLifetimeHealth, type CrewLifetimeOptions } from "../crew-lifetime";
import { teamStopQueueSummary } from "../team-stop-queue";
import { loadRegistry, seatMap } from "../registry";
import { disarm, readLoose } from "../watch-lease";
import { clearTints } from "../watch-sidecar";
import { armPath } from "../watch-notice";
import type { LifecycleTmux } from "../lifecycle-target";
import { REGISTRY_MAX_BUFFER } from "../spawn";
import { ensureAscii } from "../fsatomic";
import { formatAge } from "../roster-activity";
import { ServerUnresponsive, tmuxReadOnly, physicalSocketPath } from "../tmux";
import { observeNamespace, observeGeneration } from "../launcher/generation";
import { selectRestartCohort } from "../team/up-last";
import { registryState } from "../launcher/resume-prelude";
import { repoSetupHeadsUp } from "../first-run";
import { archiveNudge } from "../bus-archive-index";
import { cmdRefresh } from "./refresh";
import { effectiveWindows, windowsDoc } from "../digest-window";
import { configDirectory, isRegularFile, readSecureBytes } from "../launcher/catalog";
import { rosterDisplayFacts, tryLoadCatalogForDisplay, type Catalog } from "../launcher/catalog-listing";
import { harnessModelFamily } from "../launcher/catalog-metadata";
import { loadModelReference, matchingVariant } from "../launcher/model-reference";
import type { LaunchTuning } from "../launcher/tuning";
import { Notices } from "../launcher/catalog-notices";
import { shlexQuote, InvocationError } from "../launcher/invocation";
import { PyInt } from "../spool-publication";
import { cmdTeamDoctor } from "../team/doctor";
import { cmdTeamAttach } from "../team/attach";
import { cmdTeamReset } from "../team/reset";
import { cmdTeamRestore } from "../team/restore";
import { cmdTeamPurge } from "../team/purge";
import { cmdTeamDetach } from "../team/detach";
import { cmdTeamOut } from "../team/out";
import { cmdTeamHistory } from "../team-history";
import { calibrationView, compare, lastActiveCell, teamsView, writeRoutingResult } from "../routing";
import { recentCount, recentOrder, seatLastActive, takeCount, type LastActive } from "../team/recent";
import { transcriptActivity } from "../team/stale";
import { isOldStoreRefusal } from "../register-authority";
import { lifecycleDisposition, lifecycleReceipt } from "../lifecycle-target";
import { assertBoundParentLifetimes, captureCohortParentLifetimes, chooseSeatCohort, chooseTeam, confirmAction, discoveryTerminalAvailable, parentSeatSnapshot, readDiscoverySeats, requireDiscoveryTerminal, revalidateTeam, type BoundCohort, type BoundTeam, type Picker } from "../team/discovery";
import { pick } from "../fzf";
import { parseSessionDoor } from "../launcher/session-doors";
import { captureCrewProcess, fenceCrewLifetime } from "../crew-lifetime";
import { crewFamilyHandles } from "../crew-ownership";

import { observedRows, withAgentStates, withPermissionRequests, type ObservedRow } from "../roster-observation";
export { observedRows, withAgentStates, readComputeJobs, type AgentStateOptions, type ObservedRow } from "../roster-observation";

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const AGENT_COLOR: Record<SeatState, number> = {
  ready: 96,
  working: 32,
  waiting: 93,
  blocked: 31,
  error: 31,
  idle: 34,
  booting: 36,
  overprint: 35,
  unknown: 33,
  unbound: 33,
  offline: 90,
  incapable: 35,
  unsubmitted: 33,
};
export const TEAM_SUBCOMMANDS = ["doctor", "list", "roster", "calibration", "attach", "detach", "refresh", "shutdown", "down", "out", "up", "reset", "purge", "restore", "history"];
export { AGENT_FAMILIES, DENYLIST } from "../harness-families";


export type { RegistryRow } from "../team-observe";
import { observe, type RegistryRow } from "../team-observe";
import { artifactBun } from "../scripts-dir";
import { ownBun, ownBunFlags } from "../own-bun";
export { observe } from "../team-observe";

interface RegistryRead {
  ok: boolean;
  team?: unknown;
  rows?: RegistryRow[];
  error?: string;
  rawError?: boolean;
  rawOutput?: string;
}

interface TeamOptions {
  json: boolean;
  all: boolean;
  names: boolean;
  online: boolean;
  /** Spelled `--active`: the migration alias of `--online`. */
  activeAlias?: boolean;
  offline: boolean;
  /** `--harness`, `--model` and `--state`: the shared seat filters. */
  filters: SeatFilters;
  includeCrews: boolean;
  team?: string;
  wide: boolean;
  stalled: boolean;
  noState: boolean;
  noCache: boolean;
  /** Retired refresh spelling: prints an advisory and the ordinary read-only roster. */
  refreshModels?: boolean;
  /** Seconds a seat must have been idle (from its dated turn end); set only with --stalled. */
  staleAfter?: number;
  /** `--recent`: order seats by last activity, most recent first. */
  recent: boolean;
  /** `-n <n>` with --recent: keep the first n seats after the sort. */
  count?: number;
}

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
    if (first && !["--json", "--all", "--names", "--online", "--active", "--offline", "--wide", "--stalled", "--stale-after", "--refresh-models", "--no-state", "--no-cache", "--recent", "--context", "--include-crews"].includes(first)) {
      throw new TapError(1, "unknown_option", "tap help team", `unknown option '${first}'`);
    }
    return argv;
  }
  if (!TEAM_SUBCOMMANDS.includes(first)) {
    throw new TapError(
      1,
      "unknown_subcommand",
      "tap help team",
      `unknown subcommand '${first}' (usage: tap team [list|roster|calibration|attach|detach|down|out|up|refresh|history|shutdown|reset|restore|purge] [--json|--all|--wide])`,
    );
  }
  return first === "roster" ? argv.slice(1) : argv;
}

/** One --stale-after value in seconds, refusing anything but a positive safe integer. */
function staleSeconds(value: string): number {
  if (!/^\d+$/.test(value)) throw new TapError(1, "usage_error", "tap help team", `--stale-after must be a positive integer (seconds), got '${value}'`);
  const seconds = Number(value);
  if (seconds <= 0) throw new TapError(1, "usage_error", "tap help team", "--stale-after must be > 0");
  if (!Number.isSafeInteger(seconds)) throw new TapError(1, "usage_error", "tap help team", `--stale-after must not exceed ${Number.MAX_SAFE_INTEGER}, got '${value}'`);
  return seconds;
}

function parseOptions(argv: string[], allowTeamPositional: boolean = false): TeamOptions {
  const out: TeamOptions = { json: false, all: false, names: false, online: false, offline: false, filters: emptySeatFilters(), includeCrews: false, wide: false, stalled: false, noState: false, noCache: false, recent: false };
  let staleAfter: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") out.json = true;
    else if (arg === "--recent") out.recent = true;
    else if (arg === "--include-crews") out.includeCrews = true;
    else if (arg === "--no-state") out.noState = true;
    else if (arg === "--no-cache") out.noCache = true;
    else if (arg === "--stalled") out.stalled = true;
    else if (arg === "--stale-after") {
      staleAfter = argv[++i];
      if (!staleAfter) throw new TapError(1, "usage_error", "tap help team", "--stale-after needs a value (seconds)");
      // Checked as read, so a later --stale-after cannot replace a bad value (such as a flag) unseen.
      staleSeconds(staleAfter);
    }
    else if (arg === "--all") out.all = true;
    else if (arg === "--names") out.names = true;
    else if (arg === "--online") out.online = true;
    else if (arg === "--active") { out.online = true; out.activeAlias = true; }
    else if (arg === "--offline") out.offline = true;
    else if (arg === "--wide") out.wide = true;
    else if (arg === "--refresh-models") out.refreshModels = true;
    // cmdTeam reads --context from argv; accepting it here keeps it in place, so it is never lifted from under a value flag.
    else if (arg === "--context") continue;
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
  if (out.stalled) out.staleAfter = staleAfter === undefined ? DEFAULT_STALE_AFTER : staleSeconds(staleAfter);
  if (out.online && out.offline) {
    throw new TapError(
      1,
      "usage_error",
      "tap help team",
      "--online and --offline are mutually exclusive",
    );
  }
  return out;
}

/**
 * Roster flags besides the seat filters that take the word typed after them, whatever it is. Each
 * extractor keeps them with that word, so lifting one flag never joins an unrelated word to another.
 */
const ROSTER_VALUE_FLAGS = ["-n", "--stale-after"];
/** The bare seat-filter spellings, whose value is the next word. */
const SEAT_FILTER_VALUE_FLAGS = ["--harness", "--model", "--state"];

/** Shared with onboarding so invalid roster forms cannot initialize a repository. */
export function parseRosterOptions(argv: string[]): TeamOptions {
  const { filters, rest } = takeSeatFilters(argv, "tap help team", ROSTER_VALUE_FLAGS);
  const { count, rest: args } = takeCount(rest, "tap help team", ROSTER_VALUE_FLAGS);
  if (args.includes("--no-state") && (filters.state.length || filters.model.length || args.includes("--stalled") || args.includes("--context"))) {
    throw new TapError(1, "usage_error", "tap help team", "--no-state cannot combine with --state, --model, --stalled or --context (they require enrichment)");
  }
  const options: TeamOptions = { ...parseOptions(initialArgs(args), args[0] === "roster"), filters };
  options.count = recentCount(count, options.recent, "tap help team");
  return options;
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
        // Dated evidence for `--recent` (team/recent.ts); absent keys stay absent.
        ...(ent.last_launched ? {last_launched: ent.last_launched} : {}),
        ...(ent.exited_at ? {exited_at: ent.exited_at} : {}),
        boot_id: pythonOr(ent.boot_id, ""), preset: record(ent.preset) ? pythonOr(ent.preset.name, "") : "",
        model: ent.model, launch_tuning: ent.launch_tuning,
        ...(typeof ent.role === "string" ? { role: ent.role } : {}),
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


function rosterCatalog(): Catalog | null {
  try {
    return tryLoadCatalogForDisplay(new Notices(() => {}), process.env,
      readSecureBytes, configDirectory(process.env), isRegularFile);
  } catch (error) {
    const config = error as {errorClass?: string; action?: string; detail?: string; message?: string};
    if (config.errorClass === "advanced_config_invalid") throw new TapError(1, config.errorClass,
      config.action ?? "fix config.toml", config.detail ?? config.message ?? "invalid advanced settings");
    return null;
  }
}

function presetFacts(rows: RegistryRow[], catalog: Catalog | null): Record<string, Record<string, unknown>> {
  const handles = rows.map((row) => str(row.handle)).filter(Boolean);
  const recorded = Object.fromEntries(rows.map(row => [str(row.handle), str(row.preset)]).filter(([, preset]) => preset));
  const facts = rosterDisplayFacts(handles, {recorded, catalog});
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

/** An OpenCode seat whose input is known but whose model has no recorded window: the persisted map lacks it. */
function modelWindowMissing(row: ObservedRow): boolean {
  return row.harness === "opencode" && row.tokenSample?.input_tokens != null && row.tokenSample.window_tokens == null;
}

function contextCell(row: ObservedRow): string {
  const count = row.tokenSample?.input_tokens == null ? "—" : formatContextTokens(row.tokenSample);
  const usage = modelWindowMissing(row) ? `${count}/?` : count;
  return [usage, formatPromptCache(row.tokenSample?.prompt_cache, rosterStyle())].filter(Boolean).join(" ");
}

/** Only a live seat in this namespace has a transcript sample worth reading. */
const sampleable = (row: ObservedRow): boolean => row.status === "active" && !row.foreignNamespace;
const claudeHarness = (row: ObservedRow): boolean => /^claude(?:-|$)/.test(row.harness);

/** Transcript and store reads only: no tmux, no ps. The observed model comes from here. */
function readTokenSamples(rows: ObservedRow[]): ObservedRow[] {
  const readOpenCode = createOpenCodeContextReader();
  return rows.map(row => !sampleable(row) ? row : {...row, tokenSample: row.harness === "opencode"
    ? readOpenCode(row.harnessSessionId ?? "", row.transcriptPath ?? "")
    : readContextTokens(row.harness, row.harnessSessionId ?? "", row.transcriptPath ?? "")});
}

/** After the state pass: batched Claude windows and the session-mismatch rule. */
function attachTokenSamples(rows: ObservedRow[], panePids = new Map<string,string>()): ObservedRow[] {
  const windows = claudeWindows(rows.filter(row => sampleable(row) && claudeHarness(row)).map(row => panePids.get(row.observedPaneId) ?? "").filter(Boolean));
  return rows.map(row => {
    if (!sampleable(row)) return row;
    let tokenSample = row.tokenSample;
    if (claudeHarness(row) && tokenSample) {
      const window = windows.get(panePids.get(row.observedPaneId) ?? "");
      if (window?.state === "set") tokenSample = withClaudeWindow(tokenSample, window.value);
      else if (window?.state === "unset") tokenSample = withClaudeWindow(tokenSample, null);
    }
    // A transcript bound to another session cannot date this seat's turn.
    if (tokenSample?.unknown_reason === "session_mismatch") return {...row, tokenSample, turnEndedAt: null, turnEndedSource: null};
    return {...row, tokenSample};
  });
}

interface EnrichPlan {
  team: string;
  panePids?: Map<string,string>;
  panes?: Map<string, CrewLifetimeOptions & { title?: string }>;
  /** Capture each kept seat's state: pane captures plus the Claude window probe. */
  states: boolean;
  /** Probe each kept live crew's lifetime. */
  lifetimes: boolean;
  filters: SeatFilters;
}

/**
 * The roster's one enrichment owner: every output shape (--names, --json, human,
 * --stalled, calibration) gets its rows here. --harness and --model are judged
 * before any pane capture, so a seat they exclude costs no tmux or ps probe;
 * --state needs the observed state, so it runs after the capture of the seats kept.
 */
function enrichRoster(rows: ObservedRow[], plan: EnrichPlan): ObservedRow[] {
  const now = seatClock();
  const identity = { ...plan.filters, state: [] };
  const keep = (filters: SeatFilters) => (row: ObservedRow) => seatMatches(filters, seatFacts(row, now));
  if (plan.filters.harness.length) rows = rows.filter(keep({ ...identity, model: [] }));
  if (plan.states || plan.filters.model.length) rows = readTokenSamples(rows);
  if (plan.filters.model.length) rows = rows.filter(keep(identity));
  if (plan.states) {
    const paneTitles = new Map([...plan.panes ?? []].flatMap(([id, pane]) => pane.title === undefined ? [] : [[id, pane.title] as const]));
    rows = attachTokenSamples(withAgentStates(rows, { team: plan.team, paneTitles }), plan.panePids);
  }
  if (plan.filters.state.length) rows = rows.filter(keep(plan.filters));
  if (plan.lifetimes) for (const row of rows) {
    if (row.crew && row.status === "active") row.crewLifetime = row.foreignNamespace ? "unknown" : crewLifetimeHealth(row.observedPaneId, plan.panes?.get(row.observedPaneId));
  }
  return rows;
}

function width(value: string): number { return Array.from(value.replace(ANSI, "")).length; }

function truncate(value: string, size: number): string {
  if (width(value) <= size) return value;
  // Clipping plain text cannot split an escape sequence or leak styling into the next row.
  const chars = Array.from(value.replace(ANSI, ""));
  if (size <= 3) return chars.slice(0, size).join("");
  return `${chars.slice(0, size - 3).join("")}...`;
}

export function columnWidths(headers: string[], records: string[][]): number[] {
  const rows = [headers, ...records];
  return headers.map((_, i) => Math.max(...rows.map((row) => width(row[i] ?? ""))));
}

/**
 * Which columns survive at `terminal` width: dropped right-to-left until the
 * row fits, never the `keep` columns (`handle` (0) and `state` (2); `--recent`
 * adds `last active`), so a narrow terminal loses whole columns instead of
 * wrapping. `null` keeps every column.
 */
export function fitColumns(widths: number[], terminal: number | null, keep: readonly number[] = [0, 2]): number[] {
  const kept = widths.map((_, i) => i);
  if (terminal === null) return kept;
  for (let i = widths.length - 1; i >= 0; i--) {
    if (keep.includes(i)) continue;
    const used = kept.reduce((sum, j) => sum + widths[j]!, 0) + 2 * (kept.length - 1);
    if (used <= terminal) break;
    kept.splice(kept.indexOf(i), 1);
  }
  return kept;
}

/** Roster width source: a TTY-only question, so pipes and redirections never
 * drop columns. `--wide` opts out. COLUMNS wins on a TTY, matching the
 * precedence `table()` has always used. */
export function rosterWidth(wide: boolean): number | null {
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
  if (!options.online && !options.offline) return true;
  if (isDaemon(row)) return false;
  return options.online ? row.status === "active"
    : ["offline", "gone", "suspended", "expired"].includes(row.status);
}

/** Leaders first (stable), then the other seats, daemons last: the order every human roster view shows. */
export function leadersFirst<T extends { role?: string; delivery?: unknown; harness?: unknown }>(rows: T[]): T[] {
  const live = rows.filter(row => !isDaemon(row));
  return [...live.filter(row => row.role === "leader"), ...live.filter(row => row.role !== "leader"), ...rows.filter(isDaemon)];
}

/** The handle with its role, e.g. `opus (leader)`; a leader is also bold on a styled terminal. */
export function handleCell(row: { handle: string; role?: string }): string {
  const label = row.role ? `${row.handle} (${row.role})` : row.handle;
  return row.role === "leader" && rosterStyle() ? `\x1b[1m${label}\x1b[0m` : label;
}

export function rosterStyle(): boolean {
  return !!process.stdout.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
}

function humanHarness(row: ObservedRow): string {
  return isDaemon(row) ? (rosterStyle() ? "\x1b[3mdaemon\x1b[0m" : "daemon") : row.harness;
}

/** Observed model@effort from the bound-transcript sample; the (launch)
 * marker keeps the fallback honest when no observation exists. */
function rowModelCell(row: ObservedRow): string {
  const tuning = row.tokenSample?.tuning;
  return modelCell({ observedModel: tuning?.model, observedEffort: tuning?.effort, launchModel: row.model, launchEffort: row.effort }, rosterStyle());
}

function rowState(row: ObservedRow): SeatState {
  return displayState({ ...row, daemon: isDaemon(row) });
}

/** What the shared seat filters read off a roster row; the row must have had its state pass. */
function seatFacts(row: ObservedRow, now: number): SeatFacts {
  const state = rowState(row);
  return { harness: row.harness, daemon: isDaemon(row), models: [row.tokenSample?.tuning?.model, row.model], state, idleSeconds: idleSeconds(state, row.turnEndedAt, now) };
}

/** A seat stopped on a prompt says which kind, whatever the screen classifier made of it. */
function permissionNote(row: ObservedRow): string {
  const request = row.permissionRequest;
  if (!request) return "";
  return request.waitingFor === "input needed" ? " · asks a question" : ` · needs approval (${request.tool})`;
}

function humanAgent(row: ObservedRow, team: string): string {
  const state = rowState(row);
  // The exhausted healing alarm is the roster-visible half of the stuck-paint
  // alarm (tap-cl1es): the leader reads the cause and the manual cure here.
  // Working counts from turn start; idle and waiting from turn end (tap-i5fzq).
  const dated = row.agentState === "working" ? row.turnStartedAt : row.turnEndedAt;
  const age = row.status === "active" && dated != null && state === row.agentState
    ? ` ${formatAge(seatClock() - dated)}` : "";
  const label = row.agentStateReason === "heal_exhausted" && (row.agentState === "overprint" || row.agentState === "booting")
    ? `${row.agentState} · heal exhausted (tap nudge)`
    : `${state}${age}${permissionNote(row)}`;
  return statusIndicator(state, label);
}

/** Shared roster/ps status semantics; keep the label useful without terminal color. */
export function statusIndicator(state: string, label = state): string {
  const color = Object.hasOwn(AGENT_COLOR, state) ? AGENT_COLOR[state as SeatState] : AGENT_COLOR.unknown;
  const dot = rosterStyle() ? `\x1b[${color}m●\x1b[0m` : "●";
  return `${dot} ${label}`;
}

function isoSeconds(epoch: number | null | undefined): string | null {
  return epoch == null ? null : new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

interface StalledView extends StalledJudgement { afterSeconds: number }

function rosterJson(team: string, rows: ObservedRow[], facts: Record<string, Record<string, unknown>>, queue: Record<string, unknown> = {}, stalled?: StalledView, observedAt?: number, recency?: Map<string, LastActive | null>): string {
  const stalledFor = new Map((stalled?.stalled ?? []).map(s => [s.handle, s.stalledForSeconds]));
  const agents = rows.map((row) => {
    const sampled = row.tokenSample?.input_tokens == null ? null : row.tokenSample;
    // The tuning object stays out of context_tokens; observed model/effort
    // surface as their own top-level keys beside the launch provenance.
    // Tuning is independent of the usage verdict: it survives compaction and
    // outlives invalid usage, so it reads off the sample even when
    // context_tokens is null.
    const contextTokens = sampled ? (({ tuning, prompt_cache, ...rest }) => rest)(sampled) : null;
    const tuning = row.tokenSample?.tuning ?? null;
    const active = recency?.get(row.handle) ?? null;
    const item: Record<string, unknown> = {
      handle: row.handle,
      harness: row.harness,
      delivery: row.delivery,
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
      // Claude only: what the seat's open approval or question is for, from its PermissionRequest hook.
      permission_request: row.permissionRequest
        ? { tool: row.permissionRequest.tool, summary: row.permissionRequest.summary, since: isoSeconds(row.permissionRequest.since), waiting_for: row.permissionRequest.waitingFor }
        : null,
      turn_started_at: isoSeconds(row.turnStartedAt),
      turn_ended_at: isoSeconds(row.turnEndedAt),
      turn_ended_source: row.turnEndedSource ?? null,
      // Only with --recent: the shared recency rule's answer and its witness (team/recent.ts).
      ...(recency ? { last_active_at: active ? isoSeconds(active.at) : null, last_active_source: active?.source ?? null } : {}),
      context_tokens: contextTokens,
      prompt_cache: row.tokenSample?.prompt_cache ?? null,
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
    // Always present: the seat's `tap role` label, or null.
    item.role = row.role || null;
    item.family_source = row.familySource ?? null;
    return item;
  });
  const doc = { team: team || null, agents, observed_at: observedAt === undefined ? null : new Date(observedAt).toISOString(), ...(stalled ? { stalled_after_seconds: stalled.afterSeconds, unjudged: stalled.unjudged } : {}) };
  return `${ensureAscii(JSON.stringify(doc))}\n`;
}

const UNJUDGED_TEXT = { no_turn_end_date: "no dated turn end", inbound_unknown: "inbound unreadable" } as const;

/** The roster's idle seats joined to what each still owes; see roster-stalled.ts for the claim rules. */
function stalledView(ctx: ResolvedContext, sampled: ObservedRow[], team: string, afterSeconds: number): StalledView {
  const now = seatClock();
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
  const last = options.includes("--last") || options.includes("-");
  const confirmed = options.includes("--yes");
  const isVerbFlag = (arg: string) => arg === "--attach" || arg === "--tabs" || arg === "--last" || arg === "-";
  const filtered = [...options.filter(arg => !isVerbFlag(arg)), ...(separator < 0 ? [] : args.slice(separator))];
  const launcherArgs = [...options.filter(arg => !isVerbFlag(arg) && arg !== "--yes"), ...(separator < 0 ? [] : args.slice(separator))];
  const operand = scanTeamOperand(args);
  const scanned = scanOptionalSelection("team up", operand.rest);
  if (operand.extra) throw new TapError(1, "usage_error", "tap help team up",
    operand.target ? `unexpected extra argument after team '${operand.target}'` : "unexpected extra team argument", "tap team up");
  // Validate launcher flags before presenting any picker. The door's effective
  // modes (abbreviations such as --j, and TAP_JSON=1) decide --attach, never
  // a raw spelling.
  let modes: ReturnType<typeof parseSessionDoor>;
  try { modes = parseSessionDoor("resume", ["--all", ...scanOptionalSelection("team up", scanTeamOperand(launcherArgs).rest).rest]); }
  catch (error) { throw new TapError(1, "usage_error", "tap help team up", String((error as Error).message), "tap team up"); }
  if (modes.json) process.env.TAP_JSON = "1";
  // The renderer reads only the TAP_JSON gate: an abbreviated --j must still
  // get each attach-flag refusal as the one JSON object.
  const refuse = (detail: string): never => {
    if (modes.json) process.env.TAP_JSON = "1";
    throw new TapError(1, "usage_error", "tap help team up", detail, "tap team up");
  };
  if (last && (modes.key || modes.legacyName)) refuse("unexpected operand after --; tap team up --last accepts no seat operands");
  if (last && (scanned.pending || scanned.selection.mode)) refuse("--last cannot be combined with --only or --except");
  if (options.filter(arg => arg === "--last" || arg === "-").length > 1) refuse("--last was given more than once");
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
  if (last) {
    // Named-team authority applies even when selection returns an empty cohort.
    applyTeamOperand("up", filtered);
    return restartUp(launcherArgs, scriptsDir, operand.target, exact, modes.dryRun, modes.json, confirmed, attachOptions);
  }
  if (scanned.pending || needsTeam) return interactiveUp(filtered, scriptsDir, operand.target, exact, scanned.pending, scanned.selection, attachOptions);
  return teamUpExact(filtered, scriptsDir, undefined, attachOptions);
}

async function restartUp(args: string[], scriptsDir: string, typedTeam: string | undefined, exact: ResolvedContext | undefined,
  dryRun: boolean, json: boolean, confirmed: boolean, attach?: { tabs: boolean }): Promise<number> {
  let team: BoundTeam;
  if (exact) team = { team: exact.team, root: exact.root, registryPath: exact.registryPath, context: exact };
  else {
    const picked = await chooseTeam("team up", typedTeam, pick, json);
    if (picked.kind === "cancelled") { process.stdout.write("tap team up: cancelled\n"); return 0; }
    if (picked.kind === "interrupted") return 130;
    team = picked.value;
  }
  // Pin before the launcher can bootstrap a server: preview and action share this cohort.
  const rows = registryState(team.root).entries;
  let namespace: Awaited<ReturnType<typeof observeNamespace>>;
  try { namespace = await observeNamespace(true); }
  catch (error) {
    if (!(error instanceof InvocationError)) throw error;
    throw new TapError(1, "observation_unobservable", "inspect tmux and retry tap team up --last", error.message, "tap team up");
  }
  const observed = await observeGeneration(undefined, true);
  const observation = namespace.serverAbsent ? { ...observed, epoch: null, socket: "" } : observed;
  const cohort = selectRestartCohort(rows, namespace.names, observation, physicalSocketPath(), team.team, namespace.serverAbsent);
  if (!json) {
    if (cohort.skipped.length) process.stdout.write(`tap team up: skipped unknown generations: ${cohort.skipped.join(", ")}\n`);
    if (cohort.crews) process.stdout.write(`tap team up: crews not resumed: ${cohort.crews}\n`);
  }
  if (!cohort.rows.size) {
    process.stdout.write(json ? JSON.stringify({ ok: true, sessions: [], count: 0, outcome: "no_restart_cohort" }) + "\n"
      : "tap team up: no restart cohort; select seats explicitly with --only <handles>\n");
    return 0;
  }
  if (!dryRun && !confirmed && !discoveryTerminalAvailable(json)) {
    throw new TapError(1, "confirmation_required", "preview with tap team up --last --dry-run; confirm with --yes",
      "--yes is required to resume a restart cohort without an interactive terminal", "tap team up");
  }
  const seats: BoundCohort["seats"] = new Map();
  for (const [handle, row] of cohort.rows) {
    if (typeof row.instance !== "string" || !row.instance) throw new TapError(1, "target_unbound", "tap team doctor",
      `seat '${handle}' has no instance; restart approval cannot bind it`, "tap team up");
    seats.set(handle, { handle, instance: row.instance, session: String(row.session), paneId: String(row.pane_id ?? ""),
      serverEpoch: String(row.server_epoch), status: String(row.status ?? "active"), delivery: String(row.delivery ?? "pane") });
  }
  const selection = { mode: "--only" as const, only: [...seats.keys()], except: [] };
  const bound: BoundCohort = { team, seats, selection, original: selection, restartRows: cohort.rows };
  if (!json) {
    process.stdout.write(`tap team up: restart cohort ${cohort.generation}:\n`);
    for (const [handle, row] of cohort.rows) process.stdout.write(`  ${handle} (registered ${row.registered_at ?? "unknown"})\n`);
  }
  const rest = scanTeamOperand(args).rest;
  const actual = [team.team, ...rest, "--only", [...seats.keys()].join(",")];
  revalidateTeam(team);
  if (dryRun) return await teamUpExact(actual, scriptsDir, bound, attach);
  if (!confirmed) {
    // Explicit consent skips this pass in every output mode; JSON reports only actual outcomes.
    const preview = await teamUpExact([...actual, "--dry-run"], scriptsDir, bound, attach);
    if (preview !== 0) return preview;
    if (!(await confirmAction())) { process.stdout.write("tap team up: cancelled\n"); return 0; }
  }
  revalidateTeam(team);
  return await teamUpExact(actual, scriptsDir, bound, attach);
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

function crewParentsBySession(rows: ObservedRow[]): Map<string, ObservedRow[]> {
  const parents = new Map<string, ObservedRow[]>();
  for (const row of rows) {
    if (row.crew) continue;
    const { session } = parseSessionAndWindow(row);
    if (!session) continue;
    const list = parents.get(session) ?? [];
    list.push(row);
    parents.set(session, list);
  }
  return parents;
}

function buildHumanRosterRows(rows: ObservedRow[], hierarchyRows = rows): DisplayItem[] {
  const visibleHandles = new Set(rows.map(row => row.handle));
  const sessionParents = crewParentsBySession(hierarchyRows);

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

/** `recency` (--recent) keeps the given order, flat: no leaders-first and no crew nesting, plus a last-active column. */
function renderHuman(team: string, rows: ObservedRow[], all: boolean, wide: boolean, hierarchyRows = rows, recency?: Map<string, LastActive | null>, parentContext = false): void {
  if (!recency) rows = leadersFirst(rows);
  const contextParents = new Set<string>();
  if (parentContext) {
    const visible = new Set(rows.map(row => row.handle));
    const parents = crewParentsBySession(hierarchyRows);
    rows = rows.flatMap(row => {
      if (!row.crew) return [row];
      const candidates = parents.get(parseSessionAndWindow(row).session) ?? [];
      if (candidates.some(parent => visible.has(parent.handle))) return [row];
      const parent = candidates[0];
      if (!parent) return [row];
      visible.add(parent.handle);
      contextParents.add(parent.handle);
      return [parent, row];
    });
  }
  const record = (row: ObservedRow, cells: string[]): string[] => {
    if (!contextParents.has(row.handle)) return cells;
    cells[0] += " (crew parent)";
    // Context parents were not enriched: label their purpose rather than imply sampled state.
    cells[all ? 4 : 2] = "context only";
    return cells.map(cell => {
      const plain = cell.replace(ANSI, "");
      return rosterStyle() ? `\x1b[2m${plain}\x1b[0m` : plain;
    });
  };
  const now = seatClock();
  const recent = (row: ObservedRow): string[] => recency ? [lastActiveCell(recency.get(row.handle) ?? null, now, formatAge)] : [];
  const recentHeader = recency ? ["last active"] : [];
  process.stdout.write(`tap ${process.env.TAP_TEAM_LIST_VERB || "team"}: ${team || "(unnamed)"}\n`);
  if (all) {
    // The nine-column schema keeps its TTY truncation; only a redirected run
    // gains the no-truncation guarantee, so `tap team --all | head` is whole.
    process.stdout.write(table(
      ["handle", "kind", "harness", "pane", "status", ...recentHeader, "attached", "unattended", "reason", "notes/asks"],
      rows.map((row) => record(row, [
        handleCell(row), row.crew ? "CREW" : "SEAT", humanHarness(row), row.pane, row.status, ...recent(row),
        row.attached && row.attached !== "0" ? "yes" : "no", row.unattended ? "yes" : "no", row.foreignNamespace ? `bound under ${socketLabel(row.serverSocket!)}` : row.crewLifetime === "legacy_supervised" ? "legacy parent lifetime; tap team refresh" : row.statusReason, `${row.digestWindow ?? 10}s/${row.askWindow ?? 10}s`,
      ])),
      process.stdout.isTTY ? undefined : null,
    ));
  } else {
    // The hierarchy pass runs in both layouts: its stderr warnings (ambiguous session parents, rootless
    // crews) describe the registry, not the layout. The flat --recent view then keeps the recency order.
    const nested = buildHumanRosterRows(rows, hierarchyRows);
    const displayItems = recency ? rows.map(row => ({ row, prefix: "" })) : nested;
    // Keep context beside state; narrow terminals drop preset, model and family first.
    const headers = ["handle", "harness", "state", ...recentHeader, "context", "family", "model", "preset"];
    const records = displayItems.map(({ row, prefix }) => record(row, [
      prefix + handleCell(row), humanHarness(row), humanAgent(row, team) + (row.foreignNamespace ? ` (bound under ${socketLabel(row.serverSocket!)})` : ""),
      ...recent(row),
      contextCell(row),
      row.family || "-",
      rowModelCell(row),
      row.preset || "n/a",
    ]));
    const terminal = rosterWidth(wide);
    const kept = fitColumns(columnWidths(headers, records), terminal, recency ? [0, 2, 3] : undefined);
    process.stdout.write(table(kept.map(i => headers[i]!), records.map(record => kept.map(i => record[i]!)), null));
    const hidden = headers.filter((_, i) => !kept.includes(i));
    if (hidden.length) {
      const verb = process.env.TAP_TEAM_LIST_VERB || "team";
      process.stderr.write(`tap ${verb}: hid ${hidden.join(", ")} to fit ${terminal} columns; tap ${verb} --wide shows every column\n`);
    }
  }
  const unknownWindow = rows.filter(modelWindowMissing).map(row => row.handle);
  if (unknownWindow.length) process.stderr.write(`Warning: model window unavailable for ${unknownWindow.join(", ")}. Running OpenCode 2 seats publish it automatically.\n`);
  const legacy = rows.filter(row => row.crew && row.crewLifetime === "legacy_supervised").map(row => row.handle);
  if (legacy.length) process.stdout.write(`Legacy parent-bound crews: ${legacy.join(", ")}; tap team refresh transitions them to independent lifetime.\n`);
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
  await prepareApprovedCrews(bound);
  return invokeResolvedStop(verb, ctx, actual, team.team, bound);
}

async function prepareApprovedCrews(bound: BoundCohort): Promise<void> {
  const rows = readDiscoverySeats(bound.team.registryPath);
  const children = [...new Set([...bound.seats.keys()].flatMap(owner => crewFamilyHandles(rows, owner)))];
  // Check all selected identities before any legacy transition or process effect.
  for (const handle of children) {
    const row = rows[handle]!, original = bound.crewAtSelection?.get(handle);
    if (!original || row.instance !== original.instance || row.session !== original.session
      || (original.paneId !== undefined && row.pane_id !== original.paneId)
      || (original.serverEpoch !== undefined && row.server_epoch !== original.serverEpoch)
      || (original.owner !== undefined && String(row.crew_owner ?? "") !== original.owner)
      || (original.ownerInstance !== undefined && String(row.crew_owner_instance ?? "") !== original.ownerInstance)) {
      throw new TapError(1, "target_changed", `retry tap team ${bound.team.team}`,
        `crew '${handle}' appeared or changed after selection`, "tap team");
    }
  }
  bound.approvedCrewAtConsent = new Map();
  bound.approvedCrewProcesses = new Map();
  for (const handle of children) {
    const row = rows[handle]!;
    fenceCrewLifetime(bound.team.context, handle, row);
    bound.approvedCrewProcesses.set(handle, captureCrewProcess(bound.team.team, handle, row));
    bound.approvedCrewAtConsent.set(handle, { instance: String(row.instance), session: String(row.session) });
    assertBoundParentLifetimes(bound);
  }
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
  const identityObservation = observeCallerIdentity(process.env);
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

/** Only a warm advisory read may skip onboarding and live context resolution. */
export async function tryCachedRoster(argv: string[], scriptsDir: string): Promise<number | null> {
  const crew = argv[0] === "crew" && argv[1] === "list";
  if (!crew && (argv[0] !== "team" || argv[1] && !argv[1]!.startsWith("-") && argv[1] !== "roster")) return null;
  const args = argv.slice(crew ? 2 : 1);
  let options: TeamOptions;
  try {
    if (crew && takeSeatFilters(args, "tap help crew").rest.some(arg => !["--no-state", "--no-cache"].includes(arg))) return null;
    options = parseRosterOptions(args);
  } catch { return null; }
  if (options.team || options.noCache || process.env.TAP_VERBOSE === "1" || rosterCacheTtl() === 0) return null;
  const ctx = reportingContext(process.cwd(), process.env, options.team);
  if (!ctx) return null;
  const oldCrew = process.env.TAP_TEAM_CREW_ONLY, oldVerb = process.env.TAP_TEAM_LIST_VERB;
  try {
    if (crew) { process.env.TAP_TEAM_CREW_ONLY = "1"; process.env.TAP_TEAM_LIST_VERB = "crew list"; }
    return await cmdTeam(args, scriptsDir, ctx);
  } finally {
    if (oldCrew === undefined) delete process.env.TAP_TEAM_CREW_ONLY; else process.env.TAP_TEAM_CREW_ONLY = oldCrew;
    if (oldVerb === undefined) delete process.env.TAP_TEAM_LIST_VERB; else process.env.TAP_TEAM_LIST_VERB = oldVerb;
  }
}

export function cmdTeam(argv: string[], scriptsDir: string): number | Promise<number>;
export function cmdTeam(argv: string[], scriptsDir: string, cacheContext: ResolvedContext): number | Promise<number> | null;
export function cmdTeam(argv: string[], scriptsDir: string, cacheContext?: ResolvedContext): number | Promise<number> | null {
  if (argv.length <= 2 && ["help", "-h", "--help"].includes(argv.at(-1) ?? "")) {
    const result = helpArgv(["team", ...argv]);
    process.stdout.write(result.stdout); process.stderr.write(result.stderr); return result.exit;
  }
  // The machine alias must see the original argv, before roster-only flags are consumed.
  if (argv[0] === "list" && argv[1]?.startsWith("-") && (argv.includes("--seats") || argv.some(isSeatFilterFlag))) {
    return teamsView(argv.slice(1),scriptsDir).then(writeRoutingResult);
  }
  const withContextDetails = argv.includes("--context");
  // A --context typed as a value flag's value stays, so the roster parser refuses that flag's missing value.
  argv = argv.filter((arg, i, typed) => arg !== "--context" || [...ROSTER_VALUE_FLAGS, ...SEAT_FILTER_VALUE_FLAGS].includes(typed[i - 1] ?? ""));
  // Machine-wide discovery must work before resolving the caller's cwd bus.
  if (argv[0] === "list") {
    const args = argv.slice(1);
    const name = args[0];
    // `tap teams roster` beats a team literally named roster; `tap team roster roster` reaches one.
    if (name === "roster") return teamsView(["--seats", ...args.slice(1)],scriptsDir).then(writeRoutingResult);
    if (name && !name.startsWith("-")) return cmdTeam(["roster", ...args], scriptsDir);
    if (args.includes("--seats")) return teamsView(args,scriptsDir).then(writeRoutingResult);
    // Bare list enumerates enrolled teams, not a roster: there are no seats to judge.
    const stalledFlag = args.find(arg => arg === "--stalled" || arg === "--stale-after");
    if (stalledFlag) {
      const refusal = new TapError(1, "unknown_option", "tap help team", `unknown option '${stalledFlag}'`);
      if (!args.includes("--json")) throw refusal;
      jsonRefusal(refusal);
      return refusal.code;
    }
    const result = spawnSync(ownBun(), [...ownBunFlags(), resolve(scriptsDir, "../../../runtime/bun/src/routing.ts"), "teams", ...args], {
      encoding: "utf8", env: process.env, maxBuffer: REGISTRY_MAX_BUFFER,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    const rc = result.status ?? 1;
    if (rc === 0 && !args.includes("--seats") && !args.includes("--json")) process.stdout.write("to see seats on this team: tap team (or tap team roster)\n");
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
  if (argv[0] === "history") return cmdTeamHistory(argv.slice(1));
  if (argv[0] === "up") return teamUp(argv.slice(1), scriptsDir);
  if (argv[0] === "purge") return cmdTeamPurge(argv.slice(1));
  if (argv[0] === "reset") return cmdTeamReset(argv.slice(1));
  if (argv[0] === "restore") return cmdTeamRestore(argv.slice(1));
  // `shutdown` is the destructive clear and `down` the suspend stop: both are
  // the engine's own grammar, dispatched before the roster parser so the
  // stop's refusal vocabulary stays its own (H1 tap-team.sh L22-135).
  if (argv[0] === "shutdown") return cmdTeamShutdown(argv.slice(1), scriptsDir);
  if (argv[0] === "down") return cmdTeamDown(argv.slice(1), scriptsDir);

  const rosterAlias = argv[0] === "roster";
  const calibrating = argv[0] === "calibration";
  const calibrationArgs = calibrating ? takeSeatFilters(argv.slice(1), "tap help team calibration") : null;
  if (calibrationArgs?.rest.some(arg => arg !== "--strongest")) throw new TapError(1, "usage_error", "tap help team", "usage: tap team calibration [--strongest] [--harness <list>] [--model <list>] [--state <list>]", "tap team calibration");
  let options: TeamOptions;
  try {
    options = calibrationArgs ? { ...parseOptions(["--json"]), filters: calibrationArgs.filters } : parseRosterOptions([...argv, ...(withContextDetails ? ["--context"] : [])]);
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
  if (options.activeAlias && !cacheContext) process.stderr.write("tap team: --active is now --online; it still works during migration\n");

  let ctx: ResolvedContext;
  try {
    ctx = cacheContext ?? teamContext(options.team);
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
  if (!options.team && !cacheContext) {
    ctx.bus.ensureDirs();
  }
  const crewOnly = process.env.TAP_TEAM_CREW_ONLY === "1";
  // Stamp before reading: a concurrent registry replacement invalidates the next read.
  const registryStamp = rosterRegistryStamp(ctx.registryPath);
  const registry = readRegistry(ctx.registryPath, options.json, crewOnly);
  if (!registry.ok) {
    if (cacheContext) return null;
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
    return 1;
  }

  if (!cacheContext && !options.team && !options.json && !options.names && !crewOnly) repoSetupHeadsUp(ctx.root);

  const renderedTeam = options.team ? ctx.team : str(registry.team);
  let archiveHint = !cacheContext && !options.json && !options.names && !crewOnly ? archiveNudge(ctx.bus.home) : "";
  const sourceRows = registry.rows ?? [];
  // Bare --names prints stored handles without observing; --recent needs the observation to order them.
  const plainNames = options.names && !options.online && !options.offline && !options.stalled && !options.recent;
  if (cacheContext && (sourceRows.length === 0 || plainNames && !hasSeatFilters(options.filters))) return null;
  if (options.names && sourceRows.length === 0) return 0;
  const filtering = hasSeatFilters(options.filters);
  const includeCrews = crewOnly || options.includeCrews || !(filtering || options.online || options.offline || options.stalled);
  if (plainNames && !filtering) {
    for (const row of sourceRows) {
      const handle = str(row.handle);
      if (handle) process.stdout.write(`${handle}\n`);
    }
    return 0;
  }
  if (sourceRows.length === 0) {
    if (calibrating) return calibration(JSON.stringify({ team: ctx.team, agents: [] }), argv.includes("--strongest"));
    if (options.json) process.stdout.write(`${JSON.stringify({ team: options.team ? ctx.team : null, agents: [], observed_at: null, ...(options.stalled ? { stalled_after_seconds: options.staleAfter, unjudged: [] } : {}) })}\n`);
    else if (options.stalled) process.stdout.write(`tap team: no stalled seats (idle >= ${options.staleAfter}s with an unanswered ask)\n`);
    else if (crewOnly) process.stdout.write("tap crew list: no crew registered\n");
    else process.stdout.write("tap team: no agents registered yet — start one: tap launch <preset|harness> [name]\n");
    if(archiveHint)process.stdout.write(archiveHint+"\n");
    return 0;
  }

  let stalledSeatCount = 0;
  let catalog: Catalog | null;
  try { catalog = rosterCatalog(); }
  catch (error) {
    if (cacheContext) return null;
    if (options.json && error instanceof TapError) { jsonRefusal(error); return error.code; }
    throw error;
  }
  // Named roster reads may target another team: keep that bus read-only.
  const cacheTtl = options.team || options.noCache || calibrating ? 0 : rosterCacheTtl(process.env, catalog?.advanced?.roster_cache_ttl_seconds);
  const facts = options.names ? {} : presetFacts(sourceRows, catalog);
  const all = options.all || crewOnly;
  // --recent observes state in every shape, --all and --names included: a working seat sorts first.
  const states = !options.noState && (options.stalled || options.recent || options.filters.state.length > 0 || (!options.names && (options.json || !all)));
  const filters = Object.fromEntries(Object.entries(options.filters).map(([key, values]) => [key, [...values].sort()]));
  const cache = registryStamp === null ? null : rosterCache(join(ctx.bus.home, "runtime-cache"), states ? "full" : "nostate", {
    team: ctx.team, socket: physicalSocketPath(), registryStamp, filters, facts,
    mode: {states, crewOnly, includeCrews, names:options.names, online:options.online, offline:options.offline},
    epochPin: process.env.TAP_SERVER_EPOCH,
  }, cacheTtl);
  const cached = cacheContext ? cache?.read() : null;
  if (cacheContext && !cached) return null;
  let hierarchyRows: ObservedRow[], rows: ObservedRow[], observedAt: number;
  if (cached) {
    ({hierarchyRows, rows} = cached.snapshot);
    observedAt = cached.observedAt;
  } else {
    const observation = observe(sourceRows, scriptsDir);
    if (observation.code !== 0) {
      if (options.json) jsonRefusal(new TapError(observation.code, "classifier_failed", "tap doctor",
        "seat classifier failed; roster unavailable"));
      return observation.code;
    }
    const socket = sourceRows.some(row => str(row.server_socket)) ? tmuxReadOnly(["display-message", "-p", "#{socket_path}"]) : null;
    const callerSocket = socket?.code === 0 && socket.stdout.trim().startsWith("/") ? socket.stdout.trim() : "";
    hierarchyRows = observedRows(sourceRows, observation.rows, observation.serverEpoch, facts, callerSocket);
    rows = hierarchyRows.filter(row => (includeCrews || !row.crew) && rosterMatches(row, options));
    // Cold reads narrow harness/model filters before captures. Selectors live
    // in the entry key, so switching selectors replaces one of two fixed files.
    rows = enrichRoster(rows, {team:renderedTeam, panePids:observation.panePids, panes:observation.panes,
      filters:options.filters, lifetimes:!options.names, states});
    observedAt = Date.now();
    cache?.write({rows, hierarchyRows, serverEpoch:observation.serverEpoch, callerSocket}, observedAt);
  }
  // After the cache, on a hit and on a miss alike: an open request's detail is read for
  // each request and is never written into the cached observation.
  if (states) rows = withPermissionRequests(rows, ctx.bus.home, !!options.team);
  if (options.refreshModels && !options.json) {
    process.stderr.write("tap team: --refresh-models is retired; running OpenCode 2 seats publish model windows automatically. Nothing was refreshed.\n");
  }
  if (cacheContext) {
    if (options.activeAlias) process.stderr.write("tap team: --active is now --online; it still works during migration\n");
    if (!options.team && !options.json && !options.names && !crewOnly) repoSetupHeadsUp(ctx.root);
    if (!options.json && !options.names && !crewOnly) archiveHint = archiveNudge(ctx.bus.home);
  }
  let view: StalledView | undefined;
  if (options.stalled) {
    view = stalledView(ctx, rows, renderedTeam, options.staleAfter!);
    const listed = new Set(view.stalled.map(s => s.handle));
    const seatCount = rows.length;
    rows = rows.filter(row => listed.has(row.handle));
    stalledSeatCount = seatCount;
  }
  let recency: Map<string, LastActive | null> | undefined;
  if (options.recent) {
    // The stored row carries the dated evidence; the observation says who is working now.
    const stored = new Map(sourceRows.map(row => [str(row.handle), row as unknown as Record<string, unknown>]));
    const now = seatClock();
    const ordered = recentOrder(rows, row => seatLastActive(stored.get(row.handle) ?? {},
      { working: rowState(row) === "working", turnEndedAt: row.turnEndedAt }, transcriptActivity, now),
    (a, b) => compare(a.handle, b.handle), options.count);
    rows = ordered.map(({ row }) => row);
    recency = new Map(ordered.map(({ row, active }) => [row.handle, active]));
  }
  if (options.names) {
    for (const row of rows) {
      process.stdout.write(`${row.handle}\n`);
    }
  } else if (options.json) {
    const queue = withContextDetails ? contextQueueFacts(ctx.bus.home, globalRegistryPath(), renderedTeam, rows.map(row => row.handle), seatClock()) : {};
    const json = rosterJson(renderedTeam, rows, facts, queue, view, observedAt, recency);
    if (calibrating) return calibration(json, argv.includes("--strongest"));
    process.stdout.write(json);
  } else {
    const sampledRows = rows;
    if (filtering && !rows.length && !view) process.stdout.write(`tap ${process.env.TAP_TEAM_LIST_VERB || "team"}: no seats match these filters\n`);
    else if (!view || rows.length) renderHuman(renderedTeam, sampledRows, all, options.wide, hierarchyRows, recency, includeCrews && !crewOnly);
    if (view) process.stdout.write(stalledFooter(view, stalledSeatCount));
    if (cached) process.stdout.write(`cached observation ${Math.max(0, Math.floor((Date.now() - observedAt) / 1000))}s ago\n`);
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
