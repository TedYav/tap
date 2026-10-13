// Ported from skills/tap/scripts/smoke/spool-publication-binding.test.sh
// (arms 1-4). The premise: a drain must not condemn a completed binding from a
// pre-publication snapshot, and publication custody never discards canonical
// bytes. Arms 5-6 (withdraw custody schedules, stale-claim refusals) stay in
// the shell smoke: they assert public `tap cancel` custody outcomes.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainOnce, type DrainContext } from "../src/spool-drain";
import { realDrainEffects } from "../src/spool-drain-effects";
import { listEntries } from "../src/spool-state";

const REPO = join(import.meta.dir, "../../..");
const SCRIPTS = join(REPO, "skills/tap/scripts");
const registryRow = (work: string) => JSON.stringify({
  schema: "0.20", team: { name: "t", worktree_root: work },
  seats: {
    peer: { session: "sess", pane: "sess:0.0", pane_id: "%401", harness: "codex", status: "active", server_epoch: "srv:4242:100", boot_id: "boot:1", registered_from_worktree: work },
    alice: { session: "sess", pane: "sess:0.0", pane_id: "%401", harness: "codex", status: "active", server_epoch: "srv:4242:100", boot_id: "boot:1", registered_from_worktree: work },
  },
});

let roots: string[] = [];
function sandbox(name: string) {
  const work = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), `pub-bind-${name}-`));
  roots.push(work);
  const bus = join(work, ".tap/bus");
  for (const dir of ["payloads", "receipts", "spool", "tmp", "delivery"]) mkdirSync(join(bus, dir), { recursive: true });
  writeFileSync(join(bus, ".tap-bus-authority"), "");
  writeFileSync(join(bus, "registry.json"), registryRow(work));
  // Born-live enrollment: the machine index names this scratch root as team t,
  // so public verbs resolve the acting registry without a live pane.
  mkdirSync(join(work, "index"), { recursive: true });
  writeFileSync(join(work, "index/global-registry.json"),
    JSON.stringify({ schema: "0.20", teams: { t: { root: work, registry_location: join(bus, "registry.json"), state: "registered" } } }));
  const tmux = join(work, "tmux");
  mkdirSync(tmux);
  const fakebin = join(work, "bin");
  mkdirSync(fakebin);
  // The shared fake tmux (smoke/fake-tmux-stub.sh): capture answers from
  // input.<pane-key> files, send-keys logs to send-keys.log. Adaptation: strip
  // -L/-S socket flags, and inject the FAKE_FAIL_META publication-fault hook (row 4).
  const extracted = readFileSync(join(SCRIPTS, "smoke/fake-tmux-stub.sh"), "utf8");
  expect(extracted, "fake-tmux dispatch anchor drifted (socket strip would no-op)").toContain('cmd="$1"; shift');
  const script = extracted.replace("❯", "›")
    .replace("cmd=\"$1\"; shift", [
      'while [ "${1:-}" = "-L" ] || [ "${1:-}" = "-S" ]; do shift 2; done',
      'if [ -n "${FAKE_FAIL_META:-}" ] && [ -f "$TAP_HOME/payloads/$FAKE_FAIL_META.md" ]; then',
      '  mkdir -p "$TAP_HOME/spool/$FAKE_FAIL_META.meta.json"',
      'fi',
      'cmd="$1"; shift',
    ].join("\n"));
  writeFileSync(join(fakebin, "tmux"), script, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    ...process.env, TAP_HOME: bus, TAP_INDEX_HOME: join(work, "index"), PATH: `${fakebin}:${process.env.PATH}`,
    TMUX: "/fake/socket", FAKE_TMUX_STATE: tmux, FAKE_WORKTREE: work,
    TAP_SERVER_EPOCH: "srv:4242:100", TAP_BOOT_ID: "boot:1", TAP_TUI_SETTLE_SCALE: "0.1",
  };
  delete env.TAP_SPOOL_REOWN_TOKEN;
  delete env.TAP_SPOOL_DRAIN_ACTIVE;
  delete env.TAP_SPOOL_NOW;
  // The sender child must not launch a detached deliverer that races the
  // drains under test; the sandbox owns the drain schedule explicitly.
  env.TAP_SPOOL_DISABLE_DELIVERER = "1";
  const metaField = (id: string, field: string) => {
    try { return JSON.parse(readFileSync(join(bus, "spool", `${id}.meta.json`), "utf8"))[field] ?? ""; } catch { return ""; }
  };
  const drainFixture = (due?: number) => spawnSync("bash", ["-c",
    `. "$1/smoke/runtime-helpers.sh"; . "$1/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once ${due ?? ""}`,
    "drain", SCRIPTS], { env, encoding: "utf8" });
  const parkFixture = (id: string, canon: string, reason: string) => spawnSync("bash", ["-c",
    `. "$1/smoke/runtime-helpers.sh"; . "$1/smoke/spool-park-fixture.sh"; TAP_AUTOSETTLE_HOLD_SECONDS=0 spool_park_fixture "$2" "$3" peer t "$4" "" "" sess:0.0 %401 "" standard "" "$TAP_HOME/registry.json"`,
    "publish", SCRIPTS, id, canon, reason], { env, encoding: "utf8" });
  const outstanding = (sender: string) => spawnSync(process.execPath, [join(REPO, "runtime/bun/main.ts"), "outstanding", sender],
    { env, encoding: "utf8", cwd: REPO });
  return { work, bus, tmux, env, metaField, drainFixture, parkFixture, outstanding };
}
const sendViaMain = (env: NodeJS.ProcessEnv, args: string[]) =>
  spawnSync(process.execPath, [join(REPO, "runtime/bun/main.ts"), ...args], { env, encoding: "utf8", cwd: REPO });

