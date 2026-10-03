// The evaluator rung and the chain builder replay the frozen capture of the incumbent
// (fixtures/watch-evaluator-oracle.json, captured from tap-watch.sh at the pinned base
// by the since-retired capture harness): every case's scripted WORLD is offered to the
// Bun runner through a fixture-backed Seams, and the runner's exit status, stdout,
// stderr, ordered effects (lease sets, the model invocation, notices, notifications,
// the finish) and the files it wrote (the prompt, the raw verdict, the normalised
// verdict) must equal what the Bash function did.
//
// Both functions were captured in the CALLING SHAPE the tick uses (`_watch_evaluate ||
// true`, `chain="$(_watch_build_chain ...)"`), so `set -e` never ends the rung: only its
// explicit returns and a fatal expansion error decide its status, as the capture shows.
//
// Deviation classes applied by an explicit per-case table, enumerated at the end:
//   R2. bash's own diagnostics for a non-integer `evaluator_calls` become `tap watch:`
//       lines: `[: x: integer expected` (with the script's path and line) is one line
//       and the rung continues, as before; a fatal arithmetic expansion error (`unbound
//       variable`, `syntax error`, `value too great for base`, `recursion level
//       exceeded`) is a second line, status 1, no effect, as before -- except that the
//       incumbent's fatality killed the whole watcher process, while the runner's
//       status 1 returns to the tick's `|| true` (the ladder continues).
//   R2b. an EXPRESSION-shaped `evaluator_calls` (`1+1`, `(1)`, `--1`) bash evaluated and
//       went on with; the port refuses it like a fatal literal (status 1, no effect).
//   R3. IO diagnostics: `mkdir`'s, the shell's redirection error and python's traceback
//       are the real seams' lines in the port (`tap watch: mkdir: <dir>: EEXIST`, ...),
//       not compared here; status, effects and files are.
//   R1. bash's NUL-byte warning at a `$( )` is not reproduced; the byte is dropped as bash did.

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { realSeams, arithPlusOne, buildChain, evaluate, testInt, type Seams } from "../src/watch-evaluator";
import { removeScratchTree } from "./support/scratch";

interface World {
  lease: Record<string, string>;
  has_unsettled: boolean;
  observable: string;
  transcripts: string;
  invoke_rc: number;
  raw: string;
  lease_current: boolean[];
  notify_rc: number;
  human_rc: number;
  finish_rc: number;
  set_rc: number;
  prompt_dir_blocked: boolean;
  norm_blocked: boolean;
  roster: string[];
  eligible: Record<string, boolean>;
  seat_state: Record<string, string>;
  recency: Record<string, string>;
}

interface Case {
  case: string;
  verb: "evaluate" | "build-chain";
  argv: string[];
  env: Record<string, string>;
  world: World;
  rc: number;
  stdout: string;
  stderr: string;
  effects: string[][];
  files: Record<string, string>;
}

const oracle = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/watch-evaluator-oracle.json"), "utf8")) as { captured_from: { head: string }; cases: Case[] };
const template = readFileSync(join(import.meta.dir, "../../../skills/tap/scripts/watch-templates/evaluate-prompt.md"), "utf8");

const BUS = "<WORK>/bus";

