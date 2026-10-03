// The entry sidecar: everything that reads or mutates `spool/<id>.meta.json`
// and its two neighbours, `<id>.meta.json.lock` and `<id>.claim`. Ported from
// lib.sh as a strangler-fig slice; the Bash bodies are deleted in the same PR.
//
// FOUR DIFFERENT LOCKING DISCIPLINES LIVE HERE, and they are not
// interchangeable. Collapsing any pair of them would be a silent correctness
// change, so each one says which it is and why:
//
//   - `remove` WAITS for the meta lock, as the incumbent did, and holds it
//     across payload + meta + lease so a concurrent re-own cannot mint an owner
//     for an entry being terminalized — see `removeEntry` for why this wait is
//     not bounded like publication's;
//   - `bumpAttempts` takes NO lock, matching the incumbent, because a lost
//     increment delays accounting while a blocked courier stalls delivery;
//   - `claimAcquire` is an O_EXCL create with a staleness steal — a DIFFERENT
//     transaction from the meta lock and from the pane lock, and one of this
//     repo's three standing refusals: it is not redundant with either;
//   - `reapStaleSidecars` uses non-blocking flock throughout, because a sweeper
//     that blocks is a sweeper that can wedge whatever it was tidying up after.
//
// Reowner lease protocol stays in spool-reown; this reaper only retires an old
// detached lease after proving that its entry and claim are absent.

import { randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { acquireObligationLock, acquirePathLock, acquirePathLockAsync } from "./panelock";
import { PyFloat, PyInt, metaBytes, parseMetaPreservingFloats, pyInt, pyTruthy } from "./spool-publication";
import { reparkLicensed, retainedStagedIdleCopy, unverifiedCanonical } from "./delivery-custody";
import { atomicWrite, lockNameFits } from "./fsatomic";
import { markResetGenerationReused, withResetCustody } from "./reset";

/** Matches the incumbent's `${TAP_SPOOL_CLAIM_STALE_SECONDS:-300}`. */
const CLAIM_STALE_DEFAULT = 300;

function staleSeconds(env: NodeJS.ProcessEnv): number {
  const raw = env.TAP_SPOOL_CLAIM_STALE_SECONDS;
  if (!raw) return CLAIM_STALE_DEFAULT;
  // The incumbent passes this through Python `int()`, which raises on junk and
  // takes the whole program down — so a malformed value is a hard refusal
  // there, not a default. Reproduce the refusal rather than inventing a
  // fallback the incumbent does not have.
  const value = pyInt(raw);
  if (value === null) throw new Error(`TAP_SPOOL_CLAIM_STALE_SECONDS is not an integer: ${raw}`);
  return value;
}

export function metaPath(spoolDir: string, id: string): string {
  return join(spoolDir, `${id}.meta.json`);
}
export function payloadPath(spoolDir: string, id: string): string {
  return join(spoolDir, `${id}.md`);
}
export function claimPath(spoolDir: string, id: string): string {
  return join(spoolDir, `${id}.claim`);
}

/**
 * One field, or "". Every failure is "" — a missing file, unreadable JSON, a
 * missing key, and a key whose value is falsy all read the same, because the
 * incumbent's `.get(key) or ""` cannot tell them apart either and its callers
 * are written against that.
 */
export function metaField(spoolDir: string, id: string, key: string): string {
  try {
    const text = readFileSync(metaPath(spoolDir, id), "utf8");
    const row = parseMetaPreservingFloats(text);
    // Python `or ""`: every falsy value — 0, 0.0, -0.0, False, "", None, [],
    // {} — and an absent key all yield "".
    const value = row[key];
    if (!pyTruthy(value)) return "";
    return pyPrint(value);
  } catch { return ""; }
}

/**
 * What Python's `print(value)` puts on stdout, which is what the incumbent's
 * callers have always read. `JSON.stringify` is the wrong function here in
 * three separate ways, and each one produces a plausible-looking string rather
 * than an obvious failure: `true` prints as `True`, a whole float prints as
 * `1.0` rather than `1`, and a container prints in Python's repr with single
 * quotes. Only scalars are reachable through today's callers, but "unreachable"
 * is a claim about callers, not about the function.
 */
export function pyPrint(value: unknown): string {
  if (value instanceof PyFloat) return value.repr();
  if (value instanceof PyInt) return value.source;
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  if (value === null) return "None";
  if (Array.isArray(value)) return `[${value.map(pyPrint2).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).map(([k, v]) => `${pyPrint2(k)}: ${pyPrint2(v)}`).join(", ")}}`;
  }
  return String(value);
}

