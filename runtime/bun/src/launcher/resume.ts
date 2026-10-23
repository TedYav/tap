// `tap session resume <key> [<name>]`: every form except `--all` (resume-all.ts).
// session-doors.ts parses public argv; launch can also delegate here in-process.
// This owner performs selection, refusal, reattach, transaction and terminal exit.
import { spawnSync } from "node:child_process";
import { constants } from "node:os";
import { basename, join } from "node:path";
import { parseJsonPreserving, pyReadUtf8, isDict } from "../spool-publication";
import { fenceTestBarrier } from "../reset";
import { reservationExpired } from "../reservation";
import { startupTrace, withStartupTrace } from "../startup-trace";
import { beginLifecycleOperation, joinLifecycleDiagnostics } from "../lifecycle-diagnostics";
import { legacyBootId } from "../tmux";
import { listHandleHistory } from "../verbs/register";
import { ATTACH_REFUSED_TTY_OWNERSHIP, attachNarration, attachTail, detachedReceipt } from "./attach-policy";
import { HARNESSES } from "./catalog";
import { Notices } from "./catalog-notices";
import { seatIsRelaunchable } from "./complete";
import { currentBootId, observeGeneration, staleSeatGeneration } from "./generation";
import { assertUniqueHarnessSessionIdentity, orderedDoc, seatEntries } from "./identity-owner";
import { shlexQuote } from "./invocation";
import { allocateName, namedSessionName, parseUnicodeDecimal, resumeCandidateNames, sanitizeComponent, sessionNameForHandle } from "./naming";
import { attachableState, classifySession, crewPanesIn, currentEpoch, entrySession, hasSession, registryResumeSelection, type SessionSeat } from "./observation";
import { launchTmux } from "./process";
import { callerHasTty, callerOwnsForegroundTty, callerTty, exitKeepingTerminal, promptChoice } from "./prompt";
import { PANE_FACTS_FORMAT, paneFacts, paneHarness, parsePaneFacts, type PaneFacts } from "./readiness";
import { pathIsUnder, realOrSelf, recordKeySelection, rootForCwd } from "./records";
import { timestamp } from "./repair";
import { freshLaunchSessionId } from "./adapters";
import { idlessFreshWarning, recordHasResumeArtifact, pyRepr } from "./resume-identity";
import { fenceSurvivingCrew, reclaimRevivedCrew, survivingCrews, type SurvivingCrew } from "../crew-lifetime";
import { teamRegistryRefusal } from "../register-authority";
import { LauncherError } from "./types";
import { cloneRecord, compact, entryGuard, err, out, Refusal, refuseIfResetFenced, refuseRetiredFlags, registryAuthority,
  registryState, render, SCRIPTS, withRecordDefaults, type RegistryState, type Row } from "./resume-prelude";
import { exactRevivalIdentity, launchHandle, LaunchInterrupted, launchTransaction, recordFromRow, survivingSession, withLaunchSignals, type LaunchRecord,
  type TransactionKind } from "./transaction";
import { verbArgv } from "../courier-argv";

export interface Options { dryRun: boolean; json: boolean; model: string | null; teams: boolean; key: string | null; legacyName: string | null }

/** Canonical options from session-doors.ts or an in-process launch caller. */
export function parseResume(argv: string[]): Options {
  const options: Options = { dryRun: false, json: false, model: null, teams: false, key: null, legacyName: null };
  let positional = false;
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (positional || !token.startsWith("-")) { positionals.push(token); continue; }
    if (token === "--") positional = true;
    else if (token === "--dry-run") options.dryRun = true;
    else if (token === "--json") options.json = true;
    else if (token === "--teams") options.teams = true;
    else if (token === "--model" && i + 1 < argv.length) options.model = argv[++i]!;
    else throw new Refusal("usage: tap session resume <handle|session|harness>");
  }
  if (positionals.length > 2) throw new Refusal("usage: tap session resume <handle|session|harness>");
  [options.key = null, options.legacyName = null] = positionals;
  return options;
}

const isHarness = (value: string | null | undefined): value is string => typeof value === "string" && HARNESSES.includes(value);

// ---- naming: parse_session_name / allocated_index (the resume owners; launch keeps its Python twin) ----

const HARNESS_BY_CODE: Record<string, string> = { c: "claude", cx: "codex", oc: "opencode", cu: "cursor", he: "hermes", ag: "agy" };
const byCode = (stem: string): string => Object.hasOwn(HARNESS_BY_CODE, stem) ? HARNESS_BY_CODE[stem]! : stem;
const decimal = (text: string): number | null => /^\p{Nd}+$/u.test(text) ? parseUnicodeDecimal(text) : null;

/** parse_session_name for the one base a resume knows: (harness, tag, index) or null. */
export function parseSessionName(name: string, base: string): [string, string | null, number] | null {
  if (!base) return null;
  const clean = sanitizeComponent(base);
  const slashPrefix = `${clean}/`;
  if (name.startsWith(slashPrefix)) {
    const handle = name.slice(slashPrefix.length);
    if (!handle) return null;
    const match = /^([^\n]+)-(\p{Nd}+)(?![\s\S])/u.exec(handle);
    const stem = match ? match[1]! : handle;
    const index = match ? parseUnicodeDecimal(match[2]!)! : 1;
    const harness = byCode(stem);
    return isHarness(harness) ? [harness, null, index === 0 ? 1 : index] : ["", handle, 1];
  }
  const prefix = `${clean}-`;
  if (!name.startsWith(prefix)) return null;
  const parts = name.slice(prefix.length).split("-");
  const harness = byCode(parts[0]!);
  if (!isHarness(harness)) return null;
  if (parts.length === 1) return [harness, null, 1];
  const index = decimal(parts.at(-1)!);
  if (index !== null) return [harness, parts.slice(1, -1).join("-") || null, index === 0 ? 1 : index];
  return [harness, parts.slice(1).join("-") || null, 1];
}

