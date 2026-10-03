#!/usr/bin/env bash
# drain-sink-end-to-end.test.sh — tap-6vwz, the SYNTHETIC END-TO-END LEG.
#
# The five-step manufacture recipe from the work order, run as a test rather
# than kept as a memory: park on a sandboxed bus, set the terminal reason, point
# at a FAKE registry, use a DEAD pane id, then assert the entry is disposed AND
# reconciled. It replaces an acceptance gate that became impossible — the live
# specimen was delivered by an accidental injection during a probe (tap-ncd4),
# so it is no longer an undelivered entry. This substrate is safe to run twenty
# times and depends on no accident of history.
#
# THIS LEG EARNED ITS PLACE IN THE BAR. It found an ordering defect the five
# unit arms all missed: the escalated gate sits ABOVE the terminal-reason
# branch, so once a disposition is recorded, a later settle can never reconcile
# the entry and it stays spooled forever. No single-drain test reaches that
# state — arm 4 settles an entry that has not escalated yet and passes.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
# shellcheck source=sandbox-pins.sh
# tap-ea3z walk: pin machine-resolved state (session manifest, opencode db,
# version-seen) for directly invoked bodies — defense-in-depth; enrollment
# itself is unindexable-by-design for custom TAP_HOME (see the PR's framing).
. "$ROOT/skills/tap/scripts/smoke/sandbox-pins.sh"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
# STEP 1: fresh park on a SANDBOXED bus.
export TAP_HOME="$WORK/bus"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$TAP_HOME/spool"
export TAP_SPOOL_DISABLE_DELIVERER=1
. "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh" 2>/dev/null || { echo "source failed"; exit 1; }
. "$ROOT/skills/tap/scripts/smoke/spool-engine-fixture.sh"
# tap-ncd4: this fixture drives spool_drain_fixture_once directly, never through
# the real `tap` CLI, so nothing stamps this TAP_HOME as authorized. Bootstrap
# it the way production does; the entry's own pane/registry are a dead pane
# and a fake registry (STEP 3/4 below), so nothing here reaches a live pane.
tap_ensure_dirs
ID=e2e-20260819T000000Z-000000000001
cat > "$TAP_HOME/spool/$ID.md" <<EOF
---
id: $ID
from: sender
to: peer
kind: discuss
reply: settle-only
---
body
EOF
# STEP 3: FAKE registry file (not a real installation's registry).
FAKEREG="$WORK/fake-registry.json"
# The registry is FAKE (not a real installation) but must carry a sender row, or
# the notice has no addressee to inject into and returns before minting anything.
# TWO rig bugs found here, both of which produced "notices minted: 0" — a result
# I nearly read as a fix outcome twice. First `"agents":{}` (no addressee at
# all); then a sender row with `delivery: poll`, which cannot be injected into,
# so the notice returned rc=1 before minting. A rig that cannot receive the thing
# under test reports the same zero as a fix that never sent it.
printf '%s\n' '{"schema": "0.20", "team":{"name":"testteam"},"seats":{"sender":{"status":"active","pane":"nosuch:0.1","pane_id":"%999998","harness":"codex","session":"nosuch","delivery":"pane"}}}' > "$FAKEREG"
cp "$FAKEREG" "$TAP_HOME/registry.json"
# STEPS 2 + 4: terminal reason, and a DEAD pane id resolving to nothing.
python3 - "$TAP_HOME/spool/$ID.meta.json" "$FAKEREG" "$ID" <<'PY'
import json,sys
json.dump({"id":sys.argv[3],"target":"peer","team":"testteam",
 "reason":"legacy_meta_no_binding","reason_class":"safety_gate","attempts":0,
 "first_spooled_epoch":1000000,"pane":"nosuch:0.0","pane_id":"%999999","to_team":"",
 "target_registry":sys.argv[2],"policy":"standard","deadline_epoch":1000060,
 "deadline_source":"readiness-gate","waiter_lifetime":"readiness-gate"},
 open(sys.argv[1],"w"),indent=2,sort_keys=True)
PY
echo "STEP 1-4 ok: parked, terminal reason, fake registry, dead pane %999999"
echo "  before: reason=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["reason"])' "$TAP_HOME/spool/$ID.meta.json") spooled=$([ -f "$TAP_HOME/spool/$ID.md" ] && echo yes)"

# STEP 5a: run the escape route, entry UNSETTLED -> must reach a disposition.
spool_drain_fixture_once 1100000 8 >/dev/null 2>&1 || true
esc="$(python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get("escalated_at") or "")
except Exception: print("<meta gone>")' "$TAP_HOME/spool/$ID.meta.json")"
echo "STEP 5a (unsettled): escalated_at='$esc'"
[ -n "$esc" ] || { echo "FAIL: no disposition"; exit 1; }
# The notice must exist AND must not claim an observation nobody made.
if ls "$TAP_HOME/payloads/"*.md >/dev/null 2>&1; then
  if grep -ql "DELIVERY FAILED" "$TAP_HOME/payloads/"*.md 2>/dev/null; then
    echo "FAIL: the notice claims a DELIVERY FAILURE the courier never observed"; exit 1
  fi
