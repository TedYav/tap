import { constants, openSync, closeSync, fstatSync, readFileSync, writeSync, lstatSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/** Append only: preserve every existing byte and never follow a user symlink. */
export function ignoreTap(root: string): void {
  const path = join(root, ".gitignore");
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.nlink !== 1) throw new Error(`${path} is not an ordinary unshared file`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const ignored = spawnSync("git", ["-C", root, "check-ignore", "--no-index", "--quiet", ".tap/"], { encoding: "utf8" });
  if (ignored.status === 0) return;
  if (ignored.status !== 1) throw new Error(`cannot check .tap ignore rule: ${ignored.stderr.trim()}`);
  const fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o666);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw new Error(`${path} is not an ordinary unshared file`);
    const original = readFileSync(fd);
    const newline = original.includes(Buffer.from("\r\n")) ? "\r\n" : "\n";
    const separator = original.length && original[original.length - 1] !== 10 ? newline : "";
    writeSync(fd, `${separator}.tap/${newline}`);
  } finally { closeSync(fd); }
}

if (import.meta.main) {
  try { ignoreTap(process.argv[2]!); }
  catch (error) {
    process.stderr.write(`tap init: could not ignore .tap/: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
