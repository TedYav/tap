#!/usr/bin/env bash
# poll-exit-codes.test.sh -- U6 (R7, AE4): empty poll teaches the non-terminal golden rule and
# exits 0; pending poll lists work and also exits 0. Pending mail is state, not an
# error (CLI-STANDARDS exit rule), so the exit status never distinguishes listed from
# empty: the output does. Non-zero stays reserved for errors (usage exits 1).
# Outstanding follows the same rule and prints an empty-state line.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
TAP_HOME="$(mktemp -d)"
trap 'rm -rf "$TAP_HOME"' EXIT
export TAP_HOME
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"

set +e
"$TAP" poll codex >"$TAP_HOME/empty-poll.stdout" 2>"$TAP_HOME/empty-poll.stderr"
rc="$?"
set -e
[ "$rc" -eq 0 ] || { echo "poll-exit-codes: empty poll expected exit 0, got $rc" >&2; exit 1; }
grep -qx 'tap poll: empty' "$TAP_HOME/empty-poll.stdout" || {
  echo "poll-exit-codes: empty poll should keep independent work moving" >&2
  cat "$TAP_HOME/empty-poll.stdout" >&2
  exit 1
}
echo "poll-exit-codes: empty poll exits 0 and keeps independent work moving: ok"

cat > "$TAP_HOME/payloads/pending-a.md" <<'EOF'
---
id: pending-a
from: claude
to: codex
kind: discuss
reply: settle-only
path: tmp/tap/payloads/pending-a.md
---
body
EOF

set +e
"$TAP" poll codex >"$TAP_HOME/pending-poll.stdout" 2>"$TAP_HOME/pending-poll.stderr"
rc="$?"
set -e
[ "$rc" -eq 0 ] || { echo "poll-exit-codes: pending poll expected exit 0, got $rc" >&2; cat "$TAP_HOME/pending-poll.stdout" >&2; exit 1; }
grep -q 'pending-a' "$TAP_HOME/pending-poll.stdout" || { echo "poll-exit-codes: pending item missing" >&2; cat "$TAP_HOME/pending-poll.stdout" >&2; exit 1; }
grep -q 'next step' "$TAP_HOME/pending-poll.stdout" || { echo "poll-exit-codes: pending hint missing" >&2; cat "$TAP_HOME/pending-poll.stdout" >&2; exit 1; }
if grep -qx 'tap poll: empty' "$TAP_HOME/pending-poll.stdout"; then
  echo "poll-exit-codes: pending poll also claimed an empty inbox" >&2; cat "$TAP_HOME/pending-poll.stdout" >&2; exit 1
fi
echo "poll-exit-codes: pending poll exits 0 and lists the item with its hint: ok"

set +e
"$TAP" poll codex --json >"$TAP_HOME/pending-poll.json" 2>"$TAP_HOME/pending-poll-json.stderr"
rc="$?"
set -e
[ "$rc" -eq 0 ] || { echo "poll-exit-codes: pending poll --json expected exit 0, got $rc" >&2; cat "$TAP_HOME/pending-poll.json" >&2; exit 1; }
python3 -B -c 'import json, sys; d = json.load(open(sys.argv[1])); assert d.get("ok") is True and [r.get("id") for r in d.get("pending", [])] == ["pending-a"], d' \
  "$TAP_HOME/pending-poll.json" || { echo "poll-exit-codes: pending poll --json did not list exactly pending-a" >&2; cat "$TAP_HOME/pending-poll.json" >&2; exit 1; }
echo "poll-exit-codes: pending poll --json exits 0 and its pending array carries the item: ok"

set +e
"$TAP" poll codex --bogus >"$TAP_HOME/usage-poll.stdout" 2>"$TAP_HOME/usage-poll.stderr"
rc="$?"
set -e
[ "$rc" -eq 1 ] || { echo "poll-exit-codes: poll usage error expected exit 1, got $rc" >&2; cat "$TAP_HOME/usage-poll.stderr" >&2; exit 1; }
echo "poll-exit-codes: a usage error still exits 1: ok"

cat > "$TAP_HOME/payloads/malformed-a.md" <<'EOF'
---
id: malformed-a
from: claude
kind: discuss
reply: settle-only
path: tmp/tap/payloads/malformed-a.md
---
missing to
EOF
set +e
"$TAP" poll codex >"$TAP_HOME/mixed-poll.stdout" 2>"$TAP_HOME/mixed-poll.stderr"
rc="$?"
set -e
[ "$rc" -eq 0 ] || { echo "poll-exit-codes: valid pending + malformed sibling expected exit 0, got $rc" >&2; exit 1; }
grep -q 'pending-a' "$TAP_HOME/mixed-poll.stdout" || { echo "poll-exit-codes: valid pending hidden by malformed sibling" >&2; exit 1; }
# tap-7r3fn.7: a malformed payload is quarantined once and pointed at on stdout,
# instead of re-warned on stderr on every poll. Exit status unchanged (asserted
# above); the file must still be reported and must still be findable.
grep -qE 'quarantin' "$TAP_HOME/mixed-poll.stdout" || { echo "poll-exit-codes: malformed sibling was not quarantined and reported" >&2; cat "$TAP_HOME/mixed-poll.stdout" >&2; exit 1; }
[ -f "$TAP_HOME/payloads/.quarantine/malformed-a.md" ] || { echo "poll-exit-codes: malformed-a was not moved into the quarantine" >&2; exit 1; }
echo "poll-exit-codes: malformed sibling warns without changing the exit status or hiding the valid item: ok"

"$TAP" read pending-a --by codex
set +e
"$TAP" poll codex >"$TAP_HOME/settled-poll.stdout" 2>"$TAP_HOME/settled-poll.stderr"
rc="$?"
set -e
[ "$rc" -eq 0 ] || { echo "poll-exit-codes: settled poll expected exit 0, got $rc" >&2; exit 1; }
grep -qx 'tap poll: empty' "$TAP_HOME/settled-poll.stdout" || { echo "poll-exit-codes: settled empty poll missing non-terminal golden rule" >&2; cat "$TAP_HOME/settled-poll.stdout" >&2; exit 1; }
echo "poll-exit-codes: settled inbox returns to empty exit 0: ok"

set +e
"$TAP" outstanding codex >"$TAP_HOME/empty-outstanding.stdout" 2>"$TAP_HOME/empty-outstanding.stderr"
rc="$?"
set -e
[ "$rc" -eq 0 ] || { echo "poll-exit-codes: empty outstanding expected exit 0, got $rc" >&2; exit 1; }
grep -qi 'no outstanding' "$TAP_HOME/empty-outstanding.stdout" || {
  echo "poll-exit-codes: empty outstanding should say there is nothing outstanding" >&2
  cat "$TAP_HOME/empty-outstanding.stdout" >&2
  exit 1
}
echo "poll-exit-codes: empty outstanding prints an empty state: ok"

echo "poll-exit-codes: ok"
