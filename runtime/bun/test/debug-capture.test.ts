import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Bus } from "../src/bus";
import { deliver, type PaneEffects } from "../src/deliver";
import { rememberDebugFrame, captureCourierFailure } from "../src/debug-capture";
import { decodeAttemptRows } from "../src/courier-contract";

test("native swallowed Enter keeps its observation and outcome; on/off changes in the same process", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-debug-native-"));
  const old = process.env.TAP_INDEX_HOME;
  process.env.TAP_INDEX_HOME = join(root, "index");
  const enabled = join(process.env.TAP_INDEX_HOME, "debug/enabled.json");
  mkdirSync(join(process.env.TAP_INDEX_HOME, "debug"), { recursive: true });
  const bus = new Bus(join(root, "bus"));
  bus.ensureDirs();
  const frame = "\x1b[32m› [[TAP v0.23 ask\n  team/message]]\x1b[0m\n";
  try {
    for (const on of [false, true, false]) {
      if (on) writeFileSync(enabled, JSON.stringify({ id: "probe", directory: root }));
      else rmSync(enabled, { force: true });
      const id = `probe-${on ? "on" : existsSync(join(bus.home, "marker")) ? "off-again" : "off"}`;
      let injects = 0, enters = 0;
      const fx: PaneEffects = {
        observePane: () => ({ paneId: "%7", session: "test/bob", serverEpoch: "srv:1:2", panePid: "1", currentCommand: "claude" }),
        paneCurrentCommand: () => "claude", paneState: () => ({ state: "ready" }),
        injectText: () => { injects++; return true; },
        inputHasId: () => { rememberDebugFrame(frame); return true; },
        pressEnter: () => { enters++; return true; }, settle: () => {},
      };
      writeFileSync(bus.payloadPath(id), "canonical\n");
      const result = deliver({ bus, id, pane: "%7", sentinel: "[[TAP v0.23 ask team/message]]",
        bound: { paneId: "%7", serverEpoch: "srv:1:2", harness: "claude" },
        from: "alice", to: "bob", kind: "discussion", via: "owner" }, { pane: fx });
      expect(result.action).toBe("unconfirmed");
      expect(injects).toBe(1); expect(enters).toBe(1);
      const artifact = join(bus.home, "receipts", `${id}.submit-unverified.frame`);
      expect(existsSync(artifact)).toBe(on);
      if (on) expect(readFileSync(artifact, "utf8")).toBe(frame);
      const rows = decodeAttemptRows(readFileSync(bus.payloadPath(id).replace(/\.md$/, ".attempts"), "utf8"));
      expect(rows.at(-1)).toMatchObject({ disposition: "unconfirmed" });
      writeFileSync(join(bus.home, "marker"), "");
    }
  } finally {
    if (old === undefined) delete process.env.TAP_INDEX_HOME; else process.env.TAP_INDEX_HOME = old;
    rmSync(root, { recursive: true, force: true });
  }
});

test("diagnostic summaries cannot turn a pre-effect defer into retry refusal", () => {
 const root=mkdtempSync(join(tmpdir(),"debug-panel-"));
 const old=process.env.TAP_INDEX_HOME;
 process.env.TAP_INDEX_HOME=join(root,"index");
 const bus=new Bus(join(root,"bus")); bus.ensureDirs();
 mkdirSync(join(root,"index/debug"),{recursive:true});
 writeFileSync(join(root,"index/debug/enabled.json"),JSON.stringify({id:"probe",directory:root}));
 try {
  const first=captureCourierFailure({id:"pre-effect",pane:"%7",harness:"claude",sentinel:"wire",busHome:bus.home},()=>({status:"band_busy",detail:"busy draft"}),true);
  expect(first.status).toBe("band_busy");
  expect(existsSync(bus.payloadPath("pre-effect").replace(/\.md$/,".attempts"))).toBe(false);
  expect(existsSync(bus.payloadPath("pre-effect").replace(/\.md$/,".debug.attempts"))).toBe(true);
  let injects=0, entered=false;
  const fx:PaneEffects={observePane:()=>({paneId:"%7",session:"test/bob",serverEpoch:"srv:1:2",panePid:"1",currentCommand:"claude"}),paneCurrentCommand:()=>"claude",paneState:()=>({state:"ready"}),injectText:()=>{injects++; return true},inputHasId:()=>!entered,pressEnter:()=>{entered=true;return true},settle:()=>{}};
  const outcome=deliver({bus,id:"pre-effect",pane:"%7",sentinel:"wire",bound:{paneId:"%7",serverEpoch:"srv:1:2",harness:"claude"},from:"alice",to:"bob",kind:"discussion",via:"owner"},{pane:fx});
  expect(outcome.action).toBe("delivered");
  expect(injects).toBe(1);
 } finally { if(old===undefined)delete process.env.TAP_INDEX_HOME; else process.env.TAP_INDEX_HOME=old; rmSync(root,{recursive:true,force:true}); }
});
