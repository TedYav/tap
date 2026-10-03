#!/usr/bin/env bash
# D5: fixture-door — :573 delivery-clock.ts stamp plants a real clock file so the public `tap team reset` can be asserted on archive/discard behavior (module owner: runtime/bun/test/delivery-clock.test.ts); :18-24 additionally grep-reads watch-tick.ts's disposition table as a canary, and :183 is a literal inside a fake-ps fixture
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# goalie-sidecar.test.sh — deterministic idle gate, allowlisted verdicts, and watch rung.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

# The goalie consumes the courier contract as an exact tuple enumeration. A
# wildcard rc0 or retired rc4/spooled arm would silently accept contract drift.
# Every supervision sender (goalie tick, goalie verb, watch probe) reads it through
# watch-tick.ts `courierDisposition`.
GOALIE_IMPL="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)/runtime/bun/src/watch-tick.ts"
# R6 U3: the enumeration is native — same tuples, expressed as JSON pairs.
grep -Fq 'status === "injected" && delivery === "pane"' "$GOALIE_IMPL" \
  && grep -Fq 'status === "queued" && delivery === "spool"' "$GOALIE_IMPL" \
  && grep -Fq 'status === "queued" && delivery === "poll"' "$GOALIE_IMPL" \
  && grep -Fq 'status === "queued" && delivery === "harness-queue" && turn === "unconfirmed"' "$GOALIE_IMPL" \
  && grep -Fq 'rc === 5 && status === "pending"' "$GOALIE_IMPL" \
  || { echo "goalie: courier tuple allowlist is not exact" >&2; exit 1; }
! grep -q '4:spooled' "$GOALIE_IMPL" \
  || { echo "goalie: retired rc4/spooled tuple remains accepted" >&2; exit 1; }

# Mock-tmux smoke: the courier's real-TUI settle sleeps verify nothing against
# a synchronous mock — scale them down (smoke-speed PR2; default 1 in production).
export TAP_TUI_SETTLE_SCALE=0.1

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAPSH="$ROOT/bin/tap"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
export TAP_INDEX_HOME="$WORK/index"

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"; mkdir -p "$state"
cmd="${1:-}"; shift || true
pane_id() {
  case "$1" in
    %*)            echo "$1" ;;
    teamsess:0.0) echo %901 ;;
    goalie:0.0)   echo %902 ;;
    peer:0.0)     echo %903 ;;
    peer2:0.0)    echo %904 ;;
    *)            echo %999 ;;
  esac
}
session_for() {
  case "${1#=}" in
    teamsess:0.0|%901|teamsess) echo teamsess ;;
    goalie:0.0|%902|goalie)     echo goalie ;;
    peer:0.0|%903|peer)         echo peer ;;
    peer2:0.0|%904|peer2)       echo peer2 ;;
    *)                          echo teamsess ;;
  esac
}
caller_pane_id="$(pane_id "${FAKE_CURRENT_PANE:-teamsess:0.0}")"
# tap-bzyz: one TTY source per pane; both tmux queries derive from it.
tty_for() {
  [ "$1" = "$caller_pane_id" ] || return 1
  printf '/dev/faketty'
}
case "$cmd" in
  list-panes)
    # CONTRACT §Session-name authority: the caller TTY scan and exact-session
    # pane snapshot share numeric IDs, one server epoch, and live harnesses.
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -t) target="${2:-}"; shift 2 ;;
        *) fmt="$1"; shift ;;
      esac
    done
    if [[ "$fmt" == *pane_tty* ]]; then
      printf '%s\t%s\n' "$caller_pane_id" "$(tty_for "$caller_pane_id")"
    else
      session="$(session_for "$target")"
      case "$session" in
        teamsess) printf 'teamsess\tteamsess:0.0\t%%901\tcodex\t4242\t4242:100\t0\n' ;;
        goalie)   printf 'goalie\tgoalie:0.0\t%%902\thermes\t4242\t4242:100\t0\n' ;;
        peer)     printf 'peer\tpeer:0.0\t%%903\tcodex\t4242\t4242:100\t0\n' ;;
        peer2)    printf 'peer2\tpeer2:0.0\t%%904\tcodex\t4242\t4242:100\t0\n' ;;
      esac
    fi
    ;;
  list-sessions)
    printf 'teamsess\t4242:100\ngoalie\t4242:100\npeer\t4242:100\npeer2\t4242:100\n'
    ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -p) shift ;;
        -t) target="${2:-}"; shift 2 ;;
        *) fmt="$1"; shift ;;
      esac
    done
    if [ "$fmt" = '#{pid}:#{start_time}' ]; then echo "4242:100"; exit 0; fi
    if [ -z "$target" ] && [[ "$fmt" == *session_name* ]]; then
      session_for "${FAKE_CURRENT_PANE:-teamsess:0.0}"; exit 0
    fi
    case "$fmt" in
      *pane_id*session_name*pane_pid*pane_current_command*)
        # Known fixture panes only; anything else reads as gone.
        case "${target#=}" in
          teamsess:0.0|%901|teamsess) printf '%%901\tteamsess\t4242\tcodex\t0\n' ;;
          goalie:0.0|%902|goalie)     printf '%%902\tgoalie\t4242\thermes\t0\n' ;;
          peer:0.0|%903|peer)         printf '%%903\tpeer\t4242\tcodex\t0\n' ;;
          peer2:0.0|%904|peer2)       printf '%%904\tpeer2\t4242\tcodex\t0\n' ;;
          *) printf '\t\t\t\t\n' ;;
        esac ;;
      # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
      *pane_id*pane_tty*session_name*) resolved="$(pane_id "$target")"; printf '%s\t%s\t%s\t4242:100\n' "$resolved" "$(tty_for "$resolved")" "$(session_for "$target")" ;;
      *pane_id*session_name*)
        resolved="$(pane_id "$target")"
        printf '%s\t%s\t4242:100\n' "$resolved" "$(session_for "$target")" ;;
      *pane_id*pane_tty*)
        resolved="$(pane_id "$target")"
        printf '%s\t%s\n' "$resolved" "$(tty_for "$resolved")" ;;
      *pane_id*) pane_id "$target" ;;
      *pane_pid*)
        case "$target" in
          '=teamsess:goalie-sidecar') echo "${FAKE_SIDECAR_PID:-4242}" ;;
          *) echo 4242 ;;
        esac ;;
      *pane_in_mode*) echo 0 ;;
      *pane_current_command*) case "$(session_for "$target")" in goalie) echo hermes ;; *) echo codex ;; esac ;;
      *window_activity*) cat "$state/$target/activity" 2>/dev/null || echo 100 ;;
      *session_name*) session_for "$target" ;;
      *pid*start_time*) echo 4242:100 ;;
      *) echo "" ;;
    esac
    ;;
  capture-pane)
    target=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -t) target="${2:-}"; shift 2 ;; *) shift ;; esac
    done
    mkdir -p "$state/$target"
    if [ -f "$state/$target/input" ]; then
      printf 'older transcript\n\u276f %s\n' "$(cat "$state/$target/input")"
    elif [ -f "$state/$target/busy" ]; then
      printf 'still working\n'
    else
      printf 'older transcript\n\u276f \n'
    fi
    ;;
  send-keys)
    target=""
    [ "${1:-}" = -t ] && { target="${2:-}"; shift 2; }
    mkdir -p "$state/$target"
    case "${1:-}" in
      -l)
        shift; [ "${1:-}" = -- ] && shift
        printf '%s' "${1:-}" > "$state/$target/input"
        ;;
      C-u|Enter) rm -f "$state/$target/input" ;;
      *) : ;;
    esac
    ;;
  kill-pane)
    [ "${1:-}" = -t ] && printf '%s\n' "${2:-}" >> "${FAKE_KILL_LOG:?}"
    ;;
  new-window)
    printf '%%950 6262\n'
    ;;
  *) : ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
