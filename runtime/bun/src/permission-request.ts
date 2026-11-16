/**
 * A Claude seat's open permission request, as its PermissionRequest hook saw it.
 *
 * Each request is one small file with a name of its own. The hook never
 * replaces a file: it writes a new name and removes this seat's strictly older
 * ones. A reader shows the newest and removes only names it listed. A delete
 * by unique name cannot take a record written since, so no read needs a lock.
 *
 * The record is detail, never state: a reader shows it only while Claude's own
 * session file says that same session is waiting, because a declined or
 * cancelled request fires no hook and nothing else tells TAP the request closed.
 *
 * Kept: the tool name, a one-line summary capped at SUMMARY_MAX, the permission
 * mode, the session id, the pane and the time. Never the command line, a file
 * body or the tool input itself.
 */
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "./fsatomic";
import { validToken } from "./ids";

export const SUMMARY_MAX = 160;
const TOOL_MAX = 120;
const RECORD_MAX_BYTES = 4096;
const SESSION_FILE_MAX_BYTES = 65536;
const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string => typeof value === "string" ? value : "";

export interface PermissionRequestRecord {
  v: 1;
  harness: "claude";
  /** Epoch milliseconds when the hook ran. */
  at: number;
  session: string;
  pane_id: string;
  server_epoch: string;
  tool: string;
  summary: string;
  permission_mode: string;
  /** Claude's session file for this session, found when the hook ran. */
  session_file: string;
}

/** What a reader shows for a seat that is waiting on this request. */
export interface PendingPermissionRequest {
  tool: string;
  summary: string;
  /** Epoch seconds. */
  since: number;
  /** Claude's own word for the wait: `permission prompt` or `input needed`. */
  waitingFor: string;
}

export const permissionRequestDir = (bus: string): string => join(bus, "permission-requests");

/**
 * The directory, only when it is a real directory. A symlink at that name
 * points at files TAP does not own, so nothing is read, written or removed
 * through it. Any error reading it is "not owned": the callers are cleanup
 * paths that must not fail.
 */
function ownedDir(bus: string): string | null {
  if (!bus) return null;
  const directory = permissionRequestDir(bus);
  try { return lstatSync(directory, { throwIfNoEntry: false })?.isDirectory() ? directory : null; } catch { return null; }
}

function regularFile(path: string): boolean {
  try { return lstatSync(path, { throwIfNoEntry: false })?.isFile() === true; } catch { return false; }
}

/**
 * `<handle>.<epoch ms>-<8 hex>.json`. A handle may itself hold dots, digits and
 * hyphens, so the name is read from its fixed-shape tail and the handle must
 * then equal the seat's exactly: `opus` never matches `opus.fixer`'s record.
 */
const RECORD_NAME = /^(.+)\.(\d{10,16})-([0-9a-f]{8})\.json$/;

function recordNameOf(name: string): { handle: string; at: number } | null {
  const match = RECORD_NAME.exec(name);
  return match && validToken(match[1]!) ? { handle: match[1]!, at: Number(match[2]) } : null;
}

/** This seat's record files, oldest first; a name is its own tiebreak. */
export function permissionRequestFiles(bus: string, handle: string): string[] {
  const directory = validToken(handle) ? ownedDir(bus) : null;
  if (!directory) return [];
  let names: string[];
  try { names = readdirSync(directory); } catch { return []; }
  const mine = names.flatMap((name) => {
    const parsed = recordNameOf(name);
    return parsed && parsed.handle === handle && regularFile(join(directory, name)) ? [{ name, at: parsed.at }] : [];
  });
  mine.sort((a, b) => a.at - b.at || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return mine.map(entry => join(directory, entry.name));
}

function remove(path: string): void {
  try { unlinkSync(path); } catch { /* already gone, or not ours to force */ }
}

/** One line, no control characters, at most `max` characters. */
function oneLine(value: string, max: number): string {
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/ {2,}/g, " ").trim();
  const points = Array.from(flat);
  return points.length <= max ? flat : `${points.slice(0, max - 1).join("")}…`;
}

export function permissionToolName(value: unknown): string {
  const name = text(value);
  return name.length > 0 && name.length <= TOOL_MAX && /^[A-Za-z0-9_.:-]+$/.test(name) ? name : "";
}

