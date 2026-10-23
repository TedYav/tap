import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readRelease, compareVersions } from "../src/release-version";
import { removeScratchTree } from "./support/scratch";

const repo = resolve(import.meta.dir, "../../..");
const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) removeScratchTree(path); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tap-release-version-")); scratch.push(root);
  mkdirSync(join(root, "skills/tap/scripts"), { recursive: true });
  writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n## 0.23.0 — 2026-10-23\n\n### Added\n\n- Numbered releases.\n");
  const run = (...args: string[]) => spawnSync(process.execPath, [join(repo, "runtime/bun/main.ts"), ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, TAP_SCRIPTS_DIR: join(root, "skills/tap/scripts"), TAP_INDEX_HOME: join(root, "index"), TAP_HOME: "", TAP_STATELESS: "0" },
  });
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } });
    expect(result.status, result.stderr).toBe(0); return result.stdout.trim();
  };
  return { root, run, git };
}

test("version spellings report an archive release without enrolling or creating state", () => {
  const f = fixture();
  for (const args of [["--version"], ["version"]]) {
    const result = f.run(...args);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("TAP v0.23.0\n");
    expect(result.stderr).toBe("");
    expect(existsSync(join(f.root, ".tap"))).toBe(false);
    expect(existsSync(join(f.root, "index"))).toBe(false);
  }
});

test("checkout version reports distance from version introduction, then prefers release tag", () => {
  const f = fixture();
  f.git("init", "-q"); f.git("add", "CHANGELOG.md"); f.git("commit", "-qm", "Introduce release");
  f.git("commit", "--allow-empty", "-qm", "Next change");
  const short = f.git("rev-parse", "--short=12", "HEAD");
  expect(f.run("version").stdout).toBe(`TAP v0.23.0+1.g${short}\n`);
  f.git("tag", "v0.23.0");
  expect(f.run("version").stdout).toBe("TAP v0.23.0\n");
});

test("invalid release data and version operands fail without onboarding", () => {
  const f = fixture();
  writeFileSync(join(f.root, "CHANGELOG.md"), "## 0.24.0 — 2026-10-23\n\n- Wrong protocol.\n");
  const invalid = f.run("version");
  expect(invalid.status).toBe(1); expect(invalid.stderr).toContain("protocol");
  expect(f.run("version", "extra").status).toBe(1);
  const help = f.run("version", "--help");
  expect(help.status).toBe(0); expect(help.stdout).toContain("USAGE");
  for (const args of [["--version", "--help"], ["help", "--version"]]) {
    const alias = f.run(...args);
    expect(alias.status).toBe(0); expect(alias.stdout).toBe(help.stdout);
  }
});

test("release parsing preserves only newest notes and rejects malformed, empty and incompatible entries", async () => {
  const source = "# Changelog\n\n## 0.23.10 — 2026-10-23\n\n### Fixed\n\n- A user-facing fix.\n\n## 0.23.9 — 2026-10-22\n\n- Older.\n";
  expect(readRelease(source, "0.23")).toEqual({ version: "0.23.10", date: "2026-10-23", notes: "### Fixed\n\n- A user-facing fix." });
  expect(compareVersions("0.23.10", "0.23.9")).toBe(1);
  expect(compareVersions("0.24.0", "0.23.999")).toBe(1);
  expect(compareVersions("0.23.0", "0.23.0")).toBe(0);
  for (const broken of ["## Unreleased\n\n- x\n\n" + source, source.replace("0.23.10", "0.023.10"), source.replace("2026-10-23", "2026-02-30"), "## 0.23.0 — 2026-10-23\n\n### Added\n<!-- pending -->\n"]) {
    expect(() => readRelease(broken, "0.23")).toThrow();
  }
  expect(() => readRelease(source, "0.24")).toThrow("protocol");
});

test("archive version preserves its build identity from the release marker", () => {
  const f = fixture();
  writeFileSync(join(f.root, "tap-release.json"), JSON.stringify({ schema: 1, version: "0.23.0+4.g0123456789ab", commit: "0123456789ab".padEnd(40, "0") }));
  expect(f.run("version").stdout).toBe("TAP v0.23.0+4.g0123456789ab\n");
});
