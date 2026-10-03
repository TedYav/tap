#!/usr/bin/env bash
# Archive eligibility, crash recovery, and both public read/show doors.
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
bash "$ROOT/runtime/bun/test/run.sh" "$ROOT/runtime/bun/test/bus-archive.test.ts"
echo 'bus-archive: ok'
