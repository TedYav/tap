#!/usr/bin/env bash
# cursor-harness.test.sh — cursor-agent harness support (Unit C).
# Proves: (1) a pane whose shallow command is `node` resolves to `cursor` via the
# process observation (cursor-agent is the pane's own process, node with cursor-agent argv);
# (2) cursor classifies as an agent (deliverable, not deferred); (3) the cursor prompt
# glyph → is handled — a dim `→ Add a follow-up` placeholder reads as EMPTY input while
# a typed `→ real draft` reads as pending.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
HERMES_FIXTURES="$ROOT/skills/tap/scripts/smoke/fixtures/hermes-prompt"
FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$FAKE_BIN"' EXIT
export PATH="$FAKE_BIN:$PATH"

# Fake tmux: a cursor pane (shallow command `node`, pane_pid 7000). capture-pane
# renders the → prompt line; the -e (escaped) form dims the placeholder via SGR 2.
cat > "$FAKE_BIN/tmux" <<'ENDTMUX'
#!/usr/bin/env bash
set -euo pipefail
sub="${1:-}"; shift || true
case "$sub" in
  display-message)
    fmt=""; while [ "$#" -gt 0 ]; do case "$1" in -p) shift ;; -t) shift 2 ;; *) fmt="$1"; shift ;; esac; done
    case "$fmt" in
      *pane_current_command*) echo "node" ;;
      *pane_pid*)             echo "7000" ;;
      *pane_in_mode*)         echo "0" ;;
      *pane_id*)              echo "%cursorpane" ;;
      *session_name*)         echo "cursorsess" ;;
      *) echo "" ;;
    esac ;;
  capture-pane)
    esc=0; for a in "$@"; do [ "$a" = "-e" ] && esc=1; done
    if [ -n "${FAKE_CAPTURE_FIXTURE:-}" ]; then
      if [ "$esc" = 1 ]; then
        cat "$FAKE_CAPTURE_FIXTURE"
      else
        python3 -B - "$FAKE_CAPTURE_FIXTURE" <<'PY'
import re, sys
sys.stdout.write(re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", open(sys.argv[1]).read()))
PY
      fi
      exit 0
    fi
    text="${FAKE_INPUT:-}"
    if [ -n "${FAKE_HERMES_STYLE:-}" ]; then
      if [ "$esc" = 0 ]; then
        printf '❯ %s\n' "$text"
      else
        case "$FAKE_HERMES_STYLE" in
          basic-red|bright-red)
            code=31; [ "$FAKE_HERMES_STYLE" = bright-red ] && code=91
            printf '\033[38;5;230m❯ \033[3;38;5;136m\033[%sm%s\033[0m\n' "$code" "$text" ;;
          italic-prompt)
            printf '\033[38;5;230m❯ \033[3m%s\033[0m\n' "$text" ;;
          muted-plain)
            printf '\033[38;5;230m❯ \033[38;5;136m%s\033[0m\n' "$text" ;;
          *) exit 2 ;;
        esac
      fi
      exit 0
    fi
    if [ -z "$text" ]; then printf '  \xe2\x86\x92 \n'; exit 0; fi
    if [ "$esc" = 1 ] && [ "${FAKE_DIM:-0}" = 1 ]; then
      # REAL cursor placeholder capture (Unit E): the terminal cursor block overlays
      # the first char ('A') in reverse video (SGR 0;7), resetting dim on that one
      # char and splitting the dim run — the exact bytes seen on a live cursor pane.
      printf ' \033[48;2;32;32;32m \033[2m\xe2\x86\x92 \033[0;7m\033[48;2;32;32;32mA\033[0;2m\033[48;2;32;32;32mdd a follow-up\033[0m\n'
      # G2 decoy: a transcript line with a mid-line → placed BELOW the input line. The
      # old unanchored `grep → | tail -1` would return THIS (last match) and break dim
      # detection; the anchored-on-stripped fix ignores it (→ is not at line start).
      [ "${FAKE_DECOY:-0}" = 1 ] && printf 'prior turn: use \xe2\x86\x92 to accept the diff\n'
    else
      printf '  \xe2\x86\x92 %s\n' "$text"
    fi ;;
  *) : ;;
esac
ENDTMUX
chmod +x "$FAKE_BIN/tmux"

