import {installSpoolPane} from "./support/spool-pane";
import {expect,test} from "bun:test";
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {classifyPane,toPaneBand,claudeFeedbackCard,CLAUDE_FEEDBACK_DRAFT_REASON} from "../src/pane-state";
import {deliveryBand,deliveryDisposition} from "../src/slices/delivery-disposition";
import {noticeBody} from "../src/notice";
import {classifySubmitFrame, composerInput, enterReady, sentinelSubmitDecision, visibleSentinelId} from "../src/submit-frame";
import {submitStagedLocked,submitVerifyLocked,type PaneEffects,type StagedContext} from "../src/courier";
import {readPaneReady} from "../src/spool-readiness";
import {frameIo,pendingInputRegionText,pendingInputText} from "../src/pane/reader";
import {feedbackCardBehavior,feedbackCardBehaviorOrHold} from "../src/injection-behavior";

// Claude Code's feedback-draft card is a notice, not a modal (tap-89a57). Over a
// complete composer it is ignored. A composer it hides is a hold: its "empty" hint
// is no evidence, because the September 2026 card drew it over a typed sentinel
// (found in review). Under injection.feedback_card=dismiss (default) the courier
// sends one Escape per card and reads the revealed composer the normal way.
// Provenance: claude-feedback-provenance.md.
const root=new URL("../../../",import.meta.url).pathname;
const fixtureDir=root+"skills/tap/scripts/smoke/fixtures/peek-harness-adapters/";
const fixture=(name:string)=>readFileSync(`${fixtureDir}${name}.ansi`,"utf8");
const plainFixture=(name:string)=>readFileSync(`${fixtureDir}${name}.txt`,"utf8");
const hiddenEmpty=fixture("claude-feedback-card-empty-hidden");
const hiddenText=fixture("claude-feedback-card-text-hidden");
const afterEnter=fixture("claude-feedback-card-after-enter");
const visible=fixture("claude-feedback-card-visible");
const partial=fixture("claude-feedback-card-partial");
const hidden71=fixture("claude-feedback-card-hidden-71x22");
const dismissed=fixture("claude-feedback-card-dismissed-71x22");
const legacy=fixture("claude-feedback-legacy-hidden-text");
const queuedTail=fixture("claude-feedback-card-queued-tail");
const septEmpty=fixture("claude-feedback-empty-constructed");
const septTruncated=fixture("claude-feedback-truncated");
const wire="[[TAP v0.23 note feedback-fixture]]";
/** A plain frame with this text typed into its empty composer row. */
const typedInto=(name:string,text:string)=>{
 const frame=plainFixture(name).replace(/^❯[^\S\n]*$/m,`❯ ${text}`);
 expect(frame).toContain(`❯ ${text}`);
 return frame;
};

test("the card's verdict on each live and constructed frame",()=>{
 for(const capture of [hiddenEmpty,hidden71,partial,legacy]) expect(claudeFeedbackCard(capture)?.composer).toBe("hidden");
 for(const capture of [hiddenText,septTruncated]) expect(claudeFeedbackCard(capture)?.composer).toBe("text");
 // queuedTail: live, two drafts queued, so the hint ends "· +1 more queued".
 for(const capture of [visible,septEmpty,queuedTail]) expect(claudeFeedbackCard(capture)?.composer).toBe("visible");
 for(const capture of [afterEnter,dismissed]) expect(claudeFeedbackCard(capture)).toBe(null);
 // The card's own rows name the observation; the frame around them does not.
 expect(claudeFeedbackCard(hiddenEmpty)?.card).toBe(claudeFeedbackCard(hiddenEmpty.replace("Cooked for","Baked for"))?.card);
 expect(claudeFeedbackCard(hiddenEmpty)?.card).not.toBe(claudeFeedbackCard(hidden71)?.card);
});

