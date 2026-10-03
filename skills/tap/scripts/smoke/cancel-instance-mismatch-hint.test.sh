#!/usr/bin/env bash
# cancel-instance-mismatch-hint.test.sh — tap-ye2n follow-up (from
# review, two rounds): the instance-mismatch refusal must not recommend the
# exact command that just failed, AND must not flatly claim no clearing path
# exists when one conditionally does.
#
# The handle-mismatch hint (tap-cancel.sh:86) now correctly says `tap cancel
# <id> --by <sender>`. But under the v0.20 flip, a SECOND gate follows at
# :87-95: even once the actor's HANDLE matches the payload's `from`, the
# actor's CURRENT registered instance must also match the `sender_instance`
# stamped at send time. When it does not, TWO shapes reach this refusal and
# they have genuinely different answers:
#
#   (1) the handle is CURRENTLY registered under a DIFFERENT instance (a live
#       successor). tap-register.sh's own --restore path explicitly refuses
#       here ("current seat already exists") — there is truly no retry, and
#       the refusal must say so plainly rather than repeat the dead hint.
#   (2) the handle currently holds NO seat at all. `tap in <handle> --restore
#       <instance>` MAY reuse the exact stamped instance from that handle's
#       tombstone history (tap-register.sh:1893-1923) — round one's fix
#       claimed flatly that no path exists here too, which the second review
#       round caught as factually wrong: there IS a conditional door, and the
#       refusal must name it rather than close it.
#
# Neither branch repeats the "tap cancel <id> --by <sender>" hint the caller
# just ran — that part of round one's fix was correct and stays.
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
fail() { echo "cancel-instance-mismatch-hint: $*" >&2; exit 1; }

export TAP_INDEX_HOME="$WORK/index"
mkdir -p "$TAP_INDEX_HOME" "$WORK/team/.tap/bus/payloads" "$WORK/team/.tap/bus/receipts" "$WORK/team/.tap"
export TAP_HOME="$WORK/team/.tap/bus"
export TAP_REGISTRY="$TAP_HOME/registry.json"

cat >"$TAP_REGISTRY" <<'JSON'
{
  "schema": "0.20", "team": { "name": "T" },
  "seats": {
    "alice": { "status": "active", "delivery": "poll", "harness": "claude",
               "registered_at": "t", "pane": "", "pane_id": "" }
  }
}
JSON

# The v0.20-live acting registry: alice's CURRENT instance is the NEW one —
# simulating a re-registration since the payload below was originally sent.
ACTING_REG="$WORK/team/.tap/team-registry.json"
cat >"$ACTING_REG" <<'JSON'
{
  "schema": "0.20",
  "team": { "name": "T" },
  "seats": {
    "alice": { "status": "active", "delivery": "poll", "harness": "claude",
               "instance": "alice|newinstance0000", "registered_at": "t" }
  }
}
JSON

cat >"$TAP_INDEX_HOME/global-registry.json" <<JSON
{"schema":"0.20","teams":{"T":{"root":"$WORK/team","registry_location":"$ACTING_REG","state":"registered"}}}
JSON

ID="alice-20260101T000000Z-drifted01"
cat >"$TAP_HOME/payloads/${ID}.md" <<EOF
---
id: $ID
from: alice
to: ghost
kind: discuss
path: $TAP_HOME/payloads/${ID}.md
reply: expected
sender_instance: alice|oldinstance0000
---
body
EOF
: >"$TAP_HOME/receipts/${ID}.sent"

marker="$( . "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh" >/dev/null 2>&1; tap_registry_v20_state_load && printf '%s' "$_TAP_V20_STATE_VAL" )"
[ "$marker" = "live" ] || fail "fixture: expected a live flip marker, got '$marker'"

set +e
out="$(cd "$WORK/team" && "$TAP" cancel "$ID" --by alice 2>&1)"
rc=$?
set -e

[ "$rc" != 0 ] || fail "instance-mismatched cancel should refuse; got rc=0: $out"
grep -qi "not_sender\|instance" <<<"$out" \
  || fail "refusal does not read as the instance-mismatch class: $out"

# THE FIX: the `next:` ACTION field (what the caller is told to DO) must not
# be the exact command that just failed — the surrounding prose is free to
# NAME that command while explaining why it won't help, so this checks the
# action slot specifically rather than banning the phrase outright.
next_action="${out#*next: }"
[ "$next_action" != "$out" ] || fail "refusal has no 'next:' action field to check: $out"
[ "$next_action" != "tap cancel $ID --by alice" ] \
  && [ "$next_action" != "tap cancel $ID --by alice"$'\n' ] \
  || fail "the 'next:' action field IS the exact command that just failed — retrying it fails identically, a dead end disguised as an answer: $out"

