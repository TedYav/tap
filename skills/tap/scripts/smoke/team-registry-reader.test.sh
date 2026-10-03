#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$ROOT"
bash runtime/bun/test/run.sh runtime/bun/test/registry-reader.test.ts
bash runtime/bun/test/run.sh runtime/bun/test/team.test.ts --test-name-pattern 'shipped team projects registry natively|invalid index, unreachable acting file|scalar team or roster axes' --timeout 20000
