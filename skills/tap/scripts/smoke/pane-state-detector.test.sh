#!/usr/bin/env bash
# pane-state-detector.test.sh — B1 focused controls for classifyPane + copy-mode.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
RUNTIME="$ROOT/runtime/bun"
BUN="${TAP_SMOKE_BUN:-$(command -v bun 2>/dev/null || true)}"

[ -n "$BUN" ] && [ -x "$BUN" ] || { echo "pane-state-detector: Bun executable unavailable" >&2; exit 1; }

"$RUNTIME/test/run.sh" test/pane-state.test.ts
# Mutants prove RED against a copy of their own scratch tree, which they first
# run unmodified (baseline green). This repo-tree run is not that baseline.
"$RUNTIME/test/pane-state-mutants.test.sh"
echo "pane-state-detector: ok"