function seamsOf(w: World, effects: string[][], files: Record<string, string>, stderr: string[], discarded: string[] = []): Seams {
  const lease: Record<string, string> = { ...w.lease };
  let leaseCalls = 0;
  const seq = <T>(list: T[], n: number): T => list[Math.min(n, list.length - 1)]!;
  const rel = (p: string): string => p.startsWith(`${BUS}/`) ? p.slice(`${BUS}/`.length) : p;
  return {
    leaseField: (k) => lease[k] ?? "",
    leaseSet: (k, v) => {
      effects.push(["set", k, v]);
      if (w.set_rc === 0) lease[k] = v;
      return w.set_rc;
    },
    leaseCurrent: () => seq(w.lease_current, leaseCalls++),
    hasUnsettled: () => w.has_unsettled,
    now: () => "2000",
    pid: () => "<PID>",
    observableState: () => w.observable,
    transcripts: () => w.transcripts,
    template: () => template,
    // the prompt directory being a regular file: mkdir and the redirection fail, nothing is written
    writePromptPath: (name) => `${BUS}/watch/evaluator-prompts/${name}`,
    writePrompt: (path, text) => { if (!w.prompt_dir_blocked) files[rel(path)] = text; },
    invokeEvaluator: (bin, promptPath, rawPath, timeout) => {
      effects.push(["invoke", bin, promptPath, rawPath, timeout]);
      if (w.invoke_rc === 0) files[rel(rawPath)] = w.raw;
      return w.invoke_rc;
    },
    readRaw: (rawPath) => (rel(rawPath) in files ? files[rel(rawPath)]! : null),
    writeNorm: (normPath, text) => { if (w.norm_blocked) return 1; files[rel(normPath)] = text; return 0; },
    // Recorded apart from `files`, which replays what the incumbent WROTE (it never discarded).
    discard: (path) => { discarded.push(rel(path)); },
    noticeOrNotify: (to, reason, evidence) => { effects.push(["notify", to, reason, evidence]); return w.notify_rc; },
    notifyHuman: (reason) => { effects.push(["human", reason]); return w.human_rc; },
    finishSupervision: (armedAt) => { effects.push(["finish", armedAt]); return w.finish_rc; },
    warn: (line) => { stderr.push(`tap watch: ${line}\n`); },
    rosterHandles: () => w.roster,
    rungEligible: (h) => w.eligible[h] ?? false,
    seatState: (h) => w.seat_state[h] ?? "unknown",
    seatRecency: (h) => w.recency[h] ?? "0",
  };
}

function run(c: Case): { rc: number; stdout: string; stderr: string; effects: string[][]; files: Record<string, string>; discarded: string[] } {
  const effects: string[][] = [];
  const files: Record<string, string> = c.world.prompt_dir_blocked ? { "watch/evaluator-prompts": "" } : {};
  const stderr: string[] = [];
  const discarded: string[] = [];
  const s = seamsOf(c.world, effects, files, stderr, discarded);
  const env = { ...c.env };
  try {
    if (c.verb === "evaluate") return { rc: evaluate(s, BUS, "<BASE>/skills/tap/scripts", env), stdout: "", stderr: stderr.join(""), effects, files, discarded };
    // the tick reads the chain through `chain="$(...)"` and feeds `printf '%s\n' "$chain"` on
    const chain = buildChain(c.argv[0]!, c.argv[1]!, s);
    return { rc: 0, stdout: `${chain.replace(/\n+$/, "")}\n`, stderr: stderr.join(""), effects, files, discarded };
  } catch (error) {
    // the CLI's shape: one line, status 1 (main() prints it; a fatal expansion error in bash)
    stderr.push(`tap watch: ${(error as Error).message}\n`);
    return { rc: 1, stdout: "", stderr: stderr.join(""), effects, files, discarded };
  }
}

