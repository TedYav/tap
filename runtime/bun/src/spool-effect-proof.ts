// The no-effect proof: the positive evidence that no delivery attempt for a spool
// entry can have reached a pane. `tap nudge` requeue and the restart re-bind
// (spool-rebind.ts) both re-hand an entry to the courier only on this proof, so
// a possible effect is never retried. A leaf module on purpose: the spool
// waiter's stamped import closure reaches it through the drain.
import { lstatSync } from "node:fs";
import { join } from "node:path";

import { PyFloat, PyInt } from "./spool-publication";

/** Evidence of a recipient attempt, a delivery, a read, a settlement or a consumed resend. Presence alone refuses. */
const RECEIPT_EVIDENCE = ["attempted", "attempts", "idle-submit", "unconfirmed", "sent", "read", "harness-queued", "done", "cancelled", "resent"];

/** Zero attempts behind a modern pre-attempt fence, and no evidence file anywhere the bus keeps one.
 *  "" is the proof; anything else names the leg that refused. Shared with the restart re-bind. */
export function noEffectProof(home: string, spoolDir: string, id: string, meta: Record<string, unknown>): string {
  const count = meta.attempts;
  if (!((typeof count === "number" && Number.isInteger(count)) || count instanceof PyInt)) return "attempt count is missing or malformed";
  if (count !== 0) return "the entry records a delivery attempt";
  const fence = meta.attempt_fence;
  if (!(fence === 1 || fence === true || (fence instanceof PyFloat && fence.value === 1))) return "no pre-attempt fence; no effect cannot be proved";
  const native = presence(join(spoolDir, `${id}.json`));
  if (native === "unknown") return "native intent presence is unreadable";
  if (native === "present") return "a native intent owns its own delivery evidence";
  for (const dir of [join(home, "receipts"), join(home, "payloads"), spoolDir, join(home, "archive")]) {
    for (const suffix of RECEIPT_EVIDENCE) {
      const seen = presence(join(dir, `${id}.${suffix}`));
      if (seen === "unknown") return `.${suffix} evidence is unreadable`;
      if (seen === "present") return `.${suffix} evidence exists`;
    }
  }
  return "";
}

/** ENOENT alone proves absence; any other stat failure is unknown and holds. A dangling link is present. */
function presence(path: string): "present" | "absent" | "unknown" {
  try { lstatSync(path); return "present"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown"; }
}
