import { spawnSync } from "node:child_process";
import { lstatSync, opendirSync, readSync, rmSync, statSync, type Dir } from "node:fs";
import { join } from "node:path";
import { TapError } from "../context";
import { renderRefusals } from "../error-line";
import { scratchOnlyGuard } from "../out-retire";
import { REGISTRY_MAX_BUFFER } from "../spawn";

const verb = "tap team purge";
function refuse(klass: string, detail: string, action = "tap help team purge"): never {
  throw new TapError(1, klass, action, detail, verb);
}

/** "eof" means no answer came, so consent was never obtained; "no" is the operator's answer. */
function confirmed(target: string, path: string): "yes" | "no" | "eof" {
  const byte = Buffer.alloc(1);
  for (;;) {
    process.stderr.write(`${verb}: delete archive '${target}' at ${path} [y/N] `);
    let answer = "";
    for (;;) {
      if (readSync(0, byte, 0, 1, null) === 0) return "eof";
      if (byte[0] === 10) break;
      answer += byte.toString();
    }
    if (["y", "Y", "yes", "YES", "Yes"].includes(answer)) return "yes";
    if (["", "n", "N", "no", "NO", "No"].includes(answer)) return "no";
    process.stderr.write(`${verb}: choose y or n\n`);
  }
}

function fileLines(path: string): number {
  const dirs: Dir[] = [];
  let current: string | undefined = path, count = 0;
  try {
    while (current !== undefined) {
      const st = lstatSync(current);
      // find -type f | wc -l counts pathname newlines and each hard-link name.
      if (st.isFile()) count += 1 + (current.match(/\n/g)?.length ?? 0);
      else if (st.isDirectory()) dirs.push(opendirSync(current));
      current = undefined;
      while (dirs.length && current === undefined) {
        const dir = dirs.at(-1)!;
        const entry = dir.readSync();
        if (entry) current = join(dir.path, entry.name);
        else { dirs.pop(); dir.closeSync(); }
      }
    }
    return count;
  } finally {
    for (const dir of dirs) dir.closeSync();
  }
}

export function cmdTeamPurge(argv: string[], archiveRoot: string): number {
  return renderRefusals(verb, () => {
    let target = "", yes = false, dryRun = false;
    for (const arg of argv) {
      if (arg === "--yes") yes = true;
      else if (arg === "--dry-run") dryRun = true;
      // Scope comes from teamContext, never public --root/--verb arguments.
      else if (arg.startsWith("--")) refuse("unknown_option", `unknown option '${arg}'`);
      else if (target) refuse("usage_error", `unexpected arg '${arg}'`);
      else target = arg;
    }
    if (!target) refuse("usage_error", `usage: ${verb} <archive> [--dry-run] [--yes]`);
    if (target === "." || target === ".." || target.includes("/")) refuse("usage_error", "archive must be one exact archive name, not a path");
    const path = join(archiveRoot, target);
    let directory = false;
    try { directory = statSync(path).isDirectory(); } catch { /* Match the incumbent -d refusal. */ }
    if (!directory) refuse("not_found", `archive '${target}' does not exist under ${archiveRoot}`, `${verb} <archive>`);
    scratchOnlyGuard(process.env, `the archive ${verb} would delete`, path, verb);

    // Read one directory entry at a time: no archive-wide listing or output cap.
    let files: number;
    try { files = fileLines(path); }
    catch { refuse("archive_unreadable", `could not count archive '${target}' (traversal failed)`); }
    // Keep platform du semantics for links, hard links and allocated KiB.
    const sized = spawnSync("du", ["-sk", path], { encoding: "utf8", maxBuffer: REGISTRY_MAX_BUFFER });
    const size = sized.stdout?.match(/^\s*(\d+)(?:\s|$)/)?.[1];
    if (sized.error || sized.status !== 0 || size === undefined) refuse("archive_unreadable", `could not measure archive '${target}' (du failed)`);
    if (dryRun) {
      process.stdout.write(`${verb}: would delete archive '${target}' (${files} file(s), ${size} KiB)\n`);
      return 0;
    }
    if (!yes) {
      if (!process.stdin.isTTY) refuse("confirmation_required", `refusing to delete archive '${target}' without confirmation — pass --yes (or --dry-run to preview)`, `${verb} ${target} --yes`);
      const answer = confirmed(target, path);
      if (answer === "eof") refuse("aborted", "aborted at confirmation — archive left intact", `${verb} ${target} --yes`);
      // A declined confirmation is the operator's answer, not a failure (CLI-EXIT-0).
      if (answer === "no") { process.stdout.write(`${verb}: declined at confirmation — archive left intact\n`); return 0; }
    }
    // Delete the lexical entry: resolving a directory symlink here would delete its referent.
    try { rmSync(path, { recursive: true, force: true }); }
    catch (error) { refuse("purge_failed", `could not delete archive '${target}': ${(error as Error).message}`); }
    process.stdout.write(`${verb}: deleted archive '${target}' (${files} file(s), ${size} KiB freed)\n`);
    return 0;
  });
}
