// Mechanical custody only. The frontier seat owns every consolidation decision.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseObservations } from "../../../runtime/bun/src/calibration";
import { calibrationEnabled, calibrationStorePath } from "../../../runtime/bun/src/verbs/calibrate";
import { acquireNoFollowLock } from "../../../runtime/bun/src/digest-window";

function read(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${path} is not a regular file`);
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
function writeExclusive(path: string, bytes: Uint8Array | string): void {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function syncDir(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function store(argv: string[], env: NodeJS.ProcessEnv = process.env): string {
  if (!(argv.length === 1 && argv[0] === "backup") && !(argv.length === 4 && argv[0] === "replace")) {
    throw new Error("usage: bun store.ts backup | replace <backup.jsonl> <candidate.jsonl> <report.md>");
  }
  if (!calibrationEnabled(env)) throw new Error("calibration.enabled is false; next: tap config set calibration.enabled true");
  const path = calibrationStorePath(env), archiveDir = join(dirname(path), "archive");
  const lock = acquireNoFollowLock(`${path}.lock`, 2500);
  let temp: string | undefined;
  try {
    const active = read(path), before = parseObservations(active);
    if (argv[0] === "backup") {
      mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
      if (!lstatSync(archiveDir).isDirectory()) throw new Error("archive must be a real directory");
      const stamp = new Date().toISOString().replace(/[-:]/g, "");
      const archive = join(archiveDir, `observations-${stamp}.jsonl`);
      writeExclusive(archive, active);
      syncDir(archiveDir); syncDir(dirname(path));
      return `${archive}\n`;
    }
    const backup = resolve(argv[1]!);
    if (dirname(backup) !== archiveDir || !/^observations-\d{8}T\d{6}\.\d{3}Z\.jsonl$/.test(backup.slice(archiveDir.length + 1))) {
      throw new Error("backup must name an observations-<UTC>.jsonl file in the calibration archive");
    }
    if (!lstatSync(archiveDir).isDirectory()) throw new Error("archive must be a real directory");
    const input = read(backup);
    if (!active.equals(input)) throw new Error("active observations changed since backup; rebuild from a fresh backup");
    const candidate = read(argv[2]!), after = parseObservations(candidate);
    const report = new TextDecoder("utf-8", { fatal: true }).decode(read(argv[3]!));
    if (!report.trim()) throw new Error("a nonempty disposition report is required");
    temp = join(dirname(path), `.rewrite-${randomUUID()}`);
    writeExclusive(temp, candidate);
    const reportPath = backup.replace(/\.jsonl$/, ".report.md");
    const receipt = `Rows in: ${before.length}; rows out: ${after.length}\nInput SHA256: ${hash(input)}\nOutput SHA256: ${hash(candidate)}\n\n${report.trim()}\n`;
    // A prepared report surviving a failed rename is evidence of an incomplete
    // attempt; only the completion line below claims the replacement happened.
    const reportFd = openSync(reportPath, "wx", 0o600);
    try {
      writeFileSync(reportFd, `Status: prepared\n${receipt}`); fsyncSync(reportFd);
      syncDir(archiveDir); // Persist the report's name before the rewrite can become durable.
      if (!read(path).equals(input)) throw new Error("active observations changed before replacement; rebuild from a fresh backup");
      renameSync(temp, path); temp = undefined;
      syncDir(dirname(path));
      writeFileSync(reportFd, "\nStatus: replaced\n"); fsyncSync(reportFd);
    } finally { closeSync(reportFd); }
    return `Replaced ${path}; report: ${reportPath}\n${receipt}`;
  } finally {
    try { if (temp) unlinkSync(temp); }
    finally { closeSync(lock); }
  }
}
if (import.meta.main) {
  try { process.stdout.write(store(process.argv.slice(2))); }
  catch (error) { console.error(`calibrate-gc: ${(error as Error).message}`); process.exitCode = 1; }
}
