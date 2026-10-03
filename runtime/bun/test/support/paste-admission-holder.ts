import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireResetMutationLock } from "../../src/reset";

const home = process.argv[2]!;
const held = acquireResetMutationLock(home, "paste admission test holder");
try {
  writeFileSync(join(home, "holder-ready"), "");
  const deadline = Date.now() + 5000;
  while (!existsSync(join(home, "admission-start"))) {
    if (Date.now() > deadline) throw new Error("admission did not start");
    Bun.sleepSync(5);
  }
  writeFileSync(join(home, "replacement"), "");
} finally { held.release(); }
