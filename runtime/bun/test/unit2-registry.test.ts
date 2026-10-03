// Unit 2 — identity: machine index, acting registry, seat rows, self-resolution.
//
// This is the interop-critical unit. The oracle's two interop arms run bash tap
// against rows THIS code wrote and vice versa, so a row-shape divergence here
// fails them while every payload-format test stays green.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  flipMarkerState, globalRegistryPath, enrolledTeamNameForRoot, resolveTeamFromGlobal,
  resolveEnrolledTeamRoot, resolvePayloadById, enrolledTeams,
} from "../src/index-home";
import {
  loadRegistry, saveRegistry, seatMap, currentInstance, mintInstanceId, ensureSeatInstance,
  resolveHandleByPane, pyJson, SCHEMA,
} from "../src/registry";
import { containerRefusal, resolveBus } from "../src/bushome";
import { Bus, BUS_AUTHORITY_MARKER } from "../src/bus";
import { requireActingRegistry, resolveContext, TapError } from "../src/context";
import { removeScratchTree } from "./support/scratch";

let root: string;
const env = (over: Record<string, string | undefined>) => ({
  ...process.env,
  TAP_INDEX_HOME: join(root, "index"),
  TAP_SESSION_MANIFEST: join(root, "sessions.json"),
  OPENCODE_DB_PATH: join(root, "opencode.db"),
  TAP_VERSION_SEEN_PATH: join(root, "version-seen.json"),
  ...over,
});

function seedIndex(index: string, wt: string, team: string) {
  mkdirSync(index, { recursive: true });
  mkdirSync(join(wt, ".tap"), { recursive: true });
  writeFileSync(globalRegistryPath(index), JSON.stringify({
    migrated: {}, schema: "0.20",
    teams: { [team]: {
      enrolled_at: "2026-08-23T00:00:00Z",
      registry_location: join(wt, ".tap", "team-registry.json"),
      root: wt, state: "registered",
    } },
  }));
  writeFileSync(join(wt, ".tap", "team-registry.json"), JSON.stringify({
    schema: "0.20", team: { name: team, worktree_root: wt }, seats: {},
  }));
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "tap-bun-u2.")); });
afterEach(() => { removeScratchTree(root); });

