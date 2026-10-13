import { realDrainEffects } from "../src/spool-drain-effects";
import { type DrainContext, type SpoolBinding } from "../src/spool-drain";
import { processWatchSpool } from "../src/spool-watch";
// spool-park-report.ts: the park's whole route in process — the cue flash, the
// deliverer spawn, the backlog warning, the injection facts, the queued receipts —
// and the CLI door lib.sh's `tap_spool_park_placed` adapts. The pane arms run against
// a REAL tmux server on the runner's private socket (`TAP_TMUX_SOCKET`), so the flash
// token, the tint and the verified clear are observed, not mocked.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { recordHarnessQueued } from "../src/harness-queue";
import { queueExplanation } from "../src/queue-explanation";
import { acquirePaneLock, acquirePathLock } from "../src/panelock";
import { reownAfterRepark, reownClaim, reownPath } from "../src/spool-reown";
import {
  type FlashInput, type ParkReport, type ParkReportInput, type SpawnDelivererInput,
  CLOBBER_BLINK, CUE_DWELL_MS, STALE_CUE_TOKEN_MS, beginPaneCue, endPaneCue,
  flashPane, flashPaneLocked, main, paneEffectClearVerified, parkAndReport, renderParkReceipt, serverEpochNow, spawnDeliverer,
} from "../src/spool-park-report";
import { tintPane } from "../src/pane-tint";
import { clearTints } from "../src/watch-sidecar";

const NOW = new Date("2026-09-16T07:00:00Z");
const roots: string[] = [];
function scratch(): string {
  const r = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "spool-park-report-")); roots.push(r); return r;
}
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

// One private server for the pane arms; the socket name is this file's own.
const socket = `tapbun-park-report-${crypto.randomUUID().slice(0, 8)}`;
const tmuxBin = process.env.TAP_TMUX ?? "tmux";
const tmux = (...args: string[]): string => {
  const r = spawnSync(tmuxBin, ["-L", socket, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tmux ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.replace(/\n$/, "");
};
let paneId = "";
beforeAll(() => {
  tmux("new-session", "-d", "-s", "flash", "-x", "80", "-y", "24", "sleep 300");
  paneId = tmux("display-message", "-p", "-t", "flash:0.0", "#{pane_id}");
});
afterAll(() => { spawnSync(tmuxBin, ["-L", socket, "kill-server"], { stdio: "ignore" }); });
const paneEnv = (home: string): NodeJS.ProcessEnv => ({
  ...process.env, TAP_TMUX_SOCKET: socket, TMUX: undefined, TMUX_PANE: undefined, TAP_HOME: home, TAP_LOCK_DIR: join(home, "locks"),
});
const style = (opt: string): string => {
  const r = spawnSync(tmuxBin, ["-L", socket, "show-options", "-p", "-v", "-t", paneId, opt], { encoding: "utf8" });
  return r.stdout.replace(/\n$/, "");
};

function seedEntry(home: string, id: string, target = "peer", extraMeta: Record<string, unknown> = {}): void {
  mkdirSync(join(home, "spool"), { recursive: true });
  mkdirSync(join(home, "payloads"), { recursive: true });
  mkdirSync(join(home, "receipts"), { recursive: true });
  writeFileSync(join(home, "spool", `${id}.md`), `---\nid: ${id}\nfrom: alice\nto: ${target}\nkind: discuss\nreply: expected\n---\nbody\n`);
  writeFileSync(join(home, "spool", `${id}.meta.json`), JSON.stringify({ id, target, policy: "standard", first_spooled_epoch: 100, pane: "sess:0.0", pane_id: "%401", ...extraMeta }) + "\n");
}

function parkInput(home: string, over: Partial<ParkReportInput> = {}): ParkReportInput {
  const canonical = join(home, "payloads", "x.md");
  mkdirSync(join(home, "payloads"), { recursive: true });
  mkdirSync(join(home, "receipts"), { recursive: true });
  if (!existsSync(canonical)) writeFileSync(canonical, "---\nid: x\nfrom: alice\nto: peer\nkind: discuss\nreply: expected\n---\nbody\n");
  return {
    spoolDir: join(home, "spool"), home, id: "x", canonical, target: "peer", acting: "t", reason: "busy",
    timeoutSeconds: "", pane: "sess:0.0", paneId: "%401", toTeam: "", targetRegistry: "", policy: "standard",
    graceSeconds: "", cueStyle: "", cueRedAt: "", from: "alice", kind: "discuss", replyExpect: "expected", scriptsDir: join(home, "scripts"),
    env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, "cfg"), TAP_SPOOL_DISABLE_DELIVERER: "1" }, now: NOW, lockTimeoutMs: 1000, ...over,
  };
}

function captureStderr(run: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  let out = "";
  (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown): boolean => { out += String(chunk); return true; };
  try { run(); } finally { (process.stderr as unknown as { write: typeof original }).write = original; }
  return out;
}

// --- parkAndReport --------------------------------------------------------------------

test("parkAndReport parks, cues only on green/red with the pane's own facts, spawns the waiter, and reports no backlog on a lone entry", () => {
  const home = scratch();
  const flashes: FlashInput[] = [];
  const spawns: SpawnDelivererInput[] = [];
  const hooks = { flash: (i: FlashInput) => { flashes.push(i); }, spawn: (i: SpawnDelivererInput) => { spawns.push(i); return true; } };
  const report = parkAndReport(parkInput(home, { cueStyle: "green" }), hooks);
  expect(report.verdict).toBe("ok");
  expect(existsSync(join(home, "spool", "x.md"))).toBe(true);
  expect(existsSync(join(home, "spool", "x.meta.json"))).toBe(true);
  expect(existsSync(join(home, "payloads", "x.md"))).toBe(false);
  expect(flashes).toEqual([{ home, pane: "sess:0.0", paneId: "%401", ownerId: "x", style: "bg=green", count: 1, env: expect.anything() }]);
  expect(spawns).toEqual([{ scriptsDir: join(home, "scripts"), home, spoolDir: join(home, "spool"), id: "x", env: expect.anything() }]);
  expect(report.backlog).toEqual({ count: "1", condition: false, line: expect.stringContaining("1 payload to peer spooled"), remedy: expect.stringContaining("tap show <id>") });
  expect(report.injected).toBeNull();
  expect(report.injectedPhase).toBeNull();
  // No cue style: no flash at all. `bg=` prefixes are the cue's, never the caller's.
  const home2 = scratch();
  flashes.length = 0;
  parkAndReport(parkInput(home2), hooks);
  expect(flashes).toEqual([]);
  const home3 = scratch();
  parkAndReport(parkInput(home3, { cueStyle: "blue" }), hooks);
  expect(flashes).toEqual([]);
});

