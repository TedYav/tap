// Age ends parked custody, never grants a delivery attempt. Both the ordinary
// drain and detached bus maintenance enter this transaction before delivery.
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { Bus } from "./bus";
import { archivedMonth } from "./bus-archive-index";
import { envelopeField, validateEnvelope } from "./envelope";
import { appendRegistryEventOrWarn } from "./events";
import { lockNameFits } from "./fsatomic";
import { COURIER_IDENTITY, WATCH_IDENTITY, validId } from "./ids";
import { KIND_DELIVERY_FAILED, hasRecipientRead } from "./notice";
import { acquireObligationLock, acquirePathLock } from "./panelock";
import { withResetCustody, markResetGenerationReused } from "./reset";
import { notifySenderOnEscalate, registryPresence, writeDeliveryFailedReceipt, type DeadlineContext } from "./spool-deadline";
import { hashedNoticeId, noticeNameTooLong } from "./spool-retired";
import { claimAcquire, claimRelease, metaPath, payloadPath } from "./spool-sidecar";

export const PARK_RETENTION_SECONDS = 72 * 60 * 60;
export const MAX_PARK_NOTICES_PER_PASS = 8;
export interface ParkNoticeBudget { remaining: number }
export type ParkCleanup = "current" | "settled" | "expired" | "busy" | "held";

function ordinary(path: string): boolean {
  try { return lstatSync(path).isFile(); } catch (error: any) { if (error.code === "ENOENT") return false; throw error; }
}
function realDirectory(path: string): void {
  try { if (!lstatSync(path).isDirectory()) throw new Error(`unsafe directory: ${path}`); }
  catch (error: any) { if (error.code !== "ENOENT") throw error; mkdirSync(path); }
}
function optionalBytes(path: string): Buffer | undefined {
  try {
    if (!lstatSync(path).isFile()) throw new Error(`not an ordinary file: ${path}`);
    return readFileSync(path);
  } catch (error: any) { if (error.code === "ENOENT") return undefined; throw error; }
}
function inspect(ctx: DeadlineContext, id: string) {
  for (const directory of [ctx.home,ctx.spoolDir,join(ctx.home,"payloads"),join(ctx.home,"receipts")]) {
    if (!lstatSync(directory).isDirectory()) throw new Error(`unsafe active directory: ${directory}`);
  }
  for (const suffix of ["done","cancelled","read","sent"]) optionalBytes(join(ctx.home,"receipts",`${id}.${suffix}`));
  const path = payloadPath(ctx.spoolDir, id), st = lstatSync(path);
  if (!st.isFile()) throw new Error("parked body is not an ordinary file");
  const bytes = readFileSync(path), raw = bytes.toString("utf8");
  if (!validateEnvelope(raw).ok || envelopeField(raw, "id") !== id) throw new Error("parked envelope is malformed");
  const metadata = optionalBytes(metaPath(ctx.spoolDir, id));
  let meta: Record<string, unknown> = {};
  try { const parsed = JSON.parse(metadata?.toString("utf8") ?? "null"); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed; } catch { /* preserve malformed metadata as evidence */ }
  const first = typeof meta.first_spooled_epoch === "number" || typeof meta.first_spooled_epoch === "string" ? Number(meta.first_spooled_epoch) : NaN;
  // Incomplete/legacy metadata has no usable park clock. Body mtime is stable
  // across readiness probes; metadata mtime is not.
  const epoch = meta.id === id && Number.isFinite(first) && first > 0 && first <= ctx.now ? first : st.mtimeMs / 1000;
  const bus = new Bus(ctx.home), settled = bus.isDone(id);
  return { path, bytes, raw, metadata, meta, settled, expired: ctx.now >= epoch + PARK_RETENTION_SECONDS,
    target: envelopeField(raw, "to") ?? "", sender: envelopeField(raw, "from") ?? "" };
}

