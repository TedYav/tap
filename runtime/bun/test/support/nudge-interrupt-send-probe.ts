// Standalone probe for nudge-interrupt-seam.test.ts's send-door cases: runs
// the full cmdSendOutcome path (placement, permissions, spool, registry
// events) against the PATH-tmux door, with or without the internal
// recoveryInterrupt option. Prints `rc=<n> disposition=<d>`.
import { cmdSendOutcome } from "../../src/verbs/send";

const e = process.env;
const outcome = cmdSendOutcome(
  ["rb", "-m", "hi", "--urgent", "--id", e.PID!],
  e.SCRIPTS_DIR!,
  new Set(["opencode", "claude"]),
  e.R === "1" ? { recoveryInterrupt: true } : undefined,
);
console.log(`rc=${outcome.rc} disposition=${outcome.disposition} interrupt=${outcome.interrupt ? outcome.interrupt.method : "none"}`);
