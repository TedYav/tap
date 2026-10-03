#!/usr/bin/env bash
# Public refusals must advise a remedy that fits the original's current custody.
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$ROOT"
bash runtime/bun/test/run.sh runtime/bun/test/resend-guard.test.ts --test-name-pattern 'public refusal advice follows terminality'
