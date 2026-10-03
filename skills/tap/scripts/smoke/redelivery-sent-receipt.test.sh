#!/usr/bin/env bash
# Single redelivery's receipt, event, lost-response and write-failure controls
# live with the native submit/custody owner. Includes independent receipt/event
# deletion mutants; the former shell hook no longer exists.
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
exec bash "$ROOT/runtime/bun/test/run.sh" "$ROOT/runtime/bun/test/spool-drain-effects.test.ts"
