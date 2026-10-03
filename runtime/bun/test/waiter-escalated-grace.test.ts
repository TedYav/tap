import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { spawnSync } from "node:child_process";

// The failure rows plant a DIRECTORY where a receipt file would land, so the
// blocked-disposal check is about regular files, not path existence.
const isFile = (path: string) => { try { return statSync(path).isFile(); } catch { return false; } };

const repo = join(import.meta.dir, "../../..");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// The retired smoke's sandbox: a copied tree whose loop module can be patched
// with a probe barrier, a fixture bus, a stateful fake tmux, and the package's
// own bin/tap. No drain, escalation, receipt, or source-refresh code is
// substituted — only the loop's sleep site is instrumented.
function sandbox() {
  const work = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "escgrace-"));
  roots.push(work);
  const scripts = join(work, "skills/tap/scripts");
  mkdirSync(join(scripts, "smoke"), { recursive: true });
  for (const helper of ["runtime-helpers.sh", "runtime-primitives.sh"])
    cpSync(join(repo, "skills/tap/scripts/smoke", helper), join(scripts, "smoke", helper));
  for (const entry of readdirSync(join(repo, "skills/tap/scripts"), { withFileTypes: true })) {
    if (["smoke", "regress", "__pycache__"].includes(entry.name)) continue;
    entry.isDirectory()
      ? cpSync(join(repo, "skills/tap/scripts", entry.name), join(scripts, entry.name), { recursive: true })
      : cpSync(join(repo, "skills/tap/scripts", entry.name), join(scripts, entry.name));
  }
  cpSync(join(repo, "runtime/bun/src"), join(work, "runtime/bun/src"), { recursive: true });
  // fzf-tool.ts imports ../../../vendor/fzf/manifest.json, so the copied tree needs the manifest at its own root.
  mkdirSync(join(work, "vendor/fzf"), { recursive: true });
  cpSync(join(repo, "vendor/fzf/manifest.json"), join(work, "vendor/fzf/manifest.json"));
  cpSync(join(repo, "runtime/bun/test/support"), join(work, "runtime/bun/test/support"), { recursive: true });
  cpSync(join(repo, "runtime/bun/main.ts"), join(work, "runtime/bun/main.ts"));
  mkdirSync(join(work, "bin"));
  cpSync(join(repo, "bin/tap"), join(work, "bin/tap"));
  const bus = join(work, "bus");
  for (const name of ["spool", "receipts", "payloads", "delivery"]) mkdirSync(join(bus, name), { recursive: true });
  writeFileSync(join(bus, ".tap-bus-authority"), "");
  writeFileSync(join(bus, "registry.json"), JSON.stringify({
    schema: "0.20", team: { name: "fixture", worktree_root: work },
    seats: Object.fromEntries([["peer", "sess:0.0", "%401"], ["alice", "sess:0.1", "%402"]].map(([name, pane, paneId]) => [name, {
      session: "sess", pane, pane_id: paneId, harness: "codex", status: "active",
      server_epoch: "srv:4242:100", boot_id: "boot:1", registered_from_worktree: work,
    }])),
  }));
  // The gather resolves the recipient bus through the global team index; an
  // empty live index sends it down the file-pinned registry path.
  mkdirSync(join(bus, "index"), { recursive: true });
  writeFileSync(join(bus, "index", "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} }));
  const state = join(work, "tmux");
  mkdirSync(state);
  // The shared fake tmux (smoke/fake-tmux-stub.sh, also courier-busy-hold's), with
  // the two adaptations the native observer needs (socket-flag stripping and the
  // three-field session format).
  let tmuxScript = readFileSync(join(repo, "skills/tap/scripts/smoke/fake-tmux-stub.sh"), "utf8")
    .replaceAll("\u276f", "\u203a");
  const strip = 'cmd="$1"; shift';
  expect(tmuxScript.includes(strip), "fake-tmux-stub: dispatch anchor drifted").toBe(true);
  tmuxScript = tmuxScript.replace(strip, 'while [ "${1:-}" = "-L" ] || [ "${1:-}" = "-S" ]; do shift 2; done\ncmd="$1"; shift');
  const sessions = "list-sessions) printf 'sess\\t4242:100\\n' ;;";
  expect(tmuxScript.includes(sessions), "fake-tmux-stub: list-sessions anchor drifted").toBe(true);
  writeFileSync(join(work, "bin", "tmux"), tmuxScript.replace(sessions, "list-sessions) printf 'sess\\t4242:100\\t1\\n' ;;"), { mode: 0o755 });
  // Stop at the waiter's actual sleep, before its refresh check.
  const loopPath = join(work, "runtime/bun/src/spool-waiter-loop.ts");
  const original = readFileSync(loopPath, "utf8");
  const anchor = "if (wait > 0) {";
  expect(original.split(anchor).length - 1, "spool-waiter-loop sleep anchor drifted").toBe(1);
  writeFileSync(loopPath, 'import * as probeFs from "node:fs";\nlet probeSleeps = 0;\n' + original.replace(anchor,
    `if (wait > 0) {
    const n = ++probeSleeps;
    probeFs.writeFileSync(process.env.PROBE_WORK + "/sleeping-" + n, "");
    const barrier = Date.now() + 30000;
    while (!probeFs.existsSync(process.env.PROBE_WORK + "/release-" + n) && Date.now() < barrier) await Bun.sleep(10);`));
  return { work, bus, scripts, state, loopPath, original };
}

function combo(work: string, bus: string, opts: { existing: boolean; multi: boolean; senderUp: boolean; failure?: "canonical" | "receipt" }) {
  const ident = "escalated-grace";
  const payload = join(bus, `spool/${ident}.md`);
  const body = `---\nid: escalated-grace\nfrom: alice\nto: peer\nkind: ask\nreply: expected\npath: ${bus}/payloads/${ident}.md\n---\nincident body\n`;
  writeFileSync(payload, body);
  writeFileSync(join(bus, `spool/${ident}.meta.json`), JSON.stringify({
    id: ident, target: "peer", to_team: "fixture", target_registry: join(bus, "registry.json"),
    pane: "sess:0.0", pane_id: "%401", reason: "pending-input", reason_class: "busy", policy: "standard",
    first_spooled_epoch: Math.floor(Date.now() / 1000) - 500, deadline_epoch: Math.floor(Date.now() / 1000) + 90,
    waiter_lifetime: "grace-window", escalated_at: opts.existing ? "2026-09-05T14:59:36Z" : "",
    attempts: opts.existing ? 1 : 0,
  }));
  if (opts.existing) writeFileSync(join(bus, `receipts/${ident}.attempted`), JSON.stringify({ id: ident, effect: "possible" }));
  const pending = opts.multi ? "[[TAP v0.23 ask one]] [[TAP v0.23 ask two]]" : opts.existing ? "human draft" : "[[TAP v0.23 ask";
  writeFileSync(join(work, "tmux/input.sess_0_0"), pending);
  if (!opts.senderUp) {
    const registryPath = join(bus, "registry.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    delete registry.seats.alice;
    writeFileSync(registryPath, JSON.stringify(registry));
  }
  if (!opts.existing) writeFileSync(join(work, "tmux/stuck_submit"), "");
  if (opts.failure === "canonical") mkdirSync(join(bus, `payloads/${ident}.md`));
  if (opts.failure === "receipt") mkdirSync(join(bus, `receipts/${ident}.unconfirmed`));
  return { ident, payload, pending, body };
}

function waiterEnv(work: string, bus: string): NodeJS.ProcessEnv {
  return {
    ...process.env, TAP_HOME: bus, PROBE_WORK: work, PATH: `${join(work, "bin")}:${process.env.PATH}`,
    TAP_SPOOL_DELIVERER_DELAYS: ".05", TAP_SPOOL_DISABLE_DELIVERER: "1", TAP_SPOOL_NOW: String(Math.floor(Date.now() / 1000) + 91),
    TAP_TUI_SETTLE_SCALE: "0.1", TAP_SERVER_EPOCH: "srv:4242:100", TAP_BOOT_ID: "boot:1",
    FAKE_TMUX_STATE: join(work, "tmux"), FAKE_WORKTREE: work, TMUX: "/fake/socket",
    TAP_SPOOL_REOWN_TOKEN: undefined as unknown as string,
  };
}

function startWaiter(work: string, bus: string, ident: string) {
  const log = join(work, "waiter.log");
  // exec keeps the spawned PID as the waiter's own.
  return Bun.spawn(["/bin/sh", "-c", `exec '${process.execPath}' '${join(work, "runtime/bun/src/spool-waiter.ts")}' '${ident}' >> '${log}' 2>&1`],
    { env: waiterEnv(work, bus), stdin: "ignore" });
}

async function waitBarrier(work: string, name: string, deadlineMs: number) {
  const path = join(work, name);
  for (const deadline = Date.now() + deadlineMs; Date.now() < deadline;) {
    if (existsSync(path)) return true;
    await Bun.sleep(20);
  }
  return existsSync(path);
}

const drain = (work: string, bus: string) => spawnSync("bash", ["-c", '. "$1"; . "$2"; spool_drain_fixture_once', "_",
  join(work, "skills/tap/scripts/smoke/runtime-helpers.sh"), join(repo, "skills/tap/scripts/smoke/spool-engine-fixture.sh")],
  { env: waiterEnv(work, bus), encoding: "utf8" });
const tap = (work: string, ...args: string[]) => spawnSync("bash", [join(work, "bin", "tap"), ...args],
  { env: waiterEnv(work, join(work, "bus")), encoding: "utf8" });
const keysLog = (work: string) => {
  const path = join(work, "tmux/send-keys.log");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};

for (const multi of [false, true]) for (const senderUp of [true, false]) test(
  `an escalated entry disposes canonically with nobody told (multi=${multi}, sender_up=${senderUp})`, async () => {
    const s = sandbox();
    const { ident, payload, body } = combo(s.work, s.bus, { existing: true, multi, senderUp });
    const waiter = startWaiter(s.work, s.bus, ident);
    try {
      expect(await waitBarrier(s.work, "sleeping-1", 20_000), "the escalated waiter never reached its first sleep").toBe(true);
      writeFileSync(join(s.work, "release-1"), "");
      const hung = await Promise.race([waiter.exited.then(() => false), Bun.sleep(15_000).then(() => true)]);
      expect(hung, readFileSync(join(s.work, "waiter.log"), "utf8")).toBe(false);
      expect(waiter.exitCode, "waiter exit").toBe(0);
      expect(existsSync(join(s.bus, `receipts/${ident}.done`)), "disposal settled the ask").toBe(false);
      expect(existsSync(join(s.bus, `receipts/${ident}.cancelled`)), "disposal cancelled the ask").toBe(false);
      expect(readFileSync(join(s.bus, `payloads/${ident}.md`), "utf8"), "canonical move lost bytes").toBe(body);
      // The spool body stays byte-identical until explicit settlement: the
      // grace contract requires canonical AND spool copies to coexist.
      expect(readFileSync(payload, "utf8"), "disposal consumed the spool body").toBe(body);
      const receipt = JSON.parse(readFileSync(join(s.bus, `receipts/${ident}.unconfirmed`), "utf8"));
      const notice = readFileSync(join(s.bus, "payloads", `${receipt.notice_id}.md`), "utf8");
      expect(notice).toContain("DELIVERY UNCONFIRMED");
      expect(notice).toContain(join(s.bus, `payloads/${ident}.md`));
      const calls = keysLog(s.work);
      expect(calls, "the recipient pane received text during disposal").not.toContain("-t sess:0.0 -l");
      expect(readFileSync(join(s.work, "tmux/input.sess_0_0"), "utf8")).toBe(multi ? "[[TAP v0.23 ask one]] [[TAP v0.23 ask two]]" : "human draft");
      // Re-enter the real drain after the partial lifecycle: the notice stays
      // unique and no second pane effect appears.
      const again = drain(s.work, s.bus);
      expect(again.status, again.stderr).toBe(0);
      expect(keysLog(s.work)).toBe(calls);
      const notices = readdirSync(join(s.bus, "payloads")).filter(name => name.endsWith(".md") && readFileSync(join(s.bus, "payloads", name), "utf8").includes("kind: delivery-failed"));
      expect(notices).toEqual([`${receipt.notice_id}.md`]);
      const outstanding = spawnSync("bash", [join(repo, "bin/tap"), "outstanding", "alice", "--json"], { env: waiterEnv(s.work, s.bus), encoding: "utf8" });
      expect([0, 2]).toContain(outstanding.status!);
      const rows = JSON.parse(outstanding.stdout).outstanding as { id: string }[];
      expect(rows.filter(row => row.id === ident)).toHaveLength(1);
      if (senderUp) {
        const native = spawnSync(process.execPath, [join(repo, "runtime/bun/test/support/native-outstanding-entry.ts"), "alice", "--json"],
          { env: waiterEnv(s.work, s.bus), encoding: "utf8" });
        expect(native.status).toBe(outstanding.status);
        expect(JSON.parse(native.stdout)).toEqual(JSON.parse(outstanding.stdout));
        const cancelled = tap(s.work, "cancel", ident, "--by", "alice", "--spooled");
        expect(cancelled.status, cancelled.stderr).toBe(0);
        expect(existsSync(join(s.bus, "archive", `${ident}.cancelled.md`))).toBe(true);
        expect(existsSync(payload)).toBe(false);
        expect(JSON.parse(readFileSync(join(s.bus, `receipts/${ident}.cancelled`), "utf8")).reason).toBe("unconfirmed_withdrawn");
      }
    } finally {
      writeFileSync(join(s.work, "release-1"), "");
      if (waiter.exitCode === null) { waiter.kill(); await waiter.exited; }
    }
  }, 60_000);

for (const multi of [false, true]) test(`a refused pre-effect grace park keeps its waiter and its custody through two sleeps (multi=${multi})`, async () => {
  const s = sandbox();
  const { ident, pending } = combo(s.work, s.bus, { existing: false, multi, senderUp: true });
  const waiter = startWaiter(s.work, s.bus, ident);
  try {
    expect(await waitBarrier(s.work, "sleeping-1", 20_000), "the refused waiter never slept").toBe(true);
    writeFileSync(join(s.work, "release-1"), "");
    expect(await waitBarrier(s.work, "sleeping-2", 20_000), "the refused waiter did not re-arm its sleep").toBe(true);
    expect(waiter.exitCode, "the waiter gave up on a refused park").toBeNull();
    expect(existsSync(join(s.bus, `spool/${ident}.md`)), "refusal lost the parked body").toBe(true);
    expect(existsSync(join(s.bus, `receipts/${ident}.attempted`)), "refusal minted an attempted receipt").toBe(false);
    expect(existsSync(join(s.bus, `receipts/${ident}.unconfirmed`)), "refusal minted an unconfirmed receipt").toBe(false);
    expect(keysLog(s.work), "refusal injected into the stuck pane").not.toContain("-t sess:0.0 -l");
    // disposeGrace mints the durable notice BEFORE attempting the receipt, so a
    // partial disposition could leave a delivery-failed payload while the
    // receipt assertions above still pass. A refused, retry-owed park cannot
    // tell the sender delivery failed.
    expect(readdirSync(join(s.bus, "payloads")).filter(name => name.endsWith(".md") && readFileSync(join(s.bus, "payloads", name), "utf8").includes("kind: delivery-failed")),
      "a refused park published a delivery-failed notice").toEqual([]);
    expect(readFileSync(join(s.work, "tmux/input.sess_0_0"), "utf8")).toBe(pending);
  } finally {
    writeFileSync(join(s.work, "release-2"), "");
    if (waiter.exitCode === null) { waiter.kill(); await waiter.exited; }
  }
}, 45_000);

for (const failure of ["canonical", "receipt"] as const) test(
  `a blocked disposal keeps custody and recovery neither duplicates nor re-wakes (${failure})`, async () => {
    const s = sandbox();
    const { ident, body } = combo(s.work, s.bus, { existing: true, multi: false, senderUp: true, failure });
    const waiter = startWaiter(s.work, s.bus, ident);
    try {
      expect(await waitBarrier(s.work, "sleeping-1", 20_000), "the waiter never reached its first sleep").toBe(true);
      writeFileSync(join(s.work, "release-1"), "");
      const hung = await Promise.race([waiter.exited.then(() => false), Bun.sleep(15_000).then(() => true)]);
      expect(hung, readFileSync(join(s.work, "waiter.log"), "utf8")).toBe(false);
      expect(waiter.exitCode, "waiter exit").toBe(0);
      expect(existsSync(join(s.bus, `spool/${ident}.md`)), "failed disposition lost custody").toBe(true);
      expect(!isFile(join(s.bus, `receipts/${ident}.unconfirmed`)), "blocked disposal minted an unconfirmed receipt").toBe(true);
      expect(existsSync(join(s.bus, `receipts/${ident}.cancelled`)), "blocked disposal cancelled the ask").toBe(false);
      const priorCalls = keysLog(s.work);
      if (failure === "canonical") rmdirSync(join(s.bus, `payloads/${ident}.md`));
      else rmdirSync(join(s.bus, `receipts/${ident}.unconfirmed`));
      const recovery = drain(s.work, s.bus);
      expect(recovery.status, recovery.stderr).toBe(0);
      // Exit 0 is not proof of recovery: disposeGraceDue reports
      // `grace_disposition_incomplete` and still returns success when
      // disposeGrace fails. The recovered disposition must actually exist.
      expect(readFileSync(join(s.bus, `payloads/${ident}.md`), "utf8"), "recovery never produced the canonical copy").toBe(body);
      expect(readFileSync(join(s.bus, `spool/${ident}.md`), "utf8"), "recovery lost the spool body").toBe(body);
      const recovered = JSON.parse(readFileSync(join(s.bus, `receipts/${ident}.unconfirmed`), "utf8"));
      expect(readFileSync(join(s.bus, "payloads", `${recovered.notice_id}.md`), "utf8")).toContain("DELIVERY UNCONFIRMED");
      if (failure === "receipt") expect(keysLog(s.work), "receipt recovery repeated notice wake").toBe(priorCalls);
      // The same recovery must not re-wake the recipient or double-publish on
      // the drain after it.
      const afterCalls = keysLog(s.work);
      const again = drain(s.work, s.bus);
      expect(again.status, again.stderr).toBe(0);
      expect(keysLog(s.work)).toBe(afterCalls);
      expect(readdirSync(join(s.bus, "payloads")).filter(name => name.endsWith(".md") && readFileSync(join(s.bus, "payloads", name), "utf8").includes("kind: delivery-failed")),
        "recovery duplicated the sender notice").toEqual([`${recovered.notice_id}.md`]);
    } finally {
      writeFileSync(join(s.work, "release-1"), "");
      if (waiter.exitCode === null) { waiter.kill(); await waiter.exited; }
    }
  }, 60_000);

// Ported from the retired smoke's watcher section: the deliverer disposed this
// entry with nobody told (no human marker, no alert), so a later drain that
// runs INSIDE the watcher (TAP_SPOOL_HUMAN_ALERT=watcher, tap-watch.sh
// _watch_process_spool) must still alert, exactly once, and degrade loudly
// when the alert cannot publish. The deliverer's disposal is arranged directly
// — its effects are the premise (canonical body move, unconfirmed receipt with
// its sender notice, no human_escalated_at), not the subject.
test("a watcher drain alerts once for a deliverer-disposed escalation, degrades loudly when blocked, and deduplicates on ack", async () => {
  const s = sandbox();
  const { ident, body } = combo(s.work, s.bus, { existing: true, multi: false, senderUp: true });
  // The deliverer's disposal is the REAL waiter's rc-0 run (the disposal rows
  // prove it): canonical move + custody receipt + whatever state the alert
  // sweep reads. A hand-arranged copy of those effects leaves the sweep blind.
  const disposed = startWaiter(s.work, s.bus, ident);
  // The loop patch parks the waiter at its first sleep; release it so the
  // disposal completes like it does in the disposal rows.
  expect(await waitBarrier(s.work, "sleeping-1", 20_000), "the escalated waiter never reached its first sleep").toBe(true);
  writeFileSync(join(s.work, "release-1"), "");
  expect(await Promise.race([disposed.exited, Bun.sleep(20_000).then(() => "hung")]), "disposal never finished").toBe(0);
  const noticeId = readdirSync(join(s.bus, "payloads")).find(name => name.includes("unconfirmed"))!.replace(/\.md$/, "");
  const metaPath = join(s.bus, `spool/${ident}.meta.json`);
  const metaOf = (id = ident) => JSON.parse(readFileSync(join(s.bus, `spool/${id}.meta.json`), "utf8"));
  const notifyPath = join(s.bus, "watch/notify.json");
  const notifyState = () => isFile(notifyPath) ? JSON.parse(readFileSync(notifyPath, "utf8")) : null;
  const seedAcked = (at: number) => {
    mkdirSync(join(s.bus, "watch"), { recursive: true });
    writeFileSync(notifyPath, JSON.stringify({ type: "NOTIFY", at, reason: "earlier episode alert", acked: "1" }));
  };
  // The watcher states its alert duty at its drain call; this is that call.
  const watchDrain = () => spawnSync("bash", ["-c",
    'LIB="$1"; FIXTURE="$2"; set --; . "$LIB"; . "$FIXTURE"; TAP_SPOOL_HUMAN_ALERT=watcher; spool_drain_fixture_once; echo DRAIN_RC=$?', "_",
    join(s.work, "skills/tap/scripts/smoke/runtime-helpers.sh"), join(repo, "skills/tap/scripts/smoke/spool-engine-fixture.sh")],
    { env: waiterEnv(s.work, s.bus), encoding: "utf8" });
  const keys = () => keysLog(s.work);
  const recipientKeys = () => keys().split("\n").filter(line => line.includes("-t sess:0.0"));
  const notices = () => readdirSync(join(s.bus, "payloads")).filter(name => name.endsWith(".md")
    && readFileSync(join(s.bus, "payloads", name), "utf8").includes("kind: delivery-failed")).sort();
  const beforeKeys = keys(), beforeNotices = notices(), beforeRecipientKeys = recipientKeys();

  // (a) publication failure: a read-only watch/ makes the NOTIFY write fail
  // where it is written (a notify.json DIRECTORY does not work: the atomic
  // rename moves the temp file INTO it and reports success). The disposal
  // reports incomplete and claims NO human completion.
  mkdirSync(join(s.bus, "watch"), { recursive: true });
  chmodSync(join(s.bus, "watch"), 0o500);
  try {
    const blocked = watchDrain();
    expect(blocked.stdout).toContain("DRAIN_RC=0");
    expect(metaOf().human_escalated_at, "a failed alert claimed a human completion").toBeUndefined();
    expect(existsSync(notifyPath), "the failed publication still wrote an alert").toBe(false);
    expect(blocked.stderr, "a failed alert suppressed the degraded transports too").toContain("attention");
    const reported: string[] = [];
    const scan = (dir: string) => { for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isFile() && [".jsonl", ".log"].includes(extname(name.name)) && readFileSync(p, "utf8").includes("grace_disposition_incomplete")) reported.push(p);
      else if (name.isDirectory() && !p.includes("/watch")) scan(p);
    } };
    scan(s.work);
    expect(reported.length, "a failed human alert was not reported as an incomplete disposition").toBeGreaterThan(0);
  } finally { chmodSync(join(s.bus, "watch"), 0o700); }

  // (b) deliverer-first -> watcher: one sticky alert despite an earlier ACKED
  // one, one human marker, no new recipient effect.
  seedAcked(1);
  const sticky = watchDrain();
  expect(sticky.status).toBe(0);
  const alert = notifyState();
  expect(alert && String(alert.acked) === "0" && alert.at !== 1, JSON.stringify(alert)).toBe(true);
  expect(String(alert!.reason), alert).toContain("escalated-grace");
  const marked = metaOf().human_escalated_at;
  expect(marked, metaOf()).toBeTruthy();
  expect(keys()).toBe(beforeKeys);
  expect(notices()).toEqual(beforeNotices);

  // (c) after the operator acks THAT alert, a later drain is quiet: the
  // per-entry marker, not the sticky-unacked guard, deduplicates.
  writeFileSync(notifyPath, JSON.stringify({ ...alert, acked: "1" }));
  expect(watchDrain().status).toBe(0);
  expect(String(notifyState()!.acked)).toBe("1");
  expect(metaOf().human_escalated_at).toBe(marked);

  // (d) watcher-first: a second entry the watcher disposes itself alerts on
  // that same pass, once, with its own durable sender notice.
  const other = "escalated-grace-watcher-first";
  const om = { ...metaOf() };
  for (const gone of ["escalated_at", "human_escalated_at", "attempts", "attempt_fence"]) delete (om as Record<string, unknown>)[gone];
  om.id = other;
  om.first_spooled_epoch = Math.floor(Date.now() / 1000) - 500;
  om.deadline_epoch = Math.floor(Date.now() / 1000) - 10;
  om.waiter_lifetime = "grace-window";
  writeFileSync(join(s.bus, `spool/${other}.md`), body.replace(ident, other));
  writeFileSync(join(s.bus, `spool/${other}.meta.json`), JSON.stringify(om));
  // The grace-attempted check (spool-deadline.ts) reads this receipt plus the
  // grace-window lifetime; without it the entry never reaches the disposal.
  writeFileSync(join(s.bus, `receipts/${other}.attempted`), JSON.stringify({ id: other, effect: "possible" }));
  seedAcked(2);
  expect(watchDrain().status).toBe(0);
  const alert2 = notifyState();
  expect(alert2 && String(alert2.acked) === "0" && alert2.at !== 2, JSON.stringify(alert2)).toBe(true);
  expect(metaOf(other).human_escalated_at, metaOf(other)).toBeTruthy();
  const otherReceipt = JSON.parse(readFileSync(join(s.bus, `receipts/${other}.unconfirmed`), "utf8"));
  const otherNotice = `${otherReceipt.notice_id}.md`;
  expect(readFileSync(join(s.bus, "payloads", otherNotice), "utf8")).toContain("DELIVERY UNCONFIRMED");
  expect(readdirSync(join(s.bus, "payloads")).filter(name => name.startsWith(other)
    && readFileSync(join(s.bus, "payloads", name), "utf8").includes("kind: delivery-failed")), otherNotice).toEqual([otherNotice]);
  expect(recipientKeys()).toEqual(beforeRecipientKeys);
  const afterFirst = { notices: notices(), keys: keys() };
  writeFileSync(notifyPath, JSON.stringify({ ...alert2, acked: "1" }));
  expect(watchDrain().status).toBe(0);
  expect(String(notifyState()!.acked)).toBe("1");
  expect({ notices: notices(), keys: keys() }).toEqual(afterFirst);
  expect(recipientKeys()).toEqual(beforeRecipientKeys);

  for (const stray of [join(s.bus, `spool/${other}.md`), join(s.bus, `spool/${other}.meta.json`), join(s.bus, `spool/${other}.meta.json.lock`)])
    if (existsSync(stray)) rmSync(stray);
  for (const name of readdirSync(join(s.bus, "payloads"))) if (name.startsWith(other)) rmSync(join(s.bus, "payloads", name));
  for (const name of readdirSync(join(s.bus, "receipts"))) if (name.startsWith(other)) rmSync(join(s.bus, "receipts", name));
  rmSync(notifyPath, { force: true });
}, 60_000);