describe("flip marker (TAP_INDEX_HOME is the isolation primitive)", () => {
  test("absent when there is no global-registry.json", () => {
    expect(flipMarkerState(join(root, "empty"))).toBe("absent");
  });

  test("live for schema 0.20 with a dict teams map", () => {
    const idx = join(root, "i"); seedIndex(idx, join(root, "t"), "t");
    expect(flipMarkerState(idx)).toBe("live");
  });

  test("live when teams is omitted entirely — an absent key is valid", () => {
    const idx = join(root, "i2"); mkdirSync(idx, { recursive: true });
    writeFileSync(globalRegistryPath(idx), JSON.stringify({ schema: "0.20" }));
    expect(flipMarkerState(idx)).toBe("live");
  });

  test("invalid — never legacy — when teams is present but not an object", () => {
    const idx = join(root, "i3"); mkdirSync(idx, { recursive: true });
    writeFileSync(globalRegistryPath(idx), JSON.stringify({ schema: "0.20", teams: [] }));
    expect(flipMarkerState(idx)).toBe("invalid");
  });

  test("invalid on a wrong schema and on unparseable JSON", () => {
    const idx = join(root, "i4"); mkdirSync(idx, { recursive: true });
    writeFileSync(globalRegistryPath(idx), JSON.stringify({ schema: "0.19" }));
    expect(flipMarkerState(idx)).toBe("invalid");
    writeFileSync(globalRegistryPath(idx), "{not json");
    expect(flipMarkerState(idx)).toBe("invalid");
  });

  test("resolveEnrolledTeamRoot follows marker-selected index authority", () => {
    const live = join(root, "live-idx");
    const wt = join(root, "live-wt");
    seedIndex(live, wt, "alpha");
    expect(resolveEnrolledTeamRoot("alpha", live)).toEqual({ kind: "ok", root: wt });
    expect(resolveEnrolledTeamRoot("ghost", live).kind).toBe("missing");

    // F2b: no machine index means no enrolled team; a teams.json naming a
    // live root is never read.
    const absent = join(root, "absent-idx");
    mkdirSync(absent, { recursive: true });
    const legacyWt = join(root, "legacy-wt");
    mkdirSync(legacyWt, { recursive: true });
    writeFileSync(join(absent, "teams.json"), JSON.stringify({ teams: { beta: { root: legacyWt } } }));
    expect(flipMarkerState(absent)).toBe("absent");
    expect(resolveEnrolledTeamRoot("beta", absent)).toEqual({ kind: "absent" });

    const broken = join(root, "broken-idx");
    mkdirSync(broken, { recursive: true });
    writeFileSync(globalRegistryPath(broken), JSON.stringify({ schema: "0.20", teams: [] }));
    writeFileSync(join(broken, "teams.json"), JSON.stringify({ teams: { beta: { root: legacyWt } } }));
    expect(flipMarkerState(broken)).toBe("invalid");
    expect(resolveEnrolledTeamRoot("beta", broken)).toEqual({ kind: "invalid" });

    const liveGone = join(root, "live-gone-idx");
    const goneWt = join(root, "gone-wt");
    seedIndex(liveGone, goneWt, "gamma");
    rmSync(goneWt, { recursive: true, force: true });
    expect(resolveEnrolledTeamRoot("gamma", liveGone)).toEqual({ kind: "not_authoritative", status: "unreachable" });

    const hist = join(root, "hist-idx");
    const histWt = join(root, "hist-wt");
    seedIndex(hist, histWt, "old");
    const g = JSON.parse(readFileSync(globalRegistryPath(hist), "utf8")) as { teams: Record<string, { state?: string }> };
    g.teams.old!.state = "historical";
    writeFileSync(globalRegistryPath(hist), JSON.stringify(g));
    expect(resolveEnrolledTeamRoot("old", hist)).toEqual({ kind: "not_authoritative", status: "historical" });
  });

  test("resolvePayloadById skips malformed live entries and never reads teams.json", () => {
    const idx = join(root, "byid-idx");
    mkdirSync(idx, { recursive: true });
    const wt = join(root, "byid-wt");
    const bus = join(wt, ".tap", "bus");
    mkdirSync(join(bus, "payloads"), { recursive: true });
    const id = "fable-20260831T013530Z-byidarray0001";
    writeFileSync(join(bus, "payloads", `${id}.md`), "body\n");
    // F2b: an absent marker answers none even when teams.json names the bus.
    writeFileSync(join(idx, "teams.json"), JSON.stringify({ teams: { beta: { root: wt } } }));
    expect(flipMarkerState(idx)).toBe("absent");
    expect(resolvePayloadById(id, idx)).toEqual({ kind: "none" });

    writeFileSync(globalRegistryPath(idx), JSON.stringify({
      schema: "0.20",
      teams: { scalar: "nope", numbered: { root: 1 }, empty: { root: "" }, listed: [{ root: wt }] },
    }));
    expect(flipMarkerState(idx)).toBe("live");
    expect(resolvePayloadById(id, idx)).toEqual({ kind: "none" });

    writeFileSync(globalRegistryPath(idx), JSON.stringify({ schema: "0.20", teams: { beta: { root: wt } } }));
    expect(resolvePayloadById(id, idx)).toEqual({ kind: "one", path: realpathSync(join(bus, "payloads", `${id}.md`)) });
  });

  test("TAP_INDEX_HOME wins over $HOME — this is what keeps a test off production", () => {
    const idx = join(root, "i5"); seedIndex(idx, join(root, "t5"), "t5");
    expect(globalRegistryPath(idx)).toBe(join(idx, "global-registry.json"));
  });
});

