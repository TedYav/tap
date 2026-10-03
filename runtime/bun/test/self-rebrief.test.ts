import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBrief, parseOptions, clearCommand, freshIdentity, sameSeat, transcriptIdentity, runRecovery, type Request, type Receipt, type Effects } from "../src/self-rebrief";
import { removeScratchTree } from "./support/scratch";
import type { Seat } from "../src/registry";
const root = mkdtempSync(join(tmpdir(), "self-rebrief-"));
afterAll(() => removeScratchTree(root));
const request: Request = { id: "test", registry: join(root,"registry.json"), bus:root, team:"team", handle:"worker", oldSession:"old",oldTranscript:join(root,"old.jsonl"), command:"/clear", handoff:join(root,"brief.md"),notify:"owner",bound:{paneId:"%5",instance:"original",serverEpoch:"epoch",bootId:"boot",harness:"codex",handle:"worker"}};
const seat: Seat = {pane_id:"%5",instance:"original",server_epoch:"epoch",boot_id:"boot",harness:"codex",harness_session_id:"old",transcript_path:request.oldTranscript};
function fixture(overrides: Partial<Effects> = {}) {
  let time=0; const log:string[]=[]; const receipts:Receipt[]=[];
  let recoveryId="";
  const fx: Effects = {row:()=>seat,idle:()=>true,submit:()=>{log.push("clear");return{status:"injected"};},send:(to,body,id)=>{log.push(`send:${to}`);if(id)recoveryId=id;expect(body).not.toContain("rebrief succeeded");return{rc:0,disposition:"queued-spool"};},record:r=>receipts.push(r),fresh:()=>({session:"new",transcript:join(root,"new.jsonl")}),firstInput:()=>recoveryId?`[[TAP v0.23 note ${recoveryId}]]`:null,now:()=>time,wait:async()=>{time+=1000;},...overrides};
  return {fx,log,receipts};
}
test("required authored inputs and owner; plain clear accepts no free text",()=>{
  expect(()=>parseOptions(["rebrief","--handoff","x"])).toThrow("--notify");
  expect(()=>parseOptions(["clear","surprise"])).toThrow("unexpected");
  expect(()=>parseOptions(["clear","--charter","x"])).toThrow("--handoff");
  expect(()=>parseOptions(["clear","--handoff","x","--handoff","y"])).toThrow("duplicate");
  expect(parseOptions(["rebrief","--handoff","x","--notify","leader"])).toMatchObject({verb:"rebrief",handoff:"x",notify:"leader"});
});
test("durable brief is charter then handoff; invalid second source publishes nothing",()=>{
  const handoff=join(root,"source.md"), charter=join(root,"charter.md");writeFileSync(handoff,"unfinished commitment");writeFileSync(charter,"continuing purpose");
  const path=copyBrief(root,"good",handoff,charter)!;const text=readFileSync(path,"utf8");
  expect(text.indexOf("continuing purpose")).toBeLessThan(text.indexOf("unfinished commitment"));
  writeFileSync(charter," \n");expect(()=>copyBrief(root,"bad",handoff,charter)).toThrow("nonempty");expect(existsSync(join(root,"handoff/bad.md"))).toBe(false);
  expect(()=>copyBrief(root,"missing",join(root,"missing"))).toThrow();
  writeFileSync(charter,Buffer.from([255]));expect(()=>copyBrief(root,"invalid",handoff,charter)).toThrow();
});
test("native identity requires same seat, changed conversation, and corroborating transcript",()=>{
  const transcript=join(root,"new.jsonl");writeFileSync(transcript,JSON.stringify({type:"session_meta",payload:{id:"new"}})+"\n");
  const next={...seat,harness_session_id:"new",transcript_path:transcript};
  expect(freshIdentity(request,next)).toEqual({session:"new",transcript});
  for(const altered of [{...next,instance:"replacement"},{...next,pane_id:"%6"},{...next,server_epoch:"other"},{...next,boot_id:"other"},{...next,harness_session_id:"old"},{...next,harness_session_id:"wrong"},{...next,transcript_path:request.oldTranscript}])expect(freshIdentity(request,altered)).toBeNull();
  expect(sameSeat(request,{...seat,status:"gone"})).toBe(false);
  expect(transcriptIdentity(transcript,"codex","wrong")).toBe(false);
  writeFileSync(transcript,JSON.stringify({sessionId:"new",isSidechain:true})+"\n");expect(transcriptIdentity(transcript,"claude","new")).toBe(false);
  writeFileSync(transcript,JSON.stringify({sessionId:"new",type:"system"})+"\n");expect(transcriptIdentity(transcript,"claude","new")).toBe(true);
});
test("waits for observed reset before publishing the recovery; reports queue honestly",async()=>{
  let samples=0;const f=fixture({fresh:()=>++samples>=3?{session:"new",transcript:"/new"}:null});
  await runRecovery(request,f.fx,8000);expect(f.log).toEqual(["clear","send:worker"]);expect(samples).toBe(4);
  expect(f.receipts.map(r=>r.state)).toEqual(["submitted","reset-observed","reset-observed","recovery-accepted"]);
  expect(f.receipts.at(-1)).toMatchObject({delivery:"queued-spool",witness:"native-id-changed"});
  expect(f.receipts.at(-1)?.detail).toContain("recipient brief read remains unverified");
});
test("never injects into a busy turn or resets a replaced seat",async()=>{
  const busy=fixture({idle:()=>false});await runRecovery(request,busy.fx,3000);expect(busy.log).toEqual(["send:owner"]);
  const changed=fixture({row:()=>({...seat,instance:"new"})});await runRecovery(request,changed.fx);expect(changed.log).toEqual(["send:owner"]);
});
test("uncertain submit is not retried and does not wake the old session",async()=>{
  let submits=0;const f=fixture({submit:()=>{submits++;return{status:"unverified",detail:"changed composer"};},fresh:()=>null});
  await runRecovery(request,f.fx);expect(submits).toBe(1);expect(f.log).toEqual(["send:owner"]);expect(f.receipts.at(-1)?.state).toBe("incomplete");
});
test("timeout preserves brief and notifies owner without delivering to old conversation",async()=>{
  const f=fixture({fresh:()=>null});await runRecovery(request,f.fx,4000);expect(f.log).toEqual(["clear","send:owner"]);expect(f.receipts.at(-1)?.detail).toContain("brief retained");
});
test("wake failure after reset never submits another reset",async()=>{
  const f=fixture();const original=f.fx.send;f.fx.send=(to,body)=>{original(to,body);return{rc:5,disposition:"unverified"};};
  await runRecovery(request,f.fx);expect(f.log).toEqual(["clear","send:worker","send:owner"]);expect(f.receipts.at(-1)?.detail).toContain("do not reset again");
});
test("clear spellings preserve supported family mapping and refuse unknown",()=>{
  for(const h of ["claude","codex","cursor-agent","agy","hermes"])expect(clearCommand(h)).toBe("/clear");
  expect(clearCommand("opencode")).toBe("/new");expect(clearCommand("shell")).toBe("");
});

