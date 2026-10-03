#!/usr/bin/env bash
# Public native withdraw: receipt provenance, resident payload, recipient tombstone.
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$ROOT"
bash runtime/bun/test/run.sh runtime/bun/test/withdraw.test.ts
