// Per-pane submit serialization.
//
// THE DEFECT THIS EXISTS FOR, measured on real tmux panes: two senders
// submitting to ONE pane concurrently produce a FUSED LINE — both sentinels in
// a single submitted turn — and BOTH senders exit 0. The band read-back cannot
// see it: it asks "did my id leave the band", and the id did leave, glued to
// someone else's.
//
// THIS FILE USED TO BE FOUR TIMES LONGER, AND THAT WAS THE BUG.
//
// Three custom representations came and went here — an O_EXCL file, an atomic
// mkdir, then a link(2)-published owner record — each with hand-written rules
// for a question the kernel already answers: is the holder still alive? Every
// version leaked a different ownership-theft path, because "did this lock's
// owner die" is not decidable from the filesystem, and each fix moved the
// window rather than closing it:
//
//   - malformed owner JSON parsed to `{}`, reached processAlive(undefined),
//     and was classified DEAD, so an unknown lock was stolen;
//   - release removed an unreadable REPLACEMENT, because the predicate was
//     "no valid owner disagrees with me" rather than "a valid owner IS me";
//   - dead-owner reaping was check-then-unlink BY PATH, so a reaper could
//     delete A, another could publish B, and the first could then unlink B.
//
// A previous comment in this file claimed macOS ships no flock, and inferred
// that custom stale-owner rules were therefore necessary. THAT PREMISE WAS
// FALSE, and the partner reviewer caught it: this host ships /usr/bin/lockf, whose own
// manual page says it uses BSD flock(2) and that "the mere existence of the
// file is not considered to constitute a lock." Verified here before adopting:
// a second acquirer is refused while the first holds (rc 75), succeeds after
// release, and — the property that deletes all of the above — succeeds after
// the holder is SIGKILLed, because the KERNEL drops the lock when the process
// dies. No liveness inference, no owner record, no reaping, no staleness
// horizon. Those were an entire category of code written to work around a
// primitive that was already installed.
//
// It remains true that bun exposes no flock BINDING; the fix was to stop
// treating "no binding in this runtime" as "no primitive on this machine."

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { acquireFlock, acquireFlockAsync, flockAvailable, type LockMode } from "./remind-lock";

export interface PaneLock {
  release(fenceTimeoutMs?: number): void;
}

export interface AsyncPaneLock {
  release(): Promise<void>;
}

export type AsyncRegistryLock = AsyncPaneLock & Omit<RegistryLock, "release">;

declare const registryLockBrand: unique symbol;
const REGISTRY_LOCK_BRAND: typeof registryLockBrand = Symbol("tap.RegistryLock") as typeof registryLockBrand;

/**
 * Path-bound acting-registry lock. Minted only by `acquireRegistryLock`.
 * A plain `{ registryLocation, release() }` is not this type.
 *
 * `registryLocation` is the path as acquired — the index-recorded literal —
 * and the sidecar is `${literal}.lock`. Mixed Bash/Bun writers share that
 * sidecar. Do not realpath this field; canonical equality lives on Selection.
 */
export type RegistryLock = {
  readonly [registryLockBrand]: typeof registryLockBrand;
  /** Index-recorded acting registry path — never the `.lock` sidecar. */
  readonly registryLocation: string;
  release(): void;
};

export function isRegistryLock(value: object): value is RegistryLock {
  return (value as { [registryLockBrand]?: unknown })[REGISTRY_LOCK_BRAND] === REGISTRY_LOCK_BRAND;
}

/**
 * The lock root, resolved through the ISOLATION AUTHORITY rather than always
 * landing in production. A sandboxed send must not create files under the
 * operator's real ~/.tap/locks, and parallel private tmux servers must not
 * contend on identical pane-address keys. A run pinned only by TAP_HOME keeps
 * its locks WITH ITS BUS: without this tier, a bare fixture run escaped the
 * sandbox and wrote the operator's real ~/.tap/locks (tap-7r3fn.66).
 */
export function lockRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TAP_LOCK_DIR) return env.TAP_LOCK_DIR;
  if (env.TAP_INDEX_HOME) return join(env.TAP_INDEX_HOME, "locks");
  // A caller-pinned bus keeps its locks WITH ITS BUS. The --team override
  // also sets TAP_HOME, but its marker excludes it: derived buses keep the
  // incumbent default so Bash (TAP_BUS_RULE) and Bun stay in lockstep.
  if (env.TAP_HOME && env.TAP_HOME !== env.TAP_TEAM_OVERRIDE_BUS) return join(env.TAP_HOME, "locks");
  return join(homedir(), ".tap", "locks");
}

/**
 * Environment for a child process anchored to a bus this process resolved.
 * Every internal TAP_HOME injection crosses a spawn boundary where the child
 * cannot tell an injected derived bus from a caller pin: without the parent's
 * lock root riding along as the explicit TAP_LOCK_DIR (top of every resolver's
 * chain), the child locks under `<bus>/locks` while the parent — which may run
 * with no TAP_HOME at all — locks under the default root, and the two stop
 * excluding each other on pane and obligation locks (tap-a5j6t, the
 * tap-7r3fn.66 class across a spawn boundary).
 */
