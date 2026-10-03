// Causal controls for the Stage 0 Bun selector (tap-1t0h.1).
// Each named control has a mutant that must RED — a result-only assertion
// without that counterfactual does not prove the discriminator.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  accessSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import * as indexHomeModule from "../src/index-home";
import { busHomeForRegistry, enrollmentAtFromDoc, flipMarkerState, globalRegistryPath, legacyTeamsPath, resolveTeamFromGlobal } from "../src/index-home";
import { resolveContext, spoolTeamName, TapError } from "../src/context";
import { acquireRegistryLock, isRegistryLock, type RegistryLock } from "../src/panelock";
import {
  assertSelectionCurrent,
  nearestEnrollment,
  parseTarget,
  resolveSelector,
  selectCaller,
  SelectorError,
  validateChildSelection,
  type Selection,
} from "../src/selector";
import { removeScratchTree } from "./support/scratch";

const MAIN = join(import.meta.dir, "../main.ts");
const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) {
    try { chmodSync(path, 0o755); } catch { /* restore for deletion */ }
    removeScratchTree(path);
  }
});

function work() {
  const dir = mkdtempSync(join(tmpdir(), "tap-selector."));
  scratch.push(dir);
  const index = join(dir, "index");
  mkdirSync(index, { recursive: true });
  return { dir, index };
}

/** A born-live machine with no enrolled team (every install since F1). */
function seedLive(index: string) {
  writeFileSync(globalRegistryPath(index), JSON.stringify({ schema: "0.20", teams: {} }));
}

function envFor(index: string, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TAP_INDEX_HOME: index, ...extra };
  if (!("TAP_HOME" in extra)) delete env.TAP_HOME;
  return env;
}

function writeRegistry(path: string, team: string, root: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    schema: "0.20",
    team: { name: team, worktree_root: root },
    seats: {},
  }));
}

function enroll(index: string, root: string, team: string, loc?: string) {
  const registry = loc ?? join(root, ".tap", "team-registry.json");
  writeRegistry(registry, team, root);
  mkdirSync(join(root, ".tap", "bus"), { recursive: true });
  const path = globalRegistryPath(index);
  let teams: Record<string, unknown> = {};
  try {
    teams = (JSON.parse(readFileSync(path, "utf8")) as { teams?: Record<string, unknown> }).teams ?? {};
  } catch { /* first enroll */ }
  teams[team] = {
    enrolled_at: "2026-09-01T00:00:00Z",
    registry_location: registry,
    root,
    state: "registered",
  };
  mkdirSync(index, { recursive: true });
  writeFileSync(path, JSON.stringify({ schema: "0.20", migrated: {}, teams }));
  return registry;
}

function errClass(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof SelectorError) return error.errorClass;
    if (error instanceof TapError) return error.errorClass;
    throw error;
  }
  throw new Error("expected refusal");
}

function withRegistryLock(registryLocation: string, fn: (lock: RegistryLock) => void) {
  const lock = acquireRegistryLock(registryLocation);
  if (!lock) throw new Error(`acquireRegistryLock failed for ${registryLocation}`);
  try {
    fn(lock);
  } finally {
    lock.release();
  }
}

describe("an absent machine marker refuses before any selection (born live, F1)", () => {
  test("cwd, TAP_HOME, --team and a pinned root all refuse unanchored_bus; pre-flip bus fallback mutant reds", () => {
    const { dir, index } = work();
    const root = join(dir, "repo");
    const bus = join(root, ".tap", "bus");
    mkdirSync(bus, { recursive: true });
    writeRegistry(join(bus, "registry.json"), "legacy", root);
    writeFileSync(legacyTeamsPath(index), JSON.stringify({ teams: { legacy: { root } } }));
    const refusal = (fn: () => unknown) => {
      try { fn(); } catch (error) {
        if (error instanceof SelectorError) return [error.errorClass, error.action, error.detail];
        throw error;
      }
      throw new Error("expected refusal");
    };
    const expected = ["unanchored_bus", "tap init  OR  tap session launch",
      "no machine index (global-registry.json); this machine has no enrolled team"];
    expect(refusal(() => selectCaller({ cwd: root, env: envFor(index) }))).toEqual(expected);
    expect(refusal(() => selectCaller({ cwd: root, env: envFor(index, { TAP_HOME: bus }) }))).toEqual(expected);
    expect(refusal(() => selectCaller({ cwd: dir, env: envFor(index), explicitTeam: "legacy" }))).toEqual(expected);
    expect(refusal(() => selectCaller({ cwd: dir, env: envFor(index), pinnedRoot: root }))).toEqual(expected);
    // Counterfactual: everything the deleted pre-flip arm bound (a readable
    // bus registry naming the team) is present, so the refusal is the
    // selector's decision, not missing data.
    const preFlipArm = () => JSON.parse(readFileSync(join(bus, "registry.json"), "utf8")).team.name;
    expect(preFlipArm()).toBe("legacy");
  });
});

describe("explicit --team wins caller selection", () => {
  test("cwd enrolled as A, --team B binds B", () => {
    const { dir, index } = work();
    const a = join(dir, "A");
    const b = join(dir, "B");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    enroll(index, a, "alpha");
    const bReg = enroll(index, b, "beta");
    const sel = selectCaller({ cwd: a, env: envFor(index), explicitTeam: "beta" });
    expect(sel.team).toBe("beta");
    expect(sel.source).toBe("explicit-team");
    expect(sel.authority).toBe("enrolled");
    expect(sel.registryLocation).toBe(bReg);
    expect(sel.registryLocationReal).toBe(realpathSync(bReg));
  });
});

describe("same-axis conflict vs send --team X Y/h", () => {
  test("lifecycle --team X Y/h refuses; send is caller X to recipient Y", () => {
    const { dir, index } = work();
    const x = join(dir, "X");
    const y = join(dir, "Y");
    mkdirSync(x, { recursive: true });
    mkdirSync(y, { recursive: true });
    enroll(index, x, "exes");
    enroll(index, y, "whys");
    expect(errClass(() => resolveSelector({
      cwd: x, env: envFor(index), explicitTeam: "exes", explicitTarget: "whys/h", verbClass: "lifecycle",
    }))).toBe("selector_conflict");
    const send = resolveSelector({
      cwd: x, env: envFor(index), explicitTeam: "exes", explicitTarget: "whys/h", verbClass: "send",
    });
    expect(send.caller.team).toBe("exes");
    expect(send.target?.team).toBe("whys");
    expect(send.target?.handle).toBe("h");
    expect(send.target?.scope).toBe("remote");
  });
});

