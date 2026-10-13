import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { receiptBytes } from "./fsatomic";
import { validId } from "./ids";
import { acquireResetMutationLock } from "./reset";
import { TapError } from "./context";
import { retryIdleSubmitPath } from "./retry";

/** All callers mint under short reset custody, immediately before their first effect. */
export function beginDeliveryAttempt(home: string, id: string): "created" | "existing" {
  return beginDeliveryAttempts(home, [id]);
}

/** Refuse a previously attempted member before marking any fresh member. */
export function beginDeliveryAttempts(home: string, ids: readonly string[]): "created" | "existing";
export function beginDeliveryAttempts(home: string, ids: readonly string[], beforeCreate: () => boolean): "created" | "existing" | "refused";
export function beginDeliveryAttempts(home: string, ids: readonly string[], beforeCreate?: () => boolean): "created" | "existing" | "refused" {
  if (!home || !ids.length || ids.some(id => !validId(id)) || new Set(ids).size !== ids.length)
    throw new Error("delivery attempt needs a bus home and valid ids without duplicates");
  const lock = acquireResetMutationLock(home, "courier delivery attempt", undefined, "shared");
  try {
    for (const id of ids) {
      try { lstatSync(join(home, "receipts", `${id}.attempted`)); return "existing"; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    // Acquiring custody can wait: the final pane guard belongs after that wait
    // but before any durable possible-effect evidence is created.
    if (beforeCreate && !beforeCreate()) return "refused";
    // An I/O failure or crash may leave a prefix. Retain that conservative
    // evidence; the caller requires every marker before permitting a key.
    for (const id of ids) if (writeAttempt(home, id) !== "created") return "existing";
    return "created";
  } finally { lock.release(); }
}

/**
 * The idle-time Enter license (tap-9lqa7): a SECOND, separate one-shot marker,
 * never a reuse of the attempt license. `receipts/<id>.attempted` already
 * exists for a staged-idle entry and `admitEffect` rightly refuses it; the
 * single Enter on a composer holding exactly one well-formed sentinel adds no
 * bytes, so its own link-atomic receipt is the admission record (scoped to the
 * retry UUID for a retry row). Minted under
 * short reset custody, under the pane lock, after the final authorize and the
 * two-sample check, immediately before the key. Existence refuses re-fire.
 */
export function beginIdleSubmit(home: string, id: string, fields: {
  stagedId: string; pane: string; agentState: string; retry?: string;
}): "created" | "existing" {
  if (!home || !validId(id)) throw new Error("idle submit license needs a bus home and a valid id");
  const destination = fields.retry === undefined ? join(home, "receipts", `${id}.idle-submit`) : retryIdleSubmitPath(home, id, fields.retry);
  const lock = acquireResetMutationLock(home, "courier idle submit license", undefined, "shared");
  try {
    try { lstatSync(destination); return "existing"; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const receipts = join(home, "receipts");
    mkdirSync(receipts, { recursive: true });
    const temporary = join(receipts, `.idle-submit.${process.pid.toString(36)}.${Math.random().toString(36).slice(2, 10)}`);
    const fd = openSync(temporary, "wx", 0o600);
    try {
      try {
        writeFileSync(fd, receiptBytes({
          id, effect: "possible", ...(fields.retry === undefined ? {} : { retry: fields.retry }),
          label: "idle-time submit of a staged sentinel (Enter only, no bytes)",
          expected_id: id, staged_id: fields.stagedId, pane: fields.pane, agent_state: fields.agentState,
        }));
        fsyncSync(fd);
      } finally { closeSync(fd); }
      try { linkSync(temporary, destination); return "created"; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return "existing";
        throw error;
      }
    } finally {
      try { unlinkSync(temporary); } catch { /* already absent */ }
    }
  } finally { lock.release(); }
}

/** Create the conservative possible-effect marker without exposing partial bytes. */
function writeAttempt(home: string, id: string): "created" | "existing" {
  const receipts = join(home, "receipts");
  mkdirSync(receipts, { recursive: true });
  const destination = join(receipts, `${id}.attempted`);
  const temporary = join(receipts, `.attempted.${process.pid.toString(36)}.${Math.random().toString(36).slice(2, 10)}`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, receiptBytes({ id, effect: "possible" }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporary, destination);
      return "created";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return "existing";
      throw error;
    }
  } finally {
    try { unlinkSync(temporary); } catch { /* already absent */ }
  }
}

if (import.meta.main) {
  const [operation, home, id] = process.argv.slice(2);
  if (operation !== "begin" || !home || !id) {
    console.error("usage: delivery-attempt.ts begin <tap-home> <id>");
    process.exit(2);
  }
  try {
    console.log(beginDeliveryAttempt(home, id));
  } catch (error) {
    if (error instanceof TapError && ["team_reset_fenced", "reset_custody_busy"].includes(error.errorClass)) {
      console.error(`tap: delivery attempt for '${id}' refused — reset custody ${error.errorClass === "team_reset_fenced" ? "fenced" : "busy"}`);
    } else console.error(`tap: cannot record delivery attempt: ${error}`);
    process.exit(1);
  }
}