/** Fast eligibility look; errors remain actionable holds, never delivery authority. */
export function parkCleanupDue(ctx: DeadlineContext, id: string): boolean {
  if (!validId(id)) return false;
  try { const row = inspect(ctx, id); return row.settled || row.expired; }
  catch {
    // Old unreadable/malformed evidence needs inspection, not delivery. New
    // partial publication gets the full retention window to finish.
    try { return ctx.now >= lstatSync(payloadPath(ctx.spoolDir,id)).mtimeMs/1000 + PARK_RETENTION_SECONDS; }
    catch { return false; }
  }
}

/** Publish a preserved evidence copy without replacing prior bytes. */
function preserve(source: string, destination: string, bytes: Buffer): void {
  const prior = optionalBytes(destination);
  if (prior) { if (!prior.equals(bytes)) throw new Error(`preserved evidence differs: ${destination}`); flush(destination);flush(dirname(destination));return; }
  if (!readFileSync(source).equals(bytes)) throw new Error("evidence changed before preservation");
  const staging = `${destination}.expiry-${randomUUID()}`;
  const fd = openSync(staging,"wx",0o600);
  try { writeFileSync(fd,bytes);fsyncSync(fd); } finally { closeSync(fd); }
  try {
    try { linkSync(staging,destination); }
    catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      if (!optionalBytes(destination)?.equals(bytes)) throw new Error(`preserved evidence differs: ${destination}`);
    }
    flush(destination);flush(dirname(destination));
  } finally { unlinkSync(staging); }
}

