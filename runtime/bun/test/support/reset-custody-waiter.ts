// Waiter-side probe (tap-7t3ag): acquire SHARED reset custody with the
// interactive auto-wait, recording each progress line to <lines-file>. Prints
// {"acquired":bool,"errorClass":string,"action":string} — the refusal fields
// are empty when the custody was obtained.
import { appendFileSync } from "node:fs";
import { acquireResetMutationLockAsync } from "../../src/reset";
import { TapError } from "../../src/context";

const [home = "", maxWaitMs = "10000", linesFile = ""] = Bun.argv.slice(2);
try {
  const lock = await acquireResetMutationLockAsync(home, "tap send", undefined, "shared", {
    maxWaitMs: Number(maxWaitMs),
    onWait: line => { if (linesFile) appendFileSync(linesFile, `${line}\n`); },
  });
  lock.release();
  console.log(JSON.stringify({ acquired: true, errorClass: "", action: "" }));
} catch (error) {
  const tap = error instanceof TapError ? error : null;
  console.log(JSON.stringify({ acquired: false, errorClass: tap?.errorClass ?? "unknown", action: tap?.action ?? String(error) }));
}
