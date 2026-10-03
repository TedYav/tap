import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { formatSkillLinkFailure, installMachineSkills, installSkillLinks, removeOwnedLink } from "../src/install-skill-links";
import { CORE_SKILLS, OPTIONAL_SKILLS, PUBLIC_SKILLS, flatSkillName, aliasDirectory } from "../src/skill-policy";
import { removeEntry } from "../src/verbs/machine";
const original={...process.env}, roots:string[]=[];
afterEach(()=>{process.env={...original};for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){
 const root=mkdtempSync(join(process.env.TAP_INDEX_HOME!,"skill-policy-"));roots.push(root);
 const home=join(root,"home"),directory=join(home,"skills"),manifest=join(root,"install-manifest.json");mkdirSync(directory,{recursive:true});
 process.env.TAP_INSTALL_MANIFEST=manifest;
 const repo=resolve(import.meta.dir,"../../..");
 const entries=()=>JSON.parse(readFileSync(manifest,"utf8")).entries;
 const seed=(names:string[])=>{const rows=names.map(name=>({kind:"symlink",path:join(directory,name),target:join(repo,"skills",name)}));for(const e of rows)symlinkSync(e.target,e.path);writeFileSync(manifest,JSON.stringify({version:1,repo,entries:rows}));};
 const run=(value?:boolean)=>installSkillLinks(repo,"fixture",home,value,()=>{});
 return {root,home,directory,manifest,repo,entries,seed,run};
}
test("flat hosts expose only prefixed skills and retain the mandatory tap entry",()=>{
 const f=fixture();f.run(false);expect(readdirSync(f.directory).sort()).toEqual(CORE_SKILLS.map(flatSkillName).sort());
 const path=join(f.directory,"tap"),inode=lstatSync(path).ino;f.run(false);expect(lstatSync(path).ino).toBe(inode);
 expect(readlinkSync(path)).toBe(join(f.repo,"skills/tap"));
});
test("full flat kit delegates with canonical descriptions and visibility metadata",()=>{
 const f=fixture();f.run(true);
 expect(readdirSync(f.directory).sort()).toEqual(PUBLIC_SKILLS.map(flatSkillName).sort());
 for(const name of PUBLIC_SKILLS.filter(n=>n!=="tap")){
  const exposed=flatSkillName(name),target=readlinkSync(join(f.directory,exposed));
  expect(target).toBe(aliasDirectory(f.manifest,exposed));
  const body=readFileSync(join(target,"SKILL.md"),"utf8");expect(body).toContain(`name: ${exposed}\n`);expect(body).toContain(`tap help skill ${name}`);
  expect(body).toContain("canonical file's directory");
 }
 expect(readFileSync(join(f.directory,"tap-send/SKILL.md"),"utf8")).toContain("user-invocable: false");
 f.run(true);expect(new Set(f.entries().map((e:any)=>`${e.kind}:${e.path}`)).size).toBe(f.entries().length);
});
test("upgrade retires owned aliases and preserves the corresponding optional skill",()=>{
 const f=fixture();f.seed(["lead","using-tap","tap-ask","tap-config"]);
 const personal=join(f.directory,"drive");symlinkSync("/personal/drive",personal);
 f.run();
 for(const name of ["lead","using-tap","tap-config"])expect(lstatSync(join(f.directory,name),{throwIfNoEntry:false})).toBeUndefined();
 expect(existsSync(join(f.directory,"tap-lead/SKILL.md"))).toBe(true);expect(existsSync(join(f.directory,"tap-ask/SKILL.md"))).toBe(true);
 expect(existsSync(join(f.directory,"tap-crew"))).toBe(false);expect(readlinkSync(personal)).toBe("/personal/drive");
});
test("explicit No removes only unchanged owned optional links and generated files",()=>{
 const f=fixture();f.run(true);
 const edited=join(aliasDirectory(f.manifest,"tap-lead"),"SKILL.md");writeFileSync(edited,"personal edited wrapper");
 const foreign=join(f.directory,"tap-ask");rmSync(foreign);symlinkSync("/foreign/skill",foreign);
 const personal=join(f.directory,"tap-drive");rmSync(personal);mkdirSync(personal);writeFileSync(join(personal,"SKILL.md"),"personal");
 f.run(false);
 expect(readFileSync(edited,"utf8")).toBe("personal edited wrapper");expect(readlinkSync(foreign)).toBe("/foreign/skill");expect(readFileSync(join(personal,"SKILL.md"),"utf8")).toBe("personal");
 expect(existsSync(join(aliasDirectory(f.manifest,"tap-crew"),"SKILL.md"))).toBe(false);expect(existsSync(join(f.directory,"tap"))).toBe(true);
});
test("foreign core links refuse without replacement; edited optional wrappers survive",()=>{
 const f=fixture();symlinkSync("/foreign/tap",join(f.directory,"tap"));expect(f.run(true)).toMatchObject({ok:false,path:join(f.directory,"tap")});
 expect(readlinkSync(join(f.directory,"tap"))).toBe("/foreign/tap");rmSync(join(f.directory,"tap"));f.run(true);
 const wrapper=join(aliasDirectory(f.manifest,"tap-lead"),"SKILL.md");writeFileSync(wrapper,"edited");f.run(true);expect(readFileSync(wrapper,"utf8")).toBe("edited");
 expect(removeOwnedLink(join(f.directory,"tap"),"wrong")).toBe("preserved changed target");
});
test("manifest uninstall removes generated wrappers by hash and preserves edits",()=>{
 const f=fixture();f.run(true);const edited=join(aliasDirectory(f.manifest,"tap-lead"),"SKILL.md");writeFileSync(edited,"edited");
 for(const e of f.entries())removeEntry(e);
 expect(readdirSync(f.directory)).toEqual([]);expect(readFileSync(edited,"utf8")).toBe("edited");expect(existsSync(join(aliasDirectory(f.manifest,"tap-drive"),"SKILL.md"))).toBe(false);
});

test("saved preference uses secure config reads and distinguishes malformed tables from absence",async()=>{
 const {savedFullKit}=await import("../src/skill-policy");const f=fixture();process.env.XDG_CONFIG_HOME=join(f.root,"config");
 const directory=join(process.env.XDG_CONFIG_HOME,"tap"),path=join(directory,"config.toml");mkdirSync(directory,{recursive:true});
 expect(savedFullKit()).toBeUndefined();
 for(const source of ['skills="wrong"','skills=[]','skills=1979-05-27','[skills]\nfull_kit="yes"','not TOML [']){
  writeFileSync(path,source,{mode:0o600});expect(()=>savedFullKit()).toThrow();
 }
 writeFileSync(path,'[skills]\nfull_kit=true\n');expect(savedFullKit()).toBe(true);
 expect(()=>savedFullKit({skills:"wrong"})).toThrow("skills must be a table");
 chmodSync(path,0o666);expect(()=>savedFullKit()).toThrow("group/world writable");
});

// tap-7io25: a harness is linked completely or not at all, and a fixable blocker
// is a typed failure, never a throw that strands every later harness.
const canWriteBlocked=process.getuid?.()!==0;
function run(f:ReturnType<typeof fixture>,value:boolean|undefined,lines:string[]=[]){return installSkillLinks(f.repo,"fixture",f.home,value,l=>lines.push(l));}
test("a foreign object blocking a later core skill unwinds the links made before it",()=>{
 const f=fixture(),blocker=join(f.directory,"tap-help");writeFileSync(blocker,"personal");
 const lines:string[]=[],result=run(f,false,lines);
 expect(result).toMatchObject({ok:false,path:blocker,partial:false});
 expect(readdirSync(f.directory)).toEqual(["tap-help"]);expect(readFileSync(blocker,"utf8")).toBe("personal");
 expect(lines).toEqual([]);expect(existsSync(f.manifest)).toBe(false);
});
test.skipIf(!canWriteBlocked)("an unwritable manifest directory leaves no link, no manifest edit and no success line",()=>{
 const f=fixture(),index=join(f.root,"index");mkdirSync(index);process.env.TAP_INSTALL_MANIFEST=join(index,"install-manifest.json");
 chmodSync(index,0o500);
 try {
  const lines:string[]=[],result=run(f,false,lines);
  expect(result).toMatchObject({ok:false,code:"EACCES",path:process.env.TAP_INSTALL_MANIFEST});expect(readdirSync(f.directory)).toEqual([]);expect(lines).toEqual([]);
 } finally { chmodSync(index,0o700); }
});
test.skipIf(!canWriteBlocked)("an unwritable skills directory keeps earlier links, names the path, and writes nothing new",()=>{
 const f=fixture();f.seed(["tap"]);const before=readFileSync(f.manifest,"utf8");
 chmodSync(f.directory,0o500);
 try {
  const lines:string[]=[],result=run(f,false,lines);
  expect(result).toMatchObject({ok:false,code:"EACCES"});
  const failure=result as Exclude<typeof result,{ok:true}>;
  expect(failure.path.startsWith(f.directory)).toBe(true);expect(failure.remedy).toContain("writable");
  expect(formatSkillLinkFailure(failure)).toContain(failure.path);
  expect(readdirSync(f.directory)).toEqual(["tap"]);expect(readFileSync(f.manifest,"utf8")).toBe(before);expect(lines).toEqual([]);
 } finally { chmodSync(f.directory,0o700); }
});
test("a file where the skills directory belongs gets a move-aside remedy, not a permissions one",()=>{
 const f=fixture();rmSync(f.directory,{recursive:true});writeFileSync(f.directory,"personal");
 const result=run(f,false);
 expect(result).toMatchObject({ok:false,path:f.directory});
 const text=formatSkillLinkFailure(result as Exclude<typeof result,{ok:true}>);
 expect(text).toContain(`move ${f.directory} aside`);expect(text).not.toContain("writable");
 expect(readFileSync(f.directory,"utf8")).toBe("personal");
});
test.skipIf(!canWriteBlocked)("a failed alias write rolls back the optional links made before it",()=>{
 const f=fixture();f.run(false);const before=readFileSync(f.manifest,"utf8");
 const aliasRoot=dirname(aliasDirectory(f.manifest,"tap-lead"));mkdirSync(aliasRoot,{recursive:true});chmodSync(aliasRoot,0o500);
 try {
  const lines:string[]=[],result=run(f,true,lines);
  expect(result).toMatchObject({ok:false,code:"EACCES"});
  expect(readdirSync(f.directory).sort()).toEqual(CORE_SKILLS.map(flatSkillName).sort());expect(readFileSync(f.manifest,"utf8")).toBe(before);expect(lines).toEqual([]);
 } finally { chmodSync(aliasRoot,0o700); }
});
test.skipIf(!canWriteBlocked)("an unreadable manifest is kept, never deleted, and the remedy makes it readable",()=>{
 const f=fixture();f.seed(["tap"]);const before=readFileSync(f.manifest,"utf8");chmodSync(f.manifest,0);
 try {
  const result=run(f,false);
  expect(result).toMatchObject({ok:false,code:"EACCES",verb:"read",path:f.manifest});
  expect((result as Exclude<typeof result,{ok:true}>).remedy).toContain("readable");
 } finally { chmodSync(f.manifest,0o600); }
 expect(readFileSync(f.manifest,"utf8")).toBe(before);
});
test("a defect still throws, but only after the harness is unwound",()=>{
 const f=fixture(),repo=join(f.root,"repo"),missing=CORE_SKILLS[5]!;
 for(const name of CORE_SKILLS)if(name!==missing){mkdirSync(join(repo,"skills",name),{recursive:true});writeFileSync(join(repo,"skills",name,"SKILL.md"),`---\nname: ${name}\ndescription: fixture\n---\n`);}
 expect(()=>installSkillLinks(repo,"fixture",f.home,false,()=>{})).toThrow("missing shipped skill");
 expect(readdirSync(f.directory)).toEqual([]);expect(existsSync(f.manifest)).toBe(false);
});
test("a shared alias wrapper survives while any harness still links it, in either order",()=>{
 for(const order of [["a","b"],["b","a"]]){
  const f=fixture(),homes:Record<string,string>={a:f.home,b:join(f.root,"home-b")};mkdirSync(join(homes.b!,"skills"),{recursive:true});
  const each=(value:boolean)=>{for(const key of order){const r=installSkillLinks(f.repo,key,homes[key]!,value,()=>{});if(!r.ok)throw new Error("unexpected failure");}};
  each(true);
  const wrapper=join(aliasDirectory(f.manifest,"tap-lead"),"SKILL.md");expect(existsSync(wrapper)).toBe(true);
  // Home a is blocked by a foreign core skill, so it keeps its aliases while b reconciles.
  const blocker=join(homes.a!,"skills",flatSkillName(CORE_SKILLS[5]!));rmSync(blocker);writeFileSync(blocker,"personal");
  const results=order.map(key=>installSkillLinks(f.repo,key,homes[key]!,false,()=>{}));
  expect(results.map(r=>r.ok)).toEqual(order.map(key=>key!=="a"));
  expect(existsSync(wrapper)).toBe(true);expect(existsSync(join(homes.a!,"skills/tap-lead/SKILL.md"))).toBe(true);
  // Once the blocker is gone the next reconcile removes the last link and then the wrapper.
  rmSync(blocker);expect(installSkillLinks(f.repo,"a",homes.a!,false,()=>{}).ok).toBe(true);
  expect(existsSync(wrapper)).toBe(false);rmSync(f.root,{recursive:true,force:true});
 }
});
test("setup keeps going past a blocked harness and then reports it",()=>{
 const f=fixture(),other=join(f.root,"other");mkdirSync(other);process.env.HOME=join(f.root,"empty-home");
 process.env.TAP_HERMES_HOME=f.home;writeFileSync(join(f.directory,"tap-help"),"personal");
 process.env.TAP_OPENCODE_HOME=other;const lines:string[]=[];
 expect(()=>installMachineSkills(f.repo,false,l=>lines.push(l))).toThrow("skill links not installed for: Hermes");
 expect(readlinkSync(join(other,"skills/tap"))).toBe(join(f.repo,"skills/tap"));
 expect(lines.filter(l=>l.includes("WARNING"))).toHaveLength(1);
});
