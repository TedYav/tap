// tap-cl1es: the bounded automatic healing. One stuck-paint episode per pane,
// {cause, count, firstSeen, lastAt} only (never frame bytes), one owner — the
// drain's readiness disposition — and the gate that decides and records under
// the window repaint lock. The alarm fires once per episode and is carried by
// the roster, not by pane effects.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectAgentState } from "../src/agent-state";
import { OVERPRINT_BOOTING_PERSISTENCE_SECS, OVERPRINT_RECORD_STALENESS_SECS, OVERPRINT_RETRY_COOLDOWN_SECS, OVERPRINT_RETRY_MAX,
  markOverprintAlarmed, overprintRepaintGate, overprintRetryDue, readOverprintRecord,
  retireOverprintAfterReadableHeal, retireOverprintRecord, seedOverprintRecord, writeOverprintRecord, type OverprintCause,
  type OverprintRecord } from "../src/overprint-marker";
import { repaintPane, type RepaintIO } from "../src/pane/repaint";
import { withOverprintRetry, type OverprintRetryIo } from "../src/spool-drain-effects";
import type { Readiness } from "../src/spool-readiness";
import type { Run } from "../src/tmux";
import { pendingInputText, type PaneIo } from "../src/pane/reader";

let home = "";

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "overprint-heal-"));
  process.env.TAP_INDEX_HOME = home;
});

afterAll(() => {
  delete process.env.TAP_INDEX_HOME;
  if (home) rmSync(home, { recursive: true, force: true });
});

const T0 = 1_800_000_000;
const nowSec = (): number => T0 + 10_000;
const record = (paneId = "%9"): OverprintRecord | null => readOverprintRecord(paneId, process.env);
const seed = (over: Partial<OverprintRecord>, paneId = "%9"): void => {
  expect(writeOverprintRecord(paneId, { v: 2, cause: "overprint", count: 0, firstSeen: 0, lastAt: 0, ...over }, process.env)).toBe(true);
};

beforeEach(() => {
  rmSync(join(home, "debug", "overprint"), { recursive: true, force: true });
});

// --- the record bound -----------------------------------------------------------------

test("a fresh paint is due immediately and writes nothing until a repaint spends", () => {
  expect(overprintRetryDue("%9", "overprint", nowSec(), process.env)).toBe("repaint");
  expect(record()).toBeNull();
});

test("a fresh booting pane plants its persistence clock and holds", () => {
  expect(overprintRetryDue("%9", "booting", nowSec(), process.env)).toBe("hold");
  expect(record()).toMatchObject({ v: 2, cause: "booting", count: 0, firstSeen: nowSec(), lastAt: 0 });
});

test("the booting cause waits the persistence bound, then becomes due", () => {
  seed({ cause: "booting", count: 0, firstSeen: nowSec() - OVERPRINT_BOOTING_PERSISTENCE_SECS + 5, lastAt: 0 });
  expect(overprintRetryDue("%9", "booting", nowSec(), process.env)).toBe("hold");
  seed({ cause: "booting", count: 0, firstSeen: nowSec() - OVERPRINT_BOOTING_PERSISTENCE_SECS - 1, lastAt: 0 });
  expect(overprintRetryDue("%9", "booting", nowSec(), process.env)).toBe("repaint");
});

test("repaints are spaced by the cooldown and capped at N, then exhausted", () => {
  let at = nowSec() - 10_000;
  for (let spent = 1; spent <= OVERPRINT_RETRY_MAX; spent++) {
    at += OVERPRINT_RETRY_COOLDOWN_SECS + 1;
    expect(overprintRetryDue("%9", "overprint", at, process.env)).toBe("repaint");
    seed({ cause: "overprint", count: spent, firstSeen: nowSec() - 10_000, lastAt: at });
  }
  expect(overprintRetryDue("%9", "overprint", at + OVERPRINT_RETRY_COOLDOWN_SECS + 1, process.env)).toBe("exhausted");
});

test("the alarm fires exactly once per episode", () => {
  seed({ count: OVERPRINT_RETRY_MAX, firstSeen: nowSec() - 1000, lastAt: nowSec() - 61 });
  expect(markOverprintAlarmed("%9", nowSec(), process.env)).toBe(true);
  expect(markOverprintAlarmed("%9", nowSec(), process.env)).toBe(false);
  expect(record()?.alarmed).toBe(true);
});

test("a cause transition starts a fresh episode", () => {
  seed({ cause: "booting", count: OVERPRINT_RETRY_MAX, firstSeen: nowSec() - 30, lastAt: nowSec() - 30 });
  expect(overprintRetryDue("%9", "overprint", nowSec(), process.env)).toBe("repaint");
  expect(record()).toMatchObject({ cause: "overprint", count: 0, firstSeen: nowSec() });
});

test("a ready read retires the record — the only retirement", () => {
  seed({ count: 3, firstSeen: nowSec() - 100, lastAt: nowSec() - 1 });
  retireOverprintRecord("%9", process.env);
  expect(record()).toBeNull();
});

