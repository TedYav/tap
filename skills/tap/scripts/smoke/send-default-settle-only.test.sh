#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# send-default-settle-only.test.sh — tap-gyc91: a plain tap send stamps
# `reply: settle-only` in the envelope, `note` in the wire's obligation slot, and
# parks for the courier digest; --ask/--reply (and
# --expect-reply) request a reply; --fyi is a no-op alias of the default.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

export TAP_TUI_SETTLE_SCALE=0.1
export TAP_SPOOL_DISABLE_DELIVERER=1

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAPSH="$ROOT/bin/tap"
LIB="$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
export TAP_INDEX_HOME="$WORK/index"
mkdir -p "$TAP_INDEX_HOME" && printf '{"schema":"0.20","teams":{}}\n' > "$TAP_INDEX_HOME/global-registry.json"  # born live (F1)

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"; mkdir -p "$state"
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
  list-panes)
    printf 'sess\tsess:0.0\t%%401\t%s\t5001\t4242:100\t0\n' "${FAKE_TMUX_CMD:-codex}"
    printf 'sess\tsess:0.1\t%%402\tcodex\t5002\t4242:100\t0\n'
    printf 'sess\tsess:0.2\t%%403\tcodex\t5003\t4242:100\t0\n'
    ;;
  display-message)
    fmt="${@: -1}"
    target=""; argv=("$@")
    for ((i=0; i<${#argv[@]}; i++)); do [ "${argv[$i]}" = "-t" ] && target="${argv[$((i+1))]}"; done
    case "$target" in
      sess:0.1|%402) pid="%402" ;;
      sess:0.2|%403) pid="%403" ;;
      *)        pid="${FAKE_PANE_ID:-%401}" ;;
    esac
    case "$fmt" in
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%s\tsess\t4242\t%s\t0\n' "$pid" "${FAKE_TMUX_CMD:-codex}" ;;
      '#{pid}:#{start_time}') printf '4242:100\n' ;;
      *pane_id*pane_tty*session_name*) printf '%s\t/dev/faketty\tsess\t4242:100\n' "$pid" ;;
      *pane_id*session_name*) printf '%s\tsess\t4242:100\n' "$pid" ;;
      *session_name*)         echo "sess" ;;
      *pane_id*)              echo "$pid" ;;
      *pane_pid*)             echo "4242" ;;
      *pane_in_mode*)         [ -f "$state/copy_mode" ] && echo "1" || echo "0" ;;
      *pane_current_command*) echo "${FAKE_TMUX_CMD:-codex}" ;;
      *pane_current_path*)    echo "${FAKE_WORKTREE:?}" ;;
      *window_activity*)      echo "100" ;;
      *)                      echo "" ;;
    esac ;;
  capture-pane)
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
      printf '%s' "${1:-}" > "$state/input.$key"
      printf '%s' "${1:-}" > "$state/last-sentinel"
      exit 0
    fi
    if [ "${1:-}" = "Enter" ]; then rm -f "$state/input.$key"; exit 0; fi
    ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket" FAKE_TMUX_STATE="$WORK/tmux" \
       FAKE_WORKTREE="$WORK/repo" FAKE_TMUX_CMD="codex" FAKE_PANE_ID="%401"
export TAP_SERVER_EPOCH="srv:4242:100" TAP_BOOT_ID="boot:1"
mkdir -p "$WORK/tmux" "$WORK/repo"

