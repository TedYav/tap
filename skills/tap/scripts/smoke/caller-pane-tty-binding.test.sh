#!/usr/bin/env bash
# Native caller-refusal rendering: whoami and team shutdown preserve reasons
# without duplicate stderr or false alarms from a best-effort lookup.
set -uo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0; fail=0
ok()  { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n' "$1"; }

echo "caller-pane-tty-binding: native refusal rendering"

export TAP_HOME="$WORK/.tap/bus"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"

# --- fake tmux -----------------------------------------------------------------
# Models BOTH facts the site reads, and lets them disagree — which is the whole
# point. SCAN_MAP is what `list-panes -a` reports (the binding at observation 1);
# LIVE_MAP is what `display-message -t <id>` reports (observation 2). A server
# replacement is simulated by leaving an id in LIVE_MAP while SCAN_MAP has moved
# that tty to a different pane, or while the id's own tty has changed.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/tmux" <<'FAKE'
#!/usr/bin/env bash
cmd="${1:-}"; shift || true
case "$cmd" in
  list-panes)
    # `list-panes -a -F '#{pane_id}\t#{pane_tty}'` — emit the SCAN map verbatim.
    printf '%s' "${SCAN_MAP:-}"
    ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -p) shift ;;
        -t) target="$2"; shift 2 ;;
        *)  fmt="$1"; shift ;;
      esac
    done
    # LIVE_MAP lines are "<pane_id><TAB><pane_tty>". A target absent from it is a
    # dead pane. Answer the requested fields from the SAME row, so a composite
    # format is answered consistently rather than one-field-per-glob.
    row=""
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      lid="${line%%	*}"
      [ "$lid" = "$target" ] || continue
      row="$line"; break
    done <<< "${LIVE_MAP:-}"
    [ -n "$row" ] || exit 0          # dead: exit 0 with EMPTY output (tmux 3.6a)
    lid="${row%%	*}"; ltty="${row#*	}"
    out="$fmt"
    out="${out//'#{pane_id}'/$lid}"
    out="${out//'#{pane_tty}'/$ltty}"
    printf '%s' "$out"
    ;;
  *) exit 0 ;;
esac
FAKE
chmod +x "$WORK/bin/tmux"
export PATH="$WORK/bin:$PATH"

# Pin process observations rather than using the runner's controlling tty.
cat > "$WORK/bin/ps" <<'FAKEPS'
#!/usr/bin/env bash
pid=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -p) pid="$2"; shift 2 ;;
    *) shift ;;
  esac
done
case "${FAKE_PS_MODE:-tty}" in
  missing) exit 0 ;;
  invalid-parent) printf '%s %s\n' "invalid" "?" ;;
  root) printf '%s %s\n' "1" "?" ;;
  depth) printf '%s %s\n' "$((pid + 1))" "?" ;;
  outside-child)
    if [ "$pid" = "${FAKE_CALLER_PID:-}" ]; then
      printf '%s %s\n' "777" "ttys009"
    else
      printf '%s %s\n' "1" "ttys001"
    fi
    ;;
  *) printf '%s %s\n' "1" "${FAKE_CALLER_TTY:-ttys999}" ;;
esac
FAKEPS
chmod +x "$WORK/bin/ps"
export FAKE_CALLER_TTY="ttys001"

# (k) default output has one renderer and carries the internal reason -------------
human_out="$WORK/human.out"
human_err="$WORK/human.err"
set +e
FAKE_PS_MODE=missing "$TAP" whoami >"$human_out" 2>"$human_err"
human_rc=$?
set -e
human_lines="$(wc -l <"$human_err" | tr -d ' ')"
if [ "$human_rc" -eq 1 ] && [ ! -s "$human_out" ] && [ "$human_lines" = 1 ] \
    && grep -Fq "tap whoami:" "$human_err" \
    && grep -Fq "process observation unavailable" "$human_err"; then
  ok "(k) default whoami renders one line carrying the caller observation"
else
  bad "(k) default whoami renderer changed (rc=$human_rc, lines=$human_lines, stdout='$(cat "$human_out")', stderr='$(cat "$human_err")')"
fi

# (l) whoami JSON output is structured stdout only -------------------------------
json_out="$WORK/whoami-json.out"
json_err="$WORK/whoami-json.err"
set +e
FAKE_PS_MODE=missing "$TAP" whoami --json >"$json_out" 2>"$json_err"
json_rc=$?
set -e
if [ "$json_rc" -eq 1 ] && [ ! -s "$json_err" ] && "${TAP_PYTHON:-python3}" -B - "$json_out" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
assert data["ok"] is False, data
assert data["error_class"] == "not_in_tmux", data
assert "process observation unavailable" in data["detail"], data
PY
then
  ok "(l) whoami --json carries the reason on stdout with empty stderr"
else
  bad "(l) whoami --json contract changed (rc=$json_rc, stdout='$(cat "$json_out")', stderr='$(cat "$json_err")')"
fi

# (m) shutdown establishes JSON mode before resolving the caller -----------------
shutdown_json_out="$WORK/shutdown-json.out"
shutdown_json_err="$WORK/shutdown-json.err"
set +e
TMUX=/fake FAKE_PS_MODE=missing "$TAP" team shutdown --json --dry-run \
  >"$shutdown_json_out" 2>"$shutdown_json_err"
shutdown_json_rc=$?
set -e
if [ "$shutdown_json_rc" -eq 1 ] && [ ! -s "$shutdown_json_err" ] \
    && "${TAP_PYTHON:-python3}" -B - "$shutdown_json_out" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
assert data["ok"] is False, data
assert data["error_class"] == "caller_identity_unobservable", data
assert "process observation unavailable" in data["detail"], data
PY
then
  ok "(m) team shutdown --json carries the reason on stdout with empty stderr"
else
  bad "(m) team shutdown --json contract changed (rc=$shutdown_json_rc, stdout='$(cat "$shutdown_json_out")', stderr='$(cat "$shutdown_json_err")')"
fi

# (n) no-TMUX shutdown treats caller identity as a quiet best-effort observation -
best_effort_out="$WORK/best-effort.out"
best_effort_err="$WORK/best-effort.err"
set +e
env -u TMUX FAKE_PS_MODE=missing "$TAP" team shutdown --dry-run \
  >"$best_effort_out" 2>"$best_effort_err"
best_effort_rc=$?
set -e
# Class (a) CONTRACT §Registry lifecycle: blank seats={} dry-run plans delete
# (tap-w3op / review P1-2), not the pre-w3op "nothing to shut down" string.
# Pin remains: rc=0 and empty stderr (no caller-observation false alarm).
if [ "$best_effort_rc" -eq 0 ] && [ ! -s "$best_effort_err" ] \
    && grep -Eq 'nothing to shut down|would delete blank acting registry' "$best_effort_out"; then
  ok "(n) best-effort shutdown succeeds without caller-observation stderr"
else
  bad "(n) best-effort shutdown produced a false alarm (rc=$best_effort_rc, stdout='$(cat "$best_effort_out")', stderr='$(cat "$best_effort_err")')"
fi

printf 'caller-pane-tty-binding: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