describe("canonical-realpath nearest enrolled ancestor", () => {
  test("nested roots: inner wins; git-toplevel-only mutant reds", () => {
    const { dir, index } = work();
    const outer = join(dir, "outer");
    const inner = join(outer, "inner");
    const leaf = join(inner, "sub");
    mkdirSync(leaf, { recursive: true });
    enroll(index, outer, "outer-team");
    enroll(index, inner, "inner-team");
    spawnSync("git", ["init", "-q", outer]);
    const sel = selectCaller({ cwd: leaf, env: envFor(index) });
    expect(sel.team).toBe("inner-team");
    expect(sel.source).toBe("cwd");

    const gitToplevelOnly = (cwd: string) => {
      const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
      const top = r.stdout.trim();
      return realpathSync(top) === realpathSync(inner) ? "inner-team" : "outer-team";
    };
    expect(gitToplevelOnly(leaf)).toBe("outer-team");

    const agentSub = join(outer, ".claude", "worktrees", "agent-x", "sub");
    mkdirSync(agentSub, { recursive: true });
    expect(selectCaller({ cwd: agentSub, env: envFor(index) }).team).toBe("outer-team");
  });

  test("torn-read hazard: a two-read walk binds outer", () => {
    // Models the hazard on a synthetic walk. The production loop is pinned by
    // "nearestEnrollment reads the index once for the whole ancestor walk" below.
    const { dir, index } = work();
    const outer = join(dir, "outer");
    const inner = join(outer, "inner");
    mkdirSync(inner, { recursive: true });
    enroll(index, outer, "outer-team");
    enroll(index, inner, "inner-team");
    expect(selectCaller({ cwd: inner, env: envFor(index) }).team).toBe("inner-team");

    const both = JSON.parse(readFileSync(globalRegistryPath(index), "utf8")) as {
      schema: string;
      teams: Record<string, unknown>;
    };
    const withoutInner = {
      ...both,
      teams: Object.fromEntries(Object.entries(both.teams).filter(([name]) => name !== "inner-team")),
    };
    const twoReadMutant = (start: string): string => {
      let first = true;
      let dir = start;
      while (true) {
        const at = enrollmentAtFromDoc(first ? withoutInner : both, dir);
        first = false;
        if (at.status === "ok") return at.name;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      return "none";
    };
    expect(twoReadMutant(inner)).toBe("outer-team");
  });

  test("nearestEnrollment reads the index once for the whole ancestor walk", () => {
    const { dir, index } = work();
    const outer = join(dir, "outer");
    const inner = join(outer, "inner");
    mkdirSync(inner, { recursive: true });
    enroll(index, outer, "outer-team");
    // Only outer is enrolled, so the walk probes inner (missing) before outer.
    const loads = spyOn(indexHomeModule, "loadGlobalRegistry");
    const rereads = spyOn(indexHomeModule, "enrollmentAt");
    try {
      expect(nearestEnrollment(inner, index)).toMatchObject({ status: "ok", name: "outer-team" });
      // A per-ancestor re-read (enrollmentAt, or a load per directory) would
      // let a rewrite between probes bind a team no single snapshot named.
      expect(loads).toHaveBeenCalledTimes(1);
      expect(rereads).not.toHaveBeenCalled();
    } finally {
      loads.mockRestore();
      rereads.mockRestore();
    }
  });

  test("symlink parent compares realpath on both sides; logical-path mutant reds", () => {
    const { dir, index } = work();
    const real = join(dir, "real", "team");
    mkdirSync(real, { recursive: true });
    enroll(index, real, "real-team");
    const linkParent = join(dir, "link");
    mkdirSync(linkParent, { recursive: true });
    symlinkSync(real, join(linkParent, "team"));
    const viaLink = join(linkParent, "team", "sub");
    mkdirSync(viaLink, { recursive: true });
    const sel = selectCaller({ cwd: viaLink, env: envFor(index) });
    expect(sel.team).toBe("real-team");
    expect(sel.rootReal).toBe(realpathSync(real));

    const logicalCompare = (cwd: string, enrolledRoot: string) => cwd.startsWith(enrolledRoot);
    expect(logicalCompare(viaLink, real)).toBe(false);
  });
});

describe("tri-state walk: unreachable/ambiguous stop without outward fallback", () => {
  test("enrolled-but-missing registry refuses; boolean-walk mutant binds outer", () => {
    const { dir, index } = work();
    const outer = join(dir, "outer");
    const inner = join(outer, "inner");
    const leaf = join(inner, "sub");
    mkdirSync(leaf, { recursive: true });
    enroll(index, outer, "outer-team");
    const innerReg = join(inner, ".tap", "team-registry.json");
    mkdirSync(join(inner, ".tap"), { recursive: true });
    writeFileSync(globalRegistryPath(index), JSON.stringify({
      schema: "0.20",
      teams: {
        "outer-team": {
          root: outer,
          registry_location: join(outer, ".tap", "team-registry.json"),
          state: "registered",
        },
        "inner-team": {
          root: inner,
          registry_location: innerReg,
          state: "registered",
        },
      },
    }));
    expect(errClass(() => selectCaller({ cwd: leaf, env: envFor(index) }))).toBe("live_unreachable");

    const booleanWalk = (start: string): string => {
      let dir = start;
      const doc = JSON.parse(readFileSync(globalRegistryPath(index), "utf8")) as {
        teams: Record<string, { root: string }>;
      };
      while (true) {
        try {
          accessSync(join(dir, ".tap", "team-registry.json"));
          for (const [name, ent] of Object.entries(doc.teams)) {
            if (realpathSync(ent.root) === realpathSync(dir)) return name;
          }
        } catch { /* boolean probe: no file means not enrolled, keep walking */ }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      return "none";
    };
    expect(booleanWalk(leaf)).toBe("outer-team");
  });

  test("two enrollments at one realpath refuse ambiguous", () => {
    const { dir, index } = work();
    const root = join(dir, "one");
    mkdirSync(root, { recursive: true });
    const loc = join(root, ".tap", "team-registry.json");
    writeRegistry(loc, "alpha", root);
    writeFileSync(globalRegistryPath(index), JSON.stringify({
      schema: "0.20",
      teams: {
        alpha: { root, registry_location: loc, state: "registered" },
        beta: { root, registry_location: loc, state: "registered" },
      },
    }));
    expect(errClass(() => selectCaller({ cwd: root, env: envFor(index) }))).toBe("ambiguous_team");
  });
});

describe("deleted cwd refuses; TAP_HOME fallback mutant reds", () => {
  test("removed cwd is cwd_unreachable even with TAP_HOME set", () => {
    const { dir, index } = work();
    const gone = join(dir, "gone");
    mkdirSync(gone, { recursive: true });
    const bus = join(dir, "scratch", ".tap", "bus");
    mkdirSync(bus, { recursive: true });
    writeFileSync(join(bus, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "scratch" }, seats: {} }));
    writeFileSync(globalRegistryPath(index), JSON.stringify({ schema: "0.20", teams: {} }));
    rmSync(gone, { recursive: true, force: true });
    expect(errClass(() => selectCaller({
      cwd: gone,
      env: envFor(index, { TAP_HOME: bus }),
    }))).toBe("cwd_unreachable");
  });
});