test("parkAndReport warns on stderr exactly when the backlog CONDITION holds, and reads the injection facts", () => {
  const home = scratch();
  // A second entry to the same target, already probed busy three times: with this
  // park the count reaches 2 and the witness's probes reach the default 3 → condition.
  seedEntry(home, "older", "peer", { busy_pending_probes: 3, last_busy_probe_at: 150 });
  const hooks = { flash: () => {}, spawn: () => true };
  let report: ParkReport | undefined;
  const err = captureStderr(() => { report = parkAndReport(parkInput(home), hooks); });
  expect(report!.backlog).toMatchObject({ count: "2", condition: true });
  expect(err).toBe(`tap: WARNING — ${report!.backlog!.line}; next: ${report!.backlog!.remedy}\n`);
  // Below the threshold: no warning byte.
  const home2 = scratch();
  seedEntry(home2, "older", "peer", { busy_pending_probes: 2 });
  const quiet = captureStderr(() => { report = parkAndReport(parkInput(home2), hooks); });
  expect(report!.backlog).toMatchObject({ count: "2", condition: false });
  expect(quiet).toBe("");
  // A harness-queued receipt from an earlier attempt: the park reports it as injected.
  const home3 = scratch();
  parkInput(home3);
  recordHarnessQueued(home3, "x");
  report = parkAndReport(parkInput(home3), hooks);
  expect(report.injected).toBe("queued in harness; recipient processing unconfirmed");
  expect(report.injectedPhase).toBe("harness-queued");
});

test("parkAndReport treats the cue as cosmetic: a flash that throws (an unresponsive tmux) never stops the waiter spawn", () => {
  const home = scratch();
  let spawned = false;
  const report = parkAndReport(parkInput(home, { cueStyle: "red" }), {
    flash: () => { throw new Error("tmux server unresponsive"); },
    spawn: () => { spawned = true; return true; },
  });
  expect(spawned).toBe(true);
  expect(report.spawned).toBe(true);
  expect(existsSync(join(home, "spool", "x.md"))).toBe(true);
});

test("flashPane waits for the pane lock only as long as TAP_PANE_SUBMIT_LOCK_TIMEOUT says", () => {
  const home = scratch();
  const env = paneEnv(home);
  const held = acquirePaneLock(paneId, 1000, env);
  expect(held).not.toBeNull();
  try {
    const started = Date.now();
    flashPane({ home, pane: "flash:0.0", paneId, ownerId: "x", style: "bg=red", count: 1, env: { ...env, TAP_PANE_SUBMIT_LOCK_TIMEOUT: ".2" } });
    const waited = Date.now() - started;
    expect(waited).toBeLessThan(2000);
    // No lock, no flash: no token was minted while another owner held the pane.
    expect(existsSync(join(home, "pane-effects", `${paneId}.json`))).toBe(false);
  } finally { held!.release(); }
});

