#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# team-down-registry-tx.test.sh — team down holds registry.lock
# across snapshot/suspend/kill/rollback. Proves (a) kill sees the lock held,
# (b) successful kill leaves seats suspended + concurrent other-row write intact,
# (c) failed-kill rollback restores target rows + concurrent other-row write intact.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
# See team-down.test.sh — inherited TMUX_LIVE_SESSIONS poisons the mock.
unset TMUX_LIVE_SESSIONS
TAP_HOME="$(mktemp -d)"
FAKE_BIN="$(mktemp -d)"
KILL_LOG="$(mktemp)"
LOCK_PROBE="$(mktemp)"
export TAP_HOME KILL_LOG LOCK_PROBE PATH="$FAKE_BIN:$PATH" FAKE_EPOCH_RAW="900:100"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"
KILL_RELEASE="$TAP_HOME/kill.release"
export KILL_RELEASE
trap ': >"$KILL_RELEASE" 2>/dev/null || true; kill ${_WAITER_PID:-} ${DOWN_PID:-} 2>/dev/null || true; rm -rf "$TAP_HOME" "$FAKE_BIN"; rm -f "$KILL_LOG" "$LOCK_PROBE"' EXIT

fail() { echo "team-down-registry-tx: $*" >&2; exit 1; }

cat > "$FAKE_BIN/ps" <<'PS'
#!/usr/bin/env bash
printf '1 faketty\n'
PS
chmod +x "$FAKE_BIN/ps"

# Mock tmux: during kill-session, try a non-blocking flock on registry.lock.
# If the stop path released early, this acquires and records "unlocked".
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"; shift || true
pane_id_for() {
  case "$1" in
    "%101"|"demo/claude:0.0") printf '%%101' ;;
    "%103"|"demo/codex:0.0") printf '%%103' ;;
    "%"*) printf '%s' "$1" ;;
    *) printf '%%%s' "$1" ;;
  esac
}
tty_for() {
  case "$1" in "%101"|"demo/claude:0.0") printf '/dev/faketty' ;; *) return 1 ;; esac
}
case "$cmd" in
  kill-session)
    target=""
    while [ "$#" -gt 0 ]; do case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac; done
    name="${target#=}"
    python3 -B - "${TAP_HOME}/registry.json.lock" "$LOCK_PROBE" <<'PY'
import fcntl, sys
lock_path, probe = sys.argv[1], sys.argv[2]
with open(lock_path, "w") as lock:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        open(probe, "w").write("locked-during-kill\n")
    else:
        open(probe, "w").write("unlocked-during-kill\n")
        fcntl.flock(lock, fcntl.LOCK_UN)
