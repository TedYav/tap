#!/usr/bin/env bash
# D5: source-read — :213 grep-reads sentinel.ts SENTINEL_VERSION to pin the wire version stamp; assertions are on emitted sentinel text
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh

# tap-7r3fn.20: this fixture is about courier INJECTION and delivers repeatedly to
# one seat, so every delivery after the first would park in that seat's window
# instead of reaching the pane receipt under test.
# A window of zero is the seam that turns it off (ruling 24 keeps this variable
# overriding the short window) without the fixture knowing where the clock lives.
export TAP_AUTOSETTLE_HOLD_SECONDS=0

. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

# Mock-tmux smoke: the courier's real-TUI settle sleeps verify nothing against
# a synchronous mock — scale them down (smoke-speed PR2; default 1 in production).
export TAP_TUI_SETTLE_SCALE=0.1

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
TAP_HOME="$(mktemp -d)"
FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$TAP_HOME" "$FAKE_BIN"' EXIT
export TAP_HOME
# Parallel fixtures reuse fake pane IDs; only this fixture's children share locks.
export TAP_LOCK_DIR="$TAP_HOME/locks"
export TAP_SPOOL_DISABLE_DELIVERER=1

cat > "$FAKE_BIN/tmux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"
mkdir -p "$state"
cmd="$1"
shift

case "$cmd" in
  # CONTRACT §Session-name authority: injection tests model the full live
  # exact-session/designated-pane/generation/harness conjunction.
  list-sessions)
    printf 'testteam/codex\t123:456\ntestteam/claude\t123:456\n' ;;
  list-panes)
    target=""; while [ "$#" -gt 0 ]; do case "$1" in -t) target="${2#=}"; shift 2 ;; *) shift ;; esac; done
    case "$target" in
      testteam/codex) printf 'testteam/codex\tself:0.0\t%%302\tcodex\t%s\t123:456\t0\n' "${FAKE_TMUX_PANE_PID:-4242}" ;;
      testteam/claude) printf 'testteam/claude\tfake-pane\t%%301\t%s\t%s\t123:456\t0\n' "${FAKE_TMUX_CMD:-codex}" "${FAKE_TMUX_PANE_PID:-4242}" ;;
    esac ;;
  display-message)
    fmt="${@: -1}"
    [ "${FAKE_TMUX_GONE:-0}" = 1 ] && exit 1
    t=""; p=""; for a in "$@"; do [ "$p" = -t ] && t="${a#=}"; p="$a"; done
    case "$fmt" in
      '#{pid}:#{start_time}') echo "123:456" ;;
      *pane_id*session_name*pane_pid*pane_current_command*)
        case "$t" in
          fake-pane|%301|testteam/claude) printf '%%301\ttestteam/claude\t%s\t%s\t0\n' "${FAKE_TMUX_PANE_PID:-4242}" "${FAKE_TMUX_CMD:-codex}" ;;
          self:0.0|%302|testteam/codex) printf '%%302\ttestteam/codex\t%s\tcodex\n' "${FAKE_TMUX_PANE_PID:-4242}" ;;
          *) printf '\t\t\t\t\n' ;;
        esac ;;
      # The retained spool submit door observes id, session and generation.
      *pane_id*session_name*)
        case "$t" in
          fake-pane|%301|testteam/claude) printf '%%301\ttestteam/claude\t123:456\n' ;;
          self:0.0|%302|testteam/codex) printf '%%302\ttestteam/codex\t123:456\n' ;;
          *) printf '\t\t\n' ;;
        esac ;;
      *pane_id*) echo "%301" ;;
      *pane_pid*) echo "${FAKE_TMUX_PANE_PID:-4242}" ;;
      *pane_in_mode*) [ -f "$state/copy-mode" ] && echo "1" || echo "${FAKE_TMUX_IN_MODE:-0}" ;;
      *pane_current_command*) echo "${FAKE_TMUX_CMD:-codex}" ;;
      *) echo "" ;;
    esac
    ;;
  capture-pane)
    [ "${FAKE_TMUX_MIDTURN:-0}" = 1 ] && { echo "esc to interrupt"; exit 0; }
    prompt="${FAKE_TMUX_PROMPT:-›}"
    escaped=0
    for arg in "$@"; do [ "$arg" = "-e" ] && escaped=1; done
    if [ -f "$state/input" ]; then
      input_text="$(cat "$state/input")"
      if [ "${FAKE_TMUX_FLAP:-0}" = 1 ] && [ ! -f "$state/flapped" ]; then
        touch "$state/flapped"
        printf 'changed after first capture' > "$state/input"
      fi
      if [ "$escaped" = 1 ] && [ "${FAKE_TMUX_DIM_INPUT:-0}" = 1 ]; then
        printf '\033[1m%s\033[0m \033[2m%s\033[0m\n' "$prompt" "$input_text"
      elif [ "$escaped" = 1 ] && [ "${FAKE_TMUX_DIM_PROMPT:-0}" = 1 ]; then
        printf '\033[2m%s\033[0m %s\n' "$prompt" "$input_text"
      elif [ "$escaped" = 1 ] && [ "${FAKE_TMUX_TRUECOLOR_INPUT:-0}" = 1 ]; then
        printf '%s \033[38;2;1;2;3m%s\033[0m\n' "$prompt" "$input_text"
      else
        printf '%s %s\n' "$prompt" "$input_text"
      fi
    else
      printf '%s \n' "$prompt"
    fi
    ;;
  send-keys)
    if [ "${1:-}" = "-t" ]; then shift 2; fi
    if [ "${1:-}" = "-X" ] && [ "${2:-}" = "cancel" ]; then
      rm -f "$state/copy-mode"
      exit 0
    fi
    if [ "${1:-}" = "-l" ]; then
      shift                          # drop -l
      [ "${1:-}" = "--" ] && shift   # real tmux accepts the option terminator; model it
      printf '%s' "${1:-}" > "$state/input"
      printf '%s' "${1:-}" > "$state/last-sentinel"
      exit 0
    fi
    if [ "${1:-}" = "C-u" ]; then
      # kill-line: the clobber pipeline's buffer-local clear
      rm -f "$state/input"
      exit 0
    fi
    if [ "${1:-}" = "Enter" ]; then
      rm -f "$state/input"
      exit 0
    fi
    ;;
