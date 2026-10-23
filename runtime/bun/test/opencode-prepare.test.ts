import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintLaunchSessionId, type LaunchRecord } from "../src/launcher/transaction";
import { removeScratchTree } from "./support/scratch";
const root=mkdtempSync(join(tmpdir(),"oc2-prepare-"));
afterAll(()=>removeScratchTree(root));
let n=0;
function fixture(over: Partial<LaunchRecord>={}, mode="ok") {
  const cwd=join(root,String(++n)),bin=join(cwd,"bin"),log=join(cwd,"calls.jsonl");mkdirSync(bin,{recursive:true});
  writeFileSync(join(bin,"opencode"),`#!/usr/bin/env bun
import {appendFileSync} from "node:fs";
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(log)},JSON.stringify({args,stateless:process.env.TAP_STATELESS,custom:process.env.OC2_CUSTOM,cwd:process.cwd()})+"\\n");
if(args.includes("--version")){console.log("opencode v2.1.2");process.exit(0)}
if(${JSON.stringify(mode)}==="transport")process.exit(1);
if(args.includes("GET")){console.log(JSON.stringify({location:{directory:process.cwd()},data:[{providerID:"capture",id:"probe",enabled:true,variants:[{id:"high"}]}]}));process.exit(0)}
const data=JSON.parse(args[args.indexOf("--data")+1]);
console.log(JSON.stringify({data:{id:"ses_prepared",location:data.location,model:data.model ? {...data.model,variant:data.model.variant ?? "default"}:undefined}}));
`,{mode:0o755});
  const env={...process.env,PATH:`${bin}:${process.env.PATH}`};
  const record:LaunchRecord={name:"team/seat",harness:"opencode",base:"team",cwd,model:"capture/probe",harness_session_id:null,
    harness_env:{OC2_CUSTOM:"preserved"},launch_tuning:{model:"capture/probe",effort:"high",qualifiers:{},environment:{}},...over};
  const calls=()=>{try{return readFileSync(log,"utf8").trim().split("\n").map(l=>JSON.parse(l))}catch{return []}};
  return {record,env,calls};
}
test("prepares the requested native model and variant before the interactive launch",async()=>{
  const f=fixture();const result=await mintLaunchSessionId(f.record,f.env);
  expect(result.harness_session_id).toBe("ses_prepared");
  expect(f.calls().every(c=>c.stateless==="1"&&c.custom==="preserved")).toBe(true);
  const create=f.calls().find(c=>c.args.includes("POST"));
  expect(create.args).toContain("--standalone");
  expect(JSON.parse(create.args[create.args.indexOf("--data")+1])).toEqual({location:{directory:realpathSync(f.record.cwd)},model:{providerID:"capture",id:"probe",variant:"high"}});
});
test("unknown model or variant refuses before creating a conversation",async()=>{
  for(const tuning of [{model:"capture/missing",effort:null},{model:"capture/probe",effort:"unknown"}]){
    const f=fixture({launch_tuning:{...tuning,qualifiers:{},environment:{}}});
    await expect(mintLaunchSessionId(f.record,f.env)).rejects.toMatchObject({errorClass:"opencode_model_unavailable"});
    expect(f.calls().some(c=>c.args.includes("POST"))).toBe(false);
  }
});
test("native resume preserves its selected model and performs no preparation",async()=>{
  const f=fixture({harness_session_id:"ses_existing"});
  expect((await mintLaunchSessionId(f.record,f.env)).harness_session_id).toBe("ses_existing");expect(f.calls()).toEqual([]);
});
test("transport failure cannot silently discard requested tuning",async()=>{
  const f=fixture({},"transport");await expect(mintLaunchSessionId(f.record,f.env)).rejects.toMatchObject({errorClass:"opencode_prepare_failed"});
});
test("without tuning, unavailable preparation keeps the id-less fallback",async()=>{
  const f=fixture({model:null,launch_tuning:{model:null,effort:null,qualifiers:{},environment:{}}},"transport");
  expect((await mintLaunchSessionId(f.record,f.env)).harness_session_id).toBeNull();
});

 test("crew prepares a fresh session only at the launch effect",async()=>{
  const {crewRecipeInvocation}=await import("../src/launcher/crew-invocation");
  const f=fixture();
  const row={harness:"opencode",model:"capture/probe",harness_env:{OC2_CUSTOM:"preserved"},passthrough:["--variant","high"],cwd:f.record.cwd,permissions:"auto"};
  const preview=await crewRecipeInvocation("team","crew",row,f.env);
  expect(preview.command).not.toContain("--model");expect(f.calls()).toEqual([]);
  const launched=await crewRecipeInvocation("team","crew",row,f.env,true);
  expect(launched.command).toContain("--standalone --session ses_prepared");
  expect(launched.command).not.toContain("--variant");
  expect(f.calls().find(c=>c.args.includes("POST"))).toBeDefined();
});