PY
    [ "$(cat "$LOCK_PROBE")" = locked-during-kill ] || exit 99
    deadline=$((SECONDS + 300))
    while [ ! -f "${KILL_RELEASE:?}" ]; do
      [ "$SECONDS" -lt "$deadline" ] || exit 124
      sleep 0.01
    done
    if [ "${TMUX_KILL_FAIL:-0}" = 1 ]; then
      exit 1
    fi
    printf '%s\n' "$name" >> "${KILL_LOG}"
    exit 0 ;;
  has-session)
    target=""
    while [ "$#" -gt 0 ]; do case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac; done
    name="${target#=}"
    if [ "${TMUX_KILL_FAIL:-0}" = 1 ]; then
      exit 0
    fi
    if [ -n "${KILL_LOG:-}" ] && [ -f "$KILL_LOG" ] && grep -qxF "$name" "$KILL_LOG" 2>/dev/null; then
      exit 1
    fi
    exit 0 ;;
  list-panes)
    target=""; all=0
    while [ "$#" -gt 0 ]; do case "$1" in -a) all=1; shift ;; -t) target="$2"; shift 2 ;; -F) shift 2 ;; *) shift ;; esac; done
    [ "$all" = 1 ] && { printf '%%101\t%s\n' "$(tty_for %101)"; exit 0; }
    case "${target#=}" in
      demo/claude) printf '%s\n' '%101' '%102' ;;
      demo/codex)  printf '%s\n' '%103' ;;
      demo/sonnet) printf '%s\n' '%104' ;;
      *) printf '%%p1\n' ;;
    esac
    exit 0 ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) target="$2"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    if [ -z "$target" ]; then
      case "$fmt" in
        *pid*start_time*) echo "${FAKE_EPOCH_RAW:-900:100}" ;;
        *window_index*) echo "demo/claude:0.0" ;;
        *session_name*) echo "demo/claude" ;;
        *) echo "" ;;
      esac
      exit 0
    fi
    case "$fmt" in
      # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
      *pane_id*pane_tty*session_name*)
        resolved="$(pane_id_for "$target")"
        [ -n "$resolved" ] || { echo ""; exit 0; }
        case "$target" in
          "%101"|"demo/claude:0.0") resolved_session="demo/claude" ;;
          "%103"|"demo/codex:0.0") resolved_session="demo/codex" ;;
          *) resolved_session="${target%%:*}" ;;
        esac
        printf '%s\t%s\t%s\t%s\n' "$resolved" "$(tty_for "$resolved" 2>/dev/null || true)" "$resolved_session" "${FAKE_EPOCH_RAW-900:100}" ;;
      *pane_id*session_name*)
        resolved="$(pane_id_for "$target")"
        case "$target" in
          "%101"|"demo/claude:0.0") resolved_session="demo/claude" ;;
          "%103"|"demo/codex:0.0") resolved_session="demo/codex" ;;
          *) resolved_session="${target%%:*}" ;;
        esac
        printf '%s\t%s' "$resolved" "$resolved_session"
        [[ "$fmt" == *pid*start_time* ]] && printf '\t%s' "${FAKE_EPOCH_RAW-900:100}"
        printf '\n' ;;
      *pane_id*pane_tty*)
        resolved="$(pane_id_for "$target")"
        [ -n "$resolved" ] || { echo ""; exit 0; }
        printf '%s\t%s\n' "$resolved" "$(tty_for "$resolved" 2>/dev/null || true)" ;;
      *pane_id*) pane_id_for "$target"; printf '\n' ;;
      *session_name*)
        case "$target" in
          "%101") echo "demo/claude" ;;
          "%103") echo "demo/codex" ;;
          *) echo "${target%%:*}" ;;
        esac ;;
      *) echo "" ;;
    esac
    exit 0 ;;
  *) exit 0 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
export TMUX="/tmp/fake,0,0"

write_fixture() {
  cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "claude":  {"status": "active", "delivery": "pane", "pane": "demo/claude:0.0", "pane_id": "%101", "harness": "claude", "server_epoch": "srv:900:100", "session": "demo/claude"},
    "codex":   {"status": "active", "delivery": "pane", "pane": "demo/codex:0.0",  "pane_id": "%103", "harness": "codex",  "server_epoch": "srv:900:100", "note": "pre", "session": "demo/codex"},
    "pollbot": {"status": "active", "delivery": "poll", "harness": "daemon", "note": "pre"}
  }
}
JSON
}

# Waiter: block on registry.lock, then stamp pollbot.note=post once the lock frees.
start_waiter() {
  local marker="$1"
  rm -f "$marker" "${marker}.pending"
  python3 -B - "$TAP_HOME/registry.json" "$marker" <<'PY' &
import fcntl, json, os, sys, tempfile
path, marker = sys.argv[1], sys.argv[2]
with open(path + ".lock", "w") as lock:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        open(marker + ".pending", "w").write("blocked\n")
    else:
        raise SystemExit("registry writer did not contend with team down")
    fcntl.flock(lock, fcntl.LOCK_EX)
    reg = json.load(open(path))
    agents = reg.get("seats") or {}
    ent = agents.get("pollbot")
    if isinstance(ent, dict):
        ent["note"] = "post"
    d = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tap.")
    with os.fdopen(fd, "w") as fh:
        json.dump(reg, fh, indent=2, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, path)
open(marker, "w").write("done\n")
PY
  _WAITER_PID=$!
}

wait_for_line() { # <path> <expected> <producer-pid> <label>
  local path="$1" expected="$2" producer="$3" label="$4" deadline=$((SECONDS + 300))
  while [ "$(cat "$path" 2>/dev/null || true)" != "$expected" ]; do
    kill -0 "$producer" 2>/dev/null || fail "$label producer exited before publishing '$expected'"
    [ "$SECONDS" -lt "$deadline" ] || fail "$label timed out waiting for '$expected'"
    sleep 0.01
  done
}

