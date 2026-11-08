// From its own process: are the registry lock and reset custody free right now?
// Each is tried once with no wait and released at once. Prints {"registry":bool,"reset":bool}.
import { join } from "node:path";
import { acquirePathLock, acquireRegistryLock } from "../../src/panelock";

const [registry = "", busHome = ""] = Bun.argv.slice(2);
const held = acquireRegistryLock(registry, 0);
held?.release();
const reset = acquirePathLock(join(busHome, "reset.fence.json.lock"), 0, process.env, "exclusive");
reset?.release();
console.log(JSON.stringify({ registry: held !== null, reset: reset !== null }));