const notInt = (raw: string): string => `tap watch: evaluator_calls is not an integer: ${JSON.stringify(raw)}\n`;
const fatal = (raw: string): string => `tap watch: evaluator_calls is not an arithmetic literal: ${JSON.stringify(raw)}\n`;
const R2: Record<string, string> = {
  "eval-calls-garbage": notInt("abc") + fatal("abc"),
  "eval-calls-float": notInt("1.5") + fatal("1.5"),
  "eval-calls-blank": notInt(" "),
  "eval-calls-hex": notInt("0x1"),
  "eval-calls-exp": notInt("1e1") + fatal("1e1"),
  "eval-calls-underscore": notInt("1_0") + fatal("1_0"),
  "eval-calls-int64-overflow": notInt("9223372036854775808"),
  "eval-calls-nbsp": notInt("\u00a01") + fatal("\u00a01"),
  "eval-calls-var-name": notInt("calls") + fatal("calls"),
  "eval-calls-trailing-ff": fatal("1\f"),
  "eval-calls-trailing-cr": fatal("1\r"),
  "eval-calls-leading-vt": fatal("\v1"),
  "eval-calls-base2": notInt("2#1"),
  "eval-calls-base16": notInt("16#f"),
  "eval-calls-base64": notInt("64#_"),
  "eval-calls-base-too-great": notInt("2#2") + fatal("2#2"),
  "eval-calls-base-leading-zero": notInt("02#10") + fatal("02#10"),
  "eval-calls-spaced-unary": notInt("- 1"),
};
// R2b (RATIFIED, the leader): an EXPRESSION-shaped hand edit. bash
// evaluated it (`[` refused it, then `$(( x + 1 ))` computed the value the row records and the
// rung went on to invoke the model); the port refuses it the way it refuses a fatal
// literal -- one line, status 1, no effect -- rather than carry an arithmetic evaluator.
const R2B: Record<string, { raw: string; incumbentSet: string }> = {
  "eval-calls-expression-sum": { raw: "1+1", incumbentSet: "3" },
  "eval-calls-expression-paren": { raw: "(1)", incumbentSet: "2" },
  "eval-calls-expression-double-sign": { raw: "--1", incumbentSet: "2" },
};
// R1 (the diagnostic-text class, ratified in review): bash's `warning: command
// substitution: ignored null byte in input` when a verdict field carried a NUL; the port's
// `cmdSubst` drops the byte the same way and says nothing.
const R1: Record<string, RegExp> = {
  "eval-reason-nul": /^<BASE>\/skills\/tap\/scripts\/tap-watch\.sh: line \d+: warning: command substitution: ignored null byte in input\n$/,
};
const R3: Record<string, RegExp> = {
  "eval-prompt-dir-blocked": /^mkdir: <WORK>\/bus\/watch\/evaluator-prompts: .*\n<BASE>\/skills\/tap\/scripts\/tap-watch\.sh: line \d+: <WORK>\/bus\/watch\/evaluator-prompts\/2000-<PID>\.md: .*\n$/,
  "eval-norm-write-blocked": /^Traceback \(most recent call last\):\n[^]*IsADirectoryError: .*normalized\.json'\n$/,
};
const seen: string[] = [];

describe(`the evaluator rung and chain replay the incumbent at ${oracle.captured_from.head.slice(0, 9)}`, () => {
  for (const c of oracle.cases) {
    test(c.case, () => {
      const got = run(c);
      if (c.case in R2) {
        seen.push(c.case);
        // the row is about bash's diagnostic text: the incumbent printed the `[` test's line
        // (`integer expected`) and/or the fatal expansion's line, one bash line per port line
        expect(c.stderr, "bash's diagnostic").toMatch(/^<BASE>\/skills\/tap\/scripts\/tap-watch\.sh: line \d+: [^]*?(integer expected|arithmetic syntax error|value too great for base)/);
        expect((c.stderr.match(/\n/g) ?? []).length, "one bash line per port line").toBe((R2[c.case]!.match(/\n/g) ?? []).length);
        expect(got.stderr, "stderr").toBe(R2[c.case]!);
      } else if (c.case in R1) {
        seen.push(c.case);
        expect(c.stderr, "bash's warning").toMatch(R1[c.case]!);
        expect(got.stderr, "the port drops the byte silently").toBe("");
      } else if (c.case in R2B) {
        seen.push(c.case);
        const row = R2B[c.case]!;
        expect(c.rc, "the incumbent evaluated the expression and went on").toBe(0);
        expect(c.effects[0], "the incumbent's lease write").toEqual(["set", "evaluator_calls", row.incumbentSet]);
        expect(c.effects.map((e) => e[0]), "the incumbent invoked the model").toContain("invoke");
        expect(got.rc, "the port ends the rung").toBe(1);
        expect(got.stderr, "one refusal").toBe(notInt(row.raw) + fatal(row.raw));
        expect(got.effects, "no effect").toEqual([]);
        expect(got.files, "no file").toEqual({});
        return;
      } else if (c.case in R3) {
        seen.push(c.case);
        expect(c.stderr, "the incumbent's IO diagnostic").toMatch(R3[c.case]!);
      } else {
        expect(c.stderr, "the fixture carries no bash diagnostic outside the ratified rows").toBe("");
        expect(got.stderr, "stderr").toBe("");
      }
      expect(got.rc, "exit status").toBe(c.rc);
      expect(got.stdout, "stdout").toBe(c.stdout);
      expect(got.effects, "effects, in order").toEqual(c.effects);
      expect(got.files, "files written").toEqual(c.files);
      // tap-kju: once the model answered (a raw verdict was published) all three scratch
      // files are discarded, whatever the verdict; a failed invocation discards nothing.
      const rawKey = Object.keys(c.files).find((k) => /^watch\/evaluator-<PID>-.*(?<!\.normalized)\.json$/.test(k));
      expect(got.discarded, "verdict files discarded").toEqual(rawKey ? [rawKey, `${rawKey}.stderr`, rawKey.replace(/\.json$/, ".normalized.json")] : []);
    });
  }
  test("the ratified rows are exactly the enumerated ones", () => {
    expect(seen.sort()).toEqual([...Object.keys(R1), ...Object.keys(R2), ...Object.keys(R2B), ...Object.keys(R3)].sort());
    expect(oracle.cases.length).toBe(121);
  });
});