# THE FIX, positively: must say plainly there is no clearing path — accurate
# for THIS fixture, where alice's row is present under a different instance.
grep -qi "no remaining clearing path\|no clearing path" <<<"$out" \
  || fail "refusal does not explain that this obligation has no remaining clearing path: $out"

echo "cancel-instance-mismatch-hint: (1) live successor, different instance -> no clearing path, no repeated hint: ok"

# --- (2) the handle currently holds NO seat at all: a conditional restore --
# path exists and the refusal must name it, not close it. Remove alice's row
# entirely (the fixture that round two's review caught round one's fix
# getting wrong) while the payload keeps the same stamped sender_instance.
python3 -B -c "
import json
with open('$ACTING_REG') as f:
    d = json.load(f)
d['seats'].pop('alice', None)
with open('$ACTING_REG', 'w') as f:
    json.dump(d, f)
"
# The tombstone that makes arm (2)'s conditional door REAL. It was asserting
# that the refusal names `tap in --restore <inst>` while the fixture had no
# history at all — so it pinned the WORDING of a door without the door existing.
# With the code now checking history rather than deferring the check to the
# reader, the fixture has to build the world the assertion describes.
mkdir -p "$WORK/team/.tap/team-history"
cat >"$WORK/team/.tap/team-history/alice.oldinstance0000.json" <<'JSON'
{"handle":"alice","instance":"alice|oldinstance0000","retired_by":"tap out","retired_at":"2026-01-01T00:00:00Z"}
JSON
ID2="alice-20260101T000000Z-drifted02"
cat >"$TAP_HOME/payloads/${ID2}.md" <<EOF
---
id: $ID2
from: alice
to: ghost
kind: discuss
path: $TAP_HOME/payloads/${ID2}.md
reply: expected
sender_instance: alice|oldinstance0000
---
body
EOF
: >"$TAP_HOME/receipts/${ID2}.sent"

set +e
out2="$(cd "$WORK/team" && "$TAP" cancel "$ID2" --by alice 2>&1)"
rc2=$?
set -e

[ "$rc2" != 0 ] || fail "(2) instance-mismatched cancel on an absent handle should still refuse; got rc=0: $out2"

# THE ROUND-TWO FIX: must NOT flatly claim no clearing path when a conditional
# one exists — the exact defect the second review round caught.
grep -qi "no remaining clearing path\|no clearing path" <<<"$out2" \
  && fail "(2) refusal claims no clearing path exists, but 'alice' holds no current seat — tap in alice --restore may reuse the tombstoned instance; this is the factually-wrong claim codex flagged: $out2"

# THE ROUND-TWO FIX, positively: must name the real conditional door with the
# exact instance id needed, so the hint is actionable rather than vague.
grep -qF "tap in alice --restore alice|oldinstance0000" <<<"$out2" \
  || fail "(2) refusal does not name the conditional restore path with the exact stamped instance: $out2"

echo "cancel-instance-mismatch-hint: (2) handle currently absent -> names the conditional 'tap in --restore' door instead of falsely claiming no path exists: ok"

# --- (3) the row is present AND the stamped instance is in HISTORY -----------
# Review thread 3, verified against the referent rather than argued:
# `tap out <handle>` removes the current row, after which
# `tap in <handle> --restore <instance>` can reuse that exact tombstone
# (tap-register.sh refuses --restore only WHILE a current seat exists, and
# tap-unregister.sh preserves the outgoing instance in history). So "no
# remaining clearing path" is FALSE for this shape — the door is closed, not
# absent.
#
# It stays TRUE when the instance is not in history, which arm (1) pins. The
# distinction is a fact this code can check, so it checks it instead of
# asserting an absolute.
python3 -B -c "
import json
with open('$ACTING_REG') as f: d = json.load(f)
d['seats']['alice'] = {'status':'active','delivery':'poll','harness':'claude',
                       'instance':'alice|newinstance0000','registered_at':'t'}
