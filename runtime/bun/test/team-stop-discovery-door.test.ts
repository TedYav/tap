import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { bootId } from "../src/tmux";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function fixture(crew: boolean, shellParent = false) {
  const scratch = process.env.TMUX_TMPDIR;
  if (!scratch) throw new Error("isolated runner must supply TMUX_TMPDIR");
  const root = realpathSync(mkdtempSync(join(scratch, "stop-door-"))); roots.push(root);
  const tmuxDir = join(root, "tmux"), socket = join(tmuxDir, `tmux-${process.getuid?.() ?? 0}`, "default");
  const teamRoot = join(root, "demo"), index = join(root, "index");
  const bin = join(root, "bin"), bus = join(teamRoot, ".tap/bus"), registry = join(teamRoot, ".tap/team-registry.json");
  for (const dir of [bin, bus, index, join(bus, "payloads"), join(bus, "receipts"), join(tmuxDir, `tmux-${process.getuid?.() ?? 0}`)])
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  symlinkSync("/bin/sleep", join(bin, "codex"));
  expect(spawnSync("git", ["init", "-q", teamRoot]).status).toBe(0);
  const tmux = (...args: string[]) => spawnSync("tmux", ["-S", socket, ...args],
    { encoding: "utf8", timeout: 8000, env: { ...process.env, TMUX_TMPDIR: tmuxDir } });
  const read = (...args: string[]) => {
    const result = tmux(...args);
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  expect(tmux("new-session", "-d", "-s", "demo/parent", "-n", "parent", shellParent ? "/bin/bash -i" : `${bin}/codex 600`).status).toBe(0);
  const parentPane = read("display-message", "-p", "-t", "demo/parent:0.0", "#{pane_id}");
  let childPane = "";
  if (crew) {
    expect(tmux("new-window", "-d", "-t", "demo/parent", "-n", "child", "sleep 600").status).toBe(0);
    childPane = read("display-message", "-p", "-t", "demo/parent:1.0", "#{pane_id}");
  }
  expect(tmux("new-session", "-d", "-s", "demo/other", "-n", "other", `${bin}/codex 600`).status).toBe(0);
  const otherPane = read("display-message", "-p", "-t", "demo/other:0.0", "#{pane_id}");
  const epoch = `srv:${read("display-message", "-p", "#{pid}:#{start_time}")}`;
  const common = { delivery: "pane", status: "active", harness: "codex", server_epoch: epoch,
    server_socket: socket, boot_id: bootId(), registered_at: "2026-09-25T00:00:00Z" };
  const seats = {
    parent: { ...common, instance: "parent-one", session: "demo/parent", pane: "demo/parent:0.0", pane_id: parentPane },
    ...(crew ? { child: { ...common, instance: "child-one", session: "demo/parent", pane: "demo/parent:1.0", pane_id: childPane, crew: true } } : {}),
    other: { ...common, instance: "other-one", session: "demo/other", pane: "demo/other:0.0", pane_id: otherPane },
  };
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "demo", worktree_root: teamRoot }, seats }));
  writeFileSync(join(bus, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "demo", worktree_root: teamRoot }, seats }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    demo: { root: teamRoot, registry_location: registry, state: "registered" },
  } }));
  const env: NodeJS.ProcessEnv = { ...process.env, TAP_INDEX_HOME: index, TAP_TMUX_SOCKET_PATH: socket, TMUX_TMPDIR: tmuxDir,
    TAP_ONBOARDING_CHECKED: "1", NO_COLOR: "1", TERM: "xterm-256color", HOME: root };
  for (const key of ["TMUX", "TMUX_PANE", "TAP_HOME", "TAP_TEAM_SELECT", "TAP_REGISTRY", "TAP_JSON"]) delete env[key];
  const rows = () => (JSON.parse(readFileSync(registry, "utf8")) as { seats: Record<string, { status?: string }> }).seats;
  const close = () => { tmux("kill-server"); };
  return { root, socket, teamRoot, index, registry, env, tmux, rows, close };
}

