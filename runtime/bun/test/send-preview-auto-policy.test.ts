// tap_serial_triggers "runtime/bun/test/support/send-reply-flip-fixture.ts" "runtime/bun/main.ts" "skills/tap/scripts/lib.sh"
// send-preview-auto-policy — component split out of the former
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
import { NATIVE_SEND, NATIVE_REPLY, MAIN, REENABLED, teamFixture, spawnGit, waitFor, payloads, placed, assertParked, paneObserveCount, resetLockProbe, startPoller, flushScratch } from "./support/send-reply-flip-fixture";

afterEach(() => flushScratch(), 40_000);

describe("sentinel preview CLI", () => {
  const scripts = join(import.meta.dir, "../../../skills/tap/scripts");
  for (const native of [false, true]) {
    test(`${native ? "bun" : "bash"} disabled flag leaves the wire unchanged`, () => {
      const fx = teamFixture({});
      mkdirSync(join(fx.env.XDG_CONFIG_HOME!, "tap"));
      writeFileSync(join(fx.env.XDG_CONFIG_HOME!, "tap/config.toml"), "[sentinel]\npreview = false\n");
      const command = native ? [process.execPath, MAIN] : ["bash", join(scripts,"../../../bin/tap")];
      const result = Bun.spawnSync([...command,"send","ub","--ask","-m","Report","--preview","Ignored ]]\nunsafe"], {cwd:fx.wt,env:fx.env,stdout:"pipe",stderr:"pipe",timeout:20000});
      expect({code:result.exitCode,err:result.stderr.toString()}).toEqual({code:0,err:""});
      const payload = readdirSync(join(fx.bus,"payloads")).find(p=>p.endsWith(".md"))!;
      const id = payload.slice(0,-3);
      expect(readFileSync(fx.env.FAKE_KEYS!,"utf8")).toContain(`[[TAP v0.23 ask ${id}]]`);
    },30000);
    for (const verb of ["send", "assign", "reply"]) {
      test(`${native ? "bun" : "bash"} ${verb} persists preview and delivers marked wire`, () => {
        const inbound = "ub-20260908T000000Z-aabbccddeeff";
        const fx = teamFixture({ inbound: verb === "reply" ? {id:inbound,from:"ub",to:"ua"} : undefined });
        mkdirSync(join(fx.env.XDG_CONFIG_HOME!, "tap"));
        const config = join(fx.env.XDG_CONFIG_HOME!, "tap/config.toml");
        writeFileSync(config,"[sentinel]\npreview = true\n");
        const body = join(fx.root,"body.md"); writeFileSync(body,"Status report for the build.\n");
        const argv = [verb, verb === "reply" ? inbound : "ub", "-f", body, "--preview", "Status report for the build", ...(verb === "send" ? ["--ask"] : [])];
        const command = native ? [process.execPath, MAIN] : ["bash", join(scripts,"../../../bin/tap")];
        const result = Bun.spawnSync([...command,...argv], {cwd:fx.wt,env:fx.env,stdout:"pipe",stderr:"pipe",timeout:20000});
        expect({code:result.exitCode,err:result.stderr.toString()}).toEqual({code:0,err:""});
        const paths = readdirSync(join(fx.bus,"payloads")).filter(p=>p.endsWith(".md") && p !== `${inbound}.md`);
        expect(paths).toHaveLength(1);
        const path = join(fx.bus,"payloads",paths[0]!);
        expect(Buffer.from(envelopeField(readFileSync(path,"utf8"),"sentinel_preview")!,"base64").toString()).toBe("Status report for the build");
        expect(readFileSync(fx.env.FAKE_KEYS!,"utf8")).toContain('preview="Status report for the build"');
        const raw = readFileSync(path,"utf8");
        const render = () => Bun.spawnSync([process.execPath,join(import.meta.dir,"support/sentinel-render-cli.ts"),
          ...["from","to","id","kind","reply","urgency","path"].map(key => envelopeField(raw,key) ?? "")],
          {cwd:fx.wt,env:fx.env,stdout:"pipe",stderr:"pipe"});
        const rendered = render();
        expect({code:rendered.exitCode,err:rendered.stderr.toString()}).toEqual({code:0,err:""});
        expect(rendered.stdout.toString()).toContain('preview="Status report for the build"');
        writeFileSync(config,"[sentinel]\npreview = false\n");
        expect(render().stdout.toString()).not.toContain("preview=");
        const poll = () => Bun.spawnSync([...command,"poll","ub"],{cwd:fx.wt,env:fx.env,stdout:"pipe",stderr:"pipe"});
        expect(poll().stdout.toString()).not.toContain("preview=");
        writeFileSync(config,"[sentinel]\npreview = true\n");
        expect(poll().stdout.toString()).toContain('preview="Status report for the build"');
        if (native && verb === "send") {
          const hook = () => Bun.spawnSync([process.execPath,join(scripts,"../../../runtime/bun/src/session-start.ts"),"context",fx.wt], {cwd:fx.wt,env:fx.env,stdin:"ignore",stdout:"pipe",stderr:"pipe"});
          expect(hook().stdout.toString()).toContain("this seat registration could not be verified");
          expect(hook().stdout.toString()).not.toContain("TAP previews are enabled");
          writeFileSync(config,"[sentinel]\npreview = false\n");
          expect(hook().stdout.toString()).not.toContain("TAP previews are enabled");
        }
      },30000);
    }
  }
});

