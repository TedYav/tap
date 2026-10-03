import {installSpoolPane} from "./support/spool-pane";
import {expect,test} from "bun:test";
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {classifyPane,toPaneBand,claudeFeedbackOverlay,CLAUDE_FEEDBACK_DRAFT_REASON} from "../src/pane-state";
import {deliveryBand,deliveryDisposition} from "../src/slices/delivery-disposition";
import {noticeBody} from "../src/notice";
import {classifySubmitFrame, enterReady, sentinelSubmitDecision, visibleSentinelId} from "../src/submit-frame";
import {submitVerifyLocked,type PaneEffects} from "../src/courier";
import {readPaneReady} from "../src/spool-readiness";
import {frameIo,pendingInputRegionText,pendingInputText} from "../src/pane/reader";
const root=new URL("../../../",import.meta.url).pathname;
const fixture=(name:string)=>readFileSync(root+`skills/tap/scripts/smoke/fixtures/peek-harness-adapters/${name}.ansi`,"utf8");
const empty=fixture("claude-feedback-empty-constructed");
const original=fixture("claude-feedback-truncated");
const wire="[[TAP v0.23 note feedback-fixture]]";
for(const [name,capture] of [["original",original],["empty with complete composer",empty]] as const) {
 test(`Claude feedback ${name} parks through the native readers`,()=>{
  expect(classifyPane(capture,"claude",false)).toEqual({kind:"no-band",cause:"feedback-draft",reason:CLAUDE_FEEDBACK_DRAFT_REASON});
  expect(deliveryBand(null,"claude",capture)).toBe("feedback-draft");
  expect(classifySubmitFrame(capture,"claude",wire).state).toBe("unobservable");
  expect(pendingInputText(frameIo(capture,"200"),"fixture","claude")).toEqual({status:"blocked"});
 });
}
test("feedback over a usable empty composer causes no native input or Enter effects",()=>{
 let effects=0;
 const fx:PaneEffects={
  observePane:()=>({paneId:"%1",session:"fixture",serverEpoch:"srv:1:1",currentCommand:"claude"} as any),
  paneState:()=>toPaneBand(classifyPane(empty,"claude",false)),
  injectText:()=>{effects++;return true;},pressEnter:()=>{effects++;return true;},inputHasId:()=>true,settle:()=>{},
  submitFrame:()=>classifySubmitFrame(empty,"claude",wire),
 };
 expect(submitVerifyLocked("%1","feedback-fixture",wire,undefined,fx).status).toBe("band_busy");
 expect(effects).toBe(0);
});
test("readiness names feedback as its own non-forceable hold",()=>{
 // Native observation runs over executable pane facts.
 const root=mkdtempSync(join(process.env.TMUX_TMPDIR??tmpdir(),"claude-feedback-"));
 try {
  mkdirSync(join(root,"bus"),{recursive:true});
  const registry=join(root,"bus","registry.json");
  const env={...process.env,TAP_HOME:join(root,"bus"),TAP_INDEX_HOME:join(root,"index")};
  const pane=installSpoolPane(root,registry,env,"claude");writeFileSync(pane.frame,empty);
  const run=()=>String(readPaneReady({pane:"fixture:0.0",paneId:"%401",handle:"peer",toTeam:"fixture",targetRegistry:registry,policy:""},join(root,"bus"),env));
  expect(run()).toBe("busy:feedback-draft");
  const doc=JSON.parse(readFileSync(registry,"utf8"));doc.team.name="elsewhere";writeFileSync(registry,JSON.stringify(doc));
  expect(run()).toBe("gone");
 } finally { rmSync(root,{recursive:true,force:true}); }
});

test("Claude box adapter preserves multiline draft bytes",()=>{
 const raw="────────────────────\n❯   first  \n  second   \n────────────────────\nfooter";
 expect(pendingInputRegionText(frameIo(raw,"200"),"fixture","claude")).toEqual({status:"text",text:"first  \n  second   "});
});
test("panel-looking transcript or input and incomplete controls do not block",()=>{
 const plain=original.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,"");
 const panel=plain.slice(plain.indexOf("╭"),plain.indexOf("╰")+plain.slice(plain.indexOf("╰")).indexOf("\n"));
 const composer="────────────────────\n❯ \n────────────────────";
 expect(claudeFeedbackOverlay(panel+"\nThis was a prior report.\n"+composer)).toBe(false);
 expect(claudeFeedbackOverlay("────────────────────\n❯ "+panel+"\n────────────────────")).toBe(false);
 expect(claudeFeedbackOverlay(empty.replace("0 to dismiss","0 unrelated"))).toBe(false);
 expect(claudeFeedbackOverlay(empty.replace("Bug report drafted:","quoted report:"))).toBe(false);
});
test("feedback appearing after injection refuses the per-Enter proof",()=>{
 const capture=empty.replace("❯ ",`❯ ${wire}`);
 expect(enterReady(capture,capture,"claude",wire,"feedback-fixture",false,false,false,"bypass",false,true)).toBe("withhold");
});

test("feedback-draft parks under its own reason, urgent or not",()=>{
 for(const urgent of [false,true])expect(deliveryDisposition({band:"feedback-draft",harness:"claude",urgent,noSpool:false,recipientBound:true})).toMatchObject({action:"park",parkReason:"feedback-draft",graceSeconds:0});
 expect(deliveryBand(null,"claude","────────────────────\n❯ \n────────────────────")).toBe("unobservable");
});
const authority={recipient:"peer",registryPath:"",scriptsDir:"",agentFamilies:new Set(["claude"]),noPromptOk:true,forceNoPrompt:true,deliveryFacts:{noSpool:true,urgent:false,recipientBound:true}};
const fxFor=(band:()=>ReturnType<PaneEffects["paneState"]>,effects:string[]):PaneEffects=>({
 observePane:()=>({paneId:"%1",session:"fixture",serverEpoch:"1:2",panePid:"4242",currentCommand:"claude"}),harnessEvidence:()=>"alive",
 paneState:band,copyMode:()=>({status:"normal"}),
 injectText:()=>{effects.push("inject");return true},pressEnter:()=>{effects.push("enter");return true},pressKeys:()=>{effects.push("keys");return true},inputHasId:()=>false,settle:()=>{}});
