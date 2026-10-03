// The `.reown` lease: "has anyone started an owner for this id recently?" —
// the throttle on deliverer spawns after a re-park, deliberately NOT the
// delivery `.claim` (a lease over delivering, held mid-attempt) and NOT the
// pane-submit lock. Lane A, batch 2, slice A1b (U3). Every operation runs
// under the entry's EXISTING `<meta>.lock`, the file the metadata writers and
// the stale-sidecar reaper already agree on; the wait is bounded
// (`METADATA_LOCK_TIMEOUT_MS`) where `fcntl.flock(LOCK_EX)` waited forever —
// a declared delta, refused as "not claimed"/"not refreshed"/no-op.
import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, openSync, closeSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { acquirePathLock } from "./panelock";
import { METADATA_LOCK_TIMEOUT_MS, pyFloatString, pyStrip } from "./spool-publication";
import { metaPath, payloadPath } from "./spool-sidecar";
import { lockNameFits } from "./fsatomic";

export function reownPath(spoolDir: string, id: string): string {
  return `${metaPath(spoolDir, id)}.reown`;
}

/**
 * `tap_reown_claim <id>`: mint and write a fresh owner token unless a FRESH
 * incumbent holds the lease (its mtime within `staleSeconds`,
 * `TAP_SPOOL_REOWN_LEASE_SECONDS`, default 20). Under the lock, an ABSENT
 * payload whose directory is readable is a clean refusal (the entry is
 * settled); an unreadable directory is the unknown case and still mints. A
 * stale incumbent is replaced. Returns the token, or null (the incumbent's rc 1).
 */
export function reownClaim(spoolDir: string, id: string, staleSeconds: string, now: number = Date.now() / 1000, env: NodeJS.ProcessEnv = process.env): string | null {
  const meta = metaPath(spoolDir, id);
  const lease = reownPath(spoolDir, id);
  const payload = payloadPath(spoolDir, id);
  // Python: `float(sys.argv[2])` before the lock — an unparseable value raised (exit 1).
  const stale = pyFloatString(staleSeconds);
  if (stale === null) return null;
  // A lock name the filesystem cannot hold refuses at once (the incumbent's open() raised).
  if (!lockNameFits(`${meta}.lock`)) return null;
  const lock = acquirePathLock(`${meta}.lock`, METADATA_LOCK_TIMEOUT_MS, env);
  if (!lock) return null;
  try {
    try {
      if (!existsSync(payload) && dirReadable(dirname(payload) || ".")) return null;
    } catch { /* OSError: fall through, claimable */ }
    try {
      const mtime = statSync(lease).mtimeMs / 1000;
      if (now - mtime <= stale) return null; // a live owner holds it; do not spawn a second
    } catch { /* absent, or unreadable — either way, claimable */ }
    // `secrets.token_hex(8)`: 16 hex characters of real randomness.
    const token = randomBytes(8).toString("hex");
    const tmp = `${lease}.tmp.${process.pid}`;
    writeFileSync(tmp, token);
    renameSync(tmp, lease); // atomic: no reader ever sees a half-written token
    return token;
  } finally { lock.release(); }
}

/**
 * `tap_reown_refresh <id> <token>`: touch the lease only on token match. A
 * mismatch (or no lease) means this waiter was superseded: false.
 */
export function reownRefresh(spoolDir: string, id: string, token: string, now: number = Date.now() / 1000, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!token) return false;
  const meta = metaPath(spoolDir, id);
  const lease = reownPath(spoolDir, id);
  if (!lockNameFits(`${meta}.lock`)) return false;
  const lock = acquirePathLock(`${meta}.lock`, METADATA_LOCK_TIMEOUT_MS, env);
  if (!lock) return false;
  try {
    let held: string;
    try { held = pyStrip(readFileSync(lease, "utf8")); } catch { return false; }
    if (held !== token) return false;
    // `os.utime(lease, None)`: both times to now.
    const date = new Date(now * 1000);
    utimesSync(lease, date, date);
    return true;
  } finally { lock.release(); }
}

