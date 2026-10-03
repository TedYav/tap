#!/usr/bin/env bash
# scratch-only-interlock.test.sh — TAP_SCRATCH_ONLY guards the resolved roots
# of the remaining team-scoped state-clearing verbs.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

REAL="$WORK/real"
SCRATCH="$WORK/scratch"
REAL_BUS="$REAL/team/.tap/bus"
SCRATCH_BUS="$SCRATCH/team/.tap/bus"

fail() {
  echo "scratch-only: $1" >&2
  shift
  [ "$#" = 0 ] || printf '%s\n' "$@" >&2
  exit 1
}

seed_bus() { # <bus> <payload body>
  mkdir -p "$1/payloads" "$1/receipts"
  printf '%s\n' "$2" >"$1/payloads/p1.md"
  printf '%s\n' '{"schema": "0.20", "team":{"name":"scratch"},"seats":{"seat":{"status":"active","delivery":"poll"}}}' >"$1/registry.json"
}

# (1) A reset whose resolved bus is outside the declared prefix refuses before
# mutation, names both paths, and keeps the structured refusal class.
export TAP_SCRATCH_ONLY="$SCRATCH"
seed_bus "$REAL_BUS" "real traffic"
set +e
out="$(TAP_HOME="$REAL_BUS" "$TAP" team reset --yes 2>&1)"; rc=$?
json_out="$(TAP_HOME="$REAL_BUS" "$TAP" team reset --yes --json 2>/dev/null)"; json_rc=$?
set -e
[ "$rc" -ne 0 ] || fail "(1) reset outside the declared prefix must refuse" "$out"
[[ "$out" == *"TAP_SCRATCH_ONLY"* && "$out" == *"$SCRATCH"* && "$out" == *"$REAL_BUS"* ]] \
  || fail "(1) refusal must name the interlock, declared prefix, and resolved bus" "$out"
[ "$json_rc" -ne 0 ] || fail "(1) JSON reset outside the declared prefix must refuse" "$json_out"
printf '%s' "$json_out" | python3 -c '
import json, sys
row = json.load(sys.stdin)
assert row["ok"] is False and row["error_class"] == "scratch_only_refused", row
' || fail "(1) JSON refusal lost scratch_only_refused" "$json_out"
[ -f "$REAL_BUS/payloads/p1.md" ] || fail "(1) refused reset removed a payload"
[ ! -d "$REAL_BUS/archive" ] || fail "(1) refused reset created an archive"
echo "scratch-only: (1) outside reset refuses before mutation with JSON parity: ok"

# (2) The same verb is permitted when resolution lands inside the prefix.
seed_bus "$SCRATCH_BUS" "scratch traffic"
TAP_HOME="$SCRATCH_BUS" "$TAP" team reset --yes >/dev/null 2>&1 \
  || fail "(2) reset inside the declared prefix must be permitted"
[ -n "$(find "$SCRATCH_BUS/archive/team-reset" -name p1.md -print -quit 2>/dev/null)" ] \
  || fail "(2) permitted reset did not archive its bus"
echo "scratch-only: (2) inside reset is permitted: ok"

# (3) The interlock remains opt-in: unsetting it restores normal behavior.
env -u TAP_SCRATCH_ONLY TAP_HOME="$REAL_BUS" "$TAP" team reset --yes >/dev/null 2>&1 \
  || fail "(3) unset interlock changed reset behavior"
[ -n "$(find "$REAL_BUS/archive/team-reset" -name p1.md -print -quit 2>/dev/null)" ] \
  || fail "(3) unguarded reset did not archive normally"
[ ! -f "$REAL_BUS/payloads/p1.md" ] || fail "(3) unguarded reset did not clear the bus"
echo "scratch-only: (3) unset interlock leaves reset behavior unchanged: ok"

# (4) Purge checks the exact recovery archive it would remove. A refusal keeps
# it; a declaration covering that archive permits the same operation.
archive_dir="$(find "$REAL_BUS/archive/team-reset" -mindepth 1 -maxdepth 1 -type d -print -quit)"
[ -n "$archive_dir" ] || fail "(4) fixture has no recovery archive"
archive_name="$(basename "$archive_dir")"
# Born live, purge resolves the team through its registry, which reset (3)
# archived; a live team re-registers before it purges.
printf '%s\n' '{"schema": "0.20", "team":{"name":"scratch"},"seats":{}}' >"$REAL_BUS/registry.json"
set +e
out="$(TAP_HOME="$REAL_BUS" "$TAP" team purge "$archive_name" --yes 2>&1)"; rc=$?
set -e
[ "$rc" -ne 0 ] || fail "(4) purge outside the declared prefix must refuse" "$out"
[[ "$out" == *"TAP_SCRATCH_ONLY"* ]] || fail "(4) purge refusal must name the interlock" "$out"
[ -d "$archive_dir" ] || fail "(4) refused purge removed the archive"
TAP_SCRATCH_ONLY="$WORK" TAP_HOME="$REAL_BUS" "$TAP" team purge "$archive_name" --yes >/dev/null 2>&1 \
  || fail "(4) covering declaration must permit purge"
[ ! -e "$archive_dir" ] || fail "(4) permitted purge left the archive behind"
echo "scratch-only: (4) purge checks its resolved archive and preserves it on refusal: ok"

echo "scratch-only: ok"