describe("canonicalDir recovers a backslash path (tap-e05cw)", () => {
  // Bun 1.4's realpathSync throws ENOENT for an existing directory whose path
  // carries a backslash; canonicalDir's native-platform fallback must select,
  // while every failed check still refuses cwd_unreachable.
  const METACHARS = "back`$()\\slash";

  test("enrolled cwd whose path carries a backslash selects", () => {
    const { dir, index } = work();
    const cwd = join(dir, METACHARS);
    mkdirSync(cwd, { recursive: true });
    enroll(index, cwd, "here");
    writeFileSync(join(cwd, ".tap", "bus", "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "here" }, seats: {} }));
    const sel = selectCaller({ cwd, env: envFor(index) });
    expect(sel.team).toBe("here");
    expect(sel.rootReal.endsWith(METACHARS)).toBe(true);
  });

  test("nonexistent backslash path refuses cwd_unreachable", () => {
    const { dir, index } = work();
    seedLive(index);
    const gone = join(dir, "gone`$()\\dir");
    expect(errClass(() => selectCaller({ cwd: gone, env: envFor(index) }))).toBe("cwd_unreachable");
  });

  test("file at the path refuses cwd_unreachable", () => {
    const { dir, index } = work();
    seedLive(index);
    const file = join(dir, METACHARS);
    writeFileSync(file, "x");
    expect(errClass(() => selectCaller({ cwd: file, env: envFor(index) }))).toBe("cwd_unreachable");
  });

  test("symlinked cwd resolves to the physical target", () => {
    const { dir, index } = work();
    const real = join(dir, "real-root");
    mkdirSync(real, { recursive: true });
    enroll(index, real, "here");
    writeFileSync(join(real, ".tap", "bus", "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "here" }, seats: {} }));
    const link = join(dir, METACHARS);
    symlinkSync(real, link, "dir");
    const sel = selectCaller({ cwd: link, env: envFor(index) });
    expect(sel.team).toBe("here");
    expect(sel.rootReal).toBe(realpathSync(real));
  });

  test("search-denied backslash cwd refuses cwd_unreachable", () => {
    const { dir, index } = work();
    seedLive(index);
    const locked = join(dir, METACHARS);
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o000);
    try {
      expect(errClass(() => selectCaller({ cwd: locked, env: envFor(index) }))).toBe("cwd_unreachable");
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

describe("malformed explicit selector never falls back", () => {
  test("empty, slash, historical, unknown refuse; cwd-fallback mutant reds", () => {
    const { dir, index } = work();
    const cwd = join(dir, "cwd");
    mkdirSync(cwd, { recursive: true });
    enroll(index, cwd, "here");
    expect(errClass(() => selectCaller({ cwd, env: envFor(index), explicitTeam: "" }))).toBe("usage_error");
    expect(errClass(() => selectCaller({ cwd, env: envFor(index), explicitTeam: "a/b" }))).toBe("usage_error");
    expect(errClass(() => parseTarget("X/Y/h"))).toBe("usage_error");
    writeFileSync(globalRegistryPath(index), JSON.stringify({
      schema: "0.20",
      teams: {
        here: { root: cwd, registry_location: join(cwd, ".tap", "team-registry.json"), state: "registered" },
        old: { root: join(dir, "old"), registry_location: join(dir, "old", ".tap", "team-registry.json"), state: "historical" },
      },
    }));
    expect(errClass(() => selectCaller({ cwd, env: envFor(index), explicitTeam: "old" }))).toBe("historical_team");
    expect(errClass(() => selectCaller({ cwd, env: envFor(index), explicitTeam: "ghost" }))).toBe("unknown_team");
    const cwdFallbackOnUnknown = (explicit: string): string => {
      try {
        return selectCaller({ cwd, env: envFor(index), explicitTeam: explicit }).team;
      } catch {
        return selectCaller({ cwd, env: envFor(index) }).team;
      }
    };
    expect(cwdFallbackOnUnknown("ghost")).toBe("here");
  });
});

describe("TAP_HOME only when no cwd enrollment", () => {
  test("enrolled cwd wins a foreign TAP_HOME", () => {
    const { dir, index } = work();
    const cwd = join(dir, "cwd");
    mkdirSync(cwd, { recursive: true });
    enroll(index, cwd, "cwd-team");
    const bus = join(dir, "foreign", ".tap", "bus");
    mkdirSync(bus, { recursive: true });
    writeFileSync(join(bus, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "foreign" }, seats: {} }));
    const sel = selectCaller({ cwd, env: envFor(index, { TAP_HOME: bus }) });
    expect(sel.team).toBe("cwd-team");
    expect(sel.source).toBe("cwd");
    expect(sel.authority).toBe("enrolled");
  });
});

describe("live marker + no enrollment + no TAP_HOME", () => {
  test("refuses rather than returning empty registryPath; empty-registry mutant reds", () => {
    const { dir, index } = work();
    const cwd = join(dir, "bare");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(globalRegistryPath(index), JSON.stringify({ schema: "0.20", teams: {} }));
    expect(errClass(() => selectCaller({ cwd, env: envFor(index) }))).toBe("unanchored_bus");
    expect(errClass(() => resolveContext(cwd, envFor(index)))).toBe("unanchored_bus");

    const missingRegistryAsEmpty = (root: string): string => {
      const registryPath = join(root, ".tap", "bus", "registry.json");
      try {
        accessSync(registryPath);
        return realpathSync(registryPath);
      } catch {
        return "";
      }
    };
    expect(missingRegistryAsEmpty(cwd)).toBe("");
  });

  test("a real leftover bus registry is bus authority, not enrolled", () => {
    const { dir, index } = work();
    const cwd = join(dir, "leftover");
    const bus = join(cwd, ".tap", "bus");
    mkdirSync(bus, { recursive: true });
    writeFileSync(join(bus, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "leftover" }, seats: {} }));
    writeFileSync(globalRegistryPath(index), JSON.stringify({ schema: "0.20", teams: {} }));
    const sel = selectCaller({ cwd, env: envFor(index) });
    expect(sel.authority).toBe("bus");
    expect(sel.registryLocation).not.toBe("");
    expect(sel.team).toBe("leftover");
  });
});

describe("no-enrollment fallback bus is the git toplevel, not cwd", () => {
  function gitRepoWithBus(dir: string, team: string) {
    const repo = join(dir, "repo");
    const deep = join(repo, "src", "deep");
    const bus = join(repo, ".tap", "bus");
    mkdirSync(deep, { recursive: true });
    mkdirSync(bus, { recursive: true });
    writeFileSync(join(bus, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: team }, seats: {} }));
    const init = spawnSync("git", ["init", "-q", repo], { encoding: "utf8" });
    if (init.status !== 0) throw new Error(init.stderr || "git init failed");
    return { repo, deep, bus: join(realpathSync(repo), ".tap", "bus") };
  }

  test("live unenrolled subdir selects the same repository bus rather than unanchored_bus", () => {
    const { dir, index } = work();
    const { repo, deep, bus } = gitRepoWithBus(dir, "legacyteam");
    writeFileSync(globalRegistryPath(index), JSON.stringify({ schema: "0.20", teams: {} }));
    const atRoot = selectCaller({ cwd: repo, env: envFor(index) });
    expect(atRoot.busHome).toBe(bus);
    expect(atRoot.team).toBe("legacyteam");
    const atDeep = selectCaller({ cwd: deep, env: envFor(index) });
    expect(atDeep.busHome).toBe(bus);
    expect(atDeep.team).toBe("legacyteam");
    expect(atDeep.authority).toBe("bus");
    expect(atDeep.marker).toBe("live");
    const cwdAsRootMutant = (cwd: string) => join(realpathSync(cwd), ".tap", "bus");
    expect(cwdAsRootMutant(deep)).not.toBe(atDeep.busHome);
  });
});

describe("custom-bus TAP_HOME under a live marker", () => {
  test("unindexed TAP_HOME is bus authority; global-rebind mutant reds", () => {
    const { dir, index } = work();
    const cwd = join(dir, "elsewhere");
    mkdirSync(cwd, { recursive: true });
    const bus = join(dir, "custom", ".tap", "bus");
    mkdirSync(bus, { recursive: true });
    writeFileSync(join(bus, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "custom" }, seats: {} }));
    writeFileSync(globalRegistryPath(index), JSON.stringify({ schema: "0.20", teams: {} }));
    const sel = selectCaller({ cwd, env: envFor(index, { TAP_HOME: bus }) });
    expect(sel.authority).toBe("bus");
    expect(sel.source).toBe("env");
    expect(sel.team).toBe("custom");
    withRegistryLock(sel.registryLocation, (lock) => {
      assertSelectionCurrent(sel, lock, index);
    });

    const globalRebindMutant = (team: string) => {
      const parsed = JSON.parse(readFileSync(globalRegistryPath(index), "utf8")) as { teams: Record<string, unknown> };
      return parsed.teams[team] ? "ok" : "missing";
    };
    expect(globalRebindMutant(sel.team)).toBe("missing");
  });

  test("same-team qualified target on a custom bus reuses caller registry", () => {
    const { dir, index } = work();
    const cwd = join(dir, "elsewhere");
    mkdirSync(cwd, { recursive: true });
    const bus = join(dir, "custom", ".tap", "bus");
    mkdirSync(bus, { recursive: true });
    writeFileSync(join(bus, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "custom" }, seats: {} }));
    writeFileSync(globalRegistryPath(index), JSON.stringify({ schema: "0.20", teams: {} }));
    const out = resolveSelector({
      cwd,
      env: envFor(index, { TAP_HOME: bus }),
      explicitTarget: "custom/alice",
      verbClass: "send",
    });
    expect(out.caller.authority).toBe("bus");
    expect(out.target?.team).toBe("custom");
    expect(out.target?.handle).toBe("alice");
    expect(out.target?.registryLocation).toBe(out.caller.registryLocation);
    expect(out.target?.scope).toBe("local");
  });
});

