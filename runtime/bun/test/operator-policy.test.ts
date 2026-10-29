import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { operatorPolicy } from "../src/recovery/operator-policy";

const root = mkdtempSync(join(tmpdir(), "tap-operator-policy-"));
let next = 0;
afterAll(() => rmSync(root, { recursive: true, force: true }));
function config(text?: string, mode = 0o600): NodeJS.ProcessEnv {
  const dir = join(root, String(next++));
  mkdirSync(join(dir, "tap"), { recursive: true });
  if (text !== undefined) {
    writeFileSync(join(dir, "tap/config.toml"), text, { mode });
    chmodSync(join(dir, "tap/config.toml"), mode);
  }
  return { ...process.env, XDG_CONFIG_HOME: dir };
}

test("a fresh machine cannot launch an operator, even with aggressive recovery selected", () => {
  for (const text of [undefined, "", '[recovery]\naggressiveness = "aggressive"']) {
    expect(operatorPolicy(config(text))).toMatchObject({ mode: "off", afterMs: 1_200_000, source: "default" });
  }
});

test("ask and on are explicit config authority with the selected mail-age threshold", () => {
  const env = config('[recovery]\noperator = "ask"\noperator_after = "90s"\naggressiveness = "report-only"');
  expect(operatorPolicy(env)).toMatchObject({ mode: "ask", afterMs: 90_000, source: "config" });
  expect(operatorPolicy(config('[recovery]\noperator = "on"\noperator_after = "24h"')))
    .toMatchObject({ mode: "on", afterMs: 86_400_000 });
  const before = operatorPolicy(env).digest;
  writeFileSync(join(env.XDG_CONFIG_HOME!, "tap/config.toml"), '[recovery]\noperator = "on"\noperator_after = "90s"', { mode: 0o600 });
  expect(operatorPolicy(env).digest).not.toBe(before);
});

test("bad gate, unlabelled or unbounded duration, malformed and insecure config cannot enable a run", () => {
  for (const text of ['recovery = false', '[recovery]\noperator = true', '[recovery]\noperator = "yes"',
    ...['20', '0s', '-1m', '1.5h', '1d', '25h', '86401s', '999999999999999999999h', ' 20m', '20m ']
      .map(value => `[recovery]\noperator = "on"\noperator_after = "${value}"`),
    '[recovery]\noperator_after = 1200', '[broken']) {
    expect(() => operatorPolicy(config(text)), text).toThrow();
  }
  expect(() => operatorPolicy(config('[recovery]\noperator = "on"', 0o666))).toThrow();
});
