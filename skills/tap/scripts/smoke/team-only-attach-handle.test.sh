#!/usr/bin/env bash
# team-only-attach-handle.test.sh — attach must SELECT on the canonical handle
# (tap-sttl / tap-vmfr; partner review P2#7, gate review, and the review bot all
# reached this same missing arm independently).
#
# The gap being closed: producer tests proved `session list --json` emits
# `handle`, and nothing proved the CONSUMER reads it. Reverting attach to the old
# session-name derivation left every new test and the whole team-attach regress
# fixture green — a repair with no executable regression coverage.
#
# The discriminating case is specific, and picking the wrong one proves nothing.
# For a seat whose registry handle is `grok` but whose session is
# `demo/legacy-scout`:
#
#   --only kimi   -> spared under BOTH derivations (neither `grok` nor
#                    `legacy-scout` is in {kimi}), so it discriminates NOTHING.
#   --only grok   -> canonical says ACT (grok is named); the old derivation says
#                    spare (legacy-scout is not in {grok}). This is the arm.
#   --except grok -> canonical says SPARE; the old derivation says act. The
#                    mirror, so a fix that inverts a polarity cannot pass both.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"

fail() { echo "team-only-attach-handle: $*" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
TEAM_ROOT="$WORK/demo"
mkdir -p "$TEAM_ROOT"
export TAP_HOME="$TEAM_ROOT/.tap/bus"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"

# Build the registry through the launcher's OWN writer, so the fixture cannot
# encode a row shape production never produces.
"${TAP_SMOKE_BUN:-bun}" "$ROOT/runtime/bun/test/support/launcher-fixture.ts" canonical-registry "$TEAM_ROOT" || fail "could not build the fixture registry"
# Born live: the launcher lists only an enrolled worktree.
printf '{"schema":"0.20","teams":{"%s":{"root":"%s","registry_location":"%s/registry.json","state":"registered"}}}\n' demo "$(cd "$TEAM_ROOT" && pwd -P)" "$(cd "$TAP_HOME" && pwd -P)" > "${TAP_INDEX_HOME:?}/global-registry.json"

# Sanity: the snapshot attach will read must actually carry the specimen, or
# every arm below would be green against an empty plan.
# NOT `2>/dev/null || true`. That made a CRASHING launcher indistinguishable from
# one that listed nothing, so the arm below reported "fixture did not produce the
# row" for what was actually a failure to run at all — absence is only evidence
# if the read succeeded. A reviewer hitting this on another machine got the
# misleading message instead of the error (codex bot).
_snap_err="$(mktemp)"; _snap_rc=0
snapshot="$("$ROOT/bin/tap" session list --json --cwd "$TEAM_ROOT" 2>"$_snap_err")" || _snap_rc=$?
[ "$_snap_rc" = 0 ] \
  || fail "launcher list FAILED (rc=$_snap_rc) — the snapshot is empty because it could not run, not because the fixture is wrong: $(tr '\n' ' ' <"$_snap_err")"
rm -f "$_snap_err"
case "$snapshot" in
  *legacy-scout*) ;;
  *) fail "fixture did not produce the noncanonical row; snapshot was: $snapshot" ;;
esac
case "$snapshot" in
  *'"handle": "grok"'*|*'"handle":"grok"'*) ;;
  *) fail "snapshot does not carry canonical handle 'grok'; snapshot was: $snapshot" ;;
esac
echo "team-only-attach-handle: (0) fixture carries a noncanonical row with canonical handle: ok"

# Exit status IS gated, but the expected value is 1, not 0: no tmux runs under
# this fixture, so attach legitimately ends with "no live seats" after doing the
# selection. Pinning the specific code keeps a DIFFERENT failure (a refusal, a
# crash) from passing as this one.
expect_rc() { # <got> <arm>
  [ "$1" = 1 ] || fail "$2 expected exit 1 (no live seats), got $1"
}

# --- (1) --only <canonical> ACTS on the noncanonical session -------------------
# Under the old derivation this row's handle was `legacy-scout`, which is not in
# {grok}, so it would have been SPARED and never considered at all.
rc=0
out="$("$TAP" team attach --dry-run --only grok </dev/null 2>&1)" || rc=$?
expect_rc "$rc" "(1)"
case "$out" in
  *"unavailable: grok"*) ;;
  *) fail "(1) --only grok must CONSIDER the seat whose canonical handle is grok, and name it 'grok'; output: $out" ;;
esac
case "$out" in
  *"spared by --only grok — every other seat"*) ;;
  *) fail "(1) --only grok must spare the seats it did not name; output: $out" ;;
esac
echo "team-only-attach-handle: (1) --only selects on the canonical handle: ok"

# --- (2) --except <canonical> SPARES it ----------------------------------------
# The mirror arm. Under the old derivation `legacy-scout` is not in {grok}, so
# the seat would NOT have been spared — meaning a fix that merely inverted a
# polarity cannot satisfy both (1) and (2).
rc=0
out="$("$TAP" team attach --dry-run --except grok </dev/null 2>&1)" || rc=$?
expect_rc "$rc" "(2)"
case "$out" in
  *"spared by --except: grok"*) ;;
  *) fail "(2) --except grok must SPARE the seat whose canonical handle is grok; output: $out" ;;
esac
case "$out" in
  *"unavailable: kimi"*) ;;
  *) fail "(2) --except grok must still consider kimi; output: $out" ;;
esac
echo "team-only-attach-handle: (2) --except spares on the canonical handle: ok"

# --- (3) whole-roster --only stays visible on attach ---------------------------
# attach gated its selector receipt on a nonempty spared list, so naming every
# seat left no trace of the flag and a whole-team attach read as unselected
# (partner review). stop had this fix; attach, detach and up did not.
rc=0
out="$("$TAP" team attach --dry-run --only kimi,grok </dev/null 2>&1)" || rc=$?
expect_rc "$rc" "(3)"
case "$out" in
  *"--only kimi, grok matched every seat — none spared"*) ;;
  *) fail "(3) whole-roster --only must still name its selector on attach; output: $out" ;;
esac
echo "team-only-attach-handle: (3) whole-roster --only stays visible on attach: ok"

echo "team-only-attach-handle: ok"
