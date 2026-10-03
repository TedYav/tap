#!/usr/bin/env bash
# index-collision.test.sh — U8 (R13, AE8): enrolling a team name already indexed at a
# DIFFERENT, still-existing root fails loud naming both paths (no last-writer-wins);
# the original entry survives; same-name/same-root re-enroll is an idempotent no-op.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export TAP_INDEX_HOME="$WORK/index"   # machine index redirect: never touch real ~/.tap
# The marker-SELECTED machine index, resolved AT CALL TIME rather than here.
# These fixtures start on an empty index home, and a machine holding neither
# store is now born live (CONTRACT, global-registry bullet), so the first
# enrollment BELOW is what creates the store. Selecting during setup would
# resolve before either file exists and pin the wrong one -- which is exactly
# what a first attempt at this did. This file is about AE8 collision refusal;
# which store holds the enrollment is incidental to that.
idx_file() {
  if [ -f "$TAP_INDEX_HOME/global-registry.json" ]; then
    printf '%s' "$TAP_INDEX_HOME/global-registry.json"
  else
    printf '%s' "$TAP_INDEX_HOME/teams.json"
  fi
}

new_repo() { git init -q "$1"; git -C "$1" config user.email t@example.invalid; git -C "$1" config user.name t; touch "$1/r"; git -C "$1" add r; git -C "$1" commit -q -m i; }

# Two distinct repos that share the basename "api".
mkdir -p "$WORK/one" "$WORK/two"
new_repo "$WORK/one/api"
new_repo "$WORK/two/api"

# First enroll: api -> one/api.
( cd "$WORK/one/api" && env -u TAP_HOME "$TAP" init >/dev/null ) || { echo "index-collision: first init failed" >&2; exit 1; }
IDX="$(idx_file)"
grep -q "$WORK/one/api" "$IDX" || { echo "index-collision: api not enrolled at one/api (index: $IDX)" >&2; cat "$IDX" >&2; exit 1; }
echo "index-collision: first team 'api' enrolled: ok"

# Second enroll of the SAME name at a DIFFERENT existing path → fail loud naming both.
rc=0; ( cd "$WORK/two/api" && env -u TAP_HOME "$TAP" init >"$WORK/collide.out" 2>&1 ) || rc=$?
[ "$rc" != 0 ] || { echo "index-collision: duplicate-name init should fail" >&2; cat "$WORK/collide.out" >&2; exit 1; }
grep -q "$WORK/one/api" "$WORK/collide.out" || { echo "index-collision: error should name the existing path" >&2; cat "$WORK/collide.out" >&2; exit 1; }
grep -q "$WORK/two/api" "$WORK/collide.out" || { echo "index-collision: error should name the colliding path" >&2; cat "$WORK/collide.out" >&2; exit 1; }
echo "index-collision: (AE8) duplicate-name/different-path enrollment refused naming both: ok"

# The original entry survives — api still resolves to one/api.
python3 - "$IDX" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
root = d["teams"]["api"]["root"]
assert root.endswith("/one/api"), f"api re-pointed to {root}"
PY
echo "index-collision: original 'api' entry unchanged after the collision: ok"

# Same name / same root re-enroll is idempotent (no error, entry stable).
before="$(cat "$IDX")"
( cd "$WORK/one/api" && env -u TAP_HOME "$TAP" init >/dev/null ) || { echo "index-collision: idempotent re-init failed" >&2; exit 1; }
[ "$(cat "$IDX")" = "$before" ] || { echo "index-collision: re-enroll changed the index" >&2; diff <(echo "$before") "$IDX" >&2; exit 1; }
echo "index-collision: same name/same root re-enroll is idempotent: ok"

echo "index-collision: ok"
