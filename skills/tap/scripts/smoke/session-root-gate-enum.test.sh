#!/usr/bin/env bash
# D5: source-read — :22-38: grep-reads module source for invariants; no module behavior is exec'd or asserted
# session-root-gate-enum.test.sh — make the "all five adapters fixed" claim
# un-regressible (round 5 completeness instrument).
#
# Every hooks/ line naming registry.json (any language / construction), and
# every line of the native SessionStart entry, must be a comment. The pre-flip
# bus-registry presence gate is gone (an absent marker has no enrolled root),
# so no adapter may gate on a bus registry file. A sixth adapter or a re-added
# presence check fails loudly.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$ROOT"

fail() { echo "session-root-gate-enum: $1" >&2; exit 1; }

# The zero below licenses a pass, so the instrument must be able to refuse:
# prove grep can read the entry it is meant to scan.
grep -q 'resolveSessionAuthority' runtime/bun/src/session-start.ts \
  || fail "cannot read runtime/bun/src/session-start.ts — the scan would pass vacuously"
unsanctioned=0
while IFS= read -r rec; do
  [ -n "$rec" ] || continue
  file="${rec%%:*}"
  rest="${rec#*:}"
  lineno="${rest%%:*}"
  body="${rest#*:}"
  trimmed="$(printf '%s' "$body" | sed 's/^[[:space:]]*//')"
  case "$trimmed" in '#'*|'//'*|'*'*) continue ;; esac
  echo "  UNSANCTIONED ${file}:${lineno}  ${trimmed:0:72}" >&2
  unsanctioned=$((unsanctioned + 1))
done < <(grep -rn 'registry\.json' hooks/ runtime/bun/src/session-start.ts)

[ "$unsanctioned" -eq 0 ] \
  || fail "adapter gates on registry.json: $unsanctioned (want 0)"

echo "session-root-gate-enum: 0 adapter gates on registry.json: ok"
echo "session-root-gate-enum: all checks passed"
