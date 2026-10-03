#!/usr/bin/env bash
# A drain must not condemn a completed binding using a pre-publication snapshot.
# The publication-race, legacy-binding, sender-removal-race and
# native-publication-failure arms live in runtime/bun/test/spool-publication-binding.test.ts
# (drain snapshot, park custody and publication-failure custody are native
# semantics asserted in the production runtime). This file keeps the
# withdrawal/stale-claim custody arms: public bin/tap cancel doors over the
# drain fixture, which stay shell per the migration rule.
# Run through smoke-all --only; every writer, bus and pane below is isolated.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"
# shellcheck source=helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"

export TAP_SPOOL_DISABLE_DELIVERER=1
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAPSH="$ROOT/bin/tap"
WORK="$(cd "$(mktemp -d)" && pwd -P)"; FAKE_BIN="$WORK/bin"
trap 'rm -rf "$WORK"' EXIT
export TAP_INDEX_HOME="$WORK/index"
export XDG_CONFIG_HOME="$WORK/config"   # absolute, and deliberately empty
mkdir -p "$FAKE_BIN" "$WORK/tmux" "$WORK/repo" "$XDG_CONFIG_HOME"

cat > "$FAKE_BIN/tmux" <<'TMUXMOCK'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"; mkdir -p "$state"
while [[ "${1:-}" == -L || "${1:-}" == -S ]]; do shift 2; done
# tmux resolves numeric pane ids and session addresses to the same input band.
args=()
for arg in "$@"; do
  case "$arg" in %401) arg=sess:0.0 ;; %402) arg=sess:0.1 ;; %403) arg=sess:0.2 ;; esac
  args+=("$arg")
done
set -- "${args[@]}"
cmd="$1"; shift
case "$cmd" in
  list-sessions) printf 'sess\t4242:100\n' ;;
  list-panes) printf 'sess\tsess:0.0\t%%401\t%s\t5001\t4242:100\t0\n' "${FAKE_TMUX_CMD:-codex}" ;;
  display-message)
    fmt="${@: -1}"
    case "$fmt" in
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%s\tsess\t4242\t%s\t0\n' "${FAKE_PANE_ID:-%401}" "${FAKE_TMUX_CMD:-codex}" ;;
      '#{pid}:#{start_time}') printf '4242:100\n' ;;
      *pane_id*pane_tty*session_name*) printf '%s\t/dev/faketty\tsess\t4242:100\n' "${FAKE_PANE_ID:-%401}" ;;
      *pane_id*session_name*) printf '%s\tsess\t4242:100\n' "${FAKE_PANE_ID:-%401}" ;;
      *session_name*)         echo "sess" ;;
      *pane_id*)              echo "${FAKE_PANE_ID:-%401}" ;;
      *pane_pid*)             echo "4242" ;;
      *pane_in_mode*)         echo probe >> "$state/mode-probes"; [ -f "$state/copy_mode" ] && echo "1" || echo "0" ;;
      *pane_current_command*) echo "${FAKE_TMUX_CMD:-codex}" ;;
      *pane_current_path*)    echo "${FAKE_WORKTREE:?}" ;;
      *window_activity*)      echo "100" ;;
      *)                      echo "" ;;
    esac ;;
  capture-pane)
    # Native promotion uses renameSync. Pause its first subsequent pane read
    # while the real delivery claim is held and before any payload key or .sent.
    # This fixture call gets 20s so its pause outlives cancel's 5s lock wait.
    if [ "${WITHDRAW_PAUSE_DRAIN:-}" = 1 ] && [ -f "$TAP_HOME/payloads/$WITHDRAW_ID.md" ] \
       && [ ! -f "$WITHDRAW_BARRIER/drain-release" ]; then
      : > "$WITHDRAW_BARRIER/promoted"
      for _ in $(seq 1 300); do
        [ ! -f "$WITHDRAW_BARRIER/drain-release" ] || break
        sleep 0.05
      done
      [ -f "$WITHDRAW_BARRIER/drain-release" ] || { echo 'drain barrier timed out' >&2; exit 1; }
    fi
    target=""
    while [ $# -gt 0 ]; do case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac; done
    key="${target//[:.\/]/_}"
    if [ -f "$state/input.$key" ]; then printf '❯ %s\n' "$(cat "$state/input.$key")"
    else printf '❯ \n'; fi ;;
  send-keys)
    echo "$*" >> "$state/send-keys.log"
    key=""
    [ "${1:-}" = "-t" ] && { key="${2//[:.\/]/_}"; shift 2; }
    if [ "${1:-}" = "-l" ]; then
      shift; [ "${1:-}" = "--" ] && shift
      printf '%s' "${1:-}" > "$state/input.$key"; exit 0
    fi
    if [ "${1:-}" = "Enter" ]; then
      rm -f "$state/input.$key"
      exit 0
    fi
    ;;
