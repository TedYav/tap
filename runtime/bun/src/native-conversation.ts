// Exact native-store checks shared by ask receipts and crew adoption.
import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { codexSessionExists, claudeChildStoreRoot } from "./launcher/resume-identity";
import { opencodeStoredSession } from "./opencode-store";
import { cursorChatStorePath } from "./session-store";

export const NATIVE_CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const file = (path: string) => { try { return statSync(path).isFile(); } catch { return false; } };
const root = (value: string | undefined, fallback: string, cwd: string, env: NodeJS.ProcessEnv) => {
  const path = value || fallback, home = env.HOME || homedir();
  return resolve(cwd, path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path);
};

/** Claude's project-name encoding is not an API. Match the transcript's own cwd instead. */
function claudeConversation(id: string, cwd: string, env: NodeJS.ProcessEnv): boolean {
  const projects = join(claudeChildStoreRoot(env), "projects");
  let names: string[];
  try { names = readdirSync(projects); } catch { return false; }
  for (const name of names) {
    let fd: number | undefined;
    try {
      fd = openSync(join(projects, name, `${id}.jsonl`), "r");
      const bytes = Buffer.alloc(256 * 1024);
      const count = readSync(fd, bytes, 0, bytes.length, 0);
      for (const line of bytes.subarray(0, count).toString("utf8").split("\n")) {
        let entry: { sessionId?: unknown; cwd?: unknown };
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry?.sessionId === id && typeof entry.cwd === "string" && realpathSync(entry.cwd) === realpathSync(cwd)) return true;
      }
    } catch { /* missing, unreadable, or no matching workspace is not proof */ }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  return false;
}

function hermesConversation(id: string, path: string): boolean {
  if (!file(path)) return false;
  // A read-only SQLite open can create WAL sidecars. Refuse that shape before opening.
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const header = Buffer.alloc(20);
    if (readSync(fd, header, 0, header.length, 0) !== header.length) return false;
    if ((header[18] === 2 || header[19] === 2) && (!existsSync(`${path}-wal`) || !existsSync(`${path}-shm`))) return false;
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    db.exec("PRAGMA busy_timeout = 100");
    return !!db.query("SELECT 1 FROM sessions WHERE id = ? LIMIT 1").get(id);
  } catch { return false; }
  finally { db?.close(); }
}

/** `env` is the actual child's environment, not TAP's store aliases or a guessed latest session. */
export function nativeConversationExists(harness: string, id: string, cwd: string, env: NodeJS.ProcessEnv): boolean {
  if (!NATIVE_CONVERSATION_ID.test(id)) return false;
  if (harness === "claude") return claudeConversation(id, cwd, env);
  if (harness === "codex") return codexSessionExists(id, { ...env, TAP_CODEX_HOME: undefined });
  if (harness === "opencode") return opencodeStoredSession(id, { ...env, OPENCODE_DB_PATH: undefined }, cwd) === "present";
  if (harness === "cursor") return file(cursorChatStorePath(root(env.CURSOR_HOME, "~/.cursor", cwd, env), cwd, id));
  if (harness === "agy") return file(join(root(env.GEMINI_HOME, "~/.gemini", cwd, env), "antigravity-cli", "conversations", `${id}.db`));
  if (harness === "hermes") return hermesConversation(id, join(root(env.HERMES_HOME, "~/.hermes", cwd, env), "state.db"));
  return false;
}
