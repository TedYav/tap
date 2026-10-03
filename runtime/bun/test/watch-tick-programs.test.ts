// The tick's pure programs (watch-tick.ts) against eight standalone Python
// programs (lifted from tap-watch.sh at f6be3e855) and frozen outputs from the
// ninth, registry-dependent program. Compare stdout and exit status byte for
// byte, including where Python raised. One interpreter runs the whole corpus (each program is
// exec'd per case with its own argv/stdin and a strictly-encoding stdout), so the
// corpus can be wide without a process per row; the program TEXT is the incumbent's.
//
// Where the port deliberately refuses what python evaluated (a set member that is
// not a string -- python sorted ints, deduplicated True against 1, raised on a
// list; R2b class: a second engine for a value nobody writes), the row is in the
// REFUSED table below with python's actual answer beside the port's refusal, and
// enumerated at the end so a dropped row reds.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  activeSeatRows, activityFloor, blockedKeysJson, classifyBlockedTranscript, isExempt, parseResetEpoch, probeReceipt,
  readRegistryText, realWedge, skipSetJson, zoneOf,
} from "../src/watch-tick";
import { removeScratchTree } from "./support/scratch";

// The registry-dependent program's outputs were captured at d9b94af16 before
// retiring registry_v20; the other eight standalone historical programs stay verbatim.
import rowGolden from "./support/python-closure-watch-rows.json";

const PY_FLOOR = `
import sys
now = int(sys.argv[1]); floor = int(sys.argv[2]); best = floor; real = 0
for a in sys.argv[3:]:
    try: v = int(a)
    except ValueError: continue
    if v > now: v = now
    best = max(best, v)
    real = max(real, v)
print(f"{best}\\t{real}")`;
const PY_BLOCKED_KEYS = `
import json, sys
try: d = json.loads(sys.argv[1] or "{}")
except Exception: d = {}
print(json.dumps(list(d.keys()), separators=(",", ":")))`;
const PY_SKIP = `
import json, sys
a = json.loads(sys.argv[1] or "[]")
b = json.loads(sys.argv[2] or "[]")
c = [h for h in sys.argv[3].split("\\n") if h]
print(json.dumps(sorted(set(a) | set(b) | set(c)), separators=(",", ":")))`;
const PY_WEDGE = `
import json, sys
probed = set(json.loads(sys.argv[1] or "[]"))
blocked = set(json.loads(sys.argv[2] or "{}"))
exempt = set(json.loads(sys.argv[3] or "[]"))
print("1" if (probed - blocked - exempt) else "0")`;
const PY_EXEMPT = `
import json, sys
try: a = json.loads(sys.argv[2] or "[]")
except Exception: a = []
sys.exit(0 if sys.argv[1] in a else 1)`;
const PY_RECEIPT = `
import json, sys
try: d = json.load(sys.stdin)
except Exception: raise SystemExit
print("\\x1f".join(str(d.get(k, "")) for k in
      ("status", "id", "path", "delivery", "error_class", "action", "detail")))
`;
const PY_CLASSIFY = `
import re, sys
norm = re.sub(r"\\s+", " ", sys.stdin.read())
m = re.search(
    r"hit your session limit\\s*\\W*\\s*resets\\s+(\\d{1,2}:\\d{2}\\s*[ap]m)\\s*\\(([^)]+)\\)",
    norm, re.IGNORECASE)
if m:
    print("session_limit\\t%s\\t%s" % (m.group(1).strip(), m.group(2).strip()))
    sys.exit(0)
if re.search(r"terminated early due to an api error", norm, re.IGNORECASE):
    print("api_error\\t\\t")
`;
const PY_RESET = `
import re, sys
from datetime import datetime, timedelta
try:
    from zoneinfo import ZoneInfo
except ImportError:
    print(0); sys.exit(0)
time_s, tz_s, now_s = sys.argv[1], sys.argv[2], int(sys.argv[3])
m = re.match(r"(\\d{1,2}):(\\d{2})\\s*([ap])m", time_s.strip(), re.IGNORECASE)
if not m:
    print(0); sys.exit(0)
hour = int(m.group(1)) % 12
if m.group(3).lower() == "p":
    hour += 12
minute = int(m.group(2))
try:
    tz = ZoneInfo(tz_s.strip())
except Exception:
    print(0); sys.exit(0)
now_dt = datetime.fromtimestamp(now_s, tz)
candidate = now_dt.replace(hour=hour, minute=minute, second=0, microsecond=0)
if candidate <= now_dt:
    candidate += timedelta(days=1)
print(int(candidate.timestamp()))
`;

