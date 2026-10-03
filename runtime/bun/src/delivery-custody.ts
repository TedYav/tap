// Canonical residency is not proof of delivery. This verdict never authorizes retry.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDict, parseJsonPreserving, pyReadUtf8, pyTruthy } from "./spool-publication";
import { isFile } from "./watch-lease";

export function hasDeliveryReceipt(home: string, id: string): boolean {
  // Even unreadable terminal evidence keeps withdrawal from bypassing delivery.
  return ["sent", "read", "done", "cancelled", "harness-queued"].some(suffix => existsSync(join(home, "receipts", `${id}.${suffix}`)));
}

function hasAttemptEvidence(home: string, id: string): boolean {
  // The marker's mere presence is the evidence; unreadable is uncertainty, so refuse.
  try { lstatSync(join(home, "receipts", `${id}.attempted`)); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}

/**
 * The write-ahead repark mark licenses moving a payloads/ body back to spool/ only
 * while no attempt evidence and no delivery receipt exists (tap-c9vlf). mark +
 * `.attempted` is a possibly-attempted body — a kill after the attempt was admitted,
 * or a refused post-submit repark — and every repark_pending reader treats it as a
 * surface order, never a repark license. The id's obligation lock, which every mover
 * of payloads/<id>.md holds across its attempt, is the serialization point; this
 * predicate is the license check, not the lock. (The deadline flow's terminalize
 * promotes spool -> payloads without that lock, but it never submits, always holds
 * reset custody, and publishes a terminal receipt that this license refuses.)
 *
 * The one `.attempted` exception is the staged-idle hold's Enter-only re-adoption
 * (tap-9lqa7): a crashed hold (mark + staged-idle metadata + attempt evidence,
 * body canonical) may move back within its window because re-adoption can never
 * re-enter injection — the idleStaged arm only presses Enter under its own
 * one-shot `.idle-submit` license. Past the window the exception lapses, the
 * mark becomes a surface order again, and the sweep reports the body unconfirmed.
 */
export function reparkLicensed(home: string, id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const meta = parseJsonPreserving(pyReadUtf8(join(home, "spool", `${id}.meta.json`)));
    if (!isDict(meta) || !pyTruthy((meta as Record<string, unknown>).repark_pending)) return false;
    if (hasDeliveryReceipt(home, id)) return false;
    if (!hasAttemptEvidence(home, id)) return true;
    if ((meta as Record<string, unknown>).reason !== "staged-idle") return false;
    const raw = (meta as Record<string, unknown>).deadline_epoch;
    const deadline = typeof raw === "number" ? (Number.isSafeInteger(raw) ? raw : null)
      : typeof raw === "string" && /^[0-9]+$/.test(raw) ? Number(raw) : null;
    if (deadline === null) return false;
    const now = env.TAP_SPOOL_NOW && /^[0-9]+$/.test(env.TAP_SPOOL_NOW)
      ? Number(env.TAP_SPOOL_NOW) : Math.floor(Date.now() / 1000);
    return now < deadline;
  } catch { return false; }
}

export function unverifiedCanonical(home: string, id: string): boolean {
  if (!isFile(join(home, "payloads", `${id}.md`))) return false;
  if (hasDeliveryReceipt(home, id)) return false;
  // Direct rc-5 sends keep their canonical beside an Enter-only staged hold.
  // This is still unconfirmed custody: an explicit --spooled withdrawal may
  // archive the canonical and retire the spool copy under the obligation lock.
  if (existsSync(join(home, "spool", `${id}.md`))) return retainedStagedIdleCopy(home, id) && hasAttemptEvidence(home, id);
  if (isFile(join(home, "receipts", `${id}.unconfirmed`))) return true;
  const meta = join(home, "spool", `${id}.meta.json`);
  if (!isFile(meta)) return false;
  try {
    // The mark suppresses surfacing only while it is a repark license; mark +
    // attempt evidence is a possibly-attempted body the sweep must surface.
    if (JSON.parse(readFileSync(meta, "utf8"))?.repark_pending) return !reparkLicensed(home, id);
  } catch { /* Unreadable metadata is uncertainty, never delivery proof. */ }
  return true;
}

/** The only supported dual-resident payload: direct rc 5 plus its staged-idle copy. */
export function retainedStagedIdleCopy(home: string, id: string): boolean {
  if (!isFile(join(home, "payloads", `${id}.md`)) || !isFile(join(home, "spool", `${id}.md`))) return false;
  try {
    const meta = parseJsonPreserving(pyReadUtf8(join(home, "spool", `${id}.meta.json`)));
    return isDict(meta) && (meta as Record<string, unknown>).reason === "staged-idle";
  } catch { return false; }
}

export function unverifiedCanonicalMessage(id: string): string {
  return `Delivery unverified; canonical body retained, prior recipient effect unknown. Automatic retry stopped. The sender may withdraw with tap cancel ${id} --spooled.`;
}
