#!/usr/bin/env bash
# wrong-cwd-read-refusal.test.sh — cwd-derived reads must not certify a phantom
# bus as empty when the caller pane is registered on another enrolled team.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "wrong-cwd-read-refusal: $*" >&2; exit 1; }

export TAP_INDEX_HOME="$WORK/index"
TEAM_ROOT="$WORK/team"
BUS="$TEAM_ROOT/.tap/bus"
REGISTRY="$TEAM_ROOT/.tap/team-registry.json"
WRONG="$WORK/unenrolled"
mkdir -p "$TAP_INDEX_HOME" "$BUS/payloads" "$BUS/receipts" "$WRONG" "$WORK/bin"
git -C "$WRONG" init -q

# Model a pane-backed seat without trusting the runner's real process ancestry.
cat >"$WORK/bin/ps" <<'SH'
#!/usr/bin/env bash
printf '1 ttys001\n'
SH
cat >"$WORK/bin/tmux" <<'SH'
#!/usr/bin/env bash
# Real tmux honours the -p format string; this stub used to return one fixed pair
# for EVERY display-message, so a caller asking for #{session_name} was answered
# with a pane id and a tty. It now answers what it was asked (tap-3kwy), and the
# targeted four-field identity record (pane_id, pane_tty, session_name,
# pid:start_time) gets all four fields back — the arity-exact identity readers
# in both engines refuse anything else (tap-316wj). Session- and
# generation-only callers keep the short two-field record.
case "${1:-}" in
  list-panes) printf '%%5\t/dev/ttys001\n' ;;
  display-message)
    for a in "$@"; do
      case "$a" in
        *'#{pane_tty}'*) printf '%%5\t/dev/ttys001\tfixture/sol\t4242:100'; exit 0 ;;
      esac
    done
    for a in "$@"; do
      case "$a" in *'#{session_name}'*) printf 'fixture/sol\t4242:100'; exit 0 ;; esac
    done
    printf '%%5\t/dev/ttys001' ;;
  list-sessions) printf 'fixture\n' ;;
esac
SH
chmod +x "$WORK/bin/ps" "$WORK/bin/tmux"
export PATH="$WORK/bin:$PATH"

cat >"$REGISTRY" <<'JSON'
{
  "schema": "0.20",
  "team": {"name": "fixture"},
  "seats": {
    "sol": {
      "status": "active",
      "delivery": "pane",
      "harness": "codex",
      "pane": "fixture/sol:0.0",
      "pane_id": "%5",
      "session": "fixture/sol",
      "registered_at": "2026-08-11T00:00:00Z",
      "server_epoch": "srv:4242:100",
      "instance": "sol|fixture"
    }
  }
}
JSON
cat >"$TAP_INDEX_HOME/global-registry.json" <<JSON
{
  "schema": "0.20",
  "teams": {
    "fixture": {
      "root": "$TEAM_ROOT",
      "registry_location": "$REGISTRY",
      "state": "registered"
    }
  }
}
JSON

INBOUND="fable-20260811T000000Z-abcdef123456"
OUTBOUND="sol-20260811T000001Z-abcdef123456"
cat >"$BUS/payloads/$INBOUND.md" <<EOF
---
id: $INBOUND
from: fable
to: sol
kind: discuss
path: $BUS/payloads/$INBOUND.md
reply: expected
---
pending inbound
EOF
cat >"$BUS/payloads/$OUTBOUND.md" <<EOF
---
id: $OUTBOUND
from: sol
to: fable
kind: discuss
path: $BUS/payloads/$OUTBOUND.md
reply: expected
---
pending outbound
EOF

