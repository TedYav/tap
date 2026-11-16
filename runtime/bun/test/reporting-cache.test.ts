import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reportingFixture } from "./support/reporting-fixture";

test("a warm caller observation serves reports without live children while queue data stays fresh", () => {
  const f = reportingFixture();
  const run = (args: string[]) => f.run(args, undefined, undefined, { TAP_REPORTING_CACHE_TTL: "5" });
  try {
    const coldShow = run(["show", f.id]);
    expect(coldShow.code, coldShow.stderr).toBe(0);
    expect(existsSync(join(f.root, ".tap/bus/runtime-cache"))).toBe(false);
    const cold = run(["whoami", "--json"]);
    expect(cold.code, cold.stderr).toBe(0);
    expect(cold.calls.length).toBeGreaterThan(0);
    const warm = run(["whoami", "--json"]);
    expect(warm.stdout).toBe(cold.stdout);
    expect(warm.calls).toEqual([]);
    f.inbound();
    const inbox = run(["poll", "--json"]);
    expect(inbox.code, inbox.stderr).toBe(0);
    expect(JSON.parse(inbox.stdout).pending).toHaveLength(1);
    expect(inbox.calls).toEqual([]);
    const obligations = run(["outstanding", "self", "--json"]);
    expect(obligations.code, obligations.stderr).toBe(0);
    expect(obligations.stderr).toContain("self has 1 unsettled inbound");
    expect(JSON.parse(obligations.stdout).outstanding).toHaveLength(1);
    expect(obligations.calls).toEqual([]);
    const implicit = run(["outstanding", "--json"]);
    expect(implicit.code, implicit.stderr).toBe(0);
    expect(implicit.stdout).toBe(obligations.stdout);
    expect(implicit.calls).toEqual([]);
    const shown = run(["show", f.id]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain("reporting fixture body");
    expect(shown.calls).toEqual([]);

    // Cached output would retain the old body; only discovery may be cached.
    const path = join(f.root, ".tap/bus/payloads", `${f.id}.md`);
    writeFileSync(path, readFileSync(path, "utf8").replace("reporting fixture body", "fresh body"));
    expect(run(["show", f.id]).stdout).toContain("fresh body");
    const explicit = run(["whoami", "--pane", f.pane, "--json"]);
    expect(explicit.code).toBe(0);
    expect(explicit.calls.some(call => call[0] === "tmux")).toBe(true);
    const other = f.otherWorktree();
    const crossTeam = f.run(["whoami", "--json"], undefined, other, { TAP_REPORTING_CACHE_TTL: "5" });
    expect(JSON.parse(crossTeam.stdout).team).toBe("reporting");
    expect(crossTeam.calls.length).toBeGreaterThan(0);
  } finally { f.close(); }
}, 60_000);

test("an inherited pane hint for another team cannot populate that team's cache", () => {
  const f = reportingFixture();
  try {
    f.run(["whoami", "--json"], undefined, undefined, { TAP_REPORTING_CACHE_TTL: "5" });
    const other = f.otherWorktree(), registry = join(other, ".tap/team-registry.json");
    const doc = JSON.parse(readFileSync(registry, "utf8"));
    doc.seats.decoy = { status: "active", pane_id: "%999", session: "other/decoy", server_epoch: "srv:1:1" };
    writeFileSync(registry, JSON.stringify(doc));
    const result = f.run(["whoami", "--json"], undefined, undefined, { TAP_REPORTING_CACHE_TTL: "5", TMUX_PANE: "%999" });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ handle: "self", team: "reporting", pane_id: f.pane });
    expect(result.calls.length).toBeGreaterThan(0);
    expect(existsSync(join(other, ".tap/bus/runtime-cache"))).toBe(false);
  } finally { f.close(); }
}, 60_000);

