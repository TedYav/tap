import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeStoredSession } from "../src/opencode-store";
import { createOpenCodeContextReader } from "../src/opencode-context";
import { opencodeTurnState } from "../src/opencode-turn-state";
import { opencodeEvidence } from "../src/readiness-stall";

const root=mkdtempSync(join(tmpdir(),"oc2-store-"));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
const path=join(root,"opencode.db"), db=new Database(path);
// Relevant columns/indexes observed on the sandboxed OpenCode 2.1.2 database.
db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, revert TEXT);
CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id,seq);
CREATE INDEX session_message_session_type_seq_idx ON session_message(session_id,type,seq);`);
db.query("INSERT INTO session_v2 VALUES ('ses_v2',?,NULL)").run(root);
const data={model:{id:"probe",providerID:"capture"},content:[],time:{created:100,completed:200},finish:"stop",tokens:{input:131,output:89,reasoning:30,cache:{read:101696,write:12}}};
db.query("INSERT INTO session_message VALUES ('msg_z','ses_v2','assistant',1,100,200,?)").run(JSON.stringify(data));
db.query("INSERT INTO session_message VALUES ('msg_a','ses_v2','assistant',2,50,300,?)").run(JSON.stringify({...data,time:{created:50,completed:300},tokens:{input:7,output:2,reasoning:0,cache:{read:10,write:3}}}));
db.query("INSERT INTO session_message VALUES ('msg_idle','ses_v2','idle',3,301,301,?)").run(JSON.stringify({time:{created:301},outcome:"succeeded"}));
afterAll(()=>db.close());
const env={...process.env,OPENCODE_DB_PATH:path};
test("v2 native session is present and last request follows sequence, not id or wall time",()=>{
  expect(opencodeStoredSession("ses_v2",env)).toBe("present");
  expect(createOpenCodeContextReader(()=>null)("ses_v2",path)).toMatchObject({input_tokens:20,observed_at:"1970-01-01T00:00:00.300Z"});
  expect(opencodeTurnState("ses_v2",env)).toBe("idle");
  expect(opencodeEvidence("ses_v2",env)).toEqual({ended:true,lastActivity:0.301,at:0.301});
});
