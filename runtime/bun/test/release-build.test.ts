// tap-7r3fn.192: the release build's selection, inventory and archive (runtime/bun/src/release/).
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { selectArtifactPaths } from "../src/release/artifact-paths";
import { BuildError, buildArtifact, inventory, skillLists } from "../src/release/build";
import { CORE_SKILLS, OPTIONAL_SKILLS } from "../src/skill-policy";

const REPO = resolve(import.meta.dir, "../../..");
const scratch: string[] = [];
afterAll(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });
const dir = (prefix: string) => { const made = realpathSync(mkdtempSync(join(tmpdir(), prefix))); scratch.push(made); return made; };

function trackedAtHead(): string[] {
  const listed = spawnSync("git", ["-C", REPO, "ls-tree", "-r", "-z", "--name-only", "--full-tree", "HEAD"], { encoding: "utf8", maxBuffer: 1 << 28 });
  expect(listed.status, listed.stderr).toBe(0);
  return listed.stdout.split("\0").filter(Boolean);
}

const selection = () => selectArtifactPaths(trackedAtHead(), skillLists(readFileSync(join(REPO, "runtime/bun/src/skill-policy.ts"), "utf8")));

// Check Markdown links and HTML links/assets readers encounter before and during setup.
function missingReaderLinks(selected: Set<string>): string[] {
  const missing: string[] = [];
  for (const page of ["README.md", "SECURITY.md", "docs/AGENT-SETUP.md", "docs/setup.md", "docs/GETTING-STARTED.md", "docs/EASY-MODE.md",
    "docs/TAP-LEVELS.md", "docs/SKILLS.md", "docs/COMMUNITY-FEATURES.md", "docs/CHEATSHEET.md", "docs/RELEASE-ARTIFACTS.md",
    ...[...selected].filter(path => path.startsWith("docs/") && path.endsWith(".html"))]) {
    const links = page.endsWith(".html") ? /(?:href|src)="([^"]+)"/g : /\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g;
    for (const match of readFileSync(join(REPO, page), "utf8").matchAll(links)) {
      const target = match[1]!.split(/[?#]/)[0]!;
      if (!target || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
      const path = posix.normalize(target.startsWith("/") ? target.slice(1) : posix.join(posix.dirname(page), target));
      if (!selected.has(path)) missing.push(`${page} -> ${path}`);
    }
  }
  return missing;
}

test("the shipped reader entry pages have no missing local link targets", () => {
  const selected = new Set(selection());
  expect(missingReaderLinks(selected)).toEqual([]);
  // The pre-clone agent guide ships and is read as an entry page; the landing page prompt points at it.
  expect(selected.has("docs/setup.md")).toBe(true);
  selected.delete("docs/GETTING-STARTED.md");
  expect(missingReaderLinks(selected)).toContain("README.md -> docs/GETTING-STARTED.md");
  selected.delete("docs/assets/theme.js");
  expect(missingReaderLinks(selected)).toContain("docs/cheatsheet.html -> docs/assets/theme.js");
  selected.delete("docs/index.html");
  expect(missingReaderLinks(selected)).toContain("docs/cheatsheet-skills.html -> docs/index.html");
});

test("skill lists parse from skill-policy.ts source exactly as the module exports them", () => {
  expect(skillLists(readFileSync(join(REPO, "runtime/bun/src/skill-policy.ts"), "utf8"))).toEqual([...CORE_SKILLS, ...OPTIONAL_SKILLS]);
});

test("the selection at HEAD ships the runtime tree an installed tap reads", () => {
  const selected = new Set(selection());
  for (const path of ["bin/tap", "install.sh", "runtime/bun/main.ts", "runtime/bun/src/artifact-bun-preload.ts", "skills/tap/config/config.v3.toml",
    "skills/tap/scripts/run-shell-logged.sh", "skills/tap/scripts/watch-templates/notice.md", "completions/_tap", "CHANGELOG.md",
    "docs/attach-launch-reference.md", "skills/lead/references/ingest/README.md", "vendor/fzf/LICENSE", "vendor/fzf/manifest.json", "runtime/bun/third_party/herdr/LICENSE",
    "hooks/tap-shell-body-guard.ts", "docs/cheatsheet.html", "docs/RELEASE-ARTIFACTS.md", "SECURITY.md", "docs/TAP-LEVELS.md", "docs/COMMUNITY-FEATURES.md",
    "compat/skills/tap-double-check/SKILL.md", "compat/skills/tap-coach/SKILL.md", "compat/skills/tap-abandon-branch/SKILL.md"]) {
    expect(selected.has(path), path).toBe(true);
  }
});

test("the selection at HEAD leaves out tests, tracker state, release tooling and contributor material", () => {
  const selected = selection();
  const leaked = selected.filter(path => [/^runtime\/bun\/test\//, /^runtime\/bun\/src\/release\//,
    /^skills\/tap\/scripts\/(smoke|regress|research)\//, /^skills\/(coach|abandon-branch)\//, /^\.beads\//, /^AGENTS\.md$/,
    /^publish\//, /^docs\/plans\//, /^docs\/solutions\//, /^scripts\//, /\.test\.(ts|sh)$/].some(re => re.test(path)));
  expect(leaked).toEqual([]);
});

test("the selected skill directories are exactly the core and optional skills", () => {
  const skills = new Set(selection().filter(path => path.startsWith("skills/")).map(path => path.split("/")[1]!));
  expect([...skills].sort()).toEqual([...CORE_SKILLS, ...OPTIONAL_SKILLS].sort());
});

test("the inventory is sorted, flags executables and excludes nothing it is given", () => {
  const text = inventory([
    { path: "b", executable: false, bytes: Buffer.from("b") },
    { path: "a/x", executable: true, bytes: Buffer.from("") },
  ]);
  expect(text).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 x a/x\n3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d - b\n");
});

test("an unknown commit refuses with a named error and writes nothing", () => {
  const out = join(dir("tap-release-unknown-"), "out");
  let error: unknown;
  try { buildArtifact({ repo: REPO, commit: "no-such-commit-7r3fn", out }); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(BuildError);
  expect((error as BuildError).code).toBe("release_commit_unknown");
  expect(existsSync(out)).toBe(false);
});

test("two builds of HEAD give one top directory of files and directories, the same inventory, and a receipt", () => {
  const first = buildArtifact({ repo: REPO, commit: "HEAD", out: dir("tap-release-a-") });
  const second = buildArtifact({ repo: REPO, commit: "HEAD", out: dir("tap-release-b-") });
  expect(first.version).toMatch(/^\d+\.\d+-\d{8}-[0-9a-f]{12}$/);
  expect(readFileSync(`${first.archive}.sha256`, "utf8")).toBe(`${first.sha256}  ${first.top}.tar.gz\n`);
  expect(existsSync(first.bootstrap)).toBe(true);

  const listing = spawnSync("tar", ["-tvzf", first.archive], { encoding: "utf8", maxBuffer: 1 << 26 });
  expect(listing.status, listing.stderr).toBe(0);
  const lines = listing.stdout.trim().split("\n");
  expect(lines.every(line => line.startsWith("-") || line.startsWith("d"))).toBe(true);
  const names = spawnSync("tar", ["-tzf", first.archive], { encoding: "utf8", maxBuffer: 1 << 26 }).stdout.trim().split("\n");
  expect(new Set(names.map(name => name.split("/")[0]))).toEqual(new Set([first.top]));
  expect(names.filter(name => !name.endsWith("/")).length).toBe(first.files);

  const extract = (archive: string) => {
    const into = dir("tap-release-x-");
    expect(spawnSync("tar", ["-xzf", archive, "-C", into]).status).toBe(0);
    return join(into, readdirSync(into)[0]!);
  };
  const a = extract(first.archive), b = extract(second.archive);
  const tracked = (root: string) => readFileSync(join(root, "INVENTORY"), "utf8").split("\n").filter(line => line && !line.endsWith(" libexec/tap/tap"));
  expect(tracked(a)).toEqual(tracked(b));
  expect(JSON.parse(readFileSync(join(a, "tap-release.json"), "utf8"))).toMatchObject({ schema: 1, version: first.version, commit: first.commit, bun: Bun.version });
  console.log(`release-build: archives byte-identical=${first.sha256 === second.sha256} (${first.sha256.slice(0, 12)} vs ${second.sha256.slice(0, 12)})`);
}, 240000);
