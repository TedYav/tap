// The pure rules of watch-detect.ts against the python heredocs they replace: each
// rule is RUN through python3 (the incumbent's exact program text, lifted from
// tap-watch.sh at 76aacd95a) on the same inputs and compared byte-for-byte. The
// inputs are the rule-13 corpus for text: BOM, NBSP, U+2000-200A, U+202F, U+205F,
// U+3000, python-only whitespace (\x1c-\x1f, \x85), Unicode digits, exact
// integers past 2^53, integer-like handles, floats that must keep their text.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

import {
  alertAbsent, alertMark, blockedField, blockedKeys, blockedRemove, blockedUpsert, cmdSubst, codexWorkingSeconds,
  collapseSpinner, dumps, freezeStep, hasInk, loads, pressureRemember, pyIntArg, sampleForget, sha256Hex, stripAnsi,
  unicodeInt, withoutWorkingLines,
} from "../src/watch-detect";

/** Run the incumbent's python on argv (and optional stdin); returns stdout + status. */
function py(program: string, argv: string[], stdin = ""): { out: string; status: number | null } {
  const r = spawnSync("python3", ["-B", "-c", program, ...argv], { input: stdin, encoding: "utf8" });
  return { out: r.stdout, status: r.status };
}

// --- the incumbent programs, verbatim ---------------------------------------------

const PY_WORKING = `
import re, sys
text = sys.stdin.read()
m = re.search(r"Working\\s*\\(\\s*(?:(\\d+)h\\s*)?(?:(\\d+)m\\s*)?(?:(\\d+)s\\s*)?[•·-]\\s*esc to interrupt\\s*\\)", text, re.I)
if not m or not any(m.groups()):
    raise SystemExit(0)
h, minute, second = (int(x or 0) for x in m.groups())
print(h * 3600 + minute * 60 + second)
`;

const PY_FORGET = `
import json, sys
try: s = json.loads(sys.argv[1] or "{}")
except Exception: s = {}
s.pop(sys.argv[2], None)
print(json.dumps(s, separators=(",", ":")))
`;

const PY_FREEZE = `
import json, sys
samples_raw, handle, now, h, timer, window, req_adv = sys.argv[1:8]
try: s = json.loads(samples_raw or "{}")
except Exception: s = {}
now = int(now); window = int(window); req_adv = (req_adv == "1")
def as_int(x):
    try: return int(x)
    except Exception: return None
cur = s.get(handle)
fire = 0; frozen = 0
if not isinstance(cur, dict) or cur.get("hash") != h:
    s[handle] = {"at": now, "hash": h, "timer": timer, "fired": 0}
else:
    frozen = now - int(cur.get("at", now))
    advancing = True
    if req_adv:
        t0, t1 = as_int(cur.get("timer")), as_int(timer)
        advancing = (t0 is not None and t1 is not None and t1 > t0)
    if frozen >= window and advancing and not cur.get("fired"):
        fire = 1; cur["fired"] = 1
    cur["timer"] = timer
    s[handle] = cur
print("%d\\t%d" % (fire, frozen))
print(json.dumps(s, separators=(",", ":")))
`;