test("tap in stays live and re-registration invalidates a warm caller within the TTL", () => {
  const f = reportingFixture();
  const run = (args: string[]) => f.run(args, undefined, undefined, { TAP_REPORTING_CACHE_TTL: "5" });
  try {
    const before = run(["whoami", "--json"]);
    expect(run(["whoami", "--json"]).calls).toEqual([]);
    const rebound = run(["in", "renamed", "--force"]);
    expect(rebound.code, rebound.stderr + rebound.stdout).toBe(0);
    expect(rebound.calls.some(call => call[0] === "tmux")).toBe(true);
    const after = run(["whoami", "--json"]);
    expect(after.code, after.stderr).toBe(0);
    expect(JSON.parse(after.stdout)).toMatchObject({ handle: "renamed", pane_id: f.pane });
    expect(JSON.parse(after.stdout).instance).not.toBe(JSON.parse(before.stdout).instance);
    expect(after.calls.length).toBeGreaterThan(0);
  } finally { f.close(); }
}, 60_000);

test("a pane's enrolled team supplies the warm cache from an unenrolled linked worktree", () => {
  const f = reportingFixture();
  try {
    const linked = f.otherWorktree(false);
    const run = () => f.run(["whoami", "--json"], undefined, linked, { TAP_REPORTING_CACHE_TTL: "5" });
    const cold = run();
    expect(cold.code, cold.stderr).toBe(0);
    expect(JSON.parse(cold.stdout).team).toBe("reporting");
    const warm = run();
    expect(warm.stdout).toBe(cold.stdout);
    expect(warm.calls).toEqual([]);
  } finally { f.close(); }
}, 60_000);

test("expired, corrupt and disabled caches use fresh discovery, and registry changes invalidate them", () => {
  const f = reportingFixture();
  const run = (extra: NodeJS.ProcessEnv = {}) => f.run(["whoami", "--json"], undefined, undefined, { TAP_REPORTING_CACHE_TTL: "5", ...extra });
  try {
    run();
    const cacheDir = join(f.root, ".tap/bus/runtime-cache");
    const file = join(cacheDir, readdirSync(cacheDir).find(name => name.startsWith("reporting-"))!);
    const old = JSON.parse(readFileSync(file, "utf8"));
    old.observedAt = Date.now() - 6000;
    writeFileSync(file, JSON.stringify(old));
    expect(run().calls.length).toBeGreaterThan(0);
    writeFileSync(file, "{broken");
    expect(run().calls.length).toBeGreaterThan(0);
    expect(run().calls).toEqual([]);
    expect(run({ TAP_REPORTING_CACHE_TTL: "0" }).calls.length).toBeGreaterThan(0);
    const registry = JSON.parse(readFileSync(f.registry, "utf8"));
    registry.seats.self.crew = true;
    writeFileSync(f.registry, JSON.stringify(registry));
    const changed = run();
    expect(JSON.parse(changed.stdout).crew).toBe(true);
    expect(changed.calls.length).toBeGreaterThan(0);
  } finally { f.close(); }
}, 60_000);

test("the configured TTL can disable caching and a changed team index is resolved on every invocation", () => {
  const f = reportingFixture();
  const run = () => f.run(["whoami", "--json"], undefined, undefined, { TAP_REPORTING_CACHE_TTL: undefined });
  try {
    const config = join(f.dir, ".config/tap/config.toml");
    mkdirSync(join(f.dir, ".config/tap"), { recursive: true });
    writeFileSync(config, "version=2\n[advanced]\nreporting_cache_ttl_seconds=0\n");
    expect(run().calls.length).toBeGreaterThan(0);
    expect(run().calls.length).toBeGreaterThan(0);
    expect(existsSync(join(f.root, ".tap/bus/runtime-cache"))).toBe(false);
    writeFileSync(config, "version=2\n[advanced]\nreporting_cache_ttl_seconds=5\n");
    run();
    expect(run().calls).toEqual([]);
    const index = JSON.parse(readFileSync(join(f.index, "global-registry.json"), "utf8"));
    index.teams.renamed = index.teams.reporting;
    delete index.teams.reporting;
    writeFileSync(join(f.index, "global-registry.json"), JSON.stringify(index));
    const changed = run();
    expect(changed.code, changed.stderr).toBe(0);
    expect(JSON.parse(changed.stdout).team).toBe("renamed");
  } finally { f.close(); }
}, 60_000);
