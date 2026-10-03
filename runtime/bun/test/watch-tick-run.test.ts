// The watch tick's body replays the frozen capture of the incumbent
// (fixtures/watch-tick-oracle.json, captured from tap-watch.sh at the pinned base by
// the since-retired capture harness, in BOTH calling shapes -- the `tick` verb under
// `set -e` and the sidecar loop's `tap_watch_tick || true`): every case's scripted
// WORLD is offered to `runTick` through a fixture-backed TickSeams, and the status,
// stdout, stderr, the ordered effects (every door called, with its arguments; every
// lease write with its generation guards) and the arm record left behind must equal
// what the Bash function did. The lease is the real module over a real record, as it
// was in the capture.
//
// The port has ONE semantics; where the two shapes disagreed, or where bash printed a
// diagnostic, the row is ruled (leader ruling) and
// enumerated below:
//   D.   a maintenance door's nonzero status ended the verb mid-pass; the port goes on
//        and returns 0 -- the LOOP's bytes, effects and status (12 rows);
//   R1.  `[: x: integer expected` -- one `tap watch:` line, bash's decision kept (4 rows);
//   R2.  `TAP_WATCH_NOW` not an integer -- the floor program refused it and bash's
//        arithmetic died in both shapes (and would have taken the sidecar with it): the
//        port ends the tick with status 1 and one line (1 row);
//   R2b. `current_rung` a name bash evaluated as 0 AFTER sending the probe: refused at
//        the snapshot read, status 1, one line, no probe (1 row).

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claimAcquire, claimRelease } from "../src/spool-sidecar";
import { nextUnprobed, probedAppend } from "../src/watch-evaluate";
import { clearPause, fieldValue, readLoose, set as leaseSet, snapshotLines } from "../src/watch-lease";
import { activeSeatRows } from "../src/watch-tick";
import { probeBody, realTickSeams, registryRowsInOrder, runTick, type RosterRow, type TickSeams } from "../src/watch-tick-run";
import { repoRoot as registryRepoRoot } from "../src/watch-registry";
import { removeScratchTree } from "./support/scratch";

interface World {
  armed: boolean;
  arm: Record<string, unknown>;
  fence: boolean;
  reminders: { fire_rc: number; finish_rc: number } | null;
  registry: { seats?: Record<string, Record<string, unknown>> } | null;
  seats: Record<string, [string, string, string, string]>;
  blocked: { touched: string; rc: number; set: Record<string, string> };
  detectors: Record<string, number>;
  spool_pass: number;
  claim: "acquired" | "held" | "fail";
  files: string[];
  notice_rc: number;
  notify_rc: number;
  evaluate_rc: number;
  lease_current: boolean[];
  repo: { head_ct: string; porcelain: string };
  bus_activity: string;
  chain: string[];
  classify: Record<string, string>;
  send: Record<string, { rc: number; stdout: string; stderr: string }>;
}

interface Shape { rc: number; stdout: string; stderr: string; effects: string[][]; arm_after: Record<string, unknown> | null }
interface Case { case: string; env: Record<string, string>; world: World; verb: Shape; loop: Shape }

const oracle = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/watch-tick-oracle.json"), "utf8")) as {
  captured_from: { head: string; probe_template: string; shapes: string[]; now: string }; cases: Case[];
};
const NOW = oracle.captured_from.now;
const BUS = "<WORK>/bus";
const SCRIPTS = "<BASE>/skills/tap/scripts";

/** The scripted world as seams; effects recorded exactly as the capture's shims recorded them. */
function seamsOf(c: Case, arm: string, effects: string[][], stderr: string[]): TickSeams {
  const w = c.world;
  const env = { ...c.env };
  let lcCalls = 0;
  const rec = (...fields: string[]): void => { effects.push(fields); };
  const bun = (...fields: string[]): void => rec("bun", ...fields);
  const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
  const rearm = (key: string, field: string, value: string): void => {
    if (env[key] === "1") leaseSet(arm, [field, value]);
  };
  return {
    now: () => env.TAP_WATCH_NOW ?? NOW,
    fencePresent: () => w.fence,
    armed: () => w.armed,
    snapshot: () => { try { return snapshotLines(readLoose(arm)); } catch { return []; } },
    field: (k) => { try { return fieldValue(readLoose(arm), k).replace(/\n+$/, ""); } catch { return ""; } },
    set: (pairs, expect) => {
      const e = expect ?? {};
      rec("set", e.TAP_WATCH_EXPECT_ARMED_AT ?? "", e.TAP_WATCH_EXPECT_QUEUED_PROBE_ID ?? "", e.TAP_WATCH_EXPECT_CARRIED_PROBE_SEAT ?? "", e.TAP_WATCH_EXPECT_CARRIED_PROBE_AT ?? "", ...pairs);
      try { return leaseSet(arm, pairs, { ...e }) === 0; } catch { return false; }
    },
    clearPause: (n, at, pa, pu) => { rec("clear-pause", n, at, pa, pu, ""); try { return clearPause(arm, n, at, pa, pu, {}) === 0; } catch { return false; } },
    leaseCurrent: () => { rec("lease-current"); const seq = w.lease_current; return seq[Math.min(lcCalls++, seq.length - 1)]!; },
    remindersPresent: () => w.reminders !== null,
    remindFire: (at) => { bun("remind", at, "remind.ts", `${BUS}/watch/reminders.json`, "fire", SCRIPTS, at); return w.reminders?.fire_rc ?? 0; },
    remindFinish: (at) => { bun("remind", at, "remind.ts", `${BUS}/watch/reminders.json`, "finish", at); return w.reminders?.finish_rc ?? 0; },
    roster: () => {
      if (w.registry === null) return null;
      // the registry's active rows (the same program), then the classifier's answer per pane
      const out: RosterRow[] = [];
      for (const row of activeSeatRows(JSON.stringify(w.registry)).rows) {
        const [handle = "", , , pane = "", , , , , , harness = ""] = row;
        const seat = Object.values(w.seats).find((_, i) => Object.keys(w.seats)[i] === handle) ?? null;
        const byPane = seat !== null && (w.registry?.seats?.[handle]?.pane ?? handle) === pane ? seat : null;
        if (byPane === null || byPane[0] !== "active") continue;
        out.push({ handle, pane: byPane[1], paneId: byPane[2], harness: byPane[3] || harness });
      }
      return out;
    },
    processBlocked: (armedAt, n, armedBy, map, exempt) => {
      bun("watch-blocked.ts", "process-blocked", armedAt, n, armedBy, map, exempt);
      for (const [k, v] of Object.entries(w.blocked.set)) leaseSet(arm, [k, v]);
      return { touched: w.blocked.touched, rc: w.blocked.rc };
    },
    detector: (name, args) => { bun("watch-detectors.ts", name, ...args); return w.detectors[name] ?? 0; },
    processSpool: (armedAt, n, snap) => { rec("spool-pass", armedAt, n, "1", snap.queuedProbeId); return w.spool_pass; },
    claimAcquire: (id) => {
      rec("claim", id);
      rearm("TAP_WATCH_CAPTURE_REARM_BEFORE_QUEUED", "armed_at", "1001");
      if (w.claim === "fail") stderr.push(`tap: slice_failed id=${id} slice=spool-sidecar: invalid claim verdict\n`);
      return w.claim === "acquired" ? "test-token" : null;
    },
    claimRelease: (id, token) => { rec("release", id); expect(token).toBe("test-token"); },
    busFile: (rel) => w.files.includes(rel),
    noticeOrNotify: (to, reason, evidence) => { bun("watch-notice.ts", "notice-or-notify", BUS, SCRIPTS, to, reason, evidence); return w.notice_rc; },
    notifyHuman: (reason) => { bun("watch-notice.ts", "notify-human", BUS, SCRIPTS, reason, "episode"); return w.notify_rc; },
    evaluate: () => { bun("watch-evaluator.ts", "evaluate"); return w.evaluate_rc; },
    headCommitTime: () => w.repo.head_ct,
    porcelainHash: () => sha(w.repo.head_ct === "" ? "" : w.repo.porcelain),
    busActivity: (n) => { rec("bus-activity", n); rearm("TAP_WATCH_CAPTURE_REARM_BEFORE_CARRIED", "carried_probe_at", "1701"); return w.bus_activity; },
    buildChain: (overrides, terminal) => { bun("watch-evaluator.ts", "build-chain", overrides, terminal); return w.chain.map((x) => `${x}\n`).join(""); },
    nextUnprobed: (chain, skip) => { bun("watch-evaluator.ts", "next-unprobed", skip); return nextUnprobed(skip, chain); },
    probedAppend: (json, seat) => { bun("watch-evaluator.ts", "probed-append", json, seat); return probedAppend(json, seat); },
    classify: (rung) => { bun("watch-blocked.ts", "classify", rung); return w.classify[rung] ?? ""; },
    sendProbe: (rung, body, timeout) => {
      rec("send", rung, body, "watcher", timeout, "--from watcher --kind probe --fyi --json");
      const s = w.send[rung];
      if (s === undefined) return { rc: 1, stdout: "", err: "tap send: unscripted recipient" };
      return { rc: s.rc, stdout: s.stdout, err: s.stderr.split("\n")[0] ?? "" };
    },
    probeTemplate: () => oracle.captured_from.probe_template,
    stderr: (line) => { stderr.push(`${line}\n`); },
  };
}

