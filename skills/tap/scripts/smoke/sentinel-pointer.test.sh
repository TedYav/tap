#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# sentinel-pointer.test.sh — `path=` is UNCONDITIONAL on every sentinel, at all
# three construction sites (direct send, redelivery reconstruct, courier digest).
#
# This file used to be sentinel-diet.test.sh and pinned the OPPOSITE: v0.18
# (tap-wt0i) omitted `path=` whenever the recipient could derive it. tap-0z9l
# removed that diet, so the arms that once asserted absence now assert presence.
# The rename is deliberate — a file named for the diet, pinning its inverse, is a
# trap for the next reader.
#
# WHY the inversion, kept here as well as at the constructor because this is
# where someone lands when the assertions look redundant: the diet's rationale
# was that the pointer "carried no information the recipient did not already
# have." That holds only for a reader who knows the convention, and the
# convention is taught by session-start injection on three harnesses, by nothing
# on the fourth (opencode has no SessionStart hook), and by no mechanism at all
# to a compacted context or a human reading a pane. A 97-second-old opencode
# crew seat read a path-less sentinel as a message with no body and said so; the
# report was filed as P1 transport data loss. No bytes were ever lost.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"
# shellcheck source=skills/tap/scripts/smoke/helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/helpers.sh"

export TAP_TUI_SETTLE_SCALE=0.1
export TAP_SPOOL_DISABLE_DELIVERER=1

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
export TAP_INDEX_HOME="$WORK/index"   # live marker, no enrolled teams -> git worktree sibling fallback
mkdir -p "$TAP_INDEX_HOME"; printf '{"schema":"0.20","teams":{}}\n' > "$TAP_INDEX_HOME/global-registry.json"

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"; mkdir -p "$state"
cmd="${1:-}"; shift || true
case "$cmd" in
  # CONTRACT §Session-name authority: sender/recipient rows are backed by one
  # readable exact-session snapshot with numeric ids, generation, and harness.
  list-sessions) printf 'sess\t4242:100\n' ;;
  list-panes) printf 'sess\tsender-pane\t%%1001\tcodex\t4242\t4242:100\t0\nsess\tlocal-pane\t%%1002\tcodex\t4242\t4242:100\t0\nsess\tremote-pane\t%%1003\tcodex\t4242\t4242:100\t0\nsess\tremote-peer\t%%1004\tcodex\t4242\t4242:100\t0\nsess\tv20-sender\t%%1005\tcodex\t4242\t4242:100\t0\nsess\tv20-peer\t%%1006\tcodex\t4242\t4242:100\t0\n' ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) target="${2:-}"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    case "$fmt" in
      *pane_id*session_name*pane_pid*pane_current_command*)
        case "$target" in
          %*) ident="${target#%}" ;; sender-pane) ident=1001 ;; local-pane) ident=1002 ;;
          remote-pane) ident=1003 ;; remote-peer) ident=1004 ;; v20-sender) ident=1005 ;; v20-peer) ident=1006 ;; *) ident=1007 ;;
        esac
        printf '%%%s\tsess\t4242\tcodex\t0\n' "$ident" ;;
      '#{pid}:#{start_time}') printf '4242:100\n' ;;
      # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
      *pane_id*pane_tty*session_name*) case "$target" in sender-pane) ident=1001 ;; local-pane) ident=1002 ;; remote-pane) ident=1003 ;; remote-peer) ident=1004 ;; v20-sender) ident=1005 ;; v20-peer) ident=1006 ;; *) ident=1007 ;; esac; printf '%%%s\t/dev/faketty\tsess\t4242:100\n' "$ident" ;;
      *pane_id*session_name*)
        case "$target" in sender-pane) ident=1001 ;; local-pane) ident=1002 ;; remote-pane) ident=1003 ;; remote-peer) ident=1004 ;; v20-sender) ident=1005 ;; v20-peer) ident=1006 ;; *) ident=1007 ;; esac
        printf '%%%s\tsess\t4242:100\n' "$ident" ;;
      *session_name*)         echo "sess" ;;
      *pane_id*)              case "$target" in sender-pane) echo "%1001" ;; local-pane) echo "%1002" ;; remote-pane) echo "%1003" ;; remote-peer) echo "%1004" ;; v20-sender) echo "%1005" ;; v20-peer) echo "%1006" ;; *) echo "%1007" ;; esac ;;
      *pane_pid*)             echo "4242" ;;
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
      printf '%s' "${1:-}" > "$state/input"
      printf '%s' "${1:-}" > "$state/last-sentinel"
      exit 0
    fi
    if [ "${1:-}" = "Enter" ]; then rm -f "$state/input"; exit 0; fi ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH"

