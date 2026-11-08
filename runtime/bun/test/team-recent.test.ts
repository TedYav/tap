import { expect, test } from "bun:test";

import { TapError } from "../src/context";
import { lastActiveCell } from "../src/routing";
import { formatAge } from "../src/roster-activity";
import { latestActivity, recentCount, recentOrder, seatLastActive, takeCount, type LastActive } from "../src/team/recent";
import { offlineActivity } from "../src/team/stale";

const NOW = Date.parse("2026-08-27T00:20:00Z") / 1000;
const at = (iso: string) => Date.parse(iso) / 1000;
const noTranscript = () => null;
const refuseRead = () => { throw new Error("a working seat must not read its transcript"); };
const idle = { working: false };

test("a working seat is active now and never reads its transcript", () => {
  expect(seatLastActive({ last_launched: "2026-01-01T00:00:00Z" }, { working: true }, refuseRead, NOW)).toEqual({ at: NOW, source: "working" });
});

test("otherwise offlineActivity's rule decides, and a later dated turn end wins", () => {
  const row = { last_launched: "2026-08-26T00:00:00Z", exited_at: "2026-08-26T23:00:00Z", registered_at: "2026-08-01T00:00:00Z" };
  // exited_at counts only when neither the transcript nor last_launched dates the seat.
  expect(seatLastActive(row, idle, noTranscript, NOW)).toEqual({ at: at("2026-08-26T00:00:00Z"), source: "launched" });
  expect(seatLastActive(row, idle, noTranscript, NOW)).toEqual(offlineActivity(row, noTranscript));
  expect(seatLastActive(row, idle, () => at("2026-08-26T12:00:00Z"), NOW)).toEqual({ at: at("2026-08-26T12:00:00Z"), source: "transcript" });
  const ended = at("2026-08-27T00:05:00Z");
  expect(seatLastActive(row, { working: false, turnEndedAt: ended }, noTranscript, NOW)).toEqual({ at: ended, source: "turn end" });
  // An earlier turn end does not lower a later dated activity.
  expect(seatLastActive(row, { working: false, turnEndedAt: at("2026-08-20T00:00:00Z") }, noTranscript, NOW)?.source).toBe("launched");
  expect(seatLastActive({ exited_at: "2026-08-26T23:00:00Z" }, idle, noTranscript, NOW)!.source).toBe("exited");
  expect(seatLastActive({ registered_at: "2026-08-01T00:00:00Z" }, idle, noTranscript, NOW)!.source).toBe("registered");
});

test("nothing dated is null, never an error; a turn end alone dates the seat", () => {
  expect(seatLastActive({}, idle, noTranscript, NOW)).toBeNull();
  expect(seatLastActive({ last_launched: "not a date" }, { working: false, turnEndedAt: Number.NaN }, noTranscript, NOW)).toBeNull();
  expect(seatLastActive({}, { working: false, turnEndedAt: NOW - 60 }, noTranscript, NOW)).toEqual({ at: NOW - 60, source: "turn end" });
});

type Seat = { name: string; active: LastActive | null };
const seat = (name: string, ago: number | null, source = "launched"): Seat => ({ name, active: ago === null ? null : { at: NOW - ago, source } });
const byName = (a: Seat, b: Seat) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const order = (rows: Seat[], n?: number) => recentOrder(rows, row => row.active, byName, n).map(({ row }) => row.name);

test("recentOrder: working first, then most recent, undated last, ties by name", () => {
  const rows = [seat("undated-b", null), seat("old", 86_400), seat("tie-b", 600), seat("undated-a", null),
    seat("busy", 0, "working"), seat("tie-a", 600), seat("fresh", 60)];
  expect(order(rows)).toEqual(["busy", "fresh", "tie-a", "tie-b", "old", "undated-a", "undated-b"]);
  // Each row's activity is computed once and returned beside it.
  let calls = 0;
  const ordered = recentOrder(rows, row => { calls++; return row.active; }, byName);
  expect(calls).toBe(rows.length);
  expect(ordered[0]).toEqual({ row: rows[4]!, active: { at: NOW, source: "working" } });
});

test("working is its own first tier: a future-dated activity never outranks it (review: astra-ponytail)", () => {
  const ahead = { name: "a", active: { at: NOW + 60, source: "launched" } };
  expect(order([ahead, seat("z", 0, "working")])).toEqual(["z", "a"]);
  // Working seats tie among themselves by name, whatever clock stamped them.
  expect(order([{ name: "y", active: { at: NOW + 5, source: "working" } }, seat("x", 0, "working"), ahead])).toEqual(["x", "y", "a"]);
  // A future date displays as just now in both age formats, never a negative age.
  expect(lastActiveCell(ahead.active, NOW, formatAge)).toBe("just now");
  expect(lastActiveCell(ahead.active, NOW)).toBe("just now");
});

