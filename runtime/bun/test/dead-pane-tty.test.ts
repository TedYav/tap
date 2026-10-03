import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeCallingPane } from "../src/context";
import { removeScratchTree } from "./support/scratch";

const scratch = mkdtempSync(join(tmpdir(), "tap-dead-tty."));
const socket = `dead-tty-${process.pid}`;
const realTmux = Bun.which("tmux")!;
const tmuxEnv = { ...process.env };
delete tmuxEnv.TMUX;
delete tmuxEnv.TMUX_PANE;
const T = (...args: string[]) => {
  const result = spawnSync(realTmux, ["-L", socket, ...args], { env: tmuxEnv, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
};
let live: string;
let env: NodeJS.ProcessEnv;

beforeAll(() => {
  // Keep a real remain-on-exit pane, created first so the stale tty sorts first.
  const dead = T("new-session", "-d", "-s", "stale", "-P", "-F", "#{pane_id}", "sleep 60");
  T("set-option", "-w", "-t", dead, "remain-on-exit", "on");
  T("respawn-pane", "-k", "-t", dead, "exit 0");
  live = T("new-session", "-d", "-s", "fresh", "-P", "-F", "#{pane_id}", "sleep 60");
  for (let i = 0; i < 100 && T("display-message", "-p", "-t", dead, "#{pane_dead}") !== "1"; i++) Bun.sleepSync(10);
  expect(T("display-message", "-p", "-t", dead, "#{pane_dead}")).toBe("1");

  const bin = join(scratch, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ps"), "#!/bin/sh\nprintf '1 faketty\\n'\n", { mode: 0o755 });
  // Force deterministic tty reuse while leaving pane_dead and -f evaluation to
  // real tmux. Without the production query filter both panes claim this tty.
  writeFileSync(join(bin, "tmux"), `#!/bin/bash
args=()
for arg in "$@"; do args+=( "\${arg//'#{pane_tty}'//dev/faketty}" ); done
exec "$DEAD_TTY_TMUX" -L "$DEAD_TTY_SOCKET" "\${args[@]}"
`, { mode: 0o755 });
  env = { ...tmuxEnv, PATH: `${bin}:${process.env.PATH}`, DEAD_TTY_TMUX: realTmux, DEAD_TTY_SOCKET: socket,
    TAP_INDEX_HOME: join(scratch, "index") };
  delete env.TAP_TMUX_SOCKET;
  delete env.TAP_TMUX_SOCKET_PATH;
  delete env.TAP_CALLING_PANE_SOCKET;
  const inventory = spawnSync(join(bin, "tmux"), ["list-panes", "-a", "-F", "#{pane_id}\t#{pane_tty}\t#{pane_dead}"], { env, encoding: "utf8" });
  expect(inventory.status).toBe(0);
  expect(inventory.stdout.trim().split("\n").sort()).toEqual([
    `${dead}\t/dev/faketty\t1`, `${live}\t/dev/faketty\t0`,
  ].sort());
});

afterAll(() => {
  T("kill-server");
  removeScratchTree(scratch);
});

for (const readOnly of [false, true]) {
  test(`Bun caller chooses the live pane sharing a dead pane's tty (readOnly=${readOnly})`, () => {
    expect(observeCallingPane(env, readOnly)).toMatchObject({ state: "inside", paneId: live, session: "fresh" });
  });
}