fail() { echo "sentinel-pointer: $*" >&2; [ -f "$FAKE_TMUX_STATE/last-sentinel" ] && cat "$FAKE_TMUX_STATE/last-sentinel" >&2; exit 1; }
has_path()  { grep -q ' path=' "$FAKE_TMUX_STATE/last-sentinel"; }

# --- fixture worktrees --------------------------------------------------------
# Sender and recipient buses belong to their separately enrolled roots.
SENDER="$WORK/SenderTeam"
REMOTE="$WORK/RemoteTeam"
git init -q "$SENDER"
git -C "$SENDER" config user.email tap@example.invalid
git -C "$SENDER" config user.name "TAP Smoke"
touch "$SENDER/README.md"; git -C "$SENDER" add README.md; git -C "$SENDER" commit -q -m init
git -C "$SENDER" worktree add -q "$REMOTE" -b remote-team

SENDER_BUS="$SENDER/.tap/bus"
REMOTE_BUS="$REMOTE/.tap/bus"
mkdir -p "$SENDER_BUS/payloads" "$SENDER_BUS/receipts" "$SENDER_BUS/spool" "$REMOTE_BUS/payloads" "$REMOTE_BUS/receipts"
cat > "$SENDER_BUS/registry.json" <<'JSON'
{
  "schema": "0.20", "team": { "name": "SenderTeam" },
  "seats": {
    "codex":  { "pane": "sender-pane", "pane_id": "%1001", "session": "sess", "server_epoch": "srv:4242:100", "harness": "codex", "status": "active" },
    "claude": { "pane": "local-pane",  "pane_id": "%1002", "session": "sess", "server_epoch": "srv:4242:100", "harness": "codex", "status": "active" }
  }
}
JSON
cat > "$REMOTE_BUS/registry.json" <<'JSON'
{
  "schema": "0.20", "team": { "name": "RemoteTeam" },
  "seats": {
    "codex": { "pane": "remote-pane", "pane_id": "%1003", "session": "sess", "server_epoch": "srv:4242:100", "harness": "codex", "status": "active" },
    "hermes": { "pane": "remote-peer", "pane_id": "%1004", "session": "sess", "server_epoch": "srv:4242:100", "harness": "codex", "status": "active" }
  }
}
JSON

export FAKE_TMUX_STATE="$WORK/fake-tmux"; mkdir -p "$FAKE_TMUX_STATE"


# ── tap-52ys: 15 of 17 arms removed (13 ratified 2026-08-14; 2 more later) ─
# grok's call, after the untimed sweep showed this file at 23.3s rather than
# the ~0 everyone assumed. Two arms remain: (1) an ordinary same-bus v0.23 send
# drops path= and its id resolves to the recipient canonical, and (2) a
# path-LESS sentinel still settles by bare id.
#
# The later change deleted arms (7) and (11) with tap_reconstruct_sentinel. (11)'s refusal
# to reconstruct from a foreign, non-canonical path is NOT covered anywhere now:
# the arbitrary-path interface it exercised no longer exists. Native
# redeliver(ctx, id, binding) takes only an id and derives the canonical path
# itself (spool-drain-effects.ts singleEffectCustody), so it cannot be handed a
# foreign filename. spool-drain-effects.test.ts covers the live path (single
# sender-index evidence, canonical residency, no-effect repark), which is not a
# renamed test of the deleted API.
#
# Accepted gap, named: the cross-worktree and legacy-bus relay variants, the
# foreign/unbound redelivery reconstructs, the digest pointer, and the v0.20
# acting-registry layout cases.

# --- (1) same-bus ordinary send: the ID resolves, and the pointer is GONE ------
#
# THIS ARM USED TO BE THE tap-0z9l REGRESSION and it is deliberately retired here,
# not swept. It asserted that a same-bus sentinel carries `path=`, which was the
# ratified fix after v0.18's pointer diet produced a P1 filed as silent transport
# data loss: a 97-second-old opencode crew seat read a path-less sentinel as a
# message with no body and said so, truthfully and wrongly.
#
# v0.23 (tap-7r3fn.8, spec section 13) drops the pointer from the ordinary case.
# Nothing in that decision chain cited tap-0z9l until this lane surfaced it, so it
# went up rather than through: the architect ruled on 2026-09-04 that
# section 13 stands, on the grounds that the REPLACEMENT is different in kind. v0.18
# left a naive reader a bare 12-hex id and a convention. v0.23 leaves them
# `<handle>-<UTC>-<12hex>`, which pastes into `tap read` / `tap show` verbatim.
#
# So this arm now pins the REPLACEMENT rather than the retired mechanism, which is
# the only way the file keeps guarding what tap-0z9l actually cared about —
# acceptance 3, "the recipient must be able to TELL". Asserting the absence of
# `path=` alone would be an arm that a total removal of the wire would also satisfy.
( cd "$SENDER" && "$TAP" send claude --ask -m "same bus" --from codex --kind discuss --id diet-same \
    >"$WORK/same.out" 2>&1 ) || { cat "$WORK/same.out" >&2; fail "(1) same-bus send failed"; }