// tap-zlfg5: a rejected explicit --preview shows no preview (it never falls back
// to the body's first line); no --preview still derives, on every verb.
for (const verb of ["send", "assign", "reply"]) {
  const cases: Array<[string, string | null]> = [
    ["unsafe", "bad ]] hint"], ["blank", ""], ["whitespace", "   "], ["overlong", "x".repeat(300)],
    ["absent", null],
  ];
  for (const [label, hint] of cases) test(`bun ${verb} ${label} --preview ${hint === null ? "derives" : "is not replaced by the body"}`, () => {
    const inbound = "ub-20260908T000000Z-aabbccddeeff";
    const fx = teamFixture({ inbound: verb === "reply" ? {id:inbound,from:"ub",to:"ua"} : undefined });
    mkdirSync(join(fx.env.XDG_CONFIG_HOME!, "tap"));
    writeFileSync(join(fx.env.XDG_CONFIG_HOME!, "tap/config.toml"), "[sentinel]\npreview = true\n");
    const body = join(fx.root,"body.md"); writeFileSync(body,"Distinctive first line.\nSecond line.\n");
    const argv = [verb, verb === "reply" ? inbound : "ub", "-f", body, ...(hint === null ? [] : ["--preview", hint]), ...(verb === "send" ? ["--ask"] : [])];
    const result = Bun.spawnSync([process.execPath,MAIN,...argv], {cwd:fx.wt,env:fx.env,stdout:"pipe",stderr:"pipe",timeout:20000});
    expect({code:result.exitCode}).toEqual({code:0});
    const paths = readdirSync(join(fx.bus,"payloads")).filter(p=>p.endsWith(".md") && p !== `${inbound}.md`);
    expect(paths).toHaveLength(1);
    const path = join(fx.bus,"payloads",paths[0]!);
    const raw = readFileSync(path,"utf8");
    expect(envelopeField(raw,"sentinel_preview")).toBe(hint === null ? undefined : "-");
    const keys = readFileSync(fx.env.FAKE_KEYS!,"utf8");
    const poll = Bun.spawnSync([process.execPath,MAIN,"poll","ub"],{cwd:fx.wt,env:fx.env,stdout:"pipe",stderr:"pipe"}).stdout.toString();
    for (const shown of [keys, poll]) {
      if (hint === null) expect(shown).toContain('preview="Distinctive first line."');
      else expect(shown).not.toContain("preview=");
    }
  },30000);
}

