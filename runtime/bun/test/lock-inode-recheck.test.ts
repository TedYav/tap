// tap-yyu28: a flock is a claim on an INODE. If the lock path is unlinked and recreated between an opener's
// open and its grant, the opener is granted an orphan nobody else contends for while the next opener locks a
// different file at the same name: two holders of one lock. `acquireFlock` therefore compares the granted
// descriptor with the file at the path after the grant and, on a mismatch, lets go and takes the current file.
import { expect, test } from "bun:test";
import { existsSync, fstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KERNEL_LOCK, acquirePathLock, acquirePathLockAsync, kernelLockArgs } from "../src/panelock";
import { acquireFlock, acquireFlockAsync, namesCurrentFile, sameIdentity } from "../src/remind-lock";
import { reapStaleSidecars } from "../src/spool-sidecar";

function scratch(): { root: string; lock: string } {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "lockino-"));
  return { root, lock: join(root, "x.lock") };
}

test("namesCurrentFile compares the descriptor with the path's current file", () => {
  const { root, lock } = scratch();
  try {
    const held = acquireFlock(lock, 0, false)!;
    expect(namesCurrentFile(held.fd, lock)).toBe(true);
    unlinkSync(lock);
    expect(namesCurrentFile(held.fd, lock)).toBe(false);          // unlinked
    writeFileSync(lock, "");
    expect(namesCurrentFile(held.fd, lock)).toBe(false);          // recreated: a different inode
    held.release();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an async waiter that opened a file unlinked before its grant locks the successor, not the orphan", async () => {
  const { root, lock } = scratch();
  try {
    const first = acquireFlock(lock, 0, false)!;
    const pending = acquireFlockAsync(lock, 10_000, false, undefined, "unavailable");
    await Bun.sleep(150);                       // the waiter has opened X and is retrying
    unlinkSync(lock);
    first.release();                            // the waiter is granted X, which is now an orphan
    const second = (await pending)!;
    expect(second).not.toBeNull();
    // The waiter must hold the file AT the path: a further acquirer contends with it.
    expect(fstatSync(second.fd).ino).toBe(statSync(lock).ino);
    expect(acquireFlock(lock, 0, false)).toBeNull();
    second.release();
    const again = acquireFlock(lock, 0, false);
    expect(again).not.toBeNull();
    again!.release();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a sync waiter behind a real holder that unlinks the lock on exit locks the successor", () => {
  const { root, lock } = scratch();
  try {
    mkdirSync(root, { recursive: true });
    const held = `${lock}.held`;
    const holder = Bun.spawn([KERNEL_LOCK, ...kernelLockArgs(lock, 30_000, ["sh", "-c", 'touch "$0"; sleep 1; rm -f "$1"', held, lock])], { stdout: "ignore", stderr: "ignore" });
    try {
      const deadline = Date.now() + 5000;
      while (!existsSync(held)) {
        if (Date.now() > deadline) throw new Error("holder never took the lock");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      // Opens X while it is held; the holder unlinks it and exits; the grant lands on the orphan.
      const second = acquirePathLock(lock, 10_000);
      expect(second).not.toBeNull();
      expect(acquirePathLock(lock, 0)).toBeNull();
      second!.release();
    } finally { holder.kill(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the async path lock behaves the same across an unlink", async () => {
  const { root, lock } = scratch();
  try {
    const first = acquirePathLock(lock, 0)!;
    const pending = acquirePathLockAsync(lock, 10_000);
    await Bun.sleep(150);
    unlinkSync(lock);
    first.release();
    const second = (await pending)!;
    expect(second).not.toBeNull();
    expect(acquirePathLock(lock, 0)).toBeNull();
    await second.release();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a sweep never leaves a live lock behind: a held aged lock survives, an unheld one goes, and a re-taken one excludes", () => {
  const { root } = scratch();
  const spool = join(root, "spool"), payloads = join(root, "payloads");
  try {
    mkdirSync(spool, { recursive: true });
    mkdirSync(payloads, { recursive: true });
    const held = join(spool, "busy.meta.json.lock"), idle = join(spool, "idle.meta.json.lock");
    const holder = acquirePathLock(held, 0)!;
    const old = new Date(Date.now() - 4000 * 1000);
    for (const p of [held, idle]) { writeFileSync(p, ""); utimesSync(p, old, old); }
    reapStaleSidecars(spool, payloads);
    expect(existsSync(held)).toBe(true);        // an active id's lock file older than the horizon is not swept
    expect(existsSync(idle)).toBe(false);
    expect(acquirePathLock(held, 0)).toBeNull();
    holder.release();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("identities compare as BigInts: two inodes that round to one Number are two files", () => {
  const near = 2n ** 53n;
  expect(Number(near)).toBe(Number(near + 1n));               // the collapse a Number comparison would have
  expect(sameIdentity({ dev: 1n, ino: near }, { dev: 1n, ino: near + 1n })).toBe(false);
  expect(sameIdentity({ dev: 1n, ino: near }, { dev: 2n, ino: near })).toBe(false);
  expect(sameIdentity({ dev: 1n, ino: near + 1n }, { dev: 1n, ino: near + 1n })).toBe(true);
});

test("with noFollow a path swapped to a symlink at the same inode fails the check; followed, it passes", () => {
  const { root, lock } = scratch();
  try {
    const held = acquireFlock(lock, 0, true)!;
    const moved = `${lock}.moved`;
    renameSync(lock, moved);
    symlinkSync(moved, lock);                                  // the path now leads to the very inode we hold
    expect(namesCurrentFile(held.fd, lock, true)).toBe(false); // the open refused symlinks: lstat sees a link, not this file
    expect(namesCurrentFile(held.fd, lock, false)).toBe(true); // a followed open would still be at the same file
    held.release();
    // Reopening a symlinked path under noFollow refuses by name rather than locking through the link.
    expect(() => acquireFlock(lock, 0, true)).toThrow(/symlinked lock path/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** Churn the lock file under an async waiter: each round replaces the file at the path and hands the waiter
 * the previous (now orphan) one, so the waiter drops a grant and reopens once per round. */
async function churn(lock: string, rounds: number, pending: Promise<unknown>, first: NonNullable<ReturnType<typeof acquireFlock>>): Promise<{ last: NonNullable<ReturnType<typeof acquireFlock>>; settledEarly: boolean }> {
  let settledEarly = false;
  void pending.then(() => { settledEarly = true; });
  let current = first;
  await Bun.sleep(100);                                        // the waiter has opened the file and is blocked on it
  for (let i = 0; i < rounds && !settledEarly; i++) {
    unlinkSync(lock);
    const next = acquireFlock(lock, 0, false)!;                // a fresh file at the path
    current.release();                                         // the waiter is granted the orphan and must reopen
    current = next;
    await Bun.sleep(150);
  }
  return { last: current, settledEarly };
}

test("an unbounded wait keeps reopening past the churn cap and is granted the stable successor", async () => {
  const { root, lock } = scratch();
  try {
    const first = acquireFlock(lock, 0, false)!;
    const pending = acquireFlockAsync(lock, Infinity, false, undefined, "unavailable");
    // Above MAX_REOPENS (16): a bounded wait would already have reported contention.
    const { last, settledEarly } = await churn(lock, 20, pending, first);
    expect(settledEarly).toBe(false);                          // an unbounded wait never returns null while the file churns
    last!.release();
    const got = await pending;
    expect(got).not.toBeNull();
    expect(fstatSync(got!.fd).ino).toBe(statSync(lock).ino);
    got!.release();
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test("a bounded wait keeps the cap: churn past it reports contention", async () => {
  const { root, lock } = scratch();
  try {
    const first = acquireFlock(lock, 0, false)!;
    const pending = acquireFlockAsync(lock, 60_000, false, undefined, "unavailable");
    const { last } = await churn(lock, 20, pending, first);
    expect(await pending).toBeNull();
    last!.release();
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