async function run(c: Case): Promise<Shape> {
  const scratch = mkdtempSync(join(tmpdir(), "watch-tick-run."));
  try {
    const arm = join(scratch, "bus", "watch", "arm.json");
    mkdirSync(join(scratch, "bus", "watch"), { recursive: true });
    if (c.world.armed) writeFileSync(arm, `${JSON.stringify(c.world.arm)}\n`);
    const effects: string[][] = [];
    const stderr: string[] = [];
    const rc = await runTick(seamsOf(c, arm, effects, stderr), {});
    let after: Record<string, unknown> | null = null;
    try { after = JSON.parse(readFileSync(arm, "utf8")) as Record<string, unknown>; } catch { after = null; }
    return { rc, stdout: "", stderr: stderr.join(""), effects, arm_after: after };
  } finally {
    removeScratchTree(scratch);
  }
}

/** The classifier ran per seat in the incumbent; the port observes the roster once. Those rows are the world, not a decision. */
const decisions = (effects: string[][]): string[][] => effects.filter((e) => e[0] !== "seat-record");

interface Ruled { cls: "D" | "R1" | "R2" | "R2b"; rc?: number; stderr?: string | RegExp; effects?: string[][]; arm?: "verb" | "loop" | "initial" }

const D = (): Ruled => ({ cls: "D", rc: 0 });
const R: Record<string, Ruled> = {
  "reminders-only-mode-finish-fails": D(),
  "blocked-pass-status-1": D(),
  "blocked-pass-status-1-with-touched": D(),
  "detector-pressure-fails": D(),
  "detector-livelock-fails": D(),
  "detector-freeze-fails": D(),
  "detector-wedge-fails": D(),
  "spool-pass-fails": D(),
  "spool-pass-rc2": D(),
  "paused-expired-notice-fails": D(),
  "silence-first-probe-unsafe-notify-fails": D(),
  "exhausted-notify-fails": D(),
  // R1: `[: soon: integer expected` -> one line, the same decision (false)
  "arm-threshold-not-integer": { cls: "R1", stderr: /^tap watch: threshold_seconds is not an integer: "soon"\ntap watch: probe send to 'a' failed/ },
  "arm-probe-timeout-not-integer": { cls: "R1", stderr: "tap watch: probe_timeout_seconds is not an integer: \"x\"\n" },
  "arm-episode-not-integer": { cls: "R1", stderr: /^tap watch: episode_started_at is not an integer: "x"\ntap watch: probe send to 'a' failed/ },
  "arm-carried-at-not-integer": { cls: "R1", stderr: "tap watch: carried_probe_at is not an integer: \"x\"\n" },
  // R2: the clock -- refused before any door (the incumbent called the maintenance doors and died at the arithmetic;
  // through the production seams each of those doors would report its own refusal first, so the ruling's ONE line
  // needs the check first: status 1, one line, no side effect at all)
  "now-not-integer": { cls: "R2", rc: 1, stderr: "tap watch: now must be an integer: \"abc\"\n", effects: [], arm: "initial" },
  // R2b: refused at the snapshot read: no roster, no pass, no probe, the record untouched
  "arm-current-rung-not-integer": { cls: "R2b", rc: 1, stderr: "tap watch: current_rung is not an integer: \"x\"\n", effects: [], arm: "initial" },
};

const seen: string[] = [];

