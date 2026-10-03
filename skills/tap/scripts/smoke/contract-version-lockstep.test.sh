#!/usr/bin/env bash
# focused-inventory: tree (tap-z5nl6)
# D5: source-read — skills/tap/scripts/smoke/contract-version-lockstep.test.sh:11,13: grep-reads module source for invariants; no module behavior is exec'd or asserted
# contract-version-lockstep.test.sh — the CONTRACT's grammar examples drift
# behind TAP_SENTINEL_VERSION on every bump (flagged in review,
# recurred later). One assertion, forever: title, grammar token, and every
# v=X.Y occurrence in the spec match the constant implementers copy from.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
SENTINEL="$ROOT/runtime/bun/src/sentinel.ts"
CONTRACT="$ROOT/skills/tap/scripts/CONTRACT.md"

ver="$(grep -o 'SENTINEL_VERSION = "[0-9.]*"' "$SENTINEL" | cut -d'"' -f2)"
[ -n "$ver" ] || { echo "lockstep: SENTINEL_VERSION not found in sentinel.ts" >&2; exit 1; }

grep -q "^# TAP Contract (v$ver)" "$CONTRACT" \
  || { echo "lockstep: CONTRACT title is not v$ver" >&2; head -1 "$CONTRACT" >&2; exit 1; }
echo "lockstep: (1) title matches v$ver: ok"

# (2) is retired: the contract dropped the standalone "Protocol version (sentinel slot
# 1)" line to keep CONTRACT under its byte cap (5120 since 2026-09-25). Slot 1 is the grammar block's
# own version token, which (3) pins strictly (a following space, so 0.23.1 or
# 0.230 cannot satisfy 0.23).

# (3) THE GRAMMAR BLOCK'S OWN VERSION TOKEN, which is what check (3) used to reach
# by accident. It swept `v=[0-9]` outside the changelog — and v0.23 dropped the `=`
# from the wire, so that sweep now matches nothing and would report clean forever
# while the grammar block drifted. A check that cannot fail is worse than no check:
# it reads as coverage. The replacement asks the question the sweep was standing in
# for — does the ONE place implementers copy the wire shape from carry the
# constant's version? — and it can still fail, which the mutation below proves.
grep -qE '^\[\[TAP v'"$ver"' <ask\|note>' "$CONTRACT" \
  || { echo "lockstep: the §Sentinel grammar block does not carry v$ver" >&2; grep -n '^\[\[TAP' "$CONTRACT" >&2; exit 1; }
echo "lockstep: (3) the grammar block's version token matches $ver: ok"

# (4) No stale v= anywhere outside the changelog. The `=` form is retired, so the
# living spec must carry NONE of it — a different assertion from the old check (3),
# which permitted the current version in that form.
stale="$(grep -v '^\*\*Changes since' "$CONTRACT" | grep -o 'v=[0-9][0-9.]*' | sort -u || true)"
[ -z "$stale" ] || { echo "lockstep: the retired \`v=\` wire form survives outside the changelog: $stale" >&2; exit 1; }
echo "lockstep: (4) no retired v= form outside the changelog: ok"

echo "contract-version-lockstep: ok"