esac
TMUXMOCK
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket" FAKE_TMUX_STATE="$WORK/tmux" \
       FAKE_WORKTREE="$WORK/repo" FAKE_TMUX_CMD="codex" FAKE_PANE_ID="%401"
export TAP_SERVER_EPOCH="srv:4242:100" TAP_BOOT_ID="boot:1"
BUS="$WORK/repo/.tap/bus"; mkdir -p "$BUS/payloads" "$BUS/receipts" "$BUS/spool"
export TAP_HOME="$BUS"
cat > "$BUS/registry.json" <<JSON
{ "schema": "0.20", "team": { "name": "t", "worktree_root": "$WORK/repo" },
  "seats": {
    "peer":  { "session": "sess", "pane": "sess:0.0", "pane_id": "%401", "harness": "codex", "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "registered_from_worktree": "$WORK/repo" },
    "alice": { "session": "sess", "pane": "sess:0.0", "pane_id": "%401", "harness": "codex", "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "registered_from_worktree": "$WORK/repo" }
  } }
JSON
# Born live: an absent marker opens no legacy door, so the fixture team is enrolled.
tap_smoke_enroll_current "$WORK/repo" "$BUS" t

fail() { echo "spool-publication-binding: FAIL — $*" >&2; exit 1; }

# A sender withdrawal and the drain must decide custody under the SAME claim.
# Pause cancel after its eligibility read, and drain after promotion/before .sent.
# The selected schedule must end in delivery OR withdrawal, never both receipts.
(
  . "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"; . "$ROOT/skills/tap/scripts/smoke/spool-engine-fixture.sh"
  export WITHDRAW_BARRIER="$WORK/withdraw-barrier"
  mkdir -p "$WITHDRAW_BARRIER"
  cancel_pid=""; drain_pid=""
  cleanup_withdraw() {
    : > "$WITHDRAW_BARRIER/cancel.cancel-after-eligibility.release"; : > "$WITHDRAW_BARRIER/drain-release"
    [ -z "$cancel_pid" ] || wait "$cancel_pid" 2>/dev/null || true
    [ -z "$drain_pid" ] || wait "$drain_pid" 2>/dev/null || true
    rm -f "${FAKE_BIN:?}/mkdir"
  }
  trap cleanup_withdraw EXIT
  await_marker() {
    for _ in $(seq 1 300); do
      for marker in $1; do [ -f "$marker" ] && return 0; done
      kill -0 "$2" 2>/dev/null || break
      sleep 0.05
    done
    return 1
  }
  for schedule in cancel-first drain-first; do
    export WITHDRAW_ID="withdraw-$schedule"
    rm -f "$WITHDRAW_BARRIER/"*
    printf human-draft > "$WORK/tmux/input.sess_0_0"
    bash "$TAPSH" send peer --ask --id "$WITHDRAW_ID" --from alice \
      -m 'withdrawal custody bytes' > "$WORK/$schedule-send.log" 2>&1
    test -f "$BUS/spool/$WITHDRAW_ID.md" || fail "$schedule sender did not park"
    cp "$BUS/spool/$WITHDRAW_ID.md" "$WORK/$schedule-expected.md"
    rm -f "$WORK/tmux/input.sess_0_0"
    # Draft gone: production's waiter already released the hold; the fake
    # clock cannot expire the real-clock grace, so simulate that release.
    tap_protection_release_all
    due=$(( $(date +%s) + 3600 ))
    if [ "$schedule" = cancel-first ]; then
      env TAP_SCRATCH_ONLY="$WORK" TAP_OBLIGATION_TEST_BARRIER="$WITHDRAW_BARRIER/cancel" \
        TAP_OBLIGATION_TEST_ID="$WITHDRAW_ID" TAP_OBLIGATION_TEST_STAGE="cancel-after-eligibility" \
        "$ROOT/bin/tap" cancel "$WITHDRAW_ID" --by alice --spooled --json \
        > "$WORK/$schedule-cancel.log" 2>&1 &
      cancel_pid=$!
      await_marker "$WITHDRAW_BARRIER/cancel.cancel-after-eligibility.*.reached" "$cancel_pid" \
        || { cat "$WORK/$schedule-cancel.log" >&2; fail 'cancel never reached post-eligibility barrier'; }
      WITHDRAW_PAUSE_DRAIN=1 TAP_TMUX_TIMEOUT_SECONDS=20 spool_drain_fixture_once "$due" > "$WORK/$schedule-drain.log" 2>&1 &
      drain_pid=$!
      # A claim held by cancel makes drain finish without promotion. Without
      # that shared claim it reaches the second barrier, exposing the old race.
      await_marker "$WITHDRAW_BARRIER/promoted" "$drain_pid" || true
      : > "$WITHDRAW_BARRIER/cancel.cancel-after-eligibility.release"
      cancel_rc=0; wait "$cancel_pid" || cancel_rc=$?; cancel_pid=""
      [ "$cancel_rc" = 0 ] || { cat "$WORK/$schedule-cancel.log" >&2; fail "cancel-first returned $cancel_rc"; }
      : > "$WITHDRAW_BARRIER/drain-release"
      wait "$drain_pid" || true; drain_pid=""
      spool_drain_fixture_once "$due" >> "$WORK/$schedule-drain.log" 2>&1 || true
      [ -f "$BUS/receipts/$WITHDRAW_ID.cancelled" ] || fail 'withdrawal receipt missing'
      python3 - "$BUS/receipts/$WITHDRAW_ID.cancelled" <<'REASON'
import json, sys
assert json.load(open(sys.argv[1]))['reason'] == 'spooled_withdrawn'
REASON
      [ ! -f "$BUS/receipts/$WITHDRAW_ID.sent" ] || fail 'same message was delivered AND withdrawn'
      cmp -s "$BUS/archive/$WITHDRAW_ID.cancelled.md" "$WORK/$schedule-expected.md" \
        || fail 'withdrawn bytes not archived'
      ! grep -F "$WITHDRAW_ID" "$WORK/tmux/send-keys.log" >/dev/null || fail 'withdrawn message injected'
      [ ! -f "$BUS/payloads/$WITHDRAW_ID.md" ] || fail 'withdrawn message remains canonical'
    else
      WITHDRAW_PAUSE_DRAIN=1 TAP_TMUX_TIMEOUT_SECONDS=20 spool_drain_fixture_once "$due" > "$WORK/$schedule-drain.log" 2>&1 &
      drain_pid=$!
      await_marker "$WITHDRAW_BARRIER/promoted" "$drain_pid" \
        || { cat "$WORK/$schedule-drain.log" >&2; fail 'drain never reached promotion barrier'; }
      test -f "$BUS/spool/$WITHDRAW_ID.claim" || fail 'promotion lacks a delivery claim'
      cancel_rc=0
      "$ROOT/bin/tap" cancel "$WITHDRAW_ID" --by alice --spooled --json \
        > "$WORK/$schedule-cancel.log" 2>&1 || cancel_rc=$?
      [ "$cancel_rc" != 0 ] || fail 'cancel withdrew after drain promotion'
      grep -q obligation_busy "$WORK/$schedule-cancel.log" || { cat "$WORK/$schedule-cancel.log" >&2; fail 'competing cancel did not report locked delivery custody'; }
      [ ! -f "$BUS/receipts/$WITHDRAW_ID.cancelled" ] || fail 'cancel refusal wrote a receipt'
      cmp -s "$BUS/payloads/$WITHDRAW_ID.md" "$WORK/$schedule-expected.md" || fail 'cancel refusal changed bytes'
      test -f "$BUS/spool/$WITHDRAW_ID.claim" || fail 'cancel removed another writer claim'
      : > "$WITHDRAW_BARRIER/drain-release"
      wait "$drain_pid" || true; drain_pid=""
      [ -f "$BUS/receipts/$WITHDRAW_ID.sent" ] || { cat "$WORK/$schedule-drain.log" >&2; fail 'drain winner did not deliver'; }
      count="$(grep -F "$WITHDRAW_ID" "$WORK/tmux/send-keys.log" | wc -l | tr -d ' ')"
      [ "$count" = 1 ] || fail "drain winner injected $count times"
    fi
    [ ! -f "$BUS/spool/$WITHDRAW_ID.claim" ] || fail "$schedule leaked claim"
    [ ! -f "$BUS/spool/$WITHDRAW_ID.md" ] || fail "$schedule left a deliverable spool copy"
    echo "spool-publication-binding: $schedule preserves exactly one custody outcome"
  done

  # A stale pre-existing claim is still another owner's claim, never reclaimed
  # by withdrawal. Refusals after our own acquisition must release it.
  export WITHDRAW_ID=withdraw-refusal
  printf human-draft > "$WORK/tmux/input.sess_0_0"
  bash "$TAPSH" send peer --ask --id "$WITHDRAW_ID" --from alice \
    -m 'refusal custody bytes' > "$WORK/refusal-send.log" 2>&1
  cp "$BUS/spool/$WITHDRAW_ID.md" "$WORK/refusal-expected.md"
  claim="$TAP_SPOOL/$WITHDRAW_ID.claim"
  printf 'other-owner\n' > "$claim"
  python3 - "$claim" <<'STALE'
import os, sys
os.utime(sys.argv[1], (1, 1))
STALE
  rc=0
  "$ROOT/bin/tap" cancel "$WITHDRAW_ID" --by alice --spooled --json > "$WORK/refusal-held.log" 2>&1 || rc=$?
  [ "$rc" != 0 ] || fail 'cancel stole a stale claim'
  grep -q spool_busy "$WORK/refusal-held.log" || fail 'stale held claim not diagnosed'
  [ "$(cat "$claim")" = other-owner ] || fail 'failed acquisition changed another claim'
  rm -f "$claim"
  rc=0
  "$ROOT/bin/tap" cancel "$WITHDRAW_ID" --by other --spooled --json > "$WORK/refusal-actor.log" 2>&1 || rc=$?
  [ "$rc" != 0 ] || fail 'foreign actor cancelled'
  [ ! -e "$claim" ] || fail 'post-acquisition actor refusal leaked claim'
  cmp -s "$BUS/spool/$WITHDRAW_ID.md" "$WORK/refusal-expected.md" || fail 'refusal changed payload'
  [ ! -f "$BUS/receipts/$WITHDRAW_ID.cancelled" ] || fail 'refusal wrote cancellation'
  # Ordinary mkdir failure occurs after eligibility and must not leave custody.
  mv "$BUS/archive" "$WORK/old-archive"
  : > "$BUS/archive"
  rc=0
  "$ROOT/bin/tap" cancel "$WITHDRAW_ID" --by alice --spooled --json > "$WORK/refusal-error.log" 2>&1 || rc=$?
  [ "$rc" != 0 ] || fail 'archive obstruction accepted'
  [ ! -e "$claim" ] || fail 'post-acquisition archive failure leaked claim'
  cmp -s "$BUS/spool/$WITHDRAW_ID.md" "$WORK/refusal-expected.md" || fail 'archive failure changed payload'
  [ ! -f "$BUS/receipts/$WITHDRAW_ID.cancelled" ] || fail 'archive failure wrote cancellation'
  rm "$BUS/archive"; mv "$WORK/old-archive" "$BUS/archive"
  echo 'spool-publication-binding: failed acquisition preserves owner; later refusals release acquired claim'
)