describe("acting registry selection follows the migration marker", () => {
  function busFixture() {
    const wt = join(root, "authority");
    const bus = join(wt, ".tap", "bus");
    const sibling = join(wt, ".tap", "team-registry.json");
    const busRegistry = join(bus, "registry.json");
    const index = join(root, "authority-index");
    mkdirSync(join(bus, "payloads"), { recursive: true });
    mkdirSync(join(bus, "receipts"), { recursive: true });
    mkdirSync(index, { recursive: true });
    // Born live (F1): the worktree is an unenrolled bus under an empty index.
    writeFileSync(globalRegistryPath(index), JSON.stringify({ schema: "0.20", teams: {} }));
    return { wt, bus, sibling, busRegistry, index };
  }

  test("an unenrolled bus registry wins over a conflicting sibling", () => {
    const f = busFixture();
    writeFileSync(f.busRegistry, JSON.stringify({ schema: "0.20", team: { name: "bus-team" }, seats: {} }));
    writeFileSync(f.sibling, JSON.stringify({ schema: "0.20", team: { name: "sibling-team" }, seats: {} }));

    const ctx = resolveContext(f.wt, env({ TAP_HOME: f.bus, TAP_INDEX_HOME: f.index }));
    expect(ctx.registryPath).toBe(join(realpathSync(f.bus), "registry.json"));
    expect(ctx.team).toBe("bus-team");
  });

  test("an unenrolled bus without a registry refuses instead of borrowing the sibling", () => {
    const f = busFixture();
    writeFileSync(f.sibling, JSON.stringify({ schema: "0.20", team: { name: "sibling-team" }, seats: {} }));

    const ctx = resolveContext(f.wt, env({ TAP_HOME: f.bus, TAP_INDEX_HOME: f.index }));
    expect(ctx.registryPath).toBe(join(realpathSync(f.bus), "registry.json"));
    expect(() => requireActingRegistry(ctx, 2)).toThrow(TapError);
    try {
      requireActingRegistry(ctx, 2);
    } catch (error) {
      expect((error as TapError).errorClass).toBe("unanchored_bus");
    }
  });

  test("an acting registry must be a regular file, following symlinks", () => {
    const f = busFixture(), directory = join(root, "registry-directory");
    mkdirSync(f.busRegistry); mkdirSync(directory);
    let ctx = resolveContext(f.wt, env({ TAP_HOME: f.bus, TAP_INDEX_HOME: f.index }));
    expect(() => requireActingRegistry(ctx, 2)).toThrow(TapError);
    expect(loadRegistry(f.busRegistry)).toEqual({});
    rmSync(f.busRegistry, { recursive: true }); symlinkSync(directory, f.busRegistry);
    ctx = resolveContext(f.wt, env({ TAP_HOME: f.bus, TAP_INDEX_HOME: f.index }));
    expect(() => requireActingRegistry(ctx, 2)).toThrow(TapError);
    expect(loadRegistry(f.busRegistry)).toEqual({});
    rmSync(f.busRegistry); writeFileSync(f.busRegistry, JSON.stringify({ schema: "0.20", team: { name: "bus-team" }, seats: {} }));
    ctx = resolveContext(f.wt, env({ TAP_HOME: f.bus, TAP_INDEX_HOME: f.index }));
    expect(() => requireActingRegistry(ctx, 2)).not.toThrow();
    expect(loadRegistry(f.busRegistry)).toHaveProperty("team.name", "bus-team");
  });

  test("flip-live stored registry location wins over both local files", () => {
    const f = busFixture();
    const stored = join(root, "stored-registry.json");
    writeFileSync(f.busRegistry, JSON.stringify({ schema: "0.20", team: { name: "bus-team" }, seats: {} }));
    writeFileSync(f.sibling, JSON.stringify({ schema: "0.20", team: { name: "sibling-team" }, seats: {} }));
    writeFileSync(stored, JSON.stringify({ schema: "0.20", team: { name: "stored-team" }, seats: {} }));
    writeFileSync(globalRegistryPath(f.index), JSON.stringify({
      schema: "0.20",
      teams: { enrolled: { root: f.wt, registry_location: stored, state: "registered" } },
    }));

    const ctx = resolveContext(f.wt, env({ TAP_HOME: f.bus, TAP_INDEX_HOME: f.index }));
    expect(ctx.registryPath).toBe(stored);
    expect(ctx.team).toBe("enrolled");
  });

  test("flip-live stored registry location keeps the index literal across a symlink", () => {
    const f = busFixture();
    const realStored = join(root, "stored-registry.json");
    const aliasStored = join(root, "alias-stored.json");
    writeFileSync(realStored, JSON.stringify({ schema: "0.20", team: { name: "stored-team" }, seats: {} }));
    symlinkSync(realStored, aliasStored);
    writeFileSync(globalRegistryPath(f.index), JSON.stringify({
      schema: "0.20",
      teams: { enrolled: { root: f.wt, registry_location: aliasStored, state: "registered" } },
    }));

    const ctx = resolveContext(f.wt, env({ TAP_HOME: f.bus, TAP_INDEX_HOME: f.index }));
    expect(ctx.registryPath).toBe(aliasStored);
    expect(ctx.registryPath).not.toBe(realpathSync(aliasStored));
    expect(ctx.team).toBe("enrolled");
  });
});