// One interpreter, every case: argv and stdin swapped per case, stdout captured
// through a strict UTF-8 encoder (an operator locale's stdout: a lone surrogate
// raises there as it did in the tick), SystemExit read as the status it carried.
const DRIVER = `
import io, json, sys, traceback
cases = json.load(sys.stdin)
real_stdout = sys.stdout
results = []
for c in cases:
    sys.argv = ["-c"] + c["argv"]
    sys.stdin = io.StringIO(c.get("stdin", ""))
    buf = io.BytesIO()
    out = io.TextIOWrapper(buf, encoding="utf-8", errors="strict", newline="\\n")
    sys.stdout = out
    rc = 0; err = ""
    try:
        exec(compile(c["prog"], "<string>", "exec"), {"__name__": "__main__"})
    except SystemExit as e:
        code = e.code
        rc = 0 if code is None else code if isinstance(code, int) else 1
    except BaseException as e:
        rc = 1; err = type(e).__name__ + ": " + str(e)
    finally:
        try: out.flush()
        except Exception as e:
            rc = 1; err = err or (type(e).__name__ + ": " + str(e))
        sys.stdout = real_stdout
    results.append({"out": buf.getvalue().decode("utf-8", "replace"), "rc": rc, "err": err})
json.dump(results, real_stdout)
`;

interface Case { prog: string; argv: string[]; stdin?: string }
interface Result { out: string; rc: number; err: string }

