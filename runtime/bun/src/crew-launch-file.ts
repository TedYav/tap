// Fresh crew shells preserve their pane PID by execing a short file reference.
// The invocation (including environment values) never travels through the tty.
import { closeSync, constants, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TapError } from "./context";
import { shellQuote } from "./shell-quote";

const rootPath = (home: string) => join(home, ".tap", "crew-launch");
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

function privateDirectory(path: string, forbiddenMode = 0o077): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & forbiddenMode) !== 0) {
    throw new TapError(1, "crew_launch_storage_unsafe", `inspect ${path} ownership and permissions`,
      `crew launch storage '${path}' must be a private user-owned directory, not a symlink (mode 0${(stat.mode & 0o777).toString(8)})`);
  }
}

function discard(dir: string): void {
  try { unlinkSync(join(dir, "launch.sh")); } catch (error) { if (!missing(error)) throw error; }
  try { rmdirSync(dir); } catch (error) { if (!missing(error)) throw error; }
}

/** Best-effort cleanup never blocks another crew operation. Preserve queued
 * startups for five minutes (above the 60s harness wait), even if their creator
 * exited. A one-day age bound handles recycled PIDs. */
export function cleanupCrewLaunchFiles(home = homedir()): void {
  const root = rootPath(home);
  let names: string[];
  try { privateDirectory(join(home, ".tap"), 0); privateDirectory(root); names = readdirSync(root); }
  catch { return; }
  for (const name of names) {
    const match = /^([1-9][0-9]*)-[A-Za-z0-9]{6}$/.exec(name);
    if (!match) continue;
    const dir = join(root, name);
    try {
      privateDirectory(dir);
      const age = Date.now() - lstatSync(dir).mtimeMs;
      if (age < 300000) continue;
      if (age < 86400000) {
        try { process.kill(Number(match[1]), 0); continue; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue; }
      }
      discard(dir);
    } catch { /* Unsafe, unreadable or concurrently consumed: reap nothing. */ }
  }
}

export function prepareCrewLaunchFile(invocation: string, home = homedir()): { command: string; discard(): void } {
  const state = join(home, ".tap"), root = rootPath(home);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  // Existing TAP state follows the user's umask (often 002 on Linux). Only
  // the secret-bearing storage below it must be private; neither may be a link.
  privateDirectory(state, 0);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  privateDirectory(root);
  const dir = mkdtempSync(join(root, `${process.pid}-`)), file = join(dir, "launch.sh");
  try {
    const command = `exec /bin/sh ${shellQuote(file)}`;
    if (Buffer.byteLength(command) + 1 >= 1024) throw new TapError(1, "crew_launch_path_too_long", "use a shorter home directory path", "crew launch file reference exceeds the terminal input limit");
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      // /bin/sh has opened the file before either unlink. Its fd remains valid;
      // cleanup cannot race an outer login shell that has not read the command.
      writeFileSync(fd, `/bin/rm -f -- ${shellQuote(file)} || exit 1\n/bin/rmdir -- ${shellQuote(dir)} || exit 1\nexec env ${invocation}\n`);
    } finally { closeSync(fd); }
    return { command, discard: () => discard(dir) };
  } catch (error) { discard(dir); throw error; }
}