test("parkAndReport reports a failed waiter spawn as its own outcome: pair retained, the warning on stderr, the late-failure receipt", () => {
  const home = scratch();
  let report: ParkReport | undefined;
  const err = captureStderr(() => { report = parkAndReport(parkInput(home), { flash: () => {}, spawn: () => false }); });
  expect(report!.spawned).toBe(false);
  expect(existsSync(join(home, "spool", "x.md"))).toBe(true);
  expect(existsSync(join(home, "payloads", "x.md"))).toBe(false);
  expect(err).toBe("tap send: warning: parking 'x' did not complete; inspect with tap show x; automatic redelivery is not confirmed\n");
  expect(renderParkReceipt(report!, opts(home))).toBe("tap send: queued x\n");
  expect(renderParkReceipt(report!, opts(home, { verbose: true }))).toBe("tap send: accepted, queued x for peer; reply expected. Delivery not confirmed. Inspect with tap show x.\n");
  expect(JSON.parse(renderParkReceipt(report!, opts(home, { json: true })))).toEqual({
    status: "queued", delivery: "spool", id: "x", from: "alice", to: "peer", pane: "sess:0.0", kind: "discuss", turn: "unconfirmed",
    path: join(home, "spool", "x.md"), meta: join(home, "spool", "x.meta.json"), reason: "spool_park_failed", action: "tap show x",
  });
  // A real spawn that cannot start: the log path is a directory.
  const home2 = scratch();
  mkdirSync(join(home2, "tap-deliver.log"), { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home2, XDG_CONFIG_HOME: join(home2, "cfg") };
  let r2: ParkReport | undefined;
  captureStderr(() => { r2 = parkAndReport(parkInput(home2, { env }), { flash: () => {} }); });
  expect(r2!.spawned).toBe(false);
});

test("parkAndReport throws the transaction's decided refusal with the claim released and the canonical retained", () => {
  const home = scratch();
  const input = parkInput(home);
  mkdirSync(join(home, "spool"), { recursive: true });
  writeFileSync(join(home, "spool", "x.claim"), '{"v": 1, "id": "x", "owner_pid": 1, "claimed_at_epoch": 0}\n');
  let spawned = false;
  expect(() => parkAndReport(input, { flash: () => {}, spawn: () => { spawned = true; return true; } })).toThrow("spool entry is claimed; canonical payload retained");
  expect(existsSync(input.canonical)).toBe(true);
  expect(existsSync(join(home, "spool", "x.md"))).toBe(false);
  expect(spawned).toBe(false);
});

// --- renderParkReceipt ----------------------------------------------------------------

const baseReport = (over: Partial<ParkReport> = {}): ParkReport => ({
  verdict: "ok", parked: { payload: "/bus/spool/x.md", meta: "/bus/spool/x.meta.json", deadlineEpoch: "1800" } as ParkReport["parked"], spawned: true,
  backlog: { count: "2", condition: true, line: "L", remedy: "R" }, injected: null, injectedPhase: null, ...over,
});
const opts = (home: string, over: Record<string, unknown> = {}) => ({
  home, id: "x", from: "alice", to: "peer", pane: "sess:0.0", kind: "discuss", replyExpect: "expected", reason: "busy", policy: "standard",
  json: false, verbose: false, verb: "send" as const, ...over,
});

test("renderParkReceipt: the queued shapes, byte for byte, with the queue explanation the bus renders", () => {
  const home = scratch();
  // The explanation line is queue-explanation.ts's (read from the entry's sidecar; the
  // unavailable wording here, since this scratch bus has none) — the receipt carries it verbatim.
  const explanation = queueExplanation(home, "x");
  expect(explanation).toBe("Queue schedule unavailable: metadata missing or unreadable.");
  expect(renderParkReceipt(baseReport(), opts(home))).toBe(`tap send: queued x\n${explanation}\n`);
  expect(renderParkReceipt(baseReport(), opts(home, { verb: "assign" }))).toBe(`tap assign: queued x\n${explanation}\n`);
  expect(renderParkReceipt(baseReport(), opts(home, { verbose: true, displayState: "hold" }))).toBe(
    `tap send: accepted, queued x for peer; reply expected. Delivery not confirmed. Inspect with tap show x; if it is still unread, tap resend x rings it again under the same id. [hold]\n${explanation}\n`);
  expect(renderParkReceipt(baseReport(), opts(home, { verbose: true }))).toContain("same id. []\n");
  expect(JSON.parse(renderParkReceipt(baseReport(), opts(home, { json: true })))).toEqual({
    status: "queued", delivery: "spool", action: "deliver_when_clear_or_deadline", id: "x", from: "alice", to: "peer", pane: "sess:0.0",
    kind: "discuss", turn: "unconfirmed", path: "/bus/spool/x.md", meta: "/bus/spool/x.meta.json", reason: "busy", policy: "standard",
    deadline_epoch: "1800", spool_backlog: "2", spool_backlog_condition: "true", queue_explanation: explanation,
  });
  expect(JSON.parse(renderParkReceipt(baseReport({ backlog: null }), opts(home, { json: true })))).toMatchObject({ spool_backlog: "0", spool_backlog_condition: "false" });
});

test("renderParkReceipt: the injected shapes and the harness-queued message", () => {
  const home = scratch();
  const injected = baseReport({ injected: "an earlier attempt reached the pane", injectedPhase: "injected-enter-unconfirmed" });
  expect(renderParkReceipt(injected, opts(home))).toBe("tap send: injected-enter-unconfirmed x\nan earlier attempt reached the pane\n");
  expect(renderParkReceipt(injected, opts(home, { verbose: true }))).toBe("tap send: accepted x for peer; an earlier attempt reached the pane\nan earlier attempt reached the pane\n");
  expect(JSON.parse(renderParkReceipt(injected, opts(home, { json: true })))).toEqual({
    status: "queued", phase: "injected-enter-unconfirmed", delivery: "spool", id: "x", from: "alice", to: "peer", pane: "sess:0.0",
    kind: "discuss", turn: "unconfirmed", path: "/bus/spool/x.md", queue_explanation: "an earlier attempt reached the pane",
  });
  const queued = baseReport({ injected: "queued in harness; recipient processing unconfirmed", injectedPhase: "harness-queued" });
  expect(renderParkReceipt(queued, opts(home))).toBe("tap send: queued in harness x; recipient processing unconfirmed\n");
  expect(JSON.parse(renderParkReceipt(queued, opts(home, { json: true })))).toEqual({
    id: "x", status: "queued", delivery: "harness-queue", turn: "unconfirmed", path: join(home, "payloads", "x.md"),
  });
});

// --- spawnDeliverer -------------------------------------------------------------------

test("spawnDeliverer launches the waiter detached with the drain marker scrubbed and the lease token carried; disabled, it releases the lease instead", async () => {
  const home = scratch();
  const scripts = join(home, "skills/tap/scripts");
  const entry = join(home, "runtime/bun/src/spool-waiter.ts");
  mkdirSync(join(home, "runtime/bun/src"), { recursive: true });
  mkdirSync(scripts, { recursive: true });
  const out = join(home, "waiter-saw");
  writeFileSync(entry, `import {writeFileSync,renameSync} from "node:fs";
const out = ${JSON.stringify(out)};
writeFileSync(out + ".tmp", [process.argv[2], process.env.TAP_SPOOL_DRAIN_ACTIVE ?? "unset", process.env.TAP_SPOOL_REOWN_TOKEN ?? "unset"].join("\\n") + "\\n");
renameSync(out + ".tmp", out);
`);
  seedEntry(home, "x");
  const env = { ...process.env, TAP_SPOOL_DRAIN_ACTIVE: "1", TAP_SPOOL_DISABLE_DELIVERER: undefined };
  expect(spawnDeliverer({ scriptsDir: scripts, home, spoolDir: join(home, "spool"), id: "x", reownToken: "tok-1", env })).toBe(true);
  for (let i = 0; i < 200 && !existsSync(out); i++) await Bun.sleep(25);
  expect(readFileSync(out, "utf8")).toBe("x\nunset\ntok-1\n");
  expect(existsSync(join(home, "tap-deliver.log"))).toBe(true);
  // Disabled: nothing spawned; a carried lease is released here, the only place that knows.
  const home2 = scratch();
  seedEntry(home2, "y");
  const token = reownClaim(join(home2, "spool"), "y", "60", 1000, env);
  expect(token).toBeTruthy();
  expect(existsSync(reownPath(join(home2, "spool"), "y"))).toBe(true);
  const disabled = { ...env, TAP_SPOOL_DISABLE_DELIVERER: "1" };
  expect(spawnDeliverer({ scriptsDir: scripts, home: home2, spoolDir: join(home2, "spool"), id: "y", reownToken: token!, env: disabled })).toBe(true);
  expect(existsSync(reownPath(join(home2, "spool"), "y"))).toBe(false);
  expect(existsSync(join(home2, "waiter-saw"))).toBe(false);
  // A script that cannot be launched: false, lease released.
  const home3 = scratch();
  seedEntry(home3, "z");
  const token3 = reownClaim(join(home3, "spool"), "z", "60", 1000, env);
  const noHome = join(home3, "not-creatable");
  writeFileSync(noHome, "file, not a directory");
  expect(spawnDeliverer({ scriptsDir: scripts, home: noHome, spoolDir: join(home3, "spool"), id: "z", reownToken: token3!, env })).toBe(false);
  expect(existsSync(reownPath(join(home3, "spool"), "z"))).toBe(false);
});

// Ported from the retired smoke/spool-reown-drains.test.sh arm (3): a re-owned
// entry must actually get a deliverer — a REAL detached process anchored to
// THIS id, alive while the entry is resident.
test("reown composition starts a real detached deliverer anchored to THIS id, carrying the lease it minted", async () => {
  const home = scratch();
  const scripts = join(home, "skills/tap/scripts");
  const entry = join(home, "runtime/bun/src/spool-waiter.ts");
  mkdirSync(join(home, "runtime/bun/src"), { recursive: true });
  mkdirSync(scripts, { recursive: true });
  const seen = join(home, "deliverer-saw");
  // The stub records pid + id (the "for this id" claim, proven by the process's
  // own argv rather than a pgrep pattern), then exits once its entry file is
  // gone. That exit is fixture cleanup, not a production claim: the production
  // waiter's no-entry exit is pinned in spool-waiter.test.ts ("scope refusal
  // and missing payload release inherited lease").
  writeFileSync(entry, `import { writeFileSync, renameSync, existsSync } from "node:fs";
const out = ${JSON.stringify(seen)};
const entryPath = ${JSON.stringify(join(home, "spool", "rw1.md"))};
writeFileSync(out + ".tmp", [process.pid, process.argv[2], process.env.TAP_SPOOL_REOWN_TOKEN ?? ""].join("\\n") + "\\n");
renameSync(out + ".tmp", out);
const deadline = Date.now() + 15000;
while (Date.now() < deadline) {
  if (!existsSync(entryPath)) process.exit(0);
  await Bun.sleep(20);
}
`);
  seedEntry(home, "rw1");
  // The production composition: after-repark mints the lease and hands its
  // token to the spawn; the stub proves the handoff by recording the env.
  const spawnOnce = (): string | null => {
    const minted = reownAfterRepark(join(home, "spool"), "rw1", "60", 1000, process.env);
    if (minted === null) return null;
    expect(spawnDeliverer({ scriptsDir: scripts, home, spoolDir: join(home, "spool"), id: "rw1", reownToken: minted, env: process.env })).toBe(true);
    return minted;
  };
  const token = spawnOnce();
  if (token === null) throw new Error("re-owning a parked entry minted no lease");
  for (let i = 0; i < 200 && !existsSync(seen); i++) await Bun.sleep(25);
  expect(existsSync(seen), "re-owning a parked entry started NO deliverer").toBe(true);
  const [pidText, seenId, seenToken] = readFileSync(seen, "utf8").trim().split("\n");
  const pid = Number(pidText);
  expect(seenId, "the deliverer was not anchored to this entry's id").toBe("rw1");
  expect(seenToken, "the deliverer did not inherit the minted lease token").toBe(token);
  expect(readFileSync(reownPath(join(home, "spool"), "rw1"), "utf8")).toBe(token);
  // The lease survives a successful spawn: every later after-repark must see
  // the fresh lease and refuse, so the entry accumulates exactly one owner.
  for (let i = 0; i < 5; i++) expect(spawnOnce(), "a re-park minted a second owner over a fresh lease").toBeNull();
  process.kill(pid, 0);
  rmSync(join(home, "spool", "rw1.md"));
  let alive = true;
  for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
    try { process.kill(pid, 0); } catch { alive = false; break; }
    await Bun.sleep(25);
  }
  // Cleanup guard: the stub must not leak a live process past the test.
  expect(alive).toBe(false);
}, 20_000);

