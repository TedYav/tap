import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setupMachine, uninstallMachine } from "../src/verbs/machine";
import { stubHarnessCommands } from "./support/harness-stubs";

const repo = resolve(import.meta.dir, "../../..");
const original = {...process.env};
const roots: string[] = [];
afterEach(() => { process.env = {...original}; for (const root of roots.splice(0)) rmSync(root, {recursive:true, force:true}); });

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
  const root = mkdtempSync("/tmp/tap-local-bin-"); roots.push(root);
  const home = join(root,"home"); mkdirSync(home);
  process.env = {...original, HOME:home, XDG_CONFIG_HOME:join(root,"config"), TAP_INDEX_HOME:join(root,"index"), TAP_INSTALL_HOOK:"0", TAP_INSTALL_FORCE_NONPRIMARY:"1", PATH:join(home,".local/bin")+":"+stubHarnessCommands(join(root,"harness-bin"))+":"+original.PATH};
  delete process.env.TAP_INSTALL_BIN;
  delete process.env.TAP_INSTALL_MANIFEST;
  for (const name of ["CLAUDE","CODEX","HERMES","CURSOR","OPENCODE","GEMINI","CURSOR_AGENT","AGENTS"]) process.env[`TAP_${name}_HOME`] = join(root,name);
  const current = join(home,".local/bin/tap"), legacy = join(home,"Scripts/tap");
  return {home,current,legacy, manifest:()=>JSON.parse(readFileSync(join(root,"index/install-manifest.json"),"utf8"))};
}
function install(...args:string[]) { return Bun.spawnSync(["bash",join(repo,"install.sh"),...args],{env:process.env,stdin:"ignore"}); }
test("fresh default install uses local bin without creating Scripts or a PATH warning",()=>{
  const f=fixture(), result=install();
  expect({rc:result.exitCode,err:result.stderr.toString()}).toEqual({rc:0,err:expect.any(String)});
  expect(readlinkSync(f.current)).toBe(join(repo,"bin/tap"));
  expect(existsSync(join(f.home,"Scripts"))).toBe(false);
  expect(result.stderr.toString()).not.toContain("shell setup required");
  expect(f.manifest().entries.some((e:any)=>e.kind==="symlink" && e.path===f.current)).toBe(true);
});
test("installer relinks only a completion symlink proven by the prior manifest",()=>{
  const f=fixture();
  const site=join(f.home,".local/share/zsh/site-functions");mkdirSync(site,{recursive:true});
  const link=join(site,"_tap"),oldRepo=join(f.home,"prior-checkout"),oldTarget=join(oldRepo,"completions/_tap");
  symlinkSync(oldTarget,link);
  mkdirSync(process.env.TAP_INDEX_HOME!,{recursive:true});
  const manifest=join(process.env.TAP_INDEX_HOME!,"install-manifest.json");
  writeFileSync(manifest,JSON.stringify({version:1,repo:oldRepo,entries:[{kind:"symlink",path:link,target:oldTarget}]}));
  // The relink line is inventory detail: opt-in through --verbose.
  const owned=install("--verbose");expect(owned.exitCode).toBe(0);
  expect(readlinkSync(link)).toBe(join(repo,"completions/_tap"));
  expect(owned.stdout.toString()).toContain("relinked zsh completion");
  // An unrecorded replacement at the same pathname is never taken over.
  rmSync(link);symlinkSync("/foreign/completions/_tap",link);
  const refused=install();expect(refused.exitCode).toBe(0);
  expect(readlinkSync(link)).toBe("/foreign/completions/_tap");
  expect(refused.stderr.toString()).toContain(`preserving user-owned ${link}`);
});

