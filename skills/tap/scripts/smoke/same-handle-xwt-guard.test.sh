#!/usr/bin/env bash
# same-handle-xwt-guard.test.sh — tap-w66z + tap-wsuu: two teams share a handle;
# a team-qualified send must not stamp, inject, inbox, or settle as if it were
# the sender team's same-handle seat.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

export TAP_SPOOL_DISABLE_DELIVERER=1
export TAP_TUI_SETTLE_SCALE=0.1

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"

WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
export TAP_INDEX_HOME="$WORK/index"
mkdir -p "$TAP_INDEX_HOME" "$FAKE_BIN"

fail() { echo "same-handle-xwt-guard: $*" >&2; exit 1; }

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"; mkdir -p "$state"
cmd="${1:-}"; shift || true
target=""
case "$cmd" in
  list-sessions)
    printf 'alpha/fable\t123:456\nalpha/sol\t123:456\nbeta/fable\t123:456\n' ;;
  list-panes)
    target=""; while [ "$#" -gt 0 ]; do case "$1" in -t) target="${2#=}"; shift 2 ;; *) shift ;; esac; done
    case "$target" in
      alpha/fable) printf 'alpha/fable\talpha-fable-pane\t%%901\tcodex\t4242\t123:456\t0\n' ;;
      alpha/sol)   printf 'alpha/sol\talpha-sol-pane\t%%902\tcodex\t4242\t123:456\t0\n' ;;
      beta/fable)  printf 'beta/fable\tbeta-fable-pane\t%%903\tcodex\t4242\t123:456\t0\n' ;;
    esac ;;
  display-message)
    fmt=""
    while [ "$#" -gt 0 ]; do case "$1" in -p) shift ;; -t) target="${2:-}"; shift 2 ;; *) fmt="$1"; shift ;; esac; done
    case "$fmt" in
      # Native observer probes: server identity, then the four-field pane record.
      # Answers must agree with the registries (%901/%902/%903, srv:123:456).
      *pane_id*session_name*pane_pid*pane_current_command*)
        case "$target" in
          alpha-fable-pane) printf '%s\t%s\t%s\t%s\t0\n' '%901' 'alpha/fable' '4242' 'codex' ;;
          alpha-sol-pane)   printf '%s\t%s\t%s\t%s\t0\n' '%902' 'alpha/sol' '4242' 'codex' ;;
          beta-fable-pane)  printf '%s\t%s\t%s\t%s\t0\n' '%903' 'beta/fable' '4242' 'codex' ;;
          *)                printf '%s\t%s\t%s\t%s\t0\n' '%901' 'alpha/fable' '4242' 'codex' ;;
        esac ;;
      '#{pid}:#{start_time}') echo '123:456' ;;
      *pane_id*)
        case "$target" in
          alpha-fable-pane) echo '%901' ;;
          alpha-sol-pane)   echo '%902' ;;
          beta-fable-pane)  echo '%903' ;;
          *) echo '%901' ;;
        esac ;;
      *session_name*window_index*pane_index*) echo 'alpha/fable:0.0' ;;
      *pane_in_mode*)         echo "0" ;;
      *pane_current_command*) echo "codex" ;;
      *)                      echo "" ;;
    esac ;;
  capture-pane)
    if [ -f "$state/input" ]; then printf '› %s\n' "$(cat "$state/input")"; else printf '› \n'; fi ;;
  send-keys)
    if [ "${1:-}" = "-t" ]; then target="${2:-}"; shift 2; fi
    if [ "${1:-}" = "-l" ]; then
      shift; [ "${1:-}" = "--" ] && shift
      printf 'target=%s %s\n' "$target" "${1:-}" >> "$state/sent.log"
      printf '%s' "${1:-}" > "$state/input"
      exit 0
    fi
    if [ "${1:-}" = "Enter" ]; then rm -f "$state/input"; exit 0; fi ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket"

ALPHA_ROOT="$WORK/alpha"; BETA_ROOT="$WORK/beta"
ALPHA_BUS="$ALPHA_ROOT/.tap/bus"; BETA_BUS="$BETA_ROOT/.tap/bus"
mkdir -p "$ALPHA_BUS/payloads" "$ALPHA_BUS/receipts" "$BETA_BUS/payloads" "$BETA_BUS/receipts"

