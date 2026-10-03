#!/usr/bin/env bash
# cancel-spooled-withdrawal.test.sh — tap-cm00: sender-side withdrawal of an
# UNDELIVERED (spooled) send whose addressee is still live.
#
# Why this exists: a spooled entry has not reached the recipient (CONTRACT
# "Crew unregister"), so the recipient cannot settle it — live or not. Before
# tap-cm00 the seat_active refusal applied a DELIVERED-mail rule to undelivered
# mail, leaving no clearing path at all: cancel refused (addressee live) and
# done could not reach spool residency. The stranded entry also pinned the
# watch sidecar's parked-spool tint, whose clear condition is "the last parked
# entry leaves" — file presence, so only removal clears it.
#
# Tests:
# (a) spooled + LIVE addressee + --spooled: cancels, entry removed, archived,
#     receipt reason=spooled_withdrawn
# (b) spooled + LIVE addressee, NO flag: refuses AND names --spooled (a refusal
#     must never point at a dead remedy), entry left intact
# (c) canonical + LIVE addressee + --spooled: REFUSES (not_spooled). The
#     load-bearing invariant — --spooled must never become a seat_active bypass
#     for delivered mail. Asserted explicitly, not as a control-flow side effect.
# (d) spooled + GONE addressee, NO flag: still cancels (the flag is required
#     only where seat_active would otherwise have fired)
#
# Run: bash skills/tap/scripts/smoke/cancel-spooled-withdrawal.test.sh
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

echo "tap-cm00/cancel-spooled-withdrawal test  (withdraw an undelivered send)"

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

write_spool_entry() {  # <id>
  local id="$1"
  cat > "$LOCAL_BUS/spool/$id.md" <<EOF
---
id: $id
from: fable
to: qwen
kind: discuss
path: $LOCAL_BUS/spool/$id.md
reply: expected
---
parked send body for $id
EOF
  cat > "$LOCAL_BUS/spool/$id.meta.json" <<EOF
{
  "id": "$id",
  "target": "qwen",
  "team": "local",
  "reason": "pending-input",
  "reason_class": "busy",
  "timeout_seconds": null,
  "attempts": 0,
  "first_spooled": "2026-07-24T19:24:06Z",
  "first_spooled_epoch": 1784377380,
  "pane": "test:0.1",
  "pane_id": "%2",
  "to_team": "",
  "escalated_at": ""
}
EOF
}

write_canonical_entry() {  # <id>
  local id="$1"
  cat > "$LOCAL_BUS/payloads/$id.md" <<EOF
---
id: $id
from: fable
to: qwen
kind: discuss
path: $LOCAL_BUS/payloads/$id.md
reply: expected
---
delivered body for $id
EOF
}

# (a) spooled + LIVE addressee + --spooled --------------------------------------
echo "-- (a) spooled + live addressee + --spooled: withdraws --"
write_local_registry "active"
ID_A="fable-20260724T192406Z-aaaaaaaaaaaa"
write_spool_entry "$ID_A"
OUT="$(bash "$TAPSH" cancel "$ID_A" --by fable --spooled 2>&1)"; RC=$?
if [ "$RC" = 0 ]; then
  ok "(a) --spooled exits 0 on the success path"
else
  bad "(a) --spooled exited $RC (output: $OUT)"
fi
if grep -qi "cancelled $ID_A" <<<"$OUT"; then
  ok "(a) --spooled withdraws a parked send to a LIVE addressee"
else
  bad "(a) withdrawal failed (output: $OUT)"
fi
if [ ! -f "$LOCAL_BUS/spool/$ID_A.md" ] && [ ! -f "$LOCAL_BUS/spool/$ID_A.meta.json" ]; then
  ok "(a) spool entry and meta removed (tint can clear; no resurrection)"
else
  bad "(a) spool entry survived — tint would stay pinned"
fi
if [ -f "$LOCAL_BUS/receipts/$ID_A.cancelled" ]; then
  ok "(a) .cancelled receipt written"
else
  bad "(a) .cancelled receipt missing"
fi
if grep -q 'spooled_withdrawn' "$LOCAL_BUS/receipts/$ID_A.cancelled" 2>/dev/null; then
  ok "(a) receipt reason distinguishes withdrawal from addressee-gone"
else
  bad "(a) receipt reason is not spooled_withdrawn"
