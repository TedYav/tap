import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { crewFixture } from "./support/crew-fixture";
import { reserveTransaction, rollbackOwned, suspendAndStop, type FailureEvidence, type TransactionRequest } from "../src/launcher/transaction";
import { selectCaller } from "../src/selector";

// Exercise the shared pre-teardown primitive directly: no native harness launch.
test.each([true, 1])("session replacement refuses a live same-session crew, including legacy marker %j", async marker => {
  const f = crewFixture();
  const original = { ...process.env };
  for (const key of Object.keys(process.env)) if (f.env[key] === undefined) delete process.env[key];
  for (const [key, value] of Object.entries(f.env)) if (value !== undefined) process.env[key] = value;
  try {
    const parent = f.seats().parent;
    const crew = f.read("new-window", "-d", "-t", "Adopt/parent", "-n", "legacy", "-P", "-F", "#{pane_id}", "sleep 600");
    const doc = JSON.parse(readFileSync(f.registry, "utf8"));
    doc.seats.legacy = { ...parent, crew: marker, instance: "legacy-one", pane_id: crew,
      pane: f.read("display-message", "-p", "-t", crew, "#{session_name}:#{window_index}.#{pane_index}") };
    // No owner link: an old crew must also survive session-wide teardown.
    writeFileSync(f.registry, JSON.stringify(doc));
    for (const flags of [["--dry-run"], []]) {
      const before = readFileSync(f.registry, "utf8");
      const result = f.run(["session", "restart", "parent", "--force", "--json", ...flags]);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ error_class: "crew_session_shared", action: "tap session relaunch Adopt/parent" });
      expect(readFileSync(f.registry, "utf8")).toBe(before);
    }
    const selection = selectCaller({ cwd: f.cwd, env: f.env, verbClass: "lifecycle" });
    const record = { name: "Adopt/parent", replaces_session: "Adopt/parent", harness: "codex", cwd: f.cwd, base: "Adopt", tag: "parent", index: 1 };
    const request: TransactionRequest = { kind: "restart", record, incumbent_live: true };
    const evidence: FailureEvidence = { selection, handle: "parent", token: "", instance: null, record,
      vessel: null, backup: { status: "not-needed" }, reason: "restart_failed", output_path: "" };
    await reserveTransaction(selection, request, evidence, f.env);
    const before = readFileSync(f.registry, "utf8"), stop = { attempted: false, killed: false, uncertain: false, adoptedShell: false };
    await expect(suspendAndStop(evidence, request, stop, f.env)).rejects.toThrow("tap session relaunch Adopt/parent");
    expect(stop.attempted).toBe(false);
    expect(readFileSync(f.registry, "utf8")).toBe(before);
    expect(f.read("display-message", "-p", "-t", crew, "#{pane_id}")).toBe(crew);
    expect(f.read("display-message", "-p", "-t", parent.pane_id, "#{pane_id}")).toBe(parent.pane_id);
    await rollbackOwned(evidence, null, f.env, false);
  } finally {
    await f.close();
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  }
}, 30000);
