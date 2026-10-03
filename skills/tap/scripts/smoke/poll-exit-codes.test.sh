#!/usr/bin/env bash
# poll-exit-codes.test.sh -- U6 (R7, AE4): empty poll teaches the non-terminal golden rule and
# exits 0; pending poll lists work and exits 2. Outstanding keeps 0/2 and gains an
# empty-state line.
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
[ "$rc" -eq 2 ] || { echo "poll-exit-codes: pending poll expected exit 2, got $rc" >&2; cat "$TAP_HOME/pending-poll.stdout" >&2; exit 1; }
grep -q 'pending-a' "$TAP_HOME/pending-poll.stdout" || { echo "poll-exit-codes: pending item missing" >&2; cat "$TAP_HOME/pending-poll.stdout" >&2; exit 1; }
grep -q 'next step' "$TAP_HOME/pending-poll.stdout" || { echo "poll-exit-codes: pending hint missing" >&2; cat "$TAP_HOME/pending-poll.stdout" >&2; exit 1; }
echo "poll-exit-codes: pending poll exits 2 with item and hint: ok"

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
[ "$rc" -eq 2 ] || { echo "poll-exit-codes: valid pending + malformed sibling expected exit 2, got $rc" >&2; exit 1; }
grep -q 'pending-a' "$TAP_HOME/mixed-poll.stdout" || { echo "poll-exit-codes: valid pending hidden by malformed sibling" >&2; exit 1; }
# tap-7r3fn.7: a malformed payload is quarantined once and pointed at on stdout,
# instead of re-warned on stderr on every poll. Exit contract unchanged (asserted
# above); the file must still be reported and must still be findable.
grep -qE 'quarantin' "$TAP_HOME/mixed-poll.stdout" || { echo "poll-exit-codes: malformed sibling was not quarantined and reported" >&2; cat "$TAP_HOME/mixed-poll.stdout" >&2; exit 1; }
[ -f "$TAP_HOME/payloads/.quarantine/malformed-a.md" ] || { echo "poll-exit-codes: malformed-a was not moved into the quarantine" >&2; exit 1; }
echo "poll-exit-codes: malformed sibling warns without changing pending exit semantics: ok"

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
