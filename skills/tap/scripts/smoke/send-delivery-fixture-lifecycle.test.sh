#!/usr/bin/env bash
# The shared send-delivery fixture module must survive the supported multi-file
# caller: run.sh executes selected files in ONE process, so the second file's
# first fixture() has to recreate the scratch tree the first file's afterAll
# removed. Select one original case from each file plus the lifecycle check;
# the pool runs their full coverage independently.
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
. "$ROOT/scripts/serial-trigger.sh"
tap_serial_triggers "runtime/bun/" "skills/tap/scripts/"
cd "$ROOT"
bash runtime/bun/test/run.sh \
  "$ROOT/runtime/bun/test/send-delivery-no-spool.test.ts" \
  "$ROOT/runtime/bun/test/send-delivery-router.test.ts" \
  --test-name-pattern 'a live clearing fence refuses with the fence.s detail|the class conflicts refuse natively|the shared fixture recreates its scratch root'
