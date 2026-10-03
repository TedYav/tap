// Per-harness session-store attribution (tap-iee8) — native port of
// skills/tap/scripts/session/session_store.py `derive`, same four invariants:
//
// 1. READ-ONLY AND SIDE-EFFECT-FREE: live stores are opened read-only; nothing
//    here writes, migrates, or locks a store.
// 2. NEVER RAISES: missing, unreadable, corrupt, or schema-drifted stores yield
//    trust "none" plus a human-readable detail, never an exception.
// 3. DERIVED IS NOT AUTHORITATIVE: "env" and "process" are authoritative; a
//    derived id can never satisfy an expected-id equality check. Directory
//    matching is exact but a directory does not identify a PANE — ambiguity is
//    resolved by REFUSING (container path, no id).
// 4. NEVER DISAMBIGUATE BY TIME: newest-first is a scan-ORDER optimization to
//    find a cwd match fast, never an identity tiebreak (native resume decouples
//    session identity from the registration event).
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, normalize, sep } from "node:path";
import { Database } from "bun:sqlite";

export const HARNESSES = ["claude", "codex", "opencode", "cursor", "antigravity"] as const;

/** Registry harness values that alias a canonical deriver key. */
const HARNESS_ALIAS: Record<string, string> = { agy: "antigravity" };

/** Harnesses that volunteer their session id under their OWN env var — a native
 * env id is still tier-1 authoritative. agy exports ANTIGRAVITY_CONVERSATION_ID
 * live in-session, so a bare-registered agy seat is attributable with no scan. */
const NATIVE_ENV_ID: Record<string, string> = { antigravity: "ANTIGRAVITY_CONVERSATION_ID" };

/** Env keys that carry a harness identity or the calling seat. A child process must mint
 * its own; keep in sync with runtime/bun/test/run.sh and sandbox-pins.sh. */
export const INHERITED_IDENTITY_ENV = [
  "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "OPENCODE_SESSION_ID", "CURSOR_CONVERSATION_ID",
  "ANTIGRAVITY_CONVERSATION_ID", "TAP_HARNESS_SESSION_ID", "TAP_TRANSCRIPT_PATH", "TAP_SESSION_SOURCE", "TAP_SELF",
  // Launch evidence (launch-evidence.ts): only the launch that plants them may carry them.
  "TAP_LAUNCH_ROOT", "TAP_LAUNCH_ID",
] as const;

/** Ordered weakest -> strongest. Consumers may compare by index. */
export const TRUST_LEVELS = ["none", "derived_ambiguous", "derived_unique", "process", "env"] as const;
export type Trust = (typeof TRUST_LEVELS)[number];

/** What store_path points AT, so a consumer never infers file-vs-dir from trust:
 * file — one session's own file; dir — the CONTAINER of several candidates
 * (ambiguous only); db — a multi-session database; "" — nothing located. */
export const STORE_KINDS = ["", "file", "dir", "db"] as const;

/** Hard ceilings for the codex rollout walk: newest-first means the match (if
 * any) is found immediately, so these only bound the pathological case. */
const CODEX_MAX_DAY_DIRS = 60;
const CODEX_MAX_FILES = 500;

/** Two rollouts for ONE cwd whose mtimes fall inside this window are plausibly
 * two concurrent seats sharing a worktree — genuinely ambiguous. Anything older
 * is historical and must not make the current session ambiguous. */
const CODEX_CONCURRENCY_WINDOW_S = 6 * 3600;

export interface Attribution {
  harness: string;
  store_path: string;
  store_kind: string;
  harness_session_id: string;
  trust: Trust;
  candidates: number;
  detail: string;
  derived_at: string;
}

/** Injectable process runner (tests stage ps/lsof without a real process tree). */
export interface ProcResult { status: number | null; stdout: string; stderr: string; timedOut?: boolean }
export type ProcRunner = (argv: string[]) => ProcResult;

/** The production runner. The deleted Python owner ran every observation with
 * `subprocess.run(..., timeout=2)`; that per-call bound is part of the
 * never-block-registration contract, so a hung ps/lsof is killed and reported
 * as timedOut — degrading to no-authority, never blocking registration. */
