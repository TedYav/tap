import { reservedSeatName } from "../ids";
import { launchWorkdir, validateLaunchWorkdir } from "./workdir";
import { paneEnrollmentRefusal } from "../pane-enrollment";
// One session-creation transaction; callers retain selection, cohorts and attach.
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { atomicWrite } from "../fsatomic";
import { acquirePathLockAsync, acquireRegistryLockAsync, type AsyncRegistryLock } from "../panelock";
import { assertSelectionCurrent, selectCaller, type Selection } from "../selector";
import { ensureSeatInstance, supersedeForwardingAliases } from "../registry";
import { isDict, jsonDumpBytes, metaBytes, parseJsonPreserving, PyFloat, PyInt, pyReadUtf8 } from "../spool-publication";
import { reservationExpired } from "../reservation";
import { bootId, legacyBootId } from "../tmux";
import { launcherFenceRefusal, markResetGenerationReused } from "../reset";
import { startupTrace, startupTransition } from "../startup-trace";
import { Notices } from "./catalog-notices";
import { HARNESSES } from "./catalog";
import { buildInvocation, discardReceipts, launchInvocation, invocationShellCommand, resolveLoginShell, InvocationError, shlexQuote } from "./invocation";
import { type SessionRecord, type Invocation, type ResumeIdentity, UNBOUND_RESUME_IDENTITY } from "./types";
import { type PaneFacts, paneFacts, paneHarness, paneTailLines, awaitStableHarness, stripPaneSgr, memoizedStartupObservation, startupBlockerFromScreen, codexComposerIdle, opencodeReadySignal, type StartupObservation } from "./readiness";
import { currentEpoch, hasSession, classifySession, crewPanesIn, entrySession, verifiedSession, entryObservedDead, destructiveTarget, sessionPaneIds } from "./observation";
import { launchCommand, launchTmux, LaunchCommandError } from "./process";
import { ensureTmuxServer, tmuxBootstrapFailure } from "./tmux-bootstrap";
import { seatIsRelaunchable } from "./complete";
import { appendRegistryEvent } from "../events";
import { rootForCwd } from "./records";
import { enrolledTeams } from "../index-home";
import { oldStoreAction, oldStoreRefusalText, teamRegistryRefusal } from "../register-authority";
import { sanitizeComponent } from "./naming";
import { pyRepr, recordHasResumeArtifact, resolvedResumeIdentity, seatHarnessEnv } from "./resume-identity";
import { opencodeStorePath, opencodeStoredSession } from "../opencode-store";
import { launchPhase, launchTracked } from "./progress";
import { tapScriptsDir, artifactBun } from "../scripts-dir";

type Row = Record<string, unknown>;
export type LaunchRecord = SessionRecord & {
  tag?: string | null; index?: number | PyInt | null; history?: string[]; adopted_from_manual?: boolean;
  preset?: Record<string, string> | null; last_launched?: string | null; last_seen?: string | null;
  quarantined_transcript_path?: string | null; identity_quarantine_reason?: string | null;
  replaces_session?: string | null; replaces_manifest_session?: string | null; replacement_record?: Row | null; replacement_registry_entry?: Row | null;
  kill_backup_required?: boolean; kill_backup_path?: string | null; kill_backup_has_seat_state?: boolean;
  launch_id?: string | null; launch_failure_reason?: string | null; identity_capture_action?: string | null;
  ensure_action?: string; ensure_vessel?: string | null; ensure_receipts?: string[];
  /** "window": a resume revives the seat into its surviving session, beside its crews (tap-9rrat). */
  /** The surviving session's server generation and id ("<pid>:<start>\t$N"), pinned at the resume's preflight. */
  revive_vessel?: "window" | null; revive_session?: string | null;
};
export type TransactionKind = "new" | "adopted" | "resume" | "resume-all" | "restart" | "seat-up";
export type TransactionRequest = {
  kind: TransactionKind; record: LaunchRecord; dry_run?: boolean; json?: boolean;
  lifecycle_receipt?: import("../lifecycle-target").LifecycleReceipt;
  native_query?: string | null; live_sessions?: string[] | null; incumbent_live?: boolean;
  expected_row?: Row; expected_team?: string; expected_registry?: string; root?: string;
  /** Interactive team-up approval for this exact retained seat instance. */
  approved_instance?: string;
  output_path?: string; notice_state?: { suppressed: boolean; said: string[] };
  preflight_done?: boolean; terminal?: { stderr_tty: boolean };
  /** With dry_run: run every read-only validation the launch takes, then return without printing a launch receipt. */
  validate_only?: boolean;
  script_dir?: string; worker_bun?: string;
};
export type Vessel = { server: string; session: string; window: string; pane: string; socket: string };
export type Backup = { status: "backed-up"; path: string } | { status: "unavailable"; detail: string } | { status: "not-needed" };
export type FailureEvidence = { selection: Selection; handle: string; token: string; instance: string | null;
  record: LaunchRecord; vessel: Vessel | null; backup: Backup; reason: string; output_path: string };
export type TransactionResult = { code: number; record: LaunchRecord; adopted_shell: boolean; backup: Backup };
export class LaunchInterrupted extends Error {
  constructor(readonly exitCode: number) { super("launcher_interrupted: launch cancelled"); }
}
export async function withLaunchSignals<T>(body: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const interrupt = (code: number) => { if (!controller.signal.aborted) controller.abort(new LaunchInterrupted(code)); };
  const onInt = () => interrupt(130), onTerm = () => interrupt(143);
  process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
  try { return await body(controller.signal); }
  finally { process.off("SIGINT", onInt); process.off("SIGTERM", onTerm); }
}
export class TransactionError extends InvocationError {
  constructor(message: string, readonly recovery?: { selection: Selection; backup: Backup; session: string }, readonly tapErrorClass?: string, readonly tapAction?: string) {
    super(tapErrorClass ? `${tapErrorClass}: ${message}` : message);
  }
}
/** A proven session kill followed by a failed resume; never an instruction to retry automatically. */
export class RestartResumeFailure extends Error {
  readonly receipt: { ok: false; error_class: string; killed_session: string; stored_record_path: string; record: Row; action: string; resume_command: string; recovery_required: boolean; detail: string };
  constructor(cause: unknown, evidence: FailureEvidence) {
    const detail = `session ${evidence.record.name} was killed, but its resume failed: ${cause instanceof Error ? cause.message : String(cause)}`;
    super(detail, { cause });
    const resume = `cd ${shlexQuote(evidence.selection.rootReal)} && tap session resume ${shlexQuote(launchHandle(evidence.record))}`;
    const inspect = cause instanceof TransactionError && (!!cause.recovery || cause.message.startsWith("cannot identify created session"));
    this.receipt = { ok: false, error_class: "restart_resume_failed", killed_session: evidence.record.name,
      stored_record_path: evidence.backup.status === "backed-up" ? join(evidence.backup.path, "launcher-session-record.json") : evidence.selection.registryLocation,
      record: durableRecord(evidence.record),
      action: inspect ? `cd ${shlexQuote(evidence.selection.rootReal)} && tap doctor` : resume,
      resume_command: resume, recovery_required: inspect,
      detail };
  }
}
class RespawnFailure extends TransactionError {}
class StartupDialog extends TransactionError {}

const string = (v: unknown): string => typeof v === "string" ? v : "";
const clone = <T>(value: T): T => parseJsonPreserving(jsonDumpBytes(value)) as T;
const now = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const plain = (value: unknown): Row => isDict(value) ? value : {};
const relaunchable = (row: Row): boolean => seatIsRelaunchable(row.crew instanceof PyFloat ? { ...row, crew: row.crew.value } : row);
const truth = (value: unknown): boolean => value instanceof PyFloat ? value.value !== 0 : Array.isArray(value) ? value.length > 0
  : isDict(value) ? Object.keys(value).length > 0 : !!value;
function pythonList(value: unknown): unknown[] {
  if (!truth(value)) return [];
  if (Array.isArray(value)) return [...value];
  if (typeof value === "string") return [...value];
  if (isDict(value)) return Object.keys(value);
  throw new TypeError("launch recipe list is not iterable");
}
const indexText = (value: LaunchRecord["index"]): string => value instanceof PyInt ? value.source : String(value || 1);
export function launchHandle(record: LaunchRecord): string {
  const index = BigInt(indexText(record.index));
  if (record.tag) return index > 1n ? `${record.tag}-${index}` : record.tag;
  const prefix = `${record.base.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "agent"}/`;
  if (record.name.startsWith(prefix) && record.name.length > prefix.length) return record.name.slice(prefix.length);
  const handle = record.tag ?? record.harness;
  return index > 1n ? `${handle}-${index}` : handle;
}

/** The seats map a launch writes: only a seats map beside no `agents` key; anything else is refused untouched. */
function seatStore(doc: Row, path: string): Row {
  if ("agents" in doc) throw new TransactionError(`${oldStoreRefusalText(path, "agents_axis")}; original store retained; next: ${oldStoreAction("agents_axis")}`);
  if (!isDict(doc.seats)) throw new TransactionError(`registry '${path}' has no seats map; original store retained; next: tap doctor`);
  const refusal = teamRegistryRefusal(path, doc);
  if (refusal) throw new TransactionError(`${refusal.detail}; original store retained; next: ${refusal.action}`, undefined, refusal.errorClass);
  return doc.seats;
}
/** Read-only seat rows of another team's registry, for the duplicate-session scan. */
function seatRows(doc: Row): Row {
  return isDict(doc.seats) ? doc.seats : {};
}
function loadDoc(path: string): Row {
  if (!existsSync(path)) return {};
  const doc = parseJsonPreserving(pyReadUtf8(path));
  if (!isDict(doc)) throw new TransactionError("registry root is not an object");
  return doc;
}
function saveDoc(path: string, doc: Row): void {
  atomicWrite(path, metaBytes(supersedeForwardingAliases(doc) as Parameters<typeof metaBytes>[0]));
}
function putRow(seats: Row, handle: string, row: Row): void {
  Object.defineProperty(seats, handle, { value: row, writable: true, enumerable: true, configurable: true });
}

