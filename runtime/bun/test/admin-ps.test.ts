import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { cmdAdminPs, observeActivity, harnessProcess, parseResources, resourceCutoff, parseFootprints, sampleFootprints, formatMemory, type PsDeps } from "../src/verbs/admin-ps";
import { removeScratchTree } from "./support/scratch";
const env = {...process.env};
const scratch: string[] = [];
afterEach(() => { process.env = {...env}; for (const p of scratch.splice(0)) removeScratchTree(p); });
const resources = "10 10 20 0.0 1024 01:00 Ss zsh zsh\n20 20 20 12.5 204800 00:59 S claude claude\n30 30 30 4.5 4096 02:00 R codex codex\n";
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "admin-ps."))); scratch.push(root);
  const index = join(root, "index"); mkdirSync(index); process.env.TAP_INDEX_HOME = index;
  process.env.TAP_BOOT_ID = "boot:1"; process.env.TAP_BOOT_ID_LEGACY = "boot:1"; delete process.env.TAP_SERVER_EPOCH;
  const teams: Record<string, unknown> = {}, registries: string[] = [];
  const add = (name: string, seats: Record<string, unknown>) => {
    const dir = join(root, name); mkdirSync(dir); const reg = join(dir, "registry.json"); registries.push(reg);
    writeFileSync(reg, JSON.stringify({schema:"0.20", team:{name,worktree_root:dir}, seats}));
    teams[name] = {root:dir,registry_location:reg,state:"registered"};
    writeFileSync(join(index,"global-registry.json"),JSON.stringify({schema:"0.20",teams}));
  };
  const seat = (harness = "claude", socket = "/tmp/ps-test-socket") => ({status:"active",harness,session:"seat",pane:"seat:0.0",pane_id:"%1",server_epoch:"srv:1:1",boot_id:"boot:1",server_socket:socket});
  let resourceReads = 0, gathers = 0;
  const deps: PsDeps = {
    footprints: () => new Map(),
    resources: () => { resourceReads++; return {status:0,stdout:resources}; },
    gather: (rows, _env, psText, psOk) => { gathers++; return {rows,sessions_rc:0,sessions_text:"seat\t1:1\t0\n",panes_rc:0,panes_text:"seat\tseat:0.0\t%1\tclaude\t10\t1:1\t0\n",ps_rc:psOk?0:1,ps_text:psText,now_boot:"boot:1",legacy_boot:"boot:1",now_ts:100,tap_boot_id_set:true,tap_boot_id_legacy_set:true}; },
    activity: () => "working",
  };
  const run = (args = ["--json"]) => {
    let stdout = "", stderr = ""; const out = process.stdout.write, err = process.stderr.write;
    process.stdout.write = ((s: unknown) => {stdout += String(s);return true;}) as typeof out;
    process.stderr.write = ((s: unknown) => {stderr += String(s);return true;}) as typeof err;
    try { const code = cmdAdminPs(args,deps); return {code,stdout,stderr}; } finally {process.stdout.write=out;process.stderr.write=err;}
  };
  return {add,seat,deps,run,registries,index,root,counts:()=>({resourceReads,gathers})};
}
test("foreground harness PID and resources exclude shell and background agents", () => {
  const samples = parseResources(resources);
  expect(harnessProcess("10","claude",samples)?.pid).toBe("20");
  expect(harnessProcess("10","codex",samples)).toBeUndefined();
  expect(harnessProcess("30","codex",samples)?.pid).toBe("30");
  expect(harnessProcess("999","claude",samples)).toBeUndefined();
  expect(parseResources("bad\n1 1 1 NaN 42 1 S codex codex").size).toBe(0);
});
test("machine-wide table shares one resource snapshot and preserves registries", () => {
  const f=fixture();f.add("a",{same:f.seat(),stopped:{status:"suspended"}});f.add("b",{same:f.seat()});
  const before=f.registries.map(p=>readFileSync(p,"utf8"));const r=f.run();
  expect(r.code).toBe(0);expect(r.stderr).toBe("");const doc=JSON.parse(r.stdout);
  expect(doc.seats).toHaveLength(2);expect(doc.seats.map((s:any)=>s.team)).toEqual(["a","b"]);
  expect(doc.seats[0]).toMatchObject({pid:20,cpu_percent:12.5,rss_kib:204800,activity:"working",process_state:"S"});
  expect(f.counts()).toEqual({resourceReads:1,gathers:1});expect(f.registries.map(p=>readFileSync(p,"utf8"))).toEqual(before);
  const text=f.run([]);expect(text.stdout).toContain("209.7MB");expect(text.stdout).toContain("CPU%");expect(text.stdout).not.toContain("\x1b");
});
test("separate tmux sockets get distinct inventories",()=>{
  const f=fixture();f.add("a",{same:f.seat()});f.add("b",{same:f.seat("claude","/tmp/ps-second")});
  expect(JSON.parse(f.run().stdout).seats).toHaveLength(2);expect(f.counts()).toEqual({resourceReads:1,gathers:2});
});
test("failed resource snapshot retains unknown rows and null metrics",()=>{
  const f=fixture();f.add("a",{seat:f.seat()});f.deps.resources=()=>({status:1,stdout:""});
  const r=f.run();expect(r.code).toBe(1);expect(r.stderr).toBe("");
  expect(JSON.parse(r.stdout).seats[0]).toMatchObject({pid:null,cpu_percent:null,rss_kib:null,reason:"process snapshot unavailable"});
});
test("poll and daemon seats are omitted without diagnostics alongside confirmed inactive seats",()=>{
  const f=fixture();f.add("a",{poll:{status:"active",delivery:"poll"},daemon:{status:"active",harness:"daemon"},offline:{status:"offline"},seat:f.seat()});
  const r=f.run();expect(r.code).toBe(0);const doc=JSON.parse(r.stdout);expect(doc.seats).toHaveLength(1);
  expect(doc.seats[0].handle).toBe("seat"); expect(doc.diagnostics).toEqual([]);
});
test("empty enrolled machine is explicit and invalid options refuse before scanning",()=>{
  const f=fixture();f.add("empty",{});expect(f.run([]).stdout).toBe("tap admin ps: no active seats observed\n");
  expect(()=>f.run(["--fix"])).toThrow("accepted options");expect(f.counts()).toEqual({resourceReads:0,gathers:0});
});