/** Python reprs a string INSIDE a container, and prints it bare at top level. */
function pyPrint2(value: unknown): string {
  if (typeof value === "string") return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  return pyPrint(value);
}

/**
 * Best-effort +1 after a delivery attempt. UNLOCKED, exactly as the incumbent:
 * a concurrent whole-meta replace can drop this increment, and that is the
 * accepted direction — a lost increment delays accounting, while blocking here
 * would stall the courier on a held lock. The live-probe counter is the writer
 * that DOES take the lock, and it stays where it is.
 */
export function bumpAttempts(spoolDir: string, id: string): void {
  const path = metaPath(spoolDir, id);
  try {
    if (!statSync(path).isFile()) return;
    const row = parseMetaPreservingFloats(readFileSync(path, "utf8"));
    const current = pyInt(row.attempts ?? 0);
    row.attempts = current === null ? 1 : current + 1;
    // The incumbent writes `<path>.tmp` and replaces; same fixed name, because
    // a crashed writer's leftover must be overwritten rather than accumulate.
    //
    // NO TRAILING NEWLINE, unlike the publication writer: this site's
    // `json.dump` has no `fh.write("\n")` after it, so a bumped sidecar ends at
    // `}`. The two writers genuinely differ, and matching the wrong one changes
    // the file's bytes on every delivery attempt.
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, metaBytes(row as Record<string, never>).replace(/\n$/, ""));
    renameSync(tmp, path);
  } catch { /* best effort: an attempt was made whether or not the count lands */ }
}

/** The holder's proof of ownership: a random nonce written into the claim body. `claimRelease` unlinks only a claim
 * carrying it, so a slow holder whose claim was stolen cannot remove the stealer's (tap-scfhv). */
export type ClaimToken = string;
export type ClaimResult = { status: "held" } | { status: "acquired"; token: ClaimToken };

/** Test seams, the same style as `notifyDigestSenders`' `acquire`. `afterObserve` fires after the staleness
 * decision and before the mutex is taken: the window where a swap must be caught by the identity recheck.
 * `underMutex` fires after that recheck passed and before the unlink: the window where the mutex itself, and
 * a release that must run inside it, are the only protection. `claimRelease` uses `underMutex` alone. */
export interface ClaimHooks { afterObserve?: () => void; underMutex?: () => void }

/** A spool-wide LEAF mutex over every destroyer of `<id>.claim`. Its path comes from `spoolDir` alone (never the
 * lock root, which acquire and release could resolve differently), nothing else is taken while it is held, and
 * nothing sweeps it. Creation of a claim stays an unlocked `wx`. */
const CLAIM_MUTEX = ".claim.lock";
// `acquirePathLock` rounds every positive wait UP to whole seconds (panelock `helperWaitMs`), so the effective
// bound is 1 s. The constants say so rather than advertise a 250 ms the primitive cannot honor; zero stays one attempt.
const CLAIM_STEAL_WAIT_MS = 1000;
const CLAIM_RELEASE_WAIT_MS = 1000;
const claimMutexPath = (spoolDir: string): string => join(spoolDir, CLAIM_MUTEX);

