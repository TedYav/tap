import {completeHarnessQueued,recordAuthorizedRead,recordHarnessQueued,harnessQueued} from "../src/harness-queue";
import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildFixture, releaseReadScratch, readScratch } from "./support/read-fixture";
import { liveFenceBytes } from "./support/live-fence";
import { acquireObligationLock } from "../src/panelock";

afterAll(()=>releaseReadScratch());
const A='sender-20260905T130000Z-aaaaaaaaaaaa',B='sender-20260905T130000Z-bbbbbbbbbbbb';

test('read note discharges once via read; repeated read preserves first receipt',()=>{
  const f=buildFixture(),id=A; f.payload(id);
  const r=f.parity([id]); expect(r.code).toBe(0);
  const done=join(f.bus,'receipts',`${id}.done`); expect(JSON.parse(readFileSync(done,'utf8'))).toMatchObject({id,status:'done',by:'reader',via:'read',identity:'declared'});
  expect(existsSync(join(f.bus,'receipts',`${id}.read`))).toBe(false);
  const first=readFileSync(done,'utf8'); f.parity([id]); expect(readFileSync(done,'utf8')).toBe(first);
});
test('read ask and legacy absent reply stamp observation but leave obligation open',()=>{
  for(const reply of ['expected','']) {const f=buildFixture(),id=A;f.payload(id,reply);f.parity([id,'--epoch','17']);expect(existsSync(join(f.bus,'receipts',`${id}.done`))).toBe(false);expect(JSON.parse(readFileSync(join(f.bus,'receipts',`${id}.read`),'utf8')).epoch).toBe('17');}
});
test('read compact and verbose bodies/ages preserve terminal precedence',()=>{
  for(const state of ['','done','cancelled','archive']) {const f=buildFixture(),id=A; f.payload(id,'expected');if(state==='archive'){f.put(`archive/${id}.cancelled.md`,readFileSync(join(f.bus,'payloads',`${id}.md`),'utf8'));rmSync(join(f.bus,'payloads',`${id}.md`));}else if(state)f.put(`receipts/${id}.${state}`,'{"via":"reply"}\n'); const r=f.parity([id],true);expect(r.code).toBe(0);expect(r.out).toContain(state ? 'nothing owed':'tap reply');}
});
test('read immutable refusals write nothing',()=>{
  for(const extra of ['to: peer\n','to_team: other\n','id: other\n']) {const f=buildFixture(),id=A; f.payload(id);const path=join(f.bus,'payloads',`${id}.md`);
    if(extra.startsWith('to:'))writeFileSync(path,readFileSync(path,'utf8').replace('to: reader','to: peer'));
    else if(extra.startsWith('id:'))writeFileSync(path,readFileSync(path,'utf8').replace(`id: ${id}`,'id: other'));
    else f.payload(id,'settle-only',extra);
    const r=f.parity([id]);expect(r.code).toBe(1);expect(r.after).toEqual(r.before);
  }
  const f=buildFixture(),id=A; f.payload(id,'unexpected'); const r=f.parity([id]);expect(r.code).toBe(1);expect(r.after).toEqual(r.before);
});
test('read force records peer observation and never claims reply authority',()=>{
  const f=buildFixture(),id=A;f.payload(id,'expected');const p=join(f.bus,'payloads',`${id}.md`);writeFileSync(p,readFileSync(p,'utf8').replace('to: reader','to: peer'));
  const r=f.parity([id,'--force']);expect(r.code).toBe(0);expect(r.out).toContain('this read settles nothing');expect(readFileSync(join(f.bus,'registry-events.log'),'utf8')).toContain('action=read_forced');
  expect(JSON.parse(readFileSync(join(f.bus,'receipts',`${id}.read`),'utf8')).forced).toBe('true');
});
test('read predecessor note retires, predecessor ask refuses and force records mismatch',()=>{
  for(const reply of ['settle-only','expected']) {const f=buildFixture(),id=A;f.payload(id,reply,'recipient_instance: reader|old\n');const r=f.parity([id]);expect(r.code).toBe(reply==='settle-only'?0:1);if(reply==='settle-only')expect(JSON.parse(readFileSync(join(f.bus,'receipts',`${id}.done`),'utf8')).reason).toBe('instance_retired');else expect(f.parity([id,'--force']).out).toContain('no actor-side clearing path');}
});
test('read digest records its own observation and reads selected bodies independently',()=>{
  const f=buildFixture(),a=A,b='sender-20260905T130000Z-bbbbbbbbbbbb',d='courier-20260905T130001Z-cccccccccccc';f.payload(a);f.payload(b,'expected');f.put(`spool/digests/${d}.json`,JSON.stringify({kind:'digest',digest_id:d,to:'reader',to_team:'spec',items:[a,b].map(id=>({id,path:join(f.bus,'payloads',`${id}.md`),from:'sender',reply:id===a?'settle-only':'expected'}))}));
  expect(f.parity([d]).code).toBe(0);expect(existsSync(join(f.bus,'receipts',`${d}.read`))).toBe(true);expect(existsSync(join(f.bus,'receipts',`${a}.done`))).toBe(false);expect(f.parity([d,'--all']).code).toBe(0);expect(existsSync(join(f.bus,'receipts',`${a}.done`))).toBe(true);expect(existsSync(join(f.bus,'receipts',`${b}.read`))).toBe(true);expect(existsSync(join(f.bus,'receipts',`${d}.done`))).toBe(false);
});

