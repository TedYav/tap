// The prelude every `tap session resume` form shares with launcher.py's
// cmd_resume: retired flags, the reset fence and its test barrier, flip
// authority, the acting-registry projection (registry_session_state), the
// tmux bootstrap, and the LauncherError / SystemExit renderer. resume-all.ts
// (the cohort) and resume.ts (every other form) are its two callers.
import { join } from "node:path";
import { statSync } from "node:fs";
import { ensureAscii } from "../fsatomic";
import { enrollmentAtFromDoc, loadGlobalRegistry } from "../index-home";
import { NO_MACHINE_INDEX, SelectorError } from "../selector";
import { isDict, parseJsonPreserving, pyReadUtf8 } from "../spool-publication";
import { fenceTestBarrier, launcherFenceRefusal } from "../reset";
import { seatIsRelaunchable } from "./complete";
import { seatEntries, orderedDoc } from "./identity-owner";
import { InvocationError, shlexQuote } from "./invocation";
import { LaunchCommandError } from "./process";
import { ensureTmuxServer, tmuxBootstrapFailure } from "./tmux-bootstrap";
import { realOrSelf, rootForCwd } from "./records";
import { LaunchInterrupted, recordFromRow, type LaunchRecord } from "./transaction";
import { LauncherError } from "./types";
import { isOldStoreRefusal, oldStoreAction, teamRegistryRefusal } from "../register-authority";
import { tapScriptsDir } from "../scripts-dir";

export type Row = Record<string, unknown>;
export const VERB = "tap session";
export const SCRIPTS = tapScriptsDir();

/** A launcher-side refusal rendered like launcher.py's LauncherError. */
export class Refusal extends Error {}
/** launcher.py's SystemExit: the caller already rendered its own line. */
export class Exit extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }

// ---- retired flags, fence, flip authority (launcher.py order) ----

export function refuseRetiredFlags(model: string | null, teams: boolean): void {
  if (model !== null) throw new LauncherError("retired_flag: --model", "retired_flag",
    "resume replays the seat's stored record; set the model when the seat is LAUNCHED (--model, or a preset) and every later resume replays it",
    "--model was removed from `tap session resume`");
  if (teams) throw new LauncherError("retired_flag: --teams", "retired_flag",
    "agent teams is environment now, and it belongs to the seat: put CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=true in [harness.claude.env] to apply it to every claude seat, or relaunch this one with --env / a preset that carries it",
    "--teams was removed from `tap session resume`");
}

const isDir = (path: string): boolean => { try { return statSync(path).isDirectory(); } catch { return false; } };
const isFile = (path: string): boolean => { try { return statSync(path).isFile(); } catch { return false; } };

function teamBusHome(cwd: string): string | null {
  if (process.env.TAP_HOME) return process.env.TAP_HOME;
  let root: string;
  try { root = rootForCwd(cwd); } catch { root = cwd; }
  for (const base of [root, cwd]) {
    for (const candidate of [join(base, ".tap", "bus"), join(base, "tmp", "tap")]) if (isDir(candidate)) return candidate;
  }
  return null;
}

export function refuseIfResetFenced(cwd: string, action = "session resume"): void {
  const bus = teamBusHome(cwd);
  if (bus === null) return;
  const fence = join(bus, "reset.fence.json");
  if (isFile(fence)) throw new Refusal(launcherFenceRefusal(fence, action));
}

export type AuthorityStatus = "absent" | "live" | "live_unreachable" | "live_unenrolled" | "invalid";
/** registry_v20.resolve_team_registry_for_root, root-only form. */
export function registryAuthority(root: string): { status: AuthorityStatus; path: string | null } {
  const snapshot = loadGlobalRegistry();
  if (snapshot.marker === "invalid") return { status: "invalid", path: null };
  const rootReal = realOrSelf(root);
  if (snapshot.marker === "live") {
    const enrollment = enrollmentAtFromDoc(snapshot.doc!, rootReal);
    if (enrollment.status === "ok") return { status: "live", path: enrollment.registryLocation };
    if (enrollment.status === "missing") return { status: "live_unenrolled", path: null };
    if (enrollment.status === "invalid") return { status: "invalid", path: null };
    return { status: "live_unreachable", path: enrollment.status === "unreachable" ? enrollment.registryLocation || null : null };
  }
  // No machine index: no enrollment, so no acting registry (F2c). Launch bootstraps from here.
  return { status: "absent", path: null };
}

function printSessionError(verb: string, errorClass: string, action: string, detail: string): void {
  if (process.env.TAP_JSON === "1") { process.stdout.write(errorLine(errorClass, action, detail)); return; }
  const humanDetail = detail.replace(/[\n\r]/g, " ") || errorClass.replaceAll("_", " ");
  const humanAction = action.includes(" ") || action.includes("/") ? action : action.replaceAll("_", " ");
  process.stderr.write(`${verb}: ${humanDetail}; next: ${humanAction}\n`);
}

