#!/usr/bin/env bash
# turn-unconfirmed.test.sh — F4 §3.1/§3.2 (ratified 2026-07-28 as Option 3 "Honest
# Weaker Receipts"; unimplemented until tap-dnub). An exit-0 send must report the
# CEILING of what the courier observed, not the delivery a reader infers from it.
#
# WHY THIS IS A GATE ARM AND NOT DECORATION. On 2026-08-19 four sends to one seat
# carried `.placed` AND `.sent`, `error_class` none on all four, and a
# `capture-pane -S -3000` grep for each sentinel id returned zero matches. The
# receipts were TRUE — the courier did place and did submit — and the messages were
# never read. `tap_submit_verify` verifies exactly that the minted id left the input
# band; the reviewer's audit found post-submit turn-boundary tokens on 0 of 6 harnesses,
# so nothing in the fleet can attest a turn began. The stamp is the standing
# correction, and a stamp nobody checks decays into a comment.
#
# Sibling: exit-5-pending.test.sh pins the SAME fixture's submit-unverified exit and
# asserts `.sent` is absent there. Together they cover both sides of one branch:
# no `.sent` means no claim to qualify; `.sent` means the claim is qualified.
#
# Asserts:
#   (t-rc)    a clearing pane submit exits 0 and writes .sent
#   (t-recpt) the .sent receipt itself carries turn=unconfirmed
#   (t-json)  --json injected/pane shape carries turn=unconfirmed
#   (t-human) the human send receipt is disposition/id/to/reply only; F4 §3.2
#             wording is not on send stdout (it stays on outstanding + reply)
#   (t-out)   tap outstanding prints the legend once, and --json marks the row
#   (t-once)  the legend is a legend: printed ONCE for two outstanding sends
#   (t-poll)  a POLL-only listing never claims a pane was touched, and its --json
#             row still carries turn=unconfirmed
#   (t-spool) the THIRD exit-0 disposition (queued/spool) carries the stamp too
#   (t-reply) tap reply — the dominant send surface — carries the wording too
#   (t-reply-presettled-queued) the absence pin: a presettled QUEUED reply — the one
#             branch that interpolates the qualifier and can be queued — never claims a pane
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh

# tap-7r3fn.20: this fixture is about the unconfirmed-turn receipt text and sends
# repeatedly to one seat, so every send after the first would park in that seat's
# window instead of reaching the receipt under test.
# A window of zero is the seam that turns it off (ruling 24 keeps this variable
# overriding the short window), and it says so without knowing where the clock
# is stored — unlike deleting the clock directory by hand.
export TAP_AUTOSETTLE_HOLD_SECONDS=0

# Queued arms assert receipts and parked bodies, not asynchronous drain. Keep
# unused workers from racing bus cleanup; courier-busy-hold arms (7)/(8) own
# production waiter delivery and lease coverage.
export TAP_SPOOL_DISABLE_DELIVERER=1

. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"
FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "${WORK:?}"; rm -rf "${FAKE_BIN:?}"' EXIT
TAP_HOME="$WORK/repo/.tap/bus"
export TAP_HOME
# Enroll a bus the production way: the acting registry is
# <root>/.tap/team-registry.json (native derives the team root from it) and the
# bus path the fixture writes links to it, so reply runs natively under a live marker.
enroll() { # <root> <team>
  mv "$1/.tap/bus/registry.json" "$1/.tap/team-registry.json"
  ln -s ../team-registry.json "$1/.tap/bus/registry.json"
  mkdir -p "$TAP_INDEX_HOME"
  python3 -B -c 'import json, os, sys
root, team, path = sys.argv[1:4]
doc = json.load(open(path)) if os.path.exists(path) else {"schema": "0.20", "teams": {}}
doc["teams"][team] = {"root": root, "registry_location": root + "/.tap/team-registry.json", "state": "registered"}
json.dump(doc, open(path, "w"))' "$(cd "$1" && pwd -P)" "$2" "$TAP_INDEX_HOME/global-registry.json"
}

mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"
cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": { "name": "testteam" },
  "seats": {
    "claude": { "session": "testteam/claude", "pane": "sender-pane", "pane_id": "%11", "server_epoch": "srv:1:1", "harness": "codex", "status": "active" },
    "codex": { "session": "testteam/codex", "pane": "fake-pane", "pane_id": "%12", "server_epoch": "srv:1:1", "harness": "codex", "status": "active" }
  }
}
JSON
enroll "$WORK/repo" testteam