test("an OpenCode preset variant reaches native session preparation",async()=>{
  const {readSecureBytes,configDirectory,isRegularFile}=await import("../src/launcher/catalog");
  const {loadPresetCatalog,requirePreset}=await import("../src/launcher/catalog-listing");
  const {launchInvocation}=await import("../src/launcher/invocation");
  const {Notices}=await import("../src/launcher/catalog-notices");
  const f=fixture();const config=join(f.record.cwd,"config");mkdirSync(join(config,"tap"),{recursive:true});
  writeFileSync(join(config,"tap/config.toml"),'version=3\n[presets.oc]\nharness="opencode"\nparams.model="capture/probe"\nparams.variant="high"\n',{mode:0o600});
  const env={...f.env,XDG_CONFIG_HOME:config};const preset=requirePreset(loadPresetCatalog(env,()=>{},readSecureBytes,configDirectory(env),isRegularFile),"oc");
  const record={...f.record,model:preset.model,harness_passthrough:preset.harness_passthrough,launch_tuning:undefined};
  launchInvocation("new",record,new Notices(()=>{}),{env});
  const prepared=await mintLaunchSessionId(record,env);
  const call=f.calls().find(c=>c.args.includes("POST"));
  expect(JSON.parse(call.args[call.args.indexOf("--data")+1]).model).toEqual({providerID:"capture",id:"probe",variant:"high"});
  expect(launchInvocation("new",prepared,new Notices(()=>{}),{env}).argv).toEqual(["opencode","--standalone","--session","ses_prepared"]);
});

 test("preparation fallback uses the command notice suppression",async()=>{
  const {Notices}=await import("../src/launcher/catalog-notices");
  const messages:string[]=[];const notices=new Notices(message=>messages.push(message));
  const f=fixture({model:null,launch_tuning:{model:null,effort:null,qualifiers:{},environment:{}}},"transport");
  notices.suppress(true);
  await mintLaunchSessionId(f.record,f.env,undefined,notices);
  expect(messages).toEqual([]);
  notices.suppress(false);
  await mintLaunchSessionId(f.record,f.env,undefined,notices);
  expect(messages).toHaveLength(1);expect(messages[0]).toContain("launching without a prepared session");
  notices.reset();messages.length=0;
  await mintLaunchSessionId(f.record,{...f.env,TAP_JSON:"1"},undefined,notices);
  expect(messages).toEqual([]);
});

test("model-only preparation accepts the native default variant",async()=>{
  const f=fixture({launch_tuning:{model:"capture/probe",effort:null,qualifiers:{},environment:{}}});
  expect((await mintLaunchSessionId(f.record,f.env)).harness_session_id).toBe("ses_prepared");
  const create=f.calls().find(c=>c.args.includes("POST"));
  expect(JSON.parse(create.args[create.args.indexOf("--data")+1]).model).toEqual({providerID:"capture",id:"probe"});
});

for (const token of ["-mcapture/probe", "-m=capture/probe", "--model=capture/probe"]) test(`attached OpenCode model survives preparation: ${token}`,async()=>{
  const {launchInvocation}=await import("../src/launcher/invocation");
  const {Notices}=await import("../src/launcher/catalog-notices");
  const f=fixture({model:null,launch_tuning:undefined,harness_tail:[token]});
  launchInvocation("new",f.record,new Notices(()=>{}),{env:f.env});
  await mintLaunchSessionId(f.record,f.env);
  const create=f.calls().find(c=>c.args.includes("POST"));
  expect(JSON.parse(create.args[create.args.indexOf("--data")+1]).model).toEqual({providerID:"capture",id:"probe"});
});
test("inline OpenCode variants persist the same tuning as a separate variant",async()=>{
  const {launchInvocation}=await import("../src/launcher/invocation");
  const {Notices}=await import("../src/launcher/catalog-notices");
  const f=fixture({model:"capture/probe#high",launch_tuning:undefined});
  launchInvocation("new",f.record,new Notices(()=>{}),{env:f.env});
  const prepared=await mintLaunchSessionId(f.record,f.env);
  expect(prepared.launch_tuning).toEqual({model:"capture/probe",effort:"high",qualifiers:{},environment:{}});
});
test("version and API probes use the target launch directory",async()=>{
  const f=fixture();await mintLaunchSessionId(f.record,f.env);
  expect(f.calls().every(c=>c.cwd===realpathSync(f.record.cwd))).toBe(true);
});
