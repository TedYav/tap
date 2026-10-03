#!/usr/bin/env bash
# D5: path-reference — :159 is the fake-ps fixture's watcher-signature data, the literal verbs/goalie.ts RUN_SIGNATURE greps for; it asserts no runtime/bun/src behavior — the direct module execs moved to runtime/bun/test/goalie-working-zero.test.ts
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# goalie-working-zero.test.sh — the WORK-FEEDER detector (tap-ulyr).
#
# The fake-ps fixture below carries the watcher-signature line
# (`bun runtime/bun/src/goalie-run.ts run`) as fixture data; this file's
# direct runtime/bun/src executions moved to
# runtime/bun/test/goalie-working-zero.test.ts.
#
# THE TWO ACCEPTANCE FIXTURES, per the build spec:
#   FIRES     — a 12:00Z board shaped like a busy morning where nothing was
#               working: sixteen seats, every one idle-at-prompt. WORKING==0.
#               ALL-IDLE BY CONSTRUCTION: this fixture cannot speak to the
#               busy-board case (a couple of busy seats beside many idle ones).
#               Greening here is not coverage of that shape, and the limitation
#               is named beside the census in the goalie layer (native since R6 U3).
#   DOES NOT  — the same board with one seat working. WORKING==1.
#
# Plus the two properties the lane was told to defend:
#   ACK, NOT FIRE     — an emitted wake that is never answered ESCALATES; a wake
#                       that cannot be delivered escalates IMMEDIATELY. A tick
#                       that believes it warned someone is the whole bug.
#   OUTPUT EVERY FIRE — including a correctly-quiet one. A silent all-clear is
#                       indistinguishable from a dead detector.
#
# And the renderer condition: undeclared / declared-empty / no-ledger /
# unreadable-ledger / declared are FIVE facts and must render as five distinct
# strings, none of them "none".
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
# shellcheck source=helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
export TAP_TUI_SETTLE_SCALE=0.1

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAPSH="$ROOT/bin/tap"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"

# tap-4n5h: the board pass now reads LAST-ACTIVITY AGE from each seat's observed
# session store, so the fixture must supply one. `age_seat <handle> <seconds>`
# writes a store file and back-dates it; a registry with no store path leaves
# every seat UNAGED and the board cannot fire at all.
STORE="$WORK/stores"; mkdir -p "$STORE"
# tap-wbz8: the age source is now the newest record the SEAT AUTHORED, not the
# file's mtime — a courier arrival writes the store and used to read as activity.
# So a back-dated fixture carries a back-dated RECORD; the mtime is set to match
# so the two never disagree about what age this seat is supposed to have.
age_seats() { # <age-seconds> <handle>...
  local age="$1"; shift
  python3 - "$STORE" "$age" "$@" <<'PY'
import json, os, sys, time
store, age, *handles = sys.argv[1:]
at = int(time.time()) - int(age)
record = {"type": "assistant", "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(at)), "message": {"content": "work"}}
for handle in handles:
    path = os.path.join(store, handle + ".jsonl")
    with open(path, "w") as stream:
        json.dump(record, stream, separators=(",", ":"))
        stream.write("\n")
    os.utime(path, (at, at))
PY
}
age_seat() { age_seats "$2" "$1"; }
store_path() { printf '%s/%s.jsonl' "$STORE" "$1"; }
# Default posture: every seat stale, i.e. the all-idle acceptance board.
age_all() { # <age-seconds>
  local -a handles=()
  while IFS=$'\t' read -r h _ _; do handles+=("$h"); done < "$FAKE_TMUX_STATE/seats.tsv"
  age_seats "$1" "${handles[@]}"
}

trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
export TAP_INDEX_HOME="$WORK/index"

# A 15-seat board shaped like a busy morning, plus the observer. The observer is
# excluded from its own census by construction.
SEATS="fable opus-seat-1 opus-seat-2 opus-seat-3 sol-seat-1 sol-seat-2
gemini-seat-1 opus-seat-4 grok-seat-1 opus-seat-5 glm53-seat-1 sonnet-seat-1
sonnet-seat-2 kimi fable-seat-1 hermes-goalie"

export FAKE_TMUX_STATE="$WORK/fake-tmux"; mkdir -p "$FAKE_TMUX_STATE"
: > "$FAKE_TMUX_STATE/seats.tsv"
n=900
for h in $SEATS; do
  n=$((n + 1))
  printf '%s\t%s\t%%%s\n' "$h" "$h:0.0" "$n" >> "$FAKE_TMUX_STATE/seats.tsv"
done

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"; table="$state/seats.tsv"
cmd="${1:-}"; shift || true
# One seat table drives sessions, panes, and ids, so the caller TTY scan and the
# pane snapshot cannot disagree about who exists.
pane_id() { local t="${1#=}"; t="${t%%.*}"; t="${t%%:*}"
  awk -F'\t' -v s="$t" '$1==s{print $3; f=1} END{if(!f) print "%999"}' "$table"; }
session_for() { local t="${1#=}"
  case "$t" in %*) awk -F'\t' -v p="$t" '$3==p{print $1; f=1} END{if(!f) print "fable"}' "$table" ;;
               *) printf '%s' "${t%%:*}" ;; esac; }
