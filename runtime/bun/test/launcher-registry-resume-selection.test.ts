import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registryResumeSelection } from "../src/launcher/observation";


// Incumbent: 633a47c36f98d024de2fc17e10d2c69af7c2d231, captured before deleting its selector.
// The table ran through launcher.registry_resume_record until resume.ts became
// the only caller; it now drives the owner directly with the same fake tmux.
test("registry resume selection preserves incumbent choices, observation order, and defaults", async () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-resume-selection-"));
  const log = join(dir, "observed");
  writeFileSync(join(dir, "tmux"), `#!/bin/sh
while [ "$#" -gt 0 ] && [ "$1" != "-t" ]; do shift; done
target="$2"
echo "$target" >> ${JSON.stringify(log)}
if [ "$target" = "%1" ]; then printf 'observed:0.0\\t%%1\\tclaude\\t1:1\\t0\\t100\\t/fixture\\n'; else exit 1; fi
`);
  chmodSync(join(dir, "tmux"), 0o755);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, TAP_SERVER_EPOCH: "srv:1:1" };
  const row = (session = "target", extra: Record<string, unknown> = {}) => ({ session, harness: "claude", ...extra });
  const cases: [string, [string, Record<string, unknown>][], string[] | null, string[]][] = [
    ["empty", [], null, []],
    ["handle-first", [["other", row()], ["target", row("owned", { harness_session_id: "not-copied", index: 9 })]], ["owned", "claude", "target"], []],
    ["integer-order", [["10", row()], ["2", row()]], ["target", "claude", "10"], []],
    ["missing-status", [["seat", row()]], ["target", "claude", "seat"], []],
    ["explicit-active", [["seat", row("target", { status: "active" })]], ["target", "claude", "seat"], []],
    ["inactive-exact", [["other", row()], ["target", row("owned", { status: "suspended", pane_id: "%2" })]], ["target", "claude", "other"], []],
    ["no-match", [["seat", row("elsewhere")]], null, []],
    ["missing-session", [["target", { harness: "claude" }]], null, []],
    ["observed-handle", [["target", row("stored", { pane_id: "%1", server_epoch: "srv:1:1" })]], ["observed", "claude", "target"], ["%1"]],
    ["stale-epoch", [["target", row("stored", { pane_id: "%1", server_epoch: "srv:2:2" })]], ["stored", "claude", "target"], []],
    ["observe-before-key", [["other", row("miss", { pane_id: "%2" })], ["seat", row()]], ["target", "claude", "seat"], ["%2"]],
    ["observe-before-harness", [["target", { session: "owned", harness: "bogus", pane_id: "%2" }], ["seat", row()]], ["target", "claude", "seat"], ["%2"]],
    ["first-match", [["first", row()], ["later", row("target", { pane_id: "%2" })]], ["target", "claude", "first"], []],
    ...[null, "", false, 0, [], {}, "removed"].map((status, i): [string, [string, Record<string, unknown>][], null, string[]] =>
      [`status-${i}`, [["target", row("target", { status, pane_id: "%2" })]], null, []]),
  ];
  for (const [label, pairs, picked, observed] of cases) {
    writeFileSync(log, "");
    const value = await registryResumeSelection(pairs, "target", env);
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
    expect({ label, actual: value ? [value.name, value.harness, value.tag] : null, calls }).toEqual({ label, actual: picked, calls: observed });
  }
  expect(cases).toHaveLength(20);
});

test("malformed requests are refused, never read as no candidate", async () => {
  for (const [entries, key] of [[{}, "x"], [[], null], [[["x", []]], "x"], [[[1, {}]], "x"], [[["x", {}, 1]], "x"]] as const) {
    await expect(registryResumeSelection(entries, key, process.env)).rejects.toThrow("invalid registry resume selection request");
  }
});

test("observation errors and interruptions propagate before returning a candidate", async () => {
  const failure = new Error("observation failed");
  const brokenRow = { harness: "claude", get session(): string { throw failure; } };
  await expect(registryResumeSelection([["x", brokenRow]], "x", process.env)).rejects.toBe(failure);
  const controller = new AbortController(), reason = new Error("selection interrupted");
  const pending = registryResumeSelection([["x", { session: "stored", harness: "claude" }]], "x", process.env, controller.signal);
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  await expect(registryResumeSelection([], "x", process.env, controller.signal)).rejects.toBe(reason);
});
