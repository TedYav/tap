// A repark the drain could not perform (tap-conft), and the write-ahead mark that
// makes a kill between the pre-submit move and the repark recoverable (tap-c9vlf).
// The drain marks the entry before moving spool/<id>.md to payloads/; a kill after
// the move strands a LICENSED entry (mark, no attempt evidence) instead of an
// unmarked one the orphan sweep would retire as unconfirmed. The waiter retries that
// one move; the watch drain's recoverStrandedReparks is the driver when the waiter
// itself is what died. A body with attempt evidence is never moved back: that is a
// possible effect, and reparkLicensed (delivery-custody.ts) is the one license both
// paths read.
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { reparkLicensed } from "./delivery-custody";
import { acquireObligationLock, acquirePathLock } from "./panelock";
import { RESET_HELD_LOCK_WAIT_MS, withResetCustody } from "./reset";
import { isDict, metaBytes, METADATA_LOCK_TIMEOUT_MS, parseJsonPreserving, pyInt, pyReadUtf8, pyTruthy } from "./spool-publication";
import { claimPath, metaPath, payloadPath } from "./spool-sidecar";
import { lockNameFits } from "./fsatomic";

type Meta = Record<string, unknown>;
function isFile(path: string): boolean { try { return statSync(path).isFile(); } catch { return false; } }

/**
 * The claim is the deadline flows' mover exclusion (spool-deadline.ts claims the id,
 * and terminalize promotes the body under shared reset custody only), so recovery
 * must not race a LIVE claim holder. A SIGKILL-residual claim whose owner is
 * provably dead (ESRCH) is exactly this driver's crash case and does not block;
 * a claim too broken to prove an owner stays with the stale-claim reap. A reused
 * pid reads as alive: err toward waiting, never toward racing.
 */