# --- fake tmux: idle prompt, sentinel lands, Enter CLEARS it (the happy path) ---
# Deliberately the exit-5-pending fixture with FAKE_TMUX_STUCK_SUBMIT left off, so
# this arm rides a submit that genuinely reaches exit 0 rather than a mock rigged
# to produce the receipt under test.
cat > "$FAKE_BIN/tmux" <<'ENDTMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"
mkdir -p "$state"
cmd="${1:-}"; shift || true
case "$cmd" in
  list-sessions) printf 'testteam/claude\t1:1\ntestteam/codex\t1:1\n' ;;
  list-panes)
    target=""; while [ "$#" -gt 0 ]; do case "$1" in -t) target="${2#=}"; shift 2 ;; *) shift ;; esac; done
    case "$target" in testteam/claude) printf 'testteam/claude\tsender-pane\t%%11\tcodex\t4242\t1:1\t0\n' ;; testteam/codex) printf 'testteam/codex\tfake-pane\t%%12\tcodex\t4242\t1:1\t0\n' ;; esac ;;
  display-message)
    fmt=""; target=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -p) shift ;;
        -t) target="${2:-}"; shift 2 ;;
        *)  fmt="$1"; shift ;;
      esac
    done
    case "$fmt" in
      '#{pid}:#{start_time}') printf '1:1\n' ;;
      *pane_id*session_name*pane_pid*pane_current_command*)
        case "$target" in sender-pane|%11) printf '%%11\ttestteam/claude\t4242\tcodex\t0\n' ;; *) printf '%%12\ttestteam/codex\t4242\tcodex\t0\n' ;; esac ;;
      *pane_id*)              case "$target" in sender-pane|%11) echo '%11' ;; *) echo '%12' ;; esac ;;
      *pane_in_mode*)         echo "0" ;;
      *pane_current_command*) echo "codex" ;;
      *)                      echo "" ;;
    esac ;;
  capture-pane)
    # A band-less pane (mid-turn / modal): the courier defers and the send parks in
    # the spool. That is the THIRD exit-0 disposition, and the only way to reach it.
    [ "${FAKE_TMUX_MIDTURN:-0}" = 1 ] && { echo "esc to interrupt"; exit 0; }
    prompt="›"
    if [ -f "$state/input" ]; then
      printf '%s %s\n' "$prompt" "$(cat "$state/input")"
    else
      printf '%s \n' "$prompt"
    fi ;;
  send-keys)
    if [ "${1:-}" = "-t" ]; then shift 2; fi
    if [ "${1:-}" = "-l" ]; then
      shift
      [ "${1:-}" = "--" ] && shift
      printf '%s' "${1:-}" > "$state/input"
      exit 0
    fi
    [ "${1:-}" = "Enter" ] && rm -f "$state/input"
    ;;
esac
ENDTMUX
chmod +x "$FAKE_BIN/tmux"

export PATH="$FAKE_BIN:$PATH"
export FAKE_TMUX_STATE="$TAP_HOME/fake-tmux"
export TAP_TUI_SETTLE_SCALE=0.1

payload="$TAP_HOME/valid.md"
cat > "$payload" <<'EOF'
---
from: claude
to: codex
kind: discuss
---

hello
EOF

# --- (t-rc) / (t-json) machine surface -----------------------------------------
_rc=0
"$TAP" send codex "$payload" --from claude --ask --pane fake-pane --json \
  >"$TAP_HOME/j.out" 2>"$TAP_HOME/j.err" || _rc="$?"
[ "$_rc" = "0" ] || {
  echo "turn-unconfirmed: (t-rc) expected exit 0, got $_rc" >&2
  cat "$TAP_HOME/j.out" "$TAP_HOME/j.err" >&2; exit 1
}
id_a="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <"$TAP_HOME/j.out")"
[ -f "$TAP_HOME/receipts/$id_a.sent" ] || {
  echo "turn-unconfirmed: (t-rc) exit 0 wrote no .sent receipt for $id_a" >&2; exit 1
}
echo "turn-unconfirmed: (t-rc) clearing submit exits 0 and writes .sent: ok"

python3 -c 'import json,sys
d=json.load(sys.stdin)
assert d["status"]=="injected" and d["delivery"]=="pane", d
assert d.get("turn")=="unconfirmed", ("F4 3.1: injected/pane --json must carry turn=unconfirmed", d)
' <"$TAP_HOME/j.out" || { echo "turn-unconfirmed: (t-json) FAILED" >&2; cat "$TAP_HOME/j.out" >&2; exit 1; }
echo "turn-unconfirmed: (t-json) injected/pane --json carries turn=unconfirmed: ok"

