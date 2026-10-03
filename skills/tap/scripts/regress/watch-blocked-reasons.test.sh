#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# watch-blocked-reasons.test.sh — tap-dst: watcher blocked-seat REASON classification
# (session_limit / api_error), per-seat blocked_map + blocked_exempt, driven entirely
# through the public `tap watch tick` interface (state-machine style, real fixture for
# session_limit). Round-2 review (PR21): fixes a blocker (a resumed seat re-blocked off
# the same still-on-screen banner forever, NOTIFY never fired) plus 3 should-fixes —
# scope the pause per-seat, skip a clobbering continue if the seat recovered on its own,
# and never arm a reset_at=0 timer off an unparseable reset clause.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

# Mock-tmux smoke: the courier's real-TUI settle sleeps verify nothing against
# a synchronous mock — scale them down (smoke-speed PR2; default 1 in production).
# TAP_TUI_SETTLE_SCALE is the suite's one shared timing knob; TAP_WATCH_NOW is
# the logical clock. GHA run 33388777402 already ran both (scale 0.1, injected
# now) and still got 0 ordinary probes at arm (4). Do not add a second knob.
export TAP_TUI_SETTLE_SCALE=0.1
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAPSH="$ROOT/bin/tap"
FIXTURES="$ROOT/skills/tap/scripts/smoke/fixtures/peek-harness-adapters"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"; FAKE_STATE="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN" "$FAKE_STATE"' EXIT
# Same TAP_INDEX_HOME redirect every watch smoke uses: NOTIFY best-effort escalates
# via tap-escalate.sh, which must never touch a dev machine's real ~/.tap.
export TAP_INDEX_HOME="$WORK/index"
mkdir -p "$TAP_INDEX_HOME"
printf '{"schema":"0.20","teams":{}}\n' > "$TAP_INDEX_HOME/global-registry.json"  # born live (F1)

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"; shift || true
target=""; fmt=""; escaped=0; frame=""
pane_address_for() {
  case "${1#=}" in
    pane-lead|%11) printf pane-lead ;;
    pane-second|%12) printf pane-second ;;
    *) return 1 ;;
  esac
}
pane_id_for() {
  case "$(pane_address_for "$1")" in
    pane-lead) printf '%%11' ;;
    pane-second) printf '%%12' ;;
  esac
}
case "$cmd" in
  # CONTRACT §Session-name authority: serve an exact-generation inventory of
  # the designated panes, rather than treating a symbolic target as evidence.
  list-sessions)
    printf 'sess\t4242:100\n' ;;
  list-panes)
    printf 'sess\tpane-lead\t%%11\tclaude\t4242\t4242:100\t0\n'
    printf 'sess\tpane-second\t%%12\tclaude\t4242\t4242:100\t0\n' ;;
  display-message)
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -p) shift ;;
        -t) target="${2:-}"; shift 2 ;;
        *) fmt="$1"; shift ;;
      esac
    done
    if [ "$fmt" = '#{pid}:#{start_time}' ]; then echo "4242:100"; exit 0; fi
    target="$(pane_address_for "$target" || true)"
    state="${FAKE_TMUX_STATE:?}/$target"
    case "$fmt" in
      *pane_id*session_name*pane_pid*pane_current_command*)
        pid4="$(pane_id_for "$target" || true)"
        if [ -n "$pid4" ]; then printf '%s\tsess\t4242\tclaude\t0\n' "$pid4"; else printf '\t\t\t\t0\n'; fi ;;
      # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
      *pane_id*pane_tty*session_name*) printf '%s\t/dev/faketty\tsess\t4242:100\n' "$(pane_id_for "$target")" ;;
      *pane_id*session_name*) printf '%s\tsess\t4242:100\n' "$(pane_id_for "$target")" ;;
      *session_name*) echo sess ;;
      *pane_id*) pane_id_for "$target" ;;
      *pane_in_mode*) echo "0" ;;
      *pane_current_command*) echo claude ;;
      *pane_current_path*) echo "${FAKE_WORKTREE:?}" ;;
      *pane_pid*) echo "4242" ;;
      *window_activity*) [ -f "$state/window_activity" ] && cat "$state/window_activity" || echo "${FAKE_WINDOW_ACTIVITY:-100}" ;;
      *) echo "" ;;
    esac
    ;;
  capture-pane)
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -t) target="${2:-}"; shift 2 ;;
        -e) escaped=1; shift ;;
        -p) shift ;;
        *) shift ;;
      esac
    done
    target="$(pane_address_for "$target" || true)"
    state="${FAKE_TMUX_STATE:?}/$target"
    # An unseeded pane used to answer with a bare '❯ '. That is not an input band
    # the courier will inject into: its readiness probe finds no composer, reports
    # blocked/no-input-prompt, and the send parks in the spool instead of being
    # published canonically. Serve the captured idle frame instead -- selected
    # here, then rendered through the SAME -e/strip path as a seeded fixture, so
    # a caller asking for the raw frame still gets ANSI and a plain capture still
    # gets it stripped.
    frame="$state/fixture"
    [ -f "$frame" ] || frame="${FAKE_IDLE_FRAME:?}"
    if [ "$escaped" = 1 ]; then
      cat "$frame"
    else
      python3 -c 'import re,sys; print(re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", sys.stdin.read()), end="")' < "$frame"
    fi
    exit 0
    ;;
  send-keys)
    # No stateful input buffer: capture-pane always serves the fixed fixture above, so
    # injection verify (tap_input_has_id) can never observe a landed id — the courier
    # degrades to its already-supported "queued, unverified" exit 5, which every watch
    # send site treats the same as exit 0. Exit 5 is submit-unverified, and that is
    # all it says: canonical publication is observed, submission is not. It does
    # not establish that any key was sent -- the earlier reversal produced a 5 with
    # Enter explicitly withheld. This fixture cannot certify pane submission;
    # canonical publication plus the watcher-state and body assertions are what
    # it proves.
    exit 0 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket" FAKE_TMUX_STATE="$FAKE_STATE" FAKE_WORKTREE="$WORK/repo"