describe(`the tick replays the incumbent at ${oracle.captured_from.head.slice(0, 9)} in both calling shapes`, () => {
  test("the capture holds both shapes", () => {
    expect(oracle.captured_from.shapes).toEqual(["verb", "loop"]);
    expect(oracle.cases.length).toBe(97);
  });
  for (const c of oracle.cases) {
    test(c.case, async () => {
      const got = await run(c);
      const ruled = R[c.case];
      const same = (a: Shape, b: Shape): boolean => a.rc === b.rc && a.stdout === b.stdout && a.stderr === b.stderr && JSON.stringify(a.effects) === JSON.stringify(b.effects) && JSON.stringify(a.arm_after) === JSON.stringify(b.arm_after);
      if (ruled === undefined) {
        expect(same(c.verb, c.loop), "an unruled row is identical in both shapes").toBe(true);
        expect(c.loop.stderr, "an unruled row carries no shell diagnostic").not.toMatch(/Traceback|unbound variable|syntax error|integer expected/);
        expect(got.rc, "exit status").toBe(c.loop.rc);
        expect(got.stdout, "stdout").toBe(c.loop.stdout);
        expect(got.stderr, "stderr").toBe(c.loop.stderr);
        expect(got.effects, "effects, in order").toEqual(decisions(c.loop.effects));
        expect(got.arm_after, "the arm record afterwards").toEqual(c.loop.arm_after);
        return;
      }
      seen.push(c.case);
      if (ruled.cls === "D") {
        expect(c.verb.rc, "the verb died at the door").not.toBe(0);
        expect(c.loop.rc, "the loop went on").toBe(0);
        expect(c.verb.effects.length, "the verb ran no further").toBeLessThanOrEqual(c.loop.effects.length);
      }
      if (ruled.cls === "R1") expect(c.loop.stderr, "the incumbent's diagnostic is on record").toMatch(/\[: .*: integer expected/);
      if (ruled.cls === "R2") { expect(c.verb.rc).toBe(1); expect(c.loop.rc).toBe(1); expect(c.loop.stderr).toMatch(/unbound variable/); }
      if (ruled.cls === "R2b") { expect(c.loop.rc).toBe(0); expect(c.loop.effects.some((e) => e[0] === "send"), "the incumbent sent the probe").toBe(true); }
      const want = ruled.cls === "D" ? c.loop : c.loop; // both keep the loop's bytes unless the row says otherwise
      expect(got.rc, "exit status").toBe(ruled.rc ?? want.rc);
      expect(got.stdout, "stdout").toBe(want.stdout);
      if (ruled.stderr === undefined) expect(got.stderr, "stderr").toBe(want.stderr);
      else if (typeof ruled.stderr === "string") expect(got.stderr, "stderr").toBe(ruled.stderr);
      else expect(got.stderr, "stderr").toMatch(ruled.stderr);
      expect(got.effects, "effects, in order").toEqual(ruled.effects ?? decisions(want.effects));
      const armWant = ruled.arm === "initial" ? c.world.arm : ruled.arm === "verb" ? c.verb.arm_after : want.arm_after;
      expect(got.arm_after, "the arm record afterwards").toEqual(armWant);
    });
  }
  test("the ruled rows are exactly the enumerated ones", () => {
    expect(seen.sort()).toEqual(Object.keys(R).sort());
  });
});

describe("the probe body", () => {
  test("renders the armer, then the nudge line or nothing, and ends with one newline", () => {
    expect(probeBody("hi {{ARMER}}\n{{NUDGE}}\n", "lead", "")).toBe("hi lead\n\n");
    expect(probeBody("hi {{ARMER}}\n{{NUDGE}}\n", "lead", "tests are red")).toBe("hi lead\n> Carrying forward: tests are red\n");
    expect(probeBody("{{ARMER}} {{ARMER}}", "a&b", "")).toBe("a&b a&b\n");
    expect(probeBody("x {{NUDGE}} {{NUDGE}}", "", "n")).toBe("x > Carrying forward: n > Carrying forward: n\n");
  });
});

describe("the production seams", () => {
  test("the native spool pass receives tick facts as argv and strips ambient authority from descendants", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "watch-tick-spool."));
    try {
      const scripts = join(scratch, "skills/tap/scripts"), src = join(scratch, "runtime/bun/src");
      mkdirSync(scripts, { recursive: true }); mkdirSync(src, { recursive: true });
      const record = join(scratch, "record");
      writeFileSync(join(src, "spool-engine.ts"), `import {appendFileSync} from "node:fs";
const [, op, armed, now, queued, timeout] = process.argv.slice(2);
if(op!=="watch") process.exit(99);
appendFileSync(process.env.RECORD!, "pass:"+[armed,now,process.env.TAP_SPOOL_HUMAN_ALERT??"unset",queued,timeout].join("|")+"\\n");
const child=Bun.spawn([process.execPath,"-e",'require("node:fs").appendFileSync(process.env.RECORD,"waiter:"+["TAP_SPOOL_HUMAN_ALERT","TAP_WATCH_TICK_ACTIVE","TAP_WATCH_TICK_QUEUED_PROBE_ID","TAP_WATCH_TICK_PROBE_TIMEOUT"].map(k=>process.env[k]??"unset").join("|")+"\\\\n")'],{env:process.env});
await child.exited;process.exit(7);`);
      const env = { ...process.env, RECORD: record, TAP_SPOOL_HUMAN_ALERT: "ambient", TAP_WATCH_TICK_QUEUED_PROBE_ID: "ambient", TAP_WATCH_TICK_ACTIVE: "ambient" };
      const s = realTickSeams({ bus: join(scratch, "bus"), scripts, registry: join(scratch, "no-registry.json"), env });
      expect(await s.processSpool("1000", "2000", { queuedProbeId: "q-1", probeTimeout: "300" })).toBe(7);
      expect(readFileSync(record, "utf8")).toBe("pass:1000|2000|unset|q-1|300\nwaiter:unset|unset|unset|unset\n");
    } finally { removeScratchTree(scratch); }
  });
  test("the spool child runs the REAL pass: the native spool-engine watch pass over a bootstrapped bus reconcile the record's tinted_panes and return 0", async () => {
    // The stand-ins above prove the load order and the scoping; this proves the child body
    // runs the real spool-engine.ts watch pass (the shell entrance supervision-lib.sh
    // was retired in B2). The drain refuses a bus that was never bootstrapped (tap-ncd4), so the
    // fixture stamps its bus through the test-only `tap_ensure_dirs`.
    const scratch = mkdtempSync(join(tmpdir(), "watch-tick-real-spool."));
    try {
      const scripts = join(import.meta.dir, "..", "..", "..", "skills", "tap", "scripts");
      const bus = join(scratch, "repo", ".tap", "bus");
      mkdirSync(join(bus, "watch"), { recursive: true });
      writeFileSync(join(bus, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "t" }, seats: {} }));
      const boot = spawnSync("bash", ["-c", '. "$1/smoke/runtime-helpers.sh" >/dev/null; tap_ensure_dirs', "_", scripts], { env: { ...process.env, TAP_HOME: bus }, encoding: "utf8" });
      expect(boot.status).toBe(0);
      writeFileSync(join(bus, "watch", "arm.json"), JSON.stringify({ mode: "supervision", armed_by: "lead", armed_at: 1000, tick_interval_seconds: 60 }) + "\n");
      const s = realTickSeams({ bus, scripts, registry: join(scratch, "no-registry.json"), env: { ...process.env, TAP_HOME: bus } });
      const rc = await s.processSpool("1000", "2000", { queuedProbeId: "", probeTimeout: "300" });
      expect(rc).toBe(0);
      expect(JSON.parse(readFileSync(join(bus, "watch", "arm.json"), "utf8")).tinted_panes).toEqual([]);
    } finally {
      removeScratchTree(scratch);
    }
  });
  test("the probe courier: a draft that cannot be written is a failed send with the reason, never a throw; a writable bus sends the draft under TAP_SELF and the grace and removes it", () => {
    const scratch = mkdtempSync(join(tmpdir(), "watch-tick-send."));
    try {
      const scripts = join(scratch, "scripts");
      mkdirSync(join(scripts, "watch-templates"), { recursive: true });
      writeFileSync(join(scripts, "watch-templates", "probe.md"), "probe for {{ARMER}}\n{{NUDGE}}\n");
      const record = join(scratch, "record");
      writeFileSync(join(scripts, "courier"), "#!/bin/bash\nprintf '%s\\n' \"$1\" \"${TAP_SELF-unset}\" \"${TAP_SEND_GRACE_SECONDS-unset}\" \"${@:3}\" > \"$RECORD\"\ncat \"$2\" >> \"$RECORD\"\nprintf '%s' '{\"status\":\"injected\",\"id\":\"w-20260916T000000Z-0123456789ab\",\"path\":\"p\",\"delivery\":\"pane\"}'\nexit 0\n");
      const args = (bus: string) => ({ bus, scripts, registry: join(scratch, "no-registry.json"), env: { ...process.env, RECORD: record, TAP_WATCH_IDENTITY: "watcher", TAP_COURIER_SCRIPT: join(scripts, "courier") } });
      // 1. `watch` is a regular file
      const busA = join(scratch, "a"); mkdirSync(busA); writeFileSync(join(busA, "watch"), "not a directory");
      const a = realTickSeams(args(busA)).sendProbe("h", "body\n", "300");
      expect(a.rc).toBe(1);
      expect(a.err).toMatch(/ENOTDIR|EEXIST|not a directory|file exists/i);
      // 2. `watch` is a directory the process may not write
      const busB = join(scratch, "b"); mkdirSync(join(busB, "watch"), { recursive: true }); chmodSync(join(busB, "watch"), 0o500);
      let b: { rc: number; stdout: string; err: string };
      try { b = realTickSeams(args(busB)).sendProbe("h", "body\n", "300"); } finally { chmodSync(join(busB, "watch"), 0o700); }
      if (process.getuid?.() !== 0) { expect(b.rc).toBe(1); expect(b.err).toMatch(/EACCES|permission denied/i); }
      expect(readdirSync(join(busB, "watch"))).toEqual([]);
      // 3. a writable bus: the courier is handed the rung, the identity, the grace, the flags and the body; the draft is gone afterwards
      const busC = join(scratch, "c"); mkdirSync(busC);
      const c = realTickSeams(args(busC)).sendProbe("h", probeBody("probe for {{ARMER}}\n{{NUDGE}}\n", "lead", "tests are red"), "300");
      expect(c.rc).toBe(0);
      expect(c.stdout).toContain("\"status\":\"injected\"");
      expect(readFileSync(record, "utf8")).toBe("h\nwatcher\n300\n--from\nwatcher\n--kind\nprobe\n--fyi\n--json\nprobe for lead\n> Carrying forward: tests are red\n");
      expect(readdirSync(join(busC, "watch"))).toEqual([]);
      expect(existsSync(join(busC, "watch"))).toBe(true);
    } finally {
      removeScratchTree(scratch);
    }
  });
});