harness_for() { case "$(session_for "$1")" in hermes-goalie) printf hermes ;; *) printf codex ;; esac; }
caller_pane_id="$(pane_id "${FAKE_CURRENT_PANE:-fable:0.0}")"
tty_for() { [ "$1" = "$caller_pane_id" ] || return 1; printf '/dev/faketty'; }
case "$cmd" in
  list-panes)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do case "$1" in -t) target="${2:-}"; shift 2 ;; *) fmt="$1"; shift ;; esac; done
    if [[ "$fmt" == *pane_tty* ]]; then
      printf '%s\t%s\n' "$caller_pane_id" "$(tty_for "$caller_pane_id")"
    else
      s="$(session_for "$target")"
      awk -F'\t' -v s="$s" '$1==s{printf "%s\t%s\t%s\t%s\t4242\t4242:100\t0\n", $1, $2, $3, (s=="hermes-goalie"?"hermes":"codex")}' "$table"
    fi ;;
  list-sessions) awk -F'\t' '{print $1 "\t4242:100"}' "$table" ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do case "$1" in -p) shift ;; -t) target="${2:-}"; shift 2 ;; *) fmt="$1"; shift ;; esac; done
    if [ -z "$target" ] && [[ "$fmt" == *session_name* ]]; then session_for "${FAKE_CURRENT_PANE:-fable:0.0}"; exit 0; fi
    case "$fmt" in
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%s\t%s\t4242\t%s\t0\n' "$(pane_id "$target")" "$(session_for "$target")" "$(harness_for "$target")" ;;
      # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
      *pane_id*pane_tty*session_name*) r="$(pane_id "$target")"; printf '%s\t%s\t%s\t4242:100\n' "$r" "$(tty_for "$r")" "$(session_for "$target")" ;;
      *pane_id*session_name*) printf '%s\t%s\t4242:100\n' "$(pane_id "$target")" "$(session_for "$target")" ;;
      *pane_id*pane_tty*) r="$(pane_id "$target")"; printf '%s\t%s\n' "$r" "$(tty_for "$r")" ;;
      *pane_id*) pane_id "$target" ;;
      *pane_pid*) echo 4242 ;;
      *pane_in_mode*) echo 0 ;;
      *pane_current_command*) harness_for "$target" ;;
      *window_activity*) cat "$state/$(session_for "$target"):0.0/activity" 2>/dev/null || echo 100 ;;
      *session_name*) session_for "$target" ;;
      *pid*start_time*) echo 4242:100 ;;
      *) echo "" ;;
    esac ;;
  capture-pane)
    target=""
    while [ "$#" -gt 0 ]; do case "$1" in -t) target="${2:-}"; shift 2 ;; *) shift ;; esac; done
    d="$state/$(session_for "$target"):0.0"; mkdir -p "$d"
    # A `busy` marker means the seat is generating: no input band, so the
    # classifier reports `working`. Absent it, the seat sits at a ready prompt.
    if [ -f "$d/busy" ]; then printf 'still working\n'; else printf 'older transcript\n❯ \n'; fi ;;
  send-keys) : ;;
  kill-pane) : ;;
  new-window) printf '%%950 6262\n' ;;
  *) : ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
cat > "$FAKE_BIN/ps" <<'PS'
#!/usr/bin/env bash
case "$*" in
  *"ppid="*"tty="*) printf '1 faketty\n' ;;
  *) printf ' 4242 1 bun runtime/bun/src/goalie-run.ts run\n' ;;
esac
PS
chmod +x "$FAKE_BIN/ps"
# The human rung. A watchdog that will not wake the human is decorative, so the
# fixture must be able to prove the notifier was actually invoked.
cat > "$FAKE_BIN/notify-user" <<'NU'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${FAKE_NOTIFY_LOG:?}"
NU
chmod +x "$FAKE_BIN/notify-user"
export PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket"
export FAKE_NOTIFY_LOG="$WORK/notify.log"; : > "$FAKE_NOTIFY_LOG"
# sandbox-pins.sh deliberately pins the notifier to a nonexistent path so no test
# can reach a human by accident. The human rung is load-bearing here, so this
# fixture stubs it EXPLICITLY and asserts it was invoked.
export TAP_NOTIFY_USER_BIN="$FAKE_BIN/notify-user"

BUS="$WORK/repo/.tap/bus"; mkdir -p "$BUS/payloads" "$BUS/receipts" "$WORK/repo"
export TAP_HOME="$BUS"
{
  printf '{ "schema": "0.20", "team": { "name": "tap", "worktree_root": "%s" }, "seats": {\n' "$WORK/repo"
  first=1
  while IFS=$'\t' read -r h pane pid; do
    [ "$first" = 1 ] || printf ',\n'; first=0
    printf '  "%s": { "session": "%s", "pane": "%s", "pane_id": "%s", "server_epoch": "srv:4242:100", "harness": "%s", "status": "active", "session_store_path": "'"$STORE"'/%s.jsonl", "registered_from_worktree": "%s" }' \
      "$h" "$h" "$pane" "$pid" "$([ "$h" = hermes-goalie ] && echo hermes || echo codex)" "$h" "$WORK/repo"
  done < "$FAKE_TMUX_STATE/seats.tsv"
  printf '\n} }\n'
} > "$BUS/registry.json"
# Born live: an absent marker opens no legacy door, so the fixture team is enrolled.
tap_smoke_enroll_current "$WORK/repo" "$BUS" tap

