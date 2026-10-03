// The installer and picker share one private, pinned executable. PATH is never
// a fallback: a user's fzf options/version are not TAP's interaction contract.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import manifest from "../../../vendor/fzf/manifest.json";
export class FzfToolError extends Error {
  constructor(readonly errorClass: string, readonly action: string, readonly detail: string) { super(detail); }
}

export const FZF_VERSION = manifest.version;
export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const validDigest = (digest: string) => /^[a-f0-9]{64}$/.test(digest);
export function fzfTool(env = process.env, platform: string = process.platform, arch: string = process.arch) {
  const key = `${platform}-${arch}`;
  const asset = manifest.assets[key as keyof typeof manifest.assets];
  if (!asset || !validDigest(asset.sha256) || !validDigest(asset.binarySha256)) {
    throw new FzfToolError("fzf_platform_unsupported", "use an explicit target on a supported TAP platform", `no managed fzf ${FZF_VERSION} for ${key}`);
  }
  const root = resolve(env.TAP_INDEX_HOME || join(env.HOME || homedir(), ".tap"));
  const directory = join(root, "tools", "fzf", `${FZF_VERSION}-${key}`);
  return { ...asset, directory, binary: join(directory, "fzf"), cache: join(directory, asset.archive) };
}

export function fileMatches(path: string, digest: string): boolean {
  if (!validDigest(digest)) return false;
  try { return lstatSync(path).isFile() && sha256(readFileSync(path)) === digest; } catch { return false; }
}

export function managedFzf(env = process.env): string {
  const tool = fzfTool(env);
  let executable = false;
  try { executable = (lstatSync(tool.binary).mode & 0o111) !== 0; } catch { /* unavailable */ }
  if (!executable || !fileMatches(tool.binary, tool.binarySha256)) {
    throw new FzfToolError("fzf_unavailable", "run ./install.sh from the TAP primary checkout, or supply an explicit target", `managed fzf ${FZF_VERSION} is missing or changed at ${tool.binary}`);
  }
  return tool.binary;
}

/** Exact source bytes are the ownership proof; never trust an installed receipt. */
export function fzfNotices(repo: string): { name: string; bytes: Buffer }[] {
  const dir = join(repo, "vendor", "fzf");
  return readdirSync(dir).filter(name => name === "LICENSE" || name.endsWith(".LICENSE") || name === "NOTICE.md")
    .sort().map(name => ({ name, bytes: readFileSync(join(dir, name)) }));
}

export function fzfOwnedFiles(repo: string, indexHome: string): { path: string; sha256: string }[] {
  const tool = fzfTool({ ...process.env, TAP_INDEX_HOME: indexHome });
  return [
    { path: tool.binary, sha256: tool.binarySha256 },
    { path: tool.cache, sha256: tool.sha256 },
    ...fzfNotices(repo).map(n => ({ path: join(tool.directory, n.name), sha256: sha256(n.bytes) })),
  ].filter(item => fileMatches(item.path, item.sha256));
}
