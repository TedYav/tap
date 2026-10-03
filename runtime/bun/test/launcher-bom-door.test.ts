import { afterAll, expect, test } from "bun:test";
import { hasUtf8Bom, resolveCatalog } from "../src/launcher/catalog";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * The catalog reader's BOM door — rule 40 / tap-uddlm family T3.
 *
 * `tomllib` REFUSES a leading U+FEFF, so the incumbent degrades a BOM-prefixed
 * config to no policy and says so. The port reached the opposite answer by two
 * independent routes, both measured before this fix:
 *
 *   - `new TextDecoder("utf-8", { fatal: true })` defaults to `ignoreBOM: false`,
 *     which CONSUMES the BOM before the parser sees anything; and
 *   - `Bun.TOML.parse` accepts a leading U+FEFF even when handed one directly.
 *
 * Either alone would have been enough, which is why `{ ignoreBOM: true }` is the
 * WRONG fix: it only moves the BOM into the string, where the parser accepts it.
 * The question has to be asked of the bytes.
 *
 * The direction matters more than the parity. A config an editor saved with a
 * BOM had its `[harness.*.env]` policy APPLIED by the port and REFUSED by the
 * incumbent — the more permissive side was ours, on the tier that decides which
 * environment variables reach a child process.
 */

const work = mkdtempSync(join(tmpdir(), "bom-door-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
let index = 0;

const POLICY = 'version = 3\n[harness.claude]\nenv = { POLICY_TIER_TWO = "from-config" }\n';
const BOM = "﻿";

function catalogFor(text: string): { policyEnv: Record<string, string>; notices: string[] } {
  const dir = join(work, String(index++));
  mkdirSync(join(dir, "tap"), { recursive: true });
  const file = join(dir, "tap", "config.toml");
  writeFileSync(file, text);
  chmodSync(file, 0o600);
  const notices: string[] = [];
  const got = resolveCatalog(undefined, "claude", { XDG_CONFIG_HOME: dir, HOME: join(dir, "home") },
                             m => notices.push(m));
  return { policyEnv: got.policyEnv, notices };
}

test("the premise, asserted rather than assumed: TextDecoder eats the BOM and Bun.TOML.parse accepts it", () => {
  // Both halves are why the fix lives at the bytes. If a future Bun changes
  // either, this arm says so before someone concludes the guard is redundant.
  const bytes = Buffer.from(`${BOM}version = 3\n`, "utf8");
  expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes).charCodeAt(0)).not.toBe(0xfeff);
  expect(Bun.TOML.parse(`${BOM}version = 3\n`)).toEqual({ version: 3 } as never);
});

test("hasUtf8Bom asks the bytes, not the decoded string", () => {
  expect(hasUtf8Bom(Buffer.from(`${BOM}x`, "utf8"))).toBe(true);
  expect(hasUtf8Bom(Buffer.from("x", "utf8"))).toBe(false);
  expect(hasUtf8Bom(Buffer.from([0xef, 0xbb]))).toBe(false);   // truncated, not a BOM
  expect(hasUtf8Bom(Buffer.alloc(0))).toBe(false);
});

test("a BOM-prefixed config applies NO policy and degrades with a notice", () => {
  const { policyEnv, notices } = catalogFor(BOM + POLICY);
  // The security-relevant assertion: the fenced tier does not reach the child.
  expect(policyEnv).toEqual({});
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain("could not read harness environment policy from");
  expect(notices[0]).toContain("harness policy is not being applied");
  expect(notices[0]).toContain("BOM");
});

test("the SAME config without the BOM applies its policy — the positive control", () => {
  // Without this, the arm above would pass against a reader that refuses
  // everything, and "no policy applied" would prove nothing about the BOM.
  const { policyEnv, notices } = catalogFor(POLICY);
  expect(policyEnv).toEqual({ POLICY_TIER_TWO: "from-config" });
  expect(notices).toEqual([]);
});

test("a BOM in the MIDDLE is not a byte-order mark and does not refuse", () => {
  // U+FEFF is only a BOM at offset 0; elsewhere it is ZERO WIDTH NO-BREAK SPACE,
  // and this lane has already met it as a content character in preset
  // descriptions, where Python does not treat it as whitespace.
  const { policyEnv, notices } = catalogFor(
    `version = 3\n[harness.claude]\nenv = { POLICY_TIER_TWO = "from${BOM}config" }\n`);
  expect(policyEnv).toEqual({ POLICY_TIER_TWO: `from${BOM}config` });
  expect(notices).toEqual([]);
});
