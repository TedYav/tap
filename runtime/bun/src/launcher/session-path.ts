// session-path.ts — give a seat session its workdir as tmux's default
// directory without spawning a pane there.
//
// TAP creates seat sessions with `-c $HOME` (tmux-spawn-cwd.ts), which also
// makes $HOME the session's default directory (`#{session_path}`): the place a
// person's prefix-c or split opens when they give no -c. Only `attach-session
// -c` changes that default on a live session, and in tmux 3.7/3.8 it assigns
// the directory before it opens the client's terminal. A client with no
// terminal therefore sets the directory and then fails with "not a terminal"
// before anything attaches: no attach hooks, no attached-count or size change.
//
// That ordering is undocumented, so this is a best-effort courtesy, never a
// launch dependency. The read-back of `#{session_path}`, not the expected
// nonzero exit, confirms it. When it does not take, the session keeps (or is
// given back) the stable directory, which is safe. TAP's own spawns keep
// passing -c $HOME either way. Restoring the default reopens only vanilla
// tmux's exposure: a pane someone creates without -c can strand the server in
// that worktree if its fork fails (tap-p9v8).

import { launchCommand } from "./process";

/** tmux format-expands attach-session's -c. In tmux 3.8's format_expand1 a run
 * of #s directly before `[` is copied verbatim (style syntax), while any other
 * run of n #s becomes n/2. So double each maximal run except one before `[`. */
export const tmuxLiteral = (value: string): string =>
  value.replace(/#+/g, (run: string, at: number) => value[at + run.length] === "[" ? run : run + run);

/** True only when the session's default directory now reads back as `workdir`.
 * On a mismatch it puts back the directory the session had, so an unconfirmed
 * value is never left behind. `encode` exists for tests. */
export async function restoreSessionPath(socket: string, sessionId: string, workdir: string,
  env: NodeJS.ProcessEnv, signal?: AbortSignal, encode: (path: string) => string = tmuxLiteral): Promise<boolean> {
  // An explicit socket, with TMUX unset so the client is not refused as nested.
  // launchCommand gives the client no terminal, so the attach cannot take one.
  const childEnv = { ...env };
  delete childEnv.TMUX;
  delete childEnv.TMUX_PANE;
  const tmux = (...args: string[]) => launchCommand(["tmux", "-S", socket, ...args], { env: childEnv, signal, timeoutMs: 2000 });
  const sessionPath = async (): Promise<string | null> => {
    const read = await tmux("display-message", "-p", "-t", sessionId, "#{session_path}");
    return read.code === 0 ? read.stdout.replace(/\n$/, "") : null;
  };
  try {
    const before = await sessionPath();
    if (before === null) return false;
    await tmux("attach-session", "-E", "-t", sessionId, "-c", encode(workdir));
    if (await sessionPath() === workdir) return true;
    await tmux("attach-session", "-E", "-t", sessionId, "-c", encode(before));
    return false;
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}