/**
 * The summary for a request. A shell tool contributes the model's own
 * description of the command, never the command; a file tool its path; a
 * question its first question. Any other tool contributes nothing.
 */
export function permissionSummary(tool: string, input: unknown): string {
  if (!object(input)) return "";
  switch (tool) {
    case "Bash": case "PowerShell":
      return oneLine(text(input.description), SUMMARY_MAX);
    case "Edit": case "Write": case "MultiEdit": case "Read":
      return oneLine(text(input.file_path), SUMMARY_MAX);
    case "NotebookEdit":
      return oneLine(text(input.notebook_path), SUMMARY_MAX);
    case "AskUserQuestion": {
      const first = Array.isArray(input.questions) ? input.questions[0] : null;
      return object(first) ? oneLine(text(first.question), SUMMARY_MAX) : "";
    }
    default:
      return "";
  }
}

/** What TAP reads from one of Claude's per-process session files. */
export interface ClaudeSessionState {
  pid: number;
  sessionId: string;
  /** "" when the field is absent or not a string: the reader then shows nothing. */
  status: string;
  waitingFor: string;
  statusUpdatedAt: number | null;
}

/**
 * Claude Code keeps `sessions/<pid>.json` under its config directory while a
 * session runs. The format is undocumented, so every field is optional here:
 * "missing" means the file is gone, "unreadable" means it is there and TAP
 * could not use it.
 */
export function readClaudeSessionState(path: string): ClaudeSessionState | "missing" | "unreadable" {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT" ? "missing" : "unreadable";
  }
  if (raw.length > SESSION_FILE_MAX_BYTES) return "unreadable";
  let doc: unknown;
  try { doc = JSON.parse(raw.toString("utf8")); } catch { return "unreadable"; }
  if (!object(doc) || typeof doc.pid !== "number" || !Number.isInteger(doc.pid) || !UUID_RE.test(text(doc.sessionId))) return "unreadable";
  return {
    pid: doc.pid,
    sessionId: text(doc.sessionId),
    status: text(doc.status),
    waitingFor: text(doc.waitingFor),
    statusUpdatedAt: typeof doc.statusUpdatedAt === "number" && Number.isFinite(doc.statusUpdatedAt) ? doc.statusUpdatedAt : null,
  };
}

export function claudeSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"), "sessions");
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as { code?: string }).code === "EPERM"; }
}

/**
 * The session file of the live Claude process running `sessionId`, when it
 * reports a status. A file without a status cannot vouch for a record, so the
 * hook writes nothing in that case.
 */
export function findClaudeSessionFile(sessionId: string, directory: string, isAlive: (pid: number) => boolean = alive): string {
  if (!UUID_RE.test(sessionId)) return "";
  let names: string[];
  try { names = readdirSync(directory); } catch { return ""; }
  let best = "", bestAt = -1;
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const path = join(directory, name);
    const state = readClaudeSessionState(path);
    if (typeof state === "string" || state.sessionId !== sessionId || !state.status || !isAlive(state.pid)) continue;
    const at = state.statusUpdatedAt ?? 0;
    if (at > bestAt) { best = path; bestAt = at; }
  }
  return best;
}

/**
 * Write this request as a new file, then remove this seat's strictly older
 * ones. Nothing is replaced, so a reader that is judging an older file cannot
 * lose this one; a request written in the same millisecond is left alone.
 */
export function writePermissionRequest(bus: string, handle: string, record: PermissionRequestRecord): boolean {
  if (!bus || !validToken(handle) || !Number.isSafeInteger(record.at) || record.at < 1e9) return false;
  mkdirSync(permissionRequestDir(bus), { recursive: true, mode: 0o700 });
  const directory = ownedDir(bus);
  if (!directory) return false;
  atomicWrite(join(directory, `${handle}.${record.at}-${randomBytes(4).toString("hex")}.json`), `${JSON.stringify(record)}\n`, 0o600);
  for (const path of permissionRequestFiles(bus, handle)) {
    const parsed = recordNameOf(path.slice(directory.length + 1));
    if (parsed && parsed.at < record.at) remove(path);
  }
  return true;
}

