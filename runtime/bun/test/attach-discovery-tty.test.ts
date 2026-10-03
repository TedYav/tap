import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixtureFzf } from "./support/fzf-fixture";

const root = realpathSync(mkdtempSync(join(tmpdir(), "attach-discovery-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const alpha = join(root, "alpha"), beta = join(root, "beta"), index = join(root, "index");
for (const dir of [alpha, beta, index, join(alpha, ".tap/bus"), join(beta, ".tap")]) mkdirSync(dir, { recursive: true });
const alphaRegistry = join(alpha, ".tap/team-registry.json"), betaRegistry = join(beta, ".tap/team-registry.json");
writeFileSync(join(alpha, ".tap/bus/registry.json"), JSON.stringify({ team: { name: "alpha" } }));
writeFileSync(alphaRegistry, JSON.stringify({ schema: "0.20", team: { name: "alpha" }, seats: { alice: { delivery: "poll", status: "active" } } }));
writeFileSync(betaRegistry, JSON.stringify({ schema: "0.20", team: { name: "beta" }, seats: {} }));
writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
  alpha: { root: alpha, registry_location: alphaRegistry, state: "registered" },
  beta: { root: beta, registry_location: betaRegistry, state: "registered" },
} }));
const env = { ...process.env, HOME: root, TAP_HOME: join(alpha, ".tap/bus"), TAP_INDEX_HOME: index,
  TERM: "xterm-256color", NO_COLOR: "", TAP_ONBOARDING_CHECKED: "1" };
beforeAll(async () => { await fixtureFzf(env); }, 45_000);
const entry = join(root, "entry.ts");
writeFileSync(entry, `import {cmdAttach} from ${JSON.stringify(join(import.meta.dir, "../src/verbs/attach.ts"))};
import {pick} from ${JSON.stringify(join(import.meta.dir, "../src/fzf.ts"))};
const teams=['alpha','beta'].map(name=>({name,state:'ok',detail:'',root:process.env.TEST_ROOT+'/'+name,
 registry:process.env.TEST_ROOT+'/'+name+'/.tap/team-registry.json',seats:[
  {handle:'sol',harness:'codex',session:name+'/sol',crew:false,identity:{instance:'sol|original',pane:name+'/sol:0.0',
   paneId:'%1',session:name+'/sol',serverEpoch:'',serverSocket:'',bootId:'',registeredAt:'2026-09-25T00:00:00Z',
   observedPane:name+'/sol:0.0',observedPaneId:'%1'}},
  {handle:'archer',harness:'claude',session:name+'/archer',crew:false}]}));
try {process.exitCode=await cmdAttach(process.argv.slice(2),${JSON.stringify(join(import.meta.dir, "../../../skills/tap/scripts"))},
 {model:()=>({teams,observable:true}),choose:pick,...(process.env.TEST_STALE==='1'?{}:{attach:target=>{console.log('HOP:'+target);return 0;}})});}
catch(e){console.error('ERR:'+e.errorClass+':'+e.detail);process.exitCode=e.code||1;}
`);
const driver = String.raw`
import os,pty,subprocess,sys,select,time,termios,json,fcntl,struct
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,100,0,0))
def ctty(): os.setsid(); fcntl.ioctl(0,termios.TIOCSCTTY,0)
mode=sys.argv[3]
args=[] if mode in ('missing','stale') else ['so' if mode in ('bare','unanchored') else 'alpha/so' if mode=='scoped' else 'be/so']
env=os.environ.copy()
if mode=='unanchored': env.pop('TAP_HOME',None)
p=subprocess.Popen([sys.argv[1],sys.argv[2],*args],
 cwd=os.environ['TEST_ROOT'] if mode=='unanchored' else os.environ['TEST_ROOT']+'/alpha',
 stdin=slave,stdout=slave,stderr=slave,env=env,preexec_fn=ctty)
data=b''
def pump():
 global data
 if select.select([master],[],[],.03)[0]:
  try: data+=os.read(master,65536)
  except OSError: pass
def until(needle):
 deadline=time.monotonic()+10
 while needle not in data:
  if time.monotonic()>deadline or p.poll() is not None: raise AssertionError('timeout '+repr(needle)+' '+repr(data[-2000:]))
  pump()
try:
 if mode not in ('scoped','bare'):
  until(b'Pick a team'); time.sleep(.15)
  if mode in ('missing','unanchored','stale'): os.write(master,b'beta'); until(b'1/2'); os.write(master,b'\r')
  else: os.write(master,b'\r')
 until(b'Pick a seat'); time.sleep(.15)
 if mode in ('scoped','bare'): until(b'1/2')
 os.write(master,b'\r')
 until(b'ERR:selection_changed' if mode=='stale' else b'HOP:')
 deadline=time.monotonic()+5
 while p.poll() is None and time.monotonic()<deadline: pump()
 assert p.poll() is not None,'child did not exit'
 print(json.dumps({'code':p.wait(),'output':data.decode(errors='replace')}))
finally:
 if p.poll() is None: p.kill();p.wait()
 os.close(master);os.close(slave)
`;
for (const mode of ["missing", "scoped", "bare", "unknown-team", "unanchored", "stale"]) test(`human attach discovery ${mode} uses the intended picker stage`, () => {
  const result = Bun.spawnSync(["python3", "-c", driver, process.execPath, entry, mode],
    { env: { ...env, TEST_ROOT: root, TEST_STALE: mode === "stale" ? "1" : "" }, timeout: 45_000 });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const record = JSON.parse(result.stdout.toString()) as { code: number; output: string };
  expect(record.code, record.output.slice(-1000)).toBe(mode === "stale" ? 1 : 0);
  if (mode === "stale") {
    expect(record.output).toContain("ERR:selection_changed");
    expect(record.output).not.toContain("HOP:");
    return;
  }
  expect(record.output).toContain(["scoped", "bare"].includes(mode) ? "HOP:alpha/sol" : "HOP:beta/sol");
  if (["scoped", "bare"].includes(mode)) expect(record.output).not.toContain("Pick a team");
  else expect(record.output).toContain("Pick a team");
}, 50_000);
