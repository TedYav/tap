#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# courier-clear-fence.test.sh (tap-36kb) — courier reads CONTENT, not lock-held.
#
# Which assertion a mutation must redden:
#   live marker            → PARK (reason=clearing). Reds if courier ignores content.
#   drain + live           → still parked. Reds if drain injects during the window.
#   --urgent + live        → recipient_clearing, no spool. Distinct from clear_in_progress.
#   dead holder + FRESH    → PARK. This is the falsifying arm: lock-held-as-signal
#                            would DELIVER (flock free because nobody holds it).
#   dead holder + STALE    → DELIVER (fail-open). Pins the deliver direction.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

export TAP_SPOOL_DISABLE_DELIVERER=1
export TAP_TUI_SETTLE_SCALE=0.1
unset TAP_CLEAR_ID

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
TAP_HOME="$(mktemp -d)"
FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$TAP_HOME" "$FAKE_BIN"' EXIT
export TAP_HOME PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket" TAP_BOOT_ID="boot:424242"
export TAP_INDEX_HOME="$TAP_HOME/index"
mkdir -p "$TAP_INDEX_HOME" && printf '{"schema":"0.20","teams":{}}\n' > "$TAP_INDEX_HOME/global-registry.json"  # born live (F1)
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$TAP_HOME/index" "$TAP_HOME/clear-fence"

cat > "$FAKE_BIN/tmux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"
mkdir -p "$state"
cmd="${1:-}"; shift || true
case "$cmd" in
  list-sessions) printf 'sess\t900:100\n' ;;
  list-panes) printf 'sess\tfake-pane\t%%1001\tcodex\t2147483646\t900:100\t0\n' ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) target="${2:-}"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    case "$fmt" in
      # Native server-identity probe: the generation the registry pins (srv:900:100).
      *start_time*)                                      echo "900:100" ;;
      # Native five-field pane observation (pane_id+session_name+pane_pid+pane_current_command+pane_dead).
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%%1001\tsess\t%s\t%s\t0\n' "${FAKE_PANE_PID:-2147483646}" "${FAKE_TMUX_CMD:-codex}" ;;
      *pane_id*)              echo "%1001" ;;
      *pane_pid*)             echo "${FAKE_PANE_PID:-2147483646}" ;;
      *pane_in_mode*)         echo "0" ;;
      *pane_current_command*) echo "${FAKE_TMUX_CMD:-codex}" ;;
      *)                      echo "" ;;
    esac ;;
  capture-pane)
    if [ -f "$state/input" ]; then printf '› %s\n' "$(cat "$state/input")"; else printf '› \n'; fi ;;
  send-keys)
    if [ "${1:-}" = "-t" ]; then shift 2; fi
    if [ "${1:-}" = "-X" ]; then exit 0; fi
    if [ "${1:-}" = "-l" ]; then
      shift; [ "${1:-}" = "--" ] && shift
      printf '%s' "${1:-}" > "$state/input"
      exit 0
    fi
    if [ "${1:-}" = "Enter" ]; then rm -f "$state/input"; exit 0; fi ;;
esac
EOF
chmod +x "$FAKE_BIN/tmux"
export FAKE_TMUX_STATE="$TAP_HOME/fake-tmux"
mkdir -p "$FAKE_TMUX_STATE"

cat > "$TAP_HOME/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"testteam"},"seats":{"codex":{"pane":"sender-pane","pane_id":"%1002","session":"sess","server_epoch":"srv:900:100","harness":"codex","status":"active"},"peer":{"pane":"fake-pane","pane_id":"%1001","session":"sess","server_epoch":"srv:900:100","harness":"codex","status":"active"}}}
JSON

write_fence() { # <handle> <age_seconds> <ceiling>
  python3 -B - "$TAP_HOME" "$1" "$2" "$3" <<'PY'
import json, os, sys, time
bus, handle, age, ceiling = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
path = os.path.join(bus, "clear-fence", handle + ".json")
os.makedirs(os.path.dirname(path), exist_ok=True)
now = time.time()
json.dump({
    "nonce": "fence-nonce",
    "since": "2099-01-01T00:00:00Z",
    "since_epoch": now - age,
    "pid": 2147483646,
    "handle": handle,
    "harness": "codex",
    "ceiling_seconds": ceiling,
}, open(path, "w"))
PY
}

# (1) live marker, nobody holding the flock → PARK. Content, not lock.
write_fence peer 0 45
rc=0
"$TAP" send peer --ask -m "during clear" --from codex --id cf-live --json \
  >"$TAP_HOME/live.out" 2>"$TAP_HOME/live.err" || rc="$?"
[ "$rc" = "0" ] || { echo "clear-fence: (1) live send should queue, got $rc" >&2; cat "$TAP_HOME/live.out" "$TAP_HOME/live.err" >&2; exit 1; }
python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
assert d["status"]=="queued" and d["reason"]=="clearing", d
' "$TAP_HOME/live.out" || { echo "clear-fence: (1) must park reason=clearing" >&2; cat "$TAP_HOME/live.out" >&2; exit 1; }
[ -f "$TAP_HOME/spool/cf-live.md" ] || { echo "clear-fence: (1) spool missing" >&2; exit 1; }
echo "clear-fence: (1) live content parks (lock not held): ok"

