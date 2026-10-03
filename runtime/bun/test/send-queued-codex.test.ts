// tap_serial_triggers "runtime/bun/test/support/send-reply-flip-fixture.ts" "runtime/bun/main.ts" "runtime/bun/test/support/native-send-entry.ts" "skills/tap/scripts/lib.sh" "skills/tap/scripts/tap-send.sh"
// send-queued-codex — component split out of the former
// runtime/bun/test/send-reply-flip.test.ts (Deliverable B unit 1). The test
// bodies below are verbatim moves; the shared fixture and helpers live in
// ./support/send-reply-flip-fixture.ts and this file registers its own
// scratch cleanup.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { stampEnvelope, envelopeField } from "../src/envelope";
import { acquirePathLock, acquirePaneLock, KERNEL_LOCK, kernelLockArgs } from "../src/panelock";
import { createHash } from "node:crypto";
import { receiptQueued, resolveOutboundEvidence } from "../src/verbs/reply";
import { Bus } from "../src/bus";
import { TapError } from "../src/context";
import { acquireResetMutationLock, resetFenceRefusal } from "../src/reset";
import { removeScratchTree } from "./support/scratch";
import { seedExpiredProtection } from "./support/input-protection-seed";
import { NATIVE_SEND, NATIVE_REPLY, MAIN, REENABLED, teamFixture, spawnGit, waitFor, payloads, placed, assertParked, paneObserveCount, resetLockProbe, startPoller, flushScratch } from "./support/send-reply-flip-fixture";

afterEach(() => flushScratch(), 40_000);

// native=false is the router door (main.ts send), which replaced the by-path tap-send.sh door (B7c R10).
// The retired `tap_submit_verify` door, natively: the courier over its
// production draft effects, exit codes in that door's numbering.
const NATIVE_SUBMIT = `
const src = process.env.TEST_SRC;
const {submitVerify} = await import(src + "/courier.ts");
const {DARK_EFFECTS} = await import(src + "/deliver.ts");
const {draftEffects} = await import(src + "/spool-drain-effects.ts");
const e = process.env;
const row = JSON.parse(await Bun.file(e.TEST_REGISTRY).text()).seats.ub;
const r = submitVerify("ub:0.0", e.TEST_ID, e.TEST_WIRE, { paneId: row.pane_id ?? "%7", harness: "codex", handle: "ub", instance: row.instance, serverEpoch: row.server_epoch },
  { scriptsDir: e.TEST_SCRIPTS, agentFamilies: new Set(["codex"]), busHome: e.TAP_HOME, recipient: "ub", registryPath: e.TEST_REGISTRY,
    preserveDraft: false, forceNoPrompt: e.TAP_SUBMIT_FORCE_NO_PROMPT === "1" }, draftEffects(DARK_EFFECTS));
if ("detail" in r) console.error(r.status + ": " + r.detail);
const rc = { injected: 0, harness_queued: 7, pane_gone: 3, unverified: 5, attempt_evidence_unwritable: 5,
  identity_mismatch: 6, team_reset_fenced: 6, clearing: 6 }[r.status];
process.exit(rc ?? 4);
`;
function nativeSubmitArgv(wire: string, id: string, registry: string): [string[], Record<string, string>] {
  const root = join(import.meta.dir, "../../..");
  return [[process.execPath, "-e", NATIVE_SUBMIT], { TEST_SRC: join(root, "runtime/bun/src"), TEST_SCRIPTS: join(root, "skills/tap/scripts"),
    TEST_ID: id, TEST_WIRE: wire, TEST_REGISTRY: registry }];
}

for(const native of [true,false]) test(`harness-queued direct send returns accepted without premature sent: native=${native}`,()=>{
 const f=teamFixture({harnessQueue:true});
 const args=['ub','-m','queued work','--from','ua','--ask','--json'];
 const result=Bun.spawnSync(native ? [process.execPath,NATIVE_SEND,...args] : [process.execPath,MAIN,'send',...args],{cwd:f.wt,env:f.env});
 expect(result.exitCode).toBe(0);
 const output=JSON.parse(result.stdout.toString());
 expect(output).toMatchObject({status:'queued',delivery:'harness-queue',turn:'unconfirmed'});
 expect(result.stderr.toString()).not.toMatch(/submit.unverified|tap nudge|DELIVERY UNCONFIRMED/);
 expect(existsSync(join(f.bus,'receipts',`${output.id}.sent`))).toBe(false);
 expect(existsSync(join(f.bus,'receipts',`${output.id}.harness-queued`))).toBe(true);
 expect(readFileSync(f.env.FAKE_KEYS!,'utf8').split('\n').filter(line=>line.includes(' Enter'))).toHaveLength(2);
 expect(readFileSync(join(f.bus,'receipts',`${output.id}.submit-phases.jsonl`),'utf8')).toContain('"result":"queued"');
},30000);

