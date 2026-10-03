#!/usr/bin/env bash
# watch-run-lease.test.sh — U6: `tap watch run` loop heartbeat + lease exit.
# The loop is Bun since W3 (watch-run.ts); since the Bash forward went away it
# is reached through the public door, `tap watch run`, whose verb re-execs the
# watch-run.ts loop in place (same pid, the window's and the lease's).
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAPSH="$ROOT/bin/tap"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# Redirect the machine index home: the watch tick invokes tap-escalate.sh
# best-effort on NOTIFY (CONTRACT.md §Escalation). Escalate no longer consults
# any target config: as of v0.21 it invokes the NOTIFIER directly, so what keeps
# a smoke off a real person's phone is sandbox-pins.sh's TAP_NOTIFY_USER_BIN
# default (a nonexistent path -> fail loud), NOT this redirect. The redirect
# stays because the machine index is operator state a smoke must never touch.
export TAP_INDEX_HOME="$WORK/index"

BUS="$WORK/repo/.tap/bus"; mkdir -p "$BUS/payloads" "$BUS/receipts" "$WORK/repo"
cat > "$BUS/registry.json" <<JSON
{"schema": "0.20",  "team": { "name": "t", "worktree_root": "$WORK/repo" }, "seats": {} }
JSON
# Born live (F2a): native verbs refuse an absent machine marker, so enroll the team.
mkdir -p "$TAP_INDEX_HOME"
printf '{"schema":"0.20","teams":{"t":{"root":"%s","registry_location":"%s","state":"registered"}}}\n' \
  "$(mkdir -p "$WORK/repo" && cd "$WORK/repo" && pwd -P)" "$(cd "$BUS" && pwd -P)/registry.json" > "$TAP_INDEX_HOME/global-registry.json"

field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],""))' "$BUS/watch/arm.json" "$1"; }
DEADMAN_SECONDS=300
wait_field() {
  local key="$1" want_nonzero="${2:-1}" producer="${3:-}" val deadline=$((SECONDS + DEADMAN_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    val="$(field "$key" 2>/dev/null || true)"
    if [ -n "$val" ] && { [ "$want_nonzero" != 1 ] || [ "$val" != 0 ]; }; then
      printf '%s' "$val"; return 0
    fi
    [ -z "$producer" ] || kill -0 "$producer" 2>/dev/null || return 1
    sleep 0.1
  done
  return 1
}
wait_field_gt() {
  local key="$1" floor="$2" producer="$3" val deadline=$((SECONDS + DEADMAN_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    val="$(field "$key" 2>/dev/null || true)"
    case "$val" in
      ''|*[!0-9]*) ;;
      *) [ "$val" -gt "$floor" ] && { printf '%s' "$val"; return 0; } ;;
    esac
    kill -0 "$producer" 2>/dev/null || return 1
    sleep 0.1
  done
  return 1
}
wait_gone() {
  local pid="$1" deadline=$((SECONDS + DEADMAN_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  return 1
}

# (1) The running loop stamps its own observable heartbeat and process signature.
TAP_HOME="$BUS" bash "$TAPSH" watch on --by lead -m "done; proof; bound" --evaluator none --threshold 999999 --interval 1 --no-spawn >/dev/null
TAP_HOME="$BUS" bash "$TAPSH" watch run >"$WORK/run.out" 2>"$WORK/run.err" &
run_pid=$!
first="$(wait_field heartbeat_at 1 "$run_pid")" || { echo "watch-run: (1) heartbeat_at was not written before the 300s deadman or watcher exit" >&2; exit 1; }
pid="$(wait_field watcher_pid 1 "$run_pid")" || { echo "watch-run: (1) watcher_pid was not written before the 300s deadman or watcher exit" >&2; exit 1; }
cmd="$(field watcher_command)"
[ "$pid" = "$run_pid" ] || { echo "watch-run: (1) watcher_pid=$pid, expected loop pid $run_pid" >&2; exit 1; }
case "$cmd" in "watch-run.ts run") ;; *) echo "watch-run: (1) watcher_command is not the Bun loop's signature: $cmd" >&2; exit 1 ;; esac
case "$(ps -p "$run_pid" -o command= 2>/dev/null)" in *"watch-run.ts run"*) ;; *) echo "watch-run: (1) pid $run_pid is not the Bun loop (the forward must exec it in place)" >&2; exit 1 ;; esac
wait_field_gt heartbeat_at "$first" "$run_pid" >/dev/null \
  || { echo "watch-run: (1) heartbeat did not advance beyond $first before the 300s deadman or watcher exit" >&2; exit 1; }
echo "watch-run: (1) loop writes advancing heartbeat + process signature: ok"

# (2) Deleting the lease reaps the loop.
rm -f "$BUS/watch/arm.json"
wait_gone "$run_pid" || {
  echo "watch-run: (2) loop still alive after lease deletion" >&2
  kill "$run_pid" 2>/dev/null || true
  exit 1
}
wait "$run_pid" 2>/dev/null || true
echo "watch-run: (2) lease deletion exits the loop: ok"

# (3) A killed loop leaves an armed state that health reports as dead (AE10).
TAP_HOME="$BUS" bash "$TAPSH" watch on --by lead -m "done; proof; bound" --evaluator none --threshold 999999 --interval 1 --no-spawn >/dev/null
TAP_HOME="$BUS" bash "$TAPSH" watch run >"$WORK/run2.out" 2>"$WORK/run2.err" &
run_pid=$!
wait_field watcher_pid 1 "$run_pid" >/dev/null || { echo "watch-run: (3) watcher_pid was not written before kill" >&2; exit 1; }
kill "$run_pid" 2>/dev/null || true
wait "$run_pid" 2>/dev/null || true
set +e
out="$(TAP_HOME="$BUS" bash "$TAPSH" health 2>"$WORK/health.err")"
rc=$?
set -e
[ "$rc" -eq 2 ] || { echo "watch-run: (3/AE10) health should exit 2 for a dead watcher, got $rc" >&2; echo "$out" >&2; cat "$WORK/health.err" >&2; exit 1; }
[[ "$out" == *'armed-but-watcher-dead'* ]] || { echo "watch-run: (3/AE10) health did not name armed-but-watcher-dead" >&2; echo "$out" >&2; exit 1; }
echo "watch-run: (3/AE10) killed sidecar is visible in health: ok"

echo "watch-run-lease: ok"