assert_wrong_cwd_refusal() { # <verb> <forbidden-empty-text> <args...>
  local verb="$1" forbidden="$2" out rc=0
  out="$WORK/$verb.out"
  shift 2
  (cd "$WRONG" && env -u TAP_HOME "$TAP" "$@") >"$out" 2>&1 || rc=$?
  [ "$rc" -eq 4 ] || fail "$verb wrong-cwd read returned rc=$rc (want 4): $(cat "$out")"
  grep -Fq "unanchored cwd" "$out" || fail "$verb did not identify the unanchored cwd: $(cat "$out")"
  grep -Fq "cd $TEAM_ROOT" "$out" || fail "$verb did not name the enrolled root: $(cat "$out")"
  grep -Fq "pass --team fixture" "$out" || fail "$verb did not name the explicit team door: $(cat "$out")"
  ! grep -Fq "$forbidden" "$out" || fail "$verb certified the phantom bus empty: $(cat "$out")"
  [ ! -e "$WRONG/.tap" ] || fail "$verb created a self-concealing phantom bus before refusing"
}

# Run each twice: a misplaced post-ensure_dirs guard would catch invocation one
# but leave a dotdir that changes source-time resolution on invocation two.
assert_wrong_cwd_refusal poll "tap poll: empty" poll sol
assert_wrong_cwd_refusal poll-second "tap poll: empty" poll sol
assert_wrong_cwd_refusal poll-quiet "tap poll: empty" poll sol --quiet
assert_wrong_cwd_refusal outstanding "no outstanding sends" outstanding sol
assert_wrong_cwd_refusal outstanding-second "no outstanding sends" outstanding sol

# ── tap-52ys: 3 of 6 arms removed (ratified 2026-08-14) ─────────────────────
# The defect class is a cwd-derived read certifying a PHANTOM empty bus — an
# agent in the wrong directory being told it has no mail. Three arms hold it:
# poll/outstanding refuse rather than reporting empty, --team reaches the real
# bus, and an explicit TAP_HOME still works.
#
# Accepted gap, named: the peek/JSON/unobservable doors (peek is a debug verb
# this cut removed from the gate anyway).

echo "wrong-cwd-read-refusal: cwd-derived poll/outstanding refuse before creating a phantom bus: ok"

# ── tap-mcg0: send must refuse before ensure_dirs, not after ────────────────
# The defect: tap-send.sh called tap_ensure_dirs at three sites upstream of its
# own identity/FROM resolution, so a send already doomed to fail (wrong cwd)
# first mkdir'd payloads/receipts at $WRONG — a self-concealing decoy bus, same
# shape poll/outstanding were fixed for, just missed on this verb. Unlike
# poll/outstanding (rc=4), tap-send.sh's own header retires exit 4; the guard
# here refuses with rc=1, send's documented refusal code.
assert_send_no_side_effect() { # <label> <args...>
  local label="$1" out rc=0
  out="$WORK/$label.out"
  shift
  [ ! -e "$WRONG/.tap" ] || fail "$label: fixture already dirty before the call — test bug"
  (cd "$WRONG" && env -u TAP_HOME "$TAP" "$@") >"$out" 2>&1 || rc=$?
  [ "$rc" -eq 1 ] || fail "$label wrong-cwd send returned rc=$rc (want 1): $(cat "$out")"
  grep -Fq "unanchored cwd" "$out" || fail "$label did not identify the unanchored cwd: $(cat "$out")"
  grep -Fq "cd $TEAM_ROOT" "$out" || fail "$label did not name the enrolled root: $(cat "$out")"
  grep -Fq "pass --team fixture" "$out" || fail "$label did not name the explicit team door: $(cat "$out")"
  [ ! -e "$WRONG/.tap" ] || fail "$label created a self-concealing phantom bus before refusing"
}
# Run each mode twice: a misplaced post-ensure_dirs guard would catch invocation
# one but leave a dotdir that changes source-time resolution on invocation two.
assert_send_no_side_effect send-inline send fable -m "should never create a bus" --from sol
assert_send_no_side_effect send-inline-second send fable -m "should never create a bus" --from sol
BODYFILE="$WORK/body.md"
printf 'should never create a bus (body file)\n' >"$BODYFILE"
assert_send_no_side_effect send-bodyfile send fable -f "$BODYFILE" --from sol
echo "wrong-cwd-read-refusal: cwd-derived send refuses before creating a phantom bus: ok"

