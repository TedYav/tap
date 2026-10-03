// Port of crew-acting-registry.test.sh's symlink-alias arm: equal file
// realpaths do not imply equal lock-sidecar paths, so a symlink alias of the
// acting registry must refuse even though realpath() agrees. The owner drives
// the exported checkCrewRegistry — the production check behind the retired
// `tap_bun_call crew-registry` door — in-process, on a real enrolled team.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCrewRegistry } from "../src/crew-registry";

const savedEnv: Array<[string, string | undefined]> = [];
const savedCwd = process.cwd();
let fixtureRoot: string | null = null;
let fixtureState: { root: string; registry: string } | null = null;

afterAll(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.chdir(savedCwd);
});

/** One enrolled team whose acting registry lives at <root>/.tap/team-registry.json. */
function fixture() {
  if (fixtureState) return fixtureState;
  const base = process.env.TMUX_TMPDIR ?? tmpdir();
  for (const key of ["TAP_INDEX_HOME"]) savedEnv.push([key, process.env[key]]);
  fixtureRoot = realpathSync(mkdtempSync(join(base, "crew-registry-")));
  const root = join(fixtureRoot, "Crew");
  mkdirSync(join(root, ".tap"), { recursive: true });
  const init = Bun.spawnSync(["git", "init", "-q", root]);
  if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr.toString()}`);
  const registry = join(root, ".tap", "team-registry.json");
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "Crew" }, seats: {} }));
  const index = join(fixtureRoot, "index");
  mkdirSync(index, { recursive: true });
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({
    schema: "0.20",
    teams: { Crew: { root, registry_location: registry, state: "registered" } },
  }));
  process.env.TAP_INDEX_HOME = index;
  fixtureState = { root, registry };
  return fixtureState;
}

test("a symlink alias of the acting registry is refused despite equal realpaths", () => {
  const { root, registry } = fixture();
  const alias = join(fixtureRoot!, "registry-alias.json");
  symlinkSync(registry, alias);
  try {
    expect(() => checkCrewRegistry(root, alias)).toThrow(
      `crew cwd selects ${registry}, launcher uses ${alias}`,
    );
  } finally {
    rmSync(alias, { force: true });
  }
});

test("the literal acting registry passes the crew registry check", () => {
  const { root, registry } = fixture();
  expect(() => checkCrewRegistry(root, registry)).not.toThrow();
});
