import { Database } from "bun:sqlite";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addSession, createOpenCodeStore } from "../support/opencode-store";
import { captureCompactionBoundary, type ProofMode } from "../../src/compaction-proof";

export function proofFixture(root: string, mode: ProofMode, since = 1000) {
  const path = join(root, `${crypto.randomUUID()}.${mode === "claude" ? "jsonl" : "db"}`);
  const session = "bound-session";
  const seat = { harness: mode, harness_session_id: session,
    ...(mode === "opencode" ? { session_store_path: path } : { transcript_path: path }) };
  if (mode === "claude") writeFileSync(path, JSON.stringify({ type: "user", sessionId: session }) + "\n");
  else {
    const db = createOpenCodeStore(path);
    addSession(db, session, "/work");
    db.close();
  }
  const boundary = captureCompactionBoundary(mode, seat, since);
  let n = 0;
  const summary = (at = since + 1, overrides: Record<string, unknown> = {}, request = true) => {
    if (mode === "claude") {
      appendFileSync(path, JSON.stringify({ type: "user", sessionId: session, isCompactSummary: true,
        isVisibleInTranscriptOnly: true, timestamp: new Date(at).toISOString(), ...overrides }) + "\n");
    } else {
      const db = new Database(path);
      try {
        const id = `compaction-${n++}`;
        const { type = "compaction", ...data } = { type: "compaction", status: request ? "completed" : "running",
          reason: "manual", summary: "compacted", time: { created: at }, ...overrides };
        db.query("INSERT INTO session_message (id,session_id,type,seq,time_created,time_updated,data) VALUES (?,?,?,?,?,?,?)")
          .run(id, session, type, n, at, at + 1, JSON.stringify(data));
      } finally { db.close(); }
    }
  };
  return { path, seat, boundary, summary };
}
