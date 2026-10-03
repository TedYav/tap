// The pure rules of watch-evaluate.ts against the python programs they replace,
// RUN verbatim (lifted from tap-watch.sh at the W2b base) through python3 on the
// same inputs and compared byte-for-byte, including where python exited non-zero.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hasUnsettled, nextUnprobed, normField, normalizeVerdict, probedAppend, pyJsonTool, renderEvaluatorPrompt } from "../src/watch-evaluate";
import { removeScratchTree } from "./support/scratch";

function py(program: string, argv: string[], stdin = ""): { out: string; err: string; status: number | null } {
  const r = spawnSync("python3", ["-B", "-c", program, ...argv], { input: stdin, encoding: "utf8" });
  return { out: r.stdout, err: r.stderr, status: r.status };
}

const PY_NORMALIZE = `
import json, sys
raw, out = sys.argv[1:3]
ALLOW = {"advance", "notify human", "disarm"}
try:
    data = json.load(open(raw, encoding="utf-8"))
except Exception:
    sys.exit(2)
if not isinstance(data, dict):
    sys.exit(2)
verdict = data.get("verdict")
if verdict not in {"done", "not_done", "blocked"}:
    sys.exit(2)
action = data.get("action")
if action and action not in ALLOW:
    sys.exit(2)
orig_verdict = verdict
evidence = data.get("evidence") or []
if not isinstance(evidence, list):
    evidence = []
reason = str(data.get("reason") or "")

def evidence_lines(items):
    lines = []
    for item in items:
        if not isinstance(item, dict):
            continue
        clause = str(item.get("clause") or "").strip()
        citation = str(item.get("citation") or item.get("source") or "").strip()
        if clause and citation:
            lines.append(f"- {clause}: {citation}")
    return lines

lines = evidence_lines(evidence)
bad_done = False
if verdict == "done":
    if not lines:
        bad_done = True
        reason = reason or "done verdict lacked per-clause observable evidence"
    for line in lines:
        if "transcript:" in line.lower() or line.lower().startswith("- transcript"):
            bad_done = True
            reason = reason or "done verdict cited transcript-only evidence"
if bad_done:
    verdict = "not_done"
    action = "advance"
elif not action:
    action = {"done": "disarm", "blocked": "notify human", "not_done": "advance"}[verdict]

if orig_verdict != "done" and action == "disarm":
    sys.exit(2)
norm = {
    "verdict": verdict,
    "action": action,
    "reason": reason,
    "evidence_text": "\\n".join(lines),
}
json.dump(norm, open(out, "w", encoding="utf-8"), separators=(",", ":"))
sys.exit(0)
`;
const PY_NORM_FIELD = `import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],""))`;
const PY_NEXT = `
import json, sys
try: probed = set(json.loads(sys.argv[1] or "[]"))
except Exception: probed = set()
out = "__human__"
for line in sys.stdin:
    s = line.strip()
    if not s: continue
    if s == "__human__": out = "__human__"; break
    if s not in probed: out = s; break
print(out)`;
const PY_APPEND = `
import json, sys
try: a = json.loads(sys.argv[1] or "[]")
except Exception: a = []
if sys.argv[2] and sys.argv[2] not in a: a.append(sys.argv[2])
print(json.dumps(a, separators=(",", ":")))`;
const PY_HAS_UNSETTLED = `
import glob, os, sys
payloads, receipts = sys.argv[1], sys.argv[2]
SUP = {"probe", "notice", "progress"}
def kind_of(pid):
    try:
        lines = open(os.path.join(payloads, pid + ".md"), encoding="utf-8", errors="replace").readlines()
    except OSError:
        return None
    if not lines or lines[0].strip() != "---":
        return None
    for ln in lines[1:]:
        s = ln.strip()
        if s == "---": break
        if s.startswith("kind:"): return s.split(":", 1)[1].strip()
    return None
for p in glob.glob(os.path.join(payloads, "*.md")):
    b = os.path.basename(p)
    if b.startswith("_"): continue
    pid = b[:-3]
    if kind_of(pid) in SUP: continue
    if not os.path.exists(os.path.join(receipts, pid + ".done")):
        sys.exit(0)
sys.exit(1)`;
const PY_RENDER = `
import sys
template, done_when, observable, transcripts = sys.argv[1:5]
body = open(template, encoding="utf-8").read()
body = body.replace("{{DONE_WHEN}}", done_when or "-")
body = body.replace("{{OBSERVABLE_STATE}}", observable or "-")
body = body.replace("{{TRANSCRIPTS}}", transcripts or "-")
print(body, end="")`;

const scratchRoots: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "watch-evaluate."));
  scratchRoots.push(d);
  return d;
}