export function allocatedIndex(name: string, base: string, harness: string): number {
  const parsed = parseSessionName(name, base);
  return parsed && parsed[0] === harness ? parsed[2] : 1;
}

const slashHandle = (name: string, base: string): string | null => {
  const prefix = `${sanitizeComponent(base)}/`;
  return name.startsWith(prefix) ? name.slice(prefix.length) || null : null;
};

/** resolve_base_alias over the registry projection: the team name, else the root's own. */
export const baseAlias = (state: RegistryState, cwd: string): string =>
  typeof state.team.name === "string" && state.team.name ? state.team.name : sanitizeComponent(basename(rootForCwd(cwd)));

// ---- registry reads: each is a fresh read, as the incumbent re-read at each call ----

/** registry_v20._seat_map in file order; empty when absent, unreachable or unreadable. */
function seatMap(root: string, dictsOnly: boolean): Map<string, unknown> {
  const { status, path } = registryAuthority(root);
  if (!path || status === "invalid" || status === "live_unreachable" || status === "live_unenrolled") return new Map();
  let text: string, payload: unknown;
  try { text = pyReadUtf8(path); payload = parseJsonPreserving(text); } catch { return new Map(); }
  if (!isDict(payload)) return new Map();
  refuseOldRegistry(path, payload);
  try {
    return new Map(seatEntries(payload, orderedDoc(text)).filter(([, entry]) => !dictsOnly || isDict(entry)));
  } catch { return new Map(); }
}

/** An old-format acting registry is a typed refusal, never an empty roster. */
function refuseOldRegistry(path: string, payload: unknown): void {
  const oldStore = teamRegistryRefusal(path, payload);
  if (oldStore) throw new LauncherError(oldStore.detail, "old_store", oldStore.action, oldStore.detail);
}
/** registry_entries: dict rows only. */
const registryEntries = (root: string) => seatMap(root, true) as Map<string, Row>;
export const registryEntry = (root: string, handle: string): Row | null => registryEntries(root).get(handle) ?? null;

/** launch_reservation_expired's shape guard (seat_corpse.is_launch_reservation). */
const isLaunchReservation = (row: Row): boolean =>
  row.status === "pending" || (row.status === "active" && row.status_reason === "launching" && !!row.launch_id);

/** current_timestamp as epoch seconds; TAP_WATCH_NOW pins the clock for probes. */
function nowSeconds(): number {
  const pinned = Number.parseInt(process.env.TAP_WATCH_NOW ?? "", 10);
  return process.env.TAP_WATCH_NOW && /^\s*[+-]?\d+\s*$/.test(process.env.TAP_WATCH_NOW) ? pinned : Math.floor(Date.now() / 1000);
}

/** tap_seat_entries: every seat row except an expired launch reservation. */
export function unexpiredSeats(root: string, live: Set<string> | null): Map<string, unknown> {
  const seats = seatMap(root, false);
  const boot = currentBootId(), legacy = legacyBootId(process.env) || null;
  for (const [handle, entry] of seats) {
    if (isDict(entry) && isLaunchReservation(entry) && typeof entry.session === "string" && entry.session
        && reservationExpired(entry as never, live, nowSeconds(), boot, legacy)) seats.delete(handle);
  }
  return seats;
}

