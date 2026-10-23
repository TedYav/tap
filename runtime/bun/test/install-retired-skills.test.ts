import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CORE_SKILLS, OPTIONAL_SKILLS, REPO_LOCAL_SKILLS, RETIRED_SKILLS, TOMBSTONE_SKILLS } from "../src/skill-policy";
const repo=resolve(import.meta.dir,"../../..");
// REPO_LOCAL_SKILLS names skills the export manifest may deny: assert only the
// entries this checkout actually carries, so the private tree keeps full
// coverage and a public candidate without those directories still holds.
const shippedRepoLocal=REPO_LOCAL_SKILLS.filter((name)=>existsSync(join(repo,"skills",name,"SKILL.md")));
test("one policy classifies canonical sources and retired names never ship",()=>{
 expect(CORE_SKILLS).toEqual(["tap","in","send","escalate","config-wizard","help","extend"]);
 expect(REPO_LOCAL_SKILLS).toEqual(["coach","abandon-branch"]);
 for(const name of [...CORE_SKILLS,...OPTIONAL_SKILLS,...shippedRepoLocal])expect(existsSync(join(repo,"skills",name,"SKILL.md"))).toBe(true);
 for(const name of RETIRED_SKILLS)expect(existsSync(join(repo,"skills",name,"SKILL.md"))).toBe(false);
 expect(readFileSync(join(repo,"install.sh"),"utf8")).toContain('skill-policy.ts" classifications');
});
test("installer CLI reaps only manifest-owned retired links, preserving foreign links and directories",()=>{
 const root=mkdtempSync(join(process.env.TAP_INDEX_HOME!,"retired-")),home=join(root,"home"),directory=join(home,"skills"),manifest=join(root,"manifest.json");mkdirSync(directory,{recursive:true});
 try{
  const path=join(directory,"lieutenant"),target=join(repo,"skills/lieutenant");symlinkSync(target,path);
  symlinkSync("/foreign/execute",join(directory,"execute"));mkdirSync(join(directory,"tap-done"));
  writeFileSync(manifest,JSON.stringify({version:1,repo,entries:[{kind:"symlink",path,target}]}));
  const result=Bun.spawnSync([process.execPath,join(repo,"runtime/bun/src/install-skill-links.ts"),"install",repo,"fixture",home],{env:{...process.env,TAP_INSTALL_MANIFEST:manifest,XDG_CONFIG_HOME:join(root,"config")}});
  expect(result.exitCode,result.stderr.toString()).toBe(0);expect(existsSync(path)).toBe(false);expect(readlinkSync(join(directory,"execute"))).toBe("/foreign/execute");expect(existsSync(join(directory,"tap-done"))).toBe(true);expect(existsSync(join(directory,"tap"))).toBe(true);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("canonical sources and moved references resolve inside the checkout without home skills",()=>{
 const names=[...CORE_SKILLS,...OPTIONAL_SKILLS,...shippedRepoLocal];
 for(const name of names){
  const source=join(repo,"skills",name,"SKILL.md"),text=readFileSync(source,"utf8");
  expect(text).toMatch(new RegExp(`^name: ["']?${name}["']?$`,"m"));
  for(const relative of new Bun.Glob("**/*.md").scanSync(join(repo,"skills",name))){
   if(relative.startsWith("scripts/"))continue;
   const path=join(repo,"skills",name,relative);
   for(const match of readFileSync(path,"utf8").matchAll(/\]\(([^)]+)\)/g)){
    const target=match[1]!.split("#")[0]!;
    if(!target || target.includes(":") || target.includes(" ") || target.startsWith("/") || target==="path")continue;
    expect(existsSync(resolve(path,"..",target)),`${path} -> ${target}`).toBe(true);
   }
  }
 }
});

for (const fullKit of [undefined, false, true]) test(`retired contributor names remove only owned links, fullKit=${fullKit}`,()=>{
 const root=mkdtempSync(join(process.env.TAP_INDEX_HOME!,"retired-contributor-")),home=join(root,"home"),directory=join(home,"skills"),manifest=join(root,"manifest.json"),config=join(root,"config");
 mkdirSync(directory,{recursive:true});mkdirSync(join(config,"tap"),{recursive:true});
 if(fullKit!==undefined)writeFileSync(join(config,"tap/config.toml"),`[skills]\nfull_kit = ${fullKit}\n`,{mode:0o600});
 const run=()=>Bun.spawnSync([process.execPath,join(repo,"runtime/bun/src/install-skill-links.ts"),"install",repo,"fixture",home],{env:{...process.env,TAP_INSTALL_MANIFEST:manifest,XDG_CONFIG_HOME:config}});
 try{
  const entries=TOMBSTONE_SKILLS.map(name=>({kind:"symlink",path:join(directory,name),target:join(repo,"skills",name)}));
  for(const e of entries)symlinkSync(e.target,e.path);
  writeFileSync(manifest,JSON.stringify({version:1,repo,entries}));
  let result=run();expect(result.exitCode,result.stderr.toString()).toBe(0);
  for(const name of [...TOMBSTONE_SKILLS,...REPO_LOCAL_SKILLS])expect(lstatSync(join(directory,name),{throwIfNoEntry:false}),name).toBeUndefined();
  // Simulate a user replacing the recorded paths after cleanup. The old
  // manifest entries must not turn those personal objects into owned links.
  symlinkSync("/foreign/coach",join(directory,"tap-coach"));
  mkdirSync(join(directory,"tap-abandon-branch"));writeFileSync(join(directory,"tap-abandon-branch/personal"),"keep");
  symlinkSync("/foreign/double-check",join(directory,"tap-double-check"));
  result=run();expect(result.exitCode,result.stderr.toString()).toBe(0);
  expect(readlinkSync(join(directory,"tap-coach"))).toBe("/foreign/coach");
  expect(readlinkSync(join(directory,"tap-double-check"))).toBe("/foreign/double-check");
  expect(readFileSync(join(directory,"tap-abandon-branch/personal"),"utf8")).toBe("keep");
 }finally{rmSync(root,{recursive:true,force:true});}
});
