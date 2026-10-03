#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# watch-notify-semantics.test.sh — round-2 rulings #3/#4 plus v0.7 queueing:
#   #5  a no-prompt probe is durably queued once; it does not notify until the
#       queued probe leaves spool and its full response window expires.
#   #4  a forced unknown/unresolvable actor disarm owes the armer a kind=notice.
#   #3  a NOTIFY is sticky until `tap watch ack` or an armer disarm — an episode reset does
#       not clear it, and a later NOTIFY while one is unacked MERGES (first at/reason kept).
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

export TAP_SPOOL_DISABLE_DELIVERER=1

# Mock-tmux smoke: the courier's real-TUI settle sleeps verify nothing against
# a synchronous mock — scale them down (smoke-speed PR2; default 1 in production).
export TAP_TUI_SETTLE_SCALE=0.1
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAPSH="$ROOT/bin/tap"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
# Redirect the machine index home: tap-watch.sh now invokes tap-escalate.sh
# best-effort on NOTIFY (CONTRACT.md §Escalation). Escalate no longer consults
# any target config: as of v0.21 it invokes the NOTIFIER directly, so what keeps
# a smoke off a real person's phone is sandbox-pins.sh's TAP_NOTIFY_USER_BIN
# default (a nonexistent path -> fail loud), NOT this redirect. The redirect
# stays because the machine index is operator state a smoke must never touch.
export TAP_INDEX_HOME="$WORK/index"

# tmux mock: pane content is state-driven. $state/approval -> an approval dialog (no input
# prompt, so a send defers AND seat_state reads blocked-on-approval); otherwise an empty ❯.
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"; mkdir -p "$state"
cmd="$1"; shift
case "$cmd" in
  # CONTRACT §Session-name authority: present the exact current session,
  # generation, designated pane, and harness as one coherent tmux snapshot.
  list-sessions)
    printf 'sess\t4242:100\n' ;;
  list-panes)
    case "${@: -1}" in
      *pane_tty*) printf '%%11\t/dev/faketty\n' ;;
      *) printf 'sess\tsess:0.0\t%%11\tcodex\t4242\t4242:100\t0\n' ;;
    esac ;;
  display-message)
    fmt="${@: -1}"
    if [ "$fmt" = '#{pid}:#{start_time}' ]; then echo "4242:100"; exit 0; fi
    case "$fmt" in
      *pane_id*session_name*pane_pid*pane_current_command*)
        t=""; p=""; for a in "$@"; do [ "$p" = -t ] && t="${a#=}"; p="$a"; done
        case "$t" in sess:0.0|%11|sess) printf '%%11\tsess\t4242\tcodex\t0\n' ;; *) printf '\t\t\t\t0\n' ;; esac ;;
      # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
      *pane_id*pane_tty*session_name*) printf '%%11\t/dev/faketty\tsess\t%s\n' "${FAKE_EPOCH_RAW-4242:100}" ;;
      *pane_id*session_name*) printf '%%11\tsess\t%s\n' "${FAKE_EPOCH_RAW-4242:100}" ;;
      *pane_id*pane_tty*) printf '%%11\t/dev/faketty\n' ;;
      *session_name*) echo "sess" ;;
      *pane_id*) echo "%11" ;;
      *pane_pid*) echo "4242" ;;
      *pane_in_mode*) echo "0" ;;
      *pane_current_command*) echo "codex" ;;
      *pane_current_path*) echo "${FAKE_WORKTREE:?}" ;;
      *window_activity*) echo "${FAKE_WINDOW_ACTIVITY:-100}" ;;
      *) echo "" ;;
    esac ;;
  capture-pane)
    if [ -f "$state/approval" ]; then printf '? Approve this command?\n'
    elif [ -f "$state/input" ]; then printf '❯ %s\n' "$(cat "$state/input")"
    else printf '❯ \n'; fi ;;
  send-keys)
    [ "${1:-}" = "-t" ] && shift 2
    case "${1:-}" in
      -l) shift; [ "${1:-}" = "--" ] && shift; printf '%s' "${1:-}" > "$state/input"; exit 0 ;;
      C-u|Enter) rm -f "$state/input"; exit 0 ;;
    esac ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
