#!/usr/bin/env bash
# nudge-submit-verify.test.sh — tap nudge reuses submit-clear verification.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
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

cat > "$FAKE_BIN/tmux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"
mkdir -p "$state"
cmd="${1:-}"; shift || true
case "$cmd" in
  list-sessions)
    if [[ "$*" == *'start_time'* ]]; then printf 'fake-pane\t900:100\n'
    else printf 'fake-pane\n'
    fi ;;
  list-panes)
    shift; target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -t) target="${2#=}"; shift 2 ;; -F) fmt="$2"; shift 2 ;; *) shift ;; esac
    done
    [ "$target" = fake-pane ] || exit 1
    printf 'fake-pane\tfake-pane:0.0\t%%301\t%s\t301\t900:100\t0\n' "${FAKE_LIST_PANES_CMD:-${FAKE_TMUX_CMD:-codex}}" ;;
  display-message)
    fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    [ "${FAKE_TMUX_GONE:-0}" = "1" ] && exit 1
    case "$fmt" in
      *window_id*) printf '%%301\037@91\037%s\03729\n' "$(cat "$state/window-width" 2>/dev/null || printf 113)" ;;
      '#{pid}:#{start_time}') echo "900:100" ;;
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%%301\tfake-pane\t%s\t%s\t0\n' "${FAKE_TMUX_PROCESS_PID:?}" "${FAKE_TMUX_CMD:-codex}" ;;
      *session_name*start_time*) printf '%%301\tfake-pane\t900:100\n' ;;
      *pane_id*) echo "%301" ;;
      *pane_pid*) echo "${FAKE_TMUX_PROCESS_PID:?}" ;;
      *pane_in_mode*) [ -f "$state/copy-mode" ] && echo "1" || echo "0" ;;
      *pane_current_command*) echo "${FAKE_TMUX_CMD:-codex}" ;;
      *) echo "" ;;
    esac ;;
  resize-window)
    width=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -t|-y) shift 2 ;; -x) width="$2"; shift 2 ;; *) shift ;; esac
    done
    [ -n "$width" ] || exit 1
    printf '%s\n' "$width" > "$state/window-width"
    [ "${FAKE_OPENCODE_OVERPRINT:-0}" != 1 ] || : > "$state/opencode-repainted"
    printf 'manual\n' > "$state/window-option"
    printf 'resize:%s\n' "$width" >> "$state/events" ;;
  show-options)
    [ -f "$state/window-option" ] && cat "$state/window-option" || true ;;
  set-option)
    unset_option=0 value=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -wqu) unset_option=1; shift ;;
        -wq) shift ;;
        -t) shift 2 ;;
        window-size) shift; [ "$#" -eq 0 ] || { value="$1"; shift; } ;;
        *) shift ;;
      esac
    done
    if [ "$unset_option" = 1 ]; then
      rm -f "$state/window-option"
      printf 'option:unset\n' >> "$state/events"
    else
      [ -n "$value" ] || exit 1
      printf '%s\n' "$value" > "$state/window-option"
      printf 'option:%s\n' "$value" >> "$state/events"
    fi ;;
  capture-pane)
    if [ -n "${FAKE_CLAUDE_CAPTURE:-}" ]; then
      cat "$FAKE_CLAUDE_CAPTURE"
    elif [ -n "${FAKE_CODEX_FIXTURE:-}" ]; then
      python3 - "$FAKE_CODEX_FIXTURE" "$state/input" <<'PYCAPTURE'
