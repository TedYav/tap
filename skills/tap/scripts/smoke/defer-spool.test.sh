#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# defer-spool.test.sh — U13: retryable send defers park canonical payloads in spool/.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"
. "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"

export TAP_SPOOL_DISABLE_DELIVERER=1
export TAP_TUI_SETTLE_SCALE=0.1

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
LIB="$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
WORK="$(mktemp -d)"
FIXTURE_ROOT="$WORK/testteam"
TAP_HOME="$FIXTURE_ROOT/.tap/bus"
FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "${WORK:?}" "${FAKE_BIN:?}"' EXIT
export TAP_HOME

cat > "$FAKE_BIN/tmux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"
mkdir -p "$state"
cmd="${1:-}"; shift || true
case "$cmd" in
  # CONTRACT §Session-name authority: row identity is proven from this exact
  # current-generation session snapshot before any pane effect.
  list-sessions) printf 'sess\t900:100\n' ;;
  list-panes) printf 'sess\tfake-pane\t%%1001\t%s\t2147483646\t900:100\t0\n' "${FAKE_TMUX_CMD:-codex}" ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) target="${2:-}"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    case "$fmt" in
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%%1001\tsess\t2147483646\t%s\t0\n' "${FAKE_TMUX_CMD:-codex}" ;;
      *pane_id*session_name*start_time*) printf '%%1001\tsess\t900:100\n' ;;
      *pane_id*session_name*) printf '%%1001\tsess\n' ;;
      *pid*start_time*) printf '900:100\n' ;;
      *socket_path*) printf '/fake/socket\n' ;;
      *pane_id*)              echo "%1001" ;;
      # Dead pid — must not collide with a live Cursor/agent helper (4242 did on
      # an operator machine: ps-walk reclassified unfamiliar-agent → cursor → exit 0).
      *pane_pid*)             echo "${FAKE_PANE_PID:-2147483646}" ;;
      *pane_in_mode*)         [ "${FAKE_COPY_STUCK:-0}" = "1" ] && echo "1" || echo "0" ;;
      *pane_current_command*) echo "${FAKE_TMUX_CMD:-codex}" ;;
      *)                      echo "" ;;
    esac ;;
  capture-pane)
    [ -z "${FAKE_TMUX_CAPTURE:-}" ] || { cat "$FAKE_TMUX_CAPTURE"; exit 0; }
    [ "${FAKE_NO_PROMPT:-0}" = "1" ] && { printf 'model is still working\n'; exit 0; }
    if [ -f "$state/input" ]; then printf '› %s\n' "$(cat "$state/input")"; else printf '› \n'; fi ;;
  send-keys)
    printf '%s\n' "$*" >> "$state/send-keys.log"
    if [ "${1:-}" = "-t" ]; then shift 2; fi
    if [ "${1:-}" = "-X" ] && [ "${2:-}" = "cancel" ]; then
      [ "${FAKE_COPY_STUCK:-0}" = "1" ] && exit 1
      exit 0
    fi
    if [ "${1:-}" = "-l" ]; then
      shift; [ "${1:-}" = "--" ] && shift
      printf '%s' "${1:-}" > "$state/input"
      exit 0
    fi
    if [ "${1:-}" = "Enter" ]; then
      if [ "${FAKE_TMUX_STUCK_SUBMIT:-0}" = "1" ]; then
        exit 0
      fi
      if [ -n "${FAKE_TMUX_STUCK_ID:-}" ] && grep -qF "id=${FAKE_TMUX_STUCK_ID}" "$state/input" 2>/dev/null; then
        exit 0
      fi
      rm -f "$state/input"
      exit 0
    fi ;;
esac
EOF
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH" FAKE_TMUX_STATE="$TAP_HOME/fake-tmux" TMUX="/fake/socket"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"
cat > "$TAP_HOME/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"testteam"},"seats":{"codex":{"pane":"sender-pane","pane_id":"%1002","session":"sess","server_epoch":"srv:900:100","harness":"codex","status":"active"},"peer":{"pane":"fake-pane","pane_id":"%1001","session":"sess","server_epoch":"srv:900:100","harness":"codex","status":"active"},"opencode-peer":{"pane":"fake-pane","pane_id":"%1001","session":"sess","server_epoch":"srv:900:100","harness":"opencode","status":"active"}}}
JSON