interface ClaimIdentity { dev: number; ino: number; mtimeMs: number }
/** lstat, no-follow: the tuple names the claim itself. `ino` alone is not identity (ext4 reuses inode numbers). */
function claimIdentity(path: string): ClaimIdentity {
  const stat = lstatSync(path);
  return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs };
}
const sameClaim = (a: ClaimIdentity, b: ClaimIdentity): boolean => a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs;

/**
 * Unlink `path` only if, under the claim mutex, it is still the file the staleness decision saw. Once every
 * destroyer is serialized the name can change only through a destroyer, and an unlocked `wx` cannot create
 * while the name is occupied, so between this lstat and the unlink nothing can replace the claim.
 * "gone" means someone else already removed it; "busy" means the mutex was not taken in time (safe: skip).
 */
function destroyClaimIfUnchanged(spoolDir: string, path: string, seen: ClaimIdentity, waitMs: number,
  env: NodeJS.ProcessEnv, hooks?: ClaimHooks): "removed" | "changed" | "gone" | "busy" {
  hooks?.afterObserve?.();
  let lock: ReturnType<typeof acquirePathLock>;
  try { lock = acquirePathLock(claimMutexPath(spoolDir), waitMs, env); } catch { return "busy"; }
  if (!lock) return "busy";
  try {
    let now: ClaimIdentity;
    try { now = claimIdentity(path); } catch { return "gone"; }
    if (!sameClaim(seen, now)) return "changed";
    hooks?.underMutex?.();
    try { unlinkSync(path); } catch { return "busy"; }
    return "removed";
  } finally { lock.release(); }
}

/**
 * The publication/drain claim: an O_EXCL create, with one steal of a claim
 * older than the staleness horizon.
 *
 * NOT the meta lock and NOT the pane lock. It spans a canonical-to-spool
 * custody transfer that outlives any single critical section, which is why a
 * pane lock cannot stand in for it and why `.claim` is one of the three
 * refusals this repo keeps written down.
 *
 * `noSteal` is the readers' mode: a reader must never reclaim a live claim,
 * because the holder is mid-transfer and the reader only wants to look.
 */
const HELD: ClaimResult = { status: "held" };

export function claimAcquire(spoolDir: string, id: string, noSteal = false, env: NodeJS.ProcessEnv = process.env, hooks?: ClaimHooks): ClaimResult {
  const path = claimPath(spoolDir, id);
  const stale = staleSeconds(env);
  const now = Math.floor(Date.now() / 1000);
  // Two passes: create, and — after a successful steal — create again. A third
  // pass would be a retry loop against a live competitor, which is how two
  // holders end up believing they won.
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      mkdirSync(dirname(path), { recursive: true });
      fd = openSync(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return HELD;
      if (noSteal) return HELD;
      // The staleness decision is made on THIS identity; the unlink is licensed only if the
      // claim under the mutex is still that same file (see `destroyClaimIfUnchanged`).
      let seen: ClaimIdentity;
      try { seen = claimIdentity(path); } catch { continue; }
      if (now - Math.floor(seen.mtimeMs / 1000) <= stale) return HELD;
      const outcome = destroyClaimIfUnchanged(spoolDir, path, seen, CLAIM_STEAL_WAIT_MS, env, hooks);
      if (outcome === "changed" || outcome === "busy") return HELD;
      continue;
    }
    try {
      // Python's `json.dump` default separators, `", "` and `": "` — this file
      // is written without `indent`, so it is the one place in the spool where
      // the spaced form is correct.
      const token = randomBytes(16).toString("hex");
      const body = `{"v": 1, "id": ${JSON.stringify(id)}, "owner_pid": ${process.pid}, "claimed_at_epoch": ${now}, "nonce": "${token}"}`;
      writeFileSync(fd, `${body}\n`);
      return { status: "acquired", token };
    } finally { closeSync(fd); }
  }
  return HELD;
}

