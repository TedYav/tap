import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { loadGlobalRegistry } from "../index-home";
import { noMachineIndexError, TapError } from "../context";
import { pyReadUtf8 } from "../spool-publication";
import { teamRegistryRefusal } from "../register-authority";
import { tapErrorLine } from "../error-line";
import { gatheredPayload } from "../observe-gather";
import { agentFamilies, classifyCommCommand, harnessFamily, observeRows, parsePsTable, SHELLS, buildSnapshot, type ObservePayload, type RowInput } from "../observe";
import { physicalSocketPath, serverEpochFromRaw, tmuxReadOnly } from "../tmux";
import { detectAgentState } from "../agent-state";
import { isDaemon, rosterStyle, statusIndicator, table } from "./team";
import { hasSeatFilters, idleSeconds, seatClock, seatMatches, takeSeatFilters, type SeatFilters } from "../seat-filter";
import { harnessEvidence } from "../readiness-stall";
import { readContextTokens } from "../context-tokens";

const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const str = (x: unknown): string => typeof x === "string" ? x : "";
const launchModel = (seat: Record<string, unknown>): string => object(seat.launch_tuning) ? str(seat.launch_tuning.model) : str(seat.model);
export interface ProcessSample { pid: string; pgid: string; tpgid: string; cpu: number; rssKiB: number; elapsed: string; state: string; comm: string; command: string }
export function parseResources(text: string): Map<string, ProcessSample> {
  const result = new Map<string, ProcessSample>();
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(-?\d+)\s+(-?\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pid, pgid, tpgid, cpu, rss, elapsed, state, comm, command] = match;
    if (!Number.isFinite(Number(cpu)) || !Number.isSafeInteger(Number(rss))) continue;
    result.set(pid!, {pid: pid!, pgid: pgid!, tpgid: tpgid!, cpu: Number(cpu), rssKiB: Number(rss), elapsed: elapsed!, state: state!, comm: comm!, command: command!});
  }
  return result;
}

/** footprint uses binary scales even though its formatted labels say KB/MB/GB. */
export function parseFootprints(text: string): Map<number, number> {
  const result = new Map<number, number>();
  for (const line of text.split("\n")) {
    const match = /^.*\[(\d+)\]:.*?\bFootprint:\s*([\d.]+)\s*(B|KB|MB|GB|TB)\b/.exec(line);
    if (!match) continue;
    const scale = {B: 1 / 1024, KB: 1, MB: 1024, GB: 1024 ** 2, TB: 1024 ** 3}[match[3]!]!;
    const kib = Math.round(Number(match[2]) * scale);
    if (Number.isSafeInteger(kib) && kib >= 0) result.set(Number(match[1]), kib);
  }
  return result;
}

