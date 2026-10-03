#!/usr/bin/env bash
# registry-acting-readers.test.sh — Cluster A dual-axis completeness.
#
# Completeness is PER SITE ON BOTH AXES:
#   resolve — stored registry_location (not ambient TAP_HOME/registry.json,
#             not derived <root>/.tap/bus/registry.json)
#   map     — seats-first via _seat_map (not bare agents)
#
# Dual-axis red-before (proved 2026-07-29 at 47015eab; do not drop):
#   MUTATION map-only (agents-only at send remote reader; resolve still stored loc):
#     RED (1) "seats-only remote send must resolve bob"
#     observed: unknown handle 'bob' in team 'beta' (registered handles: <none>)
#   MUTATION resolve-only (derived bus path at cancel foreign; map still seats-first):
#     RED (3) "active matching foreign seat must block cancel"
#     observed: cancelled … (target 'bob' is suspended) — decoy bus, not stored seats
# Attribute each red to the assertion under test, not just "something failed".
#
# Fixture: flip-live; canonical seats-only team-registry.json at stored loc;
# ambient bus registry.json is EMPTY/wrong (agents-only decoy). A half-migration
# that fixes only one axis must RED.
#
# Cases:
#   (1) seats-only remote qualified send resolves recipient (map axis; resolve already ok)
#   (2) external read settles matching instance at stored loc (resolve axis)
#   (3) foreign cancel refuses while matching seat active at stored loc (PE-1 resolve)
#   (4) invalid flip marker fails closed (no legacy teams.json / worktree fallback)
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
# shellcheck source=helpers.sh
. "$ROOT/skills/tap/scripts/smoke/helpers.sh"
# shellcheck source=skills/tap/scripts/smoke/runtime-helpers.sh
. "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
. "$ROOT/skills/tap/scripts/smoke/native-authority-fixture.sh"

WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
export TAP_INDEX_HOME="$WORK/index"
export PATH="$FAKE_BIN:$PATH"
export TMUX="/fake/tmux/socket"
mkdir -p "$TAP_INDEX_HOME" "$FAKE_BIN"

fail() { echo "registry-acting-readers: $*" >&2; exit 1; }

# Fake tmux sufficient for a remote pane-backed send (remote poll is refused by contract).
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"; shift || true
case "$cmd" in
  # CONTRACT §Session-name authority: remote delivery needs exact-session
  # membership, a numeric id, current generation, and harness evidence.
  list-sessions) printf 'beta/bob\t900:100\n' ;;
  list-panes) printf 'beta/bob\tbeta/bob:0.0\t%%101\tclaude\t4242\t900:100\t0\n' ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) target="${2:-}"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    case "$fmt" in
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%%101\tbeta/bob\t4242\tclaude\t0\n' ;;
      '#{pid}:#{start_time}') printf '900:100\n' ;;
      *pane_id*)              echo "%101" ;;
      *session_name*)         echo "beta/bob" ;;
      *pane_pid*)             echo "4242" ;;
      *pane_in_mode*)         echo "0" ;;
      *pane_current_command*) echo "claude" ;;
      *pane_current_path*)    echo "${FAKE_TMUX_PATH:-/tmp}" ;;
      *) echo "" ;;
    esac ;;
  has-session) exit 0 ;;
  # Claude readiness requires a complete input box; this test owns registry
  # resolution, not unknown-geometry parking.
  capture-pane) printf '────────────────────\n› \n────────────────────\n' ;;
  send-keys|load-buffer|paste-buffer|delete-buffer) exit 0 ;;
  *) exit 0 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"

# --- teams: local "alpha", foreign "beta" ------------------------------------
ALPHA="$WORK/alpha"
BETA="$WORK/beta"
mkdir -p "$ALPHA/.tap/bus/payloads" "$ALPHA/.tap/bus/receipts" \
  "$BETA/.tap/bus/payloads" "$BETA/.tap/bus/receipts" \
  "$ALPHA/.tap" "$BETA/.tap"

