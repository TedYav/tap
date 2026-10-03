#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# crew-unregister.test.sh — crew teardown is window-scoped, never session-scoped.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"; FAKE_BIN="$WORK/bin"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$FAKE_BIN" "$WORK/bus/payloads" "$WORK/bus/receipts" "$WORK/bus/spool"
export TAP_HOME="$WORK/bus" PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket"
export TMUX_LOG="$WORK/tmux.log"
SESSION="demo/fable"

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  display-message)
    shift
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -p) shift ;;
        -t) target="$2"; shift 2 ;;
        *) fmt="$1"; shift ;;
      esac
    done
    # A dead-pane arm flips this flag so the fixture reports %crew as gone, the
    # way tmux does for a vanished pane.
    if [ -e "$(dirname "$TMUX_LOG")/crew-gone" ] && [ "$target" = "%crew" ]; then
      echo "can't find pane: %crew" >&2; exit 1
    fi
    case "$fmt" in
      *session_windows*) printf '2\n' ;;
      *window_panes*) printf '1\n' ;;
      *pane_id*) [ "$target" = "%crew" ] && printf '%%crew\n' || printf '%%driver\n' ;;
      *session_name*) printf '%s\n' "$FAKE_SESSION" ;;
      *window_id*) { [ "$target" = "%crew" ] || [ "$target" = "@7" ]; } && printf '@7\n' || printf '@0\n' ;;
      *) printf '\n' ;;
    esac
    ;;
  has-session) exit 0 ;;
  kill-session|kill-window|kill-pane) printf '%s\n' "$*" >> "$TMUX_LOG" ;;
  *) exit 0 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
export FAKE_SESSION="$SESSION"

cat > "$TAP_HOME/registry.json" <<JSON
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "fable": {"status": "active", "delivery": "pane", "pane": "$SESSION:0.0", "pane_id": "%driver", "session": "$SESSION"},
    "crew-sol": {"status": "active", "delivery": "pane", "pane": "$SESSION:1.0", "pane_id": "%crew", "session": "$SESSION", "crew": true}
  }
}
JSON

has_agent() {
  python3 -B - "$TAP_HOME/registry.json" "$1" <<'PY'
import json, sys
agents = json.load(open(sys.argv[1])).get("seats") or {}
raise SystemExit(0 if sys.argv[2] in agents else 1)
PY
}

write_payload() {
  local dir="$1" id="$2" from="$3" to="$4" reply="$5" to_team="${6:-}" path
  path="$dir/$id.md"
  cat > "$path" <<EOF
---
id: $id
from: $from
to: $to
kind: discuss
path: $path
reply: $reply
EOF
  if [ -n "$to_team" ]; then
    printf 'to_team: %s\n' "$to_team" >> "$path"
  fi
  cat >> "$path" <<EOF
---
body
EOF
}

assert_no_done_receipts() {
  if compgen -G "$TAP_HOME/receipts/*.done" >/dev/null; then
    echo "crew-unregister: unregister forged a .done receipt" >&2
    find "$TAP_HOME/receipts" -name '*.done' -maxdepth 1 -print >&2
    exit 1
  fi
}

# Crew dismissal is pane-scoped: --kill spells --hard and stops only the
# crew's own pane through the shared dismissal owner, never the driver's session.
cp "$TAP_HOME/registry.json" "$WORK/registry.before-kill"
rc=0
kill_out="$("$TAP" out crew-sol --kill 2>&1)" || rc=$?
[ "$rc" -eq 0 ] || { echo "crew-unregister: crew --kill must dismiss the crew pane (rc=$rc, got: $kill_out)" >&2; exit 1; }
has_agent crew-sol && { echo "crew-unregister: --kill left the crew row" >&2; exit 1; }
has_agent fable || { echo "crew-unregister: crew --kill removed the driver row" >&2; exit 1; }
grep -q "kill-pane -t %crew" "$TMUX_LOG" \
  || { echo "crew-unregister: crew --kill did not stop the crew pane (tmux log: $(cat "$TMUX_LOG"))" >&2; exit 1; }
