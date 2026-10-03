import { lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileMatches, fzfNotices, fzfTool, FZF_VERSION, sha256 } from "./fzf-tool";

const REPO = resolve(import.meta.dir, "../../..");
export interface InstallFzfOptions {
  repo?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  arch?: string;
  download?: (url: string) => Promise<Uint8Array>;
}

function pathExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

// A dropped connection, a timeout, a 429 or a 5xx says nothing about the archive,
// so the download retries; any other refusal (404, bad size) fails at once.
export class TransientDownloadError extends Error {}

async function downloadOnce(url: string): Promise<Uint8Array> {
  let response: Response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(30_000) }); }
  catch (error) { throw new TransientDownloadError(`fzf download failed: ${error instanceof Error ? error.message : String(error)}`); }
  if (!response.ok) {
    const message = `fzf download failed: HTTP ${response.status}`;
    throw response.status === 429 || response.status >= 500 ? new TransientDownloadError(message) : new Error(message);
  }
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await response.arrayBuffer()); }
  catch (error) { throw new TransientDownloadError(`fzf download failed: ${error instanceof Error ? error.message : String(error)}`); }
  if (bytes.length === 0 || bytes.length > 16 * 1024 * 1024) throw new Error("fzf download has an invalid size");
  return bytes;
}

export async function retryTransient<T>(once: () => Promise<T>, attempts = 3, delayMs = 2_000): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await once(); }
    catch (error) {
      if (!(error instanceof TransientDownloadError) || attempt >= attempts) throw error;
      await new Promise(done => setTimeout(done, delayMs * attempt));
    }
  }
}

const download = (url: string): Promise<Uint8Array> => retryTransient(() => downloadOnce(url));

// Rename only a fully verified file. A failure leaves the prior installed path
// intact; the installer's ordinary manifest trap records any completed writes.
function publish(path: string, bytes: Uint8Array, mode: number): void {
  const temporary = `${path}.install-${randomUUID()}`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export async function installFzf(options: InstallFzfOptions = {}): Promise<string> {
  const tool = fzfTool(options.env, options.platform, options.arch);
  // Read every shipped notice before making any installation writes.
  const notices = fzfNotices(options.repo || REPO);
  if (!notices.some(n => n.name === "LICENSE" && n.bytes.length)) throw new Error("fzf license is missing");
  for (const path of [tool.cache, tool.binary]) {
    const expected = path === tool.cache ? tool.sha256 : tool.binarySha256;
    if (pathExists(path) && !fileMatches(path, expected)) throw new Error(`preserved changed fzf file ${path}; move it aside and rerun ./install.sh`);
  }
  let archive: Uint8Array;
  if (fileMatches(tool.cache, tool.sha256)) archive = readFileSync(tool.cache);
  else archive = await (options.download || download)(`https://github.com/junegunn/fzf/releases/download/v${FZF_VERSION}/${tool.archive}`);
  if (sha256(archive) !== tool.sha256) throw new Error(`fzf archive checksum mismatch for ${tool.archive}; nothing installed`);
  mkdirSync(tool.directory, { recursive: true });
  if (!fileMatches(tool.cache, tool.sha256)) publish(tool.cache, archive, 0o644);
  const extracted = spawnSync("tar", ["-xOzf", tool.cache, "fzf"], { maxBuffer: 16 * 1024 * 1024 });
  if (extracted.status !== 0 || sha256(extracted.stdout) !== tool.binarySha256) throw new Error("fzf executable extraction or checksum failed; prior executable preserved");
  for (const notice of notices) {
    const path = join(tool.directory, notice.name);
    if (pathExists(path) && !fileMatches(path, sha256(notice.bytes))) throw new Error(`preserved changed fzf notice ${path}; move it aside and rerun ./install.sh`);
  }
  for (const notice of notices) publish(join(tool.directory, notice.name), notice.bytes, 0o644);
  publish(tool.binary, extracted.stdout, 0o755);
  return tool.binary;
}

if (import.meta.main) {
  // Test seam: a local archive stands in for the download. installFzf still checks
  // its sha256 against the pin, so a wrong file is refused, never trusted.
  const archive = process.env.TAP_FZF_TEST_ARCHIVE;
  try { console.log(`install: managed fzf ${FZF_VERSION}: ${await installFzf(archive ? { download: async () => readFileSync(archive) } : {})}`); }
  catch (error) { console.error(`install: ${error instanceof Error ? error.message : String(error)}; next: rerun ./install.sh after fixing the cause`); process.exitCode = 1; }
}
