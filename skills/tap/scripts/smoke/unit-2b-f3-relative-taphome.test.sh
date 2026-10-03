#!/usr/bin/env bash
# unit-2b-f3-relative-taphome.test.sh — F2B-3: a relative TAP_HOME on a
# --cross-worktree send must stamp an ABSOLUTE path: field; never a relative one.
#
# Repro (per brief): TAP_HOME=reltap + --cross-worktree stamps path: reltap/payloads/<id>.md
# (relative) into the canonical — a recipient in another worktree cannot settle it.
# After fix: lib.sh normalizes TAP_HOME to absolute once, early, so path: is absolute.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"

# Create the bus inside $ROOT/tmp/ so a relative path from $ROOT resolves to it.
mkdir -p "$ROOT/tmp"
BUS_ABS="$(mktemp -d "$ROOT/tmp/taptest-f3-XXXXXXXX")"
trap 'rm -rf "$BUS_ABS"' EXIT
BUS_REL="tmp/$(basename "$BUS_ABS")"   # relative from $ROOT
mkdir -p "$BUS_ABS/payloads" "$BUS_ABS/receipts"
cat > "$BUS_ABS/registry.json" <<'JSON'
{
  "schema": "0.20", "team": { "name": "testteam" },
  "seats": {
    "claude": { "pane": "sender-pane", "pane_id": "%f3-smoke", "server_epoch": "srv:900:100", "status": "active" }
  }
}
JSON

# Fake tmux (courier-injects.test.sh pattern)
FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$BUS_ABS" "$FAKE_BIN"' EXIT
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"
mkdir -p "$state"
cmd="${1:-}"; shift || true
case "$cmd" in
  list-sessions) printf 'f3-session\t900:100\n' ;;
  list-panes) printf 'f3-session\tf3-session:0.0\t%%1003\tcodex\t123\t900:100\t0\n' ;;
  display-message)
    fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    case "$fmt" in
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%%1003\tf3-session\t123\tcodex\t0\n' ;;
      '#{pid}:#{start_time}') printf '900:100\n' ;;
      *pane_id*)              echo "%1003" ;;
      *pane_in_mode*)         echo "0" ;;
      *pane_current_command*) echo "codex" ;;
      *)                      echo "" ;;
    esac ;;
  capture-pane)
    if [ -f "$state/input" ]; then printf '› %s\n' "$(cat "$state/input")"
    else printf '› \n'; fi ;;
  send-keys)
    if [ "${1:-}" = "-t" ]; then shift 2; fi
    if [ "${1:-}" = "-l" ]; then
      shift; [ "${1:-}" = "--" ] && shift
      printf '%s' "${1:-}" > "$state/input"; exit 0
    fi
    if [ "${1:-}" = "Enter" ]; then rm -f "$state/input"; exit 0; fi ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH"
export FAKE_TMUX_STATE="$BUS_ABS/fake-tmux"

PAYLOAD="$BUS_ABS/source.md"
cat > "$PAYLOAD" <<'EOF'
---
from: claude
to: codex
kind: discuss
---

test payload for relative TAP_HOME normalization (F2B-3)
EOF

# Run send with RELATIVE TAP_HOME from $ROOT so the relative path resolves.
(
# NOT the tap-68lp crutch — do not delete this cd. This test sets a RELATIVE
# TAP_HOME on purpose, and a relative path is resolved against $PWD by
# definition (lib.sh absolutizes it syntactically). cwd is a PRECONDITION of what
# is under test here, not a workaround for cwd-derived identity.
  cd "$ROOT"
  TAP_HOME="$BUS_REL" "$TAP" send codex "$PAYLOAD" \
    --from claude --id f2b3-relpath --pane f3-session:0.0 \
    --cross-worktree >/dev/null 2>&1
)

CANON="$BUS_ABS/payloads/f2b3-relpath.md"
[ -f "$CANON" ] || {
  echo "unit-2b-f3-relative-taphome: FAIL — canonical not found at expected absolute path" >&2
  echo "  expected: $CANON" >&2
  ls "$BUS_ABS/payloads/" 2>/dev/null || echo "  (payloads dir empty)" >&2
  exit 1
}

# The path: field must be ABSOLUTE (starts with /)
_path_field="$(awk 'NR>1 && /^path:[ \t]/{sub(/^path:[ \t]*/,""); print; exit}' "$CANON")"
case "$_path_field" in
  /*)
    echo "unit-2b-f3-relative-taphome: path field is absolute: ok ('$_path_field')" ;;
  *)
    echo "unit-2b-f3-relative-taphome: FAIL — path field is relative: '$_path_field'" >&2
    echo "  (lib.sh TAP_HOME normalization not applied — relative path stamped into canonical)" >&2
    exit 1 ;;
esac

# The path field must match the canonical's real location (self-consistent)
[ "$_path_field" = "$CANON" ] || {
  echo "unit-2b-f3-relative-taphome: FAIL — path field '$_path_field' != canonical '$CANON'" >&2; exit 1
}
echo "unit-2b-f3-relative-taphome: path field matches canonical location: ok"

echo "unit-2b-f3-relative-taphome: ok"
