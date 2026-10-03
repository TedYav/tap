import { expect, test } from "bun:test";
import { judgeStalled, type StalledRow } from "../src/roster-stalled";

const NOW = 10_000;
const row = (handle: string, agentState: string, turnEndedAt: number | null,
  turnEndedSource: "transcript" | null = turnEndedAt === null ? null : "transcript"): StalledRow =>
  ({ handle, agentState, turnEndedAt, turnEndedSource });

test("an idle seat past N that owes an ask is stalled, aged from its dated turn end", () => {
  const out = judgeStalled([row("a", "idle", NOW - 900)], { a: true }, NOW, 600);
  expect(out.stalled).toEqual([{ handle: "a", stalledForSeconds: 900 }]);
  expect(out.unjudged).toEqual([]);
});

test("N is inclusive; a seat under N is not listed and not unjudged", () => {
  expect(judgeStalled([row("a", "idle", NOW - 600)], { a: true }, NOW, 600).stalled).toHaveLength(1);
  const under = judgeStalled([row("a", "idle", NOW - 599)], { a: true }, NOW, 600);
  expect(under).toEqual({ stalled: [], unjudged: [] });
});

test("an idle seat past N with nothing owed is absent from both lists", () => {
  expect(judgeStalled([row("a", "idle", NOW - 9000)], { a: false }, NOW, 600)).toEqual({ stalled: [], unjudged: [] });
});

test("only idle qualifies: waiting, working and every other state are never listed or unjudged", () => {
  const rows = ["waiting", "working", "blocked", "booting", "overprint", "unknown", "gone", ""]
    .map((state, i) => row(`s${i}`, state, state === "working" ? null : NOW - 9000));
  const inbound = Object.fromEntries(rows.map(r => [r.handle, true]));
  expect(judgeStalled(rows, inbound, NOW, 600)).toEqual({ stalled: [], unjudged: [] });
});

test("an undated idle seat is never stalled and is reported unjudged", () => {
  const out = judgeStalled([row("a", "idle", null)], { a: true }, NOW, 600);
  expect(out.stalled).toEqual([]);
  expect(out.unjudged).toEqual([{ handle: "a", reason: "no_turn_end_date" }]);
});

test("an undated idle seat that positively owes nothing is absent from both lists", () => {
  expect(judgeStalled([row("a", "idle", null)], { a: false }, NOW, 600)).toEqual({ stalled: [], unjudged: [] });
});

test("an undated idle seat whose inbound is unreadable is unjudged for the missing date", () => {
  expect(judgeStalled([row("a", "idle", null)], { a: null }, NOW, 600).unjudged).toEqual([{ handle: "a", reason: "no_turn_end_date" }]);
});

test("a date without the transcript witness is no date", () => {
  const out = judgeStalled([row("a", "idle", NOW - 9000, null)], { a: true }, NOW, 600);
  expect(out).toEqual({ stalled: [], unjudged: [{ handle: "a", reason: "no_turn_end_date" }] });
});

test("a turn end in the future is no date", () => {
  const out = judgeStalled([row("a", "idle", NOW + 5)], { a: true }, NOW, 600);
  expect(out).toEqual({ stalled: [], unjudged: [{ handle: "a", reason: "no_turn_end_date" }] });
});

test("an unreadable inbound answer on a dated idle seat past N is unjudged, never a claim", () => {
  const out = judgeStalled([row("a", "idle", NOW - 9000)], { a: null }, NOW, 600);
  expect(out).toEqual({ stalled: [], unjudged: [{ handle: "a", reason: "inbound_unknown" }] });
});

test("a missing inbound entry is unknown, not false", () => {
  const out = judgeStalled([row("a", "idle", NOW - 9000)], {}, NOW, 600);
  expect(out.unjudged).toEqual([{ handle: "a", reason: "inbound_unknown" }]);
});

test("a dated seat under N never reports inbound_unknown: nothing could be claimed anyway", () => {
  expect(judgeStalled([row("a", "idle", NOW - 10)], { a: null }, NOW, 600)).toEqual({ stalled: [], unjudged: [] });
});

test("rows keep roster order across a mixed team", () => {
  const rows = [row("z", "idle", NOW - 700), row("m", "working", null), row("a", "idle", NOW - 800), row("q", "idle", null)];
  const out = judgeStalled(rows, { z: true, m: true, a: true, q: true }, NOW, 600);
  expect(out.stalled.map(s => s.handle)).toEqual(["z", "a"]);
  expect(out.unjudged.map(u => u.handle)).toEqual(["q"]);
});
