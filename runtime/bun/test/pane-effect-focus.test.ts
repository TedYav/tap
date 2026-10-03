import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquirePaneLock } from "../src/panelock";
import { flashPaneLocked } from "../src/spool-park-report";

// select-pane -P steals keyboard focus on tmux 3.7c (partner probe, Grok report):
// the cue must tint pane-scoped window styles instead, and never move pane_active.
// The shim records every tmux invocation so the mid-flash tint is observed
// deterministically; the real binary still runs against a private server.
test("flashPaneLocked tints the pane without moving focus and drops its token", () => {
  const socket = join(process.env.TMUX_TMPDIR!, "pane-effect-focus.sock");
  const real = Bun.which("tmux");
  if (!real) throw new Error("tmux binary not found on PATH");
  const shimDir = join(process.env.TAP_HOME!, "tmux-shim");
  mkdirSync(shimDir, { recursive: true });
  const log = join(shimDir, "calls.log");
  writeFileSync(join(shimDir, "tmux"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
exec ${JSON.stringify(real)} "$@"
`, { mode: 0o755 });
  const env = { ...process.env, TAP_TMUX_SOCKET_PATH: socket, TERM: "xterm-256color", PATH: `${shimDir}:${process.env.PATH}` };
  const t = (...args: string[]) => {
    const r = spawnSync(real, ["-S", socket, ...args], { env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const home = process.env.TAP_HOME!;
  try {
    t("-f", "/dev/null", "new-session", "-d", "-s", "focus", "-x", "80", "-y", "24", "cat");
    t("split-window", "-t", "focus", "-h", "cat");
    t("select-pane", "-t", "%0");
    const active = t("list-panes", "-t", "focus", "-F", "#{pane_active} #{pane_id}").split("\n").find(l => l.startsWith("1 "))!.slice(2);
    expect(active).not.toBe("%1");
    const panesBefore = t("list-panes", "-t", "focus", "-F", "#{pane_id} #{pane_active}");
    const lock = acquirePaneLock("%1", 1000, env);
    if (!lock) throw new Error("pane lock unavailable");
    try { flashPaneLocked({ home, pane: "%1", paneId: "%1", ownerId: "focus-regression", style: "bg=blue", env }); }
    finally { lock.release(); }
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("set-option -p -t %1 window-style bg=blue");
    expect(calls).toContain("set-option -p -t %1 window-active-style bg=blue");
    expect(calls).not.toContain("select-pane");
    expect(t("list-panes", "-t", "focus", "-F", "#{pane_id} #{pane_active}")).toBe(panesBefore);
    expect(t("show-options", "-p", "-v", "-t", "%1", "window-style")).toBe("");
    const effects = join(home, "pane-effects");
    expect(existsSync2(effects)).toEqual([]);
  } finally {
    spawnSync(real, ["-S", socket, "kill-server"], { env });
  }
});

function existsSync2(dir: string): string[] {
  try { return readdirSync(dir).filter(n => n.endsWith(".json")); } catch { return []; }
}
