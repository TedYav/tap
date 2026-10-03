// tap_serial_triggers "bin/tap" "skills/tap/scripts/lib.sh" "runtime/bun/main.ts" "runtime/bun/src/verbs/watch.ts" "runtime/bun/src/watch-run.ts" "runtime/bun/test/fixtures/watch-verbs-oracle.json" "runtime/bun/test/support/watch-verbs-fixture.ts"
// The 39 status, resume, reminders and parser cases through the Bash door.
// The router component covers every oracle row and owns deviation enumeration.

import { afterAll, describe, expect, test } from "bun:test";

import { Door, expected, HELP_CASE, normaliseTemp, oracle, releaseScratch, replay, watchHelpOk } from "./support/watch-verbs-fixture";

afterAll(() => releaseScratch(), 40_000);

describe("tap watch verbs replay the incumbent byte-for-byte through both doors", () => {
  for (const c of oracle.cases.filter(c => c.case !== HELP_CASE && !["on", "pause", "ack", "off"].includes(c.argv[0] ?? ""))) {
    for (const door of ["bin/tap"] as Door[]) {
      test(`${c.case} via ${door}`, () => {
        const got = replay(c, door);
        const want = expected(c);
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
  test("usage-help via bin/tap keeps the verb, every operation and the recorded effects", () => {
    const c = oracle.cases.find(c => c.case === HELP_CASE)!;
    expect(watchHelpOk(c, replay(c, "bin/tap" as Door))).toEqual({ rc: 0, stderr: "", post: c.post, tmux_log: c.tmux_log,
      named: ["on", "pause", "resume", "off", "status", "ack"], heading: true, offActor: true });
  }, 30_000);
});
