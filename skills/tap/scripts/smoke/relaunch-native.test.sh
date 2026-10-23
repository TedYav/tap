#!/usr/bin/env bash
# Refuse source before changing the caller's shell options or environment.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# R8a: real private-tmux durable relaunch, retaining conversation and pane.
# The harness fixture records argv and its nonce; no harness account is used.
# Drives the public door `tap session relaunch`; the router enters the same
# cmdSessionRelaunch entry the module CLI does (main.ts:93), so every
# assertion below still pins the durable-relaunch contract itself.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
unset TAP_CLEAR_ID
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d "${TMUX_TMPDIR:?run through smoke-all --only}/relaunch-native.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
REAL_TMUX="$(command -v tmux)"
SOCKET="$WORK/tmux.sock"
cleanup() {
  "$REAL_TMUX" -S "$SOCKET" kill-server 2>/dev/null || true
  rm -rf "${WORK:?}"
}
trap cleanup EXIT
fail() { echo "relaunch-native: $*" >&2; exit 1; }
mkdir -p "$WORK/bin" "$WORK/Demo/.tap/bus" "$WORK/index" "$WORK/launches" "$WORK/config/tap" "$WORK/idle"
unset TAP_HOME
export TAP_INDEX_HOME="$WORK/index" REAL_TMUX SOCKET LAUNCHES="$WORK/launches" XDG_CONFIG_HOME="$WORK/config"
cat > "$WORK/bin/tmux" <<'TMUX'
#!/usr/bin/env bash
if [ "${1:-}" = -S ]; then [ "$2" = "$SOCKET" ] || exit 99; shift 2; fi
exec "$REAL_TMUX" -S "$SOCKET" "$@"
TMUX
cat > "$WORK/bin/ps" <<'PS'
#!/usr/bin/env bash
case "$*" in
  *'ppid='*'tty='*) printf '1 %s\n' "${CALLER_TTY#/dev/}" ;;
  *) exec /bin/ps "$@" ;;
esac
PS
cat > "$WORK/bin/sh" <<'LOGIN_SHELL'
#!/bin/sh
PATH="${0%/*}:$PATH"; export PATH
if [ "${1:-}" = -lic ]; then shift; exec /bin/sh -c "$@"; fi
exec /bin/sh "$@"
LOGIN_SHELL
# The fake harness records argv and the clear id, answers the pending question
# the way a matching registration would, then idles under the harness's name.
cat > "$WORK/bin/claude" <<'HARNESS'
#!/bin/sh
if [ "${0##*/}" = opencode ]; then
  case "$1" in --version|api) exec "${TAP_SMOKE_BUN:?}" "$OPENCODE_FIXTURE" "$@" ;; esac
fi
{ printf 'TAP_CLEAR_ID=%s\nTAP_HOME=%s\n' "${TAP_CLEAR_ID:-}" "${TAP_HOME:-}"; printf '%s\n' "$@"; } > "$LAUNCHES/$$"
if [ -n "${TAP_CLEAR_ID:-}" ]; then
  python3 - "$REG" "$TAP_CLEAR_ID" <<'PY'
import json, sys
reg, nonce = sys.argv[1], sys.argv[2]
doc = json.load(open(reg))
row = doc["seats"]["sol"]
if row.get("expected_clear_nonce") == nonce:
    row["clear_nonce"] = nonce
    json.dump(doc, open(reg, "w"))
PY
fi
exec "$IDLE/${0##*/}" 600
HARNESS
cp "$WORK/bin/claude" "$WORK/bin/opencode"
export OPENCODE_FIXTURE="$ROOT/runtime/bun/test/support/opencode-cli.ts"
ln -s /bin/sleep "$WORK/idle/claude"; ln -s /bin/sleep "$WORK/idle/opencode"; export IDLE="$WORK/idle"
chmod +x "$WORK/bin/tmux" "$WORK/bin/ps" "$WORK/bin/sh" "$WORK/bin/claude" "$WORK/bin/opencode"
export PATH="$WORK/bin:$PATH" TAP_LAUNCH_SHELL="$WORK/bin/sh"
printf 'version = 2\n' > "$WORK/config/tap/config.toml"; chmod 600 "$WORK/config/tap/config.toml"
T() { "$REAL_TMUX" -S "$SOCKET" "$@"; }
git -C "$WORK/Demo" init -q

