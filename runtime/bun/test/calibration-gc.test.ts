import { afterAll, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appendObservation, makeObservation } from "../src/calibration";
import { acquireNoFollowLock } from "../src/digest-window";
import { store } from "../../../skills/calibrate-gc/scripts/store";

const root = mkdtempSync(join(tmpdir(), "tap-calibration-gc-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const helper = resolve(import.meta.dir, "../../../skills/calibrate-gc/scripts/store.ts");
let serial = 0;
function fixture(enabled = true) {
  const home = join(root, String(serial++));
  const store = join(home, ".tap/calibration/observations.jsonl");
  mkdirSync(join(home, ".config/tap"), { recursive: true });
  mkdirSync(join(home, ".tap/calibration"), { recursive: true });
  writeFileSync(join(home, ".config/tap/config.toml"), `[calibration]\nenabled = ${enabled}\n`);
  const row = makeObservation({ at: "2026-10-19", route: "codex/example-model", by: "example/writer", ref: "example/ref", note: "Seen: bounded task completed." });
  writeFileSync(store, JSON.stringify(row) + "\n");
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, helper, ...args], { env, stdout: "pipe", stderr: "pipe" });
  return { home, store, row, run, env };
}

test("GC helper preserves exact input and publishes a validated candidate with its report", () => {
  const f = fixture();
  appendObservation(f.store, makeObservation({ ...f.row, ref: "example/other" }));
  const original = readFileSync(f.store);
  const backup = f.run("backup");
  expect(backup.exitCode).toBe(0);
  const archive = backup.stdout.toString().trim();
  expect(archive).toMatch(/\/archive\/observations-[^/]+\.jsonl$/);
  expect(readFileSync(archive)).toEqual(original);
  const candidate = join(f.home, "candidate.jsonl"), report = join(f.home, "report.md");
  const next = JSON.stringify({ ...f.row, ref: "example/ref, example/other" }) + "\n";
  writeFileSync(candidate, next); writeFileSync(report, `2 in, 1 out; merged ${f.row.id}; supporting refs joined.\n`);
  expect(store(["replace", archive, candidate, report], f.env)).toContain("Rows in: 2; rows out: 1");
  expect(readFileSync(f.store, "utf8")).toBe(next);
  expect(readFileSync(archive)).toEqual(original);
  expect(readFileSync(archive.replace(/\.jsonl$/, ".report.md"), "utf8")).toContain("supporting refs joined");
  expect(readFileSync(archive.replace(/\.jsonl$/, ".report.md"), "utf8")).toContain("Status: replaced");
  expect(readdirSync(join(f.home, ".tap/calibration")).filter(x => x.startsWith(".rewrite-"))).toEqual([]);
});

test("an append after backup refuses replacement and preserves both episodes", () => {
  const f = fixture(), archive = f.run("backup").stdout.toString().trim();
  appendObservation(f.store, makeObservation({ ...f.row, note: "Seen: a later episode arrived." }));
  const before = readFileSync(f.store), candidate = join(f.home, "candidate"), report = join(f.home, "report");
  writeFileSync(candidate, ""); writeFileSync(report, "Retire the original route with complete absence evidence.");
  const result = f.run("replace", archive, candidate, report);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("changed");
  expect(readFileSync(f.store)).toEqual(before);
  expect(existsSync(archive.replace(/\.jsonl$/, ".report.md"))).toBe(false);
});

test("GC uses the append sidecar lock for backup and replacement", () => {
  const f = fixture(), archive = f.run("backup").stdout.toString().trim();
  const candidate = join(f.home, "candidate"), report = join(f.home, "report");
  writeFileSync(candidate, ""); writeFileSync(report, "All rows retired with evidence.");
  const lock = acquireNoFollowLock(`${f.store}.lock`, 100);
  try {
    const backup = f.run("backup"), replace = f.run("replace", archive, candidate, report);
    expect(backup.exitCode).not.toBe(0);
    expect(replace.exitCode).not.toBe(0);
    expect(backup.stderr.toString()).toContain("lock busy");
    expect(replace.stderr.toString()).toContain("lock busy");
  } finally { closeSync(lock); }
  expect(readFileSync(f.store)).toEqual(readFileSync(archive));
});

test("disabled, malformed and symlink inputs leave the store untouched", () => {
  const disabled = fixture(false);
  const result = disabled.run("backup");
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("calibration.enabled");
  expect(existsSync(join(disabled.home, ".tap/calibration/archive"))).toBe(false);
  const f = fixture(), original = readFileSync(f.store), archive = f.run("backup").stdout.toString().trim();
  const candidate = join(f.home, "candidate"), report = join(f.home, "report");
  writeFileSync(candidate, '{"note":"invalid"}\n'); writeFileSync(report, "A proposed disposition.");
  expect(f.run("replace", archive, candidate, report).exitCode).not.toBe(0);
  expect(readFileSync(f.store)).toEqual(original);
  rmSync(candidate); symlinkSync(f.store, candidate);
  expect(f.run("replace", archive, candidate, report).exitCode).not.toBe(0);
  expect(readFileSync(f.store)).toEqual(original);
});
