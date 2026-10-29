import { afterAll, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, flashes, notices, releaseScratch, run } from "./support/send-delivery-fixture";
afterAll(releaseScratch, 40_000);
const protection = (f: ReturnType<typeof fixture>) => {
  const dir = join(f.env.TAP_INDEX_HOME!, "input-protection");
  return join(dir, readdirSync(dir).find(n => n.endsWith(".json"))!);
};
function drain(f: ReturnType<typeof fixture>) {
  const result = Bun.spawnSync(["bash", "-c", '. "$1/smoke/runtime-helpers.sh"; . "$1/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once', "drain", join(import.meta.dir, "../../../skills/tap/scripts")], {
    cwd: f.wt, env: { ...f.env, TAP_HOME: f.bus, TAP_SPOOL: join(f.bus, "spool"), TAP_PAYLOADS: join(f.bus, "payloads"), TAP_RECEIPTS: join(f.bus, "receipts"), TAP_REGISTRY: f.registry, TAP_REGISTRY_EVENTS: join(f.bus, "registry-events.log") }, stdout: "pipe", stderr: "pipe", timeout: 15000,
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}
const sent = (f: ReturnType<typeof fixture>, id: string) => existsSync(join(f.bus, "receipts", `${id}.sent`));
const attempted = (f: ReturnType<typeof fixture>, id: string) => existsSync(join(f.bus, "receipts", `${id}.attempted`));

test("STOP survives a reopened empty composer and side view, holds urgent/new mail, START clears and delivers", () => {
  const f = fixture({ draft: "draft" }); f.env.FAKE_CLEAR_INPUT = "1";
  expect(run(f, ["send", "rb", "-m", "one", "--id", "stop-one"]).receipt.status).toBe("queued");
  writeFileSync(f.env.FAKE_BAND!, "STOP"); drain(f); drain(f);
  expect(flashes(f)).toEqual(["bg=green", "bg=blue"]);
  expect(notices(f).some(n => n.includes("STOP") && n.includes("until"))).toBe(true);
  const until = JSON.parse(readFileSync(protection(f), "utf8")).stopUntil;
  expect(until - Date.now()).toBeGreaterThan(590000);
  unlinkSync(f.env.FAKE_BAND!); drain(f); Bun.sleepSync(300); drain(f);
  expect(sent(f, "stop-one")).toBe(false); expect(attempted(f, "stop-one")).toBe(false);
  writeFileSync(f.env.FAKE_BAND!, "a question in the side view");
  const urgent = run(f, ["send", "rb", "-m", "urgent", "--id", "stop-two", "--urgent"]);
  expect(urgent.keys).toEqual([]); expect(urgent.receipt.status).toBe("queued");
  expect(JSON.parse(readFileSync(protection(f), "utf8")).stopUntil).toBe(until);
  const status = run(f, ["outstanding", "ua"]);
  expect(status.stdout).toContain("held by operator STOP until");
  expect(status.stdout).not.toContain("submits earlier when the composer is ready");
  writeFileSync(f.env.FAKE_BAND!, "START HERE"); drain(f);
  expect(attempted(f, "stop-one")).toBe(false);
  writeFileSync(f.env.FAKE_BAND!, "START"); drain(f);
  expect(sent(f, "stop-one")).toBe(true); expect(sent(f, "stop-two")).toBe(true);
  expect(notices(f).some(n => n.includes("START") && n.includes("released"))).toBe(true);
  expect(notices(f).filter(n => n.includes("STOP holds incoming mail"))).toHaveLength(1);
  const backups = readdirSync(join(f.bus, "input-backups")).map(n => readFileSync(join(f.bus, "input-backups", n), "utf8"));
  expect(backups.some(b => b.includes("recovery_policy: operator-start") && b.includes("\nSTART\n"))).toBe(true);
  expect(readFileSync(f.env.FAKE_BAND!, "utf8")).not.toBe("START");
}, 120000);

test("expired STOP takes normal draft guards without rearming or failing mail", () => {
  const f = fixture({ draft: "STOP" }); f.env.FAKE_CLEAR_INPUT = "1";
  expect(run(f, ["send", "rb", "-m", "expiry", "--id", "stop-expiry"]).receipt.status).toBe("queued");
  const file = protection(f), state = JSON.parse(readFileSync(file, "utf8"));
  state.stopUntil = Date.now() - 1000; state.graceUntil = Date.now() - 1000;
  writeFileSync(file, JSON.stringify(state));
  // Keep an unrelated draft after timeout: its ordinary backup/clear guards still apply.
  writeFileSync(f.env.FAKE_BAND!, "ordinary draft after STOP"); drain(f);
  expect(sent(f, "stop-expiry")).toBe(true);
  expect(existsSync(join(f.bus, "receipts", "stop-expiry.failed"))).toBe(false);
  const backups = readdirSync(join(f.bus, "input-backups")).map(n => readFileSync(join(f.bus, "input-backups", n), "utf8"));
  expect(backups.some(b => b.includes("ordinary draft after STOP"))).toBe(true);
}, 120000);

test("START clear is one-shot and never clears another draft on a later pass", () => {
  const f = fixture({ draft: "STOP" }); // clear deliberately has no observable effect
  expect(run(f, ["send", "rb", "-m", "one", "--id", "start-refused"]).receipt.status).toBe("queued");
  writeFileSync(f.env.FAKE_BAND!, "START"); drain(f);
  const keys = () => existsSync(f.env.FAKE_KEYS!) ? readFileSync(f.env.FAKE_KEYS!, "utf8").trim().split("\n").filter(Boolean) : [];
  expect(keys().filter(k => k.endsWith("C-u"))).toHaveLength(1);
  expect(sent(f, "start-refused")).toBe(false);
  writeFileSync(f.env.FAKE_BAND!, "different human draft"); drain(f);
  expect(keys().filter(k => k.endsWith("C-u"))).toHaveLength(1);
  expect(readFileSync(f.env.FAKE_BAND!, "utf8")).toBe("different human draft");
}, 120000);

for (const release of ["START", "expiry"] as const) test(`detached waiter observes STOP beyond its old deadline and resumes on ${release}`, async () => {
  const f = fixture({ draft: "STOP" }); f.env.FAKE_CLEAR_INPUT = "1";
  expect(run(f, ["send", "rb", "-m", "one", "--id", "watched-stop"]).receipt.status).toBe("queued");
  const metadata = join(f.bus, "spool", "watched-stop.meta.json");
  const meta = JSON.parse(readFileSync(metadata, "utf8"));
  meta.deadline_epoch = Math.floor(Date.now() / 1000) - 1;
  meta.draft_deadline_epoch = meta.deadline_epoch;
  writeFileSync(metadata, JSON.stringify(meta));
  const entry = join(f.root, "waiter.ts");
  writeFileSync(entry, `import {runWaiter} from ${JSON.stringify(join(import.meta.dir, "../src/spool-waiter-loop.ts"))};
process.exitCode = await runWaiter({argv:["watched-stop"],scriptsDir:${JSON.stringify(join(import.meta.dir, "../../../skills/tap/scripts"))},refresh:()=>null});`);
  const child = Bun.spawn([process.execPath, entry], {
    cwd: f.wt, env: { ...f.env, TAP_HOME: f.bus, TAP_SPOOL_DELIVERER_DELAYS: "0.25" }, stdout: "pipe", stderr: "pipe",
  });
  try {
    unlinkSync(f.env.FAKE_BAND!);
    await Bun.sleep(1200);
    expect(child.exitCode).toBeNull(); expect(attempted(f, "watched-stop")).toBe(false);
    expect(JSON.parse(readFileSync(metadata, "utf8")).escalated_at).toBeUndefined();
    if (release === "START") writeFileSync(f.env.FAKE_BAND!, "START");
    else {
      const file = protection(f), state = JSON.parse(readFileSync(file, "utf8"));
      state.stopUntil = Date.now() + 500;
      writeFileSync(file, JSON.stringify(state));
    }
    const until = Date.now() + 10000;
    while (!sent(f, "watched-stop") && child.exitCode === null && Date.now() < until) await Bun.sleep(50);
    expect(sent(f, "watched-stop"), existsSync(metadata) ? readFileSync(metadata, "utf8") : "spool gone").toBe(true);
    expect(await Promise.race([child.exited, Bun.sleep(3000).then(() => "hung")])).toBe(0);
  } finally {
    if (child.exitCode === null) { child.kill(); await child.exited; }
  }
}, 25000);

test("STOP expiry while a modal is open does not fail an overdue watcher probe", () => {
  const f = fixture({ draft: "STOP" });
  expect(run(f, ["send", "rb", "-m", "probe", "--id", "stopped-probe"]).receipt.status).toBe("queued");
  const file = protection(f), state = JSON.parse(readFileSync(file, "utf8"));
  state.stopUntil = Date.now() - 1000; state.graceUntil = state.stopUntil - 500000;
  writeFileSync(file, JSON.stringify(state));
  const metadata = join(f.bus, "spool", "stopped-probe.meta.json");
  const meta = JSON.parse(readFileSync(metadata, "utf8"));
  meta.first_spooled_epoch = Math.floor(state.stopUntil / 1000) - 600;
  meta.deadline_epoch = meta.first_spooled_epoch + 600;
  writeFileSync(metadata, JSON.stringify(meta));
  f.env.TAP_SPOOL_HUMAN_ALERT = "watcher";
  f.env.TAP_WATCH_TICK_QUEUED_PROBE_ID = "stopped-probe";
  f.env.TAP_WATCH_TICK_PROBE_TIMEOUT = "1";
  writeFileSync(f.env.FAKE_MODAL!, readFileSync(join(import.meta.dir, "fixtures/agent-state/claude/blocked-real.txt")));
  drain(f);
  expect(JSON.parse(readFileSync(metadata, "utf8")).escalated_at).toBeUndefined();
  expect(attempted(f, "stopped-probe")).toBe(false);
  unlinkSync(f.env.FAKE_MODAL!); unlinkSync(f.env.FAKE_BAND!); drain(f);
  expect(sent(f, "stopped-probe")).toBe(true);
}, 120000);

test("auto-permission panes honor exact STOP and START without admitting arbitrary drafts", () => {
  const f = fixture({ draft: "STOP" }); f.env.FAKE_CLEAR_INPUT = "1";
  const registry = JSON.parse(readFileSync(f.registry, "utf8")); registry.seats.rb.permissions = "auto";
  writeFileSync(f.registry, JSON.stringify(registry));
  expect(run(f, ["send", "rb", "-m", "one", "--id", "auto-stop"]).receipt.status).toBe("queued");
  expect(JSON.parse(readFileSync(protection(f), "utf8")).stopUntil).toBeGreaterThan(Date.now());
  writeFileSync(f.env.FAKE_BAND!, "START"); drain(f);
  expect(sent(f, "auto-stop")).toBe(true);
}, 120000);

test("verified START cleanup lets a quick follow-up draft receive normal grace", () => {
  const f = fixture({ draft: "STOP" }); f.env.FAKE_CLEAR_INPUT = "1";
  expect(run(f, ["send", "rb", "-m", "one", "--id", "start-done"]).receipt.status).toBe("queued");
  writeFileSync(f.env.FAKE_BAND!, "START"); drain(f);
  expect(sent(f, "start-done")).toBe(true);
  const file = protection(f);
  expect(JSON.parse(readFileSync(file, "utf8")).startRequested).toBe(false);
  unlinkSync(`${f.env.FAKE_BAND!}.submitted`);
  writeFileSync(f.env.FAKE_BAND!, "follow-up draft before an empty sample");
  const next = run(f, ["send", "rb", "-m", "two", "--id", "after-start"]);
  expect(next.receipt.status).toBe("queued");
  const state = JSON.parse(readFileSync(file, "utf8"));
  expect(state.graceUntil - Date.now()).toBeGreaterThan(25000);
  state.graceUntil = Date.now() - 1000;
  writeFileSync(file, JSON.stringify(state)); drain(f);
  expect(sent(f, "after-start")).toBe(true);
}, 120000);

for (const release of ["expiry", "START"] as const) test(`an old ${release} marker cannot suppress a later watch-probe deadline alert`, () => {
  const f = fixture({ draft: "STOP" });
  expect(run(f, ["send", "rb", "-m", "probe", "--id", "stale-stop"]).receipt.status).toBe("queued");
  const file = protection(f), state = JSON.parse(readFileSync(file, "utf8"));
  state.stopUntil = Date.now() - (release === "expiry" ? 3600000 : 60000);
  state.graceUntil = state.stopUntil - 500000;
  if (release === "START") { state.startRequested = false; state.startClearAttempted = true; }
  writeFileSync(file, JSON.stringify(state));
  const metadata = join(f.bus, "spool", "stale-stop.meta.json");
  const meta = JSON.parse(readFileSync(metadata, "utf8"));
  meta.first_spooled_epoch = Math.floor(state.stopUntil / 1000) - (release === "expiry" ? 600 : 60);
  meta.deadline_epoch = meta.first_spooled_epoch + 600;
  writeFileSync(metadata, JSON.stringify(meta));
  f.env.TAP_SPOOL_HUMAN_ALERT = "watcher";
  f.env.TAP_WATCH_TICK_QUEUED_PROBE_ID = "stale-stop";
  f.env.TAP_WATCH_TICK_PROBE_TIMEOUT = "30";
  writeFileSync(f.env.FAKE_MODAL!, readFileSync(join(import.meta.dir, "fixtures/agent-state/claude/blocked-real.txt")));
  drain(f);
  expect(JSON.parse(readFileSync(metadata, "utf8")).escalated_at).toBeTruthy();
  const alert = JSON.parse(readFileSync(join(f.bus, "watch", "notify.json"), "utf8"));
  expect(alert.reason).toContain("watch probe stale-stop");
  expect(alert.acked).toBe("0");
  expect(attempted(f, "stale-stop")).toBe(false);
}, 120000);
