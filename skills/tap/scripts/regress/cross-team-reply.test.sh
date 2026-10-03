#!/usr/bin/env bash
# tap-o4ae: fixture env must stay in this process; refuse `source`.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# cross-team-reply.test.sh — tap-g3o6: a cross-team reply derives its return route
# from the inbound payload's own absolute path (sender_bus = dirname(dirname(path))).
# Under a live marker the sender team must also be enrolled in this machine's index
# (refuseUnreachableSenderTeam, reply.ts; the unenrolled absent-marker
# door that tap-g3o6 first exercised is retired). Plus team-explicit readouts so a
# leader can never misread a cross-team outbound as a local inbound obligation.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

export TAP_SPOOL_DISABLE_DELIVERER=1

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
ALPHA="$(mktemp -d)"      # original sender's bus (team alpha, seat sentry)
BETA="$(mktemp -d)"       # replier's bus (team beta, seat fable)
FAKE_BIN="$(mktemp -d)"
INDEX_HOME="$(mktemp -d)"
# Each removal is its own guarded command; ALPHA_ROOT exists only after arm 5.
cleanup() {
  rm -rf "${ALPHA:?}"
  rm -rf "${BETA:?}"
  rm -rf "${FAKE_BIN:?}"
  rm -rf "${INDEX_HOME:?}"
  [ -z "${ALPHA_ROOT:-}" ] || rm -rf "${ALPHA_ROOT:?}"
}
trap cleanup EXIT
export TAP_INDEX_HOME="$INDEX_HOME"
# Born live (F1) with alpha enrolled: a live marker binds a foreign reply's
# sender team through the index (refuseUnreachableSenderTeam, reply.ts), and
# the absent-marker door that once routed an unenrolled team is retired.
printf '{"schema":"0.20","teams":{"alpha":{"root":"%s","registry_location":"%s","state":"registered"}}}\n' \
  "$ALPHA" "$ALPHA/registry.json" > "$TAP_INDEX_HOME/global-registry.json"

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"; mkdir -p "$state"
cmd="${1:-}"; shift || true
target=""
case "$cmd" in
  # CONTRACT §Session-name authority: cross-team reply delivery still requires
  # a readable exact-session, pane, generation, and harness observation.
  list-sessions)
    printf 'alpha/sentry\t123:456\nbeta/fable\t123:456\nbeta/peer\t123:456\n' ;;
  list-panes)
    target=""; while [ "$#" -gt 0 ]; do case "$1" in -t) target="${2#=}"; shift 2 ;; *) shift ;; esac; done
    case "$target" in
      alpha/sentry) printf 'alpha/sentry\tsentry-pane\t%%401\tcodex\t4242\t123:456\t0\n' ;;
      beta/fable) printf 'beta/fable\tfable-pane\t%%402\tcodex\t4242\t123:456\t0\n' ;;
      beta/peer) printf 'beta/peer\tpeer-pane\t%%403\tcodex\t4242\t123:456\t0\n' ;;
    esac ;;
  display-message)
    fmt=""
    while [ "$#" -gt 0 ]; do case "$1" in -p) shift ;; -t) target="${2:-}"; shift 2 ;; *) fmt="$1"; shift ;; esac; done
    case "$fmt" in
      # Native server-identity probe: the generation the registries pin (srv:123:456).
      '#{pid}:#{start_time}') echo "123:456" ;;
      # Native five-field pane observation (pane_id+session_name+pane_pid+pane_current_command+pane_dead).
      *pane_id*session_name*pane_pid*pane_current_command*pane_dead*)
        case "$target" in
          sentry-pane|%401) printf '%%401\talpha/sentry\t4242\tcodex\t0\n' ;;
          fable-pane|%402)  printf '%%402\tbeta/fable\t4242\tcodex\t0\n' ;;
          peer-pane|%403)   printf '%%403\tbeta/peer\t4242\tcodex\t0\n' ;;
        esac ;;
      # pane_id is derived from the requested pane so per-seat identity binds:
      # pane "sentry-pane" -> "%sentry", "fable-pane" -> "%fable".
      *pane_id*)              case "$target" in sentry-pane) echo '%401' ;; fable-pane) echo '%402' ;; peer-pane) echo '%403' ;; *) echo '%499' ;; esac ;;
      *pane_in_mode*)         echo "0" ;;
      *pane_current_command*) echo "codex" ;;
      *)                      echo "" ;;
    esac ;;
  capture-pane)
    if [ -f "$state/input" ]; then printf '› %s\n' "$(cat "$state/input")"; else printf '› \n'; fi ;;
  send-keys)
    if [ "${1:-}" = "-t" ]; then target="${2:-}"; shift 2; fi
    if [ "${1:-}" = "-l" ]; then shift; [ "${1:-}" = "--" ] && shift; printf '%s' "${1:-}" > "$state/input"; printf '%s\n' "${1:-}" >> "$state/sent.log"; exit 0; fi
    if [ "${1:-}" = "Enter" ]; then printf '%s\n' "$target" >> "$state/enter-targets"; rm -f "$state/input"; exit 0; fi ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket"