function runPython(cases: Case[]): Result[] {
  const r = spawnSync("python3", ["-B", "-c", DRIVER], { input: JSON.stringify(cases), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`python driver failed (${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout) as Result[];
}

/** The port's answer in the driver's shape: stdout with print's newline, status, and a thrown error's message. */
function port(fn: () => string | null, exitCode?: (v: string | null) => number): Result {
  try {
    const v = fn();
    return { out: v === null ? "" : `${v}\n`, rc: exitCode ? exitCode(v) : 0, err: "" };
  } catch (error) {
    return { out: "", rc: 1, err: (error as Error).message };
  }
}

/** Compare stdout and status; a python raise is matched by a port throw (the texts differ by design: R1). */
function same(got: Result, want: Result, label: string): void {
  expect(got.rc, `${label}: exit status (python: ${want.err || "ok"})`).toBe(want.rc);
  expect(got.out, `${label}: stdout`).toBe(want.out);
  if (want.rc === 1 && want.err) expect(got.err, `${label}: the port threw where python raised`).not.toBe("");
}

// --- :663 the registry's active rows -------------------------------------------------------

describe(":663 the registry's active rows", () => {
  // a doc given as bytes is written raw (python opened the file itself, strictly); a
  // doc given as a directory name is a directory
  const docs: Record<string, string | null | Buffer | "<dir>"> = {
    missing: null,
    "a directory": "<dir>",
    "a byte that is not utf-8": Buffer.from([0x7b, 0x22, 0x73, 0x65, 0x61, 0x74, 0x73, 0x22, 0x3a, 0x7b, 0x22, 0xff, 0x22, 0x3a, 0x7b, 0x7d, 0x7d, 0x7d]), // {"seats":{"\xff":{}}}
    "utf-8 bytes": Buffer.from("{\"schema\":\"0.20\",\"seats\":{\"h\u00e9\":{\"pane\":\"\u00e9\"}}}", "utf8"),
    empty: "",
    "not json": "not json",
    "bom": "\ufeff{}",
    // python's `open()` kept the mark and `json.load` refused the document: no rows,
    // however many seats follow it (a decoder that strips it would roster them)
    "bom before an active seat": "\ufeff{\"seats\":{\"actor\":{\"pane\":\"%42\",\"harness\":\"codex\"}}}",
    "bom before an active seat, as bytes": Buffer.from("\ufeff{\"seats\":{\"actor\":{\"pane\":\"%42\",\"harness\":\"codex\"}}}", "utf8"),
    "list": "[]",
    "string": "\"x\"",
    "status filter": "{\"schema\": \"0.20\", \"seats\": {\"a\": {}, \"b\": {\"status\": \"active\"}, \"c\": {\"status\": \"suspended\"}, \"d\": {\"status\": null}, \"e\": {\"status\": \"Active\"}, \"f\": {\"status\": 0}}}",
    "every scalar": "{\"schema\": \"0.20\", \"seats\": {\"a\": {\"status\": \"active\", \"delivery\": null, \"pane\": 0, \"pane_id\": false, \"session\": [], \"registered_at\": {}, \"server_epoch\": true, \"boot_id\": 5, \"harness\": 1.5, \"status_reason\": 1e16}}}",
    "delivery absent vs null": "{\"schema\": \"0.20\", \"seats\": {\"a\": {\"pane\": \"p\"}, \"b\": {\"delivery\": null, \"pane\": \"p\"}, \"c\": {\"delivery\": \"poll\"}}}",
    "containers": "{\"schema\": \"0.20\", \"seats\": {\"a\": {\"pane\": [1, \"a\", null, true], \"pane_id\": {\"k\": null, \"z\": [1.0]}, \"session\": \"it's \\\"q\\\"\"}}}",
    "big ints and floats": "{\"schema\": \"0.20\", \"seats\": {\"a\": {\"registered_at\": 9007199254740993, \"server_epoch\": -0.0, \"boot_id\": 1e400, \"pane\": 0.1}}}",
    "nan": "{\"schema\": \"0.20\", \"seats\": {\"a\": {\"pane\": NaN, \"pane_id\": -Infinity}}}",
    "unicode": "{\"schema\": \"0.20\", \"seats\": {\"h\u00e9\": {\"pane\": \"\u3000\ufeffx\", \"pane_id\": \"\\u00e9\\ud83d\\ude00\"}}}",
    "duplicate keys": "{\"schema\": \"0.20\", \"seats\": {\"a\": {\"pane\": \"first\"}, \"b\": {}, \"a\": {\"pane\": \"last\"}}}",
    "newline in a field": "{\"schema\": \"0.20\", \"seats\": {\"a\": {\"pane\": \"x\\ny\", \"pane_id\": \"t\\x1fu\"}}}".replace("\\x1f", "\\u001f"),
    "lone surrogate stops the roster": "{\"schema\": \"0.20\", \"seats\": {\"a\": {\"pane\": \"ok\"}, \"b\": {\"pane\": \"\\ud800\"}, \"c\": {\"pane\": \"after\"}}}",
    "lone surrogate handle": "{\"schema\": \"0.20\", \"seats\": {\"\\udc80\": {\"pane\": \"ok\"}}}",
    "escaped surrogate pair is fine": "{\"schema\": \"0.20\", \"seats\": {\"a\": {\"pane\": \"\\ud83d\\ude00\"}}}",
    "trailing garbage": "{\"schema\": \"0.20\", \"seats\": {}} x",
  };
  const scratch = mkdtempSync(join(tmpdir(), "watch-tick-rows."));
  const names = Object.keys(docs);
  const paths: Record<string, string> = {};
  for (const name of names) {
    const doc = docs[name] ?? null;
    const path = join(scratch, `${names.indexOf(name)}.json`);
    paths[name] = path;
    if (doc === "<dir>") mkdirSync(path);
    else if (doc !== null) writeFileSync(path, doc);
  }
  const want = rowGolden;
  expect(want.length).toBe(names.length);
  // the port reads the same file the same way the CLI does, before the scratch goes
  const texts: Record<string, string | null> = {};
  for (const name of names) texts[name] = readRegistryText(paths[name]!);
  removeScratchTree(scratch);
  for (const [i, name] of names.entries()) {
    test(name, () => {
      const got = port(() => {
        const r = activeSeatRows(texts[name] ?? null);
        const printed = r.rows.map((row) => `${row.join("\x1f")}\n`).join("");
        if (r.error !== null) throw Object.assign(new Error(r.error), { printed });
        return printed === "" ? null : printed.slice(0, -1);
      });
      const w = want[i]!;
      if (w.rc === 1) {
        // partial roster then the raise: python printed the rows before it
        expect(got.rc, `${name}: status`).toBe(1);
        expect(w.err, `${name}: python raised on the encode`).toContain("surrogates not allowed");
        const r = activeSeatRows(texts[name] ?? null);
        expect(r.rows.map((row) => `${row.join("\x1f")}\n`).join(""), `${name}: the rows before the raise`).toBe(w.out);
        return;
      }
      same(got, w, name);
    });
  }
  // Old formats leave the parity table on both sides (C4b): python's _seat_map raises
  // OldStoreError at the accessor, while every Bun caller holds an acting pin that refused the
  // store first, so the pure Bun reader never sees one and never turns an agents map into rows.
  test("an old-format document is never rows (seats-only)", () => {
    for (const doc of [
      "{\"seats\": null, \"agents\": {\"a\": {\"pane\": \"p\"}}}",
      "{\"seats\": [1], \"agents\": {\"a\": {\"pane\": \"p\"}}}",
      "{\"agents\": {\"a\": {\"pane\": \"p\", \"harness\": \"claude\"}}}",
      "{\"seats\": {}, \"agents\": {\"a\": {\"pane\": \"p\"}}}",
      "{\"team\": {\"name\": \"t\"}}",
      "{\"team\": {\"seats\": {\"a\": {}}}}",
    ]) expect(activeSeatRows(doc)).toEqual({ rows: [], error: null });
  });
});

// --- :814 the activity floor -----------------------------------------------------------------

describe(":814 the activity floor", () => {
  const rows: string[][] = [
    ["2000", "1000"],
    ["2000", "1000", "1500", "1700", "1600"],
    ["2000", "1000", "2500"],           // clamped to now
    ["2000", "1000", "", "abc", "1.5", "1e3", "0x10", "1_500", " 1 800 ", " 1700 ", "\u0663\u0660\u0660", "+1900", "-5", "12345678901234567890"],
    ["2000", "3000", "2500"],           // floor above now: best stays the floor, real is clamped
    ["2000", "1000", "500"],
    ["2000", "-100", "-50"],
    ["0", "0"],
    ["-5", "-10", "-7", "-3"],
    ["2000", "1000", "\ufeff1500", "1500\u200b", "\x1c1500"],
    ["2000", "1000", "٣٠٠٠"],
    ["abc", "1000"],                    // int(now) raised
    ["2000", "", "1500"],               // int(floor) raised
    ["2000", "1_000", "1_500"],
    ["2000", " 1000 ", "1500"],
  ];
  const want = runPython(rows.map((argv) => ({ prog: PY_FLOOR, argv })));
  for (const [i, argv] of rows.entries()) {
    test(JSON.stringify(argv), () => {
      same(port(() => activityFloor(argv[0]!, argv[1]!, argv.slice(2))), want[i]!, JSON.stringify(argv));
    });
  }
});

// --- the set programs -------------------------------------------------------------------------

/** Rows the port refuses where python evaluated (R2b class): python's answer is recorded here. */
const REFUSED: Record<string, { python: string }> = {
  "skip [1,2] vs []": { python: "[1,2]\n" },
  "skip [true,1] vs []": { python: "[true]\n" },
  "skip [null] vs []": { python: "[null]\n" },
  "skip [1.5] vs []": { python: "[1.5]\n" },
  "wedge [1] - {} - []": { python: "1\n" },
  "wedge [1] - {} - [1]": { python: "0\n" },
};
const refusedSeen: string[] = [];

describe(":888 the blocked map's keys", () => {
  const maps = ["", "{}", "{\"a\":1,\"b\":2}", "{\"b\":{},\"a\":null}", "{\"\u00e9\":1,\"42\":2,\"a\":3}", "{\"a\":1,\"a\":2,\"b\":3}", "[]", "[1]", "not json", "null", "\"s\"", "5", "{\"a\\ud83d\\ude00\":1}", "{\"x\\u0000y\":1}"];
  const want = runPython(maps.map((m) => ({ prog: PY_BLOCKED_KEYS, argv: [m] })));
  for (const [i, m] of maps.entries()) {
    test(JSON.stringify(m), () => { same(port(() => blockedKeysJson(m)), want[i]!, m); });
  }
});

describe(":893 the rung skip-set", () => {
  const rows: [string, string, string][] = [
    ["", "", ""],
    ["[\"b\",\"a\"]", "[\"c\"]", "d\ne\n"],
    ["[\"b\",\"a\",\"a\"]", "[\"a\"]", "a\n\nb"],
    ["[\"\u00e9\",\"z\",\"\u3000\",\"\ud83d\ude00\",\"\uffff\"]", "[]", ""],   // code-point order, ensure_ascii
    ["[\"Z\",\"a\",\"A\",\"z\",\"10\",\"9\"]", "[]", ""],
    ["{\"k\":1,\"j\":2}", "{\"i\":null}", "h"],                              // dicts: their keys
    ["\"abc\"", "\"ba\"", ""],                                                // strings: their code points
    ["\"\ud83d\ude00a\"", "", ""],
    ["not json", "[]", ""],                                                   // bare loads raised
    ["[]", "not json", ""],
    ["null", "[]", ""],                                                       // not iterable
    ["5", "[]", ""],
    ["[]", "true", ""],
    ["[1,2]", "[]", ""],                                                      // REFUSED: python sorted ints
    ["[true,1]", "[]", ""],                                                   // REFUSED: True == 1 in a set
    ["[null]", "[]", ""],
    ["[1.5]", "[]", ""],
    ["[[1]]", "[]", ""],                                                      // unhashable: raised in both
    ["[\"a\",1]", "[]", ""],                                                  // str < int raised in python's sort; refused here
    ["[\"a\"]", "[\"a\"]", "a\r\n"],                                          // \r is not a line break
    ["[\" a\"]", "[]", " a\na \n"],
  ];
  const want = runPython(rows.map((argv) => ({ prog: PY_SKIP, argv })));
  for (const [i, argv] of rows.entries()) {
    const label = `skip ${argv[0]} vs ${argv[1]}`;
    test(JSON.stringify(argv), () => {
      const got = port(() => skipSetJson(argv[0], argv[1], argv[2]));
      if (label in REFUSED) {
        refusedSeen.push(label);
        expect(want[i]!.out, `${label}: python's answer on record`).toBe(REFUSED[label]!.python);
        expect(want[i]!.rc).toBe(0);
        expect(got.rc, `${label}: the port refuses`).toBe(1);
        expect(got.err).toMatch(/where a handle was expected/);
        return;
      }
      same(got, want[i]!, label);
    });
  }
});

