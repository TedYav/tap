import {afterEach,expect,test} from "bun:test";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,utimesSync,rmSync,copyFileSync,symlinkSync,readdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {spawnSync} from "node:child_process";
import {archiveBus,cutOrder} from "../src/bus-archive";
import {archiveMonths,archivedPayload,monthIndexRows,type ArchiveRow} from "../src/bus-archive-index";
import {Bus} from "../src/bus";
const roots:string[]=[];const original={...process.env};const tree=resolve(import.meta.dir,"../../..");
afterEach(()=>{process.env={...original};for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
// Test-only read of every month manifest; production never reads them all.
function archiveRows(bus:string){const rows=new Map<string,ArchiveRow>();for(const m of archiveMonths(bus))for(const [id,row] of monthIndexRows(bus,m))rows.set(id,row);return rows;}
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
 // Archived history leaves the active bus entirely; nothing enumerates it as mail.
 expect(new Bus(f.bus).canonicalIds()).not.toContain("old");expect(existsSync(join(f.bus,"receipts/old.done"))).toBe(false);
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
 const f=fixture();f.put("a");f.put("a.b");const month=join(f.bus,"archive",f.old.toISOString().slice(0,7));mkdirSync(month,{recursive:true});writeFileSync(join(month,"index.ndjson"),'{"id":"torn');
 expect(archiveBus(f.bus,7,false,f.now).archived).toBe(2);
 const rows=archiveRows(f.bus);expect(rows.get("a")!.receipts).toEqual(["a.done"]);expect(rows.get("a.b")!.receipts).toEqual(["a.b.done"]);
 expect(archiveBus(f.bus,7,false,f.now).archived).toBe(0);
});
test("a dotted id's leftover receipt is not claimed by a shorter active id",()=>{
 const f=fixture();f.put("a.b");const phases=join(f.bus,"receipts","a.b.submit-phases.jsonl");writeFileSync(phases,"{}\n");utimesSync(phases,f.old,f.old);
 expect(archiveBus(f.bus,7,false,f.now).archived).toBe(1);
 const month=f.old.toISOString().slice(0,7);
 // Interrupted after the payload and .done unlinks: only the phases stream is left.
 copyFileSync(join(f.bus,"archive",month,"receipts","a.b.submit-phases.jsonl"),phases);utimesSync(phases,f.old,f.old);
 f.put("a");
 const result=archiveBus(f.bus,7,false,f.now);
 expect({archived:result.archived,retained:result.retained_reasons}).toEqual({archived:2,retained:{}});
 expect(readdirSync(join(f.bus,"receipts"))).toEqual([]);
 expect(archiveRows(f.bus).get("a")!.receipts).toEqual(["a.done"]);
});
test("a retried message archives with its retry stream and marker, never a phantom id",()=>{
 const f=fixture();f.put("old");const uuid="00000000-0000-4000-8000-000000000001";
 for(const name of ["old.attempted","old.idle-submit","old.retries.jsonl",`old.retry-${uuid}.attempted`,`old.retry-${uuid}.idle-submit`]){const p=join(f.bus,"receipts",name);writeFileSync(p,JSON.stringify({id:"old",retry:uuid})+"\n");utimesSync(p,f.old,f.old);}
 expect(archiveBus(f.bus,7,false,f.now).archived).toBe(1);
 expect([...archiveRows(f.bus).keys()]).toEqual(["old"]);
 expect(archiveRows(f.bus).get("old")!.receipts.sort()).toEqual(["old.attempted","old.done","old.idle-submit","old.retries.jsonl",`old.retry-${uuid}.attempted`,`old.retry-${uuid}.idle-submit`].sort());
 for(const name of ["old.retries.jsonl","old.idle-submit",`old.retry-${uuid}.attempted`,`old.retry-${uuid}.idle-submit`]) {
  expect(existsSync(join(f.bus,"receipts",name))).toBe(false);
  expect(readFileSync(join(f.bus,"archive",f.old.toISOString().slice(0,7),"receipts",name),"utf8")).toContain('"id":"old"');
 }
});
test("symlinked evidence refuses before removal",()=>{
 const f=fixture(),path=f.put("link");const copy=join(f.root,"outside");copyFileSync(path,copy);rmSync(path);symlinkSync(copy,path);
 expect(()=>archiveBus(f.bus,7,false,f.now)).toThrow("ordinary file");expect(readFileSync(copy,"utf8")).toContain("history body");
});