describe("team resolution through the index", () => {
  test("resolves a registered team to its root and stored registry location", () => {
    const idx = join(root, "i"), wt = join(root, "myteam");
    seedIndex(idx, wt, "myteam");
    const r = resolveTeamFromGlobal(globalRegistryPath(idx), "myteam");
    expect(r.status).toBe("ok");
    expect(r.root).toBe(wt);
    expect(r.registryLocation).toBe(join(wt, ".tap", "team-registry.json"));
  });

  test("missing for an unknown team", () => {
    const idx = join(root, "i"); seedIndex(idx, join(root, "a"), "a");
    expect(resolveTeamFromGlobal(globalRegistryPath(idx), "nope").status).toBe("missing");
  });

  test("stored registry reachability requires a regular file", () => {
    const idx = join(root, "kind-index"), wt = join(root, "kind-team"), directory = join(root, "registry-directory");
    seedIndex(idx, wt, "kind-team");
    const registry = join(wt, ".tap", "team-registry.json");
    mkdirSync(directory);
    rmSync(registry); mkdirSync(registry);
    expect(resolveTeamFromGlobal(globalRegistryPath(idx), "kind-team").status).toBe("unreachable");
    expect(enrolledTeams(idx)).toEqual([]);
    rmSync(registry, { recursive: true }); symlinkSync(directory, registry);
    expect(resolveTeamFromGlobal(globalRegistryPath(idx), "kind-team").status).toBe("unreachable");
    expect(enrolledTeams(idx)).toEqual([]);
    rmSync(registry); writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "kind-team" }, seats: {} }));
    expect(resolveTeamFromGlobal(globalRegistryPath(idx), "kind-team").status).toBe("ok");
    expect(enrolledTeams(idx)).toEqual([{ team: "kind-team", root: wt, registryLocation: registry }]);
  });

  test("cwd identity comes from the global root key, not from bus team.name", () => {
    // A decoy team.name in the acting file must not win: post-flip identity is
    // the enrollment key, or a relocated registry would be resolved by its lie.
    const idx = join(root, "i"), wt = join(root, "realname");
    seedIndex(idx, wt, "realname");
    writeFileSync(join(wt, ".tap", "team-registry.json"), JSON.stringify({
      schema: "0.20", team: { name: "DECOY", worktree_root: wt }, seats: {},
    }));
    expect(enrolledTeamNameForRoot(wt, idx)).toEqual({ status: "ok", name: "realname" });
  });

  test("an unenrolled root reports missing rather than guessing its basename", () => {
    const idx = join(root, "i"); seedIndex(idx, join(root, "a"), "a");
    expect(enrolledTeamNameForRoot(join(root, "stranger"), idx).status).toBe("missing");
  });
});

