#!/usr/bin/env bash
# help-wall-clock.test.sh — tap-v8o8: `tap help` stays interactive-cheap.
#
# THIS LIVES IN regress/ ON PURPOSE. It is a wall-clock assertion, and a
# wall-clock assertion is a different number on a loaded box than on an idle
# one: the work behind it was benchmarked at load ~10 on a machine running an
# overnight agent team. Inside the parallel merge gate it would red for reasons
# having nothing to do with the code, and this repo deletes a flaking test
# rather than re-parking it — so gating on it would eventually delete the guard.
# The GATE assertion is the deterministic one, smoke/help-forks-zero.test.sh
# (zero python3 starts). This file is the operator-initiated companion that
# answers "is it still fast in wall-clock terms", run via scripts/regress-all.sh.
#
# The ceiling is deliberately loose. Measured medians on this hardware: ~947ms
# before the change (registered seat's bus, load ~10), ~30ms after. A 400ms
# ceiling therefore has better than a 10x margin over the observed number and
# still catches the regression that matters — any reintroduction of per-verb
# state reads on the help path, each of which costs a ~25ms interpreter start.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "help-wall-clock: $*" >&2; exit 1; }

CEILING_MS=400
RUNS=9

# Same fixture as the gate smoke: a live marker, an enrolled team, and an
# overdue inbound payload — the conditions under which the preamble had real
# work to do. Timing an empty sandbox would flatter the result.
export TAP_INDEX_HOME="$WORK/index"
export TAP_HOME="$WORK/team/.tap/bus"
mkdir -p "$TAP_INDEX_HOME" "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$WORK/team/.tap"
cat > "$TAP_INDEX_HOME/global-registry.json" <<EOF
{"schema": "0.20", "teams": {"team": {"root": "$WORK/team", "registry_location": "$WORK/team/.tap/team-registry.json"}}}
EOF
cat > "$WORK/team/.tap/team-registry.json" <<'EOF'
{"schema": "0.20", "team": {"name": "team"}, "seats": {"seat": {"handle": "seat", "harness": "claude", "delivery": "poll", "status": "active"}}}
EOF
OVERDUE="$TAP_HOME/payloads/seat-19700101T000000Z-aaaaaaaaaaaa.md"
cat > "$OVERDUE" <<EOF
---
id: seat-19700101T000000Z-aaaaaaaaaaaa
from: other
to: seat
kind: discuss
path: $OVERDUE
reply: settle-only
---
an inbound payload old enough to be overdue
EOF
# `path:` and TAP_SELF are what make this an overdue payload the advisory would
# actually act on. Without them the envelope is invalid and the caller resolves
# to nobody, so the preamble this timing exists to measure would return early —
# the fixture would be timing a condition it never created.
export TAP_SELF=seat

# One warm run first: the first invocation pays page-cache and filesystem costs
# that say nothing about the dispatch path.
bash "$TAP" help >/dev/null 2>&1 || true

TIMEFORMAT=%R
samples="$WORK/samples"
: > "$samples"
for _ in $(seq "$RUNS"); do
  { time bash "$TAP" help >/dev/null 2>&1 ; } 2>> "$samples"
done
sort -n "$samples" -o "$samples"
median_s="$(sed -n "$(( RUNS / 2 + 1 ))p" "$samples")"
median_ms="$(python3 -B -c 'import sys; print(int(float(sys.argv[1]) * 1000))' "$median_s")"

load="$(uptime | sed 's/.*averages*: //')"
echo "help-wall-clock: median ${median_ms}ms over $RUNS runs (ceiling ${CEILING_MS}ms, load ${load})"
[ "$median_ms" -le "$CEILING_MS" ] \
  || fail "'tap help' median ${median_ms}ms exceeds the ${CEILING_MS}ms ceiling (load ${load}). Either the dispatch path regained per-verb state reads, or this box is too busy to measure — check smoke/help-forks-zero.test.sh first: if the fork count is still 0, suspect the box, not the code."

echo "help-wall-clock: all checks passed"