const PY_BLOCKED_KEYS = `
import json, sys
try: d = json.loads(sys.argv[1] or "{}")
except Exception: d = {}
for h in d: print(h)`;
const PY_BLOCKED_FIELD = `
import json, sys
try: d = json.loads(sys.argv[1] or "{}")
except Exception: d = {}
rec = d.get(sys.argv[2]) or {}
print(rec.get(sys.argv[3], ""))`;
const PY_BLOCKED_UPSERT = `
import json, sys
try: d = json.loads(sys.argv[1] or "{}")
except Exception: d = {}
d[sys.argv[2]] = {"reason": sys.argv[3], "since": int(sys.argv[4]), "reset_at": int(sys.argv[5])}
print(json.dumps(d, separators=(",", ":")))`;
const PY_BLOCKED_REMOVE = `
import json, sys
try: d = json.loads(sys.argv[1] or "{}")
except Exception: d = {}
d.pop(sys.argv[2], None)
print(json.dumps(d, separators=(",", ":")))`;
const PY_PRESSURE = `
import json,sys
rows=json.loads(sys.argv[1]); rows[sys.argv[2]]={'pane':sys.argv[3]}; print(json.dumps(rows))`;
const PY_ALERT_MARK = `
import json, sys
try: alerts = json.loads(sys.argv[1] or "{}")
except Exception: alerts = {}
alerts[sys.argv[2]] = int(sys.argv[3])
print(json.dumps(alerts, separators=(",", ":")))`;
const PY_ALERT_MARK_STRICT = `
import json,sys
s=json.loads(sys.argv[1]);s[sys.argv[2]]=int(sys.argv[3]);print(json.dumps(s,separators=(",",":")))`;
const PY_ALERT_ABSENT = `
import json, sys
try: alerts = json.loads(sys.argv[1] or "{}")
except Exception: alerts = {}
sys.exit(0 if sys.argv[2] not in alerts else 1)`;
const PY_ALERT_ABSENT_STRICT = `
import json,sys
raise SystemExit(0 if sys.argv[2] not in json.loads(sys.argv[1]) else 1)`;
const PY_STRIP_ANSI = `import re, sys
sys.stdout.write(re.sub(r"\\x1b\\[[0-?]*[ -/]*[@-~]", "", sys.stdin.read()))`;

// --- corpus -----------------------------------------------------------------------

const TEXT_CORPUS = [
  "",
  "Working (3s • esc to interrupt)",
  "Working (1h 2m 3s • esc to interrupt)",
  "working ( 5m   · ESC TO INTERRUPT )",
  "Working (2m - esc to interrupt)",
  "Working ( • esc to interrupt)", // no unit at all: python printed nothing
  "Working (12s • esc to interrupt) trailing text\nsecond line",
  "prefix\n\nWorking\t(\v7s\f•\resc to interrupt\t)",
  "Working (\x1c9s\x1d•\x1eesc to interrupt\x1f)", // python \\s includes \\x1c-\\x1f
  "Working (\x8541s\x85•\x85esc to interrupt\x85)", // ... and \\x85
  "Working (﻿8s • esc to interrupt)", // a BOM is NOT python whitespace
  "Working ( 6s •　esc to interrupt )", // NBSP, U+2000, U+3000, U+202F are
  "Working (٣٤s • esc to interrupt)", // Arabic-Indic 34
  "Working (１２m • esc to interrupt)", // fullwidth 12
  "Working (9007199254740993s • esc to interrupt)", // past 2^53
  "Working (0h 0m 0s • esc to interrupt)",
  "Working (3s • esc to interrupt\n)", // \\s spans the newline
  "\x1b[2mWorking (4s • esc to interrupt)\x1b[0m",
  "Working (5s • esc to interrupt) Working (6s • esc to interrupt)", // first match wins
  "Wörking (5s • esc to interrupt)",
];

describe("codexWorkingSeconds == the incumbent regex program", () => {
  for (const text of TEXT_CORPUS) {
    test(JSON.stringify(text), () => {
      const want = py(PY_WORKING, [], text).out;
      const got = codexWorkingSeconds(text);
      expect(got === null ? "" : `${got}\n`).toBe(want);
    });
  }
  test("Unicode decimal digits read as int() reads them", () => {
    expect(unicodeInt("٣٤")).toBe(34n);
    expect(unicodeInt("１２")).toBe(12n);
    expect(unicodeInt("9007199254740993")).toBe(9007199254740993n);
    expect(unicodeInt("𝟛𝟜")).toBe(34n); // mathematical bold digits: contiguous runs past the BMP
  });
});