/** Release runs under the claim mutex, so a reaper that has just judged this claim stale cannot unlink a
 * successor created between its lstat and its unlink, and only when the claim on disk still carries the
 * caller's token, so a slow holder whose claim was stolen cannot remove the stealer's. It never throws:
 * callers release in `finally`, and a missed release only leaves a claim that ages to stale. A mismatched or
 * unreadable body is a no-op. Returns whether it removed the claim, for tests and diagnostics. */
export function claimRelease(spoolDir: string, id: string, token: ClaimToken, env: NodeJS.ProcessEnv = process.env, hooks?: ClaimHooks): boolean {
  return releaseUnderMutex(spoolDir, id, token, env, hooks);
}

/** The CLI `release` mode's tokenless release (a smoke's cleanup, no caller-held token exists): unconditional,
 * still under the mutex. Library callers hold a token and use `claimRelease`. */
export function claimReleaseUnconditionally(spoolDir: string, id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return releaseUnderMutex(spoolDir, id, null, env);
}

function releaseUnderMutex(spoolDir: string, id: string, token: ClaimToken | null, env: NodeJS.ProcessEnv, hooks?: ClaimHooks): boolean {
  try {
    const path = claimPath(spoolDir, id);
    // Nothing to destroy is not worth a lock, and locking must not create the spool directory.
    if (!lstatSync(path, { throwIfNoEntry: false })) return false;
    const lock = acquirePathLock(claimMutexPath(spoolDir), CLAIM_RELEASE_WAIT_MS, env);
    if (!lock) return false;
    try {
      if (token !== null && claimNonce(path) !== token) return false;
      hooks?.underMutex?.();
      rmSync(path, { force: true });
      return true;
    } finally { lock.release(); }
  } catch { return false; /* a missed release is a claim that ages to stale */ }
}

/** The nonce in a claim body, or null for anything that is not a regular file with a string nonce (a legacy
 * claim minted before nonces, a FIFO, junk): those never match a token, so they are never released by one. */
function claimNonce(path: string): string | null {
  try {
    if (!lstatSync(path).isFile()) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const nonce = (parsed as { nonce?: unknown } | null)?.nonce;
    return typeof nonce === "string" && nonce !== "" ? nonce : null;
  } catch { return null; }
}

/**
 * Read-only claim observation for the reader's bounded wait (tap-4b7ib). The
 * verdict separates REAL contention — a well-formed claim some process is
 * holding through a custody transfer — from broken evidence no holder can ever
 * release: a non-regular file, junk bytes, a foreign id (`invalid`) or a valid
 * claim already past the steal horizon (`stale`). A reader must refuse the
 * broken shapes immediately instead of waiting out the ceiling on them.
 * `acquire` keeps its own meaning for its callers: under no-steal it still
 * refuses every EEXIST, so an `invalid` observation only skips the wait, never
 * widens what a claim holder may do. Nothing here writes or steals.
 */
export function claimObserve(spoolDir: string, id: string, env: NodeJS.ProcessEnv = process.env): "free" | "held" | "stale" | "invalid" {
  const path = claimPath(spoolDir, id);
  let stat: { isFile(): boolean; mtimeMs: number };
  // No-follow on purpose: a symlink alias to a real claim is still not a
  // regular claim file — observation classifies the name, not the target.
  try { stat = lstatSync(path); } catch { return "free"; }
  if (!stat.isFile()) return "invalid";
  let parsed: { v?: unknown; id?: unknown; owner_pid?: unknown; claimed_at_epoch?: unknown };
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { return "invalid"; }
  if (typeof parsed !== "object" || parsed === null || parsed.v !== 1 || parsed.id !== id) return "invalid";
  // Only the minted shape counts as a live holder: a reader that waits on
  // anything less is waiting on nothing.
  if (typeof parsed.owner_pid !== "number" || !Number.isInteger(parsed.owner_pid) || parsed.owner_pid <= 0) return "invalid";
  if (typeof parsed.claimed_at_epoch !== "number" || !Number.isFinite(parsed.claimed_at_epoch)) return "invalid";
  const age = Math.floor(Date.now() / 1000) - Math.floor(stat.mtimeMs / 1000);
  return age > staleSeconds(env) ? "stale" : "held";
}

