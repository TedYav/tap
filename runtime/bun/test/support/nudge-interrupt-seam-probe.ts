// Standalone probe for nudge-interrupt-seam.test.ts: driven through spawnSync
// so the courier's PATH-tmux door and its child effects are observable from a
// clean process. Prints `status=<SubmitResult status> [detail=...]`.
import { submitVerifyLocked } from "../../src/courier";
import { DARK_EFFECTS } from "../../src/deliver";

const e = process.env;
const result = submitVerifyLocked("fixture", e.PID!, e.WIRE!, { paneId: "%1", harness: "opencode", handle: "rb", serverEpoch: "srv:4242:100" }, DARK_EFFECTS, {
  scriptsDir: e.SCRIPTS_DIR!, agentFamilies: new Set(["opencode"]), busHome: e.TAP_HOME, recipient: "rb",
  registryPath: e.TAP_HOME + "/registry.json",
  deliveryFacts: { harness: "opencode", urgent: e.U === "1", noSpool: false, recipientBound: true, recoveryInterrupt: e.R === "1" },
});
console.log("status=" + result.status + ("detail" in result && result.detail ? " detail=" + result.detail : ""));
