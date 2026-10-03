import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeScratchTree } from "./support/scratch";
import { writeLiveFence } from "./support/live-fence";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { pasteOpenCodeText } from "../src/tmux";
import { classifySubmitFrame } from "../src/submit-frame";
import { submitVerifyLocked, type PaneEffects } from "../src/courier";

// Real regression frame, composer only. OpenCode1.18.31 Yf() summarizes
// a paste when trimmed length >150 or line count >=3; its binary contains this
// predicate immediately before lf(..., `[Pasted ~${pU} lines]`).
const collapsed=readFileSync(new URL("fixtures/opencode-capture/pasted-placeholder-160.ansi",import.meta.url),"utf8");
const wire='[[TAP v0.23 note paste-test preview="'+ 'long preview ! Unicode 😀 '.repeat(12)+'"]]';
const frame=(text:string)=>collapsed.replace("[Pasted ~1 lines]",text);

test("an opaque OpenCode placeholder alone never proves our exact wire",()=>{
 expect(classifySubmitFrame(collapsed,"opencode",wire).state).toBe("changed");
});

test("long OpenCode sentinel stays visible and courier verifies submission",()=>{
 let actual="",enters=0;const pasted:string[]=[];
 const paste=(_target:string,text:string)=>{
  pasted.push(text);
  actual += text.trim().length>150 || text.trim().split("\n").length>=3 ? "[Pasted ~1 lines]" : text;
  return true;
 };
 const fx:PaneEffects={observePane:()=>({paneId:"%9",session:"fixture",serverEpoch:"1:2",panePid:"4242",currentCommand:"opencode"}),harnessEvidence:()=>"alive",
  paneState:()=>actual?{state:"busy",text:actual}:{state:"ready"},copyMode:()=>({status:"normal"}),
  injectText:(target,text,_bracketed,permit,admit)=>pasteOpenCodeText(target,text,(target,part,_guard,admission)=>{if(admission&&!admission())return false;return paste(target,part)},permit,admit),
  pressEnter:()=>{expect(actual).toBe(enters===0?wire:"");enters++;actual="";return true},pressKeys:()=>true,
  inputHasId:()=>actual.includes("paste-test"),observeInput:()=>actual.includes("paste-test")?{state:"present",text:actual}:{state:"absent"},
  submitFrame:()=>classifySubmitFrame(frame(actual),"opencode",wire),settle:()=>{}};
 const result=submitVerifyLocked("%9","paste-test",wire,{paneId:"%9",serverEpoch:"1:2",harness:"opencode"},fx);
 expect(result.status).toBe("injected");expect(enters).toBeGreaterThan(0);expect(pasted.join("")).toBe(wire);
});

test("bounded pastes preserve Unicode and CRLF and never form a multiline summary",()=>{
 const input="x".repeat(127)+"😀\r\nsecond\nthird\rfourth";const chunks:string[]=[];
 expect(pasteOpenCodeText("%9",input,(_pane,text)=>{chunks.push(text);return true},()=>true)).toBe(true);
 expect(chunks.join("")).toBe(input);
 for(const chunk of chunks){expect(chunk.length).toBeLessThanOrEqual(128);expect(chunk.trim().split(/\r\n|\r|\n/).length).toBeLessThan(3);expect(chunk.isWellFormed()).toBe(true);}
});
for(const refusal of [false,"rate_limited"] as const)test(`partial paste stops without replay after ${refusal}`,()=>{
 const chunks:string[]=[];
 expect(pasteOpenCodeText("%9","a".repeat(400),(_pane,text)=>{chunks.push(text);return chunks.length===2?refusal:true},()=>true)).toBe(false);
 expect(chunks).toHaveLength(2);
});

for(const fault of ["late-rate-limit","replacement-pane"] as const)test(`courier keeps possible-effect custody on ${fault}`,()=>{
 let pastes=0,enters=0,epoch="1:2";
 const paste=(_target:string,_part:string)=>{pastes++;if(fault==="replacement-pane")epoch="new:server";return fault==="late-rate-limit"&&pastes===2?"rate_limited" as const:true;};
 const fx:PaneEffects={observePane:()=>({paneId:"%9",session:"fixture",serverEpoch:epoch,panePid:"4242",currentCommand:"opencode"}),harnessEvidence:()=>"alive",
  paneState:()=>({state:"ready"}),copyMode:()=>({status:"normal"}),
  injectText:(target,text,_bracketed,permit,admit)=>pasteOpenCodeText(target,text,(target,part,_guard,admission)=>{if(admission&&!admission())return false;return paste(target,part)},permit,admit),
  pressEnter:()=>{enters++;return true},pressKeys:()=>true,inputHasId:()=>false,settle:()=>{}};
 const result=submitVerifyLocked("%9","paste-test",wire,{paneId:"%9",serverEpoch:"1:2",harness:"opencode"},fx);
 expect(result.status).toBe("unverified");
 expect(pastes).toBe(fault==="replacement-pane"?1:2);expect(enters).toBe(0);
});

