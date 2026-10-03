// The blocked-seat pass replays the frozen capture of the incumbent
// (fixtures/watch-blocked-oracle.json, captured from tap-watch.sh at the pinned base
// by the since-retired capture harness, in the tick's own calling shape -- a command
// substitution, so bash had no errexit): every case's scripted WORLD is offered to
// `processBlocked` through a fixture-backed BlockedSeams, and the touched handles,
// the status, stderr and the ordered effects (lease writes, continue sends with the
// draft's bytes, transcript reads) must equal what the Bash function did.
//
// The measured deviations, each an explicit row below and enumerated at the end:
//   R1. a bash `[` diagnostic on stderr becomes one `tap watch:` line; status and
//       effects unchanged. (The blocked-map steps were Bun modules already at the
//       base, so their one-line refusals are replayed byte for byte, unruled.)
//   R2. a bash death inside the substitution -- an unbound name or a syntax error in
//       `$(( reset_at + grace ))` -- ended the subshell with the handles printed so
//       far and status 1; the port returns the same partial list and status, with
//       one `tap watch:` line in place of bash's.
//   R2b. a value bash would have EVALUATED where the tick writes a number -- an
//       expression in `reset_at`, a key the shell would glob against the working
//       directory -- is refused (status 1, one line) where bash computed something
//       from it (ruling the leader: a bash arithmetic
//       evaluator would be a second engine for a value nobody writes).

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { blockedHandles, continueBody, processBlocked, realBlockedSeams, type BlockedSeams } from "../src/watch-blocked";
import { removeScratchTree } from "./support/scratch";

interface World {
  lease: Record<string, string>;
  lease_current: boolean[];
  tick: { handles: string[]; panes: [string, string, string][] } | null;
  alive: Record<string, string | null>;
  registry_pane: Record<string, string>;
  seat_state: Record<string, [string, number]>;
  activity: Record<string, string>;
  peek: Record<string, string>;
  send: Record<string, [number, string]>;
  set_rc: number;
}

interface Case {
  case: string;
  argv: string[];
  env: Record<string, string>;
  world: World;
  rc: number;
  stdout: string;
  stderr: string;
  effects: string[][];
}

const oracle = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/watch-blocked-oracle.json"), "utf8")) as {
  captured_from: { head: string; template: string; shape: string }; cases: Case[];
};
const TEMPLATE = oracle.captured_from.template.replace(/\n+$/, ""); // `$(cat ...)`

/** The scripted world as seams; effects recorded exactly as the Bash shims recorded them. */
function seamsOf(w: World, effects: string[][], stderr: string[]): BlockedSeams {
  const lease: Record<string, string> = { ...w.lease };
  let leaseCalls = 0;
  const tick = w.tick;
  const paneAlive = (pane: string): string | null => (pane in w.alive ? w.alive[pane] ?? null : null);
  const resolvedPane = (handle: string): string | null => {
    if (tick !== null) {
      for (const [h, p, id] of tick.panes) {
        if (h !== handle) continue;
        return id !== "" && paneAlive(p) === id ? p : null;
      }
      return null;
    }
    return w.registry_pane[handle] ?? null;
  };
  return {
    leaseField: (k) => lease[k] ?? "",
    leaseSet: (pairs) => {
      effects.push(["set", ...pairs.flatMap(([k, v]) => [k, v])]);
      if (w.set_rc === 0) for (const [k, v] of pairs) lease[k] = v;
    },
    leaseCurrent: () => { const seq = w.lease_current; return seq[Math.min(leaseCalls++, seq.length - 1)]!; },
    seatActive: (h) => tick === null || tick.handles.includes(h),
    seatState: (h) => {
      const pane = resolvedPane(h);
      if (pane === null) return { out: "unknown", ok: true };
      const [out, rc] = w.seat_state[h] ?? ["unknown", 0];
      return { out, ok: rc === 0 };
    },
    windowActivity: (h) => { const t = resolvedPane(h) ?? ""; return t in w.activity ? `${w.activity[t]}\n` : ""; },
    peek: (h) => { effects.push(["peek", h]); return w.peek[h] ?? ""; },
    sendContinue: (h, body) => {
      effects.push(["send", h, body, "watcher", "--from watcher --kind probe --fyi"]);
      const [rc, err] = w.send[h] ?? [1, "tap send: unscripted recipient\n"];
      return { rc, err: err.split("\n")[0] ?? "" };
    },
    continueTemplate: () => TEMPLATE,
    stderr: (line) => { stderr.push(`${line}\n`); },
  };
}

