import { join } from "node:path";
import { validId } from "../ids";
import { isFile } from "../watch-lease";

// The caller holds the obligation lock until the pane attempt is disposed.
// Earlier transport evidence survives settlement; skipping this attempt does
// not claim that an already injected or harness-queued sentinel was withdrawn.
export function redeliveryEligibility(home: string, id: string): string {
  const has = (suffix: string) => isFile(join(home, "receipts", `${id}.${suffix}`));
  const terminal = has("done") ? "settled" : has("cancelled") ? "cancelled" : "";
  if (!terminal) return "eligible";
  const attempted = ["attempted", "sent", "harness-queued"].some(has);
  return `${terminal}-${attempted ? "after-delivery-attempt" : "before-delivery"}`;
}

if (import.meta.main) {
  const [home, id] = Bun.argv.slice(2);
  if (!home || !id || !validId(id)) process.exit(2);
  console.log(redeliveryEligibility(home, id));
}
