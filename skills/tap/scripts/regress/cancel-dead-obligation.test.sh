#!/usr/bin/env bash
# cancel-dead-obligation.test.sh — tap-pe56: cancel dead obligations to vanished seats.
#
# Tests:
# (a) truly-unregistered addressee (not in local registry): cancel succeeds
# (b) cross-worktree payload, addressee gone in FOREIGN registry: cancel succeeds
# (c) spooled dead obligation: cancel removes spool entry, .cancelled written, no resurrection
# (d) cancelled id drains from outstanding
# (e) .cancelled receipt distinct from .done (via=cancelled)
# (f) live seat refuses cancel (seat_active)
# (g) already-cancelled id refuses cancel
# (h) non-sender refuses cancel
# (i) present-but-incapable addressee: cancel succeeds (zero cancel change)
#
# Run: bash skills/tap/scripts/regress/cancel-dead-obligation.test.sh
set -uo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAPSH="$ROOT/bin/tap"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
ok()  { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n' "$1"; }

echo "tap-pe56/cancel-dead-obligation test  (cancel sends to vanished seats)"

# -- Local team fixture --
LOCAL_BUS="$WORK/local/.tap/bus"
mkdir -p "$LOCAL_BUS/payloads" "$LOCAL_BUS/receipts" "$LOCAL_BUS/spool"
export TAP_HOME="$LOCAL_BUS"

write_local_registry() {
  local qwen_status="$1"
  python3 -B -c '
import json, sys
agents = {"fable": {"handle": "fable", "pane": "test:0.0", "pane_id": "%1", "status": "active", "delivery": "pane"}}
if sys.argv[1]:
    agents["qwen"] = {"handle": "qwen", "pane": "test:0.1", "pane_id": "%2", "status": sys.argv[1], "delivery": "pane"}
print(json.dumps({"schema": "0.20", "team": {"name": "local"}, "seats": agents}))
' "$qwen_status" > "$LOCAL_BUS/registry.json"
}

# (a) truly-unregistered addressee (NOT in local registry at all)
echo "-- (a) truly-unregistered addressee (not in local registry) --"
write_local_registry ""  # no qwen entry at all
PAYLOAD_A="fable-20260715T034100A-testunreg"
cat > "$LOCAL_BUS/payloads/$PAYLOAD_A.md" <<EOF
---
id: $PAYLOAD_A
from: fable
to: qwen
kind: discuss
path: $LOCAL_BUS/payloads/$PAYLOAD_A.md
reply: expected
---
test to unregistered qwen
EOF
OUT="$(bash "$TAPSH" cancel "$PAYLOAD_A" --by fable 2>&1)" || true
if grep -qi "cancelled $PAYLOAD_A" <<<"$OUT"; then
  ok "unregistered addressee: cancel succeeds"
else
  bad "unregistered addressee: cancel failed (output: $OUT)"
fi
# Verify receipt
if [ -f "$LOCAL_BUS/receipts/$PAYLOAD_A.cancelled" ]; then
  ok "unregistered: .cancelled receipt written"
else
  bad "unregistered: .cancelled receipt missing"
fi

# (b) cross-worktree payload, addressee gone in FOREIGN registry
echo "-- (b) cross-worktree: addressee gone in foreign registry --"
FOREIGN_BUS="$WORK/foreign/.tap/bus"
mkdir -p "$FOREIGN_BUS/payloads" "$FOREIGN_BUS/receipts"
# Foreign registry with NO qwen entry (the seat is gone)
cat > "$FOREIGN_BUS/registry.json" <<JSON
{
  "schema": "0.20", "team": { "name": "foreign" },
  "seats": {
    "sol": { "handle": "sol", "pane": "test:0.5", "pane_id": "%5", "status": "active", "delivery": "pane" }
  }
}
JSON
# Machine index (born live, F2a): enroll both fixture teams.
mkdir -p "$WORK/index"
W="$(cd "$WORK" && pwd -P)"
cat > "$WORK/index/global-registry.json" <<JSON
{"schema": "0.20", "teams": {
  "local": { "root": "$W/local", "registry_location": "$W/local/.tap/bus/registry.json", "state": "registered" },
  "foreign": { "root": "$W/foreign", "registry_location": "$W/foreign/.tap/bus/registry.json", "state": "registered" }
}}
JSON
export TAP_INDEX_HOME="$WORK/index"

PAYLOAD_B="fable-20260715T034200B-crosswtx"
cat > "$LOCAL_BUS/payloads/$PAYLOAD_B.md" <<EOF
---
id: $PAYLOAD_B
from: fable
to: qwen
kind: discuss
path: $LOCAL_BUS/payloads/$PAYLOAD_B.md
reply: expected
to_team: foreign
cross_worktree: true
---
test to qwen on foreign team (gone)
EOF
OUT="$(bash "$TAPSH" cancel "$PAYLOAD_B" --by fable 2>&1)" || true
if grep -qi "cancelled $PAYLOAD_B" <<<"$OUT"; then
  ok "cross-worktree gone: cancel succeeds"
else
  bad "cross-worktree gone: cancel failed (output: $OUT)"
fi
RECEIPT_B="$(cat "$LOCAL_BUS/receipts/$PAYLOAD_B.cancelled" 2>/dev/null || echo '')"
if echo "$RECEIPT_B" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert "foreign" in d.get("registry_checked",""), d' 2>/dev/null; then
  ok "cross-worktree: receipt names foreign registry"
else
  bad "cross-worktree: receipt does not name foreign registry: $RECEIPT_B"
fi

# (c) spooled dead obligation: cancel removes spool entry, no resurrection
echo "-- (c) spooled dead obligation: cancel + no resurrection --"
write_local_registry ""  # qwen not in local registry
PAYLOAD_C="fable-20260715T034300C-spooled"
# Create a spool entry (the send parked and the target later vanished)
cat > "$LOCAL_BUS/spool/$PAYLOAD_C.md" <<EOF
---
id: $PAYLOAD_C
from: fable
to: qwen
kind: discuss
path: $LOCAL_BUS/spool/$PAYLOAD_C.md
reply: expected
---
spooled send to vanished qwen
EOF
cat > "$LOCAL_BUS/spool/$PAYLOAD_C.meta.json" <<EOF
{
  "id": "$PAYLOAD_C",
  "target": "qwen",
  "team": "local",
  "reason": "pending-input",
  "reason_class": "busy",
  "timeout_seconds": null,
  "attempts": 0,
  "first_spooled": "2026-07-15T03:43:00Z",
  "first_spooled_epoch": 1784377380,
  "pane": "test:0.1",
  "pane_id": "%2",
  "to_team": "",
  "escalated_at": ""
}
EOF
OUT="$(bash "$TAPSH" cancel "$PAYLOAD_C" --by fable 2>&1)" || true
if grep -qi "cancelled $PAYLOAD_C" <<<"$OUT"; then
  ok "spooled: cancel succeeds"
else
  bad "spooled: cancel failed (output: $OUT)"
fi
if [ ! -f "$LOCAL_BUS/spool/$PAYLOAD_C.md" ]; then
  ok "spooled: spool entry removed (no resurrection possible)"
else
  bad "spooled: spool entry still exists (can be resurrected by drain)"
fi
if [ -f "$LOCAL_BUS/receipts/$PAYLOAD_C.cancelled" ]; then
  ok "spooled: .cancelled receipt written"
else
  bad "spooled: .cancelled receipt missing"
fi
# tap-cm00: "the entry left spool/" is satisfied by a DELETE as well as a move, so on
# its own it cannot tell archived from destroyed — that weakness is why a spool-arm
# cancel silently discarded the payload for as long as it did. Assert the body is
# recoverable, not merely that the source is gone.
if grep -q "spooled send to vanished qwen" "$LOCAL_BUS/archive/$PAYLOAD_C.cancelled.md" 2>/dev/null; then
  ok "spooled: payload archived WITH its body (not destroyed)"
else
  bad "spooled: payload was discarded — archive missing or does not contain the body"
fi

# (d) cancelled id drains from outstanding
echo "-- (d) cancelled id drains from outstanding --"
OUT="$(bash "$TAPSH" outstanding fable 2>&1)"
if grep -q "$PAYLOAD_C" <<<"$OUT"; then
  bad "cancelled spooled id still in outstanding"
else
  ok "cancelled spooled id drains from outstanding"
fi

# (e) .cancelled receipt is distinct from .done
echo "-- (e) .cancelled receipt distinct from .done --"
if [ ! -f "$LOCAL_BUS/receipts/$PAYLOAD_A.done" ]; then
  ok ".done receipt does NOT exist for cancelled send"
else
  bad ".done receipt should NOT exist"
fi
RECEIPT_A="$(cat "$LOCAL_BUS/receipts/$PAYLOAD_A.cancelled")"
if echo "$RECEIPT_A" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["via"]=="cancelled"; assert d["reason"]=="seat_unresolvable"; assert d["target_status"]=="gone"' 2>/dev/null; then
  ok ".cancelled receipt: via=cancelled, reason=seat_unresolvable, target_status=gone"
else
  bad ".cancelled receipt wrong fields: $RECEIPT_A"
fi

# (f) live seat refuses cancel
echo "-- (f) live seat refuses cancel --"
write_local_registry "active"  # qwen is now active
PAYLOAD_F="fable-20260715T034500F-liveseat"
cat > "$LOCAL_BUS/payloads/$PAYLOAD_F.md" <<EOF
---
id: $PAYLOAD_F
from: fable
to: qwen
kind: discuss
path: $LOCAL_BUS/payloads/$PAYLOAD_F.md
reply: expected
---
test to active qwen
EOF
OUT="$(bash "$TAPSH" cancel "$PAYLOAD_F" --by fable 2>&1)" || true
if grep -qi "seat_active\|still an active" <<<"$OUT"; then
  ok "live seat refuses cancel"
else
  bad "live seat did not refuse (output: $OUT)"
fi

# (g) already-cancelled id refuses cancel
echo "-- (g) already-cancelled id refuses cancel --"
# PAYLOAD_A was already cancelled in (a); re-create it for the test
write_local_registry ""  # qwen gone again so cancel can proceed
cat > "$LOCAL_BUS/payloads/$PAYLOAD_A.md" <<EOF
---
id: $PAYLOAD_A
from: fable
to: qwen
kind: discuss
path: $LOCAL_BUS/payloads/$PAYLOAD_A.md
reply: expected
---
recreated for already-cancelled test
EOF
# Remove the old .cancelled so we can test cleanly
rm -f "$LOCAL_BUS/receipts/$PAYLOAD_A.cancelled"
# Cancel it fresh
bash "$TAPSH" cancel "$PAYLOAD_A" --by fable >/dev/null 2>&1 || true
# Try again: re-cancelling is idempotent, so it says so and exits 0 (CLI-EXIT-0)
RC=0; OUT="$(bash "$TAPSH" cancel "$PAYLOAD_A" --by fable 2>&1)" || RC=$?
if [ "$RC" -eq 0 ] && grep -qi "already cancelled; nothing to do" <<<"$OUT"; then
  ok "already-cancelled id reports nothing to do and exits 0"
else
  bad "already-cancelled re-cancel should exit 0 with nothing to do (rc=$RC, output: $OUT)"
fi
# Idempotence is the canceller's alone: another actor still gets the already_cancelled refusal.
RC=0; OUT="$(bash "$TAPSH" cancel "$PAYLOAD_A" --by sol 2>&1)" || RC=$?
if [ "$RC" -eq 1 ] && grep -qi "already cancelled (.cancelled exists)" <<<"$OUT"; then
  ok "another actor's re-cancel of a cancelled id refuses with exit 1"
else
  bad "another actor's re-cancel should refuse already_cancelled with exit 1 (rc=$RC, output: $OUT)"
fi
# A squatted receipt naming only the actor is not a cancellation: it still refuses.
printf '{"by":"fable"}\n' > "$LOCAL_BUS/receipts/$PAYLOAD_A.cancelled"
RC=0; OUT="$(bash "$TAPSH" cancel "$PAYLOAD_A" --by fable 2>&1)" || RC=$?
if [ "$RC" -eq 1 ] && grep -qi "already cancelled (.cancelled exists)" <<<"$OUT"; then
  ok "a malformed .cancelled receipt refuses with exit 1"
else
  bad "a malformed .cancelled receipt should refuse already_cancelled with exit 1 (rc=$RC, output: $OUT)"
fi

# (h) non-sender refuses cancel
echo "-- (h) non-sender refuses cancel --"
OUT="$(bash "$TAPSH" cancel "$PAYLOAD_F" --by sol 2>&1)" || true
if grep -qi "not_sender\|only the sender" <<<"$OUT"; then
  ok "non-sender refuses cancel"
else
  bad "non-sender did not refuse (output: $OUT)"
fi

# (i) present-but-incapable addressee is still a dead obligation: cancel succeeds
echo "-- (i) incapable addressee: cancel succeeds --"
# The B5 `tap incapable` mark persists status=suspended + status_reason=incapable
# with zero production change to cancel; this pin holds that door open.
python3 -B -c '
import json
agents = {"fable": {"handle": "fable", "pane": "test:0.0", "pane_id": "%1", "status": "active", "delivery": "pane"},
          "qwen": {"handle": "qwen", "pane": "test:0.1", "pane_id": "%2", "status": "suspended", "status_reason": "incapable", "delivery": "pane"}}
print(json.dumps({"schema": "0.20", "team": {"name": "local"}, "seats": agents}))
' > "$LOCAL_BUS/registry.json"
PAYLOAD_I="fable-20260715T034500I-incapable"
cat > "$LOCAL_BUS/payloads/$PAYLOAD_I.md" <<EOF
---
id: $PAYLOAD_I
from: fable
to: qwen
kind: discuss
path: $LOCAL_BUS/payloads/$PAYLOAD_I.md
reply: expected
---
test to incapable qwen
EOF
if bash "$TAPSH" cancel "$PAYLOAD_I" --by fable >/dev/null 2>&1; then
  ok "incapable addressee: cancel succeeds"
else
  bad "cancel refused for incapable addressee"
fi

echo "tap-pe56/cancel-dead-obligation test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
