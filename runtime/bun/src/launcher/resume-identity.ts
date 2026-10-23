// Pure resume-identity resolution over a filesystem snapshot.
// Claude chain: acting hsid → transcript_path id → quarantined → picker.
// Each exact step requires an on-disk transcript (tap-gc1n).
//
// revive_tier reads the RAW stored id, not the resolved target — that is
// why a ghost (stored id, absent transcript) prints revive_tier "exact"
// while resolving to picker / target null.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { AGENT_FAMILIES } from "../harness-families";
import { cursorChatStorePath } from "../session-store";
import { Notices } from "./catalog-notices";
import { resolveHarnessPolicy } from "./catalog";
import { isPolicyDegradedNotice } from "./catalog-listing";
import { launchWorkdir } from "./workdir";
import { LauncherError, type SessionRecord } from "./types";

export type ResumeSource =
  | "acting_hsid"
  | "transcript_path"
  | "quarantined"
  | "picker";

export type ResumeTarget = {
  session_id: string | null;
  source: ResumeSource;
  split_brain: boolean;
  disclosure: string | null;
};

export function claudeHome(env: NodeJS.ProcessEnv = process.env): string {
  // Python: os.environ.get("TAP_CLAUDE_HOME") or os.environ.get("CLAUDE_HOME", "~/.claude")
  // TAP uses truthiness (empty falls through); CLAUDE_HOME keeps a supplied empty
  // string. Path("").expanduser() is "." — not "~/.claude" via HOME.
  const raw =
    env.TAP_CLAUDE_HOME ||
    (env.CLAUDE_HOME !== undefined ? env.CLAUDE_HOME : "~/.claude");
  // tap-jevu6.1: under Bun, homedir() (like userInfo().homedir) reads the launcher's
  // startup $HOME else passwd, so this fallback consults ambient state and can diverge
  // from Python's passwd expansion when the frozen env omits HOME — dark today (no
  // production caller of planResume/planJson); the real fix is beaded.
  const home = env.HOME !== undefined ? env.HOME : homedir();
  if (raw === "~" || raw.startsWith("~/")) {
    return (home.replace(/\/+$/, "") + raw.slice(1)) || "/";
  }
  return raw === "" ? "." : raw;
}

