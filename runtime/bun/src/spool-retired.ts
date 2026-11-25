// Retire only spool custody proven older than a replacement registry row.
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { Bus } from "./bus";
import { envelopeField, stampEnvelope, validateEnvelope } from "./envelope";
import { atomicWrite } from "./fsatomic";
import { validId } from "./ids";
import { acquireObligationLock, acquirePathLock, acquireRegistryLock } from "./panelock";
import { loadRegistry, seatMap, type RegistryDoc } from "./registry";
import { teamRegistryRefusal } from "./register-authority";
import { forwardings } from "./forwarding";
import { submitNotice } from "./notice-submit";
import { AGENT_FAMILIES } from "./harness-families";
import { isFile } from "./watch-lease";
import { tapScriptsDir } from "./scripts-dir";

type Meta = Record<string, unknown>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const samePath = (a: string, b: string) => { try { return realpathSync(a) === realpathSync(b); } catch { return false; } };
function epoch(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return null;
  const n = Date.parse(value);
  return Number.isFinite(n) && new Date(n).toISOString().replace(".000Z", "Z") === value ? n / 1000 : null;
}

export function recipientRetired(meta: Meta, raw: string, registry: RegistryDoc, localRegistry: string, now = Date.now() / 1000): boolean {
  // An old-format registry is never withdrawal authority: the entry stays for ordinary delivery.
  if (teamRegistryRefusal(String(meta.target_registry ?? ""), registry)) return false;
  if (!validateEnvelope(raw).ok || !object(registry.team)) return false;
  const id = envelopeField(raw, "id"), target = envelopeField(raw, "to");
  if (id !== meta.id || target !== meta.target || typeof meta.target_registry !== "string") return false;
  const team = registry.team.name;
  if (typeof team !== "string" || !team) return false;
  const envelopeTeam = envelopeField(raw, "to_team");
  if (envelopeTeam && envelopeTeam !== team) return false;
  if (meta.to_team ? meta.to_team !== team : !envelopeTeam && !samePath(meta.target_registry, localRegistry)) return false;
  const row = seatMap(registry)[target!];
  if (!object(row) || typeof row.instance !== "string" || !row.instance) return false;
  const bound = envelopeField(raw, "recipient_instance") || "";
  // Forwarded mail retains the predecessor stamp/clock; neither dates the
  // successor incarnation, so chronology alone cannot prove its replacement.
  // Re-registration refreshes registered_at without replacing the instance.
  // Unstamped mail therefore has no evidence of an incarnation mismatch.
  if (!bound || bound === row.instance || envelopeField(raw, "to_adopted_from")) return false;
  try {
    // Every delegated route starts with an edge for this exact incarnation.
    // The edge protects the spool even if its successor cannot be resolved.
    if (forwardings(registry).some(edge =>
      edge.source === target && edge.source_instance === bound && edge.custody_revoked !== true)) return false;
  } catch {
    // An unreadable edge set cannot establish that this instance has no grant.
    return false;
  }
  // An explicit adoption grant is still a settlement route for predecessor mail.
  if (Object.values(seatMap(registry)).some(seat => object(seat) && Array.isArray(seat.adopted_handles) && seat.adopted_handles.includes(target) &&
      (!bound || (object(seat.adopted_instances) && seat.adopted_instances[target!] === bound)))) return false;
  const first = epoch(meta.first_spooled_epoch), registered = epoch(row.registered_at);
  return first !== null && registered !== null && first < registered && registered <= now;
}

function readEntry(home: string, id: string) {
  if (!validId(id)) throw new Error("invalid spool id");
  for (const suffix of [".md", ".meta.json"]) {
    if (!lstatSync(join(home, "spool", id + suffix)).isFile()) throw new Error("non-regular spool custody");
  }
  const meta = JSON.parse(readFileSync(join(home, "spool", `${id}.meta.json`), "utf8"));
  if (!object(meta) || meta.id !== id) throw new Error("invalid spool metadata");
  const raw = readFileSync(join(home, "spool", `${id}.md`), "utf8");
  if (!validateEnvelope(raw).ok || envelopeField(raw, "id") !== id) throw new Error("invalid spool envelope");
  return { meta, raw };
}
function retiredReceipt(home: string, id: string): boolean {
  try {
    const receipt = JSON.parse(readFileSync(join(home, "receipts", `${id}.cancelled`), "utf8"));
    return receipt.id === id && receipt.by === "courier" && receipt.reason === "instance_retired" && receipt.source === "spool";
  } catch { return false; }
}
function deliveredOrSettled(home: string, id: string): boolean {
  return ["done", "sent", "harness-queued"].some(ext => isFile(join(home, "receipts", `${id}.${ext}`)));
}
export function retirementCandidates(home: string, localRegistry: string, target = "", registry = ""): string[] {
  const ids: string[] = [];
  for (const name of readdirSync(join(home, "spool"))) {
    if (!name.endsWith(".meta.json")) continue;
    const id = name.slice(0, -10);
    try {
      const { meta, raw } = readEntry(home, id);
      if (target && (meta.target !== target || typeof meta.target_registry !== "string" || !samePath(meta.target_registry, registry))) continue;
      if (retiredReceipt(home, id)) { ids.push(id); continue; }
      if (deliveredOrSettled(home, id) || isFile(join(home, "receipts", `${id}.cancelled`))) continue;
      if (typeof meta.target_registry === "string" && recipientRetired(meta, raw, loadRegistry(meta.target_registry), localRegistry)) ids.push(id);
    } catch { /* Incomplete evidence is not withdrawal authority. */ }
  }
  return ids.sort();
}

