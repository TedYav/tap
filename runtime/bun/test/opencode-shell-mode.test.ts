import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { opencodeShellMode, opencodeBoxText, OPENCODE_SHELL_MODE_REASON } from "../src/opencode-composer";
import { classifyPane, toPaneBand } from "../src/pane-state";
import { detectAgentState } from "../src/agent-state";
import { deliveryBand, deliveryDisposition } from "../src/slices/delivery-disposition";
import { submitVerifyLocked, type PaneEffects } from "../src/courier";
const frame=readFileSync(join(import.meta.dir,"fixtures/opencode-capture/shell-mode-staged-160.ansi"),"utf8");
const plain=frame.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,"");
test("real shell-mode frame has a distinct blocked state, never chat input",()=>{
 for(const capture of [frame,plain,plain.replace(/\[\[TAP[^\n]*/,"human command draft")]){
  expect(opencodeShellMode(capture)).toBe(true);
  expect(classifyPane(capture,"opencode",false)).toEqual({kind:"no-band",cause:"shell-mode",reason:OPENCODE_SHELL_MODE_REASON});
  expect(detectAgentState("opencode",capture)).toEqual({agentState:"blocked",reason:"shell_mode"});
  expect(opencodeBoxText(capture)).toBe(null);
  expect(deliveryBand(null,"opencode",capture)).toBe("shell-mode");
 }
 expect(opencodeShellMode(plain.replace("Shell","Build · model"))).toBe(false);
 expect(opencodeShellMode(plain.replace("esc exit shell mode","ctrl+p commands"))).toBe(false);
 const normal=readFileSync(join(import.meta.dir,"fixtures/opencode-capture/welcome-124.ansi"),"utf8");
 expect(opencodeShellMode(plain+"\n"+normal)).toBe(false);
 for(const urgent of [false,true])expect(deliveryDisposition({band:"shell-mode",harness:"opencode",urgent,noSpool:false,recipientBound:true})).toMatchObject({action:"park",parkReason:"shell-mode",graceSeconds:0});
});
test("shell mode refuses all courier keys even with force/no-prompt authority",()=>{
 const effects:string[]=[];
 const fx:PaneEffects={observePane:()=>({paneId:"%9",session:"fixture",serverEpoch:"1:2",panePid:"4242",currentCommand:"opencode"}),harnessEvidence:()=>"alive",
  paneState:()=>toPaneBand(classifyPane(frame,"opencode",false)),copyMode:()=>({status:"normal"}),
  injectText:()=>{effects.push("inject");return true},pressEnter:()=>{effects.push("enter");return true},pressKeys:()=>{effects.push("keys");return true},inputHasId:()=>false,settle:()=>{}};
 const result=submitVerifyLocked("%9","test-id","[[TAP v0.23 note test-id]]",{paneId:"%9",serverEpoch:"1:2",harness:"opencode"},fx,
  {recipient:"peer",registryPath: "", scriptsDir:"",agentFamilies:new Set(["opencode"]),noPromptOk:true,forceNoPrompt:true,deliveryFacts:{noSpool:true,urgent:true,recipientBound:true}});
 expect(result).toMatchObject({status:"band_busy",cause:"shell-mode",detail:OPENCODE_SHELL_MODE_REASON,disposition:{action:"park",parkReason:"shell-mode",graceSeconds:0}});expect(effects).toEqual([]);
});

test("OpenCode courier text uses bracketed paste; other harnesses retain literal typing",()=>{
 for(const harness of ["opencode","codex"]){
  let pasted=false,entered=false;const injections:Array<[string,boolean|undefined]>=[];
  const fx:PaneEffects={observePane:()=>({paneId:"%9",session:"fixture",serverEpoch:"1:2",panePid:"4242",currentCommand:harness}),harnessEvidence:()=>"alive",
   paneState:()=>({state:"ready"}),copyMode:()=>({status:"normal"}),
   injectText:(_target,text,bracketed)=>{injections.push([text,bracketed]);pasted=true;return true},pressEnter:()=>{entered=true;return true},pressKeys:()=>true,inputHasId:()=>pasted&&!entered,
   observeInput:()=>pasted&&!entered?{state:"present",text:"test-id"}:{state:"absent"},submitFrame:()=>({state:entered?"empty":"staged",mode:"idle",width:"160"}),settle:()=>{}};
  const wire='[[TAP v0.23 note test-id preview="!authority"]]';
  const result=submitVerifyLocked("%9","test-id",wire,{paneId:"%9",serverEpoch:"1:2",harness},fx);
  expect(result.status).toBe("injected");expect(injections).toEqual([[wire,harness==="opencode"]]);
 }
});


test("shell mode appearing at the final read refuses paste despite no-prompt authority",()=>{
 let reads=0;const effects:string[]=[];
 const fx:PaneEffects={observePane:()=>({paneId:"%9",session:"fixture",serverEpoch:"1:2",panePid:"4242",currentCommand:"opencode"}),harnessEvidence:()=>"alive",
  paneState:()=>++reads===1?{state:"ready"}:toPaneBand(classifyPane(frame,"opencode",false)),copyMode:()=>({status:"normal"}),
  injectText:()=>{effects.push("inject");return true},pressEnter:()=>{effects.push("enter");return true},pressKeys:()=>{effects.push("keys");return true},inputHasId:()=>false,settle:()=>{}};
 const result=submitVerifyLocked("%9","late-shell-id","[[TAP v0.23 note late-shell-id]]",{paneId:"%9",serverEpoch:"1:2",harness:"opencode"},fx,
  {recipient:"peer",registryPath: "", scriptsDir:"",agentFamilies:new Set(["opencode"]),noPromptOk:true,forceNoPrompt:true});
 expect(reads).toBe(2);
 expect(result).toMatchObject({status:"band_busy",cause:"shell-mode",detail:OPENCODE_SHELL_MODE_REASON,disposition:{action:"park",parkReason:"shell-mode",graceSeconds:0}});
 expect(effects).toEqual([]);
});