/**
 * Payload, metadata and the `.reown` lease are unlinked TOGETHER, under the
 * entry's meta lock, after the metadata is archived — the incumbent's shape,
 * and CONTRACT.md's ("Removing a spool entry is one locked step").
 *
 * Separate unlinks leave a window in which a re-own observes a payload being
 * terminalized and mints a successor owner for an entry about to stop existing
 * — a waiter spawned for a dead id, and a fresh lease written after the unlink.
 * Under the lock the re-own runs either entirely before this (and its lease is
 * unlinked here) or entirely after (and finds no payload). Calling that window
 * small does not change the invariant.
 *
 * THE WAIT IS NOT BOUNDED THE WAY PUBLICATION'S IS, and the reason is the
 * callers, not the lock. Publication's bound was ratified because a refused
 * park produces a receipt where an unbounded wait produces a stalled courier.
 * Removal's Bash callers — the retained drain engine, `tap-send.sh`, `tap-cancel.sh`
 * — run `set -euo pipefail` and call `tap_spool_remove` as a bare statement,
 * written against an incumbent that could not return nonzero (its trailing
 * `rm -f` belt). A removal that REFUSES on timeout therefore does not surface
 * as a receipt: it aborts the caller after `ln` has hard-linked the payload to
 * canonical and before the spool copy is gone, and the next drain delivers it
 * again. A removal that PROCEEDS unlocked on timeout is the re-own race above
 * (partner review S1, with a real holder). The only shape that is both safe
 * for those callers and faithful to the contract is the incumbent's: wait. A
 * holder that keeps this lock for longer than its millisecond critical section
 * is a wedged process, and a courier wedged behind it is the documented
 * diagnosis ("band wedged: check the flock first"), not a new failure. The
 * helper's grammar needs a number, so the wait is a day — "without bound" for
 * any hold that is not already an incident. Do not "fix" the asymmetry with
 * publication without re-reading the callers.
 *
 * Refusals that DO exist: a missing lock helper (panelock throws; the entry
 * is retained and the caller sees `slice_failed`, exactly as it would for a
 * missing runtime) and the day elapsing. The one unlocked path is a lock NAME
 * the filesystem cannot hold — `lockNameFits` — where no holder can exist.
 *
 * The day does NOT apply under reset custody (tap-12ys6): it would hold every
 * send and reset behind one wedged metadata writer. The native drain's two
 * removals under reset pass `RESET_HELD_LOCK_WAIT_MS`. Neither refusal can
 * redeliver: a retired entry keeps its cancellation receipt and the next pass
 * repeats the idempotent retirement; terminalize has already promoted and
 * evented, so it reports the refusal, returns terminal, and leaves the sidecar
 * to `reapStaleSidecars`.
 */
export const REMOVAL_LOCK_WAIT_MS = 86_400_000;

function archiveAndUnlink(spoolDir: string, id: string): void {
  const meta = metaPath(spoolDir, id), payload = payloadPath(spoolDir, id);
  try {
    if (statSync(meta).isFile()) {
      const archive = join(dirname(dirname(meta)), "archive");
      mkdirSync(archive, { recursive: true });
      writeFileSync(join(archive, basename(meta)), readFileSync(meta));
    }
  } catch { /* an unarchivable or absent sidecar must not block the removal */ }
  // Each unlink swallows its own error, as the incumbent's per-path
  // `except OSError: pass` did. `force` only forgives ENOENT: at the 245-byte
  // boundary the `.reown` name is 261 bytes and raises ENAMETOOLONG, which
  // must not abort the removal after payload and meta are already gone.
  for (const path of [payload, meta, `${meta}.reown`]) {
    try { rmSync(path, { force: true }); } catch { /* the incumbent's own tolerance */ }
  }
}