// bash's two integer readers, at the edges the corpus pins (measured on bash 5.3.9 and, for
// the arithmetic forms, 3.2.57 -- the legal-number and arithmetic-whitespace probe scripts):
// `[ x -ge 2 ]` is legal_number (decimal within int64, C whitespace on both sides in bash 5),
// `$(( x + 1 ))` takes blanks/newlines, a spaced unary sign, octal, hex, `base#n`, and wraps.
describe("bash's integer readers", () => {
  test("legal_number", () => {
    expect(testInt(" 1 ")).toBe(1n);
    expect(testInt("\t+7")).toBe(7n);
    expect(testInt("010")).toBe(10n);
    expect(testInt("1\n")).toBe(1n);
    expect(testInt("\v1\v")).toBe(1n);
    expect(testInt("2\f")).toBe(2n);
    expect(testInt("9223372036854775807")).toBe(INT64_MAX);
    expect(testInt("-9223372036854775808")).toBe(-INT64_MAX - 1n);
    for (const bad of ["", " ", "0x1", "1.5", "1e1", "1_0", "\u00a01", "9223372036854775808", "calls", "2#1", "- 1", "1+1", "(1)"]) expect(testInt(bad), JSON.stringify(bad)).toBeNull();
  });
  test("arithmetic literal + 1", () => {
    expect(arithPlusOne("")).toBe("1");
    expect(arithPlusOne(" \t\n")).toBe("1");
    expect(arithPlusOne(" 1 ")).toBe("2");
    expect(arithPlusOne("\n1\n\n")).toBe("2");
    expect(arithPlusOne("+1")).toBe("2");
    expect(arithPlusOne("+ 1")).toBe("2");
    expect(arithPlusOne("- 1")).toBe("0");
    expect(arithPlusOne("-1")).toBe("0");
    expect(arithPlusOne("01")).toBe("2");
    expect(arithPlusOne("017")).toBe("16");
    expect(arithPlusOne("0x1f")).toBe("32");
    expect(arithPlusOne("0x")).toBe("1");
    expect(arithPlusOne("2#1")).toBe("2");
    expect(arithPlusOne("16#f")).toBe("16");
    expect(arithPlusOne("36#Z")).toBe("36");
    expect(arithPlusOne("37#z")).toBe("36");
    expect(arithPlusOne("64#_")).toBe("64");
    expect(arithPlusOne("9007199254740993")).toBe("9007199254740994");
    expect(arithPlusOne("9223372036854775807")).toBe("-9223372036854775808");
    expect(arithPlusOne("9223372036854775808")).toBe("-9223372036854775807");
    // fatal in bash too
    for (const bad of ["abc", "1.5", "1e1", "1_0", "08", "\u00a01", "calls", "+", "1\r", "\v1", "1\f", " \r\n", "2#", "0#1", "1#1", "65#1", "37#Z", "2#2", "02#1", "02#10"]) expect(() => arithPlusOne(bad), JSON.stringify(bad)).toThrow(/not an arithmetic literal/);
    // expressions bash would evaluate: refused (R2b)
    for (const expr of ["1+1", "(1)", "--1", "- -1", "1 1"]) expect(() => arithPlusOne(expr), JSON.stringify(expr)).toThrow(/not an arithmetic literal/);
  });
});