// --- the pane effect, on a real server -------------------------------------------------

test("serverEpochNow honors the env pin and otherwise reads the server's pid:start_time", () => {
  const home = scratch();
  expect(serverEpochNow({ ...paneEnv(home), TAP_SERVER_EPOCH: "1:2" })).toBe("1:2");
  expect(serverEpochNow(paneEnv(home))).toMatch(/^srv:\d+:\d+$/);
});

test("paneEffectClearVerified clears and verifies only for the pane's own server generation", () => {
  const home = scratch();
  const env = paneEnv(home);
  const epoch = serverEpochNow(env);
  tmux("set-option", "-p", "-t", paneId, "window-style", "bg=blue");
  expect(style("window-style")).toBe("bg=blue");
  // The wrong generation: nothing is touched.
  expect(paneEffectClearVerified(paneId, `${epoch}x`, env)).toBe(false);
  expect(style("window-style")).toBe("bg=blue");
  expect(paneEffectClearVerified("", epoch, env)).toBe(false);
  // The right one: both styles unset, verified empty.
  expect(paneEffectClearVerified(paneId, epoch, env)).toBe(true);
  expect(style("window-style")).toBe("");
  expect(paneEffectClearVerified("%9999", epoch, env)).toBe(false);
});

test("flashPaneLocked mints the effect token exclusively, tints, clears verified and drops the token; an existing token means do nothing", () => {
  const home = scratch();
  const env = paneEnv(home);
  const token = join(home, "pane-effects", `${paneId}.json`);
  flashPaneLocked({ home, pane: "flash:0.0", paneId, ownerId: "x", style: "bg=red", count: 2, env });
  // Verified clear: the token is gone and the pane carries no style.
  expect(existsSync(join(home, "pane-effects"))).toBe(true);
  expect(existsSync(token)).toBe(false);
  expect(style("window-style")).toBe("");
  // Another effect in flight (its token exists): no tint, no clear — the style set here survives.
  tmux("set-option", "-p", "-t", paneId, "window-style", "bg=blue");
  writeFileSync(token, `{"applied_style": "bg=red", "owner_id": "other", "pane": "flash:0.0", "pane_id": "${paneId}", "server_epoch": "0:0", "v": 2}\n`);
  flashPaneLocked({ home, pane: "flash:0.0", paneId, ownerId: "x", style: "bg=red", count: 1, env });
  expect(style("window-style")).toBe("bg=blue");
  expect(readFileSync(token, "utf8")).toContain('"owner_id": "other"');
  tmux("set-option", "-p", "-u", "-t", paneId, "window-style");
  rmSync(token);
  // A pane that is not the one asked for: nothing minted.
  flashPaneLocked({ home, pane: "flash:0.0", paneId: "%9999", ownerId: "x", env });
  expect(existsSync(join(home, "pane-effects", "%9999.json"))).toBe(false);
  flashPaneLocked({ home, pane: "flash:0.0", paneId: "", ownerId: "x", env });
});