test("explicit setup upgrades an exact recorded zsh block and preserves edited blocks",async()=>{
  const f=fixture();process.env.SHELL="/bin/zsh";process.env.TAP_SETUP_OPEN_GUIDE="0";
  const shell=join(f.home,".zshrc"), content="# >>> tap aliases >>>\nalias existing='tap help'\n# <<< tap aliases <<<";
  writeFileSync(shell,"# personal\n"+content+"\n");
  mkdirSync(process.env.TAP_INDEX_HOME!,{recursive:true});
  writeFileSync(join(process.env.TAP_INDEX_HOME!,"install-manifest.json"),JSON.stringify({version:1,repo,entries:[{kind:"block",path:shell,begin:"# >>> tap aliases >>>",end:"# <<< tap aliases <<<",content}]}));
  const answers=["","","simple","high","bypass","n","keep","y"];
  expect(await setupMachine(async()=>answers.shift()!,["codex"])).toBe(0);
  const updated=readFileSync(shell,"utf8");
  expect(updated).toContain("autoload -Uz compinit && compinit;");
  expect(updated).toContain("alias existing='tap help'");
  expect(f.manifest().entries.find((e:any)=>e.kind==="block"&&e.path===shell).content).toBe(updated.slice(updated.indexOf("# >>>"),updated.indexOf("# <<<")+"# <<< tap aliases <<<".length));
  writeFileSync(shell,updated.replace("alias existing='tap help'","alias existing='tap help team'"));
  // Existing starters need neither effort selection nor a config rewrite.
  const edited=readFileSync(shell,"utf8"),again=["","","simple","bypass","n","keep","y"];
  expect(await setupMachine(async()=>again.shift()!,["codex"])).toBe(0);
  expect(readFileSync(shell,"utf8")).toBe(edited);
});
test("old checkout link migrates once, records both paths, and uninstall touches only current link",async()=>{
  const f=fixture();mkdirSync(join(f.home,"Scripts"));
  writeFileSync(join(f.home,"Scripts/personal"),"keep me");symlinkSync(join(repo,"bin/tap"),f.legacy);
  mkdirSync(process.env.TAP_INDEX_HOME!,{recursive:true});
  writeFileSync(join(process.env.TAP_INDEX_HOME!,"install-manifest.json"),JSON.stringify({version:1,repo,entries:[{kind:"symlink",path:f.legacy,target:join(repo,"bin/tap")}]}));
  const result=install();expect(result.exitCode).toBe(0);
  expect(existsSync(f.legacy)).toBe(false);
  expect(readlinkSync(f.current)).toBe(join(repo,"bin/tap"));
  expect(result.stdout.toString()).toContain("moved tap from ~/Scripts to ~/.local/bin");
  const entries=f.manifest().entries;
  expect(entries.some((e:any)=>e.kind==="symlink"&&e.path===f.current)).toBe(true);
  expect(entries.some((e:any)=>e.kind==="migration"&&e.path===f.legacy&&e.target===join(repo,"bin/tap")&&e.destination===f.current)).toBe(true);
  expect(entries.some((e:any)=>e.kind==="symlink"&&e.path===f.legacy)).toBe(false);
  expect(install().stdout.toString()).not.toContain("moved tap");
  // The old pathname is no longer an uninstall target, even if the user reuses it.
  writeFileSync(f.legacy,"user replacement");
  const answers=["y","keep"];
  expect(await uninstallMachine(async()=>answers.shift()!)).toBe(0);
  expect(existsSync(f.current)).toBe(false);
  expect(readFileSync(f.legacy,"utf8")).toBe("user replacement");
  expect(readFileSync(join(f.home,"Scripts/personal"),"utf8")).toBe("keep me");
});
for(const kind of ["file","foreign-link"])test(`migration preserves a user-owned ${kind} at Scripts/tap`,()=>{
  const f=fixture();mkdirSync(join(f.home,"Scripts"));
  if(kind==="file")writeFileSync(f.legacy,"personal command");else symlinkSync("/some/other/checkout/bin/tap",f.legacy);
  const result=install();expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toContain("refusing");
  expect(existsSync(f.current)).toBe(true);
  if(kind==="file")expect(readFileSync(f.legacy,"utf8")).toBe("personal command");else expect(readlinkSync(f.legacy)).toBe("/some/other/checkout/bin/tap");
});
test("explicit Scripts override keeps the old location and does not migrate",()=>{
  const f=fixture();mkdirSync(join(f.home,"Scripts"));symlinkSync(join(repo,"bin/tap"),f.legacy);
  process.env.TAP_INSTALL_BIN=join(f.home,"Scripts");process.env.PATH=process.env.TAP_INSTALL_BIN+":"+stubHarnessCommands(join(f.home,"../harness-bin"))+":"+original.PATH;
  const result=install();expect(result.exitCode).toBe(0);
  expect(readlinkSync(f.legacy)).toBe(join(repo,"bin/tap"));expect(existsSync(f.current)).toBe(false);
  expect(result.stdout.toString()).not.toContain("moved tap");
  expect(f.manifest().entries.some((e:any)=>e.kind==="migration")).toBe(false);
});