test('read adopted local binding records the successor and predecessor grant',()=>{
  const f=buildFixture(),id=A;
  const reg=JSON.parse(readFileSync(f.registry,'utf8'));
  reg.seats.reader.adopted_handles=['fork'];reg.seats.reader.adopted_instances={fork:'fork|old'};
  writeFileSync(f.registry,JSON.stringify(reg));
  f.payload(id,'settle-only','to_adopted_from: fork\nrecipient_instance: fork|old\n');
  expect(f.parity([id]).code).toBe(0);
  expect(JSON.parse(readFileSync(join(f.bus,'receipts',`${id}.done`),'utf8'))).toMatchObject({by:'reader',adopted_from:'fork',via:'read'});
});
test('read reset fence refuses before any receipt; invalid envelope also stays unchanged',()=>{
  for(const fence of [true,false]) {const f=buildFixture(),id=A;f.payload(id);if(fence)f.put('reset.fence.json',liveFenceBytes());else f.put(`payloads/${id}.md`,'malformed\n');const r=f.parity([id]);expect(r.code).toBe(1);expect(r.after).toEqual(r.before);}
});

for(const reply of ['expected','settle-only']) {
 test(`queued receipt becomes sent only on actual read: ${reply}`,()=>{
  const f=buildFixture(),id=B; f.payload(id,reply);
  recordHarnessQueued(f.bus,id);
  const sent=join(f.bus,'receipts',`${id}.sent`);
  expect(existsSync(sent)).toBe(false);
  expect(f.run("native",[id]).code).toBe(0);
  expect(JSON.parse(readFileSync(sent,'utf8'))).toMatchObject({id,via:'harness-queue-read',read_by:'reader'});
  const bytes=readFileSync(sent,'utf8'); expect(f.run("native",[id]).code).toBe(0); expect(readFileSync(sent,'utf8')).toBe(bytes);
 });
}
test(`forced queue read never creates sent`,()=>{
 const f=buildFixture(),id='sender-20260905T130000Z-cccccccccccc';f.payload(id,'expected');recordHarnessQueued(f.bus,id);
 expect(f.run("native",[id,'--force']).code).toBe(0);
 expect(existsSync(join(f.bus,'receipts',`${id}.sent`))).toBe(false);
 expect(harnessQueued(f.bus,id)).toBe(true);
});

test(`queued index-backed digest completes sent on read`,()=>{
 const f=buildFixture(),id='courier-20260905T130001Z-dddddddddddd';
 f.put(`spool/digests/${id}.json`,JSON.stringify({kind:'digest',digest_id:id,to:'reader',to_team:'spec',items:[]}));
 recordHarnessQueued(f.bus,id,{from:'courier',to:'reader',kind:'digest'});
 expect(existsSync(join(f.bus,'receipts',`${id}.sent`))).toBe(false);
 expect(f.run("native",[id]).code).toBe(0);
 expect(JSON.parse(readFileSync(join(f.bus,'receipts',`${id}.sent`),'utf8'))).toMatchObject({id,via:'harness-queue-read',read_by:'reader'});
},30000);

test(`retired-instance note cleanup does not erase queued transport evidence`,()=>{
 const f=buildFixture(),id='sender-20260905T130000Z-eeeeeeeeeeee';
 f.payload(id,'settle-only','recipient_instance: reader|old\n'); recordHarnessQueued(f.bus,id);
 expect(f.run("native",[id]).code).toBe(0);
 expect(existsSync(join(f.bus,'receipts',`${id}.sent`))).toBe(false);
 expect(harnessQueued(f.bus,id)).toBe(true);
});

function parkedSeed(f:ReturnType<typeof buildFixture>,id:string,to:string,reply:string,instance='reader|new'):void{
 writeFileSync(join(f.bus,'spool',`${id}.md`),`---\nid: ${id}\nfrom: sender\nto: ${to}\nkind: discuss\npath: ${join(f.bus,'payloads',`${id}.md`)}\nreply: ${reply}\nrecipient_instance: ${instance}\nto_team: \n---\n\nparked body ${id}\n`);
 writeFileSync(join(f.bus,'spool',`${id}.meta.json`),JSON.stringify({id,target:to,target_registry:f.registry,to_team:'spec',reason:'queued-input',reason_class:'busy',first_spooled_epoch:7,deadline_epoch:1,waiter_lifetime:'grace-window'}));
}
test('read reply tail carries only the declared --by/--team flags',()=>{
 const f=buildFixture(),id=A; f.payload(id,'expected');
 const r=f.parity([id,'--by','reader','--team','spec'],true,'tail');
 expect(r.code).toBe(0);
 expect(r.out).toContain(`tap reply ${id} --by reader --team spec -f`);
});
test('read path= resolves a canonical payload pointer in process',()=>{
 const f=buildFixture(),id=A; f.payload(id);
 const r=f.parity(['path='+join(f.bus,'payloads',`${id}.md`)],false,'pathq');
 expect(r.code).toBe(0);
 expect(JSON.parse(readFileSync(join(f.bus,'receipts',`${id}.done`),'utf8'))).toMatchObject({id,via:'read'});
});
test('parked settle-only note hands custody to canonical bytes and settles once',()=>{
 const f=buildFixture(),id=B; parkedSeed(f,id,'reader','settle-only');
 const bytes=readFileSync(join(f.bus,'spool',`${id}.md`),'utf8');
 const r=f.parity([id],false,'spoolq');
 expect(r.code).toBe(0);
 expect(readFileSync(join(f.bus,'payloads',`${id}.md`),'utf8')).toBe(bytes);
 expect(existsSync(join(f.bus,'spool',`${id}.md`))).toBe(false);
 expect(existsSync(join(f.bus,'spool',`${id}.meta.json`))).toBe(false);
 expect(existsSync(join(f.bus,'spool',`${id}.claim`))).toBe(false);
 expect(JSON.parse(readFileSync(join(f.bus,'receipts',`${id}.done`),'utf8'))).toMatchObject({id,by:'reader',via:'read'});
});
test('parked ask hands custody and stamps its open obligation without waiting',()=>{
 const f=buildFixture(),id=B; parkedSeed(f,id,'reader','expected');
 const bytes=readFileSync(join(f.bus,'spool',`${id}.md`),'utf8');
 const r=f.parity([id],false,'spoolask');
 expect(r.code).toBe(0);
 expect(readFileSync(join(f.bus,'payloads',`${id}.md`),'utf8')).toBe(bytes);
 expect(existsSync(join(f.bus,'spool',`${id}.md`))).toBe(false);
 expect(JSON.parse(readFileSync(join(f.bus,'receipts',`${id}.read`),'utf8'))).toMatchObject({id,by:'reader'});
 expect(existsSync(join(f.bus,'receipts',`${id}.done`))).toBe(false);
});
test('parked mail addressed to a peer refuses without touching the queue',()=>{
 const f=buildFixture(),id=B; parkedSeed(f,id,'peer','settle-only');
 const r=f.parity([id],false,'spoolpeer');
 expect(r.code).toBe(1);
 expect(r.after).toEqual(r.before);
});
test('digest member with a mismatched filename refuses while siblings settle',()=>{
  const f=buildFixture(),a=A,x='sender-20260905T130009Z-9999aaaabbbb',d='courier-20260905T130001Z-cccccccccccc';
  f.payload(a);
  f.put(`spool/digests/${d}.json`,JSON.stringify({kind:'digest',digest_id:d,to:'reader',to_team:'spec',items:[{id:a,path:join(f.bus,'payloads',`${a}.md`),from:'sender',reply:'settle-only'},{id:x,path:join(f.bus,'payloads',`${a}.md`),from:'sender',reply:'settle-only'}]}));
  const r=f.parity([d,'--all'],false,'digestmember');
  expect(r.code).toBe(1);
  expect(r.err).toContain(`item ${x} path does not match its payload id`);
  expect(JSON.parse(readFileSync(join(f.bus,'receipts',`${a}.done`),'utf8'))).toMatchObject({id:a,via:'read'});
});