export REG="$WORK/Demo/.tap/team-registry.json"
T new-session -d -s Demo/lead -c "$WORK/Demo"
T new-session -d -s Demo/sol -c "$WORK/Demo" "exec $IDLE/claude 600"
T new-session -d -s Demo/other -c "$WORK/Demo" "exec sleep 600"
pane() { T display-message -p -t "$1" '#{pane_id}'; }
pid() { T display-message -p -t "$1" '#{pane_pid}'; }
export TMUX="$SOCKET,0,0"
LEAD="$(pane Demo/lead:0.0)"; SOL="$(pane Demo/sol:0.0)"; OTHER="$(pane Demo/other:0.0)"
export TMUX_PANE="$LEAD" CALLER_TTY="$(T display-message -p -t "$LEAD" '#{pane_tty}')"
# Pane rows carry the live server generation: an unstamped row confers no identity.
EPOCH="srv:$(T display-message -p '#{pid}:#{start_time}')"
case "$EPOCH" in srv:[0-9]*:[0-9]*) ;; *) fail "private tmux server reported no generation: $EPOCH" ;; esac
seed() { # seed <sol pane_id> <sol session> [harness]
  python3 - "$WORK" "$LEAD" "$1" "$2" "${3:-claude}" "$EPOCH" <<'PY'
import json, pathlib, sys
w = pathlib.Path(sys.argv[1]); lead, pane, session, harness, epoch = sys.argv[2:]
# Each seat owns a different native conversation; this fixture tests relaunch, not duplicate ownership.
seat = lambda p, s, h: {"status": "active", "delivery": "pane", "harness": h, "pane_id": p, "pane": f"{s}:0.0",
                        "session": s, "registered_at": "t", "model": "opus-test", "permissions": "bypass",
                        "harness_session_id": "lead-conversation" if s == "Demo/lead" else "old-conversation",
                        "clear_nonce": "stale-witness", "server_epoch": epoch}
reg = w / "Demo/.tap/team-registry.json"
reg.write_text(json.dumps({"schema": "0.20", "team": {"name": "Demo"},
    "seats": {"lead": seat(lead, "Demo/lead", "claude"), "sol": seat(pane, session, harness)}}))
(w / "index/global-registry.json").write_text(json.dumps({"schema": "0.20", "teams": {"Demo": {
    "root": str(w / "Demo"), "registry_location": str(reg), "state": "registered", "enrolled_at": "t"}}}))
PY
}
field() { python3 -c 'import json,sys; r=json.load(open(sys.argv[1]))["seats"][sys.argv[2]]; print(json.dumps(r.get(sys.argv[3])))' "$REG" "$1" "$2"; }
run() { rc=0; out="$( "$@" 2>&1 )" || rc=$?; }
# Human output streams "  <handle>: <phase>" progress lines (tap-c27s2). Drop only those three phases so a
# seat-prefixed WARNING or any other diagnostic still reaches the exact-output comparison.
result_rows() { printf '%s\n' "$out" | grep -Ev '^  Demo/[a-z]+: (checking target and resume identity|replacing [a-z]+ in pane %[0-9]+|respawn attempted; observing [a-z]+ startup for up to [0-9]+s \(pane %[0-9]+\))$'; }
cd "$WORK/Demo"
export TAP_CLAUDE_HOME="$WORK/claude"
mkdir -p "$TAP_CLAUDE_HOME/projects/fixture"
printf '{}\n' > "$TAP_CLAUDE_HOME/projects/fixture/old-conversation.jsonl"
seed "$SOL" Demo/sol
before_pid="$(pid "$SOL")"
before_reg="$(cat "$REG")"
run "$ROOT/bin/tap" session relaunch Demo/sol --dry-run --json
[ "$rc" = 0 ] || fail "dry-run failed: $out"
python3 - "$out" <<'PY_CHECK'
import json,sys
r=json.loads(sys.argv[1]); assert r['candidates']==1 and len(r['results'])==1,r
v=r['results'][0]; assert v['status']=='would-resume' and v['code']==0,v
assert 'old-conversation' in v['stdout'] and 'TAP_CLEAR_ID=' in v['stdout'],v
PY_CHECK
[ "$(cat "$REG")" = "$before_reg" ] || fail "dry-run changed registry"
[ "$(pid "$SOL")" = "$before_pid" ] || fail "dry-run replaced process"

run env TAP_HOME="$WORK/not-target-bus" "$ROOT/bin/tap" session relaunch Demo/sol
[ "$rc" = 0 ] || fail "relaunch failed: $out"
[ "$(result_rows)" = "Relaunching 1 active seats on team Demo
● Demo/sol" ] || fail "expected one result row: $out"
[ "$(pane Demo/sol:0.0)" = "$SOL" ] || fail "pane changed"
[ "$(pid "$SOL")" != "$before_pid" ] || fail "process was not replaced"
[ "$(field sol harness_session_id)" = '"old-conversation"' ] || fail "conversation changed"
[ "$(field sol expected_clear_nonce)" = null ] || fail "nonce was not consumed"
grep -q -- --resume "$LAUNCHES/$(pid "$SOL")" || fail "harness did not resume"
grep -q -- old-conversation "$LAUNCHES/$(pid "$SOL")" || fail "harness resumed wrong conversation"
[ -z "$(sed -n 's/^TAP_HOME=//p' "$LAUNCHES/$(pid "$SOL")")" ] || fail "resumed harness inherited caller bus pin"
echo "relaunch-native: same pane, stored conversation, one result, nonce consumed, caller pin removed: ok"

# OpenCode instructions ride the bus while the target fence is held. The nested
# send must not add a second result row to either human output or JSON.
T respawn-pane -k -t "$SOL" "exec $IDLE/opencode 600"
seed "$SOL" Demo/sol opencode
run "$ROOT/bin/tap" session relaunch Demo/sol -m "hello from the relaunch"
[ "$rc" = 0 ] || fail "opencode relaunch failed: $out"
[ "$(result_rows)" = "Relaunching 1 active seats on team Demo
● Demo/sol" ] || fail "opencode nested send added chatter: $out"
grep -q -- 'hello from the relaunch' "$LAUNCHES/$(pid "$SOL")" && fail "opencode instruction rode argv"
grep -rlq -- 'hello from the relaunch' "$WORK/Demo/.tap/bus" || fail "opencode instruction never reached the bus: $out"
run "$ROOT/bin/tap" session relaunch Demo/sol -m "hello from JSON relaunch" --json
[ "$rc" = 0 ] || fail "opencode JSON relaunch failed: $out"
python3 - "$out" <<'PY_CHECK'
import json,sys
r=json.loads(sys.argv[1]); assert r['candidates']==1 and len(r['results'])==1,r
assert r['results'][0]['status']=='resumed' and r['results'][0]['code']==0,r
PY_CHECK
grep -rlq -- 'hello from JSON relaunch' "$WORK/Demo/.tap/bus" || fail "JSON instruction never reached the bus"
echo "relaunch-native: opencode instruction parks on bus with one human/JSON result: ok"
