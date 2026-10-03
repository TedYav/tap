#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
# shellcheck source=skills/tap/scripts/smoke/runtime-helpers.sh
. "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"

[ "$(tap_harness_family cursor-agent)" = "cursor" ] || { echo "derive-handle: cursor-agent -> cursor family" >&2; exit 1; }
[ "$(tap_harness_family node)" = "node" ] || { echo "derive-handle: node stays node" >&2; exit 1; }

echo "derive-handle: ok"
