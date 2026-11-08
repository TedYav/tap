// Run as its own entry: the filesystem witness precedes the owners' first imports.
import { afterAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
let cacheReads = 0, registryReads = 0;
const read = fs.readFileSync;
const spy = spyOn(fs, "readFileSync").mockImplementation(((path: any, ...args: any[]) => {
  if (String(path).includes("/runtime-cache/roster-")) cacheReads++;
  if (String(path).endsWith("/registry.json")) registryReads++;
  return (read as (...args: any[]) => any)(path, ...args);
}) as typeof fs.readFileSync);
const { rosterCache } = await import("../src/roster-cache");
const { boundPaneIdentityState } = await import("../src/observe-gather");
const { readPaneReady } = await import("../src/spool-readiness");
const { withAgentStates } = await import("../src/roster-observation");
const { submitVerifyLocked } = await import("../src/courier");
const { classifySubmitFrame } = await import("../src/submit-frame");
const { recordPhase } = await import("../src/submit-phase");
const { DEFAULT_AGENT_FAMILIES } = await import("../src/observe");
const { installSpoolPane } = await import("./support/spool-pane");
const { removeScratchTree } = await import("./support/scratch");
const roots: string[] = [];
afterAll(() => { spy.mockRestore(); for (const root of roots) removeScratchTree(root); });
const scripts = join(import.meta.dir, "../../../skills/tap/scripts");
function scratch() { const root = fs.mkdtempSync(join(tmpdir(),"cache-effects.")); roots.push(root); return root; }
function warm(home: string) {
  const cache = rosterCache(join(home,"runtime-cache"),"full",{},60);
  cache.write({rows:[],hierarchyRows:[],serverEpoch:"srv:1:1",callerSocket:"/fixture"});
  cacheReads = 0; expect(cache.read()).not.toBeNull(); expect(cacheReads).toBe(1); cacheReads = 0;
}

test("warm roster cache cannot replace delivery identity or live readiness", () => {
  const root = scratch(), home = join(root,"bus"), registry = join(home,"registry.json");
  fs.mkdirSync(join(home,"watch"),{recursive:true});
  const env = {...process.env, TAP_HOME:home, TAP_INDEX_HOME:join(root,"index"), TAP_SPOOL_DISABLE_DELIVERER:"1", TAP_TUI_SETTLE_SCALE:"0.1", TAP_VERBOSE:"0"};
  const fixture = installSpoolPane(root, registry, env, "claude", true);
  const prefix = {pane:fixture.seat.pane,paneId:fixture.seat.pane_id,handle:"peer",toTeam:"fixture",targetRegistry:registry,policy:""};
  fs.writeFileSync(fixture.frame,read(join(scripts,"smoke/fixtures/pane-state/claude/idle-band.ansi")));
  warm(home); registryReads = 0;
  expect(boundPaneIdentityState(registry,"peer",prefix.pane,prefix.paneId,env)).toBe("match");
  expect(readPaneReady(prefix,home,env)).toBe("ready");
  const previousEnv = process.env;
  try {
    process.env = {...env};
    const row = {handle:"peer",harness:"claude",delivery:"pane",pane:prefix.pane,observedPaneId:prefix.paneId,
      observedServerEpoch:fixture.seat.server_epoch,status:"active"} as Parameters<typeof withAgentStates>[0][number];
    for (const state of ["idle", "working"] as const) {
      fs.writeFileSync(fixture.frame,read(join(import.meta.dir,`fixtures/agent-state/claude/${state}.txt`)));
      expect(withAgentStates([row],{computeJobs:()=>[]})[0]!.agentState).toBe(state);
    }
  } finally { process.env = previousEnv; }
  expect(read(fixture.log,"utf8").match(/capture-pane/g)!.length).toBeGreaterThanOrEqual(2);
  expect(registryReads).toBeGreaterThan(0);
  expect(cacheReads).toBe(0);
});

test("warm roster cache leaves the two fresh idle samples and Enter guard intact", () => {
  const id = "peer-seat-20260928T120000Z-aabbccddeeff", wire = `[[TAP v0.23 note ${id}]]`;
  const rule = "─".repeat(118);
  const frame = (working = false) => ["previous output",`${rule} tap/peer ─`,`❯ ${wire}`,rule,
    "  Opus 5.5 med | 45%↯ 229k/500k | 📁 tap | 🌿 main",
    working ? "  esc to interrupt · ⏵⏵ bypass permissions on" : "  ⏵⏵ bypass permissions on (shift+tab to cycle)",""].join("\n");
  for (const secondWorking of [false,true]) {
    const home = scratch(), registry = join(home,"registry.json");
    for (const name of ["spool","payloads","receipts"]) fs.mkdirSync(join(home,name));
    fs.writeFileSync(join(home,"spool",`${id}.meta.json`),JSON.stringify({id,reason:"staged-idle",deadline_epoch:4102444800}));
    fs.writeFileSync(join(home,"payloads",`${id}.md`),`---\nid: ${id}\nfrom: sender\nto: peer\nkind: note\n---\nfixture\n`);
    for (const phase of ["injected-text-confirmed","verify-result"] as const) recordPhase(home,{id,attempt:"one",phase,recipient:"peer",enter_count:0,result:"unverified"});
    fs.writeFileSync(registry,JSON.stringify({schema:"0.20",team:{name:"fixture"},seats:{peer:{status:"active",delivery:"pane",pane:"tap/peer:0.0",pane_id:"%1",session:"fixture",server_epoch:"srv:1:1",harness:"claude"}}}));
    warm(home);
    // One initial survey, then two fresh idle samples before any Enter.
    let captures = 0, enters = 0, capturesAtEnter = 0;
    const fx = {
      observePane:()=>({paneId:"%1",session:"fixture",serverEpoch:"srv:1:1",currentCommand:"claude",panePid:"4242"}),
      harnessEvidence:()=>"alive",copyMode:()=>({status:"normal"}),paneState:()=>({state:"busy",text:wire}),
      injectText:()=>{throw new Error("idle arm must not inject text");},inputHasId:()=>true,
      pressEnter:()=>{capturesAtEnter = captures; enters++;return true;},settle:()=>{},
      captureEscaped:()=>({ok:true,frame:frame(++captures === 3 && secondWorking)}),
      submitFrame:(_target:string,command:string,expected:string,alive?:boolean)=>classifySubmitFrame(enters ? frame().replace(wire,"") : frame(),command,expected,"118",alive),
    } as Parameters<typeof submitVerifyLocked>[4];
    submitVerifyLocked("tap/peer:0.0",id,wire,{paneId:"%1",handle:"peer",instance:"",serverEpoch:"srv:1:1",bootId:"",harness:"claude"},fx,{
      scriptsDir:scripts,agentFamilies:new Set(DEFAULT_AGENT_FAMILIES),busHome:home,recipient:"peer",registryPath:registry,attemptIds:[id],
      preserveDraft:false,draftGraceSatisfied:true,forceNoPrompt:false,idleStaged:true,singleEnter:true,
      eventContext:{actor:"courier",log:join(home,"events.log"),team:"fixture",verb:"tap"},
    });
    expect(captures).toBeGreaterThanOrEqual(3); expect(enters).toBe(secondWorking ? 0 : 1);
    expect(capturesAtEnter).toBe(secondWorking ? 0 : 3); expect(cacheReads).toBe(0);
  }
});