// The two races the watch-probe-courier regress arc staged with a Bash DEBUG trap on the
// tick's own commands (the tick is native since W2c-2), staged here at the seams the
// commands became -- against the REAL spool claim and the REAL lease.
describe("the queued probe's observation window", () => {
  const QID = "opus-5-20260916T000000Z-0123456789ab";
  function world(scratch: string, competitor: (phase: "observe" | "write") => void): { seams: TickSeams; arm: string; bus: string; effects: string[][] } {
    const bus = join(scratch, "bus");
    const spool = join(bus, "spool");
    const arm = join(bus, "watch", "arm.json");
    mkdirSync(join(bus, "watch"), { recursive: true }); mkdirSync(spool); mkdirSync(join(bus, "payloads")); mkdirSync(join(bus, "receipts"));
    writeFileSync(arm, `${JSON.stringify({ armed_at: "1000", armed_by: "lead", threshold_seconds: 1500, probe_timeout_seconds: 1500, queued_probe_id: QID, queued_probe_seat: "helper", episode_started_at: 1500, current_rung: 1, probed_seats: ["helper"], last_probe_at: 0, last_porcelain_hash: "x", last_porcelain_change_at: 1000 })}\n`);
    writeFileSync(join(spool, `${QID}.md`), "---\nkind: probe\n---\nbody\n");
    writeFileSync(join(spool, `${QID}.meta.json`), "{}\n");
    const effects: string[][] = [];
    const rec = (...f: string[]): void => { effects.push(f); };
    const seams: TickSeams = {
      now: () => "2001", fencePresent: () => false, armed: () => existsSync(arm),
      snapshot: () => snapshotLines(readLoose(arm)), field: (k) => fieldValue(readLoose(arm), k).replace(/\n+$/, ""),
      set: (pairs, expect) => { rec("set", ...pairs); competitor("write"); return leaseSet(arm, pairs, { ...(expect ?? {}) }) === 0; },
      clearPause: () => true, leaseCurrent: () => true, remindersPresent: () => false, remindFire: () => 0, remindFinish: () => 0,
      roster: () => [], processBlocked: () => ({ touched: "", rc: 0 }), detector: () => 0, processSpool: () => 0,
      // the real claim: `spool-sidecar.ts`, a noclobber create under `spool/<id>.claim`
      claimAcquire: (id) => { const v = claimAcquire(spool, id, false, {}); rec("claim", id, v.status); return v.status === "acquired" ? v.token : null; },
      claimRelease: (id, token) => { claimRelease(spool, id, token); rec("release", id); },
      busFile: (rel) => { rec("observe", rel); competitor("observe"); return existsSync(join(bus, rel)); },
      noticeOrNotify: () => 0, notifyHuman: () => 0, evaluate: () => 0, headCommitTime: () => "1000", porcelainHash: () => "x",
      busActivity: () => "", buildChain: () => "helper\n__human__\n", nextUnprobed: (chain, skip) => nextUnprobed(skip, chain), probedAppend,
      classify: () => "", sendProbe: () => ({ rc: 1, stdout: "", err: "unexpected" }), probeTemplate: () => "", stderr: () => {},
    };
    return { seams, arm, bus, effects };
  }
  test("an interrupted spool wait cannot reach the queued-probe claim or later tick effects", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "watch-tick-stop."));
    try {
      const w = world(scratch, () => {}), controller = new AbortController();
      let prefix: string[][] = [];
      w.seams.processSpool = async () => { prefix = [...w.effects]; controller.abort(); return 0; };
      await expect(runTick(w.seams, {}, controller.signal)).rejects.toThrow("watch invocation stopped");
      expect(w.effects).toEqual(prefix);
    } finally { removeScratchTree(scratch); }
  });
  test("the observer claim fences the claim/canonical rollback race", async () => {
    // after the watcher's claim, a drain tries to claim + move canonical; after the
    // canonical observation, its failed submit would roll the payload back before the
    // state write -- under the fence the drain's claim is refused and nothing moves
    const scratch = mkdtempSync(join(tmpdir(), "watch-tick-race."));
    try {
      let marker = "";
      let once = false;
      const w = world(scratch, (phase) => {
        const claim = join(w.bus, "spool", `${QID}.claim`);
        if (phase === "observe" && !once) {
          once = true;
          try { closeSync(openSync(claim, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL)); marker = "claimed"; renameSync(join(w.bus, "spool", `${QID}.md`), join(w.bus, "payloads", `${QID}.md`)); }
          catch { marker = "blocked"; }
        }
        if (phase === "write" && marker === "claimed") { renameSync(join(w.bus, "payloads", `${QID}.md`), join(w.bus, "spool", `${QID}.md`)); rmSync(claim, { force: true }); marker = "rolled-back"; }
      });
      expect(await runTick(w.seams, {})).toBe(0);
      expect(marker, "the competing drain was locked out by the observer's claim").toBe("blocked");
      expect(existsSync(join(w.bus, "spool", `${QID}.md`))).toBe(true);
      const after = JSON.parse(readFileSync(w.arm, "utf8")) as Record<string, unknown>;
      expect(after.queued_probe_id).toBe(QID);
      expect(after.last_probe_at).toBe(0);
      expect(existsSync(join(w.bus, "spool", `${QID}.claim`)), "the observer released its claim").toBe(false);
      expect(w.effects.filter((e) => e[0] !== "set").map((e) => e.slice(0, 2).join(" "))).toEqual([`claim ${QID}`, `observe payloads/${QID}.md`, `observe receipts/${QID}.done`, `observe spool/${QID}.md`, `release ${QID}`]);
    } finally {
      removeScratchTree(scratch);
    }
  });
  test("a same-second re-arm between the canonical observation and the guarded write is refused by the queued-id guard", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "watch-tick-rearm."));
    try {
      let rearmed = false;
      const w = world(scratch, (phase) => {
        if (phase === "write" && !rearmed) {
          rearmed = true;
          // `tap watch on --rearm` in the SAME second: a fresh record with the same armed_at and no queued probe
          writeFileSync(w.arm, `${JSON.stringify({ armed_at: "1000", armed_by: "lead", threshold_seconds: 10, probe_timeout_seconds: 100, episode_started_at: 0, current_rung: 0, probed_seats: [], last_probe_at: 0, carried_probe_at: 0 })}\n`);
        }
      });
      // the probe became canonical before this tick
      renameSync(join(w.bus, "spool", `${QID}.md`), join(w.bus, "payloads", `${QID}.md`));
      expect(await runTick(w.seams, {})).toBe(0);
      const after = JSON.parse(readFileSync(w.arm, "utf8")) as Record<string, unknown>;
      expect(after.armed_at).toBe("1000");
      expect(after.queued_probe_id ?? "").toBe("");
      expect(after.carried_probe_seat ?? "").toBe("");
      expect(after.carried_probe_at).toBe(0);
      expect(after.last_probe_at).toBe(0);
      expect(after.episode_started_at).toBe(0);
      expect(w.effects.some((e) => e[0] === "set" && e.includes("carried_probe_seat")), "the stale transition was attempted and refused").toBe(true);
      expect(existsSync(join(w.bus, "spool", `${QID}.claim`))).toBe(false);
    } finally {
      removeScratchTree(scratch);
    }
  });
});