describe(":912 a real wedge outside the blocked and exempt sets", () => {
  const rows: [string, string, string][] = [
    ["", "", ""],
    ["[\"a\"]", "{}", "[]"],
    ["[\"a\"]", "{\"a\":{}}", "[]"],
    ["[\"a\"]", "{}", "[\"a\"]"],
    ["[\"a\",\"b\"]", "{\"a\":{}}", "[\"b\"]"],
    ["[\"a\",\"b\"]", "{\"a\":{}}", "[\"c\"]"],
    ["{\"a\":1}", "[\"a\"]", "\"a\""],
    ["\"ab\"", "\"a\"", "[]"],
    ["not json", "{}", "[]"],
    ["[]", "5", "[]"],
    ["[1]", "{}", "[]"],        // REFUSED
    ["[1]", "{}", "[1]"],       // REFUSED
    ["[[1]]", "{}", "[]"],      // unhashable in both
  ];
  const want = runPython(rows.map((argv) => ({ prog: PY_WEDGE, argv })));
  for (const [i, argv] of rows.entries()) {
    const label = `wedge ${argv[0]} - ${argv[1]} - ${argv[2]}`;
    test(JSON.stringify(argv), () => {
      const got = port(() => realWedge(argv[0], argv[1], argv[2]));
      if (label in REFUSED) {
        refusedSeen.push(label);
        expect(want[i]!.out, `${label}: python's answer on record`).toBe(REFUSED[label]!.python);
        expect(got.rc, `${label}: the port refuses`).toBe(1);
        return;
      }
      same(got, want[i]!, label);
    });
  }
});