test('harness-queued direct send fixture: public nudge accepts queued submission',()=>{
 const f=teamFixture({harnessQueue:true}),id='queued-nudge-20260907T000000Z-aaaaaaaaaaaa';
 const wire=`[[TAP v0.23 ask ${id}]]`;
 writeFileSync(join(f.bus,'payloads',`${id}.md`),`---\nid: ${id}\nfrom: ua\nto: ub\nreply: expected\n---\nbody\n`);
 writeFileSync(f.env.FAKE_BAND!,wire);
 const r=Bun.spawnSync(['bash',join(import.meta.dir,'../../../bin/tap'),'nudge','flip/ub'],{cwd:f.wt,env:f.env});
 if(r.exitCode!==0) throw new Error(r.stdout.toString()+r.stderr.toString());
 expect(r.exitCode).toBe(0);expect(r.stdout.toString()).toContain('tap nudge: queued in harness');
 expect(existsSync(join(f.bus,'receipts',`${id}.harness-queued`))).toBe(true);
 expect(existsSync(join(f.bus,'receipts',`${id}.sent`))).toBe(false);
 expect(readFileSync(f.env.FAKE_KEYS!,'utf8').split('\n').filter(line=>line.includes(' Enter'))).toHaveLength(1);
},30000);

for (const prior of [false, true]) test(`harness-queued direct send fixture: staged wire uses queued verifier prior=${prior}`,()=>{
 const f=teamFixture({harnessQueue:true,command:'codex'}),id='queued-own-20260907T000000Z-bbbbbbbbbbbb';
 const wire=`[[TAP v0.23 ask ${id}]]`;
 writeFileSync(join(f.bus,'payloads',`${id}.md`),`---\nid: ${id}\nfrom: ua\nto: ub\nreply: expected\n---\nbody\n`);
 const stagedId = prior ? 'queued-prior-20260907T000000Z-cccccccccccc' : id;
 const stagedWire = `[[TAP v0.23 ask ${stagedId}]]`;
 if (prior) writeFileSync(join(f.bus,'payloads',`${stagedId}.md`),`---\nid: ${stagedId}\nfrom: ua\nto: ub\nreply: expected\n---\nbody\n`);
 writeFileSync(f.env.FAKE_BAND!,stagedWire);
 const registry=join(f.wt,'.tap/team-registry.json'); const rows=JSON.parse(readFileSync(registry,'utf8'));rows.seats.ub.harness='codex';writeFileSync(registry,JSON.stringify(rows));
 const [argv,extra]=nativeSubmitArgv(wire,id,join(f.wt,'.tap/team-registry.json'));
 const r=Bun.spawnSync(argv,{cwd:f.wt,env:{...f.env,TAP_HOME:f.bus,...extra}});
 if(r.exitCode!==7) console.error(r.stderr.toString());
 expect(r.exitCode).toBe(7);
 expect(readFileSync(f.env.FAKE_KEYS!,'utf8').split('\n').filter(line=>line.includes(' Enter'))).toHaveLength(prior ? 3 : 1);
 if (prior) {
  expect(existsSync(join(f.bus,'receipts',`${stagedId}.harness-queued`))).toBe(true);
  expect(existsSync(join(f.bus,'receipts',`${stagedId}.sent`))).toBe(false);
 }
 expect(readFileSync(join(f.bus,'receipts',`${id}.submit-phases.jsonl`),'utf8')).toContain('"result":"queued"');
},30000);

