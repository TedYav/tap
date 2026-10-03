#!/usr/bin/env bash
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
bash "$ROOT/runtime/bun/test/run.sh" "$ROOT/runtime/bun/test/pending-reservation.test.ts"
