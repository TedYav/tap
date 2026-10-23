import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { agyConversationStore, agyRootStatus } from "../src/agy-conversation";
import { removeScratchTree } from "./support/scratch";

test("only the exact native id with complete root lineage passes the store veto", () => {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR!, "agy-store-"));
  try {
    const env = { HOME: root, TAP_GEMINI_HOME: join(root, "native-home") };
    const path = agyConversationStore(env);
    expect(agyRootStatus("root", env).kind).toBe("unavailable");
    expect(existsSync(path)).toBe(false);
    mkdirSync(join(env.TAP_GEMINI_HOME, "antigravity-cli"), { recursive: true });
    const db = new Database(path);
    db.exec("CREATE TABLE conversation_summaries (conversation_id TEXT, parent_conversation_id, nesting_depth)");
    const insert = db.query("INSERT INTO conversation_summaries VALUES (?, ?, ?)");
    insert.run("root", "", 0);
    insert.run("child", "root", 1);
    insert.run("parent-only", "root", 0);
    insert.run("depth-only", "", 1);
    insert.run("invalid", null, 0);
    insert.run("duplicate", "", 0);
    insert.run("duplicate", "root", 1);
    db.close();
    expect(agyRootStatus("root", env)).toEqual({ kind: "root" });
    for (const id of ["child", "parent-only", "depth-only"]) expect(agyRootStatus(id, env)).toEqual({ kind: "nested" });
    for (const id of ["invalid", "duplicate"]) expect(agyRootStatus(id, env).kind).toBe("unavailable");
    expect(agyRootStatus("missing", env)).toEqual({ kind: "missing" });
    expect(agyRootStatus("' OR 1=1 --", env)).toEqual({ kind: "missing" });
  } finally { removeScratchTree(root); }
});