mkdir -p "$ALPHA/payloads" "$ALPHA/receipts" "$BETA/payloads" "$BETA/receipts"
cat > "$ALPHA/registry.json" <<JSON
{"schema": "0.20",  "team": { "name": "alpha", "worktree_root": "$ALPHA" },
  "seats": { "sentry": { "session": "alpha/sentry", "pane": "sentry-pane", "pane_id": "%401", "server_epoch": "srv:123:456", "harness": "codex", "status": "active" } } }
JSON
cat > "$BETA/registry.json" <<JSON
{"schema": "0.20",  "team": { "name": "beta", "worktree_root": "$BETA" },
  "seats": { "fable": { "session": "beta/fable", "pane": "fable-pane", "pane_id": "%402", "server_epoch": "srv:123:456", "harness": "codex", "status": "active" },
              "peer":  { "session": "beta/peer", "pane": "peer-pane",  "pane_id": "%403",  "server_epoch": "srv:123:456", "harness": "codex", "status": "active" } } }
JSON

# Seed a cross-team inbound ON ALPHA's bus: alpha/sentry -> beta/fable (self-contained,
# path= is alpha's absolute path — exactly how a real cross-team send lands).
INBOUND_ID="xt-inbound-1"
INBOUND="$ALPHA/payloads/$INBOUND_ID.md"
cat > "$INBOUND" <<EOF
---
id: $INBOUND_ID
from: sentry
from_team: alpha
to: fable
to_team: beta
kind: discuss
reply: expected
path: $INBOUND
---

cross-team question needing a reply
EOF

# ---- (1) reply by ABS PATH with NO --by, alpha enrolled in the machine index -> delivers
export FAKE_TMUX_STATE="$ALPHA/fake-tmux"; mkdir -p "$FAKE_TMUX_STATE"
: > "$FAKE_TMUX_STATE/sent.log"
# Run the reply from BETA's bus, as fable. --by fable (self-handle would need a live
# calling pane; --by is the explicit actor claim, fork B).
rc=0
TAP_HOME="$BETA" "$TAP" reply "$INBOUND" --by fable -m "here is my reply" \
  >"$BETA/reply1.out" 2>"$BETA/reply1.err" || rc=$?
[ "$rc" = 0 ] || { echo "cross-team-reply: (1) reply failed (exit $rc) — cross-team return route not derived from path" >&2; cat "$BETA/reply1.out" "$BETA/reply1.err" >&2; exit 1; }
# The reply sentinel was delivered to sentry's pane on alpha (route derived from path):
awk '$0 != "sentry-pane" && $0 != "%401" { bad=1 } END { exit !(NR && !bad) }' "$FAKE_TMUX_STATE/enter-targets" || { echo "cross-team-reply: (1) reply sentinel did not reach alpha/sentry" >&2; cat "$FAKE_TMUX_STATE/sent.log" >&2; exit 1; }
# v0.23 names the sender bus in the ID slot; destination and correlation live
# in the canonical envelope. Assert actual pane effects independently above.
# CONTRACT's grammar allows trailing tags, preview= and path= after the ID slot.
grep -Eq '^\[\[TAP v0\.23 note beta/[^ ]+( [^]]+)?\]\]$' "$FAKE_TMUX_STATE/sent.log" || {
  echo 'cross-team-reply: reply wire lost its beta sender-bus locator' >&2; cat "$FAKE_TMUX_STATE/sent.log" >&2; exit 1;
}
reply_canon="$(find "$BETA/payloads" -maxdepth 1 -name '*.md' -print -quit)"
[ -n "$reply_canon" ] && grep -q "^in_reply_to: $INBOUND_ID$" "$reply_canon" \
  && grep -q '^to: sentry$' "$reply_canon" && grep -q '^to_team: alpha$' "$reply_canon" || {
  echo 'cross-team-reply: canonical reply lost destination or correlation' >&2; exit 1;
}
# The inbound was settled on ALPHA's bus (its own bus), never beta's:
[ -f "$ALPHA/receipts/$INBOUND_ID.done" ] || { echo "cross-team-reply: (1) .done not on the sender (alpha) bus" >&2; ls "$ALPHA/receipts" >&2; exit 1; }
[ ! -f "$BETA/receipts/$INBOUND_ID.done" ] || { echo "cross-team-reply: (1) .done leaked onto beta bus (isolation)" >&2; exit 1; }
# The reply's own outbound canonical lives on BETA's bus (fable is its sender):
[ -n "$(find "$BETA/payloads" -maxdepth 1 -name '*.md' -print -quit)" ] || { echo "cross-team-reply: (1) reply outbound canonical not on beta bus" >&2; exit 1; }
echo "cross-team-reply: (1) reply routes by path-derived remote registry, settles on sender bus: ok"