# (1b) drain must NOT inject while content is live. Park-at-send is a no-op
# if the next drain tick delivers into the mid-restart pane.
LIB="$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
bash -c 'set -euo pipefail; . "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once' _ "$LIB" \
  >/dev/null 2>"$TAP_HOME/drain-live.err" || true
[ -f "$TAP_HOME/spool/cf-live.md" ] || {
  echo "clear-fence: (1b) drain injected during live fence — the park was undone" >&2
  cat "$TAP_HOME/drain-live.err" >&2; exit 1; }
[ ! -f "$TAP_HOME/payloads/cf-live.md" ] || {
  echo "clear-fence: (1b) drain promoted canonical during live fence" >&2; exit 1; }
echo "clear-fence: (1b) drain holds while content is live: ok"

# (2) --urgent + live → recipient_clearing, no additional spool of this id
rc=0
"$TAP" send peer -m "urgent during clear" --from codex --id cf-urgent --urgent --json \
  >"$TAP_HOME/urgent.out" 2>/dev/null || rc="$?"
[ "$rc" = "1" ] || { echo "clear-fence: (2) urgent should exit 1, got $rc" >&2; cat "$TAP_HOME/urgent.out" >&2; exit 1; }
python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
assert d["ok"] is False and d["error_class"]=="recipient_clearing", d
' "$TAP_HOME/urgent.out" || { echo "clear-fence: (2) need error_class=recipient_clearing" >&2; cat "$TAP_HOME/urgent.out" >&2; exit 1; }
[ ! -e "$TAP_HOME/spool/cf-urgent.md" ] || { echo "clear-fence: (2) urgent must not spool" >&2; exit 1; }
[ ! -e "$TAP_HOME/payloads/cf-urgent.md" ] || { echo "clear-fence: (2) urgent must not leave canonical" >&2; exit 1; }
echo "clear-fence: (2) urgent refuses recipient_clearing: ok"

# (3) dead holder + FRESH stamp → PARK. Falsifies lock-held-as-signal.
# Pid 2147483646 is not a live process; no flock is held. A lock-as-signal
# courier would deliver. Content-as-signal parks.
write_fence peer 1 45
rc=0
"$TAP" send peer --ask -m "dead but fresh" --from codex --id cf-fresh --json \
  >"$TAP_HOME/fresh.out" 2>/dev/null || rc="$?"
[ "$rc" = "0" ] || { echo "clear-fence: (3) dead+fresh should queue, got $rc" >&2; cat "$TAP_HOME/fresh.out" >&2; exit 1; }
python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
assert d["status"]=="queued" and d["reason"]=="clearing", d
' "$TAP_HOME/fresh.out" || { echo "clear-fence: (3) dead+FRESH must PARK — this arm falsifies lock-as-signal" >&2; cat "$TAP_HOME/fresh.out" >&2; exit 1; }
echo "clear-fence: (3) dead holder + fresh content PARKS (falsifying arm): ok"

# (4) An urgent attempt bypasses existing siblings and delivers after expiry.
write_fence peer 1000 45
rc=0
"$TAP" send peer --ask --urgent -m "stale deliver" --from codex --id cf-stale --json \
  >"$TAP_HOME/stale.out" 2>"$TAP_HOME/stale.err" || rc="$?"
[ "$rc" = "0" ] || { echo "clear-fence: (4) stale should inject, got $rc" >&2; cat "$TAP_HOME/stale.out" "$TAP_HOME/stale.err" >&2; exit 1; }
python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
assert d.get("status")=="injected" or d.get("delivery")=="pane", d
' "$TAP_HOME/stale.out" || { echo "clear-fence: (4) dead+STALE must DELIVER (fail-open)" >&2; cat "$TAP_HOME/stale.out" >&2; exit 1; }
grep -q "expired; delivering anyway" "$TAP_HOME/stale.err" || {
  echo "clear-fence: (4) fail-open must say so once, stderr:" >&2; cat "$TAP_HOME/stale.err" >&2; exit 1; }
echo "clear-fence: (4) dead holder + stale content DELIVERS (fail-open): ok"

# (5) after expiry, drain redelivers the mail parked in (1). Pair with (1b):
# holding during live AND delivering after expire. Either arm alone can pass
# for the wrong reason.
bash -c 'set -euo pipefail; . "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once' _ "$LIB" \
  >/dev/null 2>"$TAP_HOME/drain-expired.err" || true
[ ! -f "$TAP_HOME/spool/cf-live.md" ] || {
  echo "clear-fence: (5) drain must redeliver after expire; cf-live still spooled" >&2
  cat "$TAP_HOME/drain-expired.err" >&2; exit 1; }
echo "clear-fence: (5) drain redelivers after expire: ok"

echo "courier-clear-fence: ok"