/** _refuse_if_flip_authority; only launch (which bootstraps and enrolls) may allow absent or live_unenrolled. */
export function refuseIfFlipAuthority(cwd: string, verb = "tap session resume", allowUnenrolled = false): void {
  let root: string;
  try { root = rootForCwd(cwd); } catch { root = cwd; }
  const { status } = registryAuthority(root);
  const refusals: Partial<Record<AuthorityStatus, [string, string, string]>> = {
    invalid: ["invalid_flip", "tap doctor", `${verb} refused — global-registry.json is present but unreadable or wrong schema`],
    live_unreachable: ["acting_registry_unreachable", "tap doctor", `${verb} refused — acting team-registry unreachable under live flip marker`],
  };
  if (!allowUnenrolled) {
    refusals.absent = ["unanchored_bus", "tap init  OR  tap session launch", `${verb} refused — ${NO_MACHINE_INDEX}`];
    refusals.live_unenrolled = ["live_unenrolled", "tap session launch / tap in", `${verb} refused — worktree is not enrolled under the live flip marker`];
  }
  const refusal = refusals[status];
  if (!refusal) return;
  printSessionError(verb, ...refusal);
  throw new Exit(1);
}

/** cmd_resume's entry guard: fence, the fence-race test barrier, flip authority. */
export function entryGuard(cwd: string): void {
  refuseIfResetFenced(cwd);
  fenceTestBarrier("after-entry-guard");
  refuseIfFlipAuthority(cwd);
}

// ---- registry state: the incumbent registry_session_state projection ----

/** launcher.py SessionRecord dataclass defaults, so the transaction sees asdict(). */
export function withRecordDefaults(record: LaunchRecord): LaunchRecord {
  return {
    tag: null, index: null, model: null, harness_session_id: null, transcript_path: null,
    quarantined_harness_session_id: null, quarantined_transcript_path: null, identity_quarantine_reason: null,
    adopted_from_manual: false, harness_passthrough: [], passthrough_from_config: false, harness_env: {},
    harness_unset_env: [], harness_tail: [], preset: null, permissions: null, history: [], last_launched: null,
    last_seen: null, replaces_session: null, replaces_manifest_session: null, replacement_record: null,
    replacement_registry_entry: null, kill_backup_required: false, kill_backup_has_seat_state: false,
    kill_backup_path: null, launch_id: null, launch_failure_argv: null, launch_failure_reason: null,
    identity_capture_action: null, ensure_action: "new", ensure_vessel: null, ensure_receipts: [],
    ...record,
  } as LaunchRecord;
}

export interface RegistryState { sessions: LaunchRecord[]; entries: Map<string, Row>; team: Row }

export function registryState(cwd: string, allowUnenrolled = false): RegistryState {
  const root = rootForCwd(cwd);
  const { status, path } = registryAuthority(root);
  if (status === "invalid") throw new Refusal("acting registry is invalid; next: tap doctor");
  if (status === "live_unreachable") throw new Refusal("acting team registry is unreachable; next: tap doctor");
  if (status === "absent") {
    if (!allowUnenrolled) throw new LauncherError(`${NO_MACHINE_INDEX}; next: tap init  OR  tap session launch`, "unanchored_bus", "tap init  OR  tap session launch", NO_MACHINE_INDEX);
    return { sessions: [], entries: new Map(), team: {} };
  }
  if (status === "live_unenrolled") {
    if (!allowUnenrolled) throw new Refusal("worktree is not enrolled; next: tap session launch or tap in");
    return { sessions: [], entries: new Map(), team: {} };
  }
  if (!path) return { sessions: [], entries: new Map(), team: {} };
  let payload: unknown, text: string;
  try { text = pyReadUtf8(path); payload = parseJsonPreserving(text); }
  catch (error) { throw new Refusal(`acting registry unreadable: ${(error as Error).message}; next: tap doctor`); }
  if (!isDict(payload)) throw new Refusal("acting registry root is not an object; next: tap doctor");
  const oldStore = teamRegistryRefusal(path, payload);
  if (oldStore) throw new LauncherError(oldStore.detail, "old_store", oldStore.action, oldStore.detail);
  const team = isDict(payload.team) ? payload.team : {};
  const sessions: LaunchRecord[] = [], entries = new Map<string, Row>();
  for (const [handle, entry] of seatEntries(payload, orderedDoc(text))) {
    if (!isDict(entry)) continue;
    entries.set(handle, entry);
    if (!seatIsRelaunchable(entry)) continue;
    const record = recordFromRow(handle, entry, team, root);
    if (record !== null) sessions.push(withRecordDefaults(record));
  }
  return { sessions, entries, team };
}

// ---- tmux bootstrap ----