export function recordFromRow(handle: string, entry: Row, team: Row, root: string): LaunchRecord | null {
  if (!string(entry.session) || !HARNESSES.includes(string(entry.harness))) return null;
  const optional = (key: string) => string(entry[key]) || null;
  const index = entry.index instanceof PyInt && BigInt(entry.index.source) >= 1n ? entry.index : typeof entry.index === "number" && Number.isInteger(entry.index) && entry.index >= 1 ? entry.index : 1;
  const cwd = string(entry.registered_from_worktree) || string(team.worktree_root) || root;
  const record: LaunchRecord = {
    name: string(entry.session), harness: string(entry.harness), cwd,
    ...(entry.launch_workdir === undefined ? {} : { launch_workdir: entry.launch_workdir as string }),
    base: string(entry.base) || string(team.name) || sanitizeComponent(basename(rootForCwd(cwd))),
    tag: Object.hasOwn(entry, "tag") ? optional("tag") : handle === entry.harness ? null : handle,
    index, model: optional("model"), harness_session_id: optional("harness_session_id"), transcript_path: optional("transcript_path"),
    quarantined_harness_session_id: optional("quarantined_harness_session_id"), quarantined_transcript_path: optional("quarantined_transcript_path"),
    identity_quarantine_reason: optional("identity_quarantine_reason"), adopted_from_manual: truth(entry.adopted_from_manual),
    harness_passthrough: Array.isArray(entry.passthrough) ? entry.passthrough.filter(v => typeof v === "string") : [],
    passthrough_from_config: truth(entry.passthrough_from_config), permissions: optional("permissions") as LaunchRecord["permissions"],
    harness_env: Object.fromEntries(Object.entries(plain(entry.harness_env)).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    harness_unset_env: pythonList(entry.harness_unset_env) as string[],
    harness_tail: pythonList(entry.harness_tail) as string[],
    history: Array.isArray(entry.history) ? entry.history.filter(v => typeof v === "string") : [],
    last_launched: optional("last_launched"), last_seen: optional("last_seen"),
  };
  const preset = plain(entry.preset);
  if (isDict(entry.launch_tuning)) record.launch_tuning = clone(entry.launch_tuning) as SessionRecord["launch_tuning"];
  if (Object.keys(preset).length === 3 && ["name", "source_path", "config_digest"].every(k => string(preset[k]))) record.preset = preset as Record<string, string>;
  return record;
}

export function durableRecord(record: LaunchRecord): Row {
  const result: Row = { name: record.name, harness: record.harness, cwd: record.cwd, base: record.base, tag: record.tag ?? null,
    index: record.index ?? null, model: record.model ?? null, harness_session_id: record.harness_session_id ?? null };
  for (const key of ["last_launched", "last_seen", "transcript_path", "quarantined_harness_session_id", "quarantined_transcript_path", "identity_quarantine_reason", "permissions"] as const) {
    if (record[key]) result[key] = record[key];
  }
  if (record.adopted_from_manual) result.adopted_from_manual = true;
  if (record.launch_workdir !== undefined) result.launch_workdir = record.launch_workdir;
  if (record.passthrough_from_config) result.passthrough_from_config = true;
  for (const key of ["harness_passthrough", "harness_unset_env", "harness_tail", "history"] as const) if (record[key]?.length) result[key] = record[key];
  if (Object.keys(record.harness_env ?? {}).length) result.harness_env = record.harness_env;
  if (record.preset) result.preset = record.preset;
  if (record.launch_tuning) result.launch_tuning = clone(record.launch_tuning);
  return result;
}

export function storeRecipe(row: Row, record: LaunchRecord): void {
  record.permissions ??= "bypass";
  if (record.launch_tuning) row.launch_tuning = clone(record.launch_tuning); else delete row.launch_tuning;
  if (record.launch_workdir !== undefined) row.launch_workdir = record.launch_workdir; else delete row.launch_workdir;
  Object.assign(row, { permissions: record.permissions, session: record.name, harness: record.harness, base: record.base,
    tag: record.tag ?? null, index: record.index || 1, model: record.model ?? null, passthrough: [...record.harness_passthrough ?? []],
    adopted_from_manual: !!record.adopted_from_manual, history: [...record.history ?? []] });
  if (record.passthrough_from_config) row.passthrough_from_config = true; else delete row.passthrough_from_config;
  for (const key of ["harness_session_id", "transcript_path", "quarantined_harness_session_id", "quarantined_transcript_path", "identity_quarantine_reason", "last_launched", "last_seen"] as const) {
    if (string(record[key])) row[key] = record[key]; else delete row[key];
  }
  for (const key of ["harness_unset_env", "harness_tail"] as const) {
    if (record[key]?.length) row[key] = [...record[key]!]; else delete row[key];
  }
  for (const key of ["harness_env", "preset"] as const) {
    if (record[key] && Object.keys(record[key]).length) row[key] = { ...record[key] }; else delete row[key];
  }
}

async function registry<T>(selection: Selection, signal: AbortSignal | undefined,
  body: (doc: Row, seats: Row, lock: AsyncRegistryLock) => Promise<T>): Promise<T> {
  const lock = await acquireRegistryLockAsync(selection.registryLocation, Infinity, signal);
  if (!lock) throw new TransactionError("could not obtain registry lock");
  try {
    assertLaunchAuthority(selection, lock);
    const doc = loadDoc(selection.registryLocation);
    return await body(doc, seatStore(doc, selection.registryLocation), lock);
  } finally { await lock.release(); }
}

function assertLaunchAuthority(selection: Selection, lock: AsyncRegistryLock): void {
  const current = selectCaller({ cwd: selection.rootReal, pinnedRoot: selection.rootReal, verbClass: "lifecycle" });
  if (["rootReal", "registryLocation", "registryLocationReal", "marker", "authority"].some(key =>
      current[key as keyof Selection] !== selection[key as keyof Selection])) {
    throw new TransactionError("launch registry authority changed; original store retained; next: tap doctor");
  }
  assertSelectionCurrent(selection, lock);
}

function syncPath(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export async function writeSessionKillBackup(selection: Selection, record: LaunchRecord, original: Row | null, team: Row,
  env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
  if (/[\/\\\0]/.test(launchHandle(record))) throw new TransactionError("invalid backup handle: must be one path component");
  const root = join(selection.rootReal, ".tap", "backup", "session-kill");
  const name = `${now().replace(/[-:]/g, "")}-${launchHandle(record)}-${randomBytes(6).toString("hex")}`;
  const incomplete = join(root, `.${name}.incomplete`), bundle = join(root, name);
  const lockedRecord = original ? recordFromRow(launchHandle(record), original, team, selection.rootReal) : null;
  const launcherRecord = lockedRecord ? durableRecord(lockedRecord) : record.replacement_record ?? null;
  mkdirSync(root, { recursive: true });
  syncPath(root); syncPath(dirname(root)); syncPath(dirname(dirname(root)));
  mkdirSync(incomplete);
  const created = await launchTmux(["display-message", "-p", "-t", `=${record.replaces_session}`, "#{session_created}"], env, signal);
  const stamp = Number(created.stdout.trim());
  const createdLabel = created.code === 0 && /^\d+$/.test(created.stdout.trim())
    ? new Date(stamp * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }) : null;
  const documents: Record<string, Row> = {
    "registry-row.json": { team: clone(team), agent: original ? clone(original) : null },
    "launcher-session-record.json": { record: launcherRecord },
    "meta.json": { kind: "session_kill_backup", schema: 1, handle: launchHandle(record), team: team.name || record.base,
      session: record.replaces_session ?? null, created_at: now(), state: { registry_row: original ? "present" : "absent",
        launcher_record: launcherRecord ? "present" : "absent", restore_as_seat: original !== null } },
    "tmux-forensics.json": { session: record.replaces_session ?? null, captured_at: now(), created_label: createdLabel,
      pane_ids: await sessionPaneIds(record.replaces_session ?? "", env, signal) },
  };
  for (const [filename, doc] of Object.entries(documents)) { const path = join(incomplete, filename); saveDoc(path, doc); syncPath(path); }
  writeFileSync(join(incomplete, "COMPLETE"), "complete\n");
  syncPath(join(incomplete, "COMPLETE")); syncPath(incomplete);
  renameSync(incomplete, bundle); syncPath(root);
  return realpathSync(bundle);
}

function completeBackup(path: string | null | undefined, record: LaunchRecord, original: Row | null): boolean {
  if (!path) return false;
  try {
    if (readFileSync(join(path, "COMPLETE"), "utf8") !== "complete\n") return false;
    const meta = loadDoc(join(path, "meta.json")), saved = loadDoc(join(path, "registry-row.json"));
    return meta.kind === "session_kill_backup" && meta.handle === launchHandle(record) && meta.session === record.replaces_session &&
      jsonDumpBytes(saved.agent, undefined, true) === jsonDumpBytes(original, undefined, true) &&
      ["launcher-session-record.json", "tmux-forensics.json"].every(name => isDict(loadDoc(join(path, name))));
  } catch { return false; }
}

async function backup(selection: Selection, record: LaunchRecord, original: Row | null, team: Row,
  env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Backup> {
  if (completeBackup(record.kill_backup_path, record, original)) return { status: "backed-up", path: realpathSync(record.kill_backup_path!) };
  try {
    const path = await writeSessionKillBackup(selection, record, original, team, env, signal);
    record.kill_backup_path = path;
    record.kill_backup_has_seat_state = original !== null;
    return { status: "backed-up", path };
  } catch (error) {
    signal?.throwIfAborted();
    const detail = `backup failed for ${record.replaces_session}: ${(error as Error).message}`;
    if (record.kill_backup_required) throw new TransactionError(`${detail}; session was not killed: inspect ${selection.rootReal}/.tap/backup/session-kill and retry`);
    process.stderr.write(`tap session: WARNING: ${detail}; no durable recovery bundle is available; preserving-conversation replacement will proceed. Inspect ${selection.rootReal}/.tap/backup/session-kill permissions/free space; next: tap doctor\n`);
    return { status: "unavailable", detail };
  }
}

async function namespace(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Set<string> | null> {
  const result = await launchTmux(["list-sessions", "-F", "#S"], env, signal);
  return result.code === 0 ? new Set(result.stdout.split("\n").filter(Boolean)) : null;
}

export async function reserveTransaction(selection: Selection, request: TransactionRequest, evidence: FailureEvidence, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<FailureEvidence> {
  const record = request.record, handle = launchHandle(record);
  if (reservedSeatName(handle)) throw new TransactionError(`handle '${handle}' ${reservedSeatName(handle)} and cannot name a seat; choose another --tag`);
  const live = request.live_sessions === undefined ? await namespace(env, signal) : request.live_sessions === null ? null : new Set(request.live_sessions);
  return registry(selection, signal, async (doc, seats) => {
    if (doc.team === undefined) doc.team = {};
    if (!isDict(doc.team)) throw new TransactionError("registry team is not an object");
    const team = doc.team;
    team.name ??= record.base; team.worktree_root ??= selection.rootReal;
    const existing = Object.hasOwn(seats, handle) && isDict(seats[handle]) ? seats[handle] as Row : null;
    if (request.approved_instance && (!existing || existing.instance !== request.approved_instance)) {
      throw new TransactionError(`tap team up: '${handle}' was replaced after interactive selection; nothing resumed`);
    }
    if (request.kind === "seat-up") {
      if (request.expected_registry !== selection.registryLocationReal || request.expected_team !== selection.team ||
          jsonDumpBytes(existing, undefined, true) !== jsonDumpBytes(request.expected_row, undefined, true)) {
        throw new TransactionError("tap up: retained seat changed before resume");
      }
      if (!existing || !relaunchable(existing)) throw new TransactionError("tap up: retained seat changed before resume");
      if (await hasSession(record.name, env, signal)) throw new TransactionError("tap up: session appeared before resume; no replacement performed");
      assertUniqueResume(record, selection, doc);
    }
    const status = existing?.status ?? "active";
    const same = ["resume", "resume-all", "seat-up"].includes(request.kind) || (request.kind === "restart" && !request.incumbent_live);
    let displaced: Row | null = null;
    if (existing && ["active", "pending", "suspended"].includes(String(status)) &&
        !reservationExpired(existing, live, Date.now() / 1000, bootId(env) || null, legacyBootId(env) || null)) {
      const verified = record.kill_backup_required ? null : await verifiedSession(existing, env, signal);
      const replacing = !!record.replaces_session && (record.kill_backup_required ||
        (["active", "suspended"].includes(String(status)) && await destructiveTarget(existing, record.replaces_session, env, signal) === record.replaces_session));
      const reclaiming = same && ["active", "suspended", "pending"].includes(String(status)) && existing.session === record.name &&
        (verified === null || verified === record.name) && (status !== "pending" || !existing.launch_id);
      const dead = ["active", "suspended"].includes(String(status)) && verified === null && await entryObservedDead(existing, env, signal);
      if (!(replacing || reclaiming || dead)) throw new TransactionError(`${handle} is already claimed`);
      displaced = clone(existing);
    }
    let preserved: Backup = { status: "not-needed" };
    if (record.kill_backup_required || (record.replaces_session && await hasSession(record.replaces_session, env, signal))) {
      preserved = await backup(selection, record, existing, team, env, signal);
    }
    record.launch_id = randomUUID();
    record.replacement_registry_entry = displaced;
    record.identity_capture_action = request.kind === "new" ? record.ensure_action ?? "new" : "resume";
    const retained = displaced ?? (same && existing?.session === record.name ? existing : null);
    const row = clone(retained ?? {});
    if (row.harness && row.harness !== record.harness) { delete row.harness_session_id; delete row.transcript_path; }
    storeRecipe(row, record);
    Object.assign(row, { status: "pending", registered_from_worktree: request.kind === "seat-up" ? record.cwd : selection.rootReal,
      registered_at: now(), launch_id: record.launch_id });
    // A fork is a new conversation: its id is the launcher's minted one (claude) or the harness's own.
    row.identity_capture = { mode: record.identity_capture_action === "new" || record.identity_capture_action === "fork" ? "launcher_new" : record.harness_session_id ? "exact_resume"
      // Id-less OpenCode and cursor resumes start a fresh conversation (neither opens a
      // picker), so the SessionStart id they report is the launcher's new identity.
      : record.harness === "opencode" || record.harness === "cursor" ? "launcher_new" : "untrusted_resume",
      ...(record.harness_session_id ? { expected_harness_session_id: record.harness_session_id } : {}) };
    // A new incarnation starts: the outgoing one's launch_witness never carries over.
    for (const field of ["pane", "pane_id", "pane_current_command", "wake_url", "status_reason", "exited_at", "launch_witness"]) delete row[field];
    const boot = bootId(env); if (boot) row.boot_id = boot;
    const instance = ensureSeatInstance(row, handle);
    Object.assign(evidence, { token: record.launch_id, instance, backup: preserved });
    putRow(seats, handle, row); saveDoc(selection.registryLocation, doc);
    return evidence;
  });
}

/** The transaction's one resume binding, decided BEFORE any reservation, stop
 * or registry effect (tap-we6b). Every resume-family kind — resume,
 * resume-all (tap team up), restart and seat-up — resolves a cursor identity
 * here exactly once: a stored chat id whose conversation store never appeared
 * refuses, and the answer is bound so a store that disappears later cannot
 * turn the launch into a silent fresh start. Seat-up keeps its raw stored id
 * for other harnesses; the rest keep the adapter's own resolver. */
export function resumeIdentityBinding(kind: TransactionRequest["kind"], record: LaunchRecord, env: NodeJS.ProcessEnv): ResumeIdentity {
  if (!["resume", "resume-all", "restart", "seat-up"].includes(kind)) return UNBOUND_RESUME_IDENTITY;
  if (record.harness === "cursor") {
    if (record.harness_session_id && !recordHasResumeArtifact(record, env)) {
      throw new TransactionError(
        `${record.name} (cursor) has stored chat id ${record.harness_session_id} but no persisted conversation store; resume refuses rather than silently start a different conversation`,
        undefined, "no_exact_resume_identity", `tap session launch cursor ${launchHandle(record)} --fresh`,
      );
    }
    return record.harness_session_id ?? null;
  }
  // tap-dt6kf: OpenCode exits "Session not found" on an id its store lacks. A
  // readable store without the id refuses; the row is not touched (a restored
  // store makes the id resumable again) and no other id is nominated. Any
  // store that cannot answer (missing, locked, unexpected schema) proceeds:
  // OpenCode stays the authority and refuses without opening another session.
  // The probe reads the store the seat's child will open: its policy, harness_env
  // and unsets can move HOME or XDG_DATA_HOME, and OpenCode ignores TAP's
  // OPENCODE_DB_PATH reader pin. A refused or degraded policy cannot answer.
  const seatEnv = record.harness === "opencode" && record.harness_session_id ? seatHarnessEnv(record, env) : null;
  if (seatEnv) delete seatEnv.OPENCODE_DB_PATH;
  if (seatEnv && opencodeStoredSession(record.harness_session_id!, seatEnv) === "absent") {
    throw new TransactionError(
      `${record.name} (opencode) has stored session id ${record.harness_session_id} but OpenCode's store at ${opencodeStorePath(seatEnv)} has no such session; resume refuses rather than start a harness that exits with "Session not found"`,
      undefined, "no_exact_resume_identity", `tap session launch opencode ${launchHandle(record)} --fresh`,
    );
  }
  return kind === "seat-up" ? record.harness_session_id ?? null : UNBOUND_RESUME_IDENTITY;
}

/** A revival beside crews resumes exactly the recorded conversation, bound before any effect so no
 * later resolution can turn it into a fallback id, a picker or a fresh start (tap-9rrat). */
/** "<server pid>:<start>\t$<session id>" for the named session, or "" when tmux cannot say. */
export async function survivingSession(name: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
  const run = await launchTmux(["display-message", "-p", "-t", `=${name}:`, "#{pid}:#{start_time}\t#{session_id}"], env, signal);
  const value = run.code === 0 ? run.stdout.trim() : "";
  return /^\d+:\d+\t\$\d+$/.test(value) ? value : "";
}

export function exactRevivalIdentity(record: LaunchRecord, env: NodeJS.ProcessEnv): string {
  const stored = record.harness_session_id ?? null;
  // hermes ignores resume ids, so it cannot bind an exact target.
  if (!stored || !["claude", "codex", "opencode", "cursor", "agy"].includes(record.harness)) refuseRevival(record);
  // The ordinary resume gate first: cursor's chat store and OpenCode's session store refuse a missing id.
  resumeIdentityBinding("resume", record, env);
  if (resolvedResumeIdentity(record, env) !== stored) refuseRevival(record);
  return stored!;
}
function refuseRevival(record: LaunchRecord): never {
  throw new TransactionError(`${record.name} has no resumable recorded ${record.harness} conversation; nothing was revived and its other windows keep running`,
    undefined, "no_exact_resume_identity", `tmux attach -t ${shlexQuote(record.name)}`);
}

function assertUniqueResume(record: LaunchRecord, selection: Selection, local: Row): void {
  if (!record.harness_session_id) return;
  const check = (doc: Row, root: string, team: string) => {
    for (const [handle, row] of Object.entries(seatRows(doc))) {
      if (!isDict(row) || row.harness !== record.harness || row.harness_session_id !== record.harness_session_id) continue;
      if (root === selection.rootReal && handle === launchHandle(record)) continue;
      throw new TransactionError(`tap up: refusing resume for expected seat ${launchHandle(record)}: native ${record.harness} session id ${record.harness_session_id} already belongs to expected seat ${team}/${handle}`);
    }
  };
  check(local, selection.rootReal, selection.team);
  // Every enrolled team's acting registry, from the global registry (never ~/.tap/teams.json).
  const seen = new Set([selection.registryLocationReal]);
  for (const { team: name, root, registryLocation } of enrolledTeams()) {
    if (!root) continue;
    let canonical: string, doc: Row;
    try { canonical = realpathSync(registryLocation); if (seen.has(canonical)) continue; doc = loadDoc(registryLocation); } catch { continue; }
    seen.add(canonical);
    // An old-format registry cannot prove the id is unowned: refuse, never "no owner".
    const refusal = teamRegistryRefusal(registryLocation, doc);
    if (refusal) throw new TransactionError(`${refusal.detail}; next: ${refusal.action}`, undefined, refusal.errorClass);
    check(doc, rootForCwd(root), string(plain(doc.team).name) || name);
  }
}

export async function seatUpTransaction(argv: string[], env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<TransactionResult> {
  if (argv.length !== 5) throw new TransactionError("invalid internal seat-up invocation");
  const [root, team, handle, raw, registryPath] = argv as [string, string, string, string, string];
  let expected: unknown;
  try { expected = parseJsonPreserving(raw); } catch { throw new TransactionError("invalid expected retained row"); }
  if (!isDict(expected) || !relaunchable(expected)) throw new TransactionError("tap up: seat is not retained for resume");
  if (realpathSync(process.cwd()) !== root || rootForCwd(root) !== root) throw new TransactionError("tap up: selected worktree changed");
  const selection = selectCaller({ cwd: root, pinnedRoot: root, env, verbClass: "lifecycle" });
  if (selection.team !== team || selection.registryLocationReal !== registryPath) throw new TransactionError("tap up: selected team changed");
  return resumeSelectedSeat(selection, handle, expected, env, signal);
}

/** The retained record a seat-up launches, after the refusals that need no launch machinery. */
function seatUpRecord(selection: Selection, handle: string, expected: Row): LaunchRecord {
  if (!relaunchable(expected)) throw new TransactionError("tap up: seat is not retained for resume");
  const record = recordFromRow(handle, expected, { name: selection.team, worktree_root: selection.rootReal }, selection.rootReal);
  if (!record || rootForCwd(record.cwd) !== selection.rootReal) throw new TransactionError("tap up: retained launch record is invalid");
  record.tag = handle; record.index = 1;
  if (!record.harness_session_id || record.harness === "hermes") throw new TransactionError("tap up: exact native resume identity is unavailable");
  return record;
}

export async function resumeSelectedSeat(selection: Selection, handle: string, expected: Row,
  env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal, scriptDir?: string): Promise<TransactionResult> {
  const record = seatUpRecord(selection, handle, expected);
  return launchTransaction({ kind: "seat-up", record, root: selection.rootReal, expected_row: expected,
    expected_team: selection.team, expected_registry: selection.registryLocationReal, script_dir: scriptDir }, env, signal);
}

/** The dry run of resumeSelectedSeat: the launch transaction's own read-only validation (launch
 * workdir, recipe, resume identity and invocation), stopping before any effect, then the native
 * identity's uniqueness across the enrolled registries. A preview therefore refuses exactly where
 * the real run does, with the same class and recovery. `registry` is the caller's already-locked document. */
export async function validateSeatUp(selection: Selection, handle: string, expected: Row, registry: Row,
  env: NodeJS.ProcessEnv = process.env, scriptDir?: string): Promise<void> {
  const record = seatUpRecord(selection, handle, expected);
  await launchTransaction({ kind: "seat-up", record, root: selection.rootReal, expected_row: expected, dry_run: true, validate_only: true,
    expected_team: selection.team, expected_registry: selection.registryLocationReal, script_dir: scriptDir }, env);
  assertUniqueResume(record, selection, registry);
}

const VESSEL_FORMAT = "#{pid}:#{start_time}\t#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_pid}\t#{socket_path}";
export function parseVessel(raw: string): Vessel | null {
  const [server, session, window, pane, pid, socket, ...extra] = raw.trim().split("\t");
  if (extra.length || !/^\d+:\d+$/.test(server ?? "") || !/^\$\d+$/.test(session ?? "") ||
      !/^@\d+$/.test(window ?? "") || !/^%\d+$/.test(pane ?? "") || !/^-?\d+$/.test(pid ?? "") || !socket?.startsWith("/")) return null;
  return { server: server!, session: session!, window: window!, pane: pane!, socket };
}
const sameVessel = (a: Vessel, b: Vessel | null): boolean => !!b && Object.keys(a).every(key => a[key as keyof Vessel] === b[key as keyof Vessel]);

export function vesselPredicate(vessel: Vessel): string {
  const terms = [["#{pid}:#{start_time}", vessel.server], ["#{session_id}", vessel.session], ["#{window_id}", vessel.window], ["#{pane_id}", vessel.pane]];
  return terms.map(([format, value]) => `#{==:${format},${value}}`).reduce((a, b) => `#{&&:${a},${b}}`);
}

async function ownedEffect(vessel: Vessel, command: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<boolean> {
  // -F is essential: a shell test would separate authorization from the effect.
  const run = await launchCommand(["tmux", "-S", vessel.socket, "if-shell", "-F", "-t", vessel.pane, vesselPredicate(vessel),
    command.map(shlexQuote).join(" "), "display-message -p TAP_LAUNCH_IDENTITY_MOVED"], { env, signal });
  if (run.code !== 0) {
    if (/no server running|no sessions|can't find pane|error connecting.*No such file/.test(run.stderr)) return false;
    throw new LaunchCommandError(["tmux", ...command], run);
  }
  return run.stdout.trim() !== "TAP_LAUNCH_IDENTITY_MOVED";
}

function owns(row: unknown, evidence: FailureEvidence): row is Row {
  return isDict(row) && row.launch_id === evidence.token && (string(row.instance) || null) === evidence.instance &&
    row.session === evidence.record.name && row.harness === evidence.record.harness;
}

export async function rollbackOwned(evidence: FailureEvidence, reason: string | null, env: NodeJS.ProcessEnv,
  cleanup: boolean, captureFailure: false | "callback" = false): Promise<boolean> {
  return registry(evidence.selection, undefined, async (doc, seats) => {
    const row = seats[evidence.handle];
    if (!owns(row, evidence)) return false;
    // A pending claim may fail before bind. Once bound, it must still name the
    // same created pane/server; no delayed callback borrows a stranger's binding.
    if (evidence.vessel && row.pane_id && (row.pane_id !== evidence.vessel.pane ||
        row.server_epoch && row.server_epoch !== `srv:${evidence.vessel.server}`)) return false;
    if (captureFailure && evidence.vessel) {
      const v = evidence.vessel;
      try {
        const command = ["display-message", "-p", "-t", v.pane, "#{pane_dead_status}"].map(shlexQuote).join(" ") + " ; " +
          ["capture-pane", "-p", "-S", "-", "-t", v.pane].map(shlexQuote).join(" ");
        const captured = await launchCommand(["tmux", "-S", v.socket, "if-shell", "-F", "-t", v.pane, vesselPredicate(v),
          command, "display-message -p TAP_LAUNCH_IDENTITY_MOVED"], { env });
        const tail = captured.stdout.trim();
        if (captured.code === 0 && tail !== "TAP_LAUNCH_IDENTITY_MOVED") {
          if (captureFailure === "callback") {
            const [status, ...screen] = captured.stdout.split("\n");
            const code = /^-?\d+$/.test(status?.trim() ?? "") ? Number(status) || 1 : 1;
            const lines = screen.map(line => line.trimEnd()).filter(line => line.trim()).slice(-20);
            const message = [`launch failed: exit ${code}`, ...lines].join("\n") + "\n";
            startupTrace("seat_exit", { session: evidence.record.name, harness: evidence.record.harness, exit_code: code, launch_id: evidence.token });
            try {
              if (evidence.output_path) writeFileSync(evidence.output_path, message);
              else process.stderr.write(message);
            } catch { process.stderr.write(message); }
          }
        }
      } catch { /* Diagnostics never replace the transaction failure. */ }
    }
    const before = clone(row);
    let restored: Row | null = null;
    if (evidence.record.replacement_registry_entry) {
      restored = clone(evidence.record.replacement_registry_entry);
      if (reason) { restored.status = "suspended"; restored.status_reason = reason; }
      putRow(seats, evidence.handle, restored);
    } else delete seats[evidence.handle];
    saveDoc(evidence.selection.registryLocation, doc);
    startupTransition(evidence.selection.registryLocation, evidence.handle, before, restored,
      restored !== null && seatIsRelaunchable(restored));
    // This critical section stays held through the server-side effect. Our own
    // rollback changed the token, so a second token check here would be wrong.
    if (cleanup && evidence.vessel) {
      // A revived seat's window is all it owns: its session still holds the crews.
      const cleaned = await ownedEffect(evidence.vessel, evidence.record.revive_vessel === "window"
        ? ["kill-window", "-t", evidence.vessel.window] : ["kill-session", "-t", evidence.vessel.session], env);
      if (!cleaned) process.stderr.write(`tap session: cleanup retained residue for ${evidence.record.name}; created vessel identity changed or is gone\n`);
    }
    // No exit-hook/registration observation while their registry lock is held.
    return true;
  });
}

async function recoveryError(evidence: FailureEvidence, error: unknown): Promise<TransactionError> {
  const { selection: s, backup: b } = evidence;
  const location = b.status === "backed-up" ? `complete recovery bundle ${b.path}` : "no durable recovery bundle is available";
  let verified = false;
  if (b.status === "backed-up") {
    const lock = await acquireRegistryLockAsync(s.registryLocation, 0);
    if (lock) try {
      assertLaunchAuthority(s, lock);
      verified = completeBackup(b.path, { ...evidence.record, replaces_session: evidence.record.replaces_session ?? evidence.record.name }, evidence.record.replacement_registry_entry ?? null);
    } catch { /* Recovery advice cannot guess an authority after drift. */ }
    finally { await lock?.release(); }
  }
  const restore = verified && b.status === "backed-up" ? `; tap restore ${shlexQuote(evidence.handle)} --archive ${shlexQuote(b.path)}; tap session resume ${shlexQuote(evidence.handle)}` : "";
  return new TransactionError(`rollback incomplete for stopped session ${evidence.record.name}; original team ${s.team}, root ${s.rootReal}, registry ${s.registryLocation}; ${location}; next: cd ${shlexQuote(s.rootReal)} && tap doctor${restore}; ${(error as Error).message}`,
    { selection: s, backup: b, session: evidence.record.name });
}

/** tap-zk1w: the typed refusal for a pane row whose generation cannot be stamped. */
function generationUnverifiable(): TransactionError {
  return new TransactionError("the tmux server generation is not observable, so the seat row could not be stamped; nothing was written",
    undefined, "generation_unverifiable", "wait for tmux to answer, then retry");
}

async function stampPane(row: Row, facts: PaneFacts, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  if (!/^%\d+$/.test(facts.pane_id)) throw new TransactionError(`identity_unverified: tmux returned invalid pane_id '${facts.pane_id}'; refusing registry write; next: verify tmux and retry`);
  const epoch = await currentEpoch(env, signal);
  if (facts.server_epoch && epoch && facts.server_epoch !== epoch) throw new TransactionError("tmux server generation moved between observing the pane and recording it; re-observe and retry");
  // tap-zk1w: bindTransaction refuses an unobservable generation first; this
  // writer still refuses rather than ever publishing an unstamped pane row.
  if (!facts.server_epoch) throw generationUnverifiable();
  row.server_epoch = facts.server_epoch;
  const socket = await launchTmux(["display-message", "-p", "#{pid}:#{start_time}\t#{socket_path}"], env, signal);
  const [raw, path] = socket.stdout.trim().split("\t");
  if (socket.code === 0 && raw && path?.startsWith("/") && `srv:${raw}` === facts.server_epoch) row.server_socket = path;
  else delete row.server_socket;
  const boot = bootId(env); if (boot) row.boot_id = boot; else delete row.boot_id;
}

export async function bindTransaction(evidence: FailureEvidence, facts: PaneFacts, ready: boolean, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  if (!/^%\d+$/.test(facts.pane_id)) throw new TransactionError("invalid pane_id at registry boundary");
  // tap-zk1w: refuse before the registry lock and the enrollment refusal, which
  // may purge a gone enrollment.
  if (!facts.server_epoch) throw generationUnverifiable();
  await registry(evidence.selection, signal, async (doc, seats) => {
    const row = seats[evidence.handle];
    const already = ready && isDict(row) && row.status === "active" && (row.status_reason ?? "") === "" &&
      row.session === evidence.record.name && row.harness === evidence.record.harness && row.pane === facts.pane &&
      row.pane_id === facts.pane_id && !row.launch_id && (string(row.instance) || null) === evidence.instance &&
      // tap-zk1w: only a row already stamped with this generation is current;
      // an unstamped one falls through to stampPane, which stamps or refuses.
      !!facts.server_epoch && row.server_epoch === facts.server_epoch;
    if (!already && (!owns(row, evidence) || (ready ? row.status !== "active" || row.status_reason !== "launching" || row.pane_id !== facts.pane_id : row.status !== "pending"))) {
      throw new TransactionError(`${ready ? "bound launch" : "launch reservation"} lost for ${evidence.handle}`);
    }
    if (evidence.vessel) {
      const current = await launchCommand(["tmux", "-S", evidence.vessel.socket, "display-message", "-p", "-t", evidence.vessel.pane, VESSEL_FORMAT], { env, signal });
      if (!sameVessel(evidence.vessel, parseVessel(current.stdout))) throw new TransactionError("pane identity changed before registry write");
      if (ready) {
        const observed = await paneFacts(evidence.vessel.pane, env, signal);
        if (!observed || observed.dead || paneHarness(observed, env) !== evidence.record.harness) {
          throw new TransactionError(`harness is not running for ${evidence.handle}`);
        }
      }
    }
    if (already) return;
    const socket = await launchTmux(["display-message", "-p", "#{pid}:#{start_time}\t#{socket_path}"], env, signal);
    const [rawEpoch, socketPath] = socket.stdout.trim().split("\t");
    const enrollment = paneEnrollmentRefusal({ paneId: facts.pane_id, epoch: facts.server_epoch,
      socket: socket.code === 0 && `srv:${rawEpoch}` === facts.server_epoch ? socketPath ?? "" : "" },
      evidence.selection.rootReal, env.TAP_INDEX_HOME);
    if (enrollment) throw new TransactionError(enrollment.detail, undefined, enrollment.errorClass, enrollment.action);
    Object.assign(row, { delivery: "pane", permissions: evidence.record.permissions || "bypass", status: "active",
      status_reason: ready ? "" : "launching", harness: evidence.record.harness, session: evidence.record.name,
      pane: facts.pane, pane_id: facts.pane_id, pane_current_command: facts.command,
      registered_from_worktree: evidence.selection.rootReal, registered_at: now() });
    if (evidence.record.launch_tuning) row.launch_tuning = clone(evidence.record.launch_tuning);
    await stampPane(row, facts, env, signal);
    delete row.wake_url;
    // Verified: the pending launch_id becomes the incarnation's launch_witness.
    if (ready) { row.launch_witness = row.launch_id; delete row.launch_id; }
    saveDoc(evidence.selection.registryLocation, doc);
  });
}

type StopState = { attempted: boolean; killed: boolean; uncertain: boolean; adoptedShell: boolean };
export async function suspendAndStop(evidence: FailureEvidence, request: TransactionRequest, state: StopState,
  env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  const record = evidence.record;
  const resume = request.kind === "resume";
  const session = request.kind === "restart" || resume ? record.name : record.replaces_session;
  if (!session || (resume && !await hasSession(session, env, signal))) return;
  await registry(evidence.selection, signal, async (doc, seats) => {
    const keeper = seats[evidence.handle];
    if (!owns(keeper, evidence) || keeper.status !== "pending") throw new TransactionError(`replacement reservation changed before teardown for ${evidence.handle}; retry the launch`);
    if (resume) {
      const classification = await classifySession(session, env, signal, { harness: record.harness, crewPanes: crewPanesIn(Object.entries(seats), session) });
      // The seat's harness exited but its crews hold the session: revive beside them, stop nothing.
      // Only a caller that preflighted the revival (exact id, crew snapshot) may take that path.
      if (classification === "seat-gone") {
        if (record.revive_vessel !== "window") throw new TransactionError(`${session}'s seat exited while the resume was starting; nothing was changed; retry the resume`);
        // The revival targets the session generation its caller preflighted, never a later one under the same name.
        if (!record.revive_session || await survivingSession(session, env, signal) !== record.revive_session) {
          throw new TransactionError(`session ${session} changed after the resume checked it; nothing was changed; retry the resume`);
        }
        return;
      }
      record.revive_vessel = null;
      if (classification !== "shell") throw new TransactionError(`refusing to adopt ${session}: it is ${classification}, not a bare shell session; attach once it is live, or replace it with tap session restart --force`);
    }
    launchPhase(`Stopping ${session} for replacement`, true);
    const original = record.replacement_registry_entry ?? null;
    if (request.kind === "new" && !record.kill_backup_required && original && string(original.pane_id)) {
      if (await destructiveTarget(original, session, env, signal) !== session &&
          (await hasSession(session, env, signal) || !await entryObservedDead(original, env, signal))) {
        throw new TransactionError(`cannot verify registered pane identity for ${evidence.handle}: cannot prove it belongs to the current tmux server; re-register the seat or run tap team refresh, then retry`);
      }
    }
    if (record.ensure_vessel === "shell" && await hasSession(session, env, signal) && await classifySession(session, env, signal) !== "shell") {
      throw new TransactionError(`refusing to absorb ${session}: state changed mid-ensure; re-run to re-evaluate`);
    }
    const live = request.kind === "restart" ? request.incumbent_live === true : await hasSession(session, env, signal);
    if (live && evidence.backup.status === "not-needed") {
      const backupRecord = { ...record, replaces_session: session };
      evidence.backup = await backup(evidence.selection, backupRecord, original, plain(doc.team), env, signal);
      record.kill_backup_path = backupRecord.kill_backup_path;
    }
    const displaced = new Map<string, Row>();
    const reason = request.kind === "restart" ? "session_restarted" : "session_replaced";
    if (!resume) for (const [handle, value] of Object.entries(seats)) {
      if (handle !== evidence.handle && isDict(value) && value.delivery !== "poll" &&
          ["active", "pending"].includes(String(value.status ?? "active")) && await entrySession(value, env, signal) === session) {
        displaced.set(handle, clone(value)); value.status = "suspended"; value.status_reason = reason;
      }
    }
    if (displaced.size) saveDoc(evidence.selection.registryLocation, doc);
    try {
      if (live) {
        state.attempted = true;
        const run = await launchTmux(["kill-session", "-t", `=${session}`], env, signal);
        if (run.code !== 0) {
          if (signal?.aborted) {
            const after = await launchTmux(["list-sessions", "-F", "#S"], env);
            if (after.code === 0) state.killed = !after.stdout.split("\n").includes(session);
            else if (/no server running|no sessions|No such file/.test(after.stderr)) state.killed = true;
            else state.uncertain = true;
          }
          throw new LaunchCommandError(["tmux", "kill-session", "-t", `=${session}`], run);
        }
        state.killed = true;
        state.adoptedShell = resume;
        if (request.kind === "new") appendRegistryEvent({ log: join(evidence.selection.busHome, "registry-events.log"),
          actor: "session-launch", action: "killed", handle: evidence.handle, pane: session, team: evidence.selection.team,
          detail: "replaces_session", env });
      }
      if (request.kind === "new" && evidence.backup.status === "backed-up") {
        const outcome = state.killed ? `killed ${session}` : `${session} was already absent`;
        process.stdout.write(record.kill_backup_has_seat_state
          ? `tap session: ${outcome}; backup: ${evidence.backup.path}; restore: tap restore ${evidence.handle} --archive ${evidence.backup.path}\n`
          : `tap session: ${outcome}; no seat state existed, so restore as a seat is unavailable; forensic backup: ${evidence.backup.path}\n`);
      }
    } catch (error) {
      if (!state.killed && !state.uncertain && displaced.size) {
        for (const [handle, originalRow] of displaced) putRow(seats, handle, originalRow);
        saveDoc(evidence.selection.registryLocation, doc);
      }
      throw error;
    }
  });
}

async function fenceBarrier(stage: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  const base = env.TAP_RESET_FENCE_TEST_BARRIER;
  if (!base || !env.TAP_SCRATCH_ONLY) return;
  writeFileSync(`${base}.${stage}.reached`, "1\n");
  const deadline = performance.now() + 60_000;
  while (!existsSync(`${base}.${stage}.release`)) {
    signal?.throwIfAborted();
    if (performance.now() >= deadline) throw new TransactionError(`reset fence test barrier timed out at ${stage}`);
    await Bun.sleep(50);
  }
}
function assertReset(selection: Selection, operation: string, env: NodeJS.ProcessEnv, underLock = false): void {
  const path = join(selection.busHome, "reset.fence.json");
  if (!existsSync(path) || !statSync(path).isFile()) return;
  if (underLock) {
    try {
      const record = loadDoc(path);
      if (record.pid === process.pid || (env.TAP_RESET_FENCE_TOKEN && record.token === env.TAP_RESET_FENCE_TOKEN)) return;
    } catch { /* Unreadable fence cannot authorize a writer. */ }
  }
  throw new TransactionError(launcherFenceRefusal(path, operation));
}

export async function respawnInitialPane(evidence: FailureEvidence, command: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  const vessel = evidence.vessel!;
  startupTrace("respawn_pane", { session: evidence.record.name, pane: vessel.pane });
  try {
    if (!await ownedEffect(vessel, ["respawn-pane", "-k", "-t", vessel.pane, "-c", launchWorkdir(evidence.record), command], env, signal)) {
      throw new TransactionError("creation identity changed before respawn");
    }
  } catch (error) {
    if (!(error instanceof LaunchCommandError) || error.result.code !== 1 ||
        error.result.stderr.trim() !== "respawn pane failed: fork failed: Device not configured") throw error;
    const after = await launchTmux(["display-message", "-p", "-t", vessel.pane, VESSEL_FORMAT], env, signal);
    if (!sameVessel(vessel, parseVessel(after.stdout)) || after.stdout.trim().split("\t")[4] !== "-1") throw error;
    process.stderr.write(`tap session: fork refused for ${evidence.record.name}; retrying once in 1s\n`);
    await Bun.sleep(1000); signal?.throwIfAborted();
    const predicate = `#{&&:${vesselPredicate(vessel)},#{==:#{pane_pid},-1}}`;
    const retry = await launchCommand(["tmux", "-S", vessel.socket, "if-shell", "-F", "-t", vessel.pane, predicate,
      ["respawn-pane", "-t", vessel.pane, "-c", launchWorkdir(evidence.record), command].map(shlexQuote).join(" "), "display-message -p TAP_LAUNCH_IDENTITY_MOVED"], { env, signal });
    if (retry.code) throw new LaunchCommandError(["tmux", "respawn-pane"], retry);
    if (retry.stdout.includes("TAP_LAUNCH_IDENTITY_MOVED")) throw new TransactionError("respawn ownership changed; no further effect");
  }
}

async function reportRespawnResidue(evidence: FailureEvidence, error: Error, rollback: boolean, env: NodeJS.ProcessEnv): Promise<void> {
  let rowState = "unknown", ptys = "unknown", limit = "unknown", load = "unknown";
  try { rowState = Object.hasOwn(seatRows(loadDoc(evidence.selection.registryLocation)), evidence.handle) ? "present" : "absent"; } catch { /* diagnostic only */ }
  try { load = loadavg()[0]!.toFixed(2); } catch { /* unavailable */ }
  try {
    if (process.platform === "darwin") {
      ptys = String(readdirSync("/dev").filter(name => name.startsWith("ttys")).length);
      const result = await launchCommand(["sysctl", "-n", "kern.tty.ptmx_max"], {env, timeoutMs: 2000});
      if (result.code === 0 && /^\d+$/.test(result.stdout.trim())) limit = result.stdout.trim();
    } else if (process.platform === "linux") {
      ptys = String(readdirSync("/dev/pts").filter(name => /^\d+$/.test(name)).length);
      limit = readFileSync("/proc/sys/kernel/pty/max", "utf8").trim();
    }
  } catch { /* unavailable measurements remain unknown */ }
  const cleanup = rollback ? "owned rollback completed" : "retained or unknown; ownership/cleanup unverified";
  startupTrace("respawn_failure", {session: evidence.record.name, phase: "respawn_pane", cleanup, load1m: load, pty_devices: ptys, pty_limit: limit});
  process.stderr.write(`tap session: respawn failed: ${error.message}; session/window=${evidence.record.name}:0 (${cleanup}); registry row ${evidence.handle}=${rowState} at ${evidence.selection.registryLocation}; inspect: tap session list\n`);
  if (!rollback) process.stderr.write(`tap session: cleanup unavailable without current claim and vessel ownership; inspect original root ${evidence.selection.rootReal}; next: tap doctor\n`);
  process.stderr.write(`tap session: load1m=${load} cores=${cpus().length || "unknown"} pty-devices=${ptys} pty-limit=${limit}\n`);
}

const HARNESS_START_TIMEOUT_MS = 5000;
const SHELL_COMMANDS = new Set(["zsh", "-zsh", "bash", "-bash", "sh", "dash", "ksh", "ash", "fish"]);

/** Readiness failed: name what the pane was running and what it showed, best-effort, before the caller rolls it back. */
async function harnessStartFailure(evidence: FailureEvidence, reason: string | null, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<TransactionError> {
  const record = evidence.record;
  let facts: PaneFacts | null = null;
  try { facts = await paneFacts(evidence.vessel!.pane, env, signal, true, 2000); }
  catch (error) { if (signal?.aborted) throw error; }
  let heading: string, hint = "";
  if (reason) heading = `harness did not start for ${record.name}: ${reason}`;
  else if (!facts) return new TransactionError(`harness did not start for ${record.name}`);
  else if (facts.dead) heading = `harness did not start for ${record.name}: ${record.harness} exited during startup`;
  else if (SHELL_COMMANDS.has(facts.command) || facts.command === basename(resolveLoginShell(env))) {
    heading = `harness did not start for ${record.name}: the login shell (${facts.command}) had not started ${record.harness} after ${HARNESS_START_TIMEOUT_MS} ms; it may be waiting for input`;
    hint = `next: answer the login-shell prompt in a terminal with ${shlexQuote(resolveLoginShell(env))} -lic exit, then retry the launch`;
  } else heading = `harness did not start for ${record.name}: the pane is running ${facts.command}, not ${record.harness}`;
  const tail = facts ? await paneTailLines(facts, env, signal) : null;
  if (tail === null) return new TransactionError(hint ? `${heading}\n${hint}` : heading);
  const shown = tail.length ? [`pane ${facts!.pane_id} shows:`, ...tail.map(line => `  ${line}`)] : [`pane ${facts!.pane_id} shows no output`];
  return new TransactionError([heading, ...shown, ...(hint ? [hint] : [])].join("\n"));
}

/** Fields the SessionStart bind rewrites while the launcher owns the start.
 * registered_at is the only unconditional rewrite, so a row cloned at
 * reservation — which already carries the old ids — still changes fingerprint. */
export function bindFingerprintOf(row: Row): string {
  // `pane_current_command` closes the exact-resume collision: `registered_at`
  // is whole-second, and a resumed row can already carry the expected session
  // id, capture result and transcript — but the placeholder pane ran the
  // launch shell and the bound pane runs the harness, so the command the
  // SessionStart bind rewrites is the byte that has to move. Residual
  // collision (identical commands on both panes, same second) falls back to
  // the full window: it costs time, never safety.
  return JSON.stringify([row.registered_at ?? null, row.harness_session_id ?? null, row.identity_capture_result ?? null, row.transcript_path ?? null, row.pane_current_command ?? null]);
}

/** The Claude readiness signal: this launch's SessionStart bind has landed.
 * Lockless and read-only — the hook's `tap in` needs the registry lock to write
 * the very row this polls, so a locked read would starve the signal. A read or
 * parse failure means "no signal yet" and is never a readiness failure. */
export function claudeBindSignal(evidence: FailureEvidence, snapshot: string): (facts: PaneFacts) => Promise<boolean> {
  let lastPoll = -Infinity;
  return async () => {
    if (performance.now() - lastPoll < 250) return false;
    lastPoll = performance.now();
    try {
      const row = seatRows(loadDoc(evidence.selection.registryLocation))[evidence.handle];
      if (!isDict(row) || row.launch_id !== evidence.token || typeof row.harness_session_id !== "string" || row.harness_session_id === "") return false;
      return bindFingerprintOf(row) !== snapshot;
    } catch { return false; }
  };
}

/** A positive survival signal that may end the startup window early: the
 * SessionStart bind landing (Claude) or the input composer painting (Codex,
 * OpenCode). Harnesses without a signal keep the full observation window. The
 * Claude baseline is snapshotted right after the placeholder bind and BEFORE
 * the respawn, so a hook that lands during the respawn window reads as a change
 * from that baseline — a baseline taken after the respawn could already
 * include the bind and then never signal. */
export function claudeBaselineAfterPlaceholderBind(evidence: FailureEvidence): string | null {
  try {
    const row = seatRows(loadDoc(evidence.selection.registryLocation))[evidence.handle];
    if (!isDict(row)) return null;
    return bindFingerprintOf(row);
  } catch { return null; }
}
function harnessReadySignal(evidence: FailureEvidence, codexObserved: ((facts: PaneFacts) => Promise<StartupObservation>) | null,
  claudeBaseline: string | null, env: NodeJS.ProcessEnv, signal?: AbortSignal,
): ((facts: PaneFacts) => Promise<boolean>) | undefined {
  if (evidence.record.harness === "claude") {
    if (claudeBaseline === null) return undefined;
    return claudeBindSignal(evidence, claudeBaseline);
  }
  if (evidence.record.harness === "codex" && codexObserved) return async facts => {
    const { screen, title } = await codexObserved(facts);
    return codexComposerIdle(screen, title);
  };
  // OpenCode owns its capture (plain physical rows, no title read); every
  // failure inside is no signal, never a thrown rollback.
  if (evidence.record.harness === "opencode") return facts => opencodeReadySignal(facts, env, signal);
  return undefined;
}

async function runCreated(evidence: FailureEvidence, invocation: Invocation, request: TransactionRequest, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  const record = evidence.record;
  const scripts = request.script_dir!;
  launchPhase(`Setting up tmux session ${record.name}`, true);
  try { await ensureTmuxServer(env, { signal }); }
  catch (error) { signal?.throwIfAborted(); throw new TransactionError(tmuxBootstrapFailure(error)); }
  signal?.throwIfAborted();
  const intoWindow = record.revive_vessel === "window";
  const sessionId = record.revive_session?.split("\t")[1] ?? "";
  if (intoWindow && (!sessionId || await survivingSession(record.name, env, signal) !== record.revive_session)) {
    throw new TransactionError(`session ${record.name} ended or was replaced before the seat could be revived into it; retry the resume`);
  }
  if (!intoWindow && await hasSession(record.name, env, signal)) throw new TransactionError(`session appeared after reserving ${record.name}; retry the launch`);
  startupTrace("create_session", { session: record.name, harness: record.harness, launch_id: evidence.token, ...(intoWindow ? { vessel: "window" } : {}) });
  // The launch door reports its own phases and interruptions, in every mode.
  const progress = request.terminal?.stderr_tty && !launchTracked() ? `tap session: starting ${pyRepr(record.name)}...` : "";
  if (progress) process.stderr.write(`\r${progress}`);
  try {
    const waitCommand = `tmux wait-for tap-launch-${randomUUID()}`;
    // A revival adds the seat's window to its surviving session; crew windows stay untouched.
    const created = await launchTmux(intoWindow
      ? ["new-window", "-d", "-t", `${sessionId}:`, "-n", record.harness, "-c", launchWorkdir(record), "-P", "-F", VESSEL_FORMAT, waitCommand]
      : ["new-session", "-d", "-x", "200", "-y", "60", "-s", record.name, "-c", launchWorkdir(record), "-P", "-F", VESSEL_FORMAT, waitCommand], env, signal);
    evidence.vessel = parseVessel(created.stdout);
    if (signal?.aborted && !evidence.vessel) throw new TransactionError(`cannot identify created session ${record.name}; interrupted creation outcome is unverified and reservation retained`);
    if (created.code !== 0 && !evidence.vessel && !/duplicate session/.test(created.stderr)) throw new TransactionError(`cannot identify created session ${record.name}; creation outcome is unverified and reservation retained`);
    if (created.code !== 0) throw new LaunchCommandError(["tmux", intoWindow ? "new-window" : "new-session"], created);
    if (!evidence.vessel) throw new TransactionError(`cannot identify created session ${record.name}; retained without further effects`);
    signal?.throwIfAborted();
    const vessel = evidence.vessel;
    const helper = join(scripts, "run-shell-logged.sh");
    const log = join(env.TAP_INDEX_HOME || join(env.HOME || "", ".tap"), "session-helper.log");
    const callbackEnv = ["TAP_INDEX_HOME", "TAP_HOME"].filter(key => env[key]).map(key => `${key}=${env[key]}`);
    const callback = ["/usr/bin/env", ...callbackEnv, `TMUX=${vessel.socket},0,0`, request.worker_bun!,
      resolve(scripts, "../../../runtime/bun/src/launcher/worker.ts"), "failure", jsonDumpBytes(evidence, { item: ",", key: ":" })];
    const logged = (argv: string[]) => ["bash", helper, log, ...argv].map(shlexQuote).join(" ") + " </dev/null >/dev/null 2>&1 || true";
    const configure = async (args: string[]) => {
      if (!await ownedEffect(vessel, args, env, signal)) throw new TransactionError("created pane identity changed before configuration");
    };
    const priorRemain = (await launchTmux(["show-options", "-p", "-v", "-t", vessel.pane, "remain-on-exit"], env, signal)).stdout.trim();
    if (!["", "on", "off", "failed"].includes(priorRemain)) throw new TransactionError("unrecognized remain-on-exit setting");
    await configure(["set-option", "-p", "-t", vessel.pane, "remain-on-exit", "on"]);
    await configure(["set-hook", "-p", "-t", vessel.pane, "pane-died", `run-shell -b -t ${shlexQuote(vessel.pane)} ${shlexQuote(logged(callback))}`]);
    const placeholder = await paneFacts(vessel.pane, env, signal);
    if (!placeholder) throw new TransactionError(`could not inspect placeholder pane for ${record.name}`);
    await bindTransaction(evidence, placeholder, false, env, signal);
    // Snapshot the Claude baseline while the row still shows only the
    // placeholder bind — before the respawn can race a fast hook.
    const claudeBaseline = claudeBaselineAfterPlaceholderBind(evidence);
    startupTrace("respawn_pane", { session: record.name, pane: vessel.pane, launch_id: evidence.token });
    // Anchored where respawn_pane is traced, so ms_since_respawn is directly
    // comparable to the r2c delta (launch_complete − respawn_pane).
    const respawnedAtMs = performance.now();
    launchPhase(`Starting ${record.harness}`, true);
    try {
      // The launch evidence SessionStart binds through (launch-evidence.ts):
      // this team's root plus the token the reserved row carries as launch_id.
      const launched = { ...invocation, env: { ...invocation.env, TAP_LAUNCH_ROOT: evidence.selection.rootReal, TAP_LAUNCH_ID: evidence.token } };
      await respawnInitialPane(evidence, invocationShellCommand(launched, env), env, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new RespawnFailure(error instanceof LaunchCommandError ? error.result.stderr.trim() || error.message : (error as Error).message);
    }
    // The startup screen (and pane title) is captured once per poll and shared
    // by the Codex blocker regexes and the composer signal; Claude reads the
    // registry. OpenCode captures plain physical rows inside its own signal.
    const codexObserved = record.harness === "codex" ? memoizedStartupObservation(env, signal) : null;
    const readySignal = harnessReadySignal(evidence, codexObserved, claudeBaseline, env, signal);
    const result = await awaitStableHarness(async () => {
      const observed = await launchTmux(["display-message", "-p", "-t", vessel.pane, VESSEL_FORMAT], env, signal);
      if (!sameVessel(vessel, parseVessel(observed.stdout))) throw new TransactionError("created pane identity changed during readiness");
      return paneFacts(vessel.pane, env, signal);
    }, facts => {
      const running = !facts.dead && paneHarness(facts, env) === record.harness;
      // Claude's readiness signal is its SessionStart bind; the others paint a composer.
      if (running) launchPhase(record.harness === "claude" ? `Waiting for claude to register on team ${evidence.selection.team}` : `Waiting for ${record.harness} to be ready`, true);
      return running;
    }, HARNESS_START_TIMEOUT_MS,
    { signal, observeUntilDeadline: true,
      // The underlying signal is latched in awaitStableHarness, so this fires
      // exactly once per launch that signals — one trace event, riding the
      // launch operation's existing writer (no extra subprocess).
      ready: readySignal && (async facts => {
        const fired = await readySignal(facts);
        if (fired) startupTrace("readiness_signal", {
          signal: evidence.record.harness === "claude" ? "claude_bind"
            : evidence.record.harness === "codex" ? "codex_idle" : "opencode_idle",
          ms_since_respawn: Math.round(performance.now() - respawnedAtMs),
          pane_id: facts.pane_id, launch_id: evidence.token,
        });
        return fired;
      }),
      blocker: codexObserved
      ? async facts => {
        const { screen } = await codexObserved(facts);
        return startupBlockerFromScreen(facts, record.harness, screen === null ? null : stripPaneSgr(screen));
      } : undefined });
    if (result.reason?.startsWith("codex-hook-trust:")) {
      const facts = await paneFacts(vessel.pane, env, signal);
      if (!facts || facts.dead || facts.pane_id !== vessel.pane || paneHarness(facts, env) !== record.harness) throw new TransactionError(result.reason);
      await configure(priorRemain ? ["set-option", "-p", "-t", vessel.pane, "remain-on-exit", priorRemain]
        : ["set-option", "-p", "-u", "-t", vessel.pane, "remain-on-exit"]);
      await configure(["set-hook", "-p", "-u", "-t", vessel.pane, "pane-died"]);
      await bindTransaction(evidence, facts, true, env, signal);
      throw new StartupDialog(`${result.reason}\nSession ${record.name} retained; inspect with tmux attach -t ${record.name}`, { selection: evidence.selection, backup: evidence.backup, session: record.name }, "harness_start_dialog", `tmux attach -t ${record.name}`);
    }
    if (!result.facts) throw await harnessStartFailure(evidence, result.reason, env, signal);
    signal?.throwIfAborted();
    await configure(priorRemain ? ["set-option", "-p", "-t", vessel.pane, "remain-on-exit", priorRemain]
      : ["set-option", "-p", "-u", "-t", vessel.pane, "remain-on-exit"]);
    await configure(["set-hook", "-p", "-u", "-t", vessel.pane, "pane-died"]);
    launchPhase(`Marking ${evidence.handle} ready on team ${evidence.selection.team}`, true);
    await bindTransaction(evidence, result.facts, true, env, signal);
    // An attach lands on the revived seat, not on whichever crew window was current.
    // Best effort: the seat is already bound, so a lost focus is no rollback.
    if (intoWindow) await ownedEffect(vessel, ["select-window", "-t", vessel.window], env, signal).catch(() => false);
  } finally {
    if (progress) process.stderr.write(`\r${" ".repeat([...progress].length)}\r`);
    if (progress && signal?.aborted && signal.reason instanceof LaunchInterrupted && signal.reason.exitCode === 130) {
      process.stderr.write("tap session: interrupted\n");
    }
  }
}

export function refusePreexistingIdOnNewMint(record: LaunchRecord): void {
  if ((record.ensure_action ?? "new") !== "new" || record.harness !== "cursor") return;
  if (record.harness_session_id) throw new TransactionError(`refusing new cursor launch with a pre-existing harness_session_id (${record.harness_session_id}); that combination skips the mint and would hand the process a stored id. Fresh launches mint; stored ids resume.`);
}

// Side-effecting PRE-FENCE helper also used by clear after its identity wipe.
export async function cursorMintSession(cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string | null> {
  try {
    const result = await launchCommand(["cursor-agent", "create-chat"], { cwd, env, signal, timeoutMs: 10_000 });
    signal?.throwIfAborted();
    return result.code === 0 ? /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.exec(result.stdout)?.[0] ?? null : null;
  } catch (error) { signal?.throwIfAborted(); return null; }
}

export async function mintLaunchSessionId(record: LaunchRecord, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<LaunchRecord> {
  if (record.harness_session_id || record.harness !== "cursor") return record;
  const id = await cursorMintSession(launchWorkdir(record), env, signal);
  return id ? { ...record, harness_session_id: id, identity_capture_action: "new" } : record;
}

export async function launchTransaction(request: TransactionRequest, env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal, notices = new Notices()): Promise<TransactionResult> {
  const record = request.record;
  if (!["new", "adopted", "resume", "resume-all", "restart", "seat-up"].includes(request.kind)) throw new TransactionError("invalid launch transaction kind");
  request.script_dir ??= tapScriptsDir();
  request.worker_bun = artifactBun() ?? (env.TAP_SMOKE_BUN || Bun.which("bun", { PATH: env.PATH }) || undefined);
  if (!request.dry_run && (!request.worker_bun || !existsSync(resolve(request.script_dir, "../../../runtime/bun/src/launcher/worker.ts")))) {
    throw new TransactionError("native launch helper is unavailable; verify the Bun runtime and TAP installation; next: tap doctor");
  }
  if (!isDict(record) || ![record.name, record.harness, record.cwd, record.base].every(v => typeof v === "string") || !HARNESSES.includes(record.harness)) {
    throw new TransactionError("invalid launch transaction record");
  }
  if (!isAbsolute(record.cwd) || [record.name, record.cwd, record.base].some(value => value.includes("\0"))) throw new TransactionError("invalid launch transaction path/name");
  for (const key of ["harness_passthrough", "harness_unset_env", "harness_tail", "history"] as const) {
    if (record[key] !== undefined && (!Array.isArray(record[key]) || !record[key]!.every(value => typeof value === "string" && !value.includes("\0")))) {
      throw new TransactionError(`invalid launch recipe ${key}`);
    }
  }
  if (record.harness_env !== undefined && (!isDict(record.harness_env) || Object.entries(record.harness_env).some(([key, value]) =>
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0")))) throw new TransactionError("invalid launch recipe environment");
  const selection = selectCaller({ cwd: request.root ?? record.cwd, env: { ...env, TAP_HOME: undefined }, verbClass: "lifecycle" });
  if (record.launch_workdir !== undefined) record.launch_workdir = validateLaunchWorkdir(selection.rootReal, record.launch_workdir);
  if (env.TAP_HOME) selection.busHome = env.TAP_HOME;
  if (request.notice_state) notices.restore(request.notice_state);
  if (request.json) notices.suppress(true);
  const operation = request.kind === "restart" ? "session restart" : request.kind === "new" ? "session launch" : "session resume";
  assertReset(selection, operation, env);
  record.last_launched ||= now();
  if (request.kind === "restart" && request.incumbent_live) record.replaces_session = record.name;
  const action = request.kind === "new" ? record.ensure_action ?? "new" : "resume";
  if (action === "new") {
    refusePreexistingIdOnNewMint(record);
    if (!request.dry_run) Object.assign(record, await mintLaunchSessionId(record, env, signal));
  }
  // tap-we6b rework: seat-up used to bind the RAW stored id here, bypassing
  // the resume resolver — a cursor id whose chat store never appeared came
  // back as `--resume <stale-id>`. Bind through the same gate the resume door
  // refuses on: a stale cursor identity refuses the transaction before any
  // reservation or registry mutation.
  const invocationOptions: { env: NodeJS.ProcessEnv; nativeQuery?: string | null; resume: ResumeIdentity } = { env, nativeQuery: request.kind === "adopted" ? request.native_query ?? null : undefined,
    resume: action === "resume" ? record.revive_vessel === "window" ? exactRevivalIdentity(record, env) : resumeIdentityBinding(request.kind, record, env) : UNBOUND_RESUME_IDENTITY };
  if (request.kind === "restart" && !request.preflight_done) launchInvocation("resume", record, notices, { ...invocationOptions, notify: false, receipts: discardReceipts });
  if (request.kind === "new") buildInvocation(action, record, notices, env, null, UNBOUND_RESUME_IDENTITY, undefined, discardReceipts);
  const expectedReceipt = () => {
    if (action === "resume" && request.kind !== "adopted" && request.kind !== "seat-up") {
      process.stderr.write(`tap session: resuming ${record.name}; expected seat ${launchHandle(record)}\n`);
    }
  };
  // The id-less disclosure is part of what a dry run previews: its argv starts
  // fresh (cursor) or at a picker, and the operator must see that before acting.
  const idlessResumeWarning = () => {
    if (request.kind === "resume" && !record.harness_session_id && !["opencode", "hermes"].includes(record.harness)) {
      process.stderr.write(record.harness === "cursor"
        // tap-we6b: cursor never opens its picker; an id-less resume starts fresh.
        ? `tap session: WARNING: ${record.name} has no native cursor chat id; starting a fresh conversation\n`
        : `tap session: WARNING: ${record.name} has no native ${record.harness} session id; falling back to the native picker\n`);
    }
  };
  if (request.dry_run) {
    idlessResumeWarning();
    expectedReceipt();
    const invocation = launchInvocation(action, record, notices, invocationOptions);
    if (request.validate_only) return { code: 0, record, adopted_shell: false, backup: { status: "not-needed" } };
    process.stdout.write(request.json ? jsonDumpBytes({ ...(request.lifecycle_receipt ? { ...request.lifecycle_receipt, outcome: "would_resume" } : {}), name: record.name, harness: record.harness, cwd: launchWorkdir(record),
      env: invocation.env, argv: invocation.argv, ...(record.preset ? { preset: record.preset } : {}) }, { item: ",", key: ":" }, true) + "\n"
      : `tap session: would launch ${record.name} (${record.harness}) in ${launchWorkdir(record)}\n`);
    return { code: 0, record, adopted_shell: false, backup: { status: "not-needed" } };
  }
  launchPhase(`Reserving ${launchHandle(record)} on team ${selection.team}`, true);
  await fenceBarrier("pre-mutation", env, signal);
  // SHARED since tap-7t3ag: a launch is a registry mutation, not a structural
  // cut, so it takes SH custody like every other registry writer and holds it
  // across the whole transaction — harness start included. Sends, replies,
  // courier delivery and unrelated relaunches proceed during a launch;
  // teardown/restore still take EX and exclude it. Same-name serialization
  // comes from the pending reservation under the registry lock, not from this
  // sidecar; the generation mark below uses the shared bounded helper.
  const reset = await acquirePathLockAsync(join(selection.busHome, "reset.fence.json.lock"), Infinity, signal, env, "shared");
  if (!reset) throw new TransactionError("could not obtain reset mutation custody");
  let evidence: FailureEvidence | undefined;
  const stop: StopState = { attempted: false, killed: false, uncertain: false, adoptedShell: false };
  try {
    assertReset(selection, operation, env, true);
    await fenceBarrier("holding-mutation-lock", env, signal);
    evidence = { selection, handle: launchHandle(record), token: "", instance: null, record, vessel: null, backup: { status: "not-needed" },
      reason: request.kind === "restart" ? "restart_failed" : request.kind === "new" ? "session_replaced" : "repair_failed",
      output_path: request.output_path ?? "" };
    idlessResumeWarning();
    await reserveTransaction(selection, request, evidence, env, signal);
    signal?.throwIfAborted();
    markResetGenerationReused(selection.busHome, request.kind === "seat-up" ? "seat-up" : request.kind === "restart" ? "session-restart" : action === "new" ? "session-launch" : action === "fork" ? "session-fork" : "session-resume");
    await suspendAndStop(evidence, request, stop, env, signal);
    signal?.throwIfAborted();
    expectedReceipt();
    const invocation = launchInvocation(action, record, notices, invocationOptions);
    await runCreated(evidence, invocation, request, env, signal);
    return { code: 0, record, adopted_shell: stop.adoptedShell, backup: evidence.backup };
  } catch (error) {
    try {
      if (evidence?.token && !(error instanceof StartupDialog)) {
        if (stop.uncertain) throw await recoveryError(evidence, new Error("incumbent stop outcome is unobservable; reservation retained"));
        // A successful creation with no identity is deliberately retained. A
        // reused name is never enough evidence for rollback's destructive tail.
        const unknownCreation = error instanceof TransactionError && error.message.startsWith("cannot identify created session");
        if (unknownCreation) process.stderr.write(`tap session: creation outcome unverified; pending reservation retained for ${record.name}. Inspect the session before recovery.\n`);
        if (!unknownCreation) {
          let rolledBack = false;
          try {
            const reason = !stop.killed && (request.kind === "restart" || record.replaces_session) ? null : evidence.reason;
            rolledBack = await rollbackOwned(evidence, reason, env, evidence.vessel !== null);
          } catch (rollback) {
            const recovery = await recoveryError(evidence, rollback);
            if (signal?.aborted) process.stderr.write(`tap session: ${recovery.message}\n`);
            else throw recovery;
          } finally {
            if (error instanceof RespawnFailure) await reportRespawnResidue(evidence, error, rolledBack, env);
          }
        }
      }
      signal?.throwIfAborted();
      throw error;
    } catch (failure) {
      if (request.kind === "restart" && stop.killed && evidence && !(failure instanceof StartupDialog)) throw new RestartResumeFailure(failure, evidence);
      throw failure;
    }
  } finally {
    request.notice_state = notices.capture();
    await reset.release();
  }
}

export async function launchFailure(evidence: FailureEvidence, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!evidence.token || !Object.hasOwn(evidence, "instance") ||
      (evidence.instance !== null && typeof evidence.instance !== "string") ||
      (evidence.selection?.marker === "live" && !evidence.instance) || !evidence.vessel || !parseVessel([
    evidence.vessel.server, evidence.vessel.session, evidence.vessel.window, evidence.vessel.pane, "0", evidence.vessel.socket].join("\t"))) {
    process.stderr.write("tap session: legacy launch failure lacks owned token/instance/vessel proof; residue retained; next: tap doctor\n");
    return false;
  }
  try { return await rollbackOwned(evidence, evidence.reason, env, true, "callback"); }
  catch (error) { throw await recoveryError(evidence, error); }
}