# (t-recpt) THE RECEIPT ITSELF, not just the stdout the caller happened to see.
# The stdout line is gone the moment the sender's turn ends; the receipt is what a
# later supervisor reads, and it is the artifact that said "delivered" for the four
# specimens. A mutation that stamped only stdout would leave the durable record
# claiming exactly what it claimed on 2026-08-19.
python3 -c 'import json,sys
d=json.load(sys.stdin)
assert d.get("turn")=="unconfirmed", ("F4 3.1: the .sent receipt must carry turn=unconfirmed", d)
' <"$TAP_HOME/receipts/$id_a.sent" || {
  echo "turn-unconfirmed: (t-recpt) FAILED" >&2; cat "$TAP_HOME/receipts/$id_a.sent" >&2; exit 1; }
echo "turn-unconfirmed: (t-recpt) the durable .sent receipt carries turn=unconfirmed: ok"

# --- (t-human) the wording a person actually reads ------------------------------
# An injecting send (`--ask`) names disposition, id, destination, and reply
# obligation. F4 §3.2 stays on outstanding (t-out) and reply (t-reply), not on
# this line. A plain send is settle-only and parks (tap-gyc91).
_rc=0
"$TAP" send codex "$payload" --from claude --ask --pane fake-pane \
  >"$TAP_HOME/h.out" 2>"$TAP_HOME/h.err" || _rc="$?"
[ "$_rc" = "0" ] || { echo "turn-unconfirmed: (t-human) expected exit 0, got $_rc" >&2; cat "$TAP_HOME/h.err" >&2; exit 1; }
grep -Eq '^tap send: ok .+$' "$TAP_HOME/h.out" || {
  echo "turn-unconfirmed: (t-human) pane receipt is not the short injected line" >&2
  echo "--- stdout ---" >&2; cat "$TAP_HOME/h.out" >&2
  echo "--- stderr ---" >&2; cat "$TAP_HOME/h.err" >&2
  exit 1
}
if grep -Fq 'submitted to pane; recipient seat-side processing unverified' "$TAP_HOME/h.out" "$TAP_HOME/h.err"; then
  echo "turn-unconfirmed: (t-human) send stdout/stderr still carries F4 3.2 wording" >&2
  echo "--- stdout ---" >&2; cat "$TAP_HOME/h.out" >&2
  echo "--- stderr ---" >&2; cat "$TAP_HOME/h.err" >&2
  exit 1
fi
echo "turn-unconfirmed: (t-human) pane send receipt is the short injected line: ok"

# --- (t-out) the supervision surface -------------------------------------------
_rc=0
"$TAP" outstanding claude >"$TAP_HOME/o.out" 2>"$TAP_HOME/o.err" || _rc="$?"
[ "$_rc" = "0" ] || { echo "turn-unconfirmed: (t-out) expected outstanding rc 0, got $_rc" >&2; cat "$TAP_HOME/o.out" "$TAP_HOME/o.err" >&2; exit 1; }
grep -Fq 'submitted to pane; recipient seat-side processing unverified' "$TAP_HOME/o.out" || {
  echo "turn-unconfirmed: (t-out) tap outstanding omitted the F4 3.2 legend" >&2
  cat "$TAP_HOME/o.out" >&2; exit 1
}
echo "turn-unconfirmed: (t-out) tap outstanding displays the F4 3.2 legend: ok"

_rc=0
"$TAP" outstanding claude --json >"$TAP_HOME/oj.out" 2>/dev/null || _rc="$?"
python3 -c 'import json,sys
d=json.load(sys.stdin)
rows=d["outstanding"]
assert rows, d
for r in rows:
    assert r.get("turn")=="unconfirmed", ("every .sent row must be marked", r)
' <"$TAP_HOME/oj.out" || { echo "turn-unconfirmed: (t-out) --json row marking FAILED" >&2; cat "$TAP_HOME/oj.out" >&2; exit 1; }
echo "turn-unconfirmed: (t-out) --json marks every injected row turn=unconfirmed: ok"