cat > "$FAKE_BIN/ps" <<'PS'
#!/usr/bin/env bash
case "$*" in
  *"-p 999999 "*) : ;;
  *"ppid="*"tty="*) printf '1 faketty\n' ;;
  *lstart=*) exec /bin/ps "$@" ;;
  *) printf ' 4242 1 bun runtime/bun/src/goalie-run.ts run\n' ;;
esac
PS
chmod +x "$FAKE_BIN/ps"
cat > "$FAKE_BIN/goalie-send" <<'SEND'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "${FAKE_GOALIE_SEND_OUTPUT:?}"
exit "${FAKE_GOALIE_SEND_RC:?}"
SEND
chmod +x "$FAKE_BIN/goalie-send"
export PATH="$FAKE_BIN:$PATH" FAKE_TMUX_STATE="$WORK/fake-tmux" TMUX="/fake/socket"
# Stub the ready probe for every tick: an unpinned probe runs `bd ready` against the
# checkout's live tracker, whose aged queue turns a seat-episode tick into rung3.
export TAP_GOALIE_READY_CMD="printf '[]'"
export FAKE_KILL_LOG="$FAKE_TMUX_STATE/kill-pane.log"
mkdir -p "$FAKE_TMUX_STATE"
: > "$FAKE_KILL_LOG"

BUS="$WORK/repo/.tap/bus"; mkdir -p "$BUS/payloads" "$BUS/receipts" "$WORK/repo"
export TAP_HOME="$BUS"
cat > "$BUS/registry.json" <<JSON
{"schema": "0.20",  "team": { "name": "tap", "worktree_root": "$WORK/repo" },
  "seats": {
    "lead": { "session": "teamsess", "pane": "teamsess:0.0", "pane_id": "%901", "server_epoch": "srv:4242:100", "harness": "codex", "status": "active", "registered_from_worktree": "$WORK/repo" },
    "goalie": { "session": "goalie", "pane": "goalie:0.0", "pane_id": "%902", "server_epoch": "srv:4242:100", "harness": "hermes", "status": "active", "registered_from_worktree": "$WORK/repo" },
    "peer": { "session": "peer", "pane": "peer:0.0", "pane_id": "%903", "server_epoch": "srv:4242:100", "harness": "codex", "status": "active", "registered_from_worktree": "$WORK/repo" },
    "cron-watch": { "delivery": "poll", "harness": "cron-watch", "status": "active" }
  } }
