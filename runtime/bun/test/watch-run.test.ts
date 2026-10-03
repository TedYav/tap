// The watch sidecar loop replays the frozen capture of the incumbent `tap_watch_run`
// (tap-watch.sh at the pinned base f4099de37, captured by the since-retired harness):
// every door the loop called, in order, with its
// arguments, plus the status, stderr, the heartbeat file's mtime and the record it
// left. The doors are seams here; the heartbeat runs for real over a scratch bus
// (the capture ran the real `_watch_heartbeat`), and the three refresh rows run the
// port's real stamp over a scratch source with the re-exec recorded.
//
// Rows the port answers differently are listed in DEVIATIONS with the incumbent's
// measured cell beside the port's rule -- one grammar for the interval field, a loop
// that goes on after a bad one, and a loop that goes on after a reminder queue it
// cannot read (tap-r9rrc), announcing the file and the reason once per tick.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main as remindMain } from "../src/remind";
import { DEFAULT_INTERVAL, parseInterval, QueueUnreadable, realLoopSeams, runLoop, type LoopSeams } from "../src/watch-loop";
import { atLeast, BUN_FLOOR, currentReleaseSource, makeRefresh, reexecImage, settledStampOf, SIDECAR_SOURCES, stampOf } from "../src/watch-run";
import { pidAlive, WATCHER_COMMAND } from "../src/watch-sidecar";
import { lockRoot } from "../src/panelock";

interface Oracle {
  captured_from: { head: string; now: string };
  cases: Array<{ case: string; world: World; result: Result }>;
}
interface World {
  armed: boolean;
  arm: Record<string, unknown>;
  ticks: Array<{ rc?: number; delete_arm?: boolean; add_reminders?: boolean; corrupt_reminders?: boolean; touch_source?: boolean; delete_source?: boolean }>;
  delays: Array<{ rc?: number; out?: string }> | "real";
  sleeps: Array<{ delete_arm?: boolean; signal?: string }>;
  refresh: "shim" | "real";
  args: string[];
  /** A directory at `watch/heartbeat` before the loop starts: the incumbent's `: >` failed under `set -e`. */
  heartbeat?: "directory";
}
interface Result { rc: number; stdout: string; stderr: string; effects: string[][]; arm_after: Record<string, unknown> | null; heartbeat_mtime: number | null }

const oracle = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "watch-run-oracle.json"), "utf8")) as Oracle;
const NOW = oracle.captured_from.now;
const ENTRY = "<BASE>/skills/tap/scripts/tap-watch.sh";

/** A signal delivered mid-sleep: the incumbent's trap ended the process with 0, lease kept. */
class SignalExit extends Error {}

function scratchDir(prefix: string): string { return mkdtempSync(join(tmpdir(), prefix)); }
function scrub(text: string, work: string): string { return text.split(work).join("<WORK>"); }

/**
 * The port's answer to a case, in the capture's shapes. The heartbeat and the arm
 * record are real (a scratch bus); the refresh is the port's real stamp when the
 * world says so; every other door is a recording shim scripted by the world.
 */
async function replay(world: World): Promise<Result & { reexecs: number }> {
  const work = scratchDir("watch-run-replay.");
  const bus = join(work, "bus");
  mkdirSync(join(bus, "watch"), { recursive: true });
  const arm = join(bus, "watch", "arm.json");
  const reminders = join(bus, "watch", "reminders.json");
  if (world.armed) writeFileSync(arm, JSON.stringify(world.arm) + "\n");
  if (world.heartbeat === "directory") mkdirSync(join(bus, "watch", "heartbeat"));
  const source = join(work, "stamped-source");
  writeFileSync(source, "v1\n");
  const effects: string[][] = [];
  const stderr: string[] = [];
  let reexecs = 0;
  const env = { ...process.env, TAP_HOME: bus, TAP_WATCH_NOW: NOW };
  const real = realLoopSeams({ bus, scripts: join(work, "no-scripts"), src: join(work, "no-src"), refresh: () => null, env, stderr: (line) => stderr.push(line) });
  const refresh = world.refresh === "real"
    ? makeRefresh([source], ENTRY, (line) => stderr.push(line), () => { reexecs++; effects.push(["reexec", "bash", ENTRY, "run", ...world.args]); })
    : () => null;
  let ticks = 0, delays = 0, sleeps = 0;
  let iterations = 0;
  const s: LoopSeams = {
    refresh: () => {
      // a world that has run out of script and a loop that keeps going is a defect, not a wait
      if (++iterations > 50) throw new Error("runaway loop: the world ran out of script and the loop never ended");
      effects.push(["refresh", ENTRY, "run", ...world.args]); return refresh();
    },
    armed: real.armed,
    heartbeat: (n) => {
      // the incumbent's shim recorded the lease write as it was made; a heartbeat that
      // died at `: >` never reached it
      const dead = real.heartbeat(n);
      if (!dead) effects.push(["set", "heartbeat_at", n, "heartbeat_path", "<WORK>/bus/watch/heartbeat", "watcher_pid", "<PID>", "watcher_command", WATCHER_COMMAND]);
      return dead;
    },
    interval: real.interval,
    tick: () => {
      const row = world.ticks[ticks++] ?? {};
      effects.push(["tick", String(ticks)]);
      if (row.delete_arm) rmSync(arm, { force: true });
      if (row.add_reminders) writeFileSync(reminders, "{}\n");
      if (row.corrupt_reminders) writeFileSync(reminders, "{not json\n");
      if (row.touch_source) writeFileSync(source, "v2\n");
      if (row.delete_source) rmSync(source, { force: true });
    },
    remindersPresent: real.remindersPresent,
    remindDelay: (interval) => {
      if (world.delays === "real") {
        effects.push(["delay", "real", "remind", "delay", "remind.ts", "<WORK>/bus/watch/reminders.json", "delay", String(interval)]);
        return real.remindDelay(interval);
      }
      const row = world.delays[delays++] ?? {};
      effects.push(["delay", String(delays), "remind", "delay", "remind.ts", "<WORK>/bus/watch/reminders.json", "delay", String(interval)]);
      // the scripted door models the CHILD's failure -- a queue it could not read -- so
      // it throws the class the loop degrades on; the real seam's clock refusal is the
      // other class and has its own test below
      if ((row.rc ?? 0) !== 0) throw new QueueUnreadable("classification failed");
      const parsed = parseInterval(row.out ?? "");
      if (parsed === null) throw new QueueUnreadable(`the door printed ${JSON.stringify(row.out ?? "")}: not a number`);
      return parsed;
    },
    sleep: async (seconds) => {
      const row = world.sleeps[sleeps++] ?? {};
      effects.push(["sleep", String(sleeps), String(seconds)]);
      if (row.delete_arm) rmSync(arm, { force: true });
      if (row.signal) { effects.push(["signal", row.signal]); throw new SignalExit(row.signal); }
    },
    now: () => NOW,
    stderr: (line) => stderr.push(line),
  };
  // The capture's trailing `exit` row is the harness's, not the loop's (the incumbent
  // exited INSIDE the refresh on a change or an unreadable source, so those rows have
  // none); the status is compared on its own, so the row is dropped on both sides.
  let rc: number;
  try {
    rc = await runLoop(s);
  } catch (error) {
    if (!(error instanceof SignalExit)) throw error;
    rc = 0;
  }
  let armAfter: Record<string, unknown> | null = null;
  try { armAfter = JSON.parse(readFileSync(arm, "utf8")) as Record<string, unknown>; } catch { armAfter = null; }
  if (armAfter && "watcher_pid" in armAfter) armAfter.watcher_pid = "<PID>";
  if (armAfter && "heartbeat_path" in armAfter) armAfter.heartbeat_path = scrub(String(armAfter.heartbeat_path), work);
  let mtime: number | null = null;
  try { const st = statSync(join(bus, "watch", "heartbeat")); mtime = st.isFile() ? Math.floor(st.mtimeMs / 1000) : null; } catch { mtime = null; }
  rmSync(work, { recursive: true, force: true });
  return { rc, stdout: "", stderr: stderr.map(l => scrub(l, work) + "\n").join(""), effects, arm_after: armAfter, heartbeat_mtime: mtime, reexecs };
}

