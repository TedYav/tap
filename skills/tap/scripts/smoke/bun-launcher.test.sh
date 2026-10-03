#!/usr/bin/env bash
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
echo 'bun-launcher: run this file; do not source it' >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
bash "$ROOT/runtime/bun/test/run.sh" "$ROOT"/runtime/bun/test/launcher-*.test.ts
echo 'bun-launcher: native launcher tests passed'
