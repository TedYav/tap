import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquirePaneLock } from "../src/panelock";
import { observePaneResult } from "../src/tmux";
import { queueExplanation } from "../src/queue-explanation";
import { readInputProtection, updateInputProtection } from "../src/input-protection";
import { fixture, releaseScratch } from "./support/send-delivery-fixture";
afterAll(releaseScratch, 40_000);

test("one existing-path observer retains consumed WAIT after delivery and exits on confirmed bare", async () => {
  const f = fixture({ draft: "WAIT remains in restored draft" });
  const gate = join(f.root, "capture-gate");
  const env = { ...f.env, FAKE_HOLD: gate, FAKE_HOLD_AT: "capture" };
  mkdirSync(join(f.bus, "payloads"), { recursive: true });
  mkdirSync(join(f.bus, "receipts"), { recursive: true });
  const script = join(f.root, "observe.ts");
  writeFileSync(script, `
import {writeFileSync} from "node:fs";
import {updateInputProtection, observeUntilDraftEnds, readInputProtection} from ${JSON.stringify(join(import.meta.dir, "../src/input-protection.ts"))};
import {observePaneResult} from ${JSON.stringify(join(import.meta.dir, "../src/tmux.ts"))};
import {acquirePaneLock} from ${JSON.stringify(join(import.meta.dir, "../src/panelock.ts"))};
const seen=observePaneResult("%7"); if(seen.status!=="ok") throw new Error("identity missing");
if(process.argv[2]==="owner") {
  const lock=acquirePaneLock("%7",1000); if(!lock) throw new Error("lock missing");
  try {
    writeFileSync(${JSON.stringify(join(f.bus, "payloads", "message.md"))}, "fixture");
    updateInputProtection(seen.observation,{state:"busy",text:"WAIT remains in restored draft"},
      {message:{home:${JSON.stringify(f.bus)},id:"message",sender:"alice"}});
    writeFileSync(${JSON.stringify(join(f.bus, "receipts", "message.sent"))}, "{}");
  } finally {lock.release();}
}
await observeUntilDraftEnds("%7",seen.observation.serverEpoch);
if(process.argv[2]==="owner" && readInputProtection("%7",seen.observation.serverEpoch)) throw new Error("consumed record survived bare composer");
`);
  const owner = Bun.spawn([process.execPath, script, "owner"], { env, stdout: "pipe", stderr: "pipe" });
  try {
    const until = Date.now() + 5000;
    while (!existsSync(`${gate}.reached`) && Date.now() < until) await Bun.sleep(10);
    expect(existsSync(`${gate}.reached`)).toBe(true);
    const competitor = Bun.spawn([process.execPath, script, "competitor"], { env, stdout: "pipe", stderr: "pipe" });
    expect(await competitor.exited, await new Response(competitor.stderr).text()).toBe(0);
    expect(owner.exitCode).toBeNull();
    unlinkSync(f.env.FAKE_BAND!);
    writeFileSync(`${gate}.release`, "");
    expect(await owner.exited, await new Response(owner.stderr).text()).toBe(0);
  } finally {
    if (owner.exitCode === null) { owner.kill(); await owner.exited; }
  }
}, 15000);

test("unconfirmed mail leaves the deadline cohort so a later batch gets fresh grace", () => {
  const f = fixture({ draft: "human draft" });
  const observed = observePaneResult("%7", f.env);
  expect(observed.status).toBe("ok");
  if (observed.status !== "ok") return;
  const lock = acquirePaneLock("%7", 1000, f.env);
  expect(lock).not.toBeNull();
  try {
    const payloads = join(f.bus, "payloads"), receipts = join(f.bus, "receipts");
    writeFileSync(join(payloads, "old.md"), "old payload");
    updateInputProtection(observed.observation, { state: "busy", text: "human draft" }, {
      env: f.env, now: 1000, message: { home: f.bus, id: "old", sender: "alice" },
    });
    writeFileSync(join(receipts, "old.unconfirmed"), '{"status":"unconfirmed"}\n');
    writeFileSync(join(payloads, "new.md"), "new payload");
    const next = updateInputProtection(observed.observation, { state: "busy", text: "human draft" }, {
      env: f.env, now: 2000, message: { home: f.bus, id: "new", sender: "bob" },
    });
    expect(next?.pending).toEqual([{ home: f.bus, id: "new", sender: "bob" }]);
    expect(next?.graceUntil).toBe(32000);
    expect(readInputProtection("%7", observed.observation.serverEpoch, f.env)?.pending).toEqual(next?.pending);
  } finally { lock!.release(); }
});

test("queue explanation applies pane protection only to its own cohort member", () => {
  const f = fixture({ draft: "human draft" });
  const observed = observePaneResult("%7", f.env);
  expect(observed.status).toBe("ok");
  if (observed.status !== "ok") return;
  const lock = acquirePaneLock("%7", 1000, f.env);
  expect(lock).not.toBeNull();
  try {
    const spool = join(f.bus, "spool");
    mkdirSync(spool, { recursive: true });
    writeFileSync(join(spool, "protected.md"), "protected payload");
    updateInputProtection(observed.observation, { state: "busy", text: "human draft" }, {
      env: f.env, message: { home: f.bus, id: "protected", sender: "alice" },
    });
    for (const id of ["protected", "unrelated"]) {
      writeFileSync(join(spool, `${id}.meta.json`), JSON.stringify({ pane_id: "%7", reason: "busy", reason_class: "busy", next_probe_epoch: 9999999999, deadline_epoch: 9999999999 }));
    }
    expect(queueExplanation(f.bus, "protected", Date.now() / 1000, f.env)).toContain("draft grace");
    const unrelated = queueExplanation(f.bus, "unrelated", Date.now() / 1000, f.env);
    expect(unrelated).toContain("busy/busy");
    expect(unrelated).not.toContain("draft grace");
  } finally { lock!.release(); }
});