function run(c: Case): { rc: number; stdout: string; stderr: string; effects: string[][] } {
  const effects: string[][] = [];
  const stderr: string[] = [];
  const s = seamsOf(c.world, effects, stderr);
  const [armedAt = "", now = "", armedBy = "", map = "", exempt = ""] = c.argv;
  const r = processBlocked(armedAt, now, armedBy, map, exempt, s, { ...c.env });
  // `out="$(...)"; printf '%s' "$out"`: the handles one per line, the trailing newline gone
  return { rc: r.rc, stdout: r.touched.map((h) => `${h}\n`).join("").replace(/\n+$/, ""), stderr: stderr.join(""), effects };
}

interface Ruled { cls: "R1" | "R2" | "R2b"; rc?: number; stdout?: string; stderr: string | RegExp; effects?: string[][]; incumbent?: RegExp }

const R: Record<string, Ruled> = {
  // R1: bash's `[: abc: integer expected` becomes one line; the seat reads as not due
  "now-not-integer": { cls: "R1", stderr: "tap watch: now is not an integer: \"abc\"\n" },
  "since-non-int-with-activity": { cls: "R1", stderr: "tap watch: blocked_map[r].since is not an integer: \"x\"\n" },
  // R1: bash's `warning: command substitution: ignored null byte in input` when a field carried a NUL;
  // `cmdSubst` drops the byte the same way and says nothing (as ruled for the evaluator's fields)
  "reason-with-nul": { cls: "R1", stderr: "", incumbent: /^<BASE>\/skills\/tap\/scripts\/tap-watch\.sh: line \d+: warning: command substitution: ignored null byte in input\n$/ },
  // R2: the subshell died on `$(( None + 60 ))` / `$(( abc + 120 ))` / `$(( 1.5 + 120 ))`
  "reset-at-none": { cls: "R2", stderr: "tap watch: blocked_map[r].reset_at is not an arithmetic literal: \"None\"\n" },
  "since-name": { cls: "R2", stderr: "tap watch: blocked_map[r].since is not an arithmetic literal: \"abc\"\n" },
  "since-float": { cls: "R2", stderr: "tap watch: blocked_map[r].since is not an arithmetic literal: \"1.5\"\n" },
  "good-seat-then-fatal": { cls: "R2", stderr: "tap watch: blocked_map[s].reset_at is not an arithmetic literal: \"None\"\n" },
  // R2b: bash evaluated `1+1` as 2 (the seat came due); the port refuses the expression
  "reset-at-expression": { cls: "R2b", rc: 1, stdout: "", effects: [], stderr: "tap watch: blocked_map[r].reset_at is not an arithmetic literal: \"1+1\"\n" },
  // R2b: bash matched `a*` against the working directory (no match: the key stayed) and went on; the port refuses the pattern
  "key-with-glob": { cls: "R2b", rc: 1, stdout: "", effects: [], stderr: "tap watch: blocked_map key would be expanded as a pattern by the shell: \"a*\"\n" },
};

const seen: string[] = [];

