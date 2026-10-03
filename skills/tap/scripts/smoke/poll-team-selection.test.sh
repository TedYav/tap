#!/usr/bin/env bash
# `--team` must beat the cwd enrollment walk for a pane-less caller (tap-7rkcc).
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$ROOT"
bash runtime/bun/test/run.sh runtime/bun/test/poll-team-selection.test.ts