with open('$ACTING_REG','w') as f: json.dump(d, f)
"
mkdir -p "$WORK/team/.tap/team-history"
cat >"$WORK/team/.tap/team-history/alice.oldinstance0000.json" <<'JSON'
{"handle":"alice","instance":"alice|oldinstance0000","retired_by":"tap out","retired_at":"2026-01-01T00:00:00Z"}
JSON
ID3="alice-20260101T000000Z-drifted03"
cat >"$TAP_HOME/payloads/${ID3}.md" <<EOF
---
id: $ID3
from: alice
to: ghost
kind: discuss
path: $TAP_HOME/payloads/${ID3}.md
reply: expected
sender_instance: alice|oldinstance0000
---
body
EOF
: >"$TAP_HOME/receipts/${ID3}.sent"

set +e
out3="$(cd "$WORK/team" && "$TAP" cancel "$ID3" --by alice 2>&1)"
rc3=$?
set -e
[ "$rc3" != 0 ] || fail "(3) instance-mismatched cancel should still refuse; got rc=0: $out3"

grep -qi "no remaining clearing path\|no clearing path" <<<"$out3" \
  && fail "(3) refusal declares no clearing path, but 'alice|oldinstance0000' IS a tombstone in alice's history — tap out then tap in --restore reaches it. A closed door described as an absent one: $out3"

grep -qF "tap out alice" <<<"$out3" \
  || fail "(3) refusal does not name the out-and-restore path that history makes reachable: $out3"

# ...and it must be NAMED, not HANDED OVER. `next:` is what gets pasted, and
# `tap out` removes whoever holds the handle at that moment. Same ruling as
# --force on tap-hgzj: the destructive half lives in prose, the action field is
# the look. Asserting only "tap out appears somewhere" passed while it was the
# copied command, which is why this arm checks the slot.
next3="${out3#*next: }"
case "$next3" in
  *"tap out"*) fail "(3) the next: action is the destructive step — an agent pastes next: without reading the prose around it: $out3" ;;
esac
grep -qF "alice|oldinstance0000" <<<"$out3" \
  || fail "(3) refusal does not name the exact instance to restore: $out3"

# The path removes a LIVE row belonging to whoever holds the handle now. Naming
# it without naming that is how a remedy line gets copied into an outage.
grep -qiE "live|teammate|in use|active seat" <<<"$out3" \
  || fail "(3) refusal offers 'tap out alice' without warning that it removes whoever currently holds the handle: $out3"

echo "cancel-instance-mismatch-hint: (3) row present + instance in history -> names the conditional out-and-restore door, with its cost: ok"

# --- (2b) NO row and the instance is NOT in history --------------------------
# Codex thread 2 asked this site to "name history/restore when the stamped
# instance is restorable and reserve the no-path message for instances absent
# from history". Running it showed the site gave the SAME hedged answer either
# way — "tap in alice --list-history, then --restore if it lists there" — which
# is the code asking the reader to look up a fact the code is holding. For an
# instance that is not in history, that sends someone to an empty lookup and
# says nothing about what to do when it comes back empty.
rm -f "$WORK/team/.tap/team-history/alice.oldinstance0000.json"
ID4="alice-20260101T000000Z-drifted04"
cat >"$TAP_HOME/payloads/${ID4}.md" <<EOF
---
id: $ID4
from: alice
to: ghost
kind: discuss
path: $TAP_HOME/payloads/${ID4}.md
reply: expected
sender_instance: alice|oldinstance0000
---
body
EOF
: >"$TAP_HOME/receipts/${ID4}.sent"
python3 -B -c "
import json
with open('$ACTING_REG') as f: d = json.load(f)
d['seats'].pop('alice', None)
with open('$ACTING_REG','w') as f: json.dump(d, f)
"
set +e
out4="$(cd "$WORK/team" && "$TAP" cancel "$ID4" --by alice 2>&1)"
rc4=$?
set -e
[ "$rc4" != 0 ] || fail "(2b) should still refuse; got rc=0: $out4"
grep -qF "if it lists there" <<<"$out4" \
  && fail "(2b) the refusal defers a history lookup to the reader that it can perform itself, for an instance that is NOT in history — the lookup comes back empty and the message says nothing about that: $out4"
grep -qiE "not in .*history|no tombstone|nothing to restore" <<<"$out4" \
  || fail "(2b) refusal does not say the stamped instance is absent from history: $out4"
echo "cancel-instance-mismatch-hint: (2b) absent handle + instance NOT in history -> says so, instead of sending the reader to an empty lookup: ok"

echo "cancel-instance-mismatch-hint: ok"