describe("custom-bus TAP_HOME adopts its registry's stamped root (tap-3vvf5)", () => {
  // Register stamps team.worktree_root from the caller's worktree, not the bus
  // parent; earlier custom-bus fixtures stamped dirname(bus) and hid the split.
  function customBus(dir: string, stamp: string | undefined) {
    const bus = join(dir, "custom", "bus");
    mkdirSync(bus, { recursive: true });
    const team: Record<string, string> = { name: "sample" };
    if (stamp !== undefined) team.worktree_root = stamp;
    writeFileSync(join(bus, "registry.json"), JSON.stringify({ schema: "0.20", team, seats: {} }));
    return bus;
  }

  test("unenrolled bus parent takes an existing stamp; the lock recheck agrees and drift still refuses", () => {
    const { dir, index } = work();
    seedLive(index);
    const cwd = join(dir, "elsewhere");
    const worktree = join(dir, "registered-worktree");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    const bus = customBus(dir, worktree);
    const sel = selectCaller({ cwd, env: envFor(index, { TAP_HOME: bus }) });
    expect(sel.authority).toBe("bus");
    expect(sel.rootReal).toBe(realpathSync(worktree));
    withRegistryLock(sel.registryLocation, (lock) => {
      assertSelectionCurrent(sel, lock, index);
      writeFileSync(sel.registryLocation, JSON.stringify({ schema: "0.20", team: { name: "sample", worktree_root: cwd }, seats: {} }));
      expect(errClass(() => assertSelectionCurrent(sel, lock, index))).toBe("team_moved");
    });
  });

  test("an adopted root that vanishes after selection refuses under the lock", () => {
    const { dir, index } = work();
    seedLive(index);
    const cwd = join(dir, "elsewhere");
    const worktree = join(realpathSync(dir), "registered-worktree"); // canonical, so no symlink hop masks the vanish
    mkdirSync(cwd, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    const sel = selectCaller({ cwd, env: envFor(index, { TAP_HOME: customBus(dir, worktree) }) });
    expect(sel.rootReal).toBe(worktree);
    renameSync(worktree, join(dir, "moved-worktree"));
    withRegistryLock(sel.registryLocation, (lock) => {
      expect(errClass(() => assertSelectionCurrent(sel, lock, index))).toBe("team_moved");
    });
  });

  test("an old-format custom registry refuses old_store before its stamp is read", () => {
    const { dir, index } = work();
    const other = join(dir, "other");
    const cwd = join(dir, "elsewhere");
    for (const d of [other, cwd]) mkdirSync(d, { recursive: true });
    enroll(index, other, "others");
    const bus = join(dir, "custom", "bus");
    mkdirSync(bus, { recursive: true });
    writeFileSync(join(bus, "registry.json"), JSON.stringify({ team: { name: "sample", worktree_root: other }, agents: {} }));
    expect(errClass(() => selectCaller({ cwd, env: envFor(index, { TAP_HOME: bus }) }))).toBe("old_store");
  });

  test("a missing, relative, or vanished stamp keeps the bus-parent root and its refusal", () => {
    for (const stamp of [undefined, "relative/root", "/nonexistent/tap-3vvf5-root"]) {
      const { dir, index } = work();
      seedLive(index);
      const cwd = join(dir, "elsewhere");
      mkdirSync(cwd, { recursive: true });
      const bus = customBus(dir, stamp);
      const sel = selectCaller({ cwd, env: envFor(index, { TAP_HOME: bus }) });
      expect(sel.rootReal).toBe(realpathSync(join(dir, "custom")));
      if (stamp !== undefined) {
        withRegistryLock(sel.registryLocation, (lock) => {
          expect(errClass(() => assertSelectionCurrent(sel, lock, index))).toBe("team_moved");
        });
      }
    }
  });

  test("a stamp naming another enrolled root meets bus_not_acting", () => {
    const { dir, index } = work();
    const other = join(dir, "other");
    mkdirSync(other, { recursive: true });
    enroll(index, other, "others");
    const cwd = join(dir, "elsewhere");
    mkdirSync(cwd, { recursive: true });
    const bus = customBus(dir, other);
    expect(errClass(() => selectCaller({ cwd, env: envFor(index, { TAP_HOME: bus }) }))).toBe("bus_not_acting");
  });

  test("an enrolled bus parent never consults the bus stamp; a drifted stamp still refuses team_moved", () => {
    const { dir, index } = work();
    const a = join(dir, "A");
    const decoy = join(dir, "B");
    const cwd = join(dir, "elsewhere");
    for (const d of [a, decoy, cwd]) mkdirSync(d, { recursive: true });
    enroll(index, a, "ays");
    const bus = join(a, ".tap", "bus");
    writeFileSync(join(bus, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "ays", worktree_root: decoy }, seats: {} }));
    const sel = selectCaller({ cwd, env: envFor(index, { TAP_HOME: bus }) });
    expect(sel.authority).toBe("enrolled");
    expect(sel.team).toBe("ays");
    expect(sel.registryLocation).toBe(join(a, ".tap", "team-registry.json"));

    const { dir: dir2, index: index2 } = work();
    const a2 = join(dir2, "A");
    const drift = join(dir2, "D");
    const cwd2 = join(dir2, "elsewhere");
    for (const d of [a2, drift, cwd2]) mkdirSync(d, { recursive: true });
    const loc = enroll(index2, a2, "ays", join(a2, ".tap", "bus", "registry.json"));
    writeFileSync(loc, JSON.stringify({ schema: "0.20", team: { name: "ays", worktree_root: drift }, seats: {} }));
    const sel2 = selectCaller({ cwd: cwd2, env: envFor(index2, { TAP_HOME: join(a2, ".tap", "bus") }) });
    expect(sel2.authority).toBe("enrolled");
    withRegistryLock(sel2.registryLocation, (lock) => {
      expect(errClass(() => assertSelectionCurrent(sel2, lock, index2))).toBe("team_moved");
    });
  });

  test("a seat registered before the marker existed retires after it appears", () => {
    const { dir, index } = work();
    const repo = join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    spawnSync("git", ["init", "-q", repo]);
    const bus = customBus(dir, undefined);
    writeFileSync(join(bus, "registry.json"), JSON.stringify({ schema: "0.20", seats: {} }));
    const env = { ...process.env, TAP_HOME: bus, TAP_INDEX_HOME: index, TAP_SELF: "", TMUX: "", TMUX_PANE: "" };
    const tap = (...argv: string[]) => {
      const r = Bun.spawnSync([process.execPath, MAIN, ...argv], { cwd: repo, env, stdout: "pipe", stderr: "pipe", timeout: 30000 });
      return { code: r.exitCode, err: r.stderr.toString() };
    };
    const registered = tap("in", "early", "--offline");
    expect(registered.code, registered.err).toBe(0);
    expect(JSON.parse(readFileSync(join(bus, "registry.json"), "utf8")).team.worktree_root).toBe(realpathSync(repo));
    seedLive(index);
    for (const argv of [["down", "early"], ["out", "early"], ["unregister", "early"]]) {
      const r = tap(...argv);
      expect(r.err).not.toContain("is not selection root");
      if (argv[0] !== "down") expect(r.code, r.err).toBe(0);
    }
    expect(JSON.parse(readFileSync(join(bus, "registry.json"), "utf8")).seats.early).toBeUndefined();
  }, 60000);
});

