// Test-only doors for shell controls whose Python production adapters retired.
// Policy stays in the native owners; this file formats their observations only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Bus } from "../../src/bus";
import { repoRoot, resolveBus, teamRootFromBus } from "../../src/bushome";
import { enrollmentAt } from "../../src/index-home";
import { seatIsRelaunchable } from "../../src/launcher/complete";
import { listHandleHistory } from "../../src/verbs/register";

const [mode, arg = "", handle = "", session = ""] = process.argv.slice(2);
switch (mode) {
  case "history-count": console.log(listHandleHistory("", handle, arg).length); break;
  case "registry-status": {
    const selected = enrollmentAt(arg);
    console.log(selected.status);
    console.log("registryLocation" in selected ? selected.registryLocation : "");
    break;
  }
  case "relaunchable": {
    const row = JSON.parse(readFileSync(arg, "utf8")).seats[handle];
    assert.equal(seatIsRelaunchable(row), true);
    assert.equal(row.harness_session_id, session);
    break;
  }
  case "bus-select": {
    const selected = resolveBus(repoRoot());
    process.stdout.write(`${selected.rule}|${selected.home}`);
    break;
  }
  case "bus-ensure": new Bus(resolveBus(repoRoot()).home).ensureDirs(); break;
  case "bus-custom": {
    const home = resolveBus(repoRoot()).home;
    new Bus(home).ensureDirs();
    process.stdout.write(teamRootFromBus(home));
    break;
  }
  default: throw new Error(`unknown Python retirement fixture mode: ${mode}`);
}
