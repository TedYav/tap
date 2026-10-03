// An atomic lock holder for the reminders queue and its lease.
//
// WHY THIS EXISTS RATHER THAN `acquirePathLock`. The Python this port replaces
// locked with `os.open(path, O_CREAT|O_RDWR|O_NOFOLLOW)` and then `fcntl.flock`
// on THAT descriptor, so the bytes it locked were provably the bytes it opened.
// `panelock.ts` acquires by handing a PATHNAME to `lockf`/`flock`, which open it
// again themselves and expose no `O_NOFOLLOW` -- so a symlinked lock path is
// followed, and no amount of checking the pathname afterwards can attest which
// inode the helper actually locked.
//
// The partner reviewer demonstrated that precisely, against a first fix that opened with
// O_NOFOLLOW, recorded dev/ino, let the helper re-open, and re-checked the path:
// rename the real lock aside, point the path at another file, let the helper take
// a REAL hold on that other inode, then restore the original before the re-check.
// The path check passes, the process publishes, and the lock it "holds" is on a
// file nobody else contends -- while the legitimate owner still holds the real one.
// A post-hoc pathname comparison is not a descriptor proof.
//
// So the open and the lock happen on one descriptor, in this process. `flock(2)`
// through FFI is the same primitive `lockf`, Linux `flock` and Python's
// `fcntl.flock` all use, so this stays mutually exclusive with every existing TAP
// holder of the same sidecar (measured: an independent `lockf -t 0` on the same
// path is refused 75 while this holds, and succeeds once released). The kernel
// drops the lock when the process dies, so there is still no staleness horizon,
// no owner record and no reaping -- the property `panelock.ts` was rewritten for.

import { dlopen, FFIType, read, type Pointer } from "bun:ffi";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, statSync } from "node:fs";
import { dirname } from "node:path";

const LOCK_SH = 1, LOCK_EX = 2, LOCK_NB = 4, LOCK_UN = 8;
export type LockMode = "exclusive" | "shared";

let flockFn: ((fd: number, op: number) => number) | null | undefined;
function flock(): ((fd: number, op: number) => number) | null {
  if (flockFn !== undefined) return flockFn;
  for (const lib of ["libSystem.B.dylib", "libc.so.6", "libc.so"]) {
    try {
      const { symbols } = dlopen(lib, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
      flockFn = symbols.flock as (fd: number, op: number) => number;
      // Resolve the errno reader NOW: loading it after a failed flock(2) runs
      // the loader's own syscalls, which overwrite the errno being read.
      lastErrno();
      return flockFn;
    } catch { /* try the next name */ }
  }
  return (flockFn = null);
}

// The calling thread's errno, read right after a failed flock(2): macOS
// exports it as __error(), glibc as __errno_location(). flock() loads it first.
let errnoFn: (() => number | null) | null | undefined;
function lastErrno(): number | null {
  if (errnoFn === undefined) {
    errnoFn = null;
    for (const [lib, name] of [["libSystem.B.dylib", "__error"], ["libc.so.6", "__errno_location"], ["libc.so", "__errno_location"]] as const) {
      try {
        const { symbols } = dlopen(lib, { [name]: { args: [], returns: FFIType.ptr } });
        const at = symbols[name] as () => Pointer | null;
        errnoFn = () => { const p = at(); return p ? read.i32(p, 0) : null; };
        break;
      } catch { /* try the next name */ }
    }
  }
  return errnoFn ? errnoFn() : null;
}

// EWOULDBLOCK/EAGAIN (35 on macOS, 11 on Linux) is contention; EINTR is a
// retry. Anything else -- ENOLCK, EBADF, EOPNOTSUPP -- will not clear by waiting.
const RETRYABLE = new Set(process.platform === "darwin" ? [35, 4] : [11, 4]);

/** Whether a failed flock(2) with ERRNO may clear by retrying; an unreadable errno is treated as contention. */
export function flockFailureRetryable(errno: number | null): boolean {
  return errno === null || RETRYABLE.has(errno);
}

export class SymlinkedLockPath extends Error {}

/** Whether flock(2) is reachable in-process on this host. */
export function flockAvailable(): boolean {
  return flock() !== null;
}

export interface HeldLock { release(): void }
/** A held lock whose descriptor the holder may also write through (the clear fence). */
export interface HeldFdLock extends HeldLock { readonly fd: number }

/**
 * Acquire the lock, or return null if it stays contended to the deadline.
 *
 * Throws `SymlinkedLockPath` when the path is a symlink -- a refusal, never a
 * fallback, because it is a state the incumbent would not operate in. Throws when
 * `flock(2)` cannot be reached at all, for the same fail-closed reason
 * `panelock.ts` refuses without its kernel helper: silently not locking is the
 * defect, not the portability accommodation.
 */
export function acquireNoFollowLock(lockPath: string, timeoutMs: number): HeldLock | null {
  return acquireFlock(lockPath, timeoutMs, true);
}

/**
 * The shared primitive: open LOCKPATH on a descriptor this process owns
 * (close-on-exec, so children never inherit the hold) and flock(2) it within
 * TIMEOUTMS. NOFOLLOW refuses a symlinked path; without it the path is
 * followed, as `lockf`/`flock(1)` follow it. UNAVAILABLE is the fail-closed
 * error when flock(2) is unreachable.
 */
export function acquireFlock(
  lockPath: string, timeoutMs: number, noFollow: boolean, unavailable = "TAP locking requires flock(2) via FFI, which is unavailable on this host", mode: LockMode = "exclusive",
): HeldFdLock | null {
  let fd = openLockFd(lockPath, noFollow);
  const fn = flock();
  if (!fn) {
    closeSync(fd);
    throw new Error(unavailable);
  }
  const deadline = Date.now() + timeoutMs;
  let backoffMs = 10;
  let reopened = 0;
  let open = true;
  try {
    for (;;) {
      const held = tryHold(fn, fd, mode);
      if (held) {
        if (namesCurrentFile(fd, lockPath, noFollow)) return held;
        // The file this descriptor names was unlinked or replaced between our open and the grant, so
        // we hold a lock nobody contends for. Let go and lock whatever is at the path now.
        held.release();
        open = false;
        if (timeoutMs !== Infinity && ++reopened > MAX_REOPENS) return null;
        fd = openLockFd(lockPath, noFollow);
        open = true;
        continue;
      }
      if (Date.now() >= deadline) { closeSync(fd); open = false; return null; }
      // Jitter only admission waits; never repeat a possible delivery effect.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(deadline - Date.now(), 1 + Math.random() * backoffMs));
      backoffMs = Math.min(80, backoffMs * 2);
    }
  } catch (error) {
    if (open) closeSync(fd);
    throw error;
  }
}

/** acquireFlock that yields to the event loop while it waits, and honors SIGNAL. */
export async function acquireFlockAsync(
  lockPath: string, timeoutMs: number, noFollow: boolean, signal: AbortSignal | undefined, unavailable: string, mode: LockMode = "exclusive",
): Promise<HeldFdLock | null> {
  signal?.throwIfAborted();
  let fd = openLockFd(lockPath, noFollow);
  const fn = flock();
  if (!fn) {
    closeSync(fd);
    throw new Error(unavailable);
  }
  const deadline = Date.now() + timeoutMs;
  let backoffMs = 10;
  let reopened = 0;
  let open = true;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const held = tryHold(fn, fd, mode);
      if (held) {
        if (namesCurrentFile(fd, lockPath, noFollow)) return held;
        held.release();
        open = false;
        if (timeoutMs !== Infinity && ++reopened > MAX_REOPENS) return null;
        fd = openLockFd(lockPath, noFollow);
        open = true;
        continue;
      }
      if (Date.now() >= deadline) { closeSync(fd); open = false; return null; }
      await Bun.sleep(Math.max(1, Math.min(deadline - Date.now(), 1 + Math.random() * backoffMs)));
      backoffMs = Math.min(80, backoffMs * 2);
    }
  } catch (error) {
    if (open) closeSync(fd);
    throw error;
  }
}