grep -qE "kill-session|kill-window" "$TMUX_LOG" \
  && { echo "crew-unregister: crew --kill went wider than the crew pane" >&2; cat "$TMUX_LOG" >&2; exit 1; }
echo "crew-unregister: crew --kill stops only the crew pane, never the shared driver session: ok"
# Restore the fixture so the arms below start from the original roster.
cp "$WORK/registry.before-kill" "$TAP_HOME/registry.json"
: > "$TMUX_LOG"

write_payload "$TAP_HOME/payloads" crew-in-reply fable crew-sol expected
write_payload "$TAP_HOME/payloads" crew-in-fyi fable crew-sol settle-only
rc=0
inbound_out="$("$TAP" out crew-sol 2>&1)" || rc=$?
[ "$rc" -ne 0 ] || { echo "crew-unregister: pending local inbound must refuse" >&2; exit 1; }
has_agent crew-sol || { echo "crew-unregister: inbound refusal removed the crew row" >&2; exit 1; }
has_agent fable || { echo "crew-unregister: inbound refusal removed the driver row" >&2; exit 1; }
[[ "$inbound_out" == *"crew-in-reply"* && "$inbound_out" == *'tap reply crew-in-reply -f <file>'* ]] \
  || { echo "crew-unregister: inbound refusal omitted reply action (got: $inbound_out)" >&2; exit 1; }
[[ "$inbound_out" == *"crew-in-fyi"* && "$inbound_out" == *"tap read crew-in-fyi"* ]] \
  || { echo "crew-unregister: inbound refusal omitted settle action (got: $inbound_out)" >&2; exit 1; }
[ ! -s "$TMUX_LOG" ] || { echo "crew-unregister: inbound refusal invoked tmux" >&2; cat "$TMUX_LOG" >&2; exit 1; }
assert_no_done_receipts
rm "$TAP_HOME/payloads/crew-in-reply.md" "$TAP_HOME/payloads/crew-in-fyi.md"
echo "crew-unregister: pending local inbound refuses with exact settlement actions: ok"

write_payload "$TAP_HOME/payloads" crew-out-canonical crew-sol fable expected
write_payload "$TAP_HOME/spool" crew-out-spool crew-sol fable expected
printf '{}\n' > "$TAP_HOME/spool/crew-out-spool.meta.json"
rc=0
outbound_out="$("$TAP" out crew-sol 2>&1)" || rc=$?
[ "$rc" -ne 0 ] || { echo "crew-unregister: pending local outbound must refuse" >&2; exit 1; }
has_agent crew-sol || { echo "crew-unregister: outbound refusal removed the crew row" >&2; exit 1; }
has_agent fable || { echo "crew-unregister: outbound refusal removed the driver row" >&2; exit 1; }
# Each fixture id pins its storage source; refusals print owner/id/action.
[[ "$outbound_out" == *"outbound crew-sol id=crew-out-canonical;"* ]] \
  || { echo "crew-unregister: outbound refusal omitted canonical obligation (got: $outbound_out)" >&2; exit 1; }
[[ "$outbound_out" == *"outbound crew-sol id=crew-out-spool;"* ]] \
  || { echo "crew-unregister: outbound refusal omitted spool obligation (got: $outbound_out)" >&2; exit 1; }
[[ "$outbound_out" == *"tap outstanding crew-sol"* ]] \
  || { echo "crew-unregister: outbound refusal omitted outstanding action (got: $outbound_out)" >&2; exit 1; }
[ ! -s "$TMUX_LOG" ] || { echo "crew-unregister: outbound refusal invoked tmux" >&2; cat "$TMUX_LOG" >&2; exit 1; }
assert_no_done_receipts
rm "$TAP_HOME/payloads/crew-out-canonical.md" \
  "$TAP_HOME/spool/crew-out-spool.md" "$TAP_HOME/spool/crew-out-spool.meta.json"
