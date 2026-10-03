#!/usr/bin/env bash
# read-integrity.test.sh — tap read settlement integrity (F1) + epoch record (D4).
# Only the addressee settles; the .done carries actor + session_epoch (consumed by
# /tap-discuss's WU8 seal predicate); replay fails loud with the actor's open obligations.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
TAP_HOME="$(mktemp -d)"; trap 'rm -rf "$TAP_HOME"' EXIT; export TAP_HOME
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"

cat > "$TAP_HOME/payloads/edge-1.md" <<'EOF'
---
id: edge-1
from: claude
to: codex
kind: terminal
reply: settle-only
path: tmp/tap/payloads/edge-1.md
---

terminal edge
EOF

# 1. a non-recipient cannot settle (external process: die exits it, `if` catches)
if "$TAP" read edge-1 --by alice >/dev/null 2>&1; then
  echo "read-integrity: non-recipient settled (should be rejected)" >&2; exit 1
fi
[ -e "$TAP_HOME/receipts/edge-1.done" ] && { echo "read-integrity: .done written by non-recipient" >&2; exit 1; }

# 2. no actor at all (no --by, no TAP_SELF) is rejected on the first settle
if env -u TAP_SELF "$TAP" read edge-1 >/dev/null 2>&1; then
  echo "read-integrity: actorless first-settle accepted (should be rejected)" >&2; exit 1
fi
[ -e "$TAP_HOME/receipts/edge-1.done" ] && { echo "read-integrity: actorless first-settle wrote .done" >&2; exit 1; }

# 3. unsafe actor token is rejected before settlement
if "$TAP" read edge-1 --by 'co dex' >/dev/null 2>&1; then
  echo "read-integrity: invalid actor token accepted" >&2; exit 1
fi
[ -e "$TAP_HOME/receipts/edge-1.done" ] && { echo "read-integrity: invalid actor wrote .done" >&2; exit 1; }

# 4. payload envelope id must match the filename before settlement
cat > "$TAP_HOME/payloads/bad-id.md" <<'EOF'
---
id: other-id
from: claude
to: codex
kind: terminal
reply: settle-only
path: tmp/tap/payloads/bad-id.md
---

bad id
EOF
if "$TAP" read bad-id --by codex >/dev/null 2>&1; then
  echo "read-integrity: mismatched envelope id settled" >&2; exit 1
fi
[ ! -f "$TAP_HOME/receipts/bad-id.done" ] || { echo "read-integrity: mismatched id wrote .done" >&2; exit 1; }

# 5. the recipient settles; actor + epoch are recorded and the human receipt is explicit.
"$TAP" read edge-1 --by codex --epoch 3 >"$TAP_HOME/done.out"
grep -Eq '^tap read: note .* settled$' "$TAP_HOME/done.out" || { echo "read-integrity: successful settlement receipt missing" >&2; cat "$TAP_HOME/done.out" >&2; exit 1; }
grep -q '"by":"codex"' "$TAP_HOME/receipts/edge-1.done" || { echo "read-integrity: actor not recorded" >&2; exit 1; }
grep -q '"epoch":"3"'  "$TAP_HOME/receipts/edge-1.done" || { echo "read-integrity: epoch not recorded" >&2; exit 1; }
python3 - "$TAP_HOME/receipts/edge-1.done" <<'PY' \
  || { echo "read-integrity: plain done receipt provenance wrong" >&2; cat "$TAP_HOME/receipts/edge-1.done" >&2; exit 1; }
import json, sys
r = json.load(open(sys.argv[1]))
assert r["via"] == "read", r
assert not any(k.startswith("reply_") for k in r), r
PY
before_replay="$(cat "$TAP_HOME/receipts/edge-1.done")"

# 6. A stale settle attempt fails loud, names the original time + current open
# obligation, and never rewrites the authoritative receipt.
cat > "$TAP_HOME/payloads/edge-open.md" <<'EOF'
---
id: edge-open
from: claude
to: codex
kind: discuss
path: tmp/tap/payloads/edge-open.md
---

still open
EOF
settled_at="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["at"])' "$TAP_HOME/receipts/edge-1.done")"
rc=0
printf 'replay\n' > "$TAP_HOME/replay-body.md"
"$TAP" reply edge-1 --by codex -f "$TAP_HOME/replay-body.md" >"$TAP_HOME/replay.out" 2>&1 || rc=$?
[ "$rc" -eq 1 ] || { echo "read-integrity: settled replay should fail, got $rc" >&2; cat "$TAP_HOME/replay.out" >&2; exit 1; }
grep -Fq "id edge-1 already settled at $settled_at; you have" "$TAP_HOME/replay.out" && grep -Fq "edge-open" "$TAP_HOME/replay.out" \
  || { echo "read-integrity: settled replay did not surface the open obligation" >&2; cat "$TAP_HOME/replay.out" >&2; exit 1; }
after_replay="$(cat "$TAP_HOME/receipts/edge-1.done")"
[ "$after_replay" = "$before_replay" ] || { echo "read-integrity: refused replay rewrote receipt" >&2; exit 1; }

echo "read-integrity: ok"
