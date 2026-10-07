/** OpenCode's last request input, bound to the registered SQLite store/session. */
import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { TokenSample } from "./context-tokens";
import { opencodeStorePath } from "./opencode-store";
import { readWindowMap, windowFor, type WindowMap } from "./opencode-model-windows";

export { parseOpenCodeModels } from "./opencode-model-windows";

const integer = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const unknown = (reason: string): TokenSample => ({input_tokens:null, observed_at:null, source:null,
  window_tokens:null, window_source:null, used_percent:null, percent_source:null, unknown_reason:reason, tuning:null});

/** The same bound native identity for roster usage and doctor validation. */
export function readOpenCodeSession(db: Database, sessionId: string): {directory: string; revert: string | null} | null {
  return db.query("SELECT directory, revert FROM session WHERE id = ?").get(sessionId) as {directory: string; revert: string | null} | null;
}

/** The project directory each OpenCode seat's session is bound to, de-duplicated, for `tap team --refresh-models`. */
export function opencodeSessionDirectories(seats: readonly { sessionId: string; path: string }[], env: NodeJS.ProcessEnv = process.env): string[] {
  const directories = new Set<string>();
  for (const seat of seats) {
    const path = seat.path || opencodeStorePath(env);
    if (!seat.sessionId || !isAbsolute(path)) continue;
    let db: Database | undefined;
    try {
      if (!statSync(path).isFile()) continue;
      db = new Database(path, {readonly:true});
      db.exec("PRAGMA busy_timeout = 100");
      const session = readOpenCodeSession(db, seat.sessionId);
      if (session && isAbsolute(session.directory)) directories.add(session.directory);
    } catch { /* an unreadable store contributes no directory */ }
    finally { db?.close(); }
  }
  return [...directories];
}

/**
 * Roster usage for one OpenCode seat. The model's window comes from the persisted map only; this reader never runs
 * `opencode` (tap-8me26), so a model the map does not know leaves the count visible with an unknown cap.
 */
export function createOpenCodeContextReader(readMap: () => WindowMap | null = () => readWindowMap()) {
  let map: WindowMap | null | undefined;
  return (sessionId: string, path: string): TokenSample => {
    path ||= opencodeStorePath(process.env);
    if (!sessionId || !isAbsolute(path)) return unknown("unbound_transcript");
    let db: Database | undefined;
    try {
      if (!statSync(path).isFile()) return unknown("unreadable_transcript");
      db = new Database(path, {readonly:true});
      db.exec("PRAGMA busy_timeout = 100");
      const session = readOpenCodeSession(db, sessionId);
      if (!session) return unknown("session_mismatch");
      if (session.revert) return unknown("awaiting_usage_after_revert");
      // A bounded tail includes incomplete requests so a summary boundary cannot
      // disappear merely because it has not finished yet. Never sum requests.
      const rows = db.query(`SELECT data FROM message WHERE session_id = ?
        ORDER BY time_created DESC, id DESC LIMIT 32`).all(sessionId) as {data:string}[];
      for (const row of rows) {
        const message = JSON.parse(row.data);
        if (message.sessionID != null && message.sessionID !== sessionId) return unknown("session_mismatch");
        if (message.role !== "assistant") continue;
        if (message.summary === true) return unknown("awaiting_usage_after_compact");
        if (message.time?.completed == null) continue;
        if (message.error) return unknown("invalid_usage");
        const usage = message.tokens;
        const parts = [usage?.input, usage?.cache?.read, usage?.cache?.write];
        const completed = message.time.completed;
        const input = parts.every(integer) ? parts.reduce((sum, n) => sum + n, 0) : null;
        if (!integer(input) || !integer(completed) || !Number.isFinite(new Date(completed).getTime())) return unknown("invalid_usage");
        const sample: TokenSample = {input_tokens:input, observed_at:new Date(completed).toISOString(), source:"opencode_store",
          window_tokens:null, window_source:null, used_percent:null, percent_source:null, unknown_reason:null, tuning:null};
        db.close(); db = undefined;
        if (map === undefined) { try { map = readMap(); } catch { map = null; } }
        const window = windowFor(map, session.directory, `${message.providerID}/${message.modelID}`);
        if (!integer(window) || window === 0) return sample;
        return {...sample, window_tokens:window, window_source:"opencode_model", percent_source:"opencode_model",
          used_percent:Math.round(input / window * 100)};
      }
      return unknown("usage_not_in_tail");
    } catch { return unknown("unreadable_transcript"); }
    finally { db?.close(); }
  };
}
