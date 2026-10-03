#!/usr/bin/env bash
# collab-dir-cross-worktree.test.sh - COLLAB_DIR must resolve to ONE root across worktrees.
#
# Run: bash skills/discuss/scripts/smoke/collab-dir-cross-worktree.test.sh
# Exit: 0 on all-pass, 1 on any failure.
#
# WHY THIS ARM EXISTS, AND WHY IT IS SEPARATE FROM convergence-ledger.test.sh:
# that suite exports an absolute COLLAB_DIR before doing anything else, which is
# correct for testing ledger mechanics and is exactly why this class was invisible
# in it — an explicit override cannot exercise the DEFAULT resolution. The defect
# it hid: collab originally rooted thread state at
# `$(git rev-parse --show-toplevel)/tmp/discuss`, which is per-worktree. TAP seats
# work in per-lane worktrees under trees/tap/<Name>, so a driver in one worktree
# and a peer in another got two different roots, the peer could not read the thread
# it was invited to, and assert_driver failed on a metadata.json it could not see.
# The loop could not run across worktrees at all — its normal shape here.
#
# So this file NEVER sets COLLAB_DIR. It sets TAP_HOME (the sanctioned custom-home
# mechanism, which keeps the real ~/.tap out of the test) and asserts that two
# distinct git worktrees resolve to the same collab root. Under the old
# repo-relative resolution this arm reds: TAP_HOME is ignored and each worktree
# answers with its own toplevel.

set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "collab/discuss-dir-cross-worktree: not in a git repo" >&2; exit 1; }
LIB="$REPO_ROOT/skills/discuss/scripts/lib.sh"

pass=0
fail=0
ok() { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n' "$1"; }

echo "collab/discuss-dir-cross-worktree test  (one root across worktrees)"

[ -f "$LIB" ] || { echo "FAIL: $LIB not found" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/discuss-xwt.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

FAKE_TAP_HOME="$WORK/taphome"
mkdir -p "$FAKE_TAP_HOME"

# Two independent git repos stand in for two per-lane worktrees. Independent repos
# are a STRICTLY HARDER case than two worktrees of one repo (different toplevels
# AND different object stores), so passing here covers the worktree case.
for name in laneA laneB; do
  mkdir -p "$WORK/$name"
  git -C "$WORK/$name" init -q 2>/dev/null || { echo "FAIL: git init failed" >&2; exit 1; }
done

# Resolve COLLAB_DIR the way a seat would: cd into the lane, source lib.sh, with
# COLLAB_DIR deliberately UNSET so the default path is what answers.
resolve_from() {
  local dir="$1"
  ( cd "$dir" || exit 1
    unset COLLAB_DIR
    export TAP_HOME="$FAKE_TAP_HOME"
    # shellcheck disable=SC1090
    . "$LIB" >/dev/null 2>&1 || exit 1
    printf '%s' "$COLLAB_DIR" )
}

A="$(resolve_from "$WORK/laneA")"
B="$(resolve_from "$WORK/laneB")"

# Fixture validity: if either resolution produced nothing, the arms below would
# compare "" to "" and pass for the wrong reason.
if [ -n "$A" ] && [ -n "$B" ]; then
  ok "fixture: both lanes resolved a non-empty COLLAB_DIR"
else
  bad "fixture: a lane resolved an EMPTY COLLAB_DIR (A='$A' B='$B') - arms below would be vacuous"
fi

# Fixture validity: the two lanes must really be different repos, or "same root"
# is trivially true and proves nothing.
TOP_A="$(cd "$WORK/laneA" && git rev-parse --show-toplevel)"
TOP_B="$(cd "$WORK/laneB" && git rev-parse --show-toplevel)"
if [ "$TOP_A" != "$TOP_B" ]; then
  ok "fixture: the two lanes have distinct git toplevels"
else
  bad "fixture: lanes share a toplevel ($TOP_A) - this arm cannot detect the defect"
fi

# THE LOAD-BEARING ARM. Reds under the repo-relative resolution.
if [ "$A" = "$B" ]; then
  ok "two worktrees resolve to the SAME collab root"
else
  bad "two worktrees resolved DIFFERENT collab roots - a peer cannot see the driver's thread
         laneA -> $A
         laneB -> $B"
fi

# The root must be under TAP's home, not under either repo. Pinned separately from
# the equality above: two lanes could agree on a wrong shared root (e.g. a fixed
# /tmp path), which would satisfy equality while losing TAP_HOME's custom-home
# contract and colliding across machines-worth of state.
if [ "${A#"$FAKE_TAP_HOME"/}" != "$A" ]; then
  ok "collab root honors TAP_HOME"
else
  bad "collab root ignores TAP_HOME (got '$A', expected a path under '$FAKE_TAP_HOME')"
fi

# And it must not be rooted in the repo at all - the old failure mode, stated as a
# direct negative so a future refactor back to repo-relative reds here too.
if [ "${A#"$TOP_A"/}" = "$A" ]; then
  ok "collab root is not repo-relative"
else
  bad "collab root is inside the repo ('$A' under '$TOP_A') - per-worktree state, and git clean eats it"
fi

# The absolute override must still work; the ledger suite depends on it.
OVERRIDE="$WORK/explicit"
GOT="$( cd "$WORK/laneA" || exit 1
        export COLLAB_DIR="$OVERRIDE" TAP_HOME="$FAKE_TAP_HOME"
        # shellcheck disable=SC1090
        . "$LIB" >/dev/null 2>&1 || exit 1
        printf '%s' "$COLLAB_DIR" )"
if [ "$GOT" = "$OVERRIDE" ]; then
  ok "an absolute COLLAB_DIR override still wins"
else
  bad "absolute override was not honored (got '$GOT', expected '$OVERRIDE')"
fi

# A relative override must still die rather than silently resolving against cwd.
if ( cd "$WORK/laneA" || exit 1
     export COLLAB_DIR="relative/path" TAP_HOME="$FAKE_TAP_HOME"
     # shellcheck disable=SC1090
     . "$LIB" ) >/dev/null 2>&1; then
  bad "a RELATIVE COLLAB_DIR was accepted - it must die"
else
  ok "a relative COLLAB_DIR override still dies"
fi

printf 'collab/discuss-dir-cross-worktree test: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
