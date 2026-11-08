// Frozen fixtures: a test compares generated output with a checked-in file, so an unintended
// change fails review. When the change is intended, regenerate through the runner instead of a
// bare script (AGENTS.md § Tests and probes):
//
//   TAP_UPDATE_FIXTURES=1 bash runtime/bun/test/run.sh <test-file>
//
// Update mode rewrites the file and still FAILS, so a run that rewrote a fixture can never be
// reported as passing evidence: review the diff, then rerun without the flag. CI refuses it.

import { expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const UPDATE_FIXTURES = "TAP_UPDATE_FIXTURES";

export function expectFrozenFixture(path: string, actual: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env[UPDATE_FIXTURES] === "1") {
    if (env.CI) throw new Error(`${UPDATE_FIXTURES}=1 is refused under CI: regenerate fixtures locally and commit the reviewed file`);
    writeFileSync(path, actual);
    throw new Error(`frozen fixture rewritten: ${path}; review the diff, then rerun without ${UPDATE_FIXTURES} for evidence`);
  }
  if (!existsSync(path)) {
    throw new Error(`frozen fixture missing: ${path}; create it with ${UPDATE_FIXTURES}=1 bash runtime/bun/test/run.sh <this test file>`);
  }
  expect(actual).toBe(readFileSync(path, "utf8"));
}