echo "crew-unregister: pending canonical or spooled outbound refuses: ok"

write_payload "$TAP_HOME/spool" crew-in-spool fable crew-sol expected
printf '{}\n' > "$TAP_HOME/spool/crew-in-spool.meta.json"
# tap-w66z: foreign to_team with a colliding bare `to` is sender-bus relay, not
# local inbound — neither canonical nor spool may block or prescribe settle.
write_payload "$TAP_HOME/payloads" crew-xwt-relay fable crew-sol settle-only other-team
write_payload "$TAP_HOME/spool" crew-xwt-spool fable crew-sol expected other-team
printf '{}\n' > "$TAP_HOME/spool/crew-xwt-spool.meta.json"
plain_out="$("$TAP" out crew-sol)"
has_agent crew-sol && { echo "crew-unregister: plain out did not remove crew row" >&2; exit 1; }
has_agent fable || { echo "crew-unregister: plain out removed the driver row" >&2; exit 1; }
# Dismissal is pane-scoped: plain out stops the crew's own pane, never a window or session.
[[ "$plain_out" == *"stopped pane %crew"* ]] \
  || { echo "crew-unregister: plain out did not report stopping the crew pane (got: $plain_out)" >&2; exit 1; }
[[ "$plain_out" != *"kill-session"* && "$plain_out" != *"kill-window"* ]] \
  || { echo "crew-unregister: plain out exposed wider-than-pane advice" >&2; exit 1; }
[[ "$plain_out" == *"crew-in-spool"* && "$plain_out" == *"fable"* \
  && "$plain_out" == *"tap cancel crew-in-spool --by fable"* ]] \
  || { echo "crew-unregister: plain out omitted sender-owned spool cleanup (got: $plain_out)" >&2; exit 1; }
[[ "$plain_out" != *"crew-xwt-relay"* && "$plain_out" != *"tap done crew-xwt-relay"* ]] \
  || { echo "crew-unregister: foreign to_team treated as local inbound (got: $plain_out)" >&2; exit 1; }
[[ "$plain_out" != *"crew-xwt-spool"* ]] \
  || { echo "crew-unregister: foreign to_team spool treated as local queued inbound (got: $plain_out)" >&2; exit 1; }
[ -f "$TAP_HOME/spool/crew-in-spool.md" ] \
  || { echo "crew-unregister: plain out removed sender-owned inbound spool" >&2; exit 1; }
[ -f "$TAP_HOME/payloads/crew-xwt-relay.md" ] \
  || { echo "crew-unregister: plain out removed foreign-team canonical" >&2; exit 1; }
[ -f "$TAP_HOME/spool/crew-xwt-spool.md" ] \
  || { echo "crew-unregister: plain out removed foreign-team spool" >&2; exit 1; }
grep -q "kill-pane -t %crew" "$TMUX_LOG" \
  || { echo "crew-unregister: plain out did not stop the crew pane (tmux log: $(cat "$TMUX_LOG"))" >&2; exit 1; }
! grep -qE "kill-session|kill-window" "$TMUX_LOG" \
  || { echo "crew-unregister: plain out went wider than the crew pane" >&2; cat "$TMUX_LOG" >&2; exit 1; }
: > "$TMUX_LOG"
assert_no_done_receipts
echo "crew-unregister: plain crew out removes the row and stops only the crew pane: ok"

"$TAP" cancel crew-in-spool --by fable >/dev/null
[ -f "$TAP_HOME/receipts/crew-in-spool.cancelled" ] \
  || { echo "crew-unregister: sender could not cancel inbound spool after removal" >&2; exit 1; }
[ ! -f "$TAP_HOME/spool/crew-in-spool.md" ] \
  || { echo "crew-unregister: cancelled inbound spool was not removed" >&2; exit 1; }
