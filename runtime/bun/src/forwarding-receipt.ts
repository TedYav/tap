// Bash retains receipt composition. Explicit custody is revalidated and committed
// here under one registry lock, so a replacement cannot inherit a sampled grant.
import { linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { envelopeField, validateEnvelope } from "./envelope";
import { forwardingGrant } from "./forwarding";
import { atomicWrite } from "./fsatomic";
import { validId, validToken } from "./ids";
import { acquireRegistryLock } from "./panelock";
import { loadRegistry, seatMap } from "./registry";
import { assertSelectionCurrent, selectCaller } from "./selector";

export function forwardingReceipt(mode: string, payload: string, receipt: string, actor: string,
  actorInstance: string, team: string, bytes: string): "created" | "existing" {
  if (!["first", "replace"].includes(mode) || !actorInstance || !validToken(actor)) {
    throw new Error("forwarding_receipt_invalid: expected receipt mode and captured actor instance");
  }
  const selection = selectCaller({ cwd: process.cwd(), explicitTeam: team, env: process.env });
  const lock = acquireRegistryLock(selection.registryLocation);
  if (!lock) throw new Error("registry_lock_busy: recipient registry is busy; no receipt written");
  try {
    assertSelectionCurrent(selection, lock);
    const raw = readFileSync(payload, "utf8");
    const field = (key: string) => envelopeField(raw, key) ?? "";
    const id = field("id"), to = field("to"), instance = field("recipient_instance");
    const fields = JSON.parse(bytes);
    const expected = join(dirname(dirname(payload)), "receipts", `${id}.${mode === "replace" || field("reply") === "settle-only" ? "done" : "read"}`);
    if (!validateEnvelope(raw).ok || !validId(id) || basename(payload) !== `${id}.md` ||
      basename(dirname(payload)) !== "payloads" || resolve(receipt) !== resolve(expected) ||
      !fields || fields.id !== id || fields.by !== actor || (field("to_team") && field("to_team") !== team)) {
      throw new Error("forwarding_receipt_invalid: payload and receipt identity do not agree");
    }
    const doc = loadRegistry(selection.registryLocation);
    const row = seatMap(doc)[actor];
    if (!row || row.instance !== actorInstance) {
      throw new Error("not_addressee: forwarding recipient instance changed; no receipt written");
    }
    const authorized = Boolean(to && instance) && (to !== actor
      ? forwardingGrant(doc, actor, to, instance) === to
      : instance === actorInstance && Boolean(field("to_adopted_from")) && Boolean(field("original_recipient_instance")));
    if (!authorized) throw new Error("not_addressee: forwarding custody changed; no receipt written");
    if (mode === "replace") {
      atomicWrite(receipt, bytes);
      return "created";
    }
    const temp = join(dirname(receipt), `.tap.${process.pid}.${crypto.randomUUID()}`);
    try {
      writeFileSync(temp, bytes, { mode: 0o600 });
      linkSync(temp, receipt);
      return "created";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return "existing";
      throw error;
    } finally { try { unlinkSync(temp); } catch { /* No temporary if creation failed. */ } }
  } finally { lock.release(); }
}

if (import.meta.main) {
  try {
    const [mode, payload, receipt, actor, actorInstance, team] = process.argv.slice(2);
    if (!mode || !payload || !receipt || !actor || !actorInstance || !team) throw new Error("forwarding receipt arguments required");
    console.log(forwardingReceipt(mode, payload, receipt, actor, actorInstance, team, readFileSync(0, "utf8")));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