mkdir -p "$FIXTURE_ROOT"
git -C "$FIXTURE_ROOT" init -q
cd "$FIXTURE_ROOT"

assert_meta() { # <id> <target> <reason>
  python3 -B - "$TAP_HOME/spool/$1.meta.json" "$1" "$2" "$3" <<'PY'
import json, sys
path, ident, target, reason = sys.argv[1:5]
d = json.load(open(path))
assert d["id"] == ident, d
assert d["target"] == target, d
assert d["reason"] == reason, d
assert d["attempts"] == 0, d
assert d["team"], d
assert d["first_spooled"], d
PY
}

assert_no_payloads_left() {
  count="$(find "$TAP_HOME/payloads" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ')"
  [ "$count" = "0" ] || { echo "defer-spool: canonical payload leaked in payloads/" >&2; find "$TAP_HOME/payloads" -maxdepth 1 -name '*.md' >&2; exit 1; }
}

# (1) submit-verify no-prompt defer spools the canonical payload and names it.
# The default view is intentionally operator prose: the durable status/reason
# fields belong to PC14 JSON, while the user gets one receipt plus one warning.
rc=0
FAKE_NO_PROMPT=1 "$TAP" send peer -m "default busy body" --from codex --id ds-default --ask --pane fake-pane \
  >"$TAP_HOME/default.out" 2>"$TAP_HOME/default.err" || rc="$?"
[ "$rc" = "0" ] || { echo "defer-spool: (1) default no-prompt should be durably accepted (exit 0), got $rc" >&2; cat "$TAP_HOME/default.out" "$TAP_HOME/default.err" >&2; exit 1; }
python3 -B - "$TAP_HOME/default.out" <<'PYRECEIPT'
import pathlib, sys
lines = pathlib.Path(sys.argv[1]).read_text().splitlines()
assert lines[0] == 'tap send: queued ds-default', lines
assert len(lines) == 2 and 'busy/no-input-prompt' in lines[1] and 'next probe:' in lines[1], lines
PYRECEIPT
[ ! -s "$TAP_HOME/default.err" ] \
  || { echo "defer-spool: (1) default defer should not claim an unarmed watcher blocks delivery" >&2; cat "$TAP_HOME/default.err" >&2; exit 1; }
assert_meta ds-default peer no-input-prompt

# JSON remains the PC14 contract for spool status and reason.
rc=0
FAKE_NO_PROMPT=1 "$TAP" send peer -m "busy body" --from codex --id ds-no-prompt --ask --pane fake-pane --json \
  >"$TAP_HOME/no-prompt.out" 2>/dev/null || rc="$?"
[ "$rc" = "0" ] || { echo "defer-spool: (1) no-prompt should be durably accepted (exit 0), got $rc" >&2; cat "$TAP_HOME/no-prompt.out" >&2; exit 1; }
[ -f "$TAP_HOME/spool/ds-no-prompt.md" ] || { echo "defer-spool: (1) spool payload missing" >&2; exit 1; }
[ -f "$TAP_HOME/spool/ds-no-prompt.meta.json" ] || { echo "defer-spool: (1) spool meta missing" >&2; exit 1; }
grep -qF "busy body" "$TAP_HOME/spool/ds-no-prompt.md" || { echo "defer-spool: (1) spooled payload lost body" >&2; cat "$TAP_HOME/spool/ds-no-prompt.md" >&2; exit 1; }
# Spool receipt (was: 'tap send: spooled id=...' prose on stdout), no-watcher
# signal (was: WARNING prose on stdout), and defer reason (was: 'reason=' on
# stderr) all now ride the --json stdout object.
python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
assert d["status"]=="queued" and d["delivery"]=="spool" and d["id"]=="ds-no-prompt", d
assert d["from"]=="codex" and d["to"]=="peer", d
assert d["pane"]=="fake-pane" and d["kind"]=="discuss", d
assert "watcher" not in d, d
assert d["reason"]=="no-input-prompt", d
' "$TAP_HOME/no-prompt.out" || { echo "defer-spool: (1) spool receipt/watcher/reason wrong" >&2; cat "$TAP_HOME/no-prompt.out" >&2; exit 1; }
assert_meta ds-no-prompt peer no-input-prompt
assert_no_payloads_left

