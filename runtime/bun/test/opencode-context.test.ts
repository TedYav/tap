import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenCodeContextReader } from "../src/opencode-context";
import type { WindowMap } from "../src/opencode-model-windows";
import { removeScratchTree } from "./support/scratch";
const root = mkdtempSync(join(tmpdir(), "opencode-context-"));
afterAll(() => removeScratchTree(root));
let number = 0;
const model = {id:"glm",providerID:"provider",limit:{context:420000}};
const mapOf = (windows: Record<string, number>, directory = root): WindowMap => ({version:"2.1.2",directories:{[directory]:{fetched_at:1,windows}}});
const catalog = () => mapOf({"provider/glm":420000});
function fixture() {
  const path = join(root, `${number++}.db`);
  const db = new Database(path);
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, revert TEXT);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);
    CREATE INDEX session_message_session_seq_idx ON session_message(session_id,seq);`);
  db.query("INSERT INTO session_v2 VALUES (?, ?, NULL)").run("seat",root);
  const add = (time: number, change: Record<string, unknown> = {}, session = "seat") => {
    const {type = "assistant", ...data} = {type:"assistant",model:{id:"glm",providerID:"provider"},
      time:{created:time,completed:time+1},tokens:{input:131,output:89,reasoning:30,total:999999,
        cache:{read:101696,write:12}},...change};
    db.query("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)").run(`${time}`,session,type,time,time,JSON.stringify(data));
  };
  return {path,db,add};
}
test("latest completed request includes cache once, ignores session totals and other sessions", () => {
  const f=fixture(); f.add(100); f.add(200); f.add(300,{time:{created:300}}); f.add(400,{},"other");
  let loads=0;
  const read=createOpenCodeContextReader(() => { loads++; return catalog(); });
  const result=read("seat",f.path);
  expect(result).toMatchObject({input_tokens:101839,window_tokens:420000,used_percent:24,
    observed_at:new Date(201).toISOString(),source:"opencode_store",window_source:"opencode_model"});
  expect(read("seat",f.path)).toEqual(result); expect(loads).toBe(1);
  f.db.close();
});
test("compaction summary hides old input until a subsequent completed request", () => {
  const f=fixture(); f.add(100); f.add(200,{type:"compaction",status:"completed"});
  const read=createOpenCodeContextReader(catalog);
  expect(read("seat",f.path).unknown_reason).toBe("awaiting_usage_after_compact");
  f.add(300,{time:{created:300}});
  expect(read("seat",f.path).input_tokens).toBeNull();
  f.add(400); expect(read("seat",f.path).input_tokens).toBe(101839); f.db.close();
});
test("missing or failed model metadata keeps the measured input and never guesses a cap", () => {
  const f=fixture(); f.add(100);
  for (const models of [() => null, () => mapOf({}), () => mapOf({"provider/glm":420000},"/elsewhere"), () => {throw Error("unreadable");}]) {
    expect(createOpenCodeContextReader(models)("seat",f.path)).toMatchObject({input_tokens:101839,window_tokens:null,used_percent:null});
  }
  f.db.close();
});
test("invalid configured caps stay unknown", () => {
  const f=fixture(); f.add(100);
  const invalid=() => mapOf({"provider/glm":0});
  f.add(200); expect(createOpenCodeContextReader(invalid)("seat",f.path).window_tokens).toBeNull(); f.db.close();
});
test("invalid usage, wrong identity, revert and absent stores stay unknown", () => {
  const f=fixture(); const read=createOpenCodeContextReader(catalog);
  expect(read("seat",f.path).unknown_reason).toBe("usage_not_in_tail");
  f.add(100,{tokens:{input:-1,cache:{read:0,write:0}}});
  expect(read("seat",f.path).unknown_reason).toBe("invalid_usage");
  expect(read("other",f.path).unknown_reason).toBe("session_mismatch");
  expect(read("seat",join(root,"absent.db")).input_tokens).toBeNull();
  expect(read("seat","relative").unknown_reason).toBe("unbound_transcript");
  f.add(200,{sessionID:"other"}); expect(read("seat",f.path).unknown_reason).toBe("session_mismatch");
  f.db.query("UPDATE session_v2 SET revert = '{}' WHERE id = 'seat'").run();
  expect(read("seat",f.path).unknown_reason).toBe("awaiting_usage_after_revert"); f.db.close();
});
test("the same model keeps a separate window per project directory", () => {
  const a=join(root,"project-a"), b=join(root,"project-b");
  const map:WindowMap={version:"2.1.2",directories:{[a]:{fetched_at:1,windows:{"provider/glm":200000}},[b]:{fetched_at:1,windows:{"provider/glm":900000}}}};
  const f=fixture(); f.add(100); f.db.query("UPDATE session_v2 SET directory = ?").run(a);
  expect(createOpenCodeContextReader(() => map)("seat",f.path).window_tokens).toBe(200000);
  f.db.query("UPDATE session_v2 SET directory = ?").run(b);
  expect(createOpenCodeContextReader(() => map)("seat",f.path).window_tokens).toBe(900000); f.db.close();
});
