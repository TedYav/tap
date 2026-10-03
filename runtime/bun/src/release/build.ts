// tap-7r3fn.192: build a TAP release artifact from one commit.
//
//   bun runtime/bun/src/release/build.ts --commit <rev> --out <dir> [--repo <checkout>]
//
// Reads only committed bytes. The selection (artifact-paths.ts plus the commit's own
// skill-policy.ts lists) becomes a tree in a scratch index and object directory, with the
// repository's objects as an alternate, so the build never writes into the repository. That
// tree is extracted to compile runtime/bun/main.ts into the router; the router, the Bun shim
// (scripts/release/libexec-bun.sh at the commit), the release marker and the inventory join
// the tree; `git archive --mtime` of the result, through `gzip -n`, is the archive. Archive
// metadata therefore comes from git (fixed mtime, owner and modes), and two builds of one
// commit differ only where the compiled router does.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bunBinary } from "../courier-argv";
import { selectArtifactPaths } from "./artifact-paths";

export class BuildError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export type BuildResult = { archive: string; sha256: string; version: string; commit: string; top: string; files: number; bun: string; bootstrap: string };
type Entry = { mode: string; blob: string; path: string };

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: Buffer | string } = {}): Buffer {
  const result = spawnSync(cmd, args, { cwd: opts.cwd, env: opts.env, input: opts.input, maxBuffer: 1 << 30 });
  if (result.error) throw new BuildError("release_tool_failed", `could not run ${cmd}: ${result.error.message}`);
  if (result.status !== 0) throw new BuildError("release_tool_failed", `${cmd} ${args.slice(0, 3).join(" ")} exited ${result.status}: ${result.stderr.toString().trim()}`);
  return result.stdout;
}

const git = (repo: string, args: string[], opts: { env?: NodeJS.ProcessEnv; input?: Buffer | string } = {}) => run("git", ["-C", repo, ...args], opts);
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

function showAt(repo: string, commit: string, path: string): Buffer {
  try { return git(repo, ["show", `${commit}:${path}`]); }
  catch { throw new BuildError("release_missing_source", `${path} is not tracked at ${commit.slice(0, 12)}`); }
}

/** The core and optional skill lists from the commit's own skill-policy.ts. */
export function skillLists(policySource: string): string[] {
  const list = (name: string) => {
    const match = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(policySource);
    if (!match) throw new BuildError("release_missing_source", `skill-policy.ts has no ${name} list`);
    return [...match[1]!.matchAll(/"([^"]+)"/g)].map(m => m[1]!);
  };
  return [...list("CORE_SKILLS"), ...list("OPTIONAL_SKILLS")];
}

/** `<sha256> <x|-> <path>` for every file but INVENTORY itself, sorted by path. */
export function inventory(files: { path: string; executable: boolean; bytes: Buffer }[]): string {
  return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(file => `${sha256(file.bytes)} ${file.executable ? "x" : "-"} ${file.path}\n`).join("");
}

