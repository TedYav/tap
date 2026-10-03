#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# team-stop-watch-lease.test.sh — tap-1fcto R5 U0: `tap team shutdown` (policy
# clear) disarms the watcher lease at the shared stop boundary; `tap team down`
# (policy suspend) PRESERVES it — a selected one-seat down included — and
# policy `none` (reset-stop) keeps its own custody, not re-tested here
# (regress/watch-arm-lease.test.sh, 4/AE7, already proves reset archives
# watch/ and reaps the lease; this suite stays out of that ownership).
# Covers: armed shutdown (lease AND registry gone), armed down (lease,
# reminders.json and notify.json preserved byte for byte, registry suspended,
# only recorded sessions killed), armed zero-row down and shutdown on each side
# of the policy split, a REFUSED clear (registry and lease retained), dry-run
# (lease intact), and one-seat `down --only codex` (lease stays armed, the
# selected seat stops, the spared live seat is not killed).
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
TAP_HOME="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
KILL_LOG="$(mktemp)"
WINDOWS="$(mktemp)"
cleanup() {
  rm -rf "${TAP_HOME:?}"
  rm -rf "${FAKE_BIN:?}"
  rm -f "${KILL_LOG:?}"
  rm -f "${WINDOWS:?}"
}
trap cleanup EXIT
REAL_PY="$(command -v python3)"
export TAP_HOME KILL_LOG PATH="$FAKE_BIN:$PATH" FAKE_WINDOWS="$WINDOWS"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"

# teamstop r5 U4B: the locked-clear race arm (3c) moved to the native
# orchestrator suite — runtime/bun/test/team-stop.test.ts, zero-row case where
# ctx.registryPath corrupts on second access (readRowDump feeds clean, the
# locked clear re-reads corrupt): registry_unreadable, registry retained,
# watcher lease untouched. The helper-level half of the same race stays
# pinned in runtime/bun/test/team-stop-clear.test.ts (locked-fresh-read rc 5).

cat > "$FAKE_BIN/ps" <<'PS'
#!/usr/bin/env bash
printf '1 faketty\n'
PS
chmod +x "$FAKE_BIN/ps"

# Mock tmux: the team-shutdown pattern — kill-session appends to $KILL_LOG,
# has-session reports killed sessions gone, display-message resolves the caller
# pane to demo/claude:0.0 (seat "claude") with the matching server epoch.
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"; shift || true
pane_id_for() {
  case "$1" in
    "demo/claude:0.0") printf '%%101' ;;
    "demo/codex:0.0")  printf '%%103' ;;
    "%"*) printf '%s' "$1" ;;
    *) printf '%%%s' "$1" ;;
  esac
}
# tap-bzyz: one TTY source per pane; both tmux queries derive from it.
tty_for() {
  case "$1" in "%101"|"demo/claude:0.0") printf '/dev/faketty' ;; *) return 1 ;; esac
}
session_for() {
  case "$1" in
    "%101"|"demo/claude:0.0") printf 'demo/claude' ;;
    "%103"|"demo/codex:0.0")  printf 'demo/codex' ;;
    *) printf '%s' "${1%%:*}" ;;
  esac
}
case "$cmd" in
  kill-session)
    target=""
    while [ "$#" -gt 0 ]; do case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac; done
    printf '%s\n' "${target#=}" >> "${KILL_LOG}"
    exit 0 ;;
  has-session)
    target=""
    while [ "$#" -gt 0 ]; do case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac; done
    # Post-kill probe: a session recorded in KILL_LOG is gone.
    if grep -qxF "${target#=}" "$KILL_LOG" 2>/dev/null; then exit 1; fi
    exit 0 ;;
  list-panes)
    printf '%%101\t%s\n' "$(tty_for %101)"
    exit 0 ;;
  list-windows)
    fmt=""; while [ "$#" -gt 0 ]; do case "$1" in -F) fmt="${2:-}"; shift 2 ;; *) shift ;; esac; done
    while IFS= read -r _w; do
      [ -n "$_w" ] || continue
      printf '%s\n' "$_w"
    done < "$FAKE_WINDOWS" 2>/dev/null || true ;;
  new-window)
    # record the spawned (waiter/sidecar) window; print a fake pane pid
    echo tap-remind-waiter >> "$FAKE_WINDOWS"; echo "99999" ;;
  kill-window)
    grep -vx tap-remind-waiter "$FAKE_WINDOWS" > "$FAKE_WINDOWS.tmp" 2>/dev/null || true
    mv "$FAKE_WINDOWS.tmp" "$FAKE_WINDOWS" 2>/dev/null || true ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) target="${2:-}"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    if [ -z "$target" ]; then
      case "$fmt" in
        *pid*start_time*) echo "900:100" ;;
        *window_index*) echo "demo/claude:0.0" ;;
        *session_name*) echo "demo/claude" ;;
        *) echo "" ;;
      esac
      exit 0
    fi
    case "$fmt" in
      # Four-field calling observe (pane_id+pane_tty+session_name+generation),
      # the identity-first record implicit identity consumes directly.
      *pane_id*pane_tty*session_name*)
        resolved="$(pane_id_for "$target")"
        [ -n "$resolved" ] || { echo ""; exit 0; }
        printf '%s\t%s\t%s\t%s\n' "$resolved" "$(tty_for "$resolved")" "$(session_for "$target")" "900:100" ;;
      *pane_id*session_name*)
        resolved="$(pane_id_for "$target")"
        printf '%s\t%s' "$resolved" "$(session_for "$target")"
        [[ "$fmt" == *pid*start_time* ]] && printf '\t%s' "900:100"
        printf '\n' ;;
      *pane_id*pane_tty*)
        resolved="$(pane_id_for "$target")"
        [ -n "$resolved" ] || { echo ""; exit 0; }
        printf '%s\t%s\n' "$resolved" "$(tty_for "$resolved")" ;;
      *pid*start_time*) echo "900:100" ;;
      *session_name*) session_for "$target" ;;
      *pane_id*) pane_id_for "$target"; printf '\n' ;;
      *) echo "" ;;
    esac
    exit 0 ;;
  *) exit 0 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