describe("Codex double-chevron public delivery", () => {
  const id = "chevron-own-20260908T000000Z-aaaaaaaaaaaa";
  const wire = `[[TAP v0.23 ask ${id}]]`;
  function fixture(input = "") {
    const f = teamFixture({ command: "codex", codexChevron: true,
      seats: { ub: { status: "active", pane: "ub:0.0", pane_id: "%7",
        server_epoch: "srv:123:456", instance: "ub|A", harness: "codex" } } });
    writeFileSync(f.env.FAKE_BAND!, input);
    writeFileSync(join(f.bus, "payloads", `${id}.md`), stampEnvelope("---\n---\nbody\n", {
      id, from: "ua", to: "ub", reply: "expected", kind: "discuss",
      path: join(f.bus, "payloads", `${id}.md`),
    }));
    return f;
  }
  function run(f: ReturnType<typeof fixture>, argv: string[], forced = false) {
    return Bun.spawnSync(argv, { cwd: f.wt,
      env: { ...f.env, TAP_SPOOL_DRAIN_ACTIVE: "1", TAP_BUN_ROUTE_TRACE: join(f.root,"chevron-route.trace"), TAP_TUI_SETTLE_SCALE: "0.1",
        ...(forced ? { TAP_SUBMIT_FORCE_NO_PROMPT: "1" } : {}) },
      stdout: "pipe", stderr: "pipe", timeout: 60_000, killSignal: "SIGKILL" });
  }
  function keys(f: ReturnType<typeof fixture>) {
    return existsSync(f.env.FAKE_ALL_KEYS!) ? readFileSync(f.env.FAKE_ALL_KEYS!, "utf8") : "";
  }
  function forced(f: ReturnType<typeof fixture>) {
    const [argv, extra] = nativeSubmitArgv(wire, id, join(f.wt, ".tap/team-registry.json"));
    return run({ ...f, env: { ...f.env, TAP_HOME: f.bus, ...extra } }, argv, true);
  }
  test("MAIN accepts an empty 89-column double-chevron composer", () => {
    const f = fixture();
    const r = run(f, [process.execPath, MAIN, "send", "ub", "--ask", "-m", "synthetic body", "--from", "ua"]);
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    expect(readFileSync(join(f.root,"chevron-route.trace"),"utf8")).toBe("native send\n");
    expect(keys(f).split("\n").filter(line => line.includes(" -l -- "))).toHaveLength(1);
    expect(keys(f).split("\n").filter(line => line.includes(" Enter"))).toHaveLength(2);
    expect(existsSync(f.env.FAKE_SUBMITTED!)).toBe(true);
  }, 65_000);
  test("forced-deadline submits one staged own wire without reinjection", () => {
    const f = fixture(wire);
    const r = forced(f);
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    expect(keys(f)).not.toContain(" -l -- ");
    expect(keys(f).split("\n").filter(line => line.includes(" Enter"))).toHaveLength(1);
  }, 65_000);
  test("forced-deadline backs up a human draft without concatenation", () => {
    const draft = "unfinished synthetic human draft";
    const f = fixture(draft);
    // Production mints the pane record at park time; by the forced deadline it
    // has expired. Seed that state instead of letting the forced attempt mint
    // a fresh grace it would then refuse through.
    seedExpiredProtection({ env: f.env, paneId: "%7", serverEpoch: "srv:123:456", harness: "codex", home: f.bus, id });
    const r = forced(f);
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    expect(keys(f)).toContain(" C-u");
    // The backup is the recovery authority; whether the short-draft paste-back
    // runs depends on the effects passed (production DARK_EFFECTS carries it).
    const backups = readdirSync(join(f.bus,"input-backups"));
    expect(backups.some(name => readFileSync(join(f.bus,"input-backups",name),"utf8").includes(draft))).toBe(true);
  }, 65_000);
  const crowded = Array.from({ length: 22 }, (_, i) =>
    `[[TAP v0.23 ask prior-${String(i).padStart(2, "0")}-20260908T000000Z-bbbbbbbbbbbb]]`).join("");
  for (const [label, input] of [["draft", "unfinished synthetic human draft"], ["22 wires", crowded]] as const) {
    test(`MAIN never appends to occupied double-chevron ${label}`, () => {
      const f = fixture(input);
      // Sticky Enter models the observed stalled composer instead of granting a
      // successful submit merely because tmux accepted the key.
      writeFileSync(f.env.FAKE_ENTER_FAIL!, "1");
      const r = run(f, [process.execPath, MAIN, "send", "ub", "--ask", "-m", "synthetic body", "--from", "ua"]);
      expect([0, 5, 6]).toContain(r.exitCode);
      expect(readFileSync(join(f.root,"chevron-route.trace"),"utf8")).toBe("native send\n");
      expect(keys(f)).not.toContain(" -l -- ");
      expect(keys(f)).not.toContain(" C-u");
      expect(readFileSync(f.env.FAKE_BAND!, "utf8")).toBe(input);
    }, 65_000);
    if (label === "22 wires") test(`forced-deadline never appends to sticky double-chevron ${label}`, () => {
      const f = fixture(input);
      writeFileSync(f.env.FAKE_ENTER_FAIL!, "1");
      // A sentinel band must not enter the human-draft clear path.
      const r = forced(f);
      expect([4, 5, 6]).toContain(r.exitCode);
      expect(keys(f)).not.toContain(" -l -- ");
      expect(keys(f)).not.toContain(" C-u");
      expect(readFileSync(f.env.FAKE_BAND!, "utf8")).toBe(input);
    }, 65_000);
  }
});
