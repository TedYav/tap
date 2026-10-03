import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GC_BATCH_SIZE, parseGcBatch, SpoolGcCursor } from "../src/spool-gc";
import { reapStaleSidecars } from "../src/spool-sidecar";
import { reapSettledDigests } from "../src/digest-index";
import { acquirePathLock } from "../src/panelock";
import { realLoopSeams } from "../src/watch-loop";

function fixture() {
  const home = mkdtempSync(join(process.env.TAP_HOME!, "gc-"));
  const spool = join(home, "spool"), payloads = join(home, "payloads");
  for (const dir of [spool, payloads, join(spool, "digests"), join(home, "receipts"), join(home, "pane-effects")]) mkdirSync(dir, { recursive: true });
  return { home, spool, payloads, env: { ...process.env, TAP_HOME: home, TAP_LOCK_DIR: join(home, "locks") } };
}

test("watch cursor caps batches and covers a large unchanged directory across ticks", () => {
  const f = fixture(), cursor = new SpoolGcCursor(f.home, f.env), seen = new Set<string>();
  for (let i = 0; i < 1000; i++) writeFileSync(join(f.spool, `id${i}.meta.json.lock`), "");
  for (let i = 0; i < 9; i++) writeFileSync(join(f.spool, "digests", `d${i}.json`), "{}");
  try {
    for (let tick = 0; tick < 160 && seen.size < 1000; tick++) {
      const batch = cursor.next();
      expect(batch.sidecars.length + batch.digests.length + batch.paneEffects.length).toBeLessThanOrEqual(GC_BATCH_SIZE);
      for (const name of batch.sidecars) if (name.endsWith(".lock")) seen.add(name);
    }
    expect(seen.size).toBe(1000);
  } finally { cursor.close(); }
});

test("one cursor owns a bus, and a replacement directory starts a fresh scan", () => {
  const f = fixture(), a = new SpoolGcCursor(f.home, f.env), b = new SpoolGcCursor(f.home, f.env);
  writeFileSync(join(f.spool, "first.claim"), "");
  try {
    expect(a.next().sidecars).toContain("first.claim");
    expect(b.next()).toEqual({ sidecars: [], digests: [], paneEffects: [] });
    renameSync(f.spool, join(f.home, "old-spool")); mkdirSync(f.spool);
    writeFileSync(join(f.spool, "replacement.claim"), "");
    expect(a.next().sidecars).toEqual(["replacement.claim"]);
    a.close();
    expect(b.next().sidecars).toEqual(["replacement.claim"]);
  } finally { a.close(); b.close(); }
});

test("bounded candidate input rejects traversal and oversized batches", () => {
  expect(parseGcBatch(undefined)).toBeUndefined();
  expect(() => parseGcBatch('{"sidecars":["../x"],"digests":[],"paneEffects":[]}')).toThrow();
  expect(() => parseGcBatch(JSON.stringify({ sidecars: Array(25).fill("x"), digests: [], paneEffects: [] }))).toThrow();
});

test("residue cleanup requires absent entry and claim, old age, and a free metadata lock", () => {
  const f = fixture();
  const names = ["gone.meta.json.reown", "owned.meta.json.reown", "body.meta.json.reown", "meta.meta.json.reown", "claim.meta.json.reown", "fresh.meta.json.reown", "old.meta.json.lock.held.123.abc", "owned.meta.json.lock.held.123.abc"];
  for (const n of names) { writeFileSync(join(f.spool, n), "token"); if (!n.startsWith("fresh.")) utimesSync(join(f.spool, n), 1, 1); }
  writeFileSync(join(f.spool, "body.md"), "retained body");
  writeFileSync(join(f.spool, "meta.meta.json"), "{}");
  writeFileSync(join(f.spool, "claim.claim"), "{}");
  const held = acquirePathLock(join(f.spool, "owned.meta.json.lock"), 0, f.env);
  expect(held).not.toBeNull();
  try {
    reapStaleSidecars(f.spool, f.payloads, f.env, names);
    expect(existsSync(join(f.spool, names[0]!))).toBe(false);
    expect(existsSync(join(f.spool, names[6]!))).toBe(false);
    for (const n of names.filter((_, i) => i !== 0 && i !== 6)) expect(existsSync(join(f.spool, n))).toBe(true);
    expect(readFileSync(join(f.spool, "body.md"), "utf8")).toBe("retained body");
  } finally { held!.release(); }
  reapStaleSidecars(f.spool, f.payloads, f.env, [names[1]!, names[7]!]);
  expect(existsSync(join(f.spool, names[1]!))).toBe(false);
  expect(existsSync(join(f.spool, names[7]!))).toBe(false);
});

test("sidecar and digest reapers touch only the selected candidates", () => {
  const f = fixture(), digests = join(f.spool, "digests");
  for (let i = 0; i < 50; i++) {
    writeFileSync(join(f.spool, `id${i}.meta.json.lock`), ""); utimesSync(join(f.spool, `id${i}.meta.json.lock`), 1, 1);
    writeFileSync(join(digests, `id${i}.json`), "invalid");
  }
  reapStaleSidecars(f.spool, f.payloads, f.env, ["id0.meta.json.lock", "id1.meta.json.lock"]);
  reapSettledDigests(digests, join(f.home, "receipts"), f.env, undefined, ["id0.json"]);
  expect(readdirSync(f.spool).filter(n => n.endsWith(".lock")).length).toBe(48);
  expect(readdirSync(digests).length).toBe(49);
});

test("busy reset custody skips residue immediately instead of waiting per candidate", () => {
  const f = fixture(), name = "gone.meta.json.reown";
  writeFileSync(join(f.spool, name), "token"); utimesSync(join(f.spool, name), 1, 1);
  const held = acquirePathLock(join(f.home, "reset.fence.json.lock"), 0, f.env);
  expect(held).not.toBeNull();
  try {
    const start = performance.now();
    reapStaleSidecars(f.spool, f.payloads, f.env, [name]);
    expect(performance.now() - start).toBeLessThan(500);
    expect(existsSync(join(f.spool, name))).toBe(true);
  } finally { held!.release(); }
});

test("the long-lived loop passes different bounded batches to successive tick children", async () => {
  const f = fixture();
  for (let i = 0; i < 60; i++) writeFileSync(join(f.spool, `id${i}.claim`), "");
  const src = join(f.home, "src"); mkdirSync(src);
  writeFileSync(join(src, "watch-tick-run.ts"), 'await Bun.write(process.env.GC_RECEIPT!, process.env.TAP_SPOOL_GC_BATCH!);');
  const receipt = join(f.home, "batch.json");
  const s = realLoopSeams({ bus: f.home, scripts: src, src, refresh: () => null, env: { ...f.env, GC_RECEIPT: receipt } });
  try {
    await s.tick(); const a = parseGcBatch(readFileSync(receipt, "utf8"))!;
    await s.tick(); const b = parseGcBatch(readFileSync(receipt, "utf8"))!;
    expect(a.sidecars.length).toBeGreaterThan(0);
    expect(b.sidecars.some(n => a.sidecars.includes(n))).toBe(false);
    expect(a.sidecars.length + a.digests.length + a.paneEffects.length).toBeLessThanOrEqual(GC_BATCH_SIZE);
  } finally { s.close?.(); }
});