const entry = `import {runTeamStopDoor} from ${JSON.stringify(join(import.meta.dir, "../src/verbs/team.ts"))};
import {reconcileCrewLifetime} from ${JSON.stringify(join(import.meta.dir, "../src/crew-lifetime.ts"))};
import {resolveContext} from ${JSON.stringify(join(import.meta.dir, "../src/context.ts"))};
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const select=process.env.TEST_SELECT;
const picker=async (choices,options)=>{
  if(process.env.TEST_PICKER_CANCEL==='1') return {kind:'cancelled'};
  const values=choices.filter(choice=>choice.value?.handle===select || choice.value?.team===process.env.TEST_TEAM).map(choice=>choice.value);
  console.log('PICK:'+options.verb+':'+values.map(value=>value.handle??value.team).join(','));
  return {kind:'selected',values};
};
const consent=async()=>{
 console.log('CONSENT');
 if(process.env.TEST_LATE==='replace'){
  const path=process.env.TEST_REGISTRY,doc=JSON.parse(readFileSync(path,'utf8'));
  doc.seats.child.instance='child-replacement';
  writeFileSync(path,JSON.stringify(doc));
  console.log('CHILD:replaced');
 }else if(process.env.TEST_LATE){
  const tmux=(...args)=>spawnSync('tmux',args,{encoding:'utf8',env:process.env});
  const created=tmux('new-window','-d','-t','demo/parent','-n','late','sleep 600');
  if(created.status!==0) throw new Error('late window: '+created.stderr);
  const pane=tmux('display-message','-p','-t','demo/parent:2.0','#{pane_id}').stdout.trim();
  const path=process.env.TEST_REGISTRY,doc=JSON.parse(readFileSync(path,'utf8'));
  doc.seats.late={...doc.seats.child,instance:'late-one',pane:'demo/parent:2.0',pane_id:pane};
  writeFileSync(path,JSON.stringify(doc));
  if(process.env.TEST_LATE==='armed'){
   await reconcileCrewLifetime(resolveContext(process.cwd(),process.env,{explicitTeam:'demo',readOnly:true}),'parent','late');
   console.log('LATE:armed');
  }else console.log('LATE:unarmed');
 }
 return process.env.TEST_CONSENT==='yes';
};
try {const rc=await runTeamStopDoor(process.env.TEST_VERB,JSON.parse(process.env.TEST_ARGS),{picker,consent});
 console.log('RESULT:'+rc);process.exitCode=rc;}
catch(error){console.error('ERR:'+error.errorClass+':'+error.detail);process.exitCode=error.code||1;}
`;
const driver = String.raw`
import os,pty,subprocess,sys,select,time,termios,json,fcntl
master,slave=pty.openpty()
def ctty(): os.setsid(); fcntl.ioctl(0,termios.TIOCSCTTY,0)
p=subprocess.Popen([sys.argv[1],sys.argv[2]],cwd=os.environ['TEST_CWD'],stdin=slave,stdout=slave,stderr=slave,env=os.environ.copy(),preexec_fn=ctty)
data=b''; deadline=time.monotonic()+40
try:
 while p.poll() is None:
  if time.monotonic()>deadline: raise AssertionError('stop door timeout '+repr(data[-2000:]))
  if select.select([master],[],[],.05)[0]:
   try: data+=os.read(master,65536)
   except OSError: pass
 for _ in range(5):
  if select.select([master],[],[],.02)[0]:
   try: data+=os.read(master,65536)
   except OSError: pass
 print(json.dumps({'code':p.wait(),'output':data.decode(errors='replace')}))
finally:
 if p.poll() is None: p.kill();p.wait()
 os.close(master);os.close(slave)
`;

function run(f: ReturnType<typeof fixture>, verb: "down" | "shutdown", args: string[], select: string,
  consent = "yes", outside = false, pickerCancel = false, late = "") {
  const path = join(f.root, `entry-${verb}.ts`);
  writeFileSync(path, entry);
  const child = spawnSync("python3", ["-c", driver, process.execPath, path], { encoding: "utf8", timeout: 50_000,
    env: { ...f.env, TEST_CWD: outside ? f.root : f.teamRoot, TEST_VERB: verb, TEST_ARGS: JSON.stringify(args),
      TEST_SELECT: select, TEST_TEAM: "demo", TEST_CONSENT: consent, TEST_PICKER_CANCEL: pickerCancel ? "1" : "",
      TEST_LATE: late, TEST_REGISTRY: f.registry } });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout) as { code: number; output: string };
}

test("interactive down previews finite parent cohort, cancellation has no effect, then confirmation stops its legacy crew", () => {
  const f = fixture(true);
  try {
    const pickerCancelled = run(f, "down", ["--only"], "parent", "yes", false, true);
    expect(pickerCancelled.code, pickerCancelled.output).toBe(0);
    expect(pickerCancelled.output).toContain("cancelled");
    expect(pickerCancelled.output).not.toContain("plan for team");
    expect(f.tmux("has-session", "-t", "=demo/parent").status).toBe(0);
    const cancelled = run(f, "down", ["--only"], "parent", "no");
    expect(cancelled.code, cancelled.output).toBe(0);
    expect(cancelled.output).toContain("PICK:team down:parent");
    expect(cancelled.output).toContain("CONSENT");
    expect(cancelled.output).toContain("spared by --only parent, child");
    expect(cancelled.output).toContain("other (excepted: demo/other)");
    expect(cancelled.output).toContain("dry-run — nothing killed");
    expect(cancelled.output).toContain("cancelled");
    expect(f.tmux("has-session", "-t", "=demo/parent").status).toBe(0);
    expect(f.rows().parent?.status).toBe("active");
    const confirmed = run(f, "down", ["--only"], "parent");
    expect(confirmed.code, confirmed.output).toBe(0);
    expect(confirmed.output).toContain("CONSENT");
    expect(confirmed.output).toContain("dry-run — nothing killed");
    expect(f.tmux("has-session", "-t", "=demo/parent").status).not.toBe(0);
    expect(f.tmux("has-session", "-t", "=demo/other").status).toBe(0);
    expect(f.rows().parent?.status).toBe("suspended");
    expect(f.rows().child).toBeUndefined();
    expect(f.rows().other?.status).toBe("active");
  } finally { f.close(); }
}, 90_000);

