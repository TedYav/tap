#!/usr/bin/env bash
# compute-exec.sh — invoke `compute exec` from the primary checkout, and make its
# refusal-to-admit a real failure.
#
# WHY THIS EXISTS. `compute exec` resolves the TAP seat from the CALLER's current
# directory. Invoked from a lane worktree -- which has no acting registry -- it
# prints
#
#     compute: Register with TAP before requesting compute
#
# and EXITS 0. Nothing runs. A caller that redirected output to a log finds the
# PREVIOUS run's log still sitting there, unchanged, and reads it as a fresh
# result; a caller that checked `$?` sees success. That shape has cost lane W five
# runs across two instances, twice by re-investigating an already-explained failure
# in a stale log. Every lane pays the same tax, because every lane runs its tests
# from a worktree and its compute from wherever it happens to be standing.
#
# WHAT THIS DOES, and deliberately nothing more (no policy, no retries, no slot
# logic -- `compute` owns all of that):
#   1. derives the primary checkout and invokes from there, so a `cd` in the caller
#      cannot break seat resolution;
#   2. converts the exit-0-shaped refusal into a real nonzero (70), so a caller that
#      checks the status cannot mistake "nothing ran" for "it passed".
#
# Usage:  bash scripts/compute-exec.sh --task <key> --timeout <N>m -- <argv...>
#
# Put any `cd` INSIDE the command after `--`. The wrapper's own cwd is the primary
# by construction; the command you pass keeps whatever directory it sets for itself.
set -uo pipefail

# The primary is the checkout that owns the common .git directory: a linked
# worktree's `--git-common-dir` points at the primary's, and its parent is the
# primary's root. This holds from the primary itself and from every linked
# worktree, which is the point -- a hardcoded path would be one machine's answer.
common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || {
  echo "compute-exec: not inside a git checkout; run from the repository" >&2
  exit 78
}
primary="$(dirname "$common")"

# NO ENROLLMENT CHECK HERE, deliberately. The first version refused when
# `<primary>/.tap` was absent, which was wrong twice over:
#
#   - it rejected SUPPORTED deployments. TAP's canonical resolution
#     (lib.sh:261-280) takes an explicit `TAP_HOME` first and the legacy
#     `<root>/tmp/tap` layout next, so a checkout with no `.tap` directory can be
#     perfectly enrolled and `compute` resolves its seat fine. The wrapper made
#     the convenience command unusable for those.
#   - it was redundant with the thing this wrapper exists to do. `compute` owns
#     enrollment resolution, and an unresolved seat now arrives as a loud 70
#     instead of a silent exit 0. Re-deciding it here could only disagree with
#     the authority.
#
# It also broke every CI run: the gate checks out a fresh tree with no `.tap`, so
# the check fired before the work started. Arms proven in an enrolled tree said
# nothing about the unenrolled tree the gate actually provides
# (a second reviewer reproduced it locally).

err="$(mktemp)" || exit 78
trap 'rm -f "$err"' EXIT

cd "$primary" || exit 78

# stdout is the command's and passes through untouched. stderr is CAPTURED to a
# file and relayed after exit, rather than teed through a process substitution.
#
# The first version of this used `2> >(tee "$err" >&2)` to keep stderr streaming.
# Measurement showed that pattern: bash does not wait for a process
# substitution, so when `compute exec` exits, `tee` can still owe bytes to $err
# and the grep below can win the race. With a tiny stderr it never lost in 300
# iterations; with 64KB of stderr and the marker at the end, it lost 1 in 300 --
# a refusal passing through as exit 0, intermittently and silently. That is this
# wrapper's own motivating bug reborn at low frequency, which is the one defect it
# must not have. Capture-and-relay has no race: the file is complete before the
# grep, because the redirect is the shell's own.
#
# The trade, stated because it is a real one: the caller sees this command's
# stderr at end-of-run instead of streamed. For the batch runs this wrapper is for
# -- `--task`/`--timeout` jobs whose output lands in a log -- that costs nothing.
compute exec "$@" 2>"$err"
rc=$?
cat "$err" >&2

# Anchored to the tool's own `compute: ` prefix on purpose. Unanchored, this also
# matched the TASK's stderr, which compute relays -- so a job whose own output
# contains this sentence would be reported as a refusal that never happened. The
# canonical collision is running this file's own smoke under the wrapper.
#
# FRAGILE COUPLING, deliberately accepted and therefore stated: this recognises a
# refusal by matching another tool's prose, because `compute` exits 0 on it and
# emits no other signal. If compute rewords that message, this wrapper silently
# returns to passing the refusal through. No in-repo test can pin it -- compute's
# prose lives outside this repository -- so re-derive the string from an OBSERVED
# refusal rather than from memory. The durable fix (a nonzero refusal) belongs to
# compute, not here.
if grep -q '^compute: Register with TAP before requesting compute' "$err" 2>/dev/null; then
  echo "compute-exec: compute refused to admit the job — reporting 70, not ${rc}." >&2
  echo "compute-exec: nothing ran, so any log the command was to write is UNCHANGED and stale." >&2
  exit 70
fi
exit "$rc"
