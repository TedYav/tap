#!/usr/bin/env bash
# body-file.test.sh — tap-9sjp: -f/--body-file transports literal message
# body bytes. Shell forms and frontmatter-looking text stay data; conflicting
# sources and invalid files refuse; a failed reply never settles its inbound.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh

# tap-7r3fn.20: this fixture is about body-file handling and sends repeatedly to one
# seat, so every send after the first would park in that seat's window instead of
# reaching the behaviour under test.
# A window of zero is the seam that turns it off (ruling 24 keeps this variable
# overriding the short window), and it says so without knowing where the clock
# is stored — unlike deleting the clock directory by hand.
export TAP_AUTOSETTLE_HOLD_SECONDS=0

. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"
# shellcheck source=skills/tap/scripts/smoke/helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/helpers.sh"

# Mock-tmux smoke: production TUI waits prove nothing against this synchronous
# fixture, so keep the established smoke-only scale.
export TAP_TUI_SETTLE_SCALE=0.1

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"; TAP_HOME="$WORK/repo/.tap/bus"
FAKE_BIN="$(mktemp -d)"
trap 'chmod 700 "$TAP_HOME/unreadable.md" 2>/dev/null || true; rm -rf "$WORK" "$FAKE_BIN"' EXIT
export TAP_HOME
tap_smoke_enroll_current "$WORK/repo" "$TAP_HOME" testteam
export FAKE_TMUX_STATE="$TAP_HOME/fake-tmux"
export BACKTICK_PROBE="$TAP_HOME/backtick.probe"
export DOLLAR_PROBE="$TAP_HOME/dollar.probe"

cat > "$FAKE_BIN/tmux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"
mkdir -p "$state"
cmd="$1"; shift
case "$cmd" in
  # CONTRACT §Session-name authority: a pane effect needs exact-session,
  # designated-pane, generation, and live harness evidence.
  list-sessions)
    printf 'testteam/codex\t123:456\ntestteam/claude\t123:456\n' ;;
  list-panes)
    target=""; while [ "$#" -gt 0 ]; do case "$1" in -t) target="${2#=}"; shift 2 ;; *) shift ;; esac; done
    case "$target" in
      testteam/codex) printf 'testteam/codex\tsender-pane\t%%102\tcodex\t4242\t123:456\t0\n' ;;
      testteam/claude) printf 'testteam/claude\tfake-pane\t%%101\tcodex\t4242\t123:456\t0\n' ;;
    esac ;;
  display-message)
    fmt="${@: -1}"
    case "$fmt" in
      *pane_id*session_name*pane_pid*pane_current_command*)
        case " $* " in
          *" sender-pane "*|*" %102 "*) printf '%%102\ttestteam/codex\t4242\tcodex\t0\n' ;;
          *) printf '%%101\ttestteam/claude\t4242\tcodex\t0\n' ;;
        esac ;;
      # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
      *pane_id*pane_tty*session_name*) printf '%%101\t/dev/faketty\tsess\t123:456\n' ;;
      *pane_id*session_name*) printf '%%101\tsess\t123:456\n' ;;
      *'#{pid}:#{start_time}'*) echo "123:456" ;;
      *pane_id*)                echo "%101" ;;
      *pane_in_mode*)           echo "0" ;;
      *pane_current_command*)   echo "codex" ;;
      *)                        echo "" ;;
    esac ;;
  capture-pane)
    if [ -f "$state/input" ]; then printf '› %s\n' "$(cat "$state/input")"
    else printf '› \n'; fi ;;
  send-keys)
    # Native construction retains source bytes in memory, including in flight.
    for f in "${TAP_HOME:?}"/tmp/body-file.*; do
      [ -e "$f" ] || continue
      printf '%s\n' "$f" >> "$state/body-source-files"
    done
    if [ "${1:-}" = "-t" ]; then shift 2; fi
    if [ "${1:-}" = "-l" ]; then
      shift
      [ "${1:-}" = "--" ] && shift
      printf '%s' "${1:-}" > "$state/input"
      exit 0
    fi
    if [ "${1:-}" = "Enter" ]; then rm -f "$state/input"; exit 0; fi ;;
esac
EOF

chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"
cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": { "name": "testteam" },
  "seats": {
    "codex": {
      "pane": "sender-pane",
      "pane_id": "%102",
      "session": "testteam/codex",
      "server_epoch": "srv:123:456",
      "harness": "codex",
      "status": "active"
    },
    "claude": {
      "pane": "fake-pane",
      "pane_id": "%101",
      "session": "testteam/claude",
      "server_epoch": "srv:123:456",
      "harness": "codex",
      "status": "active"
    }
  }
}
JSON

