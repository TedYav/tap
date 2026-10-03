// Child-process writer for the lock-contention tests: `<config> <seat> <window> <include-asks 0|1>`
// drives `updateConfig` as one setter process, the in-process owner `tap digest-window`
// and `tap config` both call. Refusals print their message on stderr and exit 1.
import { updateConfig, windowSeconds } from "../../src/digest-window";

const [config = "", seat = "", window = "", includeAsks = "0"] = process.argv.slice(2);
try {
  updateConfig(config, seat, windowSeconds(window), includeAsks === "1");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