# (t-once) A LEGEND, NOT A PER-ROW SUFFIX. Two outstanding sends exist by now, so a
# per-row implementation prints twice and this arm reds. That distinction is the
# whole reason the line is not a CONDITION: conditions are counted into the
# "N outstanding send(s)" headline, so a per-send one would have every ordinary
# send inflating its own alarm count — an alarm that fires on everything is the
# failure mode this bead exists to end, rebuilt one layer up.
_legend_n="$(grep -Fc 'submitted to pane; recipient seat-side processing unverified' "$TAP_HOME/o.out" | tr -d '[:space:]')"
[ "$_legend_n" = "1" ] || {
  echo "turn-unconfirmed: (t-once) legend printed $_legend_n times across 2 outstanding sends; expected exactly 1" >&2
  cat "$TAP_HOME/o.out" >&2; exit 1
}
echo "turn-unconfirmed: (t-once) legend printed exactly once for two outstanding sends: ok"

# --- (t-reply) the DOMINANT send surface must carry the same qualifier ------------
# Reply prints its own line, and reply is the surface a working team actually
# reads: a contract enforced on every surface except its highest-traffic one is
# not enforced (review gate). Native reply's verbose receipt names the pane
# delivery and qualifies it as unconfirmed recipient processing.
_rc=0
TAP_VERBOSE=1 TAP_SELF=codex "$TAP" reply "$id_a" -m "ack" >"$TAP_HOME/rp.out" 2>"$TAP_HOME/rp.err" || _rc="$?"
[ "$_rc" = "0" ] || { echo "turn-unconfirmed: (t-reply) expected exit 0, got $_rc" >&2; cat "$TAP_HOME/rp.out" "$TAP_HOME/rp.err" >&2; exit 1; }
grep -Fq 'outbound delivered to pane' "$TAP_HOME/rp.out" "$TAP_HOME/rp.err" || {
  echo "turn-unconfirmed: (t-reply) arm did not reach the injected reply branch — it would pass vacuously" >&2
  cat "$TAP_HOME/rp.out" "$TAP_HOME/rp.err" >&2; exit 1; }
grep -Fq 'recipient processing unconfirmed' "$TAP_HOME/rp.out" "$TAP_HOME/rp.err" || {
  echo "turn-unconfirmed: (t-reply) the reply receipt omitted the unconfirmed-processing qualifier" >&2
  echo "--- stdout ---" >&2; cat "$TAP_HOME/rp.out" >&2
  echo "--- stderr ---" >&2; cat "$TAP_HOME/rp.err" >&2
  exit 1
}
echo "turn-unconfirmed: (t-reply) tap reply qualifies the injected branch as unconfirmed: ok"

# --- (t-reply-presettled-queued) the ABSENCE pin reply was missing ----------------
# `(t-reply)` proves the sentence APPEARS on the injected branch. Nothing proved it
# stays OFF a branch where no pane was touched — so the gate made `_reply_turn`
# UNCONDITIONAL (the literal trap the variable exists to avoid) and the whole suite
# stayed GREEN.
#
# The reachable form of that defect is narrower than it first looks, and the arm has
# to match it or it pins nothing. The plain `queued` reply branch never interpolates
# the variable at all, so an unconditional variable is invisible there — an arm built
# on that path passes under the mutation and would be a placebo. The ONE branch
# that both interpolates the variable and can be reached with a queued disposition is
# PRESETTLED, because `PRESETTLED` is evaluated BEFORE `SEND_STATUS`. That is exactly
# why the qualifier is a variable rather than a literal, and it is the shape this arm
# reproduces.
#
# PRESETTLED means the courier already auto-settled the inbound when its digest
# landed: a `.done` receipt carrying `via: courier-auto`. Mid-turn pane -> defer ->
# spool gives the queued disposition on top of it.
RQ_HOME="$WORK/rq/.tap/bus"
mkdir -p "$RQ_HOME/payloads" "$RQ_HOME/receipts"
sed 's/"name": "testteam"/"name": "rqteam"/' "$TAP_HOME/registry.json" > "$RQ_HOME/registry.json"
enroll "$WORK/rq" rqteam
cp "$payload" "$RQ_HOME/valid.md"
rq_id="$(TAP_HOME="$RQ_HOME" FAKE_TMUX_STATE="$RQ_HOME/fake-tmux" \
  "$TAP" send codex "$RQ_HOME/valid.md" --from claude --ask --pane fake-pane --json 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
[ -n "$rq_id" ] || { echo "turn-unconfirmed: (t-reply-presettled-queued) setup send produced no id" >&2; rm -rf "${RQ_HOME:?}"; exit 1; }
printf '{"id":"%s","via":"courier-auto"}\n' "$rq_id" > "$RQ_HOME/receipts/$rq_id.done"
_rc=0
TAP_HOME="$RQ_HOME" FAKE_TMUX_STATE="$RQ_HOME/fake-tmux" FAKE_TMUX_MIDTURN=1 TAP_VERBOSE=1 TAP_SELF=codex \
  "$TAP" reply "$rq_id" -m "ack" >"$RQ_HOME/rq.out" 2>"$RQ_HOME/rq.err" || _rc="$?"
