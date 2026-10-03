#!/usr/bin/env bash
# Exercise preview rendering through native and Bash wrapper paths.
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
bash "$ROOT/runtime/bun/test/run.sh" "$ROOT/runtime/bun/test/sentinel-preview.test.ts"
echo 'sentinel-preview: ok'