// tap-ipex2: the in-process port tinted and cleared within milliseconds, so no cue was
// ever seen. These pin a visible dwell and the token rules that keep it single-owner.
test("the clobber blink holds red long enough to see before returning", async () => {
  const home = scratch(), env = paneEnv(home);
  const started = Date.now();
  // The blink is synchronous, so it runs in a child while this process samples the pane.
  const child = Bun.spawn(["bun", "-e", `require(${JSON.stringify(join(import.meta.dir, "../src/spool-park-report"))}).flashPaneLocked(
    { home: ${JSON.stringify(home)}, pane: "flash:0.0", paneId: ${JSON.stringify(paneId)}, ownerId: "clobber", style: "bg=red", count: ${CLOBBER_BLINK.count} },
    ${JSON.stringify(CLOBBER_BLINK)})`], { env, stdout: "ignore", stderr: "ignore" });
  let red = 0, firstRed = -1, lastRed = -1;
  while (child.exitCode === null && Date.now() - started < 5000) {
    const now = style("window-style");
    if (now === "bg=red") { red++; lastRed = Date.now() - started; if (firstRed < 0) firstRed = lastRed; }
    await Bun.sleep(5);
  }
  await child.exited;
  expect(red).toBeGreaterThan(5);
  expect(lastRed - firstRed).toBeGreaterThanOrEqual(CLOBBER_BLINK.onMs);
  expect(style("window-style")).toBe("");
  expect(existsSync(join(home, "pane-effects", `${paneId}.json`))).toBe(false);
});

test("a park spawns its deliverer before the cue's dwell (liveness before cosmetics)", () => {
  const home = scratch();
  let tintedAtSpawn = "", spawnedAt = 0;
  const base = parkInput(home);
  parkAndReport(parkInput(home, { cueStyle: "green", paneId, pane: "flash:0.0", env: { ...base.env, ...paneEnv(home), TAP_SPOOL_DISABLE_DELIVERER: "1" } }), {
    spawn: () => { tintedAtSpawn = style("window-style"); spawnedAt = performance.now(); return true; },
  });
  const afterSpawnMs = performance.now() - spawnedAt;
  expect(tintedAtSpawn).toBe("bg=green");
  // The property is an ordering, so measure it from the spawn forward: the dwell
  // runs after the spawn, which makes the remainder at least the dwell. Load only
  // lengthens it. A spawn after the dwell would leave just the cue's clear.
  // (The slack covers timer granularity; a fixture-start clock would fold setup
  // time into the bound and fail under load with no ordering change.)
  expect(afterSpawnMs).toBeGreaterThanOrEqual(CUE_DWELL_MS - 25);
  expect(style("window-style")).toBe("");
});

test("a cue scheduled off the lock still clears when its process exits before the timer", async () => {
  const home = scratch(), env = paneEnv(home);
  const mod = JSON.stringify(join(import.meta.dir, "../src/spool-park-report"));
  const child = Bun.spawn(["bun", "-e", `const m = require(${mod});
    const cue = m.beginPaneCue({ home: ${JSON.stringify(home)}, pane: "flash:0.0", paneId: ${JSON.stringify(paneId)}, ownerId: "exit", style: "bg=blue" });
    process.stdout.write(cue ? "up" : "none");
    m.endPaneCueAfter(cue);
    process.exit(0);`], { env, stdout: "pipe", stderr: "ignore" });
  const said = await new Response(child.stdout).text();
  await child.exited;
  expect(said).toBe("up");
  expect(child.exitCode).toBe(0);
  expect(style("window-style")).toBe("");
  expect(existsSync(join(home, "pane-effects", `${paneId}.json`))).toBe(false);
});

test("a cue's end clears only its own mint; a fresh token blocks a cue, a stale one is taken over", () => {
  const home = scratch(), env = paneEnv(home);
  const token = join(home, "pane-effects", `${paneId}.json`);
  const input = { home, pane: "flash:0.0", paneId, ownerId: "cue", style: "bg=green", env };
  const first = beginPaneCue(input);
  expect(first).not.toBeNull();
  expect(style("window-style")).toBe("bg=green");
  // A second cue while the first is up: refused, nothing repainted.
  expect(beginPaneCue({ ...input, style: "bg=blue" })).toBeNull();
  expect(style("window-style")).toBe("bg=green");
  // The clobber takes over: its own mint, and the first cue's end is now a no-op.
  const clobber = beginPaneCue({ ...input, ownerId: "clobber", style: "bg=red" }, true);
  expect(clobber).not.toBeNull();
  endPaneCue(first!);
  expect(style("window-style")).toBe("bg=red");
  expect(readFileSync(token, "utf8")).toContain('"owner_id": "clobber"');
  endPaneCue(clobber!);
  expect(style("window-style")).toBe("");
  expect(existsSync(token)).toBe(false);
  // An end that never ran must not silence later cues forever.
  writeFileSync(token, `{"applied_style": "bg=red", "owner_id": "lost", "pane": "flash:0.0", "pane_id": "${paneId}", "server_epoch": "0:0", "v": 2}\n`);
  expect(beginPaneCue(input)).toBeNull();
  const old = (Date.now() - STALE_CUE_TOKEN_MS - 1000) / 1000;
  utimesSync(token, old, old);
  const late = beginPaneCue(input);
  expect(late).not.toBeNull();
  endPaneCue(late!);
  expect(existsSync(token)).toBe(false);
  expect(style("window-style")).toBe("");
});

// tap-12ys6 review: pane-effects/ is a reset checkpoint component. A cue running outside
// reset custody writes its token only under custody, so it serializes with the fence a
// reset writes under the same lock: a held reset lock or a live fence means no token and
// no tint, and the flash does not wait past the shortest custody bound.
test("flashPaneLocked writes its token only under reset custody: held or fenced, the checkpoint component is untouched", () => {
  const home = scratch();
  const env = paneEnv(home);
  const effects = join(home, "pane-effects");
  const held = acquirePathLock(join(home, "reset.fence.json.lock"), 1000, env)!;
  const started = Date.now();
  try { flashPaneLocked({ home, pane: "flash:0.0", paneId, ownerId: "x", style: "bg=red", count: 1, env }); }
  finally { held.release(); }
  expect({ component: existsSync(effects), style: style("window-style") }).toEqual({ component: false, style: "" });
  expect(Date.now() - started).toBeLessThan(5000);
  writeFileSync(join(home, "reset.fence.json"), "{}\n");
  flashPaneLocked({ home, pane: "flash:0.0", paneId, ownerId: "x", style: "bg=red", count: 1, env });
  expect({ component: existsSync(effects), style: style("window-style") }).toEqual({ component: false, style: "" });
  // The control: unfenced, the same call writes (and then drops) its token.
  rmSync(join(home, "reset.fence.json"));
  flashPaneLocked({ home, pane: "flash:0.0", paneId, ownerId: "x", style: "bg=red", count: 1, env });
  expect({ component: existsSync(effects), token: existsSync(join(effects, `${paneId}.json`)), style: style("window-style") })
    .toEqual({ component: true, token: false, style: "" });
});

