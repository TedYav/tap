import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AGENT_FAMILIES, SESSION_CONTEXT } from "../src/harness-families";
import { DEFAULT_AGENT_FAMILIES } from "../src/observe";

// tap-sh9g acceptance 4: a NEW supported harness added to AGENT_FAMILIES with no
// session-start context path fails here. Derived from the set (never hand-listed),
// same enumerating shape as tap-ctzt / session-root-gate-enum.

const ROOT = join(import.meta.dir, "../../..");

test("every supported family has a session-start context row", () => {
  for (const family of AGENT_FAMILIES) {
    expect(SESSION_CONTEXT[family], `family '${family}' has no SESSION_CONTEXT row`).toBeString();
  }
});

test("each row is an existing adapter artifact or a named limit", () => {
  const rows = Object.entries(SESSION_CONTEXT);
  expect(rows.length, "SESSION_CONTEXT must not carry rows outside AGENT_FAMILIES").toBeGreaterThanOrEqual(AGENT_FAMILIES.size);
  for (const [family, value] of rows) {
    expect(AGENT_FAMILIES.has(family), `SESSION_CONTEXT row '${family}' is not a supported family`).toBe(true);
    expect(value.length, `row '${family}' is empty`).toBeGreaterThan(0);
    if (value.startsWith("limit:")) continue;
    expect(existsSync(join(ROOT, value)), `adapter artifact for '${family}' does not exist: ${value}`).toBe(true);
  }
});

test("the four context-carrying families keep their artifacts wired", () => {
  for (const family of ["claude", "codex", "cursor", "opencode"] as const) {
    const value = SESSION_CONTEXT[family]!;
    expect(value.startsWith("limit:"), `'${family}' regressed to a documented limit: ${value}`).toBe(false);
    expect(existsSync(join(ROOT, value)), `'${family}' adapter artifact missing: ${value}`).toBe(true);
  }
});

// Ported from the retired smoke/bun-harness-families.test.sh: the native roster
// and observer must recognize the same families, in the same order — the
// observer's list is the fallback when discovery is unavailable.
test("the observer's default families are exactly the roster set, in order", () => {
  expect<string[]>([...AGENT_FAMILIES]).toEqual([...DEFAULT_AGENT_FAMILIES]);
});