function retainCanonical(home: string, id: string): void {
  const canonical = join(home, "payloads", `${id}.md`);
  mkdirSync(join(home, "payloads"), { recursive: true });
  try { linkSync(join(home, "spool", `${id}.md`), canonical); }
  catch (error: any) { if (error.code !== "EEXIST") throw error; }
  if (!lstatSync(canonical).isFile() || !readFileSync(canonical).equals(readFileSync(join(home, "spool", `${id}.md`)))) throw new Error("canonical conflict; spool retained");
}

/** A notice id whose payload name would pass the 255-byte filename limit. */
export function noticeNameTooLong(noticeId: string): boolean {
  return Buffer.byteLength(`${noticeId}.md`) > 255;
}
/** The bounded deterministic fallback for an over-long notice id: the label and a hash of the parked payload bytes. */
export function hashedNoticeId(label: string, raw: string): string {
  return `${label}-${createHash("sha256").update(raw).digest("hex")}`;
}

/** The two identities publishNotice can choose for `id`'s notice. A caller about to
 *  take reset custody locks both obligations first: a reset holder never waits on an
 *  obligation lock (tap-12ys6). */
export function retirementNoticeIds(home: string, id: string): string[] {
  const legacyId = `${id}-recipient-retired`;
  const fallbackId = hashedNoticeId("recipient-retired", readEntry(home, id).raw);
  return noticeNameTooLong(legacyId) ? [fallbackId] : [legacyId, fallbackId];
}

function publishNotice(home: string, id: string, raw: string, localRegistry: string, wakes?: (() => void)[], heldNotices?: ReadonlySet<string>): void {
  const sender = envelopeField(raw, "from")!;
  if (sender === "courier" || envelopeField(raw, "kind") === "delivery-failed") return;
  const legacyId = `${id}-recipient-retired`;
  const senderInstance = envelopeField(raw, "sender_instance") || "";
  // A bare-handle notice would become mail for a replacement sender at poll time.
  if (!senderInstance) return;
  const body = `Recipient instance retired: ${id}. Automatic delivery to the replacement instance was withdrawn.\n\n` +
    `The original payload is retained at ${join(home, "payloads", `${id}.md`)}.\n` +
    `This withdrawal does not establish whether an earlier attempt reached the retired instance. Inspect tap show ${id} before re-sending.\n`;
  const noticeFor = (noticeId: string) => stampEnvelope(`---\n---\n${body}`, { id: noticeId, from: "courier", to: sender,
    kind: "delivery-failed", reply: "settle-only", path: join(home, "payloads", `${noticeId}.md`), recipient_instance: senderInstance });
  const matches = (path: string, notice: string) => {
    try { return lstatSync(path).isFile() && readFileSync(path).equals(Buffer.from(notice)); }
    catch { return false; }
  };
  const receiptPath = join(home, "receipts", `${id}.cancelled`);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  const fallbackId = hashedNoticeId("recipient-retired", raw);
  let noticeId = receipt.notice_id;
  if (noticeId === undefined) {
    // An impossible legacy payload name cannot have prior publication evidence.
    // Choose before lstat: it throws ENAMETOOLONG rather than reporting absence.
    if (noticeNameTooLong(legacyId)) noticeId = fallbackId;
    else {
      const legacyPath = join(home, "payloads", `${legacyId}.md`);
      let occupied = false;
      try { lstatSync(legacyPath); occupied = true; }
      catch (error: any) { if (error.code !== "ENOENT") throw error; }
      // Existing possible-delivery evidence pins the old identity even if its
      // payload was removed or replaced; changing IDs could wake the sender twice.
      noticeId = occupied && !matches(legacyPath, noticeFor(legacyId)) &&
        !existsSync(join(home, "payloads", `${legacyId}.attempts`)) && !deliveredOrSettled(home, legacyId)
        ? fallbackId : legacyId;
    }
    // Persist the choice before publication. A retry must not switch back when
    // the unrelated conflict disappears or bypass this notice's attempt ledger.
    atomicWrite(receiptPath, JSON.stringify({ ...receipt, notice_id: noticeId }) + "\n");
  }
  if (noticeId !== legacyId && noticeId !== fallbackId) throw new Error("invalid retirement notice identity; spool retained");
  const path = join(home, "payloads", `${noticeId}.md`), notice = noticeFor(noticeId);
  if (heldNotices && !heldNotices.has(noticeId)) throw new Error("retirement notice lock not held; spool retained");
  const noticeLock = heldNotices ? null : acquireObligationLock(noticeId, 1000);
  if (!heldNotices && !noticeLock) throw new Error("retirement notice busy; spool retained");
  const temp = join(home, "payloads", `.retired-notice.${randomUUID()}`);
  try {
    // Publish complete bytes without replacing a concurrent creator's path.
    atomicWrite(temp, notice);
    try { linkSync(temp, path); }
    catch (error: any) { if (error.code !== "EEXIST") throw error; }
    if (!matches(path, notice)) throw new Error("retirement notice conflict; spool retained");
  } finally { noticeLock?.release(); rmSync(temp, { force: true }); }
  // A reused sender handle is not the old sender. Retain the addressed notice
  // without a pane wake unless its stamped instance is still current.
  let row;
  try {
    const doc = loadRegistry(localRegistry);
    // An old-format sender registry binds no pane: the addressed notice stays poll-visible.
    if (teamRegistryRefusal(localRegistry, doc)) return;
    row = seatMap(doc)[sender];
  } catch { return; }
  if (!senderInstance || !row || row.instance !== senderInstance || row.status !== "active" || row.delivery === "poll" ||
      typeof row.pane !== "string" || typeof row.pane_id !== "string") return;
  const pane = row.pane, paneId = row.pane_id;
  const wake = () => { submitNotice({ bus: new Bus(home), id: noticeId, pane,
    bound: { handle: sender, instance: senderInstance, paneId, harness: String(row.harness || ""),
      bootId: String(row.boot_id || ""), serverEpoch: String(row.server_epoch || "") },
    authority: { registryPath: localRegistry, recipient: sender, busHome: home, agentFamilies: AGENT_FAMILIES,
      scriptsDir: tapScriptsDir() } }); };
  if (wakes) wakes.push(wake); else wake();
}

