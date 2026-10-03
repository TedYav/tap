#!/usr/bin/env bash
# instance-terminal-gates.test.sh — U3 terminal-path instance gates (sol U3 #4/#5/#6):
#   (1) external read retires a predecessor note but refuses stale asks
#   (2) cancel allows withdrawal when recipient instance no longer matches
#   (3) out --kill live-failure rolls back a provisional flip-live tombstone
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
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$TAP_HOME/tmp" \
  "$WORK/team/.tap/team-history" "$TAP_INDEX_HOME" "$FAKE_TMUX_STATE"

fail() { echo "instance-terminal-gates: $*" >&2; exit 1; }

# Assert action is `rm -f <path> && …` and path equals retained tombstone.
# Uses punctuation_chars=True so ';' is a control operator (plain shlex.split
# is NOT — it kept unquoted team;semi paths as one token and left case (7)
# green under a no-%q mutation).
assert_rm_action_targets() { # <json-out> <retained-path> <label>
  # Compare via realpath: wave-1 (264389e8) routes tombstones through
  # TAP_TEAM_ROOT="$(tap_team_dir_from_bus)" which uses pwd -P, so the remedy
  # action names the physical path (/private/var/...) while the smoke's hist
  # glob may still hold the logical mktemp form (/var/...). Same inode; string
  # equality was the pre-TAP_TEAM_ROOT contract and is macOS-brittle now.
  python3 -c '
import json, os, shlex, sys
d = json.loads(sys.argv[1])
action = d.get("action") or ""
retained = sys.argv[2]
label = sys.argv[3]
lex = shlex.shlex(action, posix=True, punctuation_chars=True)
lex.whitespace_split = True
parts = list(lex)
if len(parts) < 3 or parts[0] != "rm" or parts[1] != "-f":
    raise SystemExit(f"{label}: action must start with rm -f: {action!r} parts={parts!r}")
got = parts[2]
# realpath alone resolves a RELATIVE target against this process cwd and can match by
# accident, so a remedy that says `rm -f <relative>` would pass. Require an absolute
# target first (tap-ywho).
if not got.startswith("/"):
    raise SystemExit(f"{label}: rm target must be an absolute path, got relative target {got!r}\n  action={action!r}")
if os.path.realpath(got) != os.path.realpath(retained):
    raise SystemExit(
        f"{label}: rm target must be the retained tombstone\n"
        f"  retained={retained!r}\n  got={got!r}\n  action={action!r}"
    )
' "$1" "$2" "$3"
}

# The helper itself must refuse a relative target that realpath-matches from the caller's
# cwd, and still accept the absolute spelling (tap-ywho).
mkdir -p "$WORK/relctl/team"
: >"$WORK/relctl/team/tomb"
relative_err="$(cd "$WORK/relctl" && assert_rm_action_targets '{"action":"rm -f team/tomb"}' "$WORK/relctl/team/tomb" relctl 2>&1)" \
  && fail "assert_rm_action_targets accepted a relative rm target"
case "$relative_err" in
  *"absolute path, got relative target 'team/tomb'"*) : ;;
  *) fail "relative-target refusal did not name the relative target: $relative_err" ;;
esac
(cd "$WORK/relctl" && assert_rm_action_targets "{\"action\":\"rm -f $WORK/relctl/team/tomb\"}" "$WORK/relctl/team/tomb" relctl) \
  || fail "assert_rm_action_targets rejected the absolute spelling"

