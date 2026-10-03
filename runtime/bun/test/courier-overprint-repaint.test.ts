// tap-vctb8, bounded by tap-cl1es: the pre-inject band read meeting a
// claude-mem overprint (or an OpenCode band that never painted). The courier
// repaints the composer ONCE per delivery attempt (never keys), re-reads, and
// only proceeds on a clean band. A paint that survives repaints is bounded AT
// THE EFFECT by the pane's stuck-paint record — {cause, count, firstSeen,
// lastAt}, never the frame bytes — on a cooldown, at most N attempts, then the
// episode is exhausted and the alarm layer takes over.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { submitVerifyLocked, type PaneEffects, type SubmitAuthority } from "../src/courier";
import { OVERPRINT_RETRY_MAX, overprintRepaintGate, overprintRetryDue, readOverprintRecord,
  writeOverprintRecord, type OverprintRecord } from "../src/overprint-marker";
import type { RepaintGate } from "../src/pane/repaint";
import type { PaneBand } from "../src/pane-state";

const wire = "[[TAP v0.23 note overprint-control]]";
const SENTINEL_ID = "oc-test-20260924T000000Z-ovprint01";
const live = { paneId: "%9", session: "fixture", serverEpoch: "1:2", panePid: "4242", currentCommand: "opencode" };
const opencodeBound = { paneId: "%9", serverEpoch: "1:2", harness: "opencode" };
const overprintBand = { state: "unobservable", cause: "overprint", reason: "OpenCode terminal overprint obscures the composer" } as const;
const bootingBand = { state: "unobservable", reason: "no recognized OpenCode composer" } as const;
const BEFORE = "\x1b[39m\x1b[49m     [claude-mem-capture] Worker POST failed";
const AFTER = "clean composer frame";

const authorityFor = (over: Partial<SubmitAuthority> = {}): SubmitAuthority => {
  const busHome = mkdtempSync(join(home, "bus-"));
  return { busHome, recipient: "peer", registryPath: "", scriptsDir: "", agentFamilies: new Set(["opencode"]),
    forceNoPrompt: true, noPromptOk: true,
    deliveryFacts: { noSpool: true, urgent: false, recipientBound: true },
    ...over };
};

// The automatic drain's authority: no force, no no-spool. Only this path may
// spend the booting cure — force attempts keep the incumbent behavior.
const autoAuthority = (): SubmitAuthority => authorityFor({ forceNoPrompt: false, noPromptOk: false,
  deliveryFacts: { noSpool: false, urgent: false, recipientBound: true } });

let home = "";
// The runner seeds TAP_INDEX_HOME for every file in the batch; restore it, never unset it, or later files lose the machine index.
const savedIndexHome = process.env.TAP_INDEX_HOME;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "overprint-home-"));
  process.env.TAP_INDEX_HOME = home;
});

afterAll(() => {
  if (savedIndexHome === undefined) delete process.env.TAP_INDEX_HOME;
  else process.env.TAP_INDEX_HOME = savedIndexHome;
  if (home) rmSync(home, { recursive: true, force: true });
});

const nowSec = (): number => Math.floor(Date.now() / 1000);
const record = (paneId = "%9"): OverprintRecord | null => readOverprintRecord(paneId, process.env);
const seed = (over: Partial<OverprintRecord>, paneId = "%9"): void => {
  expect(writeOverprintRecord(paneId, { v: 2, cause: "overprint", count: 0, firstSeen: 0, lastAt: 0, ...over }, process.env)).toBe(true);
};

interface Harness {
  fx: PaneEffects;
  effects: string[];
  repaints: number;
}

/**
 * The fake repaint honors the gate exactly like the real impl: admit() runs
 * before any effect, commit(attempted) records the spend — this is the
 * contract repaintPane applies under the window lock.
 */