import pathlib, re, sys
lines=pathlib.Path(sys.argv[1]).read_text().splitlines()
plain=lambda s: re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', s)
start=max(i for i,line in enumerate(lines) if re.match(r'^\s*›',plain(line)))
text=pathlib.Path(sys.argv[2]).read_text() if pathlib.Path(sys.argv[2]).exists() else ''
lines[start]='› '+text
print('\n'.join(lines))
PYCAPTURE
    elif [ "${FAKE_TMUX_CMD:-codex}" = "opencode" ]; then
      if [ "${FAKE_OPENCODE_OVERPRINT:-0}" = 1 ] && [ ! -f "$state/opencode-repainted" ]; then
        printf '  ┃\n'
        if [ -f "$state/input" ]; then
          printf '  ┃  %s [claude-mem-capture] Worker POST failed: The socket connection was closed unexpec\n' "$(cat "$state/input")"
        fi
        printf 'tedly. For more information, pass verbose: true\n'
        printf '  ┃  Build · GLM-5.3 · high\n  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\n'
        printf '%s\n' "${FAKE_OPENCODE_FOOTER:-ctrl+p commands}"
      elif [ "${FAKE_OPENCODE_ALL_WRAPPED:-0}" = 1 ] && [[ " $* " == *" -J "* ]]; then
        printf '  ┃  ┃  %s  ┃  Build · GLM-5.3 · high  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀  %s\n' \
          "$(cat "$state/input" 2>/dev/null || true)" "${FAKE_OPENCODE_FOOTER:-ctrl+p commands}"
      else
        printf '  ┃\n'
        if [ -f "$state/input" ]; then printf '  ┃  %s\n' "$(cat "$state/input")"; fi
        printf '  ┃  Build · GLM-5.3 · high\n  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\n'
        printf '%s\n' "${FAKE_OPENCODE_FOOTER:-ctrl+p commands}"
      fi
    elif [ "${FAKE_TMUX_CMD:-codex}" = "cursor" ]; then
      printf '%s\n' ' ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄'
      printf ' \033[48;2;119;15;15m→ %s\033[0m\n' "$(cat "$state/input" 2>/dev/null || true)"
      printf '%s\n' ' ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀' ' Cursor Grok · idle'
    elif [ "${FAKE_TMUX_CMD:-codex}" = "agy" ]; then
      rule="$(printf '─%.0s' $(seq 1 100))"
      printf '%s\n' "  Standing by." "$rule"
      if [ -f "$state/input" ]; then printf '> %s\n' "$(cat "$state/input")"
      else printf '> \n'; fi
      printf '%s\n' "$rule" "● [20:09:23] sleep 300 running" "$rule" \
        "? for shortcuts                                                          Gemini 3.6 Flash · high"
    elif [ -f "$state/input" ]; then printf '› %s\n' "$(cat "$state/input")"
    else printf '› \n'; fi ;;
  send-keys)
    if [ "${1:-}" = "-t" ]; then shift 2; fi
    if [ "${1:-}" = "-X" ] && [ "${2:-}" = "cancel" ]; then
      printf 'cancel\n' >>"$state/events"
      [ "${FAKE_TMUX_COPY_STUCK:-0}" = "1" ] || rm -f "$state/copy-mode"
      exit 0
    fi
    if [ "${1:-}" = "Enter" ]; then
      printf 'enter\n' >>"$state/events"
      if [ "${FAKE_TMUX_COLLAPSE_ON_ENTER:-0}" = "1" ]; then
        printf '[Pasted Content 1003 chars]' > "$state/input"
      elif [ "${FAKE_TMUX_STUCK_SUBMIT:-0}" != "1" ]; then
        rm -f "$state/input"
      fi
      exit 0
    fi ;;
esac
EOF
chmod +x "$FAKE_BIN/tmux"

export PATH="$FAKE_BIN:$PATH"
export FAKE_TMUX_STATE="$TAP_HOME/fake-tmux"
export FAKE_TMUX_PROCESS_PID="$$"
export TAP_SERVER_EPOCH="srv:900:100" TAP_BOOT_ID="boot:1"
mkdir -p "$FAKE_TMUX_STATE"
cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "testteam"},
  "seats": {
    "codex": {"session": "fake-pane", "pane": "fake-pane:0.0", "pane_id": "%301", "harness": "codex", "server_epoch": "srv:900:100", "boot_id": "boot:1", "status": "active"}
  }
}
JSON

# 1. Visible stuck sentinel clears and reports success.
printf '[[TAP v=0.2 from=claude to=codex id=nudge-ok kind=review path=/tmp/nudge-ok.md]]' > "$FAKE_TMUX_STATE/input"
"$TAP" nudge codex --pane fake-pane:0.0 >"$TAP_HOME/ok.out"
grep -q 're-submitted' "$TAP_HOME/ok.out" || { echo "nudge-submit: success output missing" >&2; cat "$TAP_HOME/ok.out" >&2; exit 1; }
[ ! -f "$FAKE_TMUX_STATE/input" ] || { echo "nudge-submit: sentinel did not clear" >&2; exit 1; }