for(const [name,capture] of [["visible 100x30",visible],["September visible",septEmpty]] as const) {
 test(`a card over a complete empty composer (${name}) reads ready through every native reader`,()=>{
  expect(classifyPane(capture,"claude",false)).toEqual({kind:"ready"});
  expect(deliveryBand("","claude",capture)).toBe("bare");
  // composerInput keeps raw rows; September's constructed composer carries blank continuation rows.
  const composer=composerInput(capture,"claude");
  expect(composer.state==="text"&&composer.text.trim()).toBe("");
  expect(pendingInputText(frameIo(capture,"58"),"fixture","claude")).toEqual({status:"text",text:""});
 });
}

for(const [name,capture] of [["hidden 58x24",hiddenEmpty],["hidden 71x22",hidden71],["prompt row only 80x24",partial],["September, cropped",legacy],["typed text 58x24",hiddenText],["September",septTruncated]] as const) {
 test(`a composer the card hides (${name}) holds in every reader`,()=>{
  expect(classifyPane(capture,"claude",false)).toEqual({kind:"no-band",cause:"feedback-draft",reason:CLAUDE_FEEDBACK_DRAFT_REASON});
  expect(deliveryBand(null,"claude",capture)).toBe("feedback-draft");
  expect(composerInput(capture,"claude")).toEqual({state:"blocked"});
  expect(pendingInputText(frameIo(capture,"80"),"fixture","claude")).toEqual({status:"blocked"});
  expect(classifySubmitFrame(capture,"claude",wire).state).toBe("unobservable");
 });
}

test("the dismissed card's turn-off prompt leaves the composer readable",()=>{
 expect(classifyPane(dismissed,"claude",false)).toEqual({kind:"ready"});
 expect(pendingInputText(frameIo(dismissed,"71"),"fixture","claude")).toEqual({status:"text",text:""});
});

test("a card above a visible composer leaves a staged wire submittable",()=>{
 const id="opus-feedback-20261114T000000Z-0123456789ab";
 const staged=`[[TAP v0.23 note ${id}]]`;
 const capture=typedInto("claude-feedback-card-visible",staged);
 for(const alive of [false,true]){
  expect(sentinelSubmitDecision(capture,"claude",staged,alive)).toEqual({action:"submit"});
  expect(classifySubmitFrame(capture,"claude",staged,"58",alive).state).toBe("staged");
  expect(visibleSentinelId(capture,"claude",alive)).toBe(id);
  expect(enterReady(capture,capture,"claude",staged,id,false,false,alive,"bypass",false,true)).toBe("ready");
 }
});

test("a hidden composer never shows nudge a wire to Enter",()=>{
 for(const capture of [hiddenEmpty,hiddenText]){
  expect(visibleSentinelId(capture,"claude",true)).toBe(null);
  expect(sentinelSubmitDecision(capture,"claude",wire,true).action).toBe("withhold");
 }
});

/** A private config and index home for one test. */
const scratchEnv=(feedbackCard?:string)=>{
 const dir=mkdtempSync(join(process.env.TMUX_TMPDIR??tmpdir(),"claude-feedback-env-"));
 mkdirSync(join(dir,"xdg","tap"),{recursive:true});
 mkdirSync(join(dir,"index"),{recursive:true});
 if(feedbackCard!==undefined) writeFileSync(join(dir,"xdg","tap","config.toml"),`[injection]\nfeedback_card = "${feedbackCard}"\n`);
 return {dir,env:{...process.env,XDG_CONFIG_HOME:join(dir,"xdg"),TAP_INDEX_HOME:join(dir,"index")}};
};

test("injection.feedback_card defaults to dismiss, reads hold, and fails safe to hold",()=>{
 for(const [value,expected] of [[undefined,"dismiss"],["dismiss","dismiss"],["hold","hold"]] as const){
  const s=scratchEnv(value);
  try { expect(feedbackCardBehavior(s.env)).toBe(expected); expect(feedbackCardBehaviorOrHold(s.env)).toBe(expected); }
  finally { rmSync(s.dir,{recursive:true,force:true}); }
 }
 const bad=scratchEnv("escape");
 try {
  expect(()=>feedbackCardBehavior(bad.env)).toThrow("injection.feedback_card must be dismiss or hold");
  expect(feedbackCardBehaviorOrHold(bad.env)).toBe("hold");
 } finally { rmSync(bad.dir,{recursive:true,force:true}); }
});

