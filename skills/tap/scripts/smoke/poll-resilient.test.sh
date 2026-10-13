#!/usr/bin/env bash
# poll-resilient.test.sh — proves malformed payloads do not starve valid siblings
# and that tap poll exits 0 and lists valid pending items despite malformed
# canonicals (pending mail is state, not an error).
#
# Covers CONTRACT.md §Poll malformed-payload contract:
#   (a) one malformed payload addressed to codex does NOT hide a valid sibling
#   (b) tap poll exits 0 when valid messages were listed despite a malformed sibling
#   (c) warnings go to stderr; valid items go to stdout; each valid item has a
#       'next step: tap done <id> --by <me>' or `tap reply` hint
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"
# shellcheck source=skills/tap/scripts/smoke/helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/helpers.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"; TAP_HOME="$WORK/repo/.tap/bus"
STDOUT_F="$(mktemp)"
STDERR_F="$(mktemp)"
trap 'rm -rf "$WORK" "$STDOUT_F" "$STDERR_F"' EXIT
export TAP_HOME
tap_smoke_enroll_current "$WORK/repo" "$TAP_HOME" team

mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"

# --- malformed payload: to=codex but missing required 'from' field -----------
cat > "$TAP_HOME/payloads/malformed-a.md" <<'EOF'
---
id: malformed-a
to: codex
kind: discuss
path: tmp/tap/payloads/malformed-a.md
---
this payload is missing the 'from' field
EOF

# --- malformed payload with unreadable routing: missing 'to' must still warn --
cat > "$TAP_HOME/payloads/malformed-no-to.md" <<'EOF'
---
id: malformed-no-to
from: claude
kind: discuss
path: tmp/tap/payloads/malformed-no-to.md
---
this payload is missing the 'to' field
EOF

# --- valid payload addressed to codex ----------------------------------------
cat > "$TAP_HOME/payloads/valid-a.md" <<'EOF'
---
id: valid-a
from: claude
to: codex
kind: discuss
path: tmp/tap/payloads/valid-a.md
---
this payload is valid and complete
EOF

# --- valid settle-only terminal payload with epoch: the done hint must preserve the
# live epoch (a settle-only item owes no reply, so it teaches `tap done`, not reply) --
cat > "$TAP_HOME/payloads/terminal-a.md" <<'EOF'
---
id: terminal-a
from: claude
to: codex
kind: terminal
reply: settle-only
path: tmp/tap/payloads/terminal-a.md
epoch: 7
---
terminal payload
EOF

# (b) tap poll exits 0 (pending mail is state, not an error) despite malformed
#     payloads; (a) below proves the valid sibling is listed
set +e
"$TAP" poll codex >"$STDOUT_F" 2>"$STDERR_F"
rc="$?"
set -e
[ "$rc" -eq 0 ] || {
  echo "poll-resilient: expected exit 0 when valid pending items exist beside malformed ones, got $rc" >&2
  echo "--- stdout ---" >&2; cat "$STDOUT_F" >&2
  echo "--- stderr ---" >&2; cat "$STDERR_F" >&2
  exit 1
}

# (a) valid payload appears in stdout
grep -q "valid-a" "$STDOUT_F" || {
  echo "poll-resilient: valid payload not listed when malformed sibling present" >&2
  echo "--- stdout ---" >&2; cat "$STDOUT_F" >&2
  echo "--- stderr ---" >&2; cat "$STDERR_F" >&2
  exit 1
}

# malformed payload must NOT appear in stdout
if grep -q "malformed-a" "$STDOUT_F"; then
  echo "poll-resilient: malformed payload id appeared in poll stdout" >&2
  exit 1
fi

# warning about malformed payload goes to stderr
# Disposal changed with the malformed-payload quarantine (tap-7r3fn.7): a
# malformed payload is MOVED to payloads/.quarantine/ once and pointed at on
# stdout, instead of warned about on stderr on every poll forever. The property this arm guards is unchanged — a
# bad file is reported and does not vanish silently — so it now looks where the
# report actually goes.
grep -qE 'quarantin' "$STDOUT_F" || {
  echo "poll-resilient: no quarantine pointer on stdout for malformed payload" >&2
  echo "--- stdout was ---" >&2; cat "$STDOUT_F" >&2
  echo "--- stderr was ---" >&2; cat "$STDERR_F" >&2
  exit 1
}
[ -f "$TAP_HOME/payloads/.quarantine/malformed-no-to.md" ] || {
  echo "poll-resilient: missing-to malformed payload was silently skipped" >&2
  echo "--- stderr was ---" >&2; cat "$STDERR_F" >&2
  exit 1
}

# (c) next step hint in stdout for valid items. valid-a is reply-expected (no reply
# field ⇒ expected), so it teaches `tap reply`; terminal-a is settle-only with an
# epoch, so it teaches `tap read … --epoch`.
grep -q "next step: tap reply valid-a -f" "$STDOUT_F" || {
  echo "poll-resilient: reply hint missing for reply-expected valid-a in stdout" >&2
  cat "$STDOUT_F" >&2
  exit 1
}
grep -q "next step: tap read terminal-a --by codex --epoch 7" "$STDOUT_F" || {
  echo "poll-resilient: settle-only terminal epoch missing from read hint" >&2
  cat "$STDOUT_F" >&2
  exit 1
}

# done: valid item should disappear after settlement
printf '%s\n' '{"schema": "0.20", "team":{"name":"team"},"seats":{"codex":{"status":"active","delivery":"poll"},"claude":{"status":"active","delivery":"poll"}}}' > "$TAP_HOME/registry.json"
printf 'answer\n' > "$TAP_HOME/answer.txt"
"$TAP" reply valid-a --by codex -f "$TAP_HOME/answer.txt"
hint="$(sed -n 's/^next step: tap read terminal-a /read terminal-a /p' "$STDOUT_F")"
# Execute the command that poll taught, not a separately reconstructed command.
"$TAP" $hint
after="$("$TAP" poll codex 2>/dev/null)"
case "$after" in *"tap poll: empty"*) ;; *)
  echo "poll-resilient: settled valid-a still listed; malformed-a should also be gone from output" >&2
  echo "$after" >&2
  exit 1
  ;;
esac

echo "poll-resilient: ok"