test("a rate limit before the first piece stays pre-effect",()=>{
 expect(pasteOpenCodeText("%9",wire,()=>"rate_limited",()=>true)).toBe("rate_limited");
});
test("missing per-piece authority refuses without a paste",()=>{
 let calls=0;
 expect(pasteOpenCodeText("%9",wire,()=>{calls++;return true})).toBe(false);
 expect(calls).toBe(0);
});
test("a thrown failure after a piece remains a possible effect",()=>{
 let calls=0;
 expect(pasteOpenCodeText("%9",wire,()=>{if(++calls===2)throw new Error("server stopped");return true},()=>true)).toBe(false);
 expect(calls).toBe(2);
});

for(const afterFirst of [false,true])test(`authorization rate limit preserves effect boundary: afterFirst=${afterFirst}`,()=>{
 let inPaste=false,pastes=0,enters=0;
 const fx:PaneEffects={observePane:()=>inPaste&&(!afterFirst||pastes>0)?"rate_limited":{paneId:"%9",session:"fixture",serverEpoch:"1:2",panePid:"4242",currentCommand:"opencode"},harnessEvidence:()=>"alive",
  paneState:()=>({state:"ready"}),copyMode:()=>({status:"normal"}),
  injectText:(target,text,_bracketed,permit,admit)=>{inPaste=true;return pasteOpenCodeText(target,text,(_target,_part,_guard,admission)=>{if(admission&&!admission())return false;pastes++;return true},permit,admit)},
  pressEnter:()=>{enters++;return true},pressKeys:()=>true,inputHasId:()=>false,settle:()=>{}};
 const result=submitVerifyLocked("%9","paste-test",wire,{paneId:"%9",serverEpoch:"1:2",harness:"opencode"},fx);
 expect(result.status).toBe(afterFirst?"unverified":"rate_limited");
 expect(pastes).toBe(afterFirst?1:0);expect(enters).toBe(0);
});


test("a pre-paste refusal leaves no durable attempt and the same payload can retry",()=>{
 const home=mkdtempSync(join(tmpdir(),"paste-admission-"));
 let inPaste=false,limited=true,actual="",pastes=0;
 const fx:PaneEffects={observePane:()=>inPaste&&limited?"rate_limited":{paneId:"%9",session:"fixture",serverEpoch:"1:2",panePid:"4242",currentCommand:"opencode"},harnessEvidence:()=>"alive",
  paneState:()=>actual?{state:"busy",text:actual}:{state:"ready"},copyMode:()=>({status:"normal"}),
  injectText:(target,text,_bracketed,permit,admit)=>{inPaste=true;return pasteOpenCodeText(target,text,(_target,part,_guard,admission)=>{if(admission&&!admission())return false;actual+=part;pastes++;return true},permit,admit)},
  pressEnter:()=>{actual="";return true},pressKeys:()=>true,inputHasId:()=>actual.includes("paste-test"),
  submitFrame:()=>classifySubmitFrame(frame(actual),"opencode",wire),settle:()=>{}};
 const authority={busHome:home,attemptIds:["paste-test"],recipient:"peer",registryPath:"",scriptsDir:"",agentFamilies:new Set(["opencode"])};
 try{
  expect(submitVerifyLocked("%9","paste-test",wire,{paneId:"%9",serverEpoch:"1:2",harness:"opencode"},fx,authority).status).toBe("rate_limited");
  expect(pastes).toBe(0);expect(existsSync(join(home,"receipts/paste-test.attempted"))).toBe(false);
  limited=false;inPaste=false;
  expect(submitVerifyLocked("%9","paste-test",wire,{paneId:"%9",serverEpoch:"1:2",harness:"opencode"},fx,authority).status).toBe("injected");
  expect(pastes).toBeGreaterThan(0);expect(existsSync(join(home,"receipts/paste-test.attempted"))).toBe(true);
 }finally{removeScratchTree(home);}
});