test("tap self rejects malformed rebrief before resolving any seat",()=>{
  const path=new URL("../main.ts",import.meta.url).pathname;
  const result=Bun.spawnSync([process.execPath,path,"self","rebrief","--handoff","absent"],{env:{...process.env},stdout:"pipe",stderr:"pipe"});
  expect(result.exitCode).toBe(1);expect(result.stderr.toString()).toContain("requires --handoff FILE and --notify");
});

test("the shared native submit path accepts a bare clear without a sentinel marker",async()=>{
  const {submitVerifyLocked}=await import("../src/courier");
  const {classifySubmitFrame}=await import("../src/submit-frame");
  let text="",enters=0;const pasted:string[]=[];
  const result=submitVerifyLocked("%5","rebrief-test","/clear",undefined,{
    observePane:()=>({paneId:"%5",session:"test",serverEpoch:"srv:1:1",panePid:"42",currentCommand:"codex"}),
    paneState:()=>({state:"ready"}),injectText:(_,input)=>{text=input;pasted.push(input);return true;},
    inputHasId:()=>false,pressEnter:()=>{enters++;text="";return true;},settle:()=>{},
    submitFrame:()=>classifySubmitFrame(`› ${text}\n`,"codex","/clear"),
  });
  expect(result.status).toBe("injected");expect(pasted).toEqual(["/clear"]);expect(enters).toBe(1);
});

test("recovery idle observation preserves Codex paint and refuses drafts, working title and epoch drift",async()=>{
  const {recoveryIdle}=await import("../src/self-rebrief");
  let painted=true, title="Review task", epoch="epoch";
  const fx: NonNullable<Parameters<typeof recoveryIdle>[1]> = {
    observePane:()=>({paneId:"%5",session:"team/worker",serverEpoch:epoch,panePid:"42",currentCommand:"codex"}),
    capturePane:(_pane,escaped)=>({code:0,stderr:"",stdout:`› ${painted&&escaped?"\x1b[2m":""}Ask Codex to do anything\x1b[0m\n\n  gpt-6-astra xhigh · Context 71% left\n`}),
    tmuxReadOnly:()=>({code:0,stderr:"",stdout:title}),
  };
  expect(recoveryIdle(request,fx)).toBe(true);
  painted=false;expect(recoveryIdle(request,fx)).toBe(false);
  painted=true;title="⠋ Working";expect(recoveryIdle(request,fx)).toBe(false);
  title="Review task";epoch="other";expect(recoveryIdle(request,fx)).toBe(false);
});