/** The retired Bash loop's signature, as the captured oracle still records it; the port writes its own. */
const INCUMBENT_COMMAND = "tap-watch.sh run";

/** The incumbent's record after the run, with the loop's own signature where the port writes its own. */
function expectedArm(rec: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!rec) return rec;
  const out = { ...rec };
  if (out.watcher_command === INCUMBENT_COMMAND) out.watcher_command = WATCHER_COMMAND;
  if ("heartbeat_path" in out) out.heartbeat_path = "<WORK>/bus/watch/heartbeat";
  return out;
}

/** The incumbent's effects with the loop's own signature in the heartbeat write, without the harness's exit row. */
function expectedEffects(effects: string[][]): string[][] {
  return effects.filter(e => e[0] !== "exit").map(e => e[0] === "set" ? e.map(f => f === INCUMBENT_COMMAND ? WATCHER_COMMAND : f) : e);
}

/**
 * The rows the port answers differently, each with the incumbent's measured cell.
 * The interval rule (architect, W3 F6a; ratified
 * by the leader): one grammar for `tick_interval_seconds` --
 * signed ASCII digits, `--interval`'s positive integer, nothing trimmed -- applied
 * BEFORE the reminder door; anything else says so once and sleeps the default, in both
 * columns of the table (reminders absent / present). The reminder door's OWN failure
 * (tap-r9rrc, the same liveness class that ruling named): the incumbent's `|| return 1`
 * ended the loop with 1, lease kept and nothing behind it; the port announces the file
 * and the reason on one `tap watch:` line, sleeps the interval it already parsed, and
 * goes on -- the next tick heartbeats again.
 */
