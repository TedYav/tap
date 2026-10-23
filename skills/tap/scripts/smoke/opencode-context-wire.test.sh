#!/usr/bin/env bash
# D5: public — real OpenCode 2 TUI with the staged plugin; assertions inspect model requests and native session state.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
BUN="${TAP_SMOKE_BUN:-$(command -v bun 2>/dev/null || true)}"
[ -n "$BUN" ] || { echo "SMOKE-SKIP: Bun absent; OpenCode wire test requires Bun"; exit 0; }
command -v opencode >/dev/null 2>&1 || { echo "SMOKE-SKIP: OpenCode absent; plugin logic remains covered by opencode-session-start.test.ts"; exit 0; }
version="$(opencode --version)"
[[ "$version" =~ ^(opencode[[:space:]]+)?v?2\. ]] || { echo "SMOKE-SKIP: OpenCode 2.x required for the wire test; installed version is $version"; exit 0; }
exec "$BUN" "$ROOT/runtime/bun/test/support/opencode-wire.ts"