test("readiness admits one dismissal for a hidden card, and holds hidden text or the hold setting",()=>{
 for(const setting of [undefined,"hold"]){
  const s=scratchEnv(setting);
  try {
   mkdirSync(join(s.dir,"bus"),{recursive:true});
   const registry=join(s.dir,"bus","registry.json");
   const env={...s.env,TAP_HOME:join(s.dir,"bus")};
   const pane=installSpoolPane(s.dir,registry,env,"claude");
   const run=()=>String(readPaneReady({pane:"fixture:0.0",paneId:"%401",handle:"peer",toTeam:"fixture",targetRegistry:registry,policy:""},join(s.dir,"bus"),env));
   writeFileSync(pane.frame,hiddenEmpty);expect(run()).toBe(setting==="hold"?"busy:feedback-draft":"recover:feedback-card");
   writeFileSync(pane.frame,hiddenText);expect(run()).toBe("busy:feedback-draft");
   writeFileSync(pane.frame,visible);expect(run()).toBe("ready");
  } finally { rmSync(s.dir,{recursive:true,force:true}); }
 }
});

test("Claude box adapter preserves multiline draft bytes",()=>{
 const raw="────────────────────\n❯   first  \n  second   \n────────────────────\nfooter";
 expect(pendingInputRegionText(frameIo(raw,"200"),"fixture","claude")).toEqual({status:"text",text:"first  \n  second   "});
});

test("card-looking transcript, cards in other states and foreign boxes are not a card",()=>{
 const plain=hiddenEmpty.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,"");
 const card=plain.slice(plain.indexOf("╭"),plain.indexOf("╰")+plain.slice(plain.indexOf("╰")).indexOf("\n"));
 const composer="────────────────────\n❯ \n────────────────────";
 expect(claudeFeedbackCard(card+"\nThis was a prior report.\n"+composer)).toBe(null);
 expect(claudeFeedbackCard("────────────────────\n❯ "+card+"\n────────────────────")).toBe(null);
 expect(claudeFeedbackCard(hiddenEmpty.replace("0 to dismiss","0 unrelated"))).toBe(null);
 expect(claudeFeedbackCard(hiddenEmpty.replace("Bug report drafted:","quoted report:"))).toBe(null);
 // Confirm-send, sending and error states are a human mid-decision: unrecognized, so they hold as unreadable.
 const confirm=hiddenEmpty.replace("1 to review · 2 to send · 0 to dismiss","Send without reviewing? 2 to send ");
 expect(claudeFeedbackCard(confirm)).toBe(null);
 expect(classifyPane(confirm,"claude",false)).toEqual({kind:"no-band",reason:"no recognized Claude input box"});
});

test("a card quoted on a draft's continuation rows is the human's text, not a live card",()=>{
 // Composer continuation rows are indented two columns; the live card starts at column 0.
 const plain=hiddenEmpty.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,"");
 const card=plain.slice(plain.indexOf("╭"),plain.indexOf("╰")+plain.slice(plain.indexOf("╰")).indexOf("\n")).split("\n");
 const fence="─".repeat(58);
 // The viewport ends at the composer's bottom fence, so nothing below it vetoes.
 const draft=["older transcript",fence,"❯ quoting the card for a bug report:",...card.map(row=>"  "+row),fence].join("\n");
 expect(claudeFeedbackCard(draft)).toBe(null);
 expect(classifyPane(draft,"claude",false)).toMatchObject({kind:"draft"});
});