describe("bus resolution (CONTRACT §Bus layout, resolution order)", () => {
  test("TAP_HOME set wins, and reports rule=env", () => {
    const b = join(root, "custom");
    expect(resolveBus(root, env({ TAP_HOME: b }))).toEqual({ home: join(realpathSync(root), "custom"), rule: "env" });
  });

  test("an existing .tap/bus is the dotdir rule", () => {
    mkdirSync(join(root, ".tap", "bus"), { recursive: true });
    expect(resolveBus(root, env({ TAP_HOME: undefined }))).toEqual({
      home: join(root, ".tap", "bus"), rule: "dotdir",
    });
  });

  test("an empty tmp/tap does not select a bus", () => {
    mkdirSync(join(root, "tmp", "tap"), { recursive: true });
    expect(resolveBus(root, env({ TAP_HOME: undefined }))).toEqual({
      home: join(root, ".tap", "bus"), rule: "default",
    });
  });

  test("neither present defaults to .tap/bus, created on demand", () => {
    expect(resolveBus(root, env({ TAP_HOME: undefined }))).toEqual({
      home: join(root, ".tap", "bus"), rule: "default",
    });
  });

  test("dotdir wins over legacy when both somehow exist", () => {
    mkdirSync(join(root, ".tap", "bus"), { recursive: true });
    mkdirSync(join(root, "tmp", "tap"), { recursive: true });
    expect(resolveBus(root, env({ TAP_HOME: undefined })).rule).toBe("dotdir");
  });
});

describe("seat rows (the shape bash tap must be able to read)", () => {
  let wt: string, reg: string;
  beforeEach(() => {
    wt = join(root, "team"); reg = join(wt, ".tap", "team-registry.json");
    seedIndex(join(root, "i"), wt, "team");
  });

  test("instance ids are <handle>|<16 hex> and are hidden bookkeeping, never a handle", () => {
    const i = mintInstanceId("seat-a");
    expect(i).toMatch(/^seat-a\|[0-9a-f]{16}$/);
    expect(mintInstanceId("seat-a")).not.toBe(i);
  });

  test("ensureSeatInstance mints once and is stable across a rebind", () => {
    const seat: Record<string, unknown> = {};
    const first = ensureSeatInstance(seat, "h");
    expect(ensureSeatInstance(seat, "h")).toBe(first);
  });

  test("currentInstance reads back what was minted, and is empty for a stranger", () => {
    const seat: Record<string, unknown> = { pane: "x:0.0" };
    ensureSeatInstance(seat, "x");
    mkdirSync(join(wt, ".tap"), { recursive: true });
    saveRegistry(reg, { schema: SCHEMA, team: { name: "team" }, seats: { x: seat } });
    expect(currentInstance(reg, "x")).toBe(seatMap(loadRegistry(reg)).x!.instance as string);
    expect(currentInstance(reg, "ghost")).toBe("");
  });

  test("seatMap reads seats only: an agents map is never a roster (readers refuse old_store first)", () => {
    expect(seatMap({ seats: { a: { pane: "p" } } })).toHaveProperty("a");
    expect(seatMap({ agents: { b: { pane: "p" } } })).toEqual({});
    expect(seatMap({ seats: [], agents: { b: { pane: "p" } } })).toEqual({});
    expect(seatMap({})).toEqual({});
  });

  test("saveRegistry preserves unknown top-level sections", () => {
    const doc = loadRegistry(reg);
    (doc as Record<string, unknown>).future_section = { keep: "me" };
    saveRegistry(reg, doc);
    expect(loadRegistry(reg)).toHaveProperty("future_section");
    expect(loadRegistry(reg).schema).toBe(SCHEMA);
  });
});

