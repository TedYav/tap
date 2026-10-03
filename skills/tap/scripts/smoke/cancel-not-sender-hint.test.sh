#!/usr/bin/env bash
# cancel-not-sender-hint.test.sh — tap-ye2n: the not-the-sender refusal's `next:`
# hint must name a command that actually works.
#
# Sighting 2026-08-18: a successor seat tried to cancel a departed predecessor's
# orphaned outstanding send and got told `tap send <id> --from <sender>` — wrong
# verb (tap send does not take a payload id as its argument) and a flag tap
# cancel does not have (no --from; the working spelling is --by). Following the
# hint verbatim dead-ends. The correct escape hatch, `tap cancel <id> --by
# <sender>`, was already the hint on the SIBLING refusal three lines down (the
# sender-instance mismatch) — this pins the first site to match the second.
set -euo pipefail
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "cancel-not-sender-hint: $*" >&2; exit 1; }

# Current bus with an unstamped payload: isolate the handle refusal from
# the sender-instance refusal exercised by the stamped payload below.
HOME_DIR="$WORK/team"
mkdir -p "$HOME_DIR/.tap/bus/payloads" "$HOME_DIR/.tap/bus/receipts"
cat >"$HOME_DIR/.tap/bus/registry.json" <<'JSON'
{
  "schema": "0.20", "team": { "name": "T" },
  "seats": {
    "alice": { "status": "active", "delivery": "poll", "harness": "claude",
               "registered_at": "t", "pane": "", "pane_id": "" },
    "bob":   { "status": "active", "delivery": "poll", "harness": "claude",
               "registered_at": "t", "pane": "", "pane_id": "" }
  }
}
JSON
export TAP_HOME="$HOME_DIR/.tap/bus"
export TAP_REGISTRY="$TAP_HOME/registry.json"
export TAP_INDEX_HOME="$WORK/index"
mkdir -p "$TAP_INDEX_HOME"
mkdir -p "$TAP_INDEX_HOME" && printf '{"schema":"0.20","teams":{}}\n' > "$TAP_INDEX_HOME/global-registry.json"  # born live (F1)

ID="alice-20200101T000000Z-stale0002"
cat >"$TAP_HOME/payloads/${ID}.md" <<EOF
---
id: $ID
from: alice
to: ghost
kind: discuss
path: $TAP_HOME/payloads/${ID}.md
reply: expected
---
body
EOF
: >"$TAP_HOME/receipts/${ID}.sent"

# bob (not the sender alice) tries to cancel.
set +e
out="$("$TAP" cancel "$ID" --by bob 2>&1)"
rc=$?
set -e

[ "$rc" != 0 ] || fail "bob should be refused cancelling alice's send; got rc=0: $out"
grep -q "not the sender\|only the sender may cancel" <<<"$out" \
  || fail "refusal text changed shape; expected the not-the-sender message: $out"

# THE FIX: the hint must be the command that actually works.
grep -qF "tap cancel $ID --by alice" <<<"$out" \
  || fail "hint does not name the working escape hatch 'tap cancel $ID --by alice': $out"

# THE DEFECT: must not regress to the broken hint (wrong verb, nonexistent flag).
grep -qF "tap send $ID --from" <<<"$out" \
  && fail "hint regressed to 'tap send <id> --from ...', which dead-ends (tap send takes no payload-id argument and tap cancel has no --from): $out"

echo "cancel-not-sender-hint: (1) not-the-sender refusal names the working 'tap cancel <id> --by <sender>' escape hatch: ok"
# --- (2) THE HINT MUST NOT SEND A READER INTO THE NEXT REFUSAL ----------------
# Arm (1) proves the hint names a command that EXISTS. That is not the same as
# a command that WORKS, and review (thread 1) caught the gap: for a live
# v0.20 payload stamped with a sender instance that no longer matches, the
# suggested cancel clears this handle check and is rejected by the instance gate
# one refusal later. Confirmed by running it, not by reading:
#
#   $ tap cancel <id> --by bob    -> "only the sender may cancel; next: tap cancel <id> --by alice"
#   $ tap cancel <id> --by alice  -> "bound to sender instance ...; next: no remaining clearing path"
#
# Arm (1)'s payload has no sender_instance, so the instance gate never fires.
# This arm supplies a stamped instance that differs from the current seat.
FLIP="$WORK/flip"
mkdir -p "$FLIP/index" "$FLIP/team/.tap/bus/payloads" "$FLIP/team/.tap/bus/receipts" "$FLIP/team/.tap"
cat >"$FLIP/team/.tap/bus/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"T"},"seats":{
  "alice":{"status":"active","delivery":"poll","harness":"claude","registered_at":"t","pane":"","pane_id":""},
  "bob":{"status":"active","delivery":"poll","harness":"claude","registered_at":"t","pane":"","pane_id":""}}}
