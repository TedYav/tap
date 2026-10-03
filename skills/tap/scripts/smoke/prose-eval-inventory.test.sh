#!/usr/bin/env bash
# focused-inventory: tree (tap-z5nl6)
# prose-eval-inventory.test.sh — mechanical prose→eval sweep (tap-psif class).
# Enumerate-then-classify: every unquoted executable-writing heredoc with bare
# ` or $( is fixed or allowlisted with a named reason; stale allowlist fails.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=skills/tap/scripts/smoke/smoke-preflight.sh
. "$HERE/smoke-preflight.sh"
smoke_preflight_check || exit 1
PY="${TAP_PYTHON:-$(smoke_resolve_python)}"
smoke_assert_python "$PY" || exit 1

echo "# prose-eval-inventory: unquoted executable heredocs with bare eval forms"
if "$PY" "$HERE/prose_eval_lint.py"; then
  echo "PASS prose-eval-inventory"
else
  echo "FAIL prose-eval-inventory — unclassified hit or stale allowlist (see above)." >&2
  exit 1
fi