describe("self-resolution by pane (identity is observational, never asserted)", () => {
  let wt: string, reg: string;
  const seat = (over: Record<string, unknown>) => ({
    delivery: "pane", harness: "claude", status: "active", ...over,
  });

  beforeEach(() => {
    wt = join(root, "team"); reg = join(wt, ".tap", "team-registry.json");
    seedIndex(join(root, "i"), wt, "team");
  });

  const write = (seats: Record<string, unknown>) =>
    writeFileSync(reg, JSON.stringify({ schema: "0.20", team: { name: "team", worktree_root: wt }, seats }));

  test("matches on pane_id under the current server generation", () => {
    write({ me: seat({ pane: "me:0.0", pane_id: "%7", server_epoch: "srv:1:2" }) });
    expect(resolveHandleByPane(reg, "%7", "me:0.0", "srv:1:2")).toEqual({ handle: "me", pane: "me:0.0", paneId: "%7" });
  });

  test("a row stamped under a PRIOR generation never confers identity", () => {
    // pane ids are unique only within one tmux server lifetime; a recycled id
    // matching a retired row is coincidence, not identity.
    write({ me: seat({ pane: "me:0.0", pane_id: "%7", server_epoch: "srv:OLD:1" }) });
    expect(resolveHandleByPane(reg, "%7", "me:0.0", "srv:1:2")).toBeNull();
  });

  test("an unstamped row never confers identity (tap-zk1w)", () => {
    // no generation claim binds the pane id to no server lifetime, so a
    // recycled id agreeing with it is not identity.
    write({ me: seat({ pane: "me:0.0", pane_id: "%7" }) });
    expect(resolveHandleByPane(reg, "%7", "me:0.0", "srv:1:2")).toBeNull();
    write({ me: seat({ pane: "me:0.0" }) });
    expect(resolveHandleByPane(reg, "%7", "me:0.0", "srv:1:2")).toBeNull();
  });

  test("a row with no pane_id falls back to matching the pane ADDRESS", () => {
    write({ me: seat({ pane: "me:0.0", server_epoch: "srv:1:2" }) });
    expect(resolveHandleByPane(reg, "%7", "me:0.0", "srv:1:2")?.handle).toBe("me");
  });

  test("a suspended seat is not an identity", () => {
    write({ me: seat({ pane: "me:0.0", pane_id: "%7", status: "suspended", server_epoch: "srv:1:2" }) });
    expect(resolveHandleByPane(reg, "%7", "me:0.0", "srv:1:2")).toBeNull();
  });

  test("an unregistered pane resolves to nothing — the caller turns that into exit 2", () => {
    write({ other: seat({ pane: "other:0.0", pane_id: "%1", server_epoch: "srv:1:2" }) });
    expect(resolveHandleByPane(reg, "%99", "ghost:0.0", "srv:1:2")).toBeNull();
  });

  test("resolution is deterministic when two rows could match, taking the first by handle", () => {
    write({
      bbb: seat({ pane: "p:0.0", pane_id: "%7", server_epoch: "srv:1:2" }),
      aaa: seat({ pane: "p:0.0", pane_id: "%7", server_epoch: "srv:1:2" }),
    });
    expect(resolveHandleByPane(reg, "%7", "p:0.0", "srv:1:2")?.handle).toBe("aaa");
  });
});


