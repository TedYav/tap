#!/usr/bin/env bash
# U3 native/public reader parity and mutation controls.
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
. "$ROOT/scripts/serial-trigger.sh"
tap_serial_triggers "runtime/bun/" "skills/tap/scripts/"
cd "$ROOT"
bash runtime/bun/test/run.sh \
  runtime/bun/test/stdio.test.ts \
  runtime/bun/test/agent-state.test.ts \
  runtime/bun/test/seat-activity.test.ts \
  runtime/bun/test/agy-band-characterization.test.ts \
  runtime/bun/test/readers-router.test.ts \
  runtime/bun/test/read-native.test.ts \
  runtime/bun/test/show-native.test.ts \
  runtime/bun/test/outstanding-native.test.ts
# The filtered module still initializes its other reference constants. Pin
# those to this same checkout too; CI has no installed TAP oracle.
TAP_POC_REF_BIN="$ROOT/scripts/tap.sh" \
bash runtime/bun/test/run.sh runtime/bun/test/differential.test.ts --test-name-pattern "poll BYTE fidelity"
bash runtime/bun/test/readers-mutants.test.sh
# Keep the public spool status remedy executable without running owner mutations.
bash runtime/bun/test/run.sh runtime/bun/test/spool.test.ts --test-name-pattern "status reports the owner"