# ── tap-52ys: 7 of 11 arms removed (ratified 2026-08-14) ────────────────────
# The spool is where an undeliverable send waits, so four arms stay: a
# no-prompt defer writes the canonical payload plus metadata, an inline body
# survives it, a duplicate id is refused, a denylisted terminal defer never
# spools at all, and poll-mode bypasses the spool entirely.
#
# delivery-polite (123.4s, deleted — it alone exceeded the whole 120s gate
# target) folded its two non-timing arms here rather than minting a new file:
# claim exclusivity and exactly-once inject. See the note at those arms.
#
# Accepted gap, named: stuck copy-mode defer, unsupported-harness terminal
# refusal, spool_list orphan surfacing, the detached redelivery paths, and the
# empty-registry team fallback.

echo "defer-spool: (1) no-prompt defer spools canonical payload + metadata: ok"

# (1b) OpenCode startup has no input band. That absence is a pre-effect defer,
# not a healthy empty band: the public sender must return a durable queued
# receipt with a named reason, leaving placement evidence but no success claim.
: > "$FAKE_TMUX_STATE/send-keys.log"
rc=0
FAKE_TMUX_CMD=opencode \
FAKE_TMUX_CAPTURE="$ROOT/skills/tap/scripts/smoke/fixtures/opencode-splash/constructed-splash.txt" \
  "$TAP" send opencode-peer -m "startup body" --from codex --id ds-opencode-booting --ask --json \
  >"$TAP_HOME/opencode-booting.out" 2>"$TAP_HOME/opencode-booting.err" || rc="$?"
[ "$rc" = 0 ] || {
  echo "defer-spool: (1b) OpenCode startup should be durably queued, got rc=$rc" >&2
  cat "$TAP_HOME/opencode-booting.out" "$TAP_HOME/opencode-booting.err" >&2
  exit 1
}
python3 -B - "$TAP_HOME/opencode-booting.out" <<'PY' || {
import json, sys
d = json.load(open(sys.argv[1]))
assert d["status"] == "queued" and d["delivery"] == "spool", d
assert d["id"] == "ds-opencode-booting" and d["reason"] == "booting", d
PY
  echo "defer-spool: (1b) queued receipt did not name reason=booting" >&2
  cat "$TAP_HOME/opencode-booting.out" >&2
  exit 1
}
assert_meta ds-opencode-booting opencode-peer booting
[ -f "$TAP_HOME/receipts/ds-opencode-booting.placed" ] \
  || { echo "defer-spool: (1b) queued startup send left no .placed evidence" >&2; exit 1; }
[ ! -f "$TAP_HOME/receipts/ds-opencode-booting.sent" ] \
  || { echo "defer-spool: (1b) startup defer wrote a .sent success claim" >&2; exit 1; }
[ ! -s "$FAKE_TMUX_STATE/send-keys.log" ] \
  || { echo "defer-spool: (1b) startup defer touched the pane" >&2; cat "$FAKE_TMUX_STATE/send-keys.log" >&2; exit 1; }
ready="$(FAKE_TMUX_CMD=opencode \
  FAKE_TMUX_CAPTURE="$ROOT/skills/tap/scripts/smoke/fixtures/opencode-splash/constructed-splash.txt" \
  bash -c '. "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-readiness-fixture.sh"; spool_pane_ready_fixture "$2" "$3" "$4" "$5" "$6"' \
    _ "$LIB" fake-pane %1001 opencode-peer testteam "$TAP_HOME/registry.json")"
[ "$ready" = busy:booting ] \
  || { echo "defer-spool: (1b) drain readiness classified startup '$ready', not busy:booting" >&2; exit 1; }
echo "defer-spool: (1b) OpenCode startup queues pre-effect with reason=booting: ok"

# (2) inline -m survives temp cleanup because the spool holds the full canonical body.
[ ! -e "$TAP_HOME/tmp/inline-$$.md" ] || { echo "defer-spool: (2) inline temp leaked" >&2; exit 1; }
grep -qF "busy body" "$TAP_HOME/spool/ds-no-prompt.md" || { echo "defer-spool: (2) inline body not durable in spool" >&2; exit 1; }
echo "defer-spool: (2) inline -m body survives in the spool: ok"


