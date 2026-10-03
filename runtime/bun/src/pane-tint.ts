import { tmux } from "./tmux";

/**
 * Pane-scoped window style: tints or untints WITHOUT selecting the pane —
 * `select-pane -P` moves pane_active on tmux 3.7c and steals keyboard focus.
 * Untint unsets the two pane options rather than writing `bg=default`: TAP
 * then removes exactly what it set, so the pane inherits again instead of an
 * explicit default overriding the operator's own styles.
 */
export function tintPane(paneId: string, style: string, env: NodeJS.ProcessEnv = process.env): void {
  tmux(["set-option", "-p", "-t", paneId, "window-style", style, ";",
    "set-option", "-p", "-t", paneId, "window-active-style", style], env);
}

export function untintPane(paneId: string, env: NodeJS.ProcessEnv = process.env): void {
  tmux(["set-option", "-p", "-u", "-t", paneId, "window-style", ";",
    "set-option", "-p", "-u", "-t", paneId, "window-active-style"], env);
}
