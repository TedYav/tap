import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { route } from "../main";
import { removeScratchTree } from "./support/scratch";
const tree=realpathSync(join(import.meta.dir,"../../.."));
const scratch=realpathSync(mkdtempSync(join(tmpdir(),"tap-readers-router.")));
afterAll(()=>removeScratchTree(scratch));

test('reader router admits native forms and keeps every declared Bash boundary',()=>{
  const called:string[]=[];
  const handlers=Object.fromEntries(['read','show','outstanding'].map(verb=>[verb,(args:string[])=>{called.push(`native ${verb}`);return 11;}]));
  const fallback=(args:string[])=>{called.push(`bash ${args[0]}`);return 22;};
  const native=[['read','id'],['read','id','--force'],['read','digest','--item','id'],['read','id','--epoch','17'],['read','id','--by','reader'],['read','id','--team','spec'],['read','spec/id'],['read','path=/tmp/message.md'],['read','digest','--item','x'],['show','id'],['show','digest','--all'],['show','id','--team','spec'],['show','path=/tmp/message.md'],['show','spec/id'],['outstanding','reader','--json'],['outstanding','--stale','50'],['outstanding','reader','--team','spec'],['outstanding','--stale']];
  const bash: string[][]=[];
  for(const args of native) {expect(route(args,handlers,fallback)).toBe(11);expect(called.pop()).toBe(`native ${args[0]}`);}
  for(const args of bash) {expect(route(args,handlers,fallback)).toBe(22);expect(called.pop()).toBe(`bash ${args[0]}`);}
});

test('shipped reader doors prove native routing, byte parity and receipt effect',()=>{
  const root=join(scratch,'public'),bus=join(root,'.tap/bus'),index=join(root,'index'),home=join(root,'home'),trace=join(root,'trace');
  for(const path of [join(bus,'payloads'),join(bus,'receipts'),index,home])mkdirSync(path,{recursive:true});
  const registry=join(root,'.tap/team-registry.json');
  writeFileSync(registry,JSON.stringify({schema:'0.20',team:{name:'spec'},seats:{reader:{status:'active',instance:'reader|one'},sender:{status:'active',instance:'sender|one'}}}));
  writeFileSync(join(index,'global-registry.json'),JSON.stringify({schema:'0.20',teams:{spec:{root,registry_location:registry,state:'registered'}}}));
  const env:NodeJS.ProcessEnv={...process.env,HOME:home,PWD:root,TAP_HOME:bus,TAP_INDEX_HOME:index,TAP_SELF:'reader',TAP_SPOOL_NOW:'1788615000',BUN_RUNTIME_TRANSPILER_CACHE_PATH:'0',TAP_BUN_ROUTE_TRACE:trace,TAP_VERSION_SEEN_PATH:join(root,'seen'),TAP_SESSION_MANIFEST:join(root,'sessions'),OPENCODE_DB_PATH:join(root,'opencode')};
  delete env.TMUX;delete env.TMUX_PANE;delete env.TAP_VERBOSE;
  const id='sender-20260905T130000Z-aaaaaaaaaaaa',path=join(bus,'payloads',`${id}.md`),done=join(bus,'receipts',`${id}.done`);
  writeFileSync(path,`---\nid: ${id}\nfrom: sender\nto: reader\nkind: discuss\npath: ${path}\nreply: settle-only\n---\npublic body\n`);
  const run=(args:string[],verbose=false)=>{
    rmSync(trace,{force:true});
    const r=spawnSync('bash',[join(tree,'bin/tap'),...args],{cwd:root,encoding:'utf8',env:{...env,TAP_VERBOSE:verbose?'1':'0'}});
    return {code:r.status,out:r.stdout,err:r.stderr,route:existsSync(trace)?readFileSync(trace,'utf8'):''};
  };
  const stamp=(s:string)=>s.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/,'TIMESTAMP');
  const n=run(['read',id]);expect(n.route).toBe('native read\n');
  expect({code:n.code,out:n.out,err:n.err}).toEqual({code:0,out:`tap read: note ${id} from=sender settled\npublic body\n`,err:''});
  expect(JSON.parse(readFileSync(done,'utf8')).via).toBe('read');
  const showOut=`path: ${path}\n\nid: ${id}\nfrom: sender\nto: reader\nkind: discuss\npath: ${path}\nreply: settle-only\n\nreceipts:\n  done      TIMESTAMP  by=reader via=read identity=declared\n\nbody:\npublic body\n`;
  const c1=run(['show',id]);expect(c1.route).toBe('native show\n');expect({code:c1.code,out:stamp(c1.out),err:c1.err}).toEqual({code:0,out:showOut,err:''});
  const c2=run(['outstanding','sender']);expect(c2.route).toBe('native outstanding\n');
  expect({code:c2.code,out:c2.out,err:c2.err}).toEqual({code:0,out:'tap outstanding: no outstanding sends for sender\n',err:''});
  const verbose=run(['show',id],true);expect(verbose.route).toBe('native show\n');expect(verbose.err).toContain('"registry":');
  expect(run(['read',id,'--by','reader']).route).toBe('native read\n');
  expect(run(['read',id,'--team','spec']).route).toBe('native read\n');
  expect(run(['show',id,'--team','spec']).route).toBe('native show\n');
  expect(run(['outstanding','sender','--team','spec']).route).toBe('native outstanding\n');
}, 30_000);
