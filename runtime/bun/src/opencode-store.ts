// OpenCode's native session store: the one path resolution every TAP reader
// uses, and the read-only session-presence probe the resume gate uses (tap-dt6kf).
import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** OpenCode's opencode.db. `OPENCODE_DB_PATH` is TAP's own pin (OpenCode
 * 2.1.2 ignores it); unset, this follows OpenCode's xdg-basedir data root,
 * so `XDG_DATA_HOME` moves the store exactly as it moves OpenCode's. */
export function opencodeStorePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCODE_DB_PATH) return env.OPENCODE_DB_PATH;
  const data = env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share");
  return join(data, "opencode", "opencode.db");
}

/** True when the header marks a WAL database (format bytes 18-19 = 2) and either
 * sidecar is absent: opening it, even read-only, could need to create one. */
function walSidecarMissing(path: string): boolean {
  const header = Buffer.alloc(20);
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    if (readSync(fd, header, 0, 20, 0) < 20) return false;
  } catch {
    return true;
  } finally {
    if (fd !== null) closeSync(fd);
  }
  if (header[18] !== 2 && header[19] !== 2) return false;
  return !existsSync(`${path}-wal`) || !existsSync(`${path}-shm`);
}

export type OpenCodeStoredSession = "present" | "absent" | "unknown";

/**
 * Whether OpenCode's store holds `sessionId` in the optional directory.
 * A readable `session_v2` store lacking the id or matching directory is "absent"; every other
 * outcome (no file, open/lock/query error, unexpected schema) is "unknown".
 * A WAL store missing either sidecar is unknown before any open; otherwise the
 * open is SQLITE_OPEN_READONLY without create, so it never creates the store or
 * its -wal/-shm.
 * Not `immutable=1`: that skips the WAL and would miss uncheckpointed sessions.
 */
export function opencodeStoredSession(sessionId: string, env: NodeJS.ProcessEnv = process.env, directory?: string): OpenCodeStoredSession {
  const path = opencodeStorePath(env);
  try { if (!statSync(path).isFile()) return "unknown"; } catch { return "unknown"; }
  if (walSidecarMissing(path)) return "unknown";
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    db.exec("PRAGMA busy_timeout = 100");
    const table = db.query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'session_v2'").get();
    if (!table) return "unknown";
    if (directory !== undefined) {
      const row = db.query("SELECT directory FROM session_v2 WHERE id = ?").get(sessionId) as { directory: string } | null;
      return row && realpathSync(row.directory) === realpathSync(directory) ? "present" : "absent";
    }
    return db.query("SELECT 1 AS present FROM session_v2 WHERE id = ?").get(sessionId) ? "present" : "absent";
  } catch {
    return "unknown";
  } finally {
    db?.close();
  }
}