export function defaultProc(argv: string[]): ProcResult {
  const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", timeout: 2000, env: { ...process.env, TZ: "UTC", LC_ALL: "C" } });
  return { status: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString(), timedOut: r.exitCode === null };
}

function result(harness: string, storePath = "", sessionId = "", trust: Trust = "none",
  detail = "", candidates = 0, kind = "", derivedAt = ""): Attribution {
  return {
    harness,
    store_path: storePath,
    store_kind: kind,
    harness_session_id: sessionId,
    trust,
    candidates,
    detail,
    derived_at: derivedAt,
  };
}

/** Normalize a filesystem path for comparison WITHOUT resolving symlinks: the
 * stores record the directory the harness was started in, and a worktree
 * reached through a symlinked parent must still match that string. */
function norm(p: string | undefined | null): string {
  if (!p) return "";
  return normalize(String(p)).replace(/\/+$/, "");
}

function nowIso(clock?: string): string {
  if (clock !== undefined) return clock;
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** First line of a file, bounded — a truncated/rotating rollout is skipped by
 * the caller, never fatal. */
function firstLine(path: string, cap = 1 << 20): string {
  const fd = openSync(path, "r");
  try {
    let text = "";
    const buf = Buffer.alloc(65536);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      text += buf.toString("utf8", 0, n);
      const nl = text.indexOf("\n");
      if (nl >= 0) return text.slice(0, nl);
      if (text.length >= cap) return text;
    }
    return text;
  } finally {
    closeSync(fd);
  }
}

/** Head JSON object of a rollout file: the first line parsed, `null` when the
 * line is not a JSON object. */
function headJson(path: string): Record<string, unknown> | null {
  const head = firstLine(path);
  let parsed: unknown;
  try { parsed = JSON.parse(head); } catch { return null; }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}