describe("a harness-queued probe", () => {
  // The Hermes recipient accepts the probe into its harness queue: the payload is canonical,
  // so the rung advances and probe_timeout starts; the turn stays unconfirmed (no spool id).
  async function tick(stdout: string, extra: Record<string, unknown> = {}): Promise<{ after: Record<string, unknown>; sends: number; stderr: string[] }> {
    const scratch = mkdtempSync(join(tmpdir(), "watch-tick-hq."));
    try {
      const arm = join(scratch, "watch", "arm.json");
      mkdirSync(join(scratch, "watch"), { recursive: true });
      writeFileSync(arm, `${JSON.stringify({ armed_at: "1000", armed_by: "lead", threshold_seconds: 100, probe_timeout_seconds: 300, episode_started_at: 1500, current_rung: 0, probed_seats: [], last_probe_at: 0, last_porcelain_hash: "x", last_porcelain_change_at: 1000, ...extra })}\n`);
      let sends = 0;
      const stderr: string[] = [];
      const seams: TickSeams = {
        now: () => "2001", fencePresent: () => false, armed: () => existsSync(arm),
        snapshot: () => snapshotLines(readLoose(arm)), field: (k) => fieldValue(readLoose(arm), k).replace(/\n+$/, ""),
        set: (pairs, expect) => leaseSet(arm, pairs, { ...(expect ?? {}) }) === 0,
        clearPause: () => true, leaseCurrent: () => true, remindersPresent: () => false, remindFire: () => 0, remindFinish: () => 0,
        roster: () => [], processBlocked: () => ({ touched: "", rc: 0 }), detector: () => 0, processSpool: () => 0,
        claimAcquire: () => "test-token", claimRelease: () => {}, busFile: () => false,
        noticeOrNotify: () => 0, notifyHuman: () => 0, evaluate: () => 0, headCommitTime: () => "1000", porcelainHash: () => "x",
        busActivity: () => "", buildChain: () => "goalie\n__human__\n", nextUnprobed: (chain, skip) => nextUnprobed(skip, chain), probedAppend,
        classify: () => "", sendProbe: () => { sends++; return { rc: 0, stdout, err: "" }; }, probeTemplate: () => "probe\n", stderr: (l) => { stderr.push(l); },
      };
      await runTick(seams, {});
      return { after: JSON.parse(readFileSync(arm, "utf8")) as Record<string, unknown>, sends, stderr };
    } finally { removeScratchTree(scratch); }
  }
  test("advances the rung and starts probe_timeout, with no queued id", async () => {
    const r = await tick(JSON.stringify({ id: "watcher-20260923T000000Z-0123456789ab", status: "queued", delivery: "harness-queue", turn: "unconfirmed" }));
    expect(r.sends).toBe(1);
    expect(r.after.probed_seats).toEqual(["goalie"]);
    expect(String(r.after.last_probe_at)).toBe("2001");
    expect(r.after.queued_probe_id ?? "").toBe("");
    expect(r.stderr).toEqual([]);
  });
  test("a poll-queued probe is accounted like a harness-queued one (tap-q2qw0)", async () => {
    // send parks a pane rung it cannot inject (stale identity, pane gone) as rc 0 queued/poll;
    // the payload is canonical, so an unrecorded rung would be probed again every tick.
    const r = await tick(JSON.stringify({ id: "watcher-20260923T000000Z-0123456789ab", status: "queued", delivery: "poll", turn: "unconfirmed" }));
    expect(r.sends).toBe(1);
    expect(r.after.probed_seats).toEqual(["goalie"]);
    expect(String(r.after.current_rung)).toBe("1");
    expect(String(r.after.last_probe_at)).toBe("2001");
    expect(r.after.queued_probe_id ?? "").toBe("");
    expect(r.stderr).toEqual([]);
  });
  test("a seat recorded in blocked_map stays in the skip set, even with an empty classifier (tap-q2qw0)", async () => {
    const blocked = { goalie: { reason: "api_error", since: 2001, reset_at: 0 } };
    const r = await tick(JSON.stringify({ id: "watcher-20260923T000000Z-0123456789ab", status: "injected", delivery: "pane" }),
      { blocked_map: JSON.stringify(blocked), blocked_exempt: "[]" });
    expect(r.sends).toBe(0);
    expect(r.after.probed_seats).toEqual([]);
    expect(JSON.parse(String(r.after.blocked_map))).toEqual(blocked);
  });
  test("a near miss (no turn) is a failed send: nothing advances", async () => {
    const r = await tick(JSON.stringify({ id: "watcher-20260923T000000Z-0123456789ab", status: "queued", delivery: "harness-queue" }));
    expect(r.after.probed_seats).toEqual([]);
    expect(String(r.after.last_probe_at)).toBe("0");
    expect(r.stderr.join("")).toContain("probe send to 'goalie' failed (rc=0)");
  });
});

