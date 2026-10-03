#!/usr/bin/env bash
# .80 U1: a warning must name only actionable poll rows.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export TAP_HOME="$WORK/team/.tap/bus" TAP_INDEX_HOME="$WORK/index" TAP_SELF=worker
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$TAP_INDEX_HOME"
cat > "$WORK/team/.tap/team-registry.json" <<JSON
{"schema":"0.20","team":{"name":"testteam","worktree_root":"$WORK/team"},"seats":{"worker":{"instance":"worker|current","status":"active","delivery":"poll"}}}
JSON
cat > "$TAP_INDEX_HOME/global-registry.json" <<JSON
{"schema":"0.20","teams":{"testteam":{"root":"$WORK/team","registry_location":"$WORK/team/.tap/team-registry.json"}}}
JSON
id=sender-20200101T000000Z-aaaaaaaaaaaa
cat > "$TAP_HOME/payloads/$id.md" <<PAYLOAD
---
id: $id
from: sender
to: worker
kind: discuss
reply: expected
recipient_instance: worker|current
path: $TAP_HOME/payloads/$id.md
---
old question
PAYLOAD
warn() {
  "$ROOT/bin/tap" outstanding worker > "$WORK/out" 2> "$WORK/warning"
}
poll_empty() {
  set +e
  TAP_VERBOSE=1 "$ROOT/bin/tap" poll worker > "$WORK/poll" 2>&1
  rc=$?
  set -e
  [ "$rc" -eq 0 ] || { cat "$WORK/poll"; echo "poll exit $rc"; exit 1; }
  ! grep -q "$id" "$WORK/poll" || { cat "$WORK/poll"; exit 1; }
}
warn
grep -q 'has 1 unsettled inbound aged' "$WORK/warning"
# Routine reads leave an ask open without repeating its age; verbose exposes it.
"$ROOT/bin/tap" read "$id" --by worker > "$WORK/out" 2> "$WORK/warning"
[ ! -s "$WORK/warning" ]
"$ROOT/bin/tap" -v read "$id" --by worker > "$WORK/out" 2> "$WORK/warning"
grep -q 'has 1 unsettled inbound aged' "$WORK/warning"
for receipt in cancelled done; do
  printf '{}' > "$TAP_HOME/receipts/$id.$receipt"
  poll_empty
  warn
  ! grep -q 'unsettled inbound aged' "$WORK/warning" || { echo "$receipt hidden by poll but warned"; cat "$WORK/warning"; exit 1; }
  rm "$TAP_HOME/receipts/$id.$receipt"
done
sed 's/worker|current/worker|retired/' "$TAP_HOME/payloads/$id.md" > "$WORK/old"
mv "$WORK/old" "$TAP_HOME/payloads/$id.md"
poll_empty
warn
! grep -q 'unsettled inbound aged' "$WORK/warning" || { echo 'retired instance hidden by poll but warned'; exit 1; }
# Unbound mail remains actionable, like poll.
sed '/recipient_instance:/d' "$TAP_HOME/payloads/$id.md" > "$WORK/unbound"
mv "$WORK/unbound" "$TAP_HOME/payloads/$id.md"
warn
grep -q 'has 1 unsettled inbound aged' "$WORK/warning"
echo 'aged-inbound: cancelled, settled and retired rows excluded; unbound row retained'