[ "$_rc" = "0" ] || { echo "turn-unconfirmed: (t-reply-presettled-queued) expected exit 0, got $_rc" >&2; cat "$RQ_HOME/rq.out" "$RQ_HOME/rq.err" >&2; rm -rf "${RQ_HOME:?}"; exit 1; }
# Refuse to pass vacuously, TWICE OVER: the arm is worthless unless it reached BOTH the
# presettled branch and a queued disposition. Assert each before asserting the absence.
grep -Fq 'already settled by the courier' "$RQ_HOME/rq.out" "$RQ_HOME/rq.err" || {
  echo "turn-unconfirmed: (t-reply-presettled-queued) never reached the PRESETTLED branch — would pass vacuously" >&2
  cat "$RQ_HOME/rq.out" "$RQ_HOME/rq.err" >&2; rm -rf "${RQ_HOME:?}"; exit 1; }
# The disposition is asserted from the SPOOL, not from the prose: the presettled
# branch's sentence legitimately never contains the word "queued", so grepping for it
# was a guard that could not pass — a check that cannot succeed is the same failure as
# one that cannot fail, and it caught itself here only because the guard ran
# before the assertion it was protecting. A spooled outbound is also the direct
# evidence the arm actually wants: the courier parked it and touched no pane.
[ -n "$(find "$RQ_HOME/spool" -maxdepth 1 -name '*.md' 2>/dev/null | head -1)" ] || {
  echo "turn-unconfirmed: (t-reply-presettled-queued) outbound was not spooled — a pane branch would pass this trivially" >&2
  cat "$RQ_HOME/rq.out" "$RQ_HOME/rq.err" >&2; rm -rf "${RQ_HOME:?}"; exit 1; }
if grep -Fq 'submitted to pane' "$RQ_HOME/rq.out" "$RQ_HOME/rq.err"; then
  echo "turn-unconfirmed: (t-reply-presettled-queued) a presettled QUEUED reply claimed a pane was touched" >&2
  cat "$RQ_HOME/rq.out" "$RQ_HOME/rq.err" >&2; rm -rf "${RQ_HOME:?}"; exit 1
fi
rm -rf "${RQ_HOME:?}"
echo "turn-unconfirmed: (t-reply-presettled-queued) a presettled queued reply never claims a pane: ok"

# --- (t-poll) the poll path must not inherit the pane sentence -------------------
# Poll delivery writes `.sent` at the SAME site as a pane inject, so a legend gated
# on "any `.sent` exists" prints "submitted to pane" over a listing where no pane was
# ever touched. The send path already withholds that sentence from the poll receipt;
# this arm is what stops the supervision surface from undoing that cut one file over.
# A fresh sandbox is required: with a pane row present the legend is CORRECT, so the
# bug is only reachable on a poll-ONLY listing (review, unit-1 review).
POLL_HOME="$(mktemp -d)"
mkdir -p "$POLL_HOME/payloads" "$POLL_HOME/receipts"
cat > "$POLL_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": { "name": "testteam" },
  "seats": {
    "claude": { "session": "testteam/claude", "pane": "sender-pane", "pane_id": "%11", "server_epoch": "srv:1:1", "harness": "codex", "status": "active" },
    "pollbot": { "delivery": "poll", "harness": "hermes-gw", "status": "active" }
  }
}
JSON
poll_payload="$POLL_HOME/valid.md"
cat > "$poll_payload" <<'EOF'
---
from: claude
to: pollbot
kind: discuss
---

hello
EOF
_rc=0
TAP_HOME="$POLL_HOME" "$TAP" send pollbot "$poll_payload" --from claude --json \
  >"$POLL_HOME/pj.out" 2>"$POLL_HOME/pj.err" || _rc="$?"
[ "$_rc" = "0" ] || { echo "turn-unconfirmed: (t-poll) poll send expected exit 0, got $_rc" >&2; cat "$POLL_HOME/pj.out" "$POLL_HOME/pj.err" >&2; rm -rf "${POLL_HOME:?}"; exit 1; }
python3 -c 'import json,sys
d=json.load(sys.stdin)
assert d["delivery"]=="poll", d
assert d.get("turn")=="unconfirmed", ("F4 3.1 stamps the poll shape too", d)
' <"$POLL_HOME/pj.out" || { echo "turn-unconfirmed: (t-poll) poll --json turn stamp FAILED" >&2; cat "$POLL_HOME/pj.out" >&2; rm -rf "${POLL_HOME:?}"; exit 1; }
echo "turn-unconfirmed: (t-poll) poll --json carries turn=unconfirmed: ok"

