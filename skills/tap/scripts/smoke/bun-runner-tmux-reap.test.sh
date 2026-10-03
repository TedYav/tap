#!/usr/bin/env bash
set -euo pipefail
# bun-runner-tmux-reap.test.sh — the Bun runner reaps its own tmux server
# (tap-7r3fn.19). A fixture test starts a real DETACHED server on the
# runner's own TAP_TMUX_SOCKET inside its TMUX_TMPDIR and records the pane
# pid; after run.sh exits, that pid must be gone (the server tree died with
# the runner's kill-server) and no socket or scratch state may remain. The
# pane pid is the liveness signal because `lsof +D` does not attribute a
# unix listening socket to its server, which is exactly how the old code
# leaked: the scratch was removed under a still-live server.
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
# Nest under the inherited runner root (like run.sh itself): under smoke-all
# the tmux guard only admits sockets under the suite root, and standalone the
# fallback keeps everything in /tmp.
# Keep nesting short: the worker and Bun runner each add a private directory.
WORK="$(mktemp -d "${TMUX_TMPDIR:-/tmp}/r.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/t" "$WORK/fixture-dir"

command -v tmux >/dev/null 2>&1 || { echo "SMOKE-SKIP: bun-runner-tmux-reap requires tmux" >&2; exit 0; }
command -v bun >/dev/null 2>&1 || { echo "SMOKE-SKIP: bun-runner-tmux-reap requires bun" >&2; exit 0; }

# The fixture asserts its own server is up, so a green control proves a
# server really started rather than passing vacuously.
cat > "$WORK/fixture-dir/fixture.test.ts" <<'TS'
import { test, expect } from "bun:test";
test("fixture: a live tmux server rides the runner socket", async () => {
  const socket = process.env.TMUX_TMPDIR! + "/" + process.env.TAP_TMUX_SOCKET!;
  const up = Bun.spawn(["tmux", "-S", socket, "new-session", "-d", "-x", "80", "-y", "24", "sleep", "120"],
    { detached: true, stdio: ["ignore", "ignore", "ignore"] });
  await up.exited;
  const listed = Bun.spawnSync(["tmux", "-S", socket, "list-sessions"]);
  expect(listed.exitCode, listed.stderr.toString()).toBe(0);
  const panes = Bun.spawnSync(["tmux", "-S", socket, "list-panes", "-a", "-F", "#{pane_pid}"]);
  const panePid = panes.stdout.toString().trim().split("\n")[0]!;
  expect(panePid).toMatch(/^[0-9]+$/);
  await Bun.write(process.env.REAP_CONTROL_SOCKET!, socket);
  await Bun.write(process.env.REAP_CONTROL_PANE_PID!, panePid);
});
TS

# run.sh nests its scratch under the inherited TMUX_TMPDIR, so pointing that
# at our own scratch makes the runner's WORK — and any leaked socket inside
# it — observable here. A nonzero runner exit fails the control outright: a
# crashed run must not pass vacuously.
set +e
TMUX_TMPDIR="$WORK/t" \
  REAP_CONTROL_SOCKET="$WORK/server-socket" \
  REAP_CONTROL_PANE_PID="$WORK/pane-pid" \
  bash "$ROOT/runtime/bun/test/run.sh" "$WORK/fixture-dir/fixture.test.ts" >"$WORK/runner.log" 2>&1
runner_rc=$?
set -e
if [ "$runner_rc" -ne 0 ]; then
  cat "$WORK/runner.log" >&2
  echo "bun-runner-tmux-reap: runner exited $runner_rc under the reap control" >&2
  exit 1
fi
[ -s "$WORK/server-socket" ] && [ -s "$WORK/pane-pid" ] || {
  echo "bun-runner-tmux-reap: fixture did not record its server" >&2
  exit 1
}
socket="$(cat "$WORK/server-socket")"
pane_pid="$(cat "$WORK/pane-pid")"

failures=0
if kill -0 "$pane_pid" 2>/dev/null; then
  echo "bun-runner-tmux-reap: server tree (pane pid $pane_pid) survived the runner" >&2
  failures=1
  # Stop the leaked server by its recorded exact socket so this control does
  # not itself leak what it detected (detection by recorded handle, not pattern).
  # The socket file may already be gone (the old code rm -rf'd the scratch
  # under the live server), which makes kill-server unreachable — so also stop
  # the recorded pane pid; the session's death ends the server.
  tmux -S "$socket" kill-server 2>/dev/null || true
  kill "$pane_pid" 2>/dev/null || true
fi
leaked_sockets="$(find "$WORK/t" -type s -print 2>/dev/null || true)"
if [ -n "$leaked_sockets" ]; then
  echo "bun-runner-tmux-reap: socket file survived the runner: $leaked_sockets" >&2
  failures=1
fi
if [ -n "$(find "$WORK/t" -mindepth 1 -print 2>/dev/null)" ]; then
  echo "bun-runner-tmux-reap: scratch tree retained after the run" >&2
  failures=1
fi
[ "$failures" = 0 ] || exit 1
echo "bun-runner-tmux-reap: runner reaped its own tmux server and scratch: ok"
