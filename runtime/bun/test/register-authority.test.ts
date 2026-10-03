// R3-C commit-1 parity: register-authority.ts against the incumbent born-live
// bootstrap and enroll machinery, including the checkpoint-C old-store refusal.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeScratchTree } from "./support/scratch";
import { flipMarkerState, globalRegistryPath, legacyTeamsPath } from "../src/index-home";
import { loads } from "../src/watch-detect";
import {
  bornLiveBootstrap,
  enrollPreflight,
  enrollTeam,
  oldStoreEvidence,
  oldStoreAction,
  oldStoreRefusalText,
  probeGitRoot,
  rootIndexable,
  teamNameForRoot,
} from "../src/register-authority";

const scratch: string[] = [];
afterEach(() => { for (const p of scratch.splice(0)) { try { chmodSync(p, 0o755); } catch { /* already writable */ } removeScratchTree(p); } }, 30000);

function seedGlobal(index: string, doc: unknown): void {
  writeFileSync(globalRegistryPath(index), `${JSON.stringify(doc, null, 2)}\n`);
}

interface Fix { root: string; index: string; bus: string; env: Record<string, string>; }
function fix(name = "teamx"): Fix {
  const root = realpathSync(mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), `tap-regauth-${name}.`)));
  scratch.push(root);
  const index = join(root, "index"), bus = join(root, "bus"), home = join(root, "home");
  mkdirSync(index, { recursive: true });
  mkdirSync(bus, { recursive: true });
  mkdirSync(home, { recursive: true });
  const team = join(root, name);
  mkdirSync(team, { recursive: true });
  const git = Bun.spawnSync(["git", "init", "-q", team]);
  if (git.exitCode !== 0) throw new Error(`git init failed: ${git.stderr.toString()}`);
  // The seat's bus is bound EXPLICITLY to the canonical .tap/bus shape, never
  // inherited ambient: rootIndexable's TAP_HOME ownership arm is load-bearing.
  const env = {
    ...process.env,
    TAP_INDEX_HOME: index,
    TAP_HOME: `${team}/.tap/bus`,
    HOME: home,
  } as Record<string, string>;
  // The runner exports an ambient TAP_SESSION_MANIFEST; fixtures decide the
  // manifest themselves (the override arm sets it explicitly).
  delete env.TAP_SESSION_MANIFEST;
  return { root: team, index, bus, env };
}

test("rootIndexable accepts only the canonical .tap/bus home", () => {
  const f = fix();
  expect(rootIndexable(f.root, f.env)).toBe(true);
  const tmpTap = { ...f.env, TAP_HOME: `${f.root}/tmp/tap` };
  expect(rootIndexable(f.root, tmpTap)).toBe(false);
  // Unset home: not indexable.
  const noHome = { ...f.env } as Record<string, string>;
  delete noHome.TAP_HOME;
  expect(rootIndexable(f.root, noHome)).toBe(false);
  // Custom/unknown suffix: not indexable even inside the root.
  expect(rootIndexable(f.root, { ...f.env, TAP_HOME: `${f.root}/custom-bus` })).toBe(false);
  // A foreign root's canonical bus: mismatch, not indexable.
  const other = join(f.root, "..", "other-root");
  mkdirSync(other, { recursive: true });
  scratch.push(other);
  expect(rootIndexable(f.root, { ...f.env, TAP_HOME: `${other}/.tap/bus` })).toBe(false);
  // A symlink spelling of the same root resolves equal: indexable.
  const link = join(f.root, "..", "teamx-link");
  try { rmSync(link); } catch { /* absent */ }
  Bun.spawnSync(["ln", "-s", f.root, link]);
  scratch.push(link);
  expect(rootIndexable(link, { ...f.env, TAP_HOME: `${link}/.tap/bus` })).toBe(true);
  // A nested git path is not the team root.
  const nested = join(f.root, "nested");
  mkdirSync(nested, { recursive: true });
  expect(rootIndexable(nested, { ...f.env, TAP_HOME: `${nested}/.tap/bus` })).toBe(false);
  // A bare directory fails the git half.
  expect(rootIndexable(f.index, f.env)).toBe(false);
});