test("late idle boundary retains a full post-submit observation window",async()=>{
  let idleChecks=0, freshChecks=0;
  const f=fixture({idle:()=>++idleChecks>=2,fresh:()=>++freshChecks>=3?{session:"new",transcript:"/new"}:null});
  await runRecovery(request,f.fx,3000);
  expect(f.log).toEqual(["clear","send:worker"]);
  expect(f.fx.now()).toBe(4000);
  expect(f.receipts.at(-1)?.state).toBe("recovery-accepted");
});

test("reset submission refuses conversation drift before injection or Enter",async()=>{
  const {submitVerifyLocked}=await import("../src/courier");
  const {classifySubmitFrame}=await import("../src/submit-frame");
  const registry=join(root,"reset-guard-registry.json");
  const save=(session:string,instance="original")=>writeFileSync(registry,JSON.stringify({schema:"0.20",team:{name:"team"},seats:{worker:{...seat,instance,harness_session_id:session}}}));
  for(const drift of ["none","before-inject","before-enter","after-enter","after-enter-instance"]){
    save(drift==="before-inject"?"replacement":"old");
    let text="";const effects:string[]=[];
    const result=submitVerifyLocked("%5",`reset-${drift}`,"/clear",{...request.bound,bootId:undefined},{
      observePane:()=>({paneId:"%5",session:"test",serverEpoch:"epoch",panePid:"42",currentCommand:"codex"}),
      harnessEvidence:()=>"alive",paneState:()=>({state:"ready"}),copyMode:()=>({status:"normal"}),
      injectText:(_,input)=>{effects.push("inject");text=input;if(drift==="before-enter")save("replacement");return true;},
      inputHasId:()=>false,pressEnter:()=>{
        effects.push("enter");text="";
        if(drift.startsWith("after-enter"))save("new",drift==="after-enter-instance"?"replacement":"original");
        return true;
      },settle:()=>{},
      submitFrame:()=>classifySubmitFrame(`› ${text}\n`,"codex","/clear"),
    },{registryPath:registry,expectedNativeSession:"old",scriptsDir:"/unused",agentFamilies:new Set(["codex"])});
    // Staged text is already an effect: a refused Enter must retain uncertainty.
    expect(result.status).toBe(drift==="before-inject"?"identity_mismatch":
      drift==="before-enter"||drift==="after-enter-instance"?"unverified":"injected");
    expect(effects).toEqual(drift==="before-inject"?[]:drift==="before-enter"?["inject"]:["inject","enter"]);
  }
});

test("observed Codex clear menu owns only the exact command and submits at most once",async()=>{
  const {classifySubmitFrame}=await import("../src/submit-frame");
  const {submitVerifyLocked}=await import("../src/courier");
  const menu=readFileSync(new URL("fixtures/self-rebrief/codex-clear-menu.ansi",import.meta.url),"utf8");
  expect(classifySubmitFrame(menu,"codex","/clear").state).toBe("staged");
  for(const changed of [menu.replace("/clear","/clear extra"),menu+"human draft\n",menu.replace("clear the terminal","delete the terminal")])
    expect(classifySubmitFrame(changed,"codex","/clear").state).not.toBe("staged");
  for(const sticky of [false,true]){
    let enters=0;const writes:string[]=[];
    const result=submitVerifyLocked("%5","clear-menu","/clear",undefined,{
      observePane:()=>({paneId:"%5",session:"test",serverEpoch:"epoch",panePid:"42",currentCommand:"codex"}),
      paneState:()=>({state:"ready"}),injectText:(_,text)=>{writes.push(text);return true;},inputHasId:()=>false,
      pressEnter:()=>{enters++;return true;},settle:()=>{},
      submitFrame:()=>classifySubmitFrame(enters&&!sticky?"› \x1b[2mAsk Codex to do anything\x1b[0m\n":menu,"codex","/clear"),
    },{registryPath: "", scriptsDir:"/unused",agentFamilies:new Set(["codex"]),singleEnter:true});
    expect(enters).toBe(1);expect(writes).toEqual(["/clear"]);
    expect(result.status).toBe(sticky?"unverified":"injected");
  }
});

