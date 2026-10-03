import {test,expect} from 'bun:test';
import {readFileSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {submitVerifyLocked,type PaneEffects} from '../src/courier';
import {phaseRows,unresolvedInjection} from '../src/submit-phase';
import {classifySubmitFrame,cursorComposer} from '../src/submit-frame';
const frame=readFileSync(new URL('./fixtures/cursor-followup-queued.ansi',import.meta.url),'utf8');
const wire='[[TAP v0.23 ask aspen-d5-instance-20260907T110821Z-a2a9c612bee4]]';
test('observed Cursor queue has empty composer and queued wire',()=>{
 expect(cursorComposer(frame)).toBe('');
 expect(classifySubmitFrame(frame,'cursor',wire)).toMatchObject({state:'queued'});
});

test('queue state requires owned wire, empty bounded input, and active turn',()=>{
 expect(classifySubmitFrame(frame.replace(wire,wire.slice(0,-2)),'cursor',wire).state).not.toBe('queued');
 expect(classifySubmitFrame(frame.replace('ctrl+c to stop',''),'cursor',wire).state).not.toBe('queued');
 expect(classifySubmitFrame(frame.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,''),'cursor',wire).state).toBe('changed');
 expect(classifySubmitFrame(frame.replace(/▀/g,'x'),'cursor',wire).state).toBe('unobservable');
 const human=frame.split('\n').map(line=>line.includes('→')?'→ human draft':line).join('\n');
 expect(classifySubmitFrame(human,'cursor',wire).state).toBe('changed');
});

test('old Claude box cannot establish an empty newer composer',()=>{
 const capture=readFileSync(new URL('../../../skills/tap/scripts/smoke/fixtures/submit-verify/claude-queue-after.ansi',import.meta.url),'utf8');
 const expected='[[TAP v0.23 note willow-sentinel-test-20260906T144128Z-d26c789b3cec]]';
 expect(classifySubmitFrame(capture+'\n❯ human draft\nesc to interrupt','claude',expected).state).toBe('unobservable');
});

for(const lateDrift of [false,true,"between-enters"] as const) test(`queued phase preserves Enter count and late identity guard: drift=${lateDrift}`,()=>{
 const home=mkdtempSync(join(tmpdir(),'harness-queue-phase-'));mkdirSync(join(home,'receipts'));
 const id='aspen-d5-instance-20260907T110821Z-a2a9c612bee4';let enters=0,drift=false;const sequence:string[]=[];
 try {
  const fx:PaneEffects={
   observePane:()=>({paneId:drift?'%2':'%1',session:'fixture',serverEpoch:'srv:1:1',currentCommand:'cursor'} as any),
   harnessEvidence:()=> 'alive',paneState:()=>({state:'ready'}),injectText:()=>{sequence.push("text");return true;},inputHasId:()=>true,
   pressEnter:()=>{enters++;sequence.push("Enter");return true;},settle:(seconds)=>{if(seconds===0.25){sequence.push("pause");if(lateDrift==="between-enters")drift=true;}},
   submitFrame:()=>{if(enters) {const result=classifySubmitFrame(frame,'cursor',wire);if(enters>1||lateDrift==="between-enters")drift=!!lateDrift;return result;}return {state:'staged',mode:'working',width:'80'};},
  };
  const result=submitVerifyLocked('%1',id,wire,{paneId:'%1',harness:'cursor',serverEpoch:'srv:1:1'},fx,{busHome:home,recipient:'peer',registryPath: "", scriptsDir:join(import.meta.dir,'../../../skills/tap/scripts'),agentFamilies:new Set()});
  expect(result.status).toBe(lateDrift?'unverified':'harness_queued');expect(enters).toBe(lateDrift==="between-enters"?1:lateDrift?2:3);expect(sequence).toEqual(lateDrift==="between-enters"?["text","Enter","pause"]:lateDrift?["text","Enter","pause","Enter"]:["text","Enter","pause","Enter","Enter"]);
  expect(phaseRows(home,id).at(-1)).toMatchObject({result:lateDrift?'unverified':'queued',enter_count:lateDrift==="between-enters"?1:lateDrift?2:3});
  if(!lateDrift) expect(unresolvedInjection(home,id)).toContain('queued in harness');
 } finally {rmSync(home,{recursive:true,force:true});}
 });

