import {test,expect} from "bun:test";
import {spawnSync} from "node:child_process";
import {chmodSync,existsSync,mkdtempSync,mkdirSync,realpathSync,writeFileSync,readFileSync} from "node:fs";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {ensureTmuxServer,tmuxBootstrapEnabled} from "../src/launcher/tmux-bootstrap";

// A scripted tmux on PATH: probes answer "no server" until the server is up
// (or until FAKE_UP_AFTER probes), start-server records its env and cwd.
function fakeEnv(extra:Record<string,string>={}){
 const base=realpathSync(mkdtempSync(join(tmpdir(),"bootstrap-fake-")));const home=join(base,"home"),bin=join(base,"bin"),state=join(base,"state");
 for(const dir of [home,bin,state])mkdirSync(dir);
 writeFileSync(join(bin,"tmux"),`#!/bin/bash
state='${state}'
printf '%s\\n' "$*" >> "$state/calls"
case " $* " in
 *" display-message "*)
  n=$(( $(cat "$state/probes" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$state/probes"
  if [ -e "$state/up" ] || { [ -n "$FAKE_UP_AFTER" ] && [ "$n" -ge "$FAKE_UP_AFTER" ]; }; then echo 123; exit 0; fi
  echo "\${FAKE_PROBE_ERR:-no server running on /x}" >&2; exit 1 ;;
 *" start-server "*)
  env > "$state/daemon-env"; pwd -P > "$state/daemon-cwd"
  if [ -n "$FAKE_START_FAIL" ]; then echo "$FAKE_START_FAIL" >&2; exit 7; fi
  : > "$state/up"; exit 0 ;;
esac
exit 0
`);
 chmodSync(join(bin,"tmux"),0o755);
 const env:NodeJS.ProcessEnv={HOME:home,PATH:`${bin}:/usr/bin:/bin`,TAP_INDEX_HOME:join(base,"index"),XDG_CONFIG_HOME:join(home,".config"),
  TAP_TMUX_SOCKET_PATH:join(base,"socket"),TERM:"dumb",TMUX:"/old/socket,1,1",TMUX_PANE:"%1",CODEX_THREAD_ID:"old",CLAUDECODE:"1",
  ANTHROPIC_API_KEY:"secret",TAP_HOME:"/foreign",GIT_DIR:"/repo/.git",...extra};
 const calls=()=>existsSync(join(state,"calls"))?readFileSync(join(state,"calls"),"utf8").trim().split("\n"):[];
 return {base,home,state,env,calls};
}
const config=(home:string,body:string)=>{mkdirSync(join(home,".config/tap"),{recursive:true});writeFileSync(join(home,".config/tap/config.toml"),body);};

test("an absent server starts from HOME with a scrubbed daemon environment",async()=>{
 const f=fakeEnv();
 expect(await ensureTmuxServer(f.env)).toBe(true);
 const start=f.calls().find(line=>line.includes("start-server"))!;
 expect(start).toBe(`-S ${f.env.TAP_TMUX_SOCKET_PATH} start-server ; set-option -s exit-empty off`);
 expect(readFileSync(join(f.state,"daemon-cwd"),"utf8").trim()).toBe(realpathSync(f.home));
 const daemon=Object.fromEntries(readFileSync(join(f.state,"daemon-env"),"utf8").trim().split("\n").map(line=>[line.slice(0,line.indexOf("=")),line.slice(line.indexOf("=")+1)]));
 expect(daemon.TERM).toBe("xterm-256color");
 expect(Object.keys(daemon).filter(key=>/^(TAP_|CODEX|CLAUDE|ANTHROPIC_)/.test(key)||["TMUX","TMUX_PANE","GIT_DIR"].includes(key))).toEqual([]);
});

test("an existing server is never reconfigured and leaves no lock state",async()=>{
 const f=fakeEnv({FAKE_UP_AFTER:"1"});
 expect(await ensureTmuxServer(f.env)).toBe(false);
 expect(f.calls().length).toBe(1);
 expect(existsSync(f.env.TAP_INDEX_HOME!)).toBe(false);
});

test("opt-out neither probes nor touches the server",async()=>{
 const f=fakeEnv();config(f.home,"[tmux]\nbootstrap = false\n");
 expect(await ensureTmuxServer(f.env)).toBe(false);
 expect(f.calls()).toEqual([]);
 expect(existsSync(f.env.TAP_INDEX_HOME!)).toBe(false);
});

test("an unobservable socket is not an absent one",async()=>{
 const f=fakeEnv({FAKE_PROBE_ERR:"Permission denied"});
 await expect(ensureTmuxServer(f.env)).rejects.toThrow("tmux server is unobservable: Permission denied");
 expect(f.calls().length).toBe(1);
});

