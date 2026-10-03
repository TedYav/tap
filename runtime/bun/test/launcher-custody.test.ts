import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquirePathLockAsync, acquireRegistryLockAsync, isRegistryLock } from "../src/panelock";

test("unbounded launch custody yields to cancellation and release ends the actual kernel hold", async () => {
  const root = mkdtempSync(join(process.env.TAP_INDEX_HOME!, "launch-custody-"));
  const path = join(root, "reset.fence.json.lock");
  const first = await acquirePathLockAsync(path);
  expect(first).not.toBeNull();
  const cancellation = new AbortController();
  const reason = new Error("launch interrupted");
  const waiter = acquirePathLockAsync(path, Infinity, cancellation.signal);
  setTimeout(() => cancellation.abort(reason), 40);
  await expect(waiter).rejects.toBe(reason);
  // Cancelling another waiter cannot release the original owner's lock.
  expect(await acquirePathLockAsync(path, 0)).toBeNull();
  await first!.release();
  const next = await acquirePathLockAsync(path, 0);
  expect(next).not.toBeNull();
  await next!.release();
  await next!.release();
});

test("async registry custody keeps the literal sidecar and invalidates its authority only after release", async () => {
  const root = mkdtempSync(join(process.env.TAP_INDEX_HOME!, "launch-registry-"));
  const path = join(root, "registry.json");
  const lock = await acquireRegistryLockAsync(path);
  expect(lock?.registryLocation).toBe(path);
  expect(isRegistryLock(lock!)).toBe(true);
  expect(await acquirePathLockAsync(`${path}.lock`, 0)).toBeNull();
  await lock!.release();
  expect(isRegistryLock(lock!)).toBe(false);
  const next = await acquirePathLockAsync(`${path}.lock`, 0);
  expect(next).not.toBeNull();
  await next!.release();
});

test("async release resolves only after the holder's cat has ended", async () => {
  const root = mkdtempSync(join(process.env.TAP_INDEX_HOME!, "launch-slow-cat-"));
  const bin = join(root, "bin");
  const path = join(root, "reset.fence.json.lock");
  // A cat that lingers after EOF widens the gap between the shell and its cat.
  mkdirSync(bin);
  writeFileSync(join(bin, "cat"), "#!/bin/sh\n/bin/cat >/dev/null\nsleep 0.5\n");
  chmodSync(join(bin, "cat"), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const held = await acquirePathLockAsync(path, 5000, undefined, env);
  expect(held).not.toBeNull();
  await held!.release();
  const next = await acquirePathLockAsync(path, 0);
  expect(next).not.toBeNull();
  await next!.release();
});
