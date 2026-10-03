#!/usr/bin/env bash
# lib.sh - shared base for collab convergence helpers.
#
# Resolves COLLAB_DIR cwd-independently. Runtime state lives under
# ${TAP_HOME:-$HOME/.tap}/collab unless a caller passes an absolute override.
#
# WHY NOT REPO-RELATIVE. Upstream rooted this at
# `$(git rev-parse --show-toplevel)/tmp/collab`. That is correct in a
# single-checkout repo and broken by construction here: TAP seats work in per-lane
# worktrees, `--show-toplevel` answers with the CALLING worktree, and a driver and
# peer in different worktrees therefore got different roots — the peer could not
# read the thread it was invited to, and assert_driver failed on a metadata.json it
# could not see. Rooting at TAP_HOME puts thread state where the bus already lives:
# one root per machine regardless of worktree, inheriting TAP's existing custom-home
# story instead of inventing a second one. It is also outside the repo, so
# `git clean` no longer eats a live thread.
#
# The root is deliberately FLAT — no per-team or per-repo namespacing. Thread ids
# are driver-minted and effectively unique; a namespace added before a real
# collision exists is a guess at the shape of one.

die() {
  echo "collab: $*" >&2
  exit 1
}

valid_handle() {
  [[ "$1" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "invalid handle '$1' (expected ^[a-z0-9][a-z0-9_-]*$ - no path separators)"
}

_resolve_collab_dir() {
  if [ -n "${COLLAB_DIR:-}" ]; then
    printf '%s' "$COLLAB_DIR"
    return
  fi
  local tap_home="${TAP_HOME:-}"
  [ -n "$tap_home" ] || tap_home="${HOME:-}/.tap"
  printf '%s/collab' "$tap_home"
}

# The override's validation runs OUT HERE, not inside _resolve_collab_dir. `die` exits,
# and a `die` reached from inside `$(_resolve_collab_dir)` exits only the command
# substitution: the caller sees a successful assignment of an empty string and sources
# on. Upstream had the check in exactly that position, so a relative COLLAB_DIR did not
# refuse — it silently resolved to "". A refusal is only as good as the control flow it
# sits in; this one runs in the sourcing shell, where exiting means what it says.
#
# Honest scope of the test below it: the pinned arm asserts the OUTCOME (a relative
# override dies), not this placement specifically. Moving the check back inside the
# substitution while keeping the empty backstop leaves the suite green, because the
# backstop refuses in the sourcing shell too. That is deliberate defense-in-depth, not
# a gap — but it means placement and backstop are two independent reasons this refuses,
# and removing BOTH is what the arm actually catches. Do not read the arm as proof that
# placement alone is what saves you.
if [ -n "${COLLAB_DIR:-}" ]; then
  case "$COLLAB_DIR" in
    /*) ;;
    *) die "COLLAB_DIR must be an absolute path (got '$COLLAB_DIR')" ;;
  esac
fi

COLLAB_DIR="$(_resolve_collab_dir)"
[ -n "$COLLAB_DIR" ] || die "could not resolve COLLAB_DIR (is HOME set?)"
export COLLAB_DIR
