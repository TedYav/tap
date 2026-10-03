import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { LauncherError, type SessionRecord } from "./types";

/** Team selection stays anchored at cwd; only the harness starts in launch_workdir. */
export const launchWorkdir = (record: Pick<SessionRecord, "cwd" | "launch_workdir">): string => record.launch_workdir ?? record.cwd;

/** The directory the seat's harness actually runs in. Registry rows anchor team
 * selection at `registered_from_worktree`, but the harness process (and its
 * session store cwd) lives in `launch_workdir` when the seat was launched with
 * one — session-identity observation must key on this, not the registration
 * anchor (discuss-2026-09-25-doctor-ambiguous F1). */
export const harnessWorkdir = (row: { launch_workdir?: unknown; registered_from_worktree?: unknown }): string =>
  typeof row.launch_workdir === "string" && row.launch_workdir ? row.launch_workdir
    : typeof row.registered_from_worktree === "string" ? row.registered_from_worktree : "";

/** Explicit workdirs are existing checkout roots listed by the team's repository. */
export function validateLaunchWorkdir(teamRoot: string, requested: string, relativeTo = process.cwd()): string {
  const refuse = (): never => { throw new LauncherError("invalid_workdir: --workdir must name an existing worktree of the team's repository",
    "invalid_workdir", "run git worktree list from the team root and pass one of its paths to --workdir",
    "--workdir must name an existing worktree of the team's repository"); };
  let path: string;
  try {
    if (typeof requested !== "string" || !requested || requested.includes("\0")) return refuse();
    path = realpathSync(resolve(relativeTo, requested));
    if (!statSync(path).isDirectory()) return refuse();
  } catch { return refuse(); }
  const listed = teamWorktrees(teamRoot);
  if (listed === null || !listed.includes(path)) return refuse();
  return path;
}

/** The realpaths `git worktree list` names for the team's repository, or null when git cannot answer. */
export function teamWorktrees(teamRoot: string): string[] | null {
  const result = spawnSync("git", ["-C", teamRoot, "worktree", "list", "--porcelain", "-z"],
    { encoding: "utf8", timeout: 5000, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) return null;
  return result.stdout.split("\0").filter(field => field.startsWith("worktree "))
    .flatMap(field => { try { return [realpathSync(field.slice(9))]; } catch { return []; } });
}
