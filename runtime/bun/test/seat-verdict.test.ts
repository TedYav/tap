// Checkpoint C commit-1 parity controls for the register chooser. The pure
// generation-aware predicates (epoch voiding, identity, classification,
// launch-reservation conjunction) are the chooser-specific ports; observation
// and session facts ride the shared owners — observe-gather.ts's chooserView
// (built on observe.ts's parseSessions/parsePanes) and the Gathered capture —
// which these controls exercise directly.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeScratchTree } from "./support/scratch";
import { chooserView, type Gathered } from "../src/observe-gather";
import {
  classifyPane,
  epochVoidedIds,
  isLaunchReservation,
  samePaneIdentity,
  seatVerdict,
  SEAT_ALIVE,
  SEAT_PANE_GONE,
  SEAT_PANE_RECYCLED,
  SEAT_UNOBSERVABLE,
} from "../src/seat-verdict";

const scratch: string[] = [];
afterEach(() => {
  for (const p of scratch.splice(0)) {
    try { chmodSync(p, 0o755); } catch { /* already writable */ }
    removeScratchTree(p);
  }
}, 30000);

test("scratch support imports resolve (fixture sanity)", () => {
  const root = realpathSync(mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "tap-seatverdict.")));
  scratch.push(root);
  expect(readdirSync(root).length).toBe(0);
  rmSync(root, { recursive: true });
});

function seatEntry(over: Record<string, string> = {}): Map<string, string> {
  return new Map(Object.entries({ pane_id: "%5", pane: "t/alice", server_epoch: "", ...over }));
}

// --- pure chooser predicates -------------------------------------------------

test("classifyPane: the incumbent four-way ladder over an injected observer", () => {
  const live = () => "%7";
  const absent = () => "";
  const blind = () => null;
  expect(classifyPane("%5", "t/a", live)).toBe(SEAT_ALIVE);
  expect(classifyPane("%5", "t/a", absent)).toBe(SEAT_PANE_GONE);
  expect(classifyPane("%5", "t/a", blind)).toBe(SEAT_UNOBSERVABLE);
  expect(classifyPane("%bad", "t/a", live)).toBe(SEAT_UNOBSERVABLE);
  expect(classifyPane("", "t/a", live)).toBe(SEAT_ALIVE);
  expect(classifyPane("", "t/a", absent)).toBe(SEAT_PANE_GONE);
  expect(classifyPane("", "t/a", blind)).toBe(SEAT_UNOBSERVABLE);
  expect(classifyPane("", "", live)).toBe(SEAT_PANE_GONE);
  // Recycled: identity observed absent, address observed present and different.
  const recycled = (t: string) => (t === "%5" ? "" : "%9");
  expect(classifyPane("%5", "t/a", recycled)).toBe(SEAT_PANE_RECYCLED);
  // Address arm: address observed equal to the stored id is still ALIVE.
  const selfAddress = (t: string) => (t === "%5" ? "" : "%5");
  expect(classifyPane("%5", "t/a", selfAddress)).toBe(SEAT_ALIVE);
});

test("samePaneIdentity: generation-aware, with the opt-in address arm", () => {
  expect(samePaneIdentity(seatEntry(), "%5", null)).toBe(true);
  expect(samePaneIdentity(seatEntry(), "%6", null)).toBe(false);
  expect(samePaneIdentity(seatEntry({ server_epoch: "srv:1:1" }), "%5", "srv:2:2")).toBe(false);
  expect(samePaneIdentity(seatEntry({ server_epoch: "srv:1:1" }), "%5", "srv:1:1")).toBe(true);
  expect(samePaneIdentity(seatEntry({ pane_id: "" }), "%5", null)).toBe(false);
  expect(samePaneIdentity(seatEntry({ pane_id: "" }), "", null, "t/alice")).toBe(true);
  expect(samePaneIdentity(seatEntry({ pane_id: "" }), "", null)).toBe(false);
  expect(samePaneIdentity(null, "%5", null)).toBe(false);
});

test("epochVoidedIds: a prior-generation stamp voids both facts; unknown never voids", () => {
  expect(epochVoidedIds(seatEntry({ server_epoch: "srv:1:1" }), "srv:2:2")).toEqual(["", ""]);
  expect(epochVoidedIds(seatEntry({ server_epoch: "srv:1:1" }), "srv:1:1")).toEqual(["%5", "t/alice"]);
  expect(epochVoidedIds(seatEntry(), "srv:2:2")).toEqual(["%5", "t/alice"]);
  expect(epochVoidedIds(seatEntry(), null)).toEqual(["%5", "t/alice"]);
  expect(epochVoidedIds(null, "srv:2:2")).toEqual(["", ""]);
});

test("isLaunchReservation: pending, or an active launching row with a launch id", () => {
  expect(isLaunchReservation(seatEntry({ status: "pending" }))).toBe(true);
  expect(isLaunchReservation(seatEntry({ status: "active", status_reason: "launching", launch_id: "j1" }))).toBe(true);
  expect(isLaunchReservation(seatEntry({ status: "active" }))).toBe(false);
  expect(isLaunchReservation(seatEntry({ status: "active", status_reason: "launching" }))).toBe(false);
  expect(isLaunchReservation(null)).toBe(false);
});

// --- the chooser view over the shared gather facts ---------------------------