JSON
# Born-live enrollment: an absent machine marker now resolves no team authority.
mkdir -p "$TAP_INDEX_HOME"
cat > "$TAP_INDEX_HOME/global-registry.json" <<JSON
{"schema": "0.20", "teams": { "tap": { "root": "$(cd "$WORK/repo" && pwd -P)", "registry_location": "$BUS/registry.json", "state": "registered" } } }
JSON

field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],""))' "$BUS/goalie/arm.json" "$1"; }
seat_field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("seats",{}).get(sys.argv[2],{}).get(sys.argv[3],""))' "$BUS/goalie/arm.json" "$1" "$2"; }
count_to() { grep -l "^to: $1$" "$BUS"/payloads/*.md 2>/dev/null | wc -l | tr -d ' '; }

# Unknown or malformed rc0 courier output is not durable acceptance. The goalie
# must fail closed and must not reuse a prior successful disposition.
for goalie_case in malformed unknown; do
  rm -rf "$BUS/goalie" "$BUS/seat-state"
  bash "$TAPSH" goalie on --by lead --threshold 1 --interval 60 --no-spawn >/dev/null 2>&1
  G="$(field armed_at)"
  for p in teamsess:0.0 goalie:0.0 peer:0.0; do mkdir -p "$FAKE_TMUX_STATE/$p"; printf '%s' "$G" > "$FAKE_TMUX_STATE/$p/activity"; done
  if [ "$goalie_case" = malformed ]; then goalie_output='not-json'
  else goalie_output='{"status":"mystery","delivery":"spool","detail":"unknown disposition"}'; fi
  FAKE_GOALIE_SEND_OUTPUT="$goalie_output" FAKE_GOALIE_SEND_RC=0 TAP_COURIER_SCRIPT="$FAKE_BIN/goalie-send" \
    TAP_GOALIE_NOW="$((G + 1))" bash "$TAPSH" goalie tick >/dev/null 2>&1
  [ "$(seat_field peer request_status)" = failed ] \
    || { echo "goalie: rc0 $goalie_case courier output was accepted or reused stale status" >&2; cat "$BUS/goalie/arm.json" >&2; exit 1; }
done
rm -rf "$BUS/goalie" "$BUS/seat-state"
echo "goalie: malformed and unknown rc0 courier output fail closed: ok"

# (1) Arming writes a per-team lease and records the explicit pane-read consent.
arm_out="$(bash "$TAPSH" goalie on --by lead --threshold 60 --interval 60 --no-spawn 2>&1)"
[[ "$arm_out" == *consent* ]] || { echo "goalie: (1) arm did not print transcript-read consent: $arm_out" >&2; exit 1; }
[[ "$arm_out" == *"tap goalie: armed by 'lead'; checks after 60s; repeats every 60s"* ]] \
  || { echo "goalie: (1) arm receipt is not event prose: $arm_out" >&2; exit 1; }
[ -f "$BUS/goalie/arm.json" ] || { echo "goalie: (1) no arm record" >&2; exit 1; }
python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); assert r["armed_by"]=="lead" and r["threshold_seconds"]==60 and r["tick_interval_seconds"]==60 and r["consent_pane_peek"]==1, r' "$BUS/goalie/arm.json"
python3 -c 'import json,sys; r=json.load(sys.stdin); assert r["armed"] is True and r["watcher_alive"] is False, r' <<<"$(bash "$TAPSH" goalie status --json)"
_g="$(bash "$TAPSH" goalie status)"
[[ "$_g" == *"tracked: 0"* && "$_g" == *"open: 0"* ]] || { echo "goalie: (1) text status lacks per-seat summary" >&2; echo "$_g" >&2; exit 1; }
A="$(field armed_at)"
for p in teamsess:0.0 goalie:0.0 peer:0.0; do mkdir -p "$FAKE_TMUX_STATE/$p"; printf '%s' "$A" > "$FAKE_TMUX_STATE/$p/activity"; done
echo "goalie: (1) arm lease + consent: ok"

# (2) Activity is per-seat: a busy lead must not mask a settled-but-undone peer.
touch "$FAKE_TMUX_STATE/teamsess:0.0/busy"
printf '%s' "$((A + 100))" > "$FAKE_TMUX_STATE/teamsess:0.0/activity"
TAP_GOALIE_NOW="$((A + 59))" bash "$TAPSH" goalie tick >/dev/null
[ "$(count_to goalie)" = 0 ] || { echo "goalie: (2) asked before threshold elapsed" >&2; exit 1; }
TAP_GOALIE_NOW="$((A + 60))" bash "$TAPSH" goalie tick >/dev/null
[ "$(count_to goalie)" = 1 ] || { echo "goalie: (2) busy lead masked an idle peer" >&2; exit 1; }
# The Hermes judge's public send is accepted into its harness queue: recorded as
# queued (turn unconfirmed), never promoted to injected.
[ "$(seat_field peer request_status)" = queued ] \
  || { echo "goalie: (2) accepted courier disposition was not recorded honestly: $(seat_field peer request_status)" >&2; exit 1; }
judge="$(grep -l '^to: goalie$' "$BUS"/payloads/*.md | head -1)"
judge_id="$(basename "$judge" .md)"
[ -f "$BUS/receipts/$judge_id.harness-queued" ] && [ ! -e "$BUS/receipts/$judge_id.sent" ] \
  || { echo "goalie: (2) judge send is not the harness-queue disposition" >&2; ls "$BUS/receipts" >&2; exit 1; }
TOKEN="$(seat_field peer episode_token)"
[ -n "$TOKEN" ] || { echo "goalie: (2) episode has no collision-proof capability" >&2; exit 1; }
grep -q '^kind: probe$' "$judge" || { echo "goalie: (2) judge request is not supervision traffic" >&2; exit 1; }
grep -q '^reply: settle-only$' "$judge" || { echo "goalie: (2) judge request created a reply obligation" >&2; exit 1; }
grep -qF 'UNTRUSTED DATA' "$judge" || { echo "goalie: (2) judge prompt lacks its injection boundary" >&2; exit 1; }
grep -qF 'wake-seat' "$judge" || { echo "goalie: (2) judge prompt lacks allowlisted opcode" >&2; exit 1; }
grep -q -- "--token $TOKEN" "$judge" || { echo "goalie: (2) judge prompt does not carry the episode capability" >&2; exit 1; }
# shellcheck disable=SC2016
grep -qF 'candidate seat `peer`' "$judge" || { echo "goalie: (2) judge prompt is not scoped to the stale peer" >&2; exit 1; }
grep -q '{{[A-Z_]*}}' "$judge" && { echo "goalie: (2) judge prompt left template placeholders" >&2; exit 1; }
TAP_GOALIE_NOW="$((A + 500))" bash "$TAPSH" goalie tick >/dev/null
[ "$(count_to goalie)" = 1 ] || { echo "goalie: (2) repeated the model call inside one idle episode" >&2; exit 1; }
echo "goalie: (2) busy teammate cannot mask one stale seat: ok"

# (3) Unrelated bus traffic does not reset peer's episode. Peer traffic does, and a
# later quiet interval gets one fresh judgment call; supervision traffic never counts.
cat > "$BUS/payloads/unrelated-activity.md" <<'PAYLOAD'
---
id: unrelated-activity
from: lead
to: lead
kind: discuss
reply: settle-only
---
other work
PAYLOAD
python3 -c 'import os,sys; t=int(sys.argv[2]); os.utime(sys.argv[1],(t,t))' "$BUS/payloads/unrelated-activity.md" "$((A + 510))"
TAP_GOALIE_NOW="$((A + 519))" bash "$TAPSH" goalie tick >/dev/null
[ "$(seat_field peer episode_started_at)" = "$((A + 60))" ] || { echo "goalie: (3) unrelated traffic reset peer's episode" >&2; exit 1; }
cat > "$BUS/payloads/work-activity.md" <<'PAYLOAD'
---
id: work-activity
from: peer
to: lead
kind: discuss
reply: settle-only
---
real work
PAYLOAD
python3 -c 'import os,sys; t=int(sys.argv[2]); os.utime(sys.argv[1],(t,t))' "$BUS/payloads/work-activity.md" "$((A + 520))"
TAP_GOALIE_NOW="$((A + 530))" bash "$TAPSH" goalie tick >/dev/null
[ "$(seat_field peer episode_started_at)" = 0 ] || { echo "goalie: (3) peer activity did not reset its episode" >&2; exit 1; }
TAP_GOALIE_NOW="$((A + 579))" bash "$TAPSH" goalie tick >/dev/null
[ "$(count_to goalie)" = 1 ] || { echo "goalie: (3) re-fired before the new threshold" >&2; exit 1; }
TAP_GOALIE_NOW="$((A + 581))" bash "$TAPSH" goalie tick >/dev/null
[ "$(count_to goalie)" = 2 ] || { echo "goalie: (3) no fresh call in the next idle episode" >&2; exit 1; }
echo "goalie: (3) activity clocks and episodes are seat-scoped: ok"
rm -f "$FAKE_TMUX_STATE/teamsess:0.0/busy"

# (4) Only the goalie pane may submit a verdict. An obvious opcode sends one fixed,
# settle-only corrective tap, and the reason is a closed enum rather than model prose.
E="$(seat_field peer episode_started_at)"
TOKEN="$(seat_field peer episode_token)"
if FAKE_CURRENT_PANE=teamsess:0.0 TAP_GOALIE_NOW="$((A + 582))" bash "$TAPSH" goalie verdict --seat peer --episode "$E" --token "$TOKEN" --action wake-seat --target peer --reason phantom-wait >/dev/null 2>&1; then
  echo "goalie: (4) non-goalie pane submitted a verdict" >&2; exit 1
fi
if FAKE_CURRENT_PANE=goalie:0.0 TAP_GOALIE_NOW="$((A + 582))" bash "$TAPSH" goalie verdict --seat peer --episode "$E" --token "$TOKEN" --action wake-seat --target peer --reason 'phantom-wait; touch /tmp/pwned' >/dev/null 2>&1; then
  echo "goalie: (4) verdict accepted a non-enum/injectable reason" >&2; exit 1
fi
if FAKE_CURRENT_PANE=goalie:0.0 TAP_GOALIE_NOW="$((A + 582))" bash "$TAPSH" goalie verdict --seat peer --episode "$E" --token "$TOKEN" --action wake-seat --target lead --reason phantom-wait >/dev/null 2>&1; then
  echo "goalie: (4) verdict redirected a peer episode to another seat" >&2; exit 1
fi
verdict_out="$(FAKE_CURRENT_PANE=goalie:0.0 TAP_GOALIE_NOW="$((A + 582))" bash "$TAPSH" goalie verdict --seat peer --episode "$E" --token "$TOKEN" --action wake-seat --target peer --reason phantom-wait)"
[[ "$verdict_out" == "tap goalie: sent wake-seat verdict to 'peer'; reason: phantom-wait" ]] \
  || { echo "goalie: (4) verdict receipt is not event prose: $verdict_out" >&2; exit 1; }
correction="$(grep -l '^from: watcher$' "$BUS"/payloads/*.md | xargs grep -l '^to: peer$' | xargs grep -l '^kind: notice$' | head -1)"
[ -n "$correction" ] || { echo "goalie: (4) wake-seat produced no corrective tap" >&2; exit 1; }
grep -q '^to: peer$' "$correction" || { echo "goalie: (4) corrective tap targeted the wrong seat" >&2; exit 1; }
grep -q '^kind: notice$' "$correction" || { echo "goalie: (4) corrective tap is not a notice" >&2; exit 1; }
grep -q '^reply: settle-only$' "$correction" || { echo "goalie: (4) corrective tap created a reply obligation" >&2; exit 1; }
grep -qF 'bus shows no matching outstanding send' "$correction" || { echo "goalie: (4) fixed phantom-wait guidance missing" >&2; exit 1; }
if FAKE_CURRENT_PANE=goalie:0.0 TAP_GOALIE_NOW="$((A + 583))" bash "$TAPSH" goalie verdict --seat peer --episode "$E" --token "$TOKEN" --action wake-lead --reason unsure >/dev/null 2>&1; then
  echo "goalie: (4) second verdict acted in the same episode" >&2; exit 1
fi
[ "$(grep -l '^to: peer$' "$BUS"/payloads/*.md 2>/dev/null | xargs grep -l '^kind: notice$' | wc -l | tr -d ' ')" = 1 ] || { echo "goalie: (4) more than one corrective tap landed" >&2; exit 1; }
echo "goalie: (4) authenticated, enum-only verdict -> one allowlisted action: ok"

# (5) If the selected teammate became active after the sweep, wake-seat fails shut;
# the goalie may use the explicit unsure opcode to wake only the lead instead.
cat > "$BUS/payloads/work-activity-2.md" <<'PAYLOAD'
---
id: work-activity-2
from: lead
to: peer
kind: discuss
reply: settle-only
---
next episode
PAYLOAD
python3 -c 'import os,sys; t=int(sys.argv[2]); os.utime(sys.argv[1],(t,t))' "$BUS/payloads/work-activity-2.md" "$((A + 600))"
TAP_GOALIE_NOW="$((A + 601))" bash "$TAPSH" goalie tick >/dev/null
TAP_GOALIE_NOW="$((A + 661))" bash "$TAPSH" goalie tick >/dev/null
[ "$(count_to goalie)" = 3 ] || { echo "goalie: (5) precondition: third episode did not request judgment" >&2; exit 1; }
E="$(seat_field peer episode_started_at)"
TOKEN="$(seat_field peer episode_token)"
touch "$FAKE_TMUX_STATE/peer:0.0/busy"
printf '%s' "$((A + 662))" > "$FAKE_TMUX_STATE/peer:0.0/activity"
if FAKE_CURRENT_PANE=goalie:0.0 TAP_GOALIE_NOW="$((A + 662))" bash "$TAPSH" goalie verdict --seat peer --episode "$E" --token "$TOKEN" --action wake-seat --target peer --reason stale-wait >/dev/null 2>&1; then
  echo "goalie: (5) corrective tap interrupted a now-working teammate" >&2; exit 1
fi
FAKE_CURRENT_PANE=goalie:0.0 TAP_GOALIE_NOW="$((A + 662))" bash "$TAPSH" goalie verdict --seat peer --episode "$E" --token "$TOKEN" --action wake-lead --reason unsure >/dev/null
lead_notice="$(grep -l '^from: watcher$' "$BUS"/payloads/*.md | xargs grep -l '^to: lead$' | xargs grep -l '^kind: notice$' | tail -1)"
grep -qF 'could not safely resolve' "$lead_notice" || { echo "goalie: (5) unsure notice lacks fixed lead guidance" >&2; exit 1; }
echo "goalie: (5) working target fails shut; unsure wakes lead: ok"

# (6a/F1) A mechanical watch probe may bump tmux window_activity, but it must not
# destroy the same seat's open goalie episode or prevent that verdict from claiming.
rm -f "$FAKE_TMUX_STATE/peer:0.0/busy"
cat > "$BUS/payloads/work-activity-3.md" <<'PAYLOAD'
---
id: work-activity-3
from: peer
to: lead
kind: discuss
reply: settle-only
---
open interaction episode
PAYLOAD
python3 -c 'import os,sys; t=int(sys.argv[2]); os.utime(sys.argv[1],(t,t))' "$BUS/payloads/work-activity-3.md" "$((A + 700))"
TAP_GOALIE_NOW="$((A + 701))" bash "$TAPSH" goalie tick >/dev/null
TAP_GOALIE_NOW="$((A + 761))" bash "$TAPSH" goalie tick >/dev/null
E="$(seat_field peer episode_started_at)"
TOKEN="$(seat_field peer episode_token)"
[ "$E" = "$((A + 761))" ] || { echo "goalie: (6a) precondition: peer episode did not open" >&2; exit 1; }

rm -rf "$BUS/watch" "$BUS/seat-state"; rm -f "$BUS"/payloads/*.md "$BUS"/receipts/*.done
bash "$TAPSH" watch on --by lead -m 'done; proof; bound' --evaluator none --threshold 60 --probe-timeout 60 --chain '["peer"]' --terminal lead --no-spawn >/dev/null
WA="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["armed_at"])' "$BUS/watch/arm.json")"
TAP_WATCH_NOW="$((WA + 100))" bash "$TAPSH" watch tick >/dev/null 2>&1
grep -l '^to: peer$' "$BUS"/payloads/watcher-*.md | xargs grep -l '^kind: probe$' >/dev/null \
  || { echo "goalie: (6a) watch did not probe the candidate" >&2; exit 1; }
printf '%s' "$((A + 800))" > "$FAKE_TMUX_STATE/peer:0.0/activity"  # tmux bumps WA for the inject
TAP_GOALIE_NOW="$((A + 801))" bash "$TAPSH" goalie tick >/dev/null
[ "$(seat_field peer episode_started_at)" = "$E" ] || { echo "goalie: (6a) watch probe destroyed the candidate's goalie episode" >&2; exit 1; }
[ "$(seat_field peer episode_token)" = "$TOKEN" ] || { echo "goalie: (6a) watch probe replaced the candidate's capability" >&2; exit 1; }
clear_out="$(FAKE_CURRENT_PANE=goalie:0.0 TAP_GOALIE_NOW="$((A + 802))" bash "$TAPSH" goalie verdict --seat peer --episode "$E" --token "$TOKEN" --action clear --reason clean)"
[[ "$clear_out" == "tap goalie: cleared episode for 'peer'; no mismatch found" ]] \
  || { echo "goalie: (6a) clear receipt is not event prose: $clear_out" >&2; exit 1; }
[ "$(seat_field peer verdict_at)" = "$((A + 802))" ] || { echo "goalie: (6a) surviving episode could not claim its verdict" >&2; exit 1; }
echo "goalie: (6a) watch probe does not poison goalie episode activity: ok"

# (6b/P3) Two seats crossing on one tick share a timestamp but receive distinct
# capabilities; one probe's capability cannot claim the other seat's episode.
python3 -c '
import json,sys
p=sys.argv[1]; d=json.load(open(p)); d["seats"]["peer2"]={"session":"peer2","pane":"peer2:0.0","pane_id":"%904","server_epoch":"srv:4242:100","harness":"codex","status":"active","registered_from_worktree":sys.argv[2]}; json.dump(d,open(p,"w"))
' "$BUS/registry.json" "$WORK/repo"
mkdir -p "$FAKE_TMUX_STATE/peer2:0.0"; printf '%s' "$A" > "$FAKE_TMUX_STATE/peer2:0.0/activity"
cat > "$BUS/payloads/collision-peer.md" <<'PAYLOAD'
---
id: collision-peer
from: peer
to: lead
kind: discuss
reply: settle-only
---
same tick peer
PAYLOAD
cat > "$BUS/payloads/collision-peer2.md" <<'PAYLOAD'
---
id: collision-peer2
from: peer2
to: lead
kind: discuss
reply: settle-only
---
same tick peer2
PAYLOAD
for p in "$BUS/payloads/collision-peer.md" "$BUS/payloads/collision-peer2.md"; do
  python3 -c 'import os,sys; t=int(sys.argv[2]); os.utime(sys.argv[1],(t,t))' "$p" "$((A + 900))"
done
TAP_GOALIE_NOW="$((A + 901))" bash "$TAPSH" goalie tick >/dev/null
TAP_GOALIE_NOW="$((A + 961))" bash "$TAPSH" goalie tick >/dev/null
E1="$(seat_field peer episode_started_at)"; E2="$(seat_field peer2 episode_started_at)"
T1="$(seat_field peer episode_token)"; T2="$(seat_field peer2 episode_token)"
[ "$E1" = "$E2" ] && [ "$E1" = "$((A + 961))" ] && [ -n "$T1" ] && [ -n "$T2" ] && [ "$T1" != "$T2" ] \
  || { echo "goalie: (6b) same-tick episodes lack distinct capabilities" >&2; exit 1; }
if FAKE_CURRENT_PANE=goalie:0.0 TAP_GOALIE_NOW="$((A + 962))" bash "$TAPSH" goalie verdict --seat peer2 --episode "$E2" --token "$T1" --action clear --reason clean >/dev/null 2>&1; then
  echo "goalie: (6b) one seat's capability claimed another seat's episode" >&2; exit 1
fi
FAKE_CURRENT_PANE=goalie:0.0 TAP_GOALIE_NOW="$((A + 962))" bash "$TAPSH" goalie verdict --seat peer --episode "$E1" --token "$T1" --action clear --reason clean >/dev/null
FAKE_CURRENT_PANE=goalie:0.0 TAP_GOALIE_NOW="$((A + 962))" bash "$TAPSH" goalie verdict --seat peer2 --episode "$E2" --token "$T2" --action clear --reason clean >/dev/null
python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); del d["seats"]["peer2"]; json.dump(d,open(p,"w"))' "$BUS/registry.json"
echo "goalie: (6b) same-tick seat episodes have distinct claim capabilities: ok"

# (6c) Default watch escalation keeps ordinary mechanical rungs first, then the local
# goalie, then the lead terminal — independent of goalie recency.
rm -rf "$BUS/watch" "$BUS/seat-state"; rm -f "$BUS"/payloads/*.md "$BUS"/receipts/*.done
rm -f "$FAKE_TMUX_STATE/peer:0.0/busy" "$FAKE_TMUX_STATE/teamsess:0.0/busy"
printf '%s' "$A" > "$FAKE_TMUX_STATE/peer:0.0/activity"
printf '%s' "$((A + 10))" > "$FAKE_TMUX_STATE/goalie:0.0/activity"
printf '%s' "$((A + 20))" > "$FAKE_TMUX_STATE/teamsess:0.0/activity"
bash "$TAPSH" watch on --by lead -m 'done; proof; bound' --evaluator none --threshold 60 --probe-timeout 60 --no-spawn >/dev/null
WA="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["armed_at"])' "$BUS/watch/arm.json")"
for delta in 100 160 220; do TAP_WATCH_NOW="$((WA + delta))" bash "$TAPSH" watch tick >/dev/null 2>&1; done
python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); assert r["probed_seats"]==["peer","goalie","lead"], r["probed_seats"]' "$BUS/watch/arm.json" \
  || { echo "goalie: (6) watch escalation order is not peer -> goalie -> lead" >&2; exit 1; }
echo "goalie: (6c) mechanical watch -> team goalie -> lead rung order: ok"

# (7) The run loop publishes its heartbeat/pid and exits when off reaps the lease.
bash "$TAPSH" goalie run >"$WORK/goalie-run.log" 2>&1 & RUN_PID=$!
deadline=$((SECONDS + 300))
while [ "$SECONDS" -lt "$deadline" ]; do
  [ "$(field watcher_pid)" = "$RUN_PID" ] && break
  kill -0 "$RUN_PID" 2>/dev/null || { echo "goalie: (7) run loop exited before publishing ownership" >&2; exit 1; }
  sleep 0.02
done
[ "$(field watcher_pid)" = "$RUN_PID" ] && [ "$(field heartbeat_at)" != 0 ] \
  || { echo "goalie: (7) run loop did not publish heartbeat ownership" >&2; exit 1; }
echo "goalie: (7) run loop publishes heartbeat ownership: ok"

# (8) Off is armer-owned, idempotent, and reaps the lease/process.
# The pane decides who the caller is (tap-calo); --by only agrees with it. The fake tmux answers as the
# lead pane by default, so a non-armer must actually stand in the peer pane.
if FAKE_CURRENT_PANE=peer:0.0 bash "$TAPSH" goalie off --by peer >/dev/null 2>&1; then
  echo "goalie: (8) non-armer disarmed the sidecar" >&2; exit 1
fi
bash "$TAPSH" goalie off --by lead >/dev/null
[ ! -f "$BUS/goalie/arm.json" ] || { echo "goalie: (8) off left the lease armed" >&2; exit 1; }
wait "$RUN_PID" 2>/dev/null || true
off_again="$(bash "$TAPSH" goalie off --by lead 2>&1)"
[[ "$off_again" == *'already disarmed'* ]] || { echo "goalie: (8) double off is not idempotent: $off_again" >&2; exit 1; }
echo "goalie: (8) armer-owned off reaps lease/process, idempotent: ok"

# (8a) Sidecar lifecycle is keyed by the named window. The stored pane id is
# deliberately stale; it may now belong to an unrelated pane in the same server.
bash "$TAPSH" goalie on --by lead --threshold 60 --interval 60 --no-spawn >/dev/null 2>&1
python3 - "$BUS/goalie/arm.json" <<'PY'
import json, sys
path = sys.argv[1]
doc = json.load(open(path))
doc["watcher_pid"] = 4242
doc["watcher_pane"] = "%stale"
json.dump(doc, open(path, "w"))
PY
: > "$FAKE_KILL_LOG"
bash "$TAPSH" goalie off --by lead >/dev/null
grep -qx '=teamsess:goalie-sidecar' "$FAKE_KILL_LOG" \
  || { echo "goalie: (8a) off did not kill the name-derived sidecar target" >&2; cat "$FAKE_KILL_LOG" >&2; exit 1; }
! grep -qx '%stale' "$FAKE_KILL_LOG" \
  || { echo "goalie: (8a) off dereferenced the stale stored pane id" >&2; exit 1; }

# PID equality remains the ownership belt: the right named window with another
# process must not be killed.
bash "$TAPSH" goalie on --by lead --threshold 60 --interval 60 --no-spawn >/dev/null 2>&1
python3 - "$BUS/goalie/arm.json" <<'PY'
import json, sys
path = sys.argv[1]
doc = json.load(open(path))
doc["watcher_pid"] = 999999
doc["watcher_pane"] = "%stale"
json.dump(doc, open(path, "w"))
PY
: > "$FAKE_KILL_LOG"
FAKE_SIDECAR_PID=4242 bash "$TAPSH" goalie off --by lead >/dev/null
[ ! -s "$FAKE_KILL_LOG" ] || { echo "goalie: (8a) pid mismatch killed the named sidecar" >&2; exit 1; }

# The stale-sidecar replacement path uses the same helper before spawning the
# new window; it must not retain the duplicate stored-id kill.
bash "$TAPSH" goalie on --by lead --threshold 60 --interval 60 --no-spawn >/dev/null 2>&1
python3 - "$BUS/goalie/arm.json" <<'PY'
import json, sys
path = sys.argv[1]
doc = json.load(open(path))
doc["watcher_pid"] = 999999
doc["watcher_pane"] = "%stale"
doc["heartbeat_at"] = 0
json.dump(doc, open(path, "w"))
PY
: > "$FAKE_KILL_LOG"
FAKE_SIDECAR_PID=999999 bash "$TAPSH" goalie on --by lead --threshold 60 --interval 60 >/dev/null 2>&1
grep -qx '=teamsess:goalie-sidecar' "$FAKE_KILL_LOG" \
  || { echo "goalie: (8a) stale replacement did not kill the name-derived sidecar target" >&2; cat "$FAKE_KILL_LOG" >&2; exit 1; }
! grep -qx '%stale' "$FAKE_KILL_LOG" \
  || { echo "goalie: (8a) stale replacement dereferenced the stored pane id" >&2; exit 1; }
bash "$TAPSH" goalie off --by lead >/dev/null
echo "goalie: (8a) sidecar kill is name-keyed with the pid ownership belt: ok"

# (8b) A forced non-armer disarm is the loud escape: it notifies the armer once.
rm -f "$BUS"/payloads/*.md "$BUS"/receipts/*.done
bash "$TAPSH" goalie on --by lead --threshold 60 --interval 60 --no-spawn >/dev/null 2>&1
FAKE_CURRENT_PANE=peer:0.0 bash "$TAPSH" goalie off --by peer --force >/dev/null
forced_notice="$(grep -l '^from: watcher$' "$BUS"/payloads/*.md 2>/dev/null | xargs grep -l '^to: lead$' 2>/dev/null | xargs grep -l '^kind: notice$' 2>/dev/null | head -1 || true)"
[ -n "$forced_notice" ] || { echo "goalie: (8b) forced non-armer disarm sent no armer notice" >&2; exit 1; }
grep -qF "force-disarmed by 'peer'" "$forced_notice" || { echo "goalie: (8b) forced notice lacks actor evidence" >&2; exit 1; }
[ ! -f "$BUS/goalie/arm.json" ] || { echo "goalie: (8b) forced off left the lease armed" >&2; exit 1; }
echo "goalie: (8b) forced non-armer off notifies the armer: ok"

# (9) Reset archives goalie state under the lease lock, just like watch state.
# tap-9tqt: --keep-registry removed; --force is confirmation-only. Re-seed roster after.
bash "$TAPSH" goalie on --by lead --threshold 60 --interval 60 --no-spawn >/dev/null 2>&1
# Poll-ify seats so reset-stop is not hard-gated by unverified pane rows (this
# case proves goalie archive/reap, not session kill — delivery-polite precedent).
python3 -B - "$BUS/registry.json" <<'PY'
import json, sys
reg = json.load(open(sys.argv[1]))
for ent in (reg.get("seats") or {}).values():
    if isinstance(ent, dict):
        ent["delivery"] = "poll"
        for k in ("pane", "pane_id", "session", "server_epoch"):
            ent.pop(k, None)
json.dump(reg, open(sys.argv[1], "w"), indent=2)
open(sys.argv[1], "a").write("\n")
PY
# Use the production writer: reset must classify the directory real deliveries
# create, and discard its batching clock with the old recipient generation.
clock_path="$(bash -c '. "$1"; "${TAP_SMOKE_BUN:-bun}" "$_TAP_SCRIPT_DIR/../../../runtime/bun/src/delivery-clock.ts" stamp "$2" lead 123; tap_bun_call delivery-clock lead delivery-clock.ts path "$2" lead' _ "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh" "$BUS/registry.json")"
[ -s "$clock_path" ] || { echo "goalie: (9) production delivery clock missing" >&2; exit 1; }
clock_component="$(basename "$(dirname "$clock_path")")"
bash "$TAPSH" team reset --yes >/dev/null
[ ! -e "$clock_path" ] && [ ! -e "$clock_path.lock" ] \
  || { echo "goalie: (9) reset retained a prior delivery clock" >&2; exit 1; }
for bundle in "$BUS"/archive/team-reset/*; do
  [ ! -e "$bundle/bus/$clock_component" ] \
    || { echo "goalie: (9) reset checkpointed the delivery clock" >&2; exit 1; }
done
[ ! -f "$BUS/goalie/arm.json" ] || { echo "goalie: (9) reset left the goalie lease armed" >&2; exit 1; }
ls "$BUS"/archive/team-reset/*/bus/goalie/arm.json >/dev/null 2>&1 \
  || ls "$BUS"/archive/*/goalie/arm.json >/dev/null 2>&1 \
  || { echo "goalie: (9) reset did not archive goalie state" >&2; exit 1; }
echo "goalie: (9) reset archives and reaps goalie state: ok"

echo "goalie-sidecar: ok"