cat > "$ALPHA_ROOT/.tap/team-registry.json" <<JSON
{
  "schema": "0.20",
  "team": {"name": "alpha"},
  "seats": {
    "fable": {
      "status": "active", "delivery": "pane", "harness": "codex",
      "session": "alpha/fable", "pane": "alpha-fable-pane",
      "pane_id": "%901", "server_epoch": "srv:123:456",
      "instance": "fable|AAAA", "registered_at": "t"
    },
    "sol": {
      "status": "active", "delivery": "pane", "harness": "codex",
      "session": "alpha/sol", "pane": "alpha-sol-pane",
      "pane_id": "%902", "server_epoch": "srv:123:456",
      "instance": "sol|SSSS", "registered_at": "t"
    }
  }
}
JSON
cat > "$BETA_ROOT/.tap/team-registry.json" <<JSON
{
  "schema": "0.20",
  "team": {"name": "beta"},
  "seats": {
    "fable": {
      "status": "active", "delivery": "pane", "harness": "codex",
      "session": "beta/fable", "pane": "beta-fable-pane",
      "pane_id": "%903", "server_epoch": "srv:123:456",
      "instance": "fable|BBBB", "registered_at": "t"
    }
  }
}
JSON

python3 -B - "$TAP_INDEX_HOME" "$ALPHA_ROOT" "$BETA_ROOT" <<'PY'
import json, pathlib, sys
idx, alpha, beta = map(pathlib.Path, sys.argv[1:4])
(idx / "global-registry.json").write_text(json.dumps({
  "schema": "0.20",
  "teams": {
    "alpha": {
      "root": str(alpha),
      "registry_location": str(alpha / ".tap" / "team-registry.json"),
      "state": "registered",
    },
    "beta": {
      "root": str(beta),
      "registry_location": str(beta / ".tap" / "team-registry.json"),
      "state": "registered",
    },
  },
}) + "\n")
PY

export FAKE_TMUX_STATE="$WORK/fake-tmux"
mkdir -p "$FAKE_TMUX_STATE"
: > "$FAKE_TMUX_STATE/sent.log"

TAP_HOME="$ALPHA_BUS" "$TAP" send beta/fable --ask -m "cross-team same-handle" \
  --from fable --kind discuss --id sol-20260813T000000Z-w66z0001 \
  >"$WORK/send.out" 2>"$WORK/send.err" \
  || fail "send failed: $(cat "$WORK/send.err")$(cat "$WORK/send.out")"

CANON="$ALPHA_BUS/payloads/sol-20260813T000000Z-w66z0001.md"
[ -f "$CANON" ] || fail "canonical missing on sender bus"

sinst="$(awk -F': ' '/^sender_instance:/{print $2; exit}' "$CANON")"
rinst="$(awk -F': ' '/^recipient_instance:/{print $2; exit}' "$CANON")"
[ "$sinst" = "fable|AAAA" ] \
  || fail "sender_instance must be the SENDER team's fable, got '$sinst' (want fable|AAAA; live leak stamped the recipient team's same handle)"
[ "$rinst" = "fable|BBBB" ] \
  || fail "recipient_instance want fable|BBBB, got '$rinst'"
grep -q '^to_team: beta$' "$CANON" || fail "to_team not stamped beta"

# Native delivery targets the registry pane_id, not the pane name — the
# pane-anchored form this test's own scenario argues for: two teams share the
# handle `fable`, and the %id can never collide where the name could.
grep -q 'target=%903' "$FAKE_TMUX_STATE/sent.log" \
  || fail "primary inject missed beta/fable pane %903: $(cat "$FAKE_TMUX_STATE/sent.log")"
if grep -q 'target=%901' "$FAKE_TMUX_STATE/sent.log"; then
  fail "duplicate inject into sender-team same-handle pane %901: $(cat "$FAKE_TMUX_STATE/sent.log")"