export function childBusEnv(busHome: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, TAP_HOME: busHome, TAP_LOCK_DIR: lockRoot(env) };
}

function lockPath(scope: string, key: string, env: NodeJS.ProcessEnv): string {
  const dir = lockRoot(env);
  mkdirSync(dir, { recursive: true });
  const safe = key.replace(/[^A-Za-z0-9_.-]/g, "_");
  // Keep every representable legacy obligation path (16-byte prefix/suffix).
  // A separate directory prevents aliasing a literal short id with its digest.
  if (scope === "obligation" && safe.length > 239) {
    return join(dir, "obligation-long", `${createHash("sha256").update(safe).digest("hex")}.lock`);
  }
  return join(dir, `${scope}-${safe}.lock`);
}

export const paneLockPath = (pane: string, env: NodeJS.ProcessEnv = process.env): string => lockPath("pane-submit", pane, env);

/** Present iff this platform has the kernel-backed helper. */
export const KERNEL_LOCK = process.platform === "linux" ? "/usr/bin/flock" : "/usr/bin/lockf";

/** Both helpers use flock(2), matching Bash's Python fcntl.flock sidecars. */
export function kernelLockArgs(path: string, timeoutMs: number, command: string[]): string[] {
  if (timeoutMs === Infinity) { // wait indefinitely: the helpers' own default with no --timeout/-t
    return process.platform === "linux"
      ? ["--exclusive", "--no-fork", path, ...command]
      : ["-k", path, ...command];
  }
  const seconds = String(Math.ceil(timeoutMs / 1000));
  // No supervisory fork: the child we terminate must be the lock holder.
  // Neither platform unlinks the sidecar after release.
  return process.platform === "linux"
    ? ["--exclusive", "--no-fork", "--timeout", seconds, path, ...command]
    : ["-k", "-t", seconds, path, ...command];
}

/**
 * Whether this host can hold TAP's locks. The locks themselves are held
 * in-process through flock(2); KERNEL_LOCK remains the helper Bash callers
 * and the spool reaper use on the same sidecars.
 */
export function kernelLockAvailable(): boolean {
  return flockAvailable() && existsSync(KERNEL_LOCK);
}

/**
 * Acquire the pane's submit lock, or null when another submit holds it.
 *
 * NULL IS A PARK, NEVER A PROCEED. Waiting a bounded time and then continuing
 * unlocked re-creates the exact fused line this prevents, and does it silently.
 *
 * HOW THE HOLD IS EXPRESSED. This process holds flock(2) on a descriptor it
 * opened; releasing unlocks and closes it, and this process dying drops it.
 * The lock therefore belongs to a PROCESS rather than to a file's contents —
 * which is the whole point, since a process's death is a fact the kernel
 * knows and a file's contents are a guess.
 */
export function acquirePaneLock(
  pane: string,
  timeoutMs = 5000,
  env: NodeJS.ProcessEnv = process.env,
): PaneLock | null {
  return acquireKernelLock("pane-submit", pane, timeoutMs, env);
}

/** Serialize resize/restore across every pane sharing one tmux window. */
export function acquireWindowRepaintLock(
  server: string,
  windowId: string,
  timeoutMs = 5000,
  env: NodeJS.ProcessEnv = process.env,
): PaneLock | null {
  const key = createHash("sha256").update(`${server}\0${windowId}`).digest("hex");
  return acquireKernelLock("window-repaint", key, timeoutMs, env);
}

/** Serialize the full eligibility/effect/receipt cycle for one obligation. */
export function acquireObligationLock(
  id: string,
  timeoutMs = 5000,
  env: NodeJS.ProcessEnv = process.env,
): PaneLock | null {
  return acquireKernelLock("obligation", id, timeoutMs, env);
}

/** One bounded acquisition and why it ended: a held lock, or null with the original failure (null failure = contention). */
export interface LockAttempt { lock: PaneLock | null; failure: Error | null; path: string }

/**
 * `acquireObligationLock`, keeping the reason a bounded acquisition came back empty.
 * A null lock with no failure is contention or timeout. A failure is what the
 * acquisition itself raised (EACCES, EROFS, EISDIR, a non-retryable flock errno):
 * waiting will not clear it, and the caller should say so instead of blaming
 * another process. Unbounded waits and an unavailable flock still throw.
 */
export function attemptObligationLock(
  id: string,
  timeoutMs = 5000,
  env: NodeJS.ProcessEnv = process.env,
): LockAttempt {
  let path = join(lockRoot(env), `obligation-${id.replace(/[^A-Za-z0-9_.-]/g, "_")}.lock`);
  try { path = lockPath("obligation", id, env); } // also creates the lock directory
  catch (error) { return { lock: null, failure: error as Error, path }; }
  return attemptKernelLockAt(path, timeoutMs);
}

