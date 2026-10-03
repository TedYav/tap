// One EX custody holder for waiter-side tests: takes reset custody exactly as
// `tap teardown` does (default exclusive — which also writes the holder note),
// prints "held", parks until the release file appears, then releases.
import { existsSync } from "node:fs";
import { acquireResetMutationLock } from "../../src/reset";

const [home = "", release = "", operation = "tap teardown"] = Bun.argv.slice(2);
const lock = acquireResetMutationLock(home, operation);
console.log("held");
const deadline = Date.now() + 30_000;
while (!existsSync(release) && Date.now() < deadline) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
}
lock.release();
