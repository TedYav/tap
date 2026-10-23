import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWindowMap, windowFor } from "../src/opencode-model-windows";
import { removeScratchTree } from "./support/scratch";
const root=mkdtempSync(join(tmpdir(),"opencode-windows-"));
afterAll(()=>removeScratchTree(root));
const snapshots=join(root,"opencode-model-windows.d");mkdirSync(snapshots);
const env={TAP_INDEX_HOME:root,PATH:"/no-harness-executable"};
const now=Math.floor(Date.now()/1000);
function snapshot(name:string,directory:string,windows:Record<string,unknown>,over:Record<string,unknown>={}) {
  writeFileSync(join(snapshots,name+".json"),JSON.stringify({directory,version:"2.1.2",fetched_at:now,windows,...over}));
}
test("reads independent live-plugin snapshots without spawning OpenCode",()=>{
  snapshot("a","/work/a",{"capture/probe":32000});
  snapshot("b","/work/b",{"capture/probe":64000});
  expect(windowFor(readWindowMap(env),"/work/a","capture/probe")).toBe(32000);
  expect(windowFor(readWindowMap(env),"/work/b","capture/probe")).toBe(64000);
  const before=readFileSync(join(snapshots,"a.json"),"utf8");
  readWindowMap(env);
  expect(readFileSync(join(snapshots,"a.json"),"utf8")).toBe(before);
});
test("malformed, old-major and stale snapshots cannot supply a window",()=>{
  snapshot("old","/old",{"p/m":100},{version:"1.18.33"});
  snapshot("stale","/stale",{"p/m":100},{fetched_at:now-8*86400});
  snapshot("bad","relative",{"p/m":100});
  writeFileSync(join(snapshots,"partial.tmp"),"{");
  writeFileSync(join(snapshots,"corrupt.json"),"{");
  const map=readWindowMap(env);
  expect(windowFor(map,"/old","p/m")).toBeUndefined();
  expect(windowFor(map,"/stale","p/m")).toBeUndefined();
  expect(map?.directories.relative).toBeUndefined();
});
test("invalid caps are omitted and the v1 aggregate file is never read",()=>{
  snapshot("invalid","/caps",{"p/ok":100,"p/zero":0,"p/string":"12","p/negative":-1});
  writeFileSync(join(root,"opencode-model-windows.json"),JSON.stringify({version:"1.18.33",directories:{"/legacy":{fetched_at:now,windows:{"p/m":999}}}}));
  expect(readWindowMap(env)?.directories["/caps"]?.windows).toEqual({"p/ok":100});
  expect(windowFor(readWindowMap(env),"/legacy","p/m")).toBeUndefined();
  expect(readWindowMap({TAP_INDEX_HOME:join(root,"absent")})).toBeNull();
});