JSON
cat >"$FLIP/team/.tap/team-registry.json" <<'JSON'
{"schema":"0.20","team":{"name":"T"},"seats":{
  "alice":{"status":"active","delivery":"poll","harness":"claude","instance":"alice|newinstance0000","registered_at":"t"},
  "bob":{"status":"active","delivery":"poll","harness":"claude","instance":"bob|bobinst00000000","registered_at":"t"}}}
JSON
cat >"$FLIP/index/global-registry.json" <<JSON
{"schema":"0.20","teams":{"T":{"root":"$FLIP/team","registry_location":"$FLIP/team/.tap/team-registry.json","state":"registered"}}}
JSON
ID2="alice-20260101T000000Z-deadend01"
cat >"$FLIP/team/.tap/bus/payloads/${ID2}.md" <<EOF
---
id: $ID2
from: alice
to: ghost
kind: discuss
path: $FLIP/team/.tap/bus/payloads/${ID2}.md
reply: expected
sender_instance: alice|oldinstance0000
---
body
EOF
: >"$FLIP/team/.tap/bus/receipts/${ID2}.sent"

set +e
out2="$(cd "$FLIP/team" && TAP_HOME="$FLIP/team/.tap/bus" TAP_REGISTRY="$FLIP/team/.tap/bus/registry.json" \
  TAP_INDEX_HOME="$FLIP/index" "$TAP" cancel "$ID2" --by bob 2>&1)"
rc2=$?
set -e
[ "$rc2" != 0 ] || fail "(2) bob should still be refused; got rc=0: $out2"

next2="${out2#*next: }"
[ "$next2" != "$out2" ] || fail "(2) refusal has no 'next:' action to check: $out2"
case "$next2" in
  "tap cancel $ID2 --by alice"*)
    fail "(2) the next: action is a command that fails one refusal later — the instance gate rejects it, so the reader is handed a dead end that LOOKS like an answer: $out2" ;;
esac
echo "cancel-not-sender-hint: (2) post-flip, drifted sender instance -> the hint is not the command the instance gate will reject: ok"

# --- (3) A THIRD PARTY NEVER RECEIVES THE SENDER'S DESTRUCTIVE DOOR ----------
# Composition grok caught as untested: when the sender holds a LIVE row and the
# stamped instance is also a tombstone, the resolver's door involves removing
# that live row. bob is not alice. Handing bob `tap out alice` as the copied
# command is a worse dead end than the one this lane removed, because it
# SUCCEEDS — and what it succeeds at is unseating a live teammate.
mkdir -p "$FLIP/team/.tap/team-history"
cat >"$FLIP/team/.tap/team-history/alice.oldinstance0000.json" <<'JSON'
{"handle":"alice","instance":"alice|oldinstance0000","retired_by":"tap out","retired_at":"2026-01-01T00:00:00Z"}
JSON
set +e
out3="$(cd "$FLIP/team" && TAP_HOME="$FLIP/team/.tap/bus" TAP_REGISTRY="$FLIP/team/.tap/bus/registry.json" \
  TAP_INDEX_HOME="$FLIP/index" "$TAP" cancel "$ID2" --by bob 2>&1)"
rc3=$?
set -e
[ "$rc3" != 0 ] || fail "(3) bob should still be refused; got rc=0: $out3"
next3="${out3#*next: }"
case "$next3" in
  *"tap out"*) fail "(3) a non-sender is handed 'tap out' as the copied command — it removes a live teammate and it is not even their handle: $out3" ;;
esac
# POSITIVE, not merely not-destructive (grok's out-of-scope note, taken): the
# code gives a third party the LOOK and nothing else — not even the harmless
# `tap in alice --restore`, which is still another seat's identity to operate.
# A negative-only assertion would pass a future change that handed bob some
# other door, which is the whole finding one step weaker.
case "$next3" in
  "tap team"*) : ;;
  *) fail "(3) a non-sender's next: should be the look ('tap team') and nothing else, got: $next3" ;;
esac
grep -qi "only the sender may cancel" <<<"$out3" \
  || fail "(3) refusal lost the not-the-sender diagnosis: $out3"
echo "cancel-not-sender-hint: (3) third party gets the diagnosis, never the sender's destructive door: ok"

echo "cancel-not-sender-hint: ok"