describe("detached --team and child pin", () => {
  test("parent --team X, child with --team X matches; dropping the flag from enrolled Y fails", () => {
    const { dir, index } = work();
    const x = join(dir, "X");
    const y = join(dir, "Y");
    mkdirSync(x, { recursive: true });
    mkdirSync(y, { recursive: true });
    enroll(index, x, "exes");
    enroll(index, y, "whys");
    const parent = selectCaller({ cwd: x, env: envFor(index), explicitTeam: "exes" });
    const child = selectCaller({ cwd: y, env: envFor(index), explicitTeam: "exes" });
    validateChildSelection(parent, child);
    const dropped = selectCaller({ cwd: y, env: envFor(index) });
    expect(errClass(() => validateChildSelection(parent, dropped))).toBe("identity_mismatch");
  });

  test("explicit --team and pinnedRoot that name different teams refuse; same team is not a conflict", () => {
    const { dir, index } = work();
    const x = join(dir, "X");
    const y = join(dir, "Y");
    mkdirSync(x, { recursive: true });
    mkdirSync(y, { recursive: true });
    enroll(index, x, "exes");
    enroll(index, y, "whys");
    const agree = selectCaller({ cwd: y, env: envFor(index), explicitTeam: "exes", pinnedRoot: x });
    expect(agree.team).toBe("exes");
    expect(agree.source).toBe("explicit-team");
    expect(errClass(() => selectCaller({
      cwd: y, env: envFor(index), explicitTeam: "exes", pinnedRoot: y,
    }))).toBe("selector_conflict");
  });

  test("pinnedRoot probes enrollmentAt exactly; nested pin cannot borrow parent", () => {
    const { dir, index } = work();
    const outer = join(dir, "outer");
    const inner = join(outer, "inner");
    mkdirSync(inner, { recursive: true });
    enroll(index, outer, "outer-team");
    expect(selectCaller({ cwd: inner, env: envFor(index) }).team).toBe("outer-team");
    expect(errClass(() => selectCaller({ cwd: inner, env: envFor(index), pinnedRoot: inner })))
      .toBe("unanchored_bus");
    const pinOuter = selectCaller({ cwd: inner, env: envFor(index), pinnedRoot: outer });
    expect(pinOuter.team).toBe("outer-team");
    expect(pinOuter.source).toBe("pinned-root");
    expect(errClass(() => selectCaller({
      cwd: inner, env: envFor(index), explicitTeam: "outer-team", pinnedRoot: inner,
    }))).toBe("unanchored_bus");
  });

  test("empty pinnedRoot is usage_error; it never walks or takes TAP_HOME", () => {
    const { dir, index } = work();
    const cwd = join(dir, "enrolled");
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    enroll(index, cwd, "enrolled-team");
    const bus = join(dir, "custom", ".tap", "bus");
    mkdirSync(bus, { recursive: true });
    writeFileSync(join(bus, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "env-team" }, seats: {} }));
    const env = envFor(index, { TAP_HOME: bus });
    expect(selectCaller({ cwd, env }).team).toBe("enrolled-team");
    expect(selectCaller({ cwd: elsewhere, env }).team).toBe("env-team");
    expect(errClass(() => selectCaller({ cwd, env, pinnedRoot: "" }))).toBe("usage_error");
    const truthyPinMutant = (pin: string): string => {
      if (pin) return "pin";
      return selectCaller({ cwd, env }).team;
    };
    expect(truthyPinMutant("")).toBe("enrolled-team");
  });

  test("rootReal drift refuses even when team and registryLocation match", () => {
    const { dir, index } = work();
    const x = join(dir, "X");
    mkdirSync(x, { recursive: true });
    const loc = enroll(index, x, "exes");
    const parent = selectCaller({ cwd: x, env: envFor(index) });
    const drifted: Selection = { ...parent, rootReal: join(dir, "relocated") };
    expect(parent.registryLocation).toBe(loc);
    expect(parent.registryLocationReal).toBe(realpathSync(loc));
    expect(errClass(() => validateChildSelection(parent, drifted))).toBe("identity_mismatch");
    const sourceOnly: Selection = { ...parent, source: "pinned-root" };
    validateChildSelection(parent, sourceOnly);
  });
});