# Minimal fake tmux: enough for out --kill identity + kill-fail rollback.
TMUX_LOG="$WORK/tmux.log"; : >"$TMUX_LOG"
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"; shift || true
case "$cmd" in
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) target="${2:-}"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    case "$fmt" in
      *pane_id*)              echo "${FAKE_PANE_ID_VALUE:-%$target}" ;;
      *session_name*)         echo "${FAKE_LIVE_SESSION:-team/alice}" ;;
      *pane_pid*)             echo "4242" ;;
      *pane_in_mode*)         echo "0" ;;
      *pane_current_command*) echo "claude" ;;
      *pane_current_path*)    echo "${FAKE_TMUX_PATH:-/tmp}" ;;
      *) echo "" ;;
    esac ;;
  has-session)
    target="${3:-}"; live="${FAKE_LIVE_SESSION:-}"
    if [[ "$target" == =* ]]; then
      [ "${target#=}" = "$live" ] && exit 0
    fi
    exit 1 ;;
  kill-session)
    printf '%s\n' "$*" >> "${TMUX_LOG:?}"
    target="${3:-}"; bare="${target#=}"
    [ "${FAKE_KILL_FAIL_TARGET:-}" = "$bare" ] && exit 1
    exit 0 ;;
  capture-pane) printf '› \n' ;;
  *) exit 0 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
# TMUX_LOG must be visible inside the fake binary.
export TMUX_LOG

flip_live() {
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
}


# ── tap-52ys: 5 of 7 arms removed (ratified 2026-08-14) ─────────────────────
# grok's call after the sweep priced this at 10.5s. The instance gate exists so
# a FRESH seat cannot settle or cancel obligations that belonged to the
# instance it replaced: arm (1) done --payload refuses a stale recipient
# instance, arm (2) cancel unblocks correctly for the predecessor-bound case.
#
# Accepted gap, named: the tombstone/kill-failure matrix (3-7) — false
# tombstones, unlink and restore failures, and the semicolon-team-root action
# string.

# --- (1) external read --payload: fresh recipient cannot settle ----------------
SENDER="$WORK/sender/.tap/bus"
mkdir -p "$SENDER/payloads" "$SENDER/receipts"
cat > "$TAP_HOME/registry.json" <<JSON
{
  "schema": "0.20", "team": { "name": "team", "worktree_root": "$WORK/team" },
  "seats": {
    "alice": {
      "status": "active", "delivery": "poll", "harness": "claude",
      "instance": "alice|NEWffff"
    }
  }
}
JSON
flip_live
tap_registry_v20_live || fail "flip should be live for external read"

ID="sender-20260729T000000Z-extinst01"
cat > "$SENDER/payloads/$ID.md" <<EOF
---
id: $ID
from: bob
to: alice
kind: task
reply: settle-only
cross_worktree: true
from_team: sender
to_team: team
recipient_instance: alice|OLDeeee
path: $SENDER/payloads/$ID.md
---
predecessor-bound cross-bus mail
EOF

rc=0
out="$(cd "$WORK/team" && env -u TAP_HOME "$TAP" read "path=$SENDER/payloads/$ID.md" --by alice 2>&1)" || rc=$?
[ "$rc" = 0 ] || fail "(1) retired-instance note must settle (got: $out)"
python3 - "$SENDER/receipts/$ID.done" <<'PYREASON'
import json,sys
assert json.load(open(sys.argv[1]))["reason"] == "instance_retired"
PYREASON
rm "$SENDER/receipts/$ID.done"
echo "instance-terminal-gates: (1) external read retires stale note: ok"

# Retirement discharges notes only. Reading an ask must not close its obligation.
AID="sender-20260729T000000Z-staleask01"
sed "s/$ID/$AID/g;s/reply: settle-only/reply: expected/" "$SENDER/payloads/$ID.md" > "$SENDER/payloads/$AID.md"
rc=0
out="$(cd "$WORK/team" && env -u TAP_HOME "$TAP" read "path=$SENDER/payloads/$AID.md" --by alice 2>&1)" || rc=$?
[ "$rc" != 0 ] || fail "(1a) stale ask must not be accepted as a note"
[ ! -e "$SENDER/receipts/$AID.done" ] && [ ! -e "$SENDER/receipts/$AID.read" ] || fail "(1a) stale ask gained a receipt"
# Another handle cannot retire somebody else's note.
rc=0
out="$(cd "$WORK/team" && env -u TAP_HOME "$TAP" read "path=$SENDER/payloads/$ID.md" --by outsider 2>&1)" || rc=$?
[ "$rc" != 0 ] && [ ! -e "$SENDER/receipts/$ID.done" ] || fail "(1a) unrelated reader retired note"

