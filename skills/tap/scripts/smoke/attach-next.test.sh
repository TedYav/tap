#!/usr/bin/env bash
# attach-next.test.sh — gate-budget smoke for `tap attach --next`.
#
# Smallest load-bearing control (FIX-AND-SHIP):
#   next/wrap: outside first eligible, after-current, wrap
#   current-team: acting registry vs bus decoy; enrollment-key hop
#   eligible-seat filtering: empty set; poll sole-candidate
#   positional delegation: race --no-resume
# Exhaustive parser/cursor/strict->/remaining soles/docs matrix:
#   skills/tap/scripts/regress/attach-next-matrix.test.sh
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"
# shellcheck source=skills/tap/scripts/smoke/attach-next-fixture.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/attach-next-fixture.sh"

# --- empty eligible set -------------------------------------------------------
write_sessions
printf 'demo/bravo\t1:1\t1\n' > "$FAKE_SESSIONS"
write_panes
run_next
[ "$rc" = 1 ] || fail "empty eligible expected exit 1, got $rc" "$(cat "$WORK/out"; cat "$WORK/err")"
[ "$(error_class "$(cat "$WORK/out")")" = not_attachable ] \
  || fail "empty eligible expected not_attachable" "$(cat "$WORK/out")"
logged 'attach-session|switch-client' && fail "empty eligible must not attach" "$(cat "$FAKE_EVENTS")"
grep -E 'session resume|session launch' "$WORK/out" "$WORK/err" >/dev/null \
  && fail "empty eligible must not name launch/resume" "$(cat "$WORK/out"; cat "$WORK/err")"
echo "attach-next: empty eligible set refuses not_attachable with no mutation: ok"

# --- outside starts at first eligible (alpha) ---------------------------------
write_sessions
write_panes
write_registry
run_next
[ "$rc" = 0 ] || fail "outside --next should hop to alpha" "$(cat "$WORK/out"; cat "$WORK/err")"
logged 'attach-session.*demo/alpha' || fail "outside should attach-session demo/alpha" "$(cat "$FAKE_EVENTS")"
logged 'attach-session.*demo/charlie' && fail "outside must not pick charlie" "$(cat "$FAKE_EVENTS")"
logged 'list-sessions.*pid.*start_time' || fail "outside hop must run positional session recheck" "$(cat "$FAKE_EVENTS")"
echo "attach-next: outside starts at first eligible alpha: ok"

# --- after-current (bravo attached) picks charlie, not first-unattached alpha -
export FAKE_PS_MODE=tty FAKE_CALLER_PANE="%12"
write_sessions
write_panes
run_next_inside "%12"
[ "$rc" = 0 ] || fail "inside bravo --next should hop to charlie" "$(cat "$WORK/out"; cat "$WORK/err")"
logged 'switch-client.*demo/charlie|attach-session.*demo/charlie' \
  || fail "current=bravo must pick charlie (after-current), not alpha" "$(cat "$FAKE_EVENTS")"
logged 'switch-client.*demo/alpha|attach-session.*demo/alpha' \
  && fail "first-unattached globally (alpha) would pass this; after-current must not pick alpha" "$(cat "$FAKE_EVENTS")"
echo "attach-next: after-current bravo -> charlie (not alpha): ok"

# --- wrap: current=charlie (attached) -> first eligible alpha -----------------
export FAKE_CALLER_PANE="%13"
run_next_inside "%13"
[ "$rc" = 0 ] || fail "wrap from charlie should hop to alpha" "$(cat "$WORK/out"; cat "$WORK/err")"
logged 'switch-client.*demo/alpha|attach-session.*demo/alpha' \
  || fail "wrap from last eligible must pick alpha" "$(cat "$FAKE_EVENTS")"
echo "attach-next: wrap from charlie -> alpha: ok"

# --- poll sole-candidate: selector empty, not hop-then-refuse -----------------
# Pane identity + live unattached session so skipping delivery==poll classifies
# this row as active/attached=0 and hops. Without those fields the skip is
# masked by att=0. Causal poll-skip mutant lives in the regress matrix.
write_sole delta '{"delivery":"poll","harness":"claude","status":"active","unattended":true,"pane":"demo/delta:0.0","pane_id":"%21","session":"demo/delta","server_epoch":"900:100","boot_id":"boot:2"}'
printf 'demo/delta\t1:1\t0\n' > "$FAKE_SESSIONS"
printf 'demo/delta\tdemo/delta:0.0\t%%21\tclaude\t121\t1:1\t0\n' > "$FAKE_PANES"
assert_selector_empty poll

# --- race: selected alpha dies before positional; --no-resume refuses ---------
write_sessions
write_panes
write_registry
export FAKE_RACE=1
: > "$FAKE_EVENTS"
rm -f "$FAKE_EVENTS.batch-count"
set +e
env -u TMUX -u TMUX_PANE TAP_JSON=1 "$TAP" attach --next >"$WORK/out" 2>"$WORK/err"
rc=$?
set -e
export FAKE_RACE=""
[ "$rc" = 1 ] || fail "race arm expected refusal, got $rc" "$(cat "$WORK/out"; cat "$WORK/err")"
[ "$(error_class "$(cat "$WORK/out")")" = seat_inactive ] \
  || fail "race arm expected seat_inactive via --no-resume" "$(cat "$WORK/out")"
grep -F -- '--no-resume' "$WORK/out" >/dev/null \
  || fail "race refusal must name --no-resume (delegated hop is load-bearing)" "$(cat "$WORK/out"; cat "$WORK/err")"
