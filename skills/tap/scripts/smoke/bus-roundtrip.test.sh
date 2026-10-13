#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
TAP_HOME="$(mktemp -d)"
trap 'rm -rf "$TAP_HOME"' EXIT
export TAP_HOME

mkdir -p "$TAP_HOME/payloads"
cat > "$TAP_HOME/payloads/old-done.md" <<'EOF'
---
id: old-done
from: alice
to: codex
kind: discuss
reply: settle-only
path: tmp/tap/payloads/old-done.md
---

old settled dogfood payload
EOF
"$TAP" read old-done --by codex

cat > "$TAP_HOME/payloads/bus-smoke.md" <<'EOF'
---
id: bus-smoke
from: alice
to: codex
kind: discuss
reply: settle-only
path: tmp/tap/payloads/bus-smoke.md
---

hello
EOF

set +e
before="$("$TAP" poll codex)"
rc="$?"
set -e
[ "$rc" -eq 0 ] || { echo "bus-roundtrip: poll with pending payload should exit 0 and list it, got $rc" >&2; exit 1; }
case "$before" in
  *"bus-smoke"*"alice"*"note"*) ;;
  *) echo "bus-roundtrip: poll did not list unprocessed payload" >&2; exit 1 ;;
esac

"$TAP" read bus-smoke --by codex

after="$("$TAP" poll codex)"
case "$after" in
  *bus-smoke*) echo "bus-roundtrip: done payload still listed" >&2; exit 1 ;;
esac

cat > "$TAP_HOME/payloads/wrong-name.md" <<'EOF'
---
id: right-name
from: alice
to: codex
kind: discuss
reply: settle-only
path: tmp/tap/payloads/right-name.md
---

bad id
EOF

# New contract (v0.2 poll): a filename/id mismatch is a malformed payload and is
# SKIPPED with a warning on stderr. poll exits 0 whether or not anything is
# pending, so the empty-state line proves no valid pending payload remains; the
# warning still identifies the mismatch so operators can find the corrupt file.
"$TAP" poll codex >"$TAP_HOME/mismatch-stdout.out" 2>"$TAP_HOME/mismatch-stderr.out" || {
  echo "bus-roundtrip: mismatched-only inbox should exit 0, got non-zero" >&2
  exit 1
}
grep -qx 'tap poll: empty' "$TAP_HOME/mismatch-stdout.out" || {
  echo "bus-roundtrip: a mismatched-only inbox should report empty, not list the malformed payload" >&2
  cat "$TAP_HOME/mismatch-stdout.out" >&2
  exit 1
}
grep -qE 'quarantin' "$TAP_HOME/mismatch-stdout.out" || {
  echo "bus-roundtrip: a filename/id mismatch was not quarantined and pointed at on stdout" >&2
  cat "$TAP_HOME/mismatch-stdout.out" >&2
  exit 1
}
[ -f "$TAP_HOME/payloads/.quarantine/wrong-name.md" ] || {
  echo "bus-roundtrip: the mismatched payload was not moved into the quarantine" >&2
  exit 1
}

echo "bus-roundtrip: ok"
