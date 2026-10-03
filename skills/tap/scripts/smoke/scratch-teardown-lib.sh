# scratch-teardown-lib.sh — sourced by exit-5-pending.test.sh and its teardown control.
#
# A smoke that sends an rc=5 leaves a detached deliver process and its spool-engine worker
# writing claim/meta files under the scratch root for a few seconds after every assertion
# passes, so a bare `rm -rf` races them ("Directory not empty", tap-1q3cw).
#
#   settle_scratch  waits (SCRATCH_SETTLE_BOUND, default 30 s of wall clock) until lsof has
#                   said "nothing open under the root" on two consecutive samples. A sample
#                   counts only on lsof exit 1 with no stdout AND no stderr; any other
#                   answer (an error, 127, or the per-call deadline) resets the streak. Two
#                   samples because the workers open, write and close in bursts. Each lsof
#                   call has its own hard deadline (SCRATCH_LSOF_DEADLINE, default 5 s) via
#                   scratch_bounded, so a stalled tree walk cannot hang the trap. Without
#                   lsof (not a documented prerequisite) it does one `command -v` check,
#                   notes it on stderr, and waits a short fixed SCRATCH_NOLSOF_WAIT
#                   (default 3 s, the observed writer tail) instead of sleeping the bound.
#   scratch_trap    the EXIT trap: settle, then ONE guarded rm per root (no loop). Each rm's
#                   failure is captured so `set -e` cannot abort the trap; both roots are
#                   always attempted. A nonzero saved status (a test failure, 2, 130) exits
#                   unchanged; otherwise a failed rm or a surviving root exits 1.
#
# Callers set TAP_HOME and FAKE_BIN (absolute scratch roots) before installing the trap.

# scratch_bounded <seconds> <cmd...> — run cmd with a hard wall bound; exit 124 at the bound.
# Same mechanism as smoke_bounded in scripts/smoke-all.sh (tap-4df9t), which is not
# sourceable: it kills only its own recorded child, never by pattern, abandons a child stuck
# past SIGKILL, and keeps child stdout in an unlinked file so an abandoned child cannot hold
# a $(...) pipe open.
scratch_bounded() {
  local s="$1"
  shift
  "${TAP_PYTHON:-python3}" -I -B -c 'import os, subprocess, sys, tempfile
bound = float(sys.argv[1])
with tempfile.TemporaryFile() as out:
    try:
        p = subprocess.Popen(sys.argv[2:], stdout=out)
    except OSError as exc:
        print("scratch_bounded: exec failed: %s" % exc, file=sys.stderr)
        raise SystemExit(127)
    try:
        rc = p.wait(timeout=bound)
    except subprocess.TimeoutExpired:
        p.kill()
        try:
            p.wait(timeout=1)
        except subprocess.TimeoutExpired:
            os._exit(124)
        rc = 124
    out.seek(0)
    sys.stdout.buffer.write(out.read())
    sys.stdout.buffer.flush()
    raise SystemExit(rc)' "$s" "$@"
}
settle_scratch() {
  local rc out streak=0 err="$FAKE_BIN/lsof.err" deadline
  if ! command -v lsof >/dev/null 2>&1; then
    echo "scratch-teardown: lsof not found; waiting a fixed ${SCRATCH_NOLSOF_WAIT:-3}s for the writers instead" >&2
    sleep "${SCRATCH_NOLSOF_WAIT:-3}"
    return 0
  fi
  deadline=$((SECONDS + ${SCRATCH_SETTLE_BOUND:-30}))
  while [ "$SECONDS" -lt "$deadline" ]; do
    rc=0; out="$(scratch_bounded "${SCRATCH_LSOF_DEADLINE:-5}" lsof +D "$TAP_HOME" 2>"$err")" || rc=$?
    if [ "$rc" = 1 ] && [ -z "$out" ] && [ ! -s "$err" ]; then
      streak=$((streak + 1))
      if [ "$streak" -ge 2 ]; then return 0; fi
    else
      streak=0
    fi
    sleep 0.5
  done
  echo "scratch-teardown: children still hold files under $TAP_HOME after ${SCRATCH_SETTLE_BOUND:-30}s (or lsof was unusable); removing anyway" >&2
}
scratch_trap() {
  local rc=$? home_rc=0 fake_rc=0
  settle_scratch
  rm -rf "${TAP_HOME:?}" || home_rc=$?
  rm -rf "${FAKE_BIN:?}" || fake_rc=$?
  if [ "$rc" = 0 ]; then
    if [ "$home_rc" != 0 ] || [ -e "$TAP_HOME" ]; then echo "scratch-teardown: could not remove $TAP_HOME" >&2; rc=1; fi
    if [ "$fake_rc" != 0 ] || [ -e "$FAKE_BIN" ]; then echo "scratch-teardown: could not remove $FAKE_BIN" >&2; rc=1; fi
  fi
  exit "$rc"
}
