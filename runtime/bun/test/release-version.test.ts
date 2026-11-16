import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readRelease, compareVersions } from "../src/release-version";
import { removeScratchTree } from "./support/scratch";

const repo = resolve(import.meta.dir, "../../..");
const scratch: string[] = [];
const childEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
afterEach(() => { for (const path of scratch.splice(0)) removeScratchTree(path); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tap-release-version-")); scratch.push(root);
  mkdirSync(join(root, "skills/tap/scripts"), { recursive: true });
  writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n## 0.23.0 — 2026-10-23\n\n### Added\n\n- Numbered releases.\n");
  const run = (...args: string[]) => spawnSync(process.execPath, [join(repo, "runtime/bun/main.ts"), ...args], {
    cwd: root, encoding: "utf8", env: { ...childEnv(), TAP_SCRIPTS_DIR: join(root, "skills/tap/scripts"), TAP_INDEX_HOME: join(root, "index"), TAP_HOME: "", TAP_STATELESS: "0" },
  });
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...childEnv(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } });
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

// A repeat must avoid Git without retaining a stale identity after ref or tag
// changes. Count processes while running real Git.
test("repeated checkout reports skip Git and invalidate for commits and tags", () => {
  const f = fixture();
  f.git("init", "-q"); f.git("add", "CHANGELOG.md"); f.git("commit", "-qm", "Introduce release");
  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  const bin = join(f.root, "bin"), log = join(f.root, "git-calls");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf 'git\\n' >> '${log}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const run = (extra: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [join(repo, "runtime/bun/main.ts"), "version"], {
    cwd: f.root, encoding: "utf8", env: { ...childEnv(), GIT_PAGER: "cat", PATH: `${bin}:${process.env.PATH}`, TAP_SCRIPTS_DIR: join(f.root, "skills/tap/scripts"), ...extra },
  });
  expect(run().stdout).toMatch(/^TAP v0\.23\.0\+0\.g[0-9a-f]{12}\n$/);
  writeFileSync(log, "");
  expect(run().status).toBe(0);
  expect(readFileSync(log, "utf8")).toBe("");
  for (const extra of [
    { GIT_EDITOR: "true" }, { GIT_SEQUENCE_EDITOR: "true" }, { GIT_ASKPASS: "true" },
    { GIT_TERMINAL_PROMPT: "0" }, { GIT_SSH: "false" }, { GIT_SSH_COMMAND: "false" },
  ]) {
    const report = run(extra);
    expect(report.status, report.stderr).toBe(0);
    expect(readFileSync(log, "utf8"), JSON.stringify(extra)).toBe("");
  }
  f.git("commit", "--allow-empty", "-qm", "Advance branch");
  expect(run().stdout).toMatch(/^TAP v0\.23\.0\+1\.g[0-9a-f]{12}\n$/);
  f.git("tag", "v0.23.0");
  expect(run().stdout).toBe("TAP v0.23.0\n");
  f.git("pack-refs", "--all", "--prune");
  expect(run().stdout).toBe("TAP v0.23.0\n");
  f.git("tag", "-d", "v0.23.0");
  expect(run().stdout).toMatch(/^TAP v0\.23\.0\+1\.g[0-9a-f]{12}\n$/);
});

test("linked worktree reports refresh when their branch advances", () => {
  const f = fixture();
  f.git("init", "-q"); f.git("add", "CHANGELOG.md"); f.git("commit", "-qm", "Introduce release");
  const linked = join(f.root, "linked");
  f.git("worktree", "add", "-qb", "linked", linked);
  const run = () => spawnSync(process.execPath, [join(repo, "runtime/bun/main.ts"), "version"], {
    cwd: linked, encoding: "utf8", env: { ...childEnv(), TAP_SCRIPTS_DIR: join(linked, "skills/tap/scripts") },
  });
  expect(run().stdout).toMatch(/^TAP v0\.23\.0\+0\.g[0-9a-f]{12}\n$/);
  expect(run().status).toBe(0);
  f.git("-C", linked, "commit", "--allow-empty", "-qm", "Advance linked branch");
  expect(run().stdout).toMatch(/^TAP v0\.23\.0\+1\.g[0-9a-f]{12}\n$/);
});

test("a warm checkout cache never overrides an explicit Git repository", () => {
  const f = fixture(), other = fixture();
  for (const source of [f, other]) {
    source.git("init", "-q"); source.git("add", "CHANGELOG.md"); source.git("commit", "-qm", "Introduce release");
  }
  f.git("commit", "--allow-empty", "-qm", "Advance primary branch");
  expect(f.run("version").stdout).toMatch(/^TAP v0\.23\.0\+1\.g[0-9a-f]{12}\n$/);
  expect(f.run("version").status).toBe(0);
  const otherHead = other.git("rev-parse", "--short=12", "HEAD");
  const selected = spawnSync(process.execPath, [join(repo, "runtime/bun/main.ts"), "version"], {
    cwd: f.root, encoding: "utf8", env: { ...childEnv(), TAP_SCRIPTS_DIR: join(f.root, "skills/tap/scripts"),
      GIT_DIR: join(other.root, ".git"), GIT_WORK_TREE: other.root },
  });
  expect(selected.status, selected.stderr).toBe(0);
  expect(selected.stdout).toBe(`TAP v0.23.0+0.g${otherHead}\n`);
  writeFileSync(join(f.root, ".git/tap-version.json"), "{broken");
  expect(f.run("version").stdout).toMatch(/^TAP v0\.23\.0\+1\.g[0-9a-f]{12}\n$/);
});
