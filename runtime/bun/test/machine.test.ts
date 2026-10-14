import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyEffort, historyPaths, installSourceAdvice, removeEntry, serializeToml, setupMachine, uninstallMachine } from "../src/verbs/machine";
import { archiveHistory, writeTarGz } from "../src/install-history";
import { fakePluginClis } from "./support/native-plugins";
import { stubHarnessCommands } from "./support/harness-stubs";
const repo = resolve(import.meta.dir,"../../..");
const original = {...process.env};
const roots: string[] = [];
const restores: (()=>void)[] = [];
afterEach(()=>{ for(const r of restores.splice(0))r(); process.env = {...original}; for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true}); });

// installMachineSkills logs "install: skipped <label> — <home> does not exist"
// for every harness home this fixture doesn't create; harmless noise the
// runner's undeclared-skip detector otherwise mistakes for an intentional skip.
const SKIPPED_INSTALL_LINE = /^install: skipped .+ does not exist \(no .+ install detected\)$/;
let restoreLogs: (() => void) | undefined;
beforeEach(() => {
  const origLog = console.log, origError = console.error;
  restoreLogs = () => { console.log = origLog; console.error = origError; };
  const filter = (orig: typeof console.log) => (...args: unknown[]) => {
    if (typeof args[0] === "string" && SKIPPED_INSTALL_LINE.test(args[0])) return;
    orig(...args);
  };
  console.log = filter(origLog); console.error = filter(origError);
});
afterEach(() => restoreLogs?.());
function fixture() {
  const root=mkdtempSync("/tmp/tap-machine-"); roots.push(root);
  process.env.HOME=join(root,"home");
  process.env.TAP_INDEX_HOME=join(root,"index");
  process.env.XDG_CONFIG_HOME=join(root,"config");
  process.env.SHELL="/bin/zsh";
  // A harness home is linked only when its command is on PATH: stub them so the machine's own CLIs never decide.
  // Outside the fixture root, which the uninstall tests assert is left empty.
  const stubs=mkdtempSync("/tmp/tap-harness-bin-"); roots.push(stubs);
  process.env.PATH=stubHarnessCommands(stubs)+":"+process.env.PATH;
  for(const p of [process.env.HOME,process.env.TAP_INDEX_HOME,process.env.XDG_CONFIG_HOME])mkdirSync(p!,{recursive:true});
  return root;
}
function nativePlugins() {
 const bin=mkdtempSync(join(original.TAP_INDEX_HOME!,"native-cli-"));roots.push(bin);
 fakePluginClis(bin);process.env.PATH=bin+":"+process.env.PATH;
}
function answers(values:string[]) {return async (question:string)=>{if(question.startsWith("Install the optional full"))return "y";if(question.startsWith("Notifier ["))return "";if(!values.length)throw Error(`unexpected prompt ${question}`);return values.shift()!;};}
// The zsh completion registration the setup block must carry: no second compinit when
// the user's own startup already ran one.
const ZSH_COMPLETION_GUARD="(( $+functions[compdef] )) && { autoload -Uz _tap && compdef _tap tap; } || { autoload -Uz compinit && compinit; }";
const q=(text:string)=>`'${text.replaceAll("'","'\\''")}'`;
async function freshZshBlock() {
 const root=fixture();
 expect(Bun.which("zsh")).not.toBeNull();
 expect(await setupMachine(async question=>question.includes("keep it simple")?"skip":"",["codex"])).toBe(0);
 const home=process.env.HOME!, rc=join(home,".zshrc");
 // The installer links _tap here; the block's fpath line points at this directory.
 const functions=join(home,".local","share","zsh","site-functions");
 mkdirSync(functions,{recursive:true});symlinkSync(join(repo,"completions","_tap"),join(functions,"_tap"));
 return {root,home,rc};
}
function runZsh(home:string,script:string) {
 return Bun.spawnSync(["zsh","-f","-c",script],{env:{HOME:home,ZDOTDIR:home,PATH:process.env.PATH!},stdout:"pipe",stderr:"pipe"});
}
test("effort modifier changes only reasoning while preserving service tier and TOML shape",()=>{
  const preset={harness:"codex",params:{model:"gpt-6-astra",config:["model_reasoning_effort=high","service_tier=default"]}};
  const result=applyEffort(preset,"medium");
  expect(result.params.config).toEqual(["service_tier=default","model_reasoning_effort=medium"]);
  expect(Bun.TOML.parse(serializeToml({version:3,presets:{astra:result}}))).toEqual({version:3,presets:{astra:result}});
});
test("wizard preserves existing config and writes only a candidate when replacement declined",async()=>{
 fixture(); const path=join(process.env.XDG_CONFIG_HOME!,"tap");mkdirSync(path);
 writeFileSync(join(path,"config.toml"),'version = 3\n# personal\n');
 expect(await setupMachine(answers(["","","simple","medium","auto","n","n","n","n"]),["codex"])).toBe(0);
 expect(readFileSync(join(path,"config.toml"),"utf8")).toBe('version = 3\n# personal\n');
 const candidate=Bun.TOML.parse(readFileSync(join(path,"config.candidate.toml"),"utf8")) as any;
 expect(Object.keys(candidate.presets).sort()).toEqual(["astra","luna","sol"]);
 expect(candidate.harness.codex.permissions).toBe("auto");
 expect(candidate.presets.astra.params.config).toContain("model_reasoning_effort=medium");
 expect(existsSync(join(process.env.HOME!,".zshrc"))).toBe(false);
});
test("wizard asks team-setup and interrupt choices, keeps saved values and tips WAIT for interrupt",async()=>{
 fixture(); const dir=join(process.env.XDG_CONFIG_HOME!,"tap");mkdirSync(dir);
 const path=join(dir,"config.toml");
 writeFileSync(path,'version=3\n# personal\n[onboarding]\ninit="ask"\n[injection]\nbehavior="warn"\n');
 const questions:string[]=[], output:string[]=[];
 const log=spyOn(console,"log").mockImplementation(value=>output.push(String(value)));
 restores.push(()=>log.mockRestore());
 expect(await setupMachine(async q=>{
   questions.push(q);
   if(q.startsWith("The first time TAP is used"))return "";
   if(q.startsWith("How should agents' messages reach you"))return "interrupt";
   if(q.includes("keep it simple"))return "skip";
   if(q.includes("Permission mode"))return "";
   if(q.startsWith("Install the optional full"))return "n";
   if(q.startsWith("Notifier ["))return "";
   if(q.startsWith("Update existing"))return "y";
   if(q.startsWith("Add shell"))return "n";
   throw new Error(`unexpected prompt ${q}`);
 },["codex"])).toBe(0);
 expect(output[0]).toContain("Pre-release beta: expect bugs");
 const initQ=questions.find(q=>q.startsWith("The first time TAP is used"))!;
 expect(initQ).toContain("[keep ask]");
 const behaviorQ=questions.find(q=>q.startsWith("How should agents' messages reach you"))!;
 expect(behaviorQ).toContain("[keep wait]");
 expect(behaviorQ).toContain("interrupt  Faster when your permission mode allows delivery into typed text");
 expect(behaviorQ).toContain("TAP saves only text it can");
 expect(behaviorQ).toContain("capture; paste-back is conditional");
 expect(behaviorQ).toContain("Pasted content or images may be missing");
 expect(behaviorQ).toContain("Type WAIT (in caps) to");
 expect(behaviorQ).toContain("wait       Messages wait until the agent's input is empty");
 expect(behaviorQ).not.toContain("draft comes back");
 expect(behaviorQ).toContain("`tap draft` recovers it");
 const parsed=Bun.TOML.parse(readFileSync(path,"utf8")) as any;
 expect(parsed.onboarding.init).toBe("ask");expect(parsed.injection.behavior).toBe("clobber");
 expect(readFileSync(path,"utf8")).toContain("# personal");
 expect(output.join("\n")).toContain("Tip: if you need more time, type WAIT (in caps)");
});
test("choosing wait writes the live spelling and suppresses the WAIT tip",async()=>{
 fixture();
 const output:string[]=[];
 const log=spyOn(console,"log").mockImplementation(value=>output.push(String(value)));
 restores.push(()=>log.mockRestore());
 expect(await setupMachine(async q=>{
   if(q.startsWith("The first time TAP is used"))return "auto";
   if(q.startsWith("How should agents' messages reach you"))return "wait";
   if(q.includes("keep it simple"))return "skip";
   if(q.includes("Permission mode"))return "";
   if(q.startsWith("Install the optional full"))return "n";
   if(q.startsWith("Notifier ["))return "";
   if(q.startsWith("Add shell"))return "n";
   throw new Error(`unexpected prompt ${q}`);
 },["codex"])).toBe(0);
 const parsed=Bun.TOML.parse(readFileSync(join(process.env.XDG_CONFIG_HOME!,"tap/config.toml"),"utf8")) as any;
  expect(parsed.onboarding.init).toBe("auto");expect(parsed.injection.behavior).toBe("wait");
  expect(output.join("\n")).not.toContain("Tip: if you need more time");
 });