// --- the production pane-alive seam (M6 U1) ---------------------------------------
//
// With no lib.sh at `scripts`, `rungEligible` must still admit a tick-active
// seat through the native pane-alive read (a stub tmux on PATH answers
// `display-message -p -t <pane> #{pane_id}`): a record naming a live pane with
// its pane id resolves; an id mismatch (the pane died and the id was reused) or
// an unobservable pane does not.
describe("the production pane-alive seam (M6 U1)", () => {
  test("rungEligible resolves a tick pane record through the native alive read", () => {
    const scratch = mkdtempSync(join(tmpdir(), "watch-evaluator-seams."));
    try {
      const stubDir = join(scratch, "bin");
      const log = join(scratch, "tmux-argv.log");
      mkdirSync(stubDir, { recursive: true });
      writeFileSync(join(stubDir, "tmux"), `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
prev=""; target=""
for a in "$@"; do [ "$prev" = "-t" ] && target="$a"; prev="$a"; done
case "\$target" in
  %0) printf '%%0\\n' ;;
  *) exit 7 ;;
esac
`);
      chmodSync(join(stubDir, "tmux"), 0o755);
      const registry = join(scratch, "registry.json");
      writeFileSync(registry, JSON.stringify({ schema: "0.20", seats: { h: { pane: "%0", harness: "claude", status: "active" } } }));
      const base = { bus: join(scratch, "bus"), scripts: join(scratch, "no-scripts"), registry };
      const env = { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, TAP_TMUX_SOCKET: "tapbun-watch-m6-u1", TAP_WATCH_TICK_ACTIVE: "1", TAP_WATCH_TICK_ROSTER_HANDLES: "h" };
      const live = realSeams({ ...base, env: { ...env, TAP_WATCH_TICK_PANE_RECORDS: "h\x1f%0\x1f%0" } });
      expect(live.rungEligible("h")).toBe(true);
      const stale = realSeams({ ...base, env: { ...env, TAP_WATCH_TICK_PANE_RECORDS: "h\x1f%1\x1f%0" } });
      expect(stale.rungEligible("h")).toBe(false);
      const gone = realSeams({ ...base, env: { ...env, TAP_WATCH_TICK_PANE_RECORDS: "h\x1f%9\x1f%0" } });
      expect(gone.rungEligible("h")).toBe(false);
      const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
      expect(calls).toContain(`-L tapbun-watch-m6-u1 display-message -p -t %0 #{pane_id}`);
    } finally { removeScratchTree(scratch); }
  });
});
describe("the production discard seam (tap-kju)", () => {
  test("removes a written verdict file and tolerates one that is already gone", () => {
    const scratch = mkdtempSync(join(tmpdir(), "watch-evaluator-discard."));
    try {
      const seams = realSeams({ bus: join(scratch, "bus"), scripts: join(scratch, "no-scripts"), registry: join(scratch, "registry.json"), env: { ...process.env } });
      const file = join(scratch, "evaluator-1-0.json");
      writeFileSync(file, "{}");
      seams.discard(file);
      expect(existsSync(file)).toBe(false);
      expect(() => seams.discard(file)).not.toThrow();
    } finally { removeScratchTree(scratch); }
  });
});
const INT64_MAX = 2n ** 63n - 1n;
