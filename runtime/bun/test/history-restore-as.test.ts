// `tap restore <handle>@N --as <name>` must produce a row `tap session resume <name>`
// finds. A launcher sibling (`tag`, `index: 2`) restored under a new name used to
// keep its index, so the record decoded to `<name>-2` and resume missed it.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeScratchTree } from "./support/scratch";
import { registryState } from "../src/launcher/resume-prelude";
import { findRecordByKey } from "../src/launcher/resume";

const MAIN = join(import.meta.dir, "../main.ts");
const owned: string[] = [];
afterEach(() => { for (const path of owned.splice(0)) removeScratchTree(path); });

test("--as on an index-2 sibling resets the launcher index, so resume's lookup finds the new handle", () => {
  const base = realpathSync(mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "tap-restore-as.")));
  owned.push(base);
  const root = join(base, "team"), bus = join(root, ".tap", "bus"), index = join(base, "index");
  const registry = join(root, ".tap", "team-registry.json"), hist = join(root, ".tap", "team-history");
  mkdirSync(bus, { recursive: true });
  mkdirSync(hist, { recursive: true });
  mkdirSync(index);
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { t: { root, registry_location: registry, state: "registered" } } }));
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "t", worktree_root: root }, seats: {} }, null, 2));
  const row = { instance: "opus-2|1", harness: "claude", harness_session_id: "sib-2", session: "t/opus-2", delivery: "pane",
    status: "active", tag: "opus", index: 2, registered_at: "2026-10-01T10:00:00Z" };
  writeFileSync(join(hist, "opus-2.out-1.20261002T100000Z.json"),
    JSON.stringify({ handle: "opus-2", instance: "opus-2|1", retired_by: "out-1", retired_at: "2026-10-02T10:00:00Z", row }));
  const env: NodeJS.ProcessEnv = { ...process.env, TAP_HOME: bus, TAP_INDEX_HOME: index, TAP_LOCK_DIR: join(base, "locks"), TAP_SCRATCH_ONLY: base };
  delete env.TMUX;
  delete env.TMUX_PANE;
  const result = Bun.spawnSync([process.execPath, MAIN, "restore", "opus-2@1", "--as", "recovered", "--json"], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
  expect(JSON.parse(result.stdout.toString()).next).toBe("tap session resume recovered");
  const restored = JSON.parse(readFileSync(registry, "utf8")).seats.recovered;
  expect(restored).toMatchObject({ index: 1, session: "t/recovered", harness_session_id: "sib-2" });
  expect(restored).not.toHaveProperty("tag");

  // The lookup `tap session resume recovered` runs: the acting registry's relaunchable records, keyed.
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { TAP_HOME: bus, TAP_INDEX_HOME: index, TAP_LOCK_DIR: join(base, "locks") });
    const records = registryState(root).sessions;
    const record = findRecordByKey(records, root, "recovered");
    expect(record, JSON.stringify(records.map(r => ({ name: r.name, tag: r.tag, index: r.index })))).not.toBeNull();
    expect(record!.harness_session_id).toBe("sib-2");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