/** Serialize readers that must observe one coherent acting-registry snapshot. */
export function acquireRegistryLock(
  registryPath: string,
  timeoutMs = 5000,
  env: NodeJS.ProcessEnv = process.env,
): RegistryLock | null {
  const literal = literalActingRegistry(registryPath);
  const held = acquireKernelLockAt(`${literal}.lock`, timeoutMs, env);
  if (!held) return null;
  const token = {
    [REGISTRY_LOCK_BRAND]: REGISTRY_LOCK_BRAND,
    registryLocation: literal,
    release() {
      held.release();
      Reflect.deleteProperty(token, REGISTRY_LOCK_BRAND);
    },
  };
  return token as RegistryLock;
}

function literalActingRegistry(registryPath: string): string {
  if (registryPath.endsWith(".lock")) {
    const stem = registryPath.slice(0, -".lock".length);
    if (existsSync(stem)) {
      throw new Error(
        `acquireRegistryLock takes the acting registry file, not the sidecar '${registryPath}'`,
      );
    }
  }
  return registryPath;
}

/** Acquire an already-resolved exact sidecar path. */
export function acquirePathLock(
  path: string,
  timeoutMs = 5000,
  env: NodeJS.ProcessEnv = process.env,
  mode: LockMode = "exclusive",
): PaneLock | null {
  return acquireKernelLockAt(path, timeoutMs, env, mode);
}

function acquireKernelLock(
  scope: string,
  key: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): PaneLock | null {
  const path = lockPath(scope, key, env);
  return acquireKernelLockAt(path, timeoutMs, env);
}

// The helpers' `-t`/`--timeout` took whole seconds, so every bounded caller was
// tuned against a wait rounded UP to the next second. The in-process wait keeps
// that bound; zero still means one attempt.
function helperWaitMs(timeoutMs: number): number {
  return timeoutMs === Infinity || timeoutMs <= 0 ? Math.max(0, timeoutMs) : Math.ceil(timeoutMs / 1000) * 1000;
}

const UNSERIALIZED =
  "pane serialization requires flock(2), which is not reachable on this host. " +
  "Refusing to submit unserialized: concurrent senders would fuse into one line " +
  "with both reporting success.";

function acquireKernelLockAt(
  path: string,
  timeoutMs: number,
  _env: NodeJS.ProcessEnv,
  mode: LockMode = "exclusive",
): PaneLock | null {
  return attemptKernelLockAt(path, timeoutMs, mode).lock;
}

function attemptKernelLockAt(path: string, timeoutMs: number, mode: LockMode = "exclusive"): LockAttempt {
  // HELD IN THIS PROCESS. The lock used to belong to a spawned `lockf`/`flock`
  // helper parked on `cat`, which cost two process spawns per lock (the grant,
  // then a `lockf ... true` fence to prove the release) plus 10 ms marker
  // polls: ~100 ms of every `tap in` (verb-prelude row F). flock(2) on a
  // descriptor this process opened is the same primitive those helpers, Bash
  // and Python's fcntl.flock use, so every existing holder still excludes this
  // one. The kernel still owns liveness: the hold ends when this process
  // closes the descriptor or dies, with no owner record and no reaping. The
  // descriptor is close-on-exec, so a child spawned inside a critical section
  // never extends the hold. The path is followed, as the helpers followed it.
  let held;
  try {
    held = acquireFlock(path, helperWaitMs(timeoutMs), false, UNSERIALIZED, mode);
  } catch (error) {
    // An unusable sidecar (EISDIR/ENOTDIR/EACCES): an unbounded wait fails
    // HERE, promptly, as it always did; a bounded one is a refusal that keeps its cause.
    if ((error as Error).message === UNSERIALIZED || timeoutMs === Infinity) throw error;
    return { lock: null, failure: error as Error, path };
  }
  if (!held) return { lock: null, failure: null, path };
  // Release is synchronous and complete: the hold has ended when it returns,
  // which is what the helper's post-release `lockf ... true` fence proved.
  return { lock: { release: (_fenceTimeoutMs?: number) => held.release() }, failure: null, path };
}

/** Same in-process flock as the synchronous API; yielding makes unbounded waits cancellable. */
export async function acquirePathLockAsync(
  path: string,
  timeoutMs = Infinity,
  signal?: AbortSignal,
  _env: NodeJS.ProcessEnv = process.env,
  mode: LockMode = "exclusive",
): Promise<AsyncPaneLock | null> {
  let held;
  try {
    held = await acquireFlockAsync(path, helperWaitMs(timeoutMs), false, signal, UNSERIALIZED, mode);
  } catch (error) {
    if (signal?.aborted || (error as Error).message === UNSERIALIZED || timeoutMs === Infinity) throw error;
    return null;
  }
  if (!held) return null;
  return { release: async () => held.release() };
}

export async function acquireRegistryLockAsync(
  registryPath: string,
  timeoutMs = Infinity,
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AsyncRegistryLock | null> {
  const literal = literalActingRegistry(registryPath);
  const held = await acquirePathLockAsync(`${literal}.lock`, timeoutMs, signal, env);
  if (!held) return null;
  const token = {
    [REGISTRY_LOCK_BRAND]: REGISTRY_LOCK_BRAND,
    registryLocation: literal,
    async release() {
      await held.release();
      Reflect.deleteProperty(token, REGISTRY_LOCK_BRAND);
    },
  };
  return token as AsyncRegistryLock;
}