fi
injects="$(grep -c 'target=' "$FAKE_TMUX_STATE/sent.log" || true)"
[ "$injects" = "1" ] || fail "expected exactly one inject, got $injects: $(cat "$FAKE_TMUX_STATE/sent.log")"

poll_rc=0
TAP_HOME="$ALPHA_BUS" "$TAP" poll fable >"$WORK/poll.out" 2>"$WORK/poll.err" || poll_rc=$?
# sol P1: poll_rc was captured and never asserted, so a CRASHING poll wrote an
# empty poll.out and the grep below found nothing — passing for the wrong
# reason.
#
# sol's RE-review corrected this fix twice over: `-le 2` admits 1, which
# tap-poll.sh uses for USAGE errors, and my comment had the codes backwards.
# Per tap-poll.sh's header: 0 = no pending payloads, 2 = at least one listed,
# 1 = usage error, 4 = ungrounded bus. Exact membership, not a range.
case "$poll_rc" in
  0|2) ;;
  *) fail "tap poll returned rc=$poll_rc (want 0=empty or 2=listed) — the absence of the relay id proves nothing: $(cat "$WORK/poll.err")" ;;
esac
grep -q 'sol-20260813T000000Z-w66z0001' "$WORK/poll.out" \
  && fail "sender-team same-handle poll treated outbound relay as inbox"

# ── tap-52ys: 3 of 6 arms kept (ratified 2026-08-14) ────────────────────────
# The defect (tap-w66z / tap-wsuu): a team-qualified send settling as if it
# were local same-handle mail. Three arms state it — poll excludes a foreign
# to_team row, done refuses it, reply refuses it.
#
# Accepted gap, named: the recap, session-context and launcher copies of the
# same guard.

echo "same-handle-xwt-guard: poll excludes foreign to_team on sender bus: ok"

done_rc=0
TAP_HOME="$ALPHA_BUS" "$TAP" read sol-20260813T000000Z-w66z0001 --by fable \
  >"$WORK/done.out" 2>"$WORK/done.err" || done_rc=$?
[ "$done_rc" -ne 0 ] || fail "tap done settled a foreign-addressed same-handle payload"
[ ! -f "$ALPHA_BUS/receipts/sol-20260813T000000Z-w66z0001.done" ] \
  || fail "tap done wrote a receipt for the wrong team's payload"
grep -q 'beta/fable' "$WORK/done.out" "$WORK/done.err" \
  || fail "done refusal did not name beta/fable: $(cat "$WORK/done.err")$(cat "$WORK/done.out")"
echo "same-handle-xwt-guard: done refuses sender-team same-handle settle: ok"


reply_rc=0
TAP_HOME="$ALPHA_BUS" "$TAP" reply sol-20260813T000000Z-w66z0001 --by fable -m "nope" \
  >"$WORK/reply.out" 2>"$WORK/reply.err" || reply_rc=$?
[ "$reply_rc" -ne 0 ] || fail "tap reply answered a foreign-addressed same-handle payload"
[ ! -f "$ALPHA_BUS/receipts/sol-20260813T000000Z-w66z0001.done" ] \
  || fail "tap reply settled the foreign-addressed payload"
grep -q 'beta/fable' "$WORK/reply.out" "$WORK/reply.err" \
  || fail "reply refusal did not name beta/fable"
echo "same-handle-xwt-guard: reply refuses sender-team same-handle settle: ok"


recap_rc=0
TAP_HOME="$ALPHA_BUS" "$TAP" recap fable --json >"$WORK/recap.json" 2>"$WORK/recap.err" || recap_rc=$?
[ "$recap_rc" -eq 0 ] || fail "recap failed: $(cat "$WORK/recap.err")"
python3 -B - "$WORK/recap.json" <<'PY' || fail "recap listed outbound relay as local inbox"
import json, sys
doc = json.load(open(sys.argv[1]))
assert doc["ok"] is True, doc
inbox = doc["inbox"]
ids = [row.get("id") for row in inbox]
assert "sol-20260813T000000Z-w66z0001" not in ids, ids
PY
echo "same-handle-xwt-guard: recap inbox excludes foreign to_team: ok"

echo "same-handle-xwt-guard: ok"