describe("the production seams' boundaries", () => {
  test("the tick idles on the RESET fence (a regular reset.fence.json), not on a clear-fence marker; a lease, a reminders record and a queued probe's files are `-f`, never a directory", () => {
    const scratch = mkdtempSync(join(tmpdir(), "watch-tick-bounds."));
    try {
      const bus = join(scratch, "bus");
      mkdirSync(join(bus, "watch"), { recursive: true }); mkdirSync(join(bus, "payloads")); mkdirSync(join(bus, "receipts")); mkdirSync(join(bus, "spool")); mkdirSync(join(bus, "clear-fence"));
      const s = realTickSeams({ bus, scripts: join(scratch, "no-scripts"), registry: join(scratch, "no-registry.json"), env: { ...process.env, TAP_WATCH_NOW: "2000" } });
      // the fence
      expect(s.fencePresent()).toBe(false);
      writeFileSync(join(bus, "clear-fence", ".json"), "{}");          // an empty-handle clear-fence marker is not the reset fence
      expect(s.fencePresent()).toBe(false);
      mkdirSync(join(bus, "reset.fence.json"));                         // a directory is not the fence either
      expect(s.fencePresent()).toBe(false);
      rmSync(join(bus, "reset.fence.json"), { recursive: true });
      mkdirSync(join(scratch, "a-dir"));
      symlinkSync(join(scratch, "a-dir"), join(bus, "reset.fence.json"));  // nor a symlink to one (`-f` follows the link)
      expect(s.fencePresent()).toBe(false);
      rmSync(join(bus, "reset.fence.json"));
      writeFileSync(join(bus, "reset.fence.json"), "{}");
      expect(s.fencePresent()).toBe(true);
      // the lease
      expect(s.armed()).toBe(false);
      mkdirSync(join(bus, "watch", "arm.json"));
      expect(s.armed(), "a directory where the lease should be is not a lease").toBe(false);
      rmSync(join(bus, "watch", "arm.json"), { recursive: true });
      symlinkSync(join(scratch, "a-dir"), join(bus, "watch", "arm.json"));
      expect(s.armed(), "a symlink to a directory is not a lease").toBe(false);
      expect(s.leaseCurrent("1000")).toBe(false);
      rmSync(join(bus, "watch", "arm.json"));
      writeFileSync(join(bus, "watch", "arm.json"), "{}\n");
      expect(s.armed()).toBe(true);
      // the reminders record
      mkdirSync(join(bus, "watch", "reminders.json"));
      expect(s.remindersPresent(), "a reminders directory is a skipped queue, not a failing fire").toBe(false);
      rmSync(join(bus, "watch", "reminders.json"), { recursive: true });
      symlinkSync(join(scratch, "a-dir"), join(bus, "watch", "reminders.json"));
      expect(s.remindersPresent()).toBe(false);
      // the queued probe's files
      mkdirSync(join(bus, "payloads", "q-1.md")); mkdirSync(join(bus, "receipts", "q-1.done")); mkdirSync(join(bus, "spool", "q-1.md"));
      expect(s.busFile("payloads/q-1.md")).toBe(false);
      expect(s.busFile("receipts/q-1.done")).toBe(false);
      expect(s.busFile("spool/q-1.md")).toBe(false);
      symlinkSync(join(scratch, "a-dir"), join(bus, "spool", "q-1.meta.json"));
      expect(s.busFile("spool/q-1.meta.json")).toBe(false);
      writeFileSync(join(bus, "spool", "q-2.md"), "x");
      expect(s.busFile("spool/q-2.md")).toBe(true);
      symlinkSync(join(bus, "spool", "q-2.md"), join(bus, "payloads", "q-2.md"));
      expect(s.busFile("payloads/q-2.md"), "a symlink to a regular file is a file (`-f` follows it)").toBe(true);
    } finally {
      removeScratchTree(scratch);
    }
  });
  test("the repo clocks read the registry's `team.worktree_root` (the incumbent's `_watch_repo_root`), never the bus's ancestor or the cwd", () => {
    const scratch = mkdtempSync(join(tmpdir(), "watch-tick-repo."));
    try {
      // checkout A holds the bus; the registry names checkout B, which has a commit and a dirty file
      const git = (dir: string, ...args: string[]) => { const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: "2002-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2002-01-01T00:00:00Z", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
      for (const name of ["A", "B"]) { mkdirSync(join(scratch, name)); git(join(scratch, name), "init", "-q"); writeFileSync(join(scratch, name, "f"), name); git(join(scratch, name), "add", "f"); }
      git(join(scratch, "A"), "-c", "commit.gpgsign=false", "commit", "-q", "-m", "a");
      const before = spawnSync("git", ["-C", join(scratch, "B"), "-c", "commit.gpgsign=false", "commit", "-q", "-m", "b"], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: "2001-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
      expect(before.status).toBe(0);
      writeFileSync(join(scratch, "B", "dirty"), "x");                 // B's porcelain is non-empty; A's is clean
      const bus = join(scratch, "A", ".tap", "bus");
      mkdirSync(join(bus, "watch"), { recursive: true });
      const reg = join(scratch, "registry.json");
      writeFileSync(reg, JSON.stringify({ schema: "0.20", team: { name: "t", worktree_root: join(scratch, "B") }, seats: {} }));
      const s = realTickSeams({ bus, scripts: join(scratch, "no-scripts"), registry: reg, env: { ...process.env, TAP_WATCH_NOW: "2000" } });
      // the same two git reads, with their stderr kept, so a host that refuses them says why
      const direct = (...args: string[]) => spawnSync("git", ["-C", join(scratch, "B"), ...args], { encoding: "utf8" });
      const log = direct("log", "-1", "--format=%ct");
      expect(log.status, `git log in B: ${log.stderr}`).toBe(0);
      const porcelain = direct("status", "--porcelain");
      expect(porcelain.status, `git status in B: ${porcelain.stderr}`).toBe(0);
      expect(s.headCommitTime(), `root=${registryRepoRoot(reg)} direct=${JSON.stringify(log.stdout)}`).toBe(String(Date.UTC(2001, 0, 1) / 1000));   // B's commit, not A's
      expect(s.porcelainHash()).toBe(createHash("sha256").update("?? dirty\n").digest("hex"));
      // no worktree_root: the cwd (the incumbent's fallback)
      writeFileSync(reg, JSON.stringify({ schema: "0.20", team: { name: "t" }, seats: {} }));
      const cwd = process.cwd();
      try { process.chdir(join(scratch, "A")); expect(realTickSeams({ bus, scripts: join(scratch, "no-scripts"), registry: reg }).headCommitTime()).toBe(String(Date.UTC(2002, 0, 1) / 1000)); } finally { process.chdir(cwd); }
    } finally {
      removeScratchTree(scratch);
    }
  });
  test("a non-integer clock through the production seams: status 1, exactly one routed line, no door called", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "watch-tick-clock."));
    try {
      const bus = join(scratch, "bus");
      mkdirSync(join(bus, "watch"), { recursive: true });
      writeFileSync(join(bus, "watch", "arm.json"), JSON.stringify({ armed_at: "1000", armed_by: "lead", threshold_seconds: 300 }));
      const lines: string[] = [];
      const real = realTickSeams({ bus, scripts: join(scratch, "no-scripts"), registry: join(scratch, "no-registry.json"), env: { ...process.env, TAP_WATCH_NOW: "abc" } });
      let doors = 0;
      const counted: TickSeams = { ...real, stderr: (l) => { lines.push(l); },
        roster: () => { doors++; return real.roster(); }, processBlocked: (...a) => { doors++; return real.processBlocked(...a); },
        detector: (...a) => { doors++; return real.detector(...a); }, processSpool: (...a) => { doors++; return real.processSpool(...a); },
        busActivity: (n) => { doors++; return real.busActivity(n); } };
      expect(await runTick(counted, { ...process.env, TAP_WATCH_NOW: "abc" })).toBe(1);
      expect(lines).toEqual(["tap watch: now must be an integer: \"abc\""]);
      expect(doors).toBe(0);
      expect(readFileSync(join(bus, "watch", "arm.json"), "utf8")).toBe(JSON.stringify({ armed_at: "1000", armed_by: "lead", threshold_seconds: 300 }));
      // ... and before the REMINDERS too: a reminders-only lease with an empty queue under an invalid clock is refused
      // with the record intact (the incumbent's `remind.ts fire` CLI refused the clock first); under a valid clock the
      // same lease finishes and disarms
      writeFileSync(join(bus, "watch", "reminders.json"), "{}\n");
      writeFileSync(join(bus, "watch", "arm.json"), JSON.stringify({ armed_at: "1000", armed_by: "lead", mode: "reminders-only" }));
      const rlines: string[] = [];
      let fired = 0;
      const rem = realTickSeams({ bus, scripts: join(scratch, "no-scripts"), registry: join(scratch, "no-registry.json"), env: { ...process.env, TAP_WATCH_NOW: "abc" } });
      const remCounted: TickSeams = { ...rem, stderr: (l) => { rlines.push(l); }, remindFire: (at) => { fired++; return rem.remindFire(at); }, remindFinish: (at) => { fired++; return rem.remindFinish(at); } };
      expect(await runTick(remCounted, { ...process.env, TAP_WATCH_NOW: "abc" })).toBe(1);
      expect(rlines).toEqual(["tap watch: now must be an integer: \"abc\""]);
      expect(fired).toBe(0);
      expect(existsSync(join(bus, "watch", "arm.json")), "the record is intact").toBe(true);
      const remOk = realTickSeams({ bus, scripts: join(scratch, "no-scripts"), registry: join(scratch, "no-registry.json"), env: { ...process.env, TAP_WATCH_NOW: "2000" } });
      expect(await runTick(remOk, { ...process.env, TAP_WATCH_NOW: "2000" })).toBe(0);
      expect(existsSync(join(bus, "watch", "arm.json")), "an empty reminders-only queue finishes and disarms").toBe(false);
      rmSync(join(bus, "watch", "reminders.json"), { force: true });
      writeFileSync(join(bus, "watch", "arm.json"), JSON.stringify({ armed_at: "1000", armed_by: "lead", threshold_seconds: 300 }));
      // a C-locale-padded clock is the shell's integer (`[ -lt ]` and the arithmetic took it): the normal path, no diagnostic,
      // the doors see the number itself
      const padded = realTickSeams({ bus, scripts: join(scratch, "no-scripts"), registry: join(scratch, "no-registry.json"), env: { ...process.env, TAP_WATCH_NOW: " 2000 " } });
      const seen: string[] = [];
      const plines: string[] = [];
      const quiet: TickSeams = { ...padded, stderr: (l) => { plines.push(l); },
        roster: () => [], processBlocked: (_a, n) => { seen.push(`blocked ${n}`); return { touched: "", rc: 0 }; },
        detector: (name, args) => { seen.push(`${name} ${args[1]}`); return 0; }, processSpool: (_a, n) => { seen.push(`spool ${n}`); return 0; },
        headCommitTime: () => "1000", porcelainHash: () => "x", busActivity: (n) => { seen.push(`bus ${n}`); return "1990"; } };
      expect(await runTick(quiet, { ...process.env, TAP_WATCH_NOW: " 2000 " })).toBe(0);
      expect(plines).toEqual([]);
      expect(seen).toEqual(["blocked 2000", "context-pressure 2000", "codex-livelock 2000", "context-freeze 2000", "opencode-wedge 2000", "spool 2000", "bus 2000"]);
      // the real detector seam with a padded clock: accepted, as the shell's `[` accepted it
      expect(padded.detector("context-pressure", ["1000", " 2000 ", "40", ""], [])).toBe(0);
    } finally {
      removeScratchTree(scratch);
    }
  });
  test("the production roster rows are the registry's active rows in the document's order (the incumbent's program), not the display reader's sorted order", () => {
    const scratch = mkdtempSync(join(tmpdir(), "watch-tick-rows."));
    try {
      const reg = join(scratch, "registry.json");
      writeFileSync(reg, JSON.stringify({ schema: "0.20", team: { name: "t" }, seats: { zed: { pane: "%2", harness: "codex" }, alpha: { pane: "%1", harness: "claude", status: "active" }, mid: { status: "suspended" }, "é": { pane: "%3" } } }));
      const rows = registryRowsInOrder(reg)!;
      expect(rows.map((r) => r.handle)).toEqual(["zed", "alpha", "é"]);
      expect(rows[0]).toMatchObject({ handle: "zed", status: "active", delivery: "pane", pane: "%2", harness: "codex" }); // the incumbent defaulted delivery to pane
      // the same rows the replay's world feeds (activeSeatRows), same order
      expect(activeSeatRows(readFileSync(reg, "utf8")).rows.map((r) => r[0])).toEqual(["zed", "alpha", "é"]);
      expect(registryRowsInOrder(join(scratch, "absent.json"))).toBeNull();
      mkdirSync(join(scratch, "dir.json"));
      expect(registryRowsInOrder(join(scratch, "dir.json"))).toBeNull();
    } finally {
      removeScratchTree(scratch);
    }
  });
});