BODY="$TAP_HOME/body.md"
cat > "$BODY" <<'EOF'
---
from: alternate
reply: expected
---
literal `touch "$BACKTICK_PROBE"`
literal $(touch "$DOLLAR_PROBE")
EOF

assert_body_matches() { # <canonical> <body-source> <label>
  python3 -B - "$1" "$2" "$3" <<'PY'
from pathlib import Path
import sys

canonical, source, label = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
lines = canonical.read_bytes().splitlines(keepends=True)
try:
    end = next(i for i, line in enumerate(lines[1:], 1)
               if line.rstrip(b"\r\n") == b"---")
except StopIteration:
    raise SystemExit(f"{label}: canonical has no closing frontmatter fence")
got = b"".join(lines[end + 1:])
want = source.read_bytes()
if got != want:
    raise SystemExit(
        f"{label}: body bytes changed\n"
        f"want={want!r}\n"
        f" got={got!r}"
    )
PY
}

assert_json_error() { # <path> <class> <label>
  python3 -B - "$1" "$2" "$3" <<'PY'
import json, sys

path, expected, label = sys.argv[1:]
data = json.load(open(path))
if data.get("error_class") != expected:
    raise SystemExit(f"{label}: expected {expected}, got {data}")
PY
}

# The separate untouched-main probe establishes that shell composition evaluates
# both forms before TAP sees -m. This test establishes the new path's behavior.
"$TAP" send claude --ask -f "$BODY" --from codex --kind discuss \
  --id body-file-send --pane fake-pane >"$TAP_HOME/send.out" 2>"$TAP_HOME/send.err" \
  || { echo "body-file: literal send failed" >&2; cat "$TAP_HOME/send.out" "$TAP_HOME/send.err" >&2; exit 1; }

CANON="$TAP_HOME/payloads/body-file-send.md"
[ -f "$CANON" ] || { echo "body-file: canonical payload missing" >&2; exit 1; }
grep -q '^from: codex$' "$CANON" \
  || { echo "body-file: courier routing was not authoritative" >&2; cat "$CANON" >&2; exit 1; }
assert_body_matches "$CANON" "$BODY" "body-file send"
[ ! -e "$BACKTICK_PROBE" ] || { echo "body-file: backtick form was evaluated" >&2; exit 1; }
[ ! -e "$DOLLAR_PROBE" ] || { echo "body-file: dollar-paren form was evaluated" >&2; exit 1; }
echo "body-file: send preserves literal body bytes without shell evaluation: ok"

[ ! -e "$FAKE_TMUX_STATE/body-source-files" ] \
  || { echo "body-file: native send wrote temporary source bytes to disk" >&2; exit 1; }
if ls "$TAP_HOME"/tmp/body-file.* >/dev/null 2>&1; then
  echo "body-file: temporary source leaked after success" >&2
  exit 1
fi
echo "body-file: native send keeps source bytes in memory: ok"

cat > "$TAP_HOME/payloads/body-file-in.md" <<EOF
---
id: body-file-in
from: claude
to: codex
kind: discuss
reply: expected
path: $TAP_HOME/payloads/body-file-in.md
---
inbound
EOF
"$TAP" reply body-file-in --body-file "$BODY" --by codex \
  >"$TAP_HOME/reply.out" 2>"$TAP_HOME/reply.err" \
  || { echo "body-file: literal reply failed" >&2; cat "$TAP_HOME/reply.out" "$TAP_HOME/reply.err" >&2; exit 1; }
[ -f "$TAP_HOME/receipts/body-file-in.done" ] \
  || { echo "body-file: successful reply did not settle inbound" >&2; exit 1; }
REPLY_CANON="$(grep -rl '^in_reply_to: body-file-in$' "$TAP_HOME/payloads"/*.md | head -1)"
[ -n "$REPLY_CANON" ] || { echo "body-file: reply canonical missing" >&2; exit 1; }
assert_body_matches "$REPLY_CANON" "$BODY" "body-file reply"
[ ! -e "$BACKTICK_PROBE" ] || { echo "body-file: reply evaluated backtick form" >&2; exit 1; }
[ ! -e "$DOLLAR_PROBE" ] || { echo "body-file: reply evaluated dollar-paren form" >&2; exit 1; }
echo "body-file: reply forwards the same literal-body contract and settles on success: ok"

