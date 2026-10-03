#!/usr/bin/env bash
# AGY may repaint between sentinel landing and the first Enter. The courier must
# re-probe that already-injected sentinel without requiring a second send.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run through smoke-all --only" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAPSH="$ROOT/bin/tap"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
FAKE_BIN="$WORK/bin"
trap 'rm -rf "${WORK:?}"' EXIT
export TAP_INDEX_HOME="$WORK/index" XDG_CONFIG_HOME="$WORK/config"
mkdir -p "$TAP_INDEX_HOME" && printf '{"schema":"0.20","teams":{}}\n' > "$TAP_INDEX_HOME/global-registry.json"  # born live (F1)
export TAP_TUI_SETTLE_SCALE=0.1 TAP_SPOOL_DELIVERER_DELAYS="0.2"
mkdir -p "$FAKE_BIN" "$WORK/tmux" "$WORK/repo" "$XDG_CONFIG_HOME"

cat > "$FAKE_BIN/tmux" <<'TMUXMOCK'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"; mkdir -p "$state"
args=()
for arg in "$@"; do
  [ "$arg" != %401 ] || arg=sess:0.0
  args+=("$arg")
done
set -- "${args[@]}"
cmd="$1"; shift
render() {
  local text="$1"
  printf '%*s\n' 69 '' | tr ' ' '─'
  printf '> %s\n' "$text"
  printf '%*s\n? for shortcuts\n' 69 '' | tr ' ' '─'
}
case "$cmd" in
  list-sessions) printf 'sess\t4242:100\n' ;;
  list-panes) printf 'sess\tsess:0.0\t%%401\tagy\t5001\t4242:100\t0\n' ;;
  display-message)
    fmt="${@: -1}"
    case "$fmt" in
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%%401\tsess\t4242\tagy\t0\n' ;;
      '#{pid}:#{start_time}') printf '4242:100\n' ;;
      *pane_id*pane_tty*session_name*) printf '%%401\t/dev/faketty\tsess\t4242:100\n' ;;
      *pane_id*session_name*) printf '%%401\tsess\t4242:100\n' ;;
      *session_name*) echo sess ;;
      *pane_id*) echo %401 ;;
      *pane_pid*) echo 4242 ;;
      *pane_in_mode*) echo 0 ;;
      *pane_current_command*) echo agy ;;
      *pane_current_path*) echo "${FAKE_WORKTREE:?}" ;;
      *pane_width*) echo 69 ;;
      *window_activity*) echo 100 ;;
      *) echo '' ;;
    esac ;;
  capture-pane)
    key=sess_0_0
    if [ -f "$state/input.$key" ]; then
      n=0; [ ! -f "$state/input-captures" ] || n="$(cat "$state/input-captures")"
      n=$((n + 1)); printf '%s' "$n" > "$state/input-captures"
      # Native landing reads one escaped frame; the second frame is the fresh
      # pre-Enter observation. Repaint after positive landing, before any key.
      if [ ! -f "$state/disable-repaint" ] && [ -f "$state/repaint-once" ] && [ "$n" -ge 2 ]; then
        render 'terminal operation output'
      else
        render "$(cat "$state/input.$key")"
      fi
    else
      render ''
    fi ;;
  send-keys)
    printf '%s\n' "$*" >> "$state/send-keys.log"
    key=sess_0_0
    [ "${1:-}" != -t ] || { key="${2//[:.\/]/_}"; shift 2; }
    if [ "${1:-}" = -l ]; then
      shift; [ "${1:-}" != -- ] || shift
      printf '%s' "${1:-}" > "$state/input.$key"
      printf '%s' "${1:-}" > "$state/last-wire"
      printf '0' > "$state/input-captures"
      [ -f "$state/disable-repaint" ] || touch "$state/repaint-once"
      n=0; [ ! -f "$state/injections" ] || n="$(cat "$state/injections")"
      printf '%s' "$((n + 1))" > "$state/injections"
    elif [ "${1:-}" = Enter ]; then
      n=0; [ ! -f "$state/enters" ] || n="$(cat "$state/enters")"
      printf '%s' "$((n + 1))" > "$state/enters"
      rm -f "${state:?}/input.$key"
    fi ;;