fi
notices=$(ls "$TAP_HOME/payloads/" 2>/dev/null | wc -l | tr -d ' ')
echo "  sender notice payloads minted: $notices"
grep -l "NOT DELIVERED" "$TAP_HOME/payloads/"*.md 2>/dev/null | head -1 | while read -r f; do
  echo "  notice says: $(grep -m1 'NOT DELIVERED' "$f")"
  echo "  and:         $(grep -m1 'never attempted\|NO attempt' "$f")"
done

# STEP 5a-bis: THE PATH THE NOTICE NAMES MUST RESOLVE (review P1).
# The notice says "The payload is intact:" and names the CANONICAL path. While an
# entry is parked, `payloads/` holds nothing for it — the spool file is the only
# copy — so notifying without promoting hands the sender a pointer to a file that
# has never existed. The original leg counted notices and grepped their prose,
# which is exactly why it missed this: it asserted the notice EXISTS and never
# that what the notice CLAIMS is true.
NOTICE="$(grep -rl "NOT DELIVERED" "$TAP_HOME/payloads/" 2>/dev/null | head -1)"
[ -n "$NOTICE" ] || { echo "FAIL: no unrouted notice was minted"; exit 1; }
NAMED="$(grep -A1 "The payload is intact" "$NOTICE" | tail -1 | tr -d ' ')"
[ -n "$NAMED" ] || { echo "FAIL: notice names no payload path"; exit 1; }
[ -f "$NAMED" ] || { echo "FAIL: the notice names $NAMED, which does not exist"; exit 1; }
echo "STEP 5a-bis: the path the notice names RESOLVES"

# STEP 5b: RECONCILED — settle it, drain again, the ENTRY must leave the spool.
: > "$TAP_HOME/receipts/$ID.done"
spool_drain_fixture_once 1200000 8 >/dev/null 2>&1 || true
if [ -f "$TAP_HOME/spool/$ID.meta.json" ]; then
  echo "STEP 5b: FAIL — settled entry still in spool (sink outlived the delivery)"; exit 1
fi
echo "STEP 5b (settled): entry reconciled and reaped from the spool"

# STEP 5c: THE BODY SURVIVES THE REAP. `tap_spool_remove` is the raw retry-state
# cleaner; reaping a spool-only entry deletes the sole copy of the message. So the
# reap must promote first, and the path the sender was handed must STILL resolve
# after reconciliation — not just at the moment the notice was written.
[ -f "$NAMED" ] || { echo "FAIL: the reap destroyed the body the notice pointed at"; exit 1; }
grep -q "THE ONLY COPY" "$NAMED" 2>/dev/null || grep -q "body" "$NAMED" 2>/dev/null || {
  echo "FAIL: the promoted file is not the message body"; exit 1; }
echo "STEP 5c: the body survives the reap at the path the sender holds"
# ── The reap's OWN residency, isolated (mutation-driven) ─────────────────────
# STEP 5c above cannot see a reap that fails to promote, because by then the
# notice path has ALREADY promoted this entry — the body is at canonical no
# matter what the reap does. Mutation K (reap without promoting) passed 5c for
# exactly that reason, which makes 5c a real assertion about the sender's
# pointer and NOT an assertion about the reap.
#
# So the reap needs its own case: an entry that is settled BEFORE any
# disposition is recorded, so nothing has promoted it and the spool file is
# still the only copy when the reap runs. This is also the live shape — the
# specimen was settled by its recipient with no disposition ever recorded.
# RIG NOTE: this case lives on the SAME bus rather than a second one. lib.sh
# freezes TAP_SPOOL/TAP_RECEIPTS at source time, so re-exporting TAP_HOME mid-run
# does not move the bus — a second-bus version of this case silently exercised
# the first bus and reported a failure that was the rig's, not the code's.
ID2=e2e-20260819T000000Z-000000000002
cat > "$TAP_HOME/spool/$ID2.md" <<EOF
---
id: $ID2
from: sender
to: peer
kind: discuss
reply: settle-only
---
SOLE COPY OF THE SECOND BODY
EOF
python3 -B - "$TAP_HOME/spool/$ID2.meta.json" "$FAKEREG" "$ID2" <<'PY'
import json, sys
json.dump({"id": sys.argv[3], "target": "peer", "team": "testteam",
 "reason": "legacy_meta_no_binding", "reason_class": "safety_gate", "attempts": 0,
 "first_spooled_epoch": 1000000, "pane": "nosuch:0.0", "pane_id": "%999999",
 "to_team": "", "target_registry": sys.argv[2], "policy": "standard",
 "deadline_epoch": 1000060, "deadline_source": "readiness-gate",
 "waiter_lifetime": "readiness-gate"}, open(sys.argv[1], "w"), indent=2, sort_keys=True)
PY
: > "$TAP_HOME/receipts/$ID2.done"          # settled with NO disposition recorded
spool_drain_fixture_once 1100000 8 >/dev/null 2>&1 || true
[ ! -f "$TAP_HOME/spool/$ID2.meta.json" ] || { echo "FAIL: settled entry was not reconciled"; exit 1; }
grep -rq "SOLE COPY OF THE SECOND BODY" "$TAP_HOME" 2>/dev/null || {
  echo "FAIL: the reap destroyed the ONLY copy of a settled entry's body"; exit 1; }
[ -f "$TAP_HOME/payloads/$ID2.md" ] || {
  echo "FAIL: the reap discarded the body instead of promoting it to canonical"; exit 1; }
echo "STEP 5d: a settled spool-only entry is promoted, not deleted, by the reap"

echo "drain-sink-end-to-end: ok"
