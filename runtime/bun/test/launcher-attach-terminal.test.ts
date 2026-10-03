// Python supplies kernel PTY/job-control APIs; the tested command is native Bun.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

test("native attach retains foreground ownership, failure narration and terminal modes", () => {
  const result = spawnSync(Bun.which(process.env.TAP_PYTHON ?? "python3")!, ["-B", join(import.meta.dir, "support/attach-tty.py")],
    { env: { ...process.env, TAP_SMOKE_BUN: process.execPath, PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 90_000 });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toContain("Ran 4 tests");
}, 100_000);
