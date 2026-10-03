#!/usr/bin/env bash
# Peer lock-helper releases are temporal observations, not wave deletions.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
. "$ROOT/scripts/smoke-all.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tap-held-release.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/operator" "$WORK/run"
for ledger in pids handles redirected panes roots peer; do : >"$WORK/$ledger"; done
printf '%s\n' 267 >"$WORK/pids"
printf '%s\n' locks/smoke-all.lease.json >"$WORK/peer"

check_deletion() {
  local rel="$1" expected="$2" diagnostic="$3" rc=0
  mkdir -p "$(dirname "$WORK/operator/$rel")"
  : >"$WORK/operator/$rel"
  smoke_operator_state_snapshot "$WORK/operator" "$WORK/before"
  rm "$WORK/operator/$rel"
  smoke_operator_state_snapshot "$WORK/operator" "$WORK/after"
  smoke_operator_state_predicate "$WORK/before" "$WORK/after" \
    "$WORK/operator" "$WORK/run" "$WORK/pids" "$WORK/handles" \
    "$WORK/redirected" "$WORK/panes" "$WORK/roots" "$WORK/peer" >"$WORK/out" 2>&1 || rc=$?
  if [ "$rc" != "$expected" ] || ! grep -Fq "$diagnostic" "$WORK/out"; then
    echo "held-release: $rel expected rc=$expected diagnostic=$diagnostic; got rc=$rc" >&2
    cat "$WORK/out" >&2
    exit 1
  fi
}

check_deletion locks/pane-submit-_158.lock.held.7003.z1uxs1qv 0 'note peer held-marker released:'
check_deletion locks/registry.json.lock.held.1267.r1 0 'note peer held-marker released:'
check_deletion locks/pane-submit-_158.lock.held.267.r1 1 'protected operator state deleted:'
check_deletion locks/pane-submit-_158.lock 1 'protected operator state deleted:'
check_deletion locks/smoke-all.lock 1 'protected operator state deleted:'
check_deletion global-registry.json 1 'protected operator state deleted:'
check_deletion locks/obligation-long/deadbeef.lock.held.7003.r1 0 'note peer held-marker released:'
check_deletion locks/obligation-long/deadbeef.lock.held.267.r1 1 'protected operator state deleted:'
check_deletion locks/.held.7003.z1uxs1qv 0 'note peer held-marker released:'
check_deletion locks/.held.267.z1uxs1qv 1 'protected operator state deleted:'
check_deletion locks/.held.notapid.zzzz 1 'protected operator state deleted:'
check_deletion locks/obligation-long/.held.7003.r1 0 'note peer held-marker released:'
check_deletion archive/locks/smoke-all.lease.json 1 'protected operator state deleted:'
check_deletion locks/pane-submit-_158.lock.held.7003.bad-suffix 1 'protected operator state deleted:'
check_deletion locks/smoke-all.lease.json 0 'no attributable violation'
# Bun staging (tap-c7whh): pid is base 36, and 7f36 = 267 is the wave pid.
check_deletion runtime-cache/.tap.zz.0123abcd.tmp 0 'note peer staging released:'
check_deletion runtime-cache/.tap.7f.0123abcd.tmp 1 'protected operator state deleted:'
check_deletion runtime-cache/.tap.7fabc123 1 'protected operator state deleted:'
check_deletion runtime-cache/.tap.zz.0123abc.tmp 1 'protected operator state deleted:'
check_deletion runtime-cache/.tap.zz.0123abcd 1 'protected operator state deleted:'
check_deletion runtime-cache/.tap.ZZ.0123abcd.tmp 1 'protected operator state deleted:'
printf '%s\n' locks/pane-submit-_158.lock.held.7003.r1 >"$WORK/redirected"
check_deletion locks/pane-submit-_158.lock.held.7003.r1 1 'redirected-path:'
printf '%s\n' runtime-cache/.tap.zz.0123abcd.tmp >"$WORK/redirected"
check_deletion runtime-cache/.tap.zz.0123abcd.tmp 1 'redirected-path:'
: >"$WORK/redirected"

