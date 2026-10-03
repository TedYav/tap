import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TapError } from "../src/context";
import { assertBoundSeats, discoverTeams, readDiscoverySeats, type BoundCohort } from "../src/team/discovery";
import { scanOptionalSelection } from "../src/team/selection";

test("optional selectors distinguish an absent value from a supplied list before UI", () => {
  expect(scanOptionalSelection("team down", ["alpha", "--only", "--yes"])).toEqual({
    pending: "--only", selection: { mode: "", only: [], except: [] }, rest: ["alpha", "--yes"],
  });
  expect(scanOptionalSelection("team down", ["--only", "beta", "--yes"])).toEqual({
    pending: undefined, selection: { mode: "--only", only: ["beta"], except: [] }, rest: ["--yes"],
  });
  for (const argv of [["--only", ""], ["--only", "ann,ann"], ["--only", "ann", "--only"], ["--only", "--except"], ["--only", "--yes", "alpha"]]) {
    expect(() => scanOptionalSelection("team down", argv)).toThrow(TapError);
  }
});

test("team discovery reads only reachable live enrollment from a guarded index", () => {
  const base = mkdtempSync(join(tmpdir(), "tap-discovery-"));
  const index = join(base, "index");
  mkdirSync(index);
  const registry = join(base, "registry.json");
  writeFileSync(registry, "{}\n");
  const previous = process.env.TAP_INDEX_HOME;
  process.env.TAP_INDEX_HOME = index;
  try {
    writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
      active: { root: base, registry_location: registry },
      retired: { root: base, registry_location: registry, state: "historical" },
      missing: { root: base, registry_location: join(base, "gone.json") },
    } }));
    expect(discoverTeams()).toEqual([{ team: "active", root: base, registryPath: registry }]);
    writeFileSync(join(index, "global-registry.json"), "broken");
    expect(() => discoverTeams()).toThrow(TapError);
  } finally {
    if (previous === undefined) delete process.env.TAP_INDEX_HOME; else process.env.TAP_INDEX_HOME = previous;
    rmSync(base, { recursive: true, force: true });
  }
});

test("a selected seat replacement refuses while an unrelated late seat is spared", () => {
  const approved = { handle: "ann", instance: "one", session: "team/ann", paneId: "%1", serverEpoch: "epoch" };
  const bound = { team: { team: "team" }, seats: new Map([["ann", approved]]) } as BoundCohort;
  const ann = { instance: "one", session: "team/ann", pane_id: "%1", server_epoch: "epoch" };
  expect(() => assertBoundSeats(bound, { ann, late: { instance: "new" } })).not.toThrow();
  try { assertBoundSeats(bound, { ann: { ...ann, instance: "two" } }); }
  catch (error) { expect((error as TapError).errorClass).toBe("target_changed"); return; }
  throw new Error("same-name replacement was accepted");
});

test("read-only discovery preserves unrelated wide-number registry extensions", () => {
  const base = mkdtempSync(join(tmpdir(), "tap-discovery-"));
  try {
    const path = join(base, "registry.json");
    writeFileSync(path, '{"schema":"0.20","team":{"name":"alpha"},"extra":9007199254740993,"seats":{"ann":{"instance":"one","crew":false,"note":9007199254740993}}}\n');
    expect(readDiscoverySeats(path).ann?.instance).toBe("one");
  } finally { rmSync(base, { recursive: true, force: true }); }
});