[ -f "$SENDER_BUS/payloads/diet-same.md" ] || fail "(1) canonical missing on the sender bus"
has_path && fail "(1) same-bus sentinel still carries path= — section 13 drops it for the ordinary case; if you are restoring it, read tap-0z9l AND the 2026-09-04 ruling first"
# The id is slot 3, and it must be the whole minted id rather than a fragment: what
# replaces the pointer is a token a reader can paste.
grep -qE '^\[\[TAP v[0-9.]+ ask diet-same( |\]\])' "$FAKE_TMUX_STATE/last-sentinel" \
  || fail "(1) sentinel's id slot is not the payload id"
# THE PROPERTY ARM: that id, taken off the wire the way a reader takes it, reaches
# the bytes. This is what now carries tap-0z9l acceptance 3.
SAME_CANON="$(cd "$SENDER_BUS/payloads" && pwd -P)/diet-same.md"
WIRE_ID="$(sed -n 's/^\[\[TAP v[0-9.]* ask \([^] ]*\).*/\1/p' "$FAKE_TMUX_STATE/last-sentinel")"
[ -n "$WIRE_ID" ] || fail "(1) could not recover an id from the sentinel"
[ -f "$SENDER_BUS/payloads/${WIRE_ID##*/}.md" ] \
  || fail "(1) the id off the wire ('$WIRE_ID') does not resolve to a payload — the pointer is gone and its replacement does not work"
[ "$(cd "$SENDER_BUS/payloads" && pwd -P)/${WIRE_ID##*/}.md" = "$SAME_CANON" ] \
  || fail "(1) the id off the wire resolves to the wrong file"
echo "sentinel-pointer: (1) same-bus sentinel drops path= and its id resolves to the canonical (tap-0z9l retired under the 2026-09-04 ruling): ok"

# --- (2) recipient reflex: settle a PATH-LESS sentinel by BARE id -------------
# THE FIXTURE IS HAND-BUILT ON PURPOSE. Nothing emits a path-less sentinel any
# more, so this arm can no longer get one from a producer — and that is exactly
# why it must keep testing one. Every path-less sentinel already sitting in a
# pane, a spool, or a scrollback stays path-less forever; the recipient-side
# ability to resolve one by bare id is what keeps those readable, and it outlives
# the producer that made them.
#
# Do not "simplify" this by deleting the hand-construction as redundant with a
# producer that no longer exists — that would delete the only coverage of the
# backward-compatible read path.
PATHLESS="[[TAP v=0.20 from=codex to=claude id=diet-same kind=discuss reply=expected]]"
case "$PATHLESS" in *' path='*) fail "(2) fixture drift: the hand-built sentinel must carry NO path=" ;; esac
# Recover the id the way a recipient must when there is no pointer to follow, and
# settle by THAT — not by a literal the test already knows. Reading it back out of
# the sentinel is what makes this an exercise of the read path rather than a
# restatement of the fixture.
PATHLESS_ID="$(printf '%s' "$PATHLESS" | sed -n 's/.* id=\([^ ]*\) .*/\1/p')"
[ "$PATHLESS_ID" = diet-same ] || fail "(2) could not recover the id from a path-less sentinel: '$PATHLESS_ID'"
printf 'answer to retained ask\n' > "$WORK/reply-body.md"
( cd "$SENDER" && "$TAP" reply "$PATHLESS_ID" --by claude -f "$WORK/reply-body.md" >"$WORK/done.out" 2>&1 ) \
  || { cat "$WORK/done.out" >&2; fail "(2) bare-id settle of a path-less sentinel failed"; }
[ -f "$SENDER_BUS/receipts/diet-same.done" ] || fail "(2) settle wrote no receipt"
echo "sentinel-pointer: (2) bare-id settle resolves a path-less sentinel: ok"

# Native redelivery construction and canonical residency are covered by
# spool-drain-effects.test.ts (single sender-index and custody cases).
# The retired reconstruct helper's arbitrary-path refusal has no live entry point.
echo "sentinel-pointer: ok"