function mtimeOf(p: string): number | null {
  try { return statSync(p).mtimeMs / 1000; } catch { return null; }
}
function md5Hex(s: string): string {
  return createHash("md5").update(s, "utf8").digest("hex");
}
/** Python `realpath` is non-strict; mirror that by falling back to the input. */
function realPathLenient(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// --- per-harness derivation ---------------------------------------------------

function deriveClaude(worktree: string, home: string): Attribution {
  // ~/.claude/projects/<worktree with '/' -> '-'>/<session-uuid>.jsonl
  const slug = norm(worktree).replaceAll("/", "-");
  const proj = join(home, ".claude", "projects", slug);
  if (!isDir(proj)) return result("claude", "", "", "none", `no claude project dir for worktree (${proj})`);
  const files = readdirSync(proj).filter((f) => f.endsWith(".jsonl") && isFile(join(proj, f))).map((f) => join(proj, f));
  if (files.length === 0) return result("claude", "", "", "none", "claude project dir has no transcript jsonl");
  if (files.length > 1) {
    // Ambiguous: hand back the CONTAINER, never the newest file. Naming one
    // candidate's file is the same guess we refuse to make for the id.
    return result("claude", proj, "", "derived_ambiguous",
      `${files.length} transcripts in project dir; enumerate to disambiguate`, files.length, "dir");
  }
  const sid = basename(files[0]!).replace(/\.jsonl$/, "");
  return result("claude", files[0]!, sid, "derived_unique", "1 transcript", 1, "file");
}

function deriveCodex(worktree: string, home: string): Attribution {
  // ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl; first record carries
  // payload.cwd (the worktree) and payload.id (the session id).
  const root = join(home, ".codex", "sessions");
  if (!isDir(root)) return result("codex", "", "", "none", `no codex sessions dir (${root})`);
  const target = norm(worktree);
  const dayDirs = listDayDirs(root).slice(0, CODEX_MAX_DAY_DIRS);
  let scanned = 0;
  let capped = false;
  const matches: Array<{ mtime: number; path: string; sid: string }> = []; // newest-first
  for (const day of dayDirs) {
    const rollouts = readdirSync(day).filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"))
      .sort().reverse().map((f) => join(day, f));
    for (const f of rollouts) {
      if (scanned >= CODEX_MAX_FILES) { capped = true; break; }
      scanned += 1;
      const meta = headJson(f);
      if (!meta) continue; // a truncated/rotating rollout is skipped, never fatal
      const payload = meta.payload && typeof meta.payload === "object" ? meta.payload as Record<string, unknown> : {};
      if (norm(typeof payload.cwd === "string" ? payload.cwd : "") !== target) continue;
      const mtime = mtimeOf(f);
      if (mtime === null) continue;
      matches.push({ mtime, path: f, sid: String(payload.id ?? "") });
    }
    // Two concurrent seats write into the same day; one extra day is enough to
    // decide concurrency, so stop as soon as we can answer.
    if (matches.length > 1) break;
    if (capped) break;
  }
  if (matches.length === 0) {
    return result("codex", "", "", "none",
      `no rollout with cwd=${target} in ${scanned} scanned files${capped ? " (scan cap hit)" : ""}`);
  }
  matches.sort((a, b) => (b.mtime - a.mtime)
    || (b.path > a.path ? 1 : b.path < a.path ? -1 : 0)
    || (b.sid > a.sid ? 1 : b.sid < a.sid ? -1 : 0));
  const newest = matches[0]!;
  const concurrent = matches.slice(1).filter((m) => newest.mtime - m.mtime <= CODEX_CONCURRENCY_WINDOW_S);
  if (concurrent.length > 0) {
    // Several seats plausibly live in this one worktree — the newest rollout is
    // not provably THIS pane's. Container, no id.
    return result("codex", root, "", "derived_ambiguous",
      `${concurrent.length + 1} rollouts for cwd=${target} within ${CODEX_CONCURRENCY_WINDOW_S}s; enumerate to disambiguate`,
      concurrent.length + 1, "dir");
  }
  if (!newest.sid) {
    return result("codex", newest.path, "", "derived_ambiguous", "rollout cwd match but no payload.id", 1, "file");
  }
  return result("codex", newest.path, newest.sid, "derived_unique", "rollout cwd match", 1, "file");
}

function listDayDirs(root: string): string[] {
  const days: string[] = [];
  for (const a of readdirSync(root)) {
    const pa = join(root, a);
    if (!isDir(pa)) continue;
    for (const b of readdirSync(pa)) {
      const pb = join(pa, b);
      if (!isDir(pb)) continue;
      for (const c of readdirSync(pb)) {
        const pc = join(pb, c);
        if (isDir(pc)) days.push(pc);
      }
    }
  }
  return days.sort().reverse();
}

/** tap-0zip2: OpenCode indexes `session` only on project_id/workspace_id/parent_id, so a
 * bare `WHERE directory = ?` is a SCAN of every session. A session's project_id is the
 * project resolved when it was created (its directory may be a subdirectory of the project
 * root or a sandbox worktree) or `global` (non-git; sessions are reassigned off `global`
 * only where directory equals the opened root). So the candidates are `global` plus every
 * project that owns the target or one of its ancestors, via project_directory, project.worktree
 * or project.sandboxes -- tables with one row per repository, not per session. The session read
 * is then a seek per candidate project, pinned INDEXED BY so a store without the index fails
 * closed rather than scanning.
 *
 * The candidate set is NOT provably complete: a v2-created session in a worktree that was not
 * appended to project.sandboxes, or a moved session (move keeps project_id and rewrites only
 * directory), can sit under a project whose metadata never names the directory. So a hit here
 * can never certify uniqueness -- see deriveOpencode, which reports hits as ambiguous. */
export const OPENCODE_SESSION_SQL = (ancestors: number) => `WITH anc(d) AS (VALUES ${Array(ancestors).fill("(?)").join(",")})
SELECT id FROM session INDEXED BY session_project_idx
WHERE directory = ? AND project_id IN (
  SELECT 'global'
  UNION SELECT project_id FROM project_directory WHERE directory IN (SELECT d FROM anc)
  UNION SELECT id FROM project WHERE worktree IN (SELECT d FROM anc)
  UNION SELECT p.id FROM project p, json_each(p.sandboxes) j WHERE j.value IN (SELECT d FROM anc))
LIMIT 5`;

/** `path` and each parent up to (excluding) the filesystem root. */
function selfAndAncestors(path: string): string[] {
  const out: string[] = [];
  for (let p = path; p && p !== "/" && p !== "."; p = dirname(p)) out.push(p);
  return out;
}

function deriveOpencode(worktree: string, home: string): Attribution {
  // ~/.local/share/opencode/opencode.db — session.directory is the worktree.
  const db = join(home, ".local", "share", "opencode", "opencode.db");
  if (!isFile(db)) return result("opencode", "", "", "none", `no opencode.db (${db})`);
  const target = norm(worktree);
  let rows: Array<{ id: string }> = [];
  try {
    // Read-only handle on a LIVE store (a running seat holds it in WAL mode);
    // corruption surfaces as a caught failure, never a crash.
    const conn = new Database(db, { readonly: true });
    try {
      const ancestors = selfAndAncestors(target);
      if (ancestors.length > 0) {
        rows = conn.query(OPENCODE_SESSION_SQL(ancestors.length)).all(...ancestors, target) as Array<{ id: string }>;
      }
    } finally {
      conn.close();
    }
  } catch (e) {
    return result("opencode", db, "", "none", `opencode.db unreadable: ${(e as Error).message}`);
  }
  // The db is the store whatever the hit count, so store_path is always the db (kind "db").
  // A hit is never "unique": session.directory is unindexed, so sessions filed under a project
  // OpenCode's metadata does not tie to this directory are unseen (see OPENCODE_SESSION_SQL).
  // Ambiguity is resolved by refusing (invariant 3): no id, only the container. The authoritative
  // id arrives from the harness's own SessionStart env/hook, never from this guess.
  if (rows.length === 0) {
    return result("opencode", db, "", "none", `no indexed session row with directory=${target}`, 0, "db");
  }
  return result("opencode", db, "", "derived_ambiguous",
    `${rows.length} indexed session(s) with directory=${target}; session.directory is unindexed so uniqueness is unprovable`, rows.length, "db");
}

/** Cursor's per-chat store for one worktree+uuid: the layout deriveCursor scans,
 * <cursor-root>/chats/<md5(norm(worktree))>/<chat-uuid>/store.db. `cursorRoot` is
 * the harness root (~/.cursor or its env override), so the launcher's resume-artifact
 * probe shares this exact layout instead of re-deriving the hash (tap-we6b). */
export function cursorChatStorePath(cursorRoot: string, worktree: string, chatUuid: string): string {
  return join(cursorRoot, "chats", md5Hex(norm(worktree)), chatUuid, "store.db");
}

function deriveCursor(worktree: string, home: string): Attribution {
  // ~/.cursor/chats/<md5(worktree)>/<chat-uuid>/store.db
  const root = join(home, ".cursor");
  const ws = md5Hex(norm(worktree));
  const wsDir = join(root, "chats", ws);
  if (!isDir(wsDir)) return result("cursor", "", "", "none", `no cursor chats dir for workspace hash ${ws}`);
  const chats = readdirSync(wsDir).filter((d) => isFile(cursorChatStorePath(root, worktree, d))).map((d) => join(wsDir, d));
  if (chats.length === 0) {
    return result("cursor", "", "", "none", `cursor workspace ${ws} has no chat with store.db`);
  }
  // NOTE: cursor's store.db is per-CHAT (a per-session FILE store) and is
  // encrypted/boundary-flushed (tap-commander WO-K2), so this path has
  // ATTRIBUTION value only and is never a readable session-state source.
  if (chats.length > 1) {
    return result("cursor", wsDir, "", "derived_ambiguous",
      `${chats.length} chats in workspace ${ws}; enumerate to disambiguate`, chats.length, "dir");
  }
  const newest = chats[0]!;
  return result("cursor", cursorChatStorePath(root, worktree, basename(newest)), basename(newest), "derived_unique", "1 chat in workspace", 1, "file");
}

function deriveAntigravity(): Attribution {
  // agy's store is keyed by the conversation id, which it volunteers LIVE in
  // env; that env path is handled in derive() and needs no scan. Reaching this
  // worktree-only deriver means the env id was absent — report none loudly
  // rather than guess.
  return result("antigravity", "", "", "none",
    "no ANTIGRAVITY_CONVERSATION_ID in env; agy attribution needs the live env id (no worktree fallback implemented)");
}

const DERIVERS: Record<string, (worktree: string, home: string) => Attribution> = {
  claude: deriveClaude,
  codex: deriveCodex,
  opencode: deriveOpencode,
  cursor: deriveCursor,
  antigravity: () => deriveAntigravity(),
};

/** Harnesses whose store path is built FROM the session id, not scanned by
 * worktree: agy's transcript lives under the conversation id, so once we have
 * the id the path is exact — no scan, and no worktree ambiguity is possible. */
function storeFromId(canon: string, id: string, home: string): [string, string] | null {
  if (canon === "antigravity" && id) {
    return [join(home, ".gemini", "antigravity-cli", "brain", id, ".system_generated", "logs", "transcript.jsonl"), "file"];
  }
  return null;
}

/** Store path implied by env capture ALONE — no filesystem scan. A provided
 * transcript is the path; else an id-keyed builder (agy) places it from the id. */
function envStorePath(canon: string, envId: string, envTranscript: string, home: string): [string, string] {
  if (envTranscript) return [envTranscript, "file"];
  return storeFromId(canon, envId, home) ?? ["", ""];
}

/** Run a worktree deriver under invariant 2: it never raises into registration. */
function safeBase(fn: (worktree: string, home: string) => Attribution, harness: string, worktree: string, home: string): Attribution {
  try {
    return fn(norm(worktree), home);
  } catch (e) {
    return result(harness, "", "", "none", `derivation error: ${(e as Error)?.message ?? String(e)}`);
  }
}

interface ProcRow { ppid: number; lstart: string; comm: string }

// The whole table, even for the `after` re-check that compares only the
// descendants: on macOS `ps -p` with two or more pids took 0.4-0.9 s where the
// full `-axo` table takes ~0.07 s (measured 2026-09-23, verb-prelude row F).
function processSnapshot(run: ProcRunner): Record<number, ProcRow> {
  // Include start time so a recycled PID cannot complete an observation.
  const r = run(["ps", "-axo", "pid=,ppid=,lstart=,comm="]);
  if (r.timedOut || r.status !== 0) throw new Error("ps failed");
  const rows: Record<number, ProcRow> = {};
  for (const line of r.stdout.split("\n")) {
    const t = line.trim().split(/\s+/).filter((x) => x !== "");
    if (t.length === 0) continue;
    let fields: string[];
    if (t.length > 8) fields = [...t.slice(0, 7), t.slice(7).join(" ")];
    else fields = t;
    if (fields.length === 8 && /^\d+$/.test(fields[0]!) && /^\d+$/.test(fields[1]!)) {
      rows[Number(fields[0])] = { ppid: Number(fields[1]), lstart: fields.slice(2, 7).join(" "), comm: fields[7]! };
    }
  }
  return rows;
}

export interface ProcessObservation { identity: Attribution | null; refusal: string }

/** Observe one harness process beneath the pane and one open session file.
 * A shared database is not a conversation identifier. Multiple topmost harness
 * processes or files, a changed ancestry, and failed observations supply no
 * authority. The refusal string names WHY authority was refused so callers can
 * remediate; it is empty exactly when identity is present. */
export function observeProcessStore(run: ProcRunner, harness: string, worktree: string, home: string, panePid: string): ProcessObservation {
  const none = (refusal: string): ProcessObservation => ({ identity: null, refusal });
  if (!(harness === "codex" || harness === "claude") || !/^\d+$/.test(panePid)) return none("unsupported_harness");
  const root = Number(panePid);
  let before: Record<number, ProcRow>;
  try { before = processSnapshot(run); } catch { return none("tools_unavailable"); }
  if (!(root in before)) return none("pane_process_gone");
  const descendants = new Set<number>([root]);
  let exhausted = true;
  for (let i = 0; i < 64; i++) {
    const added: number[] = [];
    for (const [pid, row] of Object.entries(before)) {
      const p = Number(pid);
      if (descendants.has(row.ppid) && !descendants.has(p)) added.push(p);
    }
    if (added.length === 0) { exhausted = false; break; }
    for (const pid of added) descendants.add(pid);
  }
  if (exhausted) return none("snapshot_unsettled"); // BFS did not settle within the bound: no authority
  // Structural owner choice: a candidate whose ancestry to the pane root passes
  // through ANOTHER candidate is a nested tool child of the harness (a working
  // seat routinely spawns helpers named like the harness itself) — it cannot be
  // the pane's harness. Ancestry, never time, decides (invariant 4). Sibling
  // harness processes both remain candidates and still refuse.
  const candidates = [...descendants].filter((pid) => basename(before[pid]!.comm) === harness);
  const topmost = candidates.filter((pid) => {
    // A snapshot missing an ancestor row cannot disprove topmostness; the walk
    // stops there rather than throwing (ps output is environment-truncated at
    // the edges, and the BFS already proved the pane side). The walk TESTS the
    // pane root too — on a launched seat the root itself is the harness, so a
    // root candidate must shadow its nested namesakes — and it stops as soon
    // as it leaves the pane's descendants, so the tree above the pane (tmux
    // server and beyond) can never disqualify a candidate.
    for (let p = before[pid]!.ppid; before[p] !== undefined; p = before[p]!.ppid) {
      if (candidates.includes(p)) return false;
      if (!descendants.has(p)) break;
    }
    return true;
  });
  if (topmost.length !== 1) return none(topmost.length === 0 ? "owners_absent" : "owners_ambiguous");
  const owner = topmost[0]!;
  // Only the harness and its path back to the pane establish ownership.
  // Tool children (including this observation's ps/lsof) may exit normally.
  const lineage = new Set<number>();
  for (let pid = owner; ; pid = before[pid]!.ppid) {
    lineage.add(pid);
    if (pid === root) break;
  }
  // Claude closes idle transcripts, but maintains a PID-scoped live session
  // record across /clear and /resume. Bind it to this exact process generation;
  // argv's --session-id is only the launch identity and can be stale.
  if (harness === "claude") {
    const manifestPath = join(home, ".claude", "sessions", `${owner}.json`);
    let live: Record<string, unknown> | null = null;
    try { live = headJson(manifestPath); } catch { /* older Claude has no PID record */ }
    if (live && live.pid === owner && typeof live.sessionId === "string" && UUID_RE.test(live.sessionId) &&
        typeof live.cwd === "string" && norm(live.cwd) === norm(worktree) &&
        typeof live.procStart === "string" && live.procStart.trim().replace(/\s+/g, " ") === before[owner]!.lstart &&
        live.kind === "interactive") {
      const path = join(home, ".claude", "projects", norm(worktree).replaceAll("/", "-"), `${live.sessionId}.jsonl`);
      let after: Record<number, ProcRow>;
      try { after = processSnapshot(run); } catch { return none("tools_unavailable"); }
      const again = headJson(manifestPath);
      // The manifest re-read and lineage stability carry the authority; the
      // transcript file is created lazily on the session's first turn, so its
      // absence adds no evidence either way (discuss F3).
      if (again?.sessionId === live.sessionId && again?.pid === live.pid &&
          again?.procStart === live.procStart && again?.cwd === live.cwd &&
          [...lineage].every(pid => after[pid]?.ppid === before[pid]!.ppid &&
            after[pid]?.lstart === before[pid]!.lstart && after[pid]?.comm === before[pid]!.comm)) {
        return { identity: result(harness, path, live.sessionId, "process", `live session record for pane process ${owner}`, 1, "file"), refusal: "" };
      }
      return none("lineage_unstable");
    }
  }
  let opened: ProcResult;
  try { opened = run(["lsof", "-a", "-p", String(owner), "-Fn"]); } catch { return none("tools_unavailable"); }
  if (opened.timedOut || opened.status !== 0) return none("tools_unavailable");
  let after: Record<number, ProcRow>;
  try { after = processSnapshot(run); } catch { return none("tools_unavailable"); }
  for (const pid of lineage) {
    if (after[pid]?.ppid !== before[pid]!.ppid || after[pid]?.lstart !== before[pid]!.lstart || after[pid]?.comm !== before[pid]!.comm) {
      return none("lineage_unstable");
    }
  }
  // The owner's own working directory is the instrument that can refuse the
  // match: lsof reports it as the `fcwd` descriptor, and an observable fcwd
  // that disagrees with the worktree the caller named for this pane means the
  // open session file is not this pane's session. A MISSING fcwd is not
  // evidence the check is unnecessary — an empty result cannot license the
  // binding (licensing-zero rule, discuss F4).
  const storeRoot = realPathLenient(harness === "codex"
    ? join(home, ".codex", "sessions")
    : join(home, ".claude", "projects", norm(worktree).replaceAll("/", "-")));
  let fcwd = "";
  for (const line of opened.stdout.split("\n")) {
    if (line === "fcwd") { fcwd = "pending"; continue; }
    if (fcwd === "pending") {
      if (line.startsWith("n")) fcwd = realPathLenient(line.slice(1));
      break;
    }
  }
  if (fcwd === "" || fcwd === "pending") return none("fcwd_unavailable");
  // lsof reports the RESOLVED path; resolve the caller's worktree the same
  // way, or a symlinked checkout (macOS /tmp aliases, linked worktrees)
  // false-refuses as fcwd_mismatch.
  if (norm(fcwd) !== norm(realPathLenient(worktree))) return none("fcwd_mismatch");
  const matches = new Set<string>();
  for (const line of opened.stdout.split("\n")) {
    if (!line.startsWith("n")) continue;
    const path = realPathLenient(line.slice(1));
    if (!path.startsWith(storeRoot + sep) || !path.endsWith(".jsonl")) continue;
    if (!isFile(path)) continue;
    let sid: string;
    if (harness === "codex") {
      if (!basename(path).startsWith("rollout-")) continue;
      const meta = headJson(path);
      if (!meta) continue; // malformed first line: not a session_meta
      const payload = meta.payload && typeof meta.payload === "object" ? meta.payload as Record<string, unknown> : {};
      sid = typeof payload.id === "string" ? payload.id : "";
      if (meta.type !== "session_meta" || norm(typeof payload.cwd === "string" ? payload.cwd : "") !== norm(worktree)) continue;
      // A Codex CLI/TUI process keeps its own rollout and same-cwd subagent
      // rollouts open. The marker is an own `subagent` key on a source object
      // in session_meta, not an array and not the filename.
      const source = payload.source;
      if (source !== null && typeof source === "object" && !Array.isArray(source) && Object.hasOwn(source, "subagent")) continue;
      if (!basename(path).endsWith(`-${sid}.jsonl`)) continue;
    } else {
      if (dirname(path) !== storeRoot) continue;
      sid = basename(path).slice(0, -6);
    }
    if (!UUID_RE.test(sid)) continue;
    matches.add(JSON.stringify([path, sid]));
  }
  if (matches.size !== 1) return none(matches.size === 0 ? "no_open_session" : "owners_ambiguous_session_files");
  const [path, sid] = JSON.parse([...matches][0]!) as [string, string];
  return { identity: result(harness, path, sid, "process", `open session file held by pane process ${owner}`, 1, "file"), refusal: "" };
}

/** Boolean view of the process tier for derive(): present identity or null. */
export function processStore(run: ProcRunner, harness: string, worktree: string, home: string, panePid: string): Attribution | null {
  return observeProcessStore(run, harness, worktree, home, panePid).identity;
}

export interface DeriveOpts {
  /** Fake HOME for tests; defaults to the process home. */
  home?: string;
  /** Injectable environment; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Fixed derived_at stamp for tests. */
  clock?: string;
  /** Pane pid for the process-held observation tier. */
  panePid?: string | number | null;
  /** Injectable ps/lsof runner for tests; defaults to Bun.spawnSync. */
  run?: ProcRunner;
}

export function derive(harnessArg: string | undefined | null, worktree: string | undefined | null, opts: DeriveOpts = {}): Attribution {
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const home = opts.home ?? homedir();
  const run = opts.run ?? defaultProc;
  const harness = (harnessArg ?? "").trim().toLowerCase();
  const canon = HARNESS_ALIAS[harness] ?? harness; // 'agy' -> 'antigravity'
  const stamp = nowIso(opts.clock);
  const stamped = (res: Attribution): Attribution => {
    res.derived_at = stamp;
    res.harness = harness; // echo the normalized value the caller passed (e.g. 'agy')
    return res;
  };

  // Tier-1 env id: the generic launcher var OR the harness's own native var.
  const nativeVar = NATIVE_ENV_ID[canon] ?? "";
  const envId = (env.TAP_HARNESS_SESSION_ID || (nativeVar ? env[nativeVar] : "") || "").trim();
  const envTranscript = (env.TAP_TRANSCRIPT_PATH || "").trim();
  const base = DERIVERS[canon];

  // Tier-1 env capture wins and is authoritative. It needs NO filesystem scan
  // when the store path is placeable from env alone; only when neither gives a
  // path do we scan the worktree just for the path.
  if (envId || envTranscript) {
    const [store, kind] = envStorePath(canon, envId, envTranscript, home);
    let cands = 0;
    let detail = "env capture" + (base === undefined ? " (harness not mapped)" : "");
    if (!store && base !== undefined && norm(worktree)) {
      const out = safeBase(base, harness, worktree!, home);
      const storePath = out.store_path, kindOut = out.store_kind;
      cands = out.candidates;
      if (storePath) {
        detail = "env capture (+derived store_path)";
        return stamped(result(harness, storePath, envId, "env", detail, cands, kindOut));
      }
    }
    return stamped(result(harness, store, envId, "env", detail, cands, kind));
  }

  if (opts.panePid !== undefined && opts.panePid !== null) {
    let observed: Attribution | null = null;
    try {
      observed = processStore(run, canon, worktree ?? "", home, String(opts.panePid));
    } catch {
      observed = null; // unavailable tools, timeouts, malformed files: no authority
    }
    if (observed) return stamped(observed);
  }

  // No env id: pure tier-2 derivation, which needs a worktree.
  if (base === undefined) {
    return stamped(result(harness, "", "", "none", `harness '${harness}' has no mapped session store`));
  }
  if (!norm(worktree)) {
    return stamped(result(harness, "", "", "none", "no worktree given; cannot derive"));
  }
  return stamped(safeBase(base!, harness, worktree!, home));
}

// --- CLI door (pure transport for Bash consumers) -----------------------------

export function cliDerive(argv: string[], env: Record<string, string | undefined> = process.env): number {
  let harness = "", worktree = "", home: string | undefined, panePid: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--harness") harness = argv[++i] ?? "";
    else if (a === "--worktree") worktree = argv[++i] ?? "";
    else if (a === "--home") home = argv[++i] ?? undefined;
    else if (a === "--pane-pid") panePid = argv[++i] ?? undefined;
    else {
      process.stderr.write(`session-store: unknown argument '${a}'\n`);
      return 64;
    }
  }
  // Invariant 2 at the door too: a derivation failure is a result, not a crash.
  let out: Attribution;
  try {
    out = derive(harness, worktree, { home, env, panePid: panePid ?? null });
  } catch (e) {
    out = result((harness ?? "").trim().toLowerCase(), "", "", "none", `derivation error: ${(e as Error)?.message ?? String(e)}`);
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  return 0;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv[0] === "derive") process.exit(cliDerive(argv.slice(1)));
  process.stderr.write("session-store: unknown command; expected 'derive --harness H --worktree W [--home P] [--pane-pid N]'\n");
  process.exit(64);
}