describe("registry serialization is python-byte-compatible", () => {
  // These two shapes never appear in an ordinary ASCII seat row, which is
  // exactly why the original recursive sorter shipped: every test used ASCII
  // handles and no numeric keys.
  test("integer-like keys keep LEXICOGRAPHIC order, not JS numeric order", () => {
    // A sorted object is reordered by the host language on the way out, so the
    // sorting must happen at emit time. Bare JSON.stringify gives "2" then "10".
    expect(pyJson({ "10": 1, "2": 1, b: 3 }, 0)).toBe('{\n  "10": 1,\n  "2": 1,\n  "b": 3\n}');
  });

  test("non-ASCII is escaped the way python's ensure_ascii does", () => {
    expect(pyJson({ b: "café ☕" }, 0)).toBe('{\n  "b": "caf\\u00e9 \\u2615"\n}');
  });

  test("empty containers and nesting match python's indent=2", () => {
    expect(pyJson({ a: {}, b: [], c: { d: [1, 2] } }, 0))
      .toBe('{\n  "a": {},\n  "b": [],\n  "c": {\n    "d": [\n      1,\n      2\n    ]\n  }\n}');
  });
});

describe("a container-valued TAP_HOME is refused before any write", () => {
  // The refusal reports a PHYSICALLY RESOLVED path, so an alias or a trailing
  // separator cannot bypass the check by spelling the same directory another
  // way. On macOS /var is a symlink to /private/var, so the expectations
  // resolve too — comparing against the unresolved path would be testing the
  // symlink, not the guard.
  const real = (p: string) => realpathSync(p);

  test("a git worktree root names its bus instead of becoming one", () => {
    const wt = join(root, "wt");
    mkdirSync(wt, { recursive: true });
    spawnSync("git", ["init", "-q", wt]);
    expect(containerRefusal(wt)).toBe(join(real(wt), ".tap", "bus"));
  });

  test("a root already holding .tap/bus is a container", () => {
    const r2 = join(root, "held");
    mkdirSync(join(r2, ".tap", "bus"), { recursive: true });
    expect(containerRefusal(r2)).toBe(join(real(r2), ".tap", "bus"));
  });

  test(".tap itself points one level down", () => {
    const dot = join(root, "x", ".tap");
    mkdirSync(dot, { recursive: true });
    expect(containerRefusal(dot)).toBe(join(real(dot), "bus"));
  });

  test("a tmp directory has no special container meaning", () => {
    const t = join(root, "y", "tmp");
    mkdirSync(join(t, "tap"), { recursive: true });
    expect(containerRefusal(t)).toBeNull();
  });

  test("a canonical bus is accepted, trailing slash and all", () => {
    const bus = join(root, "ok", ".tap", "bus");
    mkdirSync(bus, { recursive: true });
    expect(containerRefusal(bus)).toBeNull();
    expect(containerRefusal(`${bus}/`)).toBeNull();
  });

  test("an ordinary custom home is accepted — it may legitimately bootstrap", () => {
    expect(containerRefusal(join(root, "some", "custom", "home"))).toBeNull();
  });
});