# 1a. (tap-owanr) TERMINAL work is never re-submitted, and the sentinel is left
# alone. Residency stopped implying liveness when `tap withdraw` began leaving a
# withdrawn payload resident in payloads/ so its recipient can read the
# tombstone — so "the payload is there" no longer means "this work is owed".
# nudge resolved the resident payload and pressed Enter at exit 0, re-submitting
# work the sender had retracted (sol-ponytail-4, G1-F3). The ordinary
# submit above is this pair's control: same fixture, same door, no receipt.
term_id=sender-20260906T220111Z-000000000001
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"
cat > "$TAP_HOME/payloads/$term_id.md" <<EOF
---
id: $term_id
from: sender
to: codex
kind: note
reply: settle-only
---
Withdrawn, but deliberately still resident.
EOF
for _case in withdrawn cancelled done; do
  rm -f "$TAP_HOME/receipts/$term_id.cancelled" "$TAP_HOME/receipts/$term_id.done"
  case "$_case" in
    withdrawn) printf '{"id":"%s","status":"cancelled","via":"withdrawn","by":"sender","at":"2026-09-16T00:00:00Z","reason":"head moved","superseded_by":"sender-20260906T220111Z-000000000002"}\n' "$term_id" > "$TAP_HOME/receipts/$term_id.cancelled" ;;
    cancelled) printf '{"id":"%s","status":"cancelled","via":"cancelled","by":"sender","at":"2026-09-16T00:00:00Z"}\n' "$term_id" > "$TAP_HOME/receipts/$term_id.cancelled" ;;
    done)      printf '{"id":"%s","status":"done","via":"read","by":"codex","at":"2026-09-16T00:00:00Z"}\n' "$term_id" > "$TAP_HOME/receipts/$term_id.done" ;;
  esac
  : > "$FAKE_TMUX_STATE/events"
  printf '[[TAP v0.23 note %s]]' "$term_id" > "$FAKE_TMUX_STATE/input"
  if "$TAP" nudge codex > "$TAP_HOME/term-$_case.out" 2>&1; then
    echo "nudge-submit: terminal ($_case) id was re-submitted instead of refused" >&2
    cat "$TAP_HOME/term-$_case.out" >&2; exit 1
  fi
  # THE invariant: no pane effect at all, and the operator's text untouched.
  [ -f "$FAKE_TMUX_STATE/input" ] || {
    echo "nudge-submit: terminal ($_case) cleared the sentinel — the pane was touched" >&2; exit 1; }
  # `grep -c` PRINTS 0 and EXITS 1 when nothing matches, so `$(grep -c … || echo 0)`
  # yields "0\n0" on the no-Enter path and never compares equal to 0 — a false
  # failure that reads exactly like a real pane effect. Capture once, default once.
  _enters="$(grep -c '^enter$' "$FAKE_TMUX_STATE/events" 2>/dev/null || true)"
  [ "${_enters:-0}" = 0 ] || {
    echo "nudge-submit: terminal ($_case) issued ${_enters} Enter(s)" >&2
    cat "$FAKE_TMUX_STATE/events" >&2; cat "$TAP_HOME/term-$_case.out" >&2; exit 1; }
  if [ "$_case" = withdrawn ]; then
    grep -q 'withdrawn' "$TAP_HOME/term-$_case.out" || {
      echo 'nudge-submit: withdrawn refusal did not name the withdrawal' >&2
      cat "$TAP_HOME/term-$_case.out" >&2; exit 1; }
    grep -q '000000000002' "$TAP_HOME/term-$_case.out" || {
      echo 'nudge-submit: withdrawn refusal did not name the successor' >&2
      cat "$TAP_HOME/term-$_case.out" >&2; exit 1; }
  fi
done
rm -f "$TAP_HOME/receipts/$term_id.cancelled" "$TAP_HOME/receipts/$term_id.done" "$TAP_HOME/payloads/$term_id.md"