test("the card's other labels and its queued-draft tail are recognized",()=>{
 expect(claudeFeedbackCard(hiddenEmpty.replace("Bug report drafted:","Feature request drafted:"))?.composer).toBe("hidden");
 expect(claudeFeedbackCard(hiddenEmpty.replace("1 to review · 2 to send · 0 to dismiss                 ","1 to review · 2 to send · 0 to dismiss · +2 more queued"))?.composer).toBe("hidden");
 expect(claudeFeedbackCard(hiddenText.replace("clear text to review, send, or dismiss                 ","clear text to review, send, or dismiss · +1 more queued"))?.composer).toBe("text");
});

test("feedback-draft parks under its own reason, urgent or not",()=>{
 for(const urgent of [false,true])expect(deliveryDisposition({band:"feedback-draft",harness:"claude",urgent,noSpool:false,recipientBound:true})).toMatchObject({action:"park",parkReason:"feedback-draft",graceSeconds:0});
 expect(deliveryBand(null,"claude","────────────────────\n❯ \n────────────────────")).toBe("unobservable");
});

const bound={paneId:"%1",serverEpoch:"1:2",harness:"claude"};
const fxFor=(band:()=>ReturnType<PaneEffects["paneState"]>,effects:string[]):PaneEffects=>({
 observePane:()=>({paneId:"%1",session:"fixture",serverEpoch:"1:2",panePid:"4242",currentCommand:"claude"}),harnessEvidence:()=>"alive",
 paneState:band,copyMode:()=>({status:"normal"}),
 injectText:()=>{effects.push("inject");return true},pressEnter:()=>{effects.push("enter");return true},pressKeys:()=>{effects.push("keys");return true},inputHasId:()=>false,settle:()=>{}});

/**
 * A live pane that starts with the card hiding an empty composer. Escape shows
 * `onEscape` (the live dismissed frame by default); a paste stages the wire in that
 * composer; Enter starts the turn and the composer empties.
 */
const livePane=(effects:string[],onEscape:()=>string=()=>plainFixture("claude-feedback-card-dismissed-71x22"),start=hiddenEmpty)=>{
 let capture=start;
 const fx:PaneEffects={...fxFor(()=>toPaneBand(classifyPane(capture,"claude",false)),effects),
  pressKeys:(_t,keys)=>{effects.push(`keys:${keys.join(",")}`);if(keys.join()==="Escape")capture=onEscape();return true},
  injectText:()=>{effects.push("inject");capture=typedInto("claude-feedback-card-dismissed-71x22",wire);return true},
  pressEnter:()=>{effects.push("enter");capture=afterEnter;return true},
  captureEscaped:()=>({ok:true,frame:capture}),
  observeInput:()=>({state:"absent"}),
  submitFrame:(_t,command,expected,alive)=>classifySubmitFrame(capture,command,expected,"71",alive)};
 return fx;
};
const withEnv=(env:NodeJS.ProcessEnv)=>({recipient:"peer",registryPath:"",scriptsDir:"",agentFamilies:new Set(["claude"]),env});

test("dismiss: one Escape clears the card, then the revealed composer takes ordinary delivery",()=>{
 const s=scratchEnv();
 try {
  const effects:string[]=[];
  const result=submitVerifyLocked("%1","feedback-fixture",wire,bound,livePane(effects),withEnv(s.env));
  expect(result.status).toBe("injected");
  // The Escape, one paste, the submitting Enter, then the ordinary completion Enter on the empty composer.
  expect(effects).toEqual(["keys:Escape","inject","enter","enter"]);
 } finally { rmSync(s.dir,{recursive:true,force:true}); }
});

test("hold: a hidden composer gets no key at all",()=>{
 const s=scratchEnv("hold");
 try {
  const effects:string[]=[];
  const result=submitVerifyLocked("%1","feedback-fixture",wire,bound,livePane(effects),withEnv(s.env));
  expect(result).toMatchObject({status:"band_busy",cause:"feedback-draft"});
  expect(effects).toEqual([]);
 } finally { rmSync(s.dir,{recursive:true,force:true}); }
});

