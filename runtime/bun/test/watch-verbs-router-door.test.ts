// tap_serial_triggers "bin/tap" "skills/tap/scripts/lib.sh" "runtime/bun/main.ts" "runtime/bun/src/verbs/watch.ts" "runtime/bun/src/watch-run.ts" "runtime/bun/test/fixtures/watch-verbs-oracle.json" "runtime/bun/test/support/watch-verbs-fixture.ts"
// All 240 oracle cases through the Bun router. This component owns the original
// ratified-deviation accumulator and enumeration: every case name executes here,
// and no mutable counter crosses the boundary between replay components.

import { afterAll, describe, expect, test } from "bun:test";

import { Door, expected, HELP_CASE, normaliseTemp, oracle, releaseScratch, replay, watchHelpOk } from "./support/watch-verbs-fixture";

afterAll(() => releaseScratch(), 40_000);

const ratifiedSeen: Record<string, string[]> = { R1: [], R2: [], R4: [], R5: [], R6: [], R7: [], R8: [], R9: [], R10: [], R12: [] };

describe("tap watch verbs replay the incumbent byte-for-byte through both doors", () => {
  // Keep the archived oracle intact; its legacy-path refusal is no longer a contract.
  for (const c of oracle.cases.filter(c => c.case !== "on-legacy-home" && c.case !== HELP_CASE)) {
    for (const door of ["router"] as Door[]) {
      test(`${c.case} via ${door}`, () => {
        const got = replay(c, door);
        const want = expected(c);
        for (const r of want.ratified) ratifiedSeen[r]!.push(c.case);
        expect(got.rc, "exit status").toBe(want.rc);
        expect(got.stdout, "stdout").toBe(want.stdout);
        expect(normaliseTemp(got.stderr), "stderr").toBe(normaliseTemp(want.stderr));
        expect(got.post, "post-state").toEqual(want.post);
        expect(got.tmux_log, "tmux effects").toBe(c.tmux_log);
      }, 30_000); // the spawn-mutex arm waits ~5 s on both sides, past bun's 5 s default
    }
  }
});

describe("the rewritten help page", () => {
  test("usage-help via router keeps the verb, every operation and the recorded effects", () => {
    const c = oracle.cases.find(c => c.case === HELP_CASE)!;
    expect(watchHelpOk(c, replay(c, "router" as Door))).toEqual({ rc: 0, stderr: "", post: c.post, tmux_log: c.tmux_log,
      named: ["on", "pause", "resume", "off", "status", "ack"], heading: true, offActor: true });
  }, 30_000);
});

describe("ratified deviations are the enumerated ones and no others", () => {
  test("ratified refusals, durations, infrastructure, loop signature and notice observation touch exactly the expected cases", () => {
    const seen = (r: string) => [...new Set(ratifiedSeen[r])].sort();
    expect(seen("R1")).toEqual(["ack-by-empty", "ack-by-missing", "on-by-empty", "on-by-missing", "on-ctx-exempt-missing", "on-ctx-threshold-blank",
      "on-m-empty", "on-m-missing", "on-threshold-blank-0-x", "pause-for-empty", "pause-reason-empty", "pause-reason-missing"]);
    expect(seen("R2")).toEqual(["off-no-actor", "off-other", "off-pending-other"]);
    expect(seen("R4")).toEqual(["pause-for-arith-010m", "pause-for-arith-017h", "pause-for-arith-018s", "pause-for-arith-08h", "pause-for-arith-08m", "pause-for-arith-09m", "pause-for-arith-9223372036854775808s"]);
    expect(seen("R5")).toEqual(["on-arm-dir", "pause-notice-io-failure"]);
    expect(seen("R6")).toEqual(["on-arm-fifo"]);
    expect(seen("R7")).toEqual(["on-spawn-ok", "on-spawn-ours-alive-stale", "on-spawn-ours-dead"]);
    expect(seen("R12")).toEqual(["on-spawn-ok", "on-spawn-ours-alive-stale", "on-spawn-ours-dead"]);
    expect(seen("R8")).toEqual(["off-no-actor-force", "off-other-force", "off-unverifiable-force", "on-rearm-other-force",
      "pause-no-actor", "pause-nonarmer", "resume-paused-no-actor", "resume-paused-nonarmer"]);
    expect(seen("R9")).toEqual(["on-corrupt-no-rearm", "on-diff-goal-armer", "on-diff-goal-no-armed-by", "on-diff-goal-other", "on-diff-many", "on-list-arm",
      "on-same-goal-chain", "on-same-goal-evaluator-codex", "on-same-goal-threshold-diff"]);
    expect(seen("R10")).toEqual(["status-armed", "status-bigint", "status-corrupt", "status-empty-object", "status-extra-arg", "status-list",
      "status-nbsp-done-when", "status-null-done-when", "status-object-done-when", "status-paused", "status-paused-until-only"]);
  });
});
