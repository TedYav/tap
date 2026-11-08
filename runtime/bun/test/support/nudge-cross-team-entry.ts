// Entry for nudge-cross-team-fences.test.ts: one cmdNudge call from the Sender team's root.
import { cmdNudge, nudgePinnedSeat } from "../../src/verbs/nudge";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
try {
  const args = ["Target/peer"], scripts = resolve(import.meta.dir, "../../../../skills/tap/scripts"), families = new Set(["codex"]);
  process.exitCode = process.env.REVIEW_SELECTION && process.env.REVIEW_SELECTION !== "none"
    ? nudgePinnedSeat(args, scripts, families, "", undefined, () => process.env.REVIEW_SELECTION === "recovered" || existsSync(process.env.FAKE_ROOT + "/copy-done") ? "seat recovered; not nudged" : "")
    : process.env.REVIEW_NUDGE_GUARD === "1"
    ? nudgePinnedSeat(args, scripts, families, "", { check: () => process.env.TAP_RECOVERY_RUN ? "diagnosis changed before Enter" : "" })
    : cmdNudge(args, scripts, families);
}
catch (error) { console.error(String(error)); process.exitCode = (error as { code?: number }).code ?? 1; }
