import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rosterCache, rosterCacheTtl, type RosterSnapshot } from "../src/roster-cache";
import { removeScratchTree } from "./support/scratch";
const scratch: string[] = [];
afterEach(() => { for (const root of scratch.splice(0)) removeScratchTree(root); });
const snapshot: RosterSnapshot = {rows:[],hierarchyRows:[],serverEpoch:"srv:1:1",callerSocket:"/tmp/test"};
function fixture() { const root = mkdtempSync(join(tmpdir(), "roster-cache.")); scratch.push(root); return root; }

test("fresh whole observations survive another reader and expire at the TTL", () => {
  const root = fixture(), slot = "full" as const;
  const first = rosterCache(root, slot, {registry:"one"}, 5, 1000);
  expect(first.read()).toBeNull();
  first.write(snapshot, 1000);
  expect(rosterCache(root, slot, {registry:"one"}, 5, 5999).read()).toEqual({snapshot,observedAt:1000});
  expect(rosterCache(root, slot, {registry:"one"}, 5, 6000).read()).toBeNull();
  expect(rosterCache(root, slot, {registry:"two"}, 5, 2000).read()).toBeNull();
  expect(rosterCache(root, "nostate", {registry:"one"}, 5, 2000).read()).toBeNull();
  expect(rosterCache(root, slot, {registry:"one"}, 5, 999).read()).toBeNull();
});

// tap-k0cfv: the clock is read at read time. A clock captured when the cache object was
// built made an entry written a millisecond later read as "from the future" (a miss; the
// gate flake), and let a late read serve an entry past its TTL.
test("an entry written after the cache object was built reads back", () => {
  const clock = spyOn(Date, "now");
  try {
    const root = fixture();
    clock.mockReturnValue(1000);
    const cache = rosterCache(root, "full", {}, 5);
    clock.mockReturnValue(1001);
    cache.write(snapshot);
    expect(cache.read()).toEqual({snapshot, observedAt:1001});
  } finally { clock.mockRestore(); }
});

test("a late read measures the entry's age when it reads", () => {
  const clock = spyOn(Date, "now");
  try {
    const root = fixture();
    rosterCache(root, "full", {}, 5).write(snapshot, 1000);
    clock.mockReturnValue(2000);
    const cache = rosterCache(root, "full", {}, 5);
    clock.mockReturnValue(5999);
    expect(cache.read()).toEqual({snapshot, observedAt:1000});
    clock.mockReturnValue(6000);
    expect(cache.read()).toBeNull();
  } finally { clock.mockRestore(); }
});

test("corrupt, missing and unwritable cache entries are misses", () => {
  const root = fixture(), cache = rosterCache(root, "full", {}, 5, 2000);
  cache.write(snapshot, 1000);
  const file = join(root, readdirSync(root)[0]!);
  writeFileSync(file, "{broken"); expect(cache.read()).toBeNull();
  cache.write(snapshot, 1000);
  const changed = JSON.parse(readFileSync(file, "utf8")); changed.snapshot.rows = [null];
  writeFileSync(file, JSON.stringify(changed)); expect(cache.read()).toBeNull();
  const invalidRoot = join(root,"file"); writeFileSync(invalidRoot,"not a directory");
  expect(() => rosterCache(invalidRoot, "full", {}, 5).write(snapshot)).not.toThrow();
  expect(rosterCache(invalidRoot, "full", {}, 5).read()).toBeNull();
});

test("zero disables writes and reads; invalid TTL uses the five-second default", () => {
  expect(rosterCacheTtl({})).toBe(5);
  expect(rosterCacheTtl({}, 9)).toBe(9);
  expect(rosterCacheTtl({TAP_ROSTER_CACHE_TTL:"0"}, 9)).toBe(0);
  expect(rosterCacheTtl({TAP_WATCH_NOW:"100",TAP_ROSTER_CACHE_TTL:"60"})).toBe(0);
  expect(rosterCacheTtl({TAP_WATCH_NOW:"200"})).toBe(0);
  for (const value of ["bad","-1","Infinity",""]) expect(rosterCacheTtl({TAP_ROSTER_CACHE_TTL:value})).toBe(5);
  expect(rosterCacheTtl({TAP_ROSTER_CACHE_TTL:"0"})).toBe(0);
  expect(rosterCacheTtl({TAP_ROSTER_CACHE_TTL:"0.5"})).toBe(0.5);
  const root = fixture(), cache = rosterCache(root, "full", {}, 0);
  cache.write(snapshot); expect(cache.read()).toBeNull(); expect(readdirSync(root)).toEqual([]);
});