// Retained synchronous callers (read/cancel) keep their existing interface.
export function removeEntry(spoolDir: string, id: string, env: NodeJS.ProcessEnv = process.env, lockWaitMs = REMOVAL_LOCK_WAIT_MS): void {
  const meta = metaPath(spoolDir, id);
  if (!lockNameFits(`${meta}.lock`)) { archiveAndUnlink(spoolDir, id); return; }
  const lock = acquirePathLock(`${meta}.lock`, lockWaitMs, env);
  if (!lock) throw new Error(`spool_remove: metadata lock for '${id}' still held after ${lockWaitMs} ms; entry retained`);
  try { archiveAndUnlink(spoolDir, id); } finally { lock.release(); }
}

/** Caller holds the id's obligation lock and no-steal spool claim. Retire the
 * direct rc-5 copy before publishing a recipient observation or settlement;
 * a failed removal must leave those receipts unwritten. */
export function retireRetainedStagedCopyUnderClaim(home: string, id: string): boolean {
  if (!retainedStagedIdleCopy(home, id)) return false;
  const spoolDir = join(home, "spool");
  removeEntry(spoolDir, id, process.env, 5000);
  if (existsSync(payloadPath(spoolDir, id)) || existsSync(metaPath(spoolDir, id)))
    throw new Error(`staged-idle copy '${id}' remains after removal`);
  markResetGenerationReused(home, "spool-read");
  return true;
}

/** Same sidecar and writes; cancellation reaps a holder still waiting for grant. */
export async function removeEntryAsync(spoolDir: string, id: string, signal?: AbortSignal,
  env: NodeJS.ProcessEnv = process.env, lockWaitMs = REMOVAL_LOCK_WAIT_MS): Promise<void> {
  signal?.throwIfAborted();
  const meta = metaPath(spoolDir, id);
  if (!lockNameFits(`${meta}.lock`)) { archiveAndUnlink(spoolDir, id); return; }
  const lock = await acquirePathLockAsync(`${meta}.lock`, lockWaitMs, signal, env);
  if (!lock) throw new Error(`spool_remove: metadata lock for '${id}' still held after ${lockWaitMs} ms; entry retained`);
  try { signal?.throwIfAborted(); archiveAndUnlink(spoolDir, id); }
  finally { await lock.release(); }
}

/**
 * Sweep inert writer locks, stale claims, and metadata orphaned by a crashed
 * post-submit cleanup.
 *
 * NON-BLOCKING throughout. A sweeper that waits on a lock is a sweeper that can
 * wedge behind the very writer it exists to clean up after; every acquisition
 * here either succeeds immediately or the candidate is skipped until next time.
 *
 * Lock acquisition now uses in-process flock(2). Watch supplies a bounded
 * candidate batch; explicit maintenance callers may request a complete sweep.
 */
