#!/usr/bin/env bash
# instance-binding.test.sh — U3 KTD-16 (flip-gated): stamps + fresh-inbox polarity.
#
# CONTRACT + production omit sender_instance for pane-less (poll) senders.
# This smoke previously required a poll sender to stamp sender_instance — that
# encoded a contract the CONTRACT does not state. Poll asserts absence; a
# pane-backed case covers the positive stamp; fresh-sender polarity is retained.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
# shellcheck source=helpers.sh
. "$ROOT/skills/tap/scripts/smoke/helpers.sh"
# shellcheck source=skills/tap/scripts/smoke/runtime-helpers.sh
. "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"

WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
export TAP_INDEX_HOME="$WORK/index"
export TAP_HOME="$WORK/team/.tap/bus"
export PATH="$FAKE_BIN:$PATH"
export TMUX="/fake/tmux/socket"
export FAKE_TMUX_STATE="$WORK/fake-tmux"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$TAP_HOME/tmp" "$FAKE_TMUX_STATE" "$TAP_INDEX_HOME"

fail() { echo "instance-binding: $*" >&2; exit 1; }

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"; mkdir -p "$state"
cmd="${1:-}"; shift || true
case "$cmd" in
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) target="${2:-}"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    case "$fmt" in
      *pane_id*)              echo "%${target:-alice}" ;;
      *pane_pid*)             echo "4242" ;;
      *pane_in_mode*)         echo "0" ;;
      *pane_current_command*) echo "claude" ;;
      *pane_current_path*)    echo "${FAKE_TMUX_PATH:-/tmp}" ;;
      *session_name*window_index*pane_index*) echo "team:0.0" ;;
      *pid*:*start_time*|#{pid}:#{start_time}) echo "1:100" ;;
      *) echo "" ;;
    esac ;;
  capture-pane) printf '› \n' ;;
  send-keys)
    if [ "${1:-}" = "-t" ]; then shift 2; fi
    if [ "${1:-}" = "-l" ]; then shift; [ "${1:-}" = "--" ] && shift
      printf '%s' "${1:-}" > "$state/last-sentinel"; exit 0; fi
    if [ "${1:-}" = "Enter" ]; then exit 0; fi ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"

write_reg() {
  # $1 = alice delivery (poll|pane)
  cat > "$TAP_HOME/registry.json" <<JSON
{
  "schema": "0.20", "team": { "name": "team", "worktree_root": "$WORK/team" },
  "seats": {
    "alice": {
      "pane": "alice", "pane_id": "%alice", "status": "active",
      "delivery": "$1", "harness": "claude",
      "session": "team", "server_epoch": "srv:1:100",
      "instance": "alice|aaa111"
    },
    "bob": {
      "pane": "bob", "pane_id": "%bob", "status": "active",
      "delivery": "poll", "harness": "claude",
      "instance": "bob|bbb222"
    }
  }
}
JSON
}



# ── tap-52ys: the pre-flip "no stamps" arm removed (2026-08-14) ─────────────
# We live post-flip, so the pre-flip arm asserted the behavior of a world that
# no longer exists. Three kept: a poll seat omits sender_instance, a pane seat
# stamps both ends, and a fresh inbox is empty (the polarity that keeps the
# first two from passing vacuously).

# --- flip live ---------------------------------------------------------------
mkdir -p "$WORK/team/.tap/team-history"
python3 - "$TAP_INDEX_HOME/global-registry.json" "$WORK/team" <<'PY'
import json, os, sys, time
gpath, root = sys.argv[1:3]
os.makedirs(os.path.dirname(gpath), exist_ok=True)
json.dump({
  "schema": "0.20",
  "migrated": {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "backups": {}},
  "teams": {"team": {
    "root": root,
    "registry_location": root + "/.tap/bus/registry.json",
    "state": "registered",
  }},
}, open(gpath, "w"), indent=2)
open(gpath, "a").write("\n")
PY

# (2a) poll sender — recipient stamped; sender_instance ABSENT (CONTRACT).
write_reg poll
tap_registry_v20_live || fail "flip should be live"
( cd "$WORK/team" && env -u TAP_HOME "$TAP" send bob -m "postflip-poll" --from alice --id ib-poll >/dev/null )
grep -q 'recipient_instance: bob|bbb222' "$TAP_HOME/payloads/ib-poll.md" || {
  echo "--- payload ---"; cat "$TAP_HOME/payloads/ib-poll.md"; fail "poll send missing recipient_instance"
}
grep -q 'sender_instance:' "$TAP_HOME/payloads/ib-poll.md" \
  && fail "poll sender must omit sender_instance (CONTRACT pane-less omit)"
echo "instance-binding: (2a) poll sender omits sender_instance: ok"


# (2b) pane sender — both stamps present.
write_reg pane
export TAP_SERVER_EPOCH="srv:1:100"
( cd "$WORK/team" && env -u TAP_HOME TAP_SERVER_EPOCH="$TAP_SERVER_EPOCH" \
  "$TAP" send bob -m "postflip-pane" --from alice --id ib-pane >/dev/null )
grep -q 'recipient_instance: bob|bbb222' "$TAP_HOME/payloads/ib-pane.md" \
  || fail "pane send missing recipient_instance"
grep -q 'sender_instance: alice|aaa111' "$TAP_HOME/payloads/ib-pane.md" \
  || fail "pane send missing sender_instance"
echo "instance-binding: (2b) pane sender stamps both ends: ok"


# (3) Fresh bob instance must not see the old recipient-bound payload.
python3 - "$TAP_HOME/registry.json" <<'PY'
import json, sys
reg = json.load(open(sys.argv[1]))
reg["seats"]["bob"]["instance"] = "bob|NEWcccc"
json.dump(reg, open(sys.argv[1], "w"), indent=2); open(sys.argv[1], "a").write("\n")
PY
# sol P1: `|| true` discarded the status, so a CRASHING poll produced empty
# output and the grep below found nothing — the arm passed for the wrong
# reason. An empty inbox is only evidence when the read succeeded.
#
# sol's RE-review: `-le 2` was still wrong — it admits 1, which tap-poll.sh
# uses for usage errors (unknown option, missing name). Exact membership, not
# a range. Per tap-poll.sh's header: 0 = no pending payloads, 2 = at least one
# listed, 1 = usage error, 4 = cwd-derived bus not grounded. Both 0 and 2 are
# real reads and both must stay allowed.
poll_rc=0
poll_out="$(cd "$WORK/team" && env -u TAP_HOME "$TAP" poll bob 2>"$WORK/poll.err")" || poll_rc=$?
case "$poll_rc" in
  0|2) ;;
  *) fail "(3) tap poll returned rc=$poll_rc (want 0=empty or 2=listed) — the absence of ib-pane proves nothing: $(cat "$WORK/poll.err")" ;;
esac
grep -q 'ib-pane' <<<"$poll_out" && fail "fresh bob must not poll predecessor's payload"
echo "instance-binding: (3) fresh recipient inbox empty: ok"

echo "instance-binding: ok"