test("a timestamp no Date can hold is undated, so one bad row degrades instead of aborting", () => {
  const row = { harness: "opencode", last_launched: "2026-08-26T00:20:00Z" };
  // OpenCode's newest message created at 9000000000000000 ms: finite, but past the Date range.
  expect(seatLastActive(row, idle, () => 9e12, NOW)).toEqual({ at: at("2026-08-26T00:20:00Z"), source: "launched" });
  expect(seatLastActive({}, idle, () => Number.POSITIVE_INFINITY, NOW)).toBeNull();
  expect(seatLastActive({}, { working: false, turnEndedAt: 9e12 }, noTranscript, NOW)).toBeNull();
  expect(seatLastActive({}, { working: false, turnEndedAt: -9e12 }, noTranscript, NOW)).toBeNull();
});

test("recentOrder: -n keeps the first n after the sort, like head -n", () => {
  const rows = [seat("old", 86_400), seat("fresh", 60), seat("undated", null)];
  expect(order(rows, 1)).toEqual(["fresh"]);
  expect(order(rows, 2)).toEqual(["fresh", "old"]);
  expect(order(rows, 50)).toEqual(["fresh", "old", "undated"]);
  expect(order([], 3)).toEqual([]);
});

test("a team is as recent as its most recent seat, crews included; nothing dated is null", () => {
  const parent = seatLastActive({ registered_at: "2026-08-20T00:00:00Z" }, idle, noTranscript, NOW);
  const crew = seatLastActive({ crew: true, last_launched: "2026-08-26T23:00:00Z" }, idle, noTranscript, NOW);
  expect(latestActivity([parent, null, crew])).toEqual(crew);
  expect(latestActivity([null, null])).toBeNull();
  expect(latestActivity([])).toBeNull();
  const teams = [{ name: "quiet", active: latestActivity([null]) }, { name: "crewed", active: latestActivity([parent, crew]) },
    { name: "lead", active: latestActivity([parent]) }];
  expect(order(teams)).toEqual(["crewed", "lead", "quiet"]);
});

test("-n takes a positive integer as its own word, read where it was typed", () => {
  const count = (argv: string[], recent = true) => recentCount(takeCount(argv, "tap help team").count, recent, "tap help team");
  expect(count(["-n", "15"])).toBe(15);
  expect(count(["-n", "007"])).toBe(7);
  expect(count(["-n", "3", "-n", "4"])).toBe(4);
  expect(count([])).toBeUndefined();
  expect(count([], false)).toBeUndefined();
  const refusal = (argv: string[], recent = true): TapError => {
    try { count(argv, recent); } catch (e) { return e as TapError; }
    throw new Error(`no refusal for ${argv.join(" ")}`);
  };
  for (const raw of ["0", "-3", "x", "1.5", "", " 2", "99999999999999999999"]) {
    const error = refusal(["-n", raw]);
    expect(error, raw).toBeInstanceOf(TapError);
    expect([error.errorClass, error.action, error.detail]).toEqual(["usage_error", "tap help team", `-n must be a positive integer, got '${raw}'`]);
  }
  // -n takes the next word, whatever it is: an option word or `--` there is a missing value.
  for (const argv of [["-n"], ["-n", "--recent"], ["-n", "-h"], ["-n", "--harness", "codex", "2"], ["-n", "--"]]) {
    expect(refusal(argv).detail, argv.join(" ")).toBe("-n needs a positive integer: the number of rows to keep, e.g. -n 15");
  }
  // A malformed -n refuses as it is lifted, before --recent is known; a well-formed one then needs --recent.
  expect(refusal(["-n"], false).detail).toBe("-n needs a positive integer: the number of rows to keep, e.g. -n 15");
  expect(refusal(["-n", "5"], false).detail).toBe("-n limits a --recent listing; add --recent");
  for (const glued of ["-n5", "-n=5"]) expect(refusal([glued]).detail).toBe("-n takes its value as a separate word: -n <n>");
  // The rest keeps its order; a pass-through flag keeps its value word, even one spelled -n; `--` ends the scan.
  expect(takeCount(["--harness", "codex", "-n", "3", "web"], "tap help team")).toEqual({ count: 3, rest: ["--harness", "codex", "web"] });
  expect(takeCount(["--stale-after", "-n", "-n", "2"], "tap help team", ["--stale-after"])).toEqual({ count: 2, rest: ["--stale-after", "-n"] });
  expect(takeCount(["--", "-n", "3"], "tap help team")).toEqual({ count: undefined, rest: ["--", "-n", "3"] });
  expect(takeCount(["--names"], "tap help team").count).toBeUndefined();
});

test("the last-active cell says working, an age, or - and never a negative age", () => {
  expect(lastActiveCell({ at: NOW, source: "working" }, NOW)).toBe("working");
  expect(lastActiveCell(null, NOW)).toBe("-");
  expect(lastActiveCell({ at: NOW - 3 * 3600, source: "transcript" }, NOW)).toBe("3h");
  expect(lastActiveCell({ at: NOW + 500, source: "turn end" }, NOW)).toBe("just now");
  expect(lastActiveCell({ at: NOW - 3960, source: "launched" }, NOW, formatAge)).toBe("1h06m");
});
