#!/usr/bin/env bash
# tap-o4ae: fixture env must stay in this process. Refuse `source` so an
# interactive shell cannot inherit top-level exports. Must run BEFORE any
# `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# goalie-rearm-authority.test.sh — tap-pqf2, goalie half.
#
# Two defects, both verified against the shipped verb before the fix:
#
#   1. `--rearm` skipped the entire armed-check block, so any peer could re-arm
#      another seat's lease under their own handle. Disarming someone else's
#      lease already required --force and sent them a durable notice; re-arming
#      it out from under them required nothing.
#
#   2. The settings refusal named `tap goalie off --by <STORED armer>`, which
#      instructed the caller to CLAIM ANOTHER SEAT'S IDENTITY — and it worked:
#      `goalie off` gates on `actor == owner || --force`, so passing the owner's
#      handle satisfied the gate, skipped the --force path that notifies the
#      owner, and printed "disarmed by '<owner>'" — misattributing the act to a
#      seat that did nothing. Not a dead door that fails; a live door that
#      succeeds at the thing being prevented.
#
# The fixture varies the CALLER, which is the axis both defects live on: with
# caller == armer every assertion below passes on the unfixed code.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAPSH="$ROOT/bin/tap"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT

# tap-calo: `goalie off` takes its actor from the calling pane (never --by), and the settings
# refusal picks its door from the same pane. The fixture varies the CALLER, so the fake answers the
# calling-pane observation for $FAKE_CALLER_PANE (%0 lead, %1 worker); unset = a pane-less caller.
cat > "$FAKE_BIN/ps" <<'PS'
#!/usr/bin/env bash
case "$*" in
  *ppid*tty*) [ -n "${FAKE_CALLER_PANE:-}" ] && printf '1 faketty\n' || printf '1 ??\n' ;;
  *) exec /bin/ps "$@" ;;
esac
PS
chmod +x "$FAKE_BIN/ps"
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
target=""; args=("$@"); i=0
while [ "$i" -lt "${#args[@]}" ]; do [ "${args[$i]}" = -t ] && target="${args[$((i+1))]:-}"; i=$((i+1)); done
fmt="${!#}"
case "${1:-}" in
  has-session) exit 0 ;;
  list-panes)
    case "$fmt" in
      *pane_tty*) [ -n "${FAKE_CALLER_PANE:-}" ] && printf '%s\t/dev/faketty\n' "$FAKE_CALLER_PANE"; exit 0 ;;
      *) printf '%s\n' "repo/goalie:0.0"; exit 0 ;;
    esac ;;
  display-message)
    case "$fmt" in
      *pane_id*pane_tty*session_name*) printf '%s\t/dev/faketty\trepo\t4242:100\n' "${target:-$FAKE_CALLER_PANE}" ;;
      *pane_id*session_name*) printf '%s\trepo\t4242:100\n' "${target:-$FAKE_CALLER_PANE}" ;;
      *pid*start_time*) printf '4242:100\n' ;;
      *) printf '%s\n' "1" ;;
    esac
    exit 0 ;;
  *) exit 0 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
# Observable notice sink: the "--force is LOUD" half is a claim about behaviour,
# so it is asserted rather than assumed. Without this mock the real sender fails
# and the call site swallows it with `|| true`, which reads as "no notice".
cat > "$FAKE_BIN/goalie-send" <<'SEND'
#!/usr/bin/env bash
printf '%s\n' "to=$1" >> "${FAKE_NOTICE_LOG:?}"
# The courier's accepted pane tuple is status=injected + delivery=pane (courierDisposition); an "ok"
# status reads as an undelivered notice, so the forced takeover reports goalie_owner_notify_failed.
printf '{"status":"injected","delivery":"pane","detail":"","action":""}\n'
SEND
chmod +x "$FAKE_BIN/goalie-send"
export PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket" TAP_INDEX_HOME="$WORK/index"
export TAP_COURIER_SCRIPT="$FAKE_BIN/goalie-send" FAKE_NOTICE_LOG="$WORK/notices"
: > "$FAKE_NOTICE_LOG"

BUS="$WORK/repo/.tap/bus"; mkdir -p "$BUS/payloads" "$BUS/receipts"
cat > "$BUS/registry.json" <<JSON
{"schema": "0.20",  "team": { "name": "repo", "worktree_root": "$WORK/repo" },
  "seats": {
    "lead":   { "pane": "repo/lead:0.0",   "pane_id": "%0", "server_epoch": "srv:4242:100", "harness": "claude", "status": "active", "delivery": "pane", "registered_from_worktree": "$WORK/repo" },
    "worker": { "pane": "repo/worker:0.0", "pane_id": "%1", "server_epoch": "srv:4242:100", "harness": "claude", "status": "active", "delivery": "pane", "registered_from_worktree": "$WORK/repo" },
    "goalie": { "pane": "repo/goalie:0.0", "pane_id": "%2", "server_epoch": "srv:4242:100", "harness": "hermes", "status": "active", "delivery": "pane", "registered_from_worktree": "$WORK/repo" } } }
JSON
# Born live (F2a): native verbs refuse an absent machine marker, so enroll the team.
mkdir -p "$TAP_INDEX_HOME"
printf '{"schema":"0.20","teams":{"repo":{"root":"%s","registry_location":"%s","state":"registered"}}}\n' \
  "$(cd "$WORK/repo" && pwd -P)" "$(cd "$BUS" && pwd -P)/registry.json" > "$TAP_INDEX_HOME/global-registry.json"