const MAP_CORPUS = [
  "", "{}", "not json", "[]", '"s"', "null",
  '{"a":{"at":1,"hash":"h","timer":"3","fired":0}}',
  '{"42":{"at":1,"hash":"h","timer":"3","fired":0},"a":{"at":2,"hash":"g","timer":"","fired":1}}', // integer-like key first
  '{"a": {"at": 9007199254740993, "hash": "h", "timer": "3", "fired": 0}}', // default separators in, exact int
  '{"a":{"at":1.0,"hash":"h","timer":"3","fired":0.0}}', // floats keep their text; 0.0 is falsy
  '{"a":{"at":"12","hash":"h","timer":"x","fired":""}}', // int("12") ok; "x" is None; "" is falsy
  '{"a":{"at":1,"hash":"h","timer":" 3 ","fired":[]}}', // int(" 3 ") == 3; [] is falsy
  '{"\\u00e9":{"at":1,"hash":"h","timer":"3","fired":true},"b\\ud83d\\ude00":{"at":1,"hash":"h","timer":"3","fired":null}}', // ensure_ascii on the way out
  '{"a":{"hash":"h","timer":"3"}}', // no at -> now; no fired -> falsy
  '{"a":"scalar"}', // not a dict -> rebaseline
  '{"a":{"at":"bad","hash":"h"}}', // int("bad") RAISES
  '{"a":{"at":-0.0,"hash":1e-7,"timer":1e-5,"fired":1e16},"b":{"at":1e20,"hash":1e309,"timer":1e21,"fired":0.1}}', // python float repr through a rewrite
  '{"a":{"at":["x",null,true,1.5,"it\'s",{"k":"v\\"}],"hash":{"z":[]},"timer":"a\\nb\\t\\u00e9\\u2028\\ud83d\\ude00","fired":"\\u0007"}}', // str() of containers is repr (P3)
  '{"a":{"at":[NaN,Infinity,-Infinity],"hash":NaN,"timer":"\\u001c399\\u001f","fired":0}}', // repr of non-finite floats; int() refuses \x1c..\x1f in a timer
  '{"a":{"at":1e309,"hash":-1e309,"timer":[1e309],"fired":1e-400}}', // exponent overflow prints inf/-inf; underflow is 0.0 (C1)
];

describe("the freeze state machine == the incumbent program, every input", () => {
  const cases: Array<[string, string, string, string, string, string, string]> = [];
  for (const samples of MAP_CORPUS) {
    for (const [handle, now, hash, timer, window, adv] of [
      ["a", "100", "h", "5", "60", "1"], ["a", "100", "h", "5", "60", "0"], ["a", "100", "g", "5", "60", "1"],
      ["a", "61", "h", "4", "60", "1"], ["a", "61", "h", "3", "60", "1"], ["a", "61", "h", "", "60", "0"],
      ["42", "100", "h", "9007199254740993", "60", "1"], ["b", "7", "h", "1", "0", "1"], ["a", "100", "h", "٣", "60", "1"],
    ] as Array<[string, string, string, string, string, string]>) cases.push([samples, handle, now, hash, timer, window, adv]);
  }
  for (const [samples, handle, now, hash, timer, window, adv] of cases) {
    test(`${JSON.stringify(samples)} ${handle} ${now} ${hash} ${JSON.stringify(timer)} ${window} ${adv}`, () => {
      const want = py(PY_FREEZE, [samples, handle, now, hash, timer, window, adv]);
      if (want.status !== 0) { expect(() => freezeStep(samples, handle, BigInt(now), hash, timer, BigInt(window), adv === "1")).toThrow(); return; }
      const got = freezeStep(samples, handle, BigInt(now), hash, timer, BigInt(window), adv === "1");
      expect(`${got.fire ? 1 : 0}\t${got.frozen}\n${got.samples}\n`).toBe(want.out);
    });
  }
});

