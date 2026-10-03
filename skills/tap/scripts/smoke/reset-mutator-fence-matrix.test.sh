#!/usr/bin/env bash
# D5: fixture-door — reset-mutator-fence-matrix.test.sh:53,56,111: the module references here only build or seed fixture state; every assertion is on the surrounding shell behavior, none on the module's own
# reset-mutator-fence-matrix.test.sh — table-driven presence-authority coverage
# (sol 055309 #6). Every listed mutator must refuse a live fence before writing.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
# shellcheck source=skills/tap/scripts/smoke/runtime-helpers.sh
. "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export TAP_SCRATCH_ONLY="$WORK"
export TAP_HOME="$WORK/matrix/.tap/bus"
export TAP_INDEX_HOME="$WORK/index"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$TAP_HOME/spool" "$TAP_HOME/watch" "$TAP_HOME/goalie" \
  "$TAP_INDEX_HOME" "$WORK/matrix"
git -C "$WORK/matrix" init -q
# Reach the fence through the current enrolled target, rather than refusing at
# the retired teams.json precondition before the register row can be exercised.
python3 -B - "$WORK/matrix" "$TAP_INDEX_HOME" <<'PY'
import json, os, sys
root, index = sys.argv[1:]
registry = os.path.join(root, ".tap", "team-registry.json")
with open(os.path.join(index, "global-registry.json"), "w") as fh:
    json.dump({"schema": "0.20", "migrated": {}, "teams": {"matrix": {
        "root": root, "registry_location": registry, "state": "registered",
        "enrolled_at": "1970-01-01T00:00:00Z"}}}, fh)
with open(registry, "w") as fh:
    json.dump({"schema": "0.20", "team": {"name": "matrix", "worktree_root": root},
               "seats": {"bob": {"status": "active", "delivery": "poll", "harness": "daemon"}}}, fh)
PY
cp "$WORK/matrix/.tap/team-registry.json" "$WORK/registry.expected"
printf '%s\n' '{"schema": "0.20", "team":{"name":"matrix"},"seats":{"bob":{"status":"active","delivery":"poll","harness":"daemon"}}}' \
  > "$TAP_HOME/registry.json"
# Minimal frontmatter so reply/done resolve an id without inventing bus writes first.
cat > "$TAP_HOME/payloads/matrix-1.md" <<'PAYLOAD'
---
id: matrix-1
from: bob
to: bob
kind: task
reply: expected
---
body
PAYLOAD
cp "$TAP_HOME/payloads/matrix-1.md" "$WORK/matrix-1.expected"
printf '%s\n' '{"id":"matrix-1","status":"armed","armed_by":"bob"}' > "$TAP_HOME/watch/arm.json"
printf '%s\n' '{"armed_by":"bob","watcher_pid":0}' > "$TAP_HOME/goalie/arm.json"

token="$(bun "$_TAP_SCRIPT_DIR/../../../runtime/bun/src/reset.ts" acquire "$TAP_HOME" --owner-pid "$$" --bundle-id "bundle-matrix")"
snap_before="$(cd "$TAP_HOME" && find . -type f -print0 | sort -z | xargs -0 cksum | cksum | awk '{print $1}')"

fail() { echo "mutator-matrix: $*" >&2; bun "$_TAP_SCRIPT_DIR/../../../runtime/bun/src/reset.ts" release "$TAP_HOME" --token "$token" 2>/dev/null || true; exit 1; }

# verb | argv...
# Keep status/tick out — read-only / successful no-op by design.
# `done` is out too: it is a stateless tombstone that writes nothing, so it
# has no fence to refuse.
# `outstanding` is on this list because it stopped being read-only: it now MOVES
# malformed outbound payloads into .quarantine, so relocating a canonical while
# `tap team reset` is checkpointing lets the archive and the live tree disagree
# about what a payload was. Membership here is decided by whether the verb can
# WRITE, not by what its name suggests.
while IFS='|' read -r name args; do
  [ -n "$name" ] || continue
  set +e
  # shellcheck disable=SC2086
  out="$(eval "\"$TAP\" $args" 2>&1)"
  rc=$?
  set -e
  [ "$rc" != 0 ] || fail "$name: expected fence refusal, got exit 0: $out"
  [[ "$out" == *team_reset_fenced* || "$out" == *mid-reset* || "$out" == *reset.fence* ]] \
    || fail "$name: refusal must name fence; got: $out"
done <<'ROWS'
send|send alice -m hi --from bob
reply|reply matrix-1 -m hi --by bob
poll|poll bob
register|register bob --delivery poll --team matrix
cancel|cancel matrix-1 --by bob
unregister|unregister bob
command|command compact bob
compact|compact bob -m 'keep the fence matrix honest'
watch-on|watch on -m 'x' --by bob
watch-pause|watch pause -m 'x' --by bob
watch-resume|watch resume --by bob
watch-ack|watch ack --by bob
watch-off|watch off --by bob
goalie-on|goalie on --by bob
goalie-off|goalie off --by bob
team-refresh|team refresh
team-down|team down --yes --keep-self
session-repair|session repair --all --dry-run
outstanding|outstanding bob
ROWS

snap_after="$(cd "$TAP_HOME" && find . -type f -print0 | sort -z | xargs -0 cksum | cksum | awk '{print $1}')"
# Fence + lock may appear; ignore those two paths for bus identity of payload/registry.
python3 -B - "$TAP_HOME" "$WORK/matrix-1.expected" <<'PY'
import os, sys
root, expected_path = sys.argv[1], sys.argv[2]
got = open(os.path.join(root, "payloads/matrix-1.md")).read()
exp = open(expected_path).read()
assert got == exp, (got, exp)
assert "bob" in open(os.path.join(root, "registry.json")).read()
print("ok")
PY
[ -f "$TAP_HOME/reset.fence.json" ] || fail "fence missing after matrix"
cmp "$WORK/matrix/.tap/team-registry.json" "$WORK/registry.expected" || fail "matrix changed the acting registry"
bun "$_TAP_SCRIPT_DIR/../../../runtime/bun/src/reset.ts" release "$TAP_HOME" --token "$token"
echo "reset-mutator-fence-matrix: ok"
