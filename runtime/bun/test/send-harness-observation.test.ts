import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, releaseScratch, run } from "./support/send-delivery-fixture";

afterAll(releaseScratch, 40_000);

function deniedInspection() {
  const fx = fixture();
  fx.env.FAKE_HARNESS = "2.1.296";
  writeFileSync(join(fx.root, "bin/ps"), "#!/bin/sh\nprintf 'operation not permitted: ps (sandboxed)\\n' >&2\nexit 127\n", { mode: 0o755 });
  return fx;
}

test("delivery to native Claude succeeds without ps and rechecks the same evidence before effects", () => {
  const fx = deniedInspection();
  const versions = join(fx.root, ".local/share/claude/versions");
  mkdirSync(versions, { recursive: true });
  writeFileSync(join(versions, "2.1.296"), "fixture", { mode: 0o755 });
  const result = run(fx, ["send", "rb", "-m", "hello"]);
  expect(result.code, result.stderr + result.stdout).toBe(0);
  expect(result.payloads).toBe(1);
  expect(result.keys.some(key => /Enter/.test(key))).toBe(true);
});

for (const json of [true, false]) test(`unobservable identity explains denied inspection without claiming stale registration (${json ? "json" : "text"})`, () => {
  const fx = deniedInspection();
  const result = run(fx, ["send", "rb", "-m", "hello"], json);
  expect(result.code).toBe(1);
  expect({ payloads: result.payloads, keys: result.keys }).toEqual({ payloads: 0, keys: [] });
  const output = result.stdout + result.stderr;
  expect(output).toContain("identity unobservable, not proven stale");
  expect(output).toContain("operation not permitted: ps (sandboxed)");
  expect(output).toContain("approved sandbox escalation");
  expect(output).not.toContain("tap register");
  expect(output).not.toContain("recorded pane is stale");
  if (json) expect(result.receipt.error_class).toBe("harness_unobservable");
});