describe("the map steps == their programs", () => {
  /** python printed `out` and exited 0, or raised (non-zero, nothing usable): the port prints the same or throws. */
  const same = (want: { out: string; status: number | null }, run: () => string) => {
    if (want.status !== 0) expect(run).toThrow();
    else expect(run()).toBe(want.out);
  };
  for (const m of MAP_CORPUS) {
    test(`forget/keys/field/upsert/remove/mark/absent over ${JSON.stringify(m)}`, () => {
      same(py(PY_FORGET, [m, "a"]), () => `${sampleForget(m, "a")}\n`);
      same(py(PY_BLOCKED_KEYS, [m]), () => blockedKeys(m));
      for (const f of ["at", "hash", "timer", "fired", "missing"]) same(py(PY_BLOCKED_FIELD, [m, "a", f]), () => `${blockedField(m, "a", f)}\n`);
      same(py(PY_BLOCKED_UPSERT, [m, "42", "session_limit", "9007199254740993", " 7 "]), () => `${blockedUpsert(m, "42", "session_limit", "9007199254740993", " 7 ")}\n`);
      same(py(PY_BLOCKED_REMOVE, [m, "a"]), () => `${blockedRemove(m, "a")}\n`);
      same(py(PY_ALERT_MARK, [m, "a:id", "9007199254740993"]), () => `${alertMark(m, "a:id", 9007199254740993n)}\n`);
      same(py(PY_ALERT_MARK_STRICT, [m, "a:id", "9007199254740993"]), () => `${alertMark(m, "a:id", 9007199254740993n, true)}\n`);
      // the absent checks are exit-status programs: 0 absent, 1 present, and a raise is also 1
      const loose = py(PY_ALERT_ABSENT, [m, "a"]).status;
      const strict = py(PY_ALERT_ABSENT_STRICT, [m, "a"]).status;
      let got: boolean | "raised";
      try { got = alertAbsent(m, "a"); } catch { got = "raised"; }
      expect(got === "raised" ? 1 : got ? 0 : 1).toBe(loose ?? -1);
      expect(alertAbsent(m, "a", true) ? 0 : 1).toBe(strict ?? -1);
      same(py(PY_PRESSURE, [m, "42", "%1"]), () => `${pressureRemember(m, "42", "%1")}\n`);
    });
  }
  test("int() of an argv string: sign, surrounding whitespace, underscores, Unicode digits; else raises", () => {
    expect(pyIntArg(" 12 ")).toBe(12n);
    expect(pyIntArg("-7")).toBe(-7n);
    expect(pyIntArg("+7")).toBe(7n);
    expect(pyIntArg("1_000")).toBe(1000n);
    expect(pyIntArg("٣٤")).toBe(34n);
    for (const bad of ["", "1.5", "x", "0x10", "1e3", "1__0", "\x1c399\x1f", "\x1d5", "\u200b5", "\ufeff5", "_5", "5_"]) expect(() => pyIntArg(bad)).toThrow();
    // int()'s whitespace is not str.strip()'s -- measured against python3 here, not assumed
    for (const t of ["\x85399", "\xa0399", "\u2000399\u3000", "\u1680399", "\v399\f", "\u202f5", " 399 ", "\t399\n", "\x1c399\x1f", "\x1e7", "\u200b5", "\ufeff5", "\u2028 9"]) {
      const r = py("import sys; print(int(sys.argv[1]))", [t]);
      if (r.status !== 0) expect(() => pyIntArg(t), JSON.stringify(t)).toThrow();
      else expect(`${pyIntArg(t)}\n`, JSON.stringify(t)).toBe(r.out);
    }
  });
});