export function reapStaleSidecars(spoolDir: string, payloadsDir: string, env: NodeJS.ProcessEnv = process.env, candidates?: readonly string[], hooks?: ClaimHooks): void {
  let entries: string[];
  try { entries = candidates ? [...candidates].filter(n => basename(n) === n && n !== "." && n !== "..") : readdirSync(spoolDir); } catch { return; }
  const stale = staleSeconds(env);
  const now = Date.now() / 1000;

  const inertLocks: string[] = [];
  for (const name of entries) {
    if (!name.endsWith(".meta.json.lock") && !name.endsWith(".claim")) continue;
    const path = join(spoolDir, name);
    try {
      if (name.endsWith(".claim")) {
        const seen = claimIdentity(path);
        if (now - seen.mtimeMs / 1000 <= stale) continue;
        // Zero wait, as every sweeper: a busy mutex skips this claim until the next pass.
        destroyClaimIfUnchanged(spoolDir, path, seen, 0, env, hooks);
      } else {
        if (now - statSync(path).mtimeMs / 1000 <= stale) continue;
        inertLocks.push(path);
      }
    } catch { /* another sweeper got there first */ }
  }
  sweepUnheldLocks(inertLocks, env);

  // Reowner leases without an entry and obsolete helper handshakes have no
  // current writer to retire them. Age only selects a candidate: custody and
  // a nonblocking metadata lock must still prove it safe to remove.
  for (const name of entries) {
    const reown = name.endsWith(".meta.json.reown");
    const held = /^(.+)\.meta\.json\.lock\.held\.[0-9]+\.[A-Za-z0-9]+$/.exec(name);
    if (!reown && !held) continue;
    const id = reown ? name.slice(0, -".meta.json.reown".length) : held![1]!;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) continue;
    const path = join(spoolDir, name), meta = metaPath(spoolDir, id);
    try {
      if (now - statSync(path).mtimeMs / 1000 <= stale || !lockNameFits(`${meta}.lock`)) continue;
      const obligation = acquireObligationLock(id, 0, env);
      if (!obligation) continue;
      try {
        withResetCustody(dirname(payloadsDir), "spool residue recovery", () => {
          const lock = acquirePathLock(`${meta}.lock`, 0, env);
          if (!lock) return;
          try {
            if (existsSync(claimPath(spoolDir, id))) return;
            if (reown && (existsSync(meta) || existsSync(payloadPath(spoolDir, id)))) return;
            if (now - statSync(path).mtimeMs / 1000 <= stale) return;
            unlinkSync(path);
          } finally { lock.release(); }
        }, 0);
      } finally { obligation.release(); }
    } catch { /* A changed or unobservable candidate stays for another pass. */ }
  }

  // A canonical body without its spool copy never becomes retryable here.
  // Without delivery evidence, preserve its metadata in an unconfirmed receipt
  // before retiring the sidecar; residency alone cannot tell us what happened.
  for (const name of entries) {
    if (!name.endsWith(".meta.json")) continue;
    const id = name.slice(0, -".meta.json".length);
    const meta = join(spoolDir, name);
    // A licensed repark (write-ahead mark, no attempt evidence) leaves this same shape
    // on purpose; its waiter — or the watch drain's recoverStrandedReparks — is moving
    // the body back (spool-repark.ts, tap-conft/tap-c9vlf), so it is no orphan. Mark +
    // attempt evidence is NOT a license: that body is possibly-attempted, and the
    // orphan path below must surface it as unconfirmed (delivery-custody.ts).
    const reparkPending = (): boolean => reparkLicensed(dirname(payloadsDir), id);
    const orphaned = (): boolean =>
      !existsSync(payloadPath(spoolDir, id)) && !existsSync(claimPath(spoolDir, id)) && isFile(join(payloadsDir, `${id}.md`)) && !reparkPending();
    if (!orphaned()) continue;
    // The incumbent's `open(lock_path, "a+")` raised for an uncreatable path and
    // the candidate was skipped; a bounded acquire on the same path would wait.
    // This loop keeps its per-path acquire: the orphan decision below has to
    // be re-taken UNDER the lock, which a fire-and-unlink helper cannot do.
    let fits: boolean;
    try { fits = lockNameFits(`${meta}.lock`); } catch { continue; }
    if (!fits) continue;
    try {
      const obligation = acquireObligationLock(id, 0, env);
      if (!obligation) continue;
      try {
        withResetCustody(dirname(payloadsDir), "spool orphan recovery", () => {
          const lock = acquirePathLock(`${meta}.lock`, 0, env);
          if (!lock) return;
          try {
            if (!orphaned()) return;
            const home = dirname(payloadsDir);
            if (unverifiedCanonical(home, id)) {
              const receipt = join(home, "receipts", `${id}.unconfirmed`);
              // Never overwrite prior evidence. A pre-existing receipt keeps
              // this sidecar too; a later explicit settlement can remove it.
              if (existsSync(receipt)) return;
              const bytes = readFileSync(meta), archived = join(home, "archive", `${id}.meta.json`);
              // Resend already reads archived metadata for its unchanged proof
              // rule. Preserve those exact bytes, including zero-count fences.
              if (existsSync(archived) && !readFileSync(archived).equals(bytes)) return;
              if (!existsSync(archived)) atomicWrite(archived, bytes);
              atomicWrite(receipt, JSON.stringify({ id, status: "unconfirmed", effect: "possible",
                at: new Date().toISOString(), reason: "orphaned_spool",
                spool_metadata_base64: bytes.toString("base64") }) + "\n");
            }
            unlinkSync(meta);
          } finally { lock.release(); }
        }, 0);
      } finally { obligation.release(); }
      // The lock file goes only while HELD (never a bare unlink: a holder on that inode would keep an orphan).
      if (!existsSync(meta)) sweepUnheldLocks([`${meta}.lock`], env);
    } catch { /* leave it for the next sweep */ }
  }
}