test("Codex bootstrap requires positive fresh UI, not missing old content",async()=>{
  const {codexUiTransition}=await import("../src/self-rebrief");
  // Reset header/footer transcribed from the live 12:28:23Z capture; placeholder paint constructed.
  const before="prior conversation\n› \x1b[2mAsk Codex to do anything\x1b[0m\nContext 71% left";
  const after="│ >_ OpenAI Codex (v0.155.0) │\nTo continue this session, run codex resume, then select Review (old)\n› \x1b[2mAsk Codex to do anything\x1b[0m\n  gpt-6-astra xhigh · Context 100% left";
  expect(codexUiTransition(before,after,"old")).toBe(true);
  for(const frame of ["",before,after.replace("100%","71%"),after.replace("(old)","(other)"),after.replace("OpenAI Codex","Other CLI"),after.replace("\x1b[2m","")])
    expect(codexUiTransition(before,frame,"old")).toBe(false);
  expect(codexUiTransition(after,after,"old")).toBe(false);
});

test("Codex bootstrap waits for native identity and recovery-first input; read remains unverified",async()=>{
  const f=fixture({fresh:()=>f.log.includes("send:worker")?{session:"new",transcript:"/new"}:null,uiTransition:()=>true});
  await runRecovery(request,f.fx,5000);
  expect(f.log).toEqual(["clear","send:worker"]);
  expect(f.receipts.map(r=>r.state)).toEqual(["submitted","recovery-pending-proof","reset-observed","recovery-accepted"]);
  expect(f.receipts.at(-1)).toMatchObject({witness:"codex-ui-transition",newSession:"new"});
  expect(f.receipts.at(-1)?.detail).toContain("recipient brief read remains unverified");
});

test("Codex post-input mismatch reports delivery-miss; absent native proof times out without resetting again",async()=>{
  for(const proof of ["wrong-input","no-native"]){
    const f=fixture({uiTransition:()=>true,firstInput:()=>"unrelated work",fresh:()=>
      proof==="wrong-input"&&f.log.includes("send:worker")?{session:"new",transcript:"/new"}:null});
    await runRecovery(request,f.fx,4000);
    expect(f.log).toEqual(["clear","send:worker","send:owner"]);
    expect(f.receipts.at(-1)?.state).toBe(proof==="wrong-input"?"delivery-miss":"incomplete");
  }
});

test("Claude keeps native pre-delivery witness and never takes Codex UI bootstrap",async()=>{
  const claudeRequest={...request,bound:{...request.bound,harness:"claude"}};
  const f=fixture({row:()=>({...seat,harness:"claude"}),fresh:()=>null,uiTransition:()=>true});
  await runRecovery(claudeRequest,f.fx,3000);
  expect(f.log).toEqual(["clear","send:owner"]);
  const pass=fixture({row:()=>({...seat,harness:"claude"}),firstInput:()=>"not consulted"});
  await runRecovery(claudeRequest,pass.fx,3000);
  expect(pass.receipts.at(-1)).toMatchObject({state:"recovery-accepted",witness:"native-id-changed",detail:"durable recovery accepted; recipient read remains unverified"});
});

test("already-used fresh Codex conversation refuses recovery before placement",async()=>{
  const f=fixture({firstInput:()=>"unrelated work submitted before observer poll"});
  await runRecovery(request,f.fx,3000);
  expect(f.log).toEqual(["clear","send:owner"]);
  expect(f.receipts.at(-1)).toMatchObject({state:"delivery-miss",witness:"native-id-changed"});
  expect(f.receipts.at(-1)?.detail).toContain("recovery not sent");
  expect(f.receipts.some(r=>r.firstInput==="unrelated work submitted before observer poll")).toBe(true);
});

test("recovery-first proof accepts quoted preview but refuses mixed first input",async()=>{
  for(const suffix of ["",' preview="Read brief with \\"quotes\\" and ]] text"',"]] extra work [[TAP v0.23 note other"]){
    const f=fixture({firstInput:()=>`[[TAP v0.23 note recovery${suffix}]]`});
    await runRecovery({...request,recoveryId:"recovery"},f.fx,3000);
    expect(f.receipts.at(-1)?.state).toBe(suffix.startsWith("]]")?"delivery-miss":"recovery-accepted");
  }
});

test("first Codex input skips startup records and never skips unrelated first work",async()=>{
  const {firstCodexInput}=await import("../src/self-rebrief");
  const path=join(root,"first-input.jsonl");
  const user=(text:string)=>({type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text}]}});
  writeFileSync(path,[user("AGENTS startup"),{type:"turn_context",payload:{}},user("unrelated first"),user("[[TAP v0.23 note recovery]]")].map(event=>JSON.stringify(event)).join("\n"));
  expect(firstCodexInput(path)).toBe("unrelated first");
  writeFileSync(path,JSON.stringify({type:"event_msg",payload:{type:"user_message",message:"event-format first"}}));
  expect(firstCodexInput(path)).toBe("event-format first");
});