// Project decision 2026-11-04: archival is idempotent by ordering. Copies, then the index row,
// are durable before any active file is unlinked, and the payload goes first.
// Every interruption point leaves either a payload with its settlement receipt
// or receipts alone, so poll never surfaces the id and a rerun finishes the cut.
test("an archive interrupted after any step never surfaces as mail and the next pass completes once",()=>{
 const stages=["after-copy","after-index","after-payload-unlink","after-first-receipt-unlink"] as const;
 for(const stage of stages){
  const f=fixture(),id="sender-20260801T000000Z-abcdef123456";f.put(id);
  const placed=join(f.bus,"receipts",id+".placed");writeFileSync(placed,"courier");utimesSync(placed,f.old,f.old);
  expect(archiveBus(f.bus,7,false,f.now).archived).toBe(1);
  const row=archiveRows(f.bus).get(id)!,month=join(f.bus,"archive",row.month),index=join(month,"index.ndjson");
  expect(row.receipts).toEqual([id+".done",id+".placed"]);
  const restore=(from:string,to:string)=>{copyFileSync(from,to);utimesSync(to,f.old,f.old);};
  // Rebuild the active files the cut had not yet removed at this stage.
  if(stage==="after-copy"||stage==="after-index")restore(join(month,"payloads",id+".md"),join(f.bus,"payloads",id+".md"));
  const kept=stage==="after-first-receipt-unlink"?row.receipts.slice(1):row.receipts;
  for(const name of kept)restore(join(month,"receipts",name),join(f.bus,"receipts",name));
  if(stage==="after-copy")writeFileSync(index,readFileSync(index,"utf8").split("\n").filter(line=>!line.includes(id)).join("\n"));
  const poll=f.run(["poll","reader","--json"]);
  expect(poll.status,stage).toBe(0);expect(JSON.parse(poll.stdout).pending,stage).toEqual([]);
  expect(archiveBus(f.bus,7,false,f.now).archived,stage).toBe(1);
  expect(readFileSync(index,"utf8").split("\n").filter(line=>line.includes(`"id":"${id}"`)).length,stage).toBe(1);
  expect(existsSync(join(f.bus,"payloads",id+".md")),stage).toBe(false);
  expect(readdirSync(join(f.bus,"receipts")).filter(name=>name.startsWith(id)),stage).toEqual([]);
  expect(archiveBus(f.bus,7,false,f.now).archived,stage).toBe(0);
  expect(readFileSync(archivedPayload(f.bus,id),"utf8"),stage).toContain("history body");
 }
},60000);
test("the cut unlinks the payload before every receipt, whatever the receipt names sort to",()=>{
 const payload="/bus/payloads/x.md",receipts=["/bus/receipts/x.retries.jsonl","/bus/receipts/x.done","/bus/receipts/x.attempted","/bus/receipts/x.cancelled"];
 const order=cutOrder(payload,receipts);
 expect(order[0]).toBe(payload);expect(order.slice(1)).toEqual([...receipts].sort());
 expect(cutOrder(null,receipts)).toEqual([...receipts].sort());
 // Production builds its list through cutOrder; a hand-built list would bypass this pin.
 expect(readFileSync(resolve(import.meta.dir,"../src/bus-archive.ts"),"utf8").match(/const files=cutOrder\(/g)?.length).toBe(1);
});
test("tap resend of an archived id is a suppressed no-op that records nothing",()=>{
 const f=fixture(),id="sender-20260801T000000Z-abcdef123456";f.put(id);archiveBus(f.bus,7,false,f.now);
 process.env.TAP_SELF="sender";
 const human=f.run(["resend",id]);expect({rc:human.status,out:human.stdout,err:human.stderr}).toEqual({rc:0,out:`tap resend: ${id} already archived\n`,err:""});
 const json=f.run(["resend",id,"--json"]);expect(json.status).toBe(0);
 expect(JSON.parse(json.stdout)).toEqual({status:"suppressed",id,to:"reader",state:"archived"});
 expect(readdirSync(join(f.bus,"receipts"))).toEqual([]);expect(existsSync(join(f.bus,"payloads",id+".md"))).toBe(false);
},30000);
test("custom and future-stamped ids resolve by month walk; a second send --id of either is refused alike",()=>{
 const f=fixture(),custom="custom-handoff",future="sender-20990101T000000Z-abcdef123456",current="sender-20260801T000000Z-0123456789ab";
 for(const id of [custom,future,current])f.put(id);
 expect(archiveBus(f.bus,7,false,f.now).archived).toBe(3);
 const month=f.old.toISOString().slice(0,7);
 for(const id of [custom,future,current]) {
  expect(archivedPayload(f.bus,id)).toBe(join(f.bus,"archive",month,"payloads",id+".md"));
  const shown=f.run(["show",id]);expect(shown.status,shown.stderr).toBe(0);expect(shown.stdout).toContain("history body");
 }
 process.env.TAP_SELF="sender";
 expect(JSON.parse(f.run(["resend",custom,"--json"]).stdout)).toMatchObject({status:"suppressed",state:"archived"});
 process.env.TAP_SELF="reader";
 writeFileSync(join(f.root,".tap/team-registry.json"),JSON.stringify({schema:"0.20",team:{name:"spec"},seats:{reader:{instance:"reader|new",status:"active",delivery:"poll"},peer:{instance:"peer|1",status:"active",delivery:"poll"}}}));
 const body=join(f.root,"again.md");writeFileSync(body,"again");
 const refusals=[future,current].map(id=>{const r=f.run(["send","peer","--id",id,"-f",body]);return {rc:r.status,err:r.stderr.replaceAll(id,"<id>")};});
 expect(refusals[0]!.rc).not.toBe(0);expect(refusals[0]!.err).toContain("refusing duplicate archived id '<id>'");
 expect(refusals[1]).toEqual(refusals[0]!);
 for(const id of [future,current])expect(existsSync(join(f.bus,"payloads",id+".md"))).toBe(false);
},60000);
test("an id minted at month end and settled the next month resolves through the walk",()=>{
 const f=fixture(),id="sender-20260831T235958Z-abcdef123456",settled=new Date("2026-09-01T00:00:04Z");
 const path=f.put(id);utimesSync(path,f.old,f.old);writeFileSync(join(f.bus,"receipts",id+".done"),JSON.stringify({id,at:settled.toISOString(),by:"reader",via:"reply"}));utimesSync(join(f.bus,"receipts",id+".done"),f.old,f.old);
 expect(archiveBus(f.bus,7,false,f.now).archived).toBe(1);
 expect(archivedPayload(f.bus,id)).toBe(join(f.bus,"archive","2026-09","payloads",id+".md"));
 expect([...monthIndexRows(f.bus,"2026-09").keys()]).toEqual([id]);
});
test("an id already archived in another month stays active and both months are named",()=>{
 const f=fixture(),id="reused",path=f.put(id),month=f.old.toISOString().slice(0,7),other="2020-01";
 mkdirSync(join(f.bus,"archive",other,"payloads"),{recursive:true});mkdirSync(join(f.bus,"archive",other,"receipts"));
 copyFileSync(path,join(f.bus,"archive",other,"payloads",id+".md"));
 const errors:string[]=[];const original=console.error;console.error=(m:string)=>{errors.push(String(m));};
 try{const r=archiveBus(f.bus,7,false,f.now);expect(r.archived).toBe(0);expect(r.retained_reasons).toEqual({"archived-in-other-month":1});}finally{console.error=original;}
 expect(errors).toEqual([`tap bus archive: ${id} is already archived in ${other} but settled in ${month}; left active for inspection`]);
 expect(existsSync(path)).toBe(true);expect(existsSync(join(f.bus,"receipts",id+".done"))).toBe(true);
 expect(monthIndexRows(f.bus,month).size+monthIndexRows(f.bus,other).size).toBe(0);
});
test("lookups read no manifest; a run reads only the manifest of the month it appends to",()=>{
 const f=fixture(),leftover="sender-20260801T000000Z-aaaaaaaaaaaa",fresh="sender-20260801T000000Z-bbbbbbbbbbbb";
 f.put(leftover);const placed=join(f.bus,"receipts",leftover+".placed");writeFileSync(placed,"courier");utimesSync(placed,f.old,f.old);
 expect(archiveBus(f.bus,7,false,f.now).archived).toBe(1);
 const month=f.old.toISOString().slice(0,7);
 // Interrupt the cut after the payload unlink: one receipt is left behind.
 copyFileSync(join(f.bus,"archive",month,"receipts",leftover+".placed"),placed);utimesSync(placed,f.old,f.old);
 for(let n=0;n<24;n++){const m=`2024-${String(n%12+1).padStart(2,"0")}`.replace("2024",String(2023+Math.floor(n/12)));mkdirSync(join(f.bus,"archive",m,"payloads"),{recursive:true});writeFileSync(join(f.bus,"archive",m,"index.ndjson"),JSON.stringify({id:`seed-${n}`,month:m})+"\n");}
 f.put(fresh);
 const child=spawnSync(process.execPath,[join(import.meta.dir,"support/archive-month-reads-entry.ts"),f.bus,leftover,String(f.now)],{env:{...process.env,TAP_LOCK_DIR:join(f.root,"locks")},encoding:"utf8"});
 expect(child.status,child.stderr).toBe(0);
 expect(JSON.parse(child.stdout)).toEqual({lookupManifestReads:[],found:month,archived:2,runManifestReads:[month],leftoverGone:true});
},30000);
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
test("orphan copy staging is ignored on retry; reads do not re-hash archived bytes",()=>{
 const f=fixture();f.put("staged");const month=f.old.toISOString().slice(0,7);mkdirSync(join(f.bus,"archive",month,"payloads"),{recursive:true});
 writeFileSync(join(f.bus,"archive",month,"payloads/.archive-copy-crashed"),"partial");
 expect(archiveBus(f.bus,7,false,f.now).archived).toBe(1);
 const path=archivedPayload(f.bus,"staged");writeFileSync(path,"corrupt");
 // Duct tape (project decision, 2026-11-04): bytes were verified when copied; a damaged
 // archived copy is damaged history, never mail, so lookup still answers.
 expect(archivedPayload(f.bus,"staged")).toBe(path);
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

test("corrupt manifest rows never reach poll or publication; valid history stays readable; archive re-appends",async()=>{
 const {canonicalPlace}=await import("../src/courier");
 const f=fixture();f.put("history");archiveBus(f.bus,7,false,f.now);
 const index=join(f.bus,"archive",f.old.toISOString().slice(0,7),"index.ndjson"),valid=readFileSync(index,"utf8");
 writeFileSync(join(f.bus,"archive/index.ndjson"),"frozen legacy root, never read\n");
 const damaged='garbage\n{}\n{"id":"torn\n';
 writeFileSync(index,damaged+"\n"+valid);f.put("pending","pending body",false);writeFileSync(join(f.bus,"receipts/pending.placed"),"courier");
 {
  const poll=f.run(["poll","reader"]);expect({rc:poll.status,out:poll.stdout,err:poll.stderr}).toMatchObject({rc:0,err:""});expect(poll.stdout).toContain("pending");
  const show=f.run(["show","history"]);expect(show.status).toBe(0);expect(show.stdout).toContain("history body");
  const read=f.run(["read","history"]);expect(read.status).toBe(0);expect(read.stdout).toContain("settled");
 }
 const src=join(f.root,"source.md"),path=join(f.bus,"payloads/new-id.md");writeFileSync(src,"---\n---\nnew bytes\n");
 expect(()=>canonicalPlace(new Bus(f.bus),readFileSync(src,"utf8"),{id:"new-id",from:"sender",to:"reader",kind:"discuss",path})).not.toThrow();
 expect(existsSync(path)).toBe(true);
 f.put("retry");expect(archiveBus(f.bus,7,false,f.now).archived).toBe(1);expect(archiveRows(f.bus).has("retry")).toBe(true);
 expect(readFileSync(index,"utf8").startsWith(damaged)).toBe(true);
},30000);

test("interrupted index prefixes stay silent and permit publication after archive retry",async()=>{
 const {canonicalPlace}=await import("../src/courier");
 const f=fixture();f.put("retry");mkdirSync(join(f.bus,"archive"));
 writeFileSync(join(f.bus,"archive/index.ndjson"),'{'+'\n{"id":"retry","settled_at":"2026-08-01T00');
 const retry=f.run(["bus","archive"]);expect(retry.status).toBe(0);expect(retry.stderr).toBe("");
 expect(archiveRows(f.bus).has("retry")).toBe(true);
 const src=join(f.root,"source.md");writeFileSync(src,"---\nkind: discuss\n---\nnew bytes\n");
 const path=join(f.bus,"payloads/native-new.md");
 expect(()=>canonicalPlace(new Bus(f.bus),readFileSync(src,"utf8"),{id:"native-new",from:"sender",to:"reader",kind:"discuss",path})).not.toThrow();
 expect(existsSync(path)).toBe(true);
 const shown=f.run(["show","retry"]);expect(shown.status).toBe(0);expect(shown.stderr).toBe("");expect(shown.stdout).toContain("history body");
},30000);
