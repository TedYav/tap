// A team reset in its own process, so a test can hold it at a scratch copy
// barrier while a real drain runs. Stop effects are stubbed as in
// team-reset.test.ts; the drain fixture has one observable recipient session.
import { join } from "node:path";
import { Bus } from "../../src/bus";
import type { ResolvedContext } from "../../src/context";
import { parseResetOptions, runReset } from "../../src/team/reset";
import type { StopEffects } from "../../src/team/stop";

const root = process.env.RESET_CHILD_ROOT;
if (!root || !process.env.TAP_SCRATCH_ONLY) throw new Error("team-reset-child needs RESET_CHILD_ROOT and TAP_SCRATCH_ONLY");
const bus = new Bus(join(root, ".tap", "bus"));
const ctx: ResolvedContext = { bus, root, registryPath: join(root, ".tap", "team-registry.json"), team: "fixture", marker: "live", busRule: "env" };
let alive = true;
const present = (session: string) => alive && session === "fixture";
const effects: StopEffects = {
  tmux: { hasSession: present, paneSession: pane => alive && pane === "%401" ? "fixture" : null,
    sessionPaneIds: session => present(session) ? ["%401"] : [] },
  killSession: session => { if (!present(session)) throw new Error("unexpected kill"); alive = false; return true; },
  hasSession: present, paneCount: session => present(session) ? 1 : 0,
  observeSpare: () => null, queueSummary: () => ({ unsettled: 0, counts: new Map() }),
  watch: { isArmed: () => false, clearTints: () => {}, disarm: () => {} },
  identity: { tmuxActive: false, callingPaneId: "", selfRefusal: "", resolveSelf: () => null, displaySession: () => "" },
  runId: "test", eventLog: join(bus.home, "registry-events.log"), io: { stdout: () => {}, stderr: () => {}, warn: () => {} },
};
process.exitCode = runReset(ctx, parseResetOptions(["--json"]), effects);