# Real Codex footer: other text does not veto visible wire; truncation still refuses.
export FAKE_CODEX_FIXTURE="$ROOT/skills/tap/scripts/smoke/fixtures/submit-verify/codex-idle-staged-80.ansi"
fixture_id=sender-20260906T220111Z-21f26672936f
mkdir -p "$TAP_HOME/payloads"
cat > "$TAP_HOME/payloads/$fixture_id.md" <<EOF
---
id: $fixture_id
from: sender
to: codex
kind: note
reply: settle-only
---
Fixture only.
EOF
: > "$FAKE_TMUX_STATE/events"
printf '[[TAP⠠v0.23 note %s]]' "$fixture_id" > "$FAKE_TMUX_STATE/input"
"$TAP" nudge codex > "$TAP_HOME/codex-anchor-paint.out"
[ ! -f "$FAKE_TMUX_STATE/input" ] && [ "$(grep -c '^enter$' "$FAKE_TMUX_STATE/events")" = 1 ] || {
  echo 'nudge-submit: Codex anchor paint recovery did not issue exactly one Enter' >&2; exit 1;
}
# Enter submits the whole composer: the wire alone gets exactly one Enter; the wire beside a human draft
# (tap-tg9vz) and a truncated wire are refused with no key sent.
for suffix in '' ' human draft' truncated; do
  : > "$FAKE_TMUX_STATE/events"
  if [ "$suffix" = truncated ]; then printf '[[TAP v0.23 note %s' "$fixture_id" > "$FAKE_TMUX_STATE/input"
  else printf '[[TAP v0.23 note %s]]%s' "$fixture_id" "$suffix" > "$FAKE_TMUX_STATE/input"; fi
  if [ -z "$suffix" ]; then
    "$TAP" nudge codex > "$TAP_HOME/codex-footer.out"
    [ ! -f "$FAKE_TMUX_STATE/input" ] && [ "$(grep -c '^enter$' "$FAKE_TMUX_STATE/events")" = 1 ] || {
      echo 'nudge-submit: Codex footer recovery did not issue exactly one Enter' >&2; exit 1;
    }
  else
    if "$TAP" nudge codex > "$TAP_HOME/codex-refuse.out" 2>&1; then echo "nudge-submit: Codex unsafe input accepted (suffix: ${suffix:-none})" >&2; exit 1; fi
    [ ! -s "$FAKE_TMUX_STATE/events" ] || { echo "nudge-submit: Codex unsafe input received an effect (suffix: ${suffix})" >&2; exit 1; }
  fi
done
unset FAKE_CODEX_FIXTURE

# Claude feedback panels hold nudge even with a visible input band.
python3 - "$TAP_HOME/registry.json" <<'PYCLAUDE'
import json, sys
p=sys.argv[1]; d=json.load(open(p)); d["seats"]["codex"]["harness"]="claude"
json.dump(d, open(p, "w"))
PYCLAUDE
for frame in claude-feedback-truncated claude-feedback-empty-constructed; do
  : > "$FAKE_TMUX_STATE/events"
  result=0
  FAKE_TMUX_CMD=claude FAKE_CLAUDE_CAPTURE="$ROOT/skills/tap/scripts/smoke/fixtures/peek-harness-adapters/$frame.ansi" \
      "$TAP" nudge codex > "$TAP_HOME/claude-feedback.out" 2>&1 || result=$?
  # Neither fixture contains a complete wire: empty is a no-op, truncated refuses.
  if [ "$frame" = claude-feedback-truncated ]; then
    [ "$result" != 0 ] && grep -q 'no single complete TAP sentinel' "$TAP_HOME/claude-feedback.out" || {
      cat "$TAP_HOME/claude-feedback.out" >&2; exit 1;
    }
  fi
  [ ! -s "$FAKE_TMUX_STATE/events" ] || { echo 'nudge-submit: feedback panel received keys' >&2; exit 1; }
done
printf '❯ [[TAP incomplete\n' > "$TAP_HOME/claude-truncated.frame"
: > "$FAKE_TMUX_STATE/events"
if FAKE_TMUX_CMD=claude FAKE_CLAUDE_CAPTURE="$TAP_HOME/claude-truncated.frame" \
    "$TAP" nudge codex > "$TAP_HOME/claude-truncated.out" 2>&1; then
  echo 'nudge-submit: incomplete Claude marker accepted' >&2; exit 1
fi
grep -q 'no single complete TAP sentinel' "$TAP_HOME/claude-truncated.out" || { cat "$TAP_HOME/claude-truncated.out" >&2; exit 1; }
[ ! -s "$FAKE_TMUX_STATE/events" ] || { echo 'nudge-submit: incomplete Claude marker received keys' >&2; exit 1; }

# Cursor uses the shared colored-box reader through the public nudge door.
python3 - "$TAP_HOME/registry.json" <<'PYCURSOR'
import json, sys
p=sys.argv[1]; d=json.load(open(p)); d["seats"]["codex"]["harness"]="cursor"
json.dump(d, open(p, "w"))
PYCURSOR
: > "$FAKE_TMUX_STATE/events"
printf '[[TAP v=0.2 from=claude to=codex id=nudge-cursor kind=review path=/tmp/nudge.md]]' > "$FAKE_TMUX_STATE/input"
FAKE_TMUX_CMD=cursor "$TAP" nudge codex > "$TAP_HOME/cursor.out"
[ ! -f "$FAKE_TMUX_STATE/input" ] && [ "$(grep -c '^enter$' "$FAKE_TMUX_STATE/events")" = 1 ] || {
  echo 'nudge-submit: Cursor exact colored composer did not receive exactly one Enter' >&2; cat "$FAKE_TMUX_STATE/events" "$TAP_HOME/cursor.out" >&2; [ ! -f "$FAKE_TMUX_STATE/input" ] || cat "$FAKE_TMUX_STATE/input" >&2; exit 1;
}
: > "$FAKE_TMUX_STATE/events"
printf '[[TAP v=0.2 from=claude to=codex id=nudge-cursor kind=review path=/tmp/nudge.md]] human draft' > "$FAKE_TMUX_STATE/input"
if FAKE_TMUX_CMD=cursor "$TAP" nudge codex > "$TAP_HOME/cursor-mixed.out" 2>&1; then
  echo 'nudge-submit: Cursor mixed composer accepted' >&2; exit 1
