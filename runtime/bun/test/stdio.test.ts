import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { encodeCourierIntent } from "../src/courier-contract";

const root = resolve(import.meta.dir, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "tap-stdio-"));
const bus = join(scratch, "bus"), bin = join(scratch, "bin");
for (const dir of [bin, bus, join(bus,"payloads"), join(bus,"receipts"), join(bus,"spool")]) mkdirSync(dir);
writeFileSync(join(bin,"tmux"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
const agents = Object.fromEntries(Array.from({length: 2000}, (_, i) => [`seat${i}`, {status:"active", delivery:"poll", harness:"daemon"}]));
writeFileSync(join(bus,"registry.json"), JSON.stringify({schema:"0.20",team:{name:"fixture"}, seats:agents}));
const env: NodeJS.ProcessEnv = {...process.env, TAP_HOME:bus, TAP_SPOOL_NOW:"1790000000", PATH:`${bin}:${process.env.PATH}`};
afterAll(() => rmSync(scratch, { recursive:true, force:true }));

// A delayed consumer forces a real pipe backlog. Parent output is a small
// receipt, never the large document whose completeness is under test.
const reader = String.raw`
import hashlib,json,subprocess,sys,time
mode,entry,*args=sys.argv[1:]
if mode == 'file':
    with open('output.json','wb') as out:
        p=subprocess.run([entry,*args],stdout=out,stderr=subprocess.PIPE,timeout=15)
    data=open('output.json','rb').read()
    rc=p.returncode
else:
    p=subprocess.Popen([entry,*args],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if mode == 'closed':
        p.stdout.close()
        p.stdout=None
        try:
            _,error=p.communicate(timeout=15)
        except subprocess.TimeoutExpired:
            p.kill(); p.communicate(); raise
        rc=p.returncode
        print(json.dumps(dict(rc=rc,error=error.decode(errors='replace'))))
        raise SystemExit
    time.sleep(.1)
    try:
        data,error=p.communicate(timeout=15)
    except subprocess.TimeoutExpired:
        p.kill(); p.communicate(); raise
    rc=p.returncode
result=dict(rc=rc,bytes=len(data),sha=hashlib.sha256(data).hexdigest())
try:
    if args[:2] == ['spool','list']:
        result['count']=len([json.loads(row) for row in data.splitlines()])
    else:
        doc=json.loads(data)
        result['count']=len(doc['agents'] if args[0]=='team' else doc['outstanding'])
except Exception as e:
    result['parseError']=str(e)
print(json.dumps(result))
`;
function observe(mode: string, args: string[]) {
  const r=spawnSync("python3", ["-B","-c",reader,mode,join(root,"bin/tap"),...args], {cwd:scratch, env, encoding:"utf8",timeout:25000});
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout);
}

test("large native team JSON survives pipe backpressure byte-for-byte", () => {
  const file=observe("file",["team","--json"]), pipe=observe("pipe",["team","--json"]);
  expect(file).toMatchObject({rc:0,count:2000});
  expect(file.bytes).toBeGreaterThan(262144);
  expect(pipe).toEqual(file);
}, 20000);

test("a broken stdout pipe cannot report success", () => {
  const result=observe("closed",["team","--json"]);
  expect(result.rc).not.toBe(0);
}, 20000);

for(let i=0;i<1000;i++) {
    const id=`sender-20260906T000000Z-${String(i).padStart(12,"0")}`;
    writeFileSync(join(bus,"spool",`${id}.json`),encodeCourierIntent({v:1,id,from:"sender",to:"seat0",to_team:"fixture",target_registry:join(bus,"registry.json"),pane:"%1",pane_id:"%1",server_epoch:"srv:1:1",harness:"codex",policy:"standard",reason:"busy",first_parked_epoch:1000+i,deadline_epoch:null,hold_until_epoch:null,disposition_at_deadline:"notify-and-cancel",busy_pending_probes:0,escalated_at:null,excluded:false}));
    writeFileSync(join(bus,"payloads",`${id}.md`),`---\nid: ${id}\nfrom: sender\nto: seat0\nkind: discuss\npath: ${join(bus,"payloads",`${id}.md`)}\nreply: expected\n---\nbody\n`);
  }
for(const [args,code] of [[["spool","list","--json"],0],[["outstanding","sender","--json"],2]] as const) {
  test(`${args[0]} shares complete output and preserves exit ${code}`, () => {
    const file=observe("file",[...args]), pipe=observe("pipe",[...args]);
    expect(file).toMatchObject({rc:code,count:1000});
    expect(file.bytes).toBeGreaterThan(131072);
    expect(pipe).toEqual(file);
  }, 20000);
}


test("native read releases its lock and exits after recording an expected ask", () => {
  const id="lifetime-20260906T000000Z-abcdef123456", path=join(bus,"payloads",`${id}.md`);
  const trace=join(scratch,"read.trace");
  writeFileSync(path, `---\nid: ${id}\nfrom: lifetime\nto: seat1\nkind: discuss\npath: ${path}\nreply: expected\n---\nowned read lifetime control\n`);
  const result=spawnSync(join(root,"bin/tap"),["read",id],{cwd:scratch,env:{...env,TAP_SELF:"seat1",TAP_BUN_ROUTE_TRACE:trace},encoding:"utf8",timeout:8000});
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("owned read lifetime control");
  expect(readFileSync(trace,"utf8")).toContain("native read");
  expect(JSON.parse(readFileSync(join(bus,"receipts",`${id}.read`),"utf8"))).toMatchObject({id,by:"seat1"});
  expect(existsSync(join(bus,"receipts",`${id}.done`))).toBe(false);
}, 10000);
