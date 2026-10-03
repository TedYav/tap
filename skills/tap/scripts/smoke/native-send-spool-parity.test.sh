#!/usr/bin/env bash
# Public native/Bash doors share park, reply-evidence and recovery semantics.
# The focused selection excludes historical native fixture work owned separately.
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
. "$ROOT/scripts/serial-trigger.sh"
tap_serial_triggers "runtime/bun/" "skills/tap/scripts/"
cd "$ROOT"
bash runtime/bun/test/run.sh \
  "$ROOT/runtime/bun/test/send-note-guard.test.ts" \
  "$ROOT/runtime/bun/test/send-cutover-spool.test.ts" \
  "$ROOT/runtime/bun/test/send-cutover-redelivery.test.ts" \
  "$ROOT/runtime/bun/test/send-census-bounds.test.ts" \
  "$ROOT/runtime/bun/test/send-census-fences-routing.test.ts" \
  "$ROOT/runtime/bun/test/reply-obligations-fences.test.ts" \
  "$ROOT/runtime/bun/test/send-queued-codex.test.ts" \
  --test-name-pattern 'bin/tap sandbox route evidence|native cutover shared-spool parity|clear fence|busy-pane native|copy-mode native|poll-recipient send|harness-queued direct send'
