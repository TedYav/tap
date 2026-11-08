// M6 U1: the opencode turn-state read's one native owner; lib.sh adapts to this.
import { statSync } from "node:fs";
import { Database } from "bun:sqlite";
import { opencodeStorePath } from "./opencode-store";

// This assistant-step observation predates native idle markers; interrupted-turn
// outcomes are not classified here. readiness-stall uses the session idle marker.
export type TurnState = "in-turn" | "idle" | "dirty-end" | "unknown" | "error";

/**
 * The session id enters the SQL only as a hex blob literal, so no byte of it can
 * break out of the CAST. The seek rides
 * `session_message_session_type_seq_idx (session_id, type, seq)`: `json_extract`
 * in WHERE/ORDER BY would decode every row of a ~100 GB store (tap-2zzft). The role
 * filter runs on rows the index walk visits, newest first, so it stops at the first assistant.
 * INDEXED BY turns a store lacking the index (or columns) into "error" rather than a scan.
 */
export function turnStateSql(sessionId: string): string {
  const hex = Buffer.from(sessionId, "utf8").toString("hex");
  return `SELECT json_extract(data, '$.finish'), json_extract(data, '$.time.completed')
FROM session_message INDEXED BY session_message_session_type_seq_idx
WHERE session_id = CAST(x'${hex}' AS TEXT) AND type = 'assistant'
ORDER BY seq DESC
LIMIT 1;`;
}

export function opencodeTurnState(sessionId: string, env: NodeJS.ProcessEnv = process.env): TurnState {
  if (!sessionId) return "error";
  const db = opencodeStorePath(env);
  try {
    if (!statSync(db).isFile()) return "error";
  } catch {
    return "error";
  }
  let store: Database | undefined;
  try {
    store = new Database(db, { readonly: true, strict: true });
    const row = store.query(turnStateSql(sessionId)).values()[0];
    if (!row) return "unknown";
    const [finish, completed] = row;
    if (completed === null || completed === "") return "in-turn";
    if (finish === null || finish === "") return "dirty-end";
    return "idle";
  } catch { return "error"; }
  finally { store?.close(); }
}

export function main(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  const state = opencodeTurnState(argv[0] ?? "", env);
  process.stdout.write(`${state}\n`);
  return state === "error" ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