describe(":951 is the rung exempt (exit status)", () => {
  const rows: [string, string][] = [
    ["a", ""], ["a", "[]"], ["a", "[\"a\"]"], ["a", "[\"b\",\"a\"]"], ["a", "[\"A\"]"],
    ["a", "{\"a\":0}"], ["a", "{\"b\":\"a\"}"],
    ["a", "\"xaz\""], ["ab", "\"xaz\""], ["a", "\"\""],                  // a string: substring
    ["a", "[1,\"a\"]"], ["1", "[1]"], ["a", "[null]"],
    ["a", "not json"], ["a", "5"], ["a", "null"], ["a", "true"],      // not iterable: status 1
    ["\u00e9", "[\"\\u00e9\"]"], ["\ud83d\ude00", "\"x\ud83d\ude00\""],
  ];
  const want = runPython(rows.map((argv) => ({ prog: PY_EXEMPT, argv })));
  for (const [i, argv] of rows.entries()) {
    test(JSON.stringify(argv), () => {
      const got = isExempt(argv[0], argv[1]) ? 0 : 1;
      expect(got, `${JSON.stringify(argv)}: status (python: ${want[i]!.err || "ok"})`).toBe(want[i]!.rc);
      expect(want[i]!.out).toBe("");
    });
  }
});

