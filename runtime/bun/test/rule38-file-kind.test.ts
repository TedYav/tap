// Rule 38's corpus for the file-kind predicates slice W3 ported or widened: every
// `[ -f ]` the incumbent wrote is `statSync(p).isFile()` -- "a regular file, following
// symlinks" -- and each tested path is brought in the three shapes that separate that
// operator from `existsSync`: a DIRECTORY and a SYMLINK TO A DIRECTORY (both exist,
// neither is the file the predicate asks for) and a SYMLINK TO A REGULAR FILE (which
// `-f` follows, so it IS). The rows are per production entry, not per helper: the
// question is what each caller does at its boundary.
//
// Sites (the seven WIDENED rows of tap-ujvou plus the loop's and the stamp's):
//   watch-registry.ts   seatsOf        `[ -f registry.json ]`  -> registryPanes
//   watch-detectors.ts  :425 `.done`   `tap_is_done`           -> oldestUnsettledInbound
//   watch-detectors.ts  :515 registry  `[ -f registry.json ]`  -> realSeams().rosterHandles
//   watch-evaluator.ts  :338 registry  `[ -f registry.json ]`  -> realSeams().rosterHandles
//   watch-evaluate.ts   :195 `.done`   `tap_is_done`           -> hasUnsettled
//   remind.ts           ensureArm      `tap_watch_is_armed`    -> `add`
//   remind.ts           finish         `[ -f ]` before `rm`    -> finish
//   watch-loop.ts       armed / remindersPresent               -> realLoopSeams
//   watch-run.ts        stampOf        `git hash-object`       -> stampOf

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { finish } from "../src/remind";
import { realSeams as detectorSeams, oldestUnsettledInbound } from "../src/watch-detectors";
import { hasUnsettled } from "../src/watch-evaluate";
import { realSeams as evaluatorSeams } from "../src/watch-evaluator";
import { realLoopSeams } from "../src/watch-loop";
import { registryPanes } from "../src/watch-registry";
import { stampOf } from "../src/watch-run";

const REMIND = join(import.meta.dir, "..", "src", "remind.ts");

function scratch(): string { return mkdtempSync(join(tmpdir(), "rule38-w3.")); }

/** The three shapes at `path`, each set up from nothing; `regular` is what the file's real bytes are. */
type Shape = "directory" | "symlink-to-directory" | "symlink-to-regular";
function place(path: string, shape: Shape, regular: string): void {
  rmSync(path, { recursive: true, force: true });
  if (shape === "directory") { mkdirSync(path); return; }
  const target = `${path}.target`;
  rmSync(target, { recursive: true, force: true });
  if (shape === "symlink-to-directory") mkdirSync(target);
  else writeFileSync(target, regular);
  symlinkSync(target, path);
}
const NOT_A_FILE: Shape[] = ["directory", "symlink-to-directory"];
/**
 * A FIFO at the path: exists, and `readFileSync` on it BLOCKS until a writer appears.
 * `[ -f ]` says no without opening it; `existsSync` says yes and the reader hangs. For
 * the registry readers this is the shape that separates the operator from the
 * try/catch behind it (a directory fails the load the same way under either).
 */
function fifo(path: string): void {
  rmSync(path, { recursive: true, force: true });
  const r = spawnSync("mkfifo", [path]);
  if (r.status !== 0) throw new Error(`mkfifo ${path}: ${r.stderr}`);
}

const REGISTRY = JSON.stringify({ schema: "0.20", seats: { h: { status: "active", pane: "%7", harness: "claude" } } });