test("migration keeps the legacy link when its manifest cannot be recorded",()=>{
  const f=fixture();mkdirSync(join(f.home,"Scripts"));symlinkSync(join(repo,"bin/tap"),f.legacy);
  mkdirSync(process.env.TAP_INDEX_HOME!,{recursive:true});
  const manifest=join(process.env.TAP_INDEX_HOME!,"install-manifest.json");writeFileSync(manifest,"{broken");
  const result=install();expect(result.exitCode).toBe(0);
  expect(readlinkSync(f.legacy)).toBe(join(repo,"bin/tap"));expect(existsSync(f.current)).toBe(true);
  expect(readFileSync(manifest,"utf8")).toBe("{broken");
  expect(result.stdout.toString()).not.toContain("moved tap");
  expect(result.stderr.toString()).toContain("manifest recording incomplete");
});

test("wizard shell block's export lands first and wins over pre-existing PATH entries",async()=>{
  const f=fixture();
  // The block appends to the rc file, so a decoy tap EARLIER on PATH shadows the
  // install bin dir unless the block's export lands first (tap-1bus0's order
  // guarantee, formerly pinned through the Homebrew python line E4 retires).
  const decoy=join(f.home,"decoy-bin");mkdirSync(decoy);
  writeFileSync(join(decoy,"tap"),"#!/bin/sh\nexit 0\n",{mode:0o755});
  process.env.PATH=decoy+":"+process.env.PATH;
  process.env.SHELL="/bin/zsh";
  const mocks=join(f.home,"mocks");mkdirSync(mocks);writeFileSync(join(mocks,"open"),"#!/bin/sh\nexit 0\n",{mode:0o755});process.env.PATH=mocks+":"+process.env.PATH;
  // The install bin dir is off PATH here, so only the block can put it first.
  const installed=join(f.home,"installed-bin");mkdirSync(installed);
  writeFileSync(join(installed,"tap"),"#!/bin/sh\nexit 0\n",{mode:0o755});
  process.env.TAP_INSTALL_BIN=installed;
  const responses=["","","simple","high","bypass","n","keep","y"];
  expect(await setupMachine(async()=>responses.shift()!,["codex"])).toBe(0);
  const shell=readFileSync(join(f.home,".zshrc"),"utf8");
  expect(shell).toContain(installed);
  const sourced=Bun.spawnSync(["bash","-c",'. "$1"; printf "%s\\n%s\\n" "${PATH%%:*}" "$(command -v tap)"',"_",join(f.home,".zshrc")],{env:process.env});
  expect(sourced.exitCode).toBe(0);
  expect(sourced.stdout.toString().trim().split("\n")).toEqual([installed,join(installed,"tap")]);
});

test("public reply settles under a hostile PATH",()=>{
  const f=fixture();expect(install().exitCode).toBe(0);
  // Born live: an absent marker opens no legacy door, so the team is enrolled and its bus is canonical.
  const home=realpathSync(f.home),bus=join(home,".tap/bus"),registry=join(home,".tap/team-registry.json");
  mkdirSync(join(bus,"payloads"),{recursive:true});mkdirSync(join(bus,"receipts"));
  writeFileSync(registry,JSON.stringify({schema:"0.20",team:{name:"demo",worktree_root:home},seats:{alice:{delivery:"poll",status:"active",harness:"codex"},peer:{delivery:"poll",status:"active",harness:"codex"}}}));
  writeFileSync(join(process.env.TAP_INDEX_HOME!,"global-registry.json"),JSON.stringify({schema:"0.20",teams:{demo:{root:home,registry_location:registry,state:"registered"}}}));
  const inbound=join(bus,"payloads/inbound.md"),answer=join(f.home,"answer.md");
  writeFileSync(inbound,`---\nid: inbound\nfrom: peer\nto: alice\nkind: discuss\nreply: expected\npath: ${inbound}\n---\nquestion\n`);writeFileSync(answer,"answer\n");
  const poison=join(f.home,"old-python");mkdirSync(poison);writeFileSync(join(poison,"python3"),"#!/bin/sh\necho wrong-login-python >&2\nexit 97\n",{mode:0o755});
  const result=Bun.spawnSync([f.current,"reply","inbound","--by","alice","-f",answer],{env:{...process.env,PATH:poison+":"+process.env.PATH,TAP_HOME:bus,TAP_SPOOL_DISABLE_OPPORTUNISTIC:"1",TAP_SPOOL_DISABLE_DELIVERER:"1"},cwd:f.home,stdin:"ignore"});
  expect({rc:result.exitCode,err:result.stderr.toString()}).toEqual({rc:0,err:expect.any(String)});
  expect(result.stderr.toString()).not.toContain("wrong-login-python");
  expect(existsSync(join(bus,"receipts/inbound.done"))).toBe(true);
},20000);