test("the older card's empty hint over hidden typed text: dismiss sends one key and holds on the text; hold sends none",()=>{
 // A reviewer's falsifier: the September capture cropped to hide its typed composer row.
 // After the Escape, the card is gone and the composer shows the text it held.
 const revealed=()=>{
  const rows=septTruncated.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,"").split("\n");
  const top=rows.findIndex(row=>row.startsWith("╭")), bottom=rows.findIndex(row=>row.startsWith("╰"));
  const prompt=rows.findIndex(row=>row.startsWith("❯"));
  return [...rows.slice(0,top),...rows.slice(bottom+1,prompt+1),"─".repeat(80)].join("\n");
 };
 expect(classifyPane(revealed(),"claude",false)).toMatchObject({kind:"draft"});
 for(const setting of [undefined,"hold"]){
  const s=scratchEnv(setting);
  try {
   const effects:string[]=[];
   const result=submitVerifyLocked("%1","legacy-hidden",wire,bound,livePane(effects,revealed,legacy),withEnv(s.env));
   expect(result.status).toBe("band_busy");
   expect(effects).toEqual(setting==="hold"?[]:["keys:Escape"]);
  } finally { rmSync(s.dir,{recursive:true,force:true}); }
 }
});

test("a card still up after its one Escape holds, and no sender gets a second Escape for that card",()=>{
 const s=scratchEnv();
 try {
  const effects:string[]=[];
  const stuck=()=>hiddenEmpty;
  expect(submitVerifyLocked("%1","first",wire,bound,livePane(effects,stuck),withEnv(s.env))).toMatchObject({status:"band_busy",cause:"feedback-draft"});
  expect(submitVerifyLocked("%1","second",wire,bound,livePane(effects,stuck),withEnv(s.env))).toMatchObject({status:"band_busy",cause:"feedback-draft"});
  expect(effects).toEqual(["keys:Escape"]);
  // A different card on the same pane is a new observation.
  expect(submitVerifyLocked("%1","third",wire,bound,livePane(effects,stuck,hidden71),withEnv(s.env))).toMatchObject({status:"band_busy"});
  expect(effects).toEqual(["keys:Escape","keys:Escape"]);
 } finally { rmSync(s.dir,{recursive:true,force:true}); }
});

test("a pane process or card that changes at the key boundary gets no Escape (found in review)",()=>{
 // After the two samples and the first authorize, the license is minted; the
 // next authorize, at the key, sees a replaced process showing a human draft.
 const replaced="────────────────────────────────────────\n❯ human draft in replacement process\n────────────────────────────────────────\n";
 for(const change of ["process","card"] as const){
  const s=scratchEnv();
  try {
   const effects:string[]=[];
   let frame=hiddenEmpty, captures=0, postSample=0;
   const fx:PaneEffects={...livePane(effects),
    observePane:()=>{
     let panePid="4242";
     if(captures===2&&++postSample>=2){ if(change==="process") panePid="4343"; frame=change==="process"?replaced:hidden71; }
     return {paneId:"%1",session:"fixture",serverEpoch:"1:2",panePid,currentCommand:"claude"} as any;
    },
    paneState:()=>toPaneBand(classifyPane(frame,"claude",false)),
    captureEscaped:()=>{captures++;return {ok:true,frame}}};
   const result=submitVerifyLocked("%1",`key-race-${change}`,wire,bound,fx,withEnv(s.env));
   expect(effects).toEqual([]);
   if(change==="process") expect(result.status).toBe("identity_mismatch");
   else expect(result).toMatchObject({status:"band_busy",cause:"feedback-draft"});
  } finally { rmSync(s.dir,{recursive:true,force:true}); }
 }
});

test("a card that changes between the two samples gets no key",()=>{
 const s=scratchEnv();
 try {
  const effects:string[]=[];
  const frames=[hiddenEmpty,hidden71];
  let reads=0;
  const fx:PaneEffects={...livePane(effects),captureEscaped:()=>({ok:true,frame:frames[Math.min(reads++,1)]!})};
  expect(submitVerifyLocked("%1","changing",wire,bound,fx,withEnv(s.env))).toMatchObject({status:"band_busy",cause:"feedback-draft"});
  expect(effects).toEqual([]);
 } finally { rmSync(s.dir,{recursive:true,force:true}); }
});

