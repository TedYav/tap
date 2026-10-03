#!/usr/bin/env bash
# adoption-grant-instance.test.sh — Cluster E (separate from resolve/map Cluster A):
# Red-before (proved 2026-07-29; do not drop):
#   MUTATION E (grant path compares stamp to successor current instance again):
#     smoke_exit=1
#     RED assertion text: (1) grant + matching predecessor instance must settle
#     observed refusal: bound to recipient instance 'alice-2|FORK999', not the current 'alice' instance
#   (Case 2 alone is insufficient — it can pass while (1) still uses the wrong identity.)
# Cluster E is grant identity, NOT resolve/map (Cluster A).
#
# external done under an adoption grant must validate the adopted predecessor's
# recorded instance, not the successor's current instance (sol pass2 #2).
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
# shellcheck source=helpers.sh
. "$ROOT/skills/tap/scripts/smoke/helpers.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export TAP_INDEX_HOME="$WORK/index"
export TAP_HOME="$WORK/team/.tap/bus"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$WORK/team/.tap/team-history" "$TAP_INDEX_HOME"
# Source lib AFTER TAP_HOME so TAP_REGISTRY tracks the fixture bus.
# shellcheck source=skills/tap/scripts/smoke/runtime-helpers.sh
. "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"

fail() { echo "adoption-grant-instance: $*" >&2; exit 1; }

# Flip-live; stored loc = bus registry (agents shape ok — this test is grant identity).
python3 - "$TAP_INDEX_HOME/global-registry.json" "$WORK/team" <<'PY'
import json, os, sys, time
gpath, root = sys.argv[1:3]
os.makedirs(os.path.dirname(gpath), exist_ok=True)
json.dump({
  "schema": "0.20",
  "migrated": {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "backups": {}},
  "teams": {"team": {
    "root": root,
    "registry_location": root + "/.tap/bus/registry.json",
    "state": "registered",
  }},
}, open(gpath, "w"), indent=2)
open(gpath, "a").write("\n")
PY

# Successor alice adopted fork alice-2; grant records alice-2's retired instance.
cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": { "name": "team", "worktree_root": "REPLACE" },
  "seats": {
    "alice": {
      "status": "active", "delivery": "poll", "harness": "claude",
      "instance": "alice|SUCC001",
      "adopted_handles": ["alice-2"],
      "adopted_instances": { "alice-2": "alice-2|FORK999" }
    }
  }
}
JSON
python3 -c 'import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.write_text(p.read_text().replace("REPLACE", sys.argv[2]))' \
  "$TAP_HOME/registry.json" "$WORK/team"

tap_registry_v20_live || fail "flip should be live"
# tap_adopted_into and tap_addressee_grant_check (the lib.sh adapters that used
# to pre-check grant discovery and the grant instance record directly) were
# deleted as callerless Bash functions once the native `read` door started
# calling runtime/bun/src/addressee-grant.ts in-process; that module's own
# unit rows cover both checks directly (runtime/bun/test/addressee-grant.test.ts,
# describe("addressee grant — module rows") and the "own mail adopted from a
# predecessor…" / "predecessor's mail, no binding…" differential rows). This
# smoke test now proves the same grant end-to-end through the real `tap read`
# door below (case (1)).

SENDER="$WORK/sender/.tap/bus"
mkdir -p "$SENDER/payloads" "$SENDER/receipts"

# (1) Stamped with fork instance — successor settles under grant.
ID="sender-20260729T000000Z-grantok01"
cat > "$SENDER/payloads/$ID.md" <<EOF
---
id: $ID
from: bob
to: alice-2
kind: task
reply: settle-only
cross_worktree: true
from_team: sender
to_team: team
recipient_instance: alice-2|FORK999
path: $SENDER/payloads/$ID.md
---
adopted external mail
EOF
( cd "$WORK/team" && env -u TAP_HOME \
  "$TAP" read "path=$SENDER/payloads/$ID.md" --by alice >/dev/null ) \
  || fail "(1) grant + matching predecessor instance must settle"
[ -f "$SENDER/receipts/$ID.done" ] || fail "(1) .done missing"
echo "adoption-grant-instance: (1) grant settles matching predecessor instance: ok"

# (2) Stamped with successor instance — must REFUSE (the old bug).
ID2="sender-20260729T000000Z-grantbad01"
cat > "$SENDER/payloads/$ID2.md" <<EOF
---
id: $ID2
from: bob
to: alice-2
kind: task
reply: settle-only
cross_worktree: true
from_team: sender
to_team: team
recipient_instance: alice|SUCC001
path: $SENDER/payloads/$ID2.md
---
wrong identity on grant path
EOF
rc=0
out="$(cd "$WORK/team" && env -u TAP_HOME \
  "$TAP" read "path=$SENDER/payloads/$ID2.md" --by alice 2>&1)" || rc=$?
[ "$rc" != 0 ] || fail "(2) successor instance must not satisfy grant gate (got: $out)"
grep -qi "adopted\|bound to recipient instance" <<<"$out" \
  || fail "(2) refusal must name instance mismatch (got: $out)"
[ ! -e "$SENDER/receipts/$ID2.done" ] || fail "(2) .done must not land"
echo "adoption-grant-instance: (2) successor instance refused on grant path: ok"

# (3) sol #1 — I1 adoption THEN fresh I2 registration of the fork handle.
# Order matters: register I2 first and the stuck pair never forms. A live
# alice-2 seat must not hide alice's grant for alice-2|FORK999.
python3 - "$TAP_HOME/registry.json" <<'PY'
import json, sys
reg = json.load(open(sys.argv[1]))
reg["seats"]["alice-2"] = {
    "status": "active", "delivery": "poll", "harness": "claude",
    "instance": "alice-2|FRESH222",
}
json.dump(reg, open(sys.argv[1], "w"), indent=2)
open(sys.argv[1], "a").write("\n")
PY
# tap_adopted_into / tap_addressee_grant_check pre-checks for this case were
# removed with the deleted lib.sh adapters (see the note above case (1)). The
# actor-scoped grant still seeing the I1 predecessor grant despite the live I2
# registration is proven end-to-end by the real `tap read` settlement
# immediately below (it can only succeed as alice's I1 grant, since a live
# alice-2 would otherwise be the addressee of its own mail). The other
# property the deleted pre-check named — a live alice-2 seat not read as
# adopted-away — is about alice-2 acting on ITS OWN mail (to === actor), which
# this read never exercises; its native owner is addresseeGrant's `to ===
# actor` branch (runtime/bun/src/addressee-grant.ts:239-240), covered by the
# "own mail, no binding" row in runtime/bun/test/addressee-grant.test.ts.
ID3="sender-20260729T000000Z-grantlive01"
cat > "$SENDER/payloads/$ID3.md" <<EOF
---
id: $ID3
from: bob
to: alice-2
kind: task
reply: settle-only
cross_worktree: true
from_team: sender
to_team: team
recipient_instance: alice-2|FORK999
path: $SENDER/payloads/$ID3.md
---
predecessor mail after fresh fork re-mint
EOF
( cd "$WORK/team" && env -u TAP_HOME \
  "$TAP" read "path=$SENDER/payloads/$ID3.md" --by alice >/dev/null ) \
  || fail "(3) successor must settle I1 grant after fresh I2 registration"
[ -f "$SENDER/receipts/$ID3.done" ] || fail "(3) .done missing after live-fork grant settle"
echo "adoption-grant-instance: (3) grant survives fresh I2 registration: ok"

echo "adoption-grant-instance: ok"