# R6 U3: the field read is the lease record itself (the Bash sourcing shape is
# gone with tap-goalie.sh).
gf ()   { python3 -B -c 'import json,sys
d = json.load(open(sys.argv[1]))
v = d.get(sys.argv[2], "")
print(v if not isinstance(v, str) else v)' "$BUS/goalie/arm.json" "$1"; }
fail () { echo "goalie-rearm-authority: $1" >&2; exit 1; }
arm_lead () {
  TAP_HOME="$BUS" bash "$TAPSH" goalie off --by lead --force >/dev/null 2>&1 || true
  TAP_HOME="$BUS" bash "$TAPSH" goalie on --by lead --threshold 300 --interval 60 --no-spawn >/dev/null 2>&1
  [ "$(gf armed_by)" = "lead" ] || fail "fixture: goalie is not armed by lead"
  : > "$FAKE_NOTICE_LOG"
}

# --- (a) a peer cannot silently re-arm another seat's lease -------------------
arm_lead
if TAP_HOME="$BUS" bash "$TAPSH" goalie on --by worker --threshold 999 --interval 5 --rearm --no-spawn >/dev/null 2>&1; then
  fail "(a) a peer re-armed another seat's lease with no authority check; armed_by=$(gf armed_by)"
fi
[ "$(gf armed_by)" = "lead" ] || fail "(a) refused re-arm still changed armed_by to '$(gf armed_by)'"
[ "$(gf threshold_seconds)" = "300" ] || fail "(a) refused re-arm still changed the threshold"
echo "goalie-rearm-authority: (a) a peer cannot silently re-arm another seat's lease: ok"

# --- (b) the forced re-arm works AND is loud ---------------------------------
arm_lead
TAP_HOME="$BUS" bash "$TAPSH" goalie on --by worker --threshold 999 --interval 5 --rearm --force --no-spawn >/dev/null 2>&1 \
  || fail "(b) the named --force remedy is rejected for a peer"
[ "$(gf armed_by)" = "worker" ] || fail "(b) forced re-arm did not take effect"
/usr/bin/grep -q "to=lead" "$FAKE_NOTICE_LOG" \
  || fail "(b) forced re-arm did NOT notify the previous owner; --force must be the loud path, not a quiet one"
echo "goalie-rearm-authority: (b) the forced re-arm applies and notifies the previous owner: ok"

# --- (c) the armer's own --rearm is untouched --------------------------------
arm_lead
TAP_HOME="$BUS" bash "$TAPSH" goalie on --by lead --threshold 999 --interval 5 --rearm --no-spawn >/dev/null 2>&1 \
  || fail "(c) the ARMER's own --rearm was refused; the gate must only bind non-armers"
[ "$(gf threshold_seconds)" = "999" ] || fail "(c) armer's --rearm did not apply"
echo "goalie-rearm-authority: (c) the armer's own --rearm needs no --force: ok"

# --- (d) the settings-refusal door must not instruct impersonation -----------
# Run the door TAP hands the peer, verbatim, and then check WHO the receipt says
# acted. The pre-fix door disarmed successfully while attributing the act to a
# seat that did nothing.
arm_lead
d_out="$(FAKE_CALLER_PANE=%1 TAP_HOME="$BUS" bash "$TAPSH" goalie on --by worker --threshold 999 --interval 5 --no-spawn 2>&1 || true)"
case "$d_out" in *"next: "*) ;; *) fail "(d) peer refusal carries no next:: $d_out" ;; esac
d_next="${d_out##*next: }"; d_next="${d_next%%$'\n'*}"
d_door="${d_next%%#*}"; d_door="$(printf '%s' "$d_door" | sed 's/[[:space:]]*$//')"
case "$d_door" in "tap "*) ;; *) fail "(d) peer's next: is not a runnable tap command: '$d_door'" ;; esac
case "$d_door" in
  *"--by lead"*) fail "(d) the door instructs the peer to run as 'lead' — impersonation, and it satisfies goalie off's gate while skipping the notice: '$d_door'" ;;
esac
# shellcheck disable=SC2086 -- deliberate word-splitting: run exactly what TAP printed
door_say="$(FAKE_CALLER_PANE=%1 TAP_HOME="$BUS" bash "$TAPSH" ${d_door#tap } 2>&1)" \
  || fail "(d) TAP handed the peer a door the peer cannot open: '$d_door'"
case "$door_say" in
  *"by 'worker'"*) ;;
  *) fail "(d) the door ran but the receipt misattributes the act: $door_say" ;;
esac
/usr/bin/grep -q "to=lead" "$FAKE_NOTICE_LOG" \
  || fail "(d) the peer's door disarmed another seat's lease without notifying the owner"
echo "goalie-rearm-authority: (d) the peer's door runs as the peer, attributes correctly, and notifies the owner: ok"

# --- (e) the armer's own door is unchanged -----------------------------------
arm_lead
e_out="$(FAKE_CALLER_PANE=%0 TAP_HOME="$BUS" bash "$TAPSH" goalie on --by lead --threshold 999 --interval 5 --no-spawn 2>&1 || true)"
# Needle is the NO-OP phrase, not "already armed" — the refusal text contains
# that too, so the looser needle matched the very case it was meant to exclude.
case "$e_out" in
  *"keeping the current episode"*) fail "(e) same-armer differing settings should refuse, not no-op: $e_out" ;;
esac
case "$e_out" in *"--rearm"*) ;; *) fail "(e) the armer's door should still offer --rearm: $e_out" ;; esac
echo "goalie-rearm-authority: (e) the armer's own door still offers --rearm: ok"

echo "PASS goalie-rearm-authority"