function fxWithBands(bands: PaneBand[], opts: { repaintFails?: boolean; lockBusy?: boolean; bound?: Record<string, unknown> } = {}): Harness {
  const effects: string[] = [];
  let repaints = 0;
  let pasted = false;
  // The on-screen bytes: the paint starts as BEFORE; each successful repaint
  // leaves a DIFFERENT post-repaint screen (a working turn repaints
  // constantly) — the bound must bind across changing frames.
  let screen = BEFORE;
  let generation = 0;
  const bound = opts.bound ?? opencodeBound;
  const fx: PaneEffects = {
    observePane: () => live,
    harnessEvidence: () => "alive",
    paneState: () => bands.length > 1 ? bands.shift()! : bands[0]!,
    copyMode: () => ({ status: "normal" }),
    repaint: (target, gate?: RepaintGate) => {
      if (opts.lockBusy) return { ok: false, attempted: false, before: null, after: null, reason: "window repaint is already in progress" };
      if (gate && !gate.admit()) return { ok: false, attempted: false, before: null, after: null, reason: "repaint budget declined" };
      repaints++;
      effects.push("repaint");
      const before = screen;
      screen = opts.repaintFails ? before : `${AFTER}+${++generation}`;
      gate?.commit(true);
      return opts.repaintFails
        ? { ok: false, attempted: true, before, after: screen, reason: "resize refused" }
        : { ok: true, attempted: true, before, after: screen, reason: "" };
    },
    captureEscaped: () => ({ ok: true, frame: screen }),
    injectText: () => { pasted = true; effects.push("paste"); return true; },
    pressEnter: () => { effects.push("enter"); return true; },
    pressKeys: () => { effects.push("keys"); return true; },
    inputHasId: () => false,
    observeInput: () => ({ state: "present", text: SENTINEL_ID }),
    // Pre-paste the wire sits staged; after paste+Enter the box has cleared —
    // opencode's landing shape. State-driven, so extra pre-loop reads are safe.
    submitFrame: () => ({ state: pasted && effects.includes("enter") ? "empty" : "staged", mode: "idle", width: "80" }),
    settle: () => {},
  };
  return { fx, effects, get repaints() { return repaints; } };
}

function captureStderr(run: () => unknown): { result: unknown; lines: string[] } {
  const lines: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk?: unknown) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    return { result: run(), lines };
  } finally {
    process.stderr.write = original;
  }
}

function recordCount(): number {
  const dir = join(home, "debug", "overprint");
  return existsSync(dir) ? readdirSync(dir).length : 0;
}

beforeEach(() => {
  rmSync(join(home, "debug", "overprint"), { recursive: true, force: true });
});

test("a detected overprint repaints once, re-reads clean, and only then injects", () => {
  const h = fxWithBands([overprintBand, { state: "ready" }, { state: "ready" }]);
  const { result, lines } = captureStderr(() => submitVerifyLocked("%9", SENTINEL_ID, wire, opencodeBound, h.fx, authorityFor({ noPromptOk: false })));
  expect(result).toMatchObject({ status: "injected" });
  expect(h.repaints).toBe(1);
  // Repaint BEFORE any key, then the submit Enter and the completion Enter.
  expect(h.effects).toEqual(["repaint", "paste", "enter", "enter"]);
  expect(lines.join("")).toContain("OpenCode terminal overprint repainted before delivery classification");
  // A clean re-read retires the episode: a readable band is the one retirement.
  expect(recordCount()).toBe(0);
});

test("a persistent overpaint repaints exactly once, keys nothing, and spends one budget entry", () => {
  const h = fxWithBands([overprintBand, overprintBand]);
  const { result } = captureStderr(() => submitVerifyLocked("%9", SENTINEL_ID, wire, opencodeBound, h.fx, authorityFor()));
  expect(result).toMatchObject({ status: "band_busy", cause: "overprint", bandState: "unobservable" });
  expect(h.repaints).toBe(1);
  expect(h.effects).toEqual(["repaint"]);
  expect(record()).toMatchObject({ v: 2, cause: "overprint", count: 1 });
  // The spend is fresh, so an immediate second attempt holds with no repaint.
  const h2 = fxWithBands([overprintBand]);
  captureStderr(() => submitVerifyLocked("%9", SENTINEL_ID, wire, opencodeBound, h2.fx, authorityFor()));
  expect(h2.repaints).toBe(0);
  expect(h2.effects).toEqual([]);
});

test("the healing loop: a due episode repaints again on the cooldown, accumulating spends", () => {
  seed({ cause: "overprint", count: 1, firstSeen: nowSec() - 300, lastAt: nowSec() - 61 });
  const h = fxWithBands([overprintBand, overprintBand]);
  captureStderr(() => submitVerifyLocked("%9", SENTINEL_ID, wire, opencodeBound, h.fx, authorityFor()));
  expect(h.repaints).toBe(1);
  expect(h.effects).toEqual(["repaint"]);
  expect(record()).toMatchObject({ cause: "overprint", count: 2 });
});

