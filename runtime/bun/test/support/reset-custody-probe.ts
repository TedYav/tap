// A concurrent mutation in its own process (tap-12ys6): after <delay-ms>, take reset
// custody as `tap send` does, waiting up to <wait-ms>, then release it at once.
// Prints {"acquired":bool,"elapsedMs":n}.
import { acquireResetMutationLock } from "../../src/reset";

const [home = "", delayMs = "0", waitMs = "1000"] = Bun.argv.slice(2);
await Bun.sleep(Number(delayMs));
const started = Date.now();
let acquired = false;
try { acquireResetMutationLock(home, "test send", Number(waitMs), "shared").release(); acquired = true; }
catch { /* reset_custody_busy or fenced: not acquired */ }
console.log(JSON.stringify({ acquired, elapsedMs: Date.now() - started }));