describe("lock-held revalidation", () => {
  test("team_moved when enrolled root relocates under the lock", () => {
    const { dir, index } = work();
    const x = join(dir, "X");
    mkdirSync(x, { recursive: true });
    enroll(index, x, "exes");
    const sel = selectCaller({ cwd: x, env: envFor(index) });
    withRegistryLock(sel.registryLocation, (lock) => {
      assertSelectionCurrent(sel, lock, index);
      const doc = JSON.parse(readFileSync(globalRegistryPath(index), "utf8")) as {
        schema: string;
        teams: Record<string, { root: string; registry_location: string; state: string }>;
      };
      doc.teams["exes"]!.root = join(dir, "moved");
      writeFileSync(globalRegistryPath(index), JSON.stringify(doc));
      expect(errClass(() => assertSelectionCurrent(sel, lock, index))).toBe("team_moved");
    });
    const skipIndexReread = (pin: Selection, stillOnDiskRoot: string): "write" | "moved" => {
      try {
        return realpathSync(stillOnDiskRoot) === pin.rootReal ? "write" : "moved";
      } catch {
        return "moved";
      }
    };
    expect(skipIndexReread(sel, x)).toBe("write");
  });

  test("bad-schema rewrite with intact team entry is invalid_flip; two-read mutant reds", () => {
    const { dir, index } = work();
    const x = join(dir, "X");
    mkdirSync(x, { recursive: true });
    const loc = enroll(index, x, "exes");
    const sel = selectCaller({ cwd: x, env: envFor(index) });
    writeFileSync(globalRegistryPath(index), JSON.stringify({
      schema: "9.99",
      teams: {
        exes: { root: x, registry_location: loc, state: "registered" },
      },
    }));
    withRegistryLock(sel.registryLocation, (lock) => {
      expect(errClass(() => assertSelectionCurrent(sel, lock, index))).toBe("invalid_flip");
    });

    const twoReadMutant = () => {
      flipMarkerState(index);
      const r = resolveTeamFromGlobal(globalRegistryPath(index), "exes");
      return r.status === "ok"
        && r.registryLocation === sel.registryLocation
        && realpathSync(r.root) === sel.rootReal
        && realpathSync(r.registryLocation) === sel.registryLocationReal
        ? "pass"
        : "moved";
    };
    expect(twoReadMutant()).toBe("pass");
  });

  test("branded lock must name this registry; sidecar and plain literals are not proof", () => {
    const { dir, index } = work();
    const x = join(dir, "X");
    const y = join(dir, "Y");
    mkdirSync(x, { recursive: true });
    mkdirSync(y, { recursive: true });
    enroll(index, x, "exes");
    enroll(index, y, "whys");
    const sel = selectCaller({ cwd: x, env: envFor(index) });
    withRegistryLock(join(y, ".tap", "team-registry.json"), (wrong) => {
      expect(errClass(() => assertSelectionCurrent(sel, wrong, index))).toBe("lock_mismatch");
    });
    withRegistryLock(sel.registryLocation, (lock) => {
      assertSelectionCurrent(sel, lock, index);
      expect(lock.registryLocation.endsWith(".lock")).toBe(false);
    });
    expect(() => acquireRegistryLock(`${sel.registryLocation}.lock`)).toThrow(/sidecar/);
    expect(errClass(() => assertSelectionCurrent(sel, { release() {} } as unknown as RegistryLock, index)))
      .toBe("lock_required");
    // @ts-expect-error RegistryLock is branded; a plain literal is not proof
    expect(errClass(() => assertSelectionCurrent(sel, { registryLocation: sel.registryLocation, release() {} }, index)))
      .toBe("lock_required");
  });

  test("release invalidates the branded token; a second acquire revalidates", () => {
    const { dir, index } = work();
    const x = join(dir, "X");
    mkdirSync(x, { recursive: true });
    enroll(index, x, "exes");
    const sel = selectCaller({ cwd: x, env: envFor(index) });
    const lock = acquireRegistryLock(sel.registryLocation);
    if (!lock) throw new Error("acquireRegistryLock failed");
    assertSelectionCurrent(sel, lock, index);
    lock.release();
    expect(isRegistryLock(lock)).toBe(false);
    expect(errClass(() => assertSelectionCurrent(sel, lock, index))).toBe("lock_required");
    lock.release();
    expect(errClass(() => assertSelectionCurrent(sel, lock, index))).toBe("lock_required");
    const again = acquireRegistryLock(sel.registryLocation);
    if (!again) throw new Error("second acquireRegistryLock failed");
    try {
      assertSelectionCurrent(sel, again, index);
    } finally {
      again.release();
    }
  });

  test("acting registry whose name ends in .lock is acquirable; its sidecar is not", () => {
    const { dir, index } = work();
    const x = join(dir, "X");
    mkdirSync(join(x, ".tap"), { recursive: true });
    const loc = join(x, ".tap", "custom.lock");
    writeRegistry(loc, "exes", x);
    mkdirSync(join(x, ".tap", "bus"), { recursive: true });
    writeFileSync(globalRegistryPath(index), JSON.stringify({
      schema: "0.20",
      teams: { exes: { root: x, registry_location: loc, state: "registered" } },
    }));
    const held = acquireRegistryLock(loc);
    if (!held) throw new Error("expected to acquire custom.lock");
    try {
      expect(held.registryLocation).toBe(loc);
    } finally {
      held.release();
    }
    expect(() => acquireRegistryLock(`${loc}.lock`)).toThrow(/sidecar/);
  });

  test("bus-authority revalidation does not consult globalRegistry", () => {
    const { dir, index } = work();
    const cwd = join(dir, "elsewhere");
    mkdirSync(cwd, { recursive: true });
    const bus = join(dir, "custom", ".tap", "bus");
    mkdirSync(bus, { recursive: true });
    const reg = join(bus, "registry.json");
    writeFileSync(reg, JSON.stringify({ schema: "0.20", team: { name: "custom" }, seats: {} }));
    writeFileSync(globalRegistryPath(index), JSON.stringify({ schema: "0.20", teams: {} }));
    const sel = selectCaller({ cwd, env: envFor(index, { TAP_HOME: bus }) });
    expect(sel.authority).toBe("bus");
    withRegistryLock(sel.registryLocation, (lock) => {
      assertSelectionCurrent(sel, lock, index);
      writeFileSync(globalRegistryPath(index), JSON.stringify({ schema: "9.99", teams: {} }));
      assertSelectionCurrent(sel, lock, index);
    });
  });

  test("atomic swap of acting registry is team_moved; readability-only mutant reds", () => {
    const { dir, index } = work();
    const x = join(dir, "X");
    mkdirSync(x, { recursive: true });
    enroll(index, x, "exes");
    const sel = selectCaller({ cwd: x, env: envFor(index) });
    withRegistryLock(sel.registryLocation, (lock) => {
      assertSelectionCurrent(sel, lock, index);
      const tmp = `${sel.registryLocation}.next`;
      writeFileSync(tmp, JSON.stringify({
        schema: "0.20",
        team: { name: "other", worktree_root: x },
        seats: {},
        extra_legacy: true,
      }));
      renameSync(tmp, sel.registryLocation);
      expect(errClass(() => assertSelectionCurrent(sel, lock, index))).toBe("team_moved");
      const readabilityOnly = () => {
        try {
          accessSync(sel.registryLocation);
          return "pass";
        } catch {
          return "gone";
        }
      };
      expect(readabilityOnly()).toBe("pass");
    });
  });

  test("legacy acting file without worktree_root still revalidates on team.name", () => {
    const { dir, index } = work();
    const x = join(dir, "X");
    mkdirSync(x, { recursive: true });
    const loc = enroll(index, x, "exes");
    writeFileSync(loc, JSON.stringify({ schema: "0.20", team: { name: "exes" }, seats: {} }));
    const sel = selectCaller({ cwd: x, env: envFor(index) });
    withRegistryLock(sel.registryLocation, (lock) => {
      assertSelectionCurrent(sel, lock, index);
    });
  });

  test("a malformed team name or document is team_moved; a non-object team is old_store; absent team is ok", () => {
    const { dir, index } = work();
    const x = join(dir, "X");
    mkdirSync(x, { recursive: true });
    const loc = enroll(index, x, "exes");
    const sel = selectCaller({ cwd: x, env: envFor(index) });
    withRegistryLock(sel.registryLocation, (lock) => {
      writeFileSync(loc, JSON.stringify({ schema: "0.20", team: null, seats: {} }));
      expect(errClass(() => assertSelectionCurrent(sel, lock, index))).toBe("old_store");
      writeFileSync(loc, JSON.stringify({ schema: "0.20", team: { name: 42 }, seats: {} }));
      expect(errClass(() => assertSelectionCurrent(sel, lock, index))).toBe("team_moved");
      writeFileSync(loc, "[]\n");
      expect(errClass(() => assertSelectionCurrent(sel, lock, index))).toBe("team_moved");
      writeFileSync(loc, "null\n");
      expect(errClass(() => assertSelectionCurrent(sel, lock, index))).toBe("team_moved");
      writeFileSync(loc, JSON.stringify({ schema: "0.20", seats: {} }));
      assertSelectionCurrent(sel, lock, index);
    });
  });

});