test("migration updates a recorded existing shell block before retiring the legacy link",async()=>{
 const f=fixture();mkdirSync(join(f.home,"Scripts"));symlinkSync(join(repo,"bin/tap"),f.legacy);
 const shell=join(f.home,".zshrc"),content='# >>> tap aliases >>>\nexport PATH="$HOME/Scripts:$PATH"\nalias example="tap help"\n# <<< tap aliases <<<';
 writeFileSync(shell,'# personal\n'+content+'\n');mkdirSync(process.env.TAP_INDEX_HOME!,{recursive:true});
 writeFileSync(join(process.env.TAP_INDEX_HOME!,"install-manifest.json"),JSON.stringify({version:1,repo,entries:[{kind:"block",path:shell,begin:'# >>> tap aliases >>>',end:'# <<< tap aliases <<<',content}]}));
 expect(install().exitCode).toBe(0);
 const result=Bun.spawnSync(['bash','-c','. "$1"; command -v tap','_',shell],{env:{...process.env,PATH:'/usr/bin:/bin'}});
 expect(result.stdout.toString().trim()).toBe(f.current);expect(existsSync(f.legacy)).toBe(false);
 const responses=['y','keep'];expect(await uninstallMachine(async()=>responses.shift()!)).toBe(0);
 expect(readFileSync(shell,'utf8')).toBe('# personal\n');
});

test("installer warns once for a blocked skill home, unwinds it, and keeps linking the rest",()=>{
  // Claude and Codex take their skills from the native plugin; the loose links
  // under test belong to the flat hosts, so the blocker sits on one of those.
  const f=fixture(),hermes=process.env.TAP_HERMES_HOME!,opencode=process.env.TAP_OPENCODE_HOME!;
  mkdirSync(hermes,{recursive:true});mkdirSync(opencode,{recursive:true});
  writeFileSync(join(hermes,"skills"),"personal blocker");
  const result=install(),err=result.stderr.toString();
  expect(result.exitCode).toBe(0);
  expect(err.match(/skipped .* skill links/g)).toHaveLength(1);
  expect(err).toContain(`could not write ${join(hermes,"skills")}`);expect(err).toContain(`move ${join(hermes,"skills")} aside`);
  expect(readlinkSync(join(opencode,"skills/tap"))).toBe(join(repo,"skills/tap"));
  expect(f.manifest().entries.some((e:any)=>e.kind==="symlink"&&e.path===join(opencode,"skills/tap"))).toBe(true);
  expect(f.manifest().entries.some((e:any)=>String(e.path).startsWith(join(hermes,"skills")))).toBe(false);
  expect(readFileSync(join(hermes,"skills"),"utf8")).toBe("personal blocker");
});

test("mandatory foreign skill is preserved, warned about by path, and does not stop the install",()=>{
 const f=fixture(),hermes=process.env.TAP_HERMES_HOME!,opencode=process.env.TAP_OPENCODE_HOME!,directory=join(hermes,"skills");mkdirSync(directory,{recursive:true});mkdirSync(opencode,{recursive:true});
 const path=join(directory,"tap");symlinkSync("/foreign/tap",path);
 const result=install();expect(result.exitCode).toBe(0);expect(result.stderr.toString()).toContain(path);
 expect(result.stderr.toString()).toContain(`move ${path} aside`);expect(readlinkSync(path)).toBe("/foreign/tap");
 expect(readlinkSync(join(opencode,"skills/tap"))).toBe(join(repo,"skills/tap"));
});
