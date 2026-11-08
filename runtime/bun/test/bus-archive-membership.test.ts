import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/bus";
import { archivedMonth, monthIndexRows } from "../src/bus-archive-index";
import { removeScratchTree } from "./support/scratch";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeScratchTree(root); });

function row(id: string) {
  return { id, month: "2026-10", settled_at: "2026-10-01T00:00:00Z", payload_sha256: "a".repeat(64), receipts: [`${id}.done`] };
}
function fixture(lines: string[]) {
  const root = fs.mkdtempSync(join(tmpdir(), "tap-archive-membership."));
  roots.push(root);
  for (const dir of ["archive/2026-10/payloads", "receipts", "payloads"]) fs.mkdirSync(join(root, dir), { recursive: true });
  const index = join(root, "archive/2026-10/index.ndjson");
  fs.writeFileSync(index, lines.join("\n"));
  return { root, index, bus: new Bus(root) };
}

// Project decision 2026-11-04: archival is idempotent by ordering (payload unlinked before
// its receipts), so settlement and placement never consult the archive index.
test("settlement and placement perform no archive index I/O, even on a corrupt index", () => {
  const f = fixture([...Array.from({ length: 4096 }, (_, n) => JSON.stringify(row(`archived-${n}`))), "not json"]);
  fs.writeFileSync(join(f.root, "receipts/active-done.done"), "{}");
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "support/archive-membership-entry.ts"), f.root],
    { env: { ...process.env, TAP_LOCK_DIR: join(f.root, "locks") }, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toEqual({ settled: [false, false, true, false], placed: true, indexTouches: 0,
    historyRows: 4096, controlSawIndex: true });
  expect(child.stderr.toString()).toBe("");
});

test("a month manifest skips malformed and torn rows; the files answer lookups", () => {
  const good = row("kept");
  const f = fixture([JSON.stringify(good), "not json", JSON.stringify({ ...row("elsewhere"), month: "2026-11" }), '{"id":"unfinished']);
  const rows = monthIndexRows(f.root, "2026-10");
  expect([...rows.keys()]).toEqual(["kept"]);
  expect(rows.get("kept")).toEqual(good);
  // Lookup is by file, so a manifest row alone is not an archived payload.
  expect(archivedMonth(f.root, "kept")).toBe("");
  fs.writeFileSync(join(f.root, "archive/2026-10/payloads/kept.md"), "---\nid: kept\n---\n");
  expect(archivedMonth(f.root, "kept")).toBe("2026-10");
  expect(archivedMonth(f.root, "../escape")).toBe("");
});

test("unsafe month buckets refuse instead of answering absent", () => {
  const f = fixture([]);
  fs.mkdirSync(join(f.root, "elsewhere/payloads"), { recursive: true });
  fs.writeFileSync(join(f.root, "elsewhere/payloads/x.md"), "x");
  fs.symlinkSync(join(f.root, "elsewhere"), join(f.root, "archive/2026-09"));
  expect(() => archivedMonth(f.root, "x")).toThrow("unsafe archive path");
  fs.symlinkSync(join(f.root, "elsewhere/payloads/x.md"), join(f.root, "archive/2026-10/payloads/y.md"));
  expect(() => archivedMonth(f.root, "y")).toThrow("unsafe archived payload");
});