function recoveryBlockedByClaim(spoolDir: string, id: string): boolean {
  let doc: { v?: unknown; id?: unknown; owner_pid?: unknown } | null = null;
  try { doc = JSON.parse(readFileSync(claimPath(spoolDir, id), "utf8")); }
  catch { return existsSync(claimPath(spoolDir, id)); }
  if (typeof doc !== "object" || doc === null || doc.v !== 1 || doc.id !== id
    || typeof doc.owner_pid !== "number" || !Number.isInteger(doc.owner_pid) || doc.owner_pid <= 0) return true;
  try { process.kill(doc.owner_pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Rewrite the metadata under its lock; `then` runs after the write, still locked. Null: lock or parse failed. */function rewriteMeta(path: string, waitMs: number, env: NodeJS.ProcessEnv, change: (meta: Meta) => boolean, then: () => void = () => {}): boolean | null {
  if (!lockNameFits(`${path}.lock`)) return null;
  const lock = acquirePathLock(`${path}.lock`, waitMs, env);
  if (!lock) return null;
  try {
    const meta = parseJsonPreserving(pyReadUtf8(path));
    if (!isDict(meta)) return null;
    if (!change(meta as Meta)) return false;
    writeFileSync(`${path}.tmp`, metaBytes(meta as Record<string, never>).replace(/\n$/, ""));
    renameSync(`${path}.tmp`, path);
    then();
    return true;
  } catch { return null; } finally { lock.release(); }
}

/**
 * The drain's write-ahead mark, taken under its pre-submit custody before the body moves.
 * Inside reset custody pass RESET_HELD_LOCK_WAIT_MS (registry-unit-1 part 02 lock order).
 * "busy": the lock or write was unavailable — refuse the move; the entry stays parked and
 * the next drain retries; so does metadata that cannot be read. Absent metadata is created minimal
 * under the same lock, so the write-ahead still holds. "unparseable": metadata read but not parsed is evidence,
 * never rewritten — the caller delivers without the mark rather than strand the entry.
 */
export type ReparkMark = "marked" | "busy" | "unparseable";
export function markReparkPendingOutcome(spoolDir: string, id: string, env: NodeJS.ProcessEnv = process.env,
  waitMs = METADATA_LOCK_TIMEOUT_MS): ReparkMark {
  const path = metaPath(spoolDir, id);
  if (!lockNameFits(`${path}.lock`)) return "busy";
  const lock = acquirePathLock(`${path}.lock`, waitMs, env);
  if (!lock) return "busy";
  try {
    let meta: unknown;
    try { lstatSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "busy";
      meta = { id };
    }
    if (meta === undefined) {
      let bytes: Buffer;
      try { bytes = readFileSync(path); } catch { return "busy"; }
      try {
        meta = parseJsonPreserving(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
      } catch { return "unparseable"; }
      if (!isDict(meta)) return "unparseable";
    }
    (meta as Meta).repark_pending = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    writeFileSync(`${path}.tmp`, metaBytes(meta as Record<string, never>).replace(/\n$/, ""));
    renameSync(`${path}.tmp`, path);
    return "marked";
  } catch { return "busy"; } finally { lock.release(); }
}
export function markReparkPending(spoolDir: string, id: string, env: NodeJS.ProcessEnv = process.env,
  waitMs = METADATA_LOCK_TIMEOUT_MS): boolean {
  return markReparkPendingOutcome(spoolDir, id, env, waitMs) === "marked";
}

/** Consume the mark once the body is back in spool/ or the entry is otherwise settled. Inside reset custody pass RESET_HELD_LOCK_WAIT_MS. */
export function clearReparkPending(spoolDir: string, id: string, env: NodeJS.ProcessEnv = process.env,
  waitMs = METADATA_LOCK_TIMEOUT_MS): void {
  rewriteMeta(metaPath(spoolDir, id), waitMs, env, meta => {
    if (!pyTruthy(meta.repark_pending)) return false;
    delete meta.repark_pending;
    return true;
  });
}

/**
 * tap-9lqa7: hold an unverified drain submit as staged-idle, or report the
 * hold a staged-idle entry already carries. A FRESH hold rewrites the parked
 * entry's metadata in place — reason, the window bound as both
 * timeout_seconds and deadline_epoch (mirroring mintMeta's staged-idle
 * branch), and the waiter's readiness-gate lifetime — so the existing waiter
 * keeps following the entry and the next drain's idleStaged authority may
 * press Enter once on a still-staged wire. The deadline_source is cleared
 * deliberately: expiry ages through the ordinary escalation ladder, never a
 * held-present renewal and never a sender-wake terminalize. An entry already
 * holding reports "held" while its window runs and "expired" once past it —
 * the window is stamped once and never re-armed. The caller moves the body
 * back to spool/ around this write, under the same reset custody.
 */
export type StagedIdleHold = "held" | "expired" | "busy";
export function stagedIdleHoldOutcome(spoolDir: string, id: string, windowSeconds: number,
  env: NodeJS.ProcessEnv = process.env, waitMs = METADATA_LOCK_TIMEOUT_MS): StagedIdleHold {
  const path = metaPath(spoolDir, id);
  if (!lockNameFits(`${path}.lock`)) return "busy";
  const lock = acquirePathLock(`${path}.lock`, waitMs, env);
  if (!lock) return "busy";
  try {
    const meta = parseJsonPreserving(pyReadUtf8(path));
    if (!isDict(meta)) return "busy";
    const now = env.TAP_SPOOL_NOW && /^[0-9]+$/.test(env.TAP_SPOOL_NOW) ? Number(env.TAP_SPOOL_NOW) : Math.floor(Date.now() / 1000);
    if ((meta as Meta).reason === "staged-idle") {
      const deadline = pyInt((meta as Meta).deadline_epoch);
      return deadline !== null && now < deadline ? "held" : "expired";
    }
    (meta as Meta).reason = "staged-idle";
    (meta as Meta).timeout_seconds = String(windowSeconds);
    (meta as Meta).deadline_epoch = String(now + windowSeconds);
    (meta as Meta).waiter_lifetime = "readiness-gate";
    (meta as Meta).deadline_source = "";
    writeFileSync(`${path}.tmp`, metaBytes(meta as Record<string, never>).replace(/\n$/, ""));
    renameSync(`${path}.tmp`, path);
    return "held";
  } catch { return "busy"; } finally { lock.release(); }
}

/** A body out of spool/ carrying the mark: the repark FLOW must run (waiter retry or the watch drain's driver). Whether the move itself is licensed is reparkLicensed's call inside retryRepark — a body with attempt evidence or a delivery receipt still needs the mark consumed and the settled verdict, just never the move. */
export function reparkStranded(spoolDir: string, id: string): boolean {
  if (isFile(payloadPath(spoolDir, id))) return false;
  try {
    const meta = parseJsonPreserving(pyReadUtf8(metaPath(spoolDir, id)));
    return isDict(meta) && pyTruthy((meta as Record<string, unknown>).repark_pending);
  } catch { return false; }
}

/** `busy` retries; `fenced` belongs to a team reset; `settled` means nothing is left to move. */
export type ReparkOutcome = "reparked" | "settled" | "busy" | "fenced";

/**
 * One retry of the recorded repark. Lock order (registry-unit-1 part 02): the id's
 * obligation lock, which settlement (reply, read) holds while publishing `.done`
 * and which every mover of payloads/<id>.md holds across its attempt, so neither the
 * terminal check nor the move can race a settle or a live submit; then reset custody;
 * then the metadata lock with the held-lock bound. Under them it moves first and
 * clears the mark after (tap-c9vlf): a kill in between leaves a stale mark riding a
 * spool-resident body, which no reparkLicensed reader can mistake for a license —
 * the reverse order would recreate the unmarked-stranded miss it exists to close.
 * Attempt evidence or a delivery receipt refuses the move; the mark is consumed
 * either way, and the sweep surfaces attempt evidence as unconfirmed. A body gone
 * from payloads/ clears the mark and moves nothing. A move that cannot be
 * performed keeps the mark and reports busy, so an unattempted body never loses
 * its license. The caller holds no lock.
 */
export function retryRepark(home: string, id: string, env: NodeJS.ProcessEnv = process.env, waitMs?: number,
  obligationWaitMs = RESET_HELD_LOCK_WAIT_MS): ReparkOutcome {
  const spoolDir = join(home, "spool"), canon = join(home, "payloads", `${id}.md`), parked = payloadPath(spoolDir, id);
  const obligation = acquireObligationLock(id, obligationWaitMs, env);
  if (!obligation) return "busy";
  try {
    const held = withResetCustody(home, "courier repark", (): ReparkOutcome => {
      // Outcome starts busy: rewriteMeta null (lock refused, parse failed) keeps
      // it; the change callback sets every other verdict from the body's real
      // location under the metadata lock.
      let outcome: ReparkOutcome = "busy";
      rewriteMeta(metaPath(spoolDir, id), RESET_HELD_LOCK_WAIT_MS, env, meta => {
        if (!pyTruthy(meta.repark_pending)) { outcome = "settled"; return false; }
        // The under-lock re-check is the one that counts (M1): never overwrite a
        // parked body, and a body gone from payloads/ is settled, not a license.
        if (reparkLicensed(home, id, env) && !isFile(parked) && isFile(canon)) {
          // A failed move keeps the mark and reports busy:
          // consuming it here would strand an unattempted body unlicensed — the
          // exact miss the mark exists to close. The body stays canonical and
          // licensed for the waiter or the next watch tick.
          try { renameSync(canon, parked); outcome = "reparked"; }
          catch { outcome = "busy"; return false; }
        } else outcome = "settled";
        delete meta.repark_pending;
        return true;
      });
      return outcome;
    }, waitMs);
    return held.ok ? held.value : held.refusal === "team_reset_fenced" ? "fenced" : "busy";
  } finally { obligation.release(); }
}

/**
 * The watch drain's recovery driver (tap-c9vlf): a drain or waiter killed after the
 * pre-submit move leaves the licensed mark with nobody to retry the move. Candidates
 * come from one listing of spool/ on every tick, never the cleanup cursor's batch
 * (tap-kip6q): the mark changes a metadata file's contents, not its name, so a cursor
 * that already passed the name would hold the strand until its snapshot wrapped. A
 * strand is a metadata name whose spool body is absent from that same listing; the
 * drain already lists spool/ each tick, so this adds no scan. Zero waits on the
 * obligation and custody locks — a busy candidate skips to the next tick; the
 * metadata lock inside retryRepark waits at most RESET_HELD_LOCK_WAIT_MS. The
 * obligation lock serializes against a live drain mid-attempt, and retryRepark
 * re-checks the license under it; the sweep still surfaces a body whose license
 * lapsed into attempt evidence.
 */
export function recoverStrandedReparks(spoolDir: string, payloadsDir: string, env: NodeJS.ProcessEnv = process.env): void {
  let names: string[];
  try { names = readdirSync(spoolDir); } catch { return; }
  const bodies = new Set(names.filter(name => name.endsWith(".md")));
  const home = dirname(spoolDir);
  for (const name of names) {
    if (!name.endsWith(".meta.json")) continue;
    const id = name.slice(0, -".meta.json".length);
    if (bodies.has(`${id}.md`) || isFile(payloadPath(spoolDir, id)) || !isFile(join(payloadsDir, `${id}.md`))) continue;
    // A live claim holder stays unexcluded by the obligation lock (the deadline
    // flows claim and terminalize without it), so only a provably dead owner's
    // residual claim — the SIGKILL shape this driver exists for — may proceed.
    if (recoveryBlockedByClaim(spoolDir, id)) continue;
    if (!reparkLicensed(home, id, env)) continue;
    retryRepark(home, id, env, 0, 0);
  }
}