/** Nonblocking flock on the same path as writers, with no child per candidate. The unlink happens only while
 * the lock is held, and `acquireFlock` proved after the grant that the held file is the one at the path, so a
 * waiter that opened this inode first re-locks the successor instead of holding the orphan (tap-yyu28). */
function sweepUnheldLocks(paths: string[], env: NodeJS.ProcessEnv): void {
  for (const path of paths) {
    let lock;
    try {
      lock = acquirePathLock(path, 0, env);
      if (lock) unlinkSync(path);
    } catch { /* A changed or unobservable path stays for another pass. */ }
    finally { lock?.release(); }
  }
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

if (import.meta.main) {
  const [mode, ...rest] = Bun.argv.slice(2);
  const controller = new AbortController();
  let stopped = 0;
  const handlers = mode === "remove" ? (["SIGINT", "SIGTERM", "SIGHUP"] as const).map(signal => {
    const stop = () => { if (!controller.signal.aborted) { stopped = signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143; controller.abort(); } };
    process.on(signal, stop); return [signal, stop] as const;
  }) : [];
  try {
    // `print()`, not `write()`: the incumbent's reader is a Python `print`, so
    // the value carries a trailing newline and an empty result is a bare one.
    // Every caller uses `$(...)`, which strips it — which is exactly how a byte
    // difference like this survives until something stops using a subshell.
    if (mode === "field" && rest.length === 3) process.stdout.write(`${metaField(rest[0]!, rest[1]!, rest[2]!)}\n`);
    else if (mode === "bump" && rest.length === 2) bumpAttempts(rest[0]!, rest[1]!);
    else if (mode === "claim" && rest.length >= 2) {
      // The word is the receipt, and BOTH words exit 0. A held claim is routine
      // contention, not a failure: exiting nonzero for it made `tap_bun_call`
      // print a slice-failure line on every drain tick, and silencing that
      // line also silenced `runtime_missing`, which a missing `bun` must still
      // report loudly. So the status carries the runtime's health and the word
      // carries the verdict. A runtime that exits 0 having written nothing — a
      // stub, a crashed startup — produces neither word, and the adapter
      // refuses that shape rather than reading rc 0 as a held claim.
      process.stdout.write(`${claimAcquire(rest[0]!, rest[1]!, rest[2] === "no-steal").status}\n`);
    } else if (mode === "release" && rest.length === 2) claimReleaseUnconditionally(rest[0]!, rest[1]!);
    else if (mode === "observe" && rest.length === 2) process.stdout.write(`${claimObserve(rest[0]!, rest[1]!)}\n`);
    else if (mode === "remove" && rest.length === 2) await removeEntryAsync(rest[0]!, rest[1]!, controller.signal);
    else if (mode === "reap" && rest.length === 2) reapStaleSidecars(rest[0]!, rest[1]!);
    else {
      process.stderr.write("spool-sidecar: expected field|bump|claim|observe|release|remove|reap with its arguments\n");
      process.exit(2);
    }
  } catch (error) {
    if (!stopped) process.stderr.write(`tap: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = stopped || 1;
  } finally {
    for (const [signal, stop] of handlers) process.off(signal, stop);
  }
}