test("declining the update bases the closing tip on the live config, not the declined choice",async()=>{
 const run=async (savedBehavior:string,answer:string)=>{
  fixture(); const dir=join(process.env.XDG_CONFIG_HOME!,"tap");mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,"config.toml"),`version=3\n[injection]\nbehavior="${savedBehavior}"\n`);
  const output:string[]=[];
  const log=spyOn(console,"log").mockImplementation(value=>output.push(String(value)));
  restores.push(()=>log.mockRestore());
  expect(await setupMachine(async q=>{
   if(q.startsWith("The first time TAP is used"))return "";
   if(q.startsWith("How should agents' messages reach you"))return answer;
   if(q.includes("keep it simple"))return "skip";
   if(q.includes("Permission mode"))return "";
   if(q.startsWith("Update existing"))return "n";
   if(q.startsWith("Install the optional full"))return "n";
   if(q.startsWith("Notifier ["))return "";
   throw new Error(`unexpected prompt ${q}`);
  },["codex"])).toBe(0);
  const live=Bun.TOML.parse(readFileSync(join(dir,"config.toml"),"utf8")) as any;
  expect(live.injection.behavior).toBe(savedBehavior);
  const candidate=Bun.TOML.parse(readFileSync(join(dir,"config.candidate.toml"),"utf8")) as any;
  expect(candidate.injection.behavior).toBe(answer === "wait" ? "wait" : "clobber");
  return output.join("\n");
 };
 expect((await run("clobber","wait"))).toContain("Tip: if you need more time, type WAIT (in caps)");
 expect(await run("warn","interrupt")).not.toContain("Tip: if you need more time");
});
test("invalid team-setup choice reprompts and accepts the corrected answer",async()=>{
 fixture(); let asked=0, reprompted=false;
 expect(await setupMachine(async q=>{
   if(q.startsWith("The first time TAP is used")){asked++;return asked===1?"maybe":"auto";}
   if(q.startsWith("Choose ask or auto")){reprompted=true;return "auto";}
   if(q.startsWith("How should agents' messages reach you"))return "interrupt";
   if(q.includes("keep it simple"))return "skip";
   if(q.includes("Permission mode"))return "";
   if(q.startsWith("Install the optional full"))return "n";
   if(q.startsWith("Notifier ["))return "";
   if(q.startsWith("Add shell"))return "n";
   throw new Error(`unexpected prompt ${q}`);
 },["codex"])).toBe(0);
 expect(asked).toBe(1);expect(reprompted).toBe(true);
 expect((Bun.TOML.parse(readFileSync(join(process.env.XDG_CONFIG_HOME!,"tap/config.toml"),"utf8")) as any).onboarding.init).toBe("auto");
});
test("uninstall preserves unrelated hook siblings and outside block bytes",()=>{
 const root=fixture(),path=join(root,"settings.json"),ours={command:"/repo/hooks/tap.sh",type:"command"};
 writeFileSync(path,JSON.stringify({theme:"dark",hooks:{SessionStart:[{matcher:"*",hooks:[ours,{command:"other"}]}]}}));
 expect(removeEntry({kind:"hook",path,event:"SessionStart",nested:true,value:ours})).toBe("removed TAP SessionStart hook from");
 expect(JSON.parse(readFileSync(path,"utf8"))).toEqual({theme:"dark",hooks:{SessionStart:[{matcher:"*",hooks:[{command:"other"}]}]}});
 const block="<!-- tap:begin -->\nours\n<!-- tap:end -->";
 writeFileSync(path,"before\n"+block+"\nafter\n");
 removeEntry({kind:"block",path,content:block});
 expect(readFileSync(path,"utf8")).toBe("before\nafter\n");
});
test("uninstall preserves edited files and replaced symlink targets",()=>{
 const root=fixture(),path=join(root,"link");symlinkSync("other",path);
 expect(removeEntry({kind:"symlink",path,target:"ours"})).toContain("preserved");
 const file=join(root,"file");writeFileSync(file,"personal edit");
 expect(removeEntry({kind:"file",path:file,sha256:"old"})).toContain("preserved");
});
test("noninteractive machine verbs refuse with an interactive next step",()=>{
 fixture();
 for(const [argv,next] of [[["setup","--machine"],"interactive terminal"],[["uninstall"],"next: tap uninstall --dry-run to preview"]] as const) {
  const r=Bun.spawnSync([join(repo,"bin/tap"),...argv],{env:process.env,stdin:"ignore"});
  expect(r.exitCode).toBe(2); expect(r.stderr.toString()).toContain(next);
 }
});
test("installer records all surfaces and uninstall detects an omitted manifest record",async()=>{
  const root=fixture();
  // A standalone disposable clone is the install target. install.sh's
  // pre-push guard arms only when REPO is its own primary, and uninstall
  // unsets what install recorded — both sides of that git-config round trip
  // must hit this clone, never the checkout running the test.
  const clone=join(root,"clone");
  mkdirSync(join(clone,"runtime/bun/src"),{recursive:true});
  mkdirSync(join(clone,"scripts"),{recursive:true});
  mkdirSync(join(clone,"skills/lead/references/ingest"),{recursive:true});
  mkdirSync(join(clone,"githooks"),{recursive:true});
  writeFileSync(join(clone,"skills/lead/references/ingest/README.md"),readFileSync(join(repo,"skills/lead/references/ingest/README.md")));
  writeFileSync(join(clone,"githooks/.gitattributes"),"pre-push tap-hooks\n");
  writeFileSync(join(clone,"githooks/pre-push"),"#!/bin/sh\nexit 0\n",{mode:0o755});
  for(const f of ["install.sh"])writeFileSync(join(clone,f),readFileSync(join(repo,f)));
  mkdirSync(join(clone,"bin"),{recursive:true});
  writeFileSync(join(clone,"bin/tap"),readFileSync(join(repo,"bin/tap")),{
mode:0o755});
  cpSync(join(repo,"hooks"),join(clone,"hooks"),{recursive:true});
  cpSync(join(repo,"vendor"),join(clone,"vendor"),{recursive:true});
  cpSync(join(repo,"skills"),join(clone,"skills"),{recursive:true});
  for(const path of ["plugins",".claude-plugin"])cpSync(join(repo,path),join(clone,path),{recursive:true});
  for(const f of ["config-file","config-error","skill-policy","install-harness-state","install-skill-links","install-skill-plugin","install-roster-hook-cleanup","install-manifest","codex-fence","install-fzf","fzf-tool","install-hooks","install-history","watch-detect","lossless-json","pyint","spool-publication","fsatomic","panelock","remind-lock","unicode-decimal"])writeFileSync(join(clone,"runtime/bun/src",f+".ts"),readFileSync(join(repo,"runtime/bun/src",f+".ts")));
  Bun.spawnSync(["git","init","-q",clone]);
  // install.sh arms only TRACKED tap-hooks files; the index is enough, no commit needed.
  Bun.spawnSync(["git","-C",clone,"add","githooks"]);
  // Observe, don't compare: a forwarding git shim logs every invocation made by
  // this test's process tree (install.sh children and the in-process uninstall)
  // so the proof is "no git-config write targeted anything but the clone" —
  // immune to unrelated smokes writing the shared checkout (tap-d59gd), and
  // unlike manifest paths it also catches an unrecorded write.
  const realGit=Bun.which("git")!;
  const gitTrace=join(root,"git-trace.log");
  mkdirSync(join(root,"shim"));
  writeFileSync(join(root,"shim/git"),`#!/bin/bash\n{ printf '%s' "$PWD"; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\n'; } >> "${gitTrace}"\nexec "${realGit}" "$@"\n`,{mode:0o755});
  process.env.PATH=join(root,"shim")+":"+process.env.PATH;
  // Bun resolves the command's PATH once at startup, so the shim cannot see the
  // in-process uninstall; observe that side through the spawn seam itself.
  const inProcess: string[][] = [];
  const realSpawnSync = Bun.spawnSync.bind(Bun);
  const spawnSpy = spyOn(Bun, "spawnSync").mockImplementation(((cmd: any, ...rest: any[]) => {
    const argv = Array.isArray(cmd) ? cmd : cmd.cmd;
    if (argv?.[0] === "git") inProcess.push([process.cwd(), ...argv.slice(1)]);
    return (realSpawnSync as any)(cmd, ...rest);
  }) as any);
  restores.push(()=>spawnSpy.mockRestore());
  const cloneHooksPath=join(realpathSync(clone),"githooks");
  nativePlugins();
  const vars=["CLAUDE","CODEX","HERMES","CURSOR","OPENCODE","GEMINI","CURSOR_AGENT","AGENTS"];
  for(const name of vars){const path=join(root,name);mkdirSync(path);process.env[`TAP_${name}_HOME`]=path;}
  process.env.TAP_INSTALL_BIN=join(root,"bin");
  process.env.PATH=process.env.TAP_INSTALL_BIN+":"+process.env.PATH;
  const settings=join(process.env.TAP_CLAUDE_HOME!,"settings.json");writeFileSync(settings,'{"personal": true}');
  const install=()=>Bun.spawnSync(["bash",join(clone,"install.sh")],{env:process.env,stdin:"ignore"});
  const result=install();
  expect({code:result.exitCode,stderr:result.stderr.toString()}).toEqual({code:0,stderr:expect.any(String)});
  expect(result.stdout.toString()).toContain("set core.hooksPath=");
  expect(Bun.spawnSync(["git","-C",clone,"config","--local","core.hooksPath"]).stdout.toString().trim()).toBe(cloneHooksPath);
  expect(result.stdout.toString()).not.toContain("Default effort");
  const links=[join(process.env.TAP_INSTALL_BIN!,"tap"),join(process.env.TAP_HERMES_HOME!,"skills/tap")];
  const identities=links.map(p=>lstatSync(p).ino);
  expect(install().exitCode).toBe(0);
  expect(links.map(p=>lstatSync(p).ino)).toEqual(identities);
  const path=join(process.env.TAP_INDEX_HOME!,"install-manifest.json");
  const manifest=JSON.parse(readFileSync(path,"utf8"));
  expect(manifest.repo).toBe(realpathSync(clone));
  expect(manifest.entries.find((e:any)=>e.kind==="git-config"&&e.path===realpathSync(clone)).value).toBe(cloneHooksPath);
  expect(manifest.entries.filter((e:any)=>e.kind==="git-config").map((e:any)=>e.path)).toEqual([realpathSync(clone)]);
  expect(manifest.entries.find((e:any)=>e.kind==="hook"&&e.path===settings).created_containers.hooks).toBe(true);
  for(const kind of ["symlink","hook","block","json-key","file"])expect(manifest.entries.some((e:any)=>e.kind===kind)).toBe(true);
   const shim=join(process.env.TAP_OPENCODE_HOME!,"plugins/tap-session-context");
   const expectedShim=`#!/usr/bin/env bash\nexec bun "${join(realpathSync(clone),"runtime/bun/src/session-start.ts")}" "$@"\n`;
   expect(manifest.entries.find((e:any)=>e.kind==="file"&&e.path===shim)).toEqual({kind:"file",path:shim,sha256:new Bun.CryptoHasher("sha256").update(expectedShim).digest("hex")});
  // A mutated shim is unrecorded (so uninstall reports it preserved); the
  // installer's exact bytes are recorded again. --scan reads the manifest the
  // install itself wrote, so repo/targets come from the real recorder.
  const scan=()=>JSON.parse(Bun.spawnSync([Bun.which("bun")!,join(repo,"runtime/bun/src/install-manifest.ts"),"--scan"],{env:{...process.env,TAP_INSTALL_MANIFEST:path}}).stdout.toString()) as {path:string}[];
  const shimBytes=readFileSync(shim);
  writeFileSync(shim,shimBytes+"\n");
  expect(scan().some((e:any)=>e.path===shim)).toBe(false);
  writeFileSync(shim,shimBytes);
  expect(scan().some((e:any)=>e.path===shim)).toBe(true);
 const removed=manifest.entries.find((e:any)=>e.kind==="symlink"&&e.path.endsWith("/bin/tap"));
 expect(removed).toBeDefined();
 manifest.entries=manifest.entries.filter((e:any)=>e!==removed);writeFileSync(path,JSON.stringify(manifest));
 const output:string[]=[];const log=console.log;console.log=(...v)=>output.push(v.join(" "));
 try{expect(await uninstallMachine(answers(["y","keep"]))).toBe(0);}finally{console.log=log;}
 expect(output.join("\n")).toContain(`Unrecorded TAP artifact (preserved): ${removed.path}`);
 expect(existsSync(removed.path)).toBe(true);
 expect(JSON.parse(readFileSync(settings,"utf8"))).toEqual({personal:true});
 // The round trip touched the clone's guard, never the checkout running the
 // test. The proof is this process's own record, not a comparison of the real
 // checkout's git config: at -j N another smoke may legitimately install into
 // that checkout between two reads (tap-d59gd).
 expect(Bun.spawnSync(["git","-C",clone,"config","--local","core.hooksPath"]).exitCode).toBe(1);
 expect([...output.join("\n").matchAll(/^unset core\.hooksPath in: (.+)$/gm)].map(m=>m[1])).toEqual([realpathSync(clone)]);
 // tap-2ikzv: the first call must drain the manifest completely. A preserved
 // entry here (a spawn-backed removal that flaked under load, say) used to
 // surface only as the second call's unexpected prompt; name the surviving
 // state at the drain point instead.
 const drained=JSON.parse(readFileSync(path,"utf8")) as {entries:unknown[];historyPending?:boolean};
 expect({entries:drained.entries,historyPending:drained.historyPending}).toEqual({entries:[],historyPending:false});
 const again:string[]=[];const nextLog=console.log;console.log=(...v)=>again.push(v.join(" "));
 try{expect(await uninstallMachine(answers([]))).toBe(0);}finally{console.log=nextLog;}
 expect(again.join("\n")).toContain("Nothing to uninstall: all recorded artifacts already removed");
 expect(existsSync(shim)).toBe(false);
 const cloneReal=realpathSync(clone);
 // Fail closed: a config-bearing invocation whose target cannot be read off
 // plainly (--git-dir, --work-tree, GIT_DIR-style redirects) counts as a write
 // to "unresolved". Leading global options (--no-pager, -c k=v, -C dir) are
 // skipped so they cannot hide the subcommand.
 const KEY = "core.hooksPath";
 const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, n) => x === b[n]);
 const writes=[...readFileSync(gitTrace,"utf8").split("\n").filter(Boolean).map(l=>l.split("\x1f")),...inProcess].flatMap(([cwd,...args]): string[] => {
  let dir: string = cwd ?? "", unresolved = false, i = 0, sub = "";
  for (; i < args.length; i++) {
   const a = args[i] ?? "";
   if (a === "-C") { dir = resolve(dir, args[++i] ?? ""); continue; }
   if (a === "-c") { i++; continue; }
   if (/^--(git-dir|work-tree|namespace|super-prefix|config-env)\b/.test(a) || a === "--exec-path") { unresolved = true; if (!a.includes("=")) i++; continue; }
   if (a.startsWith("-")) continue;
   sub = a; break;
  }
  if (sub !== "config") return args.includes("config") && unresolved ? ["<unresolved>"] : [];
  // Allowlist, not a flag heuristic: this fixture only ever reads, sets or unsets
  // the local guard key, so any other config-bearing shape is itself a finding.
  const rest = args.slice(i + 1);
  if (same(rest, ["--local", "--get", KEY]) || same(rest, ["--local", KEY])) return [];
  const setUnset = same(rest, ["--local", "--unset", KEY]) || (rest.length === 3 && same(rest.slice(0, 2), ["--local", KEY]));
  if (!setUnset || unresolved) return [`<unexpected config: ${rest.join(" ")}>`];
  return [realpathSync(dir)];
 });
 // Positive: the shim saw both the installer's set and the uninstall's unset,
 // so an empty or clone-only log cannot be a bypassed shim or spy.
 expect(writes.length).toBeGreaterThanOrEqual(2);
 expect([...new Set(writes)]).toEqual([cloneReal]);
},30000);

