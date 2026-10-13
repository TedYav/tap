// Accepted by the harness queue is transport state, never recipient processing.
import { existsSync, linkSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { atomicWrite, jsonObj } from "./fsatomic";
import { envelopeField } from "./envelope";
import { utcStamp, validToken } from "./ids";

function receipt(home: string, id: string, suffix: string): Record<string, string> | null {
  try {
    const value = JSON.parse(readFileSync(join(home, "receipts", `${id}.${suffix}`), "utf8"));
    return value && typeof value === "object" && value.id === id ? value : null;
  } catch { return null; }
}

// First complete observation wins, including concurrent read/replay callers.
function publishOnce(path: string, fields: Record<string, string | undefined>): void {
  const temp = join(dirname(path), `.harness-queue.${randomUUID()}`);
  try {
    atomicWrite(temp, jsonObj(fields) + "\n");
    try { linkSync(temp, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { rmSync(temp, { force: true }); }
}

function nonAuthoritativeRead(value: Record<string,string>): boolean {
  return String(value.forced) === "true" || value.reason === "instance_retired";
}
export function hasTerminalQueueReceipt(home: string, id: string): boolean {
  const done = receipt(home,id,"done");
  return !!(receipt(home,id,"sent") || receipt(home,id,"cancelled") || (done && !nonAuthoritativeRead(done)));
}

export function harnessQueued(home: string, id: string): boolean {
  const queued = receipt(home, id, "harness-queued");
  return queued?.status === "queued" && queued.delivery === "harness-queue"
    && !hasTerminalQueueReceipt(home,id);
}

/** The immutable first `.read`/`.done` observation is forced/retired evidence:
 *  never proof of recipient processing, always preserved as the audit record. */
export function firstObservationNonAuthoritative(home: string, id: string): boolean {
  const first = receipt(home, id, "read") ?? receipt(home, id, "done");
  return !!first && nonAuthoritativeRead(first);
}

/** Evidence of the authorized read performed by the invoking process itself.
 *  Supplied only by a caller that just completed its own grant-validated,
 *  non-forced, non-retired read. */
export interface AuthorizedReadEvidence { by: string; at: string; }

/** Terminal marker presence, parse-independent: a malformed or wrong-id
 *  `.cancelled` file and the archive tombstone both fail closed — terminal
 *  even if the receipt bytes are unreadable or a crash lost them. */
export function terminalCancelMarker(home: string, id: string): boolean {
  return existsSync(join(home, "receipts", `${id}.cancelled`))
    || existsSync(join(home, "archive", `${id}.cancelled.md`));
}

/** Durable carry for the authorized successor read: minted only by a
 *  grant-validated, non-forced, non-retired read that follows a forced or
 *  retired first observation. It is the only proof of that genuine read, so it
 *  is kept even when transport `.sent` already exists (a confirmed pane send):
 *  the queue receipt may arrive later through recordHarnessQueued, and retry
 *  suppression and stats read it through recipientState. The forced/retired
 *  first observation stays byte-immutable beside it. */
export function recordAuthorizedRead(home: string, id: string, evidence: AuthorizedReadEvidence): void {
  try {
    if (terminalCancelMarker(home, id) || receipt(home, id, "authorized-read")) return;
    publishOnce(join(home, "receipts", `${id}.authorized-read`), {
      id, by: evidence.by, at: evidence.at, via: "read", turn: "unconfirmed",
    });
  } catch (error) { console.error(`tap: authorized-read evidence unavailable for ${id}: ${error}`); }
}

/**
 * The recipient-observed rule (receipt-measures.md): terminal state first, then
 * any authoritative observation. A forced or retired-instance `.read` never
 * counts; the genuine successor read is carried by `.authorized-read` or by a
 * `.sent` minted on harness-queue read. Marker presence fails closed for the
 * terminal states, as `terminalCancelMarker` does.
 */
export function recipientState(home: string, id: string): { state: "cancelled" | "settled" | "observed" | "unobserved"; via?: string; at?: string } {
  if (terminalCancelMarker(home, id)) return { state: "cancelled" };
  if (existsSync(join(home, "receipts", `${id}.done`))) {
    const done = receipt(home, id, "done");
    return { state: "settled", via: done?.via || "done", ...(done?.at ? { at: done.at } : {}) };
  }
  const read = receipt(home, id, "read");
  if (read?.by && !nonAuthoritativeRead(read)) return { state: "observed", via: "read", ...(read.at ? { at: read.at } : {}) };
  const authorized = receipt(home, id, "authorized-read");
  if (authorized?.by) return { state: "observed", via: "authorized-read", ...(authorized.at ? { at: authorized.at } : {}) };
  const sent = receipt(home, id, "sent");
  if (sent?.via === "harness-queue-read" && sent.read_by) return { state: "observed", via: "harness-queue-read", ...(sent.read_at ? { at: sent.read_at } : {}) };
  return { state: "unobserved" };
}

/** Returns whether the queued delivery is complete (`.sent` exists) after the
 *  call. Receipt-derived authority keeps its exact prior shape; the explicit
 *  `authorized` evidence and the durable `.authorized-read` record are the
 *  only other proofs consulted — never the forced/retired first observation. */
export function completeHarnessQueued(home: string, id: string, authorized?: AuthorizedReadEvidence): boolean {
  const sent = () => !!receipt(home, id, "sent");
  const queued = receipt(home, id, "harness-queued");
  if (!queued || queued.status !== "queued" || queued.delivery !== "harness-queue") return sent();
  // Terminal cancellation outranks queue telemetry: a withdrawn or cancelled
  // payload never gains fresh `.sent` or authorized-read carry, while an
  // existing `.sent` is preserved. Marker presence fails closed — a malformed
  // or wrong-id `.cancelled` file and the archive tombstone are both terminal.
  if (terminalCancelMarker(home, id)) return sent();
  const read = authorized ?? (() => {
    const first = receipt(home, id, "read") ?? receipt(home, id, "done");
    if (first && first.by && !nonAuthoritativeRead(first)
        && !(first.status === "done" && first.via !== "read")) return first;
    return receipt(home, id, "authorized-read");
  })();
  if (!read) return sent();
  try {
    publishOnce(join(home, "receipts", `${id}.sent`), {
      ...queued, status: "sent", at: utcStamp(), via: "harness-queue-read",
      read_by: read.by, read_at: read.at, turn: "unconfirmed",
    });
  } catch (error) { console.error(`tap: read observed; queued delivery telemetry unavailable for ${id}: ${error}`); }
  return sent();
}

export function recordHarnessQueued(home: string, id: string, route?: { from: string; to: string; kind: string }): void {
  try {
    const path = join(home, "payloads", `${id}.md`);
    if (receipt(home, id, "cancelled") || (!existsSync(path) && !route)) return;
    // Index-backed digests carry their routing through the delivery input.
    const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
    publishOnce(join(home, "receipts", `${id}.harness-queued`), {
      id, status: "queued", delivery: "harness-queue", at: utcStamp(),
      from: route?.from ?? envelopeField(raw, "from") ?? "",
      to: route?.to ?? envelopeField(raw, "to") ?? "",
      kind: route?.kind ?? envelopeField(raw, "kind") ?? "", turn: "unconfirmed",
    });
    completeHarnessQueued(home, id);
  } catch (error) { console.error(`tap: harness accepted queued input; receipt unavailable for ${id}: ${error}`); }
}

export function harnessQueueMessage(home: string, id: string, json = false, verb = "tap send"): string {
  const fields = { id, status: "queued", delivery: "harness-queue", turn: "unconfirmed", path: join(home, "payloads", `${id}.md`) };
  return json ? jsonObj(fields) + "\n" : `${verb}: queued in harness ${id}; recipient processing unconfirmed\n`;
}

if (import.meta.main) {
  const [action, home, id, json, verb] = Bun.argv.slice(2);
  if (!home || !id || !validToken(id) || !["record", "complete", "print"].includes(action ?? "")) process.exit(2);
  if (action === "record") recordHarnessQueued(home, id);
  else if (action === "complete") completeHarnessQueued(home, id);
  else process.stdout.write(harnessQueueMessage(home, id, json === "1", verb));
}