const PUBLICATION_BODY = `---\nid: publication-race\nfrom: alice\nto: peer\nkind: discuss\nreply: expected\n---\npublication race\n`;

test("an incomplete drain snapshot cannot condemn a binding completed mid-drain", async () => {
  const f = sandbox("race");
  const canon = join(f.work, "canonical.md");
  writeFileSync(canon, PUBLICATION_BODY);
  // The stale bait: a spool body with no metadata at all, so the first list
  // rows are incomplete by construction.
  cpSync(canon, join(f.bus, "spool/publication-race.md"));
  let count = 0;
  const ctx = {
    home: f.bus, spoolDir: join(f.bus, "spool"), payloadsDir: join(f.bus, "payloads"), receiptsDir: join(f.bus, "receipts"),
    eventLog: join(f.bus, "registry-events.log"), team: "t", actingRegistry: join(f.bus, "registry.json"), verbLabel: "tap",
    scriptsDir: SCRIPTS, courierIdentity: "courier", alert: { mode: "none" } as const,
    now: Math.floor(Date.now() / 1000), unroutedGrace: 1800, env: f.env,
  };
  const drainCtx: DrainContext = ctx;
  const effects = realDrainEffects(drainCtx);
  (effects as { entries: (target: string, registry: string) => unknown }).entries = (target: string, registry: string) => {
    const rows = listEntries(ctx.spoolDir, target, registry);
    count += 1;
    if (count === 2) {
      // Finish the REAL publication between the snapshot and Phase B.
      const result = f.parkFixture("publication-race", canon, "window");
      if (result.status !== 0) throw new Error(`real publication failed: ${result.stderr}`);
    }
    return rows;
  };
  await drainOnce(drainCtx, effects, undefined);
  expect(f.metaField("publication-race", "reason"), "complete fresh binding was marked from an incomplete snapshot").toBe("window");
  // The completed park is sender-visible immediately after this first drain.
  const out = f.outstanding("alice");
  expect(out.status, out.stderr).toBe(0);
  expect(out.stdout).toMatch(/publication-race.*spooled.*window/);
  // A next tick must deliver through the original binding, not leave an orphan.
  f.drainFixture();
  expect(existsSync(join(f.bus, "receipts/publication-race.sent")), "next drain did not deliver the completed entry").toBe(true);
  expect(existsSync(join(f.bus, "spool/publication-race.meta.json")), "delivered entry retained its spool metadata").toBe(false);
}, 30_000);

test("a complete metadata file truly lacking identity fails closed and stays sender-visible", () => {
  const f = sandbox("legacy");
  const canon = join(f.work, "legacy.md");
  writeFileSync(canon, PUBLICATION_BODY.replace(/publication-race/g, "legacy-missing-binding"));
  const parked = f.parkFixture("legacy-missing-binding", canon, "window");
  expect(parked.status, parked.stderr).toBe(0);
  const metaPath = join(f.bus, "spool/legacy-missing-binding.meta.json");
  const row = JSON.parse(readFileSync(metaPath, "utf8"));
  delete row.pane_id;
  writeFileSync(metaPath, JSON.stringify(row));
  f.drainFixture();
  expect(f.metaField("legacy-missing-binding", "reason"), "true missing binding no longer marked").toBe("legacy_meta_no_binding");
  expect(existsSync(join(f.bus, "receipts/legacy-missing-binding.sent")), "true missing binding reached a pane").toBe(false);
  const out = f.outstanding("alice");
  expect(out.status, out.stderr).toBe(0);
  expect(out.stdout).toMatch(/legacy-missing-binding.*spooled.*legacy_meta_no_binding/);
}, 30_000);

