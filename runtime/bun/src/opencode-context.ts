/** OpenCode's last request input, bound to the registered SQLite store/session. */
import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import type { TokenSample } from "./context-tokens";
import { opencodeStorePath } from "./opencode-store";

const integer = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const unknown = (reason: string): TokenSample => ({input_tokens:null, observed_at:null, source:null,
  window_tokens:null, window_source:null, used_percent:null, percent_source:null, unknown_reason:reason, tuning:null});

type Model = { id: string; providerID: string; limit?: {context?: number} };
type Models = Map<string, Model>;

/** `models --verbose` emits one heading followed by a pretty-printed JSON object. */
export function parseOpenCodeModels(text: string): Models {
  const result: Models = new Map();
  for (const match of text.matchAll(/^([^\n]+)\n(\{\n[\s\S]*?^\})\s*(?=\n|$)/gm)) {
    try {
      const model = JSON.parse(match[2]!) as Model;
      if (typeof model.id === "string" && typeof model.providerID === "string" &&
          match[1] === `${model.providerID}/${model.id}`) result.set(match[1], model);
    } catch { /* malformed metadata leaves the denominator unknown */ }
  }
  return result;
}

function loadModels(directory: string): Models {
  // Resolve project/user overrides through OpenCode, not a second config parser.
  // Pure mode avoids executing user plugins during roster observation.
  const r = spawnSync("opencode", ["models", "--verbose", "--pure"], {
    cwd: directory, encoding:"utf8", timeout:5000, maxBuffer:16 * 1024 * 1024,
    stdio:["ignore", "pipe", "pipe"],
  });
  return r.status === 0 ? parseOpenCodeModels(r.stdout) : new Map();
}

/** The same bound native identity for roster usage and doctor validation. */
export function readOpenCodeSession(db: Database, sessionId: string): {directory: string; revert: string | null} | null {
  return db.query("SELECT directory, revert FROM session WHERE id = ?").get(sessionId) as {directory: string; revert: string | null} | null;
}

/** Cache resolved metadata only for this roster observation, once per project. */
export function createOpenCodeContextReader(models: (directory: string) => Models = loadModels) {
  const catalog = new Map<string, Models>();
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
        // Store handles are closed before starting an external metadata command.
        db.close(); db = undefined;
        if (!isAbsolute(session.directory)) return sample;
        let available = catalog.get(session.directory);
        if (!available) {
          try { available = models(session.directory); } catch { available = new Map(); }
          catalog.set(session.directory, available);
        }
        const model = available.get(`${message.providerID}/${message.modelID}`);
        const window = model?.limit?.context;
        if (!integer(window) || window === 0) return sample;
        return {...sample, window_tokens:window, window_source:"opencode_model", percent_source:"opencode_model",
          used_percent:Math.round(input / window * 100)};
      }
      return unknown("usage_not_in_tail");
    } catch { return unknown("unreadable_transcript"); }
    finally { db?.close(); }
  };
}