test("no supported CLI leaves config untouched",async()=>{
 fixture();
 expect(await setupMachine(answers([]),[])).toBe(0);
 expect(existsSync(join(process.env.XDG_CONFIG_HOME!,"tap/config.toml"))).toBe(false);
});
test("the terminal wizard prints the startup file and each alias line before asking to write them",async()=>{
 fixture();
 const events:string[]=[];
 const log=spyOn(console,"log").mockImplementation(value=>{events.push(`log:${value}`);});
 restores.push(()=>log.mockRestore());
 expect(await setupMachine(async question=>{
   events.push(`ask:${question}`);
   if(question.includes("keep it simple"))return "simple";
   if(question.includes("Default effort"))return "default";
   if(question.includes("Add shell aliases"))return "n";
   return "";
 },["codex"])).toBe(0);
 const rc=join(process.env.HOME!,".zshrc");
 const asked=events.findIndex(event=>event.startsWith("ask:Add shell aliases?"));
 const shown=events.findIndex(event=>event.startsWith("log:Would add the managed TAP shell block") && event.includes("  alias astra='tap_launch astra'"));
 expect(asked).toBeGreaterThan(-1);expect(shown).toBeGreaterThan(-1);expect(shown).toBeLessThan(asked);
 expect(events[shown]).toContain(rc);
 // Declined after the preview: nothing was written.
 expect(existsSync(rc)).toBe(false);
});
test("a starter picked from the list is asked about effort, and simple on a harness without starters says so",async()=>{
 fixture();
 const questions:string[]=[], output:string[]=[];
 const log=spyOn(console,"log").mockImplementation(value=>{output.push(String(value));});
 restores.push(()=>log.mockRestore());
 expect(await setupMachine(async question=>{
   questions.push(question);
   if(question.startsWith("claude: keep it simple"))return "choose";
   if(question.startsWith("Select preset numbers"))return output.find(line=>/^\d+\. opus:/.test(line))!.split(".")[0]!;
   if(question.startsWith("opencode: keep it simple"))return "simple";
   if(question.includes("Default effort"))return "default";
   if(question.startsWith("Add shell"))return "n";
   return "";
 },["claude","opencode"])).toBe(0);
 expect(questions.some(q=>q.includes("Default effort"))).toBe(true);
 expect(output.some(line=>line.startsWith("opencode has no starter presets"))).toBe(true);
 const {presets}=Bun.TOML.parse(readFileSync(join(process.env.XDG_CONFIG_HOME!,"tap/config.toml"),"utf8")) as any;
 expect(Object.keys(presets)).toEqual(["opus"]);
 expect(presets.opus.params).toEqual({model:"opus[1m]"});
});
test("a startup file setup cannot manage withdraws the shell offer and the rest of setup completes",async()=>{
 const root=fixture(), rc=join(process.env.HOME!,".zshrc"), real=join(root,"dotfiles-zshrc");
 writeFileSync(real,"# managed elsewhere\n");symlinkSync(real,rc);
 const questions:string[]=[], output:string[]=[];
 const log=spyOn(console,"log").mockImplementation(value=>{output.push(String(value));});
 restores.push(()=>log.mockRestore());
 expect(await setupMachine(async question=>{
   questions.push(question);
   if(question.includes("keep it simple"))return "skip";
   return "";
 },["codex"])).toBe(0);
 expect(questions.some(q=>q.startsWith("Add shell"))).toBe(false);
 expect(output.some(line=>line.startsWith("Shell integration is unavailable") && line.includes("not a regular file"))).toBe(true);
 expect(readFileSync(real,"utf8")).toBe("# managed elsewhere\n");
 expect((Bun.TOML.parse(readFileSync(join(process.env.XDG_CONFIG_HOME!,"tap/config.toml"),"utf8")) as any).harness.codex.permissions).toBe("auto");
});
test("skip-all still configures permissions and shell integration without effort or plugins by default",async()=>{
 fixture();
 const questions:string[]=[], output:string[]=[];
 const log=spyOn(console,"log").mockImplementation(value=>output.push(String(value)));
 restores.push(()=>log.mockRestore());
 expect(await setupMachine(async question=>{
   questions.push(question);
   if(question.includes("keep it simple"))return "skip";
   return "";
 },["codex"])).toBe(0);
 const path=join(process.env.XDG_CONFIG_HOME!,"tap/config.toml");
 expect(Bun.TOML.parse(readFileSync(path,"utf8"))).toEqual({version:3,harness:{codex:{permissions:"auto",env:{PONYTAIL_DEFAULT_MODE:"off"}}},skills:{full_kit:false}});
 expect(questions.some(q=>q.includes("effort"))).toBe(false);
 expect(questions.filter(q=>q.startsWith("Install ")).every(q=>q.includes("[y/N]"))).toBe(true);
 const rc=readFileSync(join(process.env.HOME!,".zshrc"),"utf8");
 expect(rc).toContain("compinit");
 expect(rc).not.toContain("alias astra=");
 // No presets chosen: the receipt names what the block holds and claims no aliases.
 const receipt=output.find(line=>line.startsWith("Wrote the TAP shell block to"))!;
 expect(receipt).toContain("zsh completion, tap_launch helper");
 expect(receipt).not.toContain("alias");
 expect(output.join("\n")).not.toContain("Added shell aliases");
 expect(output.some(line=>line.includes("tap launch codex <name>"))).toBe(true);
 expect(output.join("\n")).not.toContain("launch undefined");
 expect(output.at(-1)).toContain("Tip: if you need more time, type WAIT (in caps)");
});
test("skip-all retains distinct permissions and unrelated config bytes without importing the catalog",async()=>{
 fixture(); const dir=join(process.env.XDG_CONFIG_HOME!,"tap");mkdirSync(dir);
 const path=join(dir,"config.toml");
 const original='# personal comment\nversion = 3\n[notifications]\nnotifier = "system" # keep\n[presets.mine]\nharness="codex"\n[harness.codex]\npermissions = "auto" # reviewed\n[harness.claude]\npermissions = "bypass" # my choice\n';
 writeFileSync(path,original);
 expect(await setupMachine(async question=>question.includes("keep it simple")?"skip":question.startsWith("Add shell")?"n":"",["claude","codex"])).toBe(0);
 expect(readFileSync(path,"utf8")).toBe(original);
});
test("permission-only edit preserves comments and presets and backs up original bytes",async()=>{
 fixture(); const dir=join(process.env.XDG_CONFIG_HOME!,"tap");mkdirSync(dir);
 const path=join(dir,"config.toml");
 const original='# personal\nversion=3\n[skills]\nfull_kit=true\n[presets.mine]\nharness="codex"\n[harness.codex]\npermissions = "bypass" # deliberate\n[notifications]\nnotifier="system"\n';
 writeFileSync(path,original);
 expect(await setupMachine(answers(["","","skip","auto","y","n","","",""]),["codex"])).toBe(0);
 expect(readFileSync(path,"utf8")).toBe(original.replace('permissions = "bypass"','permissions = "auto"'));
 const backups=Array.from(new Bun.Glob("config.toml.backup-*").scanSync(dir));
 expect(backups).toHaveLength(1);
 expect(readFileSync(join(dir,backups[0]!),"utf8")).toBe(original);
});
test("malformed existing config refuses before any question or write",async()=>{
 fixture(); const dir=join(process.env.XDG_CONFIG_HOME!,"tap");mkdirSync(dir);
 const path=join(dir,"config.toml");writeFileSync(path,'[broken');
 expect(await setupMachine(answers([]),["codex"])).toBe(2);
 expect(readFileSync(path,"utf8")).toBe('[broken');
 expect(existsSync(join(dir,"config.candidate.toml"))).toBe(false);
});
test("a preset addition preserves an existing starter and unrelated bytes",async()=>{
 fixture(); const dir=join(process.env.XDG_CONFIG_HOME!,"tap");mkdirSync(dir);
 const path=join(dir,"config.toml");
 const original='# personal\nversion=3\n[presets.astra]\nharness="codex"\nparams.model="custom" # retain\n[harness.codex]\npermissions="auto"\n[notifications]\nnotifier="system"\n';
 writeFileSync(path,original);
 expect(await setupMachine(answers(["","","simple","medium","","y","n","","",""]),["codex"])).toBe(0);
 const updated=readFileSync(path,"utf8"), parsed=Bun.TOML.parse(updated) as any;
 expect(updated.startsWith(original)).toBe(true);
 expect(parsed.presets.astra.params.model).toBe("custom");
 expect(Object.keys(parsed.presets).sort()).toEqual(["astra","luna","sol"]);
 expect(parsed.roles).toBeUndefined();
});
test("wizard refuses an edit made while questions were open",async()=>{
 fixture(); const dir=join(process.env.XDG_CONFIG_HOME!,"tap");mkdirSync(dir);
 const path=join(dir,"config.toml");writeFileSync(path,"version=3\n");
 const edited="version=3\n# concurrent user edit\n";
 expect(await setupMachine(async question=>{
   if(question.startsWith("The first time TAP is used")||question.startsWith("How should agents' messages reach you"))return "";
   if(question.includes("keep it simple"))return "skip";
   if(question.startsWith("codex:"))return "auto";
   if(question.startsWith("Install the optional full"))return "y";if(question.startsWith("Notifier ["))return "";
   if(question.startsWith("Update existing")){writeFileSync(path,edited);return "y";}
   if(question.startsWith("Add shell")||question.startsWith("Install "))return "n";
   throw new Error(`unexpected prompt ${question}`);
 },["codex"])).toBe(2);
 expect(readFileSync(path,"utf8")).toBe(edited);
 expect(Array.from(new Bun.Glob("config.toml.backup-*").scanSync(dir))).toHaveLength(0);
});
for (const version of ["1","1.0","true"]) test(`retired catalog ${version} refuses before questions and preserves bytes`,async()=>{
 fixture(); const dir=join(process.env.XDG_CONFIG_HOME!,"tap");mkdirSync(dir);
 const path=join(dir,"config.toml"),original=`version=${version}\n# legacy settings\n`;
 writeFileSync(path,original);
 expect(await setupMachine(answers([]),["codex"])).toBe(2);
 expect(readFileSync(path,"utf8")).toBe(original);
 expect(existsSync(join(dir,"config.candidate.toml"))).toBe(false);
});
test("FIFO config refuses before opening it",()=>{
 fixture(); const dir=join(process.env.XDG_CONFIG_HOME!,"tap");mkdirSync(dir);
 const path=join(dir,"config.toml");
 expect(Bun.spawnSync(["mkfifo",path]).exitCode).toBe(0);
 const module=join(repo,"runtime/bun/src/verbs/machine.ts");
 const result=Bun.spawnSync([process.execPath,"-e",`import {setupMachine} from ${JSON.stringify(module)}; process.exit(await setupMachine(async()=>{throw new Error("unexpected prompt")},["codex"]));`],{env:process.env,timeout:2000});
 expect(result.exitCode).toBe(2);
 expect(result.stderr.toString()).toContain("not a regular file");
 expect(lstatSync(path).isFIFO()).toBe(true);
});
test("existing Ponytail preference survives a permission change",async()=>{
 fixture(); const dir=join(process.env.XDG_CONFIG_HOME!,"tap");mkdirSync(dir);
 const path=join(dir,"config.toml");
 const original='version=3\n[skills]\nfull_kit=true\n[harness.codex]\npermissions="bypass"\nenv.PONYTAIL_DEFAULT_MODE="lite" # personal\n';
 writeFileSync(path,original);
 expect(await setupMachine(answers(["","","skip","auto","y","n","","",""]),["codex"])).toBe(0);
 expect(readFileSync(path,"utf8")).toBe(original.replace('permissions="bypass"','permissions="auto"'));
});
test("archive verifies contents before removing every enrolled history root",async()=>{
 const root=fixture(),team=join(root,"team");mkdirSync(join(team,".tap"),{recursive:true});
 writeFileSync(join(team,".tap","message.md"),"retained message");
 writeFileSync(join(process.env.TAP_INDEX_HOME!,"global-registry.json"),JSON.stringify({schema:"0.20",teams:{one:{root:team}}}));
 const artifact=join(root,"installed");writeFileSync(artifact,"unused");
 writeFileSync(join(process.env.TAP_INDEX_HOME!,"install-manifest.json"),JSON.stringify({version:1,repo,entries:[{kind:"file",path:join(root,"missing"),sha256:"none"}]}));
 expect(await uninstallMachine(answers(["yes","archive"]))).toBe(0);
 expect(existsSync(join(team,".tap"))).toBe(false);
 expect(existsSync(process.env.TAP_INDEX_HOME!)).toBe(false);
 const archives=Array.from(new Bun.Glob("tap-history-*.tar.gz").scanSync(process.env.HOME!));expect(archives).toHaveLength(1);
 const r=Bun.spawnSync(["tar","-xOf",join(process.env.HOME!,archives[0]!),join(team,".tap/message.md").slice(1)]);
 expect(r.exitCode).toBe(0);expect(r.stdout.toString()).toBe("retained message");
});

