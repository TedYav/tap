// Test-only shell bridge to the native authority and identity owners.
import { Bus } from "../../src/bus";
import { spoolTeamName } from "../../src/context";
import { teamRootFromBus } from "../../src/bushome";
import { flipMarkerState, resolveTeamMarkerAware } from "../../src/index-home";
import { bootId, legacyBootId, serverEpochFromRaw, tmuxReadOnly } from "../../src/tmux";
import { harnessFamily, classifyHarness, DEFAULT_AGENT_FAMILIES } from "../../src/observe";
import { paneHarnessAt } from "../../src/spool-readiness";
const [mode, arg = ""] = process.argv.slice(2);
const home = process.env.TAP_HOME ?? "";
let text: string;
switch (mode) {
  case "marker": text = flipMarkerState(); break;
  case "epoch-raw": text = serverEpochFromRaw(arg); if (!text) process.exit(1); break;
  case "epoch": {
    const r = Object.hasOwn(process.env, "TAP_SERVER_EPOCH") ? { code: 0, stdout: "" }
      : tmuxReadOnly(["display-message", "-p", "#{pid}:#{start_time}"]);
    text = serverEpochFromRaw(r.code === 0 ? r.stdout.trim() : "");
    if (!text) process.exit(1); break;
  }
  case "harness-family": text = harnessFamily(arg, DEFAULT_AGENT_FAMILIES); break;
  case "harness-class": text = classifyHarness(harnessFamily(arg, DEFAULT_AGENT_FAMILIES), DEFAULT_AGENT_FAMILIES); break;
  case "pane-harness": text = paneHarnessAt(arg); break;
  case "ensure": new Bus(arg || home).ensureDirs(); text = ""; break;
  case "team": text = spoolTeamName(home); break;
  case "registry": {
    const selected = resolveTeamMarkerAware(arg || spoolTeamName(home));
    if (selected.status !== "ok") process.exit(1);
    text = selected.registryLocation; break;
  }
  case "root": text = resolveTeamMarkerAware(arg).root; break;
  case "status": text = resolveTeamMarkerAware(arg).status; break;
  case "bus-root": text = teamRootFromBus(home); break;
  case "boot": text = bootId(); break;
  case "boot-epoch": text = legacyBootId(); break;
  default: throw new Error(`unknown authority fixture mode: ${mode}`);
}
process.stdout.write(text);