# Fake ps: the pane's own (root, pid 7000) process. FAKE_PS_ROOT is the "comm command"
# portion; default is the argv0-cursor-agent shape, overridable to test other launches.
cat > "$FAKE_BIN/ps" <<'ENDPS'
#!/usr/bin/env bash
printf ' 7000 7000 7000 %s\n' "${FAKE_PS_ROOT:-node /Users/dev/.local/bin/cursor-agent --use-system-ca /Users/dev/app/index.js}"
ENDPS
chmod +x "$FAKE_BIN/ps"

# shellcheck source=skills/tap/scripts/smoke/runtime-helpers.sh
. "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"

# The native pane reader through a test fixture bridge, fed the two captures the retired
# lib.sh adapter took (escaped, then plain; both joined). rc 3 no band, 4 blocked,
# 5 overprint; otherwise the pending text on stdout.
pending_text() { # <pane> <harness>
  local esc plain v
  esc="$(tmux capture-pane -J -p -e -t "$1"; printf X)"; esc="${esc%X}"
  plain="$(tmux capture-pane -J -p -t "$1"; printf X)"; plain="${plain%X}"
  v="$( { printf '%s\n%s%s' "$(printf '%s' "$esc" | wc -c | tr -d ' ')" "$esc" "$plain" \
    | bun "$ROOT/runtime/bun/test/support/pending-input-cli.ts" "$1" "$2"; printf X; } )" || return 1
  v="${v%X}"
  case "$v" in
    no-band) return 3 ;; blocked) return 4 ;; overprint) return 5 ;;
    text$'\x1f'*) printf '%s' "${v#text$'\x1f'}" ;;
    *) return 1 ;;
  esac
}

# 1. node (shallow) -> process observation -> cursor (cursor-agent is argv0 of the command).
got="$(tap_pane_harness_command cursorpane node)"
[ "$got" = "cursor" ] || { echo "cursor-harness: node did not resolve to cursor via ps-walk (got '$got')" >&2; exit 1; }
echo "cursor-harness: 1/5 — shallow 'node' resolves to 'cursor' via process observation: ok"

# 1b. G1: node with cursor-agent as a PATH SEGMENT of a later argv token (basename
# is index.js, so basename-of-token alone misses it) still resolves to cursor.
got="$(FAKE_PS_ROOT='node node /opt/pkgs/cursor-agent/index.js' tap_pane_harness_command cursorpane node)"
[ "$got" = "cursor" ] || { echo "cursor-harness: node .../cursor-agent/index.js did not resolve to cursor (got '$got')" >&2; exit 1; }
# Safety: a bare family name as a path segment (e.g. /opt/claude/scratch/run.js)
# must NOT false-classify.
got="$(FAKE_PS_ROOT='node node /opt/claude/scratch/run.js' tap_pane_harness_command cursorpane node)"
[ "$got" != "claude" ] || { echo "cursor-harness: a family-named home segment wrongly classified as claude (segment false-positive)" >&2; exit 1; }
echo "cursor-harness: 1b/5 — cursor-agent path-segment resolves; bare family segment does not false-match: ok"

# 2. cursor classifies as a deliverable agent (not unsupported/defer).
[ "$(tap_classify_harness cursor)" = "agent" ] || { echo "cursor-harness: cursor not classified as agent" >&2; exit 1; }
# The glyph set (including →) is native: promptGlyph in runtime/bun/src/pane/geometry.ts.
echo "cursor-harness: 2/5 — cursor classifies as agent: ok"

# 2b. hermes: pane cmd is a bare python3.x (venv launcher), the real harness is the
# 'hermes' argv token — process observation resolves it, and it classifies as a deliverable agent
# (an unknown family would be an injection DEFER: registered but unreachable).
got="$(FAKE_PS_ROOT='python3.11 /Users/dev/.hermes/hermes-agent/venv/bin/python3 /Users/dev/.hermes/hermes-agent/venv/bin/hermes' tap_pane_harness_command hermespane python3.11)"
[ "$got" = "hermes" ] || { echo "cursor-harness: venv python3.11 did not resolve to hermes via ps-walk (got '$got')" >&2; exit 1; }
[ "$(tap_classify_harness hermes)" = "agent" ] || { echo "cursor-harness: hermes not classified as agent" >&2; exit 1; }
echo "cursor-harness: 2b/5 — hermes venv launcher resolves from process evidence and classifies as agent: ok"