cat > "$FAKE_BIN/ps" <<'PS'
#!/usr/bin/env bash
case "$*" in
  *ppid=*tty=*) [ -n "${TMUX:-}" ] && printf '1 faketty\n' || printf '1 ?\n' ;;
  *) printf ' 4242 1 codex codex --dangerously-bypass-approvals\n' ;;
esac
PS
chmod +x "$FAKE_BIN/ps"
export PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket" FAKE_TMUX_STATE="$WORK/tmux" FAKE_WORKTREE="$WORK/repo"

BUS="$WORK/repo/.tap/bus"; mkdir -p "$BUS/payloads" "$BUS/receipts" "$WORK/repo"; export TAP_HOME="$BUS"
cat > "$BUS/registry.json" <<JSON
{"schema": "0.20",  "team": { "name": "t", "worktree_root": "$WORK/repo" },
  "seats": { "lead": { "pane": "sess:0.0", "pane_id": "%11", "session": "sess", "server_epoch": "srv:4242:100", "harness": "codex", "status": "active", "registered_from_worktree": "$WORK/repo" } } }
JSON
# Born live (F2a): native verbs refuse an absent machine marker, so enroll the team.
mkdir -p "$TAP_INDEX_HOME"
printf '{"schema":"0.20","teams":{"t":{"root":"%s","registry_location":"%s","state":"registered"}}}\n' \
  "$(mkdir -p "$WORK/repo" && cd "$WORK/repo" && pwd -P)" "$(cd "$BUS" && pwd -P)/registry.json" > "$TAP_INDEX_HOME/global-registry.json"