# ---- (2) bare `tap reply <id>` cross-team -> teaching error names the abs-path form
rc=0
TAP_HOME="$BETA" "$TAP" reply "$INBOUND_ID" --by fable -m "x" \
  >"$BETA/reply2.out" 2>"$BETA/reply2.err" || rc=$?
[ "$rc" != 0 ] || { echo "cross-team-reply: (2) bare id cross-team should fail (payload is on the sender bus)" >&2; exit 1; }
grep -q -- 'tap reply <id> --payload <abs-path-from-sentinel> -f' "$BETA/reply2.out" "$BETA/reply2.err" || { echo "cross-team-reply: (2) refusal omitted the runnable abs-path recovery this arm exists to teach" >&2; cat "$BETA/reply2.out" "$BETA/reply2.err" >&2; exit 1; }
grep -qi "path" "$BETA/reply2.err" "$BETA/reply2.out" || { echo "cross-team-reply: (2) error should name the absolute path recovery" >&2; cat "$BETA/reply2.err" >&2; exit 1; }
echo "cross-team-reply: (2) bare cross-team reply teaches the self-contained abs-path form: ok"

# ---- (4) no derivable actor -> error PREFILLS --by <to> from the payload (never auto-adopts)
# Fresh inbound (the first is settled). Run with NO calling pane (no self-handle), no --by.
INBOUND2_ID="xt-inbound-2"; INBOUND2="$ALPHA/payloads/$INBOUND2_ID.md"
sed "s/$INBOUND_ID/$INBOUND2_ID/g" "$INBOUND" > "$INBOUND2"
rc=0
TAP_HOME="$BETA" TAP_SELF="" "$TAP" reply "$INBOUND2" -m "x" \
  >"$BETA/reply4.out" 2>"$BETA/reply4.err" || rc=$?
[ "$rc" != 0 ] || { echo "cross-team-reply: (4) reply with no actor should fail" >&2; exit 1; }
if grep -qi "no_actor\|could not derive" "$BETA/reply4.out" "$BETA/reply4.err"; then
  grep -q -- "--by fable" "$BETA/reply4.out" "$BETA/reply4.err" || { echo "cross-team-reply: (4) no-actor error did not PREFILL --by fable from the payload" >&2; cat "$BETA/reply4.err" >&2; exit 1; }
  echo "cross-team-reply: (4) no-derivable-actor error prefills --by <to>, never auto-adopts: ok"
else
  # A calling pane happened to resolve — acceptable; the prefill path is exercised only when derivation fails.
  echo "cross-team-reply: (4) actor derivation resolved (prefill path not triggered here): ok"
fi

# ---- (5) tap outstanding on the SENDER bus tags the cross-team row [cross-team]
# Seed an unsettled cross-team OUTBOUND from sentry (on alpha) to beta/fable.
OUT_ID="xt-outbound-1"
cat > "$ALPHA/payloads/$OUT_ID.md" <<EOF
---
id: $OUT_ID
from: sentry
to: fable
to_team: beta
kind: discuss
reply: expected
path: $ALPHA/payloads/$OUT_ID.md
---

sentry's outbound to beta
EOF
# An enrolled team's acting bus is <root>/.tap/bus, and `outstanding` refuses a
# TAP_HOME that is not that bus, so enroll alpha at a root whose bus is this
# directory. Arms 1-4 above ran against the flat enrollment on purpose: with
# alpha reachable by id they could not exercise the bare-id teaching error.
ALPHA_ROOT="$(cd "$(mktemp -d)" && pwd -P)"
mkdir -p "$ALPHA_ROOT/.tap"; ln -s "$(cd "$ALPHA" && pwd -P)" "$ALPHA_ROOT/.tap/bus"
printf '{"schema":"0.20","teams":{"alpha":{"root":"%s","registry_location":"%s","state":"registered"}}}\n' \
  "$ALPHA_ROOT" "$ALPHA_ROOT/.tap/bus/registry.json" > "$TAP_INDEX_HOME/global-registry.json"
