#!/usr/bin/env bash
# Kernel-lock portability and cleanup refusal controls (tap-7r3fn.40/.50).
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
cd "$ROOT/runtime/bun"
# Select the primitive controls: the remaining unit3 tests exercise courier
# authorization and registry fixtures, outside this platform adapter's scope.
bash test/run.sh test/unit3-lock.test.ts -t 'exclusivity|obligation settlement serialization|Bash and Bun|the kernel owns liveness|mutual exclusion under a REAL race|the platform premise|the lock root'
bash test/run.sh test/scratch-cleanup.test.ts