field()  { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],""))' "$BUS/watch/arm.json" "$1"; }
njson()  { python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get(sys.argv[2],""))
except Exception: print("")' "$BUS/watch/notify.json" "$1"; }
notice_payload() { grep -l '^kind: notice$' "$BUS"/payloads/*.md 2>/dev/null | head -1 || true; }
# terminal MUST differ from the probed seat: the chain builder excludes the terminal from
# the regular seat list and re-adds it only if idle-at-prompt, so a blocked terminal would
# collapse the chain to just __human__. `ghost` is unregistered (ineligible) -> not a rung.
arm() { bash "$TAPSH" watch on --rearm --by lead -m "done; proof; bound" --evaluator none \
          --threshold 1500 --probe-timeout 1500 --chain '["lead"]' --terminal ghost "$@" --no-spawn >/dev/null 2>&1; A="$(field armed_at)"; }

# ---- #5: no-prompt probe queues once, then ordinary exhaustion notifies -------
mkdir -p "$FAKE_TMUX_STATE"; : > "$FAKE_TMUX_STATE/approval"
arm
TAP_WATCH_NOW="$((A + 2000))" bash "$TAPSH" watch tick >/dev/null 2>&1
[ ! -f "$BUS/watch/notify.json" ] || { echo "watch-notify: (#5) queued probe notified before delivery/timeout" >&2; exit 1; }
queued_id="$(field queued_probe_id)"
[ -n "$queued_id" ] && [ -f "$BUS/spool/$queued_id.md" ] \
  || { echo "watch-notify: (#5) no-prompt probe was not durably queued" >&2; exit 1; }
rm -f "$FAKE_TMUX_STATE/approval"
TAP_WATCH_NOW="$((A + 2001))" bash "$TAPSH" watch tick >/dev/null 2>&1
[ "$(field last_probe_at)" = "$((A + 2001))" ] \
  || { echo "watch-notify: (#5) delivered queued probe did not start its response clock" >&2; exit 1; }
TAP_WATCH_NOW="$((A + 3501))" bash "$TAPSH" watch tick >/dev/null 2>&1
[ -f "$BUS/watch/notify.json" ] || { echo "watch-notify: (#5) exhausted delivered probe did not raise a NOTIFY" >&2; exit 1; }
[ "$(njson acked)" = "0" ] || { echo "watch-notify: (#5) NOTIFY should be unacked" >&2; exit 1; }
notify_reason="$(njson reason)"
grep -qi "chain exhausted" <<<"$notify_reason" || { echo "watch-notify: (#5) NOTIFY reason should name chain exhaustion: $notify_reason" >&2; exit 1; }
echo "watch-notify: (#5) no-prompt probe queues once; notification waits for delivery + timeout: ok"

# ---- #3: NOTIFY is sticky — episode reset + a later NOTIFY MERGE, not clobber -
first_at="$(njson at)"; first_reason="$(njson reason)"
# real bus activity after the episode -> resumption resets the episode on the next tick.
printf -- '---\nid: work-r2\nfrom: lead\nto: peer\nkind: discuss\n---\nreal work\n' > "$BUS/payloads/work-r2.md"
python3 -c 'import os,sys; os.utime(sys.argv[1], (int(sys.argv[2]), int(sys.argv[2])))' "$BUS/payloads/work-r2.md" "$((A + 4000))"
TAP_WATCH_NOW="$((A + 4100))" bash "$TAPSH" watch tick >/dev/null 2>&1   # resumption -> episode reset
[ -f "$BUS/watch/notify.json" ] || { echo "watch-notify: (#3) episode reset cleared the unacked NOTIFY" >&2; exit 1; }
rm -f "$BUS/payloads/work-r2.md"
# a fresh wedge + chain-exhaustion NOTIFY must MERGE with the pending one (keep first at/reason).
TAP_WATCH_NOW="$((A + 6000))" bash "$TAPSH" watch tick >/dev/null 2>&1
[ "$(njson at)" = "$first_at" ] || { echo "watch-notify: (#3) later NOTIFY clobbered the first at ($(njson at) != $first_at)" >&2; exit 1; }
[ "$(njson reason)" = "$first_reason" ] || { echo "watch-notify: (#3) later NOTIFY clobbered the first reason" >&2; exit 1; }
[ "$(njson acked)" = "0" ] || { echo "watch-notify: (#3) merged NOTIFY lost acked=0" >&2; exit 1; }
echo "watch-notify: (#3) unacked NOTIFY survives episode reset and merges (first at/reason kept): ok"

# ack clears the stickiness; only THEN does a new escalation write a fresh NOTIFY.
bash "$TAPSH" watch ack --by lead >/dev/null 2>&1
[ "$(njson acked)" = "1" ] || { echo "watch-notify: (#3) ack did not mark the NOTIFY acked" >&2; exit 1; }
TAP_WATCH_NOW="$((A + 9000))" bash "$TAPSH" watch tick >/dev/null 2>&1
[ "$(njson acked)" = "0" ] && [ "$(njson at)" != "$first_at" ] || { echo "watch-notify: (#3) a post-ack escalation did not write a fresh NOTIFY" >&2; exit 1; }
echo "watch-notify: (#3) ack unsticks; a later escalation writes a fresh NOTIFY: ok"

# (#3c) a NON-ARMER disarm must NOT clear an unacked sticky NOTIFY (only `ack` or an ARMER
# disarm clears it); an ARMER disarm does clear it.
rm -f "$BUS"/payloads/*.md "$BUS/watch/notify.json" 2>/dev/null || true
arm; : > "$FAKE_TMUX_STATE/approval"
TAP_WATCH_NOW="$((A + 2000))" bash "$TAPSH" watch tick >/dev/null 2>&1
rm -f "$FAKE_TMUX_STATE/approval"
# Drain the queued probe and exhaust its response window to create the sticky notice.
TAP_WATCH_NOW="$((A + 2001))" bash "$TAPSH" watch tick >/dev/null 2>&1
TAP_WATCH_NOW="$((A + 3501))" bash "$TAPSH" watch tick >/dev/null 2>&1
[ -f "$BUS/watch/notify.json" ] || { echo "watch-notify: (#3c setup) expected a sticky NOTIFY before disarm" >&2; exit 1; }
# tap-calo: the actor is the calling pane, not --by, and the fake pane is the armer's; a non-armer is a
# caller that resolves to no seat (TMUX unset), which only --force can disarm as.
env -u TMUX -u TAP_SELF bash "$TAPSH" watch off --force >/dev/null 2>&1  # forced non-armer disarm
[ -f "$BUS/watch/notify.json" ] || { echo "watch-notify: (#3c) a non-armer disarm cleared the sticky NOTIFY" >&2; exit 1; }
echo "watch-notify: (#3c) forced non-armer disarm leaves the sticky NOTIFY standing: ok"
arm --chain '["ghostx"]'; TAP_WATCH_NOW="$((A + 2000))" bash "$TAPSH" watch tick >/dev/null 2>&1
bash "$TAPSH" watch off --by lead >/dev/null 2>&1                        # armer disarm
[ ! -f "$BUS/watch/notify.json" ] || { echo "watch-notify: (#3c) armer disarm did not clear the sticky NOTIFY" >&2; exit 1; }
echo "watch-notify: (#3c) armer disarm clears the sticky NOTIFY: ok"

# (#3d) an ACKED NOTIFY does not re-fire while the SAME wedge episode stays exhausted (once
# per episode) — otherwise every tick would rewrite acked=0 and re-ping the human.
rm -f "$BUS"/payloads/*.md "$BUS/watch/notify.json" 2>/dev/null || true
arm --chain '["ghostx"]'                                    # unregistered rung -> chain is just __human__
TAP_WATCH_NOW="$((A + 2000))" bash "$TAPSH" watch tick >/dev/null 2>&1   # exhaust -> NOTIFY
[ -f "$BUS/watch/notify.json" ] || { echo "watch-notify: (#3d setup) expected a chain-exhaustion NOTIFY" >&2; exit 1; }
bash "$TAPSH" watch ack --by lead >/dev/null 2>&1
[ "$(njson acked)" = "1" ] || { echo "watch-notify: (#3d setup) ack did not stick" >&2; exit 1; }
TAP_WATCH_NOW="$((A + 2100))" bash "$TAPSH" watch tick >/dev/null 2>&1   # same episode, still exhausted
[ "$(njson acked)" = "1" ] || { echo "watch-notify: (#3d) an acked NOTIFY re-fired within the same episode" >&2; exit 1; }
echo "watch-notify: (#3d) acked NOTIFY does not re-fire within the same episode: ok"

# A refused derived actor cannot acknowledge the sticky notice as an empty or
# unknown identity. The notification bytes remain untouched.
before="$(cat "$BUS/watch/notify.json")"
rc=0; FAKE_EPOCH_RAW= bash "$TAPSH" watch ack >"$WORK/unverifiable-ack.out" 2>&1 || rc=$?
[ "$rc" = 1 ] || { echo "watch-notify: refusal ack should fail with exit 1, got $rc" >&2; exit 1; }
grep -q "server generation is unavailable" "$WORK/unverifiable-ack.out" \
  || { echo "watch-notify: refusal ack did not name the unavailable generation" >&2; cat "$WORK/unverifiable-ack.out" >&2; exit 1; }
[ "$before" = "$(cat "$BUS/watch/notify.json")" ] \
  || { echo "watch-notify: refusal ack changed notify.json" >&2; exit 1; }
echo "watch-notify: refused actor cannot acknowledge or change sticky state: ok"

# ---- #4: forced unknown/unresolvable actor `off` owes a loud notice -----------
rm -f "$FAKE_TMUX_STATE/approval" "$BUS"/payloads/*.md "$BUS/watch/notify.json" 2>/dev/null || true
arm
# `off` with no --by and no resolvable self handle (TMUX unset -> tap_resolve_self_handle
# fails) leaves actor UNKNOWN. --force is the dead-armer escape and owes the armer a notice.
# With no pane to inject into, that notice falls back to the sticky NOTIFY — loud, never a
# silent skip (the pre-#4 code required a resolvable actor and skipped the notice here).
env -u TMUX -u TAP_SELF bash "$TAPSH" watch off --force >/dev/null 2>&1 || true
[ ! -f "$BUS/watch/arm.json" ] || { echo "watch-notify: (#4) unknown-actor off did not disarm" >&2; exit 1; }
notice="$(notice_payload)"
if [ -n "$notice" ]; then
  grep -q '^to: lead$' "$notice" || { echo "watch-notify: (#4) non-armer notice not addressed to the armer" >&2; exit 1; }
else
  [ -f "$BUS/watch/notify.json" ] || { echo "watch-notify: (#4) unknown-actor off was silent (no notice, no fallback NOTIFY)" >&2; exit 1; }
fi
echo "watch-notify: (#4) forced unknown-actor off owes a loud notice and disarms: ok"

echo "watch-notify-semantics: ok"
