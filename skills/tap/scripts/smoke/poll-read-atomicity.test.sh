#!/usr/bin/env bash
# A readiness file whose content is read must appear only after that content is complete.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"
# shellcheck source=skills/tap/scripts/smoke/smoke-preflight.sh
. "$HERE/smoke-preflight.sh"
smoke_preflight_check || exit 1
PY="${TAP_PYTHON:-$(smoke_resolve_python)}"
smoke_assert_python "$PY" || exit 1

"$PY" -B "$HERE/poll_read_atomicity.py" "$ROOT"
"$PY" -B "$HERE/poll_read_atomicity.py" "$ROOT" --self-test
echo "poll-read-atomicity: ok"