test("a failed socket retains its registered active seats", () => {
  const f=fixture(); f.add("a", {seat:f.seat()});
  f.deps.gather=()=>{throw new Error("timeout");};
  const r=f.run();expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout).seats[0]).toMatchObject({team:"a",handle:"seat",status:"unknown",pid:null});
});

test("shell argv naming the harness never supplies its PID or metrics", () => {
  const f = fixture(); f.add("a", {seat: f.seat()});
  f.deps.resources = () => ({status: 0, stdout: resources.replace("Ss zsh zsh", "Ss zsh zsh -c claude")});
  const row = JSON.parse(f.run().stdout).seats[0];
  expect(row).toMatchObject({pid: 20, cpu_percent: 12.5, rss_kib: 204800});
  const samples = parseResources("10 10 20 0.0 1024 01:00 Ss zsh zsh -c claude\n");
  expect(harnessProcess("10", "claude", samples)).toBeUndefined();
  expect(harnessProcess("10", "claude", parseResources("10 10 10 0.0 1024 01:00 Ss zsh zsh -c claude\n"))).toBeUndefined();
});

test("partial JSON failures retain rows and the standard envelope", () => {
  const f=fixture(); f.add("a", {seat:f.seat()});
  f.deps.activity=()=>{throw new Error("activity capture unavailable");};
  const r=f.run(); expect(r.code).toBe(1); expect(r.stderr).toBe("");
  const report=JSON.parse(r.stdout);
  expect(report).toMatchObject({ok:false,error_class:"observation_incomplete",action:"inspect diagnostics and retry tap admin ps"});
  expect(report.seats[0]).toMatchObject({pid:20,activity:"unknown",reason:"activity capture unavailable; RSS fallback (footprint unavailable)"});
});
test("empty schema marker, explicit JSON mode, and socket-local epochs", () => {
  const f=fixture();writeFileSync(join(f.index,"global-registry.json"),JSON.stringify({schema:"0.20"}));
  expect(f.run().code).toBe(0);
  process.env.TAP_JSON="1";expect(()=>f.run(["--bad"])).toThrow();expect(process.env.TAP_JSON).toBe("0");
  f.add("a",{seat:f.seat()});process.env.TAP_SERVER_EPOCH="srv:999:999";
  const gather=f.deps.gather;f.deps.gather=(rows,env,ps,ok)=>{expect(env.TAP_SERVER_EPOCH).toBeUndefined();return gather(rows,env,ps,ok);};
  expect(JSON.parse(f.run().stdout).seats[0].pid).toBe(20);
});
test("special registry files are diagnosed without opening", () => {
  const f=fixture();const fifo=join(f.root,"fifo");expect(spawnSync("mkfifo",[fifo]).status).toBe(0);
  writeFileSync(join(f.index,"global-registry.json"),JSON.stringify({schema:"0.20",teams:{a:{root:f.root,registry_location:fifo,state:"registered"}}}));
  const r=f.run();expect(r.code).toBe(1);expect(JSON.parse(r.stdout).diagnostics[0].reason).toBe("acting registry is not a regular file");
});
test("activity capture requires successful reads in the observed generation", () => {
  const run=(code=0,epoch="1:1")=>((args:string[])=>({code:args[0]==="capture-pane"?code:0,stdout:args[0]==="capture-pane"?"ready":epoch,stderr:""}));
  expect(()=>observeActivity("claude","%1",{},"srv:1:1",run(1))).toThrow("capture unavailable");
  expect(()=>observeActivity("claude","%1",{},"srv:1:1",run(0,"2:2"))).toThrow("generation changed");
  expect(()=>observeActivity("claude","%1",{},"srv:1:1",run())).not.toThrow();
});

