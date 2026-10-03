// The opencode turn-state query's one native owner (M6 U1): every terminal
// class the Bash `tap_opencode_db_turn_state` answered, plus the CLI shape the
// thin lib.sh adapter forwards. The sqlite CLI has no parameter binding, so the
// session id travels as a hex-blob literal (only [0-9a-f] can enter the SQL
// text): the punctuation rows below prove a hostile id cannot leave the data
// channel.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { opencodeTurnState } from "../src/opencode-turn-state";
import { addMessage, createOpenCodeStore } from "./support/opencode-store";
import { removeScratchTree } from "./support/scratch";

let root = "";

/** An opencode `message` row: the JSON the live writer stores, one column. */
const assistant = (sessionID: string, created: number, completed: number | null, finish: string | null) =>
  ({ role: "assistant", sessionID, time: { created, completed }, finish });

function makeDb(name: string, rows: object[]): string {
  const db = join(root, name);
  const store = createOpenCodeStore(db);
  for (const r of rows) addMessage(store, r);
  store.close();
  return db;
}

const pinned = (db: string): NodeJS.ProcessEnv => ({ ...process.env, OPENCODE_DB_PATH: db });

/** The module CLI exactly as the thin lib.sh adapter invokes it. */
function cli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [join(import.meta.dir, "../src/opencode-turn-state.ts"), ...args], { encoding: "utf8", env });
}

beforeAll(() => { root = mkdtempSync(join(tmpdir(), "opencode-turn-state.")); });
afterAll(() => { removeScratchTree(root); });

describe("opencodeTurnState", () => {
  test("empty session -> error", () => {
    expect(opencodeTurnState("", pinned(join(root, "any.db")))).toBe("error");
  });

  test("missing and non-regular db -> error", () => {
    expect(opencodeTurnState("s1", pinned(join(root, "absent.db")))).toBe("error");
    mkdirSync(join(root, "dir.db"));
    expect(opencodeTurnState("s1", pinned(join(root, "dir.db")))).toBe("error");
  });

  test("query failure -> error", () => {
    const db = join(root, "junk.db");
    writeFileSync(db, "this is not a database");
    expect(opencodeTurnState("s1", pinned(db))).toBe("error");
  });

  test("no matching assistant row -> unknown", () => {
    const db = makeDb("nomatch.db", [assistant("other", 1, 5, "stop"), { role: "user", sessionID: "s1" }]);
    expect(opencodeTurnState("s1", pinned(db))).toBe("unknown");
  });

  test("incomplete latest assistant -> in-turn; completed stop -> idle; null finish -> dirty-end; other finishes -> idle", () => {
    const db = makeDb("states.db", [
      assistant("in", 1, null, null), assistant("idle", 2, 5, "stop"),
      assistant("dirty", 3, 6, null), assistant("tools", 4, 7, "tool-calls"),
    ]);
    const env = pinned(db);
    expect(opencodeTurnState("in", env)).toBe("in-turn");
    expect(opencodeTurnState("idle", env)).toBe("idle");
    expect(opencodeTurnState("dirty", env)).toBe("dirty-end");
    expect(opencodeTurnState("tools", env)).toBe("idle");
  });

  test("the LATEST assistant by time.created decides", () => {
    const db = makeDb("latest.db", [assistant("s", 1, 5, "stop"), assistant("s", 2, null, null)]);
    expect(opencodeTurnState("s", pinned(db))).toBe("in-turn");
  });

  test("a session id with quote/punctuation reaches the query as data (hex-blob binding)", () => {
    const hostile = `s'e"i$d ;-- DROP TABLE message`;
    const db = makeDb("punct.db", [assistant(hostile, 1, 5, "stop"), assistant("plain", 2, null, null)]);
    expect(opencodeTurnState(hostile, pinned(db))).toBe("idle");
    expect(opencodeTurnState("plain", pinned(db))).toBe("in-turn");
  });
});

describe("the module CLI the lib.sh adapter forwards", () => {
  test("state on stdout with rc 0; error on stdout with rc 1", () => {
    const db = makeDb("cli.db", [assistant("busy", 1, null, null), assistant("done", 2, 5, "stop")]);
    const env = pinned(db);
    expect(cli(["busy"], env)).toMatchObject({ status: 0, stdout: "in-turn\n" });
    expect(cli(["done"], env)).toMatchObject({ status: 0, stdout: "idle\n" });
    expect(cli(["ghost"], env)).toMatchObject({ status: 0, stdout: "unknown\n" });
    expect(cli([""], env).status).toBe(1);
    expect((cli([""], env).stdout ?? "").trim()).toBe("error");
    expect(cli([], { ...env, OPENCODE_DB_PATH: join(root, "absent-cli.db") })).toMatchObject({ status: 1 });
  });
});