test("the bound binds across changing frames — a working turn cannot reset it (review A)", () => {
  seed({ cause: "overprint", count: OVERPRINT_RETRY_MAX, firstSeen: nowSec() - 1000, lastAt: nowSec() - 61 });
  // The screen changed since the last recorded paint (the fake repaints a
  // fresh generation on every effect); there is no hash in the record to
  // reset, so the exhausted episode still declines the resize.
  const h = fxWithBands([overprintBand]);
  const { result } = captureStderr(() => submitVerifyLocked("%9", SENTINEL_ID, wire, opencodeBound, h.fx, authorityFor()));
  expect(result).toMatchObject({ status: "band_busy", cause: "overprint", bandState: "unobservable" });
  expect(h.repaints).toBe(0);
  expect(h.effects).toEqual([]);
  expect(record()).toMatchObject({ count: OVERPRINT_RETRY_MAX });
});

test("the booting cause waits out its persistence bound before the first repaint", () => {
  // Fresh seed: hold, and NO resize touches a pane that may genuinely be starting.
  const h0 = fxWithBands([bootingBand, bootingBand]);
  captureStderr(() => submitVerifyLocked("%9", SENTINEL_ID, wire, opencodeBound, h0.fx, autoAuthority()));
  expect(h0.repaints).toBe(0);
  expect(record()).toMatchObject({ cause: "booting", count: 0 });
  // Past the persistence bound: the repaint happens and is spent.
  seed({ cause: "booting", count: 0, firstSeen: nowSec() - 31, lastAt: 0 });
  const h1 = fxWithBands([bootingBand, bootingBand]);
  captureStderr(() => submitVerifyLocked("%9", SENTINEL_ID, wire, opencodeBound, h1.fx, autoAuthority()));
  expect(h1.repaints).toBe(1);
  expect(h1.effects).toEqual(["repaint"]);
  expect(record()).toMatchObject({ cause: "booting", count: 1 });
  // A force attempt never spends the booting cure, even when it is due.
  seed({ cause: "booting", count: 0, firstSeen: nowSec() - 31, lastAt: 0 });
  const h2 = fxWithBands([bootingBand]);
  captureStderr(() => submitVerifyLocked("%9", SENTINEL_ID, wire, opencodeBound, h2.fx, authorityFor()));
  expect(h2.repaints).toBe(0);
  expect(record()).toMatchObject({ cause: "booting", count: 0 });
});

test("shell-mode and pane_dead causes never repaint; a non-opencode seat never repaints", () => {
  const shell = { state: "unobservable", cause: "shell-mode", reason: "shell mode" } as const;
  const h = fxWithBands([shell]);
  captureStderr(() => submitVerifyLocked("%9", SENTINEL_ID, wire, opencodeBound, h.fx, authorityFor()));
  expect(h.repaints).toBe(0);
  expect(h.effects).toEqual([]);
  expect(recordCount()).toBe(0);
  const h2 = fxWithBands([bootingBand], { bound: { ...opencodeBound, harness: "claude" } });
  captureStderr(() => submitVerifyLocked("%9", SENTINEL_ID, wire, { ...opencodeBound, harness: "claude" }, h2.fx, authorityFor()));
  // A non-opencode seat is never a repaint target (whatever else the submit does).
  expect(h2.repaints).toBe(0);
  expect(h2.effects).not.toContain("repaint");
  expect(recordCount()).toBe(0);
});

test("a clean re-read retires a stale episode record", () => {
  seed({ cause: "overprint", count: 1, firstSeen: nowSec() - 300, lastAt: nowSec() - 61 });
  const h = fxWithBands([overprintBand, { state: "ready" }, { state: "ready" }]);
  const { result } = captureStderr(() => submitVerifyLocked("%9", SENTINEL_ID, wire, opencodeBound, h.fx, authorityFor({ noPromptOk: false })));
  expect(result).toMatchObject({ status: "injected" });
  expect(recordCount()).toBe(0);
});

