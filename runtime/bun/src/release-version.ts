// One release identity for installed TAP, archives and exports. The first level-two
// heading is authoritative: a malformed newest release must not fall back to an older one.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { cacheDigest, runtimeCache } from "./runtime-cache";
import { SENTINEL_VERSION } from "./sentinel";
import { tapRoot, tapScriptsDir } from "./scripts-dir";

export type Release = { version: string; date: string; notes: string };
export class ReleaseError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const NUMBER = "(?:0|[1-9][0-9]*)";
const VERSION = new RegExp(`^(${NUMBER})\\.(${NUMBER})\\.(${NUMBER})$`);
export function compareVersions(a: string, b: string): number {
  const left = VERSION.exec(a), right = VERSION.exec(b);
  if (!left || !right) throw new ReleaseError("invalid_version", "release versions must be three nonnegative integers without leading zeros");
  for (let i = 1; i <= 3; i++) {
    const x = BigInt(left[i]!), y = BigInt(right[i]!);
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}
export function readRelease(source: string, protocol?: string): Release {
  const text = source.replace(/\r\n/g, "\n");
  const headings = [...text.matchAll(/^## (.+)$/gm)];
  const first = headings[0];
  const match = first && /^(\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2})$/.exec(first[1]!);
  if (!match || !VERSION.test(match[1]!)) throw new ReleaseError("invalid_release", "CHANGELOG.md must start with a release heading: ## <version> — <YYYY-MM-DD>");
  const version = match[1]!, date = match[2]!;
  if (!Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)
    throw new ReleaseError("invalid_release_date", "release date must be a calendar date");
  if (protocol !== undefined && version.split(".").slice(0, 2).join(".") !== protocol)
    throw new ReleaseError("release_protocol_mismatch", `release ${version} must match protocol ${protocol}`);
  const notes = text.slice(first!.index! + first![0].length, headings[1]?.index ?? text.length).trim();
  if (!notes.replace(/<!--[\s\S]*?-->/g, "").split("\n").some(line => line.trim() && !/^\s*#/.test(line)))
    throw new ReleaseError("empty_release_notes", `release ${version} needs curated notes`);
  return { version, date, notes };
}

/** Builds retain a unique identity between tags, including the untagged version-heading commit. */
export function versionAtCommit(root: string, commit: string, version: string): string {
  const git = (...args: string[]) => {
    const p = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    return p.status === 0 ? p.stdout.trim() : undefined;
  };
  const head = git("rev-parse", "--short=12", commit);
  if (!head) throw new ReleaseError("release_commit_unknown", "cannot read the build commit");
  const tag = git("rev-parse", "--verify", `refs/tags/v${version}^{commit}`);
  const tagged = tag && git("merge-base", "--is-ancestor", tag, commit) !== undefined;
  const introduced = git("log", "--first-parent", "--reverse", "--format=%H", `-G^## ${version.replaceAll(".", "\\.")} `, commit, "--", "CHANGELOG.md")?.split("\n")[0];
  const base = tagged ? tag : introduced;
  if (!base) return `${version}+g${head}`;
  const count = git("rev-list", "--count", `${base}..${commit}`);
  if (count === undefined) throw new ReleaseError("release_history_unreadable", "cannot count commits since the release");
  return tagged && count === "0" ? version : `${version}+${count}.g${head}`;
}

/** Version display only: no caller identity, registry or delivery consumer. */
function checkoutVersionCache(root: string, version: string) {
  try {
    // Git's environment can select another repository, config or history.
    // Leave those invocations to Git instead of approximating its resolution.
    const interaction = new Set(["GIT_PAGER", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_ASKPASS",
      "GIT_TERMINAL_PROMPT", "GIT_SSH", "GIT_SSH_COMMAND"]);
    if (Object.keys(process.env).some(key => key.startsWith("GIT_") && !interaction.has(key))) return null;
    const optional = (path: string): string | null => {
      try { return readFileSync(path, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    };
    const dotGit = join(root, ".git");
    const pointer = statSync(dotGit).isDirectory() ? null : optional(dotGit);
    if (pointer !== null && !/^gitdir: [^\r\n]+\n?$/.test(pointer)) return null;
    const directory = pointer === null ? dotGit : resolve(root, pointer.slice(8).trim());
    const commonPointer = optional(join(directory, "commondir"));
    const common = commonPointer === null ? directory : resolve(directory, commonPointer.trim());
    // Replacement refs and grafts can change ancestry independently of HEAD.
    if (existsSync(join(common, "refs/replace")) || existsSync(join(common, "info/grafts"))) return null;
    const head = optional(join(directory, "HEAD"))?.trim();
    const branch = head?.match(/^ref: (refs\/heads\/[^\r\n]+)$/)?.[1];
    if (!branch && !/^[0-9a-f]{40,64}$/.test(head ?? "")) return null;
    const branchRef = branch ? optional(join(common, branch)) : null;
    const tag = optional(join(common, `refs/tags/v${version}`));
    const packed = optional(join(common, "packed-refs"));
    // Symbolic refs and other ref-storage formats need Git's own resolver.
    if ([branchRef, tag].some(ref => ref !== null && !/^[0-9a-f]{40,64}$/.test(ref.trim()))) return null;
    if (branch && branchRef === null && !packed?.split("\n").some(line => line.endsWith(` ${branch}`))) return null;
    const identity = {
      schema: 1, root: resolve(root), version, head,
      branch: branchRef, tag, packed,
      shallow: optional(join(common, "shallow")),
      config: optional(join(common, "config")),
      worktreeConfig: optional(join(directory, "config.worktree")),
      path: process.env.PATH,
    };
    return { identity, cache: runtimeCache(directory, "tap-version", identity, 3600,
      (value): value is string => typeof value === "string" && (value === version
        || new RegExp(`^${version.replaceAll(".", "\\.")}\\+(?:[0-9]+\\.)?g[0-9a-f]{12,64}$`).test(value))) };
  } catch { return null; }
}

export function installedVersion(root: string): string {
  const { version } = readRelease(readFileSync(join(root, "CHANGELOG.md"), "utf8"), SENTINEL_VERSION);
  if (existsSync(join(root, ".git"))) {
    const before = checkoutVersionCache(root, version);
    const cached = before?.cache.read();
    if (cached) return cached.snapshot;
    const observed = versionAtCommit(root, "HEAD", version);
    // A ref moving during the Git reads must not publish under its old key.
    const after = checkoutVersionCache(root, version);
    if (before && after && cacheDigest(before.identity) === cacheDigest(after.identity)) before.cache.write(observed);
    return observed;
  }
  const marker = join(root, "tap-release.json");
  if (!existsSync(marker)) return version;
  const build = JSON.parse(readFileSync(marker, "utf8"));
  const suffix = typeof build.version === "string" && build.version.slice(version.length);
  if (build.schema !== 1 || typeof build.version !== "string" || !build.version.startsWith(version)
    || (suffix !== "" && !/^\+(?:[0-9]+\.)?g[0-9a-f]{12,40}$/.test(suffix as string)))
    throw new ReleaseError("invalid_release_marker", "tap-release.json does not match CHANGELOG.md");
  return build.version;
}

export function cmdVersion(args: string[], root = tapRoot(process.env.TAP_SCRIPTS_DIR ?? tapScriptsDir())): number {
  try {
    if (args.length) throw new Error("unexpected argument; use tap help version");
    console.log(`TAP v${installedVersion(root)}`);
    return 0;
  } catch (error) {
    console.error(`tap version: ${(error as Error).message}; next: check the installed CHANGELOG.md or reinstall TAP`);
    return 1;
  }
}