export function claudeSessionTranscriptExists(
  sessionId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  home: string = claudeHome(env),
): boolean {
  if (!sessionId) return false;
  const projects = join(home, "projects");
  try {
    for (const name of readdirSync(projects)) {
      try {
        if (statSync(join(projects, name, `${sessionId}.jsonl`)).isFile()) {
          return true;
        }
      } catch {
        // missing path under this project
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function transcriptPathSessionId(
  transcriptPath: string | null | undefined,
): string | null {
  if (!transcriptPath) return null;
  const name = basename(transcriptPath);
  if (name.endsWith(".jsonl") && name.length > 6) {
    return name.slice(0, -".jsonl".length);
  }
  return null;
}

export function resolveResumeTarget(
  record: SessionRecord,
  env: NodeJS.ProcessEnv = process.env,
): ResumeTarget {
  if (record.harness !== "claude") {
    return {
      session_id: record.harness_session_id ?? null,
      source: "acting_hsid",
      split_brain: false,
      disclosure: null,
    };
  }

  const hsid =
    typeof record.harness_session_id === "string"
      ? record.harness_session_id
      : null;
  const tpathId = transcriptPathSessionId(record.transcript_path ?? null);
  const split = Boolean(hsid && tpathId && hsid !== tpathId);

  if (hsid && claudeSessionTranscriptExists(hsid, env)) {
    return {
      session_id: hsid,
      source: "acting_hsid",
      split_brain: split,
      disclosure: null,
    };
  }
  if (tpathId && claudeSessionTranscriptExists(tpathId, env)) {
    return {
      session_id: tpathId,
      source: "transcript_path",
      split_brain: hsid ? true : split,
      disclosure: null,
    };
  }
  const qid =
    typeof record.quarantined_harness_session_id === "string"
      ? record.quarantined_harness_session_id
      : null;
  if (qid && claudeSessionTranscriptExists(qid, env)) {
    return {
      session_id: qid,
      source: "quarantined",
      split_brain: split,
      disclosure: "resuming quarantined session; attestation previously failed",
    };
  }
  return {
    session_id: null,
    source: "picker",
    split_brain: split,
    disclosure: null,
  };
}

/** Short tier word. Reads the RAW stored id, not the resolved target. */
export function reviveTier(
  harness: string | null | undefined,
  nativeId: string | null | undefined,
): string {
  if (!harness || !AGENT_FAMILIES.has(harness)) return "-";
  if (nativeId) return "exact";
  if (harness === "claude" || harness === "codex") return "picker";
  return "fresh";
}

/** The tier word for a seat whose stored id may name a conversation that never
 * persisted. Only a stopped cursor seat (not resumable, not attachable) with a
 * stored id is "stale": cursor writes no chat store before the first turn, so
 * resume refuses that id. Every other seat keeps its raw-id tier, read through
 * the resumable/attachable gate the launch uses. */
export function seatReviveTier(harness: string, storedId: string | null, resumable: boolean, attachable: boolean): string {
  if (!resumable && !attachable && harness === "cursor" && storedId) return "stale";
  return reviveTier(harness, resumable || attachable ? storedId : null);
}

/**
 * Python's `!r` for the two values the split-brain receipt interpolates.
 *
 * The first version was `` `'${value}'` `` -- quotes around the raw string, no
 * escaping -- which is right for the paths anyone pictures and wrong for three
 * shapes a real `transcript_path` can carry. Found by review
 * as an unverified lead and measured against CPython before fixing:
 *
 *     value                     CPython repr              the old version
 *     /t/o'brien.jsonl          "/t/o'brien.jsonl"        '/t/o'brien.jsonl'
 *     /t/back\slash.jsonl       '/t/back\\slash.jsonl'    '/t/back\slash.jsonl'
 *     /t/new\nline.jsonl        '/t/new\\nline.jsonl'     '/t/new<LF>line.jsonl'
 *
 * The third is the one that matters beyond cosmetics: an unescaped newline puts
 * a LITERAL line break inside a one-line receipt, so a reader splitting stderr
 * on newlines sees a truncated record followed by a fragment. A path can contain
 * a newline on every filesystem TAP runs on.
 *
 * Python's rule, which this reproduces: prefer single quotes; switch to double
 * quotes only when the string contains a `'` and no `"`; escape the backslash,
 * the quote actually used, and the C0 controls; leave printable non-ASCII alone,
 * because Python 3 `repr` does not escape it.
 */
export function pyRepr(value: string | null | undefined): string {
  if (value === null || value === undefined) return "None";
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of value) {
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${ch}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else {
      const code = ch.codePointAt(0)!;
      // C0 and DEL plus the C1 block, which CPython also escapes as \xNN.
      if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
        out += `\\x${code.toString(16).padStart(2, "0")}`;
      } else out += ch;
    }
  }
  return `${quote}${out}${quote}`;
}

/**
 * The resume-target receipts, byte-for-byte with `_emit_resume_target_receipts`
 * (launcher.py:1996).
 *
 * THIS IS NOT A NOTICE CHANNEL, and the distinction is load-bearing. The
 * incumbent writes these with four bare `print(..., file=sys.stderr)` calls: no
 * command-scoped dedup. Routing them through the catalog's `Notices` sink would
 * hide a second build instead of preventing it, and two independent launches
 * must each still report their own diagnostic.
 *
 * Once per launch comes from structure instead (tap-2qrt): a validation-only
 * build hands its resolver `discardReceipts`, and the real invocation build is
 * the one speaker. `notify_env_policy=False` still suppresses exactly the
 * config/env notices and NOT these.
 *
 * So: a plain writer, deliberately.
 */
export function emitResumeTargetReceipts(
  record: SessionRecord,
  target: ResumeTarget,
  write: (line: string) => void,
): void {
  if (target.split_brain) {
    write("tap session: resume_identity_split — " +
      `harness_session_id=${pyRepr(record.harness_session_id)} ` +
      `transcript_path=${pyRepr(record.transcript_path)}; ` +
      `using ${target.source}` +
      (target.session_id ? ` id=${target.session_id}` : "") +
      "; next: realign harness_session_id to the durable transcript");
  }
  if (target.disclosure) write(`tap session: ${target.disclosure}`);
  if (target.source === "picker") {
    write("tap session: no verified resume transcript; " +
      "falling through to id-less harness picker");
  } else if (target.source === "transcript_path" && !target.split_brain) {
    write(`tap session: resume target from transcript_path id=${target.session_id}`);
  }
}

// ---- resume artifact (conversation_artifact_missing) ----
// Moved here from collision.ts (which re-exports recordHasResumeArtifact) so
// resolvedResumeIdentity can consult the same probe without an import cycle:
// collision.ts already imports claudeHome from this module.

const expandUser = (path: string, env: NodeJS.ProcessEnv): string => path.replace(/^~(?=$|\/)/, env.HOME ?? "~");

/** default_codex_sessions_root. */
function codexSessionsRoot(env: NodeJS.ProcessEnv): string {
  return join(expandUser(env.TAP_CODEX_HOME || env.CODEX_HOME || "~/.codex", env), "sessions");
}

function sortedDirs(path: string): string[] {
  try { return readdirSync(path).filter(name => { try { return statSync(join(path, name)).isDirectory(); } catch { return false; } }).sort().reverse(); }
  catch { return []; }
}

function rolloutSessionMeta(path: string): Record<string, unknown> | null {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  for (const line of text.split("\n")) {
    let item: unknown;
    try { item = JSON.parse(line); } catch { continue; }
    if (item && typeof item === "object" && (item as { type?: unknown }).type === "session_meta") {
      const payload = (item as { payload?: unknown }).payload;
      if (payload && typeof payload === "object" && !Array.isArray(payload)) return payload as Record<string, unknown>;
    }
  }
  return null;
}

/** iter_codex_session_ids_for_cwd, unfiltered by start time: is any rollout for this cwd on disk? */
function codexRolloutForCwd(cwd: string, env: NodeJS.ProcessEnv): boolean {
  const root = codexSessionsRoot(env);
  const want = resolve(cwd);
  for (const year of sortedDirs(root)) for (const month of sortedDirs(join(root, year))) for (const day of sortedDirs(join(root, year, month))) {
    let rollouts: string[];
    try { rollouts = readdirSync(join(root, year, month, day)).filter(f => f.startsWith("rollout-") && f.endsWith(".jsonl")).sort().reverse(); }
    catch { continue; }
    for (const file of rollouts) {
      const meta = rolloutSessionMeta(join(root, year, month, day, file));
      if (meta && typeof meta.cwd === "string" && typeof meta.id === "string" && resolve(meta.cwd) === want) return true;
    }
  }
  return false;
}

/** The environment the relaunched Codex will see: its unset keys removed and its composed env (policy plus declared harness_env) laid
 * over the ambient env. TAP_CODEX_HOME is TAP's alias for the root, so a seat that declares or unsets CODEX_HOME has chosen its own. */
export function codexChildStoreEnv(ambient: NodeJS.ProcessEnv, child: { env: Record<string, string>; unset_env?: readonly string[] }): NodeJS.ProcessEnv {
  const seat: NodeJS.ProcessEnv = { ...ambient };
  for (const key of child.unset_env ?? []) delete seat[key];
  if (child.env.CODEX_HOME !== undefined || (child.unset_env ?? []).includes("CODEX_HOME")) delete seat.TAP_CODEX_HOME;
  return { ...seat, ...child.env };
}

/** Is a rollout with this session id on disk anywhere? `codex resume <id>` resolves ids across the whole store, not per cwd. */
export function codexSessionExists(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const root = codexSessionsRoot(env);
  for (const year of sortedDirs(root)) for (const month of sortedDirs(join(root, year))) for (const day of sortedDirs(join(root, year, month))) {
    let rollouts: string[];
    try { rollouts = readdirSync(join(root, year, month, day)).filter(f => f.startsWith("rollout-") && f.endsWith(`-${id}.jsonl`)); }
    catch { continue; }
    for (const file of rollouts) if (rolloutSessionMeta(join(root, year, month, day, file))?.id === id) return true;
  }
  return false;
}

/** The environment the seat's harness child runs with — catalog policy, then the
 * record's own env, then its unsets — so a native-store probe reads the store that
 * child will use; `declared` is the policy+record layer and `degraded` marks a
 * policy read that failed and was skipped. Null when the policy refuses. */
function composeSeatEnv(record: SessionRecord, env: NodeJS.ProcessEnv): { seat: NodeJS.ProcessEnv; declared: Record<string, string>; degraded: boolean } | null {
  let policy: Record<string, string>, degraded: boolean;
  try {
    const resolved = resolveHarnessPolicy(record.harness, env, new Notices(() => {}));
    policy = resolved.env;
    degraded = resolved.notices.some(isPolicyDegradedNotice);
  } catch (error) { if (error instanceof LauncherError) return null; throw error; }
  const declared = { ...policy, ...(record.harness_env ?? {}) };
  const seat: NodeJS.ProcessEnv = { ...env, ...declared };
  // The launch removes the unset keys last, so they beat every declared layer.
  for (const key of record.harness_unset_env ?? []) delete seat[key];
  return { seat, declared, degraded };
}

/** The seat child's environment, or null when its policy refused or could not be
 * read (unreadable, malformed or insecure config.toml): a store probe under an
 * unverified policy cannot answer for the child (tap-dt6kf). */
export function seatHarnessEnv(record: SessionRecord, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv | null {
  const composed = composeSeatEnv(record, env);
  return composed && !composed.degraded ? composed.seat : null;
}

/** The environment the seat's harness child reads its native store with, for a store probe that must agree with
 * the child: the composed seat env (policy, then the seat's declared env, then its unsets), minus TAP's own
 * aliases for a store root (`TAP_CLAUDE_HOME`, `TAP_CODEX_HOME`), which the launcher never passes to the child
 * and which the child would not read if it did. The child's store is therefore its own spelling when that is in
 * its effective env, declared or inherited (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), else the native default under
 * its HOME. Null when the policy refused or degraded: the root cannot be verified, and the launch itself answers
 * for the policy. */
export function seatStoreEnv(record: SessionRecord, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv | null {
  const composed = composeSeatEnv(record, env);
  if (composed === null || composed.degraded) return null;
  const { seat } = composed;
  delete seat.TAP_CLAUDE_HOME;
  delete seat.TAP_CODEX_HOME;
  return seat;
}

/** The Claude store root the seat child reads, from its `seatStoreEnv`: the child's own `CLAUDE_CONFIG_DIR`, else
 * `~/.claude` under the child's HOME, with `claudeHome`'s expansion and HOME-absent fallback; `CLAUDE_HOME` is a
 * TAP-side spelling the child does not read, so it is not consulted here. */
export function claudeChildStoreRoot(seat: NodeJS.ProcessEnv): string {
  return claudeHome({ ...seat, TAP_CLAUDE_HOME: seat.CLAUDE_CONFIG_DIR || "", CLAUDE_HOME: undefined });
}

/** The cursor seat's own view of its store root, as the relaunched harness will see it. It
 * composes the launch's tiers: the ambient env, then the catalog [harness.cursor.env]
 * policy, then the seat's declared harness_env, with the seat's unset keys removed from
 * all of them. A seat whose CURSOR_HOME is declared (by policy or the seat) or unset has
 * chosen its root, so that choice also outranks TAP's TAP_CURSOR_HOME alias. Null when the
 * policy refuses to read: the root cannot be verified, and the launch itself will refuse. */
function cursorStoreEnv(record: SessionRecord, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv | null {
  const composed = composeSeatEnv(record, env);
  if (composed === null) return null;
  const { seat, declared } = composed;
  if (declared.CURSOR_HOME !== undefined || (record.harness_unset_env ?? []).includes("CURSOR_HOME")) delete seat.TAP_CURSOR_HOME;
  return seat;
}

/** default_cursor_root: the harness root, matching the installer's TAP_CURSOR_HOME semantics.
 * A relative root is relative to the directory the seat's cursor runs in, not the caller's cwd. */
function cursorRoot(env: NodeJS.ProcessEnv, workdir: string): string {
  // With HOME absent, "~" must still reach the user's home (as claudeHome does),
  // never a relative "~/.cursor" under the cwd that reads every chat as stale.
  return resolve(workdir, expandUser(env.TAP_CURSOR_HOME || env.CURSOR_HOME || "~/.cursor", env.HOME !== undefined ? env : { ...env, HOME: homedir() }));
}

/** conversation_artifact_missing(record, ""): fails closed (present) when it cannot verify. */
function conversationArtifactMissing(record: SessionRecord, env: NodeJS.ProcessEnv): boolean {
  if (record.harness === "claude") {
    if (record.transcript_path) {
      try { return !statSync(record.transcript_path).isFile(); }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
    }
    if (!record.harness_session_id) return true;
    const projects = join(claudeHome(env), "projects");
    let names: string[];
    try { names = readdirSync(projects); } catch { return false; }
    return !names.some(name => { try { return statSync(join(projects, name, `${record.harness_session_id}.jsonl`)).isFile(); } catch { return false; } });
  }
  if (record.harness === "codex") return !codexRolloutForCwd(launchWorkdir(record), env);
  if (record.harness === "agy") {
    if (!record.harness_session_id) return true;
    const geminiHome = expandUser(env.TAP_GEMINI_HOME || env.GEMINI_HOME || "~/.gemini", env);
    try { return !existsSync(join(geminiHome, "antigravity-cli", "conversations", `${record.harness_session_id}.db`)); }
    catch { return false; }
  }
  if (record.harness === "cursor") {
    // Cursor writes no per-chat store until the chat's first turn (tap-we6b):
    // a stored uuid with no store.db under this worktree's hash is a stale id,
    // not a resumable conversation.
    if (!record.harness_session_id) return true;
    const seatEnv = cursorStoreEnv(record, env);
    if (seatEnv === null) return false;
    try {
      return !statSync(cursorChatStorePath(cursorRoot(seatEnv, launchWorkdir(record)), launchWorkdir(record), record.harness_session_id)).isFile();
    } catch (error) {
      // ENOTDIR: a path component is a file, so the store provably cannot exist.
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ENOTDIR";
    }
  }
  return false;
}

/** The fresh-start disclosure for an id-less record whose harness never opens a
 * native picker at startup (OpenCode, cursor, agy), else null: resume-family doors
 * that relaunch such a seat must say the conversation was not resumed. agy's
 * `--continue` would guess the workdir's latest conversation, so an id-less agy
 * seat starts empty and points at agy's own /resume picker instead. */
export function idlessFreshWarning(record: SessionRecord): string | null {
  if (record.harness_session_id) return null;
  if (record.harness === "agy") {
    return `tap session: WARNING: ${record.name} has no captured agy conversation id; starting an empty conversation. Use agy's /resume picker to select the conversation you want`;
  }
  const what = record.harness === "opencode" ? "OpenCode session" : record.harness === "cursor" ? "cursor chat" : null;
  return what && `tap session: WARNING: ${record.name} has no native ${what} id; starting a fresh conversation`;
}

/** record_has_resume_artifact. */
export function recordHasResumeArtifact(record: SessionRecord, env: NodeJS.ProcessEnv = process.env): boolean {
  return !conversationArtifactMissing(record, env);
}

export function resolvedResumeIdentity(
  record: SessionRecord,
  env: NodeJS.ProcessEnv = process.env,
  // Silent by default: a caller that only wants the id (the dark planner, a
  // pre-flight) passes nothing. The receipts ride the SAME resolution that
  // produced the id — resolving twice to explain a fallback is how the argv and
  // the explanation come to disagree about which transcript was found.
  receipts?: (line: string) => void,
): string | null {
  if (record.harness === "claude") {
    const target = resolveResumeTarget(record, env);
    if (receipts) emitResumeTargetReceipts(record, target, receipts);
    return target.session_id;
  }
  if (record.harness === "cursor") {
    // tap-we6b rework: a stored uuid whose store.db never appeared is a stale
    // id — exact-targeting it would silently start a new empty chat, and the
    // bare-`--resume` picker emission is gone. Null means NOT RESUMABLE: the
    // resume door refuses (no_exact_resume_identity) and no caller may turn
    // this null into a silent fresh start or a picker.
    const stored = record.harness_session_id ?? null;
    if (stored && !recordHasResumeArtifact(record, env)) {
      receipts?.(`tap session: no cursor chat store for stored id ${stored}; the conversation never persisted and cannot be resumed`);
      return null;
    }
    return stored;
  }
  return record.harness_session_id ?? null;
}

/** Dark plan fields for one resume row. revive_tier uses the stored id. */
export function planResume(
  record: SessionRecord,
  env: NodeJS.ProcessEnv = process.env,
): {
  target: string | null;
  source: ResumeSource;
  split_brain: boolean;
  revive_tier: string;
  disclosure: string | null;
} {
  const target = resolveResumeTarget(record, env);
  return {
    target: target.session_id,
    source: target.source,
    split_brain: target.split_brain,
    revive_tier: reviveTier(record.harness, record.harness_session_id ?? null),
    disclosure: target.disclosure,
  };
}
