#!/usr/bin/env bash
# D5: path-reference — submit-phases.test.sh:5: one-command launcher whose single run.sh dispatch covers the owner tests (runtime/bun/src/submit-phase.test.ts among them); the src reference is a runner argument naming the module's owner test, the shell side asserts nothing
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
bash "$ROOT/runtime/bun/test/run.sh" "$ROOT/runtime/bun/src/submit-phase.test.ts" "$ROOT/runtime/bun/test/submit-phases.test.ts" "$ROOT/runtime/bun/test/submit-visible.test.ts" "$ROOT/runtime/bun/test/approval-delivery.test.ts"
