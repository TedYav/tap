import type { Bus } from "./bus";
import { atomicWrite, jsonObj } from "./fsatomic";
import { utcStamp } from "./ids";
import { markResetGenerationReused } from "./reset";

/** The one `.cancelled` receipt writer (tap-4lrwv): cancel, send's
 * departed-sender record and dead-letter disposal share the exact shape, so
 * the receipt has one owner and its provenance never claims the recipient
 * settled — via is always "cancelled", whatever the caller. The bus's reset
 * generation is marked reused under the caller's custody. */
export function writeCancelledReceipt(bus: Bus, fields: {
  id: string; by: string; reason: string; target: string;
  target_status: string; registry_checked: string; source: string;
}): void {
  atomicWrite(bus.cancelPath(fields.id), jsonObj({
    id: fields.id, status: "cancelled", at: utcStamp(), by: fields.by, via: "cancelled",
    reason: fields.reason, target: fields.target, target_status: fields.target_status,
    registry_checked: fields.registry_checked, source: fields.source,
  }) + "\n");
  markResetGenerationReused(bus.home, "cancel");
}