test("partial plain failures retain rows and use one cause-and-recovery line", () => {
  const f=fixture(); f.add("a", {seat:f.seat()});
  f.deps.activity=()=>{throw new Error("capture\nunavailable");};
  const r=f.run([]); expect(r.code).toBe(1); expect(r.stdout).toContain("CPU%");
  expect(r.stderr).toBe("tap admin ps: a/seat: capture unavailable; next: inspect diagnostics and retry tap admin ps\n");
});
for (const state of ["registred", {unexpected:true}]) test(`unknown team state is diagnosed: ${JSON.stringify(state)}`, () => {
  const f=fixture();
  writeFileSync(join(f.index,"global-registry.json"),JSON.stringify({schema:"0.20",teams:{a:{root:f.root,state}}}));
  const r=f.run(); expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout).diagnostics).toEqual([{team:"a",reason:"invalid team enrollment state"}]);
});
test("an enrolled root replaced by a regular file cannot supply active seats", () => {
  const f=fixture(); const rootFile=join(f.root,"former-root"); writeFileSync(rootFile,"gone");
  writeFileSync(join(f.index,"global-registry.json"),JSON.stringify({schema:"0.20",teams:{a:{root:rootFile,registry_location:join(f.root,"registry.json"),state:"registered"}}}));
  const r=f.run(); expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout).diagnostics[0].reason).toBe("enrolled team root is not a directory");
});

test("invalid machine index points to diagnosis, not another reader of the same invalid index", () => {
  const f=fixture(); writeFileSync(join(f.index,"global-registry.json"), "{broken");
  let failure; try {f.run();} catch (error) {failure=error;}
  expect(failure).toMatchObject({errorClass:"registry_invalid",action:"tap doctor"});
});
test("malformed seat status is diagnosed instead of counted as confirmed inactive", () => {
  const f=fixture(); f.add("a",{typo:{...f.seat(),status:"actve"},offline:{status:"offline"},suspended:{status:"suspended"}});
  const r=f.run(); expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout).diagnostics).toEqual([{team:"a",handle:"typo",reason:"invalid seat status"}]);
});
test("relative enrollment cannot make an absolute enrollment ambiguous", () => {
  const f=fixture(); f.add("a",{seat:f.seat()});
  const indexFile=join(f.index,"global-registry.json"), doc=JSON.parse(readFileSync(indexFile,"utf8"));
  doc.teams.bad={...doc.teams.a,root:relative(process.cwd(),join(f.root,"a"))}; writeFileSync(indexFile,JSON.stringify(doc));
  const r=f.run(); expect(r.code).toBe(1);
  const report=JSON.parse(r.stdout); expect(report.seats[0].team).toBe("a");
  expect(report.diagnostics).toEqual([{team:"bad",reason:"missing absolute team root or acting registry"}]);
});
test("relative acting identity root refuses even when cwd would make it match", () => {
  const f=fixture(); f.add("a",{seat:f.seat()});
  const path=f.registries[0]!, doc=JSON.parse(readFileSync(path,"utf8")); doc.team.worktree_root="."; writeFileSync(path,JSON.stringify(doc));
  const startCwd=process.cwd();
  try {
    for (const cwd of [join(f.root,"a"), startCwd]) {
      process.chdir(cwd); const r=f.run(); expect(r.code).toBe(1);
      expect(JSON.parse(r.stdout).diagnostics[0].reason).toBe("acting team identity root is not absolute");
    }
  } finally {process.chdir(startCwd);}
});

