import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomInt, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

import type { LockMode } from "./remind-lock";
import { TapError } from "./context";
import { atomicWrite } from "./fsatomic";
import { acquirePathLock, acquirePathLockAsync, type PaneLock } from "./panelock";
import { pyJson } from "./registry";
import { bootId, bootIdsMatch } from "./tmux";
import { isFile } from "./watch-lease";
import { errorJson, humanAction, humanLine } from "./native-error";
import { isDict, metaBytes, parseJsonPreserving, PyFloat, PyInt } from "./spool-publication";

function numText(value: unknown): string {
  if (value instanceof PyInt) return value.source;
  if (value instanceof PyFloat) value = value.value;
  return typeof value === "string" ? value
    : typeof value === "number" && Number.isInteger(value) ? String(value) : "";
}

/** Legacy checkpoint fences retain their guards, with recovery that still exists. */
const FENCE_ACTION_WAIT =
  "wait for the reset owner (or until identity is readable)";
function ownedFenceAction(path: string): string {
  return fenceOwnerLive(path) ? FENCE_ACTION_WAIT
    : `checkpoint reset is retired; after confirming no reset owner is running, remove the stale fence: rm ${shQuote(path)}`;
}
// The kernel helper accepts whole-second waits; this is its shortest positive bound.
// Deliberately not timing-asserted: proving a holder releases mid-wait requires a
// timing-dependent child process. The refusal branches below are mutation-pinned.
const RESET_CUSTODY_WAIT_MS = 1000;

/** How long an interactive verb auto-waits for reset custody before refusing
 * (tap-7t3ag). Every EX holder is a bounded structural span (teardown or
 * restore, the reset machinery's pre-publication gap); a full team reset
 * publishes its fence and converts waiters to a terminal team_reset_fenced
 * refusal, so this bound never holds a human through one. */
export const INTERACTIVE_CUSTODY_WAIT_MS = 120_000;

/** The note an EX holder leaves inside the lock file for waiting verbs. */
export interface ResetCustodyHolderNote { readonly pid: number; readonly operation: string; readonly since: string }

/** Auto-retry policy for reset custody: wait up to maxWaitMs total, reporting
 * progress through onWait; the caller owns TTY and JSON gating. */
export interface ResetCustodyWaiting { maxWaitMs: number; onWait?: (line: string) => void }

const holderNotePath = (busHome: string): string => join(busHome, "reset.fence.json.lock");

/** Best effort: the lock works without the note, and only the holder (under
 * the flock) ever writes or clears these bytes. */
function writeHolderNote(path: string, operation: string): void {
  try {
    writeFileSync(path, `${JSON.stringify({ pid: process.pid, operation, since: new Date().toISOString() })}\n`);
  } catch { /* best effort */ }
}

function clearHolderNote(path: string): void {
  try {
    writeFileSync(path, "");
  } catch { /* best effort */ }
}

export function readResetHolderNote(path: string): ResetCustodyHolderNote | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isDict(parsed)) return null;
    const pid = parsed.pid, operation = parsed.operation, since = parsed.since;
    if (typeof pid !== "number" || typeof operation !== "string") return null;
    return { pid, operation, since: typeof since === "string" ? since : "" };
  } catch { return null; }
}

/** An interactive verb's custody-wait policy: a generous auto-wait whose
 * progress line goes to stderr, only when BOTH std streams are TTYs and never
 * in JSON mode (tap-7t3ag) — a script that redirects stdin but inherits
 * terminal stderr must not stall on the long wait. Non-interactive callers
 * get undefined and keep today's bounded, quiet refusal. */
export function interactiveResetCustodyWaiting(operation: string): ResetCustodyWaiting | undefined {
  if (process.env.TAP_JSON === "1" || !process.stderr.isTTY || !process.stdin.isTTY) return undefined;
  return {
    maxWaitMs: INTERACTIVE_CUSTODY_WAIT_MS,
    onWait: line => process.stderr.write(`${operation}: ${line}\n`),
  };
}

/**
 * The process-start fingerprint as SECONDS SINCE THE EPOCH, or "" if unreadable.
 *
 * `ps -o lstart=` renders in the CALLER's timezone — the same process reads as
 * `Tue Aug 25 05:34:42 2026` under UTC and `Mon Aug 24 22:34:42 2026` under
 * America/Los_Angeles — so comparing two renderings made under different TZ
 * reports a moved fingerprint for a process that never restarted, which is
 * positive proof of staleness manufactured out of a clock setting. Rendering is
 * pinned to UTC and parsed as UTC, so the number depends on neither party.
 *
 * An unparseable rendering returns "" and the caller resolves that to LIVE,
 * like every other unreadable factor here.
 */