describe("shell text helpers", () => {
  test("stripAnsi == the Python strip oracle", () => {
    for (const t of ["", "\x1b[2mdim\x1b[0m", "\x1b[38;5;196mred\x1b[m", "a\x1b[?25lb", "no escapes", "\x1b[Kx\x1b[1;2H"]) {
      expect(stripAnsi(t)).toBe(py(PY_STRIP_ANSI, [], t).out);
    }
  });
  test("sha256Hex == shasum -a 256", () => {
    for (const t of ["", "body\n", "é • ␟", "x".repeat(70000)]) {
      const r = spawnSync("shasum", ["-a", "256"], { input: t, encoding: "utf8" });
      expect(sha256Hex(t)).toBe(r.stdout.split(" ")[0]!);
    }
  });
  test("withoutWorkingLines == grep -vE, including the no-trailing-newline and all-lines-removed shapes", () => {
    for (const t of ["", "\n", "a\nWorking (3s • esc to interrupt)\nb", "a\nWorking (3s • esc to interrupt)\nb\n", "Working (3s • esc to interrupt)", "Working (3s • esc to interrupt)\n", "x\n\n", "Working(3s • esc to interrupt)\n"]) {
      const r = spawnSync("bash", ["-c", "grep -vE 'Working \\(.*esc to interrupt' || true"], { input: t, encoding: "utf8" });
      expect(withoutWorkingLines(t)).toBe(r.stdout);
    }
  });
  test("collapseSpinner == sed -E on this platform", () => {
    for (const t of ["", "\n", "⠋ esc interrupt\nbody", "⠋ esc interrupt\nbody\n", "no spinner", "a esc interrupt b esc interrupt\n"]) {
      const r = spawnSync("bash", ["-c", "sed -E 's/^.*esc interrupt/<spinner> esc interrupt/'"], { input: t, encoding: "utf8" });
      expect(collapseSpinner(t)).toBe(r.stdout);
    }
  });
  test("hasInk == case *[![:space:]]* under the LC_CTYPE lib.sh pins (en_US.UTF-8)", () => {
    const probes = ["", " \t\n", "x", "   ", "\v\f\r", "\x1c", "\x1f", "\x85", "\xa0", "\u1680", "\u180e", "\u2000", "\u2007", "\u200a", "\u200b", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff", " x ", "\u3000x"];
    for (const p of probes) {
      const r = spawnSync("bash", ["-c", 'case "$1" in *[![:space:]]*) exit 0 ;; *) exit 1 ;; esac', "_", p], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", LC_CTYPE: "en_US.UTF-8" } });
      expect(hasInk(p), JSON.stringify(p)).toBe(r.status === 0);
    }
  });
  test("cmdSubst drops every trailing newline and nothing else", () => {
    expect(cmdSubst("a\n\n\n")).toBe("a");
    expect(cmdSubst("\n")).toBe("");
    expect(cmdSubst("a\nb")).toBe("a\nb");
    expect(cmdSubst(" a \n")).toBe(" a ");
  });
});

describe("ordered JSON", () => {
  test("integer-like keys keep their position; exact integers and float text survive; ensure_ascii on output", () => {
    const text = '{"42":1,"a":9007199254740993,"f":1.0,"é":"ü","n":null,"t":true,"l":[1,2.5,"x"]}';
    expect(dumps(loads(text), true)).toBe('{"42":1,"a":9007199254740993,"f":1.0,"\\u00e9":"\\u00fc","n":null,"t":true,"l":[1,2.5,"x"]}');
    expect(dumps(loads(text), false)).toBe(py("import json,sys; print(json.dumps(json.loads(sys.argv[1])))", [text]).out.trimEnd());
  });
  test("accepts NaN, Infinity and -Infinity as json.loads does, and prints them back", () => {
    expect(dumps(loads('{"a":NaN,"b":Infinity,"c":-Infinity}'), true)).toBe('{"a":NaN,"b":Infinity,"c":-Infinity}');
  });
  test("floats print as python prints them (A's pyFloatRepr): -0.0, 1e-06, 1e-07, 1e+16, 1e+20, 1.5, 2.0", () => {
    const text = '{"a":-0.0,"b":1e-6,"c":1e-7,"d":1e16,"e":1e20,"f":1.5,"g":2.0,"h":123456789012345678,"i":0.1,"j":1e-5,"k":1e21,"l":1e309,"m":-1e309,"n":123456789.123456789,"o":5e-324}';
    expect(dumps(loads(text), true)).toBe(py("import json,sys; print(json.dumps(json.loads(sys.argv[1]), separators=(',',':')))", [text]).out.trimEnd());
    expect(dumps(loads(text), false)).toBe(py("import json,sys; print(json.dumps(json.loads(sys.argv[1])))", [text]).out.trimEnd());
  });
  test("refuses what json.loads refuses", () => {
    for (const bad of ["", "{", "{\"a\":}", "[1,]", "{'a':1}", "01", "1.", ".5", "{\"a\":1}x", "\"unterminated", "nan", "-NaN"]) {
      expect(() => loads(bad)).toThrow();
      expect(py("import json,sys; json.loads(sys.argv[1])", [bad]).status).not.toBe(0);
    }
  });
});