# 3. dim `→ Add a follow-up` placeholder reads as EMPTY input (no pending human draft).
export FAKE_INPUT="Add a follow-up" FAKE_DIM=1
ph="$(pending_text cursorpane cursor || true)"
unset FAKE_INPUT FAKE_DIM
[ -z "$ph" ] || { echo "cursor-harness: dim placeholder wrongly read as pending input (got '$ph')" >&2; exit 1; }
echo "cursor-harness: 3/5 — dim → placeholder classifies as EMPTY: ok"

# 3b. G2: a decoy transcript '→' line in the capture must NOT hijack dim detection.
# tap_escaped_inputline anchors on an ANSI-stripped copy and returns the raw prompt
# line, so the placeholder still classifies EMPTY even with the decoy present.
export FAKE_INPUT="Add a follow-up" FAKE_DIM=1 FAKE_DECOY=1
ph="$(pending_text cursorpane cursor || true)"
unset FAKE_INPUT FAKE_DIM FAKE_DECOY
[ -z "$ph" ] || { echo "cursor-harness: decoy → transcript line hijacked dim detection (got '$ph')" >&2; exit 1; }
echo "cursor-harness: 3b/5 — decoy → transcript line ignored (anchored escaped match): ok"

# 3c. Live Hermes idle chrome is italic plus the muted 38;5;136 foreground.
# Its wording is deliberately not part of the predicate: the two live seats that
# exposed this defect drew different hints with the same attribute split.
ph="$(FAKE_CAPTURE_FIXTURE="$HERMES_FIXTURES/placeholder.ansi" pending_text hermespane hermes || true)"
[ -z "$ph" ] || { echo "cursor-harness: Hermes placeholder wrongly read as pending input (got '$ph')" >&2; exit 1; }
echo "cursor-harness: 3c/5 — live Hermes styled placeholder classifies as EMPTY: ok"

# 4. a typed (undimmed) `→ real draft` reads as pending input.
export FAKE_INPUT="real draft" FAKE_DIM=0
typed="$(pending_text cursorpane cursor || true)"
unset FAKE_INPUT FAKE_DIM
[ "$typed" = "real draft" ] || { echo "cursor-harness: typed cursor input not captured (got '$typed')" >&2; exit 1; }
echo "cursor-harness: 4/5 — typed → input reads as pending 'real draft': ok"

# 4b. The paired live negative: real Hermes draft text is plain after SGR 39,
# not italic+38;5;136, and must remain protected as pending input.
typed="$(FAKE_CAPTURE_FIXTURE="$HERMES_FIXTURES/typed.ansi" pending_text hermespane hermes || true)"
[ "$typed" = "TAP-HERMES-TYPED-CONTROL-7R3FN37" ] || { echo "cursor-harness: typed Hermes input not protected (got '$typed')" >&2; exit 1; }
echo "cursor-harness: 4b/5 — live Hermes typed input remains pending: ok"

# 4c/4d. Each observed placeholder attribute is necessary. Italic text in the
# prompt foreground and plain text in the muted foreground are both human input.
typed="$(FAKE_INPUT="italic human draft" FAKE_HERMES_STYLE=italic-prompt pending_text hermespane hermes || true)"
[ "$typed" = "italic human draft" ] || { echo "cursor-harness: italic-only Hermes draft not protected (got '$typed')" >&2; exit 1; }
typed="$(FAKE_INPUT="muted human draft" FAKE_HERMES_STYLE=muted-plain pending_text hermespane hermes || true)"
[ "$typed" = "muted human draft" ] || { echo "cursor-harness: muted-only Hermes draft not protected (got '$typed')" >&2; exit 1; }
echo "cursor-harness: 4c/5 — Hermes italic-only and muted-only drafts remain pending: ok"

for style in basic-red bright-red; do
  typed="$(FAKE_INPUT="real draft" FAKE_HERMES_STYLE="$style" pending_text hermespane hermes || true)"
  [ "$typed" = "real draft" ] || { echo "cursor-harness: $style after placeholder lost draft (got '$typed')" >&2; exit 1; }
done

# 5. The Hermes peek assertions moved to runtime/bun/test/pane-reader.test.ts
# with tap_pane_read; peek reads the pane natively.


echo "cursor-harness: ok"
