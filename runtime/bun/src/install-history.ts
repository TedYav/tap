// Ported from scripts/install_history.py (deleted in the same commit): archive
// TAP history, verify every regular file, then remove the originals. The two
// halves are separate exports on purpose — removal is destructive and runs
// only after verification returns, so a caller cannot order the delete before
// the proof without writing it that way.
//
// Boundary rule from docs/solutions/best-practices/
// a-zero-at-the-boundary-describes-the-instrument.md: a stat failure that is
// not ENOENT/ENOTDIR is an UNPROVABLE path, never an absent one, and aborts
// the archive. Python's os.path family reported EACCES/ELOOP as absent here,
// which would have inventoried a partial world and then verified it against
// itself — precisely the silent hole this port closes.
//
// The container format is the system tar's (the machine.test.ts round-trip
// reads it back with `tar -xOf`); members are named with the leading `/`
// stripped, matching the Python tarfile arcnames. Directory recursion yields
// symlinked directories as link leaves and does not descend into them.

import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdtempSync, openSync, readFileSync, readlinkSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

type EntryKind = "link" | "file" | "dir";
type Inventory = Map<string, [EntryKind, string]>;

function errnoAwareAbsent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * One walk of the roots. `key` maps an absolute path to its inventory name:
 * the live tree keys by `str(path).lstrip("/")`; the extracted copy keys by
 * its path under the scratch dir, which lands on the same names.
 */
function inventory(roots: string[], key: (path: string) => string): Inventory {
  const result: Inventory = new Map();
  const addDir = (path: string): void => {
    // An extracted copy's walk base keys to "" and has no live counterpart —
    // Python inventoried tar members, so the base itself is not an entry.
    const k = key(path);
    if (k) result.set(k, ["dir", ""]);
    for (const name of readdirSync(path).sort()) visit(join(path, name));
  };
  const visit = (path: string): void => {
    let stat;
    try { stat = lstatSync(path); } catch (error) {
      if (errnoAwareAbsent(error)) throw new Error(`history root vanished during inventory: ${path}`);
      throw error;
    }
    if (stat.isSymbolicLink()) result.set(key(path), ["link", readlinkSync(path)]);
    else if (stat.isFile()) result.set(key(path), ["file", sha256(readFileSync(path))]);
    else if (stat.isDirectory()) addDir(path);
    else throw new Error(`cannot archive special file ${path}; stop TAP activity and retry`);
  };
  for (const root of roots) {
    let stat;
    try { stat = lstatSync(root); } catch (error) {
      if (errnoAwareAbsent(error)) throw new Error(`history root is missing: ${root}`);
      throw error;
    }
    if (stat.isSymbolicLink()) {
      const k = key(root);
      if (k) result.set(k, ["link", readlinkSync(root)]);
    } else addDir(root);
  }
  return result;
}

function inventoriesEqual(a: Inventory, b: Inventory): boolean {
  if (a.size !== b.size) return false;
  for (const [name, value] of a) {
    const other = b.get(name);
    if (!other || other[0] !== value[0] || other[1] !== value[1]) return false;
  }
  return true;
}

function lstripPath(path: string): string {
  return path.replace(/^\/+/, "");
}

/**
 * The default archive writer: exclusive-create the archive (mode 0600) and
 * stream the system tar's gzip output into that exact fd, so the file either
 * appears whole and owned or not at all. `-C /` with root paths stripped of
 * their leading slash reproduces the Python arcnames.
 */
export function writeTarGz(archive: string, roots: string[]): void {
  let fd: number;
  try {
    fd = openSync(archive, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new Error(`archive already exists: ${archive}`);
    }
    throw error;
  }
  try {
    const result = spawnSync("tar", ["-czf", "-", "-C", "/", ...roots.map(lstripPath)], { stdio: ["ignore", fd, "pipe"] });
    if (result.status !== 0) {
      throw new Error(`tar failed (${result.status}): ${result.stderr?.toString().trim()}`);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Inventory, archive, verify the archive against the inventory, re-inventory
 * the live tree — and stop there. Removal is `removeRoots`, called only by a
 * caller that has seen this return. `writeArchive` is injectable so the
 * verification-failure path has a real control, the way spool-publication's
 * `writeAllSync` injects its writer.
 */
export function archiveHistory(archive: string, roots: string[], writeArchive: (archive: string, roots: string[]) => void = writeTarGz): void {
  if (roots.length === 0) throw new Error("no history roots to archive");
  // Roots are archived AS GIVEN — the member names are lstrip("/") of the
  // given paths, which is the contract the round-trip reads back with.
  const before = inventory(roots, lstripPath);
  writeArchive(archive, roots);
  const scratch = mkdtempSync(join(tmpdir(), "tap-history-verify-"));
  try {
    const extract = spawnSync("tar", ["-xzf", archive, "-C", scratch], { stdio: ["ignore", "ignore", "pipe"] });
    if (extract.status !== 0) {
      throw new Error(`archive does not read back (${extract.status}): ${extract.stderr?.toString().trim()}`);
    }
    // Walk each root AT ITS EXTRACTED POSITION — the archive may carry
    // ancestor directories (macOS /tmp -> /private/tmp) that tar recreates
    // under the scratch root but the live walk never visits. Starting at the
    // roots makes the two inventories visit the same set; keys strip the
    // scratch prefix to the same lstrip("/")-shaped names.
    const extractedRoots = roots.map(root => join(scratch, lstripPath(root)));
    for (const extractedRoot of extractedRoots) {
      // lstat, not existsSync: a symlinked root with a relative target must
      // not be followed into nowhere; ENOENT here is the refusal arm.
      try {
        lstatSync(extractedRoot);
      } catch (error) {
        if (errnoAwareAbsent(error)) {
          throw new Error(`history changed or archive verification failed; originals preserved, inspect ${archive}`);
        }
        throw error;
      }
    }
    const actual = inventory(extractedRoots, path => lstripPath(path.slice(scratch.length)));
    if (!inventoriesEqual(actual, before) || !inventoriesEqual(inventory(roots, lstripPath), before)) {
      throw new Error(`history changed or archive verification failed; originals preserved, inspect ${archive}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The destructive half. Symlinked roots unlink; real trees remove recursively. */
export function removeRoots(roots: string[]): void {
  for (const root of roots) {
    if (lstatSync(root).isSymbolicLink()) unlinkSync(root);
    else rmSync(root, { recursive: true });
  }
}
