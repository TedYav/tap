#!/usr/bin/env bash
# D5: source-read — :107 grep-reads sentinel.ts SENTINEL_VERSION for the same wire-version pin; no module behavior exec'd
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.

# tap-7r3fn.20: this fixture is about the reply-expectation STAMP and reads the
# payload from payloads/; a parked send lives in spool/, so an arm after the
# first delivery to a seat would look for a canonical that is legitimately not
# there yet (`payloads/re-3.md: No such file or directory`).
# A window of zero is the seam that turns it off (ruling 24 keeps this variable
# overriding the short window) without the fixture knowing where the clock lives.
export TAP_AUTOSETTLE_HOLD_SECONDS=0

if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# reply-expectation-stamp.test.sh — U3 (R22): every v0.3 send stamps a sender-declared
# reply expectation into the envelope AND the sentinel; --fyi and plain poll senders
# stamp settle-only; poll renders the obligation; a v0.2 payload without the field
# reads as reply-expected and doctor does not flag it.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/helpers.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
TAP_HOME="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$TAP_HOME" "$FAKE_BIN"' EXIT
export TAP_HOME PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket"
export FAKE_TMUX_STATE="$TAP_HOME/fake-tmux"
unset TAP_SELF || true
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"

cat > "$FAKE_BIN/tmux" <<EOF
#!/usr/bin/env bash
set -euo pipefail
state="\${FAKE_TMUX_STATE:?}"; mkdir -p "\$state"
cmd="\${1:-}"; shift || true
case "\$cmd" in
  # CONTRACT §Session-name authority: the active seat proof is exact-session
  # membership with a numeric id, current generation, and expected harness.
  list-sessions) printf 'sess\\t900:100\\n' ;;
  list-panes) printf 'sess\\tself:0.0\\t%%1001\\tcodex\\t4242\\t900:100\\t0\\nsess\\trecipient\\t%%1002\\tcodex\\t4242\\t900:100\\t0\\n' ;;
  display-message)
    target=""; fmt=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        -p) shift ;;
        -t) target="\${2:-}"; shift 2 ;;
        *)  fmt="\$1"; shift ;;
      esac
    done
    if [ "\$fmt" = '#{pid}:#{start_time}' ]; then echo "900:100"; exit 0; fi
    if [ -z "\$target" ]; then echo "self:0.0"; exit 0; fi
    case "\$fmt" in
      *pane_id*session_name*pane_pid*pane_current_command*)
        case "\$target" in
          self:0.0) printf '%%1001\tsess\t4242\tcodex\t0\n' ;;
          recipient) printf '%%1002\tsess\t4242\tcodex\t0\n' ;;
          %1001) printf '%%1001\tsess\t4242\tcodex\t0\n' ;;
          %1002) printf '%%1002\tsess\t4242\tcodex\t0\n' ;;
          *) printf '\t\t\t\t\n' ;;
        esac ;;
      *pane_id*)              case "\$target" in self:0.0) echo "%1001" ;; recipient) echo "%1002" ;; *) echo "%1003" ;; esac ;;
      *pane_pid*)             echo "4242" ;;
      *pane_in_mode*)         echo "0" ;;
      *pane_current_command*) echo "codex" ;;
      *pane_current_path*)    echo "$ROOT" ;;
      *) echo "" ;;
    esac ;;
  capture-pane)
    if [ -f "\$state/input" ]; then printf '› %s\n' "\$(cat "\$state/input")"; else printf '› \n'; fi ;;
  send-keys)
    if [ "\${1:-}" = "-t" ]; then shift 2; fi
    if [ "\${1:-}" = "-l" ]; then shift; [ "\${1:-}" = "--" ] && shift
      printf '%s' "\${1:-}" > "\$state/input"; printf '%s' "\${1:-}" > "\$state/last-sentinel"; exit 0; fi
    if [ "\${1:-}" = "Enter" ]; then rm -f "\$state/input"; exit 0; fi ;;
esac
EOF
chmod +x "$FAKE_BIN/tmux"

cat > "$TAP_HOME/registry.json" <<'JSON'
{"schema": "0.20",  "team": { "name": "testteam" },
  "seats": {
    "sender": { "pane": "self:0.0", "pane_id": "%1001", "session": "sess", "server_epoch": "srv:900:100", "harness": "codex", "status": "active" },
    "codex": { "pane": "recipient", "pane_id": "%1002", "session": "sess", "server_epoch": "srv:900:100", "harness": "codex", "status": "active" },
    "poller": { "delivery": "poll", "harness": "poller", "status": "active" }
  } }
JSON
TEAM_ROOT="$TAP_HOME/team"; mkdir -p "$TEAM_ROOT"; TEAM_ROOT="$(cd "$TEAM_ROOT" && pwd -P)"
git -C "$TEAM_ROOT" init -q
tap_smoke_enroll_current "$TEAM_ROOT" "$TAP_HOME" testteam

