#!/usr/bin/env bash
# Public native resend ownership, original retention and one successor attempt.
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$ROOT"
bash runtime/bun/test/run.sh runtime/bun/test/resend-flip.test.ts