describe("the approval-timeout door (tap-rlebf.2)", () => {
  function world(scratch: string, mode: string, order: string[]): TickSeams {
    const arm = join(scratch, "bus", "watch", "arm.json");
    mkdirSync(join(scratch, "bus", "watch"), { recursive: true });
    writeFileSync(arm, `${JSON.stringify({ mode, armed_at: "1000", armed_by: "lead", threshold_seconds: 1500, episode_started_at: 0, current_rung: 0, last_porcelain_hash: "x", last_porcelain_change_at: 1000 })}\n`);
    const roster = [{ handle: "c", pane: "t:c", paneId: "%3", harness: "codex" }];
    return {
      now: () => "2001", fencePresent: () => false, armed: () => existsSync(arm),
      snapshot: () => snapshotLines(readLoose(arm)), field: (k) => fieldValue(readLoose(arm), k).replace(/\n+$/, ""),
      set: () => true, clearPause: () => true, leaseCurrent: () => true, remindersPresent: () => false, remindFire: () => 0, remindFinish: () => 0,
      roster: () => roster, processBlocked: () => { order.push("blocked"); return { touched: "", rc: 0 }; },
      approvalTimeouts: (armedBy, n, r) => { order.push(`approval ${armedBy} ${n} ${r.map(x => x.handle).join(",")}`); return 1; },
      detector: (name) => { order.push(name); return 0; }, processSpool: () => 0,
      claimAcquire: () => null, claimRelease: () => {}, busFile: () => false,
      noticeOrNotify: () => 0, notifyHuman: () => 0, evaluate: () => 0, headCommitTime: () => "1000", porcelainHash: () => "x",
      busActivity: () => "", buildChain: () => "__human__\n", nextUnprobed: (chain, skip) => nextUnprobed(skip, chain), probedAppend,
      classify: () => "", sendProbe: () => ({ rc: 1, stdout: "", err: "unexpected" }), probeTemplate: () => "", stderr: () => {},
    };
  }
  test("a full tick runs the door after the blocked pass with the armer, clock and roster, and a failed door does not stop the tick (D)", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "watch-tick-approval."));
    try {
      const order: string[] = [];
      expect(await runTick(world(scratch, "supervision", order), {})).toBe(0);
      expect(order.slice(0, 3)).toEqual(["blocked", "approval lead 2001 c", "context-pressure"]);
    } finally { removeScratchTree(scratch); }
  });
  test("a reminders-only arm never reaches the door (R15)", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "watch-tick-approval-ro."));
    try {
      const order: string[] = [];
      expect(await runTick(world(scratch, "reminders-only", order), {})).toBe(0);
      expect(order).toEqual([]);
    } finally { removeScratchTree(scratch); }
  });
});