test("the locked second probe observes a concurrent starter",async()=>{
 const f=fakeEnv({FAKE_UP_AFTER:"2"});
 expect(await ensureTmuxServer(f.env)).toBe(false);
 expect(f.calls().length).toBe(2);
 expect(f.calls().some(line=>line.includes("start-server"))).toBe(false);
});

test("a broken config warns and stays enabled; an invalid value refuses",()=>{
 const f=fakeEnv();const warnings:string[]=[];
 config(f.home,"[unrelated]\nbroken = [\n");
 expect(tmuxBootstrapEnabled(f.env,line=>warnings.push(line))).toBe(true);
 expect(warnings).toEqual([`tap config: could not read ${join(f.home,".config/tap/config.toml")}; defaulting tmux bootstrap to enabled`]);
 config(f.home,"[tmux]\nbootstrap = \"invalid\"\n");
 expect(()=>tmuxBootstrapEnabled(f.env)).toThrow("tmux.bootstrap must be true or false");
});

test("failed and successful starts are traced to the startup log",async()=>{
 // Trace evidence follows the process's own index, like every launcher trace.
 const failing=fakeEnv({FAKE_START_FAIL:"boom"});const index=failing.env.TAP_INDEX_HOME!;const saved=process.env.TAP_INDEX_HOME;
 process.env.TAP_INDEX_HOME=index;
 try{
  await expect(ensureTmuxServer(failing.env)).rejects.toThrow("boom");
  const f=fakeEnv({TAP_INDEX_HOME:index});
  expect(await ensureTmuxServer(f.env)).toBe(true);
 }finally{process.env.TAP_INDEX_HOME=saved;}
 const events=readFileSync(join(index,"logs/startup.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line)).filter(row=>row.event==="tmux_bootstrap");
 expect(events.map(row=>row.exit_code)).toEqual([7,0]);
});

test("cold server starts from HOME; existing server and opt-out remain untouched",async()=>{
 const base=mkdtempSync(join(tmpdir(),"bootstrap-"));const home=join(base,"home");mkdirSync(home);
 const socket=join(process.env.TMUX_TMPDIR!,"new-socket-dir","bootstrap-real");
 const env={...process.env,HOME:home,TAP_INDEX_HOME:join(base,"index"),XDG_CONFIG_HOME:join(home,".config"),TAP_TMUX_SOCKET_PATH:socket,TERM:"dumb",CODEX_THREAD_ID:"old",TAP_SELF:"old"};
 const tmux=(...args:string[])=>spawnSync("tmux",["-S",socket,...args],{env,encoding:"utf8"});
 try{
  expect(await ensureTmuxServer(env)).toBe(true);
  const pid=tmux("display-message","-p","#{pid}").stdout.trim();expect(pid).toMatch(/^\d+$/);
  expect(tmux("show-options","-s","-v","exit-empty").stdout.trim()).toBe("off");
  expect(tmux("show-environment","-g","CODEX_THREAD_ID").status).not.toBe(0);
  expect(tmux("new-session","-d","-s","keeper","sleep 60").status).toBe(0);
  tmux("set-option","-s","exit-empty","on");
  expect(await ensureTmuxServer(env)).toBe(false);
  expect(tmux("display-message","-p","#{pid}").stdout.trim()).toBe(pid);
  expect(tmux("show-options","-s","-v","exit-empty").stdout.trim()).toBe("on");
 }finally{tmux("kill-server");}
 config(home,"[tmux]\nbootstrap = false\n");
 expect(await ensureTmuxServer(env)).toBe(false);
 expect(tmux("-N","list-sessions").status).not.toBe(0);
},30000);

test("empty socket name cold-starts the default socket inside the private root",async()=>{
 const base=mkdtempSync(join(process.env.TMUX_TMPDIR!,"empty."));
 const home=join(base,"home");mkdirSync(home);
 const env={...process.env,HOME:home,TAP_INDEX_HOME:join(base,"index"),XDG_CONFIG_HOME:join(home,".config"),TMUX_TMPDIR:base,TMUX:"",TAP_TMUX_SOCKET:"",TAP_TMUX_SOCKET_PATH:""};
 const directory=join(base,`tmux-${process.getuid!()}`),socket=join(directory,"default");
 const tmux=(path:string,...args:string[])=>spawnSync("tmux",["-S",path,...args],{env,encoding:"utf8"});
 try{
  expect(await ensureTmuxServer(env)).toBe(true);
  const probe=tmux(socket,"display-message","-p","#{pid}");
  expect(probe.status,probe.stderr).toBe(0);expect(probe.stdout.trim()).toMatch(/^\d+$/);
  expect(tmux(socket,"show-options","-s","-v","exit-empty").stdout.trim()).toBe("off");
 }finally{
  tmux(socket,"kill-server");
  // Also reap the old bug's socket-at-directory layout during the RED control.
  tmux(directory,"kill-server");
 }
},30000);
