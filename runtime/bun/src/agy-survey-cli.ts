// Thin compatibility boundary: the Bash caller already owns the submit lock.
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { recoverSurveyLocked, REAL_EFFECTS } from "./courier";
import { loadRegistry, seatMap } from "./registry";
import { teamRegistryFileRefusal } from "./register-authority";
import { envelopeField } from "./envelope";
import { AGENT_FAMILIES } from "./harness-families";

export function surveyCli(args: string[]): string {
  const [pane, registry, handle, paneId, home, id] = args;
  if (!pane || !registry || !handle || !paneId || !home || !id) return "blocked";
  const oldStore = teamRegistryFileRefusal(registry);
  if (oldStore) { console.error(`tap: ${oldStore.errorClass}: ${oldStore.detail}; next: ${oldStore.action}`); return "blocked"; }
  const row = seatMap(loadRegistry(registry))[handle];
  if (!row || row.harness !== "agy" || row.pane_id !== paneId) return "blocked";
  // A known bound payload must still address this incarnation. Absence is
  // allowed for row-bound control callers, which have no canonical message.
  try {
    const raw = readFileSync(resolve(home, "payloads", `${id}.md`), "utf8");
    const expected = envelopeField(raw, "recipient_instance");
    if (expected && expected !== row.instance) return "blocked";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const attemptIds = (process.env.TAP_DELIVERY_ATTEMPT_IDS ?? "").split(/\s+/).filter(Boolean);
  const result = recoverSurveyLocked(pane, {
    paneId, handle, harness: "agy", instance: String(row.instance ?? ""),
    serverEpoch: String(row.server_epoch ?? ""), bootId: String(row.boot_id ?? ""),
  }, { registryPath: registry, recipient: handle, busHome: home,
    attemptAdmitted: process.env.TAP_DELIVERY_NEW_ATTEMPT === id,
    attemptIds: attemptIds.length ? attemptIds : undefined,
    scriptsDir: resolve(import.meta.dir, "../../../skills/tap/scripts"), agentFamilies: AGENT_FAMILIES }, REAL_EFFECTS, id);
  if (result.status === "blocked" || result.status === "attempt_evidence_unwritable") console.error(`tap: ${result.detail}`);
  return result.status;
}
if (import.meta.main) {
  try { console.log(surveyCli(process.argv.slice(2))); }
  catch (error) { console.error(`tap survey: ${error}`); console.log("blocked"); }
}
