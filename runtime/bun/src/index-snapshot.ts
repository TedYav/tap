// Reversibility for destructive machine-index mutations (tap-k140): snapshot
// the index beside itself with a sha256 sidecar before the first delete.
// The helper owns no lock and no stderr: the caller decides the locking
// (doctor --fix snapshots under the index lock it prunes under; admin
// refresh snapshots before its separately-locked de-enrolls) and renders
// its own restore and refusal lines.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface IndexSnapshot { path: string; sha256: string }

export function writeIndexSnapshot(indexPath: string, label: string): IndexSnapshot {
  const recovery = join(dirname(indexPath), "recovery");
  mkdirSync(recovery, { recursive: true });
  const bytes = readFileSync(indexPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const snap = join(recovery, `index-${label}.${randomBytes(6).toString("hex")}.json`);
  writeFileSync(snap, bytes, { flag: "wx", mode: 0o600 });
  try {
    writeFileSync(`${snap}.sha256`, `${sha256}\n`, { flag: "wx", mode: 0o600 });
  } catch (sidecarError) {
    try { unlinkSync(snap); } catch { /* already absent */ }
    throw sidecarError;
  }
  // The snapshot authorizes the destructive step, so make it durable
  // first: both files and the directory entry that names them must
  // survive a power loss that the purge does.
  for (const durable of [snap, `${snap}.sha256`]) {
    const fd = openSync(durable, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  const dirFd = openSync(recovery, "r");
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  return { path: snap, sha256 };
}
