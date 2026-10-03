import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recoveryPolicy } from "../src/recovery-policy";

const roots: string[] = [];
function config(text?: string) {
  const root = mkdtempSync(join(tmpdir(), "tap-recovery-policy-"));
  roots.push(root);
  mkdirSync(join(root, "tap"));
  if (text !== undefined) writeFileSync(join(root, "tap/config.toml"), text, { mode: 0o600 });
  return { HOME: root, XDG_CONFIG_HOME: root };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("missing configuration uses the calling verb's explicit default", () => {
  expect(recoveryPolicy("cautious", undefined, config())).toEqual({ mode: "cautious", source: "default" });
  expect(recoveryPolicy("report-only", undefined, config("[recovery]\n"))).toEqual({ mode: "report-only", source: "default" });
});
test("both callers share config and per-invocation override", () => {
  const env = config('[recovery]\naggressiveness = "aggressive"\n');
  expect(recoveryPolicy("cautious", undefined, env)).toEqual({ mode: "aggressive", source: "config" });
  expect(recoveryPolicy("report-only", undefined, env)).toEqual({ mode: "aggressive", source: "config" });
  expect(recoveryPolicy("cautious", "report-only", env)).toEqual({ mode: "report-only", source: "override" });
});
test("invalid selected policy refuses before recovery can act", () => {
  for (const text of ['[recovery]\naggressiveness = "yolo"', 'recovery = false', '[recovery]\naggressiveness = 1', '[recovery']) {
    expect(() => recoveryPolicy("cautious", undefined, config(text))).toThrow();
  }
  expect(() => recoveryPolicy("cautious", "", config())).toThrow();
});
test("explicit report-only can inspect despite malformed config", () => {
  expect(recoveryPolicy("cautious", "report-only", config('[broken'))).toEqual({ mode: "report-only", source: "override" });
});