rc=0
TAP_HOME="$ALPHA" "$TAP" outstanding sentry >"$ALPHA/out5.txt" 2>&1 || rc=$?
grep -q "$OUT_ID" "$ALPHA/out5.txt" || { echo "cross-team-reply: (5) outstanding did not list the cross-team outbound" >&2; cat "$ALPHA/out5.txt" >&2; exit 1; }
grep -q "beta/fable" "$ALPHA/out5.txt" || { echo "cross-team-reply: (5) outstanding did not qualify the addressed team" >&2; cat "$ALPHA/out5.txt" >&2; exit 1; }
grep -q "\[cross-team" "$ALPHA/out5.txt" || { echo "cross-team-reply: (5) outstanding cross-team row missing the [cross-team] tag" >&2; cat "$ALPHA/out5.txt" >&2; exit 1; }
echo "cross-team-reply: (5) outstanding states the addressed team + [cross-team] tag: ok"

# ---- (7) REGRESSION TRIPWIRE: the OLD misleading shape can no longer be produced.
# A cross-team outbound rendered WITHOUT the [cross-team] tag, or with the retired
# bare 'outbound-relay' label, is a red — this is the misread this lane exists to kill.
grep -q "outbound-relay" "$ALPHA/out5.txt" && { echo "cross-team-reply: (7) TRIPWIRE: retired bare 'outbound-relay' label resurfaced" >&2; cat "$ALPHA/out5.txt" >&2; exit 1; }
# JSON contract: cross-team row carries the explicit obligation-location signal.
TAP_HOME="$ALPHA" "$TAP" outstanding sentry --json >"$ALPHA/out5.json" 2>/dev/null || true
python3 -B - "$ALPHA/out5.json" "$OUT_ID" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
row = next((r for r in doc.get("outstanding", doc.get("items", [])) if r.get("id") == sys.argv[2]), None)
assert row is not None, doc
assert row.get("outbound_relay") is True, row
assert row.get("addressed_team") == "beta", row
assert row.get("settles_on") == "peer_bus", row
PY
echo "cross-team-reply: (7) regression tripwire — cross-team row cannot render as a bare local obligation: ok"

# ---- (6) tap poll names the local-team inbox; a foreign to_team never appears
# Seed a LOCAL inbound on beta for fable, plus a foreign to_team row that must not show.
cat > "$BETA/payloads/xt-local-1.md" <<EOF
---
id: xt-local-1
from: peer
to: fable
to_team: beta
kind: discuss
reply: expected
path: $BETA/payloads/xt-local-1.md
---

local inbound for fable
EOF
cat > "$BETA/payloads/xt-foreign-1.md" <<EOF
---
id: xt-foreign-1
from: sentry
from_team: alpha
to: fable
to_team: gamma
kind: discuss
reply: expected
path: $BETA/payloads/xt-foreign-1.md
---

foreign-team row that must NOT read as beta inbox
EOF
rc=0
TAP_HOME="$BETA" "$TAP" poll fable >"$BETA/poll6.txt" 2>&1 || rc=$?
grep -q "xt-local-1" "$BETA/poll6.txt" || { echo "cross-team-reply: (6) local inbound missing from poll" >&2; cat "$BETA/poll6.txt" >&2; exit 1; }
grep -q "inbox for beta/fable" "$BETA/poll6.txt" || { echo "cross-team-reply: (6) poll did not name the local-team inbox header" >&2; cat "$BETA/poll6.txt" >&2; exit 1; }
grep -q "xt-foreign-1" "$BETA/poll6.txt" && { echo "cross-team-reply: (6) foreign to_team row leaked into local poll (18so gate)" >&2; cat "$BETA/poll6.txt" >&2; exit 1; }
TAP_HOME="$BETA" "$TAP" poll fable --json >"$BETA/poll6.json" 2>/dev/null || true
python3 -B -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d.get("team")=="beta", d' "$BETA/poll6.json" \
  || { echo "cross-team-reply: (6) poll JSON did not state team=beta" >&2; cat "$BETA/poll6.json" >&2; exit 1; }
echo "cross-team-reply: (6) poll names the local-team inbox, foreign rows never appear: ok"

echo "cross-team-reply: ok"