export function sampleFootprints(pids: number[], platform = process.platform, run: (command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => {stdout: string | null} = spawnSync): Map<number, number> {
  if (platform !== "darwin" || !pids.length) return new Map();
  // One bounded call; valid per-PID output survives refusal of a sibling PID.
  const r = run("footprint", ["--format", "bytes", "--noCategories", ...pids.flatMap(pid => ["--pid", String(pid)])],
    {encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024, env: {...process.env, LC_ALL: "C"}});
  return parseFootprints(typeof r.stdout === "string" ? r.stdout : "");
}

export function formatMemory(kib: number): string {
  const bytes = kib * 1024;
  return bytes < 1e9 ? `${(bytes / 1e6).toFixed(1)}MB` : `${(bytes / 1e9).toFixed(2)}GB`;
}

/** Match the observer's root/foreground-group rule; background agents cannot own a seat. */
export function harnessProcess(panePid: string, expected: string, samples: Map<string, ProcessSample>): ProcessSample | undefined {
  const root = samples.get(panePid);
  if (!root) return;
  const families = agentFamilies();
  const wanted = harnessFamily(expected, families);
  const name = root.comm.split("/").pop()!.toLowerCase().replace(/^-+/, "");
  if (!(SHELLS as readonly string[]).includes(name)) {
    return classifyCommCommand(root.comm, root.command, families) === wanted ? root : undefined;
  }
  const leader = samples.get(root.tpgid);
  const leaderName = leader?.comm.split("/").pop()!.toLowerCase().replace(/^-+/, "") || "";
  if (leader && !(SHELLS as readonly string[]).includes(leaderName) && leader.pgid === root.tpgid && classifyCommCommand(leader.comm, leader.command, families) === wanted) return leader;
}

interface Claim { team: string; handle: string; harness: string; socket: string; row: RowInput; model: string; sessionId: string; transcript: string }
/** A registry seat's own identity, kept for every object seat so a filter can judge a seat that never became a row. */
type SeatIdentity = Pick<Claim, "harness" | "model" | "sessionId" | "transcript">;
const seatKey = (team: string | undefined, handle: string | undefined): string => JSON.stringify([team ?? "", handle ?? ""]);
interface Diagnostic { team?: string; handle?: string; reason: string }
export interface PsSeat { team: string; handle: string; harness: string; status: string; activity: string; pid: number | null; cpu_percent: number | null; rss_kib: number | null; footprint_kib: number | null; elapsed: string | null; process_state: string | null; reason: string }
export interface PsDeps {
  footprints(pids: number[]): Map<number, number>;
  resources(): {status: number | null; stdout: string};
  gather(rows: RowInput[], env: NodeJS.ProcessEnv, psText: string, psOk: boolean): ObservePayload;
  activity(harness: string, pane: string, env: NodeJS.ProcessEnv, epoch: string): string;
  /** The transcript's observed model and dated turn end; read only for a `--model` or `--state` filter. */
  turn?(harness: string, sessionId: string, transcript: string): {model: string | null; endedAt: number | null};
}
export function observeActivity(harness: string, pane: string, env: NodeJS.ProcessEnv, epoch: string, run = tmuxReadOnly): string {
  const codex = /^codex(?:-|$)/.test(harness);
  const capture = run(["capture-pane", ...(codex ? ["-e"] : []), "-p", "-t", pane], env);
  if (capture.code !== 0) throw new Error("activity capture unavailable");
  const title = codex ? run(["display-message", "-p", "-t", pane, "#{pane_title}"], env) : null;
  if (title && title.code !== 0) throw new Error("activity title unavailable");
  const generation = run(["display-message", "-p", "#{pid}:#{start_time}"], env);
  if (!epoch || generation.code !== 0 || serverEpochFromRaw(generation.stdout.trim(), env) !== epoch) throw new Error("activity server generation changed or unavailable");
  return detectAgentState(harness, capture.stdout, title?.stdout.trimEnd()).agentState;
}

const production: PsDeps = {
  footprints: sampleFootprints,
  resources() {
    const r = spawnSync("ps", ["-axo", "pid=,pgid=,tpgid=,pcpu=,rss=,etime=,stat=,comm=,args="], {encoding: "utf8", timeout: 5000, maxBuffer: 32 * 1024 * 1024, env: {...process.env, LC_ALL: "C"}});
    return {status: r.status, stdout: r.stdout || ""};
  },
  gather(rows, env, psText, psOk) {
    const payload = gatheredPayload(rows, {env, fast: true, processTable: false});
    return {...payload, ps_text: psText, ps_rc: psOk ? 0 : 1};
  },
  activity: observeActivity,
  turn: observeTurn,
};

/** The transcript's observed model and dated turn end, for --model and --state. */
export function observeTurn(harness: string, sessionId: string, transcript: string): {model: string | null; endedAt: number | null} {
  const sample = readContextTokens(harness, sessionId, transcript);
  // The roster's identity rule: a transcript bound to another session cannot date this seat's turn,
  // so the seat is undated, and an undated idle seat stays active.
  const evidence = sample?.unknown_reason === "session_mismatch" ? null
    : harnessEvidence(harness, {transcript_path: transcript, harness_session_id: sessionId}, process.env);
  return {model: sample?.tuning?.model ?? null, endedAt: evidence?.ended && evidence.at !== null ? evidence.at : null};
}

/** ps rows carry the native classifier's activity: no daemons, inactive seats, or the roster's
 * own `waiting` and `unsubmitted` readings. A filter on those could only ever list nothing. */
const PS_STATES: readonly string[] = ["working", "blocked", "error", "idle", "booting", "overprint", "unknown", "active"];

function psFilters(args: string[]): {filters: SeatFilters; rest: string[]} {
  const parsed = takeSeatFilters(args, "tap help admin ps");
  const absent = parsed.filters.state.find(state => !PS_STATES.includes(state));
  if (absent) throw new TapError(1, "usage_error", `tap teams --state ${absent}`, `it lists live seats by harness process, so it never shows state '${absent}' (it shows: ${PS_STATES.join(", ")})`, "tap admin ps");
  if (parsed.filters.harness.includes("daemon")) throw new TapError(1, "usage_error", "tap teams --harness daemon", "daemons have no harness process, so it omits daemons", "tap admin ps");
  return parsed;
}

/** Fixed attention floors avoid highlighting trivial winners on a quiet machine. */
export function resourceCutoff(values: Array<number | null>, floor: number): number {
  const eligible = values.filter((n): n is number => n !== null && Number.isFinite(n) && n >= floor).sort((a, b) => b - a);
  return eligible[Math.min(2, eligible.length - 1)] ?? Infinity;
}

export function cmdAdminPs(args: string[], deps: PsDeps = production): number {
  const json = args.includes("--json");
  process.env.TAP_JSON = json ? "1" : "0";
  const {filters, rest} = psFilters(args);
  const noState = rest.includes("--no-state");
  if (rest.some(arg => !["--json", "--no-state"].includes(arg))) throw new TapError(1, "usage_error", "tap help admin ps", "accepted options: --json --no-state --harness <list> --model <list> --state <list>", "tap admin ps");
  if (noState && (filters.model.length || filters.state.length)) throw new TapError(1, "usage_error", "tap help admin ps", "--no-state cannot combine with --model or --state (they require enrichment)", "tap admin ps");
  const index = loadGlobalRegistry();
  if (index.marker === "absent") throw noMachineIndexError("tap admin ps");
  if (index.marker !== "live" || !object(index.doc) || (index.doc.teams !== undefined && !object(index.doc.teams))) throw new TapError(1, "registry_invalid", "tap doctor", "machine index is unreadable", "tap admin ps");
  const teams = index.doc.teams ?? {};
  const claims: Claim[] = [], diagnostics: Diagnostic[] = [], seats: PsSeat[] = [];
  const identities = new Map<string, SeatIdentity>();
  const roots = new Map<string, string[]>();
  for (const [name, entry] of Object.entries(teams)) {
    if (!object(entry) || !isAbsolute(str(entry.root)) || ![undefined, null, "", "registered"].some(state => state === entry.state)) continue;
    try { const root = realpathSync(str(entry.root)); roots.set(root, [...(roots.get(root) || []), name]); } catch { /* Report in the reader below. */ }
  }
  for (const [team, entry] of Object.entries(teams).sort(([a], [b]) => a.localeCompare(b))) {
    try {
      if (!object(entry)) throw new Error("invalid team index entry");
      if (entry.state === "historical") continue;
      if (![undefined, null, "", "registered"].some(state => state === entry.state)) throw new Error("invalid team enrollment state");
      if (!isAbsolute(str(entry.root)) || !isAbsolute(str(entry.registry_location))) throw new Error("missing absolute team root or acting registry");
      const root = realpathSync(str(entry.root));
      if (!statSync(root).isDirectory()) throw new Error("enrolled team root is not a directory");
      if ((roots.get(root)?.length || 0) > 1) throw new Error("ambiguous team enrollment");
      if (!statSync(str(entry.registry_location)).isFile()) throw new Error("acting registry is not a regular file");
      const doc: unknown = JSON.parse(pyReadUtf8(str(entry.registry_location)));
      if (!object(doc)) throw new Error("invalid acting registry");
      const refusal = teamRegistryRefusal(str(entry.registry_location), doc);
      if (refusal) throw new Error(refusal.detail);
      if (object(doc.team) && doc.team.worktree_root !== undefined && !isAbsolute(str(doc.team.worktree_root))) throw new Error("acting team identity root is not absolute");
      if (object(doc.team) && ((doc.team.name !== undefined && doc.team.name !== team) || (doc.team.worktree_root !== undefined && realpathSync(str(doc.team.worktree_root)) !== root))) throw new Error("acting team identity differs from enrollment");
      if (!object(doc.seats)) throw new Error("invalid seats map");
      for (const [handle, seat] of Object.entries(doc.seats).sort(([a], [b]) => a.localeCompare(b))) {
        if (!object(seat)) { diagnostics.push({team, handle, reason: "invalid seat"}); continue; }
        identities.set(seatKey(team, handle), {harness: str(seat.harness), model: launchModel(seat), sessionId: str(seat.harness_session_id), transcript: str(seat.transcript_path)});
        const fields = ["status", "status_reason", "delivery", "pane", "pane_id", "session", "server_epoch", "boot_id", "harness", "registered_at", "server_socket"];
        if (fields.some(key => seat[key] !== undefined && typeof seat[key] !== "string") || (seat.delivery !== undefined && !["", "pane", "poll"].includes(str(seat.delivery)))) { diagnostics.push({team, handle, reason: "invalid seat identity fields"}); continue; }
        const status = str(seat.status) || "active";
        if (status === "suspended" || status === "offline") continue;
        if (status !== "active" && status !== "pending") { diagnostics.push({team, handle, reason: "invalid seat status"}); continue; }
        const socket = str(seat.server_socket) || physicalSocketPath();
        if (!isAbsolute(socket)) { diagnostics.push({team, handle, reason: "invalid socket path"}); continue; }
        if (isDaemon(seat)) continue;
        claims.push({team, handle, socket, harness: str(seat.harness), model: launchModel(seat), sessionId: str(seat.harness_session_id), transcript: str(seat.transcript_path), row: {key: JSON.stringify([team, handle]), status, status_reason: str(seat.status_reason), delivery: str(seat.delivery), pane: str(seat.pane), pane_id: str(seat.pane_id), session: str(seat.session), registered_at: str(seat.registered_at), row_epoch: str(seat.server_epoch), row_boot: str(seat.boot_id), harness: str(seat.harness)}});
      }
    } catch (error) { diagnostics.push({team, reason: error instanceof Error ? error.message : String(error)}); }
  }
  // --harness and --model are known before any probe, so an excluded seat is never captured.
  const identity = {...filters, state: []};
  const turns = new Map<SeatIdentity, {model: string | null; endedAt: number | null}>();
  const turnOf = (claim: SeatIdentity) => {
    if (!turns.has(claim)) turns.set(claim, (filters.model.length || filters.state.length ? deps.turn?.(claim.harness, claim.sessionId, claim.transcript) : undefined) ?? {model: null, endedAt: null});
    return turns.get(claim)!;
  };
  // Seats a filter positively excluded; only their diagnostics may be dropped.
  const excluded = new Set<string>();
  const identityMatches = (seat: SeatIdentity) => seatMatches(identity, {harness: seat.harness, models: [turnOf(seat).model, seat.model], state: "unknown", idleSeconds: null});
  if (identity.harness.length || identity.model.length) {
    for (const [key, seat] of identities) if (!identityMatches(seat)) excluded.add(key);
    claims.splice(0, claims.length, ...claims.filter(claim => !excluded.has(seatKey(claim.team, claim.handle))));
  }
  const resource = claims.length ? deps.resources() : {status: 0, stdout: ""};
  const samples = parseResources(resource.stdout);
  const psText = [...samples.values()].map(p => `${p.pid} ${p.pgid} ${p.tpgid} ${p.comm} ${p.command}`).join("\n");
  // Validate the exact representation handed to the common lifecycle classifier.
  const psOk = resource.status === 0 && (!claims.length || samples.size > 0) && parsePsTable(psText).size === samples.size;
  for (const socket of new Set(claims.map(c => c.socket))) {
    const group = claims.filter(c => c.socket === socket);
    const env: NodeJS.ProcessEnv = {...process.env, TAP_TMUX_SOCKET_PATH: socket};
    delete env.TAP_SERVER_EPOCH;
    try {
      const payload = deps.gather(group.map(c => c.row), env, psText, psOk);
      const epoch = buildSnapshot(payload, env).sharedEpoch;
      const observed = new Map(observeRows(payload, env).map(line => { const [key, ...rest] = line.split("\x1f"); return [key!, rest] as const; }));
      const panes = new Map((payload.panes_text || "").split("\n").map(line => line.split("\t")).filter(p => p.length === 7 || p.length >= 10).map(p => [p[2]!, p[4]!]));
      for (const claim of group) {
        const fields = observed.get(claim.row.key!) || ["unknown", "observation_missing"];
        if (!["active", "unknown", "pending"].includes(fields[0]!)) continue;
        const row: PsSeat = {team: claim.team, handle: claim.handle, harness: claim.harness, status: fields[0]!, activity: "unknown", pid: null, cpu_percent: null, rss_kib: null, footprint_kib: null, elapsed: null, process_state: null, reason: ""};
        const processSample = fields[0] === "active" && psOk ? harnessProcess(panes.get(fields[3] || "") || "", claim.harness, samples) : undefined;
        if (processSample && !processSample.state.startsWith("Z")) {
          Object.assign(row, {pid: Number(processSample.pid), cpu_percent: processSample.cpu, rss_kib: processSample.rssKiB, elapsed: processSample.elapsed, process_state: processSample.state});
          if (!noState) {
            try { row.activity = deps.activity(claim.harness, fields[3]!, env, epoch); }
            catch (error) { row.reason = error instanceof Error ? error.message : "activity observation unavailable"; }
          }
        } else row.reason = !psOk ? "process snapshot unavailable" : fields[0] !== "active" ? fields[1] || "lifecycle unknown" : "harness process unavailable";
        if (row.reason) diagnostics.push({team: row.team, handle: row.handle, reason: row.reason});
        seats.push(row);
      }
    } catch (error) {
      const reason = `socket observation unavailable: ${String(error)}`;
      diagnostics.push({reason: `socket ${socket}: ${reason}`});
      for (const claim of group) if (!seats.some(s => s.team === claim.team && s.handle === claim.handle)) {
        seats.push({team: claim.team, handle: claim.handle, harness: claim.harness, status: "unknown", activity: "unknown", pid: null, cpu_percent: null, rss_kib: null, footprint_kib: null, elapsed: null, process_state: null, reason});
      }
    }
  }
  const footprints = deps.footprints([...new Set(seats.flatMap(s => s.pid === null ? [] : [s.pid]))]);
  for (const seat of seats) {
    seat.footprint_kib = seat.pid === null ? null : footprints.get(seat.pid) ?? null;
    if (seat.rss_kib !== null && seat.footprint_kib === null) {
      seat.reason = [seat.reason, "RSS fallback (footprint unavailable)"].filter(Boolean).join("; ");
    }
  }
  if (hasSeatFilters(filters)) {
    const now = seatClock(), byId = new Map(claims.map(claim => [JSON.stringify([claim.team, claim.handle]), claim]));
    const kept = seats.filter(seat => {
      const claim = byId.get(JSON.stringify([seat.team, seat.handle]))!;
      const turn = turnOf(identities.get(seatKey(seat.team, seat.handle)) ?? claim);
      return seatMatches(filters, {harness: seat.harness, models: [turn.model, claim.model], state: seat.activity, idleSeconds: idleSeconds(seat.activity, turn.endedAt, now)});
    });
    // Only a classified state that does not match excludes. A seat whose state could not be read is
    // omitted from a --state view it does not match, but its failure stays and fails the run.
    for (const seat of seats) if (!kept.includes(seat) && seat.activity !== "unknown") excluded.add(seatKey(seat.team, seat.handle));
    seats.splice(0, seats.length, ...kept);
  }
  if (excluded.size) {
    // A seat the caller filtered out cannot fail the observation they asked for. Every other
    // failure stays, including one for a selected seat rejected before it had a row.
    diagnostics.splice(0, diagnostics.length, ...diagnostics.filter(d => !d.handle || !excluded.has(seatKey(d.team, d.handle))));
  }
  const memory = (seat: PsSeat) => seat.footprint_kib ?? seat.rss_kib;
  seats.sort((a, b) => a.team.localeCompare(b.team) || a.handle.localeCompare(b.handle));
  if (json) process.stdout.write(`${JSON.stringify({ok: diagnostics.length === 0, ...(diagnostics.length ? {error_class: "observation_incomplete", action: "inspect diagnostics and retry tap admin ps"} : {}), resource_scope: "harness_process", seats, diagnostics})}\n`);
  else {
    const cpuCutoff = resourceCutoff(seats.map(s => s.cpu_percent), 25);
    const memoryCutoff = resourceCutoff(seats.map(memory), 1e9 / 1024);
    const color = rosterStyle();
    const metric = (value: number | null, divisor: number, cutoff: number, format?: (value: number) => string): string => {
      if (value === null) return "—";
      const text = format ? format(value) : (value / divisor).toFixed(1);
      return value >= cutoff ? (color ? `\x1b[1;33m${text}*\x1b[0m` : `${text}*`) : text;
    };
    process.stdout.write(seats.length ? table(["TEAM", "SEAT", "HARNESS", "PID", "CPU%AVG", "MEMORY", "ELAPSED", "PROC", "STATUS", "REASON"], seats.map(s => [s.team, s.handle, s.harness, s.pid?.toString() || "—", metric(s.cpu_percent, 1, cpuCutoff), metric(memory(s), 1, memoryCutoff, formatMemory), s.elapsed || "—", s.process_state || "—", statusIndicator(s.activity === "unknown" ? s.status : s.activity), s.reason])) : hasSeatFilters(filters) ? "tap admin ps: no seats match these filters\n" : "tap admin ps: no active seats observed\n");
    if (cpuCutoff !== Infinity || memoryCutoff !== Infinity) process.stdout.write("* top consumers: CPU >=25% avg or memory >=1 GB; top 3 per column, ties included\n");
    if (diagnostics.length) process.stderr.write(tapErrorLine(new TapError(1, "observation_incomplete",
      "inspect diagnostics and retry tap admin ps", diagnostics.map(d => `${d.team || "machine"}${d.handle ? `/${d.handle}` : ""}: ${d.reason}`).join("; ")), "tap admin ps"));
  }
  return diagnostics.length ? 1 : 0;
}