# Matching instance still settles.
python3 - "$TAP_HOME/registry.json" <<'PY'
import json, sys
reg = json.load(open(sys.argv[1]))
reg["seats"]["alice"]["instance"] = "alice|OLDeeee"
json.dump(reg, open(sys.argv[1], "w"), indent=2); open(sys.argv[1], "a").write("\n")
PY
( cd "$WORK/team" && env -u TAP_HOME "$TAP" read "path=$SENDER/payloads/$ID.md" --by alice >/dev/null ) \
  || fail "(1b) matching recipient instance must settle external --payload"
[ -f "$SENDER/receipts/$ID.done" ] || fail "(1b) .done missing after matching settle"
echo "instance-terminal-gates: (1b) matching external read settles: ok"


# --- (2) cancel: fresh recipient unblocks predecessor-bound cancel ------------
cat > "$TAP_HOME/registry.json" <<JSON
{
  "schema": "0.20", "team": { "name": "team", "worktree_root": "$WORK/team" },
  "seats": {
    "alice": {
      "status": "active", "delivery": "poll", "harness": "claude",
      "instance": "alice|aaa111"
    },
    "bob": {
      "status": "active", "delivery": "poll", "harness": "claude",
      "instance": "bob|NEWcccc"
    }
  }
}
JSON

CID="alice-20260729T000000Z-cancinst01"
cat > "$TAP_HOME/payloads/$CID.md" <<EOF
---
id: $CID
from: alice
to: bob
kind: task
reply: settle-only
sender_instance: alice|aaa111
recipient_instance: bob|OLDbbbb
path: $TAP_HOME/payloads/$CID.md
---
predecessor-bound same-team mail
EOF

# Matching current bob must still refuse cancel (seat_active).
python3 - "$TAP_HOME/registry.json" <<'PY'
import json, sys
reg = json.load(open(sys.argv[1]))
reg["seats"]["bob"]["instance"] = "bob|OLDbbbb"
json.dump(reg, open(sys.argv[1], "w"), indent=2); open(sys.argv[1], "a").write("\n")
PY
rc=0
out="$(cd "$WORK/team" && env -u TAP_HOME "$TAP" cancel "$CID" --by alice 2>&1)" || rc=$?
[ "$rc" != 0 ] || fail "(2a) matching bob must still block cancel (got: $out)"
grep -qi "seat_active\|still an active" <<<"$out" \
  || fail "(2a) expected seat_active (got: $out)"

# Fresh bob: cancel must succeed — bob cannot settle, so alice must clear.
python3 - "$TAP_HOME/registry.json" <<'PY'
import json, sys
reg = json.load(open(sys.argv[1]))
reg["seats"]["bob"]["instance"] = "bob|NEWcccc"
json.dump(reg, open(sys.argv[1], "w"), indent=2); open(sys.argv[1], "a").write("\n")
PY
( cd "$WORK/team" && env -u TAP_HOME "$TAP" cancel "$CID" --by alice >/dev/null ) \
  || fail "(2) fresh bob must allow cancel of predecessor-bound mail"
[ -f "$TAP_HOME/receipts/$CID.cancelled" ] \
  || fail "(2) .cancelled missing after fresh-recipient cancel"
echo "instance-terminal-gates: (2) cancel after recipient recreation: ok"
python3 - "$TAP_HOME/receipts/$CID.cancelled" <<'PYREASON'
import json,sys
assert json.load(open(sys.argv[1]))["reason"] == "instance_retired"
PYREASON

echo "instance-terminal-gates: ok"
