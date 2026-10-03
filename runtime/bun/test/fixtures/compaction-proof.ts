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
        const parent = `parent-${n}`, id = `summary-${n++}`;
        db.query("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(parent, session, at, at, JSON.stringify({ role: "user", time: { created: at } }));
        if (request) db.query("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(`part-${parent}`, parent, session, at, at, JSON.stringify({ type: "compaction" }));
        db.query("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(id, session, at, at, JSON.stringify({ role: "assistant", summary: true,
          parentID: parent, finish: "stop", time: { created: at, completed: at + 1 }, ...overrides }));
      } finally { db.close(); }
    }
  };
  return { path, seat, boundary, summary };
}