export function procStartEpoch(pid: string): string {
  const r = spawnSync("ps", ["-p", pid, "-o", "lstart="], {
    encoding: "utf8", env: { ...process.env, TZ: "UTC" }, timeout: 2000,
  });
  if (r.status !== 0) return "";
  const raw = (r.stdout ?? "").trim();
  if (!raw) return "";
  const ms = Date.parse(`${raw} UTC`);
  return Number.isFinite(ms) ? String(Math.floor(ms / 1000)) : "";
}

/** The recorded owner identity, or null when the record is unreadable (not JSON,
 *  or not an object). A readable record may still carry empty factors: that is
 *  an INCOMPLETE identity, which the liveness predicate resolves to LIVE and the
 *  refusal names as unreclaimable (tap-mkiqq). */
function readFenceIdentity(path: string): { pid: string; boot: string; start: string } | null {
  let record: Record<string, unknown>;
  try {
    const parsed = parseJsonPreserving(readFileSync(path, "utf8"));
    if (!isDict(parsed)) return null;
    record = parsed;
  } catch {
    return null;
  }
  // PYTHON'S FALSY RULE, STATED AS A RULE — not enumerated as a list of scalars.
  //
  // The incumbent reads the field as `rec.get("pid") or ""`, and python's
  // falsiness includes every EMPTY CONTAINER, not just the scalars. An earlier
  // version here enumerated `undefined|null|false|0|""`, which closed those
  // instances and left the class open: a JSON `{}` is falsy to python (missing →
  // LIVE) and stringifies in JS to "[object Object]" — a present pid that fails
  // `kill -0` and reads STALE. Measured by the cleanup reviewer. `[]` was
  // safe only by accident, because `String([])` lands back inside the list.
  //
  // The rule that closes the class, taken from python rather than guessed at:
  // `x or ""` keeps x when x is TRUTHY, and python's truthiness is per-type.
  // Measured against the incumbent for every shape this field can hold:
  //
  //     0 (number) -> ''      falsy      -> MISSING
  //     "0"        -> '0'     non-empty  -> usable
  //     {} []      -> ''      empty      -> MISSING
  //     false ""   -> ''      falsy      -> MISSING
  //     123 "456"  -> kept               -> usable
  //
  // Note 0 and "0" DIVERGE — numeric zero is falsy, the string is not. A first
  // pass at this predicate said "a number is usable" and got both of those
  // backwards, which is why the table above is measured output rather than
  // reasoning. An enumeration closes the instances someone thought of; a
  // predicate closes the ones nobody did — but only if the predicate is the
  // incumbent's, not a plausible-looking substitute.
  const rawPid = record.pid;
  // ONE RULE FOR A JSON NUMBER, ACROSS THREE LANGUAGES. JSON has no integer
  // type, so `1e5` and `99999999.0` arrive as floats: JS renders them
  // `"100000"` / `"99999999"` while Python renders `"100000.0"` / `"99999999.0"`,
  // and the shape guard below then reached OPPOSITE decisions on one fence. JS
  // cannot distinguish 1e5 from 100000, so the only rule all three can state
  // identically is: a number is a pid IFF it is INTEGRAL, rendered canonically.
  // A fraction is unreadable everywhere — never truncated, or 1.5 would become
  // pid 1, which is alive on every unix.
  //
  // THIS HALF IS DEFENSIVE AND ITS MUTANT SURVIVES, which is worth stating
  // rather than leaving for someone to rediscover: `String()` on an integral
  // float already yields the canonical form in JS, so reverting this guard to a
  // bare `String(rawPid)` changes nothing observable and arm (18a) stays green.
  // The divergence lived in the two Python copies, whose `str()` renders the
  // same value `"99999999.0"` — the `pidnum-python` mutant is what reds (18a).
  // The guard stays because the rule should be stated where the value is read,
  // not only where one language happened to need it.
  //
  // WHICH OF THE TWO IS LOAD-BEARING, because "redundant" is true of this check
  // and false of the pair. This one runs on the `number` branch ONLY. A pid that
  // arrives as the STRING "-1" or "0" skips it entirely and is caught solely by
  // `/^[1-9][0-9]*$/` below — and `kill -0` exits 0 for both of those, since they
  // name a process GROUP, so a garbage pid would prove liveness (tap-jm19m).
  // Delete this check and nothing changes; delete the shape guard and that hole
  // reopens. A future reader trimming a redundant-looking pair should take this
  // half. (cleanup review, tap-9esoo.)
  const pid = numText(rawPid);
  const recordedBoot = typeof record.boot_id === "string" ? record.boot_id : "";
  // THE SAME JSON-NUMBER RULE AS THE PID FACTOR TWO LINES ABOVE. It was absent
  // here, in the very file whose comment explains it: a non-string factor was
  // called UNREADABLE, so a fingerprint written as a number could never prove a
  // fence stale in this runtime while the bash reader rendered it and compared.
  // Shape is still decided by the canonical-epoch gate below, which is why `0` stays
  // readable -- the STRING "0" already compares, arm (17) depends on it, and the
  // point of this row is that the number and the string mean the same thing.
  const rawStart = record.owner_start;
  const recordedStart = numText(rawStart);
  return { pid, boot: recordedBoot, start: recordedStart };
}

