#!/usr/bin/env bash
# reply-cross-worktree.test.sh — U4 (R6): `tap reply <foreign-path>` answers a
# cross-worktree sender AND settles the inbound on the SENDER's bus (sender-bus-owned),
# never on the recipient's bus. The reply target is derived from the envelope's
# from_team/from with no done-only flags to recall.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh

# tap-7r3fn.20: this fixture is about cross-worktree REPLY routing and delivers
# repeatedly to one seat; under ruling 83 a reply is eligible `now` traffic, so
# every delivery after the first would park instead of reaching the routing.
# A window of zero is the seam that turns it off (ruling 24 keeps this variable
# overriding the short window) without the fixture knowing where the clock lives.
export TAP_AUTOSETTLE_HOLD_SECONDS=0

. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
export TAP_INDEX_HOME="$WORK/index"   # never touch real ~/.tap (team-qualified sends read the index)

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"; mkdir -p "$state"
cmd="${1:-}"; shift || true
case "$cmd" in
  # CONTRACT §Session-name authority: reply delivery uses a live exact-session,
  # pane, generation, and harness record, never a stored pane alone.
  list-sessions)
    printf 'MyTeam/codex\t123:456\nSenderTeam/claude\t123:456\n' ;;
  list-panes)
    target=""; while [ "$#" -gt 0 ]; do case "$1" in -t) target="${2#=}"; shift 2 ;; *) shift ;; esac; done
    case "$target" in
      MyTeam/codex) printf 'MyTeam/codex\tcodex-pane\t%%502\tcodex\t4242\t123:456\t0\n' ;;
      SenderTeam/claude) printf 'SenderTeam/claude\tclaude-pane\t%%501\tcodex\t4242\t123:456\t0\n' ;;
    esac ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) target="${2:-}"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    case "$fmt" in
      '#{pid}:#{start_time}') echo "123:456" ;;
      *pane_id*session_name*pane_pid*pane_current_command*)
        case "$target" in
          SenderTeam/claude|claude-pane|%501) printf '%%501\tSenderTeam/claude\t4242\tcodex\t0\n' ;;
          MyTeam/codex|codex-pane|%502) printf '%%502\tMyTeam/codex\t4242\tcodex\t0\n' ;;
          *) printf '\t\t\t\t\n' ;;
        esac ;;
      *pane_id*)              case "$target" in claude-pane|%501) echo '%501' ;; codex-pane|%502) echo '%502' ;; *) echo '%599' ;; esac ;;
      *pane_pid*)             echo "4242" ;;
      *pane_in_mode*)         echo "0" ;;
      *pane_current_command*) echo "codex" ;;
      *) echo "" ;;
    esac ;;
  capture-pane)
    if [ -f "$state/input" ]; then printf '› %s\n' "$(cat "$state/input")"; else printf '› \n'; fi ;;
  send-keys)
    if [ "${1:-}" = "-t" ]; then shift 2; fi
    if [ "${1:-}" = "-l" ]; then shift; [ "${1:-}" = "--" ] && shift
      printf '%s' "${1:-}" > "$state/input"; exit 0; fi
    if [ "${1:-}" = "Enter" ]; then rm -f "$state/input"; exit 0; fi ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH"
export FAKE_TMUX_STATE="$WORK/fake-tmux"

MYTEAM="$WORK/MyTeam"
git init -q "$MYTEAM"
git -C "$MYTEAM" config user.email tap@example.invalid
git -C "$MYTEAM" config user.name "TAP Smoke"
touch "$MYTEAM/README.md"; git -C "$MYTEAM" add README.md; git -C "$MYTEAM" commit -q -m init
git -C "$MYTEAM" worktree add -q "$WORK/SenderTeam" -b sender-team
SENDER="$WORK/SenderTeam"

mkdir -p "$MYTEAM/.tap/bus/payloads" "$MYTEAM/.tap/bus/receipts" "$SENDER/.tap/bus/payloads" "$SENDER/.tap/bus/receipts"
cat > "$MYTEAM/.tap/bus/registry.json" <<'JSON'
{"schema": "0.20",  "team": { "name": "MyTeam" },
  "seats": { "codex": { "session": "MyTeam/codex", "pane": "codex-pane", "pane_id": "%502", "server_epoch": "srv:123:456", "harness": "codex", "status": "active" } } }
