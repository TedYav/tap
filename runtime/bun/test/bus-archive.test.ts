import {afterEach,expect,test} from "bun:test";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,utimesSync,rmSync,copyFileSync,symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {spawnSync} from "node:child_process";
import {archiveBus} from "../src/bus-archive";
import {archiveRows,archivedPayload} from "../src/bus-archive-index";
import {Bus} from "../src/bus";
const roots:string[]=[];const original={...process.env};const tree=resolve(import.meta.dir,"../../..");
afterEach(()=>{process.env={...original};for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
function fixture(){
 const root=mkdtempSync(join(tmpdir(),"bus-archive-"));roots.push(root);const bus=join(root,".tap/bus");
 for(const p of ["payloads","receipts","spool/digests"])mkdirSync(join(bus,p),{recursive:true});
 const index=join(root,"index"),home=join(root,"home");mkdirSync(index);mkdirSync(home);
 const registry=join(root,".tap/team-registry.json");
 writeFileSync(registry,JSON.stringify({schema:"0.20",team:{name:"spec"},seats:{reader:{instance:"reader|new",status:"active"}}}));
 writeFileSync(join(index,"global-registry.json"),JSON.stringify({schema:"0.20",teams:{spec:{root,registry_location:registry,state:"registered"}}}));
 Object.assign(process.env,{HOME:home,TAP_INDEX_HOME:index,TAP_HOME:bus,TAP_SELF:"reader",TAP_VERBOSE:"0",TAP_ONBOARDING_CHECKED:"1"});
 delete process.env.TMUX;delete process.env.TMUX_PANE;
 const now=Date.now(),old=new Date(now-10*86400000);
 function put(id:string,body="history body",settled=true,age=old){
  const path=join(bus,"payloads",id+".md");writeFileSync(path,`---\nid: ${id}\nfrom: sender\nto: reader\nkind: discuss\nreply: expected\npath: ${path}\n---\n${body}\n`);utimesSync(path,age,age);
  if(settled){const p=join(bus,"receipts",id+".done");writeFileSync(p,JSON.stringify({id,at:age.toISOString(),by:"reader",via:"reply"}));utimesSync(p,age,age);}
  return path;
 }
 function run(args:string[]) {return spawnSync("bash",[join(tree,"bin/tap"),...args],{cwd:root,env:process.env,encoding:"utf8"});}
 return{root,bus,now,old,put,run};
}
test("only old settled unreferenced payloads archive; dry run and repeated run",()=>{
 const f=fixture();const path=f.put("old");f.put("fresh","new",true,new Date());f.put("settled-reference","old"); // settled reference does not protect
 f.put("open","references protected",false);f.put("protected");f.put("queued");
 writeFileSync(join(f.bus,"spool/item.md"),"queued");
 const bytes=readFileSync(path);
 expect(archiveBus(f.bus,7,true,f.now).eligible).toBe(2);
 expect(existsSync(join(f.bus,"archive"))).toBe(false);
 expect(archiveBus(f.bus,7,false,f.now).archived).toBe(2);
 expect(readFileSync(archivedPayload(f.bus,"old"))).toEqual(bytes);
 expect(new Bus(f.bus).isDone("old")).toBe(true);
 for(const id of ["fresh","open","protected","queued"])expect(existsSync(join(f.bus,"payloads",id+".md"))).toBe(true);
 expect(archiveBus(f.bus,7,false,f.now).archived).toBe(0);
 expect(()=>archiveBus(f.bus,0)).toThrow("at least 1d");
});
test("archived exact/suffix/team/old-pointer read and show work without new obligations",()=>{
 const f=fixture(),id="sender-20260801T000000Z-abcdef123456",path=f.put(id);
 archiveBus(f.bus,7,false,f.now);const archived=archivedPayload(f.bus,id),receipt=join(archived,"../../receipts",id+".done");
 const before=readFileSync(receipt);
 for(const address of [id,"abcdef123456","spec/"+id,"path="+path]) {
  const show=f.run(["show",address]);expect({rc:show.status,err:show.stderr}).toEqual({rc:0,err:""});expect(show.stdout).toContain("history body");expect(show.stdout).toContain("via=reply");
  const read=f.run(["read",address]);expect({rc:read.status,err:read.stderr}).toEqual({rc:0,err:""});expect(read.stdout).toContain("settled");
 }
 expect(readFileSync(receipt)).toEqual(before);expect(existsSync(join(f.bus,"receipts",id+".read"))).toBe(false);expect(existsSync(join(f.bus,"receipts",id+".done"))).toBe(false);
},30000);
test("indexed partial cleanup resumes and differing copies refuse",()=>{
 const f=fixture(),path=f.put("resume");const source=readFileSync(path);archiveBus(f.bus,7,false,f.now);
 writeFileSync(path,source);utimesSync(path,f.old,f.old);
 expect(archiveBus(f.bus,7,false,f.now).archived).toBe(1);
 const next=f.put("different");const month=f.old.toISOString().slice(0,7);const dest=join(f.bus,"archive",month,"payloads/different.md");writeFileSync(dest,"different bytes");
 expect(()=>archiveBus(f.bus,7,false,f.now)).toThrow("differs");expect(existsSync(next)).toBe(true);
});
test("torn append is ignored and a rerun records complete history; prefix IDs retain their own receipts",()=>{
 const f=fixture();f.put("a");f.put("a.b");mkdirSync(join(f.bus,"archive"));writeFileSync(join(f.bus,"archive/index.ndjson"),'{"id":"torn');
 expect(archiveBus(f.bus,7,false,f.now).archived).toBe(2);
 const rows=archiveRows(f.bus);expect(rows.get("a")!.receipts).toEqual(["a.done"]);expect(rows.get("a.b")!.receipts).toEqual(["a.b.done"]);
 expect(archiveBus(f.bus,7,false,f.now).archived).toBe(0);
});
test("symlinked evidence refuses before removal",()=>{
 const f=fixture(),path=f.put("link");const copy=join(f.root,"outside");copyFileSync(path,copy);rmSync(path);symlinkSync(copy,path);
 expect(()=>archiveBus(f.bus,7,false,f.now)).toThrow("ordinary file");expect(readFileSync(copy,"utf8")).toContain("history body");
});

test("native placement refuses an archived id",async()=>{
 const {canonicalPlace}=await import("../src/courier");
 const f=fixture(),id="duplicate",path=f.put(id);archiveBus(f.bus,7,false,f.now);
 const src=join(f.root,"source.md");writeFileSync(src,"---\n---\nnew bytes\n");
 expect(()=>canonicalPlace(new Bus(f.bus),src,{id,from:"sender",to:"reader",kind:"discuss",path})).toThrow("duplicate");
 expect(existsSync(path)).toBe(false);
});
test("malformed settlement remains active and protects referenced history",()=>{
 const f=fixture();f.put("protected");f.put("uncertain","protected.");writeFileSync(join(f.bus,"receipts/uncertain.done"),"broken");
 expect(archiveBus(f.bus,7,false,f.now).archived).toBe(0);
 expect(existsSync(join(f.bus,"payloads/protected.md"))).toBe(true);
});
test("indexed receipt-only cleanup resumes without losing evidence",()=>{
 const f=fixture();f.put("partial");archiveBus(f.bus,7,false,f.now);
 const row=archiveRows(f.bus).get("partial")!;
 copyFileSync(join(f.bus,"archive",row.month,"receipts/partial.done"),join(f.bus,"receipts/partial.done"));utimesSync(join(f.bus,"receipts/partial.done"),f.old,f.old);
 expect(archiveBus(f.bus,7,false,f.now).archived).toBe(1);
 expect(readFileSync(join(f.bus,"archive",row.month,"receipts/partial.done"),"utf8")).toContain("reply");
});
test("archive job serialization refuses a second writer",async()=>{
 const {acquirePathLock}=await import("../src/panelock");const f=fixture();f.put("locked");
 const lock=acquirePathLock(join(f.bus,"archive.lock"),0);expect(lock).not.toBeNull();
 try{expect(()=>archiveBus(f.bus,7,false,f.now)).toThrow("another bus archive job");expect(existsSync(join(f.bus,"payloads/locked.md"))).toBe(true);}finally{lock?.release();}
});
test("archive CLI validates cutoff",()=>{
 const f=fixture();f.put("cli");const dry=f.run(["bus","archive","--older-than","7d","--dry-run"]);expect(dry.status).toBe(0);expect(dry.stdout).toContain("would archive 1");expect(existsSync(join(f.bus,"archive"))).toBe(false);const bad=f.run(["bus","archive","--older-than","0d"]);expect(bad.status).not.toBe(0);expect(existsSync(join(f.bus,"payloads/cli.md"))).toBe(true);
});

test("open short-id references and active digest items protect settled history",()=>{
 const f=fixture(),id="sender-20260801T000000Z-abcdef123456";f.put(id);f.put("open","read abcdef123456.",false);f.put("digest-history");
 writeFileSync(join(f.bus,"spool/digests/open.json"),JSON.stringify({items:[{id:"digest-history",path:join(f.bus,"payloads/digest-history.md")}]}));
 expect(archiveBus(f.bus,7,false,f.now).archived).toBe(0);
});
test("orphan copy staging is ignored on retry; indexed byte corruption refuses lookup",()=>{
 const f=fixture();f.put("staged");const month=f.old.toISOString().slice(0,7);mkdirSync(join(f.bus,"archive",month,"payloads"),{recursive:true});
 writeFileSync(join(f.bus,"archive",month,"payloads/.archive-copy-crashed"),"partial");
 expect(archiveBus(f.bus,7,false,f.now).archived).toBe(1);
 const path=archivedPayload(f.bus,"staged");writeFileSync(path,"corrupt");
 expect(()=>archivedPayload(f.bus,"staged")).toThrow("hash mismatch");expect(f.run(["show","staged"]).status).not.toBe(0);
});
test("archive nudge reports actionable maintenance failures, never payload volume or machine output",async()=>{
 const {archiveNudge}=await import("../src/bus-archive-index");const f=fixture();
 f.put("settled");expect(archiveNudge(f.bus)).toBe("");
 writeFileSync(join(f.bus,"maintenance.json"),JSON.stringify({at:Date.now(),status:"blocked",expired:0,reconciled:0,held:2,archived:0,error:"custody conflict"}));
 expect(archiveNudge(f.bus)).toBe("bus has 2 parked payloads needing attention; run tap spool list");
 const human=f.run(["team"]);expect(human.stdout).toContain("2 parked payloads needing attention");const json=f.run(["team","--json"]);expect(()=>JSON.parse(json.stdout)).not.toThrow();expect(json.stdout).not.toContain("run tap spool list");expect(f.run(["team","--names"]).stdout).not.toContain("run tap spool list");
},30000);


test("orphan receipts cannot be assigned to a shorter id and unknown formats retain their owner",()=>{
 const f=fixture();f.put("a");f.put("unknown");
 writeFileSync(join(f.bus,"receipts/a.b.done"),"orphan evidence");utimesSync(join(f.bus,"receipts/a.b.done"),f.old,f.old);
 writeFileSync(join(f.bus,"receipts/unknown.future-format"),"future receipt");utimesSync(join(f.bus,"receipts/unknown.future-format"),f.old,f.old);
 expect(archiveBus(f.bus,7,false,f.now).archived).toBe(1);
 expect(readFileSync(join(f.bus,"receipts/a.b.done"),"utf8")).toBe("orphan evidence");
 expect(existsSync(join(f.bus,"payloads/unknown.md"))).toBe(true);
 expect(archiveRows(f.bus).get("a")!.receipts).toEqual(["a.done"]);
});

test("archived replies never create mail",()=>{
 const f=fixture();const id="reply-archive";f.put(id);archiveBus(f.bus,7,false,f.now);
 const body=join(f.root,"reply.md");writeFileSync(body,"late reply");
 const result=f.run(["reply",id,"-f",body]);expect(result.status).not.toBe(0);expect(result.stderr).toContain("canonical payload");

});

test("exact live lookup does not depend on a corrupt archive index",()=>{
 const f=fixture();f.put("live");mkdirSync(join(f.bus,"archive"));writeFileSync(join(f.bus,"archive/index.ndjson"),"broken index\n");
 const shown=f.run(["show","live"]);expect(shown.status).toBe(0);expect(shown.stdout).toContain("history body");
});


test("ordinary bus paths containing archive are not mistaken for month buckets",()=>{
 const f=fixture();const dir=join(f.root,"archive/bus/payloads");mkdirSync(dir,{recursive:true});const path=join(dir,"ordinary.md");writeFileSync(path,"---\nid: ordinary\n---\nordinary pointer\n");
 const result=f.run(["show","path="+path]);expect(result.status).toBe(0);expect(result.stdout).toContain("ordinary pointer");
});

test("corrupt index rows preserve poll and valid history but refuse publication; archive re-appends",async()=>{
 const {canonicalPlace}=await import("../src/courier");
 const f=fixture();f.put("history");archiveBus(f.bus,7,false,f.now);
 const index=join(f.bus,"archive/index.ndjson"),valid=readFileSync(index,"utf8");
 const damaged='garbage\n{}\n{"id":"torn\n';
 writeFileSync(index,damaged+"\n"+valid);f.put("pending","pending body",false);writeFileSync(join(f.bus,"receipts/pending.placed"),"courier");
 {
  const poll=f.run(["poll","reader"]);expect({rc:poll.status,out:poll.stdout,err:poll.stderr}).toMatchObject({rc:2});expect(poll.stdout).toContain("pending");
  expect(poll.stderr).toContain(index);expect(poll.stderr.match(/run tap bus archive/g)?.length).toBe(1);
  const show=f.run(["show","history"]);expect(show.status).toBe(0);expect(show.stdout).toContain("history body");
  const read=f.run(["read","history"]);expect(read.status).toBe(0);expect(read.stdout).toContain("settled");
 }
 const src=join(f.root,"source.md"),path=join(f.bus,"payloads/new-id.md");writeFileSync(src,"---\n---\nnew bytes\n");
 expect(()=>canonicalPlace(new Bus(f.bus),src,{id:"new-id",from:"sender",to:"reader",kind:"discuss",path})).toThrow("archive index unreadable");
 expect(existsSync(path)).toBe(false);
 f.put("retry");expect(archiveBus(f.bus,7,false,f.now).archived).toBe(1);expect(archiveRows(f.bus).has("retry")).toBe(true);
 expect(readFileSync(index,"utf8").startsWith(damaged)).toBe(true);
},30000);

test("interrupted index prefixes stay silent and permit publication after archive retry",async()=>{
 const {canonicalPlace}=await import("../src/courier");
 const f=fixture();f.put("retry");mkdirSync(join(f.bus,"archive"));
 writeFileSync(join(f.bus,"archive/index.ndjson"),'{'+'\n{"id":"retry","settled_at":"2026-08-01T00');
 const retry=f.run(["bus","archive"]);expect(retry.status).toBe(0);expect(retry.stderr).toBe("");
 expect(archiveRows(f.bus,true).has("retry")).toBe(true);
 const src=join(f.root,"source.md");writeFileSync(src,"---\nkind: discuss\n---\nnew bytes\n");
 const path=join(f.bus,"payloads/native-new.md");
 expect(()=>canonicalPlace(new Bus(f.bus),readFileSync(src,"utf8"),{id:"native-new",from:"sender",to:"reader",kind:"discuss",path})).not.toThrow();
 expect(existsSync(path)).toBe(true);
 const shown=f.run(["show","retry"]);expect(shown.status).toBe(0);expect(shown.stderr).toBe("");expect(shown.stdout).toContain("history body");
},30000);