test("a daemon-only machine is quiet and does not scan processes or panes", () => {
  const f=fixture();f.add("services",{cron:{delivery:"poll",status:"active"},daemon:{harness:"daemon",status:"active"}});
  const r=f.run([]);expect(r.code).toBe(0);expect(r.stderr).toBe("");
  expect(r.stdout).toBe("tap admin ps: no active seats observed\n");expect(f.counts()).toEqual({resourceReads:0,gathers:0});
});

test("daemon omission preserves malformed identity diagnostics without process scans", () => {
  const f=fixture();f.add("services",{
    badDelivery:{harness:"daemon",delivery:"unsupported"},
    badSocket:{delivery:"poll",server_socket:42},
    badStatus:{delivery:"poll",status:"actve"},
    relativeSocket:{harness:"daemon",server_socket:"relative"},
  });
  const r=f.run();expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout)).toMatchObject({ok:false,seats:[],diagnostics:[
    {team:"services",handle:"badDelivery",reason:"invalid seat identity fields"},
    {team:"services",handle:"badSocket",reason:"invalid seat identity fields"},
    {team:"services",handle:"badStatus",reason:"invalid seat status"},
    {team:"services",handle:"relativeSocket",reason:"invalid socket path"},
  ]});
  const text=f.run([]);expect(text.code).toBe(1);expect(text.stderr).toContain("invalid seat identity fields");
  expect(f.counts()).toEqual({resourceReads:0,gathers:0});
});

test("status indicators share the team palette and honor terminal color controls", () => {
  const f=fixture();f.add("a",{seat:f.seat()});
  const original=Object.getOwnPropertyDescriptor(process.stdout,"isTTY");
  try {
    Object.defineProperty(process.stdout,"isTTY",{value:true,configurable:true});
    process.env.TERM="xterm-256color";delete process.env.NO_COLOR;
    expect(f.run([]).stdout).toContain("\x1b[32m●\x1b[0m working");
    f.deps.activity=()=>"blocked";
    expect(f.run([]).stdout).toContain("\x1b[31m●\x1b[0m blocked");
    expect(f.run().stdout).not.toContain("\x1b");
    process.env.NO_COLOR="";expect(f.run([]).stdout).not.toContain("\x1b");delete process.env.NO_COLOR;
    process.env.TERM="dumb";expect(f.run([]).stdout).not.toContain("\x1b");process.env.TERM="xterm";
    Object.defineProperty(process.stdout,"isTTY",{value:false,configurable:true});
    const plain=f.run([]).stdout;expect(plain).not.toContain("\x1b");expect(plain).toContain("● blocked");
  } finally {
    if(original) Object.defineProperty(process.stdout,"isTTY",original);else Reflect.deleteProperty(process.stdout,"isTTY");
  }
});

