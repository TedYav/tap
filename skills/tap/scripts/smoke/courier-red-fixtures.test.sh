#!/usr/bin/env bash
# courier-red-fixtures.test.sh — Fable option B: public tap spool
# inspection is effect-free on live bash parks. list/status notice them;
# they stay on the bash drain and remain redeliverable.
#
# The unused native-owner conversion has been retired; this
# serial is the verb-path control (and will run whenever verbs/spool.ts
# changes).
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
. "$ROOT/scripts/serial-trigger.sh"
tap_serial_triggers "runtime/bun/" "skills/tap/scripts/"
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"

RUNTIME="$ROOT/runtime/bun"
BUN="${TAP_SMOKE_BUN:-$(command -v bun 2>/dev/null || true)}"
LIB="$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
TAP_HOME="$(mktemp -d)"
INDEX="$(mktemp -d)"
printf '{"schema":"0.20","teams":{}}\n' > "$INDEX/global-registry.json"  # born live (F1)
LOCKS="$(mktemp -d)"
WORK="$(mktemp -d)"

fail() { echo "courier-red-fixtures: $1" >&2; exit 1; }
cleanup() { rm -rf "$TAP_HOME" "$INDEX" "$LOCKS" "$WORK"; }
trap cleanup EXIT

[ -n "$BUN" ] && [ -x "$BUN" ] || fail "Bun executable unavailable"

mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$TAP_HOME/spool"

plant_pair() {
  local id="$1" epoch="$2"
  local body="$TAP_HOME/spool/${id}.md"
  cat > "$body" <<EOF
---
id: ${id}
from: alice
to: peer
kind: discuss
reply: settle-only
path: ${body}
---
legacy body ${id}
EOF
  cat > "$TAP_HOME/spool/${id}.meta.json" <<EOF
{
  "id": "${id}",
  "target": "peer",
  "team": "beta",
  "to_team": "beta",
  "target_registry": "${TAP_HOME}/registry.json",
  "pane": "sess:0.0",
  "pane_id": "%701",
  "policy": "standard",
  "reason": "busy",
  "reason_class": "busy",
  "deadline_source": "readiness-gate",
  "first_spooled_epoch": ${epoch},
  "deadline_epoch": $((epoch + 300)),
  "hold_until_epoch": null
}
EOF
}

ID_A="seat-20260831T095500Z-ae9aaa"
ID_B="seat-20260831T095500Z-ae9bbb"
plant_pair "$ID_A" 1788000000
plant_pair "$ID_B" 1788000001

BODY_A="$(cat "$TAP_HOME/spool/${ID_A}.md")"
META_A="$(cat "$TAP_HOME/spool/${ID_A}.meta.json")"
BODY_B="$(cat "$TAP_HOME/spool/${ID_B}.md")"
META_B="$(cat "$TAP_HOME/spool/${ID_B}.meta.json")"

export TAP_HOME TAP_INDEX_HOME="$INDEX" TAP_LOCK_DIR="$LOCKS"

run_list() {
  local prefix="$1"
  set +e
  "$BUN" "$RUNTIME/main.ts" spool list --json >"$prefix.out" 2>"$prefix.err"
  printf '%s\n' "$?" >"$prefix.rc"
  set -e
}

run_list "$TAP_HOME/first"
[ "$(cat "$TAP_HOME/first.rc")" = "0" ] || fail "first spool list exited $(cat "$TAP_HOME/first.rc"): $(cat "$TAP_HOME/first.err")"

[ -f "$TAP_HOME/spool/${ID_A}.md" ] || fail "list consumed leftover body ${ID_A}.md"
[ -f "$TAP_HOME/spool/${ID_B}.md" ] || fail "list consumed leftover body ${ID_B}.md"
[ -f "$TAP_HOME/spool/${ID_A}.meta.json" ] || fail "list consumed leftover meta ${ID_A}"
[ -f "$TAP_HOME/spool/${ID_B}.meta.json" ] || fail "list consumed leftover meta ${ID_B}"
[ ! -e "$TAP_HOME/payloads/${ID_A}.md" ] || fail "list minted a canonical for ${ID_A}"
[ ! -e "$TAP_HOME/payloads/${ID_B}.md" ] || fail "list minted a canonical for ${ID_B}"
[ ! -e "$TAP_HOME/spool/${ID_A}.json" ] || fail "list minted an intent for ${ID_A}"
[ ! -e "$TAP_HOME/spool/${ID_B}.json" ] || fail "list minted an intent for ${ID_B}"
[ ! -e "$TAP_HOME/spool/owner.lock" ] || fail "list must not consume owner.lock"
[ "$(cat "$TAP_HOME/spool/${ID_A}.md")" = "$BODY_A" ] || fail "list mutated ${ID_A}.md"
[ "$(cat "$TAP_HOME/spool/${ID_A}.meta.json")" = "$META_A" ] || fail "list mutated ${ID_A}.meta.json"
[ "$(cat "$TAP_HOME/spool/${ID_B}.md")" = "$BODY_B" ] || fail "list mutated ${ID_B}.md"
[ "$(cat "$TAP_HOME/spool/${ID_B}.meta.json")" = "$META_B" ] || fail "list mutated ${ID_B}.meta.json"

python3 - "$TAP_HOME/first.out" <<'PY' || fail "list did not emit the legacy_bash_parks diagnostic"
import json, sys
rows = [json.loads(line) for line in open(sys.argv[1]) if line.strip()]
assert rows == [{"class": "legacy_bash_parks", "count": 2, "detail": "Shared spool parks; use tap cancel --spooled"}], rows
PY