test("a failed archive verification leaves every history root in place",()=>{
 const root=fixture(),team=join(root,"team");mkdirSync(join(team,".tap"),{recursive:true});
 writeFileSync(join(team,".tap","message.md"),"retained message");
 const archive=join(root,"tap-history-corrupt.tar.gz");
 // The injected writer produces bytes no tar can read back — the archive step
 // fails at verification, and removal never runs.
 expect(()=>archiveHistory(archive,[team],(a,rs)=>writeFileSync(a,"not a tar archive"))).toThrow(/does not read back/);
 expect(existsSync(archive)).toBe(true);
 expect(existsSync(join(team,".tap","message.md"))).toBe(true);
 expect(readFileSync(join(team,".tap","message.md"),"utf8")).toBe("retained message");
});

test("a history root changed mid-archive fails verification and preserves the originals",()=>{
 const root=fixture(),team=join(root,"team");mkdirSync(join(team,".tap"),{recursive:true});
 const message=join(team,".tap","message.md");
 writeFileSync(message,"retained message");
 const archive=join(root,"tap-history-changed.tar.gz");
 // The real archiver runs, but the source mutates inside the injection seam —
 // exactly the mid-flight change the double inventory exists to catch.
 expect(()=>archiveHistory(archive,[team],(a,rs)=>{writeTarGz(a,rs);writeFileSync(message,"mutated after the inventory");})).toThrow(/history changed or archive verification failed/);
 expect(existsSync(archive)).toBe(true);
 expect(readFileSync(message,"utf8")).toBe("mutated after the inventory");
});

test("history discovery refuses replacement-decodable machine-index bytes",()=>{
 const root=fixture();
 writeFileSync(join(process.env.TAP_INDEX_HOME!,"global-registry.json"),Buffer.concat([
  Buffer.from('{"schema":"0.20","teams":{},"oth'),Buffer.from([0xe9]),Buffer.from('er":1}')
 ]));
 expect(()=>historyPaths()).toThrow();
 expect(existsSync(root)).toBe(true);
});


test("a later installer refusal retains records of completed writes",()=>{
 const root=fixture();
 for(const name of ["CLAUDE","CODEX","HERMES","CURSOR","OPENCODE","GEMINI","CURSOR_AGENT","AGENTS"]){const path=join(root,name);mkdirSync(path);process.env[`TAP_${name}_HOME`]=path;}
 process.env.TAP_INSTALL_BIN=join(root,"bin");process.env.PATH=process.env.TAP_INSTALL_BIN+":"+process.env.PATH;
 // An unmatched owned marker refuses after bin/skill links and AGENTS were written.
 const config=join(process.env.TAP_CODEX_HOME!,"config.toml");
 writeFileSync(config,"# tap-managed:begin Codex SessionStart\n[personal]\nvalue = true\n");
 const result=Bun.spawnSync(["bash",join(repo,"install.sh")],{env:process.env,stdin:"ignore"});
 expect(result.exitCode).not.toBe(0);
 const manifest=JSON.parse(readFileSync(join(process.env.TAP_INDEX_HOME!,"install-manifest.json"),"utf8"));
 expect(manifest.entries.some((e:any)=>e.path===join(root,"bin/tap"))).toBe(true);
 expect(manifest.entries.some((e:any)=>e.path===join(process.env.TAP_CODEX_HOME!,"AGENTS.md"))).toBe(true);
 expect(manifest.entries.some((e:any)=>e.path===config)).toBe(false);
});

test("wizard limits permission settings to enforced harnesses and preserves existing mode",async()=>{
 fixture();
 // Cursor and AGY are asked (tap-6c1me): an empty answer takes the displayed auto default.
 expect(await setupMachine(answers(["","","simple","simple","simple","","bypass","n"]),["cursor","agy","opencode"])).toBe(0);
 const path=join(process.env.XDG_CONFIG_HOME!,"tap/config.toml");
 let config=Bun.TOML.parse(readFileSync(path,"utf8")) as any;
 expect(config.harness?.cursor?.permissions).toBe("auto");
 expect(config.harness?.agy?.permissions).toBe("bypass");
 expect(config.harness?.opencode?.permissions).toBeUndefined();
 writeFileSync(path,'version=3\n[harness.codex]\npermissions="auto"\n');
 expect(await setupMachine(answers(["","","simple","high","","yes","n","n","n","n"]),["codex"])).toBe(0);
 config=Bun.TOML.parse(readFileSync(path,"utf8")) as any;
 expect(config.harness.codex.permissions).toBe("auto");
});
test("PTY Ctrl-C before all choices preserves the original config",()=>{
 const root=fixture(),bin=join(root,"tools");mkdirSync(bin);
 for(const name of ["bash","bun","dirname","readlink"])symlinkSync(Bun.which(name)!,join(bin,name));
 writeFileSync(join(bin,"codex"),"#!/bin/sh\nexit 0\n",{mode:0o755});
 const result=Bun.spawnSync([Bun.which("python3")!,"-c",String.raw`
import os, pty, select, subprocess, sys, time
master,slave=pty.openpty()
p=subprocess.Popen([sys.argv[1],'setup','--machine'],stdin=slave,stdout=slave,stderr=slave,env=dict(os.environ,PATH=sys.argv[2]))
os.close(slave)
output=b''
skipped=set()
def until(needle):
    global output
    end=time.monotonic()+8
    while needle not in output:
        if time.monotonic()>end: raise AssertionError(output.decode(errors='replace'))
        if select.select([master],[],[],.1)[0]: output+=os.read(master,65536)
        for harness in ('claude','cursor','opencode','agy'):
            prompt=(harness+': keep it simple, choose myself, or skip?').encode()
            if harness not in skipped and prompt in output:
                os.write(master,b'skip\n');skipped.add(harness)
try:
    for prompt,answer in [(b'The first time TAP is used',b'\n'),(b"How should agents' messages reach you",b'\n'),(b'codex: keep it simple',b'simple\n'),(b'Default effort',b'high\n'),(b'Permission mode [',b'\n'),(b'Install the optional full',b'y\n'),(b'Notifier [',b'\n')]:
        until(prompt); os.write(master,answer)
    until(b'Add shell aliases?')
    os.write(master,b'\x03')
    until(b'next: tap help setup')
    assert p.wait(timeout=5)==2,output
    print(output.decode(errors='replace'))
finally:
    if p.poll() is None: p.kill();p.wait()
    os.close(master)
`,join(repo,"bin/tap"),bin],{env:process.env});
 expect({code:result.exitCode,stderr:result.stderr.toString()}).toEqual({code:0,stderr:""});
 expect(result.stdout.toString()).toContain("no setup effects applied");
 expect(existsSync(join(process.env.XDG_CONFIG_HOME!,"tap/config.toml"))).toBe(false);
},15000);