test("a readable manual heal retires the episode; a stuck one leaves it", () => {
  seed({ count: OVERPRINT_RETRY_MAX, firstSeen: nowSec() - 1000, lastAt: nowSec() - 61, alarmed: true });
  expect(retireOverprintAfterReadableHeal("%9", "readable", process.env)).toBe(true);
  expect(record()).toBeNull();
  seed({ count: OVERPRINT_RETRY_MAX, firstSeen: nowSec() - 1000, lastAt: nowSec() - 61, alarmed: true });
  expect(retireOverprintAfterReadableHeal("%9", "overprint", process.env)).toBe(false);
  expect(record()?.alarmed).toBe(true);
});

test("a record older than the staleness bound reads as absent — a new pane owning the id opens fresh", () => {
  const stale = nowSec() - OVERPRINT_RECORD_STALENESS_SECS - 1;
  seed({ cause: "booting", count: OVERPRINT_RETRY_MAX, firstSeen: stale, lastAt: stale, alarmed: true });
  expect(readOverprintRecord("%9", process.env, nowSec())).toBeNull();
  expect(overprintRetryDue("%9", "overprint", nowSec(), process.env)).toBe("repaint");
  expect(readOverprintRecord("%9", process.env, stale + OVERPRINT_RECORD_STALENESS_SECS - 1)).toMatchObject({ alarmed: true });
});

test("a v1 one-shot marker reads as one spent repaint, eligible after the cooldown", () => {
  seed({ count: 1, firstSeen: nowSec(), lastAt: nowSec() });
  const dir = join(home, "debug", "overprint");
  const file = join(dir, readdirSync(dir)[0]!);
  writeFileSync(file, `${JSON.stringify({ v: 1, frameHash: "a".repeat(64) })}\n`);
  const old = nowSec() - OVERPRINT_RETRY_COOLDOWN_SECS - 5;
  utimesSync(file, old, old);
  expect(record()).toMatchObject({ v: 2, cause: "overprint", count: 1 });
  expect(overprintRetryDue("%9", "overprint", old + OVERPRINT_RETRY_COOLDOWN_SECS + 1, process.env)).toBe("repaint");
});

// --- the drain disposition ------------------------------------------------------------

function spyIo(over: Partial<OverprintRetryIo> = {}): { io: OverprintRetryIo; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    io: {
      due: (paneId, cause, now) => { calls.push(`due:${cause}`); return overprintRetryDue(paneId, cause, now, process.env); },
      markAlarmed: (paneId, now) => { calls.push("alarm"); return markOverprintAlarmed(paneId, now, process.env); },
      retire: paneId => { calls.push("retire"); retireOverprintRecord(paneId, process.env); },
      ...over,
    },
  };
}

test("a due episode maps to attemptable; a held or exhausted one keeps its hold verdict", () => {
  const { io } = spyIo();
  expect(withOverprintRetry("busy:overprint", "%9", io, nowSec())).toBe("ready");
  seed({ cause: "overprint", count: 1, firstSeen: nowSec(), lastAt: nowSec() });
  expect(withOverprintRetry("busy:overprint", "%9", io, nowSec())).toBe("busy:overprint");
  seed({ cause: "overprint", count: OVERPRINT_RETRY_MAX, firstSeen: nowSec() - 1000, lastAt: nowSec() - 61 });
  expect(withOverprintRetry("busy:overprint", "%9", io, nowSec())).toBe("busy:overprint");
});

test("an exhausted episode alarms once through the disposition, never twice", () => {
  seed({ cause: "booting", count: OVERPRINT_RETRY_MAX, firstSeen: nowSec() - 1000, lastAt: nowSec() - 61 });
  const { io, calls } = spyIo();
  const alarms: string[] = [];
  expect(withOverprintRetry("busy:booting", "%9", io, nowSec(), ({ paneId, cause }) => alarms.push(`${paneId}:${cause}`)))
    .toBe("busy:booting");
  expect(alarms).toEqual([`%9:booting`]);
  expect(withOverprintRetry("busy:booting", "%9", io, nowSec(), ({}) => alarms.push("again")))
    .toBe("busy:booting");
  expect(alarms).toEqual([`%9:booting`]);
  // A held episode is early, never alarmed.
  seed({ cause: "overprint", count: 1, firstSeen: nowSec(), lastAt: nowSec() });
  const held = spyIo();
  expect(withOverprintRetry("busy:overprint", "%9", held.io, nowSec(), ({}) => alarms.push("early")))
    .toBe("busy:overprint");
  expect(alarms).toEqual([`%9:booting`]);
  expect(held.calls).toEqual(["due:overprint"]);
});

test("a ready read retires through the disposition; other verdicts pass through untouched", () => {
  seed({ count: 1, firstSeen: nowSec(), lastAt: nowSec() });
  const { io, calls } = spyIo();
  expect(withOverprintRetry("ready", "%9", io, nowSec())).toBe("ready");
  expect(calls).toEqual(["retire"]);
  expect(record()).toBeNull();
  expect(withOverprintRetry("busy:in-turn", "%9", io, nowSec())).toBe("busy:in-turn");
  expect(withOverprintRetry("busy:decision-unavailable", "%9", io, nowSec())).toBe("busy:decision-unavailable");
});

