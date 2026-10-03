#!/usr/bin/env bash
# exit-5-pending.test.sh — exit 5 (submit-unverified) keeps the default human
# output separate from the machine-readable --json result, so a caller can record
# the minted id + canonical path while a real payload remains outstanding.
#
# Asserts:
#   (e-rc)   exit code == 5
#   (e-can)  canonical payloads/<id>.md still exists (bus has the payload)
#            and no success telemetry .sent receipt exists
#   (e-json) --json contains the REAL minted id/path/target matching the canonical file
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
TAP_HOME="$(mktemp -d)"
FAKE_BIN="$(mktemp -d)"
export TAP_HOME

# Teardown (settle, then one guarded rm per root) lives in the sourced lib; see it for why
# a bare `rm -rf` here races the rc=5 send's detached workers (tap-1q3cw).
case "$TAP_HOME:$FAKE_BIN" in /*:/*) ;; *) echo "exit-5-pending: scratch roots must be absolute: $TAP_HOME $FAKE_BIN" >&2; exit 1 ;; esac
# shellcheck source=skills/tap/scripts/smoke/scratch-teardown-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/scratch-teardown-lib.sh"
trap scratch_trap EXIT

mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"
cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": { "name": "testteam" },
  "seats": {
    "claude": { "session": "testteam/claude", "pane": "sender-pane", "pane_id": "%11", "server_epoch": "srv:1:1", "harness": "codex", "status": "active" },
    "codex": { "session": "testteam/codex", "pane": "fake-pane", "pane_id": "%12", "server_epoch": "srv:1:1", "harness": "codex", "status": "active" }
  }
}
JSON

# --- fake tmux: idle input prompt, sentinel pastes in, but Enter NEVER clears ---
# FAKE_TMUX_STUCK_SUBMIT=1 suppresses the rm on Enter so the sentinel id stays in
# the input line forever — tap_submit_verify exhausts all Enter retries and returns 5.
cat > "$FAKE_BIN/tmux" <<'ENDTMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"
mkdir -p "$state"
cmd="${1:-}"; shift || true
case "$cmd" in
  # CONTRACT §Session-name authority: submit-unverified remains a real pane
  # attempt, so the fixture supplies exact live identity evidence first.
  list-sessions) printf 'testteam/claude\t1:1\ntestteam/codex\t1:1\n' ;;
  list-panes)
    target=""; while [ "$#" -gt 0 ]; do case "$1" in -t) target="${2#=}"; shift 2 ;; *) shift ;; esac; done
    case "$target" in testteam/claude) printf 'testteam/claude\tsender-pane\t%%11\tcodex\t4242\t1:1\t0\n' ;; testteam/codex) printf 'testteam/codex\tfake-pane\t%%12\tcodex\t4242\t1:1\t0\n' ;; esac ;;
  display-message)
    fmt=""; target=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -p) shift ;;
        -t) target="${2:-}"; shift 2 ;;
        *)  fmt="$1"; shift ;;
      esac
    done
    [ "${FAKE_TMUX_GONE:-0}" = "1" ] && [ -n "$target" ] && { echo "can't find pane: $target" >&2; exit 1; }
    case "$fmt" in
      '#{pid}:#{start_time}') printf '1:1\n' ;;
      # Bun's combined nine-field caller record — precedes the pane globs.
      *pane_id*pane_tty*session_name*socket_path*pane_current_path*)
        case "$target" in sender-pane|%11) printf '%%11\t/dev/faketty\ttestteam/claude\t1:1\ttestteam/claude:0.0\t4242\tcodex\t\t\n' ;; *) printf '%%12\t/dev/faketty\ttestteam/codex\t1:1\ttestteam/codex:0.0\t4242\tcodex\t\t\n' ;; esac ;;
      # Bun's combined eight-field pane record.
      *pane_id*session_name*pane_pid*pane_current_command*socket_path*)
        case "$target" in sender-pane|%11) printf '%%11\ttestteam/claude\t4242\tcodex\t0\ttestteam/claude:0.0\t\t\n' ;; *) printf '%%12\ttestteam/codex\t4242\tcodex\t0\ttestteam/codex:0.0\t\t\n' ;; esac ;;
      *pane_id*session_name*pane_pid*pane_current_command*)
        case "$target" in sender-pane|%11) printf '%%11\ttestteam/claude\t4242\tcodex\t0\n' ;; *) printf '%%12\ttestteam/codex\t4242\tcodex\t0\n' ;; esac ;;
      *pane_id*)              case "$target" in sender-pane|%11) echo '%11' ;; *) echo '%12' ;; esac ;;
      *pane_in_mode*)         echo "0" ;;
      *pane_current_command*) echo "codex" ;;
      *)                      echo "" ;;
    esac ;;
  capture-pane)
    prompt="›"
    if [ -f "$state/input" ]; then
      printf '%s %s\n' "$prompt" "$(cat "$state/input")"
    else
      printf '%s \n' "$prompt"
    fi ;;
  send-keys)
    if [ "${1:-}" = "-t" ]; then shift 2; fi
    if [ "${1:-}" = "-l" ]; then
      shift
      [ "${1:-}" = "--" ] && shift
      printf '%s' "${1:-}" > "$state/input"
      exit 0
    fi
    # Enter key: FAKE_TMUX_STUCK_SUBMIT=1 keeps the input file (sentinel never clears)
    if [ "${1:-}" = "Enter" ]; then
      [ "${FAKE_TMUX_STUCK_SUBMIT:-0}" = "1" ] || rm -f "$state/input"
    fi ;;
esac
ENDTMUX
chmod +x "$FAKE_BIN/tmux"

export PATH="$FAKE_BIN:$PATH"
export FAKE_TMUX_STATE="$TAP_HOME/fake-tmux"

# --- valid payload -------------------------------------------------------------
valid_payload="$TAP_HOME/valid.md"
cat > "$valid_payload" <<'EOF'
---
from: claude
to: codex
kind: discuss
---

hello
EOF

# --- (e) force submit-unverified → assert rc=5, canonical remains, JSON result
_e_rc=0
FAKE_TMUX_STUCK_SUBMIT=1 "$TAP" send codex "$valid_payload" \
  --from claude --ask --pane fake-pane --json \
  >"$TAP_HOME/e.out" 2>"$TAP_HOME/e.err" || _e_rc="$?"

[ "$_e_rc" = "5" ] || {
  echo "exit-5-pending: (e-rc) expected exit 5 (submit-unverified), got $_e_rc" >&2
  echo "--- stdout ---" >&2; cat "$TAP_HOME/e.out" >&2
  echo "--- stderr ---" >&2; cat "$TAP_HOME/e.err" >&2
  exit 1
}
echo "exit-5-pending: (e-rc) exit code == 5: ok"

# (e-can) canonical must still exist
canonical_count="$(find "$TAP_HOME/payloads/" -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')"
[ "$canonical_count" = "1" ] || {
  echo "exit-5-pending: (e-can) expected 1 canonical in payloads/, found $canonical_count" >&2
  exit 1
}
canonical_file="$(find "$TAP_HOME/payloads/" -maxdepth 1 -name '*.md' | head -1)"
canonical_id="$(basename "$canonical_file" .md)"
echo "exit-5-pending: (e-can) canonical $canonical_id still on bus: ok"
if [ -f "$TAP_HOME/receipts/$canonical_id.sent" ]; then
  echo "exit-5-pending: (e-can) submit-unverified wrote success telemetry" >&2
  exit 1
fi
echo "exit-5-pending: (e-can) no .sent success telemetry on exit 5: ok"
# tap-ejpf: place-time .placed MUST exist on exit 5 — that is what keeps
# submit-unverified mail from looking hand-written to poll/doctor.
if [ ! -f "$TAP_HOME/receipts/$canonical_id.placed" ]; then
  echo "exit-5-pending: (e-placed) exit 5 left no .placed attribution" >&2
  exit 1
fi
echo "exit-5-pending: (e-placed) .placed present on exit 5 (provenance ≠ .sent): ok"

# (e-json) stdout carries the stable structured pending result.
stdout_content="$(cat "$TAP_HOME/e.out")"
python3 -c 'import json,sys
d=json.load(sys.stdin)
assert d["status"] == "pending" and d["error_class"] == "submit_unverified", d
assert d["id"] == sys.argv[1], d
assert d["path"].endswith("/payloads/" + sys.argv[1] + ".md"), d
assert d["to"] == "codex", d
' "$canonical_id" <<<"$stdout_content" || {
  echo "exit-5-pending: (e-json) result did not match the canonical pending payload" >&2
  printf '%s\n' "$stdout_content" >&2
  exit 1
}
echo "exit-5-pending: (e-json) result carries real id + path + target: ok"

# (e-event, tap-xity) THIS ARM DRIVES: tap-send.sh's direct rc=5 branch
# (~tap-send.sh:1542, the `if [ "$_sv_rc" = "5" ]` block), exercised above by the
# same FAKE_TMUX_STUCK_SUBMIT=1 fixture that already proves rc=5 is real — not a
# fixture that merely asserts a string, and not a path a mutation could dodge by
# taking some other exit (rc=3/6 exit through tap_fail before this point; the
# defer-retryable branch is a different `if` entirely). The redelivery path's
# sibling event (`lib.sh:2032`/`:2497`) is out of this lane's scope (Lane 5 owns
# lib.sh) and already has its own coverage; this checks only the new call site.
grep -q "action=send_submit_unverified.*detail=id=$canonical_id" "$TAP_HOME/registry-events.log" || {
  echo "exit-5-pending: (e-event) direct-send rc=5 must append a durable send_submit_unverified event for $canonical_id" >&2
  echo "--- registry-events.log ---" >&2; cat "$TAP_HOME/registry-events.log" 2>&1 >&2
  exit 1
}
echo "exit-5-pending: (e-event) send_submit_unverified recorded durably on direct rc=5: ok"

echo "exit-5-pending: ok"