test("a failed repaint announces the failure and still spends the budget", () => {
  const h = fxWithBands([overprintBand, overprintBand], { repaintFails: true });
  const { result, lines } = captureStderr(() => submitVerifyLocked("%9", SENTINEL_ID, wire, opencodeBound, h.fx, authorityFor()));
  expect(result).toMatchObject({ status: "band_busy", cause: "overprint", bandState: "unobservable" });
  expect(h.repaints).toBe(1);
  expect(h.effects).toEqual(["repaint"]);
  expect(lines.join("")).toContain("OpenCode terminal overprint repaint failed before delivery classification: resize refused");
  expect(record()).toMatchObject({ count: 1 });
  const h2 = fxWithBands([overprintBand]);
  captureStderr(() => submitVerifyLocked("%9", SENTINEL_ID, wire, opencodeBound, h2.fx, authorityFor()));
  expect(h2.repaints).toBe(0);
  expect(h2.effects).toEqual([]);
});

test("a repaint that was never attempted (lock busy) spends nothing, so the next attempt still repaints", () => {
  const h = fxWithBands([overprintBand, overprintBand], { lockBusy: true });
  captureStderr(() => submitVerifyLocked("%9", SENTINEL_ID, wire, opencodeBound, h.fx, authorityFor()));
  expect(recordCount()).toBe(0);
  const h2 = fxWithBands([overprintBand, overprintBand]);
  captureStderr(() => submitVerifyLocked("%9", SENTINEL_ID, wire, opencodeBound, h2.fx, authorityFor()));
  expect(h2.repaints).toBe(1);
});

test("an unwritable record store keeps the overprint refusal instead of throwing", () => {
  // A FILE where the record directory belongs makes mkdirSync fail.
  mkdirSync(join(home, "debug"), { recursive: true });
  writeFileSync(join(home, "debug", "overprint"), "not a directory");
  const h = fxWithBands([overprintBand, overprintBand]);
  const { result, lines } = captureStderr(() => submitVerifyLocked("%9", SENTINEL_ID, wire, opencodeBound, h.fx, authorityFor()));
  expect(result).toMatchObject({ status: "band_busy", cause: "overprint", bandState: "unobservable" });
  expect(h.effects).toEqual(["repaint"]);
  expect(lines.join("")).toContain("repaint budget could not be recorded");
  rmSync(join(home, "debug", "overprint"), { force: true });
});

test("no repaint seam on the effects object keeps today's repark (pre-U4 fakes)", () => {
  const effects: string[] = [];
  const fx: PaneEffects = {
    observePane: () => live,
    harnessEvidence: () => "alive",
    paneState: () => overprintBand,
    copyMode: () => ({ status: "normal" }),
    injectText: () => { effects.push("paste"); return true; },
    pressEnter: () => { effects.push("enter"); return true; },
    inputHasId: () => false,
    settle: () => {},
  };
  expect(submitVerifyLocked("%9", SENTINEL_ID, wire, opencodeBound, fx, authorityFor({ noPromptOk: false })))
    .toMatchObject({ status: "band_busy", bandState: "unobservable", cause: "overprint" });
  expect(effects).toEqual([]);
  // A repaint without the capture seam cannot read or bound the episode, so
  // the branch stays out: no resize, effect-free repark.
  let repaints = 0;
  const repaintOnly: PaneEffects = {
    observePane: () => live,
    harnessEvidence: () => "alive",
    paneState: () => overprintBand,
    copyMode: () => ({ status: "normal" }),
    repaint: () => { repaints++; return { ok: true, attempted: true, before: BEFORE, after: AFTER, reason: "" }; },
    injectText: () => { effects.push("paste"); return true; },
    pressEnter: () => { effects.push("enter"); return true; },
    inputHasId: () => false,
    settle: () => {},
  };
  expect(submitVerifyLocked("%9", SENTINEL_ID, wire, opencodeBound, repaintOnly, authorityFor({ noPromptOk: false })))
    .toMatchObject({ status: "band_busy", bandState: "unobservable", cause: "overprint" });
  expect(repaints).toBe(0);
  expect(effects).toEqual([]);
});

// The REAL specimen bytes (sanitized live capture). The debris paints INSIDE a
// bordered row, so the escaped frame the courier captures is the pane's true
// byte stream, not a synthetic construction.
const SPECIMEN = readFileSync(join(import.meta.dir, "fixtures", "opencode-capture", "overprint-live-124.ansi"), "utf8");
const SPECIMEN_CLEAN = SPECIMEN.split("\n")
  .map(l => l.includes("claude-mem-capture") ? "  ┃" : l)
  .join("\n");