esac
EOF
chmod +x "$FAKE_BIN/tmux"

cat > "$FAKE_BIN/ps" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${FAKE_PS_HARNESS:-}" in
  claude)
    printf ' %s %s %s claude claude --dangerously-skip-permissions --name ttt-claude\n' "${FAKE_TMUX_PANE_PID:-4242}" "${FAKE_TMUX_PANE_PID:-4242}" "${FAKE_TMUX_PANE_PID:-4242}"
    exit 0 ;;
  argv-codex-note)
    printf ' 4242 4242 4242 vim vim /tmp/codex-notes\n'
    exit 0 ;;
  background-codex)
    printf ' 4242 4242 4242 zsh zsh\n'
    printf ' 5555 5555 4242 codex codex --dangerously-bypass-approvals\n'
    exit 0 ;;
  background-codex-python)
    printf ' 4242 4242 4242 python python\n'
    printf ' 5555 5555 4242 codex codex --dangerously-bypass-approvals\n'
    exit 0 ;;
esac
exit 0
EOF
chmod +x "$FAKE_BIN/ps"

export PATH="$FAKE_BIN:$PATH"
export FAKE_TMUX_STATE="$TAP_HOME/fake-tmux"

mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"
cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": { "name": "testteam" },
  "seats": {
    "codex": { "pane": "self:0.0", "pane_id": "%302", "session": "testteam/codex", "server_epoch": "srv:123:456", "harness": "codex", "status": "active" },
    "claude": { "pane": "fake-pane", "pane_id": "%301", "session": "testteam/claude", "server_epoch": "srv:123:456", "harness": "codex", "status": "active" }
  }
}
JSON

payload="$TAP_HOME/source.md"
cat > "$payload" <<'EOF'
---
id: courier-smoke
from: codex
to: claude
kind: discuss
path: tmp/tap/payloads/courier-smoke.md
---

hello
EOF

