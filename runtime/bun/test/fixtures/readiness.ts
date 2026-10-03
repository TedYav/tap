// Shell smoke fixtures use the same in-process reader as the native drain.
import { readPaneReady } from "../../src/spool-readiness";

const [router, home, pane, paneId, handle, toTeam, targetRegistry, policy = ""] = process.argv.slice(2);
if ([router, home, pane, paneId, handle, toTeam, targetRegistry].some(value => value === undefined)) process.exit(2);
process.stdout.write(readPaneReady({ pane: pane!, paneId: paneId!, handle: handle!, toTeam: toTeam!, targetRegistry: targetRegistry!, policy }, home!, process.env, router === "0"));