/**
 * Shared owner predicate for native guards, Bash adapters and fence acquire.
 *
 * FAIL-CLOSED IS THE WHOLE DESIGN, and it is the half a port drops because it
 * looks like error handling rather than policy. Every unreadable factor — an
 * unparseable fence, a missing stamp field, an unreadable current boot id, a
 * `ps` that will not answer — returns LIVE, because "I could not tell" must
 * never license reclaiming a fence somebody is still holding. Only a POSITIVE
 * mismatch proves stale: a different boot, a dead pid, or a start-time
 * fingerprint that moved (which is what makes pid reuse non-fatal).
 */
export function fenceOwnerLive(path: string): boolean {
  const identity = readFenceIdentity(path);
  if (!identity) return true;
  const { pid, boot: recordedBoot, start: recordedStart } = identity;
  if (!pid || !recordedBoot || !recordedStart) return true;
  // A PID THAT IS NOT A PID IS NOT EVIDENCE IN EITHER DIRECTION, and the two
  // failures are opposite — which is why this is a shape guard rather than a
  // reading of `kill`'s exit code. Measured on macOS by
  // The cleanup reviewer, exactly as the probe below calls it:
  //
  //   kill -0 garbage   status 2 "illegal process id"  -> read as PROVED STALE
  //   kill -0 1e5       status 2                       -> read as PROVED STALE
  //   kill -0 -1        status 0                       -> read as PROOF OF LIFE
  //   kill -0 0         status 0                       -> read as PROOF OF LIFE
  //
  // `0` and negatives address a process GROUP, so the probe answers a different
  // question than the one asked (tap-jm19m). Keying on status 2 would close the
  // first pair and leave the second returning 0, and it would stake the fix on
  // BSD `kill`'s codes matching GNU's and the shell builtin's. A positive-integer
  // shape closes both halves before any probe runs, on every platform.
  // AND BOUNDED, which this gate was not while both epoch factors were.
  // An out-of-range pid is not a pid any probe can answer about, and both fail
  // toward reclaim: `kill -0` on a 400-digit value OVERFLOWS and returns 0, so the
  // process-table corroborator is never even entered, and `ps -p` exits 1 with
  // empty stdout, which that corroborator reads as proof of absence. Neither the
  // three-state probe work nor the errno route can help, because the value must be
  // refused BEFORE any probe runs -- which is what the note above already claimed
  // and the missing length did not deliver. 15 digits, the same representability
  // bound as the two epoch factors; no literal-zero arm here, because `0` and
  // leading zeros address a process GROUP and were already rejected.
  // THE BOUND IS THE PROCESS API RANGE, NOT A DIGIT COUNT. A fifteen-digit rule
  // let `2147483648` through -- ten digits, and outside what pid_t can hold. Both
  // probes then answer emptily, this reader calls the owner absent, and the
  // `tap team reset` it advertises routes to an acquire whose `os.kill` raises an
  // uncaught OverflowError: a refusal recommending a recovery that cannot run.
  //
  // INT32_MAX is where the three implementations stop agreeing, measured:
  //   2147483647  native STALE  bash STALE  python ProcessLookupError -> STALE
  //   2147483648  native STALE  bash STALE  python UNCAUGHT OverflowError
  // So the limit belongs to the platform rather than to a number chosen here,
  // which is the property the digit count never had. Ten digits keeps `Number()`
  // exact well below 2^53, and the comparison then decides the range.
  if (!/^[1-9][0-9]{0,9}$/.test(pid) || Number(pid) > 2147483647) return true;

  const nowBoot = bootId();
  if (!nowBoot) return true;
  // The SAME matcher the incumbent uses, tolerance included (tmux.ts's
  // bootIdsMatch twins lib.sh:7094). An earlier draft compared only within a
  // scheme and treated a cross-scheme pair as no proof, on the theory that
  // bash's answer there was reclaim-while-held. A probe settled it: with a
  // legacy stamp equal to this host's own boot epoch both runtimes say LIVE, so
  // bash is comparing meaningfully rather than refusing to compare — and the
  // guard's real effect was to make a PRIOR-boot fence unreclaimable forever on
  // any host that has since moved to uuid identity.
  // THREE ANSWERS, and only one of them is proof. `mismatch` is a positively
  // observed prior boot and stays reclaimable; `unknown` means the two stamps
  // could not be related at all, which is an unreadable factor and joins the
  // four above it in failing closed to LIVE. Collapsing them is what let a live
  // owner be declared stale.
  const relation = bootIdsMatch(recordedBoot, nowBoot);
  if (relation === "unknown") return true;
  if (relation === "mismatch") return false;

  // Errno distinguishes absence from an occupied but unsignallable pid. EPERM
  // still needs the start fingerprint; every other error is unreadable and
  // fails closed to LIVE.
  try {
    process.kill(Number(pid), 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code !== "EPERM") return true;
  }

  // A recorded stamp that is not all digits is a LEGACY RENDERING from before
  // the epoch format. `ps -o lstart=` renders in the caller's timezone, so it
  // cannot be compared without guessing which TZ produced it, and a wrong guess
  // manufactures "the fingerprint moved" for a process that never restarted.
  // Unknown, therefore LIVE.
  // DIGITS ARE NOT AN EPOCH. A digit string too long to represent is
  // UNREADABLE, not a fingerprint that necessarily moved: `Number()` yields
  // Infinity, bash silently overflows to a plausible finite number, and python
  // carries it exactly -- three implementations, three different wrong answers,
  // each a DEFINITE mismatch that authorizes reclaim. The bound is a DIGIT COUNT
  // rather than a range check because bash does not report its overflow, so
  // "did my arithmetic succeed" is answerable in two languages and not the third;
  // string length is decided identically in all three. 15 digits keeps every
  // accepted value below 2^53, exact in a JS double, a bash 64-bit int and a
  // python int at once. It bounds representability, not plausible dates.
  // CANONICAL OR UNREADABLE. A leading zero is not a smaller number -- it is
  // a rendering no writer here emits, and each language disagrees about what it
  // means. The boot factor is compared NUMERICALLY, so `boot:01785910738` reads as
  // 1785910738 in JS and python and enters OCTAL arithmetic in the shell, where 8
  // and 9 are not digits: bash errors, resolves to "differ", and RECLAIMS a fence
  // the other two hold. That is the only direction of divergence in this predicate
  // where the shell takes a fence the others protect. `0` alone stays readable --
  // the string "0" has compared since the numeric row landed.
  if (!/^(?:0|[1-9][0-9]{0,14})$/.test(recordedStart)) return true;
  const nowStart = procStartEpoch(pid);
  if (!nowStart) return true;
  return nowStart === recordedStart;
}