const VERDICT_CORPUS = [
  "", "not json", "[]", "null", '"done"', "5",
  '{"verdict":"done"}',
  '{"verdict":"done","evidence":[{"clause":"tests pass","citation":"run 1"}]}',
  '{"verdict":"done","evidence":[{"clause":"tests pass","source":"run 1"}],"reason":"ok"}',
  '{"verdict":"done","evidence":[{"clause":"seen","citation":"transcript: pane"}]}',
  '{"verdict":"done","evidence":[{"clause":"Transcript","citation":"x"}]}',
  '{"verdict":"done","evidence":[{"clause":"a","citation":"b"},{"clause":"transcript","citation":"c"}],"reason":"had"}',
  '{"verdict":"done","evidence":"not a list"}',
  '{"verdict":"done","evidence":[{"clause":" a ","citation":"\\u3000b\\u3000"},"str",{"clause":"","citation":"x"},{"clause":5,"citation":1.5}]}',
  '{"verdict":"not_done"}', '{"verdict":"blocked"}', '{"verdict":"blocked","reason":5}', '{"verdict":"blocked","reason":["r"]}',
  '{"verdict":"not_done","action":"disarm"}', '{"verdict":"blocked","action":"disarm"}', '{"verdict":"done","action":"disarm","evidence":[{"clause":"a","citation":"b"}]}',
  '{"verdict":"done","action":"advance","evidence":[{"clause":"a","citation":"b"}]}',
  '{"verdict":"not_done","action":"nope"}', '{"verdict":"not_done","action":5}', '{"verdict":"not_done","action":""}', '{"verdict":"not_done","action":0}', '{"verdict":"not_done","action":null}',
  // an unhashable action raised at `action not in ALLOW` (a review catch): exit 1, not 2; an empty one is falsy and skipped
  '{"verdict":"not_done","action":["advance"]}', '{"verdict":"blocked","action":{"x":1}}', '{"verdict":"not_done","action":[]}', '{"verdict":"not_done","action":{}}',
  '{"verdict":"maybe"}', '{"verdict":5}', '{"verdict":null}',
  '{"verdict":"done","evidence":[{"clause":"é","citation":"ü"}],"reason":"ñ"}',
  '{"verdict":"not_done","reason":"a\\nb\\tc"}', '{"verdict":"not_done","reason":9007199254740993}', '{"verdict":"not_done","reason":1.0}', '{"verdict":"not_done","reason":true}', '{"verdict":"not_done","reason":{"k":"v"}}',
  '{"verdict":"done","evidence":[{"clause":"İ transcript: x","citation":"y"}]}',
];

describe("normalizeVerdict == _watch_normalize_verdict, every input", () => {
  for (const raw of VERDICT_CORPUS) {
    test(JSON.stringify(raw), () => {
      const d = scratch();
      writeFileSync(join(d, "raw.json"), raw);
      const r = py(PY_NORMALIZE, [join(d, "raw.json"), join(d, "norm.json")]);
      // a thrown TypeError is the program's uncaught exception: exit 1 (its traceback is the R1 line)
      let got: ReturnType<typeof normalizeVerdict>;
      try { got = normalizeVerdict(raw); } catch (error) {
        expect(error).toBeInstanceOf(TypeError);
        expect(r.status, "python raised too").toBe(1);
        expect(r.err, "python's traceback names the same type").toMatch(/TypeError: .*unhashable type/);
        removeScratchTree(d);
        return;
      }
      expect(got.status as number).toBe(r.status ?? -1);
      if (r.status === 0 && got.status === 0) {
        const want = spawnSync("cat", [join(d, "norm.json")], { encoding: "utf8" }).stdout;
        expect(got.norm).toBe(want);
        for (const f of ["verdict", "action", "reason", "evidence_text", "missing"]) {
          expect(`${normField(got.norm, f)}\n`).toBe(py(PY_NORM_FIELD, [join(d, "norm.json"), f]).out);
        }
      }
      removeScratchTree(d);
    });
  }
});

describe("the chain cursor == its programs", () => {
  const PROBED = ["", "[]", "not json", '["a","b"]', '["b"]', '{"a":1}', '"ab"', "null", "5", "[1,\"a\"]", '[["a"]]', '["a",{"b":1}]'];
  const CHAINS = ["", "a\nb\n__human__\n", "\n a \nb\n", "__human__\na\n", "b\na\n", "a\n　\nb", "x"];
  for (const p of PROBED) for (const c of CHAINS) {
    test(`next ${JSON.stringify(p)} over ${JSON.stringify(c)}`, () => {
      expect(`${nextUnprobed(p, c)}\n`).toBe(py(PY_NEXT, [p], c).out);
    });
  }
  for (const p of PROBED) for (const seat of ["a", "c", "", "é", "42"]) {
    test(`append ${JSON.stringify(seat)} to ${JSON.stringify(p)}`, () => {
      const r = py(PY_APPEND, [p, seat]);
      if (r.status !== 0) expect(() => probedAppend(p, seat)).toThrow();
      else expect(`${probedAppend(p, seat)}\n`).toBe(r.out);
    });
  }
});