const INTERVAL_LINE = (raw: string) => `tap watch: tick_interval_seconds must be a positive integer: ${JSON.stringify(raw)}; sleeping ${DEFAULT_INTERVAL}`;
/** The runtime's own JSON.parse message for a text: the loop's line carries it verbatim, and the wording is the engine's, not the port's. */
function parseErrorOf(text: string): string { try { JSON.parse(text); } catch (error) { return (error as Error).message; } throw new Error("parsed"); }
const DEVIATIONS: Record<string, { incumbent: string; effects: (e: string[][]) => string[][]; stderr: string; rc?: number; arm?: "kept" | "gone" }> = {
  "interval-non-integer": {
    incumbent: "`sleep abc` failed at once and `wait … || true` swallowed it: a tight loop (the next tick ran immediately)",
    // two iterations in this row (the lease goes with the second tick): the line once per iteration
    effects: e => e.map(x => x[0] === "sleep" ? [x[0]!, x[1]!, String(DEFAULT_INTERVAL)] : x), stderr: INTERVAL_LINE("abc") + "\n" + INTERVAL_LINE("abc") + "\n",
  },
  "interval-decimal": {
    incumbent: "`sleep 1.5` slept 1.5 s (without a reminders file)",
    effects: e => e.map(x => x[0] === "sleep" ? [x[0]!, x[1]!, String(DEFAULT_INTERVAL)] : x), stderr: INTERVAL_LINE("1.5") + "\n",
  },
  "interval-zero": {
    incumbent: "`sleep 0` returned at once: a tight loop",
    effects: e => e.map(x => x[0] === "sleep" ? [x[0]!, x[1]!, String(DEFAULT_INTERVAL)] : x), stderr: INTERVAL_LINE("0") + "\n",
  },
  "interval-decimal-with-reminders": {
    incumbent: "remind.ts's `parseInteger` refused `1.5`, `|| return 1` ENDED the loop, lease armed and silent (rc 1)",
    effects: () => [["refresh", ENTRY, "run"], ["set", "heartbeat_at", NOW, "heartbeat_path", "<WORK>/bus/watch/heartbeat", "watcher_pid", "<PID>", "watcher_command", WATCHER_COMMAND], ["tick", "1"],
      ["delay", "real", "remind", "delay", "remind.ts", "<WORK>/bus/watch/reminders.json", "delay", String(DEFAULT_INTERVAL)], ["sleep", "1", String(DEFAULT_INTERVAL)], ["refresh", ENTRY, "run"]],
    stderr: INTERVAL_LINE("1.5") + "\n", rc: 0, arm: "gone",
  },
  "interval-non-integer-with-reminders": {
    incumbent: "remind.ts's `parseInteger` refused `abc`, the loop ENDED with the lease armed (rc 1)",
    effects: () => [["refresh", ENTRY, "run"], ["set", "heartbeat_at", NOW, "heartbeat_path", "<WORK>/bus/watch/heartbeat", "watcher_pid", "<PID>", "watcher_command", WATCHER_COMMAND], ["tick", "1"],
      ["delay", "real", "remind", "delay", "remind.ts", "<WORK>/bus/watch/reminders.json", "delay", String(DEFAULT_INTERVAL)], ["sleep", "1", String(DEFAULT_INTERVAL)], ["refresh", ENTRY, "run"]],
    stderr: INTERVAL_LINE("abc") + "\n", rc: 0, arm: "gone",
  },
  "reminders-delay-fails": {
    // the world's sleep row (which the incumbent never reached) ends the port's loop
    incumbent: "`tap: slice_failed id=delay slice=remind: classification failed` from tap_bun_call, then `return 1` -- lease armed, no runner (rc 1)",
    effects: e => [...e, ["sleep", "1", "5"], ["refresh", ENTRY, "run"]],
    stderr: "tap watch: reminders: classification failed; sleeping 5\n", rc: 0, arm: "gone",
  },
  "reminders-queue-corrupt": {
    // the REAL door over `{not json`: remind's parse error, the file named by the seam
    incumbent: "the archived remind.ts refused the queue (`tap remind: JSON Parse error…` + `tap: slice_failed id=delay slice=remind: classification failed`), `|| return 1` ended the loop with the lease armed (rc 1)",
    effects: e => [...e, ["sleep", "1", "5"], ["refresh", ENTRY, "run"],
      ["set", "heartbeat_at", NOW, "heartbeat_path", "<WORK>/bus/watch/heartbeat", "watcher_pid", "<PID>", "watcher_command", WATCHER_COMMAND], ["tick", "2"]],
    stderr: `tap watch: reminders: <WORK>/bus/watch/reminders.json: ${parseErrorOf("{not json\n")}; sleeping 5\n`, rc: 0, arm: "gone",
  },
  "refresh-real-unreadable": {
    // tap-conft: a landing that deletes a stamped source ended every live
    // waiter with the lease kept and nothing behind it. A source gone after a good
    // start is a change: the same re-exec as refresh-real-changed, whose returning
    // fake the loop reads as a failed exec (1).
    incumbent: "`tap sidecar: source-unreadable; refusing another iteration` and 1, lease kept",
    effects: e => [...e, ["reexec", "bash", ENTRY, "run"]], stderr: `tap sidecar: source-unreadable; re-exec: ${ENTRY}\n`, rc: 1, arm: "kept",
  },
  "heartbeat-directory": {
    // (c)-class: the line's wording. The status (1), the effects (the refresh, then
    // nothing: no lease write, no tick) and the retained lease are the incumbent's.
    incumbent: "bash's own `tap-watch.sh: line 192: <WORK>/bus/watch/heartbeat: Is a directory` from `: >` under `set -e`",
    effects: e => e, stderr: "tap watch: heartbeat: EISDIR: illegal operation on a directory, open '<WORK>/bus/watch/heartbeat'\n", arm: "kept",
  },
};

describe(`the loop replays the incumbent at ${oracle.captured_from.head}`, () => {
  for (const c of oracle.cases) {
    test(c.case, async () => {
      const got = await replay(c.world);
      const want = c.result;
      const dev = DEVIATIONS[c.case];
      if (c.case === "reminders-delay-empty") {
        // No port analogue: the incumbent's child printed "" with status 0 and `sleep ""`
        // failed at once (a tight loop); the in-process door returns a number or throws,
        // and a throw is announced and slept through (tap-r9rrc) -- the world's sleep row
        // then ends the loop as it ended the incumbent's.
        expect(want.effects.some(e => e[0] === "sleep" && e[2] === "")).toBe(true);
        expect(got.stderr).toBe("tap watch: reminders: the door printed \"\": not a number; sleeping 5\n");
        expect(got.effects.filter(e => e[0] === "sleep")).toEqual([["sleep", "1", "5"]]);
        expect(got.rc).toBe(0);
        expect(got.arm_after).toBeNull();
        return;
      }
      if (dev) {
        expect(dev.incumbent.length).toBeGreaterThan(0);
        expect(got.effects).toEqual(dev.effects(expectedEffects(want.effects)));
        expect(got.stderr).toBe(dev.stderr);
        expect(got.rc).toBe(dev.rc ?? want.rc);
        if (dev.arm) expect(got.arm_after === null ? "gone" : "kept").toBe(dev.arm);
        return;
      }
      expect(got.effects).toEqual(expectedEffects(want.effects));
      // the re-exec never returns in production; the capture's `exec` recorder exited 0
      // and the replay's returns, which the loop reads as a failed exec (1) -- the
      // status of that one row is the harness's on both sides
      if (c.case === "refresh-real-changed") expect(got.rc).toBe(1); else expect(got.rc).toBe(want.rc);
      expect(got.stderr).toBe(want.stderr);
      expect(got.arm_after).toEqual(expectedArm(want.arm_after));
      expect(got.heartbeat_mtime).toBe(want.heartbeat_mtime);
      if (c.world.refresh === "real") expect(got.reexecs).toBe(c.case === "refresh-real-changed" ? 1 : 0);
    });
  }
  test("the ruled rows are exactly the enumerated ones", () => {
    const names = new Set(oracle.cases.map(c => c.case));
    for (const k of Object.keys(DEVIATIONS)) expect(names.has(k), k).toBe(true);
    expect(oracle.cases.length).toBe(24);
  });
});

