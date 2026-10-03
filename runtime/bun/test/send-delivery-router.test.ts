// tap_serial_triggers "bin/" "runtime/bun/main.ts" "skills/tap/scripts/tap-send.sh" "skills/tap/scripts/lib.sh" "runtime/bun/test/support/send-delivery-fixture.ts" "runtime/bun/test/fixtures/agent-state/"
/* Router and class-conflict rows of the former send-delivery-classes.test.ts (D3a): which classes trace native, which wait on Bash, and the shared parser refusal. Shared fixture: support/send-delivery-fixture.ts (lazy scratch; per-file afterAll). */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquirePaneLock } from "../src/panelock";
import { createRun } from "../src/recovery/state";
import { removeScratchTree } from "./support/scratch";
import { fixture, one, releaseScratch, run } from "./support/send-delivery-fixture";

afterAll(releaseScratch, 40_000);

describe("router: the classes this member flips, and the ones that wait", () => {
  test("every delivery class traces native: polite, polite-timeout, no-spool, --delivery polite|now|interrupt, --wake, --urgent and escalate", () => {
    // One fixture per send: a polite park publishes through the Bash spool
    // engine, and any Bash spool body on the bus delegates the next native send
    // (CONTRACT §runtime selection) — the route would then measure the census.
    const route = (args: string[]) => run(fixture(), args).route;
    expect(route(["send", "rb", "-m", "r1", "--polite"])).toBe("native send");
    expect(route(["send", "rb", "-m", "r2", "--polite", "--polite-timeout", "7"])).toBe("native send");
    expect(route(["send", "rb", "-m", "r3", "--no-spool"])).toBe("native send");
    expect(route(["send", "rb", "-m", "r4", "--delivery", "polite"])).toBe("native send");
    expect(route(["send", "rb", "-m", "r5", "--delivery", "now"])).toBe("native send");
    expect(route(["assign", "rb", "-m", "r6", "--polite"])).toBe("native assign");
    expect(route(["send", "rb", "-m", "r7", "--delivery", "interrupt"])).toBe("native send");
    expect(route(["send", "rb", "-m", "r8", "--urgent"])).toBe("native send");
    expect(route(["send", "rb", "-m", "r9", "--kind", "escalate"])).toBe("native send");
    expect(route(["send", "rb", "-m", "r10", "--wake"])).toBe("native send");
  }, 120_000);

  test("the class conflicts refuse natively with the shared parser's bytes", () => {
    const v = one({}, ["send", "rb", "-m", "hi", "--no-spool", "--polite"]);
    expect({ code: v.code, err: v.receipt.error_class, detail: v.receipt.detail })
      .toEqual({ code: 1, err: "usage_error", detail: "--no-spool contradicts interrupt/--urgent and polite/--polite; use the now class" });
  }, 120_000);
});

test("the shared fixture recreates its scratch root after a release (unit-2 lifecycle regression)", async () => {
  fixture();
  await releaseScratch();
  const fx = fixture();
  expect(existsSync(fx.root)).toBe(true);
}, 60_000);