// --- :193 the probe courier's receipt ---------------------------------------------------------

describe(":193 the probe courier's receipt", () => {
  const inputs = [
    "",
    "not json",
    "[]",
    "null",
    "\"s\"",
    "{}",
    "{\"status\":\"injected\",\"id\":\"x1\",\"path\":\"/p\",\"delivery\":\"pane\"}",
    "{\"status\":\"queued\",\"id\":\"x1\",\"path\":\"/p\",\"delivery\":\"spool\",\"error_class\":\"\",\"action\":\"\",\"detail\":\"\"}",
    "{\"status\":null,\"id\":5,\"path\":1.5,\"delivery\":true,\"error_class\":[\"a\",null],\"action\":{\"k\":\"v\"},\"detail\":\"it's \\\"q\\\"\\n\"}",
    "{\"status\":\"\u00e9\\ud83d\\ude00\",\"extra\":1}",
    "{\"status\":\"a\",\"status\":\"b\"}",
    " {\"status\":\"a\"} \n",
    "{\"detail\":9007199254740993,\"action\":1e400,\"path\":-0.0}",
    "{\"status\":\"a\"} trailing",
  ];
  const want = runPython(inputs.map((stdin) => ({ prog: PY_RECEIPT, argv: [], stdin })));
  for (const [i, stdin] of inputs.entries()) {
    test(JSON.stringify(stdin), () => {
      // the call site: `parsed="$(printf '%s' "$stdout" | python3 ... 2>/dev/null || true)"` -- the
      // status is swallowed and the traceback discarded, so a readable non-dict (python: `.get` on
      // a list raised) is "" to the tick exactly as an unreadable one is; only stdout is the answer
      const got = port(() => probeReceipt(stdin) || null);
      const w = want[i]!;
      expect(got.out, `${JSON.stringify(stdin)}: stdout`).toBe(w.out);
      expect(got.rc).toBe(0);
      if (w.rc !== 0) expect(w.err).toMatch(/object has no attribute 'get'/);
    });
  }
});

// --- :276 the blocked-banner ladder -----------------------------------------------------------

describe(":276 the blocked-banner ladder", () => {
  const inputs = [
    "",
    "just working\n",
    "You've hit your session limit · resets 3:00pm (America/Los_Angeles)\n",
    "You've hit your session limit. Resets 11:30 AM (UTC).",
    "you've HIT YOUR SESSION LIMIT\n\n  —  resets\t7:05am\n(Europe/London) more",
    "hit your session limit resets 3:00pm (America/Los_Angeles",           // no closing paren
    "hit your session limit resets 3pm (America/Los_Angeles)",             // minutes required
    "hit your session limit resets 3:00pm ()",                             // empty tz
    "hit your session limit resets 3:00pm (  US/Pacific  )",               // stripped
    "hit your session limit resets \u0663:\u0660\u0660pm (Asia/Kolkata)",  // unicode digits
    "hit your session limit resets 3:00pm (Pacific/\u00c5land)",
    "hit your session limit\u00a0\u00b7\u00a0resets\u30003:00pm\u2003(America/Los_Angeles)", // unicode spaces
    "hit your session limit\ufeff resets 3:00pm (UTC)",                    // a BOM is not whitespace nor \W... it is \W
    "hit your session limit\u200b resets 3:00pm (UTC)",
    "hit your session limit resets 3:00\x1cpm (UTC)",                    // \x1c IS python whitespace: collapsed into the clause
    "hit your session limit resets 3:00\ufeffpm (UTC)",                  // a BOM is NOT: no clause
    "hit your session limit resets 3:00\x85pm (UTC\xa0)",
    "Hit your \u017fession limit resets 3:00pm (UTC)",                     // long s folds to s under IGNORECASE
    "H\u0131t your sess\u0131on l\u0131m\u0131t resets 3:00pm (UTC)",     // dotless i: python's lowercase mapping matches `i`, JS's folding does not
    "H\u0130t your session limit resets 3:00pm (UTC)",                      // dotted capital I: likewise
    "Term\u0131nated early due to an API error\n",
    "TERM\u0130NATED EARLY DUE TO AN AP\u0130 ERROR",
    "hit your session limit resets 3:00pm (\u0130stanbul)",                 // the zone's own letters are not folded
    "hit your session limit resets 3:00\u212am (UTC)",                     // Kelvin sign is not a/p
    "hit your session limit resets 3:00Pm (UTC)",
    "hit your session limit resets 3:00pm (UTC) and Terminated early due to an API error",
    "Terminated early due to an API error\nhit your session limit resets 3:00pm (UTC)",
    "terminated   early\ndue to an api\terror",
    "terminated early due to an api error.",
    "hit your session limit resets 123:00pm (UTC)",                       // \d{1,2} then ':' -- 23:00 matches inside
    "hit your session limit resets 3:00pm (a)b)",
    "hit your session limit resets 3:00pm (\nUTC\n)",
    "hit your session limit resets 3:00pm (UTC\x00)",
  ];
  const want = runPython(inputs.map((stdin) => ({ prog: PY_CLASSIFY, argv: [], stdin })));
  for (const [i, stdin] of inputs.entries()) {
    test(JSON.stringify(stdin), () => {
      same(port(() => classifyBlockedTranscript(stdin) || null), want[i]!, stdin);
    });
  }
});

