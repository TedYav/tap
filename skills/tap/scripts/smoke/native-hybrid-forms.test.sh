#!/usr/bin/env bash
# Native hybrid forms and preserved Bash authority/roster boundaries.
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
. "$ROOT/scripts/serial-trigger.sh"
tap_serial_triggers "runtime/bun/" "skills/tap/scripts/"
cd "$ROOT"
bash runtime/bun/test/run.sh runtime/bun/test/hybrid-forms.test.ts runtime/bun/test/selector.test.ts