test("rootIndexable admits a non-git root only when init authorized that exact root", () => {
  const f = fix();
  const folder = join(f.root, "..", "notes");
  mkdirSync(folder, { recursive: true });
  expect(Bun.spawnSync(["git", "-C", folder, "rev-parse", "--show-toplevel"]).exitCode).not.toBe(0);
  const env = { ...f.env, TAP_HOME: `${folder}/.tap/bus` };
  expect(rootIndexable(folder, env)).toBe(false);
  expect(rootIndexable(folder, env, { authorizedInitRoot: folder })).toBe(true);
  // Authorization names one root: a sibling or a child of it stays refused.
  expect(rootIndexable(folder, env, { authorizedInitRoot: f.index })).toBe(false);
  const child = join(folder, "child");
  mkdirSync(child);
  expect(rootIndexable(child, { ...f.env, TAP_HOME: `${child}/.tap/bus` }, { authorizedInitRoot: folder })).toBe(false);
  // The home half still binds, and a non-git root has no legacy tmp/tap home.
  expect(rootIndexable(folder, { ...f.env, TAP_HOME: `${folder}/tmp/tap` }, { authorizedInitRoot: folder })).toBe(false);
  expect(rootIndexable(folder, f.env, { authorizedInitRoot: folder })).toBe(false);
  // A folder nested inside a git worktree is never admitted, authorized or not.
  const nested = join(f.root, "nested");
  mkdirSync(nested, { recursive: true });
  expect(rootIndexable(nested, { ...f.env, TAP_HOME: `${nested}/.tap/bus` }, { authorizedInitRoot: nested })).toBe(false);
  // The git top level is unchanged by an authorization.
  expect(rootIndexable(f.root, f.env, { authorizedInitRoot: f.root })).toBe(true);
  // An unobservable git is never read as "outside every repository".
  const shim = join(f.root, "..", "shim");
  mkdirSync(shim);
  writeFileSync(join(shim, "git"), "#!/bin/sh\necho 'fatal: simulated git failure' >&2\nexit 128\n");
  chmodSync(join(shim, "git"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${shim}:${path}`;
  try {
    expect(probeGitRoot(folder).kind).toBe("unobservable");
    expect(rootIndexable(folder, env, { authorizedInitRoot: folder })).toBe(false);
  } finally { process.env.PATH = path; }
});

test("enrollPreflight refuses only an unset index home over a temp root", () => {
  const f = fix();
  const noIndex = { ...process.env } as Record<string, string>;
  delete noIndex.TAP_INDEX_HOME;
  expect(enrollPreflight(f.root, noIndex).ok).toBe(false);
  expect(enrollPreflight(f.root, f.env)).toEqual({ ok: true });
});

test("born-live skips a live machine untouched", () => {
  const f = fix();
  seedGlobal(f.index, { schema: "0.20", teams: { t: { root: "/elsewhere" } } });
  const before = require("node:fs").readFileSync(globalRegistryPath(f.index), "utf8");
  expect(bornLiveBootstrap(f.root, f.env)).toEqual({ status: "live" });
  expect(require("node:fs").readFileSync(globalRegistryPath(f.index), "utf8")).toBe(before);
});

test("born-live creates the registry on a pristine machine and it classifies live", () => {
  const f = fix();
  expect(flipMarkerState(f.index)).toBe("absent");
  expect(bornLiveBootstrap(f.root, f.env)).toEqual({ status: "live" });
  expect(flipMarkerState(f.index)).toBe("live");
  const doc = loads(require("node:fs").readFileSync(globalRegistryPath(f.index), "utf8")) as Map<string, unknown>;
  expect(doc.get("schema")).toBe("0.20");
  expect(doc.get("teams")).toBeInstanceOf(Map);
});

test("born-live refuses a corrupt marker without writing", () => {
  const f = fix();
  writeFileSync(globalRegistryPath(f.index), "[]\n");
  const out = bornLiveBootstrap(f.root, f.env);
  expect(out.status).toBe("refusal");
  if (out.status === "refusal") expect(out.refusal.kind).toBe("invalid_marker");
  expect(require("node:fs").readFileSync(globalRegistryPath(f.index), "utf8")).toBe("[]\n");
});

test("born-live refuses a legacy teams.json store, names it, and preserves it", () => {
  const f = fix();
  const teamsJson = legacyTeamsPath(f.index);
  writeFileSync(teamsJson, '{"teams": {}}\n');
  const out = bornLiveBootstrap(f.root, f.env);
  expect(out.status).toBe("refusal");
  if (out.status === "refusal") {
    expect(out.refusal.kind).toBe("old_store");
    expect(out.refusal.path).toBe(teamsJson);
  }
  expect(out.status === "refusal" && out.refusal.store).toBe("legacy_teams_json");
  expect(oldStoreRefusalText(teamsJson, "legacy_teams_json")).toBe(
    `${teamsJson} is an old TAP registry format (pre-v0.20 teams.json machine index); this TAP reads only the {"schema":"0.20","teams":{...}} machine index in global-registry.json and never converts old files`,
  );
  expect(require("node:fs").readFileSync(teamsJson, "utf8")).toBe('{"teams": {}}\n');
  expect(flipMarkerState(f.index)).toBe("absent");
});

test("born-live refuses a bus registry as old-store evidence", () => {
  const f = fix();
  const busRegistry = join(f.bus, "registry.json");
  writeFileSync(busRegistry, '{"schema": "0.20", "agents": {}}\n');
  const evidence = oldStoreEvidence(f.index, f.bus, "", f.env);
  expect(evidence).toEqual([{ kind: "bus_registry", path: busRegistry }]);
  // bornLiveBootstrap owns only the machine-level arms (teams.json); the bus
  // and agents-axis arms are composed by cmdRegister, which has resolved bus
  // and acting paths. Machine-level: pristine apart from the bus store → live.
  expect(bornLiveBootstrap(f.root, f.env)).toEqual({ status: "live" });
});

test("an agents-axis acting registry is old-store evidence; unreadable files are not", () => {
  const f = fix();
  const acting = join(f.root, ".tap", "team-registry.json");
  mkdirSync(join(f.root, ".tap"), { recursive: true });
  writeFileSync(acting, '{"schema": "0.20", "agents": {"a": {}}}\n');
  expect(oldStoreEvidence(f.index, f.bus, acting, f.env)).toEqual([{ kind: "agents_axis", path: acting }]);
  // A current-path doc with seats is NOT old evidence.
  writeFileSync(acting, '{"schema": "0.20", "seats": {"a": {}}}\n');
  expect(oldStoreEvidence(f.index, f.bus, acting, f.env)).toEqual([]);
  // Unreadable candidates are not evidence.
  const unreadable = join(f.root, "broken.json");
  writeFileSync(unreadable, "not json at all {{{");
  expect(oldStoreEvidence(f.index, f.bus, unreadable, f.env)).toEqual([]);
});

test("enrollTeam writes a fresh enrollment with the given registry location", () => {
  const f = fix();
  expect(bornLiveBootstrap(f.root, f.env)).toEqual({ status: "live" });
  const loc = join(f.bus, "team-registry.json");
  expect(enrollTeam(f.root, loc, f.env)).toEqual({ ok: true });
  const doc = loads(require("node:fs").readFileSync(globalRegistryPath(f.index), "utf8")) as Map<string, unknown>;
  const teams = doc.get("teams") as Map<string, unknown>;
  const ent = teams.get("teamx") as Map<string, unknown>;
  expect(ent.get("root")).toBe(f.root);
  expect(ent.get("registry_location")).toBe(loc);
  expect(ent.get("state")).toBe("registered");
});

test("enrollTeam preserves the existing alias name and stored registry_location", () => {
  const f = fix();
  seedGlobal(f.index, {
    schema: "0.20",
    teams: { "legacy-name": { root: f.root, registry_location: "/custom/loc.json", state: "registered", enrolled_at: "2026-01-01T00:00:00Z" } },
  });
  expect(enrollTeam(f.root, join(f.bus, "team-registry.json"), f.env)).toEqual({ ok: true });
  const doc = loads(require("node:fs").readFileSync(globalRegistryPath(f.index), "utf8")) as Map<string, unknown>;
  const teams = doc.get("teams") as Map<string, unknown>;
  expect(teams.has("teamx")).toBe(false);
  const ent = teams.get("legacy-name") as Map<string, unknown>;
  expect(ent.get("registry_location")).toBe("/custom/loc.json");
  expect(ent.get("enrolled_at")).toBe("2026-01-01T00:00:00Z");
});

test("enrollTeam refuses a name bound to a different existing path", () => {
  const f = fix();
  const other = join(f.root, "..", "other-team-home");
  mkdirSync(other, { recursive: true });
  scratch.push(other);
  seedGlobal(f.index, { schema: "0.20", teams: { teamx: { root: other, registry_location: "/x.json", state: "registered" } } });
  const out = enrollTeam(f.root, join(f.bus, "t.json"), f.env);
  expect(out.ok).toBe(false);
  if (!out.ok) {
    expect(out.kind).toBe("name_collision");
    expect(out.detail).toContain("already indexed at a different path");
    expect(out.detail).toContain("tap admin retire teamx");
  }
});

test("enrollTeam refuses a non-0.20 schema and a non-object teams map", () => {
  const f = fix();
  seedGlobal(f.index, { schema: "0.19", teams: {} });
  const bad = enrollTeam(f.root, "/x.json", f.env);
  expect(bad.ok).toBe(false);
  if (!bad.ok) expect(bad.kind).toBe("invalid_flip");
  const f2 = fix();
  seedGlobal(f2.index, { schema: "0.20", teams: "not-a-map" });
  const bad2 = enrollTeam(f2.root, "/x.json", f2.env);
  expect(bad2.ok).toBe(false);
  if (!bad2.ok) {
    // A non-object teams map classifies the marker invalid at the same gate
    // the incumbent uses (flip_marker_state -> wrong schema, exit 4).
    expect(bad2.kind).toBe("invalid_flip");
    expect(bad2.detail).toContain("unreadable or wrong schema");
  }
});

test("enrollTeam skips a non-indexable root and refuses a temp root with no index home", () => {
  const f = fix();
  const out = enrollTeam(f.index, "/x.json", f.env);
  expect(out).toEqual({ ok: true, skipped: true });
  const noIndex = { ...f.env } as Record<string, string>;
  delete noIndex.TAP_INDEX_HOME;
  const refused = enrollTeam(f.root, "/x.json", noIndex);
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.kind).toBe("temporary_root");
});

test("enrollTeam born-lives a pristine machine inside enroll", () => {
  const f = fix();
  expect(enrollTeam(f.root, join(f.bus, "t.json"), f.env)).toEqual({ ok: true });
  expect(flipMarkerState(f.index)).toBe("live");
});

test("born-live reports not_indexable for a non-git root", () => {
  const f = fix();
  const bare = join(f.root, "..", "bare-dir");
  mkdirSync(bare, { recursive: true });
  scratch.push(bare);
  expect(bornLiveBootstrap(bare, f.env)).toEqual({ status: "not_indexable" });
});

test("old-store evidence is empty on a pristine machine", () => {
  const f = fix();
  expect(oldStoreEvidence(f.index, f.bus, "", f.env)).toEqual([]);
});

test("born-live refuses a launcher manifest as old-store evidence at the default path", () => {
  const f = fix();
  const manifest = join(f.env.HOME!, ".tap", "launcher", "sessions.json");
  mkdirSync(join(f.env.HOME!, ".tap", "launcher"), { recursive: true });
  writeFileSync(manifest, '{"sessions": {}}\n');
  const out = bornLiveBootstrap(f.root, f.env);
  expect(out.status).toBe("refusal");
  if (out.status === "refusal") {
    expect(out.refusal.kind).toBe("old_store");
    expect(out.refusal.path).toBe(manifest);
  }
  expect(require("node:fs").readFileSync(manifest, "utf8")).toBe('{"sessions": {}}\n');
  expect(flipMarkerState(f.index)).toBe("absent");
  expect(existsSync(globalRegistryPath(f.index))).toBe(false);
});

test("born-live honors TAP_SESSION_MANIFEST as the manifest evidence path", () => {
  const f = fix();
  const manifest = join(f.root, "alt-launcher-sessions.json");
  writeFileSync(manifest, "{}\n");
  const out = bornLiveBootstrap(f.root, { ...f.env, TAP_SESSION_MANIFEST: manifest });
  expect(out.status).toBe("refusal");
  if (out.status === "refusal") {
    expect(out.refusal.kind).toBe("old_store");
    expect(out.refusal.path).toBe(manifest);
  }
  expect(require("node:fs").readFileSync(manifest, "utf8")).toBe("{}\n");
  expect(flipMarkerState(f.index)).toBe("absent");
});

test("enrollTeam enrolls an invalid basename under its derived slug, and skips a root with no usable name", () => {
  // teamNameForRoot is the one team-name gate: a derivable basename enrolls
  // under its slug, and a basename with no slug stays unenrolled without a write.
  const f = fix("teamx");
  const gitRoot = (name: string) => {
    const dir = join(f.root, "..", name);
    mkdirSync(`${dir}/.tap/bus`, { recursive: true });
    scratch.push(dir);
    expect(Bun.spawnSync(["git", "init", "-q", dir]).exitCode).toBe(0);
    const env = { ...f.env, TAP_HOME: `${dir}/.tap/bus` } as Record<string, string>;
    expect(rootIndexable(dir, env)).toBe(true);
    return { dir, env };
  };
  seedGlobal(f.index, { schema: "0.20", teams: { t: { root: "/elsewhere" } } });
  const empty = gitRoot("!!!");
  const before = readFileSync(globalRegistryPath(f.index), "utf8");
  expect(enrollTeam(empty.dir, "/nonexistent/registry.json", empty.env)).toEqual({ ok: true, skipped: true });
  expect(readFileSync(globalRegistryPath(f.index), "utf8")).toBe(before);
  const spaced = gitRoot("bad name!");
  expect(enrollTeam(spaced.dir, "/nonexistent/registry.json", spaced.env)).toEqual({ ok: true });
  const teams = (loads(readFileSync(globalRegistryPath(f.index), "utf8")) as Map<string, unknown>).get("teams") as Map<string, unknown>;
  expect(teams.has("bad name!")).toBe(false);
  expect(((teams.get("bad-name") as Map<string, unknown>).get("root"))).toBe(realpathSync(spaced.dir));
});

test("teamNameForRoot keeps valid names, derives launchable slugs, and validates overrides", () => {
  const cases: Array<[string, string | null]> = [
    ["Tap", "Tap"], ["blue", "blue"], ["my.project", "my.project"],
    ["My Project", "my-project"], ["my project.v2", "my-project-v2"], ["_site ", "site"],
    ["  Spaced  Out  ", "spaced-out"], ["@@ __", null], ["!!!", null],
  ];
  for (const [folder, want] of cases) {
    const got = teamNameForRoot(join("/nonexistent-parent", folder));
    if (want === null) {
      expect(got.ok, folder).toBe(false);
      if (!got.ok) expect(got.refusal.action, folder).toContain("--team <name>");
    } else {
      expect(got, folder).toEqual(want === folder ? { ok: true, team: want } : { ok: true, team: want, derivedFrom: folder });
    }
  }
  expect(teamNameForRoot("/x/My Project", "mine")).toEqual({ ok: true, team: "mine" });
  for (const value of ["bad name", "my.team"]) {
    const bad = teamNameForRoot("/x/repo", value);
    expect(bad.ok, value).toBe(false);
    if (!bad.ok) expect(bad.refusal, value).toMatchObject({ errorClass: "invalid_team_name", detail: `--team '${value}' is not a launchable TAP team name` });
  }
});

test("old_store actions match the store: team registries hand-upgrade, machine and launcher files move aside", () => {
  for (const kind of ["agents_axis", "bus_registry"] as const) {
    expect(oldStoreAction(kind)).toStartWith("ask an agent to upgrade this file to the current format by hand");
    expect(oldStoreRefusalText("/r.json", kind)).toContain('{"schema":"0.20","team":{...},"seats":{...}} team registries');
  }
  expect(oldStoreAction("legacy_teams_json")).toBe("move this file aside, then run tap init in each team root to enroll it");
  expect(oldStoreAction("launcher_manifest")).toBe("move this file aside (or unset TAP_SESSION_MANIFEST), then relaunch the seats you still need");
  expect(oldStoreRefusalText("/s.json", "launcher_manifest")).toBe(
    "/s.json is an old TAP registry format (legacy launcher sessions.json manifest); this TAP reads launch configuration only from team-registry seat rows and never converts old files",
  );
  for (const kind of ["legacy_teams_json", "launcher_manifest"] as const) expect(oldStoreAction(kind)).not.toContain('rename "agents"');
});
