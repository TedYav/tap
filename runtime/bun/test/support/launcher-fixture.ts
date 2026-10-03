// Native fixture construction shared by shell integration tests. Run only inside their isolated runner.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeComponent } from "../../src/launcher/naming";
import { recordFromRow, storeRecipe, type LaunchRecord } from "../../src/launcher/transaction";
import { launchInvocation } from "../../src/launcher/invocation";
import { Notices } from "../../src/launcher/catalog-notices";
import { resolvedResumeIdentity } from "../../src/launcher/resume-identity";
import { observeGeneration } from "../../src/launcher/generation";
import { serverEpochFromRaw, tmuxReadOnly } from "../../src/tmux";

const [op, first = "", second = ""] = process.argv.slice(2);
if (op === "sanitize") console.log(sanitizeComponent(first));
else if (op === "epoch") console.log((await observeGeneration()).epoch ?? "");
else if (op === "epoch-raw") console.log(serverEpochFromRaw(first));
else if (op === "process-resume") {
  const row = JSON.parse(readFileSync(first, "utf8")).seats.processseat;
  assert.equal(row.session_attribution_trust, "process");
  assert.equal(row.harness_session_id, "11111111-1111-4111-8111-111111111111");
  assert.ok(!row.derived_harness_session_id);
  row.session = row.pane.slice(0, row.pane.lastIndexOf(":"));
  const record = recordFromRow("processseat", row, {}, second);
  assert.ok(record);
  assert.equal(resolvedResumeIdentity(record), row.harness_session_id);
  assert.ok(launchInvocation("resume", record, new Notices(() => {})).argv.includes(row.harness_session_id));
} else if (op === "dotted-registry" || op === "canonical-registry") {
  const root = first, team = second || "demo";
  const handles = op === "dotted-registry" ? ["fable", "sol", "ghost"] : ["kimi", "grok"];
  const seats: Record<string, Record<string, unknown>> = {};
  for (const [i, handle] of handles.entries()) {
    const name = `${sanitizeComponent(team)}/${op === "canonical-registry" && handle === "grok" ? "legacy-scout" : handle}`;
    const record: LaunchRecord = { name, harness: "claude", cwd: root, base: team, tag: handle, index: 1 };
    let pane = `%${101 + i}`;
    if (op === "dotted-registry" && handle !== "ghost") {
      const r = tmuxReadOnly(["display-message", "-p", "-t", `=${name}`, "#{pane_id}"]);
      assert.equal(r.code, 0, r.stderr);
      pane = r.stdout.trim();
    }
    const entry = { status: "active", delivery: "pane", registered_from_worktree: root,
      registered_at: "2026-09-15T00:00:00Z", pane: `${name}:0.0`, pane_id: pane,
      server_epoch: "srv:900:100", session: name };
    storeRecipe(entry, record);
    seats[handle] = entry;
  }
  const dir = join(root, ".tap/bus");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: team, worktree_root: root }, seats }) + "\n");
} else throw new Error(`unknown fixture operation: ${op}`);