esac
TMUXMOCK
chmod +x "$FAKE_BIN/tmux"

export PATH="$FAKE_BIN:$PATH" TMUX=/fake/socket FAKE_TMUX_STATE="$WORK/tmux" FAKE_WORKTREE="$WORK/repo"
export TAP_SERVER_EPOCH=srv:4242:100 TAP_BOOT_ID=boot:1
BUS="$WORK/repo/.tap/bus"
mkdir -p "$BUS/payloads" "$BUS/receipts" "$BUS/spool"
export TAP_HOME="$BUS"
cat > "$BUS/registry.json" <<JSON
{ "schema": "0.20", "team": { "name": "t", "worktree_root": "$WORK/repo" },
  "seats": {
    "peer":  { "session": "sess", "pane": "sess:0.0", "pane_id": "%401", "harness": "agy", "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "registered_from_worktree": "$WORK/repo" },
    "alice": { "session": "sess", "pane": "sess:0.0", "pane_id": "%401", "harness": "agy", "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "registered_from_worktree": "$WORK/repo" }
  } }
JSON

fail() { echo "agy-transition-reprobe: FAIL — $*" >&2; exit 1; }
id=agy-transition-reprobe
TAP_AUTOSETTLE_HOLD_SECONDS=0 bash "$TAPSH" send peer -m 'recover the repainted composer' --id "$id" --from alice --ask > "$WORK/out" 2>&1 \
  || { cat "$WORK/out" >&2; fail 'initial send was not accepted for bounded re-probe'; }
grep -F 'injected; Enter pending re-probe.' "$WORK/out" >/dev/null \
  || { cat "$WORK/out" >&2; fail 'sender receipt did not name the pending re-probe'; }

[ ! -f "$WORK/tmux/enters" ] || fail 'changed composer received Enter before recovery'
rm -f "${WORK:?}/tmux/repaint-once"
deadline=$((SECONDS + 10))
while [ "$SECONDS" -lt "$deadline" ] \
  && { [ ! -f "$BUS/receipts/$id.sent" ] || [ -f "$BUS/spool/$id.md" ] || [ -f "$BUS/spool/$id.meta.json" ]; }; do
  sleep 0.05
done
[ -f "$BUS/receipts/$id.sent" ] || { cat "$BUS/tap-deliver.log" >&2 2>/dev/null || true; fail 'courier owner did not verify the re-probe'; }
[ ! -f "$BUS/spool/$id.md" ] && [ ! -f "$BUS/spool/$id.meta.json" ] || fail 'verified re-probe retained spool custody'
[ "$(cat "$WORK/tmux/injections")" = 1 ] || fail 're-probe injected a duplicate sentinel'
[ "$(cat "$WORK/tmux/enters")" = 1 ] || fail 're-probe did not submit exactly once'

python3 -B - "$BUS/receipts/$id.submit-phases.jsonl" <<'PY'
import json,sys
rows=[json.loads(x) for x in open(sys.argv[1])]
first=rows[0]['attempt']
attempt=[x for x in rows if x['attempt']==first]
assert [x['phase'] for x in attempt] == ['injected-text-confirmed','verify-result'], attempt
assert attempt[-1]['result']=='unverified' and attempt[-1]['enter_count']==0, attempt
PY

# Re-probe authority belongs to the exact staged bytes, not merely the id: the
# altered same-id case is agy-survey.test.ts "zero-Enter re-probe preserves
# altered input" (courier.ts reprobeOnly); its Bash twin left with lib.sh's
# tap_submit_verify.
. "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
. "$ROOT/skills/tap/scripts/smoke/spool-engine-fixture.sh"

rm -f "${WORK:?}/tmux"/{send-keys.log,input-captures,injections,enters,repaint-once} "${WORK:?}/tmux"/input.*
no_spool_id=agy-transition-no-spool
rc=0
TAP_AUTOSETTLE_HOLD_SECONDS=0 bash "$TAPSH" send peer -m 'leave the repaint for manual recovery' \
  --id "$no_spool_id" --from alice --ask --no-spool > "$WORK/no-spool.out" 2>&1 || rc=$?
[ "$rc" = 5 ] || { cat "$WORK/no-spool.out" >&2; fail "--no-spool transition returned $rc instead of terminal submit-unverified"; }
[ -f "$BUS/payloads/$no_spool_id.md" ] || fail '--no-spool lost canonical custody'
[ ! -f "$BUS/spool/$no_spool_id.md" ] && [ ! -f "$BUS/spool/$no_spool_id.meta.json" ] || fail '--no-spool armed a re-probe owner'
[ "$(cat "$WORK/tmux/injections")" = 1 ] || fail '--no-spool did not stop after its first injection'
[ ! -f "$WORK/tmux/enters" ] || fail '--no-spool sent Enter after transition-changed'
grep -F 'injected; Enter unconfirmed (possible effect).' "$WORK/no-spool.out" >/dev/null \
  || fail '--no-spool lost the terminal manual-recovery receipt'

# A recipient can manually submit the staged sentinel before the owner wakes.
# The zero-Enter record is still a possible effect for digest admission: batching
# it with a sibling would redeliver a body that may already be in the harness.
rm -f "${BUS:?}/payloads"/*.md "${BUS:?}/receipts"/* "${BUS:?}/spool"/*.md "${BUS:?}/spool"/*.meta.json* \
      "${BUS:?}/spool"/*.claim "${WORK:?}/tmux"/{send-keys.log,input-captures,injections,enters,repaint-once} "${WORK:?}/tmux"/input.*
export TAP_SPOOL_DISABLE_DELIVERER=1
digest_id=agy-transition-manual-submit
TAP_AUTOSETTLE_HOLD_SECONDS=0 bash "$TAPSH" send peer -m 'manual submit before reprobe' \
  --id "$digest_id" --from alice --ask > "$WORK/manual.out" 2>&1 \
  || { cat "$WORK/manual.out" >&2; fail 'manual-submit fixture did not park'; }
[ -f "$BUS/spool/$digest_id.meta.json" ] || fail 'manual-submit fixture has no pending reprobe'
tmux send-keys -t sess:0.0 Enter
printf 'human draft' > "$WORK/tmux/input.sess_0_0"
sibling_id=agy-transition-sibling
TAP_AUTOSETTLE_HOLD_SECONDS=0 bash "$TAPSH" send peer -m 'digest sibling' \
  --id "$sibling_id" --from alice --ask > "$WORK/sibling.out" 2>&1 \
  || { cat "$WORK/sibling.out" >&2; fail 'digest sibling did not park'; }
[ -f "$BUS/spool/$sibling_id.meta.json" ] || fail 'digest sibling has no spool entry'
rm -f "${WORK:?}/tmux/input.sess_0_0"
# Draft gone and sentinel manually submitted: production's waiter releases the
# protection hold before any drain sees the pane; the fake clock cannot expire
# the real-clock grace, so simulate that release outcome.
tap_protection_release_all
touch "$WORK/tmux/disable-repaint"
drain_rc=0
spool_drain_fixture_once || drain_rc=$?
case "$drain_rc" in 0|5) ;; *) fail "manual-submit drain returned $drain_rc" ;; esac
if compgen -G "$BUS/spool/digests/*.json" >/dev/null; then
  fail 'pending re-probe entered digest batching after the staged sentinel left'
fi
[ -f "$BUS/payloads/$digest_id.md" ] && [ ! -f "$BUS/receipts/$digest_id.sent" ] \
  || fail 'manual-submit possible effect was redelivered or lost'
[ -f "$BUS/receipts/$sibling_id.sent" ] || fail 'eligible sibling was not delivered individually'
unset TAP_SPOOL_DISABLE_DELIVERER

echo 'agy-transition-reprobe: exact in-place recovery passed; no-spool and digest possible-effect controls stayed terminal'