test("a card hiding typed text gets no Escape",()=>{
 const s=scratchEnv();
 try {
  const effects:string[]=[];
  expect(submitVerifyLocked("%1","typed",wire,bound,livePane(effects,()=>hiddenText,hiddenText),withEnv(s.env))).toMatchObject({status:"band_busy",cause:"feedback-draft"});
  expect(effects).toEqual([]);
 } finally { rmSync(s.dir,{recursive:true,force:true}); }
});

test("a card that hides the wire after the paste is landing evidence only for a paste onto a positively empty composer",()=>{
 for(const cardWitness of [undefined,false,true]){
  const effects:string[]=[];
  const fx:PaneEffects={...fxFor(()=>({state:"ready"}),effects),
   submitFrame:(_t,command,expected,alive)=>classifySubmitFrame(effects.includes("enter")?afterEnter:hiddenText,command,expected,"58",alive)};
  const ctx:StagedContext={pane:"%1",target:"%1",bound,fx,authority:undefined,command:"claude",auto:false,urgent:false,cardWitness};
  const result=submitStagedLocked(ctx,"feedback-fixture",wire,false,{record:()=>undefined,admit:()=>null,bumpOrdinal:()=>{},bumpEnter:()=>{}});
  expect(result.status).toBe(cardWitness?"injected":"unverified");
  expect(effects).toEqual(cardWitness?["enter"]:[]);
 }
});

const authority={recipient:"peer",registryPath:"",scriptsDir:"",agentFamilies:new Set(["claude"]),noPromptOk:true,forceNoPrompt:true,deliveryFacts:{noSpool:true,urgent:false,recipientBound:true}};
const held={status:"band_busy",cause:"feedback-draft",detail:CLAUDE_FEEDBACK_DRAFT_REASON,disposition:{action:"park",parkReason:"feedback-draft",graceSeconds:0}};
test("a card hiding text refuses every courier key even with force/no-prompt authority",()=>{
 const effects:string[]=[];
 const result=submitVerifyLocked("%1","feedback-fixture",wire,bound,fxFor(()=>toPaneBand(classifyPane(hiddenText,"claude",false)),effects),authority);
 expect(result).toMatchObject(held);expect(effects).toEqual([]);
});
test("a hidden composer appearing at the final read refuses paste despite no-prompt authority",()=>{
 let reads=0;const effects:string[]=[];
 const result=submitVerifyLocked("%1","late-feedback",wire,bound,
  fxFor(()=>toPaneBand(classifyPane(++reads===1?visible:hiddenText,"claude",false)),effects),authority);
 expect(reads).toBe(2);expect(result).toMatchObject(held);expect(effects).toEqual([]);
});

test("the hold notice keeps its first line and names Escape as the cure",()=>{
 const body=noticeBody("feedback-draft","msg-1","nightwatch","","","n-1");
 expect(body.split("\n")[0]).toBe("DELIVERY HELD: msg-1 to nightwatch is blocked by the Claude feedback-draft panel.");
 expect(body).toContain("A human, or nightwatch's leader, dismisses the card (Esc on an empty composer)");
 expect(body).toContain("at most one Escape per card");
 expect(body).not.toContain("press 0");
});

test("negative controls: idle and a permission modal are not a card",()=>{
 const agent=(name:string)=>readFileSync(new URL(`./fixtures/agent-state/claude/${name}.txt`,import.meta.url),"utf8");
 const idle=agent("idle-real");
 expect(classifyPane(idle,"claude",false)).toEqual({kind:"ready"});
 expect(deliveryBand("","claude",idle)).toBe("bare");
 const modal=classifyPane(agent("blocked-real"),"claude",false);
 expect(modal).toMatchObject({kind:"no-band",reason:"human approval prompt is visible"});
 expect("cause" in modal).toBe(false);
 expect(deliveryBand(null,"claude",agent("blocked-real"))).toBe("unobservable");
});