// tap-ho6pk follow-up (codex P2): flushing a DIFFERENT staged sentinel first
// runs a nested verifyStaged whose harvest must not hand its earliest-busy
// evidence to the requested payload. Old sentinel lands busy; the payload then
// fast-starts from an idle seat — its relabel decides on ITS OWN landing read.
const opencodeIdle=readFileSync(new URL('../../../skills/tap/scripts/smoke/fixtures/peek-harness-adapters/opencode-wide-idle.ansi',import.meta.url),'utf8');
const opencodeWorking=readFileSync(new URL('../../../skills/tap/scripts/smoke/fixtures/peek-harness-adapters/opencode-wide-working.ansi',import.meta.url),'utf8');
const flushId='queued-label-20260924T110000Z-aaaaaaaaaaaa';
const flushWire=`[[TAP v0.23 note ${flushId}]]`;
const opencodeId='queued-label-20260924T120000Z-0123456789ab';
const opencodeWire=`[[TAP v0.23 note ${opencodeId}]]`;
const opencodeStaged=(capture:string)=>{
 const lines=capture.split('\n');
 const footer=lines.findIndex((line)=>/┃\s*Build ·/.test(line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'')));
 lines.splice(footer,0,`  ┃  ${opencodeWire}`);
 return lines.join('\n');
};
const opencodeAccepted=(capture:string)=>{
 const lines=capture.split('\n');
 const at=lines.findIndex((line)=>line.includes('TAP v=0.3'));
 let end=at; while(!lines[end]!.includes('.md]]')) end++;
 lines.splice(at,end-at+1,`  ┃  ${opencodeWire}`);
 return lines.join('\n');
};
test('nested existing-sentinel flush does not leak its busy evidence into the payload relabel',()=>{
 const home=mkdtempSync(join(tmpdir(),'harness-queue-flush-'));mkdirSync(join(home,'receipts'));
 try {
  const literal=(busy:boolean)=>({state:'staged',mode:'working',width:'80',busy});
  const script:any[]=[
   literal(true),
   {state:'queued',mode:'working',width:'80',busy:true,inferred:true},
   {frame:classifySubmitFrame(opencodeStaged(opencodeIdle),'opencode',opencodeWire)},
   {frame:classifySubmitFrame(opencodeAccepted(opencodeWorking),'opencode',opencodeWire)},
  ];
  let scriptAt=0;
  const nextFrame=()=>{
   const entry=script[scriptAt<script.length-1?scriptAt++:scriptAt];
   return 'frame' in entry ? entry.frame : entry;
  };
  let bandReads=0;
  const fx:PaneEffects={
   observePane:()=>({paneId:'%1',session:'fixture',serverEpoch:'srv:1:1',currentCommand:'opencode'} as any),
   harnessEvidence:()=>'alive',
   paneState:()=>(++bandReads===1?{state:'busy',text:flushWire}:{state:'ready'}),
   injectText:()=>true,inputHasId:()=>true,pressEnter:()=>true,settle:()=>{},
   submitFrame:()=>nextFrame(),
  };
  const result=submitVerifyLocked('%1',opencodeId,opencodeWire,{paneId:'%1',harness:'opencode',serverEpoch:'srv:1:1'},fx,
   {busHome:home,recipient:'peer',registryPath: "", scriptsDir:join(import.meta.dir,'../../../skills/tap/scripts'),agentFamilies:new Set(),preserveDraft:false});
  expect(result.status).toBe('injected');
 } finally {rmSync(home,{recursive:true,force:true});}
});