fi
[ ! -s "$FAKE_TMUX_STATE/events" ] || { echo 'nudge-submit: Cursor mixed composer received Enter' >&2; exit 1; }

# OpenCode uses the same bounded composer while idle and mid-turn. Transcript
# text outside that box must not make an empty composer look staged.
python3 - "$TAP_HOME/registry.json" <<'PYREG'
import json, sys
p=sys.argv[1]; d=json.load(open(p)); d["seats"]["codex"]["harness"]="opencode"
json.dump(d, open(p, "w"))
PYREG
export FAKE_OPENCODE_ALL_WRAPPED=1
for footer in 'ctrl+p commands' '■■■■ esc interrupt'; do
  : > "$FAKE_TMUX_STATE/events"
  printf '[[TAP v=0.2 from=claude to=codex id=nudge-opencode kind=review path=/tmp/nudge.md]]' > "$FAKE_TMUX_STATE/input"
  FAKE_TMUX_CMD=opencode FAKE_OPENCODE_FOOTER="$footer" \
    "$TAP" nudge codex > "$TAP_HOME/opencode.out"
  grep -q 're-submitted' "$TAP_HOME/opencode.out" && [ ! -f "$FAKE_TMUX_STATE/input" ] || {
    echo 'nudge-submit: opencode staged sentinel was not submitted' >&2; exit 1
  }
  [ "$(grep -c '^enter$' "$FAKE_TMUX_STATE/events" || true)" = 1 ] || {
    echo 'nudge-submit: opencode recovery did not enforce its one-Enter ceiling' >&2; cat "$FAKE_TMUX_STATE/events" >&2; exit 1
  }
  [ "$(grep -c '^resize:112$' "$FAKE_TMUX_STATE/events" || true)" = 1 ] &&
    [ "$(grep -c '^resize:113$' "$FAKE_TMUX_STATE/events" || true)" = 1 ] || {
    echo 'nudge-submit: opencode recovery did not resize and restore exactly once' >&2; cat "$FAKE_TMUX_STATE/events" >&2; exit 1
  }
  [ ! -f "$FAKE_TMUX_STATE/window-option" ] || {
    echo 'nudge-submit: opencode recovery left window-size pinned' >&2; cat "$FAKE_TMUX_STATE/window-option" >&2; exit 1
  }
done

# A child-process diagnostic can overprint the input rows while leaving the
# OpenCode mode footer and bottom border intact. Nudge must recognize that torn
# geometry, repaint before localization, then retain the normal two-sample and
# one-Enter ceiling.
: > "$FAKE_TMUX_STATE/events"
rm -f "$FAKE_TMUX_STATE/opencode-repainted"

# The supported pane-only form has no argv handle. It resolves the supplied
# pane to one active acting-registry binding solely for the repaint effect; the
# visible sentinel still supplies the canonical recipient checked afterward.
: > "$FAKE_TMUX_STATE/events"
pane_only_id=sender-20260918T060800Z-000000000001
cat > "$TAP_HOME/payloads/$pane_only_id.md" <<EOF
---
id: $pane_only_id
from: sender
to: codex
kind: note
reply: settle-only
---
Pane-only OpenCode repaint fixture.
EOF
printf '[[TAP v0.23 note %s]]' "$pane_only_id" > "$FAKE_TMUX_STATE/input"
FAKE_TMUX_CMD=opencode FAKE_OPENCODE_OVERPRINT=1 \
  "$TAP" nudge --pane fake-pane:0.0 > "$TAP_HOME/opencode-pane-only.out" 2>&1
