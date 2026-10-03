#!/usr/bin/env bash
# scratch-teardown.test.sh — control for scratch-teardown-lib.sh's EXIT trap (tap-1q3cw).
#
# The trap runs under the caller's `set -e`. A failing rm must not abort it: FAKE_BIN is
# still removed, a nonzero saved status (test failure, 2, 130) exits unchanged, and a
# surviving root turns an otherwise-green run into exit 1. Each case runs the REAL trap in
# a `bash -e` child with a PATH-shimmed rm that fails only for the TAP_HOME target.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CTL="$(mktemp -d)"
trap 'rm -rf "${CTL:?}"' EXIT
REAL_RM="$(command -v rm)"
BASH_BIN="$(command -v bash)"
mkdir -p "$CTL/shim"
printf '%s\n' '#!/bin/sh' 'for a in "$@"; do [ "$a" = "$SHIM_FAIL" ] && exit 1; done' 'exec "$REAL_RM" "$@"' > "$CTL/shim/rm"
chmod +x "$CTL/shim/rm"

# case <name> <saved-exit> <fail-home: 1|0> <want-exit> <want-home-gone: 1|0>
run_case() {
  local name="$1" saved="$2" failhome="$3" want="$4" wanthome="$5" home fake got=0
  home="$CTL/$name-home"; fake="$CTL/$name-fake"
  mkdir -p "$home" "$fake"
  SHIM_FAIL="" ; [ "$failhome" = 1 ] && SHIM_FAIL="$home"
  PATH="$CTL/shim:$PATH" SHIM_FAIL="$SHIM_FAIL" REAL_RM="$REAL_RM" TAP_HOME="$home" FAKE_BIN="$fake" LIB="$HERE/scratch-teardown-lib.sh" SAVED="$saved" \
    bash -e -c '. "$LIB"; trap scratch_trap EXIT; exit "$SAVED"' 2>"$CTL/$name.err" || got=$?
  [ "$got" = "$want" ] || { echo "scratch-teardown: $name: exit $got, want $want" >&2; cat "$CTL/$name.err" >&2; exit 1; }
  [ ! -e "$fake" ] || { echo "scratch-teardown: $name: FAKE_BIN survived a failed TAP_HOME rm" >&2; exit 1; }
  if [ "$wanthome" = 1 ] && [ -e "$home" ]; then echo "scratch-teardown: $name: TAP_HOME survived" >&2; exit 1; fi
  if [ "$wanthome" = 0 ] && [ ! -e "$home" ]; then echo "scratch-teardown: $name: shim did not hold TAP_HOME" >&2; exit 1; fi
  echo "scratch-teardown: $name: ok"
}
run_case green        0 0 0 1
run_case fail-clean   2 0 2 1
run_case interrupted  130 0 130 1
run_case rm-fails-ok  0 1 1 0
run_case rm-fails-2   2 1 2 0
run_case rm-fails-int 130 1 130 0

# --- lsof failure modes: the trap must still finish, quickly, and remove both roots ---
# run_lsof_case <name> <path-for-child> <want: max elapsed seconds> [ENV=VAL ...]
run_lsof_case() {
  local name="$1" childpath="$2" max="$3" home fake started got=0
  shift 3
  home="$CTL/$name-home"; fake="$CTL/$name-fake"
  mkdir -p "$home" "$fake"
  started=$SECONDS
  env PATH="$childpath" "$@" TAP_PYTHON="$(command -v python3)" TAP_HOME="$home" FAKE_BIN="$fake" LIB="$HERE/scratch-teardown-lib.sh" \
    "$BASH_BIN" -e -c '. "$LIB"; trap scratch_trap EXIT; exit 0' 2>"$CTL/$name.err" || got=$?
  [ "$got" = 0 ] || { echo "scratch-teardown: $name: exit $got" >&2; cat "$CTL/$name.err" >&2; exit 1; }
  [ $((SECONDS - started)) -le "$max" ] || { echo "scratch-teardown: $name: took $((SECONDS - started))s, want <= ${max}s" >&2; cat "$CTL/$name.err" >&2; exit 1; }
  [ ! -e "$home" ] && [ ! -e "$fake" ] || { echo "scratch-teardown: $name: a scratch root survived" >&2; exit 1; }
  echo "scratch-teardown: $name: ok ($((SECONDS - started))s)"
}
# A stalled lsof: dies at the 1 s per-call deadline, teardown ends at the 5 s overall bound
# (it would take the shim's full 25 s without the per-call bound).
mkdir -p "$CTL/hang"
printf '%s\n' '#!/bin/sh' 'exec sleep 25' > "$CTL/hang/lsof"
chmod +x "$CTL/hang/lsof"
run_lsof_case lsof-hangs "$CTL/hang:$PATH" 15 SCRATCH_SETTLE_BOUND=5 SCRATCH_LSOF_DEADLINE=1
# No lsof at all, and nothing on PATH but what the trap needs: a short fixed wait, not the
# 8 s bound (the loop would spend all of it on exit-127 samples).
mkdir -p "$CTL/minbin"
for tool in rm sleep seq; do ln -s "$(command -v "$tool")" "$CTL/minbin/$tool"; done
run_lsof_case lsof-absent "$CTL/minbin" 5 SCRATCH_SETTLE_BOUND=8 SCRATCH_NOLSOF_WAIT=1
echo "scratch-teardown: ok"