describe(`the blocked-seat pass replays the incumbent at ${oracle.captured_from.head.slice(0, 9)}`, () => {
  test("the capture is the substitution shape", () => {
    expect(oracle.captured_from.shape).toBe("substitution");
    expect(oracle.cases.length).toBe(63);
  });
  for (const c of oracle.cases) {
    test(c.case, () => {
      const got = run(c);
      const ruled = R[c.case];
      if (ruled === undefined) {
        expect(c.stderr, "an unruled row carries no traceback or shell diagnostic").not.toMatch(/Traceback|unbound variable|syntax error|integer expected/);
        expect(got.rc, "exit status").toBe(c.rc);
        expect(got.stdout, "the touched handles").toBe(c.stdout);
        expect(got.stderr, "stderr").toBe(c.stderr);
        expect(got.effects, "effects, in order").toEqual(c.effects);
        return;
      }
      seen.push(c.case);
      if (ruled.cls === "R1") expect(c.stderr, "the incumbent's diagnostic is on record").toMatch(ruled.incumbent ?? /\[: .*: integer expected/);
      if (ruled.cls === "R2") {
        expect(c.rc, "the incumbent's subshell died").toBe(1);
        expect(c.stderr).toMatch(/unbound variable|syntax error/);
      }
      if (ruled.cls === "R2b") expect(c.rc, "the incumbent went on").toBe(0);
      expect(got.rc, "exit status").toBe(ruled.rc ?? c.rc);
      expect(got.stdout, "the touched handles").toBe(ruled.stdout ?? c.stdout);
      if (typeof ruled.stderr === "string") expect(got.stderr, "stderr").toBe(ruled.stderr); else expect(got.stderr, "stderr").toMatch(ruled.stderr);
      expect(got.effects, "effects, in order").toEqual(ruled.effects ?? c.effects);
    });
  }
  test("the ruled rows are exactly the enumerated ones", () => {
    expect(seen.sort()).toEqual(Object.keys(R).sort());
  });
});

describe("a continue send that cannot be attempted is a reported send, not the end of the pass", () => {
  // `_watch_send_continue ... || true`: whatever failed inside the attempt -- the draft
  // directory, the draft write, the courier, the cleanup -- the pass reported it on one
  // line and went on to the next seat with the handle still touched (write-before-send
  // holds: the lease transition is already recorded when the send is attempted).
  test("the pass over two due seats whose sends both fail to start touches both, reports both, and returns the incumbent's status", () => {
    const map = "{\"r\":{\"reason\":\"api_error\",\"since\":1800,\"reset_at\":0},\"s\":{\"reason\":\"api_error\",\"since\":1800,\"reset_at\":0}}";
    const effects: string[][] = []; const stderr: string[] = [];
    const s: BlockedSeams = {
      leaseField: () => "", leaseSet: (pairs) => { effects.push(["set", ...pairs.map(([k]) => k)]); }, leaseCurrent: () => true, seatActive: () => true,
      seatState: () => ({ out: "idle-at-prompt", ok: true }), windowActivity: () => "0\n", peek: () => "claude\n> \n",
      sendContinue: (h) => { effects.push(["send", h]); return { rc: 1, err: "ENOTDIR: not a directory, mkdir '<bus>/watch'" }; },
      continueTemplate: () => TEMPLATE, stderr: (line) => { stderr.push(`${line}\n`); },
    };
    const r = processBlocked("armed1", "2000", "lead", map, "[]", s, {});
    expect(r).toEqual({ touched: ["r", "s"], rc: 0 });
    expect(effects).toEqual([["set", "blocked_map", "blocked_exempt"], ["send", "r"], ["set", "blocked_map", "blocked_exempt"], ["send", "s"]]);
    expect(stderr).toEqual([
      "tap watch: continue send to 'r' failed (rc=1): ENOTDIR: not a directory, mkdir '<bus>/watch'\n",
      "tap watch: continue send to 's' failed (rc=1): ENOTDIR: not a directory, mkdir '<bus>/watch'\n",
    ]);
  });
  test("the production seam: a draft that cannot be written is a failed send with the reason, never a throw; a writable bus sends the draft and removes it", () => {
    const scratch = mkdtempSync(join(tmpdir(), "watch-blocked-send."));
    try {
      const scripts = join(scratch, "scripts");
      mkdirSync(join(scripts, "watch-templates"), { recursive: true });
      writeFileSync(join(scripts, "watch-templates", "continue.md"), "continue {{REASON}} from {{ARMER}}\n");
      const record = join(scratch, "record");
      // the courier shim records what it was handed and the draft's bytes, then succeeds
      writeFileSync(join(scripts, "courier"), "#!/bin/bash\nprintf '%s\\n' \"$1\" \"${TAP_SELF-unset}\" \"${@:3}\" > \"$RECORD\"\ncat \"$2\" >> \"$RECORD\"\nexit 0\n");
      const args = (bus: string) => ({ bus, scripts, registry: join(scratch, "no-registry.json"), now: "2000", env: { ...process.env, RECORD: record, TAP_WATCH_IDENTITY: "watcher", TAP_COURIER_SCRIPT: join(scripts, "courier") } });
      // 1. `watch` is a regular file: mkdir -p fails
      const busA = join(scratch, "a"); mkdirSync(busA); writeFileSync(join(busA, "watch"), "not a directory");
      const a = realBlockedSeams(args(busA)).sendContinue("h", "body\n");
      expect(a.rc).toBe(1);
      expect(a.err).toMatch(/ENOTDIR|EEXIST|not a directory|file exists/i);
      // 2. `watch` is a directory the process may not write (the lease was readable and current before this point)
      const busB = join(scratch, "b"); mkdirSync(join(busB, "watch"), { recursive: true }); chmodSync(join(busB, "watch"), 0o500);
      let b: { rc: number; err: string };
      try { b = realBlockedSeams(args(busB)).sendContinue("h", "body\n"); } finally { chmodSync(join(busB, "watch"), 0o700); }
      if (process.getuid?.() !== 0) { // root writes anywhere
        expect(b.rc).toBe(1);
        expect(b.err).toMatch(/EACCES|permission denied/i);
      }
      expect(readdirSync(join(busB, "watch"))).toEqual([]);
      // 3. a writable bus: the courier gets the handle, the identity and the flags, the draft holds the body, and the draft is gone afterwards
      const busC = join(scratch, "c"); mkdirSync(busC);
      const c = realBlockedSeams(args(busC)).sendContinue("h", "the body\n");
      expect(c).toEqual({ rc: 0, err: "" });
      expect(readFileSync(record, "utf8")).toBe("h\nwatcher\n--from\nwatcher\n--kind\nprobe\n--fyi\nthe body\n");
      expect(readdirSync(join(busC, "watch"))).toEqual([]);
      expect(existsSync(join(busC, "watch"))).toBe(true);
    } finally {
      removeScratchTree(scratch);
    }
  });
});

describe("the pure pieces", () => {
  test("continueBody replaces every token literally, REASON first, and ends with one newline", () => {
    expect(continueBody("a {{REASON}} b {{ARMER}} {{REASON}}", "r&\\1", "x{{REASON}}")).toBe("a r&\\1 b x{{REASON}} r&\\1\n");
    expect(continueBody("", "", "")).toBe("\n");
    expect(continueBody("{{ARMER}}{{REASON}}", "{{ARMER}}", "A")).toBe("AA\n"); // the second pass sees the first's output, as bash did
  });
  test("blockedHandles splits the keys the way `for h in $(...)` did and refuses a pattern", () => {
    expect(blockedHandles("{\"a b\":1,\"c\":2,\"d\\ne\":3,\" f \":4}")).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(blockedHandles("")).toEqual([]);
    expect(blockedHandles("{}")).toEqual([]);
    expect(() => blockedHandles("{\"a*\":1}")).toThrow(/expanded as a pattern/);
    expect(() => blockedHandles("{\"a?\":1}")).toThrow(/expanded as a pattern/);
    expect(() => blockedHandles("{\"[a]\":1}")).toThrow(/expanded as a pattern/);
    expect(blockedHandles("[]")).toEqual([]);                 // a list map: `for h in d` over its elements (W2a's step), none here
    expect(blockedHandles("[\"x y\"]")).toEqual(["x", "y"]);
    expect(() => blockedHandles("5")).toThrow(/not iterable/);
  });
});
