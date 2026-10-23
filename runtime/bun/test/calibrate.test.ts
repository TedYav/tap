import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const work = mkdtempSync(join(tmpdir(), "tap-calibrate-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
let count = 0;
function fixture(config?: string) {
  const home = join(work, String(count++));
  mkdirSync(join(home, ".config/tap"), { recursive: true });
  if (config !== undefined) writeFileSync(join(home, ".config/tap/config.toml"), config);
  return home;
}
function run(home: string, args: string[]) {
  return Bun.spawnSync([join(root, "bin/tap"), ...args], {
    cwd: work, env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
  });
}

test("disabled calibrate refuses every read and write, even JSON, before route or file effects", () => {
  for (const config of [undefined, "[calibration]\nenabled = false\n"]) {
    const home = fixture(config);
    for (const args of [[], ["--json"], ["example"], ["example", "--all"], ["example", "-f", "missing.md", "--json"]]) {
      const result = run(home, ["calibrate", ...args]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString().trim().split("\n")).toHaveLength(1);
      expect(result.stderr.toString()).toContain("calibration.enabled");
      expect(result.stderr.toString()).toContain("tap config set calibration.enabled true");
      expect(existsSync(join(home, ".tap/calibration"))).toBe(false);
    }
    expect(run(home, ["config", "get", "calibration.enabled"]).stdout.toString()).toBe(config ? "false\n" : "false (default)\n");
  }
});

test("enabled native reads return full JSON, unknown routes refuse, and help is independent of the toggle", () => {
  const home = fixture('[calibration]\nenabled = true\n');
  const index = join(home, "index");
  const registry = join(home, "team.json");
  mkdirSync(index);
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "example" }, seats: { reader: { harness: "codex", model: "example-model", session: "example/reader", index: 1 } } }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { example: { root: home, registry_location: registry } } }));
  const invoke = (args: string[]) => Bun.spawnSync([join(root, "bin/tap"), "calibrate", ...args], {
    cwd: work, env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), TAP_INDEX_HOME: index },
  });
  const noNotes = invoke(["reader"]);
  expect(noNotes.exitCode, noNotes.stderr.toString()).toBe(0);
  expect(noNotes.stdout.toString()).toContain("codex/example-model (no notes)");
  expect(existsSync(join(home, ".tap/calibration"))).toBe(false);
  expect(JSON.parse(invoke(["reader", "--json"]).stdout.toString())).toEqual([]);
  const unknown = invoke(["codex/never-observed", "--json"]);
  expect(unknown.exitCode).toBe(1);
  expect(JSON.parse(unknown.stdout.toString()).error_class).toBe("unknown_route");
  expect(unknown.stderr.toString()).toBe("");
  const store = join(home, ".tap/calibration");
  mkdirSync(store, { recursive: true });
  const rows = [
    { id: "0123abcd", at: "2026-10-18", route: "codex/example-model", by: "example/writer", ref: "PR #1", note: "Old scoped failure" },
    { id: "0123abce", at: "2026-10-19", route: "codex/example-model", effort: "high", by: "example/writer", ref: "PR #2", note: "New scoped success" },
    { id: "0123abcf", at: "2026-10-20", route: "codex/example-other", by: "example/writer", ref: "PR #3", note: "Outside candidates" },
  ];
  writeFileSync(join(store, "observations.jsonl"), rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  expect(JSON.parse(invoke(["reader", "--json"]).stdout.toString())).toEqual([rows[1], rows[0]]);
  expect(JSON.parse(invoke(["--json"]).stdout.toString())).toEqual([rows[1], rows[0]]);
  expect(invoke([]).stdout.toString()).toContain("New scoped success");
  expect(invoke([]).stdout.toString()).not.toContain("Outside candidates");
  for (const args of [["--ref", "PR #1"], ["reader", "--effort", "high"], ["--unknown"], ["reader", "extra"]]) {
    expect(invoke(args).exitCode).toBe(1);
  }
  const empty = join(home, "empty.md");
  writeFileSync(empty, " \n");
  const refused = invoke(["reader", "-f", empty, "--json"]);
  expect(refused.exitCode).toBe(1);
  expect(JSON.parse(refused.stdout.toString()).error_class).toBe("empty_note");
  expect(invoke(["reader", "-f", home, "--json"]).exitCode).toBe(1);
  expect(invoke(["reader", "-f", "-", "--all", "--json"]).exitCode).toBe(1);
  for (const home of [fixture(), fixture("invalid [[[")]) {
    const help = run(home, ["calibrate", "--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toContain("tap calibrate");
  }
});