[ ! -e "$TAP_HOME/registry-events.log" ] || fail "list wrote registry-events.log"

run_list "$TAP_HOME/second"
[ "$(cat "$TAP_HOME/second.rc")" = "0" ] || fail "second spool list exited $(cat "$TAP_HOME/second.rc")"
cmp -s "$TAP_HOME/first.out" "$TAP_HOME/second.out" || fail "second list is not a no-op"
[ "$(cat "$TAP_HOME/spool/${ID_A}.md")" = "$BODY_A" ] || fail "second list mutated ${ID_A}.md"

# Same pair remains deliverable: real _tap_spool_native redeliver against the hermetic
# pane stub from spool-redeliver-noncanonical-home.test.sh. The submit runs in the
# native engine's fresh shell, so the stub answers capture-pane/send-keys for real.
FAKE_BIN="$WORK/bin"
mkdir -p "$FAKE_BIN" "$WORK/tmux"
cat > "$FAKE_BIN/tmux" <<'ENDTMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"
mkdir -p "$state"
cmd="${1:-}"; shift || true
case "$cmd" in
  list-sessions) printf 'sess\t4242:100\n' ;;
  list-panes)
    printf 'sess\tsess:0.0\t%%701\tcodex\t5701\t4242:100\t0\n'
    ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) target="${2:-}"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    case "$fmt" in
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%%701\tsess\t5701\tcodex\t0\n' ;;
      *pane_id*session_name*) printf '%%701\tsess\t4242:100\n' ;;
      '#{pid}:#{start_time}') printf '4242:100\n' ;;
      *pane_id*)              echo "%701" ;;
      *pane_in_mode*)         echo "0" ;;
      *pane_current_command*) echo "codex" ;;
      *)                      echo "" ;;
    esac ;;
  capture-pane)
    if [ -f "$state/input" ]; then printf '› %s\n' "$(cat "$state/input")"
    else printf '› \n'; fi ;;
  send-keys)
    printf '%s\n' "$*" >> "$state/send-keys.log"
    if [ "${1:-}" = "-t" ]; then shift 2; fi
    if [ "${1:-}" = "-l" ]; then
      shift; [ "${1:-}" = "--" ] && shift
      printf '%s' "${1:-}" >"$state/input"; exit 0
    fi
    [ "${1:-}" = "C-u" ] && : > "$state/input" || true
    [ "${1:-}" = "Enter" ] && : > "$state/input" || true ;;
esac
ENDTMUX
chmod +x "$FAKE_BIN/tmux"

cat >"$TAP_HOME/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"beta"},"seats":{"peer":{"session":"sess","pane":"sess:0.0","pane_id":"%701","status":"active","harness":"codex","server_epoch":"srv:4242:100","boot_id":"boot:1"}}}
JSON

export TAP_SERVER_EPOCH="srv:4242:100" TAP_BOOT_ID="boot:1"
export TAP_TUI_SETTLE_SCALE=0.1 TAP_SPOOL_DISABLE_DELIVERER=1
SEND_KEYS_LOG="$WORK/tmux/send-keys.log"
redeliver_rc=0
PATH="$FAKE_BIN:$PATH" FAKE_TMUX_STATE="$WORK/tmux" TMUX="/fake/socket" \
  bash -c '
LIB="$1"; ID="$2"; REG="$3"
. "$LIB"
. "${LIB%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"
tap_ensure_dirs
spool_engine_fixture redeliver "$ID" peer sess:0.0 %701 beta "$REG"
' _ "$LIB" "$ID_A" "$TAP_HOME/registry.json" \
  >"$WORK/redeliver.out" 2>"$WORK/redeliver.err" || redeliver_rc=$?

[ "$redeliver_rc" = "0" ] || fail "spool_engine_fixture redeliver ${ID_A} rc=$redeliver_rc stderr=$(cat "$WORK/redeliver.err")"
grep -qE '(^| )Enter$' "$SEND_KEYS_LOG" 2>/dev/null || fail "spool_engine_fixture redeliver ${ID_A} never sent Enter: $(cat "$SEND_KEYS_LOG" 2>/dev/null)"
# v0.23 (tap-7r3fn.8): the id is SLOT 3, positional, not an `id=` key. Bounded on
# the right so a prefix of one id cannot satisfy a different one.
grep -qE "\\[\\[TAP v[0-9.]+ (ask|note) ([A-Za-z0-9][A-Za-z0-9._-]*/)?${ID_A}( |:|\\]\\])" "$SEND_KEYS_LOG" || fail "spool_engine_fixture redeliver missing sentinel id=${ID_A}: $(cat "$SEND_KEYS_LOG")"
[ -f "$TAP_HOME/payloads/${ID_A}.md" ] || fail "redeliver did not leave a canonical for ${ID_A}"
[ ! -e "$TAP_HOME/spool/${ID_A}.md" ] || fail "redeliver left leftover body ${ID_A}.md"
[ ! -e "$TAP_HOME/spool/${ID_A}.meta.json" ] || fail "redeliver left leftover meta ${ID_A}"
[ -f "$TAP_HOME/spool/${ID_B}.md" ] || fail "redeliver of ${ID_A} consumed sibling ${ID_B}"

echo "courier-red-fixtures: option-B inspection + bash redeliver PASS"