test("wizard ends when its terminal dies instead of spinning on the dead pty",()=>{
 const root=fixture(),bin=join(root,"tools");mkdirSync(bin);
 for(const name of ["bash","bun","dirname","readlink"])symlinkSync(Bun.which(name)!,join(bin,name));
 writeFileSync(join(bin,"codex"),"#!/bin/sh\nexit 0\n",{mode:0o755});
 // A pty that is not a controlling terminal: closing the master gives the
 // wizard EIO/EOF with no SIGHUP — the tap-ryhno orphan shape. It must exit.
 const result=Bun.spawnSync([Bun.which("python3")!,"-c",String.raw`
import os, pty, select, subprocess, sys, time
master,slave=pty.openpty()
p=subprocess.Popen([sys.argv[1],'setup','--machine'],stdin=slave,stdout=slave,stderr=slave,env=dict(os.environ,PATH=sys.argv[2]))
os.close(slave)
output=b''
def until(needle):
    global output
    end=time.monotonic()+10
    while needle not in output:
        if time.monotonic()>end: raise AssertionError(output.decode(errors='replace'))
        if select.select([master],[],[],.1)[0]: output+=os.read(master,65536)
try:
    until(b'The first time TAP is used')
    os.close(master)
    code=p.wait(timeout=10)
    print('EXIT',code)
    # Not 2: printing the refusal to the dead pty throws EIO and masks the
    # abort's exit; the contract is a prompt nonzero exit with no effects.
    assert code!=0, code
finally:
    if p.poll() is None: p.kill();p.wait()
`,join(repo,"bin/tap"),bin],{env:process.env,timeout:30000});
 expect(result.exitCode,result.stderr.toString()).toBe(0);
 expect(result.stdout.toString(),result.stderr.toString()).toContain("EXIT ");
 expect(existsSync(join(process.env.XDG_CONFIG_HOME!,"tap/config.toml"))).toBe(false);
},30000);

test("malformed Gemini hooks do not abort install or hide readable manifest entries",()=>{
 const root=fixture();
 for(const name of ["CLAUDE","CODEX","HERMES","CURSOR","OPENCODE","GEMINI","CURSOR_AGENT","AGENTS"]){const path=join(root,name);mkdirSync(path);process.env[`TAP_${name}_HOME`]=path;}
 process.env.TAP_INSTALL_BIN=join(root,"bin");process.env.PATH=process.env.TAP_INSTALL_BIN+":"+process.env.PATH;
 const hooks=join(process.env.TAP_GEMINI_HOME!,"config/hooks.json");mkdirSync(join(process.env.TAP_GEMINI_HOME!,"config"));writeFileSync(hooks,"{broken");
 const result=Bun.spawnSync(["bash",join(repo,"install.sh")],{env:process.env,stdin:"ignore"});
 expect({code:result.exitCode,stderr:result.stderr.toString()}).toEqual({code:0,stderr:expect.any(String)});
 expect(result.stderr.toString()).toContain("cannot wire Antigravity tmux guard into invalid");
 expect(result.stderr.toString()).toContain(`manifest skipped ${hooks}`);
 expect(result.stderr.toString()).not.toContain("Traceback");
 expect(readFileSync(hooks,"utf8")).toBe("{broken");
 const path=join(process.env.TAP_INDEX_HOME!,"install-manifest.json");
 const manifest=JSON.parse(readFileSync(path,"utf8"));
 expect(manifest.entries.some((e:any)=>e.path===join(root,"bin/tap"))).toBe(true);
 expect(manifest.entries.some((e:any)=>e.path===join(process.env.TAP_CODEX_HOME!,"AGENTS.md"))).toBe(true);
 // A corrupt manifest preserves its bytes and refuses the required skill writer.
 writeFileSync(path,"{truncated");
 const rerun=Bun.spawnSync(["bash",join(repo,"install.sh")],{env:process.env,stdin:"ignore"});
 expect(rerun.exitCode).toBe(1);
 expect(rerun.stderr.toString()).toContain("preserve it and inspect before rerunning ./install.sh");
 expect(rerun.stderr.toString()).not.toContain("Traceback");
 expect(readFileSync(path,"utf8")).toBe("{truncated");
});

test("first install completes wizard before final PATH remedy and records shell PATH",()=>{
 const root=fixture(),tools=join(root,"tools");mkdirSync(tools);
 for(const name of ["bash","bun","python3","git","jq","tmux","tar","dirname","readlink","mkdir","ln","cp","mv","rmdir","chmod","grep","rm","sed","date","id","mktemp","cat","uname","find","tr","head","tail"]) {
  const binary=Bun.which(name);if(binary)symlinkSync(binary,join(tools,name));
 }
 for(const name of ["codex","open"])writeFileSync(join(tools,name),"#!/bin/sh\nexit 0\n",{mode:0o755});
 for(const name of ["CLAUDE","CODEX","HERMES","CURSOR","OPENCODE","GEMINI","CURSOR_AGENT","AGENTS"]){const path=join(root,name);mkdirSync(path);process.env[`TAP_${name}_HOME`]=path;}
 process.env.TAP_INSTALL_BIN=join(root,"installed-bin");
 const shell=join(process.env.HOME!,".zshrc");writeFileSync(shell,"# personal settings\n");
 const result=Bun.spawnSync([Bun.which("python3")!,"-c",String.raw`
import os, pty, select, subprocess, sys, time
master,slave=pty.openpty()
p=subprocess.Popen(['bash',sys.argv[1],'--setup'],stdin=slave,stdout=slave,stderr=slave,env=dict(os.environ,PATH=sys.argv[2]))
os.close(slave)
output=b''
skipped=set()
def until(needle):
    global output
    end=time.monotonic()+10
    while needle not in output:
        if time.monotonic()>end: raise AssertionError(output.decode(errors='replace'))
        if select.select([master],[],[],.1)[0]: output+=os.read(master,65536)
        for harness in ('claude','cursor','opencode','agy'):
            prompt=(harness+': keep it simple, choose myself, or skip?').encode()
            if harness not in skipped and prompt in output:
                os.write(master,b'skip\n');skipped.add(harness)
try:
    prompts=[(b'The first time TAP is used',b'\n'),(b"How should agents' messages reach you",b'\n'),(b'codex: keep it simple',b'simple\n'),(b'Default effort',b'high\n'),(b'Permission mode [',b'\n'),(b'Install the optional full',b'y\n'),(b'Notifier [',b'\n'),(b'Add shell aliases?',b'y\n'),(b'Install ponytail for codex?',b'n\n'),(b'Install compound-engineering for codex?',b'n\n'),(b'Install superpowers for codex?',b'n\n'),(b'Install the TAP agent lookup keybinding (prefix C-g)? [Y/n] ',b'n\n'),(b'Install TAP tmux defaults (truecolor, mouse, scrolling, clipboard; plus a status bar if you have no tmux config yet)? [Y/n] ',b'n\n')]
    for prompt,answer in prompts: until(prompt);os.write(master,answer)
    until(b'run in this terminal: export PATH=')
    assert p.wait(timeout=5)==0,output
    print(output.decode(errors='replace'))
finally:
    if p.poll() is None: p.kill();p.wait()
    os.close(master)
`,join(repo,"install.sh"),tools],{env:process.env});
 expect({code:result.exitCode,stderr:result.stderr.toString()}).toEqual({code:0,stderr:""});
 const output=result.stdout.toString();expect(output).toContain("setup completed; config written");
 expect(output.lastIndexOf("run in this terminal: export PATH=")).toBeGreaterThan(output.lastIndexOf("Install superpowers"));
 expect(output).not.toContain("install: done");
 const manifest=JSON.parse(readFileSync(join(process.env.TAP_INDEX_HOME!,"install-manifest.json"),"utf8"));
 const block=manifest.entries.find((e:any)=>e.kind==="block"&&e.path===shell);expect(block).toBeDefined();
 expect(block.content).toContain("export PATH=");
 const sourced=Bun.spawnSync(["bash","-c",'. "$1"; test "${PATH%%:*}" = "$2" && test "$(command -v tap)" = "$2/tap"',"_",shell,process.env.TAP_INSTALL_BIN!],{env:process.env});expect(sourced.exitCode).toBe(0);
 removeEntry(block);expect(readFileSync(shell,"utf8")).toContain("# personal settings");
 expect(readFileSync(shell,"utf8")).not.toContain("export PATH=");
 },20000);

test("wizard Enter on the alias prompt takes the affirmative default",()=>{
 const root=fixture(),tools=join(root,"tools");mkdirSync(tools);
 for(const name of ["bash","bun","python3","git","jq","tmux","tar","dirname","readlink","mkdir","ln","cp","mv","rmdir","chmod","grep","rm","sed","date","id","mktemp","cat","uname","find","tr","head","tail"]) {
  const binary=Bun.which(name);if(binary)symlinkSync(binary,join(tools,name));
 }
 for(const name of ["codex","open"])writeFileSync(join(tools,name),"#!/bin/sh\nexit 0\n",{mode:0o755});
 for(const name of ["CLAUDE","CODEX","HERMES","CURSOR","OPENCODE","GEMINI","CURSOR_AGENT","AGENTS"]){const path=join(root,name);mkdirSync(path);process.env[`TAP_${name}_HOME`]=path;}
 process.env.TAP_INSTALL_BIN=join(root,"installed-bin");
 const shell=join(process.env.HOME!,".zshrc");writeFileSync(shell,"# personal settings\n");
 const result=Bun.spawnSync([Bun.which("python3")!,"-c",String.raw`
import os, pty, select, subprocess, sys, time
master,slave=pty.openpty()
p=subprocess.Popen(['bash',sys.argv[1],'--setup'],stdin=slave,stdout=slave,stderr=slave,env=dict(os.environ,PATH=sys.argv[2]))
os.close(slave)
output=b''
skipped=set()
def until(needle):
    global output
    end=time.monotonic()+10
    while needle not in output:
        if time.monotonic()>end: raise AssertionError(output.decode(errors='replace'))
        if select.select([master],[],[],.1)[0]: output+=os.read(master,65536)
        for harness in ('claude','cursor','opencode','agy'):
            prompt=(harness+': keep it simple, choose myself, or skip?').encode()
            if harness not in skipped and prompt in output:
                os.write(master,b'skip\n');skipped.add(harness)
try:
    prompts=[(b'The first time TAP is used',b'\n'),(b"How should agents' messages reach you",b'\n'),(b'codex: keep it simple',b'simple\n'),(b'Default effort',b'high\n'),(b'Permission mode [',b'\n'),(b'Install the optional full',b'y\n'),(b'Notifier [',b'\n'),(b'Add shell aliases?',b'\n'),(b'Install ponytail for codex?',b'n\n'),(b'Install compound-engineering for codex?',b'n\n'),(b'Install superpowers for codex?',b'n\n'),(b'Install the TAP agent lookup keybinding (prefix C-g)? [Y/n] ',b'n\n'),(b'Install TAP tmux defaults (truecolor, mouse, scrolling, clipboard; plus a status bar if you have no tmux config yet)? [Y/n] ',b'n\n')]
    for prompt,answer in prompts: until(prompt);os.write(master,answer)
    until(b'run in this terminal: export PATH=')
    assert p.wait(timeout=5)==0,output
    print(output.decode(errors='replace'))
finally:
    if p.poll() is None: p.kill();p.wait()
    os.close(master)
`,join(repo,"install.sh"),tools],{env:process.env});
 expect({code:result.exitCode,stderr:result.stderr.toString()}).toEqual({code:0,stderr:""});
 const output=result.stdout.toString();expect(output).toContain("setup completed; config written");
 expect(output).toContain("[Y/n]");
 expect(output).toContain("Wrote the TAP shell block to");
 expect(output).toContain("3 preset aliases");
 expect(readFileSync(shell,"utf8")).toContain("# >>> tap shell integration >>>");
},20000);