describe("alias vs real registryLocation", () => {
  test("index literal is lock identity; canonical realpath is equality only", () => {
    const { dir, index } = work();
    const realRoot = join(dir, "real");
    mkdirSync(join(realRoot, ".tap"), { recursive: true });
    const realLoc = join(realRoot, ".tap", "team-registry.json");
    writeRegistry(realLoc, "alias-team", realRoot);
    mkdirSync(join(realRoot, ".tap", "bus"), { recursive: true });
    const aliasDir = join(dir, "alias-dir");
    mkdirSync(aliasDir, { recursive: true });
    const aliasLoc = join(aliasDir, "team-registry.json");
    symlinkSync(realLoc, aliasLoc);
    writeFileSync(globalRegistryPath(index), JSON.stringify({
      schema: "0.20",
      teams: {
        "alias-team": { root: realRoot, registry_location: aliasLoc, state: "registered" },
      },
    }));
    const sel = selectCaller({ cwd: realRoot, env: envFor(index) });
    expect(sel.registryLocation).toBe(aliasLoc);
    expect(sel.registryLocationReal).toBe(realpathSync(realLoc));
    expect(sel.registryLocationReal).toBe(realpathSync(aliasLoc));
    withRegistryLock(sel.registryLocation, (lock) => {
      expect(lock.registryLocation).toBe(aliasLoc);
      assertSelectionCurrent(sel, lock, index);
    });

    const other = join(dir, "other-registry.json");
    writeRegistry(other, "alias-team", realRoot);
    const doc = JSON.parse(readFileSync(globalRegistryPath(index), "utf8")) as {
      teams: Record<string, { registry_location: string }>;
    };
    doc.teams["alias-team"]!.registry_location = other;
    writeFileSync(globalRegistryPath(index), JSON.stringify({ schema: "0.20", ...doc }));
    withRegistryLock(sel.registryLocation, (lock) => {
      expect(errClass(() => assertSelectionCurrent(sel, lock, index))).toBe("team_moved");
    });
  });

  test("Bash-literal sidecar blocks Bun; canonical-lock mutant splits writers", () => {
    const { dir, index } = work();
    const realRoot = join(dir, "real");
    mkdirSync(join(realRoot, ".tap"), { recursive: true });
    const realLoc = join(realRoot, ".tap", "team-registry.json");
    writeRegistry(realLoc, "alias-team", realRoot);
    mkdirSync(join(realRoot, ".tap", "bus"), { recursive: true });
    const aliasLoc = join(dir, "alias-dir", "team-registry.json");
    mkdirSync(dirname(aliasLoc), { recursive: true });
    symlinkSync(realLoc, aliasLoc);
    writeFileSync(globalRegistryPath(index), JSON.stringify({
      schema: "0.20",
      teams: {
        "alias-team": { root: realRoot, registry_location: aliasLoc, state: "registered" },
      },
    }));
    const sel = selectCaller({ cwd: realRoot, env: envFor(index) });
    expect(sel.registryLocation).toBe(aliasLoc);
    expect(realpathSync(aliasLoc)).not.toBe(aliasLoc);

    const bashLock = acquireRegistryLock(aliasLoc);
    if (!bashLock) throw new Error("Bash-literal acquireRegistryLock failed");
    try {
      expect(acquireRegistryLock(sel.registryLocation, 80)).toBeNull();

      const canonicalLockMutant = () => acquireRegistryLock(realpathSync(aliasLoc));
      const split = canonicalLockMutant();
      expect(split).not.toBeNull();
      if (!split) throw new Error("canonical-lock mutant was expected to succeed");
      try {
        expect(errClass(() => assertSelectionCurrent(sel, split, index))).toBe("lock_mismatch");
      } finally {
        split.release();
      }
    } finally {
      bashLock.release();
    }
  });

  test("enrolled bus follows its root while the registry literal remains lock identity", () => {
    const { dir, index } = work();
    const realRoot = join(dir, "real");
    mkdirSync(join(realRoot, ".tap", "bus"), { recursive: true });
    const realLoc = join(realRoot, ".tap", "team-registry.json");
    writeRegistry(realLoc, "alias-team", realRoot);
    const relay = join(dir, "relay");
    mkdirSync(relay, { recursive: true });
    const aliasLoc = join(relay, "registry.json");
    symlinkSync(realLoc, aliasLoc);
    writeFileSync(globalRegistryPath(index), JSON.stringify({
      schema: "0.20",
      teams: {
        "alias-team": { root: realRoot, registry_location: aliasLoc, state: "registered" },
      },
    }));
    const sel = selectCaller({ cwd: realRoot, env: envFor(index) });
    expect(sel.registryLocation).toBe(aliasLoc);
    expect(sel.busHome).toBe(realpathSync(join(realRoot, ".tap", "bus")));
    // The retired registry-literal rule splits the bus away from root fences.
    const fromLiteralMutant = realpathSync(relay);
    expect(fromLiteralMutant).not.toBe(sel.busHome);
    // Path-only consumers match Python's symlink-resolving helper.
    expect(busHomeForRegistry(aliasLoc)).toBe(sel.busHome);
  });
});

describe("TAP_HOME vs acting bus of an enrolled root", () => {
  test("non-acting alternate bus of an enrolled root is bus_not_acting", () => {
    const { dir, index } = work();
    const cwd = join(dir, "elsewhere");
    mkdirSync(cwd, { recursive: true });
    const enrolled = join(dir, "enrolled");
    mkdirSync(enrolled, { recursive: true });
    enroll(index, enrolled, "home-team");
    const alternate = join(enrolled, ".tap", "alternate");
    mkdirSync(alternate, { recursive: true });
    writeFileSync(join(alternate, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "home-team" }, seats: {} }));
    expect(errClass(() => selectCaller({
      cwd, env: envFor(index, { TAP_HOME: alternate }),
    }))).toBe("bus_not_acting");
  });

  test("unindexed custom TAP_HOME remains bus authority", () => {
    const { dir, index } = work();
    const cwd = join(dir, "elsewhere");
    mkdirSync(cwd, { recursive: true });
    const bus = join(dir, "custom", ".tap", "bus");
    mkdirSync(bus, { recursive: true });
    writeFileSync(join(bus, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "custom" }, seats: {} }));
    writeFileSync(globalRegistryPath(index), JSON.stringify({ schema: "0.20", teams: {} }));
    const sel = selectCaller({ cwd, env: envFor(index, { TAP_HOME: bus }) });
    expect(sel.authority).toBe("bus");
    expect(sel.team).toBe("custom");
  });

  test("bus authority refuses a registry symlink retargeted after selection", () => {
    const { dir, index } = work();
    const cwd = join(dir, "elsewhere");
    mkdirSync(cwd, { recursive: true });
    const bus = join(dir, "custom", ".tap", "bus");
    mkdirSync(bus, { recursive: true });
    // Two files that agree on team name and root: only the resolved target differs.
    const first = join(dir, "first-registry.json");
    const second = join(dir, "second-registry.json");
    for (const file of [first, second]) {
      writeFileSync(file, JSON.stringify({ schema: "0.20", team: { name: "custom" }, seats: {} }));
    }
    const link = join(bus, "registry.json");
    symlinkSync(first, link);
    writeFileSync(globalRegistryPath(index), JSON.stringify({ schema: "0.20", teams: {} }));
    const sel = selectCaller({ cwd, env: envFor(index, { TAP_HOME: bus }) });
    expect(sel.authority).toBe("bus");
    expect(basename(sel.registryLocation)).toBe("registry.json");
    expect(sel.registryLocationReal).toBe(realpathSync(first));
    expect(sel.registryLocation).not.toBe(sel.registryLocationReal);

    // Control: an un-retargeted bus pin still passes.
    withRegistryLock(sel.registryLocation, (lock) => {
      assertSelectionCurrent(sel, lock, index);
    });

    rmSync(link);
    symlinkSync(second, link);
    withRegistryLock(sel.registryLocation, (lock) => {
      expect(errClass(() => assertSelectionCurrent(sel, lock, index))).toBe("team_moved");
    });
  });
});