test("named shutdown --except --yes spares the unrelated parent without consent", () => {
  const f = fixture(true);
  try {
    const result = run(f, "shutdown", ["demo", "--except", "--yes"], "other");
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("PICK:team shutdown:other");
    expect(result.output).not.toContain("CONSENT");
    expect(result.output).toContain("dry-run — nothing killed");
    expect(f.tmux("has-session", "-t", "=demo/parent").status).not.toBe(0);
    expect(f.tmux("has-session", "-t", "=demo/other").status).toBe(0);
    expect(f.rows().child).toBeUndefined();
    expect(f.rows().other?.status).toBe("active");
    expect(existsSync(join(f.index, "global-registry.json"))).toBe(true);
  } finally { f.close(); }
}, 90_000);

test("a child added during consent needs an existing binding to the selected parent lifetime", () => {
  const unarmed = fixture(true);
  try {
    const before = unarmed.rows().parent?.status;
    const refused = run(unarmed, "down", ["--only"], "parent", "yes", false, false, "unarmed");
    expect(refused.code, refused.output).toBe(1);
    expect(refused.output).toContain("LATE:unarmed");
    expect(refused.output).toContain("ERR:crew_lifetime_unprovable");
    expect(unarmed.tmux("has-session", "-t", "=demo/parent").status).toBe(0);
    expect(unarmed.rows().parent?.status).toBe(before);
    expect(unarmed.rows().late?.status).toBe("active");
  } finally { unarmed.close(); }
  const armed = fixture(true);
  try {
    const result = run(armed, "down", ["--only"], "parent", "yes", false, false, "armed");
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("LATE:armed");
    expect(armed.tmux("has-session", "-t", "=demo/parent").status).not.toBe(0);
    expect(armed.rows().child).toBeUndefined();
    expect(armed.rows().late).toBeUndefined();
    expect(armed.rows().other?.status).toBe("active");
  } finally { armed.close(); }
}, 90_000);

test("a selected crew handle replaced during consent cannot inherit the stop", () => {
  const f = fixture(true);
  try {
    const refused = run(f, "down", ["--only"], "parent", "yes", false, false, "replace");
    expect(refused.code, refused.output).toBe(1);
    expect(refused.output).toContain("CHILD:replaced");
    expect(refused.output).toContain("ERR:target_changed");
    expect(f.tmux("has-session", "-t", "=demo/parent").status).toBe(0);
    expect(f.rows().parent?.status).toBe("active");
  } finally { f.close(); }
}, 90_000);

test("a no-crew shell survivor can be stopped interactively; a crew makes the same lifetime unprovable", () => {
  const noCrew = fixture(false, true);
  try {
    const result = run(noCrew, "down", ["--only"], "parent");
    expect(result.code, result.output).toBe(0);
    expect(noCrew.tmux("has-session", "-t", "=demo/parent").status).not.toBe(0);
  } finally { noCrew.close(); }
  const withCrew = fixture(true, true);
  try {
    const before = readFileSync(withCrew.registry, "utf8");
    const refused = run(withCrew, "down", ["--only"], "parent");
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("ERR:target_unbound");
    expect(withCrew.tmux("has-session", "-t", "=demo/parent").status).toBe(0);
    expect(readFileSync(withCrew.registry, "utf8")).toBe(before);
  } finally { withCrew.close(); }
}, 90_000);

test("unanchored supplied --only list discovers the team and stops a no-crew shell survivor", () => {
  const f = fixture(false, true);
  try {
    const result = run(f, "down", ["--only", "parent"], "parent", "yes", true);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("PICK:team down:demo");
    expect(f.tmux("has-session", "-t", "=demo/parent").status).not.toBe(0);
    expect(f.tmux("has-session", "-t", "=demo/other").status).toBe(0);
  } finally { f.close(); }
  const withCrew = fixture(true, true);
  try {
    const before = readFileSync(withCrew.registry, "utf8");
    const refused = run(withCrew, "down", ["--only", "parent"], "parent", "yes", true);
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("ERR:crew_lifetime_unprovable");
    expect(withCrew.tmux("has-session", "-t", "=demo/parent").status).toBe(0);
    expect(readFileSync(withCrew.registry, "utf8")).toBe(before);
  } finally { withCrew.close(); }
}, 90_000);