grep -E 'resume it first' "$WORK/out" "$WORK/err" >/dev/null \
  && fail "race arm must not prompt to resume" "$(cat "$WORK/out"; cat "$WORK/err")"
logged 'attach-session|switch-client' && fail "race arm must not attach" "$(cat "$FAKE_EVENTS")"
echo "attach-next: race to inactive refuses via delegated --no-resume: ok"

# Restore live sessions after the race mutation.
write_sessions
write_panes
write_registry

# --- post-flip: acting registry, not the retired bus decoy --------------------
# Outside --next skips resolve-self, so nothing else rebinds. Bus decoy handle
# sorts first (alpha); acting handle sorts last (zulu). A bus-only or unioned
# read hops to alpha; acting-only hops to zulu.
ROOT_ABS="$(cd "$TEAM_ROOT" && pwd -P)"
ACTING_REG="$ROOT_ABS/.tap/team-registry.json"
cat > "$TAP_HOME/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"demo"},"seats":{"alpha":{"pane":"demo/alpha:0.0","pane_id":"%11","harness":"claude","status":"active","session":"demo/alpha","server_epoch":"900:100","boot_id":"boot:2"}}}
JSON
cat > "$ACTING_REG" <<'JSON'
{"schema":"0.20","team":{"name":"demo"},"seats":{"zulu":{"pane":"demo/zulu:0.0","pane_id":"%31","harness":"claude","status":"active","session":"demo/zulu","server_epoch":"900:100","boot_id":"boot:2"}}}
JSON
cat > "$TAP_INDEX_HOME/global-registry.json" <<JSON
{"schema":"0.20","teams":{"demo":{"enrolled_at":"t","registry_location":"$ACTING_REG","root":"$ROOT_ABS","state":"registered"}}}
JSON
cat > "$FAKE_SESSIONS" <<'EOF'
demo/alpha	1:1	0
demo/zulu	1:1	0
EOF
cat > "$FAKE_PANES" <<'EOF'
demo/alpha	demo/alpha:0.0	%11	claude	111	1:1	0
demo/zulu	demo/zulu:0.0	%31	claude	131	1:1	0
EOF
run_next
[ "$rc" = 0 ] || fail "post-flip outside --next should hop via acting registry" "$(cat "$WORK/out"; cat "$WORK/err")"
logged 'attach-session.*demo/zulu' \
  || fail "post-flip must hop to acting handle zulu" "$(cat "$FAKE_EVENTS")"
logged 'attach-session.*demo/alpha' \
  && fail "post-flip must not hop to bus-decoy alpha" "$(cat "$FAKE_EVENTS")"
echo "attach-next: post-flip outside --next uses acting registry, not bus decoy: ok"

# --- post-flip hop is acting-team/handle, not a bare handle against the bus ---
# Bus team.name is decoy; acting file is enrolled as demo but embeds team.name
# decoy. Enrollment key must win: embedded mismatch would hop to decoy/zulu.
DECOY_ROOT="$WORK/decoy-team"
mkdir -p "$DECOY_ROOT/.tap/bus/payloads" "$DECOY_ROOT/.tap/bus/receipts"
git -C "$DECOY_ROOT" init -q
DECOY_ABS="$(cd "$DECOY_ROOT" && pwd -P)"
DECOY_REG="$DECOY_ABS/.tap/team-registry.json"
cat > "$TAP_HOME/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"decoy"},"seats":{"zulu":{"pane":"decoy/zulu:0.0","pane_id":"%41","harness":"claude","status":"active","session":"decoy/zulu","server_epoch":"900:100","boot_id":"boot:2"}}}
JSON
cat > "$ACTING_REG" <<'JSON'
{"schema":"0.20","team":{"name":"decoy"},"seats":{"zulu":{"pane":"demo/zulu:0.0","pane_id":"%31","harness":"claude","status":"active","session":"demo/zulu","server_epoch":"900:100","boot_id":"boot:2"}}}
JSON
cat > "$DECOY_REG" <<'JSON'
{"schema":"0.20","team":{"name":"decoy"},"seats":{"zulu":{"pane":"decoy/zulu:0.0","pane_id":"%41","harness":"claude","status":"active","session":"decoy/zulu","server_epoch":"900:100","boot_id":"boot:2"}}}
JSON
cat > "$TAP_INDEX_HOME/global-registry.json" <<JSON
{"schema":"0.20","teams":{
 "demo":{"enrolled_at":"t","registry_location":"$ACTING_REG","root":"$ROOT_ABS","state":"registered"},
 "decoy":{"enrolled_at":"t","registry_location":"$DECOY_REG","root":"$DECOY_ABS","state":"registered"}
}}
JSON
cat > "$FAKE_SESSIONS" <<'EOF'
demo/zulu	1:1	0
decoy/zulu	1:1	0
EOF
cat > "$FAKE_PANES" <<'EOF'
demo/zulu	demo/zulu:0.0	%31	claude	131	1:1	0
decoy/zulu	decoy/zulu:0.0	%41	claude	141	1:1	0
EOF
run_next
[ "$rc" = 0 ] || fail "post-flip qualified hop should attach acting demo/zulu" "$(cat "$WORK/out"; cat "$WORK/err")"
logged 'attach-session.*demo/zulu' \
  || fail "qualified hop must land on acting demo/zulu" "$(cat "$FAKE_EVENTS")"
logged 'attach-session.*decoy/zulu' \
  && fail "enrollment-key hop must not follow embedded team.name decoy" "$(cat "$FAKE_EVENTS")"
echo "attach-next: post-flip hop uses enrolled team name, not embedded team.name: ok"

echo "attach-next: ok"
