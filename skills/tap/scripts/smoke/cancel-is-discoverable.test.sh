#!/usr/bin/env bash
# cancel-is-discoverable.test.sh — the surfaces that REPORT an unsettleable send
# must NAME the verb that clears it.
#
# tap-fcd3, the half that explains the incident. `tap cancel` was contract-documented
# the whole time; two sends still sat outstanding for 20h and 28h because the operator,
# the lead, AND the bead author each failed to discover it — the bead enumerated
# done/adoption/admin/doctor and never grepped for cancel. Existence is not
# discoverability. A verb nothing points at is a verb nobody runs.
#
# These arms are deliberately about TEXT, because text is the whole mechanism here.
# They assert on the two doors a stuck sender actually walks into.
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
fail() { echo "cancel-is-discoverable: $*" >&2; exit 1; }

HOME_DIR="$WORK/team"
mkdir -p "$HOME_DIR/tmp/tap/payloads" "$HOME_DIR/tmp/tap/receipts"
cat >"$HOME_DIR/tmp/tap/registry.json" <<'JSON'
{
  "schema": "0.20", "team": { "name": "T" },
  "seats": {
    "alice": { "status": "active", "delivery": "poll", "harness": "claude",
               "registered_at": "t", "pane": "", "pane_id": "" }
  }
}
JSON
export TAP_HOME="$HOME_DIR/tmp/tap"
export TAP_REGISTRY="$TAP_HOME/registry.json"
export TAP_INDEX_HOME="$WORK/index"
mkdir -p "$TAP_INDEX_HOME"
mkdir -p "$TAP_INDEX_HOME" && printf '{"schema":"0.20","teams":{}}\n' > "$TAP_INDEX_HOME/global-registry.json"  # born live (F1)

# An OLD outstanding send. The id timestamp is the age source (never file mtime),
# so a 2020 stamp is reliably past the hint threshold.
OLD="alice-20200101T000000Z-stale0001"
cat >"$TAP_HOME/payloads/${OLD}.md" <<EOF
---
id: $OLD
from: alice
to: ghost
kind: discuss
path: $TAP_HOME/payloads/${OLD}.md
reply: expected
---
old body
EOF
: >"$TAP_HOME/receipts/${OLD}.sent"

set +e
out="$(cd "$HOME_DIR" && env TAP_HOME="$TAP_HOME" TAP_INDEX_HOME="$TAP_INDEX_HOME" \
  "$TAP" outstanding alice 2>&1)"
rc=$?
set -e

# Fixture validity: if the send were not listed, the naming arm below would be
# vacuous — it would pass on an empty report that mentions nothing at all.
grep -q "$OLD" <<<"$out" || fail "fixture: the aged send must be listed; got: $out"
[ "$rc" -eq 0 ] || fail "fixture: outstanding with entries exits 0 (open sends are state, not an error), got $rc"
echo "  ok   fixture: the aged send is listed"

grep -q "tap cancel" <<<"$out" \
  || fail "an AGED outstanding send must name 'tap cancel'; got: $out"
echo "  ok   aged outstanding names tap cancel"

# --- the other direction: a FRESH send must NOT be told to cancel itself -------
# Without this, the arm above is satisfied by printing the hint unconditionally,
# which would train every reader to ignore it.
rm -f "$TAP_HOME/payloads/${OLD}.md" "$TAP_HOME/receipts/${OLD}.sent"
NOW_ID="alice-$(date -u +%Y%m%dT%H%M%SZ)-fresh001"
cat >"$TAP_HOME/payloads/${NOW_ID}.md" <<EOF
---
id: $NOW_ID
from: alice
to: ghost
kind: discuss
path: $TAP_HOME/payloads/${NOW_ID}.md
reply: expected
---
fresh body
EOF
: >"$TAP_HOME/receipts/${NOW_ID}.sent"
set +e
out2="$(cd "$HOME_DIR" && env TAP_HOME="$TAP_HOME" TAP_INDEX_HOME="$TAP_INDEX_HOME" \
  "$TAP" outstanding alice 2>&1)"
set -e
grep -q "$NOW_ID" <<<"$out2" || fail "fixture: the fresh send must be listed; got: $out2"
grep -q "tap cancel" <<<"$out2" \
  && fail "a FRESH in-flight send must NOT be told to cancel; got: $out2"
echo "  ok   fresh send is not told to cancel"

# --- --stale is an explicit hunt, so it always names the verb ------------------
set +e
out3="$(cd "$HOME_DIR" && env TAP_HOME="$TAP_HOME" TAP_INDEX_HOME="$TAP_INDEX_HOME" \
  "$TAP" outstanding alice --stale 1 2>&1)"
set -e
if grep -q "$NOW_ID" <<<"$out3"; then
  grep -q "tap cancel" <<<"$out3" \
    || fail "--stale must name tap cancel; got: $out3"
  echo "  ok   --stale names tap cancel"
else
  echo "  ok   --stale filtered the fresh send out (nothing to name)"
fi

# Settlement-refusal guidance is exercised through read/reply/done by
# local-adoption-authority.test.sh (T6), including sender cancel and actor-only
# restoration. The old source grep here named the settle script's duplicated gate;
# the shared helper moves that predicate, so keep the control on its effects.

echo "cancel-is-discoverable: ok"