test("a partial paste retains its marker and rejects a fresh retry",()=>{
 const home=mkdtempSync(join(tmpdir(),"paste-partial-admission-"));
 let inPaste=false,limited=true,pastes=0;
 const fx:PaneEffects={observePane:()=>inPaste&&limited&&pastes>0?"rate_limited":{paneId:"%9",session:"fixture",serverEpoch:"1:2",panePid:"4242",currentCommand:"opencode"},harnessEvidence:()=>"alive",
  paneState:()=>({state:"ready"}),copyMode:()=>({status:"normal"}),
  injectText:(target,text,_bracketed,permit,admit)=>{inPaste=true;return pasteOpenCodeText(target,text,(_target,_part,_guard,admission)=>{if(admission&&!admission())return false;pastes++;return true},permit,admit)},
  pressEnter:()=>{throw new Error("must not submit partial text")},pressKeys:()=>true,inputHasId:()=>false,settle:()=>{}};
 const authority={busHome:home,attemptIds:["paste-test"],recipient:"peer",registryPath:"",scriptsDir:"",agentFamilies:new Set(["opencode"])};
 try{
  expect(submitVerifyLocked("%9","paste-test",wire,{paneId:"%9",serverEpoch:"1:2",harness:"opencode"},fx,authority).status).toBe("unverified");
  expect(pastes).toBe(1);expect(existsSync(join(home,"receipts/paste-test.attempted"))).toBe(true);
  limited=false;inPaste=false;
  expect(submitVerifyLocked("%9","paste-test",wire,{paneId:"%9",serverEpoch:"1:2",harness:"opencode"},fx,authority).status).toBe("attempt_evidence_unwritable");
  expect(pastes).toBe(1);
 }finally{removeScratchTree(home);}
});

for (const refusal of ["identity", "reset"] as const) for (const afterFirst of [false, true]) test(`${refusal} refusal preserves effect custody: afterFirst=${afterFirst}`, () => {
 const home=mkdtempSync(join(tmpdir(),"paste-identity-"));
 let inPaste=false,pastes=0,enters=0;
 const fx:PaneEffects={observePane:()=>{
   const denied=inPaste&&(!afterFirst||pastes>0);
   if(denied&&refusal==="reset"&&!existsSync(join(home,"reset.fence.json")))writeLiveFence(join(home,"reset.fence.json"));
   return {paneId:"%9",session:"fixture",serverEpoch:denied&&refusal==="identity"?"replacement":"1:2",panePid:"4242",currentCommand:"opencode"};
  },harnessEvidence:()=>"alive",
  paneState:()=>({state:"ready"}),copyMode:()=>({status:"normal"}),
  injectText:(target,text,_bracketed,permit,admit)=>{inPaste=true;return pasteOpenCodeText(target,text,(_target,_part,_guard,admission)=>{if(admission&&!admission())return false;pastes++;return true},permit,admit)},
  pressEnter:()=>{enters++;return true},pressKeys:()=>true,inputHasId:()=>false,settle:()=>{}};
 const authority={busHome:home,attemptIds:["paste-test"],recipient:"peer",registryPath:"",scriptsDir:"",agentFamilies:new Set(["opencode"])};
 try {
  expect(submitVerifyLocked("%9","paste-test",wire,{paneId:"%9",serverEpoch:"1:2",harness:"opencode"},fx,authority).status).toBe(afterFirst?"unverified":refusal==="identity"?"identity_mismatch":"team_reset_fenced");
  expect(pastes).toBe(afterFirst?1:0);expect(enters).toBe(0);
  expect(existsSync(join(home,"receipts/paste-test.attempted"))).toBe(afterFirst);
 } finally {removeScratchTree(home);}
});


test("replacement while admission custody is contended refuses before markers or paste",async()=>{
 const home=mkdtempSync(join(tmpdir(),"paste-admission-wait-"));let pastes=0;
 const child=Bun.spawn([process.execPath,join(import.meta.dir,"support/paste-admission-holder.ts"),home],{stdout:"pipe",stderr:"pipe"});
 try {
  const deadline=Date.now()+5000;
  while(!existsSync(join(home,"holder-ready"))&&child.exitCode===null&&Date.now()<deadline)await Bun.sleep(5);
  expect(existsSync(join(home,"holder-ready"))).toBe(true);
  const fx:PaneEffects={observePane:()=>({paneId:"%9",session:"fixture",serverEpoch:existsSync(join(home,"replacement"))?"replacement":"1:2",panePid:"4242",currentCommand:"opencode"}),harnessEvidence:()=>"alive",
   paneState:()=>({state:"ready"}),copyMode:()=>({status:"normal"}),
   injectText:(target,text,_bracketed,permit,admit)=>pasteOpenCodeText(target,text,(_target,_part,_guard,admission)=>{
    writeFileSync(join(home,"admission-start"),"");
    if(admission&&!admission())return false;pastes++;return true;
   },permit,admit),
   pressEnter:()=>{throw new Error("must not enter replacement")},pressKeys:()=>true,inputHasId:()=>false,settle:()=>{}};
  const result=submitVerifyLocked("%9","paste-test",wire,{paneId:"%9",serverEpoch:"1:2",harness:"opencode"},fx,
   {busHome:home,attemptIds:["paste-test"],recipient:"peer",registryPath: "", scriptsDir:"",agentFamilies:new Set(["opencode"])});
  expect(result.status).toBe("identity_mismatch");expect(pastes).toBe(0);
  expect(existsSync(join(home,"receipts/paste-test.attempted"))).toBe(false);
  expect(await child.exited,await new Response(child.stderr).text()).toBe(0);
 }finally{if(child.exitCode===null)child.kill();await child.exited;removeScratchTree(home);}
},10000);