describe("the interval grammar", () => {
  test("is signed ASCII digits and nothing else: a padded, BOM'd or NBSP'd value is named, never quietly parsed", () => {
    expect(parseInterval("5")).toBe(5);
    expect(parseInterval("+3")).toBe(3);
    expect(parseInterval("-3")).toBe(-3);
    // the ruled rows for the record VALUE (leader ruling): the
    // incumbent's `sleep " 5 "` answer depends on the host's sleep(1), so these are the
    // port's rule, not differential rows
    for (const bad of ["", " 5 ", "5 ", "\u{feff}5", "\u{a0}5", "5\n", "1.5", "abc", "0x10", "5s", "1e3", "٣"]) expect(parseInterval(bad), JSON.stringify(bad)).toBeNull();
  });
  test("a padded or BOM'd record value takes the default with the one line, before the reminder door", async () => {
    for (const raw of [" 5 ", "\u{feff}5", "-5", "0"]) {
      const lines: string[] = []; const sleeps: number[] = []; let delays = 0; let ticks = 0;
      const s: LoopSeams = {
        refresh: () => null, armed: () => ticks < 1, heartbeat: () => null, interval: () => raw, tick: () => { ticks++; },
        remindersPresent: () => true, remindDelay: (i) => { delays++; return i; }, sleep: async (n) => { sleeps.push(n); }, now: () => "2000", stderr: (l) => lines.push(l),
      };
      expect(await runLoop(s)).toBe(0);
      expect(lines, raw).toEqual([INTERVAL_LINE(raw)]);
      expect(delays, raw).toBe(0);   // the lease went with the tick; had it stayed, the door would have seen 60
    }
  });
});

