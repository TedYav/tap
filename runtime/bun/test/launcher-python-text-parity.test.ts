import { expect, test } from "bun:test";
import { pyRepr } from "../src/launcher/resume-identity";

/**
 * Two places the port reproduces a PYTHON text primitive, checked against
 * CPython itself rather than against my reading of it.
 *
 * Both began as unverified review leads and both
 * were real. Neither is reachable from the config-shaped oracle corpus: `pyRepr`
 * needs a `transcript_path` carrying a quote or a control character, and the
 * ordering needs two odd keys in one harness table. So they are asserted here,
 * and asserted DIFFERENTIALLY -- the expected value is whatever the interpreter
 * on this machine prints, not a string I typed believing it was right. A
 * hand-written expectation would have encoded the same misunderstanding that
 * produced the bug.
 */

/** Ask CPython. One process for the whole table; the arms compare rows. */
function cpython(expr: string, values: string[]): string[] {
  const result = Bun.spawnSync(["python3", "-c",
    `import json,sys; print(json.dumps([${expr} for v in json.loads(sys.argv[1])]))`,
    JSON.stringify(values)]);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString());
}

const PATHS = [
  "/t/plain.jsonl",
  "/t/o'brien.jsonl",            // apostrophe: CPython switches to double quotes
  '/t/say-"hi".jsonl',           // double quote only: CPython stays single
  `/t/both-'and-".jsonl`,        // both: CPython stays single and escapes the '
  "/t/back\\slash.jsonl",        // backslash doubles
  "/t/new\nline.jsonl",          // the one that breaks a one-line receipt
  "/t/tab\there.jsonl",
  "/t/carriage\rreturn.jsonl",
  "/t/bell\x07.jsonl",           // C0 -> \x07
  "/t/del\x7f.jsonl",            // DEL -> \x7f
  "/t/nel\x85.jsonl",            // C1 NEXT LINE -> \x85, the class this lane keeps meeting
  "/t/café-ünïcode.jsonl",       // printable non-ASCII stays LITERAL in Python 3
  "/t/emoji-😀.jsonl",
];

test("pyRepr is CPython's repr, over every escaping class a path can carry", () => {
  expect(PATHS.map(pyRepr)).toEqual(cpython("repr(v)", PATHS));
});

test("pyRepr(None) is the bare word, not a quoted one", () => {
  // `harness_session_id` is null on exactly the records the split-brain receipt
  // fires for, so this is the common case rather than an edge one.
  expect(pyRepr(null)).toBe("None");
  expect(pyRepr(undefined)).toBe("None");
});

test("a newline in a path does not split the receipt into two lines", () => {
  // The reason this matters past cosmetics: the receipts go to stderr as one
  // line each, and anything reading stderr line-wise would see a truncated
  // record followed by an orphan fragment.
  const rendered = pyRepr("/t/new\nline.jsonl");
  expect(rendered).not.toContain("\n");
  expect(rendered).toContain("\\n");
});

/**
 * `byCodePoint` is not exported -- it is an implementation detail of the notice
 * loops -- so this asserts the PROPERTY that made it necessary, against both
 * engines, rather than reaching into the module.
 */
test("JS's default sort is NOT Python's, which is why the notice loops do not use it", () => {
  const names = ["\u{1F600}x", "zz", "Ａ"];
  const js = [...names].sort();
  const py = cpython("v", names.slice()).slice();
  const pySorted = JSON.parse(Bun.spawnSync(["python3", "-c",
    "import json,sys; print(json.dumps(sorted(json.loads(sys.argv[1]))))",
    JSON.stringify(names)]).stdout.toString());
  expect(py).toEqual(names);                    // the helper round-trips
  expect(js).not.toEqual(pySorted);             // the divergence is real, not folklore
  expect(pySorted).toEqual(["zz", "Ａ", "\u{1F600}x"]);
  // And the code-point comparator agrees with Python where `.sort()` does not.
  const byCodePoint = (a: string, b: string): number => {
    const x = [...a], y = [...b];
    for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
      const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
      if (d !== 0) return d;
    }
    return x.length - y.length;
  };
  expect([...names].sort(byCodePoint)).toEqual(pySorted);
});