function specimenFx(bands: PaneBand[], postRepaintScreen: string): Harness {
  const effects: string[] = [];
  let repaints = 0;
  let pasted = false;
  let screen = SPECIMEN;
  const fx: PaneEffects = {
    observePane: () => live,
    harnessEvidence: () => "alive",
    paneState: () => bands.length > 1 ? bands.shift()! : bands[0]!,
    copyMode: () => ({ status: "normal" }),
    repaint: (target, gate?: RepaintGate) => {
      if (gate && !gate.admit()) return { ok: false, attempted: false, before: null, after: null, reason: "repaint budget declined" };
      repaints++;
      effects.push("repaint");
      const before = screen;
      screen = postRepaintScreen;
      gate?.commit(true);
      return { ok: true, attempted: true, before, after: postRepaintScreen, reason: "" };
    },
    captureEscaped: () => ({ ok: true, frame: screen }),
    injectText: () => { pasted = true; effects.push("paste"); return true; },
    pressEnter: () => { effects.push("enter"); return true; },
    pressKeys: () => { effects.push("keys"); return true; },
    inputHasId: () => false,
    observeInput: () => ({ state: "present", text: SENTINEL_ID }),
    submitFrame: () => ({ state: pasted && effects.includes("enter") ? "empty" : "staged", mode: "idle", width: "80" }),
    settle: () => {},
  };
  return { fx, effects, get repaints() { return repaints; } };
}

test("real specimen bytes: a repaint that clears the paint injects and writes no record (tap-vctb8)", () => {
  const h = specimenFx([overprintBand, { state: "ready" }, { state: "ready" }], SPECIMEN_CLEAN);
  const { result } = captureStderr(() => submitVerifyLocked("%9", SENTINEL_ID, wire, opencodeBound, h.fx, authorityFor({ noPromptOk: false })));
  expect(result).toMatchObject({ status: "injected" });
  expect(h.repaints).toBe(1);
  expect(h.effects).toEqual(["repaint", "paste", "enter", "enter"]);
  expect(recordCount()).toBe(0);
});

test("real specimen bytes: a paint surviving the repaint is spent and bounded at the effect (tap-vctb8, tap-cl1es)", () => {
  // Attempt 1: the repaint leaves the same debris on screen; one spend records.
  const h1 = specimenFx([overprintBand, overprintBand], SPECIMEN);
  const { result } = captureStderr(() => submitVerifyLocked("%9", SENTINEL_ID, wire, opencodeBound, h1.fx, authorityFor()));
  expect(result).toMatchObject({ status: "band_busy", cause: "overprint", bandState: "unobservable" });
  expect(h1.repaints).toBe(1);
  expect(record()).toMatchObject({ cause: "overprint", count: 1 });
  // Attempt 2 (deadline-due or direct send: no readiness gate in between):
  // the cooldown holds with no repaint and no keys.
  const h2 = specimenFx([overprintBand], SPECIMEN);
  const { result: result2 } = captureStderr(() => submitVerifyLocked("%9", SENTINEL_ID, wire, opencodeBound, h2.fx, authorityFor()));
  expect(result2).toMatchObject({ status: "band_busy", cause: "overprint" });
  expect(h2.repaints).toBe(0);
  expect(h2.effects).toEqual([]);
});

// The gate itself: admit and commit are one decision, the contract
// repaintPane applies under the window lock (tap-cl1es review C). An
// exhausted episode declines; a due one admits, and its commit records the
// spend the next admit will see.
test("the gate declines an exhausted episode and admits a due one under its commit", () => {
  seed({ cause: "overprint", count: OVERPRINT_RETRY_MAX, firstSeen: nowSec() - 1000, lastAt: nowSec() });
  const exhausted = overprintRepaintGate("%9", "overprint", process.env);
  expect(exhausted.admit()).toBe(false);
  expect(overprintRetryDue("%9", "overprint", nowSec(), process.env)).toBe("exhausted");
  seed({ cause: "overprint", count: OVERPRINT_RETRY_MAX - 1, firstSeen: nowSec() - 1000, lastAt: nowSec() - 61 });
  const due = overprintRepaintGate("%9", "overprint", process.env);
  expect(due.admit()).toBe(true);
  due.commit(true);
  expect(record()).toMatchObject({ count: OVERPRINT_RETRY_MAX });
  expect(overprintRepaintGate("%9", "overprint", process.env).admit()).toBe(false);
});