"$TAP" send claude "$payload" --from codex --kind discuss --id courier-smoke --ask --pane fake-pane >"$TAP_HOME/courier.out"
[ -f "$TAP_HOME/payloads/courier-smoke.md" ] || { echo "courier-injects: payload not canonicalized" >&2; exit 1; }
[ -f "$TAP_HOME/receipts/courier-smoke.sent" ] || { echo "courier-injects: sent receipt missing" >&2; exit 1; }
# PREFIX-anchored, deliberately not `$`-anchored. What this arm is about is that the
# courier reported a verified pane injection naming the right id and target — that is
# the invariant. The receipt line is a CONTRACT SURFACE that grows qualifiers: a later change
# appended F4 §3.2's "; submitted to pane; recipient seat-side processing unverified"
# to exactly this line, and the old `$` anchor could no longer match.
#
# Re-anchoring to the new full string would just move the breakage one release later,
# and it would make this file a second spelling of a sentence that already has one
# authority (CONTRACT §turn=unconfirmed) plus arms in `smoke/turn-unconfirmed.test.sh`
# that pin the qualifier's exact wording on every surface. Two spellings of one string
# is how the poll-legend defect in that same PR arrived. This arm asserts the part it
# owns; the qualifier is somebody else's arm.
#
# Worth knowing if you tighten this back: `regress/` NEVER blocks a merge, so the gate
# is structurally blind to a break here and will stay green while this sits red. That
# is what happened — the receipt string was updated everywhere the gate looks and
# nowhere it does not.
grep -q '^tap send: ok courier-smoke$' "$TAP_HOME/courier.out" \
  || { echo "courier-injects: pane delivery receipt must name its path" >&2; cat "$TAP_HOME/courier.out" >&2; exit 1; }
# Same-bus delivery carries path= like every other sentinel (tap-0z9l removed the
# v0.18 diet that omitted it here). Byte-exact so any drift is loud — which is why
# the expected path is resolved with pwd -P rather than interpolated from
# $TAP_HOME: the sender emits the physical path, and on macOS $TMPDIR reaches it
# through a /var -> /private/var symlink, so an unresolved expectation would fail
# on the symlink rather than on any real drift.
# v0.23 (tap-7r3fn.8): route keys, `kind=` and `reply=` left the wire, and `path=`
# survives only for a digest, the bare-recipient manual relay, or a sender team the
# index cannot resolve -- an ordinary same-team send carries none of them. The
# version is read from the constant rather than written here, so a bump reds
# contract-version-lockstep (which owns the number) instead of this file.
#
# The pwd -P resolution below is kept even though no path rides this sentinel any
# more, because the CANONICAL comparison further down still needs it: the sender
# emits the physical path and on macOS $TMPDIR reaches it through a /var ->
# /private/var symlink, so an unresolved expectation fails on the symlink rather
# than on any real drift.
_cs_ver="$(grep -o 'SENTINEL_VERSION = "[0-9.]*"' "$ROOT/runtime/bun/src/sentinel.ts" | cut -d'"' -f2)"
empty_sentinel="[[TAP v${_cs_ver} ask courier-smoke]]"
[ "$(cat "$FAKE_TMUX_STATE/last-sentinel")" = "$empty_sentinel" ] \
  || { echo "courier-injects: empty-band sentinel bytes drifted" >&2; cat "$FAKE_TMUX_STATE/last-sentinel" >&2; exit 1; }
[ ! -e "$TAP_HOME/spool/courier-smoke.md" ] || { echo "courier-injects: empty band unexpectedly entered grace spool" >&2; exit 1; }

FAKE_TMUX_PROMPT="❯" "$TAP" send claude "$payload" --from codex --kind discuss --id courier-smoke-claude --ask --pane fake-pane >"$TAP_HOME/courier-claude.out"
[ -f "$TAP_HOME/receipts/courier-smoke-claude.sent" ] || { echo "courier-injects: claude prompt receipt missing" >&2; exit 1; }

