import { acquirePathLock } from "./panelock";
import { createHash } from "node:crypto";
import { readFileSync, statSync, lstatSync, mkdirSync, writeFileSync, realpathSync, constants, openSync, closeSync, fstatSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { tapRoot } from "./scripts-dir";

export const LAUNCH_TEAM = "tap session launch <harness|preset> <name>";

export function noTeamMessage(cwd = process.cwd()): string {
  return `No TAP team in ${cwd.replace(/[\r\n]/g, " ")}. Start one: ${LAUNCH_TEAM} (for example: tap launch claude newcomer) — or tap init for an empty team.`;
}

const hasBlock = (text: string) => /<!-- tap:begin -->[\s\S]*?<!-- tap:end -->/i.test(text);

function charterAppend(current: Buffer): Buffer | null {
  const text = current.toString("utf8");
  if (hasBlock(text)) return null;
  if (/<!-- tap:(?:begin|end) -->/i.test(text)) throw new Error("incomplete TAP signpost; run tap setup --repo");
  const section = readFileSync(join(tapRoot(), "skills/tap/templates/repo-charter.md"));
  const separator = current.length ? (current.at(-1) === 10 ? "\n" : "\n\n") : "";
  return Buffer.concat([Buffer.from(separator), section]);
}

/** Inspect the same append as apply without creating a file, notice or lock. */
export function repoCharterAppend(root: string): Buffer | null {
  const path = join(root, "AGENTS.md");
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error("AGENTS.md is not an ordinary unshared file");
  return charterAppend(stat ? readFileSync(path) : Buffer.alloc(0));
}

export function repoCharterLock(root: string): string {
  const index = process.env.TAP_INDEX_HOME || join(process.env.HOME!, ".tap");
  const key = createHash("sha256").update(realpathSync(root)).digest("hex");
  return join(index, "repo-setup-locks", key);
}

/** First-team creation adds the TAP signpost without replacing existing instructions. */
export function ensureRepoCharter(root: string, inGit: boolean, reportIssue = repoSetupHeadsUp): void {
  const path = join(root, "AGENTS.md");
  try {
    const lockPath = repoCharterLock(root);
    mkdirSync(dirname(lockPath),{recursive:true});
    const lock = acquirePathLock(lockPath);
    if (!lock) { reportIssue(root); return; }
    try {
      const fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o644);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1) throw new Error("AGENTS.md is not an ordinary unshared file");
        const current = readFileSync(fd);
        const append = charterAppend(current);
        if (append) writeSync(fd, append);
        else return;
      } finally { closeSync(fd); }
    } finally { lock.release(); }
    process.stderr.write(`tap init: added project TAP signpost to AGENTS.md${inGit ? "" : " in this directory (not a git repository)"}.\n`);
  } catch { reportIssue(root); }
}

/** Advisory only: missing or unreadable instructions never prevent team use. */
export function repoSetupHeadsUp(root: string): void {
  try {
    const path = join(root, "AGENTS.md");
    const text = statSync(path).isFile() ? readFileSync(path, "utf8") : "";
    if (hasBlock(text)) return;
  } catch { /* A missing or unreadable file needs the same setup hint. */ }
  try {
    const index = process.env.TAP_INDEX_HOME || join(process.env.HOME!, ".tap");
    let install = "uninstalled";
    try { const stat = statSync(join(index,"install-manifest.json")); install = `${stat.mtimeMs}:${stat.size}`; } catch {}
    const key = createHash("sha256").update(realpathSync(root)+"\0"+install).digest("hex");
    const directory = join(index,"repo-setup-notices");
    mkdirSync(directory,{recursive:true});
    writeFileSync(join(directory,key),"\n",{flag:"wx",mode:0o600});
  } catch { return; }
  process.stderr.write("tap: AGENTS.md has no readable TAP signpost; run tap setup --repo.\n");
}

if (import.meta.main) {
  const root = process.argv[2] ?? process.cwd();
  if (process.argv[3] === "--ensure") ensureRepoCharter(root, process.argv[4] === "1");
  else repoSetupHeadsUp(root);
}