JSON
cat > "$SENDER/.tap/bus/registry.json" <<'JSON'
{"schema": "0.20",  "team": { "name": "SenderTeam" },
  "seats": { "claude": { "session": "SenderTeam/claude", "pane": "claude-pane", "pane_id": "%501", "server_epoch": "srv:123:456", "harness": "codex", "status": "active" } } }
JSON

# The inbound lives on the SENDER's bus (sender-bus-owned), from claude@SenderTeam.
INBOUND="$SENDER/.tap/bus/payloads/cw-in.md"
cat > "$INBOUND" <<EOF
---
id: cw-in
from: claude
from_team: SenderTeam
to: codex
to_team: MyTeam
kind: discuss
cross_worktree: true
reply: expected
path: $INBOUND
---
please reply cross-worktree
EOF

. "$ROOT/skills/tap/scripts/smoke/helpers.sh"
tap_smoke_enroll_current "$MYTEAM" "$MYTEAM/.tap/bus" MyTeam

# A receiver following same-team muscle memory with a bare id: the SenderTeam bus is NOT
# enrolled in this sandbox index, so tap-akt4's by-id scan finds nothing on any enrolled
# bus and the bare id misses everywhere — the refusal then names the concrete cross-team
# recovery, the absolute path the sentinel carries, via --payload.
bare_rc=0
( cd "$MYTEAM" && env -u TAP_HOME "$TAP" reply cw-in -m "bare id cannot find foreign canonical" --by codex ) \
  >"$WORK/bare-reply.out" 2>&1 || bare_rc=$?
[ "$bare_rc" -eq 1 ] || { echo "reply-xwt: bare foreign id should fail, got $bare_rc" >&2; cat "$WORK/bare-reply.out" >&2; exit 1; }
grep -q -- '--payload <abs-path-from-sentinel>' "$WORK/bare-reply.out" \
  || { echo "reply-xwt: bare-id refusal omitted path-form recovery" >&2; cat "$WORK/bare-reply.out" >&2; exit 1; }
grep -q 'any enrolled team bus' "$WORK/bare-reply.out" \
  || { echo "reply-xwt: bare-id refusal should say the id missed the enrolled buses too (tap-akt4)" >&2; cat "$WORK/bare-reply.out" >&2; exit 1; }
echo "reply-xwt: bare-id refusal names the sentinel path form + the enrolled-bus miss: ok"

# I (codex) run reply from MyTeam. reply reads from_team/from → SenderTeam/claude,
# sends the answer team-qualified, and settles the inbound on the SENDER's bus.
tap_smoke_enroll_current "$SENDER" "$SENDER/.tap/bus" SenderTeam
( cd "$MYTEAM" && env -u TAP_HOME "$TAP" reply "$INBOUND" -m "here is my answer" --by codex ) \
  >"$WORK/reply.out" 2>&1 || { echo "reply-xwt: reply failed" >&2; cat "$WORK/reply.out" >&2; exit 1; }

# .done must land on the SENDER's bus, never the recipient's.
[ -f "$SENDER/.tap/bus/receipts/cw-in.done" ] || { echo "reply-xwt: inbound .done not written to sender bus" >&2; cat "$WORK/reply.out" >&2; exit 1; }
grep -q '"by":"codex"' "$SENDER/.tap/bus/receipts/cw-in.done" || { echo "reply-xwt: .done actor wrong" >&2; cat "$SENDER/.tap/bus/receipts/cw-in.done" >&2; exit 1; }
[ ! -f "$MYTEAM/.tap/bus/receipts/cw-in.done" ] || { echo "reply-xwt: .done wrongly written to recipient bus" >&2; exit 1; }
echo "reply-xwt: reply settles the inbound on the sender bus: ok"