# --- Standard delivery protects pending human input with durable grace. --------
# Every undimmed input shape remains in the pane and queues a standard-policy
# spool entry; placeholder chrome is covered separately below.
queue_standard_pending() { # <id> <expected-input> [ENV=VALUE ...]
  local id="$1" expected="$2" rc=0
  shift 2
  set +e
  env "$@" "$TAP" send claude "$payload" --from codex --kind discuss --id "$id" --ask --pane fake-pane >"$TAP_HOME/$id.out" 2>&1
  rc=$?
  set -e
  [ "$rc" = 0 ] || { echo "courier-injects: $id pending input should be accepted into grace, got $rc" >&2; cat "$TAP_HOME/$id.out" >&2; exit 1; }
  [ -f "$TAP_HOME/spool/$id.md" ] || { echo "courier-injects: $id missing durable standard spool entry" >&2; exit 1; }
  [ ! -f "$TAP_HOME/receipts/$id.sent" ] || { echo "courier-injects: $id wrote .sent before grace expired" >&2; exit 1; }
  [ "$(cat "$FAKE_TMUX_STATE/input")" = "$expected" ] || { echo "courier-injects: $id clobbered pending input" >&2; exit 1; }
  python3 - "$TAP_HOME/spool/$id.meta.json" <<'PY'
import json, sys, time
p = sys.argv[1]; m = json.load(open(p)); now = int(time.time())
# Pending-input protocol part-02 gives draft recovery its own clock.
assert m.get("draft_deadline_epoch"), m
m["first_spooled_epoch"] = now - 60; m["deadline_epoch"] = now
m["draft_deadline_epoch"] = now
json.dump(m, open(p, "w"), indent=2, sort_keys=True)
PY
  # The drain's effective deadline is the pane-shared protection
  # record (draft grace / WAIT snooze), not the entry's own meta, so expire that
  # clock too; the backup and no-premature-.sent assertions stay as they were.
  # Refusable: the park must have minted a record naming this entry in its
  # pending cohort, and the shared aging helper fails when it ages none.
  grep -qF "\"id\":\"$id\"" "${TAP_INDEX_HOME:?}"/input-protection/*.json 2>/dev/null \
    || { echo "courier-injects: $id parked without a pane-shared protection record naming it" >&2; exit 1; }
  bash -c '. "$1"; tap_protection_age_all "$2"' _ "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh" "$(( $(date +%s) * 1000 - 1000 ))" \
    || { echo "courier-injects: $id protection record could not be aged" >&2; exit 1; }
  bash -c '. "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once "$2"' _ "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh" "$(date +%s)"
  [ ! -f "$TAP_HOME/spool/$id.md" ] || { echo "courier-injects: $id stayed parked past its deadline" >&2; cat "$TAP_HOME/spool/$id.meta.json" >&2; exit 1; }
  backup="$(find "$TAP_HOME/input-backups/" -maxdepth 1 -name "*$id*" -print -quit 2>/dev/null)"
  [ -n "$backup" ] && grep -qF "$expected" "$backup" || { echo "courier-injects: $id deadline delivery did not preserve the draft backup" >&2; exit 1; }
  rm -f "$TAP_HOME/spool/$id.md" "$TAP_HOME/spool/$id.meta.json" "$TAP_HOME/spool/$id.claim" "$FAKE_TMUX_STATE/input"
}

printf 'human text' > "$FAKE_TMUX_STATE/input"
queue_standard_pending courier-smoke-pending 'human text' 'FAKE_TMUX_PROMPT=❯'

long_input="$(printf '%05000d' 0 | tr '0' 'x')"
printf '%s' "$long_input" > "$FAKE_TMUX_STATE/input"
queue_standard_pending courier-smoke-overlong "$long_input" 'FAKE_TMUX_PROMPT=❯'

printf 'Write tests for @filename' > "$FAKE_TMUX_STATE/input"
FAKE_TMUX_CMD="codex-aarch64-a" FAKE_TMUX_DIM_INPUT=1 "$TAP" send claude "$payload" --from codex --kind discuss --id courier-smoke-placeholder --ask --pane fake-pane >"$TAP_HOME/courier-placeholder.out"
[ -f "$TAP_HOME/receipts/courier-smoke-placeholder.sent" ] || { echo "courier-injects: codex placeholder receipt missing" >&2; exit 1; }

printf 'Find and fix a bug in @filename' > "$FAKE_TMUX_STATE/input"
# OLD (before the session-name-authority ruling): a legacy row with
# no harness expectation learned Claude from process evidence and delivered.
# Session-name authority now keeps expectation attestation at write boundaries.
python3 -B - "$TAP_HOME/registry.json" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
data["seats"]["claude"].pop("harness", None)
json.dump(data, open(path, "w"), indent=2, sort_keys=True)
PY
set +e
FAKE_TMUX_CMD="2.1.198" FAKE_PS_HARNESS=claude FAKE_TMUX_DIM_INPUT=1 "$TAP" send claude "$payload" --from codex --kind discuss --id courier-smoke-claude-placeholder --ask --json --pane fake-pane >"$TAP_HOME/courier-claude-placeholder.out" 2>&1
claude_placeholder_rc=$?
set -e
[ "$claude_placeholder_rc" -eq 1 ] || { echo "courier-injects: unattested legacy harness did not refuse" >&2; exit 1; }
python3 -B - "$TAP_HOME/courier-claude-placeholder.out" <<'PY_ASSERT'
import json, sys
out = json.load(open(sys.argv[1]))
assert out['error_class'] == 'identity_mismatch', out
assert 'unattested' in out['detail'], out
assert 'tap register claude' in out['action'], out
PY_ASSERT
python3 -B - "$TAP_HOME/registry.json" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
data["seats"]["claude"]["harness"] = "codex"
json.dump(data, open(path, "w"), indent=2, sort_keys=True)
PY

# Undimmed placeholder-shaped text IS real input, so standard grace protects it.
printf 'Find and fix a bug in @filename' > "$FAKE_TMUX_STATE/input"
queue_standard_pending courier-smoke-plain-placeholder 'Find and fix a bug in @filename' 'FAKE_TMUX_CMD=codex-aarch64-a'

# Dim prompt chrome around real (undimmed) input remains real input → grace.
printf 'real human text' > "$FAKE_TMUX_STATE/input"
queue_standard_pending courier-smoke-dim-prompt-real-input 'real human text' 'FAKE_TMUX_DIM_PROMPT=1'

# Truecolor SGR args must not be misread as dim: real input receives grace.
printf 'truecolor human text' > "$FAKE_TMUX_STATE/input"
queue_standard_pending courier-smoke-truecolor-input 'truecolor human text' 'FAKE_TMUX_TRUECOLOR_INPUT=1'

FAKE_TMUX_CMD="vim" FAKE_PS_HARNESS=argv-codex-note "$TAP" send claude "$payload" --from codex --kind discuss --id courier-smoke-argv-path --ask --pane fake-pane >"$TAP_HOME/courier-argv-path.out" 2>&1 && {
  echo "courier-injects: argv path containing codex should fail closed" >&2
  exit 1
}
[ "$?" -eq 1 ] || { echo "courier-injects: argv path command returned wrong exit" >&2; exit 1; }
grep -q "runs 'vim'" "$TAP_HOME/courier-argv-path.out" || { echo "courier-injects: argv path did not preserve executable command" >&2; cat "$TAP_HOME/courier-argv-path.out" >&2; exit 1; }
[ ! -f "$TAP_HOME/payloads/courier-smoke-argv-path.md" ] || { echo "courier-injects: argv path left canonical payload behind" >&2; exit 1; }

FAKE_TMUX_CMD="zsh" FAKE_PS_HARNESS=background-codex "$TAP" send claude "$payload" --from codex --kind discuss --id courier-smoke-background-agent --ask --pane fake-pane >"$TAP_HOME/courier-background-agent.out" 2>&1 && {
  echo "courier-injects: shell foreground with background agent should fail closed" >&2
  exit 1
}
[ "$?" -eq 1 ] || { echo "courier-injects: background agent command returned wrong exit" >&2; exit 1; }
grep -q "runs 'zsh'" "$TAP_HOME/courier-background-agent.out" || { echo "courier-injects: background agent did not preserve foreground shell" >&2; cat "$TAP_HOME/courier-background-agent.out" >&2; exit 1; }
[ ! -f "$TAP_HOME/payloads/courier-smoke-background-agent.md" ] || { echo "courier-injects: background agent left canonical payload behind" >&2; exit 1; }

FAKE_TMUX_CMD="python" FAKE_PS_HARNESS=background-codex-python "$TAP" send claude "$payload" --from codex --kind discuss --id courier-smoke-background-agent-unsupported --ask --json --pane fake-pane >"$TAP_HOME/courier-background-agent-unsupported.out" 2>&1 && {
  echo "courier-injects: unsupported foreground with background agent should fail closed" >&2
  exit 1
}
[ "$?" -eq 1 ] || { echo "courier-injects: unsupported background agent command returned wrong exit" >&2; exit 1; }
python3 -B - "$TAP_HOME/courier-background-agent-unsupported.out" <<'PY_ASSERT'
import json, sys
out = json.load(open(sys.argv[1]))
assert out['error_class'] == 'identity_mismatch', out
assert "live command 'python'" in out['detail'], out
PY_ASSERT
[ ! -f "$TAP_HOME/payloads/courier-smoke-background-agent-unsupported.md" ] || { echo "courier-injects: unsupported background agent left canonical payload behind" >&2; exit 1; }

touch "$FAKE_TMUX_STATE/copy-mode"
"$TAP" send claude "$payload" --from codex --kind discuss --id courier-smoke-copy --ask --pane fake-pane >"$TAP_HOME/courier-copy.out"
[ -f "$TAP_HOME/receipts/courier-smoke-copy.sent" ] || { echo "courier-injects: copy-mode recovery receipt missing" >&2; exit 1; }
[ ! -f "$FAKE_TMUX_STATE/copy-mode" ] || { echo "courier-injects: copy-mode was not cancelled" >&2; exit 1; }

echo "courier-injects: ok"
