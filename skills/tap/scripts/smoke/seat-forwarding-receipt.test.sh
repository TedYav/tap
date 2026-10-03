#!/usr/bin/env bash
if [ "${BASH_SOURCE[0]}" != "$0" ]; then return 1; fi
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
bash "$ROOT/runtime/bun/test/run.sh" "$ROOT/runtime/bun/test/forwarding-receipt.test.ts"