grep -q 'repainted OpenCode terminal overprint' "$TAP_HOME/opencode-pane-only.out" &&
  grep -q 're-submitted' "$TAP_HOME/opencode-pane-only.out" &&
  [ ! -f "$FAKE_TMUX_STATE/input" ] || {
  echo 'nudge-submit: pane-only OpenCode overprint did not repaint and submit' >&2
  cat "$TAP_HOME/opencode-pane-only.out" >&2
  exit 1
}
[ "$(grep -c '^enter$' "$FAKE_TMUX_STATE/events" || true)" = 1 ] || {
  echo 'nudge-submit: pane-only OpenCode recovery did not retain its one-Enter ceiling' >&2
  cat "$FAKE_TMUX_STATE/events" >&2
  exit 1
}
[ "$(grep -c '^resize:112$' "$FAKE_TMUX_STATE/events" || true)" = 1 ] &&
  [ "$(grep -c '^resize:113$' "$FAKE_TMUX_STATE/events" || true)" = 1 ] || {
  echo 'nudge-submit: pane-only OpenCode recovery did not repaint exactly once' >&2
  cat "$FAKE_TMUX_STATE/events" >&2
  exit 1
}
rm -f "${TAP_HOME:?}/payloads/${pane_only_id:?}.md"
rm -f "$FAKE_TMUX_STATE/opencode-repainted"
: > "$FAKE_TMUX_STATE/events"
printf '[[TAP v=0.2 from=claude to=codex id=nudge-opencode-overprint kind=review path=/tmp/nudge.md]]' > "$FAKE_TMUX_STATE/input"
FAKE_TMUX_CMD=opencode FAKE_OPENCODE_OVERPRINT=1 \
  "$TAP" nudge codex > "$TAP_HOME/opencode-overprint.out" 2>&1
grep -q 'repainted OpenCode terminal overprint' "$TAP_HOME/opencode-overprint.out" &&
  grep -q 're-submitted' "$TAP_HOME/opencode-overprint.out" &&
  [ ! -f "$FAKE_TMUX_STATE/input" ] || {
  echo 'nudge-submit: OpenCode overprint did not repaint and submit' >&2
  cat "$TAP_HOME/opencode-overprint.out" >&2
  exit 1
}
[ "$(grep -c '^enter$' "$FAKE_TMUX_STATE/events" || true)" = 1 ] || {
  echo 'nudge-submit: OpenCode overprint recovery did not retain its one-Enter ceiling' >&2
  cat "$FAKE_TMUX_STATE/events" >&2
  exit 1
}
[ "$(grep -c '^resize:112$' "$FAKE_TMUX_STATE/events" || true)" = 1 ] &&
  [ "$(grep -c '^resize:113$' "$FAKE_TMUX_STATE/events" || true)" = 1 ] || {
  echo 'nudge-submit: OpenCode overprint recovery did not repaint exactly once' >&2
  cat "$FAKE_TMUX_STATE/events" >&2
  exit 1
}
[ ! -f "$FAKE_TMUX_STATE/window-option" ] || {
  echo 'nudge-submit: OpenCode overprint recovery left window-size pinned' >&2
  exit 1
}
rm -f "$FAKE_TMUX_STATE/opencode-repainted"

# A sentinel that remains staged after Enter mutation-proves the OpenCode nudge
# ceiling. The ordinary success arm clears input and cannot reach this guard.
: > "$FAKE_TMUX_STATE/events"
printf '[[TAP v=0.2 from=claude to=codex id=nudge-opencode-stuck kind=review path=/tmp/nudge.md]]' > "$FAKE_TMUX_STATE/input"
set +e
FAKE_TMUX_CMD=opencode FAKE_TMUX_STUCK_SUBMIT=1 "$TAP" nudge codex > "$TAP_HOME/opencode-stuck.out" 2>&1
rc="$?"
set -e
[ "$rc" -eq 5 ] || { echo "nudge-submit: stuck OpenCode nudge expected exit 5, got $rc" >&2; cat "$TAP_HOME/opencode-stuck.out" >&2; exit 1; }
[ "$(grep -c '^enter$' "$FAKE_TMUX_STATE/events" || true)" = 1 ] || {
  echo 'nudge-submit: stuck OpenCode nudge did not stop after one Enter' >&2; cat "$FAKE_TMUX_STATE/events" >&2; exit 1
}
[ "$(grep -c '^resize:112$' "$FAKE_TMUX_STATE/events" || true)" = 1 ] &&
  [ "$(grep -c '^resize:113$' "$FAKE_TMUX_STATE/events" || true)" = 1 ] || {
  echo 'nudge-submit: stuck OpenCode nudge did not repaint exactly once' >&2; cat "$FAKE_TMUX_STATE/events" >&2; exit 1
}
[ ! -f "$FAKE_TMUX_STATE/window-option" ] || { echo 'nudge-submit: stuck OpenCode nudge left window-size pinned' >&2; exit 1; }
rm -f "$FAKE_TMUX_STATE/input"
unset FAKE_OPENCODE_ALL_WRAPPED