/**
 * Refuse an operation while the bus is mid-reset.
 *
 * `operation` is the caller's FULL verb string ("tap poll", "tap team refresh"),
 * not a bare word: the incumbent's detail opens with $TAP_VERB, and a bare word
 * reads as `refusing poll — …` where bash says `refusing tap poll — …`.
 *
 * It is ALSO the error's verb label, because bash's `tap_fail` prints
 * `$TAP_VERB` as the line prefix and $TAP_VERB is the same string. Letting the
 * router label this one instead produced `tap team: refusing tap team refresh —`
 * for a subcommand — the two halves of one sentence disagreeing about which verb
 * refused. Passing it once, here, keeps them the same string by construction
 * rather than by two callers remembering to agree.
 */
export function resetFenceRefusal(
  busHome: string,
  operation: string,
): { action: string; detail: string } | null {
  const path = join(busHome, "reset.fence.json");
  if (!isFile(path)) return null;
  return unownedFenceRefusal(path, operation) ?? {
    action: ownedFenceAction(path),
    detail: `refusing ${operation} — team bus is mid-reset (fence at ${path})`,
  };
}

/**
 * The refusal for a fence record that names no owner, or null when it names one.
 *
 * An unreadable record, or one missing pid, boot_id or owner_start, resolves to
 * LIVE in fenceOwnerLive — the right polarity for a reclaim decision, and the
 * wrong thing to tell an operator: no owner exists to finish, nothing will ever
 * reclaim it, so "wait" never comes true and every guarded verb refuses until a
 * human removes the file (tap-mkiqq). The acquire path never writes such a
 * record, so reaching this means damage or a pre-stamp writer. The two shapes
 * are named apart: a file that PARSED is not corrupt, and saying so would send
 * the reader hunting for damage a JSON parser just accepted.
 */
export function unownedFenceRefusal(path: string, operation: string): { action: string; detail: string } | null {
  const identity = readFenceIdentity(path);
  if (identity && identity.pid && identity.boot && identity.start) return null;
  const state = identity ? "names no owner (pid, boot_id or owner_start missing)" : "is unreadable";
  return {
    action: `inspect ${path} and, once you are sure no reset is running, remove it: rm ${shQuote(path)}`,
    detail: `refusing ${operation} — the reset fence record at ${path} ${state}, so nothing will clear it automatically`,
  };
}

/** POSIX quoting for the path in a runnable remedy. Local rather than imported:
 *  reset.ts sits in the goalie and watch loops' stamped import closure. */
function shQuote(s: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
}

/** The launcher doors' one-line fence refusal; they fence on presence alone. */
export function launcherFenceRefusal(path: string, operation: string): string {
  const unowned = unownedFenceRefusal(path, operation);
  return unowned ? `${unowned.detail}; next: ${unowned.action}`
    : `refusing ${operation} — team bus is mid-reset (fence at ${path}); next: ${ownedFenceAction(path)}`;
}

