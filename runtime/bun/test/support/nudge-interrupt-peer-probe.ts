// Standalone probe for nudge-interrupt-peer.test.ts: runs the PUBLIC
// single-peer interrupt form (cmdNudge) against the fixture env, printing
// `rc=<n>` on success or `taperror=<class> detail=<d>` on a TapError.
import { cmdNudge } from "../../src/verbs/nudge";

const e = process.env;
try {
  const rc = cmdNudge(JSON.parse(e.PEER_ARGV ?? "[]") as string[], e.SCRIPTS_DIR!, new Set(["opencode", "claude"]));
  console.log(`rc=${rc}`);
} catch (error) {
  const err = error as { errorClass?: string; detail?: string; action?: string };
  if (typeof err.errorClass !== "string") throw error;
  console.log(`taperror=${err.errorClass} detail=${err.detail ?? ""}`);
}