/**
 * `tap_reown_release <id> <token>`: unlink the lease on token match and NO-OP
 * on anything else — a departing waiter whose lease was already replaced must
 * leave the successor's authority standing. Never fails (the incumbent's `|| true`).
 */
export function reownRelease(spoolDir: string, id: string, token: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!token) return;
  const meta = metaPath(spoolDir, id);
  const lease = reownPath(spoolDir, id);
  if (!lockNameFits(`${meta}.lock`)) return;
  const lock = acquirePathLock(`${meta}.lock`, METADATA_LOCK_TIMEOUT_MS, env);
  if (!lock) return;
  try {
    let held: string;
    try { held = pyStrip(readFileSync(lease, "utf8")); } catch { return; }
    if (held !== token) return;
    try { unlinkSync(lease); } catch { /* already gone */ }
  } finally { lock.release(); }
}

/**
 * `tap_spool_reown_after_repark <id>` up to the mint: every path that returns a
 * body to spool/ asks here whether to start an owner. Absent payload with a
 * readable directory is a clean no-op (a settled entry); unreadable is UNKNOWN
 * and spawns (the deliverer's first loop check exits 0 if the payload is gone).
 * Returns the token the caller must hand the deliverer by ENV
 * (`TAP_SPOOL_REOWN_TOKEN`), or null when nothing should be spawned.
 */
export function reownAfterRepark(spoolDir: string, id: string, staleSeconds: string, now: number = Date.now() / 1000, env: NodeJS.ProcessEnv = process.env): string | null {
  const payload = payloadPath(spoolDir, id);
  if (!(existsSync(payload) || !dirReadable(dirname(payload)))) return null;
  const token = reownClaim(spoolDir, id, staleSeconds, now, env);
  return token || null;
}

function dirReadable(path: string): boolean { try { accessSync(path, constants.R_OK); return true; } catch { return false; } }

// --- CLI (the adapters' door) --------------------------------------------------
// Every DECIDED outcome is a verdict at exit 0 — a superseded waiter or a fresh
// incumbent is routine, and the adapter boundary (`tap_bun_call`) reports any
// nonzero exit as `slice_failed`; exit 1 is that boundary alone.
//   claim <spool> <id> <stale-seconds>        → token on stdout, or nothing (not claimed)
//   refresh <spool> <id> <token>              → refreshed | superseded
//   release <spool> <id> <token>              → (nothing)
//   after-repark <spool> <id> <stale-seconds> → token on stdout, or nothing (nothing to spawn)
export function main(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  const [verb, spool = "", id = "", third = ""] = argv;
  const now = env.TAP_SPOOL_NOW && /^[0-9]+$/.test(env.TAP_SPOOL_NOW) ? Number(env.TAP_SPOOL_NOW) : Date.now() / 1000;
  switch (verb) {
    case "claim": {
      const token = reownClaim(spool, id, third, now, env);
      if (token !== null) process.stdout.write(token);
      return 0;
    }
    case "refresh": process.stdout.write(reownRefresh(spool, id, third, now, env) ? "refreshed" : "superseded"); return 0;
    case "release": reownRelease(spool, id, third, env); return 0;
    case "after-repark": {
      const token = reownAfterRepark(spool, id, third, now, env);
      if (token !== null) process.stdout.write(token);
      return 0;
    }
    default:
      process.stderr.write(`tap spool-reown: unknown subcommand '${verb ?? ""}'\n`);
      return 1;
  }
}

// Let the rows drain: a forced exit cuts a pending pipe write at 64 KiB (the
// drain rule: 250 pairs through a slow pipe = 122 rows, exit 0,
// and both drain projections skip the torn tail without a failed status). A
// reader that went away surfaces on the stream after `main` returns: exit 1, one line.
if (import.meta.main) {
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    process.stderr.write(`tap spool-reown: stdout ${error.code ?? error.message}\n`);
    process.exitCode = 1;
  });
  process.exitCode = main(process.argv.slice(2));
}