FULL_PAYLOAD="$TAP_HOME/full-payload.md"
cat > "$FULL_PAYLOAD" <<'EOF'
---
kind: discuss
---
full payload
EOF

set +e
"$TAP" send claude -m "inline" -f "$BODY" --from codex --pane fake-pane --json \
  >"$TAP_HOME/conflict-inline.json" 2>"$TAP_HOME/conflict-inline.err"
rc=$?
set -e
[ "$rc" -eq 1 ] || { echo "body-file: -m plus -f should exit 1, got $rc" >&2; exit 1; }
assert_json_error "$TAP_HOME/conflict-inline.json" usage_error "-m plus -f"

set +e
"$TAP" send claude "$FULL_PAYLOAD" -f "$BODY" --from codex --pane fake-pane --json \
  >"$TAP_HOME/conflict-payload.json" 2>"$TAP_HOME/conflict-payload.err"
rc=$?
set -e
[ "$rc" -eq 1 ] || { echo "body-file: payload plus -f should exit 1, got $rc" >&2; exit 1; }
assert_json_error "$TAP_HOME/conflict-payload.json" usage_error "payload plus -f"
echo "body-file: conflicting message sources refuse instead of choosing one: ok"

set +e
"$TAP" send claude -f "$TAP_HOME/missing.md" --from codex --pane fake-pane --json \
  >"$TAP_HOME/missing.json" 2>"$TAP_HOME/missing.err"
rc=$?
set -e
[ "$rc" -eq 1 ] || { echo "body-file: missing file should exit 1, got $rc" >&2; exit 1; }
assert_json_error "$TAP_HOME/missing.json" not_found "missing body file"

STDIN_BODY="$TAP_HOME/stdin-body.md"
cat > "$STDIN_BODY" <<'EOF'
literal `touch "$BACKTICK_PROBE"`
literal $(touch "$DOLLAR_PROBE")
EOF
"$TAP" send claude --ask -f - --from codex --kind discuss \
  --id body-stdin-send --pane fake-pane >"$TAP_HOME/stdin-send.out" 2>"$TAP_HOME/stdin-send.err" <<'EOF' \
  || { echo "body-file: stdin send failed" >&2; cat "$TAP_HOME/stdin-send.out" "$TAP_HOME/stdin-send.err" >&2; exit 1; }
literal `touch "$BACKTICK_PROBE"`
literal $(touch "$DOLLAR_PROBE")
EOF
assert_body_matches "$TAP_HOME/payloads/body-stdin-send.md" "$STDIN_BODY" "stdin send"
[ ! -e "$BACKTICK_PROBE" ] || { echo "body-file: stdin send evaluated backtick form" >&2; exit 1; }
[ ! -e "$DOLLAR_PROBE" ] || { echo "body-file: stdin send evaluated dollar-paren form" >&2; exit 1; }
echo "body-file: -f - reads a quoted-heredoc body from stdin: ok"

cat > "$TAP_HOME/payloads/body-stdin-in.md" <<EOF
---
id: body-stdin-in
from: claude
to: codex
kind: discuss
reply: expected
path: $TAP_HOME/payloads/body-stdin-in.md
---
inbound
EOF
"$TAP" reply body-stdin-in -f - --by codex \
  >"$TAP_HOME/stdin-reply.out" 2>"$TAP_HOME/stdin-reply.err" <<'EOF' \
  || { echo "body-file: stdin reply failed" >&2; cat "$TAP_HOME/stdin-reply.out" "$TAP_HOME/stdin-reply.err" >&2; exit 1; }
literal `touch "$BACKTICK_PROBE"`
literal $(touch "$DOLLAR_PROBE")
EOF
[ -f "$TAP_HOME/receipts/body-stdin-in.done" ] \
  || { echo "body-file: successful stdin reply did not settle inbound" >&2; exit 1; }
STDIN_REPLY_CANON="$(grep -rl '^in_reply_to: body-stdin-in$' "$TAP_HOME/payloads"/*.md | head -1)"
[ -n "$STDIN_REPLY_CANON" ] || { echo "body-file: stdin reply canonical missing" >&2; exit 1; }
assert_body_matches "$STDIN_REPLY_CANON" "$STDIN_BODY" "stdin reply"
[ ! -e "$BACKTICK_PROBE" ] || { echo "body-file: stdin reply evaluated backtick form" >&2; exit 1; }
[ ! -e "$DOLLAR_PROBE" ] || { echo "body-file: stdin reply evaluated dollar-paren form" >&2; exit 1; }
echo "body-file: reply forwards stdin to the same literal-body contract: ok"