/** tmux_sessions_or_none: null when tmux cannot say. */
async function liveSessions(): Promise<Set<string> | null> {
  try {
    const result = await launchTmux(["list-sessions", "-F", "#S"], process.env);
    return result.code === 0 ? new Set(result.stdout.split(/\r\n|\r|\n/).filter(Boolean)) : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const text = (value: unknown): string => value === null || value === undefined || value === false || value === "" ? "" : String(value);
const isPaneId = (value: string): boolean => /^%[0-9]+$/.test(value);

/** launcher.py boot_ids_match: exact, else a numeric legacy stamp within five seconds. */
function bootIdsMatch(stored: string, current: string): boolean {
  if (stored && stored === current) return true;
  if (process.env.TAP_BOOT_ID !== undefined && process.env.TAP_BOOT_ID_LEGACY === undefined) return false;
  const legacy = /^boot:(\d+)$/.exec(legacyBootId(process.env) || ""), row = /^boot:(\d+)$/.exec(stored);
  if (!stored || !current || !row || !legacy) return false;
  return Math.abs(Number(row[1]) - Number(legacy[1])) <= 5;
}

/** seat_is_reclaimable_corpse: only a pane-backed active row whose name is positively gone this generation. */
export function seatIsReclaimableCorpse(entry: unknown, live: Set<string> | null, epoch: string | null, boot: string | null): boolean {
  if (!isDict(entry) || isLaunchReservation(entry) || entry.delivery === "poll") return false;
  if ((Object.hasOwn(entry, "status") ? entry.status : "active") !== "active") return false;
  const storedId = text(entry.pane_id), pane = text(entry.pane);
  if (storedId && !isPaneId(storedId)) return false;
  if (!storedId && !pane) return false;
  if (live === null) return false;
  let session = text(entry.session);
  if (!session && pane.includes(":")) session = pane.split(":", 1)[0]!;
  if (!session || live.has(session)) return false;
  const rowEpoch = text(entry.server_epoch);
  if (rowEpoch && (!epoch || rowEpoch !== epoch)) return false;
  const rowBoot = text(entry.boot_id);
  if (rowBoot && (!boot || !bootIdsMatch(rowBoot, boot))) return false;
  return true;
}

/** occupied_session_names: live names plus every protected registered name, from one snapshot. */
export async function occupiedSessionNames(base: string, root: string): Promise<Set<string>> {
  const live = await liveSessions();
  const epoch = live !== null ? await currentEpoch(process.env) : null;
  const boot = currentBootId();
  const names = new Set(live ?? []);
  for (const [handle, entry] of unexpiredSeats(root, live)) {
    if (!seatIsReclaimableCorpse(entry, live, epoch, boot)) names.add(sessionNameForHandle(base, handle));
  }
  return names;
}

/** _current_registry_handles: relaunchable handles; empty when no registry can be read. */
function currentRegistryHandles(cwd: string): Set<string> {
  let root: string;
  try { root = rootForCwd(cwd); } catch { root = realOrSelf(cwd); }
  const { status, path } = registryAuthority(root);
  if (status === "invalid" || status === "live_unreachable" || !path) return new Set();
  let payload: unknown;
  try { payload = JSON.parse(pyReadUtf8(path)); } catch { return new Set(); }
  if (!isDict(payload)) return new Set();
  refuseOldRegistry(path, payload);
  const seats = isDict(payload.seats) ? payload.seats : {};
  return new Set(Object.entries(seats).filter(([, entry]) => seatIsRelaunchable(entry)).map(([handle]) => handle));
}

/** _require_relaunchable_resume_member: membership before any reattach or launch. */
export function requireMember(cwd: string, record: LaunchRecord, explicitResume = false): void {
  const current = currentRegistryHandles(cwd);
  const handle = launchHandle(record);
  if (current.has(handle)) return;
  if (explicitResume && seatIsRelaunchable(registryEntry(rootForCwd(cwd), handle), true)) return;
  throw new Refusal(`resume refused — '${handle}' is not a relaunchable current seat in the acting registry `
    + "(archived-only or non-relaunchable); use tap session launch for a new seat, or restore membership first");
}

// ---- record lookup (launcher.py find_record_*) ----

const scoped = (records: LaunchRecord[], cwd: string) => {
  const root = rootForCwd(cwd);
  return records.filter(record => pathIsUnder(record.cwd, root));
};

export function findRecordByKey(records: LaunchRecord[], cwd: string, key: string): LaunchRecord | null {
  const rows = scoped(records, cwd);
  const index = recordKeySelection(rows.map(({ name, base, harness, tag, index }) =>
    ({ name, base, harness, tag: tag ?? null, index: index ?? null })), key);
  return index === null ? null : rows[index]!;
}
const findRecordBySession = (records: LaunchRecord[], cwd: string, name: string) => scoped(records, cwd).find(record => record.name === name) ?? null;
const findRecord = (records: LaunchRecord[], harness: string, name: string) => records.find(record => record.harness === harness && record.name === name) ?? null;

/** _failed_resume_record: exact-key recovery of a row only an explicit resume may relaunch. */
async function failedResumeRecord(base: string, cwd: string, key: string): Promise<LaunchRecord | null> {
  const root = rootForCwd(cwd);
  const matches: [string, Row][] = [];
  for (const [handle, row] of registryEntries(root)) {
    // The incumbent's order: every row not matched by handle is probed before
    // the relaunchable filters, so a failing probe fails the resume.
    if (handle !== key && await entrySession(row, process.env) !== key) continue;
    if (seatIsRelaunchable(row) || !seatIsRelaunchable(row, true)) continue;
    matches.push([handle, row]);
  }
  if (matches.length > 1) throw new Refusal(`resume key is ambiguous: ${key}; use an exact handle`);
  if (!matches.length) return null;
  const [handle, row] = matches[0]!;
  const record = recordFromRow(handle, row, { name: base, worktree_root: root }, root);
  return record ? withRecordDefaults(record) : null;
}

/** The seat a record's session is judged by: its harness, never a registered crew pane (tap-9rrat). */
export function recordSeat(record: Pick<LaunchRecord, "name" | "harness" | "cwd">): SessionSeat {
  return { harness: record.harness, crewPanes: crewPanesIn(registryEntries(rootForCwd(record.cwd)), record.name) };
}

/** session_attachable: attach only where attaching is right; shells and a gone seat fall through to resume. */
export const sessionAttachable = async (name: string, seat?: SessionSeat): Promise<boolean> =>
  await hasSession(name, process.env) && attachableState(await classifySession(name, process.env, undefined, seat));
const recordAttachable = (record: LaunchRecord): Promise<boolean> => sessionAttachable(record.name, recordSeat(record));

async function sessionPanes(name: string): Promise<PaneFacts[]> {
  let result;
  try { result = await launchTmux(["list-panes", "-s", "-t", `=${name}`, "-F", PANE_FACTS_FORMAT], process.env); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (result.code !== 0) return [];
  return result.stdout.split(/\r\n|\r|\n/).map(line => parsePaneFacts(line, process.env)).filter((facts): facts is PaneFacts => facts !== null);
}

/** matching_session_pane: the active pane if it runs the harness, else the first that does. */
async function matchingSessionPane(record: LaunchRecord): Promise<[PaneFacts | null, string | null]> {
  // A registered crew of the seat's own harness is never the seat.
  const crews = recordSeat(record).crewPanes!;
  const active = await paneFacts(`=${record.name}`, process.env);
  const activeHarness = active ? paneHarness(active, process.env) : null;
  if (active && activeHarness === record.harness && !crews.has(active.pane_id)) return [active, activeHarness];
  for (const candidate of await sessionPanes(record.name)) {
    const harness = paneHarness(candidate, process.env);
    if (harness === record.harness && !crews.has(candidate.pane_id)) return [candidate, harness];
  }
  return [active, activeHarness];
}

/** live_resume_record: a record for a live pane whose harness is known. */
async function liveResumeRecord(base: string, cwd: string, name: string): Promise<LaunchRecord | null> {
  const facts = await paneFacts(`=${name}`, process.env);
  const harness = facts ? paneHarness(facts, process.env) : null;
  if (!isHarness(harness)) return null;
  const parsed = parseSessionName(name, base);
  let tag = slashHandle(name, base), index = 1;
  if (tag === null && parsed && parsed[0] === harness) [tag, index] = [parsed[1], parsed[2]];
  return withRecordDefaults({ name, harness, cwd, base, tag, index });
}

/** registry_resume_record: an active row whose handle or verified session is the key. */
async function registryResumeRecord(base: string, cwd: string, key: string): Promise<LaunchRecord | null> {
  const value = await registryResumeSelection([...registryEntries(rootForCwd(cwd))], key, process.env);
  return value ? withRecordDefaults({ ...value, cwd, base }) : null;
}

// ---- output ----

/** launcher.py styled("warning", ...): tput colour only for a capable terminal. */
function warningWord(): string {
  if (process.env.NO_COLOR !== undefined || !process.env.TERM || process.env.TERM === "dumb") return "warning";
  const force = process.env.CLICOLOR_FORCE;
  let capable = !!force && force !== "0";
  if (!capable) { try { capable = process.stderr.isTTY === true; } catch { capable = false; } }
  if (!capable) return "warning";
  const tokens: string[] = [];
  for (const args of [["setaf", "1"], ["setaf", "3"], ["bold"], ["dim"], ["sgr0"]]) {
    const result = spawnSync("tput", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (result.error || result.status !== 0 || !result.stdout) return "warning";
    tokens.push(result.stdout);
  }
  return `${tokens[1]}warning${tokens[4]}`;
}
const warn = (problem: string, next: string) => err(`tap session: ${warningWord()}: ${problem}; next: ${next}`);
export const receipt = (message: string) => out(`tap session: ${message}`);

/** native_revive_mode's receipt context. */
function reviveContext(harness: string, sessionId: string | null | undefined): string {
  if (sessionId) return `${harness} resume ${sessionId}`;
  if (harness === "claude" || harness === "codex") return `${harness} native picker`;
  if (harness === "agy") return "no conversation id on record; pick one with agy's /resume";
  if (harness === "cursor") return "no session id on record; browse past sessions with cursor-agent ls";
  return "no conversation to resume";
}

// ---- effects: substitutable for focused tests ----

export type Outcome = { code: number; adopted_shell: boolean };
export interface ResumeDeps {
  run: (kind: TransactionKind, record: LaunchRecord, extra?: { native_query?: string | null }) => Promise<Outcome>;
  attach: (tail: "resume" | "launch", record: LaunchRecord) => Promise<number>;
  register: (record: LaunchRecord) => Promise<boolean>;
  hasTty: () => boolean;
  choose: typeof promptChoice;
}

const FRESH_START_WARNING_HOLD_MS = 1500;

/** Whether the resume attach holds before repainting: only a resume tail whose record printed an id-less fresh-start warning. */
export function holdsFreshStartWarning(tail: "resume" | "launch", record: LaunchRecord): boolean {
  return tail === "resume" && idlessFreshWarning(record) !== null;
}

/** The attach tail, in the process that owns the terminal. Never the verdict: always 0. */
export async function attachTailInProcess(tail: "resume" | "launch", record: LaunchRecord): Promise<number> {
  const name = record.name;
  const target = `${record.base}/${launchHandle(record)}`;
  const fallback = (problem: string) => { warn(`${problem}; the session is running and registered`, `from a foreground terminal, run tap attach ${target}`); return 0; };
  const facts = { tmux: process.env.TMUX ?? "", tmux_pane: process.env.TMUX_PANE ?? "", caller_tty: callerTty(),
    owns_foreground: callerOwnsForegroundTty(), has_tty: callerHasTty() };
  let decision;
  try { decision = await withLaunchSignals(signal => attachTail(tail, name, facts, signal)); }
  catch (error) {
    if (error instanceof LaunchInterrupted) throw error;
    return fallback(`could not decide how to attach to ${name} (${(error as Error)?.message ?? String(error)})`);
  }
  if ("detached" in decision) { receipt(detachedReceipt(name, decision.detached, target)); return 0; }
  if ("refused" in decision) { receipt(detachedReceipt(name, attachNarration(name, decision.refused).receipt!, target)); return 0; }
  // The attach repaints the terminal: hold an id-less fresh-start warning on screen long enough to read.
  if (holdsFreshStartWarning(tail, record)) await Bun.sleep(FRESH_START_WARNING_HOLD_MS);
  // Custody is re-read at the spawn: the probe above, or the hold, may have blocked meanwhile.
  if (!callerOwnsForegroundTty()) {
    receipt(detachedReceipt(name, attachNarration(name, ATTACH_REFUSED_TTY_OWNERSHIP).receipt!, target));
    return 0;
  }
  const unset = new Set(decision.unset_env);
  const childEnv = unset.size ? Object.fromEntries(Object.entries(process.env).filter(([key]) => !unset.has(key))) : process.env;
  const child = spawnSync(decision.argv[0]!, decision.argv.slice(1), { stdio: "inherit", env: childEnv });
  if (child.error) return fallback(`could not run ${decision.argv[0]} to attach to ${name} (${child.error.message})`);
  // subprocess.call's convention: a signal death is the negated signal number.
  const rc = child.status ?? -((child.signal && constants.signals[child.signal]) || 1);
  if (rc === 0) return 0;
  const told = attachNarration(name, rc, target);
  if (told.warning) warn(told.warning.problem, told.warning.next);
  receipt(detachedReceipt(name, told.receipt!, target));
  return 0;
}

/** The live pane a reattach would register, or the line that says why none can be. Read-only. */
async function livePaneOrProblem(record: LaunchRecord): Promise<[PaneFacts, null] | [null, string]> {
  const [facts, harness] = await matchingSessionPane(record);
  if (!facts) return [null, `session ${record.name} is not live`];
  if (harness !== record.harness) return [null, `session ${record.name} active pane is ${harness}, not ${record.harness}`];
  return [facts, null];
}

/** register_resumed_session: `tap register --pane` as its own subprocess, with its own custody. */
export async function registerResumedSession(record: LaunchRecord, scriptDir = SCRIPTS): Promise<boolean> {
  const [facts, problem] = await livePaneOrProblem(record);
  if (!facts) { out(`tap session resume: ${problem}`); return false; }
  const root = rootForCwd(record.cwd), handle = launchHandle(record);
  const existing = registryEntry(root, handle);
  const command = verbArgv(scriptDir, ["register", handle, "--pane", facts.pane, "--json"], process.env);
  if (existing && (existing.cost_mode === "subscription" || existing.cost_mode === "api")) command.push("--mode", existing.cost_mode);
  if (existing && (existing.include_policy === "always" || existing.include_policy === "on_request")) command.push("--include", existing.include_policy);
  const childEnv: NodeJS.ProcessEnv = { ...process.env, TAP_SKIP_VERSION_BRIEFING: "1" };
  delete childEnv.TAP_HOME;
  const child = Bun.spawn(command, { cwd: root, env: childEnv, stdin: "inherit", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) { err(stderr.trim() || stdout.trim() || "tap register failed"); return false; }
  let registered: unknown;
  try { const parsed = JSON.parse(stdout); registered = isDict(parsed) && isDict(parsed.receipt) ? parsed.receipt.handle : undefined; }
  catch { registered = undefined; }
  if (typeof registered !== "string" || !registered) { err("tap session resume: tap register returned an invalid receipt"); return false; }
  if (existing === null) out(`tap session resume: registered ${registered} (new seat via resume)`);
  return true;
}

// ---- the command ----

/** The refusals a live reattach takes before it registers anything. Read-only. */
async function refuseUnverifiedLiveRow(record: LaunchRecord): Promise<void> {
  const root = rootForCwd(record.cwd), handle = launchHandle(record);
  const entry = registryEntry(root, handle);
  if (seatIsRelaunchable(entry, true) && !seatIsRelaunchable(entry)) {
    throw new Refusal(`resume refused — ${record.name} is live while its retained row is suspended/${text(entry!.status_reason) || "None"}; `
      + `the occupant's native identity is unverified; inspect with tmux attach -t ${shlexQuote(record.name)} (no registration changed)`);
  }
  const row = registryEntry(root, handle);
  if (row && staleSeatGeneration(row, await observeGeneration())) {
    throw new Refusal(`resume refused — ${record.name} is live but the retained row belongs to a prior boot/server; `
      + `inspect with tmux attach -t ${shlexQuote(record.name)} (no registration changed)`);
  }
}

/** reattach_live_session: register the live occupant, then attach; never over an unverified row. */
async function reattachLiveSession(record: LaunchRecord, deps: ResumeDeps): Promise<number> {
  await refuseUnverifiedLiveRow(record);
  return await deps.register(record) ? deps.attach("resume", record) : 2;
}

/** The dry run of a live reattach: the same refusals and the same pane check, then the path
 * the real run would take. It registers, attaches and writes nothing. */
async function previewLiveReattach(record: LaunchRecord, json: boolean): Promise<number> {
  await refuseUnverifiedLiveRow(record);
  const [facts, problem] = await livePaneOrProblem(record);
  if (!facts) throw new LauncherError(`resume refused — ${problem}`, "live_session_unmatched", "tap help session", problem!);
  if (json) out(compact({ ok: true, outcome: "would_reattach", name: record.name, harness: record.harness, handle: launchHandle(record), pane: facts.pane,
    steps: ["register", "attach"] }));
  else receipt(`would reattach live session ${record.name} (pane ${facts.pane}): register ${launchHandle(record)} via tap in, then attach; no changes made`);
  return 0;
}

/** offer_departed_restore: the one sanctioned history-restore suggestion; always exit 2. */
function offerDepartedRestore(handle: string, rows: Map<string, unknown>[], interactive: boolean, deps: ResumeDeps): number {
  const instance = text(rows[0]!.get("instance"));
  const listCmd = `tap in ${handle} --list-history --json`;
  const restoreCmd = instance ? `tap in ${handle} --restore ${shlexQuote(instance)}` : listCmd;
  const message = `no active seat named ${handle}; found ${rows.length} departed in team-history — restore?`;
  if (!interactive) throw new Refusal(`${message} next: ${listCmd} then ${restoreCmd} (or tap in ${handle} --fresh)`);
  err(`tap session resume: ${message}`);
  if (instance) err(`  most recent instance: ${instance}`);
  const choice = deps.choose("session", message, [
    ["r", "restore", `restore most recent — next: ${restoreCmd}`],
    ["l", "list", `list departed instances — next: ${listCmd}`],
    ["q", "quit", "leave everything unchanged"],
  ], "q");
  if (choice === "r" && instance) err(`tap session resume: restore with:\n  ${restoreCmd}`);
  else if (choice === "l") err(`tap session resume: list with:\n  ${listCmd}`);
  return 2;
}

/** execute_fresh_launch for the create fallback: the [k] path, then the launch attach tail. */
async function executeFreshLaunch(record: LaunchRecord, deps: ResumeDeps): Promise<number> {
  const attach = deps.hasTty();
  const outcome = await deps.run("new", record);
  if (outcome.code !== 0) return outcome.code;
  for (const line of record.ensure_receipts ?? []) receipt(line);
  if (!attach) { receipt(detachedReceipt(record.name, "no controlling terminal", `${record.base}/${launchHandle(record)}`)); return 0; }
  return deps.attach("launch", record);
}

/** run_adopted_resume: a bare harness family with no single record gets a fresh adopted seat. */
async function runAdoptedResume(harness: string, base: string, cwd: string, options: Options, deps: ResumeDeps): Promise<number> {
  refuseIfResetFenced(cwd);
  fenceTestBarrier("after-entry-guard");
  const name = allocateName(base, harness, null, await occupiedSessionNames(base, rootForCwd(cwd)));
  const record = withRecordDefaults({ name, harness, cwd, base, tag: null, index: allocatedIndex(name, base, harness), model: null,
    last_launched: timestamp() });
  // Cursor never opens its picker (tap-we6b): an id-less resume starts fresh, as OpenCode's does.
  // agy's picker is in-app only, so it starts empty and the operator picks with /resume.
  const how = harness === "opencode" || harness === "cursor" ? "; starting a fresh conversation"
    : harness === "agy" ? "; starting an empty conversation. Use agy's /resume picker to select the conversation you want"
    : " using the native resume picker";
  err(`tap session: no known ${harness} session found; creating tmux session ${pyRepr(name)}${how}`);
  err(`tap session: resuming ${name}; expected seat ${launchHandle(record)}`);
  const outcome = await deps.run("adopted", record, { native_query: null });
  if (options.dryRun || outcome.code !== 0) return outcome.code;
  return deps.attach("resume", record);
}

/** The shell rendering of shlex.join. */
const shlexJoin = (argv: string[]): string => argv.map(shlexQuote).join(" ");

export async function resumeOne(options: Options, cwd: string, deps: ResumeDeps): Promise<number> {
  entryGuard(cwd);
  const state = registryState(cwd);
  const records = state.sessions, base = baseAlias(state, cwd);
  let key = options.key;
  const legacyName = options.legacyName;
  if (legacyName && !isHarness(key)) throw new Refusal("two-argument resume form is tap session resume <harness> <name>");
  const harnessHint = isHarness(key) && legacyName ? key : null;
  let harness: string | null = null;
  if (harnessHint) { harness = harnessHint; key = legacyName; }
  else if (isHarness(key)) harness = key;
  if (!key) throw new Refusal("usage: tap session resume <handle|session|harness>");
  const refuseUnbacked = (name: string) =>
    new Refusal(`resume refused — live session '${name}' has no relaunchable acting-registry seat`);
  const reattach = (record: LaunchRecord) => { requireMember(cwd, record, true); return options.dryRun ? previewLiveReattach(record, options.json || process.env.TAP_JSON === "1") : reattachLiveSession(record, deps); };

  let targetName = key;
  let record = findRecordByKey(records, cwd, targetName);
  if (record === null && !isHarness(key)) record = await failedResumeRecord(base, cwd, key);
  // A live seat reattaches, so a dry run answers the same question the real run does.
  if (record && await recordAttachable(record)) return reattach(record);
  if (!record && await sessionAttachable(targetName)) {
    const direct = record ?? findRecordBySession(records, cwd, targetName) ?? await liveResumeRecord(base, cwd, targetName);
    if (!direct) throw refuseUnbacked(targetName);
    return reattach(direct);
  }
  if (!record && isHarness(key) && !legacyName) {
    const matches = scoped(records, cwd).filter(item => item.harness === key);
    if (matches.length !== 1) return runAdoptedResume(key, base, cwd, options, deps);
    record = matches[0]!;
  }
  if (!record && harnessHint) record = findRecord(records, harnessHint, targetName);
  if (!record && harnessHint) {
    const digits = Number(process.env.PYTHONINTMAXSTRDIGITS ?? 4300);
    for (const expanded of resumeCandidateNames({ name: key, harness: harnessHint, base, int_max_str_digits: Number.isSafeInteger(digits) ? digits : 4300 })) {
      targetName = expanded;
      record = findRecord(records, harnessHint, targetName);
      if (!record && await sessionAttachable(targetName)) {
        const early = await registryResumeRecord(base, cwd, targetName) ?? await liveResumeRecord(base, cwd, targetName);
        if (!early) throw refuseUnbacked(targetName);
        return reattach(early);
      }
      if (record) break;
    }
  }
  if (record && await recordAttachable(record)) return reattach(record);
  if (!record) return noRecord(key, harness, base, cwd, options, deps);

  // Resume replays the seat's stored record; the model was chosen once, at launch.
  const launched: LaunchRecord = { ...record, last_launched: timestamp() };
  // The acting registry row is the identity claim; an id-less row reaches the
  // harness picker, never a derived exact-resume target.
  assertUniqueHarnessSessionIdentity(records, launched, "tap session resume");
  requireMember(cwd, launched, true);
  if (launched.harness === "opencode" && !launched.harness_session_id) {
    err(`tap session: WARNING: ${launched.name} has no native OpenCode session id; starting a fresh conversation`);
  }
  // tap-we6b rework: a stored cursor id whose chat store never appeared is not
  // resumable — Cursor writes no per-chat store until the chat's first turn, so
  // exact-targeting it would silently start a DIFFERENT conversation. Refuse
  // instead of picking, the same gate relaunch and restart take through
  // no_exact_resume_identity; a fresh start is an explicit decision.
  if (launched.harness === "cursor" && launched.harness_session_id && !recordHasResumeArtifact(launched, process.env)) {
    throw new LauncherError(
      `resume refused — ${launched.name} (cursor) has stored chat id ${launched.harness_session_id} but no persisted conversation store`,
      "no_exact_resume_identity", `tap session launch cursor ${launchHandle(launched)} --fresh`,
      `stored chat id ${launched.harness_session_id} has no cursor store.db under this worktree; the conversation never persisted, so resume refuses rather than silently start a different one`,
    );
  }
  const source = registryEntry(rootForCwd(cwd), launchHandle(launched)) ?? {};
  const recovery = source.status === "suspended" && !seatIsRelaunchable(source) && seatIsRelaunchable(source, true)
    ? text(source.status_reason) : "";
  if (options.dryRun && recovery) err(`tap session: would resume ${launched.name} from suspended/${recovery}`);
  // tap-9rrat: a seat whose harness exited while its crews hold the session revives beside them.
  const seatGone = await hasSession(launched.name, process.env)
    && await classifySession(launched.name, process.env, undefined, recordSeat(launched)) === "seat-gone";
  let family: { team: string; registryPath: string } | null = null, crews: SurvivingCrew[] = [];
  if (seatGone) {
    // Crews are only reclaimed into the recorded conversation, never a picked or fresh one: the
    // transaction's own exact gate runs here, before any effect, and again under its custody.
    try { exactRevivalIdentity(launched, process.env); }
    catch (error) {
      throw new LauncherError(`resume refused — ${launched.name} holds live crews but has no resumable recorded ${launched.harness} conversation`,
        "no_exact_resume_identity", `tmux attach -t ${shlexQuote(launched.name)}`,
        `reviving into a session with crews needs the seat's recorded native id (${(error as Error).message}); nothing was changed and the crews keep running`);
    }
    // Pinned with the classification: the transaction revives into exactly this session generation.
    launched.revive_session = await survivingSession(launched.name, process.env);
    if (!launched.revive_session || await classifySession(launched.name, process.env, undefined, recordSeat(launched)) !== "seat-gone"
        || await survivingSession(launched.name, process.env) !== launched.revive_session) {
      throw new Refusal(`resume refused — session ${launched.name} changed while the resume checked it; nothing was changed; retry`);
    }
    launched.revive_vessel = "window";
    if (options.dryRun) err(`tap session: would revive ${launched.harness} into surviving session ${launched.name} in a new window; its other windows stay`);
    else {
      const path = registryAuthority(rootForCwd(cwd)).path;
      family = path ? { team: base, registryPath: path } : null;
      try { crews = family ? survivingCrews(family, launchHandle(launched)) : []; }
      catch (error) { warn(`could not read ${launchHandle(launched)}'s crews before reviving (${(error as Error).message})`, "they keep running; inspect with tap crew list"); }
      // An old supervisor still running would reap its crew while the revived harness starts.
      for (const crew of crews) {
        if (crew.binding && !await fenceSurvivingCrew(launchHandle(launched), crew)) {
          warn(`crew ${crew.crew}'s old supervisor was not fenced before the revival`, `if it stops the crew, relaunch it with tap crew add`);
        }
      }
    }
  }
  const outcome = await deps.run("resume", launched);
  if (options.dryRun || outcome.code !== 0) return outcome.code;
  if (launched.revive_vessel === "window") {
    receipt(`revived ${launched.name} in a new window beside its surviving windows (${reviveContext(launched.harness, launched.harness_session_id)}; expected seat ${launchHandle(launched)})`);
    for (const crew of crews) {
      try { await reclaimRevivedCrew(family!, launchHandle(launched), crew); receipt(`crew ${crew.crew} reclaimed by ${launchHandle(launched)}`); }
      catch (error) { warn(`crew ${crew.crew} kept running but was not reclaimed (${(error as Error).message})`, `inspect with tap crew list; stop it with tap crew shutdown ${crew.crew}`); }
    }
  }
  if (outcome.adopted_shell) {
    receipt(`resumed ${launched.name} (adopted shell session, ${reviveContext(launched.harness, launched.harness_session_id)}; expected seat ${launchHandle(launched)})`);
  }
  if (recovery) err(`tap session: resumed ${launched.name} from suspended/${recovery}`);
  return deps.attach("resume", launched);
}

/** No record backs the key: departed history, an occupied roster handle, or the create fallback. */
async function noRecord(key: string, harness: string | null, base: string, cwd: string, options: Options, deps: ResumeDeps): Promise<number> {
  // U5: resume is the sole door that may offer team-history restore; launch never suggests history.
  const bare = HARNESSES.includes(key) ? null : key.slice(key.lastIndexOf("/") + 1);
  const root = rootForCwd(cwd);
  const roster = unexpiredSeats(root, await liveSessions());
  if (bare !== null && !roster.has(bare)) {
    const rows = listHandleHistory("", bare, join(root, ".tap", "team-history"));
    if (rows.length) return offerDepartedRestore(bare, rows, deps.hasTty() && !options.dryRun, deps);
  }
  if (bare !== null && roster.has(bare)) {
    const current = roster.get(bare);
    const occupied = isDict(current) && isHarness(current.harness as string) ? current.harness as string : harness;
    const launch = shlexJoin(occupied ? ["tap", "session", "launch", occupied, bare] : ["tap", "session", "launch"]);
    throw new Refusal(`resume refused — handle '${bare}' is occupied on the roster but has no launcher record to resume. `
      + `Run ${launch} and choose [k] fresh replacement or [n] suffixed sibling; no create fallback was attempted`);
  }
  if (!harness) throw new Refusal(`resume key not found: ${key}`);
  const create = shlexJoin(["tap", "session", "launch", harness, key]);
  // The same both-streams predicate the prompts use: a caller that cannot see a question is refused.
  if (options.dryRun || !deps.hasTty()) throw new Refusal(`no ${harness} session found for ${key}; create it with ${create}`);
  const fresh = namedSessionName(base, key);
  err(`tap session: no ${harness} record for ${key} — starting a fresh session under this name (replaces the live session)`);
  return executeFreshLaunch(withRecordDefaults({ name: fresh, harness, cwd, base, tag: key, index: 1,
    harness_session_id: freshLaunchSessionId(harness), replaces_session: fresh, kill_backup_required: true,
    ensure_action: "new", last_launched: timestamp() }), deps);
}

// ---- entry ----

type TraceContext = { fields: Record<string, unknown>; active: boolean };
/**
 * The Python door's open trace operation, popped so no child inherits it.
 * undefined: a direct entry with no door, which traces its own operation;
 * null: a door with no usable context, which traces nothing (as the worker did).
 */
function popTraceContext(): TraceContext | null | undefined {
  const raw = process.env.TAP_STARTUP_TRACE_CONTEXT;
  delete process.env.TAP_STARTUP_TRACE_CONTEXT;
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return isDict(parsed) && typeof parsed.active === "boolean" && isDict(parsed.fields) ? parsed as TraceContext : null;
  } catch { return null; }
}

/** scriptDir: the installed scripts tree, which a compiled router passes (its SCRIPTS is the bundle's). */
export async function cmdSessionResume(argv: string[], scriptDir = SCRIPTS, originalArgv = argv): Promise<number> {
  const context = popTraceContext();
  const jsonRequested = process.env.TAP_JSON === "1" || argv.includes("--json");
  let options: Options;
  try { options = parseResume(argv); }
  catch (error) { return render(error, jsonRequested); }
  const cwd = realOrSelf(process.cwd());
  const notices = new Notices();
  notices.suppress(jsonRequested);
  let stderrTty = false;
  try { stderrTty = process.stderr.isTTY === true; } catch { /* no terminal */ }
  // Each transaction works on a copy, as the bridge's serialized packet did.
  const run: ResumeDeps["run"] = async (kind, record, extra = {}) => withLaunchSignals(async signal => {
    const result = await launchTransaction({ kind, record: cloneRecord(record), dry_run: options.dryRun, json: options.json,
      rerun_command: `cd ${shlexQuote(cwd)} && ${["tap", "session", "resume", ...originalArgv].map(shlexQuote).join(" ")}`,
      output_path: callerTty(), terminal: { stderr_tty: stderrTty }, script_dir: scriptDir, ...extra }, process.env, signal, notices);
    Object.assign(record, result.record);
    return { code: result.code, adopted_shell: result.adopted_shell };
  });
  const deps: ResumeDeps = { run, attach: attachTailInProcess, register: record => registerResumedSession(record, scriptDir), hasTty: callerHasTty, choose: promptChoice };
  const command = async (finish: boolean): Promise<number> => {
    let code = 1;
    try {
      try { refuseRetiredFlags(options.model, options.teams); code = await resumeOne(options, cwd, deps); }
      catch (error) { code = render(error, jsonRequested); }
      return code;
    } finally {
      if (finish) startupTrace(code === 0 ? "launch_complete" : "launch_failure", { exit_code: code });
    }
  };
  if (context === null || (context && !context.active)) return command(false);
  if (context) return withStartupTrace(() => { joinLifecycleDiagnostics(); return command(true); }, context.fields, scriptDir);
  return withStartupTrace(async () => {
    const traced = !options.dryRun;
    if (traced) beginLifecycleOperation({ verb: "resume", cwd: process.cwd(), target: options.key, boot_id: currentBootId() });
    return command(traced);
  }, undefined, scriptDir);
}

if (import.meta.main) await exitKeepingTerminal(await cmdSessionResume(process.argv.slice(2)));