export TMUX="/tmp/fake,0,0"

ARM="$TAP_HOME/watch/arm.json"
NOTIFY="$TAP_HOME/watch/notify.json"
REMINDERS="$TAP_HOME/watch/reminders.json"

# Caller is "claude" (self, demo/claude); teammate codex (demo/codex). Both
# epoch-proven so the stop engine keeps legacy id-anchored resolution.
write_fixture() {
  cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "claude": {"status": "active", "delivery": "pane", "pane": "demo/claude:0.0", "pane_id": "%101", "harness": "claude", "server_epoch": "srv:900:100", "session": "demo/claude"},
    "codex":  {"status": "active", "delivery": "pane", "pane": "demo/codex:0.0",  "pane_id": "%103", "harness": "codex",  "server_epoch": "srv:900:100", "session": "demo/codex"}
  }
}
JSON
}

arm_lease() {
  "$TAP" watch on --by codex -m "suite watch" --evaluator none --no-spawn >/dev/null 2>&1
  [ -f "$ARM" ] || { echo "team-stop-watch-lease: arming did not write the lease" >&2; exit 1; }
}

# --- (1) armed down --yes: lease PRESERVED (byte-identical), reminders/notify
#         untouched, registry suspended, only recorded sessions killed --------
write_fixture
: > "$KILL_LOG"
arm_lease
remind_err="$(printf 'wake up\n' | "$TAP" remind codex --in 8m -f - 2>&1 1>/dev/null)" \
  || { echo "team-stop-watch-lease: (1) tap remind did not schedule: $remind_err" >&2; exit 1; }
[ -f "$REMINDERS" ] || { echo "team-stop-watch-lease: (1) no reminders file after tap remind" >&2; exit 1; }
cp "$REMINDERS" "$TAP_HOME/reminders.before"
printf '{}\n' > "$NOTIFY"
down_rc=0
down_out="$("$TAP" team down --yes </dev/null 2>&1)" || down_rc=$?
if [ "$down_rc" != 0 ]; then
  echo "team-stop-watch-lease: (1) down rc=$down_out rc=$down_rc" >&2
  echo "team-stop-watch-lease: (1) KILL_LOG:" >&2; cat "$KILL_LOG" >&2
  echo "team-stop-watch-lease: (1) registry:" >&2; cat "$TAP_HOME/registry.json" >&2
  exit 1
fi
[ -f "$ARM" ] || { echo "team-stop-watch-lease: (1) RED-expected: suspend down disarmed the preserved lease" >&2; exit 1; }
# The lease must STAY ARMED; tint bookkeeping on stopped panes may still churn
# its bytes (supervision-lib tap_watch_set), so no byte-identity pin here.
cmp -s "$TAP_HOME/reminders.before" "$REMINDERS" \
  || { echo "team-stop-watch-lease: (1) reminders.json was not preserved byte-for-byte" >&2; exit 1; }
printf '{}\n' | cmp -s - "$NOTIFY" \
  || { echo "team-stop-watch-lease: (1) notify.json was not preserved" >&2; exit 1; }