test("a sender paused at post-publication cleanup never loses a concurrent delivery", async () => {
  const f = sandbox("removal");
  const raceId = "sender-removal-race";
  const canon = join(f.bus, "payloads", `${raceId}.md`);
  const spoolBody = join(f.bus, "spool", `${raceId}.md`);
  const barrier = join(f.work, "removal-barrier");
  mkdirSync(barrier);
  writeFileSync(join(f.tmux, "input.sess_0_0"), "human-draft");
  const senderEnv = { ...f.env, TAP_SCRATCH_ONLY: f.work, TAP_PARK_TEST_BARRIER: join(barrier, "park"), TAP_AUTOSETTLE_HOLD_SECONDS: "60" };
  const senderLog = join(f.work, "removal-send.log");
  // exec keeps this PID the sender's, and the log gives failures their voice
  // the way the retired shell cat'd removal-send.log.
  const sender = Bun.spawn(["/bin/sh", "-c",
    `exec '${process.execPath}' '${join(REPO, "runtime/bun/main.ts")}' send peer --ask --id '${raceId}' --from alice -m 'sender removal custody' >> '${senderLog}' 2>&1`],
    { env: senderEnv, cwd: REPO, stdin: "ignore" });
  try {
    let ready = false;
    for (let i = 0; i < 400 && sender.exitCode === null; i++) {
      if (existsSync(join(barrier, "park.ready"))) { ready = true; break; }
      await Bun.sleep(50);
    }
    const senderSoFar = existsSync(senderLog) ? readFileSync(senderLog, "utf8") : "(no sender output)";
    expect(ready, `sender never reached post-publication canonical removal\n${senderSoFar}`).toBe(true);
    expect(existsSync(spoolBody) && existsSync(join(f.bus, "spool", `${raceId}.meta.json`)), "removal barrier preceded complete publication").toBe(true);
    rmSync(join(f.tmux, "input.sess_0_0"));
    const expected = readFileSync(spoolBody);
    const due = Math.floor(Date.now() / 1000) + 3600;
    // Only the sender's park pauses; a drain's re-park must not.
    const drainEnv = { ...f.env };
    delete drainEnv.TAP_PARK_TEST_BARRIER;
    spawnSync("bash", ["-c", `. "$1/smoke/runtime-helpers.sh"; . "$1/smoke/spool-engine-fixture.sh"; TAP_PARK_TEST_BARRIER= spool_drain_fixture_once ${due}`, "drain", SCRIPTS],
      { env: drainEnv, encoding: "utf8" });
    writeFileSync(join(barrier, "park.continue"), "");
    expect(await sender.exited, "sender exited nonzero").toBe(0);
    spawnSync("bash", ["-c", `. "$1/smoke/runtime-helpers.sh"; . "$1/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once ${due}`, "drain", SCRIPTS],
      { env: drainEnv, encoding: "utf8" });
    expect(existsSync(join(f.bus, "receipts", `${raceId}.sent`)), "parked message was never delivered").toBe(true);
    expect(existsSync(canon), "sender removed the message the concurrent drain delivered").toBe(true);
    expect(readFileSync(canon), "delivered body changed during custody transfer").toEqual(expected);
    const keys = existsSync(join(f.tmux, "send-keys.log")) ? readFileSync(join(f.tmux, "send-keys.log"), "utf8") : "";
    expect([...keys.matchAll(new RegExp(raceId, "g"))].length, `expected exactly one delivery`).toBe(1);
    expect(existsSync(join(f.bus, "spool", `${raceId}.claim`)), "sender left its publication claim behind").toBe(false);
  } finally {
    writeFileSync(join(barrier, "park.continue"), "");
    if (sender.exitCode === null) { sender.kill("SIGKILL"); await sender.exited; }
  }
}, 40_000);

test("a failed metadata publication reports retained poll custody and keeps the canonical bytes", () => {
  const f = sandbox("native");
  const faultId = "native-publication-failed";
  writeFileSync(join(f.tmux, "input.sess_0_0"), "human-draft");
  // The fault rides the fake tmux (as the retired shell hook did): once the
  // canonical is placed, the next tmux call plants a DIRECTORY at the metadata
  // destination, so the real atomic rename fails mid-park.
  const trace = join(f.work, "native-failure.trace");
  const result = sendViaMain({ ...f.env, TAP_BUN_ROUTE_TRACE: trace, FAKE_FAIL_META: faultId },
    ["send", "peer", "--ask", "--id", faultId, "--from", "alice", "-m", "retain native publication bytes", "--json"]);
  expect(result.status, JSON.stringify({ out: result.stdout, err: result.stderr })).toBe(0);
  expect(readFileSync(trace, "utf8").split("\n")).toContain("native send");
  expect(result.stderr).toContain("spool publication failed; canonical payload retained");
  const receipt = JSON.parse(result.stdout);
  expect([receipt.status, receipt.delivery, receipt.reason]).toEqual(["queued", "poll", "spool_park_failed"]);
  expect(readFileSync(join(f.bus, "payloads", `${faultId}.md`), "utf8")).toContain("retain native publication bytes");
  expect(existsSync(join(f.bus, "receipts", `${faultId}.placed`)), "native failure lost placement attribution").toBe(true);
  expect(existsSync(join(f.bus, "receipts", `${faultId}.sent`)), "native failure claimed delivery").toBe(false);
  expect(existsSync(join(f.bus, "spool", `${faultId}.claim`)), "native failure leaked claim").toBe(false);
  const keys = existsSync(join(f.tmux, "send-keys.log")) ? readFileSync(join(f.tmux, "send-keys.log"), "utf8") : "";
  expect(keys, "native failure injected a message").toBe("");
}, 30_000);

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