# 1a. Agy's running-task card sits below the real input band. Nudge must read the
# prompt-bearing rule pair, recover the staged sentinel, and submit it.
printf '[[TAP v=0.19 from=fable to=codex id=nudge-agy-task kind=discuss reply=expected]]' > "$FAKE_TMUX_STATE/input"
python3 - "$TAP_HOME/registry.json" agy <<'PY'
import json, sys
p, harness = sys.argv[1:3]; d=json.load(open(p)); d["seats"]["codex"]["harness"]=harness
json.dump(d, open(p, "w"), indent=2, sort_keys=True)
PY
FAKE_TMUX_CMD=agy "$TAP" nudge codex --pane fake-pane:0.0 >"$TAP_HOME/agy-task.out"
python3 - "$TAP_HOME/registry.json" codex <<'PY'
import json, sys
p, harness = sys.argv[1:3]; d=json.load(open(p)); d["seats"]["codex"]["harness"]=harness
json.dump(d, open(p, "w"), indent=2, sort_keys=True)
PY
grep -q 're-submitted' "$TAP_HOME/agy-task.out" || {
  echo "nudge-submit: agy task-card sentinel was not recovered" >&2
  cat "$TAP_HOME/agy-task.out" >&2
  exit 1
}
[ ! -f "$FAKE_TMUX_STATE/input" ] || { echo "nudge-submit: agy task-card sentinel did not clear" >&2; exit 1; }

# 1b. (U3) A v0.3 sentinel carrying the reply= token still parses: nudge's simpler
# regex must skip the extra key=value and recover the id (duplicate-parser coverage).
printf '[[TAP v=0.3 from=claude to=codex id=nudge-v03 kind=review reply=expected path=/tmp/nudge-v03.md]]' > "$FAKE_TMUX_STATE/input"
# A successful re-submit proves the id was recovered (nudge dies "missing id" if the
# regex fails to parse it) and that the id cleared from the input band.
"$TAP" nudge codex --pane fake-pane:0.0 >"$TAP_HOME/v03.out"
grep -q 're-submitted' "$TAP_HOME/v03.out" || { echo "nudge-submit: v0.3 reply-bearing sentinel not re-submitted (id not parsed?)" >&2; cat "$TAP_HOME/v03.out" >&2; exit 1; }
[ ! -f "$FAKE_TMUX_STATE/input" ] || { echo "nudge-submit: v0.3 sentinel did not clear" >&2; exit 1; }

# 1c. (tap-yv3) A v0.4 sentinel with colon-qualified from=/to= (cross-team) still
# parses: id must stay unqualified and recoverable — the class of bug fable-3
# flagged as load-bearing (a from=/to= charset change could silently break
# stuck-sentinel recovery for cross-team traffic).
printf '[[TAP v=0.4 from=teamb:hermes to=testteam:codex id=nudge-v04-xteam kind=discuss reply=expected path=/tmp/nudge-v04.md]]' > "$FAKE_TMUX_STATE/input"
"$TAP" nudge testteam/codex --pane fake-pane:0.0 >"$TAP_HOME/v04.out"
grep -q 're-submitted' "$TAP_HOME/v04.out" || { echo "nudge-submit: v0.4 colon-qualified sentinel not re-submitted (id not parsed?)" >&2; cat "$TAP_HOME/v04.out" >&2; exit 1; }
[ ! -f "$FAKE_TMUX_STATE/input" ] || { echo "nudge-submit: v0.4 colon-qualified sentinel did not clear" >&2; exit 1; }

# 1d. Display wrapping may split a qualified to= token across rows. The stored
# recipient remains authoritative after whitespace reconstruction.
printf '[[TAP v=0.6 from=claude to=test\nteam/co\ndex id=nudge-wrapped-to kind=discuss reply=expected path=/tmp/nudge-wrapped.md]]' > "$FAKE_TMUX_STATE/input"
"$TAP" nudge testteam/codex --pane fake-pane:0.0 >"$TAP_HOME/wrapped.out"
grep -q 're-submitted' "$TAP_HOME/wrapped.out" || { echo "nudge-submit: wrapped to= recipient not reconstructed" >&2; cat "$TAP_HOME/wrapped.out" >&2; exit 1; }
[ ! -f "$FAKE_TMUX_STATE/input" ] || { echo "nudge-submit: wrapped to= sentinel did not clear" >&2; exit 1; }