# The outbound answer is a cross-worktree send on MY bus, back to SenderTeam.
ob="$(grep -rl 'here is my answer' "$MYTEAM/.tap/bus/payloads"/*.md | head -1)"
[ -n "$ob" ] || { echo "reply-xwt: outbound answer not on my bus" >&2; ls "$MYTEAM/.tap/bus/payloads" >&2; exit 1; }
grep -q '^from: codex$' "$ob" || { echo "reply-xwt: outbound from should be codex" >&2; cat "$ob" >&2; exit 1; }
grep -q '^to: claude$' "$ob" || { echo "reply-xwt: outbound to should be claude" >&2; cat "$ob" >&2; exit 1; }
grep -q '^cross_worktree: true$' "$ob" || { echo "reply-xwt: outbound should be cross-worktree" >&2; cat "$ob" >&2; exit 1; }
grep -q '^reply: settle-only$' "$ob" || { echo "reply-xwt: outbound should default to settle-only" >&2; cat "$ob" >&2; exit 1; }
grep -q '^in_reply_to: cw-in$' "$ob" || { echo "reply-xwt: outbound correlation missing" >&2; cat "$ob" >&2; exit 1; }
python3 - "$SENDER/.tap/bus/receipts/cw-in.done" "$ob" <<'PY' \
  || { echo "reply-xwt: reply audit fields wrong" >&2; cat "$SENDER/.tap/bus/receipts/cw-in.done" >&2; exit 1; }
from pathlib import Path
import hashlib, json, sys
r = json.load(open(sys.argv[1])); p = Path(sys.argv[2])
lines = p.read_bytes().splitlines(keepends=True)
end = next(i for i, line in enumerate(lines[1:], 1) if line.rstrip(b"\r\n") == b"---")
body = b"".join(lines[end + 1:])
text = body.decode("utf-8", "replace")
preview = " ".join("".join(c if c.isprintable() or c.isspace() else " " for c in text).split())[:160]
assert r["via"] == "reply" and r["reply_id"] == p.stem, r
assert r["reply_sha256"] == hashlib.sha256(body).hexdigest(), r
assert r["reply_preview"] == preview, r
PY
echo "reply-xwt: outbound is a cross-worktree settle-only answer on my bus: ok"

# Progress keeps the cross-worktree inbound open on the sender bus and never writes
# a mirror-bus .done receipt.
PROGRESS="$SENDER/.tap/bus/payloads/cw-progress.md"
cat > "$PROGRESS" <<EOF
---
id: cw-progress
from: claude
from_team: SenderTeam
to: codex
to_team: MyTeam
kind: discuss
cross_worktree: true
reply: expected
path: $PROGRESS
---
please report progress cross-worktree
EOF
( cd "$MYTEAM" && env -u TAP_HOME "$TAP" reply "$PROGRESS" --progress -m "still working" --by codex ) \
  >"$WORK/progress.out" 2>&1 || { echo "reply-xwt: progress failed" >&2; cat "$WORK/progress.out" >&2; exit 1; }
[ ! -f "$SENDER/.tap/bus/receipts/cw-progress.done" ] \
  || { echo "reply-xwt: progress wrote .done on sender bus" >&2; exit 1; }
[ ! -f "$MYTEAM/.tap/bus/receipts/cw-progress.done" ] \
  || { echo "reply-xwt: progress wrote .done beside mirrored payload" >&2; exit 1; }
progress_outbound="$(grep -rl 'still working' "$MYTEAM/.tap/bus/payloads"/*.md | head -1)"
[ -n "$progress_outbound" ] || { echo "reply-xwt: progress outbound missing" >&2; exit 1; }
grep -q '^reply: settle-only$' "$progress_outbound" \
  || { echo "reply-xwt: progress outbound must be settle-only" >&2; cat "$progress_outbound" >&2; exit 1; }
grep -q '^in_reply_to: cw-progress$' "$progress_outbound" \
  || { echo "reply-xwt: progress outbound correlation missing" >&2; cat "$progress_outbound" >&2; exit 1; }
set +e; ( cd "$SENDER" && env -u TAP_HOME "$TAP" outstanding claude --json ) >"$WORK/progress-outstanding.json" 2>/dev/null; set -e
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert any(i["id"]=="cw-progress" for i in d["outstanding"]), d' "$WORK/progress-outstanding.json" \
  || { echo "reply-xwt: progress did not retain sender-bus obligation" >&2; cat "$WORK/progress-outstanding.json" >&2; exit 1; }
echo "reply-xwt: progress retains sender-bus obligation and writes no mirrored .done: ok"

echo "reply-cross-worktree: ok"