# The captured idle frame every unseeded pane answers with; also the composer the
# hand-written banners below ride on.
# Pending-input protocol part-01 preserves drafts. The old idle capture contains
# "good morning - how did the run go?", so it correctly parks ordinary probes.
export FAKE_IDLE_FRAME="$ROOT/skills/tap/scripts/smoke/fixtures/pane-state/claude/idle-band.ansi"

BUS="$WORK/repo/.tap/bus"; mkdir -p "$BUS/payloads" "$BUS/receipts" "$WORK/repo"; export TAP_HOME="$BUS"
cat > "$BUS/registry.json" <<JSON
{"schema": "0.20",  "team": { "name": "t", "worktree_root": "$WORK/repo" },
  "seats": {
    "lead": { "pane": "pane-lead", "pane_id": "%11", "session": "sess", "server_epoch": "srv:4242:100", "harness": "claude", "status": "active", "registered_from_worktree": "$WORK/repo" }
  } }
JSON
mkdir -p "$FAKE_STATE/pane-lead" "$FAKE_STATE/pane-second"
# "second" is added to the registry only for test (6) — tests (1)-(5) run with a single
# registered seat so chain-selection is unambiguous (two idle seats tied on recency have
# no guaranteed tie-break order across sort implementations).
register_second() {
  python3 -c 'import json,sys
p = sys.argv[1]; r = json.load(open(p))
r["seats"]["second"] = {"pane": "pane-second", "pane_id": "%12", "session": "sess", "server_epoch": "srv:4242:100", "harness": "claude", "status": "active", "registered_from_worktree": sys.argv[2]}
json.dump(r, open(p, "w"))' "$BUS/registry.json" "$WORK/repo"
}