# 2. If Enter does not clear the id, nudge returns submit-unverified (5).
printf '[[TAP v=0.2 from=claude to=codex id=nudge-stuck kind=review path=/tmp/nudge-stuck.md]]' > "$FAKE_TMUX_STATE/input"
set +e
FAKE_TMUX_STUCK_SUBMIT=1 "$TAP" nudge codex --pane fake-pane:0.0 >"$TAP_HOME/stuck.out" 2>&1
rc="$?"
set -e
[ "$rc" -eq 5 ] || { echo "nudge-submit: stuck submit expected exit 5, got $rc" >&2; cat "$TAP_HOME/stuck.out" >&2; exit 1; }

# 2b. A confirmed sentinel that changes into a Codex paste-collapse chip after
# Enter remains submit-unverified; the id disappearing alone is not a success.
printf '[[TAP v=0.6 from=claude to=codex id=nudge-collapse kind=review path=/tmp/nudge-collapse.md]]' > "$FAKE_TMUX_STATE/input"
set +e
FAKE_TMUX_COLLAPSE_ON_ENTER=1 "$TAP" nudge codex --pane fake-pane:0.0 >"$TAP_HOME/collapse.out" 2>&1
rc="$?"
set -e
[ "$rc" -eq 5 ] || { echo "nudge-submit: collapse after Enter expected exit 5, got $rc" >&2; cat "$TAP_HOME/collapse.out" >&2; exit 1; }
grep -q 'submit-unverified' "$TAP_HOME/collapse.out" || { echo "nudge-submit: collapse after Enter missing submit-unverified output" >&2; cat "$TAP_HOME/collapse.out" >&2; exit 1; }

# 3. Human text with no TAP sentinel is a no-op, not submitted.
printf 'human draft' > "$FAKE_TMUX_STATE/input"
"$TAP" nudge codex --pane fake-pane:0.0 >"$TAP_HOME/noop.out"
grep -q 'no stuck sentinel' "$TAP_HOME/noop.out" || { echo "nudge-submit: no-op output missing" >&2; cat "$TAP_HOME/noop.out" >&2; exit 1; }
[ "$(cat "$FAKE_TMUX_STATE/input")" = "human draft" ] || { echo "nudge-submit: no-op submitted human text" >&2; exit 1; }

# 4. Pane-gone maps to exit 3.
set +e
FAKE_TMUX_GONE=1 "$TAP" nudge codex --pane fake-pane:0.0 >"$TAP_HOME/gone.out" 2>&1
rc="$?"
set -e
[ "$rc" -eq 3 ] || { echo "nudge-submit: pane-gone expected exit 3, got $rc" >&2; cat "$TAP_HOME/gone.out" >&2; exit 1; }

# 5. A shell transition after pane lookup cannot receive even the copy-mode
# cancel effect. The stuck sentinel and mode both remain intact.
printf '[[TAP v=0.6 from=claude to=codex id=nudge-shell-barrier kind=review reply=expected]]' > "$FAKE_TMUX_STATE/input"
touch "$FAKE_TMUX_STATE/copy-mode"
rm -f "$FAKE_TMUX_STATE/events"
set +e
FAKE_LIST_PANES_CMD=zsh "$TAP" nudge codex --pane fake-pane:0.0 >"$TAP_HOME/shell-barrier.out" 2>&1
rc="$?"
set -e
[ "$rc" -ne 0 ] || { echo "nudge-submit: shell transition crossed the effect barrier" >&2; exit 1; }
[ -f "$FAKE_TMUX_STATE/copy-mode" ] || { echo "nudge-submit: shell transition received copy-mode cancel" >&2; exit 1; }
[ ! -s "$FAKE_TMUX_STATE/events" ] || { echo "nudge-submit: shell transition received a pane effect" >&2; cat "$FAKE_TMUX_STATE/events" >&2; exit 1; }
grep -q 'nudge-shell-barrier' "$FAKE_TMUX_STATE/input" || { echo "nudge-submit: shell transition altered the stuck sentinel" >&2; exit 1; }
rm -f "$FAKE_TMUX_STATE/copy-mode"

# 6. Stuck copy-mode maps to defer (4), matching tap send.
touch "$FAKE_TMUX_STATE/copy-mode"
set +e
FAKE_TMUX_COPY_STUCK=1 "$TAP" nudge codex --pane fake-pane:0.0 >"$TAP_HOME/copy-mode.out" 2>&1
rc="$?"
set -e
[ "$rc" -eq 4 ] || { echo "nudge-submit: stuck copy-mode expected exit 4, got $rc" >&2; cat "$TAP_HOME/copy-mode.out" >&2; exit 1; }
rm -f "$FAKE_TMUX_STATE/copy-mode"

echo "nudge-submit-verify: ok"