export async function bootstrapTmux(ensure: typeof ensureTmuxServer = ensureTmuxServer): Promise<void> {
  // A successful bootstrap may still warn (an unreadable config defaults to enabled).
  try { await ensure(process.env, { warn: line => process.stderr.write(`${line}\n`) }); }
  catch (error) { throw new Refusal(tmuxBootstrapFailure(error)); }
}

// ---- output ----

export const out = (line: string) => process.stdout.write(`${line}\n`);
export const err = (line: string) => process.stderr.write(`${line}\n`);
export const compact = (value: unknown): string => ensureAscii(JSON.stringify(value));
export function errorLine(errorClass: string, action: string, detail: string): string {
  const obj: Row = { ok: false, error_class: errorClass, action };
  if (detail) obj.detail = detail;
  return `${compact(obj)}\n`;
}
/** launcher._command_summary: argv joined, or its head when longer than 80. */
export const commandSummary = (argv: string[]): string => {
  const joined = argv.map(shlexQuote).join(" ");
  return joined.length > 80 ? `${argv[0]} ...` : joined;
};

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneValue) as T;
  if (isDict(value) && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)])) as T;
  }
  return value;
}
/** The bridge's serialized-packet copy: a failed attempt's partial writes never leak back. */
export const cloneRecord = (record: LaunchRecord): LaunchRecord => cloneValue(record);

/** launcher.py main()'s handler ladder for the errors a resume can raise. */
export function render(error: unknown, jsonRequested: boolean): number {
  // The launch door tags a failure with the phase it stopped in, so a caller
  // without the spinner (redirected, --json) still learns where it failed.
  const tagged = (error as { launchPhase?: unknown })?.launchPhase;
  const during = typeof tagged === "string" && tagged ? `while ${tagged.charAt(0).toLowerCase()}${tagged.slice(1)}: ` : "";
  if (error instanceof Exit) return error.code;
  if (error instanceof LaunchInterrupted) {
    // A launch interrupted inside an effect-bearing phase says where, after
    // its ✗ settled; the launch door owns this line in every mode.
    if (during && (jsonRequested || process.env.TAP_JSON === "1")) process.stdout.write(errorLine("launcher_interrupted", "tap help session", `${during}launch cancelled`));
    else if (during) err(`${VERB}: ${during}interrupted`);
    return error.exitCode;
  }
  if (error instanceof LauncherError && error.errorClass) {
    if (jsonRequested) process.stdout.write(errorLine(error.errorClass, error.action ?? "", `${during}${error.detail ?? ""}`));
    else err(`${VERB}: ${during}${error.detail ?? error.message}; next: ${error.action ?? ""}`);
    return error.errorClass === "old_store" ? 1 : 2;
  }
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
    // FileNotFoundError.filename: the command (or file) that could not be found.
    const missing = error as NodeJS.ErrnoException & { spawnargs?: string[] };
    err(`${VERB}: ${during}missing command: ${missing.path ?? missing.spawnargs?.[0] ?? "None"}`);
    return 127;
  }
  // A launch transaction's old_store keeps its class and the old_store exit code.
  if (error instanceof InvocationError && isOldStoreRefusal(error)) {
    if (jsonRequested) process.stdout.write(errorLine("old_store", oldStoreAction("agents_axis"), `${during}${error.message}`));
    else err(`${VERB}: ${during}${error.message}`);
    return 1;
  }
  if (error instanceof SelectorError && error.errorClass === "old_store") {
    if (jsonRequested) process.stdout.write(errorLine("old_store", error.action, `${during}${error.detail}`));
    else err(`${VERB}: ${during}old_store: ${error.detail}; next: ${error.action}`);
    return 1;
  }
  // A classed runtime refusal (e.g. tmux server_unresponsive) keeps its class and action.
  const classed = error as Error & { tapErrorClass?: unknown; tapAction?: unknown };
  if (typeof classed?.tapErrorClass === "string") {
    const action = typeof classed.tapAction === "string" ? classed.tapAction : "tap help session";
    if (jsonRequested) process.stdout.write(errorLine(classed.tapErrorClass, action, `${during}${classed.message}`));
    else err(`${VERB}: ${during}${classed.message}; next: ${action}`);
    // tap-zk1w: an unobservable tmux generation is transient (wait and retry), exit 1.
    return classed.tapErrorClass === "generation_unverifiable" ? 1 : 2;
  }
  if (error instanceof Refusal || error instanceof InvocationError || error instanceof SelectorError || error instanceof LauncherError) {
    const message = error instanceof SelectorError ? `${error.errorClass}: ${error.detail}; next: ${error.action}` : error.message;
    if (process.env.TAP_JSON === "1") process.stdout.write(errorLine("session_error", "tap help session", `${during}${message}`));
    else err(`${VERB}: ${during}${message}`);
    return 2;
  }
  if (error instanceof LaunchCommandError) {
    err(`${VERB}: ${during}command failed (exit ${error.result.code || 2}): ${commandSummary(error.argv)}`);
    return error.result.code || 2;
  }
  throw error;
}