# Decoy ambient bus registries — agents-only, WRONG content (half-migration bait).
cat > "$ALPHA/.tap/bus/registry.json" <<'JSON'
{
  "schema": "0.20", "team": { "name": "alpha", "worktree_root": "REPLACE_ALPHA" },
  "seats": {
    "alice": { "status": "active", "delivery": "poll", "harness": "claude", "instance": "alice|DECOYaaa" }
  }
}
JSON
cat > "$BETA/.tap/bus/registry.json" <<'JSON'
{
  "schema": "0.20", "team": { "name": "beta", "worktree_root": "REPLACE_BETA" },
  "seats": {
    "bob": { "status": "suspended", "delivery": "poll", "harness": "claude", "instance": "bob|DECOYbbb" }
  }
}
JSON
python3 - "$ALPHA" "$BETA" <<'PY'
import pathlib, sys
a, b = sys.argv[1:3]
for path, root in (
    (f"{a}/.tap/bus/registry.json", a),
    (f"{b}/.tap/bus/registry.json", b),
):
    text = pathlib.Path(path).read_text().replace("REPLACE_ALPHA", a).replace("REPLACE_BETA", b)
    pathlib.Path(path).write_text(text)
PY

# Canonical post-flip stores — seats ONLY (no agents key). Truth lives here.
cat > "$ALPHA/.tap/team-registry.json" <<JSON
{
  "schema": "0.20",
  "team": { "name": "alpha", "worktree_root": "$ALPHA" },
  "seats": {
    "alice": {
      "status": "active", "delivery": "poll", "harness": "claude",
      "instance": "alice|REALaaaa"
    }
  }
}
JSON
cat > "$BETA/.tap/team-registry.json" <<JSON
{
  "schema": "0.20",
  "team": { "name": "beta", "worktree_root": "$BETA" },
  "seats": {
    "bob": {
      "status": "active", "delivery": "pane", "harness": "claude",
      "pane": "beta/bob:0.0", "pane_id": "%101",
      "session": "beta/bob", "server_epoch": "srv:900:100",
      "instance": "bob|REALbbbb"
    }
  }
}
JSON

# Flip marker: stored locations point at team-registry.json (NOT bus decoys).
python3 - "$TAP_INDEX_HOME/global-registry.json" "$ALPHA" "$BETA" <<'PY'
import json, os, sys, time
gpath, alpha, beta = sys.argv[1:4]
os.makedirs(os.path.dirname(gpath), exist_ok=True)
json.dump({
  "schema": "0.20",
  "migrated": {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "backups": {}},
  "teams": {
    "alpha": {
      "root": alpha,
      "registry_location": alpha + "/.tap/team-registry.json",
      "state": "registered",
    },
    "beta": {
      "root": beta,
      "registry_location": beta + "/.tap/team-registry.json",
      "state": "registered",
    },
  },
}, open(gpath, "w"), indent=2)
open(gpath, "a").write("\n")
PY

export TAP_HOME="$ALPHA/.tap/bus"
tap_registry_v20_live || fail "flip should be live"
[ "$(acting_registry_fixture alpha)" = "$ALPHA/.tap/team-registry.json" ] \
  || fail "acting registry for alpha must be stored team-registry (got: $(acting_registry_fixture alpha || true))"
[ "$(acting_registry_fixture beta)" = "$BETA/.tap/team-registry.json" ] \
  || fail "acting registry for beta must be stored team-registry"

# --- (1) seats-only remote send: map axis ------------------------------------
# Resolve is already stored-loc; if send still reads agents-only, bob is MISSING
# (decoy has bob suspended under agents; seats has active bob — and seats-only
# means agents key absent on the stored file, so agents-only → MISSING).
# tap-31it --wake: this arm proves RECIPIENT RESOLUTION by the canonical landing
# on the sender bus. Alice's send is reply=settle-only, which is now eligible for
# the courier's auto-settle hold — a held body lives in spool/, not payloads/, so
# without --wake the arm would read a working resolution as a missing seat.
rc=0
out="$(cd "$ALPHA" && env -u TAP_HOME TAP_JSON=1 \
  "$TAP" send beta/bob -m "cluster-a dual-axis send" --from alice --team alpha --wake 2>&1)" || rc=$?
# Map-axis proof: seats-only stored registry must find bob. Exit 0 (injected) or
# 5 (placed, submit-unverified under fake tmux) both prove the recipient was
# resolved — agents-only on that file would have refused not_found/MISSING.
case "$rc" in
  0|5) ;;
  *) fail "(1) seats-only remote send must resolve bob (rc=$rc out=$out)" ;;