test("relative XDG root refuses before questions or config writes",async()=>{
 fixture();process.env.XDG_CONFIG_HOME="relative";
 await expect(setupMachine(answers([]),["codex"])).rejects.toThrow("XDG_CONFIG_HOME must be absolute");
});
test("owned alias blocks lose the obsolete python PATH line on upgrade",async()=>{
 fixture();
 const rc=join(process.env.HOME!,".zshrc");
 const begin="# >>> tap aliases >>>",end="# <<< tap aliases <<<";
 const brewLine="export PATH='/opt/homebrew/bin:/opt/homebrew/opt/python@3.11/libexec/bin':\"$PATH\"";
 const strippedLine="export PATH='/opt/homebrew/bin':\"$PATH\"";
 const tapLine='tap_launch() { local preset="$1" name="$1"; shift; if [ "$#" -gt 0 ] && [[ "$1" != -* ]]; then name="$name-$1"; shift; fi; tap session launch "$preset" "$name" "$@"; }';
 const blockContent=[begin,brewLine,tapLine,end].join("\n");
 writeFileSync(rc,`# personal settings\n${blockContent}\n`);
 writeFileSync(join(process.env.TAP_INDEX_HOME!,"install-manifest.json"),JSON.stringify({version:1,repo:"/repo",entries:[{kind:"block",path:rc,begin,end,content:blockContent}]}));
 const log:string[]=[];const orig=console.log;console.log=(m?:unknown)=>log.push(String(m));
 try{expect(await setupMachine(answers(["","","simple","high","bypass","y","n","n","n"]),["codex"])).toBe(0);}finally{console.log=orig;}
 const text=readFileSync(rc,"utf8");
 expect(text).not.toContain("python@3.11");
 expect(text).toContain(strippedLine);
 expect(text).toContain("compinit");
 expect(text).toContain("# personal settings");
 expect(log.join("\n")).toContain("Removed the obsolete python PATH line");
 const fpath=join(process.env.HOME!,".local","bin","..","share","zsh","site-functions");
 const completion=[`fpath=('${fpath}' $fpath)`,ZSH_COMPLETION_GUARD];
 const manifest=JSON.parse(readFileSync(join(process.env.TAP_INDEX_HOME!,"install-manifest.json"),"utf8"));
 expect(manifest.entries.find((e:any)=>e.kind==="block").content).toEqual([begin,...completion,strippedLine,tapLine,"alias astra='tap_launch astra'","alias luna='tap_launch luna'","alias sol='tap_launch sol'",end].join("\n"));
});
test("bash owned alias blocks lose the python PATH line without gaining zsh completion",async()=>{
 fixture();
 process.env.SHELL="/bin/bash";
 const rc=join(process.env.HOME!,".bashrc");
 const begin="# >>> tap aliases >>>",end="# <<< tap aliases <<<";
 const brewLine="export PATH='/usr/local/bin:/usr/local/opt/python@3.11/libexec/bin':\"$PATH\"";
 const strippedLine="export PATH='/usr/local/bin':\"$PATH\"";
 const tapLine='tap_launch() { local preset="$1" name="$1"; shift; if [ "$#" -gt 0 ] && [[ "$1" != -* ]]; then name="$name-$1"; shift; fi; tap session launch "$preset" "$name" "$@"; }';
 const blockContent=[begin,brewLine,tapLine,end].join("\n");
 writeFileSync(rc,`# personal settings\n${blockContent}\n`);
 writeFileSync(join(process.env.TAP_INDEX_HOME!,"install-manifest.json"),JSON.stringify({version:1,repo:"/repo",entries:[{kind:"block",path:rc,begin,end,content:blockContent}]}));
 const log:string[]=[];const orig=console.log;console.log=(m?:unknown)=>log.push(String(m));
 try{expect(await setupMachine(answers(["","","simple","high","bypass","y","n","n","n"]),["codex"])).toBe(0);}finally{console.log=orig;}
 const text=readFileSync(rc,"utf8");
 expect(text).not.toContain("python@3.11");
 expect(text).toContain(strippedLine);
 expect(text).not.toContain("compinit");
 expect(text).toContain("tap session launch");
 expect(log.join("\n")).toContain("Removed the obsolete python PATH line");
 const manifest=JSON.parse(readFileSync(join(process.env.TAP_INDEX_HOME!,"install-manifest.json"),"utf8"));
 expect(manifest.entries.find((e:any)=>e.kind==="block").content).toEqual([begin,strippedLine,tapLine,"alias astra='tap_launch astra'","alias luna='tap_launch luna'","alias sol='tap_launch sol'",end].join("\n"));
});
test("zsh block registers completion without a second compinit when one already ran",async()=>{
 const {home,rc}=await freshZshBlock();
 const log=join(home,"zsh.log");
 const fake=runZsh(home,`compdef(){ print -r -- "compdef $*" >>${q(log)}; }; compinit(){ print compinit >>${q(log)}; }; source ${q(rc)}`);
 expect({code:fake.exitCode,stderr:fake.stderr.toString()}).toEqual({code:0,stderr:""});
 expect(readFileSync(log,"utf8").trim().split("\n")).toEqual(["compdef _tap tap"]);
 // Real compinit ran BEFORE the block, so only the block's own registration can make `tap` complete.
 const real=runZsh(home,`autoload -Uz compinit; compinit -u -d ${q(join(home,".zd"))}; source ${q(rc)}; print -r -- "$_comps[tap]"`);
 expect({code:real.exitCode,out:real.stdout.toString().trim()}).toEqual({code:0,out:"_tap"});
});
test("zsh block runs compinit once when none ran, and completion works",async()=>{
 const {home,rc}=await freshZshBlock();
 const real=runZsh(home,`source ${q(rc)}; print -r -- "$_comps[tap]"`);
 expect({code:real.exitCode,out:real.stdout.toString().trim()}).toEqual({code:0,out:"_tap"});
});
test("unsupported login shells do not receive Bash or Zsh startup writes",async()=>{
 fixture();process.env.SHELL="/usr/local/bin/fish";
 expect(await setupMachine(answers(["","","simple","high","bypass","n","n","n"]),["codex"])).toBe(0);
 expect(existsSync(join(process.env.HOME!,".zshrc"))).toBe(false);
 expect(existsSync(join(process.env.HOME!,".bashrc"))).toBe(false);
});

test("wizard exit 2 still prints the final PATH remedy and leaves install nonzero",()=>{
 const root=fixture();
 for(const name of ["CLAUDE","CODEX","HERMES","CURSOR","OPENCODE","GEMINI","CURSOR_AGENT","AGENTS"]){const path=join(root,name);mkdirSync(path);process.env[`TAP_${name}_HOME`]=path;}
 process.env.TAP_INSTALL_BIN=join(root,"off-path-bin");
 const result=Bun.spawnSync(["bash",join(repo,"install.sh"),"--setup"],{env:process.env,stdin:"ignore"});
 expect(result.exitCode).not.toBe(0);
 expect(result.stderr.toString()).toContain("interactive terminal is required");
 expect(result.stderr.toString()).toContain("setup incomplete: rerun tap setup --machine");
 expect(result.stderr.toString()).toContain("run in this terminal: export PATH=");
 expect(result.stdout.toString()).not.toContain("install: done");
});

for (const harness of ["claude", "codex"]) for (const json of [false, true]) {
 test(`wizard auto note follows the choice for ${harness}, json=${json}`, async () => {
  fixture();
  const output: string[] = [], diagnostics: string[] = [];
  const stdout = spyOn(console, "log").mockImplementation((value) => { output.push(String(value)); });
  const stderr = spyOn(console, "error").mockImplementation((value) => { diagnostics.push(String(value)); });
  const note = "Note: Claude auto may require attention for the first TAP message; run `tap init` in the project first.";
  try {
   const reply = answers(["", "", "simple", "high", "auto", "n", "n", "n", "n"]);
   expect(await setupMachine(async question => {
    if (harness === "claude" && question.startsWith("Add shell aliases")) expect((json ? diagnostics : output)).toContain(note);
    return reply(question);
   }, [harness], json)).toBe(0);
   if (json) {
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toEqual({exit_code: 0, notes: harness === "claude" ? [note] : []});
   } else expect(output.filter(line => line === note)).toHaveLength(harness === "claude" ? 1 : 0);
  } finally { stdout.mockRestore(); stderr.mockRestore(); }
 });
}
test("wizard bypass JSON receipt has no auto note", async () => {
 fixture();
 const output: string[] = [];
 const stdout = spyOn(console, "log").mockImplementation(value => { output.push(String(value)); });
 const stderr = spyOn(console, "error").mockImplementation(() => {});
 try {
   expect(await setupMachine(answers(["", "", "simple", "high", "bypass", "n", "n", "n", "n"]), ["codex"], true)).toBe(0);
  expect(JSON.parse(output[0]!)).toEqual({exit_code: 0, notes: []});
 } finally { stdout.mockRestore(); stderr.mockRestore(); }
});