fi
# Existence alone is too weak — a `touch` archive beside an `rm` spool would satisfy
# it, which is the same assertion weakness one level down. Assert the BODY survived.
if grep -q "parked send body for $ID_A" "$LOCAL_BUS/archive/$ID_A.cancelled.md" 2>/dev/null; then
  ok "(a) withdrawn payload archived WITH its body, not destroyed"
else
  bad "(a) archive missing or does not contain the withdrawn body"
fi

# (b) spooled + LIVE addressee, no flag ----------------------------------------
echo "-- (b) spooled + live addressee, no flag: refuses and names --spooled --"
write_local_registry "active"
ID_B="fable-20260724T192406Z-bbbbbbbbbbbb"
write_spool_entry "$ID_B"
OUT="$(bash "$TAPSH" cancel "$ID_B" --by fable 2>&1)" || true
if grep -q -- "--spooled" <<<"$OUT"; then
  ok "(b) refusal names the working remedy (--spooled)"
else
  bad "(b) refusal does not name --spooled — a refusal pointing at a dead remedy (output: $OUT)"
fi
if ! grep -qi "tap done $ID_B" <<<"$OUT"; then
  ok "(b) refusal no longer points at the tap done path that cannot reach spool"
else
  bad "(b) refusal still routes the caller onto the dead tap done path"
fi
if [ -f "$LOCAL_BUS/spool/$ID_B.md" ]; then
  ok "(b) refusal left the spool entry intact"
else
  bad "(b) refusal mutated the spool"
fi
if [ ! -f "$LOCAL_BUS/receipts/$ID_B.cancelled" ]; then
  ok "(b) refusal wrote no receipt"
else
  bad "(b) refusal wrote a .cancelled receipt"
fi
OUT_J="$(bash "$TAPSH" cancel "$ID_B" --by fable --json 2>&1)"; RC=$?
if [ "$RC" = 1 ]; then
  ok "(b) refusal exits 1"
else
  bad "(b) refusal exited $RC, expected 1"
fi
if grep -q '"error_class":"spooled_needs_flag"' <<<"$OUT_J"; then
  ok "(b) refusal carries a distinct error_class (not conflated with seat_active)"
else
  bad "(b) refusal error_class is missing or conflated (output: $OUT_J)"
fi

# FOLLOW THE POINTER. Grepping for "--spooled" cannot tell a reachable door from a
# subtly wrong one: an action naming `--by qwen` (the ADDRESSEE) contains the flag,
# reads plausibly, and dies on not_sender when anyone tries it. "The refusal names a
# door that OPENS" is this fix's whole thesis, so the test opens it.
ACTION="$(printf '%s' "$OUT_J" | python3 -B -c 'import json,sys; print(json.load(sys.stdin).get("action",""))' 2>/dev/null)"
case "$ACTION" in
  "tap cancel "*) ok "(b) refusal supplies a machine-readable, runnable action" ;;
  *)              bad "(b) refusal action is absent or not a tap cancel command (action: $ACTION)" ;;
esac
# shellcheck disable=SC2086  # deliberate word-split: the action is a command line
OUT_R="$(bash "$TAPSH" ${ACTION#tap } 2>&1)"; RC=$?
if [ "$RC" = 0 ]; then
  ok "(b) the remedy the refusal named actually SUCCEEDS when executed"
else
  bad "(b) refusal named a door that does not open: '$ACTION' exited $RC ($OUT_R)"
fi
if [ ! -f "$LOCAL_BUS/spool/$ID_B.md" ] \
  && grep -q "parked send body for $ID_B" "$LOCAL_BUS/archive/$ID_B.cancelled.md" 2>/dev/null; then
  ok "(b) executing the named remedy withdrew and archived the entry"
else
  bad "(b) named remedy ran but left the entry unwithdrawn or unarchived"
fi

# (c) canonical + LIVE addressee + --spooled: MUST refuse ----------------------
echo "-- (c) canonical + live addressee + --spooled: refuses (not_spooled) --"
write_local_registry "active"
ID_C="fable-20260724T192406Z-cccccccccccc"
write_canonical_entry "$ID_C"
# Asserted on the MACHINE contract (error_class), not on prose: this invariant is
# the one that keeps --spooled from becoming a blanket seat_active bypass, so it
# should be pinned to something a consumer can branch on and a reword cannot break.
OUT="$(bash "$TAPSH" cancel "$ID_C" --by fable --spooled --json 2>&1)"; RC=$?
if [ "$RC" = 1 ]; then
  ok "(c) refusal exits 1"
else
  bad "(c) refusal exited $RC, expected 1"