// --- :294 the reset epoch ---------------------------------------------------------------------

describe(":294 the reset epoch", () => {
  // Los Angeles 2026: spring forward 2026-03-08 10:00Z (02:00 PST -> 03:00 PDT),
  // fall back 2026-11-01 09:00Z (02:00 PDT -> 01:00 PST). Lord Howe shifts by 30 min.
  const nows = [
    "1789649600",              // 2026-09-17 ordinary
    "1772963999",              // 2026-03-08 09:59:59Z: 01:59:59 PST, the second before the gap
    "1772964000",              // 10:00:00Z: 03:00:00 PDT
    "1793521800",              // 2026-11-01 08:30Z: 01:30 PDT, first occurrence (fold 0)
    "1793525400",              // 09:30Z: 01:30 PST, second occurrence (fold 1)
    "1793519400",              // 07:50Z: 00:50 PDT
    "1793524200",              // 09:10Z: 01:10 PST, the second time round (fold 1) -- a 1:30am clause keeps the fold
    "0", "-1", "86399", "-86400",
    "253402300799",            // 9999-12-31T23:59:59Z: the last representable instant
    "253402214399",            // one day before it
    "-62135596800",            // 0001-01-01T00:00:00Z
    "-62135510400",
    "300000000000",            // past the range: raised
    "abc", "", " 1789700000 ", "1_789_700_000",
  ];
  const times = ["3:00pm", "12:00am", "12:30PM", "2:30am", "1:30am", "01:05 am", "99:99pm", " 7:05 am ", "\u0663:\u0660\u0660pm", "3pm", "", "3:00 xm", "3:00pmz"];
  const zones = [
    "America/Los_Angeles", "UTC", "Etc/GMT+5", "Etc/GMT-14", "Asia/Kolkata", "Australia/Lord_Howe", "Europe/London", "Pacific/Apia",
    " UTC ", "Nope/Zone", "", "../etc", "/etc/localtime", "Etc/UTC", "America/Argentina/Buenos_Aires", "Pacific Time",
  ];
  // not in the grid: a key in the wrong case (`utc`, `zulu`), `localtime`, and the
  // database's `backward` links (`US/Pacific`, `Zulu`, `EST5EDT`, `GMT`). Python's
  // answer to those was the HOST's -- `utc` found on macOS's case-insensitive
  // filesystem and refused on the gate's Linux; `localtime` a file glibc ships and
  // macOS does not; the links present wherever tzdata ships whole and absent where a
  // distribution splits them out (Debian's `tzdata-legacy`) -- so a differential row
  // would assert a property of the machine. The port refuses the wrong case and
  // `localtime` wherever Intl does, which is everywhere, and accepts the links in
  // their own spelling, as the database does (`zoneOf` test below).
  const rows: [string, string, string][] = [];
  // the full time x zone grid at one ordinary instant, then every instant at the two
  // clauses that walk through the transitions, then the zone list at two instants
  for (const t of times) for (const z of zones.slice(0, 8)) rows.push([t, z, nows[0]!]);
  for (const n of nows) for (const t of ["2:30am", "1:30am", "3:00pm", "11:59pm"]) rows.push([t, "America/Los_Angeles", n]);
  for (const n of [nows[1]!, nows[4]!]) for (const z of zones) rows.push(["2:30am", z, n]);
  for (const n of [nows[10]!, nows[11]!, nows[12]!, nows[13]!]) for (const z of ["UTC", "Etc/GMT-14", "Etc/GMT+12", "Asia/Kolkata"]) rows.push(["11:59pm", z, n]);
  // a half-hour DST step (Lord Howe, 2026-04-05 02:00 -> 01:30 and 2026-10-04 02:00 -> 02:30): the clauses at and around the fold
  for (const n of ["1775314799", "1775314800", "1791041399", "1791041400"]) for (const t of ["1:30am", "1:45am", "2:00am", "2:15am", "2:30am"]) rows.push([t, "Australia/Lord_Howe", n]);
  // a skipped DAY (Samoa crossed the date line: 2011-12-29 23:59:59 -10:00 is followed by 2011-12-31 00:00:00 +14:00)
  for (const n of ["1325239199", "1325239200"]) for (const t of ["12:10am", "11:59pm", "3:00pm"]) rows.push([t, "Pacific/Apia", n]);
  const want = runPython(rows.map((argv) => ({ prog: PY_RESET, argv })));
  const disagreements: string[] = [];
  for (const [i, argv] of rows.entries()) {
    test(JSON.stringify(argv), () => {
      const got = port(() => parseResetEpoch(argv[0], argv[1], argv[2]));
      const w = want[i]!;
      if (got.out !== w.out || got.rc !== w.rc) disagreements.push(`${JSON.stringify(argv)}: python ${JSON.stringify(w.out)}/${w.rc} port ${JSON.stringify(got.out)}/${got.rc} ${got.err}`);
      same(got, w, JSON.stringify(argv));
    });
  }
  test("every zone in the corpus resolved the same way on both sides (Intl's database vs python's)", () => {
    expect(disagreements).toEqual([]);
    expect(rows.length).toBeGreaterThan(150);
  });
  test("zoneOf: the fold and the two-way wall-clock mapping", () => {
    const la = zoneOf("America/Los_Angeles")!;
    expect(la.fold(1793521800n)).toBe(0);   // 01:30 PDT
    expect(la.fold(1793525400n)).toBe(1);   // 01:30 PST, the second time round
    expect(la.wall(1793521800n)).toBe(la.wall(1793525400n));
    const wall = la.wall(1793521800n);
    expect(la.epoch(wall, 0)).toBe(1793521800n);
    expect(la.epoch(wall, 1)).toBe(1793525400n);
    // the gap: 02:30 on 2026-03-08 never happened; fold 0 resolves with the offset before the transition (PST, so 03:30 PDT)
    const gapWall = la.wall(1772963999n) + 31n * 60n; // 01:59:59 PST + 31 min = 02:30:59 on the wall
    expect(la.epoch(gapWall, 0)).toBe(1772963999n + 31n * 60n);
    expect(la.epoch(gapWall, 1)).toBe(1772963999n + 31n * 60n - 3600n);
    expect(zoneOf("Nope/Zone")).toBeNull();
    // a key only in the database's own casing: what python did on a case-sensitive filesystem
    expect(zoneOf("UTC")).not.toBeNull();
    expect(zoneOf("utc")).toBeNull();
    expect(zoneOf("zulu")).toBeNull();
    expect(zoneOf("america/los_angeles")).toBeNull();
    expect(zoneOf("localtime")).toBeNull();
    // the database's `backward` links, accepted as the database spells them and resolving as their targets
    for (const [link, target] of [["US/Pacific", "America/Los_Angeles"], ["Zulu", "UTC"], ["EST5EDT", "America/New_York"], ["GMT", "Etc/GMT"]] as const) {
      const z = zoneOf(link);
      expect(z, link).not.toBeNull();
      expect(z!.wall(1793521800n), link).toBe(zoneOf(target)!.wall(1793521800n));
      expect(z!.fold(1793525400n), link).toBe(zoneOf(target)!.fold(1793525400n));
    }
    expect(zoneOf("")).toBeNull();
  });
});

describe("the refused rows are exactly the enumerated ones", () => {
  test("enumeration", () => {
    expect(refusedSeen.sort()).toEqual(Object.keys(REFUSED).sort());
  });
});