assert_no_done_receipts
echo "crew-unregister: inbound spool remains sender-cancellable after crew removal: ok"

# `tap out -` chooses a dead row first, but that selection must still take the
# ordinary crew-obligation path before any row is removed.
python3 -B - "$TAP_HOME/registry.json" <<'PY'
import json, sys
path = sys.argv[1]
reg = json.load(open(path))
reg["seats"]["crew-sol"] = {
    "status": "suspended", "status_reason": "pane_gone",
    "delivery": "pane", "pane": "demo/fable:1.0", "pane_id": "%crew",
    "session": "demo/fable", "crew": True,
    "exited_at": "2026-07-20T16:00:00Z",
}
with open(path, "w") as fh:
    json.dump(reg, fh, indent=2, sort_keys=True)
    fh.write("\n")
PY
write_payload "$TAP_HOME/payloads" crew-dash-in fable crew-sol expected
: > "$WORK/crew-gone"
rc=0
dash_out="$("$TAP" out - 2>&1)" || rc=$?
rm -f "${WORK:?}/crew-gone"
[ "$rc" -ne 0 ] || { echo "crew-unregister: selector bypassed the crew obligation refusal" >&2; exit 1; }
has_agent crew-sol || { echo "crew-unregister: selector removed a blocked dead crew row" >&2; exit 1; }
[[ "$dash_out" == *"crew-dash-in"* && "$dash_out" == *'tap reply crew-dash-in -f <file>'* ]] \
  || { echo "crew-unregister: selector refusal omitted the exact settlement action (got: $dash_out)" >&2; exit 1; }
assert_no_done_receipts
echo "crew-unregister: selector scans dead crew rows for obligations before removal: ok"

# Exercise crew's public removal door as well as its shared out child.
cp "$TAP_HOME/registry.json" "$WORK/remove.before"
rc=0
remove_blocked="$("$TAP" crew remove crew-sol 2>&1)" || rc=$?
[ "$rc" -ne 0 ] || { echo 'crew remove bypassed the obligation gate' >&2; exit 1; }
has_agent crew-sol || { echo 'blocked crew remove deleted the row' >&2; exit 1; }
[[ "$remove_blocked" == *'crew-dash-in'* ]] || { echo 'crew remove lost the child refusal' >&2; exit 1; }
[ ! -s "$TMUX_LOG" ] || { echo 'blocked crew remove killed a window' >&2; exit 1; }

rm "${TAP_HOME:?}/payloads/crew-dash-in.md"
remove_out="$("$TAP" crew remove crew-sol)"
has_agent crew-sol && { echo 'crew remove retained the row' >&2; exit 1; }
has_agent fable || { echo 'crew remove deleted its driver' >&2; exit 1; }
[[ "$remove_out" == *'removed crew-sol and stopped pane %crew'* ]] || { echo 'crew remove lost its receipt' >&2; exit 1; }
[ "$(cat "$TMUX_LOG")" = 'kill-pane -t %crew' ] || { echo 'crew remove targeted more than the crew pane' >&2; exit 1; }

cp "$WORK/remove.before" "$TAP_HOME/registry.json"
: > "$TMUX_LOG"
remove_elsewhere="$(FAKE_SESSION=other/session "$TAP" crew remove crew-sol)"
has_agent crew-sol && { echo 'wrong-session removal retained the row' >&2; exit 1; }
has_agent fable || { echo 'wrong-session removal deleted its driver' >&2; exit 1; }
[[ "$remove_elsewhere" == *'pane not stopped: pane_live_elsewhere'* && "$remove_elsewhere" == *"tmux kill-pane -t '%crew'"* ]] \
  || { echo 'wrong-session removal lost the skip reason or manual hint' >&2; exit 1; }
[ ! -s "$TMUX_LOG" ] || { echo 'crew remove killed a window in another session' >&2; exit 1; }
echo 'crew-unregister: crew remove gates obligations and preserves window authority: ok'

echo "crew-unregister: ok"