esac
grep -qi "not_found\|MISSING\|unknown" <<<"$out" \
  && fail "(1) must not miss seats-only bob (got: $out)"
_found_bob=0
for _p in "$ALPHA"/.tap/bus/payloads/*.md; do
  [ -f "$_p" ] || continue
  grep -q 'to: bob' "$_p" 2>/dev/null && grep -q 'to_team: beta' "$_p" 2>/dev/null && _found_bob=1 && break
done
[ "$_found_bob" = 1 ] || fail "(1) canonical payload to beta/bob must be placed on sender bus"
echo "registry-acting-readers: (1) seats-only remote send: ok"

# --- (2) external read at stored loc: resolve axis ---------------------------
# Ambient decoy has alice|DECOYaaa; stored has alice|REALaaaa. Stamp matches
# stored. Ambient-only gate would refuse.
SENDER_BUS="$BETA/.tap/bus"
ID="beta-20260729T000000Z-actread01"
cat > "$SENDER_BUS/payloads/$ID.md" <<EOF
---
id: $ID
from: bob
to: alice
kind: task
reply: settle-only
cross_worktree: true
from_team: beta
to_team: alpha
recipient_instance: alice|REALaaaa
path: $SENDER_BUS/payloads/$ID.md
---
cluster-a external read
EOF
( cd "$ALPHA" && env -u TAP_HOME \
  "$TAP" read "path=$SENDER_BUS/payloads/$ID.md" --by alice >/dev/null ) \
  || fail "(2) matching instance at stored loc must settle external --payload"
[ -f "$SENDER_BUS/receipts/$ID.done" ] || fail "(2) .done missing on sender bus"
echo "registry-acting-readers: (2) canonical external read: ok"

# --- (3) foreign cancel PE-1: resolve axis -----------------------------------
# Mail from alice→bob stamped bob|REALbbbb. Decoy beta bus says bob suspended
# (would allow cancel); stored seats say bob active matching instance (must refuse).
CID="alice-20260729T000000Z-actcanc01"
cat > "$ALPHA/.tap/bus/payloads/$CID.md" <<EOF
---
id: $CID
from: alice
to: bob
kind: task
reply: settle-only
from_team: alpha
to_team: beta
sender_instance: alice|REALaaaa
recipient_instance: bob|REALbbbb
path: $ALPHA/.tap/bus/payloads/$CID.md
---
cluster-a foreign cancel
EOF
rc=0
out="$(cd "$ALPHA" && env -u TAP_HOME \
  "$TAP" cancel "$CID" --by alice 2>&1)" || rc=$?
[ "$rc" != 0 ] || fail "(3) active matching foreign seat must block cancel (got: $out)"
grep -qi "seat_active\|still an active" <<<"$out" \
  || fail "(3) expected seat_active (got: $out)"
[ ! -e "$ALPHA/.tap/bus/receipts/$CID.cancelled" ] \
  || fail "(3) must not write .cancelled while canonical seat active"
echo "registry-acting-readers: (3) foreign cancel PE-1: ok"

# --- (4) invalid flip marker fail-closed -------------------------------------
printf '{not json' > "$TAP_INDEX_HOME/global-registry.json"
tap_registry_v20_state_load || fail "(4) marker read failed"
[ "$_TAP_V20_STATE_VAL" = "invalid" ] || fail "(4) corrupt marker must be invalid"
# Anchor via TAP_HOME (not --team): --team consults the index before resolve, and
# an invalid flip marker must not be confused with "team not enrolled".
rc=0
out="$(cd "$ALPHA" && env TAP_HOME="$ALPHA/.tap/bus" TAP_JSON=1 \
  "$TAP" send beta/bob -m "should refuse" --from alice 2>&1)" || rc=$?
[ "$rc" != 0 ] || fail "(4) invalid flip must refuse remote send (got: $out)"
grep -qiE 'invalid_flip|flip marker is present but invalid' <<<"$out" \
  || fail "(4) refusal must name invalid flip (got: $out)"
# Must NOT silently fall through to legacy teams.json / worktree discovery.
grep -qi "worktree list\|known sibling" <<<"$out" \
  && fail "(4) invalid flip must not use legacy worktree discovery (got: $out)"
echo "registry-acting-readers: (4) invalid flip fail-closed: ok"

echo "registry-acting-readers: ok"