[ -f "$TAP_HOME/registry.json" ] || { echo "team-stop-watch-lease: (1) down deleted the registry (down retains it)" >&2; exit 1; }
python3 -B - "$TAP_HOME/registry.json" <<'PY' || { echo "team-stop-watch-lease: (1) down did not suspend the roster rows" >&2; exit 1; }
import json, sys
agents = json.load(open(sys.argv[1])).get("seats") or {}
assert agents and all(a.get("status") == "suspended" for a in agents.values()), agents
PY
[ -s "$KILL_LOG" ] || { echo "team-stop-watch-lease: (1) down killed nothing" >&2; exit 1; }
while IFS= read -r killed; do
  case "$killed" in
    demo/claude|demo/codex) ;;
    *) echo "team-stop-watch-lease: (1) kill log names an unrecorded session: $killed" >&2; exit 1 ;;
  esac
done < "$KILL_LOG"
grep -qx "demo/codex" "$KILL_LOG"  || { echo "team-stop-watch-lease: (1) teammate codex session not stopped" >&2; exit 1; }
grep -qx "demo/claude" "$KILL_LOG" || { echo "team-stop-watch-lease: (1) self session not stopped" >&2; exit 1; }
echo "team-stop-watch-lease: (1) armed down keeps the lease, preserves reminders+notify, suspends roster: ok"

# --- (2) armed shutdown --yes: lease gone AND registry gone --------------------
write_fixture
: > "$KILL_LOG"
arm_lease
"$TAP" team shutdown --yes </dev/null >/dev/null
[ ! -f "$ARM" ] || { echo "team-stop-watch-lease: (2) armed lease SURVIVED tap team shutdown --yes" >&2; exit 1; }
[ ! -e "$TAP_HOME/registry.json" ] || { echo "team-stop-watch-lease: (2) shutdown did not delete the registry" >&2; exit 1; }
echo "team-stop-watch-lease: (2) armed shutdown disarms and deletes the registry: ok"

# --- (3) policy split at zero rows: down keeps the lease, shutdown removes it --
printf '{"schema": "0.20", "team":{"name":"demo"},"seats":{}}\n' > "$TAP_HOME/registry.json"
: > "$KILL_LOG"
arm_lease
"$TAP" team down --yes </dev/null >/dev/null
[ -f "$ARM" ] || { echo "team-stop-watch-lease: (3) RED-expected: zero-row down disarmed the preserved lease" >&2; exit 1; }
echo "team-stop-watch-lease: (3a) armed zero-row down keeps the lease: ok"
printf '{"schema": "0.20", "team":{"name":"demo"},"seats":{}}\n' > "$TAP_HOME/registry.json"
arm_lease
"$TAP" team shutdown --yes </dev/null >/dev/null
[ ! -f "$ARM" ] || { echo "team-stop-watch-lease: (3) zero-row shutdown left the lease armed" >&2; exit 1; }
[ ! -e "$TAP_HOME/registry.json" ] || { echo "team-stop-watch-lease: (3) zero-row shutdown did not delete the registry" >&2; exit 1; }
echo "team-stop-watch-lease: (3b) armed zero-row shutdown disarms: ok"

# (3c) the refused zero-row clear race is the native orchestrator case above;
# the shell file keeps the public terminal watch arms only.

# --- (4) dry-run leaves the lease intact ---------------------------------------
write_fixture
arm_lease
cp "$ARM" "$TAP_HOME/arm.before"
"$TAP" team down --dry-run </dev/null >/dev/null
[ -f "$ARM" ] || { echo "team-stop-watch-lease: (4) dry-run disarmed the lease" >&2; exit 1; }
cmp -s "$TAP_HOME/arm.before" "$ARM" \
  || { echo "team-stop-watch-lease: (4) dry-run mutated the lease" >&2; exit 1; }
echo "team-stop-watch-lease: (4) dry-run leaves the lease intact: ok"

# --- (5) tap-1fcto: one-seat down --only codex — the lease stays armed, the
#     selected seat stops, and the spared live seat (self: claude) survives ---
write_fixture
: > "$KILL_LOG"
arm_lease
"$TAP" team down --only codex --yes </dev/null >/dev/null
[ -f "$ARM" ] || { echo "team-stop-watch-lease: (5) one-seat down disarmed the preserved lease" >&2; exit 1; }
grep -qx "demo/codex" "$KILL_LOG" \
  || { echo "team-stop-watch-lease: (5) the selected seat codex was not stopped" >&2; exit 1; }
grep -qx "demo/claude" "$KILL_LOG" \
  && { echo "team-stop-watch-lease: (5) the spared live seat claude was killed" >&2; exit 1; }
python3 -B - "$TAP_HOME/registry.json" <<'PY' || { echo "team-stop-watch-lease: (5) roster rows diverged from the contract" >&2; exit 1; }
import json, sys
agents = json.load(open(sys.argv[1])).get("seats") or {}
assert agents.get("codex", {}).get("status") == "suspended", agents
assert agents.get("claude", {}).get("status") == "active", agents
PY
echo "team-stop-watch-lease: (5) one-seat down keeps the lease, stops codex, spares claude: ok"

echo "team-stop-watch-lease: ok"
