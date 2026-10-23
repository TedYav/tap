// The native store may refuse an id; it never supplies one.
import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { join } from "node:path";

export function agyConversationStore(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || "";
  const configured = env.TAP_GEMINI_HOME || env.GEMINI_HOME || join(home, ".gemini");
  const gemini = configured.startsWith("~/") ? join(home, configured.slice(2)) : configured;
  return join(gemini, "antigravity-cli/conversation_summaries.db");
}

export type AgyRootStatus = { kind: "root" | "nested" | "missing" }
  | { kind: "unavailable"; detail: string };

/** An exact-id veto, with no workspace/time scan or alternate identity result. */
export function agyRootStatus(id: string, env: NodeJS.ProcessEnv = process.env): AgyRootStatus {
  let db: Database | undefined;
  try {
    const path = agyConversationStore(env);
    if (!statSync(path).isFile()) return { kind: "unavailable", detail: "conversation summaries path is not a regular file" };
    db = new Database(path, { readonly: true });
    db.exec("PRAGMA busy_timeout = 50");
    const rows = db.query("SELECT parent_conversation_id, nesting_depth FROM conversation_summaries WHERE conversation_id = ? LIMIT 2").all(id) as
      Array<{ parent_conversation_id: unknown; nesting_depth: unknown }>;
    if (rows.length === 0) return { kind: "missing" };
    if (rows.length !== 1) return { kind: "unavailable", detail: "native conversation id is not unique" };
    const { parent_conversation_id: parent, nesting_depth: depth } = rows[0]!;
    if (typeof parent !== "string" || typeof depth !== "number" || !Number.isInteger(depth) || depth < 0)
      return { kind: "unavailable", detail: "native conversation lineage fields are malformed" };
    return { kind: depth === 0 && parent === "" ? "root" : "nested" };
  } catch (error) {
    return { kind: "unavailable", detail: error instanceof Error ? error.message : String(error) };
  } finally { db?.close(); }
}
