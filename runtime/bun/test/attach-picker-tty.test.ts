import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixtureFzf } from "./support/fzf-fixture";
const root = realpathSync(mkdtempSync(join(tmpdir(), "picker-tty-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const env = { ...process.env, TAP_INDEX_HOME: join(root, "index"), TERM: "xterm-256color", NO_COLOR: "", FZF_DEFAULT_OPTS: "--filter=bad --select-1", FZF_DEFAULT_OPTS_FILE: "/missing" };
beforeAll(async () => { await fixtureFzf(env); }, 45000);
const entry = join(root, "entry.ts");
writeFileSync(entry, `import {runPicker} from ${JSON.stringify(join(import.meta.dir, "../src/attach-picker.ts"))};
import {pick} from ${JSON.stringify(join(import.meta.dir, "../src/fzf.ts"))};
try {
  if (process.env.PICKER_MULTI === '1') {
    const r=await pick([{id:'a',label:'alpha',value:'a'},{id:'b',label:'beta',value:'b'}],{verb:'attach',multi:true,query:process.env.PICKER_QUERY,header:'Pick many'});
    console.log('RESULT:'+JSON.stringify(r)); process.exitCode=r.kind==='interrupted'?130:0;
  } else process.exitCode=await runPicker([], undefined, {model:()=>({observable:true,teams:[
    {name:'alpha',state:'ok',detail:'',seats:[{handle:'fable',harness:'claude',session:'alpha/fable',crew:false}]},
    {name:'beta',state:'ok',detail:'',seats:[{handle:'sol',harness:'codex',session:'beta/sol',crew:false}]}]}),choose:pick,attach:target=>{console.log('HOP:attach:--no-resume:'+target);return 0;}});
} catch(e) { console.error(e.message); process.exitCode=e.code||1; }
if(process.env.PICKER_MODE!=='hangup') {
  console.log('PICKER_DONE');
  const {existsSync}=await import('node:fs'); const deadline=Date.now()+5000;
  while(!existsSync(process.env.PICKER_RELEASE!)&&Date.now()<deadline) await Bun.sleep(10);
}`);
const driver = String.raw`
import os,pty,subprocess,sys,select,time,termios,json,fcntl,struct
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack("HHHH",24,100,0,0))
def terminal_settings(fd):
    settings=termios.tcgetattr(fd)
    # Darwin sets PENDIN when tcsetattr restores canonical input. This is
    # kernel pending-input state, not a terminal configuration option.
    settings[3] &= ~getattr(termios,'PENDIN',0)
    return settings
before=terminal_settings(slave)
mode=sys.argv[3]
def ctty():
    os.setsid(); fcntl.ioctl(0, termios.TIOCSCTTY, 0)
p=subprocess.Popen([sys.argv[1],sys.argv[2]],stdin=slave,stdout=slave,stderr=slave,env=os.environ.copy(),preexec_fn=None if mode=='noctty' else ctty)
data=b''
def pump():
    global data
    if select.select([master],[],[],.03)[0]:
        try: data+=os.read(master,65536)
        except OSError: pass
def until(needle):
    deadline=time.monotonic()+10
    while needle not in data:
        if time.monotonic()>deadline or p.poll() is not None: raise AssertionError('picker output timeout: '+repr(data[-2000:]))
        pump()
try:
    if mode!='noctty':
        until(b'Pick many' if os.environ.get('PICKER_MULTI')=='1' else b'Pick a team')
        time.sleep(.15)
        if mode=='hangup':
            os.close(slave); os.close(master); slave=master=None
            code=p.wait(timeout=5)
            print(json.dumps({'code':code,'output':''})); sys.exit(0)
        elif mode=='sigterm': p.terminate()
        elif mode=='interrupt': os.write(master,b'\x03')
        elif mode=='escape': os.write(master,b'\x1b')
        elif mode=='escape-selected': os.write(master,b' \x1b')
        elif mode=='unmatched-escape':
            os.write(master,b'zzzzzz'); until(b'0/2'); os.write(master,b'\x1b')
        elif mode=='edit-query':
            os.write(master,b'\x15bet'); until(b'1/2'); os.write(master,b'\r')
        elif mode=='multi': os.write(master,b' \r')
        else:
            os.write(master,b'bt'); until(b'1/2'); os.write(master,b'\r')
            until(b'Pick a seat')
            time.sleep(.15); os.write(master,b'sl\r')
    until(b'PICKER_DONE')
    assert before==terminal_settings(slave), 'terminal settings not restored: '+repr(before)+' -> '+repr(termios.tcgetattr(slave))+' output='+repr(data[-1000:])
    open(os.environ['PICKER_RELEASE'],'w').close()
    deadline=time.monotonic()+10
    while p.poll() is None:
        if time.monotonic()>deadline: raise AssertionError('picker exit timeout: '+repr(data[-2000:]))
        pump()
    for _ in range(3): pump()
    print(json.dumps({'code':p.wait(),'output':data.decode(errors='replace')}))
finally:
    if p.poll() is None: p.kill(); p.wait()
    if master is not None: os.close(master); os.close(slave)
`;
for (const mode of ["select", "escape", "interrupt", "sigterm", "hangup", "noctty", "escape-selected", "unmatched-escape", "edit-query", "multi"]) test(`real pinned fzf PTY ${mode}`, () => {
  const multi = ["escape-selected", "unmatched-escape", "edit-query", "multi"].includes(mode);
  const r = Bun.spawnSync(["python3", "-c", driver, process.execPath, entry, mode], { env: { ...env, PICKER_MODE: mode, PICKER_RELEASE: join(root, `release-${mode}`), PICKER_MULTI: multi ? "1" : "", PICKER_QUERY: mode === "edit-query" ? "unmatched-initial-query" : "" } });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  const record = JSON.parse(r.stdout.toString()) as { code: number; output: string };
  expect(record.code, record.output.slice(-2000)).toBe(mode === "interrupt" ? 130 : mode === "sigterm" ? 143 : mode === "hangup" ? 129 : mode === "noctty" ? 1 : 0);
  if (mode === "select") expect(record.output.slice(-2000)).toContain("HOP:attach:--no-resume:beta/sol");
  else expect(record.output).not.toContain("HOP:");
  if (mode === "edit-query") expect(record.output).toContain('"values":["b"]');
  if (mode === "multi") expect(record.output).toContain('"values":["a"]');
  if (mode === "escape-selected" || mode === "unmatched-escape") expect(record.output).toContain('"kind":"cancelled"');
}, 25000);