// --- the CLI door ---------------------------------------------------------------------

function cli(args: string[], env: NodeJS.ProcessEnv): { code: number; out: string } {
  const original = process.stdout.write.bind(process.stdout);
  let out = "";
  (process.stdout as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown): boolean => { out += String(chunk); return true; };
  let code: number;
  try { code = main(args, env); } finally { (process.stdout as unknown as { write: typeof original }).write = original; }
  return { code, out };
}

test("CLI: park-report answers ok with the report or the refusal class with its detail, both at exit 0; park-receipt renders; shapes are refused at exit 2", () => {
  const home = scratch();
  const input = parkInput(home);
  const env = { ...input.env, TAP_SPOOL_DISABLE_DELIVERER: "1" } as NodeJS.ProcessEnv;
  const facts = [input.spoolDir, home, "x", input.canonical, "alice", "peer", "discuss", "expected", "t", "busy", "", "sess:0.0", "%401", "", "", "standard", "", "", "", input.scriptsDir];
  const r = cli(["park-report", ...facts], env);
  expect(r.code).toBe(0);
  const [verdict, json = ""] = r.out.split("\n");
  expect(verdict).toBe("ok");
  const report = JSON.parse(json) as ParkReport;
  expect(report.spawned).toBe(true);
  expect(report.parked.payload).toBe(join(home, "spool", "x.md"));
  const receipt = cli(["park-receipt", home, json, "x", "alice", "peer", "sess:0.0", "discuss", "expected", "busy", "standard", "0", "0", "send", ""], env);
  // The parked entry's own schedule line, from its sidecar.
  expect(receipt.code).toBe(0);
  expect(receipt.out).toBe(`tap send: queued x\n${queueExplanation(home, "x")}\n`);
  expect(receipt.out).toContain("Queue: busy/busy");
  // The same entry again: the pair is published, the canonical is gone → spool_publish_failed at exit 0.
  const again = cli(["park-report", ...facts], env);
  expect(again.code).toBe(0);
  expect(again.out.split("\n")[0]).toBe("spool_publish_failed");
  expect(cli(["park-report", "short"], env).code).toBe(2);
  expect(cli(["park-receipt", home, "not json", "x", "alice", "peer", "sess:0.0", "discuss", "expected", "busy", "standard", "0", "0", "send", ""], env).code).toBe(2);
  expect(cli(["park-receipt", home, json, "x", "alice", "peer", "sess:0.0", "discuss", "expected", "busy", "standard", "0", "0", "other", ""], env).code).toBe(2);
  expect(cli(["nonsense"], env).code).toBe(2);
});

test("CLI: clear-verified and spawn-deliverer answer verdict words; flash accepts count 0 and still clears", () => {
  const home = scratch();
  const env = paneEnv(home);
  // count "0" (the Bash loop ran zero tints): accepted, the token minted and the verified clear drops it —
  // the pre-set style is gone either way, so this pins acceptance, not the tint count.
  tmux("set-option", "-p", "-t", paneId, "window-style", "bg=blue");
  expect(cli(["flash", home, "flash:0.0", paneId, "x", "bg=red", "0", "locked"], env).code).toBe(0);
  expect(style("window-style")).toBe("");
  expect(existsSync(join(home, "pane-effects", `${paneId}.json`))).toBe(false);
  expect(cli(["clear-verified", paneId, serverEpochNow(env)], env)).toEqual({ code: 0, out: "yes\n" });
  expect(cli(["clear-verified", paneId, "0:0"], env)).toEqual({ code: 0, out: "no\n" });
  seedEntry(home, "x");
  expect(cli(["spawn-deliverer", join(home, "scripts"), home, join(home, "spool"), "x"], { ...env, TAP_SPOOL_DISABLE_DELIVERER: "1" })).toEqual({ code: 0, out: "ok\n" });
  expect(cli(["spawn-deliverer", "x"], env).code).toBe(2);
});

function cosmeticContext(home: string): DrainContext {
  return { home, spoolDir: join(home, "spool"), payloadsDir: join(home, "payloads"), receiptsDir: join(home, "receipts"),
    eventLog: join(home, "events"), actingRegistry: join(home, "registry.json"), scriptsDir: "/no-shell-owner",
    team: "fixture", verbLabel: "tap", courierIdentity: "courier", alert: { mode: "none" }, now: 100,
    unroutedGrace: 1800, env: { ...paneEnv(home), TAP_SERVER_EPOCH: undefined } };
}

test("native drain cosmetics reuse the pane owner without a shell callback", async () => {
  const home = scratch(), ctx = cosmeticContext(home);
  const effects = realDrainEffects(ctx);
  const binding: SpoolBinding = { target: "peer", pane: "flash:0.0", paneId, targetRegistry: "", toTeam: "" };
  await effects.flash(binding, "cue");
  const dir = join(home, "pane-effects"), token = join(dir, `${paneId}.json`);
  expect(existsSync(dir)).toBe(true);
  // The cue stays up for its dwell, with the pane lock already released (tap-ipex2).
  expect(style("window-style")).toBe("bg=red");
  expect(existsSync(token)).toBe(true);
  const free = acquirePaneLock(paneId, 0, ctx.env);
  expect(free).not.toBeNull();
  free!.release();
  await Bun.sleep(CUE_DWELL_MS + 150);
  expect(style("window-style")).toBe("");
  expect(existsSync(token)).toBe(false);
  tmux("select-pane", "-t", paneId, "-P", "bg=red");
  writeFileSync(token, JSON.stringify({ pane_id: paneId, server_epoch: serverEpochNow(ctx.env) }));
  await effects.repairOrphans();
  expect(existsSync(token)).toBe(false);
  expect(style("window-style")).toBe("");
  // A failed observation is not proof of a new generation.
  const unknown = join(dir, "unknown.json");
  writeFileSync(unknown, JSON.stringify({ pane_id: "%99999", server_epoch: "old" }));
  ctx.env!.TAP_SERVER_EPOCH = "";
  await effects.repairOrphans();
  expect(existsSync(unknown)).toBe(true);
  ctx.env!.TAP_SERVER_EPOCH = "new";
  await effects.repairOrphans();
  expect(existsSync(unknown)).toBe(false);
});