BUS="$WORK/repo/.tap/bus"; mkdir -p "$BUS/payloads" "$BUS/receipts" "$BUS/spool"; export TAP_HOME="$BUS"
cat > "$BUS/registry.json" <<JSON
{ "schema": "0.20", "team": { "name": "t", "worktree_root": "$WORK/repo" },
  "seats": {
    "peer":  { "session": "sess", "pane": "sess:0.0", "pane_id": "%401", "harness": "codex", "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "registered_from_worktree": "$WORK/repo" },
    "alice": { "session": "sess", "pane": "sess:0.1", "pane_id": "%402", "harness": "codex", "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "registered_from_worktree": "$WORK/repo" },
    "hermes": { "session": "sess", "pane": "sess:0.2", "pane_id": "%403", "harness": "codex", "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "registered_from_worktree": "$WORK/repo" },
    "ghost": { "delivery": "poll", "unattended": true, "status": "active", "harness": "codex" }
  } }
JSON

LOG="$WORK/tmux/send-keys.log"
# shellcheck source=skills/tap/scripts/smoke/runtime-helpers.sh
. "$LIB"
tap_ensure_dirs

fail() { echo "send-default: $*" >&2; [ -f "$LOG" ] && cat "$LOG" >&2; exit 1; }
injected() { grep -qE "\[\[TAP v0\.23 (ask|note) ([A-Za-z0-9_.-]+/)?$1( |\]\])" "$LOG" 2>/dev/null; }
meta_field() {
  python3 -B -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get(sys.argv[2]) or "")
except Exception: print("")' "$BUS/spool/$1.meta.json" "$2" 2>/dev/null || true
}
envelope_reply() {
  grep -E '^reply: ' "$BUS/payloads/$1.md" | head -1 | awk '{print $2}'
}
send() { bash "$TAPSH" send "$@"; }
reset_bus() {
  rm -rf "$BUS/payloads"/*.md "$BUS/receipts"/*.done "$BUS/receipts"/*.cancelled \
         "$BUS/receipts"/*.sent "$BUS/receipts"/*.placed \
         "$BUS/spool"/*.md "$BUS/spool"/*.meta.json* "$BUS/spool"/*.claim \
         "$BUS/spool/digests" "$BUS/delivery" 2>/dev/null || true
  : > "$LOG"
  rm -f "$WORK"/tmux/input.* "$WORK/tmux/last-sentinel"
}

HOLD_LONG=99999

# ---- (1) default pane send stamps settle-only (tap-31it: --wake for the stamp) ----
reset_bus
TAP_AUTOSETTLE_HOLD_SECONDS=$HOLD_LONG send peer -m "hi" --id d1 --from alice --wake >/dev/null 2>&1 \
  || fail "(1) default --wake send failed"
[ "$(envelope_reply d1)" = "settle-only" ] || fail "(1) default send stamped '$(envelope_reply d1)', want settle-only"
# v0.23 (tap-7r3fn.8): `reply=` left the wire and the obligation is slot 2, one
# bare word. The AT-REST envelope keeps `reply: settle-only` (spec section 3) and
# the arms below still read it there — only the wire changed.
grep -qE '^\[\[TAP v[0-9.]+ note ' "$WORK/tmux/last-sentinel" \
  || fail "(1) sentinel obligation slot is not 'note'"
echo "send-default: (1) default pane send renders the note obligation: ok"

# ---- (2) --ask / --reply / --expect-reply stamp expected ----
# THE LOOP DELIVERS THREE TIMES TO ONE SEAT, so under tap-7r3fn.20 each delivery
# stamps the recipient's clock and the next send lands inside the window it just
# opened — parking instead of injecting, with no canonical payload for
# envelope_reply to read. That is the ruled behaviour, not a regression: the
# window is a flood limiter for the seat and reply expectation is orthogonal to
# it (TERMINAL item 1; the expert's control is "--ask at T+2 after a delivery at
# T parks and lands at T+10"). Three rapid sends to one pane is exactly the flood
# it limits.
#
# This arm is about the STAMP — that each spelling reaches reply: expected — so it
# resets the clock between iterations rather than encoding a window it does not
# mean to test. delivery-window-drain owns the parking behaviour.
for flag in --ask --reply --expect-reply; do
  reset_bus
  id="ask-${flag#--}"
  TAP_AUTOSETTLE_HOLD_SECONDS=$HOLD_LONG send peer -m "need reply" --id "$id" --from alice --wake "$flag" >/dev/null 2>&1 \
    || fail "(2) $flag send failed"
  [ "$(envelope_reply "$id")" = "expected" ] || fail "(2) $flag stamped '$(envelope_reply "$id")', want expected"
  grep -qE '^\[\[TAP v[0-9.]+ ask ' "$WORK/tmux/last-sentinel" || fail "(2) $flag sentinel obligation slot is not 'ask'"
done
echo "send-default: (2) --ask/--reply/--expect-reply render the ask obligation: ok"

# ---- (3) --fyi is a no-op alias; --fyi --ask refuses ----
reset_bus
TAP_AUTOSETTLE_HOLD_SECONDS=$HOLD_LONG send peer -m "fyi" --id f1 --from alice --fyi --wake >/dev/null 2>&1 \
  || fail "(3) --fyi --wake send failed"
[ "$(envelope_reply f1)" = "settle-only" ] || fail "(3) --fyi stamped '$(envelope_reply f1)', want settle-only"
set +e
out3="$(TAP_AUTOSETTLE_HOLD_SECONDS=$HOLD_LONG send peer -m "both" --id f2 --from alice --fyi --ask --wake 2>&1)"
rc3=$?
set -e
[ "$rc3" -ne 0 ] || fail "(3) --fyi --ask should refuse"
case "$out3" in *"--fyi"*|*"--ask"*) ;; *) fail "(3) refusal should name --fyi/--ask, got: $out3" ;; esac
[ ! -f "$BUS/payloads/f2.md" ] || fail "(3) refused --fyi --ask placed a payload"
echo "send-default: (3) --fyi aliases the default; --fyi --ask refuses: ok"

# ---- (4) unattended interplay ----
# Three deliveries to one seat, so the clock is reset between them for the reason
# arm (2) states: each delivery opens a window and the next send would park
# inside it. These arms are about the STAMP and the downgrade warning, not about
# when mail arrives.
reset_bus
TAP_AUTOSETTLE_HOLD_SECONDS=$HOLD_LONG send peer -m "cron" --id u1 --from ghost --wake >/dev/null 2>&1 \
  || fail "(4) unattended plain send failed"
[ "$(envelope_reply u1)" = "settle-only" ] || fail "(4) unattended plain send stamped '$(envelope_reply u1)', want settle-only"

rm -rf "$BUS/delivery"
set +e
out4a="$(TAP_AUTOSETTLE_HOLD_SECONDS=$HOLD_LONG send peer -m "grant" --id u2 --from ghost --reply-to hermes --ask --wake 2>&1)"
rc4a=$?
set -e
[ "$rc4a" -eq 0 ] || fail "(4) unattended + reply_to + --ask failed: $out4a"
case "$out4a" in *"downgraded"*) fail "(4) grant should not print the unattended downgrade warning: $out4a" ;; esac
[ "$(envelope_reply u2)" = "expected" ] || fail "(4) grant stamped '$(envelope_reply u2)', want expected"

rm -rf "$BUS/delivery"
set +e
out4b="$(TAP_AUTOSETTLE_HOLD_SECONDS=$HOLD_LONG send peer -m "no grant" --id u3 --from ghost --ask --wake 2>&1)"
rc4b=$?
set -e
[ "$rc4b" -eq 0 ] || fail "(4) unattended --ask without reply_to failed: $out4b"
case "$out4b" in *"downgraded"*) ;; *) fail "(4) missing-grant --ask should warn it was downgraded: $out4b" ;; esac
[ "$(envelope_reply u3)" = "settle-only" ] || fail "(4) missing-grant --ask stamped '$(envelope_reply u3)', want settle-only"
echo "send-default: (4) unattended default/grant/downgrade: ok"

# ---- (5) a default note delivers bare and waits for recipient settlement ----
reset_bus
TAP_AUTOSETTLE_HOLD_SECONDS=$HOLD_LONG send peer -m "note body" --id p1 --from alice >/dev/null 2>&1 \
  || fail "(5) default send failed"
injected p1 || fail "(5) bare default note was not injected"
[ -f "$BUS/receipts/p1.sent" ] || fail "(5) default note was not verified"
[ ! -f "$BUS/spool/p1.md" ] || fail "(5) default note parked"
[ ! -f "$BUS/receipts/p1.done" ] || fail "(5) sender falsely settled note"
[ -f "$BUS/payloads/p1.md" ] || fail "(5) canonical body missing"
OUT="$(bash "$TAPSH" outstanding alice --json 2>/dev/null || true)"
python3 -c 'import json,sys; d=json.loads(sys.argv[1]); assert any(i["id"]=="p1" for i in d["outstanding"]),d' "$OUT" \
  || fail "(5) unread note is not outstanding"
echo "send-default: (5) bare note delivered and awaits recipient read: ok"

# Watcher progress is a NOTE, unlike its probe/notice wake instruments.
reset_bus
TAP_AUTOSETTLE_HOLD_SECONDS=$HOLD_LONG send peer -m "progress observed" --id wp1 --from watcher --kind progress --fyi >"$WORK/watch-progress.out" 2>&1 \
  || { cat "$WORK/watch-progress.out" >&2; fail "(6) watcher progress note refused"; }
injected wp1 || fail "(6) bare watcher progress note was not injected"
[ ! -f "$BUS/receipts/wp1.done" ] || fail "(6) watcher note falsely settled"
grep -q '^reply: settle-only$' "$BUS/payloads/wp1.md" || fail "(6) watcher progress is not a NOTE"
echo "send-default: (6) watcher progress uses recipient-settled note delivery: ok"

# ---- (7) --from watcher without --fyi refuses toward the door that exists (tap-87zz) ----
# The watcher identity is reserved: it has no pane and cannot register, so the
# generic unregistered-sender remedies (`tap in watcher`, a poll registration)
# are dead ends. The refusal must name the settle-only supervisor note door.
# Primary assertion drives the PUBLIC NATIVE door with --json: bin/tap's send
# parse carries TAP_JSON=1 into the delegated Bash child, so this one call pins
# the machine class (unregistered_sender) AND the native->Bash delegation.
reset_bus
set +e
json7="$("$ROOT/bin/tap" send peer -m "watcher mail" --id w7j --from watcher --json 2>/dev/null)"
rc7=$?
set -e
[ "$rc7" -eq 1 ] || fail "(7) json: watcher --from without --fyi should exit 1, got $rc7: $json7"
case "$json7" in
  *'"error_class":"unregistered_sender"'*) ;;
  *) fail "(7) json refusal should carry class unregistered_sender, got: $json7" ;;
esac
case "$json7" in
  *'"action":"tap send peer -f <path> --from watcher --kind notice"'*) ;;
  *) fail "(7) json refusal should carry the exact supervisor-note action, got: $json7" ;;
esac
case "$json7" in
  *"reserved watch-sidecar identity"*"cannot register"*) ;;
  *) fail "(7) json detail should say the identity is reserved and cannot register, got: $json7" ;;
esac
# Second call pins the human-render bytes the JSON call cannot see.
set +e
out7="$(TAP_AUTOSETTLE_HOLD_SECONDS=$HOLD_LONG send peer -m "watcher mail" --id w7 --from watcher 2>&1)"
rc7=$?
set -e
[ "$rc7" -eq 1 ] || fail "(7) human: watcher --from without --fyi should exit 1, got $rc7: $out7"
case "$out7" in
  "tap send: "*"; next: "*) ;;
  *) fail "(7) expected a tap-send refusal line, got: $out7" ;;
esac
case "$out7" in
  *"next: tap send peer -f <path> --from watcher --kind notice"*) ;;
  *) fail "(7) refusal should point at the supervisor note door, got: $out7" ;;
esac
case "$out7" in
  *"tap in watcher"*|*"tap register watcher"*) fail "(7) refusal still names a registration dead end: $out7" ;;
esac
for _id in w7 w7j; do
  [ ! -f "$BUS/payloads/$_id.md" ] || fail "(7) refused watcher send minted a payload for $_id"
  [ ! -f "$BUS/payloads/$_id.attempts" ] || fail "(7) refused watcher send recorded placement attempts for $_id"
done
echo "send-default: (7) reserved watcher without --fyi is refused toward the supervisor note door: ok"

echo "send-default-settle-only: ok"
