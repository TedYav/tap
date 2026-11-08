import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expectFrozenFixture } from "./support/frozen-fixture";

const root = realpathSync(mkdtempSync(join(tmpdir(), "tap-frozen-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("a matching fixture passes and a drifted one fails without touching the file", () => {
  const path = join(root, "match.json");
  writeFileSync(path, "frozen\n");
  expectFrozenFixture(path, "frozen\n", {});
  expect(() => expectFrozenFixture(path, "changed\n", {})).toThrow();
  expect(readFileSync(path, "utf8")).toBe("frozen\n");
});

test("update mode rewrites the file and still fails, so the rewriting run is never evidence", () => {
  const path = join(root, "update.json");
  writeFileSync(path, "old\n");
  expect(() => expectFrozenFixture(path, "new\n", { TAP_UPDATE_FIXTURES: "1" })).toThrow("frozen fixture rewritten");
  expect(readFileSync(path, "utf8")).toBe("new\n");
  expectFrozenFixture(path, "new\n", {});
});

test("CI refuses update mode and leaves the fixture alone; a missing fixture names the update command", () => {
  const path = join(root, "ci.json");
  writeFileSync(path, "old\n");
  expect(() => expectFrozenFixture(path, "new\n", { TAP_UPDATE_FIXTURES: "1", CI: "true" })).toThrow("refused under CI");
  expect(readFileSync(path, "utf8")).toBe("old\n");
  expect(() => expectFrozenFixture(join(root, "absent.json"), "x", {})).toThrow("TAP_UPDATE_FIXTURES=1 bash runtime/bun/test/run.sh");
});
