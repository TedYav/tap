import { describe, expect, test } from "bun:test";
import { isoAgeSeconds, tmuxRouterRepresentable } from "../src/slices/outstanding";

// Expected values are Python's own answers (the deleted lib.sh tap_iso_age_seconds:
// time.strptime("%Y-%m-%dT%H:%M:%SZ") + calendar.timegm, clamped at 0, "" on
// ValueError), generated with TAP_SPOOL_NOW=1000000000.
const PYTHON: Array<[string, string]> = [
  ["2001-09-09T01:46:30Z", "10"],
  ["2001-09-09T01:46:40Z", "0"],
  ["2001-09-09T01:46:50Z", "0"],
  ["2001-9-9T1:46:30Z", "10"],
  ["2001-09- 9T01:46:30Z", "10"],
  ["2001-09-09t01:46:30z", "10"],
  ["2000-02-29T00:00:00Z", "48217600"],
  ["2001-02-29T00:00:00Z", ""],
  ["2001-02-30T00:00:00Z", ""],
  ["2001-04-31T00:00:00Z", ""],
  ["2001-09-09T01:46:60Z", "0"],
  ["2001-09-09T01:46:61Z", "0"],
  ["2001-09-09T01:46:62Z", ""],
  ["2001-13-01T00:00:00Z", ""],
  ["2001-00-01T00:00:00Z", ""],
  ["2001-09-09T24:00:00Z", ""],
  ["2001-09-09T01:60:00Z", ""],
  ["0099-01-01T00:00:00Z", "60042995200"],
  ["0000-01-01T00:00:00Z", ""],
  ["1970-01-01T00:00:00Z", "1000000000"],
  ["2001-09-09T01:46:30", ""],
  ["2001-09-09 01:46:30Z", ""],
  ["01-09-09T01:46:30Z", ""],
  ["2001-09-09T01:46:30.5Z", ""],
  ["", ""],
  ["garbage", ""],
  ["2001-09-09T01:46:30Z ", ""],
  [" 2001-09-09T01:46:30Z", ""],
  ["2001-09-09T1:6:3Z", "2437"],
  ["9999-12-31T23:59:59Z", "0"],
];

describe("isoAgeSeconds matches the Python body it replaced", () => {
  const env = { TAP_SPOOL_NOW: "1000000000" };
  for (const [at, want] of PYTHON) {
    test(`${JSON.stringify(at)} -> ${JSON.stringify(want)}`, () => expect(isoAgeSeconds(at, env)).toBe(want));
  }

  test("a non-integer TAP_SPOOL_NOW yields no age, as Python's int() failed the call", () => {
    expect(isoAgeSeconds("2001-09-09T01:46:30Z", { TAP_SPOOL_NOW: "soon" })).toBe("");
    expect(isoAgeSeconds("2001-09-09T01:46:30Z", { TAP_SPOOL_NOW: " 1000000000 " })).toBe("10");
  });

  test("an unset or empty pin reads the wall clock", () => {
    const age = Number(isoAgeSeconds(new Date(Date.now() - 5000).toISOString().replace(/\.\d+Z$/, "Z"), { TAP_SPOOL_NOW: "" }));
    expect(age).toBeGreaterThanOrEqual(4);
    expect(age).toBeLessThanOrEqual(6);
  });
});

// Every one- and two-character value (digits and space) in each field, against
// the set Python 3.14's strptime accepts: space-padded day and hour are
// Python's, and a table of hand-picked stamps missed the hour.
const FIELDS: Record<string, string> = {"m": "2001-{}-09T01:46:30Z", "d": "2001-09-{}T01:46:30Z", "H": "2001-09-09T{}:46:30Z", "M": "2001-09-09T01:{}:30Z", "S": "2001-09-09T01:46:{}Z"};
const PYTHON_ACCEPTS: Record<string, string[]> = {"m": ["01", "02", "03", "04", "05", "06", "07", "08", "09", "1", "10", "11", "12", "2", "3", "4", "5", "6", "7", "8", "9"], "d": [" 1", " 2", " 3", " 4", " 5", " 6", " 7", " 8", " 9", "01", "02", "03", "04", "05", "06", "07", "08", "09", "1", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "2", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "3", "30", "4", "5", "6", "7", "8", "9"], "H": [" 0", " 1", " 2", " 3", " 4", " 5", " 6", " 7", " 8", " 9", "0", "00", "01", "02", "03", "04", "05", "06", "07", "08", "09", "1", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "2", "20", "21", "22", "23", "3", "4", "5", "6", "7", "8", "9"], "M": ["0", "00", "01", "02", "03", "04", "05", "06", "07", "08", "09", "1", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "2", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "3", "30", "31", "32", "33", "34", "35", "36", "37", "38", "39", "4", "40", "41", "42", "43", "44", "45", "46", "47", "48", "49", "5", "50", "51", "52", "53", "54", "55", "56", "57", "58", "59", "6", "7", "8", "9"], "S": ["0", "00", "01", "02", "03", "04", "05", "06", "07", "08", "09", "1", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "2", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "3", "30", "31", "32", "33", "34", "35", "36", "37", "38", "39", "4", "40", "41", "42", "43", "44", "45", "46", "47", "48", "49", "5", "50", "51", "52", "53", "54", "55", "56", "57", "58", "59", "6", "60", "61", "7", "8", "9"]};
const CHARS = [" ", ..."0123456789"];
const VALUES = [...CHARS, ...CHARS.flatMap(a => CHARS.map(b => a + b))];

describe("each field accepts exactly what Python's strptime accepts", () => {
  for (const [field, template] of Object.entries(FIELDS)) {
    test(`%${field}`, () => {
      const accepted = VALUES.filter(v => isoAgeSeconds(template.replace("{}", v), { TAP_SPOOL_NOW: "1000000000" }) !== "");
      expect(accepted.sort()).toEqual([...PYTHON_ACCEPTS[field]!].sort());
    });
  }
});

// Bash imports an exported `tmux` function into the lib.sh child,
// which kept it, and tap_tmux_router_representable then refused native reads.
test("an importable exported tmux function makes the router unrepresentable, as bash imports it", () => {
  expect(tmuxRouterRepresentable({})).toBe(true);
  expect(tmuxRouterRepresentable({ "BASH_FUNC_tmux%%": "() {  command tmux -L private \"$@\"\n}" })).toBe(false);
  // Shapes bash does not import (verified against bash 5.3): no refusal.
  expect(tmuxRouterRepresentable({ "BASH_FUNC_tmux%%": "echo hi" })).toBe(true);
  expect(tmuxRouterRepresentable({ "BASH_FUNC_tmux%%": "()  { echo hi; }" })).toBe(true);
  expect(tmuxRouterRepresentable({ "BASH_FUNC_tmux()": "() { echo hi; }" })).toBe(true);
});