describe("hasUnsettled == _watch_has_unsettled over payload/receipt trees", () => {
  const shapes: Array<[string, Record<string, string | null>, string[]]> = [
    ["empty", {}, []],
    ["one open order", { "a.md": "---\nid: a\nkind: order\n---\nbody\n" }, []],
    ["one settled order", { "a.md": "---\nid: a\nkind: order\n---\nbody\n" }, ["a"]],
    ["only supervision kinds", { "p.md": "---\nkind: probe\n---\n", "n.md": "---\nkind:notice\n---\n", "g.md": "---\nkind: progress\n---\n" }, []],
    ["kind after the fence is not a kind", { "a.md": "---\nid: a\n---\nkind: probe\n" }, []],
    ["no fence", { "a.md": "id: a\nkind: probe\n" }, []],
    ["draft and dotfile skipped", { "_draft.md": "---\nid: d\n---\n", ".hidden.md": "---\nid: h\n---\n" }, []],
    ["crlf + unicode whitespace", { "a.md": "---\r\n　kind:　probe　\r\n---\r\n" }, []],
    ["unterminated last line", { "a.md": "---\nkind: probe" }, []],
    ["empty file", { "a.md": "" }, []],
    ["fence only", { "a.md": "---" }, []],
    ["missing receipts dir", { "a.md": "---\nkind: order\n---\n" }, ["__no_receipts__"]],
    ["mixed", { "p.md": "---\nkind: probe\n---\n", "o.md": "---\nkind: order\n---\n" }, ["o"]],
    ["mixed open", { "p.md": "---\nkind: probe\n---\n", "o.md": "---\nkind: order\n---\n" }, ["p"]],
  ];
  for (const [name, files, done] of shapes) {
    test(name, () => {
      const d = scratch();
      const payloads = join(d, "payloads");
      const receipts = join(d, "receipts");
      mkdirSync(payloads);
      if (!done.includes("__no_receipts__")) mkdirSync(receipts);
      for (const [n, body] of Object.entries(files)) if (body !== null) writeFileSync(join(payloads, n), body);
      for (const id of done) if (id !== "__no_receipts__") writeFileSync(join(receipts, `${id}.done`), "");
      const r = py(PY_HAS_UNSETTLED, [payloads, receipts]);
      expect(hasUnsettled(payloads, receipts)).toBe(r.status === 0);
      removeScratchTree(d);
    });
  }
  test("a missing payloads dir is 'nothing unsettled'", () => {
    const d = scratch();
    expect(hasUnsettled(join(d, "nope"), join(d, "nope"))).toBe(py(PY_HAS_UNSETTLED, [join(d, "nope"), join(d, "nope")]).status === 0);
    removeScratchTree(d);
  });
});

describe("the prompt render and json.tool", () => {
  test("renderEvaluatorPrompt == the python replace chain, with `or '-'`", () => {
    const d = scratch();
    const template = "A {{DONE_WHEN}} B {{OBSERVABLE_STATE}} C {{TRANSCRIPTS}} D {{DONE_WHEN}}\n";
    writeFileSync(join(d, "t.md"), template);
    for (const [dw, ob, tr] of [["x", "y", "z"], ["", "", ""], ["{{TRANSCRIPTS}}", "é", "\n\n"], ["-", "0", " "]]) {
      expect(renderEvaluatorPrompt(template, dw!, ob!, tr!)).toBe(py(PY_RENDER, [join(d, "t.md"), dw!, ob!, tr!]).out);
    }
    removeScratchTree(d);
  });
  test("pyJsonTool == python3 -m json.tool", () => {
    for (const text of ['{"armed_by":"x","armed_at":9007199254740993,"f":1.0,"l":[1,{"a":[]},{}],"e":{},"u":"é"}', "[]", "{}", '[1,[2,[3]]]', '{"a":{"b":{"c":null}}}']) {
      const r = spawnSync("python3", ["-m", "json.tool"], { input: text, encoding: "utf8" });
      expect(pyJsonTool(text)).toBe(r.stdout);
    }
    expect(() => pyJsonTool("not json")).toThrow();
  });
});