field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],""))' "$BUS/watch/arm.json" "$1"; }
bfield() {  # <handle> <field> -- reads blocked_map[handle][field]
  python3 -c 'import json,sys
r = json.load(open(sys.argv[1]))
m = r.get("blocked_map", "{}") or "{}"
d = json.loads(m) if isinstance(m, str) else m
print((d.get(sys.argv[2]) or {}).get(sys.argv[3], ""))' "$BUS/watch/arm.json" "$1" "$2"
}
bempty() {  # exit 0 iff blocked_map has no entries
  python3 -c 'import json,sys
r = json.load(open(sys.argv[1]))
m = r.get("blocked_map", "{}") or "{}"
d = json.loads(m) if isinstance(m, str) else m
sys.exit(0 if not d else 1)' "$BUS/watch/arm.json"
}
exempt_has() {  # <handle> -- exit 0 iff present in blocked_exempt
  python3 -c 'import json,sys
r = json.load(open(sys.argv[1]))
e = r.get("blocked_exempt", []) or []
sys.exit(0 if sys.argv[2] in e else 1)' "$BUS/watch/arm.json" "$1"
}
setmap() {  # <blocked-map-json> -- seed blocked_map directly, bypassing classify
  python3 -c 'import json,sys
p = sys.argv[1]; r = json.load(open(p))
r["blocked_map"] = sys.argv[2]
json.dump(r, open(p, "w"))' "$BUS/watch/arm.json" "$1"
}
setfield() {  # <field> <value> -- adjust one arm field for a focused state-machine case
  python3 -c 'import json,sys
p = sys.argv[1]; r = json.load(open(p))
r[sys.argv[2]] = sys.argv[3]
json.dump(r, open(p, "w"))' "$BUS/watch/arm.json" "$1" "$2"
}
# A count of CANONICALLY PUBLISHED payloads -- not a delivery oracle. A parked
# spool entry whose canonical copy has been placed counts here too, and neither
# state proves the recipient received anything (see the send-keys note above).
payload_count() { find "$BUS/payloads" -maxdepth 1 -name '*.md' | wc -l | tr -d ' '; }
payload_bodies() { find "$BUS/payloads" -maxdepth 1 -name '*.md'; }
clear_payloads() { rm -f "$BUS"/payloads/*.md 2>/dev/null || true; }
# Read-only precondition: production's OWN composer reader must be able to read
# the pane an upcoming tick will send to. `composerInput` from submit-frame.ts is the
# reader the courier uses. A frame it cannot read makes the send park in the
# spool, and the arm then reds on a payload count several ticks later -- or
# passes anyway when that entry happens to drain to canonical first. Asserting
# it here puts the failure at the cause. The composer must also be empty: readability alone permits a human draft.
# This observes only: it repairs no
# state, clears no queue, and waits for nothing.
#
# One conservative failure, deliberately. Anything but a `text` verdict (unknown,
# blocked, or a module failure) is reported as unreadable, never as a definitive
# verdict about the pane. The
# capture is inside the pipeline under `pipefail` for the same reason: a capture
# that prints a readable frame and then exits nonzero must not be laundered into
# a pass by a reader that succeeds on its bytes. An empty composer does not prove that publication follows or that a submission succeeded.
composer_empty() {  # <pane> <arm-label>
  local _out _rc=0
  _out="$(bash -c 'set -o pipefail
tmux capture-pane -e -p -t "$2" | bun "$1/runtime/bun/test/support/composer-input-cli.ts" claude' _ "$ROOT" "$1" 2>&1)" || _rc=$?
  case "$_out" in text$'\x1f'*) _out="${_out#text$'\x1f'}" ;; *) [ "$_rc" != 0 ] || _rc=3 ;; esac
  [ "$_rc" = 0 ] || {
    echo "blocked-reasons: $2 precondition: could not establish a readable composer on pane '$1' (status $_rc); probe output: ${_out:-<none>}" >&2
    exit 1
  }
  python3 -c 'import sys; sys.exit(bool(sys.argv[1].strip()))' "$_out" || {
    echo "blocked-reasons: $2 precondition: composer contains a draft: $_out" >&2
    exit 1
  }
}
# terminal MUST differ from the probed seats (chain-builder convention, see watch-notify-semantics).
# Report the refusal rather than dying mute. This helper swallowed stdout AND
# stderr, so a refused arm killed the script under `set -e` with rc=1, no
# message, and four green cases above it — indistinguishable from a crash, and
# it cost a control-diff against main to locate. Whatever a future arm refusal
# is, the reader should be able to see it.
arm() {
  local _out _rc=0
  # `_out="$(...)"; _rc=$?` would NOT work here: under `set -e` a failing
  # command substitution in a bare assignment kills the shell at the assignment,
  # before the report ever runs — which is the mute death this helper exists to
  # end. The `&& || ` list is what makes the failure survivable long enough to
  # print.
  _out="$(bash "$TAPSH" watch on --rearm --by lead -m "done; proof; bound" --evaluator none \
            --threshold 1500 --probe-timeout 1500 --terminal ghost --no-spawn 2>&1)" || _rc=$?
  [ "$_rc" = 0 ] || { echo "blocked-reasons: arm failed (rc=$_rc): $_out" >&2; return "$_rc"; }
}
tick() { TAP_WATCH_NOW="$1" bash "$TAPSH" watch tick >/dev/null 2>&1; }

# ---- (1) session_limit: classify + PAUSE (no send, no NOTIFY, correct reset epoch) ----
cp "$FIXTURES/claude-code-session-limit.ansi" "$FAKE_STATE/pane-lead/fixture"
rm -f "$FAKE_STATE/pane-second/fixture"
arm; A="$(field armed_at)"
NOW1="$((A + 2000))"
tick "$NOW1"                                    # past threshold -> wedge-suspect -> classify, not send
[ "$(bfield lead reason)" = "session_limit" ] || { echo "blocked-reasons: (1) session_limit not classified (got '$(bfield lead reason)')" >&2; exit 1; }
[ "$(payload_count)" = "0" ] || { echo "blocked-reasons: (1) a send fired to a known-blocked seat" >&2; exit 1; }
[ -f "$BUS/watch/notify.json" ] && { echo "blocked-reasons: (1) blocked seat raised a NOTIFY" >&2; exit 1; }
RESET="$(bfield lead reset_at)"
EXPECT="$(python3 -B -c '
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
now = datetime.fromtimestamp('"$NOW1"', ZoneInfo("America/Los_Angeles"))
c = now.replace(hour=7, minute=40, second=0, microsecond=0)
if c <= now: c += timedelta(days=1)
print(int(c.timestamp()))
')"
[ "$RESET" = "$EXPECT" ] || { echo "blocked-reasons: (1) reset epoch wrong: got $RESET want $EXPECT" >&2; exit 1; }
echo "blocked-reasons: (1) session_limit classified + paused, reset epoch parsed correctly (12h clock + tz-in-parens): ok"

# ---- (2) pause holds until reset + grace elapses (still < grace boundary) ----
tick "$((RESET + 59))"                          # < reset + 60s grace
[ "$(bfield lead reason)" = "session_limit" ] || { echo "blocked-reasons: (2) pause did not hold before grace elapsed" >&2; exit 1; }
[ "$(payload_count)" = "0" ] || { echo "blocked-reasons: (2) a send fired before the resume timer" >&2; exit 1; }
[ -f "$BUS/watch/notify.json" ] && { echo "blocked-reasons: (2) NOTIFY fired while still paused" >&2; exit 1; }
echo "blocked-reasons: (2) pause holds (no send, no NOTIFY) before reset+grace: ok"

# ---- (3) resume: continue sent, moved to blocked_exempt, blocked_map cleared ----
setfield armed_by owner                         # route exceptions to the armer, not the blocked seat
tick "$((RESET + 61))"
bempty || { echo "blocked-reasons: (3) blocked_map not cleared on resume" >&2; exit 1; }
exempt_has lead || { echo "blocked-reasons: (3) resumed seat not moved to blocked_exempt" >&2; exit 1; }
[ "$(payload_count)" = "1" ] || { echo "blocked-reasons: (3) expected exactly one continue send, got $(payload_count)" >&2; exit 1; }
CONTINUE_PAYLOAD="$(payload_bodies | head -1)"
grep -q '^to: lead$' "$CONTINUE_PAYLOAD" || { echo "blocked-reasons: (3) continue message not addressed to the blocked seat" >&2; exit 1; }
grep -q '^from: watcher$' "$CONTINUE_PAYLOAD" || { echo "blocked-reasons: (3) continue message not from the watcher identity" >&2; exit 1; }
grep -qi "session limit that has now reset" "$CONTINUE_PAYLOAD" || { echo "blocked-reasons: (3) continue body missing the resume reason" >&2; exit 1; }
grep -qF '1. Settle this message' "$CONTINUE_PAYLOAD" || { echo "blocked-reasons: (3) continue body is not settlement-first" >&2; exit 1; }
grep -qF 'ONLY if you are blocked' "$CONTINUE_PAYLOAD" || { echo "blocked-reasons: (3) continue body missing conditional blocker/done routing" >&2; exit 1; }
grep -qF 'tap send owner' "$CONTINUE_PAYLOAD" || { echo "blocked-reasons: (3) continue body did not route exceptions to the armer" >&2; exit 1; }
grep -qF '{{ARMER}}' "$CONTINUE_PAYLOAD" && { echo "blocked-reasons: (3) continue body left an unsubstituted {{ARMER}}" >&2; exit 1; }
grep -qF 'send a status line to the lead' "$CONTINUE_PAYLOAD" && { echo "blocked-reasons: (3) continue body still orders unconditional status" >&2; exit 1; }
grep -qF 'tap watch off' "$CONTINUE_PAYLOAD" && { echo "blocked-reasons: (3) continue body still invites non-armer disarm" >&2; exit 1; }
# tap-hhg regression pins: the continue nudge must tell the seat to RESUME its work
# and must NOT read as a stop order.
grep -qiF 'RESUME the work you were doing' "$CONTINUE_PAYLOAD" || { echo "blocked-reasons: (3) continue body missing the resume-your-work instruction (tap-hhg)" >&2; exit 1; }
grep -qiF 'then stop' "$CONTINUE_PAYLOAD" && { echo "blocked-reasons: (3) continue body still reads as a stop order (tap-hhg regression)" >&2; exit 1; }
echo "blocked-reasons: (3) resume sends a self-contained continue, moves the seat to blocked_exempt: ok"
# Scope (3)'s armer poke to (3). It exists only so the continue body has a
# non-`lead` armer to route exceptions to; leaving it set makes every later
# `arm` a CROSS-SEAT re-arm, which tap-pqf2 now correctly refuses (`watch is
# armed by 'owner'; 'lead' cannot re-arm it`). The refusal is right — a peer
# must not take over another seat's watch — so the fixture is what has to stop
# pretending `lead` armed a watch owned by `owner`.
setfield armed_by lead

# ---- (4/BLOCKER+REQUIRED) a tick AFTER resume, banner still visible: normal ladder
# proceeds (an ORDINARY probe, not another continue — the seat is never reclassified off
# the still-on-screen banner) and NOTIFY still fires once genuinely exhausted. This is
# exactly the hole the round-2 review found: the old design wiped the "already resumed"
# memory on episode reset and re-blocked the same seat off the same banner forever. ----
# GHA 33388777402: (1)(2)(3) green, then (4) got 0 ordinary probes at RESET+62.
# Run the oracle. The named tap-tr2rd signature is empty blocked_map AND
# payload_count=0 AND no exhaustion NOTIFY; only that emits the receipt.
# Count 1 keeps the original probe-content + exhaustion/NOTIFY assertions.
# Any other state stays fatal. No uname, no blanket platform skip.
clear_payloads
tick "$((RESET + 62))"                          # banner UNCHANGED — same fixture, no real recovery
bempty || { echo "blocked-reasons: (4) an already-exempt seat got re-blocked off the stale banner" >&2; exit 1; }
_arm4_count="$(payload_count)"
if [ "$_arm4_count" = "0" ]; then
  [ ! -f "$BUS/watch/notify.json" ] || { echo "blocked-reasons: (4) zero ordinary probes but exhaustion NOTIFY fired; not tap-tr2rd" >&2; exit 1; }
  tap_smoke_known_defect tap-tr2rd 2026-08-31 "post-resume ordinary probe got 0 on Linux GHA"
  echo "blocked-reasons: (4) ordinary-probe miss matches tap-tr2rd; sibling arms continue: ok"
elif [ "$_arm4_count" = "1" ]; then
  ORDINARY_PROBE="$(payload_bodies | head -1)"
  grep -qi "escalation rung" "$ORDINARY_PROBE" || { echo "blocked-reasons: (4) exempt seat did not get an ORDINARY probe" >&2; exit 1; }
  grep -qi "session limit that has now reset" "$ORDINARY_PROBE" && { echo "blocked-reasons: (4) got another continue instead of an ordinary probe" >&2; exit 1; }
  PROBE_AT="$((RESET + 62))"
  tick "$((PROBE_AT + 1501))"                   # probe_timeout (1500s) elapses, still silent -> exhausted
  [ -f "$BUS/watch/notify.json" ] || { echo "blocked-reasons: (4) chain exhaustion after resume never reached NOTIFY" >&2; exit 1; }
  echo "blocked-reasons: (4) post-resume: ordinary probe on the stale banner (never re-blocked), NOTIFY still fires once exhausted: ok"
else
  echo "blocked-reasons: (4) expected exactly one ordinary probe, got ${_arm4_count}" >&2
  exit 1
fi

# ---- (5) api_error: single retry after backoff, then an ORDINARY probe next tick ----
clear_payloads; rm -f "$BUS/watch/notify.json"
# The banner rides a REAL captured idle frame, as arms (1)-(4) do. A hand-drawn
# transcript ending in a bare glyph has no composer for the courier's readiness
# probe, so the ordinary sends below parked in the spool instead of publishing.
{ printf 'first transcript line\nsecond transcript line\nAgent "worker" failed: Agent terminated early due to an API error: internal error, please retry\n\n'
  cat "$FAKE_IDLE_FRAME"; } > "$FAKE_STATE/pane-lead/fixture"
composer_empty pane-lead "(5)"    # the banner frame must still be readable
arm; A="$(field armed_at)"
# Observational only: prove --rearm left a fresh lease before the classify tick.
# Do not clear or rewrite any field. Failures here are a precondition leak
# (tap-tr2rd fall-through); failures after tick NOW2 with these green are a
# classify-tick send.
[ "$(payload_count)" = "0" ] || { echo "blocked-reasons: (5) post-rearm payload_count=$(payload_count) (want 0)" >&2; exit 1; }
bempty || { echo "blocked-reasons: (5) post-rearm blocked_map not empty: $(field blocked_map)" >&2; exit 1; }
[ "$(field blocked_exempt)" = "[]" ] || { echo "blocked-reasons: (5) post-rearm blocked_exempt=$(field blocked_exempt)" >&2; exit 1; }
[ "$(field current_rung)" = "0" ] || { echo "blocked-reasons: (5) post-rearm current_rung=$(field current_rung)" >&2; exit 1; }
[ "$(field probed_seats)" = "[]" ] || { echo "blocked-reasons: (5) post-rearm probed_seats=$(field probed_seats)" >&2; exit 1; }
[ -z "$(field queued_probe_id)" ] || { echo "blocked-reasons: (5) post-rearm queued_probe_id=$(field queued_probe_id)" >&2; exit 1; }
[ -z "$(field queued_probe_seat)" ] || { echo "blocked-reasons: (5) post-rearm queued_probe_seat=$(field queued_probe_seat)" >&2; exit 1; }
[ -z "$(field carried_probe_seat)" ] || { echo "blocked-reasons: (5) post-rearm carried_probe_seat=$(field carried_probe_seat)" >&2; exit 1; }
[ "$(field carried_probe_at)" = "0" ] || { echo "blocked-reasons: (5) post-rearm carried_probe_at=$(field carried_probe_at)" >&2; exit 1; }
NOW2="$((A + 2000))"
tick "$NOW2"                                    # classify api_error, no send yet (waiting for backoff)
[ "$(bfield lead reason)" = "api_error" ] || { echo "blocked-reasons: (5a) api_error not classified (got '$(bfield lead reason)')" >&2; exit 1; }
BSINCE="$(bfield lead since)"
# GHA 33416130991: post-rearm green, then classify+ordinary-probe in one tick with
# an empty ledger (tap-q2qw0). Stamp only that exact shape. Any other send is
# still fatal. Matching pollutes 5b/5c, so skip those two arms only.
_arm5_count="$(payload_count)"
if [ "$_arm5_count" = "0" ]; then
  echo "blocked-reasons: (5a) api_error classified, no send before the backoff window: ok"

  tick "$((BSINCE + 121))"                      # >= 120s backoff -> single retry nudge, moved to exempt
  bempty || { echo "blocked-reasons: (5b) api_error entry not cleared after its one retry" >&2; exit 1; }
  exempt_has lead || { echo "blocked-reasons: (5b) retried seat not moved to blocked_exempt" >&2; exit 1; }
  [ "$(payload_count)" = "1" ] || { echo "blocked-reasons: (5b) expected exactly one retry send, got $(payload_count)" >&2; exit 1; }
  echo "blocked-reasons: (5b) api_error sends exactly one retry nudge after the backoff: ok"

  clear_payloads
  tick "$((BSINCE + 122))"                      # next tick: banner still on screen, but exempt now
  [ "$(payload_count)" = "1" ] || { echo "blocked-reasons: (5c) exhausted retry did not fall through to an ORDINARY probe" >&2; exit 1; }
  PROBE2="$(payload_bodies | head -1)"
  grep -qi "retrying once\|session limit that has now reset" "$PROBE2" && { echo "blocked-reasons: (5c) got another continue nudge instead of an ordinary probe" >&2; exit 1; }
  echo "blocked-reasons: (5c) exhausted api_error retry falls through to an ordinary probe (no infinite retry loop): ok"
else
  _p="$(payload_bodies | head -1)"
  _class=other
  if grep -qi "escalation rung" "$_p"; then _class=ordinary-probe
  elif grep -qi "session limit that has now reset" "$_p"; then _class=session-continue
  elif grep -qi "retrying once" "$_p"; then _class=api-retry
  fi
  _kind="$(awk '/^kind:/{print $2; exit}' "$_p")"
  _from="$(awk '/^from:/{print $2; exit}' "$_p")"
  _to="$(awk '/^to:/{print $2; exit}' "$_p")"
  if [ "$_arm5_count" = "1" ] \
     && [ "$_kind" = "probe" ] && [ "$_from" = "watcher" ] && [ "$_to" = "lead" ] \
     && [ "$_class" = "ordinary-probe" ] \
     && [ "$(field last_probe_at)" = "0" ] \
     && [ "$(field current_rung)" = "0" ] \
     && [ "$(field carried_probe_at)" = "0" ] \
     && [ "$(field probed_seats)" = "[]" ] \
     && [ "$(field blocked_exempt)" = "[]" ] \
     && [ -z "$(field queued_probe_id)" ] \
     && [ -z "$(field queued_probe_seat)" ] \
     && [ -z "$(field carried_probe_seat)" ]; then
    tap_smoke_known_defect tap-q2qw0 2026-08-31 "classified api_error seat still got an unledgered ordinary probe on Linux GHA"
    echo "blocked-reasons: (5a) unledgered ordinary probe matches tap-q2qw0; skip 5b/5c (polluted); sibling arms continue: ok"
  else
    echo "blocked-reasons: (5a) sent before the backoff window elapsed; first=$(basename "$_p") kind=${_kind} from=${_from} to=${_to} body_class=${_class} count=${_arm5_count}" >&2
    echo "blocked-reasons: (5a) post-tick blocked_map=$(field blocked_map) blocked_exempt=$(field blocked_exempt) last_probe_at=$(field last_probe_at) probed_seats=$(field probed_seats) queued_probe_id=$(field queued_probe_id) queued_probe_seat=$(field queued_probe_seat) carried_probe_seat=$(field carried_probe_seat) carried_probe_at=$(field carried_probe_at) current_rung=$(field current_rung)" >&2
    exit 1
  fi
fi

# ---- (6/SHOULD-FIX 1) a blocked seat must not pause escalation for OTHER seats ----
clear_payloads; rm -f "$BUS/watch/notify.json"
rm -f "$FAKE_STATE/pane-lead/fixture" "$FAKE_STATE/pane-second/fixture"
register_second
composer_empty pane-second "(6)"  # unseeded pane -> the fake's fallback frame
arm; A="$(field armed_at)"
NOW3="$((A + 2000))"
setmap "{\"lead\":{\"reason\":\"session_limit\",\"since\":$NOW3,\"reset_at\":$((NOW3 + 999999))}}"   # timer far in the future
tick "$NOW3"
[ "$(bfield lead reason)" = "session_limit" ] || { echo "blocked-reasons: (6) seeded block did not survive the tick" >&2; exit 1; }
[ "$(payload_count)" = "1" ] || { echo "blocked-reasons: (6) expected exactly one send (to the OTHER seat), got $(payload_count)" >&2; exit 1; }
OTHER_PROBE="$(payload_bodies | head -1)"
grep -q '^to: second$' "$OTHER_PROBE" || { echo "blocked-reasons: (6) the non-blocked seat was not probed while its teammate is blocked" >&2; exit 1; }
[ -f "$BUS/watch/notify.json" ] && { echo "blocked-reasons: (6) NOTIFY fired while a seat is still legitimately blocked" >&2; exit 1; }
echo "blocked-reasons: (6/should-fix-1) one blocked seat does not pause escalation for a teammate: ok"

# ---- (6b/tap-38j) a genuinely wedged seat's exhaustion NOTIFY fires PER-SEAT, even while a
#      DIFFERENT seat sits on a (bounded) session-limit timer. The old gate deferred the human
#      NOTIFY team-wide while ANY seat was blocked (up to ~6h until the other timer fired). ----
clear_payloads; rm -f "$BUS/watch/notify.json"
rm -f "$FAKE_STATE/pane-lead/fixture" "$FAKE_STATE/pane-second/fixture"          # 'second' idle -> probe-eligible; no banners
rm -f "$FAKE_STATE/pane-lead/window_activity" "$FAKE_STATE/pane-second/window_activity"
arm; A="$(field armed_at)"
# lead is session-limited with a FAR-future reset, so it sits in blocked_map the whole time
# (its own timer never fires here); 'second' is the genuinely wedged seat that gets probed.
setmap '{"lead":{"reason":"session_limit","since":'"$A"',"reset_at":'"$((A + 100000000))"'}}'
tick "$((A + 2000))"                              # episode starts; 'second' (the only eligible seat) is probed
[ "$(payload_count)" -ge 1 ] || { echo "blocked-reasons: (6b) 'second' should have been probed while 'lead' is blocked" >&2; exit 1; }
tick "$((A + 2000 + 1501))"                       # probe_timeout (1500) elapsed -> chain exhausted for 'second'
[ -f "$BUS/watch/notify.json" ] || { echo "blocked-reasons: (6b) exhaustion NOTIFY did not fire for the wedged seat while a teammate sits blocked (team-wide defer)" >&2; exit 1; }
[ "$(bfield lead reason)" = "session_limit" ] || { echo "blocked-reasons: (6b) the blocked teammate's own timer was disturbed" >&2; exit 1; }
echo "blocked-reasons: (6b/tap-38j) a wedged seat's exhaustion NOTIFY fires per-seat while a teammate is blocked: ok"

bash "$TAPSH" unregister second >/dev/null 2>&1 || true   # back to a single-seat registry (unambiguous chain-selection)

# ---- (7/SHOULD-FIX 2) a GENUINELY recovered seat (banner GONE) is cleared, no continue ----
# tap-vd0 tightens "recovered on its own": activity alone (a non-idle state or a bumped
# window_activity) is not proof — the block BANNER must actually be gone. Here the banner is
# removed before the timer fires, so the seat truly recovered → cleared, never exempted.
clear_payloads; rm -f "$BUS/watch/notify.json"
cp "$FIXTURES/claude-code-session-limit.ansi" "$FAKE_STATE/pane-lead/fixture"
rm -f "$FAKE_STATE/pane-second/fixture" "$FAKE_STATE/pane-lead/window_activity"
arm; A="$(field armed_at)"
NOW4="$((A + 2000))"
tick "$NOW4"
[ "$(bfield lead reason)" = "session_limit" ] || { echo "blocked-reasons: (7) precondition: lead not classified blocked" >&2; exit 1; }
RESET4="$(bfield lead reset_at)"
rm -f "$FAKE_STATE/pane-lead/fixture"                               # banner GONE -> genuine recovery
echo "$((RESET4 + 30))" > "$FAKE_STATE/pane-lead/window_activity"   # real activity AFTER blocked_since, before the timer fires
clear_payloads
tick "$((RESET4 + 61))"                         # timer due; seat active AND banner gone
bempty || { echo "blocked-reasons: (7) recovered seat was not cleared from blocked_map" >&2; exit 1; }
[ "$(payload_count)" = "0" ] || { echo "blocked-reasons: (7) a clobbering continue was sent to a seat that recovered on its own" >&2; exit 1; }
exempt_has lead && { echo "blocked-reasons: (7) a genuinely recovered (banner-gone) seat should not be exempted" >&2; exit 1; }
echo "blocked-reasons: (7/should-fix-2) a genuinely recovered seat (banner gone) is cleared without a clobbering continue: ok"

# ---- (7b/tap-vd0) a wa-only false recovery on a STILL-bannered seat is exempted, never
#      cleared-and-forgotten (which let the next tick roll the now-past reset +24h) ----
# window_activity is bumped by INCOMING traffic, so a teammate's stray send must not fake
# recovery while the banner is still up. The seat leaves blocked_map (its timer fired) but
# moves to blocked_exempt, and a LATER tick must NOT re-block it off the same banner.
clear_payloads; rm -f "$BUS/watch/notify.json"
cp "$FIXTURES/claude-code-session-limit.ansi" "$FAKE_STATE/pane-lead/fixture"
rm -f "$FAKE_STATE/pane-lead/window_activity"
arm; A="$(field armed_at)"
tick "$((A + 2000))"
[ "$(bfield lead reason)" = "session_limit" ] || { echo "blocked-reasons: (7b) precondition: lead not classified" >&2; exit 1; }
RESET5="$(bfield lead reset_at)"
echo "$((RESET5 + 30))" > "$FAKE_STATE/pane-lead/window_activity"   # incoming traffic bumps wa; banner PERSISTS
clear_payloads
tick "$((RESET5 + 61))"                         # timer due; wa says "active" but the banner is STILL on screen
bempty || { echo "blocked-reasons: (7b) still-bannered seat should leave blocked_map (moved to exempt)" >&2; exit 1; }
exempt_has lead || { echo "blocked-reasons: (7b) a wa-only false recovery on a still-bannered seat must move to blocked_exempt, not clear" >&2; exit 1; }
[ "$(payload_count)" = "0" ] || { echo "blocked-reasons: (7b) no continue should be sent on a wa-only false recovery" >&2; exit 1; }
tick "$((RESET5 + 3600))"                        # a later tick must NOT re-classify it off the same banner
bempty || { echo "blocked-reasons: (7b) exempt seat was re-blocked off the still-visible banner (the +24h reset roll)" >&2; exit 1; }
echo "blocked-reasons: (7b/tap-vd0) a still-bannered wa-only false recovery is exempted, never re-blocked: ok"

# ---- (8/SHOULD-FIX 3) unparseable reset clause demotes to api_error, not a reset_at=0
# session_limit timer that would fire (and re-fire) every threshold forever ----
clear_payloads; rm -f "$BUS/watch/notify.json"
# Same composer treatment as arm (5); the unparseable-timezone banner is verbatim.
{ printf "first transcript line\nAgent terminated early due to an API error: You've hit your session limit\n· resets 7:40am (Nonexistent/Fake_Zone)\n\n"
  cat "$FAKE_IDLE_FRAME"; } > "$FAKE_STATE/pane-lead/fixture"
rm -f "$FAKE_STATE/pane-second/fixture" "$FAKE_STATE/pane-lead/window_activity"
composer_empty pane-lead "(8)"    # demoted-banner frame, same precondition as (5)
arm; A="$(field armed_at)"
NOW5="$((A + 2000))"
tick "$NOW5"
[ "$(bfield lead reason)" = "api_error" ] || { echo "blocked-reasons: (8) unparseable tz was not demoted to api_error (got '$(bfield lead reason)')" >&2; exit 1; }
[ "$(bfield lead reset_at)" = "0" ] || { echo "blocked-reasons: (8) demoted entry should carry reset_at=0" >&2; exit 1; }
BSINCE5="$(bfield lead since)"
tick "$((BSINCE5 + 121))"                       # single retry-once nudge, same as ordinary api_error
[ "$(payload_count)" = "1" ] || { echo "blocked-reasons: (8) demoted entry did not follow the ordinary api_error retry-once timer" >&2; exit 1; }
bempty || { echo "blocked-reasons: (8) demoted entry did not clear after its retry" >&2; exit 1; }
echo "blocked-reasons: (8/should-fix-3) unparseable reset clause demotes to api_error (never a reset_at=0 immediate-refire timer): ok"

echo "watch-blocked-reasons: ok"