# tap-cc7iu: a courier removes a pane's input-protection record when its
# pending cohort is delivered or its composer goes bare, usually while grace is
# still in the future. The record's name binds it to one tmux server, so only a
# record keyed to the operator's socket notes. Grace timing is deliberately not
# part of the test: an unexpired operator-keyed record still notes.
SOCKET="$WORK/operator.sock"
ip_key() { printf '%s\0%s' "$1" "$2" | shasum -a 256 | cut -d' ' -f1; }
ip_body() { printf '{"pane":"%s","epoch":"srv:1:2","graceUntil":%s,"snoozeUntil":0,"consumed":false,"bareSince":null,"senders":["peer"],"pending":[{"home":"/bus","id":"peer-20261001T000000Z-aaaaaaaaaaaa","sender":"peer"}],"harness":"claude"}' "$1" "$2"; }
FUTURE=$(( ($(date +%s) + 600) * 1000 ))
# <name-hash> <body> <expected-rc> <diagnostic> [other-records] [socket-arg] [dir|all wipe]
check_ip_deletion() {
  local key="$1" body="$2" expected="$3" diagnostic="$4" kept="${5:-1}" socket="${6-$SOCKET}" wipe_dir="${7:-}" rc=0 i
  rm -rf "${WORK:?}/operator"
  mkdir -p "$WORK/operator/input-protection"
  printf '%s' "$body" >"$WORK/operator/input-protection/$key.json"
  for ((i = 0; i < kept; i++)); do
    printf '{}' >"$WORK/operator/input-protection/$(ip_key other "%9$i").json"
  done
  smoke_operator_state_snapshot "$WORK/operator" "$WORK/before"
  if [ "$wipe_dir" = dir ]; then
    rm -r "${WORK:?}/operator/input-protection"
  elif [ "$wipe_dir" = all ]; then
    find "$WORK/operator/input-protection" -type f -delete
  else
    rm "${WORK:?}/operator/input-protection/$key.json"
  fi
  smoke_operator_state_snapshot "$WORK/operator" "$WORK/after"
  smoke_operator_state_predicate "$WORK/before" "$WORK/after" \
    "$WORK/operator" "$WORK/run" "$WORK/pids" "$WORK/handles" \
    "$WORK/redirected" "$WORK/panes" "$WORK/roots" "$WORK/peer" \
    "$WORK/pids" "$socket" >"$WORK/out" 2>&1 || rc=$?
  if [ "$rc" != "$expected" ] || ! grep -Fq "$diagnostic" "$WORK/out"; then
    echo "held-release: input-protection/$key.json expected rc=$expected diagnostic=$diagnostic; got rc=$rc" >&2
    cat "$WORK/out" >&2
    exit 1
  fi
}
# The runner may record /tmp/... while Bun keys by the physical path.
mkdir -p "$WORK/link-target"
ln -s "$WORK/link-target" "$WORK/link"
REAL_SOCKET="$(cd "$WORK/link-target" && pwd -P)/s"
OP_KEY="$(ip_key "$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$SOCKET")" '%7')"
WAVE_KEY="$(ip_key /tmp/tap-tmux.wave/tmux-501/default '%7')"
check_ip_deletion "$OP_KEY" "$(ip_body '%7' "$FUTURE")" 0 'note operator-server input-protection released:'
check_ip_deletion "$OP_KEY" "$(ip_body '%7' 1)" 0 'note operator-server input-protection released:'
check_ip_deletion "$(ip_key "$REAL_SOCKET" '%7')" "$(ip_body '%7' "$FUTURE")" 0 'note operator-server input-protection released:' 1 "$WORK/link/s"
check_ip_deletion "$WAVE_KEY" "$(ip_body '%7' "$FUTURE")" 1 'protected operator state deleted:'
check_ip_deletion "$OP_KEY" "$(ip_body '%8' "$FUTURE")" 1 'protected operator state deleted:'
check_ip_deletion "$OP_KEY" '{"pane":' 1 'protected operator state deleted:'
check_ip_deletion "$OP_KEY" '{"epoch":"srv:1:2"}' 1 'protected operator state deleted:'
check_ip_deletion "$OP_KEY" "$(printf '\377')" 1 'protected operator state deleted:'
check_ip_deletion "$OP_KEY" "$(ip_body '%7' "$FUTURE")" 1 'protected operator state deleted:' 1 ''
# A wipe is the realistic shape of an escape: the directory gone, or every prior record (3+) gone.
check_ip_deletion "$OP_KEY" "$(ip_body '%7' "$FUTURE")" 1 'input-protection directory gone' 0 "$SOCKET" dir
check_ip_deletion "$OP_KEY" "$(ip_body '%7' "$FUTURE")" 1 'every prior input-protection record gone' 2 "$SOCKET" all
check_ip_deletion "$OP_KEY" "$(ip_body '%7' "$FUTURE")" 0 'note operator-server input-protection released:' 2
mkdir -p "$WORK/operator/input-protection"
printf '%s\n' "input-protection/$OP_KEY.json" >"$WORK/redirected"
check_ip_deletion "$OP_KEY" "$(ip_body '%7' "$FUTURE")" 1 'redirected-path:'
: >"$WORK/redirected"
# The observer path lock beside a record is not a record.
rm -rf "${WORK:?}/operator"
mkdir -p "$WORK/operator"
check_deletion "input-protection/$OP_KEY.json.observer" 1 'protected operator state deleted:'
echo 'held-release: all 37 controls passed'