const held={status:"band_busy",cause:"feedback-draft",detail:CLAUDE_FEEDBACK_DRAFT_REASON,disposition:{action:"park",parkReason:"feedback-draft",graceSeconds:0}};
test("feedback-draft refuses every courier key even with force/no-prompt authority",()=>{
 const effects:string[]=[];
 const result=submitVerifyLocked("%1","feedback-fixture",wire,{paneId:"%1",serverEpoch:"1:2",harness:"claude"},fxFor(()=>toPaneBand(classifyPane(empty,"claude",false)),effects),authority);
 expect(result).toMatchObject(held);expect(effects).toEqual([]);
});
test("feedback-draft appearing at the final read refuses paste despite no-prompt authority",()=>{
 let reads=0;const effects:string[]=[];
 const ready=empty.replace(/╭[\s\S]*╰[^\n]*\n/,"");
 expect(classifyPane(ready,"claude",false).kind).toBe("ready");
 const result=submitVerifyLocked("%1","late-feedback",wire,{paneId:"%1",serverEpoch:"1:2",harness:"claude"},
  fxFor(()=>toPaneBand(classifyPane(++reads===1?ready:empty,"claude",false)),effects),authority);
 expect(reads).toBe(2);expect(result).toMatchObject(held);expect(effects).toEqual([]);
});
test("feedback-draft notice names the seat and the human-or-leader dismissal, and never offers an automatic one",()=>{
 const body=noticeBody("feedback-draft","msg-1","nightwatch","","","n-1");
 expect(body.split("\n")[0]).toBe("DELIVERY HELD: msg-1 to nightwatch is blocked by the Claude feedback-draft panel.");
 expect(body).toContain("A human, or nightwatch's leader, dismisses the panel");
 expect(body).toContain("will not send, review, or dismiss the draft");
});
test("negative controls: idle, a permission modal and a stale transcript panel are not feedback-draft",()=>{
 const agent=(name:string)=>readFileSync(new URL(`./fixtures/agent-state/claude/${name}.txt`,import.meta.url),"utf8");
 const idle=agent("idle-real");
 expect(classifyPane(idle,"claude",false)).toEqual({kind:"ready"});
 expect(deliveryBand("","claude",idle)).toBe("bare");
 const modal=classifyPane(agent("blocked-real"),"claude",false);
 expect(modal).toMatchObject({kind:"no-band",reason:"human approval prompt is visible"});
 expect("cause" in modal).toBe(false);
 expect(deliveryBand(null,"claude",agent("blocked-real"))).toBe("unobservable");
 const plain=original.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,"");
 const panel=plain.slice(plain.indexOf("╭"),plain.indexOf("╰")+plain.slice(plain.indexOf("╰")).indexOf("\n"));
 const stale=panel+"\nThis was a prior report.\n────────────────────\n❯ \n────────────────────";
 expect(classifyPane(stale,"claude",false)).not.toMatchObject({cause:"feedback-draft"});
 expect(deliveryBand("","claude",stale)).toBe("bare");
});
test("a live harness never licenses Enter under a feedback panel that appeared after paste",()=>{
 const id="opus-feedback-20261001T000000Z-0123456789ab";
 const staged=`[[TAP v0.23 note ${id}]]`;
 const capture=empty.replace("❯ ",`❯ ${staged}`);
 for(const alive of [false,true]){
  expect(sentinelSubmitDecision(capture,"claude",staged,alive)).toEqual({action:"withhold",reason:"dialog"});
  expect(classifySubmitFrame(capture,"claude",staged,"200",alive).state).not.toBe("staged");
  expect(visibleSentinelId(capture,"claude",alive)).toBe(null);
  expect(enterReady(capture,capture,"claude",staged,id,false,false,alive,"bypass",false,true)).toBe("withhold");
 }
 const clear=capture.replace(/╭[\s\S]*╰[^\n]*\n/,"");
 expect(sentinelSubmitDecision(clear,"claude",staged,true)).toEqual({action:"submit"});
});
for(const noPromptOk of [false,true]) test(`a panel appearing after paste refuses Enter in the staged loop (noPromptOk=${noPromptOk})`,()=>{
 const effects:string[]=[];let pasted=false;
 const ready=empty.replace(/╭[\s\S]*╰[^\n]*\n/,"");
 const fx:PaneEffects={...fxFor(()=>toPaneBand(classifyPane(ready,"claude",false)),effects),
  injectText:()=>{effects.push("inject");pasted=true;return true},
  observeInput:()=>pasted?{state:"present",text:wire}:{state:"absent"},
  submitFrame:(_t,command,expected,alive)=>classifySubmitFrame(pasted?empty.replace("❯ ",`❯ ${wire}`):ready,command,expected,"200",alive)};
 const result=submitVerifyLocked("%1","feedback-fixture",wire,{paneId:"%1",serverEpoch:"1:2",harness:"claude"},fx,
  {recipient:"peer",registryPath: "", scriptsDir:"",agentFamilies:new Set(["claude"]),noPromptOk});
 expect(effects).toEqual(["inject"]);
 expect(result).toMatchObject({status:"unverified",cause:"feedback-draft",detail:CLAUDE_FEEDBACK_DRAFT_REASON});
});