describe("the container guard is enforced AT THE WRITE BOUNDARY, not merely computed", () => {
  // The pure containerRefusal tests above are necessary and NOT sufficient:
  // deleting the call from Bus.ensureDirs, or moving it after the mkdir, leaves
  // every one of them green while reintroducing the split-bus write defect
  // (partner review, unit 2 round 2). These assert the EFFECT — the refusal
  // happens, and nothing is created — through the boundary every writer crosses
  // and through the CLI a user actually runs.
  test("Bus.ensureDirs refuses and creates NOTHING", () => {
    const wt = join(root, "guarded");
    mkdirSync(wt, { recursive: true });
    spawnSync("git", ["init", "-q", wt]);
    const bus = new Bus(wt);

    expect(() => bus.ensureDirs()).toThrow(/does not name a bus/);
    // The half that matters: a refusal AFTER bootstrapping has already left the
    // decoy tree behind, and the next lookup there reads it as real.
    expect(existsSync(join(wt, "payloads"))).toBe(false);
    expect(existsSync(join(wt, "receipts"))).toBe(false);
    expect(existsSync(join(wt, BUS_AUTHORITY_MARKER))).toBe(false);
  });

  test("the CLI refuses with the incumbent's message and its executable remedy", () => {
    const wt = join(root, "cli-guarded");
    mkdirSync(wt, { recursive: true });
    spawnSync("git", ["init", "-q", wt]);
    const index = join(root, "cli-guarded-index");
    mkdirSync(index, { recursive: true });
    writeFileSync(globalRegistryPath(index), JSON.stringify({ schema: "0.20", teams: {} }));

    const r = spawnSync("bun", [join(import.meta.dir, "..", "main.ts"), "poll", "someone"], {
      encoding: "utf8",
      cwd: wt,
      env: env({ TAP_HOME: wt, TAP_INDEX_HOME: index }),
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("does not name a bus");
    // The remedy must name the TAP_HOME fault, not send the operator to --team:
    // an accurate refusal with the wrong next step is its own defect.
    expect(r.stderr).toContain("unset TAP_HOME or point it at the bus dir");
    expect(r.stderr).not.toContain("--team");
    expect(existsSync(join(wt, "payloads"))).toBe(false);
    expect(existsSync(join(wt, "receipts"))).toBe(false);
  });
});


describe("the registry number domain is ENFORCED from raw bytes, not announced", () => {
  // Declaring a restricted value domain in a docstring changes nothing. These
  // load REAL BYTES and assert the refusal, because the distinctions being
  // guarded are destroyed by JSON.parse before any later code can see them
  // (partner review, unit 2 round 3).
  const load = (raw: string) => {
    const f = join(root, `dom-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(f, raw);
    return () => loadRegistry(f);
  };

  test("an unsafe integer is REFUSED, not silently rounded", () => {
    // JSON.parse turns 9007199254740993 into ...992 with no signal at all;
    // python preserves it. That is value loss, not byte drift.
    expect(load('{"a": 9007199254740993}')).toThrow(/exceeds the safe-integer range/);
  });

  test("the refusal names the lexeme AND what it would have become", () => {
    expect(load('{"a": 9007199254740993}')).toThrow(/9007199254740993/);
    expect(load('{"a": 9007199254740993}')).toThrow(/9007199254740992/);
  });

  test("a float is refused — JS cannot tell 1.0 from 1", () => {
    expect(load('{"a": 1.0}')).toThrow(/outside the supported value domain/);
  });

  test("an exponent form is refused", () => {
    expect(load('{"a": 1e3}')).toThrow(/outside the supported value domain/);
  });

  test("float negative zero is refused; JS cannot distinguish it from integer -0", () => {
    expect(load('{"a": -0.0}')).toThrow(/outside the supported value domain/);
  });

  test("integer -0 is ACCEPTED and normalized to 0, exactly as python loads it", () => {
    const f = join(root, "negzero.json");
    writeFileSync(f, '{"a": -0, "b": 1}');
    const doc = loadRegistry(f);
    expect(Object.is(doc.a, -0)).toBe(false);
    expect(doc.a).toBe(0);
    expect(pyJson(doc, 0)).toBe('{\n  "a": 0,\n  "b": 1\n}');
  });

  test("ordinary integers and every non-numeric type still load", () => {
    const f = join(root, "ok-domain.json");
    writeFileSync(f, '{"n": 42, "neg": -7, "s": "x", "b": true, "z": null, "o": {"k": 1}, "arr": [1, 2]}');
    expect(() => loadRegistry(f)).not.toThrow();
  });

  test("a value CONSTRUCTED in-process is refused too — the loader is not the only door", () => {
    // Covers values this process builds rather than reads, which never pass
    // through loadRegistry at all.
    expect(() => pyJson({ a: 1.5 }, 0)).toThrow(/supported value domain/);
    expect(() => pyJson({ a: 9007199254740993 }, 0)).toThrow(/supported value domain/);
  });
});