field()  { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],""))' "$BUS/goalie/arm.json" "$1"; }
to_count() { grep -l "^to: $1$" "$BUS"/payloads/*.md 2>/dev/null | wc -l | tr -d ' '; }
ticks()  { cat "$BUS/goalie/tick.log" 2>/dev/null || true; }
last_verdict() { ticks | tail -1 | sed -n 's/.* verdict=\([a-z0-9-]*\).*/\1/p'; }
# Marking a seat that is not ON the board is a silent no-op, and a silent no-op
# here makes an arm assert against a board it never created — arm (9) went red
# against `deadlock` while claiming to test `quiet` for exactly this reason, after
# the board shrank out from under a seat name. Refuse the name instead.
_on_board() { cut -f1 "$FAKE_TMUX_STATE/seats.tsv" | grep -qx "$1"; }
busy()   { _on_board "$1" || { echo "wz: fixture error — busy '$1' is not on the current board" >&2; exit 1; }
           mkdir -p "$FAKE_TMUX_STATE/$1:0.0"; touch "$FAKE_TMUX_STATE/$1:0.0/busy"; }
unbusy() { _on_board "$1" || { echo "wz: fixture error — unbusy '$1' is not on the current board" >&2; exit 1; }
           rm -f "$FAKE_TMUX_STATE/$1:0.0/busy"; }
arm() { # [extra args…]
  # Each arm is its own board. Payloads left by a prior arm would let a stale
  # wake satisfy a later assertion — the fixture must never pass on evidence it
  # did not produce.
  rm -rf "$BUS/goalie" "$BUS/seat-state"; rm -f "$BUS"/payloads/*.md
  age_all 3000   # every seat stale: the all-idle acceptance posture
  bash "$TAPSH" goalie on --by fable --goalie hermes-goalie --threshold 999999 --interval 60 --no-spawn "$@" >/dev/null 2>&1
  A="$(field armed_at)"
  while IFS=$'\t' read -r h _ _; do mkdir -p "$FAKE_TMUX_STATE/$h:0.0"; printf '%s' "$A" > "$FAKE_TMUX_STATE/$h:0.0/activity"; done < "$FAKE_TMUX_STATE/seats.tsv"
}
tick() {
  local now="$1"
  # These arms assert the board pass through the PUBLIC door (R6 U3: the tick is
  # native; the per-seat pass has its own focused fixtures, and arm (0b) runs the
  # full tick for exactly that pass).
  TAP_GOALIE_NOW="$now" bash "$TAPSH" goalie tick 2>/dev/null || true
}

# ARM (1) exercises the REAL courier, because the property it proves — that the
# wake is stamped reply=expected on the artifact — is a claim about tap-send and
# cannot be stubbed without stubbing the finding. Every later arm is about the
# LADDER, the exception form, and the renderer; those do not depend on which
# courier minted the payload, so they use a fast stand-in that mints the same
# artifact. This keeps the suite inside its budget without any arm proving its
# property against a mock of that property.
cat > "$FAKE_BIN/fast-send" <<'FS'
#!/usr/bin/env bash
set -euo pipefail
to="$1"; shift
body=""
while [ "$#" -gt 0 ]; do case "$1" in -m) body="$2"; shift 2 ;; *) shift ;; esac; done
id="hermes-goalie-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM$RANDOM"
{ printf -- '---
id: %s
from: hermes-goalie
to: %s
kind: discuss
reply: expected
---
' "$id" "$to"
  printf '%s
' "$body"; } > "$TAP_HOME/payloads/$id.md"
printf '{"status":"injected","delivery":"pane","id":"%s","to":"%s"}
' "$id" "$to"
FS
chmod +x "$FAKE_BIN/fast-send"
export TAP_COURIER_SCRIPT="$FAKE_BIN/fast-send"

iso() { python3 -c 'import sys,time; print(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(int(sys.argv[1]))))' "$1"; }
LEDGER="$WORK/board.md"
printf 'OBJECTIVE: drain the ready queue or state the exception\n' > "$LEDGER"
READY_STUB='printf %s "[{\"id\":\"tap-20ao\",\"priority\":1,\"title\":\"Courier digest_interval\"},{\"id\":\"tap-dg8g\",\"priority\":1,\"title\":\"worktree check\"}]"'
export TAP_GOALIE_READY_CMD="$READY_STUB"

# ---------------------------------------------------------------------------
# (0) THE OBSERVER IS A ROLE, NOT A NAME. This board deliberately contains NO
#     seat called `goalie` — a team's observer can be `hermes-goalie`, and
#     the old code pinned the literal string, so arming failed `no_goalie_seat`
#     and the layer never ran on the only board it was built for. The previous
#     fixture minted a handle named `goalie`, which is why that stayed invisible:
#     a test that supplies the name under dispute cannot fail on it.
# ---------------------------------------------------------------------------
rm -rf "$BUS/goalie" "$BUS/seat-state"
arm_out="$(bash "$TAPSH" goalie on --by fable --threshold 999999 --interval 60 --no-spawn 2>&1)" || true
resolved="$(bash "$TAPSH" goalie status 2>/dev/null | sed -n 's/^  goalie seat: //p')"
if [ -n "$resolved" ]; then
  [ "$resolved" = hermes-goalie ] \
    || { echo "wz: (0) role resolution picked '$resolved', not the goalie-role seat" >&2; exit 1; }
  echo "wz: (0) with no seat named 'goalie', the observer resolves BY ROLE to hermes-goalie: ok"
else
  # No preset catalog in this sandbox — then it must refuse LOUDLY and name the
  # remedy, never arm against a seat that does not exist.
  case "$arm_out" in
    *no_goalie_seat*|*"--goalie"*) ;;
    *) echo "wz: (0) unresolvable observer neither resolved nor refused with a remedy: $arm_out" >&2; exit 1 ;;
  esac
  echo "wz: (0) with no seat named 'goalie' and no catalog, arming REFUSES and names --goalie: ok"
fi
rm -rf "$BUS/goalie" "$BUS/seat-state"

# ---------------------------------------------------------------------------
# (0b) THE OBSERVER MUST NOT OBSERVE ITSELF. A watcher sits at prompt by
#      definition, so if the per-seat census does not exclude the RESOLVED
#      observer it opens an idle episode against itself and issues a judge
#      request about itself. The old code excluded the literal `goalie`, which
#      was correct only while the seat happened to carry that name — so
#      resolving by role without threading it here regresses on exactly the
#      board this PR exists to arm.
# ---------------------------------------------------------------------------
arm --feeder opus-seat-1 --ledger "$LEDGER"
TAP_GOALIE_NOW="$((A + 60))" bash "$TAPSH" goalie tick >/dev/null 2>&1 || true
[ "$(last_verdict)" = deadlock ] \
  || { echo "wz: (0b) the public tick did not run the board pass: $(ticks | tail -1)" >&2; exit 1; }
[ "$(cat "$BUS/goalie/heartbeat" 2>/dev/null)" = "$((A + 60))" ] \
  || { echo "wz: (0b) public tick did not forward TAP_GOALIE_NOW: heartbeat=$(cat "$BUS/goalie/heartbeat" 2>/dev/null) want=$((A + 60))" >&2; exit 1; }
python3 - "$BUS/goalie/arm.json" <<'PYSELF' || { echo "wz: (0b) the observer opened an episode against itself" >&2; exit 1; }
import json, sys
try: rec = json.load(open(sys.argv[1]))
except Exception: raise SystemExit(0)
seats = rec.get("seats") or {}
if "hermes-goalie" in seats:
    raise SystemExit("observer present in its own per-seat census: %r" % (seats["hermes-goalie"],))
PYSELF
[ "$(to_count hermes-goalie)" = 0 ] \
  || { echo "wz: (0b) a judge request was addressed to the observer about itself" >&2; exit 1; }
echo "wz: (0b) the public tick runs the board pass and excludes the observer from its own per-seat census: ok"

# ---------------------------------------------------------------------------
# (1) FIRES — the 12:00Z board. Every seat idle-at-prompt; WORKING==0.
# ---------------------------------------------------------------------------
arm --feeder opus-seat-1 --ledger "$LEDGER"
out="$(TAP_COURIER_SCRIPT= tick "$((A + 60))")"
[ "$(last_verdict)" = deadlock ] \
  || { echo "wz: (1) 12:00Z board did not FIRE: $(ticks | tail -2)" >&2; exit 1; }
[ "$(to_count opus-seat-1)" = 1 ] \
  || { echo "wz: (1) no wake reached the feeder" >&2; exit 1; }
wake="$(grep -l '^to: opus-seat-1$' "$BUS"/payloads/*.md | head -1)"
grep -qx 'from: hermes-goalie' "$wake" \
  || { echo "wz: (1) wake was not sent from the goalie seat: $(grep -m1 '^from:' "$wake")" >&2; exit 1; }
# THE ACK PROPERTY, asserted on the artifact rather than on the flag: an
# unregistered sender may send ONLY --fyi (reply=settle-only), so a wake stamped
# settle-only is a wake nobody owes an answer to — the design's own thesis
# relocated onto the transport.
grep -qx 'reply: expected' "$wake" \
  || { echo "wz: (1) wake carries no reply obligation: $(grep -m1 '^reply:' "$wake")" >&2; exit 1; }
for want in 'DEADLOCK · STALE 15/15 (100%) idle >=40m · READY 2' 'NEXT tap-20ao P1 Courier digest_interval' \
            'OWNER opus-seat-1' 'OBJECTIVE drain the ready queue'; do
  grep -qF "$want" "$wake" || { echo "wz: (1) wake body missing: $want" >&2; cat "$wake" >&2; exit 1; }
done
[[ "$out" == *"verdict=deadlock"* ]] || { echo "wz: (1) tick printed no verdict" >&2; exit 1; }
echo "wz: (1) the 12:00Z board FIRES — wake from goalie, reply=expected, NEXT bound: ok"

# ---------------------------------------------------------------------------
# (1b) THE STAMP READ-BACK, proven load-bearing on the ordinary pane path — not
#      only on queued (arm 10). A courier can report success while minting a
#      SETTLE-ONLY artifact: that is exactly what `--fyi`, or an `unattended`
#      flag on the goalie's registry row, does to a send this code believes it
#      declared `--expect-reply` on. The flags say obligation; the artifact says
#      none. Only the artifact is true, so a settle-only stamp must be treated as
#      "no obligation was minted" and escalate — never carried as a wake the
#      goalie believes it is owed an answer to.
# ---------------------------------------------------------------------------
cat > "$FAKE_BIN/fyi-send" <<'FYI'
#!/usr/bin/env bash
set -euo pipefail
to="$1"; shift
while [ "$#" -gt 0 ]; do case "$1" in -m) shift 2 ;; *) shift ;; esac; done
id="hermes-goalie-fyi-$RANDOM$RANDOM"
{ printf -- '---\nid: %s\nfrom: hermes-goalie\nto: %s\nkind: discuss\nreply: settle-only\n---\n' "$id" "$to"
  printf 'body\n'; } > "$TAP_HOME/payloads/$id.md"
printf '{"status":"injected","delivery":"pane","id":"%s","to":"%s","path":"%s"}\n' \
  "$id" "$to" "$TAP_HOME/payloads/$id.md"
FYI
chmod +x "$FAKE_BIN/fyi-send"
arm --feeder opus-seat-1 --ledger "$LEDGER"
: > "$FAKE_NOTIFY_LOG"
TAP_COURIER_SCRIPT="$FAKE_BIN/fyi-send" tick "$((A + 60))" >/dev/null
[ "$(last_verdict)" = rung3 ] \
  || { echo "wz: (1b) a settle-only artifact was carried as an obligation: $(ticks | tail -1)" >&2; exit 1; }
[ -z "$(field wake_id)" ] \
  || { echo "wz: (1b) a settle-only wake was stored as an obligation to escalate against" >&2; exit 1; }
[ -s "$FAKE_NOTIFY_LOG" ] \
  || { echo "wz: (1b) an unmintable obligation went silent instead of reaching the human" >&2; exit 1; }
echo "wz: (1b) a courier that reports success but mints settle-only escalates, never carries: ok"

# ---------------------------------------------------------------------------
# (2) DOES NOT FIRE — a WORKING QUORUM suppresses. Asserted at the BOUNDARY.
#
#     RATIFIED FORM WAS: "a board with >=1 working seat must NOT fire." Under the
#     instantaneous predicate one working seat WAS the whole of "working", because
#     the predicate was WORKING == 0. Under quorum staleness that literal reading
#     is wrong ON PURPOSE: one active seat in fifteen is a 93%-stale board, and
#     firing there is the ratified behaviour — a board quiet EXCEPT for a couple
#     of busy seats is the case the instantaneous predicate could not express.
#     Preserving the literal sentence would re-import that limitation. (No claim
#     here about any historical board; that claim has a required form and lives
#     in one place.)
#
#     TRANSLATED FORM: a board with a working QUORUM must not fire. Tested at the
#     boundary rather than with one seat, so it pins the PROPERTY the criterion
#     protected (do not cry deadlock while the board is working) rather than the
#     number it happened to use. 15 ageable seats, 80% threshold:
#       11 stale / 15 = 73%  -> must NOT fire
#       12 stale / 15 = 80%  -> must fire
# ---------------------------------------------------------------------------
arm --feeder opus-seat-1 --ledger "$LEDGER"
for h in opus-seat-3 opus-seat-5 sonnet-seat-1 sonnet-seat-2; do age_seat "$h" 30; done
before="$(ticks | wc -l | tr -d ' ')"
out="$(tick "$((A + 60))")"
[ "$(last_verdict)" = quiet ] \
  || { echo "wz: (2) a board with a working quorum (11/15 stale, 73%) was called deadlocked: $(ticks | tail -1)" >&2; exit 1; }
[ "$(to_count opus-seat-1)" = 0 ] \
  || { echo "wz: (2) a healthy fire pushed to a seat" >&2; exit 1; }
[ "$(ticks | wc -l | tr -d ' ')" -gt "$before" ] \
  || { echo "wz: (2) the quiet fire produced no durable output" >&2; exit 1; }
[[ "$out" == *"stale=11/15"* ]] \
  || { echo "wz: (2) quiet fire did not report the census it saw: $out" >&2; exit 1; }
[ "$(field heartbeat_at)" = "$((A + 60))" ] \
  || { echo "wz: (2) quiet fire did not stamp the heartbeat the cron reads" >&2; exit 1; }
echo "wz: (2) a working quorum (73% stale) suppresses, and the quiet fire still stamps and speaks: ok"

# THE OTHER SIDE OF THE SAME BOUNDARY: one seat fewer active and it must fire.
# Without this the arm above is satisfiable by a detector that never fires at all.
arm --feeder opus-seat-1 --ledger "$LEDGER"
for h in opus-seat-3 opus-seat-5 sonnet-seat-1; do age_seat "$h" 30; done
tick "$((A + 60))" >/dev/null
[ "$(last_verdict)" = deadlock ] \
  || { echo "wz: (2b) 12/15 stale (80%, at the threshold) did not fire: $(ticks | tail -1)" >&2; exit 1; }
echo "wz: (2b) one active seat fewer — 80% stale, at the threshold — fires: ok"

# (2c) THE OLD SCENARIO, KEPT AND DELIBERATELY INVERTED. This is verbatim the case
#      arm (2) used to assert must NOT fire — a board with exactly one working
#      seat. Under quorum staleness it MUST fire: one active seat among fifteen
#      ageable is 93% stale, over the threshold.
#      Kept rather than deleted so the record shows the exact old case flipped on
#      purpose — a rewritten fixture argues, an inverted one demonstrates.
#      NO COVERAGE CLAIM HERE ON PURPOSE. Whether this behaviour would have
#      caught any particular historical board is a claim with a required form
#      (latency stated, silent-phase evidence, the WORKING==0 freeze alongside),
#      and it lives in exactly ONE place — the PR body — rather than being
#      restated here in a shorter form that drops the qualifiers. The mechanical
#      assertion below needs no incident reference to be true or to be tested.
arm --feeder opus-seat-1 --ledger "$LEDGER"
age_seat opus-seat-3 30          # exactly one working seat, as the old arm had
tick "$((A + 60))" >/dev/null
[ "$(last_verdict)" = deadlock ] \
  || { echo "wz: (2c) one working seat did NOT fire — the ratified inversion is gone: $(ticks | tail -1)" >&2; exit 1; }
echo "wz: (2c) the old '>=1 working seat' scenario now FIRES, by ratified design: ok"

# (2d) REAL-RECORD NEGATIVE CONTROLS. The healthy-quieting phases from the replay
#      of the actual 2026-08-19 board — 40% at 11:00Z and 61% at 11:30Z — are the
#      false-positive half of the coverage claim. Encoding them makes the
#      acceptance suite and the coverage sentence cite the same evidence, and a
#      real-record control outranks a synthetic one.
#      NOTE THE DENOMINATOR: these arms run BEFORE the board shrink, so there are
#      FIFTEEN ageable seats (sixteen minus the observer), not six. Sizing the
#      fresh count against the wrong board is what made this arm fire on its
#      first run — the same "one seat from a threshold" error as arms (3) and (5),
#      committed while writing the arm that tests for it.
ALL15="fable opus-seat-1 opus-seat-2 opus-seat-3 sol-seat-1 sol-seat-2
gemini-seat-1 opus-seat-4 grok-seat-1 opus-seat-5 glm53-seat-1 sonnet-seat-1
sonnet-seat-2 kimi fable-seat-1"
for pair in "40:11:00Z:9" "61:11:30Z:6"; do
  pctwant="$(printf '%s' "$pair" | cut -d: -f1)"
  when="$(printf '%s' "$pair" | cut -d: -f2,3)"
  fresh="$(printf '%s' "$pair" | cut -d: -f4)"
  arm --feeder opus-seat-1 --ledger "$LEDGER"
  # 15 ageable: 9 fresh -> 6 stale (40%); 6 fresh -> 9 stale (60%). Both below 80%.
  i=0
  for h in $ALL15; do
    i=$((i + 1)); [ "$i" -le "$fresh" ] && age_seat "$h" 30
  done
  tick "$((A + 60))" >/dev/null
  [ "$(last_verdict)" = quiet ] \
    || { echo "wz: (2d) the replayed healthy-quieting phase (~${pctwant}% at ${when}) FIRED: $(ticks | tail -1)" >&2; exit 1; }
done
echo "wz: (2d) the replay's healthy-quieting phases (40% @11:00Z, 61% @11:30Z) do not fire: ok"

# (2e) THE WAKE LINE'S FORMAT IS PINNED. Unpinning `DEADLOCK · WORKING 0` must not
#      leave the new wake formless. The declared-form discipline this lane applied
#      to the LEDGER's inputs applies to our own output: a small, stable,
#      parseable shape, load-bearing because a fixture says so rather than
#      habitual because nobody changed it. A reader — or a later parser — is
#      entitled to rely on it.
arm --feeder opus-seat-1 --ledger "$LEDGER"
for h in opus-seat-3; do age_seat "$h" 30; done
tick "$((A + 60))" >/dev/null
w="$(grep -l '^to: opus-seat-1$' "$BUS"/payloads/*.md | tail -1)"
grep -qE '^DEADLOCK · STALE [0-9]+/[0-9]+ \([0-9]+%\) idle >=[0-9]+m · READY ' "$w" \
  || { echo "wz: (2e) the quorum wake line does not match its declared form: $(grep -m1 '^DEADLOCK' "$w")" >&2; exit 1; }
# The UNAGED line appears only when a seat is genuinely unaged — an unconditional
# line would be noise on every healthy wake, and an absent one hides a shrunken
# denominator. Here every seat is ageable, so it must be absent.
! grep -q '^UNAGED ' "$w" \
  || { echo "wz: (2e) an UNAGED line rendered on a board where every seat is ageable" >&2; exit 1; }
echo "wz: (2e) the quorum wake line matches its declared form, and UNAGED is conditional: ok"

# The two ACCEPTANCE fixtures above need the real sixteen-seat board, because the
# board IS the fixture. Everything below tests the ladder, the exception form and
# the renderer, none of which depend on census size — so the board shrinks to four
# seats and the file stays inside the gate's budget. If a later arm ever asserts
# something about census SIZE, it belongs above this line.
shrink_board() {
  # SIX seats, not three: the quorum floor needs >=5 AGEABLE seats and the
  # observer is excluded from its own census, so a three-seat board sits below
  # the floor and every downstream arm reports quiet instead of firing. The board
  # pass is now file-stat only (no tmux per seat), so the extra seats are nearly
  # free — the cost that forced the shrink belonged to the old sensor.
  # SEVEN: six ageable plus the observer. Arm (5) SUSPENDS a seat to vacate the
  # feeder role, and with six the board would drop to five-minus-one and fall
  # below the floor — reporting quiet instead of the escalation it is testing.
  # A fixture whose board size is one seat from a threshold tests the threshold,
  # not the property.
  local keep="fable opus-seat-1 opus-seat-3 opus-seat-5 sonnet-seat-1 sonnet-seat-2 hermes-goalie"
  : > "$FAKE_TMUX_STATE/seats.tsv"
  local n=900 h
  for h in $keep; do n=$((n + 1)); printf '%s\t%s\t%%%s\n' "$h" "$h:0.0" "$n" >> "$FAKE_TMUX_STATE/seats.tsv"; done
  {
    printf '{ "schema": "0.20", "team": { "name": "tap", "worktree_root": "%s" }, "seats": {\n' "$WORK/repo"
    local first=1
    while IFS=$'\t' read -r h pane pid; do
      [ "$first" = 1 ] || printf ',\n'; first=0
      printf '  "%s": { "session": "%s", "pane": "%s", "pane_id": "%s", "server_epoch": "srv:4242:100", "harness": "%s", "status": "active", "session_store_path": "'"$STORE"'/%s.jsonl", "registered_from_worktree": "%s" }' \
        "$h" "$h" "$pane" "$pid" "$([ "$h" = hermes-goalie ] && echo hermes || echo codex)" "$h" "$WORK/repo"
    done < "$FAKE_TMUX_STATE/seats.tsv"
    printf '\n} }\n'
  } > "$BUS/registry.json"
}
shrink_board

# ---------------------------------------------------------------------------
# (3) ACK, NOT FIRE — an unanswered wake climbs the ladder to the human.
# ---------------------------------------------------------------------------
arm --feeder opus-seat-1 --ledger "$LEDGER"
tick "$((A + 60))"  >/dev/null; [ "$(last_verdict)" = deadlock ] || { echo "wz: (3) rung 1 missing" >&2; exit 1; }
tick "$((A + 120))" >/dev/null
[ "$(last_verdict)" = rung2 ] \
  || { echo "wz: (3) an unanswered wake did not re-fire: $(ticks | tail -1)" >&2; exit 1; }
# Content-anchored. Payload names are second-resolution plus a variable-length
# numeric suffix, so two back-to-back ticks in the same wall-clock second make
# `tail -1` pick the lexically last id — which can be rung1, which has no
# price. Load-inverse: a quieter box is more likely to collapse the two sends
# into one second. Select the payload that carries the rung2 marker.
price=""
while IFS= read -r f; do
  grep -qF 'no acquisition attempt' "$f" || continue
  price="$f"
  break
done < <(grep -l '^to: opus-seat-1$' "$BUS"/payloads/*.md)
[ -n "$price" ] \
  || { echo "wz: (3) the re-fire did not attach the price" >&2; exit 1; }
tick "$((A + 180))" >/dev/null
[ "$(last_verdict)" = rung3 ] \
  || { echo "wz: (3) a twice-unanswered wake did not reach the human: $(ticks | tail -1)" >&2; exit 1; }
[ -s "$FAKE_NOTIFY_LOG" ] \
  || { echo "wz: (3) rung 3 never invoked the notifier — the watchdog is decorative" >&2; exit 1; }
echo "wz: (3) unanswered wake escalates rung1 -> rung2 -> the human: ok"

# ---------------------------------------------------------------------------
# (4) A wake that cannot be DELIVERED escalates immediately — never a silence.
#     This is the feba839add81 specimen: .placed, never rendered, and the sender
#     believing it had warned someone.
# ---------------------------------------------------------------------------
cat > "$FAKE_BIN/dead-send" <<'DS'
#!/usr/bin/env bash
echo '{"ok":false,"error_class":"courier_failed"}'
exit 1
DS
chmod +x "$FAKE_BIN/dead-send"
arm --feeder opus-seat-1 --ledger "$LEDGER"
: > "$FAKE_NOTIFY_LOG"
TAP_COURIER_SCRIPT="$FAKE_BIN/dead-send" tick "$((A + 60))" >/dev/null
[ "$(last_verdict)" = rung3 ] \
  || { echo "wz: (4) an undeliverable wake did not escalate: $(ticks | tail -1)" >&2; exit 1; }
[ -s "$FAKE_NOTIFY_LOG" ] \
  || { echo "wz: (4) an undeliverable wake produced SILENCE, not an escalation" >&2; exit 1; }
echo "wz: (4) an undeliverable wake escalates to the human instead of going quiet: ok"

# ---------------------------------------------------------------------------
# (5) A VACANT feeder is the failure this detector exists to expose. It must not
#     degrade into a wake addressed to nobody.
# ---------------------------------------------------------------------------
arm --feeder opus-seat-1 --ledger "$LEDGER"
: > "$FAKE_NOTIFY_LOG"
python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["seats"]["opus-seat-1"]["status"]="suspended"; json.dump(d,open(p,"w"))' "$BUS/registry.json"
tick "$((A + 60))" >/dev/null
[ "$(last_verdict)" = rung3 ] \
  || { echo "wz: (5) a vacant feeder role did not escalate: $(ticks | tail -1)" >&2; exit 1; }
[ -s "$FAKE_NOTIFY_LOG" ] || { echo "wz: (5) vacancy produced no human wake" >&2; exit 1; }
grep -qF '<vacant>' "$FAKE_NOTIFY_LOG" || grep -qF 'owner=<vacant>' "$BUS/goalie/tick.log" \
  || { echo "wz: (5) vacancy was not named as such" >&2; exit 1; }
python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["seats"]["opus-seat-1"]["status"]="active"; json.dump(d,open(p,"w"))' "$BUS/registry.json"
echo "wz: (5) a vacant feeder escalates and is named vacant: ok"

# ---------------------------------------------------------------------------
# (6) THE EXCEPTION FORM — existence, tag, expiry. Checked mechanically; the
#     goalie never judges whether the reason is a good one.
# ---------------------------------------------------------------------------
reply_to_wake() { # <body>
  local w id
  w="$(grep -l '^to: opus-seat-1$' "$BUS"/payloads/*.md | tail -1)"
  id="$(sed -n 's/^id: //p' "$w" | head -1)"
  { printf -- '---\nid: reply-%s\nfrom: opus-seat-1\nto: hermes-goalie\nkind: discuss\nin_reply_to: %s\n---\n' "$id" "$id"
    printf '%s\n' "$1"; } > "$BUS/payloads/reply-$id.md"
}
arm --feeder opus-seat-1 --ledger "$LEDGER"
tick "$((A + 60))" >/dev/null
reply_to_wake "EXCEPTION (a) backlog-needs-owner
tap-20ao -> waiting on the operator to ratify the digest_interval default
tap-dg8g -> waiting on the operator to rule on reclaim-vs-keep
VALID-UNTIL $(iso $((A + 3600)))"
tick "$((A + 120))" >/dev/null
[ "$(last_verdict)" = answered-exception ] \
  || { echo "wz: (6) a tagged exception was not recognised: $(ticks | tail -1)" >&2; exit 1; }
tick "$((A + 180))" >/dev/null
[ "$(last_verdict)" = held ] \
  || { echo "wz: (6) an unexpired exception did not hold the board: $(ticks | tail -1)" >&2; exit 1; }
# Expiry without renewal re-arms deadlock — the exception is a lease, not a mute.
# Public path: if tap_goalie_tick ignored TAP_GOALIE_NOW, wall-clock now would
# still be inside VALID-UNTIL (A+3600) and this arm would stay held.
TAP_GOALIE_NOW="$((A + 3601))" bash "$TAPSH" goalie tick >/dev/null 2>&1 || true
[ "$(last_verdict)" = deadlock ] \
  || { echo "wz: (6) an EXPIRED exception still muted the detector: $(ticks | tail -1)" >&2; exit 1; }
echo "wz: (6) tagged exception holds, and expiry re-arms deadlock: ok"


# The wake's own instructions must name only forms the checker accepts.
arm --feeder opus-seat-1 --ledger "$LEDGER"
tick "$((A + 60))" >/dev/null
wake2="$(grep -l '^to: opus-seat-1$' "$BUS"/payloads/*.md | tail -1)"
grep -qF 'named event' "$wake2" && ! grep -qF 'NOT accepted' "$wake2" \
  && { echo "wz: (6e) the wake still offers a named event as a VALID-UNTIL" >&2; exit 1; }
grep -qF '2026-08-19T13:00:00Z' "$wake2" \
  || { echo "wz: (6e) the wake does not show an accepted VALID-UNTIL spelling" >&2; cat "$wake2" >&2; exit 1; }
echo "wz: (6e) the wake instructs only VALID-UNTIL spellings the checker accepts: ok"


# ---------------------------------------------------------------------------
# (7) THE RENDERER — four facts, four strings, and not one of them says "none".
#     The regression this guards is a human editor tidying four strings into one.
# ---------------------------------------------------------------------------
render() { # <ledger-args…> -> the OBJECTIVE line of the next wake
  arm --feeder opus-seat-1 "$@"
  tick "$((A + 60))" >/dev/null
  sed -n 's/^OBJECTIVE //p' "$(grep -l '^to: opus-seat-1$' "$BUS"/payloads/*.md | tail -1)" | head -1
}
NO_LEDGER="$(render)"
printf 'the leader wrote his objective as a sentence and nothing else\n' > "$WORK/prose.md"
UNDECLARED="$(render --ledger "$WORK/prose.md")"
printf 'OBJECTIVE:\n' > "$WORK/empty.md"
EMPTY="$(render --ledger "$WORK/empty.md")"
DECLARED="$(render --ledger "$LEDGER")"
# A configured path that does not resolve is its OWN fact — an operator error,
# not a leader who failed to declare. grok: collapsing it into UNDECLARED left
# arm (7) green, so the pairwise guard had a hole at exactly the state it omitted.
UNREADABLE="$(render --ledger "$WORK/does-not-exist.md")"
for pair in "NO_LEDGER:$NO_LEDGER" "UNDECLARED:$UNDECLARED" "EMPTY:$EMPTY" "DECLARED:$DECLARED" "UNREADABLE:$UNREADABLE"; do
  [ -n "${pair#*:}" ] || { echo "wz: (7) ${pair%%:*} rendered an empty OBJECTIVE line" >&2; exit 1; }
done
[ "$(printf '%s\n%s\n%s\n%s\n%s\n' "$NO_LEDGER" "$UNDECLARED" "$EMPTY" "$DECLARED" "$UNREADABLE" | sort -u | wc -l | tr -d ' ')" = 5 ] \
  || { echo "wz: (7) the five render states are not pairwise distinct:
  no-ledger : $NO_LEDGER
  undeclared: $UNDECLARED
  empty     : $EMPTY
  declared  : $DECLARED
  unreadable: $UNREADABLE" >&2; exit 1; }
# "none" is the word that collapses them. An undeclared objective is UNKNOWN, and
# saying "none" would assert the board is unowned when it is merely unparsed.
for s in "$NO_LEDGER" "$UNDECLARED" "$EMPTY" "$UNREADABLE"; do
  case "$s" in *none*|*None*|*NONE*) echo "wz: (7) a render state claims 'none': $s" >&2; exit 1 ;; esac
done
case "$UNDECLARED" in *prose*) ;; *) echo "wz: (7) the undeclared state does not tell the reader prose is invisible: $UNDECLARED" >&2; exit 1 ;; esac
echo "wz: (7) five render states, pairwise distinct, none of them says 'none': ok"

# ---------------------------------------------------------------------------
# (8) A broken backlog probe degrades the MESSAGE and never silences the ALARM.
# ---------------------------------------------------------------------------
arm --feeder opus-seat-1 --ledger "$LEDGER"
TAP_GOALIE_READY_CMD='exit 7' tick "$((A + 60))" >/dev/null
[ "$(last_verdict)" = deadlock ] \
  || { echo "wz: (8) a broken backlog probe silenced the detector: $(ticks | tail -1)" >&2; exit 1; }
grep -qF 'READY ?' "$(grep -l '^to: opus-seat-1$' "$BUS"/payloads/*.md | tail -1)" \
  || { echo "wz: (8) an unreadable backlog did not render as unknown" >&2; exit 1; }
echo "wz: (8) a broken backlog probe renders unknown and still fires: ok"

# ---------------------------------------------------------------------------
# (9) The log line and the heartbeat cannot disagree. A cron reading a fresh
#     stamp over a fire that logged nothing would report health nobody observed.
# ---------------------------------------------------------------------------
arm --feeder opus-seat-1 --ledger "$LEDGER"
# Quiet the BOARD PASS the way it now measures: by AGE, not by pane state.
# `busy` drives tap_seat_state, which the per-seat sweep still reads but the
# board pass no longer does — marking a seat busy leaves every store file stale
# and the board fires. Two fresh of six ageable is 66%, under the threshold.
age_seat fable 30; age_seat opus-seat-1 30
tick "$((A + 60))" >/dev/null
[ -f "$BUS/goalie/heartbeat" ] || { echo "wz: (9) no heartbeat file for the cron to read" >&2; exit 1; }
[ "$(cat "$BUS/goalie/heartbeat")" = "$((A + 60))" ] \
  || { echo "wz: (9) heartbeat file disagrees with the fire that wrote it" >&2; exit 1; }
[ "$(ticks | tail -1 | grep -c "verdict=quiet")" = 1 ] \
  || { echo "wz: (9) stamp written without a matching log line" >&2; exit 1; }
# A tick that cannot append must not leave a fresh stamp behind.
chmod 0444 "$BUS/goalie/tick.log"
prev="$(cat "$BUS/goalie/heartbeat")"
TAP_GOALIE_NOW="$((A + 120))" bash "$TAPSH" goalie tick >/dev/null 2>&1 || true
chmod 0644 "$BUS/goalie/tick.log"
[ "$(cat "$BUS/goalie/heartbeat")" = "$prev" ] \
  || { echo "wz: (9) a fire that could not log still stamped the heartbeat" >&2; exit 1; }
age_seat fable 3000; age_seat opus-seat-1 3000   # restore the stale posture
echo "wz: (9) log-then-stamp is coupled; a fire that cannot log does not stamp: ok"

# ---------------------------------------------------------------------------
# (10) A QUEUED wake is PARKED, not lost. The courier rehomes a queued artifact
#      to spool/, so reading a hardcoded payloads/ path would discard a valid
#      obligation and wake the human for a merely busy feeder — ACK-not-PARK
#      wearing ACK-not-fire's clothes. grok reproduced exactly this at b9c60af7.
# ---------------------------------------------------------------------------
mkdir -p "$BUS/spool"
cat > "$FAKE_BIN/queued-send" <<'QS'
#!/usr/bin/env bash
set -euo pipefail
to="$1"; shift
body=""
while [ "$#" -gt 0 ]; do case "$1" in -m) body="$2"; shift 2 ;; *) shift ;; esac; done
id="hermes-goalie-queued-$RANDOM$RANDOM"
mkdir -p "$TAP_HOME/spool"
{ printf -- '---\nid: %s\nfrom: hermes-goalie\nto: %s\nkind: discuss\nreply: expected\n---\n' "$id" "$to"
  printf '%s\n' "$body"; } > "$TAP_HOME/spool/$id.md"
printf '{"status":"queued","delivery":"spool","id":"%s","to":"%s","path":"%s"}\n' \
  "$id" "$to" "$TAP_HOME/spool/$id.md"
QS
chmod +x "$FAKE_BIN/queued-send"
arm --feeder opus-seat-1 --ledger "$LEDGER"
: > "$FAKE_NOTIFY_LOG"
TAP_COURIER_SCRIPT="$FAKE_BIN/queued-send" tick "$((A + 60))" >/dev/null
[ "$(last_verdict)" = deadlock ] \
  || { echo "wz: (10) a QUEUED wake was treated as a failed send: $(ticks | tail -1)" >&2; exit 1; }
[ -n "$(field wake_id)" ] \
  || { echo "wz: (10) a queued wake stored no obligation to escalate against" >&2; exit 1; }
[ ! -s "$FAKE_NOTIFY_LOG" ] \
  || { echo "wz: (10) a queued wake woke the human instead of parking" >&2; exit 1; }
echo "wz: (10) a queued wake parks as a real obligation and does not wake the human: ok"

# ---------------------------------------------------------------------------
# (11) A SPOOLED reply is an answer. A reply to a busy goalie pane is spooled,
#      and the courier moves it into payloads/ only on delivery — so scanning
#      payloads/ alone reports "no answer" for a feeder who answered, and the
#      ladder escalates them to the human for complying. Worse than the queued
#      case: that one punished a busy feeder, this one punishes a correct one.
# ---------------------------------------------------------------------------
arm --feeder opus-seat-1 --ledger "$LEDGER"
: > "$FAKE_NOTIFY_LOG"
tick "$((A + 60))" >/dev/null
wake_id="$(field wake_id)"
[ -n "$wake_id" ] || { echo "wz: (11) no wake to answer" >&2; exit 1; }
mkdir -p "$BUS/spool"
{ printf -- '---\nid: spooled-reply\nfrom: opus-seat-1\nto: hermes-goalie\nkind: discuss\nin_reply_to: %s\n---\n' "$wake_id"
  printf 'Dispatching tap-20ao to Lane A now.\n'; } > "$BUS/spool/spooled-reply.md"
tick "$((A + 120))" >/dev/null
[ "$(last_verdict)" = answered ] \
  || { echo "wz: (11) a SPOOLED reply was not seen as an answer: $(ticks | tail -1)" >&2; exit 1; }
[ ! -s "$FAKE_NOTIFY_LOG" ] \
  || { echo "wz: (11) the human was woken for a feeder who had already replied" >&2; exit 1; }
rm -f "$BUS/spool/spooled-reply.md"
echo "wz: (11) a spooled reply counts as an answer and never escalates a compliant feeder: ok"

echo "goalie-working-zero: ok"