test('exclusive publication races to exactly one whole creator, never an overwriting or torn one',async()=>{
  // The public note race (read-verb.test.sh 15b) cannot distinguish a replacing
  // or torn write from an exclusive create: once a receipt exists the settled
  // guard skips the write, and same-granularity racers produce identical end
  // states. The mechanism is raced where it lives, with DISTINCT bodies: the
  // replacing mutant lets a second creator through or publishes mixed bytes,
  // and the torn mutant publishes a truncated winner — each fails here.
  const dir=join(readScratch(),'race'); mkdirSync(dir,{recursive:true});
  const target=join(dir,'one.json');
  const entry=join(import.meta.dir,'support','first-observation-entry.ts');
  // All eight start together: each child announces readiness behind a
  // helper-local barrier and holds there, so the exclusive-create race begins
  // with every racer already loaded rather than on sequential exits. Exactly
  // one creator must survive with its whole body; the other seven lose.
  const barrier=join(dir,'start');
  const env={...process.env};
  const kids=Array.from({length:8},(_,i)=>Bun.spawn([process.execPath,entry,`--barrier`,barrier,`--slot`,String(i),target,`id=one`,`by=writer${i}`,`pad=${'x'.repeat(2000)}`],{stdout:'pipe',stderr:'pipe',env}));
  // Bounded, asynchronously yielding staging wait: all eight ready, or the
  // setup failed — on deadline or any early child exit, kill and reap every
  // started child so the test leaves no processes behind, then fail loudly.
  const stage=async(): Promise<void>=>{
    const deadline=Date.now()+30_000;
    while(Date.now()<deadline){
      if(kids.some(k=>k.exitCode!==null||k.signalCode!==null)) break;
      if(kids.filter((_,i)=>existsSync(`${barrier}.${i}.ready`)).length===8) return;
      await Bun.sleep(2);
    }
    for(const k of kids) k.kill();
    await Promise.all(kids.map(k=>k.exited));
    throw new Error(`first-observation racers failed to stage: ${kids.filter(k=>k.exitCode!==null||k.signalCode!==null).length} child(ren) exited before release or the readiness deadline passed`);
  };
  await stage();
  writeFileSync(`${barrier}.go`,'1\n');
  const outs=await Promise.all(kids.map(async(k,i)=>({i,verdict:(await new Response(k.stdout).text()).trim()})));
  const created=outs.filter(o=>o.verdict==='created');
  expect(created).toHaveLength(1);
  expect(outs.filter(o=>o.verdict==='loser')).toHaveLength(7);
  expect(outs.every(o=>o.verdict==='created'||o.verdict==='loser')).toBe(true);
  const doc=JSON.parse(readFileSync(target,'utf8')) as {by:string;pad:string};
  expect(doc.by).toBe(`writer${created[0]!.i}`);
  expect(doc.pad).toBe('x'.repeat(2000));
  expect(statSync(target).mode & 0o777).toBe(0o600);
  // The smallest failure injection: fsync throws before publication, so the
  // owned temp must be unlinked on the way out and NO final receipt may
  // appear — the producer-side twin of "never report a read without its
  // record". Injection lives in the test entry; production gains no knob.
  const fault=join(dir,'fault.json');
  const f=Bun.spawnSync([process.execPath,entry,'--fsync-fail',fault,`id=one`,`by=failer`],{stdout:'pipe',stderr:'pipe',env});
  expect(f.exitCode).toBe(1);
  expect(f.stdout.toString()).toContain('could not write the receipt');
  expect(existsSync(fault)).toBe(false);
  expect(readdirSync(dir).filter(n=>n.startsWith('.tap.'))).toEqual([]);
});

