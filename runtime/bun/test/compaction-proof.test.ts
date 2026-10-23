import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { captureCompactionBoundary, compactionEnterEffects, readCompactionProof, waitForCompactionProof, type CompactionBoundary } from "../src/compaction-proof";
import { REAL_EFFECTS } from "../src/courier";
import { proofFixture } from "./fixtures/compaction-proof";

const root = mkdtempSync(join(process.env.TAP_HOME ?? tmpdir(), "compaction-proof-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("Claude proof requires a complete fresh summary for the bound session, not prose or a boundary", () => {
  const f = proofFixture(root, "claude");
  f.summary(999); f.summary(1000);
  f.summary(1001, { sessionId: "foreign" });
  f.summary(1002, { isSidechain: true });
  f.summary(1003, { isCompactSummary: false, message: { content: '"isCompactSummary":true' } });
  f.summary(1004, { type: "system", subtype: "compact_boundary" });
  expect(readCompactionProof(f.boundary)).toBeNull();
  const line = JSON.stringify({ type: "user", sessionId: f.boundary.session, isCompactSummary: true,
    isVisibleInTranscriptOnly: true, timestamp: new Date(1005).toISOString() });
  appendFileSync(f.path, line);
  expect(readCompactionProof(f.boundary)).toBeNull();
  appendFileSync(f.path, "\n");
  expect(readCompactionProof(f.boundary)).toEqual({ evidence: "transcript-proven", compactedAt: new Date(1005).toISOString() });
});

test("Claude rejects preexisting future records, a partial baseline record, replacement and rewrite", () => {
  const f = proofFixture(root, "claude");
  f.summary(2000);
  const baseline = captureCompactionBoundary("claude", f.seat, 1000);
  expect(readCompactionProof(baseline)).toBeNull();
  const partial = JSON.stringify({ type: "user", sessionId: f.boundary.session, isCompactSummary: true,
    isVisibleInTranscriptOnly: true, timestamp: new Date(3000).toISOString() });
  appendFileSync(f.path, partial.slice(0, 20));
  const mid = captureCompactionBoundary("claude", f.seat, 1000);
  appendFileSync(f.path, partial.slice(20) + "\n");
  expect(readCompactionProof(mid)).toBeNull();
  const bytes = readFileSync(f.path, "utf8");
  writeFileSync(f.path, bytes.replace("bound-session", "other-session"));
  expect(readCompactionProof(f.boundary)).toBeNull();
  renameSync(f.path, f.path + ".old");
  writeFileSync(f.path, bytes);
  expect(readCompactionProof(f.boundary)).toBeNull();
});

test("OpenCode proof requires a fresh completed manual compaction row", () => {
  const f = proofFixture(root, "opencode");
  f.summary(999); f.summary(1000);
  f.summary(1001, { status: "running" });
  f.summary(1002, { error: { name: "aborted" } });
  f.summary(1003, { status: "failed" });
  f.summary(1004, { type: "assistant" });
  f.summary(1005, {}, false);
  f.summary(1006, { reason: "auto" });
  expect(readCompactionProof(f.boundary)).toBeNull();
  f.summary(1007);
  expect(readCompactionProof(f.boundary)).toEqual({ evidence: "store-proven", compactedAt: new Date(1008).toISOString() });
});

test("OpenCode rejects old summaries with new timestamps, foreign sessions and missing stores", () => {
  const f = proofFixture(root, "opencode");
  f.summary(2000);
  const baseline = captureCompactionBoundary("opencode", f.seat, 1000);
  expect(readCompactionProof(baseline)).toBeNull();
  f.summary(3000);
  const db = new Database(f.path);
  db.exec("UPDATE session_message SET session_id = 'foreign'");
  db.close();
  expect(readCompactionProof(baseline)).toBeNull();
  renameSync(f.path, f.path + ".old");
  expect(readCompactionProof(baseline)).toBeNull();
  expect(() => captureCompactionBoundary("opencode", f.seat)).toThrow();
});

test("the production Enter wrapper captures after staging and refuses any second Enter", () => {
  const f = proofFixture(root, "claude");
  let boundary: CompactionBoundary | undefined, enters = 0;
  const fx = compactionEnterEffects("claude", f.seat, { ...REAL_EFFECTS, pressEnter: () => {
    enters++;
    expect(boundary).toBeDefined();
    expect(readCompactionProof(boundary!)).toBeNull();
    f.summary(Date.now() + 1);
    return true;
  } }, b => { boundary = b; });
  f.summary(Date.now() + 10000); // Appears while staging, before actual Enter.
  expect(fx.pressEnter("%fixture")).toBe(true);
  expect(readCompactionProof(boundary!)).not.toBeNull();
  expect(fx.pressEnter("%fixture")).toBe(false);
  expect(enters).toBe(1);
});

test("shared wait includes its final scan, refuses identity drift, and never treats timeout as proof", async () => {
  const f = proofFixture(root, "claude");
  let time = 1000;
  expect(await waitForCompactionProof(f.boundary, { valid: () => true, now: () => time,
    wait: async () => { time += 100; if (time === 1200) f.summary(time); } }, 200)).not.toBeNull();
  expect(waitForCompactionProof(f.boundary, { valid: () => false, now: () => time, wait: async () => {} }, 200)).rejects.toThrow("identity");
  const empty = proofFixture(root, "opencode");
  expect(await waitForCompactionProof(empty.boundary, { valid: () => true, now: () => time,
    wait: async () => { time += 100; } }, 200)).toBeNull();
});

test("OpenCode chooses its registered DB over a stale transcript alias; legacy rows still work", () => {
  const f = proofFixture(root, "opencode");
  expect(captureCompactionBoundary("opencode", { ...f.seat, transcript_path: "/stale/alias" }).path).toBe(f.path);
  expect(captureCompactionBoundary("opencode", { harness_session_id: f.seat.harness_session_id, transcript_path: f.path }).path).toBe(f.path);
});