describe("strict UTF-8 at the acting-registry reader doors", () => {
  test("bus team-name door: an invalid byte falls back to the root basename", () => {
    const { dir, index } = work();
    const cwd = join(dir, "elsewhere");
    mkdirSync(cwd, { recursive: true });
    const bus = join(dir, "custom", ".tap", "bus");
    mkdirSync(bus, { recursive: true });
    // Raw invalid byte, not U+FFFD: a lax decode binds the mangled name, and
    // the difference between the two answers is the whole discriminator.
    writeFileSync(
      join(bus, "registry.json"),
      Buffer.concat([
        Buffer.from('{"schema":"0.20","team":{"name":"caf'),
        Buffer.from([0xe9]),
        Buffer.from('x"},"seats":{}}'),
      ]),
    );
    writeFileSync(globalRegistryPath(index), JSON.stringify({ schema: "0.20", teams: {} }));
    const sel = selectCaller({ cwd, env: envFor(index, { TAP_HOME: bus }) });
    expect(sel.authority).toBe("bus");
    expect(sel.team).toBe("custom");
    expect(sel.team).not.toContain("\ufffd");

    // A valid multibyte name still binds: the line is decodability, not ASCII.
    writeFileSync(join(bus, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "café" }, seats: {} }));
    expect(selectCaller({ cwd, env: envFor(index, { TAP_HOME: bus }) }).team).toBe("café");

    // A file-leading BOM is not stripped by either era's reader: the bytes go
    // to JSON.parse intact, which refuses, and the door falls back to the
    // root basename under bus authority — same shape as the invalid byte.
    writeFileSync(
      join(bus, "registry.json"),
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('{"schema":"0.20","team":{"name":"bom-team"},"seats":{}}'),
      ]),
    );
    const bomSel = selectCaller({ cwd, env: envFor(index, { TAP_HOME: bus }) });
    expect(bomSel.authority).toBe("bus");
    expect(bomSel.team).toBe("custom");
    expect(bomSel.team).not.toContain("\ufffd");
  });

  test("lock-held revalidation door: an invalid byte anywhere is team_moved", () => {
    const { dir, index } = work();
    const x = join(dir, "X");
    mkdirSync(x, { recursive: true });
    enroll(index, x, "exes");
    const sel = selectCaller({ cwd: x, env: envFor(index) });
    const raw = readFileSync(sel.registryLocation);
    // Identity fields survive; an UNRELATED note field carries the byte, so
    // only a strict decode of the whole document can tell this from the original.
    const invalid = Buffer.concat([
      Buffer.from('{"note":"caf'),
      Buffer.from([0xe9]),
      Buffer.from('r","'),
      raw.subarray(2),
    ]);
    writeFileSync(sel.registryLocation, invalid);
    withRegistryLock(sel.registryLocation, (lock) => {
      expect(errClass(() => assertSelectionCurrent(sel, lock, index))).toBe("team_moved");
    });
    expect(readFileSync(sel.registryLocation)).toEqual(invalid);

    // The same note as valid UTF-8 revalidates exactly like the original.
    writeFileSync(sel.registryLocation, Buffer.concat([
      Buffer.from('{"note":"café r","'),
      raw.subarray(2),
    ]));
    withRegistryLock(sel.registryLocation, (lock) => {
      assertSelectionCurrent(sel, lock, index);
    });

    // A leading BOM is preserved by the strict reader, so JSON.parse refuses
    // it too — the same answer the lax reader already gave.
    writeFileSync(sel.registryLocation, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), raw]));
    withRegistryLock(sel.registryLocation, (lock) => {
      expect(errClass(() => assertSelectionCurrent(sel, lock, index))).toBe("team_moved");
    });
  });
});

describe("spoolTeamName (the detector authority team, M6 U2)", () => {
  test("post-flip an enrolled bus answers the global enrollment key, never the acting file's claim", () => {
    const { dir, index } = work();
    const root = join(dir, "realname");
    const registry = enroll(index, root, "realname");
    // The acting file lies about its own name; the key comes from the index.
    writeRegistry(registry, "DECOY", root);
    expect(spoolTeamName(join(root, ".tap", "bus"), index)).toBe("realname");
  });

  test("post-flip a genuinely unenrolled bus answers its root basename, not the decoy claim", () => {
    const { dir, index } = work();
    const root = join(dir, "custom-bus");
    mkdirSync(join(root, ".tap", "bus"), { recursive: true });
    // Live marker, empty enrollment: the basename arm is the only answer.
    writeFileSync(globalRegistryPath(index), JSON.stringify({ schema: "0.20", migrated: {}, teams: {} }));
    const decoy = join(root, "registry.json");
    writeRegistry(decoy, "DECOY", root);
    expect(spoolTeamName(join(root, ".tap", "bus"), index)).toBe(basename(root));
  });

  test("an enrolled row with an unreadable registry_location fails closed, never the basename arm", () => {
    const { dir, index } = work();
    const root = join(dir, "realname");
    mkdirSync(join(root, ".tap", "bus"), { recursive: true });
    // The row CLAIMS this root, but its acting registry is gone: an
    // unverifiable claim is not genuine unenrollment.
    writeFileSync(globalRegistryPath(index), JSON.stringify({
      schema: "0.20", migrated: {},
      teams: { realname: { root, state: "registered", registry_location: join(dir, "gone.json") } },
    }));
    const decoy = join(root, "registry.json");
    writeRegistry(decoy, "DECOY", root);
    expect(spoolTeamName(join(root, ".tap", "bus"), index)).toBe("");
  });

  test("a bare enrolled row (no registry_location) fails closed, never the basename arm", () => {
    const { dir, index } = work();
    const root = join(dir, "bare-row");
    mkdirSync(join(root, ".tap", "bus"), { recursive: true });
    writeFileSync(globalRegistryPath(index), JSON.stringify({
      schema: "0.20", migrated: {},
      teams: { bare: { root, state: "registered" } },
    }));
    expect(spoolTeamName(join(root, ".tap", "bus"), index)).toBe("");
  });

  test("an unreadable (mode-000) registry_location fails closed, never the key or basename arm", () => {
    const { dir, index } = work();
    const root = join(dir, "realname");
    mkdirSync(join(root, ".tap", "bus"), { recursive: true });
    const locked = join(dir, "locked-registry.json");
    writeFileSync(locked, JSON.stringify({ schema: "0.20", team: { name: "realname" }, seats: {} }));
    chmodSync(locked, 0o000);
    try {
      writeFileSync(globalRegistryPath(index), JSON.stringify({
        schema: "0.20", migrated: {},
        teams: { realname: { root, state: "registered", registry_location: locked } },
      }));
      // A regular file that stat() sees but no one can read is an
      // UNVERIFIABLE claim: empty, not the key and not the basename.
      expect(spoolTeamName(join(root, ".tap", "bus"), index)).toBe("");
    } finally {
      chmodSync(locked, 0o644);
    }
  });

  test("an absent machine index fails closed, never the acting file's claim or the basename", () => {
    const { dir, index } = work();
    const root = join(dir, "legacy");
    mkdirSync(join(root, ".tap", "bus"), { recursive: true });
    writeRegistry(join(root, ".tap", "bus", "registry.json"), "legacy-team", root);
    expect(spoolTeamName(join(root, ".tap", "bus"), index)).toBe("");
  });

  test("an unreadable machine index fails closed", () => {
    const { dir, index } = work();
    writeFileSync(globalRegistryPath(index), "unreadable JSON");
    const bus = join(dir, "x", ".tap", "bus");
    mkdirSync(bus, { recursive: true });
    expect(spoolTeamName(bus, index)).toBe("");
  });
});

describe("old-format acting registries refuse as old_store (C4a)", () => {
  test("selection refuses an old acting file; a team-less current file and an absent file do not", () => {
    const { dir, index } = work();
    const root = join(dir, "A");
    mkdirSync(root, { recursive: true });
    const reg = enroll(index, root, "alpha");
    writeFileSync(reg, JSON.stringify({ schema: "0.20", seats: {} }));
    expect(selectCaller({ cwd: root, env: envFor(index) }).team).toBe("alpha");
    for (const old of [{}, { seats: {} }, { schema: "0.20", agents: {} }, { schema: "0.20", seats: {}, team: "alpha" }]) {
      writeFileSync(reg, JSON.stringify(old));
      expect(errClass(() => selectCaller({ cwd: root, env: envFor(index) }))).toBe("old_store");
      expect(errClass(() => selectCaller({ cwd: dir, env: envFor(index), explicitTeam: "alpha" }))).toBe("old_store");
    }
  });

  test("under-lock revalidation refuses a file that turned old after selection", () => {
    const { dir, index } = work();
    const root = join(dir, "A");
    mkdirSync(root, { recursive: true });
    const reg = enroll(index, root, "alpha");
    const sel = selectCaller({ cwd: root, env: envFor(index) });
    withRegistryLock(sel.registryLocation, lock => {
      assertSelectionCurrent(sel, lock, index);
      // No team object: the old early return accepted this document unexamined.
      writeFileSync(reg, JSON.stringify({ agents: {} }));
      expect(errClass(() => assertSelectionCurrent(sel, lock, index))).toBe("old_store");
    });
  });
});