describe("rule 38: the registry predicates follow `[ -f registry.json ]`", () => {
  test("watch-registry.ts registryPanes: a directory or a symlink to one is no record; a symlink to the file is the file", () => {
    const root = scratch();
    try {
      const reg = join(root, "registry.json");
      writeFileSync(reg, REGISTRY);
      expect(registryPanes(reg, "h", true)).toEqual(["%7"]);
      for (const shape of NOT_A_FILE) { place(reg, shape, REGISTRY); expect(registryPanes(reg, "h", true)).toEqual([]); }
      fifo(reg);
      expect(registryPanes(reg, "h", true)).toEqual([]);              // answered, not blocked
      place(reg, "symlink-to-regular", REGISTRY);
      expect(registryPanes(reg, "h", true)).toEqual(["%7"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("watch-detectors.ts and watch-evaluator.ts rosterHandles over the acting registry", () => {
    const root = scratch();
    try {
      const reg = join(root, "registry.json");
      const bus = join(root, "bus");
      mkdirSync(bus);
      const env = { ...process.env };
      delete env.TAP_WATCH_TICK_ACTIVE; delete env.TAP_WATCH_TICK_ROSTER_HANDLES;
      const readers = [
        () => detectorSeams({ bus, scripts: join(root, "no-scripts"), registry: reg, env, now: "2000" }).rosterHandles(),
        () => evaluatorSeams({ bus, scripts: join(root, "no-scripts"), registry: reg, env }).rosterHandles(),
      ];
      writeFileSync(reg, REGISTRY);
      for (const read of readers) expect(read()).toEqual(["h"]);
      for (const shape of NOT_A_FILE) { place(reg, shape, REGISTRY); for (const read of readers) expect(read()).toEqual([]); }
      fifo(reg);
      for (const read of readers) expect(read()).toEqual([]);          // answered, not blocked
      place(reg, "symlink-to-regular", REGISTRY);
      for (const read of readers) expect(read()).toEqual(["h"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("rule 38: `tap_is_done` is `[ -f receipts/<id>.done ]`", () => {
  const PAYLOAD = "---\nfrom: a\nto: h\nkind: task\n---\nbody\n";
  test("watch-detectors.ts oldestUnsettledInbound and watch-evaluate.ts hasUnsettled: a directory or a symlink to one at the receipt is no receipt; a symlink to a file settles", () => {
    const root = scratch();
    try {
      const payloads = join(root, "payloads"), receipts = join(root, "receipts");
      mkdirSync(payloads); mkdirSync(receipts);
      writeFileSync(join(payloads, "p.md"), PAYLOAD);
      const done = join(receipts, "p.done");
      const now = BigInt(Math.floor(Date.now() / 1000)) + 10n;
      const unsettled = () => [oldestUnsettledInbound(payloads, receipts, "h", now, "t").startsWith("p\t"), hasUnsettled(payloads, receipts)];
      expect(unsettled()).toEqual([true, true]);
      writeFileSync(done, "");
      expect(unsettled()).toEqual([false, false]);
      for (const shape of NOT_A_FILE) { place(done, shape, ""); expect(unsettled()).toEqual([true, true]); }
      place(done, "symlink-to-regular", "");
      expect(unsettled()).toEqual([false, false]);
      // tap-nwbxf: `.cancelled` settles the same way, with the same file-kind rule.
      rmSync(done, { recursive: true, force: true });
      const cancelled = join(receipts, "p.cancelled");
      expect(unsettled()).toEqual([true, true]);
      writeFileSync(cancelled, "");
      expect(unsettled()).toEqual([false, false]);
      for (const shape of NOT_A_FILE) { rmSync(cancelled, { recursive: true, force: true }); place(cancelled, shape, ""); expect(unsettled()).toEqual([true, true]); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("rule 38: the lease is `[ -f arm.json ]`", () => {
  const LEASE = JSON.stringify({ mode: "reminders-only", armed_by: "owner", armed_at: 100, evaluator: "none", tick_interval_seconds: 60 }) + "\n";
  test("remind.ts add (ensureArm): a directory or a symlink to one at the lease's path is refused before any queue write; a symlink to the lease is the lease and is left alone", () => {
    const root = scratch();
    try {
      const bus = join(root, "bus");
      const state = join(bus, "watch", "reminders.json");
      const arm = join(bus, "watch", "arm.json");
      mkdirSync(join(bus, "watch"), { recursive: true });
      const body = join(root, "body");
      writeFileSync(body, "check the gate\n");
      const add = () => spawnSync(process.execPath, [REMIND, state, "add", "owner", "peer", body, "--in", "10s"], { env: { ...process.env, TAP_WATCH_NOW: "100" }, encoding: "utf8" });
      for (const shape of NOT_A_FILE) {
        place(arm, shape, LEASE);
        rmSync(state, { force: true });
        const r = add();
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("is not a regular file; refusing");
        expect(existsSync(state)).toBe(false);
      }
      place(arm, "symlink-to-regular", LEASE);
      rmSync(state, { force: true });
      const ok = add();
      expect(ok.status).toBe(0);
      expect(existsSync(state)).toBe(true);
      expect(lstatSync(arm).isSymbolicLink()).toBe(true);              // not replaced by a fresh lease
      expect(readFileSync(`${arm}.target`, "utf8")).toBe(LEASE);      // the target untouched: it WAS the lease
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("remind.ts finish: a symlink to the idle lease is removed as the link (the target stays); a directory or a symlink to one is refused, never removed", () => {
    // The `isFile` before the unlink is documentary: `read(arm)` runs first and every
    // non-file shape fails there (a directory throws; a dangling link reads as no record),
    // so the guard is reached only for a regular file or a link to one, where `-f` and
    // existence agree. The rows below hold the boundary's behavior, not that line's.
    const root = scratch();
    try {
      const bus = join(root, "bus");
      const state = join(bus, "watch", "reminders.json");
      const arm = join(bus, "watch", "arm.json");
      mkdirSync(join(bus, "watch"), { recursive: true });
      writeFileSync(state, "{}\n");
      place(arm, "symlink-to-regular", LEASE);
      finish(state, "100", false);
      expect(existsSync(arm)).toBe(false);
      expect(readFileSync(`${arm}.target`, "utf8")).toBe(LEASE);
      for (const shape of NOT_A_FILE) {
        place(arm, shape, LEASE);
        expect(() => finish(state, "100", false)).toThrow();
        expect(lstatSync(arm)).toBeDefined();                          // still there
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("watch-loop.ts armed / remindersPresent", () => {
    const root = scratch();
    try {
      const bus = join(root, "bus");
      mkdirSync(join(bus, "watch"), { recursive: true });
      const s = realLoopSeams({ bus, scripts: join(root, "no-scripts"), src: join(root, "no-src"), refresh: () => null, env: { ...process.env } });
      const arm = join(bus, "watch", "arm.json"), reminders = join(bus, "watch", "reminders.json");
      expect([s.armed(), s.remindersPresent()]).toEqual([false, false]);
      writeFileSync(arm, LEASE); writeFileSync(reminders, "{}\n");
      expect([s.armed(), s.remindersPresent()]).toEqual([true, true]);
      for (const shape of NOT_A_FILE) { place(arm, shape, LEASE); place(reminders, shape, "{}\n"); expect([s.armed(), s.remindersPresent()]).toEqual([false, false]); }
      place(arm, "symlink-to-regular", LEASE); place(reminders, "symlink-to-regular", "{}\n");
      expect([s.armed(), s.remindersPresent()]).toEqual([true, true]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("rule 38: the stamp reads a source as `git hash-object` does", () => {
  test("watch-run.ts stampOf: a symlink to a source stamps the target's bytes; a directory or a symlink to one is unreadable", () => {
    const root = scratch();
    try {
      const src = join(root, "a.ts");
      writeFileSync(src, "export const a = 1;\n");
      const viaLink = join(root, "link.ts");
      symlinkSync(src, viaLink);
      expect(stampOf([viaLink])).toBe(stampOf([src]));
      const git = spawnSync("git", ["hash-object", "--no-filters", "--", viaLink], { encoding: "utf8" });
      expect(git.status).toBe(0);
      expect(stampOf([viaLink])).toBe(git.stdout.trim());
      for (const shape of NOT_A_FILE) { place(join(root, "b.ts"), shape, ""); expect(stampOf([src, join(root, "b.ts")])).toBeNull(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