function readRecord(path: string): PermissionRequestRecord | "missing" | "invalid" | "foreign" {
  // Anything at the record's name that is not a plain file is not TAP's record.
  let plain: boolean | undefined;
  try { plain = lstatSync(path, { throwIfNoEntry: false })?.isFile(); } catch { return "foreign"; }
  if (plain === undefined) return "missing";
  if (!plain) return "foreign";
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT" ? "missing" : "invalid";
  }
  if (raw.length > RECORD_MAX_BYTES) return "invalid";
  let doc: unknown;
  try { doc = JSON.parse(raw.toString("utf8")); } catch { return "invalid"; }
  if (!object(doc)) return "invalid";
  // A later version's record is not this reader's to judge or to remove.
  if (doc.v !== 1 || doc.harness !== "claude") return "foreign";
  if (typeof doc.at !== "number" || !Number.isFinite(doc.at) || !UUID_RE.test(text(doc.session))
    || !permissionToolName(doc.tool) || typeof doc.summary !== "string" || !text(doc.session_file)) return "invalid";
  return {
    v: 1, harness: "claude", at: doc.at, session: text(doc.session), pane_id: text(doc.pane_id),
    server_epoch: text(doc.server_epoch), tool: text(doc.tool), summary: oneLine(doc.summary, SUMMARY_MAX),
    permission_mode: text(doc.permission_mode), session_file: text(doc.session_file),
  };
}

/** Remove every record of a seat. Never throws: `tap out` and session start call it after their own work is done. */
export function removePermissionRequest(bus: string, handle: string): void {
  for (const path of permissionRequestFiles(bus, handle)) remove(path);
}

/** Files TAP itself leaves in the directory: a record, and a writer's staging file. */
const OWN_FILE = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\.json|\.tap\.[0-9a-z]+\.[0-9a-f]{8}\.tmp)$/;

/**
 * `tap uninstall`: remove every record on a bus and then the directory, when
 * nothing else is in it. Returns the directory when it existed and is gone.
 */
export function removePermissionRequestDir(bus: string): string | null {
  // A symlink here leads outside the bus: its target's files are not TAP's to delete.
  const directory = ownedDir(bus);
  if (!directory) return null;
  try {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (OWN_FILE.test(name) && regularFile(path)) unlinkSync(path);
    }
    rmdirSync(directory);
    return directory;
  } catch {
    return null;
  }
}

/** The hook starts after Claude marks the session waiting; allow a second of clock slack. */
const WAIT_START_SLACK_MS = 1000;

/**
 * The request a seat is waiting on right now, or null. `expect` is the seat's
 * registered session and the pane this observation read. Never throws: a
 * record or session file TAP cannot use shows nothing. With `remove: false`,
 * for a named read of another team's bus, nothing is deleted.
 */
export function pendingPermissionRequest(
  bus: string,
  handle: string,
  expect: { sessionId: string; paneId: string; serverEpoch: string },
  options: { remove?: boolean } = {},
): PendingPermissionRequest | null {
  try {
    // Only names listed here are ever removed, so a record the hook writes after this line is safe.
    const files = permissionRequestFiles(bus, handle);
    const path = files.pop();
    if (!path) return null;
    const drop = (file: string): void => { if (options.remove !== false) remove(file); };
    // A newer request supersedes the seat's older ones.
    for (const older of files) drop(older);
    const record = readRecord(path);
    if (record === "missing" || record === "foreign") return null;
    if (record === "invalid") { drop(path); return null; }
    const stale = (): null => { drop(path); return null; };
    if (!expect.sessionId || record.session !== expect.sessionId) return stale();
    if (record.pane_id !== expect.paneId || (record.server_epoch && expect.serverEpoch && record.server_epoch !== expect.serverEpoch)) return stale();
    const state = readClaudeSessionState(record.session_file);
    if (state === "missing") return stale();
    // Present but unusable (mid-rewrite, or a format TAP does not know): show nothing, judge nothing.
    if (state === "unreadable" || !state.status) return null;
    // A crashed Claude leaves its file behind, still saying whatever it said last.
    if (state.sessionId !== record.session || state.status !== "waiting" || !alive(state.pid)) return stale();
    // A record older than this wait belongs to an earlier request.
    if (state.statusUpdatedAt === null) return null;
    if (record.at < state.statusUpdatedAt - WAIT_START_SLACK_MS) return stale();
    return { tool: record.tool, summary: record.summary, since: Math.floor(record.at / 1000), waitingFor: state.waitingFor };
  } catch {
    return null;
  }
}