test("a preserved artifact's rerun advice names the clone's executable, which survives the first run",async()=>{
 const root=fixture(),edited=join(root,"edited");writeFileSync(edited,"user edit");
 writeFileSync(join(process.env.TAP_INDEX_HOME!,"install-manifest.json"),JSON.stringify({version:1,repo,entries:[{kind:"file",path:edited,sha256:"none"}]}));
 const run=await captured(()=>uninstallMachine(noPrompt,{yes:true,history:"archive"}));
 expect(run.result).toBe(2);
 expect(run.lines.at(-1)).toEndWith(`rerun '${repo}/bin/tap' uninstall`);
 expect(readFileSync(edited,"utf8")).toBe("user edit");
});
// tap-ad0hh: Claude's `marketplace remove --scope user` consumes the user-scope declaration and refuses
// (exit 1, "not declared in user settings") once it is gone. Whether the marketplace then stays listed is
// Claude's, not TAP's: another scope may declare it. Neither state may strand the archive.
for (const [label,stuck] of [["stays listed after the user-scope removal",false],["is already undeclared from an earlier interrupted run",true]] as const) {
 test(`uninstall archives when Claude's marketplace ${label}`,async()=>{
  const root=fixture();codexHomes(root);
  const settings=join(process.env.TAP_CLAUDE_HOME!,"settings.json");writeFileSync(settings,'{"theme": "dark"}\n');
  expect(runInstall().exitCode).toBe(0);
  const registry=join(process.env.TAP_CLAUDE_HOME!,".native-plugin-fixture.json"),data=JSON.parse(readFileSync(registry,"utf8"));
  expect(data.declared).toEqual({"tap-marketplace":true});
  if(stuck)data.declared={};else data.kept=["tap-marketplace"];
  writeFileSync(registry,JSON.stringify(data));
  const run=await captured(()=>uninstallMachine(noPrompt,{yes:true,history:"archive"}));
  expect(run.result).toBe(0);
  expect(run.lines.filter(l=>/^(preserved|Some installed)/.test(l))).toEqual([]);
  expect(run.lines.some(l=>l.startsWith("Verified history archive: "))).toBe(true);
  expect(Array.from(new Bun.Glob("tap-history-*.tar.gz").scanSync(process.env.HOME!))).toHaveLength(1);
  expect(existsSync(process.env.TAP_INDEX_HOME!)).toBe(false);
  expect(JSON.parse(readFileSync(settings,"utf8")).theme).toBe("dark");
  // The registry keeps what was never TAP's user-scope declaration.
  expect(Object.keys(JSON.parse(readFileSync(registry,"utf8")).markets)).toEqual(["tap-marketplace"]);
  // The retained listing still names the clone, so it is not offered for deletion.
  expect(run.lines.at(-1)).toContain(`Keep TAP's clone at ${repo}`);
  expect(run.lines.join("\n")).not.toContain("safe to delete");
 },60000);
}

test("uninstall prunes only recorded TAP-created containers and preserves user settings",()=>{
 const root=fixture(),path=join(root,"settings.json"),value={type:"command",command:"tap-hook"};
 for(const owned of [false,true]) {
  writeFileSync(path,JSON.stringify({theme:"dark",hooks:{SessionStart:[{hooks:[value]}]}}));
  removeEntry({kind:"hook",path,event:"SessionStart",nested:true,value,...(owned?{created_containers:{hooks:true,events:["SessionStart"]}}:{})});
  expect(JSON.parse(readFileSync(path,"utf8"))).toEqual(owned?{theme:"dark"}:{theme:"dark",hooks:{SessionStart:[]}});
 }
 const config=join(root,"config.toml"),block="# tap block\n# end";
 for(const owned of [false,true]) {
  writeFileSync(config,'model = "keep"\n[features]\nhooks = true\n\n[hooks]\n'+block+'\n');
  removeEntry({kind:"block",path:config,content:block,...(owned?{created_containers:{hooks:true,features:true,features_hooks:true}}:{})});
  expect(Bun.TOML.parse(readFileSync(config,"utf8"))).toEqual(owned?{model:"keep"}:{model:"keep",features:{hooks:true},hooks:{}});
 }
 writeFileSync(config,'[features]\nhooks = true\n[hooks]\nuser = "keep"\n'+block+'\n');
 removeEntry({kind:"block",path:config,content:block,created_containers:{hooks:true,features:true,features_hooks:true}});
 expect(Bun.TOML.parse(readFileSync(config,"utf8"))).toEqual({features:{hooks:true},hooks:{user:"keep"}});
});

test("TOML uses readable bare keys while escaping keys that need quotes",()=>{
 const config={version:3,harness:{claude:{permissions:"bypass"}},presets:{"name.with.dot":{harness:"claude"}}};
 const text=serializeToml(config,true);
 expect(text).toContain('version = 3');expect(text).toContain('[harness.claude]');expect(text).toContain('[presets."name.with.dot"]');
 expect(Bun.TOML.parse(text)).toEqual(config);
});

test("uninstall preserves ambiguous TOML cleanup inside user multiline strings",()=>{
 const root=fixture(),path=join(root,"config.toml"),block="# TAP BLOCK\n# END TAP BLOCK";
 for(const quote of ['"""',"'''"]) {
  const before='model = "keep"\n[features]\ndescription = '+quote+'\nuser notes\nhooks = true\nend\n'+quote+'\nhooks = true\n\n[hooks]\n'+block+'\n';
  writeFileSync(path,before);
  const result=removeEntry({kind:"block",path,content:block,created_containers:{hooks:true,features:false,features_hooks:true}});
  expect(result).toBe("preserved ambiguous TOML containers");
  expect(readFileSync(path,"utf8")).toBe(before);
 }
});

test("reinstall recaptures user container ownership after uninstall kept history",async()=>{
 const root=fixture();
 for(const name of ["CLAUDE","CODEX","HERMES","CURSOR","OPENCODE","GEMINI","CURSOR_AGENT","AGENTS"]){const path=join(root,name);mkdirSync(path);process.env[`TAP_${name}_HOME`]=path;}
 process.env.TAP_INSTALL_BIN=join(root,"bin");process.env.PATH=process.env.TAP_INSTALL_BIN+":"+process.env.PATH;
 const install=()=>expect(Bun.spawnSync(["bash",join(repo,"install.sh")],{env:process.env,stdin:"ignore"}).exitCode).toBe(0);
 install();expect(await uninstallMachine(answers(["y","keep"]))).toBe(0);
 const config=join(process.env.TAP_CODEX_HOME!,"config.toml");writeFileSync(config,'[features]\nhooks = true\n');
 install();
 const manifest=JSON.parse(readFileSync(join(process.env.TAP_INDEX_HOME!,"install-manifest.json"),"utf8"));
 expect(manifest.container_baselines[config].features_hooks).toBe(false);
 expect(await uninstallMachine(answers(["y","keep"]))).toBe(0);
 expect((Bun.TOML.parse(readFileSync(config,"utf8")) as any).features.hooks).toBe(true);
},30000);

test("wizard uses expanded PATH for plugins and finds installed TAP outside shell PATH",async()=>{
 const root=fixture(),tools=join(root,"tools"),bin=join(process.env.HOME!,".local/bin");mkdirSync(tools);mkdirSync(bin,{recursive:true});
 for(const name of ["python3","git"])symlinkSync(Bun.which(name)!,join(tools,name));
 const calls=join(root,"calls");
 writeFileSync(join(bin,"codex"),`#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n`,{mode:0o755});
 symlinkSync(join(repo,"bin/tap"),join(bin,"tap"));
 process.env.PATH=tools;
 const output:string[]=[];const log=spyOn(console,"log").mockImplementation((...args)=>{output.push(args.join(" "));});
 try {expect(await setupMachine(answers(["","","simple","high","bypass","n","y","n","n"]),["codex"])).toBe(0);}
 finally{log.mockRestore();}
 expect(readFileSync(calls,"utf8")).toContain("plugin marketplace add DietrichGebert/ponytail");
 expect(output.some(line=>line.includes(`Installed TAP: ${bin}/tap ->`))).toBe(true);
});

// tap-hvdvp: Codex's toml_edit writes land its new tables before a trailing
// comment, so once a user trusts TAP's hooks they sit inside TAP's fence.
const CODEX_END_LINE="# tap-managed:end Codex SessionStart\n";
const CODEX_TRUST='\n[hooks.state]\n\n[hooks.state."/Users/dev/.codex/config.toml:session_start:0:0"]\ntrusted_hash = "sha256:aa"\n';
function codexHomes(root:string){
 nativePlugins();
 for(const name of ["CLAUDE","CODEX","HERMES","CURSOR","OPENCODE","GEMINI","CURSOR_AGENT","AGENTS"]){const path=join(root,name);mkdirSync(path);process.env[`TAP_${name}_HOME`]=path;}
 process.env.TAP_INSTALL_BIN=join(root,"bin");process.env.PATH=process.env.TAP_INSTALL_BIN+":"+process.env.PATH;
 return join(process.env.TAP_CODEX_HOME!,"config.toml");
}
const runInstall=()=>Bun.spawnSync(["bash",join(repo,"install.sh")],{env:process.env,stdin:"ignore"});
const appendInCodex=(config:string,tables:string)=>writeFileSync(config,readFileSync(config,"utf8").replace(CODEX_END_LINE,tables+CODEX_END_LINE));
const CODEX_PROJECT='\n[projects."/Users/dev/work/Example-Org/tap"]\ntrust_level = "trusted"\n';

test("Codex hook and project trust survive uninstall, reinstall and sync",async()=>{
 const config=codexHomes(fixture());
 expect(runInstall().exitCode).toBe(0);
 appendInCodex(config,CODEX_TRUST); // the user trusts TAP's hooks, then uninstalls
 expect(await uninstallMachine(answers(["y","keep"]))).toBe(0);
 const left=readFileSync(config,"utf8");
 expect(left).not.toContain("tap-managed");
 expect(left).toContain(CODEX_TRUST);
 const reinstall=runInstall();
 expect({code:reinstall.exitCode,stderr:reinstall.stderr.toString()}).toEqual({code:0,stderr:expect.any(String)});
 expect(readFileSync(config,"utf8").split("# tap-managed:begin Codex SessionStart").length).toBe(2);
 appendInCodex(config,CODEX_PROJECT); // then trusts a project directory
 const sync=runInstall();
 expect({code:sync.exitCode,stderr:sync.stderr.toString()}).toEqual({code:0,stderr:expect.any(String)});
 expect(sync.stdout.toString()).toContain("moved the TAP end marker");
 expect(readFileSync(config,"utf8").endsWith(CODEX_END_LINE+CODEX_PROJECT)).toBe(true);
 expect(runInstall().stdout.toString()).toContain("install: Codex hooks already wired in config.toml");
},60000);

test("a Codex block the user removed by hand no longer licenses removing their [features] hooks",async()=>{
 const config=codexHomes(fixture());
 expect(runInstall().exitCode).toBe(0);
 // Remove TAP's block without uninstalling: the manifest still lists the file.
 const text=readFileSync(config,"utf8");
 writeFileSync(config,text.slice(0,text.indexOf("# tap-managed:begin"))+text.slice(text.indexOf(CODEX_END_LINE)+CODEX_END_LINE.length));
 expect(runInstall().exitCode).toBe(0);
 const manifest=JSON.parse(readFileSync(join(process.env.TAP_INDEX_HOME!,"install-manifest.json"),"utf8"));
 expect(manifest.container_baselines[config]).toEqual({hooks:false,features:false,features_hooks:false});
 expect(await uninstallMachine(answers(["y","keep"]))).toBe(0);
 expect(Bun.TOML.parse(readFileSync(config,"utf8"))).toEqual({features:{hooks:true},hooks:{}});
},60000);

