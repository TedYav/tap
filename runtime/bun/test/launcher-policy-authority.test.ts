import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCatalog } from "../src/launcher/catalog";

/**
 * `[harness.*]` machine policy and `[presets]` are separate authorities that
 * happen to share a file, and conflating them broke two real machines' worth of
 * behavior at once:
 *
 *   - a machine with NO catalog refused a direct harness launch outright, where
 *     CONTRACT says an absent config "resolves the harness tier empty and
 *     silently";
 *   - a machine MID-MIGRATION -- policy already in config.toml, presets still in
 *     presets.toml -- silently lost its permissions and its declared env,
 *     because policy was read off whichever document supplied the presets.
 *
 * The second is the nastier one: nothing refuses, nothing warns, and a seat
 * launches with `bypass` where the operator wrote `auto`. These four cases are
 * the ones a single shared read gets wrong.
 */
const machine = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "tap-policy-"));
  mkdirSync(join(root, "tap"), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, "tap", name), body);
  return root;
};
const POLICY = '[harness.claude]\npermissions = "auto"\n[harness.claude.env]\nHF_TOKENS = "DECLARED"\n';
const LEGACY = '[presets.review]\nharness = "claude"\nparams.model = "opus"\n';
const resolve = (root: string, preset?: string) =>
  resolveCatalog(preset, preset ? undefined : "claude", { XDG_CONFIG_HOME: root }, () => {});

test("a direct harness launch survives a machine with no catalog at all", () => {
  const root = machine({});
  expect(() => resolve(root)).not.toThrow();
  expect(resolve(root).policyEnv).toEqual({});
});

test("a direct harness launch reads policy from a config holding only policy", () => {
  const got = resolve(machine({ "config.toml": POLICY }));
  expect(got.permissions).toBe("auto");
  expect(got.policyEnv).toEqual({ HF_TOKENS: "DECLARED" });
});

test("config policy survives when presets come from the legacy file", () => {
  // The mid-migration machine. The preset must resolve AND the policy must hold.
  const got = resolve(machine({ "config.toml": POLICY, "presets.toml": LEGACY }), "review");
  expect(got.preset?.provenance.name).toBe("review");
  expect(got.permissions).toBe("auto");
  expect(got.policyEnv).toEqual({ HF_TOKENS: "DECLARED" });
});

test("config policy survives a VACANT [presets] that falls back to legacy", () => {
  const got = resolve(machine({ "config.toml": `${POLICY}[presets]\n`, "presets.toml": LEGACY }), "review");
  expect(got.preset?.provenance.name).toBe("review");
  expect(got.permissions).toBe("auto");
});

test("the unified case still works: one file, policy and presets together", () => {
  const got = resolve(machine({ "config.toml": `version = 3\n${POLICY}${LEGACY}` }), "review");
  expect(got.preset?.provenance.name).toBe("review");
  expect(got.permissions).toBe("auto");
  expect(got.policyEnv).toEqual({ HF_TOKENS: "DECLARED" });
});

// Negative control: policy is read from config.toml and ONLY from there. A
// `[harness]` table in the legacy file must not become machine policy, or the
// file we are migrating away from could quietly widen permissions.
test("legacy presets.toml cannot supply harness policy", () => {
  const got = resolve(machine({
    "presets.toml": `[harness.claude]\npermissions = "bypass"\n${LEGACY}`,
  }), "review");
  expect(got.preset?.provenance.name).toBe("review");
  expect(got.policyEnv).toEqual({});
});
