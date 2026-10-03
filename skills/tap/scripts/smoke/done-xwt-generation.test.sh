#!/usr/bin/env bash
# read-xwt-generation.test.sh — cross-worktree read must mark the
# SENDER bus generation reused, leaving the recipient bus pristine (sol 053713).
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export TAP_SCRATCH_ONLY="$WORK"

SENDER="$WORK/sender/.tap/bus"
RECIP="$WORK/recip/.tap/bus"
mkdir -p "$SENDER/payloads" "$SENDER/receipts" "$RECIP/payloads" "$RECIP/receipts"

# Both buses post-reset pristine (distinct bundle ids).
printf '%s\n' '{"bundle_id":"sender-bundle","state":"pristine"}' > "$SENDER/reset-generation.json"
printf '%s\n' '{"bundle_id":"recip-bundle","state":"pristine"}' > "$RECIP/reset-generation.json"

# Recipient registry: local settler.
printf '%s\n' '{"schema": "0.20", "team":{"name":"recip"},"seats":{"alice":{"status":"active","delivery":"poll","harness":"daemon"}}}' \
  > "$RECIP/registry.json"

# Cross-worktree payload lives on the SENDER bus, addressed to alice.
ID="sender-20260728T000000Z-xwtgen01"
cat > "$SENDER/payloads/$ID.md" <<EOF
---
id: $ID
from: bob
to: alice
kind: task
reply: settle-only
cross_worktree: true
from_team: sender
to_team: recip
path: $SENDER/payloads/$ID.md
---
cross-bus settle probe
EOF

# Settle from the recipient bus with --payload pointing at the sender canonical.
export TAP_HOME="$RECIP"
"$TAP" read "path=$SENDER/payloads/$ID.md" --by alice >/dev/null \
  || { echo "read-xwt-generation: settle failed" >&2; exit 1; }

[ -f "$SENDER/receipts/$ID.done" ] \
  || { echo "read-xwt-generation: .done missing on sender bus" >&2; exit 1; }
[ ! -e "$RECIP/receipts/$ID.done" ] \
  || { echo "read-xwt-generation: .done must NOT land on recipient bus" >&2; exit 1; }

python3 -B - "$SENDER/reset-generation.json" "$RECIP/reset-generation.json" <<'PY'
import json, sys
sender, recip = (json.load(open(p)) for p in sys.argv[1:3])
assert sender.get("state") == "reused", f"sender must be reused, got {sender}"
assert sender.get("first_mutation") == "read", sender
assert recip.get("state") == "pristine", f"recipient must stay pristine, got {recip}"
assert recip.get("bundle_id") == "recip-bundle", recip
print("ok")
PY

echo "read-xwt-generation: ok"
