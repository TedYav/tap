// tap-gjwtw: attemptObligationLock keeps WHY a bounded acquisition came back empty,
// so tap reply can tell contention from a lock it can never take.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireObligationLock, attemptObligationLock } from "../src/panelock";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { try { chmodSync(root, 0o700); } catch { /* gone */ } rmSync(root, { recursive: true, force: true }); } });
function lockRoot(): { root: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "obligation-attempt-"));
  roots.push(root);
  return { root, env: { ...process.env, TAP_LOCK_DIR: join(root, "locks") } };
}

test("a free lock is held and a second attempt is contention with no failure", () => {
  const { env } = lockRoot();
  const first = attemptObligationLock("id-1", 0, env);
  expect(first.lock).not.toBeNull();
  expect(first.failure).toBeNull();
  const second = attemptObligationLock("id-1", 0, env);
  expect(second.lock).toBeNull();
  expect(second.failure).toBeNull();
  first.lock!.release();
  const third = attemptObligationLock("id-1", 0, env);
  expect(third.lock).not.toBeNull();
  third.lock!.release();
});

test("a sidecar that is a directory fails with its own errno, even for root", () => {
  const { root, env } = lockRoot();
  mkdirSync(join(root, "locks", "obligation-id-2.lock"), { recursive: true });
  const attempt = attemptObligationLock("id-2", 0, env);
  expect(attempt.lock).toBeNull();
  expect((attempt.failure as NodeJS.ErrnoException).code).toBe("EISDIR");
  expect(attempt.path).toBe(join(root, "locks", "obligation-id-2.lock"));
  // acquireObligationLock keeps its contract: null, no throw.
  expect(acquireObligationLock("id-2", 0, env)).toBeNull();
});

test("an uncreatable lock directory keeps its failure instead of throwing", () => {
  const { root, env } = lockRoot();
  writeFileSync(join(root, "blocker"), "a file where the parent directory should be");
  const attempt = attemptObligationLock("id-3", 0, { ...env, TAP_LOCK_DIR: join(root, "blocker", "locks") });
  expect(attempt.lock).toBeNull();
  expect((attempt.failure as NodeJS.ErrnoException).code).toBe("ENOTDIR");
});
