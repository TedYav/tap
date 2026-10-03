#!/usr/bin/env bash
# unit-2b-f2-payloads-guard.test.sh — F2B-2: tap reply --payload rejects paths whose
# parent directory is not named "payloads" (structural bus-shape guard).
#
# Repro (per brief): a payload at .../notpayloads/xwt-bad.md with matching id/to
# should be REJECTED — currently tap reply --payload settles it, writing .done on a
# synthetic bus path. After fix: rejected with nonzero exit, no .done written.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"
# shellcheck source=skills/tap/scripts/smoke/helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/helpers.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"; TAP_HOME="$WORK/repo/.tap/bus"; trap 'rm -rf "$WORK"' EXIT; export TAP_HOME
tap_smoke_enroll_current "$WORK/repo" "$TAP_HOME" team
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"

ID="f2b2-notpayloads"

printf '%s\n' '{"schema": "0.20", "team":{"name":"team"},"seats":{"codex":{"status":"active","delivery":"poll"},"claude":{"status":"active","delivery":"poll"}}}' > "$TAP_HOME/registry.json"
printf 'answer\n' > "$TAP_HOME/answer.txt"

# Plant a valid-looking payload under a non-payloads parent dir
FAKE_PARENT="$TAP_HOME/notpayloads"
mkdir -p "$FAKE_PARENT"
cat > "$FAKE_PARENT/$ID.md" <<EOF
---
id: $ID
from: claude
to: codex
kind: discuss
path: $TAP_HOME/payloads/$ID.md
---

body for structural guard test (F2B-2)
EOF

# tap reply --payload with a non-payloads parent must be rejected (nonzero exit)
_rc=0
"$TAP" reply "$ID" --by codex -f "$TAP_HOME/answer.txt" --payload "$FAKE_PARENT/$ID.md" \
  >"$TAP_HOME/f2b2.out" 2>&1 || _rc=$?
[ "$_rc" -ne 0 ] || {
  echo "unit-2b-f2-payloads-guard: FAIL — tap reply --payload accepted non-payloads parent (exit 0)" >&2
  cat "$TAP_HOME/f2b2.out" >&2; exit 1
}

# Assert no .done was written anywhere on any derived path
_synthetic_done="$(dirname "$FAKE_PARENT")/receipts/$ID.done"
[ ! -f "$_synthetic_done" ] || {
  echo "unit-2b-f2-payloads-guard: FAIL — .done was written despite rejection: $_synthetic_done" >&2; exit 1
}
[ ! -f "$TAP_HOME/receipts/$ID.done" ] || {
  echo "unit-2b-f2-payloads-guard: FAIL — .done was written to local bus despite rejection" >&2; exit 1
}
echo "unit-2b-f2-payloads-guard: non-payloads parent rejected (exit $_rc): ok"

# Back-compat regression guard: a legitimate payloads/ path still settles correctly.
cat > "$TAP_HOME/payloads/$ID.md" <<EOF
---
id: $ID
from: claude
to: codex
kind: discuss
path: $TAP_HOME/payloads/$ID.md
---

body
EOF
"$TAP" reply "$ID" --by codex -f "$TAP_HOME/answer.txt" --payload "$TAP_HOME/payloads/$ID.md" || {
  echo "unit-2b-f2-payloads-guard: FAIL — legitimate payloads/ path was rejected" >&2; exit 1
}
[ -f "$TAP_HOME/receipts/$ID.done" ] || {
  echo "unit-2b-f2-payloads-guard: FAIL — .done not written for legitimate payloads/ path" >&2; exit 1
}
echo "unit-2b-f2-payloads-guard: legitimate payloads/ path settles: ok"

echo "unit-2b-f2-payloads-guard: ok"