test('a pane-inferred parent dispatches digest members with DECLARED identity and reply hints',()=>{
  // The incumbent spawned each member as a child that parsed its own
  // `--by`/`--team`: declared identity, no parent pane provenance, reply hints
  // naming the actor. A member dispatch that instead reused the parent's
  // pane-inferred closure would stamp member receipts `identity: "pane"` with
  // the parent's pane id and drop `--by` from the reply hint — the regression
  // this control kills end to end, with the parent's actor coming from a faked
  // pane observation (TAP_SELF deliberately unset).
  const root=join(readScratch(),'pane-parent'),bus=join(root,'.tap/bus'),index=join(root,'index'),home=join(root,'home'),bin=join(root,'bin');
  for(const dir of ['payloads','receipts','spool/digests']) mkdirSync(join(bus,dir),{recursive:true});
  mkdirSync(index,{recursive:true}); mkdirSync(home); mkdirSync(bin);
  const registry=join(root,'.tap','team-registry.json');
  writeFileSync(registry,JSON.stringify({schema:'0.20',team:{name:'spec'},seats:{reader:{instance:'reader|new',status:'active',pane_id:'%5',server_epoch:'srv:900:100'},peer:{instance:'peer|new',status:'active'}}}));
  writeFileSync(join(index,'global-registry.json'),JSON.stringify({schema:'0.20',teams:{spec:{root,registry_location:registry,state:'registered'}}}));
  const a=A,d='courier-20260905T130002Z-cccccccccccc';
  writeFileSync(join(bus,'payloads',`${a}.md`),`---\nid: ${a}\nfrom: sender\nto: reader\nkind: discuss\npath: ${join(bus,'payloads',`${a}.md`)}\nreply: expected\n---\n\nmember body\n`);
  writeFileSync(join(bus,'spool','digests',`${d}.json`),JSON.stringify({kind:'digest',digest_id:d,to:'reader',to_team:'spec',items:[{id:a,path:join(bus,'payloads',`${a}.md`),from:'sender',reply:'expected'}]}));
  // A ps row with a controllable tty plus a tmux inventory naming pane %5 on
  // that tty: the parent's ancestry walk observes a real inside-tmux shape.
  // Both shims match the SUBCOMMAND anywhere in argv — tmux is invoked with a
  // leading `-L <socket>`, so a `case "$1"` would never see the verb.
  writeFileSync(join(bin,'ps'),'#!/bin/sh\ncase "$1" in -o) printf "  1 ttysFake\\n" ;; esac\n',{mode:0o755});
  writeFileSync(join(bin,'tmux'),'#!/bin/sh\nfor a in "$@"; do case "$a" in\n  list-panes) printf \'%%5\\t/dev/ttysFake\\n\'; exit 0 ;;\n  display-message) printf \'%%5\\t/dev/ttysFake\\tdemo\\t900:100\\n\'; exit 0 ;;\nesac; done\nexit 1\n',{mode:0o755});
  const env:NodeJS.ProcessEnv={...process.env,HOME:home,PWD:root,TAP_HOME:bus,TAP_INDEX_HOME:index,TAP_VERBOSE:'1',PATH:`${bin}:${process.env.PATH}`,TAP_VERSION_SEEN_PATH:join(root,'seen'),TAP_SESSION_MANIFEST:join(root,'sessions'),OPENCODE_DB_PATH:join(root,'opencode.db')};
  delete (env as Record<string,string|undefined>).TAP_SELF;
  delete (env as Record<string,string|undefined>).TMUX;
  delete (env as Record<string,string|undefined>).TMUX_PANE;
  const r=Bun.spawnSync([process.execPath,join(import.meta.dir,'..','main.ts'),'read',d,'--all'],{cwd:root,env,stdout:'pipe',stderr:'pipe',timeout:20_000});
  const out=r.stdout.toString();
  expect(r.exitCode,`${out}${r.stderr.toString()}`).toBe(0);
  expect(existsSync(join(bus,'receipts',`${d}.read`))).toBe(true);
  expect(existsSync(join(bus,'receipts',`${a}.done`))).toBe(false);
  const rec=JSON.parse(readFileSync(join(bus,'receipts',`${a}.read`),'utf8')) as Record<string,unknown>;
  expect(rec).toMatchObject({id:a,by:'reader',identity:'declared'});
  expect(rec.pane).toBeUndefined();
  expect(out).toContain(`tap reply ${a} --by reader --team spec -f`);
});