function flush(path: string): void {
  const fd=openSync(path,"r");try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Obligation -> no-steal claim -> reset custody -> metadata lock. No pane effects. */
export function cleanupPark(ctx: DeadlineContext, id: string, budget?: ParkNoticeBudget): ParkCleanup {
  if (!validId(id)) return "held";
  let observed: ReturnType<typeof inspect>;
  try { observed = inspect(ctx, id); } catch { return "held"; }
  if (!observed.settled && !observed.expired) return "current";
  if (existsSync(join(ctx.home,"reset.fence.json"))) return "busy";
  const env = ctx.env ?? process.env, obligation = acquireObligationLock(id, 0, env);
  if (!obligation) return "busy";
  try {
    const claim = claimAcquire(ctx.spoolDir, id, true, env);
    if (claim.status !== "acquired") return "busy";
    try {
      observed = inspect(ctx, id);
      if (!observed.settled && !observed.expired) return "current";
      const canonical = join(ctx.home, "payloads", `${id}.md`), prior = optionalBytes(canonical);
      if (prior && !prior.equals(observed.bytes)) throw new Error("canonical body differs from parked body");
      // A native intent is independent custody; an old .md does not retire it.
      if (existsSync(join(ctx.spoolDir, `${id}.json`))) throw new Error("native intent also owns this id");
      const delivered = ordinary(join(ctx.home, "receipts", `${id}.sent`)) || hasRecipientRead(join(ctx.home, "receipts"), id);
      let notifiable = !observed.settled && !delivered && envelopeField(observed.raw, "kind") !== KIND_DELIVERY_FAILED
        && ![COURIER_IDENTITY, WATCH_IDENTITY].includes(observed.sender) && observed.sender !== observed.target;
      const targetRegistry = typeof observed.meta.target_registry === "string" ? observed.meta.target_registry : "";
      let senderAbsent = false;
      if (notifiable) {
        const presence = registryPresence(ctx, targetRegistry, observed.sender);
        if (presence.state === "unobservable") throw new Error(`sender registry unavailable: ${presence.reason}`);
        senderAbsent = presence.state === "absent";
        notifiable = !senderAbsent;
      }
      if (notifiable) {
        const candidate = `${id}-park-expired`, noticeId = noticeNameTooLong(candidate) ? hashedNoticeId("park-expired", observed.raw) : candidate;
        const known = existsSync(join(ctx.home,"payloads",`${noticeId}.md`)) || existsSync(join(ctx.home,"archive",`${noticeId}.cancelled.md`)) || new Bus(ctx.home).isDone(noticeId)
          || Boolean(archivedMonth(ctx.home, noticeId));  // a notice archived before its park retired
        if (!known && budget && budget.remaining <= 0) return "busy";
        const noticeLock = acquireObligationLock(noticeId, 0, env);
        if (!noticeLock) return "busy";
        try {
          if (!notifySenderOnEscalate(ctx, { id, target: observed.target, targetRegistry,
            outcome: "park-expired", detail: "park retention limit reached", durableId: noticeId, publishOnly: true })) return known ? "held" : "busy";
          if (!known && budget) budget.remaining--;
        } finally { noticeLock.release(); }
      }
      const result = withResetCustody(ctx.home, "park expiry", () => {
        // Mark reuse before file effects, without nesting the generation lock
        // under metadata custody. A refused cleanup conservatively keeps it.
        markResetGenerationReused(ctx.home, "park-expiry");
        const mp = metaPath(ctx.spoolDir, id);
        if (!lockNameFits(`${mp}.lock`)) return "held" as const;
        const metadataLock = acquirePathLock(`${mp}.lock`, 0, env);
        if (!metadataLock) return "busy" as const;
        let audit: { action: string; target: string; pane: string; reason: string } | undefined;
        try {
          const fresh = inspect(ctx, id);
          if (!fresh.settled && !fresh.expired) return "current" as const;
          if (!fresh.bytes.equals(observed.bytes)) throw new Error("parked body changed during expiry");
          for (const directory of [ctx.home, ctx.spoolDir, join(ctx.home, "payloads"), join(ctx.home, "receipts"), join(ctx.home, "archive")]) realDirectory(directory);
          if (fresh.metadata) preserve(mp, join(ctx.home, "archive", `${id}.meta.json`), fresh.metadata);
          preserve(fresh.path, canonical, fresh.bytes);
          // A confirmed delivery/read only retires duplicate parked custody. The
          // recipient's still-open obligation is preserved. Uncertain delivery
          // expires as withdrawal, retaining every possible-effect marker.
          if (!fresh.settled && !delivered && !writeDeliveryFailedReceipt(ctx, id, fresh.target, "park_expired")) return "held" as const;
          if (!fresh.settled && !delivered) { flush(join(ctx.home,"receipts",`${id}.cancelled`));flush(join(ctx.home,"receipts")); }
          unlinkSync(fresh.path);
          for (const sidecar of [mp, `${mp}.reown`]) {
            try { unlinkSync(sidecar); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
          }
          audit = { action: fresh.settled ? "spool_terminal_settled" : delivered ? "spool_terminal_delivered" : "spool_terminal_park_expired",
            target: fresh.target, pane: typeof fresh.meta.pane === "string" ? fresh.meta.pane : "",
            reason: fresh.settled ? "settled" : delivered ? "delivered" : "park_expired" };
          return fresh.settled || delivered ? "settled" as const : "expired" as const;
        } finally {
          metadataLock.release();
          if (audit) appendRegistryEventOrWarn(ctx.verbLabel, { log: ctx.eventLog, actor: COURIER_IDENTITY,
            action: audit.action, handle: audit.target, pane: audit.pane, team: ctx.team,
            detail: `id=${id} reason=${audit.reason} body=preserved effect=unchanged${senderAbsent ? " notice=sender_absent" : ""}`, env });
        }
      }, 0);
      return result.ok ? result.value : "busy";
    } finally { claimRelease(ctx.spoolDir, id, claim.token, env); }
  } catch (error) {
    process.stderr.write(`tap: parked cleanup held id=${id}: ${String(error)}\n`);
    return "held";
  } finally { obligation.release(); }
}

/** Filename identities, never a metadata-supplied id or path. */
export function parkedIds(spool: string): string[] {
  try { return readdirSync(spool).filter(n => n.endsWith(".md") && validId(n.slice(0, -3))).map(n => n.slice(0, -3)); }
  catch (error: any) { if (error.code === "ENOENT") return []; throw error; }
}
