// Test-only entry: race firstObservation directly with distinct bodies — the
// native successor of the deleted primitive race (read-verb.test.sh 15a) and
// the failure-injection discriminator the public 15b race could never be.
// argv: [--fsync-fail] [--barrier <base> --slot <n>] <target-path> <key=value>...
// stdout is exactly one verdict line.
import { existsSync, writeFileSync } from "node:fs";
import { mock } from "bun:test";

const args = process.argv.slice(2);
const fsyncFail = args[0] === "--fsync-fail";
const rest = fsyncFail ? args.slice(1) : args;
let barrier = "", slot = "";
while (rest[0] === "--barrier" || rest[0] === "--slot") {
  const flag = rest.shift();
  const value = rest.shift();
  if (flag === "--barrier") barrier = value ?? "";
  else slot = value ?? "";
}
const [target = "", ...pairs] = rest;
const fields: Record<string, string> = {};
for (const pair of pairs) {
  const at = pair.indexOf("=");
  if (at !== -1) fields[pair.slice(0, at)] = pair.slice(at + 1);
}
if (barrier) {
  // Helper-local start boundary: announce readiness, then hold until the
  // parent releases every racer together — the race starts coherent or not
  // at all, which is the whole point of racing the exclusive create.
  writeFileSync(`${barrier}.${slot}.ready`, "1\n");
  const deadline = Date.now() + 30_000;
  while (!existsSync(`${barrier}.go`)) {
    if (Date.now() >= deadline) { process.stdout.write("error:barrier timed out\n"); process.exit(1); }
    Bun.sleepSync(2);
  }
}
let firstObservation: (path: string, fields: Record<string, string>) => boolean;
if (fsyncFail) {
  // Fault injection lives HERE, not in production: fsync is replaced before
  // read.ts loads, so its named import binds the throwing stub and the owned
  // phase fails before publication, exactly as a real unwritable disk would.
  const real = await import("node:fs");
  mock.module("node:fs", () => ({ ...real, fsyncSync: () => { throw new Error("fsync fault injected"); } }));
  ({ firstObservation } = await import("../../src/verbs/read"));
} else {
  ({ firstObservation } = await import("../../src/verbs/read"));
}
try {
  process.stdout.write(firstObservation(target, fields) ? "created\n" : "loser\n");
} catch (error) {
  process.stdout.write(`error:${(error as Error).message}\n`);
  process.exitCode = 1;
}
