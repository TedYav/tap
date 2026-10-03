#!/usr/bin/env bash
# .70: distinguish a child startup exit from a refused fork before retrying.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d "${TMUX_TMPDIR:-/tmp}/fork-retry.XXXXXX")"
SOCKET="$WORK/tmux.sock"
cleanup() {
  tmux -S "$SOCKET" kill-server 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT
mkdir -p "$ROOT/tmp/fork-retry"
# A child that fails immediately still has a pid and exit status; tmux accepts
# the respawn. Keep server logs as evidence of the discriminator, not a claim
# that the historical intermittent ENXIO has been reproduced.
(
  cd "$WORK"
  # Let tmux reap the original child before reusing its pane. respawn -k
  # closes the old PTY while its child can still be exiting; that lifecycle is
  # irrelevant to the no-effect retry. Keep those child lifetimes disjoint.
  printf '%s\n' 'set -g remain-on-exit on' 'set -g default-shell /bin/sh' > tmux.conf
  wait_exit() {
    local expected="$1" pidfile="$2" facts="" dead="" status="" pid="" signal="" child=""
    local deadline=$((SECONDS + 10))
    while [ "$SECONDS" -lt "$deadline" ]; do
      if ! facts="$(tmux -S "$SOCKET" display-message -p -t probe:0.0 \
          '#{pane_dead}:#{pane_dead_status}:#{pane_pid}:#{pane_dead_signal}' 2>probe.err)"; then
        echo "startup discriminator refused: tmux observation failed: $(cat probe.err)" >&2
        return 1
      fi
      IFS=: read -r dead status pid signal <<< "$facts"
      if [ -n "$signal" ]; then
        echo "startup discriminator refused: child signalled ($signal), not an exit status; facts=$facts" >&2
        return 1
      fi
      if [[ "$dead" == 1 && "$status" =~ ^[0-9]+$ && "$pid" =~ ^[1-9][0-9]*$ && -s "$pidfile" ]]; then
        child="$(cat "$pidfile")"
        [[ "$child" == "$pid" && "$status" == "$expected" ]] || {
          echo "startup discriminator failed: expected status=$expected child-pid=$child; facts=$facts" >&2
          return 1
        }
        printf 'startup exit: pane=%s, child-pid=%s\n' "$facts" "$child"
        return 0
      fi
      sleep 0.05
    done
    echo "startup discriminator refused: incomplete child exit after 10s: pane_dead=${dead:-missing} pane_dead_status=${status:-missing} pane_pid=${pid:-missing} child.pid=$(cat "$pidfile" 2>/dev/null || printf missing)" >&2
    return 1
  }
  tmux -S "$SOCKET" -f "$WORK/tmux.conf" -vv new-session -d -s probe \
    "echo \$\$ > '$WORK/initial.pid'; exit 0"
  wait_exit 0 "$WORK/initial.pid"
  tmux -S "$SOCKET" respawn-pane -t probe:0.0 "echo \$\$ > '$WORK/child.pid'; exit 17"
  wait_exit 17 "$WORK/child.pid"
)
# The native owner now owns the retry predicate. Real tmux above distinguishes
# child exit from fork refusal; the focused matrix exercises the rare refusal.
bash "$ROOT/runtime/bun/test/run.sh" "$ROOT/runtime/bun/test/launcher-fork.test.ts"
echo 'launcher-fork-retry: ok'