test("uninstall keeps a Codex block whose trailing table adds to TAP's arrays",()=>{
 const root=fixture(),path=join(root,"config.toml");
 const content="# tap-managed:begin Codex SessionStart\n[[hooks.PreToolUse]]\nmatcher = \"^Bash$\"\n# tap-managed:end Codex SessionStart";
 const before=content.replace(CODEX_END_LINE.trimEnd(),'[[hooks.PreToolUse.hooks]]\ncommand = "/foreign"\n'+CODEX_END_LINE.trimEnd())+"\n";
 writeFileSync(path,before);
 expect(removeEntry({kind:"block",path,begin:"# tap-managed:begin Codex SessionStart",end:CODEX_END_LINE.trimEnd(),content})).toStartWith("preserved TAP block");
 expect(readFileSync(path,"utf8")).toBe(before);
});

// tap-89pob: scriptable consent, a dry run that matches the real run, no
// husks, runtime locks and emptied directories cleaned, the clone named.
function treeState(root:string):string {
 const out:string[]=[];
 const walk=(dir:string)=>{for(const name of readdirSync(dir).sort()){const path=join(dir,name),stat=lstatSync(path);
  if(path===join(root,"home/Library"))continue; // Bun's own cache under the sandbox HOME
  out.push(`${path} ${stat.isSymbolicLink()?"->"+readlinkSync(path):stat.isDirectory()?"dir":new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex")}`);
  if(stat.isDirectory()&&!stat.isSymbolicLink())walk(path);}};
 walk(root);return out.join("\n");
}
function captured<T>(run:()=>Promise<T>):Promise<{result:T;lines:string[]}> {
 const lines:string[]=[];const log=spyOn(console,"log").mockImplementation((...a)=>{lines.push(a.join(" "));});
 return run().then(result=>({result,lines})).finally(()=>log.mockRestore());
}
const noPrompt=async(question:string):Promise<string>=>{throw new Error(`unexpected prompt ${question}`);};
const outcomeLines=(lines:string[],paths:string[])=>lines.filter(line=>paths.some(path=>line.endsWith(`: ${path}`)));

test("uninstall dry run changes nothing and previews the real run's outcomes",async()=>{
 const root=fixture();codexHomes(root);
 const settings=join(process.env.TAP_CLAUDE_HOME!,"settings.json");writeFileSync(settings,'{"theme": "dark"}\n');
 expect(runInstall().exitCode).toBe(0);
 mkdirSync(join(process.env.TAP_INDEX_HOME!,"locks"),{recursive:true});writeFileSync(join(process.env.TAP_INDEX_HOME!,"locks/seat.lock"),"");
 const paths=JSON.parse(readFileSync(join(process.env.TAP_INDEX_HOME!,"install-manifest.json"),"utf8")).entries.map((e:any)=>e.path);
 const before=treeState(root);
 const dry=await captured(()=>uninstallMachine(noPrompt,{dryRun:true}));
 expect(dry.result).toBe(0);
 expect(treeState(root)).toBe(before);
 const real=await captured(()=>uninstallMachine(noPrompt,{yes:true}));
 expect(real.result).toBe(0);
 for (const output of [dry.lines,real.lines]) {
   expect(output[0]).toContain("agent sessions keep running");
   expect(output[0]).toContain("tap down <team/seat>");
   expect(output[0]).not.toContain("tap down <seat>");
 }
 const tense=(line:string)=>line.replace(/^would remove/,"removed").replace(/^would preserve/,"preserved").replace(/^would unset/,"unset").replace(" and delete the file"," and deleted the file");
 expect(outcomeLines(dry.lines,paths).map(tense)).toEqual(outcomeLines(real.lines,paths));
 expect(dry.lines.filter(l=>l.startsWith("would remove runtime locks")).map(tense)).toEqual(real.lines.filter(l=>l.startsWith("removed runtime locks")));
 expect(dry.lines.filter(l=>l.startsWith("would remove emptied")).map(tense)).toEqual(real.lines.filter(l=>l.startsWith("removed emptied")));
 expect(real.lines).toContain(`removed TAP SessionStart hook from: ${settings}`);
 expect(real.lines).toContain(`removed TAP PreToolUse hook from: ${settings}`);
 expect(new Set(real.lines).size).toBe(real.lines.length);
 expect(real.lines.at(-1)).toBe(`TAP no longer uses its clone at ${realpathSync(repo)}; it is safe to delete: rm -rf '${realpathSync(repo)}'`);
 // No husks: files TAP created are gone; the user's file keeps their bytes.
 expect(readFileSync(settings,"utf8")).toBe('{\n  "theme": "dark"\n}\n');
 for(const created of [join(process.env.TAP_CODEX_HOME!,"config.toml"),join(process.env.TAP_CODEX_HOME!,"AGENTS.md"),join(process.env.TAP_CURSOR_HOME!,"hooks.json")])expect(existsSync(created)).toBe(false);
 // Runtime locks and emptied directories are not history.
 for(const leftover of ["locks","tools","ingest"])expect(existsSync(join(process.env.TAP_INDEX_HOME!,leftover))).toBe(false);
},60000);

test("uninstall names a bootstrap release's retained versions, never the current link alone",()=>{
 const prefix=realpathSync(mkdtempSync(join(process.env.TMPDIR??"/tmp","release-prefix-")));
 try {
   for(const v of ["0.23-20260901-0123456789ab","0.23-20261002-abcdefabcdef"]){mkdirSync(join(prefix,"versions",v),{recursive:true});writeFileSync(join(prefix,"versions",v,"tap-release.json"),JSON.stringify({schema:1,version:v})+"\n");}
   mkdirSync(join(prefix,"versions",".replaced-x"));
   symlinkSync("versions/0.23-20261002-abcdefabcdef",join(prefix,"current"));
   const real=join(prefix,"versions/0.23-20261002-abcdefabcdef");
   const where=`TAP's release files remain: ${prefix}/current links to ${real}, and ${prefix}/versions keeps 2 releases (0.23-20260901-0123456789ab, 0.23-20261002-abcdefabcdef).`;
   // install.sh records the physical directory; the logical link resolves the same way.
   for(const repo of [real,join(prefix,"current")]){
     expect(installSourceAdvice(repo,false)).toBe(`${where} Deleting current alone leaves every version. Agent sessions that are still running use these files; once none runs, remove the release: rm -rf '${prefix}/current' '${prefix}/versions'`);
     expect(installSourceAdvice(repo,true)).toBe(`${where} Keep them until you resolve the preserved artifacts above.`);
   }
   // An unlistable versions/ still gets the advice rather than failing a finished uninstall.
   chmodSync(join(prefix,"versions"),0o311);
   try { expect(installSourceAdvice(real,false)).toStartWith(`TAP's release files remain: ${prefix}/current links to ${real}, and ${prefix}/versions keeps every installed release. Deleting current alone`); }
   finally { chmodSync(join(prefix,"versions"),0o755); }
   // A marked artifact under a directory that merely is named versions is not a bootstrap
   // prefix: without a current link into it, the advice never names that directory.
   const loose=join(prefix,"elsewhere/versions/0.23-20261002-abcdefabcdef");mkdirSync(loose,{recursive:true});
   writeFileSync(join(loose,"tap-release.json"),JSON.stringify({schema:1,version:"0.23-20261002-abcdefabcdef"})+"\n");
   expect(installSourceAdvice(loose,false)).toBe(`TAP no longer uses its clone at ${loose}; it is safe to delete: rm -rf '${loose}'`);
   // A marker naming another version, or none, is not a release either.
   const clone=join(prefix,"versions/0.23-20260901-0123456789ab");
   writeFileSync(join(clone,"tap-release.json"),JSON.stringify({schema:1,version:"other"})+"\n");
   expect(installSourceAdvice(clone,false)).toBe(`TAP no longer uses its clone at ${clone}; it is safe to delete: rm -rf '${clone}'`);
   rmSync(join(clone,"tap-release.json"));
   expect(installSourceAdvice(clone,false)).toBe(`TAP no longer uses its clone at ${clone}; it is safe to delete: rm -rf '${clone}'`);
   expect(installSourceAdvice(clone,true)).toBe(`Keep TAP's clone at ${clone} until you resolve the preserved artifacts above.`);
 } finally { rmSync(prefix,{recursive:true,force:true}); }
});

test("uninstall without a terminal or consent refuses and touches nothing",()=>{
 const root=fixture();codexHomes(root);
 expect(runInstall().exitCode).toBe(0);
 const before=treeState(root);
 const run=Bun.spawnSync([process.execPath,join(repo,"runtime/bun/src/verbs/machine.ts"),"uninstall"],{env:process.env,stdin:"ignore",stdout:"pipe",stderr:"pipe"});
 expect(run.exitCode).toBe(2);
 expect(run.stderr.toString()).toContain("next: tap uninstall --dry-run to preview, then tap uninstall --yes [--history keep|archive|delete]");
 expect(treeState(root)).toBe(before);
 const bad=Bun.spawnSync([process.execPath,join(repo,"runtime/bun/src/verbs/machine.ts"),"uninstall","--history","purge"],{env:process.env,stdin:"ignore",stdout:"pipe",stderr:"pipe"});
 expect(bad.exitCode).toBe(2);
 expect(bad.stderr.toString()).toContain("--history takes keep, archive or delete");
},60000);

test("uninstall --yes --history delete leaves no TAP files and no index",async()=>{
 const root=fixture();codexHomes(root);
 expect(runInstall().exitCode).toBe(0);
 const run=await captured(()=>uninstallMachine(noPrompt,{yes:true,history:"delete"}));
 expect(run.result).toBe(0);
 expect(existsSync(process.env.TAP_INDEX_HOME!)).toBe(false);
 const residual=treeState(root).split("\n").filter(line=>line && !line.endsWith(" dir"));
 expect(residual).toEqual([]);
},60000);

test("uninstall keeps a lock directory some process still holds",async()=>{
 const root=fixture();codexHomes(root);
 expect(runInstall().exitCode).toBe(0);
 const locks=join(process.env.TAP_INDEX_HOME!,"locks"),lock=join(locks,"held.lock");
 mkdirSync(locks,{recursive:true});writeFileSync(lock,"");
 const holder=Bun.spawn(["sh","-c",`exec 3<'${lock}'; exec sleep 30`]);
 try {
  await Bun.sleep(300);
  const run=await captured(()=>uninstallMachine(noPrompt,{yes:true}));
  expect(run.result).toBe(0);
  expect(existsSync(lock)).toBe(true);
  expect(run.lines.some(line=>line.startsWith(`preserved runtime locks: ${locks}`))).toBe(true);
 } finally { holder.kill(); await holder.exited; }
},60000);
