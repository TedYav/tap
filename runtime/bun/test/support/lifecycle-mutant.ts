// Child-only mutants: no module state or mock escapes into another test file.
import { mock } from "bun:test";
import { lifecycleDisposition } from "../../src/lifecycle-target";
if (process.env.LIFECYCLE_MUTANT === "crew-effect-none") {
  const disposition = lifecycleDisposition("crew", "out");
  if (disposition.ok) Object.assign(disposition.row, { crews: "none" });
}
if (process.env.LIFECYCLE_MUTANT === "hard-effect-none") {
  const disposition = lifecycleDisposition("seat", "shutdown");
  if (disposition.ok) Object.assign(disposition.row, { tmux: "none" });
}
if (process.env.LIFECYCLE_MUTANT === "codec-failure") {
  const codec = await import("../../src/lossless-json");
  mock.module("../../src/lossless-json", () => ({ ...codec,
    pyDumpIndent() { throw new Error("retirement codec mutant"); },
  }));
}
const { route, NATIVE_HANDLERS } = await import("../../main");
process.exitCode = await route(process.argv.slice(2), NATIVE_HANDLERS, () => { throw new Error("unexpected Bash fallback"); });
