import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { reportingFixture } from "./support/reporting-fixture";

/** Include directories as well as file bytes, so an empty cache directory is a write too. */
function snapshot(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name), key = relative(root, path);
      if (entry.isDirectory()) { entries[`${key}/`] = "directory"; walk(path); }
      else entries[key] = readFileSync(path).toString("base64");
    }
  };
  walk(root);
  return entries;
}

for (const selector of [["roster", "other"], ["list", "other"]]) for (const mode of [[], ["--no-state"]]) {
  test(`named roster leaves an existing foreign tree byte-identical: ${[...selector, ...mode].join(" ")}`, () => {
    const f = reportingFixture();
    try {
      const other = f.otherWorktree(), registry = join(other, ".tap/team-registry.json");
      const doc = JSON.parse(readFileSync(registry, "utf8"));
      doc.seats.peer = { delivery: "poll", status: "active", harness: "codex", instance: "peer|one" };
      writeFileSync(registry, JSON.stringify(doc));
      const before = snapshot(other);
      const result = f.run(["team", ...selector, "--json", ...mode], undefined, undefined,
        { TAP_ROSTER_CACHE_TTL: "60", TAP_WATCH_NOW: undefined });
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ team: "other", agents: [{ handle: "peer" }] });
      expect(snapshot(other)).toEqual(before);
    } finally { f.close(); }
  }, 60_000);
}

test("named roster preserves an existing foreign cache; implicit own roster may cache", () => {
  const f = reportingFixture();
  try {
    const other = f.otherWorktree(), registry = join(other, ".tap/team-registry.json");
    const doc = JSON.parse(readFileSync(registry, "utf8"));
    doc.seats.peer = { delivery: "poll", status: "active", harness: "codex", instance: "peer|one" };
    writeFileSync(registry, JSON.stringify(doc));
    const cache = join(other, ".tap/bus/runtime-cache");
    mkdirSync(cache);
    writeFileSync(join(cache, "roster-nostate.json"), "stale observation to preserve\n");
    const before = snapshot(other);
    const extra = { TAP_ROSTER_CACHE_TTL: "60", TAP_WATCH_NOW: undefined };
    const foreign = f.run(["team", "roster", "other", "--json", "--no-state"], undefined, undefined, extra);
    expect(foreign.code, foreign.stderr).toBe(0);
    expect(snapshot(other)).toEqual(before);
    const own = f.run(["team", "--json", "--no-state"], undefined, undefined, extra);
    expect(own.code, own.stderr).toBe(0);
    expect(readdirSync(join(f.root, ".tap/bus/runtime-cache"))).toContain("roster-nostate.json");
  } finally { f.close(); }
}, 60_000);