fi
if grep -q '"error_class":"not_spooled"' <<<"$OUT"; then
  ok "(c) --spooled refuses a canonical payload with error_class=not_spooled"
else
  bad "(c) --spooled did NOT refuse delivered mail — seat_active is bypassable (output: $OUT)"
fi
OUT_HUMAN="$(bash "$TAPSH" cancel "$ID_C" --by fable --spooled 2>&1)" || true
if grep -qi "undelivered" <<<"$OUT_HUMAN"; then
  ok "(c) human refusal explains the residency rule"
else
  bad "(c) human refusal is unclear (output: $OUT_HUMAN)"
fi
# Thread 11 (bot): the recovery verb must match the obligation — this fixture
# is an ASK (reply: expected), and reading an ask only writes .read while the
# send stays outstanding, so directing the addressee at `tap read` advertises a
# command that cannot settle the very item the refusal is about.
if grep -q "tap reply $ID_C" <<<"$OUT_HUMAN" && ! grep -q "tap read $ID_C" <<<"$OUT_HUMAN"; then
  ok "(c) a delivered ASK's recovery names tap reply, not tap read"
else
  bad "(c) a delivered ASK's recovery does not match its obligation (output: $OUT_HUMAN)"
fi
if [ -f "$LOCAL_BUS/payloads/$ID_C.md" ]; then
  ok "(c) canonical payload untouched by the refusal"
else
  bad "(c) canonical payload was mutated"
fi
if [ ! -f "$LOCAL_BUS/receipts/$ID_C.cancelled" ]; then
  ok "(c) no receipt written for the refused canonical withdrawal"
else
  bad "(c) receipt written despite refusal"
fi

# (c2) the NOTE half of the obligation split: a delivered settle-only payload's
#      recovery names tap read — a note settles on read, and that IS the
#      executable next step for the addressee.
echo "-- (c2) canonical NOTE + --spooled: recovery names tap read --"
ID_C2="fable-20260724T192406Z-c2c2c2c2c2c2"
cat > "$LOCAL_BUS/payloads/$ID_C2.md" <<EOF
---
id: $ID_C2
from: fable
to: qwen
kind: discuss
path: $LOCAL_BUS/payloads/$ID_C2.md
reply: settle-only
---
delivered note body for $ID_C2
EOF
OUT_C2="$(bash "$TAPSH" cancel "$ID_C2" --by fable --spooled 2>&1)" || true
if grep -q "tap read $ID_C2" <<<"$OUT_C2"; then
  ok "(c2) a delivered NOTE's recovery names tap read"
else
  bad "(c2) a delivered NOTE's recovery omitted tap read (output: $OUT_C2)"
fi
rm -f "$LOCAL_BUS/payloads/$ID_C2.md"

# (d) spooled + GONE addressee, no flag: unchanged -----------------------------
echo "-- (d) spooled + gone addressee, no flag: still cancels --"
write_local_registry ""   # qwen absent entirely
ID_D="fable-20260724T192406Z-dddddddddddd"
write_spool_entry "$ID_D"
OUT="$(bash "$TAPSH" cancel "$ID_D" --by fable 2>&1)"; RC=$?
if [ "$RC" = 0 ]; then
  ok "(d) exits 0 on the success path"
else
  bad "(d) exited $RC (output: $OUT)"
fi
if grep -qi "cancelled $ID_D" <<<"$OUT"; then
  ok "(d) flag is NOT newly required where the addressee is gone"
else
  bad "(d) regression: dead-addressee spool cancel now needs a flag (output: $OUT)"
fi
if [ ! -f "$LOCAL_BUS/spool/$ID_D.md" ] && [ ! -f "$LOCAL_BUS/spool/$ID_D.meta.json" ]; then
  ok "(d) spool entry and meta removed"
else
  bad "(d) spool entry survived"
fi
# The gone-addressee path walks the SAME unified mv arm as the withdrawal path, so it
# needs the same archive assertion — otherwise a spool-arm delete regression could
# return here and this suite would stay green, which is exactly the weakness that let
# the original data loss live undetected.
if grep -q "parked send body for $ID_D" "$LOCAL_BUS/archive/$ID_D.cancelled.md" 2>/dev/null; then
  ok "(d) payload archived WITH its body on the gone-addressee path too"
else
  bad "(d) gone-addressee cancel destroyed the payload (archive missing or empty)"
fi

echo
printf 'cancel-spooled-withdrawal: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
