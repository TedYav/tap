import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCatalog } from "../src/launcher/catalog";

/**
 * The incumbent's exact degradation phrase (presets.py:1851, `_degraded_notice`).
 *
 * These two arms used to look for "policy is not applied", which was the PORT's
 * old generic wording, not the incumbent's. When the degraded notice was ported
 * to the incumbent's text ("harness policy is not BEING applied") the positive
 * arm below went red in CI and the NEGATIVE arm at the top of this file went
 * quietly vacuous -- a `.toBe(false)` on a substring that can no longer appear
 * is satisfied by every possible output, so it stopped being a control without
 * stopping being green.
 *
 * Hence one constant for both. A wording change now reds the positive arm, which
 * is the only way anyone finds out that the negative arm needs re-aiming.
 */
const DEGRADED = "harness policy is not being applied";

/**
 * `Bun.TOML` refuses any integer outside ±(2^53−1); `tomllib` reads those
 * exactly. The danger is not the wording gap, it is WHICH PATH the refusal takes.
 *
 * The generic malformed-config path resolves the harness tier empty and lets the
 * launch proceed -- documented behavior for a file the operator broke. Sending a
 * precision refusal down it means a seat starts on DEFAULT PERMISSIONS because
 * our number type is narrower than their file, while the notice tells them their
 * catalog was unavailable. Measured before the fix: `permissions=bypass` where
 * the operator had written `auto`. A limit of the reader, stated as a fact about
 * their file, costing them the fence they asked for.
 *
 * Every spelling is here because the first fix scanned the source for oversized
 * DECIMAL literals and declared hex/octal/binary out of scope; a reviewer's
 * `0x20000000000001` walked straight back into the policy-off path. The decision
 * now comes from the PARSER, which produces one diagnostic for all of them.
 *
 * That makes these tests the tripwire for a real coupling: if Bun's message ever
 * stops saying "losslessly represented", these red instead of a seat quietly
 * losing its permissions. Do not weaken them to a decimal-only case.
 */
const machine = (body: string): string => {
  const root = mkdtempSync(join(tmpdir(), "tap-ceiling-"));
  mkdirSync(join(root, "tap"), { recursive: true });
  writeFileSync(join(root, "tap", "config.toml"), body);
  return root;
};
const POLICY = '[harness.claude]\npermissions = "auto"\n[harness.claude.env]\nHF_TOKENS = "DECLARED"\n';

const SPELLINGS: [string, string][] = [
  ["decimal", "9007199254740993"],
  ["hexadecimal", "0x20000000000001"],
  ["octal", "0o400000000000000001"],
  ["binary", "0b100000000000000000000000000000000000000000000000000001"],
  ["hexadecimal with underscores", "0x2000_0000_000001"],
];

for (const [name, literal] of SPELLINGS) {
  test(`an unrepresentable ${name} integer refuses instead of dropping policy`, () => {
    const root = machine(`version = ${literal}\n${POLICY}`);
    const notices: string[] = [];
    expect(() => resolveCatalog(undefined, "claude", { XDG_CONFIG_HOME: root }, m => notices.push(m)))
      .toThrow("preset_config_unrepresentable");
    // The negative half, and the half that actually protects the operator: the
    // policy-off path must not have been taken on the way to refusing.
    expect(notices.some(n => n.includes(DEGRADED))).toBe(false);
  });
}

test("the refusal names the field and the value the operator must change", () => {
  const root = machine(`version = 0x20000000000001\n${POLICY}`);
  try {
    resolveCatalog(undefined, "claude", { XDG_CONFIG_HOME: root }, () => {});
    throw new Error("expected a refusal");
  } catch (error) {
    const err = error as { detail?: string; action?: string };
    expect(err.detail).toContain("version = 0x20000000000001");
    expect(err.action).toContain("version");
  }
});


// Negative controls. Without these the fix could be "refuse on every parse
// error", which would take the documented policy-off behavior away from files
// the operator really did break.
test("a genuine syntax error still resolves policy empty and launches", () => {
  const root = machine(`version = = =\n${POLICY}`);
  const notices: string[] = [];
  const got = resolveCatalog(undefined, "claude", { XDG_CONFIG_HOME: root }, m => notices.push(m));
  // Empty policy means no saved choice, and the unsaved default is auto.
  expect(got.permissions).toBe("auto");
  expect(notices.some(n => n.includes(DEGRADED))).toBe(true);
});

test("a value AT the ceiling reads, with policy applied", () => {
  const root = machine(`version = 9007199254740991\n${POLICY}`);
  const got = resolveCatalog(undefined, "claude", { XDG_CONFIG_HOME: root }, () => {});
  expect(got.permissions).toBe("auto");
  expect(got.policyEnv).toEqual({ HF_TOKENS: "DECLARED" });
});

test("a small hex integer is ordinary and reads", () => {
  const root = machine(`version = 0x3\n${POLICY}`);
  expect(resolveCatalog(undefined, "claude", { XDG_CONFIG_HOME: root }, () => {}).permissions).toBe("auto");
});
