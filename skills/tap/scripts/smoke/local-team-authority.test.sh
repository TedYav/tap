#!/usr/bin/env bash
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo 'do not source; run through smoke-all --only' >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# tap-3sll: the global enrollment key is the SOLE local-team source for every
# `to_team` comparison. One root carries three DIVERGENT names — worktree
# basename dir-x, enrolled alias alpha, acting/bus team.name stale-name — so
# any consumer comparing against a basename or the acting document drops mail
# stamped `to_team: alpha`. Asserted consumers: register briefing (arm 1) and
# the team-stop dry-run queue count (arm 2). Unstamped mail (legacy
# handle-only contract) must keep counting; a foreign `to_team: beta` stamp
# must never count.
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK:?}"' EXIT
FAILED=0
ok() { echo "local-team-authority: $1"; }
bad() { echo "FAIL local-team-authority: $1" >&2; FAILED=$((FAILED + 1)); }

export TAP_INDEX_HOME="$WORK/index"
mkdir -p "$TAP_INDEX_HOME"

# --- fixture: basename dir-x, enrolled alias alpha, acting name stale-name ----
# plant_enrolled shape (registry-lifecycle-reboot): the machine-index KEY is
# alpha while the acting + bus registries carry stale-name.
FIX="$WORK/dir-x"
mkdir -p "$FIX/.tap/bus/payloads" "$FIX/.tap/bus/receipts" "$FIX/.tap/bus/tmp"
python3 -B - "$TAP_INDEX_HOME/global-registry.json" "$FIX/.tap/team-registry.json" "$FIX" <<'PY'
import json, os, sys, time
gpath, treg, root = sys.argv[1:4]
os.makedirs(os.path.dirname(treg), exist_ok=True)
json.dump({
  "schema": "0.20",
  "team": {"name": "stale-name", "worktree_root": root},
  "seats": {"fable": {"status": "active", "delivery": "poll", "harness": "claude", "instance": "inst-keep-u3"}},
}, open(treg, "w"), indent=2)
open(treg + ".lock", "a+").write("lock\n")
bus = os.path.join(root, ".tap", "bus", "registry.json")
json.dump({"schema": "0.20", "team": {"name": "stale-name"}, "seats": {}}, open(bus, "w"), indent=2)
json.dump({
  "schema": "0.20",
  "migrated": {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "backups": {}},
  "teams": {"alpha": {"root": root, "registry_location": treg, "state": "registered"}},
}, open(gpath, "w"), indent=2)
PY

plant_payload() { # <file-stem> <id> [to_team]
  { printf '%s\n' '---'
    printf 'id: %s\n' "$2"
    printf 'from: peer\n'
    printf 'to: h1\n'
    printf 'reply: settle-only\n'
    [ -n "${3:-}" ] && printf 'to_team: %s\n' "$3"
    printf '%s\n' '---'
    printf 'body\n'
  } > "$FIX/.tap/bus/payloads/$1.md"
}

_rc=0
( cd "$FIX" && unset TAP_HOME && timeout 60 "$TAP" in h1 --team alpha --delivery poll ) >"$WORK/reg1.out" 2>&1 || _rc=$?
[ "$_rc" = 0 ] || bad "tap in h1 --team alpha failed (rc $_rc): $(head -c 200 "$WORK/reg1.out")"

plant_payload p-alpha p-alpha alpha # stamped LOCAL by the enrollment key
plant_payload p-local p-local       # unstamped: legacy handle-only contract
plant_payload p-beta p-beta beta    # foreign stamp: never local

# --- arm 1: register briefing counts to_team alpha ----------------------------
_brf_rc=0
( cd "$FIX" && unset TAP_HOME && timeout 60 "$TAP" in h1 --team alpha --delivery poll --json ) >"$WORK/brf.json" 2>&1 || _brf_rc=$?
if [ "$_brf_rc" != 0 ]; then
  bad "re-register for briefing failed (rc $_brf_rc): $(head -c 200 "$WORK/brf.json")"
else
  inbox="$(python3 -B -c 'import json,sys; print("\n".join(x["id"] for x in json.load(open(sys.argv[1])).get("inbox", [])))' "$WORK/brf.json")"
  case "$inbox" in
    *p-alpha*) ok "briefing counts the to_team alpha payload (enrollment-key authority)" ;;
    *) bad "briefing DROPPED the to_team alpha payload — register briefing is not reading the enrollment key (inbox: $(printf '%s' "$inbox" | tr '\n' ' '))" ;;
  esac
  case "$inbox" in
    *p-local*) ok "briefing keeps the unstamped payload (legacy handle-only contract)" ;;
    *) bad "briefing dropped the unstamped payload — legacy handle-only contract broken" ;;
  esac
  case "$inbox" in
    *p-beta*) bad "briefing counted the foreign to_team beta payload" ;;
    *) ok "briefing excludes the foreign beta stamp" ;;
  esac
fi

# --- arm 2: team-stop dry-run queue counts to_team alpha ----------------------
# team down refuses without an observable caller pane (self-last ordering), so
# the CLI runs INSIDE a real pane on a private-socket server; TAP's pane
# observation honors TAP_TMUX_SOCKET_PATH, so everything stays on that server.
SOCK="${TMUX_TMPDIR:-/tmp}/u3-$$.sock"
if ! tmux -S "$SOCK" new-session -d -s s1 -c "$FIX" -x 80 -y 24 \
  "TAP_HOME='$FIX/.tap/bus' TAP_TMUX_SOCKET_PATH='$SOCK' timeout 60 '$TAP' team down --dry-run >'$WORK/stop.out' 2>'$WORK/stop.err'; echo \$? >'$WORK/stop.rc'; : >'$WORK/stop.complete'" 2>"$WORK/ns.err"; then
  bad "tmux new-session failed: $(head -c 200 "$WORK/ns.err")"
fi
# The empty completion marker appears only after stop.rc is closed.
_stop_rc=""
_steps=0
while [ -z "$_stop_rc" ] && [ "$_steps" -lt 120 ]; do
  if [ -f "$WORK/stop.complete" ]; then _stop_rc="$(cat "$WORK/stop.rc")"; fi
  _steps=$((_steps + 1))
  sleep 0.5
done
tmux -S "$SOCK" kill-server 2>/dev/null || true
if [ -z "$_stop_rc" ] || [ "$_stop_rc" != "0" ]; then
  bad "team down --dry-run failed (rc ${_stop_rc:-timeout}): $(head -c 200 "$WORK/stop.err" 2>/dev/null)"
else
  # The to_team comparison feeds the PER-SEAT counts, rendered as a stderr
  # warning "N unprocessed inbound payload(s); seat counts: h1=N": the h1 row
  # must count the alpha stamp + the unstamped payload and exclude beta.
  case "$(cat "$WORK/stop.out" "$WORK/stop.err" 2>/dev/null)" in
    *"h1=2"*) ok "team-stop queue seat count for h1 = 2 (alpha stamp + unstamped counted)" ;;
    *) bad "team-stop queue did not render 'seat counts: h1=2' — the queue module is not fed the enrollment key (out: $(head -c 200 "$WORK/stop.out" 2>/dev/null) err: $(head -c 200 "$WORK/stop.err" 2>/dev/null))" ;;
  esac
fi

if [ "$FAILED" -gt 0 ]; then exit 1; fi
echo "local-team-authority: enrollment-key authority holds on both consumers"