agent_field() {
  python3 -B - "$TAP_HOME/registry.json" "$1" "$2" <<'PY'
import json, sys
agents = json.load(open(sys.argv[1])).get("seats") or {}
ent = agents.get(sys.argv[2]) or {}
print(ent.get(sys.argv[3], ""))
PY
}

# --- (1) successful kill: lock held during kill; concurrent pollbot write survives ---
write_fixture
: > "$KILL_LOG"
: > "$LOCK_PROBE"
rm -f "$KILL_RELEASE"
( "$TAP" team down --yes --keep-self >"$TAP_HOME/down.ok.out" 2>&1 || true ) &
DOWN_PID=$!
wait_for_line "$LOCK_PROBE" locked-during-kill "$DOWN_PID" "(1) team down"
start_waiter "$TAP_HOME/waiter.ok"
wait_for_line "$TAP_HOME/waiter.ok.pending" blocked "$_WAITER_PID" "(1) concurrent waiter"
: >"$KILL_RELEASE"
wait "$DOWN_PID"
wait "$_WAITER_PID"
_WAITER_PID=""
out="$(cat "$TAP_HOME/down.ok.out")"
[ -f "$TAP_HOME/waiter.ok" ] || { echo "(1) concurrent waiter never completed" >&2; echo "$out" >&2; exit 1; }
grep -qxF "locked-during-kill" "$LOCK_PROBE" \
  || { echo "(1) registry.lock was NOT held across kill (probe=$(cat "$LOCK_PROBE"))" >&2; echo "$out" >&2; exit 1; }
[ "$(agent_field codex status)" = "suspended" ] \
  || { echo "(1) codex not suspended after successful down" >&2; exit 1; }
[ "$(agent_field codex status_reason)" = "session_stopped" ] \
  || { echo "(1) codex missing session_stopped" >&2; exit 1; }
[ "$(agent_field pollbot note)" = "post" ] \
  || { echo "(1) concurrent pollbot mutation lost after successful kill" >&2; exit 1; }
echo "team-down-registry-tx: (1) success holds lock + preserves concurrent row: ok"

# --- (2) failed kill: lock held; target rows rolled back; concurrent write survives ---
write_fixture
: > "$KILL_LOG"
: > "$LOCK_PROBE"
export TMUX_KILL_FAIL=1
rm -f "$KILL_RELEASE"
( "$TAP" team down --yes --keep-self >"$TAP_HOME/down.fail.out" 2>&1 || true ) &
DOWN_PID=$!
wait_for_line "$LOCK_PROBE" locked-during-kill "$DOWN_PID" "(2) team down"
start_waiter "$TAP_HOME/waiter.fail"
wait_for_line "$TAP_HOME/waiter.fail.pending" blocked "$_WAITER_PID" "(2) concurrent waiter"
: >"$KILL_RELEASE"
wait "$DOWN_PID"
wait "$_WAITER_PID"
_WAITER_PID=""
out="$(cat "$TAP_HOME/down.fail.out")"
[ -f "$TAP_HOME/waiter.fail" ] || { echo "(2) concurrent waiter never completed" >&2; echo "$out" >&2; exit 1; }
grep -qxF "locked-during-kill" "$LOCK_PROBE" \
  || { echo "(2) registry.lock was NOT held across failed kill (probe=$(cat "$LOCK_PROBE"))" >&2; echo "$out" >&2; exit 1; }
[ "$(agent_field codex status)" = "active" ] \
  || { echo "(2) failed-kill did not restore codex to active (got $(agent_field codex status))" >&2; exit 1; }
[ "$(agent_field codex note)" = "pre" ] \
  || { echo "(2) failed-kill rollback lost codex.note=pre" >&2; exit 1; }
[ "$(agent_field pollbot note)" = "post" ] \
  || { echo "(2) concurrent pollbot mutation lost after failed-kill rollback" >&2; exit 1; }
[[ "$out" == *"still live after kill"* || "$out" == *"partially down"* || "$out" == *"refused"* ]] \
  || { echo "(2) failed kill should report refusal/partial-down" >&2; echo "$out" >&2; exit 1; }
unset TMUX_KILL_FAIL
echo "team-down-registry-tx: (2) failed-kill rollback + concurrent preserve: ok"

echo "team-down-registry-tx: ok"
