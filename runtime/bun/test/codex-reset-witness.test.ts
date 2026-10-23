import { afterAll, afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { codexWriterState, captureCodexResetBoundary, codexProcessInPane, codexRolloutAbsent, nextCodexResetThread, RESET_THREAD_ROWS_SQL } from "../src/codex-reset-witness";
import { acquireExistingFlock, acquireFlock, flockState, type HeldLock } from "../src/remind-lock";
import { removeScratchTree } from "./support/scratch";

const specimen=JSON.parse(readFileSync(new URL("fixtures/self-rebrief/codex-0.163-native.json",import.meta.url),"utf8"));
const root=mkdtempSync(join(tmpdir(),"codex-reset-witness-"));
const databases: Database[]=[];
const locks: HeldLock[]=[];
afterEach(()=>{for(const lock of locks.splice(0))lock.release();for(const db of databases.splice(0))db.close();});
afterAll(()=>removeScratchTree(root));
function fixture() {
  const home=mkdtempSync(join(root,"home-"));
  mkdirSync(join(home,"sessions"));mkdirSync(join(home,"thread-writer-locks"));
  acquireFlock(join(home,"thread-writer-locks",".coordination.lock"),0,true)!.release();
  const db=new Database(join(home,"logs_2.sqlite"));databases.push(db);db.exec(specimen.schema);
  const add=(row:{id:number;thread_id:string;process_uuid:string})=>db.query("INSERT INTO logs (id,ts,ts_nanos,level,target,thread_id,process_uuid) VALUES (?,?,0,'INFO','codex_core::shell_snapshot',?,?)").run(row.id,Math.floor(Date.now()/1000),row.thread_id,row.process_uuid);
  for(const row of specimen.before)add(row);
  const transcript=join(home,"sessions","rollout-old.jsonl");
  const boundary=()=>captureCodexResetBoundary(transcript,specimen.oldSession,()=>specimen.owner);
  const lock=(id:string)=>{const held=acquireFlock(join(home,"thread-writer-locks",`${id}.lock`),0,true)!;expect(held).not.toBeNull();locks.push(held);return held;};
  return {home,db,add,boundary,lock};
}

test("native reset binds the old process and observes the locked new thread before rollout creation",()=>{
  const f=fixture(), boundary=f.boundary();
  expect(boundary).toMatchObject({oldSession:specimen.oldSession,processUuid:specimen.processUuid,afterId:619,owner:specimen.owner});
  for(const row of specimen.after)f.add(row);f.lock(specimen.newSession);
  expect(nextCodexResetThread(boundary!,specimen.owner)).toMatchObject({session:specimen.newSession,logId:977,writerLock:"would-block"});
  expect(existsSync(join(f.home,"sessions",`${specimen.newSession}.jsonl`))).toBe(false);
});

test("an abandoned regular writer-lock file cannot authorize recovery",()=>{
  const f=fixture(), boundary=f.boundary()!;f.add(specimen.after[0]);
  writeFileSync(join(f.home,"thread-writer-locks",`${specimen.newSession}.lock`),"");
  expect(nextCodexResetThread(boundary,specimen.owner)).toBeNull();
});

test("native coordination contention and missing files are pending; probes always release coordination",()=>{
  const f=fixture();f.lock(specimen.newSession);
  const path=join(f.home,"thread-writer-locks",".coordination.lock");
  const held=acquireExistingFlock(path)!;
  expect(codexWriterState(f.home,specimen.newSession)).toBe("unknown");held.release();
  expect(codexWriterState(f.home,specimen.newSession)).toBe("held");
  expect(codexWriterState(f.home,specimen.auxiliary)).toBe("not-held");
  const again=acquireExistingFlock(path);expect(again).not.toBeNull();again?.release();
  const missing=join(root,"uncreated-native-store");
  expect(codexWriterState(missing,specimen.newSession)).toBe("unknown");expect(existsSync(missing)).toBe(false);
});

test("only observed WouldBlock authorizes; unreadable errno and other failures prove nothing",()=>{
  const wouldBlock=process.platform==="darwin"?35:11;
  for(const errno of [null,4,9,37])expect(flockState(-1,{flock:()=>-1,errno:()=>errno})).toBe("unknown");
  expect(flockState(-1,{flock:()=>-1,errno:()=>wouldBlock})).toBe("held");
  const calls:number[]=[];
  expect(flockState(-1,{flock:(_fd,op)=>{calls.push(op);return 0;},errno:()=>wouldBlock})).toBe("not-held");
  expect(calls).toEqual([6,8]);
});

test("an unknown distinct candidate cannot disappear from the ambiguity decision",()=>{
  const f=fixture(), boundary=f.boundary()!;f.add(specimen.after[0]);f.lock(specimen.newSession);
  f.add({...specimen.after[0],id:978});
  f.add({...specimen.after[0],id:979,thread_id:specimen.auxiliary});
  const calls:string[]=[];
  expect(nextCodexResetThread(boundary,specimen.owner,(_home,id)=>{
    calls.push(id);return id===specimen.newSession?"held":"unknown";
  })).toBeNull();
  expect(calls).toEqual([specimen.newSession,specimen.auxiliary]);
});

test("candidate rollouts in adjacent local-date directories block bootstrap, even if empty",()=>{
  const f=fixture(), thread={session:specimen.newSession,logId:977,loggedAt:Date.parse("2026-10-21T00:00:00Z")/1000,writerLock:"would-block" as const};
  expect(codexRolloutAbsent(f.home,thread)).toBe(true);
  const day=join(f.home,"sessions","2026","10","20");mkdirSync(day,{recursive:true});
  writeFileSync(join(day,`rollout-ts-${specimen.otherSession}.jsonl`),"unrelated");
  expect(codexRolloutAbsent(f.home,thread)).toBe(true);
  writeFileSync(join(day,`rollout-ts-${specimen.newSession}.jsonl`),"");
  expect(codexRolloutAbsent(f.home,thread)).toBe(false);
  const broken=fixture();writeFileSync(join(broken.home,"sessions","2026"),"not a directory");
  expect(codexRolloutAbsent(broken.home,thread)).toBe(false);
});

test("other processes, lockless auxiliary threads, and pre-boundary rows cannot authorize recovery",()=>{
  for(const kind of ["other-process","no-lock","auxiliary","before-boundary"]) {
    const f=fixture();
    if(kind==="before-boundary"){f.add(specimen.after[0]);f.lock(specimen.newSession);}
    const boundary=f.boundary()!;
    if(kind!=="before-boundary")f.add({...specimen.after[0],process_uuid:kind==="other-process"?specimen.otherProcessUuid:specimen.processUuid,
      thread_id:kind==="auxiliary"?specimen.auxiliary:specimen.newSession});
    if(kind==="other-process")f.lock(specimen.newSession);
    expect(nextCodexResetThread(boundary,specimen.owner)).toBeNull();
  }
});

test("pid reuse or relaunch cannot inherit the old process's reset witness",()=>{
  const f=fixture(), boundary=f.boundary()!;f.add(specimen.after[0]);f.lock(specimen.newSession);
  for(const owner of [null,{...specimen.owner,pid:"5678"},{...specimen.owner,start:"later"}])expect(nextCodexResetThread(boundary,owner)).toBeNull();
  expect(captureCodexResetBoundary(join(f.home,"sessions","old.jsonl"),specimen.oldSession,()=>({...specimen.owner,pid:"5678"}))).toBeNull();
});

test("a pre-existing locked thread that keeps logging cannot witness reset or obscure the new thread",()=>{
  const f=fixture();
  f.add({...specimen.after[0],id:300,thread_id:specimen.auxiliary});f.lock(specimen.auxiliary);
  const boundary=f.boundary()!;
  f.add({...specimen.after[0],id:700,thread_id:specimen.auxiliary});
  expect(nextCodexResetThread(boundary,specimen.owner)).toBeNull();
  f.add(specimen.after[0]);f.lock(specimen.newSession);
  expect(nextCodexResetThread(boundary,specimen.owner)).toMatchObject({session:specimen.newSession,logId:977});
});

test("the old thread's logging process is resolved even when a launcher owns the pane",()=>{
  const f=fixture(), calls: [number,string][]=[];
  const fx={start:(pid:string)=>pid===specimen.owner.pid?specimen.owner.start:"",
    hasAncestor:(pid:number,ancestor:string)=>{calls.push([pid,ancestor]);return ancestor==="9000" || ancestor===String(pid);}};
  for(const panePid of ["9000",specimen.owner.pid]) {
    const boundary=captureCodexResetBoundary(join(f.home,"sessions","old.jsonl"),specimen.oldSession,uuid=>codexProcessInPane(uuid,panePid,fx));
    expect(boundary?.owner).toEqual(specimen.owner);
    expect(calls.at(-1)).toEqual([Number(specimen.owner.pid),panePid]);
  }
  expect(captureCodexResetBoundary(join(f.home,"sessions","old.jsonl"),specimen.oldSession,uuid=>codexProcessInPane(uuid,"8000",fx))).toBeNull();
  let samples=0;
  expect(codexProcessInPane(specimen.processUuid,"9000",{...fx,start:()=>String(++samples)})).toBeNull();
});

test("two locked new threads are ambiguous and a symlink is not a native writer lock",()=>{
  const f=fixture(), boundary=f.boundary()!;f.add(specimen.after[0]);f.lock(specimen.newSession);
  f.add({...specimen.after[0],id:978,thread_id:specimen.auxiliary});f.lock(specimen.auxiliary);
  expect(nextCodexResetThread(boundary,specimen.owner)).toBeNull();
  const linked=fixture(), linkedBoundary=linked.boundary()!;linked.add(specimen.after[0]);
  const target=join(linked.home,"target");writeFileSync(target,"");symlinkSync(target,join(linked.home,"thread-writer-locks",`${specimen.newSession}.lock`));
  expect(nextCodexResetThread(linkedBoundary,specimen.owner)).toBeNull();
});

test("missing, incompatible, or temporarily busy log stores send nothing and are not created",()=>{
  const missing=join(root,"missing","sessions","old.jsonl");
  expect(captureCodexResetBoundary(missing,specimen.oldSession,()=>specimen.owner)).toBeNull();expect(existsSync(join(root,"missing"))).toBe(false);
  const f=fixture();f.db.exec("ALTER TABLE logs RENAME TO incompatible");expect(f.boundary()).toBeNull();
  const busy=fixture();busy.db.exec("BEGIN EXCLUSIVE");try{expect(busy.boundary()).toBeNull();}finally{busy.db.exec("ROLLBACK");}
  expect(busy.boundary()).not.toBeNull();
});

test("post-boundary log reads use the primary-key range rather than scanning retained history",()=>{
  const f=fixture();
  const plan=f.db.query("EXPLAIN QUERY PLAN "+RESET_THREAD_ROWS_SQL).all(619,specimen.processUuid,specimen.oldSession,619) as {detail:string}[];
  expect(plan.some(row=>/USING INTEGER PRIMARY KEY/.test(row.detail))).toBe(true);
  expect(plan.some(row=>/idx_logs_thread_id/.test(row.detail))).toBe(true);
});