// --- the gate under the window lock ---------------------------------------------------

function repaintFixture() {
  const seq: string[] = [];
  let width = 113;
  const ok = (stdout = ""): Run => ({ code: 0, stdout, stderr: "" }) as Run;
  const io: RepaintIO = {
    describe: () => ok(`%332\u001f@91\u001f${width}\u001f29\n`),
    windowSize: () => ok(""),
    capture: () => ok("frame"),
    resize: (_window, next) => { seq.push("resize"); width = next; return ok(); },
    restoreWindowSize: () => ok(),
    lock: () => { seq.push("lock"); return { release: () => seq.push("release") }; },
    settle: () => {},
  };
  return { io, seq };
}

test("repaintPane declines a spent budget with no resize, and admits a due one", () => {
  const f = repaintFixture();
  const result = repaintPane("%332", f.io, overprintRepaintGate("%9", "overprint", process.env, () => nowSec()));
  // No record at all: the fresh paint is due, the repaint runs.
  expect(result.ok).toBe(true);
  // One repaint = the alternate resize + the original-dimensions restore.
  expect(f.seq).toEqual(["lock", "resize", "resize", "release"]);
});

test("the gate decision and the spend recording both run while the window lock is held", () => {
  const f = repaintFixture();
  seed({ count: OVERPRINT_RETRY_MAX, firstSeen: nowSec() - 1000, lastAt: nowSec() });
  const result = repaintPane("%332", f.io, overprintRepaintGate("%9", "overprint", process.env, () => nowSec()));
  expect(result).toMatchObject({ ok: false, attempted: false, reason: "repaint budget declined" });
  expect(f.seq).toEqual(["lock", "release"]);
  // A due decision records the spend BEFORE the lock is released.
  seed({ count: OVERPRINT_RETRY_MAX - 1, firstSeen: nowSec() - 1000, lastAt: nowSec() - 61 });
  const gate = overprintRepaintGate("%9", "overprint", process.env, () => nowSec());
  const rawGate = { admit: (): boolean => gate.admit(), commit: (attempted: boolean): void => { f.seq.push("commit"); gate.commit(attempted); } };
  expect(repaintPane("%332", f.io, rawGate).ok).toBe(true);
  expect(f.seq).toEqual(["lock", "release", "lock", "resize", "resize", "commit", "release"]);
  expect(record()).toMatchObject({ count: OVERPRINT_RETRY_MAX });
});

test("a lock-busy window never consults the gate and spends nothing", () => {
  const f = repaintFixture();
  f.io.lock = () => null;
  const consulted: boolean[] = [];
  const gate = { admit: (): boolean => { consulted.push(true); return true; }, commit: () => {} };
  expect(repaintPane("%332", f.io, gate)).toMatchObject({ ok: false, attempted: false, reason: "window repaint is already in progress" });
  expect(consulted).toEqual([]);
  expect(record()).toBeNull();
});

// --- the cause reaches the roster and the nudge trigger -------------------------------

const fixtureDir = join(import.meta.dir, "fixtures", "opencode-capture");
const overprintFixtures = ["opencode-overprint-peer1-121518.ansi", "opencode-overprint-peer2-121518.ansi"];

// The readers must classify the caller's frame: a recapture would observe a
// different pane than the one whose bytes were supplied.
const NO_RECAPTURE: PaneIo = {
  capture() { throw new Error("must classify the supplied frame"); },
  paneWidth() { return ""; },
};

test("both live captures read overprint to the nudge trigger and the roster", () => {
  for (const name of overprintFixtures) {
    const frame = readFileSync(join(fixtureDir, name), "utf8");
    expect(pendingInputText(NO_RECAPTURE, "%0", "opencode", frame).status, name).toBe("overprint");
    const plain = frame.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    expect(detectAgentState("opencode", plain), name).toEqual({ agentState: "overprint", reason: "terminal_overprint" });
  }
});

test("a genuinely booting pane (no debris) still reads booting/input_band_absent", () => {
  const booting = "opencode is starting up…\n";
  expect(pendingInputText(NO_RECAPTURE, "%0", "opencode", booting).status).toBe("no-band");
  expect(detectAgentState("opencode", booting)).toEqual({ agentState: "booting", reason: "input_band_absent" });
});

test("seeding and the cause vocabulary stay typed", () => {
  expect(seedOverprintRecord("%9", "overprint", nowSec(), process.env)).toBe(true);
  expect(record()).toMatchObject({ count: 0, lastAt: 0 });
  const causes: OverprintCause[] = ["overprint", "booting"];
  expect(causes).toHaveLength(2);
  expect(withOverprintRetry("ready" as Readiness, "%9", spyIo().io, nowSec())).toBe("ready");
});
