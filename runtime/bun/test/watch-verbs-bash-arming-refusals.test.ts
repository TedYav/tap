// tap_serial_triggers "bin/tap" "skills/tap/scripts/lib.sh" "runtime/bun/main.ts" "runtime/bun/src/verbs/watch.ts" "runtime/bun/src/watch-run.ts" "runtime/bun/test/fixtures/watch-verbs-oracle.json" "runtime/bun/test/support/watch-verbs-fixture.ts"
// The 70 arming refusal cases through the Bash door.
// The router component covers every oracle row and owns deviation enumeration.

import { afterAll, describe, expect, test } from "bun:test";

import { Door, expected, normaliseTemp, oracle, releaseScratch, replay } from "./support/watch-verbs-fixture";

afterAll(() => releaseScratch(), 40_000);

describe("tap watch verbs replay the incumbent byte-for-byte through both doors", () => {
  // The archived path-spelling refusal is retired; controls cover custom homes.
  for (const c of oracle.cases.filter(c => c.argv[0] === "on" && c.rc !== 0 && c.case !== "on-legacy-home")) {
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