/** How many times a BOUNDED acquire drops a grant on an unlinked or replaced file and retakes the path's
 * current one before it reports contention; churn that fast is not a lock anyone can hold. An unbounded wait
 * (`timeoutMs === Infinity`: resend, registry/index) has no such give-up: returning null there would tell a
 * caller that asked to wait for the lock that it was refused, so it keeps following the path until the
 * successor is stable. */
const MAX_REOPENS = 16;

/** Whether two file identities are one file. dev and ino are BigInts: a 64-bit inode can exceed 2^53, where
 * two distinct values round to one Number and would compare equal. */
export function sameIdentity(a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Whether the file FD names is still the file at LOCKPATH (dev and ino). A lock is a claim on an inode: after
 * the grant, a path that was unlinked or recreated since the open means this descriptor holds an orphan while
 * the next opener locks a different file, and two holders each believe they own the same name. The path is
 * compared AFTER the grant, so an unlink that follows it is the unlinker's release to make while it holds this
 * lock, never a second holder's. NOFOLLOW compares the path itself (lstat), as the open refused to follow it:
 * a path swapped to a symlink at the same inode is not the file that was opened, and the reopen then refuses
 * the symlink by name. Without NOFOLLOW the path is followed, as the open followed it.
 */
export function namesCurrentFile(fd: number, lockPath: string, noFollow = false): boolean {
  try {
    const held = fstatSync(fd, { bigint: true });
    const current = noFollow ? lstatSync(lockPath, { bigint: true }) : statSync(lockPath, { bigint: true });
    return sameIdentity(held, current);
  } catch { return false; }
}

function openLockFd(lockPath: string, noFollow: boolean): number {
  mkdirSync(dirname(lockPath), { recursive: true });
  try {
    return openSync(lockPath, constants.O_CREAT | constants.O_RDWR | (noFollow ? constants.O_NOFOLLOW : 0), 0o600);
  } catch (error) {
    if (noFollow && (error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new SymlinkedLockPath(`refusing a symlinked lock path: ${lockPath}`);
    }
    throw error;
  }
}

function tryHold(fn: (fd: number, op: number) => number, fd: number, mode: LockMode): HeldFdLock | null {
  if (fn(fd, (mode === "shared" ? LOCK_SH : LOCK_EX) | LOCK_NB) !== 0) {
    const errno = lastErrno();
    if (flockFailureRetryable(errno)) return null;
    // A lock-system failure refuses now: an unbounded wait must not spin on it.
    throw new Error(`flock(2) failed with errno ${errno}; the lock cannot be taken on this host`);
  }
  let released = false;
  return {
    fd,
    release() {
      if (released) return;
      released = true;
      fn(fd, LOCK_UN);
      closeSync(fd);
    },
  };
}
