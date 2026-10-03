#!/usr/bin/env bash
# Shell adapter keeps the complete Bun suite in smoke-all's discovery and isolation.
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
. "$ROOT/scripts/serial-trigger.sh"
tap_serial_triggers "runtime/bun/" "bin/" "scripts/" "skills/tap/" ".github/workflows/"
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
cd "$ROOT/runtime/bun"
# Discover every test, including new files, against this checkout's Bash oracle.
# Preserve the gate's passing-row marker without rewriting failures or skips.
TAP_POC_REF_BIN="$ROOT/scripts/tap.sh" "$ROOT/runtime/bun/test/run.sh" 2>&1 | sed '/^(pass) /s/$/: ok/'