function gathered(over: Partial<Gathered> = {}): Gathered {
  return {
    sessions_rc: 0,
    sessions_text: "t/alice\t900:100\t1\nsolo\t900:100\t0\n",
    panes_rc: 0,
    panes_text:
      "t/alice\tt/alice:0.1\t%5\tclaude\t101\t900:100\t0\n" +
      "solo\tsolo:0.1\t%7\tvim\t102\t900:100\t0\n",
    ps_rc: 1,
    ps_text: "",
    serverEpoch: "srv:900:100",
    ...over,
  };
}

test("chooserView: paneIdOf answers by pane id and by address; absence is observed", () => {
  const view = chooserView(gathered())!;
  expect(view).not.toBeNull();
  expect(view!.paneIdOf("%5")).toBe("%5");
  expect(view!.paneIdOf("t/alice:0.1")).toBe("%5");
  expect(view!.paneIdOf("%9")).toBe("");
  expect(view!.paneIdOf("t/nobody:9.9")).toBe("");
  expect(view!.paneIdOf("")).toBe("");
});

test("chooserView: an unobservable pane world is fail-closed null, never absence", () => {
  const view = chooserView(gathered({ panes_rc: 1 }))!;
  expect(view!.paneIdOf("%5")).toBeNull();
  expect(view!.paneIdOf("%9")).toBeNull();
  // A malformed row poisons the whole pane world (never judge on a subset).
  const poisoned = chooserView(gathered({
    panes_text: "t/alice\tt/alice:0.1\t%5\tclaude\t101\t900:100\t0\nbrokenrow\n",
  }))!;
  expect(poisoned.paneIdOf("%5")).toBeNull();
});

test("chooserView: sessions carries live names, null when the session world is unobservable", () => {
  const view = chooserView(gathered())!;
  expect(view!.sessions!.has("t/alice")).toBe(true);
  expect(view!.sessions!.has("solo")).toBe(true);
  expect(view!.sessions!.size).toBe(2);
  const blind = chooserView(gathered({ sessions_rc: 1 }))!;
  expect(blind.sessions).toBeNull();
  // Pane lookups do not depend on the session world.
  expect(blind.paneIdOf("%5")).toBe("%5");
});

test("chooserView: an observed empty session world is an empty set, not null", () => {
  // A proven-empty server answers; only an unobservable one is null, so an
  // expired launch reservation cannot be protected forever by a blind probe.
  const empty = chooserView(gathered({ sessions_rc: 0, sessions_text: "" }))!;
  expect(empty.sessions).not.toBeNull();
  expect(empty.sessions!.size).toBe(0);
  const blind = chooserView(gathered({ sessions_rc: 1 }))!;
  expect(blind.sessions).toBeNull();
});

test("seatVerdict composes epoch voiding, the view, and live-session capture", () => {
  const view = chooserView(gathered())!;
  const epoch = "srv:900:100";
  expect(seatVerdict(seatEntry({ server_epoch: epoch }), view, epoch)).toEqual([SEAT_ALIVE, "%5", "t/alice"]);
  // A row stamped under a prior generation is voided before any lookup.
  expect(seatVerdict(seatEntry({ server_epoch: "srv:899:99" }), view, epoch)).toEqual([SEAT_PANE_GONE, "", ""]);
  // An unknown server epoch (null) voids nothing.
  expect(seatVerdict(seatEntry(), view, null)).toEqual([SEAT_ALIVE, "%5", "t/alice"]);
  // Uncertainty must not void a STAMPED row either: the guard is disagreement,
  // not the observer's blindness (epochDisagrees' epochNow !== null arm).
  expect(seatVerdict(seatEntry({ server_epoch: "srv:899:99" }), view, null)).toEqual([SEAT_ALIVE, "%5", "t/alice"]);
  // The opt-in address arm reads the same predicate.
  expect(samePaneIdentity(seatEntry({ server_epoch: "srv:899:99" }), "%5", null)).toBe(true);
  // Recycled identity: stored id observed ABSENT, address now live at %7.
  const recycledEntry = seatEntry({ pane_id: "%9", pane: "solo:0.1" });
  expect(seatVerdict(recycledEntry, view, epoch)).toEqual([SEAT_PANE_RECYCLED, "%7", "solo"]);
  // An unobservable world is unverifiable, never a death sentence.
  const blind = chooserView(gathered({ panes_rc: 1 }))!;
  expect(seatVerdict(seatEntry({ server_epoch: epoch }), blind, epoch)[0]).toBe(SEAT_UNOBSERVABLE);
});

// The tap-rxqb lockstep's import pin: the register ladder must import and
// EXECUTE the shared observation + decision functions. Without this the chooser
// could silently re-inline its own probe and the classification corpus would be
// pinning two non-authoritative mirrors — the exact false confidence the
// retired four-way lockstep existed to catch.
test("the register ladder imports and executes the shared seat-verdict functions", () => {
  const ladder = readFileSync(join(import.meta.dir, "../src/verbs/register.ts"), "utf8");
  for (const needle of ['from "../seat-verdict"', "seatVerdict(", "samePaneIdentity("]) {
    expect(ladder.includes(needle), `verbs/register.ts no longer contains '${needle}' — the ladder must import and execute the shared classifier, not re-inline its own probe`).toBe(true);
  }
});