/** Caller holds the existing obligation lock and no-steal spool claim. A caller
 *  holding reset custody passes `wakes` and runs the notice's pane wake after
 *  releasing it; custody never spans pane I/O. It also passes `heldNotices`, the
 *  `retirementNoticeIds` whose obligation locks it took before custody. */
export function withdrawRetired(home: string, id: string, localRegistry: string, wakes?: (() => void)[], heldNotices?: ReadonlySet<string>): boolean {
  let { meta, raw } = readEntry(home, id);
  if (!retiredReceipt(home, id)) {
    if (deliveredOrSettled(home, id) || isFile(join(home, "receipts", `${id}.cancelled`))) return false;
    if (typeof meta.target_registry !== "string" || !meta.target_registry) return false;
    const registryLock = acquireRegistryLock(meta.target_registry, 1000);
    if (!registryLock) throw new Error("recipient registry busy; spool retained");
    try {
      const metaLock = acquirePathLock(join(home, "spool", `${id}.meta.json.lock`), 1000);
      if (!metaLock) throw new Error("spool metadata busy; retained");
      try {
        ({ meta, raw } = readEntry(home, id));
        if (meta.target_registry !== registryLock.registryLocation ||
            !recipientRetired(meta, raw, loadRegistry(registryLock.registryLocation), localRegistry)) return false;
        retainCanonical(home, id);
        atomicWrite(join(home, "receipts", `${id}.cancelled`), JSON.stringify({ id, status: "cancelled", at: new Date().toISOString(),
          by: "courier", via: "cancelled", reason: "instance_retired", target: meta.target, target_status: "replaced",
          registry_checked: meta.target_registry, source: "spool" }) + "\n");
      } finally { metaLock.release(); }
    } finally { registryLock.release(); }
  } else { retainCanonical(home, id); }
  publishNotice(home, id, raw, localRegistry, wakes, heldNotices);
  return true;
}

if (import.meta.main) {
  try {
    const [mode, home, localRegistry, arg = "", registry = ""] = Bun.argv.slice(2);
    if (!home || !localRegistry) throw new Error("spool home and local registry required");
    if (mode === "candidates") console.log(["ok", ...retirementCandidates(home, localRegistry, arg, registry)].join("\n"));
    else if (mode === "withdraw") console.log(withdrawRetired(home, arg, localRegistry) ? "withdrawn" : "keep");
    else throw new Error("unknown retirement operation");
  } catch (error) { console.error(String(error)); process.exit(2); }
}