# An explicit --team is an assertion of bus identity. It must reach the real bus
# from the same cwd and expose the records that the phantom empty would hide.
rc=0
(cd "$WRONG" && env -u TAP_HOME "$TAP" poll sol --team fixture) >"$WORK/team-poll.out" 2>&1 || rc=$?
if [ "$rc" -ne 0 ] || ! grep -Fq "$INBOUND" "$WORK/team-poll.out"; then
  fail "poll --team did not reach the real pending inbound (rc=$rc): $(cat "$WORK/team-poll.out")"
fi
rc=0
(cd "$WRONG" && env -u TAP_HOME "$TAP" outstanding sol --team fixture) >"$WORK/team-outstanding.out" 2>&1 || rc=$?
if [ "$rc" -ne 0 ] || ! grep -Fq "$OUTBOUND" "$WORK/team-outstanding.out"; then
  fail "outstanding --team did not reach the real pending outbound (rc=$rc): $(cat "$WORK/team-outstanding.out")"
fi
echo "wrong-cwd-read-refusal: explicit --team reaches the real bus: ok"


# An explicit TAP_HOME also asserts the bus. Scratch harnesses intentionally use
# registry-less homes, so both readers must stay grounded: exit 0 and list the row.
SCRATCH="$WORK/scratch-bus"
mkdir -p "$SCRATCH/payloads" "$SCRATCH/receipts"
cp "$BUS/payloads/$INBOUND.md" "$SCRATCH/payloads/$INBOUND.md"
cp "$BUS/payloads/$OUTBOUND.md" "$SCRATCH/payloads/$OUTBOUND.md"
rc=0
TAP_HOME="$SCRATCH" "$TAP" poll sol >"$WORK/env-poll.out" 2>&1 || rc=$?
if [ "$rc" -ne 0 ] || ! grep -Fq "$INBOUND" "$WORK/env-poll.out"; then
  fail "explicit TAP_HOME poll regressed (rc=$rc): $(cat "$WORK/env-poll.out")"
fi
rc=0
TAP_HOME="$SCRATCH" "$TAP" outstanding sol >"$WORK/env-outstanding.out" 2>&1 || rc=$?
if [ "$rc" -ne 0 ] || ! grep -Fq "$OUTBOUND" "$WORK/env-outstanding.out"; then
  fail "explicit TAP_HOME outstanding regressed (rc=$rc): $(cat "$WORK/env-outstanding.out")"
fi
echo "wrong-cwd-read-refusal: explicit registry-less TAP_HOME remains supported: ok"


# Peek's missing-registry arm is the same wrong-cwd diagnosis. It must direct the
# registered caller back to the enrolled root, not propose a duplicate row.
rm -rf "$WRONG/.tap"
rc=0
(cd "$WRONG" && env -u TAP_HOME "$TAP" peek sol) >"$WORK/peek.out" 2>&1 || rc=$?
[ "$rc" -eq 4 ] || fail "peek wrong-cwd remedy returned rc=$rc (want 4): $(cat "$WORK/peek.out")"
grep -Fq "cd $TEAM_ROOT" "$WORK/peek.out" || fail "peek did not name the enrolled root: $(cat "$WORK/peek.out")"
! grep -Fq "tap register" "$WORK/peek.out" || fail "peek still proposed duplicate registration: $(cat "$WORK/peek.out")"
! grep -Fq "pass --team" "$WORK/peek.out" || fail "peek proposed an unsupported --team option: $(cat "$WORK/peek.out")"
[ ! -e "$WRONG/.tap" ] || fail "peek created a self-concealing phantom bus before refusing"
echo "wrong-cwd-read-refusal: peek reuses the enrolled-pane remedy: ok"

echo "wrong-cwd-read-refusal: ok"
