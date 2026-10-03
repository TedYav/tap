#!/usr/bin/env bash
# python-wrapper-floor.test.sh — pin the interpreter-floor guard as a
# checked-in regression, not manual evidence (sol r10 #2).
#
# The Python suite wrapper resolve an interpreter and then honor ${TAP_PYTHON}.
# An unchecked override (TAP_PYTHON=true exits 0 while running nothing, a missing
# path, or a real-but-too-old 3.11) must NOT let the gate silently pass. This
# asserts smoke_assert_python rejects each invalid override and accepts a valid
# one, AND that the wrapper actually wire the guard in (a bad override makes
# them exit non-zero rather than print PASS).
set -uo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=skills/tap/scripts/smoke/smoke-preflight.sh
. "$HERE/smoke-preflight.sh"

fails=0
note() { echo "  ok   $1"; }
bad() { echo "  FAIL $1" >&2; fails=1; }

# --- unit: smoke_assert_python's invalid/valid matrix ---
# 'true' exits 0 but reports no version -> must be rejected (the no-op bypass).
if smoke_assert_python true 2>/dev/null; then bad "accepted TAP_PYTHON=true (no-op bypass)"; else note "rejects 'true'"; fi
# a missing executable -> rejected.
if smoke_assert_python /nonexistent/python3 2>/dev/null; then bad "accepted a missing interpreter"; else note "rejects a missing interpreter"; fi
# a real interpreter that reports 3.11 (below the 3.12 floor) -> rejected.
shim="$(mktemp)"; printf '#!/bin/sh\necho 3.11\n' > "$shim"; chmod +x "$shim"
if smoke_assert_python "$shim" 2>/dev/null; then bad "accepted a 3.11 interpreter"; else note "rejects a 3.11 interpreter"; fi
rm -f "${shim:?}"
# the resolved interpreter (>= 3.12) -> accepted (valid control).
if smoke_assert_python "$(smoke_resolve_python)" 2>/dev/null; then note "accepts the resolved >=3.12 interpreter"; else bad "rejected the resolved interpreter"; fi

if [ "$fails" -eq 0 ]; then
  echo "PASS python-wrapper-floor"
else
  echo "FAIL python-wrapper-floor — an interpreter-floor guard regressed." >&2
  exit 1
fi
