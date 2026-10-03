#!/usr/bin/env bash
# prose-eval-lint-corpus.test.sh — red fixtures for the prose→eval lint.
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

echo "# prose-eval-lint-corpus: planted bomb + stale allowlist must red"
cd "$HERE"
if "$PY" "$HERE/prose_eval_lint_corpus.py"; then
  echo "PASS prose-eval-lint-corpus"
else
  echo "FAIL prose-eval-lint-corpus — see above." >&2
  exit 1
fi