for (const harness of ["claude", "codex"]) for (const urgent of [false, true]) {
  for (const permissions of ["auto", "bypass"]) test(`recorded auto policy public ${harness} urgent=${urgent} mode=${permissions} holds a prompt`, () => {
    const f = teamFixture({command:harness});
    const registry = join(f.wt,".tap/team-registry.json");
    const doc = JSON.parse(readFileSync(registry,"utf8"));
    Object.assign(doc.seats.ub,{harness,permissions});writeFileSync(registry,JSON.stringify(doc));
    f.env.FAKE_RAW_CAPTURE=join(import.meta.dir,`fixtures/agent-state/${harness}/blocked-real.txt`);
    writeFileSync(f.env.FAKE_ALL_KEYS!,"");
    const r=Bun.spawnSync([process.execPath,MAIN,"send","ub","--from","ua","--ask","--json","-m","hold",...(urgent?["--urgent"]:[])],{cwd:f.wt,env:f.env});
    if(r.exitCode!==0) throw new Error(r.stdout.toString()+r.stderr.toString());
    expect(JSON.parse(r.stdout.toString()).status).toBe("queued");
    expect(readFileSync(f.env.FAKE_ALL_KEYS!,"utf8")).toBe("");
    if(permissions==="auto" && urgent) expect(r.stderr.toString()).toContain("auto_mode_no_interrupt");
  },30000);
}
for (const harness of ["claude", "codex"]) test(`recorded auto policy public ${harness} clean composer delivers`, () => {
  const f=teamFixture({command:harness,harnessQueue:true,codexChevron:harness==="codex"});
  const registry=join(f.wt,".tap/team-registry.json");
  const doc=JSON.parse(readFileSync(registry,"utf8")); Object.assign(doc.seats.ub,{harness,permissions:"auto"});writeFileSync(registry,JSON.stringify(doc));
  const r=Bun.spawnSync([process.execPath,MAIN,"send","ub","--from","ua","--ask","--json","-m","ready"],{cwd:f.wt,env:f.env});
  if(r.exitCode!==0) throw new Error(r.stdout.toString()+r.stderr.toString());
  expect(readFileSync(f.env.FAKE_ALL_KEYS!,"utf8")).toContain(" Enter");
  expect(readFileSync(f.env.FAKE_ALL_KEYS!,"utf8")).not.toContain("Escape");
},30000);

for (const frame of ["unknown", "draft", "copy-mode"]) test(`recorded auto policy public holds ${frame} before any keys`, () => {
  const f=teamFixture({command:"claude",harnessQueue:true});
  const registry=join(f.wt,".tap/team-registry.json");
  const doc=JSON.parse(readFileSync(registry,"utf8"));doc.seats.ub.permissions="auto";writeFileSync(registry,JSON.stringify(doc));
  writeFileSync(f.env.FAKE_ALL_KEYS!,"");
  if(frame==="unknown") { f.env.FAKE_RAW_CAPTURE=join(f.wt,"unknown-frame");writeFileSync(f.env.FAKE_RAW_CAPTURE,"unrecognized modal chrome\n"); }
  if(frame==="draft") writeFileSync(f.env.FAKE_BAND!,"human draft");
  if(frame==="copy-mode") writeFileSync(f.env.FAKE_IN_MODE!,"1");
  const r=Bun.spawnSync([process.execPath,MAIN,"send","ub","--from","ua","--ask","--json","-m","hold"],{cwd:f.wt,env:f.env});
  if(r.exitCode!==0) throw new Error(r.stdout.toString()+r.stderr.toString());
  expect(JSON.parse(r.stdout.toString()).status).toBe("queued");
  expect(readFileSync(f.env.FAKE_ALL_KEYS!,"utf8")).toBe("");
},30000);

// Native redelivery copy-mode admission is covered by spool-drain-effects.test.ts.