test("watch spool clears a recorded tint and does not paint a parked row", async () => {
  const home = scratch(), ctx = cosmeticContext(home);
  seedEntry(home, "tint", "peer", { pane: "flash:0.0", pane_id: paneId, hold_until_epoch: ctx.now });
  mkdirSync(join(home, "watch"));
  const arm = join(home, "watch/arm.json");
  tintPane("flash:0.0", "bg=colour22", paneEnv(home));
  writeFileSync(arm, JSON.stringify({ armed_at: 123, tinted_panes: ["flash:0.0", "%99999"] }));
  ctx.active = true; // Isolate post-drain reconciliation; this pass owns no deliveries.
  const effects = realDrainEffects(ctx);
  effects.readiness = async () => "ready";
  expect(style("window-style")).toBe("bg=colour22");
  expect(await processWatchSpool(ctx, effects, "123")).toBe(0);
  // Untint UNSETS the pane options (inherit again) instead of writing bg=default over them.
  // A missing recorded pane does not keep the live pane painted.
  expect(style("window-style")).toBe("");
  expect(style("window-active-style")).toBe("");
  expect(JSON.parse(readFileSync(arm, "utf8")).tinted_panes).toEqual([]);
});

test("watch spool does not paint a ready row at any hold", async () => {
  const home = scratch(), ctx = cosmeticContext(home);
  seedEntry(home, "held", "peer", { pane: "flash:0.0", pane_id: paneId, hold_until_epoch: ctx.now + 300 });
  mkdirSync(join(home, "watch"));
  const arm = join(home, "watch/arm.json");
  writeFileSync(arm, JSON.stringify({ armed_at: 123, tinted_panes: [] }));
  ctx.active = true;
  const effects = realDrainEffects(ctx);
  effects.readiness = async () => "ready";
  for (const hold of [ctx.now + 300, ctx.now + 10, ctx.now - 5]) {
    const meta = JSON.parse(readFileSync(join(home, "spool", "held.meta.json"), "utf8"));
    meta.hold_until_epoch = hold;
    writeFileSync(join(home, "spool", "held.meta.json"), JSON.stringify(meta) + "\n");
    expect(await processWatchSpool(ctx, effects, "123")).toBe(0);
    expect(style("window-style")).toBe("");
    expect(style("window-active-style")).toBe("");
    expect(JSON.parse(readFileSync(arm, "utf8")).tinted_panes).toEqual([]);
  }
});

test("watch tint stays off for a busy row whose hold has already passed", async () => {
  const home = scratch(), ctx = cosmeticContext(home);
  seedEntry(home, "busy", "peer", { pane: "flash:0.0", pane_id: paneId, hold_until_epoch: ctx.now - 5 });
  mkdirSync(join(home, "watch"));
  const arm = join(home, "watch/arm.json");
  writeFileSync(arm, JSON.stringify({ armed_at: 123, tinted_panes: [] }));
  ctx.active = true;
  const effects = realDrainEffects(ctx);
  for (const ready of ["busy:pending", "busy:operator-wait", "busy:queued"]) {
    effects.readiness = async () => ready;
    expect(await processWatchSpool(ctx, effects, "123")).toBe(0);
    expect(style("window-style")).toBe("");
    expect(style("window-active-style")).toBe("");
    expect(JSON.parse(readFileSync(arm, "utf8")).tinted_panes).toEqual([]);
  }
});

test("watch spool does not paint a grace-window row at either deadline", async () => {
  const home = scratch(), ctx = cosmeticContext(home);
  seedEntry(home, "grace", "peer", {
    pane: "flash:0.0", pane_id: paneId, hold_until_epoch: ctx.now - 1,
    deadline_epoch: ctx.now + 30, waiter_lifetime: "grace-window",
  });
  mkdirSync(join(home, "watch"));
  const arm = join(home, "watch/arm.json");
  writeFileSync(arm, JSON.stringify({ armed_at: 123, tinted_panes: [] }));
  ctx.active = true;
  const effects = realDrainEffects(ctx);
  effects.readiness = async () => "busy:pending";
  for (const deadline of [ctx.now + 30, ctx.now + 10]) {
    const meta = JSON.parse(readFileSync(join(home, "spool", "grace.meta.json"), "utf8"));
    meta.deadline_epoch = deadline;
    writeFileSync(join(home, "spool", "grace.meta.json"), JSON.stringify(meta) + "\n");
    expect(await processWatchSpool(ctx, effects, "123")).toBe(0);
    expect(style("window-style")).toBe("");
    expect(style("window-active-style")).toBe("");
    expect(JSON.parse(readFileSync(arm, "utf8")).tinted_panes).toEqual([]);
  }
});