export function assertResetUnfenced(busHome: string, operation: string): void {
  const refusal = resetFenceRefusal(busHome, operation);
  if (!refusal) return;
  throw new TapError(1, "team_reset_fenced", refusal.action, refusal.detail, operation);
}

/**
 * Hold the incumbent reset sidecar so a reset cannot cut the bus while this
 * mutation window is open. Waits briefly, then rechecks the fence under the
 * lock. Failure to acquire still fails closed; there is no unlocked proceed.
 */
/** Native twin of `tap_reset_fence_test_barrier` (sol 063932): a scratch-only
 *  stage barrier for in-flight-mutator tests. Writes `<base>.<stage>.reached`
 *  then waits up to 60s for `<base>.<stage>.release`; a timeout refuses. */
export function fenceTestBarrier(stage: string, env: NodeJS.ProcessEnv = process.env): void {
  const raw = env.TAP_RESET_FENCE_TEST_BARRIER ?? "";
  if (raw === "" || (env.TAP_SCRATCH_ONLY ?? "") === "") return;
  const base = raw.split("/").pop() ?? raw;
  const parent = raw.slice(0, raw.length - base.length) || "./";
  const reached = `${parent}${base}.${stage}.reached`;
  const release = `${parent}${base}.${stage}.release`;
  writeFileSync(reached, "1\n");
  const deadline = Date.now() + 60_000;
  while (!existsSync(release)) {
    if (Date.now() >= deadline) {
      throw new Error(`reset fence test barrier timed out at ${stage}`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

/** An EX holder killed without unwinding leaves its note behind; only name a
 * holder whose pid still exists (EPERM means alive, just not ours). */
function liveHolderNote(path: string): ResetCustodyHolderNote | null {
  const note = readResetHolderNote(path);
  if (!note) return null;
  if (note.pid === process.pid) return note;
  try {
    process.kill(note.pid, 0);
    return note;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM" ? note : null;
  }
}

/** The busy-sidecar refusal, naming a live EX holder when the note has one. */
function custodyRefusal(busHome: string, path: string, operation: string, mode: LockMode): TapError {
  const fencePresent = isFile(join(busHome, "reset.fence.json"));
  const note = liveHolderNote(path);
  return new TapError(
    1,
    fencePresent ? "team_reset_fenced" : "reset_custody_busy",
    fencePresent
      ? FENCE_ACTION_WAIT
      : `retry this command; ${mode === "shared" ? "a structural TAP operation" : "another TAP mutation"} holds the reset sidecar${note ? ` (${note.operation}, pid ${note.pid}, since ${note.since})` : ""}`,
    `refusing ${operation} — could not obtain reset mutation custody (lock at ${path})`,
    operation,
  );
}

/** Post-acquire: fence recheck; an EX holder records its note and clears it
 * before releasing, so a later holder's note is never truncated late. */
function adoptCustody(busHome: string, path: string, operation: string, mode: LockMode, lock: PaneLock): PaneLock {
  try {
    assertResetUnfenced(busHome, operation);
  } catch (error) {
    lock.release();
    throw error;
  }
  if (mode === "exclusive") {
    writeHolderNote(path, operation);
    const held = lock;
    return { release() { clearHolderNote(path); held.release(); } };
  }
  return lock;
}

/** Progress-line cadence shared by the sync and async waits: a line when the
 * live holder changes, then at most one repeat every ten seconds. */
function custodyWaitReporter(waiting: ResetCustodyWaiting, path: string): () => void {
  let lastNote = "", lastLine = 0;
  return () => {
    const note = liveHolderNote(path);
    const key = note ? `${note.pid}:${note.operation}:${note.since}` : "unknown";
    const now = Date.now();
    if (key === lastNote && now - lastLine < 10_000) return;
    lastNote = key, lastLine = now;
    waiting.onWait?.(note
      ? `waiting for reset custody — held by ${note.operation} (pid ${note.pid}) since ${note.since}`
      : "waiting for reset custody — another TAP mutation holds the reset sidecar");
  };
}

/** Mail and registry writers use SH; structural cuts use EX. Every admission
 * rechecks the fence. Mail custody ends before pane delivery (tap-0p7hx).
 * waitMs=0 is nonblocking; positive waits retain the custody wait floor.
 * `waiting` (send/reply: synchronous verbs with no handlers installed, so a
 * Ctrl-C still terminates through the kernel default) retries a busy sidecar
 * with progress lines naming a live EX holder, then refuses (tap-7t3ag). The
 * replace path uses the async form; a published fence refuses at once. */
export function acquireResetMutationLock(busHome: string, operation: string, waitMs = RESET_CUSTODY_WAIT_MS, mode: LockMode = "exclusive",
  waiting?: ResetCustodyWaiting): PaneLock {
  const path = holderNotePath(busHome);
  const attemptMs = waitMs === 0 ? 0 : Math.max(RESET_CUSTODY_WAIT_MS, waitMs);
  let lock = acquirePathLock(path, attemptMs, process.env, mode);
  if (lock) return adoptCustody(busHome, path, operation, mode, lock);
  const report = waiting ? custodyWaitReporter(waiting, path) : null;
  let deadline = 0;
  while (!lock && waiting) {
    if (!deadline) deadline = Date.now() + waiting.maxWaitMs;
    report?.();
    if (Date.now() >= deadline) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(deadline - Date.now(), 250));
    // A fence published meanwhile is terminal; the next attempt reports it.
    lock = acquirePathLock(path, attemptMs, process.env, mode);
    if (!lock && isFile(join(busHome, "reset.fence.json"))) break;
  }
  if (!lock) throw custodyRefusal(busHome, path, operation, mode);
  return adoptCustody(busHome, path, operation, mode, lock);
}

/** The async form for callers that can yield: with `waiting`, a busy sidecar
 * is retried up to maxWaitMs with progress lines naming a live EX holder,
 * then refused (tap-7t3ag). A published fence refuses at once, and an
 * aborted signal ends the wait by throwing. */
export async function acquireResetMutationLockAsync(busHome: string, operation: string, waitMs = RESET_CUSTODY_WAIT_MS, mode: LockMode = "exclusive",
  waiting?: ResetCustodyWaiting, signal?: AbortSignal): Promise<PaneLock> {
  const path = holderNotePath(busHome);
  const attemptMs = waitMs === 0 ? 0 : Math.max(RESET_CUSTODY_WAIT_MS, waitMs);
  const report = waiting ? custodyWaitReporter(waiting, path) : null;
  let deadline = 0;
  for (;;) {
    const lock = await acquirePathLockAsync(path, attemptMs, signal, process.env, mode);
    if (lock) return adoptCustody(busHome, path, operation, mode, lock);
    if (!waiting) throw custodyRefusal(busHome, path, operation, mode);
    if (!deadline) deadline = Date.now() + waiting.maxWaitMs;
    report?.();
    if (Date.now() >= deadline) throw custodyRefusal(busHome, path, operation, mode);
    await Bun.sleep(Math.min(deadline - Date.now(), 250));
    // A fence published meanwhile is terminal; the next attempt reports it.
    if (isFile(join(busHome, "reset.fence.json"))) throw custodyRefusal(busHome, path, operation, mode);
  }
}

/** How long a post-placement mutation waits for custody; every holder is short. */
export const POST_PLACEMENT_CUSTODY_WAIT_MS = 10_000;
/** Durable-write locks taken under reset custody must not exceed RESET_CUSTODY_WAIT_MS. */
export const RESET_HELD_LOCK_WAIT_MS = 1_000;

export type CustodyRefusal = "team_reset_fenced" | "reset_custody_busy";

/**
 * Run one short bus mutation under reset custody, or report why it could not
 * run. A caller that already placed durable mail cannot turn this refusal into
 * an error — that would invite a duplicate re-send — so it is a value, not a
 * throw: the caller decides what the unperformed mutation means.
 */
export function withResetCustody<T>(busHome: string, operation: string, body: () => T,
  waitMs = POST_PLACEMENT_CUSTODY_WAIT_MS): { ok: true; value: T } | { ok: false; refusal: CustodyRefusal; detail: string } {
  let lock: PaneLock;
  try {
    lock = acquireResetMutationLock(busHome, operation, waitMs, "shared");
  } catch (error) {
    if (error instanceof TapError && (error.errorClass === "team_reset_fenced" || error.errorClass === "reset_custody_busy")) {
      return { ok: false, refusal: error.errorClass, detail: error.detail };
    }
    throw error;
  }
  try { return { ok: true, value: body() }; } finally { lock.release(); }
}

/** withResetCustody for an async durable effect; the body must not do pane I/O. */
export async function withResetCustodyAsync<T>(busHome: string, operation: string, body: () => Promise<T>,
  waitMs = POST_PLACEMENT_CUSTODY_WAIT_MS): Promise<{ ok: true; value: T } | { ok: false; refusal: CustodyRefusal; detail: string }> {
  let lock: PaneLock;
  try {
    lock = acquireResetMutationLock(busHome, operation, waitMs, "shared");
  } catch (error) {
    if (error instanceof TapError && (error.errorClass === "team_reset_fenced" || error.errorClass === "reset_custody_busy")) {
      return { ok: false, refusal: error.errorClass, detail: error.detail };
    }
    throw error;
  }
  try { return { ok: true, value: await body() }; } finally { lock.release(); }
}

export function markResetGenerationReused(busHome: string, firstMutation: string, waitMs = RESET_HELD_LOCK_WAIT_MS): void {
  const path = join(busHome, "reset-generation.json");
  if (!existsSync(path)) return;

  // Best effort serialization: never skip the reused mark on contention.
  const lock = acquirePathLock(join(busHome, "locks", "reset-generation.lock"), waitMs);
  try {
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      record = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (record.state !== "pristine") return;
    record.state = "reused";
    record.first_mutation = firstMutation;
    atomicWrite(path, `${pyJson(record, 0)}\n`);
  } finally { lock?.release(); }
}

export function readResetFence(busHome: string): string[] | null {
  try {
    const rec = parseJsonPreserving(readFileSync(join(busHome, "reset.fence.json"), "utf8"));
    if (!isDict(rec)) return null;
    const text = (key: string) => typeof rec[key] === "string" ? rec[key] : "";
    return [numText(rec.pid), text("boot_id"), numText(rec.owner_start), text("token"), text("bundle_id"), text("phase")];
  } catch { return null; }
}

/** The acquisition arrival marker must not wait: its observer holds the flock. */
function fenceTestMark(stage: string): void {
  const base = process.env.TAP_RESET_FENCE_TEST_BARRIER;
  if (base && process.env.TAP_SCRATCH_ONLY) writeFileSync(`${base}.${stage}.reached`, "1\n");
}

function publishFenceRecord(path: string, bytes: string, replace = false, prefix = ".tap-fence."): void {
  // A crash before publication leaves only classified, discardable scratch.
  const scratch = join(dirname(path), "tmp");
  mkdirSync(scratch, { recursive: true });
  const temp = join(scratch, `${prefix}${randomUUID()}`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    if (process.env.TAP_RESET_FENCE_TEST_PAUSE_PUBLISH === "1") fenceTestBarrier("fence-before-publish");
    if (replace) renameSync(temp, path);
    else linkSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch { /* renamed or preserve publication error */ }
  }
}

function writerLock(busHome: string, waitMs = Infinity, operation = "tap team reset"): PaneLock {
  const path = holderNotePath(busHome);
  const lock = acquirePathLock(path, waitMs);
  if (!lock && waitMs === Infinity) throw new Error("could not obtain reset fence sidecar lock");
  if (!lock) {
    // Only the bounded fence acquire can time out, before any stop or checkpoint.
    const note = readResetHolderNote(path);
    throw new TapError(1, "reset_custody_busy", "retry after the current TAP mutation releases reset custody",
      `refusing reset — could not obtain the reset fence sidecar within ${Math.ceil(waitMs / 1000)}s` +
        (note ? ` (held by ${note.operation}, pid ${note.pid}, since ${note.since})` : ""));
  }
  writeHolderNote(path, operation);
  return { release() { clearHolderNote(path); lock.release(); } };
}

/** The refusal every reset entry gives while a live or unreadable-identity owner holds the fence. */
export function resetInProgress(pid = ""): TapError {
  return new TapError(1, "reset_in_progress", FENCE_ACTION_WAIT,
    `refusing reset — fence held by live/unreadable-identity owner pid ${pid || "(unreadable)"}`);
}

export function acquireResetFence(busHome: string, ownerPid: string, bundleId = "", op = "team-reset"): string {
  const boot = bootId();
  const start = /^[1-9][0-9]{0,9}$/.test(ownerPid) && Number(ownerPid) <= 2147483647 ? procStartEpoch(ownerPid) : "";
  if (!boot || !start) throw new TapError(1, "fence_identity_unreadable",
    "retry when boot id and process-start are observable",
    "refusing to acquire reset fence — boot_id or owner_start unreadable (fail-closed; overlapping cuts are worse than delay)");
  if (op !== "team-reset" && op !== "team-restore") throw new TapError(1, "usage_error", "tap help team reset",
    `internal fence op '${op}' is not team-reset|team-restore`);
  const started = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const token = `${op}-${started.replace(/[-:]/g, "")}-${ownerPid}-${randomInt(32768)}`;
  const rec = { op, pid: Number(ownerPid), started_at: started, token, boot_id: boot,
    owner_start: start, phase: op === "team-reset" ? "checkpointing" : "restoring", ...(bundleId ? { bundle_id: bundleId } : {}) };
  const path = join(busHome, "reset.fence.json");
  const refuseLive = (pid = "") => { throw resetInProgress(pid); };
  mkdirSync(busHome, { recursive: true });
  fenceTestMark("pre-fence-acquire");
  // Bounded: every custody holder is one short durable effect (tap-g191v).
  const lock = writerLock(busHome, POST_PLACEMENT_CUSTODY_WAIT_MS);
  try {
    if (existsSync(path)) {
      if (fenceOwnerLive(path)) refuseLive(readResetFence(busHome)?.[0]);
      const scratch = join(busHome, "tmp");
      mkdirSync(scratch, { recursive: true });
      const stale = join(scratch, `.tap-fence.reclaimed.${process.pid}.${randomUUID()}`);
      try {
        renameSync(path, stale);
        try { unlinkSync(stale); } catch { /* incumbent best-effort reclaimed-file cleanup */ }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    try { publishFenceRecord(path, `${pyJson(rec, 0)}\n`); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") refuseLive();
      throw error;
    }
    return token;
  } finally { lock.release(); }
}

export function setResetFencePhase(busHome: string, phase: string, token: string): number {
  const path = join(busHome, "reset.fence.json");
  if (!isFile(path)) return 1;
  const lock = writerLock(busHome);
  try {
    // Preserve unknown JSON fields and numeric lexemes while changing only phase.
    const rec = parseJsonPreserving(readFileSync(path, "utf8"));
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) throw new Error("fence record incomplete");
    const record = rec as Record<string, unknown>;
    if (record.token !== token) return 3;
    record.phase = phase;
    publishFenceRecord(path, metaBytes(record as Parameters<typeof metaBytes>[0]), true);
    return 0;
  } finally { lock.release(); }
}

export function releaseResetFence(busHome: string, token: string): number {
  const path = join(busHome, "reset.fence.json");
  if (!isFile(path)) return 0;
  const lock = writerLock(busHome);
  try {
    let bytes: string;
    try { bytes = readFileSync(path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    let rec: unknown;
    try { rec = parseJsonPreserving(bytes); } catch {
      process.stderr.write(`tap: fence record unreadable, not releasing ${path} (inspect it and remove by hand once you are sure no reset is running)\n`);
      return 4;
    }
    const recordedToken = rec && typeof rec === "object" && !Array.isArray(rec) ? (rec as Record<string, unknown>).token : undefined;
    if (typeof recordedToken !== "string" || !recordedToken) {
      process.stderr.write(`tap: fence record incomplete, not releasing ${path} (it parses but identifies no owner, so no one can prove ownership and nothing will reclaim it — inspect it and remove by hand once you are sure no reset is running)\n`);
      return 4;
    }
    if (recordedToken !== token) {
      process.stderr.write(`tap: fence token mismatch, not releasing ${path} (another owner holds this fence)\n`);
      return 3;
    }
    try { unlinkSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return 0;
  } finally { lock.release(); }
}

export function stampResetGenerationPristine(busHome: string, bundleId: string): void {
  publishFenceRecord(join(busHome, "reset-generation.json"), `${pyJson({ bundle_id: bundleId, state: "pristine" }, 0)}\n`, true, ".tap-gen.");
}

function resetFenceCli(argv: string[]): number {
  const [mode, busHome, ...args] = argv;
  let verb = "tap";
  try {
    if (!busHome) throw new Error("reset fence requires a bus path");
    const { values } = parseArgs({ args, options: {
      "owner-pid": { type: "string" }, "bundle-id": { type: "string" }, op: { type: "string" },
      phase: { type: "string" }, token: { type: "string" }, what: { type: "string" },
      why: { type: "string" }, verb: { type: "string" },
    } });
    verb = values.verb ?? "tap";
    const required = (value: string | undefined, name: string): string => {
      if (!value) throw new Error(`reset fence requires ${name}`);
      return value;
    };
    switch (mode) {
      case "read": {
        const fields = readResetFence(busHome);
        if (!fields) return 1;
        process.stdout.write(`${fields.join("\n")}\n`); return 0;
      }
      case "owner-live": {
        const live = fenceOwnerLive(join(busHome, "reset.fence.json"));
        process.stdout.write(live ? "live\n" : "stale\n"); return live ? 0 : 1;
      }
      case "guard": {
        const refusal = resetFenceRefusal(busHome, values.what ?? "this operation");
        if (refusal) throw new TapError(1, "team_reset_fenced", refusal.action, refusal.detail);
        return 0;
      }
      case "acquire": process.stdout.write(acquireResetFence(busHome, required(values["owner-pid"], "owner-pid"), values["bundle-id"], values.op)); return 0;
      case "set-phase": return setResetFencePhase(busHome, required(values.phase, "phase"), required(values.token, "token"));
      case "release": return releaseResetFence(busHome, required(values.token, "token"));
      case "stamp-pristine": stampResetGenerationPristine(busHome, values["bundle-id"] ?? ""); return 0;
      case "mark-reused": markResetGenerationReused(busHome, values.why ?? "mutation"); return 0;
      case "proc-start-epoch": {
        const epoch = procStartEpoch(required(values["owner-pid"], "owner-pid"));
        process.stdout.write(epoch); return epoch ? 0 : 1;
      }
      default: throw new Error(`unknown reset fence operation '${mode}'`);
    }
  } catch (error) {
    if (!(error instanceof TapError) && mode === "acquire") error = new TapError(1, "reset_in_progress", "tap team reset",
      `refusing reset — fence acquire failed (${error instanceof Error ? error.message : String(error)})`);
    if (error instanceof TapError) {
      if (process.env.TAP_JSON === "1") process.stdout.write(errorJson(error.errorClass, error.action, error.detail));
      else process.stderr.write(`${verb}: ${humanLine(error.detail)}; next: ${humanAction(error.action)}\n`);
      return error.code;
    }
    process.stderr.write(`tap: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(resetFenceCli(process.argv.slice(2)));