describe("the entry's stamp and refresh", () => {
  test("stampOf is `git hash-object --no-filters` per file, null when one cannot be read or is a directory", () => {
    const work = scratchDir("watch-run-stamp.");
    try {
      const a = join(work, "a"), b = join(work, "b");
      writeFileSync(a, "alpha\n"); writeFileSync(b, Buffer.from([0, 255, 10, 13]));
      const git = spawnSync("git", ["hash-object", "--no-filters", "--", a, b], { encoding: "utf8" });
      expect(git.status).toBe(0);
      expect(stampOf([a, b])).toBe(git.stdout.trimEnd());
      expect(stampOf([a, join(work, "missing")])).toBeNull();
      mkdirSync(join(work, "dir"));
      expect(stampOf([a, join(work, "dir")])).toBeNull();   // rule 38: a directory at a source's path is unreadable, as `git hash-object` refuses it
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
  test("refresh: same → continue; changed or vanished mid-life → the line, ONE re-exec, 1 if it returns; unreadable at start → the refusal line and 1", () => {
    const work = scratchDir("watch-run-refresh.");
    try {
      const src = join(work, "s"); writeFileSync(src, "v1");
      const lines: string[] = []; let reexecs = 0;
      const refresh = makeRefresh([src], "/entry", (l) => lines.push(l), () => { reexecs++; });
      expect(refresh()).toBeNull();
      expect(lines).toEqual([]);
      writeFileSync(src, "v2");
      expect(refresh()).toEqual({ status: 1 });
      expect(reexecs).toBe(1);
      expect(lines).toEqual(["tap sidecar: source-changed; re-exec: /entry"]);
      // a source a landing deleted after a good start is a change, never a refusal (tap-conft)
      rmSync(src);
      expect(refresh()).toEqual({ status: 1 });
      expect(lines[1]).toBe("tap sidecar: source-unreadable; re-exec: /entry");
      expect(reexecs).toBe(2);
      // a re-exec that throws is reported and the loop ends with 1 (a failed `exec`)
      writeFileSync(src, "v3");
      const boom = makeRefresh([src], "/entry", (l) => lines.push(l), () => { throw new Error("ENOEXEC"); });
      writeFileSync(src, "v4");
      expect(boom()).toEqual({ status: 1 });
      expect(lines.at(-1)).toBe("tap sidecar: re-exec failed: ENOEXEC");
      // unreadable at start: the line once, and every refresh refuses
      const gone = makeRefresh([join(work, "missing")], "/entry", (l) => lines.push(l), () => { reexecs++; });
      expect(lines.at(-1)).toBe("tap sidecar: source-unreadable; refusing another iteration: /entry");
      expect(gone()).toEqual({ status: 1 });
      expect(reexecs).toBe(2);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
  test("settle: a source missing for a moment (git's unlink-then-write) is re-read, not taken for a deletion; one that stays gone is null after a bounded window", () => {
    const work = scratchDir("watch-run-settle.");
    try {
      const src = join(work, "s"); writeFileSync(src, "v1");
      const settled = stampOf([src]);
      rmSync(src);
      // the checkout writes the replacement while the reader waits
      let sleeps = 0;
      const back = settledStampOf([src], 2000, () => { if (++sleeps === 2) writeFileSync(src, "v1"); });
      expect(back).toBe(settled);
      expect(sleeps).toBe(2);
      // a transient gap in a running loop is neither a refusal nor a re-exec
      const lines: string[] = []; let reexecs = 0, gap = false;
      const refresh = makeRefresh([src], "/entry", (l) => lines.push(l), () => { reexecs++; },
        files => settledStampOf(files, 2000, () => { if (gap) { writeFileSync(src, "v1"); gap = false; } }));
      rmSync(src); gap = true;
      expect(refresh()).toBeNull();
      expect(lines).toEqual([]);
      expect(reexecs).toBe(0);
      // gone for good: the window is bounded and the answer is null
      rmSync(src);
      const started = Date.now();
      let waited = 0;
      expect(settledStampOf([src], 300, ms => { waited += ms; Bun.sleepSync(ms); })).toBeNull();
      expect(waited).toBeGreaterThanOrEqual(250);
      expect(Date.now() - started).toBeLessThan(1500);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
  test("the default refresh rides out a real 300 ms gap in a stamped source without a re-exec", () => {
    const work = scratchDir("watch-run-gap.");
    try {
      const src = join(work, "s"); writeFileSync(src, "v1");
      const lines: string[] = []; let reexecs = 0;
      const refresh = makeRefresh([src], "/entry", (l) => lines.push(l), () => { reexecs++; });
      rmSync(src);
      const writer = Bun.spawn(["sh", "-c", 'sleep 0.3; printf v1 > "$1"', "gap", src]);
      try { expect(refresh()).toBeNull(); } finally { writer.kill(); }
      expect(lines).toEqual([]);
      expect(reexecs).toBe(0);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
  test("every stamped source is a regular file at HEAD, and the entry stamps itself", () => {
    const src = join(import.meta.dir, "..", "src");
    for (const rel of SIDECAR_SOURCES) expect(statSync(join(src, rel)).isFile(), rel).toBe(true);
    expect(SIDECAR_SOURCES).toContain("watch-run.ts");
    expect(SIDECAR_SOURCES).toContain("watch-loop.ts");
    expect(SIDECAR_SOURCES).toContain("watch-tick-run.ts");
    expect(SIDECAR_SOURCES).not.toContain("verbs/watch.ts");
  });
  test("atLeast compares dotted versions numerically", () => {
    expect(atLeast("1.4.0", "1.4.0")).toBe(true);
    expect(atLeast("1.10.0", "1.4.0")).toBe(true);
    expect(atLeast("1.3.9", "1.4.0")).toBe(false);
    expect(atLeast("2", "1.4.0")).toBe(true);
    expect(atLeast("1.4", "1.4.0")).toBe(true);
    expect(atLeast("canary", "1.4.0")).toBe(false);
  });
});

describe("the production seams", () => {
  test("the heartbeat touches the file to the injected clock and writes the record's fields; a watch dir or heartbeat that cannot be written ends the loop", () => {
    const work = scratchDir("watch-run-hb.");
    try {
      const bus = join(work, "bus");
      mkdirSync(join(bus, "watch"), { recursive: true });
      const arm = join(bus, "watch", "arm.json");
      writeFileSync(arm, JSON.stringify({ armed_at: "1000", armed_by: "lead" }) + "\n");
      const s = realLoopSeams({ bus, scripts: work, src: work, refresh: () => null, env: { ...process.env, TAP_WATCH_NOW: "2000" } });
      expect(s.heartbeat(s.now())).toBeNull();
      expect(Math.floor(statSync(join(bus, "watch", "heartbeat")).mtimeMs / 1000)).toBe(2000);
      const rec = JSON.parse(readFileSync(arm, "utf8")) as Record<string, unknown>;
      expect(rec.heartbeat_at).toBe(2000);
      expect(rec.heartbeat_path).toBe(join(bus, "watch", "heartbeat"));
      expect(rec.watcher_pid).toBe(process.pid);
      expect(rec.watcher_command).toBe(WATCHER_COMMAND);
      expect(s.interval()).toBe("");
      writeFileSync(arm, JSON.stringify({ armed_at: "1000", tick_interval_seconds: 5 }) + "\n");
      expect(s.interval()).toBe("5");
      // no lease: the heartbeat file is still touched, the record write is refused quietly
      rmSync(arm);
      expect(s.heartbeat("2001")).toBeNull();
      expect(Math.floor(statSync(join(bus, "watch", "heartbeat")).mtimeMs / 1000)).toBe(2001);
      expect(s.armed()).toBe(false);
      // rule 38: a directory at the lease's path is not a lease
      mkdirSync(arm);
      expect(s.armed()).toBe(false);
      expect(s.interval()).toBe("");
      // the incumbent's `mkdir -p` / `: >` ran under `set -e`: a watch dir that cannot be
      // made, or a heartbeat that cannot be truncated, is the loop's end with 1, not a
      // shrug -- and the lease write never happens
      const sealed = join(work, "sealed"); mkdirSync(sealed); writeFileSync(join(sealed, "watch"), "a file where the dir should be");
      expect(realLoopSeams({ bus: sealed, scripts: work, src: work, refresh: () => null, env: process.env }).heartbeat("2002")).toEqual({ status: 1 });
      const dirAt = join(work, "dir-at-heartbeat"); mkdirSync(join(dirAt, "watch", "heartbeat"), { recursive: true });
      const dirArm = join(dirAt, "watch", "arm.json"); writeFileSync(dirArm, JSON.stringify({ armed_at: "1000", armed_by: "lead" }) + "\n");
      expect(realLoopSeams({ bus: dirAt, scripts: work, src: work, refresh: () => null, env: process.env }).heartbeat("2003")).toEqual({ status: 1 });
      expect(JSON.parse(readFileSync(dirArm, "utf8"))).toEqual({ armed_at: "1000", armed_by: "lead" });
      if (process.getuid?.() !== 0) {   // root truncates a read-only file; the incumbent's `: >` failed as the runner user
        const ro = join(work, "ro-heartbeat"); mkdirSync(join(ro, "watch"), { recursive: true });
        writeFileSync(join(ro, "watch", "heartbeat"), ""); chmodSync(join(ro, "watch", "heartbeat"), 0o444);
        expect(realLoopSeams({ bus: ro, scripts: work, src: work, refresh: () => null, env: process.env }).heartbeat("2004")).toEqual({ status: 1 });
      }
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
  test("a heartbeat that dies ends the loop with 1 before the tick, lease retained", async () => {
    const seen: string[] = [];
    const rc = await runLoop({
      refresh: () => null, armed: () => true, heartbeat: () => ({ status: 1 }), interval: () => "5", tick: () => { seen.push("tick"); },
      remindersPresent: () => false, remindDelay: (i) => i, sleep: async () => { seen.push("sleep"); }, now: () => "1", stderr: () => {},
    });
    expect(rc).toBe(1);
    expect(seen).toEqual([]);
  });
  test("the reminder door: the seconds to the next scheduled reminder, at most the interval; an unreadable queue throws", () => {
    const work = scratchDir("watch-run-remind.");
    try {
      const bus = join(work, "bus");
      mkdirSync(join(bus, "watch"), { recursive: true });
      const s = realLoopSeams({ bus, scripts: work, src: work, refresh: () => null, env: { ...process.env, TAP_WATCH_NOW: "2000" } });
      expect(s.remindersPresent()).toBe(false);
      const reminders = join(bus, "watch", "reminders.json");
      writeFileSync(reminders, JSON.stringify({ r1: { owner: "a", to: "b", status: "scheduled", due_at: 2007, every_seconds: 60, message_id: null } }));
      expect(s.remindersPresent()).toBe(true);
      expect(s.remindDelay(60)).toBe(7);
      expect(s.remindDelay(3)).toBe(3);
      writeFileSync(reminders, "{not json");
      // tap-r9rrc: the seam's reason names the FILE, and it is the reason `tap remind
      // list` gives for the same queue -- one reader (readUnderLockOrStale), so the
      // degraded tick's line and the verb's refusal never disagree on "unreadable"
      let reason = "";
      try { s.remindDelay(60); } catch (error) { reason = (error as Error).message; }
      expect(reason.startsWith(`${reminders}: `)).toBe(true);
      let listed = "";
      try { remindMain([reminders, "list"]); } catch (error) { listed = (error as Error).message; }
      expect(listed).not.toBe("");
      expect(reason).toBe(`${reminders}: ${listed}`);
      // rule 38: a directory at the queue's path is no queue
      rmSync(reminders); mkdirSync(reminders);
      expect(s.remindersPresent()).toBe(false);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
  test("tap-r9rrc composed: the REAL tick child and the real loop over a queue neither can read -- two lines per cycle, one per door, the heartbeat stamped, the loop alive", async () => {
    // The replay's tick is a shim, so it cannot see what the operator sees in the
    // sidecar window: the tick's own reminders pass refuses the same queue first
    // (watch-tick-run.ts, `tap watch: reminders: <reason>`, the tick's status 1 is not
    // the loop's), THEN the loop's delay door announces it with the file and sleeps.
    // Both lines are the contract (CONTRACT §Watch layer); a one-line reading of it
    // was wrong. The lease is deleted from the sleep
    // seam after the first cycle so the composition ends.
    const work = scratchDir("watch-run-composed.");
    try {
      const bus = join(work, "bus"); mkdirSync(join(bus, "watch"), { recursive: true });
      mkdirSync(join(work, "index"));
      writeFileSync(join(work, "index", "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} })); // born live (F1)
      const arm = join(bus, "watch", "arm.json");
      const reminders = join(bus, "watch", "reminders.json");
      writeFileSync(arm, JSON.stringify({ armed_at: "1000", armed_by: "lead", mode: "reminders-only", evaluator: "none", tick_interval_seconds: 7 }) + "\n");
      writeFileSync(reminders, "{not json\n");
      const env = { ...process.env, TAP_HOME: bus, TAP_INDEX_HOME: join(work, "index"), TAP_WATCH_NOW: "2000" };
      const lines: string[] = [];
      const real = realLoopSeams({ bus, scripts: join(import.meta.dir, "..", "..", "..", "skills", "tap", "scripts"), src: join(import.meta.dir, "..", "src"), refresh: () => null, env, stderr: (l) => lines.push(l) });
      // the tick child's stderr is the process's; capture it through a pipe so the
      // composition's lines are asserted as one stream
      const tickLines: string[] = [];
      const seams: LoopSeams = {
        ...real,
        tick: () => {
          const r = spawnSync(process.execPath, [join(import.meta.dir, "..", "src", "watch-tick-run.ts"), "tick"], { cwd: work, env, encoding: "utf8" });
          tickLines.push(...r.stderr.split("\n").filter(Boolean));
          expect(r.status).toBe(1);   // the tick's own status: its reminders pass failed
        },
        sleep: async (seconds) => { lines.push(`<sleep ${seconds}>`); rmSync(arm); },
      };
      const rc = await runLoop(seams);
      expect(rc).toBe(0);
      const reason = parseErrorOf("{not json\n");
      expect(tickLines).toEqual([`tap watch: reminders: ${reason}`]);
      expect(lines).toEqual([`tap watch: reminders: ${reminders}: ${reason}; sleeping 7`, "<sleep 7>"]);
      expect(statSync(join(bus, "watch", "heartbeat")).isFile()).toBe(true);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
  test("tap-r9rrc boundary: the injected clock refused is not a queue -- the loop still ends with 1, lease kept", async () => {
    const work = scratchDir("watch-run-clock.");
    try {
      const bus = join(work, "bus"); mkdirSync(join(bus, "watch"), { recursive: true });
      const arm = join(bus, "watch", "arm.json");
      writeFileSync(arm, JSON.stringify({ armed_at: "1000", armed_by: "lead", tick_interval_seconds: 5 }) + "\n");
      writeFileSync(join(bus, "watch", "reminders.json"), "{}\n");
      const lines: string[] = [];
      const real = realLoopSeams({ bus, scripts: work, src: work, refresh: () => null, env: { ...process.env, TAP_HOME: bus, TAP_WATCH_NOW: "abc" }, stderr: (l) => lines.push(l) });
      const rc = await runLoop({ ...real, tick: () => {}, sleep: async () => { throw new Error("must not sleep"); } });
      expect(rc).toBe(1);
      expect(lines).toEqual(["tap watch: reminders: TAP_WATCH_NOW must be an integer"]);
      expect(statSync(arm).isFile()).toBe(true);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
  test("the tick is a child of the same bun over the tick entry: its status never reaches the loop", async () => {
    const work = scratchDir("watch-run-tick.");
    try {
      const src = join(work, "src"); mkdirSync(src);
      writeFileSync(join(src, "watch-tick-run.ts"), "process.stdout.write(`tick ${process.argv[2]} ${process.env.TAP_HOME}\\n`); process.exit(3);\n");
      const bus = join(work, "bus"); mkdirSync(join(bus, "watch"), { recursive: true });
      const s = realLoopSeams({ bus, scripts: work, src, refresh: () => null, env: { ...process.env, TAP_HOME: bus } });
      await s.tick();
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
  test("sleep resolves; a zero sleep resolves at once", async () => {
    const s = realLoopSeams({ bus: "/nonexistent", scripts: "/n", src: "/n", refresh: () => null, env: process.env });
    const t = Date.now();
    await s.sleep(0);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe("the entry's face", () => {
  test("a stamped source missing at start is the refusal line and 1 in a REAL process, before any stamped module is imported (never Bun's resolution error)", () => {
    // the whole src tree copied, then the loop module removed: the entry must refuse on
    // its own stamp, not trip over `import("./watch-loop")`
    const work = scratchDir("watch-run-unreadable.");
    try {
      const src = join(work, "src");
      cpSync(join(import.meta.dir, "..", "src"), src, { recursive: true });
      rmSync(join(src, "watch-loop.ts"));
      const r = spawnSync(process.execPath, [join(src, "watch-run.ts"), "run"], { cwd: work, encoding: "utf8" });
      expect(r.status).toBe(1);
      // bun resolves argv[1] to its real path (/private/var on macOS)
      expect(r.stderr).toBe(`tap sidecar: source-unreadable; refusing another iteration: ${join(realpathSync(src), "watch-run.ts")}\n`);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
  test("a context the selector refuses is one `tap watch:` line and 1, never a stack trace; a wrong argv is the usage and 2", () => {
    const work = scratchDir("watch-run-face.");
    try {
      // the selector's own refusal (an invalid index marker fails closed): the tick's face
      // is `tap watch: <reason>`; the loop's entry wears the same one
      mkdirSync(join(work, "index"));
      writeFileSync(join(work, "index", "global-registry.json"), "not json");
      const env: NodeJS.ProcessEnv = { ...process.env, TAP_INDEX_HOME: join(work, "index") };
      delete env.TAP_HOME;
      const r = spawnSync(process.execPath, [join(import.meta.dir, "..", "src", "watch-run.ts"), "run"], { cwd: work, env, encoding: "utf8" });
      expect(r.status).toBe(1);
      expect(r.stderr.split("\n").filter(Boolean)).toHaveLength(1);
      expect(r.stderr.startsWith("tap watch: ")).toBe(true);
      expect(r.stderr).not.toContain("    at ");
      const u = spawnSync(process.execPath, [join(import.meta.dir, "..", "src", "watch-run.ts"), "tick"], { cwd: work, env, encoding: "utf8" });
      expect(u.status).toBe(2);
      expect(u.stderr).toBe("usage: watch-run.ts run\n");
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
});

describe("the sidecar's runtime floor", () => {
  test("ensureSidecar refuses a Bun below the loop's floor before any spawn or record write; at the floor it proceeds to the session lookup", () => {
    const work = scratchDir("watch-run-floor.");
    try {
      mkdirSync(join(work, "bus", "watch"), { recursive: true });
      const arm = join(work, "bus", "watch", "arm.json");
      writeFileSync(arm, JSON.stringify({ armed_at: 1000, armed_by: "lead" }) + "\n");
      const run = (version: string) => spawnSync(process.execPath, ["-e", [
        `import { ensureSidecar } from ${JSON.stringify(join(import.meta.dir, "..", "src", "watch-sidecar.ts"))};`,
        `process.exit(ensureSidecar({ bus: ${JSON.stringify(join(work, "bus"))}, scripts: ${JSON.stringify(work)}, registry: ${JSON.stringify(join(work, "no-registry.json"))}, armer: "lead", noSpawn: false, now: "2000", runtimeVersion: ${JSON.stringify(version)} }));`,
      ].join("\n")], { encoding: "utf8", env: { ...process.env } });
      const old = run("1.3.9");
      expect(old.status).toBe(1);
      expect(old.stderr).toBe(`tap watch: the sidecar loop needs bun ${BUN_FLOOR} or newer (process.execve); this is 1.3.9; sidecar not spawned, watch remains armed\n`);
      expect(readFileSync(arm, "utf8")).toBe(JSON.stringify({ armed_at: 1000, armed_by: "lead" }) + "\n");   // untouched
      const ok = run(BUN_FLOOR);
      expect(ok.status).toBe(1);
      expect(ok.stderr).toContain("no team tmux session is available");                     // past the floor: the next refusal
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
  test("the window runs the loop under the checked executable by absolute path: a different `bun` first on the spawned PATH is not the one named", () => {
    // a stand-in tmux (records new-window's command, answers the session/window reads)
    // and a decoy `bun` share the first PATH entry; the command tmux receives must name
    // this process's Bun, quoted as one shell word, and never the bare `bun`
    const work = scratchDir("watch-run-spawn.");
    try {
      const bin = join(work, "bin"); mkdirSync(bin);
      const record = join(work, "new-window.argv");
      writeFileSync(join(bin, "tmux"), [
        "#!/bin/bash",
        'case " $* " in',
        '  *" display-message "*) echo sess ;;',
        '  *" list-windows "*) echo "shell 1" ;;',
        `  *" new-window "*) printf '%s\\n' "\${@: -1}" > ${JSON.stringify(record)}; echo 4242 ;;`,
        "esac",
        "exit 0",
        "",
      ].join("\n"));
      writeFileSync(join(bin, "bun"), "#!/bin/bash\necho 'decoy bun 0.0.1' >&2; exit 97\n");
      chmodSync(join(bin, "tmux"), 0o755); chmodSync(join(bin, "bun"), 0o755);
      mkdirSync(join(work, "bus", "watch"), { recursive: true });
      writeFileSync(join(work, "bus", "watch", "arm.json"), JSON.stringify({ armed_at: 1000, armed_by: "lead" }) + "\n");
      writeFileSync(join(work, "registry.json"), JSON.stringify({ schema: "0.20", team: { worktree_root: work }, seats: { lead: { status: "active", pane: "%1", harness: "claude" } } }));
      const r = spawnSync(process.execPath, ["-e", [
        `import { ensureSidecar } from ${JSON.stringify(join(import.meta.dir, "..", "src", "watch-sidecar.ts"))};`,
        `process.exit(ensureSidecar({ bus: ${JSON.stringify(join(work, "bus"))}, scripts: ${JSON.stringify(work)}, registry: ${JSON.stringify(join(work, "registry.json"))}, armer: "lead", noSpawn: false, now: "2000" }));`,
      ].join("\n")], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, TAP_TMUX_SOCKET_PATH: join(work, "no-socket") } });
      expect(r.stdout).toContain("sidecar started in session 'sess'");
      expect(r.status).toBe(0);
      const command = readFileSync(record, "utf8").trim();
      expect(command).toBe(`TAP_LOCK_DIR='${lockRoot()}' TAP_HOME='${join(work, "bus")}' exec '${process.execPath}' '${join(realpathSync(join(import.meta.dir, "..", "src")), "watch-run.ts")}' run`);
      expect(command).not.toMatch(/exec bun /);
      expect(JSON.parse(readFileSync(join(work, "bus", "watch", "arm.json"), "utf8")).watcher_pid).toBe(4242);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
});

describe("the watcher signature", () => {
  test("a recorded command matches only itself; the retired Bash loop's signature is not a known one", () => {
    expect(WATCHER_COMMAND).toBe("watch-run.ts run");
    // this process is `bun test …` (by file name here, by directory on the gate --
    // bun-router.test.sh runs the whole suite in one process, so the file name is NOT a
    // substring of its own command line): neither signature, so a recorded signature is
    // dead here; the "recorded substring of the real command line" row is on the child
    // below, whose argv this test owns
    const me = String(process.pid);
    expect(pidAlive(me, WATCHER_COMMAND)).toBe(false);
    expect(pidAlive(me, "")).toBe(true);
    expect(pidAlive("0", "")).toBe(false);
    // a live loop under the Bun argv answers a record carrying its own signature, and no record carrying the retired one
    const work = scratchDir("watch-run-sig.");
    try {
      writeFileSync(join(work, "watch-run.ts"), "setTimeout(() => {}, 30000);\n");
      const child = Bun.spawn([process.execPath, join(work, "watch-run.ts"), "run"], { stdout: "ignore", stderr: "ignore" });
      try {
        const pid = String(child.pid);
        expect(pidAlive(pid, INCUMBENT_COMMAND)).toBe(false);
        expect(pidAlive(pid, WATCHER_COMMAND)).toBe(true);
        expect(pidAlive(pid, work)).toBe(true);                       // an unrelated recorded command: itself
        expect(pidAlive(pid, "some other daemon")).toBe(false);
      } finally { child.kill(); }
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
});

test("release refresh maps every loop entry to current and detects a switch before its first stamp", () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "tap-release-refresh-")));
  try {
    const src = (v: string) => join(work, "versions", v, "runtime/bun/src");
    for (const v of ["v1", "v2"]) {
      const root = join(work, "versions", v);
      mkdirSync(src(v), { recursive: true });
      mkdirSync(join(root, "libexec/tap"), { recursive: true });
      writeFileSync(join(root, "libexec/tap/bun"), "#!/bin/sh\n", { mode: 0o755 });
      writeFileSync(join(root, "tap-release.json"), JSON.stringify({ schema: 1, version: v }));
    }
    symlinkSync("versions/v2", join(work, "current"));
    expect(currentReleaseSource(src("v1"))).toBe(src("v2"));
    for (const entry of ["watch-run.ts", "goalie-run.ts", "spool-waiter.ts"]) {
      const args = [process.execPath, join(src("v1"), entry), "message", "--resume-cadence", "0.25", "0.5"];
      const [image, argv] = reexecImage(src("v1"), args);
      expect(image).toBe(join(work, "versions/v2/libexec/tap/bun"));
      expect(argv).toEqual([image, join(src("v2"), entry), ...args.slice(2)]);
    }
    let reexecs = 0;
    const refresh = makeRefresh([], "entry", () => {}, () => { reexecs++; }, () => "same", src("v1"));
    expect(refresh()).toEqual({ status: 1 });
    expect(reexecs).toBe(1);
    const next = makeRefresh([], "entry", () => {}, () => { reexecs++; }, () => "same", src("v2"));
    expect(next()).toBeNull();
    expect(next()).toBeNull();
    expect(reexecs).toBe(1);
    // A bad marker cannot redirect a running loop. A clone does not follow current.
    writeFileSync(join(work, "versions/v2/tap-release.json"), "{}");
    expect(currentReleaseSource(src("v1"))).toBe(src("v1"));
    const clone = join(work, "clone/runtime/bun/src");
    expect(currentReleaseSource(clone)).toBe(clone);
    const args = [process.execPath, join(clone, "watch-run.ts"), "run"];
    expect(reexecImage(clone, args)).toEqual([process.execPath, args]);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