# (1) Default send → the ENVELOPE carries `reply: settle-only` and the sentinel's
# obligation slot reads `note`. v0.23 (tap-7r3fn.8) removed `reply=` and the `v=`
# spelling from the wire; the envelope field is untouched (spec section 3), which is
# the split this arm now shows on both sides of.
# tap-31it: --wake keeps this send's reply=settle-only stamp while declining
# the courier's auto-settle hold, so the fixture still exercises DELIVERY.
"$TAP" send codex -m "hi" --from sender --id re-1 --pane recipient --wake >/dev/null 2>&1 \
  || { echo "reply-exp: (1) default send failed" >&2; exit 1; }
grep -q '^reply: settle-only$' "$TAP_HOME/payloads/re-1.md" || { echo "reply-exp: (1) envelope missing reply: settle-only" >&2; cat "$TAP_HOME/payloads/re-1.md" >&2; exit 1; }
# The version is read from the constant rather than written here: this arm is about
# the OBLIGATION slot, and hardcoding a version would make it red on every bump for
# a reason it does not test (contract-version-lockstep owns the number).
_ver="$(grep -o 'SENTINEL_VERSION = "[0-9.]*"' "$ROOT/runtime/bun/src/sentinel.ts" | cut -d'"' -f2)"
grep -qE "^\\[\\[TAP v${_ver} note " "$TAP_HOME/fake-tmux/last-sentinel" || { echo "reply-exp: (1) sentinel is not a v${_ver} note" >&2; cat "$TAP_HOME/fake-tmux/last-sentinel" >&2; exit 1; }
echo "reply-exp: (1) default send stamps reply: settle-only in the envelope and 'note' on the wire: ok"

# (2) --fyi send → settle-only in envelope and sentinel; poll renders it.
# tap-31it: --wake keeps this send's reply=settle-only stamp while declining
# the courier's auto-settle hold, so the fixture still exercises DELIVERY. Without
# it an eligible settle-only send parks by design and no sentinel/canonical exists.
# The claim under test is the STAMP (envelope + sentinel), not the delivery timing.
"$TAP" send sender -m "fyi" --from sender --fyi --wake --id re-2 --pane self:0.0 >/dev/null 2>&1 \
  || { echo "reply-exp: (2) --fyi send failed" >&2; exit 1; }
grep -q '^reply: settle-only$' "$TAP_HOME/payloads/re-2.md" || { echo "reply-exp: (2) --fyi did not stamp settle-only" >&2; cat "$TAP_HOME/payloads/re-2.md" >&2; exit 1; }
grep -qE '^\[\[TAP v[0-9.]+ note ' "$TAP_HOME/fake-tmux/last-sentinel" || { echo "reply-exp: (2) --fyi sentinel obligation slot is not 'note'" >&2; exit 1; }
set +e; pollout="$("$TAP" poll sender 2>/dev/null)"; set -e
case "$pollout" in *" note "*) ;; *) echo "reply-exp: (2) poll did not render the settle-only obligation as 'note'" >&2; echo "$pollout" >&2; exit 1 ;; esac
echo "reply-exp: (2) --fyi stamps settle-only and poll renders it: ok"

# (3) Registered poll sender, plain send → settle-only (R22).
# tap-31it: --wake for the same reason as (2) — the claim is the STAMP, and an
# eligible settle-only send now parks instead of canonicalizing.
"$TAP" send codex -m "no pane" --from poller --id re-3 --pane recipient --wake >/dev/null 2>&1 \
  || { echo "reply-exp: (3) registered poll send failed" >&2; exit 1; }
grep -q '^reply: settle-only$' "$TAP_HOME/payloads/re-3.md" || { echo "reply-exp: (3) plain poll sender not settle-only" >&2; cat "$TAP_HOME/payloads/re-3.md" >&2; exit 1; }
echo "reply-exp: (3) plain registered poll sender defaults to settle-only: ok"

# (4) v0.2 payload with no reply field → poll renders reply=expected; doctor clean
#     (the missing reply field is a known-optional absence, never a torn finding).
cat > "$TAP_HOME/payloads/re-legacy.md" <<EOF
---
id: re-legacy
from: claude
to: codex
kind: discuss
path: $TAP_HOME/payloads/re-legacy.md
---
legacy v0.2 body, no reply field
EOF
set +e; legpoll="$("$TAP" poll codex 2>/dev/null)"; set -e
case "$legpoll" in *"re-legacy"*" ask "*) ;; *) echo "reply-exp: (4) a legacy payload with no reply field must read as an ask" >&2; echo "$legpoll" >&2; exit 1 ;; esac
"$TAP" doctor >"$TAP_HOME/doc.out" 2>&1 || { echo "reply-exp: (4) doctor should exit 0 on a legacy payload" >&2; cat "$TAP_HOME/doc.out" >&2; exit 1; }
grep -q 'TORN:' "$TAP_HOME/doc.out" && { echo "reply-exp: (4) doctor flagged the legacy payload as torn" >&2; cat "$TAP_HOME/doc.out" >&2; exit 1; }
echo "reply-exp: (4) v0.2 payload reads reply=expected, doctor clean: ok"

echo "reply-expectation-stamp: ok"