export function buildArtifact(options: { repo: string; commit: string; out: string }): BuildResult {
  const repo = git(options.repo, ["rev-parse", "--show-toplevel"]).toString().trim();
  let commit: string;
  try { commit = git(repo, ["rev-parse", "--verify", "--quiet", `${options.commit}^{commit}`]).toString().trim(); }
  catch { throw new BuildError("release_commit_unknown", `no commit named ${options.commit}; next: pass a commit or branch that git rev-parse resolves`); }

  const entries: Entry[] = git(repo, ["ls-tree", "-r", "-z", "--full-tree", commit]).toString().split("\0").filter(Boolean).map(line => {
    const [meta, path] = [line.slice(0, line.indexOf("\t")), line.slice(line.indexOf("\t") + 1)];
    const [mode, , blob] = meta.split(" ");
    return { mode: mode!, blob: blob!, path };
  });
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  const selected = selectArtifactPaths(entries.map(entry => entry.path), skillLists(showAt(repo, commit, "runtime/bun/src/skill-policy.ts").toString()));
  for (const path of selected) {
    const { mode } = byPath.get(path)!;
    if (mode !== "100644" && mode !== "100755") throw new BuildError("release_unsupported_entry", `${path} has mode ${mode}; an artifact ships only regular files`);
    if (path.includes("\n")) throw new BuildError("release_unsupported_entry", `a selected path contains a newline: ${JSON.stringify(path)}`);
  }

  const sentinel = /SENTINEL_VERSION\s*=\s*"([^"]+)"/.exec(showAt(repo, commit, "runtime/bun/src/sentinel.ts").toString())?.[1];
  if (!sentinel) throw new BuildError("release_missing_source", "runtime/bun/src/sentinel.ts has no SENTINEL_VERSION");
  const committed = Number(git(repo, ["show", "-s", "--format=%ct", commit]).toString().trim());
  const day = new Date(committed * 1000).toISOString().slice(0, 10).replaceAll("-", "");
  const version = `${sentinel}-${day}-${commit.slice(0, 12)}`;
  const platform = `${process.platform}-${process.arch}`;
  const top = `tap-${version}-${platform}`;
  const shim = showAt(repo, commit, "scripts/release/libexec-bun.sh");
  const bootstrapBytes = showAt(repo, commit, "scripts/release/bootstrap.sh");

  const scratch = mkdtempSync(join(tmpdir(), "tap-release-build-"));
  const previousUmask = process.umask(0o022);
  try {
    const objects = join(scratch, "objects"), tree = join(scratch, "tree");
    mkdirSync(objects); mkdirSync(tree);
    const commonDir = resolve(repo, git(repo, ["rev-parse", "--git-common-dir"]).toString().trim());
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index"), GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(commonDir, "objects") };
    const stage = (rows: Entry[]) => git(repo, ["update-index", "--add", "-z", "--index-info"], { env, input: rows.map(row => `${row.mode} ${row.blob}\t${row.path}\0`).join("") });

    stage(selected.map(path => byPath.get(path)!));
    run("tar", ["-x", "-C", tree], { input: git(repo, ["archive", "--format=tar", git(repo, ["write-tree"], { env }).toString().trim()], { env }) });

    const router = join(scratch, "tap");
    run(bunBinary(), ["build", "--compile", join(tree, "runtime/bun/main.ts"), "--outfile", router], { cwd: scratch });
    const routerBytes = readFileSync(router);
    const marker = `${JSON.stringify({ schema: 1, version, commit, platform, bun: Bun.version }, null, 2)}\n`;
    const generated = [
      { path: "libexec/tap/tap", executable: true, bytes: routerBytes },
      { path: "libexec/tap/bun", executable: true, bytes: shim },
      { path: "tap-release.json", executable: false, bytes: Buffer.from(marker) },
    ];
    const tracked = selected.map(path => ({ path, executable: byPath.get(path)!.mode === "100755", bytes: readFileSync(join(tree, path)) }));
    const all = [...tracked, ...generated];
    generated.push({ path: "INVENTORY", executable: false, bytes: Buffer.from(inventory(all)) });
    stage(generated.map(file => {
      const blob = git(repo, ["hash-object", "-w", "--stdin"], { env, input: file.bytes }).toString().trim();
      return { mode: file.executable ? "100755" : "100644", blob, path: file.path };
    }));

    const finalTree = git(repo, ["write-tree"], { env }).toString().trim();
    const tarBytes = git(repo, ["archive", "--format=tar", `--prefix=${top}/`, `--mtime=@${committed}`, finalTree], { env });
    const gz = run("gzip", ["-n", "-c"], { input: tarBytes });
    mkdirSync(options.out, { recursive: true });
    const archive = join(options.out, `${top}.tar.gz`), digest = sha256(gz), bootstrap = join(options.out, "tap-bootstrap.sh");
    writeFileSync(archive, gz);
    writeFileSync(`${archive}.sha256`, `${digest}  ${top}.tar.gz\n`);
    writeFileSync(bootstrap, bootstrapBytes);
    chmodSync(bootstrap, 0o755);
    return { archive, sha256: digest, version, commit, top, files: all.length + 1, bun: Bun.version, bootstrap };
  } finally {
    process.umask(previousUmask);
    rmSync(scratch, { recursive: true, force: true });
  }
}

const USAGE = "Usage: bun runtime/bun/src/release/build.ts --commit <rev> --out <dir> [--repo <checkout>]";

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) { console.log(USAGE); process.exit(0); }
  const value = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const commit = value("--commit"), out = value("--out"), repo = value("--repo") ?? process.cwd();
  if (!commit || !out) { console.error(`release build: --commit and --out are required\n${USAGE}`); process.exit(2); }
  try {
    const result = buildArtifact({ repo, commit, out: resolve(out) });
    console.log(`release: ${result.archive} sha256=${result.sha256} files=${result.files} commit=${result.commit.slice(0, 12)} bun=${result.bun} bootstrap=${result.bootstrap}`);
  } catch (error) {
    if (!(error instanceof BuildError)) throw error;
    console.error(`release build: ${error.code}: ${error.message}`);
    process.exit(1);
  }
}