# (3) same-id re-send while spooled must fail instead of double-delivering.
# Born live, an ordinary send places under the recipient lock, whose wrapper
# reports the spool refusal as `locked place failed` (class error, the
# incumbent's live bytes); only a manual relay keeps spooled_id.
rc=0
"$TAP" send peer -m "second body" --from codex --id ds-no-prompt --ask --pane fake-pane --json \
  >"$TAP_HOME/duplicate.out" 2>/dev/null || rc="$?"
[ "$rc" != "0" ] || { echo "defer-spool: (3) duplicate spooled id unexpectedly delivered" >&2; cat "$TAP_HOME/duplicate.out" >&2; exit 1; }
python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
assert d["ok"] is False and d["error_class"]=="error", d
assert "locked place failed for \x27peer\x27" in d["detail"] and "already has a spool entry" in d["detail"], d
assert sys.argv[2] in d["detail"], d
' "$TAP_HOME/duplicate.out" "$TAP_HOME/spool/ds-no-prompt.md" || { echo "defer-spool: (3) duplicate spooled id should be structured + name the spool entry" >&2; cat "$TAP_HOME/duplicate.out" >&2; exit 1; }
grep -qF "busy body" "$TAP_HOME/spool/ds-no-prompt.md" || { echo "defer-spool: (3) duplicate send mutated existing spool entry" >&2; exit 1; }
assert_no_payloads_left
echo "defer-spool: (3) duplicate id already in spool is refused: ok"


# (5) terminal denylist refusals exit 1, create no artifacts, and name their class.
rc=0
FAKE_TMUX_CMD=zsh "$TAP" send peer -m "shell body" --from codex --id ds-deny --ask --pane fake-pane --json \
  >"$TAP_HOME/deny.out" 2>/dev/null || rc="$?"
[ "$rc" = "1" ] || { echo "defer-spool: (5) denylist should exit 1, got $rc" >&2; cat "$TAP_HOME/deny.out" >&2; exit 1; }
[ ! -e "$TAP_HOME/spool/ds-deny.md" ] || { echo "defer-spool: (5) denylist must not spool" >&2; exit 1; }
[ ! -e "$TAP_HOME/payloads/ds-deny.md" ] || { echo "defer-spool: (5) denylist must not canonicalize" >&2; exit 1; }
python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
assert d["ok"] is False and d["error_class"]=="unsafe_target", d
# The recipient is a registered seat whose pane runs a shell: the action is the
# step that repairs it, not an internal token.
assert d["action"]=="run tap in peer from inside an agent, or start one with tap launch <harness> <name>", d
assert "reason=denylist" in d["detail"], d
' "$TAP_HOME/deny.out" || { echo "defer-spool: (5) terminal refusal should name unsafe_target, the denylist reason and the seat repair step" >&2; cat "$TAP_HOME/deny.out" >&2; exit 1; }
assert_no_payloads_left
echo "defer-spool: (5) denylist terminal defer never spools: ok"


# (6) poll-mode target never enters pane defer/spool machinery.
# Registration needs an enrolled world: root the fixture and stamp instances.
python3 -B - "$TAP_HOME/registry.json" "$FIXTURE_ROOT" <<'PY'
import json, os, sys
path, root = sys.argv[1:]
doc = json.load(open(path))
doc["team"]["worktree_root"] = os.path.realpath(root)
for handle, row in doc["seats"].items():
    row.setdefault("instance", handle + "|fixture")
with open(path, "w") as output:
    json.dump(doc, output)
PY
tap_smoke_enroll_current "$FIXTURE_ROOT" "$TAP_HOME"
bash "$ROOT/bin/tap" in hermes-gw --delivery poll >/dev/null
"$TAP" send hermes-gw -m "poll body" --from codex --id ds-poll --ask >"$TAP_HOME/poll.out" 2>&1
[ -f "$TAP_HOME/payloads/ds-poll.md" ] || { echo "defer-spool: (6) poll delivery should leave canonical payload" >&2; exit 1; }
[ ! -e "$TAP_HOME/spool/ds-poll.md" ] || { echo "defer-spool: (6) poll target must not spool" >&2; exit 1; }
[ "$(cat "$TAP_HOME/poll.out")" = "tap send: queued ds-poll" ] \
  || { echo "defer-spool: (6) poll receipt missing" >&2; cat "$TAP_HOME/poll.out" >&2; exit 1; }
rm -f "$TAP_HOME/payloads/ds-poll.md"
echo "defer-spool: (6) poll-mode delivery bypasses spool: ok"

echo "defer-spool: ok"
