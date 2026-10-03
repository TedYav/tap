#!/usr/bin/env bash
# suite-slot-unlock.sh — clear a STALE smoke-all suite slot (dead holder only).
#
# Refuses if the lease pid is still alive. Does not kill the suite.
# Lock path: ${TAP_SUITE_LOCK_HOME:-$HOME/.tap/locks}/smoke-all.lock
#
# Named in the suite_slot_busy refusal text — must stay runnable as printed.
set -euo pipefail

usage() {
  cat <<'EOF'
suite-slot-unlock.sh — clear a STALE smoke-all suite slot (dead holder only).

Refuses (nonzero) while the lease pid is still alive; it never kills the
suite. Clears the stale lease only once the holder is dead.
Lock path: ${TAP_SUITE_LOCK_HOME:-$HOME/.tap/locks}/smoke-all.lock

Usage:
  suite-slot-unlock.sh          clear the slot if its holder is dead
  suite-slot-unlock.sh -h       show this help
EOF
}

# Accept exactly zero arguments or exactly one help flag; every other argv
# shape (an empty argument, trailing words) refuses before any mutation.
if [ "$#" -eq 1 ] && { [ "$1" = -h ] || [ "$1" = --help ]; }; then
  usage
  exit 0
fi
if [ "$#" -ne 0 ]; then
  printf 'suite-slot-unlock: unknown argument: %s\n' "$*" >&2
  printf 'usage: suite-slot-unlock.sh [-h]\n' >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="${TAP_PYTHON:-python3}"

exec "$PY" -I -B -c '
import sys
sys.path.insert(0, sys.argv[1])
import suite_slot
rc, msg = suite_slot.unlock()
print(msg, file=sys.stderr if rc else sys.stdout)
raise SystemExit(rc)
' "$ROOT/scripts"