test("resource emphasis applies independent floors and the third-place cutoff, including ties", () => {
  expect(resourceCutoff([null, 0, 24.9],25)).toBe(Infinity);
  expect(resourceCutoff([null, 25, 50],25)).toBe(25);
  const values=[100,80,70,70,25,0,null];const cutoff=resourceCutoff(values,25);
  expect(cutoff).toBe(70);expect(values.filter(n=>n!==null && n>=cutoff)).toEqual([100,80,70,70]);
  expect(resourceCutoff([1024*1024-1,null],1024*1024)).toBe(Infinity);
  expect(resourceCutoff([1024*1024,null],1024*1024)).toBe(1024*1024);
});
test("high resource cells retain marks without color, raw JSON, and aligned colored output", () => {
  const f=fixture();f.add("a",{seat:f.seat()});
  const quiet=f.run([]).stdout;expect(quiet).not.toContain("*");
  f.deps.resources=()=>({status:0,stdout:resources.replace("12.5 204800","41.0 2361344")});
  const plain=f.run([]).stdout;expect(plain).toContain("41.0*");expect(plain).toContain("2.42GB*");expect(plain).toContain("ties included");
  const json=f.run().stdout;expect(json).not.toContain("*");expect(JSON.parse(json).seats[0]).toMatchObject({cpu_percent:41,rss_kib:2361344});
  const original=Object.getOwnPropertyDescriptor(process.stdout,"isTTY");
  try {
    Object.defineProperty(process.stdout,"isTTY",{value:true,configurable:true});process.env.TERM="xterm";delete process.env.NO_COLOR;
    const colored=f.run([]).stdout;expect(colored).toContain("\x1b[1;33m41.0*\x1b[0m");expect(colored).toContain("\x1b[1;33m2.42GB*\x1b[0m");
    expect(colored.replace(/\x1b\[[0-9;]*m/g,"")).toBe(plain);
    process.env.NO_COLOR="";expect(f.run([]).stdout).toBe(plain);
  } finally {if(original) Object.defineProperty(process.stdout,"isTTY",original);else Reflect.deleteProperty(process.stdout,"isTTY");}
});

test("footprint parser associates each header with its PID and ignores totals and refused PIDs", () => {
  const text = `======================================================================
claude [20]: 64-bit    Footprint: 2040 MB (16384 bytes per page)
TOTAL 999 GB
    phys_footprint_peak: 9999 MB
footprint: failed to inspect pid 30: permission denied
codex [40]: 64-bit    Footprint: 555110400 B (16384 bytes per page)
other [50]: 64-bit    Footprint: 2.5 GB (16384 bytes per page)
`;
  expect([...parseFootprints(text)]).toEqual([[20,2088960],[40,542100],[50,2621440]]);
  expect(parseFootprints("bad [1]: Footprint: 1.2.3 MB\nbad [2]: Footprint: 1e99 B").size).toBe(0);
});

test("sampler batches PIDs, retains partial success, and handles missing binary and non-macOS", () => {
  const calls: unknown[][] = [];
  const run = ((...args: unknown[]) => {calls.push(args); return {status:1,stdout:"claude [20]: 64-bit    Footprint: 1048576 B\n",stderr:"pid 30 refused"};});
  expect([...sampleFootprints([20,30],"darwin",run)]).toEqual([[20,1024]]);
  expect(calls).toHaveLength(1);
  expect(calls[0]![1]).toEqual(["--format","bytes","--noCategories","--pid","20","--pid","30"]);
  const missing = (() => ({status:null,stdout:null,error:Object.assign(new Error("not found"),{code:"ENOENT"})}));
  expect(sampleFootprints([20],"darwin",missing).size).toBe(0);
  expect(sampleFootprints([20],"linux",run).size).toBe(0);
  expect(sampleFootprints([],"darwin",run).size).toBe(0);
  expect(calls).toHaveLength(1);
});

test("MEMORY uses footprint for values and stars, retains raw RSS, and labels only fallback rows", () => {
  const f=fixture();f.add("a",{seat:f.seat()});f.add("b",{seat:f.seat("claude","/tmp/ps-second")});
  const calls: number[][]=[];
  f.deps.footprints=pids=>{calls.push(pids);return new Map([[20,Math.round(2.04e9/1024)]]);};
  const r=f.run();expect(r.code).toBe(0);
  expect(calls).toEqual([[20]]);
  expect(JSON.parse(r.stdout).seats[0]).toMatchObject({footprint_kib:1992188,rss_kib:204800,reason:""});
  const text=f.run([]).stdout;expect(text).toContain("MEMORY");expect(text).toContain("2.04GB*");expect(text).not.toContain("RSS fallback");
  f.deps.resources=()=>({status:0,stdout:resources.replace("204800","3000000")});
  f.deps.footprints=()=>new Map([[20,1000]]);
  expect(f.run([]).stdout).not.toContain("*");
  f.deps.footprints=()=>sampleFootprints([20],"darwin",(()=>({status:null,stdout:null,error:new Error("ENOENT")})));
  const fallback=f.run();expect(fallback.code).toBe(0);
  expect(JSON.parse(fallback.stdout).seats[0]).toMatchObject({footprint_kib:null,rss_kib:3000000,reason:"RSS fallback (footprint unavailable)"});
  expect(f.run([]).stdout).toContain("3.07GB*");
});

test("human memory uses decimal MB below one GB and two decimal GB at or above", () => {
  expect(formatMemory(542100)).toBe("555.1MB");
  expect(formatMemory(0)).toBe("0.0MB");
  expect(formatMemory(976562)).toBe("1000.0MB");
  expect(formatMemory(976563)).toBe("1.00GB");
  expect(formatMemory(1992188)).toBe("2.04GB");
});
