#!/usr/bin/env bash
# token-safety.test.sh — route/sentinel tokens validated + receipts are valid JSON
# (codex P1). A quote/space in from/to/kind/--by/register-name is rejected before it
# can break the one-line sentinel grammar; an arbitrary --epoch is JSON-escaped so the
# .done stays parseable (WU8's seal predicate depends on it).
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
TAP_HOME="$(mktemp -d)"; trap 'rm -rf "$TAP_HOME"' EXIT; export TAP_HOME
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"

cat > "$TAP_HOME/payloads/edge.md" <<'EOF'
---
id: edge
from: claude
to: codex
kind: discuss
reply: settle-only
path: tmp/tap/payloads/edge.md
---

body
EOF

# 1. a quote-bearing --from is rejected (before pane resolution)
if "$TAP" send claude "$TAP_HOME/payloads/edge.md" --from 'codex"bad' --kind review --id s1 --pane fake >/dev/null 2>&1; then
  echo "token-safety: quote-bearing --from was not rejected" >&2; exit 1
fi
# 2. a spaced --from is rejected
if "$TAP" send claude "$TAP_HOME/payloads/edge.md" --from 'co dex' --kind review --id s2 --pane fake >/dev/null 2>&1; then
  echo "token-safety: spaced --from was not rejected" >&2; exit 1
fi
# 3. a spaced positional to is rejected
if "$TAP" send 'clau de' "$TAP_HOME/payloads/edge.md" --from codex --kind review --id s3 --pane fake >/dev/null 2>&1; then
  echo "token-safety: spaced to was not rejected" >&2; exit 1
fi
# 4. a spaced --kind is rejected
if "$TAP" send claude "$TAP_HOME/payloads/edge.md" --from codex --kind 'needs review' --id s4 --pane fake >/dev/null 2>&1; then
  echo "token-safety: spaced --kind was not rejected" >&2; exit 1
fi
# 5. a spaced --by is rejected before settlement
if "$TAP" read edge --by 'co dex' >/dev/null 2>&1; then
  echo "token-safety: spaced --by was not rejected" >&2; exit 1
fi
[ ! -f "$TAP_HOME/receipts/edge.done" ] || { echo "token-safety: invalid --by wrote .done" >&2; exit 1; }
# 6. an invalid register name is rejected
# tap-zty8 exemption: expected invalid-handle refusal.
if "$TAP" register 'bad name' --pane fake >/dev/null 2>&1; then
  echo "token-safety: invalid register name was not rejected" >&2; exit 1
fi
# 7. a quote-bearing --epoch is JSON-escaped → .done is valid + round-trips
"$TAP" read edge --by codex --epoch 'e"2'
python3 -m json.tool "$TAP_HOME/receipts/edge.done" >/dev/null || { echo "token-safety: .done is not valid JSON" >&2; exit 1; }
python3 - "$TAP_HOME/receipts/edge.done" <<'PY' || { echo "token-safety: epoch/by did not round-trip" >&2; exit 1; }
import json, sys
d = json.load(open(sys.argv[1]))
sys.exit(0 if d.get("epoch") == 'e"2' and d.get("by") == "codex" else 1)
PY

echo "token-safety: ok"
