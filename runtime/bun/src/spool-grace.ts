// Grace expiry retains its authorized delivery policy. Only a refused entry
// with no possible-effect evidence, or the stricter zero-Enter transition
// record, can keep a later drain owner.
import { lstatSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { pendingReprobe } from "./submit-phase";
type Meta = Record<string, unknown>;
export function graceCanReprobe(meta: Meta, possible: boolean): boolean {
  return meta.waiter_lifetime === "grace-window" && (meta.policy || "standard") === "standard" && !possible;
}
export function heldSpoolClass(meta: Meta, possible: boolean, pending = false): boolean {
  if (meta.reason_class === "window") return true;
  const lifetime = Object.hasOwn(meta, "waiter_lifetime") ? meta.waiter_lifetime : meta.deadline_source;
  return lifetime === "readiness-gate" || graceCanReprobe(meta, possible) || pending;
}
// The native waiter imports heldSpoolClass; the `held` CLI remains a test control. The `reprobe`
// decision runs in-process inside the drain's deadline transaction
// (spool-deadline.ts `disposeAtDeadline`) and has no adapter any more.
if (import.meta.main) {
  try {
    const [mode, path, attempted] = Bun.argv.slice(2);
    if (!path || !attempted) throw new Error("metadata and attempt path required");
    const meta = JSON.parse(readFileSync(path, "utf8"));
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error("invalid metadata");
    let possible = true;
    try { lstatSync(attempted); } catch (error: any) { if (error.code === "ENOENT") possible = false; }
    if (mode !== "held") throw new Error("invalid grace decision");
    const home = dirname(dirname(path));
    const id = typeof meta.id === "string" ? meta.id : "";
    console.log(heldSpoolClass(meta, possible, id ? pendingReprobe(home, id) : false) ? "yes" : "no");
  } catch (error) { console.error(String(error)); process.exit(2); }
}