mkdir "$TAP_HOME/body-dir"
set +e
"$TAP" send claude -f "$TAP_HOME/body-dir" --from codex --pane fake-pane --json \
  >"$TAP_HOME/directory.json" 2>"$TAP_HOME/directory.err"
rc=$?
set -e
[ "$rc" -eq 1 ] || { echo "body-file: directory should exit 1, got $rc" >&2; exit 1; }
assert_json_error "$TAP_HOME/directory.json" usage_error "directory body file"

printf 'unreadable\n' > "$TAP_HOME/unreadable.md"
chmod 000 "$TAP_HOME/unreadable.md"
set +e
"$TAP" send claude -f "$TAP_HOME/unreadable.md" --from codex --pane fake-pane --json \
  >"$TAP_HOME/unreadable.json" 2>"$TAP_HOME/unreadable.err"
rc=$?
set -e
chmod 600 "$TAP_HOME/unreadable.md"
[ "$rc" -eq 1 ] || { echo "body-file: unreadable file should exit 1, got $rc" >&2; exit 1; }
assert_json_error "$TAP_HOME/unreadable.json" usage_error "unreadable body file"
echo "body-file: invalid body paths use the documented error classes: ok"

set +e
"$TAP" send claude --json -m safe shattered argv --from codex --pane fake-pane \
  >"$TAP_HOME/shattered.json" 2>"$TAP_HOME/shattered.err"
rc=$?
set -e
[ "$rc" -eq 1 ] || { echo "body-file: shattered argv should exit 1, got $rc" >&2; exit 1; }
assert_json_error "$TAP_HOME/shattered.json" usage_error "shattered argv"
echo "body-file: unexpected positionals refuse instead of becoming a second body source: ok"

cat > "$TAP_HOME/payloads/body-file-missing-in.md" <<EOF
---
id: body-file-missing-in
from: claude
to: codex
kind: discuss
reply: expected
path: $TAP_HOME/payloads/body-file-missing-in.md
---
inbound
EOF
set +e
TAP_JSON=1 "$TAP" reply body-file-missing-in --body-file "$TAP_HOME/missing.md" --by codex \
  >"$TAP_HOME/reply-missing.out" 2>"$TAP_HOME/reply-missing.err"
rc=$?
set -e
[ "$rc" -eq 1 ] || { echo "body-file: missing reply body should exit 1, got $rc" >&2; exit 1; }
[ ! -e "$TAP_HOME/receipts/body-file-missing-in.done" ] \
  || { echo "body-file: failed body-file reply consumed the inbound obligation" >&2; exit 1; }
echo "body-file: failed reply read leaves the inbound unsettled: ok"

set +e
"$TAP" send missing-seat -f "$BODY" --from codex --json \
  >"$TAP_HOME/late-refusal.json" 2>"$TAP_HOME/late-refusal.err"
rc=$?
set -e
[ "$rc" -eq 1 ] || { echo "body-file: missing recipient should exit 1, got $rc" >&2; exit 1; }
if ls "$TAP_HOME"/tmp/body-file.* >/dev/null 2>&1; then
  echo "body-file: temporary source leaked after a later refusal" >&2
  exit 1
fi
echo "body-file: existing cleanup owner removes the source after later refusal: ok"

"$TAP" help send > "$TAP_HOME/help-send"
"$TAP" help reply > "$TAP_HOME/help-reply"
for help_file in "$TAP_HOME/help-send" "$TAP_HOME/help-reply"; do
  grep -qF -- '-f, --body-file <path>' "$help_file" \
    || { echo "body-file: runtime help omits -f, --body-file" >&2; cat "$help_file" >&2; exit 1; }
  grep -qiE 'write the (body|answer) to a file first|literal (body|answer) file' "$help_file" \
    || { echo "body-file: runtime help does not identify body-only input" >&2; cat "$help_file" >&2; exit 1; }
  grep -qiE 'complete payload( including frontmatter|, frontmatter included| with frontmatter)' "$help_file" \
    || { echo "body-file: runtime help does not identify positional full-payload input" >&2; cat "$help_file" >&2; exit 1; }
done
echo "body-file: runtime help distinguishes body-only and complete-payload files: ok"

echo "body-file: ok"
