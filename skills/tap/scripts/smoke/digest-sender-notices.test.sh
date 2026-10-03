#!/usr/bin/env bash
# The digest owner is native; preserve this focused smoke entry at its owner.
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
exec bash "$ROOT/runtime/bun/test/run.sh" "$ROOT/runtime/bun/test/spool-drain-effects.test.ts" --test-name-pattern 'digest sender notices'