// Append after the parity fixtures so their ordinal golden keys stay stable.
for (const destination of ["canonical", "archive", "both"] as const) {
  test(`locked parked read follows only completed canonical promotion: ${destination}`, async () => {
    const f = buildFixture(), id = A;
    parkedSeed(f, id, "reader", "settle-only");
    const barrier = join(f.root, "promotion-barrier");
    const env = { ...process.env, TAP_HOME: f.bus, TAP_INDEX_HOME: join(f.root, "index"),
      TAP_LOCK_DIR: join(f.root, "locks"), TAP_SELF: "reader", TAP_JSON: "1",
      TAP_READ_TEST_BARRIER: barrier, TAP_READ_TEST_ID: id, TAP_SCRATCH_ONLY: "1" };
    let held = acquireObligationLock(id, 1000, env);
    expect(held).not.toBeNull();
    const reader = Bun.spawn([process.execPath, join(import.meta.dir, "support/native-read-entry.ts"), id],
      { cwd: f.root, env, stdout: "pipe", stderr: "pipe", timeout: 10000 });
    try {
      const reached = `${barrier}.gates.${reader.pid}.reached`;
      const deadline = Date.now() + 5000;
      while (!existsSync(reached) && reader.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
      expect(existsSync(reached)).toBe(true);
      expect(existsSync(join(f.bus, "receipts", `${id}.done`))).toBe(false);
      const spool = join(f.bus, "spool", `${id}.md`);
      const target = join(f.bus, destination === "archive" ? "archive" : "payloads",
        destination === "archive" ? `${id}.cancelled.md` : `${id}.md`);
      if (destination === "both") copyFileSync(spool, target);
      else renameSync(spool, target);
      writeFileSync(`${barrier}.gates.release`, "1");
      held!.release(); held = null;
      const rc = await reader.exited;
      const out = await new Response(reader.stdout).text();
      const err = await new Response(reader.stderr).text();
      if (destination === "canonical") {
        expect(rc, err).toBe(0);
        expect(out).toContain(`parked body ${id}`);
        expect(readdirSync(join(f.bus, "receipts"))).toEqual([`${id}.done`]);
        const receipt = readFileSync(join(f.bus, "receipts", `${id}.done`), "utf8");
        expect(JSON.parse(receipt)).toMatchObject({ id, via: "read", by: "reader" });
        expect(f.run("native", [id]).code).toBe(0);
        expect(readFileSync(join(f.bus, "receipts", `${id}.done`), "utf8")).toBe(receipt);
      } else {
        expect(rc).toBe(1);
        expect(JSON.parse(out).error_class).toBe("not_found");
        expect(readdirSync(join(f.bus, "receipts"))).toEqual([]);
      }
    } finally {
      held?.release();
      reader.kill();
      await reader.exited;
    }
  }, 15000);
}

// tap-stap: the settle-only `.done` names the settling instance. Appended after the LAST
// test so these fixtures take serials after every parity fixture and no golden key moves.
function settledReceipt(extra: string, edit?: (registry: any) => void) {
  const f = buildFixture();
  if (edit) { const reg = JSON.parse(readFileSync(f.registry, "utf8")); edit(reg); writeFileSync(f.registry, JSON.stringify(reg)); }
  f.payload(A, "settle-only", extra);
  expect(f.run("native", [A]).code).toBe(0);
  return JSON.parse(readFileSync(join(f.bus, "receipts", `${A}.done`), "utf8"));
}

test("a matching binding stamps the settling instance, equal to the envelope's", () => {
  const receipt = settledReceipt("recipient_instance: reader|new\n");
  expect(receipt).toMatchObject({ by: "reader", instance: "reader|new" });
  expect(receipt.reason).toBeUndefined();
});

test("a predecessor-bound note still settles, and the stamp differs from the envelope's binding", () => {
  // Same handle, an earlier instance: the refuse-vs-write policy is unchanged (the note is
  // retired), and the receipt now tells a matching settle from this one by `instance`.
  const receipt = settledReceipt("recipient_instance: reader|old\n");
  expect(receipt).toMatchObject({ by: "reader", instance: "reader|new", reason: "instance_retired" });
});

test("an adopted predecessor keeps its explicit adopted_from beside the successor's instance", () => {
  const receipt = settledReceipt("to_adopted_from: fork\nrecipient_instance: fork|old\n", reg => {
    reg.seats.reader.adopted_handles = ["fork"]; reg.seats.reader.adopted_instances = { fork: "fork|old" };
  });
  expect(receipt).toMatchObject({ by: "reader", adopted_from: "fork", instance: "reader|new" });
});

test("a seat row with no instance stamps the explicit unresolved value", () => {
  expect(settledReceipt("", reg => { delete reg.seats.reader.instance; }).instance).toBe("unresolved");
});
test('read into an already-closed stdout exits quietly and still settles the note (tap-gdvb1)',()=>{
  const f=buildFixture(),id=A; f.payload(id);
  const r=f.runClosedStdout([id]);
  expect(r.err).toBe('');
  expect(r.code).toBe(0);
  expect(JSON.parse(readFileSync(join(f.bus,'receipts',`${id}.done`),'utf8'))).toMatchObject({id,status:'done',by:'reader',via:'read'});
});
// A REAL pipe: process.stdout.write queues and reports EPIPE as a later async event, so a sync loop
// had settled every member before it fired. A stub that throws synchronously cannot see that.
const bigPayload=(f:ReturnType<typeof buildFixture>,id:string)=>
  f.put(`payloads/${id}.md`,`---\nid: ${id}\nfrom: sender\nto: reader\nkind: discuss\npath: ${join(f.bus,'payloads',id+'.md')}\nreply: settle-only\n---\n\n${('y'.repeat(1023)+'\n').repeat(1536)}`);
test('a digest read into an early-closing real pipe settles only the first member and exits quietly (tap-gdvb1)',()=>{
  const f=buildFixture(),ids=[A,B,'sender-20260905T130000Z-cccccccccccc'],d='courier-20260905T130001Z-dddddddddddd';
  for(const id of ids) bigPayload(f,id);
  f.put(`spool/digests/${d}.json`,JSON.stringify({kind:'digest',digest_id:d,to:'reader',to_team:'spec',items:ids.map(id=>({id,path:join(f.bus,'payloads',`${id}.md`),from:'sender',reply:'settle-only'}))}));
  const r=f.runEarlyReader([d,'--all']);
  expect([r.code,r.err]).toEqual([0,'']);
  // The first member settles before its output; the later ones are never reached.
  const done=(id:string)=>existsSync(join(f.bus,'receipts',`${id}.done`));
  expect(ids.map(done)).toEqual([true,false,false]);
  // The direct-note path meets the same failure the same way.
  const g=buildFixture(); bigPayload(g,A);
  expect(g.runEarlyReader([A])).toMatchObject({code:0,err:''});
});
test('a stderr EPIPE on a refusal is still a failure, never the quiet stdout disposition (tap-gdvb1)',()=>{
  const f=buildFixture(),d='courier-20260905T130001Z-dddddddddddd';
  f.put(`spool/digests/${d}.json`,'{ not json');
  // Control: the invalid digest is a refusal with its diagnostic on a readable stderr.
  const seen=f.run('native',[d,'--all']);
  expect(seen.code).not.toBe(0);
  expect(seen.err).toContain('invalid digest');
  const r=f.runFailingStderr([d,'--all']);
  expect(r.code).not.toBe(0);
});

test('read prints nothing about a lower-ranked copy of the same logical id',()=>{
  const f=buildFixture(),id=A; f.payload(id,'expected'); mkdirSync(join(f.bus,'payloads','.quarantine'),{recursive:true}); f.put(`payloads/.quarantine/${id}.md`,'bad'); f.put(`archive/${id}.cancelled.md`,'old');
  const r=f.run('native',[id]); expect(r.code).toBe(0); expect(r.out+r.err).not.toContain('also:');
});

// tap-9uc12: the immutable first forced/retired observation stays the audit
// record while THIS invocation's own authorized read completes queued delivery.
// Appended after every parity fixture so no golden key moves.
test('an authorized successor read completes a queued ask left open by a forced first observation (tap-9uc12)',()=>{
  const f=buildFixture(),id='sender-20260905T130000Z-ffff20260912';f.payload(id,'expected');recordHarnessQueued(f.bus,id);
  const p=join(f.bus,'payloads',`${id}.md`);writeFileSync(p,readFileSync(p,'utf8').replace('to: reader','to: peer'));
  expect(f.run('native',[id,'--force']).code).toBe(0);
  const forcedBytes=readFileSync(join(f.bus,'receipts',`${id}.read`),'utf8');
  expect(JSON.parse(forcedBytes)).toMatchObject({id,by:'reader',forced:'true',to:'peer'});
  expect(existsSync(join(f.bus,'receipts',`${id}.sent`))).toBe(false);
  expect(harnessQueued(f.bus,id)).toBe(true);
  expect(f.run('native',[id,'--by','peer']).code).toBe(0);
  expect(JSON.parse(readFileSync(join(f.bus,'receipts',`${id}.sent`),'utf8'))).toMatchObject({id,status:'sent',delivery:'harness-queue',via:'harness-queue-read',read_by:'peer',turn:'unconfirmed'});
  expect(readFileSync(join(f.bus,'receipts',`${id}.read`),'utf8')).toBe(forcedBytes);
  expect(harnessQueued(f.bus,id)).toBe(false);
});
test('an authorized successor read completes a queued note settled first by a retired instance (tap-9uc12)',()=>{
  const f=buildFixture(),id='sender-20260905T130000Z-ffff20260913';f.payload(id,'settle-only','recipient_instance: reader|old\n');recordHarnessQueued(f.bus,id);
  expect(f.run('native',[id]).code).toBe(0);
  const retiredBytes=readFileSync(join(f.bus,'receipts',`${id}.done`),'utf8');
  expect(JSON.parse(retiredBytes)).toMatchObject({id,by:'reader',reason:'instance_retired',via:'read'});
  expect(existsSync(join(f.bus,'receipts',`${id}.sent`))).toBe(false);
  expect(harnessQueued(f.bus,id)).toBe(true);
  const reg=JSON.parse(readFileSync(f.registry,'utf8'));reg.seats.reader.instance='reader|old';writeFileSync(f.registry,JSON.stringify(reg));
  expect(f.run('native',[id]).code).toBe(0);
  expect(JSON.parse(readFileSync(join(f.bus,'receipts',`${id}.sent`),'utf8'))).toMatchObject({id,status:'sent',delivery:'harness-queue',via:'harness-queue-read',read_by:'reader',turn:'unconfirmed'});
  expect(readFileSync(join(f.bus,'receipts',`${id}.done`),'utf8')).toBe(retiredBytes);
  expect(harnessQueued(f.bus,id)).toBe(false);
});
test('a forced read never completes a queued delivery, before or after another forced read (tap-9uc12 negative)',()=>{
  const f=buildFixture(),id='sender-20260905T130000Z-ffff20260914';f.payload(id,'expected');recordHarnessQueued(f.bus,id);
  expect(f.run('native',[id,'--force']).code).toBe(0);
  expect(existsSync(join(f.bus,'receipts',`${id}.sent`))).toBe(false);
  expect(f.run('native',[id,'--force']).code).toBe(0);
  expect(existsSync(join(f.bus,'receipts',`${id}.sent`))).toBe(false);
  expect(harnessQueued(f.bus,id)).toBe(true);
});
test('a non-addressee forced read and a retire-shaped read each still leave the queue unconfirmed (tap-9uc12 negative)',()=>{
  const f=buildFixture(),id='sender-20260905T130000Z-ffff20260915';f.payload(id,'settle-only','recipient_instance: reader|old\n');recordHarnessQueued(f.bus,id);
  expect(f.run('native',[id,'--force']).code).toBe(0);
  expect(existsSync(join(f.bus,'receipts',`${id}.sent`))).toBe(false);
  expect(f.run('native',[id]).code).toBe(0);
  expect(existsSync(join(f.bus,'receipts',`${id}.sent`))).toBe(false);
  expect(harnessQueued(f.bus,id)).toBe(true);
});
test('an authorized read with an authoritative first receipt needs no durable record: late recording completes from the receipt (tap-9uc12)',()=>{
  const f=buildFixture(),id='sender-20260905T130000Z-ffff20260916';f.payload(id,'expected');
  expect(f.run('native',[id]).code).toBe(0);
  recordHarnessQueued(f.bus,id);
  expect(JSON.parse(readFileSync(join(f.bus,'receipts',`${id}.sent`),'utf8'))).toMatchObject({id,status:'sent',via:'harness-queue-read',read_by:'reader'});
  expect(existsSync(join(f.bus,'receipts',`${id}.authorized-read`))).toBe(false);
});
test('forced first, authorized successor, queue recorded last: the late recorder completes from durable evidence (tap-9uc12)',()=>{
  const f=buildFixture(),id='sender-20260905T130000Z-ffff20260917';f.payload(id,'expected');
  const p=join(f.bus,'payloads',`${id}.md`);writeFileSync(p,readFileSync(p,'utf8').replace('to: reader','to: peer'));
  expect(f.run('native',[id,'--force']).code).toBe(0);
  const forcedBytes=readFileSync(join(f.bus,'receipts',`${id}.read`),'utf8');
  expect(f.run('native',[id,'--by','peer']).code).toBe(0);
  const record=JSON.parse(readFileSync(join(f.bus,'receipts',`${id}.authorized-read`),'utf8'));
  expect(record).toMatchObject({id,by:'peer',via:'read',turn:'unconfirmed'});
  expect(readFileSync(join(f.bus,'receipts',`${id}.read`),'utf8')).toBe(forcedBytes);
  recordHarnessQueued(f.bus,id);
  expect(JSON.parse(readFileSync(join(f.bus,'receipts',`${id}.sent`),'utf8'))).toMatchObject({id,status:'sent',delivery:'harness-queue',via:'harness-queue-read',read_by:'peer',turn:'unconfirmed'});
  expect(readFileSync(join(f.bus,'receipts',`${id}.read`),'utf8')).toBe(forcedBytes);
  expect(harnessQueued(f.bus,id)).toBe(false);
});
test('a forced read alone still never completes a queue recorded after it (tap-9uc12 negative)',()=>{
  const f=buildFixture(),id='sender-20260905T130000Z-ffff20260918';f.payload(id,'expected');
  expect(f.run('native',[id,'--force']).code).toBe(0);
  recordHarnessQueued(f.bus,id);
  expect(existsSync(join(f.bus,'receipts',`${id}.sent`))).toBe(false);
  expect(existsSync(join(f.bus,'receipts',`${id}.authorized-read`))).toBe(false);
  expect(harnessQueued(f.bus,id)).toBe(true);
});
test('a queue recorded between the read check and its evidence publication still completes after the read reconciles (tap-9uc12)',()=>{
  const f=buildFixture(),id='sender-20260905T130000Z-ffff20260919';f.payload(id,'expected');
  const p=join(f.bus,'payloads',`${id}.md`);writeFileSync(p,readFileSync(p,'utf8').replace('to: reader','to: peer'));
  expect(f.run('native',[id,'--force']).code).toBe(0);
  const forcedBytes=readFileSync(join(f.bus,'receipts',`${id}.read`),'utf8');
  const evidence={by:'peer',at:'2026-10-02T05:00:00Z'};
  expect(completeHarnessQueued(f.bus,id,evidence)).toBe(false);
  recordHarnessQueued(f.bus,id);
  recordAuthorizedRead(f.bus,id,evidence);
  completeHarnessQueued(f.bus,id);
  expect(JSON.parse(readFileSync(join(f.bus,'receipts',`${id}.sent`),'utf8'))).toMatchObject({id,status:'sent',delivery:'harness-queue',via:'harness-queue-read',read_by:'peer',turn:'unconfirmed'});
  expect(readFileSync(join(f.bus,'receipts',`${id}.read`),'utf8')).toBe(forcedBytes);
  expect(harnessQueued(f.bus,id)).toBe(false);
});
test('the read path itself reconciles a queue recorded after its completion check (tap-9uc12)',async()=>{
  const f=buildFixture(),id='sender-20260905T130000Z-ffff20260920';f.payload(id,'expected');
  const p=join(f.bus,'payloads',`${id}.md`);writeFileSync(p,readFileSync(p,'utf8').replace('to: reader','to: peer'));
  expect(f.run('native',[id,'--force']).code).toBe(0);
  const forcedBytes=readFileSync(join(f.bus,'receipts',`${id}.read`),'utf8');
  const barrier=join(f.root,'evidence-barrier');
  const env={...process.env,TAP_HOME:f.bus,TAP_INDEX_HOME:join(f.root,'index'),TAP_SELF:'reader',
    TAP_READ_TEST_BARRIER:barrier,TAP_READ_TEST_ID:id,TAP_SCRATCH_ONLY:'1'};
  const reader=Bun.spawn([process.execPath,join(import.meta.dir,'support','native-read-entry.ts'),id,'--by','peer'],
    {cwd:f.root,env,stdout:'pipe',stderr:'pipe',timeout:15000});
  try {
    const waitFor=(stage:string):Promise<boolean>=>
      (async()=>{const marker=`${barrier}.${stage}.${reader.pid}.reached`;const deadline=Date.now()+5000;
        while(!existsSync(marker)&&reader.exitCode===null&&Date.now()<deadline) await Bun.sleep(10);
        return existsSync(marker);})();
    expect(await waitFor('gates')).toBe(true);
    writeFileSync(`${barrier}.gates.release`,'1');
    expect(await waitFor('evidence')).toBe(true);
    expect(existsSync(join(f.bus,'receipts',`${id}.sent`))).toBe(false);
    recordHarnessQueued(f.bus,id);
    writeFileSync(`${barrier}.evidence.release`,'1');
    expect(await reader.exited).toBe(0);
    expect(JSON.parse(readFileSync(join(f.bus,'receipts',`${id}.sent`),'utf8'))).toMatchObject({id,status:'sent',delivery:'harness-queue',via:'harness-queue-read',read_by:'peer',turn:'unconfirmed'});
    expect(readFileSync(join(f.bus,'receipts',`${id}.read`),'utf8')).toBe(forcedBytes);
    expect(harnessQueued(f.bus,id)).toBe(false);
  } finally {
    writeFileSync(`${barrier}.gates.release`,'1');
    writeFileSync(`${barrier}.evidence.release`,'1');
    reader.kill();
    await reader.exited;
  }
});
test('an authorized read of a cancelled queued payload never mints .sent or authorized-read carry (tap-9uc12 negative)',()=>{
  const f=buildFixture(),id='sender-20260905T130000Z-ffff20260921';f.payload(id,'expected');recordHarnessQueued(f.bus,id);
  writeFileSync(join(f.bus,'receipts',`${id}.cancelled`),JSON.stringify({id,via:'cancelled',at:'2026-10-02T05:00:00Z'})+"\n");
  expect(f.run('native',[id]).code).toBe(0);
  expect(existsSync(join(f.bus,'receipts',`${id}.sent`))).toBe(false);
  expect(existsSync(join(f.bus,'receipts',`${id}.authorized-read`))).toBe(false);
  expect(existsSync(join(f.bus,'receipts',`${id}.done`))).toBe(false);
  expect(existsSync(join(f.bus,'receipts',`${id}.cancelled`))).toBe(true);
});
test('a withdrawn queued payload read as withdrawn never gains .sent (tap-9uc12 negative)',()=>{
  const f=buildFixture(),id='sender-20260905T130000Z-ffff20260922';f.payload(id,'expected');recordHarnessQueued(f.bus,id);
  writeFileSync(join(f.bus,'receipts',`${id}.cancelled`),JSON.stringify({id,via:'withdrawn',at:'2026-10-02T05:00:00Z'})+"\n");
  expect(f.run('native',[id]).code).toBe(0);
  expect(existsSync(join(f.bus,'receipts',`${id}.sent`))).toBe(false);
  expect(existsSync(join(f.bus,'receipts',`${id}.authorized-read`))).toBe(false);
  expect(existsSync(join(f.bus,'receipts',`${id}.done`))).toBe(false);
});
test('an authorized read of an archive tombstone without a receipt never mints .sent (tap-9uc12 negative)',()=>{
  const f=buildFixture(),id='sender-20260905T130000Z-ffff20260923';f.payload(id,'settle-only');
  renameSync(join(f.bus,'payloads',`${id}.md`),join(f.bus,'archive',`${id}.cancelled.md`));
  recordHarnessQueued(f.bus,id,{from:'sender',to:'reader',kind:'discuss'});
  expect(f.run('native',[id]).code).toBe(0);
  expect(existsSync(join(f.bus,'receipts',`${id}.sent`))).toBe(false);
  expect(existsSync(join(f.bus,'receipts',`${id}.authorized-read`))).toBe(false);
  expect(existsSync(join(f.bus,'receipts',`${id}.done`))).toBe(false);
});
test('an archive tombstone over a forced-first queued payload mints no durable carry even before the queue receipt (tap-9uc12 negative)',()=>{
  const f=buildFixture(),id='sender-20260905T130000Z-ffff20260924';f.payload(id,'expected');
  const p=join(f.bus,'payloads',`${id}.md`);writeFileSync(p,readFileSync(p,'utf8').replace('to: reader','to: peer'));
  expect(f.run('native',[id,'--force']).code).toBe(0);
  copyFileSync(join(f.bus,'payloads',`${id}.md`),join(f.bus,'archive',`${id}.cancelled.md`));
  expect(f.run('native',[id,'--by','peer']).code).toBe(0);
  expect(existsSync(join(f.bus,'receipts',`${id}.sent`))).toBe(false);
  expect(existsSync(join(f.bus,'receipts',`${id}.authorized-read`))).toBe(false);
  recordHarnessQueued(f.bus,id);
  expect(existsSync(join(f.bus,'receipts',`${id}.sent`))).toBe(false);
  expect(existsSync(join(f.bus,'receipts',`${id}.authorized-read`))).toBe(false);
});
test('a malformed or wrong-id cancellation receipt still fails closed after a forced-first observation (tap-9uc12 negative)',()=>{
  const f=buildFixture(),id='sender-20260905T130000Z-ffff20260925';f.payload(id,'expected');
  const p=join(f.bus,'payloads',`${id}.md`);writeFileSync(p,readFileSync(p,'utf8').replace('to: reader','to: peer'));
  expect(f.run('native',[id,'--force']).code).toBe(0);
  const forcedBytes=readFileSync(join(f.bus,'receipts',`${id}.read`),'utf8');
  writeFileSync(join(f.bus,'receipts',`${id}.cancelled`),'{"id":"other"}\n');
  expect(f.run('native',[id,'--by','peer']).code).toBe(0);
  expect(existsSync(join(f.bus,'receipts',`${id}.sent`))).toBe(false);
  expect(existsSync(join(f.bus,'receipts',`${id}.authorized-read`))).toBe(false);
  expect(readFileSync(join(f.bus,'receipts',`${id}.read`),'utf8')).toBe(forcedBytes);
  recordHarnessQueued(f.bus,id);
  expect(existsSync(join(f.bus,'receipts',`${id}.sent`))).toBe(false);
  expect(existsSync(join(f.bus,'receipts',`${id}.authorized-read`))).toBe(false);
  expect(readFileSync(join(f.bus,'receipts',`${id}.read`),'utf8')).toBe(forcedBytes);
});
