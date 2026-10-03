#!/usr/bin/env bash
# Finite child custody, cancellation, explicit kill, and observation outcomes.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo 'do not source; run through scripts/smoke-all.sh --only' >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
bash "$ROOT/runtime/bun/test/run.sh" "$ROOT/runtime/bun/test/remind-job.test.ts"
