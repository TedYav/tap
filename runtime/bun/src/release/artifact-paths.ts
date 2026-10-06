// tap-7r3fn.192: what a release artifact ships. The runtime tree an installed `tap` reads or
// executes, and nothing a contributor alone needs. Skill directories come from skill-policy.ts
// (core and optional), the same lists install.sh links; everything else is an allow glob
// here. A deny glob always wins. A distribution archive is built from the public copy (plan
// KD3), so these lists name only paths that copy holds. A build from a tree that also holds
// private-only paths selects them too; such an archive stays in scratch.

/** Non-skill paths the artifact ships. */
export const ARTIFACT_ALLOW = [
  "bin/tap",
  "compat/skills/**",
  ".claude-plugin/marketplace.json",
  "plugins/tap/**",
  "install.sh",
  "hooks/**",
  "runtime/bun/main.ts",
  "runtime/bun/src/**",
  // agent-state.ts adapts Herdr; its Apache-2.0 notice ships with the code.
  "runtime/bun/third_party/**",
  "completions/**",
  // fzf-tool.ts imports manifest.json statically; install-fzf.ts copies the notices.
  "vendor/fzf/**",
  "README.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "CONCEPTS.md",
  // README links the push-not-poll section.
  "docs/PHILOSOPHY.md",
  "docs/GETTING-STARTED.md",
  "docs/TAP-LEVELS.md",
  "docs/SKILLS.md",
  "docs/COMMUNITY-FEATURES.md",
  "docs/EASY-MODE.md",
  "docs/AGENT-SETUP.md",
  "docs/RELEASE-ARTIFACTS.md",
  "docs/CHEATSHEET.md",
  "docs/attach-launch-reference.md",
  "docs/index.html",
  // `tap setup --machine` opens docs/cheatsheet.html on macOS.
  "docs/cheatsheet*.html",
  "docs/assets/**",
] as const;

/** Paths no artifact ships, even when an allow glob or a skill directory selects them. */
export const ARTIFACT_DENY = [
  "runtime/bun/src/release/**",
  "skills/tap/scripts/smoke/**",
  "skills/tap/scripts/regress/**",
  "skills/tap/scripts/research/**",
  "**/*.test.ts",
  "**/*.test.sh",
] as const;

const allow = ARTIFACT_ALLOW.map(glob => new Bun.Glob(glob));
const deny = ARTIFACT_DENY.map(glob => new Bun.Glob(glob));

/**
 * The artifact selection over a commit's tracked paths: an allow glob or a shipped skill
 * directory selects a path; any deny glob removes it. Returns the selected paths sorted.
 */
export function selectArtifactPaths(paths: readonly string[], skills: readonly string[]): string[] {
  const skillPrefixes = skills.map(name => `skills/${name}/`);
  return paths
    .filter(path => allow.some(glob => glob.match(path)) || skillPrefixes.some(prefix => path.startsWith(prefix)))
    .filter(path => !deny.some(glob => glob.match(path)))
    .sort();
}
