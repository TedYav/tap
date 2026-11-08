// tmux-spawn-cwd.ts — where TAP asks tmux to start a pane, and how the pane
// reaches its working directory.
//
// tmux 3.7 and 3.8 chdir the server process into a pane's `-c` directory for
// the length of each spawn. If the fork fails (`fork failed: Device not
// configured` under pty pressure), spawn_pane returns before changing back, and
// the server keeps that directory as its cwd (tmux issue 5793). When the directory
// is later removed, getcwd fails inside the server, so every later spawn skips
// the chdir, ignores `-c` and inherits the deleted directory (tmux issue 5658). The
// only cure is a server restart (tap-p9v8; 2026-11-05: one refused launch into
// a lane worktree, the worktree reaped hours later, every launch dead after).
//
// So TAP never hands tmux a disposable directory. Panes start in $HOME, which
// outlives every worktree, and the pane command changes into the workdir by
// absolute path before it execs. A failed fork can then strand the server only
// in $HOME, and a server already stranded in a deleted directory still starts
// TAP's programs in the right place. Seat sessions still get their workdir as
// tmux's default directory, best effort, via launcher/session-path.ts.
// Upstream fixes (a8523db8, d34d16b4) are on tmux master and in no release
// yet; this module stays useful until every supported tmux carries them.

import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { shellQuote } from "./shell-quote";

/** The `-c` directory for every TAP spawn: $HOME when it is an existing absolute directory, else "/". */
export function stableSpawnCwd(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? "";
  try { if (isAbsolute(home) && statSync(home).isDirectory()) return home; } catch { /* fall through */ }
  return "/";
}

/** A pane command string that runs `command` in `workdir`, whatever the tmux
 * server's cwd. `command` must replace the shell (start with `exec`, or end in
 * an `exec` after its own assignments) so the pane's process is the program
 * itself, as it was when tmux started the pane in `workdir` directly. A missing
 * workdir fails the pane loudly instead of silently starting it in $HOME. */
export function inWorkdir(workdir: string, command: string): string {
  if (!isAbsolute(workdir)) throw new Error(`pane workdir must be absolute: ${workdir}`);
  return `cd ${shellQuote(workdir)} && ${command}`;
}