if grep -Fq 'submitted to pane' "$POLL_HOME/pj.out" "$POLL_HOME/pj.err"; then
  echo "turn-unconfirmed: (t-poll) the poll SEND receipt claimed a pane was touched" >&2
  cat "$POLL_HOME/pj.out" "$POLL_HOME/pj.err" >&2; rm -rf "${POLL_HOME:?}"; exit 1
fi

_rc=0
TAP_HOME="$POLL_HOME" "$TAP" outstanding claude >"$POLL_HOME/po.out" 2>/dev/null || _rc="$?"
[ "$_rc" = "0" ] || { echo "turn-unconfirmed: (t-poll) expected outstanding rc 0, got $_rc" >&2; cat "$POLL_HOME/po.out" >&2; rm -rf "${POLL_HOME:?}"; exit 1; }
# Exit 0 also covers an empty listing, so the pollbot row is what keeps this arm from passing vacuously.
grep -q 'pollbot' "$POLL_HOME/po.out" || { echo "turn-unconfirmed: (t-poll) outstanding did not list the send to pollbot; the arm would pass vacuously" >&2; cat "$POLL_HOME/po.out" >&2; rm -rf "${POLL_HOME:?}"; exit 1; }
if grep -Fq 'submitted to pane' "$POLL_HOME/po.out"; then
  echo "turn-unconfirmed: (t-poll) a POLL-ONLY outstanding listing claimed a pane was touched" >&2
  cat "$POLL_HOME/po.out" >&2; rm -rf "${POLL_HOME:?}"; exit 1
fi
rm -rf "${POLL_HOME:?}"
echo "turn-unconfirmed: (t-poll) poll-only listing never claims a pane was touched: ok"

# --- (t-spool) the THIRD exit-0 disposition ---------------------------------------
# CONTRACT says every exit-0 `tap send --json` carries the stamp. There are three
# exit-0 dispositions, not two: `injected`/`pane`, `queued`/`poll`, and
# `queued`/`spool`. The spool exit returns BEFORE the `.sent` write site, so it was
# the one path where the stamp appeared nowhere while the contract said "every" — an
# emitted string claiming more than the code delivered, in the contract file, one
# bullet below the fix for exactly that (review finding). Enforced here so
# the corrected sentence is a checked property rather than a nicer assertion.
SPOOL_HOME="$(mktemp -d)"
mkdir -p "$SPOOL_HOME/payloads" "$SPOOL_HOME/receipts"
cp "$TAP_HOME/registry.json" "$SPOOL_HOME/registry.json"
cp "$payload" "$SPOOL_HOME/valid.md"
_rc=0
TAP_HOME="$SPOOL_HOME" FAKE_TMUX_STATE="$SPOOL_HOME/fake-tmux" FAKE_TMUX_MIDTURN=1 \
  "$TAP" send codex "$SPOOL_HOME/valid.md" --from claude --ask --pane fake-pane --json \
  >"$SPOOL_HOME/s.out" 2>"$SPOOL_HOME/s.err" || _rc="$?"
[ "$_rc" = "0" ] || { echo "turn-unconfirmed: (t-spool) expected exit 0/queued, got $_rc" >&2; cat "$SPOOL_HOME/s.out" "$SPOOL_HOME/s.err" >&2; rm -rf "$SPOOL_HOME"; exit 1; }
python3 -c 'import json,sys
d=json.load(sys.stdin)
assert d["status"]=="queued" and d["delivery"]=="spool", ("arm did not reach the spool disposition", d)
assert d.get("turn")=="unconfirmed", ("the spool shape is an exit-0 send and CONTRACT says every one is stamped", d)
' <"$SPOOL_HOME/s.out" || { echo "turn-unconfirmed: (t-spool) FAILED" >&2; cat "$SPOOL_HOME/s.out" >&2; rm -rf "$SPOOL_HOME"; exit 1; }
rm -rf "$SPOOL_HOME"
echo "turn-unconfirmed: (t-spool) the spool exit-0 shape carries turn=unconfirmed: ok"

echo "turn-unconfirmed: ok"