test("watch tint and untint never move pane_active, and clearTints unsets too", async () => {
  // Two panes with the SPLIT as the active one: a `select-pane -t -P` tint would
  // move pane_active to the tinted pane (the tmux 3.7c focus steal); a pane-scoped
  // `set-option -p` must not. Observed on the runner's real tmux server.
  tmux("new-session", "-d", "-s", "focus", "-x", "80", "-y", "24", "sleep 300");
  const target = tmux("display-message", "-p", "-t", "focus:0.0", "#{pane_id}");
  const other = tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", "focus:0.0", "sleep 300");
  tmux("select-pane", "-t", other); // test setup: the split pane owns focus
  const activeOf = (pane: string): string =>
    tmux("display-message", "-p", "-t", pane, "#{pane_active}");
  const styleOf = (pane: string, opt: string): string => {
    const r = spawnSync(tmuxBin, ["-L", socket, "show-options", "-p", "-v", "-t", pane, opt], { encoding: "utf8" });
    return r.stdout.replace(/\n$/, "");
  };
  expect(activeOf(target)).toBe("0"); // setup: the other pane owns focus
  expect(activeOf(other)).toBe("1");
  const home = scratch(), ctx = cosmeticContext(home);
  seedEntry(home, "tint", "peer", { pane: `focus:0.0`, pane_id: target });
  mkdirSync(join(home, "watch"));
  tintPane(target, "bg=colour22", paneEnv(home));
  writeFileSync(join(home, "watch/arm.json"), JSON.stringify({ armed_at: 5, tinted_panes: [target] }));
  ctx.active = true;
  const effects = realDrainEffects(ctx);
  effects.readiness = async () => "ready";
  expect(styleOf(target, "window-style")).toBe("bg=colour22");
  expect(await processWatchSpool(ctx, effects, "5")).toBe(0);
  expect(styleOf(target, "window-style")).toBe("");
  expect(styleOf(target, "window-active-style")).toBe("");
  expect(activeOf(target)).toBe("0");
  expect(activeOf(other)).toBe("1");
  // …and through the disarm's clearTints.
  writeFileSync(join(home, "watch/arm.json"), JSON.stringify({ armed_at: 5, tinted_panes: [target] }));
  tintPane(target, "bg=colour22", paneEnv(home));
  clearTints(home, paneEnv(home));
  expect(styleOf(target, "window-style")).toBe("");
  expect(styleOf(target, "window-active-style")).toBe("");
  expect(activeOf(target)).toBe("0");
  expect(activeOf(other)).toBe("1");
});

// Ported from the retired smoke/spool-waiter-lock-fd.test.sh: a detached
// deliverer must not extend a spawning parent's lock lifetime. A flock the
// parent holds on an inherited descriptor (fd 8, the retired Bash obligation
// lock's slot) has to die with the parent, not survive inside the waiter.
test("a live detached deliverer cannot retain its spawning parent's flock", async () => {
  const home = scratch();
  const scripts = join(home, "skills/tap/scripts");
  mkdirSync(join(home, "runtime/bun/src"), { recursive: true });
  mkdirSync(scripts, { recursive: true });
  const probe = join(home, "probe");
  mkdirSync(probe);
  const lockPath = join(home, "detached-lock-probe.lock");
  writeFileSync(join(home, "runtime/bun/src/spool-waiter.ts"), `import { existsSync, writeFileSync, renameSync } from "node:fs";
const p = ${JSON.stringify(probe)};
writeFileSync(p + "/child.tmp", String(process.pid));
renameSync(p + "/child.tmp", p + "/child.json");
const deadline = Date.now() + 15000;
while (!existsSync(p + "/child-release")) {
  if (Date.now() > deadline) throw new Error("waiter barrier timed out");
  await Bun.sleep(20);
}
writeFileSync(p + "/child-exited", "");
`);
  // The spawning parent holds an exclusive flock on fd 8 across the production
  // spawnDeliverer call, so the descriptor flows parent -> spawner -> detached
  // waiter exactly as it does in service. The env clears an inherited
  // TAP_SPOOL_DISABLE_DELIVERER so the row always exercises a real spawn.
  const rowEnv: NodeJS.ProcessEnv = { ...process.env, TAP_SPOOL_DISABLE_DELIVERER: undefined };
  const caller = join(home, "caller.ts");
  writeFileSync(caller, `import { spawnDeliverer } from ${JSON.stringify(join(import.meta.dir, "../src/spool-park-report.ts"))};
import { existsSync, writeFileSync } from "node:fs";
const ok = spawnDeliverer({ scriptsDir: ${JSON.stringify(scripts)}, home: ${JSON.stringify(home)}, spoolDir: ${JSON.stringify(join(home, "spool"))}, id: "detached-lock-probe", env: process.env });
writeFileSync(${JSON.stringify(join(probe, "spawn.json"))}, String(ok));
writeFileSync(${JSON.stringify(join(probe, "parent-ready"))}, "");
const deadline = Date.now() + 15000;
while (!existsSync(${JSON.stringify(join(probe, "parent-release"))})) {
  if (Date.now() > deadline) process.exit(77);
  await Bun.sleep(20);
}
`);
  const holder = Bun.spawn(["/bin/bash", "-c", `exec 8>'${lockPath}'
python3 -B -c 'import fcntl; fcntl.flock(8, fcntl.LOCK_EX | fcntl.LOCK_NB)'
exec '${process.execPath}' '${caller}'
`], { env: rowEnv, stdout: "pipe", stderr: "pipe" });
  const tryLock = (): boolean => spawnSync("python3", ["-B", "-c",
    'import fcntl,sys\nf=open(sys.argv[1],"a")\ntry: fcntl.flock(f, fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept OSError: sys.exit(1)', lockPath],
    { encoding: "utf8" }).status === 0;
  const until = async (path: string, ms = 10_000): Promise<void> => {
    for (const deadline = Date.now() + ms; !existsSync(path);) {
      if (Date.now() > deadline) throw new Error(`barrier timed out: ${path}`);
      await Bun.sleep(20);
    }
  };
  let childPid: number | undefined;
  try {
    await until(join(probe, "parent-ready"));
    await until(join(probe, "child.json"));
    expect(readFileSync(join(probe, "spawn.json"), "utf8")).toBe("true");
    // Positive control: the spawning parent owns the same lock the probe takes.
    expect(tryLock(), "fixture never held its lock").toBe(false);
    writeFileSync(join(probe, "parent-release"), "");
    expect(await Promise.race([holder.exited, Bun.sleep(8000).then(() => "hung")])).toBe(0);
    // Readiness is not liveness: check the exact child's pid while its release
    // barrier is still closed, before observing the lock's availability.
    childPid = Number(readFileSync(join(probe, "child.json"), "utf8"));
    process.kill(childPid, 0);
    expect(tryLock(), "live detached waiter retained the exited parent lock").toBe(true);
    process.kill(childPid, 0);
  } finally {
    if (existsSync(join(probe, "child.json")) && !existsSync(join(probe, "child-release"))) {
      writeFileSync(join(probe, "child-release"), "");
      for (const deadline = Date.now() + 5000; !existsSync(join(probe, "child-exited")) && Date.now() < deadline;) await Bun.sleep(20);
    }
    if (childPid !== undefined) { try { process.kill(childPid, "SIGKILL"); } catch { /* already exited */ } }
    if (holder.exitCode === null) { holder.kill("SIGKILL"); await holder.exited; }
  }
}, 25_000);
