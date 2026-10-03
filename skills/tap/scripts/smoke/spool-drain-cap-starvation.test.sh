#!/usr/bin/env bash
# tap-zeng: already-escalated (or otherwise non-actionable) oldest spool entries
# must NOT consume TAP_SPOOL_DRAIN_CAP and starve a younger ready entry — that
# left attempts=0 on live parked mail for days while junk sat at the front.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

export TAP_SPOOL_DISABLE_DELIVERER=1 TAP_TUI_SETTLE_SCALE=0.1

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export TAP_HOME="$WORK/bus"
export TAP_SERVER_EPOCH="srv:900:100" TAP_BOOT_ID="boot:1"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$TAP_HOME/spool"
# Source AFTER TAP_HOME so TAP_SPOOL binds the fixture bus (lib.sh freezes it).
# shellcheck source=skills/tap/scripts/smoke/runtime-helpers.sh
. "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
. "$ROOT/skills/tap/scripts/smoke/spool-engine-fixture.sh"
# tap-ncd4: this fixture drives tap_spool_drain_once directly, never through
# the real `tap` CLI, so nothing stamps this TAP_HOME as authorized. Bootstrap
# it the way production does; injection here only ever reaches the fake tmux
# stub set up below, never a live pane.
tap_ensure_dirs
FAKE_BIN="$WORK/bin"
mkdir -p "$FAKE_BIN" "$WORK/tmux"
fail() { echo "spool-drain-cap-starvation: $*" >&2; exit 1; }

cat >"$FAKE_BIN/tmux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"; mkdir -p "$state"
cmd="${1:-}"; shift || true
case "$cmd" in
  list-sessions)
    printf 'taptest\t900:100\n'
    ;;
  list-panes)
    printf 'taptest\ttaptest:0.0\t%%811\tcodex\t5811\t900:100\t0\n'
    printf 'taptest\ttaptest:0.1\t%%812\tcodex\t5812\t900:100\t0\n'
    ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) target="${2:-}"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    case "$fmt" in
      *pane_id*)              [ "$target" = "taptest:0.0" ] && echo '%811' || echo '%812' ;;
      *pane_pid*)             echo "2147483646" ;;
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
      printf '%s' "${1:-}" >"$state/input"; exit 0
    fi
    if [ "${1:-}" = "Enter" ]; then rm -f "$state/input"; exit 0; fi ;;
esac
EOF
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH" FAKE_TMUX_STATE="$WORK/tmux" TMUX="/fake/socket"

cat >"$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "testteam"},
  "seats": {
    "sender": {"session": "taptest", "pane": "taptest:0.0", "pane_id": "%811", "status": "active", "harness": "codex", "server_epoch": "srv:900:100", "boot_id": "boot:1"},
    "peer": {"session": "taptest", "pane": "taptest:0.1", "pane_id": "%812", "status": "active", "harness": "codex", "server_epoch": "srv:900:100", "boot_id": "boot:1"}
  }
}
JSON

plant() { # <id> <first_epoch> <escalated:0|1>
  local id="$1" epoch="$2" esc="$3" reg="$TAP_HOME/registry.json"
  cat >"$TAP_HOME/spool/${id}.md" <<EOF
---
id: $id
from: sender
to: peer
kind: discuss
path: $TAP_HOME/spool/${id}.md
reply: settle-only
---
body $id
EOF
  python3 -B - "$TAP_HOME/spool/${id}.meta.json" "$id" "$epoch" "$esc" "$reg" <<'PY'
import json, sys
path, ident, epoch, esc, reg = sys.argv[1:6]
meta = {
  "id": ident,
  "target": "peer",
  "team": "testteam",
  "reason": "pending-input",
  "reason_class": "busy",
  "attempts": 0,
  "first_spooled": "t",
  "first_spooled_epoch": int(epoch),
  "pane": "taptest:0.1",
  "pane_id": "%812",
  "to_team": "",
  "target_registry": reg,
  "policy": "standard",
  "deadline_epoch": int(epoch) + 60,
}
if esc == "1":
  meta["escalated_at"] = "2026-01-01T00:00:00Z"
json.dump(meta, open(path, "w"), indent=2, sort_keys=True)
open(path, "a").write("\n")
PY
}

# Cap defaults to 8 — fill it with already-escalated OLDEST entries, then one
# younger ready entry that must still be drained.
CAP="${TAP_SPOOL_DRAIN_CAP:-8}"
base=1000000
i=0
while [ "$i" -lt "$CAP" ]; do
  plant "stuck-${i}" "$((base + i))" 1
  i=$((i + 1))
done
plant "fresh-ready" "$((base + CAP + 10))" 0

# --- polarity: ready entry must be attempted/delivered despite escalated front ---
spool_drain_fixture_once "$((base + CAP + 100))" "$CAP" || true
meta="$TAP_HOME/spool/fresh-ready.meta.json"
if [ -f "$meta" ]; then
  attempts="$(python3 -B -c 'import json,sys; print(json.load(open(sys.argv[1])).get("attempts") or 0)' "$meta")"
  [ "$attempts" -ge 1 ] || fail \
    "STARVATION: fresh-ready still attempts=$attempts after drain — escalated front consumed the cap"
else
  # Delivered (removed from spool) is also success — including submit-unverified
  # canonicalization that retires the automatic-delivery obligation.
  [ -f "$TAP_HOME/payloads/fresh-ready.md" ] \
    || fail "fresh-ready neither bumped attempts nor landed in payloads/"
fi

# Stuck escalated entries must remain in spool (skip ≠ digest-away ≠ delete).
i=0
while [ "$i" -lt "$CAP" ]; do
  [ -f "$TAP_HOME/spool/stuck-${i}.meta.json" ] \
    || fail "escalated stuck-$i left spool (digest/delete); human disposition lost"
  [ ! -f "$TAP_HOME/payloads/stuck-${i}.md" ] \
    || fail "escalated stuck-$i was moved to payloads/; must stay parked"
  i=$((i + 1))
done

echo "spool-drain-cap-starvation: escalated front does not starve ready entry: ok"
echo "spool-drain-cap-starvation: ok"
