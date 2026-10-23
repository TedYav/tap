import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfiguredDriver } from "../src/verbs/send";
import { teamFixture, flushScratch, payloads, NATIVE_SEND } from "./support/send-reply-flip-fixture";

afterEach(() => flushScratch(), 40_000);
const recoveryModule = new URL("../src/self-rebrief.ts", import.meta.url).pathname;
const sendModule = new URL("../src/verbs/send.ts", import.meta.url).pathname;
function fixture(fence = false) {
  const fx = teamFixture({ fence });
  const request = { id: "recovery", registry: join(fx.wt, ".tap/team-registry.json"), bus: fx.bus,
    team: "flip", handle: "ub", oldSession: "old", oldTranscript: "/old", command: "/clear",
    bound: { paneId: "%7", instance: "ub|A", serverEpoch: "srv:123:456", harness: "claude", handle: "ub" } };
  const registry=JSON.parse(readFileSync(request.registry,"utf8"));
  registry.seats.ub.harness_session_id="old";
  writeFileSync(request.registry,JSON.stringify(registry));
  mkdirSync(join(fx.bus, "spool"), { recursive: true });
  const legacy = join(fx.bus, "spool/old-unrelated.md");
  writeFileSync(legacy, "old unrelated body\n");
  const shellCall = join(fx.root, "unexpected-shell");
  writeFileSync(join(fx.root, "bin/bash"), `#!/bin/sh\nprintf called > '${shellCall}'\nexit 77\n`, { mode: 0o755 });
  const send = (target = "ub", instance = "ub|A", session="old", guard: boolean | "pending" | "after-copy"=false) => Bun.spawnSync([process.execPath, "-e",
    `import {sendRecovery} from ${JSON.stringify(recoveryModule)}; import {SendAuthorizationPending} from ${JSON.stringify(sendModule)}; import {existsSync} from "node:fs";
const request=JSON.parse(process.argv[1]),mode=process.argv[4];
const authorize=()=>{if(mode==="after-copy" && existsSync(process.env.FAKE_IN_MODE))return;if(mode==="pending" || mode==="after-copy")throw new SendAuthorizationPending("bootstrap pending");throw new Error("bootstrap proof changed before placement");};
try{console.log(JSON.stringify(sendRecovery(request,process.argv[2],"Read /durable/brief.md first","ub-20260919T000000Z-123456789abc",process.argv[3],mode?authorize:undefined)));}catch(error){console.error(error.message+"; effect="+error.effect);process.exit(1);}`,
    JSON.stringify({ ...request, bound: { ...request.bound, instance } }), target, session,guard===true?"guard":guard||""],
    { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe", timeout: 10000 });
  return { ...fx, legacy, shellCall, send };
}
for (const target of ["ub", "ua"]) test(`recovery to ${target === "ub" ? "self" : "owner"} remains native with unrelated legacy spool`, () => {
  const control = fixture();
  const ordinary = Bun.spawnSync([process.execPath, NATIVE_SEND, "ub", "--from", "ub", "-m", "control"],
    { cwd: control.wt, env: control.env, stdout: "pipe", stderr: "pipe" });
  expect(ordinary.exitCode, ordinary.stderr.toString()).toBe(0);
  expect(payloads(control.bus)).toHaveLength(1);
  expect(readFileSync(control.legacy, "utf8")).toBe("old unrelated body\n");
  expect(existsSync(control.shellCall)).toBe(false);
  const fx = fixture();
  const sent = fx.send(target);
  expect(sent.exitCode, sent.stderr.toString()).toBe(0);
  expect(JSON.parse(sent.stdout.toString().trim())).toEqual({ rc: 0, disposition: "delivered" });
  const messages = payloads(fx.bus);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toBe("ub-20260919T000000Z-123456789abc.md");
  expect(readFileSync(join(fx.bus, "payloads", messages[0]!), "utf8")).toContain("Read /durable/brief.md first");
  expect(readFileSync(fx.legacy, "utf8")).toBe("old unrelated body\n");
  expect(existsSync(fx.shellCall)).toBe(false);
}, 15000);

test("native sends beside legacy backlog preserve reset fence and sender instance checks", () => {
  for (const fenced of [true, false]) {
    const fx = fixture(fenced);
    const result = fx.send("ub", fenced ? "ub|A" : "replacement");
    expect(result.exitCode).not.toBe(0);
    expect(payloads(fx.bus)).toHaveLength(0);
    expect(readFileSync(fx.legacy, "utf8")).toBe("old unrelated body\n");
    expect(existsSync(fx.shellCall)).toBe(false);
  }
});

test("recovery placement rechecks the captured native conversation",()=>{
  const fx=fixture();
  const result=fx.send("ub","ub|A","changed");
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("native session changed before recovery placement");
  expect(payloads(fx.bus)).toHaveLength(0);
  expect(existsSync(fx.shellCall)).toBe(false);
});

test("a changed bootstrap proof refuses inside placement before publishing recovery",()=>{
  const fx=fixture(), result=fx.send("ub","ub|A","old",true);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("bootstrap proof changed before placement");
  expect(payloads(fx.bus)).toHaveLength(0);
  expect(existsSync(fx.shellCall)).toBe(false);
});

for(const mode of ["pending","after-copy"] as const)test(`pending authorization stamps actual send effects at ${mode}`,()=>{
  const fx=fixture();
  if(mode==="after-copy")writeFileSync(fx.env.FAKE_IN_MODE!,"1");
  const result=fx.send("ub","ub|A","old",mode);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain(`effect=${mode==="pending"?"none":"possible"}`);
  expect(payloads(fx.bus)).toHaveLength(0);
  expect(existsSync(join(fx.bus,"receipts","ub-20260919T000000Z-123456789abc.attempted"))).toBe(mode==="after-copy");
  expect(existsSync(fx.env.FAKE_IN_MODE!)).toBe(false);
});

test("native driver selection preserves defaults, explicit preferences and source refusals", () => {
  const fx = teamFixture({});
  const path = join(fx.env.XDG_CONFIG_HOME!, "tap/config.toml");
  mkdirSync(join(fx.env.XDG_CONFIG_HOME!, "tap"));
  const read = () => resolveConfiguredDriver("claude", fx.env);
  expect(read()).toEqual({ ok: true, driver: "tmux" });
  for (const source of ['[roles]\ndriver="role"', 'harness.claude = 3', 'harness.claude.driver = "tmux"']) {
    writeFileSync(path, source, { mode: 0o600 });
    expect(read()).toEqual({ ok: true, driver: "tmux" });
  }
  writeFileSync(path, '[harness . "claude"]\n"driver" = "ccnative"');
  expect(read()).toEqual({ ok: false });
  for (const value of ['""', '42', '"tmux\\n"', '"tmux"\nbroken']) {
    writeFileSync(path, `harness.claude.driver = ${value}`);
    expect(read()).toEqual({ ok: false });
  }
  writeFileSync(path, 'harness.claude.driver = "tmux"'); chmodSync(path, 0o666);
  expect(read()).toEqual({ ok: false });
  expect(resolveConfiguredDriver("claude", { ...fx.env, XDG_CONFIG_HOME: "relative" })).toEqual({ ok: false });
  expect(resolveConfiguredDriver("claude", { ...fx.env, TAP_DRIVER_FORCE_TMUX: "1" })).toEqual({ ok: true, driver: "tmux" });
  const dangling = join(fx.root, "dangling/tap"); mkdirSync(dangling, { recursive: true });
  symlinkSync(join(fx.root, "absent"), join(dangling, "config.toml"));
  expect(resolveConfiguredDriver("claude", { ...fx.env, XDG_CONFIG_HOME: join(fx.root, "dangling") })).toEqual({ ok: false });
});
