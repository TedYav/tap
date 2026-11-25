// Behavioral controls retained when registry_v20 and its Python-only tests retire.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRegistryLock } from "../src/panelock";
import { registryWriteRefusal, teamRegistryDefect, teamRegistryRefusal } from "../src/register-authority";
import { validateLockedRegistryAuthority } from "../src/slices/registry-authority";
import { removeScratchTree } from "./support/scratch";

test("native in-lock authority accepts acting, retries retired bus, and refuses unusable enrollment", () => {
  const root = mkdtempSync(join(tmpdir(), "python-closure-authority."));
  const team = join(root, "team"), index = join(root, "index");
  const bus = join(team, ".tap/bus/registry.json"), acting = join(team, ".tap/team-registry.json");
  mkdirSync(join(team, ".tap/bus"), { recursive: true }); mkdirSync(index);
  const marker = join(index, "global-registry.json");
  const doc = { schema: "0.20", team: { name: "t", worktree_root: team }, seats: {
    alice: { status: "active", instance: "alice|bus" }, poison: { status: "active" },
  } };
  writeFileSync(acting, JSON.stringify(doc)); writeFileSync(bus, JSON.stringify(doc));
  const before = readFileSync(bus, "utf8");
  const check = (path: string) => {
    const lock = acquireRegistryLock(path); expect(lock).not.toBeNull();
    try { return validateLockedRegistryAuthority(path, team, index, { requireLive: true }); }
    finally { lock?.release(); }
  };
  try {
    writeFileSync(marker, JSON.stringify({ schema: "0.20", teams: { t: { root: team, registry_location: acting } } }));
    expect(check(acting)).toEqual({ ok: true });
    const lock = acquireRegistryLock(bus); expect(lock).not.toBeNull();
    try {
      const verdict = validateLockedRegistryAuthority(bus, team, index, { requireLive: true });
      // A false allow would actually poison the retired mirror under its lock.
      if (verdict.ok) writeFileSync(bus, JSON.stringify({ ...doc, seats: {} }));
      expect(verdict).toMatchObject({ ok: false, retry: true });
      expect(readFileSync(bus, "utf8")).toBe(before);
    } finally { lock?.release(); }
    writeFileSync(marker, JSON.stringify({ schema: "0.20", teams: {} }));
    expect(check(acting)).toMatchObject({ ok: false, retry: false });
    writeFileSync(marker, "{invalid");
    expect(check(acting)).toMatchObject({ ok: false, retry: false });
    rmSync(marker);
    for (const path of [acting, bus]) expect(check(path)).toMatchObject({ ok: false, retry: false });
    expect(readFileSync(bus, "utf8")).toBe(before);
  } finally { removeScratchTree(root); }
});

test("remaining old-store scalar reasons retain precise native refusal text", () => {
  for (const [schema, reason] of [[0.2, "schema 0.2"], [true, "schema true"], ["0.2é", 'schema "0.2é"']] as const) {
    const doc = { schema, seats: {} };
    expect(teamRegistryDefect(doc)).toBe(reason);
    expect(teamRegistryRefusal("/r.json", doc)).toMatchObject({
      errorClass: "old_store",
      detail: `/r.json is an old TAP registry format (${reason}); this TAP reads team registries with a seats object and schema 0.20 or 0.21 and never converts old files`,
    });
  }
});

test("native writer refuses hybrid, agents-only, and axisless documents without mutation", () => {
  for (const doc of [
    { schema: "0.20", seats: { alice: {} }, agents: { old: {} } },
    { schema: "0.20", agents: { old: {} } },
    { schema: "0.20", team: { name: "t" } },
  ]) {
    const before = JSON.stringify(doc);
    expect(registryWriteRefusal("/r.json", doc)?.errorClass).toBe("old_store");
    expect(JSON.stringify(doc)).toBe(before);
  }
});
